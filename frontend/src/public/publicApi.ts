// Client for a chat link's public API (/api/public/<token>): no account; the
// server knows this browser by a visitor cookie scoped to that path. Errors
// carry the server's friendly `detail`, ready to show as is.

import type { PublicConversation, PublicConversationDetail, PublicInfo } from '../types';

export class PublicError extends Error {
  /** HTTP status; 0 when the server could not be reached. */
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'PublicError';
    this.status = status;
  }
}

const FALLBACK: Record<number, string> = {
  0: "Can't reach the chat right now. Check your connection and try again.",
  404: "This chat link doesn't exist or has been replaced.",
  410: 'This chat link has been turned off.',
  429: "You're going a bit fast. Wait a moment and try again.",
};

/** The token of the page's own address (/c/<token>). */
export function tokenFromPath(pathname: string): string {
  const m = /^\/c\/([^/?#]+)/.exec(pathname);
  return m ? decodeURIComponent(m[1]) : '';
}

/** A message for any thrown value. */
export function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return 'Something went wrong. Please try again.';
}

export function statusOf(err: unknown): number | null {
  return err instanceof PublicError ? err.status : null;
}

async function toError(res: Response): Promise<PublicError> {
  let message = '';
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body.detail === 'string') message = body.detail;
    else if (Array.isArray(body.detail) && body.detail.length) {
      const first = body.detail[0] as { msg?: unknown } | string;
      message = typeof first === 'string' ? first : String(first.msg ?? '');
    }
  } catch {
    /* not JSON */
  }
  return new PublicError(res.status, message || FALLBACK[res.status] || 'Something went wrong. Please try again.');
}

export function publicApi(token: string) {
  const base = `/api/public/${encodeURIComponent(token)}`;

  async function open(method: string, path: string, body: unknown, accept: string, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { Accept: accept };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      // no-store: the server sends no Cache-Control, and browsers may keep a 404/410 ("turned off") after the link is back on.
      res = await fetch(base + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal,
        cache: 'no-store',
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new PublicError(0, FALLBACK[0]);
    }
    if (!res.ok) throw await toError(res);
    return res;
  }

  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> =>
    (await (await open(method, path, body, 'application/json')).json()) as T;
  const enc = encodeURIComponent;

  return {
    info: () => call<PublicInfo>('GET', ''),
    access: (code: string) => call<{ ok: boolean }>('POST', '/access', { code }),
    /** This visitor's conversations that still exist, newest first. */
    conversations: () => call<PublicConversation[]>('GET', '/conversations'),
    start: (consent: boolean) => call<PublicConversation>('POST', '/conversations', { consent }),
    conversation: (id: string) => call<PublicConversationDetail>('GET', `/conversations/${enc(id)}`),
    /** Starts a turn; the response body is its SSE event stream. */
    send: (id: string, text: string, signal?: AbortSignal) =>
      open('POST', `/conversations/${enc(id)}/messages`, { text }, 'text/event-stream', signal),
    /** Re-attaches to a reply in progress (replays it so far). */
    attach: (id: string, signal?: AbortSignal) => open('GET', `/conversations/${enc(id)}/stream`, undefined, 'text/event-stream', signal),
    end: (id: string) => call<{ ok: boolean; erased: boolean }>('POST', `/conversations/${enc(id)}/end`, {}),
  };
}

export type PublicApi = ReturnType<typeof publicApi>;
