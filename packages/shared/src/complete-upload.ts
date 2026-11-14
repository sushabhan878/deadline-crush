import { audit, transition, type Tx } from './db';
import { storage } from './s3';

/** A committed manifest is safe to replay even when the original API request vanished. */
export async function finishStorage(v: { s3_key: string; s3_upload_id: string; declared_size: string; completion_parts: { n: number; etag: string }[] }) {
  try {
    await storage.complete(v.s3_key, v.s3_upload_id, v.completion_parts);
  } catch (error) {
    if ((await storage.head(v.s3_key))?.size !== Number(v.declared_size)) throw error;
  }
}

/** Commit the upload, queue job and receipt together in the transaction holding the version lock. */
export async function recordUploaded(tx: Tx, v: { id: string; version_no: number },
  hackathonId: string, teamId: string, actorId: string | null, size: number, receivedAt: Date) {
  const moved = await transition(tx, v.id, 'uploading', 'uploaded', {
    actual_size: size, completed_at: receivedAt, completed_in_grace: true, counts: true,
  });
  if (!moved) return;
  await tx.query(`INSERT INTO jobs (version_id) VALUES ($1) ON CONFLICT (version_id, kind) DO NOTHING`, [v.id]);
  await tx.query(`INSERT INTO receipts (version_id) VALUES ($1) ON CONFLICT DO NOTHING`, [v.id]);
  await audit(tx, hackathonId, teamId, actorId, 'version.uploaded', { versionId: v.id, versionNo: v.version_no });
}
