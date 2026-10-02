// Browser checks for drawing review: submitting, the two independent PDF
// viewers (page, zoom, rotation), remembering a reference page, comments,
// passing, handover with its reminder, and signature.
//   npm run build && npm run e2e

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { test, before, after, afterEach } from 'node:test';
import { makePdf } from './fixtures/pdf.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');

const PORT = 18094;
const BASE = `http://127.0.0.1:${PORT}`;
let server, dir, browser;
const PASSWORD = 'board-e2e-1';
const sha = (b) => createHash('sha256').update(b).digest('hex');

async function api(method, path, body, cookie) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { r, body: text ? JSON.parse(text) : null, cookie: r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eb-e2e-review-'));
  server = spawn(process.execPath, ['dist/app/server.mjs'], {
    env: { ...process.env, EB_DATA_DIR: dir, EB_PORT: String(PORT), EB_HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(BASE + '/api/health')).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const user_id of [1, 2, 3, 4]) assert.equal((await api('POST', '/api/session/password', { user_id, password: PASSWORD })).r.status, 200);
  const s = await api('POST', '/api/session', { user_id: 1, password: PASSWORD });
  const u = await api('POST', '/api/admin/unlock', { pin: '1234' }, s.cookie);
  const r = await api('POST', '/api/admin/users', { name: 'Ebin', role: 'reviewer' }, `${s.cookie}; ${u.cookie}`);
  assert.equal(r.r.status, 201);
  assert.equal((await api('POST', '/api/session/password', { user_id: r.body.user.id, password: PASSWORD })).r.status, 200);
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
});

after(async () => {
  await browser?.close();
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

const open = [];
const pages = [];
const EXPECTED_CONSOLE = [/Failed to load resource: the server responded with a status of 4\d\d/];
afterEach(async () => {
  const problems = pages.splice(0).flatMap((p) => [
    ...p.errors.map((e) => `page error: ${e}`),
    ...p.consoleErrors.filter((m) => !EXPECTED_CONSOLE.some((re) => re.test(m))).map((m) => `console: ${m}`),
  ]);
  while (open.length) await open.pop().close().catch(() => {});
  assert.deepEqual(problems, [], 'no errors in the browser');
});

async function login(name, theme) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  open.push(ctx);
  if (theme) await ctx.addInitScript((t) => localStorage.setItem('engineering-board-theme', t), theme);
  const p = await ctx.newPage();
  p.errors = [];
  p.consoleErrors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  p.on('console', (m) => m.type() === 'error' && p.consoleErrors.push(m.text()));
  pages.push(p);
  await p.goto(BASE + '/');
  await p.click(`.who-option:has-text("${name}")`);
  await p.fill('input[name=password]', PASSWORD);
  await p.press('input[name=password]', 'Enter');
  await p.waitForSelector('.topbar');
  return p;
}

const rendered = (p, id) => p.waitForSelector(`[data-testid=${id}] canvas[data-rendered]`, { timeout: 20_000 });
const renderedState = (p, id) => p.locator(`[data-testid=${id}] canvas`).getAttribute('data-rendered');

let jobId;
const scan = makePdf(3, { labels: ['BRK-023 Rev B signed', 'ASM-010 Rev C signed', 'PLT-004 Rev A signed'] });

test('an engineer submits a signed scan and single-page drawings; a multi-page drawing is refused', async () => {
  const c = await login('Christin');
  const created = await c.evaluate(async () => {
    const r = await fetch('/api/tickets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Revise mounting bracket', claim: true }) });
    return (await r.json()).ticket;
  });
  jobId = created.id;
  await c.goto(`${BASE}/board?job=${jobId}`);
  await c.click('.panel-review button:has-text("Submit for board review")');
  await c.waitForSelector('.rw-submit');
  await c.setInputFiles('[data-testid=pick-reference]', { name: 'Telescope mount signed set.pdf', mimeType: 'application/pdf', buffer: scan });
  await c.waitForSelector('.rw-file.done:has-text("3 pages")');
  await c.setInputFiles('[data-testid=pick-drawings]', [
    { name: 'BRK-023.pdf', mimeType: 'application/pdf', buffer: makePdf(1, { labels: ['BRK-023 Rev C'] }) },
    { name: 'SUP-011.pdf', mimeType: 'application/pdf', buffer: makePdf(1, { labels: ['SUP-011 Rev A'], compressed: true }) },
    { name: 'TWO-SHEETS.pdf', mimeType: 'application/pdf', buffer: makePdf(2) },
  ]);
  await c.waitForSelector('.rw-file.error:has-text("TWO-SHEETS.pdf has 2 pages")');
  await c.click('button[aria-label="Remove TWO-SHEETS.pdf"]');
  await c.fill('textarea[aria-label="Notes for BRK-023.pdf"]', 'Mounting holes Ø8 → Ø10 for the revised fastener size.');
  await c.selectOption('select[aria-label="Type of SUP-011.pdf"]', 'new');
  await c.fill('textarea[aria-label="Notes for SUP-011.pdf"]', 'New support plate.');
  await c.click('button:has-text("Submit 2 drawings for board review")');
  await c.waitForSelector('.toast:has-text("Submitted for board review")');
  await c.waitForSelector('.rw-item:has-text("BRK-023")');
  await c.waitForSelector('.rw-item:has-text("SUP-011")');
  assert.equal(await c.locator('[data-testid=action-bar]').getByText('Pass board review').count(), 0, 'engineers cannot pass drawings');
});

