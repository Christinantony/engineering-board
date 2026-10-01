// Simple LAN authentication:
//  * "Who are you?" — the user picks their name; a signed cookie remembers it.
//  * Admin area — unlocked with a PIN (stored as a salted scrypt hash).
// Isolated here so real passwords/SSO can replace it later.

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { get, run } from '../db/connection.ts';
import type { Ctx } from '../lib/core.ts';

export const DEFAULT_PIN = '1234';
const ADMIN_TTL_MS = 12 * 3600_000;

export function getSetting(ctx: Ctx, key: string): string | undefined {
  return get<{ value: string }>(ctx.db, 'SELECT value FROM settings WHERE key = ?', key)?.value;
}
export function setSetting(ctx: Ctx, key: string, value: string) {
  run(ctx.db, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

function hashPin(pin: string, salt = randomBytes(16).toString('hex')): string {
  return `scrypt$${salt}$${scryptSync(pin, salt, 32).toString('hex')}`;
}

export function ensureAuthSettings(ctx: Ctx) {
  if (!getSetting(ctx, 'cookie_secret')) setSetting(ctx, 'cookie_secret', randomBytes(32).toString('hex'));
  if (!getSetting(ctx, 'admin_pin')) {
    setSetting(ctx, 'admin_pin', hashPin(DEFAULT_PIN));
    setSetting(ctx, 'admin_pin_is_default', '1');
  }
}

export function verifyPin(ctx: Ctx, pin: string): boolean {
  const stored = getSetting(ctx, 'admin_pin');
  if (!stored) return false;
  const [, salt, hash] = stored.split('$');
  const candidate = scryptSync(pin, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function changePin(ctx: Ctx, newPin: string) {
  setSetting(ctx, 'admin_pin', hashPin(newPin));
  setSetting(ctx, 'admin_pin_is_default', '0');
}

export const pinIsDefault = (ctx: Ctx) => getSetting(ctx, 'admin_pin_is_default') === '1';

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

export const sessionCookie = (ctx: Ctx, userId: number) => sign(ctx, `u${userId}`);
export function readSession(ctx: Ctx, cookie: string | undefined): number | null {
  const v = unsign(ctx, cookie);
  return v && /^u\d+$/.test(v) ? Number(v.slice(1)) : null;
}

export const adminCookie = (ctx: Ctx, userId: number) => sign(ctx, `a${userId}:${ctx.now().getTime() + ADMIN_TTL_MS}`);
export function readAdmin(ctx: Ctx, cookie: string | undefined, userId: number): boolean {
  const v = unsign(ctx, cookie);
  const m = v && /^a(\d+):(\d+)$/.exec(v);
  return !!m && Number(m[1]) === userId && Number(m[2]) > ctx.now().getTime();
}
export const ADMIN_TTL_SECONDS = ADMIN_TTL_MS / 1000;
