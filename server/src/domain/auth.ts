// LAN authentication:
//  * Sign-in — the user picks their name and enters their password (decision #28).
//    The first time (and after an admin resets it) they create the password instead.
//    A signed cookie then remembers them; it is bound to the current password, so
//    changing or resetting the password signs that person out everywhere.
//  * Admin area — unlocked with a PIN (stored as a salted scrypt hash).
// Isolated here so SSO or a directory could replace it later.

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { get, run } from '../db/connection.ts';
import { HttpError, type Ctx } from '../lib/core.ts';

export const DEFAULT_PIN = '1234';
const ADMIN_TTL_MS = 12 * 3600_000;

/** Wrong passwords allowed in a row before sign-in for that person pauses, and for how long. */
export const SIGN_IN_ATTEMPTS = 5;
export const SIGN_IN_PAUSE_MS = 30_000;

export function getSetting(ctx: Ctx, key: string): string | undefined {
  return get<{ value: string }>(ctx.db, 'SELECT value FROM settings WHERE key = ?', key)?.value;
}
export function setSetting(ctx: Ctx, key: string, value: string) {
  run(ctx.db, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

// ---- secrets (PIN and passwords share one format) ----

function hashSecret(secret: string, salt = randomBytes(16).toString('hex')): string {
  return `scrypt$${salt}$${scryptSync(secret, salt, 32).toString('hex')}`;
}

function verifySecret(stored: string | null | undefined, candidate: string): boolean {
  if (!stored) return false;
  const [, salt, hash] = stored.split('$');
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(candidate, salt, 32);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function ensureAuthSettings(ctx: Ctx) {
  if (!getSetting(ctx, 'cookie_secret')) setSetting(ctx, 'cookie_secret', randomBytes(32).toString('hex'));
  if (!getSetting(ctx, 'admin_pin')) {
    setSetting(ctx, 'admin_pin', hashSecret(DEFAULT_PIN));
    setSetting(ctx, 'admin_pin_is_default', '1');
  }
}

// ---- admin PIN ----

export function verifyPin(ctx: Ctx, pin: string): boolean {
  return verifySecret(getSetting(ctx, 'admin_pin'), pin);
}

export function changePin(ctx: Ctx, newPin: string) {
  setSetting(ctx, 'admin_pin', hashSecret(newPin));
  setSetting(ctx, 'admin_pin_is_default', '0');
}

/** Put the admin PIN back to the default (someone with access to the host PC asked for it). */
export function resetPin(ctx: Ctx) {
  setSetting(ctx, 'admin_pin', hashSecret(DEFAULT_PIN));
  setSetting(ctx, 'admin_pin_is_default', '1');
}

export const pinIsDefault = (ctx: Ctx) => getSetting(ctx, 'admin_pin_is_default') === '1';

// ---- passwords ----

interface Credential {
  id: number;
  active: number;
  password_hash: string | null;
}

const credential = (ctx: Ctx, userId: number) => get<Credential>(ctx.db, 'SELECT id, active, password_hash FROM users WHERE id = ?', userId);

export const hasPassword = (ctx: Ctx, userId: number) => !!credential(ctx, userId)?.password_hash;

/** The person's first password (or their first after an admin reset). Refused once one exists. */
export function createPassword(ctx: Ctx, userId: number, password: string) {
  const res = run(ctx.db, 'UPDATE users SET password_hash = ? WHERE id = ? AND password_hash IS NULL', hashSecret(password), userId);
  if (res.changes === 0) throw new HttpError(409, 'password_already_set', 'A password has already been created for this person. Enter it to sign in.');
  ctx.events.emit({ type: 'users' });
}

/** Change a password after the current one has been checked. */
export function setPassword(ctx: Ctx, userId: number, password: string) {
  run(ctx.db, 'UPDATE users SET password_hash = ? WHERE id = ?', hashSecret(password), userId);
  ctx.events.emit({ type: 'users' });
}

/** Forgotten password: clear it so the person creates a new one at their next sign-in. Signs them out everywhere. */
export function clearPassword(ctx: Ctx, userId: number) {
  run(ctx.db, 'UPDATE users SET password_hash = NULL WHERE id = ?', userId);
  attempts(ctx).delete(userId);
  ctx.events.emit({ type: 'users' });
}

/** Everyone locked out (the RESET-PASSWORDS file on the host PC): clear every password. */
export function clearAllPasswords(ctx: Ctx): number {
  const n = run(ctx.db, 'UPDATE users SET password_hash = NULL WHERE password_hash IS NOT NULL').changes;
  attempts(ctx).clear();
  return Number(n);
}

interface Attempts {
  fails: number;
  pausedUntil: number;
}
// per app instance (tests run several), per user: wrong passwords in a row
const attemptsByApp = new WeakMap<object, Map<number, Attempts>>();
function attempts(ctx: Ctx): Map<number, Attempts> {
  let m = attemptsByApp.get(ctx.events);
  if (!m) attemptsByApp.set(ctx.events, (m = new Map()));
  return m;
}

/**
 * Check a password for sign-in. Wrong → 403 `wrong_password`. After SIGN_IN_ATTEMPTS
 * wrong ones in a row, sign-in for that person pauses for SIGN_IN_PAUSE_MS (429
 * `too_many_attempts`), and every further wrong password extends the pause. A
 * right password while paused is still refused, so guessing cannot continue.
 */
export function checkPassword(ctx: Ctx, userId: number, password: string): void {
  const now = ctx.now().getTime();
  const log = attempts(ctx);
  const a = log.get(userId);
  if (a && a.pausedUntil > now) throw tooMany(a.pausedUntil - now);
  if (verifySecret(credential(ctx, userId)?.password_hash, password)) {
    log.delete(userId);
    return;
  }
  const fails = (a?.fails ?? 0) + 1;
  const pausedUntil = fails >= SIGN_IN_ATTEMPTS ? now + SIGN_IN_PAUSE_MS : 0;
  log.set(userId, { fails, pausedUntil });
  if (pausedUntil) throw tooMany(SIGN_IN_PAUSE_MS);
  throw new HttpError(403, 'wrong_password', "That password isn't right.");
}

const tooMany = (waitMs: number) => {
  const s = Math.max(1, Math.ceil(waitMs / 1000));
  return new HttpError(429, 'too_many_attempts', `Too many wrong passwords. Wait ${s} second${s === 1 ? '' : 's'} and try again.`, { retry_after_seconds: s });
};

// ---- cookies ----

function sign(ctx: Ctx, value: string): string {
  const mac = createHmac('sha256', getSetting(ctx, 'cookie_secret')!).update(value).digest('base64url');
  return `${value}.${mac}`;
}

function unsign(ctx: Ctx, signed: string | undefined): string | null {
  if (!signed) return null;
  const i = signed.lastIndexOf('.');
  if (i < 0) return null;
  const value = signed.slice(0, i);
  const a = Buffer.from(sign(ctx, value));
  const b = Buffer.from(signed);
  return a.length === b.length && timingSafeEqual(a, b) ? value : null;
}

/** Ties a session to the password it was signed in with: a new password makes old cookies invalid. */
const passwordTag = (hash: string) => createHash('sha256').update(hash).digest('hex').slice(0, 16);

/** The session cookie for someone who has just signed in. The person must have a password. */
export function sessionCookie(ctx: Ctx, userId: number): string {
  const c = credential(ctx, userId);
  if (!c?.password_hash) throw new Error('a session needs a password');
  return sign(ctx, `u${userId}:${passwordTag(c.password_hash)}`);
}

/** The signed-in user id, or null: no cookie, a forged one, a password that has changed since, or an inactive user. */
export function readSession(ctx: Ctx, cookie: string | undefined): number | null {
  const v = unsign(ctx, cookie);
  const m = v && /^u(\d+):([0-9a-f]{16})$/.exec(v);
  if (!m) return null;
  const c = credential(ctx, Number(m[1]));
  if (!c?.password_hash || !c.active) return null;
  const want = Buffer.from(passwordTag(c.password_hash));
  const got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got) ? c.id : null;
}

export const adminCookie = (ctx: Ctx, userId: number) => sign(ctx, `a${userId}:${ctx.now().getTime() + ADMIN_TTL_MS}`);
export function readAdmin(ctx: Ctx, cookie: string | undefined, userId: number): boolean {
  const v = unsign(ctx, cookie);
  const m = v && /^a(\d+):(\d+)$/.exec(v);
  return !!m && Number(m[1]) === userId && Number(m[2]) > ctx.now().getTime();
}
export const ADMIN_TTL_SECONDS = ADMIN_TTL_MS / 1000;
