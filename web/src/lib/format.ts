// Date and number formatting in the team's time zone (from /api/meta).

import { estimateLabel, formatMinutes, type Ticket } from '@board/shared';

let TZ = 'Asia/Kolkata';
export function setTimeZone(tz: string) {
  TZ = tz;
}

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, ...opts });

export function localDate(d = new Date()): string {
  const p = Object.fromEntries(fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

function addDays(date: string, n: number) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** "Today", "Tomorrow 15:00", "Mon 6 Oct", "12 Jan 2027". */
export function dueLabel(t: Pick<Ticket, 'due_date' | 'due_time'>): string | null {
  if (!t.due_date) return null;
  const today = localDate();
  const time = t.due_time ? ` ${t.due_time}` : '';
  if (t.due_date === today) return `Today${time}`;
  if (t.due_date === addDays(today, 1)) return `Tomorrow${time}`;
  if (t.due_date === addDays(today, -1)) return `Yesterday${time}`;
  const [y, m, d] = t.due_date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  const sameYear = t.due_date.slice(0, 4) === today.slice(0, 4);
  const diff = (Date.parse(t.due_date) - Date.parse(today)) / 86_400_000;
  const opts: Intl.DateTimeFormatOptions =
    Math.abs(diff) < 7 ? { weekday: 'short', day: 'numeric', month: 'short' } : sameYear ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' };
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts }).format(dt) + time;
}

export function clock(iso: string | null): string {
  return iso ? fmt({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso)) : '';
}

/** "10:43" today, "Yesterday 10:43", "Mon 29 Sep 10:43". */
export function when(iso: string): string {
  const d = new Date(iso);
  const day = localDate(d);
  const today = localDate();
  if (day === today) return clock(iso);
  if (day === addDays(today, -1)) return `Yesterday ${clock(iso)}`;
  const sameYear = day.slice(0, 4) === today.slice(0, 4);
  return fmt(sameYear ? { weekday: 'short', day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' }).format(d) + ` ${clock(iso)}`;
}

export const est = (m: number | null) => estimateLabel(m);
export const hours = (m: number) => formatMinutes(m);
