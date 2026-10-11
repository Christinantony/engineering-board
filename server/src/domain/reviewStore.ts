// Board-managed storage for review PDFs.
//
// Every PDF the board receives is stored once, named by the SHA-256 of its
// bytes, in a "review-files" folder next to the database:
//   data/review-files/ab/ab12…ef.pdf
// A review decision is recorded against that hash, so the exact bytes that
// were reviewed can never change underneath it, and a later re-export of the
// working file cannot alter a past review. Files are written once and never
// modified. Only unprotected files that no live attempt still needs are ever
// deleted (signed scans are protected, enforced by database triggers too).

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, readdirSync, copyFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { all, get, run } from '../db/connection.ts';
import { HttpError, nowIso, type Ctx } from '../lib/core.ts';

export interface StoreCtx extends Ctx {
  dbPath: string;
}

export const storeDir = (ctx: { dbPath: string }) => join(dirname(ctx.dbPath), 'review-files');
const SHA_RE = /^[0-9a-f]{64}$/;

export function blobPath(ctx: { dbPath: string }, sha: string): string {
  if (!SHA_RE.test(sha)) throw new HttpError(400, 'bad_request', 'Not a file reference');
  return join(storeDir(ctx), sha.slice(0, 2), `${sha}.pdf`);
}

export const hasBlob = (ctx: { dbPath: string }, sha: string) => existsSync(blobPath(ctx, sha));

export function hashFile(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('end', () => resolveHash(h.digest('hex')))
      .on('error', reject);
  });
}

export const hashBuffer = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Re-read a stored file and confirm its bytes still match its name. */
export function verifyBlob(ctx: { dbPath: string }, sha: string): boolean {
  const p = blobPath(ctx, sha);
  if (!existsSync(p)) return false;
  return hashBuffer(readFileSync(p)) === sha;
}

/**
 * Move a fully received, hashed upload into the store and record it.
 * An identical file that is already stored is kept as it is.
 */
export function ingest(ctx: StoreCtx, tempPath: string, sha: string, pages: number): { size: number } {
  const target = blobPath(ctx, sha);
  const size = statSync(tempPath).size;
  if (!existsSync(target) || statSync(target).size !== size) {
    mkdirSync(dirname(target), { recursive: true });
    renameSync(tempPath, target);
  }
  const row = get<{ removed_at: string | null }>(ctx.db, 'SELECT removed_at FROM review_files WHERE sha256 = ?', sha);
  if (!row) run(ctx.db, 'INSERT INTO review_files (sha256, size, pages, created_at) VALUES (?, ?, ?, ?)', sha, size, pages, nowIso(ctx));
  else if (row.removed_at) run(ctx.db, 'UPDATE review_files SET removed_at = NULL, created_at = ? WHERE sha256 = ?', nowIso(ctx), sha);
  return { size };
}

/** True when a live attempt or a reference still needs these bytes. */
export function blobInUse(ctx: Ctx, sha: string): boolean {
  return !!get(
    ctx.db,
    `SELECT 1 FROM review_files f WHERE f.sha256 = ? AND (f.protected = 1
       OR EXISTS (SELECT 1 FROM review_references r WHERE r.sha256 = f.sha256)
       OR EXISTS (SELECT 1 FROM review_attempts a WHERE a.sha256 = f.sha256 AND a.file_removed_at IS NULL))`,
    sha,
  );
}

/**
 * Delete a stored file that nothing needs any more. Refuses protected files and
 * files still in use. Returns true when the file is gone.
 */
export function removeBlob(ctx: StoreCtx, sha: string): boolean {
  const row = get<{ protected: number }>(ctx.db, 'SELECT protected FROM review_files WHERE sha256 = ?', sha);
  if (row?.protected) throw new Error('A signed reference scan is protected and is never deleted.');
  if (blobInUse(ctx, sha)) return false;
  rmSync(blobPath(ctx, sha), { force: true });
  if (row) run(ctx.db, 'UPDATE review_files SET removed_at = ? WHERE sha256 = ?', nowIso(ctx), sha);
  return true;
}

/**
 * Forget uploads that were never submitted (someone closed the form), once
 * they are a day old. Protected and referenced files are never touched.
 */
