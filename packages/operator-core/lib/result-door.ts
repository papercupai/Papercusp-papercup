/**
 * Per-tool-result door (deterministic-context-carry P-006 leg C, ornith-overflow brief).
 *
 * Caps the TEXT content of one MCP `tools/call` result at the `resultEach` door
 * (context-doors.ts — 1500 tokens at the universal 8K floor, ~6000 chars) so a
 * single oversized tool result cannot blow the per-hop ingestion budget the
 * compaction thresholds are derived from (P-007 holds by CONSTRUCTION). The FULL
 * original text is spilled to the existing scratch store (scratch-uri.ts,
 * "tool-output-as-resource" T2.3) behind a pointer line, so nothing is lost —
 * the reader pages the spill file instead of paying for the whole result in one
 * hop.
 *
 * Same universal-floor rationale as the wake-executor injection door (leg B):
 * this seam does not know the CALLER's context window, and /26 lands virtually
 * every fleet model at the 8K floor anyway, so the floor door applies to all.
 * P-023 makes the knobs configurable.
 *
 * Applied at ONE choke point — the direct tools/call `execute()` path in
 * _mcp-handler.ts, AFTER the delta proxy — because that is where every
 * model-facing result converges (a tools:invoke inner result re-enters through
 * its outer call). Machine-consumed dispatches (capabilities/invoke, the
 * tools:invoke inner re-dispatch, TUI plan-item routes) are deliberately NOT
 * doored: their consumers parse programmatically and pay no context rent.
 *
 * Never doored, by construction:
 *   - genuine delta ENVELOPE results (`_meta.delta.mode !== 'full'`) —
 *     content[0].text is structured JSON the CLIENT JSON.parses to
 *     reconstruct; a cap corrupts it (the delta protocol is itself a
 *     result-shrinking mechanism). NOTE: every delta-CAPABLE tool also
 *     stamps `_meta.delta` on an ORDINARY full response (`mode:'full'`,
 *     reason `no_request` or `proxy_reconstructed`) to advertise the
 *     capability + carry a cursor — that shape is a normal body and MUST
 *     still be doored (EI-19325631662380565: the mere presence of the
 *     block used to skip the door for the whole list-tool family, the
 *     fattest population it exists to cap);
 *   - non-text content items (images, resource links) — passed through intact.
 *
 * Kill-switch: PAPERCUSP_RESULT_DOOR_OFF=1 bypasses entirely (operational
 * rollback, mirrors PAPERCUSP_INJECTION_DOOR_OFF). Unexpected errors while
 * capping/spilling remain fail-soft and return the ORIGINAL result untouched.
 * A recognized hard spill-write failure instead returns a bounded
 * `output_spill_failed` error, or a receipt-preserving projection for committed
 * writes (`scheduler:get_next`, `improvements:agent-review`, `coord:send`,
 * `work_items:complete`, and `work_items:set_blocker`). A bounded timeout keeps
 * a typed pending cursor while its already-started writer continues; neither
 * path re-exposes an over-budget result.
 */

import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import type { ScratchWriteTimings } from './scratch-gc';
import { withBoundedTimeout } from './bounded-timeout';
import { projectBoundedPayload, type BoundedPayloadRecovery, type BulkEnvelopeProjectionOpts } from '@papercusp/tooldef';
import { compactLeaderBriefForResultDoor } from './agent-tools/fleet/leader-brief-shape';
import { decode } from '@papercusp/result-encoding';
import { CHARS_PER_TOKEN_ESTIMATE, computeTurnDoors } from './context-doors';
import { getDoorConstantsSync } from './context-doors-config';
import { buildScratchUri, safeScratchFilesystemPath } from './scratch-uri';
import { buildSpillIndex } from './result-door-index';
import { COORD_SEND_RECEIPT_RECOVERY, isCoordSendDeliveryDiagnostic } from './agent-tools/coordination/tools/inbox-content-bounds';
import { classifyProjectionBody, type ProjectionBodyShape } from './result-projection';
import {
  buildOutputEnvelope,
  OUTPUT_EVIDENCE_CLASSES,
  type OutputEvidenceClass,
  type OutputEvidenceReferenceContentItem,
  type OutputReferenceContentItem,
} from './output-envelope';
import {
  contentMetadata,
  persistVolatileScratchReference,
  scratchReferencePayloadByteOffset,
  storeVolatileScratchReference,
  VOLATILE_SCRATCH_REFERENCE_TTL_MS,
  writeScratchReference,
  type ScratchReferenceManifest,
} from './scratch-reference';

/** The BAKED floor `resultEach` door (window 0 ⇒ the 8K-floor split ⇒ 1500 tokens).
 *  The live door is resolved per call through the P-023 config surface
 *  (getDoorConstantsSync — workspace defaults ⟵ per-session override); un-configured,
 *  it is exactly this value. */
export const RESULT_DOOR_TOKENS = computeTurnDoors(0).resultEach;
const RESULT_DOOR_SCRATCH_WRITE_WAIT_MS = 30_000;
const RESULT_DOOR_DURABLE_FALLBACK_WAIT_MS = 5_000;

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOOL_SEGMENT_REGEX = /^[A-Za-z0-9._:-]+$/;

// Keep this model-facing ceiling synchronized with MAX_BYTE_PAGE in
// agent-tools/capability/read.ts. A cursor advertises the safe page request
// (3,072 bytes) separately, but callers also need the tool's schema maximum
// when they choose their own page size during recovery.
const CAPABILITY_READ_MAX_BYTE_PAGE = 4_096;

/** The subset of an MCP tools/call result the door reads/rewrites. */
export interface DoorableResult {
  content: ReadonlyArray<{ type?: string; text?: string } | Record<string, unknown>>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  structuredContent?: unknown;
}

export interface ResultDoorOpts {
  /** Canonical tool name (colon form) — names the scratch subdir + pointer line. */
  toolName: string;
  /** When the outer call is tools:invoke, the nested target whose result reached this door. */
  nestedTargetToolName?: string;
  /** Effective per-call effect, including a tool's effectForCall classification. */
  effect?: 'read' | 'write';
  /** Caller's workspace id; '*'/invalid shapes spill under 'unscoped'. */
  workspaceId?: string | null;
  /** Spawn run id when it is a UUID; otherwise a fresh UUID names the spill dir. */
  runId?: string | null;
  /** Caller's resolved agent ownerId (resolveAgentIdentity) — keys the P-023
   *  per-session door override; absent ⇒ workspace/baked constants. */
  ownerId?: string | null;
  /** Aggregate cohort reserved when this MCP call STARTED. Explicit client
   *  outputGroupId/turnId is preferred; legacy clients use a documented
   *  start-time compatibility cohort (see beginResultDoorAggregate). */
  aggregateScope?: ResultDoorAggregateScope | null;
  /** Explicit caller-selected paths that must survive a bounded identity
   * fallback when the result-door is applied after `projection.pick`. */
  preservePaths?: readonly string[];
  /**
   * Preserve semantic failures in keyed-array bulk results before projecting
   * bulky successful rows. `true` uses the canonical `{ results, counts, ok }`
   * envelope; an object supplies custom key names. Omit to let the projector
   * infer the canonical envelope from the returned body.
   */
  bulkEnvelope?: BulkEnvelopeProjectionOpts | boolean;
  /**
   * Collector for spill writes deferred off the main thread (WI-10004533). When given,
   * every spill file is written with fs.promises and its promise lands here; the result
   * names files that are NOT on disk yet. Use applyResultDoorAsync rather than passing
   * this by hand — it waits boundedly and returns a typed pending cursor if a write runs
   * past its deadline.
   */
  deferredScratchWrites?: Promise<void>[];
  /** A spill that outlives the bounded request wait may finish after the response.
   *  The transport uses this callback to backfill its invocation row on late settlement. */
  onLateScratchWriteSettled?: (settlement: ResultDoorLateScratchWriteSettlement) => void | Promise<void>;
  /** Persist the bounded-wait timeout before registering the late-settlement backfill. */
  onScratchWritePending?: (timeout: ResultDoorScratchWriteTimeout) => void | Promise<void>;
  /** Phase attribution for awaited spill writes, including failed writes. */
  onScratchWriteTiming?: (timings: ScratchWriteTimings) => void;
  /** MCP request ID attached to process-local scratch mutex holder diagnostics. */
  requestTraceId?: string;
  /** Internal replay of a deferred failure: cap honestly without retrying filesystem I/O. */
  scratchWriteFailure?: { error: unknown };
}

export interface ResultDoorLateScratchWriteSettlement {
  status: 'persisted' | 'failed';
  spillPath: string;
  spillUri: string;
  originalBytes: number;
  returnedContextBytes: number;
  reason: string;
  aggregateOutputEscape: boolean;
  errorCode?: string;
}

export interface ResultDoorScratchWriteTimeout {
  timeoutMs: number;
  timedOutAt: string;
  spillPath: string;
  spillUri: string;
  originalBytes: number;
  returnedContextBytes: number;
  reason: string;
  aggregateOutputEscape: boolean;
}

export interface ResultDoorAggregateScope {
  /** Opaque, bounded server key. Never contains the caller's raw ids. */
  key: string;
  mode: 'explicit' | 'compatibility';
  groupIdHash: string;
}

export interface ResultDoorAggregateReservation {
  mode: ResultDoorAggregateScope['mode'];
  groupIdHash: string;
  budgetBytes: number;
  consumedBeforeBytes: number;
  /** Bytes charged to the aggregate after applying the per-result ceiling.
   *  Raw sourceBytes remains visible separately for diagnosis. */
  chargedBytes: number;
  sourceBytes: number;
  acceptedBytes: number;
  consumedAfterBytes: number;
  exceeded: boolean;
}

const AGGREGATE_COMPAT_IDLE_GAP_MS = 2_000;
const AGGREGATE_STATE_TTL_MS = 5 * 60_000;
const aggregateCohorts = new Map<string, { generation: number; lastStartedAtMs: number }>();
const aggregateUsage = new Map<string, { usedBytes: number; lastTouchedAtMs: number }>();
let aggregateGeneration = 0;
let aggregateOps = 0;

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

/**
 * Reserve a cohort at REQUEST START, not result completion. Parallel calls in a
 * legacy client therefore remain grouped even when one tool runs much longer
 * than its siblings. Clients that can identify a model turn/run should pass an
 * explicit outputGroupId (or compatibility alias turnId); that is the exact
 * route. The fallback groups starts separated by <=2s and is deliberately
 * declared best-effort because an MCP request alone carries no model-turn id.
 */
export function beginResultDoorAggregate(input: {
  sessionKey: string;
  outputGroupId?: string | number | null;
  startedAtMs?: number;
}): ResultDoorAggregateScope {
  const sessionHash = shortHash(input.sessionKey || 'unscoped');
  if (input.outputGroupId !== undefined && input.outputGroupId !== null && String(input.outputGroupId).trim()) {
    const groupIdHash = shortHash(String(input.outputGroupId));
    return { key: `${sessionHash}:explicit:${groupIdHash}`, mode: 'explicit', groupIdHash };
  }

  const startedAtMs = Number.isFinite(input.startedAtMs) ? Number(input.startedAtMs) : Date.now();
  const previous = aggregateCohorts.get(sessionHash);
  const generation =
    !previous || startedAtMs - previous.lastStartedAtMs > AGGREGATE_COMPAT_IDLE_GAP_MS
      ? ++aggregateGeneration
      : previous.generation;
  aggregateCohorts.set(sessionHash, {
    generation,
    lastStartedAtMs: Math.max(startedAtMs, previous?.lastStartedAtMs ?? startedAtMs),
  });
  const groupIdHash = shortHash(`compatibility:${generation}`);
  return { key: `${sessionHash}:compatibility:${generation}`, mode: 'compatibility', groupIdHash };
}

function pruneAggregateState(now: number): void {
  aggregateOps += 1;
  if (aggregateOps % 256 !== 0) return;
  for (const [key, value] of aggregateUsage) {
    if (now - value.lastTouchedAtMs > AGGREGATE_STATE_TTL_MS) aggregateUsage.delete(key);
  }
  for (const [key, value] of aggregateCohorts) {
    if (now - value.lastStartedAtMs > AGGREGATE_STATE_TTL_MS) aggregateCohorts.delete(key);
  }
}

function reserveAggregateBytes(
  scope: ResultDoorAggregateScope,
  sourceBytes: number,
  chargedBytes: number,
  budgetBytes: number,
): ResultDoorAggregateReservation {
  const now = Date.now();
  pruneAggregateState(now);
  const prior = aggregateUsage.get(scope.key);
  const consumedBeforeBytes = prior?.usedBytes ?? 0;
  const remaining = Math.max(0, budgetBytes - consumedBeforeBytes);
  const acceptedBytes = Math.min(chargedBytes, remaining);
  const consumedAfterBytes = consumedBeforeBytes + acceptedBytes;
  aggregateUsage.set(scope.key, { usedBytes: consumedAfterBytes, lastTouchedAtMs: now });
  return {
    mode: scope.mode,
    groupIdHash: scope.groupIdHash,
    budgetBytes,
    consumedBeforeBytes,
    chargedBytes,
    sourceBytes,
    acceptedBytes,
    consumedAfterBytes,
    exceeded: chargedBytes > remaining,
  };
}

/** Test-only state reset; exported so focused tests never depend on process order. */
export function resetResultDoorAggregatesForTests(): void {
  aggregateCohorts.clear();
  aggregateUsage.clear();
  aggregateGeneration = 0;
  aggregateOps = 0;
}

// EI-18745696571494110: some tools truncate individual FIELDS inside their own
// JSON body (coord:inbox's per-entry `body_truncated`, plan/list summaries'
// `summary_truncated`, …) independently of this door's own budget — there is
// no shared `_meta` marker for this (unlike `payloadProjection` above), because
// each tool bakes its own field-level cutoff into the body it serializes. When
// that happens on a result that ALSO overflows the door, the spill faithfully
// preserves the tool's output — but that output was already missing the field
// content, so "page the spill instead of re-running" is a dead end: the spill
// can never contain what the tool itself never serialized. Detect the generic
// `"<name>_truncated": true` / `"<name>Truncated": true` JSON shapes and
// their bare TOON equivalents (`<name>Truncated: true`) textually (cheap,
// tool-agnostic). Then swap the footer/header wording so the reader is
// pointed at re-calling the tool with a wider field-level limit instead of
// paging a spill that cannot help. The camelCase form is used by
// build:typecheck's public fields (errorsTruncated, byFileTruncated).
const INNER_TRUNCATION_MARKER_REGEX =
  /(?:"((?:\w+_truncated|\w+Truncated))"|(?<![\w"])((?:\w+_truncated|\w+Truncated)))\s*:\s*true\b/g;
const INNER_TRUNCATION_TEXT_REGEX = /(?:…|\.\.\.)\s*\[TRUNCATED[^\]]*\]/gi;
const INNER_PARTIAL_FLAG_CANDIDATE_REGEX = /(?<!\\)"_partial"\s*:\s*true\b/;
const SUMMARY_NOTICE_JSON_CANDIDATE_REGEX = /(?<!\\)"summaryNotice"\s*:\s*\{/;
const SUMMARY_NOTICE_TEXT_MARKER_REGEX = /^\s*summaryNotice\s*:\s*\{\s*truncated\s*:\s*true\b/m;

// coord:thread intentionally returns a bounded window/page and marks fields
// that have field-specific recovery routes: follow next_page_offset for rows,
// or use coord:read with the entry's msg_id for omitted envelope details.
// Those markers are part of its documented response contract, not evidence
// that this result-door call failed or that its own spill discarded data.
const COORD_THREAD_RECOVERABLE_TRUNCATION_MARKERS = new Set([
  'entries_truncated',
  'thread_metadata_truncated',
  'thread_entry_truncated',
  'summary_truncated',
  'body_truncated',
  'sections_truncated',
  'to_truncated',
]);

function hasPartialFlag(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasPartialFlag);
  if (value === null || typeof value !== 'object') return false;
  const object = value as Record<string, unknown>;
  return object._partial === true || Object.values(object).some(hasPartialFlag);
}

/** _partial can mark a row or a keyed map. Parse JSON after a cheap candidate
 *  check so examples embedded in escaped string values do not become markers. */
function hasStructuredPartialFlag(text: string): boolean {
  if (!INNER_PARTIAL_FLAG_CANDIDATE_REGEX.test(text)) return false;
  const jsonSlice = findJsonPrefixSlice(text);
  try {
    const value = JSON.parse(jsonSlice ? text.slice(jsonSlice.start, jsonSlice.end) : text);
    return hasPartialFlag(value);
  } catch {
    return false;
  }
}

function hasTruncatedSummaryNotice(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasTruncatedSummaryNotice);
  if (value === null || typeof value !== 'object') return false;
  const object = value as Record<string, unknown>;
  const notice = object.summaryNotice;
  if (notice !== null && typeof notice === 'object' && !Array.isArray(notice)) {
    if ((notice as Record<string, unknown>).truncated === true) return true;
  }
  return Object.values(object).some(hasTruncatedSummaryNotice);
}

/** code:run marks its already-bounded return with `summaryNotice.truncated`.
 *  Parse JSON so an example inside a string is not treated as live metadata;
 *  accept the dedicated bare-text marker form used by diagnostic renderings. */
function hasStructuredSummaryNoticeTruncation(text: string): boolean {
  if (SUMMARY_NOTICE_TEXT_MARKER_REGEX.test(text)) return true;
  if (!SUMMARY_NOTICE_JSON_CANDIDATE_REGEX.test(text)) return false;
  const jsonSlice = findJsonPrefixSlice(text);
  try {
    const value = JSON.parse(jsonSlice ? text.slice(jsonSlice.start, jsonSlice.end) : text);
    return hasTruncatedSummaryNotice(value);
  } catch {
    return false;
  }
}

function innerTruncationRecoveryInstruction(
  toolName: string,
  markers: readonly string[],
  nestedTargetToolName?: string,
): string {
  if (toolName === 'coord:send') return COORD_SEND_RECEIPT_RECOVERY;
  const recoveryTarget = toolName === 'tools:invoke' ? nestedTargetToolName : toolName;
  if (recoveryTarget === 'code:run' && markers.includes('summaryNotice.truncated')) {
    return (
      'Read the original unshaped return through `summaryNotice.rawSummaryCursor` with `capability:read`, ' +
      'following `next_cursor`; the ordinary result-door spill contains only the emitted bounded summary. ' +
      'If `rawSummaryCursor.status` is `unavailable`, re-run code:run with a smaller return split into bounded slices.'
    );
  }
  if (recoveryTarget === 'work_items:get' && markers.includes('checkpointTruncated')) {
    return 'The work-item checkpoint was clipped before this result door. Read the exact stored text with work_items:get { id, checkpointOnly:true, offset:0, limit:512 }; follow checkpointPage.nextOffset and restart at offset 0 if checkpointContentHash changes. payloadTier:\'full\' cannot restore checkpoint text already clipped by the tool.';
  }
  if (recoveryTarget === 'work_items:get' && markers.includes('bodyTruncated')) {
    return (
      'A work-item comment body was clipped by work_items:get\'s threadWindow shaper ' +
      '(bodyTruncated/bodyChars). Re-read the same work item with payloadTier:\'full\' ' +
      'and a narrow dispatch projection selecting results[].threadWindow.posts[].body. ' +
      'Keep the projection narrow so the full response fits the result door; a spill ' +
      'cannot restore body bytes omitted by the upstream shaper.'
    );
  }
  if (markers.includes('textTruncated') && toolName === 'work_items:get') {
    return 'The clipped prior-attempt record has a field-specific recovery handle: read its rawRef and pass it in priorAttemptRefs to work_items:get. payloadTier:\'full\' does not expand source text already clipped by the tool.';
  }
  if (markers.includes('textTruncated') && toolName === 'tools:invoke') {
    if (nestedTargetToolName === 'work_items:get') {
      return 'The nested work_items:get target marked prior-attempt text as textTruncated. Read the affected record rawRef and pass it in priorAttemptRefs to work_items:get. payloadTier:\'full\' does not expand source text already clipped by the tool, and work_items:get has no wider per-field limit argument.';
    }
    const target = nestedTargetToolName ? ' (' + nestedTargetToolName + ')' : '';
    return 'The nested target' + target + ' already marked a field as truncated. Re-read through that target\'s documented field-specific recovery handle or narrower arguments; tools:invoke has no generic per-field limit.';
  }
  if (toolName === 'capability:read') {
    return (
      'capability:read has no per-field limit; `limit` counts lines. For exact long text, re-read the original ' +
      'file with `byte_offset` + `byte_limit` (without `evidence_class`) and follow the returned `next_cursor`.'
    );
  }
  return 'The ' + toolName + ' result already marked a field as truncated. Re-read using that field\'s documented recovery handle or narrower arguments; a wider per-field limit may not exist.';
}

function upstreamProjectionRecoveryInstruction(
  toolName: string,
  nestedTargetToolName?: string,
  innerTruncationMarkers: readonly string[] = [],
  effect?: 'read' | 'write',
): string {
  const recoveryToolName = toolName === 'tools:invoke' ? nestedTargetToolName : toolName;
  const writeRecovery =
    recoveryToolName === 'scorecards:emit'
      ? 'scorecards:emit may have recorded a card. Do NOT repeat this non-idempotent emit to recover fields omitted upstream; ' +
        'page the reference for its emitted receipt and inspect the scorecard ledger before any follow-up.'
      : `${recoveryToolName ? `The ${recoveryToolName} write` : 'The nested write'} may have committed. ` +
        'Do NOT repeat the write to recover fields omitted by upstream shaping; page the reference for its emitted receipt, ' +
        'then read the operation’s authoritative state before deciding on any follow-up.';
  const projectionRecovery =
    effect === 'write' || recoveryToolName === 'scorecards:emit'
      ? writeRecovery
      : !recoveryToolName || recoveryToolName === 'tools:invoke'
        ? 'The outer `tools:invoke` result does not identify a re-callable nested target. ' +
          'Use the original target\'s documented recovery route; `tools:invoke` cannot invoke itself.'
        : `Re-call ${recoveryToolName} with payloadTier:'full' (or narrower args) for the missing detail. ` +
          `If your client validates against the target tool schema, use \`tools:invoke { name:'${recoveryToolName}', args:{ …original args, payloadTier:'full' } }\`. `;
  if (recoveryToolName === 'coord:send') return COORD_SEND_RECEIPT_RECOVERY;
  if (recoveryToolName === 'plans:start') return PLANS_START_RECEIPT_RECOVERY;
  if (innerTruncationMarkers.length === 0) return projectionRecovery;

  // Upstream payload shaping and tool-owned field bounds are independent loss
  // sources. Keep both recovery routes visible: e.g. work_items:get's clipped
  // prior-attempt text needs priorAttemptRefs, while other tier-omitted fields
  // need a full-tier or narrower re-read.
  return (
    `${innerTruncationRecoveryInstruction(toolName, innerTruncationMarkers, nestedTargetToolName)} ` +
    `For other fields omitted by the upstream payload projection, ${projectionRecovery}`
  );
}

/** Distinct truncation and partial marker names found in text (capped — this
 *  feeds advisory wording, not an audit). Empty when none are present. */
function detectInnerTruncationMarkers(
  text: string | readonly string[],
  toolName: string,
  nestedTargetToolName?: string,
): string[] {
  const textItems = typeof text === 'string' ? [text] : [...text];
  const sourceText = textItems.join('\n\n');
  const diagnosticToolName = toolName === 'tools:invoke' ? nestedTargetToolName : toolName;
  const found = new Set<string>();
  INNER_TRUNCATION_MARKER_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INNER_TRUNCATION_MARKER_REGEX.exec(sourceText))) {
    const marker = m[1] ?? m[2];
    if (isCoordSendDeliveryDiagnostic(diagnosticToolName, marker)) continue;
    found.add(marker);
    if (found.size >= 5) break;
  }
  // Work-item and other custom shapers also put the cutoff directly in the
  // field value (`…[TRUNCATED ...]`) without a sibling boolean marker. Keep a
  // named marker for that shape so a hard reference spill cannot promise bytes
  // that the upstream shaper never serialized.
  INNER_TRUNCATION_TEXT_REGEX.lastIndex = 0;
  if (INNER_TRUNCATION_TEXT_REGEX.test(sourceText)) found.add('textTruncated');
  if (textItems.some(hasStructuredPartialFlag)) found.add('_partial');
  if (textItems.some(hasStructuredSummaryNoticeTruncation)) found.add('summaryNotice.truncated');
  return [...found];
}

