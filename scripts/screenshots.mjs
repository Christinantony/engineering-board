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
// 1.7.0 sample data
const jobTypes = (await api('GET', '/api/job-types', undefined, s.cookie)).body.job_types;
const typeId = (name) => jobTypes.find((t) => t.name === name).id;
// jobs finished this week with their actual time, for the estimates report and the weekly summary
{
  const projects = (await api('GET', '/api/projects', undefined, s.cookie)).body.projects;
  const proj = (name) => projects.find((p) => p.name === name)?.id ?? projects[0].id;
  const as = async (id) => (await api('POST', '/api/session', { user_id: id, password: PASSWORD })).cookie;
  const people = { Christin: s.cookie, Paul: await as(2), Allen: await as(3) };
  const finished = [
    ['Paul', 'FEA', 'Pump skid', 'FEA on the pump base frame', 360, 410],
    ['Allen', 'FEA', 'Acme housing', 'Modal check of the housing lid', 360, 620],
    ['Christin', 'FEA', 'Control enclosure', 'Thermal check of the enclosure', 360, 330],
    ['Allen', 'Drawing', 'Pump skid', 'Inlet flange drawing', 90, 55],
    ['Paul', 'Drawing', 'Acme housing', 'Gasket drawing', 90, 110],
    ['Christin', 'CAD Modification', 'Control enclosure', 'Cable gland holes', 180, 200],
    ['Paul', 'CAD Modification', 'Pump skid', 'Lifting lug position', 180, 420],
  ];
  for (const [who, type, project, title, est, act] of finished) {
    const c = people[who];
    const t = (await api('POST', '/api/tickets', { title, claim: true, job_type_id: typeId(type), estimate_minutes: est, project_id: proj(project) }, c)).body.ticket;
    const done = (await api('POST', `/api/tickets/${t.id}/move`, { status: 'done' }, c)).body.ticket;
    await api('PATCH', `/api/tickets/${t.id}`, { version: done.version, actual_minutes: act }, c);
  }
}
// a release checklist on CAD Modification (the bracket job's type; two items ticked below), after the finished jobs
const checklistIds = [];
for (const text of ['Model rebuilt without errors', 'Mass properties checked', 'Drawing views updated', 'Change noted in the revision table'])
  checklistIds.push((await api('POST', `/api/admin/job-types/${typeId('CAD Modification')}/checklist`, { text }, admin)).body.item.id);
for (const text of ['Title block filled in', 'Revision table updated', 'Tolerances and finish specified'])
  await api('POST', `/api/admin/job-types/${typeId('Drawing Revision')}/checklist`, { text }, admin);
