// Turning parts where it fits more, and the offcut in one piece (decision #44).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkSheet, fitOnSize, IdenticalPacker, offcutOf, type SheetPattern } from '@board/shared';

const S = { kerf: 3, margin: 5, rotate: true };

/** The pattern's slots as nesting parts, for the shop-floor check: inside the margin and a kerf apart. */
function check(p: SheetPattern, size: { length: number; width: number }, s: { kerf: number; margin: number }) {
  const parts = p.parts.map((q, i) => ({ part: 0, n: i + 1, ...q }));
  return checkSheet({ parts, parts_area: 0, utilisation: 0, reach_length: 0, reach_width: 0, offcut: null }, size, s);
}

describe('sheet patterns', () => {
  it('keeps the workbook\'s answer where its grid is already best', () => {
    const r = fitOnSize({ length: 150, width: 100, quantity: 500 }, { length: 2500, width: 1250 }, S);
    assert.equal(r.per_sheet, 192);
    assert.equal(r.per_sheet_mixed, 192);
    assert.equal(r.orientation, 'along');
    assert.equal(r.sheets, 3);
    assert.equal(r.last_sheet_parts, 116);
  });

  it('turns a block of parts when that fits more than either grid', () => {
    const r = fitOnSize({ length: 850, width: 250, quantity: 30 }, { length: 2400, width: 1200 }, S);
    assert.equal(r.per_sheet_1, 8);
    assert.equal(r.per_sheet_2, 9);
    assert.equal(r.per_sheet_mixed, 11);
    assert.equal(r.per_sheet, 11);
    assert.equal(r.orientation, 'mixed');
    assert.equal(r.sheets, 3); // 30 / 11, rounded up (the grid needed 4)
    const turned = r.full_sheet!.parts.filter((p) => p.rotated).length;
    assert.ok(turned > 0 && turned < 11);
    // rotation off: the workbook's orientation 1, nothing turned
    const off = fitOnSize({ length: 850, width: 250, quantity: 30 }, { length: 2400, width: 1200 }, { ...S, rotate: false });
    assert.equal(off.per_sheet, 8);
    assert.equal(off.per_sheet_mixed, 8);
    assert.ok(off.full_sheet!.parts.every((p) => !p.rotated));
  });

  it('gathers the last sheet\'s parts at one end, so the rest comes off in one piece', () => {
    const r = fitOnSize({ length: 150, width: 100, quantity: 500 }, { length: 2500, width: 1250 }, S);
    const last = r.last_sheet!;
    assert.equal(last.count, 116);
    const o = last.offcut!;
    assert.equal(o.side, 'end');
    assert.equal(o.width, 1250);
    assert.ok(o.length >= 1000, `offcut ${o.length} × ${o.width}`);
    for (const p of last.parts.slice(0, 116)) assert.ok(p.x + p.length + 3 <= o.x + 1e-6, 'every used part is clear of the offcut by a kerf');
    assert.deepEqual(check(last, { length: 2500, width: 1250 }, S), []);
  });

  it('makes only patterns that fit: inside the margin, a kerf apart, as many slots as it says (400 cases)', () => {
    let checked = 0;
    for (let i = 0; i < 400; i++) {
      const a = 20 + ((i * 7919) % 900);
      const b = 20 + ((i * 104729) % 600);
      const s = { kerf: [0, 3, 10][i % 3], margin: [0, 5, 10][(i >> 1) % 3], rotate: i % 7 !== 0 };
      const size = [
        { length: 2400, width: 1200 },
        { length: 2500, width: 1250 },
        { length: 3000, width: 1500 },
      ][i % 3];
      const r = fitOnSize({ length: a, width: b, quantity: 37 }, size, s);
      assert.ok(r.per_sheet >= Math.max(r.per_sheet_1, s.rotate ? r.per_sheet_2 : 0), 'never fewer than the workbook');
      for (const p of [r.full_sheet, r.last_sheet]) {
        if (!p) continue;
        checked++;
        assert.ok(p.parts.length >= p.count);
        assert.deepEqual(check(p, size, s), [], `${a} × ${b}, kerf ${s.kerf}, margin ${s.margin}`);
        if (!s.rotate) assert.ok(p.parts.every((q) => !q.rotated));
      }
      if (r.full_sheet) assert.equal(r.full_sheet.count, r.per_sheet);
    }
    assert.ok(checked > 600);
  });

  it('stays quick for tiny parts by falling back to two blocks', () => {
    const t = Date.now();
    const p = new IdenticalPacker(2490, 1240, 7, 3, 3, true);
    assert.ok(p.perSheet() >= 249 * 206); // at least the better grid
    assert.ok(Date.now() - t < 2000);
  });

  it('reports no offcut when the strip left is too narrow to use', () => {
    assert.equal(offcutOf({ length: 2500, width: 1250 }, { length: 2495, width: 1240 }, { kerf: 3, margin: 5 }), null);
    assert.deepEqual(offcutOf({ length: 2500, width: 1250 }, { length: 1500, width: 1245 }, { kerf: 3, margin: 5 }), { x: 1503, y: 0, length: 997, width: 1250, side: 'end' });
  });
});
