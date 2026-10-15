/**
 * inference-transport-retry.ts — P-006 (R-12/R-13, WI-10007504).
 *
 * Scout's LLM chain (register-scout-action.ts) used to retry exactly one failure class: an
 * ATTESTED capacity denial, diverted once to the Codex bridge (withCodexCapacityFallback). The
 * canonical Scout model is now the Codex-bridged learning model, and on that path NOTHING retried
 * a TRANSPORT death — the connection dropping mid-call. With a one-ideator roster a single dropped
 * connection failed the whole cycle. Measured 2026-10-08 over 7 days: 11 of the 12 scout error
 * ticks were exactly this ("all 1 ideator LLM call(s) failed — transport death"), which alone held
 * the scout cycle error rate above the 5% bar.
 *
 * This module is the ONE classifier for "did this call die in transport?" plus a bounded,
 * deadline- and abort-aware SAME-MODEL retry around the existing chain. It deliberately does
 * NOT retry:
 *   - an attested capacity denial — that is withCodexCapacityFallback's job, and retrying a wall
 *     only burns the cycle budget the honest capacity error needs to land;
 *   - Scout's own timers and cancellations ("Scout ideator … timed out", "… aborted") — those
 *     are budget decisions, not transport faults;
 *   - anything else (401s, validation errors, model refusals) — retrying a deterministic failure
 *     cannot change its outcome.
 *
 * There is no cross-provider leg here on purpose: the learning model policy is a single canonical
 * model, so "fallback" means another attempt over a fresh connection.
 */

import { isCapacityError } from './capacity-errors';

/** One retry attempt the wrapper made after a transport death. Persisted on the scout tick
 * detail as `transportRetries` so R-12's falsifier ("a transport death that was neither retried
 * nor served by a fallback") is checkable from the ledger alone. */
export interface TransportRetryEvent {
  /** The model the call was routed to (unchanged across retries). */
  model: string;
  /** 1-based retry number (1 = the first retry after the original attempt). */
  attempt: number;
  /** Head of the transport-death message that triggered this retry. */
  error: string;
  /** Whether THIS retry returned a result. */
  succeeded: boolean;
}

/**
 * Transport-death signatures. Each one is a message the inference path actually produces when a
 * connection dies, NOT a judgment about the request. The first five are verbatim from the
 * 2026-10-01..08 scout error ticks; the rest are the undici/node socket-level spellings of the same
 * event, which arrive as `err.cause` under a generic "fetch failed".
 */
const TRANSPORT_DEATH_SIGNATURES: readonly RegExp[] = [
  /\bfetch failed\b/i,
  // undici's bare `TypeError: terminated` (alone, or as the tail of "…upstream failed: terminated").
  /(?:^|: |\| )terminated(?:$| \|)/i,
  /upstream body idle exceeded/i,
  /SSE ended without response\.completed/i,
  /inference-gateway internal error/i,
  /\bsocket hang up\b/i,
  /\bother side closed\b/i,
  /\bpremature close\b/i,
  /\b(?:ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENETUNREACH)\b/,
  /\bUND_ERR_(?:SOCKET|CLOSED|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT)\b/,
];

/** Scout's OWN timers/cancellations name themselves; they are budget decisions, never transport. */
const SCOUT_OWN_FAILURE = /^Scout (?:ideator|cycle)\b/;

const MAX_CAUSE_DEPTH = 4;

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return '';
}

/** The message plus every `cause` message/code down the chain (undici nests the real reason). */
function chainText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur && depth < MAX_CAUSE_DEPTH; depth++) {
    parts.push(messageOf(cur));
    if (typeof cur === 'object') {
      const code = (cur as { code?: unknown }).code;
      if (typeof code === 'string') parts.push(code);
      cur = (cur as { cause?: unknown }).cause;
    } else {
      cur = undefined;
    }
  }
  return parts.filter(Boolean).join(' | ');
}

