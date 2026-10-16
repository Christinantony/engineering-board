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
    assert.equal(lines[0], 'No.,Item,Final size / spec,Qty / unit,Per,Total qty,Unit,Inventory,In procurement,Material,Discipline,Category,Means,Status,In stock since,Marked by,Notes');
    assert.match(lines[2], /^2,SMA cable,"300 mm, RG-402",5,in total,5,pcs,,CHECK,,RF,Array,Bought-out,In stock,2026-10-01T04:30:00.000Z,Allen,$/);
    assert.equal(lines.length, 7);
    assert.match(lines[6], /^Build: 0 arrays × 0 antennas per array \+ 0 extra antennas \(spare\) = 0 antennas to build$/);
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

  it('works out totals from what the project builds: per antenna, per array or in total (decision #45)', async () => {
    const proj = (await paul.post('/api/projects', { name: 'Five-element spiral arrays' })).body.project.id;
    let d = (await paul.get(`/api/projects/${proj}/procurement`)).body;
    assert.deepEqual(
      { arrays: d.build.arrays, per_array: d.build.per_array, spares: d.build.spares, antennas: d.build.antennas, version: d.build.version },
      { arrays: 0, per_array: 0, spares: 0, antennas: 0, version: 0 },
    );
    const element = await add(paul, proj, { name: 'Spiral element', category: 'Single Antenna', quantity: 1, basis: 'antenna' });
    const sma = await add(paul, proj, { name: 'SMA connector', category: 'Single Antenna', quantity: 2, basis: 'antenna' });
    const plate = await add(paul, proj, { name: 'Array base plate', category: 'Array', quantity: 1, basis: 'array' });
    const jig = await add(paul, proj, { name: 'Alignment jig', category: 'Tool', quantity: 2 });
    assert.equal(jig.basis, 'total');
    assert.equal(element.required, 0, 'nothing needed per antenna until the build is set');
    // 6 arrays of 5 antennas, and 2 separate antennas (spares)
    let r = await paul.put(`/api/projects/${proj}/procurement/build`, { version: 0, arrays: 6, per_array: 5, spares: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.build.antennas, 32);
    assert.equal(r.body.build.version, 1);
    d = (await paul.get(`/api/projects/${proj}/procurement`)).body;
    const need = (id: number) => d.items.find((i: any) => i.id === id).required;
    assert.equal(need(element.id), 32);
    assert.equal(need(sma.id), 64);
    assert.equal(need(plate.id), 6);
    assert.equal(need(jig.id), 2);
    // two people can't overwrite each other; every change is kept
    r = await allen.put(`/api/projects/${proj}/procurement/build`, { version: 0, arrays: 7, per_array: 5, spares: 0 });
    assert.equal(r.status, 409);
    assert.equal((await allen.put(`/api/projects/${proj}/procurement/build`, { version: 1, arrays: -1, per_array: 5, spares: 0 })).status, 400);
    r = await allen.put(`/api/projects/${proj}/procurement/build`, { version: 1, arrays: 8, per_array: 5, spares: 2 });
    assert.equal(r.body.build.antennas, 42);
    d = (await paul.get(`/api/projects/${proj}/procurement`)).body;
    assert.deepEqual(
      d.build_log.map((l: any) => [l.arrays, l.per_array, l.spares]),
      [
        [8, 5, 2],
        [6, 5, 2],
      ],
    );
    // changing an item's basis
    r = await paul.patch(`/api/procurement/items/${jig.id}`, { version: jig.version, basis: 'array' });
    assert.equal(r.body.item.required, 16);
    // manufacturing works to the total needed, and a smaller build can't undercut what it has recorded
    r = await paul.put(`/api/manufacturing/items/${sma.id}`, { version: 0, stage: 'inspection', in_process: 0, received: 80, accepted: 80, rejected: 0, escalation: 'none', detail: 'All 84 connectors in, 80 checked' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await paul.get('/api/manufacturing')).body.items.find((i: any) => i.id === sma.id).quantity, 84);
    r = await paul.put(`/api/projects/${proj}/procurement/build`, { version: 2, arrays: 6, per_array: 5, spares: 2 });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message ?? r.body.message ?? JSON.stringify(r.body), /SMA connector/);
    assert.equal((await paul.get(`/api/projects/${proj}/procurement`)).body.build.arrays, 8, 'refused builds change nothing');
    assert.equal((await paul.patch(`/api/procurement/items/${sma.id}`, { version: sma.version, basis: 'total' })).status, 400);
    // the export has the build; copying the list to a new project brings the build and the bases
    const admin = await h.as('Christin');
    await admin.post('/api/admin/unlock', { pin: '1234' });
    const ex = (await admin.get('/api/export/tickets.json')).body;
    assert.equal(ex.procurement.builds.find((b: any) => b.project === 'Five-element spiral arrays').antennas, 42);
    assert.equal(ex.procurement.items.find((i: any) => i.name === 'SMA connector').required, 84);
    const next = (await paul.post('/api/projects', { name: 'Spiral arrays, second batch' })).body.project.id;
    assert.equal((await paul.post(`/api/projects/${next}/procurement/copy`, { from_project_id: proj })).status, 200);
    const n = (await paul.get(`/api/projects/${next}/procurement`)).body;
    assert.equal(n.build.antennas, 42);
    assert.equal(n.items.find((i: any) => i.name === 'SMA connector').basis, 'antenna');
    assert.equal(n.items.find((i: any) => i.name === 'SMA connector').required, 84);
  });

  it('gives the inventory workbook\'s own figures: total qty, inventory and in procurement (decision #45)', async () => {
    // 3_inch_Inventory_Check_v9.xlsm: 5 arrays × 4 antennas + 2 extra (spare) = 22 antennas to build
    const proj = (await paul.post('/api/projects', { name: 'JK S 4A 70 workbook check' })).body.project.id;
    let r = await paul.put(`/api/projects/${proj}/procurement/build`, { version: 0, arrays: 5, per_array: 4, spares: 2 });
    assert.equal(r.body.build.antennas, 22);
    // rows as typed in the workbook's Master List (Part name, Qty / unit, Inventory, Material, Category);
    // the basis is left to "Count by category", as for a list typed before 2.3
    const rows: [string, number, number | null, string, string, string][] = [
      ['Cavity', 1, 6, '', 'ALUMINIUM 6061-T651', 'Single Antenna'],
      ['DELRIN 02', 1, 0, '', 'DELRIN', 'Single Antenna'], // NIL
      ['FLX 01', 1, null, '', 'FLX', 'Single Antenna'], // blank
      ['MF DISC', 4, 0, '', 'TC 2800 HT', 'Single Antenna'],
      ['VENT SCREW', 1, null, 'M3X8', '', 'Single Antenna'],
      ['ARRAY BLOCK', 1, 0, '', 'ALUMINIUM 6061-T651', 'Array'],
      ['MOUNTING HOLE SLEEVE', 14, 0, '', '', 'Array'],
      ['HELICOIL', 25, 25, '', '', 'Array'],
      ['HELICOIL TAP', 1, 1, '', '', 'Tool'],
      ['Odd one', 3, 1, '', '', 'Fixture'],
    ];
    for (const [name, quantity, inventory, inventory_note, material, category] of rows) await add(paul, proj, { name, quantity, inventory, inventory_note, material, category });
    let d = (await paul.get(`/api/projects/${proj}/procurement`)).body;
    assert.ok(d.items.every((i: any) => i.basis === 'total'));
    assert.deepEqual(d.suggestions.materials.filter((m: string) => m.startsWith('ALUMINIUM') || m === 'TC 2800 HT'), ['ALUMINIUM 6061-T651', 'TC 2800 HT']);
    r = await paul.post(`/api/projects/${proj}/procurement/basis-from-category`, {});
    assert.equal(r.status, 200);
    assert.equal(r.body.changed, 8, 'Single Antenna and Array items change; Tool stays in total; an unknown category is left alone');
    assert.equal((await paul.post(`/api/projects/${proj}/procurement/basis-from-category`, {})).body.changed, 0);
    d = (await paul.get(`/api/projects/${proj}/procurement`)).body;
    const got = Object.fromEntries(d.items.map((i: any) => [i.name, [i.required, i.to_procure]]));
    // the workbook's cached values of Total qty (E) and In procurement (G); CHECK is null
    assert.deepEqual(got, {
      Cavity: [22, 16],
      'DELRIN 02': [22, 22],
      'FLX 01': [22, null],
      'MF DISC': [88, 88],
      'VENT SCREW': [22, null],
      'ARRAY BLOCK': [5, 5],
      'MOUNTING HOLE SLEEVE': [70, 70],
      HELICOIL: [125, 100],
      'HELICOIL TAP': [1, 0],
      'Odd one': [3, 2],
    });
    // the inventory and material are ordinary, versioned edits
    const cavity = d.items.find((i: any) => i.name === 'Cavity');
    r = await allen.patch(`/api/procurement/items/${cavity.id}`, { version: cavity.version, inventory: 30, material: 'AL 6061' });
    assert.deepEqual([r.body.item.inventory, r.body.item.to_procure, r.body.item.material], [30, 0, 'AL 6061']);
    assert.equal((await allen.patch(`/api/procurement/items/${cavity.id}`, { version: r.body.item.version, inventory: -1 })).status, 400);
    // the CSV carries the workbook's columns
    const csv = String((await paul.get(`/api/projects/${proj}/procurement.csv`)).body);
    assert.match(csv, /Qty \/ unit,Per,Total qty,Unit,Inventory,In procurement,Material/);
    assert.match(csv, /VENT SCREW,,1,per antenna,22,pcs,M3X8,CHECK,/);
    assert.match(csv, /5 arrays × 4 antennas per array \+ 2 extra antennas \(spare\) = 22 antennas to build/);
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
