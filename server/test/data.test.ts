import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startHarness, type Harness, type Client } from './helpers.ts';
import { parseCsv, toCsv } from '../src/lib/csv.ts';
import { mapHeaders, parseDate, parseEstimate, parsePriority, parseStatus } from '../src/domain/transfer.ts';
import { dailyBackupDue, runDailyBackupIfDue, pruneBackups, listBackups } from '../src/domain/backup.ts';

describe('unit: CSV and import parsing', () => {
  it('reads what Excel writes: BOM, CRLF, quotes, multi-line cells, semicolons', () => {
    const text = '﻿title;notes\r\n"Pump; housing";"line 1\r\nline 2 with ""quotes"""\r\n\r\nBracket;\r\n';
    assert.deepEqual(parseCsv(text), [
      ['title', 'notes'],
      ['Pump; housing', 'line 1\r\nline 2 with "quotes"'],
      ['Bracket', ''],
    ]);
  });
  it('writes CSV that round-trips and is safe to open in Excel', () => {
    const out = toCsv([['a', 'b'], ['x, y', '=SUM(A1)'], ['multi\nline', '"q"']]);
    assert.ok(out.startsWith('﻿'));
    assert.deepEqual(parseCsv(out), [['a', 'b'], ['x, y', "'=SUM(A1)"], ['multi\nline', '"q"']]);
  });
  it('understands the ways people write dates, estimates, priorities and statuses', () => {
    assert.equal(parseDate('02/10/2026'), '2026-10-02'); // day first (India)
    assert.equal(parseDate('02/10/2026', 'MDY'), '2026-02-10');
    assert.equal(parseDate('2026-10-02'), '2026-10-02');
    assert.equal(parseDate('2 Oct 2026'), '2026-10-02');
    assert.equal(parseDate('Oct 2, 2026'), '2026-10-02');
    assert.equal(parseDate('2.10.26'), '2026-10-02');
    assert.equal(parseDate('46297'), '2026-10-02'); // Excel serial
    assert.equal(parseDate('31/02/2026'), null);
    assert.equal(parseDate('soon'), null);
    assert.equal(parseEstimate('120'), 120);
    assert.equal(parseEstimate('2h'), 120);
    assert.equal(parseEstimate('1.5 hr'), 90);
    assert.equal(parseEstimate('2 days'), 960);
    assert.equal(parseEstimate('1–2 hr'), 90);
    assert.equal(parseEstimate('a while'), 'invalid');
    assert.equal(parsePriority('HIGH'), 'high');
    assert.equal(parsePriority('P1'), 'urgent');
    assert.equal(parsePriority('medium'), 'normal');
    assert.equal(parseStatus('In Progress'), 'in_progress');
    assert.equal(parseStatus('On hold'), 'waiting');
    assert.deepEqual(mapHeaders(['Job', 'Assigned To', 'Due Date', 'Est', 'Drawing No', 'Whatever']), ['title', 'assignee', 'due_date', 'estimate', 'reference', null]);
  });
});

