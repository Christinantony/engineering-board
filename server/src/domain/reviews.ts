// Drawing review: the board's internal check of submitted drawings, followed
// by printing and physical signature. See DECISIONS.md #23–#27 and
// docs/USER-GUIDE.md "Drawing review".
//
// Per drawing:
//   awaiting ──pass──▶ passed ──handover──▶ handed_over ──signed──▶ signed
//      │  ▲                │                     │
//   return  resubmit ◀─────┴──── resubmit ◀───────┘   (new bytes need a new decision)
//      ▼  │
//   returned
//
// Board review is NOT official approval. The physically signed print is the
// approved record; signed scans attached as references are never written,
// replaced or deleted by anything here.

import {
  CLOSED_STATUSES,
  DRAWING_STATE_LABEL,
  OPEN_STATUSES,
  bookmarkSchema,
  canReview,
  decisionSchema,
  drawingEditSchema,
  drawingReviewersSchema,
  referenceAttachSchema,
  reviewCommentSchema,
  reviewSubmissionSchema,
  reviewTextSchema,
  type DrawingState,
  type ReviewAttempt,
  type ReviewComment,
  type ReviewDrawing,
  type ReviewEvent,
  type ReviewQueueRow,
  type ReviewReference,
  type ReviewWorkspace,
  type Ticket,
  type User,
  seesWholeBoard,
} from '@board/shared';
import { all, get, run, tx, type Param } from '../db/connection.ts';
import { HttpError, badRequest, bool, conflict, forbidden, notFound, nowIso, type Ctx } from '../lib/core.ts';
import { blobInUse, blobPath, hasBlob, removeBlob, verifyBlob, type StoreCtx } from './reviewStore.ts';
import { emitTicket, getTicket, logActivity, moveTicket } from './tickets.ts';
import { reindexTicket } from './search.ts';
import { getUser } from './users.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DrawingRow {
  id: number;
  ticket_id: number;
  identifier: string;
  kind: 'revision' | 'new';
  state: DrawingState;
  required: number;
  ref_reference_id: number | null;
  ref_page: number | null;
  current_attempt_id: number | null;
  passed_attempt_id: number | null;
  passed_by: number | null;
  passed_at: string | null;
  handover_by: number | null;
  handover_at: string | null;
  signed_by: number | null;
  signed_at: string | null;
  cleanup: 'none' | 'pending' | 'done' | 'failed';
  cleanup_detail: string | null;
  version: number;
}

interface AttemptRow {
  id: number;
  drawing_id: number;
  number: number;
  submission_id: number;
  filename: string;
  sha256: string;
  notes: string;
  submitted_by: number | null;
  submitted_at: string;
  outcome: ReviewAttempt['outcome'];
  decided_by: number | null;
  decided_at: string | null;
  decision_note: string | null;
  file_removed_at: string | null;
}

const ACTIVE_TICKET = (status: string, archived: number) => !archived && OPEN_STATUSES.includes(status as never);

function ticketRow(ctx: Ctx, id: number) {
  const t = get<{ id: number; job_number: string; status: string; archived: number; file_location: string; assigned_to: number | null }>(
    ctx.db,
    'SELECT id, job_number, status, archived, file_location, assigned_to FROM tickets WHERE id = ?',
    id,
  );
  if (!t) throw notFound('Job');
  return t;
}

function drawingRow(ctx: Ctx, id: number): DrawingRow {
  const d = get<DrawingRow>(ctx.db, 'SELECT * FROM review_drawings WHERE id = ?', id);
  if (!d) throw notFound('Drawing');
  return d;
}

function attemptRow(ctx: Ctx, id: number | null): AttemptRow | undefined {
  return id == null ? undefined : get<AttemptRow>(ctx.db, 'SELECT * FROM review_attempts WHERE id = ?', id);
}

function event(ctx: Ctx, ticketId: number, userId: number | null, kind: string, detail: string | null, drawingId: number | null = null, attemptId: number | null = null) {
  run(
    ctx.db,
    'INSERT INTO review_events (ticket_id, drawing_id, attempt_id, user_id, at, kind, detail) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ticketId,
    drawingId,
    attemptId,
    userId,
    nowIso(ctx),
    kind,
    detail,
  );
}

function touchDrawing(ctx: Ctx, id: number, sets: Record<string, Param>) {
  const keys = Object.keys(sets);
  run(
    ctx.db,
    `UPDATE review_drawings SET ${keys.map((k) => `${k} = ?`).join(', ')}${keys.length ? ', ' : ''}updated_at = ?, version = version + 1 WHERE id = ?`,
    ...keys.map((k) => sets[k]),
    nowIso(ctx),
    id,
  );
}

function bumpTicket(ctx: Ctx, ticketId: number, actor: User) {
  run(ctx.db, 'UPDATE tickets SET updated_at = ? WHERE id = ?', nowIso(ctx), ticketId);
  emitTicket(ctx, ticketId, actor.id);
}

function requireEngineer(actor: User, what: string) {
  if (actor.role !== 'engineer' || !actor.active) throw forbidden(`Only engineers can ${what}.`);
}

function requireReviewer(actor: User) {
  if (!canReview(actor)) throw forbidden('Only the manager and reviewers can pass or return drawings in board review. Engineers cannot review drawings.');
}

// ---------------------------------------------------------------------------
// Who a drawing is handed to (decision #29)
// ---------------------------------------------------------------------------

export function drawingReviewers(ctx: Ctx, drawingId: number): number[] {
  return all<{ user_id: number }>(ctx.db, 'SELECT user_id FROM review_drawing_reviewers WHERE drawing_id = ? ORDER BY assigned_at, user_id', drawingId).map((r) => r.user_id);
}

/**
 * The drawings of a job that `viewer` may see. Engineers and the manager see
 * them all; a reviewer sees the ones handed to them, plus any they passed
 * (they still sign those, even if the engineer later changed the reviewers).
 */
export function visibleDrawingIds(ctx: Ctx, viewer: User, ticketId: number): number[] | 'all' {
  if (seesWholeBoard(viewer)) return 'all';
  return all<{ id: number }>(
    ctx.db,
    `SELECT d.id FROM review_drawings d
     WHERE d.ticket_id = ? AND (d.passed_by = ? OR EXISTS (SELECT 1 FROM review_drawing_reviewers r WHERE r.drawing_id = d.id AND r.user_id = ?))
     ORDER BY d.id`,
    ticketId,
    viewer.id,
    viewer.id,
  ).map((r) => r.id);
}

