// One PDF viewer pane: page navigation, zoom, fit page / fit width and
// 90-degree rotation, each pane on its own (decision #23). Rotation and zoom
// change only what is drawn on screen; the PDF itself is never modified.

import { useEffect, useRef, useState } from 'react';
import { openPdf, type PdfDoc } from '../lib/pdf.ts';

type Zoom = { mode: 'page' | 'width' } | { mode: 'custom'; scale: number };

export interface PdfViewerProps {
  url: string | null;
  /** Shown above the page (what this pane is). */
  heading: any;
  /** Page to show; when it (or pageKey) changes, the viewer goes there. */
  page?: number;
  pageKey?: string | number;
  onPage?: (page: number, pages: number) => void;
  /** Extra controls at the end of the toolbar (e.g. "Remember reference page"). */
  extra?: any;
  empty?: any;
  testId?: string;
}

const STEP = 1.25;

export function PdfViewer({ url, heading, page: wanted, pageKey, onPage, extra, empty, testId }: PdfViewerProps) {
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageText, setPageText] = useState('1');
  const [zoom, setZoom] = useState<Zoom>({ mode: 'page' });
  const [rotation, setRotation] = useState(0);
  const [scale, setScale] = useState(1);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const box = useRef<HTMLDivElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);

  // open the document
  useEffect(() => {
    setDoc(null);
    setError(null);
    if (!url) return;
    let live = true;
    openPdf(url).then(
      (d) => live && setDoc(d),
      (e: any) => {
        if (!live) return;
        const status = /\b(410)\b/.test(String(e?.message ?? e)) || e?.status === 410;
        setError(status ? 'This intermediate PDF was removed after board review. Its notes and decision are kept in the history.' : `This PDF could not be shown: ${e?.message ?? e}`);
      },
    );
    return () => {
      live = false;
    };
  }, [url]);

  // go to the requested page (a remembered reference page, say)
  useEffect(() => {
    if (!doc) return;
    const p = Math.min(Math.max(wanted ?? 1, 1), doc.numPages);
    setPage(p);
  }, [doc, wanted, pageKey]);

  useEffect(() => {
    setPageText(String(page));
    if (doc) onPage?.(page, doc.numPages);
  }, [page, doc]);

  // follow the pane's size
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // draw
  useEffect(() => {
    if (!doc || !canvas.current || size.w < 20 || size.h < 20) return;
    let cancelled = false;
    let task: { cancel(): void } | null = null;
    void (async () => {
      try {
        const p = await doc.getPage(page);
        if (cancelled) return;
        const rot = (p.rotate + rotation) % 360;
        const base = p.getViewport({ scale: 1, rotation: rot });
        const pad = 24;
        const fitW = (size.w - pad) / base.width;
        const fitP = Math.min(fitW, (size.h - pad) / base.height);
        const s = zoom.mode === 'custom' ? zoom.scale : zoom.mode === 'width' ? fitW : fitP;
        setScale(s);
        const vp = p.getViewport({ scale: s, rotation: rot });
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        const c = canvas.current!;
        c.width = Math.floor(vp.width * dpr);
        c.height = Math.floor(vp.height * dpr);
        c.style.width = `${Math.floor(vp.width)}px`;
        c.style.height = `${Math.floor(vp.height)}px`;
        const r = p.render({ canvas: c, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
        task = r;
        await r.promise;
        if (!cancelled) c.dataset.rendered = `${page}:${rot}:${s.toFixed(3)}`;
      } catch (e: any) {
        if (!cancelled && e?.name !== 'RenderingCancelledException') setError(`This page could not be drawn: ${e?.message ?? e}`);
      }
    })();
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [doc, page, zoom, rotation, size]);

  const pages = doc?.numPages ?? 0;
  const go = (p: number) => pages && setPage(Math.min(Math.max(p, 1), pages));
  const zoomBy = (f: number) => setZoom({ mode: 'custom', scale: Math.min(Math.max(scale * f, 0.1), 8) });

  return (
    <section
      className="pdf-pane"
      data-testid={testId}
      data-page={page}
      data-pages={pages}
      data-rotation={rotation}
      data-zoom={zoom.mode}
      aria-label={typeof heading === 'string' ? heading : undefined}
    >
      <header className="pdf-head">{heading}</header>
      <div className="pdf-toolbar" role="toolbar" aria-label="Viewer controls">
        <button className="icon-btn" onClick={() => go(page - 1)} disabled={page <= 1} aria-label="Previous page" title="Previous page">
          ‹
        </button>
        <span className="pdf-pageno">
          <input
            className="field-input"
            aria-label="Page"
            value={pageText}
            inputMode="numeric"
            onChange={(e: any) => setPageText(e.target.value)}
            onBlur={() => go(Number(pageText) || page)}
            onKeyDown={(e: any) => e.key === 'Enter' && go(Number(pageText) || page)}
          />
          <span className="muted">of {pages || '–'}</span>
        </span>
        <button className="icon-btn" onClick={() => go(page + 1)} disabled={!pages || page >= pages} aria-label="Next page" title="Next page">
          ›
        </button>
        <span className="pdf-sep" />
        <button className="icon-btn" onClick={() => zoomBy(1 / STEP)} aria-label="Zoom out" title="Zoom out">
          −
        </button>
        <span className="pdf-scale" aria-live="polite">
          {Math.round(scale * 100)}%
        </span>
        <button className="icon-btn" onClick={() => zoomBy(STEP)} aria-label="Zoom in" title="Zoom in">
          +
        </button>
        <button className={`btn btn-quiet btn-sm${zoom.mode === 'page' ? ' on' : ''}`} onClick={() => setZoom({ mode: 'page' })} aria-pressed={zoom.mode === 'page'}>
          Fit page
        </button>
        <button className={`btn btn-quiet btn-sm${zoom.mode === 'width' ? ' on' : ''}`} onClick={() => setZoom({ mode: 'width' })} aria-pressed={zoom.mode === 'width'}>
          Fit width
        </button>
        <span className="pdf-sep" />
        <button className="icon-btn" onClick={() => setRotation((r) => (r + 270) % 360)} aria-label="Rotate anticlockwise" title="Rotate anticlockwise (view only)">
          ↺
        </button>
        <button className="icon-btn" onClick={() => setRotation((r) => (r + 90) % 360)} aria-label="Rotate clockwise" title="Rotate clockwise (view only)">
          ↻
        </button>
        <button
          className="btn btn-quiet btn-sm"
          onClick={() => {
            setRotation(0);
            setZoom({ mode: 'page' });
          }}
          disabled={rotation === 0 && zoom.mode === 'page'}
          title="Back to upright and fit page"
        >
          Reset
        </button>
        {extra && <span className="pdf-extra">{extra}</span>}
      </div>
      <div className="pdf-canvas-box" ref={box} tabIndex={0} aria-label="Page view; scroll to move around a zoomed page">
        {!url && <div className="pdf-empty">{empty ?? 'Nothing to show'}</div>}
        {url && error && <div className="pdf-empty pdf-error">{error}</div>}
        {url && !error && !doc && <div className="pdf-empty muted">Opening PDF…</div>}
        <canvas ref={canvas} className="pdf-canvas" hidden={!url || !!error || !doc} />
      </div>
    </section>
  );
}

/** A small first-page preview (review queue). */
export function PdfThumb({ url, label }: { url: string; label: string }) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void openPdf(url)
      .then(async (d) => {
        const p = await d.getPage(1);
        if (cancelled || !canvas.current) return;
        const base = p.getViewport({ scale: 1 });
        const s = 200 / Math.max(base.width, base.height);
        const vp = p.getViewport({ scale: s * 2 });
        const c = canvas.current;
        c.width = Math.floor(vp.width);
        c.height = Math.floor(vp.height);
        await p.render({ canvas: c, viewport: vp }).promise;
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [url]);
  return failed ? <div className="pdf-thumb pdf-thumb-missing">{label}</div> : <canvas ref={canvas} className="pdf-thumb" aria-label={label} />;
}
