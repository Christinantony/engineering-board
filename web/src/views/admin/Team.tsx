import { useState } from 'react';
import type { User } from '@board/shared';
import { patch, post } from '../../lib/api.ts';
import { invalidate, useQuery } from '../../lib/store.ts';
import { toast } from '../../lib/toasts.ts';
import { Badge, Spinner } from '../../components/bits.tsx';
import { onAdminError } from './Admin.tsx';

const refresh = () => {
  invalidate('/api/admin/users');
  invalidate('/api/users');
};

export function TeamSection() {
  const q = useQuery<{ users: User[] }>('/api/admin/users');
  const [name, setName] = useState('');
  const [role, setRole] = useState<'engineer' | 'manager' | 'reviewer'>('engineer');
  if (!q.data) return <Spinner />;

  const add = async (e: any) => {
    e.preventDefault();
    try {
      const r = await post<{ user: User }>('/api/admin/users', { name: name.trim(), role });
      toast(`${r.user.name} added`, { kind: 'success' });
      setName('');
      refresh();
    } catch (err) {
      onAdminError(err);
    }
  };

  return (
    <section className="admin-section">
      <h2>Team</h2>
      <p className="muted">
        Engineers can claim and be assigned jobs; managers create, assign and comment. Reviewers (and managers) pass or return drawings in board review and sign the prints; reviewers don't create or change jobs. People who leave can be made inactive: their history stays, they
        disappear from pickers, and they can't sign in. Nobody is ever deleted.
      </p>
      <table className="table admin-table">
        <thead>
          <tr>
            <th>Person</th>
            <th>Initials</th>
            <th>Colour</th>
            <th>Role</th>
            <th>Admin menu</th>
            <th>Active</th>
          </tr>
        </thead>
        <tbody>
          {q.data.users.map((u) => (
            <UserRow key={u.id} u={u} />
          ))}
        </tbody>
      </table>
      <form className="inline-form" onSubmit={add}>
        <input className="field-input" value={name} maxLength={60} placeholder="New person's name" aria-label="Name" onChange={(e: any) => setName(e.target.value)} />
        <select className="field-input" value={role} aria-label="Role" onChange={(e: any) => setRole(e.target.value)}>
          <option value="engineer">Engineer</option>
          <option value="manager">Manager</option>
          <option value="reviewer">Reviewer</option>
        </select>
        <button className="btn btn-primary" disabled={!name.trim()}>
          Add person
        </button>
      </form>
    </section>
  );
}

function UserRow({ u }: { u: User }) {
  const [name, setName] = useState(u.name);
  const [initials, setInitials] = useState(u.initials);
  const save = async (fields: Partial<User>) => {
    try {
      await patch(`/api/admin/users/${u.id}`, fields);
      refresh();
    } catch (err) {
      setName(u.name);
      setInitials(u.initials);
      onAdminError(err);
    }
  };
  return (
    <tr className={u.active ? '' : 'row-inactive'}>
      <td>
        <span className="cell-who">
          <Badge user={{ ...u, initials, active: true }} size="sm" />
          <input
            className="field-input"
            value={name}
            aria-label={`Name of ${u.name}`}
            onChange={(e: any) => setName(e.target.value)}
            onBlur={() => name.trim() && name.trim() !== u.name && void save({ name: name.trim() })}
          />
        </span>
      </td>
      <td>
        <input
          className="field-input narrow"
          value={initials}
          maxLength={3}
          aria-label={`Initials of ${u.name}`}
          onChange={(e: any) => setInitials(e.target.value.toUpperCase())}
          onBlur={() => initials.trim() && initials !== u.initials && void save({ initials: initials.trim() })}
        />
      </td>
      <td>
        <input type="color" className="color-input" value={u.color} aria-label={`Colour of ${u.name}`} onChange={(e: any) => void save({ color: e.target.value })} />
      </td>
      <td>
        <select className="field-input" value={u.role} aria-label={`Role of ${u.name}`} onChange={(e: any) => void save({ role: e.target.value })}>
          <option value="engineer">Engineer</option>
          <option value="manager">Manager</option>
          <option value="reviewer">Reviewer</option>
        </select>
      </td>
      <td>
        <input type="checkbox" checked={u.is_admin} aria-label={`Show admin menu to ${u.name}`} onChange={(e: any) => void save({ is_admin: e.target.checked })} />
      </td>
      <td>
        <input type="checkbox" checked={u.active} aria-label={`${u.name} is active`} onChange={(e: any) => void save({ active: e.target.checked })} />
      </td>
    </tr>
  );
}
