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

export const ROLES = ['engineer', 'manager', 'reviewer'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABEL: Record<Role, string> = { engineer: 'Engineer', manager: 'Manager', reviewer: 'Reviewer' };
/** Who may pass or return drawings in board review (never engineers). */
export const canReview = (u: { role: Role; active: boolean }) => u.active && (u.role === 'manager' || u.role === 'reviewer');
/**
 * Drawing review visibility (decision #29): reviewers see only the drawings
 * handed to them; engineers and the manager see every drawing. This is about
 * the review process only and is not changed by the role capabilities below.
 */
export const seesWholeBoard = (u: { role: Role }) => u.role !== 'reviewer';

/**
 * Job capabilities per role (decision #31), set by the admin under Admin → Roles.
 *  - create: make new jobs (and add projects)
 *  - claim:  claim jobs, be assigned jobs, and work on the jobs assigned to you
 *            (move them between columns, edit their fields, order your My work list)
 *  - edit:   edit, move, assign, archive and reopen any job
 * Commenting needs only board access. Board review (who submits drawings, who
 * passes or returns them, what a reviewer sees) is separate and never changes.
 */
export const CAPABILITIES = ['create', 'claim', 'edit'] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const CAPABILITY_LABEL: Record<Capability, string> = { create: 'Create jobs', claim: 'Claim and be assigned jobs', edit: 'Edit and move any job' };
export type RolePermissions = Record<Role, Record<Capability, boolean>>;
/** The rules the board shipped with (decision #11): engineers do the work, the manager runs the board, reviewers only review. */
export const DEFAULT_PERMISSIONS: RolePermissions = {
  engineer: { create: true, claim: true, edit: true },
  manager: { create: true, claim: false, edit: true },
  reviewer: { create: false, claim: false, edit: false },
};
export const allows = (perms: RolePermissions, u: { role: Role }, cap: Capability): boolean => !!perms[u.role]?.[cap];
/**
 * Who sees the Kanban board, its pages and the job panel: everyone but
 * reviewers, unless the admin has given reviewers a job capability (jobs are
 * sometimes created for them too). Review visibility stays as seesWholeBoard.
 */
export const hasBoardAccess = (perms: RolePermissions, u: { role: Role }): boolean =>
  u.role !== 'reviewer' || CAPABILITIES.some((c) => allows(perms, u, c));
/** Can this person change this job: edit any job, or claim-holders on the job assigned to them. */
export const canChangeJob = (perms: RolePermissions, u: { id: number; role: Role }, t: { assigned_to: number | null }): boolean =>
  allows(perms, u, 'edit') || (allows(perms, u, 'claim') && t.assigned_to === u.id);

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
  /** False until the person has created their password (first sign-in, or after an admin reset). */
  has_password: boolean;
}

export interface JobType {
  id: number;
  name: string;
  sort_order: number;
  active: boolean;
}

/** A project jobs belong to, added by the team when it is needed (decision #30). */
export interface Project {
  id: number;
  name: string;
  created_by: number | null;
  created_at: string;
  /** Jobs in this project that are open (not done, cancelled or archived). */
  open: number;
  /** All jobs in this project, archived included. */
  total: number;
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
  /** The job's project. Null only for jobs from before projects existed (or imported without one). */
  project_id: number | null;
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

// ---------- Drawing review ----------

export const DRAWING_STATES = ['awaiting', 'returned', 'passed', 'handed_over', 'signed', 'withdrawn'] as const;
export type DrawingState = (typeof DRAWING_STATES)[number];

/** Labels never call board review "approval": only the physical signature is. */
export const DRAWING_STATE_LABEL: Record<DrawingState, string> = {
  awaiting: 'Awaiting board review',
  returned: 'Returned for correction',
  passed: 'Board review passed — signature pending',
  handed_over: 'Handed over for signature',
  signed: 'Physically signed',
  withdrawn: 'Withdrawn',
};
export const DRAWING_STATE_SHORT: Record<DrawingState, string> = {
  awaiting: 'Awaiting review',
  returned: 'Returned',
  passed: 'Passed — sign pending',
  handed_over: 'With reviewer to sign',
  signed: 'Signed',
  withdrawn: 'Withdrawn',
};

export interface ReviewFile {
  sha256: string;
  filename: string;
  size: number;
  pages: number;
}

export interface ReviewReference {
  id: number;
  filename: string;
  sha256: string;
  pages: number;
  attached_by: number | null;
  attached_at: string;
  available: boolean;
}

export interface ReviewComment {
  id: number;
  drawing_id: number;
  attempt_id: number | null;
  user_id: number | null;
  body: string;
  created_at: string;
  response: string | null;
  response_by: number | null;
  response_at: string | null;
  resolved_by: number | null;
  resolved_at: string | null;
}

export interface ReviewAttempt {
  id: number;
  number: number;
  submission_number: number;
  filename: string;
  sha256: string;
  notes: string;
  submitted_by: number | null;
  submitted_at: string;
  outcome: 'returned' | 'passed' | 'superseded' | null;
  decided_by: number | null;
  decided_at: string | null;
  decision_note: string | null;
  /** False once an intermediate PDF has been removed after board review. */
  available: boolean;
  file_removed_at: string | null;
}

export interface ReviewDrawing {
  id: number;
  identifier: string;
  kind: 'revision' | 'new';
  state: DrawingState;
  required: boolean;
  ref_reference_id: number | null;
  ref_page: number | null;
  current_attempt_id: number | null;
  passed_attempt_id: number | null;
  passed_by: number | null;
  passed_at: string | null;
  handover_by: number | null;
  handover_at: string | null;
  signed_by: number | null;
  signed_at: string | null;
  cleanup: 'none' | 'pending' | 'done' | 'failed';
  cleanup_detail: string | null;
  version: number;
  /** The reviewers this drawing is handed to (decision #29). */
  reviewers: number[];
  attempts: ReviewAttempt[];
  comments: ReviewComment[];
  open_comments: number;
}

export interface ReviewEvent {
  id: number;
  drawing_id: number | null;
  attempt_id: number | null;
  user_id: number | null;
  at: string;
  kind: string;
  detail: string | null;
}

export interface ReviewSyncState {
  state: 'ok' | 'pending' | 'failed' | 'no_folder';
  detail: string | null;
  updated_at: string | null;
  folder: string;
}

export interface ReviewWorkspace {
  ticket: Ticket;
  submissions: number;
  references: ReviewReference[];
  drawings: ReviewDrawing[];
  events: ReviewEvent[];
  sync: ReviewSyncState;
  /** Required drawings that still need a physical signature. */
  signatures_pending: number;
}

export interface ReviewQueueRow {
  ticket_id: number;
  job_number: string;
  title: string;
  folder: string;
  /** The job's project (null for reviewers, and for jobs without one). */
  project: string | null;
  submissions: number;
  submitted_by: number | null;
  submitted_at: string;
  drawings: number;
  revised: number;
  new_count: number;
  awaiting: number;
  returned: number;
  passed: number;
  handed_over: number;
  signed: number;
  open_comments: number;
  /** Reviewers who passed drawings now handed over to them to sign. */
  signers: number[];
}
