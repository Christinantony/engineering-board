// Sheet patterns that turn parts where it helps, and keep the offcut in one
// piece (decision #44).
//
// The workbook's grid (sheets.ts, decision #32) lays every part the same way
// round. A block of parts one way and a block turned 90° beside it often fits
// more, and on a part-used sheet the parts can be gathered at one end so the
// rest comes off with one straight cut as a single reusable offcut.
//
// For one part size this finds the best guillotine pattern exactly: every
// block boundary is a straight cut right across, so a panel saw or a shear can
// cut it as well as a laser. It is a dynamic programme over the "normal"
// positions (sums of the part's two sides, each grown by the kerf); for very
// small parts, where those positions run into millions of states, it falls
// back to two blocks side by side, which is nearly as good there.

/** A part on the sheet, from the sheet's corner (margin included), mm. */
export interface PatternPart {
  x: number;
  y: number;
  /** as placed, along the sheet's length and width */
  length: number;
  width: number;
  rotated: boolean;
}

/** The leftover cut off in one piece by one straight cut right across the sheet. */
export interface Offcut {
  x: number;
  y: number;
  length: number;
  width: number;
  /** 'end': across the far end of the length; 'edge': along the length */
  side: 'end' | 'edge';
}

/**
 * The larger of the two strips left beyond the parts: across the far end, or
 * along the far edge. The cut itself takes one kerf. A strip narrower than
 * twice the margin (and 10 mm) has nothing usable in it once its own edges are
 * trimmed again, so none is reported.
 */
export function offcutOf(
  sheet: { length: number; width: number },
  reach: { length: number; width: number },
  s: { kerf: number; margin: number },
): Offcut | null {
  const x0 = reach.length + s.kerf;
  const y0 = reach.width + s.kerf;
  const end: Offcut = { x: x0, y: 0, length: sheet.length - x0, width: sheet.width, side: 'end' };
  const edge: Offcut = { x: 0, y: y0, length: sheet.length, width: sheet.width - y0, side: 'edge' };
  const min = Math.max(10, 2 * s.margin);
  const ok = (o: Offcut) => Math.min(o.length, o.width) >= min - 1e-6;
  const cands = [end, edge].filter(ok);
  if (!cands.length) return null;
  return cands.reduce((a, b) => (b.length * b.width > a.length * a.width + 1e-6 ? b : a));
}

export function reachOfParts(parts: { x: number; y: number; length: number; width: number }[]) {
  let length = 0;
  let width = 0;
  for (const p of parts) {
    length = Math.max(length, p.x + p.length);
    width = Math.max(width, p.y + p.width);
  }
  return { length, width };
}

/** A part-used or full sheet: where the parts go, and the offcut. */
export interface SheetPattern {
  /** the slots of the pattern, in cutting order (rows from the corner); the first `count` are used */
  parts: PatternPart[];
  count: number;
  offcut: Offcut | null;
}

const EPS = 1e-6;
/** Above this much work the exact search gives way to two blocks side by side. */
const MAX_WORK = 4e6;

/** Sums i·p + j·q up to the limit, sorted. */
function normals(p: number, q: number, limit: number): number[] {
  const set = new Set<number>();
  for (let i = 0; i * p <= limit + EPS; i++) for (let j = 0; i * p + j * q <= limit + EPS; j++) if (i + j > 0) set.add(Math.round((i * p + j * q) * 1e6) / 1e6);
  return [...set].sort((a, b) => a - b);
}

/** Index of the largest value ≤ x, or -1. */
function floorIndex(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length - 1;
  let r = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] <= x + EPS) {
      r = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return r;
}

type Choice = { t: 0 | 1 } | { t: 2; at: number } | { t: 3; at: number };

/**
 * Identical a × b parts on a usable area, kerf between neighbours, turned or not.
 * All sizes are in mm; positions come out from the usable area's corner.
 */
export class IdenticalPacker {
  private pa: number;
  private pb: number;
  private NL: number[];
  private NW: number[];
  private exact: boolean;
  private val?: Int32Array;
  private cho?: Choice[];

