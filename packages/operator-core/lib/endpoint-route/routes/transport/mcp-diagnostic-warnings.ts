/**
 * Pure MCP result diagnostics shared by the HTTP route and direct probes.
 *
 * Keep this module free of the MCP host, operator tool registry, database, and
 * timers. Helper consumers (including tsx boot guards) must be able to import
 * and invoke it in a one-shot process without starting host infrastructure.
 */
import { parseMcpToolText } from './mcp-result-text';
import { OUTPUT_ENVELOPE_SCHEMA_VERSION } from '../../../output-envelope';

export type McpCallResult = {
  content: Array<{ type: 'text'; text: string } | Record<string, unknown>>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  structuredContent?: unknown;
};

export interface McpDiagnosticContext {
  workspaceId: string;
  workspaceResolution?: 'registry-fallback';
  dataPlaneDegradedAtMs?: number;
}

function withMcpDiagnosticWarning<T extends McpCallResult>(
  result: T,
  jsonKey: string,
  metaKey: string,
  warning: string,
): T {
  const content = Array.isArray(result.content) ? result.content : [];
  const first = content[0];
  if (first && 'type' in first && first.type === 'text' && typeof (first as { text?: unknown }).text === 'string') {
    try {
      const parsed: unknown = JSON.parse((first as { text: string }).text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        (parsed as Record<string, unknown>)[jsonKey] = warning;
        return {
          ...result,
          content: [{ type: 'text' as const, text: JSON.stringify(parsed) }, ...content.slice(1)],
        };
      }
    } catch {
      /* non-JSON text content (or a malformed body) — fall through to _meta */
    }
  }
  return { ...result, _meta: { ...(result._meta ?? {}), [metaKey]: warning } };
}

function hasPopulatedMcpResult(result: McpCallResult): boolean {
  // Output-schema tools can carry their populated result only in structuredContent.
  // The text projection may be absent, truncated, or use a separate content block;
  // none of those should make a successful read look empty during a proxy warning.
  if (result.structuredContent !== undefined && hasPopulatedMcpResultValue(result.structuredContent)) {
    return true;
  }

  const content = Array.isArray(result.content) ? result.content : [];
  for (const block of content) {
    if (!('type' in block) || block.type !== 'text' || typeof block.text !== 'string') continue;
    let parsed: unknown;
    try {
      parsed = parseMcpToolText(block.text);
    } catch {
      continue;
    }
    if (hasPopulatedMcpResultValue(parsed)) return true;
  }
  return false;
}

function isPopulatedGitEvidenceResult(body: Record<string, unknown>): boolean {
  if (body.ok !== true) return false;

  if (body.op === 'isAncestor') {
    return typeof body.ancestorSha === 'string' &&
      body.ancestorSha.trim().length > 0 &&
      typeof body.descendantSha === 'string' &&
      body.descendantSha.trim().length > 0 &&
      typeof body.isAncestor === 'boolean';
  }

  if (
    body.op !== 'readFileAtCommit' ||
    typeof body.commitSha !== 'string' ||
    body.commitSha.trim().length === 0 ||
    typeof body.path !== 'string' ||
    body.path.trim().length === 0
  ) {
    return false;
  }

  if (
    typeof body.bytes === 'number' &&
    Number.isSafeInteger(body.bytes) &&
    body.bytes >= 0 &&
    typeof body.content === 'string'
  ) {
    return true;
  }

  return body.encoding === 'base64' &&
    typeof body.byte_offset === 'number' && Number.isSafeInteger(body.byte_offset) && body.byte_offset >= 0 &&
    typeof body.byte_length === 'number' && Number.isSafeInteger(body.byte_length) && body.byte_length >= 0 &&
    typeof body.total_bytes === 'number' && Number.isSafeInteger(body.total_bytes) && body.total_bytes >= 0 &&
    typeof body.eof === 'boolean' &&
    typeof body.data === 'string' &&
    'next_cursor' in body;
}

function isPopulatedWorkItemParkResult(body: Record<string, unknown>): boolean {
  // work_items:park returns a lifecycle receipt rather than a generic results array. Its
  // booleans are domain outcomes, not evidence that the result is empty: the item id,
  // checkpoint size, release/note outcomes, and actor identify the completed park attempt.
  return body.ok === true &&
    typeof body.id === 'string' && body.id.trim().length > 0 &&
    typeof body.checkpointChars === 'number' && Number.isSafeInteger(body.checkpointChars) && body.checkpointChars >= 0 &&
    typeof body.released === 'boolean' &&
    typeof body.noted === 'boolean' &&
    typeof body.by === 'string' && body.by.trim().length > 0;
}

