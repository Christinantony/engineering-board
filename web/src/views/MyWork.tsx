// "What should I work on next?" — one engineer's queue, in their own order.
// Drag rows (or Alt+↑/↓) to reorder. Managers can look at anyone's list.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Ticket } from '@board/shared';
import { useApp } from '../context.ts';
import { post } from '../lib/api.ts';
import { hours } from '../lib/format.ts';
import { navigate, useLocation } from '../lib/router.ts';
import { TICKET_KEYS, invalidate, useQuery } from '../lib/store.ts';
import { toastError } from '../lib/toasts.ts';
import { Badge, ErrorBox, Spinner } from '../components/bits.tsx';
import { JobRow, Section } from '../components/JobRow.tsx';

interface MyWorkData {
  in_progress: Ticket[];
  waiting: Ticket[];
  review: Ticket[];
  up_next: Ticket[];
  summary: { open: number; estimated_minutes: number; unestimated: number; overdue: number };
}

export function MyWork() {
  const { me, workers, can } = useApp();
  const { params } = useLocation();
  const active = workers.filter((u) => u.active);
  const requested = Number(params.get('user')) || null;
  const uid = requested ?? (can('claim') ? me.id : active[0]?.id);
  const whose = workers.find((u) => u.id === uid);
  const q = useQuery<MyWorkData>(uid ? `/api/my-work?user=${uid}` : null);
  const own = uid === me.id;

  if (!uid) return <ErrorBox message="Nobody can hold jobs yet: add people under Admin → Team, or give a role the claim capability under Admin → Roles." />;
  if (q.error && !q.data) return <ErrorBox message={q.error.message} retry={q.refresh} />;
  if (!q.data) return <Spinner label="Loading work" />;
  const d = q.data;
  const s = d.summary;

  return (
    <div className="view view-narrow">
      <header className="view-head">
        <div className="view-head-row">
          <h1>{own ? 'My work' : `${whose?.name ?? 'Engineer'}'s work`}</h1>
          <div className="who-switch" role="group" aria-label="Show work for">
            {active.map((u) => (
              <button
                key={u.id}
                className={`fbadge${u.id === uid ? ' on' : ''}`}
                aria-pressed={u.id === uid}
                title={u.name}
                onClick={() => navigate(u.id === me.id ? '/my-work' : `/my-work?user=${u.id}`)}
              >
                <Badge user={u} size="sm" title="" />
              </button>
            ))}
          </div>
        </div>
        <p className="view-lede">
          {s.open === 0
            ? own
              ? 'Nothing assigned to you. Claim something from the inbox.'
              : `${whose?.name} has nothing assigned.`
            : `${s.open} open ${s.open === 1 ? 'job' : 'jobs'}, about ${hours(s.estimated_minutes)} estimated` +
              (s.unestimated ? ` plus ${s.unestimated} not estimated` : '') +
              (s.overdue ? `. ${s.overdue} overdue.` : '.')}
        </p>
      </header>

      <Section title="In progress" count={d.in_progress.length} tone="progress" empty="Nothing in progress.">
        <Reorderable list={d.in_progress} enabled={own} />
      </Section>
      <Section title="Up next" count={d.up_next.length} tone="claimed" empty={own ? 'Your queue is empty.' : 'Queue is empty.'}>
        <Reorderable list={d.up_next} enabled={own} />
      </Section>
      <Section title="Waiting / blocked" count={d.waiting.length} tone="waiting" empty="Nothing waiting.">
        <Reorderable list={d.waiting} enabled={own} />
      </Section>
      <Section title="In review" count={d.review.length} tone="review" empty="Nothing in review.">
        <Reorderable list={d.review} enabled={own} />
      </Section>
      {own && (d.in_progress.length + d.up_next.length > 1) && <p className="muted hint">Drag the handle or press Alt+↑ / Alt+↓ on a job to set your own order.</p>}
    </div>
  );
}

/** A list whose rows can be dragged (or moved with Alt+arrows) to set my_rank. */
function Reorderable({ list, enabled }: { list: Ticket[]; enabled: boolean }) {
  const [order, setOrder] = useState<number[] | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const overRef = useRef<number | null>(null);

  // server data wins once it arrives
  useEffect(() => setOrder(null), [list]);

  const items = useMemo(() => {
    if (!order) return list;
    const byId = new Map(list.map((t) => [t.id, t]));
    return order.map((id) => byId.get(id)).filter(Boolean) as Ticket[];
  }, [list, order]);

  async function save(id: number, ids: number[]) {
    const i = ids.indexOf(id);
    setOrder(ids);
    try {
      await post(`/api/tickets/${id}/my-rank`, { before_id: ids[i - 1] ?? null, after_id: ids[i + 1] ?? null });
      invalidate(TICKET_KEYS);
    } catch (e) {
      setOrder(null);
      toastError(e);
    }
  }

  function move(id: number, to: number) {
    const ids = items.map((t) => t.id).filter((x) => x !== id);
    ids.splice(Math.max(0, Math.min(to, ids.length)), 0, id);
    if (ids.join() !== items.map((t) => t.id).join()) void save(id, ids);
  }

  function onHandleDown(id: number, e: any) {
    if (!enabled || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setDragId(id);
    const onMove = (ev: PointerEvent) => {
      const rows = [...(box.current?.querySelectorAll<HTMLElement>('[data-row]') ?? [])].filter((r) => Number(r.dataset.row) !== id);
      let idx = rows.length;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i].getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) {
          idx = i;
          break;
        }
      }
      overRef.current = idx;
      setOverIndex(idx);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('dragging-active');
      setDragId(null);
      setOverIndex(null);
      const idx = overRef.current;
      overRef.current = null;
      if (idx != null) move(id, idx);
    };
    document.body.classList.add('dragging-active');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  return (
    <div className="reorder" ref={box}>
      {items.map((t, i) => {
        const others = items.filter((x) => x.id !== dragId);
        const lineHere = dragId != null && overIndex === others.indexOf(t) && t.id !== dragId;
        return (
          <div
            key={t.id}
            className={`reorder-item${t.id === dragId ? ' is-dragging' : ''}${lineHere ? ' line-above' : ''}`}
            onKeyDown={(e: any) => {
              if (!enabled || !e.altKey) return;
              if (e.key === 'ArrowUp' && i > 0) {
                e.preventDefault();
                move(t.id, i - 1);
              } else if (e.key === 'ArrowDown' && i < items.length - 1) {
                e.preventDefault();
                move(t.id, i + 1);
              }
            }}
          >
            <JobRow
              t={t}
              showStatus={false}
              showAssignee={false}
              handle={
                enabled && items.length > 1 ? (
                  <span
                    className="drag-handle"
                    aria-hidden="true"
                    title="Drag to reorder"
                    onPointerDown={(e: any) => onHandleDown(t.id, e)}
                    onClick={(e: any) => e.stopPropagation()}
                  >
                    ⠿
                  </span>
                ) : undefined
              }
            />
          </div>
        );
      })}
      {dragId != null && overIndex === items.filter((x) => x.id !== dragId).length && <div className="reorder-line-end" />}
    </div>
  );
}
