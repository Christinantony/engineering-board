// Minimal, dependency-free input validation.
// A Schema<T> is a function that returns a clean T or throws ValidationError.

export class ValidationError extends Error {
  constructor(public issues: { path: string; message: string }[]) {
    super(issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; '));
    this.name = 'ValidationError';
  }
}

export type Schema<T> = (input: unknown, path?: string) => T;
export type Infer<S> = S extends Schema<infer T> ? T : never;

const fail = (path: string, message: string): never => {
  throw new ValidationError([{ path, message }]);
};

export interface StringOpts {
  min?: number;
  max?: number;
  trim?: boolean; // default true
  pattern?: RegExp;
  patternMessage?: string;
}

export const v = {
  string(opts: StringOpts = {}): Schema<string> {
    const { min = 0, max = 10_000, trim = true } = opts;
    return (input, path = '') => {
      if (typeof input !== 'string') return fail(path, 'must be text');
      // strip ASCII control chars except tab/newline/carriage return
      let s = input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
      if (trim) s = s.trim();
      if (s.length < min) return fail(path, min === 1 ? 'is required' : `must be at least ${min} characters`);
      if (s.length > max) return fail(path, `must be at most ${max} characters`);
      if (opts.pattern && !opts.pattern.test(s)) return fail(path, opts.patternMessage ?? 'has an invalid format');
      return s;
    };
  },

  int(opts: { min?: number; max?: number } = {}): Schema<number> {
    const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = opts;
    return (input, path = '') => {
      const n = typeof input === 'string' && input.trim() !== '' ? Number(input) : input;
      if (typeof n !== 'number' || !Number.isInteger(n)) return fail(path, 'must be a whole number');
      if (n < min) return fail(path, `must be ≥ ${min}`);
      if (n > max) return fail(path, `must be ≤ ${max}`);
      return n;
    };
  },

  number(opts: { min?: number; max?: number } = {}): Schema<number> {
    const { min = -Infinity, max = Infinity } = opts;
    return (input, path = '') => {
      if (typeof input !== 'number' || !Number.isFinite(input)) return fail(path, 'must be a number');
      if (input < min || input > max) return fail(path, `must be between ${min} and ${max}`);
      return input;
    };
  },

  bool(): Schema<boolean> {
    return (input, path = '') => {
      if (typeof input === 'boolean') return input;
      if (input === 'true' || input === '1') return true;
      if (input === 'false' || input === '0') return false;
      return fail(path, 'must be true or false');
    };
  },

  enum<const T extends readonly string[]>(values: T): Schema<T[number]> {
    return (input, path = '') => {
      const s = typeof input === 'string' ? input.trim().toLowerCase() : input;
      if (typeof s !== 'string' || !values.includes(s)) return fail(path, `must be one of: ${values.join(', ')}`);
      return s as T[number];
    };
  },

  /** Calendar date YYYY-MM-DD, validated for real dates (no 2026-02-30). */
  date(): Schema<string> {
    return (input, path = '') => {
      if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.trim())) return fail(path, 'must be a date (YYYY-MM-DD)');
      const s = input.trim();
      const [y, m, d] = s.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return fail(path, 'is not a valid date');
      if (y < 2000 || y > 2100) return fail(path, 'year must be between 2000 and 2100');
      return s;
    };
  },

  /** Time HH:MM (24h). */
  time(): Schema<string> {
    return (input, path = '') => {
      if (typeof input !== 'string') return fail(path, 'must be a time (HH:MM)');
      const m = /^(\d{1,2}):(\d{2})$/.exec(input.trim());
      if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return fail(path, 'must be a time (HH:MM)');
      return `${m[1].padStart(2, '0')}:${m[2]}`;
    };
  },

  array<T>(item: Schema<T>, opts: { max?: number } = {}): Schema<T[]> {
    const { max = 1000 } = opts;
    return (input, path = '') => {
      if (!Array.isArray(input)) return fail(path, 'must be a list');
      if (input.length > max) return fail(path, `must have at most ${max} items`);
      return input.map((x, i) => item(x, `${path}[${i}]`));
    };
  },

  /** Accept undefined (field omitted). */
  optional<T>(s: Schema<T>): Schema<T | undefined> {
    return (input, path) => (input === undefined ? undefined : s(input, path));
  },

  /** Accept null; empty string is also treated as null (form fields). */
  nullable<T>(s: Schema<T>): Schema<T | null> {
    return (input, path) => (input === null || input === '' ? null : s(input, path));
  },

  withDefault<T>(s: Schema<T>, dflt: T): Schema<T> {
    return (input, path) => (input === undefined ? dflt : s(input, path));
  },

  /**
   * Object schema. Unknown keys are dropped. All issues are collected so the
   * user sees every problem at once.
   */
  object<S extends Record<string, Schema<any>>>(shape: S): Schema<{ [K in keyof S]: Infer<S[K]> }> {
    return (input, path = '') => {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail(path, 'must be an object');
      const out: Record<string, unknown> = {};
      const issues: { path: string; message: string }[] = [];
      for (const key of Object.keys(shape)) {
        try {
          const val = shape[key]((input as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
          if (val !== undefined) out[key] = val;
        } catch (e) {
          if (e instanceof ValidationError) issues.push(...e.issues);
          else throw e;
        }
      }
      if (issues.length) throw new ValidationError(issues);
      return out as { [K in keyof S]: Infer<S[K]> };
    };
  },
};

// ---------- Request schemas ----------

import { PRIORITIES, STATUSES, ROLES } from './constants.ts';

const id = v.int({ min: 1 });
const minutes = v.int({ min: 0, max: 100_000 });

export const ticketFields = {
  title: v.string({ min: 1, max: 200 }),
  description: v.string({ max: 20_000 }),
  priority: v.enum(PRIORITIES),
  requester: v.string({ max: 200 }),
  job_type_id: v.nullable(id),
  estimate_minutes: v.nullable(minutes),
  actual_minutes: v.nullable(minutes),
  due_date: v.nullable(v.date()),
  due_time: v.nullable(v.time()),
  reference: v.string({ max: 2000 }),
  file_location: v.string({ max: 2000 }),
  notes: v.string({ max: 50_000 }),
  parent_job_id: v.nullable(id),
  tags: v.array(v.string({ min: 1, max: 40 }), { max: 20 }),
};

export const createTicketSchema = v.object({
  title: ticketFields.title,
  description: v.withDefault(ticketFields.description, ''),
  priority: v.withDefault(ticketFields.priority, 'normal'),
  requester: v.withDefault(ticketFields.requester, ''),
  job_type_id: v.optional(ticketFields.job_type_id),
  estimate_minutes: v.optional(ticketFields.estimate_minutes),
  due_date: v.optional(ticketFields.due_date),
  due_time: v.optional(ticketFields.due_time),
  reference: v.withDefault(ticketFields.reference, ''),
  file_location: v.withDefault(ticketFields.file_location, ''),
  notes: v.withDefault(ticketFields.notes, ''),
  parent_job_id: v.optional(ticketFields.parent_job_id),
  tags: v.withDefault(ticketFields.tags, []),
  /** Create and immediately claim for the current user. */
  claim: v.withDefault(v.bool(), false),
  /** Assign on creation (manager use). */
  assigned_to: v.optional(v.nullable(id)),
});
export type CreateTicketInput = Infer<typeof createTicketSchema>;

export const updateTicketSchema = v.object({
  version: v.int({ min: 1 }),
  title: v.optional(ticketFields.title),
  description: v.optional(ticketFields.description),
  priority: v.optional(ticketFields.priority),
  requester: v.optional(ticketFields.requester),
  job_type_id: v.optional(ticketFields.job_type_id),
  estimate_minutes: v.optional(ticketFields.estimate_minutes),
  actual_minutes: v.optional(ticketFields.actual_minutes),
  due_date: v.optional(ticketFields.due_date),
  due_time: v.optional(ticketFields.due_time),
  reference: v.optional(ticketFields.reference),
  file_location: v.optional(ticketFields.file_location),
  notes: v.optional(ticketFields.notes),
  parent_job_id: v.optional(ticketFields.parent_job_id),
  tags: v.optional(ticketFields.tags),
  assigned_to: v.optional(v.nullable(id)),
});
export type UpdateTicketInput = Infer<typeof updateTicketSchema>;

export const moveTicketSchema = v.object({
  status: v.enum(STATUSES),
  /** Status the client believed the ticket had; mismatch → 409. */
  from_status: v.optional(v.enum(STATUSES)),
  /** Neighbour cards in the target column (for ordering). */
  before_id: v.optional(v.nullable(id)),
  after_id: v.optional(v.nullable(id)),
  /** "Waiting for:" text, required for waiting/blocked. */
  reason: v.optional(v.string({ max: 500 })),
});
export type MoveTicketInput = Infer<typeof moveTicketSchema>;

export const rankSchema = v.object({
  before_id: v.optional(v.nullable(id)),
  after_id: v.optional(v.nullable(id)),
});

export const commentSchema = v.object({ body: v.string({ min: 1, max: 10_000 }) });

const color = v.string({ pattern: /^#[0-9a-fA-F]{6}$/, patternMessage: 'must be a colour like #2563eb' });
export const createUserSchema = v.object({
  name: v.string({ min: 1, max: 60 }),
  initials: v.optional(v.string({ min: 1, max: 3 })),
  color: v.optional(color),
  role: v.withDefault(v.enum(ROLES), 'engineer'),
  is_admin: v.withDefault(v.bool(), false),
});
export const updateUserSchema = v.object({
  name: v.optional(v.string({ min: 1, max: 60 })),
  initials: v.optional(v.string({ min: 1, max: 3 })),
  color: v.optional(color),
  role: v.optional(v.enum(ROLES)),
  is_admin: v.optional(v.bool()),
  active: v.optional(v.bool()),
});

/** Sign-in passwords: at least 6 characters, spaces allowed (a phrase is fine), not only spaces. */
export const PASSWORD_MIN = 6;
export const passwordField = v.string({ min: PASSWORD_MIN, max: 100, trim: false, pattern: /\S/, patternMessage: 'must not be only spaces' });
export const signInSchema = v.object({ user_id: v.int({ min: 1 }), password: v.string({ max: 100, trim: false }) });
export const createPasswordSchema = v.object({ user_id: v.int({ min: 1 }), password: passwordField });
export const changePasswordSchema = v.object({ current_password: v.string({ max: 100, trim: false }), new_password: passwordField });

export const jobTypeSchema = v.object({
  name: v.string({ min: 1, max: 60 }),
  sort_order: v.optional(v.int({ min: 0, max: 10_000 })),
  active: v.optional(v.bool()),
});

// ---------- Drawing review ----------

const sha = v.string({ min: 64, max: 64, pattern: /^[0-9a-f]{64}$/, patternMessage: 'must be a file reference from an upload' });
const filename = v.string({ min: 1, max: 255 });
export const identifierField = v.string({ min: 1, max: 100, pattern: /^[^\\/:*?"<>|]+$/, patternMessage: 'cannot contain \\ / : * ? " < > |' });

export const reviewSubmissionSchema = v.object({
  references: v.withDefault(v.array(v.object({ sha256: sha, filename }), { max: 10 }), []),
  drawings: v.array(
    v.object({
      sha256: sha,
      filename,
      /** Defaults to the file name without ".pdf". */
      identifier: v.optional(identifierField),
      kind: v.withDefault(v.enum(['revision', 'new'] as const), 'revision'),
      notes: v.string({ min: 1, max: 5000 }),
      /** Optional reference bookmark chosen while preparing the submission. */
      ref_sha256: v.optional(v.nullable(sha)),
      ref_page: v.optional(v.nullable(v.int({ min: 1, max: 100_000 }))),
    }),
    { max: 50 },
  ),
});
export type ReviewSubmissionInput = Infer<typeof reviewSubmissionSchema>;

export const referenceAttachSchema = v.object({ sha256: sha, filename });
export const bookmarkSchema = v.object({
  reference_id: v.nullable(v.int({ min: 1 })),
  page: v.nullable(v.int({ min: 1, max: 100_000 })),
});
export const decisionSchema = v.object({
  attempt_id: v.int({ min: 1 }),
  outcome: v.enum(['passed', 'returned'] as const),
  note: v.withDefault(v.string({ max: 5000 }), ''),
});
export const reviewCommentSchema = v.object({
  body: v.string({ min: 1, max: 5000 }),
  attempt_id: v.optional(v.nullable(v.int({ min: 1 }))),
});
export const reviewTextSchema = v.object({ body: v.withDefault(v.string({ max: 5000 }), '') });
export const drawingEditSchema = v.object({ identifier: identifierField });
