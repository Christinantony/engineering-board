// Drawing tools (decision #46): the team's drawing scripts as one page with
// tabs. The first is the dimension checklist: drawing_to_dcl.py, run
// unchanged on the host PC with the host's Python. The drawing is sent to the
// board, the script writes the Word and/or Excel checklist, and both come back
// with what the script printed, so the rows can be checked against the sheet.

import { useEffect, useState } from 'react';
import { ApiError, post } from '../../lib/api.ts';
import { navigate, useLocation } from '../../lib/router.ts';
import { invalidate, useQuery } from '../../lib/store.ts';
import { toast, toastError } from '../../lib/toasts.ts';
import { makeZip } from '../../lib/pdf/zip.ts';
import { Spinner } from '../../components/bits.tsx';
import { FilePicker, PickedList, download, typeOf, type Picked } from './PdfTools.tsx';

const TABS = [{ id: 'dcl', label: 'Dimension checklist (DCL)' }] as const;

export function DrawingTools() {
  const { params } = useLocation();
  const tab = TABS.find((t) => t.id === params.get('tab'))?.id ?? 'dcl';
  return (
    <div className="pdf-tools">
      <nav className="pdf-tabs" aria-label="Drawing tools">
        {TABS.map((t) => (
          <a
            key={t.id}
            href={`/tools?tool=drawing&tab=${t.id}`}
            className={t.id === tab ? 'on' : ''}
            aria-current={t.id === tab ? 'page' : undefined}
            onClick={(e: any) => {
              e.preventDefault();
              navigate(`/tools?tool=drawing&tab=${t.id}`);
            }}
          >
            {t.label}
          </a>
        ))}
      </nav>
      {tab === 'dcl' && <DclTool />}
    </div>
  );
}

export interface DclStatus {
  state: 'ready' | 'no_python' | 'missing_packages' | 'no_script';
  command: string | null;
  version: string | null;
  missing: string[];
  ocr_missing: string[];
  pillow: boolean;
  checked_at: string;
  logo: boolean;
}

interface Options {
  format: 'docx' | 'xlsx' | 'both';
  project: string;
  part_no: string;
  weight: string;
  samples: number;
  ocr: boolean;
  rotate: '' | '0' | '90' | '180' | '270';
}

const DEFAULTS: Options = { format: 'docx', project: '', part_no: '', weight: '', samples: 10, ocr: false, rotate: '' };
const KEY = 'engineering-board-dcl';

