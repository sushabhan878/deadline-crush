/**
 * In-browser fake backend for demo mode (?demo=1). Mirrors the real API's response shapes closely enough
 * to exercise every screen without Postgres/S3. Never used when demo mode is off.
 */
const HID = '00000000-0000-4000-8000-000000000001';
const SUB = '00000000-0000-4000-8000-0000000000a1';
const TEAM = '00000000-0000-4000-8000-0000000000b1';
const PART = 8 * 1024 * 1024;
const now = () => Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const uid = () => crypto.randomUUID();
const delay = (ms = 120) => new Promise((r) => setTimeout(r, ms));
const hex = (n: number) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

class MockError extends Error { constructor(public code: string, message: string, public status: number) { super(message); } }

const KEY = 'dc_demo_state';
interface V {
  id: string; version_no: number; status: string; declared_filename: string; declared_size: number; actual_size: number | null;
  sha256: string | null; started_at: string; completed_at: string | null; started_in_time: boolean; counts: boolean;
  failure_summary: string | null; total_parts: number; uploaded: number[]; doneAt?: number; bad?: boolean;
}
interface S {
  deadline: number; grace: number; role: string | null; email: string;
  meta: { title: string; description: string; links: string[]; updated_at: string };
  history: { version_no: number; title: string; description: string; links: string[]; created_at: string; in_time: boolean }[];
  versions: V[]; late: number;
}
const fresh = (): S => ({
  deadline: now() + (37 * 3600 + 31 * 60 + 57) * 1000, grace: 300, role: null, email: '',
  meta: { title: 'Race-proof team formation', description: 'Seat allocation with row-level locks and idempotent joins.', links: ['https://github.com/demo/team-formation'], updated_at: iso(now() - 3600e3) },
  history: [{ version_no: 1, title: 'Race-proof team formation', description: 'Seat allocation with row-level locks and idempotent joins.', links: ['https://github.com/demo/team-formation'], created_at: iso(now() - 3600e3), in_time: true }],
  versions: [{
    id: uid(), version_no: 1, status: 'accepted', declared_filename: 'team-formation-v1.zip', declared_size: 4_812_331, actual_size: 4_812_331,
    sha256: hex(64), started_at: iso(now() - 3500e3), completed_at: iso(now() - 3490e3), started_in_time: true, counts: true,
    failure_summary: null, total_parts: 1, uploaded: [1], doneAt: now() - 3490e3,
  }],
  late: 0,
});
let st: S = (() => { try { return JSON.parse(sessionStorage.getItem(KEY) ?? '') as S; } catch { return fresh(); } })();
const save = () => sessionStorage.setItem(KEY, JSON.stringify(st));

/** Simulated worker: uploaded -> checking (1.5s) -> accepted/needs_fix (4s). */
function advance(v: V) {
  if (!v.doneAt || !['uploaded', 'checking'].includes(v.status)) return;
  const age = now() - v.doneAt;
  if (age > 4000) {
    v.status = v.bad ? 'needs_fix' : 'accepted';
    v.sha256 = hex(64);
    v.failure_summary = v.bad ? 'LINK_UNREACHABLE: https://example.invalid returned no response\nFix: make every link public and reachable over https.' : null;
  } else if (age > 1500) v.status = 'checking';
}
const checksFor = (v: V) => {
  if (!['accepted', 'needs_fix'].includes(v.status)) return v.status === 'checking' ? [
    { check_name: 'type', status: 'pass', detail: { mime: v.declared_filename.endsWith('.pdf') ? 'application/pdf' : 'application/zip' } },
  ] : [];
  const zip = v.declared_filename.endsWith('.zip');
  return [
    { check_name: 'type', status: 'pass', detail: { mime: zip ? 'application/zip' : 'application/pdf' } },
    { check_name: 'archive', status: zip ? 'pass' : 'skipped', detail: zip ? { entries: 42, uncompressed: 18_220_114 } : { reason: 'not an archive' } },
    { check_name: 'links', status: v.bad ? 'fail' : 'pass', detail: v.bad ? { reason: 'https://example.invalid: DNS lookup failed' } : { checked: st.meta.links.length } },
    { check_name: 'preview', status: 'pass', detail: { key: 'p.png' } },
    { check_name: 'hash', status: 'pass', detail: { sha256: v.sha256 } },
  ];
};
const counting = () => st.versions.find((v) => v.status === 'accepted' && v.counts);
const listV = () => { st.versions.forEach(advance); save(); const c = counting(); return st.versions.map((v) => ({ ...v, currently_counts: c?.id === v.id })); };

