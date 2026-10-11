// Projects (decision #30): added by the team when needed, none preset; every
// job created on the board belongs to one; jobs can be found by project and a
// job shows its project.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Client, type Harness } from './helpers.ts';
import { run } from '../src/db/connection.ts';

describe('projects', () => {
  let h: Harness;
  let christin: Client;
  let jeffin: Client;
  let admin: Client;

  const raw = async (c: Client, path: string, body: string) => {
    const res = await fetch(h.base + path, {
      method: 'POST',
      headers: { 'content-type': 'text/csv', cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
      body,
    });
    return { status: res.status, json: JSON.parse(await res.text()) };
  };

  before(async () => {
    h = await startHarness();
    christin = await h.as('Christin');
    jeffin = await h.as('Jeffin');
    admin = await h.as('Christin');
    await admin.post('/api/admin/unlock', { pin: '1234' });
  });
  after(async () => {
    await h.close();
  });

  it('starts with no projects: none are preset', async () => {
    const r = await christin.get('/api/projects');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.projects, []);
  });

  let mount: any;
  let skid: any;
  it('engineers and the manager add projects; names are unique whatever the case or spacing', async () => {
    let r = await christin.post('/api/projects', { name: '  Telescope   mount ' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    mount = r.body.project;
    assert.equal(mount.name, 'Telescope mount');
    assert.equal(mount.open, 0);
    r = await jeffin.post('/api/projects', { name: 'Pump skid' });
    assert.equal(r.status, 201);
    skid = r.body.project;
    r = await jeffin.post('/api/projects', { name: 'telescope MOUNT' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'project_exists');
    assert.equal(r.body.project.id, mount.id, 'the existing project comes back, to choose instead');
    assert.equal((await christin.post('/api/projects', { name: '   ' })).status, 400);
    assert.equal((await christin.post('/api/projects', { name: 'x'.repeat(101) })).status, 400);
    const list = (await christin.get('/api/projects')).body.projects.map((p: any) => p.name);
    assert.deepEqual(list, ['Pump skid', 'Telescope mount'], 'sorted by name');
  });

  it('reviewers can neither see nor add projects', async () => {
    const add = await admin.post('/api/admin/users', { name: 'Ebin', role: 'reviewer' });
    assert.equal(add.status, 201, JSON.stringify(add.body));
    const ebin = await h.as('Ebin');
    assert.equal((await ebin.get('/api/projects')).status, 403);
    assert.equal((await ebin.post('/api/projects', { name: 'Sneaky' })).status, 403);
  });

  it('a new job must name an existing project', async () => {
    let r = await christin.post('/api/tickets', { title: 'No project' });
    assert.equal(r.status, 400);
    assert.deepEqual(r.body.details.map((d: any) => d.path), ['project_id']);
    assert.match(r.body.message, /choose the project this job belongs to/);
    r = await christin.post('/api/tickets', { title: 'Ghost project', project_id: 9999 });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /project does not exist/);
  });

  let bracket: any;
  it('a job carries its project, can move to another one with history, but never back to none', async () => {
    bracket = await christin.create({ title: 'Revise mounting bracket', project_id: mount.id, claim: true });
    assert.equal(bracket.project_id, mount.id);
    let r = await christin.patch(`/api/tickets/${bracket.id}`, { version: bracket.version, project_id: skid.id });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ticket.project_id, skid.id);
    const hist = (await christin.get(`/api/tickets/${bracket.id}`)).body.activity;
    assert.ok(hist.some((a: any) => a.kind === 'field' && a.body === 'project' && a.from_value === 'Telescope mount' && a.to_value === 'Pump skid'));
    r = await christin.patch(`/api/tickets/${bracket.id}`, { version: r.body.ticket.version, project_id: null });
    assert.equal(r.status, 400);
    r = await christin.patch(`/api/tickets/${bracket.id}`, { version: (await christin.get(`/api/tickets/${bracket.id}`)).body.ticket.version, project_id: mount.id });
    assert.equal(r.status, 200);
  });

  it('finds every job of a project, and the project of every job, including jobs from before projects', async () => {
    const cable = await christin.create({ title: 'Cable support', project_id: mount.id });
    const pumpBom = await jeffin.create({ title: 'Pump BOM', project_id: skid.id });
    // a job from before projects existed has no link row
    const old = await christin.create({ title: 'Legacy job' });
    run(h.app.ctx.db, 'DELETE FROM ticket_projects WHERE ticket_id = ?', old.id);
    assert.equal((await christin.get(`/api/tickets/${old.id}`)).body.ticket.project_id, null);

    const inMount = (await christin.get(`/api/tickets?project=${mount.id}`)).body.tickets.map((t: any) => t.title).sort();
    assert.deepEqual(inMount, ['Cable support', 'Revise mounting bracket']);
    const both = (await christin.get(`/api/tickets?project=${mount.id},${skid.id}`)).body.total;
    assert.equal(both, 3);
    const none = (await christin.get('/api/tickets?project=none')).body.tickets.map((t: any) => t.id);
    assert.ok(none.includes(old.id));
    assert.ok(!none.includes(cable.id));
    assert.equal((await christin.get('/api/tickets?project=abc')).status, 400);

    // counts
    await christin.post(`/api/tickets/${cable.id}/claim`);
    const c2 = (await christin.get(`/api/tickets/${cable.id}`)).body.ticket;
    await christin.post(`/api/tickets/${cable.id}/move`, { status: 'done', from_status: c2.status });
    const list = (await christin.get('/api/projects')).body.projects;
    const m = list.find((p: any) => p.id === mount.id);
    assert.equal(m.total, 2);
    assert.equal(m.open, 1, 'the done job no longer counts as open');
    assert.equal(list.find((p: any) => p.id === skid.id).total, 1);
    void pumpBom;

    // search finds jobs by their project's name
    const s = (await christin.get('/api/tickets?q=telescope')).body.tickets.map((t: any) => t.title).sort();
    assert.deepEqual(s, ['Cable support', 'Revise mounting bracket']);
  });

  it('exports the project of each job, and imports projects by name', async () => {
    const csv = await fetch(`${h.base}/api/export/tickets.csv`, { headers: { cookie: [...christin.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
    const text = await csv.text();
    const header = text.replace(/^﻿/, '').split(/\r?\n/)[0].split(',');
    assert.ok(header.includes('project'));
    const json = (await christin.get('/api/export/tickets.json')).body;
    assert.ok(json.projects.some((p: any) => p.name === 'Pump skid'));
    assert.ok(json.tickets.some((t: any) => t.title === 'Pump BOM' && t.project === 'Pump skid'));

    const sheet = ['Title,Project,Priority', 'Gearbox cover,pump SKID,High', 'Antenna bracket,Spiral array,', 'No project row,,'].join('\r\n');
    const p = await raw(admin, '/api/admin/import/preview', sheet);
    assert.equal(p.status, 200, JSON.stringify(p.json));
    assert.equal(p.json.rows[0].project, 'Pump skid', 'matched whatever the case');
    assert.equal(p.json.rows[1].project_is_new, true);
    assert.deepEqual(p.json.new_projects, ['Spiral array']);
    assert.match(p.json.rows[2].warnings.join(' '), /No project/);
    assert.equal(p.json.no_project_column, false);
    const kept = await raw(admin, '/api/admin/import/preview?create_projects=0', sheet);
    assert.equal(kept.json.rows[1].project, null);
    assert.match(kept.json.rows[1].warnings.join(' '), /Project "Spiral array" doesn't exist/);
    const c = await raw(admin, '/api/admin/import/commit?filename=projects.csv', sheet);
    assert.equal(c.status, 200, JSON.stringify(c.json));
    const projects = (await christin.get('/api/projects')).body.projects;
    const spiral = projects.find((x: any) => x.name === 'Spiral array');
    assert.ok(spiral);
    const gear = (await christin.get('/api/tickets?q=Gearbox')).body.tickets[0];
    assert.equal(gear.project_id, skid.id);
    const noPr = (await christin.get('/api/tickets?q=No%20project%20row')).body.tickets[0];
    assert.equal(noPr.project_id, null);
    const noCol = await raw(admin, '/api/admin/import/preview', 'Title\r\nSomething');
    assert.equal(noCol.json.no_project_column, true);
    assert.deepEqual(noCol.json.rows[0].warnings, [], 'no warning per row when the sheet has no project column');
  });

  it('demo data brings demo projects and takes them away again, keeping any a real job uses', async () => {
    let r = await admin.post('/api/admin/demo');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const names = (await christin.get('/api/projects')).body.projects.map((p: any) => p.name);
    assert.ok(names.includes('ACME housing') && names.includes('Control enclosure'));
    assert.ok(names.filter((n: string) => n === 'Pump skid').length === 1, 'an existing real project is reused');
    const demoJobs = (await christin.get('/api/tickets?view=all&limit=500')).body.tickets.filter((t: any) => t.is_demo);
    assert.ok(demoJobs.length > 5 && demoJobs.every((t: any) => t.project_id != null));
    const acme = (await christin.get('/api/projects')).body.projects.find((p: any) => p.name === 'Control enclosure');
    await christin.create({ title: 'Real job in a demo project', project_id: acme.id });
    r = await admin.del('/api/admin/demo');
    assert.equal(r.status, 200);
    const after = (await christin.get('/api/projects')).body.projects.map((p: any) => p.name);
    assert.ok(!after.includes('ACME housing'), 'unused demo project removed');
    assert.ok(after.includes('Control enclosure'), 'a demo project a real job uses is kept');
    assert.ok(after.includes('Pump skid') && after.includes('Telescope mount'), 'real projects are untouched');
  });

  it('projects are never deleted', () => {
    assert.throws(() => run(h.app.ctx.db, 'DELETE FROM projects WHERE id = ?', mount.id), /projects cannot be deleted/);
  });
});
