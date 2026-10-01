// Small shared presentational pieces.

import { useEffect, useState } from 'react';
import type { Priority, User } from '@board/shared';

// Relative luminance (WCAG) of a #rrggbb colour.
function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
/** White or dark text, whichever is readable on this background (people pick their own colours). */
export function readableOn(hex: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return '#fff';
  const l = luminance(hex);
  return 1.05 / (l + 0.05) >= 4.5 ? '#fff' : '#1f2a37';
}

export function Badge({ user, size = 'md', title }: { user: User | undefined; size?: 'sm' | 'md' | 'lg'; title?: string }) {
  if (!user) return null;
  return (
    <span
      className={`badge badge-${size}${user.active ? '' : ' badge-inactive'}`}
      style={{ '--who': user.color, color: readableOn(user.color) } as any}
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
  // wait a moment before showing it, so fast loads don't flash
  const [show, setShow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setShow(true), 250);
    return () => clearTimeout(t);
  }, []);
  if (!show) return <div className="spinner-wait" aria-busy="true" />;
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