/** A reviewer may act on a drawing only if it is handed to them (the manager on any). */
function canSeeDrawing(ctx: Ctx, viewer: User, d: Pick<DrawingRow, 'id' | 'passed_by'>): boolean {
  if (seesWholeBoard(viewer)) return true;
  return d.passed_by === viewer.id || !!get(ctx.db, 'SELECT 1 FROM review_drawing_reviewers WHERE drawing_id = ? AND user_id = ?', d.id, viewer.id);
}

/** 404 rather than 403, so a reviewer can't probe which jobs or drawings exist. */
function requireSeeDrawing(ctx: Ctx, viewer: User, d: DrawingRow) {
  if (!canSeeDrawing(ctx, viewer, d)) throw notFound('Drawing');
}

/** Throws 404 unless `viewer` may open this job's review (a reviewer: at least one drawing handed to them). */
export function requireReviewAccess(ctx: Ctx, viewer: User, ticketId: number) {
  ticketRow(ctx, ticketId);
  const ids = visibleDrawingIds(ctx, viewer, ticketId);
  if (ids !== 'all' && !ids.length) throw notFound('Job');
}

/** Whether `viewer` may download the stored PDF `sha` (a reviewer: only files of drawings handed to them, and their jobs' signed references). */
export function canSeeFile(ctx: Ctx, viewer: User, sha: string): boolean {
  if (seesWholeBoard(viewer)) return true;
  const mine = `(d.passed_by = ? OR EXISTS (SELECT 1 FROM review_drawing_reviewers r WHERE r.drawing_id = d.id AND r.user_id = ?))`;
  return (
    !!get(ctx.db, `SELECT 1 FROM review_attempts a JOIN review_drawings d ON d.id = a.drawing_id WHERE a.sha256 = ? AND ${mine} LIMIT 1`, sha, viewer.id, viewer.id) ||
    !!get(
      ctx.db,
      `SELECT 1 FROM review_references f JOIN review_drawings d ON d.ticket_id = f.ticket_id WHERE f.sha256 = ? AND ${mine} LIMIT 1`,
      sha,
      viewer.id,
      viewer.id,
    )
  );
}

/** The ids of jobs with at least one drawing handed to this reviewer. */
export function reviewerTicketIds(ctx: Ctx, viewer: User): Set<number> {
  return new Set(
    all<{ ticket_id: number }>(
      ctx.db,
      `SELECT DISTINCT d.ticket_id FROM review_drawings d
       WHERE d.passed_by = ? OR EXISTS (SELECT 1 FROM review_drawing_reviewers r WHERE r.drawing_id = d.id AND r.user_id = ?)`,
      viewer.id,
      viewer.id,
    ).map((r) => r.ticket_id),
  );
}

