/**
 * Answer-usefulness tier (mdenseon-adoption-measurements-2026-10-01 P-008).
 *
 * The retrieval tiers (P-004) score ranked keys against independent gold
 * labels. This tier asks the downstream question: with the SAME answer model,
 * SAME prompt and SAME context budget, does an arm's retrieved context let an
 * agent answer correctly, cite the right source and decline when nothing in
 * the corpus answers the question?
 *
 * Reused, not forked:
 *   - judging rides the llm-testing framework's `judgeRun()` (as the T3 judged
 *     tier does), with a versioned rubric derived from every prompt layer;
 *   - receipts use the judged tier's crash-safe `writeBlindReceipt`;
 *   - paired uncertainty uses `pairedBootstrap` (fusion-score-aware).
 *
 * Contracts enforced here (specs AUTO-BAR-R-7-P-008 and
 * MDENSE-blinded-answer-score):
 *   - every arm report must share the snapshot, gold labels, corpus and query
 *     set; the answer model, prompt, route and context budget are frozen in
 *     `ANSWER_CONTRACT` and identical across arms;
 *   - the judge request is built ONLY from arm-independent inputs (question,
 *     numbered sources, answer, reference). `assertJudgeBlind` re-checks every
 *     judge request at the transport seam, and `acceptJudgedScore` refuses any
 *     judgment that lacks that verification;
 *   - an answer or judgment is reused from a receipt only on an exact
 *     request-fingerprint match; a mismatching receipt is an error, never a
 *     silent re-call or a silent reuse.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  deriveRubricVersion,
  judgeRun,
  JUDGE_PROMPT_SCAFFOLD_VERSION,
  type JudgeRubric,
  type LlmCallFn,
  type PersonaTraits,
  type RunSummary,
} from '@papercusp/testing-shell/llm';

import { writeBlindReceipt } from './judged';
import { pairedBootstrap } from './fusion-score-aware';
import type { HeldoutQuery, Snapshot } from './candidate-hybrid-bench';

type LlmCallOpts = Parameters<LlmCallFn>[0];
type LlmCallResult = Awaited<ReturnType<LlmCallFn>>;

// =============================================================================
// Frozen contracts
// =============================================================================

export const ABSTAIN_TOKEN = 'INSUFFICIENT_EVIDENCE';

/** Everything that shapes the answer request. Identical for every arm. */
export const ANSWER_CONTRACT = {
  version: 1,
  model: 'claude-haiku-4-5',
  temperature: 0,
  maxTokens: 700,
  route: 'pull',
  k: 5,
  passageChars: 1600,
  system:
    'You answer a question for a software agent using ONLY the numbered sources provided. ' +
    'Cite every claim with the source label in square brackets, e.g. [S2]. ' +
    `If the sources do not contain the answer, reply with exactly ${ABSTAIN_TOKEN} and nothing else. ` +
    'Do not use outside knowledge. Be concise.',
  userTemplate: 'Question: {question}\n\nSources:\n{sources}\n\nAnswer:',
} as const;

export const ANSWER_CONTRACT_HASH = sha256Text(stableStringify(ANSWER_CONTRACT));

export const ANSWER_RUBRIC_CONTENT: Pick<JudgeRubric, 'axes'> = {
  axes: [
    {
      id: 'correctness',
      description:
        'Does the ANSWER deliver the correct answer to the QUESTION, as established by the REFERENCE? ' +
        `When the reference states that no source answers the question, a decline (${ABSTAIN_TOKEN}) is ideal ` +
        'and any substantive answer is bad. When the reference contains the answer, a decline delivers nothing and is bad.',
      anchors: {
        bad: 'Wrong, contradicts the reference, declines an answerable question, or answers an unanswerable one.',
        ideal: 'Fully correct per the reference, or a decline when the reference marks the question unanswerable.',
      },
    },
    {
      id: 'grounding',
      description:
        'Is every substantive claim in the ANSWER supported by the numbered SOURCE it cites ([S1], [S2], ...), ' +
        'with no claim beyond the sources and no citation of a source that does not state the claim? ' +
        'A decline that makes no claim is fully grounded.',
      anchors: {
        bad: 'Claims are absent from the sources, uncited, or cite a source that does not support them.',
        ideal: 'Every claim is stated by a cited source.',
      },
    },
  ],
};

