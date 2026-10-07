// Role capabilities (decision #31): what engineers, managers and reviewers may
// do with jobs, set by the admin. Stored as one JSON setting; the defaults are
// the rules the board shipped with. Board review is not governed here.

import { CAPABILITIES, DEFAULT_PERMISSIONS, ROLES, allows, permissionsSchema, type Capability, type RolePermissions, type User } from '@board/shared';
import { all, get } from '../db/connection.ts';
import { conflict, forbidden, type Ctx } from '../lib/core.ts';
import { getSetting, setSetting } from './auth.ts';

const KEY = 'role_permissions';

/** The current rules: the saved setting, with the defaults filling anything missing or unreadable. */
export function getPermissions(ctx: Ctx): RolePermissions {
  const raw = getSetting(ctx, KEY);
  let saved: Partial<Record<string, Partial<Record<string, unknown>>>> = {};
  if (raw) {
    try {
      saved = JSON.parse(raw) ?? {};
    } catch {
      saved = {};
    }
  }
  const out = {} as RolePermissions;
  for (const role of ROLES) {
    out[role] = {} as RolePermissions[typeof role];
    for (const cap of CAPABILITIES) {
      const v = saved[role]?.[cap];
      out[role][cap] = typeof v === 'boolean' ? v : DEFAULT_PERMISSIONS[role][cap];
    }
  }
  return out;
}

/**
 * Save new rules. Taking "claim" away from a role whose members still hold open
 * jobs is refused (reassign first), the same rule as changing one person's role.
 */
export function setPermissions(ctx: Ctx, input: unknown): RolePermissions {
  const next = permissionsSchema(input);
  const now = getPermissions(ctx);
  const losing = ROLES.filter((r) => now[r].claim && !next[r].claim);
  if (losing.length) {
    const rows = all<{ role: string; n: number }>(
      ctx.db,
      `SELECT u.role role, COUNT(*) n FROM tickets t JOIN users u ON u.id = t.assigned_to
       WHERE t.status NOT IN ('done','cancelled') AND t.archived = 0 AND u.role IN (${losing.map(() => '?').join(',')}) GROUP BY u.role`,
      ...losing,
    );
    if (rows.length)
      throw conflict(
        `${rows.map((r) => `${r.role === 'engineer' ? 'Engineers' : r.role === 'manager' ? 'Managers' : 'Reviewers'} still hold ${r.n} open job(s)`).join('; ')}. Reassign them before taking "claim" away.`,
      );
  }
  setSetting(ctx, KEY, JSON.stringify(next));
  ctx.events.emit({ type: 'permissions' });
  return next;
}

export const PERMISSION_DENIED: Record<Capability, string> = {
  create: 'Your role cannot create jobs. The admin sets this under Admin → Roles.',
  claim: 'Your role cannot claim or be assigned jobs. The admin sets this under Admin → Roles.',
  edit: 'Your role cannot change this job. The admin sets this under Admin → Roles.',
};

export function requireCapability(ctx: Ctx, user: User, cap: Capability): void {
  if (!allows(getPermissions(ctx), user, cap)) throw forbidden(PERMISSION_DENIED[cap]);
}

/** Roles that may hold jobs right now (for lists of people who can be assigned work). */
export function claimingRoles(ctx: Ctx): string[] {
  const p = getPermissions(ctx);
  return ROLES.filter((r) => p[r].claim);
}

/** Open jobs held by one person (used before a role or rule change takes "claim" away). */
export function openJobsHeldBy(ctx: Ctx, userId: number): number {
  return get<{ n: number }>(ctx.db, `SELECT COUNT(*) n FROM tickets WHERE assigned_to = ? AND status NOT IN ('done','cancelled') AND archived = 0`, userId)!.n;
}
