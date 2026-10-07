import {
  ASSIGNED_STATUSES,
  CLOSED_STATUSES,
  OPEN_STATUSES,
  PRIORITIES,
  REASON_STATUSES,
  STATUSES,
  STATUS_LABEL,
  allows,
  canChangeJob,
  commentSchema,
  createTicketSchema,
  createBoardTicketSchema,
  estimateLabel,
  moveTicketSchema,
  rankSchema,
  updateTicketSchema,
  type Activity,
  type Status,
  type Ticket,
  type User,
} from '@board/shared';
import { randomUUID } from 'node:crypto';
import { all, get, run, tx, type Db, type Param } from '../db/connection.ts';
import { PERMISSION_DENIED, getPermissions } from './permissions.ts';
import { HttpError, badRequest, bool, conflict, forbidden, notFound, nowIso, type Ctx } from '../lib/core.ts';
import { dueAtIso, localDate, startOfLocalDayIso, addDays } from '../lib/time.ts';
import { boardScope, bottomRank, myScope, rankFor } from './rank.ts';
import { reindexTicket, searchCondition, rankExpr } from './search.ts';
import { getUser } from './users.ts';
import { projectIdsFor, requireProject, setTicketProject } from './projects.ts';

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type Row = Omit<Ticket, 'archived' | 'is_demo' | 'tags' | 'overdue' | 'due_today' | 'project_id'> & { archived: number; is_demo: number };

function tagsFor(ctx: Ctx, ids: number[]): Map<number, string[]> {
  const map = new Map<number, string[]>();
  if (!ids.length) return map;
  // chunk to stay well under SQLite's parameter limit
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = all<{ ticket_id: number; name: string }>(
      ctx.db,
      `SELECT tt.ticket_id, g.name FROM ticket_tags tt JOIN tags g ON g.id = tt.tag_id
       WHERE tt.ticket_id IN (${chunk.map(() => '?').join(',')}) ORDER BY g.name`,
      ...chunk,
    );
    for (const r of rows) {
      const list = map.get(r.ticket_id) ?? [];
      list.push(r.name);
      map.set(r.ticket_id, list);
    }
  }
  return map;
}

function toTickets(ctx: Ctx, rows: Row[]): Ticket[] {
  const tags = tagsFor(ctx, rows.map((r) => r.id));
  const projects = projectIdsFor(ctx, rows.map((r) => r.id));
  const now = nowIso(ctx);
  const today = localDate(ctx.now().getTime(), ctx.tz);
  return rows.map((r) => {
    const open = OPEN_STATUSES.includes(r.status);
    return {
      ...r,
      archived: bool(r.archived),
      is_demo: bool(r.is_demo),
      tags: tags.get(r.id) ?? [],
      project_id: projects.get(r.id) ?? null,
      overdue: open && r.due_at != null && now > r.due_at,
      due_today: open && r.due_date === today,
    };
  });
}

export function getTicket(ctx: Ctx, id: number): Ticket {
  const r = get<Row>(ctx.db, 'SELECT * FROM tickets WHERE id = ?', id);
  if (!r) throw notFound('Job');
  return toTickets(ctx, [r])[0];
}

