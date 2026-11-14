import { Body, Controller, Get, Headers, Param, Post, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  AppError, PART_SIZE, audit, canComplete, canStart, completeSchema, pool, signExpirySeconds, signPartsSchema,
  finishStorage, recordUploaded, startUploadSchema, storage, totalParts, transition, txNow, withTx,
} from '@dc/shared';
import { AuthGuard, AuthUser, Ip, TeamCtx, TeamMemberGuard, User, logLate, parse } from './common';

const safeName = (n: string) => n.replace(/[^\w.\- ]/g, '_').slice(0, 200);
const ext = (n: string) => n.split('.').pop()?.toLowerCase() ?? '';
const storedResponse = (v: any) => ({
  versionId: v.id, versionNo: v.version_no, partSize: v.part_size, totalParts: v.total_parts, status: v.status,
});

async function loadVersion(id: string) {
  const r = await pool.query('SELECT * FROM file_versions WHERE id=$1', [id]);
  if (!r.rowCount) throw new AppError('NOT_FOUND', 'Version not found');
  return r.rows[0];
}
const hackathon = async (id: string) =>
  (await pool.query('SELECT * FROM hackathons WHERE id=$1', [id])).rows[0];

@Controller('submissions')
@UseGuards(AuthGuard, TeamMemberGuard)
export class StartController {
  @Get(':id/versions')
  async list(@Param('id') _id: string, @TeamCtx() c: any) {
    const r = await pool.query(
      `SELECT id, version_no, status, declared_filename, declared_size, actual_size, sha256, started_at, completed_at,
              started_in_time, completed_in_grace, counts, failure_summary,
              (id = (SELECT id FROM file_versions WHERE submission_id=$1 AND status='accepted' AND counts
                     ORDER BY version_no DESC LIMIT 1)) AS currently_counts
       FROM file_versions WHERE submission_id=$1 ORDER BY version_no DESC`, [c.submissionId]);
    return r.rows;
  }

