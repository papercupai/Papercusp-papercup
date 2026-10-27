/**
 * bm25-hybrid-recall.ts — the pure half of requirement R-13's instrument
 * (plan bm25-lexical-search-evoke-adoption-2026-10-10; decisions D-004, D-006).
 *
 * R-13: on a known-item sample, HYBRID recall (lexical leg + cosine leg, fused by
 * RRF) with the BM25 lexical leg is at least the recall with the legacy ts_rank_cd
 * leg (BM25 flag off), measured on the identical sample in one session.
 * `bm25-hybrid-recall-cli.ts` runs both arms for every pair in one process, through
 * the same engine path `search:semantic` uses; this module scores and judges.
 *
 * WHY THE VERDICT CAN BE `invalid`. The instrument R-13 first named
 * (memory/bench/ab-live-recall-cli.ts) ranks `memory_canonical` with
 * canonical-store `lexicalSearch`, which never reads the BM25 flag: both arms ran
 * the same code and would have "passed" by construction. So a comparison counts
 * only when each arm's seam actually reported its engine (legacy arm = 'legacy',
 * BM25 arm = 'bm25') and both arms scored the identical pairs. Anything else is
 * `invalid`, never `pass`.
 */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { MeasurementPin } from '../../agent-tools/plans/evidence-measurement-pin';

// The same matcher the commit-time identity lints use, so what this scrubs at write time and
// what git-sync's content lint refuses cannot drift (see prose-corpus.ts for the same pattern).
import { redactIdentityLeaks } from '../../../../../scripts/lib/identity-leak-patterns.mjs';

export type Arm = 'legacy' | 'bm25';
export const ARMS: readonly Arm[] = ['legacy', 'bm25'];

/** D-035: a post-run HEAD is not a witness of the bytes that ran. */
export const BM25_EXECUTED_SOURCE_PATHS = [
  'packages/operator-core/lib/search/bench/bm25-hybrid-recall-cli.ts',
  'packages/operator-core/lib/search/bench/bm25-hybrid-recall.ts',
  'libs/generic/search/src/hybrid.ts',
  'libs/generic/rrf/src/index.ts',
  'packages/operator-core/lib/search/lexical/rank.ts',
  'packages/operator-core/lib/agent-tools/search/sources.ts',
] as const;

const repoPath = z.string().refine(p => !!p && !p.startsWith('/') && !p.includes('\\') &&
  p.split('/').every(part => !!part && part !== '.' && part !== '..'), 'expected repository-relative path');
const commitId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const sourceQualificationManifestSchema = z.object({
  schemaVersion: z.literal(1),
  rootCommit: commitId,
  // A manifest may add dependencies to the mandatory six; none may be dropped.
  sourceHashes: z.record(repoPath, z.string().regex(/^[0-9a-f]{64}$/)),
  repos: z.record(z.string(), commitId),
  embeddingProfile: z.object({ mode: z.string().min(1), profileId: z.string().min(1) }).strict(),
  /** Optional prospective binding for exact saved inputs, keyed by declared seed. */
  queryInputs: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)).optional(),
  runs: z.array(z.object({ seed: z.string().min(1), artifactPath: repoPath })).length(3),
}).passthrough().superRefine((m, ctx) => {
  // Passthrough metadata is persisted with the manifest too. Reject leaks
  // before admission; rewriting an already-qualified manifest changes its hash.
  const serialized = JSON.stringify(m);
  if (redactIdentityLeaks(serialized) !== serialized)
    ctx.addIssue({ code: 'custom', message: 'source qualification manifest contains identity leaks' });
  for (const p of BM25_EXECUTED_SOURCE_PATHS) if (!m.sourceHashes[p])
    ctx.addIssue({ code: 'custom', message: `missing executed source: ${p}` });
  if (m.repos['.'] !== m.rootCommit)
    ctx.addIssue({ code: 'custom', message: 'root repository pin differs from rootCommit' });
  if (new Set(m.runs.map(r => r.seed)).size !== 3 || new Set(m.runs.map(r => r.artifactPath)).size !== 3)
    ctx.addIssue({ code: 'custom', message: 'three distinct prospective seeds and artifact paths are required' });
});
export type SourceQualificationManifest = z.infer<typeof sourceQualificationManifestSchema>;
export type ExecutedSourceSnapshot = MeasurementPin & { rootCommit: string | null; observedAt: string };

/** A manifest qualifies the complete R-13 sample and its exact registered space. */
export function qualificationConfigurationProblems(manifest: SourceQualificationManifest, options: {
  pairsPerSource: number; sources: readonly string[]; profile?: { mode: string; profileId?: string }; explicitDatabase: boolean;
}): string[] {
  const reasons: string[] = [];
  if (!options.explicitDatabase) reasons.push('judged runs require explicit HARNESS_ADMIN_DATABASE_URL');
  if (!Number.isInteger(options.pairsPerSource) || options.pairsPerSource < 60) reasons.push('judged runs require at least60 pairs per source');
  if (options.sources.length !== 2 || !options.sources.includes('work_item') || !options.sources.includes('session_turn'))
    reasons.push('judged runs require both work_item and session_turn, exactly once');
  if (options.profile?.mode !== manifest.embeddingProfile.mode || options.profile?.profileId !== manifest.embeddingProfile.profileId)
    reasons.push('registered query embedding profile differs from manifest');
  return reasons;
}

/** Fail closed on unknown provenance as well as known dirt or movement. */
export function qualifyExecutedSource(before: ExecutedSourceSnapshot, after: ExecutedSourceSnapshot,
  expected?: SourceQualificationManifest): { verdict: 'pass' | 'invalid'; reasons: string[] } {
  const reasons: string[] = [];
  const paths = expected ? Object.keys(expected.sourceHashes) : [...BM25_EXECUTED_SOURCE_PATHS];
  for (const [label, snapshot] of [['before', before], ['after', after]] as const) {
    if (!snapshot.rootCommit) reasons.push(`${label}: root commit unavailable`);
    if (snapshot.repos.find(r => r.repo === '.')?.head !== snapshot.rootCommit)
      reasons.push(`${label}: root HEAD differs from observed root commit`);
    if (expected && snapshot.rootCommit !== expected.rootCommit) reasons.push(`${label}: root commit differs from manifest`);
    for (const error of snapshot.errors ?? []) reasons.push(`${label}: ${error}`);
    for (const p of paths) {
      const file = snapshot.files.find(f => f.path === p);
      if (!file || file.clean !== true) reasons.push(`${label}: executed source dirty or unavailable: ${p}`);
      if (expected && file?.sha256 !== expected.sourceHashes[p]) reasons.push(`${label}: executed source hash differs from manifest: ${p}`);
      if (file && !snapshot.repos.some(r => r.repo === file.repo)) reasons.push(`${label}: repository pin missing: ${file.repo}`);
    }
    for (const repo of snapshot.repos) {
      if (!repo.head || (repo.repo !== '.' && repo.gitlink !== repo.head))
        reasons.push(`${label}: repository HEAD/gitlink unavailable or mismatched: ${repo.repo}`);
      if (expected && repo.head !== expected.repos[repo.repo]) reasons.push(`${label}: repository pin differs from manifest: ${repo.repo}`);
    }
    for (const repo of Object.keys(expected?.repos ?? {})) if (!snapshot.repos.some(r => r.repo === repo))
      reasons.push(`${label}: manifest repository pin unavailable: ${repo}`);
  }
  if (before.rootCommit !== after.rootCommit) reasons.push('root commit changed during execution');
  for (const p of paths) if (before.files.find(f => f.path === p)?.sha256 !== after.files.find(f => f.path === p)?.sha256)
    reasons.push(`executed source changed during execution: ${p}`);
  for (const repo of before.repos) if (repo.head !== after.repos.find(r => r.repo === repo.repo)?.head)
    reasons.push(`repository commit changed during execution: ${repo.repo}`);
  return { verdict: reasons.length ? 'invalid' : 'pass', reasons: [...new Set(reasons)] };
}

