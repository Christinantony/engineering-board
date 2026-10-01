import { createServer, type Server } from 'node:http';
import { STATUSES, PRIORITIES, ESTIMATE_BUCKETS, STATUS_LABEL, type User } from '@board/shared';
import { v } from '@board/shared';
import { openDb, migrate, pendingMigrations, run, all } from './db/connection.ts';
import { createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { seedBase, seedDemo, clearDemo, hasDemoData } from './db/seed.ts';
import { EventHub, HttpError, forbidden, type Ctx } from './lib/core.ts';
import { localDate } from './lib/time.ts';
import {
  HANDLED,
  Reply,
  Router,
  buildRequest,
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
  ensureAuthSettings,
  resetPin,
  pinIsDefault,
  readAdmin,
  readSession,
  sessionCookie,
  verifyPin,
} from './domain/auth.ts';
import { createUser, getUser, listUsers, updateUser } from './domain/users.ts';
import { createJobType, listJobTypes, updateJobType } from './domain/jobTypes.ts';
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
  stageUpload,
  type BackupCtx,
} from './domain/backup.ts';
import { archiveOld, commitImport, deleteTag, exportCsv, exportJson, importTemplate, listTags, previewImport, renameTag } from './domain/transfer.ts';
import { rmSync } from 'node:fs';

