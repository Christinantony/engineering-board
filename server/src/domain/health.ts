// Host health (decision #34): what the admin needs to know about the PC the
// board runs on, in one place. The biggest risk on a single host PC is losing
// the disk with the backups on it, so the checks put that first: are backups
// being made, are they on another disk, is there room for them.
//
// Everything here is read on request with Node built-ins (fs.statfsSync for
// free space, statSync().dev to tell disks apart); nothing runs in the
// background except remembering the last daily-backup failure.

import { existsSync, readdirSync, statSync, statfsSync } from 'node:fs';
import { hostname, platform, release } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { all, get } from '../db/connection.ts';
import { localDate } from '../lib/time.ts';
import { getSetting, pinIsDefault } from './auth.ts';
import { BACKUP_RE, listBackups, type BackupCtx } from './backup.ts';
import { storeDir } from './reviewStore.ts';

export type Level = 'ok' | 'warn' | 'bad';

export interface HealthCheck {
  id: 'backups' | 'backup_disk' | 'disk_space' | 'database' | 'admin_pin';
  level: Level;
  title: string;
  detail: string;
}

export interface DiskInfo {
  path: string;
  free: number;
  total: number;
}

export interface HostHealth {
  level: Level;
  checks: HealthCheck[];
  host: { name: string; platform: string; node: string; version: string; started_at: string; uptime_seconds: number };
  database: { path: string; size: number; wal_size: number; tickets: number; activity: number; schema: number };
  review_files: { path: string; count: number; size: number };
  backups: { dir: string; count: number; size: number; newest: { name: string; kind: string; created_at: string } | null; last_daily: string | null; keep_days: number };
  disks: { database: DiskInfo | null; backups: DiskInfo | null; same_disk: boolean | null };
}

/** What the running board remembers between requests: when it started and the last daily-backup failure. */
export class HealthState {
  readonly startedAt: Date;
  backupError: { at: string; message: string } | null = null;
  constructor(now: Date) {
    this.startedAt = now;
  }
}

const GiB = 1024 ** 3;
/** Below this much free space a backup or upload can fail outright. */
export const DISK_BAD_BYTES = 1 * GiB;
/** Below this (or under 10 %), worth sorting out soon. */
export const DISK_WARN_BYTES = 5 * GiB;
/** A backup older than this many days, on a board with jobs, needs looking at. */
export const BACKUP_STALE_DAYS = 3;

/** The nearest folder that exists, so a backup folder not created yet still tells us its disk. */
function existing(path: string): string {
  let p = resolve(path);
  while (!existsSync(p)) {
    const up = dirname(p);
    if (up === p) break;
    p = up;
  }
  return p;
}

function disk(path: string): DiskInfo | null {
  try {
    const s = statfsSync(existing(path));
    return { path, free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

const isUnc = (p: string) => /^(\\\\|\/\/)[^\\/]+[\\/]/.test(p);

/**
 * Whether two folders are on the same disk. A network share (\\server\share)
 * is never the PC's own disk. Otherwise the device number decides; on Windows
 * Node reports the volume serial number there, so C: and D: differ. Where it
 * can't tell, the drive letter decides.
 */
export function sameDisk(a: string, b: string): boolean | null {
  if (isUnc(a) !== isUnc(b)) return false;
  try {
    const da = statSync(existing(a)).dev;
    const db = statSync(existing(b)).dev;
    if (da || db) return da === db;
  } catch {
    // fall through to the drive letter
  }
  const ra = parse(resolve(a)).root.toLowerCase();
  const rb = parse(resolve(b)).root.toLowerCase();
  return ra && rb ? ra === rb : null;
}

function folderSize(dir: string): { count: number; size: number } {
  let count = 0;
  let size = 0;
  if (!existsSync(dir)) return { count, size };
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        count++;
        size += statSync(p).size;
      }
    }
  };
  try {
    walk(dir);
  } catch {
    // a file removed while we looked: the numbers are a guide, not an audit
  }
  return { count, size };
}

const fileSize = (p: string) => (existsSync(p) ? statSync(p).size : 0);

export const formatBytes = (b: number) =>
  b >= GiB ? `${(b / GiB).toFixed(1)} GB` : b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;

function diskCheck(name: string, d: DiskInfo | null): { level: Level; text: string } | null {
  if (!d || !d.total) return null;
  const share = d.free / d.total;
  const text = `${name}: ${formatBytes(d.free)} free of ${formatBytes(d.total)}`;
  if (d.free < DISK_BAD_BYTES) return { level: 'bad', text };
  if (d.free < DISK_WARN_BYTES || share < 0.1) return { level: 'warn', text };
  return { level: 'ok', text };
}

const worst = (levels: Level[]): Level => (levels.includes('bad') ? 'bad' : levels.includes('warn') ? 'warn' : 'ok');

