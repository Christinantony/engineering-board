import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { all, get, migrate, openDb, run, sqlite, SCHEMA_VERSION, type Db } from '../src/db/connection.ts';
import { undoMigrationsAfter } from './helpers.ts';
import { migrations } from '../src/db/migrations.ts';
import { restoreFrom, verifyDatabaseFile, type BackupCtx } from '../src/domain/backup.ts';
import { changePin, ensureAuthSettings, getSetting, readSession, sessionCookie, verifyPin } from '../src/domain/auth.ts';
import { EventHub } from '../src/lib/core.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'eb-restore-safety-'));
  const make = (name: string, title: string): BackupCtx => {
    const dbPath = join(dir, `${name}.db`);
    const db = openDb(dbPath);
    migrate(db);
    const ctx: BackupCtx = { db, dbPath, backupDir: join(dir, 'backups'), keepDays: 30,
      tz: 'Asia/Kolkata', now: () => new Date('2026-10-01T04:30:00Z'), events: new EventHub() };
    ensureAuthSettings(ctx);
    run(db, `INSERT INTO users(id,name,initials,color,created_at) VALUES (1,'Designer','D','#047857','2026-10-01')`);
    run(db, `INSERT INTO tickets(id,job_number,title,created_by,created_at,updated_at) VALUES (1,'JOB-1001',?,1,'2026-10-01','2026-10-01')`, title);
    run(db, `INSERT INTO activity(ticket_id,user_id,at,kind,body) VALUES (1,1,'2026-10-01','comment','Preserve this comment')`);
    run(db, `INSERT INTO idempotency(key,ticket_id,created_at) VALUES ('retry',1,'2026-10-01')`);
    return ctx;
  };
  const live = make('live', 'Live drawing');
  const source = make('source', 'Restored drawing');
  source.db.close();
  const editSource = (edit: (db: Db) => void) => {
    const db = openDb(source.dbPath);
    try { edit(db); } finally { db.close(); }
  };
  const snapshot = () => ['tickets','activity','users','settings','idempotency'].map(table => all(live.db, `SELECT * FROM ${table} ORDER BY 1`));
  const clean = () => {
    if (live.db.isOpen) live.db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  const assertNoTemporaryFiles = () => assert.deepEqual(readdirSync(dir).filter(name => name.includes('.restore-')), []);
  return { dir, live, source, editSource, snapshot, clean, assertNoTemporaryFiles };
}

