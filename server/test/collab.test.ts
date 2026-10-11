import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness, type Client } from './helpers.ts';

describe('collaboration', () => {
  let h: Harness;
  let christin: Client, paul: Client, allen: Client, jeffin: Client;
  let ids: Record<string, number>;
  before(async () => {
    h = await startHarness();
    [christin, paul, allen, jeffin] = await Promise.all(['Christin', 'Paul', 'Allen', 'Jeffin'].map((n) => h.as(n)));
    const users = (await christin.get('/api/users')).body.users;
    ids = Object.fromEntries(users.map((u: any) => [u.name, u.id]));
  });
  after(() => h.close());

  describe('notifications', () => {
    it('tells each person what matters to them, never about their own actions', async () => {
      const urgent = await jeffin.create({ title: 'Line down: fixture broken', priority: 'urgent' });
      const forPaul = await jeffin.create({ title: 'For Paul', assigned_to: ids.Paul });
      await paul.post(`/api/tickets/${forPaul.id}/move`, { status: 'in_progress' });
      await paul.post(`/api/tickets/${forPaul.id}/move`, { status: 'review' });
      await allen.post(`/api/tickets/${forPaul.id}/comments`, { body: 'Looks good, one dimension missing' });

      const kinds = async (c: Client) => (await c.get('/api/notifications')).body.items.map((i: any) => `${i.kind}:${i.job_number}`);
      const pk = await kinds(paul);
      assert.ok(pk.includes(`urgent:${urgent.job_number}`));
      assert.ok(pk.includes(`assigned:${forPaul.job_number}`));
      assert.ok(pk.includes(`comment:${forPaul.job_number}`), 'comment on my job');
      assert.ok(!pk.includes(`review:${forPaul.job_number}`), 'not told about my own move');

      const ck = await kinds(christin);
      assert.ok(ck.includes(`review:${forPaul.job_number}`), 'engineers hear about reviews');
      assert.ok(!ck.includes(`assigned:${forPaul.job_number}`), 'not my assignment');
      assert.ok(!ck.includes(`comment:${forPaul.job_number}`), 'not my job');

      const jk = await kinds(jeffin);
      assert.ok(jk.includes(`comment:${forPaul.job_number}`), 'creator hears about notes');
      assert.ok(!jk.includes(`urgent:${urgent.job_number}`), 'not told about own urgent job');
      assert.ok(!jk.some((k: string) => k.startsWith('review:')), 'manager is not asked to review');
    });

    it('counts unread until marked seen, per person', async () => {
      const before = (await paul.get('/api/notifications')).body;
      assert.ok(before.unread > 0);
      await paul.post('/api/notifications/seen', { up_to: before.latest_activity_id });
      assert.equal((await paul.get('/api/notifications')).body.unread, 0);
      assert.ok((await christin.get('/api/notifications')).body.unread > 0, 'Christin still has hers');
      // seen never moves backwards
      await paul.post('/api/notifications/seen', { up_to: 0 });
      assert.equal((await paul.get('/api/notifications')).body.unread, 0);
      await jeffin.create({ title: 'Another urgent one', priority: 'urgent' });
      assert.equal((await paul.get('/api/notifications')).body.unread, 1);
    });

    it('reminds you of your own overdue and due-today jobs', async () => {
      await allen.create({ title: 'late', claim: true, due_date: '2026-09-28' });
      await allen.create({ title: 'today', claim: true, due_date: '2026-10-01' });
      const n = (await allen.get('/api/notifications')).body;
      assert.equal(n.overdue_mine, 1);
      assert.equal(n.due_today_mine, 1);
    });
  });

  describe('activity feed', () => {
    it('pages backwards and filters by person', async () => {
      const first = (await christin.get('/api/activity?limit=5')).body.activity;
      assert.equal(first.length, 5);
      const next = (await christin.get(`/api/activity?limit=5&before=${first[4].id}`)).body.activity;
      assert.ok(next.every((a: any) => a.id < first[4].id));
      const jeffinOnly = (await christin.get(`/api/activity?limit=50&user=${ids.Jeffin}`)).body.activity;
      assert.ok(jeffinOnly.length > 0 && jeffinOnly.every((a: any) => a.user_name === 'Jeffin'));
    });
  });

  describe('presence', () => {
    it('shows who is online and which job they have open', async () => {
      const ctrl = new AbortController();
      const res = await fetch(h.base + '/api/events', {
        headers: { cookie: [...paul.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
        signal: ctrl.signal,
      });
      const reader = res.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      assert.match(first, /"version":"\d+\.\d+\.\d+"/);
      let online = (await christin.get('/api/presence')).body.online;
      assert.deepEqual(online.map((o: any) => o.user_id), [ids.Paul]);

      const t = await christin.create({ title: 'Viewed' });
      await paul.post('/api/presence', { job_id: t.id, tab: 'tab-1' });
      online = (await christin.get('/api/presence')).body.online;
      assert.deepEqual(online, [{ user_id: ids.Paul, viewing: [t.id] }]);

      // a viewing heartbeat expires after 90 s
      h.clock.advance(91_000);
      online = (await christin.get('/api/presence')).body.online;
      assert.deepEqual(online, [{ user_id: ids.Paul, viewing: [] }]);

      ctrl.abort();
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual((await christin.get('/api/presence')).body.online, []);
    });
  });
});

describe('notifications: urgent at creation vs raised later', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(() => h.close());
  it('a job created normal and later raised to urgent notifies once, as a raise', async () => {
    const [jeffin, paul] = await Promise.all(['Jeffin', 'Paul'].map((n) => h.as(n)));
    const t = await jeffin.create({ title: 'Was normal' });
    await jeffin.patch(`/api/tickets/${t.id}`, { version: t.version, priority: 'urgent' });
    const items = (await paul.get('/api/notifications')).body.items.filter((i: any) => i.ticket_id === t.id);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, 'urgent');
  });
});