// a procurement list on a new project, from the team's inventory workbook
let procurementProject;
{
  procurementProject = (await api('POST', '/api/projects', { name: 'Spiral array 3 inch' }, s.cookie)).body.project.id;
  const items = [
    ['Spiral antenna element', 'RF', 'Single Antenna', 'outsourced', 'Ø76 mm, 2–18 GHz', 5, 'pcs', true, 'PO 4512'],
    ['Balun', 'RF', 'Single Antenna', 'outsourced', 'Tapered microstrip, 0.8 mm RO4003', 5, 'pcs', false, 'PO 4513, due 20 Oct'],
    ['SMA cable', 'RF', 'Array', 'bought_out', '300 mm, RG-402', 5, 'pcs', true, ''],
    ['Power divider 1:5', 'RF', 'Array', 'bought_out', '2–18 GHz', 1, 'pcs', false, 'Quote requested'],
    ['Torque wrench, SMA', 'RF', 'Tool', 'tools', '8 in-lb', 1, 'pcs', true, ''],
    ['Mounting plate', 'Mechanical', 'Array', 'in_house', '6 mm Al 6061, 400 × 400', 1, 'pcs', false, 'In the CNC queue'],
    ['Cavity backing', 'Mechanical', 'Single Antenna', 'in_house', 'Ø80 × 40 mm, Al', 5, 'pcs', true, ''],
    ['M3 × 8 screws', 'Mechanical', 'Array', 'bought_out', 'A2 stainless, DIN 912', 40, 'pcs', true, ''],
    ['Alignment jig', 'Mechanical', 'Tool', 'tools', 'Printed PLA', 1, 'set', false, ''],
  ];
  for (const [name, discipline, category, means, spec, quantity, unit, inStock, notes] of items) {
    const it = (await api('POST', `/api/projects/${procurementProject}/procurement/items`, { name, discipline, category, means, spec, quantity, unit, notes }, s.cookie)).body.item;
    if (inStock) await api('POST', `/api/procurement/items/${it.id}/stock`, { in_stock: true }, s.cookie);
  }
}
// a file location on the bracket job, so its panel shows Copy and Go to location
{
  const list = await api('GET', '/api/tickets?q=Bracket%20redesign', undefined, s.cookie);
  const t = list.body.tickets.find((x) => x.title === 'Bracket redesign');
  await api('PATCH', `/api/tickets/${t.id}`, { version: t.version, file_location: '\\\\FILESERVER\\Projects\\P-1042\\CAD\\Motor bracket' }, s.cookie);
  // two of its checklist items ticked by its owner
  const owner = (await api('POST', '/api/session', { user_id: t.assigned_to, password: PASSWORD })).cookie;
  for (const item_id of checklistIds.slice(0, 2)) await api('PUT', `/api/tickets/${t.id}/checklist`, { item_id, checked: true }, owner);
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
  // PDF tools: the stamp with its live preview
  await p.goto(BASE + '/tools?tool=pdf');
  await p.waitForSelector('.pdf-tabs a.on:has-text("Stamp")');
  await p.setInputFiles('[data-testid=pick-stamp]', [
    { name: 'BRK-023 Rev C.pdf', mimeType: 'application/pdf', buffer: makePdf(1, { labels: ['BRK-023 Rev C'] }) },
    { name: 'SUP-011 Rev A.pdf', mimeType: 'application/pdf', buffer: makePdf(1, { labels: ['SUP-011 Rev A'] }) },
  ]);
  await p.waitForSelector('[data-testid=stamp-preview][data-state=ready]', { timeout: 20_000 });
  // moved down so the whole stamp shows on this landscape sheet (the script's default starts 40% down)
  await p.fill('input[aria-label="Down value"]', '72');
  await p.waitForSelector('[data-testid=stamp-preview][data-state=ready]', { timeout: 20_000 });
  await settle(p, 1200);
  await shot(p, 'tools-pdf');
  // 1.7.0: estimates against actual time, the weekly summary, the procurement tracker
  await p.goto(BASE + '/reports?r=week');
  await p.waitForSelector('[data-testid=estimate-accuracy] .accuracy-table');
  await settle(p, 600);
  await p.locator('[data-testid=estimate-accuracy]').screenshot({ path: `${OUT}/reports-estimates.png` });
  await p.goto(BASE + '/reports/weekly');
  await p.waitForSelector('[data-testid=weekly-sheet]');
  await settle(p, 900);
  await shot(p, 'weekly-summary');
  await p.goto(`${BASE}/projects/procurement?project=${procurementProject}`);
  await p.waitForSelector('[data-testid=master-list]');
  await settle(p, 900);
  await shot(p, 'procurement');
  await p.goto(`${BASE}/projects/procurement?project=${procurementProject}&tab=checklist`);
  await p.waitForSelector('[data-testid=proc-ready]');
  await settle(p, 900);
  await shot(p, 'procurement-checklist');
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
  // a backup first, as the daily one would have been, so Health shows a board in use
  await p.evaluate(async () => fetch('/api/admin/backups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
  for (const [section, file] of [['roles', 'admin-roles'], ['tools', 'admin-tools'], ['health', 'admin-health']]) {
    await p.goto(`${BASE}/admin?s=${section}`);
    await p.waitForSelector('.admin-body');
    await settle(p, 900);
    await shot(p, file);
  }
  // 1.7.0: a job type's release checklist
  await p.goto(`${BASE}/admin?s=job-types`);
  await p.click('.admin-list li:has(input[value="CAD Modification"]) button:has-text("Checklist")');
  await p.waitForSelector('[data-testid="checklist-editor-CAD Modification"]');
  await settle(p, 600);
  await shot(p, 'admin-checklists');
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
  await c.fill('input[aria-label="Revision of BRK-023.pdf"]', 'C');
  await c.fill('input[aria-label="Revision of SUP-011.pdf"]', 'A');
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
  // SUP-011 passed: Christin hands the print over and Ebin records the signature, so the register has a signed revision
  const sup = (await api('GET', `/api/tickets/${jobId}/review`, undefined, s.cookie)).body.drawings.find((d) => d.identifier === 'SUP-011');
  await api('POST', `/api/review/drawings/${sup.id}/handover`, {}, s.cookie);
  const ebinCookie = (await api('POST', '/api/session', { user_id: ebin.body.user.id, password: PASSWORD })).cookie;
  await api('POST', `/api/review/drawings/${sup.id}/signed`, {}, ebinCookie);
  await c.goto(`${BASE}/review/register?drawing=SUP-011`);
  await c.waitForSelector('.reg-history .reg-entry');
  await settle(c, 900);
  await shot(c, 'drawing-register');
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
