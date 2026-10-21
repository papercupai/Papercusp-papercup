/**
 * Telemetry event kind taxonomy.
 *
 * Every report sent through /api/desktop/telemetry-report or forwarded
 * via lib/telemetry-flush.ts uses one of these kinds. The map is the
 * single source of truth — adding a new kind means editing this file
 * and nothing else. Consumers (operator, agents, plugins) import
 * `TELEMETRY_KINDS`/`TelemetryKind` and get autocomplete + compile
 * errors at every site that drifts.
 *
 * Local diagnostic payloads retain their existing wire format. Cloud
 * delivery uses the closed schemas below before anything leaves its host.
 */
import { z } from 'zod';
import { productTutorialLessonIds } from './onboarding/product-tutorial-lesson';

/** Browser-safe contract shared by the hosted ingress and its final writer.
 * Identity, environment, release and observation time are server-owned. */
const counter = z.number().int().nonnegative().safe();
const instant = z.string().datetime({ offset: true });
const operation = z.string().uuid();
const cloudEvent = <N extends string, P extends z.ZodRawShape>(event: N, properties: P) =>
  z.object({ event: z.literal(event), operation_id: operation, properties: z.object(properties).strict() }).strict();

export const CLOUD_MONITORING_DISCLOSURE_VERSION = '2026-10-13' as const;
export const CLOUD_ERROR_CODES = ['render_failure', 'request_failure', 'provisioning_failure', 'connector_unavailable'] as const;
export type CloudErrorCode = typeof CLOUD_ERROR_CODES[number];
/** Error constructor names that may cross the cloud boundary; any other value is reported as 'Error'. */
export const CLOUD_ERROR_TYPE_NAMES = ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError'] as const;
/** The single fingerprint input. The server hashes it with node:crypto and the
 * browser with SubtleCrypto, so one code/type pair groups identically whichever
 * side observed it. No message, stack, URL, component name or customer value is
 * part of it. */
export function cloudErrorFingerprintInput(code: CloudErrorCode, error: unknown): string {
  const type = error instanceof Error && (CLOUD_ERROR_TYPE_NAMES as readonly string[]).includes(error.name) ? error.name : 'Error';
  return JSON.stringify([code, type]);
}

export const cloudDiagnosticAggregateSchema = z.object({
  period_start: instant,
  period_end: instant,
  calls: counter,
  input_tokens: counter,
  output_tokens: counter,
  cache_read_tokens: counter,
  cache_creation_tokens: counter,
  provider_cost_usd: z.number().finite().nonnegative().nullable(),
  estimated_cost_usd: z.number().finite().nonnegative().nullable(),
  unpriced_calls: counter,
}).strict().refine(value => Date.parse(value.period_end) >= Date.parse(value.period_start), 'invalid aggregate window')
  .refine(value => value.unpriced_calls <= value.calls, 'unpriced calls exceed observed calls');

