/**
 * P-017 — FAIR code-intelligence engine comparison
 * (plan `gitnexus-deterministic-integration-2026-10-05`, D-011).
 *
 * The 2026-10-02 run (`engine-comparison.ts`) answered "is a GitNexus upgrade
 * safe?" on 5 cases. D-011 asks a different question — keep GitNexus, switch to
 * a permissively licensed backend, or drop third-party graphs — and listed what
 * made the old run unfit for it. Each defect maps to one mechanism here:
 *
 *  | defect in the 2026-10-02 run                       | mechanism here                               |
 *  |----------------------------------------------------|----------------------------------------------|
 *  | unsupported intents scored as wrong                | {@link ArmCapabilities} + `undeclared`       |
 *  | crashes / timeouts scored as wrong answers         | {@link OutcomeClass} keeps them separate     |
 *  | recall only, all-or-nothing                        | precision / recall / F1 per case             |
 *  | "no callers" failures invisible                    | confident-false-empty + absence-FP rates     |
 *  | key written before any engine ran                  | pooled adjudication ({@link poolCandidates}) |
 *  | one run per arm                                    | repetitions + spread ({@link aggregateArm})  |
 *  | disposition bars chosen with the data in view      | {@link preregister} hash + {@link decideBackend} |
 *
 * This file is PURE: no subprocess, no filesystem. Arm adapters and the CLI that
 * produces evidence live beside it; everything that decides a verdict is here so
 * it can be unit-tested without an engine installed.
 */
import { createHash } from 'node:crypto';
import { DEFAULT_RESOURCE_BUDGET, type ResourceBudget, type SymbolSite } from './contracts';

// ─── corpus ──────────────────────────────────────────────────────────────────

/** The intents the comparison scores. Each arm declares the subset it supports. */
export const FAIR_INTENTS = [
  'callers',
  'callees',
  'impact',
  'definition',
  'references',
  'symbol-search',
  'text-search',
] as const;
export type FairIntent = (typeof FAIR_INTENTS)[number];

/** The intents a graph BACKEND must answer to sit behind the P-004 seam. */
export const GRAPH_INTENTS: readonly FairIntent[] = ['callers', 'callees', 'impact'];

/**
 * Hard-case strata. `absence` marks a case whose true answer is EMPTY — the case
 * that catches "no callers" claims, the most expensive wrong answer here.
 */
export type HardnessTag =
  | 'absence'
  | 'barrel-reexport'
  | 'same-name'
  | 'dynamic-dispatch'
  | 'cross-package'
  | 'submodule';

export type CaseSource = 'selective' | 'acceptance' | 'mined-grep' | 'gate-incident' | 'authored' | 'micro-repo' | 'repository-task';

export interface FairCase {
  readonly id: string;
  readonly intent: FairIntent;
  /** The symbol (or, for text-search, the literal) the question is about. */
  readonly subject: string;
  /** A repo-relative file that disambiguates `subject` (same-name cases need it). */
  readonly anchorFile?: string;
  /** Traversal depth for `impact` (2-3 in the D-011 design). */
  readonly depth?: number;
  readonly tags: readonly HardnessTag[];
  readonly source: CaseSource;
  /** Explicit cohort/control cells; omission on old corpora remains unmeasured. */
  readonly language?: string;
  readonly configuration?: 'configured' | 'unconfigured';
  readonly sourceState?: 'current' | 'stale' | 'deleted';
  /** Pin authored repository content and real task identity independently of its id. */
  readonly sourceFingerprint?: string;
  readonly taskRef?: string;
}