/** Select saved warm-pass indices for diagnosis; never carry prior observations into a replay. */
export function selectReplayPairs(saved: readonly PairResult[], sources: readonly string[], indices: readonly number[]): PairResult[] {
  if (!indices.length || indices.some((i) => !Number.isInteger(i) || i < 0) || new Set(indices).size !== indices.length)
    throw new Error('replay indices must be distinct non-negative integers');
  return sources.flatMap((source) => {
    const rows = saved.filter((p) => p.source === source);
    return indices.map((i) => {
      const p = rows[i];
      if (!p || typeof p.query !== 'string' || !p.query.trim() || p.query.includes('[redacted'))
        throw new Error(`saved replay query ${source}[${i}] is missing or redacted`);
      return { ...p, arms: {} };
    });
  });
}

/** Recall cut-off: the target must be in the top K of the fused list. */
export const RECALL_K = 10;

/** Below this many scored pairs a source's comparison is too small to read. */
export const MIN_PAIRS_PER_SOURCE = 20;

export type QueryStyle = 'fragment' | 'keyword';

export interface ArmObservation {
  /** 1-based rank of the target in the fused list (top RECALL_K), or null when absent. */
  rank: number | null;
  latencyMs: number;
  /** The lexical engine the seam (`lexicalEngine`) reported for this arm and source. */
  engine: 'bm25' | 'legacy';
  /** Actual post-floor vector candidates entering fusion; absent on historical artifacts. */
  semanticCandidates?: number;
  /** Length of the fused list; 0 is a zero-hit query. */
  hits: number;
  /**
   * Per-leg time inside the call, keyed `<leg>:<ranker>` (e.g. `lexical:lexical`,
   * `semantic:embeddings`), from the search engine's own `legs.*.sourceCalls[].durationMs`
   * (see {@link legDurations}). Legs run concurrently, so these do not sum to `latencyMs`.
   * It attributes an R-18 tail to a leg; artifacts written before it was recorded omit it.
   */
  legMs?: Record<string, number>;
  /**
   * Where this call's time went, measured OUTSIDE the timed window (D-026): the lexical
   * statements' pg_stat_statements deltas, the bench process's CPU time and event-loop delay,
   * and host I/O pressure at call start. Artifacts written before D-026 omit it.
   */
  attrib?: CallAttribution;
  /**
   * D-027: whether a full-database dump (application `pcbackup`, a transaction open) was in
   * progress just before this call, sampled outside the timed window. `null` when the check
   * failed; absent in artifacts written before D-027.
   */
  dumpActive?: boolean | null;
}

/**
 * D-027: whether a full-database dump overlapped these calls. `true` if any call saw one;
 * `false` only if every call was checked and none did; `null` if some call could not be
 * checked; `undefined` when no call carries the check (an artifact written before D-027).
 */
export function dumpOverlapOf(pairs: readonly PairResult[]): boolean | null | undefined {
  const seen = pairs.flatMap((p) => ARMS.flatMap((a) => (p.arms[a] ? [p.arms[a]!.dumpActive] : [])));
  if (seen.length === 0 || seen.every((d) => d === undefined)) return undefined;
  if (seen.some((d) => d === true)) return true;
  if (seen.some((d) => d !== false)) return null;
  return false;
}

/** Per-call attribution of an R-18 observation (D-026). See {@link callAttribution}. */
export interface CallAttribution {
  /** Shared lexical-statement execution counters; includes other sessions, not own-call time. */
  pgExecMs: number;
  /** Of which: time reading blocks not in shared buffers. Can exceed pgExecMs under parallel query. */
  pgReadMs: number;
  pgBlksRead: number;
  /** Statement executions in the window; above the call's own count means a peer ran the same statement. */
  pgCalls: number;
  /** User + system CPU time of the bench process over the call. */
  clientCpuMs?: number;
  /** Largest sampled event-loop delay; does not distinguish scheduling from synchronous work. */
  loopDelayMaxMs?: number;
  /** `/proc/pressure/io` some avg10 at call start. */
  psiIoAvg10?: number;
  /** D-030: what the bench's own backends waited on during the call. See {@link summarizeWaitSamples}. */
  waits?: WaitProfile;
  /** D-030: on-CPU time of the bench's backends over the call (`/proc/<pid>/schedstat`, summed). */
  pgCpuMs?: number;
  /** D-030: run-queue wait of those backends: runnable, but waiting for a CPU. */
  pgRunqMs?: number;
  /** D-030: run-queue wait of the bench process's main thread over the call. */
  clientRunqMs?: number;
  /**
   * D-032: backends seen by an in-call sampler poll but not the before-call pid list.
   * Why a pid is missing from the before list is not known (run 12: such pids were long-lived,
   * not born in the call), so none is counted from zero. Replaces D-031's `pgBackendsBorn`,
   * which did count them from zero and is retracted.
   */
  pgBackendsUnseen?: number;
  /**
   * D-032: of {@link pgBackendsUnseen}, the pids the wait sampler saw active during the call; each
   * is baselined at that first sighting and its delta from there is in pgCpuMs and pgRunqMs.
   */
  pgBackendsLateBaselined?: number;
  /**
   * D-032: per-pid deltas dropped because their CPU exceeded the schedstat window's wall time,
   * which one backend cannot do. Non-zero means a pid's baseline was not its state at window start.
   */
  pgPidsImplausible?: number;
  /** Observable skew around non-atomic /proc reads; counters span this wider bounded window. */
  schedBeforeSkewMs?: number;
  schedAfterSkewMs?: number;
  diagnosticSetupMs?: number;
  diagnosticCleanupMs?: number;
  pgPidsMeasured?: number;
  /** Sampler queries crossing a call boundary, excluded from the wait profile. */
  waitPollsExcluded?: number;
  waitSamplerFailed?: boolean;
  /** Unobserved time before/after accepted sampler polls; null means no in-call poll. */
  waitStartGapMs?: number | null;
  waitEndGapMs?: number | null;
}

/** One pg_stat_activity row of an active bench backend, sampled during a timed call (D-030). */
export interface WaitSample {
  waitEventType: string | null;
  waitEvent: string | null;
}

/** One poll of the wait sampler: when it ran (ms, any monotonic clock) and the active backends it saw. */
export interface WaitPoll {
  atMs: number;
  samples: readonly WaitSample[];
}

/**
 * D-030: what the bench's own backends were doing while a timed call ran. Counts are samples, so
 * a key's share is its share of sampled backend-time, not of wall time.
 */
export interface WaitProfile {
  /** Polls taken, including those that found no active backend (client, transit, between statements). */
  polls: number;
  /** Active-backend samples across all polls. */
  activeSamples: number;
  /** Samples per {@link waitEventKey}. */
  byEvent: Record<string, number>;
  /** Largest gap between consecutive polls: well above the interval, the sampler itself was stalled. */
  maxPollGapMs: number | null;
}

/**
 * The profile key of one sample. An active backend with no wait event is on a CPU or queued for
 * one: 'CPU' (schedstat's run-queue wait splits the two). Otherwise `<type>:<event>`, e.g.
 * `IO:DataFileRead`, `LWLock:BufferMapping`, `IPC:BufferIO`, `Lock:relation`.
 */