const cloudTelemetryEventUnion = z.discriminatedUnion('event', [
  cloudEvent('cloud_portal_session', { action: z.enum(['signed_in', 'returned', 'setup_started', 'setup_completed']) }),
  cloudEvent('cloud_tutorial', {
    lesson_id: z.literal('first-cloud-agent'), lesson_version: z.union([z.literal(1), z.literal(2)]),
    action: z.enum(['start', 'step_displayed', 'step_confirmed', 'waiting', 'recovery', 'pause', 'resume', 'skip', 'exit', 'replay', 'check_again', 'complete', 'help_requested']),
    step: z.enum(['connection', 'configuration', 'workspace', 'agent', 'task', 'result', 'revision', 'practice']).optional(),
    status: z.enum(['loading', 'ready', 'waiting', 'delayed', 'error', 'blocked', 'missing-target', 'complete']).optional(),
  }),
  cloudEvent('product_tutorial', {
    lesson_id: z.literal('product-guide'), lesson_version: z.literal(3),
    action: z.enum(['start', 'resume', 'pause', 'skip', 'guide_closed', 'lesson_displayed', 'explanation_reviewed', 'waiting', 'recovery', 'help_requested']),
    lesson: z.string().max(120).refine(id => productTutorialLessonIds.has(id)).optional(),
  }),
  cloudEvent('cloud_workspace_provisioning', {
    phase: z.enum(['requested', 'ready', 'failed', 'destroyed']),
    provider: z.enum(['gcp', 'aws', 'azure', 'local']), hosting_mode: z.enum(['managed', 'byoc', 'unknown']),
    duration_ms: counter.max(7 * 24 * 60 * 60 * 1000).optional(),
    failure_code: z.enum(['provider_refused', 'timeout', 'connection_unavailable', 'internal_failure']).optional(),
  }),
  cloudEvent('cloud_feature_adoption', { feature: z.enum(['workspace_list', 'connection_setup', 'cloud_tutorial', 'billing', 'monitoring']) }),
  cloudEvent('cloud_error', { code: z.enum(CLOUD_ERROR_CODES), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.object({ event: z.literal('cloud_diagnostic_aggregate'), operation_id: operation, properties: cloudDiagnosticAggregateSchema }).strict(),
]);
// Zod deliberately omits __proto__ while enumerating unknown keys. Our writer
// contract rejects the input, rather than silently accepting a stripped key.
export const cloudTelemetryEventSchema = z.preprocess(value => {
  const plain = (input: unknown): input is Record<string, unknown> => input !== null && typeof input === 'object' &&
    !Array.isArray(input) && [Object.prototype, null].includes(Object.getPrototypeOf(input));
  const dangerous = (input: Record<string, unknown>) => Object.keys(input).some(key => ['__proto__', 'constructor', 'prototype'].includes(key));
  if (!plain(value) || dangerous(value) || !plain(value.properties) || dangerous(value.properties)) return undefined;
  return value;
}, cloudTelemetryEventUnion);
export type CloudTelemetryEvent = z.infer<typeof cloudTelemetryEventSchema>;

/** Stored locally in existing scoped preferences. No maintainer override. */
const consentChoice = z.object({ enabled: z.boolean(), since: instant.nullable() }).strict();
export const cloudTelemetryConsentSchema = z.object({
  disclosure_version: z.literal(CLOUD_MONITORING_DISCLOSURE_VERSION),
  analytics: consentChoice,
  diagnostics: consentChoice,
}).strict();
export type CloudTelemetryConsent = z.infer<typeof cloudTelemetryConsentSchema>;
/** Customers choose categories; only the server can stamp consent epochs. */
export const cloudTelemetryConsentUpdateSchema = z.object({
  disclosure_version: z.literal(CLOUD_MONITORING_DISCLOSURE_VERSION),
  analytics: z.boolean().optional(),
  diagnostics: z.boolean().optional(),
}).strict().refine(value => value.analytics !== undefined || value.diagnostics !== undefined, 'no consent choice');
export type CloudTelemetryConsentUpdate = z.infer<typeof cloudTelemetryConsentUpdateSchema>;
export const DEFAULT_CLOUD_TELEMETRY_CONSENT: CloudTelemetryConsent = {
  disclosure_version: CLOUD_MONITORING_DISCLOSURE_VERSION,
  analytics: { enabled: false, since: null }, diagnostics: { enabled: false, since: null },
};

export const TELEMETRY_KINDS = {
  /** End-user-triggered diagnostic. Carries no automatic info — used
   *  by Step 12's "Send test report" button. */
  test: 'test',

  /** Unhandled JS exception caught by the operator's global error
   *  boundary. Payload should include stack + url + componentStack. */
  crash: 'crash',

  /** Tauri shell or Rust-side panic surfaced via the bridge.
   *  Payload: panicMessage, location. */
  native_crash: 'native_crash',

  /** Operator boot failed (couldn't bind port, sidecar refused to
   *  start, embedded PG failed to come up). Payload: stage, detail. */
  startup_failed: 'startup_failed',

  /** A migration runner aborted. Payload: migration filename,
   *  errorCode, queryFragment. */
  migration_failed: 'migration_failed',

  /** A long-running operation hit a hard timeout. Payload: operation,
   *  elapsedMs, lastEventTs. */
  hang_detected: 'hang_detected',

  /** A locked-down route returned 403/404 because the user's PostHog
   *  flag evaluated false. Useful for "are users hitting cut surfaces
   *  via stale bookmarks?". Payload: route, flagKey. */
  feature_unavailable: 'feature_unavailable',

  /** Anchored to Setup Wizard interactions — useful for understanding
   *  drop-off through the 12-step flow. Payload: stepId, action
   *  ('view'|'skip'|'complete'|'finish'). */
  setup_step: 'setup_step',

  /** A swarm peer's announce was conclusively REFUSED admission to the
   *  substrate (per-peer-Hypercore + channel-2-admitted-merge boundary,
   *  D-004). Fleet-health signal: a spike means canonicalisation drift,
   *  a stale revocation set, or active forgery attempts. Payload:
   *  harness_slug, reason ('bad_sig'|'binding_invalid'|'revoked'), and a
   *  truncated peer label (NOT the full device pubkey). The same event is
   *  recorded locally on the boot-history channel; this kind forwards the
   *  count off-device when the user has opted in. */
  substrate_admission_rejected: 'substrate_admission_rejected',

  /** Slow improvements:capture occurrence persistence; records client-observed
   *  canonical lookup and occurrence INSERT await times, without work-item data. */
  capture_stage_timing: 'capture_stage_timing',
} as const;

export type TelemetryKind = (typeof TELEMETRY_KINDS)[keyof typeof TELEMETRY_KINDS];

/**
 * Loose payload typing — each kind has a recommended shape but the
 * wire is permissive. Use this as the second arg to telemetry helpers
 * so callers get a hint without breaking forward-compat.
 */
export interface TelemetryPayloads {
  test: { source?: string; triggered_at?: string };
  crash: { message: string; stack?: string; url?: string; componentStack?: string };
  native_crash: { panicMessage: string; location?: string };
  startup_failed: { stage: 'port' | 'sidecar' | 'pg' | 'migrations' | 'other'; detail: string };
  migration_failed: { migration: string; errorCode?: string; queryFragment?: string };
  hang_detected: { operation: string; elapsedMs: number; lastEventTs?: string };
  feature_unavailable: { route: string; flagKey: string };
  setup_step: { stepId: string; action: 'view' | 'skip' | 'complete' | 'finish' };
  substrate_admission_rejected: {
    harness_slug: string;
    reason: 'bad_sig' | 'binding_invalid' | 'revoked';
    /** Truncated peer label (e.g. first bytes of the log key) — NOT the full pubkey. */
    peer?: string;
  };
  capture_stage_timing: {
    operation: 'issue_occurrence_persistence';
    sourceTool: 'improvements:capture';
    reportKind: 'canonical-created';
    startedAt: string;
    canonicalLookupAwaitMs: number | null;
    occurrenceInsertAwaitMs: number | null;
    totalElapsedMs: number;
    outcome: 'recorded' | 'canonical-missing' | 'insert-empty' | 'failed';
    failedStage: 'canonical-lookup' | 'occurrence-insert' | null;
  };
}

export function isTelemetryKind(s: string): s is TelemetryKind {
  return Object.prototype.hasOwnProperty.call(TELEMETRY_KINDS, s);
}
