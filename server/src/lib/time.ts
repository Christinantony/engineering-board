// Time-zone helpers. All timestamps are stored as UTC ISO strings; due dates
// are entered as local calendar dates (+ optional local time) in the team's
// configured time zone (default Asia/Kolkata).

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

function localParts(ms: number, tz: string) {
  const p: Record<string, number> = {};
  for (const part of partsFormatter(tz).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return p as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Offset of `tz` from UTC at instant `ms`, in milliseconds. */
export function tzOffsetMs(ms: number, tz: string): number {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Convert a local wall-clock time in `tz` to a UTC epoch (ms). */
export function localToUtcMs(date: string, time: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ms = guess - tzOffsetMs(guess, tz);
  // second pass handles DST boundaries
  ms = guess - tzOffsetMs(ms, tz);
  return ms;
}

/** Local calendar date (YYYY-MM-DD) of an instant in `tz`. */
export function localDate(ms: number, tz: string): string {
  const p = localParts(ms, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

/** 0 = Sunday … 6 = Saturday */
export function dayOfWeek(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Last day (Sunday) of the Monday-based week containing `date`. */
export function endOfWeek(date: string): string {
  const dow = dayOfWeek(date);
  return addDays(date, dow === 0 ? 0 : 7 - dow);
}

/**
 * Deadline instant for a due date. Date-only → end of that local day
 * (overdue from midnight). With a time → that local time.
 */
export function dueAtIso(dueDate: string | null, dueTime: string | null, tz: string): string | null {
  if (!dueDate) return null;
  if (dueTime) return new Date(localToUtcMs(dueDate, dueTime, tz)).toISOString();
  return new Date(localToUtcMs(addDays(dueDate, 1), '00:00', tz) - 1).toISOString();
}

/** UTC ISO instant for the start of a local date. */
export function startOfLocalDayIso(date: string, tz: string): string {
  return new Date(localToUtcMs(date, '00:00', tz)).toISOString();
}
