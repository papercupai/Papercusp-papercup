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
import { checkLoopVerdict, gymLoopId, scoutLoopId, LEARNING_GOVERNOR_BUDGET_FLOOR_USD } from '../learning-governor/core';
import { OWNER_STEERING_KEYS } from '../owner-steering';
import { readDreamRoutineControls } from './dream-control';
import { DREAM_ACTION_DECISION_PREFIX, DREAM_ADMISSION_GATES, resolveDreamCycleConfig, type DreamCycleConfig } from './dream-config';
import { GYM_ADMISSION_DECISION_PREFIX, GYM_ADMISSION_GATES } from '../gym/autoloop-tick';
import { readJournal, type JournalReadResult } from '../journal-read';
import { dreamLoopId, sumDreamSpendSince, DREAM_ROLLING_WINDOW_MS } from './dream-governor';
import { resolveScoutBudget } from '../scout/budget';
import { traceNamedQueryStage } from '../agent-tools/db-diagnostic-correlation-wiring';

const nonempty = z.string().trim().min(1).max(500);
export const controlObservationRuntimeSchema = z.object({
  host: nonempty, processId: nonempty, buildSha: nonempty,
}).strict();
export const controlObservationScopeSchema = z.object({
  workspaceId: nonempty, potSlug: nonempty,
  since: z.string().datetime(), until: z.string().datetime(),
  expectedRuntime: controlObservationRuntimeSchema,
  actionJournalUnit: nonempty.optional(),
  expectedActionRuntime: controlObservationRuntimeSchema.optional(),
  gymJournalUnit: nonempty.optional(),
  expectedGymRuntime: controlObservationRuntimeSchema.optional(),
}).strict().refine(s => {
  const span = Date.parse(s.until) - Date.parse(s.since);
  return span > 0 && span <= 31 * 86_400_000;
}, 'Observations require a scoped window of at most 31 days')
  .refine(s => Boolean(s.actionJournalUnit) === Boolean(s.expectedActionRuntime), 'Action journal requires its exact expected runtime')
  .refine(s => Boolean(s.gymJournalUnit) === Boolean(s.expectedGymRuntime), 'Gym journal requires its exact expected runtime');
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
async function observe<T>(stage: Parameters<typeof traceNamedQueryStage>[0], sourceRefs: string[], read: () => Promise<T>): Promise<ControlObservation<T>> {
  try { return { status: 'observed', value: await traceNamedQueryStage(stage, read), sourceRefs }; }
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
  const cap = z.object({ schemaVersion: z.literal(1), supplied: z.record(z.string(), z.unknown()).nullable(),
    resolved: z.object({ maxIdeators: z.number().int().positive(), maxCostUsd: z.number().nonnegative(), maxCriticsPerIdea: z.number().int().positive() }).strict(),
  }).strict().safeParse(detail?.budgetProvenance);
  const expectedCap = cap.success ? resolveScoutBudget(cap.data.supplied ?? undefined) : null;
  const capMatches = cap.success && expectedCap && expectedCap.maxCostUsd === cap.data.resolved.maxCostUsd &&
    expectedCap.maxIdeators === cap.data.resolved.maxIdeators && expectedCap.maxCriticsPerIdea === cap.data.resolved.maxCriticsPerIdea;
  const supplied = cap.success ? cap.data.supplied : null;
  const suppliedCap = capMatches && supplied && typeof supplied.maxCostUsd === 'number' && Number.isFinite(supplied.maxCostUsd) && supplied.maxCostUsd >= 0 &&
    supplied.maxIdeators === 1 && cap.data.resolved.maxIdeators === 1 && cap.data.resolved.maxCostUsd === supplied.maxCostUsd;
  const measuredCost = row.budget_used_usd != null && nonnegative(Number(row.budget_used_usd)) ? Number(row.budget_used_usd) : null;
  const capRespected = suppliedCap
    ? slots.success && slots.data.length > cap.data.resolved.maxIdeators ||
      measuredCost !== null && measuredCost > cap.data.resolved.maxCostUsd ? false
      : slots.success && slots.data.length === 1 && measuredCost !== null ? true : null
    : null;
  return { raw: row, origin: 'scout' as const,
    budgetProvenance: capMatches ? { status: 'observed' as const, ...cap.data } : { status: 'unknown' as const, reason: 'missing-or-invalid-tick-budget-provenance' },
    suppliedOneIdeatorCapRespected: capRespected,
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
  journal: typeof readJournal;
}

const actionDecisionSchema = z.object({
  schemaVersion: z.literal(1), actionId: nonempty, workspaceId: nonempty, potSlug: nonempty,
  capturedAt: z.string().datetime(), runtime: controlObservationRuntimeSchema,
  source: z.literal('dream/dream-cycle-action:makeDreamCycleAction'), mode: z.enum(['manual', 'auto']),
  reason: nonempty, disposition: z.enum(['pre-attempt-policy-skip', 'cycle-result']),
  costUsd: z.number().finite().nonnegative(),
}).passthrough();

const dreamGateSchema = z.object({ gate: z.enum(DREAM_ADMISSION_GATES),
  status: z.enum(['passed', 'refused', 'unknown', 'not-reached', 'not-applicable']),
  inputs: z.record(z.string(), z.unknown()),
}).strict();

/** A refusal can terminate the chain; later checks remain explicitly unreached.
 * A legacy row, missing gate, or read failure cannot establish full admission. */
export function assessDreamAdmission(row: z.infer<typeof actionDecisionSchema>) {
  const refs = ['dream/dream-cycle-action:makeDreamCycleAction', 'dream-governor:preflightDreamCycle'];
  const parsed = z.array(dreamGateSchema).min(DREAM_ADMISSION_GATES.length).safeParse(row.admission);
  if (!parsed.success || DREAM_ADMISSION_GATES.some(g => !parsed.data.some(r => r.gate === g)))
    return unknown('missing-production-admission-gates', refs);
  const gates = parsed.data;
  if (gates.some(g => g.status === 'unknown')) return unknown('unresolved-production-admission-gate', refs);
  const skipGate = { 'feature-off': 'feature', 'owner-idle-disabled': 'owner-idle', 'idle-ratio-below-floor': 'idle-ratio' }[row.reason];
  if (row.disposition === 'pre-attempt-policy-skip') {
    const at = DREAM_ADMISSION_GATES.indexOf(skipGate as typeof DREAM_ADMISSION_GATES[number]);
    if (at < 0 || gates.length !== DREAM_ADMISSION_GATES.length || gates.some((g, i) =>
      g.gate !== DREAM_ADMISSION_GATES[i] || g.status !== (i < at ? 'passed' : i === at ? 'refused' : 'not-reached')))
      return unknown('incoherent-policy-skip-gate-chain', refs);
    return { status: 'observed' as const, value: { allow: false, reason: row.reason, gates, scope: 'actual-production-action' as const }, sourceRefs: refs };
  }
  const prereqs = gates.filter(g => g.gate !== 'continue');
  if (prereqs.some(g => !['passed', 'not-applicable'].includes(g.status))) {
    // A governor refusal is a complete observed refusal only after source and
    // the action-level gates passed; it does not mean a model call occurred.
    if (row.reason !== 'governor-refused' || !gates.some(g => g.gate === 'governor' && g.status === 'refused') ||
      prereqs.some(g => g.gate !== 'governor' && !['passed', 'not-applicable'].includes(g.status)))
      return unknown('incomplete-production-admission-chain', refs);
    return { status: 'observed' as const, value: { allow: false, reason: row.reason, gates, scope: 'actual-production-action' as const }, sourceRefs: refs };
  }
  const continued = gates.filter(g => g.gate === 'continue');
  if (continued.some(g => g.status === 'refused'))
    return { status: 'observed' as const, value: { allow: false, reason: 'continuation-refused', gates, scope: 'actual-production-action' as const }, sourceRefs: refs };
  if (!continued.length || continued.some(g => g.status !== 'passed')) return unknown('continuation-not-observed', refs);
  return { status: 'observed' as const, value: { allow: true, reason: 'observed-gates-passed', gates, scope: 'actual-production-action' as const }, sourceRefs: refs };
}

/** The bounded maintained journal is an actual decision source. No records,
 * unavailable/clipped/truncated reads and dispatch labels never become skips. */
export function assessDreamActionDecisions(journal: JournalReadResult, scope: ControlObservationScope) {
  const refs = ['journal:readJournal', 'dream/dream-cycle-action:makeDreamCycleAction'];
  if (!scope.expectedActionRuntime || !scope.actionJournalUnit) return unknown('action-runtime-and-unit-required', refs);
  if (!journal.journalAvailable || journal.journalError || journal.truncated || journal.unitsUnknown.length > 0)
    return unknown('incomplete-action-journal', refs);
  const records: Array<z.infer<typeof actionDecisionSchema>> = [];
  for (const entry of journal.entries) {
    const index = entry.message.indexOf(DREAM_ACTION_DECISION_PREFIX);
    if (index < 0) continue;
    if (entry.unit !== scope.actionJournalUnit) return unknown('wrong-action-journal-unit', refs);
    if (entry.clipped) return unknown('clipped-action-decision', refs);
    let raw: unknown;
    try { raw = JSON.parse(entry.message.slice(index + DREAM_ACTION_DECISION_PREFIX.length)); }
    catch { return unknown('invalid-action-decision-json', refs); }
    const parsed = actionDecisionSchema.safeParse(raw);
    if (!parsed.success) return unknown('invalid-action-decision', refs);
    const row = parsed.data;
    if (row.workspaceId !== scope.workspaceId || row.potSlug !== scope.potSlug) continue;
    if (!sameRuntime(row.runtime, scope.expectedActionRuntime)) return unknown('wrong-action-runtime', refs);
    if (Date.parse(row.capturedAt) < Date.parse(scope.since) || Date.parse(row.capturedAt) >= Date.parse(scope.until) ||
      Date.parse(entry.ts) < Date.parse(scope.since) || Date.parse(entry.ts) >= Date.parse(scope.until))
      return unknown('wrong-window-action-decision', refs);
    if (row.disposition === 'pre-attempt-policy-skip' &&
      (!['feature-off', 'owner-idle-disabled', 'idle-ratio-below-floor'].includes(row.reason) ||
        row.paidCalls !== 0 || row.model !== null || row.usage !== null || row.costUsd !== 0))
      return unknown('invalid-pre-attempt-skip', refs);
    records.push(row);
  }
  return records.length > 0 ? { status: 'observed' as const, value: { records,
    admission: records.map(row => ({ actionId: row.actionId, assessment: assessDreamAdmission(row) })),
    modelUsage: 'follow-dream-run-ledger' as const }, sourceRefs: refs }
    : unknown('no-actual-action-decision-records', refs);
}

const gymDecisionSchema = z.object({ schemaVersion: z.literal(1), actionId: nonempty,
  workspaceId: nonempty, potSlug: nonempty.nullable(), capturedAt: z.string().datetime(),
  runtime: controlObservationRuntimeSchema, source: z.literal('harness/routines/gym-actions:runGymCycleInline'),
  gate: z.enum(['owner-idle', ...GYM_ADMISSION_GATES, 'tick-result']),
  status: z.enum(['passed', 'refused', 'unknown', 'not-applicable']), inputs: z.record(z.string(), z.unknown()),
}).strict();

export function assessGymAdmissionDecisions(journal: JournalReadResult, scope: ControlObservationScope) {
  const refs = ['journal:readJournal', 'gym/autoloop-tick:runGymAutoloopTick', 'harness/routines/gym-actions:runGymCycleInline'];
  if (!scope.expectedGymRuntime || !scope.gymJournalUnit) return unknown('gym-runtime-and-unit-required', refs);
  if (!journal.journalAvailable || journal.journalError || journal.truncated || journal.unitsUnknown.length)
    return unknown('incomplete-gym-journal', refs);
  const records: Array<z.infer<typeof gymDecisionSchema>> = [];
  for (const entry of journal.entries) {
    const index = entry.message.indexOf(GYM_ADMISSION_DECISION_PREFIX);
    if (index < 0) continue;
    if (entry.unit !== scope.gymJournalUnit || entry.clipped) return unknown('wrong-unit-or-clipped-gym-decision', refs);
    let raw: unknown;
    try { raw = JSON.parse(entry.message.slice(index + GYM_ADMISSION_DECISION_PREFIX.length)); }
    catch { return unknown('invalid-gym-decision-json', refs); }
    const parsed = gymDecisionSchema.safeParse(raw);
    if (!parsed.success) return unknown('invalid-gym-decision', refs);
    const row = parsed.data;
    if (row.workspaceId !== scope.workspaceId || row.potSlug !== null && row.potSlug !== scope.potSlug) continue;
    if (!sameRuntime(row.runtime, scope.expectedGymRuntime)) return unknown('wrong-gym-runtime', refs);
    if ([row.capturedAt, entry.ts].some(t => timestamp(t) < timestamp(scope.since) || timestamp(t) >= timestamp(scope.until)))
      return unknown('wrong-window-gym-decision', refs);
    records.push(row);
  }
  if (!records.length) return unknown('no-actual-gym-admission-records', refs);
  const actions = [...new Set(records.map(row => row.actionId))].map(actionId => {
    const rows = records.filter(row => row.actionId === actionId);
    const gates = ['owner-idle', ...GYM_ADMISSION_GATES].map(gate => {
      const found = rows.filter(row => row.gate === gate);
      return { gate, status: found.some(r => r.status === 'unknown') ? 'unknown' : found.some(r => r.status === 'refused') ? 'refused'
        : found.length ? found[found.length - 1].status : 'not-reached', records: found };
    });
    const refused = gates.find(g => g.status === 'refused');
    const unresolved = gates.some(g => g.status === 'unknown');
    const refusalIndex = gates.findIndex(g => g.status === 'refused');
    const prefixComplete = refusalIndex >= 0 && gates.slice(0, refusalIndex).every(g => g.status === 'passed');
    const complete = !unresolved && (prefixComplete || gates.every(g => g.status === 'passed'));
    return { actionId, status: complete ? 'observed' as const : 'unknown' as const,
      allow: complete ? !refused : null, gates, records: rows,
      reason: unresolved ? 'unresolved-gym-gate' : refused ? refused.gate : complete ? 'observed-gates-passed' : 'incomplete-gym-gate-chain' };
  });
  return { status: actions.every(a => a.status === 'observed') ? 'observed' as const : 'unknown' as const,
    value: { actions, modelUsage: 'not-established' as const }, sourceRefs: refs };
}

/** All SQL below is SELECT-only. In particular, do not call the control snapshot's
 * ensureSetup or pot-gate fallback reader: the latter records telemetry on reads.
 * Read the exact pot row here and reuse the maintained native Gym predicate.
 * Missing stores/invalid rows remain unknown rather than taking fail-open defaults.
 */
interface R2ObservationInput {
  schemaVersion: string; status: string; reason?: string | null; scope: ControlObservationScope; runtime: ServingHostIdentity;
  capturedAt: string; expiresAt: string;
  observations: Record<string, ControlObservation<unknown>> | null;
  actionDecisions?: ControlObservation<{ journal: JournalReadResult; assessment: ReturnType<typeof assessDreamActionDecisions> }>;
  gymDecisions?: ControlObservation<{ journal: JournalReadResult; assessment: ReturnType<typeof assessGymAdmissionDecisions> }>;
  productionAdmission?: ControlObservation<unknown>;
}
export interface R2ClauseAssertion {
  id: string; status: 'pass' | 'fail' | 'unknown'; healthy: boolean; reason: string;
  rawRefs: string[]; sourceRefs: string[]; scope: ControlObservationScope;
  source: { path: string; runtime: ServingHostIdentity };
  capturedAt: string; expiresAt: string;
}

/** Maintained source assertions for D-007. These measure the named R2 clauses;
 * they do not certify output quality, benefit, independent acceptance or shipment. */
export function assessDreamR2ClauseAssertions(value: R2ObservationInput, nowMs: number = Date.now()) {
  const clauses: R2ClauseAssertion[] = [];
  const current = value.schemaVersion === 'dream-control-observations-v1' && Number.isFinite(nowMs) && sameRuntime(value.runtime, value.scope.expectedRuntime) &&
    nowMs >= timestamp(value.capturedAt) && nowMs < timestamp(value.expiresAt) &&
    timestamp(value.expiresAt) - timestamp(value.capturedAt) === CONTROL_OBSERVATION_TTL_MS;
  const emit = (id: string, status: R2ClauseAssertion['status'], reason: string, rawRefs: string[], sourceRefs: string[]) => {
    if (!current || value.status !== 'observed') {
      status = 'unknown'; reason = !current ? 'stale-or-wrong-serving-runtime' : value.reason ?? 'incomplete-observations';
    }
    // An unread/unavailable source still has a measured envelope. Point to its
    // nearest retained ancestor rather than publishing a dangling raw ref.
    const retainedRefs = rawRefs.map(ref => {
      let cursor: unknown = value, retained = '';
      for (const segment of ref.slice(1).split('/')) {
        if (!cursor || typeof cursor !== 'object' || !Object.hasOwn(cursor, segment)) break;
        cursor = (cursor as Row)[segment]; retained += '/' + segment;
      }
      return retained || '/status';
    });
    clauses.push({ id, status, healthy: status === 'pass', reason, rawRefs: [...new Set(retainedRefs)], sourceRefs, scope: value.scope,
      source: { path: 'packages/operator-core/lib/dream/dream-control-observations.ts', runtime: value.runtime },
      capturedAt: value.capturedAt, expiresAt: value.expiresAt });
  };
  const action = value.actionDecisions?.status === 'observed' ? value.actionDecisions.value.assessment : null;
  const gym = value.gymDecisions?.status === 'observed' ? value.gymDecisions.value.assessment : null;
  const completeAction = action?.status === 'observed' && action.value.admission.every(row => row.assessment.status === 'observed');
  emit('r2:dream-action-decisions', completeAction ? 'pass' : 'unknown',
    completeAction ? 'actual-complete-dream-decisions' : action?.status === 'unknown' ? action.reason : 'incomplete-dream-decisions',
    ['/actionDecisions'], ['journal:readJournal', 'dream/dream-cycle-action:makeDreamCycleAction']);
  emit('r2:gym-admission-decisions', gym?.status === 'observed' ? 'pass' : 'unknown',
    gym?.status === 'observed' ? 'actual-complete-gym-decisions' : gym && 'reason' in gym ? gym.reason : 'gym-decisions-not-observed',
    ['/gymDecisions'], ['journal:readJournal', 'gym/autoloop-tick:runGymAutoloopTick']);

  const governors = value.observations?.governors;
  const spend = value.observations?.rollingSpend;
  const full = value.productionAdmission?.status === 'observed' && completeAction && gym?.status === 'observed' &&
    governors?.status === 'observed' && spend?.status === 'observed';
  emit('r2:full-admission-and-spend', full ? 'pass' : 'unknown',
    full ? 'production-decisions-reservations-and-spend-observed' : 'complete-production-admission-and-spend-required',
    ['/productionAdmission', '/observations/governors', '/observations/rollingSpend'],
    ['dream-governor:preflightDreamCycle', 'learning-governor:checkLoopVerdict', 'dream-governor:sumDreamSpendSince']);

  const activity = value.observations?.activity;
  const data = activity?.status === 'observed' ? activity.value as {
    scout?: { hasMore: boolean; observations: ReturnType<typeof scoutObservation>[] };
    dream?: { rows: Row[] };
  } : null;
  const ticks = data?.scout?.observations ?? [];
  const scoped = ticks.every(t => t.origin === 'scout' && t.raw.origin === 'scout' &&
    t.raw.workspace_id === value.scope.workspaceId &&
    (t.raw.pot_slug === value.scope.potSlug || t.raw.pot_slug == null && t.raw.install_slug === value.scope.potSlug));
  const overCap = scoped && ticks.some(t => t.suppliedOneIdeatorCapRespected === false);
  const provenance = scoped && data?.scout?.hasMore === false && ticks.length >= 2 && ticks.every(t =>
    t.budgetProvenance.status === 'observed' && t.suppliedOneIdeatorCapRespected === true &&
    t.oneIdeatorZeroRoute === true && t.ideatorCount === 1 && t.lenses?.length === 1) &&
    new Set(ticks.flatMap(t => t.lenses ?? [])).size >= 2;
  emit('r2:scout-zero-route-lens-cap-provenance', overCap ? 'fail' : provenance ? 'pass' : 'unknown',
    overCap ? 'supplied-scout-cap-violated' : provenance ? 'same-origin-one-ideator-zero-route-cap-and-changing-lenses-observed'
      : 'qualifying-complete-scout-cap-lens-origin-window-required',
    ['/observations/activity/value/scout'], ['harness_shared.scout_ticks', 'scout/scheduler:runScoutTick', 'scout/run:runScoutCycleTick']);

  let attempts: R2ClauseAssertion['status'] = 'unknown';
  let attemptReason = 'actual-attempt-usage-or-explicit-policy-skip-required';
  if (completeAction && action?.status === 'observed') {
    const rows = data?.dream?.rows ?? [];
    const measured = action.value.records.every(r => {
      if (r.disposition === 'pre-attempt-policy-skip')
        return r.paidCalls === 0 && r.model === null && r.usage === null && r.costUsd === 0;
      const refs = z.array(nonempty).min(1).safeParse(r.runRefs);
      if (!refs.success || typeof r.attempts !== 'number' || r.attempts < 1) return false;
      return refs.data.every(ref => rows.some(row => {
        const usage = z.object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative() })
          .passthrough().safeParse(row.dream_usage);
        return row.id === ref && row.workspace_id === value.scope.workspaceId && row.pot_slug === value.scope.potSlug &&
          typeof row.dreamer_model === 'string' && row.dreamer_model.trim().length > 0 && usage.success &&
          row.cost_usd != null && nonnegative(Number(row.cost_usd));
      }));
    });
    if (measured) { attempts = 'pass'; attemptReason = 'actual-ledger-usage-or-authoritative-pre-attempt-skip'; }
  }
  emit('r2:actual-attempts-or-explicit-policy-skips', attempts, attemptReason,
    ['/actionDecisions', '/observations/activity/value/dream'],
    ['dream/dream-cycle-action:makeDreamCycleAction', 'harness_shared.dream_runs']);
  return { schemaVersion: 1 as const, healthy: clauses.every(row => row.healthy), clauses };
}

