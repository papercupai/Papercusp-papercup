/**
 * The reproducibility-layer types (BRIEF 8 / P-010). The per-(task × arm × seed)
 * scoreable row — `TaskRunResult` — is OWNED by P-011 (`@papercusp/bench-metrics`)
 * and imported here; this file owns the two repro artifacts that wrap it:
 *
 *   RolloutRecord — the Rollout-Card published unit (arXiv 2605.12131): the full
 *     config snapshot, exact model/harness versions + git sha, env fingerprint,
 *     VERBATIM raw grader output, the graded submission, and the trajectory
 *     pointer. 1:1 with a run_result via the shared `rolloutId`.
 *   PreregRecord — the pre-registered run config, content-hashed and committed to
 *     git before the run (the tune-to-test firewall).
 *   EmitRolloutInput — the structured input every arm runner hands to
 *     emitRollout(); one call writes the run_result row + the rollout card.
 *
 * snake_case (PG, migration 291) ↔ camelCase (TS) is the persistence seam, owned
 * here in store.ts (rows → TaskRunResult) + emit.ts (input → rows).
 */
import type {
  ArmId,
  BenchSuite,
  GenerationStatus,
  GraderModality,
  GraderStatus,
  TestOutcome,
  PriceTable,
} from '@papercusp/bench-metrics';
import { z } from 'zod';
import { pairedRepositoryPowerPlan } from '@papercusp/bench-metrics';
import { canonicalJson } from './canonical-json';
import { MIN_COMPACTION_LIMIT_TOKENS } from '../../agent-config-constants';
// Value import; capability-ablations.ts imports this module for types only, so there is no runtime cycle.
import { requireRunnableAblation } from '../capability-ablations';

const pin = z.string().trim().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const distinct = <T>(items: T[]) => new Set(items).size === items.length;
const taskRoster = z.array(pin).min(1).refine(distinct, 'Task ids must be unique.');
const seeds = z.array(z.number().int().nonnegative()).min(1).refine(distinct, 'Seeds must be unique.');
const generationCap = z.object({
  maxUsd: z.number().finite().positive(),
  maxTokens: z.number().int().positive().optional(),
  maxWallClockMs: z.number().int().positive(),
}).strict();

/**
 * The product capabilities a controlled comparison can switch individually
 * (modernization P-004; FrontierSWE v2 P-011 / D-018 defines the six shipped
 * since June, plus planning and review). Each controlled arm states every one
 * explicitly: an omitted capability would be an unmeasured confound.
 */
export const BENCHMARK_CAPABILITIES = [
  'memory-recall', 'carry-respawn', 'fleet-leader', 'locks',
  'consult-router', 'work-item-ledger', 'planning', 'review',
] as const;
export type BenchmarkCapability = typeof BENCHMARK_CAPABILITIES[number];
const capabilityToggle = z.enum(['on', 'off']);
const capabilityToggles = z.object(Object.fromEntries(
  BENCHMARK_CAPABILITIES.map(capability => [capability, capabilityToggle]),
) as Record<BenchmarkCapability, typeof capabilityToggle>).strict();

/** stock-native-reference = the unmodified reference harness; the others hold the solver fixed and vary coordination. */
export const ARM_TOPOLOGIES = ['stock-native-reference', 'solo', 'independent', 'coordinated', 'ensemble', 'repeated-session'] as const;
export type ArmTopology = typeof ARM_TOPOLOGIES[number];

/** Official research reference, independent of the frozen Codex study pins. D-059/D-060. */
export const PROXIMUS_SOURCE_REVISION = 'a989f7b35c95c0fd30603290da3c923b7898cba8';
export const PROXIMUS_CLIENT_VERSION = 'harbor-proximus@0.1.0a1';
const proximusRuntime = z.object({
  harborVersion: z.literal('0.23.0'),
  provider: z.enum(['openai', 'anthropic']),
  // Actual context capacity, not a guessed fallback or per-request token estimate.
  maxInputTokens: z.number().int().safe().positive(),
  supportsVision: z.boolean(),
}).strict();