function hasOnlyRecoverableCoordThreadMarkers(
  markers: readonly string[],
  toolName: string,
  nestedTargetToolName?: string,
): boolean {
  const target = toolName === 'tools:invoke' ? nestedTargetToolName : toolName;
  return target === 'coord:thread' && markers.length > 0 &&
    markers.every((marker) => COORD_THREAD_RECOVERABLE_TRUNCATION_MARKERS.has(marker));
}

/**
 * P-020 / D-041 discoverability. The projection stage is a DISPATCH-level
 * reserved arg, so it appears in no tool's inputSchema — which means no agent
 * would ever learn it exists, and a built-but-unreachable feature is dead code
 * however green its tests. Injecting the schema into every tool would blow
 * the P-011 prompt-weight budget for a knob most calls never use.
 *
 * A truncated result is the one moment the answer is both relevant and earned:
 * the caller has just been handed less than they asked for and is about to go
 * page a spill file. Teaching `projection` HERE costs zero standing context and
 * arrives exactly when it is actionable — the same "advise at the decision
 * point" shape as the code:run batch nudge.
 */
/**
 * D-012 (plan agent-context-firewall-and-output-spill-2026-08-02): the hint is
 * a FUNCTION of the payload, not a constant.
 *
 * The constant this replaces led with `pipe` "for text" on every result —
 * including the one-line JSON bodies that are the overwhelming majority of what
 * this door cuts. On such a body the line operators are provably all-or-nothing
 * (measured: `grep` with a non-matching pattern returns an EMPTY body, `head
 * n:3` returns the ENTIRE array), so the footer's first suggestion was the one
 * operator family that cannot reduce the payload it is attached to — and a
 * no-match reads exactly like a successful filter. Filed as
 * EI-19387749343846381.
 *
 * opencode does the same thing correctly and is where the ruling comes from
 * (`tool/truncate.ts:109-111`): its spill hint branches on `hasTaskTool(agent)`
 * so it never advertises a recovery route the reading agent cannot take. This
 * is that, applied to payload TYPE — and the classification comes from
 * `classifyProjectionBody`, the same function the projection stage itself uses
 * to find the body `pick` operates on, so the advertised operator cannot drift
 * from the one that would actually run.
 *
 * `preClassified` closes the one seam where that guarantee LEAKED. The spill
 * writer classifies the body with `classifyProjectionBody` AND, when that
 * misses, recovers a JSON payload carrying a same-item framework advisory
 * suffix (`See also:` / `[batch-hint]` / `[nudge]`) via `findJsonPrefixSlice`.
 * Re-deriving the shape here saw only the weaker half, so a body the door had
 * just proven to be JSON — and written to the spill as JSON — was advertised as
 * "N lines of non-JSON text … `pick` does not apply here", in the SAME `next`
 * string that says "JSON starts after cursor.bodyOffsetInPayload". Measured on
 * `work_items:claimable` (EI-20071580479842384): the same tool+args reduced 95%
 * under `pick: ["claimable[].id"]` while the spill told the reader to use
 * `pipe`, which on a JSON body is the all-or-nothing trap this hint exists to
 * warn about — a no-match returns an EMPTY body that reads like a filter that
 * worked. Callers that have already classified MUST pass their shape.
 *
 * oversized-tool-results-reduction-2026-10-12#D-005 changed the `pipe` half:
 * `applyProjection` now renders a pipe-only JSON body with 2-space indentation
 * before the line operators run, so `grep`/`head` cut it by field line instead
 * of keeping all or nothing. `pick` still leads (it returns JSON; `pipe` returns
 * lines), but the hint no longer claims `pipe` cannot reduce a JSON body. This
 * hint is emitted by the same build that runs `applyProjection`, so the two
 * cannot disagree.
 */
export function buildProjectionHint(
  textItems: ReadonlyArray<{ text: string }>,
  toolName: string,
  preClassified?: ProjectionBodyShape | null,
): string {
  // BUDGET NOTE (measured, not assumed — the correction in D-016): this string
  // is emitted on EVERY doored result, ~2,600 times per 6 days, 83% of them
  // JSON. A first cut of this function was 570 chars against the 420-char
  // constant it replaced — +34.5% overall, i.e. it would have spent ~94k est.
  // tokens per 6d to fix a correctness bug. Every variant below is now AT OR
  // UNDER the constant's 420. Keep it that way: measure a wording change here,
  // do not eyeball it.
  const lead = ' ⓘ ';
  // Keep these hints short: `next` shares the output budget with the retained
  // preview. A longer variant evicted `_projection.omitted` samples from an
  // events:status result, hiding which history rows were cut (EI-25740925774324505).
  const asString = ` \`projection\` also accepts a JSON STRING.`;
  const searchIt = ` Search: \`capability:read { file_path, query:"terms" }\`, then view_lines.`;
  let shape: { json: unknown; lineCount: number };
  let hasOversizedLine: boolean;
  try {
    // A caller-supplied classification is authoritative: it is the one the door
    // actually acted on when it wrote the spill. Only re-derive when absent.
    shape = preClassified ?? classifyProjectionBody(textItems);
    hasOversizedLine = textItems.some(({ text }) =>
      text.split(/\r?\n/).some((line) => Buffer.byteLength(line, 'utf8') > CAPABILITY_READ_MAX_BYTE_PAGE),
    );
  } catch {
    // Fail-soft to the payload-agnostic wording rather than losing the hint.
    return (
      `${lead}\`projection: { pick: ["results[].id"] }\` for a JSON body, or ` +
      `\`projection: { pipe: [{ op:"grep", pattern:"..." }] }\` for multi-line text.${asString}`
    );
  }
  if (shape.json) {
    return (
      `${lead}JSON (${shape.lineCount} line(s)): \`projection: { pick: ["results[].id"] }\`; ` +
      `\`pick\` is what reduces it; \`pipe\` filters the indented lines.${asString}${searchIt}`
    );
  }
  // capability:read's scratch-reference guard runs inside the handler, before
  // dispatch-level projection can shrink the returned content. A line beyond
  // the byte-page threshold therefore needs the exact byte-page cursor.
  if (hasOversizedLine) {
    return (
      `${lead}${shape.lineCount} lines of non-JSON text include a line over ` +
      `${CAPABILITY_READ_MAX_BYTE_PAGE} bytes; use capability:read cursor.args ` +
      `(byte_offset+byte_limit; no raw) and follow next_cursor.`
    );
  }
  // The spill's own query mode filters the saved body inside capability:read,
  // before it renders a line window and checks that window against the result
  // door. Dispatch-level `projection.pipe` runs later and cannot recover from
  // that handler refusal, so point multi-line spills at the bounded query path.
  if (shape.lineCount > 1) {
    return (
      `${lead}${shape.lineCount} lines of non-JSON text: search the spill with ` +
      `\`capability:read { file_path, query:"terms" }\` (all terms, context and coverage), then view_lines.${asString}`
    );
  }
  return (
    `${lead}\`projection\` cannot help with one non-JSON line; \`pick\` and \`pipe\` cannot narrow it. Page the spill or re-call ` +
    `${toolName} with narrower arguments.`
  );
}

/** Approximate context cost of a NON-text content item (WI-36613). Cheap by
 *  design — an MCP image/audio block carries its payload as a base64 `data`
 *  string, so its length IS the cost; anything else falls back to a fail-soft
 *  stringify. Called only for items that are already known not to be text, which
 *  in this corpus is a near-empty population. */
function nonTextSize(it: unknown): number {
  const data = (it as { data?: unknown } | undefined)?.data;
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8');
  try {
    return Buffer.byteLength(JSON.stringify(it) ?? '', 'utf8');
  } catch {
    return 0;
  }
}

/** Context-bearing bytes in an MCP result. Shared with the post-door telemetry
 * backfill so the metric and the enforcing door cannot drift on units. */
export function measureResultContextBytes(result: Pick<DoorableResult, 'content'>): number {
  let bytes = 0;
  for (const item of result.content) {
    bytes += isTextItem(item) ? Buffer.byteLength(item.text, 'utf8') : nonTextSize(item);
  }
  return bytes;
}

function isTextItem(it: unknown): it is { type: 'text'; text: string } {
  return (
    !!it &&
    typeof it === 'object' &&
    (it as { type?: unknown }).type === 'text' &&
    typeof (it as { text?: unknown }).text === 'string'
  );
}

const SPEC_TEST_ADEQUACY_TOOL = 'plans:evaluate-spec-test-adequacy';
const PIPELINE_POSITION_TOOL = 'dev:pipeline_position';
/**
 * coord:send's result is a write receipt, not a list whose detail can be
 * safely reduced to row identity. These fields are the delivery verdict the
 * sender uses to distinguish "queued" from "missed" and to verify the durable
 * message handle. Keep them in the generic result-door projection even when a
 * large body/diagnostic section is evicted; otherwise a successful send can
 * render exactly like a failed one (EI-23481355842555588).
 */
const COORD_SEND_DELIVERY_PRESERVE_PATHS = [
  'ok',
  'partial',
  'counts.ok',
  'counts.failed',
  'deliveryFailureWarning',
  'results[].msg_id',
  'results[].ok',
  'results[].error',
  'results[].to',
  'results[].queued',
  'results[].woken',
  'results[].wakeOutcome',
  'results[].pickupConfirmed',
  'results[].recipient_absent',
  'results[].wake.queued',
  'results[].wake.woken',
  'results[].wake.wakeOutcome',
  'results[].wake.pickupConfirmed',
  'results[].wake.recipient_absent',
] as const;

/**
 * `work_items:complete` is a write. If its oversized response cannot be saved,
 * callers still need the per-item write verdicts so they can inspect persisted
 * state instead of replaying the close. Keep these ahead of the echoed workItem
 * and completion records, which are the bulk that caused the spill.
 */
const WORK_ITEMS_COMPLETE_RECEIPT_PRESERVE_PATHS = [
  'ok',
  'counts.ok',
  'counts.failed',
  'results[].ok',
  'results[].id',
  'results[].error',
  'results[].stateError',
  'results[].stateWarning',
  'results[].aliased',
  'results[].requestedState',
  'results[].appliedState',
  'results[].completionAuthority',
  'results[].countsTowardBurnDown',
  'results[].authorityWarning',
  'results[].requirementShortfallWarning',
  'results[].terminalConflictWarning',
  'results[].workItem.id',
  'results[].workItem.state',
  'results[].workItem.terminalCompletionRef',
  'results[].finish.complete',
  'results[].finishFailed',
] as const;

/**
 * `work_items:set_blocker` can persist the typed blocker before its oversized
 * response is spilled. Keep enough of each row to identify committed and
 * partial writes, then let callers read the authoritative current blocker
 * state instead of replaying the mutation when scratch storage is unavailable.
 */
const WORK_ITEMS_SET_BLOCKER_RECEIPT_PRESERVE_PATHS = [
  'ok',
  'counts.ok',
  'counts.failed',
  'results[].ok',
  'results[].id',
  'results[].changed',
  'results[].error',
  'results[].code',
  'results[].partialOutcome.blockerHistoryPersisted',
  'results[].partialOutcome.lifecycleApplied',
  'results[].partialOutcome.currentState',
  'results[].partialOutcome.activeBlockerCount',
  'results[].partialOutcome.recoveryAction',
  'results[].activeBlockers[].kind',
  'results[].activeBlockers[].ref',
  'results[].activeBlockers[].capability',
  'results[].activeBlockers[].summary',
  'results[].activeBlockers[].nextVerb',
  'results[].activeBlockers[].status',
  'results[].capabilityDisposition.capability',
  'results[].capabilityDisposition.disposition',
  'results[].capabilityDispositions[].capability',
  'results[].capabilityDispositions[].disposition',
  'results[].workItem.id',
  'results[].workItem.state',
  'results[].workItem.harness',
  'results[].autoCleared',
] as const;

/**
 * work_items:release can clear a claim before its oversized response is spilled.
 * Keep the release outcome and current row identity so callers can verify state
 * instead of replaying the release when scratch storage is unavailable.
 */
const WORK_ITEMS_RELEASE_RECEIPT_PRESERVE_PATHS = [
  'ok',
  'counts.ok',
  'counts.failed',
  'results[].ok',
  'results[].id',
  'results[].error',
  'results[].released',
  'results[].previousAssignee',
  'results[].noop',
  'results[].forced',
  'results[].claimHold',
  'results[].claimHoldFailed',
  'results[].claimHoldRelease.condition',
  'results[].claimHoldRelease.trigger',
  'results[].claimHoldRelease.owner',
  'results[].workItem.id',
  'results[].workItem.state',
  'results[].workItem.assignee',
  'results[].workItem.harness',
] as const;

/**
 * `scorecards:emit` can commit a card before its oversized response is spilled.
 * Keep its durable write receipt and the degenerate-distribution verdict
 * addressable if the spill fails, so callers do not replay a non-idempotent
 * emit to recover them.
 */
const SCORECARDS_EMIT_SPILL_PRESERVE_PATHS = [
  'ok',
  'committed',
  'completionReceipt',
  'canonicalRatings.base-rate-check.rating',
  'canonicalRatings.instrument-split.rating',
  'canonicalRatings.terminal-re-rate.rating',
  'canonicalRatings.platform-telemetry-excluded.rating',
  'canonicalRatings.re-runnable-evidence.rating',
  'canonicalRatings.degenerate-distribution.rating',
  'created',
  'issueId',
  'previousIssueId',
] as const;

// A failed admission does not roll back approval or promotion. Retain the
// committed legs beside the refusal; the immutable spill holds full diagnostics.
const PLANS_BIND_SPEC_EVIDENCE_REFUSAL_PRESERVE_PATHS = [
  'ok',
  'counts.ok',
  'counts.failed',
  'results[].ok',
  'results[].slug',
  'results[].error',
  'results[].clause',
  'results[].targeted',
  'results[].acceptedTargets',
  'results[].reason',
  'results[].correctedCall',
] as const;

const PLANS_START_RECEIPT_PRESERVE_PATHS = [
  'ok', 'counts.ok', 'counts.failed',
  'results[].ok', 'results[].slug', 'results[].harnessSlug', 'results[].error',
  'results[].autoApproved', 'results[].transitioned',
  'results[].promotion.promoted', 'results[].promotion.skipped',
  'results[].promotion.flagOff', 'results[].promotionError',
  'results[].promotedBlock.changed', 'results[].promotedBlock.rows',
  'results[].promotedBlockError',
  'results[].admission.ready', 'results[].admission.reason',
  'results[].admission.message', 'results[].admissionError',
  'results[].claimSpecBinding.ok', 'results[].claimSpecBindingError',
  'results[].message', 'results[].promotion.workItems[].workItemId',
] as const;

const PLANS_START_RECEIPT_RECOVERY =
  'plans:start may have approved the plan and promoted items before returning a refusal. ' +
  'Do NOT repeat plans:start to recover its receipt. Page the original response with capability:read; ' +
  'fields already omitted upstream cannot be recovered from that copy. Read plans:get for each preserved ' +
  'slug/harnessSlug and work_items:get for promoted workItemIds to inspect current state before follow-up.';

const FLEET_ADMISSION_RECEIPT_PRESERVE_PATHS = [
  'ok', 'error', 'reason', 'message', 'blockingPlanItemIds', 'blockingWorkItemIds', 'namedFloors',
  'repairCall', 'repairCall.tool', 'repairCall.args', 'repairCall.effect', 'blockerCounts',
  'fleet', 'plan', 'harness',
] as const;

function isFleetLaunchCall(input: { toolName: string; nestedTargetToolName?: string }): boolean {
  return input.toolName === 'fleet:launch-on-plan' ||
    (input.toolName === 'tools:invoke' && input.nestedTargetToolName === 'fleet:launch-on-plan');
}

function isPlansStartCall(input: { toolName: string; nestedTargetToolName?: string }): boolean {
  return input.toolName === 'plans:start' ||
    (input.toolName === 'tools:invoke' && input.nestedTargetToolName === 'plans:start');
}

function isWorkItemsCompleteCall(input: { toolName: string; nestedTargetToolName?: string }): boolean {
  return input.toolName === 'work_items:complete' ||
    (input.toolName === 'tools:invoke' && input.nestedTargetToolName === 'work_items:complete');
}

function isWorkItemsSetBlockerCall(input: { toolName: string; nestedTargetToolName?: string }): boolean {
  return input.toolName === 'work_items:set_blocker' ||
    (input.toolName === 'tools:invoke' && input.nestedTargetToolName === 'work_items:set_blocker');
}

function isWorkItemsReleaseCall(input: { toolName: string; nestedTargetToolName?: string }): boolean {
  return input.toolName === 'work_items:release' ||
    (input.toolName === 'tools:invoke' && input.nestedTargetToolName === 'work_items:release');
}

function isWorkItemsGetCall(input: { toolName: string; nestedTargetToolName?: string }): boolean {
  return input.toolName === 'work_items:get' ||
    (input.toolName === 'tools:invoke' && input.nestedTargetToolName === 'work_items:get');
}

function isWorkItemsGetReceiptEntry(value: unknown): value is Record<string, unknown> & { id: string; delivered: boolean } {
  const row = recordAt(value);
  return typeof row?.id === 'string' && typeof row.delivered === 'boolean';
}

/** Reconcile the source manifest against the rows that survived this door. */
function reconcileWorkItemsGetReceipt(sourceValue: unknown, outputValue: JsonObject): JsonObject {
  const source = recordAt(sourceValue);
  const output = recordAt(outputValue);
  if (!source || !output || !Array.isArray(source.receipt)) return outputValue;

  const sourceRead = recordAt(source.read);
  const outputRead = recordAt(output.read);
  const requested = typeof sourceRead?.requested === 'number'
    ? sourceRead.requested
    : source.receipt.filter(isWorkItemsGetReceiptEntry).length;
  const sourceEntries = source.receipt.filter(isWorkItemsGetReceiptEntry);
  const outputReceipt = Array.isArray(output.receipt) ? output.receipt : [];
  const resultCounts = new Map<string, number>();
  for (const value of Array.isArray(output.results) ? output.results : []) {
    const row = recordAt(value);
    if (typeof row?.id !== 'string') continue;
    resultCounts.set(row.id, (resultCounts.get(row.id) ?? 0) + 1);
  }
  const sourceById = new Map<string, Array<Record<string, unknown>>>();
  for (const entry of sourceEntries) {
    const queue = sourceById.get(entry.id) ?? [];
    queue.push(entry);
    sourceById.set(entry.id, queue);
  }
  const receipt = outputReceipt.flatMap((value) => {
    if (!isWorkItemsGetReceiptEntry(value)) return [];
    const sourceEntry = sourceById.get(value.id)?.shift() ?? value;
    if (sourceEntry.delivered !== true) {
      return [{
        id: value.id,
        delivered: false,
        ...(typeof sourceEntry.reason === 'string' ? { reason: sourceEntry.reason } : {}),
      }];
    }
    const remainingRows = resultCounts.get(value.id) ?? 0;
    if (remainingRows > 0) {
      resultCounts.set(value.id, remainingRows - 1);
      return [{ id: value.id, delivered: true }];
    }
    return [{ id: value.id, delivered: false, reason: 'projection' }];
  });
  const receiptComplete = sourceEntries.length === requested && receipt.length === requested;
  const read: Record<string, unknown> = { ...(outputRead ?? {}) };
  if (typeof read.requested !== 'number') read.requested = requested;
  read.receiptComplete = receiptComplete;
  if (receiptComplete) delete read.receiptOmitted;
  else read.receiptOmitted = Math.max(0, requested - receipt.length);
  return { ...output, receipt, read };
}

function reconcileWorkItemsGetReceiptResult<T extends DoorableResult>(
  result: T,
  opts: Pick<ResultDoorOpts, 'toolName' | 'nestedTargetToolName'>,
): T {
  if (!isWorkItemsGetCall(opts)) return result;
  const textItems = result.content.filter(isTextItem);
  const bodyShape = classifyProjectionBody(textItems);
  const json = bodyShape.json;
  if (!json || !isJsonObject(json.parsed)) return result;
  const body = reconcileWorkItemsGetReceipt(json.parsed, json.parsed);
  const serialized = JSON.stringify(body);
  const original = textItems[json.itemIndex];
  if (!original || serialized === original.text) return result;
  const slice = findJsonPrefixSlice(original.text);
  if (!slice) return result;
  const contentIndex = result.content.indexOf(original);
  if (contentIndex < 0) return result;
  const content = [...result.content];
  content[contentIndex] = {
    ...original,
    text: original.text.slice(0, slice.start) + serialized + original.text.slice(slice.end),
  };
  return { ...result, content } as T;
}

function isScorecardsEmitCall(input: { toolName: string; nestedTargetToolName?: string }): boolean {
  return input.toolName === 'scorecards:emit' ||
    (input.toolName === 'tools:invoke' && input.nestedTargetToolName === 'scorecards:emit');
}

const WORK_ITEMS_COMPLETE_SPILL_RECOVERY =
  'The work_items:complete write may already have committed before its response spill failed. Do NOT repeat this call. ' +
  'Read each preserved results[].id with work_items:get and inspect the current item state and completionAuthority ' +
  'before deciding any follow-up; the omitted echo cannot be recovered.';

const WORK_ITEMS_RELEASE_SPILL_RECOVERY =
  'The work_items:release write may already have unassigned or parked one or more items. Do NOT repeat this call. ' +
  'Read the affected item IDs with work_items:get and inspect current assignee, state, claimHold, and checkpoint before deciding any follow-up.';

