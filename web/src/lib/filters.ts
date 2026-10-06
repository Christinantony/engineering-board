// Board/search filters. Stored in the URL so a filtered view survives a
// refresh and can be shared ("Unassigned + High + CAD Modification").

import type { Priority, Status, Ticket } from '@board/shared';
import { localDate } from './format.ts';

export type DueFilter = '' | 'today' | 'week' | 'next7';
export type CreatedFilter = '' | 'today' | '7d' | '30d';

export interface Filters {
  assignee: (number | 'none')[];
  priority: Priority[];
  jobType: number[];
  /** Project ids, or "none" for jobs without a project. */
  project: (number | 'none')[];
  status: Status[];
  overdue: boolean;
  blocked: boolean;
  unassigned: boolean;
  due: DueFilter;
  created: CreatedFilter;
  tag: string;
}

export const EMPTY_FILTERS: Filters = {
  assignee: [],
  priority: [],
  jobType: [],
  project: [],
  status: [],
  overdue: false,
  blocked: false,
  unassigned: false,
  due: '',
  created: '',
  tag: '',
};

const list = (s: string | null) => (s ? s.split(',').filter(Boolean) : []);

export function readFilters(params: URLSearchParams): Filters {
  return {
    assignee: list(params.get('a')).map((x) => (x === 'none' ? 'none' : Number(x))).filter((x) => x === 'none' || Number.isInteger(x)),
    priority: list(params.get('p')) as Priority[],
    jobType: list(params.get('jt')).map(Number).filter(Number.isInteger),
    project: list(params.get('pr')).map((x) => (x === 'none' ? 'none' : Number(x))).filter((x) => x === 'none' || Number.isInteger(x)),
    status: list(params.get('st')) as Status[],
    overdue: params.get('o') === '1',
    blocked: params.get('b') === '1',
    unassigned: params.get('u') === '1',
    due: (params.get('due') ?? '') as DueFilter,
    created: (params.get('cr') ?? '') as CreatedFilter,
    tag: params.get('tag') ?? '',
  };
}

/** Write filters into a copy of `params` (other params such as q/job are kept). */
export function writeFilters(params: URLSearchParams, f: Filters): URLSearchParams {
  const p = new URLSearchParams(params);
  const set = (k: string, v: string) => (v ? p.set(k, v) : p.delete(k));
  set('a', f.assignee.join(','));
  set('p', f.priority.join(','));
  set('jt', f.jobType.join(','));
  set('pr', f.project.join(','));
  set('st', f.status.join(','));
  set('o', f.overdue ? '1' : '');
  set('b', f.blocked ? '1' : '');
  set('u', f.unassigned ? '1' : '');
  set('due', f.due);
  set('cr', f.created);
  set('tag', f.tag);
  return p;
}

export function activeCount(f: Filters): number {
  return (
    (f.assignee.length ? 1 : 0) +
    (f.priority.length ? 1 : 0) +
    (f.jobType.length ? 1 : 0) +
    (f.project.length ? 1 : 0) +
    (f.status.length ? 1 : 0) +
    Number(f.overdue) +
    Number(f.blocked) +
    Number(f.unassigned) +
    (f.due ? 1 : 0) +
    (f.created ? 1 : 0) +
    (f.tag ? 1 : 0)
  );
}

function addDays(date: string, n: number) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function endOfWeek(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(date, dow === 0 ? 0 : 7 - dow);
}

/** Inclusive local-date ranges for the due/created filters. */
export function dueRange(due: DueFilter, today = localDate()): [string | null, string] | null {
  if (due === 'today') return [null, today]; // due today or earlier (overdue included)
  if (due === 'week') return [null, endOfWeek(today)];
  if (due === 'next7') return [null, addDays(today, 6)];
  return null;
}
export function createdFrom(c: CreatedFilter, today = localDate()): string | null {
  if (c === 'today') return today;
  if (c === '7d') return addDays(today, -6);
  if (c === '30d') return addDays(today, -29);
  return null;
}

/** Client-side test, used on the board (all board jobs are already loaded). */
export function matches(t: Ticket, f: Filters, today = localDate()): boolean {
  if (f.assignee.length && !f.assignee.some((a) => (a === 'none' ? t.assigned_to == null : t.assigned_to === a))) return false;
  if (f.priority.length && !f.priority.includes(t.priority)) return false;
  if (f.jobType.length && (t.job_type_id == null || !f.jobType.includes(t.job_type_id))) return false;
  if (f.project.length && !f.project.some((p) => (p === 'none' ? t.project_id == null : t.project_id === p))) return false;
  if (f.status.length && !f.status.includes(t.status)) return false;
  if (f.overdue && !t.overdue) return false;
  if (f.blocked && t.status !== 'waiting' && t.status !== 'blocked') return false;
  if (f.unassigned && (t.assigned_to != null || t.status === 'done' || t.status === 'cancelled')) return false;
  if (f.tag && !t.tags.some((x) => x.toLowerCase() === f.tag.toLowerCase())) return false;
  const dr = dueRange(f.due, today);
  if (dr && (!t.due_date || t.due_date > dr[1] || (dr[0] && t.due_date < dr[0]))) return false;
  const cf = createdFrom(f.created, today);
  if (cf && localDate(new Date(t.created_at)) < cf) return false;
  return true;
}

/** Same filters as API query parameters (for server-side search). */
export function toQuery(f: Filters, today = localDate()): URLSearchParams {
  const q = new URLSearchParams();
  if (f.assignee.length) q.set('assignee', f.assignee.join(','));
  if (f.priority.length) q.set('priority', f.priority.join(','));
  if (f.jobType.length) q.set('job_type', f.jobType.join(','));
  if (f.project.length) q.set('project', f.project.join(','));
  if (f.status.length) q.set('status', f.status.join(','));
  if (f.overdue) q.set('overdue', '1');
  if (f.blocked) q.set('blocked', '1');
  if (f.unassigned) q.set('unassigned', '1');
  if (f.tag) q.set('tag', f.tag);
  const dr = dueRange(f.due, today);
  if (dr) {
    if (dr[0]) q.set('due_from', dr[0]);
    q.set('due_to', dr[1]);
  }
  const cf = createdFrom(f.created, today);
  if (cf) q.set('created_from', cf);
  return q;
}
