/**
 * @papercusp/seed-bundle — the restore orchestration.
 *
 * The generic "restore-before-join" step: validate the manifest, then for each
 * store entry resolve its payload, VERIFY it, and RESTORE it. This NEVER throws
 * — it returns a per-store outcome so the host decides fallback (any not-ok
 * store ⇒ that store drops to its cold catch-up path; the others still benefit).
 * The host's live sync/join runs AFTER this and is unmodified.
 */

import { validateManifest, type SeedManifest, type SeedStoreEntry } from './manifest';
import type {
  SeedPayload,
  SeedProviderRegistry,
  SeedRestoreContext,
  SeedRestoreDiagnosticIdentity,
  SeedRestorePhase,
  SeedRestorePhaseEvent,
} from './registry';

/**
 * Process-global diagnostic slot read by the existing CDP inspector helper.
 *
 * This is deliberately a tiny, bounded observation seam rather than another
 * service or transport.  A debugger attached to the exact host process can
 * read phase transitions while a provider await is held; ordinary restore
 * callers never need to know that the slot exists.  The literal is duplicated
 * in `scripts/cdp-inspector.mjs` because that diagnostic script cannot import
 * this TypeScript package from a plain Node target.
 */
export const SEED_RESTORE_DIAGNOSTIC_SLOT = '@papercusp/seed-bundle.restore-diagnostics';

const DIAGNOSTIC_VERSION = 1;
const MAX_DIAGNOSTIC_OPERATIONS = 8;
const MAX_DIAGNOSTIC_EVENTS = 256;
let diagnosticSequence = 0;

interface DiagnosticEvent extends SeedRestorePhaseEvent {
  readonly seq: number;
  readonly at: number;
}

interface DiagnosticOperation {
  readonly id: string;
  readonly pid: number | null;
  readonly identity: SeedRestoreDiagnosticIdentity;
  readonly startedAt: number;
  readonly events: DiagnosticEvent[];
  droppedEvents: number;
  status: 'running' | 'succeeded' | 'failed';
  finishedAt: number | null;
  outcomeOk: boolean | null;
}

interface DiagnosticState {
  readonly version: number;
  readonly operations: DiagnosticOperation[];
}

function processFacts(): { pid: number | null; buildSha: string | null; script: string | null } {
  const processValue = (globalThis as unknown as { process?: { pid?: unknown; env?: Record<string, unknown>; argv?: unknown } }).process;
  const pid = typeof processValue?.pid === 'number' && Number.isInteger(processValue.pid) && processValue.pid > 0
    ? processValue.pid : null;
  const buildSha = typeof processValue?.env?.PAPERCUSP_BUILD_SHA === 'string'
    ? processValue.env.PAPERCUSP_BUILD_SHA : null;
  const argv = Array.isArray(processValue?.argv) ? processValue.argv : [];
  const script = typeof argv[1] === 'string' ? argv[1] : null;
  return { pid, buildSha, script };
}

function diagnosticId(): string {
  const randomUUID = (globalThis.crypto as { randomUUID?: () => string } | undefined)?.randomUUID;
  if (typeof randomUUID === 'function') return randomUUID.call(globalThis.crypto);
  diagnosticSequence += 1;
  return `seed-restore-${Date.now()}-${diagnosticSequence}`;
}

function diagnosticState(identity?: SeedRestoreDiagnosticIdentity): { state: DiagnosticState; operation: DiagnosticOperation } {
  const root = globalThis as unknown as Record<symbol, unknown>;
  const key = Symbol.for(SEED_RESTORE_DIAGNOSTIC_SLOT);
  let state = root[key] as DiagnosticState | undefined;
  if (!state || state.version !== DIAGNOSTIC_VERSION || !Array.isArray(state.operations)) {
    state = { version: DIAGNOSTIC_VERSION, operations: [] };
    root[key] = state;
  }
  const facts = processFacts();
  const mergedIdentity: SeedRestoreDiagnosticIdentity = {
    processInstanceId: identity?.processInstanceId ?? null,
    buildSha: identity?.buildSha ?? facts.buildSha,
    sourceSha256: identity?.sourceSha256 ?? null,
    script: identity?.script ?? facts.script,
  };
  const operation: DiagnosticOperation = {
    id: diagnosticId(), pid: facts.pid, identity: mergedIdentity,
    startedAt: Date.now(), events: [], droppedEvents: 0,
    status: 'running', finishedAt: null, outcomeOk: null,
  };
  state.operations.push(operation);
  while (state.operations.length > MAX_DIAGNOSTIC_OPERATIONS) state.operations.shift();
  return { state, operation };
}

