// Shared constants and API types.

export const STATUSES = [
  'inbox',
  'claimed',
  'in_progress',
  'waiting',
  'blocked',
  'review',
  'done',
  'cancelled',
] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABEL: Record<Status, string> = {
  inbox: 'Inbox',
  claimed: 'Claimed',
  in_progress: 'In progress',
  waiting: 'Waiting',
  blocked: 'Blocked',
  review: 'Review',
  done: 'Done',
  cancelled: 'Cancelled',
};

/** Statuses that count as "open" work. */
export const OPEN_STATUSES: Status[] = ['inbox', 'claimed', 'in_progress', 'waiting', 'blocked', 'review'];
/** Statuses that require an assignee. */
export const ASSIGNED_STATUSES: Status[] = ['claimed', 'in_progress', 'review'];
/** Statuses that require a reason ("Waiting for:"). */
export const REASON_STATUSES: Status[] = ['waiting', 'blocked'];
export const CLOSED_STATUSES: Status[] = ['done', 'cancelled'];

export const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_RANK: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

export const ROLES = ['engineer', 'manager'] as const;
export type Role = (typeof ROLES)[number];

/**
 * Estimate buckets. `minutes` is the planning value stored in the database
 * (roughly the midpoint; days are 8-hour working days).
 */
export const ESTIMATE_BUCKETS = [
  { label: '< 15 min', minutes: 10, max: 14 },
  { label: '15–30 min', minutes: 23, max: 30 },
  { label: '30–60 min', minutes: 45, max: 60 },
  { label: '1–2 hr', minutes: 90, max: 120 },
  { label: '2–4 hr', minutes: 180, max: 240 },
  { label: '4–8 hr', minutes: 360, max: 480 },
  { label: '1–2 days', minutes: 720, max: 960 },
  { label: '> 2 days', minutes: 1440, max: Infinity },
] as const;

export function estimateLabel(minutes: number | null | undefined): string | null {
  if (minutes == null) return null;
  for (const b of ESTIMATE_BUCKETS) if (minutes <= b.max) return b.label;
  return ESTIMATE_BUCKETS[ESTIMATE_BUCKETS.length - 1].label;
}

export function formatMinutes(min: number): string {
  if (min < 60) return `${min} min`;
  const h = min / 60;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

export const DEFAULT_JOB_TYPES = [
  'CAD Modification',
  'New CAD Design',
  'Drawing',
  'Drawing Revision',
  'STEP/IGES Cleanup',
  'Geometry Repair',
  'FEA',
  'CFD',
  'Design Calculation',
  'Engineering Analysis',
  'Manufacturing Support',
  'BOM',
  'Documentation',
  'Prototype Support',
  'Design Review',
  'General',
];

// ---------- API shapes ----------

export interface User {
  id: number;
  name: string;
  initials: string;
  color: string;
  role: Role;
  is_admin: boolean;
  active: boolean;
}

export interface JobType {
  id: number;
  name: string;
  sort_order: number;
  active: boolean;
}

export interface Ticket {
  id: number;
  job_number: string;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  assigned_to: number | null;
  created_by: number | null;
  requester: string;
  job_type_id: number | null;
  estimate_minutes: number | null;
  actual_minutes: number | null;
  due_date: string | null; // YYYY-MM-DD (local)
  due_time: string | null; // HH:MM (local) or null = end of day
  due_at: string | null; // UTC ISO deadline, derived
  reference: string;
  file_location: string;
  notes: string;
  waiting_for: string;
  parent_job_id: number | null;
  board_rank: number;
  my_rank: number;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  archived: boolean;
  is_demo: boolean;
  version: number;
  tags: string[];
  // derived
  overdue: boolean;
  due_today: boolean;
}

export interface Activity {
  id: number;
  ticket_id: number;
  job_number?: string;
  ticket_title?: string;
  user_id: number | null;
  user_name?: string | null;
  at: string;
  kind: string;
  from_value: string | null;
  to_value: string | null;
  body: string | null;
}

export interface WorkloadRow {
  user_id: number;
  name: string;
  initials: string;
  color: string;
  load_minutes: number; // estimated minutes in horizon (excl. waiting/blocked)
  unestimated: number; // jobs in horizon with no estimate
  backlog_minutes: number; // all open assigned work (excl. waiting/blocked)
  backlog_unestimated: number;
  in_progress: number;
  assigned_open: number;
  overdue: number;
  blocked: number;
}

export interface ApiError {
  error: string;
  message: string;
  details?: unknown;
  current?: unknown;
}
