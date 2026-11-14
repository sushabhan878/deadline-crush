import { Body, Controller, Get, Param, Put, Query, UseGuards } from '@nestjs/common';
import { AppError, audit, canEditMetadata, metadataSchema, phaseAt, pool, withTx, txNow } from '@dc/shared';
import { AuthGuard, AuthUser, Ip, TeamCtx, TeamMemberGuard, User, logLate, parse, uuidParam } from './common';

@Controller()
export class TimeController {
  /** F-03: server time + phase. hackathonId optional (defaults to latest hackathon). */
  @Get('time')
  async time(@Query('hackathonId') hid?: string) {
    const r = await pool.query(
      `SELECT now() AS server_now, deadline_at, grace_seconds FROM hackathons
       WHERE ($1::uuid IS NULL OR id=$1) ORDER BY created_at DESC LIMIT 1`, [hid === undefined ? null : uuidParam(hid)]);
    if (!r.rowCount) throw new AppError('NOT_FOUND', 'No hackathon');
    const { server_now, deadline_at, grace_seconds } = r.rows[0];
    const graceEnds = new Date(deadline_at.getTime() + grace_seconds * 1000);
    return {
      serverNow: server_now, deadlineAt: deadline_at, graceEndsAt: graceEnds,
      phase: phaseAt(server_now, deadline_at, grace_seconds),
    };
  }

  /** Public event info for the hackathon page (no secrets: join code is not exposed). */
  @Get('hackathon-info')
  async info(@Query('hackathonId') hid?: string) {
    const r = await pool.query(
      `SELECT h.id, h.name, h.starts_at, h.deadline_at, h.grace_seconds, h.max_file_bytes, h.allowed_types, h.max_links,
              h.created_at, now() AS server_now,
              (SELECT count(*)::int FROM team_members m WHERE m.hackathon_id=h.id) AS registered,
              (SELECT count(*)::int FROM teams t WHERE t.hackathon_id=h.id) AS teams
       FROM hackathons h WHERE ($1::uuid IS NULL OR h.id=$1) ORDER BY h.created_at DESC LIMIT 1`, [hid === undefined ? null : uuidParam(hid)]);
    if (!r.rowCount) throw new AppError('NOT_FOUND', 'No hackathon');
    const h = r.rows[0];
    return {
      id: h.id, name: h.name, startsAt: h.starts_at, deadlineAt: h.deadline_at, graceSeconds: h.grace_seconds,
      maxFileBytes: Number(h.max_file_bytes), allowedTypes: h.allowed_types, maxLinks: h.max_links,
      registered: h.registered, teams: h.teams, phase: phaseAt(h.server_now, h.deadline_at, h.grace_seconds),
    };
  }
}

@Controller('submissions')
@UseGuards(AuthGuard, TeamMemberGuard)
export class MetadataController {
  @Get(':id/metadata')
  async get(@Param('id') _id: string, @TeamCtx() c: any) {
    const cur = await pool.query('SELECT current_title title, current_description description, current_links links, updated_at FROM submissions WHERE id=$1', [c.submissionId]);
    const hist = await pool.query('SELECT version_no, title, description, links, created_at, in_time FROM metadata_versions WHERE submission_id=$1 ORDER BY version_no DESC', [c.submissionId]);
    return { current: cur.rows[0], history: hist.rows };
  }

  /** F-04: versioned, deadline-gated. Row lock prevents lost versions. */
  @Put(':id/metadata')
  async put(@Param('id') _id: string, @Body() body: unknown, @TeamCtx() c: any, @User() u: AuthUser, @Ip() ip: string) {
    const m = parse(metadataSchema, body);
    const rejected = await withTx(async (tx) => {
      await tx.query('SELECT 1 FROM submissions WHERE id=$1 FOR UPDATE', [c.submissionId]);
      const h = (await tx.query('SELECT deadline_at, max_links FROM hackathons WHERE id=$1', [c.hackathonId])).rows[0];
      const now = await txNow(tx);
      if (!canEditMetadata(now, h.deadline_at)) return { now, deadline: h.deadline_at as Date };
      if (m.links.length > h.max_links) throw new AppError('VALIDATION', `At most ${h.max_links} links`);
      const n = (await tx.query('SELECT coalesce(max(version_no),0)+1 n FROM metadata_versions WHERE submission_id=$1', [c.submissionId])).rows[0].n;
      await tx.query('INSERT INTO metadata_versions (submission_id,version_no,title,description,links,created_at) VALUES ($1,$2,$3,$4,$5,$6)', [c.submissionId, n, m.title, m.description, JSON.stringify(m.links), now]);
      await tx.query('UPDATE submissions SET current_title=$2,current_description=$3,current_links=$4,updated_at=$5 WHERE id=$1', [c.submissionId, m.title, m.description, JSON.stringify(m.links), now]);
      await audit(tx, c.hackathonId, c.teamId, u.id, 'metadata.updated', { versionNo: n });
      return { versionNo: n as number };
    });
    if ('deadline' in rejected && rejected.deadline && rejected.now) {
      await logLate(c.teamId, u.id, 'edit_metadata', rejected.now, rejected.deadline, 'DEADLINE_PASSED', ip);
      throw new AppError('DEADLINE_PASSED', 'Metadata edits closed at the deadline');
    }
    return rejected;
  }
}
