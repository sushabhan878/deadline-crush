import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { fetchTime, ServerTime } from './api';
import { initials, pad2, phaseAt, Phase, splitDuration, statusMeta } from './lib';

/* ---------- icons (inline, stroke = currentColor) ---------- */
const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
const svg = (d: React.ReactNode, size = 16) => (props: { size?: number }) => (
  <svg width={props.size ?? size} height={props.size ?? size} viewBox="0 0 24 24" aria-hidden="true" {...P}>{d}</svg>
);
export const I = {
  search: svg(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>),
  moon: svg(<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />),
  sun: svg(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>),
  chevDown: svg(<path d="m6 9 6 6 6-6" />, 14),
  chevRight: svg(<path d="m9 6 6 6-6 6" />),
  arrowRight: svg(<path d="M5 12h14M13 6l6 6-6 6" />),
  link: svg(<><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></>),
  bookmark: svg(<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />),
  trophy: svg(<><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z" /><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" /></>, 14),
  calendar: svg(<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" /></>, 14),
  users: svg(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6" /></>, 14),
  globe: svg(<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>, 14),
  check: svg(<path d="m5 12 5 5L20 7" />),
  mail: svg(<><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>),
  upload: svg(<><path d="M12 16V4M6 10l6-6 6 6" /><path d="M4 20h16" /></>, 20),
  copy: svg(<><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></>, 13),
  sparkle: svg(<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />, 12),
  x: svg(<path d="M6 6l12 12M18 6 6 18" />),
  download: svg(<><path d="M12 4v12M6 10l6 6 6-6" /><path d="M4 20h16" /></>, 14),
  receipt: svg(<><path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z" /><path d="M9 8h6M9 12h6" /></>, 14),
  pause: svg(<path d="M8 5v14M16 5v14" />, 14),
  play: svg(<path d="M7 5v14l11-7z" />, 14),
  wifiOff: svg(<><path d="M2 2l20 20M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5.2-2.8M19 13a10 10 0 0 0-2.3-1.7M2 8.8a15 15 0 0 1 4.2-2.6M22 8.8A15 15 0 0 0 10.7 5" /><circle cx="12" cy="20" r="0.5" /></>),
  clock: svg(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>),
};

/* ---------- theme ---------- */
export function useTheme() {
  const [theme, setTheme] = useState(document.documentElement.dataset.theme ?? 'dark');
  const toggle = () => {
    const t = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = t; localStorage.setItem('dc_theme', t); setTheme(t);
  };
  return { theme, toggle };
}

/* ---------- top nav ---------- */
export interface NavItem { href: string; label: string }
export function TopNav({ items, route, user, onLogout, onSearch }: {
  items: NavItem[]; route: string; user?: { email: string; role: string } | null; onLogout?: () => void; onSearch?: (q: string) => void;
}) {
  const { theme, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); searchRef.current?.focus(); } };
    const c = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('keydown', k); window.addEventListener('mousedown', c);
    return () => { window.removeEventListener('keydown', k); window.removeEventListener('mousedown', c); };
  }, []);
  return (
    <header className="nav">
      <a href="#/" className="brand" aria-label="Deadline Crush home"><span className="brand-mark"><I.clock size={21} /></span>Deadline Crush</a>
      <nav className="nav-links" aria-label="Main">
        {items.map((it) => (
          <a key={it.href} href={it.href} className={`nav-link${route === it.href.slice(1) ? ' active' : ''}`}
            aria-current={route === it.href.slice(1) ? 'page' : undefined}>{it.label}</a>
        ))}
      </nav>
      <div className="nav-right">
        {onSearch && <label className="search">
          <I.search size={15} />
          <input ref={searchRef} placeholder="Search..." aria-label="Search teams"
            onKeyDown={(e) => { if (e.key === 'Enter' && onSearch) onSearch((e.target as HTMLInputElement).value); }} />
          <span className="kbd">Ctrl K</span>
        </label>}
        <button className="icon-btn" onClick={toggle} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>
          {theme === 'dark' ? <I.moon size={17} /> : <I.sun size={17} />}
        </button>
        {user ? (
          <div className="menu" ref={menuRef}>
            <button className="menu-btn" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} aria-label="Account menu">
              <span className="avatar">{initials(user.email)}</span><span className="muted"><I.chevDown /></span>
            </button>
            {open && (
              <div className="menu-pop" role="menu">
                <div className="who"><div>{user.email}</div><div className="muted" style={{ textTransform: 'capitalize' }}>{user.role}</div></div>
                <button role="menuitem" onClick={() => { setOpen(false); onLogout?.(); }}>Log out</button>
              </div>
            )}
          </div>
        ) : <a className="btn sm" href="#/login">Log in</a>}
      </div>
    </header>
  );
}

