/**
 * P-001 / R-1 of change-provenance-and-admission-throughput-2026-10-27: an admission DRY RUN never
 * outlives the MCP call that asked for it.
 *
 * A `release:repair-queue { op:'admit' }` dry run (no `confirm`) is a read-only preview that can
 * take minutes: a 9-path whole-blob preview took 164 s, and an identical one was cut off by the
 * MCP proxy's 120 s limit with no reply, so the verdict was simply lost. Confirmed admits already
 * hand their slow R6 pre-check to a managed worker (`admission-fix-precheck-managed.ts`); this
 * module does the same for the preview, in-process:
 *
 *   - the preview starts immediately and races an inline budget (< 60 s, well under the proxy);
 *   - finishing inside the budget returns the verdict INLINE exactly as before, with no write;
 *   - outlasting it returns a preview-operation HANDLE; the preview keeps running, and when it
 *     settles its bounded verdict is persisted and `release:repair-queue:admit-preview-settled:<id>`
 *     is emitted. `release:repair-queue { op:'get', previewOperationId }` reads the settled verdict.
 *
 * Store: a sibling key `admission_previews` on the SAME `harness_shared.routines` row that holds
 * `repair_queue` (no new table). It is written with its own `jsonb_set`, never through the queue
 * writer, so a preview never bumps `repair_queue.updatedAtMs`: the expected-identity tuple the
 * preview hands back for the later `confirm:true` stays valid, and a preview write can never CAS-race
 * a confirmed admission. The key keeps only the newest {@link ADMISSION_PREVIEW_MAX_OPERATIONS}.
 *
 * A host restart while a preview runs leaves its record `running`; readers see it as `expired`
 * once `expiresAtMs` passes (see {@link describeAdmissionPreviewOperation}), never as pending forever.
 */
import { randomUUID } from 'node:crypto';
import type { GateVerdictTarget } from './gate-verdict-target';

/** Inline budget for a dry run. Must stay under 60 s (R-1) and well under the proxy's 120 s cut. */
export const ADMISSION_PREVIEW_INLINE_BUDGET_MS = 45_000;
/** A preview still `running` after this is reported `expired` (its host most likely died). */
export const ADMISSION_PREVIEW_OPERATION_TTL_MS = 15 * 60_000;
/** Upper bound on one stored verdict; a larger verdict keeps its scalar decision fields only. */
export const ADMISSION_PREVIEW_MAX_STORED_BYTES = 48 * 1024;
/** Operations kept on the routine row; older ones are pruned on each write. */
export const ADMISSION_PREVIEW_MAX_OPERATIONS = 20;
export const ADMISSION_PREVIEW_SETTLED_EVENT_PREFIX = 'release:repair-queue:admit-preview-settled:';

export type AdmissionPreviewStatus = 'running' | 'settled' | 'failed';

export interface AdmissionPreviewOperation {
  schemaVersion: 1;
  operationId: string;
  status: AdmissionPreviewStatus;
  startedAtMs: number;
  expiresAtMs: number;
  settledAtMs: number | null;
  /** The admit `paths` the preview was asked about, for a reader matching handle to request. */
  paths: string[];
  /** The dry run's own result payload (bounded); null while running or after a failure. */
  verdict: unknown;
  verdictTruncated: boolean;
  /** The failure message when `status === 'failed'`. */
  error: string | null;
}

export interface AdmissionPreviewStore {
  put(operation: AdmissionPreviewOperation): Promise<void>;
  get(operationId: string): Promise<AdmissionPreviewOperation | null>;
}

export type AdmissionPreviewOutcome<T> =
  | { mode: 'inline'; result: T }
  | {
      mode: 'deferred';
      /** The `running` record as written (the handle is `operation.operationId`). */
      operation: AdmissionPreviewOperation;
      /** False when the `running` record could not be written; the settle write is still tried. */
      persisted: boolean;
      persistError?: string;
      /** Resolves with the final record once it has been written and the event emitted. */
      settlement: Promise<AdmissionPreviewOperation>;
    };

