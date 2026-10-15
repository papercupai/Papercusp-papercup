/**
 * answer-capture.ts — D-004, the loop-closer. When a question resolves, the
 * accepted answer is written back into an INDEXED knowledge surface so the NEXT
 * asker gets a SYNCHRONOUS knowledge-tier hit (coord:ask never has to interrupt
 * a peer for an already-answered question), and so the answer is not lost if the
 * original asker went idle.
 *
 * Why the memory store is the default target: coord:ask's knowledge tier queries
 * TWO surfaces — search:semantic (escalations/brainstorm/turns/decisions) + the
 * persistent memory store. Raw conversations are NOT in the search:semantic index
 * today (the plan's known coverage gap), so the loop closes ONLY through a
 * writeback into an indexed surface. The memory store is the reliable one: it is
 * the SAME store coord:ask reads, scoped by the same `harness:<slug>` /
 * `workspace:<id>` pseudo-user keys, so a captured answer is immediately
 * findable. (harness_decisions / agent-insights are valid alternative targets per
 * D-004 but are a follow-on; see the conversations plan's optional "index
 * conversations/issues" follow-up.)
 *
 * Storage rides the neutral `MemoryBackend` seam (generalize-memory-backend-
 * swappable D-003). The `mem0`/`mem0_*` wire literals are kept for surface
 * stability (the capture-target enum + result strings are agent-visible) even
 * though the store behind them is now swappable.
 *
 * Best-effort: a capture failure (store unavailable) NEVER fails the resolve —
 * the accepted answer still lives on the conversation row. We report what
 * happened so the resolver/asker can see it.
 */

import { getMemoryBackend } from '../../memory/backend';
import { activeWorkspaceId } from '../../workspace-registry';
import type { ConversationScope } from './conversations-store';

export type CaptureTarget = 'mem0' | 'none';

export interface CaptureInput {
  target: CaptureTarget;
  question: string;
  answer: string;
  scope: ConversationScope;
  harness_slug: string | null;
  /** Workspace id (for the operator-scope pseudo-user key). */
  workspace_id?: string | null;
  asker_id: string;
  resolver_id: string;
  conversation_id: string;
}

export interface CaptureResult {
  /** What actually happened: the target written, or why it didn't. */
  target: string;
  ok: boolean;
  detail?: string;
  diagnostics?: CaptureDiagnostics;
}

export interface CaptureDiagnostics {
  status: number | null;
  requestId: string | null;
  type: 'anthropic' | 'openai' | 'unknown' | null;
  classification:
    | 'rate_limited' | 'usage_limit' | 'overloaded' | 'timeout' | 'transient_io' | 'auth'
    | 'context_overflow' | 'agent_crash' | 'empty_output' | 'malformed_output' | 'permanent'
    | null;
  transport: 'anthropic-direct' | 'gateway-pool' | null;
  transportFailureCode:
    | 'ECONNREFUSED' | 'ECONNRESET' | 'ETIMEDOUT' | 'ENOTFOUND' | 'EAI_AGAIN' | 'EPIPE'
    | 'UND_ERR_CONNECT_TIMEOUT' | 'UND_ERR_HEADERS_TIMEOUT' | 'UND_ERR_BODY_TIMEOUT'
    | 'UND_ERR_SOCKET' | 'ABORT_ERR' | null;
}

const CAPTURE_DIAGNOSTIC_TYPES = new Set(['anthropic', 'openai', 'unknown']);
const CAPTURE_DIAGNOSTIC_CLASSIFICATIONS = new Set([
  'rate_limited', 'usage_limit', 'overloaded', 'timeout', 'transient_io', 'auth',
  'context_overflow', 'agent_crash', 'empty_output', 'malformed_output', 'permanent',
]);
const CAPTURE_DIAGNOSTIC_TRANSPORTS = new Set(['anthropic-direct', 'gateway-pool']);
const CAPTURE_DIAGNOSTIC_FAILURE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'ABORT_ERR',
]);

function enumOrNull(value: unknown, allowed: ReadonlySet<string>): string | null {
  return typeof value === 'string' && allowed.has(value) ? value : null;
}

function ownDataProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