  constructor(
    private usableL: number,
    private usableW: number,
    private a: number,
    private b: number,
    private kerf: number,
    private rotate: boolean,
  ) {
    this.pa = a + kerf;
    this.pb = b + kerf;
    const PL = usableL + kerf;
    const PW = usableW + kerf;
    const ok = usableL > 0 && usableW > 0 && a > 0 && b > 0;
    if (!ok) {
      this.NL = [];
      this.NW = [];
      this.exact = false;
      return;
    }
    // without turning, lengths are made of a's only and widths of b's only
    this.NL = rotate ? normals(this.pa, this.pb, PL) : normals(this.pa, this.pa, PL);
    this.NW = rotate ? normals(this.pb, this.pa, PW) : normals(this.pb, this.pb, PW);
    const work = this.NL.length * this.NW.length * (this.NL.length + this.NW.length);
    this.exact = rotate && work <= MAX_WORK && Math.abs(a - b) > EPS;
    if (this.exact) this.solve();
  }

  private grid(x: number, y: number, turned: boolean) {
    const [p, q] = turned ? [this.pb, this.pa] : [this.pa, this.pb];
    return Math.floor((x + EPS) / p) * Math.floor((y + EPS) / q);
  }

  private solve() {
    const nl = this.NL.length;
    const nw = this.NW.length;
    const val = new Int32Array(nl * nw);
    const cho: Choice[] = new Array(nl * nw);
    const restL = this.NL.map(() => [] as number[]);
    for (let xi = 0; xi < nl; xi++) {
      const x = this.NL[xi];
      for (let i = 0; i < nl && this.NL[i] <= x / 2 + EPS; i++) restL[xi].push(i, floorIndex(this.NL, x - this.NL[i]));
    }
    const restW = this.NW.map(() => [] as number[]);
    for (let yi = 0; yi < nw; yi++) {
      const y = this.NW[yi];
      for (let i = 0; i < nw && this.NW[i] <= y / 2 + EPS; i++) restW[yi].push(i, floorIndex(this.NW, y - this.NW[i]));
    }
    for (let xi = 0; xi < nl; xi++)
      for (let yi = 0; yi < nw; yi++) {
        const x = this.NL[xi];
        const y = this.NW[yi];
        let best = this.grid(x, y, false);
        let c: Choice = { t: 0 };
        const g2 = this.grid(x, y, true);
        if (g2 > best) {
          best = g2;
          c = { t: 1 };
        }
        const rl = restL[xi];
        for (let k = 0; k < rl.length; k += 2) {
          const r = rl[k + 1];
          if (r < 0) continue;
          const v = val[rl[k] * nw + yi] + val[r * nw + yi];
          if (v > best) {
            best = v;
            c = { t: 2, at: rl[k] };
          }
        }
        const rw = restW[yi];
        for (let k = 0; k < rw.length; k += 2) {
          const r = rw[k + 1];
          if (r < 0) continue;
          const v = val[xi * nw + rw[k]] + val[xi * nw + r];
          if (v > best) {
            best = v;
            c = { t: 3, at: rw[k] };
          }
        }
        val[xi * nw + yi] = best;
        cho[xi * nw + yi] = c;
      }
    this.val = val;
    this.cho = cho;
  }

  /** The most parts in a block x long and y wide (grown sizes), and how. */
  private best(x: number, y: number): { count: number; build: (ox: number, oy: number, out: PatternPart[]) => void } {
    const xi = floorIndex(this.NL, x);
    const yi = floorIndex(this.NW, y);
    if (xi < 0 || yi < 0) return { count: 0, build: () => {} };
    if (this.exact) return { count: this.val![xi * this.NW.length + yi], build: (ox, oy, out) => this.buildExact(xi, yi, ox, oy, out) };
    // two blocks side by side (or one), along either direction
    const X = this.NL[xi];
    const Y = this.NW[yi];
    const turns = this.rotate ? [false, true] : [false];
    let bestCount = -1;
    let bestBuild: (ox: number, oy: number, out: PatternPart[]) => void = () => {};
    const consider = (count: number, build: typeof bestBuild) => {
      if (count > bestCount) {
        bestCount = count;
        bestBuild = build;
      }
    };
    for (const t of turns) consider(this.grid(X, Y, t), (ox, oy, out) => this.emitGrid(X, Y, t, ox, oy, out));
    if (this.rotate)
      for (const [t1, t2] of [
        [false, true],
        [true, false],
      ]) {
        for (const x1 of this.NL) {
          if (x1 > X + EPS) break;
          const x2 = X - x1;
          consider(this.grid(x1, Y, t1) + this.grid(x2, Y, t2), (ox, oy, out) => {
            this.emitGrid(x1, Y, t1, ox, oy, out);
            this.emitGrid(x2, Y, t2, ox + x1, oy, out);
          });
        }
        for (const y1 of this.NW) {
          if (y1 > Y + EPS) break;
          const y2 = Y - y1;
          consider(this.grid(X, y1, t1) + this.grid(X, y2, t2), (ox, oy, out) => {
            this.emitGrid(X, y1, t1, ox, oy, out);
            this.emitGrid(X, y2, t2, ox, oy + y1, out);
          });
        }
      }
    return { count: Math.max(0, bestCount), build: bestBuild };
  }

