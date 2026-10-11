// PDF tools (decision #33): the team's four scripts as board tools. Stamp,
// negative and combine-by-size are browser code (web/src/lib/pdf), pure enough
// to run here; Word to PDF is a server route driven by a converter the tests
// replace with a fake.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePdf } from '../../e2e/fixtures/pdf.mjs';
import { stampPdf, firstPageOnly, cleanStampOptions, STAMP_DEFAULTS } from '../../web/src/lib/pdf/stamp.ts';
import { pdfToNegative, tokenize, inverted, invertCmyk, pdfNumber } from '../../web/src/lib/pdf/negative.ts';
import { classifyPageSize, groupPdfsBySize } from '../../web/src/lib/pdf/group.ts';
import { makeZip, crc32 } from '../../web/src/lib/pdf/zip.ts';
import { cleanWordName, WordQueue } from '../src/domain/wordToPdf.ts';
import { createApp, type App } from '../src/app.ts';
import { Client, signIn } from './helpers.ts';
import { HttpError } from '../src/lib/core.ts';

import type { PDFName as PDFNameT, PDFRawStream as PDFRawStreamT } from 'pdf-lib';

type Lib = typeof import('pdf-lib');
let lib: Lib;
before(async () => {
  lib = await import('pdf-lib');
});

/** The decoded content of every page, joined. */
async function pageContents(bytes: Uint8Array): Promise<string[]> {
  const doc = await lib.PDFDocument.load(bytes);
  return doc.getPages().map((p) => {
    const c = p.node.Contents();
    const streams = c instanceof lib.PDFArray ? c.asArray().map((r) => doc.context.lookup(r)) : [c];
    return streams
      .map((s) => (s instanceof lib.PDFRawStream ? Buffer.from(lib.decodePDFRawStream(s).decode()).toString('latin1') : ''))
      .join('\n');
  });
}

/** A 2×2 RGB PNG so pdf-lib can embed an image. */
function tinyPng(): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

describe('PDF tools: stamp', () => {
  it("writes the script's stamp on every page: Helvetica at 12% of the width, 45°, 30% opaque, starting a quarter across and 40% down", async () => {
    const src = new Uint8Array(makePdf(3, { size: [842, 595] }));
    const r = await stampPdf(src);
    assert.equal(r.pages, 3);
    const doc = await lib.PDFDocument.load(r.bytes);
    assert.equal(doc.getPageCount(), 3);
    const contents = await pageContents(r.bytes);
    for (const c of contents) {
      assert.match(c, /Tf/, 'text is drawn');
      // 842 × 0.12 = 101.04; the rotation is 45° (cos = sin ≈ 0.7071); the start is (210.5, 595 − 238 = 357)
      assert.match(c, /101\.0[34]\d* Tf/);
      assert.match(c, /0\.7071\d* 0\.7071\d* -0\.7071\d* 0\.7071\d* 210\.5 357/);
      assert.match(c, /\[DRAFT\]|5b44524146545d/i, 'the [DRAFT] text (literal or hex)');
    }
    const page = doc.getPage(0);
    const gs = page.node.Resources()!.lookup(lib.PDFName.of('ExtGState'), lib.PDFDict);
    assert.ok(gs && gs.entries().length >= 1, 'an ExtGState carries the 30% opacity');
    assert.match(String(gs!.entries()[0][1] instanceof lib.PDFRef ? doc.context.lookup(gs!.entries()[0][1]) : gs!.entries()[0][1]), /\/ca 0\.3/);
  });

  it('adjustments change what is written, and bad values fall back to the defaults', async () => {
    const src = new Uint8Array(makePdf(1, { size: [600, 400] }));
    const r = await stampPdf(src, { text: 'CONFIDENTIAL', size: 0.125, angle: 0, x: 0.25, y: 0.5, color: '#ff0000', opacity: 1 });
    const [c] = await pageContents(r.bytes);
    assert.match(c, /75 Tf/); // 600 × 0.125
    assert.match(c, /1 0 -?0 1 150 200/); // no rotation, x = 150, y = 400 − 200
    assert.match(c, /1 0 0 rg/);
    assert.deepEqual(cleanStampOptions({ text: '', size: 99, angle: 999, color: 'red', opacity: -2 }), { ...STAMP_DEFAULTS, size: 2, angle: 180, opacity: 0 });
    const one = await firstPageOnly(new Uint8Array(makePdf(4)));
    assert.equal((await lib.PDFDocument.load(one)).getPageCount(), 1, 'the preview stamps the first page alone');
  });
});

