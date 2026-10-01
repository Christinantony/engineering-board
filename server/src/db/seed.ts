import { DEFAULT_JOB_TYPES, type User } from '@board/shared';
import { all, get, run, tx } from './connection.ts';
import type { Ctx } from '../lib/core.ts';
import { createTicket, claimTicket, moveTicket, updateTicket, addComment } from '../domain/tickets.ts';
import { listUsers } from '../domain/users.ts';
import { rebuildIndex } from '../domain/search.ts';
import { addDays, localDate } from '../lib/time.ts';

export const INITIAL_USERS = [
  { name: 'Christin', initials: 'CH', color: '#2563eb', role: 'engineer', is_admin: 1 },
  { name: 'Paul', initials: 'PA', color: '#9333ea', role: 'engineer', is_admin: 0 },
  { name: 'Allen', initials: 'AL', color: '#059669', role: 'engineer', is_admin: 0 },
  { name: 'Jeffin', initials: 'JE', color: '#d97706', role: 'manager', is_admin: 0 },
] as const;

/** First-run data: team members and default job types. Safe to call on every start. */
export function seedBase(ctx: Ctx) {
  tx(ctx.db, () => {
    const now = ctx.now().toISOString();
    if (get<{ n: number }>(ctx.db, 'SELECT COUNT(*) n FROM users')!.n === 0) {
      for (const u of INITIAL_USERS)
        run(
          ctx.db,
          'INSERT INTO users (name, initials, color, role, is_admin, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
          u.name,
          u.initials,
          u.color,
          u.role,
          u.is_admin,
          now,
        );
    }
    if (get<{ n: number }>(ctx.db, 'SELECT COUNT(*) n FROM job_types')!.n === 0) {
      DEFAULT_JOB_TYPES.forEach((name, i) => run(ctx.db, 'INSERT INTO job_types (name, sort_order) VALUES (?, ?)', name, (i + 1) * 10));
    }
  });
}

export function hasDemoData(ctx: Ctx): boolean {
  return !!get(ctx.db, 'SELECT 1 FROM tickets WHERE is_demo = 1 LIMIT 1');
}

