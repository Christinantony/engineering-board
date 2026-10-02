// Minimal PDF reader: is this a readable PDF, and how many pages does it have?
//
// Board review needs exactly two facts from a PDF: that it opens, and its page
// count (a submitted drawing must be a single page; a remembered reference page
// must exist). Nothing here looks at drawing content. It is written with Node
// built-ins only (decision #1): the cross-reference table or stream is read,
// the document catalogue is followed to its page tree, and /Count is returned.
// When the cross-reference data is damaged the file is scanned for objects the
// way PDF readers repair files. Encrypted PDFs are refused with a clear reason.

import { inflateSync, constants as zc } from 'node:zlib';

export class PdfError extends Error {}

const ENCRYPTED = 'This PDF is encrypted or password-protected. Save or export it without security, then attach it again.';

type Ref = { ref: [number, number] };
type PdfVal = number | string | boolean | null | PdfName | PdfVal[] | PdfDict | Ref;
interface PdfName {
  name: string;
}
interface PdfDict {
  dict: Map<string, PdfVal>;
  /** Byte offset of stream data, when the dictionary starts a stream. */
  streamAt?: number;
}

const isName = (v: unknown): v is PdfName => typeof v === 'object' && v !== null && 'name' in v;
const isDict = (v: unknown): v is PdfDict => typeof v === 'object' && v !== null && 'dict' in v;
const isRef = (v: unknown): v is Ref => typeof v === 'object' && v !== null && 'ref' in v;

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

class Lexer {
  constructor(
    public buf: Buffer,
    public pos: number,
  ) {}

  skipWs() {
    const b = this.buf;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (WS.has(c)) this.pos++;
      else if (c === 0x25) {
        // comment to end of line
        while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++;
      } else break;
    }
  }

  /** A regular token (number, keyword) without consuming delimiters. */
  word(): string {
    this.skipWs();
    const start = this.pos;
    const b = this.buf;
    while (this.pos < b.length && !WS.has(b[this.pos]) && !DELIM.has(b[this.pos])) this.pos++;
    return b.toString('latin1', start, this.pos);
  }

  peekWord(): string {
    const save = this.pos;
    const w = this.word();
    this.pos = save;
    return w;
  }

  value(depth = 0): PdfVal {
    if (depth > 64) throw new PdfError('nested too deeply');
    this.skipWs();
    const b = this.buf;
    if (this.pos >= b.length) throw new PdfError('unexpected end of file');
    const c = b[this.pos];
    if (c === 0x2f) {
      // name
      this.pos++;
      const start = this.pos;
      while (this.pos < b.length && !WS.has(b[this.pos]) && !DELIM.has(b[this.pos])) this.pos++;
      return { name: b.toString('latin1', start, this.pos).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) };
    }
    if (c === 0x3c && b[this.pos + 1] === 0x3c) {
      this.pos += 2;
      const dict = new Map<string, PdfVal>();
      for (;;) {
        this.skipWs();
        if (this.pos >= b.length) throw new PdfError('unterminated dictionary');
        if (b[this.pos] === 0x3e && b[this.pos + 1] === 0x3e) {
          this.pos += 2;
          break;
        }
        const key = this.value(depth + 1);
        if (!isName(key)) throw new PdfError('bad dictionary key');
        dict.set(key.name, this.value(depth + 1));
      }
      const out: PdfDict = { dict };
      const save = this.pos;
      if (this.word() === 'stream') {
        if (b[this.pos] === 0x0d) this.pos++;
        if (b[this.pos] === 0x0a) this.pos++;
        out.streamAt = this.pos;
      } else this.pos = save;
      return out;
    }
    if (c === 0x3c) {
      // hex string
      const end = b.indexOf(0x3e, this.pos);
      if (end < 0) throw new PdfError('unterminated hex string');
      const hex = b.toString('latin1', this.pos + 1, end).replace(/\s+/g, '');
      this.pos = end + 1;
      return Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex').toString('latin1');
    }
    if (c === 0x28) {
      // literal string with balanced parentheses and escapes
      let level = 0;
      const start = this.pos + 1;
      for (; this.pos < b.length; this.pos++) {
        const d = b[this.pos];
        if (d === 0x5c) this.pos++;
        else if (d === 0x28) level++;
        else if (d === 0x29 && --level === 0) {
          this.pos++;
          return b.toString('latin1', start, this.pos - 1);
        }
      }
      throw new PdfError('unterminated string');
    }
    if (c === 0x5b) {
      this.pos++;
      const arr: PdfVal[] = [];
      for (;;) {
        this.skipWs();
        if (this.pos >= b.length) throw new PdfError('unterminated array');
        if (b[this.pos] === 0x5d) {
          this.pos++;
          return arr;
        }
        arr.push(this.value(depth + 1));
      }
    }
    const w = this.word();
    if (!w) {
      this.pos++;
      throw new PdfError('unexpected delimiter');
    }
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) {
      // "N G R" is an indirect reference
      if (/^\d+$/.test(w)) {
        const save = this.pos;
        const g = this.word();
        if (/^\d+$/.test(g) && this.word() === 'R') return { ref: [Number(w), Number(g)] };
        this.pos = save;
      }
      return Number(w);
    }
    return w; // other keywords (unused here)
  }
}