/** Check a list of reviewer ids: active manager or reviewers, not the person handing it over. */
function checkReviewers(ctx: Ctx, actor: User, ids: number[], identifier: string): number[] {
  const unique = [...new Set(ids)];
  if (!unique.length) throw badRequest(`Choose at least one reviewer for ${identifier}.`);
  for (const id of unique) {
    const u = getUser(ctx, id);
    if (!u || !canReview(u)) throw badRequest(`${u?.name ?? `User #${id}`} is not an active reviewer, so ${identifier} can't be handed to them.`);
    if (u.id === actor.id) throw badRequest(`You can't hand ${identifier} to yourself for review.`);
  }
  return unique;
}

/** Replace a drawing's reviewers. Returns true when the list changed. */
function assignReviewers(ctx: Ctx, actor: User, d: Pick<DrawingRow, 'id' | 'ticket_id' | 'identifier'>, ids: number[]): boolean {
  const before = drawingReviewers(ctx, d.id);
  const same = before.length === ids.length && ids.every((id) => before.includes(id));
  if (same) return false;
  const now = nowIso(ctx);
  run(ctx.db, 'DELETE FROM review_drawing_reviewers WHERE drawing_id = ?', d.id);
  for (const id of ids) run(ctx.db, 'INSERT INTO review_drawing_reviewers (drawing_id, user_id, assigned_by, assigned_at) VALUES (?, ?, ?, ?)', d.id, id, actor.id, now);
  const names = ids.map((id) => userName(ctx, id)).join(', ');
  event(ctx, d.ticket_id, actor.id, 'reviewers', `Handed to ${names}`, d.id);
  // one activity row per reviewer newly handed this drawing: their notification
  for (const id of ids.filter((x) => !before.includes(x)))
    logActivity(ctx, d.ticket_id, actor.id, 'review_assigned', String(d.id), userName(ctx, id), d.identifier);
  return true;
}

/** A job as a reviewer sees it: the job number and title, nothing else (decision #29). */
function reviewerTicket(t: Ticket): Ticket {
  return {
    ...t,
    description: '',
    priority: 'normal' as Ticket['priority'],
    assigned_to: null,
    created_by: null,
    requester: '',
    job_type_id: null,
    project_id: null,
    estimate_minutes: null,
    actual_minutes: null,
    due_date: null,
    due_time: null,
    due_at: null,
    reference: '',
    file_location: '',
    notes: '',
    waiting_for: '',
    parent_job_id: null,
    board_rank: 0,
    my_rank: 0,
    claimed_at: null,
    started_at: null,
    completed_at: null,
    tags: [],
    overdue: false,
    due_today: false,
  };
}

const userName = (ctx: Ctx, id: number | null) => (id == null ? 'someone' : getUser(ctx, id)?.name ?? `user #${id}`);

/** "2 Oct 2026" in the board's time zone. */
export function localDay(ctx: Ctx, iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: ctx.tz, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
}

const stem = (filename: string) => filename.replace(/^.*[\\/]/, '').replace(/\.pdf$/i, '').trim();

function fileRow(ctx: StoreCtx, sha: string) {
  const f = get<{ sha256: string; pages: number; removed_at: string | null; protected: number }>(
    ctx.db,
    'SELECT sha256, pages, removed_at, protected FROM review_files WHERE sha256 = ?',
    sha,
  );
  if (!f || f.removed_at || !hasBlob(ctx, sha))
    throw new HttpError(409, 'upload_missing', 'One of the files has not finished uploading (or was removed). Attach it again, then submit.');
  return f;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function signaturesPending(ctx: Ctx, ticketId: number): number {
  return get<{ n: number }>(ctx.db, `SELECT COUNT(*) n FROM review_drawings WHERE ticket_id = ? AND required = 1 AND state <> 'signed'`, ticketId)!.n;
}

export function syncState(ctx: Ctx, ticketId: number, folder: string) {
  const s = get<{ state: ReviewWorkspace['sync']['state']; detail: string | null; updated_at: string }>(
    ctx.db,
    'SELECT state, detail, updated_at FROM review_sync WHERE ticket_id = ?',
    ticketId,
  );
  return { state: s?.state ?? (folder.trim() ? 'pending' : 'no_folder'), detail: s?.detail ?? null, updated_at: s?.updated_at ?? null, folder };
}

/**
 * The review workspace of a job. Pass `viewer` to get it as that person sees
 * it: a reviewer gets only the drawings handed to them and the job's number
 * and title (decision #29).
 */
export function workspace(ctx: StoreCtx, ticketId: number, viewer?: User): ReviewWorkspace {
  const full = getTicket(ctx, ticketId);
  const only = viewer ? visibleDrawingIds(ctx, viewer, ticketId) : 'all';
  const shown = (drawingId: number | null) => only === 'all' || (drawingId != null && only.includes(drawingId));
  const ticket = only === 'all' ? full : reviewerTicket(full);
  const references = all<Omit<ReviewReference, 'available'>>(
    ctx.db,
    'SELECT id, filename, sha256, pages, attached_by, attached_at FROM review_references WHERE ticket_id = ? ORDER BY id',
    ticketId,
  ).map((r) => ({ ...r, available: hasBlob(ctx, r.sha256) }));
  const drawings = all<DrawingRow>(ctx.db, 'SELECT * FROM review_drawings WHERE ticket_id = ? ORDER BY id', ticketId).filter((d) => shown(d.id));
  const assigned = all<{ drawing_id: number; user_id: number }>(
    ctx.db,
    `SELECT r.drawing_id, r.user_id FROM review_drawing_reviewers r JOIN review_drawings d ON d.id = r.drawing_id WHERE d.ticket_id = ? ORDER BY r.assigned_at, r.user_id`,
    ticketId,
  );
  const attempts = all<AttemptRow & { submission_number: number }>(
    ctx.db,
    `SELECT a.*, s.number AS submission_number FROM review_attempts a
     JOIN review_drawings d ON d.id = a.drawing_id
     JOIN review_submissions s ON s.id = a.submission_id
     WHERE d.ticket_id = ? ORDER BY a.drawing_id, a.number`,
    ticketId,
  );
  const comments = all<ReviewComment>(
    ctx.db,
    `SELECT c.* FROM review_comments c JOIN review_drawings d ON d.id = c.drawing_id WHERE d.ticket_id = ? ORDER BY c.id`,
    ticketId,
  );
  const out: ReviewDrawing[] = drawings.map((d) => {
    const cs = comments.filter((c) => c.drawing_id === d.id);
    return {
      id: d.id,
      identifier: d.identifier,
      kind: d.kind,
      state: d.state,
      required: bool(d.required),
      ref_reference_id: d.ref_reference_id,
      ref_page: d.ref_page,
      current_attempt_id: d.current_attempt_id,
      passed_attempt_id: d.passed_attempt_id,
      passed_by: d.passed_by,
      passed_at: d.passed_at,
      handover_by: d.handover_by,
      handover_at: d.handover_at,
      signed_by: d.signed_by,
      signed_at: d.signed_at,
      cleanup: d.cleanup,
      cleanup_detail: d.cleanup_detail,
      version: d.version,
      reviewers: assigned.filter((r) => r.drawing_id === d.id).map((r) => r.user_id),
      attempts: attempts
        .filter((a) => a.drawing_id === d.id)
        .map((a) => ({
          id: a.id,
          number: a.number,
          submission_number: a.submission_number,
          filename: a.filename,
          sha256: a.sha256,
          notes: a.notes,
          submitted_by: a.submitted_by,
          submitted_at: a.submitted_at,
          outcome: a.outcome,
          decided_by: a.decided_by,
          decided_at: a.decided_at,
          decision_note: a.decision_note,
          file_removed_at: a.file_removed_at,
          available: !a.file_removed_at && hasBlob(ctx, a.sha256),
        })),
      comments: cs,
      open_comments: cs.filter((c) => !c.resolved_at).length,
    };
  });
  const events = all<ReviewEvent>(
    ctx.db,
    'SELECT id, drawing_id, attempt_id, user_id, at, kind, detail FROM review_events WHERE ticket_id = ? ORDER BY id',
    ticketId,
  ).filter((e) => e.drawing_id == null || shown(e.drawing_id));
  const submissions = get<{ n: number }>(ctx.db, 'SELECT COUNT(*) n FROM review_submissions WHERE ticket_id = ?', ticketId)!.n;
  return {
    ticket,
    submissions,
    references,
    drawings: out,
    events,
    // a reviewer doesn't see the job's File location (or where the copies go)
    sync: only === 'all' ? syncState(ctx, ticketId, full.file_location) : { state: 'ok', detail: null, updated_at: null, folder: '' },
    signatures_pending: only === 'all' ? signaturesPending(ctx, ticketId) : out.filter((d) => d.required && d.state !== 'signed').length,
  };
}

export type QueueTab = 'awaiting' | 'returned' | 'signature' | 'done' | 'all';

/** The review queue: one row per job that has drawings in board review. */
export function reviewQueue(ctx: Ctx, me: User, tab: QueueTab, q = '') {
  // A reviewer's queue holds only the drawings handed to them (decision #29).
  const whole = seesWholeBoard(me);
  const mine = (alias: string) =>
    whole ? '1' : `(${alias}.passed_by = ${Number(me.id)} OR EXISTS (SELECT 1 FROM review_drawing_reviewers rr WHERE rr.drawing_id = ${alias}.id AND rr.user_id = ${Number(me.id)}))`;
  const rows = all<ReviewQueueRow & { status: string; archived: number }>(
    ctx.db,
    `SELECT t.id AS ticket_id, t.job_number, t.title, ${whole ? 't.file_location' : "''"} AS folder, t.status, t.archived,
       ${whole ? '(SELECT p.name FROM ticket_projects tp JOIN projects p ON p.id = tp.project_id WHERE tp.ticket_id = t.id)' : 'NULL'} AS project,
       (SELECT COUNT(*) FROM review_submissions s WHERE s.ticket_id = t.id) AS submissions,
       (SELECT s.submitted_by FROM review_submissions s WHERE s.ticket_id = t.id ORDER BY s.id DESC LIMIT 1) AS submitted_by,
       (SELECT s.submitted_at FROM review_submissions s WHERE s.ticket_id = t.id ORDER BY s.id DESC LIMIT 1) AS submitted_at,
       COUNT(d.id) AS drawings,
       SUM(d.kind = 'revision') AS revised,
       SUM(d.kind = 'new') AS new_count,
       SUM(d.state = 'awaiting') AS awaiting,
       SUM(d.state = 'returned') AS returned,
       SUM(d.state = 'passed') AS passed,
       SUM(d.state = 'handed_over') AS handed_over,
       SUM(d.state = 'signed') AS signed,
       (SELECT COUNT(*) FROM review_comments c JOIN review_drawings d2 ON d2.id = c.drawing_id
          WHERE d2.ticket_id = t.id AND c.resolved_at IS NULL AND d2.state <> 'withdrawn' AND ${mine('d2')}) AS open_comments,
       (SELECT group_concat(DISTINCT d3.passed_by) FROM review_drawings d3 WHERE d3.ticket_id = t.id AND d3.state = 'handed_over' AND ${mine('d3')}) AS signers_csv
     FROM tickets t JOIN review_drawings d ON d.ticket_id = t.id AND d.state <> 'withdrawn' AND ${mine('d')}
     GROUP BY t.id
     ORDER BY submitted_at DESC`,
  ) as (ReviewQueueRow & { status: string; archived: number; signers_csv: string | null })[];
  const term = q.trim().toLowerCase();
  const matchesTerm = (r: ReviewQueueRow) => {
    if (!term) return true;
    if (`${r.job_number} ${r.title} ${r.folder} ${r.project ?? ''}`.toLowerCase().includes(term)) return true;
    return !!get(
      ctx.db,
      `SELECT 1 FROM review_drawings d WHERE d.ticket_id = ? AND d.identifier LIKE ? ESCAPE '\\' AND ${mine('d')}`,
      r.ticket_id,
      `%${term.replace(/[\\%_]/g, '\\$&')}%`,
    );
  };
  const clean = rows.map(({ signers_csv, ...r }) => ({
    ...r,
    signers: (signers_csv ?? '').split(',').filter(Boolean).map(Number),
  }));
  const inTab = (r: (typeof clean)[number]) => {
    switch (tab) {
      case 'awaiting':
        return r.awaiting > 0;
      case 'returned':
        return r.returned > 0;
      case 'signature':
        return r.passed + r.handed_over > 0;
      case 'done':
        return r.signed > 0 && r.awaiting + r.returned + r.passed + r.handed_over === 0;
      default:
        return true;
    }
  };
  const monthStart = new Date(ctx.now().getTime());
  const ym = new Intl.DateTimeFormat('en-CA', { timeZone: ctx.tz, year: 'numeric', month: '2-digit' }).format(monthStart);
  const passedThisMonth = all<{ passed_at: string }>(ctx.db, `SELECT passed_at FROM review_drawings WHERE passed_at IS NOT NULL${whole ? '' : ` AND passed_by = ${Number(me.id)}`}`).filter(
    (r) => new Intl.DateTimeFormat('en-CA', { timeZone: ctx.tz, year: 'numeric', month: '2-digit' }).format(new Date(r.passed_at)) === ym,
  ).length;
  const counts = {
    awaiting: clean.filter((r) => r.awaiting > 0).length,
    returned: clean.filter((r) => r.returned > 0).length,
    signature: clean.filter((r) => r.passed + r.handed_over > 0).length,
    done: clean.filter((r) => r.signed > 0 && r.awaiting + r.returned + r.passed + r.handed_over === 0).length,
    all: clean.length,
    passed_this_month: passedThisMonth,
    /** Drawings handed over to me that I passed and still need to sign. */
    to_sign_mine: get<{ n: number }>(ctx.db, `SELECT COUNT(*) n FROM review_drawings WHERE state = 'handed_over' AND passed_by = ?`, me.id)!.n,
  };
  return { rows: clean.filter((r) => inTab(r) && matchesTerm(r)), counts };
}

// ---------------------------------------------------------------------------
// References (signed scans)
// ---------------------------------------------------------------------------

function attachReference(ctx: StoreCtx, actor: User, ticketId: number, sha: string, filename: string): number {
  fileRow(ctx, sha);
  const existing = get<{ id: number }>(ctx.db, 'SELECT id FROM review_references WHERE ticket_id = ? AND sha256 = ?', ticketId, sha);
  if (existing) return existing.id;
  const f = get<{ pages: number }>(ctx.db, 'SELECT pages FROM review_files WHERE sha256 = ?', sha)!;
  // From here on this file is protected: no clean-up can ever remove it.
  run(ctx.db, 'UPDATE review_files SET protected = 1 WHERE sha256 = ?', sha);
  const res = run(
    ctx.db,
    'INSERT INTO review_references (ticket_id, filename, sha256, pages, attached_by, attached_at) VALUES (?, ?, ?, ?, ?, ?)',
    ticketId,
    filename,
    sha,
    f.pages,
    actor.id,
    nowIso(ctx),
  );
  event(ctx, ticketId, actor.id, 'reference_attached', `${filename} (${f.pages} page${f.pages === 1 ? '' : 's'})`);
  return Number(res.lastInsertRowid);
}

export function addReference(ctx: StoreCtx, actor: User, ticketId: number, input: unknown): ReviewWorkspace {
  const data = referenceAttachSchema(input);
  requireEngineer(actor, 'attach signed reference scans');
  tx(ctx.db, () => {
    const t = ticketRow(ctx, ticketId);
    if (!ACTIVE_TICKET(t.status, t.archived)) throw conflict(`${t.job_number} is closed.`);
    attachReference(ctx, actor, ticketId, data.sha256, data.filename);
    bumpTicket(ctx, ticketId, actor);
  });
  return workspace(ctx, ticketId, actor);
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

export function submit(ctx: StoreCtx, actor: User, ticketId: number, input: unknown): ReviewWorkspace {
  const data = reviewSubmissionSchema(input);
  requireEngineer(actor, 'submit drawings for board review');
  if (!data.drawings.length && !data.references.length) throw badRequest('Attach at least one drawing to submit.');
  const touched: number[] = [];
  tx(ctx.db, () => {
    const t = ticketRow(ctx, ticketId);
    if (!ACTIVE_TICKET(t.status, t.archived)) throw conflict(`${t.job_number} is ${t.archived ? 'archived' : 'closed'}; reopen it before submitting drawings.`);

    const refIds = new Map<string, number>();
    for (const r of data.references) refIds.set(r.sha256, attachReference(ctx, actor, ticketId, r.sha256, r.filename));
    const refBySha = (sha: string) =>
      refIds.get(sha) ?? get<{ id: number }>(ctx.db, 'SELECT id FROM review_references WHERE ticket_id = ? AND sha256 = ?', ticketId, sha)?.id;
    const hasReference = !!get(ctx.db, 'SELECT 1 FROM review_references WHERE ticket_id = ?', ticketId);

    if (!data.drawings.length) {
      bumpTicket(ctx, ticketId, actor);
      return;
    }
    const seen = new Set<string>();
    const now = nowIso(ctx);
    const number = (get<{ n: number | null }>(ctx.db, 'SELECT MAX(number) n FROM review_submissions WHERE ticket_id = ?', ticketId)!.n ?? 0) + 1;
    const submissionId = Number(
      run(ctx.db, 'INSERT INTO review_submissions (ticket_id, number, submitted_by, submitted_at) VALUES (?, ?, ?, ?)', ticketId, number, actor.id, now)
        .lastInsertRowid,
    );
    const summary: string[] = [];
    for (const d of data.drawings) {
      const identifier = (d.identifier ?? stem(d.filename)).trim();
      if (!identifier) throw badRequest(`"${d.filename}" needs a drawing number.`);
      if (seen.has(identifier.toLowerCase())) throw badRequest(`${identifier} is listed twice in this submission.`);
      seen.add(identifier.toLowerCase());
      const f = fileRow(ctx, d.sha256);
      if (f.pages !== 1)
        throw new HttpError(
          400,
          'not_single_page',
          `${d.filename} has ${f.pages} pages. Each drawing submitted for board review must be a single-page PDF: export each sheet on its own.`,
        );
      if (!verifyBlob(ctx, d.sha256)) throw new HttpError(409, 'upload_missing', `${d.filename} did not upload completely. Attach it again.`);
      if (f.protected) throw badRequest(`${d.filename} is a signed reference scan on this board; it can't also be submitted as a drawing.`);

      let drawing = get<DrawingRow>(ctx.db, 'SELECT * FROM review_drawings WHERE ticket_id = ? AND identifier = ?', ticketId, identifier);
      if (drawing) {
        if (drawing.state === 'signed') throw conflict(`${identifier} is already physically signed. A further change needs a new job.`);
        const cur = attemptRow(ctx, drawing.current_attempt_id);
        if (cur && cur.sha256 === d.sha256 && drawing.state !== 'withdrawn')
          throw conflict(`${d.filename} is the same file as attempt ${cur.number} of ${identifier}. Export the corrected drawing, then attach it again.`);
        if (cur && cur.outcome == null) {
          run(ctx.db, `UPDATE review_attempts SET outcome = 'superseded', decided_at = ? WHERE id = ?`, now, cur.id);
          event(ctx, ticketId, actor.id, 'superseded', `Attempt ${cur.number} replaced before a decision`, drawing.id, cur.id);
        }
        if (drawing.state === 'passed' || drawing.state === 'handed_over')
          event(ctx, ticketId, actor.id, 'repassed_needed', `${identifier} changed after passing board review; it needs a new decision and a new print`, drawing.id);
      } else {
        if (d.kind === 'revision' && !hasReference)
          throw badRequest(`${identifier} is a revision: attach the signed scan of the previous revision as a reference first (or mark it as a new drawing).`);
        const id = Number(
          run(
            ctx.db,
            `INSERT INTO review_drawings (ticket_id, identifier, kind, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
            ticketId,
            identifier,
            d.kind,
            actor.id,
            now,
            now,
          ).lastInsertRowid,
        );
        drawing = drawingRow(ctx, id);
      }
      const attemptNo = (get<{ n: number | null }>(ctx.db, 'SELECT MAX(number) n FROM review_attempts WHERE drawing_id = ?', drawing.id)!.n ?? 0) + 1;
      const attemptId = Number(
        run(
          ctx.db,
          `INSERT INTO review_attempts (drawing_id, submission_id, number, filename, sha256, notes, submitted_by, submitted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          drawing.id,
          submissionId,
          attemptNo,
          d.filename,
          d.sha256,
          d.notes,
          actor.id,
          now,
        ).lastInsertRowid,
      );
      const sets: Record<string, Param> = {
        state: 'awaiting',
        required: 1,
        current_attempt_id: attemptId,
        passed_attempt_id: null,
        passed_by: null,
        passed_at: null,
        handover_by: null,
        handover_at: null,
        cleanup: 'none',
        cleanup_detail: null,
      };
      if (d.ref_sha256 && d.ref_page != null) {
        const refId = refBySha(d.ref_sha256);
        if (!refId) throw badRequest(`The reference chosen for ${identifier} is not attached to this job.`);
        const pages = get<{ pages: number }>(ctx.db, 'SELECT pages FROM review_references WHERE id = ?', refId)!.pages;
        if (d.ref_page > pages) throw badRequest(`The reference has ${pages} pages, so page ${d.ref_page} doesn't exist.`);
        sets.ref_reference_id = refId;
        sets.ref_page = d.ref_page;
      }
      touchDrawing(ctx, drawing.id, sets);
      event(ctx, ticketId, actor.id, 'submitted', d.notes, drawing.id, attemptId);
      // hand it to its reviewers: required for a drawing new to the job; a resubmission keeps its own unless changed
      if (d.reviewer_ids) assignReviewers(ctx, actor, drawing, checkReviewers(ctx, actor, d.reviewer_ids, identifier));
      else if (!drawingReviewers(ctx, drawing.id).length) throw badRequest(`Choose at least one reviewer for ${identifier}.`);
      summary.push(attemptNo > 1 ? `${identifier} (attempt ${attemptNo})` : `${identifier} (${d.kind === 'new' ? 'new' : 'revision'})`);
      touched.push(drawing.id);
    }
    logActivity(ctx, ticketId, actor.id, 'review_submitted', null, String(number), summary.join(', '));
    // put the job in the Review column (assigning the submitter if nobody has it)
    if (t.status !== 'review') moveTicket(ctx, actor, ticketId, { status: 'review', from_status: t.status as never });
    reindexTicket(ctx, ticketId);
    bumpTicket(ctx, ticketId, actor);
  });
  return workspace(ctx, ticketId, actor);
}

// ---------------------------------------------------------------------------
// Reference page bookmark (a manual choice, never matched automatically)
// ---------------------------------------------------------------------------

export function setBookmark(ctx: StoreCtx, actor: User, drawingId: number, input: unknown): ReviewWorkspace {
  const data = bookmarkSchema(input);
  if (actor.role !== 'engineer' && !canReview(actor)) throw forbidden('You cannot change this drawing.');
  const d = drawingRow(ctx, drawingId);
  requireSeeDrawing(ctx, actor, d);
  tx(ctx.db, () => {
    if (data.reference_id == null || data.page == null) {
      touchDrawing(ctx, d.id, { ref_reference_id: null, ref_page: null });
      event(ctx, d.ticket_id, actor.id, 'bookmark', 'Reference page cleared', d.id);
    } else {
      const ref = get<{ id: number; ticket_id: number; pages: number; filename: string }>(
        ctx.db,
        'SELECT id, ticket_id, pages, filename FROM review_references WHERE id = ?',
        data.reference_id,
      );
      if (!ref || ref.ticket_id !== d.ticket_id) throw badRequest('That reference is not attached to this job.');
      if (data.page > ref.pages) throw badRequest(`${ref.filename} has ${ref.pages} pages, so page ${data.page} doesn't exist.`);
      touchDrawing(ctx, d.id, { ref_reference_id: ref.id, ref_page: data.page });
      event(ctx, d.ticket_id, actor.id, 'bookmark', `Reference page ${data.page} of ${ref.filename}`, d.id);
    }
    bumpTicket(ctx, d.ticket_id, actor);
  });
  return workspace(ctx, d.ticket_id, actor);
}

// ---------------------------------------------------------------------------
// Board review decision
// ---------------------------------------------------------------------------

export function decide(ctx: StoreCtx, actor: User, drawingId: number, input: unknown): { workspace: ReviewWorkspace; cleanup: boolean } {
  const data = decisionSchema(input);
  requireReviewer(actor);
  const d = drawingRow(ctx, drawingId);
  requireSeeDrawing(ctx, actor, d);
  tx(ctx.db, () => {
    const t = ticketRow(ctx, d.ticket_id);
    if (t.archived) throw conflict(`${t.job_number} is archived.`);
    const a = attemptRow(ctx, data.attempt_id);
    if (!a || a.drawing_id !== d.id) throw badRequest('That attempt does not belong to this drawing.');
    if (d.current_attempt_id !== a.id || a.outcome != null || d.state !== 'awaiting')
      throw conflict(`${d.identifier} attempt ${a.number} has already been ${a.outcome === 'superseded' ? 'replaced by a newer attempt' : a.outcome ?? 'decided'}. Your view has been refreshed.`);
    if (a.submitted_by === actor.id) throw forbidden('You submitted this drawing, so someone else must review it.');
    const open = get<{ n: number }>(ctx.db, 'SELECT COUNT(*) n FROM review_comments WHERE drawing_id = ? AND resolved_at IS NULL', d.id)!.n;
    const now = nowIso(ctx);
    const note = data.note.trim();
    if (data.outcome === 'passed') {
      if (open) throw new HttpError(409, 'open_comments', `Resolve the ${open === 1 ? 'open comment' : `${open} open comments`} on ${d.identifier} before passing it.`);
      run(ctx.db, `UPDATE review_attempts SET outcome = 'passed', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?`, actor.id, now, note || null, a.id);
      touchDrawing(ctx, d.id, { state: 'passed', passed_attempt_id: a.id, passed_by: actor.id, passed_at: now, cleanup: 'pending', cleanup_detail: null });
      event(ctx, d.ticket_id, actor.id, 'passed', note || null, d.id, a.id);
      logActivity(ctx, d.ticket_id, actor.id, 'review_passed', null, d.identifier, note || null);
    } else {
      if (!note && !open) throw badRequest(`Say what needs correcting on ${d.identifier} (add a note or a comment).`);
      run(ctx.db, `UPDATE review_attempts SET outcome = 'returned', decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?`, actor.id, now, note || null, a.id);
      touchDrawing(ctx, d.id, { state: 'returned' });
      event(ctx, d.ticket_id, actor.id, 'returned', note || null, d.id, a.id);
      logActivity(ctx, d.ticket_id, actor.id, 'review_returned', null, d.identifier, note || `${open} open comment${open === 1 ? '' : 's'}`);
    }
    bumpTicket(ctx, d.ticket_id, actor);
  });
  return { workspace: workspace(ctx, d.ticket_id, actor), cleanup: data.outcome === 'passed' };
}

// ---------------------------------------------------------------------------
// Print handover and physical signature
// ---------------------------------------------------------------------------

export function handover(ctx: StoreCtx, actor: User, drawingId: number): ReviewWorkspace {
  requireEngineer(actor, 'mark a print as handed over');
  const d = drawingRow(ctx, drawingId);
  tx(ctx.db, () => {
    if (d.state === 'handed_over')
      throw conflict(`${d.identifier} was already marked handed over on ${localDay(ctx, d.handover_at!)}. ${userName(ctx, d.passed_by)} has been reminded once.`);
    if (d.state !== 'passed') throw conflict(`${d.identifier} is ${DRAWING_STATE_LABEL[d.state].toLowerCase()}; only a drawing that passed board review can be handed over for signature.`);
    const a = attemptRow(ctx, d.passed_attempt_id)!;
    const now = nowIso(ctx);
    touchDrawing(ctx, d.id, { state: 'handed_over', handover_by: actor.id, handover_at: now });
    const reviewer = getUser(ctx, d.passed_by!);
    const reminder = `${a.filename} was approved by you in the board on ${localDay(ctx, d.passed_at!)}. The printed drawing has now been handed over for your signature.`;
    event(ctx, d.ticket_id, actor.id, 'handover', `Printed attempt ${a.number} handed to ${reviewer?.name ?? 'the reviewer'}`, d.id, a.id);
    // One in-board reminder for the reviewer who passed it (decision #13: derived from history).
    logActivity(ctx, d.ticket_id, actor.id, 'review_handover', String(d.id), reviewer?.name ?? null, reminder);
    bumpTicket(ctx, d.ticket_id, actor);
  });
  return workspace(ctx, d.ticket_id, actor);
}

export function markSigned(ctx: StoreCtx, actor: User, drawingId: number): ReviewWorkspace {
  if (actor.role !== 'engineer' && !canReview(actor)) throw forbidden('You cannot record signatures.');
  const d = drawingRow(ctx, drawingId);
  requireSeeDrawing(ctx, actor, d);
  tx(ctx.db, () => {
    if (d.state === 'signed') throw conflict(`${d.identifier} was already recorded as signed on ${localDay(ctx, d.signed_at!)}.`);
    if (d.state === 'passed') throw conflict(`Mark ${d.identifier} as handed over for signature first.`);
    if (d.state !== 'handed_over') throw conflict(`${d.identifier} is ${DRAWING_STATE_LABEL[d.state].toLowerCase()}; it can't be signed yet.`);
    const now = nowIso(ctx);
    touchDrawing(ctx, d.id, { state: 'signed', signed_by: actor.id, signed_at: now });
    event(ctx, d.ticket_id, actor.id, 'signed', null, d.id, d.passed_attempt_id);
    logActivity(ctx, d.ticket_id, actor.id, 'review_signed', null, d.identifier, null);
    // The job is Done once every required drawing carries its physical signature.
    const t = ticketRow(ctx, d.ticket_id);
    if (signaturesPending(ctx, d.ticket_id) === 0 && !CLOSED_STATUSES.includes(t.status as never) && !t.archived) {
      moveTicket(ctx, actor, d.ticket_id, { status: 'done', from_status: t.status as never });
    }
    bumpTicket(ctx, d.ticket_id, actor);
  });
  return workspace(ctx, d.ticket_id, actor);
}

// ---------------------------------------------------------------------------
// Corrections: withdraw a drawing, fix its number
// ---------------------------------------------------------------------------

export function withdraw(ctx: StoreCtx, actor: User, drawingId: number, input: unknown): ReviewWorkspace {
  const { body } = reviewTextSchema(input);
  requireEngineer(actor, 'withdraw drawings');
  const d = drawingRow(ctx, drawingId);
  tx(ctx.db, () => {
    if (!['awaiting', 'returned'].includes(d.state)) throw conflict(`${d.identifier} is ${DRAWING_STATE_LABEL[d.state].toLowerCase()} and can't be withdrawn.`);
    const cur = attemptRow(ctx, d.current_attempt_id);
    if (cur && cur.outcome == null) run(ctx.db, `UPDATE review_attempts SET outcome = 'superseded', decided_at = ? WHERE id = ?`, nowIso(ctx), cur.id);
    touchDrawing(ctx, d.id, { state: 'withdrawn', required: 0 });
    event(ctx, d.ticket_id, actor.id, 'withdrawn', body.trim() || null, d.id);
    bumpTicket(ctx, d.ticket_id, actor);
  });
  return workspace(ctx, d.ticket_id, actor);
}

export function renameDrawing(ctx: StoreCtx, actor: User, drawingId: number, input: unknown): ReviewWorkspace {
  const { identifier } = drawingEditSchema(input);
  requireEngineer(actor, 'correct drawing numbers');
  const d = drawingRow(ctx, drawingId);
  tx(ctx.db, () => {
    if (d.state === 'signed') throw conflict(`${d.identifier} is signed; its number can't change.`);
    if (identifier === d.identifier) return;
    if (get(ctx.db, 'SELECT 1 FROM review_drawings WHERE ticket_id = ? AND identifier = ? AND id <> ?', d.ticket_id, identifier, d.id))
      throw conflict(`${identifier} is already a drawing in this job.`);
    touchDrawing(ctx, d.id, { identifier });
    event(ctx, d.ticket_id, actor.id, 'renamed', `${d.identifier} → ${identifier}`, d.id);
    reindexTicket(ctx, d.ticket_id);
    bumpTicket(ctx, d.ticket_id, actor);
  });
  return workspace(ctx, d.ticket_id, actor);
}

/** An engineer changes who a drawing is handed to (someone on leave, a second check). */
export function setDrawingReviewers(ctx: StoreCtx, actor: User, drawingId: number, input: unknown): ReviewWorkspace {
  const { reviewer_ids } = drawingReviewersSchema(input);
  requireEngineer(actor, 'choose who reviews a drawing');
  const d = drawingRow(ctx, drawingId);
  tx(ctx.db, () => {
    if (d.state === 'signed' || d.state === 'withdrawn') throw conflict(`${d.identifier} is ${DRAWING_STATE_LABEL[d.state].toLowerCase()}; its reviewers can't change.`);
    if (assignReviewers(ctx, actor, d, checkReviewers(ctx, actor, reviewer_ids, d.identifier))) bumpTicket(ctx, d.ticket_id, actor);
  });
  return workspace(ctx, d.ticket_id, actor);
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export function addReviewComment(ctx: StoreCtx, actor: User, drawingId: number, input: unknown): ReviewWorkspace {
  const data = reviewCommentSchema(input);
  const d = drawingRow(ctx, drawingId);
  requireSeeDrawing(ctx, actor, d);
  tx(ctx.db, () => {
    if (d.state === 'signed' || d.state === 'withdrawn') throw conflict(`${d.identifier} is ${DRAWING_STATE_LABEL[d.state].toLowerCase()}; comments are closed.`);
    const attemptId = data.attempt_id ?? d.current_attempt_id;
    const a = attemptRow(ctx, attemptId ?? null);
    if (attemptId != null && (!a || a.drawing_id !== d.id)) throw badRequest('That attempt does not belong to this drawing.');
    const id = Number(
      run(ctx.db, 'INSERT INTO review_comments (drawing_id, attempt_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?)', d.id, attemptId ?? null, actor.id, data.body, nowIso(ctx))
        .lastInsertRowid,
    );
    event(ctx, d.ticket_id, actor.id, 'comment', data.body, d.id, attemptId ?? null);
    logActivity(ctx, d.ticket_id, actor.id, 'review_comment', String(id), d.identifier, data.body);
    bumpTicket(ctx, d.ticket_id, actor);
  });
  return workspace(ctx, d.ticket_id, actor);
}

function commentRow(ctx: Ctx, id: number) {
  const c = get<ReviewComment & { ticket_id: number; identifier: string }>(
    ctx.db,
    'SELECT c.*, d.ticket_id, d.identifier FROM review_comments c JOIN review_drawings d ON d.id = c.drawing_id WHERE c.id = ?',
    id,
  );
  if (!c) throw notFound('Comment');
  return c;
}

/** An engineer's correction response to a reviewer comment. */
export function respondToComment(ctx: StoreCtx, actor: User, commentId: number, input: unknown): ReviewWorkspace {
  const { body } = reviewTextSchema(input);
  requireEngineer(actor, 'respond to review comments');
  if (!body.trim()) throw badRequest('Write a response.');
  const c = commentRow(ctx, commentId);
  tx(ctx.db, () => {
    run(ctx.db, 'UPDATE review_comments SET response = ?, response_by = ?, response_at = ? WHERE id = ?', body.trim(), actor.id, nowIso(ctx), c.id);
    event(ctx, c.ticket_id, actor.id, 'comment_response', body.trim(), c.drawing_id, c.attempt_id);
    bumpTicket(ctx, c.ticket_id, actor);
  });
  return workspace(ctx, c.ticket_id, actor);
}

export function resolveComment(ctx: StoreCtx, actor: User, commentId: number): ReviewWorkspace {
  const c = commentRow(ctx, commentId);
  requireSeeDrawing(ctx, actor, drawingRow(ctx, c.drawing_id));
  if (!canReview(actor) && c.user_id !== actor.id) throw forbidden('Only a reviewer or the person who wrote the comment can resolve it.');
  tx(ctx.db, () => {
    if (c.resolved_at) return;
    run(ctx.db, 'UPDATE review_comments SET resolved_by = ?, resolved_at = ? WHERE id = ?', actor.id, nowIso(ctx), c.id);
    event(ctx, c.ticket_id, actor.id, 'comment_resolved', c.body.length > 120 ? c.body.slice(0, 117) + '…' : c.body, c.drawing_id, c.attempt_id);
    bumpTicket(ctx, c.ticket_id, actor);
  });
  return workspace(ctx, c.ticket_id, actor);
}

// ---------------------------------------------------------------------------
// Clean-up of intermediate PDFs after a drawing passes (board storage)
// ---------------------------------------------------------------------------

/**
 * After a drawing passes: confirm the reviewed final is intact, then remove
 * the earlier attempts' PDFs that are no longer needed. The history keeps
 * every attempt; only the PDF bytes of intermediates go. Signed scans and the
 * reviewed final are never touched. Safe to run again (it is idempotent).
 */
export function cleanupDrawing(ctx: StoreCtx, drawingId: number): 'done' | 'failed' | 'skipped' {
  const d = get<DrawingRow>(ctx.db, 'SELECT * FROM review_drawings WHERE id = ?', drawingId);
  if (!d || d.cleanup !== 'pending' && d.cleanup !== 'failed') return 'skipped';
  if (!d.passed_attempt_id || !['passed', 'handed_over', 'signed'].includes(d.state)) return 'skipped';
  const final = attemptRow(ctx, d.passed_attempt_id)!;
  try {
    if (!verifyBlob(ctx, final.sha256)) throw new Error('the reviewed PDF could not be verified, so the earlier attempts were kept');
    const removed = tx(ctx.db, () => {
      const olds = all<AttemptRow>(
        ctx.db,
        'SELECT * FROM review_attempts WHERE drawing_id = ? AND id <> ? AND file_removed_at IS NULL',
        d.id,
        final.id,
      );
      const now = nowIso(ctx);
      for (const a of olds) run(ctx.db, 'UPDATE review_attempts SET file_removed_at = ? WHERE id = ?', now, a.id);
      return olds;
    });
    let deleted = 0;
    for (const sha of new Set(removed.map((a) => a.sha256))) {
      if (sha === final.sha256) continue;
      // a file that is also attached as a signed scan is protected: keep it
      if (get<{ protected: number }>(ctx.db, 'SELECT protected FROM review_files WHERE sha256 = ?', sha)?.protected) continue;
      if (removeBlob(ctx, sha)) deleted++;
    }
    tx(ctx.db, () => {
      run(ctx.db, `UPDATE review_drawings SET cleanup = 'done', cleanup_detail = NULL WHERE id = ?`, d.id);
      event(
        ctx,
        d.ticket_id,
        null,
        'cleanup_done',
        removed.length
          ? `Intermediate PDF${removed.length === 1 ? '' : 's'} of attempt${removed.length === 1 ? '' : 's'} ${removed.map((a) => a.number).join(', ')} removed after board review; the reviewed PDF (attempt ${final.number}) is kept`
          : `No intermediate PDFs to remove; the reviewed PDF (attempt ${final.number}) is kept`,
        d.id,
        final.id,
      );
      emitTicket(ctx, d.ticket_id, null);
    });
    void deleted;
    return 'done';
  } catch (e) {
    const msg = (e as Error).message;
    tx(ctx.db, () => {
      run(ctx.db, `UPDATE review_drawings SET cleanup = 'failed', cleanup_detail = ? WHERE id = ?`, msg, d.id);
      if (d.cleanup !== 'failed') event(ctx, d.ticket_id, null, 'cleanup_failed', msg, d.id, final.id);
      emitTicket(ctx, d.ticket_id, null);
    });
    return 'failed';
  }
}

/** Retry clean-ups that are pending or failed, and delete PDFs nothing needs any more. */
export function runPendingCleanups(ctx: StoreCtx): number {
  const ids = all<{ id: number }>(ctx.db, `SELECT id FROM review_drawings WHERE cleanup IN ('pending','failed')`).map((r) => r.id);
  let n = 0;
  for (const id of ids) if (cleanupDrawing(ctx, id) === 'done') n++;
  // files whose every attempt was removed but whose delete didn't finish
  for (const { sha256 } of all<{ sha256: string }>(
    ctx.db,
    `SELECT f.sha256 FROM review_files f WHERE f.protected = 0 AND f.removed_at IS NULL
       AND EXISTS (SELECT 1 FROM review_attempts a WHERE a.sha256 = f.sha256)`,
  ))
    if (!blobInUse(ctx, sha256)) removeBlob(ctx, sha256);
  return n;
}

/**
 * The stored file for a sha: a signed reference, a live attempt, or an upload
 * not yet submitted (the submit form previews it). Intermediate PDFs removed
 * after board review answer 410 with an explanation instead.
 */
export function servableBlob(ctx: StoreCtx, sha: string): { path: string; filename: string } {
  const file = get<{ removed_at: string | null }>(ctx.db, 'SELECT removed_at FROM review_files WHERE sha256 = ?', sha);
  if (!file) throw notFound('PDF');
  const ref = get<{ filename: string }>(ctx.db, 'SELECT filename FROM review_references WHERE sha256 = ? LIMIT 1', sha);
  const live = get<{ filename: string }>(ctx.db, 'SELECT filename FROM review_attempts WHERE sha256 = ? AND file_removed_at IS NULL LIMIT 1', sha);
  const anyAttempt = get<{ filename: string }>(ctx.db, 'SELECT filename FROM review_attempts WHERE sha256 = ? LIMIT 1', sha);
  if (!ref && !live && (anyAttempt || file.removed_at))
    throw new HttpError(410, 'removed', 'This intermediate PDF was removed after board review. Its notes, comments and decision are kept in the history.');
  if (!hasBlob(ctx, sha)) throw new HttpError(404, 'not_found', 'The PDF file is missing from the board storage. Restore a backup, or attach the file again.');
  return { path: blobPath(ctx, sha), filename: ref?.filename ?? live?.filename ?? 'upload.pdf' };
}
