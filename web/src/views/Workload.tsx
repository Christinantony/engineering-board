// "Are we overloaded?" — approximate, from estimates. Click a person to see their jobs.

import { useState } from 'react';
import type { Ticket } from '@board/shared';
import { useApp } from '../context.ts';
import { localDate } from '../lib/format.ts';
import { navigate, useLocation } from '../lib/router.ts';
import { useQuery } from '../lib/store.ts';
import { ErrorBox, Spinner } from '../components/bits.tsx';
import { JobRow } from '../components/JobRow.tsx';
import { WorkloadBars, referenceMinutes, type WorkloadData } from '../components/WorkloadBars.tsx';

const HORIZONS = [
  { v: 'today', label: 'Today' },
  { v: '3days', label: 'Next 3 days' },
  { v: 'week', label: 'This week' },
];

export function Workload() {
  const { meta } = useApp();
  const { params } = useLocation();
  const horizon = HORIZONS.some((h) => h.v === params.get('h')) ? params.get('h')! : 'today';
  const q = useQuery<WorkloadData>(`/api/workload?horizon=${horizon}`);
  const [picked, setPicked] = useState<number | null>(null);
  const jobs = useQuery<{ tickets: Ticket[] }>(picked ? `/api/tickets?assignee=${picked}&status=claimed,in_progress,waiting,blocked,review` : null);

  if (q.error && !q.data) return <ErrorBox message={q.error.message} retry={q.refresh} />;
  if (!q.data) return <Spinner label="Loading workload" />;
  const ref = referenceMinutes(localDate(), q.data.through, meta.workday);
  const through = q.data.through;
  const inHorizon = (t: Ticket) => (t.due_date ? t.due_date <= through : t.status === 'in_progress');

  return (
    <div className="view view-narrow">
      <header className="view-head">
        <div className="view-head-row">
          <h1>Team workload</h1>
          <div className="seg seg-tabs" role="tablist" aria-label="Time horizon">
            {HORIZONS.map((h) => (
              <button key={h.v} role="tab" aria-selected={h.v === horizon} className={h.v === horizon ? 'on' : ''} onClick={() => navigate(`/workload?h=${h.v}`)}>
                {h.label}
              </button>
            ))}
          </div>
        </div>
        <p className="view-lede">
          Estimated hours of work due by {horizon === 'today' ? 'the end of today' : `the end of ${new Date(through + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' })}`}, plus jobs
          in progress with no due date. Waiting and blocked jobs aren't counted in the hours. The faint line marks {meta.workday.hours_per_day} h per working day, as a
          rough guide.
        </p>
      </header>

      <WorkloadBars data={q.data} referenceMinutes={ref} onPick={(id) => setPicked(picked === id ? null : id)} picked={picked} />

      {picked && (
        <section className="vsection">
          <header className="vsection-head">
            <h2>Open jobs</h2>
          </header>
          {!jobs.data ? (
            <Spinner />
          ) : jobs.data.tickets.length === 0 ? (
            <p className="vsection-empty">No open jobs.</p>
          ) : (
            <div className="vsection-list">
              {[...jobs.data.tickets]
                .sort((a, b) => Number(inHorizon(b)) - Number(inHorizon(a)) || (a.due_date ?? '9').localeCompare(b.due_date ?? '9'))
                .map((t) => (
                  <div key={t.id} className={inHorizon(t) ? '' : 'outside-horizon'}>
                    <JobRow t={t} showAssignee={false} />
                  </div>
                ))}
            </div>
          )}
          <p className="muted hint">Faded jobs are due later than this time window, so they aren't in the hours above.</p>
        </section>
      )}
    </div>
  );
}
