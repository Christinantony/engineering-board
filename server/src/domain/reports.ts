// Lightweight reporting: what the team finished, by whom and what kind, and
// how long jobs take. Operational visibility only, not a KPI tracker.

import { all, get } from '../db/connection.ts';
import { badRequest, nowIso, type Ctx } from '../lib/core.ts';
import { addDays, startOfLocalDayIso } from '../lib/time.ts';

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);

export function report(ctx: Ctx, from: string, to: string) {
  if (!isDate(from) || !isDate(to)) throw badRequest('from and to must be dates (YYYY-MM-DD)');
  if (from > to) throw badRequest('from must be on or before to');
  const start = startOfLocalDayIso(from, ctx.tz);
  const end = startOfLocalDayIso(addDays(to, 1), ctx.tz);
  const now = nowIso(ctx);

  const done = all<{
    id: number;
    assigned_to: number | null;
    job_type_id: number | null;
    created_at: string;
    started_at: string | null;
    completed_at: string;
    estimate_minutes: number | null;
    actual_minutes: number | null;
  }>(
    ctx.db,
    `SELECT id, assigned_to, job_type_id, created_at, started_at, completed_at, estimate_minutes, actual_minutes
     FROM tickets WHERE status = 'done' AND completed_at >= ? AND completed_at < ?`,
    start,
    end,
  );

  const hoursBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 3_600_000;
  const leadTimes = done.map((t) => hoursBetween(t.created_at, t.completed_at));
  const workTimes = done.filter((t) => t.started_at).map((t) => hoursBetween(t.started_at!, t.completed_at));
  const both = done.filter((t) => t.estimate_minutes != null && t.actual_minutes != null);

  const users = all<{ id: number; name: string; initials: string; color: string; role: string; active: number }>(
    ctx.db,
    'SELECT id, name, initials, color, role, active FROM users',
  );
  const byEngineer = users
    .map((u) => {
      const mine = done.filter((t) => t.assigned_to === u.id);
      const est = mine.filter((t) => t.estimate_minutes != null);
      return {
        user_id: u.id,
        name: u.name,
        initials: u.initials,
        color: u.color,
        completed: mine.length,
        estimated_minutes: est.reduce((s, t) => s + t.estimate_minutes!, 0),
        open_now: get<{ n: number }>(
          ctx.db,
          `SELECT COUNT(*) n FROM tickets WHERE assigned_to = ? AND archived = 0 AND status NOT IN ('done','cancelled')`,
          u.id,
        )!.n,
        role: u.role,
        active: u.active === 1,
      };
    })
    .filter((r) => r.role === 'engineer' && (r.active || r.completed > 0))
    .sort((a, b) => b.completed - a.completed || a.name.localeCompare(b.name));

  const types = all<{ id: number; name: string }>(ctx.db, 'SELECT id, name FROM job_types');
  const created = all<{ job_type_id: number | null }>(ctx.db, 'SELECT job_type_id FROM tickets WHERE created_at >= ? AND created_at < ?', start, end);
  const typeName = (id: number | null) => (id == null ? 'No job type' : types.find((t) => t.id === id)?.name ?? 'Unknown');
  const typeIds = [...new Set([...done.map((t) => t.job_type_id), ...created.map((t) => t.job_type_id)])];
  const byType = typeIds
    .map((id) => ({
      job_type: typeName(id),
      completed: done.filter((t) => t.job_type_id === id).length,
      created: created.filter((t) => t.job_type_id === id).length,
    }))
    .sort((a, b) => b.completed - a.completed || b.created - a.created || a.job_type.localeCompare(b.job_type));

  // completed per local day, for a small trend line
  const perDay: { date: string; completed: number }[] = [];
  for (let d = from, i = 0; d <= to && i < 400; d = addDays(d, 1), i++) {
    const s = startOfLocalDayIso(d, ctx.tz);
    const e = startOfLocalDayIso(addDays(d, 1), ctx.tz);
    perDay.push({ date: d, completed: done.filter((t) => t.completed_at >= s && t.completed_at < e).length });
  }

  const counts = get<{ open: number; overdue: number }>(
    ctx.db,
    `SELECT COALESCE(SUM(status NOT IN ('done','cancelled')), 0) open,
            COALESCE(SUM(status NOT IN ('done','cancelled') AND due_at < ?), 0) overdue
     FROM tickets WHERE archived = 0`,
    now,
  )!;

  return {
    from,
    to,
    completed: done.length,
    created: created.length,
    open_now: counts.open,
    overdue_now: counts.overdue,
    lead_time_hours: { average: round1(avg(leadTimes)), median: round1(median(leadTimes)) },
    work_time_hours: { average: round1(avg(workTimes)), median: round1(median(workTimes)), jobs: workTimes.length },
    estimate_vs_actual: {
      jobs: both.length,
      estimated_minutes: both.reduce((s, t) => s + t.estimate_minutes!, 0),
      actual_minutes: both.reduce((s, t) => s + t.actual_minutes!, 0),
    },
    by_engineer: byEngineer.map(({ role: _r, ...rest }) => rest),
    by_type: byType,
    per_day: perDay,
  };
}