/* ---------- server-time hook (F-03) ---------- */
export function useServerTime(hackathonId?: string) {
  const [t, setT] = useState<ServerTime | null>(null);
  const [, tick] = useState(0);
  const [error, setError] = useState(false);
  const load = useCallback(() => fetchTime(hackathonId).then((x) => { setT(x); setError(false); }).catch(() => setError(true)), [hackathonId]);
  useEffect(() => {
    void load();
    const a = setInterval(load, 30_000), b = setInterval(() => tick((n) => n + 1), 1000);
    return () => { clearInterval(a); clearInterval(b); };
  }, [load]);
  if (!t) return { t: null, now: Date.now(), phase: null as Phase | null, error, reload: load };
  const now = Date.now() + t.offset; // server-aligned; display only
  return { t, now, phase: phaseAt(now, t.deadlineMs, t.graceEndsMs), error, reload: load };
}

export function CountdownBoxes({ ms }: { ms: number }) {
  const d = splitDuration(ms);
  const cells: [number, string][] = [[d.days, 'Days'], [d.hours, 'Hours'], [d.mins, 'Mins'], [d.secs, 'Secs']];
  return (
    <div className="cd" role="timer" aria-label={`${d.days} days ${d.hours} hours ${d.mins} minutes ${d.secs} seconds`}>
      {cells.map(([n, l]) => <div key={l} className="cd-box"><div className="cd-n">{pad2(n)}</div><div className="cd-l">{l}</div></div>)}
    </div>
  );
}

export function PhasePill({ phase }: { phase: Phase | null }) {
  if (!phase) return null;
  const label = phase === 'open' ? 'Open' : phase === 'grace' ? 'Grace period' : 'Closed';
  return <span className={`pill ${phase}`}><span className="dot" />{label}</span>;
}

export function StatusPill({ status }: { status?: string | null }) {
  const m = statusMeta(status);
  return <span className={`pill ${m.tone}`}><span aria-hidden="true">{m.icon}</span>{m.label}</span>;
}

/* ---------- toasts ---------- */
type Toast = { id: number; tone: 'ok' | 'bad' | 'info'; text: string };
const ToastCtx = createContext<(tone: Toast['tone'], text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast['tone'], text: string) => {
    const id = Date.now() + Math.random();
    setList((l) => [...l.slice(-3), { id, tone, text }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {list.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------- overlay (modal / drawer) ---------- */
export function Overlay({ kind, title, onClose, children }: { kind: 'modal' | 'drawer'; title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => { window.removeEventListener('keydown', k); prev?.focus(); };
  }, [onClose]);
  return (
    <div className={`scrim${kind === 'modal' ? ' center' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={kind} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref}>
        <div className="row" style={{ marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{title}</h2><span className="spacer" />
          <button className="icon-btn" onClick={onClose} aria-label="Close"><I.x /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const toast = useToast();
  return (
    <button className="copy" onClick={() => navigator.clipboard?.writeText(text).then(() => toast('ok', 'Copied to clipboard'), () => toast('bad', 'Copy failed'))}
      aria-label={`Copy ${label ?? text}`}>
      <span className="mono">{label ?? text}</span><I.copy />
    </button>
  );
}

export const Skeleton = ({ h = 16, w = '100%' }: { h?: number; w?: number | string }) => <div className="skeleton" style={{ height: h, width: w }} />;