export function waitEventKey(s: WaitSample): string {
  if (!s.waitEventType) return 'CPU';
  return s.waitEvent ? `${s.waitEventType}:${s.waitEvent}` : s.waitEventType;
}

export function summarizeWaitSamples(polls: readonly WaitPoll[]): WaitProfile {
  const byEvent: Record<string, number> = {};
  let activeSamples = 0;
  let maxGap: number | null = null;
  for (const [i, p] of polls.entries()) {
    for (const s of p.samples) {
      const k = waitEventKey(s);
      byEvent[k] = (byEvent[k] ?? 0) + 1;
      activeSamples += 1;
    }
    if (i > 0) {
      const gap = p.atMs - polls[i - 1]!.atMs;
      if (maxGap === null || gap > maxGap) maxGap = gap;
    }
  }
  return { polls: polls.length, activeSamples, byEvent, maxPollGapMs: maxGap === null ? null : round1(maxGap) };
}

/** Sum wait profiles (e.g. over the tail calls of one pass). */
export function mergeWaitProfiles(profiles: readonly WaitProfile[]): WaitProfile {
  const byEvent: Record<string, number> = {};
  let polls = 0;
  let activeSamples = 0;
  let maxGap: number | null = null;
  for (const p of profiles) {
    polls += p.polls;
    activeSamples += p.activeSamples;
    for (const [k, n] of Object.entries(p.byEvent)) byEvent[k] = (byEvent[k] ?? 0) + n;
    if (p.maxPollGapMs !== null && (maxGap === null || p.maxPollGapMs > maxGap)) maxGap = p.maxPollGapMs;
  }
  return { polls, activeSamples, byEvent, maxPollGapMs: maxGap };
}

/** `/proc/<pid>/schedstat`: nanoseconds on a CPU, nanoseconds runnable but waiting for one. */
export interface Schedstat {
  cpuNs: number;
  runqNs: number;
}

/** Parse `/proc/<pid>/schedstat` ("<on-cpu ns> <run-queue ns> <timeslices>"); null if malformed. */
export function parseSchedstat(text: string | null | undefined): Schedstat | null {
  const m = /^\s*(\d+)\s+(\d+)(\s+\d+)?\s*$/.exec(text ?? '');
  return m ? { cpuNs: Number(m[1]), runqNs: Number(m[2]) } : null;
}

/**
 * Summed schedstat deltas, in ms, over the pids present in BOTH snapshots: a backend that appeared
 * or exited mid-call is left out rather than counted from zero (a recycled pid would otherwise add
 * another process's whole lifetime).
 *
 * D-032: when `maxCpuMs` is given (the wall time between the two snapshots, plus slack), a pid
 * whose CPU delta exceeds it is dropped and counted in `implausible`: one single-threaded backend
 * cannot run longer than the window, so such a delta means the baseline was not taken at the
 * window's start.
 */
export function schedstatDeltaMs(
  before: ReadonlyMap<number, Schedstat>,
  after: ReadonlyMap<number, Schedstat>,
  maxCpuMs?: number,
): { cpuMs: number; runqMs: number; pids: number; implausible: number } {
  let cpuNs = 0;
  let runqNs = 0;
  let pids = 0;
  let implausible = 0;
  for (const [pid, b] of before) {
    const a = after.get(pid);
    if (!a || a.cpuNs < b.cpuNs || a.runqNs < b.runqNs) continue;
    if (maxCpuMs !== undefined && (a.cpuNs - b.cpuNs) / 1e6 > maxCpuMs) {
      implausible += 1;
      continue;
    }
    cpuNs += a.cpuNs - b.cpuNs;
    runqNs += a.runqNs - b.runqNs;
    pids += 1;
  }
  return { cpuMs: round1(cpuNs / 1e6), runqMs: round1(runqNs / 1e6), pids, implausible };
}

/**
 * The lexical statements' share of one call, from pg_stat_statements snapshots taken just before
 * and just after it (both outside the timed window). Uses {@link statementDeltas}, so evicted or
 * reset counters count from zero.
 */
export function callAttribution(
  before: readonly StatementStat[],
  after: readonly StatementStat[],
): Pick<CallAttribution, 'pgExecMs' | 'pgReadMs' | 'pgBlksRead' | 'pgCalls'> {
  const d = statementDeltas(before, after);
  return {
    pgExecMs: round1(d.reduce((s, x) => s + x.totalExecMs, 0)),
    pgReadMs: round1(d.reduce((s, x) => s + x.sharedBlkReadMs, 0)),
    pgBlksRead: d.reduce((s, x) => s + x.sharedBlksRead, 0),
    pgCalls: d.reduce((s, x) => s + x.calls, 0),
  };
}

/** Sum over a set of observations: how much of the lexical leg was statement execution. */
export interface AttributionSummary {
  calls: number;
  wallMs: number;
  lexicalMs: number;
  pgExecMs: number;
  pgReadMs: number;
  /** Shared statement counters cannot decompose one call; retained as null for old readers. */
  outsideExecShare: null;
  /** D-030: summed over the calls that recorded them; absent when none did (an artifact before D-030). */
  pgCpuMs?: number;
  pgRunqMs?: number;
  clientRunqMs?: number;
  waits?: WaitProfile;
}

export function summarizeAttribution(observations: readonly ArmObservation[]): AttributionSummary {
  const with_ = observations.filter((o) => o.attrib && o.legMs && 'lexical:lexical' in o.legMs);
  const lexicalMs = round1(with_.reduce((s, o) => s + (o.legMs!['lexical:lexical'] ?? 0), 0));
  const pgExecMs = round1(with_.reduce((s, o) => s + o.attrib!.pgExecMs, 0));
  const sumOf = (k: 'pgCpuMs' | 'pgRunqMs' | 'clientRunqMs'): number | undefined => {
    const xs = with_.map((o) => o.attrib![k]).filter((v): v is number => typeof v === 'number');
    return xs.length ? round1(xs.reduce((s, v) => s + v, 0)) : undefined;
  };
  const waits = with_.map((o) => o.attrib!.waits).filter((w): w is WaitProfile => !!w);
  const sched = { pgCpuMs: sumOf('pgCpuMs'), pgRunqMs: sumOf('pgRunqMs'), clientRunqMs: sumOf('clientRunqMs') };
  return {
    calls: with_.length,
    wallMs: round1(with_.reduce((s, o) => s + o.latencyMs, 0)),
    lexicalMs,
    pgExecMs,
    pgReadMs: round1(with_.reduce((s, o) => s + o.attrib!.pgReadMs, 0)),
    outsideExecShare: null,
    ...Object.fromEntries(Object.entries(sched).filter(([, v]) => v !== undefined)),
    ...(waits.length ? { waits: mergeWaitProfiles(waits) } : {}),
  };
}

/**
 * D-030: the slowest calls of one pass, slowest first, with what they waited on: the calls a p95
 * over `observations` rests on (the top 5%, at least `min`). Only calls that recorded attribution
 * are listed; `count` says how many were eligible.
 */
export function tailAttribution(
  observations: readonly ArmObservation[],
  min = 3,
): { count: number; calls: Array<{ latencyMs: number; lexicalMs: number | null; attrib: CallAttribution }> } {
  const with_ = observations.filter((o): o is ArmObservation & { attrib: CallAttribution } => !!o.attrib);
  const n = Math.max(min, Math.ceil(observations.length * 0.05));
  const calls = [...with_]
    .sort((a, b) => b.latencyMs - a.latencyMs)
    .slice(0, n)
    .map((o) => ({ latencyMs: o.latencyMs, lexicalMs: o.legMs?.['lexical:lexical'] ?? null, attrib: o.attrib }));
  return { count: with_.length, calls };
}

