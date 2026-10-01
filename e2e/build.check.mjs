// Build check: runs the packaged board exactly as the host PC will
// (plain `node app/server.mjs` from a folder with config.json, no node_modules,
// no TypeScript) and checks what a person starting it would see.
//
//   npm run build && npm run check:build

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIST = 'dist/app';
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

function freePort() {
  return new Promise((res) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

/** Start `node app/server.mjs` in `root`. Resolves once it prints its banner (or exits). */
function start(root, { nodeArgs = [], env = {} } = {}) {
  const child = spawn(process.execPath, [...nodeArgs, join('app', 'server.mjs')], {
    cwd: root,
    // a clean environment: nothing from npm, no NODE_OPTIONS, no dev tools
    env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const p = { child, out: '', err: '', code: undefined };
  child.stdout.on('data', (d) => (p.out += d));
  child.stderr.on('data', (d) => (p.err += d));
  p.exited = new Promise((res) => child.on('exit', (code) => res((p.code = code))));
  p.ready = new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`no banner after 15s\n${p.out}\n${p.err}`)), 15000);
    const check = () => {
      if (/Keep this window open/.test(p.out)) {
        clearTimeout(t);
        res(p);
      }
    };
    child.stdout.on('data', check);
    p.exited.then(() => {
      clearTimeout(t);
      res(p);
    });
  });
  p.stop = async () => {
    if (p.code === undefined) child.kill('SIGTERM');
    return p.exited;
  };
  return p;
}

describe('packaged build', () => {
  let root;
  let port;
  let base;
  const running = [];

  before(async () => {
    assert.ok(existsSync(join(DIST, 'server.mjs')), 'run `npm run build` first');
    // lay it out like the Windows package: <root>/app/…, <root>/config.json, data next to it
    root = mkdtempSync(join(tmpdir(), 'eb-build-'));
    cpSync(DIST, join(root, 'app'), { recursive: true });
    port = await freePort();
    base = `http://127.0.0.1:${port}`;
    writeFileSync(join(root, 'config.json'), JSON.stringify({ port, host: '127.0.0.1' }, null, 2));
  });

  after(async () => {
    for (const p of running) await p.stop();
    rmSync(root, { recursive: true, force: true });
  });

  it('the server is one self-contained file that imports only Node built-ins', () => {
    const src = readFileSync(join(DIST, 'server.mjs'), 'utf8');
    const specifiers = new Set();
    for (const m of src.matchAll(/(?:^|[;\s])(?:import\s*(?:[\w*{}\s,$]+from\s*)?|export\s*[\w*{}\s,$]+from\s*)["']([^"']+)["']/gm)) specifiers.add(m[1]);
    for (const m of src.matchAll(/\b(?:require|import)\(\s*["']([^"']+)["']\s*\)/g)) specifiers.add(m[1]);
    const builtins = new Set([...builtinModules, ...builtinModules.map((b) => `node:${b}`)]);
    const foreign = [...specifiers].filter((s) => !builtins.has(s));
    assert.deepEqual(foreign, [], 'only node: built-ins at runtime (decision #1)');
    // node:sqlite must be loaded lazily, so an old node.exe gets a readable message instead of a crash
    assert.ok(![...specifiers].includes('node:sqlite'), 'no static import of node:sqlite');
    const kb = statSync(join(DIST, 'server.mjs')).size / 1024;
    assert.ok(kb < 400, `server.mjs is ${kb.toFixed(0)} KB`);
  });

  it('the web app is complete: index.html and every file it points at exist', () => {
    const html = readFileSync(join(DIST, 'web', 'index.html'), 'utf8');
    assert.ok(!html.includes('__VERSION__'), 'version stamped into index.html');
    const refs = [...html.matchAll(/(?:src|href)="\/([^"#?]+)/g)].map((m) => m[1]);
    assert.ok(refs.some((r) => r.endsWith('.js')), 'index.html loads the app script');
    for (const r of refs) assert.ok(existsSync(join(DIST, 'web', r)), `missing ${r}`);
    const sizes = readdirSync(join(DIST, 'web', 'assets')).map((f) => [f, statSync(join(DIST, 'web', 'assets', f)).size]);
    const js = sizes.filter(([f]) => f.endsWith('.js')).reduce((n, [, s]) => n + s, 0);
    assert.ok(js < 1024 * 1024, `web JS is ${(js / 1024).toFixed(0)} KB`);
  });

  it('starts with plain node, prints where to find it, and serves the board', async () => {
    const p = await start(root).ready;
    running.push(p);
    assert.equal(p.code, undefined, `exited early:\n${p.out}\n${p.err}`);
    assert.match(p.out, new RegExp(`Engineering Board v${pkg.version.replace(/\./g, '\\.')}`));
    assert.match(p.out, new RegExp(`http://localhost:${port}`));
    assert.doesNotMatch(p.out, /web app not built/);
    assert.equal(p.err.trim(), '', 'no warnings or errors on start');

    const health = await (await fetch(`${base}/api/health`)).json();
    assert.equal(health.version, pkg.version, 'APP_VERSION matches package.json');

    const page = await fetch(`${base}/board`); // a deep link: served by the SPA fallback
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/);
    const html = await page.text();
    const script = /src="(\/assets\/[^"]+\.js[^"]*)"/.exec(html)[1];
    const js = await fetch(base + script);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);

    assert.equal((await fetch(`${base}/api/tickets`)).status, 401, 'API needs a chosen user');
    assert.equal((await fetch(`${base}/api/nope`)).status, 404, 'unknown API paths are 404, not the SPA');
    assert.ok(existsSync(join(root, 'data', 'board.db')), 'data/board.db created next to app/');
  });

  it('a second copy on the same port says so and exits instead of crashing', async () => {
    const p = start(root);
    const code = await p.exited;
    assert.equal(code, 1);
    assert.match(p.err, /already in use/);
  });

  it('stops cleanly on Ctrl+C / SIGTERM and starts again on the same data', async () => {
    const first = running.pop();
    assert.equal(await first.stop(), 0);
    assert.match(first.out, /shutting down cleanly/);

    const again = await start(root).ready;
    running.push(again);
    assert.equal(again.code, undefined, again.err);
    assert.doesNotMatch(again.out, /Database upgrade/, 'no upgrade on an up-to-date database');
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal(await running.pop().stop(), 0);
  });

  it('an old node.exe gets a clear message, not a stack trace', async () => {
    const fakeOld = `data:text/javascript,Object.defineProperty(process.versions,"node",{value:"22.12.0"})`;
    const p = start(root, { nodeArgs: ['--import', fakeOld] });
    assert.equal(await p.exited, 1);
    assert.match(p.err, /version 22\.12\.0\. The board needs Node\.js 22\.16 or newer/);
    assert.doesNotMatch(p.err, /\n\s+at /, 'no stack trace');
  });

  it('a node.exe with SQLite switched off gets a clear message too', async () => {
    const p = start(root, { nodeArgs: ['--no-experimental-sqlite'] });
    assert.equal(await p.exited, 1);
    assert.match(p.err, /built-in SQLite turned off/);
  });
});
