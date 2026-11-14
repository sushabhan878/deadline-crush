import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, fetchInfo, HackathonInfo, subscribe } from './api';
import {
  CHECK_LABEL, fileExt, fixHint, formatBytes, formatDuration, parseLinks, rate, shortDate, statusMeta, timeline, validateFile, validateMetadata,
} from './lib';
import type { Me } from './main';
import { pendingUploadName, startUpload, UploadHandle, UploadProgress } from './uploader';
import { CopyButton, CountdownBoxes, I, Overlay, PhasePill, Skeleton, StatusPill, useServerTime, useToast } from './ui';

const EVENTS = ['version.started', 'version.uploaded', 'version.checking', 'version.accepted', 'version.needs_fix', 'version.aborted', 'version.expired', 'metadata.updated'];
const STEP_LABEL: Record<string, string> = { uploading: 'Uploading', uploaded: 'Uploaded', checking: 'Checking', accepted: 'Accepted', needs_fix: 'Needs fix' };

interface Version {
  id: string; version_no: number; status: string; declared_filename: string; declared_size: number; actual_size: number | null;
  sha256: string | null; started_at: string; completed_at: string | null; started_in_time: boolean; counts: boolean;
  failure_summary: string | null; currently_counts?: boolean;
}
interface Check { check_name: string; status: string; detail: any }

