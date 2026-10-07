// "+ New job": title first, everything else optional. Enter creates;
// Shift+Enter creates and claims (engineers).

import { useEffect, useRef, useState } from 'react';
import { ESTIMATE_BUCKETS, PRIORITIES, type Priority } from '@board/shared';
import { useApp } from '../context.ts';
import { claimTicket, createTicket } from '../lib/actions.ts';
import { newKey } from '../lib/api.ts';
import { toast } from '../lib/toasts.ts';
import { PRIORITY_TEXT } from './bits.tsx';
import { ProjectPicker } from './ProjectPicker.tsx';
import { useLocation } from '../lib/router.ts';

/** The project used for the last new job, offered again for the next one (this page only). */
let lastProject: number | null = null;

export function QuickCreate({ onClose }: { onClose: () => void }) {
  const { me, jobTypes, openJob, project: projectById, can } = useApp();
  const { path, params } = useLocation();
  // on a project's page, new jobs go to that project
  const pagePj = path === '/projects' ? Number(params.get('project')) || null : null;
  const [project, setProject] = useState<number | null>(() => {
    const pick = pagePj ?? lastProject;
    return pick != null && projectById(pick) ? pick : null;
  });
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [estimate, setEstimate] = useState('');
  const [due, setDue] = useState('');
  const [jobType, setJobType] = useState('');
  const [requester, setRequester] = useState('');
  const [busy, setBusy] = useState(false);
  const [showMore, setShowMore] = useState(false);
  // one key per form: a retried submit returns the same job instead of a duplicate
  const key = useRef(newKey());
  const titleRef = useRef<HTMLInputElement | null>(null);
  const canClaim = can('claim');

  useEffect(() => {
    titleRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function submit(claim: boolean) {
    if (!title.trim()) {
      titleRef.current?.focus();
      toast('Give the job a short title first', { kind: 'error' });
      return;
    }
    if (project == null) {
      document.getElementById('qc-project')?.focus();
      toast('Choose the project this job belongs to (or add it with "+ Add a project…")', { kind: 'error' });
      return;
    }
    if (busy) return;
    setBusy(true);
    const t = await createTicket(
      {
        title: title.trim(),
        project_id: project,
        description,
        priority,
        estimate_minutes: estimate ? Number(estimate) : null,
        due_date: due || null,
        job_type_id: jobType ? Number(jobType) : null,
        requester,
        claim: claim && canClaim,
      },
      key.current,
    );
    setBusy(false);
    if (!t) return; // error already shown; the form keeps what was typed
    lastProject = project;
    onClose();
    toast(`${t.job_number} created${t.assigned_to ? ' and claimed' : ''}`, {
      kind: 'success',
      timeout: 7000,
      action:
        !t.assigned_to && canClaim
          ? { label: 'Claim it', run: () => void claimTicket(t) }
          : { label: 'Open', run: () => openJob(t.id) },
    });
  }

  const onKeyDown = (e: any) => {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault();
      void submit(e.shiftKey);
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit(e.shiftKey);
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={(e: any) => e.target === e.currentTarget && onClose()}>
      <form className="quick-create" onKeyDown={onKeyDown} onSubmit={(e: any) => e.preventDefault()} aria-label="New job">
        <label className="qc-label" htmlFor="qc-title">
          What needs to be done?
        </label>
        <input
          id="qc-title"
          ref={titleRef}
          className="qc-title"
          value={title}
          maxLength={200}
          autoComplete="off"
          placeholder="e.g. Revise pump housing drawing to Rev D"
          onChange={(e: any) => setTitle(e.target.value)}
        />
        <label className="qc-project">
          <span className="field-label">Project</span>
          <ProjectPicker id="qc-project" value={project} onChange={setProject} required />
        </label>
        <textarea
          className="field-input"
          rows={2}
          value={description}
          placeholder="Details of the request (optional)"
          aria-label="Description"
          onChange={(e: any) => setDescription(e.target.value)}
        />
        <div className="qc-row">
          <label>
            <span className="field-label">Priority</span>
            <select className="field-input" value={priority} onChange={(e: any) => setPriority(e.target.value)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_TEXT[p]}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="field-label">Estimate</span>
            <select className="field-input" value={estimate} onChange={(e: any) => setEstimate(e.target.value)}>
              <option value="">Not sure yet</option>
              {ESTIMATE_BUCKETS.map((b) => (
                <option key={b.minutes} value={b.minutes}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="field-label">Due</span>
            <input type="date" className="field-input" value={due} onChange={(e: any) => setDue(e.target.value)} />
          </label>
        </div>
        {showMore ? (
          <div className="qc-row">
            <label>
              <span className="field-label">Job type</span>
              <select className="field-input" value={jobType} onChange={(e: any) => setJobType(e.target.value)}>
                <option value="">None</option>
                {jobTypes
                  .filter((j) => j.active)
                  .map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.name}
                    </option>
                  ))}
              </select>
            </label>
            <label className="grow">
              <span className="field-label">Requester</span>
              <input className="field-input" value={requester} placeholder="Who asked?" onChange={(e: any) => setRequester(e.target.value)} />
            </label>
          </div>
        ) : (
          <button type="button" className="link-btn" onClick={() => setShowMore(true)}>
            Add job type and requester
          </button>
        )}
        <div className="qc-buttons">
          <span className="muted qc-hint">{canClaim ? 'Enter creates. Shift+Enter creates and claims.' : 'Enter creates.'}</span>
          <button type="button" className="btn btn-quiet" onClick={onClose}>
            Cancel
          </button>
          {canClaim && (
            <button type="button" className="btn" disabled={busy} onClick={() => void submit(true)}>
              Create and claim
            </button>
          )}
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit(false)}>
            {busy ? 'Creating…' : 'Create job'}
          </button>
        </div>
      </form>
    </div>
  );
}
