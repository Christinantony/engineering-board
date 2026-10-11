// "What should the team be paying attention to today?"

import type { Ticket } from '@board/shared';
import { useApp } from '../context.ts';
import { useQuery } from '../lib/store.ts';
import { ErrorBox, Spinner } from '../components/bits.tsx';
import { JobRow, Section } from '../components/JobRow.tsx';

interface TodayData {
  date: string;
  urgent: Ticket[];
  overdue: Ticket[];
  due_today: Ticket[];
  active: Ticket[];
  blocked: Ticket[];
  review: Ticket[];
  unclaimed: Ticket[];
  recently_completed: Ticket[];
}

function longDate(d: string) {
  const [y, m, day] = d.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(Date.UTC(y, m - 1, day, 12)));
}

function plural(n: number, one: string, many = one + 's') {
  return `${n} ${n === 1 ? one : many}`;
}

export function Today() {
  const { user } = useApp();
  const q = useQuery<TodayData>('/api/today');
  if (q.error && !q.data) return <ErrorBox message={q.error.message} retry={q.refresh} />;
  if (!q.data) return <Spinner label="Loading today" />;
  const d = q.data;

  // urgent jobs also appear under overdue / due today / unclaimed; show each job once in the left column
  const seen = new Set<number>();
  const once = (list: Ticket[]) => list.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
  const urgent = once(d.urgent);
  const overdue = once(d.overdue);
  const dueToday = once(d.due_today);
  const unclaimed = once(d.unclaimed);

  const byEngineer = new Map<number, Ticket[]>();
  for (const t of d.active) byEngineer.set(t.assigned_to ?? 0, [...(byEngineer.get(t.assigned_to ?? 0) ?? []), t]);

  const headline: string[] = [];
  if (d.overdue.length) headline.push(`${plural(d.overdue.length, 'job')} overdue`);
  if (d.due_today.length) headline.push(`${d.due_today.length} due today`);
  if (d.unclaimed.length) headline.push(`${d.unclaimed.length} waiting for someone to claim`);
  if (d.blocked.length) headline.push(`${d.blocked.length} stuck`);

  return (
    <div className="view">
      <header className="view-head">
        <h1>{longDate(d.date)}</h1>
        <p className="view-lede">{headline.length ? headline.join(', ') + '.' : 'Nothing urgent, overdue or unclaimed. A clear start.'}</p>
      </header>
      <div className="today-grid">
        <div className="today-col">
          <Section title="Urgent" count={urgent.length} tone="urgent" empty="No urgent jobs.">
            {urgent.map((t) => (
              <JobRow key={t.id} t={t} />
            ))}
          </Section>
          <Section title="Overdue" count={overdue.length} tone="overdue" empty="Nothing overdue.">
            {overdue.map((t) => (
              <JobRow key={t.id} t={t} />
            ))}
          </Section>
          <Section title="Due today" count={dueToday.length} empty="Nothing else due today.">
            {dueToday.map((t) => (
              <JobRow key={t.id} t={t} />
            ))}
          </Section>
          <Section title="Unclaimed" count={unclaimed.length} tone="inbox" empty="Every job has an owner.">
            {unclaimed.map((t) => (
              <JobRow key={t.id} t={t} showStatus={false} />
            ))}
          </Section>
        </div>
        <div className="today-col">
          <Section title="Being worked on" count={d.active.length} tone="progress" empty="Nobody has a job in progress.">
            {[...byEngineer].map(([uid, list]) => (
              <div key={uid} className="today-group">
                <div className="today-group-name">{user(uid)?.name ?? 'Unassigned'}</div>
                {list.map((t) => (
                  <JobRow key={t.id} t={t} showStatus={false} showAssignee={false} />
                ))}
              </div>
            ))}
          </Section>
          <Section title="Waiting / blocked" count={d.blocked.length} tone="waiting" empty="Nothing is stuck.">
            {d.blocked.map((t) => (
              <JobRow key={t.id} t={t} showStatus={false} />
            ))}
          </Section>
          <Section title="Ready for review" count={d.review.length} tone="review" empty="Nothing waiting for review.">
            {d.review.map((t) => (
              <JobRow key={t.id} t={t} showStatus={false} />
            ))}
          </Section>
          <Section title="Finished since yesterday" count={d.recently_completed.length} tone="done" empty="Nothing finished yet.">
            {d.recently_completed.map((t) => (
              <JobRow key={t.id} t={t} showStatus={false} showUpdated />
            ))}
          </Section>
        </div>
      </div>
    </div>
  );
}