describe('export, import, backup and restore', () => {
  let h: Harness;
  let christin: Client, jeffin: Client;
  before(async () => {
    h = await startHarness();
    [christin, jeffin] = await Promise.all(['Christin', 'Jeffin'].map((n) => h.as(n)));
    await christin.post('/api/admin/unlock', { pin: '1234' });
  });
  after(() => h.close());

  const raw = async (c: Client, method: string, path: string, body?: string | Buffer, type = 'text/csv') => {
    const res = await fetch(h.base + path, {
      method,
      headers: { 'content-type': type, cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: body as any,
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, text, json, headers: res.headers };
  };

  it('exports CSV with every job, readable by Excel, honouring filters', async () => {
    await christin.create({ title: 'Export me, please', notes: 'line 1\nline 2', tags: ['STEP'], claim: true, estimate_minutes: 90, priority: 'high' });
    await jeffin.create({ title: 'Low one', priority: 'low' });
    const r = await raw(christin, 'GET', '/api/export/tickets.csv');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition')!, /attachment; filename="engineering-board-jobs-2026-10-01\.csv"/);
    const rows = parseCsv(r.text);
    assert.equal(rows[0][0], 'job_number');
    const row = rows.find((x) => x[1] === 'Export me, please')!;
    const col = (n: string) => row[rows[0].indexOf(n)];
    assert.equal(col('assignee'), 'Christin');
    assert.equal(col('notes'), 'line 1\nline 2');
    assert.equal(col('tags'), 'STEP');
    assert.equal(col('created_at'), '2026-10-01 10:00'); // local time
    const high = parseCsv((await raw(christin, 'GET', '/api/export/tickets.csv?priority=high')).text);
    assert.equal(high.length, 2);
  });

  it('exports JSON with history', async () => {
    const r = await raw(christin, 'GET', '/api/export/tickets.json');
    assert.equal(r.json.format, 'engineering-board-export');
    const t = r.json.tickets.find((x: any) => x.title === 'Export me, please');
    assert.equal(t.assignee, 'Christin');
    assert.ok(t.activity.some((a: any) => a.kind === 'claimed' && a.by === 'Christin'));
  });

  const sheet = [
    'Job,Details,Priority,Assigned To,Due Date,Est,Requested By,Type,Tags,Drawing No,Status',
    'Pump drawing revision,Update holes,HIGH,Paul,02/10/2026,120,Quality,Drawing Revision,customer-A,DWG-4410,',
    'STEP cleanup,Repair imported geometry,NORMAL,,03/10/2026,1 hr,Production,Reverse Engineering,,,',
    'Old finished thing,,low,Allen,,,,,,,Done',
    'Waiting one,,,Allen,,,,,,,On hold',
    ',missing title,,,,,,,,,',
    'Bad date,,,,31/02/2026,,,,,,',
    'Unknown person,,urgent,Zara,,,,,,,',
  ].join('\r\n');

  it('previews an import: maps columns, explains every problem, creates nothing', async () => {
    const before = (await christin.get('/api/tickets?archived=include')).body.total;
    const r = await raw(christin, 'POST', '/api/admin/import/preview?filename=jobs.csv', sheet);
    assert.equal(r.status, 200, r.text);
    const p = r.json;
    assert.deepEqual(p.counts, { total: 7, valid: 5, with_errors: 2, with_warnings: 1 });
    assert.deepEqual(p.new_job_types, ['Reverse Engineering']);
    const first = p.rows[0];
    assert.equal(first.assignee, 'Paul');
    assert.equal(first.due_date, '2026-10-02');
    assert.equal(first.status, 'claimed');
    assert.equal(p.rows[1].estimate_minutes, 60);
    assert.equal(p.rows[2].status, 'done');
    assert.equal(p.rows[3].status, 'waiting');
    assert.deepEqual(p.rows[4].errors, ['No title']);
    assert.match(p.rows[5].errors[0], /isn't a date/);
    assert.match(p.rows[6].warnings[0], /Nobody called "Zara"/);
    assert.equal((await christin.get('/api/tickets?archived=include')).body.total, before);
    // only admins can import
    assert.equal((await raw(jeffin, 'POST', '/api/admin/import/preview', sheet)).status, 403);
  });

  it('refuses to import rows with errors unless told to skip them; then imports atomically with a backup first', async () => {
    const blocked = await raw(christin, 'POST', '/api/admin/import/commit?filename=jobs.csv', sheet);
    assert.equal(blocked.status, 400);
    const backupsBefore = listBackups(h.app.ctx).length;
    const r = await raw(christin, 'POST', '/api/admin/import/commit?filename=jobs.csv&skip_invalid=1', sheet);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.created, 5);
    assert.equal(r.json.skipped, 2);
    assert.equal(listBackups(h.app.ctx).length, backupsBefore + 1);
    assert.ok(listBackups(h.app.ctx).some((b) => b.kind === 'pre-import'));
    const pump = (await christin.get('/api/tickets?q=Pump%20drawing%20revision')).body.tickets[0];
    assert.equal(pump.priority, 'high');
    assert.equal(pump.due_date, '2026-10-02');
    assert.equal(pump.status, 'claimed');
    assert.equal(pump.reference, 'DWG-4410');
    const hist = (await christin.get(`/api/tickets/${pump.id}`)).body.activity;
    assert.ok(hist.some((a: any) => a.kind === 'imported' && /jobs\.csv, line 2/.test(a.body)));
    const done = (await christin.get('/api/tickets?q=Old%20finished')).body.tickets[0];
    assert.equal(done.status, 'done');
    const waiting = (await christin.get('/api/tickets?q=Waiting%20one')).body.tickets[0];
    assert.equal(waiting.status, 'waiting');
    assert.ok((await christin.get('/api/job-types')).body.job_types.some((j: any) => j.name === 'Reverse Engineering'));
  });

  it('warns before importing the same file twice', async () => {
    const p = await raw(christin, 'POST', '/api/admin/import/preview', sheet);
    assert.ok(p.json.already_imported);
    const again = await raw(christin, 'POST', '/api/admin/import/commit?skip_invalid=1', sheet);
    assert.equal(again.status, 409);
  });

  it('takes a manual backup that is a complete, openable database', async () => {
    const r = await christin.post('/api/admin/backups');
    assert.equal(r.status, 201);
    const name = r.body.backup.name;
    assert.match(name, /^board-2026-10-01_\d{6}-manual\.db$/);
    const dl = await fetch(`${h.base}/api/admin/backups/${name}`, { headers: { cookie: [...christin.cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
    const buf = Buffer.from(await dl.arrayBuffer());
    assert.equal(buf.subarray(0, 15).toString(), 'SQLite format 3');
    // traversal attempts are rejected
    assert.equal((await christin.get('/api/admin/backups/..%2Fboard.db')).status, 400);
  });

  it('restores from a backup: data goes back, a safety backup is made, nobody is signed out', async () => {
    const backup = (await christin.post('/api/admin/backups')).body.backup.name;
    const count = (await christin.get('/api/tickets?archived=include')).body.total;
    await christin.create({ title: 'Made after the backup' });
    assert.equal((await christin.get('/api/tickets?archived=include')).body.total, count + 1);

    const r = await christin.post('/api/admin/restore', { name: backup });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(r.body.safety_backup, /pre-restore/);
    // same browser session still works, and admin is still unlocked
    assert.equal((await christin.get('/api/tickets?archived=include')).body.total, count);
    assert.equal((await christin.get('/api/admin/status')).body.unlocked, true);
    assert.equal((await christin.get('/api/tickets?q=Made%20after')).body.total, 0, 'search index rebuilt');
    // and the safety backup brings the newer job back
    await christin.post('/api/admin/restore', { name: r.body.safety_backup });
    assert.equal((await christin.get('/api/tickets?q=Made%20after')).body.total, 1);
  });

  it('restores from an uploaded file, and rejects files that are not board backups', async () => {
    const name = (await christin.post('/api/admin/backups')).body.backup.name;
    const file = readFileSync(join(h.app.ctx.backupDir, name));
    const ok = await raw(christin, 'POST', '/api/admin/restore/upload', file, 'application/octet-stream');
    assert.equal(ok.status, 200, ok.text);
    const junk = await raw(christin, 'POST', '/api/admin/restore/upload', Buffer.from('hello world, not a database'), 'application/octet-stream');
    assert.equal(junk.status, 400);
    assert.match(junk.json.message, /isn't a board backup/);
    // a valid SQLite file that isn't ours
    const { DatabaseSync } = await import('node:sqlite');
    const other = join(h.dir, 'other.db');
    const d = new DatabaseSync(other);
    d.exec('CREATE TABLE x (a)');
    d.close();
    const foreign = await raw(christin, 'POST', '/api/admin/restore/upload', readFileSync(other), 'application/octet-stream');
    assert.equal(foreign.status, 400);
    assert.match(foreign.json.message, /isn't an Engineering Board backup/);
    // the live board is untouched after the rejected uploads
    assert.equal((await christin.get('/api/tickets?q=Made%20after')).body.total, 1);
    // binary uploads are only accepted on the restore route
    assert.equal((await raw(christin, 'POST', '/api/tickets', Buffer.from('x'), 'application/octet-stream')).status, 415);
  });

  it('daily backup runs once a day, skips an empty board, and old backups are pruned (keeping the newest few)', () => {
    const ctx = h.app.ctx;
    ctx.db.exec("DELETE FROM settings WHERE key = 'last_daily_backup'");
    assert.equal(dailyBackupDue(ctx), true);
    assert.ok(runDailyBackupIfDue(ctx));
    assert.equal(runDailyBackupIfDue(ctx), null, 'only once per day');
    // make some ancient backups and prune
    for (let i = 1; i <= 10; i++) writeFileSync(join(ctx.backupDir, `board-2025-01-${String(i).padStart(2, '0')}_010000-daily.db`), 'x');
    const removed = pruneBackups(ctx);
    assert.ok(removed.length > 0);
    assert.ok(listBackups(ctx).length >= 7);
    assert.ok(!existsSync(join(ctx.backupDir, 'board-2025-01-01_010000-daily.db')));
    assert.ok(readdirSync(ctx.backupDir).every((n) => !n.endsWith('.partial')));
  });

  it('bulk-archives old finished jobs and tidies tags', async () => {
    const t = await christin.create({ title: 'Finished long ago', claim: true, tags: ['old-tag'] });
    await christin.post(`/api/tickets/${t.id}/move`, { status: 'done' });
    h.clock.advance(40 * 86_400_000);
    await christin.post('/api/admin/unlock', { pin: '1234' }); // the 12-hour admin unlock has expired
    const r = await christin.post('/api/admin/archive-old', { days: 30 });
    assert.ok(r.body.archived >= 1);
    assert.equal((await christin.get(`/api/tickets/${t.id}`)).body.ticket.archived, true);
    const tags = (await christin.get('/api/admin/tags')).body.tags;
    const old = tags.find((g: any) => g.name === 'old-tag');
    const step = tags.find((g: any) => g.name === 'STEP');
    assert.equal((await christin.del(`/api/admin/tags/${old.id}`)).status, 409, 'in use');
    const merged = await christin.patch(`/api/admin/tags/${old.id}`, { name: 'STEP' });
    assert.equal(merged.body.merged, true);
    assert.deepEqual((await christin.get(`/api/tickets/${t.id}`)).body.ticket.tags, ['STEP']);
    assert.equal((await christin.get('/api/tickets?q=old-tag')).body.total, 0);
    void step;
  });
});
