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
/** Every seeded person creates this password before the tests (as they would at a first sign-in). */
const PASSWORD = 'board-e2e-1';

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
  // first sign-in for each seeded person: create the password
  for (const user_id of [1, 2, 3, 4]) assert.equal((await api('POST', '/api/session/password', { user_id, password: PASSWORD })).r.status, 200);
  const s = await api('POST', '/api/session', { user_id: 1, password: PASSWORD });
  const u = await api('POST', '/api/admin/unlock', { pin: '1234' }, s.cookie);
  await api('POST', '/api/admin/demo', {}, `${s.cookie}; ${u.cookie}`);
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
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

async function trackedPage(ctx) {
  const p = await ctx.newPage();
  p.errors = [];
  p.consoleErrors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  p.on('console', (m) => m.type() === 'error' && p.consoleErrors.push(m.text()));
  pages.push(p);
  return p;
}

async function freshPage(options = {}, init) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 }, ...options });
  open.push(ctx);
  if (init) await ctx.addInitScript(init);
  return trackedPage(ctx);
}

/** Pick a name on the sign-in screen and enter the password. */
async function signIn(p, name, password = PASSWORD) {
  await p.click(`.who-option:has-text("${name}")`);
  await p.fill('input[name=password]', password);
  await p.press('input[name=password]', 'Enter');
}

async function login(name) {
  const p = await freshPage();
  await p.goto(BASE + '/');
  await signIn(p, name);
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
  // the full user guide is one click away, served by the board itself
  const [guide] = await Promise.all([c.context().waitForEvent('page'), c.click('.help a:has-text("Open the user guide")')]);
  await guide.waitForLoadState();
  assert.equal(await guide.textContent('h1'), 'User guide');
  await guide.close();
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
  const s = await api('POST', '/api/session', { user_id: 2, password: PASSWORD });
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
  await signIn(p, 'Paul');
  await p.waitForSelector('.card');
  await p.waitForSelector('.banner-info', { timeout: 20000 });
  assert.match(await p.textContent('.banner-info'), /updated on the server/);
  const nav = p.waitForNavigation();
  await p.click('.banner-info button');
  await nav;
});