/** Freeze question semantics, not merely ids that can hide a changed question. */
export function hashCases(cases: readonly FairCase[]): string {
  const canon = [...cases].sort((a, b) => a.id.localeCompare(b.id)).map(c => ({
    id: c.id, intent: c.intent, subject: c.subject, anchorFile: c.anchorFile ?? null,
    depth: c.depth ?? null, tags: [...c.tags].sort(), source: c.source,
    language: c.language ?? null, configuration: c.configuration ?? null,
    sourceState: c.sourceState ?? null, sourceFingerprint: c.sourceFingerprint ?? null,
    taskRef: c.taskRef ?? null,
  }));
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

// ─── answer key (pooled adjudication) ─────────────────────────────────────────

/** `path:line1` — the one site identity every arm is scored on. */
export type SiteKey = string;

export const siteKey = (s: Pick<SymbolSite, 'path' | 'line1'>): SiteKey => `${s.path}:${s.line1 ?? '?'}`;

/**
 * The adjudicated truth for one case. `sites` is the answer set (empty for an
 * absence case). `aliases` maps a site an engine reported to the canonical site
 * it denotes (e.g. a decorator line vs the declaration line) so an engine is not
 * punished for a different-but-correct line choice. `rejected` records sites a
 * human verified as WRONG, so they never re-enter the adjudication pool.
 * `neutral` records sites that are neither credited nor penalised — the subject's
 * own declaration in a callers/references answer is the standard case: LSP
 * includes it by default and graph engines omit it, and neither choice is wrong.
 */
export interface AnswerKey {
  readonly caseId: string;
  readonly sites: readonly SiteKey[];
  readonly aliases: Readonly<Record<SiteKey, SiteKey>>;
  readonly rejected: readonly SiteKey[];
  readonly neutral: readonly SiteKey[];
}

export interface AdjudicationVerdict {
  readonly site: SiteKey;
  readonly verdict: 'valid' | 'invalid' | 'alias' | 'neutral';
  /** Required when verdict is `alias`: the canonical site it denotes. */
  readonly aliasOf?: SiteKey;
  /** Why — the evidence a reviewer saw (file excerpt, call expression). */
  readonly note: string;
}

const known = (key: AnswerKey): Set<SiteKey> =>
  new Set<SiteKey>([...key.sites, ...Object.keys(key.aliases), ...key.rejected, ...key.neutral]);

/**
 * Pooled adjudication, step 1: every site ANY arm returned that the key has not
 * yet ruled on. Standard IR pooling — a correct site that only one engine found
 * is added to the key and EVERY arm is rescored, so the key never favours the
 * engine it was first written from.
 */
export function poolCandidates(
  key: AnswerKey,
  answers: ReadonlyArray<{ readonly sites: readonly SymbolSite[] }>,
): SiteKey[] {
  const seen = known(key);
  const pool = new Set<SiteKey>();
  for (const a of answers) {
    for (const s of a.sites) {
      const k = siteKey(s);
      if (!seen.has(k)) pool.add(k);
    }
  }
  return [...pool].sort();
}

/**
 * Pooled adjudication, step 2: fold verdicts into a NEW key (the input is never
 * mutated). Refuses an alias whose target is not itself a valid site, and a
 * verdict that contradicts an earlier ruling — a silent flip of a ruled site
 * would rescore every arm without a trace.
 */
export function applyAdjudication(key: AnswerKey, verdicts: readonly AdjudicationVerdict[]): AnswerKey {
  const sites = new Set(key.sites);
  const aliases: Record<SiteKey, SiteKey> = { ...key.aliases };
  const rejected = new Set(key.rejected);
  const neutral = new Set(key.neutral);
  const ruled = (k: SiteKey): string | null =>
    sites.has(k)
      ? 'valid'
      : rejected.has(k)
        ? 'invalid'
        : neutral.has(k)
          ? 'neutral'
          : k in aliases
            ? 'alias'
            : null;
  for (const v of verdicts) {
    const prior = ruled(v.site);
    if (prior !== null && prior !== v.verdict) {
      throw new Error(`adjudication conflict on ${key.caseId} ${v.site}: already ${prior}, now ${v.verdict}`);
    }
    if (v.verdict === 'valid') sites.add(v.site);
    else if (v.verdict === 'invalid') rejected.add(v.site);
    else if (v.verdict === 'neutral') neutral.add(v.site);
    else {
      if (!v.aliasOf) throw new Error(`alias verdict for ${v.site} on ${key.caseId} names no aliasOf`);
      aliases[v.site] = v.aliasOf;
    }
  }
  for (const [from, to] of Object.entries(aliases)) {
    if (!sites.has(to)) throw new Error(`alias ${from} -> ${to} on ${key.caseId}: target is not a valid site`);
  }
  return {
    caseId: key.caseId,
    sites: [...sites].sort(),
    aliases,
    rejected: [...rejected].sort(),
    neutral: [...neutral].sort(),
  };
}

/** Order-independent hash of the frozen keys — recorded in the preregistration. */
export function hashKeys(keys: readonly AnswerKey[]): string {
  const canon = [...keys]
    .sort((a, b) => a.caseId.localeCompare(b.caseId))
    .map((k) => ({
      caseId: k.caseId,
      sites: [...k.sites].sort(),
      aliases: Object.fromEntries(Object.entries(k.aliases).sort(([a], [b]) => a.localeCompare(b))),
      rejected: [...k.rejected].sort(),
      neutral: [...k.neutral].sort(),
    }));
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}

// ─── arms and answers ─────────────────────────────────────────────────────────

/** Licence family — the decision rule prefers the least encumbered among ties. */
export type LicenceClass = 'first-party' | 'permissive' | 'noncommercial';

/**
 * What an arm PREREGISTERS before it runs: the intents it answers and the terms
 * it is used under. Accuracy is scored only inside `intents`; a case outside
 * them is `undeclared` and counts against COVERAGE, never against accuracy.
 */
export interface ArmCapabilities {
  readonly armId: string;
  readonly version: string;
  readonly intents: readonly FairIntent[];
  readonly licence: LicenceClass;
}

/** How an arm's attempt at one case ended, BEFORE grading. */
export type AnswerStatus = 'answered' | 'declined' | 'crashed' | 'timed-out' | 'stale-index';

export interface ArmAnswer {
  readonly caseId: string;
  readonly status: AnswerStatus;
  readonly sites: readonly SymbolSite[];
  readonly latencyMs: number;
  readonly detail?: string;
}

/**
 * The graded outcome. `correct`/`partial`/`wrong` exist only for ANSWERED cases;
 * the other four come straight from {@link AnswerStatus}, so a crash can never be
 * read as a wrong answer (the 2026-10-02 defect) nor as a right one.
 */
export type OutcomeClass =
  | 'correct'
  | 'partial'
  | 'wrong'
  | 'declined'
  | 'crashed'
  | 'timed-out'
  | 'stale-index'
  | 'undeclared';

export interface CaseScore {
  readonly caseId: string;
  readonly intent: FairIntent;
  readonly outcome: OutcomeClass;
  /** The adjudicated answer is EMPTY (an absence case). */
  readonly absence: boolean;
  /** null when the case was not answered (nothing to measure). */
  readonly precision: number | null;
  readonly recall: number | null;
  readonly f1: number | null;
  /** Answered EMPTY when the key is non-empty — the "no callers" failure. */
  readonly confidentFalseEmpty: boolean;
  /** Answered NON-empty on an absence case. */
  readonly absenceFalsePositive: boolean;
  /** Returned sites the key has not ruled on; > 0 means the score is provisional. */
  readonly unadjudicated: number;
  readonly latencyMs: number;
}

/**
 * Grade one answer against the adjudicated key. Aliased sites are mapped to their
 * canonical site; duplicates collapse. Unruled sites count as false positives for
 * precision AND are reported in `unadjudicated`, so a report built on a key that
 * still has pending candidates is visibly provisional rather than silently harsh.
 */
export function scoreCase(kase: FairCase, caps: ArmCapabilities, key: AnswerKey, answer: ArmAnswer): CaseScore {
  const base = { caseId: kase.id, intent: kase.intent, absence: key.sites.length === 0, latencyMs: answer.latencyMs };
  const empty = { precision: null, recall: null, f1: null, confidentFalseEmpty: false, absenceFalsePositive: false, unadjudicated: 0 };
  if (!caps.intents.includes(kase.intent)) return { ...base, ...empty, outcome: 'undeclared' };
  if (answer.status !== 'answered') return { ...base, ...empty, outcome: answer.status };

  const truth = new Set(key.sites);
  const ruled = known(key);
  const neutral = new Set(key.neutral);
  const returned = new Set<SiteKey>();
  let unadjudicated = 0;
  for (const s of answer.sites) {
    const raw = siteKey(s);
    if (!ruled.has(raw)) unadjudicated += 1;
    if (neutral.has(raw)) continue;
    returned.add(key.aliases[raw] ?? raw);
  }
  const tp = [...returned].filter((k) => truth.has(k)).length;

  if (truth.size === 0) {
    const ok = returned.size === 0;
    return {
      ...base,
      outcome: ok ? 'correct' : 'wrong',
      precision: ok ? 1 : 0,
      recall: 1,
      f1: ok ? 1 : 0,
      confidentFalseEmpty: false,
      absenceFalsePositive: !ok,
      unadjudicated,
    };
  }
  const precision = returned.size === 0 ? 0 : tp / returned.size;
  const recall = tp / truth.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const outcome: OutcomeClass = f1 === 1 ? 'correct' : f1 > 0 ? 'partial' : 'wrong';
  return {
    ...base,
    outcome,
    precision,
    recall,
    f1,
    confidentFalseEmpty: returned.size === 0,
    absenceFalsePositive: false,
    unadjudicated,
  };
}

// ─── repetitions ──────────────────────────────────────────────────────────────

/** Deterministic PRNG so a randomized arm order is reproducible from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates over a copy, driven by `mulberry32(seed)`. */
export function shuffledArmOrder<T>(arms: readonly T[], seed: number): T[] {
  const rnd = mulberry32(seed);
  const out = [...arms];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export interface Spread {
  readonly median: number | null;
  readonly min: number | null;
  readonly max: number | null;
}

function spreadOf(xs: readonly number[]): Spread {
  if (xs.length === 0) return { median: null, min: null, max: null };
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
  return { median, min: s[0]!, max: s[s.length - 1]! };
}

const mean = (xs: readonly number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

const NOT_ANSWERED: readonly OutcomeClass[] = ['declined', 'crashed', 'timed-out', 'stale-index'];

/** One repetition's view of an arm: every case score from that rep. */
export interface RepScores {
  readonly rep: number;
  readonly scores: readonly CaseScore[];
}

export interface RepMetrics {
  readonly rep: number;
  /** Macro F1 over ANSWERED declared cases. */
  readonly answeredF1: number | null;
  /** Macro F1 over ALL declared cases, a non-answer counted as 0 (crashes cost). */
  readonly effectiveF1: number | null;
  /** effectiveF1 restricted to {@link GRAPH_INTENTS}. */
  readonly graphEffectiveF1: number | null;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly confidentFalseEmptyRate: number | null;
  readonly absenceFalsePositiveRate: number | null;
  readonly graphConfidentFalseEmptyRate: number | null;
}

/** The metrics of one repetition. Denominators are declared cases only. */
export function repMetrics(r: RepScores): RepMetrics {
  const declared = r.scores.filter((s) => s.outcome !== 'undeclared');
  const answered = declared.filter((s) => !NOT_ANSWERED.includes(s.outcome));
  const eff = (xs: readonly CaseScore[]) => mean(xs.map((s) => s.f1 ?? 0));
  const graph = declared.filter((s) => GRAPH_INTENTS.includes(s.intent));
  // Confident-false-empty is defined only where an empty answer is WRONG:
  // answered, non-absence cases.
  const cfeRate = (xs: readonly CaseScore[]) => {
    const pool = xs.filter((s) => !s.absence);
    return pool.length === 0 ? null : pool.filter((s) => s.confidentFalseEmpty).length / pool.length;
  };
  const absence = answered.filter((s) => s.absence);
  return {
    rep: r.rep,
    answeredF1: mean(answered.map((s) => s.f1 ?? 0)),
    effectiveF1: eff(declared),
    graphEffectiveF1: eff(graph),
    precision: mean(answered.map((s) => s.precision ?? 0)),
    recall: mean(answered.filter((s) => !s.absence).map((s) => s.recall ?? 0)),
    confidentFalseEmptyRate: cfeRate(answered),
    absenceFalsePositiveRate: absence.length === 0 ? null : absence.filter((s) => s.absenceFalsePositive).length / absence.length,
    graphConfidentFalseEmptyRate: cfeRate(answered.filter((s) => GRAPH_INTENTS.includes(s.intent))),
  };
}

export interface ArmAggregate {
  readonly armId: string;
  readonly licence: LicenceClass;
  readonly reps: number;
  /** Share of the corpus's intents this arm declared. */
  readonly coverage: number;
  readonly declaresGraphIntents: boolean;
  readonly outcomeCounts: Readonly<Record<OutcomeClass, number>>;
  /** Share of declared (case, rep) attempts that crashed or timed out. */
  readonly failureRate: number;
  readonly unadjudicated: number;
  /** Cases whose outcome differed between repetitions (non-determinism). */
  readonly unstableCases: readonly string[];
  readonly effectiveF1: Spread;
  readonly graphEffectiveF1: Spread;
  readonly answeredF1: Spread;
  readonly precision: Spread;
  readonly recall: Spread;
  readonly confidentFalseEmptyRate: Spread;
  readonly graphConfidentFalseEmptyRate: Spread;
  readonly absenceFalsePositiveRate: Spread;
  readonly latencyMs: Spread;
}

const ALL_OUTCOMES: readonly OutcomeClass[] = [
  'correct',
  'partial',
  'wrong',
  'declined',
  'crashed',
  'timed-out',
  'stale-index',
  'undeclared',
];

const nonNull = (xs: ReadonlyArray<number | null>): number[] => xs.filter((x): x is number => x !== null);

/** Fold every repetition of one arm into medians + spread. */
export function aggregateArm(
  caps: ArmCapabilities,
  corpusIntents: readonly FairIntent[],
  reps: readonly RepScores[],
): ArmAggregate {
  const metrics = reps.map(repMetrics);
  const all = reps.flatMap((r) => r.scores);
  const outcomeCounts = Object.fromEntries(ALL_OUTCOMES.map((o) => [o, 0])) as Record<OutcomeClass, number>;
  for (const s of all) outcomeCounts[s.outcome] += 1;
  const declared = all.filter((s) => s.outcome !== 'undeclared');
  const failed = declared.filter((s) => s.outcome === 'crashed' || s.outcome === 'timed-out').length;
  const byCase = new Map<string, Set<OutcomeClass>>();
  for (const s of all) {
    const set = byCase.get(s.caseId) ?? new Set<OutcomeClass>();
    set.add(s.outcome);
    byCase.set(s.caseId, set);
  }
  const intents = new Set(corpusIntents);
  const declaredInCorpus = caps.intents.filter((i) => intents.has(i)).length;
  const pick = (f: (m: RepMetrics) => number | null) => spreadOf(nonNull(metrics.map(f)));
  return {
    armId: caps.armId,
    licence: caps.licence,
    reps: reps.length,
    coverage: intents.size === 0 ? 0 : declaredInCorpus / intents.size,
    declaresGraphIntents: GRAPH_INTENTS.every((i) => caps.intents.includes(i)),
    outcomeCounts,
    failureRate: declared.length === 0 ? 0 : failed / declared.length,
    unadjudicated: all.reduce((n, s) => n + s.unadjudicated, 0),
    unstableCases: [...byCase.entries()].filter(([, o]) => o.size > 1).map(([id]) => id).sort(),
    effectiveF1: pick((m) => m.effectiveF1),
    graphEffectiveF1: pick((m) => m.graphEffectiveF1),
    answeredF1: pick((m) => m.answeredF1),
    precision: pick((m) => m.precision),
    recall: pick((m) => m.recall),
    confidentFalseEmptyRate: pick((m) => m.confidentFalseEmptyRate),
    graphConfidentFalseEmptyRate: pick((m) => m.graphConfidentFalseEmptyRate),
    absenceFalsePositiveRate: pick((m) => m.absenceFalsePositiveRate),
    latencyMs: spreadOf(declared.filter((s) => !NOT_ANSWERED.includes(s.outcome)).map((s) => s.latencyMs)),
  };
}

// ─── preregistration + decision ───────────────────────────────────────────────

/**
 * The keep / switch / drop bars, fixed BEFORE any arm runs (D-011 "preregistered
 * thresholds"). Changing any value changes the preregistration hash, so a bar
 * moved after the data is visible cannot pass as the original design.
 */
export const FAIR_DECISION_BARS = Object.freeze({
  /** Minimum full repetitions per arm. */
  minReps: 3,
  /** An eligible backend may crash or time out on at most this share of declared attempts. */
  maxFailureRate: 0.05,
  /** Arms within this much graph effective-F1 of the best are a tie. */
  f1TieMargin: 0.05,
  /** ...provided their graph confident-false-empty rate is at most this much worse. */
  cfeTieMargin: 0.02,
});

/** Among tied arms, the least encumbered wins — first-party, then permissive. */
const LICENCE_PREFERENCE: readonly LicenceClass[] = ['first-party', 'permissive', 'noncommercial'];

export interface Preregistration {
  readonly corpusIds: readonly string[];
  readonly corpusHash: string;
  readonly keyHash: string;
  readonly arms: readonly ArmCapabilities[];
  readonly reps: number;
  readonly seed: number;
  readonly bars: typeof FAIR_DECISION_BARS;
  readonly budgets: Readonly<ResourceBudget>;
  /** Optional native cohort protocol; frozen before observations, including missing instruments. */
  readonly protocol?: FairEvaluationProtocol;
  readonly hash: string;
}

export interface FairEvaluationProtocol {
  readonly edition: string;
  readonly languages: readonly string[];
  readonly matchedIntents: readonly FairIntent[];
  readonly sourceCommit: string;
  readonly fixtureHash: string;
  readonly measurements: readonly {
    readonly metric: 'setup-wall' | 'cold-query' | 'warm-query' | 'peak-memory' | 'resident-memory' | 'index-disk' | 'agent-task';
    readonly unit: 'ms' | 'MiB' | 'outcome';
    readonly method: string;
    readonly unavailable: string;
  }[];
  readonly correctness: {
    readonly minEffectiveF1: number;
    readonly maxConfidentFalseEmptyRate: number;
    readonly maxAbsenceFalsePositiveRate: number;
    readonly maxStaleAnswerRate: number;
    readonly pooling: string;
  };
  readonly realTaskCoverage: readonly { readonly language: string; readonly refs: readonly string[]; readonly unavailable: string | null }[];
}

// Protocols are ordinary JSON, so a saved edition can be reconstructed without
// an engine or a process. Sort object keys; array order remains part of the protocol.
function canonicalProtocol(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalProtocol);
  if (value !== null && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonicalProtocol(v)]),
  );
  return value;
}