export interface RunAdmissionPreviewOperationOptions<T> {
  run: () => Promise<T>;
  store: AdmissionPreviewStore;
  emitSettled: (operation: AdmissionPreviewOperation) => Promise<void>;
  paths: readonly string[];
  inlineBudgetMs?: number;
  ttlMs?: number;
  now?: () => number;
  operationId?: string;
  /** Maps the run's result to the payload stored as the verdict (default: the result itself). */
  toVerdict?: (result: T) => unknown;
  /** Background settle-path failures (store/emit) — they must never become unhandled rejections. */
  onBackgroundError?: (error: unknown, stage: 'store' | 'emit' | 'verdict') => void;
}

type Race<T> = { kind: 'done'; result: T } | { kind: 'error'; error: unknown } | { kind: 'budget' };

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function runAdmissionPreviewOperation<T>(
  opts: RunAdmissionPreviewOperationOptions<T>,
): Promise<AdmissionPreviewOutcome<T>> {
  const budget = opts.inlineBudgetMs ?? ADMISSION_PREVIEW_INLINE_BUDGET_MS;
  if (!(budget > 0 && budget < 60_000)) {
    throw new RangeError(`admission preview inline budget must be in (0, 60000) ms, got ${budget}`);
  }
  const now = opts.now ?? Date.now;
  const report = opts.onBackgroundError ?? ((error: unknown, stage: string) => {
    console.warn(`[release:repair-queue] admission preview ${stage} failed: ${message(error)}`);
  });
  const startedAtMs = now();
  const outcome: Promise<Race<T>> = Promise.resolve()
    .then(() => opts.run())
    .then(
      (result) => ({ kind: 'done' as const, result }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budgetElapsed = new Promise<Race<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'budget' }), budget);
  });
  const first = await Promise.race([outcome, budgetElapsed]);
  clearTimeout(timer);
  if (first.kind === 'done') return { mode: 'inline', result: first.result };
  if (first.kind === 'error') throw first.error;

  const running: AdmissionPreviewOperation = {
    schemaVersion: 1,
    operationId: opts.operationId ?? `arp-${randomUUID()}`,
    status: 'running',
    startedAtMs,
    expiresAtMs: startedAtMs + (opts.ttlMs ?? ADMISSION_PREVIEW_OPERATION_TTL_MS),
    settledAtMs: null,
    paths: [...opts.paths],
    verdict: null,
    verdictTruncated: false,
    error: null,
  };
  let persisted = true;
  let persistError: string | undefined;
  try {
    await opts.store.put(running);
  } catch (error) {
    persisted = false;
    persistError = message(error);
  }
  // Chained after the `running` write, so a settle can never be overwritten by it.
  const settlement = outcome.then(async (settled) => {
    let final: AdmissionPreviewOperation;
    if (settled.kind === 'done') {
      let bounded: BoundedVerdict;
      try {
        bounded = boundAdmissionPreviewVerdict(opts.toVerdict ? opts.toVerdict(settled.result) : settled.result);
      } catch (error) {
        report(error, 'verdict');
        bounded = { verdict: null, verdictTruncated: true };
      }
      final = { ...running, status: 'settled', settledAtMs: now(), ...bounded };
    } else {
      final = { ...running, status: 'failed', settledAtMs: now(), error: message(settled.kind === 'error' ? settled.error : 'unknown') };
    }
    try {
      await opts.store.put(final);
    } catch (error) {
      report(error, 'store');
    }
    try {
      await opts.emitSettled(final);
    } catch (error) {
      report(error, 'emit');
    }
    return final;
  });
  return {
    mode: 'deferred',
    operation: running,
    persisted,
    ...(persistError !== undefined ? { persistError } : {}),
    settlement,
  };
}

export interface BoundedVerdict {
  verdict: unknown;
  verdictTruncated: boolean;
}

const SCALAR_STRING_CAP = 2_000;

/**
 * Keep a stored verdict under {@link ADMISSION_PREVIEW_MAX_STORED_BYTES}. An oversized object keeps
 * its scalar top-level fields (verdict, reason, judgedSha, …: the decision a caller acts on) and
 * names what it dropped, so truncation is visible on the record instead of silent.
 */
