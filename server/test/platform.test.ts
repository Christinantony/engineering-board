import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, Client, type Harness } from './helpers.ts';
import { dueAtIso, endOfWeek, localDate, localToUtcMs } from '../src/lib/time.ts';
import { v, ValidationError, estimateLabel } from '@board/shared';
import { openDb, migrate } from '../src/db/connection.ts';

describe('unit: time zone helpers', () => {
  it('converts IST wall-clock to UTC and back', () => {
    assert.equal(new Date(localToUtcMs('2026-10-01', '10:00', 'Asia/Kolkata')).toISOString(), '2026-10-01T04:30:00.000Z');
    assert.equal(dueAtIso('2026-10-01', null, 'Asia/Kolkata'), '2026-10-01T18:29:59.999Z');
    assert.equal(localDate(Date.parse('2026-10-01T18:31:00Z'), 'Asia/Kolkata'), '2026-10-02');
    assert.equal(endOfWeek('2026-10-01'), '2026-10-04'); // Thu → Sun
    assert.equal(endOfWeek('2026-10-04'), '2026-10-04');
  });
  it('handles a DST zone too', () => {
    // 2026-03-29 02:30 does not exist in Berlin; 12:00 is CEST (+2)
    assert.equal(new Date(localToUtcMs('2026-03-29', '12:00', 'Europe/Berlin')).toISOString(), '2026-03-29T10:00:00.000Z');
  });
});

describe('unit: validation and estimates', () => {
  it('validates dates strictly and strips control characters', () => {
    assert.throws(() => v.date()('2026-02-29'), ValidationError);
    assert.equal(v.date()('2028-02-29'), '2028-02-29');
    assert.equal(v.string()('  a\u0000b\nc  '), 'ab\nc');
    assert.equal(v.time()('9:05'), '09:05');
    assert.throws(() => v.time()('24:00'), ValidationError);
  });
  it('maps minutes to estimate buckets', () => {
    assert.equal(estimateLabel(10), '< 15 min');
    assert.equal(estimateLabel(45), '30–60 min');
    assert.equal(estimateLabel(180), '2–4 hr');
    assert.equal(estimateLabel(5000), '> 2 days');
    assert.equal(estimateLabel(null), null);
  });
});

