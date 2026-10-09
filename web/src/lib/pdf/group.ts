// Combine PDFs by page size (the team's group_pdfs_by_size.py): each file is
// classified by the size of its first page as A4, A3 or other (portrait or
// landscape, 5 pt tolerance) and every file of a size is merged into one
// combined_<size>.pdf, in the order the files were chosen.

import type { PDFDocument as PDFDocumentType } from 'pdf-lib';

export const PAGE_SIZES: Record<string, [number, number]> = {
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
};
export const DEFAULT_TOLERANCE_PT = 5;
export type SizeName = 'A4' | 'A3' | 'other';

export function classifyPageSize(widthPt: number, heightPt: number, tolerance = DEFAULT_TOLERANCE_PT): SizeName {
  const [short, long] = widthPt <= heightPt ? [widthPt, heightPt] : [heightPt, widthPt];
  for (const [name, [stdShort, stdLong]] of Object.entries(PAGE_SIZES)) {
    if (Math.abs(short - stdShort) <= tolerance && Math.abs(long - stdLong) <= tolerance) return name as SizeName;
  }
  return 'other';
}

export interface GroupInput {
  name: string;
  bytes: Uint8Array;
}

export interface GroupDetail {
  name: string;
  width: number;
  height: number;
  size: SizeName;
  pages: number;
  error?: string;
}

export interface GroupOutput {
  size: SizeName;
  name: string;
  files: string[];
  pages: number;
  bytes: Uint8Array;
}

export async function groupPdfsBySize(inputs: GroupInput[], tolerance = DEFAULT_TOLERANCE_PT): Promise<{ details: GroupDetail[]; outputs: GroupOutput[] }> {
  const { PDFDocument } = await import('pdf-lib');
  const details: GroupDetail[] = [];
  const groups: Record<SizeName, { name: string; doc: PDFDocumentType }[]> = { A4: [], A3: [], other: [] };
  for (const f of inputs) {
    try {
      const doc = await PDFDocument.load(f.bytes, { ignoreEncryption: false });
      const n = doc.getPageCount();
      if (!n) throw new Error(`${f.name} has no pages`);
      const { width, height } = doc.getPage(0).getMediaBox();
      const size = classifyPageSize(width, height, tolerance);
      details.push({ name: f.name, width, height, size, pages: n });
      groups[size].push({ name: f.name, doc });
    } catch (e) {
      details.push({ name: f.name, width: 0, height: 0, size: 'other', pages: 0, error: (e as Error).message });
    }
  }
  const outputs: GroupOutput[] = [];
  for (const size of ['A4', 'A3', 'other'] as SizeName[]) {
    const members = groups[size];
    if (!members.length) continue;
    const out = await PDFDocument.create();
    let pages = 0;
    for (const m of members) {
      const copied = await out.copyPages(m.doc, m.doc.getPageIndices());
      for (const p of copied) out.addPage(p);
      pages += copied.length;
    }
    outputs.push({ size, name: `combined_${size}.pdf`, files: members.map((m) => m.name), pages, bytes: await out.save() });
  }
  return { details, outputs };
}
