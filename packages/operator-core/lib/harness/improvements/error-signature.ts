/**
 * Error-signature identity for the one intake (plan
 * unified-bug-pipeline-and-honest-queue-2026-10-05, P-011 / D-046).
 *
 * Two reports of the same defect rarely share wording: a person types "the
 * plans page says relation does not exist", an agent writes "plans:list fails
 * against the new schema". They often share the ERROR. This module turns the
 * most recent error a report carries into a stable identity so the intake can
 * fold both reports onto one candidate.
 *
 * The identity is used as an INFERRED `watchdogKey` (`error-signature:<hash>`),
 * which reuses the indexed exact-key lookup and the unique open-identity index
 * in capture: two concurrent reports of the same error cannot mint two rows.
 *
 * Pure: no I/O. Normalization removes what varies between occurrences of the
 * same failure (case, ids, numbers, paths, timestamps, wrapper prefixes) and
 * keeps what names the failure. A signature that is too generic to identify a
 * defect ("timeout", "error") is refused, so it never folds unrelated reports.
 */
import { createHash } from 'node:crypto';

export const ERROR_SIGNATURE_KEY_PREFIX = 'error-signature:';

/** A normalized error shorter than this, or with fewer words, is too generic to fold on. */
export const ERROR_SIGNATURE_MIN_CHARS = 20;
export const ERROR_SIGNATURE_MIN_WORDS = 3;
/** Normalization reads at most this much of one message. */
export const ERROR_SIGNATURE_MAX_INPUT = 2_000;

export interface ErrorSignature {
  /** `error-signature:<16 hex>` — the inferred watchdogKey. */
  key: string;
  /** The tool the error came from, when its source names one; null otherwise. */
  tool: string | null;
  /** The normalized text the hash covers (stored for review, never for matching). */
  normalized: string;
}

/** A recent error as the report context stores it. */
export interface SignatureError {
  message?: unknown;
  source?: unknown;
}

const TOOL_NAME_RE = /^[a-z][\w-]*(?:[:.][\w-]+)+$/i;

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO_TS_RE = /\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2})?\b/gi;
const WORK_ITEM_RE = /\b(?:ei|wi|f)-\d+\b/gi;
const HEX_RE = /\b(?:0x)?[0-9a-f]{7,}\b/gi;
const PATH_RE = /(?:[a-z]:)?(?:[\\/][\w.@-]+){2,}/gi;
const URL_RE = /\bhttps?:\/\/[^\s'"]+/gi;
const NUMBER_RE = /\d+(?:\.\d+)?/g;
// Leading wrappers that say WHO failed, not WHAT failed: "Error:", "TypeError:",
// "plans:list failed:", "request failed (500):", "Uncaught (in promise)".
const WRAPPER_RE =
  /^(?:uncaught(?:\s+\(in promise\))?\s*|(?:[a-z]*error|exception|fatal|warn(?:ing)?)\s*:\s*|[\w:.-]+\s+failed(?:\s*\(#\))?\s*:\s*|failed(?:\s+to\s+\w+)?(?:\s*\(#\))?\s*:\s*|request failed(?:\s*\(#\))?\s*:\s*)/i;

/**
 * The defining text of one error message, or null when it is too generic to
 * identify a defect.
 */
export function normalizeErrorText(message: string): string | null {
  let text = message.slice(0, ERROR_SIGNATURE_MAX_INPUT).toLowerCase();
  // Keep the first non-empty line: stack frames below it vary by build.
  text = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? '';
  text = text
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(URL_RE, '<url>')
    .replace(UUID_RE, '<id>')
    .replace(ISO_TS_RE, '<ts>')
    .replace(WORK_ITEM_RE, '<item>')
    .replace(PATH_RE, (path) => `<path:${path.split(/[\\/]/).pop() ?? ''}>`)
    .replace(HEX_RE, '<hex>')
    .replace(NUMBER_RE, '#');
  for (let i = 0; i < 4; i++) {
    const next = text.replace(WRAPPER_RE, '').trim();
    if (next === text) break;
    text = next;
  }
  text = text.replace(/\s+/g, ' ').replace(/[.;,\s]+$/, '').trim();
  const words = text.split(' ').filter((word) => /[a-z]{2,}/.test(word));
  if (text.length < ERROR_SIGNATURE_MIN_CHARS || words.length < ERROR_SIGNATURE_MIN_WORDS) return null;
  return text;
}

/** The tool an error's source names, or null when the source is not a tool name. */
export function toolOfErrorSource(source: unknown): string | null {
  if (typeof source !== 'string') return null;
  const trimmed = source.trim();
  return TOOL_NAME_RE.test(trimmed) ? trimmed : null;
}

/** Signature of one error. */
export function errorSignatureOf(error: SignatureError): ErrorSignature | null {
  if (typeof error.message !== 'string') return null;
  const normalized = normalizeErrorText(error.message);
  if (!normalized) return null;
  const hash = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return { key: `${ERROR_SIGNATURE_KEY_PREFIX}${hash}`, tool: toolOfErrorSource(error.source), normalized };
}

/**
 * Signature of a report: its MOST RECENT error (the report context keeps the
 * tail, newest last). Earlier errors are context, not the defect being reported.
 */
export function reportErrorSignature(recentErrors: readonly SignatureError[] | null | undefined): ErrorSignature | null {
  if (!recentErrors || recentErrors.length === 0) return null;
  for (let i = recentErrors.length - 1; i >= 0; i--) {
    const signature = errorSignatureOf(recentErrors[i]!);
    if (signature) return signature;
  }
  return null;
}

/** The stored signature on an issue payload, if any. */
export function storedErrorSignature(payload: unknown): ErrorSignature | null {
  if (!payload || typeof payload !== 'object') return null;
  const stored = (payload as Record<string, unknown>).errorSignature;
  if (!stored || typeof stored !== 'object') return null;
  const { key, tool, normalized } = stored as Record<string, unknown>;
  if (typeof key !== 'string' || !key.startsWith(ERROR_SIGNATURE_KEY_PREFIX)) return null;
  return { key, tool: typeof tool === 'string' && tool ? tool : null, normalized: typeof normalized === 'string' ? normalized : '' };
}

/**
 * Same defect? The signatures must match, and when BOTH reports name a tool the
 * tools must match too. A report that names no tool (a person rarely knows one)
 * folds onto a report that does.
 */
export function sameErrorSignature(a: ErrorSignature, b: ErrorSignature): boolean {
  if (a.key !== b.key) return false;
  return !a.tool || !b.tool || a.tool === b.tool;
}
