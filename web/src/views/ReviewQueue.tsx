// Drawing review queue: every job with drawings in board review.

import { useEffect, useState } from 'react';
import { seesWholeBoard, type ReviewQueueRow, type ReviewWorkspace } from '@board/shared';
import { useApp } from '../context.ts';
import { when } from '../lib/format.ts';
import { navigate, replaceParams, useLocation } from '../lib/router.ts';
import { useQuery } from '../lib/store.ts';
import { fileUrl } from '../lib/pdf.ts';
import { Badge, ErrorBox, Spinner } from '../components/bits.tsx';
import { PdfThumb } from '../components/PdfViewer.tsx';

type Tab = 'awaiting' | 'returned' | 'signature' | 'done' | 'all';
interface QueueData {
  rows: ReviewQueueRow[];
  counts: Record<Tab | 'passed_this_month' | 'to_sign_mine', number>;
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'awaiting', label: 'Awaiting review' },
  { id: 'returned', label: 'Returned' },
  { id: 'signature', label: 'Signature pending' },
  { id: 'done', label: 'Signed' },
  { id: 'all', label: 'All' },
];

export function rowStatus(r: ReviewQueueRow): { label: string; tone: string } {
  if (r.awaiting) return { label: 'Awaiting review', tone: 'awaiting' };
  if (r.returned) return { label: 'Returned', tone: 'returned' };
  if (r.passed) return { label: 'Signature pending', tone: 'passed' };
  if (r.handed_over) return { label: 'With reviewer to sign', tone: 'handed_over' };
  return { label: 'Signed', tone: 'signed' };
}

export const folderName = (f: string) => f.trim().replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';

