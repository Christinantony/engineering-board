// Release checklists (decision #38).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makePdf } from '../../e2e/fixtures/pdf.mjs';
import { settleSyncs } from '../src/domain/projectFolder.ts';
import { startHarness, Client, type Harness } from './helpers.ts';

describe('release checklists', () => {
  let h: Harness;
  let admin: Client;
  let paul: Client;
  let allen: Client;
  let drawing: number; // job type
  let fea: number;
  const items: Record<string, number> = {};

  before(async () => {
    h = await startHarness();
    admin = await h.as('Christin');
    await admin.post('/api/admin/unlock', { pin: '1234' });
    paul = await h.as('Paul');
    allen = await h.as('Allen');
    const types = (await paul.get('/api/job-types')).body.job_types;
    drawing = types.find((t: any) => t.name === 'Drawing').id;
    fea = types.find((t: any) => t.name === 'FEA').id;
  });
  after(async () => {
    await new Promise((r) => setImmediate(r));
    await settleSyncs();
    await h.close();
  });

  it('lets the admin keep a checklist per job type; job types start with none and block', async () => {
    const before = (await paul.get('/api/job-types')).body.job_types.find((t: any) => t.id === drawing);
    assert.deepEqual(before.checklist, []);
    assert.equal(before.checklist_mode, 'block');
    for (const text of ['Title block filled in', 'BOM checked against the model', 'Tolerances and finish specified']) {
      const r = await admin.post(`/api/admin/job-types/${drawing}/checklist`, { text });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      items[text.split(' ')[0]] = r.body.item.id;
    }
    assert.equal((await paul.post(`/api/admin/job-types/${drawing}/checklist`, { text: 'x' })).status, 403, 'admin only');
    assert.equal((await admin.post(`/api/admin/job-types/999/checklist`, { text: 'x' })).status, 404);
    assert.equal((await admin.post(`/api/admin/job-types/${drawing}/checklist`, { text: '' })).status, 400);
    const after = (await paul.get('/api/job-types')).body.job_types.find((t: any) => t.id === drawing);
    assert.deepEqual(after.checklist.map((i: any) => i.text), ['Title block filled in', 'BOM checked against the model', 'Tolerances and finish specified']);
  });

  it('shows progress on the job and refuses Review and Done until every item is ticked', async () => {
    const t = await paul.create({ title: 'Housing drawing Rev D', claim: true, job_type_id: drawing });
    assert.deepEqual(t.checklist, { done: 0, total: 3, mode: 'block' });
    let r = await paul.post(`/api/tickets/${t.id}/move`, { status: 'review' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'checklist_incomplete');
    assert.match(r.body.message, /3 of 3 left: Title block filled in; BOM checked/);
    assert.equal(r.body.missing.length, 3);
    assert.equal((await paul.post(`/api/tickets/${t.id}/move`, { status: 'done' })).status, 409, 'Done is guarded too');
    // tick two; the third still blocks
    for (const k of ['Title', 'BOM']) {
      r = await paul.put(`/api/tickets/${t.id}/checklist`, { item_id: items[k], checked: true });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    assert.equal(r.body.checklist.items.filter((i: any) => i.checked_at).length, 2);
    assert.equal(r.body.checklist.items[0].checked_by, (await paul.get('/api/session')).body.user.id);
    r = await paul.post(`/api/tickets/${t.id}/move`, { status: 'review' });
    assert.equal(r.status, 409);
    assert.match(r.body.message, /1 of 3 left: Tolerances and finish specified/);
    r = await paul.put(`/api/tickets/${t.id}/checklist`, { item_id: items['Tolerances'], checked: true });
    assert.equal(r.status, 200);
    assert.deepEqual((await paul.get(`/api/tickets/${t.id}`)).body.ticket.checklist, { done: 3, total: 3, mode: 'block' });
    r = await paul.post(`/api/tickets/${t.id}/move`, { status: 'review' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // from Review on to Done needs nothing more
    r = await paul.post(`/api/tickets/${t.id}/move`, { status: 'done' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // the history keeps every tick
    const activity = (await paul.get(`/api/tickets/${t.id}`)).body.activity;
    assert.equal(activity.filter((a: any) => a.kind === 'checklist' && a.to_value === 'ticked').length, 3);
  });

  it('records unticking, refuses items from another list, and follows the job type', async () => {
    const t = await allen.create({ title: 'Bracket drawing', claim: true, job_type_id: drawing });
    let r = await allen.put(`/api/tickets/${t.id}/checklist`, { item_id: items['Title'], checked: true });
    assert.equal(r.status, 200);
    r = await allen.put(`/api/tickets/${t.id}/checklist`, { item_id: items['Title'], checked: false });
    assert.equal(r.status, 200);
    assert.equal(r.body.checklist.items[0].checked_at, null);
    const activity = (await allen.get(`/api/tickets/${t.id}`)).body.activity;
    assert.ok(activity.some((a: any) => a.kind === 'checklist' && a.to_value === 'unticked' && a.body === 'Title block filled in'));
    // an FEA job has no list: nothing to tick, nothing guarded
    const f = await allen.create({ title: 'Plate FEA', claim: true, job_type_id: fea });
    assert.equal(f.checklist, null);
    assert.equal((await allen.get(`/api/tickets/${f.id}/checklist`)).body.checklist, null);
    assert.equal((await allen.put(`/api/tickets/${f.id}/checklist`, { item_id: items['Title'], checked: true })).status, 400);
    assert.equal((await allen.post(`/api/tickets/${f.id}/move`, { status: 'done' })).status, 200);
    // changing a job's type changes its list
    const now = (await allen.get(`/api/tickets/${t.id}`)).body.ticket;
    r = await allen.patch(`/api/tickets/${t.id}`, { version: now.version, job_type_id: fea });
    assert.equal(r.status, 200);
    assert.equal(r.body.ticket.checklist, null);
  });

  it('only asks, never blocks, once the admin sets the type to warn; retired items drop out', async () => {
    let r = await admin.patch(`/api/admin/job-types/${drawing}`, { checklist_mode: 'warn' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.job_type.checklist_mode, 'warn');
    const t = await paul.create({ title: 'Quick drawing fix', claim: true, job_type_id: drawing });
    assert.deepEqual(t.checklist, { done: 0, total: 3, mode: 'warn' });
    assert.equal((await paul.post(`/api/tickets/${t.id}/move`, { status: 'review' })).status, 200);
    await admin.patch(`/api/admin/job-types/${drawing}`, { checklist_mode: 'block' });
    r = await admin.patch(`/api/admin/checklist-items/${items['BOM']}`, { active: false });
    assert.equal(r.status, 200);
    const u = await paul.create({ title: 'Another drawing', claim: true, job_type_id: drawing });
    assert.equal(u.checklist.total, 2);
    assert.equal((await paul.put(`/api/tickets/${u.id}/checklist`, { item_id: items['BOM'], checked: true })).status, 400, 'a retired item can\'t be ticked');
    r = await admin.patch(`/api/admin/checklist-items/${items['Title']}`, { text: 'Title block complete' });
    assert.equal(r.body.item.text, 'Title block complete');
    await admin.patch(`/api/admin/checklist-items/${items['BOM']}`, { active: true });
  });

  it('applies when drawings are submitted for board review, and not to the move after the last signature', async () => {
    const r0 = await admin.post('/api/admin/users', { name: 'Ebin', role: 'reviewer' });
    const ebinId = r0.body.user.id;
    const ebin = await h.as('Ebin');
    const t = await paul.create({ title: 'Gusset drawing', claim: true, job_type_id: drawing });
    const res = await fetch(`${paul.base}/api/review/uploads?kind=drawing&name=GUS-009.pdf`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', cookie: [...paul.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: new Uint8Array(makePdf(1, { labels: ['GUS-009'] })),
    });
    const f = ((await res.json()) as any).file;
    const submission = { drawings: [{ sha256: f.sha256, filename: 'GUS-009.pdf', kind: 'new', notes: 'New gusset', reviewer_ids: [ebinId] }] };
    let r = await paul.post(`/api/tickets/${t.id}/review/submissions`, submission);
    assert.equal(r.status, 409, 'submitting moves the job to Review, which the checklist guards');
    assert.equal(r.body.error, 'checklist_incomplete');
    for (const i of (await paul.get(`/api/tickets/${t.id}/checklist`)).body.checklist.items) await paul.put(`/api/tickets/${t.id}/checklist`, { item_id: i.id, checked: true });
    r = await paul.post(`/api/tickets/${t.id}/review/submissions`, submission);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const d = r.body.drawings[0];
    // the admin adds an item afterwards: the job is in Review already, and the last signature still closes it
    await admin.post(`/api/admin/job-types/${drawing}/checklist`, { text: 'Weld symbols checked' });
    await ebin.post(`/api/review/drawings/${d.id}/decision`, { attempt_id: d.current_attempt_id, outcome: 'passed' });
    await paul.post(`/api/review/drawings/${d.id}/handover`);
    r = await ebin.post(`/api/review/drawings/${d.id}/signed`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ticket.status, 'done');
  });

  it('is behind the job permissions: reviewers can\'t see or tick', async () => {
    const ebin = await h.as('Ebin');
    const t = await paul.create({ title: 'Private drawing', claim: true, job_type_id: drawing });
    assert.equal((await ebin.get(`/api/tickets/${t.id}/checklist`)).status, 403);
    assert.equal((await ebin.put(`/api/tickets/${t.id}/checklist`, { item_id: items['Title'], checked: true })).status, 403);
  });
});