const armControl = z.object({
  topology: z.enum(ARM_TOPOLOGIES),
  /** Arms in one group are compared as the SAME solver: their frozen solver settings must be identical. */
  solverGroup: pin,
  /** Digest of the solver's own tool surface, excluding coordination tools a topology adds. */
  solverToolsHash: digest,
  capabilities: capabilityToggles,
  /** Reuse the maintained native launch threshold. A solver group freezes one
   * value across on/off arms; omission preserves historical protocols. */
  compactionLimit: z.number().int().safe().min(MIN_COMPACTION_LIMIT_TOKENS).optional(),
  /** A single-capability ablation: identical to `of` except `treatment` is switched off. */
  ablation: z.object({ of: pin, treatment: z.enum(BENCHMARK_CAPABILITIES) }).strict().optional(),
  ensemble: z.object({
    candidates: z.number().int().min(2),
    isolation: z.literal('independent'),
    selector: z.object({
      id: pin,
      kind: z.enum(['judge-agent', 'visible-test-verifier']),
      /** Selector spend counts against the arm's own cap. */
      charged: z.literal(true),
      onUnavailable: z.literal('first-candidate'),
    }).strict(),
  }).strict().optional(),
  /** Fresh native sessions continue one workspace; no candidate selection or conversational carry. */
  repeatedSession: z.object({
    matchedCostOf: pin,
    maxSessions: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    workspace: z.literal('same-task'),
    sessionContext: z.literal('fresh-native'),
    submission: z.literal('last-session'),
  }).strict().optional(),
}).strict();
export type ArmControl = z.infer<typeof armControl>;

type ProtocolArm = {
  id: string; agent: string; model: string; effort: string; account: string;
  generationBudget: unknown;
  runtime: { sourceRevision: string; runtimeRevision: string; clientVersion: string; promptHashMode?: string;
    proximus?: z.infer<typeof proximusRuntime> };
  control?: ArmControl;
};

/**
 * The settings that define "the same solver". Prompt and full tool hashes are
 * deliberately excluded: topologies legitimately add coordination prompts and
 * tools, and `solverToolsHash` pins the solver's own tool surface instead.
 */
function frozenSolverSettings(arm: ProtocolArm) {
  return canonicalJson({
    agent: arm.agent, model: arm.model, effort: arm.effort, account: arm.account,
    generationBudget: arm.generationBudget,
    sourceRevision: arm.runtime.sourceRevision, runtimeRevision: arm.runtime.runtimeRevision,
    clientVersion: arm.runtime.clientVersion, promptHashMode: arm.runtime.promptHashMode ?? 'exact-request-v1',
    ...(arm.runtime.proximus ? { proximus: arm.runtime.proximus } : {}),
    solverToolsHash: arm.control?.solverToolsHash,
    ...(arm.control?.compactionLimit !== undefined ? { compactionLimit: arm.control.compactionLimit } : {}),
  });
}

