// The whole team acting at the same moment, and a board with a few years of jobs on it.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, get, all } from '../src/db/connection.ts';
import { startHarness, type Harness, type Client } from './helpers.ts';

describe('many people at once', () => {
  let h: Harness;
  let team: Client[];
  let engineers: Client[];
  before(async () => {
    h = await startHarness();
    team = await Promise.all(['Christin', 'Paul', 'Allen', 'Jeffin'].map((n) => h.as(n)));
    engineers = team.slice(0, 3);
  });
  after(() => h.close());

  it('60 jobs created at the same time get 60 different, consecutive job numbers', async () => {
    const made = await Promise.all(Array.from({ length: 60 }, (_, i) => team[i % 4].create({ title: `Parallel ${i}` })));
    const nums = made.map((t: any) => Number(String(t.job_number).replace(/\D/g, ''))).sort((a, b) => a - b);
    assert.equal(new Set(nums).size, 60);
    assert.equal(nums[59] - nums[0], 59, 'no gaps');
  });

  it('three engineers grabbing the same 20 jobs: each job ends up with exactly one of them', async () => {
    const jobs = await Promise.all(Array.from({ length: 20 }, (_, i) => team[3].create({ title: `Grab ${i}` })));
    const tries = jobs.flatMap((t: any) => engineers.map((e) => e.post(`/api/tickets/${t.id}/claim`, {}).then((r) => ({ id: t.id, r }))));
    const results = await Promise.all(tries);
    for (const t of jobs) {
      const mine = results.filter((x) => x.id === t.id);
      assert.equal(mine.filter((x) => x.r.status === 200).length, 1, `${t.job_number}: one winner`);
      assert.equal(mine.filter((x) => x.r.status === 409).length, 2, `${t.job_number}: two told it is taken`);
    }
    const db = openDb(h.dbPath);
    const claims = get<{ n: number }>(db, `SELECT COUNT(*) n FROM activity WHERE kind = 'claimed' AND ticket_id IN (${jobs.map((t: any) => t.id).join(',')})`)!.n;
    db.close();
    assert.equal(claims, 20, 'history shows exactly one claim per job');
  });

  it('everyone saving the same version of a job: one save wins, the rest are told it changed', async () => {
    const t = await team[0].create({ title: 'Edit race' });
    const rs = await Promise.all(team.map((c, i) => c.patch(`/api/tickets/${t.id}`, { version: t.version, notes: `from ${i}` })));
    assert.equal(rs.filter((r) => r.status === 200).length, 1);
    assert.equal(rs.filter((r) => r.status === 409).length, 3);
  });

  it('stays quick with 600 jobs and their history on the board', async () => {
    const c = team[0];
    await Promise.all(
      Array.from({ length: 540 }, (_, i) =>
        c.create({ title: `Bulk job ${i} bracket weldment`, description: 'Lorem ipsum '.repeat(20), tags: [`t${i % 12}`], estimate_minutes: 60 }),
      ),
    );
    const time = async (path: string) => {
      const t0 = performance.now();
      const r = await c.get(path);
      assert.equal(r.status, 200, path);
      return performance.now() - t0;
    };
    // warm up, then take the slowest of three
    const paths = ['/api/tickets?view=board', '/api/tickets?q=weldment', '/api/dashboard', '/api/workload', '/api/reports', '/api/today'];
    for (const p of paths) await time(p);
    for (const p of paths) {
      const worst = Math.max(await time(p), await time(p), await time(p));
      assert.ok(worst < 500, `${p} took ${worst.toFixed(0)} ms`);
    }
    // the database stays consistent
    const db = openDb(h.dbPath);
    assert.equal(get<{ integrity_check: string }>(db, 'PRAGMA integrity_check')!.integrity_check, 'ok');
    const fts = get<{ n: number }>(db, 'SELECT COUNT(*) n FROM tickets_fts')!.n;
    const tickets = get<{ n: number }>(db, 'SELECT COUNT(*) n FROM tickets')!.n;
    assert.equal(fts, tickets, 'every job is in the search index');
    assert.deepEqual(all(db, 'PRAGMA foreign_key_check'), []);
    db.close();
  });
});
