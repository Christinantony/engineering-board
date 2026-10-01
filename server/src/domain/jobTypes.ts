import type { JobType } from '@board/shared';
import { jobTypeSchema } from '@board/shared';
import { all, get, run, tx } from '../db/connection.ts';
import { bool, conflict, int, notFound, type Ctx } from '../lib/core.ts';
import { reindexWhere } from './search.ts';

interface Row {
  id: number;
  name: string;
  sort_order: number;
  active: number;
}
const toJobType = (r: Row): JobType => ({ id: r.id, name: r.name, sort_order: r.sort_order, active: bool(r.active) });

export function listJobTypes(ctx: Ctx): JobType[] {
  return all<Row>(ctx.db, 'SELECT * FROM job_types ORDER BY active DESC, sort_order, name').map(toJobType);
}

export function createJobType(ctx: Ctx, input: unknown): JobType {
  const data = jobTypeSchema(input);
  return tx(ctx.db, () => {
    if (get(ctx.db, 'SELECT 1 FROM job_types WHERE name = ?', data.name)) throw conflict(`Job type "${data.name}" already exists`);
    const max = get<{ m: number | null }>(ctx.db, 'SELECT MAX(sort_order) m FROM job_types')!.m ?? 0;
    const res = run(
      ctx.db,
      'INSERT INTO job_types (name, sort_order, active) VALUES (?, ?, ?)',
      data.name,
      data.sort_order ?? max + 10,
      int(data.active ?? true),
    );
    ctx.events.emit({ type: 'job_types' });
    return toJobType(get<Row>(ctx.db, 'SELECT * FROM job_types WHERE id = ?', Number(res.lastInsertRowid))!);
  });
}

export function updateJobType(ctx: Ctx, id: number, input: unknown): JobType {
  return tx(ctx.db, () => {
    const cur = get<Row>(ctx.db, 'SELECT * FROM job_types WHERE id = ?', id);
    if (!cur) throw notFound('Job type');
    const data = jobTypeSchema({ name: cur.name, ...(input as object) });
    if (get(ctx.db, 'SELECT 1 FROM job_types WHERE name = ? AND id <> ?', data.name, id)) throw conflict(`Job type "${data.name}" already exists`);
    run(
      ctx.db,
      'UPDATE job_types SET name = ?, sort_order = ?, active = ? WHERE id = ?',
      data.name,
      data.sort_order ?? cur.sort_order,
      int(data.active ?? bool(cur.active)),
      id,
    );
    if (data.name !== cur.name) reindexWhere(ctx, 'job_type_id', id);
    ctx.events.emit({ type: 'job_types' });
    return toJobType(get<Row>(ctx.db, 'SELECT * FROM job_types WHERE id = ?', id)!);
  });
}