type Entry = { type: 1; offset: number } | { type: 2; stream: number; index: number };

export interface PdfInfo {
  pages: number;
  /** PDF header version, e.g. "1.7". */
  version: string;
}

export class PdfReader {
  private xref = new Map<number, Entry>();
  private trailer: Map<string, PdfVal> = new Map();
  private objStreams = new Map<number, Map<number, PdfVal>>();
  private resolving = new Set<number>();

  constructor(private buf: Buffer) {}

  static inspect(buf: Buffer): PdfInfo {
    const head = buf.toString('latin1', 0, Math.min(buf.length, 1024));
    const m = /%PDF-(\d\.\d)/.exec(head);
    if (!m) throw new PdfError('This file is not a PDF.');
    const r = new PdfReader(buf);
    let pages: number | null = null;
    try {
      r.readXrefChain();
      pages = r.pageCount();
    } catch (e) {
      if (e instanceof PdfError && /encrypted/i.test(e.message)) throw e;
      pages = null;
    }
    if (pages == null) {
      // damaged or unusual cross-reference data: rebuild it from the objects
      try {
        r.reconstruct();
        pages = r.pageCount();
      } catch (e) {
        if (e instanceof PdfError && /encrypted/i.test(e.message)) throw e;
        if (r.encrypted) throw new PdfError(ENCRYPTED);
        throw new PdfError('This PDF could not be read. It may be damaged or incomplete; export or scan it again.');
      }
    }
    if (!Number.isInteger(pages) || pages < 1) throw new PdfError('This PDF has no pages.');
    return { pages, version: m[1] };
  }

  // ---- cross-reference data ----

  private readXrefChain() {
    const tail = this.buf.toString('latin1', Math.max(0, this.buf.length - 2048));
    const i = tail.lastIndexOf('startxref');
    if (i < 0) throw new PdfError('no startxref');
    let offset = Number(/startxref\s+(\d+)/.exec(tail.slice(i))?.[1]);
    const seen = new Set<number>();
    let first = true;
    while (Number.isInteger(offset) && offset > 0 && offset < this.buf.length && !seen.has(offset)) {
      seen.add(offset);
      const trailer = this.readXrefSection(offset);
      if (first) {
        this.trailer = trailer;
        first = false;
      }
      // hybrid files: a classic table pointing at an additional xref stream
      const stm = trailer.get('XRefStm');
      if (typeof stm === 'number' && !seen.has(stm)) {
        seen.add(stm);
        this.readXrefSection(stm);
      }
      const prev = trailer.get('Prev');
      offset = typeof prev === 'number' ? prev : -1;
    }
    if (first) throw new PdfError('no cross-reference data');
  }

