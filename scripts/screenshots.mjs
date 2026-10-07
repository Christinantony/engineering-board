// Takes the README screenshots in real Chromium against a freshly started
// board with demo data (dev machines only — not needed to run the board).
//   npm run build && node scripts/screenshots.mjs
// Writes assets/screenshots/*.png. Uses the same Playwright setup as e2e/.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { makePdf } from '../e2e/fixtures/pdf.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? 'playwright');

const PORT = 18096;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = 'assets/screenshots';
const PASSWORD = 'screenshots-1';
mkdirSync(OUT, { recursive: true });

async function api(method, path, body, cookie) {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { r, body: text ? JSON.parse(text) : null, cookie: r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
}

const dir = mkdtempSync(join(tmpdir(), 'eb-shots-'));
const server = spawn(process.execPath, ['dist/app/server.mjs'], {
  env: { ...process.env, EB_DATA_DIR: dir, EB_PORT: String(PORT), EB_HOST: '127.0.0.1' },
  stdio: 'ignore',
});
process.on('exit', () => server.kill('SIGTERM'));
for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(BASE + '/api/health')).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

// first sign-in for the seeded team, demo jobs, a reviewer, and a changed PIN (so no banner nags)
for (const user_id of [1, 2, 3, 4]) await api('POST', '/api/session/password', { user_id, password: PASSWORD });
const s = await api('POST', '/api/session', { user_id: 1, password: PASSWORD });
const u = await api('POST', '/api/admin/unlock', { pin: '1234' }, s.cookie);
const admin = `${s.cookie}; ${u.cookie}`;
await api('POST', '/api/admin/demo', {}, admin);
const ebin = await api('POST', '/api/admin/users', { name: 'Ebin', role: 'reviewer' }, admin);
if (!ebin.body?.user) throw new Error(`could not add the reviewer: ${ebin.r.status} ${JSON.stringify(ebin.body)}`);
await api('POST', '/api/session/password', { user_id: ebin.body.user.id, password: PASSWORD });
await api('POST', '/api/admin/pin', { new_pin: '4821' }, admin);
const pumpSkid = (await api('GET', '/api/projects', undefined, s.cookie)).body.projects.find((p) => p.name === 'Pump skid').id;
// a file location on the bracket job, so its panel shows Copy and Go to location
{
  const list = await api('GET', '/api/tickets?q=Bracket%20redesign', undefined, s.cookie);
  const t = list.body.tickets.find((x) => x.title === 'Bracket redesign');
  await api('PATCH', `/api/tickets/${t.id}`, { version: t.version, file_location: '\\\\FILESERVER\\Projects\\P-1042\\CAD\\Motor bracket' }, s.cookie);
}

const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
const open = [];
async function page(name, { viewport = { width: 1800, height: 1000 }, theme, mobile } = {}) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: !!mobile, hasTouch: !!mobile });
  open.push(ctx);
  if (theme) await ctx.addInitScript((t) => localStorage.setItem('engineering-board-theme', t), theme);
  const p = await ctx.newPage();
  await p.goto(BASE + '/');
  if (name) {
    await p.click(`.who-option:has-text("${name}")`);
    await p.fill('input[name=password]', PASSWORD);
    await p.press('input[name=password]', 'Enter');
    await p.waitForSelector('.topbar');
  }
  return p;
}
const settle = (p, ms = 600) => p.waitForTimeout(ms);
const shot = (p, file, opts = {}) => p.screenshot({ path: `${OUT}/${file}.png`, ...opts });

// sign-in screen
{
  const p = await page(null);
  await p.waitForSelector('.who-option');
  await settle(p);
  await shot(p, 'sign-in');
}

