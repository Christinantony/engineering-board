// Compact one-line job, used in lists (Today, My work, Dashboard, Search…).

import { STATUS_LABEL, type Ticket } from '@board/shared';
import { useApp } from '../context.ts';
import { claimTicket } from '../lib/actions.ts';
import { dueLabel, est, when } from '../lib/format.ts';
import { Badge, PriorityTag } from './bits.tsx';

export function JobRow({
  t,
  showStatus = true,
  showAssignee = true,
  showUpdated = false,
  handle,
}: {
  t: Ticket;
  showStatus?: boolean;
  showAssignee?: boolean;
  showUpdated?: boolean;
  handle?: any;
}) {
  const { me, user, jobType, openJob } = useApp();
  const due = dueLabel(t);
  const open = t.status !== 'done' && t.status !== 'cancelled';
  const waiting = t.status === 'waiting' || t.status === 'blocked';
  return (
    <div
      className={`jobrow prio-edge-${t.priority}`}
      role="button"
      tabIndex={0}
      data-row={t.id}
      onClick={() => openJob(t.id)}
      onKeyDown={(e: any) => {
        if (e.key === 'Enter') openJob(t.id);
      }}
    >
      {handle}
      <span className="jobno">{t.job_number}</span>
      <span className="jobrow-main">
        <span className="jobrow-title">{t.title}</span>
        {waiting && t.waiting_for && (
          <span className="jobrow-sub">
            {t.status === 'blocked' ? 'Blocked' : 'Waiting'} for {t.waiting_for}
          </span>
        )}
        {!waiting && jobType(t.job_type_id) && <span className="jobrow-sub muted">{jobType(t.job_type_id)!.name}</span>}
      </span>
      <span className="jobrow-tags">
        <PriorityTag p={t.priority} />
        {t.estimate_minutes != null && <span className="chip">{est(t.estimate_minutes)}</span>}
        {due && open && (
          <span className={`chip due${t.overdue ? ' overdue' : t.due_today ? ' today' : ''}`}>
            {t.overdue && <span className="dot" aria-hidden="true" />}
            {t.overdue && <span className="sr-only">Overdue, was due </span>}
            {due}
          </span>
        )}
        {showStatus && <span className={`status-pill sm st-${t.status}`}>{t.archived ? 'Archived' : STATUS_LABEL[t.status]}</span>}
        {showUpdated && <span className="muted jobrow-when">{when(t.status === 'done' && t.completed_at ? t.completed_at : t.updated_at)}</span>}
      </span>
      {showAssignee && (
        <span className="jobrow-who">
          {t.assigned_to != null ? (
            <Badge user={user(t.assigned_to)} size="sm" />
          ) : open && me.role === 'engineer' ? (
            <button
              className="btn btn-claim btn-sm"
              onClick={(e: any) => {
                e.stopPropagation();
                void claimTicket(t);
              }}
            >
              Claim
            </button>
          ) : (
            <span className="muted">—</span>
          )}
        </span>
      )}
    </div>
  );
}

export function Section({
  title,
  count,
  tone,
  empty,
  children,
  extra,
}: {
  title: string;
  count?: number;
  tone?: string;
  empty?: string;
  children?: any;
  extra?: any;
}) {
  return (
    <section className={`vsection${tone ? ` tone-${tone}` : ''}`}>
      <header className="vsection-head">
        <h2>{title}</h2>
        {count != null && <span className="vsection-count">{count}</span>}
        {extra}
      </header>
      {count === 0 && empty ? <p className="vsection-empty">{empty}</p> : <div className="vsection-list">{children}</div>}
    </section>
  );
}
