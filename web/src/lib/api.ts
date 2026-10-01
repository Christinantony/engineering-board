// Thin fetch wrapper. Every failure becomes an ApiError with a sentence the
// user can act on — nothing fails silently.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public body: any = null,
  ) {
    super(message);
  }
}

/** Random key for idempotent creates (crypto.randomUUID needs https, which the LAN board doesn't have). */
export function newKey(): string {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

let onUnauthenticated: () => void = () => {};
export function setUnauthenticatedHandler(fn: () => void) {
  onUnauthenticated = fn;
}

export async function api<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'network', "Can't reach the board server. Check that the host PC is on, then try again. Nothing was saved.");
  }
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401) onUnauthenticated();
    throw new ApiError(res.status, data?.error ?? 'http', data?.message ?? `The server answered ${res.status}. Nothing was saved.`, data);
  }
  return data as T;
}

export const get = <T = any>(p: string) => api<T>('GET', p);
export const post = <T = any>(p: string, b: unknown = {}, h?: Record<string, string>) => api<T>('POST', p, b, h);
export const patch = <T = any>(p: string, b: unknown) => api<T>('PATCH', p, b);
export const del = <T = any>(p: string) => api<T>('DELETE', p);
