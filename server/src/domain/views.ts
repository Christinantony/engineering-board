// Read-only operational views: dashboard, Today, My Work, team workload.

import { PRIORITY_RANK, type Ticket, type WorkloadRow } from '@board/shared';
import { all, get } from '../db/connection.ts';
import { badRequest, nowIso, type Ctx } from '../lib/core.ts';
import { addDays, endOfWeek, localDate, startOfLocalDayIso } from '../lib/time.ts';
import { recentActivity, ticketsWhere } from './tickets.ts';

const OPEN = `t.archived = 0 AND t.status IN ('inbox','claimed','in_progress','waiting','blocked','review')`;
const ASSIGNED_OPEN = `t.archived = 0 AND t.status IN ('claimed','in_progress','waiting','blocked','review')`;
const PRIORITY_ORDER = `CASE t.priority ${Object.entries(PRIORITY_RANK).map(([p, r]) => `WHEN '${p}' THEN ${r}`).join(' ')} END`;
const URGENCY_ORDER = `${PRIORITY_ORDER}, t.due_at IS NULL, t.due_at, t.created_at`;

export type Horizon = 'today' | '3days' | 'week';

function today(ctx: Ctx) {
  return localDate(ctx.now().getTime(), ctx.tz);
}

export function horizonEnd(ctx: Ctx, h: Horizon): string {
  const d = today(ctx);
  if (h === 'today') return d;
  if (h === '3days') return addDays(d, 2);
  if (h === 'week') return endOfWeek(d);
  throw badRequest('horizon must be today, 3days or week');
}

/**
 * Team workload. A job counts toward a horizon when it is due on or before the
 * horizon's last day (overdue work included), or when it is in progress with
 * no due date. Hours exclude waiting/blocked work (it can't be worked on) and
 * unestimated jobs are counted, never guessed.
 */
export function workload(ctx: Ctx, h: Horizon = 'today') {
  const end = horizonEnd(ctx, h);
  const now = nowIso(ctx);
  const rows = all<WorkloadRow>(
    ctx.db,
    `SELECT u.id AS user_id, u.name, u.initials, u.color,
       COALESCE(SUM(CASE WHEN inh = 1 AND workable = 1 THEN t.estimate_minutes END), 0) AS load_minutes,
       COALESCE(SUM(CASE WHEN inh = 1 AND workable = 1 AND t.estimate_minutes IS NULL THEN 1 END), 0) AS unestimated,
       COALESCE(SUM(CASE WHEN workable = 1 THEN t.estimate_minutes END), 0) AS backlog_minutes,
       COALESCE(SUM(CASE WHEN workable = 1 AND t.estimate_minutes IS NULL THEN 1 END), 0) AS backlog_unestimated,
       COALESCE(SUM(t.status = 'in_progress'), 0) AS in_progress,
       COUNT(t.id) AS assigned_open,
       COALESCE(SUM(t.due_at IS NOT NULL AND t.due_at < ?), 0) AS overdue,
       COALESCE(SUM(t.status IN ('waiting','blocked')), 0) AS blocked
     FROM users u
     LEFT JOIN (
       SELECT t.*,
         ((t.due_date IS NOT NULL AND t.due_date <= ?) OR (t.due_date IS NULL AND t.status = 'in_progress')) AS inh,
         (t.status NOT IN ('waiting','blocked')) AS workable
       FROM tickets t WHERE ${ASSIGNED_OPEN}
     ) t ON t.assigned_to = u.id
     WHERE u.role = 'engineer' AND (u.active = 1 OR t.id IS NOT NULL)
     GROUP BY u.id
     ORDER BY u.active DESC, u.name`,
    now,
    end,
  );
  const unclaimed = get<{ n: number; minutes: number; unestimated: number }>(
    ctx.db,
    `SELECT COUNT(*) n, COALESCE(SUM(estimate_minutes), 0) minutes, COALESCE(SUM(estimate_minutes IS NULL), 0) unestimated
     FROM tickets t WHERE ${OPEN} AND t.assigned_to IS NULL`,
  )!;
  return { horizon: h, through: end, engineers: rows, unclaimed };
}