/**
 * Sum the engine's per-source durations for every source call that actually RAN, keyed
 * `<leg>:<ranker>`. Input is `runHybridSearch(...).legs`; anything else yields `{}` (an
 * absent instrument is not a zero-millisecond leg, so callers should omit an empty result).
 */
export function legDurations(legs: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!legs || typeof legs !== 'object') return out;
  for (const [legName, leg] of Object.entries(legs as Record<string, unknown>)) {
    const calls = (leg as { sourceCalls?: unknown } | null)?.sourceCalls;
    if (!Array.isArray(calls)) continue;
    for (const c of calls as Array<{ ranker?: unknown; status?: unknown; durationMs?: unknown }>) {
      if (c?.status !== 'ran' || typeof c.durationMs !== 'number') continue;
      const key = `${legName}:${String(c.ranker)}`;
      out[key] = (out[key] ?? 0) + c.durationMs;
    }
  }
  return out;
}

export interface PairResult {
  /** Search source name, e.g. `work_item`, `session_turn`. */
  source: string;
  /** The known item's `source_id` as the source emits it. */
  targetId: string;
  style: QueryStyle;
  query: string;
  arms: Partial<Record<Arm, ArmObservation>>;
}

/** A source-derived sampling stratum, not a claim about all user queries. */
export const BM25_PROBE_SAMPLING_POLICY = {
  population: 'identity-safe derived known-item probes',
  eligibility: 'nonempty derivable query unchanged by the shared identity scrubber',
  exclusions: ['not-derivable', 'identity-bearing'] as const,
  selection: 'seeded candidate order; disjoint target/query samples; requested sample size is never lowered',
};

/** Freeze eligibility before search and retain every candidate without leaking its text. */
export function selectBm25ProbeInputs(source: string,
  candidates: readonly { targetId: string; style: QueryStyle; query: string | null }[], n: number) {
  const eligible = candidates.flatMap(p => p.query?.trim() && redactIdentityLeaks(p.query) === p.query
    ? [{ source, targetId: p.targetId, style: p.style, query: p.query, arms: {} } satisfies PairResult] : []);
  const split = splitDisjointSamples(eligible, n);
  const selected = new Map<string, string>();
  for (const pass of ['paired', 'warmup', 'steady'] as const)
    for (const p of split[pass]) selected.set(JSON.stringify([p.targetId, p.style, p.query]), pass);
  return { ...split, candidates: candidates.map((p, index) => ({ source, index, targetId: p.targetId, style: p.style,
    queryFingerprint: p.query === null ? null : createHash('sha256').update(p.query).digest('hex'),
    disposition: !p.query?.trim() ? 'not-derivable' : redactIdentityLeaks(p.query) !== p.query ? 'identity-bearing' :
      selected.get(JSON.stringify([p.targetId, p.style, p.query])) ?? 'not-selected',
  })) };
}

const queryInputPairSchema = z.object({
  source: z.enum(['work_item', 'session_turn']), targetId: z.string().min(1).refine(s => !!s.trim()),
  style: z.enum(['fragment', 'keyword']), query: z.string().min(1).refine(q => !!q.trim()),
}).strict();

/** Exact pre-execution requests, separate from observations and the retrieval corpus. */
export const bm25QueryInputsSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('bm25-hybrid-query-inputs'),
  preparedAt: z.string().refine(s => Number.isFinite(Date.parse(s))),
  seed: z.string().min(1), workspaceId: z.string().min(1),
  sources: z.array(z.enum(['work_item', 'session_turn'])).min(1), pairsPerSource: z.number().int().positive(),
  configuration: z.record(z.string(), z.unknown()),
  // Sampling known items does not freeze the corpus searched by either arm.
  corpus: z.null(),
  paired: z.array(queryInputPairSchema), warmup: z.array(queryInputPairSchema), steady: z.array(queryInputPairSchema),
}).strict().superRefine((m, ctx) => {
  if (new Set(m.sources).size !== m.sources.length)
    ctx.addIssue({ code: 'custom', message: 'duplicate input source' });
  const ids = new Set<string>(), queries = new Set<string>();
  for (const pass of ['paired', 'warmup', 'steady'] as const) {
    for (const source of m.sources) if (m[pass].filter(p => p.source === source).length > m.pairsPerSource)
      ctx.addIssue({ code: 'custom', message: 'input population exceeds requested sample' });
    for (const p of m[pass]) {
      if (!m.sources.includes(p.source)) ctx.addIssue({ code: 'custom', message: 'input outside declared sources' });
      const id = JSON.stringify([p.source, p.targetId]), query = JSON.stringify([p.source, p.query]);
      if (ids.has(id) || queries.has(query)) ctx.addIssue({ code: 'custom', message: 'input samples are not disjoint' });
      ids.add(id); queries.add(query);
    }
  }
  // Tracked evidence must never silently redact and thereby change a frozen request.
  if (redactIdentityLeaks(JSON.stringify(m)) !== JSON.stringify(m))
    ctx.addIssue({ code: 'custom', message: 'query inputs contain identity leaks; exact inputs cannot be redacted' });
});
export type Bm25QueryInputs = z.infer<typeof bm25QueryInputsSchema>;

export function freezeBm25QueryInputs(options: Omit<Bm25QueryInputs, 'schemaVersion' | 'kind' | 'corpus' | 'paired' | 'warmup' | 'steady'> & {
  paired: readonly PairResult[]; warmup: readonly PairResult[]; steady: readonly PairResult[];
}): Bm25QueryInputs {
  const strip = (rows: readonly PairResult[]) => rows.map(({ source, targetId, style, query }) => ({ source, targetId, style, query }));
  return bm25QueryInputsSchema.parse({ ...options, schemaVersion: 1, kind: 'bm25-hybrid-query-inputs', corpus: null,
    paired: strip(options.paired), warmup: strip(options.warmup), steady: strip(options.steady) });
}

/** Database names and ports locate an execution; they do not identify its corpus.
 * Keep them in the saved receipt, but compare the server's settings instead so
 * requests survive disposal of the private runtime that prepared them. Corpus
 * qualification remains separate: query inputs deliberately carry corpus:null. */
function queryConfigurationIdentity(configuration: Record<string, unknown>) {
  const server = configuration.server;
  if (!server || typeof server !== 'object' || Array.isArray(server)) return configuration;
  return { ...configuration, server: Object.fromEntries(Object.entries(server)
    .filter(([key]) => key !== 'db' && key !== 'port')) };
}

/** Admit saved bytes only for the exact requested population/configuration; never import results. */
export function restoreBm25QueryInputs(bytes: string, expected: Pick<Bm25QueryInputs,
  'seed' | 'workspaceId' | 'sources' | 'pairsPerSource' | 'configuration'>, expectedSha256?: string) {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (expectedSha256 !== undefined && sha256 !== expectedSha256) throw new Error('query input bytes differ from manifest');
  const inputs = bm25QueryInputsSchema.parse(JSON.parse(bytes));
  for (const key of ['seed', 'workspaceId', 'sources', 'pairsPerSource'] as const)
    if (!isDeepStrictEqual(inputs[key], expected[key])) throw new Error(`saved query input ${key} differs`);
  if (!isDeepStrictEqual(queryConfigurationIdentity(inputs.configuration), queryConfigurationIdentity(expected.configuration)))
    throw new Error('saved query input configuration differs');
  const pairs = (rows: Bm25QueryInputs['paired']): PairResult[] => rows.map(p => ({ ...p, arms: {} }));
  return { inputs, sha256, paired: pairs(inputs.paired), warmup: pairs(inputs.warmup), steady: pairs(inputs.steady) };
}

