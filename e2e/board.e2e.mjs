// Browser end-to-end checks for the board (Phase 3).
// Needs Playwright with Chromium (dev machines only — not needed to run the board).
//   npm run build && npm run e2e
// Starts its own server on a temporary data folder with demo data.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');

const PORT = 18093;
const BASE = `http://127.0.0.1:${PORT}`;
let server, dir, browser;

async function api(method, path, body, cookie) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { r, cookie: r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eb-e2e-'));
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'dist/app/server.mjs'], {
    env: { ...process.env, EB_DATA_DIR: dir, EB_PORT: String(PORT), EB_HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(BASE + '/api/health')).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  const s = await api('POST', '/api/session', { user_id: 1 });
  const u = await api('POST', '/api/admin/unlock', { pin: '1234' }, s.cookie);
  await api('POST', '/api/admin/demo', {}, `${s.cookie}; ${u.cookie}`);
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

async function login(name) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const p = await ctx.newPage();
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  await p.goto(BASE + '/');
  await p.click(`.who-option:has-text("${name}")`);
  await p.waitForSelector('.card');
  return p;
}

async function drag(p, cardText, colId) {
  const box = await p.locator('.card', { hasText: cardText }).first().boundingBox();
  const col = await p.locator(`[data-col="${colId}"] .col-list`).boundingBox();
  await p.mouse.move(box.x + 40, box.y + 20);
  await p.mouse.down();
  await p.mouse.move(box.x + 60, box.y + 40, { steps: 3 });
  await p.mouse.move(col.x + 60, col.y + col.height - 30, { steps: 12 });
  await p.mouse.up();
}
const columnOf = (p, text) => p.locator('.card', { hasText: text }).first().evaluate((el) => el.closest('[data-col]').dataset.col);

test('drag between columns, live update to a second browser, and undo', async () => {
  const c = await login('Christin');
  const paul = await login('Paul');
  await drag(c, 'Bracket redesign', 'review');
  await c.waitForSelector('.toast:has-text("moved to Review")');
  assert.equal(await columnOf(c, 'Bracket redesign'), 'review');
  await paul.waitForFunction(() => document.querySelector('[data-col=review]')?.textContent.includes('Bracket redesign'), null, { timeout: 5000 });
  await c.click('.toast-action:has-text("Undo")');
  await c.waitForFunction(() => document.querySelector('[data-col=in_progress]')?.textContent.includes('Bracket redesign'));
  assert.deepEqual([...c.errors, ...paul.errors], []);
});

test('moving to Waiting asks what it is waiting for; cancelling puts the card back', async () => {
  const c = await login('Christin');
  await drag(c, 'Investigate interference', 'waiting');
  await c.waitForSelector('.dialog');
  await c.keyboard.press('Escape');
  await c.waitForTimeout(300);
  assert.equal(await columnOf(c, 'Investigate interference'), 'inbox');
  await drag(c, 'CFD on inlet duct', 'waiting');
  await c.fill('.dialog input[aria-label="Waiting for"]', 'Supplier response');
  await c.click('.dialog button[type=submit]');
  await c.waitForSelector('.card:has-text("CFD on inlet duct") .card-waiting');
  assert.equal(await columnOf(c, 'CFD on inlet duct'), 'waiting');
});

test('quick create with N and Shift+Enter creates and claims', async () => {
  const c = await login('Allen');
  await c.keyboard.press('n');
  await c.fill('#qc-title', 'Check weld symbol on frame drawing');
  await c.keyboard.press('Shift+Enter');
  await c.waitForSelector('.toast:has-text("created and claimed")');
  assert.equal(await columnOf(c, 'Check weld symbol'), 'claimed');
});

test('simultaneous claim: one wins, the other is told who has it', async () => {
  const a = await login('Christin');
  const b = await login('Paul');
  const sel = (p) => p.locator('.card', { hasText: 'Repair imported STEP' }).locator('.btn-claim');
  await Promise.all([sel(a).click(), sel(b).click()]);
  await a.waitForTimeout(800);
  const msgs = [...(await a.locator('.toast').allInnerTexts()), ...(await b.locator('.toast').allInnerTexts())].join('\n');
  assert.match(msgs, /You claimed JOB-\d+/);
  assert.match(msgs, /already claimed by (Christin|Paul)/);
});

test('manager drag of an unassigned job asks who should take it', async () => {
  const j = await login('Jeffin');
  await drag(j, 'Investigate interference', 'in_progress');
  await j.click('.assign-option:has-text("Allen")');
  await j.waitForFunction(() => document.querySelector('[data-col=in_progress]')?.textContent.includes('Investigate interference'));
  assert.equal(await j.locator('.card', { hasText: 'Investigate interference' }).locator('.badge').innerText(), 'AL');
});

test('panel edits sync to another open panel; comments land in the history', async () => {
  const a = await login('Christin');
  const b = await login('Paul');
  await a.goto(BASE + '/board?job=4');
  await b.goto(BASE + '/board?job=4');
  await b.fill('.panel-title', 'Run FEA on mounting plate (modal + static)');
  await b.keyboard.press('Enter');
  await a.waitForFunction(() => document.querySelector('.panel-title')?.value.includes('modal + static'), null, { timeout: 5000 });
  await a.fill('textarea[aria-label="Add a comment"]', 'Mesh converged at 2 mm');
  await a.click('button:has-text("Add to history")');
  await a.waitForSelector('.tl-bubble:has-text("Mesh converged")');
});
