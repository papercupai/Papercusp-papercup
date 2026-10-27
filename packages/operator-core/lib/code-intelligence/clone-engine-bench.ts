/** P-003: clone-pair adapters for the existing fair-comparison runner/scorer.
 * A pair is a references question with at most one relevant site. This does
 * not add an intent to the older graph corpus or reuse its backend decision.
 */
import { createHash } from 'node:crypto';
import * as ts from 'typescript';
import { guardedArm, type FairArm } from './fair-comparison-arms';
import { preregister, scoreCase, type AnswerKey, type FairCase } from './fair-comparison';
import { runArm, scoreRuns, type ArmRun } from './fair-comparison-run';

export const CLONE_BENCH_POLICY = Object.freeze({
  edition: 'clone-pairs-v2-native-conformance', similarity: 0.8, minNodes: 20, minLines: 1,
  jscpd: { minTokens: 1, kinds: 'all (exact plus normalized similar)', workers: 1,
    pairLifting: 'a cross-file segment must cover at least the similarity ratio of both complete function line spans' },
  similarityTs: { renameCost: 0.3, fast: false, types: false, pairLifting: 'cross-file top-level function spans start at line 1' },
  minhashSeeds: 32, rowsPerBand: 4, shingleWidth: 3, reps: 3, seed: 20261021,
  ranking: 'micro-F1 descending, then dependency count ascending, then arm id; failures or unavailable required candidates forbid selection',
});
export const CLONE_ENGINE_IDS = ['jscpd', 'similarity-ts', 'minhash-tree-edit'] as const;
export type CloneEngineId = typeof CLONE_ENGINE_IDS[number];
export interface CloneBenchPair {
  readonly id: string;
  readonly left: string;
  readonly right: string;
  readonly positive: boolean;
  readonly stratum: 'historical-renamed' | 'authored-near-miss' | 'checked-negative';
  readonly evidence: string;
}
export const cloneBenchHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function clonePairCorpus(pairs: readonly CloneBenchPair[]) {
  if (!pairs.length || new Set(pairs.map(p => p.id)).size !== pairs.length) throw new Error('empty or duplicate clone pairs');
  const cases: FairCase[] = pairs.map(p => {
    if (!p.left.trim() || !p.right.trim() || !p.evidence.trim()) throw new Error(`missing source or adjudication: ${p.id}`);
    return { id: p.id, intent: 'references', subject: p.id, source: 'authored',
      tags: p.positive ? [] : ['absence'], sourceFingerprint: cloneBenchHash(p), taskRef: p.evidence };
  });
  const keys: AnswerKey[] = pairs.map(p => ({ caseId: p.id,
    sites: p.positive ? [`pairs/${p.id}/b.ts:1`] : [],
    rejected: p.positive ? [] : [`pairs/${p.id}/b.ts:1`], aliases: {}, neutral: [] }));
  return { cases, keys };
}

interface Shape { kind: number; children: Shape[]; mass: number }
function shape(source: string): Shape {
  const file = ts.createSourceFile('sample.ts', source, ts.ScriptTarget.Latest, true);
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.length) throw new Error('clone sample has syntax errors');
  const build = (node: ts.Node): Shape => {
    const children: Shape[] = [];
    ts.forEachChild(node, child => { children.push(build(child)); });
    return { kind: node.kind, children, mass: 1 + children.reduce((s, c) => s + c.mass, 0) };
  };
  return build(file);
}
function kinds(tree: Shape): number[] { return [tree.kind, ...tree.children.flatMap(kinds)]; }
function minhash(tree: Shape): number[] {
  const stream = kinds(tree), shingles: string[] = [];
  for (let i = 0; i <= stream.length - CLONE_BENCH_POLICY.shingleWidth; i++)
    shingles.push(stream.slice(i, i + CLONE_BENCH_POLICY.shingleWidth).join(','));
  return Array.from({ length: CLONE_BENCH_POLICY.minhashSeeds }, (_, seed) => {
    let minimum = 0xffffffff;
    for (const s of shingles) {
      let h = (2166136261 ^ Math.imul(seed + 1, 2654435761)) >>> 0;
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
      minimum = Math.min(minimum, h);
    }
    return minimum;
  });
}
/** Ordered subtree edit: deleting/inserting a subtree costs its node mass;
 * relabelling costs one. Unlike APTED, deletion does not promote children.
 */