export const APP_VERSION = '1.0.0';

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
  /** Where backups go (default: a "backups" folder next to the database). */
  backupDir?: string;
  backupKeepDays?: number;
  /** Take the daily backup automatically (off in tests). */
  autoBackup?: boolean;
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
    seedBase(ctx);
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

  const presence = new Presence(ctx.events, () => ctx.now().getTime());
  const router = new Router();
  const id = (req: Request) => v.int({ min: 1 })(req.params.id, 'id');

  // ---- auth wrappers ----
  function currentUser(req: Request): User | null {
    const uid = readSession(ctx, req.cookies[SESSION_COOKIE]);
    if (!uid) return null;
    const u = getUser(ctx, uid);
    return u && u.active ? u : null;
  }
  const pub = (method: string, path: string, h: (req: Request) => unknown) => router.add(method, path, h);
  const authed = (method: string, path: string, h: (req: Request, user: User) => unknown) =>
    router.add(method, path, (req) => {
      const user = currentUser(req);
      if (!user) throw new HttpError(401, 'unauthenticated', 'Please choose who you are first.');
      return h(req, user);
    });
  const admin = (method: string, path: string, h: (req: Request, user: User) => unknown) =>
    authed(method, path, (req, user) => {
      if (!readAdmin(ctx, req.cookies[ADMIN_COOKIE], user.id)) throw new HttpError(403, 'admin_locked', 'Unlock the admin area with the PIN first.');
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
  }));
  pub('GET', '/api/users', (req) => ({ users: listUsers(ctx, req.query.get('all') === '1') }));
  pub('GET', '/api/session', (req) => ({ user: currentUser(req) }));
  pub('POST', '/api/session', (req) => {
    const { user_id } = v.object({ user_id: v.int({ min: 1 }) })(req.body);
    const u = getUser(ctx, user_id);
    if (!u || !u.active) throw new HttpError(400, 'bad_user', 'That user is not available.');
    return new Reply(200, { user: u }, { 'Set-Cookie': cookie(SESSION_COOKIE, sessionCookie(ctx, u.id), { maxAge: ONE_YEAR }) });
  });
  pub('DELETE', '/api/session', () =>
    new Reply(200, { ok: true }, { 'Set-Cookie': [cookie(SESSION_COOKIE, '', { maxAge: 0 }), cookie(ADMIN_COOKIE, '', { maxAge: 0 })] }),
  );

  // ---- reference data ----
  authed('GET', '/api/job-types', () => ({ job_types: listJobTypes(ctx) }));
  authed('GET', '/api/tags', () => ({
    tags: all<{ name: string; count: number }>(
      ctx.db,
      'SELECT g.name, COUNT(tt.ticket_id) count FROM tags g LEFT JOIN ticket_tags tt ON tt.tag_id = g.id GROUP BY g.id ORDER BY count DESC, g.name',
    ),
  }));

  // ---- tickets ----
  authed('GET', '/api/tickets', (req) => listTickets(ctx, parseFilters(req.query)));
  authed('POST', '/api/tickets', (req, user) => {
    const key = req.headers['idempotency-key'];
    const k = typeof key === 'string' && key.length >= 8 && key.length <= 100 ? key : undefined;
    const { ticket, replayed } = createTicket(ctx, user, req.body ?? {}, k);
    return new Reply(replayed ? 200 : 201, { ticket, replayed });
  });
  authed('GET', '/api/tickets/:id', (req) => ({ ticket: getTicket(ctx, id(req)), activity: ticketActivity(ctx, id(req)) }));
  authed('PATCH', '/api/tickets/:id', (req, user) => ({ ticket: updateTicket(ctx, user, id(req), req.body ?? {}) }));
  authed('POST', '/api/tickets/:id/move', (req, user) => ({ ticket: moveTicket(ctx, user, id(req), req.body ?? {}) }));
  authed('POST', '/api/tickets/:id/claim', (req, user) => ({ ticket: claimTicket(ctx, user, id(req)) }));
  authed('POST', '/api/tickets/:id/release', (req, user) => ({ ticket: releaseTicket(ctx, user, id(req)) }));
  authed('POST', '/api/tickets/:id/my-rank', (req, user) => ({ ticket: setMyRank(ctx, user, id(req), req.body ?? {}) }));
  authed('POST', '/api/tickets/:id/comments', (req, user) => new Reply(201, { activity: addComment(ctx, user, id(req), req.body ?? {}) }));
  authed('POST', '/api/tickets/:id/archive', (req, user) => ({ ticket: archiveTicket(ctx, user, id(req)) }));
  authed('POST', '/api/tickets/:id/restore', (req, user) => ({ ticket: restoreTicket(ctx, user, id(req)) }));
  authed('GET', '/api/tickets/:id/activity', (req) => ({ activity: ticketActivity(ctx, id(req)) }));

  // ---- views ----
  authed('GET', '/api/activity', (req) => {
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
  authed('GET', '/api/presence', () => ({ online: presence.snapshot() }));
  authed('POST', '/api/presence', (req, user) => {
    const { job_id, tab } = v.object({
      job_id: v.nullable(v.int({ min: 1 })),
      tab: v.string({ min: 1, max: 64 }),
    })(req.body);
    presence.view(user.id, tab, job_id);
    return { ok: true };
  });
  authed('GET', '/api/dashboard', () => dashboard(ctx));
  authed('GET', '/api/today', () => todayView(ctx));
  authed('GET', '/api/my-work', (req, user) => {
    const uid = req.query.get('user') ? v.int({ min: 1 })(req.query.get('user'), 'user') : user.id;
    return myWork(ctx, uid);
  });
  authed('GET', '/api/reports', (req) => {
    const today = localDate(ctx.now().getTime(), ctx.tz);
    return report(ctx, req.query.get('from') ?? today, req.query.get('to') ?? today);
  });
  authed('GET', '/api/workload', (req) => workload(ctx, (req.query.get('horizon') ?? 'today') as Horizon));

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
    const unsubscribe = ctx.events.subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
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
  authed('GET', '/api/admin/status', (req, user) => ({
    unlocked: readAdmin(ctx, req.cookies[ADMIN_COOKIE], user.id),
    pin_is_default: pinIsDefault(ctx),
  }));
  authed('POST', '/api/admin/unlock', (req, user) => {
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
  authed('GET', '/api/export/tickets.csv', (req) =>
    new Reply(200, exportCsv(ctx, parseFilters(req.query)), attach(`engineering-board-jobs-${today()}.csv`, 'text/csv; charset=utf-8')),
  );
  authed('GET', '/api/export/tickets.json', (req) =>
    new Reply(200, exportJson(ctx, { activity: req.query.get('activity') !== '0' }), attach(`engineering-board-${today()}.json`, 'application/json; charset=utf-8')),
  );
  authed('GET', '/api/import/template.csv', () => new Reply(200, importTemplate(), attach('engineering-board-import-template.csv', 'text/csv; charset=utf-8')));
  const importOpts = (req: Request) => ({
    date_order: req.query.get('date_order') === 'MDY' ? ('MDY' as const) : ('DMY' as const),
    create_job_types: req.query.get('create_job_types') !== '0',
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
    if (!req.binary?.length) throw new HttpError(400, 'bad_request', 'Choose a backup file (.db) to upload.');
    if (req.binary.subarray(0, 16).toString('latin1') !== 'SQLite format 3\u0000')
      throw new HttpError(400, 'bad_request', "That file isn't a board backup. Choose a .db file made by the board's backup.");
    const staged = stageUpload(ctx, req.binary);
    try {
      return restoreFrom(ctx, staged);
    } finally {
      rmSync(staged, { force: true });
    }
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
  const server = createServer(async (raw, res) => {
    const started = Date.now();
    let status = 500;
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
      const req = await buildRequest(raw, res);
      const m = router.match(req.method, req.path);
      if (m === null) throw new HttpError(404, 'not_found', `No API route for ${req.method} ${req.path}`);
      if (m === 'method') throw new HttpError(405, 'method_not_allowed', `${req.method} is not allowed here`);
      req.params = m.params;
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
      const reply = errorToReply(err);
      status = reply.status;
      send(res, reply.status, reply.body, reply.headers);
    } finally {
      if (opts.log && raw.url?.startsWith('/api/') && raw.url !== '/api/events')
        console.log(`${new Date().toISOString()} ${raw.method} ${raw.url} ${status} ${Date.now() - started}ms`);
    }
  });
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
        if (server.listening) {
          server.close(done);
          server.closeAllConnections?.();
        } else done();
      });
      return closing;
    },
  };
}
