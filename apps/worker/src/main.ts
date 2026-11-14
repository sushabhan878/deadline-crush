import { randomUUID } from 'node:crypto';
import { audit, config, finishStorage, pool, recordUploaded, storage, transition, withTx } from '@dc/shared';
import { finalize, runChecks } from './checks';

const WORKER_ID = `w-${process.pid}-${randomUUID().slice(0, 6)}`;
const LEASE_S = Number(process.env.LEASE_SECONDS ?? 60);
const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ worker: WORKER_ID, msg, ...extra }));
let stopping = false;
const running = new Set<number>();

/** F-10 claim: SKIP LOCKED, lease, attempts++. */
async function claim(n: number) {
  const r = await pool.query(
    `UPDATE jobs SET state='running', locked_by=$1, lease_expires_at=now()+make_interval(secs => $3), attempts=attempts+1
     WHERE id IN (SELECT id FROM jobs WHERE state='queued' AND run_after<=now() ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $2)
     RETURNING *`, [WORKER_ID, n, LEASE_S]);
  return r.rows;
}

async function handle(job: any) {
  running.add(job.id);
  const hb = setInterval(() => pool.query(
    `UPDATE jobs SET lease_expires_at=now()+make_interval(secs => $3) WHERE id=$1 AND locked_by=$2 AND state='running' AND lease_expires_at > now()`,
    [job.id, WORKER_ID, LEASE_S]).catch(() => {}), Math.min(20_000, LEASE_S * 1000 / 3));
  try {
    const v = (await pool.query(
      `SELECT v.*, t.id team_id, t.hackathon_id FROM file_versions v JOIN submissions s ON s.id=v.submission_id JOIN teams t ON t.id=s.team_id WHERE v.id=$1`,
      [job.version_id])).rows[0];
    // uploaded -> checking (no-op if a retry already moved it)
    await withTx(async (tx) => {
      if (await transition(tx, v.id, 'uploaded', 'checking')) await audit(tx, v.hackathon_id, v.team_id, null, 'version.checking', { versionId: v.id });
    });
    const results = await runChecks(v, () => {
      if (process.env.CHAOS_CRASH_ON_JOB === '1') { log('chaos: crashing after file type check'); process.kill(process.pid, 'SIGKILL'); }
    });
    if (await finalize(v, job.id, WORKER_ID, results)) log('job done', { jobId: job.id });
  } catch (e) {
    log('job error', { jobId: job.id, err: String(e) });
    await pool.query(`UPDATE jobs SET last_error=$2 WHERE id=$1 AND locked_by=$3`, [job.id, String(e).slice(0, 500), WORKER_ID]).catch(() => {});
    // lease will expire and the reaper retries with backoff
  } finally {
    clearInterval(hb);
    running.delete(job.id);
  }
}
/** Reaper: requeue expired leases with backoff; exhaust => needs_fix CHECK_INFRA_FAILURE. */
async function reap() {
  await withTx(async (tx) => {
    const exp = (await tx.query(`SELECT j.*, t.id team_id, t.hackathon_id FROM jobs j
      JOIN file_versions v ON v.id=j.version_id JOIN submissions s ON s.id=v.submission_id JOIN teams t ON t.id=s.team_id
      WHERE j.state='running' AND j.lease_expires_at < now() FOR UPDATE OF j SKIP LOCKED`)).rows;
    for (const j of exp) {
      if (j.attempts < j.max_attempts) {
        await tx.query(`UPDATE jobs SET state='queued', locked_by=NULL, lease_expires_at=NULL, run_after=now()+make_interval(secs => $2) WHERE id=$1`,
          [j.id, Math.min(60, 2 ** j.attempts)]);
        await tx.query(`SELECT pg_notify('metrics','lease_expired')`);
      } else {
        await tx.query(`UPDATE jobs SET state='failed', locked_by=NULL, last_error=coalesce(last_error,'max attempts') WHERE id=$1`, [j.id]);
        if (await transition(tx, j.version_id, ['uploaded', 'checking'], 'needs_fix', { failure_summary: 'CHECK_INFRA_FAILURE: our checker failed repeatedly — organizers have been notified', finalized_at: new Date() }))
          await audit(tx, j.hackathon_id, j.team_id, null, 'version.needs_fix', { versionId: j.version_id, reason: 'CHECK_INFRA_FAILURE' });
      }
    }
    if (exp.length) log('reaped', { n: exp.length });
  });
}

