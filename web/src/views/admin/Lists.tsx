import { useState } from 'react';
import type { JobType } from '@board/shared';
import { del, patch, post } from '../../lib/api.ts';
import { ask } from '../../lib/dialogs.ts';
import { TICKET_KEYS, invalidate, useQuery } from '../../lib/store.ts';
import { toast } from '../../lib/toasts.ts';
import { Spinner } from '../../components/bits.tsx';
import { onAdminError } from './Admin.tsx';

export function JobTypesSection() {
  const q = useQuery<{ job_types: JobType[] }>('/api/job-types');
  const [name, setName] = useState('');
  if (!q.data) return <Spinner />;
  const list = q.data.job_types;
  const active = list.filter((j) => j.active);

  const save = async (j: JobType, fields: Partial<JobType>) => {
    try {
      await patch(`/api/admin/job-types/${j.id}`, fields);
      invalidate('/api/job-types');
    } catch (e) {
      onAdminError(e);
    }
  };
  const move = async (j: JobType, dir: -1 | 1) => {
    const i = active.indexOf(j);
    const other = active[i + dir];
    if (!other) return;
    await save(j, { sort_order: other.sort_order });
    await save(other, { sort_order: j.sort_order });
  };
  const add = async (e: any) => {
    e.preventDefault();
    try {
      await post('/api/admin/job-types', { name: name.trim() });
      setName('');
      invalidate('/api/job-types');
    } catch (err) {
      onAdminError(err);
    }
  };

  return (
    <section className="admin-section">
      <h2>Job types</h2>
      <p className="muted">
        The order here is the order in every menu. Retiring a type hides it from new jobs; jobs that already use it keep it.
      </p>
      <ul className="admin-list">
        {list.map((j) => (
          <li key={j.id} className={j.active ? '' : 'row-inactive'}>
            <RenameInput value={j.name} label="Job type name" onSave={(v) => save(j, { name: v })} />
            {j.active && (
              <span className="order-btns">
                <button className="icon-btn" aria-label={`Move ${j.name} up`} disabled={active.indexOf(j) === 0} onClick={() => void move(j, -1)}>
                  ↑
                </button>
                <button className="icon-btn" aria-label={`Move ${j.name} down`} disabled={active.indexOf(j) === active.length - 1} onClick={() => void move(j, 1)}>
                  ↓
                </button>
              </span>
            )}
            <button className="btn btn-quiet" onClick={() => void save(j, { active: !j.active })}>
              {j.active ? 'Retire' : 'Bring back'}
            </button>
          </li>
        ))}
      </ul>
      <form className="inline-form" onSubmit={add}>
        <input className="field-input" value={name} maxLength={60} placeholder="New job type" aria-label="New job type" onChange={(e: any) => setName(e.target.value)} />
        <button className="btn btn-primary" disabled={!name.trim()}>
          Add job type
        </button>
      </form>
    </section>
  );
}

export function TagsSection() {
  const q = useQuery<{ tags: { id: number; name: string; count: number }[] }>('/api/admin/tags');
  if (!q.data) return <Spinner />;
  const rename = async (id: number, name: string) => {
    try {
      const r = await patch<{ merged: boolean; tickets: number }>(`/api/admin/tags/${id}`, { name });
      toast(r.merged ? `Merged into ${name} (${r.tickets} jobs)` : 'Tag renamed', { kind: 'success' });
      invalidate('/api/admin/tags');
      invalidate(TICKET_KEYS);
    } catch (e) {
      onAdminError(e);
    }
  };
  const remove = async (id: number, name: string) => {
    const ok = await ask({ type: 'confirm', title: `Delete the tag ${name}?`, body: 'No jobs use it.', confirm: 'Delete tag' });
    if (!ok) return;
    try {
      await del(`/api/admin/tags/${id}`);
      invalidate('/api/admin/tags');
    } catch (e) {
      onAdminError(e);
    }
  };
  return (
    <section className="admin-section">
      <h2>Tags</h2>
      <p className="muted">Tags are created by typing them on a job. Rename one to fix a spelling; renaming to an existing tag merges the two.</p>
      {q.data.tags.length === 0 ? (
        <p className="vsection-empty">No tags yet.</p>
      ) : (
        <ul className="admin-list">
          {q.data.tags.map((t) => (
            <li key={t.id}>
              <RenameInput value={t.name} label="Tag name" onSave={(v) => rename(t.id, v)} />
              <span className="muted">
                {t.count} {t.count === 1 ? 'job' : 'jobs'}
              </span>
              {t.count === 0 && (
                <button className="btn btn-quiet danger" onClick={() => void remove(t.id, t.name)}>
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RenameInput({ value, label, onSave }: { value: string; label: string; onSave: (v: string) => Promise<unknown> }) {
  const [v, setV] = useState(value);
  return (
    <input
      className="field-input"
      value={v}
      aria-label={label}
      onChange={(e: any) => setV(e.target.value)}
      onBlur={() => {
        if (v.trim() && v.trim() !== value) void onSave(v.trim());
        else setV(value);
      }}
      onKeyDown={(e: any) => e.key === 'Enter' && e.target.blur()}
    />
  );
}
