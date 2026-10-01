import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JobType, User } from '@board/shared';
import { AppContext, type AppState, type Meta } from './context.ts';
import { del, post, setUnauthenticatedHandler } from './lib/api.ts';
import { setTimeZone } from './lib/format.ts';
import { navigate, setJob, useLocation } from './lib/router.ts';
import { invalidate, startLive, stopLive, useLiveState, useQuery } from './lib/store.ts';
import { toastError } from './lib/toasts.ts';
import { Badge, ErrorBox, Spinner } from './components/bits.tsx';
import { DialogHost, Toasts } from './components/Overlays.tsx';
import { QuickCreate } from './components/QuickCreate.tsx';
import { TicketPanel } from './components/TicketPanel.tsx';
import { SearchBox } from './components/SearchBox.tsx';
import { Bell, ConnectionBanner, OnlineNow } from './components/Collab.tsx';
import { ActivityFeed } from './views/ActivityFeed.tsx';
import { BoardPage } from './views/BoardPage.tsx';
import { Dashboard } from './views/Dashboard.tsx';
import { MyWork } from './views/MyWork.tsx';
import { Reports } from './views/Reports.tsx';
import { Search } from './views/Search.tsx';
import { Today } from './views/Today.tsx';
import { Workload } from './views/Workload.tsx';

const NAV = [
  { path: '/board', label: 'Board', key: 'b' },
  { path: '/today', label: 'Today', key: 't' },
  { path: '/my-work', label: 'My work', key: 'm' },
  { path: '/dashboard', label: 'Dashboard', key: 'd' },
  { path: '/workload', label: 'Workload', key: 'w' },
  { path: '/reports', label: 'Reports', key: 'r' },
];

const VIEWS: Record<string, () => any> = {
  '/board': BoardPage,
  '/today': Today,
  '/my-work': MyWork,
  '/dashboard': Dashboard,
  '/workload': Workload,
  '/reports': Reports,
  '/search': Search,
  '/activity': ActivityFeed,
};

export function App() {
  const session = useQuery<{ user: User | null }>('/api/session');
  const meta = useQuery<Meta>('/api/meta');

  useEffect(() => setUnauthenticatedHandler(() => invalidate('/api/session')), []);
  useEffect(() => {
    if (meta.data) setTimeZone(meta.data.tz);
  }, [meta.data]);

  if ((session.error && !session.data) || (meta.error && !meta.data)) {
    return (
      <div className="center-screen">
        <ErrorBox message={(session.error ?? meta.error)!.message} retry={() => invalidate()} />
      </div>
    );
  }
  if (!session.data || !meta.data) return <div className="center-screen"><Spinner /></div>;
  if (!session.data.user) return <WhoAreYou />;
  return <Shell me={session.data.user} meta={meta.data} />;
}