test('large board and workload lists show every job; later-page failures stay visible and retry', async () => {
  // Seed directly while stopped: thousands of API creates would test creation
  // throughput instead of the pagination boundary and make the suite slow.
  const s = await api('POST', '/api/session', { user_id: 2, password: PASSWORD });
  const users = await (await api('GET', '/api/users', undefined, s.cookie)).r.json();
  const paul = users.users.find((u) => u.name === 'Paul').id;
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  let p;
  await stopServer();
  const db = new DatabaseSync(join(dir, 'board.db'));
  db.exec('BEGIN');
  const insert = db.prepare(`INSERT INTO tickets
    (job_number, title, status, assigned_to, estimate_minutes, board_rank, created_at, updated_at, is_demo)
    VALUES (?, ?, 'in_progress', ?, 60, ?, ?, ?, 1)`);
  const now = new Date().toISOString();
  for (let i = 0; i < 2005; i++) insert.run(`PAGING-${i}`, `Pagination regression ${i}`, paul, 100_000 + i, now, now);
  db.exec('COMMIT');
  db.close();
  await startServer();
  try {
    const expected = await (await api('GET', '/api/tickets?view=board', undefined, s.cookie)).r.json();
    assert.ok(expected.total > 2000);
    p = await login('Paul');
    await p.waitForFunction((n) => document.querySelectorAll('.card[data-card]').length === n, expected.total, { timeout: 20000 });
    assert.equal(await p.locator('.card[data-card]').count(), expected.total);
    assert.equal(await p.locator('.card', { hasText: 'Pagination regression 2004' }).count(), 1);

    // Fail the second page of an SSE refresh, keeping the last complete list.
    await p.route('**/api/tickets?*', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('view') === 'board' && url.searchParams.get('offset') === '2000') {
        await route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'test_page_failure', message: 'Later page temporarily unavailable.' }) });
      } else await route.continue();
    });
    const made = await api('POST', '/api/tickets', { title: 'Pagination refresh trigger' }, s.cookie);
    assert.equal(made.r.status, 201);
    await p.waitForSelector('.error-box:has-text("last complete load")');
    assert.equal(await p.locator('.card[data-card]').count(), expected.total, 'no partial refresh replaces the complete board');
    await p.unroute('**/api/tickets?*');
    await p.click('.error-box button:has-text("Try again")');
    await p.waitForSelector('.error-box', { state: 'detached' });
    await p.waitForFunction((n) => document.querySelectorAll('.card[data-card]').length === n, expected.total + 1);

    // An event after the server has produced the last page can only be caught
    // by the cache's queued invalidation, not by cross-page revision checking.
    let releaseLastPage, sawLastPage;
    const held = new Promise((resolve) => { releaseLastPage = resolve; });
    const received = new Promise((resolve) => { sawLastPage = resolve; });
    let lastPageCalls = 0;
    await p.route('**/api/tickets?*', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('view') === 'board' && url.searchParams.get('offset') === '2000' && ++lastPageCalls === 1) {
        const response = await route.fetch();
        sawLastPage();
        await held;
        await route.fulfill({ response });
      } else await route.continue();
    });
    try {
      assert.equal((await api('POST', '/api/tickets', { title: 'Pagination inflight trigger' }, s.cookie)).r.status, 201);
      let deadline;
      try {
        await Promise.race([received, new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('refresh did not request its last page')), 5000); })]);
      } finally { clearTimeout(deadline); }
      assert.equal((await api('POST', '/api/tickets', { title: 'Created while last page was inflight' }, s.cookie)).r.status, 201);
      // Let the 120 ms SSE coalescer invalidate the still-pending collection.
      await p.waitForTimeout(300);
    } finally { releaseLastPage(); }
    await p.waitForSelector('.card:has-text("Created while last page was inflight")', { timeout: 10000 });
    assert.ok(lastPageCalls >= 2, 'an inflight invalidation caused another complete refresh');
    await p.unroute('**/api/tickets?*');

    const jobs = await (await api('GET', `/api/tickets?assignee=${paul}&status=claimed,in_progress,waiting,blocked,review`, undefined, s.cookie)).r.json();
    assert.ok(jobs.total > 2000);
    await p.keyboard.press('w');
    await p.click('.wl-row:has-text("Paul")');
    await p.waitForFunction((n) => document.querySelectorAll('.vsection-list .jobrow').length === n, jobs.total, { timeout: 20000 });
    assert.equal(await p.locator('.vsection-list .jobrow').count(), jobs.total);
    assert.match(await p.textContent('.vsection-head h2'), new RegExp(`\\(${jobs.total}\\)`));
  } finally {
    await p?.context().close();
    await stopServer();
    const cleanup = new DatabaseSync(join(dir, 'board.db'));
    cleanup.exec("DELETE FROM tickets WHERE job_number LIKE 'PAGING-%'");
    cleanup.close();
    await startServer();
  }
});

// ---------------- Optional themes: browser preference and whole-board appearance ----------------

const THEME_KEY = 'engineering-board-theme';
const themePicker = (p) => p.getByRole('combobox', { name: 'Theme', exact: true });
async function expectTheme(p, theme) {
  await p.waitForFunction((t) => document.documentElement.dataset.theme === t, theme);
  assert.equal(await themePicker(p).inputValue(), theme);
}