function getRow(ctx: Ctx, id: number): Row {
  const r = get<Row>(ctx.db, 'SELECT * FROM tickets WHERE id = ?', id);
  if (!r) throw notFound('Job');
  return r;
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

function log(
  ctx: Ctx,
  ticketId: number,
  userId: number | null,
  kind: string,
  from: string | null = null,
  to: string | null = null,
  body: string | null = null,
) {
  run(
    ctx.db,
    'INSERT INTO activity (ticket_id, user_id, at, kind, from_value, to_value, body) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ticketId,
    userId,
    nowIso(ctx),
    kind,
    from,
    to,
    body,
  );
}

/** Append to a job's history (used by the review workflow too). */
export const logActivity = log;

const ACTIVITY_SELECT = `
  SELECT a.*, u.name AS user_name, t.job_number, t.title AS ticket_title
  FROM activity a
  LEFT JOIN users u ON u.id = a.user_id
  JOIN tickets t ON t.id = a.ticket_id`;

export function ticketActivity(ctx: Ctx, id: number): Activity[] {
  getRow(ctx, id);
  return all<Activity>(ctx.db, `${ACTIVITY_SELECT} WHERE a.ticket_id = ? ORDER BY a.id`, id);
}

/** A page of the team activity feed, newest first. */
export function activityPage(ctx: Ctx, opts: { limit: number; before?: number; userId?: number }): Activity[] {
  const where: string[] = [];
  const params: Param[] = [];
  if (opts.before) {
    where.push('a.id < ?');
    params.push(opts.before);
  }
  if (opts.userId) {
    where.push('a.user_id = ?');
    params.push(opts.userId);
  }
  return all<Activity>(
    ctx.db,
    `${ACTIVITY_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT ?`,
    ...params,
    opts.limit,
  );
}

export function recentActivity(ctx: Ctx, limit = 30, sinceId?: number): Activity[] {
  if (sinceId) return all<Activity>(ctx.db, `${ACTIVITY_SELECT} WHERE a.id > ? ORDER BY a.id DESC LIMIT ?`, sinceId, limit);
  return all<Activity>(ctx.db, `${ACTIVITY_SELECT} ORDER BY a.id DESC LIMIT ?`, limit);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userName(ctx: Ctx, id: number | null): string | null {
  if (id == null) return null;
  return getUser(ctx, id)?.name ?? `user #${id}`;
}

function requireAssignable(ctx: Ctx, userId: number): User {
  const u = getUser(ctx, userId);
  if (!u) throw badRequest('That person does not exist');
  if (!u.active) throw badRequest(`${u.name} is inactive and cannot be assigned work`);
  if (!allows(getPermissions(ctx), u, 'claim')) throw badRequest(`${u.name} is a ${u.role}; ${u.role}s cannot be assigned jobs (Admin → Roles)`);
  return u;
}

/** Changing a job needs "edit", or "claim" on a job assigned to you (decision #31). */
function requireChange(ctx: Ctx, actor: User, row: { assigned_to: number | null }) {
  if (!canChangeJob(getPermissions(ctx), actor, row)) throw forbidden(PERMISSION_DENIED.edit);
}

function nextJobNumber(ctx: Ctx): string {
  run(ctx.db, `INSERT INTO counters (name, value) VALUES ('job', 1) ON CONFLICT(name) DO UPDATE SET value = value + 1`);
  const n = get<{ value: number }>(ctx.db, `SELECT value FROM counters WHERE name = 'job'`)!.value;
  return `JOB-${String(n).padStart(4, '0')}`;
}

function setTags(ctx: Ctx, ticketId: number, names: string[]): void {
  const clean = [...new Map(names.map((n) => [n.trim().replace(/\s+/g, '-').toLowerCase(), n.trim().replace(/\s+/g, '-')])).values()].filter(Boolean);
  run(ctx.db, 'DELETE FROM ticket_tags WHERE ticket_id = ?', ticketId);
  for (const name of clean) {
    run(ctx.db, 'INSERT INTO tags (name) VALUES (?) ON CONFLICT(name) DO NOTHING', name);
    const tag = get<{ id: number }>(ctx.db, 'SELECT id FROM tags WHERE name = ?', name)!;
    run(ctx.db, 'INSERT OR IGNORE INTO ticket_tags (ticket_id, tag_id) VALUES (?, ?)', ticketId, tag.id);
  }
}

function currentTags(ctx: Ctx, ticketId: number): string[] {
  return tagsFor(ctx, [ticketId]).get(ticketId) ?? [];
}

function checkJobType(ctx: Ctx, id: number | null | undefined) {
  if (id == null) return;
  if (!get(ctx.db, 'SELECT 1 FROM job_types WHERE id = ?', id)) throw badRequest('Unknown job type');
}

function checkParent(ctx: Ctx, selfId: number | null, parentId: number | null | undefined) {
  if (parentId == null) return;
  if (parentId === selfId) throw badRequest('A job cannot be its own parent');
  let cur: number | null = parentId;
  for (let i = 0; cur != null && i < 100; i++) {
    const r: { parent_job_id: number | null } | undefined = get<{ parent_job_id: number | null }>(ctx.db, 'SELECT parent_job_id FROM tickets WHERE id = ?', cur);
    if (!r) throw badRequest('Parent job not found');
    if (r.parent_job_id === selfId && selfId != null) throw badRequest('That would create a parent/child loop');
    cur = r.parent_job_id;
  }
}

const fmtDue = (d: string | null, t: string | null) => (d ? (t ? `${d} ${t}` : d) : null);
const short = (s: string | null) => (s == null ? null : s.length > 200 ? s.slice(0, 197) + '…' : s);

function touch(ctx: Ctx, id: number) {
  run(ctx.db, 'UPDATE tickets SET updated_at = ?, version = version + 1 WHERE id = ?', nowIso(ctx), id);
}

export function emitTicket(ctx: Ctx, id: number, by: number | null) {
  const v = get<{ version: number }>(ctx.db, 'SELECT version FROM tickets WHERE id = ?', id)?.version;
  ctx.events.emit({ type: 'ticket', id, version: v, by });
}

/** Assign/unassign with all the side effects (status, timestamps, ranks, activity). */
function applyAssignment(ctx: Ctx, actor: User, row: Row, to: number | null) {
  if (to === row.assigned_to) return;
  const now = nowIso(ctx);
  if (to == null) {
    const status: Status = ASSIGNED_STATUSES.includes(row.status) ? 'inbox' : row.status;
    run(ctx.db, 'UPDATE tickets SET assigned_to = NULL, claimed_at = NULL, status = ? WHERE id = ?', status, row.id);
    if (status !== row.status) {
      run(ctx.db, 'UPDATE tickets SET board_rank = ? WHERE id = ?', rankFor(ctx, boardScope(status), row.id), row.id);
    }
    log(ctx, row.id, actor.id, 'released', userName(ctx, row.assigned_to), null);
    if (status !== row.status) log(ctx, row.id, actor.id, 'status', row.status, status);
    return;
  }
  const target = requireAssignable(ctx, to);
  const status: Status = row.status === 'inbox' ? 'claimed' : row.status;
  run(
    ctx.db,
    'UPDATE tickets SET assigned_to = ?, claimed_at = ?, status = ?, my_rank = ? WHERE id = ?',
    target.id,
    now,
    status,
    bottomRank(ctx, myScope(target.id), row.id),
    row.id,
  );
  if (status !== row.status) run(ctx.db, 'UPDATE tickets SET board_rank = ? WHERE id = ?', rankFor(ctx, boardScope(status), row.id), row.id);
  if (actor.id === target.id && row.assigned_to == null) log(ctx, row.id, actor.id, 'claimed', null, target.name);
  else log(ctx, row.id, actor.id, 'assigned', userName(ctx, row.assigned_to), target.name);
  if (status !== row.status) log(ctx, row.id, actor.id, 'status', row.status, status);
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export function createTicket(
  ctx: Ctx,
  actor: User,
  input: unknown,
  idempotencyKey?: string,
  opts: { requireProject?: boolean } = {},
): { ticket: Ticket; replayed: boolean } {
  const data = (opts.requireProject ? createBoardTicketSchema : createTicketSchema)(input);
  if (data.claim && !allows(getPermissions(ctx), actor, 'claim')) throw forbidden(PERMISSION_DENIED.claim);
  return tx(ctx.db, () => {
    if (idempotencyKey) {
      const prev = get<{ ticket_id: number }>(ctx.db, 'SELECT ticket_id FROM idempotency WHERE key = ?', idempotencyKey);
      if (prev) return { ticket: getTicket(ctx, prev.ticket_id), replayed: true };
    }
    checkJobType(ctx, data.job_type_id);
    if (data.project_id != null) requireProject(ctx, data.project_id);
    checkParent(ctx, null, data.parent_job_id);
    if (data.due_time && !data.due_date) throw badRequest('A due time needs a due date');
    const now = nowIso(ctx);
    const jobNumber = nextJobNumber(ctx);
    const res = run(
      ctx.db,
      `INSERT INTO tickets (job_number, title, description, status, priority, created_by, requester, job_type_id,
         estimate_minutes, due_date, due_time, due_at, reference, file_location, notes, parent_job_id,
         board_rank, created_at, updated_at)
       VALUES (?, ?, ?, 'inbox', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      jobNumber,
      data.title,
      data.description,
      data.priority,
      actor.id,
      data.requester,
      data.job_type_id ?? null,
      data.estimate_minutes ?? null,
      data.due_date ?? null,
      data.due_time ?? null,
      dueAtIso(data.due_date ?? null, data.due_time ?? null, ctx.tz),
      data.reference,
      data.file_location,
      data.notes,
      data.parent_job_id ?? null,
      now,
      now,
    );
    const id = Number(res.lastInsertRowid);
    run(ctx.db, 'UPDATE tickets SET board_rank = ? WHERE id = ?', rankFor(ctx, boardScope('inbox'), id), id);
    if (data.tags.length) setTags(ctx, id, data.tags);
    if (data.project_id != null) setTicketProject(ctx, id, data.project_id);
    log(ctx, id, actor.id, 'created', null, data.priority, data.title);

    const assignee = data.claim ? actor.id : data.assigned_to ?? null;
    if (assignee != null) applyAssignment(ctx, actor, getRow(ctx, id), assignee);

    if (idempotencyKey) run(ctx.db, 'INSERT INTO idempotency (key, ticket_id, created_at) VALUES (?, ?, ?)', idempotencyKey, id, now);
    reindexTicket(ctx, id);
    emitTicket(ctx, id, actor.id);
    return { ticket: getTicket(ctx, id), replayed: false };
  });
}

// ---------------------------------------------------------------------------
// Update fields
// ---------------------------------------------------------------------------

const SIMPLE_FIELDS = ['title', 'priority', 'requester', 'reference', 'file_location'] as const;
const LONG_FIELDS = ['description', 'notes'] as const;
const FIELD_LABEL: Record<string, string> = {
  title: 'title',
  priority: 'priority',
  requester: 'requester',
  reference: 'reference',
  file_location: 'file location',
  description: 'description',
  notes: 'notes',
  estimate_minutes: 'estimate',
  actual_minutes: 'actual time',
  job_type_id: 'job type',
  project_id: 'project',
  due: 'due date',
  tags: 'tags',
  parent_job_id: 'parent job',
};

export function updateTicket(ctx: Ctx, actor: User, id: number, input: unknown): Ticket {
  const data = updateTicketSchema(input);
  return tx(ctx.db, () => {
    const row = getRow(ctx, id);
    requireChange(ctx, actor, row);
    if (data.version !== row.version) {
      throw conflict(`${row.job_number} was changed by someone else. Your view has been refreshed — please re-apply your edit.`, {
        current: getTicket(ctx, id),
      });
    }
    const sets: string[] = [];
    const params: Param[] = [];
    const set = (col: string, val: Param) => {
      sets.push(`${col} = ?`);
      params.push(val);
    };

    for (const f of SIMPLE_FIELDS) {
      const nv = data[f];
      if (nv !== undefined && nv !== row[f]) {
        set(f, nv);
        if (f === 'priority') log(ctx, id, actor.id, 'priority', row.priority, nv as string);
        else log(ctx, id, actor.id, 'field', short(row[f] as string) || null, short(nv as string) || null, FIELD_LABEL[f]);
      }
    }
    for (const f of LONG_FIELDS) {
      const nv = data[f];
      if (nv !== undefined && nv !== row[f]) {
        set(f, nv);
        log(ctx, id, actor.id, 'field', null, null, FIELD_LABEL[f]);
      }
    }
    for (const f of ['estimate_minutes', 'actual_minutes'] as const) {
      const nv = data[f];
      if (nv !== undefined && nv !== row[f]) {
        set(f, nv);
        const fmt = (m: number | null) => (m == null ? null : f === 'estimate_minutes' ? estimateLabel(m) : `${m} min`);
        log(ctx, id, actor.id, 'field', fmt(row[f]), fmt(nv), FIELD_LABEL[f]);
      }
    }
    if (data.job_type_id !== undefined && data.job_type_id !== row.job_type_id) {
      checkJobType(ctx, data.job_type_id);
      set('job_type_id', data.job_type_id);
      const name = (jid: number | null) => (jid == null ? null : get<{ name: string }>(ctx.db, 'SELECT name FROM job_types WHERE id = ?', jid)?.name ?? null);
      log(ctx, id, actor.id, 'field', name(row.job_type_id), name(data.job_type_id), FIELD_LABEL.job_type_id);
    }
    if (data.project_id !== undefined) {
      const changed = setTicketProject(ctx, id, data.project_id);
      if (changed) log(ctx, id, actor.id, 'field', changed.from, changed.to, FIELD_LABEL.project_id);
    }
    if (data.parent_job_id !== undefined && data.parent_job_id !== row.parent_job_id) {
      checkParent(ctx, id, data.parent_job_id);
      set('parent_job_id', data.parent_job_id);
      const jn = (pid: number | null) => (pid == null ? null : get<{ job_number: string }>(ctx.db, 'SELECT job_number FROM tickets WHERE id = ?', pid)?.job_number ?? null);
      log(ctx, id, actor.id, 'field', jn(row.parent_job_id), jn(data.parent_job_id), FIELD_LABEL.parent_job_id);
    }
    if (data.due_date !== undefined || data.due_time !== undefined) {
      const dd = data.due_date !== undefined ? data.due_date : row.due_date;
      let dt = data.due_time !== undefined ? data.due_time : row.due_time;
      if (!dd) dt = null; // clearing the date clears the time
      if (dd !== row.due_date || dt !== row.due_time) {
        set('due_date', dd);
        set('due_time', dt);
        set('due_at', dueAtIso(dd, dt, ctx.tz));
        log(ctx, id, actor.id, 'field', fmtDue(row.due_date, row.due_time), fmtDue(dd, dt), FIELD_LABEL.due);
      }
    }
    if (data.tags !== undefined) {
      const before = currentTags(ctx, id);
      setTags(ctx, id, data.tags);
      const after = currentTags(ctx, id);
      if (before.join('\u0000').toLowerCase() !== after.join('\u0000').toLowerCase())
        log(ctx, id, actor.id, 'field', before.join(', ') || null, after.join(', ') || null, FIELD_LABEL.tags);
    }
    if (sets.length) run(ctx.db, `UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
    if (data.assigned_to !== undefined) applyAssignment(ctx, actor, getRow(ctx, id), data.assigned_to);

    touch(ctx, id);
    reindexTicket(ctx, id);
    emitTicket(ctx, id, actor.id);
    return getTicket(ctx, id);
  });
}

// ---------------------------------------------------------------------------
// Move (status change and/or reorder on the board)
// ---------------------------------------------------------------------------

export function moveTicket(ctx: Ctx, actor: User, id: number, input: unknown): Ticket {
  const data = moveTicketSchema(input);
  return tx(ctx.db, () => {
    let row = getRow(ctx, id);
    requireChange(ctx, actor, row);
    if (row.archived) throw conflict(`${row.job_number} is archived. Restore it first.`);
    if (data.from_status && data.from_status !== row.status) {
      const who = userName(ctx, lastActorFor(ctx, id));
      throw conflict(
        `${row.job_number} was already moved to ${STATUS_LABEL[row.status]}${who ? ` by ${who}` : ''}.`,
        { current: getTicket(ctx, id) },
      );
    }
    const target = data.status;
    const from = row.status;
    const now = nowIso(ctx);
    const reason = (data.reason ?? '').trim();

    if (target !== from) {
      // assignment requirements
      if (ASSIGNED_STATUSES.includes(target) && row.assigned_to == null) {
        if (!allows(getPermissions(ctx), actor, 'claim')) {
          throw new HttpError(409, 'needs_assignee', `Assign ${row.job_number} to someone before moving it to ${STATUS_LABEL[target]}.`);
        }
        applyAssignment(ctx, actor, row, actor.id);
        row = getRow(ctx, id);
      }
      if (target === 'inbox' && row.assigned_to != null) {
        applyAssignment(ctx, actor, row, null);
        row = getRow(ctx, id);
      }
      // reason requirement for waiting/blocked
      let waitingFor = row.waiting_for;
      if (REASON_STATUSES.includes(target)) {
        if (reason) waitingFor = reason;
        else if (!(REASON_STATUSES.includes(from) && row.waiting_for)) {
          throw new HttpError(400, 'reason_required', `Say what ${row.job_number} is waiting for.`);
        }
      } else {
        waitingFor = '';
      }
      if (target === 'done') {
        // Drawings under board review must be physically signed first (decision #26).
        const pending = all<{ identifier: string }>(
          ctx.db,
          `SELECT identifier FROM review_drawings WHERE ticket_id = ? AND required = 1 AND state <> 'signed' ORDER BY identifier`,
          id,
        );
        if (pending.length)
          throw new HttpError(
            409,
            'signatures_pending',
            `${row.job_number} can't be Done yet: ${pending.length === 1 ? '1 drawing still needs' : `${pending.length} drawings still need`} a physical signature (${pending.map((p) => p.identifier).join(', ')}). Record the signatures in Review first.`,
          );
      }
      const startedAt = target === 'in_progress' ? row.started_at ?? now : row.started_at;
      const completedAt = target === 'done' ? now : CLOSED_STATUSES.includes(target) ? row.completed_at : null;
      run(
        ctx.db,
        'UPDATE tickets SET status = ?, waiting_for = ?, started_at = ?, completed_at = ? WHERE id = ?',
        target,
        waitingFor,
        startedAt,
        completedAt,
        id,
      );
      if (row.status !== target) log(ctx, id, actor.id, 'status', row.status, target, REASON_STATUSES.includes(target) ? waitingFor : null);
    } else if (REASON_STATUSES.includes(target) && reason && reason !== row.waiting_for) {
      run(ctx.db, 'UPDATE tickets SET waiting_for = ? WHERE id = ?', reason, id);
      log(ctx, id, actor.id, 'field', short(row.waiting_for) || null, short(reason), 'waiting for');
    }

    run(ctx.db, 'UPDATE tickets SET board_rank = ? WHERE id = ?', rankFor(ctx, boardScope(target), id, data.before_id, data.after_id), id);
    touch(ctx, id);
    reindexTicket(ctx, id);
    emitTicket(ctx, id, actor.id);
    return getTicket(ctx, id);
  });
}

function lastActorFor(ctx: Ctx, ticketId: number): number | null {
  return get<{ user_id: number | null }>(ctx.db, 'SELECT user_id FROM activity WHERE ticket_id = ? ORDER BY id DESC LIMIT 1', ticketId)?.user_id ?? null;
}

// ---------------------------------------------------------------------------
// Claim / release
// ---------------------------------------------------------------------------

export function claimTicket(ctx: Ctx, actor: User, id: number): Ticket {
  if (!allows(getPermissions(ctx), actor, 'claim')) throw forbidden(PERMISSION_DENIED.claim);
  if (!actor.active) throw forbidden('Inactive users cannot claim jobs');
  return tx(ctx.db, () => {
    const row = getRow(ctx, id);
    // Atomic guard: only succeeds if still unassigned and open.
    const res = run(
      ctx.db,
      `UPDATE tickets SET assigned_to = ? WHERE id = ? AND assigned_to IS NULL AND archived = 0 AND status NOT IN ('done','cancelled')`,
      actor.id,
      id,
    );
    if (res.changes === 0) {
      if (row.assigned_to != null) {
        throw conflict(
          row.assigned_to === actor.id ? `You already have ${row.job_number}.` : `${row.job_number} was already claimed by ${userName(ctx, row.assigned_to)}.`,
          { current: getTicket(ctx, id) },
        );
      }
      throw conflict(`${row.job_number} is ${row.archived ? 'archived' : STATUS_LABEL[row.status].toLowerCase()} and cannot be claimed.`, {
        current: getTicket(ctx, id),
      });
    }
    // undo the guard write and let applyAssignment do the full bookkeeping
    run(ctx.db, 'UPDATE tickets SET assigned_to = NULL WHERE id = ?', id);
    applyAssignment(ctx, actor, getRow(ctx, id), actor.id);
    touch(ctx, id);
    reindexTicket(ctx, id);
    emitTicket(ctx, id, actor.id);
    return getTicket(ctx, id);
  });
}

export function releaseTicket(ctx: Ctx, actor: User, id: number): Ticket {
  return tx(ctx.db, () => {
    const row = getRow(ctx, id);
    requireChange(ctx, actor, row);
    if (row.assigned_to == null) throw conflict(`${row.job_number} is not assigned to anyone.`, { current: getTicket(ctx, id) });
    if (CLOSED_STATUSES.includes(row.status)) throw conflict(`${row.job_number} is closed.`);
    applyAssignment(ctx, actor, row, null);
    touch(ctx, id);
    reindexTicket(ctx, id);
    emitTicket(ctx, id, actor.id);
    return getTicket(ctx, id);
  });
}

// ---------------------------------------------------------------------------
// My Work ordering, comments, archive
// ---------------------------------------------------------------------------

export function setMyRank(ctx: Ctx, actor: User, id: number, input: unknown): Ticket {
  const data = rankSchema(input);
  return tx(ctx.db, () => {
    const row = getRow(ctx, id);
    if (row.assigned_to !== actor.id) throw forbidden('You can only reorder your own work');
    run(ctx.db, 'UPDATE tickets SET my_rank = ? WHERE id = ?', rankFor(ctx, myScope(actor.id), id, data.before_id, data.after_id), id);
    // ordering only: no version bump, no activity entry
    ctx.events.emit({ type: 'ticket', id, version: row.version, by: actor.id });
    return getTicket(ctx, id);
  });
}

export function addComment(ctx: Ctx, actor: User, id: number, input: unknown): Activity {
  const data = commentSchema(input);
  return tx(ctx.db, () => {
    getRow(ctx, id);
    log(ctx, id, actor.id, 'comment', null, null, data.body);
    run(ctx.db, 'UPDATE tickets SET updated_at = ? WHERE id = ?', nowIso(ctx), id);
    emitTicket(ctx, id, actor.id);
    return all<Activity>(ctx.db, `${ACTIVITY_SELECT} WHERE a.ticket_id = ? ORDER BY a.id DESC LIMIT 1`, id)[0];
  });
}

export function archiveTicket(ctx: Ctx, actor: User, id: number): Ticket {
  return tx(ctx.db, () => {
    const row = getRow(ctx, id);
    requireChange(ctx, actor, row);
    if (row.archived) return getTicket(ctx, id);
    if (!CLOSED_STATUSES.includes(row.status))
      throw conflict(`Only done or cancelled jobs can be archived. ${row.job_number} is ${STATUS_LABEL[row.status].toLowerCase()}.`);
    run(ctx.db, 'UPDATE tickets SET archived = 1 WHERE id = ?', id);
    log(ctx, id, actor.id, 'archived');
    touch(ctx, id);
    emitTicket(ctx, id, actor.id);
    return getTicket(ctx, id);
  });
}

export function restoreTicket(ctx: Ctx, actor: User, id: number): Ticket {
  return tx(ctx.db, () => {
    const row = getRow(ctx, id);
    requireChange(ctx, actor, row);
    if (!row.archived) return getTicket(ctx, id);
    run(ctx.db, 'UPDATE tickets SET archived = 0, board_rank = ? WHERE id = ?', rankFor(ctx, boardScope(row.status), id), id);
    log(ctx, id, actor.id, 'restored');
    touch(ctx, id);
    emitTicket(ctx, id, actor.id);
    return getTicket(ctx, id);
  });
}

// ---------------------------------------------------------------------------
// Listing / filtering / search
// ---------------------------------------------------------------------------

export interface TicketFilters {
  view?: 'board' | 'all';
  q?: string;
  assignee?: (number | 'none')[];
  status?: Status[];
  priority?: string[];
  job_type?: number[];
  /** Project ids, or "none" for jobs without a project. */
  project?: (number | 'none')[];
  tag?: string;
  overdue?: boolean;
  blocked?: boolean;
  unassigned?: boolean;
  due_from?: string;
  due_to?: string;
  created_from?: string;
  created_to?: string;
  archived?: 'exclude' | 'only' | 'include';
  limit?: number;
  offset?: number;
}

const csv = (s: string | null | undefined) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const isDate = (s: string | undefined) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Parse query-string filters leniently: unknown values are rejected with a clear message. */
export function parseFilters(qs: URLSearchParams): TicketFilters {
  const f: TicketFilters = {};
  const view = qs.get('view');
  if (view) {
    if (view !== 'board' && view !== 'all') throw badRequest('view must be board or all');
    f.view = view;
  }
  if (qs.get('q')) f.q = qs.get('q')!.slice(0, 200);
  const assignee = csv(qs.get('assignee'));
  if (assignee.length)
    f.assignee = assignee.map((a) => {
      if (a === 'none') return 'none' as const;
      const n = Number(a);
      if (!Number.isInteger(n)) throw badRequest('assignee must be user ids or "none"');
      return n;
    });
  const status = csv(qs.get('status'));
  for (const s of status) if (!STATUSES.includes(s as Status)) throw badRequest(`Unknown status "${s}"`);
  if (status.length) f.status = status as Status[];
  const priority = csv(qs.get('priority'));
  for (const p of priority) if (!PRIORITIES.includes(p as never)) throw badRequest(`Unknown priority "${p}"`);
  if (priority.length) f.priority = priority;
  const jt = csv(qs.get('job_type')).map(Number);
  if (jt.some((n) => !Number.isInteger(n))) throw badRequest('job_type must be ids');
  if (jt.length) f.job_type = jt;
  const pr = csv(qs.get('project'));
  if (pr.length)
    f.project = pr.map((p) => {
      if (p === 'none') return 'none' as const;
      const n = Number(p);
      if (!Number.isInteger(n)) throw badRequest('project must be ids or "none"');
      return n;
    });
  if (qs.get('tag')) f.tag = qs.get('tag')!;
  for (const k of ['overdue', 'blocked', 'unassigned'] as const) if (qs.get(k) === '1' || qs.get(k) === 'true') f[k] = true;
  for (const k of ['due_from', 'due_to', 'created_from', 'created_to'] as const) {
    const val = qs.get(k);
    if (val) {
      if (!isDate(val)) throw badRequest(`${k} must be YYYY-MM-DD`);
      f[k] = val;
    }
  }
  const arch = qs.get('archived');
  if (arch) {
    if (!['exclude', 'only', 'include'].includes(arch)) throw badRequest('archived must be exclude, only or include');
    f.archived = arch as TicketFilters['archived'];
  }
  if (qs.get('limit')) f.limit = Math.min(Math.max(Number(qs.get('limit')) || 100, 1), 2000);
  if (qs.get('offset')) f.offset = Math.max(Number(qs.get('offset')) || 0, 0);
  return f;
}

// Offset pages must all describe the same database state. SQLite's own writes
// increment total_changes (including triggers/rank renumbering), external writes
// increment data_version, and a nonce distinguishes reopened/restored databases.
// No database state is retained: a changed token tells clients to restart paging.
const listConnectionIds = new WeakMap<Db, string>();
function listRevision(db: Db): string {
  let id = listConnectionIds.get(db);
  if (!id) {
    id = randomUUID();
    listConnectionIds.set(db, id);
  }
  const changes = get<{ n: number }>(db, 'SELECT total_changes() n')!.n;
  const version = get<{ data_version: number }>(db, 'PRAGMA data_version')!.data_version;
  return `${id}:${changes}:${version}`;
}

export function listTickets(ctx: Ctx, f: TicketFilters = {}): { tickets: Ticket[]; total: number; revision: string } {
  const where: string[] = [];
  const params: Param[] = [];
  const now = nowIso(ctx);
  const add = (sql: string, ...p: Param[]) => {
    where.push(sql);
    params.push(...p);
  };

  const archived = f.archived ?? (f.q ? 'include' : 'exclude');
  if (archived === 'exclude') add('t.archived = 0');
  if (archived === 'only') add('t.archived = 1');

  if (f.view === 'board') {
    add(`t.status <> 'cancelled'`);
    add(`(t.status <> 'done' OR t.completed_at >= ?)`, new Date(ctx.now().getTime() - 7 * 86_400_000).toISOString());
  }
  if (f.assignee?.length) {
    const ids = f.assignee.filter((a): a is number => a !== 'none');
    const parts: string[] = [];
    if (ids.length) {
      parts.push(`t.assigned_to IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids);
    }
    if (f.assignee.includes('none')) parts.push('t.assigned_to IS NULL');
    where.push(`(${parts.join(' OR ')})`);
  }
  if (f.status?.length) add(`t.status IN (${f.status.map(() => '?').join(',')})`, ...f.status);
  if (f.priority?.length) add(`t.priority IN (${f.priority.map(() => '?').join(',')})`, ...f.priority);
  if (f.job_type?.length) add(`t.job_type_id IN (${f.job_type.map(() => '?').join(',')})`, ...f.job_type);
  if (f.project?.length) {
    const ids = f.project.filter((p): p is number => p !== 'none');
    const parts: string[] = [];
    if (ids.length) {
      parts.push(`t.id IN (SELECT ticket_id FROM ticket_projects WHERE project_id IN (${ids.map(() => '?').join(',')}))`);
      params.push(...ids);
    }
    if (f.project.includes('none')) parts.push('t.id NOT IN (SELECT ticket_id FROM ticket_projects)');
    where.push(`(${parts.join(' OR ')})`);
  }
  if (f.tag) add(`t.id IN (SELECT tt.ticket_id FROM ticket_tags tt JOIN tags g ON g.id = tt.tag_id WHERE g.name = ?)`, f.tag);
  if (f.overdue) add(`t.due_at IS NOT NULL AND t.due_at < ? AND t.status NOT IN ('done','cancelled')`, now);
  if (f.blocked) add(`t.status IN ('waiting','blocked')`);
  if (f.unassigned) add(`t.assigned_to IS NULL AND t.status NOT IN ('done','cancelled')`);
  if (f.due_from) add('t.due_date >= ?', f.due_from);
  if (f.due_to) add('t.due_date <= ?', f.due_to);
  if (f.created_from) add('t.created_at >= ?', startOfLocalDayIso(f.created_from, ctx.tz));
  if (f.created_to) add('t.created_at < ?', startOfLocalDayIso(addDays(f.created_to, 1), ctx.tz));

  let order = 't.board_rank, t.id';
  const orderParams: Param[] = [];
  if (f.q) {
    const cond = searchCondition(f.q);
    if (cond) {
      add(cond.sql, ...cond.params);
      if (cond.ranked) {
        order = `${rankExpr()}, t.updated_at DESC, t.id`;
        orderParams.push(cond.params[0]);
      } else order = 't.updated_at DESC, t.id';
    }
  } else if (f.view !== 'board') {
    order = 't.updated_at DESC, t.id';
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = get<{ n: number }>(ctx.db, `SELECT COUNT(*) n FROM tickets t ${whereSql}`, ...params)!.n;
  const limit = f.limit ?? (f.view === 'board' ? 2000 : 100);
  const rows = all<Row>(
    ctx.db,
    `SELECT t.* FROM tickets t ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...params,
    ...orderParams,
    limit,
    f.offset ?? 0,
  );
  return { tickets: toTickets(ctx, rows), total, revision: listRevision(ctx.db) };
}

/** Tickets for a raw SQL condition (used by the operational views). */
export function ticketsWhere(ctx: Ctx, whereSql: string, order: string, ...params: Param[]): Ticket[] {
  return toTickets(ctx, all<Row>(ctx.db, `SELECT t.* FROM tickets t WHERE ${whereSql} ORDER BY ${order}`, ...params));
}
