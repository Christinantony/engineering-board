// The procurement tracker (decision #39).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, Client, type Harness } from './helpers.ts';

describe('procurement tracker', () => {
  let h: Harness;
  let paul: Client;
  let allen: Client;
  let arrayProject: number;
  let nextArray: number;
  const ids: Record<string, number> = {};

  before(async () => {
    h = await startHarness();
    paul = await h.as('Paul');
    allen = await h.as('Allen');
    arrayProject = (await paul.post('/api/projects', { name: 'JK S 4A 70 spiral array' })).body.project.id;
    nextArray = (await paul.post('/api/projects', { name: 'Next spiral array' })).body.project.id;
  });
  after(() => h.close());

  const add = async (c: Client, project: number, fields: Record<string, unknown>) => {
    const r = await c.post(`/api/projects/${project}/procurement/items`, fields);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.item;
  };

  it('builds the master list, with the workbook\'s columns and defaults', async () => {
    const empty = (await paul.get(`/api/projects/${arrayProject}/procurement`)).body;
    assert.deepEqual(empty.totals, { items: 0, in_stock: 0, pending: 0 });
    assert.ok(empty.suggestions.disciplines.includes('RF') && empty.suggestions.disciplines.includes('Mechanical'));
    const spiral = await add(paul, arrayProject, { name: 'Spiral antenna element', discipline: 'RF', category: 'Single Antenna', means: 'outsourced', spec: 'Ø76 mm, 2–18 GHz', quantity: 5 });
    ids.spiral = spiral.id;
    assert.equal(spiral.unit, 'pcs');
    ids.cable = (await add(paul, arrayProject, { name: 'SMA cable', discipline: 'RF', category: 'Array', means: 'bought_out', spec: '300 mm, RG-402', quantity: 5 })).id;
    ids.plate = (await add(allen, arrayProject, { name: 'Mounting plate', discipline: 'Mechanical', category: 'Array', means: 'in_house', spec: '6 mm Al 6061, 400 × 400' })).id;
    ids.jig = (await add(allen, arrayProject, { name: 'Alignment jig', discipline: 'Mechanical', category: 'Tool', means: 'tools', spec: 'Printed PLA' })).id;
    const r = await paul.get(`/api/projects/${arrayProject}/procurement`);
    assert.deepEqual(r.body.items.map((i: any) => i.name), ['Spiral antenna element', 'SMA cable', 'Mounting plate', 'Alignment jig'], 'in the order added');
    assert.deepEqual(r.body.totals, { items: 4, in_stock: 0, pending: 4 });
    assert.equal(r.body.items[0].quantity, 5);
    // bad input
    assert.equal((await paul.post(`/api/projects/${arrayProject}/procurement/items`, { name: '' })).status, 400);
    assert.equal((await paul.post(`/api/projects/${arrayProject}/procurement/items`, { name: 'x', means: 'stolen' })).status, 400);
    assert.equal((await paul.post(`/api/projects/${arrayProject}/procurement/items`, { name: 'x', quantity: 0 })).status, 400);
    assert.equal((await paul.post(`/api/projects/9999/procurement/items`, { name: 'x' })).status, 404);
  });

  it('marks items in stock with the date, time and who, and logs every change', async () => {
    let r = await allen.post(`/api/procurement/items/${ids.cable}/stock`, { in_stock: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.item.in_stock_at, '2026-10-01T04:30:00.000Z');
    assert.equal(r.body.item.in_stock_by, (await allen.get('/api/session')).body.user.id);
    h.clock.advance(3_600_000);
    r = await paul.post(`/api/procurement/items/${ids.plate}/stock`, { in_stock: true });
    assert.equal(r.body.item.in_stock_at, '2026-10-01T05:30:00.000Z');
    // marking it again changes nothing and logs nothing
    await paul.post(`/api/procurement/items/${ids.plate}/stock`, { in_stock: true });
    const t = (await paul.get(`/api/projects/${arrayProject}/procurement`)).body;
    assert.deepEqual(t.totals, { items: 4, in_stock: 2, pending: 2 });
    const stockLog = t.log.filter((l: any) => l.kind === 'in_stock');
    assert.deepEqual(stockLog.map((l: any) => l.item_name), ['Mounting plate', 'SMA cable'], 'newest first');
    assert.equal(stockLog[0].item_spec, '6 mm Al 6061, 400 × 400');
    // taken back to pending (a wrong delivery): logged too
    r = await paul.post(`/api/procurement/items/${ids.plate}/stock`, { in_stock: false });
    assert.equal(r.body.item.in_stock_at, null);
    const after = (await paul.get(`/api/projects/${arrayProject}/procurement`)).body;
    assert.equal(after.log[0].kind, 'not_in_stock');
    assert.equal(after.totals.pending, 3);
    await paul.post(`/api/procurement/items/${ids.plate}/stock`, { in_stock: true });
  });

  it('edits an item with a version check, and removes it while keeping its log', async () => {
    const cur = (await paul.get(`/api/projects/${arrayProject}/procurement`)).body.items.find((i: any) => i.id === ids.spiral);
    let r = await paul.patch(`/api/procurement/items/${ids.spiral}`, { version: cur.version, spec: 'Ø76 mm, 2–18 GHz, gold plated', notes: 'PO 4512, due 20 Oct' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.item.spec, 'Ø76 mm, 2–18 GHz, gold plated');
    r = await allen.patch(`/api/procurement/items/${ids.spiral}`, { version: cur.version, quantity: 6 });
    assert.equal(r.status, 409, 'a stale version is refused');
    assert.equal(r.body.current.notes, 'PO 4512, due 20 Oct');
    const spare = await add(paul, arrayProject, { name: 'Spare connector', means: 'bought_out' });
    r = await paul.del(`/api/procurement/items/${spare.id}`);
    assert.equal(r.status, 200);
    const t = (await paul.get(`/api/projects/${arrayProject}/procurement`)).body;
    assert.equal(t.items.some((i: any) => i.id === spare.id), false);
    assert.equal(t.log[0].kind, 'removed');
    assert.equal(t.log[0].item_name, 'Spare connector');
    assert.equal((await paul.post(`/api/procurement/items/${spare.id}/stock`, { in_stock: true })).status, 404);
  });

  it('starts another project from this list, all pending, and copying twice adds nothing', async () => {
    let r = await paul.post(`/api/projects/${nextArray}/procurement/copy`, { from_project_id: arrayProject });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { copied: 4, skipped: 0 });
    const t = (await paul.get(`/api/projects/${nextArray}/procurement`)).body;
    assert.deepEqual(t.totals, { items: 4, in_stock: 0, pending: 4 });
    assert.equal(t.items.every((i: any) => i.notes === ''), true, 'notes such as POs stay with the old project');
    assert.equal(t.items[0].quantity, 5);
    r = await paul.post(`/api/projects/${nextArray}/procurement/copy`, { from_project_id: arrayProject });
    assert.deepEqual(r.body, { copied: 0, skipped: 4 });
    assert.equal((await paul.post(`/api/projects/${nextArray}/procurement/copy`, { from_project_id: nextArray })).status, 400);
    assert.deepEqual(
      (await paul.get(`/api/projects/${nextArray}/procurement`)).body.copy_from.map((p: any) => p.name),
      ['JK S 4A 70 spiral array'],
    );
  });

  it('exports the master list as CSV for Excel', async () => {
    const res = await fetch(`${paul.base}/api/projects/${arrayProject}/procurement.csv`, { headers: { cookie: [...paul.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') ?? '', /JK S 4A 70 spiral array - procurement 2026-10-01\.csv/);
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'a BOM so Excel reads UTF-8');
    const lines = bytes.subarray(3).toString('utf8').trim().split('\r\n');
    assert.equal(lines[0], 'No.,Item,Discipline,Category,Means,Final size / spec,Quantity,Unit,Status,In stock since,Marked by,Notes');
    assert.match(lines[2], /^2,SMA cable,RF,Array,Bought-out,"300 mm, RG-402",5,pcs,In stock,2026-10-01T04:30:00.000Z,Allen,$/);
    assert.equal(lines.length, 5);
  });

  it('goes into the full export, and is not for reviewers', async () => {
    const admin = await h.as('Christin');
    await admin.post('/api/admin/unlock', { pin: '1234' });
    const all = (await admin.get('/api/export/tickets.json')).body;
    assert.equal(all.procurement.items.filter((i: any) => i.project === 'JK S 4A 70 spiral array' && !i.removed_at).length, 4);
    assert.ok(all.procurement.log.some((l: any) => l.kind === 'in_stock' && l.by === 'Allen'));
    await admin.post('/api/admin/users', { name: 'Ebin', role: 'reviewer' });
    const ebin = await h.as('Ebin');
    assert.equal((await ebin.get(`/api/projects/${arrayProject}/procurement`)).status, 403);
    assert.equal((await ebin.post(`/api/procurement/items/${ids.jig}/stock`, { in_stock: true })).status, 403);
  });

  it('keeps a demo project that has a procurement list when demo data is removed', async () => {
    const admin = await h.as('Christin');
    await admin.post('/api/admin/unlock', { pin: '1234' });
    assert.equal((await admin.post('/api/admin/demo')).status, 200);
    const skid = (await admin.get('/api/projects')).body.projects.find((p: any) => p.name === 'Pump skid').id;
    await add(admin, skid, { name: 'Pump coupling', means: 'bought_out' });
    const r = await admin.del('/api/admin/demo');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await admin.get(`/api/projects/${skid}/procurement`)).body.items.length, 1, 'the list someone typed is kept');
  });
});
