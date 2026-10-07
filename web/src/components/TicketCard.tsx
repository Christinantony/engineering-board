import type { Ticket } from '@board/shared';
import { useApp } from '../context.ts';
import { claimTicket, updateTicket } from '../lib/actions.ts';
import { ask } from '../lib/dialogs.ts';
import { clock, dueLabel, est } from '../lib/format.ts';
import { Badge, PriorityTag } from './bits.tsx';
import { useRecentChange } from '../lib/store.ts';

interface Props {
  t: Ticket;
  dragging?: boolean;
  ghost?: boolean;
  onPointerDown?: (e: any) => void;
  onOpen?: () => void;
}

export function TicketCard({ t, dragging, ghost, onPointerDown, onOpen }: Props) {
  const { user, jobType, project, can } = useApp();
  const assignee = user(t.assigned_to);
  const due = dueLabel(t);
  const open = !['done', 'cancelled'].includes(t.status);
  const unassigned = t.assigned_to == null && open;
  const waiting = t.status === 'waiting' || t.status === 'blocked';
  const changedBy = useRecentChange(t.id);
  const flash = changedBy !== undefined && !ghost;

  const assign = async (e: any) => {
    e.stopPropagation();
    const uid = await ask({ type: 'assign', ticket: t, title: `Who should take ${t.job_number}?` });
    if (uid != null) await updateTicket(t, { assigned_to: uid });
  };

  return (
    <div
      className={`card prio-edge-${t.priority}${dragging ? ' is-dragging' : ''}${ghost ? ' is-ghost' : ''}${t.overdue ? ' is-overdue' : ''}${flash ? ' just-changed' : ''}`}
      title={flash && changedBy != null ? `Just changed by ${user(changedBy)?.name ?? 'someone'}` : undefined}
      data-card={t.id}
      role="button"
      tabIndex={ghost ? -1 : 0}
      aria-label={`${t.job_number} ${t.title}`}
      onPointerDown={onPointerDown}
      onClick={onOpen}
      onKeyDown={(e: any) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen?.();
        }
      }}
    >
      <div className="card-top">
        <span className="jobno">{t.job_number}</span>
        {assignee ? <Badge user={assignee} /> : <span className="unassigned-label">Unassigned</span>}
      </div>
      {project(t.project_id) && (
        <div className="card-project" title={`Project: ${project(t.project_id)!.name}`}>
          {project(t.project_id)!.name}
        </div>
      )}
      <div className="card-title">{t.title}</div>

      {waiting && t.waiting_for && (
        <div className={`card-waiting ${t.status}`}>
          <span className="card-waiting-kind">{t.status === 'blocked' ? 'Blocked' : 'Waiting'} for</span> {t.waiting_for}
        </div>
      )}

      <div className="card-meta">
        <PriorityTag p={t.priority} />
        {t.estimate_minutes != null && <span className="chip">{est(t.estimate_minutes)}</span>}
        {due && (
          <span className={`chip due${t.overdue ? ' overdue' : t.due_today ? ' today' : ''}`} title={t.overdue ? 'Overdue' : 'Due'}>
            {t.overdue && <span className="dot" aria-hidden="true" />}
            {t.overdue && <span className="sr-only">Overdue, was due </span>}
            {due}
          </span>
        )}
      </div>

      {(jobType(t.job_type_id) || (t.status === 'claimed' && t.claimed_at) || t.status === 'done') && (
        <div className="card-foot">
          <span className="jobtype">{jobType(t.job_type_id)?.name}</span>
          {t.status === 'claimed' && t.claimed_at && <span className="muted">Claimed {clock(t.claimed_at)}</span>}
          {t.status === 'done' && t.completed_at && <span className="muted">Done {clock(t.completed_at)}</span>}
        </div>
      )}

      {unassigned && !ghost && (can('claim') || can('edit')) && (
        <div className="card-actions">
          {can('claim') ? (
            <button
              className="btn btn-claim"
              onPointerDown={(e: any) => e.stopPropagation()}
              onClick={(e: any) => {
                e.stopPropagation();
                void claimTicket(t);
              }}
            >
              Claim
            </button>
          ) : (
            <button className="btn btn-quiet" onPointerDown={(e: any) => e.stopPropagation()} onClick={assign}>
              Assign…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
