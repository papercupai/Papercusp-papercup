/**
 * Fault construction and Retry-After parsing for provider packages (WI-6554700010018411).
 *
 * Every provider package turns a failed `host.fetch` into a fault the host reads with
 * {@link providerSyncErrorOf}: an `Error` carrying `kind` and, for `rate-limited`, the
 * `retryAfterSeconds` the platform asked for. Before this module each package restated that
 * constructor and its own Retry-After parsing (measured 2026-10-21: 21 packages under
 * libs/papercusp/plugins, each with its own `fault`/`syncError`, none reading the HTTP-date
 * form of Retry-After). These helpers are pure and dependency-free, so a TypeScript adapter can
 * import them and a self-contained CommonJS package can carry a bundled copy.
 *
 * Retry and backoff stay host-owned (provider-adapters-to-packages-2026-10-11 D-003): a package
 * reports what the platform said and throws; it never sleeps or retries itself.
 */
import { PROVIDER_SYNC_ERROR_KINDS, type ProviderSyncError } from './provider';

/** The `kind` of a {@link ProviderSyncError}. */
export type ProviderSyncErrorKind = ProviderSyncError['kind'];

/** An `Error` the host reads as a {@link ProviderSyncError} through `providerSyncErrorOf`. */
export type ProviderSyncFault = Error & {
  kind: ProviderSyncErrorKind;
  retryAfterSeconds?: number;
  [field: string]: unknown;
};

/**
 * Response headers as packages receive them: the plain object `host.fetch` returns (names
 * lower-cased), a WHATWG `Headers`, or a test double with mixed-case names or array values.
 */
export type ProviderResponseHeaders =
  | { get(name: string): string | null }
  | Record<string, string | readonly string[] | number | undefined | null>;

const KINDS: readonly string[] = PROVIDER_SYNC_ERROR_KINDS;

/**
 * Build the fault a provider throws. The message reads `<prefix>:<message>` (the convention every
 * package already logs under), `kind` is always the given kind (an `extra` field cannot override
 * it), and a `retryAfterSeconds` that is not a finite non-negative number is dropped instead of
 * being passed to the host's backoff.
 */
export function providerSyncFault(
  prefix: string,
  kind: ProviderSyncErrorKind,
  message: string,
  extra?: Record<string, unknown>,
): ProviderSyncFault {
  if (!KINDS.includes(kind)) {
    throw new TypeError(`providerSyncFault: kind must be one of ${KINDS.join(', ')}, got ${JSON.stringify(kind)}`);
  }
  const fault = new Error(prefix ? `${prefix}:${message}` : message) as ProviderSyncFault;
  if (extra) {
    for (const [field, value] of Object.entries(extra)) {
      if (field === 'kind' || field === 'message' || field === 'stack' || value === undefined) continue;
      fault[field] = value;
    }
  }
  fault.kind = kind;
  if ('retryAfterSeconds' in fault) {
    const seconds = fault.retryAfterSeconds;
    if (kind !== 'rate-limited' || typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) {
      delete fault.retryAfterSeconds;
    }
  }
  return fault;
}

/** The first value of header `name`, matched case-insensitively. */
export function providerHeaderValue(headers: ProviderResponseHeaders | null | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get(n: string): string | null }).get(name);
    return value == null ? undefined : String(value);
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted || value == null) continue;
    const first = Array.isArray(value) ? value[0] : value;
    return first == null ? undefined : String(first);
  }
  return undefined;
}

const DELTA_SECONDS = /^\d+(?:\.\d+)?$/;

/**
 * Seconds to wait before retrying, read from a `Retry-After` header (RFC 9110 section 10.2.3):
 * either delta-seconds or an HTTP-date. Fractional seconds round up; a date in the past means 0.
 * Returns undefined when the header is absent or unreadable, so the host applies its own backoff.
 */
export function retryAfterSecondsOf(
  headers: ProviderResponseHeaders | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  const raw = providerHeaderValue(headers, 'retry-after')?.trim();
  if (!raw) return undefined;
  if (DELTA_SECONDS.test(raw)) return Math.ceil(Number(raw));
  // An HTTP-date always names a weekday and a month; a bare signed or garbled number is neither.
  if (!/[a-z]/i.test(raw)) return undefined;
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, Math.ceil((at - nowMs) / 1000));
}

/**
 * A `rate-limited` fault carrying the response's `Retry-After`, when it has a readable one.
 * Platforms that signal their window another way (an epoch reset header, a usage header) pass
 * `retryAfterSeconds` in `extra`; an explicit value there wins over the header.
 */
export function rateLimitedFault(
  prefix: string,
  message: string,
  headers?: ProviderResponseHeaders | null,
  extra?: Record<string, unknown>,
  nowMs?: number,
): ProviderSyncFault {
  const fromHeader = retryAfterSecondsOf(headers, nowMs);
  const fields: Record<string, unknown> = { ...extra };
  if (fields.retryAfterSeconds === undefined && fromHeader !== undefined) fields.retryAfterSeconds = fromHeader;
  return providerSyncFault(prefix, 'rate-limited', message, fields);
}