/** Every caller-authored value that reaches the judge prompt (placeholders for per-row text). */
export const ANSWER_JUDGE_INSTRUCTIONS = {
  scenarioId: 'answer-usefulness',
  scenarioTemplate:
    'Grounded question answering. An assistant was given a QUESTION and numbered SOURCES and asked to answer ' +
    `using only those sources with [S#] citations, or to reply ${ABSTAIN_TOKEN} when they do not contain the answer.\n\n` +
    'QUESTION:\n{question}\n\nSOURCES SHOWN TO THE ASSISTANT:\n{sources}\n\n' +
    'REFERENCE (independently labelled material that answers the question; the assistant did not see this):\n{reference}',
  noReference: '(none: no source in the corpus answers this question, so the correct behavior is to decline)',
  noSources: '(no sources were retrieved)',
  personaSummary: 'n/a: non-interactive grounded-answer bench (no sim-user)',
  goalSummary: 'A correct, source-grounded answer, or a decline when the sources cannot support one.',
  transcriptTemplate: '{answer}',
} as const;

export const ANSWER_RUBRIC_VERSION = deriveRubricVersion('answer-usefulness', {
  rubric: ANSWER_RUBRIC_CONTENT,
  instructions: ANSWER_JUDGE_INSTRUCTIONS,
  scaffold: JUDGE_PROMPT_SCAFFOLD_VERSION,
});

export const ANSWER_RUBRIC: JudgeRubric = { version: ANSWER_RUBRIC_VERSION, ...ANSWER_RUBRIC_CONTENT };

/** Frozen blind judge. Two passes: temperature 0 (primary) and 0.4 (agreement). */
export const ANSWER_JUDGE_MODEL = 'claude-sonnet-4-6';
export const JUDGE_PASS_TEMPERATURES = [0, 0.4] as const;
/** An axis score at or above this is a pass. */
export const ANSWER_PASS_BAR = 4;

// =============================================================================
// Shapes
// =============================================================================

export interface ArmReportRow {
  id: string; class: string; group: string; expected: string[];
  routes: Partial<Record<string, { rankedKeys: string[] }>>;
}
export interface ArmReport {
  runner: string; model: string; corpus: 'memory' | 'prose';
  binding?: { profileId?: string; schema?: string; syntheticEmbedder?: boolean };
  inputs: { snapshotSha256: string; goldSha256: string };
  rows: ArmReportRow[];
}
export interface Passage { label: string; key: string; text: string }

export interface BlindAttestation { verified: true; requestSha256: string[]; forbiddenChecked: number }
export interface JudgePass {
  temperature: number; fingerprint: string; scores: Record<string, number>; notes?: string;
  costUsd: number; blind: BlindAttestation; replayed: boolean;
  /** The judge returned no usable score on some axis even after judgeRun's repair turn. */
  inconclusive: boolean;
}
export interface ArmOutcome {
  contextKeys: string[]; contextHasGold: boolean;
  answerFingerprint: string; answer: string; answerCostUsd: number; answerReplayed: boolean;
  abstained: boolean; citedLabels: string[]; invalidCitations: string[];
  citationGoldPrecision: number | null;
  passes: JudgePass[];
  /** null when the primary judgment is inconclusive (excluded from judged metrics, counted in the report). */
  correct: boolean | null; grounded: boolean | null;
  /** answerable: correct AND grounded AND not declined; unanswerable: declined (deterministic). */
  useful: boolean | null;
  /** Substantive answer to an unanswerable question, or a substantive answer the judge found ungrounded. */
  unsupportedAnswer: boolean | null;
}

// =============================================================================
// Pure helpers
// =============================================================================

export function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}
function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fill(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key]! : whole);
}

export function buildPassages(keys: readonly string[], texts: ReadonlyMap<string, string>): Passage[] {
  return keys.slice(0, ANSWER_CONTRACT.k).map((key, i) => {
    const text = texts.get(key);
    if (text === undefined) throw new Error(`context key ${key} is not in the snapshot corpus`);
    return { label: `S${i + 1}`, key, text: text.slice(0, ANSWER_CONTRACT.passageChars) };
  });
}

