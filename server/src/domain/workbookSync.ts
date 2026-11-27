// The workbook link (decision #47): the inventory workbook and a project's
// procurement list kept as one list, changed in either place.
//
// The workbook's macro posts every Master List row as two sets of cell
// values: what the row held after the last sync (the base) and what it holds
// now. The board merges cell by cell against its own value:
//   - unchanged in the workbook        -> the board's value goes to the workbook
//   - changed only in the workbook     -> the workbook's value is saved here
//   - changed in both, to the same     -> nothing to do
//   - changed in both, differently     -> a conflict: nothing is overwritten,
//                                         and the workbook asks which to keep
// The reply is the whole list, so the macro only writes cells. All the rules
// live here, where they are tested; the macro has none of its own.
//
// The wire format is lines of tab-separated fields in plain ASCII (VBA has no
// JSON parser and its HTTP objects mangle non-ASCII text): `\t`, `\n`, `\\`
// and `\uXXXX` escapes.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  PROCUREMENT_COATING_LABEL,
  basisForCategory,
  hasBoardAccess,
  type ProcurementBasis,
  type ProcurementCoating,
  type ProcurementItem,
  type ProcurementMeans,
  type User,
} from '@board/shared';
import { all, get, run, tx } from '../db/connection.ts';
import { HttpError, badRequest, forbidden, notFound, nowIso, type Ctx } from '../lib/core.ts';
import { localDate, tzOffsetMs } from '../lib/time.ts';
import { getSetting } from './auth.ts';
import { getPermissions } from './permissions.ts';
import { addItem, editItem, getBuild, procurement, removeItem, setBuild, setStock } from './procurement.ts';
import { getProject } from './projects.ts';
import { getUser } from './users.ts';

export const SYNC_PROTOCOL = 'EB1';

// ---------- the wire format ----------

/** One field as plain ASCII: backslash escapes for tab, newline, backslash and anything outside printable ASCII. */
export function esc(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 92) out += '\\\\';
    else if (c === 9) out += '\\t';
    else if (c === 10) out += '\\n';
    else if (c === 13) continue;
    else if (c < 32 || c > 126) out += '\\u' + c.toString(16).padStart(4, '0');
    else out += value[i];
  }
  return out;
}

export function unesc(value: string): string {
  if (!value.includes('\\')) return value;
  return value.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, e: string) =>
    e === 't' ? '\t' : e === 'n' ? '\n' : e === 'r' ? '' : e[0] === 'u' && e.length === 5 ? String.fromCharCode(parseInt(e.slice(1), 16)) : e,
  );
}

const line = (...fields: (string | number | null)[]) => fields.map((f) => esc(f === null ? '' : String(f))).join('\t');

// ---------- cells ----------

/**
 * The cells of a Master List row that are kept in step, in wire order. `qty`
 * is Qty / unit. `total` is the part's own total when it is not the one its
 * category gives (a typed number, or a formula of the person's own such as
 * =D49), and empty when it is; the macro sends whatever the Total qty cell
 * shows and `ownTotal` works out which it is. `status` is the In stock tick
 * ('1' or '0').
 */
export const SYNC_FIELDS = ['name', 'spec', 'qty', 'total', 'inventory', 'material', 'remarks', 'coating', 'category', 'discipline', 'means', 'status'] as const;
export type SyncField = (typeof SYNC_FIELDS)[number];
export type Cells = Record<SyncField, string>;
const N = SYNC_FIELDS.length;

const FIELD_LABEL: Record<SyncField, string> = {
  name: 'Part name',
  spec: 'Final size',
  qty: 'Qty / unit',
  total: 'Total qty',
  inventory: 'Inventory',
  material: 'Material',
  remarks: 'Remarks',
  coating: 'Coating',
  category: 'Category',
  discipline: 'Discipline',
  means: 'Means',
  status: 'Status',
};

