// Build check: runs the packaged board exactly as the host PC will
// (plain `node app/server.mjs` from a folder with config.json, no node_modules,
// no TypeScript) and checks what a person starting it would see. Then checks
// the release zip itself: its layout, line endings, guides and first-run paths.
//
//   npm run check:build      (builds and packages first)

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readZip } from '../scripts/lib/zip.mjs';

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
    const scripts = [...html.matchAll(/src="(\/assets\/[^"]+\.js[^"]*)"/g)].map((m) => m[1]);
    assert.ok(scripts.some((src) => src.startsWith('/assets/app.js')), 'the application bundle is present');
    for (const script of scripts) {
      const js = await fetch(base + script);
      assert.equal(js.status, 200, `script served: ${script}`);
      assert.match(js.headers.get('content-type'), /javascript/);
    }

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

describe('release zip', () => {
  const zipPath = `dist/EngineeringBoard-${pkg.version}.zip`;
  let files;
  let root;
  let port;
  const running = [];
  const file = (n) => files.find((f) => f.name === `EngineeringBoard/${n}`);
  const text = (n) => file(n).data.toString('utf8');

  before(async () => {
    assert.ok(existsSync(zipPath), 'run `npm run package` first');
    files = readZip(readFileSync(zipPath));
    // unpack it like Windows Explorer would
    root = mkdtempSync(join(tmpdir(), 'eb-zip-'));
    for (const f of files) {
      if (f.name.endsWith('/')) continue;
      const to = join(root, f.name);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, f.data, { mode: f.mode & 0o777 });
    }
    root = join(root, 'EngineeringBoard');
    port = await freePort();
  });

  after(async () => {
    for (const p of running) await p.stop();
    rmSync(join(root, '..'), { recursive: true, force: true });
  });

  it('has everything a first install needs, under one EngineeringBoard folder', () => {
    assert.ok(files.every((f) => f.name.startsWith('EngineeringBoard/')));
    for (const n of [
      'app/server.mjs',
      'app/web/index.html',
      'app/web/guides/user-guide.html',
      'start.bat',
      'autostart-on.bat',
      'autostart-off.bat',
      'config.example.json',
      'README-FIRST.txt',
      'guides/install.html',
      'guides/user-guide.html',
      'guides/admin-guide.html',
      'guides/troubleshooting.html',
      'for-IT/allow-board-port.bat',
      'for-IT/FOR-IT.html',
      'linux/start.sh',
      'linux/engineering-board.service',
      'linux/Dockerfile',
      'linux/docker-compose.yml',
    ])
      assert.ok(file(n), `missing ${n}`);
  });

  it('ships no data, no settings and no node.exe, so unzipping an update can never overwrite them', () => {
    const bad = files.filter((f) => /\/data\/|\.db($|-)|\/config\.json$|node\.exe$|\.map$|RESET-ADMIN-PIN/i.test(f.name));
    assert.deepEqual(bad.map((f) => f.name), []);
  });

  it('Windows scripts have CRLF line endings, Linux files LF, start.sh is executable', () => {
    for (const f of files.filter((x) => /\.(bat|txt)$/.test(x.name) && !x.name.includes("/app/"))) {
      const t = f.data.toString('utf8');
      assert.ok(!/(^|[^\r])\n/.test(t), `${f.name} has a bare LF`);
      assert.ok(!/[^\x00-\x7f]/.test(t) || f.name.endsWith('.txt'), `${f.name} has non-ASCII characters cmd.exe may garble`);
    }
    for (const n of ['linux/start.sh', 'linux/Dockerfile', 'linux/engineering-board.service', 'linux/docker-compose.yml']) assert.ok(!text(n).includes('\r'), `${n} has CR`);
    assert.equal(file('linux/start.sh').mode & 0o111, 0o111);
    assert.match(text('start.bat'), /app\\server\.mjs/);
    assert.match(text('autostart-on.bat'), /start\.bat/);
    JSON.parse(text('config.example.json'));
  });

  it('every link between the guides points at a page and a heading that exist', () => {
    const guides = files.filter((f) => /\/guides\/[^/]+\.html$/.test(f.name) && f.name.includes('EngineeringBoard/guides/'));
    assert.ok(guides.length >= 5);
    const ids = new Map(guides.map((g) => [g.name.split('/').pop(), new Set([...g.data.toString().matchAll(/ id="([^"]+)"/g)].map((m) => m[1]))]));
    const broken = [];
    for (const g of guides) {
      const html = g.data.toString();
      assert.ok(!/\]\(|\.md["#]/.test(html), `${g.name} has unconverted Markdown links`);
      for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
        if (/^(https?:|mailto:)/.test(href)) continue;
        const [page, hash] = href.split('#');
        const target = page || g.name.split('/').pop();
        if (!ids.has(target)) broken.push(`${g.name}: ${href} (no such page)`);
        else if (hash && !ids.get(target).has(hash)) broken.push(`${g.name}: ${href} (no such heading)`);
      }
    }
    assert.deepEqual(broken, []);
  });

  it('starts from the unzipped folder with Linux start.sh, reads config.json, and serves the guides', async () => {
    writeFileSync(join(root, 'config.json'), '\uFEFF' + JSON.stringify({ _comment: 'saved by Notepad', port, host: '127.0.0.1' }));
    const p = spawn('sh', ['linux/start.sh'], { cwd: root, env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
    const proc = { out: '', err: '', exited: new Promise((r) => p.on('exit', r)), stop: async () => (p.kill('SIGTERM'), proc.exited) };
    p.stdout.on('data', (d) => (proc.out += d));
    p.stderr.on('data', (d) => (proc.err += d));
    running.push(proc);
    for (let i = 0; i < 100 && !/Keep this window open/.test(proc.out); i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(proc.out, /Keep this window open/, proc.err);
    assert.match(proc.out, /Settings: +.*config\.json/);
    assert.match(proc.out, /allows this PC only/, 'host 127.0.0.1 is explained in the banner');
    const g = await fetch(`http://127.0.0.1:${port}/guides/user-guide.html`);
    assert.equal(g.status, 200);
    assert.match(g.headers.get('content-type'), /text\/html/);
    assert.match(await g.text(), /<h1 id="user-guide">User guide<\/h1>/);
    assert.ok(existsSync(join(root, 'data', 'board.db')));
    await running.pop().stop();
  });

  it('a mistake in config.json stops the start with a plain explanation, not a stack trace', async () => {
    writeFileSync(join(root, 'config.json'), '{ "port": 80000, "backupDir": "D:/x", "Timezone": "x" }');
    const p = start(root);
    assert.equal(await p.exited, 1);
    assert.match(p.err, /"port" is 80000; it must be a whole number from 1 to 65535/);
    assert.doesNotMatch(p.err, /\n\s+at /);
    writeFileSync(join(root, 'config.json'), '{ "backupDir": "D:\\Board\\backups" }'.replace(/\\\\/g, '\\'));
    const q = start(root);
    assert.equal(await q.exited, 1);
    assert.match(q.err, /forward slashes/);
  });

  it('a RESET-ADMIN-PIN file next to start.bat resets a forgotten PIN once', async () => {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ port, host: '127.0.0.1' }));
    const base = `http://127.0.0.1:${port}`;
    const cookieOf = (r) => r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const post = (path, body, cookie) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });

    let p = await start(root).ready;
    running.push(p);
    const s = cookieOf(await post('/api/session/password', { user_id: 1, password: 'check-pass-1' }));
    const a = cookieOf(await post('/api/admin/unlock', { pin: '1234' }, s));
    assert.equal((await post('/api/admin/pin', { new_pin: 'forgotten-9' }, `${s}; ${a}`)).status, 200);
    await running.pop().stop();

    writeFileSync(join(root, 'RESET-ADMIN-PIN.txt'), '');
    p = await start(root).ready;
    running.push(p);
    assert.match(p.out, /admin PIN has been reset to 1234/);
    assert.ok(!existsSync(join(root, 'RESET-ADMIN-PIN.txt')), 'the file is removed so it only works once');
    assert.equal((await post('/api/admin/unlock', { pin: '1234' }, s)).status, 200);
    await running.pop().stop();
  });

  it('a RESET-PASSWORDS file next to start.bat clears every password once; people create new ones', async () => {
    writeFileSync(join(root, 'config.json'), JSON.stringify({ port, host: '127.0.0.1' }));
    const base = `http://127.0.0.1:${port}`;
    const cookieOf = (r) => r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const post = (path, body, cookie) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body) });
    const get = (path, cookie) => fetch(base + path, { headers: { cookie } });

    let p = await start(root).ready;
    running.push(p);
    // the password from the previous check still works, and the session survives a restart
    const r = await post('/api/session', { user_id: 1, password: 'check-pass-1' });
    assert.equal(r.status, 200);
    const s = cookieOf(r);
    assert.equal((await get('/api/tickets', s)).status, 200);
    await running.pop().stop();

    writeFileSync(join(root, 'RESET-PASSWORDS'), '');
    p = await start(root).ready;
    running.push(p);
    assert.match(p.out, /All passwords have been reset/);
    assert.ok(!existsSync(join(root, 'RESET-PASSWORDS')), 'the file is removed so it only works once');
    assert.equal((await get('/api/tickets', s)).status, 401, 'old sessions are signed out');
    assert.equal((await post('/api/session', { user_id: 1, password: 'check-pass-1' })).status, 409, 'the old password is gone');
    assert.equal((await post('/api/session/password', { user_id: 1, password: 'check-pass-2' })).status, 200, 'a new one is created at sign-in');
    await running.pop().stop();
  });
});
