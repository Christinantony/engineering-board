// Mixed nesting (decision #43): different parts cut from the same sheet.
//
// The workbook's method (sheets.ts, decision #32) lays out one part size per
// sheet in a straight grid. Here a list of different rectangles is packed
// together onto as few sheets of one size as possible, and every part gets
// its position on the sheet, for a cutting layout and a DXF.
//
// Conventions, as in the workbook: the edge margin is removed from all four
// sides; the kerf is the gap left between adjacent parts. Each part is packed
// as a rectangle grown by the kerf on its length and width, into a usable area
// grown by one kerf (so the last part in a row may touch the margin line).
// X runs along the sheet's length, Y along its width, from the top-left
// corner of the sheet itself (margin included), in mm.
//
// Two packers:
//   - "any": maximal rectangles (Jukka Jylänki's MaxRects), for laser,
//     plasma, waterjet or CNC, where parts can be cut in any order;
//   - "guillotine": every cut runs straight across the piece being cut, for
//     panel saws and shears.
// Each runs with several part orders and placement rules, and (when turning
// is allowed) with each part turned as it fits, or all with their long side
// along the sheet, or all across it; the result with the fewest sheets wins,
// then the one leaving the last sheet's offcut in the biggest single piece.
// The last sheet's parts are then packed again into the shortest strip of the
// sheet (or the narrowest) they fit, so what is left comes off with one
// straight cut (decision #44). Deterministic: the same input gives the same
// layout.

import { offcutOf, reachOfParts, type Offcut } from './patterns.ts';

export interface NestPart {
  name: string;
  /** along the sheet's length when not rotated, mm */
  length: number;
  width: number;
  quantity: number;
}

export type CutMode = 'any' | 'guillotine';

export interface NestSettings {
  kerf: number;
  margin: number;
  rotate: boolean;
  cut: CutMode;
}

export interface PlacedPart {
  /** index into the parts list */
  part: number;
  /** 1 … quantity, within its part */
  n: number;
  x: number;
  y: number;
  /** as placed: along the sheet's length and width */
  length: number;
  width: number;
  rotated: boolean;
}

export interface NestedSheet {
  parts: PlacedPart[];
  parts_area: number;
  utilisation: number;
  /** how far the parts reach, from the sheet's corner (margin included) */
  reach_length: number;
  reach_width: number;
  /** what comes off in one piece with one straight cut beyond the parts (decision #44) */
  offcut: Offcut | null;
}

export interface NestResult {
  sheet: { length: number; width: number };
  usable_length: number;
  usable_width: number;
  sheets: NestedSheet[];
  /** parts that fit no sheet in any allowed orientation */
  unplaced: { part: number; count: number }[];
  parts_area: number;
  purchased_area: number;
  utilisation: number;
  waste_area: number;
}

/** Most pieces one calculation will nest (the page stays responsive). */
export const NEST_MAX_PIECES = 1500;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Item {
  part: number;
  n: number;
  /** turned before packing (a fixed-orientation strategy) */
  pre?: boolean;
  /** grown by the kerf */
  w: number;
  h: number;
}
interface Place {
  rect: Rect;
  rotated: boolean;
  score1: number;
  score2: number;
}

const EPS = 1e-6;
const fits = (w: number, h: number, r: Rect) => w <= r.w + EPS && h <= r.h + EPS;

type Rule = 'short' | 'long' | 'area' | 'bottomleft';

function score(rule: Rule, free: Rect, w: number, h: number): [number, number] {
  const dw = free.w - w;
  const dh = free.h - h;
  switch (rule) {
    case 'short':
      return [Math.min(dw, dh), Math.max(dw, dh)];
    case 'long':
      return [Math.max(dw, dh), Math.min(dw, dh)];
    case 'area':
      return [free.w * free.h - w * h, Math.min(dw, dh)];
    case 'bottomleft':
      return [free.y + h, free.x];
  }
}

function choose(free: Rect[], item: Item, rotate: boolean, rule: Rule): Place | null {
  let best: Place | null = null;
  for (const r of free) {
    for (const rotated of rotate && Math.abs(item.w - item.h) > EPS ? [false, true] : [false]) {
      const w = rotated ? item.h : item.w;
      const h = rotated ? item.w : item.h;
      if (!fits(w, h, r)) continue;
      const [s1, s2] = score(rule, r, w, h);
      if (!best || s1 < best.score1 - EPS || (Math.abs(s1 - best.score1) <= EPS && s2 < best.score2 - EPS))
        best = { rect: { x: r.x, y: r.y, w, h }, rotated, score1: s1, score2: s2 };
    }
  }
  return best;
}

