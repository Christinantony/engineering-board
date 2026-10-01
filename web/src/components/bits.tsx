// Small shared presentational pieces.

import type { Priority, User } from '@board/shared';

export function Badge({ user, size = 'md', title }: { user: User | undefined; size?: 'sm' | 'md' | 'lg'; title?: string }) {
  if (!user) return null;
  return (
    <span
      className={`badge badge-${size}${user.active ? '' : ' badge-inactive'}`}
      style={{ '--who': user.color } as any}
      title={title ?? `${user.name}${user.active ? '' : ' (inactive)'}`}
    >
      {user.initials}
    </span>
  );
}

export const PRIORITY_TEXT: Record<Priority, string> = { urgent: 'Urgent', high: 'High', normal: 'Normal', low: 'Low' };

export function PriorityTag({ p }: { p: Priority }) {
  if (p === 'normal') return null;
  return <span className={`prio prio-${p}`}>{PRIORITY_TEXT[p]}</span>;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="spinner" role="status">
      <span className="spinner-dot" aria-hidden="true" />
      {label}…
    </div>
  );
}

export function ErrorBox({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      <p>{message}</p>
      {retry && (
        <button className="btn" onClick={retry}>
          Try again
        </button>
      )}
    </div>
  );
}
