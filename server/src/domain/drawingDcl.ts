// Drawing tools → Dimension checklist (decision #46): the team's
// drawing_to_dcl.py, run unchanged on the host PC with the host's own Python.
//
// The script is shipped byte for byte in app\tools\ and called exactly as on
// the command line (`py -3.14 drawing_to_dcl.py drawing.pdf --format docx …`):
// the board only uploads the PDF into a private folder, passes the options the
// person chose as the script's own arguments, and sends back the .docx/.xlsx
// it writes next to the PDF, with what it printed (the title block it read,
// the rows, and the text it did not use) so the checklist can be checked.
// Python and its packages (pymupdf, openpyxl, python-docx; rapidocr and
// onnxruntime for drawings without selectable text) are installed on the host
// by the admin; the board says what is missing instead of failing half-way.
// node:child_process runs it, so the server still has no dependencies (#1).

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from '../lib/core.ts';

export const DCL_SCRIPT = 'drawing_to_dcl.py';

export interface DclStatus {
  /** ready: Python and the script's packages are there; no_script: the app folder is incomplete */
  state: 'ready' | 'no_python' | 'missing_packages' | 'no_script';
  /** the command that runs Python, as typed in a command prompt */
  command: string | null;
  /** the same, as the program and its arguments (a path may contain spaces) */
  argv: string[] | null;
  version: string | null;
  /** pip names of what the script needs and the host lacks */
  missing: string[];
  /** pip names needed only for drawings without selectable text (OCR) */
  ocr_missing: string[];
  /** Pillow: openpyxl needs it to put the logo into the Excel file */
  pillow: boolean;
  checked_at: string;
}

/** Runs Python: resolves with what it printed, rejects with an HttpError. */
export type PythonRunner = (command: string[], args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<{ stdout: string; stderr: string }>;

/** The real runner: the host's Python, with UTF-8 output so Ø, ± and ° survive a Windows pipe. */
export const runPython: PythonRunner = (command, args, { cwd, timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile(
      command[0],
      [...command.slice(1), ...args],
      { cwd, windowsHide: true, timeout: timeoutMs, maxBuffer: 8 << 20, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout: String(stdout), stderr: String(stderr) });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
        if (e.code === 'ENOENT') return reject(new HttpError(501, 'python_missing', `Python was not found on the host PC (${command.join(' ')}).`));
        if (e.killed) return reject(new HttpError(504, 'dcl_timeout', `The script took longer than ${Math.round(timeoutMs / 60000)} minutes and was stopped.`));
        const err2 = new HttpError(500, 'dcl_failed', lastLines(String(stderr) || String(stdout) || err.message));
        (err2 as HttpError & { output?: string }).output = String(stdout);
        reject(err2);
      },
    );
  });

const lastLines = (s: string) =>
  s
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-4)
    .join(' ')
    .slice(0, 600) || 'no details';

/** The Pythons to try, in order: config.json's "python" if set, else the launcher the script's own usage names. */
export function pythonCandidates(configured: string | string[] | undefined, platform = process.platform): string[][] {
  if (configured) return [Array.isArray(configured) ? configured : [configured]];
  return platform === 'win32' ? [['py', '-3.14'], ['py', '-3'], ['python']] : [['python3'], ['python']];
}

const PROBE = `import sys, importlib.util as u
need = {"pymupdf": "pymupdf", "openpyxl": "openpyxl", "docx": "python-docx"}
ocr = {"rapidocr": "rapidocr", "onnxruntime": "onnxruntime", "cv2": "opencv-python", "numpy": "numpy"}
print(sys.version.split()[0])
print(",".join(p for m, p in need.items() if u.find_spec(m) is None))
print(",".join(p for m, p in ocr.items() if u.find_spec(m) is None))
print("yes" if u.find_spec("PIL") else "no")`;

/** What the host can do: the first Python that runs, and which of the script's packages it has. */
export async function probeDcl(candidates: string[][], scriptPath: string | null, run: PythonRunner = runPython, now = () => new Date()): Promise<DclStatus> {
  const base = { command: null, argv: null, version: null, missing: [], ocr_missing: [], pillow: false, checked_at: now().toISOString() };
  if (!scriptPath) return { ...base, state: 'no_script' };
  let best: DclStatus | null = null;
  for (const cmd of candidates) {
    let out: string;
    try {
      out = (await run(cmd, ['-c', PROBE], { cwd: process.cwd(), timeoutMs: 30_000 })).stdout;
    } catch {
      continue;
    }
    const [version = '', missing = '', ocr = '', pil = ''] = out.split(/\r?\n/).map((l) => l.trim());
    const s: DclStatus = {
      state: missing ? 'missing_packages' : 'ready',
      command: cmd.map((c) => (/\s/.test(c) ? `"${c}"` : c)).join(' '),
      argv: cmd,
      version: version || null,
      missing: missing ? missing.split(',') : [],
      ocr_missing: ocr ? ocr.split(',') : [],
      pillow: pil === 'yes',
      checked_at: base.checked_at,
    };
    if (s.state === 'ready') return s;
    best ??= s; // the first Python found, if none has the packages
  }
  return best ?? { ...base, state: 'no_python' };
}

