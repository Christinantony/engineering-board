// Tools (decision #32): reference data for the engineers' toolset, kept by the
// admin under Admin → Tools. The first tool is the sheet calculator; its
// materials, standard sheet sizes and settings live here. The calculation
// itself is in shared/src/sheets.ts and runs in the browser.

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
  density: number | null;
  sort_order: number;
  active: number;
}
interface SizeRow {
  id: number;
  material_id: number;
  thickness: number | null;
  length: number;
  width: number;
  active: number;
}

const toMaterial = (r: MaterialRow): SheetMaterial => ({ id: r.id, name: r.name, density: r.density, sort_order: r.sort_order, active: bool(r.active) });
const toSize = (r: SizeRow): SheetSize => ({ id: r.id, material_id: r.material_id, thickness: r.thickness, length: r.length, width: r.width, active: bool(r.active) });

/**
 * A starting list so the calculator works on day one. Only written when there
 * are no materials at all (a new board, or the upgrade to 1.5.0); the admin
 * edits it from there. Sizes with no thickness are stocked in every thickness.
 */
export const INITIAL_MATERIALS: { name: string; density: number; sizes: [number, number][] }[] = [
  { name: 'Mild steel (IS 2062)', density: 7850, sizes: [[2500, 1250], [3000, 1500], [6000, 2000]] },
  { name: 'Stainless steel 304', density: 8000, sizes: [[2500, 1250], [3000, 1500]] },
  { name: 'Stainless steel 316', density: 8000, sizes: [[2500, 1250], [3000, 1500]] },
  { name: 'Aluminium', density: 2700, sizes: [[2500, 1250], [3000, 1500]] },
];

export function seedTools(ctx: Ctx) {
  if (get<{ n: number }>(ctx.db, 'SELECT COUNT(*) n FROM materials')!.n > 0) return;
  tx(ctx.db, () => {
    INITIAL_MATERIALS.forEach((m, i) => {
      const id = Number(run(ctx.db, 'INSERT INTO materials (name, density, sort_order) VALUES (?, ?, ?)', m.name, m.density, (i + 1) * 10).lastInsertRowid);
      for (const [length, width] of m.sizes) run(ctx.db, 'INSERT INTO sheet_sizes (material_id, thickness, length, width) VALUES (?, NULL, ?, ?)', id, length, width);
    });
  });
}

export function listMaterials(ctx: Ctx): SheetMaterial[] {
  return all<MaterialRow>(ctx.db, 'SELECT * FROM materials ORDER BY active DESC, sort_order, name').map(toMaterial);
}
export function listSheetSizes(ctx: Ctx): SheetSize[] {
  return all<SizeRow>(ctx.db, 'SELECT * FROM sheet_sizes ORDER BY material_id, thickness IS NOT NULL, thickness, length * width, length').map(toSize);
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
    const res = run(ctx.db, 'INSERT INTO materials (name, density, sort_order) VALUES (?, ?, ?)', data.name, data.density ?? null, next);
    ctx.events.emit({ type: 'tools' });
    return requireMaterial(ctx, Number(res.lastInsertRowid));
  });
}

export function updateMaterial(ctx: Ctx, id: number, input: unknown): SheetMaterial {
  const data = materialUpdateSchema(input);
  return tx(ctx.db, () => {
    const m = requireMaterial(ctx, id);
    if (data.name && get(ctx.db, 'SELECT 1 FROM materials WHERE name = ? AND id <> ?', data.name, id)) throw conflict(`A material called "${data.name}" already exists`);
    run(
      ctx.db,
      'UPDATE materials SET name = ?, density = ?, sort_order = ?, active = ? WHERE id = ?',
      data.name ?? m.name,
      data.density === undefined ? m.density : data.density,
      data.sort_order ?? m.sort_order,
      int(data.active ?? m.active),
      id,
    );
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
    const thickness = data.thickness ?? null;
    if (get(ctx.db, 'SELECT 1 FROM sheet_sizes WHERE material_id = ? AND thickness IS ? AND length = ? AND width = ?', data.material_id, thickness, data.length, data.width))
      throw conflict('That sheet size is already in the list');
    const res = run(ctx.db, 'INSERT INTO sheet_sizes (material_id, thickness, length, width) VALUES (?, ?, ?, ?)', data.material_id, thickness, data.length, data.width);
    ctx.events.emit({ type: 'tools' });
    return requireSize(ctx, Number(res.lastInsertRowid));
  });
}

export function updateSheetSize(ctx: Ctx, id: number, input: unknown): SheetSize {
  const data = sheetSizeUpdateSchema(input);
  return tx(ctx.db, () => {
    const s = requireSize(ctx, id);
    const thickness = data.thickness === undefined ? s.thickness : data.thickness;
    const length = data.length ?? s.length;
    const width = data.width ?? s.width;
    if (get(ctx.db, 'SELECT 1 FROM sheet_sizes WHERE material_id = ? AND thickness IS ? AND length = ? AND width = ? AND id <> ?', s.material_id, thickness, length, width, id))
      throw conflict('That sheet size is already in the list');
    run(ctx.db, 'UPDATE sheet_sizes SET thickness = ?, length = ?, width = ?, active = ? WHERE id = ?', thickness, length, width, int(data.active ?? s.active), id);
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