const TEAMS = ['Byte Brigade', 'Null Pointers', 'Race Conditions', 'Deadline Crushers', 'Async Avengers', 'Merge Conflict', 'Stack Smashers', 'Lambda Lions', 'Kernel Panic', 'Hot Reloaders', 'Zero Day', 'Cache Me'];
const STATUSES = ['accepted', 'accepted', 'accepted', 'checking', 'needs_fix', 'uploading', 'accepted', null, 'accepted', 'needs_fix', 'uploaded', 'accepted'];
const orgRows = () => TEAMS.map((name, i) => {
  const s = i === 0 ? (listV()[0]?.status ?? null) : STATUSES[i];
  return {
    team_id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, team_name: i === 0 ? 'Team 1 (you)' : name,
    title: s ? `${name} project` : '', counting_version: s === 'accepted' || i % 5 === 4 ? (i % 3) + 1 : null, latest_version: s ? (i % 3) + 1 : null,
    latest_status: s, in_time: s ? true : null, fallback_used: s === 'needs_fix' && i % 5 === 4, size_bytes: s ? 1_000_000 + i * 731_337 : null,
    sha256: s ? hex(64) : null, late_attempts: i % 4 === 3 ? 2 : 0, last_activity: iso(now() - i * 610e3),
  };
});