// ---- maximal rectangles ----

class MaxRectsBin {
  free: Rect[];
  constructor(w: number, h: number) {
    this.free = [{ x: 0, y: 0, w, h }];
  }
  find(item: Item, rotate: boolean, rule: Rule) {
    return choose(this.free, item, rotate, rule);
  }
  place(p: Rect) {
    const next: Rect[] = [];
    for (const f of this.free) {
      if (p.x >= f.x + f.w - EPS || p.x + p.w <= f.x + EPS || p.y >= f.y + f.h - EPS || p.y + p.h <= f.y + EPS) {
        next.push(f);
        continue;
      }
      if (p.x > f.x + EPS) next.push({ x: f.x, y: f.y, w: p.x - f.x, h: f.h });
      if (p.x + p.w < f.x + f.w - EPS) next.push({ x: p.x + p.w, y: f.y, w: f.x + f.w - (p.x + p.w), h: f.h });
      if (p.y > f.y + EPS) next.push({ x: f.x, y: f.y, w: f.w, h: p.y - f.y });
      if (p.y + p.h < f.y + f.h - EPS) next.push({ x: f.x, y: p.y + p.h, w: f.w, h: f.y + f.h - (p.y + p.h) });
    }
    // drop free rectangles inside another
    this.free = next.filter(
      (a, i) => !next.some((b, j) => j !== i && a.x >= b.x - EPS && a.y >= b.y - EPS && a.x + a.w <= b.x + b.w + EPS && a.y + a.h <= b.y + b.h + EPS && (j < i || a.w * a.h < b.w * b.h - EPS)),
    );
  }
}

// ---- guillotine ----

class GuillotineBin {
  free: Rect[];
  constructor(w: number, h: number, private split: 'shorter' | 'longer') {
    this.free = [{ x: 0, y: 0, w, h }];
  }
  find(item: Item, rotate: boolean, rule: Rule) {
    return choose(this.free, item, rotate, rule);
  }
  place(p: Rect) {
    // the free piece the part was placed in (at its corner)
    const i = this.free.findIndex((f) => Math.abs(f.x - p.x) <= EPS && Math.abs(f.y - p.y) <= EPS && fits(p.w, p.h, f));
    const f = this.free[i];
    this.free.splice(i, 1);
    const dw = f.w - p.w;
    const dh = f.h - p.h;
    // one straight cut across the piece, then one across the part's strip
    const horizontalFirst = this.split === 'shorter' ? dw > dh : dw <= dh;
    if (horizontalFirst) {
      // cut along the length first: the strip below spans the whole piece
      if (dh > EPS) this.free.push({ x: f.x, y: f.y + p.h, w: f.w, h: dh });
      if (dw > EPS) this.free.push({ x: f.x + p.w, y: f.y, w: dw, h: p.h });
    } else {
      if (dw > EPS) this.free.push({ x: f.x + p.w, y: f.y, w: dw, h: f.h });
      if (dh > EPS) this.free.push({ x: f.x, y: f.y + p.h, w: p.w, h: dh });
    }
  }
}

type Bin = MaxRectsBin | GuillotineBin;

interface Run {
  bins: { bin: Bin; placed: PlacedPart[] }[];
  unplaced: Item[];
}

function pack(items: Item[], W: number, H: number, rotate: boolean, rule: Rule, make: () => Bin, kerf: number, margin: number, maxBins = Infinity): Run | null {
  const bins: Run['bins'] = [];
  const unplaced: Item[] = [];
  for (const it of items) {
    let done = false;
    // fill the sheets already started first
    for (const b of bins) {
      const p = b.bin.find(it, rotate, rule);
      if (!p) continue;
      b.bin.place(p.rect);
      b.placed.push({ part: it.part, n: it.n, x: margin + p.rect.x, y: margin + p.rect.y, length: p.rect.w - kerf, width: p.rect.h - kerf, rotated: p.rotated !== !!it.pre });
      done = true;
      break;
    }
    if (done) continue;
    if (bins.length >= maxBins) return null; // more sheets than allowed: give up early
    const bin = make();
    const p = bin.find(it, rotate, rule);
    if (!p) {
      unplaced.push(it);
      continue;
    }
    bin.place(p.rect);
    bins.push({ bin, placed: [{ part: it.part, n: it.n, x: margin + p.rect.x, y: margin + p.rect.y, length: p.rect.w - kerf, width: p.rect.h - kerf, rotated: p.rotated !== !!it.pre }] });
  }
  return { bins, unplaced };
}