describe('platform', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(() => h.close());

  it('migrations are idempotent', () => {
    const db = openDb(':memory:');
    assert.deepEqual(migrate(db).applied, [1, 2]);
    assert.deepEqual(migrate(db).applied, []);
    db.close();
  });

  it('seeds the team on first run', async () => {
    const users = (await new Client(h.base).get('/api/users')).body.users;
    const byName = Object.fromEntries(users.map((u: any) => [u.name, u]));
    assert.deepEqual(Object.keys(byName).sort(), ['Allen', 'Christin', 'Jeffin', 'Paul']);
    assert.equal(byName.Jeffin.role, 'manager');
    assert.equal(byName.Christin.is_admin, true);
    const meta = (await new Client(h.base).get('/api/meta')).body;
    assert.equal(meta.tz, 'Asia/Kolkata');
    assert.equal(meta.pin_is_default, true);
  });

  describe('auth', () => {
    it('requires choosing a user; rejects forged cookies', async () => {
      const anon = new Client(h.base);
      assert.equal((await anon.get('/api/tickets')).status, 401);
      anon.cookies.set('eb_session', 'u1.forged');
      assert.equal((await anon.get('/api/tickets')).status, 401);
    });

    it('locks admin endpoints behind the PIN and lets the PIN be changed', async () => {
      const c = await h.as('Paul');
      assert.equal((await c.post('/api/admin/users', { name: 'Maya' })).status, 403);
      assert.equal((await c.post('/api/admin/unlock', { pin: '0000' })).status, 403);
      assert.equal((await c.post('/api/admin/unlock', { pin: '1234' })).status, 200);
      const created = await c.post('/api/admin/users', { name: 'Maya Joseph' });
      assert.equal(created.status, 201);
      assert.equal(created.body.user.initials, 'MJ');
      assert.equal((await c.post('/api/admin/users', { name: 'maya joseph' })).status, 409);
      assert.equal((await c.post('/api/admin/pin', { new_pin: '4321' })).status, 200);
      assert.equal((await new Client(h.base).get('/api/meta')).body.pin_is_default, false);
      // deactivated users are signed out
      const maya = await h.as('Maya Joseph');
      assert.equal((await maya.get('/api/tickets')).status, 200);
      await c.patch(`/api/admin/users/${created.body.user.id}`, { active: false });
      assert.equal((await maya.get('/api/tickets')).status, 401);
      // admin cookie expires after 12 h
      h.clock.advance(13 * 3600_000);
      assert.equal((await c.get('/api/admin/status')).body.unlocked, false);
    });

    it('refuses to demote an engineer who still holds open work', async () => {
      const allen = await h.as('Allen');
      await allen.create({ title: 'Allen holds this', claim: true });
      await allen.post('/api/admin/unlock', { pin: '4321' });
      const allenId = (await allen.get('/api/session')).body.user.id;
      const r = await allen.patch(`/api/admin/users/${allenId}`, { role: 'manager' });
      assert.equal(r.status, 409);
    });
  });

  describe('concurrent use', () => {
    it('parallel creates get unique numbers; parallel edits on different tickets do not interfere', async () => {
      const users = await Promise.all(['Christin', 'Paul', 'Allen'].map((n) => h.as(n)));
      const created = await Promise.all(
        Array.from({ length: 30 }, (_, i) => users[i % 3].create({ title: `Parallel ${i}`, estimate_minutes: i + 1 })),
      );
      assert.equal(new Set(created.map((t) => t.job_number)).size, 30);
      const edits = await Promise.all(
        created.map((t, i) => users[i % 3].patch(`/api/tickets/${t.id}`, { version: t.version, title: `Edited ${i}`, notes: `by user ${i % 3}` })),
      );
      assert.ok(edits.every((r) => r.status === 200));
      for (const [i, t] of created.entries()) {
        const fresh = (await users[0].get(`/api/tickets/${t.id}`)).body.ticket;
        assert.equal(fresh.title, `Edited ${i}`);
        assert.equal(fresh.estimate_minutes, i + 1);
        assert.equal(fresh.notes, `by user ${i % 3}`);
      }
      const integrity = h.app.ctx.db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
      assert.equal(integrity.integrity_check, 'ok');
    });
  });

  describe('live updates', () => {
    it('pushes changes to other browsers over Server-Sent Events', async () => {
      const watcher = await h.as('Christin');
      const actor = await h.as('Paul');
      const ctrl = new AbortController();
      const res = await fetch(h.base + '/api/events', {
        headers: { cookie: [...watcher.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
        signal: ctrl.signal,
      });
      assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const waitFor = async (pred: (s: string) => boolean) => {
        const deadline = Date.now() + 3000;
        while (!pred(buf)) {
          if (Date.now() > deadline) throw new Error('timeout; got: ' + buf);
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value);
        }
      };
      await waitFor((s) => s.includes('event: hello'));
      const t = await actor.create({ title: 'Live!' });
      await waitFor((s) => s.includes(`"id":${t.id}`));
      assert.match(buf, new RegExp(`"type":"ticket","id":${t.id},"version":1`));
      ctrl.abort();
    });
  });

  describe('demo data', () => {
    it('loads realistic demo jobs and clears them without touching real ones', async () => {
      const c = await h.as('Christin');
      await c.post('/api/admin/unlock', { pin: '4321' });
      const before = (await c.get('/api/tickets?archived=include&limit=2000')).body.total;
      const r = await c.post('/api/admin/demo');
      assert.equal(r.status, 200);
      assert.ok(r.body.created >= 8);
      const board = (await c.get('/api/tickets?view=board')).body.tickets;
      const statuses = new Set(board.filter((t: any) => t.is_demo).map((t: any) => t.status));
      for (const s of ['inbox', 'claimed', 'in_progress', 'waiting', 'blocked', 'review', 'done']) assert.ok(statuses.has(s), s);
      assert.equal((await c.post('/api/admin/demo')).status, 409);
      const cleared = await c.del('/api/admin/demo');
      assert.equal(cleared.body.removed, r.body.created);
      assert.equal((await c.get('/api/tickets?archived=include&limit=2000')).body.total, before);
      assert.equal((await c.get('/api/tickets?q=Bracket%20redesign')).body.total, 0);
    });
  });

  describe('persistence', () => {
    it('keeps everything across a server restart and continues numbering', async () => {
      const c = await h.as('Christin');
      const t = await c.create({ title: 'Survives restart', notes: 'keep me' });
      await c.post(`/api/tickets/${t.id}/comments`, { body: 'still here' });
      await h.restart();
      const c2 = await h.as('Christin');
      const r = await c2.get(`/api/tickets/${t.id}`);
      assert.equal(r.body.ticket.notes, 'keep me');
      assert.ok(r.body.activity.some((a: any) => a.body === 'still here'));
      const next = await c2.create({ title: 'After restart' });
      assert.equal(Number(next.job_number.slice(4)), Number(t.job_number.slice(4)) + 1);
      assert.equal((await c2.get('/api/tickets?q=survives')).body.total, 1);
    });
  });

  it('returns JSON 404/405 for unknown API routes', async () => {
    const c = new Client(h.base);
    assert.equal((await c.get('/api/nope')).status, 404);
    assert.equal((await c.del('/api/health')).status, 405);
  });
});
