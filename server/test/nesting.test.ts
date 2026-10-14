// Mixed nesting (decision #43): different parts on one sheet.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NEST_MAX_PIECES, checkSheet, nestParts, nestingDxf, partLetter, type NestPart, type NestedSheet } from '@board/shared';

const SHEET = { length: 2400, width: 1200 };
// Christin's example of 14 October 2026: from 2400 × 1200, six 550 × 200 and five 850 × 250
const EXAMPLE: NestPart[] = [
  { name: 'Panel 550 x 200', length: 550, width: 200, quantity: 6 },
  { name: 'Panel 850 x 250', length: 850, width: 250, quantity: 5 },
];

/**
 * Whether a set of rectangles can be cut out with guillotine cuts: some
 * straight line across the region separates the parts into two groups, each
 * of which can again be cut the same way.
 */
function guillotineCuttable(rects: { x: number; y: number; l: number; w: number }[]): boolean {
  if (rects.length <= 1) return true;
  for (const axis of ['x', 'y'] as const) {
    const lo = (r: (typeof rects)[number]) => (axis === 'x' ? r.x : r.y);
    const hi = (r: (typeof rects)[number]) => (axis === 'x' ? r.x + r.l : r.y + r.w);
    const cuts = [...new Set(rects.map(hi))].sort((a, b) => a - b);
    for (const c of cuts) {
      const before = rects.filter((r) => hi(r) <= c + 1e-6);
      const after = rects.filter((r) => lo(r) >= c - 1e-6);
      if (before.length && after.length && before.length + after.length === rects.length) return guillotineCuttable(before) && guillotineCuttable(after);
    }
  }
  return false;
}
const asRects = (s: NestedSheet) => s.parts.map((p) => ({ x: p.x, y: p.y, l: p.length, w: p.width }));
const count = (s: NestedSheet[], part: number) => s.reduce((t, x) => t + x.parts.filter((p) => p.part === part).length, 0);