/** Realistic demo jobs across every column. Marked is_demo so they can be cleared. */
export function seedDemo(ctx: Ctx): number {
  const users = listUsers(ctx).filter((u) => u.active);
  const by = (name: string) => users.find((u) => u.name === name) ?? users[0];
  const eng = users.filter((u) => u.role === 'engineer');
  const [e1, e2, e3] = [eng[0], eng[1] ?? eng[0], eng[2] ?? eng[0]];
  const mgr = users.find((u) => u.role === 'manager') ?? e1;
  const jt = new Map(all<{ id: number; name: string }>(ctx.db, 'SELECT id, name FROM job_types').map((r) => [r.name, r.id]));
  const today = localDate(ctx.now().getTime(), ctx.tz);
  const d = (n: number) => addDays(today, n);

  type Spec = {
    title: string;
    description: string;
    type: string;
    priority?: 'urgent' | 'high' | 'normal' | 'low';
    est?: number;
    due?: string;
    dueTime?: string;
    requester?: string;
    notes?: string;
    file?: string;
    reference?: string;
    tags?: string[];
    creator: User;
    owner?: User;
    path?: ('in_progress' | 'waiting' | 'blocked' | 'review' | 'done')[];
    reason?: string;
    comment?: string;
  };

  const specs: Spec[] = [
    { title: 'Repair imported STEP geometry', description: 'Customer STEP has gaps and sliver faces; needs to be watertight for meshing.', type: 'STEP/IGES Cleanup', priority: 'high', est: 45, due: d(0), requester: 'Production', file: '\\\\SERVER\\Projects\\ACME\\Inbound\\housing_v2.step', tags: ['STEP', 'customer-A'], creator: mgr },
    { title: 'Revise pump housing drawing', description: 'Update hole callouts per ECN-112 and bump to Rev D.', type: 'Drawing Revision', est: 90, due: d(1), requester: 'Quality', reference: 'DWG-4410 Rev C', tags: ['drawing'], creator: mgr, owner: e1, path: ['in_progress'], comment: 'Started on sheet 2 callouts.' },
    { title: 'Bracket redesign', description: 'Lighten the motor bracket by ~20% while keeping stiffness.', type: 'CAD Modification', priority: 'high', est: 180, due: d(0), dueTime: '17:00', tags: ['prototype'], creator: e1, owner: e1, path: ['in_progress'] },
    { title: 'Run FEA on mounting plate', description: 'Static + modal on the 6 mm plate. Check first mode > 80 Hz.', type: 'FEA', est: 360, due: d(3), notes: 'ANSYS model:\n\\\\SERVER\\FEA\\Plate_ABC\n\nUse bonded contacts for the welds.', tags: ['ANSYS'], creator: mgr, owner: e2 },
    { title: 'Customer drawing revision', description: 'Customer wants tolerances tightened on the bore.', type: 'Drawing Revision', priority: 'normal', est: 60, due: d(-1), requester: 'Sales — Customer A', tags: ['customer-A'], creator: mgr, owner: e2, path: ['in_progress', 'waiting'], reason: 'Customer to confirm bore tolerance (H7 or H8)' },
    { title: 'Clean up overlapping ANSYS surfaces', description: 'SpaceClaim share-topology fails on the manifold.', type: 'Geometry Repair', est: 120, creator: e3, owner: e3, path: ['in_progress', 'blocked'], reason: 'Need original Creo model from supplier', tags: ['ANSYS'] },
    { title: 'Prepare manufacturing drawing', description: 'Flat pattern + bend table for the enclosure lid.', type: 'Drawing', est: 120, due: d(2), tags: ['machine-shop'], creator: mgr, owner: e3, path: ['in_progress', 'review'] },
    { title: 'Investigate interference issue', description: 'Assembly shows 0.4 mm clash between cover and PCB standoffs.', type: 'Engineering Analysis', priority: 'urgent', est: 60, due: d(0), requester: 'Assembly line', creator: mgr },
    { title: 'Update BOM for pump skid', description: 'Add new fasteners and remove obsolete gasket.', type: 'BOM', priority: 'low', est: 30, creator: e2, owner: e2, path: ['in_progress', 'review', 'done'] },
    { title: 'Hand calc: shaft key stress', description: 'Check keyway shear for 15 kW motor at 1450 rpm.', type: 'Design Calculation', est: 45, creator: e1, owner: e1, path: ['done'] },
    { title: 'CFD on inlet duct', description: 'Pressure drop at 2 m³/s; compare two inlet radii.', type: 'CFD', est: 720, due: d(6), creator: mgr },
    { title: 'Prototype jig for weld fixture', description: 'Quick 3D-printed locating jig for the frame welds.', type: 'Prototype Support', priority: 'low', est: 90, creator: e3, owner: e3 },
  ];

  let count = 0;
  tx(ctx.db, () => {
    for (const s of specs) {
      const { ticket } = createTicket(ctx, s.creator, {
        title: s.title,
        description: s.description,
        priority: s.priority ?? 'normal',
        job_type_id: jt.get(s.type) ?? null,
        estimate_minutes: s.est ?? null,
        due_date: s.due ?? null,
        due_time: s.dueTime ?? null,
        requester: s.requester ?? '',
        notes: s.notes ?? '',
        file_location: s.file ?? '',
        reference: s.reference ?? '',
        tags: s.tags ?? [],
      });
      run(ctx.db, 'UPDATE tickets SET is_demo = 1 WHERE id = ?', ticket.id);
      count++;
      if (!s.owner) continue;
      claimTicket(ctx, s.owner, ticket.id);
      let status = 'claimed';
      for (const step of s.path ?? []) {
        moveTicket(ctx, s.owner, ticket.id, { status: step, from_status: status, reason: s.reason });
        status = step;
      }
      if (s.comment) addComment(ctx, s.owner, ticket.id, { body: s.comment });
    }
    // a small edit so the activity timeline shows a field change
    const first = get<{ id: number; version: number }>(ctx.db, `SELECT id, version FROM tickets WHERE is_demo = 1 AND title = 'Bracket redesign'`);
    if (first) updateTicket(ctx, by('Jeffin'), first.id, { version: first.version, priority: 'urgent' });
  });
  ctx.events.flush();
  return count;
}

/** Remove every demo ticket (and its history). Real tickets are untouched. */
export function clearDemo(ctx: Ctx): number {
  const n = tx(ctx.db, () => {
    const ids = all<{ id: number }>(ctx.db, 'SELECT id FROM tickets WHERE is_demo = 1').map((r) => r.id);
    if (!ids.length) return 0;
    const list = ids.join(',');
    run(ctx.db, `UPDATE tickets SET parent_job_id = NULL WHERE parent_job_id IN (${list})`);
    run(ctx.db, `DELETE FROM activity WHERE ticket_id IN (${list})`);
    run(ctx.db, `DELETE FROM ticket_tags WHERE ticket_id IN (${list})`);
    run(ctx.db, `DELETE FROM idempotency WHERE ticket_id IN (${list})`);
    run(ctx.db, `DELETE FROM tickets WHERE id IN (${list})`);
    run(ctx.db, `DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM ticket_tags)`);
    // restart numbering only if no real tickets exist
    if (get<{ n: number }>(ctx.db, 'SELECT COUNT(*) n FROM tickets')!.n === 0) run(ctx.db, `DELETE FROM counters WHERE name = 'job'`);
    rebuildIndex(ctx);
    return ids.length;
  });
  ctx.events.emit({ type: 'reload' });
  ctx.events.flush();
  return n;
}
