// Sheet calculator (decision #32): how many standard sheets a list of flat
// components needs, per material and thickness. Pure functions, shared by the
// Tools page and the server tests.
//
// Method (stated here because the workbook it replaces wasn't available to
// compare against; see HANDOFF.md):
//  * Components are grouped by material and thickness.
//  * For each candidate sheet size of that material (and thickness, when the
//    size is stocked per thickness), every component gets "pieces per sheet":
//    the better of the two orientations in a plain grid, with the kerf (cut
//    width) added to each side of a part.
//  * Sheets by fit  = ceil( Σ quantity / piecesPerSheet )
//    Sheets by area = ceil( Σ blank area / (sheet area × utilisation) )
//    Required       = the larger of the two: fit catches parts too big to
//    share a sheet well, area catches many small parts that a grid overstates.
//  * The size needing the fewest sheets wins (ties: the smaller sheet).

export interface SheetMaterial {
  id: number;
  name: string;
  /** kg/m³, or null when unknown */
  density: number | null;
  sort_order: number;
  active: boolean;
}

export interface SheetSize {
  id: number;
  material_id: number;
  /** mm; null = stocked in every thickness */
  thickness: number | null;
  length: number;
  width: number;
  active: boolean;
}

export interface SheetSettings {
  utilisation: number;
  kerf: number;
}

export const DEFAULT_SHEET_SETTINGS: SheetSettings = { utilisation: 0.85, kerf: 0 };

export interface ComponentInput {
  name: string;
  material_id: number | null;
  thickness: number | null;
  length: number | null;
  width: number | null;
  quantity: number | null;
}

export interface ComponentResult extends ComponentInput {
  /** blank area of all pieces, mm² */
  area: number;
  /** pieces of this component on one sheet of the chosen size (0 = doesn't fit) */
  per_sheet: number;
  /** quantity / per_sheet */
  sheets: number;
}

export interface SizeOption {
  size: SheetSize;
  sheets_by_fit: number;
  sheets_by_area: number;
  required: number;
  /** blank area / (required × sheet area) */
  utilisation: number;
  /** any component that does not fit this size at all */
  misfits: string[];
}

export interface GroupResult {
  material: SheetMaterial;
  thickness: number;
  components: ComponentResult[];
  total_area: number;
  options: SizeOption[];
  /** the option with the fewest sheets, or null when no size fits */
  best: SizeOption | null;
  /** kg, when the material has a density */
  mass_kg: number | null;
  /** components with missing or invalid numbers, left out of the count */
  skipped: string[];
}

export interface SheetReport {
  groups: GroupResult[];
  /** components whose material or thickness is missing, left out entirely */
  unplaced: string[];
  total_sheets: number;
}

const pos = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** Pieces of l×w (plus kerf) that fit on L×W in a grid, in the better orientation. */
export function piecesPerSheet(L: number, W: number, l: number, w: number, kerf: number): number {
  const fit = (a: number, b: number) => Math.floor((L + kerf) / (a + kerf)) * Math.floor((W + kerf) / (b + kerf));
  return Math.max(fit(l, w), fit(w, l));
}

export function calculateSheets(components: ComponentInput[], materials: SheetMaterial[], sizes: SheetSize[], settings: SheetSettings): SheetReport {
  const util = Math.min(1, Math.max(0.1, settings.utilisation || DEFAULT_SHEET_SETTINGS.utilisation));
  const kerf = Math.max(0, settings.kerf || 0);
  const byMaterial = new Map(materials.map((m) => [m.id, m]));
  const unplaced: string[] = [];
  const groups = new Map<string, { material: SheetMaterial; thickness: number; items: ComponentInput[] }>();
  for (const c of components) {
    const label = c.name.trim() || 'Unnamed component';
    const m = c.material_id == null ? undefined : byMaterial.get(c.material_id);
    if (!m || !pos(c.thickness)) {
      // an untouched blank row (the default quantity of 1 alone) is not a component
      if (c.name.trim() || pos(c.length) || pos(c.width)) unplaced.push(label);
      continue;
    }
    const key = `${m.id}:${c.thickness}`;
    if (!groups.has(key)) groups.set(key, { material: m, thickness: c.thickness, items: [] });
    groups.get(key)!.items.push(c);
  }

  const out: GroupResult[] = [];
  for (const g of [...groups.values()].sort((a, b) => a.material.sort_order - b.material.sort_order || a.material.name.localeCompare(b.material.name) || a.thickness - b.thickness)) {
    const valid = g.items.filter((c) => pos(c.length) && pos(c.width) && pos(c.quantity) && Number.isInteger(c.quantity));
    const skipped = g.items.filter((c) => !valid.includes(c)).map((c) => c.name.trim() || 'Unnamed component');
    const total_area = valid.reduce((n, c) => n + c.length! * c.width! * c.quantity!, 0);
    const candidates = sizes
      .filter((s) => s.active && s.material_id === g.material.id && (s.thickness == null || s.thickness === g.thickness))
      .sort((a, b) => a.length * a.width - b.length * b.width);
    const options: SizeOption[] = candidates.map((size) => {
      let fitSum = 0;
      const misfits: string[] = [];
      for (const c of valid) {
        const per = piecesPerSheet(size.length, size.width, c.length!, c.width!, kerf);
        if (per === 0) misfits.push(c.name.trim() || 'Unnamed component');
        else fitSum += c.quantity! / per;
      }
      const sheets_by_fit = Math.ceil(fitSum - 1e-9);
      const sheets_by_area = Math.ceil(total_area / (size.length * size.width * util) - 1e-9);
      const required = misfits.length ? 0 : Math.max(sheets_by_fit, sheets_by_area);
      return { size, sheets_by_fit, sheets_by_area, required, utilisation: required ? total_area / (required * size.length * size.width) : 0, misfits };
    });
    const usable = options.filter((o) => !o.misfits.length && o.required > 0);
    const best = usable.sort((a, b) => a.required - b.required || a.size.length * a.size.width - b.size.length * b.size.width)[0] ?? null;
    const comps: ComponentResult[] = valid.map((c) => {
      const per = best ? piecesPerSheet(best.size.length, best.size.width, c.length!, c.width!, kerf) : 0;
      return { ...c, area: c.length! * c.width! * c.quantity!, per_sheet: per, sheets: per ? c.quantity! / per : 0 };
    });
    const mass_kg = best && g.material.density != null ? (best.required * best.size.length * best.size.width * g.thickness * g.material.density) / 1e9 : null;
    out.push({ material: g.material, thickness: g.thickness, components: comps, total_area, options, best, mass_kg, skipped });
  }
  return { groups: out, unplaced, total_sheets: out.reduce((n, g) => n + (g.best?.required ?? 0), 0) };
}
