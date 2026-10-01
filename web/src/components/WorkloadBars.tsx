// Estimated hours per engineer as horizontal bars. A faint mark shows a
// "normal day's work" reference. It's a planning aid, not a capacity limit.

import type { WorkloadRow } from '@board/shared';
import { useApp } from '../context.ts';
import { hours } from '../lib/format.ts';
import { Badge } from './bits.tsx';

export interface WorkloadData {
  horizon: string;
  through: string;
  engineers: WorkloadRow[];
  unclaimed: { n: number; minutes: number; unestimated: number };
}

export function WorkloadBars({
  data,
  referenceMinutes,
  compact,
  onPick,
  picked,
}: {
  data: WorkloadData;
  referenceMinutes: number;
  compact?: boolean;
  onPick?: (userId: number) => void;
  picked?: number | null;
}) {
  const { user } = useApp();
  const max = Math.max(referenceMinutes * 1.25, ...data.engineers.map((e) => e.load_minutes), 60);
  const pct = (m: number) => `${Math.min(100, (m / max) * 100)}%`;
  return (
    <div className={`wl${compact ? ' wl-compact' : ''}`}>
      {data.engineers.map((e) => {
        const u = user(e.user_id);
        const over = e.load_minutes > referenceMinutes;
        const body = (
          <>
            <span className="wl-who">
              <Badge user={u} size="sm" />
              <span className="wl-name">{e.name}</span>
            </span>
            <span className="wl-track" title={`${e.name}: ${hours(e.load_minutes)} estimated`}>
              <span className={`wl-bar${over ? ' over' : ''}`} style={{ width: pct(e.load_minutes) }} />
              {referenceMinutes > 0 && <span className="wl-ref" style={{ left: pct(referenceMinutes) }} aria-hidden="true" />}
            </span>
            <span className="wl-value">
              <strong>{hours(e.load_minutes)}</strong>
              {e.unestimated > 0 && <span className="muted"> +{e.unestimated} not estimated</span>}
            </span>
            {!compact && (
              <span className="wl-facts">
                <span>{e.in_progress} in progress</span>
                <span>{e.assigned_open} open</span>
                {e.blocked > 0 && <span className="wl-warn">{e.blocked} waiting</span>}
                {e.overdue > 0 && <span className="wl-bad">{e.overdue} overdue</span>}
              </span>
            )}
          </>
        );
        return onPick ? (
          <button key={e.user_id} className={`wl-row${picked === e.user_id ? ' on' : ''}`} aria-expanded={picked === e.user_id} onClick={() => onPick(e.user_id)}>
            {body}
          </button>
        ) : (
          <div key={e.user_id} className="wl-row">
            {body}
          </div>
        );
      })}
      <div className="wl-row wl-unclaimed">
        <span className="wl-who">
          <span className="wl-name">Unclaimed</span>
        </span>
        <span className="wl-text">
          {data.unclaimed.n === 0
            ? 'Nothing waiting to be claimed'
            : `${data.unclaimed.n} ${data.unclaimed.n === 1 ? 'job' : 'jobs'}, about ${hours(data.unclaimed.minutes)}` +
              (data.unclaimed.unestimated ? ` plus ${data.unclaimed.unestimated} not estimated` : '')}
        </span>
      </div>
    </div>
  );
}

/** Working days × hours per day between today and the horizon end (inclusive). */
export function referenceMinutes(today: string, through: string, workday: { hours_per_day: number; working_days: number[] }) {
  let days = 0;
  const [y, m, d] = today.split('-').map(Number);
  for (let i = 0; i < 31; i++) {
    const dt = new Date(Date.UTC(y, m - 1, d + i));
    const iso = dt.toISOString().slice(0, 10);
    if (iso > through) break;
    if (workday.working_days.includes(dt.getUTCDay())) days++;
  }
  return Math.max(days, 1) * workday.hours_per_day * 60;
}
