// Side panel with every detail of a job. Fields save when you leave them.
// The board stays visible behind it.

import { useEffect, useRef, useState } from 'react';
import { ESTIMATE_BUCKETS, PRIORITIES, STATUS_LABEL, estimateLabel, type Activity, type Status, type Ticket } from '@board/shared';
import { useApp } from '../context.ts';
import { addComment, archiveTicket, claimTicket, moveTicket, releaseTicket, updateTicket } from '../lib/actions.ts';
import { copyText } from '../lib/clipboard.ts';
import { ask } from '../lib/dialogs.ts';
import { clock, dueLabel, when } from '../lib/format.ts';
import { useQuery } from '../lib/store.ts';
import { toast } from '../lib/toasts.ts';
import { Badge, ErrorBox, PRIORITY_TEXT, Spinner } from './bits.tsx';
import { AlsoViewing, useAnnounceViewing } from './Collab.tsx';

export function TicketPanel({ id, onClose }: { id: number; onClose: () => void }) {
  const q = useQuery<{ ticket: Ticket; activity: Activity[] }>(`/api/tickets/${id}`);
  const panelRef = useRef<HTMLElement | null>(null);
  useAnnounceViewing(id);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.dialog-backdrop')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    panelRef.current?.focus();
  }, [id]);

  return (
    <aside className="panel" ref={panelRef} tabIndex={-1} aria-label="Job details">
      {q.error && !q.data ? (
        <div className="panel-body">
          <button className="icon-btn panel-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
          <ErrorBox message={q.error.status === 404 ? 'This job does not exist.' : q.error.message} retry={q.error.status === 404 ? undefined : q.refresh} />
        </div>
      ) : !q.data ? (
        <Spinner label="Loading job" />
      ) : (
        <PanelContent key={q.data.ticket.id} t={q.data.ticket} activity={q.data.activity} onClose={onClose} />
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------

/** Text field with its own draft; saves on blur/Enter; never clobbers what you're typing. */
function EditText({
  value,
  onSave,
  multiline,
  placeholder,
  className,
  label,
  required,
}: {
  value: string;
  /** `base` is the value when you started editing — used to detect someone else's change. */
  onSave: (v: string, base: string) => Promise<unknown>;
  multiline?: boolean;
  placeholder?: string;
  className?: string;
  label: string;
  required?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const base = useRef(value);
  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);
  const changedUnderneath = focused && value !== base.current;
  const commit = async () => {
    setFocused(false);
    const v = multiline ? draft.replace(/\s+$/, '') : draft.trim();
    if (v === base.current && v === value) return;
    if (v === base.current) return; // you changed nothing; keep their newer value
    if (required && !v) {
      toast(`${label} can't be empty`, { kind: 'error' });
      setDraft(value);
      return;
    }
    await onSave(v, base.current);
  };
  const props = {
    className: `field-input ${className ?? ''}`,
    value: draft,
    placeholder,
    'aria-label': label,
    onFocus: () => {
      base.current = value;
      setFocused(true);
    },
    onChange: (e: any) => setDraft(e.target.value),
    onBlur: commit,
    onKeyDown: (e: any) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setDraft(value);
        e.target.blur();
      } else if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        e.target.blur();
      }
    },
  };
  const warn = changedUnderneath ? <span className="edit-warn">Someone else just changed this. When you leave the field you'll be asked which version to keep.</span> : null;
  if (multiline)
    return (
      <>
        <textarea {...props} rows={Math.min(Math.max(draft.split('\n').length + 1, 3), 16)} />
        {warn}
      </>
    );
  return (
    <>
      <input type="text" {...props} />
      {warn}
    </>
  );
}

const splitTags = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);