function isPopulatedCapabilityReadResult(body: Record<string, unknown>): boolean {
  if (body.ok !== true || typeof body.file_path !== 'string' || body.file_path.trim().length === 0) {
    return false;
  }

  // `capability:read` returns exact text in `structuredContent.body`. Empty files
  // are still successful reads: the file path and declared body field prove the
  // read completed, even when the body itself has zero characters.
  if (typeof body.body === 'string') return true;

  // The remaining machine-readable modes have explicit receipts around their
  // selected bytes/content. Preserve empty byte pages and empty selections too;
  // their offsets/counts are authoritative, unlike an unshaped empty result.
  if (
    body.encoding === 'base64' &&
    typeof body.byte_offset === 'number' && Number.isSafeInteger(body.byte_offset) && body.byte_offset >= 0 &&
    typeof body.byte_length === 'number' && Number.isSafeInteger(body.byte_length) && body.byte_length >= 0 &&
    typeof body.total_bytes === 'number' && Number.isSafeInteger(body.total_bytes) && body.total_bytes >= 0 &&
    typeof body.eof === 'boolean' &&
    typeof body.data === 'string' &&
    'next_cursor' in body
  ) return true;

  if (
    Array.isArray(body.content) &&
    Array.isArray(body.selected_indexes) &&
    typeof body.total_content_items === 'number' && Number.isSafeInteger(body.total_content_items) &&
    body.total_content_items >= 0 &&
    body.reference !== null && typeof body.reference === 'object'
  ) return true;

  return Array.isArray(body.evidence) &&
    typeof body.evidence_class === 'string' &&
    body.reference !== null && typeof body.reference === 'object';
}

function hasPopulatedMcpResultValue(parsed: unknown): boolean {
  if (Array.isArray(parsed)) return parsed.length > 0;
  if (!parsed || typeof parsed !== 'object') return false;

  const body = parsed as Record<string, unknown>;
  if (body.authoritative === true) return true;
  if (body.notFound === true || body.not_found === true || body.missing === true) return false;
  if (typeof body.status === 'string' && body.status.replace(/[-\s]/g, '_').toLowerCase() === 'not_found') return false;
  if (typeof body.code === 'string' && body.code.replace(/[-\s]/g, '_').toLowerCase() === 'not_found') return false;
  // capability:git-evidence reports authoritative values in operation-specific fields;
  // empty files and a negative ancestry result are still successful, populated reads.
  if (isPopulatedGitEvidenceResult(body)) return true;
  if (isPopulatedWorkItemParkResult(body)) return true;
  if (isPopulatedCapabilityReadResult(body)) return true;
  // code:run wraps the script's returned summary with orchestration metadata instead of a
  // conventional `results` field. Only recognize this distinctive successful envelope, then
  // classify the summary itself so an empty script result still keeps the warning.
  if (
    body.ok === true &&
    typeof body.dryRun === 'boolean' &&
    typeof body.dispatchCount === 'number' && Number.isFinite(body.dispatchCount) && body.dispatchCount >= 0 &&
    typeof body.intermediateBytes === 'number' && Number.isFinite(body.intermediateBytes) && body.intermediateBytes >= 0 &&
    Array.isArray(body.logs) &&
    'summary' in body
  ) {
    return hasPopulatedCodeRunSummary(body.summary);
  }
  const completionReceipt = body.completionReceipt;
  if (
    body.ok === true &&
    completionReceipt &&
    typeof completionReceipt === 'object' &&
    !Array.isArray(completionReceipt) &&
    (completionReceipt as Record<string, unknown>).status === 'recorded' &&
    typeof (completionReceipt as Record<string, unknown>).effectRef === 'string' &&
    ((completionReceipt as Record<string, unknown>).effectRef as string).trim().length > 0
  ) {
    return true;
  }
  if (Array.isArray(body.entries) && body.entries.length > 0) return true;
  // The result door moves large, intact payloads behind a typed reference envelope.
  // These have no `ok` field, so the generic success-envelope check below would
  // otherwise call a recoverable populated result empty and attach a misleading
  // data-plane warning to it.
  if (
    body.schemaVersion === OUTPUT_ENVELOPE_SCHEMA_VERSION &&
    Array.isArray(body.content) &&
    body.content.length > 0
  ) {
    return true;
  }
  if (
    typeof body.ownerId === 'string' &&
    body.ownerId.trim().length > 0 &&
    typeof body.source === 'string' &&
    body.source.trim().length > 0
  ) {
    return true;
  }
  // tools:find and testing:runs use populated top-level arrays without the legacy `{ ok: true, ... }` shape.
  if (Array.isArray(body.hits) && body.hits.length > 0) return true;
  if (Array.isArray(body.runs) && body.runs.length > 0) return true;
  // dev:pg_query returns populated query results as top-level `rows`, without `ok` or `results`.
  if (Array.isArray(body.rows) && body.rows.length > 0) return true;
  // activity:tool-log returns a nonempty row/call count instead of a result array.
  // Keep zero counts empty so a genuinely empty log still receives the warning.
  if (
    ['calls', 'rawRows'].some((key) => {
      const value = body[key];
      return typeof value === 'number' && Number.isFinite(value) && value > 0;
    })
  ) {
    return true;
  }
  // Some successful tools return their domain result without the generic `ok`
  // envelope. Explicit not-found and negative-status checks above stay
  // authoritative; recognized result fields below decide whether these bodies
  // are populated.
  if (body.ok !== true && body.ok !== undefined) return false;
  if (body.ended === true || body.verified === true) return true;
  if (
    (typeof body.await_id === 'number' && Number.isSafeInteger(body.await_id) && body.await_id > 0) ||
    (typeof body.await_id === 'string' && body.await_id.trim().length > 0)
  ) {
    return true;
  }

  let sawResultField = false;
  let hasPopulatedField = false;
  // Some successful tools return a single domain object or collection instead of a generic
  // results/items envelope (for example facts:assert -> `fact`, improvements:capture -> `issue`,
  // locks:acquire -> `held`,
  // loop:status -> `loop`, scheduler:get_claim_spec -> `spec`, scheduler:get_next -> `workItem`,
  // and events:status -> `event_inspection`).
  // Keep these explicit so control metadata alone does not suppress warnings for true empties.
  for (const key of [
    'results', 'items', 'data', 'result', 'value', 'presence', 'facts', 'hits', 'agents',
    'sessions', 'turns', 'watch', 'fact', 'issue', 'held', 'scorecard', 'scorecards', 'loop', 'spec', 'specs', 'evidence', 'rows',
    'workItem', 'event_inspection',
  ]) {
    if (!(key in body)) continue;
    sawResultField = true;
    const value = body[key];
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      hasPopulatedField ||= value.length > 0;
      continue;
    }
    if (typeof value === 'object') {
      hasPopulatedField ||= Object.keys(value as object).length > 0;
      continue;
    }
    hasPopulatedField = true;
  }
  return sawResultField && hasPopulatedField;
}

