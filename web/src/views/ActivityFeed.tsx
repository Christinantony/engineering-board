// The whole team's history, newest first, grouped by day. "What happened?"

import { useEffect, useState } from 'react';
import type { Activity } from '@board/shared';
import { useApp } from '../context.ts';
import { get } from '../lib/api.ts';
import { clock, localDate } from '../lib/format.ts';
import { navigate, useLocation } from '../lib/router.ts';
import { useQuery } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';
import { Badge, ErrorBox, Spinner } from '../components/bits.tsx';
import { activitySentence } from './Dashboard.tsx';

const PAGE = 100;

function dayLabel(d: string) {
  const today = localDate();
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day, 12));
  const [ty, tm, td] = today.split('-').map(Number);
  const yest = new Date(Date.UTC(ty, tm - 1, td - 1)).toISOString().slice(0, 10);
  if (d === today) return 'Today';
  if (d === yest) return 'Yesterday';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: d.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric' }).format(dt);
}

export function ActivityFeed() {
  const { users, user, openJob } = useApp();
  const { params } = useLocation();
  const who = Number(params.get('user')) || null;
  const key = `/api/activity?limit=${PAGE}${who ? `&user=${who}` : ''}`;
  const q = useQuery<{ activity: Activity[] }>(key);
  const [older, setOlder] = useState<Activity[]>([]);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    setOlder([]);
    setDone(false);
  }, [key]);

  if (q.error && !q.data) return <ErrorBox message={q.error.message} retry={q.refresh} />;
  if (!q.data) return <Spinner label="Loading activity" />;

  // live page + older pages, without duplicates
  const seen = new Set<number>();
  const list = [...q.data.activity, ...older].filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
  const groups: [string, Activity[]][] = [];
  for (const a of list) {
    const d = localDate(new Date(a.at));
    const last = groups[groups.length - 1];
    if (last && last[0] === d) last[1].push(a);
    else groups.push([d, [a]]);
  }

  const loadOlder = async () => {
    const oldest = list[list.length - 1];
    if (!oldest) return;
    setLoading(true);
    try {
      const r = await get<{ activity: Activity[] }>(`/api/activity?limit=${PAGE}&before=${oldest.id}${who ? `&user=${who}` : ''}`);
      setOlder((o) => [...o, ...r.activity]);
      if (r.activity.length < PAGE) setDone(true);
    } catch (e) {
      toastError(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="view view-narrow">
      <header className="view-head">
        <div className="view-head-row">
          <h1>Team activity</h1>
          <div className="who-switch" role="group" aria-label="Show activity by">
            <button className={`fchip${who ? '' : ' on'}`} onClick={() => navigate('/activity')}>
              Everyone
            </button>
            {users
              .filter((u) => u.active)
              .map((u) => (
                <button key={u.id} className={`fbadge${who === u.id ? ' on' : ''}`} title={u.name} onClick={() => navigate(`/activity?user=${u.id}`)}>
                  <Badge user={u} size="sm" title="" />
                </button>
              ))}
          </div>
        </div>
        <p className="view-lede">Every change to every job, as it happened. History can't be edited or deleted.</p>
      </header>
      {groups.length === 0 && <p className="vsection-empty">No activity yet.</p>}
      {groups.map(([d, items]) => (
        <section key={d} className="vsection">
          <header className="vsection-head">
            <h2>{dayLabel(d)}</h2>
          </header>
          <ol className="feed">
            {items.map((a) => (
              <li key={a.id}>
                <button className="feed-item feed-wide" onClick={() => openJob(a.ticket_id)}>
                  <time className="muted">{clock(a.at)}</time>
                  <Badge user={user(a.user_id)} size="sm" />
                  <span className="feed-text">
                    <span className="jobno">{a.job_number}</span> {a.ticket_title}
                    <span className="feed-what">{activitySentence(a)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      ))}
      {!done && list.length >= PAGE && (
        <button className="btn load-more" onClick={() => void loadOlder()} disabled={loading}>
          {loading ? 'Loading…' : 'Show older activity'}
        </button>
      )}
    </div>
  );
}
