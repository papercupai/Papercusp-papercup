/**
 * Code-intel result status — plan code-intel-delivery-and-outcomes-2026-10-26, P-004 (R-2, R-9).
 *
 * Every native code-intel call (graph:query, lsp:query, code:pack) stores exactly one status
 * on the invocation row it already writes (`tool_invocations.metadata_json.codeIntelResult`):
 * `measured`, or `unknown` with a reason from a FIXED set. Reused surface, not a second ledger:
 * the row is the invocation, so the status is correlated to it by construction.
 *
 * Two inputs decide the status:
 *  - the dispatcher EXIT (a thrown error, a timeout, a cancellation, a refusal), and
 *  - on a normal return, the PAYLOAD the handler returned (the measured/unknown + limitations
 *    shape the native contracts already carry: `status`, `error`, `freshness`, `truncation`,
 *    `coverage.limitations`, `discovery.outcome`).
 *
 * Conservative by design: a payload this module cannot read is `unknown` (reason `partial`),
 * never `measured`. An empty but well-formed answer is `measured` — absence of matches is a
 * measurement, not a failure.
 */
import { NATIVE_CODE_INTEL_TOOLS } from './native-adoption.ts';

/** The fixed reason set. Order is the precedence used when several signals are present. */
export const CODE_INTEL_UNKNOWN_REASONS = Object.freeze([
  'index-missing',
  'stale',
  'scope-refused',
  'timeout',
  'cancelled',
  'exception',
  'partial',
] as const);
export type CodeIntelUnknownReason = (typeof CODE_INTEL_UNKNOWN_REASONS)[number];

export type CodeIntelResultStatus =
  | { readonly status: 'measured'; readonly invocationId: string | null }
  | {
      readonly status: 'unknown';
      readonly reason: CodeIntelUnknownReason;
      readonly invocationId: string | null;
      /** Short evidence for the reason (bounded); never used for classification downstream. */
      readonly detail?: string;
    };

/** The metadata_json key the status rides under. */
export const CODE_INTEL_RESULT_METADATA_KEY = 'codeIntelResult';

const NATIVE = new Set<string>(NATIVE_CODE_INTEL_TOOLS);
export function isNativeCodeIntelTool(toolName: string): boolean {
  return NATIVE.has(toolName);
}

/** How one dispatch ended, as the dispatcher's telemetry sees it. */
export interface CodeIntelExit {
  readonly toolName: string;
  readonly invocationId?: string | null;
  /** The row status the dispatcher derived: ok | refused | error | timeout | invalid-input | role-not-allowed | quota-exceeded | replayed. */
  readonly status: string;
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
  /** The ToolResult the handler returned, on a normal return. */
  readonly resultSnapshot?: unknown;
}

