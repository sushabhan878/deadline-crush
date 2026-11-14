import React, { useEffect, useState } from 'react';
import { fetchInfo, HackathonInfo } from './api';
import { formatBytes, shortDate } from './lib';
import type { Me } from './main';
import { CountdownBoxes, I, PhasePill, Skeleton, useServerTime, useToast } from './ui';

const TABS = ['Overview', 'Timeline', 'Submission', 'Prizes', 'Rules', 'FAQ'] as const;
type Tab = typeof TABS[number];

/** Public event page, laid out like the Hack4Hack challenge page. */
export function HackathonPage({ me, hackathonId }: { me: Me | null; hackathonId?: string }) {
  const toast = useToast();
  const [info, setInfo] = useState<HackathonInfo | null>(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<Tab>('Overview');
  const [saved, setSaved] = useState(() => localStorage.getItem('dc_bookmark') === '1');
  const { t, now, phase, error: timeErr } = useServerTime(hackathonId ?? info?.id);

  useEffect(() => { fetchInfo(hackathonId).then(setInfo).catch((e) => setErr(e.message)); }, [hackathonId]);

  const name = info?.name ?? 'Hack4Hack Crew Hiring Challenge 2026';
  const deadline = t ? t.deadlineMs : info ? new Date(info.deadlineAt).getTime() : null;
  const team = me?.team;
  const isOrg = me?.user.role === 'organizer';
  const types = (info?.allowedTypes ?? ['pdf', 'zip']).map((x) => x.toUpperCase()).join(' or ');

  const share = () => navigator.clipboard?.writeText(location.href).then(() => toast('ok', 'Link copied'), () => toast('bad', 'Copy failed'));
  const bookmark = () => { const v = !saved; setSaved(v); localStorage.setItem('dc_bookmark', v ? '1' : '0'); toast('info', v ? 'Saved to bookmarks' : 'Removed from bookmarks'); };

  return (
    <main className="page event-page">
      <section className="cover" aria-labelledby="event-title">
        <div className="cover-inner">
          <div className="cover-sub">Hack4Hack / PS2</div>
          <h1 id="event-title" className="cover-title">Deadline Crush</h1>
          <p>Submit your project with resumable uploads, live checks, and a server-timed receipt.</p>
          <a className="btn primary" href={isOrg ? '#/organizer' : '#/workspace'}>{isOrg ? 'Open dashboard' : 'Open workspace'} <I.arrowRight /></a>
        </div>
      </section>
      <div className="hero-row">
        <div className="hero-pills">
          <PhasePill phase={phase ?? (info?.phase as any) ?? null} />
        </div>
        <div className="hero-actions">
          <button className="icon-btn" onClick={share} aria-label="Copy link to this page"><I.link /></button>
          <button className="icon-btn" onClick={bookmark} aria-label={saved ? 'Remove bookmark' : 'Bookmark'} aria-pressed={saved}
            style={saved ? { color: 'var(--lime)' } : undefined}><I.bookmark /></button>
        </div>
      </div>

      <div className="grid-2 event-content">
        <div style={{ minWidth: 0 }}>
          <h2 className="event-name">{name}</h2>
          {err && <div className="alert warn" role="status" style={{ marginBottom: 16 }}>Live event data is unavailable ({err}). Showing defaults.</div>}

          <div className="stats">
            <Stat k={<><I.upload size={14} /> File limit</>} v={formatBytes(info?.maxFileBytes ?? 104857600)} />
            <Stat k={<><I.clock size={14} /> Upload grace</>} v={`${(info?.graceSeconds ?? 300) / 60} min`} />
            <Stat k={<><I.users /> Teams</>} v={info?.teams.toLocaleString() ?? '—'} />
            <Stat k={<><I.link size={14} /> Public links</>} v={`Up to ${info?.maxLinks ?? 5}`} />
          </div>

          <div className="tabs" role="tablist" aria-label="Event sections">
            {TABS.map((x) => (
              <button key={x} role="tab" aria-selected={tab === x} className={`tab${tab === x ? ' active' : ''}`} onClick={() => setTab(x)}>{x}</button>
            ))}
          </div>
          <div className="prose" role="tabpanel" aria-label={tab}>
            {tab === 'Overview' && <>
              <h3>About the challenge</h3>
              <p>Hack4Hack is hiring engineers who can ship reliable systems under pressure. Instead of a quiz, you solve a real
                problem from our own platform. Pick one problem statement, build it, and submit before the deadline.</p>
              <h3>Problem statements</h3>
              <h4>PS1 · Race-proof team formation at scale</h4>
              <p>Hundreds of people join teams at the same moment. Seats must never be over-allocated and a retried request must never create a duplicate member.</p>
              <h4>PS2 · Deadline Crush: submissions that hold up at the last second</h4>
              <p>Most teams upload in the final minutes. Build a submission flow where the <b>server</b> decides what is on time,
                large files resume after a dropped connection, each upload is a numbered version with a receipt, and automatic
                checks tell teams exactly what to fix.</p>
              <h4>PS3 · Fair judging with conflict-of-interest detection</h4>
              <p>Assign judges to projects so that no one reviews a team they are connected to, and every project gets a balanced number of reviews.</p>
              <h3>What we look for</h3>
              <ul><li>Correctness under concurrency and failure</li><li>Clear, honest UX for stressed users</li><li>Tests that prove the hard parts</li></ul>
            </>}
            {tab === 'Timeline' && <ul className="trail" style={{ maxWidth: 520 }}>
              <li><span className="muted">Start</span><span>{info ? shortDate(info.startsAt) : '—'} · Registration and submissions open</span></li>
              <li><span className="muted">Deadline</span><span>{deadline ? shortDate(deadline) : '—'} · Last moment to <b>start</b> an upload or edit details</span></li>
              <li><span className="muted">Grace</span><span>{info ? `${Math.round(info.graceSeconds / 60)} min` : '—'} · Uploads already started may finish</span></li>
              <li><span className="muted">Results</span><span>Shortlisted teams are contacted within 7 days</span></li>
            </ul>}
            {tab === 'Submission' && <>
              <p>Submit one {types} file up to <b>{formatBytes(info?.maxFileBytes ?? 100 * 1024 * 1024)}</b>, a title, a description and up to {info?.maxLinks ?? 5} https links.</p>
              <ul>
                <li>Every upload creates a new numbered version. The latest accepted version that started before the deadline counts.</li>
                <li>Large files upload in parts and resume automatically if your connection drops.</li>
                <li>Each version gets a receipt with its SHA-256 hash and the server time it was received.</li>
                <li>Automatic checks verify the file type, archive safety and that your links work.</li>
              </ul>
            </>}
            {tab === 'Prizes' && <ul>
              <li><b>Winner</b>: ₹75,000 and a fast-track interview</li><li><b>Runner-up</b>: ₹45,000</li><li><b>Third place</b>: ₹30,000</li>
              <li>All accepted submissions get written feedback from our engineers.</li></ul>}
            {tab === 'Rules' && <ul>
              <li>Teams of 1 to 4. One team per person.</li><li>Work must be your own and built during the event.</li>
              <li>The server clock is final. Your device clock is never used to decide lateness.</li>
              <li>Uploads started after the deadline are rejected and logged.</li></ul>}
            {tab === 'FAQ' && <>
              <h4>My internet dropped during the upload. What now?</h4><p>Pick the same file again. The upload resumes from the parts already received.</p>
              <h4>The deadline passed while my upload was running.</h4><p>If you started before the deadline, the upload can still finish during the grace period and it counts.</p>
              <h4>Which version is judged?</h4><p>The latest accepted version that started on time. It is marked “Counts” in your workspace.</p>
            </>}
          </div>
        </div>

        <aside className="side" aria-label="Registration">
          <div className="card">
            <div className="label-sm">{phase === 'grace' ? 'Grace period ends in' : phase === 'closed' ? 'Submissions closed' : 'Registration closes in'}</div>
            {t ? <CountdownBoxes ms={Math.max(0, (phase === 'grace' ? t.graceEndsMs : t.deadlineMs) - now)} />
              : timeErr ? <div className="cd-note">Server time unavailable.</div> : <Skeleton h={62} />}
            {t && <div className="cd-note">Server time · {shortDate(phase === 'grace' ? t.graceEndsMs : t.deadlineMs)}</div>}

            {team ? <div className="registered"><I.check size={15} /> Registered · {team.team_name}</div>
              : isOrg ? <div className="registered warn">Organizer account</div>
              : <div className="registered warn">Not registered yet</div>}

            <div className="stack" style={{ gap: 10 }}>
              {isOrg ? <a className="btn primary block" href="#/organizer">Open submissions dashboard <I.arrowRight size={15} /></a>
                : team ? <a className="btn primary block" href="#/workspace">Open your workspace <I.arrowRight size={15} /></a>
                : <a className="btn primary block" href="#/login">Register now <I.arrowRight size={15} /></a>}
            </div>

            <div className="kv">
              <div className="kv-row"><span>Registered</span><span>{info?.registered ?? '—'}</span></div>
              <div className="kv-row"><span>Registration</span><span>{info ? `${shortDate(info.startsAt).split(',')[0]} – ${shortDate(info.deadlineAt).split(',')[0]}` : '—'}</span></div>
              <div className="kv-row"><span>Submissions</span><span>{deadline ? `Until ${shortDate(deadline)}` : '—'}</span></div>
              <div className="kv-row"><span>Entry fee</span><span>Free</span></div>
              <div className="kv-row"><span>Eligibility</span><span>Everyone</span></div>
            </div>
          </div>
          <div className="card">
            <div className="label-sm">Contact the organizer</div>
            <a className="side-link" href="mailto:contact@hack4hack.com"><span className="row"><I.mail /> contact@hack4hack.com</span><I.chevRight /></a>
          </div>
          <a className="card side-link" href="#/" onClick={(e) => { e.preventDefault(); setTab('Rules'); window.scrollTo({ top: 420, behavior: 'smooth' }); }}>
            <span>Code of conduct</span><I.chevRight />
          </a>
        </aside>
      </div>
    </main>
  );
}

const Stat = ({ k, v }: { k: React.ReactNode; v: string }) => (
  <div className="stat"><div className="stat-k">{k}</div><div className="stat-v" title={v}>{v}</div></div>
);
