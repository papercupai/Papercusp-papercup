/**
 * Campaign runner — one round of a cleanup campaign (code-cleanup-campaigns-2026-10-26 P-009, R-8; D-015).
 *
 * The round composes the campaign's parts in a fixed order, so no caller can skip a step:
 *   1. triage the sweep's ranked families into batches (P-005, R-5);
 *   2. file every diverged pair triage held as a bug BEFORE any batch is admitted (P-010, R-5);
 *   3. narrow the batches to what the campaign's aggressiveness admits (P-016, R-12);
 *   4. plan each family's extraction; a refused family is dropped with its reason and a batch with
 *      no planned family is withheld (P-006, R-6);
 *   5. ask the tests-first executor for the batch's next step; only a `refactor` step proceeds,
 *      anything else (characterize / exclude / wait / refuse) is reported, never applied (P-006, R-6);
 *   6. re-evaluate the regression throttle and persist a trip (P-008, R-9);
 *   7. admit the refactor-ready batches under the throttle, the live locks and the edit ledger (P-007).
 *
 * The core is pure over injected deps. `dryRun` files nothing, saves nothing and takes no lock.
 * `cleanupBatchRecord` builds the `payload.cleanupBatch` record (D-014) a landed batch carries.
 */
import { admitCampaignRound, evaluateRegressionThrottle } from './throttle';
import type { AttributionMode, CampaignThrottleState, GateRed, GatedSkip, LandedBatch } from './throttle';
import type { AcquireOutcome, AdmissionDeps } from './admission';
import { aggressivenessCandidatesFromTriage, selectBatchesForAggressiveness } from './aggressiveness';
import type { WithheldUnit } from './aggressiveness';
import { nextExecutorStep } from './executor';
import type { CharacterizationRecord, CleanupAggressiveness, CoverageView, ExecutorDeps, ExecutorMember, ExecutorStep } from './executor';
import { planExtraction } from './extract-codemod';
import type { ExtractionPlan, FileEdit } from './extract-codemod';
import { triageCloneFamilies } from './triage';
import type { DivergedHold, DivergenceBugLookup, MemberHistoryLookup, TriageExclusion, TriageFamily, TriageHistory } from './triage';
import type { DivergedFilingRow } from './divergence';
import type { CleanupBatchRecord } from './outcome';

/** Durable per-campaign throttle state (stored by the native adapter; key `code-cleanup:throttle:<campaign>`). */
export interface CampaignThrottleStore {
  load(campaignId: string): Promise<CampaignThrottleState>;
  save(campaignId: string, state: CampaignThrottleState): Promise<void>;
}

export interface CampaignRoundInput {
  campaignId: string;
  /** The runner's own owner id: its own locks and edits never block it. */
  self: string;
  aggressiveness: CleanupAggressiveness;
  /** Sweep-ranked families as triage inputs (`triageFamilyFromRanked`). */
  families: readonly TriageFamily[];
  history: TriageHistory;
  coverage: CoverageView;
  /** Ids of this campaign's batches running now. */
  running: readonly string[];
  /** Characterization changes already emitted, by batch id. */
  characterizations?: ReadonlyMap<string, CharacterizationRecord>;
  /** Gate reds and landed batches the throttle attributes. */
  reds: readonly GateRed[];
  landed: readonly LandedBatch[];
  attribution?: AttributionMode;
  cap?: number;
  now: Date;
  dryRun?: boolean;
}

export interface CampaignRoundDeps {
  divergenceBug: DivergenceBugLookup;
  /** Member-level co-change for families file history cannot connect (D-022). Absent, triage
   * excludes them as single-file or independent. */
  memberHistory?: MemberHistoryLookup;
  fileDiverged(holds: readonly DivergedHold[]): Promise<DivergedFilingRow[]>;
  /** Read a member's file, relative to the scanned root; null = unreadable. */
  readFile(path: string): Promise<string | null>;
  executor: ExecutorDeps;
  admission: AdmissionDeps;
  throttle: CampaignThrottleStore;
}

export type BatchWithholdReason = 'no-planned-family' | 'executor-step';
export interface WithheldBatch { batchId: string; reason: BatchWithholdReason; detail: string; step?: ExecutorStep }
export interface CodemodRefusal { batchId: string; familyId: string; reason: string }
export interface StartedBatch {
  batchId: string;
  lockId: string;
  targetFiles: string[];
  familyIds: string[];
  members: ExecutorMember[];
  edits: FileEdit[];
}

export interface CampaignRoundResult {
  campaignId: string;
  dryRun: boolean;
  excluded: TriageExclusion[];
  diverged: DivergedHold[];
  /** Bugs filed (or reused) for `diverged`; empty on a dry run. */
  divergedFiled: DivergedFilingRow[];
  withheldUnits: WithheldUnit[];
  codemodRefused: CodemodRefusal[];
  withheldBatches: WithheldBatch[];
  started: StartedBatch[];
  skipped: GatedSkip[];
  throttle: { tripped: boolean; count: number; threshold: number; state: CampaignThrottleState };
}

/** Dry-run admission: same readers, but nothing is locked. */
function dryAdmission(deps: AdmissionDeps): AdmissionDeps {
  return { ...deps, acquire: async (): Promise<AcquireOutcome> => ({ ok: true, lockId: 'dry-run' }) };
}

