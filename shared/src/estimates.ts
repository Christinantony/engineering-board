// Estimates against actual time (decision #36): shared by the server's report
// and the web app's time entry.

import { ESTIMATE_BUCKETS, estimateLabel } from './constants.ts';

/** Which estimate bucket a number of minutes falls in (0 = "< 15 min"). */
export function bucketIndex(minutes: number): number {
  const i = ESTIMATE_BUCKETS.findIndex((b) => minutes <= b.max);
  return i === -1 ? ESTIMATE_BUCKETS.length - 1 : i;
}

export type EstimateOutcome = 'within' | 'longer' | 'shorter';

/**
 * How a job's actual time compares with its estimate. Estimates are buckets
 * (2–4 hr, 4–8 hr…), so a job is "within" when the time it took falls in the
 * bucket that was chosen, "longer" or "shorter" otherwise.
 */
export function compareToEstimate(estimateMinutes: number, actualMinutes: number): EstimateOutcome {
  const e = bucketIndex(estimateMinutes);
  const a = bucketIndex(actualMinutes);
  return a === e ? 'within' : a > e ? 'longer' : 'shorter';
}

/** The label of the bucket a number of minutes falls in, such as "4–8 hr". */
export const bucketLabel = (minutes: number) => estimateLabel(minutes)!;

/** A time as people write it, and as parseDuration reads it back: "45m", "3h", "3h 30m". */
export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes - h * 60);
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/**
 * Read a time as people type it: "90", "90 min", "1.5h", "3h 30m", "2 h 15",
 * "1d" (a working day of `hoursPerDay`). Returns whole minutes, or null when
 * it can't be read. A bare number is minutes.
 */
export function parseDuration(text: string, hoursPerDay = 8): number | null {
  const s = text.trim().toLowerCase().replace(/,/g, '.');
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
  }
  const re = /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m)?\s*/gy;
  let total = 0;
  let matched = 0;
  let m: RegExpExecArray | null;
  while (re.lastIndex < s.length && (m = re.exec(s))) {
    if (!m[0]) break;
    const n = Number(m[1]);
    // a number without a unit is minutes ("2 h 15" is 2 h 15 min)
    const unit = m[2] ?? 'm';
    const u = unit.startsWith('d') ? 'd' : unit.startsWith('h') ? 'h' : 'm';
    total += u === 'd' ? n * hoursPerDay * 60 : u === 'h' ? n * 60 : n;
    matched = re.lastIndex;
  }
  if (matched !== s.length) return null;
  return Math.round(total);
}
