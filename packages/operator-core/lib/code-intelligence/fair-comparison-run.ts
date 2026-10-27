/**
 * P-017 Phase E core (plan `gitnexus-deterministic-integration-2026-10-05`,
 * D-011): run one arm against the preregistered corpus, then score every arm's
 * raw answers against the pooled, adjudicated key. Pure apart from the arm it
 * is handed, so the whole pipeline is tested with fake arms; the CLI
 * (fair-comparison-cli.ts) adds files, trees and engines.
 *
 * Order of operations the D-011 design requires, and where each is enforced:
 *  1. preregister (fair-comparison.ts) BEFORE any arm runs: `runArm` refuses an
 *     arm, version, intent set or corpus that differs from the preregistration.
 *  2. legacy arms index once; a measurement protocol uses fresh task-backed
 *     repetitions with cold queries, labelled warm-up and warm answers.
 *  3. answers are stored RAW; scoring happens later, against keys completed by
 *     pooled adjudication, so no arm's answers shape the key it is scored on
 *     except through a recorded verdict.
 *  4. `scoreRuns` lists every site still unadjudicated; `decideBackend` refuses
 *     to decide while any remain.
 */
import type { PhaseCost } from './engine-comparison';
import {
  aggregateArm,
  applyAdjudication,
  decideBackend,
  hashCases,
  hashKeys,
  hashPreregistration,
  poolCandidates,
  scoreCase,
  shuffledArmOrder,
  type AdjudicationVerdict,
  type AnswerKey,
  type ArmAggregate,
  type ArmAnswer,
  type ArmCapabilities,
  type BackendDecision,
  type FairCase,
  type Preregistration,
  type SiteKey,
} from './fair-comparison';
import type { FairArm } from './fair-comparison-arms';
import type { CodeIntelAnswer } from './contracts';

export interface ArmRepAnswers {
  readonly rep: number;
  readonly answers: readonly ArmAnswer[];
  /** Fresh-protocol attempts retain failures, rather than inventing scored answers. */
  readonly outcome?: 'completed' | 'setup-failed' | 'unavailable';
  readonly index?: PhaseCost | null;
  readonly setupWallMs?: number;
  readonly identity?: ArmRepetitionIdentity;
  readonly coldAnswers?: readonly ArmAnswer[];
  readonly warmupAnswers?: readonly ArmAnswer[];
  readonly resources?: Readonly<Record<ResourceStage, ArmResourceSample>>;
  readonly setupError?: string;
}

export type ResourceStage = 'ready' | 'warm' | 'final';

/** Runtime custody supplied by the task-backed factory, never inferred from parent RSS. */
export interface ArmRepetitionIdentity {
  readonly taskId: string;
  readonly cgroupPath: string;
  readonly treeRoot: string;
  readonly home: string;
  readonly sourceCommit: string;
  readonly runtimeVersion: string;
}

export interface ArmResourceSample {
  readonly sampledAt: string;
  readonly memoryCurrentBytes: number | null;
  readonly memoryPeakBytes: number | null;
  readonly memoryPeakBasis?: 'sum-of-scope-peaks-upper-bound';
  readonly scopeCosts?: readonly ({ readonly taskId: string | null; readonly cgroupPath: string } &
    import('../task-manager/cgroup-read').CgroupSample)[];
  /** Measured descendant-process high-water mark through this stage, including
   * separately managed child scopes. Threads are not processes. Omitted/null
   * means no complete process census; never infer zero from worker-only metrics. */
  readonly peakChildProcesses?: number | null;
  /** Kernel lineage/counter proof and separately enrolled observer overhead. */
  readonly processObservation?: {
    readonly witness: import('./fair-process-observer').FairProcessWitness | null;
    readonly unknown: readonly string[];
    readonly overhead: ({ readonly taskId: string; readonly cgroupPath: string } &
      import('../task-manager/cgroup-read').CgroupSample) | null;
  };
  /** Race-checked process population at this instant; never a lifetime peak. */
  readonly processCensus?: {
    readonly taskId: string;
    readonly cgroupPath: string;
    readonly rootPid: number;
    readonly processes: readonly { readonly pid: number; readonly identity: string | null; readonly cgroupPath: string | null }[];
    readonly childProcesses: number | null;
    readonly unknown: readonly string[];
  };
  /** Maximum of valid point samples so far. Short-lived forks may be missed. */
  readonly observedChildProcessesMax?: number | null;
  /** Logical file sizes; null means incomplete census, [] means measured empty. */
  readonly indexFiles: readonly { readonly path: string; readonly bytes: number }[] | null;
  readonly unknown: readonly string[];
}

