import type { User } from '@board/shared';
import { createUserSchema, updateUserSchema } from '@board/shared';
import { all, get, run, tx } from '../db/connection.ts';
import { bool, conflict, int, notFound, nowIso, type Ctx } from '../lib/core.ts';
import { reindexWhere } from './search.ts';

// colours with readable white initials (WCAG AA)
const PALETTE = ['#2563eb', '#9333ea', '#047857', '#b45309', '#be185d', '#0e7490', '#4d7c0f', '#dc2626'];

interface UserRow {
  id: number;
  name: string;
  initials: string;
  color: string;
  role: 'engineer' | 'manager';
  is_admin: number;
  active: number;
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  name: r.name,
  initials: r.initials,
  color: r.color,
  role: r.role,
  is_admin: bool(r.is_admin),
  active: bool(r.active),
});

export function deriveInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return name.trim().slice(0, 2).toUpperCase();
}

export function listUsers(ctx: Ctx, includeInactive = true): User[] {
  return all<UserRow>(
    ctx.db,
    `SELECT * FROM users ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY active DESC, role, name`,
  ).map(toUser);
}

export function getUser(ctx: Ctx, id: number): User | undefined {
  const r = get<UserRow>(ctx.db, 'SELECT * FROM users WHERE id = ?', id);
  return r ? toUser(r) : undefined;
}

export function requireUser(ctx: Ctx, id: number): User {
  const u = getUser(ctx, id);
  if (!u) throw notFound('User');
  return u;
}

export function createUser(ctx: Ctx, input: unknown): User {
  const data = createUserSchema(input);
  return tx(ctx.db, () => {
    if (get(ctx.db, 'SELECT 1 FROM users WHERE name = ?', data.name)) throw conflict(`A user called "${data.name}" already exists`);
    const count = get<{ n: number }>(ctx.db, 'SELECT COUNT(*) n FROM users')!.n;
    const res = run(
      ctx.db,
      'INSERT INTO users (name, initials, color, role, is_admin, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
      data.name,
      (data.initials ?? deriveInitials(data.name)).toUpperCase(),
      data.color ?? PALETTE[count % PALETTE.length],
      data.role,
      int(data.is_admin),
      nowIso(ctx),
    );
    ctx.events.emit({ type: 'users' });
    return getUser(ctx, Number(res.lastInsertRowid))!;
  });
}

export function updateUser(ctx: Ctx, id: number, input: unknown): User {
  const data = updateUserSchema(input);
  return tx(ctx.db, () => {
    const u = requireUser(ctx, id);
    if (data.name && get(ctx.db, 'SELECT 1 FROM users WHERE name = ? AND id <> ?', data.name, id))
      throw conflict(`A user called "${data.name}" already exists`);
    if (data.role === 'manager' && u.role === 'engineer') {
      // managers cannot hold claimed work; refuse rather than silently unassign
      const n = get<{ n: number }>(
        ctx.db,
        `SELECT COUNT(*) n FROM tickets WHERE assigned_to = ? AND status NOT IN ('done','cancelled') AND archived = 0`,
        id,
      )!.n;
      if (n > 0) throw conflict(`${u.name} still has ${n} open job(s). Reassign them before changing the role.`);
    }
    const next = {
      name: data.name ?? u.name,
      initials: (data.initials ?? (data.name ? deriveInitials(data.name) : u.initials)).toUpperCase(),
      color: data.color ?? u.color,
      role: data.role ?? u.role,
      is_admin: data.is_admin ?? u.is_admin,
      active: data.active ?? u.active,
    };
    run(
      ctx.db,
      'UPDATE users SET name = ?, initials = ?, color = ?, role = ?, is_admin = ?, active = ? WHERE id = ?',
      next.name,
      next.initials,
      next.color,
      next.role,
      int(next.is_admin),
      int(next.active),
      id,
    );
    if (next.name !== u.name) reindexWhere(ctx, 'assigned_to', id);
    ctx.events.emit({ type: 'users' });
    return getUser(ctx, id)!;
  });
}
