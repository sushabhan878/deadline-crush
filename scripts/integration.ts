import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import { config, PART_SIZE, pool, storage } from '@dc/shared';

assert(process.env.DATABASE_URL && process.env.S3_ENDPOINT, 'Use a migrated test database and test bucket');
const root = process.env.API ?? 'http://127.0.0.1:3122';
const processes: ReturnType<typeof spawn>[] = [];
const spawnApp = (kind: 'api' | 'worker', extra = {}) => {
  const proc = spawn(process.execPath, ['--import', 'tsx', `apps/${kind}/src/main.ts`], {
    env: { ...process.env, PORT: '3122', LEASE_SECONDS: '4', WORKER_CONCURRENCY: '1', ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr?.pipe(process.stderr);
  processes.push(proc);
  return proc;
};
const waitFor = async <T,>(action: () => Promise<T>, predicate: (value: T) => boolean, ms = 40_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await action();
    if (predicate(value)) return value;
    await delay(200);
  }
  throw new Error('Timed out waiting for condition');
};
const request = (url: string, token?: string, body?: object, method = body ? 'POST' : 'GET', headers = {}) => fetch(root + url, {
  method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  body: body && JSON.stringify(body), signal: AbortSignal.timeout(20_000),
});
const json = async (url: string, token?: string, body?: object, method?: string, headers?: object) => {
  const response = await request(url, token, body, method, headers);
  const data = await response.json();
  assert(response.ok, `${url} ${response.status} ${JSON.stringify(data)}`);
  return data;
};
const expectCode = async (expected: string, response: Promise<Response>) => assert.equal((await (await response).json()).code, expected);

const run = randomUUID();
const zip = await readFile(new URL('./smoke.zip', import.meta.url));
const sha = createHash('sha256').update(zip).digest('hex');
const email = (role: string) => `${role}-${run}@qa.test`;
const password = randomUUID();
const file = { filename: 'project.zip', size: zip.length, contentType: 'application/zip' };

try {
  if (!process.env.API) spawnApp('api');
  await waitFor(() => request('/healthz').then((r) => r.ok).catch(() => false), Boolean);
  const { rows: [{ id: hid }] } = await pool.query(`INSERT INTO hackathons(name,join_code,starts_at,deadline_at)
    VALUES ('Integration QA',$1,now(),now()+interval '6 minutes') RETURNING id`, [run]);
  const participant = await json('/auth/signup', undefined, { name: 'Team lead', email: email('team'), password, joinCode: run, teamName: '=Formula test' });
  const token = participant.token;
  const { team } = await json('/me', token);
  const { token: teammate } = await json('/auth/signup', undefined, { name: 'Teammate', email: email('member'), password, joinCode: run, teamCode: team.invite_code });
  assert.equal((await json('/me', teammate)).team.team_id, team.team_id);
  const { token: other } = await json('/auth/signup', undefined, { name: 'Another', email: email('other'), password, joinCode: run, teamName: 'Another team' });
  const { rows: [admin] } = await pool.query(`INSERT INTO users(email,name,password_hash,role) VALUES ($1,'Integration organizer',$2,'organizer') RETURNING id`, [email('org'), await argon2.hash(password)]);
  const organizer = (await json('/auth/login', undefined, { email: email('org'), password })).token;
  const expired = jwt.sign({ id: admin.id, role: 'organizer' }, config.jwtSecret, { expiresIn: -5 });
  const dashboard = `/hackathons/${hid}/dashboard`;
  await expectCode('FORBIDDEN', request(dashboard, token));
  await expectCode('UNAUTHORIZED', request(dashboard, expired));
  const sid = `/submissions/${team.submission_id}`;
  const metadata = (title: string, links: string[] = []) => request(`${sid}/metadata`, token, { title, description: 'Integration fixture', links }, 'PUT');
  assert((await metadata('First title')).ok);
  assert((await metadata('Second title')).ok);
  assert.deepEqual((await json(`${sid}/metadata`, teammate)).history.map((row: any) => row.title), ['Second title', 'First title']);
  await expectCode('VALIDATION', metadata('Bad URL', ['http://localhost']));

  const events = await request(`/teams/${team.team_id}/events`, token);
  const reader = events.body!.getReader();
  const start = (body = file, key = randomUUID()) => json(`${sid}/versions`, token, body, 'POST', { 'Idempotency-Key': key });
  const put = async (v: { versionId: string }, bytes: Buffer, n = 1) => {
    const { urls: [part], expiresInSeconds } = await json(`/versions/${v.versionId}/parts/sign`, token, { partNumbers: [n] });
    assert(expiresInSeconds > 0 && expiresInSeconds <= 900);
    const r = await fetch(part.url, { method: 'PUT', body: new Uint8Array(bytes), signal: AbortSignal.timeout(30_000) });
    assert(r.ok, `PUT ${r.status} ${await r.text()}`);
    return r.headers.get('ETag')!;
  };
  const complete = (v: { versionId: string }, parts: { n: number; etag: string }[]) => json(`/versions/${v.versionId}/complete`, token, { parts });
  const key = randomUUID();
  const v = await start(file, key);
  assert.equal((await start(file, key)).versionId, v.versionId);
  await expectCode('NOT_A_MEMBER', request(`/versions/${v.versionId}/download`, other));
  await expectCode('NOT_A_MEMBER', request(`/versions/${v.versionId}/preview`, other));
  await expectCode('NOT_A_MEMBER', request(`/teams/${team.team_id}/events`, other));
  await expectCode('NOT_A_MEMBER', request(`/versions/${v.versionId}/abort`, organizer, {}));
  await expectCode('VALIDATION', request(`${sid}/versions`, token, { ...file, size: 104857601 }, 'POST', { 'Idempotency-Key': randomUUID() }));
  assert.deepEqual((await json(`/versions/${v.versionId}/parts`, token)).missing, [1]);
  const etag = await put(v, zip);
  assert.deepEqual((await json(`/versions/${v.versionId}/parts`, token)).missing, []);
  await expectCode('INVALID_PARTS', request(`/versions/${v.versionId}/complete`, token, { parts: [{ n: 1, etag: 'wrong' }] }));
  const receipts = await Promise.all(Array.from({ length: 10 }, () => complete(v, [{ n: 1, etag }])));
  assert(receipts.every((r) => r.receiptId === v.versionId));
  let stream = '';
  while (!stream.includes('event: version.uploaded')) stream += Buffer.from((await reader.read()).value ?? []).toString();
  await reader.cancel();
  const cursor = /id: (\d+)\nevent: version\.started/.exec(stream)?.[1];
  assert(cursor);
  const replay = (await request(`/teams/${team.team_id}/events`, token, undefined, 'GET', { 'Last-Event-ID': cursor })).body!.getReader();
  assert.match(Buffer.from((await replay.read()).value!).toString(), /version.uploaded/);
  await replay.cancel();

  const crash = spawnApp('worker', { CHAOS_CRASH_ON_JOB: '1' });
  let crashLog = '';
  crash.stdout?.on('data', (data) => { crashLog += data.toString(); });
  const crashExit = await Promise.race([once(crash, 'exit'), delay(15_000, 'timeout', { ref: false })]);
  assert(Array.isArray(crashExit) && crashExit[0] !== 0, `Crash worker exit: ${crashExit}`);
  assert.match(crashLog, /chaos: crashing after file type check/);
  assert.equal((await json(`/versions/${v.versionId}`, token)).status, 'checking');
  const replacement = spawnApp('worker');
  replacement.stdout?.resume();
  const check = (id: string) => json(`/versions/${id}`, token);
  const accepted = await waitFor(() => check(v.versionId), (r) => r.status === 'accepted');
  assert.equal(accepted.checks.length, 5);
  assert.equal(accepted.sha256, sha);
  const { rows: [proof] } = await pool.query(`SELECT (SELECT attempts FROM jobs WHERE version_id=$1) attempts,
    (SELECT count(*)::int FROM audit_events WHERE type='check.completed' AND payload->>'versionId'=$1::text) check_events,
    (SELECT count(*)::int FROM audit_events WHERE type='version.accepted' AND payload->>'versionId'=$1::text) accepted_events,
    (SELECT count(*)::int FROM receipts WHERE version_id=$1 AND sha256=$2) receipts`, [v.versionId, sha]);
  assert.deepEqual(proof, { attempts: 2, check_events: 5, accepted_events: 1, receipts: 1 });
  console.log('Crash recovery:', JSON.stringify({ crashExit, ...proof }));
  const preview = await json(`/versions/${v.versionId}/preview`, token);
  assert.equal(preview.kind, 'text');
  assert.match(await (await fetch(preview.url)).text(), /test|hello|demo|project/i);
  const own = await json(`/versions/${v.versionId}/download`, token);
  assert.equal(createHash('sha256').update(Buffer.from(await (await fetch(own.url)).arrayBuffer())).digest('hex'), sha);

  const bad = await start({ ...file, size: 8 });
  await complete(bad, [{ n: 1, etag: await put(bad, Buffer.from('notazip!')) }]);
  await waitFor(() => check(bad.versionId), (r) => r.status === 'needs_fix');
  assert.equal((await json(`${sid}/versions`, token)).find((r: any) => r.currently_counts).id, v.versionId);

  if (process.env.TEST_PDF !== '0') {
    const pdf = await readFile(new URL('./smoke.pdf', import.meta.url));
    const pdfVersion = await start({ filename: 'project.pdf', size: pdf.length, contentType: 'application/pdf' });
    await complete(pdfVersion, [{ n: 1, etag: await put(pdfVersion, pdf) }]);
    await waitFor(() => check(pdfVersion.versionId), (r) => r.status === 'accepted');
    const preview = await json(`/versions/${pdfVersion.versionId}/preview`, token);
    assert((await fetch(preview.url)).headers.get('content-type')?.includes('image/png'));
  }

  if (process.env.TEST_LARGE === '1') {
    const fullSize = 100 * 1024 * 1024;
    // A malformed ZIP exercises the exact byte limit independently of archive acceptance.
    const bytes = Buffer.alloc(fullSize);
    bytes.writeUInt32LE(0x04034b50, 0);
    const large = await start({ ...file, filename: 'maximum-size.zip', size: fullSize });
    const manifest: { n: number; etag: string }[] = [];
    for (let offset = 0; offset < bytes.length; offset += PART_SIZE) {
      const n = offset / PART_SIZE + 1;
      manifest.push({ n, etag: await put(large, bytes.subarray(offset, offset + PART_SIZE), n) });
      if (n === 1) assert.deepEqual((await json(`/versions/${large.versionId}/parts`, token)).missing, Array.from({ length: 12 }, (_, i) => i + 2));
    }
    await complete(large, manifest);
    const result = await waitFor(() => check(large.versionId), (r) => r.status === 'needs_fix');
    assert.equal(Number(result.actual_size), fullSize);
    assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
    console.log('Maximum size test: 104857600 bytes, 13 direct parts, resumed from listed parts; file hash matched after worker readback.');
  }

  const grace = await start({ filename: 'multipart.zip', size: PART_SIZE + 1, contentType: 'application/zip' });
  const first = await put(grace, Buffer.alloc(PART_SIZE));
  const second = await put(grace, Buffer.from([42]), 2);
  await pool.query(`UPDATE hackathons SET deadline_at=clock_timestamp()-interval '1 second' WHERE id=$1`, [hid]);
  await expectCode('DEADLINE_PASSED', metadata('Late edit'));
  await expectCode('DEADLINE_PASSED', request(`${sid}/versions`, token, file, 'POST', { 'Idempotency-Key': randomUUID() }));
  await complete(grace, [{ n: 1, etag: first }, { n: 2, etag: second }]);
  assert.equal((await check(grace.versionId)).completed_in_grace, true);
  const csv = await (await request(`/hackathons/${hid}/export.csv`, organizer)).text();
  assert.match(csv, /"'=Formula test"/);
  const late = await (await request(`/hackathons/${hid}/late-attempts.csv`, organizer)).text();
  assert.match(late, /edit_metadata/);
  assert.equal((await json(dashboard, organizer)).lateAttempts, 2);
  assert.equal((await json('/status')).storage, 'ok');
  assert(await storage.ping());
  console.log('Integration passed: auth, metadata, isolation, signed multipart, grace, SSE replay, worker kill, hash, preview, fallback, dashboard and exports.');
} finally {
  processes.forEach((proc) => proc.kill());
  await pool.end();
}
