import { Controller, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AppError, audit, pool, storage, withTx } from '@dc/shared';
import { AuthGuard, AuthUser, OrganizerGuard, User, parse, uuidParam } from './common';

/** Team row with counting version + fallback_used (PRD §5.5). */
const TEAM_ROWS = `
  SELECT t.id team_id, t.name team_name, s.current_title title, s.current_links links,
    cv.id counting_version_id, cv.version_no counting_version, cv.status, cv.started_in_time in_time,
    cv.actual_size size_bytes, cv.sha256, cv.completed_at submitted_at,
    lv.version_no latest_version, lv.status latest_status, lv.failure_summary,
    (lv.status IN ('needs_fix') AND cv.id IS NOT NULL AND cv.id <> lv.id) fallback_used,
    (SELECT count(*)::int FROM late_attempts la WHERE la.team_id=t.id) late_attempts,
    greatest(s.updated_at, lv.started_at) last_activity
  FROM teams t JOIN submissions s ON s.team_id=t.id
  LEFT JOIN LATERAL (SELECT * FROM file_versions f WHERE f.submission_id=s.id AND f.status='accepted' AND f.counts
                     ORDER BY version_no DESC LIMIT 1) cv ON true
  LEFT JOIN LATERAL (SELECT * FROM file_versions f WHERE f.submission_id=s.id
                     AND f.status NOT IN ('aborted') ORDER BY version_no DESC LIMIT 1) lv ON true
  WHERE t.hackathon_id=$1`;

const csvCell = (v: unknown) => {
  let s = v == null ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // formula-injection neutralization
  return `"${s.replace(/"/g, '""')}"`;
};

@Controller('hackathons')
@UseGuards(AuthGuard, OrganizerGuard)
export class OrganizerController {
  @Get(':id/dashboard')
  async dashboard(@Param('id') id: string) {
    const hid = uuidParam(id);
    const q = async (sql: string) => (await pool.query(sql, [hid])).rows;
    const [teams] = await q(`SELECT count(*)::int total FROM teams WHERE hackathon_id=$1`);
    const byStatus = await q(`SELECT lv.status, count(*)::int n FROM teams t JOIN submissions s ON s.team_id=t.id
      JOIN LATERAL (SELECT status FROM file_versions f WHERE f.submission_id=s.id AND f.status<>'aborted' ORDER BY version_no DESC LIMIT 1) lv ON true
      WHERE t.hackathon_id=$1 GROUP BY lv.status`);
    const [late] = await q(`SELECT count(*)::int n FROM late_attempts la JOIN teams t ON t.id=la.team_id WHERE t.hackathon_id=$1`);
    const [queue] = await q(`SELECT count(*) FILTER (WHERE j.state='queued')::int depth,
      coalesce(extract(epoch FROM now()-min(j.created_at) FILTER (WHERE j.state='queued')),0)::int oldest_s FROM jobs j
      JOIN file_versions f ON f.id=j.version_id JOIN submissions s ON s.id=f.submission_id JOIN teams t ON t.id=s.team_id WHERE t.hackathon_id=$1`);
    const workers = (await pool.query(`SELECT count(*)::int n FROM worker_heartbeats WHERE seen_at > now() - interval '30 seconds'`)).rows[0];
    const reasons = await q(`SELECT check_name, count(*)::int n FROM check_results c
      JOIN file_versions f ON f.id=c.version_id JOIN submissions s ON s.id=f.submission_id JOIN teams t ON t.id=s.team_id
      WHERE c.status='fail' AND t.hackathon_id=$1 GROUP BY 1`);
    return { teamsTotal: teams.total, byStatus, lateAttempts: late.n, queueDepth: queue.depth, oldestQueuedSeconds: queue.oldest_s, activeWorkers: workers.n, failedChecks: reasons };
  }

  @Get(':id/submissions')
  async submissions(@Param('id') id: string, @Query('q') q?: string, @Query('status') status?: string,
    @Query('page') page = '1', @Query('pageSize') pageSize = '50') {
    const positiveInteger = z.string().regex(/^\d{1,6}$/).transform(Number).pipe(z.number().int().min(1));
    const size = Math.min(200, parse(positiveInteger, pageSize));
    const pageNo = parse(positiveInteger, page);
    const off = (pageNo - 1) * size;
    const search = parse(z.string().max(120).optional(), q);
    const state = parse(z.enum(['none', 'uploading', 'uploaded', 'checking', 'accepted', 'needs_fix', 'expired']).optional(), status);
    const r = await pool.query(
      `SELECT * FROM (${TEAM_ROWS}) x WHERE ($2::text IS NULL OR team_name ILIKE '%'||$2||'%')
       AND ($3::text IS NULL OR coalesce(latest_status,'none')=$3) ORDER BY team_name LIMIT $4 OFFSET $5`,
      [uuidParam(id), search || null, state || null, size, off]);
    return { rows: r.rows, page: pageNo, pageSize: size };
  }

