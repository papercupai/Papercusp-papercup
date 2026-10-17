/** Mutation-free observations on the existing Learning read plane (WI-6554700010016926).
 * These are observations of this process and scoped stores, never an admission,
 * model-execution, benefit, independent-acceptance or shipment certificate.
 */
import type { Sql } from 'postgres';
import { z } from 'zod';
import { FLAGS } from '@papercusp/flags';
import { getFlagAttestation, type FlagAttestation } from '@papercusp/flags/server';
import { getServingHostIdentity, type ServingHostIdentity } from '../serving-host-identity';
import { activeWorkspaceId } from '../workspace-registry';
import { getAutoloop } from '../gym/control-plane';
import { gymBudgetFloorUsd, isEligibleAutoloop, remainingBudgetUsd } from '../gym/autoloop-tick';
import { DEFAULT_GYM_GATES } from '../gym-gates';
import { getLearningLoop } from '../learning-governor/store';
import { gymLoopId, scoutLoopId, LEARNING_GOVERNOR_BUDGET_FLOOR_USD } from '../learning-governor/core';
import { OWNER_STEERING_KEYS } from '../owner-steering';
import { readDreamRoutineControls } from './dream-control';
import { resolveDreamCycleConfig, type DreamCycleConfig } from './dream-config';
import { dreamLoopId, sumDreamSpendSince, DREAM_ROLLING_WINDOW_MS } from './dream-governor';

const nonempty = z.string().trim().min(1).max(500);
export const controlObservationRuntimeSchema = z.object({
  host: nonempty, processId: nonempty, buildSha: nonempty,
}).strict();
export const controlObservationScopeSchema = z.object({
  workspaceId: nonempty, potSlug: nonempty,
  since: z.string().datetime(), until: z.string().datetime(),
  expectedRuntime: controlObservationRuntimeSchema,
}).strict().refine(s => {
  const span = Date.parse(s.until) - Date.parse(s.since);
  return span > 0 && span <= 31 * 86_400_000;
}, 'Observations require a scoped window of at most 31 days');
export type ControlObservationScope = z.infer<typeof controlObservationScopeSchema>;
export const CONTROL_OBSERVATION_TTL_MS = 60_000;
const ROW_LIMIT = 20;
type Row = Record<string, unknown>;
export type ControlObservation<T> =
  | { status: 'observed'; value: T; sourceRefs: string[] }
  | { status: 'unknown'; value: null; reason: string; sourceRefs: string[] };
const nonnegative = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const unknown = (reason: string, sourceRefs: string[]): ControlObservation<never> =>
  ({ status: 'unknown', value: null, reason, sourceRefs });
async function observe<T>(sourceRefs: string[], read: () => Promise<T>): Promise<ControlObservation<T>> {
  try { return { status: 'observed', value: await read(), sourceRefs }; }
  catch (err) { return unknown(err instanceof Error ? err.message : 'read-failed', sourceRefs); }
}
function requireValue(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason);
}
function sameRuntime(actual: ServingHostIdentity, expected: ControlObservationScope['expectedRuntime']): boolean {
  return actual.host === expected.host && actual.processId === expected.processId && actual.buildSha === expected.buildSha;
}
function page(rows: Row[]) {
  return { rows: rows.slice(0, ROW_LIMIT), hasMore: rows.length > ROW_LIMIT, limit: ROW_LIMIT,
    population: 'bounded-window-rows' as const };
}
function timestamp(value: unknown): number {
  return value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : Number.NaN;
}
function scoutObservation(row: Row) {
  const detail = row.detail && typeof row.detail === 'object' && !Array.isArray(row.detail) ? row.detail as Row : null;
  const slots = z.array(z.object({ lens: nonempty, ok: z.boolean(), raw: z.number().int().nonnegative(), produced: z.number().int().nonnegative() }).passthrough())
    .safeParse(detail?.ideators);
  return { raw: row, origin: 'scout' as const,
    ideatorCount: slots.success ? slots.data.length : null,
    lenses: slots.success ? slots.data.map(s => s.lens) : null,
    ideasRouted: typeof row.ideas_routed === 'number' ? row.ideas_routed : null,
    costUsd: row.budget_used_usd == null ? null : Number(row.budget_used_usd),
    oneIdeatorZeroRoute: slots.success && slots.data.length === 1 && slots.data[0].ok && row.status === 'ran' && row.ideas_routed === 0
      ? true : slots.success ? false : null,
    // This is reported tick provenance, not provider usage or causal value.
    modelUsage: 'not-established' as const,
  };
}

export interface ControlObservationReadDeps {
  now: () => number;
  workspace: () => string;
  runtime: () => ServingHostIdentity;
  flags: () => Promise<{ dream: FlagAttestation; learningGovernor: FlagAttestation }>;
}