export function renderSources(passages: readonly Passage[]): string {
  return passages.length
    ? passages.map((p) => `[${p.label}] ${p.text}`).join('\n\n')
    : ANSWER_JUDGE_INSTRUCTIONS.noSources;
}

export function buildAnswerRequest(question: string, passages: readonly Passage[]) {
  return {
    model: ANSWER_CONTRACT.model,
    system: ANSWER_CONTRACT.system,
    user: fill(ANSWER_CONTRACT.userTemplate, { question, sources: renderSources(passages) }),
    temperature: ANSWER_CONTRACT.temperature,
    maxTokens: ANSWER_CONTRACT.maxTokens,
  };
}

export function parseAnswer(text: string, passageCount: number): {
  abstained: boolean; citedLabels: string[]; invalidCitations: string[];
} {
  const trimmed = text.trim();
  const abstained = trimmed === ABSTAIN_TOKEN || trimmed.startsWith(ABSTAIN_TOKEN);
  const cited = [...new Set([...trimmed.matchAll(/\[S(\d+)\]/g)].map((m) => `S${m[1]}`))];
  const invalid = cited.filter((l) => Number(l.slice(1)) < 1 || Number(l.slice(1)) > passageCount);
  return { abstained, citedLabels: cited, invalidCitations: invalid };
}

/** Inputs the judge may see. Arm identity is deliberately not a field. */
export interface JudgeInputs { question: string; sources: string; reference: string; answer: string }

export function buildJudgeInputs(question: string, passages: readonly Passage[], referenceTexts: readonly string[], answer: string): JudgeInputs {
  return {
    question,
    sources: renderSources(passages),
    reference: referenceTexts.length
      ? referenceTexts.map((t, i) => `[R${i + 1}] ${t.slice(0, ANSWER_CONTRACT.passageChars)}`).join('\n\n')
      : ANSWER_JUDGE_INSTRUCTIONS.noReference,
    answer,
  };
}

export class BlindingViolation extends Error {}

/**
 * Refuse a judge request that carries an arm identifier outside the
 * arm-independent content. Content strings (question, sources, reference,
 * answer) are removed first, so a corpus passage that legitimately mentions a
 * model name does not trip the guard; anything left over is scaffold, and the
 * scaffold must never name an arm. Assistant turns (the judge's own earlier
 * output in a repair turn) derive from blind inputs and are not checked.
 */
export function assertJudgeBlind(request: Pick<LlmCallOpts, 'system' | 'messages'>, inputs: JudgeInputs, forbidden: readonly string[]): BlindAttestation {
  const content = [inputs.question, inputs.sources, inputs.reference, inputs.answer].filter((c) => c.length > 0);
  const texts = [request.system ?? '', ...request.messages.filter((m) => m.role !== 'assistant').map((m) => m.content)];
  const tokens = [...new Set(forbidden.map((f) => f.trim().toLowerCase()).filter((f) => f.length >= 3))];
  if (tokens.length === 0) throw new BlindingViolation('no arm identifiers supplied: the blinding check would be vacuous');
  for (const text of texts) {
    let scaffold = text;
    for (const c of content) scaffold = scaffold.split(c).join('\u0000');
    const lower = scaffold.toLowerCase();
    const hit = tokens.find((t) => lower.includes(t));
    if (hit) throw new BlindingViolation(`judge request names arm identifier "${hit}" outside the arm-independent content`);
  }
  return { verified: true, requestSha256: texts.map(sha256Text), forbiddenChecked: tokens.length };
}

/** Downstream gate: a judged score counts only when its blinding was verified at the transport seam. */
export function acceptJudgedScore(pass: Pick<JudgePass, 'blind' | 'scores'>): Record<string, number> {
  const b = pass.blind as Partial<BlindAttestation> | undefined;
  if (!b || b.verified !== true || !Array.isArray(b.requestSha256) || b.requestSha256.length === 0 || !(Number(b.forbiddenChecked) > 0)) {
    throw new BlindingViolation('judged score refused: no verified blinding attestation');
  }
  return pass.scores;
}

const BENCH_PERSONA: PersonaTraits = {
  verbosity: 'terse', politeness: 'neutral', clarification: 'never_clarifies', goalClarity: 'precise', interrupts: false, modality: 'text',
};

