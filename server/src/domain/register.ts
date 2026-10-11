// The drawing register (decision #35): every drawing number that has been
// through board review, across all jobs, with its latest signed revision and
// whatever is in review for it now. It is a read-only view over the review
// tables; nothing is stored twice.
//
// A drawing number is the same drawing whatever its case ("brk-023" and
// "BRK-023" are one entry); the spelling shown is the newest one used.

import { DRAWING_STATE_LABEL, type DrawingState } from '@board/shared';
import { all } from '../db/connection.ts';
import { badRequest, type Ctx } from '../lib/core.ts';
import { hasBlob, type StoreCtx } from './reviewStore.ts';

export interface RegisterRecord {
  drawing_id: number;
  identifier: string;
  revision: string | null;
  kind: 'revision' | 'new';
  state: DrawingState;
  state_label: string;
  ticket_id: number;
  job_number: string;
  title: string;
  job_status: string;
  archived: boolean;
  project_id: number | null;
  project: string | null;
  created_at: string;
  updated_at: string;
  attempts: number;
  passed_by: number | null;
  passed_at: string | null;
  handover_at: string | null;
  signed_by: number | null;
  signed_at: string | null;
  /** The PDF that passed board review (or the newest attempt while in review). */
  file: { filename: string; sha256: string; notes: string; available: boolean } | null;
}

export interface RegisterEntry {
  identifier: string;
  /** The newest signed record of this drawing number. */
  latest_signed: RegisterRecord | null;
  /** The newest record still going through review (not signed, not withdrawn). */
  in_review: RegisterRecord | null;
  projects: string[];
  records: number;
  signed_count: number;
  last_change: string;
}

export type RegisterFilter = 'all' | 'signed' | 'in_review' | 'never_signed';

interface Row {
  drawing_id: number;
  identifier: string;
  revision: string | null;
  kind: 'revision' | 'new';
  state: DrawingState;
  ticket_id: number;
  job_number: string;
  title: string;
  job_status: string;
  archived: number;
  project_id: number | null;
  project: string | null;
  created_at: string;
  updated_at: string;
  attempts: number;
  passed_by: number | null;
  passed_at: string | null;
  handover_at: string | null;
  signed_by: number | null;
  signed_at: string | null;
  filename: string | null;
  sha256: string | null;
  notes: string | null;
  file_removed_at: string | null;
}

function rows(ctx: Ctx, identifier?: string): Row[] {
  return all<Row>(
    ctx.db,
    `SELECT d.id AS drawing_id, d.identifier, d.revision, d.kind, d.state, d.ticket_id, t.job_number, t.title, t.status AS job_status, t.archived,
            p.id AS project_id, p.name AS project, d.created_at, d.updated_at,
            (SELECT COUNT(*) FROM review_attempts x WHERE x.drawing_id = d.id) AS attempts,
            d.passed_by, d.passed_at, d.handover_at, d.signed_by, d.signed_at,
            a.filename, a.sha256, a.notes, a.file_removed_at
     FROM review_drawings d
     JOIN tickets t ON t.id = d.ticket_id
     LEFT JOIN ticket_projects tp ON tp.ticket_id = t.id
     LEFT JOIN projects p ON p.id = tp.project_id
     LEFT JOIN review_attempts a ON a.id = COALESCE(d.passed_attempt_id, d.current_attempt_id)
     ${identifier ? 'WHERE d.identifier = ?' : ''}
     ORDER BY COALESCE(d.signed_at, d.updated_at) DESC, d.id DESC`,
    ...(identifier ? [identifier] : []),
  );
}

function record(ctx: StoreCtx, r: Row): RegisterRecord {
  return {
    drawing_id: r.drawing_id,
    identifier: r.identifier,
    revision: r.revision,
    kind: r.kind,
    state: r.state,
    state_label: DRAWING_STATE_LABEL[r.state] ?? r.state,
    ticket_id: r.ticket_id,
    job_number: r.job_number,
    title: r.title,
    job_status: r.job_status,
    archived: !!r.archived,
    project_id: r.project_id,
    project: r.project,
    created_at: r.created_at,
    updated_at: r.updated_at,
    attempts: r.attempts,
    passed_by: r.passed_by,
    passed_at: r.passed_at,
    handover_at: r.handover_at,
    signed_by: r.signed_by,
    signed_at: r.signed_at,
    file: r.sha256 ? { filename: r.filename!, sha256: r.sha256, notes: r.notes ?? '', available: !r.file_removed_at && hasBlob(ctx, r.sha256) } : null,
  };
}

const IN_REVIEW: DrawingState[] = ['awaiting', 'returned', 'passed', 'handed_over'];

/** Every drawing number, newest change first, optionally narrowed. */
export function drawingRegister(ctx: StoreCtx, opts: { q?: string; project?: number | null; filter?: RegisterFilter } = {}): { drawings: RegisterEntry[]; total: number } {
  const filter = opts.filter ?? 'all';
  if (!['all', 'signed', 'in_review', 'never_signed'].includes(filter)) throw badRequest('Unknown register filter');
  const groups = new Map<string, Row[]>();
  for (const r of rows(ctx)) {
    const k = r.identifier.toLowerCase();
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const term = (opts.q ?? '').trim().toLowerCase();
  const entries: RegisterEntry[] = [];
  for (const list of groups.values()) {
    // rows arrive newest first
    const live = list.filter((r) => r.state !== 'withdrawn');
    if (!live.length) continue;
    const signed = live.filter((r) => r.state === 'signed');
    const reviewing = live.find((r) => IN_REVIEW.includes(r.state));
    const newest = [...live].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    const entry: RegisterEntry = {
      identifier: newest.identifier,
      latest_signed: signed.length ? record(ctx, [...signed].sort((a, b) => b.signed_at!.localeCompare(a.signed_at!))[0]) : null,
      in_review: reviewing ? record(ctx, reviewing) : null,
      projects: [...new Set(live.map((r) => r.project).filter((p): p is string => !!p))].sort((a, b) => a.localeCompare(b)),
      records: live.length,
      signed_count: signed.length,
      last_change: newest.updated_at,
    };
    if (opts.project != null && !live.some((r) => r.project_id === opts.project)) continue;
    if (filter === 'signed' && !entry.latest_signed) continue;
    if (filter === 'in_review' && !entry.in_review) continue;
    if (filter === 'never_signed' && entry.latest_signed) continue;
    if (term) {
      const hay = [entry.identifier, ...live.flatMap((r) => [r.job_number, r.title, r.project ?? '', r.revision ?? '', r.notes ?? ''])].join(' ').toLowerCase();
      if (!hay.includes(term)) continue;
    }
    entries.push(entry);
  }
  entries.sort((a, b) => b.last_change.localeCompare(a.last_change) || a.identifier.localeCompare(b.identifier));
  return { drawings: entries, total: entries.length };
}

/** Every record of one drawing number across jobs, newest first (withdrawn ones included, marked). */
export function drawingHistory(ctx: StoreCtx, identifier: string): { identifier: string; records: RegisterRecord[] } {
  const id = identifier.trim();
  if (!id) throw badRequest('Which drawing number?');
  const list = rows(ctx, id).map((r) => record(ctx, r));
  if (!list.length) return { identifier: id, records: [] };
  const shown = [...list].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0].identifier;
  return { identifier: shown, records: list };
}
