// Backups and restore.
//
// A backup is a complete, self-contained copy of the database made with
// SQLite's `VACUUM INTO`. It is consistent even while people are using the
// board, and it opens in any SQLite tool. Backups are plain .db files in the
// backup folder (default data/backups; can point at a network share or a
// OneDrive folder in config.json).
//
// Automatic backups: one per day, the first time the server is running that
// day (the host is a workstation that may be off at night), plus one before
// every restore and every CSV import, and before a new version of the board
// upgrades the database schema.
//
// Drawing-review PDFs are files next to the database (data/review-files). Each
// backup copies any it doesn't have yet into <backupDir>/review-files and lists
// the ones it needs in "<backup>.review-files.txt"; a restore puts back any
// listed file missing from the live folder.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { all, get, migrate, openDb, run, sqlite, type Db } from '../db/connection.ts';
import { migrations } from '../db/migrations.ts';
import { HttpError, badRequest, type Ctx } from '../lib/core.ts';
import { localDate } from '../lib/time.ts';
import { ensureAuthSettings, getSetting, setSetting } from './auth.ts';
import { rebuildIndex } from './search.ts';
import { backupReviewFiles, manifestFor, pruneBackupStore, restoreReviewFiles } from './reviewStore.ts';

export type BackupKind = 'daily' | 'manual' | 'pre-restore' | 'pre-import' | 'pre-upgrade' | 'shutdown';
export const BACKUP_RE = /^board-(\d{4}-\d{2}-\d{2})_(\d{6})-(daily|manual|pre-restore|pre-import|pre-upgrade|shutdown)\.db$/;
const KEEP_AT_LEAST = 7;

export interface BackupInfo {
  name: string;
  kind: BackupKind;
  size: number;
  created_at: string;
}

export interface BackupCtx extends Ctx {
  dbPath: string;
  backupDir: string;
  keepDays: number;
}

function stamp(ctx: Ctx): string {
  // local wall-clock time in the file name, so it reads naturally in Explorer
  const ms = ctx.now().getTime();
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: ctx.tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return `${localDate(ms, ctx.tz)}_${p.hour}${p.minute}${p.second}`;
}