function judgeRunSummary(fingerprint: string, answer: string, judgeModel: string): RunSummary {
  const now = new Date(0);
  return {
    runId: `answer-${fingerprint.slice(0, 16)}`, scenarioId: ANSWER_JUDGE_INSTRUCTIONS.scenarioId, scenarioVersion: 1,
    scenarioTarget: 'answer-bench', identityHash: `answer:${ANSWER_RUBRIC_VERSION}:${fingerprint}`,
    sutModel: 'withheld', judgeModel, personaId: 'answer-bench', personaTraits: BENCH_PERSONA,
    workspaceMode: 'isolated', transportMode: 'in-process',
    turns: [{ assistantText: fill(ANSWER_JUDGE_INSTRUCTIONS.transcriptTemplate, { answer }), toolCalls: [], toolResults: [], cards: [],
      controlTags: [], costUsd: 0, latencyMs: 0, finishReason: 'done', rawSseTape: [] }],
    toolInvocations: [], continueChainRows: [], totalCostUsd: 0, startedAt: now, finishedAt: now,
    finishReason: 'completed', capBreaches: [],
  };
}

/** judgeRun reports an unparseable or missing axis as 0; the rubric scale is 1..5. */
export function usableScores(scores: Record<string, number>): boolean {
  return ANSWER_RUBRIC.axes.every((axis) => {
    const s = scores[axis.id];
    return typeof s === 'number' && Number.isFinite(s) && s >= 1 && s <= 5;
  });
}

/** Cohen's kappa for two binary raters. */
export function cohenKappa(a: readonly boolean[], b: readonly boolean[]): number | null {
  const n = a.length;
  if (n === 0 || n !== b.length) return null;
  let agree = 0; let aYes = 0; let bYes = 0;
  for (let i = 0; i < n; i++) { if (a[i] === b[i]) agree++; if (a[i]) aYes++; if (b[i]) bYes++; }
  const po = agree / n;
  const pe = (aYes / n) * (bYes / n) + (1 - aYes / n) * (1 - bYes / n);
  return pe === 1 ? (po === 1 ? 1 : null) : (po - pe) / (1 - pe);
}

// =============================================================================
// Receipts: exact-fingerprint replay
// =============================================================================

function readReceipt<T extends { fingerprint: string; request: unknown }>(file: string, fingerprint: string, request: unknown): T | null {
  if (!fs.existsSync(file)) return null;
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  if (saved.fingerprint !== fingerprint || stableStringify(saved.request) !== stableStringify(request)) {
    throw new Error(`receipt ${file} does not match its request fingerprint; refusing to reuse or overwrite it`);
  }
  return saved;
}

function costOf(r: LlmCallResult): number {
  if (!Number.isFinite(r.costUsd) || r.costUsd < 0) throw new Error('LLM result carries no finite cost');
  return r.costUsd;
}

// =============================================================================
// Runner
// =============================================================================

export interface AnswerUsefulnessOptions {
  reports: string[];
  snapshot: string;
  gold: string;
  receipts: string;
  out: string;
  llm: LlmCallFn;
  baseline?: string;
  concurrency?: number;
  /** Test queries to run, in report order; default all. */
  limit?: number;
  judgeModel?: string;
  bootstrapIters?: number;
  callContext?: Partial<LlmCallOpts>;
  /** Protocol tests only: accept synthetic-embedder arm reports. */
  allowSynthetic?: boolean;
}

