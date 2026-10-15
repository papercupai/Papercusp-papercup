/**
 * contamination.ts — the benchmark freshness / contamination policy (WI-10008258;
 * benchmark-coverage-frontierswe-v2-2026-10-10 P-009, clause FSWE-P009-CONTAMINATION@1).
 *
 * A model can have seen a task (its issue, its fix, its tests) if the task existed before the model's
 * training data was collected. A headline score over such tasks measures recall as much as ability, so:
 *   1. every evaluated model is looked up against a SOURCED training-data cutoff ({@link MODEL_TRAINING_CUTOFFS});
 *   2. every task's creation date is compared with that cutoff;
 *   3. each arm's headline carries a label — `contamination-exposed` when any assigned task predates the
 *      cutoff, `contamination-unknown` when a task is undated or the model's cutoff is unknown, and
 *      `post-cutoff` only when every assigned task is provably newer than the cutoff;
 *   4. the post-cutoff, exposed and unknown subsets are reported separately, each with its own primary
 *      outcome, so the post-cutoff figure (SWE-rebench / SWE-bench-Live style) is the one a headline
 *      claim should prefer.
 * An unknown is never treated as clean: a missing date or a missing cutoff yields `contamination-unknown`.
 *
 * Pure: no disk, no network, no PG, no clock.
 */
import { summarizeAssignedOutcomes } from '@papercusp/bench-metrics';
import { normalizeModelId } from '@papercusp/model-pricing';

export const CONTAMINATION_POLICY_VERSION = 'bench-contamination-policy/v1' as const;

export type ContaminationLabel = 'post-cutoff' | 'contamination-exposed' | 'contamination-unknown';

/** Where one task falls relative to one model's training-data cutoff. */
export type TaskExposure = 'post-cutoff' | 'exposed' | 'unknown';

/**
 * The vendor's own label for a published cutoff. Anthropic publishes a "training data cutoff" and a narrower
 * "reliable knowledge cutoff"; we record the training data cutoff. OpenAI publishes only a "knowledge cutoff"
 * and does not define it on the model page, so it is recorded verbatim under that label. If OpenAI's training
 * data runs past it, a 'knowledge cutoff' row can under-report exposure, so a reader weighing a post-cutoff
 * headline should check this label.
 */
export type CutoffTerm = 'training data cutoff' | 'knowledge cutoff';

/** A vendor-published cutoff for one concrete model id. */
export interface TrainingCutoffFact {
  /** `YYYY-MM` (vendor month precision) or `YYYY-MM-DD` (vendor day precision). Never the narrower "reliable knowledge cutoff". */
  trainingDataCutoff: string;
  /** The vendor's label for {@link trainingDataCutoff}, as printed on {@link source}. */
  vendorTerm: CutoffTerm;
  /** The page the value was read from. */
  source: string;
  /** When it was read (`YYYY-MM-DD`). */
  retrievedAt: string;
}

const ANTHROPIC_MODELS_OVERVIEW = 'https://platform.claude.com/docs/en/models/overview';
const anthropicModelPage = (slug: string) => `https://platform.claude.com/docs/en/models/${slug}/overview`;
const openaiModelPage = (id: string) => `https://developers.openai.com/api/docs/models/${id}`;
const RETRIEVED = '2026-10-11';

const anthropic = (trainingDataCutoff: string, source: string): TrainingCutoffFact =>
  ({ trainingDataCutoff, vendorTerm: 'training data cutoff', source, retrievedAt: RETRIEVED });
const openai = (id: string, knowledgeCutoff: string): TrainingCutoffFact =>
  ({ trainingDataCutoff: knowledgeCutoff, vendorTerm: 'knowledge cutoff', source: openaiModelPage(id), retrievedAt: RETRIEVED });

/**
 * Curated (derived-truth ladder rung 4): a training cutoff is a vendor statement about training data, which
 * no code in this repo can derive, pin or attest. Every row cites the page it was read from. A model with
 * no row here has an UNKNOWN cutoff, and its reports are labelled `contamination-unknown` — add a row (with
 * its source) rather than guessing. Ids are bare concrete ids, as {@link normalizeModelId} produces. Lookup is
 * exact: a dated snapshot id the vendor page does not name stays unknown rather than inheriting its alias's row.
 *
 * Priced ids with no row, deliberately: the retired Opus and Sonnet releases
 * (platform.claude.com model-deprecations) and no longer have a vendor model page to cite.
 */
