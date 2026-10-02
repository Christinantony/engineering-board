// Collaboration UI: the notification bell, who's online, who else has a job
// open, and the "server unreachable" / "new version" banners.

import { useEffect, useRef, useState } from 'react';
import { useApp } from '../context.ts';
import { post } from '../lib/api.ts';
import { when } from '../lib/format.ts';
import { navigate } from '../lib/router.ts';
import { invalidate, useLiveState, useNewVersionAvailable, useQuery } from '../lib/store.ts';
import { toast } from '../lib/toasts.ts';
import { setUnreadCount } from '../lib/title.ts';
import { Badge } from './bits.tsx';


interface Notice {
  id: number;
  kind: 'urgent' | 'assigned' | 'review' | 'waiting' | 'comment' | 'done' | 'unassigned' | 'review_submitted' | 'review_passed' | 'review_returned' | 'review_comment' | 'signature';
  ticket_id: number;
  job_number: string;
  title: string;
  by: string | null;
  at: string;
  detail: string | null;
  unread: boolean;
}
interface NoticeData {
  items: Notice[];
  unread: number;
  latest_activity_id: number;
  overdue_mine: number;
  due_today_mine: number;
}

function noticeText(n: Notice): string {
  const who = n.by ?? 'Someone';
  switch (n.kind) {
    case 'urgent':
      return `${who} raised an urgent job`;
    case 'assigned':
      return `${who} assigned this to you`;
    case 'review':
      return `${who} sent this for review`;
    case 'waiting':
      return `${who} marked this as waiting`;
    case 'comment':
      return `${who} added a note`;
    case 'done':
      return `${who} finished a job you raised`;
    case 'unassigned':
      return `${who} took this off you`;
    case 'review_submitted':
      return `${who} submitted drawings for board review`;
    case 'review_passed':
      return `${who} passed ${n.detail ?? 'a drawing'} in board review`;
    case 'review_returned':
      return `${who} returned a drawing for correction`;
    case 'review_comment':
      return `${who} commented on a drawing`;
    case 'signature':
      return `${who} handed you a print to sign`;
  }
}

/** Kinds worth a pop-up toast the moment they arrive. */
const LOUD = new Set(['urgent', 'assigned', 'unassigned', 'signature', 'review_returned']);

