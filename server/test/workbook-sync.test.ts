// The workbook link (decision #47): the inventory workbook's macro and a
// project's procurement list kept as one list.
//
// `Workbook` below does what the macro does (tools/excel/BoardSync.bas): it
// keeps each row's cells and the cells as they stood after the last sync,
// posts both, and writes back whatever the board answers. It has no rules of
// its own, so these tests are the rules.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.ts';
import { startHarness, signIn, Client, type Harness } from './helpers.ts';
import { SYNC_FIELDS, esc, unesc, sameCell, type Cells, type SyncField } from '../src/domain/workbookSync.ts';

const blank = (): Cells => Object.fromEntries(SYNC_FIELDS.map((f) => [f, ''])) as Cells;
const cells = (c: Partial<Cells>): Cells => ({ ...blank(), status: '0', ...c });

interface WbRow {
  id: number | null;
  base: Cells;
  cur: Cells;
}

class Workbook {
  rows: WbRow[] = [];
  token = '';
  build = { base: ['', '', ''], cur: ['', '', ''] };
  /** what the last reply said, by kind */
  last: { head: string[]; conflicts: string[][]; gone: string[][]; waiting: string[][]; errors: string[][]; status: Map<number, string[]> } = {
    head: [],
    conflicts: [],
    gone: [],
    waiting: [],
    errors: [],
    status: new Map(),
  };
  /** the answer to "keep the workbook's value?" for a conflict */
  keepMine: (id: string, field: SyncField, boardValue: string) => boolean = () => true;
  deletes: number[] = [];

  constructor(
    private base: string,
    public key: string,
  ) {}

  add(c: Partial<Cells>): WbRow {
    const r = { id: null, base: blank(), cur: cells(c) };
    this.rows.push(r);
    return r;
  }
  row(name: string): WbRow {
    const r = this.rows.find((x) => x.cur.name === name);
    assert.ok(r, `no row named ${name}`);
    return r;
  }

  async post(mode = 'auto'): Promise<{ status: number; lines: string[][] }> {
    const out = [['EB1', 'sync', mode, this.token]];
    out.push(['B', ...this.build.base, ...this.build.cur]);
    this.rows.forEach((r, n) => out.push(['R', r.id === null ? '' : String(r.id), String(n), ...SYNC_FIELDS.map((f) => r.base[f]), ...SYNC_FIELDS.map((f) => r.cur[f])]));
    for (const id of this.deletes) out.push(['D', String(id)]);
    const res = await fetch(this.base + '/api/sync', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'x-board-key': this.key },
      body: out.map((l) => l.map(esc).join('\t')).join('\n') + '\n',
    });
    const text = await res.text();
    assert.ok(/^[\x20-\x7e\t\n]*$/.test(text), 'the reply is plain ASCII');
    return {
      status: res.status,
      lines: text
        .split('\n')
        .filter(Boolean)
        .map((l) => l.split('\t').map(unesc)),
    };
  }

  /** One round, as the macro does it. */
  async sync(mode = 'auto'): Promise<string> {
    const { lines } = await this.post(mode);
    const head = lines[0];
    this.last = { head, conflicts: [], gone: [], waiting: [], errors: [], status: new Map() };
    if (head[1] === 'relink') {
      for (const r of this.rows) {
        r.id = null;
        r.base = blank();
      }
      this.build.base = ['', '', ''];
      this.token = '';
      return 'relink';
    }
    if (head[1] !== 'ok') return head[1];
    this.token = head[2];
    this.deletes = [];
    const conflict = new Map<string, string>();
    for (const l of lines.slice(1)) {
      if (l[0] === 'C') {
        this.last.conflicts.push(l);
        conflict.set(`${l[1]}|${l[2]}`, l[3]);
      } else if (l[0] === 'G') this.last.gone.push(l);
      else if (l[0] === 'W') this.last.waiting.push(l);
      else if (l[0] === 'E') this.last.errors.push(l);
    }
    for (const l of lines.slice(1)) {
      if (l[0] === 'B') {
        const server = l.slice(1, 4);
        server.forEach((v, n) => {
          const c = conflict.get(`build|${n}`);
          if (c === undefined || !this.keepMine('build', 'qty', c)) this.build.cur[n] = v;
        });
        this.build.base = [...server];
      } else if (l[0] === 'I') {
        const [, state, idText, ref] = l;
        const id = Number(idText);
        this.last.status.set(id, l.slice(4 + SYNC_FIELDS.length));
        if (state === 'hold') continue;
        let r = ref === '' ? undefined : this.rows[Number(ref)];
        if (!r) {
          // a part added on the board: a new row at the end
          r = { id, base: blank(), cur: blank() };
          this.rows.push(r);
        }
        r.id = id;
        SYNC_FIELDS.forEach((f, n) => {
          const v = l[4 + n];
          const c = conflict.get(`${id}|${n}`);
          if (c === undefined || !this.keepMine(idText, f, c)) r!.cur[f] = v;
          r!.base[f] = v;
        });
      }
    }
    return 'ok';
  }
}