export const MODEL_TRAINING_CUTOFFS: Readonly<Record<string, TrainingCutoffFact>> = Object.freeze({
  'claude-fable-5-1': anthropic('2026-06', ANTHROPIC_MODELS_OVERVIEW),
  'claude-opus-5-5': anthropic('2026-06', ANTHROPIC_MODELS_OVERVIEW),
  'claude-sonnet-5-5': anthropic('2026-06', ANTHROPIC_MODELS_OVERVIEW),
  'claude-haiku-5-5': anthropic('2026-06', ANTHROPIC_MODELS_OVERVIEW),
  'claude-opus-5': anthropic('2026-05', anthropicModelPage('opus-5')),
  'claude-fable-5': anthropic('2026-01', anthropicModelPage('fable-5')),
  'claude-sonnet-5': anthropic('2026-01', anthropicModelPage('sonnet-5')),
  'claude-opus-4-8': anthropic('2026-01', anthropicModelPage('opus-4-8')),
  'claude-opus-4-7': anthropic('2026-01', anthropicModelPage('opus-4-7')),
  'claude-sonnet-4-6': anthropic('2026-01', anthropicModelPage('sonnet-4-6')),
  'claude-opus-4-6': anthropic('2025-08', anthropicModelPage('opus-4-6')),
  'claude-opus-4-5': anthropic('2025-08', anthropicModelPage('opus-4-5')),
  'claude-sonnet-4-5': anthropic('2025-07', anthropicModelPage('sonnet-4-5')),
  'claude-haiku-4-5': anthropic('2025-07', anthropicModelPage('haiku-4-5')),
  'gpt-6.1-sol': openai('gpt-6.1-sol', '2026-04-30'),
  'gpt-6-luna': openai('gpt-6-luna', '2026-05-18'),
  'gpt-6-astra': openai('gpt-6-astra', '2026-04-30'),
  'gpt-6-sol': openai('gpt-6-sol', '2026-04-20'),
  'gpt-5.6': openai('gpt-5.6', '2026-02-16'),
  'gpt-5.6-sol': openai('gpt-5.6-sol', '2026-02-16'),
  'gpt-5.6-luna': openai('gpt-5.6-luna', '2026-02-16'),
  'gpt-5.6-terra': openai('gpt-5.6-terra', '2026-02-16'),
  'gpt-5.5': openai('gpt-5.5', '2025-12-01'),
  'gpt-5.4': openai('gpt-5.4', '2025-08-31'),
  'gpt-5.4-mini': openai('gpt-5.4-mini', '2025-08-31'),
  'gpt-5': openai('gpt-5', '2024-09-30'),
  'gpt-4o': openai('gpt-4o', '2023-10-01'),
  'gpt-4o-mini': openai('gpt-4o-mini', '2023-10-01'),
});

const CUTOFF_RE = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/;

/** The sourced cutoff for a model id (bare, vendor-prefixed or suffixed); null when unknown. */
export function trainingCutoffFor(modelId: string | null | undefined): TrainingCutoffFact | null {
  if (!modelId) return null;
  return MODEL_TRAINING_CUTOFFS[normalizeModelId(modelId)] ?? null;
}

/**
 * The first instant AFTER a cutoff's coverage. Month precision covers the whole month (a task created in
 * the cutoff month may be in the training data), so `2026-06` ends at 2026-07-01T00:00Z.
 */
export function trainingCutoffEnd(cutoff: string): Date {
  const m = CUTOFF_RE.exec(cutoff);
  if (!m) throw new Error(`contamination: training cutoff "${cutoff}" is not YYYY-MM or YYYY-MM-DD`);
  const [year, month, day] = [Number(m[1]), Number(m[2]), m[3] === undefined ? null : Number(m[3])];
  if (month < 1 || month > 12 || (day !== null && (day < 1 || day > 31))) {
    throw new Error(`contamination: training cutoff "${cutoff}" is not a calendar date`);
  }
  return day === null ? new Date(Date.UTC(year, month, 1)) : new Date(Date.UTC(year, month - 1, day + 1));
}