export function ReviewQueue() {
  const { me, user } = useApp();
  const whole = seesWholeBoard(me);
  const { params } = useLocation();
  const tab = (TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'awaiting') as Tab;
  const [q, setQ] = useState(params.get('q') ?? '');
  const [selected, setSelected] = useState<number | null>(null);
  const data = useQuery<QueueData>(`/api/reviews?tab=${tab}&q=${encodeURIComponent(params.get('q') ?? '')}`);

  useEffect(() => {
    const t = setTimeout(() => {
      const p = new URLSearchParams(params);
      if (q.trim()) p.set('q', q.trim());
      else p.delete('q');
      replaceParams(p);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const rows = data.data?.rows ?? [];
  useEffect(() => {
    if (rows.length && !rows.some((r) => r.ticket_id === selected)) setSelected(rows[0].ticket_id);
    if (!rows.length) setSelected(null);
  }, [data.data]);

  const setTab = (t: Tab) => {
    const p = new URLSearchParams(params);
    p.set('tab', t);
    replaceParams(p);
  };
  const c = data.data?.counts;
  const sel = rows.find((r) => r.ticket_id === selected) ?? null;

  return (
    <div className="view review-queue">
      <header className="view-head">
        <div>
          <h1>Drawing review</h1>
          <p className="view-lede">
            {whole
              ? 'Review submitted drawings and revision notes. Passing board review is an internal check: the printed drawing still needs its physical signature.'
              : 'The drawings engineers have handed to you for review. Passing board review is an internal check: the printed drawing still needs its physical signature.'}
          </p>
        </div>
      </header>

      {!!c?.to_sign_mine && (
        <div className="banner banner-info" role="status">
          {c.to_sign_mine === 1 ? '1 printed drawing you passed has' : `${c.to_sign_mine} printed drawings you passed have`} been handed to you for signature.{' '}
          <button className="link-btn" onClick={() => setTab('signature')}>
            Show them
          </button>
        </div>
      )}

      <div className="rv-stats">
        <button className="rv-stat tone-awaiting" onClick={() => setTab('awaiting')}>
          <strong>{c?.awaiting ?? '–'}</strong>
          <span>Awaiting review</span>
        </button>
        <button className="rv-stat tone-returned" onClick={() => setTab('returned')}>
          <strong>{c?.returned ?? '–'}</strong>
          <span>Returned</span>
        </button>
        <button className="rv-stat tone-passed" onClick={() => setTab('signature')}>
          <strong>{c?.signature ?? '–'}</strong>
          <span>Signature pending</span>
        </button>
        <div className="rv-stat tone-signed">
          <strong>{c?.passed_this_month ?? '–'}</strong>
          <span>Drawings passed this month</span>
        </div>
      </div>

      <div className="rv-layout">
        <section className="rv-list">
          <div className="rv-tools">
            <div className="seg" role="tablist" aria-label="Review status">
              {TABS.map((t) => (
                <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
                  {t.label} ({c?.[t.id] ?? 0})
                </button>
              ))}
            </div>
            <input className="field-input rv-search" type="search" placeholder={whole ? 'Find job, drawing or folder' : 'Find job or drawing'} aria-label={whole ? 'Find job, drawing or folder' : 'Find job or drawing'} value={q} onChange={(e: any) => setQ(e.target.value)} />
          </div>
          {data.error && <ErrorBox message={data.error.message} retry={data.refresh} />}
          {!data.data && !data.error && <Spinner />}
          {data.data && !rows.length && (
            <p className="empty muted">{tab === 'awaiting' ? (whole ? 'Nothing is waiting for board review.' : 'Nothing is waiting for your review.') : 'No jobs here.'}{' '}
              {whole ? 'Engineers submit drawings from a job ("Submit for board review").' : 'When an engineer hands you a drawing, it appears here and in your notifications.'}</p>
          )}
          {!!rows.length && (
            <table className="rv-table">
              <thead>
                <tr>
                  <th>Job / project</th>
                  <th>Drawings</th>
                  <th>Submitted by</th>
                  <th>Submitted</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const st = rowStatus(r);
                  return (
                    <tr
                      key={r.ticket_id}
                      className={r.ticket_id === selected ? 'sel' : ''}
                      onClick={() => setSelected(r.ticket_id)}
                      onDoubleClick={() => navigate(`/review/${r.ticket_id}`)}
                    >
                      <td>
                        <a
                          className="rv-jobno"
                          href={`/review/${r.ticket_id}`}
                          onClick={(e: any) => {
                            e.preventDefault();
                            navigate(`/review/${r.ticket_id}`);
                          }}
                        >
                          {r.job_number}
                        </a>
                        <div className="rv-title">{r.title}</div>
                        {(r.project || r.folder) && <div className="muted small">{r.project ?? folderName(r.folder)}</div>}
                      </td>
                      <td>
                        {r.drawings} drawing{r.drawings === 1 ? '' : 's'}
                        <div className="muted small">
                          {[r.revised && `${r.revised} revised`, r.new_count && `${r.new_count} new`].filter(Boolean).join(' · ')}
                        </div>
                      </td>
                      <td>{user(r.submitted_by)?.name ?? '—'}</td>
                      <td>{when(r.submitted_at)}</td>
                      <td>
                        <span className={`rv-chip rv-${st.tone}`}>{st.label}</span>
                        {!!r.open_comments && <div className="muted small">{r.open_comments} open comment{r.open_comments === 1 ? '' : 's'}</div>}
                        {r.signers.includes(me.id) && <div className="rv-to-sign small">Yours to sign</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>
        <aside className="rv-side">{sel ? <QueuePreview row={sel} /> : <p className="muted">Select a job to preview it.</p>}</aside>
      </div>
    </div>
  );
}

function QueuePreview({ row }: { row: ReviewQueueRow }) {
  const { user } = useApp();
  const w = useQuery<ReviewWorkspace>(`/api/tickets/${row.ticket_id}/review`);
  const ws = w.data;
  const current = ws?.drawings.filter((d) => d.state !== 'withdrawn') ?? [];
  const reviewers = [...new Set(current.map((d) => d.passed_by).filter((x): x is number => x != null))];
  return (
    <div className="rv-preview">
      <div className="muted small">Submission {row.submissions}</div>
      <h2 className="rv-preview-job">{row.job_number}</h2>
      <div className="rv-preview-title">{row.title}</div>
      {(row.project || row.folder) && <div className="muted small">{row.project ?? folderName(row.folder)}</div>}
      {!ws && <Spinner />}
      {ws && (
        <>
          <div className="rv-thumbs">
            {current.slice(0, 4).map((d) => {
              const a = d.attempts.find((x) => x.id === d.current_attempt_id);
              return (
                <figure key={d.id}>
                  {a?.available ? <PdfThumb url={fileUrl(a.sha256)} label={d.identifier} /> : <div className="pdf-thumb pdf-thumb-missing">{d.identifier}</div>}
                  <figcaption>
                    <strong>{d.identifier}</strong> · {d.kind === 'new' ? 'New drawing' : `Revision, attempt ${a?.number ?? 1}`}
                  </figcaption>
                </figure>
              );
            })}
          </div>
          <h3 className="rv-h3">Revision summary</h3>
          <ul className="rv-summary">
            {current.map((d) => {
              const a = d.attempts.find((x) => x.id === d.current_attempt_id);
              return (
                <li key={d.id}>
                  <strong>{d.identifier}:</strong> {a?.notes.split('\n')[0]}
                </li>
              );
            })}
          </ul>
          <div className="rv-people">
            <div>
              <span className="muted small">Engineer</span>
              <div>
                <Badge user={user(row.submitted_by)} size="sm" /> {user(row.submitted_by)?.name ?? '—'}
              </div>
            </div>
            <div>
              <span className="muted small">Reviewer</span>
              <div>{reviewers.length ? reviewers.map((id) => user(id)?.name).join(', ') : '—'}</div>
            </div>
          </div>
        </>
      )}
      <button className="btn btn-primary rv-open-btn" onClick={() => navigate(`/review/${row.ticket_id}`)}>
        Open review
      </button>
      <p className="muted small">Submitted drawings are kept exactly as submitted for review.</p>
    </div>
  );
}