export interface DclOptions {
  format: 'docx' | 'xlsx' | 'both';
  /** empty: the script takes it from the drawing number */
  project: string;
  part_no: string;
  weight: string;
  samples: number;
  ocr: boolean;
  rotate: '' | '0' | '90' | '180' | '270';
}

const text = (v: string | null, label: string, max: number) => {
  const s = (v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (s.length > max) throw new HttpError(400, 'bad_request', `${label} is longer than ${max} characters.`);
  return s;
};

/** The options from the request's query string, checked as the script's argparse would check them. */
export function dclOptions(q: URLSearchParams): DclOptions {
  const format = q.get('format') ?? 'docx';
  if (format !== 'docx' && format !== 'xlsx' && format !== 'both') throw new HttpError(400, 'bad_request', 'Choose Word, Excel or both.');
  const samples = Number(q.get('samples') ?? 10);
  if (!Number.isInteger(samples) || samples < 8 || samples > 20) throw new HttpError(400, 'bad_request', 'The number of SL № columns must be from 8 to 20.');
  const rotate = q.get('rotate') ?? '';
  if (!['', '0', '90', '180', '270'].includes(rotate)) throw new HttpError(400, 'bad_request', 'Turn the sheet by 0, 90, 180 or 270 degrees, or leave it to the script.');
  return {
    format,
    // empty: the script takes the project from the drawing number
    project: text(q.get('project'), 'Project', 100),
    part_no: text(q.get('part_no'), 'Part number', 100),
    weight: text(q.get('weight'), 'Weight', 100),
    samples,
    ocr: q.get('ocr') === '1',
    rotate: rotate as DclOptions['rotate'],
  };
}

/**
 * The script's command line for these options. Values go as --name=value, so
 * one starting with "-" is still a value, and execFile passes them without a
 * shell. The logo is the admin's (Admin → Tools), or the script's own default.
 */
export function dclArgs(script: string, pdf: string, o: DclOptions, logo: string | null): string[] {
  const a = [script, pdf, `--format=${o.format}`];
  if (o.project) a.push(`--project=${o.project}`);
  a.push(`--samples=${o.samples}`);
  if (o.part_no) a.push(`--part-no=${o.part_no}`);
  if (o.weight) a.push(`--weight=${o.weight}`);
  if (logo) a.push(`--logo=${logo}`);
  if (o.ocr) a.push('--ocr');
  if (o.rotate) a.push(`--rotate=${o.rotate}`);
  return a;
}

export interface DclFile {
  name: string;
  /** base64 */
  data: string;
}

/** One drawing at a time: OCR in particular uses the whole CPU. */
export class DclQueue {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private workDir: string,
    private run: PythonRunner,
  ) {}

  /** A private folder for one upload. */
  newDir(): string {
    mkdirSync(this.workDir, { recursive: true });
    return mkdtempSync(join(this.workDir, 'dcl-'));
  }

  convert(command: string[], script: string, pdfPath: string, dir: string, o: DclOptions, logo: string | null): Promise<{ files: DclFile[]; report: string; warnings: string }> {
    const job = async () => {
      const name = pdfPath.slice(dir.length + 1);
      const { stdout, stderr } = await this.run(command, dclArgs(script, name, o, logo), { cwd: dir, timeoutMs: 10 * 60_000 });
      // what the script wrote next to the drawing: <name>.docx and/or <name>.xlsx
      const stem = name.replace(/\.pdf$/i, '');
      const files = readdirSync(dir)
        .filter((f) => f !== name && f.startsWith(stem) && /\.(docx|xlsx)$/i.test(f))
        .sort()
        .map((f) => ({ name: f, data: readFileSync(join(dir, f)).toString('base64') }));
      if (!files.length) throw new HttpError(500, 'dcl_failed', `The script finished but wrote no checklist. ${lastLines(stderr || stdout)}`);
      return { files, report: stdout, warnings: stderr.trim() };
    };
    const p = this.tail.then(job, job);
    this.tail = p.catch(() => {});
    return p;
  }
}

/** The upload's file name: kept, since the script names the checklist after it. */
export function cleanPdfName(raw: string | null): string {
  const name = (raw ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^[.\s-]+/, '').trim().slice(0, 150);
  if (!name || !/\.pdf$/i.test(name)) throw new HttpError(400, 'not_pdf', 'Choose a drawing PDF (.pdf).');
  return name;
}

/** Where the script is: app\tools\ in the package, tools\ in the source. */
export function findScript(roots: string[]): string | null {
  return roots.map((r) => join(r, DCL_SCRIPT)).find((p) => existsSync(p)) ?? null;
}

export const LOGO_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg' };

/** The image's type from its first bytes: PNG or JPEG, else null. */
export function logoType(bytes: Buffer): 'png' | 'jpg' | null {
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  return null;
}