/** Every issue that makes a set of controlled arms an unfair or misattributed comparison. */
function armControlIssues(arms: ReadonlyArray<ProtocolArm>): Array<{ path: (string | number)[]; message: string }> {
  const issues: Array<{ path: (string | number)[]; message: string }> = [];
  const controlled = arms.filter(arm => arm.control);
  if (controlled.length === 0) return issues;
  if (controlled.length !== arms.length) {
    issues.push({ path: ['arms'], message: 'Either every arm declares a control block or none does.' });
    return issues;
  }
  const byId = new Map(arms.map(arm => [arm.id, arm]));
  const groupSettings = new Map<string, string>();
  arms.forEach((arm, index) => {
    const control = arm.control!;
    const path = ['arms', index, 'control'];
    const settings = frozenSolverSettings(arm);
    const peer = groupSettings.get(control.solverGroup);
    if (peer === undefined) groupSettings.set(control.solverGroup, settings);
    else if (peer !== settings) {
      issues.push({ path, message: `Arms in solver group ${control.solverGroup} must freeze identical solver settings.` });
    }
    if ((control.topology === 'ensemble') !== (control.ensemble !== undefined)) {
      issues.push({ path, message: 'An ensemble block is required exactly when the topology is ensemble.' });
    }
    if ((control.topology === 'repeated-session') !== (control.repeatedSession !== undefined)) {
      issues.push({ path, message: 'A repeatedSession block is required exactly when the topology is repeated-session.' });
    }
    if (control.topology === 'repeated-session') {
      if (Object.values(control.capabilities).some(toggle => toggle !== 'off')) {
        issues.push({ path, message: 'The stock repeated-session baseline runs with every product capability off.' });
      }
      if (control.ablation) issues.push({ path, message: 'The repeated-session baseline is not an ablation.' });
      const treatment = control.repeatedSession && byId.get(control.repeatedSession.matchedCostOf);
      if (!treatment || treatment === arm || !treatment.control || treatment.control.ablation ||
          ['repeated-session', 'stock-native-reference'].includes(treatment.control.topology) ||
          treatment.control.solverGroup !== control.solverGroup) {
        issues.push({ path, message: 'A repeated-session baseline must match an existing distinct full treatment arm in the same solver group.' });
      }
    }
    if (control.topology === 'stock-native-reference') {
      if (Object.values(control.capabilities).some(toggle => toggle !== 'off')) {
        issues.push({ path, message: 'The stock-native reference runs with every product capability off.' });
      }
      if (control.ablation) issues.push({ path, message: 'The stock-native reference is not an ablation.' });
    }
    if (!control.ablation) return;
    const base = byId.get(control.ablation.of);
    if (!base || base === arm) {
      issues.push({ path, message: 'An ablation must name another declared arm as its control.' });
      return;
    }
    const baseControl = base.control!;
    if (baseControl.ablation) issues.push({ path, message: 'An ablation must be paired with a full control, not another ablation.' });
    if (baseControl.solverGroup !== control.solverGroup || baseControl.topology !== control.topology ||
        canonicalJson(baseControl.ensemble ?? null) !== canonicalJson(control.ensemble ?? null)) {
      issues.push({ path, message: 'An ablation must keep its control arm\'s solver group, topology and ensemble.' });
    }
    const differing = BENCHMARK_CAPABILITIES.filter(key => baseControl.capabilities[key] !== control.capabilities[key]);
    const treatment = control.ablation.treatment;
    if (differing.length !== 1 || differing[0] !== treatment ||
        baseControl.capabilities[treatment] !== 'on' || control.capabilities[treatment] !== 'off') {
      issues.push({ path, message: `An ablation must switch off exactly ${treatment} relative to its control.` });
    }
    // R-14 / D-037: equal frozen ceilings alone do not match cumulative actual spend.
    // Require the fresh-session, same-workspace control paired to this exact full treatment;
    // an independent ensemble with candidate selection is a separate experiment.
    const hasBaseline = arms.some(candidate => candidate !== base && candidate !== arm &&
      candidate.control!.solverGroup === control.solverGroup && !candidate.control!.ablation &&
      candidate.control!.topology === 'repeated-session' && candidate.control!.repeatedSession?.matchedCostOf === base.id);
    if (!hasBaseline) {
      issues.push({ path, message: `An ablation needs a repeated-session baseline in solver group ${control.solverGroup}, matched to its full control ${base.id}.` });
    }
  });
  return issues;
}

/**
 * A native-CLI reference arm: the declared stock-native topology or, in an uncontrolled protocol,
 * the `baseline` arm the launcher routes to the stock CLI driver.
 */
export function isNativeCliReferenceArm(arm: Pick<ProtocolArm, 'id' | 'control'>): boolean {
  return arm.control ? arm.control.topology === 'stock-native-reference' : arm.id === 'baseline';
}

/**
 * benchmark-coverage-frontierswe-v2-2026-10-10#P-018: harness lift is attributable only with the model
 * held fixed. Every native-CLI reference runs a model some Papercusp arm runs, and every Papercusp arm
 * has a reference on its own model. A study without both kinds of arm is not a lift comparison.
 */
function nativeReferenceModelIssues(arms: ReadonlyArray<ProtocolArm>): Array<{ path: (string | number)[]; message: string }> {
  const issues: Array<{ path: (string | number)[]; message: string }> = [];
  const references = arms.filter(isNativeCliReferenceArm);
  const treatments = arms.filter(arm => !isNativeCliReferenceArm(arm));
  if (references.length === 0 || treatments.length === 0) return issues;
  const treatmentModels = new Set(treatments.map(arm => arm.model));
  const referenceModels = new Set(references.map(arm => arm.model));
  arms.forEach((arm, index) => {
    if (isNativeCliReferenceArm(arm)) {
      if (!treatmentModels.has(arm.model)) {
        issues.push({ path: ['arms', index, 'model'], message: `Native-CLI reference arm ${arm.id} runs ${arm.model}; harness lift needs a Papercusp arm on the same model.` });
      }
    } else if (!referenceModels.has(arm.model)) {
      issues.push({ path: ['arms', index, 'model'], message: `Papercusp arm ${arm.id} runs ${arm.model} with no native-CLI reference on the same model.` });
    }
  });
  return issues;
}

