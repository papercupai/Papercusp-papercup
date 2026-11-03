/**
 * Route-invocation telemetry — R2.
 *
 * Writes one `harness_shared.route_invocations` row per `defineTool`
 * call (migration 077). Best-effort + fire-and-forget: the route-stack
 * calls `recordRouteInvocation` from its `finally` and does not await —
 * a telemetry failure must never affect the response.
 *
 * Honors `def.sampleRate` (0..1, default 1). High-frequency polled
 * routes set it < 1; pure transport routes set it 0 (never recorded).
 *
 * Plan: apps/operator/docs/plans/endpoint-route-migration-2026-05-20.md §6 R2
 */

import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../workspace-registry';
import type { RouteExecution } from './route-stack';
import type { Sql } from 'postgres';
import type { ExpertiseRoutingReceipt } from '../consult/relevance-router';
import { pinModuleState } from '@papercusp/module-singleton';

export const EXPERTISE_ROUTING_PATH = 'internal:expertise-routing';

const expertiseRecorder = pinModuleState('@papercusp/operator-core.expertise-routing-recorder', () => ({
  since: new Date().toISOString(), attempted: 0, persisted: 0, failed: 0,
  lastFailure: null as null | { at: string; code: string; caller: string; policy: string },
}));

/** Process-local recorder observations, independent of persisted routing cohorts. */
export function readExpertiseRoutingRecorderHealth() {
  return structuredClone({
    scope: 'serving-process' as const, processId: process.pid, ...expertiseRecorder,
    pending: expertiseRecorder.attempted - expertiseRecorder.persisted - expertiseRecorder.failed,
  });
}

/** Reuse route_invocations without manufacturing an MCP tool execution. */
export async function recordExpertiseRoutingInvocation(receipt: ExpertiseRoutingReceipt, inject?: Sql): Promise<void> {
  expertiseRecorder.attempted++;
  try {
    const sql = inject ?? getOrgPg().sql;
    await sql.begin(async tx => {
      await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [receipt.workspaceId]);
      await tx.unsafe(
        `INSERT INTO harness_shared.route_invocations
           (workspace_id, method, path, status, duration_ms, error_message, invoked_at, metadata_json)
         VALUES ($1, 'INTERNAL', $2, $3, $4, $5, $6::timestamptz, $7::text::jsonb)`,
        [receipt.workspaceId, EXPERTISE_ROUTING_PATH, receipt.outcome,
          Math.round(receipt.durationMs), receipt.errorCode, receipt.startedAt, JSON.stringify(receipt)],
      );
    });
    expertiseRecorder.persisted++;
  } catch (error) {
    expertiseRecorder.failed++;
    const rawCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    expertiseRecorder.lastFailure = {
      at: new Date().toISOString(), code: /^[A-Z0-9_]{1,40}$/.test(rawCode) ? rawCode : 'recorder_exception',
      caller: receipt.caller, policy: receipt.policy,
    };
    throw error;
  }
}

/** "logged once and swallowed" — the once. Repeated write failures (PG down,
 *  unmigrated dev DB) must not flood the console: under vitest-fail-on-console
 *  a single stray warn fails the test file (gate hold 2026-06-10 16:17Z). */
let warnedWriteFailure = false;

/**
 * Record one route invocation. Fire-and-forget — kicks off the PG write
 * and returns immediately. Sampling + all failure handling are internal.
 */
