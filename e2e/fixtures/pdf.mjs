// Test PDFs, generated in code so no binary files live in the repo.
// makePdf(pages, opts) returns a Buffer with `pages` pages. Each page shows a
// drawing-like frame, a title block and its label, so a viewer test can see
// which page is on screen.
//   opts.labels      page labels (default "Page 1", "Page 2", …)
//   opts.compressed  write the objects in an object stream with a
//                    compressed cross-reference stream (PDF 1.5 style), the
//                    way SolidWorks and most scanners save
//   opts.size        [width, height] in points (default A4 landscape)
import { deflateSync } from 'node:zlib';

export function makePdf(pages = 1, opts = {}) {
  const [w, h] = opts.size ?? [842, 595];
  const labels = opts.labels ?? Array.from({ length: pages }, (_, i) => `Page ${i + 1}`);
  // object numbers: 1 catalog, 2 pages, 3 font, then (page, content) pairs
  const objs = new Map();
  const kids = [];
  objs.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let i = 0; i < pages; i++) {
    const pageNum = 4 + i * 2;
    const contentNum = pageNum + 1;
    kids.push(`${pageNum} 0 R`);
    const label = String(labels[i] ?? `Page ${i + 1}`).replace(/[()\\]/g, '');
    const ops = [
      '2 w 20 20 ' + (w - 40) + ' ' + (h - 40) + ' re S',
      '1 w ' + (w - 300) + ' 20 280 70 re S',
      `120 ${h / 2 - 80} 260 160 re S`,
      `250 ${h / 2} 60 0 360 arc`.replace(/.*/, `250 ${h / 2 + 50} m 250 ${h / 2 - 50} l S`),
      `BT /F1 28 Tf 60 ${h - 80} Td (${label}) Tj ET`,
      `BT /F1 12 Tf ${w - 290} 50 Td (SHEET ${i + 1} OF ${pages}) Tj ET`,
    ].join('\n');
    objs.set(contentNum, { stream: Buffer.from(ops, 'latin1') });
    objs.set(pageNum, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentNum} 0 R >>`);
  }
  objs.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
  objs.set(2, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`);
  const size = 4 + pages * 2;

  const parts = [Buffer.from('%PDF-1.7\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let length = parts[0].length;
  const offsets = new Map();
  const write = (s) => {
    const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1');
    parts.push(b);
    length += b.length;
  };
  const writeObj = (num, body) => {
    offsets.set(num, length);
    if (typeof body === 'string') write(`${num} 0 obj\n${body}\nendobj\n`);
    else {
      write(`${num} 0 obj\n<< /Length ${body.stream.length} >>\nstream\n`);
      write(body.stream);
      write('\nendstream\nendobj\n');
    }
  };

  if (!opts.compressed) {
    for (let n = 1; n < size; n++) writeObj(n, objs.get(n));
    const xrefAt = length;
    let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let n = 1; n < size; n++) xref += `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n`;
    write(xref + `trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
    return Buffer.concat(parts);
  }

  // Dictionaries go in one object stream; content streams stay as plain objects.
  const objStmNum = size;
  const xrefNum = size + 1;
  const inStream = [...objs.keys()].filter((n) => typeof objs.get(n) === 'string').sort((a, b) => a - b);
  let header = '';
  let body = '';
  const index = new Map();
  inStream.forEach((n, i) => {
    index.set(n, i);
    header += `${n} ${body.length} `;
    body += objs.get(n) + '\n';
  });
  for (const n of [...objs.keys()].sort((a, b) => a - b)) if (typeof objs.get(n) !== 'string') writeObj(n, objs.get(n));
  const stmData = deflateSync(Buffer.from(header + body, 'latin1'));
  offsets.set(objStmNum, length);
  write(`${objStmNum} 0 obj\n<< /Type /ObjStm /N ${inStream.length} /First ${header.length} /Filter /FlateDecode /Length ${stmData.length} >>\nstream\n`);
  write(stmData);
  write('\nendstream\nendobj\n');

  // cross-reference stream, W [1 4 2], PNG "Up" predictor like Acrobat writes
  const xrefAt = length;
  offsets.set(xrefNum, xrefAt);
  const rows = [];
  for (let n = 0; n <= xrefNum; n++) {
    const row = Buffer.alloc(7);
    if (n === 0) {
      row[0] = 0;
      row.writeUInt16BE(65535, 5);
    } else if (index.has(n)) {
      row[0] = 2;
      row.writeUInt32BE(objStmNum, 1);
      row.writeUInt16BE(index.get(n), 5);
    } else {
      row[0] = 1;
      row.writeUInt32BE(offsets.get(n), 1);
    }
    rows.push(row);
  }
  const predicted = [];
  let prev = Buffer.alloc(7);
  for (const row of rows) {
    const out = Buffer.alloc(8);
    out[0] = 2;
    for (let i = 0; i < 7; i++) out[i + 1] = (row[i] - prev[i]) & 0xff;
    predicted.push(out);
    prev = row;
  }
  const xrefData = deflateSync(Buffer.concat(predicted));
  write(`${xrefNum} 0 obj\n<< /Type /XRef /Size ${xrefNum + 1} /W [1 4 2] /Root 1 0 R /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns 7 >> /Length ${xrefData.length} >>\nstream\n`);
  write(xrefData);
  write(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`);
  return Buffer.concat(parts);
}