describe('PDF tools: negative', () => {
  it('inverts colour operators and the defaults, and copies everything else byte for byte', () => {
    const src = new TextEncoder().encode('q 0.2 0.4 0.6 rg 1 0 0 RG /Cs1 cs 0.5 sc (text (nested) \\) with rg inside) Tj [1 2] TJ 0 0 0 1 k BI /W 1 /H 1 /CS /G /BPC 8 ID \x00 EI 10 10 m Q');
    const ops = tokenize(src).map((i) => i.op);
    assert.deepEqual(ops, ['q', 'rg', 'RG', 'cs', 'sc', 'Tj', 'TJ', 'k', 'BI', 'm', 'Q']);
    assert.deepEqual(inverted('DeviceRGB', [0.2, 0.4, 0.6]), ['0.8', '0.6', '0.4']);
    assert.deepEqual(inverted('DeviceGray', [0]), ['1']);
    assert.deepEqual(invertCmyk(0, 0, 0, 1), [0, 0, 0, 0], 'black becomes white, not rich black (1,1,1,0)'); // the script inverts CMYK through RGB
    assert.deepEqual(inverted('DeviceCMYK', [0, 0, 0, 1]), ['0', '0', '0', '0']);
    assert.deepEqual(inverted('DeviceCMYK', [1, 0, 0, 0]), ['0', '1', '1', '0'], 'cyan becomes red');
    assert.deepEqual(invertCmyk(0, 0, 0, 0), [0, 0, 0, 1], 'white becomes black');
    assert.equal(pdfNumber(0.123456), '0.1235');
    assert.equal(pdfNumber(1.7), '1');
    assert.equal(pdfNumber(0), '0');
  });

  it('turns a drawing into its negative: black background, white lines, inverted fills, forms and images, with the script\'s statistics', async () => {
    const doc = await lib.PDFDocument.create();
    const page = doc.addPage([400, 300]);
    page.drawRectangle({ x: 10, y: 10, width: 100, height: 50, color: lib.rgb(0.2, 0.4, 0.6), borderColor: lib.cmyk(0, 0, 0, 1), borderWidth: 2 });
    page.drawLine({ start: { x: 0, y: 0 }, end: { x: 400, y: 300 }, color: lib.grayscale(0.25) });
    const png = await doc.embedPng(tinyPng());
    page.drawImage(png, { x: 200, y: 200, width: 20, height: 20 });
    // a form XObject: another page embedded
    const inner = doc.addPage([100, 100]);
    inner.drawRectangle({ x: 0, y: 0, width: 50, height: 50, color: lib.rgb(1, 0, 0) });
    const form = await doc.embedPage(inner);
    page.drawPage(form, { x: 300, y: 10 });
    doc.removePage(1);
    const src = await doc.save();

    const r = await pdfToNegative(src, true);
    assert.deepEqual(r.stats, { pages: 1, forms: 1, images: 1, images_skipped: 0 });
    const [c] = await pageContents(r.bytes);
    assert.match(c, /^q 0 g 0 0 400 300 re f Q\n1 g 1 G\n/, 'the page is painted black first and unset colours become white');
    assert.match(c, /0\.8 0\.6 0\.4 rg/, 'the fill is inverted');
    assert.match(c, /0 0 0 0 K/, 'the black CMYK stroke becomes white by the script\'s rule');
    assert.match(c, /0\.75 G/, 'the grey line is inverted');
    assert.doesNotMatch(c, /0\.2 0\.4 0\.6 rg/);
    const out = await lib.PDFDocument.load(r.bytes);
    const res = out.getPage(0).node.Resources()!;
    const xobjects = res.lookup(lib.PDFName.of('XObject'), lib.PDFDict)!;
    let sawForm = false;
    let sawImage = false;
    for (const [, ref] of xobjects.entries()) {
      const x = out.context.lookup(ref) as PDFRawStreamT;
      const subtype = (x.dict.get(lib.PDFName.of('Subtype')) as PDFNameT).decodeText();
      if (subtype === 'Form') {
        sawForm = true;
        const body = Buffer.from(lib.decodePDFRawStream(x).decode()).toString('latin1');
        assert.match(body, /0 1 1 rg/, 'the red fill inside the form is inverted to cyan');
      } else if (subtype === 'Image') {
        sawImage = true;
        const decode = x.dict.get(lib.PDFName.of('Decode'));
        assert.equal(String(decode), '[ 1 0 1 0 1 0 ]', 'the RGB image is inverted through /Decode');
      }
    }
    assert.ok(sawForm && sawImage);
    // without the background: no black rectangle, the rest unchanged
    const r2 = await pdfToNegative(src, false);
    const [c2] = await pageContents(r2.bytes);
    assert.match(c2, /^1 g 1 G\n/);
    assert.doesNotMatch(c2, /re f Q\n1 g/);
    // the fixture drawings (no colour operators at all) still come out white-on-black
    const fixture = await pdfToNegative(new Uint8Array(makePdf(2)), true);
    assert.equal(fixture.stats.pages, 2);
  });
});