test('a reviewer compares independently: page, zoom and rotation per viewer, and remembers the reference page', async () => {
  const e = await login('Ebin', 'midnight');
  await e.goto(`${BASE}/review`);
  await e.waitForSelector(`.rv-table tr:has-text("Revise mounting bracket")`);
  await e.click('.rv-open-btn');
  await rendered(e, 'viewer-reference');
  await rendered(e, 'viewer-submitted');
  const ref = e.locator('[data-testid=viewer-reference]');
  const sub = e.locator('[data-testid=viewer-submitted]');
  assert.equal(await ref.getAttribute('data-pages'), '3');
  assert.equal(await sub.getAttribute('data-pages'), '1');

  // move only the reference to page 2 and rotate only the submitted drawing
  await ref.locator('button[aria-label="Next page"]').click();
  await e.waitForFunction(() => document.querySelector('[data-testid=viewer-reference] canvas')?.dataset.rendered?.startsWith('2:'));
  const before = await sub.locator('canvas').boundingBox();
  await sub.locator('button[aria-label="Rotate clockwise"]').click();
  await e.waitForFunction(() => document.querySelector('[data-testid=viewer-submitted] canvas')?.dataset.rendered?.split(':')[1] === '90');
  const after = await sub.locator('canvas').boundingBox();
  assert.ok(after.height > after.width && before.width > before.height, 'the landscape sheet is shown portrait');
  assert.equal(await ref.getAttribute('data-rotation'), '0', 'the other viewer is not rotated');
  assert.equal(await sub.getAttribute('data-page'), '1');
  await ref.locator('button[aria-label="Zoom in"]').click();
  assert.equal(await ref.getAttribute('data-zoom'), 'custom');
  assert.equal(await sub.getAttribute('data-zoom'), 'page');
  await sub.locator('button:has-text("Reset")').click();
  await e.waitForFunction(() => document.querySelector('[data-testid=viewer-submitted] canvas')?.dataset.rendered?.split(':')[1] === '0');

  // the bytes are unchanged by viewing
  const bytes = await e.evaluate(async () => {
    const w = await (await fetch(location.pathname.replace('/review/', '/api/tickets/') + '/review')).json();
    const r = await fetch(`/api/review-files/${w.references[0].sha256}`);
    return Array.from(new Uint8Array(await r.arrayBuffer()));
  });
  assert.equal(sha(Buffer.from(bytes)), sha(scan));

  // remember page 2 for BRK-023; it comes back after a reload
  await ref.locator('button:has-text("Remember page 2")').click();
  await e.waitForSelector('[data-testid=remembered]:has-text("Remembered page 2")');
  await e.reload();
  await rendered(e, 'viewer-reference');
  await e.waitForFunction(() => document.querySelector('[data-testid=viewer-reference]')?.getAttribute('data-page') === '2');
  assert.match(await e.locator('.rw-dl').innerText(), /Page 2 of Telescope mount signed set\.pdf/);
});

test('comments block a pass; pass, handover reminder and signature complete the job', async () => {
  const e = await login('Ebin');
  await e.goto(`${BASE}/review/${jobId}`);
  await e.waitForSelector('.rw-item:has-text("BRK-023")');
  await e.fill('textarea[aria-label="Add a review comment"]', 'Please confirm mating fastener clearance.');
  await e.click('button:has-text("Post comment")');
  await e.waitForSelector('.rw-comment:has-text("mating fastener")');
  assert.equal(await e.locator('button:has-text("Pass board review")').isDisabled(), true);
  await e.waitForSelector('text=Resolve open comments to pass');
  await e.click('.rw-comment button:has-text("Resolve")');
  await e.waitForSelector('.rw-comment .rv-chip:has-text("Resolved")');
  await e.click('button:has-text("Pass board review")');
  await e.waitForSelector('[data-testid=drawing-state]:has-text("Board review passed — signature pending")');
  await e.click('.rw-item:has-text("SUP-011")');
  await rendered(e, 'viewer-submitted');
  await e.click('button:has-text("Pass board review")');
  await e.waitForSelector('[data-testid=drawing-state]:has-text("Board review passed")');

  const c = await login('Christin');
  await c.goto(`${BASE}/review/${jobId}`);
  await c.waitForSelector('.rw-item:has-text("BRK-023")');
  for (const d of ['BRK-023', 'SUP-011']) {
    await c.click(`.rw-item:has-text("${d}")`);
    await c.click('button:has-text("Mark handed over for signature")');
    await c.click('.dialog button:has-text("Mark handed over")');
    await c.waitForSelector('[data-testid=drawing-state]:has-text("Handed over for signature")');
  }
  // Done is refused until signed
  const move = await c.evaluate(async (id) => {
    const t = (await (await fetch(`/api/tickets/${id}`)).json()).ticket;
    const r = await fetch(`/api/tickets/${id}/move`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'done', from_status: t.status }) });
    return { status: r.status, body: await r.json() };
  }, jobId);
  assert.equal(move.status, 409);
  assert.match(move.body.message, /physical signature/);

  // the reviewer gets exactly one reminder per handed-over drawing
  await e.reload();
  await e.click('.bell-btn');
  await e.waitForSelector('.bell-detail:has-text("was approved by you in the board on")');
  assert.equal(await e.locator('.bell-detail:has-text("handed over for your signature")').count(), 2);
  await e.keyboard.press('Escape');

  for (const d of ['BRK-023', 'SUP-011']) {
    await c.click(`.rw-item:has-text("${d}")`);
    await c.click('button:has-text("Record physical signature")');
    await c.click('.dialog button:has-text("Record signature")');
    await c.waitForSelector('[data-testid=drawing-state]:has-text("Physically signed")');
  }
  await c.waitForSelector('.rv-chip:has-text("All drawings signed")');
  const t = await c.evaluate(async (id) => (await (await fetch(`/api/tickets/${id}`)).json()).ticket.status, jobId);
  assert.equal(t, 'done');
});
