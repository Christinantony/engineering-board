// Projects (decision #30). None are preset: the team adds a project name the
// first time a job needs it, from the New job form or the Projects page. Every
// job created on the board belongs to one, so a job can be traced to its
// project and a project to all of its jobs. Names are unique regardless of
// case and spacing; projects are never deleted (their jobs' history needs them).

import { allows, projectSchema, type Project, type User } from '@board/shared';
import { getPermissions, PERMISSION_DENIED } from './permissions.ts';
import { all, get, run, tx } from '../db/connection.ts';
import { HttpError, badRequest, forbidden, notFound, nowIso, type Ctx } from '../lib/core.ts';

/** "  Telescope   mount " → "Telescope mount". */
export const cleanProjectName = (name: string) => name.replace(/\s+/g, ' ').trim();

const SELECT = `
  SELECT p.id, p.name, p.created_by, p.created_at,
    COUNT(t.id) AS total,
    COALESCE(SUM(t.archived = 0 AND t.status NOT IN ('done','cancelled')), 0) AS open
  FROM projects p
  LEFT JOIN ticket_projects tp ON tp.project_id = p.id
  LEFT JOIN tickets t ON t.id = tp.ticket_id`;

export function listProjects(ctx: Ctx): Project[] {
  return all<Project>(ctx.db, `${SELECT} GROUP BY p.id ORDER BY p.name COLLATE NOCASE`);
}

export function getProject(ctx: Ctx, id: number): Project {
  const p = get<Project>(ctx.db, `${SELECT} WHERE p.id = ? GROUP BY p.id`, id);
  if (!p) throw notFound('Project');
  return p;
}

export function findProjectByName(ctx: Ctx, name: string): { id: number; name: string } | undefined {
  return get<{ id: number; name: string }>(ctx.db, 'SELECT id, name FROM projects WHERE name = ?', cleanProjectName(name));
}

/** Add a project. A name that already exists (any case) is refused with the existing project. */
export function createProject(ctx: Ctx, actor: User | null, input: unknown, opts: { demo?: boolean } = {}): Project {
  if (actor && !allows(getPermissions(ctx), actor, 'create')) throw forbidden(PERMISSION_DENIED.create);
  const name = cleanProjectName(projectSchema(input).name);
  if (!name) throw badRequest('Give the project a name.');
  return tx(ctx.db, () => {
    const existing = findProjectByName(ctx, name);
    if (existing)
      throw new HttpError(409, 'project_exists', `There is already a project called "${existing.name}". Choose it from the list.`, {
        project: getProject(ctx, existing.id),
      });
    const res = run(
      ctx.db,
      'INSERT INTO projects (name, created_by, created_at, is_demo) VALUES (?, ?, ?, ?)',
      name,
      actor?.id ?? null,
      nowIso(ctx),
      opts.demo ? 1 : 0,
    );
    ctx.events.emit({ type: 'projects' });
    return getProject(ctx, Number(res.lastInsertRowid));
  });
}

export function requireProject(ctx: Ctx, id: number): { id: number; name: string } {
  const p = get<{ id: number; name: string }>(ctx.db, 'SELECT id, name FROM projects WHERE id = ?', id);
  if (!p) throw badRequest('That project does not exist. Choose one from the list, or add it.');
  return p;
}

export function projectIdsFor(ctx: Ctx, ticketIds: number[]): Map<number, number> {
  const map = new Map<number, number>();
  for (let i = 0; i < ticketIds.length; i += 500) {
    const chunk = ticketIds.slice(i, i + 500);
    if (!chunk.length) break;
    for (const r of all<{ ticket_id: number; project_id: number }>(
      ctx.db,
      `SELECT ticket_id, project_id FROM ticket_projects WHERE ticket_id IN (${chunk.map(() => '?').join(',')})`,
      ...chunk,
    ))
      map.set(r.ticket_id, r.project_id);
  }
  return map;
}

/** Set a job's project (inside the caller's transaction). Returns the old and new names when it changed. */
export function setTicketProject(ctx: Ctx, ticketId: number, projectId: number): { from: string | null; to: string } | null {
  const to = requireProject(ctx, projectId);
  const cur = get<{ project_id: number; name: string }>(
    ctx.db,
    'SELECT tp.project_id, p.name FROM ticket_projects tp JOIN projects p ON p.id = tp.project_id WHERE tp.ticket_id = ?',
    ticketId,
  );
  if (cur?.project_id === to.id) return null;
  run(
    ctx.db,
    'INSERT INTO ticket_projects (ticket_id, project_id) VALUES (?, ?) ON CONFLICT(ticket_id) DO UPDATE SET project_id = excluded.project_id',
    ticketId,
    to.id,
  );
  return { from: cur?.name ?? null, to: to.name };
}