function freezeProtocol<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeProtocol(child);
    Object.freeze(value);
  }
  return value;
}

function validateProtocol(protocol: FairEvaluationProtocol, cases: readonly FairCase[]): void {
  if (!protocol.edition.trim() || !/^[a-f0-9]{40}$/.test(protocol.sourceCommit) || !/^[a-f0-9]{64}$/.test(protocol.fixtureHash))
    throw new Error('preregistration refused: protocol needs an edition and full source commit');
  if (!protocol.languages.length || new Set(protocol.languages).size !== protocol.languages.length ||
    !protocol.matchedIntents.length || new Set(protocol.matchedIntents).size !== protocol.matchedIntents.length ||
    protocol.matchedIntents.some(intent => !FAIR_INTENTS.includes(intent)))
    throw new Error('preregistration refused: duplicate or missing protocol language/intent');
  const metrics = ['setup-wall', 'cold-query', 'warm-query', 'peak-memory', 'resident-memory', 'index-disk', 'agent-task'];
  if (protocol.measurements.length !== metrics.length || metrics.some(metric =>
    protocol.measurements.filter(m => m.metric === metric && m.method.trim() && m.unavailable.trim() &&
      m.unit === (metric === 'agent-task' ? 'outcome' : metric.includes('memory') || metric === 'index-disk' ? 'MiB' : 'ms')).length !== 1))
    throw new Error('preregistration refused: measurement protocol is incomplete');
  const thresholds = protocol.correctness;
  if ([thresholds.minEffectiveF1, thresholds.maxConfidentFalseEmptyRate,
    thresholds.maxAbsenceFalsePositiveRate, thresholds.maxStaleAnswerRate]
    .some(v => !Number.isFinite(v) || v < 0 || v > 1) || !thresholds.pooling.trim())
    throw new Error('preregistration refused: correctness thresholds are incomplete');
  for (const language of protocol.languages) {
    const cohort = cases.filter(c => c.language === language);
    for (const intent of protocol.matchedIntents) {
      const matched = cohort.filter(c => c.intent === intent && c.configuration === 'configured' && c.sourceState === 'current');
      if (!matched.some(c => c.tags.includes('absence')) || !matched.some(c => !c.tags.includes('absence')))
        throw new Error(`preregistration refused: ${language}/${intent} lacks matched positive/absence controls`);
    }
    if (!cohort.some(c => c.configuration === 'unconfigured') ||
      !cohort.some(c => c.sourceState === 'stale') || !cohort.some(c => c.sourceState === 'deleted'))
      throw new Error(`preregistration refused: ${language} lacks configuration/freshness controls`);
    const coverage = protocol.realTaskCoverage.filter(c => c.language === language);
    if (coverage.length !== 1 || (!coverage[0]!.refs.length && !coverage[0]!.unavailable?.trim()) ||
      coverage[0]!.refs.some(ref => !cases.some(c => c.language === language && c.taskRef === ref && c.source !== 'authored')))
      throw new Error(`preregistration refused: ${language} real task coverage is missing or ungrounded`);
  }
  if (cases.some(c => !/^[a-f0-9]{64}$/.test(c.sourceFingerprint ?? '') || !c.taskRef || !c.language || !protocol.languages.includes(c.language)))
    throw new Error('preregistration refused: protocol cases need source pins and task references');
}

