import { useCallback, useEffect, useMemo, useState } from 'react';
import { PASSWORD_MIN, ROLE_LABEL, type JobType, type User } from '@board/shared';
import { AppContext, type AppState, type Meta } from './context.ts';
import { del, post, setUnauthenticatedHandler } from './lib/api.ts';
import { setTimeZone } from './lib/format.ts';
import { navigate, setJob, useLocation } from './lib/router.ts';
import { invalidate, startLive, stopLive, useLiveState, useQuery } from './lib/store.ts';
import { toast, toastError } from './lib/toasts.ts';
import { Badge, ErrorBox, Spinner } from './components/bits.tsx';
import { DialogHost, Toasts } from './components/Overlays.tsx';
import { QuickCreate } from './components/QuickCreate.tsx';
import { TicketPanel } from './components/TicketPanel.tsx';
import { SearchBox } from './components/SearchBox.tsx';
import { ThemePicker } from './components/ThemePicker.tsx';
import { Bell, ConnectionBanner, OnlineNow } from './components/Collab.tsx';
import { ActivityFeed } from './views/ActivityFeed.tsx';
import { Admin } from './views/admin/Admin.tsx';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { ask } from './lib/dialogs.ts';
import { setPageTitle } from './lib/title.ts';
import { BoardPage } from './views/BoardPage.tsx';
import { Dashboard } from './views/Dashboard.tsx';
import { MyWork } from './views/MyWork.tsx';
import { Reports } from './views/Reports.tsx';
import { Search } from './views/Search.tsx';
import { Today } from './views/Today.tsx';
import { Workload } from './views/Workload.tsx';
import { ReviewQueue } from './views/ReviewQueue.tsx';
import { ReviewWorkspaceView } from './views/ReviewWorkspace.tsx';

