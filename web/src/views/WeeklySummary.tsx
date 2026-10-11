// The weekly summary (decision #37): one page for the review meeting, made to
// be printed or saved as a PDF. Reports → Weekly summary.

import { useApp } from '../context.ts';
import { when } from '../lib/format.ts';
import { navigate, useLocation } from '../lib/router.ts';
import { useQuery } from '../lib/store.ts';
import { ErrorBox, Spinner } from '../components/bits.tsx';

interface Job {
  id: number;
  job_number: string;
  title: string;
  status: string;
  status_label: string;
  owner: string | null;
  owner_id: number | null;
  project: string | null;
  job_type: string | null;
  priority: string;
  due_date: string | null;
  completed_at: string | null;
}
interface Summary {
  week: { from: string; to: string; is_current: boolean };
  today: string;
  generated_at: string;
  numbers: { finished: number; created: number; open_now: number; unassigned_now: number; overdue_now: number; waiting_now: number; drawings_signed: number };
  finished_by_project: { project: string | null; jobs: Job[] }[];
  people: { user_id: number; name: string; finished: number; open: number; in_progress: number; waiting: number; overdue: number; due_next_week: number }[];
  overdue: (Job & { days_overdue: number })[];
  waiting: (Job & { waiting_for: string; since: string | null; days: number | null })[];
  due_next_week: { from: string; to: string; jobs: Job[] };
  unclaimed_urgent: Job[];
  review: { signed: { identifier: string; revision: string | null; job_number: string; ticket_id: number }[]; awaiting_now: number; returned_now: number; signature_pending_now: number };
}

function addDays(date: string, n: number) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const day = (d: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }) =>
  new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', ...opts });