export function listBackups(ctx: BackupCtx): BackupInfo[] {
  if (!existsSync(ctx.backupDir)) return [];
  return readdirSync(ctx.backupDir)
    .filter((n) => BACKUP_RE.test(n))
    .map((name) => {
      const st = statSync(join(ctx.backupDir, name));
      return { name, kind: BACKUP_RE.exec(name)![3] as BackupKind, size: st.size, created_at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

/** Make a backup now. Returns its info. Synchronous: the copy takes milliseconds for this size of database. */
export function backupNow(ctx: BackupCtx, kind: BackupKind): BackupInfo {
  mkdirSync(ctx.backupDir, { recursive: true });
  let name = `board-${stamp(ctx)}-${kind}.db`;
  for (let i = 1; existsSync(join(ctx.backupDir, name)); i++) {
    // two backups in the same second: nudge the seconds field
    const s = stamp(ctx).replace(/(\d{2})$/, (m) => String((Number(m) + i) % 60).padStart(2, '0'));
    name = `board-${s}-${kind}.db`;
  }
  const target = join(ctx.backupDir, name);
  const tmp = `${target}.partial`;
  rmSync(tmp, { force: true });
  ctx.db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  verifyDatabaseFile(tmp); // never keep a backup we couldn't restore from
  renameSync(tmp, target);
  // drawing-review PDFs live next to the database, not in it: copy them too
  backupReviewFiles(ctx, ctx.backupDir, target);
  if (kind === 'daily') setSetting(ctx, 'last_daily_backup', localDate(ctx.now().getTime(), ctx.tz));
  const st = statSync(target);
  return { name, kind, size: st.size, created_at: st.mtime.toISOString() };
}

/**
 * Delete backups older than keepDays, but always keep the newest few of any
 * kind, so a long holiday never leaves you with nothing.
 */
export function pruneBackups(ctx: BackupCtx): string[] {
  const list = listBackups(ctx);
  const cutoff = ctx.now().getTime() - ctx.keepDays * 86_400_000;
  const removed: string[] = [];
  list.forEach((b, i) => {
    if (i < KEEP_AT_LEAST) return;
    const date = BACKUP_RE.exec(b.name)![1];
    if (Date.parse(`${date}T23:59:59Z`) < cutoff) {
      rmSync(join(ctx.backupDir, b.name), { force: true });
      rmSync(manifestFor(join(ctx.backupDir, b.name)), { force: true });
      removed.push(b.name);
    }
  });
  // review PDFs no remaining backup needs (intermediates kept until their backups expire)
  pruneBackupStore(ctx.backupDir, (name) => BACKUP_RE.test(name));
  return removed;
}

/** True if today's automatic backup hasn't been made yet. */
export function dailyBackupDue(ctx: Ctx): boolean {
  return getSetting(ctx, 'last_daily_backup') !== localDate(ctx.now().getTime(), ctx.tz);
}

export function runDailyBackupIfDue(ctx: BackupCtx): BackupInfo | null {
  if (!dailyBackupDue(ctx)) return null;
  // skip an empty board: nothing worth keeping yet
  if (get<{ n: number }>(ctx.db, 'SELECT COUNT(*) n FROM tickets')!.n === 0) return null;
  const info = backupNow(ctx, 'daily');
  pruneBackups(ctx);
  return info;
}

export function backupPath(ctx: BackupCtx, name: string): string {
  if (!BACKUP_RE.test(name)) throw badRequest('Not a backup file name');
  const p = join(ctx.backupDir, basename(name));
  if (!existsSync(p)) throw new HttpError(404, 'not_found', 'That backup no longer exists');
  return p;
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/** Open a candidate database read-only and check it really is an Engineering Board database. */
export function verifyDatabaseFile(path: string): { tickets: number; activity: number; schema: number } {
  let db: Db | undefined;
  let reference: Db | undefined;
  try {
    db = new (sqlite().DatabaseSync)(path, { readOnly: true });
    const ok = (db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
    if (ok !== 'ok') throw badRequest(`That file is damaged (${ok}).`);
    const tables = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name),
    );
    for (const t of ['tickets', 'activity', 'users', 'schema_migrations'])
      if (!tables.has(t)) throw badRequest(`That isn't an Engineering Board backup (no "${t}" table).`);
    const schema = (db.prepare('SELECT MAX(id) m FROM schema_migrations').get() as { m: number }).m ?? 0;
    const newest = Math.max(...migrations.map((m) => m.id));
    if (schema > newest)
      throw badRequest('That backup was made by a newer version of the board. Update the board first, then restore it.');
    const applied = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all() as { id: number }[];
    if (!schema || applied.length !== schema || applied.some((m, i) => m.id !== i + 1))
      throw badRequest('That backup has an incomplete database migration history.');

    // Validate against the schema this version actually wrote, including older
    // versions used by pre-upgrade backups. SQLite integrity alone accepts a
    // perfectly healthy database with essential application tables missing.
    reference = new (sqlite().DatabaseSync)(':memory:');
    reference.exec(`CREATE TABLE schema_migrations (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    for (const migration of migrations) if (migration.id <= schema) reference.exec(migration.sql);
    const objects = reference.prepare(`SELECT name, type, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'`).all() as
      { name: string; type: string; sql: string | null }[];
    const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
    const normalize = (sql: string | null) => sql?.replace(/\s+/g, ' ').trim();
    for (const expected of objects) {
      const actual = db.prepare('SELECT type, sql FROM sqlite_master WHERE name = ?').get(expected.name) as
        { type: string; sql: string | null } | undefined;
      if (!actual || actual.type !== expected.type)
        throw badRequest(`That backup is missing a required ${expected.type}: "${expected.name}".`);
      if (expected.type === 'table') {
        const columns = (connection: Db) => connection.prepare(`PRAGMA table_info(${quote(expected.name)})`).all();
        // Column metadata alone omits CHECK and foreign-key declarations.
        // Official backups retain the CREATE SQL from these migrations.
        if (JSON.stringify(columns(db)) !== JSON.stringify(columns(reference)) || normalize(actual.sql) !== normalize(expected.sql))
          throw badRequest(`That backup has an incompatible "${expected.name}" table.`);
      } else if (normalize(actual.sql) !== normalize(expected.sql)) {
        throw badRequest(`That backup has an incompatible ${expected.type}: "${expected.name}".`);
      }
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length)
      throw badRequest('That backup contains broken database references.');
    const tickets = (db.prepare('SELECT COUNT(*) n FROM tickets').get() as { n: number }).n;
    const activity = (db.prepare('SELECT COUNT(*) n FROM activity').get() as { n: number }).n;
    return { tickets, activity, schema };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw badRequest(`That file can't be opened as a board database: ${(e as Error).message}`);
  } finally {
    reference?.close();
    db?.close();
  }
}

/**
 * Replace the live database with `sourcePath`.
 * Validate, migrate and initialize a private candidate before touching live
 * data. Keep the original file until activation succeeds; any activation
 * failure restores both that file and the running connection.
 * Sessions, passwords and the admin PIN of the running board are kept, so
 * nobody is signed out and the person restoring keeps admin access. (Passwords
 * are credentials, not board data: a backup from before someone changed theirs,
 * or from before passwords existed, must not lock them out.)
 */
export function restoreFrom(ctx: BackupCtx, sourcePath: string): { tickets: number; safety_backup: string; review_files_missing: number } {
  verifyDatabaseFile(sourcePath);
  const keep = {
    cookie_secret: getSetting(ctx, 'cookie_secret')!,
    admin_pin: getSetting(ctx, 'admin_pin')!,
    admin_pin_is_default: getSetting(ctx, 'admin_pin_is_default') ?? '1',
  };
  const keepPasswords = all<{ id: number; password_hash: string }>(ctx.db, 'SELECT id, password_hash FROM users WHERE password_hash IS NOT NULL');

  const stagingDir = mkdtempSync(`${ctx.dbPath}.restore-`);
  const staged = join(stagingDir, 'candidate.db');
  const original = join(stagingDir, 'original.db');
  let candidate: Db | undefined;
  let preserveOriginal = false;
  const checkpoint = (db: Db) => {
    const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number; log: number; checkpointed: number };
    if (result.busy || result.log !== result.checkpointed)
      throw new Error('The database is busy; close other SQLite connections before restoring.');
  };
  try {
    copyFileSync(sourcePath, staged);
    try {
      candidate = openDb(staged);
      migrate(candidate);
      const stagingCtx = { ...ctx, db: candidate };
      ensureAuthSettings(stagingCtx);
      for (const [k, v] of Object.entries(keep)) setSetting(stagingCtx, k, v);
      for (const p of keepPasswords) run(candidate, 'UPDATE users SET password_hash = ? WHERE id = ?', p.password_hash, p.id);
      run(candidate, 'DELETE FROM idempotency');
      rebuildIndex(stagingCtx);
      verifyDatabaseFile(staged);
      checkpoint(candidate);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw badRequest(`That backup could not be prepared for restore: ${(e as Error).message}`);
    } finally {
      candidate?.close();
      candidate = undefined;
    }

    const safety = backupNow(ctx, 'pre-restore');
    let closed = false;
    let moved = false;
    try {
      // Checkpoint before moving the original: keep its complete state even
      // if reopening the candidate fails. No request can interleave here.
      checkpoint(ctx.db);
      ctx.db.close();
      closed = true;
      renameSync(ctx.dbPath, original);
      moved = true;
      for (const suffix of ['-wal', '-shm']) rmSync(ctx.dbPath + suffix, { force: true });
      renameSync(staged, ctx.dbPath);
      ctx.db = openDb(ctx.dbPath);
      const check = verifyDatabaseFile(ctx.dbPath);
      // Read authentication settings through the activated connection too.
      for (const [key, value] of Object.entries(keep)) {
        if (getSetting(ctx, key) !== value) throw new Error(`Restored ${key} did not match the running board`);
      }
      for (const p of keepPasswords) {
        const row = get<{ password_hash: string | null }>(ctx.db, 'SELECT password_hash FROM users WHERE id = ?', p.id);
        if (row && row.password_hash !== p.password_hash) throw new Error(`Restored password of user ${p.id} did not match the running board`);
      }
      // put back review PDFs the restored data needs, from the backup store
      const files = restoreReviewFiles(ctx, ctx.backupDir);
      ctx.events.emit({ type: 'reload' });
      return { tickets: check.tickets, safety_backup: safety.name, review_files_missing: files.missing };
    } catch (e) {
      if (closed || !ctx.db.isOpen) {
        try {
          if (ctx.db.isOpen) ctx.db.close();
          if (moved) {
            for (const suffix of ['', '-wal', '-shm']) rmSync(ctx.dbPath + suffix, { force: true });
            renameSync(original, ctx.dbPath);
          }
          ctx.db = openDb(ctx.dbPath);
        } catch (rollbackError) {
          // Never erase the only intact original if disk/connection recovery
          // itself fails. The independent safety backup also remains intact.
          preserveOriginal = true;
          throw new AggregateError([e, rollbackError],
            `Restore failed and the original database could not be reopened. Original files: ${stagingDir}; safety backup: ${safety.name}`);
        }
      }
      throw e;
    }
  } finally {
    if (!preserveOriginal) rmSync(stagingDir, { recursive: true, force: true });
  }
}

export function dbStats(ctx: BackupCtx) {
  // the live database is the main file plus its write-ahead log
  const size = ['', '-wal'].reduce((n, sfx) => n + (existsSync(ctx.dbPath + sfx) ? statSync(ctx.dbPath + sfx).size : 0), 0);
  const counts = get<{ tickets: number; archived: number; activity: number }>(
    ctx.db,
    `SELECT (SELECT COUNT(*) FROM tickets) tickets, (SELECT COUNT(*) FROM tickets WHERE archived = 1) archived,
            (SELECT COUNT(*) FROM activity) activity`,
  )!;
  return { db_path: ctx.dbPath, db_size: size, backup_dir: ctx.backupDir, keep_days: ctx.keepDays, ...counts };
}
