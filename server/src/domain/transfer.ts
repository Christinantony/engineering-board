// Getting data in and out: CSV/JSON export, CSV import (with a preview
// step), bulk archiving, and tag housekeeping.

import { createHash } from 'node:crypto';
import { ESTIMATE_BUCKETS, PRIORITIES, STATUSES, type Priority, type Status, type Ticket, type User } from '@board/shared';
import { all, get, run, tx } from '../db/connection.ts';
import { badRequest, conflict, nowIso, type Ctx } from '../lib/core.ts';
import { parseCsv, toCsv, unguard } from '../lib/csv.ts';
import { localDate } from '../lib/time.ts';
import { createJobType, listJobTypes } from './jobTypes.ts';
import { reindexTicket } from './search.ts';
import { createTicket, getTicket, listTickets, moveTicket, type TicketFilters } from './tickets.ts';
import { cleanProjectName, createProject, listProjects } from './projects.ts';
import { listUsers } from './users.ts';

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function localDateTime(ctx: Ctx, iso: string | null): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: ctx.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
  return `${localDate(ms, ctx.tz)} ${t}`;
}

function allTickets(ctx: Ctx, f: TicketFilters): Ticket[] {
  const out: Ticket[] = [];
  for (let offset = 0; ; offset += 2000) {
    const page = listTickets(ctx, { archived: 'include', ...f, limit: 2000, offset }).tickets;
    out.push(...page);
    if (page.length < 2000) break;
  }
  return out.sort((a, b) => a.id - b.id);
}

export const CSV_COLUMNS = [
  'job_number',
  'title',
  'description',
  'status',
  'priority',
  'assignee',
  'requester',
  'job_type',
  'project',
  'estimate_minutes',
  'actual_minutes',
  'due_date',
  'due_time',
  'tags',
  'reference',
  'file_location',
  'notes',
  'waiting_for',
  'parent_job',
  'created_at',
  'created_by',
  'claimed_at',
  'started_at',
  'completed_at',
  'archived',
] as const;

export function exportCsv(ctx: Ctx, f: TicketFilters = {}): string {
  const users = new Map(listUsers(ctx).map((u) => [u.id, u.name]));
  const types = new Map(listJobTypes(ctx).map((j) => [j.id, j.name]));
  const projects = new Map(listProjects(ctx).map((p) => [p.id, p.name]));
  const tickets = allTickets(ctx, f);
  const numbers = new Map(tickets.map((t) => [t.id, t.job_number]));
  const rows = tickets.map((t) => [
    t.job_number,
    t.title,
    t.description,
    t.status,
    t.priority,
    t.assigned_to ? users.get(t.assigned_to) ?? '' : '',
    t.requester,
    t.job_type_id ? types.get(t.job_type_id) ?? '' : '',
    t.project_id ? projects.get(t.project_id) ?? '' : '',
    t.estimate_minutes,
    t.actual_minutes,
    t.due_date,
    t.due_time,
    t.tags.join(', '),
    t.reference,
    t.file_location,
    t.notes,
    t.waiting_for,
    t.parent_job_id ? numbers.get(t.parent_job_id) ?? get<{ j: string }>(ctx.db, 'SELECT job_number j FROM tickets WHERE id = ?', t.parent_job_id)?.j ?? '' : '',
    localDateTime(ctx, t.created_at),
    t.created_by ? users.get(t.created_by) ?? '' : '',
    localDateTime(ctx, t.claimed_at),
    localDateTime(ctx, t.started_at),
    localDateTime(ctx, t.completed_at),
    t.archived ? 'yes' : '',
  ]);
  return toCsv([[...CSV_COLUMNS], ...rows]);
}

