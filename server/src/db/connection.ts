import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrations } from './migrations.ts';

export type Db = DatabaseSync;
export type Param = SQLInputValue;

const MIN_NODE = [22, 16];

/**
 * Load the built-in SQLite module lazily so an old node.exe produces a clear
 * message instead of a crash at startup.
 */
/**
 * Node 22 prints "ExperimentalWarning: SQLite is an experimental feature" the
 * first time node:sqlite loads. On the host PC that line looks like an error in
 * the board's window, so drop that one warning (and only that one), however
 * the server was started.
 */
let quieted = false;
function quietSqliteWarning() {
  if (quieted) return;
  quieted = true;
  const emit = process.emitWarning;
  process.emitWarning = function (warning: string | Error, ...rest: any[]) {
    const msg = typeof warning === 'string' ? warning : warning?.message;
    if (typeof msg === 'string' && /^SQLite is an experimental feature/.test(msg)) return;
    return (emit as any).call(process, warning, ...rest);
  } as typeof process.emitWarning;
}

export function sqlite(): typeof import('node:sqlite') {
  const [maj, min] = process.versions.node.split('.').map(Number);
  quietSqliteWarning();
  const mod = (process as any).getBuiltinModule?.('node:sqlite') as typeof import('node:sqlite') | undefined;
  const oldNode = maj < MIN_NODE[0] || (maj === MIN_NODE[0] && min < MIN_NODE[1]);
  if (!mod && !oldNode)
    throw new Error(
      `This node.exe (${process.versions.node}) has its built-in SQLite turned off, which the board needs. ` +
        `Remove --no-experimental-sqlite from NODE_OPTIONS (or from start.bat) and start the board again.`,
    );
  if (!mod || oldNode) {
    throw new Error(
      `This node.exe is version ${process.versions.node}. The board needs Node.js ${MIN_NODE.join('.')} or newer ` +
        `(download the latest v22 "Windows Binary (.zip)" from nodejs.org and replace node.exe).`,
    );
  }
  return mod;
}

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new (sqlite().DatabaseSync)(path);
  try {
    db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}

const depthByDb = new WeakMap<Db, number>();

/**
 * Run `fn` inside a transaction. Nested calls use savepoints. Because the
 * driver is synchronous and Node is single-threaded, a transaction can never
 * interleave with another request in this process.
 */
export function tx<T>(db: Db, fn: () => T): T {
  const depth = depthByDb.get(db) ?? 0;
  const sp = `sp${depth}`;
  db.exec(depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
  depthByDb.set(db, depth + 1);
  try {
    const result = fn();
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return result;
  } catch (err) {
    db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw err;
  } finally {
    depthByDb.set(db, depth);
  }
}

/** Typed helpers (node:sqlite rows are null-prototype objects). */
export function all<T>(db: Db, sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function get<T>(db: Db, sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function run(db: Db, sql: string, ...params: Param[]) {
  return db.prepare(sql).run(...params);
}

/** Newest schema version this build of the board understands. */
export const SCHEMA_VERSION = Math.max(...migrations.map((m) => m.id));

/** Ids of migrations not yet applied to `db` (empty for a brand-new or up-to-date file). */
export function pendingMigrations(db: Db): number[] {
  const has = get(db, `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`);
  const done = new Set(has ? all<{ id: number }>(db, 'SELECT id FROM schema_migrations').map((r) => r.id) : []);
  return migrations.map((m) => m.id).filter((id) => !done.has(id)).sort((a, b) => a - b);
}

export function migrate(db: Db): { applied: number[] } {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const done = new Set(all<{ id: number }>(db, 'SELECT id FROM schema_migrations').map((r) => r.id));
  // An older copy of the board must never run on data written by a newer one:
  // it would not know about newer tables and columns and could damage them.
  const newest = Math.max(0, ...done);
  if (newest > SCHEMA_VERSION)
    throw new Error(
      `This data was written by a newer version of the board (database version ${newest}; this copy understands up to ${SCHEMA_VERSION}). ` +
        `Run the newer version again, or restore a backup made by this version.`,
    );
  const applied: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.id - b.id)) {
    if (done.has(m.id)) continue;
    tx(db, () => {
      db.exec(m.sql);
      run(db, 'INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)', m.id, m.name, new Date().toISOString());
    });
    applied.push(m.id);
  }
  return { applied };
}