export function hostHealth(ctx: BackupCtx, state: HealthState, appVersion: string): HostHealth {
  const now = ctx.now();
  const counts = get<{ tickets: number; activity: number }>(ctx.db, 'SELECT (SELECT COUNT(*) FROM tickets) tickets, (SELECT COUNT(*) FROM activity) activity')!;
  const schema = get<{ v: number }>(ctx.db, 'SELECT COALESCE(MAX(id), 0) v FROM schema_migrations')!.v;
  const backups = listBackups(ctx);
  const newest = backups[0] ?? null;
  const lastDaily = getSetting(ctx, 'last_daily_backup') ?? null;
  const reviewDir = storeDir(ctx);
  const review = folderSize(reviewDir);
  const dbDisk = disk(dirname(ctx.dbPath));
  const backupDisk = disk(ctx.backupDir);
  const same = sameDisk(dirname(ctx.dbPath), ctx.backupDir);
  const checks: HealthCheck[] = [];

  // 1. backups being made
  {
    const today = localDate(now.getTime(), ctx.tz);
    // the date in the name is the board's own local date when it was taken
    const taken = newest ? BACKUP_RE.exec(newest.name)![1] : '';
    const ageDays = newest ? Math.round((Date.parse(today) - Date.parse(taken)) / 86_400_000) : Infinity;
    const when = newest ? `${taken} (${newest.name})` : '';
    if (state.backupError)
      checks.push({
        id: 'backups',
        level: 'bad',
        title: 'The last daily backup failed',
        detail: `${state.backupError.message} (at ${state.backupError.at}). ${newest ? `The newest backup that worked is from ${when}.` : 'There is no backup yet.'} Check the backup folder exists and has room, then press Back up now.`,
      });
    else if (!newest && counts.tickets > 0)
      checks.push({ id: 'backups', level: 'bad', title: 'No backup yet', detail: 'The board has jobs but no backup yet. Press Back up now.' });
    else if (!newest)
      checks.push({ id: 'backups', level: 'ok', title: 'No backups needed yet', detail: 'The first daily backup is taken once the board has jobs.' });
    else if (ageDays > BACKUP_STALE_DAYS && counts.tickets > 0)
      checks.push({
        id: 'backups',
        level: 'warn',
        title: `No backup for ${ageDays} days`,
        detail: `The newest is from ${when}. A backup is taken the first hour the board runs each day; if the board has been running, check the console window for an error.`,
      });
    else
      checks.push({
        id: 'backups',
        level: 'ok',
        title: lastDaily === today ? "Today's backup is done" : 'Backups are being made',
        detail: `Newest: ${when}. ${backups.length} kept, ${ctx.keepDays} days.`,
      });
  }

  // 2. backups on another disk
  if (same === true)
    checks.push({
      id: 'backup_disk',
      level: 'warn',
      title: 'Backups are on the same disk as the board',
      detail: `If this PC's disk fails, the board and every backup are lost together. Set "backupDir" in config.json to a network share or a OneDrive folder (now: ${ctx.backupDir}).`,
    });
  else if (same === false)
    checks.push({ id: 'backup_disk', level: 'ok', title: 'Backups are on another disk', detail: `Backup folder: ${ctx.backupDir}` });
  else checks.push({ id: 'backup_disk', level: 'warn', title: "Can't tell where the backups are", detail: `Check that ${ctx.backupDir} is on another disk or a network share.` });

  // 3. free space where the board writes
  {
    const parts = [diskCheck('Board', dbDisk), same ? null : diskCheck('Backups', backupDisk)].filter((x): x is { level: Level; text: string } => !!x);
    if (!parts.length) checks.push({ id: 'disk_space', level: 'warn', title: "Can't read the free space", detail: 'The operating system did not report it.' });
    else {
      const level = worst(parts.map((p) => p.level));
      checks.push({
        id: 'disk_space',
        level,
        title: level === 'ok' ? 'Enough disk space' : level === 'warn' ? 'Disk space is getting low' : 'Disk almost full',
        detail: parts.map((p) => p.text).join('. ') + (level === 'ok' ? '.' : '. Backups and drawing uploads fail when the disk is full: free some space or move the backup folder.'),
      });
    }
  }

  // 4. the database file reads back cleanly
  {
    const rows = all<{ quick_check: string }>(ctx.db, 'PRAGMA quick_check');
    const ok = rows.length === 1 && rows[0].quick_check === 'ok';
    checks.push(
      ok
        ? { id: 'database', level: 'ok', title: 'Database checks out', detail: `SQLite quick check passed. Schema version ${schema}.` }
        : { id: 'database', level: 'bad', title: 'The database reports damage', detail: `SQLite quick check: ${rows.slice(0, 3).map((r) => r.quick_check).join('; ')}. Restore the newest backup and tell whoever looks after the board.` },
    );
  }

  // 5. the admin PIN
  checks.push(
    pinIsDefault(ctx)
      ? { id: 'admin_pin', level: 'warn', title: 'The admin PIN is still 1234', detail: 'Anyone on the network could change the team or restore old data. Change it under Admin PIN.' }
      : { id: 'admin_pin', level: 'ok', title: 'The admin PIN has been changed', detail: 'Only people who know it can open Admin.' },
  );

  const backupBytes = backups.reduce((n, b) => n + b.size, 0);
  return {
    level: worst(checks.map((c) => c.level)),
    checks,
    host: {
      name: hostname(),
      platform: `${platform()} ${release()}`,
      node: process.versions.node,
      version: appVersion,
      started_at: state.startedAt.toISOString(),
      uptime_seconds: Math.max(0, Math.round((now.getTime() - state.startedAt.getTime()) / 1000)),
    },
    database: { path: ctx.dbPath, size: fileSize(ctx.dbPath), wal_size: fileSize(`${ctx.dbPath}-wal`), tickets: counts.tickets, activity: counts.activity, schema },
    review_files: { path: reviewDir, ...review },
    backups: {
      dir: ctx.backupDir,
      count: backups.length,
      size: backupBytes,
      newest: newest ? { name: newest.name, kind: newest.kind, created_at: newest.created_at } : null,
      last_daily: lastDaily,
      keep_days: ctx.keepDays,
    },
    disks: { database: dbDisk, backups: backupDisk, same_disk: same },
  };
}