const URL_RE = /(https?:\/\/[^\s<>"']+)/g;
function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <a key={i} href={p} target="_blank" rel="noreferrer noopener">
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

function PathField({
  value,
  onSave,
  label,
  placeholder,
}: {
  value: string;
  onSave: (v: string, base: string) => Promise<unknown>;
  label: string;
  placeholder: string;
}) {
  const copy = async () => {
    const ok = await copyText(value);
    toast(ok ? 'Path copied. Paste it into File Explorer.' : 'Could not copy. Select the text and press Ctrl+C.', { kind: ok ? 'success' : 'error' });
  };
  return (
    <div className="path-field">
      <EditText value={value} onSave={onSave} label={label} placeholder={placeholder} className="mono-ish" />
      {value && (
        <button className="btn btn-quiet" onClick={copy} type="button">
          Copy
        </button>
      )}
      {/^https?:\/\//.test(value) && (
        <a className="btn btn-quiet" href={value} target="_blank" rel="noreferrer noopener">
          Open
        </a>
      )}
    </div>
  );
}

/** What can happen next from each status — one primary action, shown big. */
function nextStep(t: Ticket): { label: string; to: Status } | null {
  switch (t.status) {
    case 'claimed':
      return { label: 'Start work', to: 'in_progress' };
    case 'in_progress':
      return { label: 'Send to review', to: 'review' };
    case 'waiting':
    case 'blocked':
      return { label: 'Resume work', to: 'in_progress' };
    case 'review':
      return { label: 'Approve and mark done', to: 'done' };
    default:
      return null;
  }
}

function PanelContent({ t, activity, onClose }: { t: Ticket; activity: Activity[]; onClose: () => void }) {
  const { me, user, engineers, jobTypes, jobType } = useApp();
  const save = (fields: Record<string, unknown>, base?: Record<string, unknown>) => updateTicket(t, fields, base);
  const assignee = user(t.assigned_to);
  const closed = t.status === 'done' || t.status === 'cancelled';
  const step = nextStep(t);
  const [comment, setComment] = useState('');
  const [posting, setPosting] = useState(false);
  const isBucket = t.estimate_minutes == null || ESTIMATE_BUCKETS.some((b) => b.minutes === t.estimate_minutes);

  const copyLink = async () => {
    const ok = await copyText(`${location.origin}/board?job=${t.id}`);
    toast(ok ? `Link to ${t.job_number} copied` : 'Could not copy the link', { kind: ok ? 'success' : 'error' });
  };

  const post = async () => {
    if (!comment.trim() || posting) return;
    setPosting(true);
    if (await addComment(t, comment.trim())) setComment('');
    setPosting(false);
  };

  const cancelJob = async () => {
    const ok = await ask({
      type: 'confirm',
      title: `Cancel ${t.job_number}?`,
      body: 'It leaves the board but stays searchable, and you can reopen it later.',
      confirm: 'Cancel job',
      danger: true,
    });
    if (ok) await moveTicket(me, t, 'cancelled', {}, { quiet: false });
  };

  return (
    <div className="panel-body">
      <div className="panel-head">
        <span className="panel-jobno">{t.job_number}</span>
        <span className={`status-pill st-${t.status}`}>{STATUS_LABEL[t.status]}</span>
        {t.archived && <span className="status-pill st-archived">Archived</span>}
        <span className="spacer" />
        <button className="icon-btn" onClick={copyLink} title="Copy a link to this job" aria-label="Copy link">
          🔗
        </button>
        <button className="icon-btn" onClick={onClose} aria-label="Close (Esc)" title="Close (Esc)">
          ✕
        </button>
      </div>

      <AlsoViewing jobId={t.id} />
      <EditText value={t.title} onSave={(v, b) => save({ title: v }, { title: b })} className="panel-title" label="Title" required />

      {(t.status === 'waiting' || t.status === 'blocked') && (
        <div className={`waiting-box ${t.status}`}>
          <label className="field-label">{t.status === 'blocked' ? 'Blocked' : 'Waiting'} for</label>
          <EditText
            value={t.waiting_for}
            onSave={(v) => moveTicket(me, t, t.status, {}, { reason: v, quiet: true })}
            label="Waiting for"
            required
          />
        </div>
      )}

      <div className="panel-actions">
        {t.assigned_to == null && !closed && me.role === 'engineer' && (
          <button className="btn btn-claim" onClick={() => void claimTicket(t)}>
            Claim
          </button>
        )}
        {step && !t.archived && (
          <button className="btn btn-primary" onClick={() => void moveTicket(me, t, step.to, {}, { undo: { status: t.status, reason: t.waiting_for } })}>
            {step.label}
          </button>
        )}
        {t.status === 'review' && (
          <button className="btn" onClick={() => void moveTicket(me, t, 'in_progress', {}, { undo: { status: t.status } })}>
            Return to in progress
          </button>
        )}
        {(t.status === 'in_progress' || t.status === 'claimed') && (
          <button className="btn" onClick={() => void moveTicket(me, t, 'waiting', {}, { undo: { status: t.status } })}>
            Mark waiting…
          </button>
        )}
        {(t.status === 'in_progress' || t.status === 'claimed') && (
          <button className="btn" onClick={() => void moveTicket(me, t, 'done', {}, { undo: { status: t.status } })}>
            Mark done
          </button>
        )}
        {closed && !t.archived && (
          <button className="btn" onClick={() => void moveTicket(me, t, t.assigned_to ? 'in_progress' : 'inbox', {}, { undo: { status: t.status } })}>
            Reopen
          </button>
        )}
      </div>

      <dl className="fields">
        <div className="field">
          <dt className="field-label">Status</dt>
          <dd>
            <select
              className="field-input"
              value={t.status}
              disabled={t.archived}
              aria-label="Status"
              onChange={(e: any) => void moveTicket(me, t, e.target.value as Status, {}, { undo: { status: t.status, reason: t.waiting_for } })}
            >
              {(['inbox', 'claimed', 'in_progress', 'waiting', 'blocked', 'review', 'done', 'cancelled'] as Status[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </dd>
        </div>
        <div className="field">
          <dt className="field-label">Assigned to</dt>
          <dd className="assign-row">
            {assignee && <Badge user={assignee} size="sm" />}
            <select
              className="field-input"
              value={t.assigned_to ?? ''}
              disabled={closed}
              aria-label="Assigned to"
              onChange={(e: any) => {
                const v = e.target.value;
                if (v === '') void releaseTicket(t);
                else void save({ assigned_to: Number(v) });
              }}
            >
              <option value="">Unassigned</option>
              {engineers
                .filter((u) => u.active || u.id === t.assigned_to)
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                    {u.active ? '' : ' (inactive)'}
                  </option>
                ))}
            </select>
          </dd>
        </div>
        <div className="field">
          <dt className="field-label">Priority</dt>
          <dd>
            <select className="field-input" value={t.priority} aria-label="Priority" onChange={(e: any) => void save({ priority: e.target.value })}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_TEXT[p]}
                </option>
              ))}
            </select>
          </dd>
        </div>
        <div className="field">
          <dt className="field-label">Estimate</dt>
          <dd>
            <select
              className="field-input"
              value={t.estimate_minutes ?? ''}
              aria-label="Estimate"
              onChange={(e: any) => void save({ estimate_minutes: e.target.value === '' ? null : Number(e.target.value) })}
            >
              <option value="">Not estimated</option>
              {!isBucket && <option value={t.estimate_minutes!}>{estimateLabel(t.estimate_minutes)} ({t.estimate_minutes} min)</option>}
              {ESTIMATE_BUCKETS.map((b) => (
                <option key={b.minutes} value={b.minutes}>
                  {b.label}
                </option>
              ))}
            </select>
          </dd>
        </div>
        <div className="field">
          <dt className="field-label">Due</dt>
          <dd className="due-row">
            <input
              type="date"
              className="field-input"
              value={t.due_date ?? ''}
              aria-label="Due date"
              onChange={(e: any) => void save({ due_date: e.target.value || null })}
            />
            <input
              type="time"
              className="field-input time"
              value={t.due_time ?? ''}
              disabled={!t.due_date}
              aria-label="Due time (optional)"
              title="Optional time"
              onChange={(e: any) => void save({ due_time: e.target.value || null })}
            />
            {t.due_date && (
              <span className={`due-hint${t.overdue ? ' overdue' : ''}`}>{t.overdue ? 'Overdue' : dueLabel(t)}</span>
            )}
          </dd>
        </div>
        <div className="field">
          <dt className="field-label">Job type</dt>
          <dd>
            <select
              className="field-input"
              value={t.job_type_id ?? ''}
              aria-label="Job type"
              onChange={(e: any) => void save({ job_type_id: e.target.value === '' ? null : Number(e.target.value) })}
            >
              <option value="">None</option>
              {jobTypes
                .filter((j) => j.active || j.id === t.job_type_id)
                .map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.name}
                  </option>
                ))}
            </select>
          </dd>
        </div>
        <div className="field">
          <dt className="field-label">Requester</dt>
          <dd>
            <EditText value={t.requester} onSave={(v, b) => save({ requester: v }, { requester: b })} label="Requester" placeholder="Who asked for this?" />
          </dd>
        </div>
        <div className="field">
          <dt className="field-label">Tags</dt>
          <dd>
            <EditText
              value={t.tags.join(', ')}
              onSave={(v, b) => save({ tags: splitTags(v) }, { tags: splitTags(b) })}
              label="Tags"
              placeholder="e.g. customer-A, ANSYS"
            />
          </dd>
        </div>
        <div className="field">
          <dt className="field-label">Actual time</dt>
          <dd className="actual-row">
            <EditText
              value={t.actual_minutes == null ? '' : String(t.actual_minutes)}
              onSave={async (v) => {
                if (v !== '' && !/^\d+$/.test(v)) {
                  toast('Actual time must be a whole number of minutes', { kind: 'error' });
                  return;
                }
                await save({ actual_minutes: v === '' ? null : Number(v) });
              }}
              label="Actual minutes"
              placeholder="Optional"
            />
            <span className="muted">min</span>
          </dd>
        </div>
      </dl>

      <section className="panel-section">
        <label className="field-label">Description</label>
        <EditText value={t.description} onSave={(v, b) => save({ description: v }, { description: b })} multiline label="Description" placeholder="What was asked for?" />
      </section>

      <section className="panel-section">
        <label className="field-label">Reference</label>
        <PathField value={t.reference} onSave={(v, b) => save({ reference: v }, { reference: b })} label="Reference" placeholder="Drawing, part or project number, or a URL" />
        <label className="field-label">File location</label>
        <PathField value={t.file_location} onSave={(v, b) => save({ file_location: v }, { file_location: b })} label="File location" placeholder="\\SERVER\Projects\…" />
      </section>

      <section className="panel-section">
        <label className="field-label">Notes</label>
        <EditText
          value={t.notes}
          onSave={(v, b) => save({ notes: v }, { notes: b })}
          multiline
          label="Notes"
          placeholder="Context, constraints, model locations… (Ctrl+Enter to save)"
          className="notes"
        />
      </section>

      <section className="panel-section">
        <h3 className="section-title">History</h3>
        <ol className="timeline">
          {activity.map((a) => (
            <ActivityItem key={a.id} a={a} />
          ))}
        </ol>
        <div className="comment-box">
          <textarea
            className="field-input"
            rows={2}
            value={comment}
            placeholder="Add a note to the history…"
            aria-label="Add a comment"
            onChange={(e: any) => setComment(e.target.value)}
            onKeyDown={(e: any) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void post();
            }}
          />
          <button className="btn" onClick={() => void post()} disabled={!comment.trim() || posting}>
            Add to history
          </button>
        </div>
      </section>

      <footer className="panel-foot">
        <span className="muted">
          Created {when(t.created_at)} by {user(t.created_by)?.name ?? 'someone'}
          {t.claimed_at && `. Claimed ${when(t.claimed_at)}`}
        </span>
        <span className="spacer" />
        {t.assigned_to != null && !closed && (
          <button className="btn btn-quiet" onClick={() => void releaseTicket(t)}>
            Return to inbox
          </button>
        )}
        {!closed && (
          <button className="btn btn-quiet danger" onClick={() => void cancelJob()}>
            Cancel job
          </button>
        )}
        {closed && (
          <button className="btn btn-quiet" onClick={() => void archiveTicket(t, t.archived)}>
            {t.archived ? 'Restore' : 'Archive'}
          </button>
        )}
      </footer>
    </div>
  );
}