export function recordRouteInvocation(exec: RouteExecution): void {
  const sampleRate = exec.def.sampleRate ?? 1;
  if (sampleRate <= 0) return;
  if (sampleRate < 1 && Math.random() >= sampleRate) return;

  // Unit tests routinely run the route stack against a PARTIAL db-org mock
  // ({ db } with no sql) — a real pool always has sql.begin. No pool, no
  // telemetry; throwing here would warn on every invocation in such suites.
  if (typeof getOrgPg().sql?.begin !== 'function') return;

  // EI-7069: `exec.def.path` is the route TEMPLATE ('/admin/plans/:verb') —
  // record the RESOLVED path too (what the client actually hit) so per-verb
  // traffic attribution doesn't require falling back to tool_invocations (which
  // only works for routes that happen to dispatch into a tool). Best-effort:
  // an unparseable exec.req.url must never break telemetry.
  let resolvedPath: string | null = null;
  try {
    resolvedPath = new URL(exec.req.url).pathname;
  } catch {
    resolvedPath = null;
  }

  // Correlate only the launcher's Codex-home repair request. Never persist
  // arbitrary headers: randomUUID() emits UUIDv4, so reject every other shape
  // (including combined duplicate values) before copying it into metadata.
  const repairAttempt = exec.def.method === 'POST' && exec.def.path === '/adv/sessions/ensure-codex-home'
    ? exec.req.headers.get('x-papercusp-repair-attempt')
    : null;
  const validRepairAttempt = repairAttempt !== null
    && repairAttempt.length === 36
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(repairAttempt);
  // Correlate the route's auth/input/invoke phases with the hook's timeout and
  // the handler's plan/identity timings. The body is deliberately never read
  // here; only the same bounded UUIDv4 header may enter durable telemetry.
  const guardRequest = exec.def.method === 'POST' && exec.def.path === '/agent-mcp/tool-guard'
    ? exec.req.headers.get('x-papercusp-guard-request-id')
    : null;
  const validGuardRequest = guardRequest !== null
    && guardRequest.length === 36
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(guardRequest);
  let metadataJson: string | null = null;
  const sessionPortInspection = exec.def.method === 'POST'
    && ['/adv/sessions/port/inspect', '/adv/sessions/port/prepare'].includes(exec.def.path);
  if (validRepairAttempt || validGuardRequest || sessionPortInspection) {
    const metadata: Record<string, unknown> = validRepairAttempt
      ? { codexHomeRepairAttemptId: repairAttempt.toLowerCase() }
      : {};
    if (validGuardRequest) metadata.guardRequestId = guardRequest.toLowerCase();
    // Only these explicitly selected routes carry diagnostic phases. Keep
    // the persisted values numeric, finite, and bounded even if a route
    // supplies a custom diagnostics implementation in a test or host.
    try {
      const phaseTimings: Record<string, number> = Object.create(null) as Record<string, number>;
      const raw = exec.routeDiagnostics?.snapshot() ?? {};
      for (const [phase, value] of Object.entries(raw).slice(0, 32)) {
        if (!/^[a-z][a-z0-9._-]{0,63}$/.test(phase)) continue;
        if (!Number.isFinite(value) || value < 0) continue;
        phaseTimings[phase] = Math.min(86_400_000, Math.round(value));
      }
      if (Object.keys(phaseTimings).length > 0) metadata.routePhaseTimingsMs = phaseTimings;
    } catch {
      // Diagnostics are observational and must never affect the route result.
    }
    if (Object.keys(metadata).length > 0) metadataJson = JSON.stringify(metadata);
  }

  // Snapshot everything off `exec` synchronously — `exec` is mutable and
  // the caller's `finally` may clear timers etc. right after this returns.
  const row = {
    method: exec.def.method,
    path: exec.def.path,
    resolvedPath,
    responseBytes: exec.responseBytes,
    metadataJson,
    status: exec.status,
    durationMs: Date.now() - exec.startedAt,
    principalKind: exec.principal?.kind ?? null,
    principalAuthMethod: exec.principal?.authMethod ?? null,
    principalTrust: exec.principal?.trust ?? null,
    errorMessage: exec.status === 'error' || exec.status === 'timeout' ? exec.status : null,
  };

  void (async () => {
    try {
      const workspaceId = activeWorkspaceId();
      const { sql } = getOrgPg();
      await sql.begin(async (tx) => {
        await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId]);
        await tx.unsafe(
          `INSERT INTO harness_shared.route_invocations
             (workspace_id, method, path, status, duration_ms,
              principal_kind, principal_auth_method, principal_trust, error_message,
              resolved_path, response_bytes, metadata_json)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::text::jsonb)`,
          [
            workspaceId,
            row.method,
            row.path,
            row.status,
            row.durationMs,
            row.principalKind,
            row.principalAuthMethod,
            row.principalTrust,
            row.errorMessage,
            row.resolvedPath,
            row.responseBytes,
            row.metadataJson,
          ],
        );
      });
    } catch {
      // Best-effort and once-only. Server exceptions can contain bound route
      // values, so diagnostic output must use fixed control metadata only.
      if (warnedWriteFailure) return;
      warnedWriteFailure = true;
      console.warn(
        '[route-telemetry] write failed (further telemetry write failures suppressed)',
        'route_telemetry_write_failed',
      );
    }
  })();
}