  private readXrefSection(offset: number): Map<string, PdfVal> {
    const lx = new Lexer(this.buf, offset);
    if (lx.peekWord() === 'xref') {
      lx.word();
      for (;;) {
        const w = lx.peekWord();
        if (w === 'trailer') {
          lx.word();
          const t = lx.value();
          if (!isDict(t)) throw new PdfError('bad trailer');
          return t.dict;
        }
        const start = Number(lx.word());
        const count = Number(lx.word());
        if (!Number.isInteger(start) || !Number.isInteger(count) || count < 0) throw new PdfError('bad xref subsection');
        for (let k = 0; k < count; k++) {
          const off = Number(lx.word());
          lx.word(); // generation
          const kind = lx.word();
          const num = start + k;
          if (!this.xref.has(num) && kind === 'n' && off > 0) this.xref.set(num, { type: 1, offset: off });
          else if (!this.xref.has(num) && kind === 'f') this.xref.set(num, { type: 1, offset: -1 });
        }
      }
    }
    // cross-reference stream: "N G obj << /Type /XRef ... >> stream"
    lx.word();
    lx.word();
    if (lx.word() !== 'obj') throw new PdfError('bad xref offset');
    const d = lx.value();
    if (!isDict(d) || d.streamAt == null || (d.dict.get('Type') as PdfName | undefined)?.name !== 'XRef') throw new PdfError('bad xref stream');
    const data = this.streamData(d);
    const w = (d.dict.get('W') as number[]) ?? [];
    if (w.length !== 3 || w.some((n) => typeof n !== 'number')) throw new PdfError('bad xref stream widths');
    const size = d.dict.get('Size') as number;
    const index = (d.dict.get('Index') as number[] | undefined) ?? [0, size];
    const rowLen = w[0] + w[1] + w[2];
    let p = 0;
    const field = (len: number, dflt: number) => {
      if (!len) return dflt;
      let n = 0;
      for (let k = 0; k < len; k++) n = n * 256 + data[p++];
      return n;
    };
    for (let s = 0; s + 1 < index.length; s += 2) {
      for (let k = 0; k < index[s + 1]; k++) {
        if (p + rowLen > data.length) break;
        const type = field(w[0], 1);
        const f2 = field(w[1], 0);
        const f3 = field(w[2], 0);
        const num = index[s] + k;
        if (this.xref.has(num)) continue;
        if (type === 1) this.xref.set(num, { type: 1, offset: f2 });
        else if (type === 2) this.xref.set(num, { type: 2, stream: f2, index: f3 });
        else this.xref.set(num, { type: 1, offset: -1 });
      }
    }
    return d.dict;
  }