export function boundAdmissionPreviewVerdict(
  value: unknown,
  maxBytes: number = ADMISSION_PREVIEW_MAX_STORED_BYTES,
): BoundedVerdict {
  const serialized = JSON.stringify(value ?? null);
  if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) {
    return { verdict: JSON.parse(serialized) as unknown, verdictTruncated: false };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      verdict: { _truncated: { originalBytes: Buffer.byteLength(serialized, 'utf8'), omittedKeys: [] } },
      verdictTruncated: true,
    };
  }
  const kept: Record<string, unknown> = {};
  const omittedKeys: string[] = [];
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    if (field === null || typeof field === 'boolean' || typeof field === 'number') kept[key] = field;
    else if (typeof field === 'string') kept[key] = field.length > SCALAR_STRING_CAP ? `${field.slice(0, SCALAR_STRING_CAP)}…` : field;
    else omittedKeys.push(key);
  }
  kept._truncated = { originalBytes: Buffer.byteLength(serialized, 'utf8'), omittedKeys };
  return { verdict: kept, verdictTruncated: true };
}

/** Fail-soft parse of a stored record: a malformed entry reads as absent, never as a verdict. */
export function parseAdmissionPreviewOperation(raw: unknown): AdmissionPreviewOperation | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const status = r.status;
  if (
    typeof r.operationId !== 'string' ||
    (status !== 'running' && status !== 'settled' && status !== 'failed') ||
    typeof r.startedAtMs !== 'number' ||
    typeof r.expiresAtMs !== 'number'
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    operationId: r.operationId,
    status,
    startedAtMs: r.startedAtMs,
    expiresAtMs: r.expiresAtMs,
    settledAtMs: typeof r.settledAtMs === 'number' ? r.settledAtMs : null,
    paths: Array.isArray(r.paths) ? r.paths.filter((p): p is string => typeof p === 'string') : [],
    verdict: r.verdict ?? null,
    verdictTruncated: r.verdictTruncated === true,
    error: typeof r.error === 'string' ? r.error : null,
  };
}

export type AdmissionPreviewReadStatus = AdmissionPreviewStatus | 'expired';

export interface AdmissionPreviewRead {
  operation: AdmissionPreviewOperation;
  /** `expired` = still `running` past `expiresAtMs`: its host most likely died; re-run the dry run. */
  status: AdmissionPreviewReadStatus;
  /** The repair head the settled verdict judged, when the verdict names one. */
  judgedSha: string | null;
  /** True when the queue's repair head has moved since the verdict was computed. */
  stale: boolean | null;
  nextAction: string;
}

export function describeAdmissionPreviewOperation(
  operation: AdmissionPreviewOperation,
  ctx: { nowMs: number; currentRepairHead: string | null },
): AdmissionPreviewRead {
  const status: AdmissionPreviewReadStatus =
    operation.status === 'running' && ctx.nowMs > operation.expiresAtMs ? 'expired' : operation.status;
  const verdict = operation.verdict as { judgedSha?: unknown } | null;
  const judgedSha = verdict && typeof verdict.judgedSha === 'string' ? verdict.judgedSha : null;
  const stale = judgedSha && ctx.currentRepairHead ? judgedSha !== ctx.currentRepairHead : null;
  const nextAction =
    status === 'running'
      ? `Still running. Await ${ADMISSION_PREVIEW_SETTLED_EVENT_PREFIX}${operation.operationId} (or re-read this op:get) instead of re-issuing the dry run.`
      : status === 'expired'
        ? 'The preview never settled before its expiry (its host most likely restarted). Re-run the dry run.'
        : status === 'failed'
          ? 'The preview failed; read `error`, then re-run the dry run.'
          : stale
            ? 'The repair head moved after this verdict was computed. Re-run the dry run before confirming.'
            : 'Settled. If the verdict is a pass, confirm with the expected-identity tuple it carries.';
  return { operation, status, judgedSha, stale, nextAction };
}

