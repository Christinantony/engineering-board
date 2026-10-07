// Tools (decision #32): the sheet calculator, checked against the team's
// Sheet Requirement Calculator workbook (docs/tools/), and the reference data
// kept by the admin.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { calculateSheets, fitOnSize, gridFit, type SheetMaterial, type SheetSize } from '@board/shared';
import { INITIAL_MATERIALS } from '../src/domain/tools.ts';
import { startHarness, Client, type Harness } from './helpers.ts';

describe('sheet calculator: the workbook, formula for formula', () => {
  const steel: SheetMaterial = { id: 1, name: 'Mild Steel', sort_order: 10, active: true };
  const copper: SheetMaterial = { id: 4, name: 'Copper', sort_order: 40, active: true };
  const sizes: SheetSize[] = [
    { id: 1, material_id: 1, length: 2500, width: 1250, active: true },
    { id: 4, material_id: 4, length: 2000, width: 1000, active: true },
  ];
  // the workbook as delivered: Mild Steel, a = 150, b = 100, n = 500, kerf 3, margin 5, rotation Yes
  const example = { length: 150, width: 100, quantity: 500 };
  const wb = { kerf: 3, margin: 5, rotate: true };

  it('reproduces the Calculator sheet of the delivered workbook exactly', () => {
    const r = fitOnSize(example, sizes[0], wb);
    assert.equal(r.usable_length, 2490); // B16
    assert.equal(r.usable_width, 1240); // B17
    assert.equal(r.per_sheet_1, 192); // B20: INT(2493/153)=16 × INT(1243/103)=12
    assert.equal(r.per_sheet_2, 192); // B21: INT(2493/103)=24 × INT(1243/153)=8
    assert.equal(r.per_sheet, 192); // B22
    assert.equal(r.orientation, 'along'); // B23: "a along length" (ties go to orientation 1, as the workbook's IF does)
    assert.equal(r.sheets, 3); // B26: ROUNDUP(500/192)
    assert.equal(r.last_sheet_parts, 116); // B27: 500 − 2 × 192
    assert.equal(r.parts_area, 7.5); // B28
    assert.equal(r.purchased_area, 9.375); // B29
    assert.equal(r.utilisation, 0.8); // B30
    assert.equal(r.waste_area, 1.875); // B31
    // the Layout sheet
    assert.deepEqual(r.layout, { across: 16, down: 12, part_length: 150, part_width: 100, usable_length: 2490, usable_width: 1240, strip_length: 45, strip_width: 7 });
  });

  it('follows the workbook when rotation is off, when the part only fits one way, and when it does not fit', () => {
    const noRotate = fitOnSize({ length: 1300, width: 400, quantity: 10 }, sizes[0], { ...wb, rotate: false });
    assert.equal(noRotate.per_sheet_1, 1 * 3); // 1300 along 2490 once; 400 along 1240 three times
    assert.equal(noRotate.per_sheet, 3, 'orientation 1 only when rotation is off');
    const rotated = fitOnSize({ length: 1300, width: 400, quantity: 10 }, sizes[0], wb);
    assert.equal(rotated.per_sheet_2, 0, 'b along length: 400 fits 6 times but 1300 does not fit the 1240 width');
    assert.equal(rotated.per_sheet, 3);
    const tall = fitOnSize({ length: 1245, width: 100, quantity: 10 }, sizes[0], wb);
    assert.equal(tall.per_sheet_1, 1 * 12, 'a along the length');
    assert.equal(tall.per_sheet_2, 0, 'rotated it is taller than the usable width');
    const huge = fitOnSize({ length: 2600, width: 100, quantity: 1 }, sizes[0], wb);
    assert.equal(huge.per_sheet, 0);
    assert.equal(huge.orientation, 'none');
    assert.equal(huge.sheets, 0);
    assert.equal(huge.layout, null);
    assert.equal(gridFit(2490, 1240, 150, 100, 0), 16 * 12, 'no kerf: plain division');
    assert.equal(gridFit(-10, 1240, 150, 100, 3), 0, 'a margin larger than the sheet gives MAX(0, …) = 0, as the workbook does');
  });

  it('runs the sums for every row, totals per material, and skips what it cannot count', () => {
    const r = calculateSheets(
      [
        { name: 'Bracket', material_id: 1, length: 150, width: 100, quantity: 500 },
        { name: 'Plate', material_id: 1, length: 1200, width: 600, quantity: 4 },
        { name: 'Bus bar', material_id: 4, length: 400, width: 50, quantity: 20 },
        { name: 'No material', material_id: null, length: 100, width: 100, quantity: 1 },
        { name: 'No size', material_id: 1, length: null, width: 100, quantity: 1 },
        { name: 'Half a part', material_id: 1, length: 100, width: 100, quantity: 2.5 },
        { name: '', material_id: null, length: null, width: null, quantity: null }, // an untouched row
      ],
      [steel, copper],
      sizes,
      wb,
    );
    assert.deepEqual(
      r.rows.map((x) => [x.name, x.best?.sheets]),
      [
        ['Bracket', 3],
        ['Plate', 1], // 2 × 2 = 4 per sheet (rotated 4 × 1 = 4 too; the tie keeps orientation 1)
        ['Bus bar', 1],
      ],
    );
    assert.deepEqual(
      r.by_material.map((t) => [t.material.name, t.sheets]),
      [
        ['Mild Steel', 4],
        ['Copper', 1],
      ],
    );
    assert.equal(r.total_sheets, 5);
    assert.deepEqual(r.skipped, [
      { name: 'No material', reason: 'no material' },
      { name: 'No size', reason: 'length and width needed' },
      { name: 'Half a part', reason: 'a whole number of components needed' },
    ]);
  });

  it('with several stock sizes for one material, uses the one needing the fewest sheets', () => {
    const twoSizes = [...sizes, { id: 9, material_id: 1, length: 3000, width: 1500, active: true }, { id: 10, material_id: 1, length: 1000, width: 500, active: false }];
    const r = calculateSheets([{ name: 'Cover', material_id: 1, length: 1250, width: 1250, quantity: 3 }], [steel], twoSizes, wb);
    const row = r.rows[0];
    assert.equal(row.options.length, 2, 'the retired size is not offered');
    assert.equal(row.options[0].per_sheet, 0, 'a 1250 square does not fit the 1240 usable width of a 2500×1250 sheet');
    assert.equal(row.best!.size.length, 3000, '2 per 3000×1500 sheet → 2 sheets');
    assert.equal(row.best!.sheets, 2);
    assert.deepEqual(r.by_material[0].by_size.map((b) => [b.size.length, b.sheets]), [[3000, 2]]);
  });
});