/** Extend the existing runner with a fresh tree/home/task for each repetition. */
export interface FairArmFactory {
  readonly capabilities: ArmCapabilities;
  readonly unavailable: string | null;
  create(rep: number): Promise<{
    readonly arm: FairArm;
    readonly identity: ArmRepetitionIdentity;
    sampleResources?(stage: ResourceStage): Promise<ArmResourceSample>;
    /** Separate native task replay; never substituted for a registered arm answer. */
    nativeGraphQuery?(kase: FairCase): Promise<{
      tool: 'graph:query';
      question: FairCase;
      request: Record<string, unknown>;
      response: CodeIntelAnswer;
      dispatchWitness: { entrypoint: 'dispatchProjectedTool'; transport: string; toolName: 'graph:query'; callId: string };
      wallMs: number;
      control: unknown;
      sourceWitness: { path: string; contentHash: string | null; sourceCommit: string };
      tokenWitness: { requestHash: string; responseHash: string; requestTokens: number; responseTokens: number };
    }>;
  }>;
}

/** Everything one arm produced, as written to `<arm>.run.json`. */
export interface ArmRun {
  readonly capabilities: ArmCapabilities;
  readonly preregHash: string;
  /** Non-null when the arm could not run on this host: reported, never scored. */
  readonly unavailable: string | null;
  readonly index: PhaseCost | null;
  readonly reps: readonly ArmRepAnswers[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly measurementMode?: 'fresh-repetitions';
}

const sortedIntents = (c: ArmCapabilities): string => JSON.stringify([...c.intents].sort());

/** Why `arm` may not run under `prereg`, or null when it matches. */
export function preregMismatch(caps: ArmCapabilities, cases: readonly FairCase[], prereg: Preregistration): string | null {
  if (!prereg.corpusHash || !prereg.budgets) return 'legacy preregistration has no frozen corpus semantics/budgets; preregister a new edition';
  if (hashPreregistration(prereg) !== prereg.hash) return 'preregistration content or budget differs from its recorded hash';
  const reg = prereg.arms.find((a) => a.armId === caps.armId);
  if (!reg) return `arm ${caps.armId} is not in preregistration ${prereg.hash.slice(0, 12)}`;
  if (reg.version !== caps.version) return `arm ${caps.armId} version '${caps.version}' differs from preregistered '${reg.version}'`;
  if (sortedIntents(reg) !== sortedIntents(caps)) return `arm ${caps.armId} intents differ from its preregistration`;
  if (reg.licence !== caps.licence) return `arm ${caps.armId} licence differs from its preregistration`;
  const ids = cases.map((c) => c.id).sort();
  if (JSON.stringify(ids) !== JSON.stringify(prereg.corpusIds)) return 'the corpus differs from the preregistered case ids';
  if (hashCases(cases) !== prereg.corpusHash) return 'the corpus semantics differ from preregistration';
  return null;
}

/** Legacy arms index once; protocol runs require a fresh task-backed factory. */
export async function runArm(
  arm: FairArm | FairArmFactory,
  cases: readonly FairCase[],
  prereg: Preregistration,
  clock: () => string = () => new Date().toISOString(),
): Promise<ArmRun> {
  const mismatch = preregMismatch(arm.capabilities, cases, prereg);
  if (mismatch) throw new Error(`run refused: ${mismatch}`);
  const startedAt = clock();
  const base = { capabilities: arm.capabilities, preregHash: prereg.hash, unavailable: arm.unavailable, startedAt };
  if (arm.unavailable) return { ...base, index: null, reps: [], finishedAt: clock() };
  if ('create' in arm) return runFreshArm(arm, cases, prereg, clock, base);
  if (prereg.protocol) throw new Error('run refused: measurement protocol requires a fresh repetition factory');
  const reps: ArmRepAnswers[] = [];
  let index: PhaseCost;
  try {
    index = await arm.index();
    if (index.ok) {
      for (let rep = 1; rep <= prereg.reps; rep += 1) {
        const answers: ArmAnswer[] = [];
        for (const kase of shuffledArmOrder(cases, prereg.seed + rep)) answers.push(await arm.query(kase));
        reps.push({ rep, answers });
      }
    }
  } finally {
    await arm.close?.();
  }
  return { ...base, index, reps, finishedAt: clock() };
}

async function resourceSample(
  context: Awaited<ReturnType<FairArmFactory['create']>>, stage: ResourceStage, clock: () => string,
): Promise<ArmResourceSample> {
  const missing = (reason: string): ArmResourceSample => ({ sampledAt: clock(),
    memoryCurrentBytes: null, memoryPeakBytes: null, indexFiles: null, unknown: [reason] });
  if (!context.sampleResources) return missing(`not-measured:${stage}`);
  try { return await context.sampleResources(stage); }
  catch (error) { return missing(`sample-failed:${stage}:${String(error)}`); }
}

async function runFreshArm(
  factory: FairArmFactory, cases: readonly FairCase[], prereg: Preregistration,
  clock: () => string, base: Pick<ArmRun, 'capabilities' | 'preregHash' | 'unavailable' | 'startedAt'>,
): Promise<ArmRun> {
  const reps: ArmRepAnswers[] = [];
  const used = new Map<keyof ArmRepetitionIdentity, Set<string>>();
  for (let rep = 1; rep <= prereg.reps; rep += 1) {
    const setupStart = performance.now();
    let context: Awaited<ReturnType<FairArmFactory['create']>>;
    try { context = await factory.create(rep); }
    catch (error) {
      reps.push({ rep, answers: [], outcome: 'setup-failed', index: null,
        setupWallMs: performance.now() - setupStart, setupError: String(error) });
      continue;
    }
    const { arm, identity } = context;
    try {
      const mismatch = preregMismatch(arm.capabilities, cases, prereg);
      if (mismatch || arm.capabilities.armId !== factory.capabilities.armId)
        throw new Error(`run refused: fresh arm capabilities changed (${mismatch ?? 'factory mismatch'})`);
      for (const key of ['taskId', 'cgroupPath', 'treeRoot', 'home'] as const) {
        const values = used.get(key) ?? new Set<string>();
        if (!identity[key]?.trim() || values.has(identity[key])) throw new Error(`run refused: fresh repetition reused or omitted ${key}`);
        values.add(identity[key]);
        used.set(key, values);
      }
      if (!identity.runtimeVersion?.trim() || !identity.sourceCommit?.trim() ||
        (prereg.protocol && identity.sourceCommit !== prereg.protocol.sourceCommit))
        throw new Error('run refused: fresh runtime/source identity differs from protocol');
      if (arm.unavailable) {
        reps.push({ rep, answers: [], outcome: 'unavailable', index: null,
          identity, setupWallMs: performance.now() - setupStart, setupError: arm.unavailable });
        continue;
      }
      let index: PhaseCost;
      try { index = await arm.index(); }
      catch (error) { index = { ok: false, error: String(error), wallMs: performance.now() - setupStart,
        peakRssKb: null, loadAvg1: null }; }
      const setupWallMs = performance.now() - setupStart;
      const ready = await resourceSample(context, 'ready', clock);
      const coldAnswers: ArmAnswer[] = [];
      const warmupAnswers: ArmAnswer[] = [];
      const answers: ArmAnswer[] = [];
      const order = shuffledArmOrder(cases, prereg.seed + rep);
      if (index.ok) {
        const queried = new Set<string>();
        for (const kase of order) {
          // First engine query in each language/intent; undeclared calls never
          // reach the engine and cannot supply a cold-query witness.
          const stratum = JSON.stringify([kase.language ?? null, kase.intent]);
          if (!arm.capabilities.intents.includes(kase.intent) || queried.has(stratum)) continue;
          queried.add(stratum);
          coldAnswers.push(await arm.query(kase));
        }
        for (const kase of order) warmupAnswers.push(await arm.query(kase));
      }
      const warm = await resourceSample(context, 'warm', clock);
      if (index.ok) for (const kase of order) answers.push(await arm.query(kase));
      const final = await resourceSample(context, 'final', clock);
      reps.push({ rep, answers, outcome: index.ok ? 'completed' : 'setup-failed',
        index, setupWallMs, identity, coldAnswers, warmupAnswers, resources: { ready, warm, final } });
    } catch (error) {
      // A cleanup failure must not replace the error that ended the repetition:
      // a masked first failure leaves the run undiagnosable.
      try { await arm.close?.(); } catch (closeError) {
        throw new AggregateError([error, closeError], `fair repetition ${rep} failed (${String(error)}); its close also failed (${String(closeError)})`);
      }
      throw error;
    }
    await arm.close?.();
  }
  return { ...base, measurementMode: 'fresh-repetitions', index: reps[0]?.index ?? null, reps, finishedAt: clock() };
}

/** Missing or over-budget measurements keep a protocol verdict inconclusive. */
function protocolMeasurementResidue(runs: readonly ArmRun[], cases: readonly FairCase[], prereg: Preregistration): string[] {
  const residue: string[] = [];
  const measured = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  for (const run of runs.filter(run => run.unavailable === null)) {
    const label = run.capabilities.armId;
    if (run.measurementMode !== 'fresh-repetitions') { residue.push(`${label}:legacy-measurements`); continue; }
    if (JSON.stringify(run.reps.map(rep => rep.rep)) !== JSON.stringify(Array.from({ length: prereg.reps }, (_, i) => i + 1)))
      residue.push(`${label}:missing-repetitions`);
    for (const rep of run.reps) {
      const ref = `${label}/rep${rep.rep}`;
      if (rep.outcome !== 'completed' || !rep.index?.ok) { residue.push(`${ref}:setup-incomplete`); continue; }
      if (!rep.identity || rep.identity.sourceCommit !== prereg.protocol!.sourceCommit) residue.push(`${ref}:source-unmeasured`);
      if (!measured(rep.setupWallMs) || rep.setupWallMs > prereg.budgets.coldStartMsMax) residue.push(`${ref}:setup-budget`);
      const strata = new Set(cases.filter(kase => run.capabilities.intents.includes(kase.intent))
        .map(kase => JSON.stringify([kase.language ?? null, kase.intent])));
      const cold = rep.coldAnswers ?? [];
      const coldStrata = cold.map(answer => {
        const kase = cases.find(kase => kase.id === answer.caseId);
        return kase ? JSON.stringify([kase.language ?? null, kase.intent]) : 'foreign-case';
      });
      if (cold.length !== strata.size || new Set(coldStrata).size !== strata.size || coldStrata.some(key => !strata.has(key)) ||
        cold.some(answer => answer.status !== 'answered' || !measured(answer.latencyMs) || answer.latencyMs > prereg.budgets.coldStartMsMax))
        residue.push(`${ref}:cold-query-unqualified`);
      const expectedIds = [...prereg.corpusIds].sort();
      for (const [phase, answers] of [['warmup', rep.warmupAnswers ?? []], ['warm', rep.answers]] as const) {
        if (JSON.stringify(answers.map(answer => answer.caseId).sort()) !== JSON.stringify(expectedIds)) residue.push(`${ref}:${phase}-cases-incomplete`);
        if (phase === 'warm' && answers.some(answer => answer.status === 'answered' &&
          (!measured(answer.latencyMs) || answer.latencyMs > prereg.budgets.warmQueryMsMax))) residue.push(`${ref}:warm-query-budget`);
      }
      for (const stage of ['ready', 'warm', 'final'] as const) {
        const sample = rep.resources?.[stage];
        const childPeak = sample?.peakChildProcesses;
        if (!measured(childPeak) || !Number.isSafeInteger(childPeak))
          residue.push(`${ref}:${stage}-child-processes-unmeasured`);
        else if (childPeak > prereg.budgets.childProcMax)
          residue.push(`${ref}:${stage}-child-process-budget`);
        if (!sample || !sample.sampledAt || sample.unknown.length || !measured(sample.memoryCurrentBytes)) {
          residue.push(`${ref}:${stage}-resources-unmeasured`); continue;
        }
        if (sample.memoryCurrentBytes / 1048576 > prereg.budgets.rssMbMax) residue.push(`${ref}:${stage}-resident-budget`);
        if (stage === 'final' && (!measured(sample.memoryPeakBytes) || sample.memoryPeakBytes / 1048576 > prereg.budgets.rssMbMax))
          residue.push(`${ref}:peak-memory-budget`);
        if (stage !== 'warm') {
          const files = sample.indexFiles;
          if (!files || files.some(file => !file.path || !measured(file.bytes)) || new Set(files.map(file => file.path)).size !== files.length)
            residue.push(`${ref}:${stage}-index-unmeasured`);
          else if (files.reduce((sum, file) => sum + file.bytes, 0) / 1048576 > prereg.budgets.indexDiskMbMax)
            residue.push(`${ref}:${stage}-index-budget`);
        }
      }
    }
  }
  return residue;
}

export interface PendingSites {
  readonly caseId: string;
  /** Sites some arm answered that the key does not yet rule on. */
  readonly sites: readonly SiteKey[];
  /** Which arms named each site, so the adjudicator can see who to credit. */
  readonly namedBy: Readonly<Record<SiteKey, readonly string[]>>;
}

export interface ScoredComparison {
  readonly keys: readonly AnswerKey[];
  readonly pending: readonly PendingSites[];
  readonly aggregates: readonly ArmAggregate[];
  readonly decision: BackendDecision;
}

/**
 * Score every arm's raw answers. Keys are the seed keys with the recorded
 * verdicts applied; any answered site no verdict covers is listed in `pending`
 * and keeps the decision inconclusive.
 */
export function scoreRuns(
  runs: readonly ArmRun[],
  cases: readonly FairCase[],
  seedKeys: readonly AnswerKey[],
  verdicts: Readonly<Record<string, readonly AdjudicationVerdict[]>>,
  prereg: Preregistration,
): ScoredComparison {
  if (!prereg.corpusHash || !prereg.budgets) throw new Error('score refused: legacy preregistration lacks corpus semantics/budgets');
  if (hashPreregistration(prereg) !== prereg.hash) throw new Error('score refused: changed preregistration content or budget');
  if (hashCases(cases) !== prereg.corpusHash) throw new Error('score refused: corpus semantics changed after preregistration');
  if (hashKeys(seedKeys) !== prereg.keyHash) throw new Error('score refused: seed answer key changed outside recorded adjudication');
  const foreign = runs.filter((r) => r.preregHash !== prereg.hash).map((r) => r.capabilities.armId);
  if (foreign.length > 0) throw new Error(`score refused: runs from another preregistration (${foreign.join(', ')})`);
  // One run per arm. A superseded run left beside its rerun (a renamed
  // `<arm>.index-failed.run.json`) otherwise scores the arm twice: its answers
  // pool into the key and it appears twice in the aggregates (EI-25227522600988042).
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const r of runs) (seen.has(r.capabilities.armId) ? repeated : seen).add(r.capabilities.armId);
  if (repeated.size > 0) {
    throw new Error(`score refused: more than one run for arm(s) ${[...repeated].join(', ')}; keep only the run to be scored`);
  }
  const keys = seedKeys.map((k) => applyAdjudication(k, verdicts[k.caseId] ?? []));
  const keyOf = new Map(keys.map((k) => [k.caseId, k]));
  const caseOf = new Map(cases.map((c) => [c.id, c]));