/** Current runs extend the existing prereg config; historical configs retain their original schema. */
export const currentBenchmarkProtocolSchema = z.object({
  schemaVersion: z.literal(1),
  runId: pin,
  taskIds: taskRoster,
  seeds,
  arms: z.array(z.object({
    id: pin,
    agent: z.enum(['codex', 'claude', 'proximus']),
    model: pin,
    effort: pin,
    account: pin,
    generationBudget: generationCap,
    runtime: z.object({ sourceRevision: pin, runtimeRevision: pin, clientVersion: pin, promptHash: digest, toolsHash: digest,
      // Omission preserves historical exact-request pins. Native templates
      // retain a separate full request hash and verified resource-path binding.
      promptHashMode: z.enum(['exact-request-v1', 'codex-native-template-v1']).optional(),
      proximus: proximusRuntime.optional(),
    }).strict(),
    // Omission preserves uncontrolled protocols; when present on any arm it is required on all.
    control: armControl.optional(),
    // benchmark-coverage-frontierswe-v2-2026-10-10#D-023: who pays. Omission is the original
    // OpenAI/Anthropic API key. 'subscription' runs a Codex arm on a ChatGPT subscription
    // (oauth-http), and its USD caps are list-price equivalents rather than money spent.
    payer: z.enum(['api-key', 'subscription']).optional(),
  }).strict()).min(2),
  aggregateBudgetUsd: z.number().finite().positive(),
  maxInFlightUsd: z.number().finite().positive(),
  priceSchedule: z.object({ version: pin, rates: z.array(z.object({
    model: pin, inputUsdPerMillion: z.number().finite().nonnegative(),
    cachedInputUsdPerMillion: z.number().finite().nonnegative(), outputUsdPerMillion: z.number().finite().nonnegative(),
    // Native admission reserves a source-bound COMPLETE input ceiling. This is
    // either the provider maximum or a cap checked against the provider's exact
    // complete-request count; a local estimate/client window is not proof.
    inputTokenCeiling: z.number().int().positive().optional(),
    inputTokenCeilingSourceSha256: digest.optional(),
    // The provider's maximum output per request. A subscription backend rejects
    // max_output_tokens, so this frozen model maximum is that route's output bound.
    outputTokenCeiling: z.number().int().positive().optional(),
    // Freeze the most expensive supported cache-write tier before Claude sends.
    cacheWriteUsdPerMillion: z.number().finite().nonnegative().optional(),
  }).strict()).min(1) }).strict(),
  grader: z.object({ family: pin, version: pin, imageDigest: pin,
    // Current Docker grading binds the official source commit, canonical CSV,
    // and a task -> immutable image URI manifest. Historical pins remain readable.
    datasetSha256: digest.optional(),
    images: z.record(pin, z.string().regex(/^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/)).optional(),
  }).strict(),
  context: z.object({
    corpusHash: digest, memoryHash: digest, corpusRef: pin, memoryRef: pin,
    isolation: z.literal('fresh-per-assignment'), forbiddenSources: z.array(pin).min(1),
  }).strict(),
  exclusions: z.array(pin),
  // Earlier protocol-v1 records remain readable. New executions must freeze
  // this policy; reports without it explicitly withhold inferential intervals.
  sampling: z.object({
    unit: z.literal('repository'), taskRepositories: z.record(pin, pin),
    ci: z.union([z.literal(0.9), z.literal(0.95), z.literal(0.99)]),
    bootstrapSeed: z.number().int().nonnegative().max(0xffffffff),
    bootstrapIterations: z.number().int().min(1000).max(1_000_000),
  }).strict().optional(),
  stopping: z.object({
    maxAttemptsPerAssignment: z.number().int().positive(),
    budgetAction: z.literal('record-cap-outcome'), graderOutage: z.literal('repair-or-inconclusive'),
    superiorityClaim: z.literal('withheld-confirmation-only'),
  }).strict(),
  confirmation: z.object({
    taskIds: taskRoster, seeds,
    plannedPairedTasks: z.number().int().positive(),
    minimumEffect: z.number().finite().gt(0).lte(1), alpha: z.number().finite().gt(0).lt(1),
    power: z.number().finite().gt(0).lt(1), method: pin,
  }).strict(),
}).strict().superRefine((protocol, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  if (!distinct(protocol.arms.map(arm => arm.id))) issue(['arms'], 'Arm ids must be unique.');
  const cap = canonicalJson(protocol.arms[0].generationBudget);
  if (protocol.arms.some(arm => canonicalJson(arm.generationBudget) !== cap)) issue(['arms'], 'Matched arms require equal generation caps.');
  for (const { path, message } of armControlIssues(protocol.arms)) issue(path, message);
  for (const { path, message } of nativeReferenceModelIssues(protocol.arms)) issue(path, message);
  if (protocol.maxInFlightUsd > protocol.aggregateBudgetUsd) issue(['maxInFlightUsd'], 'In-flight exposure cannot exceed the aggregate cap.');
  const modelRates = protocol.priceSchedule.rates.map(rate => rate.model);
  if (!distinct(modelRates) || protocol.arms.some(arm => !modelRates.includes(arm.model))) issue(['priceSchedule'], 'Every arm model needs one frozen price rate.');
  protocol.priceSchedule.rates.forEach((rate, index) => {
    if ((rate.inputTokenCeiling === undefined) !== (rate.inputTokenCeilingSourceSha256 === undefined)) {
      issue(['priceSchedule', 'rates', index], 'Native input ceiling and source proof must be frozen together.');
    }
    if (rate.outputTokenCeiling !== undefined && rate.inputTokenCeiling === undefined) {
      issue(['priceSchedule', 'rates', index], 'A provider output ceiling requires the frozen native input ceiling.');
    }
  });
  // D-023: a subscription arm is never compared with an API-key arm.
  if (new Set(protocol.arms.map(arm => arm.payer ?? 'api-key')).size !== 1) {
    issue(['arms'], 'Matched arms require one payer basis.');
  }
  protocol.arms.forEach((arm, index) => {
    const reference = arm.runtime.proximus;
    if ((arm.agent === 'proximus') !== (reference !== undefined)) {
      issue(['arms', index, 'runtime'], 'A Proximus runtime is required exactly for agent proximus.');
    }
    if (arm.agent === 'proximus') {
      if (arm.control?.topology !== 'stock-native-reference') {
        issue(['arms', index, 'control'], 'Proximus requires an explicit stock-native-reference topology.');
      }
      if (!protocol.arms.some(candidate => !isNativeCliReferenceArm(candidate) && candidate.model === arm.model)) {
        issue(['arms', index, 'model'], 'A Proximus reference requires a Papercusp treatment on the same model.');
      }
      if (arm.runtime.sourceRevision !== PROXIMUS_SOURCE_REVISION || arm.runtime.clientVersion !== PROXIMUS_CLIENT_VERSION ||
          !digest.safeParse(arm.runtime.runtimeRevision).success || arm.runtime.promptHashMode === 'codex-native-template-v1') {
        issue(['arms', index, 'runtime'], 'Proximus requires the official source/package pins and an exact dependency runtime digest.');
      }
      const rate = protocol.priceSchedule.rates.find(value => value.model === arm.model);
      if (!rate || rate.inputTokenCeiling === undefined || rate.outputTokenCeiling === undefined ||
          reference && rate.inputTokenCeiling > reference.maxInputTokens ||
          reference?.provider === 'anthropic' && rate.cacheWriteUsdPerMillion === undefined) {
        issue(['arms', index, 'runtime'], 'Proximus requires frozen provider input/output ceilings within its context limit and cache-write prices for Anthropic.');
      }
      if (!protocol.grader.images || protocol.taskIds.some(taskId => !protocol.grader.images![taskId])) {
        issue(['grader', 'images'], 'Proximus requires the shared immutable task image manifest.');
      }
    }
    if (arm.payer !== 'subscription') return;
    const rate = protocol.priceSchedule.rates.find(value => value.model === arm.model);
    if (arm.agent !== 'codex') issue(['arms', index, 'payer'], 'Only Codex arms support the subscription payer.');
    else if (rate && (rate.inputTokenCeiling === undefined || rate.outputTokenCeiling === undefined)) {
      issue(['arms', index, 'payer'], 'A subscription arm needs frozen provider input and output ceilings.');
    }
  });
  if (protocol.confirmation.taskIds.some(id => protocol.taskIds.includes(id))) issue(['confirmation', 'taskIds'], 'Confirmation tasks must be withheld from the pilot.');
  if (protocol.confirmation.plannedPairedTasks > protocol.confirmation.taskIds.length) issue(['confirmation', 'plannedPairedTasks'], 'The confirmation roster must reserve the planned paired tasks.');
  if (protocol.sampling) {
    const taskIds = new Set([...protocol.taskIds, ...protocol.confirmation.taskIds]);
    const mapping = protocol.sampling.taskRepositories;
    if (Object.keys(mapping).length !== taskIds.size || [...taskIds].some(id => !Object.hasOwn(mapping, id))) {
      issue(['sampling', 'taskRepositories'], 'Repository mapping must cover exactly pilot and withheld confirmation tasks.');
    }
  }
});
export type CurrentBenchmarkProtocol = z.infer<typeof currentBenchmarkProtocolSchema>;