const range = (from: string, to: string) => `${day(from, { day: 'numeric', month: 'short' })} – ${day(to, { day: 'numeric', month: 'short', year: 'numeric' })}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function WeeklySummary() {
  const { params } = useLocation();
  const { me } = useApp();
  const week = params.get('week');
  const q = useQuery<Summary>(`/api/reports/weekly${week ? `?week=${week}` : ''}`);
  const s = q.data;
  const go = (d: string | null) => navigate(d ? `/reports/weekly?week=${d}` : '/reports/weekly');

  return (
    <div className="view view-narrow weekly">
      <header className="view-head weekly-tools">
        <div className="view-head-row">
          <div>
            <h1>Weekly summary</h1>
            <p className="view-lede">One page for the review meeting: print it or save it as a PDF.</p>
          </div>
          <div className="weekly-buttons">
            <button className="btn btn-quiet" onClick={() => navigate('/reports')}>
              Reports
            </button>
            <button className="btn btn-primary" onClick={() => window.print()} disabled={!s}>
              Print or save as PDF
            </button>
          </div>
        </div>
        {s && (
          <div className="weekly-nav">
            <button className="btn" onClick={() => go(addDays(s.week.from, -7))} aria-label="Previous week">
              ← Previous week
            </button>
            <strong>{range(s.week.from, s.week.to)}</strong>
            <button className="btn" onClick={() => go(addDays(s.week.from, 7))} disabled={s.week.is_current} aria-label="Next week">
              Next week →
            </button>
            {!s.week.is_current && (
              <button className="link-btn" onClick={() => go(null)}>
                This week
              </button>
            )}
          </div>
        )}
      </header>

      {q.error && !q.data ? <ErrorBox message={q.error.message} retry={q.refresh} /> : !s ? <Spinner label="Putting the week together" /> : <Sheet s={s} by={me.name} />}
    </div>
  );
}

function Sheet({ s, by }: { s: Summary; by: string }) {
  const { openJob } = useApp();
  const J = ({ j }: { j: Job }) => (
    <button className="weekly-job" onClick={() => openJob(j.id)}>
      {j.job_number}
    </button>
  );
  const n = s.numbers;
  return (
    <article className="weekly-sheet" data-testid="weekly-sheet">
      <header className="weekly-head">
        <div>
          <p className="weekly-kicker">Engineering Board · weekly summary</p>
          <h2>Week of {range(s.week.from, s.week.to)}</h2>
        </div>
        <p className="muted small">
          Prepared {when(s.generated_at)} by {by}.
          {!s.week.is_current && ` Overdue, waiting and open are as of ${day(s.today, { day: 'numeric', month: 'short' })}.`}
        </p>
      </header>

      <dl className="weekly-numbers">
        <div>
          <dt>Finished</dt>
          <dd>{n.finished}</dd>
        </div>
        <div>
          <dt>New jobs</dt>
          <dd>{n.created}</dd>
        </div>
        <div>
          <dt>Open now</dt>
          <dd>
            {n.open_now}
            {n.unassigned_now ? <small> ({n.unassigned_now} unassigned)</small> : null}
          </dd>
        </div>
        <div className={n.overdue_now ? 'weekly-alert' : ''}>
          <dt>Overdue now</dt>
          <dd>{n.overdue_now}</dd>
        </div>
        <div>
          <dt>Waiting or blocked</dt>
          <dd>{n.waiting_now}</dd>
        </div>
        <div>
          <dt>Drawings signed</dt>
          <dd>{n.drawings_signed}</dd>
        </div>
      </dl>

      <section className="weekly-sec">
        <h3>Finished this week</h3>
        {!s.finished_by_project.length ? (
          <p className="muted">Nothing was finished this week.</p>
        ) : (
          <div className="weekly-projects">
            {s.finished_by_project.map((p) => (
              <div key={p.project ?? ''} className="weekly-project">
                <h4>
                  {p.project ?? 'No project'} <span className="muted">· {plural(p.jobs.length, 'job')}</span>
                </h4>
                <ul>
                  {p.jobs.map((j) => (
                    <li key={j.id}>
                      <J j={j} /> {j.title}
                      <span className="muted"> · {j.owner ?? 'nobody'}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="weekly-sec">
        <h3>The team</h3>
        <table className="table weekly-table">
          <thead>
            <tr>
              <th>Person</th>
              <th className="num">Finished this week</th>
              <th className="num">Open</th>
              <th className="num">In progress</th>
              <th className="num">Waiting</th>
              <th className="num">Overdue</th>
              <th className="num">Due next week</th>
            </tr>
          </thead>
          <tbody>
            {s.people.map((p) => (
              <tr key={p.user_id}>
                <td>{p.name}</td>
                <td className="num">{p.finished}</td>
                <td className="num">{p.open}</td>
                <td className="num">{p.in_progress}</td>
                <td className="num">{p.waiting}</td>
                <td className={`num${p.overdue ? ' weekly-alert' : ''}`}>{p.overdue}</td>
                <td className="num">{p.due_next_week}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="weekly-sec">
        <h3>Overdue now</h3>
        {!s.overdue.length ? (
          <p className="muted">Nothing is overdue.</p>
        ) : (
          <table className="table weekly-table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Owner</th>
                <th>Was due</th>
                <th className="num">Days over</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {s.overdue.map((j) => (
                <tr key={j.id}>
                  <td>
                    <J j={j} /> {j.title}
                    {j.project && <span className="muted"> · {j.project}</span>}
                  </td>
                  <td>{j.owner ?? <span className="muted">Nobody</span>}</td>
                  <td>{j.due_date ? day(j.due_date) : ''}</td>
                  <td className="num">{j.days_overdue === 0 ? 'Today' : j.days_overdue}</td>
                  <td>{j.status_label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="weekly-sec">
        <h3>Waiting or blocked</h3>
        {!s.waiting.length ? (
          <p className="muted">Nothing is waiting.</p>
        ) : (
          <table className="table weekly-table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Owner</th>
                <th>Waiting for</th>
                <th className="num">Days waiting</th>
              </tr>
            </thead>
            <tbody>
              {s.waiting.map((j) => (
                <tr key={j.id}>
                  <td>
                    <J j={j} /> {j.title}
                    {j.status === 'blocked' && <span className="weekly-alert"> · blocked</span>}
                  </td>
                  <td>{j.owner ?? <span className="muted">Nobody</span>}</td>
                  <td>{j.waiting_for || <span className="muted">Not said</span>}</td>
                  <td className="num">{j.days == null ? '' : j.days === 0 ? 'Today' : j.days}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="weekly-two">
        <section className="weekly-sec">
          <h3>Due next week ({range(s.due_next_week.from, s.due_next_week.to)})</h3>
          {!s.due_next_week.jobs.length ? (
            <p className="muted">Nothing has a due date next week.</p>
          ) : (
            <ul className="weekly-list">
              {s.due_next_week.jobs.map((j) => (
                <li key={j.id}>
                  <span className="weekly-date">{j.due_date ? day(j.due_date, { weekday: 'short', day: 'numeric' }) : ''}</span> <J j={j} /> {j.title}
                  <span className="muted"> · {j.owner ?? 'nobody yet'}</span>
                </li>
              ))}
            </ul>
          )}
          {!!s.unclaimed_urgent.length && (
            <>
              <h4>Urgent or high, nobody on it</h4>
              <ul className="weekly-list">
                {s.unclaimed_urgent.map((j) => (
                  <li key={j.id}>
                    <J j={j} /> {j.title} <span className="muted">· {j.priority}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
        <section className="weekly-sec">
          <h3>Drawing review</h3>
          <p>
            Now: <strong>{s.review.awaiting_now}</strong> awaiting review, <strong>{s.review.returned_now}</strong> returned for correction,{' '}
            <strong>{s.review.signature_pending_now}</strong> waiting for a signature.
          </p>
          {s.review.signed.length ? (
            <p>
              Signed this week:{' '}
              {s.review.signed.map((d, i) => (
                <span key={`${d.ticket_id}-${d.identifier}`}>
                  {i ? ', ' : ''}
                  <strong>
                    {d.identifier}
                    {d.revision ? ` Rev ${d.revision}` : ''}
                  </strong>{' '}
                  <span className="muted">({d.job_number})</span>
                </span>
              ))}
              .
            </p>
          ) : (
            <p className="muted">No drawings were signed this week.</p>
          )}
        </section>
      </div>
    </article>
  );
}
