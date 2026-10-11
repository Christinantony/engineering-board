// CSV reading and writing, tolerant of what Excel produces: a UTF-8 byte-order
// mark, CRLF line endings, quoted fields with commas and line breaks, and
// semicolon or tab separators (Excel uses ';' in many regional settings).

export function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const counts = [',', ';', '\t'].map((d) => ({ d, n: firstLine.split(d).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : ',';
}

/** Parse CSV text into rows of strings. Handles quotes, escaped quotes ("") and multi-line fields. */
export function parseCsv(input: string, delimiter = detectDelimiter(input.replace(/^﻿/, ''))): string[][] {
  const text = input.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') inQuotes = true;
    else if (c === delimiter) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  // drop completely empty lines (Excel adds them at the end)
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

/** Values that Excel would run as a formula get a leading apostrophe (CSV injection guard). */
function guard(v: string): string {
  return /^[=+@\t\r]/.test(v) ? `'${v}` : v;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    if (v == null) return '';
    const s = guard(String(v));
    return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // BOM so Excel opens UTF-8 (₹, °, ø, Ø…) correctly; CRLF for Windows
  return '﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Undo the export guard on import. */
export function unguard(v: string): string {
  return /^'[=+@]/.test(v) ? v.slice(1) : v;
}
