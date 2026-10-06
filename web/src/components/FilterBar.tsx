import { useEffect, useRef } from 'react';
import { PRIORITIES, STATUS_LABEL, type Status } from '@board/shared';
import { useApp } from '../context.ts';
import { EMPTY_FILTERS, activeCount, type CreatedFilter, type DueFilter, type Filters } from '../lib/filters.ts';
import { Badge, PRIORITY_TEXT } from './bits.tsx';

const DUE: { v: DueFilter; label: string }[] = [
  { v: '', label: 'Any due date' },
  { v: 'today', label: 'Due today or earlier' },
  { v: 'week', label: 'Due this week' },
  { v: 'next7', label: 'Due in the next 7 days' },
];
const CREATED: { v: CreatedFilter; label: string }[] = [
  { v: '', label: 'Created any time' },
  { v: 'today', label: 'Created today' },
  { v: '7d', label: 'Created in the last 7 days' },
  { v: '30d', label: 'Created in the last 30 days' },
];
const STATUSES: Status[] = ['inbox', 'claimed', 'in_progress', 'waiting', 'blocked', 'review', 'done', 'cancelled'];

function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

/** A <details> dropdown that closes when you click elsewhere. */
function Drop({ label, active, children }: { label: string; active: boolean; children: any }) {
  const ref = useRef<HTMLDetailsElement | null>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) ref.current.open = false;
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  return (
    <details className={`fdrop${active ? ' on' : ''}`} ref={ref}>
      <summary>{label}</summary>
      <div className="fdrop-pop">{children}</div>
    </details>
  );
}

export function FilterBar({
  value,
  onChange,
  showStatus,
  shown,
  total,
}: {
  value: Filters;
  onChange: (f: Filters) => void;
  showStatus?: boolean;
  shown?: number;
  total?: number;
}) {
  const { me, engineers, jobTypes, projects } = useApp();
  const set = (patch: Partial<Filters>) => onChange({ ...value, ...patch });
  const n = activeCount(value);
  const mineOnly = value.assignee.length === 1 && value.assignee[0] === me.id;
  const jtLabel =
    value.jobType.length === 0
      ? 'Job type'
      : value.jobType.length === 1
        ? jobTypes.find((j) => j.id === value.jobType[0])?.name ?? 'Job type'
        : `${value.jobType.length} job types`;
  const prLabel =
    value.project.length === 0
      ? 'Project'
      : value.project.length === 1
        ? value.project[0] === 'none'
          ? 'No project'
          : projects.find((p) => p.id === value.project[0])?.name ?? 'Project'
        : `${value.project.length} projects`;
  const stLabel = value.status.length === 0 ? 'Status' : value.status.length === 1 ? STATUS_LABEL[value.status[0]] : `${value.status.length} statuses`;

  return (
    <div className="filterbar" role="toolbar" aria-label="Filters">
      {me.role === 'engineer' && (
        <button className={`fchip${mineOnly ? ' on' : ''}`} aria-pressed={mineOnly} onClick={() => set({ assignee: mineOnly ? [] : [me.id] })}>
          Mine
        </button>
      )}
      <div className="fgroup" aria-label="Assignee">
        {engineers
          .filter((u) => u.active)
          .map((u) => {
            const on = value.assignee.includes(u.id);
            return (
              <button
                key={u.id}
                className={`fbadge${on ? ' on' : ''}`}
                aria-pressed={on}
                title={`${u.name}'s jobs`}
                onClick={() => set({ assignee: toggle(value.assignee, u.id) })}
              >
                <Badge user={u} size="sm" title="" />
              </button>
            );
          })}
      </div>
      <span className="fsep" aria-hidden="true" />
      <div className="fgroup" aria-label="Priority">
        {PRIORITIES.map((p) => {
          const on = value.priority.includes(p);
          return (
            <button key={p} className={`fchip fprio-${p}${on ? ' on' : ''}`} aria-pressed={on} onClick={() => set({ priority: toggle(value.priority, p) })}>
              {PRIORITY_TEXT[p]}
            </button>
          );
        })}
      </div>
      <span className="fsep" aria-hidden="true" />
      {showStatus && (
        <Drop label={stLabel} active={value.status.length > 0}>
          {STATUSES.map((s) => (
            <label key={s} className="fopt">
              <input type="checkbox" checked={value.status.includes(s)} onChange={() => set({ status: toggle(value.status, s) })} />
              {STATUS_LABEL[s]}
            </label>
          ))}
        </Drop>
      )}
      <Drop label={prLabel} active={value.project.length > 0}>
        {projects.length === 0 && <span className="muted fopt">No projects yet</span>}
        {projects.map((p) => (
          <label key={p.id} className="fopt">
            <input type="checkbox" checked={value.project.includes(p.id)} onChange={() => set({ project: toggle(value.project, p.id) })} />
            {p.name}
          </label>
        ))}
        <label className="fopt">
          <input type="checkbox" checked={value.project.includes('none')} onChange={() => set({ project: toggle(value.project, 'none') })} />
          <span className="muted">No project</span>
        </label>
      </Drop>
      <Drop label={jtLabel} active={value.jobType.length > 0}>
        {jobTypes.map((j) => (
          <label key={j.id} className="fopt">
            <input type="checkbox" checked={value.jobType.includes(j.id)} onChange={() => set({ jobType: toggle(value.jobType, j.id) })} />
            {j.name}
            {!j.active && <span className="muted"> (retired)</span>}
          </label>
        ))}
      </Drop>
      <Drop label={DUE.find((d) => d.v === value.due)!.label.replace('Any due date', 'Due')} active={!!value.due}>
        {DUE.map((d) => (
          <label key={d.v} className="fopt">
            <input type="radio" name="due" checked={value.due === d.v} onChange={() => set({ due: d.v })} />
            {d.label}
          </label>
        ))}
      </Drop>
      <Drop label={CREATED.find((d) => d.v === value.created)!.label.replace('Created any time', 'Created')} active={!!value.created}>
        {CREATED.map((d) => (
          <label key={d.v} className="fopt">
            <input type="radio" name="created" checked={value.created === d.v} onChange={() => set({ created: d.v })} />
            {d.label}
          </label>
        ))}
      </Drop>
      <span className="fsep" aria-hidden="true" />
      <button className={`fchip fwarn${value.overdue ? ' on' : ''}`} aria-pressed={value.overdue} onClick={() => set({ overdue: !value.overdue })}>
        Overdue
      </button>
      <button className={`fchip fwarn${value.blocked ? ' on' : ''}`} aria-pressed={value.blocked} onClick={() => set({ blocked: !value.blocked })}>
        Waiting / blocked
      </button>
      <button className={`fchip${value.unassigned ? ' on' : ''}`} aria-pressed={value.unassigned} onClick={() => set({ unassigned: !value.unassigned })}>
        Unassigned
      </button>
      {value.tag && (
        <button className="fchip on" onClick={() => set({ tag: '' })} title="Remove tag filter">
          #{value.tag} ✕
        </button>
      )}
      <span className="spacer" />
      {n > 0 && shown != null && total != null && (
        <span className="fcount">
          Showing {shown} of {total}
        </span>
      )}
      {n > 0 && (
        <button className="btn btn-quiet" onClick={() => onChange({ ...EMPTY_FILTERS })}>
          Clear filters
        </button>
      )}
    </div>
  );
}
