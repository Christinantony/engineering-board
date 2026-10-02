// The review workspace for one job: the drawing set, the signed reference and
// the submitted drawing side by side (each viewer on its own), revision notes,
// reviewer comments and the board-review / signature actions.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DRAWING_STATE_LABEL,
  DRAWING_STATE_SHORT,
  canReview,
  type ReviewAttempt,
  type ReviewDrawing,
  type ReviewFile,
  type ReviewWorkspace,
} from '@board/shared';
import { useApp } from '../context.ts';
import { when } from '../lib/format.ts';
import { navigate, replaceParams, useLocation } from '../lib/router.ts';
import { useQuery, invalidate } from '../lib/store.ts';
import { fileUrl } from '../lib/pdf.ts';
import { reviewAction, uploadPdf } from '../lib/review.ts';
import { ask } from '../lib/dialogs.ts';
import { toast, toastError } from '../lib/toasts.ts';
import { post } from '../lib/api.ts';
import { Badge, ErrorBox, Spinner } from '../components/bits.tsx';
import { PdfViewer } from '../components/PdfViewer.tsx';
import { folderName } from './ReviewQueue.tsx';
import { useFocusTrap } from '../lib/focus.ts';

type Compare = 'reference' | 'previous' | 'none';

export function ReviewWorkspaceView({ ticketId }: { ticketId: number }) {
  const { me } = useApp();
  const { params } = useLocation();
  const q = useQuery<ReviewWorkspace>(`/api/tickets/${ticketId}/review`);
  const w = q.data;
  const submitting = params.get('submit') === '1';
  const setParam = (k: string, v: string | null) => {
    const p = new URLSearchParams(location.search);
    if (v == null) p.delete(k);
    else p.set(k, v);
    replaceParams(p);
  };

  if (q.error && !w) return <div className="view"><ErrorBox message={q.error.message} retry={q.refresh} /></div>;
  if (!w) return <div className="view"><Spinner /></div>;

  const visible = w.drawings.filter((d) => d.state !== 'withdrawn' || String(d.id) === params.get('d'));
  const selected = w.drawings.find((d) => String(d.id) === params.get('d')) ?? visible[0] ?? null;
  const isEngineer = me.role === 'engineer';
  const open = !w.ticket.archived && !['done', 'cancelled'].includes(w.ticket.status);

  return (
    <div className="view review-ws">
      <a
        className="back-link"
        href="/review"
        onClick={(e: any) => {
          e.preventDefault();
          navigate('/review');
        }}
      >
        ← Back to review queue
      </a>
      <header className="rw-head">
        <h1>
          <span className="rw-jobno">{w.ticket.job_number}</span> · {w.ticket.title}
        </h1>
        <div className="rw-chips">
          {w.ticket.file_location && (
            <span className="rv-chip rv-plain" title={w.ticket.file_location}>
              {folderName(w.ticket.file_location)}
            </span>
          )}
          {w.submissions > 0 && <span className="rv-chip rv-plain">Submission {w.submissions}</span>}
          <JobReviewStatus w={w} />
          <span className="spacer" />
          <button className="btn btn-quiet btn-sm" onClick={() => navigate(`/board?job=${w.ticket.id}`)}>
            Open job
          </button>
          <a className="btn btn-quiet btn-sm" href={`/api/tickets/${w.ticket.id}/review/log`} target="_blank" rel="noopener">
            Revision log
          </a>
          {isEngineer && open && (
            <button className="btn btn-primary btn-sm" onClick={() => setParam('submit', '1')}>
              Submit drawings…
            </button>
          )}
        </div>
        <SyncLine w={w} />
      </header>

      {!w.drawings.length ? (
        <div className="rw-empty">
          <p>No drawings have been submitted for board review on this job yet.</p>
          {isEngineer && open && (
            <button className="btn btn-primary" onClick={() => setParam('submit', '1')}>
              Submit drawings for board review
            </button>
          )}
        </div>
      ) : (
        <div className="rw-grid">
          <DrawingSet w={w} selected={selected} onSelect={(id) => setParam('d', String(id))} />
          {selected && <DrawingWorkspace key={selected.id} w={w} d={selected} />}
        </div>
      )}
      {submitting && <SubmitPanel w={w} forDrawing={Number(params.get('for')) || null} onClose={() => { setParam('submit', null); setParam('for', null); }} />}
    </div>
  );
}