const ORDERS: ((a: Item, b: Item) => number)[] = [
  (a, b) => b.w * b.h - a.w * a.h,
  (a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.w * b.h - a.w * a.h,
  (a, b) => b.h - a.h || b.w - a.w,
  (a, b) => b.w - a.w || b.h - a.h,
  (a, b) => b.w + b.h - (a.w + a.h),
];

type Orient = 'free' | 'long' | 'across';

interface Strategy {
  order: (a: Item, b: Item) => number;
  orient: Orient;
  rule: Rule;
  make: (W: number, H: number) => Bin;
}

/** Every part turned the same way round first, or each turned as it fits. */
function orientItems(items: Item[], orient: Orient): Item[] {
  if (orient === 'free') return items;
  return items.map((it) => {
    const turn = orient === 'long' ? it.w < it.h : it.w > it.h;
    return turn ? { ...it, w: it.h, h: it.w, pre: !it.pre } : it;
  });
}

function strategies(s: NestSettings): Strategy[] {
  const rules: Rule[] = s.cut === 'guillotine' ? ['area', 'short', 'long', 'bottomleft'] : ['short', 'long', 'area', 'bottomleft'];
  const makers: Strategy['make'][] =
    s.cut === 'guillotine' ? [(W, H) => new GuillotineBin(W, H, 'shorter'), (W, H) => new GuillotineBin(W, H, 'longer')] : [(W, H) => new MaxRectsBin(W, H)];
  // turning parts where it helps: each part as it fits best, or all with their long side along the sheet, or all across it
  const orients: Orient[] = s.rotate ? ['free', 'long', 'across'] : ['free'];
  const out: Strategy[] = [];
  for (const orient of orients) for (const order of ORDERS) for (const rule of rules) for (const make of makers) out.push({ order, orient, rule, make });
  return out;
}

function runStrategy(base: Item[], st: Strategy, W: number, H: number, s: NestSettings, maxBins = Infinity): Run | null {
  const items = orientItems(base, st.orient).sort((a, b) => st.order(a, b) || a.part - b.part || a.n - b.n);
  return pack(items, W, H, s.rotate && st.orient === 'free', st.rule, () => st.make(W, H), s.kerf, s.margin, maxBins);
}

/** Up to this many parts on the last sheet, its squeeze tries every strategy. */
const SQUEEZE_FULL = 300;

const offcutArea = (o: Offcut | null) => (o ? o.length * o.width : 0);

/** Nest the parts onto sheets of one size. */
export function nestParts(parts: NestPart[], sheet: { length: number; width: number }, s: NestSettings): NestResult {
  const usableL = sheet.length - 2 * s.margin;
  const usableW = sheet.width - 2 * s.margin;
  const W = usableL + s.kerf;
  const H = usableW + s.kerf;
  const base: Item[] = [];
  parts.forEach((p, part) => {
    for (let n = 1; n <= p.quantity; n++) base.push({ part, n, w: p.length + s.kerf, h: p.width + s.kerf });
  });
  const all = usableL > 0 && usableW > 0 ? strategies(s) : [];
  const offcut = (placed: PlacedPart[]) => offcutOf(sheet, reachOfParts(placed), s);
  let best: Run | null = null;
  let bestKey: number[] | null = null;
  for (const st of all) {
    const run = runStrategy(base, st, W, H, s)!;
    const last = run.bins[run.bins.length - 1];
    const reach = last ? reachOf(last.placed) : { l: 0, w: 0 };
    // fewest unplaced, then fewest sheets, then the biggest offcut left in one piece on the last sheet
    const key = [run.unplaced.length, run.bins.length, -Math.round(last ? offcutArea(offcut(last.placed)) : 0), Math.round(reach.l * reach.w)];
    if (!bestKey || lessThan(key, bestKey)) {
      best = run;
      bestKey = key;
    }
  }
  const run = best ?? { bins: [], unplaced: base };
  // gather the last sheet's parts into as short (or as narrow) a block as they go, for the biggest offcut
  if (run.bins.length) {
    const last = run.bins[run.bins.length - 1];
    const squeezed = squeeze(last.placed, all, W, H, s, sheet);
    if (squeezed && offcutArea(offcut(squeezed)) > offcutArea(offcut(last.placed)) + EPS) last.placed = squeezed;
  }
  const area = (p: { length: number; width: number }) => p.length * p.width;
  const sheetArea = sheet.length * sheet.width;
  const sheets: NestedSheet[] = run.bins.map((b) => {
    const placed = [...b.placed].sort((a, c) => a.y - c.y || a.x - c.x);
    const pa = placed.reduce((t, p) => t + area(p), 0);
    const r = reachOf(placed);
    return { parts: placed, parts_area: pa, utilisation: pa / sheetArea, reach_length: r.l, reach_width: r.w, offcut: offcut(placed) };
  });
  const unplaced = new Map<number, number>();
  for (const it of run.unplaced) unplaced.set(it.part, (unplaced.get(it.part) ?? 0) + 1);
  const partsArea = sheets.reduce((t, x) => t + x.parts_area, 0);
  const purchased = sheets.length * sheetArea;
  return {
    sheet: { length: sheet.length, width: sheet.width },
    usable_length: usableL,
    usable_width: usableW,
    sheets,
    unplaced: [...unplaced.entries()].map(([part, count]) => ({ part, count })),
    parts_area: partsArea,
    purchased_area: purchased,
    utilisation: purchased ? partsArea / purchased : 0,
    waste_area: purchased - partsArea,
  };
}

/**
 * The same parts packed into the shortest strip of the full width, and into
 * the narrowest strip of the full length (each found by halving, to the
 * millimetre); the arrangement leaving the bigger offcut wins. Null if
 * neither does better than the area the parts already fit.
 */
function squeeze(placed: PlacedPart[], all: Strategy[], W: number, H: number, s: NestSettings, sheet: { length: number; width: number }): PlacedPart[] | null {
  const items: Item[] = placed.map((p) => {
    // back to the part's own way round, so every strategy can turn it again
    const [l, w] = p.rotated ? [p.width, p.length] : [p.length, p.width];
    return { part: p.part, n: p.n, w: l + s.kerf, h: w + s.kerf };
  });
  const area = items.reduce((t, it) => t + it.w * it.h, 0);
  const minSide = (it: Item) => (s.rotate ? Math.min(it.w, it.h) : it.w);
  const minSideH = (it: Item) => (s.rotate ? Math.min(it.w, it.h) : it.h);
  // a big last sheet gets fewer tries per width, so the page stays quick
  const tries = items.length > SQUEEZE_FULL ? all.filter((st) => st.order === ORDERS[0] || st.order === ORDERS[1]) : all;
  const fitOne = (w: number, h: number): PlacedPart[] | null => {
    for (const st of tries) {
      const r = runStrategy(items, st, w, h, s, 1);
      if (r && !r.unplaced.length && r.bins.length === 1) return r.bins[0].placed;
    }
    return null;
  };
  const shortest = (lo: number, hi: number, fit: (v: number) => PlacedPart[] | null): PlacedPart[] | null => {
    let found: PlacedPart[] | null = null;
    let a = Math.ceil(lo);
    let b = Math.floor(hi);
    while (a <= b) {
      const m = Math.floor((a + b) / 2);
      const f = fit(m);
      if (f) {
        found = f;
        b = m - 1;
      } else a = m + 1;
    }
    return found;
  };
  const reach = reachOf(placed);
  const cands: PlacedPart[][] = [];
  const endHi = reach.l - s.margin + s.kerf - 1; // something shorter than now
  const endLo = Math.max(area / H, ...items.map(minSide));
  if (endLo <= endHi) {
    const f = shortest(endLo, endHi, (v) => fitOne(v, H));
    if (f) cands.push(f);
  }
  const edgeHi = reach.w - s.margin + s.kerf - 1;
  const edgeLo = Math.max(area / W, ...items.map(minSideH));
  if (edgeLo <= edgeHi) {
    const f = shortest(edgeLo, edgeHi, (v) => fitOne(W, v));
    if (f) cands.push(f);
  }
  if (!cands.length) return null;
  const score = (c: PlacedPart[]) => offcutArea(offcutOf(sheet, reachOfParts(c), s));
  return cands.reduce((a, b) => (score(b) > score(a) + EPS ? b : a));
}

/** Compares two score lists entry by entry: the first difference decides. */
function lessThan(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

function reachOf(placed: PlacedPart[]) {
  let l = 0;
  let w = 0;
  for (const p of placed) {
    l = Math.max(l, p.x + p.length);
    w = Math.max(w, p.y + p.width);
  }
  return { l, w };
}

/**
 * Checks a nested sheet the way a shop would: every part inside the margin
 * line, and at least one kerf between any two parts. Returns what is wrong,
 * or an empty list. Used by the tests, and cheap enough to run on every result.
 */
export function checkSheet(sheet: NestedSheet, size: { length: number; width: number }, s: { kerf: number; margin: number }): string[] {
  const problems: string[] = [];
  const t = 1e-6;
  for (const p of sheet.parts) {
    if (p.x < s.margin - t || p.y < s.margin - t || p.x + p.length > size.length - s.margin + t || p.y + p.width > size.width - s.margin + t)
      problems.push(`part ${p.part}#${p.n} crosses the margin`);
  }
  for (let i = 0; i < sheet.parts.length; i++)
    for (let j = i + 1; j < sheet.parts.length; j++) {
      const a = sheet.parts[i];
      const b = sheet.parts[j];
      const apartX = a.x + a.length + s.kerf <= b.x + t || b.x + b.length + s.kerf <= a.x + t;
      const apartY = a.y + a.width + s.kerf <= b.y + t || b.y + b.width + s.kerf <= a.y + t;
      if (!apartX && !apartY) problems.push(`parts ${a.part}#${a.n} and ${b.part}#${b.n} are closer than the kerf`);
    }
  return problems;
}

/** Part letters for labels: A, B, … Z, AA, AB … */
export function partLetter(i: number): string {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/**
 * The layout as a DXF (AutoCAD R12 ASCII, millimetres) that laser, plasma and
 * CAM software read: each sheet's outline and margin line, every part as a
 * closed outline with its label, the offcut kept in one piece on layer
 * OFFCUT, sheets placed one below the other. Y is
 * flipped to DXF's upward axis.
 */
export function nestingDxf(r: NestResult, parts: NestPart[], s: { margin: number }, letters: string[] = parts.map((_, i) => partLetter(i))): string {
  const out: string[] = [];
  const add = (...pairs: (string | number)[]) => {
    for (let i = 0; i < pairs.length; i += 2) out.push(String(pairs[i]), typeof pairs[i + 1] === 'number' ? fmtNum(pairs[i + 1] as number) : String(pairs[i + 1]));
  };
  const line = (layer: string, x1: number, y1: number, x2: number, y2: number) => add(0, 'LINE', 8, layer, 10, x1, 20, y1, 30, 0, 11, x2, 21, y2, 31, 0);
  const box = (layer: string, x: number, y: number, w: number, h: number) => {
    line(layer, x, y, x + w, y);
    line(layer, x + w, y, x + w, y + h);
    line(layer, x + w, y + h, x, y + h);
    line(layer, x, y + h, x, y);
  };
  const text = (layer: string, x: number, y: number, h: number, value: string) => add(0, 'TEXT', 8, layer, 10, x, 20, y, 30, 0, 40, h, 1, value.replace(/[\r\n]/g, ' '));
  add(0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1009', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC');
  add(0, 'SECTION', 2, 'TABLES', 0, 'TABLE', 2, 'LAYER', 70, 4);
  for (const [name, colour] of [['SHEET', 8], ['MARGIN', 9], ['PARTS', 1], ['LABELS', 3], ['OFFCUT', 5]] as const) add(0, 'LAYER', 2, name, 70, 0, 62, colour, 6, 'CONTINUOUS');
  add(0, 'ENDTAB', 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES');
  const L = r.sheet.length;
  const Wd = r.sheet.width;
  const gap = Math.max(100, Wd * 0.1);
  r.sheets.forEach((sh, k) => {
    const oy = -k * (Wd + gap); // sheet k's top edge, in DXF Y
    const Y = (y: number) => oy - y; // board Y (down) to DXF Y (up)
    box('SHEET', 0, Y(Wd), L, Wd);
    if (s.margin > 0) box('MARGIN', s.margin, Y(Wd - s.margin), L - 2 * s.margin, Wd - 2 * s.margin);
    text('LABELS', 0, Y(0) + Math.max(10, Wd * 0.015), Math.max(12, Wd * 0.025), `Sheet ${k + 1} of ${r.sheets.length}  ${fmtNum(L)} x ${fmtNum(Wd)} mm`);
    for (const p of sh.parts) {
      box('PARTS', p.x, Y(p.y + p.width), p.length, p.width);
      const h = Math.max(4, Math.min(p.width * 0.25, p.length * 0.12, 40));
      text('LABELS', p.x + h * 0.5, Y(p.y + p.width / 2) - h / 2, h, `${letters[p.part] ?? partLetter(p.part)}${p.n} ${parts[p.part]?.name ?? ''}`.trim());
    }
    // the offcut kept in one piece, on its own layer so the cutting program can leave it out
    const o = sh.offcut;
    if (o) {
      box('OFFCUT', o.x, Y(o.y + o.width), o.length, o.width);
      const h = Math.max(6, Math.min(o.width * 0.12, o.length * 0.06, 40));
      text('OFFCUT', o.x + h, Y(o.y + o.width / 2) - h / 2, h, `OFFCUT ${fmtNum(o.length)} x ${fmtNum(o.width)}`);
    }
  });
  add(0, 'ENDSEC', 0, 'EOF');
  return out.join('\r\n') + '\r\n';
}

function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}
