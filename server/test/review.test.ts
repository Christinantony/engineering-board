// Drawing review: the acceptance checks in the review plan (§9), end to end
// through the HTTP API, plus the rules that protect signed scans.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makePdf } from '../../e2e/fixtures/pdf.mjs';
import { startHarness, Client, type Harness } from './helpers.ts';
import { inspectPdf } from '../src/domain/pdf.ts';
import { blobPath, removeBlob } from '../src/domain/reviewStore.ts';
import { cleanupDrawing } from '../src/domain/reviews.ts';
import { settleSyncs } from '../src/domain/projectFolder.ts';
import { backupNow, restoreFrom } from '../src/domain/backup.ts';
import { run } from '../src/db/connection.ts';

/** Who each test's drawings are handed to (decision #29). */
let REV: number[] = [];
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function upload(c: Client, buf: Buffer, name: string, kind: 'drawing' | 'reference' = 'drawing') {
  const res = await fetch(`${c.base}/api/review/uploads?kind=${kind}&name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    body: new Uint8Array(buf),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function uploaded(c: Client, buf: Buffer, name: string, kind: 'drawing' | 'reference' = 'drawing') {
  const r = await upload(c, buf, name, kind);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.file as { sha256: string; filename: string; pages: number };
}

/** Let post-commit clean-up and project-folder copies finish. */
async function settle() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await settleSyncs();
}

async function rawGet(c: Client, path: string) {
  const res = await fetch(c.base + path, { headers: { cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
  return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
}

describe('drawing review', () => {
  let h: Harness;
  let christin: Client;
  let paul: Client;
  let jeffin: Client;
  let ebin: Client;
  const scan = makePdf(3, { labels: ['BRK-023 Rev B signed', 'ASM-010 Rev C signed', 'PLT-004 Rev A signed'] });
  const brkC = makePdf(1, { labels: ['BRK-023 Rev C'] });
  const asmD = makePdf(1, { labels: ['ASM-010 Rev D'], compressed: true });
  const sup = makePdf(1, { labels: ['SUP-011 Rev A'] });

  before(async () => {
    h = await startHarness();
    christin = await h.as('Christin');
    paul = await h.as('Paul');
    jeffin = await h.as('Jeffin');
    const admin = await h.as('Christin');
    await admin.post('/api/admin/unlock', { pin: '1234' });
    const r = await admin.post('/api/admin/users', { name: 'Ebin', role: 'reviewer' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ebin = await h.as('Ebin');
    REV = [r.body.user.id];
  });
  after(async () => {
    await settle();
    await h.close();
  });

  async function newJob(title: string, extra: Record<string, unknown> = {}) {
    return christin.create({ title, claim: true, ...extra });
  }

  it('reads page counts of plain and compressed PDFs, and refuses non-PDFs', async () => {
    assert.equal(inspectPdf(makePdf(1)).pages, 1);
    assert.equal(inspectPdf(makePdf(4, { compressed: true })).pages, 4);
    const r = await upload(christin, Buffer.from('not a pdf at all'), 'notes.txt');
    assert.equal(r.status, 400);
    assert.match(r.body.message, /isn't a PDF/);
  });

  it('rejects a multi-page drawing with a clear message, at upload and at submission', async () => {
    const r = await upload(christin, makePdf(2), 'BRK-099.pdf', 'drawing');
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'not_single_page');
    assert.match(r.body.message, /BRK-099\.pdf has 2 pages.*single-page PDF/);
    // uploaded as a reference (allowed), then submitted as a drawing: refused too
    const t = await newJob('Multi-page check');
    const multi = await uploaded(christin, makePdf(2, { labels: ['x', 'y'] }), 'TWO.pdf', 'reference');
    const s = await christin.post(`/api/tickets/${t.id}/review/submissions`, { drawings: [{ reviewer_ids: REV, ...multi, kind: 'new', notes: 'n' }] });
    assert.equal(s.status, 400);
    assert.match(s.body.message, /TWO\.pdf has 2 pages/);
  });

  it('only engineers upload and submit; reviewers cannot change jobs', async () => {
    assert.equal((await upload(jeffin, sup, 'SUP-011.pdf')).status, 403);
    assert.equal((await upload(ebin, sup, 'SUP-011.pdf')).status, 403);
    assert.equal((await ebin.post('/api/tickets', { title: 'Nope' })).status, 403);
    const t = await newJob('Reviewer guard');
    assert.equal((await ebin.patch(`/api/tickets/${t.id}`, { version: t.version, title: 'x' })).status, 403);
    assert.equal((await ebin.post(`/api/tickets/${t.id}/comments`, { body: 'Job notes are for the team.' })).status, 403, 'reviewers comment on drawings, not jobs (decision #29)');
  });

  let job: any;
  let ws: any;
  const byId = (id: string) => ws.drawings.find((d: any) => d.identifier === id);

  it('attaches one signed merged scan and several single-page drawings in one submission', async () => {
    job = await newJob('Revise mounting bracket');
    const ref = await uploaded(christin, scan, 'Telescope mount - signed set.pdf', 'reference');
    assert.equal(ref.pages, 3);
    const a = await uploaded(christin, brkC, 'BRK-023.pdf');
    const b = await uploaded(christin, asmD, 'ASM-010.pdf');
    const c = await uploaded(christin, sup, 'SUP-011.pdf');
    const r = await christin.post(`/api/tickets/${job.id}/review/submissions`, {
      references: [ref],
      drawings: [
        { reviewer_ids: REV, ...a, notes: 'Mounting holes Ø8 → Ø10 for the revised fastener size. Finish changed to black anodise.', ref_sha256: ref.sha256, ref_page: 1 },
        { reviewer_ids: REV, ...b, notes: 'Updated bracket reference.' },
        { reviewer_ids: REV, ...c, kind: 'new', notes: 'New support plate for the cable harness.' },
      ],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ws = r.body;
    assert.equal(ws.references.length, 1);
    assert.equal(ws.drawings.length, 3);
    assert.deepEqual(ws.drawings.map((d: any) => d.identifier), ['BRK-023', 'ASM-010', 'SUP-011']);
    assert.ok(ws.drawings.every((d: any) => d.state === 'awaiting'));
    assert.equal(byId('SUP-011').kind, 'new');
    assert.equal(byId('BRK-023').ref_page, 1);
    assert.equal(ws.ticket.status, 'review', 'submitting puts the job in Review');
    // the reviewers hear about it
    const n = (await ebin.get('/api/notifications')).body.items;
    assert.ok(n.some((i: any) => i.kind === 'review_submitted' && i.ticket_id === job.id));
    // drawing numbers are searchable
    const s = await christin.get('/api/tickets?q=SUP-011');
    assert.ok(s.body.tickets.some((t: any) => t.id === job.id));
  });

  it('serves the exact submitted bytes (rotation and zoom never change them)', async () => {
    const d = byId('BRK-023');
    const got = await rawGet(paul, `/api/review-files/${d.attempts[0].sha256}`);
    assert.equal(got.status, 200);
    assert.equal(sha(got.buf), sha(brkC));
    const refGot = await rawGet(paul, `/api/review-files/${ws.references[0].sha256}`);
    assert.equal(sha(refGot.buf), sha(scan));
  });

  it('remembers a manually chosen reference page per drawing, and lets reviewers change it', async () => {
    const asm = byId('ASM-010');
    const ref = ws.references[0];
    let r = await christin.put(`/api/review/drawings/${asm.id}/reference-page`, { reference_id: ref.id, page: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await ebin.put(`/api/review/drawings/${asm.id}/reference-page`, { reference_id: ref.id, page: 3 });
    assert.equal(r.status, 200);
    ws = r.body;
    assert.equal(byId('ASM-010').ref_page, 3);
    assert.equal(byId('BRK-023').ref_page, 1, 'other drawings keep their own bookmark');
    r = await christin.put(`/api/review/drawings/${asm.id}/reference-page`, { reference_id: ref.id, page: 4 });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /has 3 pages, so page 4 doesn't exist/);
    r = await christin.put(`/api/review/drawings/${asm.id}/reference-page`, { reference_id: ref.id, page: 2 });
    ws = r.body;
    assert.equal(byId('ASM-010').ref_page, 2);
  });

  it('engineers cannot review; reviewers pass or return; open comments block a pass', async () => {
    const brk = byId('BRK-023');
    const att = brk.attempts[0].id;
    let r = await paul.post(`/api/review/drawings/${brk.id}/decision`, { attempt_id: att, outcome: 'passed' });
    assert.equal(r.status, 403);
    assert.match(r.body.message, /Engineers cannot review/);
    r = await ebin.post(`/api/review/drawings/${brk.id}/comments`, { body: 'Please confirm mating fastener clearance.' });
    assert.equal(r.status, 200);
    r = await ebin.post(`/api/review/drawings/${brk.id}/decision`, { attempt_id: att, outcome: 'passed' });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'open_comments');
    // return it for correction (the open comment says why)
    r = await ebin.post(`/api/review/drawings/${brk.id}/decision`, { attempt_id: att, outcome: 'returned' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    ws = r.body;
    assert.equal(byId('BRK-023').state, 'returned');
    const n = (await christin.get('/api/notifications')).body.items;
    assert.ok(n.some((i: any) => i.kind === 'review_returned'));
  });

  it('passes one drawing while others remain under review', async () => {
    const sp = byId('SUP-011');
    const r = await jeffin.post(`/api/review/drawings/${sp.id}/decision`, { attempt_id: sp.attempts[0].id, outcome: 'passed', note: 'OK' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    ws = r.body;
    assert.equal(byId('SUP-011').state, 'passed');
    assert.equal(byId('ASM-010').state, 'awaiting');
    assert.equal(byId('BRK-023').state, 'returned');
    await settle();
  });

  it('resubmits a returned drawing as a new attempt and keeps both for comparison', async () => {
    const brk = byId('BRK-023');
    const same = await uploaded(christin, brkC, 'BRK-023.pdf');
    let r = await christin.post(`/api/tickets/${job.id}/review/submissions`, { drawings: [{ reviewer_ids: REV, ...same, notes: 'again' }] });
    assert.equal(r.status, 409, 'the identical file is refused');
    const fixed = await uploaded(christin, makePdf(1, { labels: ['BRK-023 Rev C (fixed)'] }), 'BRK-023.pdf');
    r = await christin.post(`/api/tickets/${job.id}/review/submissions`, {
      drawings: [{ reviewer_ids: REV, ...fixed, notes: 'Added fastener clearance note; Ø10 holes confirmed against M8 bolts.' }],
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    ws = r.body;
    const d = byId('BRK-023');
    assert.equal(d.id, brk.id, 'same drawing, matched by its file name');
    assert.equal(d.state, 'awaiting');
    assert.equal(d.kind, 'revision', 'the engineering revision is unchanged; only the attempt advances');
    assert.deepEqual(d.attempts.map((a: any) => [a.number, a.outcome, a.available]), [[1, 'returned', true], [2, null, true]]);
    assert.equal(ws.submissions, 2);
    assert.equal(d.ref_page, 1, 'the reference bookmark carries over');
    const prev = await rawGet(ebin, `/api/review-files/${d.attempts[0].sha256}`);
    assert.equal(prev.status, 200, 'the previous attempt can still be compared');
    // respond to and resolve the comment, then pass
    const c = d.comments[0];
    r = await christin.post(`/api/review/comments/${c.id}/respond`, { body: 'Clearance 1.5 mm each side; note added.' });
    assert.equal(r.status, 200);
    r = await christin.post(`/api/review/comments/${c.id}/resolve`);
    assert.equal(r.status, 403, 'an engineer cannot resolve a reviewer\'s comment');
    r = await ebin.post(`/api/review/comments/${c.id}/resolve`);
    assert.equal(r.status, 200);
    r = await ebin.post(`/api/review/drawings/${d.id}/decision`, { attempt_id: d.attempts[0].id, outcome: 'passed' });
    assert.equal(r.status, 409, 'an old attempt cannot be decided');
    r = await ebin.post(`/api/review/drawings/${d.id}/decision`, { attempt_id: d.attempts[1].id, outcome: 'passed' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await settle();
    ws = (await christin.get(`/api/tickets/${job.id}/review`)).body;
  });

  it('removes intermediate PDFs after a pass, keeps the reviewed final, and never touches the signed scan', async () => {
    const d = byId('BRK-023');
    assert.equal(d.state, 'passed');
    assert.equal(d.cleanup, 'done');
    const [a1, a2] = d.attempts;
    assert.equal(a1.available, false);
    assert.ok(a1.file_removed_at);
    assert.equal(a2.available, true);
    assert.equal(existsSync(blobPath(h.app.ctx, a1.sha256)), false, 'the intermediate PDF is deleted');
    assert.equal(existsSync(blobPath(h.app.ctx, a2.sha256)), true, 'the reviewed PDF is kept');
    const gone = await rawGet(ebin, `/api/review-files/${a1.sha256}`);
    assert.equal(gone.status, 410);
    // history survives
    assert.equal(a1.notes, 'Mounting holes Ø8 → Ø10 for the revised fastener size. Finish changed to black anodise.');
    assert.equal(a1.outcome, 'returned');
    assert.ok(ws.events.some((e: any) => e.kind === 'cleanup_done' && /attempt 1/.test(e.detail)));
    // the signed scan: same bytes, still there, protected against every removal path
    const ref = ws.references[0];
    assert.equal(sha(readFileSync(blobPath(h.app.ctx, ref.sha256))), sha(scan));
    assert.throws(() => removeBlob(h.app.ctx, ref.sha256), /protected/);
    assert.throws(() => run(h.app.ctx.db, 'UPDATE review_files SET removed_at = ? WHERE sha256 = ?', 'x', ref.sha256), /never removed/);
    assert.throws(() => run(h.app.ctx.db, 'UPDATE review_references SET sha256 = ? WHERE id = ?', 'y'.repeat(64), ref.id), /never removed or changed/);
    assert.throws(() => run(h.app.ctx.db, 'DELETE FROM review_files WHERE sha256 = ?', ref.sha256), /never removed/);
    // the other drawings' pending attempts are untouched
    assert.equal(byId('ASM-010').attempts[0].available, true);
  });

  it('refuses Done until every required drawing is physically signed', async () => {
    const t = (await christin.get(`/api/tickets/${job.id}`)).body.ticket;
    const r = await christin.post(`/api/tickets/${job.id}/move`, { status: 'done', from_status: t.status });
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'signatures_pending');
    assert.match(r.body.message, /3 drawings still need a physical signature/);
  });

  it('marks handover and reminds the reviewer who passed it, once', async () => {
    const d = byId('BRK-023');
    let r = await christin.post(`/api/review/drawings/${d.id}/signed`);
    assert.equal(r.status, 409, 'handover comes first');
    r = await christin.post(`/api/review/drawings/${d.id}/handover`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await christin.post(`/api/review/drawings/${d.id}/handover`);
    assert.equal(r.status, 409, 'a second click makes no second reminder');
    const n = (await ebin.get('/api/notifications')).body.items.filter((i: any) => i.kind === 'signature');
    assert.equal(n.length, 1);
    assert.equal(n[0].detail, 'BRK-023.pdf was approved by you in the board on 1 Oct 2026. The printed drawing has now been handed over for your signature.');
    assert.equal((await jeffin.get('/api/notifications')).body.items.filter((i: any) => i.kind === 'signature').length, 0, 'only that reviewer');
  });

  it('a changed PDF after passing needs a new decision and does not inherit handover', async () => {
    const sp = byId('SUP-011');
    let r = await christin.post(`/api/review/drawings/${sp.id}/handover`);
    assert.equal(r.status, 200);
    const v2 = await uploaded(christin, makePdf(1, { labels: ['SUP-011 Rev A tweak'] }), 'SUP-011.pdf');
    r = await christin.post(`/api/tickets/${job.id}/review/submissions`, { drawings: [{ reviewer_ids: REV, ...v2, notes: 'Hole moved 2 mm.' }] });
    assert.equal(r.status, 201);
    ws = r.body;
    const d = byId('SUP-011');
    assert.equal(d.state, 'awaiting');
    assert.equal(d.handover_at, null);
    assert.equal(d.passed_attempt_id, null);
    r = await jeffin.post(`/api/review/drawings/${d.id}/decision`, { attempt_id: d.attempts[1].id, outcome: 'passed' });
    assert.equal(r.status, 200);
    await settle();
  });

  it('records signatures without any new upload, and the job becomes Done after the last one', async () => {
    const asm = byId('ASM-010');
    let r = await jeffin.post(`/api/review/drawings/${asm.id}/decision`, { attempt_id: asm.attempts[0].id, outcome: 'passed' });
    assert.equal(r.status, 200);
    for (const id of ['ASM-010', 'SUP-011']) {
      ws = (await christin.get(`/api/tickets/${job.id}/review`)).body;
      r = await christin.post(`/api/review/drawings/${byId(id).id}/handover`);
      assert.equal(r.status, 200, `${id} ${JSON.stringify(r.body)}`);
    }
    ws = r.body;
    const refBefore = ws.references.map((x: any) => x.sha256);
    r = await ebin.post(`/api/review/drawings/${byId('BRK-023').id}/signed`);
    assert.equal(r.status, 200);
    r = await jeffin.post(`/api/review/drawings/${byId('ASM-010').id}/signed`);
    assert.equal(r.status, 200);
    assert.equal(r.body.ticket.status, 'review');
    r = await christin.post(`/api/review/drawings/${byId('SUP-011').id}/signed`);
    assert.equal(r.status, 200);
    ws = r.body;
    assert.equal(ws.signatures_pending, 0);
    assert.equal(ws.ticket.status, 'done');
    assert.deepEqual(ws.references.map((x: any) => x.sha256), refBefore, 'the old scan is neither replaced nor needed');
    r = await christin.post(`/api/review/drawings/${byId('SUP-011').id}/signed`);
    assert.equal(r.status, 409);
    await settle();
  });

  it('reviews a new drawing without any signed reference; a revision needs one', async () => {
    const t = await newJob('Cable support', { file_location: '' });
    const cbl = await uploaded(christin, makePdf(1, { labels: ['CBL-007 Rev A'] }), 'CBL-007.pdf');
    let r = await christin.post(`/api/tickets/${t.id}/review/submissions`, { drawings: [{ reviewer_ids: REV, ...cbl, kind: 'revision', notes: 'x' }] });
    assert.equal(r.status, 400);
    assert.match(r.body.message, /attach the signed scan/);
    r = await christin.post(`/api/tickets/${t.id}/review/submissions`, { drawings: [{ reviewer_ids: REV, ...cbl, kind: 'new', notes: 'New support for routing the telescope cable harness.' }] });
    assert.equal(r.status, 201);
    assert.equal(r.body.references.length, 0);
    assert.equal(r.body.sync.state, 'no_folder');
    const d = r.body.drawings[0];
    r = await ebin.post(`/api/review/drawings/${d.id}/decision`, { attempt_id: d.attempts[0].id, outcome: 'passed' });
    assert.equal(r.status, 200);
  });

  it('lists jobs in the review queue by tab', async () => {
    const q = (await ebin.get('/api/reviews?tab=all')).body;
    const row = q.rows.find((r: any) => r.ticket_id === job.id);
    assert.equal(row.drawings, 3);
    assert.equal(row.revised, 2);
    assert.equal(row.new_count, 1);
    assert.equal(row.signed, 3);
    assert.ok(q.counts.passed_this_month >= 1, 'a reviewer counts their own passes');
    assert.ok((await jeffin.get('/api/reviews?tab=all')).body.counts.passed_this_month >= 4, 'the manager counts everyone\'s');
    const done = (await ebin.get('/api/reviews?tab=done')).body.rows;
    assert.ok(done.some((r: any) => r.ticket_id === job.id));
    const awaiting = (await ebin.get('/api/reviews?tab=awaiting&q=BRK')).body.rows;
    assert.ok(!awaiting.some((r: any) => r.ticket_id === job.id));
  });

  it('keeps records and files through a restart', async () => {
    await h.restart();
    [christin, paul, jeffin, ebin] = await Promise.all(['Christin', 'Paul', 'Jeffin', 'Ebin'].map((n) => h.as(n)));
    const w = (await christin.get(`/api/tickets/${job.id}/review`)).body;
    assert.equal(w.drawings.length, 3);
    assert.ok(w.drawings.every((d: any) => d.state === 'signed'));
    const final = w.drawings[0].attempts[1];
    assert.equal((await rawGet(christin, `/api/review-files/${final.sha256}`)).status, 200);
  });

  it('retains the reviewed final when clean-up fails, and retries later', async () => {
    const t = await newJob('Clean-up failure');
    const ref = await uploaded(christin, makePdf(2), 'old-set.pdf', 'reference');
    const v1 = await uploaded(christin, makePdf(1, { labels: ['PLT-004 v1'] }), 'PLT-004.pdf');
    let r = await christin.post(`/api/tickets/${t.id}/review/submissions`, { references: [ref], drawings: [{ reviewer_ids: REV, ...v1, notes: 'one' }] });
    let d = r.body.drawings[0];
    r = await ebin.post(`/api/review/drawings/${d.id}/decision`, { attempt_id: d.attempts[0].id, outcome: 'returned', note: 'fix' });
    const v2 = await uploaded(christin, makePdf(1, { labels: ['PLT-004 v2'] }), 'PLT-004.pdf');
    r = await christin.post(`/api/tickets/${t.id}/review/submissions`, { drawings: [{ reviewer_ids: REV, ...v2, notes: 'two' }] });
    d = r.body.drawings[0];
    // the final's stored copy is damaged before the clean-up runs
    const finalPath = blobPath(h.app.ctx, v2.sha256);
    const good = readFileSync(finalPath);
    writeFileSync(finalPath, Buffer.concat([good, Buffer.from('x')]));
    r = await ebin.post(`/api/review/drawings/${d.id}/decision`, { attempt_id: d.attempts[1].id, outcome: 'passed' });
    assert.equal(r.status, 200);
    await settle();
    let w = (await christin.get(`/api/tickets/${t.id}/review`)).body;
    assert.equal(w.drawings[0].cleanup, 'failed');
    assert.match(w.drawings[0].cleanup_detail, /could not be verified/);
    assert.equal(w.drawings[0].attempts[0].available, true, 'nothing removed while the final is in doubt');
    writeFileSync(finalPath, good);
    assert.equal(cleanupDrawing(h.app.ctx, d.id), 'done');
    w = (await christin.get(`/api/tickets/${t.id}/review`)).body;
    assert.equal(w.drawings[0].cleanup, 'done');
    assert.equal(w.drawings[0].attempts[0].available, false);
    assert.equal(w.drawings[0].attempts[1].available, true);
  });

  it('backs up review PDFs with the database and restores missing ones', async () => {
    const ctx = h.app.ctx;
    const b = backupNow(ctx, 'manual');
    assert.ok(existsSync(join(ctx.backupDir, `${b.name}.review-files.txt`)));
    const store = join(h.dir, 'review-files');
    const pdfs = () => readdirSync(store, { recursive: true }).filter((n) => String(n).endsWith('.pdf')).length;
    const before = pdfs();
    assert.ok(before >= 8);
    rmSync(store, { recursive: true, force: true });
    mkdirSync(store);
    const r = restoreFrom(ctx, join(ctx.backupDir, b.name));
    assert.equal(r.review_files_missing, 0);
    assert.equal(pdfs(), before);
    christin = await h.as('Christin');
    const w = (await christin.get(`/api/tickets/${job.id}/review`)).body;
    assert.equal(sha((await rawGet(christin, `/api/review-files/${w.references[0].sha256}`)).buf), sha(scan));
  });
});

describe('drawing review: project folder copies and the revision log', () => {
  let h: Harness;
  let christin: Client;
  let jeffin: Client;
  let folder: string;

  before(async () => {
    h = await startHarness();
    christin = await h.as('Christin');
    jeffin = await h.as('Jeffin');
    REV = [(await jeffin.get('/api/session')).body.user.id];
    folder = join(h.dir, 'share', 'Telescope mount');
    mkdirSync(folder, { recursive: true });
  });
  after(async () => {
    await settle();
    await h.close();
  });

  it('writes copies into Project/BoardReview and REVISION_LOG.md, cleans intermediates, and leaves other files alone', async () => {
    // files that were already in the project folder
    writeFileSync(join(folder, 'BRK-023 signed set.pdf'), makePdf(2));
    writeFileSync(join(folder, 'BRK-023.SLDDRW'), 'native CAD');
    const scanBytes = readFileSync(join(folder, 'BRK-023 signed set.pdf'));
    const t = await christin.create({ title: 'Revise mounting bracket', claim: true, file_location: folder });
    const ref = await uploaded(christin, scanBytes, 'BRK-023 signed set.pdf', 'reference');
    const v1 = await uploaded(christin, makePdf(1, { labels: ['v1'] }), 'BRK-023.pdf');
    let r = await christin.post(`/api/tickets/${t.id}/review/submissions`, { references: [ref], drawings: [{ reviewer_ids: REV, ...v1, notes: 'Holes Ø8 → Ø10' }] });
    assert.equal(r.status, 201);
    await settle();
    let w = (await christin.get(`/api/tickets/${t.id}/review`)).body;
    assert.equal(w.sync.state, 'ok', w.sync.detail);
    const jobDir = join(folder, 'BoardReview', t.job_number);
    assert.ok(existsSync(join(jobDir, 'BRK-023', 'attempt 1.pdf')));
    assert.match(readFileSync(join(folder, 'REVISION_LOG.md'), 'utf8'), /Attempt 1\*\* · BRK-023\.pdf/);

    const d = w.drawings[0];
    r = await jeffin.post(`/api/review/drawings/${d.id}/decision`, { attempt_id: d.attempts[0].id, outcome: 'returned', note: 'Check clearance' });
    const v2 = await uploaded(christin, makePdf(1, { labels: ['v2'] }), 'BRK-023.pdf');
    r = await christin.post(`/api/tickets/${t.id}/review/submissions`, { drawings: [{ reviewer_ids: REV, ...v2, notes: 'Clearance confirmed' }] });
    await settle();
    assert.ok(existsSync(join(jobDir, 'BRK-023', 'attempt 2.pdf')));
    // someone already saved a file where the reviewed copy will go
    writeFileSync(join(jobDir, 'BRK-023 - board reviewed (attempt 2).pdf'), 'not the board');
    r = await jeffin.post(`/api/review/drawings/${d.id}/decision`, { attempt_id: r.body.drawings[0].attempts[1].id, outcome: 'passed' });
    assert.equal(r.status, 200);
    await settle();
    w = (await christin.get(`/api/tickets/${t.id}/review`)).body;
    assert.equal(w.sync.state, 'failed');
    assert.match(w.sync.detail, /was not written by the board, so it was left alone/);
    assert.equal(readFileSync(join(jobDir, 'BRK-023 - board reviewed (attempt 2).pdf'), 'utf8'), 'not the board');
    // move it aside and retry
    rmSync(join(jobDir, 'BRK-023 - board reviewed (attempt 2).pdf'));
    await christin.post(`/api/tickets/${t.id}/review/sync`);
    await settle();
    w = (await christin.get(`/api/tickets/${t.id}/review`)).body;
    assert.equal(w.sync.state, 'ok', w.sync.detail);
    assert.equal(sha(readFileSync(join(jobDir, 'BRK-023 - board reviewed (attempt 2).pdf'))), v2.sha256, 'the exact reviewed bytes');
    assert.equal(existsSync(join(jobDir, 'BRK-023', 'attempt 1.pdf')), false, 'intermediate copy removed');
    assert.equal(existsSync(join(jobDir, 'BRK-023', 'attempt 2.pdf')), false, 'the final is kept under its reviewed name only');
    // untouched: the signed scan and the CAD file
    assert.equal(sha(readFileSync(join(folder, 'BRK-023 signed set.pdf'))), sha(scanBytes));
    assert.equal(readFileSync(join(folder, 'BRK-023.SLDDRW'), 'utf8'), 'native CAD');
    const log = readFileSync(join(folder, 'REVISION_LOG.md'), 'utf8');
    assert.match(log, /returned for correction by Jeffin.*Check clearance/);
    assert.match(log, /board review passed by Jeffin.*not official approval/);
    assert.match(log, /Intermediate PDF removed after board review/);
    assert.match(log, /Intermediate-file clean-up: done/);
  });

  it('reports an unreachable project folder and keeps the board copies', async () => {
    const t = await christin.create({ title: 'Offline share', claim: true, file_location: join(h.dir, 'no-such-share', 'Project') });
    const v1 = await uploaded(christin, makePdf(1, { labels: ['offline'] }), 'OFF-001.pdf');
    const r = await christin.post(`/api/tickets/${t.id}/review/submissions`, { drawings: [{ reviewer_ids: REV, ...v1, kind: 'new', notes: 'n' }] });
    assert.equal(r.status, 201);
    await settle();
    const w = (await christin.get(`/api/tickets/${t.id}/review`)).body;
    assert.equal(w.sync.state, 'failed');
    assert.match(w.sync.detail, /Can't reach the project folder/);
    assert.equal((await rawGet(christin, `/api/review-files/${v1.sha256}`)).status, 200);
  });

  it('never replaces a REVISION_LOG.md the board did not write', async () => {
    const other = join(h.dir, 'share', 'Other project');
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'REVISION_LOG.md'), '# Our own log\n');
    const t = await christin.create({ title: 'Own log', claim: true, file_location: other });
    const v1 = await uploaded(christin, makePdf(1, { labels: ['own'] }), 'OWN-001.pdf');
    await christin.post(`/api/tickets/${t.id}/review/submissions`, { drawings: [{ reviewer_ids: REV, ...v1, kind: 'new', notes: 'n' }] });
    await settle();
    const w = (await christin.get(`/api/tickets/${t.id}/review`)).body;
    assert.equal(w.sync.state, 'failed');
    assert.match(w.sync.detail, /REVISION_LOG\.md exists but was not written by the board/);
    assert.equal(readFileSync(join(other, 'REVISION_LOG.md'), 'utf8'), '# Our own log\n');
    const log = await christin.req('GET', `/api/tickets/${t.id}/review/log`);
    assert.match(String(log.body), /# Revision log/);
  });
});

describe('drawing review: a PDF that is both an attempt and a signed scan', () => {
  let h: Harness;
  before(async () => {
    h = await startHarness();
  });
  after(async () => {
    await settle();
    await h.close();
  });

  it('keeps it through clean-up, because signed scans are protected', async () => {
    const c = await h.as('Christin');
    const j = await h.as('Jeffin');
    REV = [(await j.get('/api/session')).body.user.id];
    const t = await c.create({ title: 'Shared bytes', claim: true });
    const first = makePdf(1, { labels: ['DUP-001 first'] });
    const v1 = await uploaded(c, first, 'DUP-001.pdf');
    let r = await c.post(`/api/tickets/${t.id}/review/submissions`, { drawings: [{ reviewer_ids: REV, ...v1, kind: 'new', notes: 'n' }] });
    let d = r.body.drawings[0];
    r = await j.post(`/api/review/drawings/${d.id}/decision`, { attempt_id: d.attempts[0].id, outcome: 'returned', note: 'redo' });
    // the same bytes are later attached as a signed reference scan
    const ref = await uploaded(c, first, 'signed.pdf', 'reference');
    await c.post(`/api/tickets/${t.id}/review/references`, ref);
    const v2 = await uploaded(c, makePdf(1, { labels: ['DUP-001 second'] }), 'DUP-001.pdf');
    r = await c.post(`/api/tickets/${t.id}/review/submissions`, { drawings: [{ reviewer_ids: REV, ...v2, notes: 'two' }] });
    d = r.body.drawings[0];
    r = await j.post(`/api/review/drawings/${d.id}/decision`, { attempt_id: d.attempts[1].id, outcome: 'passed' });
    await settle();
    const w = (await c.get(`/api/tickets/${t.id}/review`)).body;
    assert.equal(w.drawings[0].cleanup, 'done');
    assert.equal(w.drawings[0].attempts[0].available, false, 'the attempt is marked removed');
    assert.equal(sha(readFileSync(blobPath(h.app.ctx, v1.sha256))), sha(first), 'but the protected scan bytes stay');
    assert.equal((await rawGet(c, `/api/review-files/${v1.sha256}`)).status, 200);
  });
});