/** All SQL below is SELECT-only. In particular, do not call the control snapshot's
 * ensureSetup or pot-gate fallback reader: the latter records telemetry on reads.
 * Read the exact pot row here and reuse the maintained native Gym predicate.
 * Missing stores/invalid rows remain unknown rather than taking fail-open defaults.
 */
export async function readDreamControlObservations(
  sql: Sql, input: ControlObservationScope, overrides: Partial<ControlObservationReadDeps> = {},
) {
  const scope = controlObservationScopeSchema.parse(input);
  const deps: ControlObservationReadDeps = {
    now: Date.now, workspace: activeWorkspaceId, runtime: getServingHostIdentity,
    flags: async () => ({ dream: await getFlagAttestation(FLAGS.DREAM_CYCLE, 'dream-cycle'),
      learningGovernor: await getFlagAttestation(FLAGS.LEARNING_GOVERNOR, 'dream-cycle') }),
    ...overrides,
  };
  const startedAt = deps.now();
  requireValue(deps.workspace() === scope.workspaceId, 'wrong-serving-workspace');
  requireValue(Number.isFinite(startedAt) && Date.parse(scope.until) <= startedAt, 'future-observation-window');
  const runtime = deps.runtime();
  const runtimeMatches = sameRuntime(runtime, scope.expectedRuntime);
  // A read on the operator cannot certify bg-host's loaded environment or code.
  if (!runtimeMatches) return {
    schemaVersion: 'dream-control-observations-v1' as const, status: 'unknown' as const,
    reason: 'wrong-or-unproven-serving-runtime', scope, runtime,
    capturedAt: new Date(startedAt).toISOString(), expiresAt: new Date(startedAt + CONTROL_OBSERVATION_TTL_MS).toISOString(),
    observations: null,
  };

  const [flags, dream, gym, governors, activity, rollingSpend] = await Promise.all([
    observe(['flags:DREAM_CYCLE', 'flags:LEARNING_GOVERNOR'], async () => {
      const value = await deps.flags();
      for (const [name, key] of [['dream', FLAGS.DREAM_CYCLE], ['learningGovernor', FLAGS.LEARNING_GOVERNOR]] as const) {
        const flag = value[name];
        requireValue(flag?.key === key && typeof flag.resolvedValue === 'boolean' &&
          Number.isFinite(flag.observedAtMs) && flag.observedAtMs >= startedAt && flag.observedAtMs < startedAt + CONTROL_OBSERVATION_TTL_MS,
        'invalid-or-stale-flag-attestation');
        requireValue(!['unconfigured', 'store-error', 'stale-cache-fallback'].includes(flag.overrideRead.kind) ||
          ['env-override', 'platform-mode-override'].includes(flag.source), 'flag-override-read-unavailable');
      }
      return { dream: value.dream.resolvedValue, learningGovernor: value.learningGovernor.resolvedValue, attestations: value };
    }),
    observe(['harness_shared.routines', 'dream-config:resolveDreamCycleConfig'], async () => {
      const routines = await readDreamRoutineControls(sql, scope);
      const resolved: Partial<Record<'manual' | 'auto', DreamCycleConfig>> = {};
      for (const mode of ['manual', 'auto'] as const) {
        const matches = routines.filter(r => r.name === `dream-cycle-${mode}`);
        requireValue(matches.length === 1, `missing-or-ambiguous-dream-${mode}-routine`);
        const row = matches[0];
        const payload = row.payload_template as Record<string, unknown> | null;
        requireValue(typeof row.active === 'boolean' && payload?.mode === mode, `invalid-dream-${mode}-routine`);
        requireValue(payload.cycle === undefined || payload.cycle !== null && typeof payload.cycle === 'object' && !Array.isArray(payload.cycle), 'invalid-cycle-payload');
        resolved[mode] = resolveDreamCycleConfig(payload.cycle as Partial<DreamCycleConfig> | undefined);
      }
      return { routines, resolved };
    }),
    observe(['harness_shared.gym_autoloop_config', 'harness_shared.operator_gym_gates', 'gym/autoloop-tick:isEligibleAutoloop'], async () => {
      const autoloop = await getAutoloop(sql, { workspaceId: scope.workspaceId, harnessSlug: scope.potSlug });
      requireValue(autoloop && autoloop.workspaceId === scope.workspaceId && autoloop.harnessSlug === scope.potSlug, 'missing-or-wrong-scope-gym-control');
      requireValue(typeof autoloop.enabled === 'boolean' && ['idle', 'running', 'paused', 'exhausted'].includes(autoloop.status) &&
        (autoloop.budgetUsd === null || nonnegative(autoloop.budgetUsd)) && nonnegative(autoloop.spentUsd), 'invalid-gym-control');
      const rows = await sql<Row[]>`SELECT payload FROM harness_shared.operator_gym_gates
        WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.potSlug} LIMIT 1`;
      requireValue(!rows[0] || rows[0].payload !== null && typeof rows[0].payload === 'object' && !Array.isArray(rows[0].payload), 'invalid-gym-gates');
      const gates = { ...DEFAULT_GYM_GATES, ...(rows[0]?.payload as object ?? {}) };
      requireValue(Object.values(gates).every(nonnegative), 'invalid-gym-gates');
      const budgetFloorUsd = gymBudgetFloorUsd();
      return { autoloop, gates, budgetFloorUsd, remainingUsd: remainingBudgetUsd(autoloop),
        // This is the native budget/row predicate only. Fire/backoff, authority,
        // blueprint, pot and idle gates remain separate; this never means RUN.
        nativeBudgetEligible: isEligibleAutoloop(autoloop, budgetFloorUsd),
        cycleHardCapUsd: remainingBudgetUsd(autoloop),
        nullBudgetRefusesUnattended: !isEligibleAutoloop({ ...autoloop, enabled: true, status: 'idle', budgetUsd: null }, budgetFloorUsd) };
    }),
    observe(['harness_shared.learning_governor_loops', 'harness_shared.learning_pot_scope', 'harness_shared.pot_settings'], async () => {
      const loopIds = [dreamLoopId(scope.potSlug), gymLoopId(scope.potSlug), scoutLoopId(scope.potSlug)];
      const loops = await Promise.all(loopIds.map(loopId => getLearningLoop(sql, { workspaceId: scope.workspaceId, loopId })));
      for (const [index, row] of loops.entries()) {
        requireValue(row && row.workspaceId === scope.workspaceId && row.potSlug === scope.potSlug && row.loopId === loopIds[index], 'missing-or-wrong-scope-learning-loop');
        requireValue((row.budgetUsd === null || nonnegative(row.budgetUsd)) && nonnegative(row.spentUsd) &&
          ['lifetime', 'per-cycle'].includes(row.budgetKind) && ['governor', 'native'].includes(row.enforcement), 'invalid-learning-loop');
      }
      const potScope = await sql<Row[]>`SELECT workspace_id, pot_slug, enabled FROM harness_shared.learning_pot_scope
        WHERE workspace_id = ${scope.workspaceId} AND pot_slug = ${scope.potSlug}`;
      requireValue(potScope.length <= 1 && potScope.every(r => typeof r.enabled === 'boolean'), 'invalid-pot-scope');
      const steering = await sql<Row[]>`SELECT workspace_id, harness_slug, setting_key, value, updated_at FROM harness_shared.pot_settings
        WHERE workspace_id = ${scope.workspaceId} AND harness_slug = ${scope.potSlug}
          AND setting_key = ${OWNER_STEERING_KEYS.idleActivities}`;
      return { loops, floorUsd: LEARNING_GOVERNOR_BUDGET_FLOOR_USD, potScope, steering,
        admission: 'not-evaluated' as const, // includes open reservations and live gates; do not reconstruct from mirrors
      };
    }),
    observe(['harness_shared.dream_runs', 'harness_shared.scout_ticks'], async () => {
      const dreamRuns = await sql<Row[]>`SELECT workspace_id, pot_slug, run_id, cycle_id, mode, status,
          dreamer_model, reviewer_model, dream_usage, review_usage, input_tokens, output_tokens,
          cost_usd, routed_ref, started_at, completed_at, updated_at,
          outcome->'capabilityRun' AS capability_run
        FROM harness_shared.dream_runs WHERE workspace_id = ${scope.workspaceId} AND pot_slug = ${scope.potSlug}
          AND started_at >= ${scope.since}::timestamptz AND started_at < ${scope.until}::timestamptz
        ORDER BY started_at DESC, run_id DESC LIMIT ${ROW_LIMIT + 1}`;
      const scoutTicks = await sql<Row[]>`SELECT id::text, workspace_id, install_slug, pot_slug, tick_at, origin, status, gate,
          ideas_generated, ideas_routed, budget_used_usd, detail
        FROM harness_shared.scout_ticks WHERE workspace_id = ${scope.workspaceId}
          AND (pot_slug = ${scope.potSlug} OR (pot_slug IS NULL AND install_slug = ${scope.potSlug}))
          AND origin = 'scout' AND tick_at >= ${scope.since}::timestamptz AND tick_at < ${scope.until}::timestamptz
        ORDER BY tick_at DESC, id DESC LIMIT ${ROW_LIMIT + 1}`;
      requireValue(dreamRuns.every(r => r.workspace_id === scope.workspaceId && r.pot_slug === scope.potSlug) &&
        scoutTicks.every(r => r.workspace_id === scope.workspaceId && (r.pot_slug === scope.potSlug || r.pot_slug == null && r.install_slug === scope.potSlug) && r.origin === 'scout'), 'wrong-scope-activity');
      const inWindow = (v: unknown) => timestamp(v) >= Date.parse(scope.since) && timestamp(v) < Date.parse(scope.until);
      requireValue(dreamRuns.every(r => inWindow(r.started_at)) && scoutTicks.every(r => inWindow(r.tick_at)), 'wrong-window-activity');
      requireValue(scoutTicks.every(r => r.budget_used_usd == null || Number.isFinite(Number(r.budget_used_usd)) && Number(r.budget_used_usd) >= 0), 'invalid-scout-cost');
      return { dream: page(dreamRuns), scout: { ...page(scoutTicks), observations: scoutTicks.slice(0, ROW_LIMIT).map(scoutObservation) },
        // Preserve NULLs and raw detail.ideators/lens/cost. Empty rows cannot
        // distinguish no dispatch from a pre-ledger policy skip. Stored zero
        // tokens/cost alone do not prove measured usage; full run detail is the
        // maintained learning.dream view=run drill-down.
        modelExecution: 'not-established' as const, outputQuality: 'not-evaluated' as const,
        preLedgerPolicySkips: 'not-recorded-in-attempt-ledger' as const,
      };
    }),
    observe(['dream-governor:sumDreamSpendSince', 'harness_shared.learning_spend_events', 'harness_shared.dream_runs'], async () => {
      const sinceMs = startedAt - DREAM_ROLLING_WINDOW_MS;
      const value = await sumDreamSpendSince(sql, { workspaceId: scope.workspaceId, sinceMs });
      requireValue(nonnegative(value.totalUsd) && Number.isInteger(value.loopCount) && value.loopCount >= 0, 'invalid-rolling-spend');
      return { ...value, workspaceId: scope.workspaceId, since: new Date(sinceMs).toISOString(),
        accounting: 'maintained-conservative-admission-total' as const };
    }),
  ]);
  const completedAt = deps.now();
  const fresh = completedAt >= startedAt && completedAt - startedAt < CONTROL_OBSERVATION_TTL_MS;
  const observations = { flags, dream, gym, governors, activity, rollingSpend };
  return {
    schemaVersion: 'dream-control-observations-v1' as const,
    status: fresh && Object.values(observations).every(o => o.status === 'observed') ? 'observed' as const : 'unknown' as const,
    reason: !fresh ? 'read-expired-or-clock-invalid' : Object.values(observations).some(o => o.status === 'unknown') ? 'incomplete-observations' : null,
    scope, runtime, capturedAt: new Date(startedAt).toISOString(),
    expiresAt: new Date(startedAt + CONTROL_OBSERVATION_TTL_MS).toISOString(), observations,
  };
}