export function loadArmReports(files: readonly string[], snapshotFile: string, goldFile: string, allowSynthetic = false) {
  if (files.length < 2) throw new Error('need at least two arm reports to compare');
  const snapshotSha256 = sha256File(snapshotFile);
  const goldSha256 = sha256File(goldFile);
  const reports = files.map((f) => ({ file: f, sha256: sha256File(f), report: JSON.parse(fs.readFileSync(f, 'utf8')) as ArmReport }));
  const corpus = reports[0]!.report.corpus;
  const ids = reports[0]!.report.rows.map((r) => r.id).join('\n');
  const models = new Set<string>();
  for (const { file, report } of reports) {
    if (report.runner !== 'complete-hybrid-bench') throw new Error(`${file}: not a complete-hybrid-bench report`);
    if (report.corpus !== corpus) throw new Error(`${file}: corpus ${report.corpus} differs from ${corpus}`);
    if (report.inputs.snapshotSha256 !== snapshotSha256) throw new Error(`${file}: built on a different snapshot`);
    if (report.inputs.goldSha256 !== goldSha256) throw new Error(`${file}: built on different gold labels`);
    if (report.rows.map((r) => r.id).join('\n') !== ids) throw new Error(`${file}: query set differs from the first report`);
    if (report.binding?.syntheticEmbedder && !allowSynthetic) throw new Error(`${file}: synthetic-embedder report is not a model measurement`);
    if (models.has(report.model)) throw new Error(`duplicate arm ${report.model}`);
    models.add(report.model);
  }
  return { reports, corpus, snapshotSha256, goldSha256 };
}

async function pool<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i]!); }
  });
  await Promise.all(workers);
}

