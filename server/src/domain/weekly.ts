// The weekly summary (decision #37): one printable page for the manager's
// review meeting. What was finished in a week (by project and by person), and
// as of now what is overdue, what is waiting and on what, what is due next
// week, and where drawing review stands.
//
// A week runs Monday to Sunday in the board's time zone. Finished and new
// jobs belong to the chosen week; overdue, waiting and open are always "now",
// because that is what the meeting acts on.

import { STATUS_LABEL, type Status } from '@board/shared';
import { all, get } from '../db/connection.ts';
import { badRequest, type Ctx } from '../lib/core.ts';
import { addDays, dayOfWeek, localDate, startOfLocalDayIso } from '../lib/time.ts';
import { claimingRoles } from './permissions.ts';

export interface SummaryJob {
  id: number;
  job_number: string;
  title: string;
  status: Status;
  status_label: string;
  owner: string | null;
  owner_id: number | null;
  project: string | null;
  job_type: string | null;
  priority: string;
  due_date: string | null;
  completed_at: string | null;
}

interface Row {
  id: number;
  job_number: string;
  title: string;
  status: Status;
  assigned_to: number | null;
  owner: string | null;
  project: string | null;
  job_type: string | null;
  priority: string;
  due_date: string | null;
  due_at: string | null;
  completed_at: string | null;
  created_at: string;
  waiting_for: string;
  estimate_minutes: number | null;
}

const SELECT = `SELECT t.id, t.job_number, t.title, t.status, t.assigned_to, u.name AS owner, p.name AS project, jt.name AS job_type,
  t.priority, t.due_date, t.due_at, t.completed_at, t.created_at, t.waiting_for, t.estimate_minutes
  FROM tickets t
  LEFT JOIN users u ON u.id = t.assigned_to
  LEFT JOIN ticket_projects tp ON tp.ticket_id = t.id
  LEFT JOIN projects p ON p.id = tp.project_id
  LEFT JOIN job_types jt ON jt.id = t.job_type_id`;

const job = (r: Row): SummaryJob => ({
  id: r.id,
  job_number: r.job_number,
  title: r.title,
  status: r.status,
  status_label: STATUS_LABEL[r.status],
  owner: r.owner,
  owner_id: r.assigned_to,
  project: r.project,
  job_type: r.job_type,
  priority: r.priority,
  due_date: r.due_date,
  completed_at: r.completed_at,
});

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const OPEN = `t.archived = 0 AND t.status NOT IN ('done','cancelled')`;

/** The Monday of the week holding `date` (YYYY-MM-DD). */
export function mondayOf(date: string): string {
  const dow = dayOfWeek(date); // 0 = Sunday
  return addDays(date, dow === 0 ? -6 : 1 - dow);
}

/** Whole calendar days from a local date to another (yesterday → 1), never negative. */
const calendarDays = (from: string, to: string) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000));