/** Run one campaign round. See the module header for the order of steps. */
export async function planCampaignRound(input: CampaignRoundInput, deps: CampaignRoundDeps): Promise<CampaignRoundResult> {
  const dryRun = input.dryRun === true;
  const triage = await triageCloneFamilies({ families: input.families, history: input.history, divergenceBug: deps.divergenceBug,
    ...(deps.memberHistory ? { memberHistory: deps.memberHistory } : {}) });

  // Divergence is filed before any batch can be admitted (R-5).
  const divergedFiled = dryRun || !triage.diverged.length ? [] : await deps.fileDiverged(triage.diverged);

  const byId = new Map(input.families.map(f => [f.id, f] as const));
  const selection = selectBatchesForAggressiveness(input.aggressiveness,
    aggressivenessCandidatesFromTriage(triage.batches, input.families), input.coverage);

  const codemodRefused: CodemodRefusal[] = [];
  const withheldBatches: WithheldBatch[] = [];
  const ready: Array<Omit<StartedBatch, 'lockId'>> = [];

  for (const proposed of selection.proposed) {
    const batchId = proposed.candidateId;
    const planned: Array<Extract<ExtractionPlan, { status: 'planned' }>> = [];
    for (const unit of proposed.units) {
      const family = byId.get(unit.id);
      if (!family) { codemodRefused.push({ batchId, familyId: unit.id, reason: 'family missing from the round input' }); continue; }
      const plan = await planExtraction(
        { id: family.id, kind: family.kind, members: family.members.map(m => ({ path: m.path, line: m.line, symbol: m.symbol })) },
        deps.readFile);
      if (plan.status === 'refused') codemodRefused.push({ batchId, familyId: unit.id, reason: plan.reason });
      else planned.push(plan);
    }
    if (!planned.length) {
      withheldBatches.push({ batchId, reason: 'no-planned-family', detail: 'every family in the batch was refused by the extraction planner' });
      continue;
    }
    const members = planned.flatMap(p => p.members);
    const step = await nextExecutorStep({
      batch: { id: batchId, members }, aggressiveness: input.aggressiveness, coverage: input.coverage,
      characterization: input.characterizations?.get(batchId) ?? null,
    }, deps.executor);
    if (step.kind !== 'refactor') {
      withheldBatches.push({ batchId, reason: 'executor-step', detail: `executor step is ${step.kind}`, step });
      continue;
    }
    const edits = planned.flatMap(p => p.edits);
    ready.push({
      batchId, familyIds: planned.map(p => p.familyId), members,
      targetFiles: [...new Set(edits.map(e => e.path))].sort(), edits,
    });
  }

  const before = await deps.throttle.load(input.campaignId);
  const evaluation = evaluateRegressionThrottle({
    state: before, reds: input.reds, batches: input.landed, mode: input.attribution ?? 'ledger', now: input.now,
  });
  if (evaluation.tripped && !dryRun) await deps.throttle.save(input.campaignId, evaluation.state);

  const gated = await admitCampaignRound({
    campaignId: input.campaignId, self: input.self, running: input.running, cap: input.cap, now: input.now,
    candidates: ready.map(b => ({ id: b.batchId, targetFiles: b.targetFiles })),
  }, dryRun ? dryAdmission(deps.admission) : deps.admission, evaluation.state);

  const readyById = new Map(ready.map(b => [b.batchId, b] as const));
  const started = gated.admitted.map(a => ({ ...readyById.get(a.batchId)!, lockId: a.lockId }));

  return {
    campaignId: input.campaignId, dryRun,
    excluded: triage.excluded, diverged: triage.diverged, divergedFiled,
    withheldUnits: selection.withheld, codemodRefused, withheldBatches, started, skipped: gated.skipped,
    throttle: { tripped: evaluation.tripped, count: evaluation.count, threshold: evaluation.threshold, state: evaluation.state },
  };
}

/**
 * Net lines removed by a batch, from `git diff --numstat` output, counting only the batch's own
 * files. A binary entry (`-\t-\tpath`) counts zero.
 */
export function linesRemovedFromNumstat(numstat: string, files: readonly string[]): number {
  const own = new Set(files);
  let net = 0;
  for (const line of numstat.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim() ? line : '');
    if (!m || !own.has(m[3])) continue;
    const added = m[1] === '-' ? 0 : Number(m[1]);
    const deleted = m[2] === '-' ? 0 : Number(m[2]);
    net += deleted - added;
  }
  return net;
}

/** The `payload.cleanupBatch` record a landed batch carries (D-014). */
export function cleanupBatchRecord(input: {
  campaign: string; batchId: string; numstat: string; files: readonly string[]; attributedRedIds?: readonly string[];
}): CleanupBatchRecord {
  if (!input.campaign.trim() || !input.batchId.trim()) throw new Error('cleanupBatchRecord needs a campaign and a batch id');
  return {
    campaign: input.campaign,
    batchId: input.batchId,
    linesRemoved: linesRemovedFromNumstat(input.numstat, input.files),
    attributedRedIds: [...new Set(input.attributedRedIds ?? [])].sort(),
  };
}