// Use the rendered foreground/background rather than CSS token names: this
// catches a white input or hardcoded pale badge in an otherwise dark screen.
async function readableDarkSurface(p, selector, minContrast = 4.5, pseudo = null) {
  const locator = typeof selector === 'string' ? p.locator(selector).first() : selector;
  const colors = await locator.evaluate((el, pseudo) => {
    const rgba = (s) => s.match(/[\d.]+/g).map(Number);
    const blend = (fg, bg) => fg.slice(0, 3).map((v, i) => v * (fg[3] ?? 1) + bg[i] * (1 - (fg[3] ?? 1)));
    const ancestors = [];
    for (let node = el; node; node = node.parentElement) ancestors.push(node);
    let bg = [255, 255, 255];
    for (const node of ancestors.reverse()) bg = blend(rgba(getComputedStyle(node).backgroundColor), bg);
    const style = getComputedStyle(el, pseudo);
    const foreground = rgba(style.color);
    foreground[3] = (foreground[3] ?? 1) * Number(style.opacity);
    const fg = blend(foreground, bg);
    const luminance = (rgb) => rgb.map((v) => v / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
    const a = luminance(fg), b = luminance(bg);
    return { fg, bg, backgroundLuminance: b, contrast: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
  }, pseudo);
  assert.ok(colors.backgroundLuminance < 0.25, `${selector} has a dark surface: ${JSON.stringify(colors)}`);
  assert.ok(colors.contrast >= minContrast, `${selector} remains readable (${colors.contrast.toFixed(2)}:1)`);
}

test('theme picker retains the existing light default and preferences survive reload and user switches', async () => {
  const p = await freshPage({ colorScheme: 'dark' });
  await p.goto(BASE);
  await p.waitForSelector('.who-option');
  await expectTheme(p, 'light'); // optional themes never override the existing default
  assert.deepEqual(await themePicker(p).locator('option').allTextContents(), ['Light', 'Charcoal', 'Midnight']);
  const lightBackground = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await themePicker(p).selectOption({ label: 'Charcoal' });
  await expectTheme(p, 'charcoal');
  await readableDarkSurface(p, '.who-card');
  await signIn(p, 'Christin');
  await p.waitForSelector('.card');
  await expectTheme(p, 'charcoal');
  await themePicker(p).selectOption({ label: 'Midnight' });
  await expectTheme(p, 'midnight');
  assert.equal(await p.evaluate((key) => localStorage.getItem(key), THEME_KEY), 'midnight');
  await p.reload();
  await p.waitForSelector('.card');
  await expectTheme(p, 'midnight');
  await p.click('summary[aria-label="Account"]');
  await p.click('button:has-text("Sign out")');
  await p.waitForSelector('.who-option');
  await expectTheme(p, 'midnight');
  await signIn(p, 'Paul');
  await p.waitForSelector('.card');
  await expectTheme(p, 'midnight');
  await themePicker(p).selectOption({ label: 'Light' });
  await expectTheme(p, 'light');
  assert.equal(await p.evaluate(() => getComputedStyle(document.body).backgroundColor), lightBackground);
  const otherBrowser = await freshPage();
  await otherBrowser.goto(BASE);
  await otherBrowser.waitForSelector('.who-option');
  await expectTheme(otherBrowser, 'light');
});

test('saved dark preference is applied before the main application bundle loads', async () => {
  for (const theme of ['charcoal', 'midnight']) {
    const p = await freshPage();
    // Seed on the same origin before the navigation whose first paint is being inspected.
    await p.context().clearCookies();
    await p.goto(BASE);
    await p.evaluate(([key, value]) => localStorage.setItem(key, value), [THEME_KEY, theme]);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await p.route('**/assets/app.js?*', async (route) => { await held; await route.continue(); });
    try {
      await p.goto(BASE, { waitUntil: 'commit' });
      await p.waitForFunction(() => document.body && [...document.styleSheets].some((s) => s.href?.includes('/assets/app.css')));
      await p.waitForFunction((t) => document.documentElement.dataset.theme === t, theme);
      assert.equal(await p.locator('.who-option').count(), 0, 'application bundle is still held');
      await readableDarkSurface(p, 'body');
    } finally { release(); }
    await p.waitForSelector('.who-option');
    await expectTheme(p, theme);
  }
});

test('changing a theme updates other tabs without changing another browser preference', async () => {
  const a = await freshPage();
  await a.goto(BASE);
  await a.waitForSelector('.who-option');
  const b = await trackedPage(a.context());
  await b.goto(BASE);
  await b.waitForSelector('.who-option');
  const separate = await freshPage();
  await separate.goto(BASE);
  await separate.waitForSelector('.who-option');
  await themePicker(a).selectOption('midnight');
  await expectTheme(b, 'midnight');
  await expectTheme(separate, 'light');
  await b.evaluate((key) => localStorage.removeItem(key), THEME_KEY);
  await expectTheme(a, 'light');
});

test('invalid or inaccessible storage falls back to light without preventing theme changes', async () => {
  const invalid = await freshPage({}, () => localStorage.setItem('engineering-board-theme', 'unrecognised-theme'));
  await invalid.goto(BASE);
  await invalid.waitForSelector('.who-option');
  await expectTheme(invalid, 'light');
  await themePicker(invalid).selectOption('charcoal');
  await expectTheme(invalid, 'charcoal');
  for (const mode of ['methods', 'property']) {
    const blocked = await freshPage({}, mode === 'methods' ? () => {
      Storage.prototype.getItem = () => { throw new DOMException('Storage blocked', 'SecurityError'); };
      Storage.prototype.setItem = () => { throw new DOMException('Storage blocked', 'SecurityError'); };
    } : () => {
      Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage blocked', 'SecurityError'); } });
    });
    await blocked.goto(BASE);
    await blocked.waitForSelector('.who-option');
    await expectTheme(blocked, 'light');
    await themePicker(blocked).selectOption('midnight');
    await expectTheme(blocked, 'midnight');
    await signIn(blocked, 'Allen');
    await blocked.waitForSelector('.card');
    await expectTheme(blocked, 'midnight');
    await blocked.reload();
    await blocked.waitForSelector('.card');
    await expectTheme(blocked, 'light');
  }
});

for (const theme of ['charcoal', 'midnight']) {
  test(`${theme} covers board, views, inputs, job panel, dialogs and mobile controls`, async () => {
    const p = await login('Christin');
    await themePicker(p).selectOption(theme);
    await expectTheme(p, theme);
    await readableDarkSurface(p, '.card-title');
    await readableDarkSurface(p, '.card-meta');
    await readableDarkSurface(p, '.topbar .brand');
    const routes = [
      ['/today', '.vsection-head h2'], ['/my-work', '.vsection-head h2'], ['/dashboard', '.tally-item'],
      ['/workload', '.wl-row'], ['/reports', '.table'], ['/search?q=pump', 'input[aria-label="Search text"]'], ['/activity', '.feed-item'],
      ['/admin', 'input[aria-label="Admin PIN"]'],
    ];
    for (const [path, ready] of routes) {
      await p.goto(BASE + path);
      await p.waitForSelector(ready);
      await expectTheme(p, theme);
      await readableDarkSurface(p, 'body');
      await readableDarkSurface(p, ready);
      const counts = p.locator('.vsection-count');
      for (let i = 0; i < await counts.count(); i++) await readableDarkSurface(p, counts.nth(i));
    }
    await readableDarkSurface(p, 'input[aria-label="Admin PIN"]');
    await p.goto(BASE + '/board?job=1');
    await p.waitForSelector('.panel-title');
    await readableDarkSurface(p, '.panel-title');
    await readableDarkSurface(p, '.status-pill');
    await readableDarkSurface(p, 'textarea[aria-label="Add a comment"]');
    assert.equal(await p.inputValue('input[aria-label="Reference"]'), '', 'empty reference shows its placeholder');
    await readableDarkSurface(p, 'input[aria-label="Reference"]', 4.5, '::placeholder');
    await p.getByRole('button', { name: 'Close (Esc)', exact: true }).click();
    await p.click('.new-job');
    await p.waitForSelector('#qc-title');
    await readableDarkSurface(p, '#qc-title');
    assert.equal(await p.inputValue('#qc-title'), '');
    await readableDarkSurface(p, '#qc-title', 4.5, '::placeholder');
    const details = '.quick-create textarea[aria-label="Description"]';
    assert.equal(await p.inputValue(details), '');
    await readableDarkSurface(p, details, 4.5, '::placeholder');
    await readableDarkSurface(p, '.quick-create');
    await p.keyboard.press('Escape');
    await p.click('button[aria-label="Keyboard shortcuts"]');
    await p.waitForSelector('.help');
    await readableDarkSurface(p, '.dialog-title');
    await readableDarkSurface(p, '.help kbd');
    await p.keyboard.press('Escape');
    await p.setViewportSize({ width: 390, height: 844 });
    const picker = themePicker(p);
    await picker.scrollIntoViewIfNeeded();
    const bounds = await picker.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391, 'theme selector fits the mobile viewport');
    await picker.selectOption('light');
    await expectTheme(p, 'light');
    await picker.selectOption(theme);
    await expectTheme(p, theme);
    await p.click('.new-job');
    await p.waitForSelector('#qc-title');
    await p.fill('#qc-title', `Mobile ${theme} draft`);
    assert.equal(await p.inputValue('#qc-title'), `Mobile ${theme} draft`);
    await p.keyboard.press('Escape');
  });
}

test('password sign-in: a new person creates theirs, a wrong one is refused, changing it signs out other browsers, an admin resets it', async () => {
  // an admin adds Nila; she has no password until she creates one
  const s = await api('POST', '/api/session', { user_id: 1, password: PASSWORD });
  const u = await api('POST', '/api/admin/unlock', { pin: '1234' }, s.cookie);
  const made = await api('POST', '/api/admin/users', { name: 'Nila Thomas', role: 'engineer' }, `${s.cookie}; ${u.cookie}`);
  assert.equal(made.r.status, 201);
  const nilaId = (await made.r.json()).user.id;

  const p = await freshPage();
  await p.goto(BASE + '/');
  await p.click('.who-option:has-text("Nila")');
  await p.waitForSelector('text=create one now');
  const submit = p.locator('button[type=submit]');
  assert.equal(await submit.isDisabled(), true, 'nothing typed yet');
  await p.fill('input[name=password]', 'nilas-phrase');
  await p.fill('input[name=password_again]', 'mayas-phrasx');
  await p.waitForSelector('.form-error:has-text("don\'t match")');
  assert.equal(await submit.isDisabled(), true, 'mismatch blocks the button');
  await p.fill('input[name=password_again]', 'nilas-phrase');
  await submit.click();
  await p.waitForSelector('.card');
  assert.ok((await p.textContent('.me-name')).includes('Nila'), 'signed in as Nila');

  // a second browser: wrong password, then the right one
  const q = await freshPage();
  await q.goto(BASE + '/');
  await q.click('.who-option:has-text("Nila")');
  await q.waitForSelector('text=Enter your password');
  assert.equal(await q.locator('input[name=password_again]').count(), 0, 'no confirm field once a password exists');
  await q.fill('input[name=password]', 'not-this-one');
  await q.press('input[name=password]', 'Enter');
  await q.waitForSelector('.form-error:has-text("isn\'t right")');
  assert.equal(await q.locator('.card').count(), 0, 'still on the sign-in screen');
  await q.fill('input[name=password]', 'nilas-phrase');
  await q.press('input[name=password]', 'Enter');
  await q.waitForSelector('.card');

  // changing the password from the account menu: this browser stays in, the other is signed out
  await p.click('summary[aria-label="Account"]');
  await p.click('button:has-text("Change password")');
  await p.waitForSelector('.dialog');
  await p.fill('#pw-current', 'wrong-current');
  await p.fill('#pw-next', 'new-phrase-2026');
  await p.fill('#pw-again', 'new-phrase-2026');
  await p.click('.dialog button:has-text("Change password")');
  await p.waitForSelector('.dialog .form-error:has-text("isn\'t right")');
  await p.fill('#pw-current', 'nilas-phrase');
  await p.click('.dialog button:has-text("Change password")');
  await p.waitForSelector('.toast:has-text("password has been changed")');
  await p.reload();
  await p.waitForSelector('.card');
  await q.reload();
  await q.waitForSelector('.who-option', { timeout: 5000 });

  // an admin resets it: Nila is signed out and creates a new password next time
  const a = await login('Christin');
  await a.goto(BASE + '/admin?s=team');
  await a.fill('input[aria-label="Admin PIN"]', '1234');
  await a.press('input[aria-label="Admin PIN"]', 'Enter');
  await a.waitForSelector('.admin-table');
  const row = a.locator('tr:has(input[aria-label="Name of Nila Thomas"])');
  assert.equal((await row.textContent()).includes('Set'), true);
  await row.locator('button[aria-label="Reset the password of Nila Thomas"]').click();
  await a.click('.dialog button:has-text("Reset password")');
  await a.waitForSelector('.toast:has-text("password was reset")');
  await a.waitForSelector('tr:has(input[aria-label="Name of Nila Thomas"]):has-text("Not created yet")');
  await p.reload();
  await p.waitForSelector('.who-option', { timeout: 5000 });
  await p.click('.who-option:has-text("Nila")');
  await p.waitForSelector('text=create one now');
  // tidy: make Nila inactive so the other tests' pickers are unchanged
  await api('PATCH', `/api/admin/users/${nilaId}`, { active: false }, `${s.cookie}; ${u.cookie}`);
});
