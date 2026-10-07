// Role capabilities (decision #31): the admin decides what engineers, managers
// and reviewers may do with jobs. The defaults are the rules the board shipped
// with, and board review is never governed by them.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PERMISSIONS, type RolePermissions } from '@board/shared';
import { makePdf } from '../../e2e/fixtures/pdf.mjs';
import { startHarness, Client, type Harness } from './helpers.ts';

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

const set = (p: Partial<Record<keyof RolePermissions, Partial<RolePermissions['engineer']>>>): RolePermissions => ({
  engineer: { ...DEFAULT_PERMISSIONS.engineer, ...p.engineer },
  manager: { ...DEFAULT_PERMISSIONS.manager, ...p.manager },
  reviewer: { ...DEFAULT_PERMISSIONS.reviewer, ...p.reviewer },
});

describe('role capabilities', () => {
  let h: Harness;
  let admin: Client;
  let jeffin: Client; // manager
  let paul: Client; // engineer
  let ebin: Client; // reviewer
  let ebinId: number;
  let jeffinId: number;
  before(async () => {
    h = await startHarness();
    admin = await h.as('Christin');
    await admin.post('/api/admin/unlock', { pin: '1234' });
    const made = await admin.post('/api/admin/users', { name: 'Ebin', role: 'reviewer' });
    ebinId = made.body.user.id;
    jeffin = await h.as('Jeffin');
    paul = await h.as('Paul');
    ebin = await h.as('Ebin');
    jeffinId = (await jeffin.get('/api/session')).body.user.id;
  });
  after(() => h.close());

  const rules = async (p: RolePermissions) => {
    const r = await admin.put('/api/admin/permissions', p);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.permissions as RolePermissions;
  };

  it('starts with the rules the board shipped with, visible to everyone through /api/meta', async () => {
    assert.deepEqual((await admin.get('/api/admin/permissions')).body.permissions, DEFAULT_PERMISSIONS);
    assert.deepEqual((await new Client(h.base).get('/api/meta')).body.permissions, DEFAULT_PERMISSIONS);
    assert.equal((await paul.put('/api/admin/permissions', DEFAULT_PERMISSIONS)).status, 403, 'needs the admin PIN');
  });

  it('by default the manager cannot claim or be assigned, and a reviewer sees no board', async () => {
    const t = await paul.create({ title: 'Default rules' });
    assert.equal((await jeffin.post(`/api/tickets/${t.id}/claim`)).status, 403);
    const r = await paul.patch(`/api/tickets/${t.id}`, { version: t.version, assigned_to: jeffinId });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /managers cannot be assigned/);
    assert.equal((await ebin.get('/api/tickets')).status, 403);
    assert.equal((await ebin.post('/api/tickets', { title: 'x' })).status, 403);
  });

  it('the admin lets managers claim: the manager then claims, is assignable, auto-claims on a drag and shows in workload', async () => {
    await rules(set({ manager: { claim: true } }));
    const t = await paul.create({ title: 'Manager takes this one' });
    let r = await jeffin.post(`/api/tickets/${t.id}/claim`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ticket.assigned_to, jeffinId);
    const t2 = await paul.create({ title: 'Assigned to the manager' });
    r = await paul.patch(`/api/tickets/${t2.id}`, { version: t2.version, assigned_to: jeffinId });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const t3 = await paul.create({ title: 'Manager drags it' });
    r = await jeffin.post(`/api/tickets/${t3.id}/move`, { status: 'in_progress', from_status: 'inbox' });
    assert.equal(r.status, 200, 'a claim-capable manager auto-claims on a drag instead of needs_assignee');
    assert.equal(r.body.ticket.assigned_to, jeffinId);
    const wl = (await paul.get('/api/workload')).body;
    assert.ok(wl.engineers.some((e: any) => e.user_id === jeffinId || e.id === jeffinId || e.name === 'Jeffin'), 'the manager appears in workload');
    const mw = await jeffin.get(`/api/my-work?user=${jeffinId}`);
    assert.equal(mw.status, 200);
    // taking claim away again is refused while the manager holds open jobs
    const refused = await admin.put('/api/admin/permissions', DEFAULT_PERMISSIONS);
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /Managers still hold 3 open job/);
    for (const id of [t.id, t2.id, t3.id]) assert.equal((await paul.post(`/api/tickets/${id}/release`)).status, 200);
    await rules(DEFAULT_PERMISSIONS);
    assert.equal((await jeffin.post(`/api/tickets/${t.id}/claim`)).status, 403, 'back to the shipped rules');
  });

  it('"claim" without "edit" means working on your own jobs only; "edit" covers every job', async () => {
    await rules(set({ manager: { claim: true, edit: false } }));
    const mine = await paul.create({ title: 'Paul owns this', claim: true });
    const other = await paul.create({ title: 'Nobody owns this yet' });
    // the manager can't change Paul's job or an unowned job…
    let r = await jeffin.patch(`/api/tickets/${mine.id}`, { version: mine.version, priority: 'urgent' });
    assert.equal(r.status, 403);
    assert.match(r.body.message, /cannot change this job/);
    assert.equal((await jeffin.post(`/api/tickets/${other.id}/move`, { status: 'waiting', from_status: 'inbox', reason: 'x' })).status, 403);
    assert.equal((await jeffin.post(`/api/tickets/${mine.id}/release`)).status, 403);
    // …but can claim the free one and then work on it, and comment on anything
    r = await jeffin.post(`/api/tickets/${other.id}/claim`);
    assert.equal(r.status, 200);
    r = await jeffin.patch(`/api/tickets/${other.id}`, { version: r.body.ticket.version, priority: 'high' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await jeffin.post(`/api/tickets/${other.id}/move`, { status: 'in_progress', from_status: 'claimed' });
    assert.equal(r.status, 200);
    assert.equal((await jeffin.post(`/api/tickets/${mine.id}/comments`, { body: 'Looks good' })).status, 201);
    // the Assign… path (assigning someone else) is editing another job
    assert.equal((await jeffin.patch(`/api/tickets/${mine.id}`, { version: (await jeffin.get(`/api/tickets/${mine.id}`)).body.ticket.version, assigned_to: jeffinId })).status, 403);
    await paul.post(`/api/tickets/${other.id}/release`);
    await rules(DEFAULT_PERMISSIONS);
  });

  it('"create" is needed to make jobs and projects; without it the role can still comment', async () => {
    await rules(set({ manager: { create: false } }));
    let r = await jeffin.post('/api/tickets', { title: 'Not allowed', project_id: await paul.testProject() });
    assert.equal(r.status, 403);
    assert.match(r.body.message, /cannot create jobs/);
    assert.equal((await jeffin.post('/api/projects', { name: 'Managers project' })).status, 403);
    const t = await paul.create({ title: 'Comment target' });
    assert.equal((await jeffin.post(`/api/tickets/${t.id}/comments`, { body: 'fine' })).status, 201);
    assert.equal((await jeffin.patch(`/api/tickets/${t.id}`, { version: t.version, priority: 'low' })).status, 200, 'edit is still on');
    await rules(DEFAULT_PERMISSIONS);
  });

  it('a reviewer given "claim" sees the board and works on jobs, while review visibility stays as before', async () => {
    // before the change: one drawing handed to Ebin, another handed to the manager only
    const forEbin = await paul.create({ title: 'Drawing for Ebin' });
    const forJeffin = await paul.create({ title: 'Drawing for the manager' });
    const d1 = await uploaded(paul, makePdf(1, { labels: ['BRK-101'] }), 'BRK-101.pdf');
    const d2 = await uploaded(paul, makePdf(1, { labels: ['PLT-202'] }), 'PLT-202.pdf');
    assert.equal((await paul.post(`/api/tickets/${forEbin.id}/review/submissions`, { drawings: [{ reviewer_ids: [ebinId], ...d1, kind: 'new', notes: 'n' }] })).status, 201);
    assert.equal((await paul.post(`/api/tickets/${forJeffin.id}/review/submissions`, { drawings: [{ reviewer_ids: [jeffinId], ...d2, kind: 'new', notes: 'n' }] })).status, 201);
    const r0 = await rules(set({ reviewer: { claim: true } }));
    assert.equal(r0.reviewer.claim, true);
    assert.equal((await ebin.get('/api/tickets')).status, 200, 'board access comes with a job capability');
    assert.equal((await ebin.get('/api/today')).status, 200);
    assert.equal((await ebin.get('/api/projects')).status, 200);
    const t = await paul.create({ title: 'For Ebin' });
    let r = await paul.patch(`/api/tickets/${t.id}`, { version: t.version, assigned_to: ebinId });
    assert.equal(r.status, 200, 'a reviewer can now be assigned a job');
    r = await ebin.post(`/api/tickets/${t.id}/move`, { status: 'in_progress', from_status: 'claimed' });
    assert.equal(r.status, 200, 'and works on it');
    assert.equal((await ebin.post('/api/tickets', { title: 'x', project_id: await paul.testProject() })).status, 403, 'but still cannot create');
    // the review process is untouched: Ebin's queue lists only the drawing handed to them, the other job's review is 404,
    // the "handed to you" notice still arrives, and uploads stay engineers-only
    const queue = await ebin.get('/api/reviews?tab=all');
    assert.equal(queue.status, 200);
    assert.deepEqual(
      queue.body.rows.map((row: any) => row.ticket_id ?? row.id),
      [forEbin.id],
      'only the drawing handed to Ebin',
    );
    assert.equal((await ebin.get(`/api/tickets/${forJeffin.id}/review`)).status, 404);
    assert.equal((await ebin.get(`/api/tickets/${forJeffin.id}`)).status, 200, 'the job itself is on the board Ebin now sees');
    const notes = (await ebin.get('/api/notifications')).body;
    assert.ok((notes.items ?? notes.notices ?? notes).some((n: any) => n.kind === 'review_submitted' && n.ticket_id === forEbin.id), JSON.stringify(notes));
    const up = await fetch(`${h.base}/api/review/uploads?kind=drawing&name=x.pdf`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', cookie: [...ebin.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: new Uint8Array([1, 2, 3]),
    });
    assert.equal(up.status, 403, 'only engineers submit drawings, whatever the job capabilities');
    await paul.post(`/api/tickets/${t.id}/release`);
    await rules(DEFAULT_PERMISSIONS);
    assert.equal((await ebin.get('/api/tickets')).status, 403, 'back to review-only');
  });

  it('changing a person to a role that cannot hold jobs is refused while they hold open jobs', async () => {
    const t = await paul.create({ title: 'Paul is busy', claim: true });
    const paulId = (await paul.get('/api/session')).body.user.id;
    const r = await admin.patch(`/api/admin/users/${paulId}`, { role: 'reviewer' });
    assert.equal(r.status, 409);
    assert.match(r.body.message, /still has \d+ open job/);
    // with managers allowed to claim, becoming a manager is fine
    await rules(set({ manager: { claim: true } }));
    assert.equal((await admin.patch(`/api/admin/users/${paulId}`, { role: 'manager' })).status, 200);
    assert.equal((await admin.patch(`/api/admin/users/${paulId}`, { role: 'engineer' })).status, 200);
    await paul.post(`/api/tickets/${t.id}/release`);
    await rules(DEFAULT_PERMISSIONS);
  });

  it('rejects malformed rules and keeps the saved ones across a restart', async () => {
    assert.equal((await admin.put('/api/admin/permissions', { engineer: { create: 'yes' } })).status, 400);
    await rules(set({ manager: { claim: true } }));
    await h.restart();
    const c = new Client(h.base);
    assert.equal((await c.get('/api/meta')).body.permissions.manager.claim, true);
    const a2 = await h.as('Christin');
    await a2.post('/api/admin/unlock', { pin: '1234' });
    assert.equal((await a2.put('/api/admin/permissions', DEFAULT_PERMISSIONS)).status, 200);
  });
});