function ActivityItem({ a }: { a: Activity }) {
  const who = a.user_name ?? 'Someone';
  const st = (s: string | null) => (s ? STATUS_LABEL[s as Status] ?? s : '');
  let text: any;
  switch (a.kind) {
    case 'created':
      text = <>{who} created this job</>;
      break;
    case 'claimed':
      text = <>{who} claimed this job</>;
      break;
    case 'assigned':
      text = a.from_value ? <>{who} reassigned it from {a.from_value} to {a.to_value}</> : <>{who} assigned it to {a.to_value}</>;
      break;
    case 'released':
      text = <>{who} returned it to the inbox{a.from_value ? ` (was ${a.from_value})` : ''}</>;
      break;
    case 'status':
      text = (
        <>
          {who} moved it {st(a.from_value)} → <strong>{st(a.to_value)}</strong>
          {a.body && <span className="tl-quote">{a.to_value === 'blocked' ? 'Blocked' : 'Waiting'} for: {a.body}</span>}
        </>
      );
      break;
    case 'priority':
      text = (
        <>
          {who} changed priority {PRIORITY_TEXT[a.from_value as never] ?? a.from_value} → <strong>{PRIORITY_TEXT[a.to_value as never] ?? a.to_value}</strong>
        </>
      );
      break;
    case 'field':
      text =
        a.from_value == null && a.to_value == null ? (
          <>
            {who} edited the {a.body}
          </>
        ) : (
          <>
            {who} changed {a.body}: {a.from_value ?? 'none'} → <strong>{a.to_value ?? 'none'}</strong>
          </>
        );
      break;
    case 'comment':
      text = (
        <>
          <strong>{who}</strong>
          <span className="tl-bubble">
            <Linkified text={a.body ?? ''} />
          </span>
        </>
      );
      break;
    case 'archived':
      text = <>{who} archived it</>;
      break;
    case 'restored':
      text = <>{who} restored it</>;
      break;
    default:
      text = (
        <>
          {who}: {a.kind}
        </>
      );
  }
  return (
    <li className={`tl-item tl-${a.kind}`}>
      <time dateTime={a.at} title={new Date(a.at).toLocaleString()}>
        {when(a.at)}
      </time>
      <div className="tl-text">{text}</div>
    </li>
  );
}

export { clock };