const DETAIL_MAX = 200;
const bounded = (text: string): string => (text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 1)}…` : text);

const REFUSAL_STATUSES = new Set(['refused', 'invalid-input', 'role-not-allowed', 'quota-exceeded']);
const CANCEL_CODES = new Set(['aborted', 'abort', 'cancelled', 'canceled', 'parent-signal']);
const TIMEOUT_CODES = new Set(['timeout', 'dispatcher-timeout', 'idle-timeout']);

/** Classify one native code-intel call from its exit and, on a normal return, its payload. */
export function classifyCodeIntelExit(exit: CodeIntelExit): CodeIntelResultStatus {
  const invocationId = exit.invocationId ?? null;
  const code = (exit.errorCode ?? '').toLowerCase();
  const unknown = (reason: CodeIntelUnknownReason, detail?: string | null): CodeIntelResultStatus =>
    detail ? { status: 'unknown', reason, invocationId, detail: bounded(detail) } : { status: 'unknown', reason, invocationId };

  if (CANCEL_CODES.has(code)) return unknown('cancelled', exit.errorMessage ?? code);
  if (exit.status === 'timeout' || TIMEOUT_CODES.has(code)) return unknown('timeout', exit.errorMessage ?? code);
  if (REFUSAL_STATUSES.has(exit.status)) {
    // A self-reported refusal still carries the handler's payload; read it for a sharper reason
    // (a refusal that says the index is missing is index-missing, not a scope refusal).
    const fromPayload = exit.status === 'refused' ? payloadOf(exit.resultSnapshot) : undefined;
    if (fromPayload !== undefined) {
      const c = classifyCodeIntelPayload(fromPayload, invocationId);
      if (c.status === 'unknown' && c.reason !== 'partial') return c;
    }
    return unknown('scope-refused', exit.errorMessage ?? exit.status);
  }
  if (exit.status !== 'ok' && exit.status !== 'replayed') return unknown('exception', exit.errorMessage ?? (code || exit.status));
  const payload = payloadOf(exit.resultSnapshot);
  if (payload === undefined) return unknown('partial', 'result payload missing or unreadable');
  return classifyCodeIntelPayload(payload, invocationId);
}

/**
 * The handler's payload from a ToolResult: `structuredContent` when present, else the JSON in
 * the first text content block. `undefined` when neither is readable.
 */
export function payloadOf(resultSnapshot: unknown): unknown {
  if (!isRecord(resultSnapshot)) return undefined;
  if (resultSnapshot.structuredContent !== undefined) return resultSnapshot.structuredContent;
  const content = resultSnapshot.content;
  if (!Array.isArray(content)) return undefined;
  const first = content.find((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string');
  if (!first) return undefined;
  try {
    return JSON.parse((first as { text: string }).text);
  } catch {
    return undefined;
  }
}

/** Classify a native code-intel payload (the handler's `data`). */
export function classifyCodeIntelPayload(payload: unknown, invocationId: string | null = null): CodeIntelResultStatus {
  const unknown = (reason: CodeIntelUnknownReason, detail?: string | null): CodeIntelResultStatus =>
    detail ? { status: 'unknown', reason, invocationId, detail: bounded(detail) } : { status: 'unknown', reason, invocationId };
  if (!isRecord(payload)) return unknown('partial', 'malformed result payload');
  // code:pack wraps the code-intel answer beside its artifact.
  const body = isRecord(payload.answer) ? payload.answer : payload;

  const texts: string[] = [];
  if (typeof body.error === 'string' && body.error.trim()) texts.push(body.error);
  const coverage = isRecord(body.coverage) ? body.coverage : null;
  if (coverage && Array.isArray(coverage.limitations)) {
    for (const l of coverage.limitations) if (typeof l === 'string') texts.push(l);
  }
  const reasons = new Set<CodeIntelUnknownReason>();
  const errorText = typeof body.error === 'string' && body.error.trim() ? body.error : null;
  if (errorText) reasons.add(reasonFromText(errorText));

  const freshness = isRecord(body.freshness) ? body.freshness : null;
  if (freshness && freshness.staleVsDisk === true) reasons.add('stale');
  if (freshness && freshness.health === 'unhealthy') reasons.add(reasonFromText(texts.join(' ')) === 'index-missing' ? 'index-missing' : 'partial');

  const truncation = isRecord(body.truncation) ? body.truncation : null;
  if (truncation && truncation.truncated === true) reasons.add('partial');
  const discovery = isRecord(body.discovery) ? body.discovery : null;
  if (discovery && discovery.outcome === 'incomplete') reasons.add('partial');

  if (body.status === 'unknown' && reasons.size === 0) reasons.add(texts.length ? reasonFromText(texts.join(' ')) : 'partial');
  if (body.status !== undefined && body.status !== 'unknown' && body.status !== 'measured' && reasons.size === 0) {
    reasons.add('partial');
  }
  if (reasons.size === 0) return { status: 'measured', invocationId };
  const reason = CODE_INTEL_UNKNOWN_REASONS.find((r) => reasons.has(r)) ?? 'partial';
  return unknown(reason, errorText ?? texts[0] ?? null);
}

/** Map a free-text error or limitation onto the fixed reason set. Unrecognized text is `partial`. */
export function reasonFromText(text: string): CodeIntelUnknownReason {
  const t = text.toLowerCase();
  if (/\b(no|missing|absent|unavailable)\b[^.]{0,40}\bindex\b|\bindex\b[^.]{0,20}\b(missing|absent|not (built|found|available))\b|\bnot indexed\b|\bunindexed\b/.test(t)) {
    return 'index-missing';
  }
  if (/\bstale\b|out of date|behind (the )?(disk|working tree|head)/.test(t)) return 'stale';
  if (/timed? ?out|\btimeout\b|deadline exceeded/.test(t)) return 'timeout';
  if (/\bcancel(l)?ed\b|\babort(ed)?\b/.test(t)) return 'cancelled';
  if (/\brefus|\bout of scope\b|\boutside (the )?(scope|authori[sz]ed)|not authori[sz]ed|\brequires\b|\bscope\b/.test(t)) {
    return 'scope-refused';
  }
  return 'partial';
}

// ── R-9: unknown-rate alarm decision ─────────────────────────────────────────────────────────

/** Alarm when the unknown share is ABOVE this (exactly 20% does not alarm). */
export const UNKNOWN_RATE_THRESHOLD = 0.2;
/** Minimum non-canary calls in the window before the share is judged. */
export const UNKNOWN_RATE_MIN_CALLS = 50;
/** Window the share is computed over. */
export const UNKNOWN_RATE_WINDOW_HOURS = 24;

export type UnknownRateDecision =
  | { readonly alarm: true; readonly share: number; readonly total: number; readonly unknown: number; readonly reason: 'above-threshold' }
  | {
      readonly alarm: false;
      readonly share: number | null;
      readonly total: number | null;
      readonly unknown: number | null;
      readonly reason: 'within-threshold' | 'insufficient-calls' | 'malformed-window';
    };

/**
 * Decide the unknown-rate alarm for one window of NON-CANARY calls. A window whose counts are
 * missing or inconsistent is reported as `malformed-window` — never read as a clean window.
 */
export function decideUnknownRateAlarm(window: { total: unknown; unknown: unknown }): UnknownRateDecision {
  const total = window.total, unknown = window.unknown;
  if (!isCount(total) || !isCount(unknown) || unknown > total) {
    return { alarm: false, share: null, total: isCount(total) ? total : null, unknown: isCount(unknown) ? unknown : null, reason: 'malformed-window' };
  }
  if (total < UNKNOWN_RATE_MIN_CALLS) {
    return { alarm: false, share: total === 0 ? null : unknown / total, total, unknown, reason: 'insufficient-calls' };
  }
  // Integer comparison: unknown/total > 0.2  <=>  5*unknown > total. Avoids a float edge at exactly 20%.
  const share = unknown / total;
  if (unknown * 5 > total) return { alarm: true, share, total, unknown, reason: 'above-threshold' };
  return { alarm: false, share, total, unknown, reason: 'within-threshold' };
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