// the board, a job panel, and the other pages as Paul (engineer)
{
  const p = await page('Paul');
  await p.waitForSelector('.card');
  await settle(p);
  await shot(p, 'board');
  await p.click('.card:has-text("Bracket redesign")');
  await p.waitForSelector('.panel');
  await settle(p);
  await shot(p, 'job-panel');
  await p.keyboard.press('Escape');
  await p.keyboard.press('n');
  await p.waitForSelector('#qc-title');
  await p.fill('#qc-title', 'Revise pump housing drawing to Rev D');
  await p.selectOption('#qc-project', { label: 'Pump skid' });
  await settle(p);
  await shot(p, 'new-job');
  await p.keyboard.press('Escape');
  for (const [path, file] of [['/projects?project=__PUMP__', 'projects'], ['/today', 'today'], ['/my-work', 'my-work'], ['/dashboard', 'dashboard'], ['/workload', 'workload'], ['/reports', 'reports'], ['/search?q=housing', 'search'], ['/activity', 'activity']]) {
    await p.goto(BASE + path.replace('__PUMP__', String(pumpSkid)));
    await p.waitForSelector('.topbar');
    await settle(p, 900);
    await shot(p, file);
  }
  // Tools: the sheet calculator with the workbook's own example and a second part, and its cutting layout
  await p.goto(BASE + '/tools');
  await p.waitForSelector('.tool-card');
  await p.click('.tool-card:has-text("Sheet calculator")');
  await p.waitForSelector('.sheet-table');
  await p.fill('input[aria-label="Component 1 name"]', 'Bracket');
  await p.selectOption('select[aria-label="Component 1 material"]', { label: 'Mild Steel' });
  await p.fill('input[aria-label="Component 1 length (mm)"]', '150');
  await p.fill('input[aria-label="Component 1 width (mm)"]', '100');
  await p.fill('input[aria-label="Component 1 quantity"]', '500');
  await p.waitForSelector('[data-testid=sheet-total]:has-text("3")');
  await p.click('button:has-text("+ Add component")');
  await p.waitForSelector('input[aria-label="Component 2 name"]');
  await p.fill('input[aria-label="Component 2 name"]', 'Cover plate');
  await p.selectOption('select[aria-label="Component 2 material"]', { label: 'Aluminium' });
  await p.fill('input[aria-label="Component 2 length (mm)"]', '600');
  await p.fill('input[aria-label="Component 2 width (mm)"]', '400');
  await p.fill('input[aria-label="Component 2 quantity"]', '24');
  await settle(p, 900);
  await shot(p, 'tools-sheet');
  await p.locator('button:has-text("Show cutting layout")').first().click();
  await p.waitForSelector('.sheet-svg');
  await p.fill('input[aria-label="Sheet number to view"]', '3');
  await p.waitForFunction(() => document.querySelectorAll('.sheet-svg .sheet-svg-part').length === 116);
  await p.locator('.sheet-layout').first().scrollIntoViewIfNeeded();
  await settle(p, 600);
  await p.locator('[data-testid=sheet-group]').first().screenshot({ path: `${OUT}/tools-layout.png` });
}

