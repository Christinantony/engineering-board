// Tools (decision #32): the sheet calculator's reference data, kept by the
// admin, and the calculation itself.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { calculateSheets, piecesPerSheet, type SheetMaterial, type SheetSize } from '@board/shared';
import { INITIAL_MATERIALS } from '../src/domain/tools.ts';
import { startHarness, Client, type Harness } from './helpers.ts';

describe('sheet calculator: the sums', () => {
  const steel: SheetMaterial = { id: 1, name: 'Mild steel', density: 7850, sort_order: 10, active: true };
  const alu: SheetMaterial = { id: 2, name: 'Aluminium', density: null, sort_order: 20, active: true };
  const sizes: SheetSize[] = [
    { id: 1, material_id: 1, thickness: null, length: 2500, width: 1250, active: true },
    { id: 2, material_id: 1, thickness: null, length: 3000, width: 1500, active: true },
    { id: 3, material_id: 1, thickness: 10, length: 6000, width: 2000, active: true },
    { id: 4, material_id: 2, thickness: null, length: 2500, width: 1250, active: true },
    { id: 5, material_id: 2, thickness: null, length: 2000, width: 1000, active: false },
  ];
  const settings = { utilisation: 0.85, kerf: 0 };

  it('counts pieces per sheet in a grid, in the better orientation, with the kerf between pieces', () => {
    assert.equal(piecesPerSheet(2500, 1250, 500, 250, 0), 25);
    assert.equal(piecesPerSheet(2500, 1250, 1250, 400, 0), 6); // 2 along × 3 across, rotated
    assert.equal(piecesPerSheet(2500, 1250, 2600, 100, 0), 0); // too long either way
    assert.equal(piecesPerSheet(2500, 1250, 500, 250, 5), 18); // rotated: 9 along × 2 across once each cut takes 5 mm
  });

  it('groups by material and thickness, picks the size needing the fewest sheets, and reports mass', () => {
    const r = calculateSheets(
      [
        { name: 'Base plate', material_id: 1, thickness: 6, length: 1200, width: 600, quantity: 4 },
        { name: 'Gusset', material_id: 1, thickness: 6, length: 300, width: 300, quantity: 20 },
        { name: 'Cover', material_id: 1, thickness: 3, length: 2400, width: 1200, quantity: 3 },
        { name: 'Bracket', material_id: 2, thickness: 3, length: 400, width: 200, quantity: 10 },
      ],
      [steel, alu],
      sizes,
      settings,
    );
    assert.equal(r.groups.length, 3);
    const [steel3, steel6, alu3] = r.groups;
    assert.equal(steel3.thickness, 3);
    assert.equal(steel6.thickness, 6);
    assert.equal(alu3.material.id, 2);
    // 6 mm: both stock sizes need 2 sheets (2500×1250: 4 plates and 32 gussets per sheet; 3000×1500: 5 and 50), so the smaller sheet wins the tie
    const best6 = steel6.best!;
    assert.equal(best6.size.length, 2500);
    assert.equal(best6.sheets_by_fit, Math.ceil(4 / 4 + 20 / 32));
    assert.equal(best6.sheets_by_area, Math.ceil((4 * 1200 * 600 + 20 * 300 * 300) / (2500 * 1250 * 0.85)));
    assert.equal(best6.required, 2);
    const big6 = steel6.options.find((o) => o.size.length === 3000)!;
    assert.equal(big6.sheets_by_fit, Math.ceil(4 / 5 + 20 / 50));
    assert.equal(big6.required, 2);
    assert.ok(steel6.options.every((o) => o.size.thickness !== 10), 'a size stocked only in 10 mm is not offered for 6 mm');
    // 3 mm covers: one per sheet on either stock size, but by area 2500×1250 needs 4 (8.64 m² ÷ 2.66 m² usable) and 3000×1500 needs 3, so the larger sheet wins
    assert.equal(steel3.options.find((o) => o.size.length === 2500)!.required, 4);
    assert.equal(steel3.best!.required, 3);
    assert.equal(steel3.best!.size.length, 3000);
    assert.equal(steel3.mass_kg, (3 * 3000 * 1500 * 3 * 7850) / 1e9);
    // aluminium: the retired size is ignored; no density → no mass
    assert.equal(alu3.options.length, 1);
    assert.equal(alu3.best!.required, 1);
    assert.equal(alu3.mass_kg, null);
    assert.equal(r.total_sheets, 2 + 3 + 1);
    assert.deepEqual(r.unplaced, []);
  });

  it('says what it could not count: no material or thickness, missing numbers, parts larger than any sheet', () => {
    const r = calculateSheets(
      [
        { name: 'No material', material_id: null, thickness: 3, length: 100, width: 100, quantity: 1 },
        { name: 'No size', material_id: 1, thickness: 3, length: null, width: 100, quantity: 1 },
        { name: 'Huge', material_id: 1, thickness: 3, length: 7000, width: 100, quantity: 1 },
        { name: '', material_id: null, thickness: null, length: null, width: null, quantity: 1 },
      ],
      [steel],
      sizes,
      settings,
    );
    assert.deepEqual(r.unplaced, ['No material']);
    assert.equal(r.groups.length, 1);
    assert.deepEqual(r.groups[0].skipped, ['No size']);
    assert.equal(r.groups[0].best, null);
    assert.ok(r.groups[0].options.every((o) => o.misfits.includes('Huge')));
    assert.equal(r.total_sheets, 0);
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

  it('a new board starts with a usable list of materials and sheet sizes, readable by anyone on the board', async () => {
    const r = await paul.get('/api/tools/sheet');
    assert.equal(r.status, 200);
    assert.deepEqual(
      r.body.materials.map((m: any) => m.name),
      INITIAL_MATERIALS.map((m) => m.name),
    );
    assert.equal(r.body.sizes.length, INITIAL_MATERIALS.reduce((n, m) => n + m.sizes.length, 0));
    assert.deepEqual(r.body.settings, { utilisation: 0.85, kerf: 0 });
    assert.equal((await new Client(h.base).get('/api/tools/sheet')).status, 401);
  });

  it('the admin adds, renames, reorders and retires materials; names are unique', async () => {
    assert.equal((await paul.post('/api/admin/materials', { name: 'Brass' })).status, 403, 'needs the admin PIN');
    let r = await admin.post('/api/admin/materials', { name: 'Brass', density: 8500 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const brass = r.body.material;
    assert.equal(brass.density, 8500);
    assert.equal((await admin.post('/api/admin/materials', { name: 'brass' })).status, 409, 'same name, other case');
    assert.equal((await admin.post('/api/admin/materials', { name: '' })).status, 400);
    r = await admin.patch(`/api/admin/materials/${brass.id}`, { name: 'Brass CZ121', density: null, sort_order: 5 });
    assert.equal(r.status, 200);
    assert.equal(r.body.material.density, null);
    const list = (await paul.get('/api/tools/sheet')).body.materials;
    assert.equal(list[0].name, 'Brass CZ121', 'sort order moved it first');
    r = await admin.patch(`/api/admin/materials/${brass.id}`, { active: false });
    assert.equal(r.body.material.active, false);
    assert.equal((await admin.patch('/api/admin/materials/9999', { name: 'x' })).status, 404);
  });

  it('sheet sizes belong to a material, are unique per thickness, and can be removed', async () => {
    const steel = (await paul.get('/api/tools/sheet')).body.materials.find((m: any) => /Mild steel/.test(m.name));
    let r = await admin.post('/api/admin/sheet-sizes', { material_id: steel.id, thickness: 12, length: 6000, width: 2000 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const size = r.body.size;
    assert.equal((await admin.post('/api/admin/sheet-sizes', { material_id: steel.id, thickness: 12, length: 6000, width: 2000 })).status, 409);
    assert.equal((await admin.post('/api/admin/sheet-sizes', { material_id: steel.id, length: 2500, width: 1250 })).status, 409, 'the seeded any-thickness size');
    assert.equal((await admin.post('/api/admin/sheet-sizes', { material_id: 9999, length: 1, width: 1 })).status, 404);
    assert.equal((await admin.post('/api/admin/sheet-sizes', { material_id: steel.id, length: 0, width: 1 })).status, 400);
    r = await admin.patch(`/api/admin/sheet-sizes/${size.id}`, { thickness: 16 });
    assert.equal(r.body.size.thickness, 16);
    assert.equal((await paul.del(`/api/admin/sheet-sizes/${size.id}`)).status, 403);
    assert.equal((await admin.del(`/api/admin/sheet-sizes/${size.id}`)).status, 200);
    assert.equal((await admin.del(`/api/admin/sheet-sizes/${size.id}`)).status, 404);
    // the calculator uses the live list: a 12 mm part gets only sizes stocked for any thickness now
    const d = (await paul.get('/api/tools/sheet')).body;
    const rep = calculateSheets([{ name: 'Plate', material_id: steel.id, thickness: 12, length: 1000, width: 1000, quantity: 1 }], d.materials, d.sizes, d.settings);
    assert.ok(rep.groups[0].options.every((o) => o.size.thickness == null));
  });

  it('settings are validated and kept', async () => {
    assert.equal((await admin.put('/api/admin/tools/sheet-settings', { utilisation: 1.5, kerf: 0 })).status, 400);
    assert.equal((await admin.put('/api/admin/tools/sheet-settings', { utilisation: 0.8, kerf: -1 })).status, 400);
    const r = await admin.put('/api/admin/tools/sheet-settings', { utilisation: 0.8, kerf: 3 });
    assert.equal(r.status, 200);
    await h.restart();
    const p2 = await h.as('Paul');
    assert.deepEqual((await p2.get('/api/tools/sheet')).body.settings, { utilisation: 0.8, kerf: 3 });
  });

  it('the seeded list is written once: an emptied list stays as the admin left it after a restart', async () => {
    const a2 = await h.as('Christin');
    await a2.post('/api/admin/unlock', { pin: '1234' });
    const d = (await a2.get('/api/tools/sheet')).body;
    for (const s of d.sizes) assert.equal((await a2.del(`/api/admin/sheet-sizes/${s.id}`)).status, 200);
    await h.restart();
    const p3 = await h.as('Paul');
    assert.equal((await p3.get('/api/tools/sheet')).body.sizes.length, 0, 'materials still exist, so nothing is re-seeded');
  });
});