describe('restore safety', () => {
  for (const table of ['settings', 'counters', 'user_state', 'imports']) {
    it(`rejects a healthy SQLite file missing ${table} before touching live state`, () => {
      const f = fixture();
      try {
        f.editSource(db => db.exec(`DROP TABLE ${table}`));
        const before = f.snapshot();
        const connection = f.live.db;
        assert.throws(() => restoreFrom(f.live, f.source.dbPath), /missing|required|backup/);
        assert.equal(f.live.db, connection);
        assert.deepEqual(f.snapshot(), before);
        f.assertNoTemporaryFiles();
      } finally { f.clean(); }
    });
  }

  for (const sql of [
    'DROP TRIGGER activity_no_update',
    'DROP INDEX idx_tickets_due',
    'DROP TABLE tickets_fts',
    'DELETE FROM schema_migrations WHERE id = 2',
    "ALTER TABLE settings RENAME COLUMN value TO missing_value",
    'PRAGMA foreign_keys = OFF; UPDATE tickets SET assigned_to = 999',
  ]) {
    it(`rejects incompatible or inconsistent data: ${sql}`, () => {
      const f = fixture();
      try {
        f.editSource(db => db.exec(sql));
        const before = f.snapshot();
        assert.throws(() => restoreFrom(f.live, f.source.dbPath), /backup|references|migration/);
        assert.deepEqual(f.snapshot(), before);
        f.assertNoTemporaryFiles();
      } finally { f.clean(); }
    });
  }

  it('rejects missing foreign-key declarations even when column metadata is unchanged', () => {
    const f = fixture();
    try {
      const alteredPath = join(f.dir, 'no-fk.db');
      const altered = openDb(alteredPath);
      try {
        altered.exec(get<{ sql: string }>(f.live.db, `SELECT sql FROM sqlite_master WHERE name = 'schema_migrations'`)!.sql);
        for (const migration of migrations) {
          altered.exec(migration.sql.replaceAll('REFERENCES users(id)', ''));
          run(altered, 'INSERT INTO schema_migrations VALUES (?, ?, ?)', migration.id, migration.name, '2026-10-01');
        }
      } finally { altered.close(); }
      const before = f.snapshot();
      assert.throws(() => restoreFrom(f.live, alteredPath), /incompatible.*tickets/);
      assert.deepEqual(f.snapshot(), before);
      f.assertNoTemporaryFiles();
    } finally { f.clean(); }
  });

  it('refuses a busy live checkpoint without closing or replacing the live database', t => {
    const f = fixture();
    try {
      const before = f.snapshot();
      const connection = f.live.db;
      const prepare = connection.prepare.bind(connection);
      t.mock.method(connection, 'prepare', (sql: string) => sql === 'PRAGMA wal_checkpoint(TRUNCATE)'
        ? { get: () => ({ busy: 1, log: 5, checkpointed: 4 }) }
        : prepare(sql));
      assert.throws(() => restoreFrom(f.live, f.source.dbPath), /database is busy/);
      assert.equal(f.live.db, connection);
      assert.deepEqual(f.snapshot(), before);
      f.assertNoTemporaryFiles();
    } finally { t.mock.restoreAll(); f.clean(); }
  });

  it('rejects a migration failure on the staged candidate without closing the live connection', () => {
    const f = fixture();
    try {
      f.editSource(db => { undoMigrationsAfter(db, 3); db.exec('DROP TABLE user_state; DELETE FROM schema_migrations WHERE id > 1'); });
      // An unexpected imports table is tolerated by structural verification of
      // v1, but causes the v3 CREATE TABLE to fail during staged migration.
      assert.equal(verifyDatabaseFile(f.source.dbPath).schema, 1);
      const before = f.snapshot();
      const connection = f.live.db;
      assert.throws(() => restoreFrom(f.live, f.source.dbPath), /could not be prepared.*imports/i);
      assert.equal(f.live.db, connection);
      assert.deepEqual(f.snapshot(), before);
      f.assertNoTemporaryFiles();
    } finally { f.clean(); }
  });

  it('migrates a v1 backup, rebuilds search and preserves the running PIN and cookies', () => {
    const f = fixture();
    try {
      f.editSource(db => undoMigrationsAfter(db, 1));
      const sourceBefore = verifyDatabaseFile(f.source.dbPath);
      changePin(f.live, '54321');
      const token = sessionCookie(f.live, 1);
      const secret = getSetting(f.live, 'cookie_secret');
      let reloads = 0;
      f.live.events.subscribe(e => { if (e.type === 'reload') reloads++; });
      const result = restoreFrom(f.live, f.source.dbPath);
      assert.equal(result.tickets, 1);
      assert.equal(get<{ title: string }>(f.live.db, 'SELECT title FROM tickets')!.title, 'Restored drawing');
      assert.equal(getSetting(f.live, 'cookie_secret'), secret);
      assert.equal(readSession(f.live, token), 1);
      assert.equal(verifyPin(f.live, '54321'), true);
      assert.equal(get<{ n: number }>(f.live.db, 'SELECT COUNT(*) n FROM idempotency')!.n, 0);
      assert.equal(get<{ n: number }>(f.live.db, `SELECT COUNT(*) n FROM tickets_fts WHERE tickets_fts MATCH '"Restored"'`)!.n, 1);
      assert.deepEqual(verifyDatabaseFile(f.source.dbPath), sourceBefore, 'source backup was not migrated or modified');
      assert.equal(verifyDatabaseFile(f.live.dbPath).schema, SCHEMA_VERSION);
      assert.equal(verifyDatabaseFile(join(f.live.backupDir, result.safety_backup)).tickets, 1);
      f.live.events.flush();
      assert.equal(reloads, 1);
      f.assertNoTemporaryFiles();
    } finally { f.clean(); }
  });

  for (const phase of ['opening the activated connection', 'checking activated integrity', 'reading activated settings', 'notifying clients']) {
    it(`rolls back all live state after failure ${phase}`, t => {
      const f = fixture();
      try {
        const before = f.snapshot();
        const token = sessionCookie(f.live, 1);
        let activating = false;
        let failed = false;
        let reloads = 0;
        const liveDb = f.live.db;
        const close = liveDb.close.bind(liveDb);
        t.mock.method(liveDb, 'close', () => { close(); activating = true; });
        const failOnce = () => { failed = true; throw new Error('Injected activation failure'); };
        if (phase === 'opening the activated connection') {
          const exec = sqlite().DatabaseSync.prototype.exec;
          t.mock.method(sqlite().DatabaseSync.prototype, 'exec', function(this: Db, sql: string) {
            if (activating && !failed && sql.includes('PRAGMA journal_mode')) failOnce();
            return exec.call(this, sql);
          });
        } else if (phase === 'reading activated settings' || phase === 'checking activated integrity') {
          const prepare = sqlite().DatabaseSync.prototype.prepare;
          t.mock.method(sqlite().DatabaseSync.prototype, 'prepare', function(this: Db, sql: string) {
            const target = phase === 'checking activated integrity' ? 'PRAGMA integrity_check' : 'SELECT value FROM settings WHERE key = ?';
            if (activating && !failed && sql === target) failOnce();
            return prepare.call(this, sql);
          });
        } else {
          t.mock.method(f.live.events, 'emit', failOnce);
        }
        f.live.events.subscribe(e => { if (e.type === 'reload') reloads++; });
        assert.throws(() => restoreFrom(f.live, f.source.dbPath), /Injected activation failure/);
        assert.equal(failed, true);
        assert.equal(f.live.db.isOpen, true);
        assert.notEqual(f.live.db, liveDb);
        assert.deepEqual(f.snapshot(), before, 'original tickets, history, settings and idempotency remain intact');
        assert.equal(readSession(f.live, token), 1);
        assert.equal(verifyPin(f.live, '1234'), true);
        run(f.live.db, `INSERT INTO settings(key,value) VALUES ('after_failure','working')`);
        assert.equal(getSetting(f.live, 'after_failure'), 'working', 'board can write after rollback');
        f.live.events.flush();
        assert.equal(reloads, 0);
        assert.equal(readdirSync(f.live.backupDir).filter(name => name.endsWith('-pre-restore.db')).length, 1);
        f.assertNoTemporaryFiles();
      } finally { t.mock.restoreAll(); f.clean(); }
    });
  }
});