  /** F-05 start upload (idempotent, deadline-gated, 1 active upload per team). */
  @Post(':id/versions')
  async start(@Param('id') _id: string, @Body() body: unknown, @Headers('idempotency-key') key: string | undefined,
    @TeamCtx() c: any, @User() u: AuthUser, @Ip() ip: string) {
    const b = parse(startUploadSchema, body);
    if (!key || !/^[\w-]{1,128}$/.test(key)) throw new AppError('VALIDATION', 'A valid Idempotency-Key header is required');
    const res = await withTx(async (tx) => {
      // Lock submission: serializes version_no allocation and idempotency checks.
      await tx.query('SELECT 1 FROM submissions WHERE id=$1 FOR UPDATE', [c.submissionId]);
      const prior = await tx.query('SELECT * FROM file_versions WHERE submission_id=$1 AND idempotency_key=$2', [c.submissionId, key]);
      if (prior.rowCount) {
        const v = prior.rows[0];
        if (Number(v.declared_size) !== b.size || v.declared_filename !== safeName(b.filename)) {
          throw new AppError('VERSION_STATE_CONFLICT', 'Idempotency key already used for another file');
        }
        return { ok: storedResponse(v) };
      }
      const h = (await tx.query('SELECT * FROM hackathons WHERE id=$1', [c.hackathonId])).rows[0];
      const now = await txNow(tx);
      if (!canStart(now, h.deadline_at)) return { late: { now, deadline: h.deadline_at as Date } };
      if (b.size > Number(h.max_file_bytes)) throw new AppError('VALIDATION', 'File too large', { max: Number(h.max_file_bytes) });
      if (!h.allowed_types.includes(ext(b.filename))) throw new AppError('VALIDATION', `Allowed types: ${h.allowed_types.join(', ')}`);
      const cnt = await tx.query('SELECT count(*)::int n FROM file_versions WHERE submission_id=$1', [c.submissionId]);
      if (cnt.rows[0].n >= 50) throw new AppError('RATE_LIMITED', 'Max 50 versions');

      // Abort any previous active upload.
      const old = await tx.query(`SELECT * FROM file_versions WHERE submission_id=$1 AND status='uploading' FOR UPDATE`, [c.submissionId]);
      for (const o of old.rows) {
        if (o.completion_parts) {
          await finishStorage(o);
          await recordUploaded(tx, o, c.hackathonId, c.teamId, u.id, Number(o.declared_size), o.completion_requested_at);
          continue;
        }
        await transition(tx, o.id, 'uploading', 'aborted');
        await audit(tx, c.hackathonId, c.teamId, u.id, 'version.aborted', { versionId: o.id, reason: 'superseded' });
      }
      const id = randomUUID();
      const s3Key = `h/${c.hackathonId}/t/${c.teamId}/v/${id}`;
      // S3 call first inside tx: failure rolls back, no orphan DB row (PRD F-05 AC).
      const uploadId = await storage.createMultipart(s3Key, b.contentType);
      const n = (await tx.query('SELECT coalesce(max(version_no),0)+1 n FROM file_versions WHERE submission_id=$1', [c.submissionId])).rows[0].n;
      const ins = await tx.query(
        `INSERT INTO file_versions (id,submission_id,version_no,idempotency_key,status,s3_key,s3_upload_id,part_size,total_parts,declared_size,declared_filename,started_at)
         VALUES ($1,$2,$3,$4,'uploading',$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [id, c.submissionId, n, key, s3Key, uploadId, PART_SIZE, totalParts(b.size), b.size, safeName(b.filename), now]);
      await audit(tx, c.hackathonId, c.teamId, u.id, 'version.started', { versionId: id, versionNo: n, size: b.size });
      return { ok: storedResponse(ins.rows[0]), old: old.rows, expiresAt: new Date(h.deadline_at.getTime() + h.grace_seconds * 1000) };
    });
    if ('late' in res && res.late) {
      await logLate(c.teamId, u.id, 'start_upload', res.late.now, res.late.deadline, 'DEADLINE_PASSED', ip);
      throw new AppError('DEADLINE_PASSED', 'The deadline has passed');
    }
    if (res.old) await Promise.all(res.old.map((v) => storage.abort(v.s3_key, v.s3_upload_id)));
    return { ...res.ok, expiresAt: res.expiresAt };
  }
}

@Controller('versions')
@UseGuards(AuthGuard, TeamMemberGuard)
export class VersionsController {
  @Get(':id')
  async get(@Param('id') id: string) {
    const v = await loadVersion(id);
    const checks = await pool.query('SELECT check_name, status, detail, finished_at FROM check_results WHERE version_id=$1', [id]);
    const { s3_key, s3_upload_id, ...pub } = v;
    return { ...pub, checks: checks.rows };
  }

  /** F-06 sign parts. */
  @Post(':id/parts/sign')
  async sign(@Param('id') id: string, @Body() body: unknown, @TeamCtx() c: any) {
    const { partNumbers } = parse(signPartsSchema, body);
    const v = await loadVersion(id);
    if (v.status !== 'uploading' || v.completion_parts) throw new AppError('VERSION_STATE_CONFLICT', 'This version no longer accepts parts');
    const h = await hackathon(c.hackathonId);
    const now = (await pool.query('SELECT now() n')).rows[0].n as Date;
    const exp = signExpirySeconds(now, h.deadline_at, h.grace_seconds);
    if (exp <= 0) throw new AppError('GRACE_EXPIRED', 'Upload window closed');
    if (partNumbers.some((n) => n > v.total_parts)) throw new AppError('INVALID_PARTS', 'Part beyond total parts');
    const urls = await Promise.all(partNumbers.map(async (n) => {
      const size = Math.min(v.part_size, Number(v.declared_size) - (n - 1) * v.part_size);
      return { n, url: await storage.signPart(v.s3_key, v.s3_upload_id, n, size, exp) };
    }));
    return { urls, expiresInSeconds: exp };
  }

  /** F-08 list parts + reconcile into upload_parts. */
  @Get(':id/parts')
  async parts(@Param('id') id: string) {
    const v = await loadVersion(id);
    if (v.status !== 'uploading') return { uploaded: [], missing: [], status: v.status };
    if (v.completion_parts) return { uploaded: v.completion_parts, missing: [], status: 'completing' };
    const up = await storage.listParts(v.s3_key, v.s3_upload_id);
    for (const p of up) {
      await pool.query(
        `INSERT INTO upload_parts (version_id,part_no,etag,size) VALUES ($1,$2,$3,$4)
         ON CONFLICT (version_id,part_no) DO UPDATE SET etag=EXCLUDED.etag,size=EXCLUDED.size,uploaded_at=now()`,
        [id, p.n, p.etag, p.size]);
    }
    const have = new Set(up.map((p) => p.n));
    const missing = Array.from({ length: v.total_parts }, (_, i) => i + 1).filter((n) => !have.has(n));
    return { uploaded: up, missing, status: v.status };
  }

  /** F-09 complete. Idempotent by state; acknowledged => committed. */
  @Post(':id/complete')
  async complete(@Param('id') id: string, @Body() body: unknown, @TeamCtx() c: any, @User() u: AuthUser, @Ip() ip: string) {
    const { parts } = parse(completeSchema, body);
    const done = (v: any) => ({ status: v.status, receiptId: v.id, versionNo: v.version_no });
    const ready = await withTx(async (tx) => {
      const v = (await tx.query('SELECT * FROM file_versions WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (['uploaded', 'checking', 'accepted', 'needs_fix'].includes(v.status)) {
        return { done: done(v) };
      }
      const h = (await tx.query('SELECT * FROM hackathons WHERE id=$1', [c.hackathonId])).rows[0];
      const now = await txNow(tx);
      if (v.status === 'expired') return { late: { now, deadline: new Date(h.deadline_at.getTime() + h.grace_seconds * 1000) } };
      if (v.status !== 'uploading') throw new AppError('VERSION_STATE_CONFLICT', `Version is ${v.status}`);
      if (v.completion_parts) return {};
      if (!canComplete(now, h.deadline_at, h.grace_seconds)) {
        await transition(tx, id, 'uploading', 'expired', { finalized_at: now });
        await audit(tx, c.hackathonId, c.teamId, u.id, 'version.expired', { versionId: id });
        return { late: { now, deadline: new Date(h.deadline_at.getTime() + h.grace_seconds * 1000) }, cleanup: v };
      }
      const listed = await storage.listParts(v.s3_key, v.s3_upload_id);
      const sorted = [...parts].sort((a, b) => a.n - b.n);
      const valid = sorted.length === v.total_parts && listed.length === sorted.length &&
        sorted.every((p, i) => p.n === i + 1 && listed[i].n === p.n && listed[i].etag === p.etag);
      if (!valid) throw new AppError('INVALID_PARTS', 'Parts do not match what storage received');
      if (listed.some((p, i) => p.size !== Math.min(v.part_size, Number(v.declared_size) - i * v.part_size))) {
        throw new AppError('SIZE_MISMATCH', 'Uploaded size differs from declared size');
      }
      await tx.query(`UPDATE file_versions SET completion_requested_at=$2, links_snapshot=(SELECT current_links FROM submissions WHERE id=$3),
        completion_parts=$4 WHERE id=$1`, [id, now, c.submissionId, JSON.stringify(sorted)]);
      return {};
    });
    if (ready.late) {
      if (ready.cleanup) await storage.abort(ready.cleanup.s3_key, ready.cleanup.s3_upload_id);
      await logLate(c.teamId, u.id, 'complete_upload', ready.late.now, ready.late.deadline, 'GRACE_EXPIRED', ip);
      throw new AppError('GRACE_EXPIRED', 'Upload window closed');
    }
    if (ready.done) return ready.done;
    return withTx(async (tx) => {
      const v = (await tx.query('SELECT * FROM file_versions WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (['uploaded', 'checking', 'accepted', 'needs_fix'].includes(v.status)) return done(v);
      if (v.status !== 'uploading') throw new AppError('VERSION_STATE_CONFLICT', `Version is ${v.status}`);
      await finishStorage(v);
      await recordUploaded(tx, v, c.hackathonId, c.teamId, u.id, Number(v.declared_size), v.completion_requested_at);
      return done({ ...v, status: 'uploaded' });
    });
  }

  @Post(':id/abort')
  async abort(@Param('id') id: string, @TeamCtx() c: any, @User() u: AuthUser) {
    const v = await loadVersion(id);
    const moved = await withTx(async (tx) => {
      const current = (await tx.query('SELECT completion_parts FROM file_versions WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (current.completion_parts) return false;
      const ok = await transition(tx, id, 'uploading', 'aborted', { finalized_at: new Date() });
      if (ok) await audit(tx, c.hackathonId, c.teamId, u.id, 'version.aborted', { versionId: id });
      return ok;
    });
    if (moved && v.s3_upload_id) await storage.abort(v.s3_key, v.s3_upload_id);
    return { aborted: moved };
  }

  @Get(':id/download')
  async download(@Param('id') id: string, @TeamCtx() c: any, @User() u: AuthUser) {
    const v = await loadVersion(id);
    if (!['uploaded', 'checking', 'accepted', 'needs_fix'].includes(v.status)) throw new AppError('VERSION_STATE_CONFLICT', 'No file yet');
    if (u.role !== 'participant') await withTx((tx) => audit(tx, c.hackathonId, c.teamId, u.id, 'organizer.download', { versionId: id }));
    return { url: await storage.downloadUrl(v.s3_key, v.declared_filename, 60) };
  }

  @Get(':id/preview')
  async preview(@Param('id') id: string) {
    const r = await pool.query(`SELECT detail FROM check_results WHERE version_id=$1 AND check_name='preview' AND status='pass'`, [id]);
    const key = r.rows[0]?.detail?.key as string | undefined;
    if (!key) throw new AppError('NOT_FOUND', 'No preview');
    return { url: await storage.previewUrl(key, 60), kind: key.endsWith('.png') ? 'image' : 'text' };
  }
}
