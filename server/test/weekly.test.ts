// The weekly summary (decision #37).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mondayOf } from '../src/domain/weekly.ts';
import { startHarness, Client, type Harness } from './helpers.ts';

describe('weekly summary', () => {
  let h: Harness;
  let paul: Client;
  let allen: Client;
  let christin: Client;
  let skid: number;
  let mount: number;
  const jobs: Record<string, any> = {};

  // the harness clock: Thursday 1 October 2026, 10:00 IST → the week of Monday 28 September
  before(async () => {
    h = await startHarness();
    paul = await h.as('Paul');
    allen = await h.as('Allen');
    christin = await h.as('Christin');
    skid = (await paul.post('/api/projects', { name: 'Pump skid' })).body.project.id;
    mount = (await paul.post('/api/projects', { name: 'Telescope mount' })).body.project.id;
    const done = async (c: Client, title: string, project_id: number) => {
      const t = await c.create({ title, claim: true, project_id });
      assert.equal((await c.post(`/api/tickets/${t.id}/move`, { status: 'done' })).status, 200);
      return t;
    };
    jobs.a = await done(paul, 'Bracket redesign', skid);
    jobs.b = await done(paul, 'Pump BOM update', skid);
    jobs.c = await done(allen, 'Mount support plate', mount);
    jobs.late = await paul.create({ title: 'Late housing drawing', claim: true, project_id: skid, due_date: '2026-09-29' });
    jobs.wait = await allen.create({ title: 'Clean up STEP from supplier', claim: true, project_id: mount });
    assert.equal((await allen.post(`/api/tickets/${jobs.wait.id}/move`, { status: 'waiting', reason: 'Supplier to resend the STEP file' })).status, 200);
    jobs.next = await allen.create({ title: 'Gusset FEA', claim: true, project_id: mount, due_date: '2026-10-07' });
    jobs.urgent = await christin.create({ title: 'Customer interference check', priority: 'urgent', project_id: skid });
    h.clock.advance(2 * 86_400_000); // Saturday 3 October
  });
  after(() => h.close());

  it('finds the Monday of a week', () => {
    assert.equal(mondayOf('2026-10-01'), '2026-09-28');
    assert.equal(mondayOf('2026-09-28'), '2026-09-28');
    assert.equal(mondayOf('2026-10-04'), '2026-09-28', 'Sunday belongs to the week before');
  });

  it('sums up the week: finished by project and person, and what is overdue, waiting and due next week now', async () => {
    const r = await christin.get('/api/reports/weekly');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = r.body;
    assert.deepEqual(s.week, { from: '2026-09-28', to: '2026-10-04', is_current: true });
    assert.equal(s.numbers.finished, 3);
    assert.equal(s.numbers.created, 7);
    assert.equal(s.numbers.overdue_now, 1);
    assert.equal(s.numbers.waiting_now, 1);
    assert.equal(s.numbers.open_now, 4);
    assert.equal(s.numbers.unassigned_now, 1);
    assert.deepEqual(
      s.finished_by_project.map((p: any) => [p.project, p.jobs.map((j: any) => j.title)]),
      [
        ['Pump skid', ['Bracket redesign', 'Pump BOM update']],
        ['Telescope mount', ['Mount support plate']],
      ],
    );
    assert.equal(s.finished_by_project[0].jobs[0].owner, 'Paul');
    const paulRow = s.people.find((p: any) => p.name === 'Paul');
    assert.deepEqual([paulRow.finished, paulRow.open, paulRow.overdue], [2, 1, 1]);
    const allenRow = s.people.find((p: any) => p.name === 'Allen');
    assert.deepEqual([allenRow.finished, allenRow.open, allenRow.waiting, allenRow.due_next_week], [1, 2, 1, 1]);
    assert.equal(s.overdue[0].job_number, jobs.late.job_number);
    assert.equal(s.overdue[0].days_overdue, 4, 'due 29 September, today is 3 October');
    assert.equal(s.waiting[0].waiting_for, 'Supplier to resend the STEP file');
    assert.equal(s.waiting[0].days, 2, 'waiting since Thursday, today is Saturday');
    assert.deepEqual(s.due_next_week.from, '2026-10-05');
    assert.deepEqual(s.due_next_week.jobs.map((j: any) => j.title), ['Gusset FEA']);
    assert.deepEqual(s.unclaimed_urgent.map((j: any) => j.title), ['Customer interference check']);
    assert.deepEqual(s.review, { signed: [], awaiting_now: 0, returned_now: 0, signature_pending_now: 0 });
  });

  it('shows an earlier week by any of its dates, with today\'s overdue and waiting', async () => {
    const s = (await christin.get('/api/reports/weekly?week=2026-09-23')).body;
    assert.deepEqual(s.week, { from: '2026-09-21', to: '2026-09-27', is_current: false });
    assert.equal(s.numbers.finished, 0);
    assert.equal(s.numbers.overdue_now, 1, 'overdue is always as of now');
    assert.equal((await christin.get('/api/reports/weekly?week=last')).status, 400);
  });

  it('is not for reviewers', async () => {
    await christin.post('/api/admin/unlock', { pin: '1234' });
    await christin.post('/api/admin/users', { name: 'Ebin', role: 'reviewer' });
    const ebin = await h.as('Ebin');
    assert.equal((await ebin.get('/api/reports/weekly')).status, 403);
  });
});