/** Credential/client family is separate from the reference harness identity. */
export function currentBenchProviderAgent(arm: Pick<CurrentBenchmarkProtocol['arms'][number], 'agent'> & {
  runtime?: Pick<CurrentBenchmarkProtocol['arms'][number]['runtime'], 'proximus'>;
}): 'codex' | 'claude' {
  if (arm.agent !== 'proximus') return arm.agent;
  const provider = arm.runtime?.proximus?.provider;
  if (provider === 'openai') return 'codex';
  if (provider === 'anthropic') return 'claude';
  throw new Error('Proximus provider authority requires its explicit frozen provider.');
}

/** Recompute a withheld design from frozen controls; this authorizes no runs. */
export function planCurrentBenchmarkConfirmation(config: unknown) {
  const protocol = currentBenchmarkProtocolSchema.parse(config);
  if (!protocol.sampling) throw new Error('Confirmation planning requires the frozen repository mapping.');
  const confirmation = protocol.confirmation;
  if (confirmation.method !== 'paired-repository-hoeffding-v1') {
    throw new Error('Confirmation planning requires the paired-repository-hoeffding-v1 rejection rule.');
  }
  if (confirmation.plannedPairedTasks !== confirmation.taskIds.length) {
    throw new Error('Confirmation planning requires the exact selected withheld roster, not an unspecified subset.');
  }
  const counts = new Map<string, number>();
  for (const taskId of confirmation.taskIds) {
    const repository = protocol.sampling.taskRepositories[taskId];
    counts.set(repository, (counts.get(repository) ?? 0) + 1);
  }
  const repositories = [...counts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([repository, pairedTasks]) => ({ repository, pairedTasks }));
  const generationAssignments = confirmation.taskIds.length * confirmation.seeds.length * protocol.arms.length;
  if (!Number.isSafeInteger(generationAssignments)) throw new Error('Confirmation assignment count is not representable.');
  return {
    ...pairedRepositoryPowerPlan(repositories.map(entry => entry.pairedTasks), confirmation),
    runId: protocol.runId, repositories, seedsPerTask: confirmation.seeds.length,
    arms: protocol.arms.map(arm => arm.id), generationAssignments,
    inferenceAuthorized: false as const,
  };
}

