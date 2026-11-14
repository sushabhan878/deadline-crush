// End-to-end smoke: login -> reset deadline -> start -> sign -> PUT parts to S3 -> complete -> wait for worker.
import { readFileSync } from 'node:fs';

const API = process.env.API ?? 'http://localhost:3000';
const HID = process.argv[2];
if (!HID) throw new Error('usage: tsx scripts/smoke.ts <hackathonId>');

async function j(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status} ${text}`);
  return data;
}
const login = async (email: string) => (await j('POST', '/auth/login', undefined, { email, password: 'password123' })).token as string;

const org = await login('organizer@demo.test');
await j('POST', `/hackathons/${HID}/reset-demo-deadline`, org);
console.log('deadline reset');

const tok = await login('team1@demo.test');
const me = await j('GET', '/me', tok);
console.log('me', JSON.stringify(me).slice(0, 200));
const submissionId = me.team?.submission_id;
if (!submissionId) throw new Error('no submissionId in /me');

const zip = readFileSync(new URL('./smoke.zip', import.meta.url));
const v = await j('POST', `/submissions/${submissionId}/versions`, tok,
  { filename: 'a.zip', size: zip.length, contentType: 'application/zip' }, { 'idempotency-key': crypto.randomUUID() });
console.log('started', JSON.stringify(v));
const vid = v.versionId ?? v.id;
const signed = await j('POST', `/versions/${vid}/parts/sign`, tok, { partNumbers: [1] });
const put = await fetch(signed.urls[0].url, { method: 'PUT', body: zip });
console.log('PUT part', put.status);
if (!put.ok) throw new Error(await put.text());
const etag = put.headers.get('etag')!;
const done = await j('POST', `/versions/${vid}/complete`, tok, { parts: [{ n: 1, etag }] });
console.log('complete', JSON.stringify(done));

for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  const cur = await j('GET', `/versions/${vid}`, tok);
  console.log('status', cur.status);
  if (['accepted', 'needs_fix'].includes(cur.status)) { console.log(JSON.stringify(cur, null, 1)); break; }
}
