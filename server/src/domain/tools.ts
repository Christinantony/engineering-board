// Tools (decision #32): reference data for the engineers' toolset, kept by the
// admin under Admin → Tools. The first tool is the sheet calculator, the
// team's Sheet Requirement Calculator workbook (docs/tools/) as a board page:
// its Materials sheet lives here, its Calculator and Layout sheets are
// shared/src/sheets.ts, run in the browser.

import {
  DEFAULT_SHEET_SETTINGS,
  materialSchema,
  materialUpdateSchema,
  sheetSettingsSchema,
  sheetSizeSchema,
  sheetSizeUpdateSchema,
  type SheetMaterial,
  type SheetSettings,
  type SheetSize,
} from '@board/shared';
import { all, get, run, tx } from '../db/connection.ts';
import { bool, conflict, int, notFound, type Ctx } from '../lib/core.ts';
import { getSetting, setSetting } from './auth.ts';

const SETTINGS_KEY = 'sheet_calculator';

interface MaterialRow {
  id: number;
  name: string;
  sort_order: number;
  active: number;
}
interface SizeRow {
  id: number;
  material_id: number;
  length: number;
  width: number;
  active: number;
}

const toMaterial = (r: MaterialRow): SheetMaterial => ({ id: r.id, name: r.name, sort_order: r.sort_order, active: bool(r.active) });
const toSize = (r: SizeRow): SheetSize => ({ id: r.id, material_id: r.material_id, length: r.length, width: r.width, active: bool(r.active) });

/**
 * The workbook's Materials sheet, row for row (its note: "typical commercial
 * stock sizes, entered as placeholders. Replace with your supplier's actual
 * sizes"). Written only when there are no materials at all (a new board, or
 * the upgrade to 1.5.0); the admin edits the list from there.
 */
export const INITIAL_MATERIALS: { name: string; length: number; width: number }[] = [
  { name: 'Mild Steel', length: 2500, width: 1250 },
  { name: 'Stainless Steel', length: 2500, width: 1250 },
  { name: 'Aluminium', length: 2500, width: 1250 },
  { name: 'Copper', length: 2000, width: 1000 },
  { name: 'Brass', length: 2000, width: 1000 },
  { name: 'Plywood', length: 2440, width: 1220 },
  { name: 'MDF', length: 2440, width: 1220 },
  { name: 'Acrylic', length: 2440, width: 1220 },
  { name: 'FR4 / G10', length: 1220, width: 1020 },
  { name: 'Teflon / PTFE', length: 1200, width: 1000 },
];

export function seedTools(ctx: Ctx) {
  if (get<{ n: number }>(ctx.db, 'SELECT COUNT(*) n FROM materials')!.n > 0) return;
  tx(ctx.db, () => {
    INITIAL_MATERIALS.forEach((m, i) => {
      const id = Number(run(ctx.db, 'INSERT INTO materials (name, sort_order) VALUES (?, ?)', m.name, (i + 1) * 10).lastInsertRowid);
      run(ctx.db, 'INSERT INTO sheet_sizes (material_id, length, width) VALUES (?, ?, ?)', id, m.length, m.width);
    });
  });
}

export function listMaterials(ctx: Ctx): SheetMaterial[] {
  return all<MaterialRow>(ctx.db, 'SELECT * FROM materials ORDER BY active DESC, sort_order, name').map(toMaterial);
}
export function listSheetSizes(ctx: Ctx): SheetSize[] {
  return all<SizeRow>(ctx.db, 'SELECT * FROM sheet_sizes ORDER BY material_id, length * width, length').map(toSize);
}

export function getSheetSettings(ctx: Ctx): SheetSettings {
  const raw = getSetting(ctx, SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_SHEET_SETTINGS };
  try {
    return sheetSettingsSchema(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SHEET_SETTINGS };
  }
}
export function setSheetSettings(ctx: Ctx, input: unknown): SheetSettings {
  const s = sheetSettingsSchema(input);
  setSetting(ctx, SETTINGS_KEY, JSON.stringify(s));
  ctx.events.emit({ type: 'tools' });
  return s;
}

