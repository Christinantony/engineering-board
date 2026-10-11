// Lightweight reports: what got done, what kind of work, how long jobs take.

import { useState } from 'react';
import { useApp } from '../context.ts';
import { hours, localDate } from '../lib/format.ts';
import { navigate, useLocation } from '../lib/router.ts';
import { useQuery } from '../lib/store.ts';
import { Badge, ErrorBox, Spinner } from '../components/bits.tsx';

interface ReportData {
  from: string;
  to: string;
  completed: number;
  created: number;
  open_now: number;
  overdue_now: number;
  lead_time_hours: { average: number | null; median: number | null };
  work_time_hours: { average: number | null; median: number | null; jobs: number };
  estimate_vs_actual: { jobs: number; estimated_minutes: number; actual_minutes: number };
  estimate_accuracy: { done: number; with_actual: number; compared: number; overall: Accuracy | null; by_type: Accuracy[]; by_person: Accuracy[] };
  by_engineer: { user_id: number; name: string; completed: number; estimated_minutes: number; open_now: number }[];
  by_type: { job_type: string; completed: number; created: number }[];
  per_day: { date: string; completed: number }[];
}

interface Accuracy {
  key: number | null;
  name: string;
  jobs: number;
  estimated_minutes: number;
  actual_minutes: number;
  within: number;
  longer: number;
  shorter: number;
  median_ratio: number | null;
}

function addDays(date: string, n: number) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function startOfWeek(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(date, dow === 0 ? -6 : 1 - dow);
}

function ranges(today: string) {
  const sow = startOfWeek(today);
  const som = today.slice(0, 8) + '01';
  const lastMonthEnd = addDays(som, -1);
  return [
    { id: 'week', label: 'This week', from: sow, to: today },
    { id: 'lastweek', label: 'Last week', from: addDays(sow, -7), to: addDays(sow, -1) },
    { id: 'month', label: 'This month', from: som, to: today },
    { id: 'lastmonth', label: 'Last month', from: lastMonthEnd.slice(0, 8) + '01', to: lastMonthEnd },
    { id: '30d', label: 'Last 30 days', from: addDays(today, -29), to: today },
  ];
}