function loadOptions(): Options {
  try {
    const raw = localStorage.getItem(KEY);
    // the part number and weight belong to one drawing, so they are not remembered
    return raw ? { ...DEFAULTS, ...JSON.parse(raw), part_no: '', weight: '' } : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

interface Done {
  name: string;
  files?: { name: string; bytes: Uint8Array }[];
  report?: string;
  warnings?: string;
  note?: string;
  error?: string;
}

const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Send one drawing; the answer is JSON with the checklist file(s) and what the script printed. */
function makeChecklist(file: Picked, o: Options): Promise<Done> {
  const q = new URLSearchParams({ name: file.name, format: o.format, project: o.project, samples: String(o.samples), rotate: o.rotate });
  if (o.part_no.trim()) q.set('part_no', o.part_no.trim());
  if (o.weight.trim()) q.set('weight', o.weight.trim());
  if (o.ocr) q.set('ocr', '1');
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/tools/drawing-to-dcl?${q}`);
    xhr.setRequestHeader('Content-Type', 'application/pdf');
    xhr.responseType = 'json';
    xhr.onerror = () => reject(new ApiError(0, 'network', "Can't reach the board server. Check that the host PC is on, then try again."));
    xhr.onload = () => {
      const body = xhr.response as any;
      if (xhr.status !== 200) return reject(new ApiError(xhr.status, body?.error ?? 'http', body?.message ?? `The server answered ${xhr.status}.`, body));
      resolve({
        name: file.name,
        files: (body.files as { name: string; data: string }[]).map((f) => ({ name: f.name, bytes: fromBase64(f.data) })),
        report: body.report,
        warnings: body.warnings,
        note: body.logo_left_out ? 'The logo was left out: putting it into the Excel file needs Pillow on the host PC (see above).' : undefined,
      });
    };
    xhr.send(new Blob([file.bytes as BlobPart], { type: 'application/pdf' }));
  });
}

function DclTool() {
  const status = useQuery<DclStatus>('/api/tools/drawing/status');
  const [files, setFiles] = useState<Picked[]>([]);
  const [o, setO] = useState<Options>(loadOptions);
  const [done, setDone] = useState<Done[]>([]);
  const [working, setWorking] = useState<string | null>(null);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...o, part_no: '', weight: '' }));
    } catch {
      /* private window */
    }
  }, [o]);
  const s = status.data;
  const ready = s?.state === 'ready';
  const set = (patch: Partial<Options>) => setO({ ...o, ...patch });

  const run = async () => {
    setDone([]);
    const out: Done[] = [];
    for (const f of files) {
      setWorking(f.name);
      try {
        out.push(await makeChecklist(f, { ...o, project: o.project.trim() || 'N/A' }));
      } catch (e) {
        out.push({ name: f.name, error: (e as Error).message || 'The checklist could not be made' });
      }
      setDone([...out]);
    }
    setWorking(null);
    const ok = out.filter((d) => d.files).length;
    toast(ok === out.length ? `Done: ${ok} checklist${ok === 1 ? '' : 's'}` : `${ok} of ${out.length} drawings done; see the list`, { kind: ok === out.length ? 'success' : 'error' });
  };
  const all = done.flatMap((d) => d.files ?? []);

  return (
    <section className="pdf-tool dcl-tool">
      <p className="muted">
        Builds a <strong>dimension checklist (DCL)</strong> from a CAD drawing PDF with the team's <code>drawing_to_dcl.py</code>, run unchanged on the host PC. It reads the title
        block (part name, drawing number, revision, material and the general tolerance table), the zone grid, and every dimension with its tolerance (Ø, R, angles, chamfers, inline
        and stacked tolerances; a leading * marks a key characteristic), turns hole and thread callouts into VERIFY rows, and writes the checklist as a Word or Excel file in the
        VT-F-DCL-01 format. Best from a vector PDF exported from CAD; a scan, or a sheet printed to PDF, is read with OCR.
      </p>
      <DclStatusPanel status={status.data} refresh={status.refresh} />

      <div className="dcl-options">
        <label>
          <span>Project</span>
          <input className="field-input" value={o.project} maxLength={100} placeholder="N/A" aria-label="Project" onChange={(e: any) => set({ project: e.target.value })} />
        </label>
        <label>
          <span>Part number</span>
          <input className="field-input" value={o.part_no} maxLength={100} placeholder="From the drawing number" aria-label="Part number" onChange={(e: any) => set({ part_no: e.target.value })} />
        </label>
        <label>
          <span>Weight</span>
          <input className="field-input" value={o.weight} maxLength={100} placeholder="e.g. 1822 ± 10 g (row left out if empty)" aria-label="Weight" onChange={(e: any) => set({ weight: e.target.value })} />
        </label>
        <label>
          <span>SL № columns</span>
          <input
            className="field-input narrow"
            type="number"
            min={8}
            max={20}
            step={1}
            value={o.samples}
            aria-label="Number of SL № columns"
            onChange={(e: any) => set({ samples: Math.min(20, Math.max(8, Math.round(Number(e.target.value) || 10))) })}
          />
        </label>
        <fieldset className="dcl-format">
          <legend>Checklist as</legend>
          {(
            [
              ['docx', 'Word'],
              ['xlsx', 'Excel'],
              ['both', 'Both'],
            ] as const
          ).map(([v, label]) => (
            <label key={v}>
              <input type="radio" name="dcl-format" checked={o.format === v} onChange={() => set({ format: v })} /> {label}
            </label>
          ))}
        </fieldset>
        <details className="dcl-more">
          <summary>Drawings without selectable text</summary>
          <label>
            <input type="checkbox" checked={o.ocr} aria-label="Read every page with OCR" onChange={(e: any) => set({ ocr: e.target.checked })} /> Read every page with OCR, even pages
            with selectable text
          </label>
          <label>
            Turn OCR pages{' '}
            <select className="field-input" value={o.rotate} aria-label="Turn OCR pages" onChange={(e: any) => set({ rotate: e.target.value })}>
              <option value="">as the script detects</option>
              <option value="0">0° (upright)</option>
              <option value="90">90° (printed sideways)</option>
              <option value="180">180°</option>
              <option value="270">270°</option>
            </select>
          </label>
          <p className="muted small">Pages without selectable text are read with OCR anyway; the sheet is turned upright first. Use these only when the result is wrong.</p>
        </details>
      </div>

      <div className="pdf-tool-row">
        <FilePicker accept=".pdf,application/pdf" onPick={(p) => setFiles([...files, ...p])} label="Choose drawing PDFs…" testId="pick-dcl" />
        <button type="button" className="btn btn-primary" disabled={!files.length || !!working || !ready} onClick={() => void run()}>
          {working ? `Reading ${working}…` : 'Make the checklist'}
        </button>
        {files.length > 0 && (
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => {
              setFiles([]);
              setDone([]);
            }}
          >
            Clear
          </button>
        )}
      </div>
      <PickedList files={files} onRemove={(i) => setFiles(files.filter((_, j) => j !== i))} />

      {done.length > 0 && (
        <div className="pdf-results dcl-results" data-testid="dcl-results">
          {done.map((d, i) => (
            <DclResult key={`${d.name}-${i}`} d={d} />
          ))}
          {all.length > 1 && (
            <button type="button" className="btn" onClick={() => download('dimension_checklists.zip', makeZip(all.map((f) => ({ name: f.name, data: f.bytes }))), 'application/zip')}>
              Download all (.zip)
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function DclResult({ d }: { d: Done }) {
  const [open, setOpen] = useState(false);
  // the script's report: rows, then "not used" text, then the output paths (which are the host's, so left out)
  const lines = (d.report ?? '').split(/\r?\n/).filter((l) => l.trim() && !/^\s*-> /.test(l));
  const notUsed = lines.filter((l) => /^\s*not used /.test(l)).length;
  const rows = lines.filter((l) => /^\s+[a-z]+\.\s/.test(l)).length;
  const verify = lines.filter((l) => /\sVERIFY\s/.test(l) && !/^\s*not used /.test(l)).length;
  return (
    <div className={`dcl-result${d.error ? ' pdf-result-error' : ''}`} data-drawing={d.name}>
      <div className="dcl-result-head">
        <strong className="pdf-file-name">{d.name}</strong>
        {d.error ? (
          <span className="form-error">{d.error}</span>
        ) : (
          <span className="muted small" data-testid="dcl-summary">
            {rows} dimension{rows === 1 ? '' : 's'}
            {verify ? `, ${verify} callout${verify === 1 ? '' : 's'} to verify` : ''}
            {notUsed ? `; ${notUsed} piece${notUsed === 1 ? '' : 's'} of text not used` : ''}
          </span>
        )}
        <span className="spacer" />
        {d.files?.map((f) => (
          <button key={f.name} type="button" className="btn btn-quiet btn-sm" onClick={() => download(f.name, f.bytes, typeOf(f.name))}>
            Download {f.name.split('.').pop()!.toUpperCase() === 'DOCX' ? 'Word' : 'Excel'}
          </button>
        ))}
      </div>
      {d.note && <p className="notice notice-warn small">{d.note}</p>}
      {d.files && (
        <>
          <button type="button" className="link-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Hide what the script read' : 'Show what the script read'}
          </button>
          {open && (
            <pre className="dcl-report" data-testid="dcl-report">
              {lines.join('\n')}
              {d.warnings ? `\n\n${d.warnings}` : ''}
            </pre>
          )}
          <p className="muted small">Check every row against the drawing before the checklist is issued: "not used" lists the text the script left out.</p>
        </>
      )}
    </div>
  );
}

/** What the host PC's Python can do, and what to install when it can't. */
export function DclStatusPanel({ status, refresh }: { status: DclStatus | undefined; refresh: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!status) return <Spinner />;
  const s = status;
  const py = s.command ?? 'py -3.14';
  const again = async () => {
    setBusy(true);
    try {
      await post('/api/tools/drawing/status');
      invalidate('/api/tools/drawing/status');
      refresh();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const check = (
    <button type="button" className="btn btn-small" disabled={busy} onClick={() => void again()}>
      {busy ? 'Checking…' : 'Check again'}
    </button>
  );
  if (s.state !== 'ready')
    return (
      <div className="notice notice-warn dcl-status" data-testid="dcl-unavailable">
        {s.state === 'no_script' ? (
          <p>The drawing tools are missing from the board's app folder. Install the update again (replace the whole app folder).</p>
        ) : s.state === 'no_python' ? (
          <>
            <p>
              <strong>Not available yet:</strong> Python is not installed on the host PC. Whoever looks after the board installs it once, on the host PC:
            </p>
            <ol>
              <li>
                Python 3.14 from <code>python.org</code> (the installer's defaults are fine; it adds the <code>py</code> launcher).
              </li>
              <li>
                In a command prompt: <code>py -3.14 -m pip install pymupdf python-docx openpyxl pillow</code>
              </li>
              <li>
                For drawings without selectable text, also: <code>py -3.14 -m pip install rapidocr onnxruntime</code>
              </li>
            </ol>
          </>
        ) : (
          <>
            <p>
              <strong>Not available yet:</strong> the host PC's Python ({py}, version {s.version}) lacks {s.missing.join(', ')}. On the host PC, in a command prompt:
            </p>
            <p>
              <code>
                {py} -m pip install {s.missing.join(' ')}
              </code>
            </p>
          </>
        )}
        <p>{check}</p>
      </div>
    );
  return (
    <div className="dcl-status muted small" data-testid="dcl-ready">
      <span>
        Runs with Python {s.version} on the host PC (<code>{py}</code>).
      </span>{' '}
      <span>
        {s.ocr_missing.length ? (
          <>
            OCR for drawings without selectable text is not installed: <code>{py} -m pip install {s.ocr_missing.join(' ')}</code>.
          </>
        ) : (
          'OCR for drawings without selectable text is installed.'
        )}
      </span>{' '}
      <span>
        {s.logo ? 'The footer has the logo from Admin → Tools.' : 'No logo in the footer: the admin adds one under Admin → Tools.'}
        {s.logo && !s.pillow ? (
          <>
            {' '}
            Excel files leave it out until Pillow is installed: <code>{py} -m pip install pillow</code>.
          </>
        ) : null}
      </span>{' '}
      {check}
    </div>
  );
}
