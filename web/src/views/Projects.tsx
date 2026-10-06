// Projects (decision #30): the list the team adds to as projects come up, and
// for each project every job in it. Every job belongs to a project.

import { useMemo, useState } from 'react';
import { STATUS_LABEL, type Project, type Status, type Ticket } from '@board/shared';
import { useApp } from '../context.ts';
import { navigate, replaceParams, useLocation } from '../lib/router.ts';
import { useQuery } from '../lib/store.ts';
import { ErrorBox, Spinner } from '../components/bits.tsx';
import { JobRow, Section } from '../components/JobRow.tsx';
import { addProject } from '../components/ProjectPicker.tsx';

const OPEN_ORDER: Status[] = ['inbox', 'claimed', 'in_progress', 'waiting', 'blocked', 'review'];

export function Projects() {
  const { projects, newJob } = useApp();
  const { params } = useLocation();
  const [find, setFind] = useState('');
  const sel = params.get('project');
  const selectedId = sel === 'none' ? 'none' : Number(sel) || null;
  const noProject = useQuery<{ total: number }>('/api/tickets?project=none&archived=include&limit=1');
  const missing = noProject.data?.total ?? 0;

  const select = (id: number | 'none' | null) => {
    const p = new URLSearchParams(location.search);
    if (id == null) p.delete('project');
    else p.set('project', String(id));
    replaceParams(p);
  };
  const add = async () => {
    const p = await addProject();
    if (p) select(p.id);
  };

  const shown = projects.filter((p) => p.name.toLowerCase().includes(find.trim().toLowerCase()));
  const current = selectedId === 'none' ? 'none' : projects.find((p) => p.id === selectedId) ?? null;

  return (
    <div className="view projects-view">
      <header className="view-head">
        <div className="view-head-row">
          <h1>Projects</h1>
          <span className="spacer" />
          <button className="btn btn-primary" onClick={() => void add()}>
            + Add project
          </button>
        </div>
        <p className="view-lede">Every job belongs to a project. Add a project here, or from the New job form, when its first job comes in.</p>
      </header>

      <div className="pj-layout">
        <nav className="pj-list" aria-label="Projects">
          <input className="field-input" type="search" placeholder="Find a project" aria-label="Find a project" value={find} onChange={(e: any) => setFind(e.target.value)} />
          {!projects.length && (
            <p className="muted pj-empty">
              No projects yet. <button className="link-btn" onClick={() => void add()}>Add the first one</button>
            </p>
          )}
          <ul>
            {shown.map((p) => (
              <li key={p.id}>
                <button className={`pj-item${current !== 'none' && current?.id === p.id ? ' sel' : ''}`} aria-current={current !== 'none' && current?.id === p.id} onClick={() => select(p.id)}>
                  <span className="pj-name">{p.name}</span>
                  <span className="pj-counts muted small">
                    {p.open} open · {p.total} total
                  </span>
                </button>
              </li>
            ))}
            {missing > 0 && (
              <li>
                <button className={`pj-item pj-none${current === 'none' ? ' sel' : ''}`} onClick={() => select('none')}>
                  <span className="pj-name">No project</span>
                  <span className="pj-counts small">{missing} job{missing === 1 ? '' : 's'} to sort</span>
                </button>
              </li>
            )}
          </ul>
        </nav>
        <section className="pj-detail">
          {current ? (
            <ProjectJobs project={current} onNewJob={newJob} />
          ) : (
            <p className="muted pj-pick">{projects.length ? 'Choose a project to see all of its jobs.' : 'Add a project to get started.'}</p>
          )}
        </section>
      </div>
    </div>
  );
}

function ProjectJobs({ project, onNewJob }: { project: Project | 'none'; onNewJob: () => void }) {
  const id = project === 'none' ? 'none' : project.id;
  const q = useQuery<{ tickets: Ticket[]; total: number }>(`/api/tickets?project=${id}&archived=include&limit=2000`);
  const tickets = q.data?.tickets ?? [];
  const groups = useMemo(() => {
    const open = tickets.filter((t) => !t.archived && OPEN_ORDER.includes(t.status)).sort((a, b) => OPEN_ORDER.indexOf(a.status) - OPEN_ORDER.indexOf(b.status));
    const closed = tickets.filter((t) => t.archived || !OPEN_ORDER.includes(t.status));
    return { open, closed };
  }, [q.data]);
  const byStatus = OPEN_ORDER.map((s) => [s, groups.open.filter((t) => t.status === s).length] as const).filter(([, n]) => n);

  return (
    <div>
      <header className="pj-head">
        <div>
          <h2>{project === 'none' ? 'Jobs without a project' : project.name}</h2>
          <div className="muted small">
            {project === 'none'
              ? 'These jobs are from before projects existed, or were imported without one. Open each and choose its project.'
              : byStatus.length
                ? byStatus.map(([s, n]) => `${n} ${STATUS_LABEL[s].toLowerCase()}`).join(' · ')
                : 'No open jobs'}
          </div>
        </div>
        <span className="spacer" />
        {project !== 'none' && (
          <>
            <button className="btn" onClick={() => navigate(`/board?pr=${project.id}`)} title="The board, showing only this project's jobs">
              Show on the board
            </button>
            <button className="btn btn-primary" onClick={onNewJob} title="The new job goes in this project">
              + New job in this project
            </button>
          </>
        )}
      </header>
      {q.error && <ErrorBox message={q.error.message} retry={q.refresh} />}
      {!q.data && !q.error && <Spinner />}
      {q.data && (
        <>
          <Section title="Open" count={groups.open.length} empty="No open jobs.">
            {groups.open.map((t) => (
              <JobRow key={t.id} t={t} />
            ))}
          </Section>
          <Section title="Done, cancelled and archived" count={groups.closed.length} tone="done" empty="Nothing finished yet.">
            {groups.closed.map((t) => (
              <JobRow key={t.id} t={t} showUpdated />
            ))}
          </Section>
        </>
      )}
    </div>
  );
}
