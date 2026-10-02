// A small query cache (a stand-in for TanStack Query) plus the live-update
// connection. Components call useQuery(url); mutations call invalidate().

import { useEffect, useSyncExternalStore } from 'react';
import { ApiError, get } from './api.ts';
import { getAllTicketPages, type TicketPage } from './ticketPages.ts';

interface Entry {
  data?: unknown;
  error?: ApiError;
  loading: boolean;
  inflight?: Promise<void>;
  fetcher?: (key: string) => Promise<unknown>;
  invalidated?: boolean;
  listeners: Set<() => void>;
  snapshot: { data?: unknown; error?: ApiError; loading: boolean };
}

const cache = new Map<string, Entry>();

function entry(key: string): Entry {
  let e = cache.get(key);
  if (!e) {
    e = { loading: false, listeners: new Set(), snapshot: { loading: false } };
    cache.set(key, e);
  }
  return e;
}

function publish(e: Entry) {
  e.snapshot = { data: e.data, error: e.error, loading: e.loading };
  for (const l of e.listeners) l();
}

function fetchKey(key: string): Promise<void> {
  const e = entry(key);
  if (e.inflight) return e.inflight;
  e.loading = true;
  publish(e);
  e.inflight = (e.fetcher ?? get)(key)
    .then((data) => {
      e.data = data;
      e.error = undefined;
    })
    .catch((err: ApiError) => {
      e.error = err;
    })
    .finally(() => {
      e.loading = false;
      e.inflight = undefined;
      publish(e);
      // An SSE update arriving midway through a multi-page load must not be
      // swallowed. Coalesce it into one subsequent refresh of watched data.
      if (e.invalidated) {
        e.invalidated = false;
        if (e.listeners.size) void fetchKey(key);
        else cache.delete(key);
      }
    });
  return e.inflight;
}

export interface QueryResult<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  refresh: () => Promise<void>;
}

const EMPTY = { data: undefined, error: undefined, loading: false };

export function useQuery<T>(key: string | null, fetcher?: (key: string) => Promise<unknown>): QueryResult<T> {
  if (key && fetcher) entry(key).fetcher = fetcher;
  const snap = useSyncExternalStore(
    (cb) => {
      if (!key) return () => {};
      const e = entry(key);
      e.listeners.add(cb);
      return () => e.listeners.delete(cb);
    },
    () => (key ? entry(key).snapshot : EMPTY),
  );
  useEffect(() => {
    if (key && entry(key).data === undefined && !entry(key).inflight) void fetchKey(key);
  }, [key]);
  return {
    data: snap.data as T | undefined,
    error: snap.error,
    loading: snap.loading || (key != null && snap.data === undefined && !snap.error),
    refresh: () => (key ? fetchKey(key) : Promise.resolve()),
  };
}

/** All pages share one cache entry and are replaced atomically on refresh. */
export function useTicketQuery(key: string | null): QueryResult<TicketPage> {
  return useQuery<TicketPage>(key, getAllTicketPages);
}

/** Refetch every watched query whose key matches; forget unwatched ones. */
export function invalidate(match: string | ((key: string) => boolean) = () => true) {
  const test = typeof match === 'string' ? (k: string) => k.startsWith(match) : match;
  for (const [key, e] of cache) {
    if (!test(key)) continue;
    if (e.listeners.size) {
      if (e.inflight) e.invalidated = true;
      else void fetchKey(key);
    } else cache.delete(key);
  }
}

/** Overwrite cached data locally (used to apply server responses immediately). */
export function setCached<T>(key: string, fn: (prev: T | undefined) => T) {
  const e = entry(key);
  e.data = fn(e.data as T | undefined);
  publish(e);
}

export const TICKET_KEYS = (k: string) =>
  /^\/api\/(tickets|dashboard|today|my-work|workload|activity|tags|notifications|reports|reviews)/.test(k);

// ---------------------------------------------------------------------------
// Live updates (Server-Sent Events) with a 30-second polling fallback
// ---------------------------------------------------------------------------

