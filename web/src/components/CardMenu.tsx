// "More actions" menu for a card: right-click, press-and-hold on a tablet,
// or the Menu key / Shift+F10 with a card focused. It's also the way to move
// a card without dragging it.

import { useEffect, useRef } from 'react';
import type { Status, Ticket } from '@board/shared';
import { useApp } from '../context.ts';
import { claimTicket, releaseTicket, updateTicket } from '../lib/actions.ts';
import { copyText } from '../lib/clipboard.ts';
import { ask } from '../lib/dialogs.ts';
import { toast } from '../lib/toasts.ts';

export interface MenuTarget {
  ticket: Ticket;
  x: number;
  y: number;
}

export function CardMenu({
  target,
  columns,
  onMove,
  onClose,
}: {
  target: MenuTarget;
  columns: { id: string; title: string; statuses: Status[]; drop: Status }[];
  onMove: (t: Ticket, columnId: string) => void;
  onClose: () => void;
}) {
  const { me, openJob } = useApp();
  const ref = useRef<HTMLDivElement | null>(null);
  const t = target.ticket;
  const closed = t.status === 'done' || t.status === 'cancelled';
  const here = columns.find((c) => c.statuses.includes(t.status))?.id;

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        (document.querySelector(`[data-card="${t.id}"]`) as HTMLElement | null)?.focus();
      }
    };
    document.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc, true);
    window.addEventListener('scroll', onClose, true);
    return () => {
      document.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc, true);
      window.removeEventListener('scroll', onClose, true);
    };
  }, []);

  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };

  // arrow keys move between items
  const onKeyDown = (e: any) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
      next?.focus();
    } else if (e.key === 'Tab') {
      e.preventDefault();
    }
  };

  // keep the menu on screen
  const left = Math.min(target.x, window.innerWidth - 240);
  const top = Math.min(target.y, window.innerHeight - 380);

  return (
    <div className="card-menu" role="menu" aria-label={`Actions for ${t.job_number}`} ref={ref} style={{ left, top }} onKeyDown={onKeyDown}>
      <div className="card-menu-head">{t.job_number}</div>
      <button role="menuitem" onClick={run(() => openJob(t.id))}>
        Open
      </button>
      {!closed && t.assigned_to == null && me.role === 'engineer' && (
        <button role="menuitem" onClick={run(() => void claimTicket(t))}>
          Claim
        </button>
      )}
      {!closed && (
        <button
          role="menuitem"
          onClick={run(async () => {
            const uid = await ask({ type: 'assign', ticket: t, title: `Who should take ${t.job_number}?` });
            if (uid != null) await updateTicket(t, { assigned_to: uid });
          })}
        >
          {t.assigned_to == null ? 'Assign to…' : 'Reassign to…'}
        </button>
      )}
      {!closed && t.assigned_to != null && (
        <button role="menuitem" onClick={run(() => void releaseTicket(t))}>
          Return to inbox
        </button>
      )}
      <div className="card-menu-sep" role="separator" />
      <div className="card-menu-label">Move to</div>
      {columns
        .filter((c) => c.id !== here)
        .map((c) => (
          <button key={c.id} role="menuitem" onClick={run(() => onMove(t, c.id))}>
            {c.title}
          </button>
        ))}
      <div className="card-menu-sep" role="separator" />
      <button
        role="menuitem"
        onClick={run(async () => {
          const ok = await copyText(`${location.origin}/board?job=${t.id}`);
          toast(ok ? `Link to ${t.job_number} copied` : 'Could not copy the link', { kind: ok ? 'success' : 'error' });
        })}
      >
        Copy link
      </button>
    </div>
  );
}