export interface ArmSummary {
  scored: number;
  /** Sum of measured vector contributions, or null when any observation lacks the measurement. */
  semanticCandidates: number | null;
  hitsAtK: number;
  recallAtK: number;
  mrrAtK: number;
  zeroHit: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  /** Distinct engines this arm's seam reported across the source's pairs. */
  engines: string[];
  /**
   * p95 of each leg's own time (`ArmObservation.legMs`) over the observations that recorded
   * it. Attribution only: R-18 judges `latencyP95Ms`, the whole call.
   */
  legP95Ms: Record<string, number | null>;
}

export interface PairedCounts {
  bm25Only: number;
  legacyOnly: number;
  both: number;
  neither: number;
}

export type Verdict = 'pass' | 'fail' | 'invalid';

/**
 * R-18's absolute ceilings (D-020), per source: the BM25 arm's end-to-end p95 may not exceed
 * these even when legacy is slower. They are D-016's measured p95 (152 / 324 ms) with about 30%
 * headroom. A source with no entry is judged against legacy only, and its reason says so.
 */
export const LATENCY_P95_CEILING_MS: Readonly<Record<string, number>> = {
  work_item: 200,
  session_turn: 400,
};

/**
 * R-18 clause (c), D-029: the cold paired pass's BM25-arm p95 may not exceed these, so a cold
 * call users would call slow still fails the bar even when legacy is slower still. About 1.6x
 * and 1.7x the highest cold p95 measured on the current search path (634 / 689.1 ms, five runs
 * on 2026-10-11), inside the 3.4x run-to-run swing D-028 measured on this host. Judged on every
 * run, dump overlap or not. A source with no entry has no cold ceiling.
 */
export const COLD_LATENCY_P95_CEILING_MS: Readonly<Record<string, number>> = {
  work_item: 1000,
  session_turn: 1200,
};

export type Bm25Pass = 'paired' | 'repeat-warmup' | 'warm-repeat' | 'steady-warmup' | 'steady';
export interface Bm25AttemptIdentity {
  id: string;
  cellId: string;
  source: string;
  queryClass: QueryStyle;
  pass: Bm25Pass;
  arm: Arm;
  queryFingerprint: string;
}

/** The declaration is written before embedding or executing ANY selected query. */
export function declareBm25Attempts(options: {
  declaredAt: string;
  sources: readonly string[];
  pairsPerSource: number;
  paired: readonly PairResult[];
  warmup: readonly PairResult[];
  steady: readonly PairResult[];
  pins: { source: string; corpus: string | null; queries: string; configuration: string };
}) {
  if (!Number.isInteger(options.pairsPerSource) || options.pairsPerSource < 1 ||
      !Number.isFinite(Date.parse(options.declaredAt)) || new Set(options.sources).size !== options.sources.length || !options.sources.length)
    throw new Error('invalid benchmark declaration');
  for (const p of [...options.paired, ...options.warmup, ...options.steady]) {
    if (!options.sources.includes(p.source) || !['fragment', 'keyword'].includes(p.style) || !p.query.trim() || !p.targetId.trim())
      throw new Error('sample outside declared benchmark population');
  }
  const attempts: Bm25AttemptIdentity[] = [];
  const cells = options.sources.flatMap(source => (['fragment', 'keyword'] as const).flatMap(queryClass =>
    (['paired', 'repeat-warmup', 'warm-repeat', 'steady-warmup', 'steady'] as const).flatMap(pass =>
      (pass === 'paired' ? ARMS : ['bm25'] as const).map(arm => {
        const cellId = [source, queryClass, pass, arm].join('/');
        const selected = (pass === 'steady' ? options.steady : pass === 'steady-warmup' ? options.warmup : options.paired)
          .filter(p => p.source === source && p.style === queryClass);
        const identities = selected.map(p => ({ id: bm25AttemptId(pass, p, arm), cellId, source, queryClass, pass, arm,
          queryFingerprint: createHash('sha256').update(p.query).digest('hex') }));
        attempts.push(...identities);
        return { id: cellId, product: 'papercusp', adapter: 'in-process/runHybridSearch', source, queryClass, pass, arm,
          temperature: pass === 'paired' ? 'cold' : 'warm',
          // Warm-ups are an explicit role, never censored measurement failures.
          role: pass.endsWith('warmup') ? 'warmup' : 'measurement',
          requestedPerSource: options.pairsPerSource, minExecuted: MIN_PAIRS_PER_SOURCE,
          coverageSource: 'bm25-hybrid-recall.ts#MIN_PAIRS_PER_SOURCE; applied prospectively to each query class',
          attemptIds: identities.map(a => a.id),
          maxP95LatencyMs: arm !== 'bm25' ? null : pass === 'paired' ? COLD_LATENCY_P95_CEILING_MS[source] ?? null :
            pass === 'warm-repeat' ? LATENCY_P95_CEILING_MS[source] ?? null : null,
          budgetSource: 'bm25-lexical-search-evoke-adoption-2026-10-10#D-020,D-028,D-029',
          quality: pass === 'paired' ? 'R-13 paired known-item recall nonregression; class-specific quality target unmeasured' : 'reported-only',
          maxPerAttemptCostUsd: null, maxErrorRate: 0, maxDegradedRate: 0, censoring: [] };
      }))));
  if (new Set(attempts.map(a => a.id)).size !== attempts.length) throw new Error('duplicate declared benchmark attempt');
  return { schemaVersion: 1 as const, declaredAt: options.declaredAt, pins: options.pins, cells, attempts };
}

export function bm25AttemptId(pass: Bm25Pass, pair: Pick<PairResult, 'source' | 'style' | 'targetId' | 'query'>, arm: Arm): string {
  return createHash('sha256').update(JSON.stringify([pass, pair.source, pair.style, pair.targetId, pair.query, arm])).digest('hex');
}

export interface Bm25AttemptReceipt {
  id: string;
  outcome: 'success' | 'timeout' | 'error' | 'unknown';
  executed: boolean;
  latencyMs: number | null;
  costUsd: number | null;
  observation: ArmObservation | null;
}

/** Keep one placeholder for every request, including work not reached after a failure. */
export function reconcileBm25Attempts(declaration: ReturnType<typeof declareBm25Attempts>, receipts: readonly Bm25AttemptReceipt[]) {
  const ids = new Set(declaration.attempts.map(a => a.id));
  if (new Set(receipts.map(r => r.id)).size !== receipts.length || receipts.some(r => !ids.has(r.id)))
    throw new Error('duplicate or undeclared benchmark receipt');
  const byId = new Map(receipts.map(r => [r.id, r]));
  const attempts = declaration.attempts.map(a => ({ ...a, ...(byId.get(a.id) ?? {
    outcome: 'unknown' as const, executed: false, latencyMs: null, costUsd: null, observation: null }) }));
  return { attempts, cells: declaration.cells.map(cell => {
    const mine = attempts.filter(a => a.cellId === cell.id);
    return { id: cell.id, attempted: mine.length, executed: mine.filter(a => a.executed).length,
      observed: mine.filter(a => a.outcome === 'success' && a.observation !== null).length,
      // Per-query relevance labels are not collected by this known-item latency instrument.
      judged: 0,
      errors: mine.filter(a => a.outcome === 'error').length, timeouts: mine.filter(a => a.outcome === 'timeout').length,
      unknown: mine.filter(a => a.outcome === 'unknown').length,
      populationStatus: mine.length < cell.minExecuted || mine.some(a => a.outcome === 'unknown' || !a.executed) ? 'unknown' : 'complete' };
  }), qualification: 'unknown' as const,
  unknowns: ['corpus and cost require independent measurement; this ledger alone is not a qualified search baseline'] };
}