describe('PDF tools: combine by size', () => {
  it('classifies first pages as A4, A3 or other in either orientation, with the 5 pt tolerance', () => {
    assert.equal(classifyPageSize(595.28, 841.89), 'A4');
    assert.equal(classifyPageSize(842, 595), 'A4', 'landscape, rounded');
    assert.equal(classifyPageSize(841.89, 1190.55), 'A3');
    assert.equal(classifyPageSize(1191, 842), 'A3');
    assert.equal(classifyPageSize(612, 792), 'other', 'US Letter');
    assert.equal(classifyPageSize(600, 848), 'other', 'more than 5 pt off');
  });

  it('merges each size into one PDF in the order chosen, and reports what it could not read', async () => {
    const r = await groupPdfsBySize([
      { name: 'a4-portrait.pdf', bytes: new Uint8Array(makePdf(2, { size: [595.28, 841.89] })) },
      { name: 'a3.pdf', bytes: new Uint8Array(makePdf(1, { size: [1190.55, 841.89] })) },
      { name: 'a4-landscape.pdf', bytes: new Uint8Array(makePdf(3, { size: [842, 595] })) },
      { name: 'letter.pdf', bytes: new Uint8Array(makePdf(1, { size: [612, 792] })) },
      { name: 'broken.pdf', bytes: new TextEncoder().encode('not a pdf at all') },
    ]);
    assert.deepEqual(
      r.details.map((d) => [d.name, d.size, d.pages, !!d.error]),
      [
        ['a4-portrait.pdf', 'A4', 2, false],
        ['a3.pdf', 'A3', 1, false],
        ['a4-landscape.pdf', 'A4', 3, false],
        ['letter.pdf', 'other', 1, false],
        ['broken.pdf', 'other', 0, true],
      ],
    );
    assert.deepEqual(
      r.outputs.map((o) => [o.name, o.files, o.pages]),
      [
        ['combined_A4.pdf', ['a4-portrait.pdf', 'a4-landscape.pdf'], 5],
        ['combined_A3.pdf', ['a3.pdf'], 1],
        ['combined_other.pdf', ['letter.pdf'], 1],
      ],
    );
    const a4 = await lib.PDFDocument.load(r.outputs[0].bytes);
    assert.equal(a4.getPageCount(), 5);
    assert.equal(Math.round(a4.getPage(0).getWidth()), 595, 'portrait pages first');
    assert.equal(Math.round(a4.getPage(2).getWidth()), 842, 'then the landscape file');
  });
});

describe('PDF tools: zip for downloading several results', () => {
  it('writes a stored zip with correct headers, names and CRCs', () => {
    const a = new TextEncoder().encode('hello');
    const b = new Uint8Array(makePdf(1));
    const zip = makeZip([{ name: 'a.txt', data: a }, { name: 'sub/b.pdf', data: b }], new Date(2026, 9, 8, 10, 30, 0));
    const buf = Buffer.from(zip);
    assert.equal(buf.readUInt32LE(0), 0x04034b50, 'local file header');
    assert.equal(buf.readUInt32LE(14), crc32(a));
    assert.equal(buf.readUInt32LE(18), a.length);
    assert.equal(buf.toString('latin1', 30, 35), 'a.txt');
    assert.equal(buf.subarray(35, 40).toString(), 'hello');
    const endAt = buf.length - 22;
    assert.equal(buf.readUInt32LE(endAt), 0x06054b50, 'end of central directory');
    assert.equal(buf.readUInt16LE(endAt + 10), 2, 'two entries');
    const centralAt = buf.readUInt32LE(endAt + 16);
    assert.equal(buf.readUInt32LE(centralAt), 0x02014b50, 'central directory');
    assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926, 'the standard CRC-32 check value');
  });
});