  private emitGrid(x: number, y: number, turned: boolean, ox: number, oy: number, out: PatternPart[]) {
    const [p, q] = turned ? [this.pb, this.pa] : [this.pa, this.pb];
    const cols = Math.floor((x + EPS) / p);
    const rows = Math.floor((y + EPS) / q);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) out.push({ x: ox + c * p, y: oy + r * q, length: p - this.kerf, width: q - this.kerf, rotated: turned });
  }

  private buildExact(xi: number, yi: number, ox: number, oy: number, out: PatternPart[]) {
    const c = this.cho![xi * this.NW.length + yi];
    const x = this.NL[xi];
    const y = this.NW[yi];
    if (c.t === 0 || c.t === 1) return this.emitGrid(x, y, c.t === 1, ox, oy, out);
    if (c.t === 2) {
      const x1 = this.NL[c.at];
      this.buildExact(c.at, yi, ox, oy, out);
      this.buildExact(floorIndex(this.NL, x - x1), yi, ox + x1, oy, out);
    } else if (c.t === 3) {
      const y1 = this.NW[c.at];
      this.buildExact(xi, c.at, ox, oy, out);
      this.buildExact(xi, floorIndex(this.NW, y - y1), ox, oy + y1, out);
    }
  }

  /** Most parts on a whole sheet. */
  perSheet(): number {
    return this.best(this.usableL + this.kerf, this.usableW + this.kerf).count;
  }

  /**
   * n parts gathered at one end or one edge, whichever leaves the bigger
   * offcut in one piece; positions from the sheet's corner. n ≤ perSheet().
   */
  arrange(n: number, sheet: { length: number; width: number }, margin: number): SheetPattern {
    const PL = this.usableL + this.kerf;
    const PW = this.usableW + this.kerf;
    const full = this.best(PL, PW);
    const want = Math.min(n, full.count);
    const shortest = (vals: number[], ok: (v: number) => boolean) => {
      let lo = 0;
      let hi = vals.length - 1;
      let r = vals.length - 1;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (ok(vals[m])) {
          r = m;
          hi = m - 1;
        } else lo = m + 1;
      }
      return vals[r];
    };
    const options: { x: number; y: number }[] = [];
    if (want > 0 && this.NL.length && this.NW.length) {
      options.push({ x: shortest(this.NL, (x) => this.best(x, PW).count >= want), y: PW });
      options.push({ x: PL, y: shortest(this.NW, (y) => this.best(PL, y).count >= want) });
    }
    let bestPattern: SheetPattern = { parts: [], count: 0, offcut: null };
    let bestArea = -1;
    for (const o of options) {
      const b = this.best(o.x, o.y);
      const parts: PatternPart[] = [];
      b.build(margin, margin, parts);
      parts.sort((p, q) => p.y - q.y || p.x - q.x);
      // the offcut beyond the parts actually used
      const used = parts.slice(0, want);
      const off = offcutOf(sheet, reachOfParts(used), { kerf: this.kerf, margin });
      const area = off ? off.length * off.width : 0;
      if (area > bestArea + EPS) {
        bestArea = area;
        bestPattern = { parts, count: want, offcut: off };
      }
    }
    return bestPattern;
  }
}
