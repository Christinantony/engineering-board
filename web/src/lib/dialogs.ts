// Promise-based dialogs: `await ask({...})` resolves with the answer or null if cancelled.

import { useSyncExternalStore } from 'react';
import type { Ticket } from '@board/shared';

export type DialogSpec =
  | { type: 'reason'; ticket: Ticket; status: 'waiting' | 'blocked'; initial: string }
  | { type: 'assign'; ticket: Ticket; title: string }
  | { type: 'confirm'; title: string; body: string; confirm: string; danger?: boolean }
  | { type: 'conflict'; field: string; jobNumber: string; mine: string; theirs: string; canCombine: boolean }
  | { type: 'help' };

export type DialogAnswer<S extends DialogSpec> = S extends { type: 'reason' }
  ? { reason: string; status: 'waiting' | 'blocked' }
  : S extends { type: 'assign' }
    ? number
    : S extends { type: 'conflict' }
      ? 'mine' | 'theirs' | 'both'
      : true;

interface Open {
  spec: DialogSpec;
  resolve: (v: any) => void;
}
let current: Open | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function ask<S extends DialogSpec>(spec: S): Promise<DialogAnswer<S> | null> {
  current?.resolve(null);
  return new Promise((resolve) => {
    current = {
      spec,
      resolve: (v) => {
        current = null;
        emit();
        resolve(v);
      },
    };
    emit();
  });
}

export function useDialog(): Open | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}
