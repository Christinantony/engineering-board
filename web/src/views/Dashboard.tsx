// Compact overview: the tally strip, team load, what needs an owner, and recent activity.

import type { Activity, Ticket } from '@board/shared';
import { STATUS_LABEL, type Status } from '@board/shared';
import { useApp } from '../context.ts';
import { localDate, when } from '../lib/format.ts';
import { navigate } from '../lib/router.ts';
import { useQuery } from '../lib/store.ts';
import { ErrorBox, Spinner } from '../components/bits.tsx';
import { JobRow, Section } from '../components/JobRow.tsx';
import { WorkloadBars, referenceMinutes, type WorkloadData } from '../components/WorkloadBars.tsx';

interface DashData {
  counts: Record<string, number>;
  workload: WorkloadData;
  recent_activity: Activity[];
  attention: Ticket[];
}

const TALLY: { key: string; label: string; to: string; tone?: string }[] = [
  { key: 'unclaimed', label: 'Unclaimed', to: '/board?u=1', tone: 'inbox' },
  { key: 'in_progress', label: 'In progress', to: '/today', tone: 'progress' },
  { key: 'blocked', label: 'Waiting / blocked', to: '/board?b=1', tone: 'waiting' },
  { key: 'due_today', label: 'Due today', to: '/today' },
  { key: 'overdue', label: 'Overdue', to: '/board?o=1', tone: 'bad' },
  { key: 'done_today', label: 'Done today', to: '/today', tone: 'done' },
];

export function activitySentence(a: Activity): string {
  const who = a.user_name ?? 'Someone';
  const st = (s: string | null) => (s ? STATUS_LABEL[s as Status] ?? s : '');
  switch (a.kind) {
    case 'created':
      return `${who} created`;
    case 'claimed':
      return `${who} claimed`;
    case 'assigned':
      return `${who} assigned to ${a.to_value}`;
    case 'released':
      return `${who} returned to the inbox`;
    case 'status':
      return `${who} moved to ${st(a.to_value)}`;
    case 'priority':
      return `${who} set priority to ${a.to_value}`;
    case 'comment':
      return `${who} noted: “${(a.body ?? '').slice(0, 80)}${(a.body ?? '').length > 80 ? '…' : ''}”`;
    case 'field':
      return `${who} changed ${a.body}`;
    case 'archived':
      return `${who} archived`;
    case 'restored':
      return `${who} restored`;
    case 'review_submitted':
      return `${who} submitted drawings for board review: ${a.body ?? ''}`;
    case 'review_passed':
      return `${who} passed ${a.to_value} in board review`;
    case 'review_returned':
      return `${who} returned ${a.to_value} for correction`;
    case 'review_comment':
      return `${who} commented on ${a.to_value}: “${(a.body ?? '').slice(0, 80)}${(a.body ?? '').length > 80 ? '…' : ''}”`;
    case 'review_handover':
      return `${who} handed a print to ${a.to_value} for signature`;
    case 'review_assigned':
      return `${who} handed ${a.body ?? 'a drawing'} to ${a.to_value} for review`;
    case 'review_signed':
      return `${who} recorded the physical signature of ${a.to_value}`;
    default:
      return `${who}: ${a.kind}`;
  }
}

/**
 * Collapse bursts: consecutive entries by the same person on the same job
 * within 15 minutes show as one line (the latest), with a count.
 */
export function groupActivity(list: Activity[]): { a: Activity; more: number }[] {
  const out: { a: Activity; more: number; last: Activity }[] = [];
  for (const a of list) {
    const g = out[out.length - 1];
    if (g && g.a.ticket_id === a.ticket_id && g.a.user_id === a.user_id && Date.parse(g.last.at) - Date.parse(a.at) < 15 * 60_000 && a.kind !== 'comment' && g.a.kind !== 'comment') {
      g.more++;
      g.last = a;
    } else out.push({ a, more: 0, last: a });
  }
  return out;
}

export function Dashboard() {
  const { meta, openJob } = useApp();
  const q = useQuery<DashData>('/api/dashboard');
  if (q.error && !q.data) return <ErrorBox message={q.error.message} retry={q.refresh} />;
  if (!q.data) return <Spinner label="Loading dashboard" />;
  const d = q.data;
  const today = localDate();

  return (
    <div className="view">
      <div className="tally" role="list">
        {TALLY.map((t) => (
          <button key={t.key} role="listitem" className={`tally-item${t.tone ? ` tone-${t.tone}` : ''}${d.counts[t.key] ? '' : ' zero'}`} onClick={() => navigate(t.to)}>
            <span className="tally-n">{d.counts[t.key] ?? 0}</span>
            <span className="tally-label">{t.label}</span>
          </button>
        ))}
      </div>

      <div className="dash-grid">
        <div className="dash-col">
          <Section title="Team workload today" extra={<button className="link-btn" onClick={() => navigate('/workload')}>Open workload</button>}>
            <WorkloadBars data={d.workload} referenceMinutes={referenceMinutes(today, today, meta.workday)} compact />
          </Section>
          <Section title="Needs an owner or is urgent" count={d.attention.length} tone="urgent" empty="Every job has an owner and nothing is urgent.">
            {d.attention.map((t) => (
              <JobRow key={t.id} t={t} />
            ))}
          </Section>
        </div>
        <div className="dash-col">
          <Section title="Recent activity">
            <ol className="feed">
              {groupActivity(d.recent_activity).map(({ a, more }) => (
                <li key={a.id}>
                  <button className="feed-item" onClick={() => openJob(a.ticket_id)}>
                    <time className="muted">{when(a.at)}</time>
                    <span className="feed-text">
                      <span className="jobno">{a.job_number}</span> {a.ticket_title}
                      <span className="feed-what">
                        {activitySentence(a)}
                        {more > 0 && <span className="muted"> and {more} earlier {more === 1 ? 'change' : 'changes'}</span>}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
              {d.recent_activity.length === 0 && <li className="vsection-empty">No activity yet.</li>}
            </ol>
          </Section>
        </div>
      </div>
    </div>
  );
}
