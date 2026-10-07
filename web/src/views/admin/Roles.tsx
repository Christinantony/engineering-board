// Admin → Roles (decision #31): what engineers, managers and reviewers may do
// with jobs. Board review is not governed here and says so.

import { useEffect, useState } from 'react';
import { CAPABILITIES, CAPABILITY_LABEL, DEFAULT_PERMISSIONS, ROLES, ROLE_LABEL, type RolePermissions } from '@board/shared';
import { api } from '../../lib/api.ts';
import { invalidate, useQuery } from '../../lib/store.ts';
import { toast } from '../../lib/toasts.ts';
import { Spinner } from '../../components/bits.tsx';
import { onAdminError } from './Admin.tsx';

const same = (a: RolePermissions, b: RolePermissions) => ROLES.every((r) => CAPABILITIES.every((c) => a[r][c] === b[r][c]));

export function RolesSection() {
  const q = useQuery<{ permissions: RolePermissions }>('/api/admin/permissions');
  const [draft, setDraft] = useState<RolePermissions | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (q.data) setDraft(q.data.permissions);
  }, [q.data]);
  if (!q.data || !draft) return <Spinner />;
  const saved = q.data.permissions;
  const dirty = !same(draft, saved);

  const toggle = (role: (typeof ROLES)[number], cap: (typeof CAPABILITIES)[number]) =>
    setDraft({ ...draft, [role]: { ...draft[role], [cap]: !draft[role][cap] } });
  const save = async () => {
    setSaving(true);
    try {
      await api('PUT', '/api/admin/permissions', draft);
      toast('Role capabilities saved. Everyone sees the change straight away.', { kind: 'success' });
      invalidate('/api/admin/permissions');
      invalidate('/api/meta');
    } catch (e) {
      onAdminError(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="admin-section">
      <h2>Roles</h2>
      <p className="muted">
        Who may do what with jobs. <strong>Create jobs</strong> also lets a role add projects. <strong>Claim and be assigned jobs</strong> lets a role claim jobs, be
        assigned them, and work on the jobs assigned to them (move them, edit them, order their My work list); they then appear in the assignee lists, My work and
        Workload. <strong>Edit and move any job</strong> covers every job: fields, columns, assigning others, archiving. Anyone who can see the board can comment.
      </p>
      <p className="muted">
        <strong>Board review is separate and never changes here:</strong> engineers submit drawings, the manager and reviewers pass or return them, and a reviewer
        sees only the drawings handed to them. Giving reviewers a job capability also shows them the board, so they can work on jobs created for them.
      </p>
      <table className="table admin-table roles-table">
        <thead>
          <tr>
            <th>Role</th>
            {CAPABILITIES.map((c) => (
              <th key={c}>{CAPABILITY_LABEL[c]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ROLES.map((r) => (
            <tr key={r}>
              <th scope="row">{ROLE_LABEL[r]}s</th>
              {CAPABILITIES.map((c) => (
                <td key={c}>
                  <input type="checkbox" checked={draft[r][c]} aria-label={`${ROLE_LABEL[r]}s: ${CAPABILITY_LABEL[c]}`} onChange={() => toggle(r, c)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="inline-form">
        <button className="btn btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
          Save capabilities
        </button>
        <button className="btn btn-quiet" disabled={!dirty || saving} onClick={() => setDraft(saved)}>
          Undo changes
        </button>
        <button className="btn btn-quiet" disabled={same(draft, DEFAULT_PERMISSIONS) || saving} onClick={() => setDraft(DEFAULT_PERMISSIONS)} title="Engineers do everything; managers create, edit and assign; reviewers only review">
          Back to the original rules
        </button>
      </div>
      <p className="muted small">
        Taking <em>claim</em> away from a role whose members still hold open jobs is refused until those jobs are reassigned, so nobody's work silently loses its owner.
      </p>
    </section>
  );
}
