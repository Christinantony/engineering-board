// Ordering of cards within a column (board_rank) and within an engineer's
// "My Work" list (my_rank). Ranks are floats; a card dropped between two
// others gets the midpoint. When gaps get too small the scope is renumbered.

import { all, get, run, type Param } from '../db/connection.ts';
import type { Status } from '@board/shared';
import { OPEN_STATUSES } from '@board/shared';
import type { Ctx } from '../lib/core.ts';

const STEP = 1024;
const MIN_GAP = 1e-6;

export type RankField = 'board_rank' | 'my_rank';
export interface Scope {
  field: RankField;
  where: string;
  params: Param[];
}

/** Waiting and Blocked share one board column. */
export function columnStatuses(status: Status): Status[] {
  return status === 'waiting' || status === 'blocked' ? ['waiting', 'blocked'] : [status];
}

export function boardScope(status: Status): Scope {
  const st = columnStatuses(status);
  return { field: 'board_rank', where: `archived = 0 AND status IN (${st.map(() => '?').join(',')})`, params: st };
}

export function myScope(userId: number): Scope {
  return {
    field: 'my_rank',
    where: `archived = 0 AND assigned_to = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})`,
    params: [userId, ...OPEN_STATUSES],
  };
}

function rankOf(ctx: Ctx, s: Scope, id: number | null | undefined, selfId: number): number | undefined {
  if (!id || id === selfId) return undefined;
  return get<{ r: number }>(ctx.db, `SELECT ${s.field} r FROM tickets WHERE id = ? AND ${s.where}`, id, ...s.params)?.r;
}

function renumber(ctx: Ctx, s: Scope) {
  const rows = all<{ id: number }>(ctx.db, `SELECT id FROM tickets WHERE ${s.where} ORDER BY ${s.field}, id`, ...s.params);
  rows.forEach((r, i) => run(ctx.db, `UPDATE tickets SET ${s.field} = ? WHERE id = ?`, (i + 1) * STEP, r.id));
}

function compute(ctx: Ctx, s: Scope, selfId: number, beforeId?: number | null, afterId?: number | null): number | null {
  const rb = rankOf(ctx, s, beforeId, selfId); // card that will be ABOVE
  const ra = rankOf(ctx, s, afterId, selfId); // card that will be BELOW
  const ex = `AND id <> ?`;
  let lo: number | undefined;
  let hi: number | undefined;
  if (rb !== undefined && ra !== undefined && rb < ra) {
    lo = rb;
    hi = ra;
  } else if (rb !== undefined) {
    lo = rb;
    hi = get<{ r: number | null }>(ctx.db, `SELECT MIN(${s.field}) r FROM tickets WHERE ${s.where} AND ${s.field} > ? ${ex}`, ...s.params, rb, selfId)!.r ?? undefined;
  } else if (ra !== undefined) {
    hi = ra;
    lo = get<{ r: number | null }>(ctx.db, `SELECT MAX(${s.field}) r FROM tickets WHERE ${s.where} AND ${s.field} < ? ${ex}`, ...s.params, ra, selfId)!.r ?? undefined;
  } else {
    const top = get<{ r: number | null }>(ctx.db, `SELECT MIN(${s.field}) r FROM tickets WHERE ${s.where} ${ex}`, ...s.params, selfId)!.r;
    return top == null ? STEP : top - STEP;
  }
  if (lo === undefined) return hi! - STEP;
  if (hi === undefined) return lo + STEP;
  if (hi - lo < MIN_GAP) return null;
  return (lo + hi) / 2;
}

/** Rank for placing `selfId` between `beforeId` (above) and `afterId` (below); top of scope if neither. */
export function rankFor(ctx: Ctx, s: Scope, selfId: number, beforeId?: number | null, afterId?: number | null): number {
  const r = compute(ctx, s, selfId, beforeId, afterId);
  if (r !== null) return r;
  renumber(ctx, s);
  return compute(ctx, s, selfId, beforeId, afterId) ?? 0;
}

/** Rank that puts a card at the bottom of a scope. */
export function bottomRank(ctx: Ctx, s: Scope, selfId: number): number {
  const max = get<{ r: number | null }>(ctx.db, `SELECT MAX(${s.field}) r FROM tickets WHERE ${s.where} AND id <> ?`, ...s.params, selfId)!.r;
  return max == null ? STEP : max + STEP;
}
