// Minimal React type declarations.
// The official @types/react package could not be installed in the build
// environment, so this file declares just the parts of React the app uses.
// Hooks are typed properly; DOM event objects are typed loosely.

declare module 'react' {
  export type ReactNode = any;
  export type Key = string | number;
  export type SetState<T> = (v: T | ((prev: T) => T)) => void;
  export interface MutableRef<T> {
    current: T;
  }
  export interface Context<T> {
    Provider: any;
    _default?: T;
  }
  export function useState<T>(init: T | (() => T)): [T, SetState<T>];
  export function useState<T = undefined>(): [T | undefined, SetState<T | undefined>];
  export function useEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useLayoutEffect(fn: () => void | (() => void), deps?: readonly unknown[]): void;
  export function useRef<T>(init: T): MutableRef<T>;
  export function useRef<T>(init: T | null): MutableRef<T | null>;
  export function useMemo<T>(fn: () => T, deps: readonly unknown[]): T;
  export function useCallback<T extends (...args: any[]) => any>(fn: T, deps: readonly unknown[]): T;
  export function useSyncExternalStore<T>(subscribe: (cb: () => void) => () => void, get: () => T): T;
  export function useId(): string;
  export function createContext<T>(v: T): Context<T>;
  export function useContext<T>(c: Context<T>): T;
  export function memo<T>(c: T): T;
  export const Fragment: any;
  export const StrictMode: any;
  const React: any;
  export default React;
}

declare module 'react-dom/client' {
  export function createRoot(el: Element): { render(node: any): void; unmount(): void };
}

declare module 'react-dom' {
  export function createPortal(node: any, el: Element): any;
  export function flushSync(fn: () => void): void;
}

declare module 'react/jsx-runtime' {
  export const jsx: any;
  export const jsxs: any;
  export const Fragment: any;
  export namespace JSX {
    type Element = any;
    interface IntrinsicElements {
      [tag: string]: any;
    }
    interface ElementChildrenAttribute {
      children: {};
    }
    interface IntrinsicAttributes {
      key?: string | number;
    }
  }
}

declare module '*.css';