/** Repair interrupted finalization before expiring unfinished sessions. */
async function reconcile() {
  const pending = await pool.query(`SELECT id FROM file_versions WHERE status='uploading'
    AND completion_parts IS NOT NULL AND completion_requested_at < now() - interval '5 seconds' LIMIT 100`);
  for (const { id } of pending.rows) {
    await withTx(async (tx) => {
      const v = (await tx.query(`SELECT v.*, t.id team_id, t.hackathon_id FROM file_versions v
        JOIN submissions s ON s.id=v.submission_id JOIN teams t ON t.id=s.team_id
        WHERE v.id=$1 AND v.status='uploading' FOR UPDATE OF v SKIP LOCKED`, [id])).rows[0];
      if (!v) return;
      await finishStorage(v);
      await recordUploaded(tx, v, v.hackathon_id, v.team_id, null, Number(v.declared_size), v.completion_requested_at);
    }).catch((error) => log('completion recovery error', { versionId: id, error: String(error) }));
  }
  // (a) uploading past deadline+grace -> expired
  const stale = (await pool.query(`SELECT v.id, v.s3_key, v.s3_upload_id, t.id team_id, t.hackathon_id FROM file_versions v
    JOIN submissions s ON s.id=v.submission_id JOIN teams t ON t.id=s.team_id JOIN hackathons h ON h.id=t.hackathon_id
    WHERE v.status='uploading' AND v.completion_parts IS NULL AND now() >= h.deadline_at + make_interval(secs => h.grace_seconds)`)).rows;
  for (const v of stale) {
    const ok = await withTx(async (tx) => {
      const row = (await tx.query('SELECT completion_parts FROM file_versions WHERE id=$1 FOR UPDATE', [v.id])).rows[0];
      if (row.completion_parts) return false;
      const m = await transition(tx, v.id, 'uploading', 'expired', { finalized_at: new Date() });
      if (m) await audit(tx, v.hackathon_id, v.team_id, null, 'version.expired', { versionId: v.id });
      return m;
    });
    if (ok && v.s3_upload_id) await storage.abort(v.s3_key, v.s3_upload_id);
  }
  // (c) uploaded without a job -> create the job
  await pool.query(`INSERT INTO jobs (version_id) SELECT id FROM file_versions WHERE status='uploaded' ON CONFLICT (version_id,kind) DO NOTHING`);
  // (d) checking whose job failed -> needs_fix
  await pool.query(`UPDATE file_versions v SET status='needs_fix', failure_summary='CHECK_INFRA_FAILURE', finalized_at=now()
    FROM jobs j WHERE j.version_id=v.id AND j.state='failed' AND v.status='checking'`);
  if (stale.length) log('reconciled expired', { n: stale.length });
}

async function loop() {
  while (!stopping) {
    try {
      const free = config.workerConcurrency - running.size;
      if (free > 0) for (const j of await claim(free)) void handle(j);
    } catch (e) { log('claim error', { err: String(e) }); }
    await new Promise((r) => setTimeout(r, 500));
  }
}

const every = (ms: number, fn: () => Promise<unknown>) =>
  setInterval(() => fn().catch((e) => log('loop error', { err: String(e) })), ms);

every(15_000, reap);
every(15_000, reconcile);
every(10_000, () => pool.query(`INSERT INTO worker_heartbeats (worker_id) VALUES ($1) ON CONFLICT (worker_id) DO UPDATE SET seen_at=now()`, [WORKER_ID]));
void pool.query(`INSERT INTO worker_heartbeats (worker_id) VALUES ($1) ON CONFLICT (worker_id) DO UPDATE SET seen_at=now()`, [WORKER_ID]);

// Graceful shutdown: release jobs we haven't finished so another worker takes them immediately.
for (const sig of ['SIGINT', 'SIGTERM'] as const) globalThis.process.on(sig, async () => {
  stopping = true;
  await pool.query(`UPDATE jobs SET state='queued', locked_by=NULL, lease_expires_at=NULL WHERE locked_by=$1 AND state='running'`, [WORKER_ID]).catch(() => {});
  await pool.query('DELETE FROM worker_heartbeats WHERE worker_id=$1', [WORKER_ID]).catch(() => {});
  globalThis.process.exit(0);
});

log('worker started');
await loop();