/**
 * R-18's judgment, separate from R-13's recall verdict. Both bounds time the whole
 * `runHybridSearch` call (the BM25 list, the D-016 exact list and the fusion):
 * - D-019: on the paired cold pass, the BM25 arm's p95 may not exceed the legacy arm's p95 on
 *   the same pairs. Judged on every run: both arms meet the same host conditions.
 * - D-020: the source's absolute ceiling in `LATENCY_P95_CEILING_MS`. D-028: it bounds the
 *   warm-repeat pass's p95, the timed repeat of each paired query's BM25-arm call after an
 *   untimed one loaded its pages. That measures the path's own work (CPU and buffer hits) and
 *   not the host's per-block read latency, which run 8 showed swings the cold p95 3.4x with
 *   unchanged code. The cold paired p95 is reported against the ceiling, not judged.
 * - Before D-028 (no warm-repeat pass in the run) the ceiling bounds the paired p95, judged only
 *   when no full-database dump overlapped the paired calls (D-027): such artifacts are judged
 *   as they were then.
 * The steady pass (D-024/D-025) is reported data only; D-026 retracted the premise that it
 * isolates the path's own cost, so it judges nothing.
 */
export interface LatencyJudgment {
  verdict: Verdict;
  reason: string;
}

export interface SourceSummary {
  source: string;
  scored: number;
  arms: Record<Arm, ArmSummary>;
  paired: PairedCounts;
  /** R-13: recall@K of the BM25 arm against the legacy arm. */
  verdict: Verdict;
  reasons: string[];
  /**
   * The steady pass (D-024/D-025): the BM25 arm over this source's steady sample, or null when
   * none was run. Reported data only since D-026; it judges nothing.
   */
  steady: ArmSummary | null;
  /** Why the steady pass is not a sound sample (see {@link steadyPassProblems}); empty when none was run. */
  steadyProblems: string[];
  /** D-027: whether a full-database dump overlapped this source's paired calls (see {@link dumpOverlapOf}). */
  dumpOverlap: boolean | null | undefined;
  /**
   * D-028: the warm-repeat pass, the timed second BM25-arm call of each paired query (the
   * untimed first one loaded its pages). The D-020 ceiling judges its p95. Null when the run
   * had no warm-repeat pass (an artifact written before D-028).
   */
  warmRepeat: ArmSummary | null;
  /** Why the warm-repeat pass cannot carry the ceiling (see {@link bm25PassProblems}); empty when sound or absent. */
  warmRepeatProblems: string[];
  /**
   * D-028: timed warm repeats whose lexical statements read blocks not in shared buffers, by
   * the pg_stat_statements delta. An upper bound (the delta also counts peers running the
   * same statement), so it is reported, not judged; null when no repeat recorded attribution.
   */
  warmRepeatReadCalls: number | null;
  /** R-18: the paired relative bound (D-019) and the absolute ceiling (D-020; D-027, D-028). */
  latency: LatencyJudgment;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? null;
}

function found(o: ArmObservation | undefined): boolean {
  return o?.rank != null && o.rank <= RECALL_K;
}

/** Score one arm over a set of pairs. Pairs missing the arm are not counted. */
export function summarizeArm(pairs: readonly PairResult[], arm: Arm): ArmSummary {
  const observed = pairs.map((p) => p.arms[arm]).filter((o): o is ArmObservation => o !== undefined);
  const hitsAtK = observed.filter(found).length;
  const mrr = observed.reduce((s, o) => s + (found(o) ? 1 / (o.rank as number) : 0), 0);
  const latencies = observed.map((o) => o.latencyMs).sort((a, b) => a - b);
  const legKeys = [...new Set(observed.flatMap((o) => Object.keys(o.legMs ?? {})))].sort();
  const legP95Ms = Object.fromEntries(legKeys.map((k) => [
    k,
    percentile(observed.flatMap((o) => (o.legMs && k in o.legMs ? [o.legMs[k]!] : [])).sort((a, b) => a - b), 95),
  ]));
  return {
    scored: observed.length,
    semanticCandidates: observed.length && observed.every(o =>
      Number.isInteger(o.semanticCandidates) && o.semanticCandidates! >= 0)
      ? observed.reduce((sum, o) => sum + o.semanticCandidates!, 0) : null,
    hitsAtK,
    recallAtK: observed.length ? hitsAtK / observed.length : 0,
    mrrAtK: observed.length ? mrr / observed.length : 0,
    zeroHit: observed.filter((o) => o.hits === 0).length,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    engines: [...new Set(observed.map((o) => o.engine))].sort(),
    legP95Ms,
  };
}

/** Per-pair agreement between the arms (McNemar's discordant cells are bm25Only / legacyOnly). */
export function pairedCounts(pairs: readonly PairResult[]): PairedCounts {
  const c: PairedCounts = { bm25Only: 0, legacyOnly: 0, both: 0, neither: 0 };
  for (const p of pairs) {
    const b = found(p.arms.bm25);
    const l = found(p.arms.legacy);
    if (b && l) c.both += 1;
    else if (b) c.bm25Only += 1;
    else if (l) c.legacyOnly += 1;
    else c.neither += 1;
  }
  return c;
}

/**
 * Judge one source. `invalid` when the comparison cannot support a verdict (too few
 * pairs, a pair missing an arm, or an arm that did not run its engine); `fail` when the
 * BM25 arm's recall@K is below the legacy arm's; otherwise `pass`.
 */
export function summarizeSource(
  source: string,
  pairs: readonly PairResult[],
  minPairs: number = MIN_PAIRS_PER_SOURCE,
  steadyPairs: readonly PairResult[] | null = null,
  warmPairs: readonly PairResult[] | null = null,
): SourceSummary {
  const mine = pairs.filter((p) => p.source === source);
  const steadyMine = steadyPairs?.filter((p) => p.source === source) ?? null;
  const steady = steadyMine ? summarizeArm(steadyMine, 'bm25') : null;
  const warmMine = warmPairs?.filter((p) => p.source === source) ?? null;
  const warmRepeat = warmMine ? summarizeArm(warmMine, 'bm25') : null;
  const warmRepeatProblems = warmMine ? bm25PassProblems(warmMine, minPairs, 'warm-repeat') : [];
  const warmObs = (warmMine ?? []).flatMap((p) => (p.arms.bm25?.attrib ? [p.arms.bm25.attrib] : []));
  const warmRepeatReadCalls = warmObs.length ? warmObs.filter((a) => a.pgBlksRead > 0).length : null;
  const arms = { legacy: summarizeArm(mine, 'legacy'), bm25: summarizeArm(mine, 'bm25') };
  const reasons: string[] = [];
  for (const arm of ARMS) {
    if (arms[arm].semanticCandidates === null) reasons.push(`${arm} semantic contribution was not measured`);
    else if (arms[arm].semanticCandidates === 0) reasons.push(`${arm} semantic leg contributed no candidates; this is not a hybrid comparison`);
  }
  const incomplete = mine.filter((p) => !p.arms.legacy || !p.arms.bm25).length;
  if (incomplete > 0) reasons.push(`${incomplete} pair(s) were not scored by both arms`);
  if (mine.length < minPairs) reasons.push(`only ${mine.length} pair(s); at least ${minPairs} are needed`);
  if (arms.legacy.engines.join() !== 'legacy') {
    reasons.push(`legacy arm ran engine(s) [${arms.legacy.engines.join(', ')}], expected [legacy]`);
  }
  if (arms.bm25.engines.join() !== 'bm25') {
    reasons.push(`BM25 arm ran engine(s) [${arms.bm25.engines.join(', ')}], expected [bm25]: the flag flip did not reach the lexical seam`);
  }
  let verdict: Verdict;
  if (reasons.length > 0) verdict = 'invalid';
  else if (arms.bm25.hitsAtK < arms.legacy.hitsAtK) {
    verdict = 'fail';
    reasons.push(`BM25 recall@${RECALL_K} ${arms.bm25.hitsAtK}/${arms.bm25.scored} is below legacy ${arms.legacy.hitsAtK}/${arms.legacy.scored}`);
  } else {
    verdict = 'pass';
    reasons.push(`BM25 recall@${RECALL_K} ${arms.bm25.hitsAtK}/${arms.bm25.scored} >= legacy ${arms.legacy.hitsAtK}/${arms.legacy.scored}`);
  }
  const dumpOverlap = dumpOverlapOf(mine);
  const latency: LatencyJudgment = verdict === 'invalid'
    ? { verdict: 'invalid', reason: 'the comparison is invalid (see reasons), so latency is not judged' }
    : judgeLatency(
        arms,
        LATENCY_P95_CEILING_MS[source] ?? null,
        dumpOverlap,
        warmRepeat ? { summary: warmRepeat, problems: warmRepeatProblems } : null,
        COLD_LATENCY_P95_CEILING_MS[source] ?? null,
      );
  const steadyProblems = steadyMine ? steadyPassProblems(steadyMine, minPairs) : [];
  return {
    source,
    scored: mine.length,
    arms,
    paired: pairedCounts(mine),
    verdict,
    reasons,
    steady,
    steadyProblems,
    dumpOverlap,
    warmRepeat,
    warmRepeatProblems,
    warmRepeatReadCalls,
    latency,
  };
}

