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

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { get, migrate, openDb, run, sqlite, type Db } from '../db/connection.ts';
import { migrations } from '../db/migrations.ts';
import { HttpError, badRequest, type Ctx } from '../lib/core.ts';
import { localDate } from '../lib/time.ts';
import { ensureAuthSettings, getSetting, setSetting } from './auth.ts';
import { rebuildIndex } from './search.ts';

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
      removed.push(b.name);
    }
  });
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
    const tickets = (db.prepare('SELECT COUNT(*) n FROM tickets').get() as { n: number }).n;
    const activity = (db.prepare('SELECT COUNT(*) n FROM activity').get() as { n: number }).n;
    return { tickets, activity, schema };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw badRequest(`That file can't be opened as a board database: ${(e as Error).message}`);
  } finally {
    db?.close();
  }
}

/**
 * Replace the live database with `sourcePath`.
 * 1. check the file  2. back up the current data  3. swap files  4. reopen,
 * upgrade the schema if the backup is older, rebuild the search index.
 * Sessions and the admin PIN of the running board are kept, so nobody is
 * signed out and the person restoring keeps admin access.
 */
export function restoreFrom(ctx: BackupCtx, sourcePath: string): { tickets: number; safety_backup: string } {
  const check = verifyDatabaseFile(sourcePath);
  const safety = backupNow(ctx, 'pre-restore');
  const keep = {
    cookie_secret: getSetting(ctx, 'cookie_secret')!,
    admin_pin: getSetting(ctx, 'admin_pin')!,
    admin_pin_is_default: getSetting(ctx, 'admin_pin_is_default') ?? '1',
  };

  const staged = `${ctx.dbPath}.restoring`;
  copyFileSync(sourcePath, staged);
  ctx.db.close();
  try {
    for (const suffix of ['', '-wal', '-shm']) rmSync(ctx.dbPath + suffix, { force: true });
    renameSync(staged, ctx.dbPath);
  } catch (e) {
    // put the safety copy back so the board keeps running on the old data
    copyFileSync(join(ctx.backupDir, safety.name), ctx.dbPath);
    ctx.db = openDb(ctx.dbPath);
    throw e;
  }
  ctx.db = openDb(ctx.dbPath);
  migrate(ctx.db);
  ensureAuthSettings(ctx);
  for (const [k, v] of Object.entries(keep)) setSetting(ctx, k, v);
  run(ctx.db, 'DELETE FROM idempotency');
  rebuildIndex(ctx);
  ctx.events.emit({ type: 'reload' });
  return { tickets: check.tickets, safety_backup: safety.name };
}

/** Write an uploaded file to a temp path next to the database (same disk, so the swap is a rename). */
export function stageUpload(ctx: BackupCtx, data: Buffer): string {
  const p = `${ctx.dbPath}.upload-${Date.now()}`;
  writeFileSync(p, data);
  return p;
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

