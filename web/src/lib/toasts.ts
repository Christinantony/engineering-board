import { useSyncExternalStore } from 'react';

export interface Toast {
  id: number;
  kind: 'info' | 'error' | 'success';
  text: string;
  action?: { label: string; run: () => void };
  timeout: number;
}

let toasts: Toast[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function toast(text: string, opts: Partial<Omit<Toast, 'id' | 'text'>> = {}): number {
  const t: Toast = { id: ++seq, kind: opts.kind ?? 'info', text, action: opts.action, timeout: opts.timeout ?? (opts.kind === 'error' ? 10_000 : 5_000) };
  toasts = [...toasts.slice(-3), t];
  emit();
  if (t.timeout > 0) setTimeout(() => dismiss(t.id), t.timeout);
  return t.id;
}
export const toastError = (err: unknown) => toast(err instanceof Error ? err.message : String(err), { kind: 'error' });

export function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => toasts,
  );
}