/** Historical string-arm configs retain their semantics; current controls must validate in full. */
export function currentProtocolFromConfig(config: Record<string, unknown>): CurrentBenchmarkProtocol | null {
  return 'aggregateBudgetUsd' in config ||
    Array.isArray(config.arms) && config.arms.some(value => value !== null && typeof value === 'object')
    ? currentBenchmarkProtocolSchema.parse(config) : null;
}

/** Shared frozen price projection for persistence and regenerated reports. */
export function currentProtocolPriceTable(protocol: CurrentBenchmarkProtocol,
  usage: ReadonlyArray<{ modelId: string; tokensCacheWrite?: number | null }> = []): PriceTable {
  const rates = new Map(protocol.priceSchedule.rates.map(rate => [rate.model, rate]));
  for (const row of usage) {
    const rate = rates.get(row.modelId);
    if (!rate) throw new Error('benchmark: no frozen price for current model');
    if ((row.tokensCacheWrite ?? 0) > 0 && rate.cacheWriteUsdPerMillion === undefined) {
      throw new Error('benchmark: no frozen cache-write price for current usage');
    }
  }
  return {
    version: protocol.priceSchedule.version,
    prices: Object.fromEntries(protocol.priceSchedule.rates.map(rate => [rate.model, {
      inputPerMtok: rate.inputUsdPerMillion, outputPerMtok: rate.outputUsdPerMillion,
      cacheReadPerMtok: rate.cachedInputUsdPerMillion,
      cacheWritePerMtok: rate.cacheWriteUsdPerMillion ?? 0,
    }])),
  };
}

