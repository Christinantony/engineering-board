// The Kanban board: six columns, pointer-based drag and drop (works with mouse,
// pen and touch), optimistic moves with rollback, and Undo.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Status, Ticket } from '@board/shared';
import { useApp } from '../context.ts';
import { moveTicket } from '../lib/actions.ts';
import { hours } from '../lib/format.ts';
import { useTicketQuery } from '../lib/store.ts';
import { ErrorBox, Spinner } from '../components/bits.tsx';
import { TicketCard } from '../components/TicketCard.tsx';
import { CardMenu, type MenuTarget } from '../components/CardMenu.tsx';
import { claimTicket } from '../lib/actions.ts';

interface Column {
  id: string;
  title: string;
  statuses: Status[];
  drop: Status;
  empty: string;
}

export const COLUMNS: Column[] = [
  { id: 'inbox', title: 'Inbox', statuses: ['inbox'], drop: 'inbox', empty: 'Nothing waiting to be picked up.' },
  { id: 'claimed', title: 'Claimed', statuses: ['claimed'], drop: 'claimed', empty: 'No one has work queued up.' },
  { id: 'in_progress', title: 'In progress', statuses: ['in_progress'], drop: 'in_progress', empty: 'Nothing being worked on right now.' },
  { id: 'waiting', title: 'Waiting / blocked', statuses: ['waiting', 'blocked'], drop: 'waiting', empty: 'Nothing is stuck.' },
  { id: 'review', title: 'Review', statuses: ['review'], drop: 'review', empty: 'Nothing to review.' },
  { id: 'done', title: 'Done', statuses: ['done'], drop: 'done', empty: 'Finished jobs from the last 7 days appear here.' },
];
const columnOf = (s: Status) => COLUMNS.find((c) => c.statuses.includes(s));

interface Drag {
  id: number;
  width: number;
  height: number;
  dx: number;
  dy: number;
  col: string | null;
  index: number;
}

/** Local, not-yet-confirmed positions for cards being moved. */
type Overrides = Map<number, { status: Status; board_rank: number }>;