function hasPopulatedCodeRunSummary(summary: unknown): boolean {
  if (typeof summary === 'string') return summary.trim().length > 0;
  if (Array.isArray(summary)) return summary.length > 0;
  if (typeof summary === 'number') return Number.isFinite(summary) && summary > 0;
  if (typeof summary === 'boolean') return summary;
  if (!summary || typeof summary !== 'object') return false;

  const record = summary as Record<string, unknown>;
  const resultFields = [
    'results', 'items', 'data', 'result', 'value', 'presence', 'facts', 'fact', 'hits', 'agents',
    'issue', 'held', 'scorecard', 'scorecards', 'loop', 'spec', 'specs', 'evidence', 'rows',
    'workItem', 'event_inspection', 'entries', 'runs',
  ];
  if (resultFields.some((key) => key in record)) {
    return hasPopulatedMcpResult({ content: [{ type: 'text', text: JSON.stringify(record) }] });
  }

  // A code:run script may return a domain-shaped object unknown to this module. Its nonempty
  // fields are user-selected summary data; control metadata alone remains empty.
  return Object.keys(record).some((key) => !['ok', 'count', 'total', 'truncated'].includes(key));
}

export function withMcpDiagnosticWarnings<T extends McpCallResult>(result: T, spawnCtx: McpDiagnosticContext): T {
  if (!result || result.isError) return result;
  let annotated = result;
  if (spawnCtx.workspaceResolution === 'registry-fallback') {
    const warning =
      `⚠ SCOPE GUESSED, NOT VERIFIED: this session's workspace could not be resolved from an explicit ` +
      `param, header, or launch record — it was scoped to '${spawnCtx.workspaceId}' as a REGISTRY-FALLBACK ` +
      `GUESS (the box's active workspace), which can be wrong on a multi-workspace box. If this result ` +
      `looks like an unexpected empty/not-found for something you expect to exist, suspect WRONG-WORKSPACE ` +
      `SCOPING before concluding data is missing — verify independently (dev:pg_query / psql against the ` +
      `expected workspace) rather than trusting this result at face value.`;
    annotated = withMcpDiagnosticWarning(annotated, '_scopeGuessWarning', 'scopeGuessWarning', warning);
  }
  if (spawnCtx.dataPlaneDegradedAtMs && !hasPopulatedMcpResult(annotated)) {
    const observedAt = new Date(spawnCtx.dataPlaneDegradedAtMs).toISOString();
    const warning =
      `⚠ DATA PLANE MAY BE DEGRADED: this session's local MCP proxy observed an upstream retry or ` +
      `connection failure at ${observedAt}. During this short warning window, an unexpected empty/not-found ` +
      `result may be a transport symptom rather than authoritative absence. Retry or verify independently ` +
      `before concluding that data is missing.`;
    annotated = withMcpDiagnosticWarning(annotated, '_dataPlaneMayBeDegraded', 'dataPlaneMayBeDegraded', warning);
  }
  return annotated;
}
