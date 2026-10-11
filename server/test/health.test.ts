// Host health (decision #34): the admin's view of the PC the board runs on.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type App } from '../src/app.ts';
import { sameDisk } from '../src/domain/health.ts';
import { Clock, Client, signIn, startHarness, type Harness } from './helpers.ts';

const check = (body: any, id: string) => body.checks.find((c: any) => c.id === id);

describe('host health', () => {
  let h: Harness;
  let admin: Client;
  before(async () => {
    h = await startHarness();
    admin = await h.as('Christin');
    await admin.post('/api/admin/unlock', { pin: '1234' });
  });
  after(() => h.close());

  it('is behind the admin PIN', async () => {
    const paul = await h.as('Paul');
    assert.equal((await paul.get('/api/admin/health')).status, 403);
    assert.equal((await new Client(h.base).get('/api/admin/health')).status, 401);
  });

  it('describes the host, the database and the backups', async () => {
    const r = await admin.get('/api/admin/health');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const b = r.body;
    assert.equal(b.host.version, (await admin.get('/api/health')).body.version);
    assert.equal(b.host.node, process.versions.node);
    assert.ok(b.host.name);
    assert.equal(b.database.path, h.dbPath);
    assert.ok(b.database.size > 0);
    assert.ok(b.database.schema >= 10);
    assert.equal(b.backups.dir, join(h.dir, 'backups'));
    assert.equal(b.backups.count, 0);
    assert.equal(b.review_files.count, 0);
    assert.ok(b.disks.database.total > 0, 'free space is read with fs.statfsSync');
    assert.deepEqual(b.checks.map((c: any) => c.id), ['backups', 'backup_disk', 'disk_space', 'database', 'admin_pin']);
    assert.equal(check(b, 'database').level, 'ok');
    assert.equal(check(b, 'backups').level, 'ok', 'an empty board needs no backup yet');
  });

  it('warns that backups next to the database share its disk', async () => {
    const b = (await admin.get('/api/admin/health')).body;
    assert.equal(b.disks.same_disk, true);
    assert.equal(check(b, 'backup_disk').level, 'warn');
    assert.match(check(b, 'backup_disk').detail, /backupDir/);
    assert.equal(b.level === 'ok', false);
  });

  it('flags a board with jobs and no backup, then clears it once one is made', async () => {
    await admin.create({ title: 'Needs a backup' });
    let b = (await admin.get('/api/admin/health')).body;
    assert.equal(check(b, 'backups').level, 'bad');
    assert.equal(b.level, 'bad');
    assert.equal((await admin.post('/api/admin/backups')).status, 201);
    b = (await admin.get('/api/admin/health')).body;
    assert.equal(check(b, 'backups').level, 'ok');
    assert.equal(b.backups.count, 1);
    assert.equal(b.backups.newest.kind, 'manual');
  });

  it('warns when the newest backup is more than three days old', async () => {
    h.clock.advance(4 * 86_400_000);
    await admin.post('/api/admin/unlock', { pin: '1234' }); // the unlock lasts 12 hours
    const b = (await admin.get('/api/admin/health')).body;
    assert.equal(check(b, 'backups').level, 'warn');
    assert.match(check(b, 'backups').title, /No backup for 4 days/);
    h.app.runMaintenance(); // the hourly check takes today's daily backup
    const after = (await admin.get('/api/admin/health')).body;
    assert.equal(check(after, 'backups').level, 'ok');
    assert.match(check(after, 'backups').title, /Today's backup is done/);
  });

  it('notices the admin PIN being changed', async () => {
    assert.equal(check((await admin.get('/api/admin/health')).body, 'admin_pin').level, 'warn');
    await admin.post('/api/admin/pin', { new_pin: '4821' });
    assert.equal(check((await admin.get('/api/admin/health')).body, 'admin_pin').level, 'ok');
    await admin.post('/api/admin/pin', { new_pin: '1234' });
  });
});

describe('host health: a failing daily backup', () => {
  let app: App;
  let dir: string;
  let base: string;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'eb-health-'));
    // a file where the backup folder should be: every backup fails
    writeFileSync(join(dir, 'not-a-folder'), 'x');
    app = createApp({ dbPath: join(dir, 'board.db'), tz: 'Asia/Kolkata', now: new Clock().now, backupDir: join(dir, 'not-a-folder', 'backups') });
    base = `http://127.0.0.1:${await app.listen(0, '127.0.0.1')}`;
  });
  after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports the failure until a backup works', async () => {
    const c = new Client(base);
    await signIn(c, 1);
    await c.post('/api/admin/unlock', { pin: '1234' });
    await c.create({ title: 'A job worth keeping' });
    app.runMaintenance();
    const b = (await c.get('/api/admin/health')).body;
    const backups = check(b, 'backups');
    assert.equal(backups.level, 'bad');
    assert.match(backups.title, /last daily backup failed/);
    assert.match(backups.detail, /Back up now/);
    assert.equal(b.level, 'bad');
  });
});

describe('sameDisk', () => {
  it('treats a network share as another disk, and one folder as the same disk', () => {
    const d = mkdtempSync(join(tmpdir(), 'eb-disk-'));
    try {
      assert.equal(sameDisk(d, join(d, 'backups', 'not-made-yet')), true);
      assert.equal(sameDisk(d, '\\\\fileserver\\board-backups'), false);
      assert.equal(sameDisk(d, '//fileserver/board-backups'), false);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