const fmtDate = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtHours = (h: number | null) =>
  h == null ? '—' : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${h} h` : `${Math.round((h / 24) * 10) / 10} days`;

export function Reports() {
  const { user } = useApp();
  const { params } = useLocation();
  const today = localDate();
  const presets = ranges(today);
  const preset = presets.find((p) => p.id === (params.get('r') ?? 'week'));
  const from = preset?.from ?? params.get('from') ?? presets[0].from;
  const to = preset?.to ?? params.get('to') ?? today;
  const q = useQuery<ReportData>(`/api/reports?from=${from}&to=${to}`);
  const [cf, setCf] = useState(from);
  const [ct, setCt] = useState(to);

  return (
    <div className="view view-narrow">
      <header className="view-head">
        <div className="view-head-row">
          <h1>Reports</h1>
          <div className="seg seg-tabs" role="tablist" aria-label="Period">
            {presets.map((p) => (
              <button key={p.id} role="tab" aria-selected={preset?.id === p.id} className={preset?.id === p.id ? 'on' : ''} onClick={() => navigate(`/reports?r=${p.id}`)}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <form
          className="range-form"
          onSubmit={(e: any) => {
            e.preventDefault();
            if (cf && ct) navigate(`/reports?r=custom&from=${cf}&to=${ct}`);
          }}
        >
          <label>
            From <input type="date" className="field-input" value={cf} onChange={(e: any) => setCf(e.target.value)} />
          </label>
          <label>
            to <input type="date" className="field-input" value={ct} onChange={(e: any) => setCt(e.target.value)} />
          </label>
          <button className="btn" type="submit">
            Show
          </button>
          <span className="muted">
            {fmtDate(from)} to {fmtDate(to)}
          </span>
        </form>
      </header>

      {q.error && !q.data ? (
        <ErrorBox message={q.error.message} retry={q.refresh} />
      ) : !q.data ? (
        <Spinner label="Working out the numbers" />
      ) : (
        <ReportBody r={q.data} user={user} />
      )}
    </div>
  );
}

function ReportBody({ r, user }: { r: ReportData; user: ReturnType<typeof useApp>['user'] }) {
  const maxDay = Math.max(1, ...r.per_day.map((d) => d.completed));
  const maxType = Math.max(1, ...r.by_type.map((t) => t.completed));
  return (
    <>
      <div className="tally tally-quiet">
        <div className="tally-item">
          <span className="tally-n">{r.completed}</span>
          <span className="tally-label">jobs completed</span>
        </div>
        <div className="tally-item">
          <span className="tally-n">{r.created}</span>
          <span className="tally-label">jobs created</span>
        </div>
        <div className="tally-item">
          <span className="tally-n">{fmtHours(r.lead_time_hours.median)}</span>
          <span className="tally-label">typical time from request to done</span>
        </div>
        <div className="tally-item">
          <span className="tally-n">{r.open_now}</span>
          <span className="tally-label">open right now ({r.overdue_now} overdue)</span>
        </div>
      </div>

      {r.per_day.length > 1 && r.per_day.length <= 62 && (
        <section className="vsection">
          <header className="vsection-head">
            <h2>Completed per day</h2>
          </header>
          <div className="daybars" role="img" aria-label="Jobs completed per day">
            {r.per_day.map((d) => (
              <div key={d.date} className="daybar" title={`${fmtDate(d.date)}: ${d.completed} completed`}>
                <span className="daybar-fill" style={{ height: `${(d.completed / maxDay) * 100}%` }} />
                {d.completed > 0 && r.per_day.length <= 14 && <span className="daybar-n">{d.completed}</span>}
                {r.per_day.length <= 14 && <span className="daybar-x">{new Date(d.date + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })}</span>}
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="dash-grid">
        <section className="vsection">
          <header className="vsection-head">
            <h2>By engineer</h2>
          </header>
          <table className="table">
            <thead>
              <tr>
                <th>Engineer</th>
                <th className="num">Completed</th>
                <th className="num">Estimated work done</th>
                <th className="num">Open now</th>
              </tr>
            </thead>
            <tbody>
              {r.by_engineer.map((e) => (
                <tr key={e.user_id}>
                  <td>
                    <span className="cell-who">
                      <Badge user={user(e.user_id)} size="sm" /> {e.name}
                    </span>
                  </td>
                  <td className="num">{e.completed}</td>
                  <td className="num">{e.estimated_minutes ? hours(e.estimated_minutes) : '—'}</td>
                  <td className="num">{e.open_now}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="vsection">
          <header className="vsection-head">
            <h2>By job type</h2>
          </header>
          {r.by_type.length === 0 ? (
            <p className="vsection-empty">No jobs in this period.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Job type</th>
                  <th className="num">Completed</th>
                  <th className="num">Created</th>
                </tr>
              </thead>
              <tbody>
                {r.by_type.map((t) => (
                  <tr key={t.job_type}>
                    <td>
                      <span className="cell-bar">
                        <span className="cell-bar-fill" style={{ width: `${(t.completed / maxType) * 100}%` }} />
                        <span>{t.job_type}</span>
                      </span>
                    </td>
                    <td className="num">{t.completed}</td>
                    <td className="num">{t.created}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <section className="vsection">
        <header className="vsection-head">
          <h2>How long jobs take</h2>
        </header>
        <dl className="facts">
          <div>
            <dt>Request to done</dt>
            <dd>
              typically {fmtHours(r.lead_time_hours.median)} (average {fmtHours(r.lead_time_hours.average)})
            </dd>
          </div>
          <div>
            <dt>Started to done</dt>
            <dd>
              {r.work_time_hours.jobs
                ? `typically ${fmtHours(r.work_time_hours.median)} (average ${fmtHours(r.work_time_hours.average)}, from ${r.work_time_hours.jobs} ${r.work_time_hours.jobs === 1 ? 'job' : 'jobs'} that went through In progress)`
                : 'No completed jobs went through In progress in this period.'}
            </dd>
          </div>
        </dl>
      </section>

      <EstimateAccuracy a={r.estimate_accuracy} />
    </>
  );
}

const ratioText = (x: number | null) =>
  x == null ? '—' : Math.abs(x - 1) < 0.05 ? 'on estimate' : x > 1 ? `${Math.round((x - 1) * 100)}% longer` : `${Math.round((1 - x) * 100)}% shorter`;

function AccuracyTable({ rows, first }: { rows: Accuracy[]; first: string }) {
  return (
    <table className="table accuracy-table">
      <thead>
        <tr>
          <th>{first}</th>
          <th className="num">Jobs</th>
          <th>Within / longer / shorter</th>
          <th className="num">Usually</th>
          <th className="num">Estimated</th>
          <th className="num">Actual</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((x) => (
          <tr key={`${x.key}`}>
            <td>{x.name}</td>
            <td className="num">{x.jobs}</td>
            <td>
              <span className="acc-bar" role="img" aria-label={`${x.within} within, ${x.longer} longer, ${x.shorter} shorter`}>
                <span className="acc-within" style={{ flexGrow: x.within }} />
                <span className="acc-longer" style={{ flexGrow: x.longer }} />
                <span className="acc-shorter" style={{ flexGrow: x.shorter }} />
              </span>
              <span className="muted small">
                {x.within} · {x.longer} · {x.shorter}
              </span>
            </td>
            <td className="num">{ratioText(x.median_ratio)}</td>
            <td className="num">{hours(x.estimated_minutes)}</td>
            <td className="num">{hours(x.actual_minutes)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** How close estimates were (decision #36). */
function EstimateAccuracy({ a }: { a: ReportData['estimate_accuracy'] }) {
  return (
    <section className="vsection" data-testid="estimate-accuracy">
      <header className="vsection-head">
        <h2>Estimates against actual time</h2>
      </header>
      <p className="muted">
        {a.done
          ? `${a.with_actual} of ${a.done} finished ${a.done === 1 ? 'job' : 'jobs'} recorded the time ${a.with_actual === 1 ? 'it' : 'they'} took (Actual time in the job). `
          : 'No jobs were finished in this period. '}
        A job is <strong>within</strong> its estimate when the time it took falls in the range chosen (2–4 hr, say). "Usually" is the middle job: how much
        longer or shorter than its estimate it took.
      </p>
      {a.compared === 0 ? (
        <p className="vsection-empty">No finished job in this period has both an estimate and an actual time.</p>
      ) : (
        <>
          {a.overall && (
            <p className="acc-overall">
              <strong>
                {a.overall.within} of {a.overall.jobs}
              </strong>{' '}
              within their estimate; {a.overall.longer} took longer, {a.overall.shorter} shorter. The middle job took {ratioText(a.overall.median_ratio)}.
            </p>
          )}
          <p className="acc-legend muted small" aria-hidden="true">
            <span>
              <i className="acc-within" />
              Within
            </span>
            <span>
              <i className="acc-longer" />
              Longer
            </span>
            <span>
              <i className="acc-shorter" />
              Shorter
            </span>
          </p>
          <div className="acc-grid">
            <div>
              <h3>By job type</h3>
              <AccuracyTable rows={a.by_type} first="Job type" />
            </div>
            <div>
              <h3>By person</h3>
              <AccuracyTable rows={a.by_person} first="Person" />
            </div>
          </div>
        </>
      )}
    </section>
  );
}