function recordDiagnosticEvent(operation: DiagnosticOperation, event: SeedRestorePhaseEvent): void {
  if (operation.events.length >= MAX_DIAGNOSTIC_EVENTS) {
    operation.events.shift();
    operation.droppedEvents += 1;
  }
  operation.events.push({ ...event, seq: operation.events.length + operation.droppedEvents, at: Date.now() });
}

function finishDiagnostic(operation: DiagnosticOperation, ok: boolean): void {
  operation.status = ok ? 'succeeded' : 'failed';
  operation.outcomeOk = ok;
  operation.finishedAt = Date.now();
}

/** The result of restoring one store. */
export interface StoreRestoreOutcome {
  readonly kind: string;
  readonly ok: boolean;
  /** Why it failed (absent on success) — surfaced to the host's fallback logic. */
  readonly reason?: string;
}

export interface RestoreResult {
  /** True iff EVERY store restored — else the host cold-paths the failed ones. */
  readonly ok: boolean;
  readonly outcomes: readonly StoreRestoreOutcome[];
}

/** Resolves a store entry to its payload bytes/handle (fetch from the source). */
export type SeedPayloadResolver = (entry: SeedStoreEntry) => Promise<SeedPayload>;

/**
 * Restore every store in a manifest. Order-preserving; failure-isolating (one
 * store's failure never aborts the others). A store fails (with a reason) when:
 * the manifest is invalid, no provider is registered for its kind, the payload
 * resolver throws, `verify` returns not-ok, or `restore` throws.
 */
export async function restoreSeed(
  manifest: SeedManifest,
  registry: SeedProviderRegistry,
  resolvePayload: SeedPayloadResolver,
  ctx: SeedRestoreContext,
): Promise<RestoreResult> {
  const diagnostic = diagnosticState(ctx.diagnosticIdentity).operation;
  const emit = (event: Parameters<NonNullable<SeedRestoreContext['onPhase']>>[0]): void => {
    recordDiagnosticEvent(diagnostic, event);
    try {
      ctx.onPhase?.(event);
    } catch {
      // Diagnostics must never change the fail-soft restore contract.
    }
  };
  const validation = validateManifest(manifest);
  if (!validation.ok) {
    const result: RestoreResult = {
      ok: false,
      outcomes: [{ kind: '(manifest)', ok: false, reason: 'invalid manifest: ' + validation.errors.join('; ') }],
    };
    finishDiagnostic(diagnostic, result.ok);
    return result;
  }

  const outcomes: StoreRestoreOutcome[] = [];
  for (const entry of manifest.stores) {
    const provider = registry.get(entry.kind);
    if (!provider) {
      outcomes.push({ kind: entry.kind, ok: false, reason: `no provider registered for kind ${entry.kind}` });
      continue;
    }
    let phase: SeedRestorePhase = 'resolve';
    try {
      emit({ kind: entry.kind, phase, state: 'started' });
      const payload = await resolvePayload(entry);
      emit({ kind: entry.kind, phase, state: 'succeeded' });
      phase = 'verify';
      emit({ kind: entry.kind, phase, state: 'started' });
      const verdict = await provider.verify(entry, payload);
      if (!verdict.ok) {
        emit({ kind: entry.kind, phase, state: 'failed', reason: verdict.reason ?? 'unknown' });
        outcomes.push({ kind: entry.kind, ok: false, reason: `verify failed: ${verdict.reason ?? 'unknown'}` });
        continue;
      }
      emit({ kind: entry.kind, phase, state: 'succeeded' });
      phase = 'restore';
      emit({ kind: entry.kind, phase, state: 'started' });
      await provider.restore(entry, payload, ctx);
      emit({ kind: entry.kind, phase, state: 'succeeded' });
      outcomes.push({ kind: entry.kind, ok: true });
    } catch (e) {
      const reason = (e as Error).message;
      emit({ kind: entry.kind, phase, state: 'failed', reason });
      outcomes.push({ kind: entry.kind, ok: false, reason: `${phase} threw: ${reason}` });
    }
  }

  const result: RestoreResult = { ok: outcomes.every((o) => o.ok), outcomes };
  finishDiagnostic(diagnostic, result.ok);
  return result;
}