export function sanitizeCaptureDiagnostics(value: unknown): CaptureDiagnostics | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const status = raw.status;
  const requestId = raw.requestId;
  const safeRequestId = typeof requestId === 'string'
    && requestId.trim().length <= 160
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(requestId.trim())
    ? requestId.trim()
    : null;
  return {
    status: typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
      ? status
      : null,
    requestId: safeRequestId,
    type: enumOrNull(raw.type, CAPTURE_DIAGNOSTIC_TYPES) as CaptureDiagnostics['type'],
    classification: enumOrNull(raw.classification, CAPTURE_DIAGNOSTIC_CLASSIFICATIONS) as CaptureDiagnostics['classification'],
    transport: enumOrNull(raw.transport, CAPTURE_DIAGNOSTIC_TRANSPORTS) as CaptureDiagnostics['transport'],
    transportFailureCode: enumOrNull(raw.transportFailureCode, CAPTURE_DIAGNOSTIC_FAILURE_CODES) as CaptureDiagnostics['transportFailureCode'],
  };
}

function captureDiagnosticsFromError(error: unknown): CaptureDiagnostics | undefined {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    const diagnostics = sanitizeCaptureDiagnostics(ownDataProperty(current, 'diagnostics'));
    if (diagnostics) return diagnostics;
    current = ownDataProperty(current, 'cause');
  }
  return undefined;
}

/**
 * The memory-pool key a captured answer is written under, mirroring
 * memory:remember's scoping so coord:ask's memory read (which fans out over the
 * same keys) finds it:
 *   harness scope   → `harness:<slug>`
 *   operator scope  → `workspace:<workspace_id>`
 *
 * Pure: the caller (captureResolvedAnswer) resolves a CONCRETE workspaceId
 * (activeWorkspaceId() when not threaded) BEFORE calling — never a silent 'default'
 * here, which mixed captured answers across the WI-148 workspace split (D-003).
 */
export function captureMem0Key(scope: ConversationScope, harnessSlug: string | null, workspaceId: string): string {
  if (scope === 'harness' && harnessSlug) return `harness:${harnessSlug}`;
  return `workspace:${workspaceId}`;
}

export async function captureResolvedAnswer(input: CaptureInput): Promise<CaptureResult> {
  if (input.target === 'none') {
    return { target: 'none', ok: true, detail: 'capture skipped by resolver' };
  }

  // A blank question would write a malformed `Q: \nA: …` entry whose empty
  // question stem can never match a future semantic search — worse than not
  // capturing at all. Skip it (best-effort: the answer still lives on the
  // conversation row, so nothing is lost).
  if (!input.question.trim()) {
    return { target: 'mem0_blank_question', ok: false, detail: 'blank question; nothing to index — answer kept on the conversation row only' };
  }

  // target === 'mem0' (the persistent memory store, whichever backend serves it)
  const backend = getMemoryBackend();
  let available = false;
  try {
    available = (await backend.available()).ok;
  } catch {
    available = false;
  }
  if (!available) {
    return { target: 'mem0_unavailable', ok: false, detail: 'memory store unavailable; answer kept on the conversation row only' };
  }

  // Resolve the workspace for the operator-scope cache key — never a silent 'default'
  // (which mixed captured answers across the WI-148 workspace split). The asker's
  // ask-knowledge-tier reads under the SAME activeWorkspaceId()-resolved key (D-003).
  const workspaceId = (input.workspace_id ?? '').trim() || activeWorkspaceId();
  const scopeKey = captureMem0Key(input.scope, input.harness_slug, workspaceId);
  // Store as a Q→A fact so a semantic search on a paraphrase of the question
  // surfaces the answer. Anchor it to the source conversation for provenance.
  const content = `Q: ${input.question.trim()}\nA: ${input.answer.trim()}`;
  const metadata: Record<string, unknown> = {
    scope: input.scope === 'harness' ? 'harness' : 'workspace',
    source: 'conversation',
    conversation_id: input.conversation_id,
    resolved_by: input.resolver_id,
    asked_by: input.asker_id,
  };
  if (input.scope === 'harness' && input.harness_slug) metadata.harness_slug = input.harness_slug;
  metadata.workspace_id = workspaceId;

  try {
    const res = await backend.remember(content, { scope: scopeKey, kind: 'project', metadata });
    // A resolved promise is NOT proof of storage: mem0 swallows its LLM
    // extraction failures internally and resolves with zero events (EI-25).
    // Report an honest failure so the resolver knows the loop did not close —
    // a false "captured ok" is worse than a visible miss.
    const stored = res.storedEvents ?? res.ids.length;
    if (stored === 0) {
      return {
        target: 'mem0_no_store',
        ok: false,
        detail:
          'memory backend resolved but persisted nothing (extraction failed or declined — check the operator log); answer kept on the conversation row only',
      };
    }
    return { target: `mem0:${scopeKey}`, ok: true };
  } catch (err) {
    const diagnostics = captureDiagnosticsFromError(err);
    return {
      target: 'mem0_error',
      ok: false,
      detail: (err as Error).message,
      ...(diagnostics ? { diagnostics } : {}),
    };
  }
}
