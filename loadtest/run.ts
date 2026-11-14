import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { config, pool, withTx } from '@dc/shared';

const api = process.env.API ?? 'http://localhost:3000';
const teams = Number(process.env.LOAD_TEAMS ?? 2000);
const seconds = Number(process.env.LOAD_SECONDS ?? 600);
const output = process.env.LOAD_REPORT ?? 'loadtest/result.json';
assert(process.env.DATABASE_URL && Number.isInteger(teams) && teams > 0 && seconds > 0);
const run = randomUUID();
const zip = await readFile(new URL('../scripts/smoke.zip', import.meta.url));
const hackathon = await withTx(async (tx) => {
  const { rows: [h] } = await tx.query(`INSERT INTO hackathons(name,join_code,starts_at,deadline_at)
    VALUES ('Load test',$1,now(),now()+interval '1 hour') RETURNING id`, [run]);
  const hash = await argon2.hash(randomUUID());
  const { rows } = await tx.query(`WITH new_teams AS (
    INSERT INTO teams(hackathon_id,name) SELECT $1,'Load team '||i FROM generate_series(1,$2::int) i RETURNING id,name
  ), new_submissions AS (
    INSERT INTO submissions(team_id) SELECT id FROM new_teams RETURNING id,team_id
  ), new_users AS (
    INSERT INTO users(email,name,password_hash,role) SELECT id||'@load.test',name,$3,'participant' FROM new_teams RETURNING id,email
  ), members AS (
    INSERT INTO team_members(team_id,user_id,hackathon_id,role)
    SELECT t.id,u.id,$1,'leader' FROM new_teams t JOIN new_users u ON u.email=t.id||'@load.test'
  ) SELECT s.id AS submission_id,u.id,u.email FROM new_submissions s JOIN new_users u ON u.email=s.team_id||'@load.test'`, [h.id, teams, hash]);
  return { id: h.id as string, participants: rows };
});

const samples = new Map<string, number[]>();
const errors: { team: string; message: string }[] = [];
let submitted = 0;
let successfulVersions = 0;
const progress = setInterval(() => console.log(JSON.stringify({ submitted, errors: errors.length, teamTarget: teams })), 60_000);
const started = Date.now();
const deadlineBuffer = Math.min(15, seconds * 0.2);
await pool.query('UPDATE hackathons SET deadline_at=clock_timestamp()+make_interval(secs=>$2) WHERE id=$1', [hackathon.id, seconds]);

function arrival(index: number) {
  const share = index / teams;
  const relative = share < 0.15 ? share / 0.15 * 0.5
    : share < 0.40 ? 0.5 + (share - 0.15) / 0.25 * 0.2
      : 0.7 + (share - 0.40) / 0.60 * 0.3;
  return relative * (seconds - deadlineBuffer) * 1000;
}