function treeDistance(a: Shape, b: Shape): number {
  const previous = [0];
  for (const child of b.children) previous.push(previous[previous.length - 1]! + child.mass);
  for (const ac of a.children) {
    const next = [previous[0]! + ac.mass];
    for (let j = 0; j < b.children.length; j++) {
      const bc = b.children[j]!;
      next.push(Math.min(previous[j + 1]! + ac.mass, next[j]! + bc.mass, previous[j]! + treeDistance(ac, bc)));
    }
    previous.splice(0, previous.length, ...next);
  }
  return previous[b.children.length]! + Number(a.kind !== b.kind);
}
export function minhashTreeSimilarity(left: string, right: string): { candidate: boolean; similarity: number | null } {
  const a = shape(left), b = shape(right);
  const ah = minhash(a), bh = minhash(b), rows = CLONE_BENCH_POLICY.rowsPerBand;
  let candidate = false;
  for (let i = 0; i < ah.length; i += rows)
    if (ah.slice(i, i + rows).every((v, j) => v === bh[i + j])) candidate = true;
  return { candidate, similarity: candidate ? Math.max(0, 1 - treeDistance(a, b) / Math.max(a.mass, b.mass)) : null };
}

/** Parsers reject unrecognised output instead of certifying an empty answer. */
export function parseSimilarityTs(text: string): boolean {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  if (/No (?:similar|duplicate) functions found!/.test(clean)) return false;
  if (/Found \d+ duplicate (?:pairs|clusters?)/.test(clean)) {
    // The native report also includes within-file/nested-function matches.
    // Only a reported cross-file pair belongs to this labelled pair question.
    return /Similarity:[^\n]*\n\s+[^\n]*\/a\.ts:1-\d+[^\n]*\n\s+[^\n]*\/b\.ts:1-\d+/.test(clean)
      || /Similarity:[^\n]*\n\s+[^\n]*\/b\.ts:1-\d+[^\n]*\n\s+[^\n]*\/a\.ts:1-\d+/.test(clean);
  }
  const total = /Total similar (?:function )?pairs found:\s*(\d+)/.exec(clean);
  if (!total) throw new Error('unrecognised similarity-ts function report');
  return Number(total[1]) > 0;
}
export function parseJscpd(value: unknown, functionLines: readonly [number, number] = [1, 1]): boolean {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { duplicates?: unknown }).duplicates))
    throw new Error('unrecognised jscpd JSON report');
  type Segment = { name?: string; start?: number; end?: number };
  const duplicates = (value as { duplicates: { firstFile?: Segment; secondFile?: Segment }[] }).duplicates;
  const basename = (name: string | undefined) => name?.split('/').pop();
  const covers = (segment: Segment | undefined, index: number) => functionLines[index] === 1
    || (segment?.start !== undefined && segment.end !== undefined
      && (segment.end - segment.start + 1) / functionLines[index]! >= CLONE_BENCH_POLICY.similarity);
  return duplicates.some(p => basename(p.firstFile?.name) === 'a.ts' && basename(p.secondFile?.name) === 'b.ts'
    && covers(p.firstFile, 0) && covers(p.secondFile, 1)
    || basename(p.firstFile?.name) === 'b.ts' && basename(p.secondFile?.name) === 'a.ts'
      && covers(p.firstFile, 1) && covers(p.secondFile, 0));
}
export interface CloneEngine {
  readonly id: CloneEngineId;
  readonly version: string;
  readonly dependencyCount: number;
  readonly dependencyEvidence: string;
  readonly unavailable: string | null;
  compare(pair: CloneBenchPair): Promise<boolean>;
}
export function cloneFairArm(engine: CloneEngine, pairs: readonly CloneBenchPair[]): FairArm {
  const byId = new Map(pairs.map(p => [p.id, p]));
  return guardedArm({ capabilities: { armId: engine.id, version: engine.version, intents: ['references'],
    licence: engine.id === 'minhash-tree-edit' ? 'first-party' : 'permissive' }, unavailable: engine.unavailable,
  index: async () => ({ wallMs: 0, peakRssKb: null, ok: true, error: null, loadAvg1: null }),
  ask: async c => {
    const pair = byId.get(c.id);
    if (!pair) throw new Error(`unknown clone pair: ${c.id}`);
    const match = await engine.compare(pair);
    return { sites: match ? [{ path: `pairs/${pair.id}/b.ts`, line1: 1, kind: 'function' }] : [], error: null };
  } });
}