export async function mockApi(method: string, path: string, body: any): Promise<any> {
  await delay();
  const [p, qs] = path.split('?');
  const q = new URLSearchParams(qs);
  const seg = p.split('/').filter(Boolean);
  const open = now() < st.deadline, inGrace = now() < st.deadline + st.grace * 1000;
  const user = () => {
    if (!st.role) throw new MockError('UNAUTHORIZED', 'Missing token', 401);
    return { id: 'u1', role: st.role, email: st.email };
  };

  if (p === '/auth/login' || p === '/auth/signup') {
    const email = String(body.email ?? '').toLowerCase();
    if (p === '/auth/login' && body.password !== 'password123') throw new MockError('UNAUTHORIZED', 'Invalid credentials', 401);
    st.role = email.startsWith('organizer') ? 'organizer' : 'participant'; st.email = email; save();
    return { token: 'demo-token', user: user() };
  }
  if (p === '/me') return { user: user(), team: st.role === 'participant' ? { team_id: TEAM, team_name: 'Team 1', invite_code: 'h4h-7k2q', hackathon_id: HID, submission_id: SUB } : null };
  if (p === '/time') return { serverNow: iso(now()), deadlineAt: iso(st.deadline), graceEndsAt: iso(st.deadline + st.grace * 1000), phase: open ? 'open' : inGrace ? 'grace' : 'closed' };
  if (p === '/hackathon-info') return {
    id: HID, name: 'Hack4Hack Crew Hiring Challenge 2026', startsAt: iso(now() - 13 * 864e5), deadlineAt: iso(st.deadline), graceSeconds: st.grace,
    maxFileBytes: 100 * 1024 * 1024, allowedTypes: ['pdf', 'zip'], maxLinks: 5, registered: 299, teams: 287, phase: open ? 'open' : inGrace ? 'grace' : 'closed',
  };
  if (p === '/status') return { api: 'ok', db: 'ok', storage: 'ok', worker: 'ok', activeWorkers: 4, queueLagSeconds: 1, latencyMs: 7, checkedAt: iso(now()) };

  user();
  if (seg[0] === 'submissions' && seg[2] === 'metadata') {
    if (method === 'GET') return { current: st.meta, history: st.history };
    if (!open) { st.late++; save(); throw new MockError('DEADLINE_PASSED', 'Metadata edits closed at the deadline', 403); }
    const n = st.history.length + 1;
    st.meta = { ...body, updated_at: iso(now()) };
    st.history.unshift({ version_no: n, ...body, created_at: iso(now()), in_time: true }); save();
    return { versionNo: n };
  }
  if (seg[0] === 'submissions' && seg[2] === 'versions') {
    if (method === 'GET') return listV();
    if (!open) { st.late++; save(); throw new MockError('DEADLINE_PASSED', 'The deadline has passed', 403); }
    st.versions.filter((v) => v.status === 'uploading').forEach((v) => (v.status = 'aborted'));
    const total = Math.max(1, Math.ceil(body.size / PART));
    const v: V = {
      id: uid(), version_no: (st.versions[0]?.version_no ?? 0) + 1, status: 'uploading', declared_filename: body.filename, declared_size: body.size,
      actual_size: null, sha256: null, started_at: iso(now()), completed_at: null, started_in_time: true, counts: false, failure_summary: null,
      total_parts: total, uploaded: [], bad: /bad|broken|fail/i.test(body.filename),
    };
    st.versions.unshift(v); save();
    return { versionId: v.id, versionNo: v.version_no, partSize: PART, totalParts: total, status: 'uploading', expiresAt: iso(st.deadline + st.grace * 1000) };
  }
  if (seg[0] === 'versions') {
    const v = st.versions.find((x) => x.id === seg[1]);
    if (!v) throw new MockError('NOT_FOUND', 'Version not found', 404);
    advance(v); save();
    if (!seg[2]) return { ...v, checks: checksFor(v) };
    if (seg[2] === 'parts' && seg[3] === 'sign') {
      if (v.status !== 'uploading') throw new MockError('VERSION_STATE_CONFLICT', `Version is ${v.status}`, 409);
      if (!inGrace) throw new MockError('GRACE_EXPIRED', 'Upload window closed', 409);
      return { urls: body.partNumbers.map((n: number) => ({ n, url: `demo://${v.id}/${n}` })), expiresInSeconds: 900 };
    }
    if (seg[2] === 'parts') {
      if (v.status !== 'uploading') return { uploaded: [], missing: [], status: v.status };
      const size = (n: number) => (n < v.total_parts ? PART : v.declared_size - PART * (v.total_parts - 1));
      return {
        uploaded: v.uploaded.map((n) => ({ n, etag: `"e${n}"`, size: size(n) })),
        missing: Array.from({ length: v.total_parts }, (_, i) => i + 1).filter((n) => !v.uploaded.includes(n)), status: v.status,
      };
    }
    if (seg[2] === 'complete') {
      if (v.status !== 'uploading') return { status: v.status, receiptId: v.id, versionNo: v.version_no };
      if (!inGrace) { v.status = 'expired'; save(); throw new MockError('GRACE_EXPIRED', 'Upload window closed', 409); }
      Object.assign(v, { status: 'uploaded', actual_size: v.declared_size, completed_at: iso(now()), counts: true, doneAt: now() }); save();
      return { status: 'uploaded', receiptId: v.id, versionNo: v.version_no };
    }
    if (seg[2] === 'abort') { const ok = v.status === 'uploading'; if (ok) v.status = 'aborted'; save(); return { aborted: ok }; }
    if (seg[2] === 'download') return { url: `data:text/plain,Demo mode: ${encodeURIComponent(v.declared_filename)} is not stored.` };
    if (seg[2] === 'preview') return { url: '', kind: 'demo' };
  }
  if (seg[0] === 'teams' && seg[2] === 'status') return { latest: listV()[0] ?? null };
  if (seg[0] === 'hackathons') {
    const rows = orgRows();
    if (seg[2] === 'dashboard') {
      const by: Record<string, number> = {};
      rows.forEach((r) => { if (r.latest_status) by[r.latest_status] = (by[r.latest_status] ?? 0) + 1; });
      return {
        teamsTotal: rows.length, byStatus: Object.entries(by).map(([status, n]) => ({ status, n })), lateAttempts: 6 + st.late,
        queueDepth: 2, oldestQueuedSeconds: 3, activeWorkers: 4, failedChecks: [{ check_name: 'links', n: 2 }, { check_name: 'archive', n: 1 }, { check_name: 'type', n: 1 }],
      };
    }
    if (seg[2] === 'submissions') {
      const s = q.get('status'), term = (q.get('q') ?? '').toLowerCase();
      const all = rows.filter((r) => (!term || r.team_name.toLowerCase().includes(term)) && (!s || (r.latest_status ?? 'none') === s));
      const size = Number(q.get('pageSize') ?? 50), page = Number(q.get('page') ?? 1);
      return { rows: all.slice((page - 1) * size, page * size), page, pageSize: size, total: all.length };
    }
    if (seg[2] === 'teams') {
      const r = rows.find((x) => x.team_id === seg[3]);
      const vs = r?.team_name.includes('(you)') ? listV() : r?.latest_status ? [{ id: uid(), version_no: r.latest_version, status: r.latest_status, declared_filename: 'project.zip', actual_size: r.size_bytes, declared_size: r.size_bytes, sha256: r.sha256, started_at: r.last_activity, completed_at: r.last_activity, started_in_time: true, counts: true, failure_summary: r.latest_status === 'needs_fix' ? 'ARCHIVE_UNSAFE: entry "../../etc/passwd" escapes the archive root' : null }] : [];
      return {
        versions: vs,
        late: r?.late_attempts ? [{ id: 1, action: 'start_upload', server_time: iso(st.deadline + 2000), delta_ms: 2000, reason: 'DEADLINE_PASSED' }, { id: 2, action: 'edit_metadata', server_time: iso(st.deadline + 9000), delta_ms: 9000, reason: 'DEADLINE_PASSED' }] : [],
        trail: [{ id: 3, type: 'version.accepted', created_at: iso(now() - 600e3), payload: {} }, { id: 2, type: 'version.uploaded', created_at: iso(now() - 610e3), payload: {} }, { id: 1, type: 'team.member_joined', created_at: iso(now() - 86400e3), payload: {} }],
      };
    }
    if (seg[2] === 'reset-demo-deadline') { st.deadline = now() + 5 * 60e3; save(); return { ok: true }; }
  }
  throw new MockError('NOT_FOUND', `Demo mode: ${method} ${p} not mocked`, 404);
}

