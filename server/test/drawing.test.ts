// Drawing tools (decision #46): the team's drawing_to_dcl.py, run unchanged
// with the host's Python.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp, type App } from '../src/app.ts';
import { cleanPdfName, dclArgs, dclOptions, logoType, probeDcl, pythonCandidates, runPython, type PythonRunner } from '../src/domain/drawingDcl.ts';
import { HttpError } from '../src/lib/core.ts';
// @ts-expect-error a plain .mjs helper without types
import { readZip } from '../../scripts/lib/zip.mjs';
import { Client, signIn } from './helpers.ts';

const TOOLS = resolve('tools');
// Christin's drawing_to_dcl_01.py as she sent it on 31 October 2026
// with her changes of 31 October 2026: the project from the drawing number, and the Prepared by / Verified by levels
const ORIGINAL_SHA256 = 'f47063e429d8e753f14d4ed8fa24f37354ba645e71daf4c1ef6e2330c1dba6cc';

const cookie = (c: Client) => [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
const upload = (base: string, c: Client, query: string, body: Uint8Array | string, type = 'application/pdf') =>
  fetch(`${base}/api/tools/drawing-to-dcl?${query}`, { method: 'POST', headers: { 'content-type': type, cookie: cookie(c) }, body: typeof body === 'string' ? body : new Uint8Array(body) });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);

describe('drawing tools: the dimension checklist script', () => {
  it('ships the script exactly as Christin wrote it', () => {
    const bytes = readFileSync(join(TOOLS, 'drawing_to_dcl.py'));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), ORIGINAL_SHA256, 'tools/drawing_to_dcl.py must not be edited: the board runs it as it is');
  });

  it('passes the options as the script\'s own arguments, checked the way its argparse checks them', () => {
    const o = dclOptions(new URLSearchParams({ format: 'both', project: '  ISRO ', part_no: '-JL 18', weight: '1822 ± 10 g', samples: '12', ocr: '1', rotate: '90' }));
    assert.deepEqual(o, { format: 'both', project: 'ISRO', part_no: '-JL 18', weight: '1822 ± 10 g', samples: 12, ocr: true, rotate: '90' });
    // --name=value, so a value starting with "-" is never read as an option
    assert.deepEqual(dclArgs('/app/tools/drawing_to_dcl.py', 'BRK-023.pdf', o, '/data/tools/dcl-logo.png'), [
      '/app/tools/drawing_to_dcl.py',
      'BRK-023.pdf',
      '--format=both',
      '--project=ISRO',
      '--samples=12',
      '--part-no=-JL 18',
      '--weight=1822 ± 10 g',
      '--logo=/data/tools/dcl-logo.png',
      '--ocr',
      '--rotate=90',
    ]);
    // the defaults are the script's: Word, the project from the drawing number, 10 SL № columns, no OCR, rotation detected
    const d = dclOptions(new URLSearchParams());
    assert.deepEqual(dclArgs('s.py', 'a.pdf', d, null), ['s.py', 'a.pdf', '--format=docx', '--samples=10']);
    assert.throws(() => dclOptions(new URLSearchParams({ samples: '7' })), /8 to 20/);
    assert.throws(() => dclOptions(new URLSearchParams({ samples: '21' })), /8 to 20/);
    assert.throws(() => dclOptions(new URLSearchParams({ format: 'pdf' })), /Word, Excel or both/);
    assert.throws(() => dclOptions(new URLSearchParams({ rotate: '45' })), /0, 90, 180 or 270/);
    assert.equal(cleanPdfName(' --Spec/2026:v1.PDF '), 'Spec_2026_v1.PDF');
    assert.throws(() => cleanPdfName('a.docx'), /drawing PDF/);
    assert.equal(logoType(PNG), 'png');
    assert.equal(logoType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'jpg');
    assert.equal(logoType(Buffer.from('GIF89a')), null);
  });

  it('finds the host\'s Python: the configured one, else py -3.14 as the script asks, then others', async () => {
    assert.deepEqual(pythonCandidates(undefined, 'win32'), [['py', '-3.14'], ['py', '-3'], ['python']]);
    assert.deepEqual(pythonCandidates(undefined, 'linux'), [['python3'], ['python']]);
    assert.deepEqual(pythonCandidates('C:/Program Files/Python314/python.exe', 'win32'), [['C:/Program Files/Python314/python.exe']]);
    const tried: string[] = [];
    const fake =
      (answers: Record<string, string | null>): PythonRunner =>
      async (cmd) => {
        tried.push(cmd.join(' '));
        const a = answers[cmd.join(' ')];
        if (a == null) throw new Error('not found');
        return { stdout: a, stderr: '' };
      };
    // py -3.14 is missing; py -3 runs but lacks python-docx; python has everything
    let s = await probeDcl(pythonCandidates(undefined, 'win32'), 'x.py', fake({ 'py -3': '3.12.1\npython-docx\nrapidocr,onnxruntime\nno', python: '3.13.2\n\n\nyes' }));
    assert.deepEqual(tried, ['py -3.14', 'py -3', 'python']);
    assert.equal(s.state, 'ready');
    assert.equal(s.command, 'python');
    assert.equal(s.pillow, true);
    s = await probeDcl([['py', '-3']], 'x.py', fake({ 'py -3': '3.12.1\npython-docx\nrapidocr,onnxruntime\nno' }));
    assert.deepEqual([s.state, s.missing, s.ocr_missing], ['missing_packages', ['python-docx'], ['rapidocr', 'onnxruntime']]);
    assert.equal((await probeDcl([['nope']], 'x.py', fake({}))).state, 'no_python');
    assert.equal((await probeDcl([['python']], null, fake({ python: '3.14.0\n\n\nyes' }))).state, 'no_script');
    // a path with spaces stays one argument
    s = await probeDcl([['C:/Program Files/Python314/python.exe']], 'x.py', fake({ 'C:/Program Files/Python314/python.exe': '3.14.0\n\n\nyes' }));
    assert.deepEqual([s.command, s.argv], ['"C:/Program Files/Python314/python.exe"', ['C:/Program Files/Python314/python.exe']]);
  });
});

