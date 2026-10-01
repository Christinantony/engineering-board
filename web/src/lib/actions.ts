// Mutations used across the UI. Each one reports failures with a toast,
// refreshes affected views, and (for moves) offers Undo.

import { REASON_STATUSES, ASSIGNED_STATUSES, STATUS_LABEL, type Status, type Ticket, type User } from '@board/shared';
import { ApiError, newKey, patch, post } from './api.ts';
import { ask } from './dialogs.ts';
import { TICKET_KEYS, invalidate, setCached } from './store.ts';
import { toast, toastError } from './toasts.ts';

function refreshAfter(t?: Ticket) {
  if (t) setCached(`/api/tickets/${t.id}`, (prev: any) => (prev ? { ...prev, ticket: t } : prev));
  invalidate(TICKET_KEYS);
}

function handleConflict(err: unknown) {
  if (err instanceof ApiError && err.status === 409) invalidate(TICKET_KEYS);
  toastError(err);
}

export interface Placement {
  before_id?: number | null;
  after_id?: number | null;
}

/**
 * Move a job to a column (and position). Asks for "Waiting for" or an
 * assignee when needed. Resolves with the saved ticket, or null if the user
 * cancelled or the save failed (the caller then reverts its optimistic state).
 */
export async function moveTicket(
  me: User,
  t: Ticket,
  target: Status,
  place: Placement = {},
  opts: { undo?: Placement & { status: Status; reason?: string }; quiet?: boolean; reason?: string } = {},
): Promise<Ticket | null> {
  let status = target;
  let reason = opts.reason;
  let cur = t;
  try {
    if (REASON_STATUSES.includes(target) && reason === undefined && !(REASON_STATUSES.includes(t.status) && t.waiting_for)) {
      const ans = await ask({ type: 'reason', ticket: t, status: target as 'waiting' | 'blocked', initial: t.waiting_for });
      if (!ans) return null;
      reason = ans.reason;
      status = ans.status;
    }
    if (ASSIGNED_STATUSES.includes(target) && t.assigned_to == null && me.role !== 'engineer') {
      const uid = await ask({ type: 'assign', ticket: t, title: `Who should take ${t.job_number}?` });
      if (uid == null) return null;
      cur = (await patch<{ ticket: Ticket }>(`/api/tickets/${t.id}`, { version: t.version, assigned_to: uid })).ticket;
    }
    const res = await post<{ ticket: Ticket }>(`/api/tickets/${t.id}/move`, {
      status,
      from_status: cur.status,
      ...place,
      ...(reason !== undefined ? { reason } : {}),
    });
    refreshAfter(res.ticket);
    if (!opts.quiet && res.ticket.status !== t.status) {
      const undoTo = opts.undo;
      toast(`${t.job_number} moved to ${STATUS_LABEL[res.ticket.status]}`, {
        timeout: 8000,
        action: undoTo
          ? {
              label: 'Undo',
              run: () =>
                void moveTicket(me, res.ticket, undoTo.status, { before_id: undoTo.before_id, after_id: undoTo.after_id }, {
                  quiet: true,
                  reason: REASON_STATUSES.includes(undoTo.status) ? undoTo.reason || t.waiting_for || 'Waiting' : undefined,
                }).then((r) => r && toast(`Moved ${t.job_number} back to ${STATUS_LABEL[r.status]}`)),
            }
          : undefined,
      });
    }
    return res.ticket;
  } catch (err) {
    handleConflict(err);
    return null;
  }
}

export async function claimTicket(t: Ticket): Promise<Ticket | null> {
  try {
    const res = await post<{ ticket: Ticket }>(`/api/tickets/${t.id}/claim`);
    refreshAfter(res.ticket);
    toast(`You claimed ${t.job_number}`, { kind: 'success' });
    return res.ticket;
  } catch (err) {
    handleConflict(err);
    return null;
  }
}

export async function releaseTicket(t: Ticket): Promise<Ticket | null> {
  try {
    const res = await post<{ ticket: Ticket }>(`/api/tickets/${t.id}/release`);
    refreshAfter(res.ticket);
    toast(`${t.job_number} returned to the inbox`);
    return res.ticket;
  } catch (err) {
    handleConflict(err);
    return null;
  }
}

/** Save field edits. On a version conflict the panel reloads and the user is told. */
export async function updateTicket(t: Ticket, fields: Record<string, unknown>): Promise<Ticket | null> {
  try {
    const res = await patch<{ ticket: Ticket }>(`/api/tickets/${t.id}`, { version: t.version, ...fields });
    refreshAfter(res.ticket);
    return res.ticket;
  } catch (err) {
    if (err instanceof ApiError && err.status === 409 && err.body?.current) {
      refreshAfter(err.body.current);
      invalidate(`/api/tickets/${t.id}`);
    }
    toastError(err);
    return null;
  }
}

/** Create with an idempotency key so a retry or double-submit can't duplicate the job. */
export async function createTicket(fields: Record<string, unknown>, key = newKey()): Promise<Ticket | null> {
  try {
    const res = await post<{ ticket: Ticket }>('/api/tickets', fields, { 'Idempotency-Key': key });
    refreshAfter(res.ticket);
    return res.ticket;
  } catch (err) {
    toastError(err);
    return null;
  }
}

export async function addComment(t: Ticket, body: string): Promise<boolean> {
  try {
    await post(`/api/tickets/${t.id}/comments`, { body });
    invalidate(`/api/tickets/${t.id}`);
    invalidate('/api/activity');
    return true;
  } catch (err) {
    toastError(err);
    return false;
  }
}

export async function archiveTicket(t: Ticket, restore = false): Promise<Ticket | null> {
  try {
    const res = await post<{ ticket: Ticket }>(`/api/tickets/${t.id}/${restore ? 'restore' : 'archive'}`);
    refreshAfter(res.ticket);
    toast(`${t.job_number} ${restore ? 'restored' : 'archived'}`);
    return res.ticket;
  } catch (err) {
    handleConflict(err);
    return null;
  }
}