export type DreamControlObservations = Awaited<ReturnType<typeof readDreamControlObservations>>;

/** Recheck when consuming a stored/cached observation. A hash or a label cannot
 * substitute for exact scope, serving process/build and a still-live timestamp.
 */
export function assessDreamControlObservationCurrentness(
  value: DreamControlObservations, input: ControlObservationScope, nowMs: number = Date.now(),
): { current: boolean; reason: string | null } {
  const parsed = controlObservationScopeSchema.safeParse(input);
  if (!parsed.success || !value || value.schemaVersion !== 'dream-control-observations-v1' ||
    !controlObservationScopeSchema.safeParse(value.scope).success || !value.runtime ||
    !value.observations || !['flags', 'dream', 'gym', 'governors', 'activity', 'rollingSpend'].every(key => {
      const row = (value.observations as Record<string, ControlObservation<unknown>>)[key];
      return row && row.status === 'observed' && row.value != null && Array.isArray(row.sourceRefs) && row.sourceRefs.length > 0;
    })) return { current: false, reason: 'invalid-or-incomplete-observation' };
  const expected = parsed.data;
  if (value.scope.workspaceId !== expected.workspaceId || value.scope.potSlug !== expected.potSlug ||
    value.scope.since !== expected.since || value.scope.until !== expected.until) return { current: false, reason: 'wrong-scope-or-window' };
  if (!sameRuntime(value.runtime, expected.expectedRuntime)) return { current: false, reason: 'wrong-runtime' };
  const captured = Date.parse(value.capturedAt), expires = Date.parse(value.expiresAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(captured) || !Number.isFinite(expires) ||
    expires - captured !== CONTROL_OBSERVATION_TTL_MS || nowMs < captured || nowMs >= expires)
    return { current: false, reason: 'stale-or-invalid-clock' };
  return value.status === 'observed' ? { current: true, reason: null } : { current: false, reason: value.reason ?? 'unknown-observation' };
}
