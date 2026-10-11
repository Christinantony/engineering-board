// Card order under heavy use: hundreds of drops, including the worst case of
// always dropping into the same gap, must keep exactly the order people made.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, all } from '../src/db/connection.ts';
import { startHarness, type Harness, type Client } from './helpers.ts';

/** Small seeded PRNG so a failure can be replayed. */
function prng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

describe('card order', () => {
  let h: Harness;
  let c: Client;
  before(async () => {
    h = await startHarness();
    c = await h.as('Christin');
  });
  after(() => h.close());

  const inboxOrder = () => {
    const db = openDb(h.dbPath);
    try {
      return all<{ id: number; r: number }>(db, `SELECT id, board_rank r FROM tickets WHERE status = 'inbox' AND archived = 0 ORDER BY board_rank, id`);
    } finally {
      db.close();
    }
  };

  /** Drop `id` so it sits at `index` in `model` (the expected order), the way the board sends it. */
  async function drop(model: number[], id: number, index: number) {
    const rest = model.filter((x) => x !== id);
    const before_id = rest[index - 1] ?? null; // the card that will be above
    const after_id = rest[index] ?? null; // the card that will be below
    const r = await c.post(`/api/tickets/${id}/move`, { status: 'inbox', before_id, after_id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    rest.splice(index, 0, id);
    return rest;
  }

  it('keeps the order through 200 drops into the same gap (forces renumbering)', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) ids.push((await c.create({ title: `Gap test ${i}` })).id);
    let model = inboxOrder().map((r) => r.id);
    // always drop the bottom card just under the top card: the gap halves every time
    for (let i = 0; i < 200; i++) model = await drop(model, model[model.length - 1], 1);
    const got = inboxOrder();
    assert.deepEqual(got.map((r) => r.id), model);
    for (let i = 1; i < got.length; i++) assert.ok(got[i].r > got[i - 1].r, 'ranks strictly increase (no ties)');
  });

  it('matches a simple model across 300 random drops, new cards and moves out and back', async () => {
    const rand = prng(20261002);
    let model = inboxOrder().map((r) => r.id);
    for (let step = 0; step < 300; step++) {
      const roll = rand();
      if (roll < 0.1) {
        // a new job goes to the top of Inbox
        const t = await c.create({ title: `Random ${step}` });
        model = [t.id, ...model];
      } else if (roll < 0.15 && model.length > 3) {
        // claimed and released again: comes back to the place it is dropped
        const id = model[Math.floor(rand() * model.length)];
        const cl = await c.post(`/api/tickets/${id}/claim`, {});
        assert.equal(cl.status, 200, JSON.stringify(cl.body));
        model = model.filter((x) => x !== id);
        const index = Math.floor(rand() * (model.length + 1));
        const r = await c.post(`/api/tickets/${id}/move`, { status: 'inbox', before_id: model[index - 1] ?? null, after_id: model[index] ?? null });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        model.splice(index, 0, id);
      } else {
        const id = model[Math.floor(rand() * model.length)];
        model = await drop(model, id, Math.floor(rand() * model.length));
      }
      if (step % 50 === 49) assert.deepEqual(inboxOrder().map((r) => r.id), model, `after step ${step}`);
    }
    assert.deepEqual(inboxOrder().map((r) => r.id), model);
    // and the board API returns the same order
    const board = (await c.get('/api/tickets?view=board&status=inbox')).body.tickets.map((t: any) => t.id);
    assert.deepEqual(board, model);
  });
});
