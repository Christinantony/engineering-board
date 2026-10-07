// Sheet calculator (decision #32): how many standard sheets a flat component
// needs. This is the team's "Sheet Requirement Calculator" workbook
// (docs/tools/Sheet_Requirement_Calculator.xlsx) as code, formula for formula:
//
//   usable length  = sheet length − 2 × edge margin        (Calculator!B16)
//   usable width   = sheet width  − 2 × edge margin        (Calculator!B17)
//   per sheet, orientation 1 (a along the length)          (Calculator!B20)
//                  = MAX(0, INT((UL + k) / (a + k))) × MAX(0, INT((UW + k) / (b + k)))
//   per sheet, orientation 2 (b along the length)          (Calculator!B21)
//                  = MAX(0, INT((UL + k) / (b + k))) × MAX(0, INT((UW + k) / (a + k)))
//   parts per sheet = MAX of the two when rotation is allowed, else orientation 1   (B22)
//   sheets required = ROUNDUP(n / parts per sheet)         (Calculator!B26)
//   parts on last sheet = n − (sheets − 1) × parts per sheet                       (B27)
//   total parts area, sheet area purchased, utilisation, waste                     (B28–B31)
//   cutting layout: parts across and down, part size along each axis, unused strips (Layout!L6–L11)
//
// where k is the kerf (gap between adjacent parts). The workbook takes one
// component at a time with one stock size per material; the board runs the
// same sums for every row of a component list and, where the admin lists more
// than one stock size for a material, for each size, keeping the one that
// needs the fewest sheets. Pure functions, shared by the Tools page and the
// server tests.

export interface SheetMaterial {
  id: number;
  name: string;
  sort_order: number;
  active: boolean;
}

export interface SheetSize {
  id: number;
  material_id: number;
  length: number;
  width: number;
  active: boolean;
}

/** The workbook's three parameters, as the defaults the admin keeps for new calculations. */
export interface SheetSettings {
  /** gap between adjacent parts, mm (Calculator!B9; the workbook's default is 3) */
  kerf: number;
  /** unusable border on every side of the sheet, mm (Calculator!B10; the workbook's default is 5) */
  margin: number;
  /** allow rotation by 90° (Calculator!B11; the workbook's default is Yes) */
  rotate: boolean;
}

export const DEFAULT_SHEET_SETTINGS: SheetSettings = { kerf: 3, margin: 5, rotate: true };

export interface ComponentInput {
  name: string;
  material_id: number | null;
  /** component length a, mm */
  length: number | null;
  /** component width b, mm */
  width: number | null;
  /** number of components n */
  quantity: number | null;
}

/** The cutting layout of one stock size (the workbook's Layout sheet). */
export interface SheetLayout {
  /** parts along the sheet length and along the sheet width */
  across: number;
  down: number;
  /** the part's size along the sheet length and along the sheet width, mm */
  part_length: number;
  part_width: number;
  usable_length: number;
  usable_width: number;
  /** unused strip left along the length and along the width, mm */
  strip_length: number;
  strip_width: number;
}

export interface SizeResult {
  size: SheetSize;
  usable_length: number;
  usable_width: number;
  per_sheet_1: number;
  per_sheet_2: number;
  per_sheet: number;
  /** 'a along length' | 'b along length (rotated)' | 'Does not fit' */
  orientation: 'along' | 'rotated' | 'none';
  sheets: number;
  last_sheet_parts: number;
  /** m² */
  parts_area: number;
  purchased_area: number;
  utilisation: number;
  waste_area: number;
  layout: SheetLayout | null;
}

export interface ComponentResult extends ComponentInput {
  material: SheetMaterial;
  options: SizeResult[];
  /** the stock size needing the fewest sheets (ties: the smaller sheet), or null when the part fits none */
  best: SizeResult | null;
}

export interface MaterialTotal {
  material: SheetMaterial;
  sheets: number;
  /** stock sizes used and the sheets of each, e.g. "2500 × 1250" → 3 */
  by_size: { size: SheetSize; sheets: number }[];
}

export interface SheetReport {
  rows: ComponentResult[];
  by_material: MaterialTotal[];
  total_sheets: number;
  /** rows left out: no material, or a size or quantity missing or not positive */
  skipped: { name: string; reason: string }[];
}

const pos = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** Parts of a×b in a straight grid on a usable UL×UW area with kerf k between parts: Calculator!B20 (swap a and b for B21). */
export function gridFit(usableLength: number, usableWidth: number, a: number, b: number, kerf: number): number {
  return Math.max(0, Math.floor((usableLength + kerf) / (a + kerf))) * Math.max(0, Math.floor((usableWidth + kerf) / (b + kerf)));
}