describe('mixed nesting', () => {
  it('fits the example on one sheet in every mode, with every part inside the margin and a kerf apart', () => {
    for (const cut of ['any', 'guillotine'] as const)
      for (const [kerf, margin] of [
        [10, 0],
        [3, 5],
        [10, 10],
      ]) {
        const r = nestParts(EXAMPLE, SHEET, { kerf, margin, rotate: true, cut });
        assert.equal(r.sheets.length, 1, `${cut} kerf ${kerf} margin ${margin}`);
        assert.deepEqual(r.unplaced, []);
        assert.equal(count(r.sheets, 0), 6);
        assert.equal(count(r.sheets, 1), 5);
        assert.deepEqual(checkSheet(r.sheets[0], SHEET, { kerf, margin }), []);
        assert.equal(r.parts_area, 6 * 550 * 200 + 5 * 850 * 250);
        assert.ok(Math.abs(r.utilisation - r.parts_area / (2400 * 1200)) < 1e-9);
      }
  });

  it('tells a straight-cut layout from one that is not (the check the next test relies on)', () => {
    const rows = [{ x: 0, y: 0, l: 2, w: 1 }, { x: 2, y: 0, l: 1, w: 1 }, { x: 0, y: 1, l: 3, w: 1 }];
    assert.equal(guillotineCuttable(rows), true);
    // a pinwheel: no straight line crosses the whole square without cutting a part
    const pinwheel = [{ x: 0, y: 0, l: 2, w: 1 }, { x: 2, y: 0, l: 1, w: 2 }, { x: 1, y: 2, l: 2, w: 1 }, { x: 0, y: 1, l: 1, w: 2 }, { x: 1, y: 1, l: 1, w: 1 }];
    assert.equal(guillotineCuttable(pinwheel), false);
  });

  it('makes straight-cut layouts that really are cut straight across, and labels each piece once', () => {
    const r = nestParts(EXAMPLE, SHEET, { kerf: 10, margin: 0, rotate: true, cut: 'guillotine' });
    assert.ok(guillotineCuttable(asRects(r.sheets[0])));
    const labels = r.sheets[0].parts.map((p) => `${partLetter(p.part)}${p.n}`).sort();
    assert.deepEqual(labels, ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'B1', 'B2', 'B3', 'B4', 'B5']);
    // a busier job, over several sheets
    const many = nestParts(
      [
        { name: 'a', length: 310, width: 180, quantity: 40 },
        { name: 'b', length: 620, width: 95, quantity: 25 },
        { name: 'c', length: 140, width: 140, quantity: 30 },
      ],
      { length: 2500, width: 1250 },
      { kerf: 3, margin: 5, rotate: true, cut: 'guillotine' },
    );
    for (const s of many.sheets) {
      assert.ok(guillotineCuttable(asRects(s)), 'every sheet is guillotine-cuttable');
      assert.deepEqual(checkSheet(s, { length: 2500, width: 1250 }, { kerf: 3, margin: 5 }), []);
    }
    assert.equal(count(many.sheets, 0) + count(many.sheets, 1) + count(many.sheets, 2), 95);
  });

  it('spreads a large job over as few sheets as its area allows', () => {
    const parts = [
      { name: 'x', length: 123, width: 77, quantity: 600 },
      { name: 'y', length: 311, width: 140, quantity: 300 },
    ];
    const r = nestParts(parts, { length: 2500, width: 1250 }, { kerf: 3, margin: 5, rotate: true, cut: 'any' });
    const usable = 2490 * 1240;
    const area = 600 * 123 * 77 + 300 * 311 * 140;
    assert.equal(r.sheets.length, Math.ceil(area / usable), 'no more sheets than the area needs');
    for (const s of r.sheets) assert.deepEqual(checkSheet(s, { length: 2500, width: 1250 }, { kerf: 3, margin: 5 }), []);
    assert.equal(r.sheets.reduce((t, s) => t + s.parts.length, 0), 900);
  });

  it('turns parts only when allowed, and reports parts too big for the sheet', () => {
    // 1100 × 300 only fits a 1000 × 1200 sheet turned
    const tall = [{ name: 'tall', length: 1100, width: 300, quantity: 2 }];
    const turned = nestParts(tall, { length: 1000, width: 1200 }, { kerf: 3, margin: 0, rotate: true, cut: 'any' });
    assert.equal(turned.sheets.length, 1);
    assert.ok(turned.sheets[0].parts.every((p) => p.rotated && p.length === 300 && p.width === 1100));
    const fixed = nestParts(tall, { length: 1000, width: 1200 }, { kerf: 3, margin: 0, rotate: false, cut: 'any' });
    assert.equal(fixed.sheets.length, 0);
    assert.deepEqual(fixed.unplaced, [{ part: 0, count: 2 }]);
    // a margin can make a part that fits the bare sheet too big
    const edge = nestParts([{ name: 'edge', length: 2400, width: 100, quantity: 1 }], SHEET, { kerf: 0, margin: 5, rotate: false, cut: 'any' });
    assert.deepEqual(edge.unplaced, [{ part: 0, count: 1 }]);
  });

  it('gives the same layout for the same input', () => {
    const a = nestParts(EXAMPLE, SHEET, { kerf: 3, margin: 5, rotate: true, cut: 'any' });
    const b = nestParts(EXAMPLE, SHEET, { kerf: 3, margin: 5, rotate: true, cut: 'any' });
    assert.deepEqual(a, b);
  });

  it('writes a DXF in millimetres with each sheet, its margin and every part outline and label', () => {
    const r = nestParts(EXAMPLE, SHEET, { kerf: 3, margin: 5, rotate: true, cut: 'any' });
    const dxf = nestingDxf(r, EXAMPLE, { margin: 5 });
    const lines = dxf.split('\r\n');
    assert.equal(lines[1], 'SECTION');
    assert.ok(dxf.includes('$INSUNITS\r\n70\r\n4'), 'units: millimetres');
    assert.ok(dxf.trimEnd().endsWith('EOF'));
    const entities = (kind: string, layer: string) => lines.filter((l, i) => l === kind && lines[i - 1] === '0' && lines[i + 2] === layer).length;
    assert.equal(entities('LINE', 'SHEET'), 4);
    assert.equal(entities('LINE', 'MARGIN'), 4);
    assert.equal(entities('LINE', 'PARTS'), 11 * 4);
    assert.equal(entities('TEXT', 'LABELS'), 11 + 1);
    assert.ok(dxf.includes('A1 Panel 550 x 200'));
    // custom letters, as the page passes when a row above is left empty
    assert.ok(nestingDxf(r, EXAMPLE, { margin: 5 }, ['C', 'D']).includes('D1 Panel 850 x 250'));
  });

  it('names parts A … Z, then AA, AB …', () => {
    assert.deepEqual([0, 1, 25, 26, 27, 51, 52].map(partLetter), ['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA']);
    assert.ok(NEST_MAX_PIECES >= 1000);
  });
});