export async function runAnswerUsefulness(opts: AnswerUsefulnessOptions) {
  if (fs.existsSync(opts.out)) throw new Error(`refusing to overwrite ${opts.out}`);
  const judgeModel = opts.judgeModel ?? ANSWER_JUDGE_MODEL;
  const { reports, corpus, snapshotSha256, goldSha256 } = loadArmReports(opts.reports, opts.snapshot, opts.gold, opts.allowSynthetic);
  const snapshot = JSON.parse(fs.readFileSync(opts.snapshot, 'utf8')) as Snapshot;
  const gold = JSON.parse(fs.readFileSync(opts.gold, 'utf8')) as Record<string, HeldoutQuery[]>;
  const texts = new Map(snapshot.suites[corpus].entries.map((e) => [e.key, e.text] as const));
  const queries = new Map((gold[corpus] ?? []).map((q) => [q.id, q] as const));
  const arms = reports.map((r) => r.report.model);
  const baseline = opts.baseline ?? arms[0]!;
  if (!arms.includes(baseline)) throw new Error(`baseline ${baseline} is not an arm`);
  // Arm-identifying strings only: a value every arm shares (e.g. the benchmark schema) identifies nothing.
  const forbidden = [...new Set(reports.flatMap(({ file, report }) => [report.model, report.binding?.profileId ?? '', path.basename(file, '.json')]))]
    .filter((t) => t.length >= 3);

  const rows = reports[0]!.report.rows.slice(0, opts.limit ?? undefined);
  for (const r of rows) {
    const q = queries.get(r.id);
    if (!q || q.partition !== 'test') throw new Error(`query ${r.id} is not a test query in the gold labels`);
    if (stableStringify([...q.expected].sort()) !== stableStringify([...r.expected].sort())) throw new Error(`query ${r.id}: report expected keys differ from gold`);
  }

  fs.mkdirSync(path.join(opts.receipts, 'answers'), { recursive: true });
  fs.mkdirSync(path.join(opts.receipts, 'judgments'), { recursive: true });
  const ctx = { harnessSlug: 'papercusp', ...(opts.callContext ?? {}) };
  const inflight = new Map<string, Promise<unknown>>();
  const coalesce = <T>(key: string, make: () => Promise<T>): Promise<T> => {
    let p = inflight.get(key) as Promise<T> | undefined;
    if (!p) { p = make(); inflight.set(key, p); }
    return p;
  };
  const unique = { answerCalls: 0, judgeCalls: 0, answerCostUsd: 0, judgeCostUsd: 0, answerReplays: 0, judgeReplays: 0 };

  const answerOnce = (question: string, passages: Passage[]) => {
    const request = buildAnswerRequest(question, passages);
    const fingerprint = sha256Text(stableStringify({ contract: ANSWER_CONTRACT_HASH, request }));
    return coalesce(`a:${fingerprint}`, async () => {
      const file = path.join(opts.receipts, 'answers', `${fingerprint}.json`);
      const saved = readReceipt<{ fingerprint: string; request: unknown; result: { text: string; costUsd: number } }>(file, fingerprint, request);
      if (saved) { unique.answerReplays++; return { fingerprint, text: saved.result.text, costUsd: saved.result.costUsd, replayed: true }; }
      const result = await opts.llm({ ...ctx, model: request.model, system: request.system, messages: [{ role: 'user', content: request.user }],
        temperature: request.temperature, maxTokens: request.maxTokens, responseFormat: 'text' });
      const costUsd = costOf(result);
      writeBlindReceipt(file, { fingerprint, request, result: { text: result.text, inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd } });
      unique.answerCalls++; unique.answerCostUsd += costUsd;
      return { fingerprint, text: result.text, costUsd, replayed: false };
    });
  };

  const judgeOnce = (inputs: JudgeInputs, temperature: number): Promise<JudgePass> => {
    const request = { rubric: ANSWER_RUBRIC_VERSION, judgeModel, temperature, inputs };
    const fingerprint = sha256Text(stableStringify(request));
    return coalesce(`j:${fingerprint}`, async () => {
      const file = path.join(opts.receipts, 'judgments', `${fingerprint}.json`);
      const saved = readReceipt<{ fingerprint: string; request: unknown; pass: JudgePass }>(file, fingerprint, request);
      if (saved) {
        acceptJudgedScore(saved.pass);
        unique.judgeReplays++;
        return { ...saved.pass, replayed: true };
      }
      const attestations: BlindAttestation[] = [];
      const blindLlm: LlmCallFn = async (call) => {
        attestations.push(assertJudgeBlind(call, inputs, forbidden));
        return opts.llm({ ...ctx, ...call });
      };
      const judge = await judgeRun({
        model: judgeModel, rubric: ANSWER_RUBRIC, scenarioId: ANSWER_JUDGE_INSTRUCTIONS.scenarioId,
        scenarioDescription: fill(ANSWER_JUDGE_INSTRUCTIONS.scenarioTemplate, { question: inputs.question, sources: inputs.sources, reference: inputs.reference }),
        personaSummary: ANSWER_JUDGE_INSTRUCTIONS.personaSummary, goalSummary: ANSWER_JUDGE_INSTRUCTIONS.goalSummary, temperature,
      }, judgeRunSummary(fingerprint, inputs.answer, judgeModel), [], blindLlm);
      if (attestations.length === 0) throw new Error('judge returned without a model call; no blinding evidence');
      const pass: JudgePass = {
        temperature, fingerprint, scores: judge.scores, ...(judge.notes ? { notes: judge.notes } : {}), costUsd: judge.costUsd,
        blind: { verified: true, requestSha256: attestations.flatMap((a) => a.requestSha256), forbiddenChecked: attestations[0]!.forbiddenChecked },
        replayed: false, inconclusive: !usableScores(judge.scores),
      };
      writeBlindReceipt(file, { fingerprint, request, pass });
      unique.judgeCalls++; unique.judgeCostUsd += pass.costUsd;
      return pass;
    });
  };

  const outcomes = new Map<string, ArmOutcome>();
  const tasks = rows.flatMap((row) => reports.map(({ report }) => ({ row, report })));
  // Deterministic, arm-interleaved order so no arm is systematically judged first.
  tasks.sort((a, b) => sha256Text(`${a.row.id}|${a.report.model}`).localeCompare(sha256Text(`${b.row.id}|${b.report.model}`)));
  await pool(tasks, opts.concurrency ?? 4, async ({ row, report }) => {
    const q = queries.get(row.id)!;
    const armRow = report.rows.find((r) => r.id === row.id)!;
    const keys = armRow.routes[ANSWER_CONTRACT.route]?.rankedKeys;
    if (!keys) throw new Error(`${report.model} row ${row.id} has no ${ANSWER_CONTRACT.route} route`);
    const passages = buildPassages(keys, texts);
    const answer = await answerOnce(q.query, passages);
    const parsed = parseAnswer(answer.text, passages.length);
    const referenceTexts = q.expected.map((k) => { const t = texts.get(k); if (t === undefined) throw new Error(`gold key ${k} missing`); return t; });
    const inputs = buildJudgeInputs(q.query, passages, referenceTexts, answer.text);
    const passes = await Promise.all(JUDGE_PASS_TEMPERATURES.map((t) => judgeOnce(inputs, t)));
    const primaryScores = acceptJudgedScore(passes[0]!);
    const judged = !passes[0]!.inconclusive;
    const answerable = q.expected.length > 0;
    const citedKeys = parsed.citedLabels.filter((l) => !parsed.invalidCitations.includes(l)).map((l) => passages[Number(l.slice(1)) - 1]!.key);
    const correct = judged ? (primaryScores.correctness ?? 0) >= ANSWER_PASS_BAR : null;
    const grounded = judged ? (primaryScores.grounding ?? 0) >= ANSWER_PASS_BAR : null;
    outcomes.set(`${row.id}|${report.model}`, {
      contextKeys: passages.map((p) => p.key),
      contextHasGold: passages.some((p) => q.expected.includes(p.key)),
      answerFingerprint: answer.fingerprint, answer: answer.text, answerCostUsd: answer.costUsd, answerReplayed: answer.replayed,
      ...parsed,
      citationGoldPrecision: answerable && citedKeys.length ? citedKeys.filter((k) => q.expected.includes(k)).length / citedKeys.length : null,
      passes, correct, grounded,
      // An unanswerable query's outcome (decline or not) is deterministic; an answerable one needs the judge.
      useful: answerable ? (judged ? correct! && grounded! && !parsed.abstained : null) : parsed.abstained,
      unsupportedAnswer: parsed.abstained ? false : !answerable ? true : judged ? !grounded : null,
    });
  });

  // ---------------------------------------------------------------- aggregate
  const get = (id: string, arm: string) => outcomes.get(`${id}|${arm}`)!;
  const rate = (all: Array<boolean | null>) => {
    const xs = all.filter((x): x is boolean => x !== null);
    return xs.length ? xs.filter(Boolean).length / xs.length : null;
  };
  const toNum = (x: boolean | null) => (x === null ? null : Number(x));
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const summarize = (subset: ArmReportRow[], arm: string) => {
    const os = subset.map((r) => ({ q: queries.get(r.id)!, o: get(r.id, arm) }));
    const ans = os.filter(({ q }) => q.expected.length > 0);
    const neg = os.filter(({ q }) => q.expected.length === 0);
    return {
      queries: os.length, answerable: ans.length, unanswerable: neg.length,
      inconclusiveJudgments: os.filter(({ o }) => o.passes[0]!.inconclusive).length,
      usefulRate: rate(os.map(({ o }) => o.useful)),
      groundedAccuracy: rate(ans.map(({ o }) => o.useful)),
      correctRejection: rate(neg.map(({ o }) => o.abstained)),
      unsupportedAnswerRate: rate(os.map(({ o }) => o.unsupportedAnswer)),
      unsupportedOnUnanswerable: rate(neg.map(({ o }) => o.unsupportedAnswer)),
      falseAbstentionWithGoldInContext: rate(ans.filter(({ o }) => o.contextHasGold).map(({ o }) => o.abstained)),
      contextHasGold: rate(ans.map(({ o }) => o.contextHasGold)),
      citationGoldPrecision: mean(ans.map(({ o }) => o.citationGoldPrecision).filter((x): x is number => x !== null)),
      invalidCitationRate: rate(os.map(({ o }) => o.invalidCitations.length > 0)),
      groundedRate: rate(os.filter(({ o }) => !o.abstained).map(({ o }) => o.grounded)),
      nominalCostUsd: os.reduce((s, { o }) => s + o.answerCostUsd + o.passes.reduce((t, p) => t + p.costUsd, 0), 0),
    };
  };
  const classes = [...new Set(rows.map((r) => r.class))].sort();
  const armSummaries = Object.fromEntries(arms.map((arm) => [arm, {
    all: summarize(rows, arm),
    byClass: Object.fromEntries(classes.map((c) => [c, summarize(rows.filter((r) => r.class === c), arm)])),
  }]));
  const iters = opts.bootstrapIters ?? 10000;
  const paired = Object.fromEntries(arms.filter((a) => a !== baseline).map((arm) => {
    const delta = (subset: ArmReportRow[], pick: (o: ArmOutcome) => number | null) => {
      const diffs = subset.map((r) => [pick(get(r.id, arm)), pick(get(r.id, baseline))] as const)
        .filter((p): p is readonly [number, number] => p[0] !== null && p[1] !== null).map(([a, b]) => a - b);
      return { n: diffs.length, ...pairedBootstrap(diffs, iters), wins: diffs.filter((d) => d > 0).length, losses: diffs.filter((d) => d < 0).length };
    };
    const ansRows = rows.filter((r) => r.expected.length > 0);
    return [arm, {
      vs: baseline,
      useful: delta(rows, (o) => toNum(o.useful)),
      groundedAccuracy: delta(ansRows, (o) => toNum(o.useful)),
      unsupportedAnswer: delta(rows, (o) => toNum(o.unsupportedAnswer)),
      citationGoldPrecision: delta(ansRows, (o) => o.citationGoldPrecision),
      byClass: Object.fromEntries(classes.map((c) => [c, delta(rows.filter((r) => r.class === c), (o) => toNum(o.useful))])),
    }];
  }));
  const allOutcomes = [...outcomes.values()].filter((o) => !o.passes[0]!.inconclusive && !o.passes[1]!.inconclusive);
  const agreement = Object.fromEntries(ANSWER_RUBRIC.axes.map((axis) => {
    const a = allOutcomes.map((o) => (o.passes[0]!.scores[axis.id] ?? 0) >= ANSWER_PASS_BAR);
    const b = allOutcomes.map((o) => (o.passes[1]!.scores[axis.id] ?? 0) >= ANSWER_PASS_BAR);
    return [axis.id, {
      n: a.length, binaryAgreement: rate(a.map((x, i) => x === b[i])), kappa: cohenKappa(a, b),
      meanAbsScoreDiff: mean(allOutcomes.map((o) => Math.abs((o.passes[0]!.scores[axis.id] ?? 0) - (o.passes[1]!.scores[axis.id] ?? 0)))),
    }];
  }));
  const report = {
    formatVersion: 1, runner: 'answer-usefulness', corpus, route: ANSWER_CONTRACT.route, baseline, arms,
    contract: {
      answer: { ...ANSWER_CONTRACT, hash: ANSWER_CONTRACT_HASH },
      judge: { model: judgeModel, rubricVersion: ANSWER_RUBRIC_VERSION, passTemperatures: JUDGE_PASS_TEMPERATURES, passBar: ANSWER_PASS_BAR,
        blind: { forbiddenIdentifiers: forbidden.length, method: 'judge request built from arm-independent inputs; scaffold re-checked at the transport seam' } },
      bootstrap: { iters, method: 'paired bootstrap over test queries (fusion-score-aware.pairedBootstrap)' },
    },
    inputs: {
      snapshot: path.basename(opts.snapshot), snapshotSha256, gold: path.basename(opts.gold), goldSha256,
      reports: reports.map(({ file, sha256, report: r }) => ({ arm: r.model, file: path.basename(file), sha256, profileId: r.binding?.profileId ?? null })),
    },
    queries: rows.length,
    cost: { ...unique, uniqueTotalUsd: unique.answerCostUsd + unique.judgeCostUsd },
    summary: armSummaries, paired, agreement,
    rows: rows.map((r) => ({ id: r.id, class: r.class, expected: r.expected,
      arms: Object.fromEntries(arms.map((arm) => { const o = get(r.id, arm); return [arm, {
        contextKeys: o.contextKeys, contextHasGold: o.contextHasGold, answerFingerprint: o.answerFingerprint, answer: o.answer,
        abstained: o.abstained, citedLabels: o.citedLabels, invalidCitations: o.invalidCitations, citationGoldPrecision: o.citationGoldPrecision,
        scores: o.passes.map((p) => ({ temperature: p.temperature, ...p.scores })), judgeFingerprints: o.passes.map((p) => p.fingerprint),
        correct: o.correct, grounded: o.grounded, useful: o.useful, unsupportedAnswer: o.unsupportedAnswer,
      }]; })) })),
    limitations: [
      `answers come from one fixed model (${ANSWER_CONTRACT.model}) at temperature 0; agent models in production differ`,
      `the judge (${judgeModel}) is a different model family member from the answerer but is still an LLM; agreement is same-model temperature agreement`,
      'context is the production pull route top-k truncated to the frozen character budget',
      'unanswerable queries are the independently labelled hard negatives (empty gold)',
    ],
  };
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  writeBlindReceipt(opts.out, report);
  return report;
}