  @Get(':id/teams/:teamId')
  async teamDetail(@Param('id') id: string, @Param('teamId') teamId: string, @User() u: AuthUser) {
    const tid = uuidParam(teamId);
    const hid = uuidParam(id);
    if (!(await pool.query('SELECT 1 FROM teams WHERE id=$1 AND hackathon_id=$2', [tid, hid])).rowCount) throw new AppError('NOT_FOUND', 'Team not found');
    await withTx((tx) => audit(tx, hid, tid, u.id, 'organizer.team_viewed'));
    const versions = (await pool.query(`SELECT f.* FROM file_versions f JOIN submissions s ON s.id=f.submission_id WHERE s.team_id=$1 ORDER BY version_no DESC`, [tid])).rows;
    const late = (await pool.query('SELECT * FROM late_attempts WHERE team_id=$1 ORDER BY id DESC', [tid])).rows;
    const trail = (await pool.query('SELECT * FROM audit_events WHERE team_id=$1 ORDER BY id DESC LIMIT 200', [tid])).rows;
    return { versions: versions.map(({ s3_key, s3_upload_id, ...v }) => v), late, trail };
  }

  /** Streamed via cursor; never loads all rows. */
  @Get(':id/export.csv')
  async exportCsv(@Param('id') id: string, @User() u: AuthUser, @Res() res: any) {
    const hid = uuidParam(id);
    await withTx((tx) => audit(tx, hid, null, u.id, 'organizer.export', { file: 'export.csv' }));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="export.csv"' });
    const cols = ['team_id', 'team_name', 'title', 'links', 'counting_version', 'status', 'in_time', 'fallback_used', 'sha256', 'size_bytes', 'submitted_at', 'late_attempts'];
    res.write(cols.join(',') + '\n');
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`DECLARE cur NO SCROLL CURSOR FOR SELECT * FROM (${TEAM_ROWS}) x ORDER BY team_name`.replace('$1', `'${hid}'::uuid`));
      for (;;) {
        const r = await c.query('FETCH 500 FROM cur');
        if (!r.rowCount) break;
        res.write(r.rows.map((row: any) => cols.map((k) => csvCell(row[k])).join(',')).join('\n') + '\n');
      }
      await c.query('COMMIT');
    } catch (error) {
      await c.query('ROLLBACK').catch(() => {});
      res.destroy(error as Error);
    } finally { c.release(); res.end(); }
  }

  @Get(':id/late-attempts.csv')
  async lateCsv(@Param('id') id: string, @Res() res: any) {
    const r = await pool.query(`SELECT la.* FROM late_attempts la JOIN teams t ON t.id=la.team_id WHERE t.hackathon_id=$1 ORDER BY la.id`, [uuidParam(id)]);
    const cols = ['id', 'team_id', 'user_id', 'action', 'server_time', 'deadline_at', 'delta_ms', 'reason', 'ip'];
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="late-attempts.csv"' });
    res.send([cols.join(','), ...r.rows.map((row) => cols.map((k) => csvCell(row[k])).join(','))].join('\n') + '\n');
  }

  /** Demo only: resets the deadline. Audited, and does not touch any version's flags (F-18). */
  @Post(':id/reset-demo-deadline')
  async resetDemo(@Param('id') id: string, @User() u: AuthUser) {
    const hid = uuidParam(id);
    await withTx(async (tx) => {
      const updated = await tx.query(`UPDATE hackathons SET deadline_at = now() + interval '5 minutes' WHERE id=$1 AND join_code='DEMO'`, [hid]);
      if (!updated.rowCount) throw new AppError('FORBIDDEN', 'Deadline reset is available on the demo event');
      await audit(tx, hid, null, u.id, 'organizer.demo_deadline_reset');
    });
    return { ok: true };
  }
}

@Controller()
export class StatusController {
  @Get('healthz')
  async health() { return { api: 'ok' }; }

  @Get('status')
  async status() {
    const t0 = Date.now();
    let db = 'down', queueLag = 0, workers = 0;
    const storageOk = storage.ping();
    try {
      await pool.query('SELECT 1'); db = 'ok';
      queueLag = (await pool.query(`SELECT coalesce(extract(epoch FROM now()-min(created_at)),0)::int s FROM jobs WHERE state='queued'`)).rows[0].s;
      workers = (await pool.query(`SELECT count(*)::int n FROM worker_heartbeats WHERE seen_at > now() - interval '30 seconds'`)).rows[0].n;
    } catch { /* reported as down */ }
    return {
      api: 'ok', db, storage: (await storageOk) ? 'ok' : 'down', worker: workers > 0 ? 'ok' : 'down',
      activeWorkers: workers, queueLagSeconds: queueLag, latencyMs: Date.now() - t0, checkedAt: new Date().toISOString(),
    };
  }
}
