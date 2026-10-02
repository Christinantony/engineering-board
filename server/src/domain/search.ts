// Full-text search index maintenance and query building.
// The index is a trigram FTS5 table keyed by ticket id (rowid), so any
// substring of 3+ characters matches ("brack" → "Bracket", "1042" → "JOB-1042",
// "Pump_ABC" → "\\SERVER\FEA\Pump_ABC"). Shorter terms fall back to LIKE.

import { all, get, run, type Param } from '../db/connection.ts';
import type { Ctx } from '../lib/core.ts';

interface IndexRow {
  id: number;
  job_number: string;
  title: string;
  description: string;
  notes: string;
  requester: string;
  reference: string;
  file_location: string;
  waiting_for: string;
  job_type: string | null;
  assignee: string | null;
  tags: string | null;
  drawings: string | null;
}

const INDEX_SELECT = `
  SELECT t.id, t.job_number, t.title, t.description, t.notes, t.requester, t.reference,
         t.file_location, t.waiting_for, jt.name AS job_type, u.name AS assignee,
         (SELECT group_concat(g.name, ' ') FROM ticket_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.ticket_id = t.id) AS tags,
         (SELECT group_concat(d.identifier, ' ') FROM review_drawings d WHERE d.ticket_id = t.id) AS drawings
  FROM tickets t
  LEFT JOIN job_types jt ON jt.id = t.job_type_id
  LEFT JOIN users u ON u.id = t.assigned_to`;

function writeIndex(ctx: Ctx, r: IndexRow) {
  run(ctx.db, 'DELETE FROM tickets_fts WHERE rowid = ?', r.id);
  const body = [r.description, r.notes, r.requester, r.reference, r.file_location, r.waiting_for, r.job_type, r.assignee, r.tags, r.drawings]
    .filter(Boolean)
    .join('\n');
  run(ctx.db, 'INSERT INTO tickets_fts (rowid, job_number, title, body) VALUES (?, ?, ?, ?)', r.id, r.job_number, r.title, body);
}

export function reindexTicket(ctx: Ctx, id: number) {
  const r = get<IndexRow>(ctx.db, `${INDEX_SELECT} WHERE t.id = ?`, id);
  if (r) writeIndex(ctx, r);
  else run(ctx.db, 'DELETE FROM tickets_fts WHERE rowid = ?', id);
}

/** Reindex every ticket referencing a renamed user or job type. */
export function reindexWhere(ctx: Ctx, column: 'assigned_to' | 'job_type_id', value: number) {
  for (const r of all<IndexRow>(ctx.db, `${INDEX_SELECT} WHERE t.${column} = ?`, value)) writeIndex(ctx, r);
}

export function rebuildIndex(ctx: Ctx) {
  run(ctx.db, 'DELETE FROM tickets_fts');
  for (const r of all<IndexRow>(ctx.db, INDEX_SELECT)) writeIndex(ctx, r);
}

/**
 * Turn user text into an SQL condition on ticket id `t.id`.
 * Every term must match (AND). Returns null for empty queries.
 */
export function searchCondition(q: string): { sql: string; params: Param[]; ranked: boolean } | null {
  const terms = q
    .trim()
    .split(/\s+/)
    .map((s) => s.replace(/^["']+|["']+$/g, ''))
    .filter(Boolean)
    .slice(0, 12);
  if (!terms.length) return null;
  const long = terms.filter((t) => [...t].length >= 3);
  const short = terms.filter((t) => [...t].length < 3);
  const parts: string[] = [];
  const params: Param[] = [];
  if (long.length) {
    parts.push(`t.id IN (SELECT rowid FROM tickets_fts WHERE tickets_fts MATCH ?)`);
    params.push(long.map((t) => `"${t.replace(/"/g, '""')}"`).join(' AND '));
  }
  for (const s of short) {
    parts.push(
      `t.id IN (SELECT rowid FROM tickets_fts WHERE (job_number || ' ' || title || ' ' || body) LIKE ? ESCAPE '\\')`,
    );
    params.push(`%${s.replace(/[\\%_]/g, (m) => '\\' + m)}%`);
  }
  return { sql: parts.join(' AND '), params, ranked: long.length > 0 };
}

/** bm25 relevance (lower is better) — job number and title weigh more than body. */
export function rankExpr(): string {
  return `(SELECT bm25(tickets_fts, 10.0, 5.0, 1.0) FROM tickets_fts WHERE tickets_fts MATCH ? AND rowid = t.id)`;
}
