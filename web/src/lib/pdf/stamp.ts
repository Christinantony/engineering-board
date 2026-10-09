// Diagonal stamp (the team's PDF_STAMP.py): "[DRAFT]" across every page. The
// defaults are exactly that script's placement: the text starts a quarter of
// the way across and 40% down the page, rises at 45°, Helvetica at 12% of the
// page width, black at 30% opacity. Every value can be adjusted on the Tools
// page with a live preview. pdf-lib is loaded on demand so the rest of the
// board never pays for it.

export interface StampOptions {
  text: string;
  /** start of the text as a share of the page width, from the left (the script's 0.25) */
  x: number;
  /** start of the text as a share of the page height, from the top (the script's 0.4 = 1/2.5) */
  y: number;
  /** degrees, counter-clockwise (the script's 45) */
  angle: number;
  /** font size as a share of the page width (the script's 0.12) */
  size: number;
  /** 0–1 (the script's 0.3) */
  opacity: number;
  /** #rrggbb (the script's black) */
  color: string;
}

export const STAMP_DEFAULTS: StampOptions = { text: '[DRAFT]', x: 0.25, y: 0.4, angle: 45, size: 0.12, opacity: 0.3, color: '#000000' };

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

/** Keep the options within what a PDF can take, whatever the inputs say. */
export function cleanStampOptions(o: Partial<StampOptions>): StampOptions {
  const num = (v: unknown, dflt: number, min: number, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt);
  return {
    text: typeof o.text === 'string' && o.text.length ? o.text.slice(0, 200) : STAMP_DEFAULTS.text,
    x: num(o.x, STAMP_DEFAULTS.x, -1, 2),
    y: num(o.y, STAMP_DEFAULTS.y, -1, 2),
    angle: num(o.angle, STAMP_DEFAULTS.angle, -180, 180),
    size: num(o.size, STAMP_DEFAULTS.size, 0.005, 2),
    opacity: num(o.opacity, STAMP_DEFAULTS.opacity, 0, 1),
    color: /^#[0-9a-f]{6}$/i.test(String(o.color ?? '')) ? String(o.color).toLowerCase() : STAMP_DEFAULTS.color,
  };
}

export async function stampPdf(bytes: Uint8Array, options: Partial<StampOptions> = {}): Promise<{ bytes: Uint8Array; pages: number }> {
  const o = cleanStampOptions(options);
  const { PDFDocument, StandardFonts, rgb, degrees } = await import('pdf-lib');
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const [r, g, b] = hexToRgb(o.color);
  const pages = doc.getPages();
  for (const page of pages) {
    const { width, height } = page.getSize();
    // PyMuPDF measures from the top-left; pdf-lib from the bottom-left
    page.drawText(o.text, {
      x: width * o.x,
      y: height - height * o.y,
      size: width * o.size,
      font,
      color: rgb(r, g, b),
      opacity: o.opacity,
      rotate: degrees(o.angle),
    });
  }
  return { bytes: await doc.save(), pages: pages.length };
}

/** The first page alone, as its own small PDF: what the live preview stamps and draws. */
export async function firstPageOnly(bytes: Uint8Array): Promise<Uint8Array> {
  const { PDFDocument } = await import('pdf-lib');
  const src = await PDFDocument.load(bytes, { ignoreEncryption: false });
  const out = await PDFDocument.create();
  const [page] = await out.copyPages(src, [0]);
  out.addPage(page);
  return out.save();
}
