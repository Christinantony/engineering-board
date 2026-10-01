import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness, type Client } from './helpers.ts';

// Clock starts 2026-10-01 10:00 IST (Thursday).
describe('views', () => {
  let h: Harness;
  let christin: Client, paul: Client, jeffin: Client;
  beforeEach(async () => {
    h = await startHarness();
    [christin, paul, jeffin] = await Promise.all(['Christin', 'Paul', 'Jeffin'].map((n) => h.as(n)));
  });
  afterEach(() => h.close());

  describe('overdue', () => {
    it('date-only due dates become overdue after local midnight', async () => {
      const today = await christin.create({ title: 'Due today', due_date: '2026-10-01' });
      const yesterday = await christin.create({ title: 'Due yesterday', due_date: '2026-09-30' });
      let t = (await christin.get(`/api/tickets/${today.id}`)).body.ticket;
      assert.equal(t.overdue, false);
      assert.equal(t.due_today, true);
      assert.equal((await christin.get(`/api/tickets/${yesterday.id}`)).body.ticket.overdue, true);

      h.clock.set('2026-10-01T18:29:00Z'); // 23:59 IST
      assert.equal((await christin.get(`/api/tickets/${today.id}`)).body.ticket.overdue, false);
      h.clock.set('2026-10-01T18:31:00Z'); // 00:01 IST next day
      t = (await christin.get(`/api/tickets/${today.id}`)).body.ticket;
      assert.equal(t.overdue, true);
    });

    it('timed due dates become overdue at that time; closed jobs are never overdue', async () => {
      const timed = await christin.create({ title: 'By 3pm', due_date: '2026-10-01', due_time: '15:00', claim: true });
      h.clock.set('2026-10-01T09:29:00Z'); // 14:59 IST
      assert.equal((await christin.get(`/api/tickets/${timed.id}`)).body.ticket.overdue, false);
      h.clock.set('2026-10-01T09:31:00Z'); // 15:01 IST
      assert.equal((await christin.get(`/api/tickets/${timed.id}`)).body.ticket.overdue, true);
      const overdueList = (await christin.get('/api/tickets?overdue=1')).body.tickets.map((x: any) => x.id);
      assert.deepEqual(overdueList, [timed.id]);
      assert.equal((await christin.get('/api/dashboard')).body.counts.overdue, 1);
      await christin.post(`/api/tickets/${timed.id}/move`, { status: 'done' });
      assert.equal((await christin.get(`/api/tickets/${timed.id}`)).body.ticket.overdue, false);
      assert.equal((await christin.get('/api/dashboard')).body.counts.overdue, 0);
    });
  });

  describe('workload', () => {
    it('aggregates estimates per engineer by horizon, excluding waiting work and counting unestimated', async () => {
      const mk = (c: Client, title: string, extra: object) => c.create({ title, claim: true, ...extra });
      await mk(christin, 'today 2h', { estimate_minutes: 120, due_date: '2026-10-01' });
      await mk(christin, 'overdue 1h', { estimate_minutes: 60, due_date: '2026-09-29' });
      await mk(christin, 'saturday 3h', { estimate_minutes: 180, due_date: '2026-10-03' });
      await mk(christin, 'next week', { estimate_minutes: 600, due_date: '2026-10-08' });
      await mk(christin, 'today no estimate', { due_date: '2026-10-01' });
      const ip = await mk(christin, 'in progress, no due', { estimate_minutes: 30 });
      await christin.post(`/api/tickets/${ip.id}/move`, { status: 'in_progress' });
      const w = await mk(christin, 'waiting today', { estimate_minutes: 240, due_date: '2026-10-01' });
      await christin.post(`/api/tickets/${w.id}/move`, { status: 'waiting', reason: 'supplier' });
      await mk(paul, 'paul today', { estimate_minutes: 45, due_date: '2026-10-01' });
      await jeffin.create({ title: 'unclaimed', estimate_minutes: 90 });

      const row = (body: any, name: string) => body.engineers.find((e: any) => e.name === name);
      const today = (await christin.get('/api/workload?horizon=today')).body;
      assert.equal(row(today, 'Christin').load_minutes, 120 + 60 + 30);
      assert.equal(row(today, 'Christin').unestimated, 1);
      assert.equal(row(today, 'Christin').blocked, 1);
      assert.equal(row(today, 'Christin').overdue, 1);
      assert.equal(row(today, 'Christin').in_progress, 1);
      assert.equal(row(today, 'Paul').load_minutes, 45);
      assert.equal(row(today, 'Allen').load_minutes, 0);
      assert.equal(today.unclaimed.n, 1);
      assert.equal(today.unclaimed.minutes, 90);
      assert.ok(!today.engineers.some((e: any) => e.name === 'Jeffin'), 'managers are not in the workload');

      const three = (await christin.get('/api/workload?horizon=3days')).body;
      assert.equal(three.through, '2026-10-03');
      assert.equal(row(three, 'Christin').load_minutes, 120 + 60 + 30 + 180);
      const week = (await christin.get('/api/workload?horizon=week')).body;
      assert.equal(week.through, '2026-10-04');
      assert.equal(row(week, 'Christin').load_minutes, 120 + 60 + 30 + 180);
      assert.equal(row(week, 'Christin').backlog_minutes, 120 + 60 + 180 + 600 + 30);
      assert.equal((await christin.get('/api/workload?horizon=year')).status, 400);
    });
  });

  describe('search', () => {
    it('finds tickets by any field, substring, job number, path, tag, assignee and job type', async () => {
      const types = (await christin.get('/api/job-types')).body.job_types;
      const fea = types.find((t: any) => t.name === 'FEA').id;
      const t = await christin.create({
        title: 'Bracket redesign',
        description: 'Lighten the motor bracket',
        notes: 'ANSYS model:\n\\\\SERVER\\FEA\\Pump_ABC',
        requester: 'Production',
        reference: 'DWG-4410',
        tags: ['customer-A'],
        job_type_id: fea,
        claim: true,
      });
      await christin.create({ title: 'Unrelated pump drawing' });
      const ids = async (q: string) => (await christin.get(`/api/tickets?q=${encodeURIComponent(q)}`)).body.tickets.map((x: any) => x.id);
      for (const q of ['brack', 'Bracket redesign', t.job_number, t.job_number.slice(4), 'Pump_ABC', '\\\\SERVER\\FEA', 'production', 'DWG-4410', 'customer-a', 'Christin', 'FEA', 'motor lighten'])
        assert.ok((await ids(q)).includes(t.id), `query "${q}" should find the ticket`);
      assert.deepEqual(await ids('bracket nonexistentword'), []);
      assert.ok((await ids('pump')).length === 2);
      // ranking: title match first
      assert.equal((await ids('pump'))[0] !== t.id, true);
      // short term falls back to substring
      assert.ok((await ids('A')).length >= 1);
    });

    it('stays in sync after a user is renamed', async () => {
      const t = await paul.create({ title: 'Rename test', claim: true });
      await christin.post('/api/admin/unlock', { pin: '1234' });
      const paulId = (await paul.get('/api/session')).body.user.id;
      await christin.patch(`/api/admin/users/${paulId}`, { name: 'Paul Mathew' });
      const found = (await christin.get('/api/tickets?q=Mathew')).body.tickets.map((x: any) => x.id);
      assert.deepEqual(found, [t.id]);
    });
  });

  describe('board, dashboard, today, my work', () => {
    it('board shows done work for 7 days only; filters combine', async () => {
      const old = await christin.create({ title: 'Old done', claim: true });
      await christin.post(`/api/tickets/${old.id}/move`, { status: 'done' });
      h.clock.advance(8 * 86_400_000);
      const recent = await christin.create({ title: 'Recent done', claim: true });
      await christin.post(`/api/tickets/${recent.id}/move`, { status: 'done' });
      const board = (await christin.get('/api/tickets?view=board')).body.tickets.map((x: any) => x.id);
      assert.ok(board.includes(recent.id) && !board.includes(old.id));

      const types = (await christin.get('/api/job-types')).body.job_types;
      const cad = types.find((t: any) => t.name === 'CAD Modification').id;
      const match = await jeffin.create({ title: 'match', priority: 'high', job_type_id: cad });
      await jeffin.create({ title: 'wrong prio', priority: 'low', job_type_id: cad });
      await christin.create({ title: 'assigned', priority: 'high', job_type_id: cad, claim: true });
      const r = await christin.get(`/api/tickets?unassigned=1&priority=high&job_type=${cad}`);
      assert.deepEqual(r.body.tickets.map((x: any) => x.id), [match.id]);
      assert.equal((await christin.get('/api/tickets?status=bogus')).status, 400);
    });

    it('dashboard, today and my work answer the daily questions', async () => {
      const u = await jeffin.create({ title: 'Urgent unclaimed', priority: 'urgent' });
      const a = await christin.create({ title: 'Active', claim: true, estimate_minutes: 60 });
      await christin.post(`/api/tickets/${a.id}/move`, { status: 'in_progress' });
      const n1 = await christin.create({ title: 'Next 1', claim: true });
      const n2 = await christin.create({ title: 'Next 2', claim: true });
      const b = await christin.create({ title: 'Stuck', claim: true });
      await christin.post(`/api/tickets/${b.id}/move`, { status: 'blocked', reason: 'Manager approval' });
      const d = await paul.create({ title: 'Done', claim: true });
      await paul.post(`/api/tickets/${d.id}/move`, { status: 'done' });

      const dash = (await christin.get('/api/dashboard')).body;
      assert.deepEqual(
        { u: dash.counts.unclaimed, ip: dash.counts.in_progress, b: dash.counts.blocked, done: dash.counts.done_today },
        { u: 1, ip: 1, b: 1, done: 1 },
      );
      assert.equal(dash.attention[0].id, u.id);
      assert.ok(dash.recent_activity.length > 0);

      const today = (await christin.get('/api/today')).body;
      assert.deepEqual(today.urgent.map((x: any) => x.id), [u.id]);
      assert.deepEqual(today.active.map((x: any) => x.id), [a.id]);
      assert.deepEqual(today.blocked.map((x: any) => x.id), [b.id]);
      assert.deepEqual(today.recently_completed.map((x: any) => x.id), [d.id]);

      let mine = (await christin.get('/api/my-work')).body;
      assert.deepEqual(mine.in_progress.map((x: any) => x.id), [a.id]);
      assert.deepEqual(mine.waiting.map((x: any) => x.id), [b.id]);
      assert.deepEqual(mine.up_next.map((x: any) => x.id), [n1.id, n2.id]);
      // reorder: put Next 2 above Next 1
      await christin.post(`/api/tickets/${n2.id}/my-rank`, { after_id: n1.id });
      mine = (await christin.get('/api/my-work')).body;
      assert.deepEqual(mine.up_next.map((x: any) => x.id), [n2.id, n1.id]);
      assert.equal((await paul.post(`/api/tickets/${n1.id}/my-rank`, {})).status, 403);
    });
  });
});
