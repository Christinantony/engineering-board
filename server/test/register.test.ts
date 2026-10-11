// The drawing register (decision #35) and drawing revisions.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makePdf } from '../../e2e/fixtures/pdf.mjs';
import { settleSyncs } from '../src/domain/projectFolder.ts';
import { startHarness, Client, type Harness } from './helpers.ts';

async function uploaded(c: Client, buf: Buffer, name: string, kind: 'drawing' | 'reference' = 'drawing') {
  const res = await fetch(`${c.base}/api/review/uploads?kind=${kind}&name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    body: new Uint8Array(buf),
  });
  const body = (await res.json()) as any;
  assert.equal(res.status, 201, JSON.stringify(body));
  return body.file as { sha256: string; filename: string };
}

let n = 0;
const pdf = (label: string) => makePdf(1, { labels: [`${label} #${++n}`] });

describe('drawing register', () => {
  let h: Harness;
  let christin: Client;
  let ebin: Client;
  let REV: number[];
  let pumpSkid: number;
  let telescope: number;

  before(async () => {
    h = await startHarness();
    christin = await h.as('Christin');
    await christin.post('/api/admin/unlock', { pin: '1234' });
    const r = await christin.post('/api/admin/users', { name: 'Ebin', role: 'reviewer' });
    REV = [r.body.user.id];
    ebin = await h.as('Ebin');
    pumpSkid = (await christin.post('/api/projects', { name: 'Pump skid' })).body.project.id;
    telescope = (await christin.post('/api/projects', { name: 'Telescope mount' })).body.project.id;
  });
  after(async () => {
    await new Promise((r) => setImmediate(r));
    await settleSyncs();
    await h.close();
  });

  /** Submit one drawing on a job; returns the drawing as the workspace shows it. */
  async function submit(ticketId: number, filename: string, extra: Record<string, unknown> = {}) {
    const f = await uploaded(christin, pdf(filename), filename);
    const r = await christin.post(`/api/tickets/${ticketId}/review/submissions`, {
      drawings: [{ sha256: f.sha256, filename, kind: 'new', notes: `Notes for ${filename}`, reviewer_ids: REV, ...extra }],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const id = (extra.identifier as string | undefined) ?? filename.replace(/\.pdf$/i, '');
    return r.body.drawings.find((d: any) => d.identifier === id);
  }

  /** Pass, hand over and sign a drawing. */
  async function sign(d: any) {
    let r = await ebin.post(`/api/review/drawings/${d.id}/decision`, { attempt_id: d.current_attempt_id, outcome: 'passed' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await christin.post(`/api/review/drawings/${d.id}/handover`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await ebin.post(`/api/review/drawings/${d.id}/signed`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }

  let jobA: any;
  let jobB: any;
  let jobC: any;

  it('records the revision given at submission, in capitals, and lets an engineer correct it', async () => {
    jobA = await christin.create({ title: 'Motor bracket M10 change', claim: true, project_id: pumpSkid });
    const d = await submit(jobA.id, 'BRK-023.pdf', { revision: 'b' });
    assert.equal(d.revision, 'B');
    let r = await christin.patch(`/api/review/drawings/${d.id}`, { revision: 'C' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const after = r.body.drawings.find((x: any) => x.id === d.id);
    assert.equal(after.revision, 'C');
    assert.equal(after.identifier, 'BRK-023', 'the number is left alone');
    assert.ok(r.body.events.some((e: any) => e.kind === 'revision_set' && /revision C \(was B\)/.test(e.detail)));
    r = await christin.patch(`/api/review/drawings/${d.id}`, { revision: 'B' });
    assert.equal(r.status, 200);
    assert.equal((await christin.patch(`/api/review/drawings/${d.id}`, {})).status, 400, 'something to change');
    assert.equal((await christin.patch(`/api/review/drawings/${d.id}`, { revision: 'Rev B/2' })).status, 400, 'letters, digits, dots, dashes');
    assert.equal((await ebin.patch(`/api/review/drawings/${d.id}`, { revision: 'D' })).status, 403, 'engineers only');
  });

  it('keeps the revision on a resubmission unless a new one is given', async () => {
    const w = (await christin.get(`/api/tickets/${jobA.id}/review`)).body;
    const d = w.drawings[0];
    await ebin.post(`/api/review/drawings/${d.id}/decision`, { attempt_id: d.current_attempt_id, outcome: 'returned', note: 'Fix the title block' });
    let again = await submit(jobA.id, 'BRK-023.pdf');
    assert.equal(again.revision, 'B');
    assert.equal(again.attempts.length, 2);
    await ebin.post(`/api/review/drawings/${d.id}/decision`, { attempt_id: again.current_attempt_id, outcome: 'returned', note: 'Wrong revision letter' });
    again = await submit(jobA.id, 'BRK-023.pdf', { revision: 'C' });
    assert.equal(again.revision, 'C');
    await sign(again);
    const signed = (await christin.get(`/api/tickets/${jobA.id}/review`)).body.drawings[0];
    assert.equal(signed.state, 'signed');
    assert.equal((await christin.patch(`/api/review/drawings/${d.id}`, { revision: 'D' })).status, 409, 'a signed drawing keeps its revision');
  });

  it('lists each drawing number once across jobs, with its latest signed revision and what is in review now', async () => {
    // the next revision of the same drawing, on a later job, typed in lower case
    jobB = await christin.create({ title: 'Bracket slot for cable tie', claim: true, project_id: pumpSkid });
    await submit(jobB.id, 'brk-023.pdf', { revision: 'D' });
    // a different drawing on another project, signed
    jobC = await christin.create({ title: 'Support plate for telescope mount', claim: true, project_id: telescope });
    const sup = await submit(jobC.id, 'SUP-011.pdf', { revision: 'A' });
    // a drawing from before revisions were recorded, still in review on the same job
    await submit(jobC.id, 'PLT-004.pdf');
    await sign(sup);

    const r = await christin.get('/api/drawings');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.drawings.map((d: any) => d.identifier).sort(), ['brk-023', 'PLT-004', 'SUP-011'].sort());
    const brk = r.body.drawings.find((d: any) => d.identifier.toLowerCase() === 'brk-023');
    assert.equal(brk.identifier, 'brk-023', 'the newest spelling is shown');
    assert.equal(brk.records, 2);
    assert.equal(brk.signed_count, 1);
    assert.equal(brk.latest_signed.revision, 'C');
    assert.equal(brk.latest_signed.job_number, jobA.job_number);
    assert.equal(brk.latest_signed.project, 'Pump skid');
    assert.equal(brk.latest_signed.file.available, true);
    assert.match(brk.latest_signed.file.notes, /BRK-023/);
    assert.equal(brk.in_review.revision, 'D');
    assert.equal(brk.in_review.job_number, jobB.job_number);
    assert.equal(brk.in_review.state, 'awaiting');
    assert.deepEqual(brk.projects, ['Pump skid']);
    const plt = r.body.drawings.find((d: any) => d.identifier === 'PLT-004');
    assert.equal(plt.latest_signed, null);
    assert.equal(plt.in_review.revision, null);
  });

  it('narrows by signed, in review, never signed, project and text', async () => {
    const ids = async (qs: string) => (await christin.get(`/api/drawings${qs}`)).body.drawings.map((d: any) => d.identifier.toUpperCase()).sort();
    assert.deepEqual(await ids('?filter=signed'), ['BRK-023', 'SUP-011']);
    assert.deepEqual(await ids('?filter=in_review'), ['BRK-023', 'PLT-004']);
    assert.deepEqual(await ids('?filter=never_signed'), ['PLT-004']);
    assert.deepEqual(await ids(`?project=${telescope}`), ['PLT-004', 'SUP-011']);
    assert.deepEqual(await ids('?q=cable%20tie'), ['BRK-023'], 'job titles are searched');
    assert.deepEqual(await ids(`?q=${jobC.job_number}`), ['PLT-004', 'SUP-011'], 'job numbers are searched');
    assert.equal((await christin.get('/api/drawings?filter=bogus')).status, 400);
  });

  it('gives a drawing number its whole history, and the reviewed PDF opens', async () => {
    const r = await christin.get('/api/drawings/history?identifier=BRK-023');
    assert.equal(r.status, 200);
    assert.equal(r.body.records.length, 2);
    assert.deepEqual(r.body.records.map((x: any) => x.job_number), [jobB.job_number, jobA.job_number], 'newest first');
    const signed = r.body.records[1];
    assert.equal(signed.state, 'signed');
    assert.equal(signed.attempts, 3);
    const pdfRes = await fetch(`${christin.base}/api/review-files/${signed.file.sha256}`, { headers: { cookie: [...christin.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
    assert.equal(pdfRes.status, 200);
    assert.deepEqual((await christin.get('/api/drawings/history?identifier=NOPE-1')).body.records, []);
    assert.equal((await christin.get('/api/drawings/history')).status, 400);
  });

  it('writes the revision into the job\'s revision log', async () => {
    const log = await fetch(`${christin.base}/api/tickets/${jobA.id}/review/log`, { headers: { cookie: [...christin.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
    assert.equal(log.status, 200);
    assert.match(await log.text(), /### BRK-023 Rev C · new drawing · Physically signed/);
  });

  it('is not for reviewers, who see only the drawings handed to them', async () => {
    assert.equal((await ebin.get('/api/drawings')).status, 403);
    assert.equal((await ebin.get('/api/drawings/history?identifier=BRK-023')).status, 403);
  });
});