/**
 * Refuse a solo / independent / coordinated / ensemble comparison whose arms
 * are not the same frozen solver. Returns the shared solver group.
 */
export function requireSameSolverComparison(protocol: CurrentBenchmarkProtocol, armIds: ReadonlyArray<string>): string {
  if (armIds.length < 2) throw new Error('A same-solver comparison needs at least two arms.');
  const arms = armIds.map(id => {
    const arm = protocol.arms.find(candidate => candidate.id === id);
    if (!arm) throw new Error(`Comparison arm ${id} is not in the frozen protocol.`);
    if (!arm.control) throw new Error(`Comparison arm ${id} declares no control block.`);
    return arm;
  });
  const group = arms[0].control!.solverGroup;
  if (arms.some(arm => arm.control!.solverGroup !== group)) {
    throw new Error('Same-solver comparison arms must share one solver group.');
  }
  const settings = frozenSolverSettings(arms[0]);
  const drifted = arms.find(arm => frozenSolverSettings(arm) !== settings);
  if (drifted) throw new Error(`Comparison arm ${drifted.id} drifts from the frozen solver settings.`);
  return group;
}

/** Refuse drift between the frozen protocol and the request that will actually launch. */
export function requireCurrentBenchmarkAssignment(config: unknown, execution: {
  runId: string; armId: string; seed: number; taskId: string;
  agent: string; model: string; effort: string; account: string;
  budget: { maxUsd?: number; maxTokens?: number; maxWallClockMs?: number };
  /** Required when the frozen arm declares a control block: the topology the runner will actually execute. */
  topology?: ArmTopology;
}): CurrentBenchmarkProtocol {
  const parsed = currentBenchmarkProtocolSchema.safeParse(config);
  if (!parsed.success) throw new Error(`Current benchmark requires a complete frozen protocol: ${parsed.error.message}`);
  const protocol = parsed.data;
  if (!protocol.sampling) throw new Error('Current benchmark launch requires a frozen repository sampling policy.');
  const arm = protocol.arms.find(candidate => candidate.id === execution.armId);
  if (protocol.runId !== execution.runId || !arm || !protocol.taskIds.includes(execution.taskId) || !protocol.seeds.includes(execution.seed)) {
    throw new Error('Current benchmark assignment is not in the frozen protocol.');
  }
  if (arm.agent !== execution.agent || arm.model !== execution.model || arm.effort !== execution.effort || arm.account !== execution.account ||
      canonicalJson(arm.generationBudget) !== canonicalJson(execution.budget)) {
    throw new Error('Current benchmark launch controls or budget drift from the frozen protocol.');
  }
  if (arm.control) {
    if (execution.topology !== arm.control.topology) {
      throw new Error(`Current benchmark arm ${arm.id} is frozen as ${arm.control.topology}; the runner did not declare that topology.`);
    }
    const peers = protocol.arms.filter(candidate => candidate.control?.solverGroup === arm.control!.solverGroup);
    if (peers.length > 1) requireSameSolverComparison(protocol, peers.map(peer => peer.id));
    requireRunnableAblation(protocol, arm.id);
  }
  return protocol;
}

