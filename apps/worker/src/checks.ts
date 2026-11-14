import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { audit, pool, storage, transition, withTx } from '@dc/shared';
import { checkLink } from './ssrf';
import { analyzeEntries, readCentralDirectory, readEntry, type ZipEntry } from './zip';

type Status = 'pass' | 'fail' | 'skipped';
interface Result { status: Status; detail: Record<string, unknown>; reason?: string; hint?: string }

export function detectType(head: Buffer): 'pdf' | 'zip' | null {
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4) return 'zip';
  return null;
}

export async function runChecks(v: any, afterFirstCheck: () => void) {
  const results: Record<string, Result> = {};
  const run = async (name: string, fn: () => Promise<Result>) => {
    const r = await fn().catch((e): Result => ({ status: 'fail', detail: {}, reason: `${name} check error: ${(e as Error).message}`, hint: 'Re-upload the file.' }));
    results[name] = r;
    return r;
  };

  let detected: 'pdf' | 'zip' | null = null;
  let entries: ZipEntry[] = [];
  const size = Number(v.actual_size);
  const rangeRead = (s: number, e: number) => storage.rangeGet(v.s3_key, `bytes=${s}-${e}`);

  await run('type', async () => {
    const head = await rangeRead(0, Math.min(size, 4096) - 1);
    detected = detectType(head);
    const ext = v.declared_filename.split('.').pop()?.toLowerCase();
    if (!detected) return { status: 'fail', detail: {}, reason: 'TYPE_MISMATCH: content is not a PDF or ZIP', hint: 'Upload a real PDF or ZIP file.' };
    if (ext !== detected) return { status: 'fail', detail: { detected }, reason: `TYPE_MISMATCH: file is named .${ext} but contains ${detected}`, hint: 'Rename the file to match its real type.' };
    return { status: 'pass', detail: { detected } };
  });
  afterFirstCheck();

  await run('archive', async () => {
    if (detected !== 'zip') return { status: 'skipped', detail: {} };
    entries = await readCentralDirectory(size, rangeRead);
    const problems = analyzeEntries(entries, size);
    return problems.length
      ? { status: 'fail', detail: { problems }, reason: `Unsafe archive: ${problems.slice(0, 3).join('; ')}`, hint: 'Remove encrypted, nested, oversized or path-escaping entries.' }
      : { status: 'pass', detail: { entries: entries.length } };
  });

  await run('links', async () => {
    const links: string[] = v.links_snapshot ?? (await pool.query('SELECT current_links FROM submissions WHERE id=$1', [v.submission_id])).rows[0].current_links;
    if (!links.length) return { status: 'skipped', detail: {} };
    const rs = await Promise.all(links.map((l) => checkLink(l)));
    const bad = rs.filter((r) => !r.ok);
    return bad.length
      ? { status: 'fail', detail: { results: rs }, reason: `LINK_UNREACHABLE: ${bad.map((b) => b.url).join(', ')}`, hint: 'Make sure these links are public https URLs.' }
      : { status: 'pass', detail: { results: rs } };
  });

  await run('preview', async () => {
    if (results.type.status === 'fail' || results.archive.status === 'fail') return { status: 'skipped', detail: {} };
    if (detected === 'zip') {
      const readme = entries.find((e) => /^(?:[^/]+\/)?readme\.(md|txt)$/i.test(e.name));
      if (!readme) return { status: 'skipped', detail: { note: 'no README' } };
      const buf = (await readEntry(readme, rangeRead, 20 * 1024)).subarray(0, 20 * 1024);
      const key = `previews/${v.id}.txt`;
      await storage.put(key, buf, 'text/plain; charset=utf-8');
      return { status: 'pass', detail: { key } };
    }
    return renderPdfPreview(v);
  });

  await run('hash', async () => {
    const h = createHash('sha256');
    let n = 0;
    for await (const chunk of await storage.stream(v.s3_key)) { h.update(chunk as Buffer); n += (chunk as Buffer).length; }
    if (n !== size) return { status: 'fail', detail: { n }, reason: 'SIZE_MISMATCH while hashing', hint: 'Re-upload the file.' };
    const sha = h.digest('hex');
    return { status: 'pass', detail: { sha256: sha } };
  });

  return results;
}