async function send(label: string, path: string, token: string, method = 'GET', body?: object, extra?: Record<string, string>) {
  const before = performance.now();
  try {
    const r = await fetch(api + path, { method, signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw new Error(`${label} ${r.status} ${JSON.stringify(data)}`);
    return data;
  } finally {
    if (!samples.has(label)) samples.set(label, []);
    samples.get(label)!.push(performance.now() - before);
  }
}

try {
  await Promise.all(hackathon.participants.map(async (participant, i) => {
    await delay(Math.max(0, started + arrival(i) - Date.now()));
    const token = jwt.sign({ id: participant.id, email: participant.email, role: 'participant' }, config.jwtSecret, { expiresIn: '15m' });
    const path = `/submissions/${participant.submission_id}`;
    try {
      await send('time', `/time?hackathonId=${hackathon.id}`, token);
      await send('metadata', `${path}/metadata`, token, 'PUT', { title: `Project ${i}`, description: 'Load fixture', links: [] });
      const versions = i % 50 === 0 ? 2 : 1;
      for (let n = 0; n < versions; n++) {
        const body = { filename: 'project.zip', size: zip.length, contentType: 'application/zip' };
        const headers = { 'Idempotency-Key': randomUUID() };
        const start = () => send('start', `${path}/versions`, token, 'POST', body, headers);
        const v = await start();
        if (i % 20 === 0) assert.equal((await start()).versionId, v.versionId);
        const upload = `/versions/${v.versionId}`;
        const { urls: [part] } = await send('sign', `${upload}/parts/sign`, token, 'POST', { partNumbers: [1] });
        if (i % 33 === 0) {
          await assert.rejects(fetch(part.url, { method: 'PUT', body: zip, signal: AbortSignal.abort() }));
          assert.deepEqual((await send('list', `${upload}/parts`, token)).missing, [1]);
        }
        const put = await fetch(part.url, { method: 'PUT', body: zip, signal: AbortSignal.timeout(30_000) });
        assert(put.ok, `Storage PUT ${put.status}`);
        const { uploaded } = await send('list', `${upload}/parts`, token);
        const done = () => send('complete', `${upload}/complete`, token, 'POST', { parts: uploaded.map(({ n, etag }: any) => ({ n, etag })) });
        const receipt = await done();
        assert.equal(receipt.receiptId, v.versionId);
        if (i % 20 === 0) assert.equal((await done()).receiptId, receipt.receiptId);
        successfulVersions++;
      }
      await send('versions', `${path}/versions`, token);
      submitted++;
    } catch (error) { errors.push({ team: participant.submission_id, message: String(error) }); }
  }));
  await delay(Math.max(0, started + seconds * 1000 - Date.now()));
  const expectedVersions = teams + Math.ceil(teams / 50);
  let reconciliation;
  for (let i = 0; i < 180; i++) {
    const result = await pool.query(`SELECT count(DISTINCT v.submission_id)::int teams, count(*)::int versions,
       count(*) FILTER (WHERE v.status='accepted')::int accepted, count(*) FILTER (WHERE v.status='needs_fix')::int needs_fix,
       count(r.version_id)::int receipts, count(j.id) FILTER (WHERE j.state='done')::int jobs,
       (SELECT count(*)::int FROM check_results c JOIN file_versions f ON f.id=c.version_id
         JOIN submissions s2 ON s2.id=f.submission_id JOIN teams t2 ON t2.id=s2.team_id WHERE t2.hackathon_id=$1) AS checks
       FROM file_versions v JOIN submissions s ON s.id=v.submission_id JOIN teams t ON t.id=s.team_id
       LEFT JOIN receipts r ON r.version_id=v.id AND r.sha256=v.sha256 LEFT JOIN jobs j ON j.version_id=v.id
       WHERE t.hackathon_id=$1`, [hackathon.id]);
    reconciliation = result.rows[0];
    if (reconciliation.jobs >= successfulVersions) break;
    await delay(1000);
  }
  const stats = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { count: sorted.length, p95Ms: Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1] * 10) / 10 };
  };
  const report = { run, startedAt: new Date(started).toISOString(), seconds, teams, submitted, expectedVersions,
    successfulVersions, fixtureBytes: zip.length, errors, api: stats([...samples.values()].flat()),
    endpoints: Object.fromEntries([...samples].map(([key, value]) => [key, stats(value)])), reconciliation };
  await mkdir(new URL('./', import.meta.url), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  assert.equal(errors.length, 0);
  assert.equal(reconciliation.teams, teams);
  assert.equal(reconciliation.versions, expectedVersions);
  assert.equal(reconciliation.accepted, expectedVersions);
  assert.equal(reconciliation.receipts, expectedVersions);
  assert.equal(reconciliation.jobs, expectedVersions);
  assert.equal(reconciliation.checks, expectedVersions * 5);
  assert(report.api.p95Ms < 300);
} finally {
  clearInterval(progress);
  await pool.end();
}