const NAV = [
  { path: '/board', label: 'Board', key: 'b' },
  { path: '/today', label: 'Today', key: 't' },
  { path: '/my-work', label: 'My work', key: 'm' },
  { path: '/dashboard', label: 'Dashboard', key: 'd' },
  { path: '/review', label: 'Review', key: 'v' },
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
  '/admin': Admin,
  '/review': ReviewQueue,
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

/** Sign-in: pick your name, then enter your password (or create it the first time). */
function WhoAreYou() {
  const users = useQuery<{ users: User[] }>('/api/users');
  const [whoId, setWhoId] = useState<number | null>(null);
  // always the fresh copy, so a password created or reset elsewhere shows the right form
  const who = users.data?.users.find((u) => u.id === whoId) ?? null;
  return (
    <div className="center-screen who">
      <div className="who-card">
        <h1 className="brand-big">Engineering Board</h1>
        <ThemePicker />
        {who ? (
          <SignIn user={who} back={() => setWhoId(null)} />
        ) : (
          <>
            <p className="muted">Who's at this computer? Pick your name, then enter your password. The board remembers you on this browser.</p>
            {users.error && <ErrorBox message={users.error.message} retry={users.refresh} />}
            {!users.data && !users.error && <Spinner />}
            <div className="who-grid">
              {users.data?.users.map((u) => (
                <button key={u.id} className="who-option" onClick={() => setWhoId(u.id)}>
                  <Badge user={u} size="lg" />
                  <span className="who-name">{u.name}</span>
                  <span className="muted who-role">{ROLE_LABEL[u.role]}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
      <Toasts />
    </div>
  );
}

function SignIn({ user, back }: { user: User; back: () => void }) {
  const creating = !user.has_password;
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = creating && again.length > 0 && password !== again;
  const ok = creating ? password.length >= PASSWORD_MIN && password.trim().length > 0 && password === again : password.length > 0;
  const submit = async (e: any) => {
    e.preventDefault();
    if (!ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      await post(creating ? '/api/session/password' : '/api/session', { user_id: user.id, password });
      invalidate();
    } catch (err: any) {
      if (err?.code === 'password_not_set' || err?.code === 'password_already_set') {
        // changed under us (an admin reset, or a first sign-in from two browsers): show the right form
        setPassword('');
        setAgain('');
        setError(err.message);
        invalidate('/api/users');
      } else if (err?.code === 'wrong_password' || err?.code === 'too_many_attempts' || err?.status === 400) {
        setError(err.message);
      } else toastError(err);
      setBusy(false);
    }
  };
  return (
    <form className="signin" onSubmit={submit}>
      <div className="signin-who">
        <Badge user={user} size="lg" />
        <div>
          <div className="who-name">{user.name}</div>
          <div className="muted who-role">{ROLE_LABEL[user.role]}</div>
        </div>
        <button type="button" className="link-btn signin-back" onClick={back}>
          Not you?
        </button>
      </div>
      {creating ? (
        <p className="muted">
          Welcome, {user.name.split(' ')[0]}. You don't have a password yet: create one now (at least {PASSWORD_MIN} characters; a short phrase is fine). Only you should know it.
        </p>
      ) : (
        <p className="muted">Enter your password to sign in.</p>
      )}
      <label className="field-label" htmlFor="signin-password">
        {creating ? 'New password' : 'Password'}
      </label>
      <input
        id="signin-password"
        name="password"
        className="field-input"
        type="password"
        autoComplete={creating ? 'new-password' : 'current-password'}
        autoFocus
        value={password}
        aria-invalid={!!error}
        onChange={(e: any) => setPassword(e.target.value)}
      />
      {creating && (
        <>
          <label className="field-label" htmlFor="signin-again">
            New password again
          </label>
          <input
            id="signin-again"
            name="password_again"
            className="field-input"
            type="password"
            autoComplete="new-password"
            value={again}
            aria-invalid={mismatch}
            onChange={(e: any) => setAgain(e.target.value)}
          />
          {mismatch && <p className="form-error">The two passwords don't match.</p>}
        </>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!creating && <p className="muted small">Forgotten it? Ask whoever looks after the board to reset it under Admin → Team.</p>}
      <div className="dialog-buttons">
        <button type="button" className="btn btn-quiet" onClick={back}>
          Back
        </button>
        <button type="submit" className="btn btn-primary" disabled={!ok || busy}>
          {creating ? 'Create password and sign in' : 'Sign in'}
        </button>
      </div>
    </form>
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
      if (e.key === '?') {
        e.preventDefault();
        void ask({ type: 'help' });
        return;
      }
      const k = e.key.toLowerCase();
      if (k === 'n') {
        e.preventDefault();
        if (me.role !== 'reviewer') setCreating(true);
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
  const changePassword = async () => {
    if (await ask({ type: 'password' })) toast('Your password has been changed.', { kind: 'success' });
  };

  return (
    <AppContext.Provider value={state}>
      <div className={`shell${jobId ? ' has-panel' : ''}`}>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
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
                className={path === n.path || path.startsWith(n.path + '/') ? 'active' : ''}
                aria-current={path === n.path || path.startsWith(n.path + '/') ? 'page' : undefined}
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
          <button className="help-btn" onClick={() => void ask({ type: 'help' })} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">
            ?
          </button>
          <Bell />
          <ThemePicker />
          {state.me.role !== 'reviewer' && (
            <button className="btn btn-primary new-job" onClick={() => setCreating(true)} title="New job (N)">
              + New job
            </button>
          )}
          <details className="me-menu">
            <summary aria-label="Account">
              <Badge user={state.me} />
              <span className="me-name">{state.me.name}</span>
            </summary>
            <div className="me-pop">
              <button className="btn btn-quiet" onClick={() => navigate('/activity')}>
                Team activity
              </button>
              <button className="btn btn-quiet" onClick={() => navigate('/admin')}>
                Admin
              </button>
              <a className="btn btn-quiet" href="/guides/user-guide.html" target="_blank" rel="noopener">
                User guide
              </a>
              <button className="btn btn-quiet" onClick={() => void changePassword()}>
                Change password
              </button>
              <button className="btn btn-quiet" onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
          </details>
        </header>

        <ConnectionBanner />
        {meta.pin_is_default && state.me.is_admin && path !== '/admin' && (
          <div className="banner">
            The admin PIN is still the default (1234).{' '}
            <button className="link-btn" onClick={() => navigate('/admin?s=pin')}>
              Change it in Admin
            </button>
          </div>
        )}

        <main className="main" id="main" tabIndex={-1}>
          <ErrorBoundary resetKey={path}>
            <View path={path} />
          </ErrorBoundary>
        </main>

        {jobId && <TicketPanel id={jobId} onClose={() => setJob(null)} />}
      </div>
      {creating && <QuickCreate onClose={() => setCreating(false)} />}
      <DialogHost />
      <Toasts />
    </AppContext.Provider>
  );
}

const TITLES: Record<string, string> = {
  '/board': 'Board',
  '/today': 'Today',
  '/my-work': 'My work',
  '/dashboard': 'Dashboard',
  '/workload': 'Workload',
  '/reports': 'Reports',
  '/search': 'Search',
  '/activity': 'Team activity',
  '/admin': 'Admin',
  '/review': 'Drawing review',
};

function View({ path }: { path: string }) {
  useEffect(() => setPageTitle(TITLES[path] ?? (path.startsWith('/review/') ? 'Drawing review' : '')), [path]);
  const reviewJob = /^\/review\/(\d+)$/.exec(path);
  if (reviewJob) return <ReviewWorkspaceView ticketId={Number(reviewJob[1])} />;
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