describe('drawing tools on the board', () => {
  let dir: string;
  let app: App;
  let base: string;
  let paul: Client;
  let admin: Client;
  let ready = true;
  let pillow = true;
  const calls: { cmd: string[]; args: string[]; cwd: string }[] = [];
  // stands in for Python: the probe answers as configured; a run writes what the script would, next to the drawing
  const runner: PythonRunner = async (cmd, args, { cwd }) => {
    if (args[0] === '-c') return { stdout: ready ? `3.14.0\n\nrapidocr,onnxruntime\n${pillow ? 'yes' : 'no'}` : '3.14.0\npymupdf,openpyxl\n\nno', stderr: '' };
    calls.push({ cmd, args, cwd });
    const stem = args[1].replace(/\.pdf$/i, '');
    const format = args.find((a) => a.startsWith('--format='))!.split('=')[1];
    if (stem === 'broken') throw new HttpError(500, 'dcl_failed', "Missing dependency 'pymupdf'.");
    for (const ext of format === 'both' ? ['docx', 'xlsx'] : [format]) writeFileSync(join(cwd, `${stem}.${ext}`), `${ext} for ${stem}`);
    return { stdout: `${args[1]}\n  title: BRACKET   drawing: VT-JD 123-01 REV.02   material: AL 6061\n   a.   E7   25.0           ±0.1\n        D3   VERIFY 4X M6x1.0 THRU\n   not used [C7]: (10)  (reference dimension)\n  -> ${stem}.${format}\n`, stderr: '' };
  };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'eb-dcl-'));
    app = createApp({ dbPath: join(dir, 'board.db'), toolScriptDirs: [TOOLS], python: ['py', '-3.14'], pythonRunner: runner });
    base = `http://127.0.0.1:${await app.listen(0, '127.0.0.1')}`;
    paul = new Client(base);
    await signIn(paul, 2);
    admin = new Client(base);
    await signIn(admin, 1);
    await admin.post('/api/admin/unlock', { pin: '1234' });
  });
  after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs the script on the uploaded drawing and sends back the checklist and what the script read', async () => {
    const st = (await paul.get('/api/tools/drawing/status')).body;
    assert.deepEqual([st.state, st.command, st.version, st.ocr_missing, st.logo], ['ready', 'py -3.14', '3.14.0', ['rapidocr', 'onnxruntime'], false]);
    const res = await upload(base, paul, 'name=VT-JD 123-01.pdf&format=both&project=Spiral&weight=180 g', '%PDF-1.4 drawing');
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    assert.deepEqual(
      body.files.map((f: any) => [f.name, Buffer.from(f.data, 'base64').toString()]),
      [
        ['VT-JD 123-01.docx', 'docx for VT-JD 123-01'],
        ['VT-JD 123-01.xlsx', 'xlsx for VT-JD 123-01'],
      ],
    );
    assert.match(body.report, /VERIFY 4X M6x1.0 THRU/);
    const call = calls.at(-1)!;
    assert.deepEqual(call.cmd, ['py', '-3.14']);
    assert.match(call.args[0], /tools[\\/]drawing_to_dcl\.py$/);
    assert.deepEqual(call.args.slice(1), ['VT-JD 123-01.pdf', '--format=both', '--project=Spiral', '--samples=10', '--weight=180 g']);
    // the drawing and the checklist are deleted afterwards
    assert.equal(readdir(join(dir, 'tmp')).filter((f) => f.startsWith('dcl-')).length, 0);
  });

  it('refuses what the script would refuse before the upload, and is not for reviewers', async () => {
    assert.equal((await upload(base, paul, 'name=a.pdf&samples=30', 'x')).status, 400);
    assert.equal((await upload(base, paul, 'name=a.dwg', 'x')).status, 400);
    assert.equal((await upload(base, paul, 'name=a.pdf', '')).status, 400);
    await admin.post('/api/admin/users', { name: 'Ebin', role: 'reviewer' });
    const users = (await admin.get('/api/users')).body.users as { id: number; name: string }[];
    const ebin = new Client(base);
    await signIn(ebin, users.find((u) => u.name === 'Ebin')!.id);
    assert.equal((await ebin.get('/api/tools/drawing/status')).status, 403);
    assert.equal((await upload(base, ebin, 'name=a.pdf', 'x')).status, 403);
  });

  it('says what went wrong when the script stops, and what to install when Python lacks a package', async () => {
    const res = await upload(base, paul, 'name=broken.pdf', 'x');
    assert.equal(res.status, 500);
    ready = false;
    const st = (await paul.post('/api/tools/drawing/status')).body;
    assert.deepEqual([st.state, st.missing], ['missing_packages', ['pymupdf', 'openpyxl']]);
    const r = await upload(base, paul, 'name=a.pdf', 'x');
    assert.equal(r.status, 501);
    assert.match((await r.json()).message, /lacks pymupdf, openpyxl/);
    ready = true;
    await paul.post('/api/tools/drawing/status');
  });

  it('puts the admin\'s logo in the footer, and leaves it out of Excel when Pillow is missing', async () => {
    const put = (c: Client, body: Uint8Array) =>
      fetch(`${base}/api/admin/tools/dcl-logo`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream', cookie: cookie(c) }, body: new Uint8Array(body) });
    assert.equal((await put(paul, PNG)).status, 403, 'only the admin');
    assert.equal((await put(admin, Buffer.from('GIF89a not a png'))).status, 400);
    assert.equal((await put(admin, PNG)).status, 200);
    assert.equal((await paul.get('/api/tools/drawing/status')).body.logo, true);
    const got = await fetch(`${base}/api/admin/tools/dcl-logo`, { headers: { cookie: cookie(admin) } });
    assert.equal(got.headers.get('content-type'), 'image/png');
    await (await upload(base, paul, 'name=a.pdf&format=xlsx', 'x')).json();
    assert.match(calls.at(-1)!.args.find((a) => a.startsWith('--logo='))!, /tools[\\/]dcl-logo\.png$/);
    pillow = false;
    await paul.post('/api/tools/drawing/status');
    const r = await (await upload(base, paul, 'name=a.pdf&format=xlsx', 'x')).json();
    assert.equal(r.logo_left_out, true);
    assert.ok(!calls.at(-1)!.args.some((a) => a.startsWith('--logo')));
    // Word needs no Pillow
    await (await upload(base, paul, 'name=a.pdf&format=docx', 'x')).json();
    assert.ok(calls.at(-1)!.args.some((a) => a.startsWith('--logo')));
    pillow = true;
    assert.equal((await admin.del('/api/admin/tools/dcl-logo')).status, 200);
    assert.equal((await paul.get('/api/tools/drawing/status')).body.logo, false);
  });
});