describe('workbook link', () => {
  let h: Harness;
  let christin: Client;
  let paul: Client;
  let jeffin: Client;
  let project: number;
  let key: string;
  let wb: Workbook;

  const list = async () => (await christin.get(`/api/projects/${project}/procurement`)).body;
  const item = async (name: string) => (await list()).items.find((i: any) => i.name === name);
  const newProject = async (name: string) => (await christin.post('/api/projects', { name })).body.project.id as number;
  const newKey = async (c: Client, p: number) => {
    const r = await c.post(`/api/projects/${p}/workbook-link/keys`, {});
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body as { key: string; row: { id: number; hint: string } };
  };

  before(async () => {
    h = await startHarness();
    christin = await h.as('Christin');
    paul = await h.as('Paul');
    jeffin = await h.as('Jeffin');
    project = await newProject('7 inch spiral array');
    key = (await newKey(christin, project)).key;
    wb = new Workbook(h.base, key);
  });
  after(() => h.close());

  it('escapes anything that is not printable ASCII, both ways', () => {
    const s = 'ø 189 × 69.4\tconsult\\designer\nLATER 😀';
    assert.ok(/^[\x20-\x7e]*$/.test(esc(s)));
    assert.equal(unesc(esc(s)), s);
    assert.equal(unesc('plain'), 'plain');
  });

  it('gives a key once, keeps only its hash, and refuses a wrong or missing one in the macro\'s own format', async () => {
    const link = (await christin.get(`/api/projects/${project}/workbook-link`)).body;
    assert.equal(link.keys.length, 1);
    assert.equal(link.keys[0].hint, key.slice(-4));
    assert.ok(!JSON.stringify(link).includes(key));
    for (const bad of ['', 'eb_nope']) {
      const r = await new Workbook(h.base, bad).post();
      assert.equal(r.status, 401);
      assert.deepEqual(r.lines[0].slice(0, 2), ['EB1', 'error']);
    }
  });

  it('first sync of a new project: every row becomes a part, with the workbook\'s totals and order', async () => {
    wb.build.cur = ['4', '3', '2'];
    wb.add({ name: 'CAVITY', spec: 'ø 189 X 69.4', qty: '1', inventory: '0', material: 'AL. ALLOY 6061', category: 'Single Antenna', discipline: 'Mechanical', means: 'OUTSOURCED' });
    wb.add({ name: 'TEFLON SPACER', spec: '25.4 X 25.4 X 1', qty: '3', inventory: 'NIL', material: 'PTFE ', category: 'Single Antenna', discipline: 'Mechanical', means: 'OUTSOURCED' });
    wb.add({ name: 'ARRAY BLOCK', spec: '80.2 X 890 X 292', qty: '1', inventory: '1', category: 'Array', discipline: 'Mechanical', means: 'OUTSOURCED', coating: 'PENDING' });
    wb.add({ name: 'SPIRAL CARD', spec: 'ø 174.6 X 0.8', qty: '1', category: 'Single Antenna', discipline: 'RF', means: 'IN-HOUSE', remarks: 'consult with designer\nLATER' });
    wb.add({ name: 'HELICOIL TAP', spec: '#10-32', qty: '1', inventory: '1', category: 'Tool', discipline: 'Mechanical', means: 'TOOLS', status: '1' });
    wb.add({ name: 'O-RING', spec: 'Ø1.5 x 2006 Lg', qty: '2006mm', total: '4', category: 'Array', discipline: 'Mechanical', means: 'OUTSOURCED' });
    assert.equal(await wb.sync(), 'ok');
    const d = await list();
    assert.deepEqual(
      d.items.map((i: any) => [i.name, i.required, i.to_procure, i.basis]),
      [
        ['CAVITY', 14, 14, 'antenna'],
        ['TEFLON SPACER', 42, 42, 'antenna'],
        ['ARRAY BLOCK', 4, 3, 'array'],
        ['SPIRAL CARD', 14, null, 'antenna'],
        ['HELICOIL TAP', 1, 0, 'total'],
        ['O-RING', 4, null, 'total'],
      ],
    );
    assert.equal(d.build.antennas, 14);
    assert.equal((await item('CAVITY')).spec, 'ø 189 X 69.4');
    assert.equal((await item('SPIRAL CARD')).notes, 'consult with designer\nLATER');
    assert.equal((await item('ARRAY BLOCK')).coating, 'pending');
    assert.ok((await item('HELICOIL TAP')).in_stock_at);
    // every row now knows its part, and what the workbook already said its own way is left alone
    assert.ok(wb.rows.every((r) => r.id !== null));
    assert.equal(wb.row('TEFLON SPACER').cur.inventory, 'NIL');
    assert.equal(wb.row('TEFLON SPACER').cur.material, 'PTFE ');
    assert.equal(wb.row('O-RING').cur.qty, '2006mm');
    assert.equal(wb.row('O-RING').cur.total, '4');
    assert.equal(wb.row('CAVITY').cur.total, '');
    const log = (await christin.get(`/api/projects/${project}/workbook-link`)).body.log;
    assert.equal(log.length, 1);
    assert.equal(log[0].added, 6);
    assert.equal(log[0].build, 1);
  });

  it('a sync with nothing to say changes nothing', async () => {
    const before = await list();
    assert.equal(await wb.sync(), 'ok');
    assert.equal(await wb.sync(), 'ok');
    const after = await list();
    assert.deepEqual(after.items.map((i: any) => [i.id, i.version, i.sort_order]), before.items.map((i: any) => [i.id, i.version, i.sort_order]));
    assert.equal((await christin.get(`/api/projects/${project}/workbook-link`)).body.log.length, 1);
    assert.deepEqual(wb.last.conflicts, []);
  });

  it('a change in the workbook reaches the board, and a change on the board reaches the workbook', async () => {
    wb.row('CAVITY').cur.material = 'AL. ALLOY 6082';
    wb.row('CAVITY').cur.inventory = '6';
    await wb.sync();
    let cavity = await item('CAVITY');
    assert.equal(cavity.material, 'AL. ALLOY 6082');
    assert.equal(cavity.to_procure, 8);
    const r = await paul.patch(`/api/procurement/items/${cavity.id}`, { version: cavity.version, spec: 'ø 190 X 70', coating: 'done' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await wb.sync();
    assert.equal(wb.row('CAVITY').cur.spec, 'ø 190 X 70');
    assert.equal(wb.row('CAVITY').cur.coating, 'DONE');
    assert.equal(wb.row('CAVITY').cur.material, 'AL. ALLOY 6082');
    cavity = await item('CAVITY');
    assert.equal(cavity.spec, 'ø 190 X 70');
  });

  it('different cells of one part changed in both places are both kept', async () => {
    const card = await item('SPIRAL CARD');
    await paul.patch(`/api/procurement/items/${card.id}`, { version: card.version, material: 'RT DUROID 5880' });
    wb.row('SPIRAL CARD').cur.inventory = '3';
    await wb.sync();
    assert.deepEqual(wb.last.conflicts, []);
    const now = await item('SPIRAL CARD');
    assert.equal(now.material, 'RT DUROID 5880');
    assert.equal(now.inventory, 3);
    assert.equal(wb.row('SPIRAL CARD').cur.material, 'RT DUROID 5880');
  });

  it('the same cell changed in both places is a conflict: nothing is overwritten until the person chooses', async () => {
    let card = await item('SPIRAL CARD');
    await paul.patch(`/api/procurement/items/${card.id}`, { version: card.version, spec: 'ø 175 X 0.8' });
    wb.row('SPIRAL CARD').cur.spec = 'ø 174 X 0.8';
    // keep the workbook's
    wb.keepMine = () => true;
    await wb.sync();
    assert.equal(wb.last.conflicts.length, 1);
    assert.deepEqual(wb.last.conflicts[0].slice(1), [String(card.id), String(SYNC_FIELDS.indexOf('spec')), 'ø 175 X 0.8', 'Final size']);
    assert.equal((await item('SPIRAL CARD')).spec, 'ø 175 X 0.8', 'the board keeps its value for now');
    assert.equal(wb.row('SPIRAL CARD').cur.spec, 'ø 174 X 0.8', 'and the workbook keeps its own');
    await wb.sync();
    assert.equal((await item('SPIRAL CARD')).spec, 'ø 174 X 0.8', 'the workbook\'s value was chosen, so it is saved at the next sync');
    assert.deepEqual(wb.last.conflicts, []);
    // keep the board's
    card = await item('SPIRAL CARD');
    await paul.patch(`/api/procurement/items/${card.id}`, { version: card.version, spec: 'ø 176 X 0.8' });
    wb.row('SPIRAL CARD').cur.spec = 'ø 173 X 0.8';
    wb.keepMine = () => false;
    await wb.sync();
    assert.equal(wb.row('SPIRAL CARD').cur.spec, 'ø 176 X 0.8');
    await wb.sync();
    assert.equal((await item('SPIRAL CARD')).spec, 'ø 176 X 0.8');
    // both made the same change: no conflict
    card = await item('SPIRAL CARD');
    await paul.patch(`/api/procurement/items/${card.id}`, { version: card.version, discipline: 'Mechanical' });
    wb.row('SPIRAL CARD').cur.discipline = 'mechanical ';
    await wb.sync();
    assert.deepEqual(wb.last.conflicts, []);
    wb.keepMine = () => true;
  });

  it('rows added, parts added on the board, rows deleted and parts removed on the board', async () => {
    // a new row in the workbook
    wb.add({ name: 'COVER TOP', spec: 'ø 178.6 X 5', qty: '1', category: 'Single Antenna', discipline: 'Mechanical', means: 'OUTSOURCED' });
    // a new part on the board
    const made = await paul.post(`/api/projects/${project}/procurement/items`, { name: 'Connector', spec: 'N-TYPE', means: 'bought_out', category: 'Single Antenna', basis: 'antenna', quantity: 1 });
    assert.equal(made.status, 201);
    await wb.sync();
    assert.ok(await item('COVER TOP'));
    const connector = wb.row('Connector');
    assert.equal(connector.id, made.body.item.id);
    assert.equal(connector.cur.means, 'BOUGHT-OUT');
    assert.equal(connector.cur.total, '', 'counted by its category, so the workbook\'s formula gives the total');
    // the workbook's order is the list's order
    assert.deepEqual((await list()).items.map((i: any) => i.name), wb.rows.map((r) => r.cur.name));
    // a row deleted in the workbook, once the person has confirmed
    const cover = wb.row('COVER TOP');
    wb.rows.splice(wb.rows.indexOf(cover), 1);
    wb.deletes.push(cover.id!);
    await wb.sync();
    assert.equal(await item('COVER TOP'), undefined);
    assert.ok((await list()).log.some((l: any) => l.kind === 'removed' && l.item_name === 'COVER TOP'));
    // a row deleted but not confirmed comes back from the board
    const tap = wb.row('HELICOIL TAP');
    wb.rows.splice(wb.rows.indexOf(tap), 1);
    await wb.sync();
    assert.equal(wb.row('HELICOIL TAP').id, tap.id);
    // a part removed on the board: the workbook is told, and its row is left alone
    assert.equal((await paul.del(`/api/procurement/items/${connector.id}`)).status, 200);
    await wb.sync();
    assert.deepEqual(wb.last.gone.map((g) => g[2]), [String(connector.id)]);
    assert.equal(wb.row('Connector').cur.spec, 'N-TYPE');
    wb.rows.splice(wb.rows.indexOf(wb.row('Connector')), 1);
  });

  it('the In stock tick goes both ways', async () => {
    wb.row('CAVITY').cur.status = '1';
    await wb.sync();
    const cavity = await item('CAVITY');
    assert.ok(cavity.in_stock_at);
    assert.equal(cavity.in_stock_by, (await christin.get('/api/session')).body.user.id, 'recorded under the key\'s owner');
    const block = await item('ARRAY BLOCK');
    await paul.post(`/api/procurement/items/${block.id}/stock`, { in_stock: true });
    await paul.post(`/api/procurement/items/${cavity.id}/stock`, { in_stock: false });
    await wb.sync();
    assert.equal(wb.row('ARRAY BLOCK').cur.status, '1');
    assert.equal(wb.row('CAVITY').cur.status, '0');
    const status = wb.last.status.get(block.id)!;
    assert.match(status[2], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'when it was marked, in the board\'s local time');
    assert.equal(status[3], 'Paul');
  });

  it('the quantity drivers go both ways, and clash like any other cell', async () => {
    wb.build.cur = ['5', '3', '2'];
    await wb.sync();
    let d = await list();
    assert.equal(d.build.antennas, 17);
    assert.equal((await item('CAVITY')).required, 17);
    await paul.put(`/api/projects/${project}/procurement/build`, { version: d.build.version, arrays: 5, per_array: 4, spares: 2 });
    await wb.sync();
    assert.deepEqual(wb.build.cur, ['5', '4', '2']);
    d = await list();
    await paul.put(`/api/projects/${project}/procurement/build`, { version: d.build.version, arrays: 6, per_array: 4, spares: 2 });
    wb.build.cur = ['7', '4', '2'];
    wb.keepMine = () => false;
    await wb.sync();
    assert.equal(wb.last.conflicts.length, 1);
    assert.equal(wb.last.conflicts[0][1], 'build');
    assert.deepEqual(wb.build.cur, ['6', '4', '2']);
    assert.equal((await list()).build.arrays, 6);
    wb.keepMine = () => true;
    wb.build.cur = ['4', '3', '2'];
    await wb.sync();
    assert.equal((await list()).build.antennas, 14);
  });

  it('a hand-typed total, and a part the board counts differently from its category', async () => {
    // typed over in the workbook
    wb.row('O-RING').cur.total = '6';
    await wb.sync();
    let ring = await item('O-RING');
    assert.deepEqual([ring.quantity, ring.basis, ring.required], [6, 'total', 6]);
    assert.equal(wb.row('O-RING').cur.qty, '2006mm', 'Qty / unit beside a typed total is the person\'s own note');
    // changing another cell of that row does not change how it is counted
    wb.row('O-RING').cur.material = 'NEOPRENE';
    await wb.sync();
    ring = await item('O-RING');
    assert.deepEqual([ring.quantity, ring.basis, ring.material], [6, 'total', 'NEOPRENE']);
    // the board counts the tap per array, which its category (Tool) does not say: the workbook is given the total to type
    const tap = await item('HELICOIL TAP');
    await paul.patch(`/api/procurement/items/${tap.id}`, { version: tap.version, basis: 'array', quantity: 2 });
    await wb.sync();
    assert.equal(wb.row('HELICOIL TAP').cur.total, '8');
    wb.row('HELICOIL TAP').cur.remarks = 'one per bench';
    await wb.sync();
    const now = await item('HELICOIL TAP');
    assert.deepEqual([now.quantity, now.basis, now.required, now.notes], [2, 'array', 8, 'one per bench'], 'an edit elsewhere in the row leaves the count alone');
    // clearing the typed total hands the count back to the category
    wb.row('HELICOIL TAP').cur.total = '';
    wb.row('HELICOIL TAP').cur.qty = '1';
    await wb.sync();
    const back = await item('HELICOIL TAP');
    assert.deepEqual([back.quantity, back.basis, back.required], [1, 'total', 1]);
  });

  it('reads the Total qty cell as it shows: the category\'s total is left to the formula, any other is the part\'s own', async () => {
    // what the macro really sends: the number each Total qty cell shows, formula or not
    const p = await newProject('Totals as shown');
    const w = new Workbook(h.base, (await newKey(christin, p)).key);
    w.build.cur = ['4', '3', '2'];
    w.add({ name: 'CAVITY', qty: '1', total: '14', category: 'Single Antenna', means: 'OUTSOURCED' }); // the workbook's formula: 1 x 14 antennas
    w.add({ name: 'ARRAY BLOCK', qty: '1', total: '4', category: 'Array', means: 'OUTSOURCED' }); // 1 x 4 arrays
    w.add({ name: 'TEST SCREW', qty: '8', total: '8', category: 'Single Antenna', means: 'BOUGHT-OUT' }); // her own formula, =D49
    w.add({ name: 'NO CATEGORY YET', qty: '5', total: '', means: 'BOUGHT-OUT' }); // the formula shows nothing without a category
    assert.equal(await w.sync(), 'ok');
    const items = (await christin.get(`/api/projects/${p}/procurement`)).body.items;
    assert.deepEqual(
      items.map((i: any) => [i.name, i.basis, i.quantity, i.required]),
      [
        ['CAVITY', 'antenna', 1, 14],
        ['ARRAY BLOCK', 'array', 1, 4],
        ['TEST SCREW', 'total', 8, 8],
        ['NO CATEGORY YET', 'total', 5, 5],
      ],
    );
    // nothing to do to any Total qty cell: each already shows its part's total (or is the formula's to fill)
    const action = (name: string, ls: string[][]) => ls.find((l) => l[0] === 'I' && l[4] === name)!.at(-1);
    const shows = () => {
      w.row('CAVITY').cur.total = '14';
      w.row('ARRAY BLOCK').cur.total = '4';
      w.row('TEST SCREW').cur.total = '8';
    };
    shows();
    const { lines } = await w.post();
    for (const i of items) assert.equal(action(i.name, lines), '', i.name);
    // the board changes the drivers: the cells still show the old totals, and that is not a change by the workbook
    const b = (await christin.get(`/api/projects/${p}/procurement`)).body.build;
    await paul.put(`/api/projects/${p}/procurement/build`, { version: b.version, arrays: 5, per_array: 3, spares: 2 });
    shows();
    const before = (await christin.get(`/api/projects/${p}/procurement`)).body.items.map((i: any) => [i.name, i.basis, i.version]);
    await w.sync();
    assert.deepEqual((await christin.get(`/api/projects/${p}/procurement`)).body.items.map((i: any) => [i.name, i.basis, i.version]), before);
    assert.deepEqual(w.build.cur, ['5', '3', '2']);
    // the board starts counting the screw per antenna: the workbook is told to give the cell its formula back
    const screw = (await christin.get(`/api/projects/${p}/procurement`)).body.items.find((i: any) => i.name === 'TEST SCREW');
    await paul.patch(`/api/procurement/items/${screw.id}`, { version: screw.version, basis: 'antenna' });
    w.row('CAVITY').cur.total = '17';
    w.row('ARRAY BLOCK').cur.total = '5';
    w.row('TEST SCREW').cur.total = '8';
    let r = await w.post();
    assert.equal(action('TEST SCREW', r.lines), 'F');
    assert.equal(action('CAVITY', r.lines), '');
    // and counts the cavity as 3 in total: the workbook is given that number to type
    const cavity = (await christin.get(`/api/projects/${p}/procurement`)).body.items.find((i: any) => i.name === 'CAVITY');
    await paul.patch(`/api/procurement/items/${cavity.id}`, { version: cavity.version, basis: 'total', quantity: 3 });
    r = await w.post();
    assert.equal(action('CAVITY', r.lines), '3');
    // a part new to the workbook gets the formula, or its own total
    const made = await paul.post(`/api/projects/${p}/procurement/items`, { name: 'NEW ON BOARD', means: 'bought_out', category: 'Array', basis: 'array', quantity: 2 });
    r = await w.post();
    assert.equal(r.lines.find((l) => l[0] === 'I' && l[2] === String(made.body.item.id))!.at(-1), 'F');
  });

  it('a row that is not ready waits, and a change the board refuses is held, both with the reason', async () => {
    const half = wb.add({ name: 'BALUN CARD', spec: '76.5 X 3.4 X 0.5' });
    await wb.sync();
    assert.equal(wb.last.waiting.length, 1);
    assert.match(wb.last.waiting[0][2], /Means/);
    assert.equal(half.id, null);
    assert.equal(await item('BALUN CARD'), undefined);
    half.cur.means = 'OUTSOURCED';
    await wb.sync();
    assert.match(wb.last.waiting[0][2], /Qty/);
    half.cur.qty = '1';
    half.cur.category = 'Single Antenna';
    await wb.sync();
    assert.deepEqual(wb.last.waiting, []);
    assert.equal((await item('BALUN CARD')).required, 14);
    // manufacturing has received 10 teflon spacers; the workbook then asks for fewer than that
    const spacer = await item('TEFLON SPACER');
    const m = await paul.put(`/api/manufacturing/items/${spacer.id}`, { version: 0, stage: 'fabrication', in_process: 40, received: 10, accepted: 10, rejected: 0, escalation: 'none', detail: 'first lot in' });
    assert.equal(m.status, 200, JSON.stringify(m.body));
    wb.row('TEFLON SPACER').cur.qty = '2';
    await wb.sync();
    assert.equal(wb.last.errors.length, 1);
    assert.match(wb.last.errors[0][2], /manufacturing/i);
    assert.equal(wb.row('TEFLON SPACER').cur.qty, '2', 'the workbook\'s cell is left for the person to put right');
    assert.equal((await item('TEFLON SPACER')).quantity, 3);
    await wb.sync();
    assert.equal(wb.last.errors.length, 1, 'and it says so again until it is put right');
    wb.row('TEFLON SPACER').cur.qty = '3';
    await wb.sync();
    assert.deepEqual(wb.last.errors, []);
    // the status columns for the Live Status sheet
    const s = wb.last.status.get(spacer.id)!;
    assert.deepEqual(s.slice(0, 2), ['42', '42']);
    assert.deepEqual(s.slice(4, 9), ['Machining / fabrication', '40', '10', '10', '0']);
  });

  it('a sync cut short does not add its rows twice, and duplicate names stay separate parts', async () => {
    wb.add({ name: 'WEDGE LOCK WASHER', spec: 'M5 WEDGE LOCK', qty: '4', category: 'Single Antenna', means: 'BOUGHT-OUT' });
    wb.add({ name: 'WEDGE LOCK WASHER', spec: 'M4 WEDGE LOCK', qty: '4', category: 'Single Antenna', means: 'BOUGHT-OUT' });
    // the board adds them, but the workbook never hears back
    await wb.post();
    assert.equal((await list()).items.filter((i: any) => i.name === 'WEDGE LOCK WASHER').length, 2);
    await wb.sync();
    const washers = (await list()).items.filter((i: any) => i.name === 'WEDGE LOCK WASHER');
    assert.equal(washers.length, 2);
    assert.deepEqual(
      wb.rows.filter((r) => r.cur.name === 'WEDGE LOCK WASHER').map((r) => [r.id, r.cur.spec]),
      washers.map((i: any) => [i.id, i.spec]),
    );
  });

  it('a second copy of the workbook, opened later, catches up without undoing anything', async () => {
    const copy = new Workbook(h.base, (await newKey(paul, project)).key);
    // a copy made before the last changes: it knows the parts, with old cells
    copy.token = wb.token;
    copy.build = { base: ['4', '3', '2'], cur: ['4', '3', '2'] };
    for (const r of wb.rows) copy.rows.push({ id: r.id, base: { ...r.base, material: 'OLD' }, cur: { ...r.cur, material: 'OLD' } });
    const before = (await list()).items.map((i: any) => [i.id, i.material]);
    await copy.sync();
    assert.deepEqual((await list()).items.map((i: any) => [i.id, i.material]), before, 'cells the copy did not change are not pushed');
    assert.deepEqual(copy.rows.map((r) => r.cur.material), before.map((b: any[]) => b[1]), 'and its own cells are brought up to date');
  });

  it('a list that already has parts: the workbook asks first, then discards them or takes them up by name', async () => {
    const other = await newProject('3 inch spiral array');
    for (const name of ['CAVITY', 'OLD BRACKET']) await paul.post(`/api/projects/${other}/procurement/items`, { name, spec: 'as built', means: 'outsourced', quantity: 2, material: 'STEEL' });
    const fresh = () => {
      const w = new Workbook(h.base, otherKey);
      w.build.cur = ['1', '1', '0'];
      w.add({ name: 'cavity', spec: 'ø 97 X 62.1', qty: '1', category: 'Single Antenna', means: 'OUTSOURCED' });
      w.add({ name: 'GDSS 1', spec: '31.8 X 215 X 3.1', qty: '1', category: 'Single Antenna', means: 'IN-HOUSE' });
      return w;
    };
    const otherKey = (await newKey(christin, other)).key;
    const names = async () => (await christin.get(`/api/projects/${other}/procurement`)).body.items.map((i: any) => i.name);
    // asked, and nothing touched
    const w1 = fresh();
    assert.equal(await w1.sync(), 'ask-first');
    assert.deepEqual(w1.last.head.slice(3), ['3 inch spiral array', '2']);
    assert.deepEqual(await names(), ['CAVITY', 'OLD BRACKET']);
    // take them up by name: the workbook's cells win, the rest of the board's list comes over
    assert.equal(await w1.sync('first-merge'), 'ok');
    assert.deepEqual(await names(), ['cavity', 'GDSS 1', 'OLD BRACKET']);
    assert.equal(w1.rows.length, 3);
    assert.equal(w1.row('OLD BRACKET').cur.material, 'STEEL');
    // a workbook from another project or board starts again
    const w2 = fresh();
    w2.token = 'someotherboard000';
    w2.rows[0].id = 999;
    assert.equal(await w2.sync(), 'relink');
    assert.equal(w2.rows[0].id, null);
    assert.equal(await w2.sync(), 'ask-first');
    // discard what the board has
    assert.equal(await w2.sync('first-replace'), 'ok');
    assert.deepEqual(await names(), ['cavity', 'GDSS 1']);
    const log = (await christin.get(`/api/projects/${other}/procurement`)).body.log;
    assert.equal(log.filter((l: any) => l.kind === 'removed').length, 3, 'discarded parts are removed, never deleted, and logged');
    // a key reaches only its own project
    assert.equal((await list()).items.some((i: any) => i.name === 'GDSS 1'), false);
  });

  it('keys: your own to switch off, anyone\'s for the manager; none for reviewers or Purchase', async () => {
    const mine = await newKey(paul, project);
    assert.equal((await christin.del(`/api/workbook-link/keys/${mine.row.id}`)).status, 403);
    const w = new Workbook(h.base, mine.key);
    assert.equal((await w.post()).status, 200);
    assert.equal((await jeffin.del(`/api/workbook-link/keys/${mine.row.id}`)).status, 200);
    const r = await w.post();
    assert.equal(r.status, 401);
    assert.match(r.lines[0][2], /switched off/);
    const admin = await h.as('Christin');
    await admin.post('/api/admin/unlock', { pin: '1234' });
    for (const [name, role] of [
      ['Ebin', 'reviewer'],
      ['Priya', 'purchase'],
    ] as const) {
      const made = await admin.post('/api/admin/users', { name, role });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      const c = await h.as(name);
      assert.equal((await c.get(`/api/projects/${project}/workbook-link`)).status, 403);
      assert.equal((await c.post(`/api/projects/${project}/workbook-link/keys`, {})).status, 403);
      assert.equal((await c.get('/api/workbook-link/macro/BoardSync.bas')).status, 403);
    }
  });

  it('ships a macro Excel can import: plain ASCII, CRLF, nothing to install, and the board hands it out', async () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools');
    for (const name of ['BoardSync.bas', 'ThisWorkbook.txt']) {
      const bytes = readFileSync(join(dir, 'excel', name));
      assert.ok(bytes.every((b) => b === 13 || b === 10 || b === 9 || (b >= 32 && b < 127)), `${name} is plain ASCII`);
      const text = bytes.toString('latin1');
      assert.equal(text.replace(/\r\n/g, '').includes('\n'), false, `${name} has Windows line ends`);
      assert.ok(Math.max(...text.split('\r\n').map((l) => l.length)) < 1000, 'no line too long for the VBA editor');
    }
    const bas = readFileSync(join(dir, 'excel', 'BoardSync.bas'), 'latin1');
    assert.ok(bas.startsWith('Attribute VB_Name = "BoardSync"\r\nOption Explicit\r\n'));
    assert.deepEqual([...bas.matchAll(/CreateObject\("([^"]+)"\)/g)].map((m) => m[1]), ['WinHttp.WinHttpRequest.5.1'], 'only what Windows has');
    assert.ok(bas.includes(`Private Const NFIELDS As Long = ${SYNC_FIELDS.length}`), 'the macro and the board agree on the cells');
    for (const proc of ['BoardSync_Setup', 'BoardSync_Now', 'BoardSync_Unlink', 'BoardSync_Start', 'BoardSync_Stop', 'BoardSync_Changed', 'BoardSync_Tick'])
      assert.ok(bas.includes(`Public Sub ${proc}(`), proc);
    // the board hands the files out to people who can use the list, where the app has them
    const d = mkdtempSync(join(tmpdir(), 'eb-macro-'));
    const app = createApp({ dbPath: join(d, 'board.db'), tz: 'Asia/Kolkata', toolScriptDirs: [dir] });
    try {
      const base = `http://127.0.0.1:${await app.listen(0, '127.0.0.1')}`;
      const anon = await fetch(`${base}/api/workbook-link/macro/BoardSync.bas`);
      assert.equal(anon.status, 401);
      const c = new Client(base);
      const users = (await c.get('/api/users')).body.users as { id: number; name: string }[];
      await signIn(c, users.find((u) => u.name === 'Paul')!.id);
      const res = await fetch(`${base}/api/workbook-link/macro/BoardSync.bas`, { headers: { cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-disposition') ?? '', /BoardSync\.bas/);
      assert.ok(Buffer.from(await res.arrayBuffer()).equals(readFileSync(join(dir, 'excel', 'BoardSync.bas'))), 'byte for byte');
      assert.equal((await c.get('/api/workbook-link/macro/other.bas')).status, 404);
      assert.equal((await c.get('/api/workbook-link/macro/..%2Fdrawing_to_dcl.py')).status, 404);
    } finally {
      await app.close();
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('cells are compared by what they say', () => {
    assert.ok(sameCell('qty', '3', '3.0'));
    assert.ok(sameCell('qty', ' .5', '0.5'));
    assert.ok(!sameCell('qty', '3', '4'));
    assert.ok(sameCell('inventory', 'NIL', '0'));
    assert.ok(!sameCell('inventory', '', '0'));
    assert.ok(sameCell('means', 'In House', 'IN-HOUSE'));
    assert.ok(sameCell('coating', 'n/a', 'N/A'));
    assert.ok(sameCell('status', '', '0'));
    assert.ok(sameCell('material', 'PTFE ', 'PTFE'));
    assert.ok(!sameCell('name', 'Cavity', 'CAVITY'));
  });
});
