// The procurement tracker (decision #39): the team's inventory and
// procurement workbook as a page per project. The master list is the only
// place items are typed; the assembly checklist and the pending list are
// views of it; the log records, with the date and time, every item marked in
// stock (or taken back out), added or removed.
//
// Items are removed, never deleted, so the log keeps its names. A new project
// can start from another project's list (the workbook's template and Reset).

import {
  PROCUREMENT_MEANS_LABEL,
  procurementCopySchema,
  procurementEditSchema,
  procurementItemSchema,
  procurementStockSchema,
  type ProcurementItem,
  type ProcurementLogEntry,
  type User,
} from '@board/shared';
import { all, get, run, tx } from '../db/connection.ts';
import { badRequest, conflict, notFound, nowIso, type Ctx } from '../lib/core.ts';
import { getProject } from './projects.ts';

const COLS = `id, project_id, name, discipline, category, means, spec, quantity, unit, notes, sort_order, in_stock_at, in_stock_by, created_by, created_at, updated_at, version`;

function itemRow(ctx: Ctx, id: number): ProcurementItem & { removed_at: string | null } {
  const r = get<ProcurementItem & { removed_at: string | null }>(ctx.db, `SELECT ${COLS}, removed_at FROM procurement_items WHERE id = ?`, id);
  if (!r) throw notFound('Item');
  return r;
}

function liveItem(ctx: Ctx, id: number) {
  const r = itemRow(ctx, id);
  if (r.removed_at) throw notFound('Item');
  return r;
}

function logEntry(ctx: Ctx, item: { id: number; project_id: number; name: string; spec: string }, user: User | null, kind: ProcurementLogEntry['kind']) {
  run(
    ctx.db,
    'INSERT INTO procurement_log (project_id, item_id, user_id, at, kind, item_name, item_spec) VALUES (?, ?, ?, ?, ?, ?, ?)',
    item.project_id,
    item.id,
    user?.id ?? null,
    nowIso(ctx),
    kind,
    item.name,
    item.spec,
  );
}

const changed = (ctx: Ctx, projectId: number) => ctx.events.emit({ type: 'procurement', id: projectId });

/** A project's tracker: its items in master-list order, the log (newest first) and the totals. */
export function procurement(ctx: Ctx, projectId: number) {
  const project = getProject(ctx, projectId);
  const items = all<ProcurementItem>(ctx.db, `SELECT ${COLS} FROM procurement_items WHERE project_id = ? AND removed_at IS NULL ORDER BY sort_order, id`, projectId);
  const log = all<ProcurementLogEntry>(
    ctx.db,
    'SELECT id, item_id, user_id, at, kind, item_name, item_spec FROM procurement_log WHERE project_id = ? ORDER BY id DESC LIMIT 500',
    projectId,
  );
  const inStock = items.filter((i) => i.in_stock_at).length;
  // what the team has typed before, offered as suggestions (the workbook's drop-downs)
  const used = (col: 'discipline' | 'category' | 'unit') =>
    all<{ v: string }>(ctx.db, `SELECT DISTINCT ${col} v FROM procurement_items WHERE ${col} <> '' AND removed_at IS NULL ORDER BY ${col} COLLATE NOCASE`).map((r) => r.v);
  const others = all<{ id: number; name: string; items: number }>(
    ctx.db,
    `SELECT p.id, p.name, COUNT(i.id) items FROM projects p JOIN procurement_items i ON i.project_id = p.id AND i.removed_at IS NULL
     WHERE p.id <> ? GROUP BY p.id ORDER BY p.name COLLATE NOCASE`,
    projectId,
  );
  return {
    project: { id: project.id, name: project.name },
    items,
    log,
    totals: { items: items.length, in_stock: inStock, pending: items.length - inStock },
    suggestions: {
      disciplines: [...new Set(['RF', 'Mechanical', ...used('discipline')])],
      categories: [...new Set(['Single Antenna', 'Array', 'Tool', ...used('category')])],
      units: [...new Set(['pcs', 'set', 'm', 'kg', ...used('unit')])],
    },
    copy_from: others,
  };
}

