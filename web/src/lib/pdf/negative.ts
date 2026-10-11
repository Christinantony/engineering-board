// Colour negative of a vector PDF (the team's pdf_to_negative.py), kept
// vector: every fill, stroke and text colour in the pages, and in nested forms
// and tiling patterns, is replaced by its inverse, so lines stay lines and
// text stays text. The page is painted black first (white paper isn't stored
// in a PDF, so it would otherwise stay white). Grey and RGB images are
// inverted through their /Decode arrays, without recompressing them.
// Gradients (shadings), CMYK and indexed images and annotation appearances
// are left unchanged, as in the script.

import type { PDFArray, PDFContext, PDFDict, PDFName, PDFObject, PDFRawStream, PDFRef, PDFStream } from 'pdf-lib';

type Lib = typeof import('pdf-lib');

interface Space {
  family: string;
  n: number;
  pattern?: boolean;
}

const DEVICE: Record<string, Space> = {
  DeviceGray: { family: 'DeviceGray', n: 1 },
  G: { family: 'DeviceGray', n: 1 },
  DeviceRGB: { family: 'DeviceRGB', n: 3 },
  RGB: { family: 'DeviceRGB', n: 3 },
  DeviceCMYK: { family: 'DeviceCMYK', n: 4 },
  CMYK: { family: 'DeviceCMYK', n: 4 },
  Pattern: { family: 'Pattern', n: 0, pattern: true },
};
const BY_COMPONENTS: Record<number, string> = { 1: 'DeviceGray', 3: 'DeviceRGB', 4: 'DeviceCMYK' };
const INVERTIBLE = new Set(['DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'Separation', 'DeviceN']);
const INVERTIBLE_IMAGES = new Set(['DeviceGray', 'DeviceRGB', 'Separation', 'DeviceN']);
const UNKNOWN: Space = { family: 'Unknown', n: 0 };
const SHORT_OPS: Record<string, string> = { g: 'DeviceGray', rg: 'DeviceRGB', k: 'DeviceCMYK' };

export interface NegativeStats {
  pages: number;
  forms: number;
  images: number;
  images_skipped: number;
}

// ---- colour maths (as the script) ----

export function invertCmyk(c: number, m: number, y: number, k: number): number[] {
  // Plain 1 − x per channel turns black (0,0,0,1) into rich black, so invert via RGB
  const [r, g, b] = [c, m, y].map((v) => 1 - (1 - v) * (1 - k));
  const k2 = 1 - Math.max(r, g, b);
  if (k2 >= 1) return [0, 0, 0, 1];
  return [...[r, g, b].map((v) => (1 - v - k2) / (1 - k2)), k2];
}

export function pdfNumber(v: number): string {
  const s = Math.min(Math.max(v, 0), 1).toFixed(4);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') || '0' : s;
}

export function inverted(family: string, values: number[]): string[] {
  const result = family === 'DeviceCMYK' && values.length === 4 ? invertCmyk(values[0], values[1], values[2], values[3]) : values.map((v) => 1 - v);
  return result.map(pdfNumber);
}

function initialColour(space: Space): number[] {
  if (space.pattern) return [];
  switch (space.family) {
    case 'DeviceGray':
      return [0];
    case 'DeviceRGB':
      return [0, 0, 0];
    case 'DeviceCMYK':
      return [0, 0, 0, 1];
    case 'Separation':
      return [1];
    case 'DeviceN':
      return Array(space.n).fill(1);
    default:
      return [];
  }
}

// ---- content stream tokenizer ----

export interface Token {
  kind: 'num' | 'name' | 'other';
  text: string;
  value?: number;
}
export interface Instruction {
  operands: Token[];
  op: string;
  /** byte range of the whole instruction in the source, kept verbatim when nothing changes */
  start: number;
  end: number;
}

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const isRegular = (c: number) => !WS.has(c) && !DELIM.has(c);

/** Split a content stream into instructions. Inline images (BI … ID … EI) are one instruction, copied verbatim. */
export function tokenize(src: Uint8Array): Instruction[] {
  const out: Instruction[] = [];
  let i = 0;
  let operands: Token[] = [];
  let start = -1;
  const n = src.length;
  const text = (a: number, b: number) => String.fromCharCode(...src.subarray(a, b));
  while (i < n) {
    const c = src[i];
    if (WS.has(c)) {
      i++;
      continue;
    }
    if (start < 0) start = i;
    if (c === 0x25) {
      // comment to end of line
      while (i < n && src[i] !== 0x0a && src[i] !== 0x0d) i++;
      continue;
    }
    if (c === 0x28) {
      // literal string with nesting and escapes
      let depth = 0;
      let j = i;
      for (; j < n; j++) {
        if (src[j] === 0x5c) {
          j++;
          continue;
        }
        if (src[j] === 0x28) depth++;
        else if (src[j] === 0x29 && --depth === 0) {
          j++;
          break;
        }
      }
      operands.push({ kind: 'other', text: text(i, j) });
      i = j;
      continue;
    }
    if (c === 0x3c) {
      if (src[i + 1] === 0x3c) {
        // dictionary: scan to the matching >>
        let depth = 0;
        let j = i;
        while (j < n) {
          if (src[j] === 0x3c && src[j + 1] === 0x3c) {
            depth++;
            j += 2;
          } else if (src[j] === 0x3e && src[j + 1] === 0x3e) {
            depth--;
            j += 2;
            if (depth === 0) break;
          } else if (src[j] === 0x28) {
            let d = 0;
            for (; j < n; j++) {
              if (src[j] === 0x5c) {
                j++;
                continue;
              }
              if (src[j] === 0x28) d++;
              else if (src[j] === 0x29 && --d === 0) {
                j++;
                break;
              }
            }
          } else j++;
        }
        operands.push({ kind: 'other', text: text(i, j) });
        i = j;
      } else {
        let j = i + 1;
        while (j < n && src[j] !== 0x3e) j++;
        operands.push({ kind: 'other', text: text(i, j + 1) });
        i = j + 1;
      }
      continue;
    }
    if (c === 0x5b) {
      // array: nest counting, strings inside respected
      let depth = 0;
      let j = i;
      while (j < n) {
        if (src[j] === 0x5b) depth++;
        else if (src[j] === 0x5d) {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        } else if (src[j] === 0x28) {
          let d = 0;
          for (; j < n; j++) {
            if (src[j] === 0x5c) {
              j++;
              continue;
            }
            if (src[j] === 0x28) d++;
            else if (src[j] === 0x29 && --d === 0) break;
          }
        }
        j++;
      }
      operands.push({ kind: 'other', text: text(i, j) });
      i = j;
      continue;
    }
    if (c === 0x2f) {
      let j = i + 1;
      while (j < n && isRegular(src[j])) j++;
      operands.push({ kind: 'name', text: text(i, j) });
      i = j;
      continue;
    }
    if (c === 0x5d || c === 0x29 || c === 0x3e || c === 0x7b || c === 0x7d) {
      i++; // stray delimiter: ignore
      continue;
    }
    // regular token: number or operator
    let j = i;
    while (j < n && isRegular(src[j])) j++;
    const t = text(i, j);
    i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) {
      operands.push({ kind: 'num', text: t, value: parseFloat(t) });
      continue;
    }
    if (t === 'BI') {
      // inline image: through ID, the binary data, and EI (whitespace EI whitespace-or-end)
      let k = i;
      while (k < n) {
        if (src[k] === 0x49 && src[k + 1] === 0x44 && WS.has(src[k + 2] ?? 0x20) && (k === 0 || WS.has(src[k - 1]))) {
          k += 3;
          break;
        }
        k++;
      }
      let e = k;
      while (e < n) {
        if (src[e] === 0x45 && src[e + 1] === 0x49 && WS.has(src[e - 1]) && (e + 2 >= n || WS.has(src[e + 2]) || DELIM.has(src[e + 2]))) {
          e += 2;
          break;
        }
        e++;
      }
      out.push({ operands: [], op: 'BI', start, end: e });
      operands = [];
      start = -1;
      i = e;
      continue;
    }
    out.push({ operands, op: t, start, end: i });
    operands = [];
    start = -1;
  }
  return out;
}

// ---- the inverter ----

export class Inverter {
  private seen = new Set<string>();
  stats: NegativeStats = { pages: 0, forms: 0, images: 0, images_skipped: 0 };
  constructor(
    private lib: Lib,
    private ctx: PDFContext,
  ) {}

  private firstVisit(ref: PDFRef | undefined): boolean {
    if (!ref) return true;
    const key = ref.toString();
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }

  private lookup(obj: PDFObject | undefined): PDFObject | undefined {
    return obj instanceof this.lib.PDFRef ? this.ctx.lookup(obj) : obj;
  }

  private num(v: PDFObject | undefined): number {
    return v instanceof this.lib.PDFNumber ? v.asNumber() : 0;
  }

  resolveSpace(cs: PDFObject | undefined, resources?: PDFDict): Space {
    const { PDFName, PDFArray, PDFDict } = this.lib;
    cs = this.lookup(cs);
    if (cs instanceof PDFName) {
      const key = cs.decodeText();
      if (DEVICE[key]) return DEVICE[key];
      const table = resources ? this.lookup(resources.get(PDFName.of('ColorSpace'))) : undefined;
      if (!(table instanceof PDFDict)) return UNKNOWN;
      const entry = table.get(cs);
      if (!entry) return UNKNOWN;
      return this.resolveSpace(entry, resources);
    }
    if (cs instanceof PDFArray && cs.size() > 0) {
      const head = this.lookup(cs.get(0));
      const kind = head instanceof PDFName ? head.decodeText() : '';
      switch (kind) {
        case 'ICCBased': {
          const stream = this.lookup(cs.get(1));
          const n = stream instanceof this.lib.PDFStream ? this.num(this.lookup(stream.dict.get(PDFName.of('N')))) : 0;
          return { family: BY_COMPONENTS[n] ?? 'Unknown', n };
        }
        case 'CalGray':
          return DEVICE.DeviceGray;
        case 'CalRGB':
          return DEVICE.DeviceRGB;
        case 'Separation':
          return { family: 'Separation', n: 1 };
        case 'DeviceN': {
          const names = this.lookup(cs.get(1));
          return { family: 'DeviceN', n: names instanceof PDFArray ? names.size() : 1 };
        }
        case 'Pattern':
          if (cs.size() > 1) return { ...this.resolveSpace(cs.get(1), resources), pattern: true };
          return DEVICE.Pattern;
        default:
          return { family: kind, n: 0 };
      }
    }
    return UNKNOWN;
  }

  /** Rewrite the colour operators of one content stream; everything else is copied byte for byte. */
  invertContent(src: Uint8Array, resources?: PDFDict): Uint8Array {
    const parts: (Uint8Array | string)[] = [];
    let fill: Space = DEVICE.DeviceGray;
    let stroke: Space = DEVICE.DeviceGray;
    const saved: [Space, Space][] = [];
    const emitOriginal = (ins: Instruction) => parts.push(src.subarray(ins.start, ins.end), '\n');
    for (const ins of tokenize(src)) {
      const op = ins.op;
      switch (op) {
        case 'q':
          saved.push([fill, stroke]);
          emitOriginal(ins);
          break;
        case 'Q':
          if (saved.length) [fill, stroke] = saved.pop()!;
          emitOriginal(ins);
          break;
        case 'g':
        case 'G':
        case 'rg':
        case 'RG':
        case 'k':
        case 'K': {
          const space = DEVICE[SHORT_OPS[op.toLowerCase()]];
          if (op === op.toLowerCase()) fill = space;
          else stroke = space;
          const nums = ins.operands.filter((t) => t.kind === 'num').map((t) => t.value!);
          parts.push(`${inverted(space.family, nums).join(' ')} ${op}\n`);
          break;
        }
        case 'cs':
        case 'CS': {
          const name = ins.operands[0];
          const space = name && name.kind === 'name' ? this.resolveSpace(this.lib.PDFName.of(name.text.slice(1)), resources) : UNKNOWN;
          if (op === 'cs') fill = space;
          else stroke = space;
          emitOriginal(ins);
          // Selecting a space resets the colour to its default (usually black)
          const start = initialColour(space);
          if (INVERTIBLE.has(space.family) && start.length) parts.push(`${inverted(space.family, start).join(' ')} ${op === 'cs' ? 'scn' : 'SCN'}\n`);
          break;
        }
        case 'sc':
        case 'scn':
        case 'SC':
        case 'SCN': {
          const space = op === op.toLowerCase() ? fill : stroke;
          if (INVERTIBLE.has(space.family)) {
            const nums = ins.operands.filter((t) => t.kind === 'num').map((t) => t.value!);
            const names = ins.operands.filter((t) => t.kind !== 'num').map((t) => t.text);
            parts.push(`${[...inverted(space.family, nums), ...names].join(' ')} ${op}\n`);
          } else emitOriginal(ins);
          break;
        }
        default:
          emitOriginal(ins);
      }
    }
    const enc = new TextEncoder();
    const chunks = parts.map((p) => (typeof p === 'string' ? enc.encode(p) : p));
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let p = 0;
    for (const c of chunks) {
      out.set(c, p);
      p += c.length;
    }
    return out;
  }

  private decode(stream: PDFStream): Uint8Array {
    if (stream instanceof this.lib.PDFRawStream) return this.lib.decodePDFRawStream(stream).decode();
    return stream.getContents();
  }

  /** Replace a stream's bytes in place (recompressed), keeping its dictionary and references. */
  private rewrite(stream: PDFRawStream, bytes: Uint8Array) {
    const { PDFName } = this.lib;
    const packed = this.ctx.flateStream(bytes);
    (stream as unknown as { contents: Uint8Array }).contents = packed.contents;
    stream.dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
    stream.dict.delete(PDFName.of('DecodeParms'));
    stream.dict.set(PDFName.of('Length'), this.ctx.obj(packed.contents.length));
  }

  processPage(page: import('pdf-lib').PDFPage, background: boolean) {
    const { PDFName, PDFArray, PDFStream } = this.lib;
    const node = page.node;
    const resources = node.Resources();
    const contents = node.Contents();
    const streams: PDFStream[] = [];
    if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i++) {
        const s = this.lookup(contents.get(i));
        if (s instanceof PDFStream) streams.push(s);
      }
    } else if (contents instanceof PDFStream) streams.push(contents);
    const body = streams.map((s) => this.invertContent(this.decode(s), resources));

    let prefix = '';
    if (background) {
      const { x, y, width, height } = page.getMediaBox();
      prefix += `q 0 g ${x} ${y} ${width} ${height} re f Q\n`;
    }
    // Unset colours default to black, whose negative is white
    prefix += '1 g 1 G\n';
    const enc = new TextEncoder().encode(prefix);
    const joined = new Uint8Array(enc.length + body.reduce((n, b) => n + b.length + 1, 0));
    joined.set(enc, 0);
    let p = enc.length;
    for (const b of body) {
      joined.set(b, p);
      p += b.length;
      joined[p++] = 0x0a;
    }
    node.set(PDFName.of('Contents'), this.ctx.register(this.ctx.flateStream(joined)));
    this.stats.pages++;
    if (resources) this.processResources(resources);
  }

  private processForm(stream: PDFRawStream, parentResources?: PDFDict) {
    const { PDFName, PDFDict } = this.lib;
    const own = this.lookup(stream.dict.get(PDFName.of('Resources')));
    const resources = own instanceof PDFDict ? own : parentResources;
    this.rewrite(stream, this.invertContent(this.decode(stream), resources));
    this.stats.forms++;
    if (resources) this.processResources(resources);
  }

  private processResources(resources: PDFDict) {
    const { PDFName, PDFDict, PDFRef, PDFRawStream } = this.lib;
    const xobjects = this.lookup(resources.get(PDFName.of('XObject')));
    if (xobjects instanceof PDFDict) {
      for (const [, value] of xobjects.entries()) {
        const ref = value instanceof PDFRef ? value : undefined;
        const xobj = this.lookup(value);
        if (!(xobj instanceof PDFRawStream) || !this.firstVisit(ref)) continue;
        const subtype = this.lookup(xobj.dict.get(PDFName.of('Subtype')));
        const kind = subtype instanceof PDFName ? subtype.decodeText() : '';
        if (kind === 'Image') this.invertImage(xobj);
        else if (kind === 'Form') this.processForm(xobj, resources);
      }
    }
    const patterns = this.lookup(resources.get(PDFName.of('Pattern')));
    if (patterns instanceof PDFDict) {
      for (const [, value] of patterns.entries()) {
        const ref = value instanceof PDFRef ? value : undefined;
        const pattern = this.lookup(value);
        if (!(pattern instanceof PDFRawStream)) continue;
        // Type 1 + PaintType 1 = coloured tiling pattern with its own content stream
        if (this.num(this.lookup(pattern.dict.get(PDFName.of('PatternType')))) === 1 && this.num(this.lookup(pattern.dict.get(PDFName.of('PaintType')))) === 1 && this.firstVisit(ref))
          this.processForm(pattern, resources);
      }
    }
  }

  private invertImage(image: PDFRawStream) {
    const { PDFName, PDFBool, PDFArray } = this.lib;
    const mask = this.lookup(image.dict.get(PDFName.of('ImageMask')));
    if (mask instanceof PDFBool && mask.asBoolean()) return; // stencil masks are painted with the fill colour, already inverted
    const cs = image.dict.get(PDFName.of('ColorSpace'));
    const space = cs ? this.resolveSpace(cs) : UNKNOWN;
    if (!INVERTIBLE_IMAGES.has(space.family)) {
      this.stats.images_skipped++;
      return;
    }
    const existing = this.lookup(image.dict.get(PDFName.of('Decode')));
    const decode = existing instanceof PDFArray ? existing.asArray().map((v) => this.num(this.lookup(v))) : Array.from({ length: space.n * 2 }, (_, i) => i % 2);
    // Swapping each [min max] pair in /Decode inverts the image without recompressing it
    image.dict.set(PDFName.of('Decode'), this.ctx.obj(decode.map((_, i) => decode[i ^ 1])));
    this.stats.images++;
  }
}

export async function pdfToNegative(bytes: Uint8Array, background = true): Promise<{ bytes: Uint8Array; stats: NegativeStats }> {
  const lib = await import('pdf-lib');
  const doc = await lib.PDFDocument.load(bytes, { ignoreEncryption: false });
  const inverter = new Inverter(lib, doc.context);
  for (const page of doc.getPages()) inverter.processPage(page, background);
  return { bytes: await doc.save(), stats: inverter.stats };
}

export function describeStats(s: NegativeStats): string {
  const parts = [`${s.pages} page${s.pages === 1 ? '' : 's'}`];
  if (s.forms) parts.push(`${s.forms} form${s.forms === 1 ? '' : 's'}`);
  if (s.images) parts.push(`${s.images} image${s.images === 1 ? '' : 's'}`);
  if (s.images_skipped) parts.push(`${s.images_skipped} image${s.images_skipped === 1 ? '' : 's'} skipped`);
  return parts.join(', ');
}