/**
 * Why a BM25-only pass cannot carry a judgment: too few calls, a call that did not record the
 * BM25 arm, or a call whose seam ran another engine (the flag did not reach it). `label` names
 * the pass in the messages. Empty when the pass is usable.
 */
export function bm25PassProblems(passPairs: readonly PairResult[], minPairs: number = MIN_PAIRS_PER_SOURCE, label = 'steady'): string[] {
  const problems: string[] = [];
  const missing = passPairs.filter((p) => !p.arms.bm25).length;
  if (missing > 0) problems.push(`${missing} ${label} call(s) recorded no BM25 observation`);
  const scored = passPairs.length - missing;
  if (scored < minPairs) problems.push(`only ${scored} ${label} call(s); at least ${minPairs} are needed`);
  const engines = [...new Set(passPairs.flatMap((p) => (p.arms.bm25 ? [p.arms.bm25.engine] : [])))].sort();
  if (scored > 0 && engines.join() !== 'bm25') problems.push(`${label} calls ran engine(s) [${engines.join(', ')}], expected [bm25]`);
  return problems;
}

/** The steady pass's problems (D-024/D-025); reported only since D-026. See {@link bm25PassProblems}. */
export function steadyPassProblems(steadyPairs: readonly PairResult[], minPairs: number = MIN_PAIRS_PER_SOURCE): string[] {
  return bm25PassProblems(steadyPairs, minPairs, 'steady');
}

/** D-028: the warm-repeat pass as {@link judgeLatency} reads it. */
export interface WarmRepeatPass {
  summary: ArmSummary;
  problems: string[];
}

/**
 * R-18: `fail` when the paired BM25 p95 exceeds the legacy arm's (D-019, judged on every run),
 * or when the ceiling-judged p95 exceeds `ceilingMs` (D-020). `invalid` with no samples;
 * `ceilingMs: null` judges against legacy only.
 *
 * With a warm-repeat pass (`warm`, D-028) the ceiling judges `warm.summary.latencyP95Ms`; a
 * warm-repeat pass with problems is `invalid` for the ceiling unless the relative bound already
 * failed. The dump overlap is not a precondition then: the repeat's pages are already cached.
 *
 * Without one (`warm` null: an artifact written before D-028) the ceiling judges the paired p95
 * as D-027 did: only when `dumpOverlap` is `false`, or `undefined` (an artifact written before
 * D-027); with a dump overlapping (`true`) or unchecked (`null`) the ceiling is `invalid`.
 *
 * `coldCeilingMs` (D-029) bounds the paired p95 absolutely on every run, dump or not: a breach
 * is `fail` and outranks an unsound warm-repeat pass. `null` means no cold ceiling.
 */
export function judgeLatency(
  arms: Record<Arm, ArmSummary>,
  ceilingMs: number | null = null,
  dumpOverlap: boolean | null | undefined = undefined,
  warm: WarmRepeatPass | null = null,
  coldCeilingMs: number | null = null,
): LatencyJudgment {
  const bm25 = arms.bm25.latencyP95Ms;
  const legacy = arms.legacy.latencyP95Ms;
  if (bm25 == null || legacy == null) {
    return { verdict: 'invalid', reason: 'an arm has no latency samples' };
  }
  const warmP95 = warm?.summary.latencyP95Ms ?? null;
  const coldBreach = coldCeilingMs != null && bm25 > coldCeilingMs
    ? `the cold paired BM25 p95 ${bm25} ms exceeds the ${coldCeilingMs} ms cold ceiling (D-029)`
    : null;
  if (bm25 > legacy) {
    const judged = warm ? warmP95 : bm25;
    const what = warm ? `the warm-repeat p95 ${warmP95} ms also exceeds` : 'it also exceeds';
    const ceiling = ceilingMs != null && judged != null && judged > ceilingMs ? `; ${what} the ${ceilingMs} ms ceiling` : '';
    const cold = coldBreach ? `; ${coldBreach}` : '';
    return { verdict: 'fail', reason: `BM25-arm p95 ${bm25} ms exceeds legacy p95 ${legacy} ms${ceiling}${cold}` };
  }
  const relative = `BM25-arm p95 ${bm25} ms <= legacy p95 ${legacy} ms`;
  if (coldBreach) return { verdict: 'fail', reason: `${relative}, but ${coldBreach}` };
  const coldOk = coldCeilingMs != null ? `cold paired BM25 p95 ${bm25} ms <= the ${coldCeilingMs} ms cold ceiling (D-029)` : null;
  if (ceilingMs == null) {
    return { verdict: 'pass', reason: `${relative}${coldOk ? `; ${coldOk}` : ''} (no absolute ceiling for this source)` };
  }
  if (warm) {
    if (warm.problems.length > 0 || warmP95 == null) {
      const why = warm.problems.length ? warm.problems.join('; ') : 'it has no latency samples';
      const coldPart = coldOk ? `; ${coldOk}` : '';
      return { verdict: 'invalid', reason: `${relative}${coldPart}; the ${ceilingMs} ms ceiling is not judged: the warm-repeat pass is unsound: ${why} (D-028)` };
    }
    const cold = coldOk ?? `cold paired p95 ${bm25} ms reported, not judged (D-028)`;
    if (warmP95 > ceilingMs) {
      return { verdict: 'fail', reason: `${relative}, but the warm-repeat BM25 p95 ${warmP95} ms exceeds the ${ceilingMs} ms ceiling; ${cold}` };
    }
    return { verdict: 'pass', reason: `${relative}; warm-repeat BM25 p95 ${warmP95} ms <= the ${ceilingMs} ms ceiling; ${cold}` };
  }
  if (dumpOverlap === true || dumpOverlap === null) {
    const why = dumpOverlap
      ? 'a full-database dump (pcbackup) was in progress during the paired calls'
      : 'whether a full-database dump overlapped the paired calls could not be checked';
    return { verdict: 'invalid', reason: `${relative}; the ${ceilingMs} ms ceiling is not judged on this run: ${why} (D-027)` };
  }
  if (bm25 > ceilingMs) return { verdict: 'fail', reason: `${relative}, but it exceeds the ${ceilingMs} ms ceiling` };
  return { verdict: 'pass', reason: `${relative} and the ${ceilingMs} ms ceiling` };
}