export function rankCloneRuns(runs: readonly ArmRun[], pairs: readonly CloneBenchPair[], engines: readonly CloneEngine[],
  registration: ReturnType<typeof preregister>) {
  const { cases, keys } = clonePairCorpus(pairs);
  const scored = scoreRuns(runs, cases, keys, {}, registration);
  const residue: string[] = scored.pending.map(p => `unadjudicated:${p.caseId}`);
  const ranking = CLONE_ENGINE_IDS.map(id => {
    const run = runs.find(r => r.capabilities.armId === id), engine = engines.find(e => e.id === id);
    if (!run || !engine || run.unavailable || !run.index?.ok || run.reps.length !== registration.reps)
      residue.push(`missing/unavailable/incomplete:${id}`);
    let tp = 0, fp = 0, fn = 0;
    const latencies: number[] = [];
    const strata: Record<string, { tp: number; fp: number; fn: number }> = {};
    for (const rep of run?.reps ?? []) {
      if (rep.answers.length !== cases.length || new Set(rep.answers.map(a => a.caseId)).size !== cases.length)
        residue.push(`incomplete-repetition:${id}:${rep.rep}`);
      for (const c of cases) {
        const answer = rep.answers.find(a => a.caseId === c.id), key = keys.find(k => k.caseId === c.id)!;
        if (!answer || answer.status !== 'answered') { residue.push(`failed:${id}:${rep.rep}:${c.id}`); continue; }
        const grade = scoreCase(c, run!.capabilities, key, answer);
        const positive = key.sites.length > 0, returned = answer.sites.length > 0;
        const counts = { tp: Number(positive && grade.recall === 1), fp: Number(!positive && returned), fn: Number(positive && grade.recall !== 1) };
        tp += counts.tp; fp += counts.fp; fn += counts.fn; latencies.push(answer.latencyMs);
        const stratum = pairs.find(p => p.id === c.id)!.stratum;
        const cell = strata[stratum] ??= { tp: 0, fp: 0, fn: 0 };
        cell.tp += counts.tp; cell.fp += counts.fp; cell.fn += counts.fn;
      }
    }
    const precision = tp + fp ? tp / (tp + fp) : 0, recall = tp + fn ? tp / (tp + fn) : 0;
    latencies.sort((a, b) => a - b);
    return { id, precision, recall, f1: precision + recall ? 2 * precision * recall / (precision + recall) : 0,
      tp, fp, fn, strata, runtimeMs: { total: latencies.reduce((a, b) => a + b, 0),
        median: latencies.length ? latencies[Math.floor(latencies.length / 2)]! : null,
        max: latencies.length ? latencies[latencies.length - 1]! : null },
      dependencyCount: engine?.dependencyCount ?? null, dependencyEvidence: engine?.dependencyEvidence ?? 'missing' };
  }).sort((a, b) => b.f1 - a.f1 || (a.dependencyCount ?? Infinity) - (b.dependencyCount ?? Infinity) || a.id.localeCompare(b.id));
  return { ranking, residue: [...new Set(residue)], selected: residue.length ? null : ranking[0]!.id };
}

export async function runCloneBench(pairs: readonly CloneBenchPair[], engines: readonly CloneEngine[],
  saveRegistration: (registration: unknown) => Promise<void>, saveRun: (run: ArmRun) => Promise<void>) {
  if (engines.length !== 3 || new Set(engines.map(e => e.id)).size !== 3) throw new Error('all three clone engines are required');
  if (!pairs.some(p => p.stratum === 'historical-renamed') || !pairs.some(p => p.stratum === 'authored-near-miss')
    || !pairs.some(p => p.stratum === 'checked-negative')) throw new Error('all clone strata are required');
  const { cases, keys } = clonePairCorpus(pairs), arms = engines.map(e => cloneFairArm(e, pairs));
  const registration = preregister({ cases, keys, arms: arms.map(a => a.capabilities), reps: CLONE_BENCH_POLICY.reps, seed: CLONE_BENCH_POLICY.seed });
  // Persist the policy and source-containing sample BEFORE the first engine runs.
  await saveRegistration({ policy: CLONE_BENCH_POLICY, policyHash: cloneBenchHash(CLONE_BENCH_POLICY), pairs, registration,
    dependencies: engines.map(({ id, version, dependencyCount, dependencyEvidence }) => ({ id, version, dependencyCount, dependencyEvidence })) });
  const runs: ArmRun[] = [];
  for (const arm of arms) { const run = await runArm(arm, cases, registration); runs.push(run); await saveRun(run); }
  return { registration, runs, ...rankCloneRuns(runs, pairs, engines, registration) };
}
