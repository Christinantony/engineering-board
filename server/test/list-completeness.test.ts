import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db/connection.ts';
import { startHarness, type Harness, type Client } from './helpers.ts';
import { getAllTicketPages, type TicketPage } from '../../web/src/lib/ticketPages.ts';

// Exercise the exact browser loader against the API, including page boundaries.
describe('complete job lists', () => {
  let h: Harness;
  let c: Client;
  before(async () => {
    h = await startHarness();
    c = await h.as('Paul');
    const users = (await c.get('/api/users')).body.users;
    const paul = users.find((u: any) => u.name === 'Paul').id;
    const db = openDb(h.dbPath);
    db.exec('BEGIN');
    const insert = db.prepare(`INSERT INTO tickets
      (job_number, title, status, assigned_to, estimate_minutes, board_rank, created_at, updated_at)
      VALUES (?, ?, 'in_progress', ?, 60, ?, ?, ?)`);
    for (let i = 0; i < 2005; i++) insert.run(`PAGE-${i}`, `Pagination job ${i}`, paul, i, h.clock.now().toISOString(), h.clock.now().toISOString());
    db.exec('COMMIT');
    db.close();
  });
  after(async () => { await h.close(); });

  const page = async (url: string): Promise<TicketPage> => {
    const r = await c.get(url);
    assert.equal(r.status, 200);
    return r.body;
  };

  it('loads every board job and every workload drill-down job across page limits', async () => {
    const first = await page('/api/tickets?view=board');
    assert.equal(first.tickets.length, 2000);
    assert.equal(first.total, 2005);
    const board = await getAllTicketPages('/api/tickets?view=board', page);
    assert.equal(board.tickets.length, 2005);
    assert.equal(new Set(board.tickets.map((t) => t.id)).size, board.total);
    const userId = board.tickets[0].assigned_to;
    const path = `/api/tickets?assignee=${userId}&status=claimed,in_progress,waiting,blocked,review`;
    assert.equal((await page(path)).tickets.length, 100, 'default API page remains small');
    const jobs = await getAllTicketPages(path, page);
    assert.equal(jobs.tickets.length, 2005);
    assert.equal(new Set(jobs.tickets.map((t) => t.id)).size, jobs.total);
    assert.deepEqual(jobs.tickets.map((t) => t.id), [...jobs.tickets.map((t) => t.id)].sort((a, b) => a - b), 'equal timestamps have an ID tie-break');
  });

  it('restarts offset paging when a reorder changes page boundaries without changing the total', async () => {
    let calls = 0;
    const result = await getAllTicketPages('/api/tickets?view=board', async (url) => {
      const result = await page(url);
      if (++calls === 1) {
        const t = result.tickets[0];
        assert.equal((await c.post(`/api/tickets/${t.id}/move`, { status: t.status, from_status: t.status, before_id: null, after_id: null })).status, 200);
      }
      return result;
    });
    assert.equal(calls, 4, 'two mismatching pages, then two consistent pages');
    assert.equal(new Set(result.tickets.map((t) => t.id)).size, result.total);
  });

  it('changes the revision after external writes and a reopened database', async () => {
    const before = await page('/api/tickets?view=board');
    const db = openDb(h.dbPath);
    db.exec("UPDATE tickets SET title = 'Externally changed' WHERE job_number = 'PAGE-0'");
    db.close();
    assert.notEqual((await page('/api/tickets?view=board')).revision, before.revision);
    const previous = (await page('/api/tickets?view=board')).revision;
    await h.restart();
    c = await h.as('Paul');
    assert.notEqual((await page('/api/tickets?view=board')).revision, previous);
  });

  it('does not return partial jobs after a later page fails', async () => {
    let calls = 0;
    const error = new Error('second page unavailable');
    await assert.rejects(getAllTicketPages('/api/tickets?view=board', async (url) => {
      if (++calls === 2) throw error;
      return page(url);
    }), error);
    assert.equal(calls, 2);
  });

  it('bounds retries under sustained changes, duplicate rows, or an empty premature page', async () => {
    const first = await page('/api/tickets?view=board');
    for (const failure of ['revision', 'duplicate', 'empty']) {
      let calls = 0;
      await assert.rejects(getAllTicketPages('/api/tickets?view=board', async (url) => {
        calls++;
        if (new URL(url, 'http://board').searchParams.get('offset') === '0') return first;
        const next = await page(url);
        return failure === 'revision' ? { ...next, revision: `changed-${calls}` } :
          failure === 'duplicate' ? { ...next, tickets: [first.tickets[0]] } : { ...next, tickets: [] };
      }), /Jobs changed while the full list was loading/);
      assert.equal(calls, 6, `${failure}: three attempts, no infinite paging`);
    }
  });
});
