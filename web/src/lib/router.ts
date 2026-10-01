// Minimal history-API router. The open job lives in ?job=<id> so a link to a
// job can be pasted into chat or email.

import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
window.addEventListener('popstate', emit);

const snapshot = () => location.pathname + location.search;

export function useLocation(): { path: string; params: URLSearchParams } {
  const s = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    snapshot,
  );
  const u = new URL(s, location.origin);
  return { path: u.pathname, params: u.searchParams };
}

export function navigate(path: string, opts: { keepJob?: boolean; replace?: boolean } = {}) {
  const u = new URL(path, location.origin);
  const job = new URLSearchParams(location.search).get('job');
  if (opts.keepJob && job && !u.searchParams.has('job')) u.searchParams.set('job', job);
  const next = u.pathname + u.search;
  if (next === snapshot()) return;
  history[opts.replace ? 'replaceState' : 'pushState'](null, '', next);
  emit();
}

export function setJob(id: number | null) {
  const u = new URL(location.href);
  if (id == null) u.searchParams.delete('job');
  else u.searchParams.set('job', String(id));
  const next = u.pathname + u.search;
  if (next === snapshot()) return;
  history.pushState(null, '', next);
  emit();
}
