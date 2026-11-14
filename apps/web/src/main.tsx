import './styles.css';
import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, exitDemo, getToken, isDemo, setToken } from './api';
import { resetDemo } from './mock';
import { HackathonPage } from './HackathonPage';
import { TeamPage } from './TeamPage';
import { OrganizerPage } from './OrganizerPage';
import { StatusPage } from './StatusPage';
import { NavItem, ToastProvider, TopNav, useToast } from './ui';

export interface Me {
  user: { id: string; email: string; role: 'participant' | 'organizer' };
  team: { team_id: string; team_name: string; invite_code: string; hackathon_id: string; submission_id: string } | null;
}

const useRoute = () => {
  const get = () => location.hash.replace(/^#/, '').split('?')[0] || '/';
  const [r, setR] = useState(get);
  useEffect(() => { const f = () => { setR(get()); window.scrollTo(0, 0); }; window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  return r;
};
export const go = (r: string) => { location.hash = r; };

function Login({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [teamMode, setTeamMode] = useState<'create' | 'join'>('create');
  const [f, setF] = useState({ email: '', password: '', name: '', joinCode: 'DEMO', teamName: '', teamCode: '' });
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const body = mode === 'login' ? { email: f.email, password: f.password } : {
        email: f.email, password: f.password, name: f.name, joinCode: f.joinCode,
        ...(teamMode === 'create' ? { teamName: f.teamName } : { teamCode: f.teamCode }),
      };
      const r = await api(`/auth/${mode}`, { body });
      setToken(r.token); onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const fill = (email: string) => setF({ ...f, email, password: 'password123' });
  return (
    <main className="auth">
      <div className="card">
        <h1>{mode === 'login' ? 'Welcome back' : 'Join the challenge'}</h1>
        <p className="muted" style={{ margin: 0, fontSize: 14 }}>Sign in to submit your project before the deadline.</p>
        <div className="seg-full" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')}>Log in</button>
          <button type="button" role="tab" aria-selected={mode === 'signup'} className={mode === 'signup' ? 'on' : ''} onClick={() => setMode('signup')}>Sign up</button>
        </div>
        <form onSubmit={submit}>
          {mode === 'signup' && <label className="field">Full name<input className="input" required value={f.name} onChange={set('name')} autoComplete="name" /></label>}
          <label className="field">Email<input className="input" type="email" required value={f.email} onChange={set('email')} autoComplete="email" /></label>
          <label className="field">Password<input className="input" type="password" required minLength={mode === 'signup' ? 8 : 1} value={f.password} onChange={set('password')} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
            {mode === 'signup' && <span className="hint">At least 8 characters.</span>}</label>
          {mode === 'signup' && <>
            <label className="field">Hackathon join code<input className="input" required value={f.joinCode} onChange={set('joinCode')} /></label>
            <div className="seg" style={{ marginBottom: 14 }}>
              <button type="button" className={teamMode === 'create' ? 'on' : ''} onClick={() => setTeamMode('create')}>Create a team</button>
              <button type="button" className={teamMode === 'join' ? 'on' : ''} onClick={() => setTeamMode('join')}>Join with invite code</button>
            </div>
            {teamMode === 'create'
              ? <label className="field">Team name<input className="input" required minLength={2} value={f.teamName} onChange={set('teamName')} /></label>
              : <label className="field">Team invite code<input className="input" required value={f.teamCode} onChange={set('teamCode')} /><span className="hint">Ask a teammate for the code shown in their workspace.</span></label>}
          </>}
          {err && <div className="alert bad" role="alert" style={{ marginBottom: 14 }}>{err}</div>}
          <button className="btn primary block" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Log in' : 'Create account'}</button>
        </form>
        {(isDemo() || import.meta.env.DEV) && <div className="demo-accounts">
          Demo accounts (password <span className="mono">password123</span>):{' '}
          <button onClick={() => fill('team1@demo.test')}>team1@demo.test</button>{' · '}
          <button onClick={() => fill('organizer@demo.test')}>organizer@demo.test</button>
        </div>}
      </div>
    </main>
  );
}

function App() {
  const route = useRoute();
  const toast = useToast();
  const [me, setMe] = useState<Me | null>(null);
  const [state, setState] = useState<'loading' | 'anon' | 'ready'>('loading');
  const load = useCallback(async () => {
    if (!getToken()) return setState('anon');
    try { setMe(await api('/me')); setState('ready'); } catch (e: any) {
      if (e.status === 401) { setToken(null); setState('anon'); } else { setState('anon'); toast('bad', e.message); }
    }
  }, [toast]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const f = () => { setToken(null); setMe(null); setState('anon'); toast('info', 'Your session expired. Please log in again.'); go('/login'); };
    window.addEventListener('dc:unauthorized', f); return () => window.removeEventListener('dc:unauthorized', f);
  }, [toast]);
  const logout = () => { setToken(null); setMe(null); setState('anon'); go('/'); };

  const isOrg = me?.user.role === 'organizer';
  const items: NavItem[] = [
    { href: '#/', label: 'Overview' },
    { href: isOrg ? '#/organizer' : '#/workspace', label: isOrg ? 'Submissions' : 'My workspace' },
    { href: '#/status', label: 'Status' },
    ...(isOrg ? [] : [{ href: '#/organizer', label: 'Organizer' }]),
  ].filter((x, i, a) => a.findIndex((y) => y.href === x.href) === i);

  const needsAuth = route === '/workspace' || route === '/organizer';
  let page: React.ReactNode;
  if (state === 'loading') page = <div className="page page-pad"><div className="skeleton" style={{ height: 200 }} /></div>;
  else if (route === '/status') page = <StatusPage />;
  else if (route === '/login' || (needsAuth && state === 'anon'))
    page = <Login onDone={async () => { await load(); go(route === '/login' ? '/workspace' : route); }} />;
  else if (route === '/workspace') page = me?.team ? <TeamPage me={me} /> : isOrg ? <Redirect to="/organizer" /> : <NoTeam />;
  else if (route === '/organizer') page = isOrg ? <OrganizerPage /> : <Forbidden />;
  else page = <HackathonPage me={me} hackathonId={me?.team?.hackathon_id} />;

  return (
    <>
      {isDemo() && (
        <div className="banner demo" role="note">
          <b>Demo mode</b><span>— running against in-browser sample data, no server needed.</span><span className="spacer" />
          <button className="btn sm ghost" onClick={() => { resetDemo(); location.reload(); }}>Reset data</button>
          <button className="btn sm ghost" onClick={exitDemo}>Exit demo</button>
        </div>
      )}
      <TopNav items={items} route={route === '/login' ? '' : route} user={me?.user} onLogout={logout}
        onSearch={isOrg ? (q) => go(`/organizer?q=${encodeURIComponent(q)}`) : undefined} />
      {page}
    </>
  );
}

function Redirect({ to }: { to: string }) { useEffect(() => go(to), [to]); return null; }
const NoTeam = () => <div className="page page-pad"><div className="card empty">You are not on a team yet. Sign up with a join code to create or join one.</div></div>;
const Forbidden = () => <div className="page page-pad"><div className="card empty">This area is for organizers. Log in with an organizer account to see submissions.</div></div>;

document.documentElement.dataset.theme = localStorage.getItem('dc_theme') || 'dark';
createRoot(document.getElementById('root')!).render(<ToastProvider><App /></ToastProvider>);