const readdir = (p: string): string[] => (existsSync(p) ? readdirSync(p) : []);

// With Python and the script's packages on this machine, the real script runs on a drawing made here.
const realPython = (() => {
  for (const cmd of [['python3'], ['python']]) {
    try {
      execFileSync(cmd[0], ['-c', 'import pymupdf, openpyxl, docx'], { stdio: 'ignore' });
      return cmd;
    } catch {
      /* next */
    }
  }
  return null;
})();

describe('drawing tools with the real script', { skip: realPython ? false : 'Python with pymupdf, openpyxl and python-docx is not installed here' }, () => {
  it('makes the Word and Excel checklist of a vector drawing, reading its title block and dimensions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'eb-dcl-real-'));
    try {
      const pdf = join(dir, 'drawing.pdf');
      execFileSync(realPython![0], [resolve('e2e/fixtures/make_drawing.py'), pdf]);
      const app = createApp({ dbPath: join(dir, 'board.db'), toolScriptDirs: [TOOLS], python: realPython!, pythonRunner: runPython });
      const base = `http://127.0.0.1:${await app.listen(0, '127.0.0.1')}`;
      try {
        const c = new Client(base);
        await signIn(c, 2);
        const st = (await c.get('/api/tools/drawing/status')).body;
        assert.equal(st.state, 'ready', JSON.stringify(st));
        const res = await upload(base, c, 'name=VT-JD 123-01.pdf&format=both', readFileSync(pdf));
        const body = await res.json();
        assert.equal(res.status, 200, JSON.stringify(body));
        assert.deepEqual(
          body.files.map((f: any) => f.name),
          ['VT-JD 123-01.docx', 'VT-JD 123-01.xlsx'],
        );
        // both are zip containers (Office files)
        for (const f of body.files) assert.equal(Buffer.from(f.data, 'base64').subarray(0, 2).toString(), 'PK');
        assert.match(body.report, /title: MOUNTING BRACKET\s+drawing: VT-JD 123-01 REV\.02\s+material: AL 6061-T6/);
        assert.match(body.report, /general tolerances: 0 dec ±0\.5, 1 dec ±0\.1, 2 dec ±0\.02, angle ±1°/);
        assert.match(body.report, /a\.\s+E7\s+25\.0\s+±0\.1/);
        assert.match(body.report, /Ø12\.5\s+±0\.1/);
        assert.match(body.report, /\*40\s+±0\.5/);
        assert.match(body.report, /VERIFY 4X M6x1\.0 THRU/);
        assert.match(body.report, /not used \[C7\]: \(10\)\s+\(reference dimension\)/);
        // inside the Word and Excel files: the project from the drawing number (VT-JD 123-01 -> JD 123), and the sign-off levels
        for (const f of body.files) {
          const xml = (readZip(Buffer.from(f.data, 'base64')) as { name: string; data: Buffer }[])
            .filter((e) => e.name.endsWith('.xml'))
            .map((e) => e.data.toString('utf8'))
            .join('\n');
          assert.match(xml, /DIMENSION CHECK LIST FOR MOUNTING BRACKET FOR JD 123</, f.name);
          assert.match(xml, />JD 123</, `${f.name}: the project in the header`);
          assert.doesNotMatch(xml, />N\/A</, f.name);
          assert.match(xml, /Min\. Level Reqd\.: Tech\. Asst\./, f.name);
          assert.match(xml, /Min\. Level Reqd\.: Tech\. Officer/, f.name);
          assert.doesNotMatch(xml, /Tech\. Exec|Reqd\.: Officer/, f.name);
        }
      } finally {
        await app.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