function JobReviewStatus({ w }: { w: ReviewWorkspace }) {
  const ds = w.drawings.filter((d) => d.required);
  if (!ds.length) return null;
  const n = (s: string) => ds.filter((d) => d.state === s).length;
  const label = n('awaiting')
    ? 'Awaiting review'
    : n('returned')
      ? 'Returned for correction'
      : n('passed') + n('handed_over')
        ? 'Signature pending'
        : 'All drawings signed';
  const tone = n('awaiting') ? 'awaiting' : n('returned') ? 'returned' : n('passed') + n('handed_over') ? 'passed' : 'signed';
  return <span className={`rv-chip rv-${tone}`}>{label}</span>;
}

function SyncLine({ w }: { w: ReviewWorkspace }) {
  const s = w.sync;
  if (!w.drawings.length) return null;
  const retry = async () => {
    try {
      await post(`/api/tickets/${w.ticket.id}/review/sync`);
      toast('Updating the project folder copies…');
    } catch (e) {
      toastError(e);
    }
  };
  const text =
    s.state === 'ok'
      ? 'Project folder copies and REVISION_LOG.md are up to date.'
      : s.state === 'pending'
        ? 'Updating the project folder copies…'
        : s.state === 'no_folder'
          ? 'No project folder: set the job’s File location to keep copies and REVISION_LOG.md there. The board keeps its own copies either way.'
          : `Project folder copies need attention: ${s.detail ?? ''}`;
  return (
    <p className={`rw-sync rw-sync-${s.state}`} role={s.state === 'failed' ? 'alert' : undefined} data-testid="sync-line">
      {text}
      {s.state === 'failed' && (
        <button className="link-btn" onClick={() => void retry()}>
          Try again
        </button>
      )}
    </p>
  );
}