/** Recompute a persisted registration; caller-controlled hash fields are not proof. */
export function hashPreregistration(prereg: Omit<Preregistration, 'hash'>): string {
  const budgets = prereg.budgets;
  const body = {
    corpusIds: [...prereg.corpusIds].sort(), corpusHash: prereg.corpusHash, keyHash: prereg.keyHash,
    arms: [...prereg.arms].map(a => ({ ...a, intents: [...a.intents].sort() }))
      .sort((a, b) => a.armId.localeCompare(b.armId)),
    reps: prereg.reps, seed: prereg.seed,
    bars: { minReps: prereg.bars.minReps, maxFailureRate: prereg.bars.maxFailureRate,
      f1TieMargin: prereg.bars.f1TieMargin, cfeTieMargin: prereg.bars.cfeTieMargin },
    budgets: { coldStartMsMax: budgets.coldStartMsMax, warmQueryMsMax: budgets.warmQueryMsMax,
      rssMbMax: budgets.rssMbMax, childProcMax: budgets.childProcMax,
      indexDiskMbMax: budgets.indexDiskMbMax, resultTokensMax: budgets.resultTokensMax },
    ...(prereg.protocol ? { protocol: canonicalProtocol(prereg.protocol) } : {}),
  };
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

/** Freeze complete corpus, key, arms, resource budgets, repetitions and bars. */
export function preregister(input: {
  readonly cases: readonly FairCase[];
  readonly keys: readonly AnswerKey[];
  readonly arms: readonly ArmCapabilities[];
  readonly reps: number;
  readonly seed: number;
  readonly budgets?: Readonly<ResourceBudget>;
  readonly protocol?: FairEvaluationProtocol;
}): Preregistration {
  const corpusIds = input.cases.map((c) => c.id).sort();
  if (new Set(corpusIds).size !== corpusIds.length) throw new Error('preregistration refused: duplicate case ids');
  if (new Set(input.keys.map(k => k.caseId)).size !== input.keys.length) throw new Error('preregistration refused: duplicate key ids');
  if (new Set(input.arms.map(a => a.armId)).size !== input.arms.length) throw new Error('preregistration refused: duplicate arm ids');
  if (!Number.isInteger(input.reps) || input.reps < FAIR_DECISION_BARS.minReps || !Number.isInteger(input.seed))
    throw new Error('preregistration refused: repetitions and seed must be integers with at least the minimum repetitions');
  const keyIds = new Set(input.keys.map((k) => k.caseId));
  const missing = corpusIds.filter((id) => !keyIds.has(id));
  if (missing.length > 0) throw new Error(`preregistration refused: no answer key for ${missing.join(', ')}`);
  if (input.keys.some(k => !corpusIds.includes(k.caseId))) throw new Error('preregistration refused: foreign answer key');
  if (input.protocol) validateProtocol(input.protocol, input.cases);
  const keyHash = hashKeys(input.keys);
  const budgets = Object.freeze({ ...(input.budgets ?? DEFAULT_RESOURCE_BUDGET) });
  if ((Object.keys(DEFAULT_RESOURCE_BUDGET) as Array<keyof ResourceBudget>)
    .some(key => !Number.isFinite(budgets[key]) || budgets[key] <= 0))
    throw new Error('preregistration refused: resource budgets must be positive finite ceilings');
  const arms = [...input.arms]
    .map((a) => Object.freeze({ ...a, intents: Object.freeze([...a.intents].sort()) }))
    .sort((a, b) => a.armId.localeCompare(b.armId));
  const body = { corpusIds: Object.freeze(corpusIds), corpusHash: hashCases(input.cases), keyHash,
    arms: Object.freeze(arms), reps: input.reps, seed: input.seed, bars: FAIR_DECISION_BARS, budgets,
    ...(input.protocol ? { protocol: freezeProtocol(structuredClone(input.protocol)) } : {}) };
  return Object.freeze({ ...body, hash: hashPreregistration(body) });
}

export type BackendDecision =
  | { readonly kind: 'keep'; readonly arm: string; readonly reason: string }
  | { readonly kind: 'switch'; readonly arm: string; readonly reason: string }
  | { readonly kind: 'drop-third-party'; readonly arm: string; readonly reason: string }
  | { readonly kind: 'inconclusive'; readonly reason: string };

/**
 * The preregistered rule. Eligible backends declare every graph intent, ran the
 * required repetitions, have a fully adjudicated pool, and stay under the
 * failure bar. The best by median graph effective-F1 sets the bar; every arm
 * within the tie margins is a co-winner, and the least encumbered licence among
 * co-winners is chosen. First-party ⇒ drop third-party; noncommercial (GitNexus)
 * ⇒ keep; permissive ⇒ switch.
 */
export function decideBackend(aggs: readonly ArmAggregate[], prereg: Pick<Preregistration, 'reps'>): BackendDecision {
  const bars = FAIR_DECISION_BARS;
  const pending = aggs.filter((a) => a.unadjudicated > 0).map((a) => a.armId);
  if (pending.length > 0) return { kind: 'inconclusive', reason: `unadjudicated sites remain for ${pending.join(', ')}` };
  const short = aggs.filter((a) => a.reps < Math.max(bars.minReps, prereg.reps)).map((a) => a.armId);
  if (short.length > 0) return { kind: 'inconclusive', reason: `fewer than the preregistered repetitions: ${short.join(', ')}` };

  const eligible = aggs.filter(
    (a) => a.declaresGraphIntents && a.failureRate <= bars.maxFailureRate && a.graphEffectiveF1.median !== null,
  );
  if (eligible.length === 0) return { kind: 'inconclusive', reason: 'no arm is an eligible graph backend' };

  const f1 = (a: ArmAggregate) => a.graphEffectiveF1.median ?? 0;
  const cfe = (a: ArmAggregate) => a.graphConfidentFalseEmptyRate.median ?? 0;
  const best = [...eligible].sort((a, b) => f1(b) - f1(a) || cfe(a) - cfe(b))[0]!;
  const tied = eligible.filter((a) => f1(a) >= f1(best) - bars.f1TieMargin && cfe(a) <= cfe(best) + bars.cfeTieMargin);
  const chosen = [...tied].sort(
    (a, b) =>
      LICENCE_PREFERENCE.indexOf(a.licence) - LICENCE_PREFERENCE.indexOf(b.licence) || f1(b) - f1(a) || cfe(a) - cfe(b),
  )[0]!;
  const reason =
    `best graph effective-F1 ${f1(best).toFixed(3)} (${best.armId}); ` +
    `${tied.length} arm(s) within ${bars.f1TieMargin} F1 / ${bars.cfeTieMargin} CFE: ${tied.map((a) => a.armId).join(', ')}; ` +
    `chose ${chosen.armId} (${chosen.licence}, F1 ${f1(chosen).toFixed(3)}, CFE ${cfe(chosen).toFixed(3)})`;
  if (chosen.licence === 'first-party') return { kind: 'drop-third-party', arm: chosen.armId, reason };
  if (chosen.licence === 'noncommercial') return { kind: 'keep', arm: chosen.armId, reason };
  return { kind: 'switch', arm: chosen.armId, reason };
}