  const pending: PendingSites[] = [];
  for (const c of cases) {
    const namedBy: Record<SiteKey, string[]> = {};
    for (const r of runs) {
      const answered = r.reps.flatMap((rep) => rep.answers).filter((a) => a.caseId === c.id && a.status === 'answered');
      for (const site of poolCandidates(keyOf.get(c.id)!, answered)) {
        namedBy[site] = [...new Set([...(namedBy[site] ?? []), r.capabilities.armId])];
      }
    }
    const sites = Object.keys(namedBy).sort();
    if (sites.length > 0) pending.push({ caseId: c.id, sites, namedBy });
  }

  const corpusIntents = [...new Set(cases.map((c) => c.intent))];
  const aggregates = runs
    .filter((r) => r.unavailable === null)
    .map((r) =>
      aggregateArm(
        r.capabilities,
        corpusIntents,
        r.reps.map((rep) => ({
          rep: rep.rep,
          scores: rep.answers.map((a) => scoreCase(caseOf.get(a.caseId)!, r.capabilities, keyOf.get(a.caseId)!, a)),
        })),
      ),
    );
  const residue = prereg.protocol ? protocolMeasurementResidue(runs, cases, prereg) : [];
  const decision: BackendDecision = residue.length
    ? { kind: 'inconclusive', reason: `protocol measurements unqualified: ${residue.join(', ')}` }
    : decideBackend(aggregates, prereg);
  return { keys, pending, aggregates, decision };
}