/** One component on one stock size: the workbook's Calculator and Layout sheets. */
export function fitOnSize(c: { length: number; width: number; quantity: number }, size: { length: number; width: number }, s: SheetSettings): Omit<SizeResult, 'size'> {
  const usable_length = size.length - 2 * s.margin;
  const usable_width = size.width - 2 * s.margin;
  const per_sheet_1 = gridFit(usable_length, usable_width, c.length, c.width, s.kerf);
  const per_sheet_2 = gridFit(usable_length, usable_width, c.width, c.length, s.kerf);
  const per_sheet = s.rotate ? Math.max(per_sheet_1, per_sheet_2) : per_sheet_1;
  const orientation: SizeResult['orientation'] = per_sheet === 0 ? 'none' : per_sheet === per_sheet_1 ? 'along' : 'rotated';
  const sheets = per_sheet ? Math.ceil(c.quantity / per_sheet) : 0;
  const parts_area = (c.quantity * c.length * c.width) / 1e6;
  const purchased_area = (sheets * size.length * size.width) / 1e6;
  let layout: SheetLayout | null = null;
  if (per_sheet) {
    const [pl, pw] = orientation === 'along' ? [c.length, c.width] : [c.width, c.length];
    const across = Math.floor((usable_length + s.kerf) / (pl + s.kerf));
    const down = Math.floor((usable_width + s.kerf) / (pw + s.kerf));
    layout = {
      across,
      down,
      part_length: pl,
      part_width: pw,
      usable_length,
      usable_width,
      strip_length: across ? usable_length - (across * pl + (across - 1) * s.kerf) : 0,
      strip_width: down ? usable_width - (down * pw + (down - 1) * s.kerf) : 0,
    };
  }
  return {
    usable_length,
    usable_width,
    per_sheet_1,
    per_sheet_2,
    per_sheet,
    orientation,
    sheets,
    last_sheet_parts: per_sheet ? c.quantity - (sheets - 1) * per_sheet : 0,
    parts_area,
    purchased_area,
    utilisation: purchased_area ? parts_area / purchased_area : 0,
    waste_area: purchased_area ? purchased_area - parts_area : 0,
    layout,
  };
}

export function calculateSheets(components: ComponentInput[], materials: SheetMaterial[], sizes: SheetSize[], settings: SheetSettings): SheetReport {
  const s: SheetSettings = { kerf: Math.max(0, settings.kerf || 0), margin: Math.max(0, settings.margin || 0), rotate: !!settings.rotate };
  const byMaterial = new Map(materials.map((m) => [m.id, m]));
  const rows: ComponentResult[] = [];
  const skipped: SheetReport['skipped'] = [];
  components.forEach((c, i) => {
    const label = c.name.trim() || `Component ${i + 1}`;
    const touched = c.name.trim() || pos(c.length) || pos(c.width) || c.material_id != null;
    if (!touched) return; // an untouched blank row
    const m = c.material_id == null ? undefined : byMaterial.get(c.material_id);
    if (!m) return void skipped.push({ name: label, reason: 'no material' });
    if (!pos(c.length) || !pos(c.width)) return void skipped.push({ name: label, reason: 'length and width needed' });
    if (!pos(c.quantity) || !Number.isInteger(c.quantity)) return void skipped.push({ name: label, reason: 'a whole number of components needed' });
    const comp = { length: c.length, width: c.width, quantity: c.quantity };
    const options: SizeResult[] = sizes
      .filter((z) => z.active && z.material_id === m.id)
      .sort((x, y) => x.length * x.width - y.length * y.width)
      .map((size) => ({ size, ...fitOnSize(comp, size, s) }));
    const best = options.filter((o) => o.per_sheet > 0).sort((x, y) => x.sheets - y.sheets || x.size.length * x.size.width - y.size.length * y.size.width)[0] ?? null;
    rows.push({ ...c, material: m, options, best });
  });

  const totals = new Map<number, MaterialTotal>();
  for (const r of rows) {
    if (!r.best) continue;
    let t = totals.get(r.material.id);
    if (!t) totals.set(r.material.id, (t = { material: r.material, sheets: 0, by_size: [] }));
    t.sheets += r.best.sheets;
    const bs = t.by_size.find((x) => x.size.id === r.best!.size.id);
    if (bs) bs.sheets += r.best.sheets;
    else t.by_size.push({ size: r.best.size, sheets: r.best.sheets });
  }
  const by_material = [...totals.values()].sort((a, b) => a.material.sort_order - b.material.sort_order || a.material.name.localeCompare(b.material.name));
  return { rows, by_material, total_sheets: by_material.reduce((n, t) => n + t.sheets, 0), skipped };
}
