// Release checklists (decision #38): per job type, the things to check before
// a job goes to Review or Done ("title block filled", "BOM checked"…). The
// admin keeps the lists under Admin → Job types; people tick them in the job.
//
// This module holds the lists and the rule; ticking lives in tickets.ts (it
// needs the per-job change check).

import { checklistItemEditSchema, checklistItemSchema, type ChecklistItem, type ChecklistMode, type JobChecklist } from '@board/shared';
import { all, get, run, tx } from '../db/connection.ts';
import { HttpError, bool, int, notFound, type Ctx } from '../lib/core.ts';

interface ItemRow {
  id: number;
  job_type_id: number;
  text: string;
  sort_order: number;
  active: number;
}
const toItem = (r: ItemRow): ChecklistItem => ({ id: r.id, text: r.text, sort_order: r.sort_order, active: bool(r.active) });

/** Every job type's items, active first in order (for the job types list). */
export function itemsByType(ctx: Ctx): Map<number, ChecklistItem[]> {
  const map = new Map<number, ChecklistItem[]>();
  for (const r of all<ItemRow>(ctx.db, 'SELECT * FROM checklist_items ORDER BY active DESC, sort_order, id')) {
    if (!map.has(r.job_type_id)) map.set(r.job_type_id, []);
    map.get(r.job_type_id)!.push(toItem(r));
  }
  return map;
}

function requireType(ctx: Ctx, id: number) {
  if (!get(ctx.db, 'SELECT 1 FROM job_types WHERE id = ?', id)) throw notFound('Job type');
}

export function createItem(ctx: Ctx, jobTypeId: number, input: unknown): ChecklistItem {
  const data = checklistItemSchema(input);
  return tx(ctx.db, () => {
    requireType(ctx, jobTypeId);
    const max = get<{ m: number | null }>(ctx.db, 'SELECT MAX(sort_order) m FROM checklist_items WHERE job_type_id = ?', jobTypeId)!.m ?? 0;
    const id = Number(
      run(ctx.db, 'INSERT INTO checklist_items (job_type_id, text, sort_order, active) VALUES (?, ?, ?, ?)', jobTypeId, data.text, data.sort_order ?? max + 10, int(data.active ?? true))
        .lastInsertRowid,
    );
    ctx.events.emit({ type: 'job_types' });
    return toItem(get<ItemRow>(ctx.db, 'SELECT * FROM checklist_items WHERE id = ?', id)!);
  });
}

/** Rename, reorder, retire or bring back an item. Items are never deleted, so a job's history keeps what was ticked. */
export function updateItem(ctx: Ctx, id: number, input: unknown): ChecklistItem {
  const data = checklistItemEditSchema(input);
  return tx(ctx.db, () => {
    const cur = get<ItemRow>(ctx.db, 'SELECT * FROM checklist_items WHERE id = ?', id);
    if (!cur) throw notFound('Checklist item');
    run(
      ctx.db,
      'UPDATE checklist_items SET text = ?, sort_order = ?, active = ? WHERE id = ?',
      data.text ?? cur.text,
      data.sort_order ?? cur.sort_order,
      data.active === undefined ? cur.active : int(data.active),
      id,
    );
    // job types, and the cards of jobs of this type (their count changes)
    ctx.events.emit({ type: 'job_types' });
    return toItem(get<ItemRow>(ctx.db, 'SELECT * FROM checklist_items WHERE id = ?', id)!);
  });
}

/** The checklist of a job, with its ticks, or null when its type has none. */
export function jobChecklist(ctx: Ctx, ticketId: number): JobChecklist | null {
  const t = get<{ job_type_id: number | null }>(ctx.db, 'SELECT job_type_id FROM tickets WHERE id = ?', ticketId);
  if (!t) throw notFound('Job');
  if (t.job_type_id == null) return null;
  const items = all<{ id: number; text: string; checked_by: number | null; checked_at: string | null }>(
    ctx.db,
    `SELECT i.id, i.text, c.checked_by, c.checked_at FROM checklist_items i
     LEFT JOIN ticket_checks c ON c.item_id = i.id AND c.ticket_id = ?
     WHERE i.job_type_id = ? AND i.active = 1 ORDER BY i.sort_order, i.id`,
    ticketId,
    t.job_type_id,
  );
  if (!items.length) return null;
  const mode = get<{ checklist_mode: ChecklistMode }>(ctx.db, 'SELECT checklist_mode FROM job_types WHERE id = ?', t.job_type_id)!.checklist_mode;
  return { mode, items };
}

/** Progress for many jobs at once (the board's cards). */
export function checklistSummaries(ctx: Ctx, rows: { id: number; job_type_id: number | null }[]): Map<number, { done: number; total: number; mode: ChecklistMode }> {
  const out = new Map<number, { done: number; total: number; mode: ChecklistMode }>();
  const typeIds = [...new Set(rows.map((r) => r.job_type_id).filter((x): x is number => x != null))];
  if (!typeIds.length) return out;
  const totals = new Map(
    all<{ job_type_id: number; n: number; mode: ChecklistMode }>(
      ctx.db,
      `SELECT i.job_type_id, COUNT(*) n, jt.checklist_mode mode FROM checklist_items i JOIN job_types jt ON jt.id = i.job_type_id
       WHERE i.active = 1 AND i.job_type_id IN (${typeIds.map(() => '?').join(',')}) GROUP BY i.job_type_id`,
      ...typeIds,
    ).map((r) => [r.job_type_id, r]),
  );
  if (!totals.size) return out;
  const withList = rows.filter((r) => r.job_type_id != null && totals.has(r.job_type_id));
  const done = new Map<number, number>();
  // in chunks, to stay well under SQLite's parameter limit on a full board
  for (let i = 0; i < withList.length; i += 500) {
    const chunk = withList.slice(i, i + 500);
    for (const r of all<{ ticket_id: number; n: number }>(
      ctx.db,
      `SELECT c.ticket_id, COUNT(*) n FROM ticket_checks c JOIN checklist_items i ON i.id = c.item_id
       JOIN tickets t ON t.id = c.ticket_id AND t.job_type_id = i.job_type_id
       WHERE i.active = 1 AND c.ticket_id IN (${chunk.map(() => '?').join(',')}) GROUP BY c.ticket_id`,
      ...chunk.map((r) => r.id),
    ))
      done.set(r.ticket_id, r.n);
  }
  for (const r of withList) {
    const t = totals.get(r.job_type_id!)!;
    out.set(r.id, { done: done.get(r.id) ?? 0, total: t.n, mode: t.mode });
  }
  return out;
}

/**
 * The rule: a job whose type has a blocking checklist can't move to Review or
 * Done until every item is ticked. Throws 409 checklist_incomplete with the
 * items still open. A "warn" checklist never blocks (the web app asks first).
 */
export function requireChecklistDone(ctx: Ctx, ticketId: number, jobNumber: string, target: string) {
  const c = jobChecklist(ctx, ticketId);
  if (!c || c.mode !== 'block') return;
  const open = c.items.filter((i) => !i.checked_at);
  if (!open.length) return;
  throw new HttpError(
    409,
    'checklist_incomplete',
    `${jobNumber} can't go to ${target === 'review' ? 'Review' : 'Done'} yet: tick its release checklist first (${open.length} of ${c.items.length} left: ${open.map((i) => i.text).join('; ')}).`,
    { missing: open.map((i) => ({ id: i.id, text: i.text })) },
  );
}