export async function readDreamControlObservations(
  sql: Sql, input: ControlObservationScope, overrides: Partial<ControlObservationReadDeps> = {},
) {
  const scope = controlObservationScopeSchema.parse(input);
  const deps: ControlObservationReadDeps = {
    now: Date.now, workspace: activeWorkspaceId, runtime: getServingHostIdentity,
    flags: async () => ({ dream: await getFlagAttestation(FLAGS.DREAM_CYCLE, 'dream-cycle'),
      learningGovernor: await getFlagAttestation(FLAGS.LEARNING_GOVERNOR, 'dream-cycle') }),
    journal: readJournal, ...overrides,
  };
  const startedAt = deps.now();
  requireValue(deps.workspace() === scope.workspaceId, 'wrong-serving-workspace');
  requireValue(Number.isFinite(startedAt) && Date.parse(scope.until) <= startedAt, 'future-observation-window');
  const runtime = deps.runtime();
  const runtimeMatches = sameRuntime(runtime, scope.expectedRuntime);
  // A read on the operator cannot certify bg-host's loaded environment or code.
  if (!runtimeMatches) {
    const value = {
    schemaVersion: 'dream-control-observations-v1' as const, status: 'unknown' as const,
    reason: 'wrong-or-unproven-serving-runtime', scope, runtime,
    capturedAt: new Date(startedAt).toISOString(), expiresAt: new Date(startedAt + CONTROL_OBSERVATION_TTL_MS).toISOString(),
      observations: null,
    };
    return { ...value, r2Assertions: assessDreamR2ClauseAssertions(value, startedAt) };
  }

  const [flags, dream, gym, governors, activity, rollingSpend] = await Promise.all([
    observe('dream-observation-flags', ['flags:DREAM_CYCLE', 'flags:LEARNING_GOVERNOR'], async () => {
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
    observe('dream-observation-routines', ['harness_shared.routines', 'dream-config:resolveDreamCycleConfig'], async () => {
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
    observe('dream-observation-gym', ['harness_shared.gym_autoloop_config', 'harness_shared.operator_gym_gates', 'gym/autoloop-tick:isEligibleAutoloop'], async () => {
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
    observe('dream-observation-governors', ['harness_shared.learning_governor_loops', 'harness_shared.learning_pot_scope', 'harness_shared.pot_settings'], async () => {
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
      // Read the complete aggregate directly. The maintained store degrades a
      // missing reservation relation to zero for production availability; an
      // evidence reader must instead retain that read failure as UNKNOWN.
      const reservations = await sql<Row[]>`SELECT loop_id, COALESCE(SUM(reserved_usd), 0)::float8 AS open_reserved_usd,
          COUNT(*)::int AS open_count FROM harness_shared.learning_spend_reservations
        WHERE workspace_id = ${scope.workspaceId} AND loop_id = ANY(${loopIds}) AND status = 'open'
        GROUP BY loop_id`;
      requireValue(reservations.every(row => loopIds.includes(String(row.loop_id)) && nonnegative(row.open_reserved_usd) &&
        Number.isInteger(row.open_count) && Number(row.open_count) >= 0), 'invalid-open-reservations');
      const governorAdmission = loops.map(row => {
        const open = reservations.find(r => r.loop_id === row!.loopId);
        const openReservedUsd = Number(open?.open_reserved_usd ?? 0);
        const chargedOpenUsd = row!.budgetKind === 'lifetime' && row!.budgetUsd !== null ? openReservedUsd : 0;
        return { loopId: row!.loopId, openReservedUsd, chargedOpenUsd, openCount: Number(open?.open_count ?? 0),
          verdict: checkLoopVerdict({ ...row!, spentUsd: row!.spentUsd + chargedOpenUsd },
            LEARNING_GOVERNOR_BUDGET_FLOOR_USD, potScope[0]?.enabled as boolean | undefined),
          enforcement: row!.enforcement, scope: 'governor-budget-and-pot-only' as const };
      });
      return { loops, floorUsd: LEARNING_GOVERNOR_BUDGET_FLOOR_USD, potScope, steering, reservations, governorAdmission,
        admission: 'not-evaluated' as const, // includes open reservations and live gates; do not reconstruct from mirrors
      };
    }),
    observe('dream-observation-activity', ['harness_shared.dream_runs', 'harness_shared.scout_ticks'], async () => {
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
    observe('dream-observation-spend', ['dream-governor:sumDreamSpendSince', 'harness_shared.learning_spend_events', 'harness_shared.dream_runs'], async () => {
      const sinceMs = startedAt - DREAM_ROLLING_WINDOW_MS;
      const value = await sumDreamSpendSince(sql, { workspaceId: scope.workspaceId, sinceMs });
      requireValue(nonnegative(value.totalUsd) && Number.isInteger(value.loopCount) && value.loopCount >= 0, 'invalid-rolling-spend');
      return { ...value, workspaceId: scope.workspaceId, since: new Date(sinceMs).toISOString(),
        accounting: 'maintained-conservative-admission-total' as const };
    }),
  ]);
  const actionDecisions = scope.actionJournalUnit && scope.expectedActionRuntime
    ? await observe('dream-action-journal', ['journal:readJournal'], async () => {
      // Journal windows are resolved by @epoch, never local-time ISO strings.
      const journal = await deps.journal({ units: [scope.actionJournalUnit!],
        since: `@${Date.parse(scope.since) / 1000}`, until: `@${Date.parse(scope.until) / 1000}`,
        grep: DREAM_ACTION_DECISION_PREFIX, limit: ROW_LIMIT });
      return { journal, assessment: assessDreamActionDecisions(journal, scope) };
    }) : unknown('action-runtime-and-unit-required', ['journal:readJournal']);
  const gymDecisions = scope.gymJournalUnit && scope.expectedGymRuntime
    ? await observe('dream-gym-journal', ['journal:readJournal'], async () => {
      const journal = await deps.journal({ units: [scope.gymJournalUnit!],
        since: `@${Date.parse(scope.since) / 1000}`, until: `@${Date.parse(scope.until) / 1000}`,
        grep: GYM_ADMISSION_DECISION_PREFIX, limit: 1000 });
      return { journal, assessment: assessGymAdmissionDecisions(journal, scope) };
    }) : unknown('gym-runtime-and-unit-required', ['journal:readJournal']);
  const productionAdmission = actionDecisions.status === 'observed' && actionDecisions.value.assessment.status === 'observed' &&
    actionDecisions.value.assessment.value.admission.every(row => row.assessment.status === 'observed') &&
    gymDecisions.status === 'observed' && gymDecisions.value.assessment.status === 'observed'
    ? { status: 'observed' as const, value: { dream: actionDecisions.value.assessment.value.admission,
      gym: gymDecisions.value.assessment.value.actions, scope: 'actual-production-gate-decisions' as const },
      sourceRefs: ['dream/dream-cycle-action:makeDreamCycleAction', 'gym/autoloop-tick:runGymAutoloopTick'] }
    : unknown('complete-dream-and-gym-production-decisions-required', ['journal:readJournal']);
  const completedAt = deps.now();
  const fresh = completedAt >= startedAt && completedAt - startedAt < CONTROL_OBSERVATION_TTL_MS;
  const observations = { flags, dream, gym, governors, activity, rollingSpend };
  const value = {
    schemaVersion: 'dream-control-observations-v1' as const,
    status: fresh && Object.values(observations).every(o => o.status === 'observed') ? 'observed' as const : 'unknown' as const,
    reason: !fresh ? 'read-expired-or-clock-invalid' : Object.values(observations).some(o => o.status === 'unknown') ? 'incomplete-observations' : null,
    scope, runtime, capturedAt: new Date(startedAt).toISOString(),
    expiresAt: new Date(startedAt + CONTROL_OBSERVATION_TTL_MS).toISOString(), observations, actionDecisions, gymDecisions, productionAdmission,
  };
  return { ...value, r2Assertions: assessDreamR2ClauseAssertions(value, completedAt) };
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
  if (expected.expectedActionRuntime) {
    if (value.scope.actionJournalUnit !== expected.actionJournalUnit || !value.scope.expectedActionRuntime ||
      !sameRuntime(value.scope.expectedActionRuntime, expected.expectedActionRuntime))
      return { current: false, reason: 'wrong-action-runtime-or-unit' };
    if (!('actionDecisions' in value) || value.actionDecisions.status !== 'observed' ||
      value.actionDecisions.value.assessment.status !== 'observed')
      return { current: false, reason: 'incomplete-action-decisions' };
    if (value.actionDecisions.value.assessment.value.admission.some(row => row.assessment.status !== 'observed'))
      return { current: false, reason: 'incomplete-dream-production-admission' };
  }
  if (expected.expectedGymRuntime) {
    if (value.scope.gymJournalUnit !== expected.gymJournalUnit || !value.scope.expectedGymRuntime ||
      !sameRuntime(value.scope.expectedGymRuntime, expected.expectedGymRuntime))
      return { current: false, reason: 'wrong-gym-runtime-or-unit' };
    if (!('gymDecisions' in value) || value.gymDecisions.status !== 'observed' || value.gymDecisions.value.assessment.status !== 'observed')
      return { current: false, reason: 'incomplete-gym-decisions' };
  }
  const captured = Date.parse(value.capturedAt), expires = Date.parse(value.expiresAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(captured) || !Number.isFinite(expires) ||
    expires - captured !== CONTROL_OBSERVATION_TTL_MS || nowMs < captured || nowMs >= expires)
    return { current: false, reason: 'stale-or-invalid-clock' };
  return value.status === 'observed' ? { current: true, reason: null } : { current: false, reason: value.reason ?? 'unknown-observation' };
}