/** The Rollout Card — the published unit of reproducibility (1:1 with a run_result). */
export interface RolloutRecord {
  rolloutId: string;
  runId: string;
  preregHash: string;
  suite: BenchSuite;
  taskId: string;
  arm: ArmId;
  seed: number;
  /** The resolved per-run config incl. arm settings + model params. */
  configSnapshot?: Record<string, unknown> | null;
  modelId: string;
  /** Exact provider model version string if distinct from modelId. */
  modelVersion?: string | null;
  harnessVersion: string;
  /** Exact tree sha the harness ran from. */
  harnessGitSha?: string | null;
  /** os / node / docker image digests / grader image digest. */
  envFingerprint?: Record<string, unknown> | null;
  graderFamily: string;
  graderVersion: string;
  /** Structured grader report: { failToPass, passToPass, report }. */
  graderOutput?: unknown;
  /** The benchmark's own output, VERBATIM. */
  rawGraderOutput?: string | null;
  /** The exact submission graded — M1: the unified diff; M2: the env handle ref. */
  submission?: string | null;
  trajectoryRef?: string | null;
  trajectoryKind?: string | null;
  createdAt: string;
}

/** The pre-registered run config (committed to git before the run). */
export interface PreregRecord {
  preregHash: string;
  runId: string;
  label?: string | null;
  suites: BenchSuite[];
  config: Record<string, unknown>;
  /** Repo-relative path the committed file lands at (benchmarks/preregistrations/<runId>.json). */
  filePath: string;
  gitCommitted: boolean;
  gitCommitSha?: string | null;
  createdAt: string;
}

/**
 * What an arm runner hands to emitRollout(). The `generation` half is arm-specific
 * (tokens SUMMED across every agent/role/candidate+verifier — coordination
 * overhead counted in OUR number); the `grading` half comes verbatim from the
 * arm-agnostic OfficialGrader. cost_usd + price_table_version are DERIVED at emit
 * (P-011 priceRun) — never passed in, so one published price table applies to
 * every arm identically.
 */
export interface EmitRolloutInput {
  runId: string;
  /** Must match an existing benchmark_prereg row (tune-to-test firewall). */
  preregHash: string;
  suite: BenchSuite;
  taskId: string;
  arm: ArmId;
  /** Independent-attempt ordinal — ≥3 distinct per (task × arm). */
  seed: number;
  modality: GraderModality;
  /** The L2 fleet run that placed this task (Phase 5 / D-010); null for standalone L1 arms. */
  fleetRunId?: string | null;
  generation: {
    status: GenerationStatus;
    error?: string | null;
    tokensIn: number;
    tokensOut: number;
    /** SUMMED across every agent/role (Papercusp) or every candidate+verifier (best-of-N). */
    tokensTotal: number;
    tokensCacheRead?: number | null;
    tokensCacheWrite?: number | null;
    wallClockMs: number;
    turns?: number;
    /** GENERATION iso-budget cap this run ran under (null = uncapped / native). */
    budgetTokens?: number | null;
    /** Did generation hit/terminate at the cap? (a capped run ≠ a genuine fail). */
    capped?: boolean;
    modelId: string;
    harnessVersion: string;
    /** Arm-specific detail; opaque to scoring, published for repro (best-of-N candidates, …). */
    armMeta?: Record<string, unknown> | null;
    /** The graded submission content (diff/env-ref) — stored in the rollout card. */
    submission?: string | null;
    trajectoryRef?: string | null;
    trajectoryKind?: string | null;
  };
  grading: {
    /** NULL when never genuinely graded (generation/grader infra) — excluded from accuracy. */
    resolved: boolean | null;
    status: GraderStatus;
    family: string;
    version: string;
    error?: string | null;
    failToPass?: TestOutcome[] | null;
    passToPass?: TestOutcome[] | null;
    /** Full grader report → rollout.grader_output. */
    structuredOutput?: unknown;
    /** Verbatim grader output → rollout.raw_grader_output. */
    rawOutput?: string | null;
    /**
     * Continuous partial-credit score in [0,1] for rubric/checkpoint/coordination suites
     * (TheAgentCompany, PaperBench, AgentsNet) → run_result.score. NULL for boolean-resolved
     * suites (SWE-bench family) where `resolved` is the score.
     */
    score?: number | null;
  };
  provenance?: {
    configSnapshot?: Record<string, unknown> | null;
    modelVersion?: string | null;
    harnessGitSha?: string | null;
    envFingerprint?: Record<string, unknown> | null;
  };
}