// notifications bell as Christin (urgent job, assignment, overdue reminders)
{
  const p = await page('Christin');
  await p.waitForSelector('.card');
  await p.click('.bell-btn');
  await p.waitForSelector('.bell-detail, .bell-item, .bell-list', { timeout: 5000 }).catch(() => {});
  await settle(p);
  await shot(p, 'notifications');
  await p.keyboard.press('Escape');
  // Admin → Team
  await p.evaluate(async () => fetch('/api/admin/unlock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '4821' }) }));
  await p.goto(BASE + '/admin');
  await p.waitForSelector('.topbar');
  await settle(p, 900);
  await shot(p, 'admin');
  // Admin → Roles (decision #31) and Admin → Tools (decision #32)
  for (const [section, file] of [['roles', 'admin-roles'], ['tools', 'admin-tools']]) {
    await p.goto(`${BASE}/admin?s=${section}`);
    await p.waitForSelector('.admin-body');
    await settle(p, 900);
    await shot(p, file);
  }
}

// drawing review: Christin submits a signed scan and two drawings, Ebin reviews
let jobId;
{
  const c = await page('Christin');
  jobId = await c.evaluate(async () => {
    // every new job belongs to a project (decision #30)
    const pr = await fetch('/api/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Telescope mount' }) });
    const project_id = (await pr.json()).project.id;
    const r = await fetch('/api/tickets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Revise mounting bracket for M10 fasteners', claim: true, priority: 'high', reference: 'BRK-023 Rev C', project_id }) });
    return (await r.json()).ticket.id;
  });
  await c.goto(`${BASE}/board?job=${jobId}`);
  await c.click('.panel-review button:has-text("Submit for board review")');
  await c.waitForSelector('.rw-submit');
  await c.setInputFiles('[data-testid=pick-reference]', { name: 'Telescope mount signed set.pdf', mimeType: 'application/pdf', buffer: makePdf(3, { labels: ['BRK-023 Rev B signed', 'ASM-010 Rev C signed', 'PLT-004 Rev A signed'] }) });
  await c.waitForSelector('.rw-file.done:has-text("3 pages")');
  await c.setInputFiles('[data-testid=pick-drawings]', [
    { name: 'BRK-023.pdf', mimeType: 'application/pdf', buffer: makePdf(1, { labels: ['BRK-023 Rev C'] }) },
    { name: 'SUP-011.pdf', mimeType: 'application/pdf', buffer: makePdf(1, { labels: ['SUP-011 Rev A'], compressed: true }) },
  ]);
  await c.waitForSelector('.rw-file.done:has-text("SUP-011")');
  await c.fill('textarea[aria-label="Notes for BRK-023.pdf"]', 'Mounting holes Ø8 → Ø10 for the revised fastener size; slot added for cable tie.');
  await c.selectOption('select[aria-label="Type of SUP-011.pdf"]', 'new');
  await c.fill('textarea[aria-label="Notes for SUP-011.pdf"]', 'New support plate, 6 mm, laser cut.');
  await settle(c);
  await c.click('[aria-label="Reviewers for these drawings"] label:has-text("Ebin")');
  await shot(c, 'review-submit');
  await c.click('button:has-text("Submit 2 drawings for board review")');
  await c.waitForSelector('.rw-item:has-text("SUP-011")');

  const e = await page('Ebin');
  await e.goto(`${BASE}/review/${jobId}`);
  await e.waitForSelector('.rw-item:has-text("BRK-023")');
  await e.fill('textarea[aria-label="Add a review comment"]', 'Please confirm clearance to the mating fastener head at the slot.');
  await e.click('button:has-text("Post comment")');
  await e.waitForSelector('.rw-comment');
  await e.click('.rw-item:has-text("SUP-011")');
  await e.waitForSelector('[data-testid=viewer-submitted] canvas[data-rendered]', { timeout: 20_000 });
  await e.click('button:has-text("Pass board review")');
  await e.waitForSelector('[data-testid=drawing-state]:has-text("Board review passed")');
  await e.click('.rw-item:has-text("BRK-023")');
  await e.waitForSelector('[data-testid=viewer-reference] canvas[data-rendered]', { timeout: 20_000 });
  await e.waitForSelector('[data-testid=viewer-submitted] canvas[data-rendered]', { timeout: 20_000 });
  await settle(e, 1200);
  await shot(e, 'review-workspace');
  await e.goto(`${BASE}/review`);
  await e.waitForSelector('.rv-table');
  await settle(e, 900);
  await shot(e, 'review-queue');
}

// themes
for (const theme of ['charcoal', 'midnight']) {
  const p = await page('Allen', { theme });
  await p.waitForSelector('.card');
  await settle(p);
  await shot(p, `board-${theme}`);
}

// phone
{
  const p = await page('Paul', { viewport: { width: 390, height: 844 }, mobile: true });
  await p.waitForSelector('.card');
  await settle(p);
  await shot(p, 'phone-board');
  await p.goto(BASE + '/today');
  await p.waitForSelector('.topbar');
  await settle(p, 900);
  await shot(p, 'phone-today');
}

while (open.length) await open.pop().close().catch(() => {});
await browser.close();
server.kill('SIGTERM');
rmSync(dir, { recursive: true, force: true });
console.log(`Screenshots written to ${OUT}/`);