/** One normalized statement's cumulative counters from `pg_stat_statements`. */
export interface StatementStat {
  /** pg_stat_statements row identity is the full tuple, never queryid alone. */
  userid: string;
  dbid: string;
  toplevel: boolean;
  queryid: string;
  calls: number;
  totalExecMs: number;
  sharedBlksHit: number;
  sharedBlksRead: number;
  /** `shared_blk_read_time`: time spent reading blocks not in shared buffers (needs track_io_timing). */
  sharedBlkReadMs: number;
  /** Normalized query text, whitespace-collapsed and truncated. */
  query: string;
}

export interface StatementDelta extends StatementStat {
  meanExecMs: number | null;
  /** sharedBlkReadMs / totalExecMs: the share of execution spent waiting on block reads. */
  readTimeShare: number | null;
}

/**
 * Per-statement change between two `pg_stat_statements` snapshots, statements with calls in
 * the window only, slowest total first. A statement absent from `before`, or whose counters
 * went backwards (evicted or reset in between), counts from zero. The view is cluster-wide, so
 * a delta also contains any concurrent calls of the same normalized statement by other
 * sessions; compare `calls` with the calls the bench made.
 */
export function statementDeltas(before: readonly StatementStat[], after: readonly StatementStat[]): StatementDelta[] {
  // Same identity contract as hot-seq-scan-detector.sampleKey, without importing its DB runtime.
  const key = (s: StatementStat) => `${s.userid}:${s.dbid}:${s.queryid}:${s.toplevel}`;
  const prior = new Map(before.map((s) => [key(s), s]));
  const out: StatementDelta[] = [];
  for (const a of after) {
    const b0 = prior.get(key(a));
    const b = b0 && b0.calls <= a.calls && b0.totalExecMs <= a.totalExecMs ? b0 : null;
    const calls = a.calls - (b?.calls ?? 0);
    if (calls <= 0) continue;
    const totalExecMs = round1(a.totalExecMs - (b?.totalExecMs ?? 0));
    const sharedBlkReadMs = round1(a.sharedBlkReadMs - (b?.sharedBlkReadMs ?? 0));
    out.push({
      userid: a.userid,
      dbid: a.dbid,
      toplevel: a.toplevel,
      queryid: a.queryid,
      calls,
      totalExecMs,
      sharedBlksHit: a.sharedBlksHit - (b?.sharedBlksHit ?? 0),
      sharedBlksRead: a.sharedBlksRead - (b?.sharedBlksRead ?? 0),
      sharedBlkReadMs,
      query: a.query,
      meanExecMs: round1(totalExecMs / calls),
      readTimeShare: totalExecMs > 0 ? Math.round((sharedBlkReadMs / totalExecMs) * 1000) / 1000 : null,
    });
  }
  return out.sort((x, y) => y.totalExecMs - x.totalExecMs);
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Split one source's derivable candidates, in their seeded order, into the three disjoint
 * samples of D-025: `paired` (the first `n`, identical to the pre-D-024 sample for the same
 * seed), `warmup` (the next `n`) and `steady` (the next `n`). A later candidate whose query
 * text repeats an earlier one is skipped, so the three are disjoint by target id and by query.
 * A set may come up short when the source has too few candidates; the steady pass's validity
 * check then reports it.
 */
export function splitDisjointSamples<P extends Pick<PairResult, 'targetId' | 'query'>>(
  candidates: readonly P[],
  n: number,
): { paired: P[]; warmup: P[]; steady: P[] } {
  const ids = new Set<string>();
  const queries = new Set<string>();
  const taken: P[] = [];
  for (const c of candidates) {
    if (taken.length >= n * 3) break;
    if (ids.has(c.targetId) || queries.has(c.query)) continue;
    ids.add(c.targetId);
    queries.add(c.query);
    taken.push(c);
  }
  return { paired: taken.slice(0, n), warmup: taken.slice(n, 2 * n), steady: taken.slice(2 * n, 3 * n) };
}

function combine(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.length === 0) return 'invalid';
  if (verdicts.includes('invalid')) return 'invalid';
  if (verdicts.includes('fail')) return 'fail';
  return 'pass';
}

/** The overall R-13 verdict: `invalid` if any source is, else `fail` if any source is, else `pass`. */
export function overallVerdict(sources: readonly SourceSummary[]): Verdict {
  return combine(sources.map((s) => s.verdict));
}

/**
 * Embed every distinct query once, in sample order, BEFORE any arm is timed (D-021). The CLI
 * caches embeddings per query, so without this the arm that runs first in a pair also pays for
 * the in-process embedding: measured 2026-10-11, the session_turn BM25 arm's p95 was 596 ms
 * when it ran first and 303 ms when it ran second. Embedding is identical for both arms and not
 * something this plan changes, so it must not land in either arm's latency. Returns how many
 * distinct queries were embedded.
 */
export async function warmQueryEmbeddings(
  pairs: readonly Pick<PairResult, 'query'>[],
  embed: (text: string) => Promise<unknown>,
): Promise<number> {
  const seen = new Set<string>();
  for (const p of pairs) {
    if (seen.has(p.query)) continue;
    seen.add(p.query);
    await embed(p.query);
  }
  return seen.size;
}

/** The overall R-18 verdict, combined the same way over each source's latency judgment. */
export function overallLatencyVerdict(sources: readonly SourceSummary[]): Verdict {
  return combine(sources.map((s) => s.latency.verdict));
}

/**
 * A fingerprint of the sample (source, target, style, query), order-independent. Both arms
 * read the same in-memory pairs, so this pins WHICH sample the evidence is about.
 */
export function sampleFingerprint(pairs: readonly Pick<PairResult, 'source' | 'targetId' | 'style' | 'query'>[]): string {
  const lines = pairs.map((p) => `${p.source}\t${p.targetId}\t${p.style}\t${p.query}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * The pairs as they may be written to a tracked evidence file. Probe queries are sampled from
 * live rows, so one can carry this box's identity (a home path, the git name or email); the
 * release-bundle identity audit then refuses the file and git-sync quarantines it (measured
 * 2026-10-11: a session-turn query held a home path). Each query is passed through the shared
 * redactor. `sampleFingerprint` is computed on the raw queries BEFORE this, so the recorded
 * fingerprint still names the sample that ran; `redactedQueries` says how many were changed.
 */
export function redactPairsForArtifact<P extends { query: string }>(
  pairs: readonly P[],
  literals?: [string, string][],
): { pairs: P[]; redactedQueries: number } {
  let redactedQueries = 0;
  const out = pairs.map((p) => {
    const query = redactIdentityLeaks(p.query, literals);
    if (query === p.query) return p;
    redactedQueries += 1;
    return { ...p, query };
  });
  return { pairs: out, redactedQueries };
}

/** Run order for pair `i`: alternate which arm goes first so warm caches favour neither. */
export function armOrder(i: number): readonly Arm[] {
  return i % 2 === 0 ? ['legacy', 'bm25'] : ['bm25', 'legacy'];
}

/** The 1-based rank of `targetId` from `source` in a fused hit list, or null. */
export function rankOf(
  hits: readonly { source: string; source_id: string }[],
  source: string,
  targetId: string,
): number | null {
  const i = hits.findIndex((h) => h.source === source && h.source_id === targetId);
  return i >= 0 ? i + 1 : null;
}
