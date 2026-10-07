import { createServer, type Server } from 'node:http';
import { STATUSES, PRIORITIES, ESTIMATE_BUCKETS, STATUS_LABEL, hasBoardAccess, type Capability, type User } from '@board/shared';
import { v, signInSchema, createPasswordSchema, changePasswordSchema } from '@board/shared';
import { openDb, migrate, pendingMigrations, run, all, tx } from './db/connection.ts';
import { createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { seedBase, seedDemo, clearDemo, hasDemoData } from './db/seed.ts';
import { EventHub, HttpError, forbidden, type Ctx } from './lib/core.ts';
import { localDate } from './lib/time.ts';
import {
  HANDLED,
  Reply,
  Router,
  buildRequestHead,
  readRequestBody,
  checkUploadHeaders,
  streamUpload,
  streamPdfUpload,
  DEFAULT_RESTORE_UPLOAD_MAX_MB,
  cookie,
  errorToReply,
  send,
  serveStatic,
  type Request,
} from './http/http.ts';
import {
  ADMIN_TTL_SECONDS,
  adminCookie,
  changePin,
  checkPassword,
  clearAllPasswords,
  clearPassword,
  createPassword,
  hasPassword,
  setPassword,
  ensureAuthSettings,
  resetPin,
  pinIsDefault,
  readAdmin,
  readSession,
  sessionCookie,
  verifyPin,
} from './domain/auth.ts';
import { createUser, getUser, listUsers, requireUser, updateUser } from './domain/users.ts';
import { createJobType, listJobTypes, updateJobType } from './domain/jobTypes.ts';
import { createProject, listProjects } from './domain/projects.ts';
import { getPermissions, requireCapability, setPermissions } from './domain/permissions.ts';
import {
  createMaterial,
  createSheetSize,
  deleteSheetSize,
  seedTools,
  setSheetSettings,
  sheetCalculatorData,
  updateMaterial,
  updateSheetSize,
} from './domain/tools.ts';
import {
  addComment,
  archiveTicket,
  claimTicket,
  createTicket,
  getTicket,
  listTickets,
  moveTicket,
  parseFilters,
  recentActivity,
  releaseTicket,
  restoreTicket,
  setMyRank,
  ticketActivity,
  activityPage,
  updateTicket,
} from './domain/tickets.ts';
import { dashboard, myWork, todayView, workload, type Horizon } from './domain/views.ts';
import { report } from './domain/reports.ts';
import { markSeen, notifications } from './domain/notifications.ts';
import { Presence } from './domain/presence.ts';
import {
  backupNow,
  backupPath,
  dbStats,
  listBackups,
  pruneBackups,
  restoreFrom,
  runDailyBackupIfDue,
  type BackupCtx,
} from './domain/backup.ts';
import { archiveOld, commitImport, deleteTag, exportCsv, exportJson, importTemplate, listTags, previewImport, renameTag } from './domain/transfer.ts';
import { readFileSync, rmSync } from 'node:fs';
import type { ReviewWorkspace } from '@board/shared';
import { inspectPdf, PdfError } from './domain/pdf.ts';
import { collectUnusedUploads, ingest, storeDir } from './domain/reviewStore.ts';
import {
  addReference,
  addReviewComment,
  canSeeFile,
  cleanupDrawing,
  decide,
  handover,
  markSigned,
  renameDrawing,
  requireReviewAccess,
  resolveComment,
  respondToComment,
  reviewQueue,
  reviewerTicketIds,
  runPendingCleanups,
  servableBlob,
  setBookmark,
  setDrawingReviewers,
  submit,
  withdraw,
  workspace,
  type QueueTab,
} from './domain/reviews.ts';
import { jobsNeedingSync, markSyncPending, revisionLog, settleSyncs, syncProjectFolder } from './domain/projectFolder.ts';

/** Default maximum PDF upload for drawing review (merged signed scans can be large). */
export const DEFAULT_REVIEW_UPLOAD_MAX_MB = 200;

export const APP_VERSION = '1.5.0';

export interface AppOptions {
  dbPath: string;
  tz?: string;
  now?: () => Date;
  webRoot?: string;
  /** Planning reference shown on the workload page (not a capacity limit). */
  workday?: { hoursPerDay: number; workingDays: number[] };
  log?: boolean;
  /** Reset the admin PIN to the default on start (the RESET-ADMIN-PIN file on the host PC). */
  resetAdminPin?: boolean;
  /** Clear everyone's password on start (the RESET-PASSWORDS file on the host PC); each person creates a new one at sign-in. */
  resetPasswords?: boolean;
  /** Where backups go (default: a "backups" folder next to the database). */
  backupDir?: string;
  backupKeepDays?: number;
  /** Maximum restore file upload, in MiB (default 64; 1..1024). */
  restoreUploadMaxMB?: number;
  /** Take the daily backup automatically (off in tests). */
  autoBackup?: boolean;
  /** Maximum PDF upload for drawing review, in MiB (default 200; 1..2048). */
  reviewUploadMaxMB?: number;
  /** Retry project-folder copies and clean-ups in the background (off in tests). */
  reviewMaintenance?: boolean;
}

export interface App {
  ctx: BackupCtx;
  server: Server;
  /** Every API route (method and pattern). */
  routes: { method: string; path: string }[];
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

const SESSION_COOKIE = 'eb_session';
const ADMIN_COOKIE = 'eb_admin';
const ONE_YEAR = 365 * 24 * 3600;

export function createApp(opts: AppOptions): App {
  const uploadMaxMB = opts.restoreUploadMaxMB ?? DEFAULT_RESTORE_UPLOAD_MAX_MB;
  if (!Number.isInteger(uploadMaxMB) || uploadMaxMB < 1 || uploadMaxMB > 1024)
    throw new Error('restoreUploadMaxMB must be a whole number from 1 to 1024.');
  const uploadMaxBytes = uploadMaxMB * 1048576;
  const reviewMaxMB = opts.reviewUploadMaxMB ?? DEFAULT_REVIEW_UPLOAD_MAX_MB;
  if (!Number.isInteger(reviewMaxMB) || reviewMaxMB < 1 || reviewMaxMB > 2048)
    throw new Error('reviewUploadMaxMB must be a whole number from 1 to 2048.');
  const reviewMaxBytes = reviewMaxMB * 1048576;
  const ctx: BackupCtx = {
    db: openDb(opts.dbPath),
    tz: opts.tz ?? 'Asia/Kolkata',
    now: opts.now ?? (() => new Date()),
    events: new EventHub(),
    dbPath: opts.dbPath,
    backupDir: opts.backupDir ?? join(dirname(opts.dbPath), 'backups'),
    keepDays: opts.backupKeepDays ?? 30,
  };
  // NOTE: always use ctx.db (never a captured copy): a restore swaps in a new connection.
  // A new version of the board upgrading existing data backs it up first, so the
  // previous version can be put back with its data exactly as it was.
  try {
    const pending = pendingMigrations(ctx.db);
    if (pending.length && pending[0] > 1) {
      const b = backupNow(ctx, 'pre-upgrade');
      console.log(`Database upgrade ${pending.join(', ')}: a backup of the data from before is in ${join(ctx.backupDir, b.name)}`);
    }
    migrate(ctx.db);
    ensureAuthSettings(ctx);
    if (opts.resetAdminPin) resetPin(ctx);
    if (opts.resetPasswords) clearAllPasswords(ctx);
    seedBase(ctx);
    seedTools(ctx);
  } catch (e) {
    ctx.db.close(); // don't hold the file open (and locked on Windows) after a failed start
    throw e;
  }
  // forget idempotency keys older than 7 days
  run(ctx.db, 'DELETE FROM idempotency WHERE created_at < ?', new Date(ctx.now().getTime() - 7 * 86_400_000).toISOString());

  // daily backup: a minute after start, then checked every hour
  const timers: ReturnType<typeof setTimeout>[] = [];
  let closing: Promise<void> | undefined;
  const maintenance = () => {
    try {
      const b = runDailyBackupIfDue(ctx);
      if (b) console.log(`Daily backup saved: ${join(ctx.backupDir, b.name)}`);
    } catch (e) {
      console.error('Daily backup failed:', (e as Error).message);
    }
  };
  if (opts.autoBackup) {
    timers.push(setTimeout(maintenance, 60_000));
    timers.push(setInterval(maintenance, 3600_000));
  }
  // drawing review: finish clean-ups and project-folder copies that failed
  // (a share that was offline, say), and forget uploads never submitted
  const reviewMaintenance = () => {
    try {
      runPendingCleanups(ctx);
      collectUnusedUploads(ctx);
      for (const id of jobsNeedingSync(ctx)) void syncProjectFolder(ctx, id);
    } catch (e) {
      console.error('Drawing review maintenance failed:', (e as Error).message);
    }
  };
  if (opts.reviewMaintenance) {
    timers.push(setTimeout(reviewMaintenance, 30_000));
    timers.push(setInterval(reviewMaintenance, 5 * 60_000));
  }
  /** After a review change commits: clean up (if a drawing passed), then update the project folder. */
  const afterReview = (ticketId: number, cleanupDrawingId?: number) => {
    markSyncPending(ctx, ticketId);
    setImmediate(() => {
      if (!ctx.db.isOpen) return;
      try {
        if (cleanupDrawingId) cleanupDrawing(ctx, cleanupDrawingId);
        ctx.events.flush();
      } catch (e) {
        console.error('Review clean-up failed:', (e as Error).message);
      }
      void syncProjectFolder(ctx, ticketId);
    });
  };

  const presence = new Presence(ctx.events, () => ctx.now().getTime());
  const router = new Router();
  const id = (req: Request) => v.int({ min: 1 })(req.params.id, 'id');

  // ---- auth wrappers ----
  function currentUser(req: Pick<Request, 'cookies'>): User | null {
    const uid = readSession(ctx, req.cookies[SESSION_COOKIE]);
    if (!uid) return null;
    const u = getUser(ctx, uid);
    return u && u.active ? u : null;
  }
  const pub = (method: string, path: string, h: (req: Request) => unknown) => router.add(method, path, h);
  const authed = (method: string, path: string, h: (req: Request, user: User) => unknown) =>
    router.add(method, path, (req) => {
      const user = currentUser(req);
      if (!user) throw new HttpError(401, 'unauthenticated', 'Please sign in first.');
      return h(req, user);
    });
  const REVIEWER_ONLY = 'Reviewers see only the drawings handed to them for review.';
  function requireAdmin(req: Pick<Request, 'cookies'>): User {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'unauthenticated', 'Please sign in first.');
    if (!hasBoardAccess(getPermissions(ctx), user)) throw forbidden(REVIEWER_ONLY);
    if (!readAdmin(ctx, req.cookies[ADMIN_COOKIE], user.id))
      throw new HttpError(403, 'admin_locked', 'Unlock the admin area with the PIN first.');
    return user;
  }
  const admin = (method: string, path: string, h: (req: Request, user: User) => unknown) =>
    router.add(method, path, (req) => h(req, requireAdmin(req)));
  /**
   * Board-wide reads: reviewers see only the drawings handed to them (decision
   * #29), unless the admin has given reviewers a job capability (decision #31).
   */
  const board = (method: string, path: string, h: (req: Request, user: User) => unknown) =>
    authed(method, path, (req, user) => {
      if (!hasBoardAccess(getPermissions(ctx), user)) throw forbidden(REVIEWER_ONLY);
      return h(req, user);
    });
  /**
   * Job-changing routes: board access plus, when given, the capability the admin
   * set for the role (Admin → Roles). Per-job rules (your own job) are checked in domain/tickets.ts.
   */
  const worker = (method: string, path: string, h: (req: Request, user: User) => unknown, cap?: Capability) =>
    authed(method, path, (req, user) => {
      if (!hasBoardAccess(getPermissions(ctx), user)) throw forbidden('Reviewers review the drawings handed to them; they cannot create or change jobs.');
      if (cap) requireCapability(ctx, user, cap);
      return h(req, user);
    });

  // ---- public ----
  pub('GET', '/api/health', () => ({ ok: true, version: APP_VERSION, time: ctx.now().toISOString() }));
  pub('GET', '/api/meta', () => ({
    version: APP_VERSION,
    tz: ctx.tz,
    today: localDate(ctx.now().getTime(), ctx.tz),
    statuses: STATUSES.map((s) => ({ id: s, label: STATUS_LABEL[s] })),
    priorities: PRIORITIES,
    estimates: ESTIMATE_BUCKETS.map(({ label, minutes }) => ({ label, minutes })),
    pin_is_default: pinIsDefault(ctx),
    workday: { hours_per_day: opts.workday?.hoursPerDay ?? 8, working_days: opts.workday?.workingDays ?? [1, 2, 3, 4, 5, 6] },
    demo_present: hasDemoData(ctx),
    permissions: getPermissions(ctx),
  }));
  pub('GET', '/api/users', (req) => ({ users: listUsers(ctx, req.query.get('all') === '1') }));
  pub('GET', '/api/session', (req) => ({ user: currentUser(req) }));
  const signedIn = (userId: number) => {
    const u = getUser(ctx, userId)!;
    return new Reply(200, { user: u }, { 'Set-Cookie': cookie(SESSION_COOKIE, sessionCookie(ctx, u.id), { maxAge: ONE_YEAR }) });
  };
  const availableUser = (userId: number): User => {
    const u = getUser(ctx, userId);
    if (!u || !u.active) throw new HttpError(400, 'bad_user', 'That user is not available.');
    return u;
  };
  // Sign in with a password (decision #28). Someone without one yet gets 409 and creates it below.
  pub('POST', '/api/session', (req) => {
    const { user_id, password } = signInSchema(req.body);
    const u = availableUser(user_id);
    if (!u.has_password) throw new HttpError(409, 'password_not_set', `${u.name} has no password yet. Create one to sign in.`);
    checkPassword(ctx, u.id, password);
    return signedIn(u.id);
  });
  // First sign-in (or the first after an admin reset): create the password, then sign in.
  pub('POST', '/api/session/password', (req) => {
    const { user_id, password } = createPasswordSchema(req.body);
    const u = availableUser(user_id);
    createPassword(ctx, u.id, password);
    return signedIn(u.id);
  });
  pub('DELETE', '/api/session', () =>
    new Reply(200, { ok: true }, { 'Set-Cookie': [cookie(SESSION_COOKIE, '', { maxAge: 0 }), cookie(ADMIN_COOKIE, '', { maxAge: 0 })] }),
  );
  // Change your own password. Other browsers signed in as you are signed out; this one gets a new cookie.
  authed('POST', '/api/me/password', (req, user) => {
    const { current_password, new_password } = changePasswordSchema(req.body);
    checkPassword(ctx, user.id, current_password);
    setPassword(ctx, user.id, new_password);
    return signedIn(user.id);
  });

  // ---- reference data ----
  authed('GET', '/api/job-types', () => ({ job_types: listJobTypes(ctx) }));
  board('GET', '/api/tools/sheet', () => sheetCalculatorData(ctx));
  board('GET', '/api/tags', () => ({
    tags: all<{ name: string; count: number }>(
      ctx.db,
      'SELECT g.name, COUNT(tt.ticket_id) count FROM tags g LEFT JOIN ticket_tags tt ON tt.tag_id = g.id GROUP BY g.id ORDER BY count DESC, g.name',
    ),
  }));

  // ---- tickets ----
  board('GET', '/api/tickets', (req) => listTickets(ctx, parseFilters(req.query)));
  // ---- projects (decision #30): added by the team when needed, none preset ----
  board('GET', '/api/projects', () => ({ projects: listProjects(ctx) }));
  worker('POST', '/api/projects', (req, user) => new Reply(201, { project: createProject(ctx, user, req.body ?? {}) }), 'create');

  worker('POST', '/api/tickets', (req, user) => {
    const key = req.headers['idempotency-key'];
    const k = typeof key === 'string' && key.length >= 8 && key.length <= 100 ? key : undefined;
    // every job created on the board belongs to a project (decision #30)
    const { ticket, replayed } = createTicket(ctx, user, req.body ?? {}, k, { requireProject: true });
    return new Reply(replayed ? 200 : 201, { ticket, replayed });
  }, 'create');
  board('GET', '/api/tickets/:id', (req) => ({ ticket: getTicket(ctx, id(req)), activity: ticketActivity(ctx, id(req)) }));
  worker('PATCH', '/api/tickets/:id', (req, user) => ({ ticket: updateTicket(ctx, user, id(req), req.body ?? {}) }));
  worker('POST', '/api/tickets/:id/move', (req, user) => ({ ticket: moveTicket(ctx, user, id(req), req.body ?? {}) }));
  worker('POST', '/api/tickets/:id/claim', (req, user) => ({ ticket: claimTicket(ctx, user, id(req)) }));
  worker('POST', '/api/tickets/:id/release', (req, user) => ({ ticket: releaseTicket(ctx, user, id(req)) }));
  worker('POST', '/api/tickets/:id/my-rank', (req, user) => ({ ticket: setMyRank(ctx, user, id(req), req.body ?? {}) }));
  worker('POST', '/api/tickets/:id/comments', (req, user) => new Reply(201, { activity: addComment(ctx, user, id(req), req.body ?? {}) }));
  worker('POST', '/api/tickets/:id/archive', (req, user) => ({ ticket: archiveTicket(ctx, user, id(req)) }));
  worker('POST', '/api/tickets/:id/restore', (req, user) => ({ ticket: restoreTicket(ctx, user, id(req)) }));
  board('GET', '/api/tickets/:id/activity', (req) => ({ activity: ticketActivity(ctx, id(req)) }));

  // ---- drawing review ----
  const did = (req: Request) => v.int({ min: 1 })(req.params.id, 'id');
  authed('GET', '/api/reviews', (req, user) => {
    const tab = (req.query.get('tab') ?? 'awaiting') as QueueTab;
    if (!['awaiting', 'returned', 'signature', 'done', 'all'].includes(tab)) throw new HttpError(400, 'bad_request', 'Unknown review tab');
    return reviewQueue(ctx, user, tab, (req.query.get('q') ?? '').slice(0, 100));
  });
  authed('POST', '/api/review/uploads', (req) => {
    // streamed and hashed before this runs (see handleRequest)
    const up = req.upload!;
    const filename = (req.query.get('name') ?? 'drawing.pdf').replace(/^.*[\\/]/, '').slice(0, 255) || 'drawing.pdf';
    let pages: number;
    try {
      pages = inspectPdf(readFileSync(up.path)).pages;
    } catch (e) {
      if (e instanceof PdfError) throw new HttpError(400, 'bad_pdf', `${filename}: ${e.message}`);
      throw e;
    }
    if (req.query.get('kind') === 'drawing' && pages !== 1)
      throw new HttpError(
        400,
        'not_single_page',
        `${filename} has ${pages} pages. Each drawing submitted for board review must be a single-page PDF: export each sheet on its own.`,
      );
    tx(ctx.db, () => ingest(ctx, up.path, up.sha256!, pages));
    return new Reply(201, { file: { sha256: up.sha256, filename, size: up.bytes, pages } });
  });
  authed('GET', '/api/review-files/:sha', (req, user) => {
    if (!canSeeFile(ctx, user, req.params.sha)) throw new HttpError(404, 'not_found', 'PDF not found');
    const f = servableBlob(ctx, req.params.sha);
    req.res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${f.filename.replace(/[^\w .()-]/g, '_')}"`,
      // named by content: the bytes behind this address never change
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    createReadStream(f.path).pipe(req.res);
    return HANDLED;
  });
  authed('GET', '/api/tickets/:id/review', (req, user) => {
    requireReviewAccess(ctx, user, id(req));
    return workspace(ctx, id(req), user);
  });
  board('GET', '/api/tickets/:id/review/log', (req) => {
    const t = getTicket(ctx, id(req));
    return new Reply(200, revisionLog(ctx, t.file_location, t.id), {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `inline; filename="${t.job_number}-REVISION_LOG.md"`,
    });
  });
  const reviewed = (ticketId: number, w: unknown, cleanup?: number) => {
    afterReview(ticketId, cleanup);
    return w;
  };
  authed('POST', '/api/tickets/:id/review/submissions', (req, user) => new Reply(201, reviewed(id(req), submit(ctx, user, id(req), req.body ?? {}))));
  authed('POST', '/api/tickets/:id/review/references', (req, user) => reviewed(id(req), addReference(ctx, user, id(req), req.body ?? {})));
  board('POST', '/api/tickets/:id/review/sync', (req) => {
    const t = getTicket(ctx, id(req));
    afterReview(t.id);
    return { ok: true };
  });
  const onDrawing = (fn: (req: Request, user: User) => ReviewWorkspace) => (req: Request, user: User) => {
    const w = fn(req, user);
    return reviewed(w.ticket.id, w);
  };
  authed('PUT', '/api/review/drawings/:id/reference-page', onDrawing((req, user) => setBookmark(ctx, user, did(req), req.body ?? {})));
  authed('POST', '/api/review/drawings/:id/decision', (req, user) => {
    const r = decide(ctx, user, did(req), req.body ?? {});
    return reviewed(r.workspace.ticket.id, r.workspace, r.cleanup ? did(req) : undefined);
  });
  authed('POST', '/api/review/drawings/:id/handover', onDrawing((req, user) => handover(ctx, user, did(req))));
  authed('POST', '/api/review/drawings/:id/signed', onDrawing((req, user) => markSigned(ctx, user, did(req))));
  authed('POST', '/api/review/drawings/:id/withdraw', onDrawing((req, user) => withdraw(ctx, user, did(req), req.body ?? {})));
  authed('PATCH', '/api/review/drawings/:id', onDrawing((req, user) => renameDrawing(ctx, user, did(req), req.body ?? {})));
  authed('PUT', '/api/review/drawings/:id/reviewers', onDrawing((req, user) => setDrawingReviewers(ctx, user, did(req), req.body ?? {})));
  authed('POST', '/api/review/drawings/:id/comments', onDrawing((req, user) => addReviewComment(ctx, user, did(req), req.body ?? {})));
  authed('POST', '/api/review/comments/:id/respond', onDrawing((req, user) => respondToComment(ctx, user, did(req), req.body ?? {})));
  authed('POST', '/api/review/comments/:id/resolve', onDrawing((req, user) => resolveComment(ctx, user, did(req))));

  // ---- views ----
  board('GET', '/api/activity', (req) => {
    const limit = Math.min(Math.max(Number(req.query.get('limit')) || 30, 1), 200);
    const since = Number(req.query.get('since')) || undefined;
    if (since) return { activity: recentActivity(ctx, limit, since) };
    return {
      activity: activityPage(ctx, {
        limit,
        before: Number(req.query.get('before')) || undefined,
        userId: Number(req.query.get('user')) || undefined,
      }),
    };
  });

  // ---- collaboration: notifications and presence ----
  authed('GET', '/api/notifications', (_req, user) => notifications(ctx, user));
  authed('POST', '/api/notifications/seen', (req, user) => {
    const { up_to } = v.object({ up_to: v.int({ min: 0 }) })(req.body);
    markSeen(ctx, user.id, up_to);
    return { ok: true };
  });
  board('GET', '/api/presence', () => ({ online: presence.snapshot() }));
  authed('POST', '/api/presence', (req, user) => {
    const { job_id, tab } = v.object({
      job_id: v.nullable(v.int({ min: 1 })),
      tab: v.string({ min: 1, max: 64 }),
    })(req.body);
    presence.view(user.id, tab, job_id);
    return { ok: true };
  });
  board('GET', '/api/dashboard', () => dashboard(ctx));
  board('GET', '/api/today', () => todayView(ctx));
  board('GET', '/api/my-work', (req, user) => {
    const uid = req.query.get('user') ? v.int({ min: 1 })(req.query.get('user'), 'user') : user.id;
    return myWork(ctx, uid);
  });
  board('GET', '/api/reports', (req) => {
    const today = localDate(ctx.now().getTime(), ctx.tz);
    return report(ctx, req.query.get('from') ?? today, req.query.get('to') ?? today);
  });
  board('GET', '/api/workload', (req) => workload(ctx, (req.query.get('horizon') ?? 'today') as Horizon));

  // ---- live updates (Server-Sent Events) ----
  authed('GET', '/api/events', (req, user) => {
    const res = req.res;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ time: ctx.now().toISOString(), version: APP_VERSION })}\n\n`);
    // a reviewer hears only about jobs with drawings handed to them (decision #29)
    const hears = (e: { type: string; id?: number }) =>
      hasBoardAccess(getPermissions(ctx), user) || e.type === 'reload' || e.type === 'users' || e.type === 'permissions' || (e.type === 'ticket' && e.id != null && reviewerTicketIds(ctx, user).has(e.id));
    const unsubscribe = ctx.events.subscribe((e) => {
      if (hears(e)) res.write(`data: ${JSON.stringify(e)}\n\n`);
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    const leave = presence.connect(user.id);
    const cleanup = () => {
      clearInterval(ping);
      unsubscribe();
      leave();
    };
    req.raw.on('close', cleanup);
    sseConnections.add(res);
    res.on('close', () => sseConnections.delete(res));
    return HANDLED;
  });

  // ---- admin ----
  board('GET', '/api/admin/status', (req, user) => ({
    unlocked: readAdmin(ctx, req.cookies[ADMIN_COOKIE], user.id),
    pin_is_default: pinIsDefault(ctx),
  }));
  board('POST', '/api/admin/unlock', (req, user) => {
    const { pin } = v.object({ pin: v.string({ min: 1, max: 32 }) })(req.body);
    if (!verifyPin(ctx, pin)) throw forbidden('Wrong PIN');
    return new Reply(200, { unlocked: true }, { 'Set-Cookie': cookie(ADMIN_COOKIE, adminCookie(ctx, user.id), { maxAge: ADMIN_TTL_SECONDS }) });
  });
  authed('POST', '/api/admin/lock', () => new Reply(200, { unlocked: false }, { 'Set-Cookie': cookie(ADMIN_COOKIE, '', { maxAge: 0 }) }));
  admin('POST', '/api/admin/pin', (req) => {
    const { new_pin } = v.object({
      new_pin: v.string({ min: 4, max: 32, pattern: /^\S+$/, patternMessage: 'must not contain spaces' }),
    })(req.body);
    changePin(ctx, new_pin);
    return { ok: true };
  });
  admin('GET', '/api/admin/users', () => ({ users: listUsers(ctx, true) }));
  admin('POST', '/api/admin/users', (req) => new Reply(201, { user: createUser(ctx, req.body ?? {}) }));
  admin('PATCH', '/api/admin/users/:id', (req) => ({ user: updateUser(ctx, id(req), req.body ?? {}) }));
  // Forgotten password: clear it. The person creates a new one at their next sign-in.
  admin('DELETE', '/api/admin/users/:id/password', (req) => {
    const u = requireUser(ctx, id(req));
    if (!hasPassword(ctx, u.id)) throw new HttpError(409, 'password_not_set', `${u.name} has no password to reset.`);
    clearPassword(ctx, u.id);
    return { user: getUser(ctx, u.id) };
  });
  // who may do what with jobs (decision #31)
  admin('GET', '/api/admin/permissions', () => ({ permissions: getPermissions(ctx) }));
  admin('PUT', '/api/admin/permissions', (req) => ({ permissions: setPermissions(ctx, req.body ?? {}) }));
  // tools reference data (decision #32)
  admin('POST', '/api/admin/materials', (req) => new Reply(201, { material: createMaterial(ctx, req.body ?? {}) }));
  admin('PATCH', '/api/admin/materials/:id', (req) => ({ material: updateMaterial(ctx, id(req), req.body ?? {}) }));
  admin('POST', '/api/admin/sheet-sizes', (req) => new Reply(201, { size: createSheetSize(ctx, req.body ?? {}) }));
  admin('PATCH', '/api/admin/sheet-sizes/:id', (req) => ({ size: updateSheetSize(ctx, id(req), req.body ?? {}) }));
  admin('DELETE', '/api/admin/sheet-sizes/:id', (req) => deleteSheetSize(ctx, id(req)));
  admin('PUT', '/api/admin/tools/sheet-settings', (req) => ({ settings: setSheetSettings(ctx, req.body ?? {}) }));
  admin('POST', '/api/admin/job-types', (req) => new Reply(201, { job_type: createJobType(ctx, req.body ?? {}) }));
  admin('PATCH', '/api/admin/job-types/:id', (req) => ({ job_type: updateJobType(ctx, id(req), req.body ?? {}) }));
  admin('POST', '/api/admin/demo', () => {
    if (hasDemoData(ctx)) throw new HttpError(409, 'conflict', 'Demo data is already loaded.');
    return { created: seedDemo(ctx) };
  });
  admin('DELETE', '/api/admin/demo', () => ({ removed: clearDemo(ctx) }));

  // ---- export / import ----
  const attach = (name: string, type: string) => ({ 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"` });
  const today = () => localDate(ctx.now().getTime(), ctx.tz);
  board('GET', '/api/export/tickets.csv', (req) =>
    new Reply(200, exportCsv(ctx, parseFilters(req.query)), attach(`engineering-board-jobs-${today()}.csv`, 'text/csv; charset=utf-8')),
  );
  board('GET', '/api/export/tickets.json', (req) =>
    new Reply(200, exportJson(ctx, { activity: req.query.get('activity') !== '0' }), attach(`engineering-board-${today()}.json`, 'application/json; charset=utf-8')),
  );
  board('GET', '/api/import/template.csv', () => new Reply(200, importTemplate(), attach('engineering-board-import-template.csv', 'text/csv; charset=utf-8')));
  const importOpts = (req: Request) => ({
    date_order: req.query.get('date_order') === 'MDY' ? ('MDY' as const) : ('DMY' as const),
    create_job_types: req.query.get('create_job_types') !== '0',
    create_projects: req.query.get('create_projects') !== '0',
    filename: (req.query.get('filename') ?? '').slice(0, 200),
    skip_invalid: req.query.get('skip_invalid') === '1',
    allow_duplicate: req.query.get('allow_duplicate') === '1',
  });
  admin('POST', '/api/admin/import/preview', (req) => previewImport(ctx, req.rawBody, importOpts(req)));
  admin('POST', '/api/admin/import/commit', (req, user) => {
    const o = importOpts(req);
    backupNow(ctx, 'pre-import');
    return commitImport(ctx, user, req.rawBody, o);
  });

  // ---- backups, restore, archive, tags ----
  admin('GET', '/api/admin/info', () => ({ ...dbStats(ctx), version: APP_VERSION, node: process.versions.node, tz: ctx.tz, backups: listBackups(ctx) }));
  admin('POST', '/api/admin/backups', () => {
    const b = backupNow(ctx, 'manual');
    pruneBackups(ctx);
    return new Reply(201, { backup: b });
  });
  admin('GET', '/api/admin/backups/:name', (req) => {
    const path = backupPath(ctx, req.params.name);
    req.res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${req.params.name}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    createReadStream(path).pipe(req.res);
    return HANDLED;
  });
  admin('POST', '/api/admin/restore', (req) => {
    const { name } = v.object({ name: v.string({ min: 1, max: 200 }) })(req.body);
    return restoreFrom(ctx, backupPath(ctx, name));
  });
  admin('POST', '/api/admin/restore/upload', (req) => {
    if (!req.upload) throw new HttpError(400, 'bad_request', 'Choose a backup file (.db) to upload.');
    return restoreFrom(ctx, req.upload.path);
  });
  admin('POST', '/api/admin/archive-old', (req, user) => {
    const { days } = v.object({ days: v.int({ min: 1, max: 3650 }) })(req.body);
    return archiveOld(ctx, user, days);
  });
  admin('GET', '/api/admin/tags', () => ({ tags: listTags(ctx) }));
  admin('PATCH', '/api/admin/tags/:id', (req) => renameTag(ctx, id(req), v.object({ name: v.string({ min: 1, max: 40 }) })(req.body).name));
  admin('DELETE', '/api/admin/tags/:id', (req) => deleteTag(ctx, id(req)));

  // ---- server ----
  const sseConnections = new Set<import('node:http').ServerResponse>();
  const handleRequest = async (raw: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    const started = Date.now();
    let status = 500;
    let req: Request | undefined;
    try {
      const url = raw.url ?? '/';
      if (!url.startsWith('/api/')) {
        if ((raw.method === 'GET' || raw.method === 'HEAD') && opts.webRoot && serveStatic(opts.webRoot, raw, res, url.split('?')[0])) {
          status = 200;
          return;
        }
        status = 404;
        return send(res, 404, { error: 'not_found', message: 'Not found' });
      }
      req = buildRequestHead(raw, res);
      const m = router.match(req.method, req.path);
      if (m === null) throw new HttpError(404, 'not_found', `No API route for ${req.method} ${req.path}`);
      if (m === 'method') throw new HttpError(405, 'method_not_allowed', `${req.method} is not allowed here`);
      req.params = m.params;
      if (req.path === '/api/admin/restore/upload') {
        requireAdmin(req); // before reading any bytes or sending 100 Continue
        checkUploadHeaders(req, uploadMaxBytes);
        if (raw.headers.expect?.toLowerCase() === '100-continue') res.writeContinue();
        await streamUpload(req, dirname(ctx.dbPath), uploadMaxBytes);
      } else if (req.path === '/api/review/uploads' && req.method === 'POST') {
        const who = currentUser(req); // before reading any bytes
        if (!who) throw new HttpError(401, 'unauthenticated', 'Please sign in first.');
        if (who.role !== 'engineer') throw forbidden('Only engineers attach drawings and signed scans for board review.');
        checkUploadHeaders(req, reviewMaxBytes, 'a PDF file');
        if (raw.headers.expect?.toLowerCase() === '100-continue') res.writeContinue();
        await streamPdfUpload(req, storeDir(ctx), reviewMaxBytes);
      } else {
        if (raw.headers.expect?.toLowerCase() === '100-continue') res.writeContinue();
        await readRequestBody(req);
      }
      let result: unknown;
      try {
        result = await m.route.handler(req);
        ctx.events.flush();
      } catch (e) {
        ctx.events.discard();
        throw e;
      }
      if (result === HANDLED) {
        status = 200;
        return;
      }
      const reply = result instanceof Reply ? result : new Reply(200, result);
      status = reply.status;
      send(res, reply.status, reply.body, reply.headers);
    } catch (err) {
      if (raw.aborted || res.destroyed) { status = 499; return; }
      const reply = errorToReply(err);
      status = reply.status;
      // Header-only rejections and interrupted streams must not leave unread bodies
      // on a reusable connection. Flush the error response, then close the socket.
      if (!raw.complete) res.shouldKeepAlive = false;
      send(res, reply.status, reply.body, reply.headers);
    } finally {
      if (req?.upload) rmSync(req.upload.dir, { recursive: true, force: true });
      if (opts.log && raw.url?.startsWith('/api/') && raw.url !== '/api/events')
        console.log(`${new Date().toISOString()} ${raw.method} ${raw.url} ${status} ${Date.now() - started}ms`);
    }
  };
  const server = createServer((raw, res) => { void handleRequest(raw, res); });
  // Without this listener node:http sends 100 Continue before our authorization check.
  server.on('checkContinue', (raw, res) => { void handleRequest(raw, res); });
  server.keepAliveTimeout = 65_000;

  return {
    ctx,
    server,
    routes: router.list(),
    listen(port, host = '0.0.0.0') {
      return new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const addr = server.address();
          resolveListen(typeof addr === 'object' && addr ? addr.port : port);
        });
      });
    },
    close() {
      // safe to call more than once (Ctrl+C twice, or a test closing a board that is already closed)
      closing ??= new Promise((resolveClose) => {
        for (const res of sseConnections) res.end();
        for (const t of timers) clearTimeout(t);
        const done = () => {
          if (ctx.db.isOpen) ctx.db.close();
          resolveClose();
        };
        // let project-folder copies in progress finish (bounded), then close
        const settled = Promise.race([settleSyncs(), new Promise((r) => setTimeout(r, 5000))]);
        void settled.then(() => {
          if (server.listening) {
            server.close(done);
            server.closeAllConnections?.();
          } else done();
        });
      });
      return closing;
    },
  };
}
