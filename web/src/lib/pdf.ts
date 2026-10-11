// The bundled PDF viewer (pdf.js, decision #23), loaded only when a review
// screen needs it so the rest of the board stays small. Everything is served
// by the board itself: no internet is needed.

export interface PdfPage {
  rotate: number;
  getViewport(o: { scale: number; rotation?: number }): { width: number; height: number };
  render(o: { canvas: HTMLCanvasElement; viewport: unknown; transform?: number[] }): { promise: Promise<void>; cancel(): void };
  cleanup(): void;
}
export interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}
interface PdfJs {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(o: Record<string, unknown>): { promise: Promise<PdfDoc>; destroy(): Promise<void> };
}

let lib: Promise<PdfJs> | null = null;
function pdfjs(): Promise<PdfJs> {
  if (!lib) {
    // a runtime URL, so the build doesn't bundle pdf.js into the main script
    const url = `${__PDFJS_BASE__}pdf.min.mjs`;
    lib = (import(/* @vite-ignore */ url) as Promise<PdfJs>).then((m) => {
      m.GlobalWorkerOptions.workerSrc = `${__PDFJS_BASE__}pdf.worker.min.mjs`;
      return m;
    });
    lib.catch(() => (lib = null));
  }
  return lib;
}

const docs = new Map<string, Promise<PdfDoc>>();

/** Open a PDF from the board (cached: review files never change at the same address). */
export function openPdf(url: string): Promise<PdfDoc> {
  let p = docs.get(url);
  if (p) {
    // most recently used goes last, so eviction drops the oldest unused one
    docs.delete(url);
    docs.set(url, p);
  } else {
    p = pdfjs().then(
      (m) =>
        m.getDocument({
          url,
          withCredentials: true,
          wasmUrl: `${__PDFJS_BASE__}wasm/`,
          standardFontDataUrl: `${__PDFJS_BASE__}standard_fonts/`,
          cMapUrl: `${__PDFJS_BASE__}cmaps/`,
          cMapPacked: true,
          iccUrl: `${__PDFJS_BASE__}iccs/`,
          enableXfa: false,
        }).promise,
    );
    docs.set(url, p);
    p.catch(() => docs.delete(url));
    // keep the last few documents only (merged scans can be large)
    if (docs.size > 8) {
      const [oldest] = docs.keys();
      const old = docs.get(oldest);
      docs.delete(oldest);
      void old?.then((d) => d.destroy()).catch(() => {});
    }
  }
  return p;
}

export const fileUrl = (sha: string) => `/api/review-files/${sha}`;

/** Open a PDF held in memory (the PDF tools' previews). Not cached: destroy it when done. */
export function openPdfBytes(bytes: Uint8Array): Promise<PdfDoc> {
  return pdfjs().then(async (m) => {
    const task = m.getDocument({
      data: bytes.slice(),
      wasmUrl: `${__PDFJS_BASE__}wasm/`,
      standardFontDataUrl: `${__PDFJS_BASE__}standard_fonts/`,
      cMapUrl: `${__PDFJS_BASE__}cmaps/`,
      cMapPacked: true,
      iccUrl: `${__PDFJS_BASE__}iccs/`,
      enableXfa: false,
    });
    const doc = await task.promise;
    // the document proxy has no destroy() of its own in this pdf.js: the loading task frees it
    return Object.assign(doc, { destroy: () => task.destroy() });
  });
}