describe('PDF tools: Word to PDF through the host', () => {
  let app: App;
  let dir: string;
  let base: string;
  let paul: Client;
  let converted: string[] = [];
  let active = 0;
  let maxActive = 0;
  const fakeWord = async (input: string, output: string) => {
    converted.push(input);
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 15)); // Word takes its time; overlapping calls would show here
    active--;
    if (/fail/i.test(input)) throw new HttpError(500, 'word_failed', 'Microsoft Word could not convert the file: pretend');
    copyFileSync(join(dir, 'source.pdf'), output);
  };
  const upload = (c: Client, name: string, body: Uint8Array | string, type = 'application/octet-stream') =>
    fetch(`${base}/api/tools/word-to-pdf?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': type, cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: typeof body === 'string' ? body : new Uint8Array(body),
    });
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'eb-word-'));
    const fs = await import('node:fs');
    fs.writeFileSync(join(dir, 'source.pdf'), makePdf(2));
    app = createApp({ dbPath: join(dir, 'board.db'), wordToPdf: { convert: fakeWord, status: 'available' } });
    base = `http://127.0.0.1:${await app.listen(0, '127.0.0.1')}`;
    paul = new Client(base);
    await signIn(paul, 2);
  });
  after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports availability, and converts an uploaded .docx into a downloaded PDF named after it', async () => {
    assert.deepEqual((await paul.get('/api/tools/pdf/status')).body, { word_to_pdf: 'available' });
    const res = await upload(paul, 'Pump spec (rev B).docx', new Uint8Array([0x50, 0x4b, 3, 4, 1, 2, 3]));
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="Pump spec (rev B).pdf"');
    const pdf = Buffer.from(await res.arrayBuffer());
    assert.ok(pdf.subarray(0, 5).toString() === '%PDF-');
    assert.equal((await lib.PDFDocument.load(pdf)).getPageCount(), 2);
    assert.match(converted[0], /Pump spec \(rev B\)\.docx$/, 'Word opens the file under its own name and extension');
    assert.deepEqual(readdirSync(join(dir, 'tmp')), [], 'the upload and the PDF are removed afterwards');
  });

  it('refuses anything but .doc and .docx, empty uploads, reviewers and the wrong content type, before reading the body', async () => {
    assert.equal((await upload(paul, 'drawing.pdf', 'x')).status, 400);
    assert.equal((await upload(paul, '', 'x')).status, 400);
    assert.equal((await upload(paul, 'a.docx', '')).status, 400);
    assert.equal((await upload(paul, 'a.docx', 'x', 'application/json')).status, 415);
    assert.equal((await upload(new Client(base), 'a.docx', 'x')).status, 401);
    const admin = new Client(base);
    await signIn(admin, 1);
    await admin.post('/api/admin/unlock', { pin: '1234' });
    const made = await admin.post('/api/admin/users', { name: 'Ebin', role: 'reviewer' });
    const ebin = new Client(base);
    await signIn(ebin, made.body.user.id);
    assert.equal((await upload(ebin, 'a.docx', 'x')).status, 403);
    assert.equal((await ebin.get('/api/tools/pdf/status')).status, 403);
  });

  it("passes Word's failure on, and cleans up", async () => {
    const res = await upload(paul, 'will-fail.doc', 'x');
    assert.equal(res.status, 500);
    assert.match((await res.json()).message, /could not convert/);
    assert.deepEqual(readdirSync(join(dir, 'tmp')), []);
  });

  it('runs conversions one at a time, never two in Word at once', async () => {
    converted = [];
    maxActive = 0;
    const results = await Promise.all(['one.docx', 'two.docx', 'three.docx'].map((n) => upload(paul, n, 'x')));
    assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
    assert.deepEqual(converted.map((p) => p.replace(/.*[\\/]/, '')).sort(), ['one.docx', 'three.docx', 'two.docx']);
    assert.equal(maxActive, 1, 'the queue serialises Word');
  });

  it('says so on a host without Windows or Word, and the name check is strict', async () => {
    const other = createApp({ dbPath: join(dir, 'board2.db'), wordToPdf: { convert: fakeWord, status: 'not_windows' } });
    const base2 = `http://127.0.0.1:${await other.listen(0, '127.0.0.1')}`;
    const c = new Client(base2);
    await signIn(c, 2);
    assert.deepEqual((await c.get('/api/tools/pdf/status')).body, { word_to_pdf: 'not_windows' });
    const res = await fetch(`${base2}/api/tools/word-to-pdf?name=a.docx`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }, body: 'x' });
    assert.equal(res.status, 501);
    assert.match((await res.json()).message, /Microsoft Word/);
    await other.close();
    assert.equal(cleanWordName('  Spec/2026:v1.DOCX '), 'Spec_2026_v1.DOCX');
    assert.throws(() => cleanWordName('a.pdf'), /Word document/);
    assert.throws(() => cleanWordName(null), /Word document/);
    const q = new WordQueue(async () => {}, join(dir, 'q'));
    assert.match(q.newDir(), /word-/);
  });

  it('the real converter is not used in tests: the probe answers not_windows here or available on a Windows host with Word', async () => {
    const { probeWord } = await import('../src/domain/wordToPdf.ts');
    const s = await probeWord();
    assert.ok(['available', 'not_windows', 'no_word'].includes(s));
    if (process.platform !== 'win32') assert.equal(s, 'not_windows');
  });
});