export function Bell() {
  const { openJob } = useApp();
  const q = useQuery<NoticeData>('/api/notifications');
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const lastSeenTop = useRef<number | null>(null);

  // pop a toast for important notices that arrive while the page is open
  useEffect(() => {
    if (!q.data) return;
    const top = q.data.items[0]?.id ?? 0;
    if (lastSeenTop.current != null) {
      const fresh = q.data.items.filter((n) => n.id > lastSeenTop.current! && n.unread && LOUD.has(n.kind));
      for (const n of fresh.slice(0, 2).reverse())
        toast(`${noticeText(n)}: ${n.job_number} ${n.title}`, {
          kind: n.kind === 'urgent' ? 'error' : 'info',
          timeout: 12_000,
          action: { label: 'Open', run: () => (n.kind.startsWith('review') || n.kind === 'signature' ? navigate(`/review/${n.ticket_id}`) : openJob(n.ticket_id)) },
        });
    }
    lastSeenTop.current = Math.max(lastSeenTop.current ?? 0, top);
  }, [q.data]);

  // unread count in the browser tab title, so it shows when the board is in the background
  useEffect(() => {
    const n = q.data?.unread ?? 0;
    setUnreadCount(n);
  }, [q.data?.unread]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);

  const markAll = async () => {
    if (!q.data) return;
    try {
      await post('/api/notifications/seen', { up_to: q.data.latest_activity_id });
      invalidate('/api/notifications');
    } catch {
      /* not important enough to interrupt anyone */
    }
  };

  const d = q.data;
  const unread = d?.unread ?? 0;
  const reminders = (d?.overdue_mine ?? 0) + (d?.due_today_mine ?? 0);

  return (
    <div className="bell" ref={box}>
      <button
        className={`bell-btn${unread ? ' has-unread' : ''}`}
        aria-label={unread ? `${unread} new notifications` : 'Notifications'}
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open && unread) void markAll();
        }}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 22a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22Zm7-6V11a7 7 0 0 0-5.5-6.84V3.5a1.5 1.5 0 0 0-3 0v.66A7 7 0 0 0 5 11v5l-1.7 1.7A1 1 0 0 0 4 19.4h16a1 1 0 0 0 .7-1.7Z"
          />
        </svg>
        {unread > 0 && <span className="bell-count">{unread > 9 ? '9+' : unread}</span>}
        {unread === 0 && reminders > 0 && <span className="bell-dot" aria-hidden="true" />}
      </button>
      {open && d && (
        <div className="bell-pop" role="dialog" aria-label="Notifications">
          {(d.overdue_mine > 0 || d.due_today_mine > 0) && (
            <button
              className="bell-reminder"
              onClick={() => {
                setOpen(false);
                navigate('/my-work');
              }}
            >
              {d.overdue_mine > 0 && <strong className="bad">{d.overdue_mine} of your jobs overdue. </strong>}
              {d.due_today_mine > 0 && <span>{d.due_today_mine} due today.</span>} Open My work.
            </button>
          )}
          {d.items.length === 0 ? (
            <p className="bell-empty">Nothing new for you in the last two weeks.</p>
          ) : (
            <ol className="bell-list">
              {d.items.map((n) => (
                <li key={n.id}>
                  <button
                    className={`bell-item k-${n.kind}${n.unread ? ' unread' : ''}`}
                    onClick={() => {
                      setOpen(false);
                      if (n.kind.startsWith('review') || n.kind === 'signature') navigate(`/review/${n.ticket_id}`);
                      else openJob(n.ticket_id);
                    }}
                  >
                    <span className="bell-what">{noticeText(n)}</span>
                    <span className="bell-job">
                      <span className="jobno">{n.job_number}</span> {n.title}
                    </span>
                    {n.detail && <span className="bell-detail">{n.detail}</span>}
                    <time className="muted">{when(n.at)}</time>
                  </button>
                </li>
              ))}
            </ol>
          )}
          <button
            className="bell-all"
            onClick={() => {
              setOpen(false);
              navigate('/activity');
            }}
          >
            See all team activity
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

interface PresenceData {
  online: { user_id: number; viewing: number[] }[];
}

export function usePresence() {
  return useQuery<PresenceData>('/api/presence').data?.online ?? [];
}

/** Small stack of badges for the people who have the board open right now. */
export function OnlineNow() {
  const { me, user } = useApp();
  const online = usePresence().filter((o) => o.user_id !== me.id);
  if (!online.length) return null;
  const names = online.map((o) => user(o.user_id)?.name).filter(Boolean);
  return (
    <span className="online" title={`Also on the board now: ${names.join(', ')}`} aria-label={`Also online: ${names.join(', ')}`}>
      {online.slice(0, 5).map((o) => (
        <Badge key={o.user_id} user={user(o.user_id)} size="sm" title="" />
      ))}
    </span>
  );
}

// one id per browser tab, so two tabs of the same person count separately
const TAB_ID = Math.random().toString(36).slice(2, 10);

/** Tell the server which job this tab has open (refreshed every 30 s). */
export function useAnnounceViewing(jobId: number | null) {
  useEffect(() => {
    const send = (id: number | null) => post('/api/presence', { job_id: id, tab: TAB_ID }).catch(() => {});
    void send(jobId);
    if (jobId == null) return;
    const t = setInterval(() => void send(jobId), 30_000);
    return () => {
      clearInterval(t);
      void send(null);
    };
  }, [jobId]);
}

/** "Paul also has this job open" — shown at the top of the panel. */
export function AlsoViewing({ jobId }: { jobId: number }) {
  const { me, user } = useApp();
  const others = usePresence()
    .filter((o) => o.user_id !== me.id && o.viewing.includes(jobId))
    .map((o) => user(o.user_id))
    .filter(Boolean);
  if (!others.length) return null;
  const names = others.map((u) => u!.name);
  const text = names.length === 1 ? `${names[0]} also has this job open` : `${names.slice(0, -1).join(', ')} and ${names.at(-1)} also have this job open`;
  return (
    <div className="also-viewing" role="status">
      {others.map((u) => (
        <Badge key={u!.id} user={u} size="sm" title="" />
      ))}
      <span>{text}. Your edits are checked against theirs, so nothing gets overwritten.</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connection and version banners
// ---------------------------------------------------------------------------

export function ConnectionBanner() {
  const live = useLiveState();
  const newVersion = useNewVersionAvailable();
  const [lostFor, setLostFor] = useState(0);
  useEffect(() => {
    if (live === 'live') {
      setLostFor(0);
      return;
    }
    const started = Date.now();
    const t = setInterval(() => setLostFor(Date.now() - started), 1000);
    return () => clearInterval(t);
  }, [live]);

  if (newVersion)
    return (
      <div className="banner banner-info" role="status">
        The board has been updated on the server.{' '}
        <button className="link-btn" onClick={() => location.reload()}>
          Reload to get the new version
        </button>
      </div>
    );
  if (live !== 'live' && lostFor > 6000)
    return (
      <div className="banner banner-bad" role="alert">
        Can't reach the board server. Changes you make now won't be saved. Check that the host PC is on; the board will reconnect by itself.
      </div>
    );
  return null;
}
