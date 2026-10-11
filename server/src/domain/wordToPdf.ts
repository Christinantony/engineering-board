// Word to PDF (the team's DOC_to_PDF.py): the host PC's own Microsoft Word
// does the conversion, driven through PowerShell and COM exactly as that
// script drives it (Documents.Open read-only, ExportAsFixedFormat optimised for
// print, SaveAs PDF as the fallback). Nothing is installed: Word, PowerShell
// and node:child_process are all already on the host. Conversions run one at a
// time, since one Word instance serves them all. On a host without Windows or
// Word the tool says so instead of failing half-way.

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from '../lib/core.ts';

export type WordStatus = 'available' | 'not_windows' | 'no_word';

export type WordConverter = (input: string, output: string) => Promise<void>;

/** What the Word tool can do on this host (checked once per start). */
export async function probeWord(): Promise<WordStatus> {
  if (process.platform !== 'win32') return 'not_windows';
  return new Promise((resolve) => {
    execFile('reg', ['query', 'HKEY_CLASSES_ROOT\\Word.Application'], { windowsHide: true, timeout: 10_000 }, (err) => resolve(err ? 'no_word' : 'available'));
  });
}

const SCRIPT = `param([string]$In, [string]$Out)
$ErrorActionPreference = 'Stop'
# WdExportFormat 17 = PDF, WdExportOptimizeFor 0 = print, WdExportRange 0 = whole document, WdExportItem 0 = content, WdExportCreateBookmarks 0 = none
$word = New-Object -ComObject Word.Application
try {
  try { $word.Visible = $false } catch {}
  try { $word.DisplayAlerts = 0 } catch {}
  $doc = $word.Documents.Open($In, $false, $true, $false)
  try {
    try {
      $doc.ExportAsFixedFormat($Out, 17, $false, 0, 0, 0, 0, 0, $true, $true, 0, $true, $true, $false)
    } catch {
      $doc.SaveAs([ref]$Out, [ref]17)
    }
  } finally {
    $doc.Close($false)
  }
} finally {
  $word.Quit($false)
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}
if (-not (Test-Path -LiteralPath $Out)) { throw "Word reported success but no PDF was written." }
`;

/** The real converter: PowerShell drives Word on the host. */
export const convertWithWord: WordConverter = (input, output) =>
  new Promise((resolve, reject) => {
    const dir = mkdtempSync(join(process.env.TEMP ?? process.env.TMP ?? '.', 'eb-word-'));
    const script = join(dir, 'convert.ps1');
    writeFileSync(script, SCRIPT, 'utf8');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-In', input, '-Out', output],
      { windowsHide: true, timeout: 180_000, maxBuffer: 1 << 20 },
      (err, _stdout, stderr) => {
        rmSync(dir, { recursive: true, force: true });
        if (!err) return resolve();
        const timedOut = (err as NodeJS.ErrnoException & { killed?: boolean }).killed;
        const detail = String(stderr || err.message).trim().split('\n').slice(-3).join(' ').slice(0, 400);
        reject(new HttpError(timedOut ? 504 : 500, 'word_failed', timedOut ? 'Microsoft Word took longer than 3 minutes; the conversion was stopped.' : `Microsoft Word could not convert the file: ${detail || 'no details'}`));
      },
    );
  });

/** One conversion at a time: Word serves them all. */
export class WordQueue {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private convert: WordConverter,
    private workDir: string,
  ) {}

  /** Convert the uploaded document; resolves with the PDF's path inside `dir` (the caller removes the directory). */
  run(uploadPath: string, originalName: string): Promise<string> {
    const output = join(uploadPath.replace(/[^\\/]+$/, ''), originalName.replace(/\.[^.]+$/, '') + '.pdf');
    const job = this.tail.then(
      () => this.convert(uploadPath, output),
      () => this.convert(uploadPath, output),
    );
    this.tail = job.catch(() => {});
    return job.then(() => output);
  }

  /** A private directory for one upload. */
  newDir(): string {
    mkdirSync(this.workDir, { recursive: true });
    return mkdtempSync(join(this.workDir, 'word-'));
  }
}

export const WORD_EXTENSIONS = ['.doc', '.docx'];

/** The upload's file name, kept for Word (which needs the right extension) and the PDF's name. */
export function cleanWordName(raw: string | null): string {
  const name = (raw ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 150);
  const ext = name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
  if (!name || !WORD_EXTENSIONS.includes(ext)) throw new HttpError(400, 'not_word', 'Choose a Word document (.doc or .docx).');
  return name;
}