  /** Rebuild the object table by scanning the whole file (for damaged files). */
  private reconstruct() {
    this.xref.clear();
    this.objStreams.clear();
    const text = this.buf.toString('latin1');
    const re = /(?:^|[\r\n\s])(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
    let m: RegExpExecArray | null;
    let trailer: Map<string, PdfVal> | null = null;
    while ((m = re.exec(text))) {
      const at = m.index + m[0].indexOf(m[1]);
      this.xref.set(Number(m[1]), { type: 1, offset: at }); // later definitions win
    }
    // classic trailers (last one wins) and xref streams carry /Root
    const tr = /trailer\s*<</g;
    while ((m = tr.exec(text))) {
      try {
        const t = new Lexer(this.buf, m.index + m[0].length - 2).value();
        if (isDict(t) && t.dict.has('Root')) trailer = t.dict;
      } catch {
        /* skip damaged trailer */
      }
    }
    // objects inside object streams
    for (const [num, e] of [...this.xref]) {
      if (e.type !== 1) continue;
      try {
        const obj = this.readAt(e.offset, num);
        if (isDict(obj) && (obj.dict.get('Type') as PdfName | undefined)?.name === 'XRef' && obj.dict.has('Root') && !trailer) trailer = obj.dict;
        if (isDict(obj) && (obj.dict.get('Type') as PdfName | undefined)?.name === 'ObjStm') {
          for (const n of this.parseObjStm(num, obj).keys()) if (!this.xref.has(n)) this.xref.set(n, { type: 2, stream: num, index: -1 });
        }
      } catch {
        /* skip damaged object */
      }
    }
    if (!trailer) {
      // no trailer at all: find the catalogue directly
      for (const [num] of this.xref) {
        try {
          const o = this.resolve({ ref: [num, 0] });
          if (isDict(o) && (o.dict.get('Type') as PdfName | undefined)?.name === 'Catalog') {
            trailer = new Map([['Root', { ref: [num, 0] } as Ref]]);
            break;
          }
        } catch {
          /* keep looking */
        }
      }
    }
    if (!trailer) throw new PdfError('no document catalogue');
    this.trailer = trailer;
  }

  // ---- objects ----

  private readAt(offset: number, expect: number): PdfVal {
    const lx = new Lexer(this.buf, offset);
    const num = Number(lx.word());
    lx.word();
    if (lx.word() !== 'obj' || num !== expect) throw new PdfError(`object ${expect} not found at its offset`);
    return lx.value();
  }

  private parseObjStm(num: number, stm: PdfDict): Map<number, PdfVal> {
    const cached = this.objStreams.get(num);
    if (cached) return cached;
    const data = this.streamData(stm);
    const n = stm.dict.get('N') as number;
    const first = stm.dict.get('First') as number;
    if (typeof n !== 'number' || typeof first !== 'number') throw new PdfError('bad object stream');
    const lx = new Lexer(data, 0);
    const pairs: [number, number][] = [];
    for (let k = 0; k < n; k++) pairs.push([Number(lx.word()), Number(lx.word())]);
    const out = new Map<number, PdfVal>();
    for (const [objNum, off] of pairs) {
      try {
        out.set(objNum, new Lexer(data, first + off).value());
      } catch {
        /* skip one damaged entry */
      }
    }
    this.objStreams.set(num, out);
    return out;
  }

  resolve(v: PdfVal | undefined): PdfVal | undefined {
    if (!isRef(v)) return v;
    const num = v.ref[0];
    if (this.resolving.has(num)) throw new PdfError('reference loop');
    const e = this.xref.get(num);
    if (!e) return null;
    this.resolving.add(num);
    try {
      if (e.type === 1) return e.offset < 0 ? null : this.readAt(e.offset, num);
      if (this.encrypted) throw new PdfError(ENCRYPTED);
      const container = this.resolve({ ref: [e.stream, 0] });
      if (!isDict(container)) throw new PdfError('bad object stream');
      return this.parseObjStm(e.stream, container).get(num) ?? null;
    } finally {
      this.resolving.delete(num);
    }
  }

  private streamData(d: PdfDict): Buffer {
    if (d.streamAt == null) throw new PdfError('not a stream');
    let len = this.resolve(d.dict.get('Length'));
    let end = typeof len === 'number' ? d.streamAt + len : -1;
    // trust /Length only when "endstream" follows it; otherwise search for it
    const near = end >= 0 ? this.buf.toString('latin1', end, Math.min(this.buf.length, end + 32)) : '';
    if (end < 0 || end > this.buf.length || !/^\s*endstream/.test(near)) {
      end = this.buf.indexOf('endstream', d.streamAt, 'latin1');
      if (end < 0) throw new PdfError('unterminated stream');
      while (end > d.streamAt && (this.buf[end - 1] === 0x0a || this.buf[end - 1] === 0x0d)) end--;
      len = end - d.streamAt;
    }
    let data = this.buf.subarray(d.streamAt, end);
    const filters = ([] as PdfVal[]).concat(d.dict.get('Filter') ?? []);
    const parms = ([] as PdfVal[]).concat(d.dict.get('DecodeParms') ?? []);
    filters.forEach((f, i) => {
      const name = isName(f) ? f.name : '';
      if (name !== 'FlateDecode' && name !== 'Fl') throw new PdfError(`unsupported filter ${name}`);
      data = inflateSync(data, { finishFlush: zc.Z_SYNC_FLUSH });
      const p = this.resolve(parms[i]);
      if (isDict(p)) data = unpredict(data, p.dict);
    });
    return data;
  }

  /**
   * Dictionaries are not encrypted, so an encrypted file's page count can still
   * be read unless it sits in an (encrypted) object stream; resolve() refuses then.
   */
  get encrypted(): boolean {
    return this.trailer.has('Encrypt') || this.buf.includes('/Encrypt');
  }

  pageCount(): number {
    const root = this.resolve(this.trailer.get('Root'));
    if (!isDict(root)) throw new PdfError('no document catalogue');
    const pages = this.resolve(root.dict.get('Pages'));
    if (!isDict(pages)) throw new PdfError('no page tree');
    const count = this.resolve(pages.dict.get('Count'));
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) throw new PdfError('no page count');
    return count;
  }
}

/** PNG predictors used by cross-reference and object streams. */
function unpredict(data: Buffer, parms: Map<string, PdfVal>): Buffer {
  const predictor = (parms.get('Predictor') as number) ?? 1;
  if (predictor < 10) {
    if (predictor === 1) return data;
    throw new PdfError('unsupported predictor');
  }
  const colors = (parms.get('Colors') as number) ?? 1;
  const bpc = (parms.get('BitsPerComponent') as number) ?? 8;
  const columns = (parms.get('Columns') as number) ?? 1;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * columns) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = Buffer.alloc(rows * rowLen);
  const prev = Buffer.alloc(rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const row = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
    const cur = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let i = 0; i < rowLen; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0;
      const up = prev[i];
      const ul = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (type === 1) v += left;
      else if (type === 2) v += up;
      else if (type === 3) v += (left + up) >> 1;
      else if (type === 4) {
        const p = left + up - ul;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - ul);
        v += pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
      }
      cur[i] = v & 0xff;
    }
    cur.copy(prev);
  }
  return out;
}

/** Page count and version of a PDF, or a PdfError with a sentence for the user. */
export function inspectPdf(buf: Buffer): PdfInfo {
  return PdfReader.inspect(buf);
}