function DrawingSet({ w, selected, onSelect }: { w: ReviewWorkspace; selected: ReviewDrawing | null; onSelect: (id: number) => void }) {
  const req = w.drawings.filter((d) => d.required);
  const done = req.filter((d) => ['passed', 'handed_over', 'signed'].includes(d.state)).length;
  const signed = req.filter((d) => d.state === 'signed').length;
  return (
    <nav className="rw-set" aria-label="Drawing set">
      <h2>Drawing set</h2>
      <div className="muted small">
        {done} of {req.length} passed board review · {signed} signed
      </div>
      <div className="rw-progress" aria-hidden="true">
        <span style={{ width: `${req.length ? (100 * done) / req.length : 0}%` }} />
      </div>
      <ul>
        {w.drawings.map((d) => {
          const a = d.attempts.find((x) => x.id === d.current_attempt_id);
          return (
            <li key={d.id}>
              <button className={`rw-item${selected?.id === d.id ? ' sel' : ''}${d.state === 'withdrawn' ? ' withdrawn' : ''}`} onClick={() => onSelect(d.id)} aria-current={selected?.id === d.id}>
                <span className="rw-item-id">{d.identifier}</span>
                <span className={`rv-chip rv-${d.kind === 'new' ? 'new' : 'revised'}`}>{d.kind === 'new' ? 'New' : 'Revised'}</span>
                <span className="rw-item-sub muted small">
                  {a ? `Attempt ${a.number}` : ''} · {DRAWING_STATE_SHORT[d.state]}
                  {d.open_comments ? ` · ${d.open_comments} open` : ''}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function DrawingWorkspace({ w, d }: { w: ReviewWorkspace; d: ReviewDrawing }) {
  const { me, user } = useApp();
  const current = d.attempts.find((a) => a.id === d.current_attempt_id) ?? d.attempts[d.attempts.length - 1];
  const [viewId, setViewId] = useState<number>(current?.id);
  const viewing = d.attempts.find((a) => a.id === viewId) ?? current;
  const previous = [...d.attempts].reverse().find((a) => a.number < viewing.number && a.available) ?? null;
  const refs = w.references.filter((r) => r.available);
  const [compare, setCompare] = useState<Compare>(() => (d.kind === 'revision' && refs.length ? 'reference' : previous ? 'previous' : refs.length ? 'reference' : 'none'));
  const [refId, setRefId] = useState<number | null>(d.ref_reference_id ?? refs[0]?.id ?? null);
  const ref = refs.find((r) => r.id === refId) ?? null;
  const [leftPage, setLeftPage] = useState(1);
  const reviewer = canReview(me);
  const engineer = me.role === 'engineer';
  const mineSubmitted = current.submitted_by === me.id;
  const isCurrent = viewing.id === current.id;

  useEffect(() => setViewId(current.id), [current.id]);

  const bookmarked = d.ref_reference_id === ref?.id ? d.ref_page : null;
  const remember = () =>
    ref && void reviewAction('PUT', `/api/review/drawings/${d.id}/reference-page`, { reference_id: ref.id, page: leftPage });

  const left =
    compare === 'reference' && ref ? (
      <PdfViewer
        testId="viewer-reference"
        url={fileUrl(ref.sha256)}
        heading={
          <>
            <strong>Signed reference</strong>
            {refs.length > 1 ? (
              <select className="field-input rw-ref-select" aria-label="Reference file" value={ref.id} onChange={(e: any) => setRefId(Number(e.target.value))}>
                {refs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.filename}
                  </option>
                ))}
              </select>
            ) : (
              <span className="muted"> · {ref.filename}</span>
            )}
            <span className="rv-chip rv-signed">Official reference</span>
          </>
        }
        page={bookmarked ?? 1}
        pageKey={`${d.id}:${ref.id}:${bookmarked}`}
        onPage={(p) => setLeftPage(p)}
        extra={
          (engineer || reviewer) &&
          (bookmarked === leftPage ? (
            <span className="rw-remembered" data-testid="remembered">
              ✓ Remembered page {leftPage}
            </span>
          ) : (
            <button className="btn btn-sm" onClick={() => void remember()} title="Save this page as the matching reference page for this drawing">
              Remember page {leftPage}
            </button>
          ))
        }
      />
    ) : compare === 'previous' && previous ? (
      <PdfViewer
        testId="viewer-previous"
        url={fileUrl(previous.sha256)}
        heading={
          <>
            <strong>Previous attempt {previous.number}</strong>
            <span className="muted"> · {previous.filename}</span>
            {previous.outcome && <span className="rv-chip rv-returned">{previous.outcome === 'returned' ? 'Returned' : previous.outcome === 'passed' ? 'Passed' : 'Replaced'}</span>}
          </>
        }
      />
    ) : null;

  const right = (
    <PdfViewer
      testId="viewer-submitted"
      url={viewing.available ? fileUrl(viewing.sha256) : null}
      empty={'This intermediate PDF was removed after board review. Its notes, comments and decision are kept below.'}
      heading={
        <>
          <strong>{d.kind === 'new' && viewing.number === 1 ? 'Submitted drawing' : 'Submitted'} · attempt {viewing.number}</strong>
          <span className="muted"> · {viewing.filename}</span>
          <span className={`rv-chip rv-${viewing.outcome === 'passed' ? 'signed' : viewing.outcome === 'returned' ? 'returned' : 'awaiting'}`}>
            {viewing.outcome === 'passed' ? 'Passed board review' : viewing.outcome === 'returned' ? 'Returned' : viewing.outcome === 'superseded' ? 'Replaced' : 'Submitted'}
          </span>
        </>
      }
    />
  );

  return (
    <>
      <div className="rw-center">
        <div className="rw-compare" role="toolbar" aria-label="Compare with">
          <span className="muted small">Compare with:</span>
          <div className="seg seg-tabs">
            <button className={compare === 'reference' ? 'on' : ''} disabled={!refs.length} onClick={() => setCompare('reference')} aria-pressed={compare === 'reference'}>
              Signed reference
            </button>
            <button className={compare === 'previous' ? 'on' : ''} disabled={!previous} onClick={() => setCompare('previous')} aria-pressed={compare === 'previous'}>
              Previous attempt
            </button>
            <button className={compare === 'none' ? 'on' : ''} onClick={() => setCompare('none')} aria-pressed={compare === 'none'}>
              Drawing only
            </button>
          </div>
          {!isCurrent && (
            <span className="rw-old-note">
              Viewing attempt {viewing.number}.{' '}
              <button className="link-btn" onClick={() => setViewId(current.id)}>
                Back to attempt {current.number}
              </button>
            </span>
          )}
        </div>
        {d.kind === 'new' && !refs.length && !previous && <div className="banner banner-info rw-new-banner">New drawing: no previous revision to compare with.</div>}
        <div className={`rw-viewers${left ? ' two' : ''}`}>
          {left}
          {right}
        </div>
      </div>
      <aside className="rw-side">
        <section className="rw-card">
          <h2>{d.kind === 'new' && viewing.number === 1 ? 'Creation notes' : 'Revision notes'}</h2>
          <div className="muted small">
            {d.identifier} · attempt {viewing.number} · {user(viewing.submitted_by)?.name ?? 'someone'}, {when(viewing.submitted_at)}
          </div>
          <p className="rw-notes">{viewing.notes}</p>
          {viewing.decision_note && (
            <p className="rw-decision">
              <strong>{viewing.outcome === 'passed' ? 'Pass note' : 'Return note'}</strong> ({user(viewing.decided_by)?.name}): {viewing.decision_note}
            </p>
          )}
        </section>
        <DrawingDetails w={w} d={d} />
        <Comments d={d} attempt={viewing} />
        <History d={d} viewing={viewing} onView={setViewId} />
      </aside>
      <ActionBar w={w} d={d} current={current} mineSubmitted={mineSubmitted} />
    </>
  );
}

function DrawingDetails({ w, d }: { w: ReviewWorkspace; d: ReviewDrawing }) {
  const { me, user } = useApp();
  const ref = w.references.find((r) => r.id === d.ref_reference_id);
  const rename = async () => {
    const name = await ask({ type: 'text', title: `Correct the drawing number of ${d.identifier}`, body: 'The drawing number comes from the file name. Correct it here if the file was named wrongly.', label: 'Drawing number', confirm: 'Save', required: true });
    if (name) await reviewAction('PATCH', `/api/review/drawings/${d.id}`, { identifier: name });
  };
  return (
    <section className="rw-card">
      <h2>Drawing</h2>
      <dl className="rw-dl">
        <dt>Number</dt>
        <dd>
          {d.identifier}{' '}
          {me.role === 'engineer' && d.state !== 'signed' && (
            <button className="link-btn" onClick={() => void rename()}>
              Correct
            </button>
          )}
        </dd>
        <dt>Type</dt>
        <dd>{d.kind === 'new' ? 'New drawing' : 'Revision of a signed drawing'}</dd>
        <dt>Status</dt>
        <dd data-testid="drawing-state">{DRAWING_STATE_LABEL[d.state]}</dd>
        <dt>Reference page</dt>
        <dd>{ref && d.ref_page ? `Page ${d.ref_page} of ${ref.filename}` : d.kind === 'new' ? '—' : 'Not chosen yet'}</dd>
        {d.passed_at && (
          <>
            <dt>Board review</dt>
            <dd>
              Passed by {user(d.passed_by)?.name}, {when(d.passed_at)}
            </dd>
          </>
        )}
        {d.handover_at && (
          <>
            <dt>Handed over</dt>
            <dd>
              {when(d.handover_at)} by {user(d.handover_by)?.name}
            </dd>
          </>
        )}
        {d.signed_at && (
          <>
            <dt>Signed</dt>
            <dd>
              Recorded {when(d.signed_at)} by {user(d.signed_by)?.name}
            </dd>
          </>
        )}
        {d.cleanup === 'failed' && (
          <>
            <dt>Clean-up</dt>
            <dd className="rw-warn">Pending retry: {d.cleanup_detail}</dd>
          </>
        )}
      </dl>
    </section>
  );
}

function Comments({ d, attempt }: { d: ReviewDrawing; attempt: ReviewAttempt }) {
  const { me, user } = useApp();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const closed = d.state === 'signed' || d.state === 'withdrawn';
  const postComment = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    if (await reviewAction('POST', `/api/review/drawings/${d.id}/comments`, { body: text.trim(), attempt_id: attempt.id })) setText('');
    setBusy(false);
  };
  const respond = async (id: number) => {
    const body = await ask({ type: 'text', title: 'Respond to the comment', body: 'Say what you corrected (or why no change is needed). The reviewer resolves the comment.', label: 'Response', confirm: 'Save response', required: true });
    if (body) await reviewAction('POST', `/api/review/comments/${id}/respond`, { body });
  };
  return (
    <section className="rw-card">
      <h2>Reviewer comments</h2>
      {!d.comments.length && <p className="muted small">No comments yet.</p>}
      <ul className="rw-comments">
        {d.comments.map((c) => {
          const author = user(c.user_id);
          const att = d.attempts.find((a) => a.id === c.attempt_id);
          return (
            <li key={c.id} className={`rw-comment${c.resolved_at ? ' resolved' : ''}`}>
              <div className="rw-comment-head">
                <Badge user={author} size="sm" />
                <strong>{author?.name ?? 'Someone'}</strong>
                <span className="muted small">
                  {when(c.created_at)}
                  {att ? ` · attempt ${att.number}` : ''}
                </span>
                <span className="spacer" />
                <span className={`rv-chip ${c.resolved_at ? 'rv-signed' : 'rv-open'}`}>{c.resolved_at ? 'Resolved' : 'Open'}</span>
              </div>
              <p>{c.body}</p>
              {c.response && (
                <p className="rw-response">
                  <strong>{user(c.response_by)?.name}:</strong> {c.response}
                </p>
              )}
              {!c.resolved_at && !closed && (
                <div className="rw-comment-actions">
                  {me.role === 'engineer' && (
                    <button className="link-btn" onClick={() => void respond(c.id)}>
                      {c.response ? 'Change response' : 'Respond'}
                    </button>
                  )}
                  {(canReview(me) || c.user_id === me.id) && (
                    <button className="link-btn" onClick={() => void reviewAction('POST', `/api/review/comments/${c.id}/resolve`)}>
                      Resolve
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {!closed && (
        <div className="rw-add-comment">
          <textarea className="field-input" rows={3} placeholder="Add a review comment…" aria-label="Add a review comment" value={text} maxLength={5000} onChange={(e: any) => setText(e.target.value)} />
          <button className="btn btn-primary btn-sm" disabled={!text.trim() || busy} onClick={() => void postComment()}>
            Post comment
          </button>
        </div>
      )}
    </section>
  );
}

function History({ d, viewing, onView }: { d: ReviewDrawing; viewing: ReviewAttempt; onView: (id: number) => void }) {
  const { user } = useApp();
  return (
    <section className="rw-card">
      <h2>Attempts</h2>
      <ol className="rw-history">
        {[...d.attempts].reverse().map((a) => (
          <li key={a.id} className={a.id === viewing.id ? 'sel' : ''}>
            <div>
              <strong>Attempt {a.number}</strong> · {user(a.submitted_by)?.name}, {when(a.submitted_at)}
            </div>
            <div className="small">
              {a.outcome === 'passed'
                ? `Passed board review by ${user(a.decided_by)?.name}`
                : a.outcome === 'returned'
                  ? `Returned by ${user(a.decided_by)?.name}`
                  : a.outcome === 'superseded'
                    ? 'Replaced before a decision'
                    : 'Awaiting board review'}
            </div>
            {a.available ? (
              a.id !== viewing.id && (
                <button className="link-btn small" onClick={() => onView(a.id)}>
                  View this attempt
                </button>
              )
            ) : (
              <div className="muted small">Intermediate PDF removed after board review</div>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function ActionBar({ w, d, current, mineSubmitted }: { w: ReviewWorkspace; d: ReviewDrawing; current: ReviewAttempt; mineSubmitted: boolean }) {
  const { me, user } = useApp();
  const reviewer = canReview(me);
  const engineer = me.role === 'engineer';
  const open = d.open_comments;
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const pass = () =>
    act(() => reviewAction('POST', `/api/review/drawings/${d.id}/decision`, { attempt_id: current.id, outcome: 'passed' }));
  const ret = () =>
    act(async () => {
      const note = await ask({
        type: 'text',
        title: `Return ${d.identifier} for correction`,
        body: open ? 'The open comments go back with it. Add a note if there is more to say.' : 'Say what needs correcting.',
        label: 'Note to the engineer',
        confirm: 'Return for correction',
        required: !open,
      });
      if (note != null) await reviewAction('POST', `/api/review/drawings/${d.id}/decision`, { attempt_id: current.id, outcome: 'returned', note });
    });
  const handover = () =>
    act(async () => {
      const ok = await ask({
        type: 'confirm',
        title: `Hand over the print of ${d.identifier}?`,
        body: `Confirm that the printed drawing (attempt ${current.number}, the PDF that passed board review) has reached ${user(d.passed_by)?.name ?? 'the reviewer'}. They get one reminder in the board.`,
        confirm: 'Mark handed over',
      });
      if (ok) await reviewAction('POST', `/api/review/drawings/${d.id}/handover`);
    });
  const signed = () =>
    act(async () => {
      const ok = await ask({
        type: 'confirm',
        title: `Record the physical signature of ${d.identifier}?`,
        body: 'Only once the printed drawing has actually been signed. The signed scan already attached is kept as it is; nothing needs uploading.',
        confirm: 'Record signature',
      });
      if (ok) await reviewAction('POST', `/api/review/drawings/${d.id}/signed`);
    });
  const withdraw = () =>
    act(async () => {
      const why = await ask({ type: 'text', title: `Withdraw ${d.identifier}?`, body: 'It no longer counts towards this job. Its history is kept.', label: 'Reason', confirm: 'Withdraw', danger: true });
      if (why != null) await reviewAction('POST', `/api/review/drawings/${d.id}/withdraw`, { body: why });
    });
  const resubmit = () => {
    const p = new URLSearchParams(location.search);
    p.set('submit', '1');
    p.set('for', String(d.id));
    replaceParams(p);
  };

  let status: any;
  if (d.state === 'awaiting') status = open ? <span className="rw-status-warn">⚠ {open} open comment{open === 1 ? '' : 's'}</span> : <span className="rw-status-ok">Ready for review</span>;
  else status = <span>{DRAWING_STATE_LABEL[d.state]}</span>;

  return (
    <footer className="rw-actions" data-testid="action-bar">
      <div className="rw-actions-status">{status}</div>
      <div className="rw-actions-buttons">
        {d.state === 'awaiting' && reviewer && (
          <>
            <button className="btn btn-return" disabled={busy || mineSubmitted} onClick={() => void ret()}>
              ↺ Return for correction
            </button>
            <div className="rw-pass">
              <button className="btn btn-pass" disabled={busy || !!open || mineSubmitted} onClick={() => void pass()}>
                ✓ Pass board review
              </button>
              <span className="muted small">{open ? 'Resolve open comments to pass' : 'Internal check only: the print still needs a physical signature'}</span>
            </div>
          </>
        )}
        {d.state === 'awaiting' && !reviewer && <span className="muted small">Waiting for the manager or a reviewer.</span>}
        {['awaiting', 'returned'].includes(d.state) && engineer && (
          <button className="btn btn-quiet" disabled={busy} onClick={() => void withdraw()}>
            Withdraw
          </button>
        )}
        {d.state === 'returned' && engineer && (
          <button className="btn btn-primary" onClick={resubmit}>
            Submit corrected drawing…
          </button>
        )}
        {['passed', 'handed_over'].includes(d.state) && (
          <a className="btn" href={fileUrl(current.sha256)} target="_blank" rel="noopener" title="The exact PDF that passed board review">
            Open reviewed PDF to print
          </a>
        )}
        {d.state === 'passed' && engineer && (
          <button className="btn btn-primary" disabled={busy} onClick={() => void handover()}>
            Mark handed over for signature
          </button>
        )}
        {d.state === 'handed_over' && (engineer || reviewer) && (
          <button className="btn btn-primary" disabled={busy} onClick={() => void signed()}>
            Record physical signature
          </button>
        )}
        {['passed', 'handed_over'].includes(d.state) && engineer && (
          <button className="btn btn-quiet" onClick={resubmit} title="A changed PDF needs a new board review decision">
            Submit a change…
          </button>
        )}
        {d.state === 'signed' && w.signatures_pending === 0 && <span className="rw-status-ok">All drawings signed</span>}
      </div>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Submitting drawings
// ---------------------------------------------------------------------------

interface Pending {
  key: number;
  file: File;
  progress: number;
  result?: ReviewFile;
  error?: string;
}
interface PendingDrawing extends Pending {
  identifier: string;
  kind: 'revision' | 'new';
  notes: string;
}

let seq = 0;
const stem = (n: string) => n.replace(/\.pdf$/i, '').trim();

function SubmitPanel({ w, forDrawing, onClose }: { w: ReviewWorkspace; forDrawing: number | null; onClose: () => void }) {
  const [refs, setRefs] = useState<Pending[]>([]);
  const [drawings, setDrawings] = useState<PendingDrawing[]>([]);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  useFocusTrap(box);
  const target = w.drawings.find((d) => d.id === forDrawing) ?? null;
  const existing = useMemo(() => new Map(w.drawings.map((d) => [d.identifier.toLowerCase(), d])), [w.drawings]);
  const hasRef = w.references.length > 0 || refs.some((r) => r.result);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [busy]);

  const start = <T extends Pending>(file: File, kind: 'drawing' | 'reference', set: (fn: (xs: T[]) => T[]) => void, item: T) => {
    set((xs) => [...xs, item]);
    const upd = (patch: Partial<T>) => set((xs) => xs.map((x) => (x.key === item.key ? { ...x, ...patch } : x)));
    uploadPdf(file, kind, (f) => upd({ progress: f } as Partial<T>)).then(
      (result) => upd({ result, progress: 1 } as Partial<T>),
      (e) => upd({ error: e.message } as Partial<T>),
    );
  };
  const addRefs = (files: FileList | null) => {
    for (const f of Array.from(files ?? [])) start(f, 'reference', setRefs, { key: ++seq, file: f, progress: 0 });
  };
  const addDrawings = (files: FileList | null) => {
    for (const f of Array.from(files ?? [])) {
      const id = target && files!.length === 1 ? target.identifier : stem(f.name);
      const match = existing.get(id.toLowerCase());
      start(f, 'drawing', setDrawings, {
        key: ++seq,
        file: f,
        progress: 0,
        identifier: id,
        kind: match ? match.kind : hasRef ? 'revision' : 'new',
        notes: '',
      });
    }
  };
  const edit = (key: number, patch: Partial<PendingDrawing>) => setDrawings((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  const uploading = [...refs, ...drawings].some((x) => !x.result && !x.error);
  const failed = [...refs, ...drawings].some((x) => x.error);
  const missingNotes = drawings.some((d) => !d.notes.trim() || !d.identifier.trim());
  const revisionWithoutRef = drawings.some((d) => d.kind === 'revision' && !existing.has(d.identifier.toLowerCase()) && !hasRef);
  const canSubmit = (drawings.length > 0 || refs.length > 0) && !uploading && !failed && !missingNotes && !revisionWithoutRef && !busy;

  const submitNow = async () => {
    if (!canSubmit) return;
    setBusy(true);
    const res = await reviewAction('POST', `/api/tickets/${w.ticket.id}/review/submissions`, {
      references: refs.map((r) => ({ sha256: r.result!.sha256, filename: r.result!.filename })),
      drawings: drawings.map((d) => ({ sha256: d.result!.sha256, filename: d.result!.filename, identifier: d.identifier.trim(), kind: d.kind, notes: d.notes.trim() })),
    });
    setBusy(false);
    if (res) {
      toast(drawings.length ? `Submitted for board review: ${drawings.map((d) => d.identifier).join(', ')}` : 'Signed scan attached', { kind: 'success' });
      invalidate('/api/reviews');
      onClose();
    }
  };

  return (
    <div className="dialog-backdrop">
      <div className="dialog rw-submit" role="dialog" aria-modal="true" aria-labelledby="submit-title" ref={box}>
        <h2 className="dialog-title" id="submit-title">
          {target ? `Submit a corrected ${target.identifier}` : 'Submit drawings for board review'} · {w.ticket.job_number}
        </h2>
        <p className="dialog-sub muted">
          Attach each drawing as its own single-page PDF, named with its part number (e.g. BRK-023.pdf). For revisions, attach the signed, scanned set of the previous revision as the reference. The board keeps exact copies; your files are never changed.
        </p>

        {!target && (
          <section className="rw-submit-sec">
            <h3>Signed reference scan</h3>
            {w.references.map((r) => (
              <div key={r.id} className="rw-file done">
                📄 {r.filename} <span className="muted small">· {r.pages} pages · already attached</span>
              </div>
            ))}
            {refs.map((r) => (
              <FileRow key={r.key} p={r} detail={r.result ? `${r.result.pages} page${r.result.pages === 1 ? '' : 's'} · protected: never changed or removed` : undefined} onRemove={() => setRefs((xs) => xs.filter((x) => x.key !== r.key))} />
            ))}
            <label className="btn btn-sm rw-pick">
              Attach signed scan (PDF)…
              <input type="file" accept="application/pdf,.pdf" hidden data-testid="pick-reference" onChange={(e: any) => { addRefs(e.target.files); e.target.value = ''; }} />
            </label>
          </section>
        )}

        <section className="rw-submit-sec">
          <h3>Drawings</h3>
          {drawings.map((d) => {
            const match = existing.get(d.identifier.trim().toLowerCase());
            return (
              <div key={d.key} className="rw-submit-drawing">
                <FileRow p={d} onRemove={() => setDrawings((xs) => xs.filter((x) => x.key !== d.key))} />
                {!d.error && (
                  <div className="rw-submit-fields">
                    <label>
                      <span className="field-label">Drawing number</span>
                      <input className="field-input" value={d.identifier} onChange={(e: any) => edit(d.key, { identifier: e.target.value })} aria-label={`Drawing number for ${d.file.name}`} />
                    </label>
                    <label>
                      <span className="field-label">Type</span>
                      <select className="field-input" value={d.kind} disabled={!!match} onChange={(e: any) => edit(d.key, { kind: e.target.value })} aria-label={`Type of ${d.file.name}`}>
                        <option value="revision">Revision of a signed drawing</option>
                        <option value="new">New drawing</option>
                      </select>
                    </label>
                    <div className="rw-match small">
                      {match ? (
                        <>Resubmission of {match.identifier}: attempt {match.attempts.length + 1}</>
                      ) : d.kind === 'revision' && !hasRef ? (
                        <span className="rw-warn">Attach the signed scan of the previous revision first</span>
                      ) : (
                        <>New in this job</>
                      )}
                    </div>
                    <label className="rw-notes-field">
                      <span className="field-label">{d.kind === 'new' && !match ? 'Purpose of the new drawing' : 'What changed and why'}</span>
                      <textarea className="field-input" rows={2} value={d.notes} maxLength={5000} onChange={(e: any) => edit(d.key, { notes: e.target.value })} aria-label={`Notes for ${d.file.name}`} />
                    </label>
                  </div>
                )}
              </div>
            );
          })}
          <label className="btn btn-sm rw-pick">
            {target ? `Choose the corrected ${target.identifier} PDF…` : 'Add drawing PDFs…'}
            <input type="file" accept="application/pdf,.pdf" multiple={!target} hidden data-testid="pick-drawings" onChange={(e: any) => { addDrawings(e.target.files); e.target.value = ''; }} />
          </label>
        </section>

        <div className="dialog-buttons">
          {uploading && <span className="muted small">Uploading…</span>}
          {!uploading && failed && <span className="rw-warn small">Remove the files that could not be used</span>}
          {!uploading && !failed && missingNotes && drawings.length > 0 && <span className="muted small">Add notes for every drawing</span>}
          <button className="btn btn-quiet" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" disabled={!canSubmit} onClick={() => void submitNow()}>
            {drawings.length ? `Submit ${drawings.length} drawing${drawings.length === 1 ? '' : 's'} for board review` : 'Attach signed scan'}
          </button>
        </div>
      </div>
    </div>
  );
}

function FileRow({ p, detail, onRemove }: { p: Pending; detail?: string; onRemove: () => void }) {
  return (
    <div className={`rw-file${p.error ? ' error' : p.result ? ' done' : ''}`}>
      <span>📄 {p.file.name}</span>
      {!p.result && !p.error && (
        <progress max={1} value={p.progress} aria-label={`Uploading ${p.file.name}`}>
          {Math.round(p.progress * 100)}%
        </progress>
      )}
      {p.result && <span className="muted small">{detail ?? `${p.result.pages} page · ${(p.result.size / 1024).toFixed(0)} KB`}</span>}
      {p.error && <span className="rw-file-error" role="alert">{p.error}</span>}
      <span className="spacer" />
      <button className="icon-btn" onClick={onRemove} aria-label={`Remove ${p.file.name}`} title="Remove">
        ✕
      </button>
    </div>
  );
}
