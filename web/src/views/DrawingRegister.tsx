// The drawing register (decision #35): every drawing number that has been
// through board review, with its latest signed revision and what is in
// review for it now. Opened from the Review page (G anywhere).

import { useEffect, useState } from 'react';
import { DRAWING_STATE_LABEL, type DrawingState } from '@board/shared';
import { useApp } from '../context.ts';
import { localDay } from '../lib/format.ts';
import { fileUrl } from '../lib/pdf.ts';
import { navigate, replaceParams, useLocation } from '../lib/router.ts';
import { useQuery } from '../lib/store.ts';
import { Badge, ErrorBox, Spinner } from '../components/bits.tsx';

interface RegisterRecord {
  drawing_id: number;
  identifier: string;
  revision: string | null;
  kind: 'revision' | 'new';
  state: DrawingState;
  state_label: string;
  ticket_id: number;
  job_number: string;
  title: string;
  job_status: string;
  archived: boolean;
  project_id: number | null;
  project: string | null;
  created_at: string;
  updated_at: string;
  attempts: number;
  passed_by: number | null;
  passed_at: string | null;
  handover_at: string | null;
  signed_by: number | null;
  signed_at: string | null;
  file: { filename: string; sha256: string; notes: string; available: boolean } | null;
}
interface RegisterEntry {
  identifier: string;
  latest_signed: RegisterRecord | null;
  in_review: RegisterRecord | null;
  projects: string[];
  records: number;
  signed_count: number;
  last_change: string;
}

type Filter = 'all' | 'signed' | 'in_review' | 'never_signed';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'signed', label: 'Signed' },
  { id: 'in_review', label: 'In review now' },
  { id: 'never_signed', label: 'Never signed' },
];

const rev = (r: string | null) => (r ? `Rev ${r}` : 'No rev');