export function TeamPage({ me }: { me: Me }) {
  const team = me.team!;
  const sid = team.submission_id;
  const toast = useToast();
  const { t, now, phase } = useServerTime(team.hackathon_id);
  const [info, setInfo] = useState<HackathonInfo | null>(null);
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [online, setOnline] = useState(navigator.onLine);
  const [live, setLive] = useState(''); // ARIA live announcements
  const [receipt, setReceipt] = useState<Version | null>(null);
  const [preview, setPreview] = useState<{ url: string; kind: string } | null | 'none'>(null);
  const lastStatus = useRef<string>();

  const latest = versions?.[0];
  const counting = versions?.find((v) => v.currently_counts);

  const refresh = useCallback(async () => {
    try {
      const vs: Version[] = await api(`/submissions/${sid}/versions`);
      setVersions(vs);
      const l = vs[0];
      if (l && l.status !== 'uploading' && l.status !== 'aborted') setChecks((await api(`/versions/${l.id}`)).checks ?? []);
      else setChecks([]);
      if (l && lastStatus.current && lastStatus.current !== l.status) {
        const msg = `Version ${l.version_no} is now ${statusMeta(l.status).label}`;
        setLive(msg);
        if (l.status === 'accepted') toast('ok', msg); else if (l.status === 'needs_fix') toast('bad', msg);
      }
      lastStatus.current = l?.status;
    } catch (e: any) { if (versions === null) setVersions([]); toast('bad', e.message); }
  }, [sid, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { fetchInfo(team.hackathon_id).then(setInfo).catch(() => {}); void refresh(); }, [team.hackathon_id, refresh]);
  useEffect(() => subscribe(`/teams/${team.team_id}/events`, EVENTS, () => void refresh()), [team.team_id, refresh]);
  useEffect(() => {
    const on = () => { setOnline(true); setLive('Back online'); }, off = () => { setOnline(false); setLive('You are offline. Uploads are paused.'); };
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  useEffect(() => {
    setPreview(null);
    if (latest?.status === 'accepted') api(`/versions/${latest.id}/preview`).then(setPreview).catch(() => setPreview('none'));
  }, [latest?.id, latest?.status]);

  const download = async (v: Version) => {
    try { const { url } = await api(`/versions/${v.id}/download`); window.open(url, '_blank', 'noopener'); } catch (e: any) { toast('bad', e.message); }
  };

  const remaining = t ? (phase === 'grace' ? t.graceEndsMs : t.deadlineMs) - now : 0;

  return (
    <>
      {!online && <div className="banner offline" role="alert"><I.wifiOff /> You are offline. Uploads pause and resume automatically when you reconnect.</div>}
      {phase === 'grace' && <div className="banner grace" role="alert"><I.clock /> Deadline passed. Uploads already started can finish in the next {formatDuration(remaining / 1000)}. New uploads and edits are closed.</div>}
      {phase === 'closed' && <div className="banner closed" role="alert"><I.clock /> Submissions are closed. Checks may still finish for uploads received on time.</div>}
      <div className="sr" aria-live="polite" role="status">{live}</div>

      <main className="page" style={{ padding: '0 24px 80px' }}>
        <div className="ws-head">
          <div>
            <div className="crumbs"><a href="#/">{info?.name ?? 'Hackathon'}</a> / Workspace</div>
            <h1>{team.team_name}</h1>
          </div>
          <PhasePill phase={phase} />
          <span className="spacer" />
          <div className="row" style={{ fontSize: 13 }}><span className="muted">Invite code</span><CopyButton text={team.invite_code} /></div>
        </div>

        <div className="grid-2">
          <div className="main-col stack" style={{ gap: 20 }}>
            <MetadataCard sid={sid} maxLinks={info?.maxLinks ?? 5} editable={phase === 'open'} onSaved={() => setLive('Project details saved as a new version')} />
            <UploadCard sid={sid} info={info} phase={phase} onChange={refresh} onLive={setLive} />

            <section className="card" aria-labelledby="st-h">
              <div className="row"><h2 id="st-h" style={{ margin: 0 }}>Latest version</h2><span className="spacer" />{latest && <StatusPill status={latest.status} />}</div>
              {versions === null ? <Skeleton h={80} /> : !latest ? <div className="empty">No uploads yet. Your first upload will appear here.</div> : <>
                <p className="card-sub">v{latest.version_no} · {latest.declared_filename} · {formatBytes(latest.actual_size ?? latest.declared_size)}</p>
                <Stepper status={latest.status} />
                {latest.status === 'needs_fix' && latest.failure_summary && <div className="alert bad" role="alert" style={{ marginBottom: 12 }}>{latest.failure_summary}</div>}
                {latest.status === 'needs_fix' && counting && <div className="alert info" style={{ marginBottom: 12 }}>Version {counting.version_no} is still your counting version until you upload a fixed one.</div>}
                {checks.length > 0 && <div className="checks">
                  {checks.map((c) => (
                    <div key={c.check_name} className="check">
                      <span className={`check-ic ${c.status}`} aria-hidden="true">{c.status === 'pass' ? '✓' : c.status === 'fail' ? '✕' : '–'}</span>
                      <div>
                        <div className="check-name">{CHECK_LABEL[c.check_name] ?? c.check_name}</div>
                        <div className="check-detail">{describe(c)}</div>
                        {c.status === 'fail' && <div className="check-hint">How to fix: {fixHint(c.check_name)}</div>}
                      </div>
                      <span className={`pill ${c.status === 'pass' ? 'ok' : c.status === 'fail' ? 'bad' : 'muted'}`}>{c.status}</span>
                    </div>
                  ))}
                </div>}
                <div className="row wrap" style={{ marginTop: 14 }}>
                  {latest.status !== 'uploading' && latest.status !== 'aborted' && <button className="btn sm" onClick={() => setReceipt(latest)}><I.receipt /> Receipt</button>}
                  {['accepted', 'needs_fix', 'checking', 'uploaded'].includes(latest.status) && <button className="btn sm" onClick={() => download(latest)}><I.download /> Download</button>}
                </div>
              </>}
            </section>

            {latest?.status === 'accepted' && (
              <section className="card" aria-labelledby="pv-h">
                <h2 id="pv-h">Preview</h2>
                {preview === null ? <Skeleton h={120} /> : preview === 'none' ? <div className="empty">No preview available for this file.</div>
                  : preview.kind === 'image' && preview.url ? <img src={preview.url} alt={`Preview of ${latest.declared_filename}`} style={{ maxWidth: '100%', borderRadius: 10, border: '1px solid var(--line)' }} />
                  : <div className="empty">{fileExt(latest.declared_filename).toUpperCase()} file · preview {preview.kind === 'demo' ? 'is not generated in demo mode' : 'available as text'}{preview.url && <> · <a href={preview.url} target="_blank" rel="noreferrer" style={{ color: 'var(--lime)' }}>open</a></>}</div>}
              </section>
            )}

            <section className="card" aria-labelledby="vh-h">
              <h2 id="vh-h">Version history</h2>
              <p className="card-sub">The latest accepted version that started before the deadline counts.</p>
              {versions === null ? <Skeleton h={100} /> : versions.length === 0 ? <div className="empty">No versions yet.</div> : (
                <div className="table-wrap"><table className="tbl">
                  <thead><tr><th>Version</th><th>File</th><th>Size</th><th>Status</th><th>Started</th><th>SHA-256</th><th /></tr></thead>
                  <tbody>{versions.map((v) => (
                    <tr key={v.id} className={v.currently_counts ? 'counts' : ''}>
                      <td>v{v.version_no} {v.currently_counts && <span className="pill featured" style={{ marginLeft: 4 }}>Counts</span>}</td>
                      <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }} title={v.declared_filename}>{v.declared_filename}</td>
                      <td>{formatBytes(v.actual_size ?? v.declared_size)}</td>
                      <td><StatusPill status={v.status} /></td>
                      <td>{shortDate(v.started_at)} {v.started_in_time ? <span className="pill ok">In time</span> : <span className="pill bad">Late</span>}</td>
                      <td className="mono muted">{v.sha256 ? `${v.sha256.slice(0, 10)}…` : '—'}</td>
                      <td>{v.status !== 'uploading' && v.status !== 'aborted' && <button className="btn sm ghost" onClick={() => setReceipt(v)}>Receipt</button>}</td>
                    </tr>))}</tbody>
                </table></div>
              )}
            </section>
          </div>

          <aside className="side" aria-label="Deadline">
            <div className="card">
              <div className="label-sm">{phase === 'grace' ? 'Grace period ends in' : phase === 'closed' ? 'Submissions closed' : 'Submission deadline in'}</div>
              {t ? <CountdownBoxes ms={Math.max(0, remaining)} /> : <Skeleton h={62} />}
              <div className="cd-note">Server time decides lateness, not your device clock.</div>
              {counting ? <div className="registered"><I.check size={15} /> v{counting.version_no} counts</div>
                : latest?.status === 'needs_fix' ? <div className="registered bad">Latest version needs a fix</div>
                : <div className="registered warn">No counting version yet</div>}
              <div className="kv" style={{ marginTop: 8 }}>
                <div className="kv-row"><span>Deadline</span><span>{t ? shortDate(t.deadlineMs) : '—'}</span></div>
                <div className="kv-row"><span>Grace period</span><span>{info ? `${Math.round(info.graceSeconds / 60)} min` : '—'}</span></div>
                <div className="kv-row"><span>Max file</span><span>{info ? formatBytes(info.maxFileBytes) : '—'}</span></div>
                <div className="kv-row"><span>Allowed</span><span>{info?.allowedTypes.map((x) => x.toUpperCase()).join(', ') ?? '—'}</span></div>
                <div className="kv-row"><span>Versions</span><span>{versions?.length ?? '—'}</span></div>
              </div>
            </div>
            <div className="card">
              <div className="label-sm">Signed in as</div>
              <div style={{ fontSize: 14 }}>{me.user.email}</div>
            </div>
          </aside>
        </div>
      </main>
      {receipt && <ReceiptModal v={versions?.find((v) => v.id === receipt.id) ?? receipt} team={team.team_name} onClose={() => setReceipt(null)} />}
    </>
  );
}

function describe(c: Check) {
  const d = c.detail ?? {};
  if (d.reason) return d.reason;
  if (c.check_name === 'type' && (d.detected || d.mime)) return `Detected ${d.detected?.toUpperCase() ?? d.mime}`;
  if (c.check_name === 'archive' && d.entries != null) return `${d.entries} archive entries`;
  if (c.check_name === 'links' && d.results) return `${d.results.length} reachable`;
  if (c.status === 'skipped') return d.note ?? 'No check needed';
  if (c.check_name === 'hash' && d.sha256) return d.sha256;
  if (c.check_name === 'preview') return 'Preview generated';
  return c.status;
}

function Stepper({ status }: { status: string }) {
  const tl = timeline(status);
  return (
    <ol className="steps" aria-label="Upload progress">
      {tl.steps.map((s, i) => {
        const done = i < tl.active || (i === tl.active && s === 'accepted');
        const cls = tl.failed && i === tl.active ? 'fail' : done ? 'done' : i === tl.active ? `current${s === 'checking' || s === 'uploading' ? ' spin' : ''}` : '';
        return (
          <li key={s} className={`step ${cls}`} aria-current={i === tl.active ? 'step' : undefined}>
            <div className="node">{cls === 'fail' ? '!' : done ? '✓' : i + 1}</div>{STEP_LABEL[s]}
          </li>
        );
      })}
    </ol>
  );
}

function UploadCard({ sid, info, phase, onChange, onLive }: {
  sid: string; info: HackathonInfo | null; phase: string | null; onChange: () => void; onLive: (s: string) => void;
}) {
  const toast = useToast();
  const [over, setOver] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [prog, setProg] = useState<UploadProgress | null>(null);
  const [err, setErr] = useState('');
  const [state, setState] = useState<'idle' | 'running' | 'done'>('idle');
  const handle = useRef<UploadHandle | null>(null);
  const samples = useRef<{ t: number; bytes: number }[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const resumeName = pendingUploadName(sid);
  const mayResume = phase === 'grace' && !!resumeName;
  const disabled = (phase !== 'open' && !mayResume) || state === 'running';

  const begin = (f: File) => {
    setErr('');
    const bad = validateFile(f, info?.maxFileBytes ?? 100 * 1024 * 1024, info?.allowedTypes ?? ['pdf', 'zip']);
    if (bad) { setErr(bad); return; }
    setFile(f); setState('running'); setProg(null); samples.current = [];
    onLive(`Uploading ${f.name}`);
    const h = startUpload(sid, f, (p) => {
      setProg(p);
      samples.current = [...samples.current.filter((s) => Date.now() - s.t < 4000), { t: Date.now(), bytes: p.uploadedBytes }];
    }, mayResume);
    handle.current = h;
    setTimeout(onChange, 300);
    h.done.then((r) => {
      setState('done'); toast('ok', `Version ${r.versionNo} uploaded. Running checks…`); onLive(`Upload complete. Version ${r.versionNo} is being checked.`); onChange();
    }).catch((e: any) => {
      setState('idle'); setProg(null);
      if (e?.code !== 'CANCELLED') { setErr(e.message); onLive(`Upload failed: ${e.message}`); } else onLive('Upload cancelled');
      onChange();
    });
  };

  const r = rate(samples.current, prog?.total ?? 0);
  const pct = prog ? Math.round((prog.uploadedBytes / Math.max(1, prog.total)) * 100) : 0;

  return (
    <section className="card" aria-labelledby="up-h">
      <h2 id="up-h">{mayResume ? 'Resume your upload' : 'Upload a new version'}</h2>
      <p className="card-sub">{info ? `${info.allowedTypes.map((x) => x.toUpperCase()).join(' or ')} up to ${formatBytes(info.maxFileBytes)}` : 'PDF or ZIP'} · Uploads resume automatically if your connection drops.</p>
      {state !== 'running' && (
        <div className={`drop${over ? ' over' : ''}${disabled ? ' disabled' : ''}`} role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled}
          aria-label="Choose a file to upload, or drop it here"
          onClick={() => !disabled && input.current?.click()}
          onKeyDown={(e) => { if (!disabled && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); input.current?.click(); } }}
          onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f && !disabled) begin(f); }}>
          <div className="drop-icon"><I.upload /></div>
          {mayResume ? <><b>Choose {resumeName}</b> to resume</> : phase === 'open' ? <><b>Drop your file here</b> or click to browse</> : <>Uploads are closed</>}
          {state === 'done' && file && <div className="muted" style={{ marginTop: 6, fontSize: 12.5 }}>Last upload: {file.name}</div>}
        </div>
      )}
      <input ref={input} type="file" hidden accept={(info?.allowedTypes ?? ['pdf', 'zip']).map((x) => `.${x}`).join(',')}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) begin(f); }} />

      {state === 'running' && file && (
        <div>
          <div className="upl-file">
            <div className="file-ic">{fileExt(file.name) || 'file'}</div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</div>
              <div className="muted" style={{ fontSize: 12.5 }}>{prog?.versionNo ? `Version ${prog.versionNo} · ` : ''}{formatBytes(file.size)}</div>
            </div>
            <b style={{ fontVariantNumeric: 'tabular-nums' }}>{pct}%</b>
          </div>
          <div className={`bar${prog?.paused ? ' paused' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Overall upload progress"><i style={{ width: `${pct}%` }} /></div>
          <div className="upl-meta">
            <span>{formatBytes(prog?.uploadedBytes ?? 0)} of {formatBytes(file.size)}</span>
            {prog?.paused ? <span style={{ color: 'var(--amber)' }}>Paused</span> : <>
              <span>{r.bps ? `${formatBytes(r.bps)}/s` : 'Starting…'}</span>
              {Number.isFinite(r.etaSec) && <span>About {formatDuration(r.etaSec)} left</span>}</>}
            {prog?.resumed && <span style={{ color: 'var(--lime)' }}>Resumed from earlier upload</span>}
            {prog?.retrying != null && <span style={{ color: 'var(--amber)' }}>Retrying part {prog.retrying}…</span>}
          </div>
          {prog && prog.totalParts > 1 && (
            <div className="parts" aria-label={`${Object.values(prog.parts).length} of ${prog.totalParts} parts`}>
              {Array.from({ length: prog.totalParts }, (_, i) => {
                const n = i + 1, size = n < prog.totalParts ? 8 * 1024 * 1024 : prog.total - 8 * 1024 * 1024 * (prog.totalParts - 1);
                return <div key={n} className="part" title={`Part ${n}`}><i style={{ width: `${Math.min(100, ((prog.parts[n] ?? 0) / size) * 100)}%` }} /></div>;
              })}
            </div>
          )}
          <div className="row" style={{ marginTop: 14 }}>
            {prog?.paused ? <button className="btn sm" onClick={() => handle.current?.resume()}><I.play /> Resume</button>
              : <button className="btn sm" onClick={() => handle.current?.pause()}><I.pause /> Pause</button>}
            <button className="btn sm danger" onClick={() => handle.current?.cancel()}><I.x size={14} /> Cancel</button>
          </div>
        </div>
      )}
      {err && <div className="alert bad" role="alert" style={{ marginTop: 12 }}>{err}</div>}
    </section>
  );
}

function MetadataCard({ sid, maxLinks, editable, onSaved }: { sid: string; maxLinks: number; editable: boolean; onSaved: () => void }) {
  const toast = useToast();
  const draftKey = `dc_draft_${sid}`;
  const [f, setF] = useState<{ title: string; description: string; links: string } | null>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [server, setServer] = useState('');
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState(false);
  const [showHist, setShowHist] = useState(false);

  const load = useCallback(async () => {
    try {
      const m = await api(`/submissions/${sid}/metadata`);
      const cur = { title: m.current?.title ?? '', description: m.current?.description ?? '', links: (m.current?.links ?? []).join('\n') };
      setServer(JSON.stringify(cur)); setHistory(m.history ?? []);
      const draft = localStorage.getItem(draftKey);
      setF(draft ? JSON.parse(draft) : cur);
    } catch (e: any) { toast('bad', e.message); setF({ title: '', description: '', links: '' }); }
  }, [sid, draftKey, toast]);
  useEffect(() => { void load(); }, [load]);

  // Autosave a local draft (never sent to the server until "Save version").
  useEffect(() => {
    if (!f) return;
    const id = setTimeout(() => (JSON.stringify(f) === server ? localStorage.removeItem(draftKey) : localStorage.setItem(draftKey, JSON.stringify(f))), 400);
    return () => clearTimeout(id);
  }, [f, server, draftKey]);

  if (!f) return <section className="card"><Skeleton h={160} /></section>;
  const errors = validateMetadata(f, maxLinks);
  const dirty = JSON.stringify(f) !== server;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setTouched(true); setF({ ...f, [k]: e.target.value }); };

  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setTouched(true);
    if (Object.keys(errors).length) return;
    setBusy(true);
    try {
      const r = await api(`/submissions/${sid}/metadata`, { method: 'PUT', body: { title: f.title.trim(), description: f.description, links: parseLinks(f.links) } });
      localStorage.removeItem(draftKey); toast('ok', `Details saved as version ${r.versionNo}`); onSaved(); await load(); setTouched(false);
    } catch (e: any) { toast('bad', e.message); } finally { setBusy(false); }
  };
  const err = (k: string) => touched && (errors as any)[k];

  return (
    <section className="card" aria-labelledby="md-h">
      <div className="row"><h2 id="md-h" style={{ margin: 0 }}>Project details</h2><span className="spacer" />
        {dirty ? <span className="pill warn">Draft saved locally</span> : <span className="pill ok">Saved</span>}</div>
      <p className="card-sub">Each save creates a new version. Edits close at the deadline.</p>
      <form onSubmit={save}>
        <fieldset disabled={!editable || busy} style={{ border: 0, padding: 0, margin: 0 }}>
          <label className="field">Title<input className="input" value={f.title} onChange={set('title')} aria-invalid={!!err('title')} maxLength={120} />
            {err('title') && <span className="error">{(errors as any).title}</span>}</label>
          <label className="field">Description<textarea className="input" rows={4} value={f.description} onChange={set('description')} aria-invalid={!!err('description')} />
            <span className={err('description') ? 'error' : 'hint'}>{err('description') || `${f.description.length} / 5000`}</span></label>
          <label className="field">Links (one per line, https only)<textarea className="input mono" rows={3} value={f.links} onChange={set('links')} aria-invalid={!!err('links')} placeholder="https://github.com/your-team/project" />
            <span className={err('links') ? 'error' : 'hint'}>{err('links') || `${parseLinks(f.links).length} / ${maxLinks} links`}</span></label>
        </fieldset>
        <div className="row wrap">
          <button className="btn primary" disabled={!editable || busy || !dirty}>{busy ? 'Saving…' : 'Save version'}</button>
          {dirty && <button type="button" className="btn ghost" onClick={() => { localStorage.removeItem(draftKey); setF(JSON.parse(server)); setTouched(false); }}>Discard draft</button>}
          <span className="spacer" />
          {history.length > 0 && <button type="button" className="btn sm ghost" onClick={() => setShowHist(!showHist)} aria-expanded={showHist}>History ({history.length})</button>}
        </div>
      </form>
      {showHist && <ul className="trail" style={{ marginTop: 14 }}>
        {history.map((h) => <li key={h.version_no}><span className="muted">v{h.version_no}</span><span>{h.title} · <span className="muted">{shortDate(h.created_at)}</span> {h.in_time ? '' : <span className="pill bad">Late</span>}</span></li>)}
      </ul>}
    </section>
  );
}

function ReceiptModal({ v, team, onClose }: { v: Version; team: string; onClose: () => void }) {
  return (
    <Overlay kind="modal" title={`Receipt · version ${v.version_no}`} onClose={onClose}>
      <div className="kv" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>
        <div className="kv-row"><span>Team</span><span>{team}</span></div>
        <div className="kv-row"><span>File</span><span>{v.declared_filename}</span></div>
        <div className="kv-row"><span>Size</span><span>{formatBytes(v.actual_size ?? v.declared_size)}</span></div>
        <div className="kv-row"><span>Upload started (server)</span><span>{new Date(v.started_at).toISOString()}</span></div>
        <div className="kv-row"><span>Received (server)</span><span>{v.completed_at ? new Date(v.completed_at).toISOString() : '—'}</span></div>
        <div className="kv-row"><span>Started in time</span><span>{v.started_in_time ? 'Yes' : 'No'}</span></div>
        <div className="kv-row"><span>Status</span><span>{statusMeta(v.status).label}</span></div>
        <div className="kv-row"><span>Counts for judging</span><span>{v.currently_counts ? 'Yes' : 'No'}</span></div>
      </div>
      <div className="label-sm" style={{ marginTop: 14 }}>SHA-256</div>
      <div className="mono" style={{ wordBreak: 'break-all', fontSize: 12.5 }}>{v.sha256 ?? 'Computed after checks finish'}</div>
      <div className="row" style={{ marginTop: 18 }}><span className="spacer" />
        <button className="btn" onClick={() => window.print()}>Print</button>
        {v.sha256 && <CopyButton text={v.sha256} label="Copy hash" />}
      </div>
    </Overlay>
  );
}
