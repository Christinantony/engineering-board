// Upgrade tests: a board that has been in use under an older schema must come
// up on the new version with every job, comment and history entry intact.
//
// The old databases are made realistically: real use through the API on the
// current version, then the file is taken back to schema N by undoing the
// migrations after N (every later migration only adds tables or recolours the
// original defaults, so this produces exactly what version N wrote).

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, migrate, all, get, run, SCHEMA_VERSION, pendingMigrations } from '../src/db/connection.ts';
import { migrations } from '../src/db/migrations.ts';
import { createApp } from '../src/app.ts';
import { startHarness, Client, type Harness } from './helpers.ts';

/** What undoes each migration, to rebuild the database an older version wrote. */
const UNDO: Record<number, string> = {
  2: 'DROP TABLE user_state;',
  3: 'DROP TABLE imports;',
  4: `UPDATE users SET color = '#059669' WHERE color = '#047857';
      UPDATE users SET color = '#d97706' WHERE color = '#b45309';`,
};

function downgrade(dbPath: string, to: number) {
  const db = openDb(dbPath);
  for (const id of Object.keys(UNDO).map(Number).sort((a, b) => b - a)) {
    if (id <= to) continue;
    db.exec(UNDO[id]);
    run(db, 'DELETE FROM schema_migrations WHERE id = ?', id);
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

interface Snapshot {
  tickets: { job_number: string; title: string; status: string; assigned_to: number | null; version: number }[];
  activity: number;
  comments: number;
  tags: string[];
  nextJob: string;
}

async function useTheBoard(h: Harness): Promise<void> {
  const christin = await h.as('Christin');
  const paul = await h.as('Paul');
  const a = await christin.create({ title: 'Bracket for pump skid', priority: 'high', estimate_minutes: 240, tags: ['skid', 'rev-b'] });
  const b = await paul.create({ title: 'Weldment drawing for frame', due_date: '2026-10-05' });
  await christin.create({ title: 'GA drawing check' });
  await paul.post(`/api/tickets/${a.id}/claim`, { version: a.version });
  await christin.post(`/api/tickets/${b.id}/comments`, { body: 'Use the 2024 frame standard.' });
  // people who picked their own colour keep it through the colour migration
  const admin = await h.as('Christin');
  await admin.post('/api/admin/unlock', { pin: '1234' });
  const users = (await admin.get('/api/users')).body.users;
  const allen = users.find((u: any) => u.name === 'Allen');
  const r = await admin.patch(`/api/admin/users/${allen.id}`, { color: '#123456' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

function snapshot(dbPath: string): Snapshot {
  const db = openDb(dbPath);
  try {
    return {
      tickets: all<any>(db, 'SELECT job_number, title, status, assigned_to, version FROM tickets ORDER BY id'),
      activity: get<{ n: number }>(db, 'SELECT COUNT(*) n FROM activity')!.n,
      comments: get<{ n: number }>(db, `SELECT COUNT(*) n FROM activity WHERE kind = 'comment'`)!.n,
      tags: all<{ name: string }>(db, 'SELECT name FROM tags ORDER BY name').map((r) => r.name),
      nextJob: String(get<{ value: number }>(db, `SELECT value FROM counters LIMIT 1`)?.value ?? ''),
    };
  } finally {
    db.close();
  }
}

describe('database upgrades', () => {
  const open: Harness[] = [];
  after(async () => {
    for (const h of open) await h.close().catch(() => {});
  });

  it('the migration list is numbered 1..N with no gaps, and SCHEMA_VERSION is N', () => {
    assert.deepEqual(
      migrations.map((m) => m.id),
      Array.from({ length: migrations.length }, (_, i) => i + 1),
    );
    assert.equal(SCHEMA_VERSION, migrations.length);
    // every migration after the first can be undone by this test, so a new one must add its undo here
    for (const m of migrations) if (m.id > 1) assert.ok(UNDO[m.id], `add an UNDO entry for migration ${m.id} in this test`);
  });

  for (let from = 1; from < SCHEMA_VERSION; from++) {
    it(`upgrades a board that was in use at schema version ${from}`, async () => {
      const h = await startHarness();
      open.push(h);
      await useTheBoard(h);
      await h.app.close();
      downgrade(h.dbPath, from);

      // the file really is at the old version
      const check = openDb(h.dbPath);
      assert.deepEqual(pendingMigrations(check), Array.from({ length: SCHEMA_VERSION - from }, (_, i) => from + i + 1));
      assert.equal(get(check, `SELECT 1 FROM sqlite_master WHERE name = 'imports'`) != null, from >= 3);
      check.close();
      const before = snapshot(h.dbPath);

      // start the current version on it
      await h.restart();
      const after = snapshot(h.dbPath);
      assert.deepEqual(after, before, 'jobs, history, tags and the job counter are unchanged');

      const db = openDb(h.dbPath);
      assert.deepEqual(pendingMigrations(db), []);
      for (const t of ['user_state', 'imports']) assert.ok(get(db, `SELECT 1 FROM sqlite_master WHERE name = ?`, t), `${t} exists`);
      const colours = Object.fromEntries(all<{ name: string; color: string }>(db, 'SELECT name, color FROM users').map((u) => [u.name, u.color]));
      assert.equal(colours.Jeffin, '#b45309', 'old default colour darkened');
      assert.equal(colours.Allen, '#123456', 'a colour someone picked is left alone');
      // history is still append-only after the upgrade
      assert.throws(() => db.exec(`UPDATE activity SET body = 'x'`), /append-only/);
      assert.throws(() => db.exec(`DELETE FROM tickets`), /cannot be deleted/);
      db.close();

      // a backup of the old data was taken before upgrading, and it is still at the old version
      const backups = readdirSync(join(h.dir, 'backups')).filter((n) => n.endsWith('-pre-upgrade.db'));
      assert.equal(backups.length, 1);
      const old = openDb(join(h.dir, 'backups', backups[0]));
      assert.equal(get<{ m: number }>(old, 'SELECT MAX(id) m FROM schema_migrations')!.m, from);
      old.close();

      // and the board works normally on the upgraded data
      const c = await h.as('Paul');
      const list = await c.get('/api/tickets');
      assert.equal(list.status, 200);
      assert.equal(list.body.tickets.length, before.tickets.length, 'board loads every job');
      const found = (await c.get('/api/tickets?q=weldment')).body;
      assert.equal(found.tickets[0]?.title, 'Weldment drawing for frame', 'search index still works');
      const fresh = await c.create({ title: 'New job after upgrade' });
      assert.ok(!before.tickets.some((t) => t.job_number === fresh.job_number), 'job numbers carry on, no reuse');
      assert.equal((await c.get('/api/notifications')).status, 200, 'notifications work (needs user_state)');

      // starting again does not upgrade or back up a second time
      await h.restart();
      assert.equal(readdirSync(join(h.dir, 'backups')).filter((n) => n.endsWith('-pre-upgrade.db')).length, 1);
    });
  }

  it('a brand-new board and an up-to-date board take no upgrade backup', async () => {
    const h = await startHarness();
    open.push(h);
    await (await h.as('Christin')).create({ title: 'x' });
    await h.restart();
    const names = (() => {
      try {
        return readdirSync(join(h.dir, 'backups'));
      } catch {
        return [];
      }
    })();
    assert.equal(names.filter((n) => n.includes('pre-upgrade')).length, 0);
  });

  it('restoring a backup made by an older version upgrades it', async () => {
    const src = await startHarness();
    open.push(src);
    await useTheBoard(src);
    await src.app.close();
    downgrade(src.dbPath, 1);
    const want = snapshot(src.dbPath).tickets.length;

    const h = await startHarness();
    open.push(h);
    const admin = await h.as('Christin');
    await admin.post('/api/admin/unlock', { pin: '1234' });
    const res = await fetch(`${h.base}/api/admin/restore/upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', cookie: [...admin.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: readFileSync(src.dbPath),
    });
    assert.equal(res.status, 200, await res.clone().text());
    const db = openDb(h.dbPath);
    assert.deepEqual(pendingMigrations(db), []);
    assert.equal(get<{ n: number }>(db, 'SELECT COUNT(*) n FROM tickets')!.n, want);
    db.close();
    assert.equal((await admin.get('/api/notifications')).status, 200);
  });

  it('refuses to start on data written by a newer version, without touching it', async () => {
    const h = await startHarness();
    open.push(h);
    await (await h.as('Christin')).create({ title: 'from the future' });
    await h.app.close();
    const db = openDb(h.dbPath);
    run(db, 'INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', SCHEMA_VERSION + 1, 'future', new Date().toISOString());
    db.close();
    const copy = `${h.dbPath}.copy`;
    copyFileSync(h.dbPath, copy);
    assert.throws(() => createApp({ dbPath: h.dbPath }), /newer version of the board/);
    const raw = openDb(copy);
    assert.throws(() => migrate(raw), /newer version of the board/);
    raw.close();
    // the refused file is exactly as it was: nothing was migrated or backed up
    assert.deepEqual(readFileSync(h.dbPath), readFileSync(copy));
    // put it back so close() can clean up normally
    const fix = openDb(h.dbPath);
    run(fix, 'DELETE FROM schema_migrations WHERE id > ?', SCHEMA_VERSION);
    fix.close();
    await h.restart();
    assert.equal((await new Client(h.base).get('/api/health')).status, 200);
  });
});