export type LiveState = 'connecting' | 'live' | 'offline';
let liveState: LiveState = 'connecting';
const liveListeners = new Set<() => void>();
function setLive(s: LiveState) {
  if (s === liveState) return;
  liveState = s;
  liveListeners.forEach((l) => l());
}
export function useLiveState(): LiveState {
  return useSyncExternalStore(
    (cb) => {
      liveListeners.add(cb);
      return () => liveListeners.delete(cb);
    },
    () => liveState,
  );
}

// ---- cards recently changed by someone else (for a brief highlight) ----
const changed = new Map<number, { by: number | null; at: number }>();
const changedListeners = new Set<() => void>();
let changedVersion = 0;
function markChanged(id: number, by: number | null) {
  changed.set(id, { by, at: Date.now() });
  changedVersion++;
  changedListeners.forEach((l) => l());
  setTimeout(() => {
    const c = changed.get(id);
    if (c && Date.now() - c.at >= 3900) {
      changed.delete(id);
      changedVersion++;
      changedListeners.forEach((l) => l());
    }
  }, 4000);
}
/** Who changed this job in the last few seconds (someone other than you), if anyone. */
export function useRecentChange(id: number): number | null | undefined {
  useSyncExternalStore(
    (cb) => {
      changedListeners.add(cb);
      return () => changedListeners.delete(cb);
    },
    () => changedVersion,
  );
  return changed.get(id)?.by;
}

// ---- server version: tell people to reload after an upgrade ----
let serverVersion: string | null = null;
let newVersion = false;
const versionListeners = new Set<() => void>();
export function useNewVersionAvailable(): boolean {
  return useSyncExternalStore(
    (cb) => {
      versionListeners.add(cb);
      return () => versionListeners.delete(cb);
    },
    () => newVersion,
  );
}

let source: EventSource | null = null;
let myId: number | null = null;
let pollTimer: number | undefined;
let pending = false;
let wasOffline = false;

function scheduleRefresh() {
  if (pending) return;
  pending = true;
  // coalesce bursts (e.g. a drag fires several events)
  setTimeout(() => {
    pending = false;
    invalidate(TICKET_KEYS);
  }, 120);
}

export function startLive(meId?: number, loadedVersion?: string) {
  if (meId != null) myId = meId;
  if (loadedVersion && !serverVersion) serverVersion = loadedVersion;
  if (source) return;
  source = new EventSource('/api/events');
  source.addEventListener('hello', (ev: MessageEvent) => {
    setLive('live');
    try {
      const v = JSON.parse(ev.data).version as string | undefined;
      if (v && serverVersion && v !== serverVersion && !newVersion) {
        newVersion = true;
        versionListeners.forEach((l) => l());
      }
      if (v && !serverVersion) serverVersion = v;
    } catch {
      /* ignore */
    }
    if (wasOffline) {
      wasOffline = false;
      invalidate(); // catch up on anything missed while disconnected
    }
  });
  source.onmessage = (ev) => {
    try {
      const e = JSON.parse(ev.data);
      if (e.type === 'ticket') {
        if (e.by !== myId && typeof e.id === 'number') markChanged(e.id, e.by ?? null);
        scheduleRefresh();
      } else if (e.type === 'presence') invalidate('/api/presence');
      else if (e.type === 'users') invalidate((k) => k.startsWith('/api/users') || k.startsWith('/api/admin/users') || TICKET_KEYS(k));
      else if (e.type === 'job_types') invalidate('/api/job-types');
      else if (e.type === 'reload') invalidate();
    } catch {
      /* ignore malformed event */
    }
  };
  source.onerror = () => {
    wasOffline = true;
    setLive(source?.readyState === EventSource.CLOSED ? 'offline' : 'connecting');
    if (source?.readyState === EventSource.CLOSED) {
      source = null;
      setTimeout(startLive, 5000);
    }
  };
  if (!pollTimer) pollTimer = window.setInterval(() => invalidate(TICKET_KEYS), 30_000);
}

export function stopLive() {
  source?.close();
  source = null;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
}