export async function mockFetchRaw(path: string): Promise<Blob> {
  const header = path.includes('late') ? 'id,team_id,action,server_time,delta_ms,reason\n' : 'team_id,team_name,counting_version,status,sha256,size_bytes,late_attempts\n';
  const body = path.includes('late') ? '' : orgRows().map((r) => [r.team_id, r.team_name, r.counting_version ?? '', r.latest_status ?? '', r.sha256 ?? '', r.size_bytes ?? '', r.late_attempts].map((c) => `"${c}"`).join(',')).join('\n');
  return new Blob([header + body + '\n'], { type: 'text/csv' });
}

/** Simulated part PUT for demo:// URLs: ~12 MB/s with progress events. */
export function mockPut(url: string, size: number, onProgress: (loaded: number) => void, signal: AbortSignal): Promise<string> {
  const [, id, n] = url.replace('demo://', '/').split('/');
  return new Promise((resolve, reject) => {
    let loaded = 0;
    const t = setInterval(() => {
      if (signal.aborted) { clearInterval(t); return reject(new DOMException('aborted', 'AbortError')); }
      loaded = Math.min(size, loaded + 12 * 1024 * 1024 * 0.1);
      onProgress(loaded);
      if (loaded >= size) {
        clearInterval(t);
        const v = st.versions.find((x) => x.id === id);
        if (v && !v.uploaded.includes(Number(n))) { v.uploaded.push(Number(n)); save(); }
        resolve(`"e${n}"`);
      }
    }, 100);
  });
}

export const resetDemo = () => { sessionStorage.removeItem(KEY); st = fresh(); };