function WhoAreYou() {
  const users = useQuery<{ users: User[] }>('/api/users');
  const [busy, setBusy] = useState(false);
  const pick = async (u: User) => {
    setBusy(true);
    try {
      await post('/api/session', { user_id: u.id });
      invalidate();
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };
  return (
    <div className="center-screen who">
      <div className="who-card">
        <h1 className="brand-big">Engineering Board</h1>
        <p className="muted">Who's at this computer? The board remembers you on this browser.</p>
        {users.error && <ErrorBox message={users.error.message} retry={users.refresh} />}
        {!users.data && !users.error && <Spinner />}
        <div className="who-grid">
          {users.data?.users.map((u) => (
            <button key={u.id} className="who-option" disabled={busy} onClick={() => void pick(u)}>
              <Badge user={u} size="lg" />
              <span className="who-name">{u.name}</span>
              <span className="muted who-role">{u.role === 'manager' ? 'Manager' : 'Engineer'}</span>
            </button>
          ))}
        </div>
      </div>
      <Toasts />
    </div>
  );
}

function Shell({ me, meta }: { me: User; meta: Meta }) {
  const users = useQuery<{ users: User[] }>('/api/users?all=1');
  const types = useQuery<{ job_types: JobType[] }>('/api/job-types');
  const { path, params } = useLocation();
  const [creating, setCreating] = useState(false);
  const live = useLiveState();
  const jobId = Number(params.get('job')) || null;

  useEffect(() => {
    startLive(me.id, meta.version);
    return stopLive;
  }, []);
  useEffect(() => {
    if (path === '/') navigate('/board', { replace: true, keepJob: true });
  }, [path]);

  const openJob = useCallback((id: number | null) => setJob(id), []);
  const newJob = useCallback(() => setCreating(true), []);

  // keyboard shortcuts (never while typing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable="true"]') || document.querySelector('.dialog-backdrop')) return;
      const k = e.key.toLowerCase();
      if (k === 'n') {
        e.preventDefault();
        setCreating(true);
        return;
      }
      const nav = NAV.find((n) => n.key === k);
      if (nav) navigate(nav.path, { keepJob: true });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const state = useMemo<AppState | null>(() => {
    if (!users.data || !types.data) return null;
    const all = users.data.users;
    const byId = new Map(all.map((u) => [u.id, u]));
    const jt = new Map(types.data.job_types.map((j) => [j.id, j]));
    return {
      me: byId.get(me.id) ?? me,
      users: all,
      engineers: all.filter((u) => u.role === 'engineer'),
      jobTypes: types.data.job_types,
      meta,
      user: (id) => (id == null ? undefined : byId.get(id)),
      jobType: (id) => (id == null ? undefined : jt.get(id)),
      openJob,
      newJob,
    };
  }, [users.data, types.data, me, meta, openJob, newJob]);

  if (!state) {
    const err = users.error ?? types.error;
    return <div className="center-screen">{err ? <ErrorBox message={err.message} retry={() => invalidate()} /> : <Spinner />}</div>;
  }

  const signOut = async () => {
    try {
      await del('/api/session');
    } finally {
      invalidate();
    }
  };

  return (
    <AppContext.Provider value={state}>
      <div className={`shell${jobId ? ' has-panel' : ''}`}>
        <header className="topbar">
          <a
            className="brand"
            href="/board"
            onClick={(e: any) => {
              e.preventDefault();
              navigate('/board');
            }}
          >
            Engineering Board
          </a>
          <nav className="nav" aria-label="Views">
            {NAV.map((n) => (
              <a
                key={n.path}
                href={n.path}
                className={path === n.path ? 'active' : ''}
                aria-current={path === n.path ? 'page' : undefined}
                title={`${n.label} (${n.key.toUpperCase()})`}
                onClick={(e: any) => {
                  e.preventDefault();
                  navigate(n.path, { keepJob: true });
                }}
              >
                {n.label}
              </a>
            ))}
          </nav>
          <span className="spacer" />
          <SearchBox />
          <OnlineNow />
          <span className={`live live-${live}`} title={live === 'live' ? 'Changes from your team appear automatically' : 'Trying to reconnect to the server'}>
            <span className="live-dot" aria-hidden="true" />
            {live === 'live' ? 'Live' : live === 'connecting' ? 'Reconnecting…' : 'Offline'}
          </span>
          <Bell />
          <button className="btn btn-primary new-job" onClick={() => setCreating(true)} title="New job (N)">
            + New job
          </button>
          <details className="me-menu">
            <summary aria-label="Account">
              <Badge user={state.me} />
              <span className="me-name">{state.me.name}</span>
            </summary>
            <div className="me-pop">
              <button className="btn btn-quiet" onClick={() => void signOut()}>
                Switch user
              </button>
            </div>
          </details>
        </header>

        <ConnectionBanner />
        {meta.pin_is_default && state.me.is_admin && (
          <div className="banner">The admin PIN is still the default (1234). It can be changed from the admin area once that's built in Phase 6.</div>
        )}

        <main className="main">
          <View path={path} />
        </main>

        {jobId && <TicketPanel id={jobId} onClose={() => setJob(null)} />}
      </div>
      {creating && <QuickCreate onClose={() => setCreating(false)} />}
      <DialogHost />
      <Toasts />
    </AppContext.Provider>
  );
}

function View({ path }: { path: string }) {
  const V = VIEWS[path] ?? (path === '/' ? BoardPage : null);
  if (!V)
    return (
      <div className="center-screen">
        <div className="error-box">
          <p>There's no page at {path}.</p>
          <button className="btn" onClick={() => navigate('/board')}>
            Go to the board
          </button>
        </div>
      </div>
    );
  return <V />;
}
