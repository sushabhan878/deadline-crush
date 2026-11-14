import { mockApi, mockFetchRaw } from './mock';

/** Demo mode runs the whole UI against in-browser fake data (no Postgres/S3 needed). Enable with ?demo=1. */
export const browserDemo = import.meta.env.VITE_BROWSER_DEMO === '1';
if (new URLSearchParams(location.search).has('demo')) localStorage.setItem('dc_demo', '1');
export const isDemo = () => browserDemo || localStorage.getItem('dc_demo') === '1';
export const exitDemo = () => { localStorage.removeItem('dc_demo'); setToken(null); location.href = location.pathname; };

let token: string | null = localStorage.getItem('dc_token');
export const setToken = (t: string | null) => {
  token = t;
  t ? localStorage.setItem('dc_token', t) : localStorage.removeItem('dc_token');
};
export const getToken = () => token;

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}

type Opts = { method?: string; body?: unknown; headers?: Record<string, string> };

export async function api<T = any>(path: string, opts: Opts = {}): Promise<T> {
  const method = opts.method ?? (opts.body ? 'POST' : 'GET');
  if (isDemo()) return mockApi(method, path, opts.body) as Promise<T>;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...opts.headers },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    throw new ApiError('NETWORK', 'Network error: cannot reach the server', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token && !path.startsWith('/auth/')) window.dispatchEvent(new Event('dc:unauthorized'));
    const msg = res.status >= 500 ? 'The server could not complete the request. Try again shortly.' : data.message ?? res.statusText;
    throw new ApiError(data.code ?? 'ERROR', msg, res.status);
  }
  return data;
}

/** Authenticated file download (CSV exports). */
export async function downloadFile(path: string, filename: string) {
  const blob = isDemo()
    ? await mockFetchRaw(path)
    : await (async () => {
      const r = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
      if (!r.ok) throw new ApiError('ERROR', `Download failed (${r.status})`, r.status);
      return r.blob();
    })();
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** SSE with polling fallback after 3 failures (F-12). Returns a cleanup function. */
export function subscribe(path: string, types: string[], onEvent: (type: string) => void, pollMs = 5000) {
  if (isDemo()) {
    const t = setInterval(() => onEvent('poll'), Math.min(pollMs, 1500));
    return () => clearInterval(t);
  }
  const controller = new AbortController();
  let lastId = '';
  let connected = false;
  const poll = setInterval(() => { if (!connected) onEvent('poll'); }, pollMs);
  const listen = async () => {
    while (!controller.signal.aborted) {
      const attempt = new AbortController();
      let watchdog = setTimeout(() => attempt.abort(), pollMs);
      try {
        const response = await fetch(`/api${path}`, { signal: AbortSignal.any([controller.signal, attempt.signal]), headers: {
          Authorization: `Bearer ${getToken()}`, ...(lastId ? { 'Last-Event-ID': lastId } : {}),
        } });
        if (!response.ok || !response.body) throw new Error('Live updates unavailable');
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          clearTimeout(watchdog);
          watchdog = setTimeout(() => attempt.abort(), 25_000);
          if (!connected) { connected = true; onEvent('poll'); }
          buffer += value;
          for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
            const event = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            lastId = /^id: (\d+)$/m.exec(event)?.[1] ?? lastId;
            const type = /^event: (.+)$/m.exec(event)?.[1];
            if (type && types.includes(type)) onEvent(type);
          }
        }
      } catch { /* The fallback keeps the view current during reconnects. */ }
      finally { clearTimeout(watchdog); }
      connected = false;
      if (!controller.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  };
  void listen();
  return () => { controller.abort(); clearInterval(poll); };
}

export interface ServerTime { offset: number; deadlineMs: number; graceEndsMs: number; phase: string }

/** Offset between server and client clocks; UI only DISPLAYS time with it (F-03). */
export async function fetchTime(hackathonId?: string): Promise<ServerTime> {
  const t0 = Date.now();
  const t = await api(`/time${hackathonId ? `?hackathonId=${hackathonId}` : ''}`);
  const offset = new Date(t.serverNow).getTime() - (t0 + Date.now()) / 2;
  return { ...t, offset, deadlineMs: new Date(t.deadlineAt).getTime(), graceEndsMs: new Date(t.graceEndsAt).getTime() };
}

export interface HackathonInfo {
  id: string; name: string; startsAt: string; deadlineAt: string; graceSeconds: number; maxFileBytes: number;
  allowedTypes: string[]; maxLinks: number; registered: number; teams: number; phase: string;
}
export const fetchInfo = (hackathonId?: string) =>
  api<HackathonInfo>(`/hackathon-info${hackathonId ? `?hackathonId=${hackathonId}` : ''}`);