export function addItem(ctx: Ctx, actor: User, projectId: number, input: unknown): ProcurementItem {
  const d = procurementItemSchema(input);
  return tx(ctx.db, () => {
    getProject(ctx, projectId);
    const now = nowIso(ctx);
    const max = get<{ m: number | null }>(ctx.db, 'SELECT MAX(sort_order) m FROM procurement_items WHERE project_id = ?', projectId)!.m ?? 0;
    const id = Number(
      run(
        ctx.db,
        `INSERT INTO procurement_items (project_id, name, discipline, category, means, spec, quantity, unit, notes, sort_order, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        projectId,
        d.name,
        d.discipline,
        d.category,
        d.means,
        d.spec,
        d.quantity,
        d.unit,
        d.notes,
        max + 10,
        actor.id,
        now,
        now,
      ).lastInsertRowid,
    );
    const item = liveItem(ctx, id);
    logEntry(ctx, item, actor, 'added');
    changed(ctx, projectId);
    return item;
  });
}

/** Edit an item of the master list. `version` guards against two people overwriting each other. */
export function editItem(ctx: Ctx, actor: User, id: number, input: unknown): ProcurementItem {
  const d = procurementEditSchema(input);
  void actor;
  return tx(ctx.db, () => {
    const cur = liveItem(ctx, id);
    if (cur.version !== d.version) throw conflict(`Someone else changed "${cur.name}" a moment ago. Here is their version.`, { current: cur });
    const next = {
      name: d.name ?? cur.name,
      discipline: d.discipline ?? cur.discipline,
      category: d.category ?? cur.category,
      means: d.means ?? cur.means,
      spec: d.spec ?? cur.spec,
      quantity: d.quantity ?? cur.quantity,
      unit: d.unit ?? cur.unit,
      notes: d.notes ?? cur.notes,
      sort_order: d.sort_order ?? cur.sort_order,
    };
    run(
      ctx.db,
      `UPDATE procurement_items SET name = ?, discipline = ?, category = ?, means = ?, spec = ?, quantity = ?, unit = ?, notes = ?, sort_order = ?,
       updated_at = ?, version = version + 1 WHERE id = ?`,
      next.name,
      next.discipline,
      next.category,
      next.means,
      next.spec,
      next.quantity,
      next.unit,
      next.notes,
      next.sort_order,
      nowIso(ctx),
      id,
    );
    changed(ctx, cur.project_id);
    return liveItem(ctx, id);
  });
}

/** Mark an item in stock (stamped with the date, time and who) or back to pending. */
export function setStock(ctx: Ctx, actor: User, id: number, input: unknown): ProcurementItem {
  const { in_stock } = procurementStockSchema(input);
  return tx(ctx.db, () => {
    const cur = liveItem(ctx, id);
    if (!!cur.in_stock_at === in_stock) return cur;
    if (in_stock) run(ctx.db, 'UPDATE procurement_items SET in_stock_at = ?, in_stock_by = ?, updated_at = ?, version = version + 1 WHERE id = ?', nowIso(ctx), actor.id, nowIso(ctx), id);
    else run(ctx.db, 'UPDATE procurement_items SET in_stock_at = NULL, in_stock_by = NULL, updated_at = ?, version = version + 1 WHERE id = ?', nowIso(ctx), id);
    logEntry(ctx, cur, actor, in_stock ? 'in_stock' : 'not_in_stock');
    changed(ctx, cur.project_id);
    return liveItem(ctx, id);
  });
}

/** Take an item off the master list. Its log entries stay. */
export function removeItem(ctx: Ctx, actor: User, id: number): { removed: true } {
  return tx(ctx.db, () => {
    const cur = liveItem(ctx, id);
    run(ctx.db, 'UPDATE procurement_items SET removed_at = ?, updated_at = ?, version = version + 1 WHERE id = ?', nowIso(ctx), nowIso(ctx), id);
    logEntry(ctx, cur, actor, 'removed');
    changed(ctx, cur.project_id);
    return { removed: true };
  });
}

/**
 * Start a project's list from another project's (the workbook's template):
 * every item is copied as pending, without notes. Items whose name and spec
 * are already on the list are skipped, so copying twice adds nothing.
 */
export function copyList(ctx: Ctx, actor: User, projectId: number, input: unknown): { copied: number; skipped: number } {
  const { from_project_id } = procurementCopySchema(input);
  if (from_project_id === projectId) throw badRequest('Choose another project to copy from.');
  return tx(ctx.db, () => {
    getProject(ctx, projectId);
    getProject(ctx, from_project_id);
    const source = all<ProcurementItem>(ctx.db, `SELECT ${COLS} FROM procurement_items WHERE project_id = ? AND removed_at IS NULL ORDER BY sort_order, id`, from_project_id);
    // compared in JavaScript: SQLite's lower() leaves "Ø" and other non-ASCII letters alone
    const key = (name: string, spec: string) => `${name.trim().toLowerCase()}|${spec.trim().toLowerCase()}`;
    const have = new Set(
      all<{ name: string; spec: string }>(ctx.db, 'SELECT name, spec FROM procurement_items WHERE project_id = ? AND removed_at IS NULL', projectId).map((r) => key(r.name, r.spec)),
    );
    let copied = 0;
    for (const s of source) {
      if (have.has(key(s.name, s.spec))) continue;
      addItem(ctx, actor, projectId, { name: s.name, discipline: s.discipline, category: s.category, means: s.means, spec: s.spec, quantity: s.quantity, unit: s.unit });
      copied++;
    }
    return { copied, skipped: source.length - copied };
  });
}

/** The master list as CSV for Excel (UTF-8 with a BOM, formula-safe), like the jobs export. */
export function procurementCsv(ctx: Ctx, projectId: number, userName: (id: number | null) => string): string {
  const { items } = procurement(ctx, projectId);
  const cell = (v: string | number) => {
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ['No.', 'Item', 'Discipline', 'Category', 'Means', 'Final size / spec', 'Quantity', 'Unit', 'Status', 'In stock since', 'Marked by', 'Notes'];
  const rows = items.map((i, n) => [
    n + 1,
    i.name,
    i.discipline,
    i.category,
    PROCUREMENT_MEANS_LABEL[i.means],
    i.spec,
    i.quantity,
    i.unit,
    i.in_stock_at ? 'In stock' : 'Pending',
    i.in_stock_at ?? '',
    i.in_stock_at ? userName(i.in_stock_by) : '',
    i.notes,
  ]);
  return '﻿' + [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