const SCORECARDS_EMIT_SPILL_RECOVERY =
  'scorecards:emit may have recorded a card before its response spill failed. Do NOT repeat this non-idempotent emit. ' +
  'Use the preserved committed flag, completionReceipt, issueId, and canonicalRatings rating entries ' +
  'to determine the write outcome; the omitted response bytes cannot be recovered.';

const SCORECARDS_EMIT_UNKNOWN_SPILL_RECOVERY =
  'The scorecards:emit write outcome is unknown. Do NOT repeat this non-idempotent emit. Re-read the target or ' +
  'scorecard ledger to resolve whether it committed before any retry.';

function workItemsBulkReceiptBody(
  result: DoorableResult,
  accept: (value: JsonObject) => boolean = (value) => Array.isArray(value.results),
): JsonObject | undefined {
  const textBodies = result.content.filter(isTextItem).map((item) => {
    try {
      return JSON.parse(item.text) as unknown;
    } catch {
      const toon = /^format:\s*toon\s*\r?\n/.exec(item.text);
      if (!toon) return null;
      try {
        return decode(item.text.slice(toon[0].length), 'toon');
      } catch {
        return null;
      }
    }
  });
  return [result.structuredContent, ...textBodies].find(
    (value): value is JsonObject => isJsonObject(value) && accept(value),
  );
}

function workItemsSetBlockerReceipt(
  result: DoorableResult,
  opts: { toolName: string; nestedTargetToolName?: string },
): { body: JsonObject; readArgs: { ids: string[]; harness?: string } } | undefined {
  if (!isWorkItemsSetBlockerCall(opts)) return undefined;
  const body = workItemsBulkReceiptBody(result);
  if (!body || !Array.isArray(body.results)) return undefined;
  const rows = body.results.filter(isJsonObject);
  const committedRows = rows.filter((row) =>
    row.changed === true ||
    (isJsonObject(row.partialOutcome) &&
      (row.partialOutcome.blockerHistoryPersisted === true || row.partialOutcome.dependencyEdgesMayBePersisted === true)),
  );
  const ids = [...new Set(committedRows.flatMap((row) =>
    typeof row.id === 'string' && row.id.length > 0 ? [row.id] : [],
  ))];
  if (ids.length === 0) return undefined;
  const harnesses = [...new Set(committedRows.flatMap((row) =>
    isJsonObject(row.workItem) && typeof row.workItem.harness === 'string' ? [row.workItem.harness] : [],
  ))];
  return {
    body,
    readArgs: { ids, ...(harnesses.length === 1 ? { harness: harnesses[0] } : {}) },
  };
}

function workItemsReleaseReceipt(
  result: DoorableResult,
  opts: { toolName: string; nestedTargetToolName?: string },
): { body: JsonObject; readArgs: { ids: string[]; harness?: string } } | undefined {
  if (!isWorkItemsReleaseCall(opts)) return undefined;
  const body = workItemsBulkReceiptBody(result);
  if (!body || !Array.isArray(body.results)) return undefined;
  const rows = body.results.filter(isJsonObject);
  const ids = [...new Set(rows.flatMap((row) =>
    typeof row.id === 'string' && row.id.length > 0 ? [row.id] : [],
  ))];
  if (ids.length === 0) return undefined;
  const harnesses = [...new Set(rows.flatMap((row) =>
    isJsonObject(row.workItem) && typeof row.workItem.harness === 'string' ? [row.workItem.harness] : [],
  ))];
  return {
    body,
    readArgs: { ids, ...(harnesses.length === 1 ? { harness: harnesses[0] } : {}) },
  };
}

function workItemsReleaseRecovery(
  receipt: NonNullable<ReturnType<typeof workItemsReleaseReceipt>>,
) {
  const args = JSON.stringify(receipt.readArgs);
  return {
    cursor: { kind: 'release-outcome-check', tool: 'work_items:get', args: receipt.readArgs },
    next:
      'The work_items:release write may already have unassigned or parked ' +
      receipt.readArgs.ids.join(', ') + '. Do NOT repeat this call. Read work_items:get ' + args +
      ' and inspect current assignee, state, claimHold, and checkpoint before follow-up.',
  };
}

function workItemsSetBlockerRecovery(
  receipt: NonNullable<ReturnType<typeof workItemsSetBlockerReceipt>>,
) {
  const args = JSON.stringify(receipt.readArgs);
  return {
    cursor: { kind: 'committed-blocker-write', tool: 'work_items:get', args: receipt.readArgs },
    next:
      `The work_items:set_blocker write committed for ${receipt.readArgs.ids.join(', ')}. ` +
      `Do NOT repeat this mutation. Read work_items:get ${args} and inspect each item's current blockers ` +
      'and lifecycle before deciding any follow-up; the omitted response details cannot be recovered.',
  };
}

const WORK_ITEMS_SET_BLOCKER_SPILL_RECOVERY =
  'The work_items:set_blocker write may already have committed before its response spill failed. ' +
  'Do NOT repeat this mutation. Read work_items:get for the submitted item ids and inspect current blockers ' +
  'and lifecycle before deciding any follow-up; the omitted response details cannot be recovered.';

/**
 * `dev:pipeline_position`'s marker argument exists to settle these verdicts,
 * but the handler's compact response places them after the verbose gate/queue
 * fields. Keep the marker result and the two legs it corrects addressable when
 * this later, generic door has to project the response again.
 */
const PIPELINE_POSITION_PRESERVE_PATHS = [
  'currentBuildTestRoute',
  'changeInCandidate.markerJudging',
  'changeInCandidate.markerNext',
  'changeInCandidate.judgingSha',
  'changeInCandidate.nextCandidateSha',
  'changeInCandidate.judgingContainsPath',
  'changeInCandidate.nextContainsPath',
  'changeInCandidate.missingReason',
  'positions.inMain',
  'positions.deployed',
  'positionsMarker',
] as const;
type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Preserve every emitted criterion rating through a bounded scorecards:emit
 * projection. The grading-integrity rubric currently has six canonical keys,
 * but scorecard criteria are data-driven; deriving paths from the response
 * keeps a newly-added criterion from silently becoming `{}` at the outer
 * tools:invoke result door.
 */
function scorecardsEmitPreservePaths(value: unknown): string[] {
  const canonicalRatings = isJsonObject(value) && isJsonObject(value.canonicalRatings)
    ? value.canonicalRatings
    : undefined;
  const dynamicPaths = canonicalRatings
    ? Object.keys(canonicalRatings)
        .map((key) => `canonicalRatings.${key}.rating`)
        .filter((path) => !(SCORECARDS_EMIT_SPILL_PRESERVE_PATHS as readonly string[]).includes(path))
    : [];
  return [...SCORECARDS_EMIT_SPILL_PRESERVE_PATHS, ...dynamicPaths];
}

/** Keep every scorecard verdict inline while leaving bulky evidence in the spill. */
function compactScorecardsEmitRatings(value: unknown): JsonObject | null {
  if (!isJsonObject(value)) return null;
  const compact: JsonObject = {};
  for (const [criterion, entry] of Object.entries(value)) {
    if (!isJsonObject(entry) || !Object.prototype.hasOwnProperty.call(entry, 'rating')) return null;
    compact[criterion] = { rating: entry.rating };
  }
  return Object.keys(compact).length > 0 ? compact : null;
}

function compactScorecardsEmitBody(value: unknown): JsonObject | null {
  if (!isJsonObject(value)) return null;
  const canonicalRatings = compactScorecardsEmitRatings(value.canonicalRatings);
  if (!canonicalRatings) return null;
  return {
    ...value,
    canonicalRatings,
    _partial: true,
    _compactProjection: {
      kind: 'scorecards-emit',
      preserves: ['canonicalRatings.<criterion>.rating'],
      omits: ['canonicalRatings.<criterion>.evidence'],
      recovery: 'full result is in _projection.cursor',
    },
  };
}

function scorecardsEmitReceipt(
  result: DoorableResult,
  opts: { toolName: string; nestedTargetToolName?: string },
): JsonObject | undefined {
  if (!isScorecardsEmitCall(opts)) return undefined;
  const textBodies = result.content.filter(isTextItem).map((item) => {
    try {
      return JSON.parse(item.text) as unknown;
    } catch {
      const toon = /^format:\s*toon\s*\r?\n/.exec(item.text);
      if (!toon) return null;
      try {
        return decode(item.text.slice(toon[0].length), 'toon');
      } catch {
        return null;
      }
    }
  });
  const body = [result.structuredContent, ...textBodies].find((value): value is JsonObject =>
    isJsonObject(value) && isJsonObject(value.completionReceipt));
  if (!body) return undefined;

  const receipt = isJsonObject(body.completionReceipt) ? body.completionReceipt : {};
  const committed = receipt.status === 'recorded'
    ? true
    : receipt.status === 'not-recorded'
      ? false
      : undefined;
  return {
    ...body,
    ...(committed !== undefined ? { committed } : {}),
  };
}

function schedulerClaimReceipt(
  result: DoorableResult,
  opts: { toolName: string; nestedTargetToolName?: string },
): { body: JsonObject; readArgs: { id: string; harness?: string } } | undefined {
  if (opts.toolName !== 'scheduler:get_next' &&
      !(opts.toolName === 'tools:invoke' && opts.nestedTargetToolName === 'scheduler:get_next')) {
    return undefined;
  }
  const body = [result.structuredContent, ...result.content.filter(isTextItem).map((item) => {
    try {
      return JSON.parse(item.text) as unknown;
    } catch {
      return null;
    }
  })].find((value): value is JsonObject => {
    if (!isJsonObject(value) || !isJsonObject(value.claimReceipt)) return false;
    return value.claimReceipt.committed === true && typeof value.claimReceipt.workItemId === 'string';
  });
  if (!body || !isJsonObject(body.claimReceipt)) return undefined;
  const id = body.claimReceipt.workItemId as string;
  if (!id) return undefined;
  const harness = isJsonObject(body.workItem) && typeof body.workItem.harness === 'string'
    ? body.workItem.harness
    : undefined;
  return { body, readArgs: { id, ...(harness ? { harness } : {}) } };
}

function schedulerClaimRecovery(claim: NonNullable<ReturnType<typeof schedulerClaimReceipt>>) {
  return {
    cursor: { kind: 'committed-claim', tool: 'work_items:get', args: claim.readArgs },
    next:
      `The scheduler claim for ${claim.readArgs.id} is committed. Do not retry scheduler:get_next. ` +
      `Read work_items:get ${JSON.stringify(claim.readArgs)} ` +
      'for the current item details, then check its governing plan decisions before acting.',
  };
}

type AgentReviewClaimReceipt = {
  body: JsonObject;
  readArgs: { id: string; harness?: string };
  ideaId?: string;
};

function agentReviewClaimReceipt(
  result: DoorableResult,
  opts: { toolName: string; nestedTargetToolName?: string },
): AgentReviewClaimReceipt | undefined {
  if (opts.toolName !== 'improvements:agent-review' &&
      !(opts.toolName === 'tools:invoke' && opts.nestedTargetToolName === 'improvements:agent-review')) {
    return undefined;
  }
  const body = [result.structuredContent, ...result.content.filter(isTextItem).map((item) => {
    try {
      return JSON.parse(item.text) as unknown;
    } catch {
      return null;
    }
  })].find((value): value is JsonObject => {
    if (!isJsonObject(value) || value.claimed !== true || !isJsonObject(value.workItem)) return false;
    return typeof value.workItem.id === 'string';
  });
  if (!body || !isJsonObject(body.workItem)) return undefined;

  const workItem = body.workItem;
  const id = typeof workItem.id === 'string' ? workItem.id : undefined;
  if (!id) return undefined;
  const harness = typeof workItem.harness === 'string' ? workItem.harness : undefined;
  const gradeWith = isJsonObject(body.gradeWith) ? body.gradeWith : undefined;
  const ideaId = typeof body.ledgerIdeaId === 'string'
    ? body.ledgerIdeaId
    : typeof gradeWith?.ideaId === 'string'
      ? gradeWith.ideaId
      : undefined;
  return {
    body,
    readArgs: { id, ...(harness ? { harness } : {}) },
    ...(ideaId ? { ideaId } : {}),
  };
}

function agentReviewClaimRecovery(claim: AgentReviewClaimReceipt) {
  return {
    cursor: { kind: 'committed-review-claim', tool: 'work_items:get', args: claim.readArgs },
    next:
      `The peer-review claim for ${claim.readArgs.id} is committed. Do not retry improvements:agent-review. ` +
      `Read work_items:get ${JSON.stringify(claim.readArgs)} for the full item details` +
      (claim.ideaId
        ? `, then grade its routed idea with blender:grade-idea { ideaId: ${JSON.stringify(claim.ideaId)} }.`
        : '.'),
  };
}

/** Keep evaluator decisions inline; verbose evidence remains in the spill. */
function compactSpecTestAdequacyRatings(value: unknown): JsonObject | null {
  if (!isJsonObject(value)) return null;
  const compact: JsonObject = {};
  for (const [criterion, entry] of Object.entries(value)) {
    if (!isJsonObject(entry) || typeof entry.rating !== 'string') return null;
    // `_partial` describes the lossy projection of the surrounding row, not a
    // criterion. Keeping it out of this homogeneous map lets generic consumers
    // enumerate every value as an AdequacyRatingEntry without a boolean guard.
    compact[criterion] = { rating: entry.rating };
  }
  return Object.keys(compact).length > 0 ? compact : null;
}

function copyJsonKeys(source: JsonObject, target: JsonObject, keys: readonly string[]): void {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) target[key] = source[key];
  }
}

function compactSpecTestAdequacyRow(value: unknown): JsonObject | null {
  if (!isJsonObject(value)) return null;
  const ratings = compactSpecTestAdequacyRatings(value.ratings);
  if (!ratings) return null;
  // Evidence/suggestions are intentionally omitted from every criterion, so
  // mark the row envelope rather than contaminating the ratings map.
  const compact: JsonObject = { ratings, _partial: true };
  copyJsonKeys(value, compact, [
    'planSlug', 'specId', 'specRevision', 'specFingerprint', 'planItemId',
    'classRef', 'behaviorClass', 'requiredProofFloor', 'verdict', 'wouldBlock',
  ]);
  const draft = isJsonObject(value.scorecardDraft) ? value.scorecardDraft : null;
  if (draft) {
    const compactDraft: JsonObject = { ratings };
    copyJsonKeys(draft, compactDraft, ['rubricRef', 'subject', 'title', 'rerunRecipe', 'terminal']);
    if (Object.prototype.hasOwnProperty.call(draft, 'body')) compactDraft._partial = true;
    compact.scorecardDraft = compactDraft;
  }
  return compact;
}

function compactSpecTestAdequacyBody(body: unknown): JsonObject | null {
  if (!isJsonObject(body) || body.ok !== true || !Array.isArray(body.rows)) return null;
  const rows = body.rows.map(compactSpecTestAdequacyRow);
  if (rows.some((row) => row === null)) return null;
  const compact: JsonObject = { rows };
  copyJsonKeys(body, compact, [
    'ok', 'slug', 'harnessSlug', 'classRef', 'rubricRef', 'count', 'verdicts',
    'wouldBlock', 'uncoveredWorkItemSelection',
  ]);
  compact._compactProjection = {
    kind: 'evaluator-specific',
    tool: SPEC_TEST_ADEQUACY_TOOL,
    preserves: [
      'rows[].ratings.<criterion>.rating', 'rows[].requiredProofFloor',
      'rows[].verdict', 'rows[].wouldBlock', 'verdicts', 'wouldBlock',
    ],
    omits: [
      'rows[].ratings.<criterion>.evidence', 'rows[].ratings.<criterion>.suggestion',
      'rows[].scorecardDraft.body',
    ],
    recovery: 'full result is in _projection.cursor',
  };
  return compact;
}

/** Shape the parts so buildScratchUri's validators accept them (fail-soft names,
 *  never fail-the-spill on a weird caller identity). */
function scratchParts(opts: ResultDoorOpts): { workspaceId: string; toolName: string; runId: string } {
  const rawWs = opts.workspaceId ?? '';
  const workspaceId = TOOL_SEGMENT_REGEX.test(rawWs) && rawWs !== '.' && rawWs !== '..' ? rawWs : 'unscoped';
  let toolName = TOOL_SEGMENT_REGEX.test(opts.toolName) ? opts.toolName : 'unknown:tool';
  if (!toolName.includes('.') && !toolName.includes(':')) toolName = `tool:${toolName}`;
  const runId = opts.runId && UUID_V4_REGEX.test(opts.runId) ? opts.runId : randomUUID();
  return { workspaceId, toolName, runId };
}

function cacheFailedSpill(input: {
  opts: ResultDoorOpts;
  payload: Buffer | string;
  mediaType: string;
  content: ReturnType<typeof contentMetadata>;
  evidence?: ReturnType<typeof detectResultEvidence>;
  bodyOffsetInPayload?: number;
}): NonNullable<ReturnType<typeof storeVolatileScratchReference>> | null {
  try {
    const parts = scratchParts(input.opts);
    return storeVolatileScratchReference({
      payload: input.payload,
      workspaceId: parts.workspaceId,
      ownerId: input.opts.ownerId,
      audience: input.opts.ownerId ? 'owner' : 'workspace',
      mediaType: input.mediaType,
      content: input.content,
      evidence: input.evidence,
      bodyOffsetInPayload: input.bodyOffsetInPayload,
    });
  } catch {
    // The emergency cache is strictly best-effort; the caller still returns a
    // bounded, explicitly unavailable cursor if the fallback itself cannot fit.
    return null;
  }
}

function volatileScratchRecovery(
  fallback: NonNullable<ReturnType<typeof storeVolatileScratchReference>>,
  bodyComplete: boolean,
  toolName: string,
  spillErrorCode: string | null = null,
  spillErrorSummary: string | null = null,
) {
  const spillDiagnostic = [
    spillErrorCode && spillErrorCode !== 'unknown error' ? spillErrorCode : null,
    spillErrorSummary,
  ].filter(Boolean).join('; ');
  const persistenceStatus = spillErrorCode === 'ETIMEDOUT'
    ? 'Primary scratch persistence exceeded its response deadline; its writer may still settle'
    : 'Primary scratch persistence failed';
  return {
    cursor: {
      kind: 'volatile-scratch-page',
      tool: 'capability:read',
      reason: 'spill-write-failed',
      ...(spillErrorCode && spillErrorCode !== 'unknown error' ? { errorCode: spillErrorCode } : {}),
      ...(spillErrorSummary ? { errorDetail: spillErrorSummary } : {}),
      args: { uri: fallback.uri, byte_offset: 0, byte_limit: 3_072 },
      uri: fallback.uri,
      maxByteLimit: CAPABILITY_READ_MAX_BYTE_PAGE,
      dataEncoding: 'base64',
      expiresAt: fallback.manifest.expiresAt,
      ...(fallback.manifest.bodyOffsetInPayload !== undefined
        ? { bodyOffsetInPayload: fallback.manifest.bodyOffsetInPayload, ...(!bodyComplete ? { bodyComplete: false } : {}) }
        : {}),
    },
    next:
      persistenceStatus +
      (spillDiagnostic ? ' (' + spillDiagnostic + ')' : '') +
      '; an exact in-process copy is available until ' + fallback.manifest.expiresAt + '. ' +
      `Read cursor.args with capability:read and follow next_cursor until eof. This URI is not a file and is ` +
      `lost on server restart or cache eviction. ` +
      (bodyComplete
        ? 'The copy preserves the exact bytes received by the result door from ' + toolName + '.'
        : 'The copy preserves the bytes received by the result door from ' + toolName + '; fields already omitted upstream remain absent.'),
  };
}

function preferVolatileScratchRecovery(
  volatileRecovery: ReturnType<typeof volatileScratchRecovery> | undefined,
  fallback: BoundedPayloadRecovery,
  volatileNote: string = fallback.next,
): BoundedPayloadRecovery {
  return volatileRecovery
    ? { cursor: volatileRecovery.cursor, next: volatileRecovery.next + ' ' + volatileNote }
    : fallback;
}

function volatileScratchRecoveryForTool(
  recovery: ReturnType<typeof volatileScratchRecovery>,
  toolName: string,
  nestedTargetToolName?: string,
) {
  const target = toolName === 'tools:invoke' ? nestedTargetToolName : toolName;
  const note = target === 'coord:send'
    ? 'The delivery outcome is unknown; do NOT repeat the send until checking coord:feed or coord:inbox. ' +
      COORD_SEND_RECEIPT_RECOVERY
    : target === 'work_items:complete'
      ? 'The complete work_items:complete response is available in the volatile page above. ' +
        'Do NOT repeat this call; read work_items:get to confirm current item state before follow-up.'
      : target === 'work_items:set_blocker'
        ? 'The work_items:set_blocker mutation may have committed. Do NOT repeat it; read work_items:get to inspect current blocker state.'
        : target === 'scorecards:emit'
          ? 'The scorecards:emit outcome must be established from the volatile page and scorecard ledger. ' +
            'Do NOT repeat this non-idempotent emit; inspect completionReceipt if present.'
          : target === 'improvements:agent-review'
            ? 'The peer-review claim may have committed. Do NOT repeat improvements:agent-review; inspect the claim before follow-up.'
            : target === 'plans:start'
              ? PLANS_START_RECEIPT_RECOVERY
              : undefined;
  return note
    ? { cursor: recovery.cursor, next: recovery.next + ' ' + note }
    : recovery;
}

function spillFailureDetails(error: unknown, candidatePaths: Array<string | undefined>) {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : undefined;
  const rawMessage = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : typeof record?.message === 'string'
        ? record.message
        : error == null
          ? 'empty rejection'
          : (() => {
              try { return JSON.stringify(error) ?? String(error); }
              catch { return String(error); }
            })();
  const code = typeof record?.code === 'string' ? record.code : 'unknown error';
  const name = error instanceof Error
    ? error.name
    : typeof record?.name === 'string'
      ? record.name
      : 'Error';
  let safeMessage = rawMessage.replace(/[\r\n\t]+/g, ' ').trim();
  const paths = [...new Set(candidatePaths.filter((path): path is string => Boolean(path)))];
  for (const path of paths.sort((a, b) => b.length - a.length)) {
    safeMessage = safeMessage.replaceAll(path, '<scratch path>');
  }
  return {
    error: rawMessage,
    code,
    summary: `${name}${safeMessage ? `: ${safeMessage}` : ''}`.slice(0, 240),
  };
}

interface JsonPrefixSlice {
  start: number;
  end: number;
}

/** Find a complete object/array JSON value at the start of a text item. Some
 * dispatch paths append guidance to the SAME text item rather than emitting a
 * separate content item, so JSON.parse(item.text) cannot identify the payload
 * even though the bytes before the guidance are a complete JSON document. */
