// Bad input never breaks the server: every route, given junk, answers with a
// clear 4xx, never a 500, and the board keeps working afterwards.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness, type Client } from './helpers.ts';

const JUNK_BODIES: unknown[] = [
  null,
  [],
  'text',
  42,
  { title: null },
  { title: 'x'.repeat(10_000) },
  { title: ['a'] },
  { title: { $gt: '' } },
  { status: 'nonsense', version: 'one' },
  { version: -1, priority: 'mega', estimate_minutes: -5, due_date: '2026-02-30', due_time: '25:61' },
  { before_id: 'x', after_id: { a: 1 }, status: 'done' },
  { user_id: 'Robert"); DROP TABLE tickets;--' },
  { tags: 'not-a-list' },
  { tags: Array.from({ length: 500 }, (_, i) => `tag${i}`) },
  { body: '' },
  { assigned_to: 99999 },
  { job_type_id: 99999, parent_job_id: -3 },
  { pin: 1234 },
  { days: 'forever' },
  { name: '../../etc/passwd' },
  { color: 'red; background:url(x)' },
  { '__proto__': { admin: true } },
];

describe('bad input', () => {
  let h: Harness;
  let admin: Client;
  let ticketId: number;
  let routes: { method: string; path: string }[];

  before(async () => {
    h = await startHarness();
    admin = await h.as('Christin');
    await admin.post('/api/admin/unlock', { pin: '1234' });
    ticketId = (await admin.create({ title: 'Target' })).id;
    const id = String(ticketId);
    routes = h.app.routes
      .map((r: { method: string; path: string }) => ({ method: r.method, path: r.path.replace(/:id\b/g, id).replace(/:name\b/g, 'nope.db') }))
      .filter((r: { path: string }) => r.path !== '/api/events'); // a stream, tested elsewhere
  });
  after(() => h.close());

  it('every route answers junk with a 4xx and never a 500', async () => {
    assert.ok(routes.length > 40, `found ${routes.length} routes`);
    const failures: string[] = [];
    for (const r of routes) {
      const bodies = r.method === 'GET' || r.method === 'DELETE' ? [undefined] : JUNK_BODIES;
      for (const b of bodies) {
        const res = await admin.req(r.method, r.path, b);
        if (res.status >= 500) failures.push(`${r.method} ${r.path} ${JSON.stringify(b)?.slice(0, 60)} → ${res.status}`);
      }
      // ids that don't exist, and ids that aren't numbers
      for (const bad of ['999999', 'abc', '-1', '1.5', '%00']) {
        if (!/\/\d+(\/|$)/.test(r.path)) continue;
        const path = r.path.replace(String(ticketId), bad);
        const res = await admin.req(r.method, path, r.method === 'GET' ? undefined : {});
        if (res.status >= 500) failures.push(`${r.method} ${path} → ${res.status}`);
        else if (res.status < 400 && bad !== '999999') failures.push(`${r.method} ${path} → ${res.status} (accepted a bad id)`);
      }
    }
    assert.deepEqual(failures, []);
  });

  it('broken JSON, the wrong content type and odd query strings are refused politely', async () => {
    const raw = (init: RequestInit & { path: string }) =>
      fetch(h.base + init.path, { ...init, headers: { cookie: [...admin.cookies].map(([k, v]) => `${k}=${v}`).join('; '), ...(init.headers ?? {}) } });
    let r = await raw({ path: '/api/tickets', method: 'POST', body: '{"title": "x"', headers: { 'content-type': 'application/json' } });
    assert.equal(r.status, 400);
    r = await raw({ path: '/api/tickets', method: 'POST', body: 'x', headers: { 'content-type': 'application/octet-stream' } });
    assert.equal(r.status, 415);
    for (const q of ['q=%', 'q=' + '%E0%A4%A'.repeat(3), 'q=' + 'a'.repeat(5000), 'status=zzz', 'assignee=abc', 'due=yesterday', 'limit=-1', 'offset=abc', 'q="', 'q=*', 'q=AND OR NOT', 'q=((']) {
      const res = await admin.get(`/api/tickets?${q}`);
      assert.ok(res.status < 500, `?${q} → ${res.status}`);
    }
    const big = await raw({ path: '/api/tickets', method: 'POST', body: JSON.stringify({ title: 'x', notes: 'y'.repeat(25 * 1024 * 1024) }), headers: { 'content-type': 'application/json' } });
    assert.equal(big.status, 413, 'oversized bodies are refused');
  });

  it('paths outside the web folder are not served', async () => {
    for (const p of ['/../package.json', '/%2e%2e/%2e%2e/package.json', '/assets/..%2f..%2fserver.mjs', '/..\\..\\data\\board.db', '/data/board.db']) {
      const r = await fetch(h.base + p);
      const text = await r.text();
      assert.ok(!text.includes('"devDependencies"') && !text.startsWith('SQLite format'), `${p} leaked a file`);
      assert.ok(r.status < 500, `${p} → ${r.status}`);
    }
  });

  it('the board still works normally afterwards', async () => {
    admin = await h.as('Christin'); // the sweep signed out (DELETE /api/session) on purpose
    const t = await admin.get(`/api/tickets/${ticketId}`);
    assert.equal(t.status, 200);
    assert.equal(t.body.ticket.title, 'Target');
    assert.equal((await admin.create({ title: 'After the junk' })).title, 'After the junk');
    assert.equal((await admin.get('/api/users')).body.users.length >= 4, true);
  });
});
