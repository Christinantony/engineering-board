// Estimates against actual time (decision #36): how close the team's
// estimates are, by job type and by person, and what a type of job usually
// takes, so the next estimate can be better. Read from the jobs' own
// estimate and actual-time fields; nothing extra is stored.

import { compareToEstimate, bucketLabel } from '@board/shared';
import { all } from '../db/connection.ts';
import type { Ctx } from '../lib/core.ts';

export interface DoneJob {
  assigned_to: number | null;
  job_type_id: number | null;
  estimate_minutes: number | null;
  actual_minutes: number | null;
}

export interface AccuracyRow {
  key: number | null;
  name: string;
  /** Jobs finished with both an estimate and an actual time. */
  jobs: number;
  estimated_minutes: number;
  actual_minutes: number;
  within: number;
  longer: number;
  shorter: number;
  /** The middle value of actual ÷ estimate (1 = spot on), or null without jobs. */
  median_ratio: number | null;
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function group(jobs: DoneJob[], keyOf: (j: DoneJob) => number | null, nameOf: (k: number | null) => string): AccuracyRow[] {
  const map = new Map<number | null, DoneJob[]>();
  for (const j of jobs) {
    const k = keyOf(j);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(j);
  }
  return [...map.entries()]
    .map(([key, list]) => {
      const out = list.map((j) => compareToEstimate(j.estimate_minutes!, j.actual_minutes!));
      return {
        key,
        name: nameOf(key),
        jobs: list.length,
        estimated_minutes: list.reduce((s, j) => s + j.estimate_minutes!, 0),
        actual_minutes: list.reduce((s, j) => s + j.actual_minutes!, 0),
        within: out.filter((o) => o === 'within').length,
        longer: out.filter((o) => o === 'longer').length,
        shorter: out.filter((o) => o === 'shorter').length,
        median_ratio: (() => {
          const m = median(list.map((j) => j.actual_minutes! / Math.max(j.estimate_minutes!, 1)));
          return m == null ? null : Math.round(m * 100) / 100;
        })(),
      };
    })
    .sort((a, b) => b.jobs - a.jobs || a.name.localeCompare(b.name));
}

/** Accuracy of the finished jobs in a period, overall, by job type and by the person who held each job. */
export function estimateAccuracy(ctx: Ctx, done: DoneJob[]) {
  const both = done.filter((j) => j.estimate_minutes != null && j.actual_minutes != null);
  const types = new Map(all<{ id: number; name: string }>(ctx.db, 'SELECT id, name FROM job_types').map((t) => [t.id, t.name]));
  const users = new Map(all<{ id: number; name: string }>(ctx.db, 'SELECT id, name FROM users').map((u) => [u.id, u.name]));
  const overall = group(both, () => null, () => 'All jobs')[0] ?? null;
  return {
    done: done.length,
    with_actual: done.filter((j) => j.actual_minutes != null).length,
    compared: both.length,
    overall,
    by_type: group(both, (j) => j.job_type_id, (k) => (k == null ? 'No job type' : types.get(k) ?? 'Unknown')),
    by_person: group(both, (j) => j.assigned_to, (k) => (k == null ? 'Nobody' : users.get(k) ?? 'Unknown')),
  };
}

/** How far back "what this type of job usually takes" looks, and how many jobs it needs before it says anything. */
export const TYPICAL_DAYS = 180;
export const TYPICAL_MIN_JOBS = 3;

/** For each job type with enough finished jobs that recorded their time: the middle actual time and its estimate bucket. */
export function typicalTimes(ctx: Ctx): { job_type_id: number; jobs: number; median_minutes: number; label: string }[] {
  const since = new Date(ctx.now().getTime() - TYPICAL_DAYS * 86_400_000).toISOString();
  const rows = all<{ job_type_id: number; actual_minutes: number }>(
    ctx.db,
    `SELECT job_type_id, actual_minutes FROM tickets
     WHERE status = 'done' AND completed_at >= ? AND actual_minutes IS NOT NULL AND actual_minutes > 0 AND job_type_id IS NOT NULL`,
    since,
  );
  const by = new Map<number, number[]>();
  for (const r of rows) {
    if (!by.has(r.job_type_id)) by.set(r.job_type_id, []);
    by.get(r.job_type_id)!.push(r.actual_minutes);
  }
  return [...by.entries()]
    .filter(([, xs]) => xs.length >= TYPICAL_MIN_JOBS)
    .map(([job_type_id, xs]) => {
      const m = Math.round(median(xs)!);
      return { job_type_id, jobs: xs.length, median_minutes: m, label: bucketLabel(m) };
    })
    .sort((a, b) => a.job_type_id - b.job_type_id);
}
