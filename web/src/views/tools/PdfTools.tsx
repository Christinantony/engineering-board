// PDF tools (decision #33): the team's four PDF scripts as one page with tabs.
// Stamp, Negative and Combine by size run in the browser (pdf-lib, loaded on
// demand); Word to PDF sends the document to the host PC, where Microsoft
// Word converts it. Results are downloaded, singly or as one .zip.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../lib/api.ts';
import { navigate, useLocation } from '../../lib/router.ts';
import { useQuery } from '../../lib/store.ts';
import { toast, toastError } from '../../lib/toasts.ts';
import { openPdfBytes, type PdfDoc } from '../../lib/pdf.ts';
import { STAMP_DEFAULTS, cleanStampOptions, firstPageOnly, stampPdf, type StampOptions } from '../../lib/pdf/stamp.ts';
import { describeStats, pdfToNegative } from '../../lib/pdf/negative.ts';
import { groupPdfsBySize, type GroupDetail, type GroupOutput } from '../../lib/pdf/group.ts';
import { makeZip } from '../../lib/pdf/zip.ts';
import { Spinner } from '../../components/bits.tsx';

const TABS = [
  { id: 'stamp', label: 'Stamp' },
  { id: 'negative', label: 'Negative' },
  { id: 'combine', label: 'Combine by size' },
  { id: 'word', label: 'Word to PDF' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export function PdfTools() {
  const { params } = useLocation();
  const tab = (TABS.find((t) => t.id === params.get('tab'))?.id ?? 'stamp') as TabId;
  return (
    <div className="pdf-tools">
      <nav className="pdf-tabs" aria-label="PDF tools">
        {TABS.map((t) => (
          <a key={t.id} href={`/tools?tool=pdf&tab=${t.id}`} className={t.id === tab ? 'on' : ''} aria-current={t.id === tab ? 'page' : undefined} onClick={(e: any) => { e.preventDefault(); navigate(`/tools?tool=pdf&tab=${t.id}`); }}>
            {t.label}
          </a>
        ))}
      </nav>
      {tab === 'stamp' && <StampTool />}
      {tab === 'negative' && <NegativeTool />}
      {tab === 'combine' && <CombineTool />}
      {tab === 'word' && <WordTool />}
    </div>
  );
}

// ---- shared bits ----

interface Picked {
  name: string;
  bytes: Uint8Array;
}
interface Result {
  name: string;
  bytes?: Uint8Array;
  note?: string;
  error?: string;
}

async function readFiles(list: FileList | null): Promise<Picked[]> {
  const out: Picked[] = [];
  for (const f of Array.from(list ?? [])) out.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
  return out;
}

function download(name: string, bytes: Uint8Array, type = 'application/pdf') {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const stem = (name: string) => name.replace(/\.[^.]+$/, '');

function FilePicker({ accept, multiple = true, onPick, label, testId }: { accept: string; multiple?: boolean; onPick: (files: Picked[]) => void; label: string; testId: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <label className={`btn btn-primary file-pick${busy ? ' is-busy' : ''}`}>
      {busy ? 'Reading…' : label}
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        data-testid={testId}
        onChange={async (e: any) => {
          setBusy(true);
          try {
            onPick(await readFiles(e.target.files));
          } finally {
            setBusy(false);
            e.target.value = '';
          }
        }}
      />
    </label>
  );
}

function PickedList({ files, onRemove }: { files: Picked[]; onRemove: (i: number) => void }) {
  if (!files.length) return null;
  return (
    <ul className="pdf-files">
      {files.map((f, i) => (
        <li key={`${f.name}-${i}`}>
          <span className="pdf-file-name">{f.name}</span>
          <span className="muted small">{kb(f.bytes.length)}</span>
          <button type="button" className="icon-btn" aria-label={`Remove ${f.name}`} title="Remove" onClick={() => onRemove(i)}>
            ✕
          </button>
        </li>
      ))}
    </ul>
  );
}

function Results({ results, zipName }: { results: Result[]; zipName: string }) {
  const done = results.filter((r) => r.bytes);
  if (!results.length) return null;
  return (
    <div className="pdf-results" data-testid="pdf-results">
      <ul className="pdf-files">
        {results.map((r, i) => (
          <li key={`${r.name}-${i}`} className={r.error ? 'pdf-result-error' : ''}>
            <span className="pdf-file-name">{r.name}</span>
            <span className="muted small">{r.error ? <span className="form-error">{r.error}</span> : r.note}</span>
            {r.bytes && (
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => download(r.name, r.bytes!)}>
                Download
              </button>
            )}
          </li>
        ))}
      </ul>
      {done.length > 1 && (
        <button type="button" className="btn" onClick={() => download(zipName, makeZip(done.map((r) => ({ name: r.name, data: r.bytes! }))), 'application/zip')}>
          Download all ({done.length} files, .zip)
        </button>
      )}
    </div>
  );
}

/** Run a per-file job, showing which file is being worked on. */
function useBatch() {
  const [results, setResults] = useState<Result[]>([]);
  const [working, setWorking] = useState<string | null>(null);
  const run = async (files: Picked[], job: (f: Picked) => Promise<Result>) => {
    setResults([]);
    const out: Result[] = [];
    for (const f of files) {
      setWorking(f.name);
      try {
        out.push(await job(f));
      } catch (e) {
        out.push({ name: f.name, error: (e as Error).message || 'Could not process this file' });
      }
      setResults([...out]);
    }
    setWorking(null);
    const ok = out.filter((r) => r.bytes).length;
    toast(ok === out.length ? `Done: ${ok} file${ok === 1 ? '' : 's'}` : `${ok} of ${out.length} files done; see the list`, { kind: ok === out.length ? 'success' : 'error' });
  };
  return { results, working, run, reset: () => setResults([]) };
}

// ---- Stamp ----

const STAMP_KEY = 'engineering-board-pdf-stamp';
function loadStamp(): StampOptions {
  try {
    const raw = localStorage.getItem(STAMP_KEY);
    return raw ? cleanStampOptions(JSON.parse(raw)) : STAMP_DEFAULTS;
  } catch {
    return STAMP_DEFAULTS;
  }
}

function StampTool() {
  const [files, setFiles] = useState<Picked[]>([]);
  const [o, setO] = useState<StampOptions>(loadStamp);
  const batch = useBatch();
  useEffect(() => {
    try {
      localStorage.setItem(STAMP_KEY, JSON.stringify(o));
    } catch {
      /* fine */
    }
  }, [o]);
  const set = (patch: Partial<StampOptions>) => setO(cleanStampOptions({ ...o, ...patch }));
  const isDefault = useMemo(() => JSON.stringify(o) === JSON.stringify(STAMP_DEFAULTS), [o]);
  const run = () => batch.run(files, async (f) => {
    const r = await stampPdf(f.bytes, o);
    return { name: f.name, bytes: r.bytes, note: `${r.pages} page${r.pages === 1 ? '' : 's'} stamped` };
  });
  return (
    <section className="pdf-tool">
      <p className="muted">
        Writes the stamp across every page of each PDF, as the team's stamp script does. The preview shows the first page of the first file; what you see is what every
        page gets. The settings are remembered in this browser.
      </p>
      <div className="pdf-tool-row">
        <FilePicker accept="application/pdf,.pdf" onPick={(p) => setFiles([...files, ...p])} label="Choose PDFs…" testId="pick-stamp" />
        <button type="button" className="btn btn-primary" disabled={!files.length || !!batch.working} onClick={() => void run()}>
          {batch.working ? `Stamping ${batch.working}…` : `Stamp ${files.length || ''} file${files.length === 1 ? '' : 's'}`}
        </button>
        {files.length > 0 && (
          <button type="button" className="btn btn-quiet" onClick={() => { setFiles([]); batch.reset(); }}>
            Clear
          </button>
        )}
      </div>
      <PickedList files={files} onRemove={(i) => setFiles(files.filter((_, j) => j !== i))} />
      <div className="stamp-layout">
        <div className="stamp-controls">
          <label className="field-label" htmlFor="stamp-text">Text</label>
          <input id="stamp-text" className="field-input" value={o.text} maxLength={200} onChange={(e: any) => set({ text: e.target.value })} />
          <Slider label="Size" hint="% of the page width" value={o.size * 100} min={1} max={60} step={0.5} unit="%" onChange={(v) => set({ size: v / 100 })} />
          <Slider label="Angle" hint="degrees, counter-clockwise" value={o.angle} min={-90} max={90} step={1} unit="°" onChange={(v) => set({ angle: v })} />
          <Slider label="Opacity" value={o.opacity * 100} min={5} max={100} step={5} unit="%" onChange={(v) => set({ opacity: v / 100 })} />
          <Slider label="Across" hint="where the text starts, from the left" value={o.x * 100} min={0} max={100} step={1} unit="%" onChange={(v) => set({ x: v / 100 })} />
          <Slider label="Down" hint="where the text starts, from the top" value={o.y * 100} min={0} max={100} step={1} unit="%" onChange={(v) => set({ y: v / 100 })} />
          <label className="stamp-colour">
            Colour <input type="color" className="color-input" value={o.color} aria-label="Stamp colour" onChange={(e: any) => set({ color: e.target.value })} />
            <span className="muted small">{o.color}</span>
          </label>
          <button type="button" className="link-btn" disabled={isDefault} onClick={() => setO(STAMP_DEFAULTS)}>
            Back to the script's stamp ([DRAFT], 45°, 12%, 30%, black)
          </button>
        </div>
        <StampPreview file={files[0]} options={o} />
      </div>
      <Results results={batch.results} zipName="stamped_output.zip" />
    </section>
  );
}

function Slider({ label, hint, value, min, max, step, unit, onChange }: { label: string; hint?: string; value: number; min: number; max: number; step: number; unit: string; onChange: (v: number) => void }) {
  const id = `stamp-${label.toLowerCase()}`;
  return (
    <div className="stamp-slider">
      <label htmlFor={id} className="field-label">
        {label} <span className="stamp-value">{Math.round(value * 10) / 10}{unit}</span>
        {hint && <span className="muted small"> · {hint}</span>}
      </label>
      <div className="stamp-slider-row">
        <input id={id} type="range" min={min} max={max} step={step} value={value} aria-label={label} onChange={(e: any) => onChange(Number(e.target.value))} />
        <input type="number" className="field-input narrow" min={min} max={max} step={step} value={value} aria-label={`${label} value`} onChange={(e: any) => onChange(Number(e.target.value))} />
      </div>
    </div>
  );
}

/** The first page of the first file, stamped with the current settings and drawn by pdf.js: the exact result, refreshed as you adjust. */
function StampPreview({ file, options }: { file: Picked | undefined; options: StampOptions }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [page, setPage] = useState<Uint8Array | null>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'ready' | 'error'>('idle');
  const [error, setError] = useState('');
  const seq = useRef(0);
  // the first page alone, extracted once per file: stamping and drawing it is fast
  useEffect(() => {
    setPage(null);
    if (!file) return;
    let live = true;
    firstPageOnly(file.bytes)
      .then((p) => live && setPage(p))
      .catch((e) => {
        if (!live) return;
        setState('error');
        setError((e as Error).message);
      });
    return () => {
      live = false;
    };
  }, [file]);
  useEffect(() => {
    if (!page) return;
    const my = ++seq.current;
    setState('busy');
    const t = setTimeout(async () => {
      let doc: PdfDoc | null = null;
      try {
        const stamped = await stampPdf(page, options);
        if (my !== seq.current) return;
        doc = await openPdfBytes(stamped.bytes);
        const p = await doc.getPage(1);
        const c = canvas.current;
        if (!c || my !== seq.current) return;
        const base = p.getViewport({ scale: 1 });
        const width = Math.min(720, c.parentElement?.clientWidth ?? 720);
        const scale = width / base.width;
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const vp = p.getViewport({ scale: scale * dpr });
        c.width = Math.floor(vp.width);
        c.height = Math.floor(vp.height);
        c.style.width = `${Math.floor(vp.width / dpr)}px`;
        c.style.height = `${Math.floor(vp.height / dpr)}px`;
        await p.render({ canvas: c, viewport: vp }).promise;
        p.cleanup();
        if (my === seq.current) setState('ready');
      } catch (e) {
        if (my === seq.current) {
          setState('error');
          setError((e as Error).message);
        }
      } finally {
        void doc?.destroy().catch(() => {});
      }
    }, 120);
    return () => clearTimeout(t);
  }, [page, options]);
  return (
    <div className="stamp-preview" data-testid="stamp-preview" data-state={file ? state : 'none'}>
      {!file && <p className="muted">Choose a PDF to see the stamp on its first page.</p>}
      {file && state === 'error' && <p className="form-error">Could not draw the preview: {error}</p>}
      {file && state !== 'error' && (
        <>
          <canvas ref={canvas} className="stamp-canvas" aria-label="Stamp preview of the first page" />
          <p className="muted small">
            {state === 'busy' ? 'Updating…' : `First page of ${file.name}, with the stamp as it will be written`}
          </p>
        </>
      )}
    </div>
  );
}

// ---- Negative ----

function NegativeTool() {
  const [files, setFiles] = useState<Picked[]>([]);
  const [background, setBackground] = useState(true);
  const batch = useBatch();
  const run = () => batch.run(files, async (f) => {
    const r = await pdfToNegative(f.bytes, background);
    return { name: `${stem(f.name)}_negative.pdf`, bytes: r.bytes, note: describeStats(r.stats) };
  });
  return (
    <section className="pdf-tool">
      <p className="muted">
        Turns a vector PDF into its colour negative and keeps it vector: every fill, stroke and text colour (and those in nested forms and tiling patterns) becomes its
        inverse, so lines stay lines and text stays text. Grey and RGB images are inverted too. Gradients, CMYK and indexed images and annotation appearances are left
        as they are. Each result is named <code>…_negative.pdf</code>.
      </p>
      <div className="pdf-tool-row">
        <FilePicker accept="application/pdf,.pdf" onPick={(p) => setFiles([...files, ...p])} label="Choose PDFs…" testId="pick-negative" />
        <label className="pdf-check">
          <input type="checkbox" checked={background} onChange={(e: any) => setBackground(e.target.checked)} /> Paint the page black first
        </label>
        <button type="button" className="btn btn-primary" disabled={!files.length || !!batch.working} onClick={() => void run()}>
          {batch.working ? `Converting ${batch.working}…` : `Make negative${files.length > 1 ? 's' : ''}`}
        </button>
        {files.length > 0 && (
          <button type="button" className="btn btn-quiet" onClick={() => { setFiles([]); batch.reset(); }}>
            Clear
          </button>
        )}
      </div>
      <p className="muted small">White paper isn't stored in a PDF, so without the black background the page stays white behind the inverted lines.</p>
      <PickedList files={files} onRemove={(i) => setFiles(files.filter((_, j) => j !== i))} />
      <Results results={batch.results} zipName="negatives.zip" />
    </section>
  );
}

// ---- Combine by size ----

function CombineTool() {
  const [files, setFiles] = useState<Picked[]>([]);
  const [details, setDetails] = useState<GroupDetail[]>([]);
  const [outputs, setOutputs] = useState<GroupOutput[]>([]);
  const [working, setWorking] = useState(false);
  const run = async () => {
    setWorking(true);
    try {
      const r = await groupPdfsBySize(files);
      setDetails(r.details);
      setOutputs(r.outputs);
      toast(`Combined into ${r.outputs.length} file${r.outputs.length === 1 ? '' : 's'}`, { kind: 'success' });
    } catch (e) {
      toastError(e);
    } finally {
      setWorking(false);
    }
  };
  return (
    <section className="pdf-tool">
      <p className="muted">
        Sorts PDFs by the size of their first page (A4 or A3, portrait or landscape, 5 pt tolerance) and combines every file of a size into one PDF, in the order you
        chose them: <code>combined_A4.pdf</code>, <code>combined_A3.pdf</code>, and <code>combined_other.pdf</code> for anything else.
      </p>
      <div className="pdf-tool-row">
        <FilePicker accept="application/pdf,.pdf" onPick={(p) => setFiles([...files, ...p])} label="Choose PDFs…" testId="pick-combine" />
        <button type="button" className="btn btn-primary" disabled={!files.length || working} onClick={() => void run()}>
          {working ? 'Combining…' : 'Combine by size'}
        </button>
        {files.length > 0 && (
          <button type="button" className="btn btn-quiet" onClick={() => { setFiles([]); setDetails([]); setOutputs([]); }}>
            Clear
          </button>
        )}
      </div>
      <PickedList files={files} onRemove={(i) => setFiles(files.filter((_, j) => j !== i))} />
      {details.length > 0 && (
        <table className="table combine-table" data-testid="combine-details">
          <thead>
            <tr>
              <th>File</th>
              <th className="num">First page (pt)</th>
              <th className="num">Pages</th>
              <th>Size</th>
            </tr>
          </thead>
          <tbody>
            {details.map((d, i) => (
              <tr key={i}>
                <td>{d.name}</td>
                <td className="num">{d.error ? '–' : `${d.width.toFixed(1)} × ${d.height.toFixed(1)}`}</td>
                <td className="num">{d.error ? '–' : d.pages}</td>
                <td>{d.error ? <span className="form-error">{d.error}</span> : d.size}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Results results={outputs.map((o) => ({ name: o.name, bytes: o.bytes, note: `${o.files.length} file${o.files.length === 1 ? '' : 's'}, ${o.pages} page${o.pages === 1 ? '' : 's'}` }))} zipName="combined_by_size.zip" />
    </section>
  );
}

// ---- Word to PDF ----

function convertWord(file: Picked): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/tools/word-to-pdf?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.responseType = 'arraybuffer';
    xhr.onerror = () => reject(new ApiError(0, 'network', "Can't reach the board server. Check that the host PC is on, then try again."));
    xhr.onload = () => {
      if (xhr.status === 200) return resolve(new Uint8Array(xhr.response));
      let body: any = null;
      try {
        body = JSON.parse(new TextDecoder().decode(xhr.response));
      } catch {
        /* not JSON */
      }
      reject(new ApiError(xhr.status, body?.error ?? 'http', body?.message ?? `The server answered ${xhr.status}.`, body));
    };
    xhr.send(new Blob([file.bytes as BlobPart]));
  });
}

function WordTool() {
  const status = useQuery<{ word_to_pdf: 'available' | 'not_windows' | 'no_word' }>('/api/tools/pdf/status');
  const [files, setFiles] = useState<Picked[]>([]);
  const batch = useBatch();
  const available = status.data?.word_to_pdf === 'available';
  const run = () => batch.run(files, async (f) => ({ name: `${stem(f.name)}.pdf`, bytes: await convertWord(f), note: 'converted by Word on the host PC' }));
  return (
    <section className="pdf-tool">
      <p className="muted">
        Converts Word documents (.doc or .docx) to PDF with Microsoft Word on the host PC, as the team's DOC to PDF script does: the file is sent to the board, Word
        exports it (print quality, document properties and tags kept, no bookmarks), and the PDF comes back for download. One document at a time.
      </p>
      {!status.data && <Spinner />}
      {status.data && !available && (
        <p className="notice notice-warn" data-testid="word-unavailable">
          {status.data.word_to_pdf === 'not_windows'
            ? 'Not available here: the host PC is not running Windows, so there is no Microsoft Word to convert with.'
            : 'Not available here: Microsoft Word is not installed on the host PC.'}
        </p>
      )}
      <div className="pdf-tool-row">
        <FilePicker accept=".doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onPick={(p) => setFiles([...files, ...p])} label="Choose Word documents…" testId="pick-word" />
        <button type="button" className="btn btn-primary" disabled={!files.length || !!batch.working || !available} onClick={() => void run()}>
          {batch.working ? `Converting ${batch.working}…` : `Convert to PDF`}
        </button>
        {files.length > 0 && (
          <button type="button" className="btn btn-quiet" onClick={() => { setFiles([]); batch.reset(); }}>
            Clear
          </button>
        )}
      </div>
      <PickedList files={files} onRemove={(i) => setFiles(files.filter((_, j) => j !== i))} />
      <Results results={batch.results} zipName="word_to_pdf.zip" />
    </section>
  );
}