/** Everything the calculator needs, in one answer. */
export function sheetCalculatorData(ctx: Ctx) {
  return { materials: listMaterials(ctx), sizes: listSheetSizes(ctx), settings: getSheetSettings(ctx) };
}

function requireMaterial(ctx: Ctx, id: number): SheetMaterial {
  const r = get<MaterialRow>(ctx.db, 'SELECT * FROM materials WHERE id = ?', id);
  if (!r) throw notFound('Material');
  return toMaterial(r);
}

export function createMaterial(ctx: Ctx, input: unknown): SheetMaterial {
  const data = materialSchema(input);
  return tx(ctx.db, () => {
    if (get(ctx.db, 'SELECT 1 FROM materials WHERE name = ?', data.name)) throw conflict(`A material called "${data.name}" already exists`);
    const next = (get<{ m: number | null }>(ctx.db, 'SELECT MAX(sort_order) m FROM materials')!.m ?? 0) + 10;
    const res = run(ctx.db, 'INSERT INTO materials (name, sort_order) VALUES (?, ?)', data.name, next);
    ctx.events.emit({ type: 'tools' });
    return requireMaterial(ctx, Number(res.lastInsertRowid));
  });
}

export function updateMaterial(ctx: Ctx, id: number, input: unknown): SheetMaterial {
  const data = materialUpdateSchema(input);
  return tx(ctx.db, () => {
    const m = requireMaterial(ctx, id);
    if (data.name && get(ctx.db, 'SELECT 1 FROM materials WHERE name = ? AND id <> ?', data.name, id)) throw conflict(`A material called "${data.name}" already exists`);
    run(ctx.db, 'UPDATE materials SET name = ?, sort_order = ?, active = ? WHERE id = ?', data.name ?? m.name, data.sort_order ?? m.sort_order, int(data.active ?? m.active), id);
    ctx.events.emit({ type: 'tools' });
    return requireMaterial(ctx, id);
  });
}

function requireSize(ctx: Ctx, id: number): SheetSize {
  const r = get<SizeRow>(ctx.db, 'SELECT * FROM sheet_sizes WHERE id = ?', id);
  if (!r) throw notFound('Sheet size');
  return toSize(r);
}

export function createSheetSize(ctx: Ctx, input: unknown): SheetSize {
  const data = sheetSizeSchema(input);
  return tx(ctx.db, () => {
    requireMaterial(ctx, data.material_id);
    if (get(ctx.db, 'SELECT 1 FROM sheet_sizes WHERE material_id = ? AND length = ? AND width = ?', data.material_id, data.length, data.width))
      throw conflict('That sheet size is already in the list');
    const res = run(ctx.db, 'INSERT INTO sheet_sizes (material_id, length, width) VALUES (?, ?, ?)', data.material_id, data.length, data.width);
    ctx.events.emit({ type: 'tools' });
    return requireSize(ctx, Number(res.lastInsertRowid));
  });
}

export function updateSheetSize(ctx: Ctx, id: number, input: unknown): SheetSize {
  const data = sheetSizeUpdateSchema(input);
  return tx(ctx.db, () => {
    const s = requireSize(ctx, id);
    const length = data.length ?? s.length;
    const width = data.width ?? s.width;
    if (get(ctx.db, 'SELECT 1 FROM sheet_sizes WHERE material_id = ? AND length = ? AND width = ? AND id <> ?', s.material_id, length, width, id))
      throw conflict('That sheet size is already in the list');
    run(ctx.db, 'UPDATE sheet_sizes SET length = ?, width = ?, active = ? WHERE id = ?', length, width, int(data.active ?? s.active), id);
    ctx.events.emit({ type: 'tools' });
    return requireSize(ctx, id);
  });
}

export function deleteSheetSize(ctx: Ctx, id: number): { ok: true } {
  requireSize(ctx, id);
  run(ctx.db, 'DELETE FROM sheet_sizes WHERE id = ?', id);
  ctx.events.emit({ type: 'tools' });
  return { ok: true };
}