export function DrawingRegister() {
  const { projects } = useApp();
  const { params } = useLocation();
  const filter = (FILTERS.some((f) => f.id === params.get('filter')) ? params.get('filter') : 'all') as Filter;
  const project = params.get('project') ?? '';
  const [q, setQ] = useState(params.get('q') ?? '');
  const [open, setOpen] = useState<string | null>(params.get('drawing'));
  const qs = new URLSearchParams();
  if (filter !== 'all') qs.set('filter', filter);
  if (project) qs.set('project', project);
  if (params.get('q')) qs.set('q', params.get('q')!);
  const data = useQuery<{ drawings: RegisterEntry[]; total: number }>(`/api/drawings?${qs}`);

  useEffect(() => {
    const t = setTimeout(() => {
      const p = new URLSearchParams(params);
      if (q.trim()) p.set('q', q.trim());
      else p.delete('q');
      replaceParams(p);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const setParam = (k: string, val: string) => {
    const p = new URLSearchParams(params);
    if (val && val !== 'all') p.set(k, val);
    else p.delete(k);
    replaceParams(p);
  };
  const toggle = (id: string) => {
    const next = open?.toLowerCase() === id.toLowerCase() ? null : id;
    setOpen(next);
    setParam('drawing', next ?? '');
  };
  const rows = data.data?.drawings ?? [];

  return (
    <div className="view drawing-register">
      <header className="view-head view-head-row">
        <div>
          <h1>Drawing register</h1>
          <p className="view-lede">
            Every drawing number that has been through board review, with its latest signed revision and anything in review for it now. Open a number for its
            history across jobs.
          </p>
        </div>
        <button className="btn btn-quiet" onClick={() => navigate('/review')}>
          Review queue
        </button>
      </header>

      <div className="reg-tools">
        <div className="seg-tabs" role="tablist" aria-label="Which drawings">
          {FILTERS.map((f) => (
            <button key={f.id} role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'on' : ''} onClick={() => setParam('filter', f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <select className="field-input reg-project" value={project} aria-label="Project" onChange={(e: any) => setParam('project', e.target.value)}>
          <option value="">Every project</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <input
          className="field-input reg-search"
          type="search"
          placeholder="Find drawing number, job, revision or note"
          aria-label="Find drawing number, job, revision or note"
          value={q}
          onChange={(e: any) => setQ(e.target.value)}
        />
        <span className="muted small">{data.data ? `${data.data.total} drawing${data.data.total === 1 ? '' : 's'}` : ''}</span>
      </div>

      {data.error && <ErrorBox message={data.error.message} retry={data.refresh} />}
      {!data.data && !data.error && <Spinner />}
      {data.data && !rows.length && (
        <p className="empty muted">
          {filter === 'all' && !params.get('q') && !project
            ? 'No drawings yet. Drawings appear here once they are submitted for board review.'
            : 'No drawings match.'}
        </p>
      )}
      {!!rows.length && (
        <div className="reg-wrap">
          <table className="table reg-table" data-testid="register">
            <thead>
              <tr>
                <th>Drawing</th>
                <th>Latest signed</th>
                <th>In review now</th>
                <th>Project</th>
                <th className="num">Jobs</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => {
                const isOpen = open?.toLowerCase() === d.identifier.toLowerCase();
                return (
                  <RegisterRow key={d.identifier.toLowerCase()} d={d} open={isOpen} onToggle={() => toggle(d.identifier)} />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RegisterRow({ d, open, onToggle }: { d: RegisterEntry; open: boolean; onToggle: () => void }) {
  const { user } = useApp();
  const s = d.latest_signed;
  const r = d.in_review;
  return (
    <>
      <tr className={`reg-row${open ? ' open' : ''}`} data-drawing={d.identifier}>
        <td>
          <button className="reg-id" aria-expanded={open} onClick={onToggle}>
            <span className="reg-caret" aria-hidden="true">
              {open ? '▾' : '▸'}
            </span>
            {d.identifier}
          </button>
        </td>
        <td>
          {s ? (
            <div className="reg-cell">
              <span className="reg-rev reg-rev-signed">{rev(s.revision)}</span>
              <span>
                Signed {localDay(s.signed_at!)}
                {s.signed_by != null && (
                  <>
                    {' '}
                    by <Badge user={user(s.signed_by)} size="sm" />
                  </>
                )}
              </span>
              <span className="muted small">
                {s.job_number}
                {s.file?.available && (
                  <>
                    {' · '}
                    <a href={fileUrl(s.file.sha256)} target="_blank" rel="noopener">
                      PDF
                    </a>
                  </>
                )}
              </span>
            </div>
          ) : (
            <span className="muted">Never signed</span>
          )}
        </td>
        <td>
          {r ? (
            <div className="reg-cell">
              <span className="reg-rev">{rev(r.revision)}</span>
              <span className={`reg-state state-${r.state}`}>{DRAWING_STATE_LABEL[r.state]}</span>
              <a className="muted small" href={`/review/${r.ticket_id}`} onClick={(e: any) => (e.preventDefault(), navigate(`/review/${r.ticket_id}`))}>
                {r.job_number}
              </a>
            </div>
          ) : (
            <span className="muted">–</span>
          )}
        </td>
        <td>{d.projects.length ? d.projects.join(', ') : <span className="muted">No project</span>}</td>
        <td className="num">{d.records}</td>
      </tr>
      {open && (
        <tr className="reg-history-row">
          <td colSpan={5}>
            <History identifier={d.identifier} />
          </td>
        </tr>
      )}
    </>
  );
}

function History({ identifier }: { identifier: string }) {
  const { user, openJob } = useApp();
  const h = useQuery<{ identifier: string; records: RegisterRecord[] }>(`/api/drawings/history?identifier=${encodeURIComponent(identifier)}`);
  if (h.error) return <ErrorBox message={h.error.message} retry={h.refresh} />;
  if (!h.data) return <Spinner />;
  return (
    <ol className="reg-history" aria-label={`History of ${identifier}`}>
      {h.data.records.map((x) => (
        <li key={x.drawing_id} className={`reg-entry state-${x.state}`}>
          <div className="reg-entry-head">
            <span className={`reg-rev${x.state === 'signed' ? ' reg-rev-signed' : ''}`}>{rev(x.revision)}</span>
            <strong>{x.state_label}</strong>
            <span className="muted">{x.kind === 'new' ? 'New drawing' : 'Revision'}</span>
            <span className="spacer" />
            <a href={`/review/${x.ticket_id}`} onClick={(e: any) => (e.preventDefault(), navigate(`/review/${x.ticket_id}`))}>
              {x.job_number} · {x.title}
            </a>
            <button className="link-btn" onClick={() => openJob(x.ticket_id)}>
              Open job
            </button>
          </div>
          <div className="reg-entry-facts muted small">
            {x.project ?? 'No project'} · submitted {localDay(x.created_at)} · {x.attempts} attempt{x.attempts === 1 ? '' : 's'}
            {x.passed_at && <> · passed {localDay(x.passed_at)} by {user(x.passed_by)?.name ?? 'someone'}</>}
            {x.signed_at && <> · signed {localDay(x.signed_at)} by {user(x.signed_by)?.name ?? 'someone'}</>}
            {x.archived && <> · job archived</>}
          </div>
          {x.file && (
            <div className="reg-entry-notes">
              <span className="muted small">Revision notes ({x.file.filename}):</span> {x.file.notes}
              {x.file.available ? (
                <>
                  {' '}
                  <a href={fileUrl(x.file.sha256)} target="_blank" rel="noopener">
                    Open the PDF
                  </a>
                </>
              ) : (
                <span className="muted small"> (PDF no longer kept)</span>
              )}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}
