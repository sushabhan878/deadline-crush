import { Controller, Get, Headers, Param, Req, Res, UseGuards } from '@nestjs/common';
import pg from 'pg';
import { config, pool } from '@dc/shared';
import { AuthGuard, OrganizerGuard, TeamMemberGuard, uuidParam } from './common';

type Sub = { teamId?: string; hackathonId?: string; send: (row: any) => void };
const subs = new Set<Sub>();
let listening = false;

/** F-12: ONE LISTEN connection for the whole process; fan-out in memory. */
async function ensureListener() {
  if (listening) return;
  listening = true;
  const connect = async () => {
    const c = new pg.Client({ connectionString: config.databaseUrl });
    c.on('error', () => { c.end().catch(() => {}); setTimeout(connect, 1000); });
    c.on('notification', async (m) => {
      const r = await pool.query('SELECT * FROM audit_events WHERE id=$1', [m.payload]);
      const row = r.rows[0];
      if (!row) return;
      for (const s of subs) if ((s.teamId && s.teamId === row.team_id) || (s.hackathonId && s.hackathonId === row.hackathon_id)) s.send(row);
    });
    await c.connect();
    await c.query('LISTEN events');
  };
  await connect().catch(() => { listening = false; });
}

async function stream(req: any, res: any, filter: { teamId?: string; hackathonId?: string }, lastId?: string) {
  await ensureListener();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (row: any) => res.write(`id: ${row.id}\nevent: ${row.type}\ndata: ${JSON.stringify({ ...row.payload, teamId: row.team_id, at: row.created_at })}\n\n`);
  // Subscribe first (buffering), then replay, so nothing is missed between the two.
  const buf: any[] = [];
  let replaying = true;
  const sub: Sub = { ...filter, send: (r) => (replaying ? buf.push(r) : send(r)) };
  subs.add(sub);
  const cur = /^\d{1,15}$/.test(lastId ?? '') ? Number(lastId) : 0;
  let max = cur;
  if (cur > 0) {
    const col = filter.teamId ? 'team_id' : 'hackathon_id';
    const r = await pool.query(`SELECT * FROM audit_events WHERE ${col}=$1 AND id>$2 ORDER BY id LIMIT 500`, [filter.teamId ?? filter.hackathonId, cur]);
    for (const row of r.rows) { send(row); max = Math.max(max, Number(row.id)); }
  }
  replaying = false;
  for (const row of buf) if (Number(row.id) > max) send(row);
  res.write(': connected\n\n');
  const hb = setInterval(() => res.write(': hb\n\n'), 15_000);
  res.on('close', () => { clearInterval(hb); subs.delete(sub); });
}

@Controller()
export class EventsController {
  @Get('teams/:id/events')
  @UseGuards(AuthGuard, TeamMemberGuard)
  async team(@Param('id') id: string, @Headers('last-event-id') last: string | undefined, @Req() req: any, @Res() res: any) {
    await stream(req, res, { teamId: uuidParam(id) }, last);
  }

  @Get('hackathons/:id/events')
  @UseGuards(AuthGuard, OrganizerGuard)
  async hackathon(@Param('id') id: string, @Headers('last-event-id') last: string | undefined, @Req() req: any, @Res() res: any) {
    await stream(req, res, { hackathonId: uuidParam(id) }, last);
  }

  /** Polling fallback (5s) when SSE fails. */
  @Get('teams/:id/status')
  @UseGuards(AuthGuard, TeamMemberGuard)
  async status(@Param('id') id: string) {
    const r = await pool.query(
      `SELECT v.id, v.version_no, v.status, v.failure_summary FROM file_versions v JOIN submissions s ON s.id=v.submission_id
       WHERE s.team_id=$1 ORDER BY v.version_no DESC LIMIT 1`, [uuidParam(id)]);
    return { latest: r.rows[0] ?? null };
  }
}
