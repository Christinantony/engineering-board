// In-app notifications, derived from the activity log (no separate inbox to
// keep in sync). Each person sees what matters to them, done by someone else:
//   * new urgent jobs, and jobs raised to urgent        (everyone)
//   * a job assigned to you                              (you)
//   * a job ready for review                             (engineers)
//   * a job you own or created moved to waiting/blocked  (owner, creator)
//   * a note added to a job you own or created           (owner, creator)
//   * a job you created marked done                      (creator)
//   * a job taken off you                                (you)
// plus two standing reminders: your overdue jobs and your jobs due today.

import type { Activity, User } from '@board/shared';
import { all, get, run } from '../db/connection.ts';
import { nowIso, type Ctx } from '../lib/core.ts';
import { localDate } from '../lib/time.ts';

export type NoticeKind = 'urgent' | 'assigned' | 'review' | 'waiting' | 'comment' | 'done' | 'unassigned';

export interface Notice {
  id: number; // activity id
  kind: NoticeKind;
  ticket_id: number;
  job_number: string;
  title: string;
  by: string | null;
  at: string;
  detail: string | null;
  unread: boolean;
}

interface Row extends Activity {
  t_assigned_to: number | null;
  t_created_by: number | null;
  t_priority: string;
}

const WINDOW_DAYS = 14;

function classify(a: Row, me: User): { kind: NoticeKind; detail: string | null } | null {
  if (a.user_id === me.id) return null; // never notify people about their own actions
  const mine = a.t_assigned_to === me.id;
  const created = a.t_created_by === me.id;
  switch (a.kind) {
    case 'created':
      // to_value holds the priority at creation (older rows: fall back to the current priority)
      return (a.to_value ?? a.t_priority) === 'urgent' ? { kind: 'urgent', detail: null } : null;
    case 'priority':
      return a.to_value === 'urgent' ? { kind: 'urgent', detail: null } : null;
    case 'assigned':
      return a.to_value === me.name && mine ? { kind: 'assigned', detail: null } : null;
    case 'released':
      return a.from_value === me.name ? { kind: 'unassigned', detail: null } : null;
    case 'status':
      if (a.to_value === 'review' && me.role === 'engineer') return { kind: 'review', detail: null };
      if ((a.to_value === 'waiting' || a.to_value === 'blocked') && (mine || created || me.role === 'manager'))
        return { kind: 'waiting', detail: a.body };
      if (a.to_value === 'done' && created) return { kind: 'done', detail: null };
      return null;
    case 'comment':
      return mine || created ? { kind: 'comment', detail: a.body } : null;
    default:
      return null;
  }
}

export function seenUpTo(ctx: Ctx, userId: number): number {
  return get<{ seen_activity_id: number }>(ctx.db, 'SELECT seen_activity_id FROM user_state WHERE user_id = ?', userId)?.seen_activity_id ?? 0;
}

export function markSeen(ctx: Ctx, userId: number, upTo: number) {
  const max = get<{ m: number | null }>(ctx.db, 'SELECT MAX(id) m FROM activity')!.m ?? 0;
  const value = Math.min(Math.max(upTo, 0), max);
  run(
    ctx.db,
    `INSERT INTO user_state (user_id, seen_activity_id, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET seen_activity_id = MAX(seen_activity_id, excluded.seen_activity_id), updated_at = excluded.updated_at`,
    userId,
    value,
    nowIso(ctx),
  );
}

export function notifications(ctx: Ctx, me: User, limit = 40) {
  const since = new Date(ctx.now().getTime() - WINDOW_DAYS * 86_400_000).toISOString();
  const seen = seenUpTo(ctx, me.id);
  const rows = all<Row>(
    ctx.db,
    `SELECT a.*, u.name AS user_name, t.job_number, t.title AS ticket_title,
            t.assigned_to AS t_assigned_to, t.created_by AS t_created_by, t.priority AS t_priority
     FROM activity a
     JOIN tickets t ON t.id = a.ticket_id
     LEFT JOIN users u ON u.id = a.user_id
     WHERE a.at >= ? AND (a.user_id IS NULL OR a.user_id <> ?)
       AND a.kind IN ('created','priority','assigned','released','status','comment')
       AND t.archived = 0
     ORDER BY a.id DESC
     LIMIT 1000`,
    since,
    me.id,
  );
  const items: Notice[] = [];
  for (const r of rows) {
    const c = classify(r, me);
    if (!c) continue;
    items.push({
      id: r.id,
      kind: c.kind,
      ticket_id: r.ticket_id,
      job_number: r.job_number!,
      title: r.ticket_title!,
      by: r.user_name ?? null,
      at: r.at,
      detail: c.detail ? (c.detail.length > 160 ? c.detail.slice(0, 157) + '…' : c.detail) : null,
      unread: r.id > seen,
    });
    if (items.length >= limit) break;
  }
  const today = localDate(ctx.now().getTime(), ctx.tz);
  const reminders = get<{ overdue: number; due_today: number }>(
    ctx.db,
    `SELECT COALESCE(SUM(due_at < ?), 0) overdue, COALESCE(SUM(due_date = ? AND due_at >= ?), 0) due_today
     FROM tickets WHERE assigned_to = ? AND archived = 0 AND status NOT IN ('done','cancelled')`,
    nowIso(ctx),
    today,
    nowIso(ctx),
    me.id,
  )!;
  const latest = get<{ m: number | null }>(ctx.db, 'SELECT MAX(id) m FROM activity')!.m ?? 0;
  return {
    items,
    unread: items.filter((i) => i.unread).length,
    latest_activity_id: latest,
    overdue_mine: reminders.overdue,
    due_today_mine: reminders.due_today,
  };
}