/** PDF first page -> PNG via pdftoppm (restricted subprocess: timeout, no shell). */
async function renderPdfPreview(v: any): Promise<Result> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-'));
  try {
    const src = path.join(dir, 'in.pdf');
    await pipeline(await storage.stream(v.s3_key), fs.createWriteStream(src));
    const out = path.join(dir, 'out');
    const res = await new Promise<{ err: any }>((resolve) =>
      execFile('pdftoppm', ['-png', '-f', '1', '-l', '1', '-scale-to', '1200', src, out],
        { timeout: 20_000, env: { PATH: process.env.PATH } }, (err) => resolve({ err })));
    if (res.err?.code === 'ENOENT') return { status: 'fail', detail: {}, reason: 'PDF preview service unavailable', hint: 'Contact the organizer.' };
    const png = fs.readdirSync(dir).find((f) => f.startsWith('out') && f.endsWith('.png'));
    if (res.err || !png) return { status: 'fail', detail: {}, reason: 'PDF could not be rendered', hint: 'Re-export the PDF.' };
    const key = `previews/${v.id}.png`;
    await storage.put(key, fs.readFileSync(path.join(dir, png)), 'image/png');
    return { status: 'pass', detail: { key } };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Final decision in ONE transaction with audit + notify (F-11). Safe to re-run. */
export async function finalize(v: any, jobId: number, workerId: string, results: Record<string, Result>) {
  return withTx(async (tx) => {
    const job = await tx.query(`SELECT 1 FROM jobs WHERE id=$1 AND locked_by=$2 AND state='running'
      AND lease_expires_at > clock_timestamp() FOR UPDATE`, [jobId, workerId]);
    if (!job.rowCount) return false;
    const versionId = v.id;
    for (const [name, result] of Object.entries(results)) {
      await tx.query(`INSERT INTO check_results (version_id,check_name,status,detail) VALUES ($1,$2,$3,$4)
        ON CONFLICT (version_id,check_name) DO UPDATE SET status=EXCLUDED.status, detail=EXCLUDED.detail, finished_at=now()`,
      [versionId, name, result.status, JSON.stringify({ ...result.detail, reason: result.reason, hint: result.hint })]);
      await audit(tx, v.hackathon_id, v.team_id, null, 'check.completed', { versionId, check: name, status: result.status });
    }
    const sha = results.hash.detail.sha256 ?? null;
    const mime = results.type.detail.detected === 'pdf' ? 'application/pdf' : results.type.detail.detected === 'zip' ? 'application/zip' : null;
    await tx.query('UPDATE receipts SET sha256=$2 WHERE version_id=$1', [versionId, sha]);
    const fields = { sha256: sha, detected_mime: mime, finalized_at: new Date() };
    const failed = Object.entries(results).filter(([, result]) => result.status === 'fail');
    if (failed.length) {
      const summary = failed.map(([name, result]) => `${result.reason ?? name}${result.hint ? ` · ${result.hint}` : ''}`).join('\n');
      if (await transition(tx, versionId, ['checking', 'uploaded'], 'needs_fix', { ...fields, failure_summary: summary }))
        await audit(tx, v.hackathon_id, v.team_id, null, 'version.needs_fix', { versionId, reasons: failed.map(([name]) => name) });
    } else if (await transition(tx, versionId, ['checking', 'uploaded'], 'accepted', fields)) {
      await audit(tx, v.hackathon_id, v.team_id, null, 'version.accepted', { versionId });
    }
    await tx.query(`UPDATE jobs SET state='done', locked_by=NULL, lease_expires_at=NULL WHERE id=$1`, [jobId]);
    return true;
  });
}