describe('tools: reference data kept by the admin', () => {
  let h: Harness;
  let admin: Client;
  let paul: Client;
  before(async () => {
    h = await startHarness();
    admin = await h.as('Christin');
    await admin.post('/api/admin/unlock', { pin: '1234' });
    paul = await h.as('Paul');
  });
  after(() => h.close());

  it("a new board starts with the workbook's Materials sheet, readable by anyone on the board", async () => {
    const r = await paul.get('/api/tools/sheet');
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.body.materials.map((m: any) => m.name),
      INITIAL_MATERIALS.map((m) => m.name),
    );
    assert.deepEqual(
      r.body.sizes.map((s: any) => [s.length, s.width]),
      INITIAL_MATERIALS.map((m) => [m.length, m.width]),
    );
    assert.equal(r.body.materials[0].name, 'Mild Steel');
    assert.deepEqual(r.body.settings, { kerf: 3, margin: 5, rotate: true }, "the workbook's input defaults");
    assert.equal((await new Client(h.base).get('/api/tools/sheet')).status, 401);
  });

  it('the admin adds, renames, reorders and retires materials; names are unique', async () => {
    assert.equal((await paul.post('/api/admin/materials', { name: 'Titanium' })).status, 403, 'needs the admin PIN');
    let r = await admin.post('/api/admin/materials', { name: 'Titanium' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const ti = r.body.material;
    assert.equal((await admin.post('/api/admin/materials', { name: 'titanium' })).status, 409, 'same name, other case');
    assert.equal((await admin.post('/api/admin/materials', { name: '' })).status, 400);
    r = await admin.patch(`/api/admin/materials/${ti.id}`, { name: 'Titanium Gr 2', sort_order: 5 });
    assert.equal(r.status, 200);
    const list = (await paul.get('/api/tools/sheet')).body.materials;
    assert.equal(list[0].name, 'Titanium Gr 2', 'sort order moved it first');
    r = await admin.patch(`/api/admin/materials/${ti.id}`, { active: false });
    assert.equal(r.body.material.active, false);
    assert.equal((await admin.patch('/api/admin/materials/9999', { name: 'x' })).status, 404);
  });

  it('sheet sizes belong to a material, are unique, and can be changed or removed', async () => {
    const steel = (await paul.get('/api/tools/sheet')).body.materials.find((m: any) => m.name === 'Mild Steel');
    let r = await admin.post('/api/admin/sheet-sizes', { material_id: steel.id, length: 3000, width: 1500 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const size = r.body.size;
    assert.equal((await admin.post('/api/admin/sheet-sizes', { material_id: steel.id, length: 3000, width: 1500 })).status, 409);
    assert.equal((await admin.post('/api/admin/sheet-sizes', { material_id: steel.id, length: 2500, width: 1250 })).status, 409, "the workbook's size");
    assert.equal((await admin.post('/api/admin/sheet-sizes', { material_id: 9999, length: 1, width: 1 })).status, 404);
    assert.equal((await admin.post('/api/admin/sheet-sizes', { material_id: steel.id, length: 0, width: 1 })).status, 400);
    r = await admin.patch(`/api/admin/sheet-sizes/${size.id}`, { length: 6000, width: 2000 });
    assert.equal(r.body.size.length, 6000);
    // the calculator uses the live list
    const d = (await paul.get('/api/tools/sheet')).body;
    const rep = calculateSheets([{ name: 'Plate', material_id: steel.id, length: 1200, width: 1200, quantity: 8 }], d.materials, d.sizes, d.settings);
    assert.equal(rep.rows[0].best!.size.length, 6000, '8 per 6000×2000 sheet → 1 sheet');
    assert.equal((await paul.del(`/api/admin/sheet-sizes/${size.id}`)).status, 403);
    assert.equal((await admin.del(`/api/admin/sheet-sizes/${size.id}`)).status, 200);
    assert.equal((await admin.del(`/api/admin/sheet-sizes/${size.id}`)).status, 404);
  });

  it('the input defaults are validated and kept', async () => {
    assert.equal((await admin.put('/api/admin/tools/sheet-settings', { kerf: -1, margin: 5, rotate: true })).status, 400);
    assert.equal((await admin.put('/api/admin/tools/sheet-settings', { kerf: 3, margin: 5, rotate: 'yes' })).status, 400);
    const r = await admin.put('/api/admin/tools/sheet-settings', { kerf: 2, margin: 10, rotate: false });
    assert.equal(r.status, 200);
    await h.restart();
    const p2 = await h.as('Paul');
    assert.deepEqual((await p2.get('/api/tools/sheet')).body.settings, { kerf: 2, margin: 10, rotate: false });
  });

  it('the seeded list is written once: an emptied size list stays empty after a restart', async () => {
    const a2 = await h.as('Christin');
    await a2.post('/api/admin/unlock', { pin: '1234' });
    const d = (await a2.get('/api/tools/sheet')).body;
    for (const s of d.sizes) assert.equal((await a2.del(`/api/admin/sheet-sizes/${s.id}`)).status, 200);
    await h.restart();
    const p3 = await h.as('Paul');
    assert.equal((await p3.get('/api/tools/sheet')).body.sizes.length, 0, 'materials still exist, so nothing is re-seeded');
  });
});
