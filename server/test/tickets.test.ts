import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness, type Client } from './helpers.ts';

describe('tickets', () => {
  let h: Harness;
  let christin: Client, paul: Client, allen: Client, jeffin: Client;
  before(async () => {
    h = await startHarness();
    [christin, paul, allen, jeffin] = await Promise.all(['Christin', 'Paul', 'Allen', 'Jeffin'].map((n) => h.as(n)));
  });
  after(() => h.close());

  describe('creation', () => {
    it('assigns sequential unique job numbers with sensible defaults', async () => {
      const a = await christin.create({ title: 'First job' });
      const b = await jeffin.create({ title: 'Second job', description: 'From the manager' });
      assert.match(a.job_number, /^JOB-\d{4}$/);
      assert.equal(Number(b.job_number.slice(4)), Number(a.job_number.slice(4)) + 1);
      assert.equal(a.status, 'inbox');
      assert.equal(a.priority, 'normal');
      assert.equal(a.assigned_to, null);
      assert.equal(b.created_by !== a.created_by, true);
      const { body } = await christin.get(`/api/tickets/${a.id}`);
      assert.deepEqual(body.activity.map((x: any) => x.kind), ['created']);
    });

    it('requires a title and reports every invalid field at once', async () => {
      const r = await christin.post('/api/tickets', { title: '   ', priority: 'whenever', due_date: '2026-02-30' });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'validation');
      const paths = r.body.details.map((d: any) => d.path).sort();
      assert.deepEqual(paths, ['due_date', 'priority', 'title']);
    });

    it('rejects a due time without a date, unknown job types and non-JSON bodies', async () => {
      assert.equal((await christin.post('/api/tickets', { title: 'x', due_time: '10:00' })).status, 400);
      assert.equal((await christin.post('/api/tickets', { title: 'x', job_type_id: 9999 })).status, 400);
      const raw = await fetch(h.base + '/api/tickets', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: [...christin.cookies].map(([k, v]) => `${k}=${v}`).join(';') },
        body: '{not json',
      });
      assert.equal(raw.status, 400);
    });

    it('never creates duplicates when the same request is retried', async () => {
      const key = { 'Idempotency-Key': 'retry-key-123456' };
      const [r1, r2] = await Promise.all([
        christin.post('/api/tickets', { title: 'Double click' }, key),
        christin.post('/api/tickets', { title: 'Double click' }, key),
      ]);
      assert.deepEqual([r1.status, r2.status].sort(), [200, 201]);
      assert.equal(r1.body.ticket.id, r2.body.ticket.id);
      const list = await christin.get('/api/tickets?q=Double%20click');
      assert.equal(list.body.total, 1);
    });

    it('can create-and-claim in one step, but only for engineers', async () => {
      const t = await allen.create({ title: 'Quick fix', claim: true });
      assert.equal(t.status, 'claimed');
      const allenId = (await allen.get('/api/session')).body.user.id;
      assert.equal(t.assigned_to, allenId);
      assert.equal((await jeffin.post('/api/tickets', { title: 'x', claim: true })).status, 403);
    });

    it('lets the manager create and assign directly to an engineer', async () => {
      const paulId = (await paul.get('/api/session')).body.user.id;
      const t = await jeffin.create({ title: 'For Paul', assigned_to: paulId });
      assert.equal(t.status, 'claimed');
      const act = (await jeffin.get(`/api/tickets/${t.id}`)).body.activity;
      assert.equal(act[1].kind, 'assigned');
      assert.equal(act[1].to_value, 'Paul');
    });
  });

  describe('claiming', () => {
    it('assigns, timestamps and logs the claim', async () => {
      const t = await jeffin.create({ title: 'Claim me' });
      const r = await paul.post(`/api/tickets/${t.id}/claim`);
      assert.equal(r.status, 200);
      assert.equal(r.body.ticket.status, 'claimed');
      assert.equal(r.body.ticket.claimed_at, h.clock.now().toISOString());
      const act = (await paul.get(`/api/tickets/${t.id}`)).body.activity;
      const claim = act.find((a: any) => a.kind === 'claimed');
      assert.equal(claim.user_name, 'Paul');
      assert.ok(act.some((a: any) => a.kind === 'status' && a.from_value === 'inbox' && a.to_value === 'claimed'));
    });

    it('lets exactly one engineer win a simultaneous claim', async () => {
      const t = await jeffin.create({ title: 'Race' });
      const results = await Promise.all([christin, paul, allen].map((c) => c.post(`/api/tickets/${t.id}/claim`)));
      const ok = results.filter((r) => r.status === 200);
      const lost = results.filter((r) => r.status === 409);
      assert.equal(ok.length, 1);
      assert.equal(lost.length, 2);
      const winner = ok[0].body.ticket.assigned_to;
      for (const r of lost) assert.match(r.body.message, /already claimed by (Christin|Paul|Allen)/);
      assert.equal(lost[0].body.current.assigned_to, winner);
    });

    it('does not let a manager claim', async () => {
      const t = await jeffin.create({ title: 'Manager claim' });
      assert.equal((await jeffin.post(`/api/tickets/${t.id}/claim`)).status, 403);
    });

    it('releases back to the inbox', async () => {
      const t = await christin.create({ title: 'Release me', claim: true });
      const r = await christin.post(`/api/tickets/${t.id}/release`);
      assert.equal(r.body.ticket.status, 'inbox');
      assert.equal(r.body.ticket.assigned_to, null);
    });

    it('refuses to assign work to a manager', async () => {
      const t = await christin.create({ title: 'Assign test' });
      const jeffinId = (await jeffin.get('/api/session')).body.user.id;
      const r = await christin.patch(`/api/tickets/${t.id}`, { version: t.version, assigned_to: jeffinId });
      assert.equal(r.status, 400);
      assert.match(r.body.message, /manager/);
    });
  });

  describe('status movement', () => {
    it('persists transitions, timestamps and activity', async () => {
      const t = await christin.create({ title: 'Flow', claim: true });
      let r = await christin.post(`/api/tickets/${t.id}/move`, { status: 'in_progress', from_status: 'claimed' });
      assert.equal(r.status, 200);
      assert.ok(r.body.ticket.started_at);
      r = await christin.post(`/api/tickets/${t.id}/move`, { status: 'review' });
      r = await christin.post(`/api/tickets/${t.id}/move`, { status: 'done' });
      assert.equal(r.body.ticket.status, 'done');
      assert.ok(r.body.ticket.completed_at);
      const fresh = (await paul.get(`/api/tickets/${t.id}`)).body;
      assert.equal(fresh.ticket.status, 'done');
      const steps = fresh.activity.filter((a: any) => a.kind === 'status').map((a: any) => `${a.from_value}>${a.to_value}`);
      assert.deepEqual(steps, ['inbox>claimed', 'claimed>in_progress', 'in_progress>review', 'review>done']);
      // reopening clears completed_at
      r = await christin.post(`/api/tickets/${t.id}/move`, { status: 'in_progress' });
      assert.equal(r.body.ticket.completed_at, null);
    });

    it('requires a "waiting for" reason and clears it on leaving', async () => {
      const t = await paul.create({ title: 'Needs dims', claim: true });
      let r = await paul.post(`/api/tickets/${t.id}/move`, { status: 'waiting' });
      assert.equal(r.status, 400);
      assert.equal(r.body.error, 'reason_required');
      r = await paul.post(`/api/tickets/${t.id}/move`, { status: 'blocked', reason: 'Customer to confirm mounting dimensions' });
      assert.equal(r.body.ticket.status, 'blocked');
      assert.equal(r.body.ticket.waiting_for, 'Customer to confirm mounting dimensions');
      // switching waiting<->blocked keeps the reason
      r = await paul.post(`/api/tickets/${t.id}/move`, { status: 'waiting' });
      assert.equal(r.status, 200);
      assert.equal(r.body.ticket.waiting_for, 'Customer to confirm mounting dimensions');
      r = await paul.post(`/api/tickets/${t.id}/move`, { status: 'in_progress' });
      assert.equal(r.body.ticket.waiting_for, '');
    });

    it('detects a stale drag (someone else moved it first)', async () => {
      const t = await paul.create({ title: 'Stale', claim: true });
      await paul.post(`/api/tickets/${t.id}/move`, { status: 'in_progress', from_status: 'claimed' });
      const r = await christin.post(`/api/tickets/${t.id}/move`, { status: 'review', from_status: 'claimed' });
      assert.equal(r.status, 409);
      assert.match(r.body.message, /already moved to In progress by Paul/);
      assert.equal(r.body.current.status, 'in_progress');
    });

    it('auto-claims when an engineer drags an unassigned job forward; asks the manager to assign', async () => {
      const t = await jeffin.create({ title: 'Drag me' });
      const m = await jeffin.post(`/api/tickets/${t.id}/move`, { status: 'in_progress' });
      assert.equal(m.status, 409);
      assert.equal(m.body.error, 'needs_assignee');
      const r = await allen.post(`/api/tickets/${t.id}/move`, { status: 'in_progress' });
      assert.equal(r.status, 200);
      assert.equal(r.body.ticket.assigned_to, (await allen.get('/api/session')).body.user.id);
      // dragging back to the inbox unassigns
      const back = await allen.post(`/api/tickets/${t.id}/move`, { status: 'inbox' });
      assert.equal(back.body.ticket.assigned_to, null);
    });

    it('orders cards within a column using before/after neighbours', async () => {
      const a = await jeffin.create({ title: 'Order A' });
      const b = await jeffin.create({ title: 'Order B' });
      const c = await jeffin.create({ title: 'Order C' }); // newest on top: C, B, A, …
      // move A between C and B
      await jeffin.post(`/api/tickets/${a.id}/move`, { status: 'inbox', before_id: c.id, after_id: b.id });
      const inbox = (await jeffin.get('/api/tickets?view=board&status=inbox')).body.tickets.map((t: any) => t.id);
      const idx = (id: number) => inbox.indexOf(id);
      assert.ok(idx(c.id) < idx(a.id) && idx(a.id) < idx(b.id), `order was ${inbox}`);
    });
  });

  describe('editing', () => {
    it('logs each changed field and rejects stale versions', async () => {
      const t = await christin.create({ title: 'Edit me', notes: 'line 1' });
      const r = await christin.patch(`/api/tickets/${t.id}`, {
        version: t.version,
        priority: 'high',
        estimate_minutes: 90,
        notes: 'line 1\nline 2\n\\\\SERVER\\FEA\\Pump_ABC',
        due_date: '2026-10-05',
        tags: ['ANSYS', 'customer-A'],
      });
      assert.equal(r.status, 200);
      assert.equal(r.body.ticket.notes, 'line 1\nline 2\n\\\\SERVER\\FEA\\Pump_ABC', 'line breaks and backslashes preserved');
      assert.deepEqual(r.body.ticket.tags, ['ANSYS', 'customer-A']);
      const kinds = (await christin.get(`/api/tickets/${t.id}`)).body.activity.map((a: any) => a.kind + ':' + (a.body ?? ''));
      for (const k of ['priority:', 'field:estimate', 'field:notes', 'field:due date', 'field:tags']) assert.ok(kinds.includes(k), k);

      const stale = await paul.patch(`/api/tickets/${t.id}`, { version: t.version, title: 'Overwrite' });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.current.title, 'Edit me');
      assert.equal(stale.body.current.version, r.body.ticket.version);
    });

    it('rejects parent loops', async () => {
      const p = await christin.create({ title: 'Parent' });
      const c = await christin.create({ title: 'Child', parent_job_id: p.id });
      const r = await christin.patch(`/api/tickets/${p.id}`, { version: p.version, parent_job_id: c.id });
      assert.equal(r.status, 400);
    });

    it('stores comments in the timeline', async () => {
      const t = await christin.create({ title: 'Comment' });
      const r = await allen.post(`/api/tickets/${t.id}/comments`, { body: 'Need to repair 3 intersecting faces' });
      assert.equal(r.status, 201);
      assert.equal(r.body.activity.user_name, 'Allen');
    });
  });

  describe('archive', () => {
    it('only archives closed work; archived jobs leave the board but stay searchable', async () => {
      const t = await christin.create({ title: 'Archivable widget', claim: true });
      assert.equal((await christin.post(`/api/tickets/${t.id}/archive`)).status, 409);
      await christin.post(`/api/tickets/${t.id}/move`, { status: 'done' });
      assert.equal((await christin.post(`/api/tickets/${t.id}/archive`)).body.ticket.archived, true);
      const board = (await christin.get('/api/tickets?view=board')).body.tickets.map((x: any) => x.id);
      assert.ok(!board.includes(t.id));
      const found = (await christin.get('/api/tickets?q=archivable')).body.tickets.map((x: any) => x.id);
      assert.ok(found.includes(t.id));
      assert.equal((await christin.post(`/api/tickets/${t.id}/restore`)).body.ticket.archived, false);
    });

    it('cannot delete real tickets or rewrite history, even with direct SQL', () => {
      const db = h.app.ctx.db;
      assert.throws(() => db.exec('UPDATE activity SET body = 1'), /append-only/);
      assert.throws(() => db.exec('DELETE FROM activity'), /append-only/);
      assert.throws(() => db.exec('DELETE FROM tickets'), /cannot be deleted/);
    });
  });
});
