import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, downloadFile, fetchInfo, HackathonInfo, isDemo, subscribe } from './api';
import { CHECK_LABEL, formatBytes, shortDate, statusMeta } from './lib';
import { CountdownBoxes, I, Overlay, PhasePill, Skeleton, StatusPill, useServerTime, useToast } from './ui';

const FILTERS: [string, string][] = [['', 'All'], ['accepted', 'Accepted'], ['checking', 'Checking'], ['needs_fix', 'Needs fix'], ['uploading', 'Uploading'], ['none', 'No upload']];
const TONE: Record<string, string> = { ok: 'var(--green)', warn: 'var(--amber)', bad: 'var(--red)', info: 'var(--blue)', muted: 'var(--muted)' };
const PAGE = 25;

export function OrganizerPage() {
  const toast = useToast();
  const [info, setInfo] = useState<HackathonInfo | null>(null);
  const [err, setErr] = useState('');
  const [dash, setDash] = useState<any>(null);
  const [rows, setRows] = useState<any[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState(() => new URLSearchParams(location.hash.split('?')[1]).get('q') ?? '');
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<any | null>(null);
  const detailRequest = useRef(0);
  const hid = info?.id;
  const { t, now, phase } = useServerTime(hid);

  useEffect(() => { fetchInfo().then(setInfo).catch((e) => setErr(e.message)); }, []);

  const loadDash = useCallback(async () => { if (hid) try { setDash(await api(`/hackathons/${hid}/dashboard`)); } catch (e: any) { setErr(e.message); } }, [hid]);
  const loadRows = useCallback(async () => {
    if (!hid) return;
    try {
      const p = new URLSearchParams({ page: String(page), pageSize: String(PAGE), ...(q ? { q } : {}), ...(status ? { status } : {}) });
      const r = await api(`/hackathons/${hid}/submissions?${p}`);
      setRows(r.rows); setTotal(r.total ?? null);
    } catch (e: any) { setErr(e.message); setRows([]); }
  }, [hid, page, q, status]);

  useEffect(() => { void loadDash(); }, [loadDash]);
  useEffect(() => { const id = setTimeout(loadRows, 250); return () => clearTimeout(id); }, [loadRows]);
  useEffect(() => {
    if (!hid) return;
    let refresh: ReturnType<typeof setTimeout> | undefined;
    const dispose = subscribe(`/hackathons/${hid}/events`, ['version.uploaded', 'version.accepted', 'version.needs_fix', 'version.started', 'version.checking', 'version.expired', 'version.aborted', 'metadata.updated', 'submission.late_attempt', 'team.member_joined'],
      () => { refresh ??= setTimeout(() => { refresh = undefined; void loadDash(); void loadRows(); }, 300); }, isDemo() ? 3000 : 10000);
    return () => { dispose(); clearTimeout(refresh); };
  }, [hid, loadDash, loadRows]);
  useEffect(() => { const f = () => setQ(new URLSearchParams(location.hash.split('?')[1]).get('q') ?? q); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, [q]);

  const open = async (r: any) => {
    const requestId = ++detailRequest.current;
    setDetail({ row: r, loading: true });
    try {
      const data = await api(`/hackathons/${hid}/teams/${r.team_id}`);
      if (detailRequest.current === requestId) setDetail({ row: r, ...data });
    } catch (e: any) {
      if (detailRequest.current === requestId) { toast('bad', e.message); setDetail(null); }
    }
  };
  const closeDetail = () => { detailRequest.current++; setDetail(null); };
  const dl = (path: string, name: string) => downloadFile(`/hackathons/${hid}${path}`, name).then(() => toast('ok', `Downloaded ${name}`), (e) => toast('bad', e.message));
  const reset = async () => {
    if (!confirm('Move the deadline to 5 minutes from now? This is for demos only.')) return;
    try { await api(`/hackathons/${hid}/reset-demo-deadline`, { method: 'POST', body: {} }); toast('ok', 'Deadline reset to now + 5 min'); location.reload(); } catch (e: any) { toast('bad', e.message); }
  };

  const by = Object.fromEntries((dash?.byStatus ?? []).map((x: any) => [x.status, x.n]));
  const submitted = (dash?.byStatus ?? []).reduce((a: number, x: any) => a + x.n, 0);
  const maxFail = Math.max(1, ...(dash?.failedChecks ?? []).map((x: any) => x.n));
  const remaining = t ? (phase === 'grace' ? t.graceEndsMs : t.deadlineMs) - now : 0;

  return (
    <main className="page" style={{ padding: '0 24px 80px' }}>
      <div className="ws-head">
        <div>
          <div className="crumbs"><a href="#/">{info?.name ?? 'Hackathon'}</a> / Organizer</div>
          <h1>Submissions</h1>
        </div>
        <PhasePill phase={phase} />
        <span className="spacer" />
        <div className="row wrap">
          <button className="btn primary sm" onClick={() => dl('/export.csv', 'submissions.csv')} disabled={!hid}><I.download /> Export CSV</button>
          <button className="btn sm" onClick={() => dl('/late-attempts.csv', 'late-attempts.csv')} disabled={!hid}><I.download /> Late attempts CSV</button>
          {(isDemo() || info?.name === 'Demo Hackathon') && <button className="btn sm ghost" onClick={reset} disabled={!hid}>Reset demo deadline</button>}
        </div>
      </div>
      {err && <div className="alert bad" role="alert" style={{ marginBottom: 16 }}>{err}</div>}

      <div className="grid-2">
        <div className="stack" style={{ gap: 20, minWidth: 0 }}>
          <div className="tiles">
            <Tile k="Teams" v={dash?.teamsTotal} s={`${submitted} with an upload`} />
            <Tile k="Accepted" v={by.accepted ?? (dash ? 0 : undefined)} s="latest version" tone="ok" />
            <Tile k="Needs fix" v={by.needs_fix ?? (dash ? 0 : undefined)} s="failed a check" tone="bad" />
            <Tile k="In progress" v={dash ? (by.uploading ?? 0) + (by.uploaded ?? 0) + (by.checking ?? 0) : undefined} s="uploading or checking" tone="info" />
            <Tile k="Late attempts" v={dash?.lateAttempts} s="rejected after deadline" tone="warn" />
          </div>

          <section className="card" aria-labelledby="sub-h">
            <div className="toolbar">
              <h2 id="sub-h" style={{ margin: 0 }}>Teams</h2>
              <span className="spacer" />
              <label className="search" style={{ display: 'flex' }}><I.search size={15} />
                <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Search team name" aria-label="Search team name" /></label>
            </div>
            <div className="seg" role="group" aria-label="Filter by status" style={{ margin: '12px 0', flexWrap: 'wrap' }}>
              {FILTERS.map(([v, l]) => <button key={v} className={status === v ? 'on' : ''} aria-pressed={status === v} onClick={() => { setStatus(v); setPage(1); }}>{l}</button>)}
            </div>
            {rows === null ? <Skeleton h={200} /> : rows.length === 0 ? <div className="empty">No teams match.</div> : (
              <div className="table-wrap"><table className="tbl">
                <thead><tr><th>Team</th><th>Project</th><th>Status</th><th>Counting</th><th>Size</th><th>Late</th><th>Last activity</th></tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r.team_id} className="click" tabIndex={0} onClick={() => open(r)} onKeyDown={(e) => e.key === 'Enter' && open(r)}>
                    <td style={{ fontWeight: 500 }}>{r.team_name}</td>
                    <td className="muted" style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title || '—'}</td>
                    <td><StatusPill status={r.latest_status} />{r.fallback_used && <span className="pill info" style={{ marginLeft: 4 }} title="An earlier accepted version counts">fallback</span>}</td>
                    <td>{r.counting_version ? `v${r.counting_version}` : '—'}</td>
                    <td>{formatBytes(r.size_bytes)}</td>
                    <td>{r.late_attempts ? <span className="pill warn">{r.late_attempts}</span> : <span className="muted">0</span>}</td>
                    <td className="muted">{r.last_activity ? shortDate(r.last_activity) : '—'}</td>
                  </tr>))}</tbody>
              </table></div>
            )}
            <div className="row" style={{ marginTop: 12, fontSize: 13 }}>
              <span className="muted">{total != null ? `${total} team${total === 1 ? '' : 's'}` : `Page ${page}`}</span><span className="spacer" />
              <button className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
              <button className="btn sm" disabled={!rows || (total != null ? page * PAGE >= total : rows.length < PAGE)} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          </section>
        </div>

        <aside className="side">
          <div className="card">
            <div className="label-sm">{phase === 'grace' ? 'Grace period ends in' : phase === 'closed' ? 'Submissions closed' : 'Deadline in'}</div>
            {t ? <CountdownBoxes ms={Math.max(0, remaining)} /> : <Skeleton h={62} />}
            <div className="kv">
              <div className="kv-row"><span>Queue depth</span><span>{dash?.queueDepth ?? '—'}</span></div>
              <div className="kv-row"><span>Oldest job</span><span>{dash ? `${dash.oldestQueuedSeconds ?? 0}s` : '—'}</span></div>
              <div className="kv-row"><span>Active workers</span><span>{dash?.activeWorkers ?? '—'}</span></div>
              <div className="kv-row"><span>Registered</span><span>{info?.registered ?? '—'}</span></div>
            </div>
            <a className="btn block" href="#/status" style={{ marginTop: 12 }}>Live status <I.arrowRight size={15} /></a>
          </div>
          <div className="card">
            <div className="label-sm">Failed checks</div>
            {!dash ? <Skeleton h={80} /> : !dash.failedChecks?.length ? <div className="muted" style={{ fontSize: 13 }}>No failed checks.</div>
              : dash.failedChecks.map((f: any) => (
                <div key={f.check_name} className="hbar"><span>{CHECK_LABEL[f.check_name] ?? f.check_name}</span>
                  <span className="track"><i style={{ width: `${(f.n / maxFail) * 100}%`, background: 'var(--red)' }} /></span><b style={{ textAlign: 'right' }}>{f.n}</b></div>))}
          </div>
          <div className="card">
            <div className="label-sm">Status breakdown</div>
            {(dash?.byStatus ?? []).map((x: any) => {
              const m = statusMeta(x.status);
              return <div key={x.status} className="hbar"><span>{m.label}</span><span className="track"><i style={{ width: `${(x.n / Math.max(1, dash.teamsTotal)) * 100}%`, background: TONE[m.tone] }} /></span><b style={{ textAlign: 'right' }}>{x.n}</b></div>;
            })}
          </div>
        </aside>
      </div>

      {detail && (
        <Overlay kind="drawer" title={detail.row.team_name} onClose={closeDetail}>
          {detail.loading ? <Skeleton h={200} /> : <div className="stack" style={{ gap: 20 }}>
            <div>
              <div className="label-sm">Versions</div>
              {!detail.versions.length ? <div className="muted">No uploads.</div> : detail.versions.map((v: any) => (
                <div key={v.id} className="check" style={{ marginBottom: 8 }}>
                  <span className="check-ic skipped">v{v.version_no}</span>
                  <div>
                    <div className="check-name">{v.declared_filename} · {formatBytes(v.actual_size ?? v.declared_size)}</div>
                    <div className="check-detail">Started {shortDate(v.started_at)} · {v.started_in_time ? 'in time' : 'late'}{v.sha256 ? ` · ${v.sha256.slice(0, 16)}…` : ''}</div>
                    {v.failure_summary && <div className="check-hint">{v.failure_summary}</div>}
                  </div>
                  <StatusPill status={v.status} />
                </div>))}
            </div>
            <div>
              <div className="label-sm">Late attempts</div>
              {!detail.late.length ? <div className="muted" style={{ fontSize: 13 }}>None.</div> : <ul className="trail">
                {detail.late.map((l: any) => <li key={l.id}><span className="muted">+{Math.round((l.delta_ms ?? 0) / 1000)}s</span><span>{l.action} · {l.reason} · <span className="muted">{shortDate(l.server_time)}</span></span></li>)}
              </ul>}
            </div>
            <div>
              <div className="label-sm">Audit trail</div>
              <ul className="trail">{detail.trail.map((a: any) => <li key={a.id}><span className="muted">{new Date(a.created_at).toLocaleTimeString()}</span><span className="mono" style={{ fontSize: 12.5 }}>{a.type}</span></li>)}</ul>
            </div>
          </div>}
        </Overlay>
      )}
    </main>
  );
}

const Tile = ({ k, v, s, tone }: { k: string; v?: number; s: string; tone?: string }) => (
  <div className="tile"><div className="tile-k">{k}</div>
    <div className="tile-v" style={tone ? { color: TONE[tone] } : undefined}>{v ?? '—'}</div><div className="tile-s">{s}</div></div>
);
