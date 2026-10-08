// Tiny HTTP framework on node:http: routing, JSON bodies, cookies, errors,
// static files. Kept deliberately small — about what Fastify gave us, minus
// the dependency.

import { createReadStream, existsSync, statSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { ValidationError } from '@board/shared';
import { HttpError } from '../lib/core.ts';

export interface Request {
  raw: IncomingMessage;
  res: ServerResponse;
  method: string;
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
  cookies: Record<string, string>;
  body: unknown;
  rawBody: string;
  /** A streamed upload (database or PDF). Removed by the HTTP handler after use. */
  upload?: { path: string; dir: string; bytes: number; sha256?: string };
  headers: IncomingMessage['headers'];
}

export class Reply {
  constructor(
    public status: number,
    public body: unknown,
    public headers: Record<string, string | string[]> = {},
  ) {}
}
/** Returned by handlers that take over the response (SSE, downloads). */
export const HANDLED = Symbol('handled');

export type Handler<A> = (req: Request, auth: A) => unknown | Promise<unknown>;

interface Route {
  method: string;
  parts: string[];
  handler: (req: Request) => unknown | Promise<unknown>;
}

export class Router {
  private routes: Route[] = [];
  add(method: string, pattern: string, handler: (req: Request) => unknown | Promise<unknown>) {
    this.routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
  }
  /** Every registered route, e.g. for tests that sweep the whole API. */
  list(): { method: string; path: string }[] {
    return this.routes.map((r) => ({ method: r.method, path: '/' + r.parts.join('/') }));
  }
  match(method: string, path: string): { route: Route; params: Record<string, string> } | 'method' | null {
    const segs = path.split('/').filter(Boolean);
    let methodMismatch = false;
    for (const route of this.routes) {
      if (route.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const p = route.parts[i];
        if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(segs[i]);
        else if (p !== segs[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (route.method !== method) {
        methodMismatch = true;
        continue;
      }
      return { route, params };
    }
    return methodMismatch ? 'method' : null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore malformed cookie */
    }
  }
  return out;
}

export function cookie(name: string, value: string, opts: { maxAge?: number; httpOnly?: boolean } = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Strict'];
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join('; ');
}

const MAX_BODY = 20 * 1024 * 1024; // JSON and CSV
export const DEFAULT_RESTORE_UPLOAD_MAX_MB = 64;

function readBody(req: IncomingMessage, limit = MAX_BODY): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    const tooLarge = () => new HttpError(413, 'too_large', `That file is too large (limit ${Math.round(limit / 1048576)} MB).`);
    // Past the limit, keep reading and throw the rest away, so the browser gets the
    // "too large" answer instead of a dropped connection. Only cut the connection if
    // the sender goes on far beyond the limit.
    const hardStop = limit * 2;
    let size = 0;
    let over = false;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > hardStop) {
        reject(tooLarge());
        req.destroy();
        return;
      }
      if (size > limit) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => (over ? reject(tooLarge()) : resolveBody(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}) {
  if (res.headersSent) return;
  const isText = typeof body === 'string';
  const payload = body === undefined ? '' : isText ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(payload);
}

export function errorToReply(err: unknown): Reply {
  if (err instanceof HttpError) return new Reply(err.status, { error: err.code, message: err.message, ...err.extra });
  if (err instanceof ValidationError) {
    return new Reply(400, { error: 'validation', message: `Please check: ${err.message}`, details: err.issues });
  }
  if (err instanceof SyntaxError) return new Reply(400, { error: 'bad_json', message: 'Request body is not valid JSON' });
  const msg = err instanceof Error ? err.message : String(err);
  if (/SQLITE_BUSY|database is locked/i.test(msg)) {
    return new Reply(503, { error: 'busy', message: 'The database is busy. Please try again in a moment.' });
  }
  if (/append-only|cannot be deleted/.test(msg)) return new Reply(409, { error: 'immutable', message: msg });
  console.error('[error]', err);
  return new Reply(500, { error: 'internal', message: 'Something went wrong on the server. Nothing was saved. Please try again.' });
}

/** Parse only headers/URL. Route and authorization checks happen before body reads. */
export function buildRequestHead(raw: IncomingMessage, res: ServerResponse): Request {
  const url = new URL(raw.url ?? '/', 'http://localhost');
  return {
    raw, res, method: (raw.method ?? 'GET').toUpperCase(), path: url.pathname,
    params: {}, query: url.searchParams, cookies: parseCookies(raw.headers.cookie),
    body: undefined, rawBody: '', headers: raw.headers,
  };
}

export async function readRequestBody(req: Request): Promise<void> {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const ct = String(req.headers['content-type'] ?? '');
  if (ct.startsWith('application/octet-stream'))
    throw new HttpError(415, 'unsupported_media_type', 'Send JSON (Content-Type: application/json)');
  req.rawBody = (await readBody(req.raw)).toString('utf8');
  if (!req.rawBody.length) return;
  if (ct.includes('application/json')) req.body = JSON.parse(req.rawBody);
  else if (!ct.startsWith('text/'))
    throw new HttpError(415, 'unsupported_media_type', 'Send JSON (Content-Type: application/json)');
}

/** Header checks also run before an Expect: 100-continue response or creating a file. */
export function checkUploadHeaders(req: Request, maxBytes: number, what = 'a backup file (.db)'): void {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/octet-stream' && !(what.includes('PDF') && type === 'application/pdf'))
    throw new HttpError(415, 'unsupported_media_type', `Send ${what} (Content-Type: application/octet-stream).`);
  const length = req.headers['content-length'];
  if (length !== undefined) {
    const n = Number(length);
    if (!/^\d+$/.test(length) || !Number.isSafeInteger(n))
      throw new HttpError(400, 'bad_request', 'Invalid upload size.');
    if (n > maxBytes) throw uploadTooLarge(maxBytes);
    if (n === 0) throw new HttpError(400, 'bad_request', `Choose ${what} to upload.`);
  }
}

const uploadTooLarge = (maxBytes: number) => new HttpError(413, 'too_large',
  `That file is too large (limit ${maxBytes / 1048576} MB).`);

/** Stream with backpressure to a private, unique directory on the database disk. */
export async function streamUpload(req: Request, dataDir: string, maxBytes: number): Promise<void> {
  checkUploadHeaders(req, maxBytes);
  const dir = mkdtempSync(join(dataDir, '.restore-upload-'));
  const path = join(dir, 'candidate.db');
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let bytes = 0;
  let header = Buffer.alloc(0);
  try {
    file = await open(path, 'wx', 0o600);
    // A limit rejection must leave the socket alive long enough to return a readable 413.
    // The HTTP handler closes the connection after sending the error; no unbounded drain.
    for await (const chunk of req.raw.iterator({ destroyOnReturn: false })) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.length;
      if (bytes > maxBytes) throw uploadTooLarge(maxBytes);
      if (header.length < 16) header = Buffer.concat([header, data.subarray(0, 16 - header.length)]);
      if (header.length === 16 && header.toString('latin1') !== 'SQLite format 3\u0000')
        throw new HttpError(400, 'bad_request', "That file isn't a board backup. Choose a .db file made by the board's backup.");
      let written = 0;
      while (written < data.length) {
        const part = await file.write(data, written, data.length - written);
        if (!part.bytesWritten) throw new Error('The upload could not be written to disk.');
        written += part.bytesWritten;
      }
    }
    if (header.length < 16)
      throw new HttpError(400, 'bad_request', bytes ? "That file isn't a board backup." : 'Choose a backup file (.db) to upload.');
    await file.close();
    file = undefined;
    req.upload = { path, dir, bytes };
  } catch (e) {
    await file?.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/**
 * Stream a PDF upload to a private folder while hashing it (SHA-256), so the
 * exact bytes received are what the board stores and reviews.
 */
export async function streamPdfUpload(req: Request, storeDir: string, maxBytes: number): Promise<void> {
  checkUploadHeaders(req, maxBytes, 'a PDF file');
  mkdirSync(storeDir, { recursive: true });
  const dir = mkdtempSync(join(storeDir, '.incoming-'));
  const path = join(dir, 'upload.pdf');
  const hash = createHash('sha256');
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let bytes = 0;
  let header = Buffer.alloc(0);
  try {
    file = await open(path, 'wx', 0o600);
    for await (const chunk of req.raw.iterator({ destroyOnReturn: false })) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.length;
      if (bytes > maxBytes) throw uploadTooLarge(maxBytes);
      if (header.length < 1024) header = Buffer.concat([header, data.subarray(0, 1024 - header.length)]);
      hash.update(data);
      let written = 0;
      while (written < data.length) {
        const part = await file.write(data, written, data.length - written);
        if (!part.bytesWritten) throw new Error('The upload could not be written to disk.');
        written += part.bytesWritten;
      }
    }
    if (!bytes) throw new HttpError(400, 'bad_request', 'Choose a PDF file to upload.');
    if (!header.includes('%PDF-')) throw new HttpError(400, 'not_pdf', "That file isn't a PDF. Attach the drawing as a PDF.");
    await file.sync();
    await file.close();
    file = undefined;
    req.upload = { path, dir, bytes, sha256: hash.digest('hex') };
  } catch (e) {
    await file?.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** Stream any file to a private directory under `dir`, keeping the given file name. Nothing is checked but the size. */
export async function streamFileUpload(req: Request, dir: string, filename: string, maxBytes: number, what: string): Promise<void> {
  checkUploadHeaders(req, maxBytes, what);
  const path = join(dir, filename);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let bytes = 0;
  try {
    file = await open(path, 'wx', 0o600);
    for await (const chunk of req.raw.iterator({ destroyOnReturn: false })) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.length;
      if (bytes > maxBytes) throw uploadTooLarge(maxBytes);
      let written = 0;
      while (written < data.length) {
        const part = await file.write(data, written, data.length - written);
        if (!part.bytesWritten) throw new Error('The upload could not be written to disk.');
        written += part.bytesWritten;
      }
    }
    if (!bytes) throw new HttpError(400, 'bad_request', `Choose ${what} to upload.`);
    await file.sync();
    await file.close();
    file = undefined;
    req.upload = { path, dir, bytes };
  } catch (e) {
    await file?.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  // the bundled PDF viewer (decision #23)
  '.wasm': 'application/wasm',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.bcmap': 'application/octet-stream',
  '.icc': 'application/vnd.iccprofile',
};

export function serveStatic(root: string, raw: IncomingMessage, res: ServerResponse, path: string): boolean {
  if (!existsSync(root)) return false;
  const base = resolve(root);
  let file = normalize(join(base, decodeURIComponent(path)));
  if (!file.startsWith(base + sep) && file !== base) return false; // path traversal
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (extname(path)) return false; // missing asset → 404
    file = join(base, 'index.html'); // SPA route
    if (!existsSync(file)) return false;
  }
  const isHtml = file.endsWith('.html');
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': isHtml ? 'no-cache' : 'public, max-age=31536000, immutable',
    ...(isHtml
      ? {
          // 'wasm-unsafe-eval' lets the bundled PDF viewer compile its image decoders
          // (JBIG2, JPEG 2000) for scanned drawings; it does not allow JavaScript eval.
          'Content-Security-Policy':
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'",
        }
      : {}),
  });
  if (raw.method === 'HEAD') res.end();
  else createReadStream(file).pipe(res);
  return true;
}
