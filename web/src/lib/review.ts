// Drawing review: API calls used by the review screens.

import type { ReviewFile, ReviewWorkspace } from '@board/shared';
import { ApiError, api } from './api.ts';
import { invalidate, setCached } from './store.ts';
import { toastError } from './toasts.ts';

/** Upload one PDF with progress. kind "drawing" must be a single page. */
export function uploadPdf(file: File, kind: 'drawing' | 'reference', onProgress?: (fraction: number) => void): Promise<ReviewFile> {
  return new Promise((resolveUpload, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/review/uploads?kind=${kind}&name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onerror = () => reject(new ApiError(0, 'network', "Can't reach the board server. Check that the host PC is on, then try again."));
    xhr.onload = () => {
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status === 201) resolveUpload(body.file);
      else reject(new ApiError(xhr.status, body?.error ?? 'http', body?.message ?? `The server answered ${xhr.status}.`, body));
    };
    xhr.send(file);
  });
}

/** Call a review action; on success update the open workspace straight away. */
export async function reviewAction(method: string, path: string, body?: unknown): Promise<ReviewWorkspace | null> {
  try {
    const w = await api<ReviewWorkspace>(method, path, body);
    if (w?.ticket) setCached<ReviewWorkspace>(`/api/tickets/${w.ticket.id}/review`, () => w);
    invalidate((k) => k.startsWith('/api/reviews') || k.startsWith('/api/tickets') || k.startsWith('/api/notifications'));
    return w;
  } catch (e) {
    toastError(e);
    if (e instanceof ApiError && e.status === 409) invalidate((k) => k.includes('/review'));
    return null;
  }
}