export function weeklySummary(ctx: Ctx, weekOf?: string) {
  const nowMs = ctx.now().getTime();
  const today = localDate(nowMs, ctx.tz);
  if (weekOf != null && !/^\d{4}-\d{2}-\d{2}$/.test(weekOf)) throw badRequest('week must be a date (YYYY-MM-DD)');
  const from = mondayOf(weekOf ?? today);
  const to = addDays(from, 6);
  const start = startOfLocalDayIso(from, ctx.tz);
  const end = startOfLocalDayIso(addDays(from, 7), ctx.tz);
  const nowIso = new Date(nowMs).toISOString();

  // ---- the chosen week ----
  const finished = all<Row>(ctx.db, `${SELECT} WHERE t.status = 'done' AND t.completed_at >= ? AND t.completed_at < ? ORDER BY t.completed_at`, start, end);
  const created = get<{ n: number }>(ctx.db, 'SELECT COUNT(*) n FROM tickets WHERE created_at >= ? AND created_at < ?', start, end)!.n;
  const byProject = new Map<string, SummaryJob[]>();
  for (const r of finished) {
    const k = r.project ?? '';
    if (!byProject.has(k)) byProject.set(k, []);
    byProject.get(k)!.push(job(r));
  }
  const finishedByProject = [...byProject.entries()]
    .map(([project, jobs]) => ({ project: project || null, jobs }))
    .sort((a, b) => b.jobs.length - a.jobs.length || (a.project ?? '￿').localeCompare(b.project ?? '￿'));

  // ---- now ----
  const overdue = all<Row>(ctx.db, `${SELECT} WHERE ${OPEN} AND t.due_at IS NOT NULL AND t.due_at < ? ORDER BY t.due_at`, nowIso).map((r) => ({
    ...job(r),
    // calendar days late: due yesterday is 1 day over, due earlier today is 0 ("today")
    days_overdue: calendarDays(r.due_date ?? localDate(Date.parse(r.due_at!), ctx.tz), today),
  }));
  const waitingRows = all<Row & { since: string | null }>(
    ctx.db,
    `${SELECT.replace('t.estimate_minutes', `t.estimate_minutes,
       (SELECT MAX(a.at) FROM activity a WHERE a.ticket_id = t.id AND a.kind = 'status' AND a.to_value IN ('waiting','blocked')) AS since`)}
     WHERE t.archived = 0 AND t.status IN ('waiting','blocked')`,
  );
  const waiting = waitingRows
    .map((r) => ({ ...job(r), waiting_for: r.waiting_for, since: r.since, days: r.since ? calendarDays(localDate(Date.parse(r.since), ctx.tz), today) : null }))
    .sort((a, b) => (b.days ?? 0) - (a.days ?? 0) || a.job_number.localeCompare(b.job_number));
  const nextFrom = mondayOf(addDays(today, 7));
  const nextTo = addDays(nextFrom, 6);
  const dueNext = all<Row>(ctx.db, `${SELECT} WHERE ${OPEN} AND t.due_date >= ? AND t.due_date <= ? ORDER BY t.due_date, t.due_time`, nextFrom, nextTo).map(job);
  const unclaimedUrgent = all<Row>(ctx.db, `${SELECT} WHERE ${OPEN} AND t.assigned_to IS NULL AND t.priority IN ('urgent','high')`)
    .map(job)
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.job_number.localeCompare(b.job_number));
  const counts = get<{ open: number; unassigned: number }>(
    ctx.db,
    `SELECT COALESCE(SUM(1), 0) open, COALESCE(SUM(t.assigned_to IS NULL), 0) unassigned FROM tickets t WHERE ${OPEN}`,
  )!;

  // ---- people: who holds jobs ----
  const holders = claimingRoles(ctx);
  const users = all<{ id: number; name: string; role: string; active: number }>(ctx.db, 'SELECT id, name, role, active FROM users ORDER BY name');
  const openByUser = all<{ assigned_to: number; open: number; in_progress: number; waiting: number; overdue: number }>(
    ctx.db,
    `SELECT t.assigned_to, COUNT(*) open, SUM(t.status = 'in_progress') in_progress, SUM(t.status IN ('waiting','blocked')) waiting,
            SUM(t.due_at IS NOT NULL AND t.due_at < ?) overdue
     FROM tickets t WHERE ${OPEN} AND t.assigned_to IS NOT NULL GROUP BY t.assigned_to`,
    nowIso,
  );
  const people = users
    .map((u) => {
      const o = openByUser.find((x) => x.assigned_to === u.id);
      return {
        user_id: u.id,
        name: u.name,
        finished: finished.filter((r) => r.assigned_to === u.id).length,
        open: o?.open ?? 0,
        in_progress: o?.in_progress ?? 0,
        waiting: o?.waiting ?? 0,
        overdue: o?.overdue ?? 0,
        due_next_week: dueNext.filter((j) => j.owner_id === u.id).length,
        holds_jobs: (holders.includes(u.role) && u.active === 1),
      };
    })
    .filter((p) => p.holds_jobs || p.finished || p.open)
    .map(({ holds_jobs: _h, ...p }) => p);

  // ---- drawing review ----
  const signed = all<{ identifier: string; revision: string | null; job_number: string; ticket_id: number }>(
    ctx.db,
    `SELECT d.identifier, d.revision, t.job_number, t.id AS ticket_id FROM review_drawings d JOIN tickets t ON t.id = d.ticket_id
     WHERE d.state = 'signed' AND d.signed_at >= ? AND d.signed_at < ? ORDER BY d.signed_at`,
    start,
    end,
  );
  const reviewNow = get<{ awaiting: number; returned: number; signature: number }>(
    ctx.db,
    `SELECT COALESCE(SUM(d.state = 'awaiting'), 0) awaiting, COALESCE(SUM(d.state = 'returned'), 0) returned,
            COALESCE(SUM(d.state IN ('passed','handed_over')), 0) signature
     FROM review_drawings d JOIN tickets t ON t.id = d.ticket_id WHERE t.archived = 0`,
  )!;

  return {
    week: { from, to, is_current: from === mondayOf(today) },
    today,
    generated_at: nowIso,
    numbers: {
      finished: finished.length,
      created,
      open_now: counts.open,
      unassigned_now: counts.unassigned,
      overdue_now: overdue.length,
      waiting_now: waiting.length,
      drawings_signed: signed.length,
    },
    finished_by_project: finishedByProject,
    people,
    overdue,
    waiting,
    due_next_week: { from: nextFrom, to: nextTo, jobs: dueNext },
    unclaimed_urgent: unclaimedUrgent,
    review: { signed, awaiting_now: reviewNow.awaiting, returned_now: reviewNow.returned, signature_pending_now: reviewNow.signature },
  };
}
