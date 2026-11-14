import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api';

type S = { api: string; db: string; storage: string; worker: string; activeWorkers: number; queueLagSeconds: number; latencyMs: number; checkedAt: string };
const LAMP: Record<string, 'ok' | 'warn' | 'bad'> = { ok: 'ok', degraded: 'warn', idle: 'warn', down: 'bad' };
const WORDS: Record<string, string> = { ok: 'Operational', degraded: 'Degraded', idle: 'Idle', down: 'Down' };

/** F-15: public traffic-light status page. Refreshes every 5 seconds. */
export function StatusPage() {
  const [s, setS] = useState<S | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => api<S>('/status').then((x) => { setS(x); setErr(''); }).catch((e) => setErr(e.message)), []);
  useEffect(() => { void load(); const id = setInterval(load, 5000); return () => clearInterval(id); }, [load]);

  const items: [string, string, string][] = s ? [
    ['API', s.api, `${s.latencyMs} ms response`],
    ['Database', s.db, s.db === 'ok' ? 'Accepting queries' : 'Not reachable'],
    ['File storage', s.storage, s.storage === 'ok' ? 'Uploads available' : 'Uploads unavailable'],
    ['Check workers', s.worker, `${s.activeWorkers} active · queue lag ${s.queueLagSeconds}s`],
  ] : err ? [['API', 'down', err], ['Database', 'down', 'Unknown'], ['File storage', 'down', 'Unknown'], ['Check workers', 'down', 'Unknown']] : [];
  const all = items.every(([, v]) => v === 'ok');

  return (
    <main className="page" style={{ padding: '0 24px 80px' }}>
      <div className="ws-head"><div><div className="crumbs"><a href="#/">Hack4Hack</a> / Status</div><h1>Live status</h1></div></div>
      {items.length > 0 && <div className={`alert ${all ? 'ok' : 'bad'}`} role="status" style={{ marginBottom: 16 }}>
        {all ? 'All systems operational.' : 'Some systems are having problems. Uploads you have started will retry automatically.'}</div>}
      <div className="lights">
        {items.length === 0 ? <div className="skeleton" style={{ height: 70 }} /> : items.map(([k, v, d]) => (
          <div key={k} className="light">
            <span className={`lamp ${LAMP[v] ?? 'warn'}`} aria-hidden="true" />
            <div><div style={{ fontWeight: 500 }}>{k}</div><div className="muted" style={{ fontSize: 13 }}>{WORDS[v] ?? v} · {d}</div></div>
          </div>))}
      </div>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 16 }}>{s ? `Checked ${new Date(s.checkedAt).toLocaleTimeString()} · refreshes every 5 seconds` : 'Checking…'}</p>
    </main>
  );
}