export function dashboard(ctx: Ctx) {
  const now = nowIso(ctx);
  const d = today(ctx);
  const c = get<Record<string, number>>(
    ctx.db,
    `SELECT
       COALESCE(SUM(${OPEN} AND t.assigned_to IS NULL), 0) AS unclaimed,
       COALESCE(SUM(t.archived = 0 AND t.status = 'in_progress'), 0) AS in_progress,
       COALESCE(SUM(t.archived = 0 AND t.status IN ('waiting','blocked')), 0) AS blocked,
       COALESCE(SUM(t.archived = 0 AND t.status = 'review'), 0) AS review,
       COALESCE(SUM(${OPEN} AND t.due_date = ?), 0) AS due_today,
       COALESCE(SUM(${OPEN} AND t.due_at < ?), 0) AS overdue,
       COALESCE(SUM(t.status = 'done' AND t.completed_at >= ?), 0) AS done_today,
       COALESCE(SUM(${OPEN} AND t.priority = 'urgent'), 0) AS urgent
     FROM tickets t`,
    d,
    now,
    startOfLocalDayIso(d, ctx.tz),
  )!;
  return {
    counts: c,
    workload: workload(ctx, 'today'),
    recent_activity: recentActivity(ctx, 20),
    attention: ticketsWhere(ctx, `${OPEN} AND (t.assigned_to IS NULL OR t.priority = 'urgent')`, `${URGENCY_ORDER} LIMIT 30`),
  };
}

export function todayView(ctx: Ctx) {
  const now = nowIso(ctx);
  const d = today(ctx);
  const sinceYesterday = startOfLocalDayIso(addDays(d, -1), ctx.tz);
  return {
    date: d,
    urgent: ticketsWhere(ctx, `${OPEN} AND t.priority = 'urgent'`, URGENCY_ORDER),
    overdue: ticketsWhere(ctx, `${OPEN} AND t.due_at < ?`, 't.due_at', now),
    due_today: ticketsWhere(ctx, `${OPEN} AND t.due_date = ? AND t.due_at >= ?`, `t.due_at, ${PRIORITY_ORDER}`, d, now),
    active: ticketsWhere(ctx, `t.archived = 0 AND t.status = 'in_progress'`, 't.assigned_to, t.my_rank'),
    blocked: ticketsWhere(ctx, `t.archived = 0 AND t.status IN ('waiting','blocked')`, 't.updated_at'),
    review: ticketsWhere(ctx, `t.archived = 0 AND t.status = 'review'`, 't.updated_at'),
    unclaimed: ticketsWhere(ctx, `${OPEN} AND t.assigned_to IS NULL`, URGENCY_ORDER),
    recently_completed: ticketsWhere(ctx, `t.status = 'done' AND t.completed_at >= ?`, 't.completed_at DESC LIMIT 50', sinceYesterday),
  };
}

export function myWork(ctx: Ctx, userId: number) {
  const mine = ticketsWhere(ctx, `${ASSIGNED_OPEN} AND t.assigned_to = ?`, 't.my_rank, t.id', userId);
  const pick = (...st: string[]) => mine.filter((t: Ticket) => st.includes(t.status));
  const minutes = (list: Ticket[]) => list.reduce((s, t) => s + (t.estimate_minutes ?? 0), 0);
  const inProgress = pick('in_progress');
  const upNext = pick('claimed');
  return {
    in_progress: inProgress,
    waiting: pick('waiting', 'blocked'),
    review: pick('review'),
    up_next: upNext,
    summary: {
      open: mine.length,
      estimated_minutes: minutes([...inProgress, ...upNext, ...pick('review')]),
      unestimated: [...inProgress, ...upNext].filter((t) => t.estimate_minutes == null).length,
      overdue: mine.filter((t) => t.overdue).length,
    },
  };
}