export function Board({ filter }: { filter?: (t: Ticket) => boolean }) {
  const { me, openJob } = useApp();
  const q = useTicketQuery('/api/tickets?view=board');
  const [overrides, setOverrides] = useState<Overrides>(new Map());
  const [drag, setDrag] = useState<Drag | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const suppressClick = useRef(false);

  const tickets = useMemo(() => {
    const list = (q.data?.tickets ?? []).map((t) => {
      const o = overrides.get(t.id);
      return o ? { ...t, ...o } : t;
    });
    return filter ? list.filter(filter) : list;
  }, [q.data, overrides, filter]);

  const byColumn = useMemo(() => {
    const m = new Map<string, Ticket[]>(COLUMNS.map((c) => [c.id, []]));
    for (const t of tickets) {
      const c = columnOf(t.status);
      if (c) m.get(c.id)!.push(t);
    }
    for (const [id, list] of m) {
      if (id === 'done') list.sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''));
      else list.sort((a, b) => a.board_rank - b.board_rank || a.id - b.id);
    }
    return m;
  }, [tickets]);

  // ---------- drag and drop ----------
  const start = useRef<{ id: number; x: number; y: number; el: HTMLElement; pointerId: number } | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  // Window listeners must be stable functions so they can be removed again;
  // they forward to the latest render's handlers.
  const latest = useRef({ onMove: (_e: PointerEvent) => {}, onUp: () => {}, onCancel: () => {}, onKey: (_e: KeyboardEvent) => {} });
  const stable = useRef({
    move: (e: PointerEvent) => latest.current.onMove(e),
    up: () => latest.current.onUp(),
    cancel: () => latest.current.onCancel(),
    key: (e: KeyboardEvent) => latest.current.onKey(e),
  }).current;

  function onPointerDown(t: Ticket, e: any) {
    if (e.button !== 0 || e.target.closest('button, a, input, textarea, select')) return;
    start.current = { id: t.id, x: e.clientX, y: e.clientY, el: e.currentTarget, pointerId: e.pointerId };
    window.addEventListener('pointermove', stable.move);
    window.addEventListener('pointerup', stable.up);
    window.addEventListener('pointercancel', stable.cancel);
    window.addEventListener('keydown', stable.key);
  }

  function hitTest(x: number, y: number, id: number): { col: string | null; index: number } {
    const el = document.elementFromPoint(x, y)?.closest('[data-col]') as HTMLElement | null;
    if (!el) return { col: null, index: 0 };
    const list = el.querySelector('.col-list') as HTMLElement;
    // auto-scroll a long column while dragging near its edges
    const r = list.getBoundingClientRect();
    if (y < r.top + 48) list.scrollTop -= 14;
    else if (y > r.bottom - 48) list.scrollTop += 14;
    const cards = [...list.querySelectorAll<HTMLElement>('[data-card]')].filter((c) => Number(c.dataset.card) !== id);
    let index = cards.length;
    for (let i = 0; i < cards.length; i++) {
      const cr = cards[i].getBoundingClientRect();
      if (y < cr.top + cr.height / 2) {
        index = i;
        break;
      }
    }
    return { col: el.dataset.col ?? null, index };
  }

  function onMove(e: PointerEvent) {
    const s = start.current;
    if (!s) return;
    let d = dragRef.current;
    if (!d) {
      if (Math.hypot(e.clientX - s.x, e.clientY - s.y) < 6) return;
      const r = s.el.getBoundingClientRect();
      d = { id: s.id, width: r.width, height: r.height, dx: s.x - r.left, dy: s.y - r.top, col: null, index: 0 };
      document.body.classList.add('dragging-active');
    }
    if (ghostRef.current) ghostRef.current.style.transform = `translate(${e.clientX - d.dx}px, ${e.clientY - d.dy}px) rotate(1.5deg)`;
    const hit = hitTest(e.clientX, e.clientY, d.id);
    if (!dragRef.current || hit.col !== d.col || hit.index !== d.index) {
      const next = { ...d, ...hit };
      dragRef.current = next;
      setDrag(next);
      // position the ghost on the first frame too
      requestAnimationFrame(() => {
        if (ghostRef.current) ghostRef.current.style.transform = `translate(${e.clientX - next.dx}px, ${e.clientY - next.dy}px) rotate(1.5deg)`;
      });
    }
  }

  function cleanup() {
    window.removeEventListener('pointermove', stable.move);
    window.removeEventListener('pointerup', stable.up);
    window.removeEventListener('pointercancel', stable.cancel);
    window.removeEventListener('keydown', stable.key);
    document.body.classList.remove('dragging-active');
    start.current = null;
    dragRef.current = null;
    setDrag(null);
  }
  function onCancel() {
    cleanup();
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') cleanup();
  }
  function onUp() {
    const d = dragRef.current;
    cleanup();
    if (!d) return; // a plain click; onClick opens the card
    suppressClick.current = true;
    setTimeout(() => (suppressClick.current = false), 0);
    if (d.col) void drop(d.id, d.col, d.index);
  }

  async function drop(id: number, colId: string, index: number) {
    const t = q.data?.tickets.find((x) => x.id === id);
    const col = COLUMNS.find((c) => c.id === colId)!;
    if (!t) return;
    const fromCol = columnOf(t.status)!;
    const list = (byColumn.get(colId) ?? []).filter((x) => x.id !== id);
    const before = list[index - 1] ?? null;
    const after = list[index] ?? null;
    const target: Status = col.statuses.includes(t.status) ? t.status : col.drop;
    if (fromCol.id === colId) {
      const oldIndex = byColumn.get(colId)!.findIndex((x) => x.id === id);
      if (colId === 'done' || oldIndex === index) return; // dropped where it was
    }
    // where it came from (for Undo)
    const origList = byColumn.get(fromCol.id)!.filter((x) => x.id !== id);
    const origIndex = byColumn.get(fromCol.id)!.findIndex((x) => x.id === id);
    const undo = { status: t.status, before_id: origList[origIndex - 1]?.id ?? null, after_id: origList[origIndex]?.id ?? null, reason: t.waiting_for };

    // optimistic position
    const lo = before?.board_rank ?? (after ? after.board_rank - 1024 : 0);
    const hi = after?.board_rank ?? lo + 2048;
    setOverrides((m) => new Map(m).set(id, { status: target, board_rank: (lo + hi) / 2 }));
    const saved = await moveTicket(me, t, target, { before_id: before?.id ?? null, after_id: after?.id ?? null }, { undo });
    if (!saved) {
      // cancelled or failed: put it back
      setOverrides((m) => {
        const n = new Map(m);
        n.delete(id);
        return n;
      });
      return;
    }
    // keep the override until the refreshed list includes the change
    await q.refresh();
    setOverrides((m) => {
      const n = new Map(m);
      n.delete(id);
      return n;
    });
  }

  latest.current = { onMove, onUp, onCancel, onKey };
  useEffect(() => cleanup, []); // remove listeners if the board unmounts mid-drag

  // ---------- keyboard and menu: moving cards without a mouse ----------
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  // After a keyboard move the card re-renders in its new column; keep focus on it.
  const pendingFocus = useRef<{ id: number; until: number } | null>(null);
  const refocus = (id: number) => {
    pendingFocus.current = { id, until: Date.now() + 4000 };
    restoreFocus();
  };
  function restoreFocus() {
    const p = pendingFocus.current;
    if (!p) return;
    if (Date.now() > p.until) {
      pendingFocus.current = null;
      return;
    }
    const el = document.querySelector<HTMLElement>(`[data-card="${p.id}"]:not(.is-ghost)`);
    const active = document.activeElement;
    // only when focus fell to the page itself (the old element was removed); never steal it from something else
    if (el && active !== el && (!active || active === document.body)) el.focus();
    if (active && active !== document.body && active !== el) pendingFocus.current = null;
  }
  useEffect(() => restoreFocus()); // after every render
  const ticketOf = (el: Element | null) => {
    const id = Number((el?.closest('[data-card]') as HTMLElement | null)?.dataset.card);
    return id ? tickets.find((t) => t.id === id) : undefined;
  };
  const colIndexOf = (t: Ticket) => COLUMNS.findIndex((c) => c.statuses.includes(t.status));

  function onBoardKeyDown(e: any) {
    const t = ticketOf(e.target);
    if (!t || e.target.closest('button, input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    const ci = colIndexOf(t);
    const col = COLUMNS[ci];
    const list = byColumn.get(col.id) ?? [];
    const idx = list.findIndex((x) => x.id === t.id);
    const focusCard = (x: Ticket | undefined) => x && document.querySelector<HTMLElement>(`[data-card="${x.id}"]`)?.focus();
    const key = e.key;
    if ((key === 'ContextMenu' || (key === 'F10' && e.shiftKey)) && !drag) {
      e.preventDefault();
      const r = e.target.closest('[data-card]').getBoundingClientRect();
      setMenu({ ticket: t, x: r.left + 24, y: r.top + 24 });
    } else if (key === 'c' || key === 'C') {
      if (t.assigned_to == null && me.role === 'engineer' && t.status !== 'done' && t.status !== 'cancelled') {
        e.preventDefault();
        e.stopPropagation();
        void claimTicket(t).then(() => refocus(t.id));
      }
    } else if (e.shiftKey && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      e.preventDefault();
      const next = COLUMNS[ci + (key === 'ArrowLeft' ? -1 : 1)];
      if (next) void drop(t.id, next.id, 0).then(() => refocus(t.id));
    } else if (e.shiftKey && (key === 'ArrowUp' || key === 'ArrowDown') && col.id !== 'done') {
      e.preventDefault();
      const to = idx + (key === 'ArrowUp' ? -1 : 1);
      if (to >= 0 && to < list.length) void drop(t.id, col.id, to).then(() => refocus(t.id));
    } else if (!e.shiftKey && (key === 'ArrowUp' || key === 'ArrowDown')) {
      e.preventDefault();
      focusCard(list[idx + (key === 'ArrowUp' ? -1 : 1)]);
    } else if (!e.shiftKey && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      e.preventDefault();
      for (let c = ci + (key === 'ArrowLeft' ? -1 : 1); c >= 0 && c < COLUMNS.length; c += key === 'ArrowLeft' ? -1 : 1) {
        const other = byColumn.get(COLUMNS[c].id) ?? [];
        if (other.length) {
          focusCard(other[Math.min(idx, other.length - 1)]);
          break;
        }
      }
    }
  }

  function onBoardContextMenu(e: any) {
    const t = ticketOf(e.target);
    if (!t || drag) return;
    e.preventDefault();
    setMenu({ ticket: t, x: e.clientX, y: e.clientY });
  }

  if (q.error && !q.data) return <ErrorBox message={q.error.message} retry={q.refresh} />;
  if (!q.data) return <Spinner label="Loading the board" />;

  const dragged = drag ? tickets.find((t) => t.id === drag.id) : undefined;

  return (
    <>
      {q.error && <ErrorBox message={`The displayed board is from the last complete load. ${q.error.message}`} retry={q.refresh} />}
    <div className="board" aria-label="Kanban board" onKeyDown={onBoardKeyDown} onContextMenu={onBoardContextMenu}>
      {COLUMNS.map((c) => {
        const list = byColumn.get(c.id)!;
        const minutes = list.reduce((s, t) => s + (t.estimate_minutes ?? 0), 0);
        const isTarget = drag?.col === c.id;
        const visible = drag ? list.filter((t) => t.id !== drag.id) : list;
        return (
          <section key={c.id} className={`col col-${c.id}${isTarget ? ' is-target' : ''}`} data-col={c.id} aria-label={c.title}>
            <header className="col-head">
              <h2>{c.title}</h2>
              <span className="col-count" aria-label={`${list.length} jobs`}>
                {list.length}
              </span>
              {minutes > 0 && c.id !== 'done' && <span className="col-hours">{hours(minutes)}</span>}
            </header>
            <div className="col-list">
              {visible.length === 0 && !isTarget && c.id === 'inbox' && (q.data?.tickets.length ?? 0) === 0 ? (
                <div className="welcome">
                  <p>
                    <strong>The board is empty.</strong>
                  </p>
                  <p>
                    Press <kbd>N</kbd> to add the first job, or bring in your current list from Excel with Admin, Import.
                  </p>
                  <p className="muted">
                    Press <kbd>?</kbd> any time for keyboard shortcuts.
                  </p>
                </div>
              ) : (
                visible.length === 0 && !isTarget && <p className="col-empty">{c.empty}</p>
              )}
              {visible.map((t, i) => (
                <div key={t.id} className="card-slot">
                  {isTarget && drag!.index === i && c.id !== 'done' && <div className="drop-line" style={{ height: drag!.height }} />}
                  <TicketCard
                    t={t}
                    onPointerDown={(e) => onPointerDown(t, e)}
                    onOpen={() => {
                      if (!suppressClick.current) openJob(t.id);
                    }}
                  />
                </div>
              ))}
              {isTarget && (drag!.index >= visible.length || c.id === 'done') && <div className="drop-line" style={{ height: drag!.height }} />}
            </div>
          </section>
        );
      })}
      {menu && (
        <CardMenu
          target={menu}
          columns={COLUMNS}
          onClose={() => setMenu(null)}
          onMove={(t, colId) => void drop(t.id, colId, 0).then(() => refocus(t.id))}
        />
      )}
      {drag &&
        dragged &&
        createPortal(
          <div className="drag-ghost" ref={ghostRef} style={{ width: drag.width }}>
            <TicketCard t={dragged} ghost />
          </div>,
          document.body,
        )}
    </div>
    </>
  );
}