const MEANS_CELL: Record<ProcurementMeans, string> = { outsourced: 'OUTSOURCED', in_house: 'IN-HOUSE', bought_out: 'BOUGHT-OUT', tools: 'TOOLS' };
const num = (n: number) => String(Math.round(n * 1000) / 1000);
const toNumber = (s: string): number | null => {
  const t = s.trim();
  if (!t || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  return Number(t);
};
const squash = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

function meansOf(cell: string): ProcurementMeans | null {
  const k = cell.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (k === 'outsourced') return 'outsourced';
  if (k === 'inhouse') return 'in_house';
  if (k === 'boughtout') return 'bought_out';
  if (k === 'tools' || k === 'tool') return 'tools';
  return null;
}

function coatingOf(cell: string): ProcurementCoating | null {
  const k = cell.trim().toLowerCase().replace(/[\s./_-]+/g, '');
  if (!k) return '';
  if (k === 'na' || k === 'notapplicable' || k === 'none' || k === 'nil') return 'na';
  if (k === 'pending') return 'pending';
  if (k === 'done' || k === 'complete' || k === 'completed') return 'done';
  return null;
}

/** The workbook's Inventory cell: a count, NIL for none, or a note. As the board's own Inventory box reads it. */
export function inventoryOf(cell: string): { inventory: number | null; inventory_note: string } {
  const t = cell.trim();
  if (!t) return { inventory: null, inventory_note: '' };
  if (/^nil$/i.test(t)) return { inventory: 0, inventory_note: '' };
  const n = toNumber(t);
  if (n !== null && n >= 0) return { inventory: n, inventory_note: '' };
  return { inventory: null, inventory_note: t.slice(0, 80) };
}

/**
 * Is the part counted the way its category says? Then the workbook's own
 * Total qty formula gives the board's total and that cell is left to it. A
 * category the workbook doesn't count by (or none) is counted in total.
 */
const followsCategory = (i: Pick<ProcurementItem, 'basis' | 'category'>) => (basisForCategory(i.category) ?? 'total') === i.basis;

/** A board item as the workbook's cells. */
export function toCells(i: ProcurementItem): Cells {
  return {
    name: i.name,
    spec: i.spec,
    qty: num(i.quantity),
    // a total the workbook's formula would not give is typed into Total qty
    total: followsCategory(i) ? '' : num(i.required),
    inventory: i.inventory !== null ? num(i.inventory) : i.inventory_note,
    material: i.material,
    remarks: i.notes,
    coating: PROCUREMENT_COATING_LABEL[i.coating].toUpperCase(),
    category: i.category,
    discipline: i.discipline,
    means: MEANS_CELL[i.means],
    status: i.in_stock_at ? '1' : '0',
  };
}

/** Do two cell values say the same thing? Numbers by value, lists by meaning, text without stray spaces. */
export function sameCell(f: SyncField, a: string, b: string): boolean {
  if (a === b) return true;
  switch (f) {
    case 'qty':
    case 'total': {
      const x = toNumber(a);
      const y = toNumber(b);
      return x !== null && y !== null ? Math.abs(x - y) < 1e-9 : a.trim() === b.trim();
    }
    case 'inventory': {
      const x = inventoryOf(a);
      const y = inventoryOf(b);
      return x.inventory === y.inventory && x.inventory_note === y.inventory_note;
    }
    case 'means': {
      const x = meansOf(a);
      return x !== null ? x === meansOf(b) : squash(a) === squash(b);
    }
    case 'coating': {
      const x = coatingOf(a);
      return x !== null ? x === coatingOf(b) : squash(a) === squash(b);
    }
    case 'status':
      return (a.trim() === '1') === (b.trim() === '1');
    case 'category':
    case 'discipline':
      return squash(a) === squash(b);
    default:
      return a.trim() === b.trim();
  }
}

/** What the workbook's three driver cells say the project builds. */
export interface Drivers {
  arrays: number;
  antennas: number;
}

/** The total the workbook's own formula gives a row: Qty / unit times the antennas, the arrays or 1, by its category. */
function categoryTotal(c: Pick<Cells, 'qty' | 'category'>, d: Drivers): number | null {
  const q = toNumber(c.qty);
  if (q === null) return null;
  const basis = basisForCategory(c.category) ?? 'total';
  return q * (basis === 'antenna' ? d.antennas : basis === 'array' ? d.arrays : 1);
}

/**
 * A row's own total: what its Total qty cell shows when that is not what its
 * category gives, else ''. So a row left to the workbook's formula has none,
 * and a typed total or a formula of the person's own (=D49) has.
 */
export function ownTotal(c: Pick<Cells, 'qty' | 'total' | 'category'>, d: Drivers): string {
  const shown = toNumber(c.total);
  if (shown === null) return '';
  const byCategory = categoryTotal(c, d);
  return byCategory !== null && Math.abs(byCategory - shown) < 1e-6 ? '' : num(shown);
}

class RowProblem extends Error {}

/** What a row's cells say about the item, ready for addItem or editItem. A RowProblem says what is missing. */
function fromCells(c: Cells) {
  const name = c.name.trim();
  if (!name) throw new RowProblem('Part name is empty.');
  const means = meansOf(c.means);
  if (!means) throw new RowProblem(c.means.trim() ? `Means "${c.means.trim()}" is not one of OUTSOURCED, IN-HOUSE, BOUGHT-OUT, TOOLS.` : 'Choose the Means.');
  const coating = coatingOf(c.coating);
  if (coating === null) throw new RowProblem(`Coating "${c.coating.trim()}" is not one of N/A, PENDING, DONE.`);
  const typed = toNumber(c.total);
  let quantity: number;
  let basis: ProcurementBasis;
  if (c.total.trim()) {
    // Total qty typed by hand: that number is what the project needs
    if (typed === null || typed <= 0) throw new RowProblem('Total qty is typed by hand and is not a number above 0.');
    quantity = typed;
    basis = 'total';
  } else {
    const q = toNumber(c.qty);
    if (q === null || q <= 0) throw new RowProblem(c.qty.trim() ? `Qty / unit "${c.qty.trim()}" is not a number above 0.` : 'Enter the Qty / unit.');
    quantity = q;
    basis = basisForCategory(c.category) ?? 'total';
  }
  const category = c.category.trim();
  if (category.length > 40) throw new RowProblem('Category is longer than 40 characters.');
  return {
    name: name.slice(0, 120),
    spec: c.spec.trim().slice(0, 200),
    quantity,
    basis,
    ...inventoryOf(c.inventory),
    material: c.material.trim().slice(0, 80),
    notes: c.remarks.trim().slice(0, 500),
    coating,
    category,
    discipline: c.discipline.trim().slice(0, 40),
    means,
  };
}

// ---------- keys ----------

const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

/** Tells one project's list on this board from any other, so a copied workbook is noticed. */
export function linkToken(ctx: Ctx, projectId: number): string {
  return createHmac('sha256', getSetting(ctx, 'cookie_secret') ?? '').update(`workbook-link:${projectId}`).digest('hex').slice(0, 16);
}

export interface SyncKeyRow {
  id: number;
  project_id: number;
  user_id: number;
  hint: string;
  created_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}

/** A project's link: its keys (never the keys themselves) and what the last syncs changed. */
export function workbookLink(ctx: Ctx, projectId: number) {
  getProject(ctx, projectId);
  return {
    keys: all<SyncKeyRow>(ctx.db, 'SELECT id, project_id, user_id, hint, created_at, revoked_at, last_used_at FROM sync_keys WHERE project_id = ? ORDER BY id DESC', projectId),
    log: all<{ id: number; user_id: number; at: string; added: number; changed: number; removed: number; stock: number; build: number; conflicts: number }>(
      ctx.db,
      'SELECT id, user_id, at, added, changed, removed, stock, build, conflicts FROM sync_log WHERE project_id = ? ORDER BY id DESC LIMIT 30',
      projectId,
    ),
  };
}

/** A new key for the signed-in person's workbook. The key is shown once; only its hash is kept. */
export function createSyncKey(ctx: Ctx, actor: User, projectId: number): { key: string; row: SyncKeyRow } {
  return tx(ctx.db, () => {
    getProject(ctx, projectId);
    const key = 'eb_' + randomBytes(24).toString('base64url');
    const id = Number(
      run(ctx.db, 'INSERT INTO sync_keys (project_id, user_id, key_hash, hint, created_at) VALUES (?, ?, ?, ?, ?)', projectId, actor.id, hashKey(key), key.slice(-4), nowIso(ctx)).lastInsertRowid,
    );
    ctx.events.emit({ type: 'procurement', id: projectId });
    return { key, row: get<SyncKeyRow>(ctx.db, 'SELECT id, project_id, user_id, hint, created_at, revoked_at, last_used_at FROM sync_keys WHERE id = ?', id)! };
  });
}

/** Switch a key off. Your own, or anyone's for the manager or an admin. */
export function revokeSyncKey(ctx: Ctx, actor: User, id: number, isAdmin: boolean): { revoked: true } {
  return tx(ctx.db, () => {
    const k = get<SyncKeyRow>(ctx.db, 'SELECT id, project_id, user_id, hint, created_at, revoked_at, last_used_at FROM sync_keys WHERE id = ?', id);
    if (!k) throw notFound('Key');
    if (k.user_id !== actor.id && actor.role !== 'manager' && !isAdmin) throw forbidden('You can switch off only your own workbook keys.');
    if (!k.revoked_at) run(ctx.db, 'UPDATE sync_keys SET revoked_at = ? WHERE id = ?', nowIso(ctx), id);
    ctx.events.emit({ type: 'procurement', id: k.project_id });
    return { revoked: true };
  });
}

interface SyncAuth {
  key: SyncKeyRow;
  user: User;
}

/** Who a key belongs to, or a 401/403 saying why it does not work. */
export function authenticateSyncKey(ctx: Ctx, key: string | undefined): SyncAuth {
  const denied = () => new HttpError(401, 'unauthenticated', 'That workbook key is not known to this board. Make a new one on the project\'s Procurement page.');
  if (!key || key.length > 200) throw denied();
  const k = get<SyncKeyRow>(ctx.db, 'SELECT id, project_id, user_id, hint, created_at, revoked_at, last_used_at FROM sync_keys WHERE key_hash = ?', hashKey(key.trim()));
  if (!k) throw denied();
  if (k.revoked_at) throw new HttpError(401, 'unauthenticated', 'That workbook key has been switched off. Make a new one on the project\'s Procurement page.');
  const user = getUser(ctx, k.user_id);
  if (!user || !user.active) throw forbidden('The person this workbook key belongs to is no longer active on the board.');
  if (user.role === 'purchase' || !hasBoardAccess(getPermissions(ctx), user)) throw forbidden('This workbook key belongs to someone who cannot change the procurement list.');
  // a note of use, at most every five minutes: a workbook left open asks twice a minute
  const now = ctx.now().getTime();
  if (!k.last_used_at || now - Date.parse(k.last_used_at) > 300_000) run(ctx.db, 'UPDATE sync_keys SET last_used_at = ? WHERE id = ?', nowIso(ctx), k.id);
  return { key: k, user };
}

// ---------- the sync ----------

interface Row {
  id: number | null;
  ref: string;
  base: Cells;
  cur: Cells;
}

function cellsFrom(fields: string[], at: number): Cells {
  const c = {} as Cells;
  SYNC_FIELDS.forEach((f, n) => (c[f] = fields[at + n] ?? ''));
  return c;
}

const problem = (e: unknown): string => {
  if (e instanceof RowProblem || e instanceof HttpError) return e.message;
  throw e;
};

/** The board's local date and time, as the workbook shows it. */
function localStamp(ctx: Ctx, iso: string | null): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  const t = new Date(ms + tzOffsetMs(ms, ctx.tz));
  return `${localDate(ms, ctx.tz)} ${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}

interface StatusRow {
  id: number;
  stage: string | null;
  in_process: number | null;
  received: number | null;
  accepted: number | null;
  rejected: number | null;
  promise: string | null;
  order_status: string | null;
  po_ref: string | null;
  vendor: string | null;
  next_action: string | null;
  next_due: string | null;
}

/**
 * One round of the workbook's sync. `body` is what the macro posted; the
 * reply is what it should do and the whole list as it now stands.
 */
export function syncWorkbook(ctx: Ctx, auth: SyncAuth, body: string): string {
  const lines = body
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.length)
    .map((l) => l.split('\t').map(unesc));
  const head = lines[0];
  if (!head || head[0] !== SYNC_PROTOCOL || head[1] !== 'sync')
    throw badRequest('This workbook\'s sync macro is not one this board understands. Download the current macro from the project\'s Procurement page.');
  const mode = head[2] === 'first-replace' || head[2] === 'first-merge' ? head[2] : 'auto';
  const projectId = auth.key.project_id;
  const token = linkToken(ctx, projectId);
  const project = getProject(ctx, projectId);

  const rows: Row[] = [];
  const deletes: number[] = [];
  let buildLine: string[] | null = null;
  for (const f of lines.slice(1)) {
    if (f[0] === 'R') {
      if (f.length < 3 + 2 * N) throw badRequest('A row in the workbook\'s sync message is incomplete.');
      const id = /^\d+$/.test(f[1]) ? Number(f[1]) : null;
      rows.push({ id, ref: f[2], base: cellsFrom(f, 3), cur: cellsFrom(f, 3 + N) });
    } else if (f[0] === 'D' && /^\d+$/.test(f[1] ?? '')) deletes.push(Number(f[1]));
    else if (f[0] === 'B') buildLine = f;
  }
  // The Total qty cells show what the workbook's own drivers make them, so they are read against those
  // (the board's, where the workbook has none): a row whose total is its category's has no total of its own.
  const serverBuild = getBuild(ctx, auth.key.project_id);
  const wb = [4, 5, 6].map((n) => toNumber((buildLine?.[n] ?? '').trim() || '0'));
  const drivers: Drivers =
    buildLine && buildLine.length >= 7 && wb.every((v) => v !== null) && buildLine.slice(4, 7).some((v) => v.trim())
      ? { arrays: wb[0]!, antennas: wb[0]! * wb[1]! + wb[2]! }
      : { arrays: serverBuild.arrays, antennas: serverBuild.antennas };
  /** what each row's Total qty cell showed, before it is reduced to the row's own total */
  const shown = new Map<string, number | null>();
  for (const r of rows) {
    shown.set(r.ref, toNumber(r.cur.total));
    r.cur.total = ownTotal(r.cur, drivers);
  }
  if (rows.length > 500) throw badRequest('The workbook lists more than 500 parts.');

  // a workbook linked to another project or another board starts again from nothing
  if (head[3] && head[3] !== token) return line(SYNC_PROTOCOL, 'relink', token, project.name) + '\n';

  return tx(ctx.db, () => {
    const live = () => procurement(ctx, projectId).items;
    // a workbook that has never synced meeting a list that already has parts: ask before touching either
    const firstTime = !head[3] && rows.every((r) => r.id === null);
    if (firstTime && mode === 'auto') {
      const n = live().length;
      if (n > 0) return line(SYNC_PROTOCOL, 'ask-first', token, project.name, n) + '\n';
    }

    const out: string[] = [];
    const count = { added: 0, changed: 0, removed: 0, stock: 0, build: 0, conflicts: 0 };
    const actor = auth.user;

    if (firstTime && mode === 'first-replace') {
      for (const i of live()) {
        removeItem(ctx, actor, i.id);
        count.removed++;
      }
    }
    // rows the person deleted in the workbook, and confirmed
    for (const id of deletes) {
      const i = live().find((x) => x.id === id);
      if (!i) continue;
      removeItem(ctx, actor, id);
      count.removed++;
    }

    // what the project builds: the three drivers, merged like any other cells
    if (buildLine && buildLine.length >= 7) {
      const b = getBuild(ctx, projectId);
      const server = [b.arrays, b.per_array, b.spares];
      const next = [...server];
      let touched = false;
      let bad = '';
      (['arrays', 'antennas per array', 'extra antennas'] as const).forEach((label, n) => {
        const base = buildLine![1 + n].trim();
        const cur = buildLine![4 + n].trim();
        if (cur === base) return;
        const v = toNumber(cur === '' ? '0' : cur);
        if (v === null || v < 0 || !Number.isInteger(v)) {
          bad = `Number of ${label} must be a whole number.`;
          return;
        }
        if (v === server[n]) return;
        const baseN = toNumber(base === '' ? '0' : base);
        if (baseN !== null && baseN !== server[n]) {
          out.push(line('C', 'build', String(n), String(server[n]), `Number of ${label}`));
          count.conflicts++;
          return;
        }
        next[n] = v;
        touched = true;
      });
      if (bad) out.push(line('E', 'build', bad));
      else if (touched) {
        try {
          tx(ctx.db, () => setBuild(ctx, actor, projectId, { version: b.version, arrays: next[0], per_array: next[1], spares: next[2] }));
          count.build++;
        } catch (e) {
          out.push(line('E', 'build', problem(e)));
        }
      }
    }

    // the rows
    const byId = new Map(live().map((i) => [i.id, i]));
    const claimed = new Set<number>();
    for (const r of rows) if (r.id !== null && byId.has(r.id) && !claimed.has(r.id)) claimed.add(r.id);
    const seen = new Set<number>();
    /** row ref -> the item it is, once known */
    const rowItem = new Map<string, number>();
    /** rows whose cells must be left alone this round */
    const held = new Set<string>();
    const conflictsOf = new Map<number, Set<SyncField>>();

    for (const r of rows) {
      let id = r.id;
      // the same id twice is a copied row: the copy is a new part
      if (id !== null && seen.has(id)) id = null;
      if (id !== null && !byId.has(id)) {
        // removed on the board (or never this project's): the workbook asks what to do with the row
        out.push(line('G', r.ref, id));
        held.add(r.ref);
        continue;
      }
      let base = r.base;
      if (id === null) {
        if (!r.cur.name.trim()) continue;
        // a part already on the list under this name (a sync cut short, or the first link): take it up, don't add it twice
        const free = [...byId.values()].filter((i) => !claimed.has(i.id) && squash(i.name) === squash(r.cur.name));
        const match = free.find((i) => squash(i.spec) === squash(r.cur.spec)) ?? (free.length === 1 ? free[0] : undefined);
        if (match) {
          id = match.id;
          claimed.add(id);
          base = toCells(match); // the workbook's cells are the changes
        } else {
          try {
            const input = fromCells(r.cur);
            const item = tx(ctx.db, () => {
              const made = addItem(ctx, actor, projectId, input);
              return r.cur.status.trim() === '1' ? setStock(ctx, actor, made.id, { in_stock: true }) : made;
            });
            byId.set(item.id, item);
            claimed.add(item.id);
            seen.add(item.id);
            rowItem.set(r.ref, item.id);
            count.added++;
          } catch (e) {
            out.push(line('W', r.ref, problem(e)));
            held.add(r.ref);
          }
          continue;
        }
      }
      seen.add(id);
      rowItem.set(r.ref, id);
      const item = byId.get(id)!;
      const server = toCells(item);
      const merged = { ...server };
      const mine: SyncField[] = [];
      // beside a hand-typed Total qty, Qty / unit is the person's own note ("290mm"): it is never read or written
      const typedTotal = !!r.cur.total.trim();
      for (const f of SYNC_FIELDS) {
        if (f === 'qty' && typedTotal) continue;
        if (sameCell(f, r.cur[f], base[f])) continue; // not changed in the workbook
        if (sameCell(f, r.cur[f], server[f])) continue; // both made the same change
        if (!sameCell(f, server[f], base[f])) {
          // changed in both places, differently
          if (!conflictsOf.has(id)) conflictsOf.set(id, new Set());
          conflictsOf.get(id)!.add(f);
          out.push(line('C', id, String(SYNC_FIELDS.indexOf(f)), server[f], FIELD_LABEL[f]));
          count.conflicts++;
          continue;
        }
        merged[f] = r.cur[f];
        mine.push(f);
      }
      if (!mine.length) continue;
      try {
        const updated = tx(ctx.db, () => {
          let it = item;
          if (mine.some((f) => f !== 'status')) {
            const { quantity, basis, ...text } = fromCells(merged);
            // how the part is counted changes only when its quantity cells did, or its category while it was counted by category
            const recount = mine.includes('qty') || mine.includes('total') || (mine.includes('category') && followsCategory(item));
            it = editItem(ctx, actor, id!, { version: it.version, ...text, ...(recount ? { quantity, basis } : {}) });
          }
          if (mine.includes('status')) it = setStock(ctx, actor, id!, { in_stock: merged.status.trim() === '1' });
          return it;
        });
        byId.set(id, updated);
        if (mine.some((f) => f !== 'status')) count.changed++;
        if (mine.includes('status')) count.stock++;
      } catch (e) {
        out.push(line('E', r.ref, problem(e)));
        held.add(r.ref);
      }
    }

    // the workbook's row order is the list's order
    let order = 0;
    let moved = false;
    const ordered = rows.map((r) => rowItem.get(r.ref)).filter((id): id is number => id !== undefined);
    const rest = live()
      .filter((i) => !ordered.includes(i.id))
      .map((i) => i.id);
    for (const id of [...ordered, ...rest]) {
      order += 10;
      const cur = byId.get(id) ?? live().find((i) => i.id === id);
      if (cur && cur.sort_order !== order) {
        run(ctx.db, 'UPDATE procurement_items SET sort_order = ? WHERE id = ?', order, id);
        moved = true;
      }
    }
    if (moved) ctx.events.emit({ type: 'procurement', id: projectId });

    if (count.added || count.changed || count.removed || count.stock || count.build || count.conflicts)
      run(
        ctx.db,
        'INSERT INTO sync_log (project_id, key_id, user_id, at, added, changed, removed, stock, build, conflicts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        projectId,
        auth.key.id,
        actor.id,
        nowIso(ctx),
        count.added,
        count.changed,
        count.removed,
        count.stock,
        count.build,
        count.conflicts,
      );

    // the list as it now stands
    const final = procurement(ctx, projectId);
    const status = new Map(
      all<StatusRow>(
        ctx.db,
        `SELECT i.id, COALESCE(l.label, t.stage) stage, t.in_process, t.received, t.accepted, t.rejected,
           (SELECT promised_date FROM manufacturing_events WHERE item_id = i.id AND kind = 'commitment' ORDER BY id DESC LIMIT 1) promise,
           o.order_status, o.po_ref, v.name vendor, f.next_action, f.next_due
         FROM procurement_items i
         LEFT JOIN manufacturing_tracking t ON t.item_id = i.id
         LEFT JOIN manufacturing_stage_labels l ON l.means = i.means AND l.stage = t.stage
         LEFT JOIN purchase_orders o ON o.item_id = i.id
         LEFT JOIN purchase_vendors v ON v.id = o.vendor_id
         LEFT JOIN procurement_followups f ON f.item_id = i.id
         WHERE i.project_id = ? AND i.removed_at IS NULL`,
        projectId,
      ).map((s) => [s.id, s]),
    );
    const refOf = new Map<number, Row>();
    for (const r of rows) {
      const id = rowItem.get(r.ref);
      if (id !== undefined) refOf.set(id, r);
    }
    const b = final.build;
    const reply = [line(SYNC_PROTOCOL, 'ok', token, project.name, localStamp(ctx, nowIso(ctx))), line('B', b.arrays, b.per_array, b.spares, b.antennas), ...out];
    for (const i of final.items) {
      const r = refOf.get(i.id);
      const cells = toCells(i);
      // where the workbook already says the same thing its own way ("NIL", a trailing space), leave its cell as it is
      if (r) {
        for (const f of SYNC_FIELDS) if (!conflictsOf.get(i.id)?.has(f) && sameCell(f, r.cur[f], cells[f])) cells[f] = r.cur[f];
        if (cells.total && r.cur.total.trim()) cells.qty = r.cur.qty;
      }
      // What to do with the Total qty cell: nothing when it already shows the part's total, "F" to give it the
      // workbook's formula (the part is counted by its category), or the total to type in (it is not).
      let totalCell = '';
      if (!cells.total) {
        if (!r || r.cur.total.trim()) totalCell = 'F';
      } else {
        const was = r ? shown.get(r.ref) : null;
        if (was === null || was === undefined || Math.abs(was - i.required) > 1e-6) totalCell = num(i.required);
      }
      const s = status.get(i.id);
      reply.push(
        line(
          'I',
          r && held.has(r.ref) ? 'hold' : 'ok',
          i.id,
          r?.ref ?? '',
          ...SYNC_FIELDS.map((f) => cells[f]),
          num(i.required),
          i.to_procure === null ? 'CHECK' : num(i.to_procure),
          localStamp(ctx, i.in_stock_at),
          i.in_stock_by ? (getUser(ctx, i.in_stock_by)?.name ?? '') : '',
          s?.stage ?? '',
          s?.in_process ?? '',
          s?.received ?? '',
          s?.accepted ?? '',
          s?.rejected ?? '',
          s?.promise ?? '',
          s?.order_status ?? '',
          s?.po_ref ?? '',
          s?.vendor ?? '',
          s?.next_action ?? '',
          s?.next_due ?? '',
          totalCell,
        ),
      );
    }
    return reply.join('\n') + '\n';
  });
}