/** The response body for a deferred dry run, so every caller gets the same handle contract. */
export function deferredAdmissionPreviewPayload(
  outcome: Extract<AdmissionPreviewOutcome<unknown>, { mode: 'deferred' }>,
  inlineBudgetMs: number,
): Record<string, unknown> {
  const { operation } = outcome;
  return {
    ok: true,
    op: 'admit',
    dryRun: true,
    admitted: false,
    verdict: 'preview-running',
    previewOperation: {
      operationId: operation.operationId,
      status: operation.status,
      startedAtMs: operation.startedAtMs,
      expiresAtMs: operation.expiresAtMs,
      settleEvent: `${ADMISSION_PREVIEW_SETTLED_EVENT_PREFIX}${operation.operationId}`,
      persisted: outcome.persisted,
      ...(outcome.persistError ? { persistError: outcome.persistError } : {}),
    },
    nextAction: {
      tool: 'release:repair-queue',
      args: { op: 'get', previewOperationId: operation.operationId },
    },
    detail:
      `The read-only preview is still running after ${inlineBudgetMs}ms, so it continues in the background ` +
      'instead of holding this call. Await the settle event (events:await) or read ' +
      "release:repair-queue { op:'get', previewOperationId } for the settled verdict. Nothing was admitted.",
  };
}

type SqlUnsafe = (query: string, params: unknown[]) => Promise<unknown>;

const ROUTINE_ROW_FILTER =
  "workspace_id = $1 AND install_slug = $2 AND target_role = 'system:green-checkpoint'";

/**
 * The PG store: `metadata.admission_previews.<operationId>` on the green-checkpoint routine row.
 * Pruning to the newest N happens in the same statement as the write.
 */
export function createRoutineMetadataAdmissionPreviewStore(
  target: Pick<GateVerdictTarget, 'workspaceId' | 'installSlug'>,
  deps: { sql?: SqlUnsafe; maxOperations?: number } = {},
): AdmissionPreviewStore {
  const sqlFn = async (): Promise<SqlUnsafe> => {
    if (deps.sql) return deps.sql;
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    return (query, params) => sql.unsafe(query, params as never[]) as Promise<unknown>;
  };
  const maxOperations = deps.maxOperations ?? ADMISSION_PREVIEW_MAX_OPERATIONS;
  return {
    async put(operation) {
      const sql = await sqlFn();
      const rows = (await sql(
        `UPDATE harness_shared.routines
            SET metadata = jsonb_set(
                  COALESCE(metadata, '{}'::jsonb),
                  '{admission_previews}',
                  COALESCE((
                    SELECT jsonb_object_agg(e.key, e.value)
                      FROM (
                        SELECT key, value
                          FROM jsonb_each(
                                 COALESCE(metadata->'admission_previews', '{}'::jsonb)
                                 || jsonb_build_object($3::text, $4::jsonb))
                         ORDER BY (value->>'startedAtMs')::bigint DESC NULLS LAST
                         LIMIT $5
                      ) e
                  ), '{}'::jsonb),
                  true)
          WHERE ${ROUTINE_ROW_FILTER}
          RETURNING true AS written`,
        [target.workspaceId, target.installSlug, operation.operationId, JSON.stringify(operation), maxOperations],
      )) as unknown[];
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error(
          `no green-checkpoint routine row for ${target.workspaceId}/${target.installSlug}; preview operation not stored`,
        );
      }
    },
    async get(operationId) {
      const sql = await sqlFn();
      const rows = (await sql(
        `SELECT metadata->'admission_previews'->$3::text AS operation
           FROM harness_shared.routines
          WHERE ${ROUTINE_ROW_FILTER}`,
        [target.workspaceId, target.installSlug, operationId],
      )) as Array<{ operation?: unknown }>;
      return parseAdmissionPreviewOperation(Array.isArray(rows) ? rows[0]?.operation : null);
    },
  };
}

/** Default settle emitter: one awaited event per operation, keyed by its handle. */
export async function emitAdmissionPreviewSettled(
  operation: AdmissionPreviewOperation,
  workspaceId: string,
): Promise<void> {
  const { emitAwaitedEvent } = await import('../events/await/engine');
  const verdict = operation.verdict as { verdict?: unknown; judgedSha?: unknown } | null;
  await emitAwaitedEvent({
    key: `${ADMISSION_PREVIEW_SETTLED_EVENT_PREFIX}${operation.operationId}`,
    summary: `admission preview ${operation.operationId} ${operation.status}`,
    payload: {
      operationId: operation.operationId,
      status: operation.status,
      settledAtMs: operation.settledAtMs,
      verdict: typeof verdict?.verdict === 'string' ? verdict.verdict : null,
      judgedSha: typeof verdict?.judgedSha === 'string' ? verdict.judgedSha : null,
    },
    source: 'release:repair-queue:admit-preview',
    workspaceId,
  });
}