/** True when `err` is an inference TRANSPORT death that a fresh attempt could plausibly survive. */
export function isInferenceTransportDeath(err: unknown): boolean {
  if (!err) return false;
  if (isCapacityError(err)) return false;
  if (err instanceof Error && err.name === 'AbortError') return false;
  if (SCOUT_OWN_FAILURE.test(messageOf(err))) return false;
  const text = chainText(err);
  return TRANSPORT_DEATH_SIGNATURES.some((re) => re.test(text));
}

/** Default backoff before retry N (index N-1). Short: a transport death is not a load signal. */
export const DEFAULT_TRANSPORT_RETRY_BACKOFF_MS: readonly number[] = [2_000, 8_000];
/** Default number of retries after the original attempt. */
export const DEFAULT_TRANSPORT_MAX_RETRIES = 2;
/**
 * Never START a retry with less than this left before the caller's retry deadline: a retry that
 * cannot finish only converts an honest transport error into an opaque cycle timeout.
 */
export const DEFAULT_TRANSPORT_RETRY_MIN_REMAINING_MS = 30_000;

export interface TransportRetryOptions {
  /** Mutated in place — the runner surfaces it on the cycle result / thrown error. */
  events: TransportRetryEvent[];
  maxRetries?: number;
  backoffMs?: readonly number[];
  minRemainingMs?: number;
  /** Test seams. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Wrap a Scout LLM call so a transport death gets up to `maxRetries` fresh attempts on the SAME
 * model. A retry is skipped (the error rethrown as-is) when the call's signal is aborted or when
 * the call's `retryDeadlineMs` leaves less than `minRemainingMs` after the backoff. The LAST error
 * is what propagates, so a retry that fails differently (e.g. hits a capacity wall) surfaces that
 * honest error to the classifier instead of the earlier transport message.
 */
export function withTransportRetry<
  O extends { model?: string; signal?: AbortSignal; retryDeadlineMs?: number },
  R,
>(call: (o: O) => Promise<R>, opts: TransportRetryOptions): (o: O) => Promise<R> {
  const maxRetries = opts.maxRetries ?? DEFAULT_TRANSPORT_MAX_RETRIES;
  const backoff = opts.backoffMs ?? DEFAULT_TRANSPORT_RETRY_BACKOFF_MS;
  const minRemainingMs = opts.minRemainingMs ?? DEFAULT_TRANSPORT_RETRY_MIN_REMAINING_MS;
  const sleep = opts.sleep ?? abortableSleep;
  const now = opts.now ?? Date.now;

  return async (o: O): Promise<R> => {
    let current: TransportRetryEvent | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await call(o);
        if (current) current.succeeded = true;
        return res;
      } catch (err) {
        if (attempt >= maxRetries || !isInferenceTransportDeath(err) || o.signal?.aborted) throw err;
        const wait = backoff.length > 0 ? backoff[Math.min(attempt, backoff.length - 1)] : 0;
        if (o.retryDeadlineMs !== undefined && o.retryDeadlineMs - now() - wait < minRemainingMs) throw err;
        current = {
          model: o.model ?? '(unresolved)',
          attempt: attempt + 1,
          error: messageOf(err).slice(0, 200),
          succeeded: false,
        };
        opts.events.push(current);
        if (wait > 0) {
          try {
            await sleep(wait, o.signal);
          } catch {
            // Cancelled mid-backoff: the cycle is being torn down — surface the transport error
            // that started this, not a bare abort that hides why we were waiting.
            throw err;
          }
        }
      }
    }
  };
}

/** Read persisted/attached transport-retry events from an error object or tick detail.
 * Shape-validated per entry — a malformed entry is dropped, never trusted. */
export function transportRetriesFrom(input: unknown): TransportRetryEvent[] | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = (input as Record<string, unknown>).transportRetries;
  if (!Array.isArray(raw)) return undefined;
  const out: TransportRetryEvent[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (
      typeof e.model !== 'string' ||
      typeof e.attempt !== 'number' ||
      typeof e.error !== 'string' ||
      typeof e.succeeded !== 'boolean'
    ) {
      continue;
    }
    out.push({ model: e.model, attempt: e.attempt, error: e.error, succeeded: e.succeeded });
  }
  return out.length > 0 ? out : undefined;
}
