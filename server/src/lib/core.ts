import type { Db } from '../db/connection.ts';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (message: string, extra: Record<string, unknown> = {}) => new HttpError(409, 'conflict', message, extra);
export const badRequest = (message: string) => new HttpError(400, 'bad_request', message);
export const forbidden = (message: string) => new HttpError(403, 'forbidden', message);

export interface ChangeEvent {
  type: 'ticket' | 'users' | 'job_types' | 'projects' | 'reload' | 'presence';
  id?: number;
  version?: number;
  by?: number | null;
}

/** In-process pub/sub used to fan changes out to Server-Sent-Event clients. */
export class EventHub {
  private listeners = new Set<(e: ChangeEvent) => void>();
  private pending: ChangeEvent[] = [];
  subscribe(fn: (e: ChangeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  /** Queue an event; it is delivered by flush() after the transaction commits. */
  emit(e: ChangeEvent) {
    this.pending.push(e);
  }
  flush() {
    const batch = this.pending;
    this.pending = [];
    for (const e of batch) for (const fn of this.listeners) fn(e);
  }
  discard() {
    this.pending = [];
  }
  get size() {
    return this.listeners.size;
  }
}

export interface Ctx {
  db: Db;
  tz: string;
  now: () => Date;
  events: EventHub;
}

export const nowIso = (ctx: Ctx) => ctx.now().toISOString();
export const bool = (v: unknown) => v === 1 || v === true;
export const int = (b: boolean | undefined) => (b ? 1 : 0);