/** Full JSON export: every job with its history, plus users and job types. */
export function exportJson(ctx: Ctx, opts: { activity: boolean } = { activity: true }) {
  const users = listUsers(ctx);
  const byId = new Map(users.map((u) => [u.id, u.name]));
  const types = listJobTypes(ctx);
  const tName = new Map(types.map((j) => [j.id, j.name]));
  const projects = listProjects(ctx);
  const pName = new Map(projects.map((p) => [p.id, p.name]));
  const tickets = allTickets(ctx, {});
  const activity = opts.activity
    ? all<{ ticket_id: number; at: string; kind: string; user_id: number | null; from_value: string | null; to_value: string | null; body: string | null }>(
        ctx.db,
        'SELECT ticket_id, at, kind, user_id, from_value, to_value, body FROM activity ORDER BY id',
      )
    : [];
  const byTicket = new Map<number, unknown[]>();
  for (const a of activity) {
    const list = byTicket.get(a.ticket_id) ?? [];
    list.push({ at: a.at, kind: a.kind, by: a.user_id ? byId.get(a.user_id) ?? null : null, from: a.from_value, to: a.to_value, body: a.body });
    byTicket.set(a.ticket_id, list);
  }
  return {
    format: 'engineering-board-export',
    format_version: 1,
    exported_at: nowIso(ctx),
    time_zone: ctx.tz,
    users: users.map(({ id, name, initials, color, role, active }) => ({ id, name, initials, color, role, active })),
    job_types: types.map(({ id, name, active }) => ({ id, name, active })),
    projects: projects.map(({ id, name, created_at }) => ({ id, name, created_at })),
    tickets: tickets.map((t) => {
      const { overdue: _o, due_today: _d, board_rank: _b, my_rank: _m, version: _v, ...rest } = t;
      return {
        ...rest,
        assignee: t.assigned_to ? byId.get(t.assigned_to) ?? null : null,
        created_by_name: t.created_by ? byId.get(t.created_by) ?? null : null,
        job_type: t.job_type_id ? tName.get(t.job_type_id) ?? null : null,
        project: t.project_id ? pName.get(t.project_id) ?? null : null,
        ...(opts.activity ? { activity: byTicket.get(t.id) ?? [] } : {}),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

type Field =
  | 'title'
  | 'description'
  | 'priority'
  | 'assignee'
  | 'due_date'
  | 'due_time'
  | 'estimate'
  | 'requester'
  | 'job_type'
  | 'project'
  | 'tags'
  | 'reference'
  | 'file_location'
  | 'notes'
  | 'status'
  | 'waiting_for';

/** Header spellings people actually use in their spreadsheets. Compared lower-case, without spaces/punctuation. */
const ALIASES: Record<Field, string[]> = {
  title: ['title', 'job', 'jobtitle', 'task', 'name', 'summary', 'subject', 'work', 'item'],
  description: ['description', 'details', 'detail', 'request', 'desc', 'scope', 'whatneedstobedone'],
  priority: ['priority', 'prio', 'urgency', 'importance'],
  assignee: ['assignee', 'assignedto', 'assigned', 'engineer', 'owner', 'who', 'responsible', 'designer'],
  due_date: ['duedate', 'due', 'deadline', 'targetdate', 'requiredby', 'needby', 'date'],
  due_time: ['duetime', 'time'],
  estimate: ['estimate', 'estimateminutes', 'estimatedminutes', 'est', 'estminutes', 'minutes', 'duration', 'effort', 'estimatedtime'],
  requester: ['requester', 'requestedby', 'requestor', 'customer', 'client', 'from', 'raisedby'],
  job_type: ['jobtype', 'type', 'category', 'worktype', 'kind'],
  project: ['project', 'projectname', 'proj'],
  tags: ['tags', 'tag', 'labels', 'label'],
  reference: ['reference', 'ref', 'drawing', 'drawingnumber', 'drawingno', 'dwg', 'partnumber', 'partno', 'part', 'projectnumber', 'projectno', 'jobnumber', 'jobno'],
  file_location: ['filelocation', 'file', 'path', 'filepath', 'folder', 'location', 'link', 'url'],
  notes: ['notes', 'note', 'comments', 'comment', 'remarks', 'remark'],
  status: ['status', 'state', 'stage', 'column'],
  waiting_for: ['waitingfor', 'blockedby', 'blockedreason', 'waitingon'],
};

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

export function mapHeaders(headers: string[]): (Field | null)[] {
  const used = new Set<Field>();
  return headers.map((h) => {
    const n = norm(h);
    for (const [field, names] of Object.entries(ALIASES) as [Field, string[]][]) {
      if (!used.has(field) && names.includes(n)) {
        used.add(field);
        return field;
      }
    }
    return null;
  });
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');
function validDate(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d || y < 2000 || y > 2100) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * Dates as people type them. Numeric dates are read day-first (India/UK) unless
 * `order` is 'MDY'. Also: 2026-10-02, 2 Oct 2026, Oct 2 2026, and Excel serial numbers.
 */
export function parseDate(raw: string, order: 'DMY' | 'MDY' = 'DMY'): string | null {
  const s = raw.trim();
  if (!s) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(s);
  if (m) return validDate(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:\s.*)?$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    const [a, b] = [+m[1], +m[2]];
    return order === 'DMY' ? validDate(y, b, a) : validDate(y, a, b);
  }
  m = /^(\d{1,2})[\s-]+([a-z]{3})[a-z]*[\s-,]+(\d{4})$/i.exec(s);
  if (m && MONTHS.includes(m[2].toLowerCase())) return validDate(+m[3], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1]);
  m = /^([a-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{4})$/i.exec(s);
  if (m && MONTHS.includes(m[1].toLowerCase())) return validDate(+m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2]);
  if (/^\d{5}$/.test(s)) {
    // Excel serial date (days since 1899-12-30)
    const d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86_400_000);
    return validDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  return null;
}

/** "120", "2h", "1.5 hr", "45 min", "2 days", "1–2 hr" (a bucket label). Bare numbers are minutes. */
export function parseEstimate(raw: string): number | null | 'invalid' {
  const s = raw.trim().toLowerCase().replace(/[–—]/g, '-');
  if (!s) return null;
  const bucket = ESTIMATE_BUCKETS.find((b) => b.label.toLowerCase().replace(/[–—]/g, '-') === s);
  if (bucket) return bucket.minutes;
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|day|days)?$/.exec(s);
  if (!m) return 'invalid';
  const n = parseFloat(m[1]);
  const unit = m[2] ?? 'min';
  const minutes = unit.startsWith('h') ? n * 60 : unit.startsWith('d') ? n * 8 * 60 : n;
  return Math.round(minutes);
}

export function parsePriority(raw: string): Priority | null | 'invalid' {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  if ((PRIORITIES as readonly string[]).includes(s)) return s as Priority;
  const map: Record<string, Priority> = { critical: 'urgent', asap: 'urgent', p1: 'urgent', '1': 'urgent', p2: 'high', '2': 'high', medium: 'normal', med: 'normal', p3: 'normal', '3': 'normal', p4: 'low', '4': 'low', minor: 'low' };
  return map[s] ?? 'invalid';
}

export function parseStatus(raw: string): Status | null | 'invalid' {
  const s = norm(raw);
  if (!s) return null;
  const map: Record<string, Status> = {
    inbox: 'inbox', new: 'inbox', open: 'inbox', todo: 'inbox', unassigned: 'inbox', notstarted: 'inbox',
    claimed: 'claimed', assigned: 'claimed', upnext: 'claimed',
    inprogress: 'in_progress', wip: 'in_progress', started: 'in_progress', ongoing: 'in_progress', working: 'in_progress', active: 'in_progress',
    waiting: 'waiting', onhold: 'waiting', hold: 'waiting', pending: 'waiting',
    blocked: 'blocked', stuck: 'blocked',
    review: 'review', inreview: 'review', checking: 'review',
    done: 'done', complete: 'done', completed: 'done', closed: 'done', finished: 'done',
    cancelled: 'cancelled', canceled: 'cancelled', dropped: 'cancelled',
  };
  return map[s] ?? ((STATUSES as readonly string[]).includes(raw.trim()) ? (raw.trim() as Status) : 'invalid');
}

export interface ImportOptions {
  date_order?: 'DMY' | 'MDY';
  create_job_types?: boolean;
  /** Add project names the board doesn't have yet (default yes). */
  create_projects?: boolean;
  filename?: string;
}

export interface PreviewRow {
  line: number;
  title: string;
  description: string;
  priority: Priority;
  assignee: string | null;
  assignee_id: number | null;
  due_date: string | null;
  due_time: string | null;
  estimate_minutes: number | null;
  requester: string;
  job_type: string | null;
  job_type_is_new: boolean;
  project: string | null;
  project_is_new: boolean;
  tags: string[];
  reference: string;
  file_location: string;
  notes: string;
  status: Status;
  waiting_for: string;
  warnings: string[];
  errors: string[];
}

const MAX_ROWS = 5000;

export function previewImport(ctx: Ctx, csv: string, opts: ImportOptions = {}) {
  if (!csv.trim()) throw badRequest('The file is empty.');
  const rows = parseCsv(csv);
  if (rows.length < 2) throw badRequest('The file needs a header row and at least one job.');
  if (rows.length - 1 > MAX_ROWS) throw badRequest(`That's ${rows.length - 1} rows. Import at most ${MAX_ROWS} at a time.`);
  const headers = rows[0].map((h) => h.trim());
  const mapping = mapHeaders(headers);
  if (!mapping.includes('title'))
    throw badRequest(`No title column found. Name one column "title" (or Job, Task, Name). Columns found: ${headers.join(', ')}`);

  const users = listUsers(ctx);
  const engineers = users.filter((u) => u.role === 'engineer');
  const types = listJobTypes(ctx);
  const order = opts.date_order ?? 'DMY';
  const createTypes = opts.create_job_types ?? true;
  const createProjects = opts.create_projects ?? true;
  const projects = listProjects(ctx);

  const findUser = (s: string): User | undefined => {
    const n = s.trim().toLowerCase();
    if (!n) return undefined;
    return (
      users.find((u) => u.name.toLowerCase() === n) ??
      users.find((u) => u.initials.toLowerCase() === n) ??
      users.find((u) => u.name.toLowerCase().split(/\s+/)[0] === n.split(/\s+/)[0])
    );
  };

  const out: PreviewRow[] = rows.slice(1).map((cells, i) => {
    const get = (f: Field) => {
      const idx = mapping.indexOf(f);
      return idx >= 0 ? unguard((cells[idx] ?? '').trim()) : '';
    };
    const warnings: string[] = [];
    const errors: string[] = [];
    const title = get('title').replace(/\s+/g, ' ').slice(0, 200);
    if (!title) errors.push('No title');
    if (get('title').length > 200) warnings.push('Title cut to 200 characters');

    const p = parsePriority(get('priority'));
    if (p === 'invalid') warnings.push(`Priority "${get('priority')}" not recognised; using Normal`);

    let assignee: User | undefined;
    const aRaw = get('assignee');
    if (aRaw) {
      assignee = findUser(aRaw);
      if (!assignee) warnings.push(`No engineer called "${aRaw}"; left unassigned`);
      else if (assignee.role !== 'engineer') {
        warnings.push(`${assignee.name} is a manager; left unassigned`);
        assignee = undefined;
      } else if (!assignee.active) {
        warnings.push(`${assignee.name} is inactive; left unassigned`);
        assignee = undefined;
      }
    }

    const dRaw = get('due_date');
    const due = dRaw ? parseDate(dRaw, order) : null;
    if (dRaw && !due) errors.push(`Due date "${dRaw}" isn't a date`);
    const tRaw = get('due_time');
    const tm = /^(\d{1,2}):(\d{2})/.exec(tRaw);
    const dueTime = tm && +tm[1] < 24 && +tm[2] < 60 ? `${pad(+tm[1])}:${tm[2]}` : null;
    if (tRaw && !dueTime) warnings.push(`Due time "${tRaw}" ignored`);

    const e = parseEstimate(get('estimate'));
    if (e === 'invalid') warnings.push(`Estimate "${get('estimate')}" not understood; left blank`);

    const jtRaw = get('job_type');
    const jt = jtRaw ? types.find((t) => t.name.toLowerCase() === jtRaw.toLowerCase()) : undefined;
    const jtNew = !!jtRaw && !jt;
    if (jtNew && !createTypes) warnings.push(`Job type "${jtRaw}" doesn't exist; left blank`);

    const prRaw = cleanProjectName(get('project')).slice(0, 100);
    const pr = prRaw ? projects.find((p) => p.name.toLowerCase() === prRaw.toLowerCase()) : undefined;
    const prNew = !!prRaw && !pr;
    if (prNew && !createProjects) warnings.push(`Project "${prRaw}" doesn't exist; set it on the board after importing`);
    if (!prRaw && mapping.includes('project')) warnings.push('No project; set it on the board after importing');

    let status = parseStatus(get('status'));
    if (status === 'invalid') {
      warnings.push(`Status "${get('status')}" not recognised; imported to the Inbox`);
      status = null;
    }
    let st: Status = status ?? (assignee ? 'claimed' : 'inbox');
    if (['claimed', 'in_progress', 'review'].includes(st) && !assignee) {
      warnings.push(`"${get('status')}" needs an engineer; imported to the Inbox`);
      st = 'inbox';
    }
    if (st === 'inbox' && assignee) st = 'claimed';
    let waitingFor = get('waiting_for');
    if ((st === 'waiting' || st === 'blocked') && !waitingFor) waitingFor = 'Imported as waiting; reason not given';

    return {
      line: i + 2,
      title,
      description: get('description'),
      priority: p && p !== 'invalid' ? p : 'normal',
      assignee: assignee?.name ?? null,
      assignee_id: assignee?.id ?? null,
      due_date: due,
      due_time: due ? dueTime : null,
      estimate_minutes: e === 'invalid' ? null : e,
      requester: get('requester'),
      job_type: jt?.name ?? (jtNew && createTypes ? jtRaw.trim() : null),
      job_type_is_new: jtNew && createTypes,
      project: pr?.name ?? (prNew && createProjects ? prRaw : null),
      project_is_new: prNew && createProjects,
      tags: get('tags')
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 20),
      reference: get('reference'),
      file_location: get('file_location'),
      notes: get('notes'),
      status: st,
      waiting_for: waitingFor,
      warnings,
      errors,
    };
  });

  const hash = createHash('sha256').update(csv.replace(/\r\n/g, '\n').trim()).digest('hex');
  const previous = get<{ at: string; rows: number; filename: string; user: string | null }>(
    ctx.db,
    `SELECT i.at, i.rows, i.filename, u.name AS user FROM imports i LEFT JOIN users u ON u.id = i.user_id WHERE i.hash = ? ORDER BY i.id DESC LIMIT 1`,
    hash,
  );
  return {
    columns: headers.map((h, i) => ({ header: h, field: mapping[i] })),
    rows: out,
    counts: {
      total: out.length,
      valid: out.filter((r) => !r.errors.length).length,
      with_errors: out.filter((r) => r.errors.length).length,
      with_warnings: out.filter((r) => !r.errors.length && r.warnings.length).length,
    },
    new_job_types: [...new Set(out.filter((r) => r.job_type_is_new && !r.errors.length).map((r) => r.job_type!))],
    /** True when the sheet has no project column: every job imports without a project. */
    no_project_column: !mapping.includes('project'),
    new_projects: [...new Map(out.filter((r) => r.project_is_new && !r.errors.length).map((r) => [r.project!.toLowerCase(), r.project!])).values()],
    already_imported: previous ?? null,
    hash,
  };
}

export function commitImport(
  ctx: Ctx,
  actor: User,
  csv: string,
  opts: ImportOptions & { skip_invalid?: boolean; allow_duplicate?: boolean },
) {
  const preview = previewImport(ctx, csv, opts);
  if (preview.already_imported && !opts.allow_duplicate)
    throw conflict(`This exact file was already imported on ${preview.already_imported.at.slice(0, 10)}. Importing it again would create duplicates.`, {
      already_imported: preview.already_imported,
    });
  if (preview.counts.with_errors && !opts.skip_invalid)
    throw badRequest(`${preview.counts.with_errors} row(s) have errors. Fix them in the file, or choose to skip them.`);
  const rows = preview.rows.filter((r) => !r.errors.length);
  if (!rows.length) throw badRequest('There are no valid rows to import.');

  const created: string[] = [];
  tx(ctx.db, () => {
    const typeIds = new Map(listJobTypes(ctx).map((t) => [t.name.toLowerCase(), t.id]));
    for (const name of preview.new_job_types) {
      if (!typeIds.has(name.toLowerCase())) typeIds.set(name.toLowerCase(), createJobType(ctx, { name }).id);
    }
    const projectIds = new Map(listProjects(ctx).map((p) => [p.name.toLowerCase(), p.id]));
    for (const name of preview.new_projects) {
      if (!projectIds.has(name.toLowerCase())) projectIds.set(name.toLowerCase(), createProject(ctx, actor, { name }).id);
    }
    const users = new Map(listUsers(ctx).map((u) => [u.id, u]));
    for (const r of rows) {
      const { ticket } = createTicket(ctx, actor, {
        title: r.title,
        description: r.description,
        priority: r.priority,
        requester: r.requester,
        job_type_id: r.job_type ? typeIds.get(r.job_type.toLowerCase()) ?? null : null,
        project_id: r.project ? projectIds.get(r.project.toLowerCase()) ?? null : null,
        estimate_minutes: r.estimate_minutes,
        due_date: r.due_date,
        due_time: r.due_time,
        reference: r.reference,
        file_location: r.file_location,
        notes: r.notes,
        tags: r.tags,
        assigned_to: r.assignee_id,
      });
      run(
        ctx.db,
        'INSERT INTO activity (ticket_id, user_id, at, kind, body) VALUES (?, ?, ?, ?, ?)',
        ticket.id,
        actor.id,
        nowIso(ctx),
        'imported',
        `${opts.filename || 'CSV file'}, line ${r.line}`,
      );
      if (r.status !== 'inbox' && r.status !== 'claimed') {
        const owner = r.assignee_id ? users.get(r.assignee_id)! : actor;
        moveTicket(ctx, owner, ticket.id, { status: r.status, reason: r.waiting_for || undefined });
      }
      created.push(getTicket(ctx, ticket.id).job_number);
    }
    run(
      ctx.db,
      'INSERT INTO imports (hash, filename, rows, user_id, at) VALUES (?, ?, ?, ?, ?)',
      preview.hash,
      opts.filename ?? '',
      created.length,
      actor.id,
      nowIso(ctx),
    );
  });
  return { created: created.length, first: created[0], last: created[created.length - 1], skipped: preview.counts.with_errors };
}

/** A starter file people can fill in from Excel. */
export function importTemplate(): string {
  return toCsv([
    ['title', 'project', 'description', 'priority', 'assignee', 'due_date', 'estimate', 'requester', 'job_type', 'tags', 'reference', 'file_location', 'notes', 'status'],
    ['Pump drawing revision', 'Pump skid', 'Update holes per ECN-112', 'High', 'Paul', '02/10/2026', '120', 'Quality', 'Drawing Revision', 'customer-A', 'DWG-4410', '\\\\SERVER\\Projects\\Pump', '', ''],
    ['STEP cleanup', 'Pump skid', 'Repair imported geometry', 'Normal', '', '03/10/2026', '1 hr', 'Production', 'STEP/IGES Cleanup', 'STEP', '', '', '', ''],
  ]);
}

// ---------------------------------------------------------------------------
// Bulk archive and tags
// ---------------------------------------------------------------------------

/** Archive done/cancelled jobs finished more than `days` days ago. They stay searchable. */
export function archiveOld(ctx: Ctx, actor: User, days: number): { archived: number } {
  if (!Number.isInteger(days) || days < 1) throw badRequest('Days must be a whole number of at least 1');
  const cutoff = new Date(ctx.now().getTime() - days * 86_400_000).toISOString();
  return tx(ctx.db, () => {
    const ids = all<{ id: number }>(
      ctx.db,
      `SELECT id FROM tickets WHERE archived = 0 AND status IN ('done','cancelled') AND COALESCE(completed_at, updated_at) < ?`,
      cutoff,
    ).map((r) => r.id);
    for (const id of ids) {
      run(ctx.db, 'UPDATE tickets SET archived = 1, version = version + 1, updated_at = ? WHERE id = ?', nowIso(ctx), id);
      run(ctx.db, 'INSERT INTO activity (ticket_id, user_id, at, kind, body) VALUES (?, ?, ?, ?, ?)', id, actor.id, nowIso(ctx), 'archived', `finished more than ${days} days ago`);
    }
    if (ids.length) ctx.events.emit({ type: 'reload' });
    return { archived: ids.length };
  });
}

export function listTags(ctx: Ctx) {
  return all<{ id: number; name: string; count: number }>(
    ctx.db,
    'SELECT g.id, g.name, COUNT(tt.ticket_id) count FROM tags g LEFT JOIN ticket_tags tt ON tt.tag_id = g.id GROUP BY g.id ORDER BY g.name COLLATE NOCASE',
  );
}

/** Rename a tag. If the new name already exists, the two are merged. */
export function renameTag(ctx: Ctx, id: number, newName: string) {
  const name = newName.trim().replace(/\s+/g, '-');
  if (!name || name.length > 40) throw badRequest('Tag names are 1–40 characters');
  return tx(ctx.db, () => {
    const cur = get<{ id: number; name: string }>(ctx.db, 'SELECT id, name FROM tags WHERE id = ?', id);
    if (!cur) throw badRequest('Tag not found');
    const other = get<{ id: number }>(ctx.db, 'SELECT id FROM tags WHERE name = ? AND id <> ?', name, id);
    const affected = all<{ ticket_id: number }>(ctx.db, 'SELECT ticket_id FROM ticket_tags WHERE tag_id = ?', id).map((r) => r.ticket_id);
    if (other) {
      run(ctx.db, 'INSERT OR IGNORE INTO ticket_tags (ticket_id, tag_id) SELECT ticket_id, ? FROM ticket_tags WHERE tag_id = ?', other.id, id);
      run(ctx.db, 'DELETE FROM ticket_tags WHERE tag_id = ?', id);
      run(ctx.db, 'DELETE FROM tags WHERE id = ?', id);
    } else run(ctx.db, 'UPDATE tags SET name = ? WHERE id = ?', name, id);
    for (const tid of affected) reindexTicket(ctx, tid);
    ctx.events.emit({ type: 'reload' });
    return { merged: !!other, tickets: affected.length };
  });
}

export function deleteTag(ctx: Ctx, id: number) {
  const used = get<{ n: number }>(ctx.db, 'SELECT COUNT(*) n FROM ticket_tags WHERE tag_id = ?', id)!.n;
  if (used) throw conflict(`That tag is on ${used} job(s). Rename it to merge it into another tag instead.`);
  run(ctx.db, 'DELETE FROM tags WHERE id = ?', id);
  return { ok: true };
}