function findJsonPrefixSlice(text: string): JsonPrefixSlice | null {
  const start = text.search(/\S/);
  if (start < 0 || (text[start] !== '{' && text[start] !== '[')) return null;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) {
        const end = index + 1;
        try {
          JSON.parse(text.slice(start, end));
          const trailing = text.slice(end).trim();
          // Only split a same-item suffix when it has the framework's known
          // advisory shape. A JSON snippet followed by arbitrary text can be a
          // genuine non-JSON result (including tool-owned truncation samples),
          // and treating that as a complete payload would overclaim recovery.
          if (trailing && !/^(?:See also:|\[batch-hint\]|\[nudge\])/i.test(trailing)) return null;
          return { start, end };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Keep a per-item JSON payload parseable when the MCP result also carries
 * advisory text items (for example a tool's `guidance.seeAlso` entry).
 *
 * `classifyProjectionBody` deliberately finds JSON in one item even when the
 * joined content does not parse. The spill must make the same distinction:
 * putting the advisory item after that JSON turns an otherwise valid body into
 * `JSON + prose`, so `jq` cannot consume the bytes. Preserve the advisory text
 * as one JSON-encoded comment before the payload and leave the payload as the
 * final byte stream. The encoded array is lossless (including newlines) while
 * the comment cannot contaminate the JSON body after its advertised offset.
 */
function buildSpillAdvisoryPrefix(
  textItems: ReadonlyArray<{ text: string }>,
  jsonItemIndex: number,
  jsonSlice?: JsonPrefixSlice | null,
): string {
  if (jsonItemIndex < 0) return '';
  const advisoryTexts: string[] = [];
  textItems.forEach((item, index) => {
    if (index !== jsonItemIndex) {
      advisoryTexts.push(item.text);
      return;
    }
    if (!jsonSlice) return;
    const before = item.text.slice(0, jsonSlice.start).trim();
    const after = item.text.slice(jsonSlice.end).trim();
    if (before) advisoryTexts.push(before);
    if (after) advisoryTexts.push(after);
  });
  if (advisoryTexts.length === 0) return '';
  return (
    `# result-door advisory text item(s) moved before the JSON payload so the payload remains parseable\n` +
    `# advisory-text-items-json: ${JSON.stringify(advisoryTexts)}\n`
  );
}

const STRUCTURAL_PROJECTION_WARNING_MAX_CHARS = 1_200;

/**
 * Keep a trust-degrading projection verdict in the model-facing result when
 * the result door replaces the projection's text body with a structural JSON
 * preview.
 *
 * `applyResultProjection` deliberately emits degraded verdicts as a leading
 * `⚠` text item so a downstream head-truncation cannot hide them. The result
 * door used to keep only the parsed JSON item, undoing that guarantee exactly
 * when the fail-open body was large enough to overflow. Courtesy/advisory
 * text (including a clean projection footer) is still intentionally dropped:
 * only a leading warning from the projection stage is load-bearing here.
 *
 * The warning is bounded independently of the JSON preview. An unusually
 * verbose upstream footer must not consume the entire result door.
 */
function extractStructuralProjectionWarning(
  result: Pick<DoorableResult, '_meta'>,
  textItems: ReadonlyArray<{ text: string }>,
  jsonItemIndex: number,
): string | null {
  const projection = (
    result._meta as
      | { resultProjection?: { applied?: unknown; notes?: unknown } }
      | undefined
  )?.resultProjection;
  if (projection?.applied !== true || jsonItemIndex <= 0) return null;
  if (!Array.isArray(projection.notes) && projection.notes !== undefined) return null;

  const warning = textItems
    .slice(0, jsonItemIndex)
    .find((item) => item.text.trimStart().startsWith('⚠'))
    ?.text;
  if (!warning) return null;
  if (warning.length <= STRUCTURAL_PROJECTION_WARNING_MAX_CHARS) return warning;
  return warning.slice(0, STRUCTURAL_PROJECTION_WARNING_MAX_CHARS - 1) + '…';
}

const EVIDENCE_KEY_CLASS: Readonly<Record<string, OutputEvidenceClass>> = {
  workitem: 'work-item', workitems: 'work-item', issue: 'work-item', issues: 'work-item',
  event: 'event', events: 'event', eventstatus: 'event', eventstatuses: 'event',
  fleet: 'fleet', fleets: 'fleet',
  capacity: 'capacity', capacities: 'capacity',
  account: 'account', accounts: 'account',
  release: 'release', releases: 'release',
};

function jsonPointerSegment(value: string): string {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Discover evidence groups in script-authored JSON without coupling the door
 * to one script schema. Only explicit field names count; values are never
 * guessed from IDs or prose. */
export function detectResultEvidence(content: readonly unknown[]): Array<{
  evidenceClass: OutputEvidenceClass;
  contentIndex: number;
  jsonPointers: string[];
}> {
  const found = new Map<string, { evidenceClass: OutputEvidenceClass; contentIndex: number; jsonPointers: string[] }>();
  const visit = (value: unknown, contentIndex: number, pointer: string, depth: number): void => {
    if (depth > 12 || value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPointer = `${pointer}/${jsonPointerSegment(key)}`;
      const evidenceClass = EVIDENCE_KEY_CLASS[key.toLowerCase().replace(/[^a-z0-9]/g, '')];
      if (evidenceClass) {
        const mapKey = `${evidenceClass}:${contentIndex}`;
        const row = found.get(mapKey) ?? { evidenceClass, contentIndex, jsonPointers: [] };
        if (!row.jsonPointers.includes(childPointer)) row.jsonPointers.push(childPointer);
        found.set(mapKey, row);
      }
      visit(child, contentIndex, childPointer, depth + 1);
    }
  };
  content.forEach((item, contentIndex) => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : null;
    if (!row || row.type !== 'text' || typeof row.text !== 'string') return;
    try { visit(JSON.parse(row.text), contentIndex, '', 0); } catch { /* prose is not typed evidence */ }
  });
  return [...found.values()].sort((a, b) =>
    OUTPUT_EVIDENCE_CLASSES.indexOf(a.evidenceClass) - OUTPUT_EVIDENCE_CLASSES.indexOf(b.evidenceClass));
}

/** Every route `spillResultAsReferenceEnvelope` can be reached for — see each
 *  branch's call site for what triggers it. */
type SpillReason =
  | 'aggregate-output-budget-exceeded'
  | 'non-text-result-budget-exceeded'
  | 'explicit-full-request-overflow'
  | 'under-budget-partial-result';

/**
 * The one actionable fact each spill reason implies, stated where the MODEL
 * reads it — the envelope in `content` — rather than only in
 * `_meta.resultDoor.aggregate`. The aggregate reservation was already recorded
 * there while every reporter below read the envelope, saw the word "omitted",
 * and concluded the bytes were gone (EI-21954450841272611 and friends).
 *
 * The aggregate size diagnosis is derived: the cohort budget is
 * `resultEach * resultSlots` chars, a single result is charged at most
 * `resultEach` (`reserveAggregateBytes`' `chargedBytes` is
 * `min(sourceBytes, budgetChars)`), and `resultSlots` is a positive integer —
 * so a call that is FIRST in its cohort can never exceed the budget. Reaching
 * this reason proves earlier calls in the SAME COHORT consumed it, and that
 * this result was not oversized on its own. A compatibility cohort is only
 * a 2s start-time heuristic; it does NOT prove a shared model turn.
 */
function spillRecoveryNote(
  reason: SpillReason,
  input: { toolName: string; nestedTargetToolName?: string; effect?: 'read' | 'write'; upstreamProjection?: boolean; innerTruncationMarkers?: readonly string[]; aggregateMode?: ResultDoorAggregateScope['mode'] },
): string {
  const referenceReader =
    'The `uri` in `content` is a framed scratch-reference container, not a raw JSON file. ' +
    'Read it with `capability:read` byte pages (`byte_offset` + `byte_limit`, without `raw`) and follow `next_cursor` ' +
    'to validate and unwrap its manifest before parsing the payload; the default numbered line view can truncate a long single-line payload. ';
  const recoverable =
    'Nothing was lost: the complete result was written to the reference in `content` — page it to read it. ' +
    referenceReader;
  const innerTruncationMarkers = input.innerTruncationMarkers ?? [];
  const recoveryTarget = input.toolName === 'tools:invoke' ? input.nestedTargetToolName : input.toolName;
  if (isPlansStartCall(input)) {
    return (input.upstreamProjection || innerTruncationMarkers.length > 0
      ? 'The reference preserves only the emitted response; already-omitted fields cannot be recovered by paging. ' + referenceReader
      : recoverable) + PLANS_START_RECEIPT_RECOVERY;
  }
  if (isWorkItemsCompleteCall(input)) {
    return (
      (input.upstreamProjection || innerTruncationMarkers.length > 0
        ? 'The reference preserves only the completion response emitted by the tool; already-omitted fields cannot be recovered by paging. ' + referenceReader
        : recoverable) +
      'The work_items:complete write may already have committed. Do NOT repeat this call; page the reference for the emitted receipt and read work_items:get for each result id to confirm current item state.'
    );
  }
  if (isWorkItemsSetBlockerCall(input)) {
    return (
      (input.upstreamProjection || innerTruncationMarkers.length > 0
        ? 'The reference preserves only the blocker response emitted by the tool; already-omitted fields cannot be recovered by paging. ' + referenceReader
        : recoverable) +
      'The work_items:set_blocker write may already have committed. Do NOT repeat it; page the reference for the receipt and read work_items:get to inspect current blockers before follow-up.'
    );
  }
  if (isWorkItemsReleaseCall(input)) {
    return (
      (input.upstreamProjection || innerTruncationMarkers.length > 0
        ? 'The reference preserves only the release response emitted by the tool; already-omitted fields cannot be recovered by paging. ' + referenceReader
        : recoverable) +
      'The work_items:release response may include a committed release. Page the reference for its receipt, then read work_items:get to verify current state before follow-up. Do NOT repeat the release.'
    );
  }
  if (isScorecardsEmitCall(input)) {
    return (
      (input.upstreamProjection || innerTruncationMarkers.length > 0
        ? 'The reference preserves only the scorecards:emit response; already-omitted fields cannot be recovered by paging. ' + referenceReader
        : recoverable) +
      'scorecards:emit may have recorded a card. Do NOT repeat this non-idempotent emit; page the reference for the emitted receipt and inspect the scorecard ledger before any retry.'
    );
  }
  if (input.toolName === 'coord:send' ||
    (input.toolName === 'tools:invoke' && input.nestedTargetToolName === 'coord:send')) {
    return (
      (input.upstreamProjection || innerTruncationMarkers.length > 0
        ? 'The reference preserves the emitted send receipt; upstream-omitted receipt fields cannot be recovered by paging. ' + referenceReader
        : recoverable) +
      COORD_SEND_RECEIPT_RECOVERY
    );
  }
  if (input.upstreamProjection) {
    return (
      'The emitted result was written to the reference in `content` — page it to inspect what the tool emitted. ' +
      referenceReader +
      'However, the tool had already applied a lossy upstream projection before this spill; omitted fields were ' +
      'never serialized and paging this reference cannot recover them. ' +
      upstreamProjectionRecoveryInstruction(
        input.toolName,
        input.nestedTargetToolName,
        innerTruncationMarkers,
        input.effect,
      )
    );
  }
  if (innerTruncationMarkers.length > 0) {
    return (
      'The emitted result was written to the reference in `content` — page it to inspect what the tool emitted. ' +
      referenceReader +
      `However, the emitted result already carries upstream partial marker(s) (${innerTruncationMarkers.join(', ')}); ` +
      `paging this reference cannot recover the omitted fields, rows, or text. ${innerTruncationRecoveryInstruction(input.toolName, innerTruncationMarkers, input.nestedTargetToolName)}`
    );
  }
  if (reason === 'under-budget-partial-result') {
    return (
      'The emitted result was already marked partial before it reached this result door. ' +
      referenceReader +
      'The reference preserves what the tool emitted for inspection; ' +
      upstreamProjectionRecoveryInstruction(input.toolName, input.nestedTargetToolName, [], input.effect)
    );
  }
  if (reason === 'aggregate-output-budget-exceeded') {
    return (
      `${recoverable}This result was NOT too large on its own; earlier calls in the same ` +
      `${input.aggregateMode === 'compatibility' ? '2-second compatibility cohort' : 'explicit output cohort'} ` +
      'consumed the shared budget. This does not prove they were parallel siblings. ' +
      'Read the spill in bounded byte pages, or retry in a NEW output cohort; reissuing ' +
      'within the same cohort can spill again. To fan out WIDE without spending this budget, ' +
      'use ONE code:run only for compact output; oversized summaries are clipped and marked ' +
      '`summaryNotice.truncated`, which that spill cannot restore. For complete long text, ' +
      'page this spill or fetch bounded slices (a re-issue after this spill is not counted ' +
      'against you by the batch-hint).'
    );
  }
  if (reason === 'explicit-full-request-overflow') {
    // EI-22167228731928620: an explicit payloadTier:'full' skipped the tool's
    // own field-aware shaper, so the raw body reaching this door is LARGER
    // than what a 'trimmed' call would have produced — re-projecting it here
    // with the generic, field-blind bounded-payload walk could leave less
    // inline than 'trimmed' does, i.e. worse than the tier the caller opted
    // out of. Spilling the untouched full body and saying so plainly is
    // honest about the size AND strictly recoverable, unlike that reprojection.
    if (recoveryTarget === 'work_items:get' && innerTruncationMarkers.includes('checkpointTruncated')) {
      return 'The explicit full work_items:get response exceeded the door, and its checkpoint was already clipped by the tool. The spill cannot restore that text. ' +
        innerTruncationRecoveryInstruction(input.toolName, innerTruncationMarkers, input.nestedTargetToolName);
    }
    return (
      `${recoverable}This is the RAW, unshaped payload you explicitly requested with payloadTier:'full' ` +
      "(or an equivalent transport-cap exemption) — it does not fit inline at this size. If you don't need " +
      "the full raw payload, omit payloadTier (or don't request 'full') for a properly tier-shaped, " +
      'field-aware inline summary instead — often MORE informative than a generic re-projection of the full body.'
    );
  }
  return (
    `${recoverable}It took this route because a non-text block (image/audio/resource) cannot be ` +
    'sliced, so re-running the same call alone will spill again — page the reference rather than retrying.'
  );
}

/**
 * Hard overflow route for aggregate exhaustion and non-text results. The
 * existing text projector cannot safely slice an image/audio/resource block,
 * so the full MCP content array is serialized once to the existing scratch
 * store and replaced by the shared typed reference envelope.
 *
 * ⚠ Everything this route touches is RELOCATED, never dropped: the whole
 * content array is serialized into the spill above, and the `incomplete`
 * descriptor must say so. It previously reported `omittedItems: content.length`
 * — a field reserved for bytes that were never serialized (see
 * `OutputEnvelopeIncomplete`) — which stated the exact opposite of the truth
 * AND counted MCP content blocks, which readers took for domain rows ("omitted
 * three items"). Note the spill-failure branch below returns state:'error'
 * instead, so on this `incomplete` branch the spill always succeeded. The
 * reference is recoverable when the source was complete; if the source already
 * carried an upstream truncation marker, the bytes are still inspectable but
 * `recoverable` is false because the omitted fields never reached this door.
 */
function spillResultAsReferenceEnvelope<T extends DoorableResult>(input: {
  result: T;
  opts: ResultDoorOpts;
  reason: SpillReason;
  sourceBytes: number;
  nonTextBytes: number;
  doorTokens: number;
  aggregate?: ResultDoorAggregateReservation;
  onSpillFailure?: (error: unknown) => void;
}): T {
  const upstreamProjection = (
    input.result._meta as
      | { payloadProjection?: { truncated?: unknown } }
      | undefined
  )?.payloadProjection;
  const innerTruncationMarkers = detectInnerTruncationMarkers(
    input.result.content.filter(isTextItem).map((item) => item.text),
    input.opts.toolName,
    input.opts.nestedTargetToolName,
  );
  const sourceWasPartial = Boolean(upstreamProjection?.truncated) || innerTruncationMarkers.length > 0;
  const payload = JSON.stringify({
    content: input.result.content,
    ...(input.result.isError !== undefined ? { isError: input.result.isError } : {}),
  });
  let spillPath: string | null = null;
  let spillUri: string | null = null;
  let spillError: string | null = null;
  let spillErrorCode: string | null = null;
  let spillErrorSummary: string | null = null;
  let manifest: ScratchReferenceManifest | null = null;
  let volatileFallback: NonNullable<ReturnType<typeof storeVolatileScratchReference>> | null = null;
  const evidence = detectResultEvidence(input.result.content);
  try {
    if (input.opts.scratchWriteFailure) throw input.opts.scratchWriteFailure.error;
    const parts = scratchParts(input.opts);
    // EI-21282689413153947: NOT `.json` — every spill is a self-describing
    // scratch reference (magic + manifest + payload), so a `.json` name lies
    // about the bytes and invites a direct `jq <file>` that dies on the header
    // ("Invalid numeric literal at line 2"). The payload INSIDE the reference
    // stays machine-parseable JSON; recover it via parseScratchReference or the
    // cursor recipe, never by parsing the whole file.
    const basename = `result-door-${Date.now()}-${randomUUID().slice(0, 8)}.spill`;
    spillUri = buildScratchUri({ ...parts, basename });
    spillPath = safeScratchFilesystemPath(spillUri);
    manifest = writeScratchReference({
      filePath: spillPath,
      payload,
      workspaceId: parts.workspaceId,
      ownerId: input.opts.ownerId,
      audience: input.opts.ownerId ? 'owner' : 'workspace',
      mediaType: 'application/json',
      content: contentMetadata(input.result.content),
      evidence,
      deferredWrites: input.opts.deferredScratchWrites,
      requestTraceId: input.opts.requestTraceId,
      onScratchWriteTiming: input.opts.onScratchWriteTiming,
      // This spill path stores the JSON MCP content envelope directly as the
      // scratch payload. Declare byte zero as its machine-readable body so the
      // manifest has the same explicit framing contract as shaped text spills.
      bodyOffsetInPayload: 0,
    });
  } catch (err) {
    input.onSpillFailure?.(err);
    const details = spillFailureDetails(err, [
      ...(spillPath ? [spillPath, dirname(spillPath)] : []),
      process.env.PAPERCUSP_SCRATCH_ROOT,
    ]);
    spillError = details.error;
    spillErrorCode = details.code;
    spillErrorSummary = details.summary;
    spillPath = null;
    spillUri = null;
    volatileFallback = cacheFailedSpill({
      opts: input.opts,
      payload,
      mediaType: 'application/json',
      content: contentMetadata(input.result.content),
      evidence,
      bodyOffsetInPayload: 0,
    });
  }

  const firstText = input.result.content.find(isTextItem)?.text ?? '';
  const preview = firstText
    ? firstText.slice(0, 240)
    : `[${input.result.content.map((item) => String((item as { type?: unknown }).type ?? 'unknown')).join(', ')}]`;
  const referenceUri = spillUri && manifest ? spillUri : volatileFallback?.uri;
  const referenceManifest = manifest ?? volatileFallback?.manifest;
  const reference: OutputReferenceContentItem | null = referenceUri && referenceManifest
    ? {
        kind: 'reference',
        uri: referenceUri,
        preview,
        byteCount: referenceManifest.byteCount,
        sha256: referenceManifest.sha256,
        expiresAt: referenceManifest.expiresAt,
        ...(referenceManifest.ownerId ? { ownerId: referenceManifest.ownerId } : {}),
        audience: referenceManifest.audience,
      }
    : null;
  const volatileRecovery = volatileFallback
    ? volatileScratchRecovery(volatileFallback, !sourceWasPartial, input.opts.toolName, spillErrorCode, spillErrorSummary)
    : undefined;
  const evidenceReferences: OutputEvidenceReferenceContentItem[] = reference
    ? [...new Set(evidence.map((entry) => entry.evidenceClass))].map((evidenceClass) => ({
        ...reference,
        kind: 'evidence-reference' as const,
        evidenceClass,
        preview: `${evidenceClass} evidence`,
      }))
    : [];
  const schedulerClaim = schedulerClaimReceipt(input.result, input.opts);
  const boundedSchedulerClaim = schedulerClaim
    ? projectBoundedPayload(schedulerClaim.body, {
        toolName: 'scheduler:get_next',
        tier: 'trimmed',
        forced: true,
        originalChars: input.sourceBytes,
        targetChars: Math.min(input.doorTokens * CHARS_PER_TOKEN_ESTIMATE, 1_200),
        preservePaths: ['ok', 'claimReceipt', 'claimReceipt.committed', 'claimReceipt.workItemId'],
        preserveTopLevelKeys: ['ok', 'claimReceipt'],
        recovery: preferVolatileScratchRecovery(volatileRecovery, schedulerClaimRecovery(schedulerClaim)),
      })
    : undefined;
  if (boundedSchedulerClaim) {
    return {
      ...input.result,
      content: [{ type: 'text' as const, text: JSON.stringify(boundedSchedulerClaim) }],
      _meta: {
        ...(input.result._meta ?? {}),
        resultDoor: {
          truncated: true,
          structural: true,
          spillPath,
          spillUri,
          spillFailed: spillPath == null,
          spillError,
          spillErrorCode,
          ...(volatileFallback
            ? { volatileFallbackUri: volatileFallback.uri, volatileFallbackExpiresAt: volatileFallback.manifest.expiresAt }
            : {}),
          originalChars: input.sourceBytes,
          originalBytes: input.sourceBytes,
          nonTextChars: input.nonTextBytes,
          nonTextBytes: input.nonTextBytes,
          doorTokens: input.doorTokens,
          reason: input.reason,
          upstreamProjected: Boolean(upstreamProjection?.truncated),
          innerTruncationMarkers,
          ...(input.aggregate ? { aggregate: input.aggregate } : {}),
        },
      },
    } as T;
  }
  const agentReviewClaim = spillPath == null ? agentReviewClaimReceipt(input.result, input.opts) : undefined;
  const boundedAgentReviewClaim = agentReviewClaim
    ? projectBoundedPayload(agentReviewClaim.body, {
        toolName: 'improvements:agent-review',
        tier: 'trimmed',
        forced: true,
        originalChars: input.sourceBytes,
        targetChars: Math.min(input.doorTokens * CHARS_PER_TOKEN_ESTIMATE, 1_200),
        preservePaths: [
          'ok', 'mode', 'claimed', 'workItem.id', 'workItem.title', 'workItem.harness',
          'ledgerIdeaId', 'gradeWith.ideaId',
        ],
        preserveTopLevelKeys: ['ok', 'mode', 'claimed', 'ledgerIdeaId', 'gradeWith'],
        recovery: preferVolatileScratchRecovery(
          volatileRecovery,
          agentReviewClaimRecovery(agentReviewClaim),
        ),
      })
    : undefined;
  if (boundedAgentReviewClaim) {
    return {
      ...input.result,
      content: [{ type: 'text' as const, text: JSON.stringify(boundedAgentReviewClaim) }],
      _meta: {
        ...(input.result._meta ?? {}),
        resultDoor: {
          truncated: true,
          structural: true,
          spillPath,
          spillUri,
          spillFailed: spillPath == null,
          spillError,
          spillErrorCode,
          originalChars: input.sourceBytes,
          originalBytes: input.sourceBytes,
          nonTextChars: input.nonTextBytes,
          nonTextBytes: input.nonTextBytes,
          doorTokens: input.doorTokens,
          reason: input.reason,
          upstreamProjected: Boolean(upstreamProjection?.truncated),
          innerTruncationMarkers,
          ...(input.aggregate ? { aggregate: input.aggregate } : {}),
        },
      },
    } as T;
  }
  const coordSendReceipt = spillPath == null &&
    (input.opts.toolName === 'coord:send' ||
      (input.opts.toolName === 'tools:invoke' && input.opts.nestedTargetToolName === 'coord:send'))
    ? [input.result.structuredContent, ...input.result.content.filter(isTextItem).map((item) => {
        try {
          return JSON.parse(item.text) as unknown;
        } catch {
          return null;
        }
      })].find((value): value is Record<string, unknown> =>
        isJsonObject(value) && Array.isArray(value.results))
    : undefined;
  const boundedCoordSendReceipt = coordSendReceipt
    ? projectBoundedPayload(coordSendReceipt, {
        toolName: 'coord:send',
        tier: 'trimmed',
        forced: true,
        originalChars: input.sourceBytes,
        targetChars: input.doorTokens * CHARS_PER_TOKEN_ESTIMATE,
        preservePaths: COORD_SEND_DELIVERY_PRESERVE_PATHS,
        preserveTopLevelKeys: ['ok', 'partial', 'counts', 'deliveryFailureWarning'],
        recovery: preferVolatileScratchRecovery(
          volatileRecovery,
          {
            cursor: {
              kind: 'unavailable',
              tool: 'coord:send',
              args: {},
              reason: 'spill-write-failed',
              ...(spillErrorCode && spillErrorCode !== 'unknown error' ? { errorCode: spillErrorCode } : {}),
            },
            next:
              'The coord:send delivery receipt is preserved here, but oversized message details could not be saved. ' +
              'The delivery outcome is unknown; do NOT repeat the send until checking coordination state. ' +
              COORD_SEND_RECEIPT_RECOVERY,
          },
          COORD_SEND_RECEIPT_RECOVERY,
        ),
      })
    : undefined;
  if (boundedCoordSendReceipt) {
    return {
      ...input.result,
      content: [{ type: 'text' as const, text: JSON.stringify(boundedCoordSendReceipt) }],
      _meta: {
        ...(input.result._meta ?? {}),
        resultDoor: {
          truncated: true,
          structural: true,
          spillPath: null,
          spillUri: null,
          spillFailed: true,
          spillError,
          spillErrorCode,
          originalChars: input.sourceBytes,
          originalBytes: input.sourceBytes,
          nonTextChars: input.nonTextBytes,
          nonTextBytes: input.nonTextBytes,
          doorTokens: input.doorTokens,
          reason: input.reason,
          upstreamProjected: Boolean(upstreamProjection?.truncated),
          innerTruncationMarkers,
          ...(input.aggregate ? { aggregate: input.aggregate } : {}),
        },
      },
    } as T;
  }
  const completionReceipt = spillPath == null && isWorkItemsCompleteCall(input.opts)
    ? workItemsBulkReceiptBody(input.result)
    : undefined;
  const boundedCompletionReceipt = completionReceipt
    ? projectBoundedPayload(completionReceipt, {
        toolName: 'work_items:complete',
        tier: 'trimmed',
        forced: true,
        originalChars: input.sourceBytes,
        targetChars: Math.min(input.doorTokens * CHARS_PER_TOKEN_ESTIMATE, 1_200),
        preservePaths: WORK_ITEMS_COMPLETE_RECEIPT_PRESERVE_PATHS,
        preserveTopLevelKeys: ['ok', 'counts', 'results'],
        recovery: volatileRecovery
          ? {
              cursor: volatileRecovery.cursor,
              next:
                'Read _projection.cursor.args with capability:read and follow next_cursor to EOF. ' +
                'Do NOT repeat work_items:complete; verify current item state with work_items:get.',
            }
          : {
              cursor: {
                kind: 'unavailable',
                tool: 'work_items:complete',
                args: {},
                reason: 'spill-write-failed',
                ...(spillErrorCode && spillErrorCode !== 'unknown error' ? { errorCode: spillErrorCode } : {}),
              },
              next: WORK_ITEMS_COMPLETE_SPILL_RECOVERY,
            },
      })
    : undefined;
  if (boundedCompletionReceipt) {
    return {
      ...input.result,
      content: [{ type: 'text' as const, text: JSON.stringify(boundedCompletionReceipt) }],
      _meta: {
        ...(input.result._meta ?? {}),
        resultDoor: {
          truncated: true,
          structural: true,
          spillPath: null,
          spillUri: null,
          spillFailed: true,
          spillError,
          spillErrorCode,
          originalChars: input.sourceBytes,
          originalBytes: input.sourceBytes,
          nonTextChars: input.nonTextBytes,
          nonTextBytes: input.nonTextBytes,
          doorTokens: input.doorTokens,
          reason: input.reason,
          upstreamProjected: Boolean(upstreamProjection?.truncated),
          innerTruncationMarkers,
          ...(input.aggregate ? { aggregate: input.aggregate } : {}),
        },
      },
    } as T;
  }
  const setBlockerReceipt = spillPath == null ? workItemsSetBlockerReceipt(input.result, input.opts) : undefined;
  const boundedSetBlockerReceipt = setBlockerReceipt
    ? projectBoundedPayload(setBlockerReceipt.body, {
        toolName: 'work_items:set_blocker',
        tier: 'trimmed',
        forced: true,
        originalChars: input.sourceBytes,
        targetChars: Math.min(input.doorTokens * CHARS_PER_TOKEN_ESTIMATE, 1_200),
        preservePaths: WORK_ITEMS_SET_BLOCKER_RECEIPT_PRESERVE_PATHS,
        preserveTopLevelKeys: ['ok', 'counts', 'results'],
        recovery: preferVolatileScratchRecovery(
          volatileRecovery,
          workItemsSetBlockerRecovery(setBlockerReceipt),
        ),
      })
    : undefined;
  if (boundedSetBlockerReceipt) {
    return {
      ...input.result,
      content: [{ type: 'text' as const, text: JSON.stringify(boundedSetBlockerReceipt) }],
      _meta: {
        ...(input.result._meta ?? {}),
        resultDoor: {
          truncated: true,
          structural: true,
          spillPath: null,
          spillUri: null,
          spillFailed: true,
          spillError,
          spillErrorCode,
          originalChars: input.sourceBytes,
          originalBytes: input.sourceBytes,
          nonTextChars: input.nonTextBytes,
          nonTextBytes: input.nonTextBytes,
          doorTokens: input.doorTokens,
          reason: input.reason,
          upstreamProjected: Boolean(upstreamProjection?.truncated),
          innerTruncationMarkers,
          ...(input.aggregate ? { aggregate: input.aggregate } : {}),
        },
      },
    } as T;
  }
  const releaseReceipt = spillPath == null ? workItemsReleaseReceipt(input.result, input.opts) : undefined;
  const boundedReleaseReceipt = releaseReceipt
    ? projectBoundedPayload(releaseReceipt.body, {
        toolName: 'work_items:release',
        tier: 'trimmed',
        forced: true,
        originalChars: input.sourceBytes,
        targetChars: Math.min(input.doorTokens * CHARS_PER_TOKEN_ESTIMATE, 1_200),
        preservePaths: WORK_ITEMS_RELEASE_RECEIPT_PRESERVE_PATHS,
        preserveTopLevelKeys: ['ok', 'counts', 'results'],
        recovery: preferVolatileScratchRecovery(
          volatileRecovery,
          workItemsReleaseRecovery(releaseReceipt),
        ),
      })
    : undefined;
  if (boundedReleaseReceipt) {
    return {
      ...input.result,
      content: [{ type: 'text' as const, text: JSON.stringify(boundedReleaseReceipt) }],
      _meta: {
        ...(input.result._meta ?? {}),
        resultDoor: {
          truncated: true,
          structural: true,
          spillPath: null,
          spillUri: null,
          spillFailed: true,
          spillError,
          spillErrorCode,
          originalChars: input.sourceBytes,
          originalBytes: input.sourceBytes,
          nonTextChars: input.nonTextBytes,
          nonTextBytes: input.nonTextBytes,
          doorTokens: input.doorTokens,
          reason: input.reason,
          upstreamProjected: Boolean(upstreamProjection?.truncated),
          innerTruncationMarkers,
          ...(input.aggregate ? { aggregate: input.aggregate } : {}),
        },
      },
    } as T;
  }
  const scorecardReceipt = spillPath == null ? scorecardsEmitReceipt(input.result, input.opts) : undefined;
  const compactScorecardReceipt = scorecardReceipt ? compactScorecardsEmitBody(scorecardReceipt) : undefined;
  const boundedScorecardReceipt = scorecardReceipt
    ? projectBoundedPayload(compactScorecardReceipt ?? scorecardReceipt, {
        toolName: 'scorecards:emit',
        tier: 'trimmed',
        forced: true,
        originalChars: input.sourceBytes,
        targetChars: Math.min(input.doorTokens * CHARS_PER_TOKEN_ESTIMATE, 1_200),
        preservePaths: scorecardsEmitPreservePaths(compactScorecardReceipt ?? scorecardReceipt),
        preserveTopLevelKeys: ['ok', 'committed', 'completionReceipt', 'created', 'issueId', 'previousIssueId', 'canonicalRatings'],
        recovery: preferVolatileScratchRecovery(
          volatileRecovery,
          {
            cursor: {
              kind: 'unavailable',
              tool: 'scorecards:emit',
              args: {},
              reason: 'spill-write-failed',
              ...(spillErrorCode && spillErrorCode !== 'unknown error' ? { errorCode: spillErrorCode } : {}),
            },
          next: SCORECARDS_EMIT_SPILL_RECOVERY,
          },
          'The full scorecards:emit response is available in the volatile page above. ' +
            'Do NOT repeat this non-idempotent emit; inspect completionReceipt and the preserved commit status before follow-up.',
        ),
      })
    : undefined;
  if (boundedScorecardReceipt) {
    return {
      ...input.result,
      content: [{ type: 'text' as const, text: JSON.stringify(boundedScorecardReceipt) }],
      _meta: {
        ...(input.result._meta ?? {}),
        resultDoor: {
          truncated: true,
          structural: true,
          spillPath: null,
          spillUri: null,
          spillFailed: true,
          spillError,
          spillErrorCode,
          originalChars: input.sourceBytes,
          originalBytes: input.sourceBytes,
          nonTextChars: input.nonTextBytes,
          nonTextBytes: input.nonTextBytes,
          doorTokens: input.doorTokens,
          reason: input.reason,
          upstreamProjected: Boolean(upstreamProjection?.truncated),
          innerTruncationMarkers,
          ...(input.aggregate ? { aggregate: input.aggregate } : {}),
        },
      },
    } as T;
  }
  const startReceipt = isPlansStartCall(input.opts) ? workItemsBulkReceiptBody(input.result) : undefined;
  const fleetAdmissionReceipt = isFleetLaunchCall(input.opts)
    ? workItemsBulkReceiptBody(input.result, (value) => value.error === 'admission_refused')
    : undefined;
  const admissionReceipt = startReceipt ?? fleetAdmissionReceipt;
  if (admissionReceipt) {
    const receiptTool = startReceipt ? 'plans:start' : 'fleet:launch-on-plan';
    const receiptPaths = startReceipt ? PLANS_START_RECEIPT_PRESERVE_PATHS : FLEET_ADMISSION_RECEIPT_PRESERVE_PATHS;
    const next = startReceipt ? PLANS_START_RECEIPT_RECOVERY
      : 'Inspect the preserved repairCall before retrying. Page the original admission and promotion details with capability:read.';
    const recovery: BoundedPayloadRecovery = reference
      ? {
          cursor: { kind: 'scratch-page', tool: 'capability:read', args: { file_path: reference.uri, byte_offset: 0, byte_limit: 3_072 } },
          next,
        }
      : {
          cursor: { kind: 'unavailable', tool: 'plans:get', args: {}, reason: 'spill-write-failed' },
          next,
        };
    // A nested door must keep the ORIGINAL full-details cursor, rather than
    // replacing it with a page containing only the already-bounded receipt.
    const priorProjection = fleetAdmissionReceipt?._projection;
    const priorRecovery = isJsonObject(priorProjection) && isJsonObject(priorProjection.cursor)
      ? { cursor: priorProjection.cursor, next: String(priorProjection.next ?? next) } as BoundedPayloadRecovery
      : undefined;
    return {
      ...input.result,
      content: [{ type: 'text' as const, text: JSON.stringify(projectBoundedPayload(admissionReceipt, {
        toolName: receiptTool, tier: 'trimmed', forced: true,
        originalChars: input.sourceBytes,
        targetChars: input.doorTokens * CHARS_PER_TOKEN_ESTIMATE,
        preservePaths: receiptPaths,
        recovery: priorRecovery ?? preferVolatileScratchRecovery(volatileRecovery, recovery),
      })) }],
      _meta: { ...(input.result._meta ?? {}), resultDoor: {
        truncated: true, structural: true, spillPath, spillUri,
        spillFailed: spillPath == null, spillError, spillErrorCode,
        originalChars: input.sourceBytes, reason: input.reason,
      } },
    } as T;
  }
  const spillDiagnostic = [spillErrorCode, spillErrorSummary].filter(Boolean).join('; ') || 'unknown error';
  const envelope = reference
    ? buildOutputEnvelope(
        {
          summary: '',
          content: evidenceReferences.length > 0 ? evidenceReferences : [reference],
          state: 'incomplete',
          incomplete: {
            reason: input.reason,
            spilledItems: input.result.content.length,
            recoverable: !sourceWasPartial,
            note: volatileFallback
              ? volatileScratchRecoveryForTool(
                  volatileRecovery!,
                  input.opts.toolName,
                  input.opts.nestedTargetToolName,
                ).next
              : spillRecoveryNote(input.reason, {
                  toolName: input.opts.toolName,
                  nestedTargetToolName: input.opts.nestedTargetToolName,
                  effect: input.opts.effect,
                  upstreamProjection: Boolean(upstreamProjection?.truncated),
                  innerTruncationMarkers,
                  aggregateMode: input.aggregate?.mode,
                }),
          },
        },
        { summaryBudgetChars: 0 },
      )
      : buildOutputEnvelope(
        {
          summary: '',
          state: 'error',
          error: {
            code: 'output_spill_failed',
            message:
              input.opts.toolName === 'coord:send' ||
              (input.opts.toolName === 'tools:invoke' && input.opts.nestedTargetToolName === 'coord:send')
                ? `Output exceeded its hard budget and the spill write failed (${spillDiagnostic}). ` +
                  'The coord:send delivery outcome is unknown; do NOT repeat the send until you check coordination state with coord:feed or the recipient\'s coord:inbox.'
                : isWorkItemsCompleteCall(input.opts)
                  ? `Output exceeded its hard budget and the spill write failed (${spillDiagnostic}). ` +
                    'The work_items:complete write may already have committed; do NOT repeat it. Read the requested items with work_items:get before deciding any follow-up.'
                : isWorkItemsSetBlockerCall(input.opts)
                  ? `Output exceeded its hard budget and the spill write failed (${spillDiagnostic}). ` +
                    WORK_ITEMS_SET_BLOCKER_SPILL_RECOVERY
                  : isWorkItemsReleaseCall(input.opts)
                    ? `Output exceeded its hard budget and the spill write failed (${spillDiagnostic}). ` +
                      WORK_ITEMS_RELEASE_SPILL_RECOVERY
                  : isScorecardsEmitCall(input.opts)
                    ? `Output exceeded its hard budget and the spill write failed (${spillDiagnostic}). ` +
                      SCORECARDS_EMIT_UNKNOWN_SPILL_RECOVERY
                : `Output exceeded its hard budget and the spill write failed (${spillDiagnostic}).`,
            retryable: !(
              input.opts.toolName === 'coord:send' ||
              (input.opts.toolName === 'tools:invoke' && input.opts.nestedTargetToolName === 'coord:send') ||
              isWorkItemsCompleteCall(input.opts) ||
              isWorkItemsSetBlockerCall(input.opts) ||
              isWorkItemsReleaseCall(input.opts) ||
              isScorecardsEmitCall(input.opts)
            ),
          },
        },
        { summaryBudgetChars: 0 },
      );

  return {
    ...input.result,
    content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
    _meta: {
      ...(input.result._meta ?? {}),
      resultDoor: {
        truncated: true,
        structural: true,
        spillPath,
        spillUri,
        spillFailed: spillPath == null,
        spillError,
        spillErrorCode,
        ...(volatileFallback
          ? { volatileFallbackUri: volatileFallback.uri, volatileFallbackExpiresAt: volatileFallback.manifest.expiresAt }
          : {}),
        originalChars: input.sourceBytes,
        originalBytes: input.sourceBytes,
        nonTextChars: input.nonTextBytes,
        nonTextBytes: input.nonTextBytes,
        doorTokens: input.doorTokens,
        reason: input.reason,
        upstreamProjected: Boolean(upstreamProjection?.truncated),
        innerTruncationMarkers,
        ...(input.aggregate ? { aggregate: input.aggregate } : {}),
        outputEnvelope: envelope,
      },
    },
  } as T;
}

/**
 * applyResultDoor for request handlers: identical output, but any spill file is written
 * with fs.promises instead of blocking the event loop, and awaited before this resolves —
 * so a returned cursor normally names a file that exists (WI-10004533). The wait is bounded:
 * a hard write failure is re-doored without a filesystem retry, while a deadline timeout
 * keeps a typed pending cursor because the background writer still owns its quota reservation
 * and may finish later. A volatile in-process copy is returned alongside that pending state so
 * a later write failure does not strand the omitted bytes. Late settlement is reported to the
 * transport for telemetry backfill.
 */
export async function applyResultDoorAsync<T extends DoorableResult>(
  result: T,
  opts: ResultDoorOpts,
): Promise<T> {
  const deferred: Promise<void>[] = [];
  const doored = applyResultDoor(result, { ...opts, deferredScratchWrites: deferred });
  if (deferred.length === 0) return doored;
  const writeSettlements = Promise.allSettled(deferred);
  const boundedWrites = await withBoundedTimeout(writeSettlements, {
    fallback: null,
    timeoutMs: RESULT_DOOR_SCRATCH_WRITE_WAIT_MS,
    label: 'result-door scratch spill write',
  });
  if (boundedWrites.degraded || boundedWrites.value === null) {
    const error = boundedWrites.reason === 'timeout'
      ? Object.assign(
          new Error(`result-door scratch spill write exceeded ${RESULT_DOOR_SCRATCH_WRITE_WAIT_MS}ms`),
          { code: 'ETIMEDOUT' },
        )
      : boundedWrites.error ?? new Error('result-door scratch spill write did not settle');
    if (boundedWrites.reason === 'timeout') {
      const pendingResult = markPendingScratchWrite(doored, error, opts);
      if (pendingResult) {
        await recordPendingScratchWriteTimeout(pendingResult, opts);
        observeLateScratchWrite(writeSettlements, pendingResult, opts);
        const volatileFallback = applyResultDoor(result, {
          ...opts,
          deferredScratchWrites: undefined,
          scratchWriteFailure: { error },
        });
        const recoveryFallback = await persistTimedOutScratchFallback(volatileFallback, opts);
        return attachPendingScratchFallback(recoveryFallback, pendingResult, opts) ?? pendingResult;
      }
    }
    const failedResult = applyResultDoor(result, {
      ...opts,
      deferredScratchWrites: undefined,
      scratchWriteFailure: { error },
    });
    return failedResult;
  }
  const settled = boundedWrites.value;
  const failure = settled.find((s) => s.status === 'rejected');
  if (!failure || failure.status !== 'rejected') return doored;
  const failedResult = applyResultDoor(result, { ...opts, deferredScratchWrites: undefined,
    scratchWriteFailure: { error: failure.reason } });
  return failedResult;
}

async function persistTimedOutScratchFallback<T extends DoorableResult>(
  fallback: T,
  opts: ResultDoorOpts,
): Promise<T> {
  const resultDoor = recordAt(fallback._meta?.resultDoor);
  const volatileUri = typeof resultDoor?.volatileFallbackUri === 'string'
    ? resultDoor.volatileFallbackUri
    : null;
  if (!volatileUri) return fallback;

  const parts = scratchParts(opts);
  const persisted = await withBoundedTimeout(
    persistVolatileScratchReference(volatileUri, {
      workspaceId: parts.workspaceId,
      ownerId: opts.ownerId,
    }),
    {
      fallback: null,
      timeoutMs: RESULT_DOOR_DURABLE_FALLBACK_WAIT_MS,
      label: 'result-door durable timeout recovery',
    },
  );
  if (persisted.degraded || !persisted.value) return fallback;

  return promoteVolatileScratchFallback(
    fallback,
    volatileUri,
    persisted.value.uri,
    persisted.value.manifest,
  );
}

function promoteVolatileScratchFallback<T extends DoorableResult>(
  fallback: T,
  volatileUri: string,
  durableUri: string,
  manifest: ScratchReferenceManifest,
): T {
  const rewrite = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return value
        .replaceAll(volatileUri, durableUri)
        .replaceAll('exact in-process copy', 'exact workspace-scoped durable copy')
        .replaceAll(
          'This URI is not a file and is lost on server restart or cache eviction.',
          'This URI is stored in the workspace-scoped payload spool.',
        );
    }
    if (Array.isArray(value)) return value.map(rewrite);
    const row = recordAt(value);
    if (!row) return value;

    const rewritten = Object.fromEntries(Object.entries(row).map(([key, entry]) => [key, rewrite(entry)]));
    const args = recordAt(row.args);
    if (
      row.kind === 'volatile-scratch-page' &&
      (row.uri === volatileUri || args?.uri === volatileUri)
    ) {
      return {
        ...rewritten,
        kind: 'durable-scratch-page',
        uri: durableUri,
        expiresAt: manifest.expiresAt,
        args: { ...(recordAt(rewritten.args) ?? {}), uri: durableUri, byte_offset: 0, byte_limit: 3_072 },
      };
    }
    return rewritten;
  };

  const content = fallback.content.map((item) => {
    if (!isTextItem(item)) return item;
    try {
      return { ...item, text: JSON.stringify(rewrite(JSON.parse(item.text))) };
    } catch {
      return { ...item, text: item.text.replaceAll(volatileUri, durableUri) };
    }
  });
  const resultDoor = recordAt(fallback._meta?.resultDoor);
  return {
    ...fallback,
    content,
    ...(fallback.structuredContent !== undefined ? { structuredContent: rewrite(fallback.structuredContent) } : {}),
    _meta: {
      ...(fallback._meta ?? {}),
      ...(resultDoor
        ? {
            resultDoor: {
              ...resultDoor,
              durableFallbackUri: durableUri,
              durableFallbackExpiresAt: manifest.expiresAt,
              recoveryCursor: rewrite(resultDoor.recoveryCursor),
              outputEnvelope: rewrite(resultDoor.outputEnvelope),
            },
          }
        : {}),
    },
  } as T;
}

function fallbackRecoveryCursor(
  fallback: DoorableResult,
  fallbackDoor: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const declared = recordAt(fallbackDoor?.recoveryCursor);
  if (isPendingFallbackRecoveryCursor(declared)) return declared;

  // Most structural receipt projections carry the recovery cursor in the
  // model-facing `_projection`, while the text projection path also mirrors it
  // into resultDoor metadata. Read both forms before deciding that a fallback
  // cannot recover the overflow.
  for (const item of fallback.content) {
    if (!isTextItem(item)) continue;
    try {
      const body = recordAt(JSON.parse(item.text));
      const projection = recordAt(body?._projection);
      const cursor = recordAt(projection?.cursor);
      if (isPendingFallbackRecoveryCursor(cursor)) return cursor;
    } catch {
      // A non-JSON text fallback may still expose its reference in resultDoor.
    }
  }

  // Reference envelopes expose their URI and expiry in resultDoor instead of
  // `_projection.cursor`. A timeout fallback can be promoted from volatile to
  // durable after it is built, so prefer that durable URI when it is present.
  const durableUriValue = fallbackDoor?.durableFallbackUri;
  const durableUri = typeof durableUriValue === 'string'
    ? durableUriValue
    : null;
  const volatileUriValue = fallbackDoor?.volatileFallbackUri;
  const volatileUri = typeof volatileUriValue === 'string'
    ? volatileUriValue
    : null;
  const uri = durableUri ?? volatileUri;
  if (!uri) return null;
  const durableExpiresAt = fallbackDoor?.durableFallbackExpiresAt;
  const volatileExpiresAt = fallbackDoor?.volatileFallbackExpiresAt;
  const expiresAt = typeof durableExpiresAt === 'string'
    ? durableExpiresAt
    : typeof volatileExpiresAt === 'string'
      ? volatileExpiresAt
      : undefined;
  return {
    kind: durableUri ? 'durable-scratch-page' : 'volatile-scratch-page',
    tool: 'capability:read',
    uri,
    args: { uri, byte_offset: 0, byte_limit: 3_072 },
    maxByteLimit: CAPABILITY_READ_MAX_BYTE_PAGE,
    dataEncoding: 'base64',
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function isPendingFallbackRecoveryCursor(
  cursor: Record<string, unknown> | null,
): cursor is Record<string, unknown> {
  return cursor?.kind === 'volatile-scratch-page' ||
    cursor?.kind === 'durable-scratch-page' ||
    cursor?.kind === 'release-outcome-check';
}

function attachPendingScratchFallback<T extends DoorableResult>(
  fallback: T,
  pending: T,
  opts: Pick<ResultDoorOpts, 'toolName' | 'nestedTargetToolName'>,
): T | null {
  const fallbackDoor = recordAt(fallback._meta?.resultDoor);
  const pendingDoor = recordAt(pending._meta?.resultDoor);
  const fallbackCursor = fallbackRecoveryCursor(fallback, fallbackDoor);
  const pendingCursor = recordAt(pendingDoor?.recoveryCursor);
  const coordSendCall = opts.toolName === 'coord:send' ||
    (opts.toolName === 'tools:invoke' && opts.nestedTargetToolName === 'coord:send');
  // The coord:send receipt path can offer only an in-process copy while the
  // primary spill is still pending. Returning that cursor would hide the
  // pending-write warning and its do-not-resend instruction, so keep the
  // primary result until a durable fallback exists.
  if (coordSendCall && fallbackCursor?.kind === 'volatile-scratch-page') return null;
  const fallbackCanRecover = isPendingFallbackRecoveryCursor(fallbackCursor);
  if (!fallbackCanRecover || !fallbackDoor || !pendingDoor || !pendingCursor) {
    return null;
  }

  return {
    ...fallback,
    _meta: {
      ...(fallback._meta ?? {}),
      resultDoor: {
        ...fallbackDoor,
        ...(typeof fallbackDoor.spillPath === 'string' || typeof pendingDoor.spillPath !== 'string'
          ? {}
          : { spillPath: pendingDoor.spillPath }),
        ...(typeof fallbackDoor.spillUri === 'string' || typeof pendingDoor.spillUri !== 'string'
          ? {}
          : { spillUri: pendingDoor.spillUri }),
        spillPending: true,
        spillFailed: false,
        // coord:send's primary cursor carries the delivery-unknown safety
        // contract. Its fallback envelope may still expose a readable page,
        // but replacing this cursor would hide the instruction not to resend.
        recoveryCursor: coordSendCall ? pendingCursor : fallbackCursor,
        pendingSpill: {
          ...(typeof pendingDoor.spillPath === 'string' ? { path: pendingDoor.spillPath } : {}),
          ...(typeof pendingDoor.spillUri === 'string' ? { uri: pendingDoor.spillUri } : {}),
          cursor: pendingCursor,
        },
      },
    },
  } as T;
}

function markPendingScratchWrite<T extends DoorableResult>(
  result: T,
  error: unknown,
  opts: ResultDoorOpts,
): T | null {
  const meta = result._meta ?? {};
  const sourceDoorMeta = recordAt(meta.resultDoor);
  const spillPath = typeof sourceDoorMeta?.spillPath === 'string' ? sourceDoorMeta.spillPath : null;
  const spillUri = typeof sourceDoorMeta?.spillUri === 'string' ? sourceDoorMeta.spillUri : null;
  if (!sourceDoorMeta || !spillPath || !spillUri) return null;

  const sourceCursor = recordAt(sourceDoorMeta.recoveryCursor);
  const pendingCursor = {
    ...(sourceCursor ?? {}),
    kind: 'pending-spill',
    tool: 'capability:read',
    args: {
      // A pending write's absolute path can be much longer than the result-door
      // envelope allows capability:read to page.  The scratch URI resolves to the
      // same reference without putting that path in the cursor (and remains valid
      // after the writer settles).  Do not spread the source cursor's file_path:
      // capability:read prefers file_path when both keys are present.
      uri: spillUri,
      byte_offset: 0,
      byte_limit: 3_072,
    },
    path: spillPath,
    uri: spillUri,
    reason: 'spill-write-pending',
    errorCode: 'ETIMEDOUT',
    retryAfterMs: 1_000,
  };
  const coordSendCall = opts.toolName === 'coord:send' ||
    (opts.toolName === 'tools:invoke' && opts.nestedTargetToolName === 'coord:send');
  const operationName = opts.toolName === 'tools:invoke' && opts.nestedTargetToolName
    ? opts.nestedTargetToolName
    : opts.toolName;
  const pendingNext = coordSendCall
    ? `The spill write exceeded ${RESULT_DOOR_SCRATCH_WRITE_WAIT_MS}ms and is still running. ` +
      'The coord:send delivery outcome may be unknown; do NOT repeat the send until you check coordination ' +
      'state with coord:feed or the recipient\'s coord:inbox. The pending URI/path in _projection.cursor ' +
      'is not a durable recovery guarantee. Retry capability:read after it becomes readable; if late ' +
      'settlement reports failed, the overflow is unavailable from this result.'
    : `The spill write exceeded ${RESULT_DOOR_SCRATCH_WRITE_WAIT_MS}ms and is still running. ` +
      `Do NOT repeat ${operationName}; the pending URI/path in _projection.cursor is not a durable ` +
      `recovery guarantee. Retry capability:read after it becomes readable; if late settlement reports ` +
      `failed, the overflow is unavailable from this result.`;

  let outputEnvelope = recordAt(sourceDoorMeta.outputEnvelope);
  const sourceIncomplete = recordAt(outputEnvelope?.incomplete);
  if (outputEnvelope && sourceIncomplete) {
    outputEnvelope = {
      ...outputEnvelope,
      incomplete: { ...sourceIncomplete, note: pendingNext },
    };
  }

  const content = result.content.map((item) => {
    if (!isTextItem(item)) return item;
    try {
      const body = recordAt(JSON.parse(item.text));
      if (!body) return item;
      const projection = recordAt(body._projection);
      const incomplete = recordAt(body.incomplete);
      if (!projection && !incomplete) return item;
      return {
        ...item,
        text: JSON.stringify({
          ...body,
          ...(incomplete ? { incomplete: { ...incomplete, note: pendingNext } } : {}),
          _projection: {
            ...(projection ?? {}),
            kind: projection?.kind ?? 'bounded-payload',
            truncated: true,
            cursor: pendingCursor,
            next: pendingNext,
          },
        }),
      };
    } catch {
      return item;
    }
  });

  const errorMessage = error instanceof Error ? error.message : String(error);
  return {
    ...result,
    content,
    _meta: {
      ...meta,
      resultDoor: {
        ...sourceDoorMeta,
        spillPending: true,
        spillFailed: false,
        spillError: errorMessage.slice(0, 240),
        spillErrorCode: 'ETIMEDOUT',
        recoveryCursor: pendingCursor,
        ...(outputEnvelope ? { outputEnvelope } : {}),
      },
    },
  } as T;
}

function observeLateScratchWrite<T extends DoorableResult>(
  writeSettlements: Promise<PromiseSettledResult<void>[]>,
  pendingResult: T,
  opts: ResultDoorOpts,
): void {
  const callback = opts.onLateScratchWriteSettled;
  const meta = recordAt(pendingResult._meta?.resultDoor);
  const spillPath = typeof meta?.spillPath === 'string' ? meta.spillPath : null;
  const spillUri = typeof meta?.spillUri === 'string' ? meta.spillUri : null;
  if (!callback || !meta || !spillPath || !spillUri) return;

  const aggregate = recordAt(meta.aggregate);
  const settlementBase = {
    spillPath,
    spillUri,
    originalBytes: typeof meta.originalBytes === 'number' ? meta.originalBytes : 0,
    returnedContextBytes: measureResultContextBytes(pendingResult),
    reason: typeof meta.reason === 'string' ? meta.reason : 'per-result-budget-exceeded',
    aggregateOutputEscape:
      meta.reason === 'aggregate-output-budget-exceeded' || aggregate?.exceeded === true,
  };
  void writeSettlements.then(async (settled) => {
    const failure = settled.find((entry): entry is PromiseRejectedResult => entry.status === 'rejected');
    const errorCode = failure && failure.reason && typeof failure.reason === 'object' &&
      'code' in failure.reason && typeof failure.reason.code === 'string'
      ? failure.reason.code
      : undefined;
    try {
      await callback({
        ...settlementBase,
        status: failure ? 'failed' : 'persisted',
        ...(errorCode ? { errorCode } : {}),
      });
    } catch (callbackError) {
      console.warn(
        `[result-door] late scratch-write settlement callback failed: ${callbackError instanceof Error ? callbackError.message : String(callbackError)}`,
      );
    }
  });
}

async function recordPendingScratchWriteTimeout<T extends DoorableResult>(
  pendingResult: T,
  opts: ResultDoorOpts,
): Promise<void> {
  const callback = opts.onScratchWritePending;
  const meta = recordAt(pendingResult._meta?.resultDoor);
  const spillPath = typeof meta?.spillPath === 'string' ? meta.spillPath : null;
  const spillUri = typeof meta?.spillUri === 'string' ? meta.spillUri : null;
  if (!callback || !meta || !spillPath || !spillUri) return;

  const aggregate = recordAt(meta.aggregate);
  try {
    await callback({
      timeoutMs: RESULT_DOOR_SCRATCH_WRITE_WAIT_MS,
      timedOutAt: new Date().toISOString(),
      spillPath,
      spillUri,
      originalBytes: typeof meta.originalBytes === 'number' ? meta.originalBytes : 0,
      returnedContextBytes: measureResultContextBytes(pendingResult),
      reason: typeof meta.reason === 'string' ? meta.reason : 'per-result-budget-exceeded',
      aggregateOutputEscape:
        meta.reason === 'aggregate-output-budget-exceeded' || aggregate?.exceeded === true,
    });
  } catch (callbackError) {
    console.warn(
      `[result-door] pending scratch-write timeout callback failed: ${callbackError instanceof Error ? callbackError.message : String(callbackError)}`,
    );
  }
}

function isScorecardsGetResult(opts: ResultDoorOpts): boolean {
  return opts.toolName === 'scorecards:get' ||
    (opts.toolName === 'tools:invoke' && opts.nestedTargetToolName === 'scorecards:get');
}

function recordAt(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Discovery schemas are executable contracts, including compact signatures.
 * Generic prose clipping must never leave a damaged contract under argSchema.
 * Reuse the existing source cursor for schemas that cannot fit atomically. */
function repairDiscoverySchemaProjection(
  sourceValue: unknown,
  projected: Record<string, unknown>,
  targetBytes: number,
): void {
  const source = recordAt(sourceValue);
  if (!Array.isArray(source?.hits) || !Array.isArray(projected.hits)) return;
  const sourceSchemas = new Map<string, string>();
  for (const value of source.hits) {
    const hit = recordAt(value);
    if (typeof hit?.tool === 'string' && typeof hit.argSchema === 'string') {
      sourceSchemas.set(hit.tool, hit.argSchema);
    }
  }
  const clipped: Array<{ hit: Record<string, unknown>; schema: string }> = [];
  for (const value of projected.hits) {
    const hit = recordAt(value);
    const schema = typeof hit?.tool === 'string' ? sourceSchemas.get(hit.tool) : undefined;
    if (!hit || schema === undefined || hit.argSchema === schema) continue;
    delete hit.argSchema;
    hit.argSchemaUnavailable = true;
    clipped.push({ hit, schema });
  }
  // Remove every damaged schema first so a large early hit cannot crowd out
  // a later usable schema. Account for UTF-8, as the transport door does.
  const metadata = recordAt(projected._projection);
  for (const { hit, schema } of clipped) {
    delete hit.argSchemaUnavailable;
    hit.argSchema = schema;
    if (metadata) metadata.returnedChars = JSON.stringify(projected).length;
    if (Buffer.byteLength(JSON.stringify(projected), 'utf8') > targetBytes) {
      delete hit.argSchema;
      hit.argSchemaUnavailable = true;
    }
  }
  if (metadata) metadata.returnedChars = JSON.stringify(projected).length;
}

function retainedPrefixLength(source: string, projected: string): number {
  let length = 0;
  while (length < source.length && length < projected.length && source[length] === projected[length]) {
    length += 1;
  }
  return length;
}

function scorecardEvidenceReadCall(issueId: string, criterionKey: string, evidenceOffset: number) {
  return {
    tool: 'scorecards:get',
    args: { issueId, criterionKey, evidenceOffset },
  };
}

/** Keep scorecards:get's paging contract truthful across this later projection. */
function repairScorecardsGetProjection(sourceValue: unknown, projected: Record<string, unknown>): void {
  const source = recordAt(sourceValue);
  const sourceScorecard = recordAt(source?.scorecard);
  const sourceRead = recordAt(source?.evidenceRead);
  const sourceCriteria = Array.isArray(sourceScorecard?.criteria)
    ? sourceScorecard.criteria.map(recordAt).filter((row): row is Record<string, unknown> => row != null)
    : [];
  if (!sourceScorecard || !sourceRead || sourceCriteria.length === 0) return;

  const targetScorecard = recordAt(projected.scorecard) ?? {
    issueId: sourceScorecard.issueId,
    criteria: [],
  };
  projected.scorecard = targetScorecard;
  const targetRead = {
    ...sourceRead,
    ...(recordAt(projected.evidenceRead) ?? {}),
  };
  projected.evidenceRead = targetRead;

  if (sourceRead.scope === 'selected-criterion') {
    const sourceCriterion = sourceCriteria[0];
    const key = typeof sourceCriterion.key === 'string' ? sourceCriterion.key : null;
    const sourcePage = typeof sourceCriterion.evidence === 'string' ? sourceCriterion.evidence : null;
    const issueId = typeof sourceScorecard.issueId === 'string' ? sourceScorecard.issueId : null;
    const sourceOffset = typeof sourceRead.offset === 'number' ? sourceRead.offset : 0;
    if (!key || sourcePage == null || !issueId) return;

    const targetCriteria = Array.isArray(targetScorecard.criteria)
      ? targetScorecard.criteria.map(recordAt).filter((row): row is Record<string, unknown> => row != null)
      : [];
    const targetCriterion = targetCriteria.find((row) => row.key === key);
    const projectedPage = typeof targetCriterion?.evidence === 'string' ? targetCriterion.evidence : '';
    const retainedChars = retainedPrefixLength(sourcePage, projectedPage);
    const pageWasClipped = retainedChars < sourcePage.length;

    targetScorecard.criteria = [{
      ...(targetCriterion ?? {}),
      key,
      ...(typeof sourceCriterion.rating === 'string' ? { rating: sourceCriterion.rating } : {}),
      evidence: pageWasClipped ? sourcePage.slice(0, retainedChars) : sourcePage,
    }];

    if (pageWasClipped) {
      const nextOffset = sourceOffset + retainedChars;
      targetRead.complete = false;
      targetRead.reason = 'outer-result-door-clipped-page';
      targetRead.instruction =
        'The outer result door clipped this page. Continue from evidenceRead.next; if its offset does not advance, read the _projection.cursor to recover the original page.';
      targetRead.next = scorecardEvidenceReadCall(issueId, key, nextOffset);
    } else if (sourceRead.complete === false && sourceRead.next === undefined) {
      const nextOffset = sourceOffset + sourcePage.length;
      targetRead.complete = false;
      targetRead.next = scorecardEvidenceReadCall(issueId, key, nextOffset);
    }
    return;
  }

  if (sourceRead.complete === true) {
    const targetCriteria = Array.isArray(targetScorecard.criteria)
      ? targetScorecard.criteria.map(recordAt).filter((row): row is Record<string, unknown> => row != null)
      : [];
    const evidenceIntact = sourceCriteria.every((sourceCriterion) => {
      const key = sourceCriterion.key;
      const sourceEvidence = sourceCriterion.evidence;
      if (typeof key !== 'string' || typeof sourceEvidence !== 'string') return false;
      const targetCriterion = targetCriteria.find((row) => row.key === key);
      return targetCriterion?.evidence === sourceEvidence;
    });
    if (evidenceIntact && targetCriteria.length === sourceCriteria.length) return;

    const issueId = typeof sourceScorecard.issueId === 'string' ? sourceScorecard.issueId : null;
    if (!issueId) return;
    targetScorecard.criteria = [];
    targetRead.complete = false;
    targetRead.reason = 'outer-result-door-clipped-card';
    targetRead.instruction =
      'The outer result door clipped card evidence. Read every indexed criterion and concatenate its pages before grading; this index is not evidence of a missing probe.';
    targetRead.criteria = sourceCriteria.flatMap((criterion) => {
      if (typeof criterion.key !== 'string' || typeof criterion.evidence !== 'string') return [];
      return [{
        key: criterion.key,
        ...(typeof criterion.rating === 'string' ? { rating: criterion.rating } : {}),
        evidenceChars: criterion.evidence.length,
        read: scorecardEvidenceReadCall(issueId, criterion.key, 0),
      }];
    });
  }
}

function isScratchReferenceBytePageResult(
  result: DoorableResult,
  opts: Pick<ResultDoorOpts, 'toolName' | 'nestedTargetToolName'>,
): boolean {
  const targetToolName = opts.toolName === 'tools:invoke'
    ? opts.nestedTargetToolName
    : opts.toolName;
  if (targetToolName !== 'capability:read' || result.content.length !== 1) return false;
  const item = result.content[0];
  if (!isTextItem(item)) return false;

  try {
    const page = recordAt(JSON.parse(item.text));
    return page?.ok === true &&
      page.encoding === 'base64' &&
      Number.isSafeInteger(page.byte_offset) &&
      Number.isSafeInteger(page.byte_length) &&
      Number.isSafeInteger(page.total_bytes) &&
      recordAt(page.reference) !== null;
  } catch {
    return false;
  }
}

function isScratchReferenceReadResult(
  result: DoorableResult,
  opts: Pick<ResultDoorOpts, 'toolName' | 'nestedTargetToolName'>,
): boolean {
  const targetToolName = opts.toolName === 'tools:invoke'
    ? opts.nestedTargetToolName
    : opts.toolName;
  const capabilityReadMeta = (
    result._meta as { capabilityRead?: { source?: unknown } } | undefined
  )?.capabilityRead;
  return targetToolName === 'capability:read' && capabilityReadMeta?.source === 'scratch-reference';
}

/**
 * Apply both model-facing output rails: the existing per-result door and, when
 * the transport supplied a cohort, one aggregate budget across the fan-out.
 * Text overflow is structurally projected; non-text or aggregate overflow is
 * stored once and replaced by the shared typed-reference envelope.
 */
export function applyResultDoor<T extends DoorableResult>(result: T, opts: ResultDoorOpts): T {
  try {
    if (process.env.PAPERCUSP_RESULT_DOOR_OFF === '1') return result;
    // EI-19325631662380565: `_meta.delta` presence alone is NOT the marker of a
    // genuine delta envelope — every delta-CAPABLE tool also stamps this block on
    // an ordinary full response (mode:'full', reason 'no_request' or
    // 'proxy_reconstructed') to advertise the capability + carry a cursor. Only a
    // non-'full' mode is a client-reconstructed patch that a text cap would corrupt.
    const deltaMeta = (result._meta as { delta?: { mode?: unknown } } | undefined)?.delta;
    if (deltaMeta != null && deltaMeta.mode !== 'full') return result;
    const items = result.content;
    if (!Array.isArray(items)) return result;

    // P-023: the effective resultEach door for THIS caller (workspace defaults ⟵
    // session override; sync snapshot, fail-soft to the baked 1500-token floor).
    const effectiveConstants = getDoorConstantsSync(opts.ownerId);
    const doors = computeTurnDoors(0, effectiveConstants);
    const doorTokens = doors.resultEach;
    const budgetChars = doorTokens * CHARS_PER_TOKEN_ESTIMATE;
    // EI-13918: `result.data` may ALREADY have been replaced upstream by a
    // lossy payload-tier projection (payload-tier.ts) BEFORE this door ever
    // saw it — in which case `fullText` below is not the tool's true full
    // output; the genuinely-omitted content was never serialized at all, so
    // paging this spill file can never recover it. Detect that via the
    // `_meta.payloadProjection` marker (serialize-result.ts) rather than
    // sniffing the serialized JSON text, and pick truthful header/footer
    // wording for each case instead of unconditionally claiming "FULL".
    const upstreamProjection = (
      result._meta as
        | {
            payloadProjection?: {
              truncated: true;
              tier: string;
              forced: boolean;
              originalChars: number;
              returnedChars: number;
              omittedCount: number;
            };
          }
        | undefined
    )?.payloadProjection;
    // EI-22167228731928620: an EXPLICIT payloadTier:'full' (or an equivalent
    // transport-cap exemption) skipped payload-tier.ts's own tier shaper AND
    // its hard-ceiling force-shape — `data` is the tool's true raw output.
    // Mutually exclusive with `upstreamProjection` by construction (payload-tier.ts
    // returns before ever setting `payloadProjection` on this path).
    const explicitFullRequest = Boolean(
      (result._meta as { explicitFullRequest?: unknown } | undefined)?.explicitFullRequest,
    );
    let explicitFullSpillFailed = false;
    let explicitFullSpillError: unknown;
    let totalChars = 0;
    let textBytes = 0;
    // D-021 activates the old WI-36613 detector: non-text content is now a live
    // output path, so it participates in the same byte accounting as text.
    let nonTextChars = 0;
    for (const it of items) {
      if (isTextItem(it)) {
        totalChars += it.text.length;
        textBytes += Buffer.byteLength(it.text, 'utf8');
      } else nonTextChars += nonTextSize(it);
    }
    const sourceBytes = textBytes + nonTextChars;
    // A scratch-reference byte page is itself the recovery transport for a
    // result-door spill. Re-spilling it only creates another reference and
    // forces capability:read to recurse. The page is already sized to fit the
    // per-result door by capability:read; ordinary reads still consume the
    // aggregate fan-out budget.
    const recoveryBytePage = isScratchReferenceBytePageResult(result, opts);
    const scratchReferenceRead = isScratchReferenceReadResult(result, opts);
    const aggregate = opts.aggregateScope && !recoveryBytePage && !scratchReferenceRead
      ? reserveAggregateBytes(
          opts.aggregateScope,
          sourceBytes,
          // Aggregate accounting is downstream of the per-result rail. A
          // 20KB single result becomes a <=6KB structural projection and must
          // not consume the whole 12KB fan-out budget by its pre-door size.
          // Charging the per-result ceiling is conservative (the returned
          // envelope is normally smaller) while preserving the existing
          // structural projection path and enforcing the aggregate invariant.
          Math.min(sourceBytes, budgetChars),
          doors.resultEach * doors.resultSlots * CHARS_PER_TOKEN_ESTIMATE,
        )
      : undefined;

    // D-021 activates the old WI-36613 revisit condition: now that media is a
    // live output path, non-text participates in the SAME hard accounting. A
    // non-text block cannot be structurally sliced, so spill the whole MCP
    // content array once and return the typed reference envelope. Aggregate
    // exhaustion takes the same route for text or non-text.
    if (aggregate?.exceeded || (nonTextChars > 0 && sourceBytes > budgetChars)) {
      return spillResultAsReferenceEnvelope({
        result,
        opts,
        reason: aggregate?.exceeded ? 'aggregate-output-budget-exceeded' : 'non-text-result-budget-exceeded',
        sourceBytes,
        nonTextBytes: nonTextChars,
        doorTokens,
        aggregate,
      });
    }

    // EI-22167228731928620: an explicit-full body that STILL overflows the
    // transport door takes the same hard-overflow route as aggregate/non-text
    // exhaustion, rather than falling into the generic bounded-payload
    // reprojection below. That generic walk is field-blind (it does not know
    // e.g. `summary` deserves the priority a tool's own trimmed shaper gives
    // it), and the RAW body it would be walking here is LARGER than a
    // 'trimmed' call's output precisely because payload-tier.ts's
    // explicitFullRequest exemption skipped that shaper — so re-projecting it
    // generically can leave LESS useful content inline than plain 'trimmed'
    // would have: worse than the tier the caller explicitly opted out of.
    // Spilling the untouched full body and pointing at it is honest about the
    // size and strictly recoverable in full, which the generic reprojection
    // is not. If persistence fails for an ordinary result, continue into the
    // existing bounded projector instead of replacing readable content with an
    // error envelope. coord:send keeps its specialized failure result: when a
    // receipt is present it preserves delivery fields, and when no receipt can
    // be recovered it must retain the non-retryable unknown-delivery verdict.
    if (explicitFullRequest && sourceBytes > budgetChars) {
      const spilled = spillResultAsReferenceEnvelope({
        result,
        opts,
        reason: 'explicit-full-request-overflow',
        sourceBytes,
        nonTextBytes: nonTextChars,
        doorTokens,
        aggregate,
        onSpillFailure: (error) => {
          explicitFullSpillFailed = true;
          explicitFullSpillError = error;
        },
      });
      const coordSendCall = opts.toolName === 'coord:send' ||
        (opts.toolName === 'tools:invoke' && opts.nestedTargetToolName === 'coord:send');
      if (!explicitFullSpillFailed || coordSendCall) return spilled;
    }

    if (sourceBytes <= budgetChars) {
      // Fitting the door does not make an upstream-projected value complete.
      // Row/map partial sentinels and clipped-string markers can be the only
      // disclosure; route them through the typed incomplete envelope so a
      // downstream caller cannot infer success from a short body. coord:thread
      // is the exception when every marker is one of its documented,
      // field-specific continuations; those flags are the usable response.
      const innerTruncationMarkers = detectInnerTruncationMarkers(
        items.filter(isTextItem).map((item) => item.text),
        opts.toolName,
        opts.nestedTargetToolName,
      );
      const threadMarkersRecoverable = hasOnlyRecoverableCoordThreadMarkers(
        innerTruncationMarkers,
        opts.toolName,
        opts.nestedTargetToolName,
      );
      if (!upstreamProjection?.truncated &&
        (innerTruncationMarkers.length === 0 || threadMarkersRecoverable || scratchReferenceRead)) {
        return reconcileWorkItemsGetReceiptResult(result, opts);
      }
      return spillResultAsReferenceEnvelope({
        result,
        opts,
        reason: 'under-budget-partial-result',
        sourceBytes,
        nonTextBytes: nonTextChars,
        doorTokens,
        aggregate,
      });
    }

    const textItems = items.filter(isTextItem);
    const fullText = textItems.map((it) => it.text).join('\n\n');
    // A structured JSON payload is often followed by a separate advisory
    // content item. Classify once before writing the spill so the machine-
    // readable payload can be kept as the final byte stream, with those
    // advisories preserved in the prefix rather than appended after JSON.
    const classifiedBodyShape = classifyProjectionBody(textItems);
    let jsonItemIndex = classifiedBodyShape.json?.itemIndex ?? -1;
    let jsonSlice = jsonItemIndex >= 0 ? findJsonPrefixSlice(textItems[jsonItemIndex].text) : null;
    if (jsonItemIndex < 0) {
      for (let index = 0; index < textItems.length; index += 1) {
        const candidate = findJsonPrefixSlice(textItems[index].text);
        if (!candidate) continue;
        jsonItemIndex = index;
        jsonSlice = candidate;
        break;
      }
    }
    const bodyShape = classifiedBodyShape.json || !jsonSlice
      ? classifiedBodyShape
      : {
          ...classifiedBodyShape,
          json: {
            parsed: JSON.parse(textItems[jsonItemIndex].text.slice(jsonSlice.start, jsonSlice.end)),
            itemIndex: jsonItemIndex,
          },
        };
    const spillBodyText = jsonItemIndex >= 0 && jsonSlice
      ? textItems[jsonItemIndex].text.slice(jsonSlice.start, jsonSlice.end)
      : jsonItemIndex >= 0
        ? textItems[jsonItemIndex].text
        : fullText;
    const spillAdvisoryPrefix = buildSpillAdvisoryPrefix(textItems, jsonItemIndex, jsonSlice);
    // Preserve the same typed evidence index on ordinary text spills as on the
    // hard-overflow reference envelope. A result can reach this branch when the
    // outer result door caps a JSON `work_items:get` response; without the index,
    // capability:read's evidence_class selector sees a valid scratch reference
    // but cannot resolve its work-item/event/fleet evidence (EI-22586299911603348).
    const spillEvidence = detectResultEvidence(items);
    // WI-36047 (borrow item 9, opencode/OMP research): THE SPILL GETS ITS OWN
    // FAIL-SOFT BOUNDARY, SEPARATE FROM THE CAP.
    //
    // This door's cap is implemented as a side-effect of "park the full copy
    // somewhere first", and that shape has TWO distinct failure modes which
    // deserve OPPOSITE answers:
    //   - the CAPPING fails  → returning the original result is right (the door
    //     must never turn a good result into a failure);
    //   - the SPILL WRITE fails → returning the original result is WRONG. It
    //     re-exposes the full, context-blowing payload the door exists to bound,
    //     and it does so precisely when the box is already unhealthy (disk full,
    //     unwritable scratch, permissions).
    // Until this fix ONE `try` spanned both, so the second case silently took the
    // first case's answer. OMP has the identical bug with the sign flipped: it
    // gets the save-FAILED path right (output-meta.ts:684-692, truncates anyway,
    // under an explicit comment that a save failure must never re-expose the full
    // output) and the store-ABSENT path wrong (`:656`, returns uncapped).
    //
    // So: a spill we could not write degrades to TRUNCATE-WITHOUT-RECOVERY —
    // still capped, and the footer says the overflow is gone rather than naming a
    // path that does not exist. Never to no-cap.
    let fsPath: string | null = null;
    let uri: string | null = null;
    let spillError: string | null = null;
    // The unavailable cursor is model-facing: it carries the terse errno and a
    // bounded, path-redacted error summary. A raw fs error embeds the full path
    // (`ENOTDIR: not a directory, mkdir '/…/scratch/ws-1/plans:get/…'`), so keep
    // that unredacted message private in `_meta` while preserving the cause for
    // diagnosis in `errorDetail` and the recovery text.
    let spillErrorCode: string | null = null;
    let spillErrorSummary: string | null = null;
    let spillManifest: ScratchReferenceManifest | null = null;
    let volatileFallback: NonNullable<ReturnType<typeof storeVolatileScratchReference>> | null = null;
    const noteSpillFailure = (err: unknown): void => {
      const details = spillFailureDetails(err, [
        ...(fsPath ? [fsPath, dirname(fsPath)] : []),
        process.env.PAPERCUSP_SCRATCH_ROOT,
      ]);
      spillError = details.error;
      spillErrorCode = details.code;
      spillErrorSummary = details.summary;
      spillManifest = null;
      fsPath = null;
      uri = null;
    };
    try {
      const parts = scratchParts(opts);
      const basename = `result-door-${Date.now()}.md`;
      uri = buildScratchUri({ ...parts, basename });
      fsPath = safeScratchFilesystemPath(uri);
    } catch (err) {
      // A path we cannot even NAME is the store-absent case: cap, disclose, move on.
      noteSpillFailure(err);
    }
    // A result can carry BOTH a payload-tier projection marker and tool-owned
    // field markers. They describe different losses and can have different
    // recovery routes (for example work_items:get's priorAttemptRefs handle), so
    // the broader projection must not suppress the field-level diagnosis.
    const innerTruncationMarkers = detectInnerTruncationMarkers(
      textItems.map((item) => item.text),
      opts.toolName,
      opts.nestedTargetToolName,
    );
    const header = upstreamProjection
      ? `# result-door spill — an ALREADY-PROJECTED (partial) tool result\n` +
        `# tool: ${opts.toolName}\n# spilled: ${new Date().toISOString()}\n` +
        `# upstream payload-tier shaping already replaced the tool's full output with a ` +
        `bounded projection BEFORE this door ran: tier=${upstreamProjection.tier} ` +
        `forced=${upstreamProjection.forced} originalChars=${upstreamProjection.originalChars} ` +
        `returnedChars=${upstreamProjection.returnedChars} omittedCount=${upstreamProjection.omittedCount}.\n` +
        `# The ${upstreamProjection.omittedCount} omitted field(s)/row(s) were NEVER serialized and are ` +
        `NOT recoverable from this file — ${upstreamProjectionRecoveryInstruction(opts.toolName, opts.nestedTargetToolName, innerTruncationMarkers, opts.effect)}\n` +
        `# What follows is only that already-partial projection, further capped at the ` +
        `per-result door (${doorTokens} tokens) below.\n\n`
      : innerTruncationMarkers.length > 0
        ? `# result-door spill — FULL door-level text, but the TOOL ITSELF already truncated field(s)\n` +
          `# tool: ${opts.toolName}\n# spilled: ${new Date().toISOString()}\n` +
          `# original ~${Math.ceil(totalChars / CHARS_PER_TOKEN_ESTIMATE)} tokens (${totalChars} chars); door ${doorTokens} tokens\n` +
          `# detected marker(s): ${innerTruncationMarkers.join(', ')} — these mark field(s) the tool cut\n` +
          `# short BEFORE this door ever ran. This file holds everything the tool DID emit, but the\n` +
          `# marked field(s) are themselves incomplete and were never fully serialized — paging this\n` +
          `# file will NOT recover them. ${innerTruncationRecoveryInstruction(opts.toolName, innerTruncationMarkers, opts.nestedTargetToolName)}\n\n`
        : // EI-18762253154342502: never claim "FULL" unconditionally — no marker firing
          // proves nothing was cut upstream, only that no DETECTED marker was found (a
          // tool can truncate a field with a plain ellipsis and no `_truncated` flag,
          // as plans:items did before this fix). "as it reached this door" is always
          // true and never overclaims what was actually recoverable.
          `# result-door spill — the text as it reached this door (no upstream truncation marker detected;\n` +
          `# that does NOT guarantee the tool emitted every field in full — only that none of its known\n` +
          `# _truncated markers fired)\n` +
          `# tool: ${opts.toolName}\n# spilled: ${new Date().toISOString()}\n` +
          `# original ~${Math.ceil(totalChars / CHARS_PER_TOKEN_ESTIMATE)} tokens (${totalChars} chars); door ${doorTokens} tokens\n\n`;
    // P-003 (agent-epistemics-2026-08-02): for a LIST-shaped result, lead the file
    // with one line per entry. The door already solves SIZE; this solves the question
    // the reader actually arrives with — "which of these do I care about" — which was
    // otherwise answered by grepping the spill file by hand. It lives in the FILE, not
    // in the returned result, so it costs the agent zero context. `buildSpillIndex`
    // returns null (never throws) whenever an index would not help, keeping the
    // door's fail-soft contract: a missing index is an annoyance, a failed WRITE
    // loses the payload.
    const spillIndex = buildSpillIndex(spillBodyText);
    // EI-21949915395361184: the recipe belongs in the FILE, for the reader who has only
    // the file. The manifest carries the boundary as a number; this says how to use it
    // without the cursor this call returns — and names the wrong guess explicitly,
    // because "parse from the first `{`" does not error, it returns the MANIFEST.
    // Deliberately prints no offset of its own: a number written here would sit inside
    // the very payload it measures.
    const spillBodyRecipe =
      bodyShape.json != null
        ? '# recover the JSON body from this file alone — the boundary is in the manifest on line 2:\n' +
          "#   P=$(sed -n 2p FILE | jq -r '.bodyOffsetInPayload'); H=$(head -2 FILE | wc -c)\n" +
          '#   tail -c +$((H + P + 1)) FILE | jq .\n' +
          '# Do NOT parse from the first `{` — that is the manifest: well-formed, wrong object.\n\n'
        : '';
    const spillPrefix = header + spillBodyRecipe + spillAdvisoryPrefix + (spillIndex ? `${spillIndex}\n` : '');
    if (fsPath != null) {
      try {
        if (explicitFullSpillFailed) throw explicitFullSpillError;
        if (opts.scratchWriteFailure) throw opts.scratchWriteFailure.error;
        const parts = scratchParts(opts);
        spillManifest = writeScratchReference({
          filePath: fsPath,
          payload: spillPrefix + spillBodyText,
          workspaceId: parts.workspaceId,
          ownerId: opts.ownerId,
          audience: opts.ownerId ? 'owner' : 'workspace',
          mediaType: 'text/plain',
          content: contentMetadata(items),
          evidence: spillEvidence,
          deferredWrites: opts.deferredScratchWrites,
          requestTraceId: opts.requestTraceId,
          onScratchWriteTiming: opts.onScratchWriteTiming,
          // EI-21949915395361184: put the boundary IN THE FILE, not only in the cursor
          // this call returns. Ten reports across five months all describe the same
          // consumer — one holding the path and nothing else — and every guess that
          // consumer can make fails: `jq .` chokes on the magic line, and "first `{`
          // through EOF" silently parses the MANIFEST instead of the body. Declared for
          // a JSON body only, so its ABSENCE is the honest answer "there is no JSON here"
          // rather than a boundary that points at prose.
          ...(bodyShape.json != null
            ? { bodyOffsetInPayload: Buffer.byteLength(spillPrefix, 'utf8') }
            : {}),
        });
      } catch (err) {
        // WI-36047: the write failed — fall through to the CAP anyway, and null
        // the path so no footer, no `_meta`, and no telemetry backfill advertises
        // a spill file that is not there. The bounded volatile cache below is a
        // short-lived recovery path; when it cannot retain the body we still cap.
        noteSpillFailure(err);
      }
    }
    if (spillError !== null) {
      volatileFallback = cacheFailedSpill({
        opts,
        payload: spillPrefix + spillBodyText,
        mediaType: 'text/plain',
        content: contentMetadata(items),
        evidence: spillEvidence,
        ...(bodyShape.json != null ? { bodyOffsetInPayload: Buffer.byteLength(spillPrefix, 'utf8') } : {}),
      });
    }

    const baseResultDoorMeta = {
      truncated: true,
      /** null when the spill could NOT be written (WI-36047) — the result was
       *  still capped, but nothing was parked, so `_mcp-handler`'s outputRef
       *  backfill correctly declines to advertise a file that is not there. */
      spillPath: fsPath,
      spillUri: uri,
      /** True when the cap applied but the spill write failed, i.e. the cut
       *  content is gone. Distinct from `upstreamProjected` (content that was
       *  never serialized) — this is content the door itself discarded. */
      spillFailed: fsPath == null,
      /** Full fs error message (carries the failing path — kept OUT of the
       *  model-facing footer, which gets `spillErrorCode` instead). */
      spillError,
      spillErrorCode,
      ...(volatileFallback
        ? { volatileFallbackUri: volatileFallback.uri, volatileFallbackExpiresAt: volatileFallback.manifest.expiresAt }
        : {}),
      originalChars: totalChars,
      /** Exact UTF-8 bytes as they reached the door. Unlike originalChars this
       * remains comparable to intermediateBytes for non-ASCII payloads. */
      originalBytes: sourceBytes,
      /** UTF-8 bytes of non-text content carried by this result. Kept under the
       *  legacy key for telemetry compatibility; D-021 makes it enforced. */
      nonTextChars,
      nonTextBytes: nonTextChars,
      doorTokens,
      /** True when `data` was ALREADY a lossy upstream projection before this
       *  door saw it — i.e. paging the spill cannot recover what was omitted. */
      upstreamProjected: Boolean(upstreamProjection),
      /** Field-level cutoffs the TOOL itself applied; the spill cannot recover
       *  these either (EI-18745696571494110). Empty when none were detected. */
      innerTruncationMarkers,
    };

    // WI-38402 / EI-20244970883634313 / EI-20435986111760474: character-slicing
    // ANY oversized text body creates an incomplete transport value. JSON was
    // the obvious case, but raw text is equally unsafe for a machine-readable
    // caller: code:tools emits TypeScript, and tools:invoke used to return a
    // sliced declaration followed by prose. ptool correctly refused that as an
    // incomplete payload, so a ten-signature acceptance read could not recover.
    //
    // This is the universal model-facing choke point. Project both JSON and
    // non-JSON text STRUCTURALLY and serialize only after projection completes.
    // Non-JSON text gets a stable `{ text, _projection }` envelope; JSON retains
    // its native object/array shape plus `_projection`. The durable spill is
    // written first, so both forms carry the same schema-valid capability:read
    // cursor and no client ever has to parse a chopped prefix plus a prose footer.
    const parsedJsonBody = bodyShape.json != null;
    // A valid JSON body can still be only a sample: custom shapers mark field
    // cutoffs in the body, while payload-tier marks an upstream projection in
    // metadata. Both make the spill incomplete; neither removes the byte locator.
    const upstreamJsonProjection = Boolean(upstreamProjection?.truncated);
    const partialJsonBody =
      parsedJsonBody && (upstreamJsonProjection || innerTruncationMarkers.length > 0);
    const partialJsonSource = upstreamJsonProjection
      ? 'upstream payloadProjection'
      : `the tool marked ${innerTruncationMarkers.join(', ')}`;
    const partialJsonReRead = upstreamJsonProjection
      ? upstreamProjectionRecoveryInstruction(opts.toolName, opts.nestedTargetToolName, innerTruncationMarkers, opts.effect)
      : innerTruncationRecoveryInstruction(opts.toolName, innerTruncationMarkers, opts.nestedTargetToolName);
    const agentReviewClaim = fsPath == null ? agentReviewClaimReceipt(result, opts) : undefined;
    // The claim committed before the optional scratch write. Recover the item
    // through a read, using the same receipt contract as the hard-spill path.
    const schedulerClaim = fsPath == null ? schedulerClaimReceipt(result, opts) : undefined;
    const setBlockerReceipt = fsPath == null ? workItemsSetBlockerReceipt(result, opts) : undefined;
    const releaseReceipt = fsPath == null ? workItemsReleaseReceipt(result, opts) : undefined;
    // TWO different byte streams reach a caller here, and ONE offset cannot
    // serve both — EI-21239097430071791 followed this cursor exactly as written
    // and landed mid-body, because the offset was measured against a stream the
    // caller was never handed:
    //   * the RAW on-disk file at `cursor.args.file_path` — what shell / jq /
    //     grep users read. Its body is preceded by the scratch-reference
    //     manifest header AND the result-door prefix.
    //   * capability:read's returned `response.data` — what THIS cursor's own
    //     `next` tells the caller to fetch. read.ts strips the manifest
    //     (`bytes = parsed.payload`) BEFORE applying byte_offset, so only the
    //     result-door prefix precedes the body there.
    // The manifest header is ~450 bytes, so using the file-relative offset
    // against capability:read's payload overshoots into the middle of the JSON
    // and yields an unparseable fragment. Naming each field for the stream it
    // measures is the durable fix: a bare `bodyByteOffset` silently means the
    // wrong thing to whichever of the two audiences does not own it.
    const spillPrefixBytes = Buffer.byteLength(spillPrefix, 'utf8');
    const bodyOffsetInPayload = spillPrefixBytes;
    const bodyOffsetInFile = spillManifest == null
      ? null
      : scratchReferencePayloadByteOffset(spillManifest) + spillPrefixBytes;
    const bodyComplete = !upstreamProjection?.truncated && innerTruncationMarkers.length === 0;
    const volatileRecovery = volatileFallback
      ? volatileScratchRecovery(volatileFallback, bodyComplete, opts.toolName, spillErrorCode, spillErrorSummary)
      : undefined;
    const recovery = schedulerClaim
      ? preferVolatileScratchRecovery(volatileRecovery, schedulerClaimRecovery(schedulerClaim))
      : agentReviewClaim
        ? preferVolatileScratchRecovery(volatileRecovery, agentReviewClaimRecovery(agentReviewClaim))
      : setBlockerReceipt
        ? preferVolatileScratchRecovery(volatileRecovery, workItemsSetBlockerRecovery(setBlockerReceipt))
      : releaseReceipt
        ? preferVolatileScratchRecovery(volatileRecovery, workItemsReleaseRecovery(releaseReceipt))
      : volatileRecovery
        ? volatileScratchRecoveryForTool(volatileRecovery, opts.toolName, opts.nestedTargetToolName)
      : fsPath != null && uri != null
        ? {
            cursor: {
              kind: 'scratch-page',
              tool: 'capability:read',
              args: { file_path: fsPath, byte_offset: 0, byte_limit: 3_072 },
              maxByteLimit: CAPABILITY_READ_MAX_BYTE_PAGE,
              uri,
              // EI-20685195115158619: named `dataEncoding`, not `encoding`. Bare
              // and adjacent to `file_path`, it read as "the file at that path is
              // base64" — an agent took that reading, ran `base64 -d <path>`, got
              // `invalid input`, and burned calls. Only capability:read's response
              // `data` field is base64 (byte-window mode, read.ts); the spill FILE
              // is plaintext UTF-8, and being directly greppable/tailable is the
              // point of writing it that way. The key binds to the field it
              // describes and costs 4 chars against the budget guarded below;
              // `result-door-encoding-contract.test.ts` then follows this cursor
              // end-to-end so the declaration and the bytes cannot drift apart.
              dataEncoding: 'base64',
              // The spill is plaintext with a Markdown header (and, for
              // list-shaped results, an index) before the body, and the RAW file
              // additionally opens with the scratch-reference manifest — whose
              // `{` is the file's FIRST `{`. So the natural fallback, "start
              // parsing at the first brace", finds the MANIFEST: a well-formed
              // but WRONG object. JSON callers need the exact boundary for the
              // stream they are actually reading, never a guess.
              //
              // Emitted for EVERY valid JSON body, INCLUDING a tool-internally
              // clipped one. The prior rule withheld it whenever the tool had
              // marked field truncation (EI-21185758364267344), which treated
              // "where does the body start" as though it were "is the body
              // complete" — two orthogonal facts. That filing's actual complaint
              // was the COMPLETENESS promise, not the locator, and withholding
              // the locator never stopped anyone parsing the same bytes: it only
              // pushed them onto the first-brace fallback above, converting a
              // loud failure into a silent wrong object (EI-21208128396414381,
              // EI-21202588767992062). Completeness now travels as its own
              // machine-readable field rather than being signalled by ABSENCE,
              // which no caller can distinguish from "this door emitted nothing".
              ...(parsedJsonBody
                ? {
                    bodyOffsetInPayload,
                    ...(bodyOffsetInFile != null ? { bodyOffsetInFile } : {}),
                    ...(partialJsonBody ? { bodyComplete: false } : {}),
                  }
                : {}),
            },
            next:
              // Some callers (including Codex functions.exec) have no base64 codec.
              // The cursor points to a manifest-bearing scratch file, not the JSON body;
              // offer plaintext line windows and retain the validated byte-page path.
              `Use capability:read cursor.args (byte_offset+byte_limit; no raw). ` +
              `Plaintext: raw:true+offset/limit lines (long selected lines require byte pages). ` +
              `file_path-only truncates long lines; Scratch ref, not JSON; ` +
              `response.data canonical base64; runtime codec; decoded.length===byte_length; ` +
              `follow next_cursor; ` +
              `parse only at eof:true+next_cursor:null. ` +
              (partialJsonBody
                ? `inspect the emitted spill bytes at cursor.bodyOffsetInPayload. The source is already ` +
                  `partial (${partialJsonSource}); this JSON is partial (bodyComplete:false) and ` +
                  `paging cannot recover omitted fields. ${partialJsonReRead}`
                : parsedJsonBody
                  ? `JSON at response.data[cursor.bodyOffsetInPayload].`
                  : `the spill opens with a text header.`) +
              // Keep the JSON recovery pointer compact. The payload projector budgets
              // the pointer together with the retained JSON preview; page-integrity
              // and EOF gating are load-bearing, so the contract above is deliberately
              // terse and its bounded size is pinned by result-door-encoding-contract.test.ts.
              // Raw text needs the fuller honesty wording because its new
              // `{ text, _projection }` envelope replaced the former prose footer
              // that carried those disclosures.
              (parsedJsonBody
                ? ''
                : ` The unwrapped spill payload is plaintext. Read it through capability:read; ` +
                  `direct shell access to args.file_path can be sandbox-masked. Do not ` +
                  `\`base64 -d\` the manifest-bearing file (response.data is base64).`) +
              (parsedJsonBody || partialJsonBody
                ? ''
                : upstreamProjection
                  ? ` ⚠ This is NOT the tool's full output: it was ALREADY tier-projected upstream ` +
                    `(tier=${upstreamProjection.tier}, forced=${upstreamProjection.forced}, ` +
                    `omittedCount=${upstreamProjection.omittedCount}); paging cannot recover those omitted ` +
                  `fields. ${upstreamProjectionRecoveryInstruction(opts.toolName, opts.nestedTargetToolName, innerTruncationMarkers, opts.effect)}`
                  : innerTruncationMarkers.length > 0
                    ? ` ⚠ The TOOL ITSELF already truncated field(s) before this door ` +
                      `(${innerTruncationMarkers.join(', ')}); paging preserves what it emitted but cannot ` +
                      `recover those fields. ${innerTruncationRecoveryInstruction(opts.toolName, innerTruncationMarkers, opts.nestedTargetToolName)}`
                    : ` No upstream truncation marker was detected; that does not prove the tool emitted ` +
                      `every field in full.`) +
              buildProjectionHint(textItems, opts.toolName, bodyShape),
          }
        : {
            cursor: {
              kind: 'unavailable',
              tool: opts.toolName,
              args: {},
              reason: 'spill-write-failed',
              ...(spillErrorCode && spillErrorCode !== 'unknown error' ? { errorCode: spillErrorCode } : {}),
              ...(spillErrorSummary ? { errorDetail: spillErrorSummary } : {}),
            },
            next:
              isPlansStartCall(opts)
                ? PLANS_START_RECEIPT_RECOVERY
                : isWorkItemsCompleteCall(opts)
                ? WORK_ITEMS_COMPLETE_SPILL_RECOVERY +
                  (upstreamProjection
                    ? ` The tool also tier-projected upstream (omittedCount=${upstreamProjection.omittedCount}), ` +
                      `so those fields were never serialized either.`
                    : '')
                : isWorkItemsSetBlockerCall(opts)
                  ? WORK_ITEMS_SET_BLOCKER_SPILL_RECOVERY +
                    (upstreamProjection
                      ? ` The tool also tier-projected upstream (omittedCount=${upstreamProjection.omittedCount}), ` +
                        `so those fields were never serialized either.`
                      : '')
                : isWorkItemsReleaseCall(opts)
                  ? WORK_ITEMS_RELEASE_SPILL_RECOVERY +
                    (upstreamProjection
                      ? ` The tool also tier-projected upstream (omittedCount=${upstreamProjection.omittedCount}), ` +
                        `so those fields were never serialized either.`
                      : '')
                : isScorecardsEmitCall(opts)
                  ? SCORECARDS_EMIT_SPILL_RECOVERY +
                    ' Spill write error: ' +
                    (spillErrorCode && spillErrorCode !== 'unknown error'
                      ? spillErrorCode
                      : spillErrorSummary ?? 'unknown error') +
                    '.' +
                    (upstreamProjection
                      ? ` The tool also tier-projected upstream (omittedCount=${upstreamProjection.omittedCount}), ` +
                        `so those fields were never serialized either.`
                      : '')
                  : `The result was structurally bounded, but its spill write failed ` +
                    `(${spillErrorCode && spillErrorCode !== 'unknown error' ? spillErrorCode : spillErrorSummary ?? 'unknown error'}), ` +
                    `so the omitted bytes are NOT recoverable and no ` +
                    `spill path exists. Re-call ${opts.toolName} with narrower arguments or a projection.` +
                    (upstreamProjection
                      ? ` It was ALSO tier-projected upstream (omittedCount=${upstreamProjection.omittedCount}), ` +
                        `so those fields were never serialized either.`
                      : '') +
                    buildProjectionHint(textItems, opts.toolName, bodyShape),
          };
    // plans:get's item text is the semantic payload of the detail read, not an
    // optional identity field. Promote it through the generic fallback so a
    // deep/key-bounded result keeps the instruction the caller came to read.
    // The projector still applies its normal string/transport budgets, whose
    // in-band markers make a clipped value honest; this only prevents the field
    // from disappearing as an identity-only omission. Merge caller-selected
    // paths rather than replacing them (projection.pick remains additive).
    // Order is PRIORITY (payload-tier.ts `preservedChildRank`): the earlier path
    // wins the budget. `shipReadiness` leads because it is opt-in and default-OFF
    // — a caller only sees it by asking for it BY NAME, and its absence reads as
    // "nothing is blocking this plan", a false green on a ship gate
    // (EI-22186855527494865). `items[].text` follows: also load-bearing, but an
    // items array announces its own truncation in band, so a cut there is visible.
    const preservePaths = [
      ...(schedulerClaim ? ['ok', 'claimReceipt', 'claimReceipt.committed', 'claimReceipt.workItemId'] : []),
      ...(opts.toolName === 'rubrics:amend'
        ? ['review.state', 'review.conversationId', 'review.previewPostRef', 'review.next', 'ok', 'dryRun']
        : []),
      ...(isScorecardsGetResult(opts)
        ? [
            'scorecard.issueId',
            'scorecard.criteria[].key',
            'scorecard.criteria[].rating',
            'scorecard.criteria[].evidence',
            'evidenceRead.complete',
            'evidenceRead.scope',
            'evidenceRead.offset',
            'evidenceRead.totalChars',
            'evidenceRead.next',
            'evidenceRead.criteria',
          ]
        : []),
      ...(isScorecardsEmitCall(opts) ? scorecardsEmitPreservePaths(bodyShape.json?.parsed) : []),
      ...(opts.toolName === 'plans:get' ||
        (opts.toolName === 'tools:invoke' && opts.nestedTargetToolName === 'plans:get')
        ? ['results[].shipReadiness', 'results[].items[].text']
        : []),
      ...(opts.toolName === 'plans:bind-spec-evidence' ||
        (opts.toolName === 'tools:invoke' && opts.nestedTargetToolName === 'plans:bind-spec-evidence')
        ? PLANS_BIND_SPEC_EVIDENCE_REFUSAL_PRESERVE_PATHS
        : []),
      ...(opts.toolName === PIPELINE_POSITION_TOOL ||
        (opts.toolName === 'tools:invoke' && opts.nestedTargetToolName === PIPELINE_POSITION_TOOL)
        ? PIPELINE_POSITION_PRESERVE_PATHS
        : []),
      ...(opts.toolName === 'coord:send' ||
        (opts.toolName === 'tools:invoke' && opts.nestedTargetToolName === 'coord:send')
        ? COORD_SEND_DELIVERY_PRESERVE_PATHS
        : []),
      ...(agentReviewClaim
        ? [
            'ok', 'mode', 'claimed', 'workItem.id', 'workItem.title', 'workItem.harness',
            'ledgerIdeaId', 'gradeWith.ideaId',
          ]
        : []),
      // Exact events:status snapshots carry the only in-band identity for the
      // requested key. Preserve the success bit and event/watermark first, then
      // keep history keys selectable. Oversized arrays stay domain-only; the
      // containing envelope's partial flag and omission entry disclose the cut.
      // The scratch cursor remains the route to the complete contents.
      ...(opts.toolName === 'events:status'
        ? [
            'ok',
            'event_inspection.event',
            'event_inspection.current_generation',
            'event_inspection.current_state',
            'event_inspection.resync',
            'event_inspection.declarations',
            'event_inspection.waiters',
            'event_inspection.wake_outcomes',
          ]
        : []),
      ...(opts.toolName === 'work_items:links'
        ? [
            'coverage.selectedCount',
            'coverage.checkedCount',
            'coverage.complete',
            'coverage.linkedCount',
          ]
        : []),
      // work_items:get reports the selected/checked source set before its own
      // tier shaper, then appends a stage-labeled detail count and bounded
      // omitted-ID handles. Preserve those qualifiers through this later,
      // independent projection. Row ids/stub markers stay selectable too, so a
      // caller can reconcile inline rows or follow the spill cursor for rows
      // this door could not render.
      ...(isWorkItemsGetCall(opts)
        ? [
            'read.schemaVersion',
            'read.requested',
            'read.receiptComplete',
            'read.receiptOmitted',
            'receipt[].id',
            'receipt[].delivered',
            'receipt[].reason',
            'results[].id',
            'results[].ok',
            'results[].availability',
            // A bounded comment window is an explicitly requested continuation
            // surface. Keep its read bounds and post content ahead of the bulky
            // checkpoint projection below: otherwise one large checkpoint can
            // consume the result budget before a selected objection reaches the
            // model. These same paths are needed when the outer MCP tool is
            // `tools:invoke`; its depth-limited door must retain the nested
            // target's contract instead of reducing each post to `{id}`.
            'results[].threadWindow.total',
            'results[].threadWindow.shown',
            'results[].threadWindow.posts[].id',
            'results[].threadWindow.posts[].thread_id',
            'results[].threadWindow.posts[].author_id',
            'results[].threadWindow.posts[].body',
            'results[].threadWindow.posts[].created_ts',
            'results[].threadWindow.topics',
            'results[].threadWindow.createdAt',
            // A spill-write failure removes the recovery path for the omitted
            // bytes. Keep the checkpoint itself ahead of diagnostic bulk so a
            // continuation read still carries useful state inline; the normal
            // field clip remains marked and the full-note hash stays available.
            'results[].checkpoint',
            'results[].checkpointContentHash',
            'results[].checkpointUpdatedAtMs',
            'results[].checkpointBody',
            'results[].checkpointReadFailed',
            'results[]._stub',
            'read.available',
            'read.absent',
            'read.unavailable',
            'read.detailRows',
            'read.stubbedRows',
            '_shapeNote.stubbed.count',
            '_shapeNote.dropped',
          ]
        : []),
      // work_items:complete writes these fields before its bulky echoes, and its
      // tier shaper deliberately spreads them through unchanged. The generic
      // result-door is a later, independent projection seam, though: without an
      // explicit priority here, a multi-row completion can keep row 1/2's
      // identity while reducing a later row to `{id,ok,workItem:{_partial:true}}`.
      // That is especially dangerous for `completionAuthority:'proposed'` and
      // its two load-bearing warnings: the caller sees a close receipt but loses
      // the evidence that it is not counted and why. Keep correlation first,
      // then the authority/count verdict, then the explanatory warnings; values
      // still obey the projector's normal string and transport budgets.
      ...(isWorkItemsCompleteCall(opts)
        ? WORK_ITEMS_COMPLETE_RECEIPT_PRESERVE_PATHS
        : []),
      ...(isWorkItemsSetBlockerCall(opts)
        ? WORK_ITEMS_SET_BLOCKER_RECEIPT_PRESERVE_PATHS
        : []),
      ...(isWorkItemsReleaseCall(opts)
        ? WORK_ITEMS_RELEASE_RECEIPT_PRESERVE_PATHS
        : []),
      ...(isPlansStartCall(opts) ? PLANS_START_RECEIPT_PRESERVE_PATHS : []),
      ...(isFleetLaunchCall(opts) && bodyShape.json != null &&
        isJsonObject(bodyShape.json.parsed) && bodyShape.json.parsed.error === 'admission_refused'
        ? FLEET_ADMISSION_RECEIPT_PRESERVE_PATHS : []),
      ...(opts.preservePaths ?? []),
      // code:run's `summary` is the script's authored return value; `state` is
      // replay support added by the sandbox. The generic identity projector
      // ranks `state` ahead of ordinary fields, so a large store() value could
      // consume the whole door and erase the useful script result. Keep the
      // summary ahead of that replay state while the normal result-door budget
      // continues to bound both and the spill keeps the full response recoverable.
      ...(opts.toolName === 'code:run' ||
        (opts.toolName === 'tools:invoke' && opts.nestedTargetToolName === 'code:run')
        ? ['summary', 'summaryNotice.truncated', 'summaryNotice.rawSummaryCursor']
        : []),
    ];
    const structuralProjectionWarning = extractStructuralProjectionWarning(result, textItems, jsonItemIndex);
    // The warning is a separate model-facing content item, so reserve its
    // UTF-8 bytes before asking the generic projector to fill the result door.
    // Without this reservation, preserving the warning can make the combined
    // result exceed the same cap this branch is enforcing.
    const structuralTargetChars = Math.max(
      1_500,
      budgetChars -
        (structuralProjectionWarning ? Buffer.byteLength(structuralProjectionWarning, 'utf8') : 0),
    );
    const evaluatorCompactBody =
      parsedJsonBody && opts.toolName === SPEC_TEST_ADEQUACY_TOOL
        ? compactSpecTestAdequacyBody(bodyShape.json!.parsed)
        : null;
    const scorecardsEmitCompactBody =
      parsedJsonBody && isScorecardsEmitCall(opts)
        ? compactScorecardsEmitBody(bodyShape.json!.parsed)
        : null;
    // Full fleet indexes can outgrow even the domain emergency shaper. The
    // source body has already been spilled above; retain the atomic numeric
    // contract inline instead of walking early obligation fields until the
    // generic budget runs out before it encounters the queue metrics.
    const leaderBriefCore = parsedJsonBody &&
      (opts.toolName === 'fleet:leader-brief' || opts.nestedTargetToolName === 'fleet:leader-brief') &&
      recovery?.cursor
      ? compactLeaderBriefForResultDoor(bodyShape.json!.parsed)
      : null;
    const leaderBriefPreview = leaderBriefCore ? {
      ...leaderBriefCore,
      _partial: true,
      _projection: {
        kind: 'bounded-payload', truncated: true, tier: 'trimmed', forced: true,
        originalChars: totalChars, cursor: recovery!.cursor,
        next: 'Page this cursor for the emitted snapshot, including all indexes and secondary metrics.',
      },
    } : null;
    const leaderBriefFits = leaderBriefPreview !== null &&
      Buffer.byteLength(JSON.stringify(leaderBriefPreview), 'utf8') <= structuralTargetChars;
    let projected: JsonObject = leaderBriefFits ? leaderBriefPreview! : projectBoundedPayload(
      scorecardsEmitCompactBody ?? evaluatorCompactBody ?? releaseReceipt?.body ?? setBlockerReceipt?.body ??
        (parsedJsonBody ? bodyShape.json!.parsed : { text: fullText }),
      {
      toolName: opts.toolName,
      // `work_items:get` is the continuity read. If its spill cannot be
      // written, a trimmed 800-character string ceiling can leave too little
      // of the checkpoint to resume safely. The same transport target still
      // caps the whole response; the standard string ceiling only reallocates
      // that bounded space to the explicitly preserved checkpoint path.
      tier: isWorkItemsGetCall(opts) ? 'standard' : 'trimmed',
      forced: true,
      originalChars: totalChars,
      targetChars: structuralTargetChars,
      recovery,
      // The generic payload-tier projection wraps arrays so its `_projection`
      // metadata can survive JSON serialization. At this model-facing door the
      // source tool's top-level shape is part of its contract (notably
      // work_items:list), so keep an array root while retaining the metadata
      // out-of-band for this process and in `_meta.resultDoor` below.
      preserveArrayRoot: parsedJsonBody && Array.isArray(bodyShape.json!.parsed),
      // This door retains the containing envelope, omission counts and spill
      // cursor. Keep nested arrays iterable as domain rows; bare array roots
      // still carry their own marker because they have no containing object.
      arrayTruncation: 'envelope',
      // These roots contain model-facing state that cannot be reconstructed
      // from the generic identity fields. Keep them visible even if
      // projection metadata forces the final identity-only fallback;
      // ordinary tools retain the generic behavior.
      ...(scorecardsEmitCompactBody != null
        ? { preserveTopLevelKeys: ['ok', 'committed', 'completionReceipt', 'created', 'issueId', 'previousIssueId', 'canonicalRatings'] as const }
        : opts.toolName === 'coord:orient'
        ? { preserveTopLevelKeys: ['self', 'recovery'] as const }
        : opts.toolName === 'events:status'
          ? { preserveTopLevelKeys: ['ok', 'event_inspection'] as const }
          : schedulerClaim
            ? { preserveTopLevelKeys: ['ok', 'claimReceipt'] as const }
            : agentReviewClaim
              ? { preserveTopLevelKeys: ['ok', 'mode', 'claimed', 'workItem', 'ledgerIdeaId', 'gradeWith'] as const }
              : {}),
      ...(isWorkItemsCompleteCall(opts)
        ? { preserveTopLevelKeys: ['ok', 'counts', 'results'] as const }
        : isWorkItemsSetBlockerCall(opts)
          ? { preserveTopLevelKeys: ['ok', 'counts', 'results'] as const }
          : isWorkItemsReleaseCall(opts)
            ? { preserveTopLevelKeys: ['ok', 'counts', 'results'] as const }
        : {}),
      ...(evaluatorCompactBody == null && preservePaths.length > 0 ? { preservePaths } : {}),
      bulkEnvelope: opts.bulkEnvelope,
    });
    if (isScorecardsGetResult(opts) && parsedJsonBody && evaluatorCompactBody == null) {
      repairScorecardsGetProjection(bodyShape.json!.parsed, projected);
    }
    if (parsedJsonBody && (opts.toolName === 'tools:find' ||
      (opts.toolName === 'tools:invoke' && opts.nestedTargetToolName === 'tools:find'))) {
      repairDiscoverySchemaProjection(bodyShape.json!.parsed, projected, structuralTargetChars);
    }
    if (isWorkItemsGetCall(opts)) {
      projected = reconcileWorkItemsGetReceipt(bodyShape.json?.parsed, projected);
    }
    const structuralText = JSON.stringify(projected);
    let inserted = false;
    const structuralContent: Array<{ type: 'text'; text: string } | Record<string, unknown>> = [];
    for (const item of items) {
      if (isTextItem(item)) {
        if (!inserted) {
          structuralContent.push({ type: 'text', text: structuralText });
          inserted = true;
        }
      } else {
        structuralContent.push(item as Record<string, unknown>);
      }
    }
    if (structuralProjectionWarning) {
      // Degraded projection verdicts are intentionally kept ahead of the
      // structural JSON so a caller cannot mistake a fail-open body for a
      // successful selection. Ordinary advisory text remains spill-only.
      structuralContent.unshift({ type: 'text', text: structuralProjectionWarning });
    }
    return {
      ...result,
      _meta: {
        ...(result._meta ?? {}),
        resultDoor: {
          ...baseResultDoorMeta,
          structural: true,
          ...(leaderBriefFits ? { compactProjection: 'fleet:leader-brief-numeric-core' } : {}),
      ...(scorecardsEmitCompactBody != null
            ? { compactProjection: 'scorecards-emit:canonical-ratings' }
            : evaluatorCompactBody != null
            ? { compactProjection: 'evaluator-specific:plans:evaluate-spec-test-adequacy' }
            : {}),
          recoveryCursor: recovery.cursor,
        },
      },
      content: structuralContent,
      // EI-20335562969900283: `structuredContent` is the schema-bearing MCP
      // payload, not a second copy of the model-facing text body. Replacing it
      // with `projected` can violate the declared outputSchema after a generic
      // projection omits rows/required fields. Preserve it byte-for-byte; only
      // model-facing text is subject to this context door.
    } as T;
  } catch {
    return result; // fail-soft: never let the door break a good result
  }
}
