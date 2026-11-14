import pg from 'pg';
import type { Clock } from './clock';

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://dc:dc@localhost:5433/dc',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret',
  s3: {
    endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    publicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT ?? 'http://localhost:9000',
    region: process.env.S3_REGION ?? 'us-east-1',
    bucket: process.env.S3_BUCKET ?? 'submissions',
    accessKey: process.env.S3_ACCESS_KEY ?? 'minioadmin',
    secretKey: process.env.S3_SECRET_KEY ?? 'minioadmin',
  },
  port: Number(process.env.PORT ?? process.env.API_PORT ?? 3000),
  webOrigin: process.env.WEB_ORIGIN ?? process.env.RENDER_EXTERNAL_URL ?? 'http://localhost:5173',
  workerConcurrency: Number(process.env.WORKER_CONCURRENCY ?? 4),
};

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });
export type Tx = pg.PoolClient;

/** Run fn in a transaction. */
export async function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Production clock: database wall time, including time spent waiting for locks. */
export class DbClock implements Clock {
  async now() {
    return (await pool.query('SELECT now() AS n')).rows[0].n as Date;
  }
}
export async function txNow(tx: Tx): Promise<Date> {
  return (await tx.query('SELECT clock_timestamp() AS n')).rows[0].n;
}

export async function audit(
  tx: Tx, hackathonId: string, teamId: string | null, actorId: string | null,
  type: string, payload: Record<string, unknown> = {},
) {
  const r = await tx.query(
    `INSERT INTO audit_events (hackathon_id, team_id, actor_id, type, payload) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [hackathonId, teamId, actorId, type, JSON.stringify(payload)]);
  await tx.query(`SELECT pg_notify('events', $1)`, [String(r.rows[0].id)]);
}

export type VersionStatus = 'uploading' | 'uploaded' | 'checking' | 'accepted' | 'needs_fix' | 'aborted' | 'expired';

/** The ONE place statuses change. Zero rows = lost race => no-op (returns false). */
export async function transition(
  tx: Tx, versionId: string, from: VersionStatus | VersionStatus[], to: VersionStatus,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const froms = Array.isArray(from) ? from : [from];
  const sets = ['status = $2'];
  const vals: unknown[] = [versionId, to, froms];
  for (const [k, v] of Object.entries(extra)) {
    if (!/^[a-z_][a-z_0-9]*$/.test(k)) throw new Error('bad column');
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  const r = await tx.query(`UPDATE file_versions SET ${sets.join(', ')} WHERE id = $1 AND status = ANY($3)`, vals);
  return (r.rowCount ?? 0) > 0;
}
