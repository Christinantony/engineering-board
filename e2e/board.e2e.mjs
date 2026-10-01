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
import { test, before, after, afterEach } from 'node:test';

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

async function startServer() {
  server = spawn(process.execPath, ['dist/app/server.mjs'], {
    env: { ...process.env, EB_DATA_DIR: dir, EB_PORT: String(PORT), EB_HOST: '127.0.0.1' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(BASE + '/api/health')).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

async function stopServer() {
  const exited = new Promise((r) => server.once('exit', r));
  server.kill('SIGTERM');
  await exited;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'eb-e2e-'));
  await startServer();
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

// every browser window opened by a test is closed after it, so tests don't slow each other down
// and every page must finish without an uncaught error or an unexpected console error
const open = [];
const pages = [];
// 4xx answers are expected in some tests (a lost claim race is a 409); the app handles them
const EXPECTED_CONSOLE = [/Failed to load resource: the server responded with a status of 4\d\d/];
afterEach(async () => {
  const problems = pages.splice(0).flatMap((p) => [
    ...p.errors.map((e) => `page error: ${e}`),
    ...p.consoleErrors.filter((m) => !EXPECTED_CONSOLE.some((re) => re.test(m))).map((m) => `console: ${m}`),
  ]);
  while (open.length) await open.pop().close().catch(() => {});
  assert.deepEqual(problems, [], 'no errors in the browser');
});

async function login(name) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  open.push(ctx);
  const p = await ctx.newPage();
  p.errors = [];
  p.consoleErrors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  p.on('console', (m) => m.type() === 'error' && p.consoleErrors.push(m.text()));
  pages.push(p);
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

// ---------------- Phase 4: operational views, filters, search ----------------

test('board filters combine and survive a reload', async () => {
  const c = await login('Christin');
  const cookie = async () => (await c.context().cookies()).map((x) => `${x.name}=${x.value}`).join('; ');
  const shown = async () => {
    const ids = await c.locator('.card').evaluateAll((els) => els.map((e) => e.dataset.card));
    return Promise.all(ids.map(async (id) => (await (await fetch(`${BASE}/api/tickets/${id}`, { headers: { cookie: await cookie() } })).json()).ticket));
  };
  await c.click('.fchip:has-text("Urgent")');
  await c.waitForSelector('.fcount');
  const urgent = await shown();
  assert.ok(urgent.length >= 1);
  assert.ok(urgent.every((t) => t.priority === 'urgent'));
  await c.click('.fchip:has-text("Unassigned")');
  await c.waitForTimeout(200);
  assert.ok((await shown()).every((t) => t.priority === 'urgent' && t.assigned_to === null));
  assert.match(c.url(), /p=urgent/);
  assert.match(c.url(), /u=1/);
  await c.reload();
  await c.waitForSelector('.fchip.on:has-text("Urgent")');
  await c.click('button:has-text("Clear filters")');
  assert.doesNotMatch(c.url(), /p=urgent/);
});

test('search box finds by partial word and opens the job', async () => {
  const c = await login('Paul');
  await c.keyboard.press('/');
  await c.keyboard.type('weld fix');
  await c.waitForSelector('.search-row:has-text("Prototype jig for weld fixture")');
  await c.keyboard.press('ArrowDown');
  await c.keyboard.press('Enter');
  await c.waitForFunction(() => document.querySelector('.panel-title')?.value === 'Prototype jig for weld fixture');
});

test('today, dashboard, workload and reports pages render real data', async () => {
  const c = await login('Jeffin');
  await c.keyboard.press('t');
  await c.waitForSelector('.vsection-head h2:has-text("Being worked on")');
  await c.keyboard.press('d');
  await c.waitForSelector('.tally-item');
  assert.equal(await c.locator('.tally-item').count(), 6);
  await c.keyboard.press('w');
  await c.waitForSelector('.wl-row');
  await c.click('.seg-tabs button:has-text("This week")');
  await c.waitForURL(/h=week/);
  await c.keyboard.press('r');
  await c.waitForSelector('.table');
  assert.deepEqual(c.errors, []);
});

test('my work can be reordered with the keyboard', async () => {
  const a = await login('Allen');
  // give Allen two queued jobs
  for (const title of ['Queue one', 'Queue two']) {
    await a.keyboard.press('n');
    await a.fill('#qc-title', title);
    await a.keyboard.press('Shift+Enter');
    await a.waitForSelector('.quick-create', { state: 'detached' });
  }
  await a.keyboard.press('m');
  await a.waitForSelector('.reorder-item:has-text("Queue two")');
  const order = () => a.locator('.vsection:has(h2:has-text("Up next")) .jobrow-title').allInnerTexts();
  const before = await order();
  const idx = before.indexOf('Queue two');
  await a.locator('.reorder-item:has-text("Queue two") .jobrow').focus();
  await a.keyboard.press(idx > 0 ? 'Alt+ArrowUp' : 'Alt+ArrowDown');
  await a.waitForFunction(
    ([i]) => {
      const t = [...document.querySelectorAll('.vsection')].find((s) => s.textContent.includes('Up next'));
      const titles = [...t.querySelectorAll('.jobrow-title')].map((x) => x.textContent);
      return titles.indexOf('Queue two') !== i;
    },
    [idx],
  );
  await a.reload();
  await a.waitForSelector('.reorder-item:has-text("Queue two")');
  assert.notEqual((await order()).indexOf('Queue two'), idx, 'order is saved on the server');
});

// ---------------- Phase 5: collaboration ----------------

async function openJob(p, title) {
  const id = await p.locator('.card', { hasText: title }).first().getAttribute('data-card');
  await p.goto(`${BASE}/board?job=${id}`);
  await p.waitForSelector('.panel-title');
  return id;
}

test('two people editing different fields of one job: both changes survive, no prompt', async () => {
  const a = await login('Christin');
  const b = await login('Paul');
  await openJob(a, 'Hand calc: shaft key stress');
  await openJob(b, 'Hand calc: shaft key stress');
  await a.click('textarea[aria-label="Description"]'); // Christin starts editing the description
  await b.fill('.panel-title', 'Hand calc: shaft key stress (15 kW)');
  await b.keyboard.press('Enter'); // Paul saves a new title meanwhile
  await a.waitForFunction(() => document.querySelector('.panel-title')?.value.includes('15 kW'));
  await a.fill('textarea[aria-label="Description"]', 'Check keyway shear; use 1.5 safety factor.');
  await a.click('.panel-jobno'); // blur → save
  await a.waitForTimeout(600);
  assert.equal(await a.locator('.dialog').count(), 0, 'no conflict prompt for different fields');
  await b.waitForFunction(() => document.querySelector('textarea[aria-label="Description"]')?.value.includes('1.5 safety factor'));
  assert.equal(await b.inputValue('.panel-title'), 'Hand calc: shaft key stress (15 kW)');
});

test('two people editing the same notes: asked which to keep, and "keep both" keeps both', async () => {
  const a = await login('Christin');
  const b = await login('Paul');
  await openJob(a, 'Run FEA on mounting plate');
  await openJob(b, 'Run FEA on mounting plate');
  await b.waitForSelector('.also-viewing:has-text("Christin")');
  await a.click('textarea[aria-label="Notes"]');
  await b.fill('textarea[aria-label="Notes"]', 'Paul: use bonded contacts');
  await b.click('.panel-jobno');
  await a.waitForSelector('.edit-warn');
  await a.fill('textarea[aria-label="Notes"]', 'Christin: mesh 2 mm');
  await a.click('.panel-jobno');
  await a.waitForSelector('.conflict');
  assert.match(await a.locator('.conflict-text').first().innerText(), /Paul: use bonded contacts/);
  await a.click('.conflict button:has-text("Keep both")');
  await a.waitForFunction(() => {
    const v = document.querySelector('textarea[aria-label="Notes"]')?.value ?? '';
    return v.includes('Paul: use bonded contacts') && v.includes('Christin: mesh 2 mm');
  });
});

test('assignment pops a notification for the engineer, with a count on the bell', async () => {
  const allen = await login('Allen');
  const jeffin = await login('Jeffin');
  await jeffin.keyboard.press('n');
  await jeffin.fill('#qc-title', 'Notify Allen about this');
  await jeffin.keyboard.press('Enter');
  await jeffin.waitForSelector('.quick-create', { state: 'detached' });
  const card = jeffin.locator('.card', { hasText: 'Notify Allen about this' });
  await card.locator('button:has-text("Assign")').click();
  await jeffin.click('.assign-option:has-text("Allen")');
  await allen.waitForSelector('.toast:has-text("assigned this to you")', { timeout: 8000 });
  await allen.waitForSelector('.bell-count');
  await allen.click('.bell-btn');
  await allen.waitForSelector('.bell-item:has-text("Notify Allen about this")');
  await allen.waitForSelector('.bell-count', { state: 'detached' });
});

test('the activity page shows the team history and other people show as online', async () => {
  const a = await login('Christin');
  await login('Paul'); // Paul has the board open too
  await a.waitForSelector('.online .badge:has-text("PA")');
  await a.goto(`${BASE}/activity`);
  await a.waitForSelector('.feed-item');
  assert.ok((await a.locator('.feed-item').count()) > 10);
  assert.deepEqual(a.errors, []);
});

// ---------------- Phase 6: admin, import, export, backups ----------------

import { writeFileSync as _wf } from 'node:fs';

test('admin: unlock with the PIN, add a person and a job type', async () => {
  const c = await login('Christin');
  await c.goto(`${BASE}/admin`);
  await c.fill('input[aria-label="Admin PIN"]', '0000');
  await c.click('button:has-text("Unlock")');
  await c.waitForSelector('.form-error');
  await c.fill('input[aria-label="Admin PIN"]', '1234');
  await c.click('button:has-text("Unlock")');
  await c.waitForSelector('.admin-section h2:has-text("Team")');
  await c.fill('input[aria-label="Name"]', 'Maya Joseph');
  await c.click('button:has-text("Add person")');
  await c.waitForSelector('input[aria-label="Name of Maya Joseph"]');
  await c.click('.admin-nav a:has-text("Job types")');
  await c.fill('input[aria-label="New job type"]', 'Tolerance Stack-up');
  await c.click('button:has-text("Add job type")');
  await c.waitForFunction(() => [...document.querySelectorAll('.admin-list input')].some((i) => i.value === 'Tolerance Stack-up'));
});

test('admin: import from a CSV file with a preview, then the jobs are on the board', async () => {
  const c = await login('Christin');
  await c.goto(`${BASE}/admin?s=import`);
  await c.waitForSelector('input[aria-label="Admin PIN"], .admin-section');
  if (await c.locator('input[aria-label="Admin PIN"]').count()) {
    await c.fill('input[aria-label="Admin PIN"]', '1234');
    await c.click('button:has-text("Unlock")');
  }
  const file = join(dir, 'jobs.csv');
  _wf(file, 'Job,Assigned To,Due Date,Est,Priority\r\nImported bracket check,Paul,05/10/2026,2h,High\r\nImported BOM tidy,,06/10/2026,30,\r\n,,,,\r\nNo date here,,32/13/2026,,\r\n');
  await c.setInputFiles('input[aria-label="CSV file"]', file);
  await c.click('button:has-text("Check the file")');
  await c.waitForSelector('.import-summary');
  assert.match(await c.locator('.import-summary').innerText(), /2 of 3 rows are ready/);
  await c.click('button:has-text("Import 2 jobs")');
  await c.waitForSelector('.notice-ok:has-text("Imported 2 jobs")');
  await c.goto(`${BASE}/board`);
  await c.waitForSelector('.card:has-text("Imported bracket check") .badge:has-text("PA")');
});

test('admin: back up now, then restore it; the board follows', async () => {
  const c = await login('Christin');
  await c.goto(`${BASE}/admin?s=backups`);
  await c.waitForSelector('input[aria-label="Admin PIN"], .admin-section');
  if (await c.locator('input[aria-label="Admin PIN"]').count()) {
    await c.fill('input[aria-label="Admin PIN"]', '1234');
    await c.click('button:has-text("Unlock")');
  }
  await c.click('button:has-text("Back up now")');
  const saved = await c.locator('.toast:has-text("Backup saved")').innerText();
  const backupName = /board-[\w-]+\.db/.exec(saved)[0];
  // make a change after the backup
  const other = await login('Paul');
  await other.keyboard.press('n');
  await other.fill('#qc-title', 'Created after the backup');
  await other.keyboard.press('Enter');
  await other.waitForSelector('.card:has-text("Created after the backup")');
  // restore the newest manual backup
  await c.locator(`tr:has(td[title="${backupName}"])`).locator('button:has-text("Restore")').click();
  await c.click('.dialog button:has-text("Restore")');
  await c.waitForSelector('.toast:has-text("Restored")');
  // Paul's board drops the job without him reloading
  await other.waitForSelector('.card:has-text("Created after the backup")', { state: 'detached', timeout: 15000 });
});

test('export links download CSV and JSON', async () => {
  const c = await login('Allen');
  const cookie = (await c.context().cookies()).map((x) => `${x.name}=${x.value}`).join('; ');
  const csv = await fetch(`${BASE}/api/export/tickets.csv`, { headers: { cookie } });
  assert.equal(csv.status, 200);
  const bytes = Buffer.from(await csv.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM so Excel reads accents correctly');
  assert.match(bytes.subarray(3).toString('utf8'), /^job_number,title/);
  const json = await (await fetch(`${BASE}/api/export/tickets.json`, { headers: { cookie } })).json();
  assert.ok(json.tickets.length > 5);
});

// ---------------- Phase 7: keyboard, menus, accessibility ----------------

test('keyboard only: move a card to the next column and back, and claim with C', async () => {
  const c = await login('Christin');
  const card = c.locator('.card', { hasText: 'Prototype jig for weld fixture' });
  await card.focus();
  await c.keyboard.press('Shift+ArrowRight');
  await c.waitForFunction(() => document.querySelector('[data-col=in_progress]')?.textContent.includes('Prototype jig'));
  // focus stays on the moved card, so it can keep going
  await c.waitForFunction(() => !!document.activeElement?.closest('[data-card]')?.textContent?.includes('Prototype jig'));
  await c.keyboard.press('Shift+ArrowLeft');
  await c.waitForFunction(() => document.querySelector('[data-col=claimed]')?.textContent.includes('Prototype jig'));
  // claim the first unclaimed inbox card with C
  const inboxCard = c.locator('[data-col=inbox] .card:has(.btn-claim)').first();
  const title = await inboxCard.locator('.card-title').innerText();
  await inboxCard.focus();
  await c.keyboard.press('c');
  await c.waitForSelector('.toast:has-text("You claimed")');
  await c.waitForFunction((t) => document.querySelector('[data-col=claimed]')?.textContent.includes(t), title);
});

test('right-click menu moves a card and the ? key shows shortcuts', async () => {
  const c = await login('Paul');
  const card = c.locator('.card', { hasText: 'Clean up overlapping ANSYS surfaces' });
  await card.click({ button: 'right' });
  await c.waitForSelector('.card-menu');
  await c.click('.card-menu button:has-text("Review")');
  await c.waitForFunction(() => document.querySelector('[data-col=review]')?.textContent.includes('Clean up overlapping'));
  await c.locator('body').click({ position: { x: 5, y: 600 } });
  await c.keyboard.press('?');
  await c.waitForSelector('.help kbd');
  await c.keyboard.press('Escape');
  await c.waitForSelector('.help', { state: 'detached' });
});

test('dialogs keep keyboard focus inside and give it back when closed', async () => {
  const c = await login('Christin');
  await c.click('.new-job');
  await c.waitForSelector('#qc-title');
  await c.keyboard.press('Escape');
  const card = c.locator('.card').first();
  await card.focus();
  await c.keyboard.press('Shift+F10'); // open the card menu from the keyboard
  await c.waitForSelector('.card-menu');
  await c.keyboard.press('Escape');
  await c.waitForFunction(() => !!document.activeElement?.closest('[data-card]'), null, { timeout: 2000 });
  await c.keyboard.press('?');
  await c.waitForSelector('.help');
  for (let i = 0; i < 6; i++) await c.keyboard.press('Tab');
  assert.ok(await c.evaluate(() => !!document.activeElement?.closest('.dialog')), 'focus stays in the dialog');
  await c.keyboard.press('Escape');
});

test('every control on every page has a name a screen reader can read out', async () => {
  const c = await login('Christin');
  const pages = ['/board', '/today', '/my-work', '/dashboard', '/workload', '/reports', '/search?q=pump', '/activity', '/board?job=1'];
  const problems = [];
  for (const path of pages) {
    await c.goto(BASE + path);
    await c.waitForTimeout(700);
    const bad = await c.evaluate(() => {
      const named = (el) => {
        if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title')) return true;
        if ((el.textContent || '').trim()) return el.tagName !== 'INPUT' && el.tagName !== 'SELECT' && el.tagName !== 'TEXTAREA' ? true : !!el.labels?.length;
        if (el.labels && el.labels.length) return true;
        if (el.getAttribute('placeholder')) return true;
        return false;
      };
      return [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button]')]
        .filter((el) => el.offsetParent !== null && !named(el))
        .map((el) => el.outerHTML.slice(0, 120));
    });
    for (const b of bad) problems.push(`${path}: ${b}`);
  }
  assert.deepEqual(problems, []);
});

test('the host PC going away and coming back: people are told, then it carries on by itself', async () => {
  const p = await login('Allen');
  await stopServer();
  try {
    await p.waitForSelector('.banner-bad', { timeout: 15000 });
    assert.match(await p.textContent('.banner-bad'), /Can't reach the board server/);
  } finally {
    await startServer();
  }
  // a job created while Allen's screen was reconnecting still shows up
  const s = await api('POST', '/api/session', { user_id: 2 });
  await api('POST', '/api/tickets', { title: 'Made after the restart' }, s.cookie);
  await p.waitForSelector('.banner-bad', { state: 'detached', timeout: 20000 });
  await p.waitForSelector('.card:has-text("Made after the restart")', { timeout: 15000 });
  // the board is usable again: open the new job
  await p.click('.card:has-text("Made after the restart")');
  await p.waitForSelector('.panel');
  // the browser logs the dropped live connection while the server is down; that is expected here
  p.consoleErrors = p.consoleErrors.filter((m) => !/ERR_CONNECTION_REFUSED|net::ERR|EventSource|Failed to load resource/.test(m));
});

test('after the board is upgraded on the host, open screens offer a reload', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  open.push(ctx);
  const p = await ctx.newPage();
  p.errors = [];
  p.consoleErrors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  pages.push(p);
  // the page was loaded from this version, but its live connection now reaches a newer server
  await p.route('**/api/events', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
      body: 'retry: 5000\nevent: hello\ndata: {"version":"99.0.0"}\n\n',
    }),
  );
  await p.goto(BASE + '/');
  await p.click('.who-option:has-text("Paul")');
  await p.waitForSelector('.card');
  await p.waitForSelector('.banner-info', { timeout: 20000 });
  assert.match(await p.textContent('.banner-info'), /updated on the server/);
  const nav = p.waitForNavigation();
  await p.click('.banner-info button');
  await nav;
});
