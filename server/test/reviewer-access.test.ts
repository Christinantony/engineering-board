// Reviewer access (decision #29): engineers hand each drawing to one or more
// reviewers; a reviewer sees and decides only the drawings handed to them and
// nothing else on the board. The manager keeps today's access.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makePdf } from '../../e2e/fixtures/pdf.mjs';
import { startHarness, undoMigrationsAfter, Client, type Harness } from './helpers.ts';
import { openDb } from '../src/db/connection.ts';
import { settleSyncs } from '../src/domain/projectFolder.ts';

async function uploaded(c: Client, buf: Buffer, name: string, kind: 'drawing' | 'reference' = 'drawing') {
  const res = await fetch(`${c.base}/api/review/uploads?kind=${kind}&name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    body: new Uint8Array(buf),
  });
  const body = (await res.json()) as any;
  assert.equal(res.status, 201, JSON.stringify(body));
  return body.file as { sha256: string; filename: string; pages: number };
}

async function rawStatus(c: Client, path: string) {
  const res = await fetch(c.base + path, { headers: { cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
  await res.arrayBuffer();
  return res.status;
}

async function settle() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await settleSyncs();
}

/** Routes a reviewer may call. Everything else answers 403 for them. */
const REVIEWER_ROUTES = new Set([
  'GET /api/health',
  'GET /api/meta',
  'GET /api/users',
  'GET /api/session',
  'POST /api/session',
  'POST /api/session/password',
  'DELETE /api/session',
  'POST /api/me/password',
  'GET /api/job-types',
  'GET /api/reviews',
  'GET /api/review-files/:sha',
  'GET /api/tickets/:id/review',
  'POST /api/review/drawings/:id/decision',
  'PUT /api/review/drawings/:id/reference-page',
  'POST /api/review/drawings/:id/signed',
  'POST /api/review/drawings/:id/comments',
  'POST /api/review/comments/:id/resolve',
  'GET /api/notifications',
  'POST /api/notifications/seen',
  'POST /api/presence',
  'POST /api/admin/lock', // only clears the admin cookie
  'GET /api/events',
  // these refuse reviewers inside (engineers only), with their own message
  'POST /api/review/uploads',
  'POST /api/tickets/:id/review/submissions',
  'POST /api/tickets/:id/review/references',
  'POST /api/review/drawings/:id/handover',
  'POST /api/review/drawings/:id/withdraw',
  'PATCH /api/review/drawings/:id',
  'PUT /api/review/drawings/:id/reviewers',
  'POST /api/review/comments/:id/respond',
]);

describe('reviewer access', () => {
  let h: Harness;
  let christin: Client;
  let jeffin: Client;
  let ebin: Client;
  let rohith: Client;
  let jins: Client;
  let hoxen: Client;
  const ids: Record<string, number> = {};
  let job: any;
  let other: any;
  let ws: any;
  const scan = makePdf(2, { labels: ['BRK-023 Rev B signed', 'PLT-004 Rev A signed'] });
  const brk = makePdf(1, { labels: ['BRK-023 Rev C'] });
  const plt = makePdf(1, { labels: ['PLT-004 Rev B'] });
  const drawing = (identifier: string) => ws.drawings.find((d: any) => d.identifier === identifier);

  before(async () => {
    h = await startHarness();
    christin = await h.as('Christin');
    jeffin = await h.as('Jeffin');
    const admin = await h.as('Christin');
    await admin.post('/api/admin/unlock', { pin: '1234' });
    for (const name of ['Ebin', 'Rohith', 'Jins', 'Hoxen']) {
      const r = await admin.post('/api/admin/users', { name, role: 'reviewer' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      ids[name] = r.body.user.id;
    }
    for (const u of (await christin.get('/api/users')).body.users) ids[u.name] = u.id;
    [ebin, rohith, jins, hoxen] = await Promise.all(['Ebin', 'Rohith', 'Jins', 'Hoxen'].map((n) => h.as(n)));
    job = await christin.create({
      title: 'Telescope mount bracket',
      description: 'Customer budget and schedule notes',
      notes: 'Internal: quote 42k',
      file_location: '\\\\SERVER\\Projects\\Telescope',
      claim: true,
    });
    other = await christin.create({ title: 'Unrelated job', claim: true });
  });
  after(async () => {
    await settle();
    await h.close();
  });

  it('needs at least one reviewer, and only active reviewers or the manager', async () => {
    const d = await uploaded(christin, brk, 'BRK-023.pdf');
    let r = await christin.post(`/api/tickets/${job.id}/review/submissions`, { drawings: [{ ...d, kind: 'new', notes: 'n' }] });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /Choose at least one reviewer for BRK-023/);
    r = await christin.post(`/api/tickets/${job.id}/review/submissions`, { drawings: [{ ...d, kind: 'new', notes: 'n', reviewer_ids: [ids.Paul] }] });
    assert.equal(r.status, 400, 'an engineer is not a reviewer');
    assert.match(r.body.message, /Paul is not an active reviewer/);
  });

  it('hands each drawing to the reviewers the engineer picks (several per drawing)', async () => {
    const ref = await uploaded(christin, scan, 'Signed set.pdf', 'reference');
    const a = await uploaded(christin, brk, 'BRK-023.pdf');
    const b = await uploaded(christin, plt, 'PLT-004.pdf');
    const r = await christin.post(`/api/tickets/${job.id}/review/submissions`, {
      references: [ref],
      drawings: [
        { ...a, notes: 'Holes Ø8 → Ø10', reviewer_ids: [ids.Ebin, ids.Rohith] },
        { ...b, notes: 'Thickness 6 → 8', reviewer_ids: [ids.Jins] },
      ],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ws = r.body;
    assert.deepEqual(drawing('BRK-023').reviewers, [ids.Ebin, ids.Rohith]);
    assert.deepEqual(drawing('PLT-004').reviewers, [ids.Jins]);
    assert.ok(ws.events.some((e: any) => e.kind === 'reviewers' && /Ebin, Rohith/.test(e.detail)));
  });

  it('shows a reviewer only the drawings handed to them, and only the job number and title', async () => {
    const mine = (await ebin.get(`/api/tickets/${job.id}/review`)).body;
    assert.deepEqual(mine.drawings.map((d: any) => d.identifier), ['BRK-023']);
    assert.equal(mine.ticket.job_number, job.job_number);
    assert.equal(mine.ticket.title, 'Telescope mount bracket');
    for (const f of ['description', 'notes', 'file_location', 'requester', 'reference', 'waiting_for']) assert.equal(mine.ticket[f], '', f);
    assert.equal(mine.ticket.assigned_to, null);
    assert.equal(mine.ticket.due_date, null);
    assert.equal(mine.sync.folder, '');
    assert.equal(mine.references.length, 1, 'the signed reference to compare against');
    const pltId = ws.drawings.find((d: any) => d.identifier === 'PLT-004').id;
    assert.ok(mine.events.every((e: any) => e.drawing_id !== pltId), 'no history of drawings not handed to them');
    assert.equal(mine.signatures_pending, 1);

    assert.deepEqual((await jins.get(`/api/tickets/${job.id}/review`)).body.drawings.map((d: any) => d.identifier), ['PLT-004']);
    assert.equal((await hoxen.get(`/api/tickets/${job.id}/review`)).status, 404, 'nothing handed to Hoxen');
    assert.equal((await ebin.get(`/api/tickets/${other.id}/review`)).status, 404);
    // the manager and engineers see everything, as before
    assert.equal((await jeffin.get(`/api/tickets/${job.id}/review`)).body.drawings.length, 2);
    assert.equal((await jeffin.get(`/api/tickets/${job.id}/review`)).body.ticket.notes, 'Internal: quote 42k');
  });

  it('lists only their own drawings in the review queue', async () => {
    const q = (await ebin.get('/api/reviews?tab=all')).body;
    const row = q.rows.find((r: any) => r.ticket_id === job.id);
    assert.equal(row.drawings, 1);
    assert.equal(row.folder, '');
    assert.equal(q.counts.awaiting, 1);
    assert.equal((await ebin.get('/api/reviews?tab=all&q=PLT-004')).body.rows.length, 0, 'searching finds only their drawings');
    assert.equal((await hoxen.get('/api/reviews?tab=all')).body.rows.length, 0);
    assert.equal((await jeffin.get('/api/reviews?tab=all')).body.rows.find((r: any) => r.ticket_id === job.id).drawings, 2);
  });

  it('serves a reviewer only the PDFs of their drawings and the job’s signed reference', async () => {
    const a = drawing('BRK-023');
    const b = drawing('PLT-004');
    assert.equal(await rawStatus(ebin, `/api/review-files/${a.attempts[0].sha256}`), 200);
    assert.equal(await rawStatus(ebin, `/api/review-files/${ws.references[0].sha256}`), 200);
    assert.equal(await rawStatus(ebin, `/api/review-files/${b.attempts[0].sha256}`), 404);
    assert.equal(await rawStatus(hoxen, `/api/review-files/${ws.references[0].sha256}`), 404);
  });

  it('refuses a reviewer every other page of the board', async () => {
    const t = String(job.id);
    for (const path of [
      '/api/tickets',
      `/api/tickets/${t}`,
      `/api/tickets/${t}/activity`,
      `/api/tickets/${t}/review/log`,
      '/api/activity',
      '/api/dashboard',
      '/api/today',
      '/api/my-work',
      '/api/reports',
      '/api/workload',
      '/api/presence',
      '/api/tags',
      '/api/export/tickets.csv',
      '/api/export/tickets.json',
      '/api/admin/status',
    ]) {
      const r = await ebin.get(path);
      assert.equal(r.status, 403, path);
    }
    assert.match((await ebin.get('/api/workload')).body.message, /only the drawings handed to them/);
    assert.equal((await ebin.post('/api/admin/unlock', { pin: '1234' })).status, 403);
    assert.equal((await ebin.post(`/api/tickets/${t}/comments`, { body: 'x' })).status, 403);
    // and the manager keeps everything
    assert.equal((await jeffin.get('/api/workload')).status, 200);
    assert.equal((await jeffin.get(`/api/tickets/${t}`)).status, 200);
  });

  it('every route outside the review screens answers 403 to a reviewer', async () => {
    const failures: string[] = [];
    for (const r of h.app.routes as { method: string; path: string }[]) {
      if (REVIEWER_ROUTES.has(`${r.method} ${r.path}`)) continue;
      const path = r.path.replace(/:id\b/g, String(job.id)).replace(/:name\b/g, 'nope.db').replace(/:sha\b/g, 'a'.repeat(64));
      const res = await ebin.req(r.method, path, r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
      if (res.status !== 403) failures.push(`${r.method} ${r.path} → ${res.status}`);
    }
    assert.deepEqual(failures, []);
  });

  it('lets only the reviewers it was handed to (or the manager) decide or comment', async () => {
    const a = drawing('BRK-023');
    const b = drawing('PLT-004');
    let r = await ebin.post(`/api/review/drawings/${b.id}/decision`, { attempt_id: b.current_attempt_id, outcome: 'passed' });
    assert.equal(r.status, 404);
    r = await ebin.post(`/api/review/drawings/${b.id}/comments`, { body: 'not mine' });
    assert.equal(r.status, 404);
    r = await hoxen.put(`/api/review/drawings/${a.id}/reference-page`, { reference_id: ws.references[0].id, page: 1 });
    assert.equal(r.status, 404);
    r = await ebin.post(`/api/review/drawings/${a.id}/comments`, { body: 'Check the hole callout.' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.drawings.length, 1, 'the reply is filtered too');
    const commentId = r.body.drawings[0].comments[0].id;
    r = await rohith.post(`/api/review/comments/${commentId}/resolve`);
    assert.equal(r.status, 200, 'a second reviewer of the same drawing can resolve it');
    r = await rohith.post(`/api/review/drawings/${a.id}/decision`, { attempt_id: a.current_attempt_id, outcome: 'passed' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // the manager can still decide any drawing
    r = await jeffin.post(`/api/review/drawings/${b.id}/decision`, { attempt_id: b.current_attempt_id, outcome: 'returned', note: 'Wrong material' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  it('tells reviewers only about their own drawings', async () => {
    await christin.create({ title: 'Urgent unrelated', priority: 'urgent' });
    const kinds = (c: Client) => c.get('/api/notifications').then((r) => r.body.items as any[]);
    const e = await kinds(ebin);
    assert.ok(e.some((i) => i.kind === 'review_submitted' && i.ticket_id === job.id && i.detail === 'BRK-023'), 'handed BRK-023');
    assert.ok(!e.some((i) => i.kind === 'urgent'), 'no board-wide notices');
    const j = await kinds(jins);
    assert.ok(j.some((i) => i.kind === 'review_submitted' && i.detail === 'PLT-004'));
    assert.ok(!j.some((i) => i.kind === 'review_comment'), 'not the comment on a drawing not handed to Jins');
    assert.equal((await kinds(hoxen)).length, 0);
    // the manager hears about every submission, as before
    assert.ok((await kinds(jeffin)).some((i) => i.kind === 'review_submitted' && i.ticket_id === job.id));
  });

  it('lets engineers change who reviews a drawing; a resubmission keeps its reviewers', async () => {
    const b = drawing('PLT-004');
    assert.equal((await ebin.put(`/api/review/drawings/${b.id}/reviewers`, { reviewer_ids: [ids.Ebin] })).status, 403);
    let r = await christin.put(`/api/review/drawings/${b.id}/reviewers`, { reviewer_ids: [ids.Ebin, ids.Hoxen] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.drawings.find((d: any) => d.id === b.id).reviewers, [ids.Ebin, ids.Hoxen]);
    assert.deepEqual((await ebin.get(`/api/tickets/${job.id}/review`)).body.drawings.map((d: any) => d.identifier), ['BRK-023', 'PLT-004']);
    assert.equal((await jins.get(`/api/tickets/${job.id}/review`)).status, 404, 'taken off Jins');
    assert.ok((await hoxen.get('/api/notifications')).body.items.some((i: any) => i.detail === 'PLT-004'), 'Hoxen is told');

    const v2 = await uploaded(christin, makePdf(1, { labels: ['PLT-004 Rev B corrected'] }), 'PLT-004.pdf');
    r = await christin.post(`/api/tickets/${job.id}/review/submissions`, { drawings: [{ ...v2, notes: 'Material corrected' }] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(r.body.drawings.find((d: any) => d.id === b.id).reviewers, [ids.Ebin, ids.Hoxen]);
  });

  it('keeps a drawing visible to the reviewer who passed it, to sign, even after the reviewers change', async () => {
    const a = drawing('BRK-023');
    const r = await christin.put(`/api/review/drawings/${a.id}/reviewers`, { reviewer_ids: [ids.Ebin] });
    assert.equal(r.status, 200);
    assert.ok((await rohith.get(`/api/tickets/${job.id}/review`)).body.drawings.some((d: any) => d.id === a.id));
    assert.equal((await christin.post(`/api/review/drawings/${a.id}/handover`)).status, 200);
    assert.equal((await rohith.post(`/api/review/drawings/${a.id}/signed`)).status, 200);
  });

  it('sends a reviewer live updates only for jobs with drawings handed to them', async () => {
    const ctrl = new AbortController();
    const res = await fetch(h.base + '/api/events', { headers: { cookie: [...jins.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }, signal: ctrl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    await reader.read(); // hello
    let got = '';
    const pump = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          got += dec.decode(value);
        }
      } catch {
        /* aborted */
      }
    })();
    const o = (await christin.get(`/api/tickets/${other.id}`)).body.ticket;
    await christin.patch(`/api/tickets/${other.id}`, { version: o.version, title: 'Unrelated job (renamed)' });
    // hand Jins a drawing on the main job: that one is heard
    await christin.put(`/api/review/drawings/${drawing('PLT-004').id}/reviewers`, { reviewer_ids: [ids.Jins] });
    await new Promise((r) => setTimeout(r, 150));
    ctrl.abort();
    await pump;
    assert.ok(!got.includes(`"id":${other.id},`), 'nothing about the unrelated job');
    assert.ok(got.includes(`"id":${job.id},`), 'the job handed to Jins');
  });
});

describe('reviewer access: upgrading a board with drawings already in review', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await settle();
    await h.close();
  });

  it('hands drawings to the reviewers who already worked on them; untouched ones wait for an engineer', async () => {
    const christin = await h.as('Christin');
    const admin = await h.as('Christin');
    await admin.post('/api/admin/unlock', { pin: '1234' });
    const ebinId = (await admin.post('/api/admin/users', { name: 'Ebin', role: 'reviewer' })).body.user.id;
    const rohithId = (await admin.post('/api/admin/users', { name: 'Rohith', role: 'reviewer' })).body.user.id;
    const ebin = await h.as('Ebin');
    const t = await christin.create({ title: 'In review before 1.3.0', claim: true });
    const a = await uploaded(christin, makePdf(1, { labels: ['A-1'] }), 'A-1.pdf');
    const b = await uploaded(christin, makePdf(1, { labels: ['B-1'] }), 'B-1.pdf');
    let r = await christin.post(`/api/tickets/${t.id}/review/submissions`, {
      drawings: [
        { ...a, kind: 'new', notes: 'a', reviewer_ids: [ebinId, rohithId] },
        { ...b, kind: 'new', notes: 'b', reviewer_ids: [ebinId] },
      ],
    });
    assert.equal(r.status, 201);
    const [da, db] = r.body.drawings;
    r = await ebin.post(`/api/review/drawings/${da.id}/comments`, { body: 'Ebin worked on A' });
    assert.equal(r.status, 200);

    // take the database back to 1.2.0 (no assignments), then start 1.3.0 on it
    await h.app.close();
    const db0 = openDb(h.dbPath);
    undoMigrationsAfter(db0, 7);
    db0.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db0.close();
    await h.restart(); // closing an already closed app is safe
    const e2 = await h.as('Ebin');
    const w = (await e2.get(`/api/tickets/${t.id}/review`)).body;
    assert.deepEqual(w.drawings.map((d: any) => d.id), [da.id], 'A (which Ebin commented on) only');
    const all = (await (await h.as('Christin')).get(`/api/tickets/${t.id}/review`)).body;
    assert.deepEqual(all.drawings.find((d: any) => d.id === db.id).reviewers, [], 'B waits for an engineer to pick reviewers');
  });
});