export function collectUnusedUploads(ctx: StoreCtx): number {
  const cutoff = new Date(ctx.now().getTime() - 86_400_000).toISOString();
  const rows = all<{ sha256: string }>(
    ctx.db,
    `SELECT f.sha256 FROM review_files f
     WHERE f.protected = 0 AND f.created_at < ?
       AND NOT EXISTS (SELECT 1 FROM review_references r WHERE r.sha256 = f.sha256)
       AND NOT EXISTS (SELECT 1 FROM review_attempts a WHERE a.sha256 = f.sha256)`,
    cutoff,
  );
  for (const r of rows) {
    rmSync(blobPath(ctx, r.sha256), { force: true });
    run(ctx.db, 'DELETE FROM review_files WHERE sha256 = ?', r.sha256);
  }
  // leftovers of uploads interrupted part-way
  const dir = storeDir(ctx);
  if (existsSync(dir))
    for (const name of readdirSync(dir))
      if (name.startsWith('.incoming-') && statSync(join(dir, name)).mtimeMs < Date.parse(cutoff)) rmSync(join(dir, name), { recursive: true, force: true });
  return rows.length;
}

// ---------------------------------------------------------------------------
// Backups: review files are copied into <backupDir>/review-files (each file
// once, however many backups need it) and every backup gets a list of the
// files it needs. Restoring a backup puts back any of those files that are
// missing. Files no remaining backup needs are pruned with the backups.
// ---------------------------------------------------------------------------

const backupStore = (backupDir: string) => join(backupDir, 'review-files');
export const manifestFor = (backupFile: string) => `${backupFile}.review-files.txt`;

/** Copy the live review files into the backup store and write the manifest for `backupFile`. */
export function backupReviewFiles(ctx: StoreCtx, backupDir: string, backupFile: string): { files: number; missing: number } {
  const hasTable = get(ctx.db, `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'review_files'`);
  const shas = hasTable ? all<{ sha256: string }>(ctx.db, 'SELECT sha256 FROM review_files WHERE removed_at IS NULL').map((r) => r.sha256) : [];
  let missing = 0;
  const kept: string[] = [];
  for (const sha of shas) {
    const src = blobPath(ctx, sha);
    const dst = join(backupStore(backupDir), sha.slice(0, 2), `${sha}.pdf`);
    if (!existsSync(src)) {
      missing++;
      continue;
    }
    if (!existsSync(dst) || statSync(dst).size !== statSync(src).size) {
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, `${dst}.partial`);
      renameSync(`${dst}.partial`, dst);
    }
    kept.push(sha);
  }
  const m = manifestFor(backupFile);
  if (kept.length) {
    copyText(m, kept.join('\n') + '\n');
  } else rmSync(m, { force: true });
  return { files: kept.length, missing };
}

function copyText(path: string, text: string) {
  const tmp = `${path}.partial`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** After backups are pruned: drop manifests of deleted backups and files no backup needs. */
export function pruneBackupStore(backupDir: string, isBackup: (name: string) => boolean): number {
  if (!existsSync(backupDir)) return 0;
  const needed = new Set<string>();
  for (const name of readdirSync(backupDir)) {
    if (!name.endsWith('.review-files.txt')) continue;
    const db = name.slice(0, -'.review-files.txt'.length);
    if (!isBackup(db) || !existsSync(join(backupDir, db))) {
      rmSync(join(backupDir, name), { force: true });
      continue;
    }
    for (const sha of readFileSync(join(backupDir, name), 'utf8').split('\n')) if (SHA_RE.test(sha)) needed.add(sha);
  }
  const store = backupStore(backupDir);
  if (!existsSync(store)) return 0;
  let removed = 0;
  for (const sub of readdirSync(store)) {
    const subDir = join(store, sub);
    if (!statSync(subDir).isDirectory()) continue;
    for (const f of readdirSync(subDir)) {
      const sha = f.replace(/\.pdf(\.partial)?$/, '');
      if (!needed.has(sha) || f.endsWith('.partial')) {
        rmSync(join(subDir, f), { force: true });
        removed++;
      }
    }
  }
  return removed;
}

/** After a restore: put back any review file the restored data needs and the live folder lacks. */
export function restoreReviewFiles(ctx: StoreCtx, backupDir: string): { restored: number; missing: number } {
  const hasTable = get(ctx.db, `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'review_files'`);
  if (!hasTable) return { restored: 0, missing: 0 };
  let restored = 0;
  let missing = 0;
  for (const { sha256 } of all<{ sha256: string }>(ctx.db, 'SELECT sha256 FROM review_files WHERE removed_at IS NULL')) {
    const target = blobPath(ctx, sha256);
    if (existsSync(target)) continue;
    const src = join(backupStore(backupDir), sha256.slice(0, 2), `${sha256}.pdf`);
    if (existsSync(src)) {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(src, `${target}.partial`);
      renameSync(`${target}.partial`, target);
      restored++;
    } else missing++;
  }
  return { restored, missing };
}