/** Classify one task. An absent or unparseable creation date, or an unknown cutoff, is `unknown` — never clean. */
export function classifyTaskExposure(taskCreatedAt: string | null | undefined, cutoff: string | null): TaskExposure {
  if (cutoff === null || !taskCreatedAt) return 'unknown';
  const created = Date.parse(taskCreatedAt);
  if (!Number.isFinite(created)) return 'unknown';
  return created < trainingCutoffEnd(cutoff).getTime() ? 'exposed' : 'post-cutoff';
}

/** The arm label: any exposed task dominates; any unknown blocks a clean label; an empty pool is unknown. */
export function contaminationLabelFor(exposures: readonly TaskExposure[]): ContaminationLabel {
  if (exposures.includes('exposed')) return 'contamination-exposed';
  if (exposures.length === 0 || exposures.includes('unknown')) return 'contamination-unknown';
  return 'post-cutoff';
}

/** One subset of an arm's assigned tasks and the primary outcome over just that subset. */
export interface ContaminationSubset {
  taskIds: string[];
  /** Task-weighted primary resolved FRACTION in [0,1] over the subset (failures and absent attempts included); null when empty. */
  primaryResolvedPct: number | null;
  /** Primary mean score over the subset, for partial-credit suites; null when empty or unscored. */
  primaryMeanScore: number | null;
}

/** The contamination verdict for one arm's headline. */
export interface ArmContamination {
  policy: typeof CONTAMINATION_POLICY_VERSION;
  label: ContaminationLabel;
  modelId: string;
  trainingDataCutoff: string | null;
  /** Where the cutoff came from: a {@link MODEL_TRAINING_CUTOFFS} source URL, `caller-supplied`, or null when unknown. */
  cutoffSource: string | null;
  /** The vendor's label for {@link trainingDataCutoff} ({@link CutoffTerm}); null when unknown or caller-supplied. */
  cutoffTerm: CutoffTerm | null;
  postCutoff: ContaminationSubset;
  exposed: ContaminationSubset;
  unknown: ContaminationSubset;
}

type OutcomeRow = Parameters<typeof summarizeAssignedOutcomes>[0][number];

/**
 * Judge one arm. `trainingCutoffOverride`: `undefined` = use {@link MODEL_TRAINING_CUTOFFS}; a string = a
 * cutoff the caller pinned (e.g. read from a stored run record); `null` = explicitly unknown.
 */
export function armContamination(input: {
  modelId: string;
  assignedTaskIds: readonly string[];
  assignedSeeds?: readonly number[];
  rows: readonly OutcomeRow[];
  taskCreatedAt?: Readonly<Record<string, string | null | undefined>>;
  trainingCutoffOverride?: string | null;
}): ArmContamination {
  const fact = input.trainingCutoffOverride === undefined ? trainingCutoffFor(input.modelId) : null;
  const cutoff = input.trainingCutoffOverride === undefined ? fact?.trainingDataCutoff ?? null : input.trainingCutoffOverride;
  const cutoffSource = input.trainingCutoffOverride === undefined ? fact?.source ?? null : cutoff === null ? null : 'caller-supplied';
  if (cutoff !== null) trainingCutoffEnd(cutoff); // refuse a malformed pinned cutoff up front

  const byExposure: Record<TaskExposure, string[]> = { 'post-cutoff': [], exposed: [], unknown: [] };
  for (const taskId of input.assignedTaskIds) byExposure[classifyTaskExposure(input.taskCreatedAt?.[taskId], cutoff)].push(taskId);

  const subset = (taskIds: string[]): ContaminationSubset => {
    if (!taskIds.length) return { taskIds, primaryResolvedPct: null, primaryMeanScore: null };
    const ids = new Set(taskIds);
    const outcome = summarizeAssignedOutcomes(
      input.rows.filter((row) => ids.has(row.taskId)),
      { assignedTaskIds: taskIds, assignedSeeds: input.assignedSeeds },
    );
    return { taskIds, primaryResolvedPct: outcome.primaryResolvedPct, primaryMeanScore: outcome.primaryMeanScore };
  };

  return {
    policy: CONTAMINATION_POLICY_VERSION,
    label: contaminationLabelFor(input.assignedTaskIds.map((id) => classifyTaskExposure(input.taskCreatedAt?.[id], cutoff))),
    modelId: input.modelId,
    trainingDataCutoff: cutoff,
    cutoffSource,
    cutoffTerm: fact?.vendorTerm ?? null,
    postCutoff: subset(byExposure['post-cutoff']),
    exposed: subset(byExposure.exposed),
    unknown: subset(byExposure.unknown),
  };
}
