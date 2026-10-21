/**
 * Offline replay of the code-intelligence routing signal over persisted
 * consult routings (plan code-intel-relevance-routing-2026-10-21, P-005 / R-6).
 *
 * READ-ONLY: it loads `consult_state.routing` snapshots and never writes them.
 *
 * For each routing it resolves the question to code files exactly as the live
 * router does (`resolveQuestionCodeSubjects`), measures each stored candidate's
 * familiarity with those files AS OF THE ROUTING'S OWN TIMESTAMP (so an edit
 * made afterwards is never credited), and re-scores the stored candidates with
 * the router's own `relevanceOf` / `freshnessOf` / `snapshotCandidateQualifies`.
 *
 * Two passes over every snapshot share one code path: a CONTROL pass with no
 * code signal and the TREATMENT pass with it. The control is also compared with
 * the stored ranking (`controlDrift`), which is how a reader can tell the replay
 * reproduces the router rather than a re-implementation of it.
 *
 * Known limits, reported rather than hidden:
 *  - only the candidates the snapshot stored can be re-ranked (snapshots are
 *    bounded), so a responder the router never stored cannot appear;
 *  - identifiers resolve against the CURRENT tree, not the tree at routing time;
 *  - in a snapshot with subject refs, a candidate that never had subject
 *    evidence measured cannot newly qualify: the live router would have had to
 *    measure it, and the replay cannot;
 *  - the router stores ages clamped at 0, so a non-qualified candidate NEWER
 *    than the old reference reads as age 0; when it newly qualifies the replay
 *    cannot age the others by the true gap. That favours the previous top, so
 *    the replay can only UNDERcount top-candidate changes, never inflate them.
 */
import type { Sql } from 'postgres';
import { codeAuthorshipScore, measureCodeFamiliarity, type CodeFamiliarity } from './code-familiarity';
import {
  extractIdentifierTokens,
  hasCodeSubjects,
  resolveQuestionCodeSubjects,
  type SymbolResolver,
} from './code-subject-resolution';
import {
  DEFAULT_RECENCY_HALF_LIFE_DAYS,
  DEFAULT_WEIGHTS,
  freshnessOf,
  relevanceOf,
  snapshotCandidateQualifies,
  type BlendWeights,
} from './relevance-router';

const MS_PER_DAY = 86_400_000;
export const REPLAY_RESOLVE_CHUNK = 40;
export const REPLAY_FAMILIARITY_TIMEOUT_MS = 20_000;
export const REPLAY_EXAMPLE_LIMIT = 8;

const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export interface ReplayCandidate {
  ownerId: string;
  relevance?: number;
  score?: number;
  relativeAgeDays?: number | null;
  signals?: { similarity?: number; verification?: number; authorship?: number; freshness?: number };
  subjectEvidence?: { status?: unknown } | null;
  subjectEvidenceCoverage?: { status?: unknown } | null;
}

export interface ReplaySnapshot {
  relevanceFloor?: number;
  simFloor?: number;
  floor?: number;
  weights?: BlendWeights;
  recencyHalfLifeDays?: number;
  subjectRefs?: string[];
  candidates: ReplayCandidate[];
}

export interface PersistedRouting {
  consultId: string;
  workspaceId: string;
  question: string;
  createdAt: string;
  snapshot: ReplaySnapshot;
}

export interface RescoredCandidate {
  ownerId: string;
  authorship: number;
  relevance: number;
  score: number;
  qualifies: boolean;
}

export interface RescoreResult {
  candidates: RescoredCandidate[];
  top: string | null;
  qualified: number;
  anyAuthorship: boolean;
}

/**
 * A snapshot is replayable only when every stored candidate's relevance is
 * exactly what `relevanceOf` recomputes from its stored signals and weights.
 * Older formats (a legacy `floor`, cascade snapshots, renamed signals) fail
 * this, and re-scoring them would report format drift as a rank change.
 */
export function isReplayable(snapshot: ReplaySnapshot): boolean {
  const weights = snapshot.weights ?? DEFAULT_WEIGHTS;
  return snapshot.candidates.every((c) => typeof c.relevance === 'number' && Math.abs(relevanceOf({
    similarity: num(c.signals?.similarity), verification: num(c.signals?.verification), authorship: num(c.signals?.authorship),
  }, weights) - c.relevance) <= 1e-9);
}

/** The stored outcome, unchanged: used on both sides for an unreplayable snapshot. */
export function storedResult(snapshot: ReplaySnapshot): RescoreResult {
  return {
    candidates: [],
    top: storedTop(snapshot),
    qualified: snapshot.candidates.filter((c) => snapshotCandidateQualifies(snapshot, c)).length,
    anyAuthorship: snapshot.candidates.some((c) => num(c.signals?.authorship) > 0),
  };
}

/** The candidate the stored snapshot itself would route to (stored score order). */
export function storedTop(snapshot: ReplaySnapshot): string | null {
  const ordered = [...snapshot.candidates].sort((a, b) => num(b.score) - num(a.score) || a.ownerId.localeCompare(b.ownerId));
  return ordered.find((c) => snapshotCandidateQualifies(snapshot, c))?.ownerId ?? null;
}

/**
 * Re-score a stored snapshot with code familiarity folded into authorship the
 * way the router folds it (`max(path-substring authorship, code authorship)`).
 * `familiarity: null` is the control pass: authorship stays as stored.
 */
export function rescoreSnapshot(snapshot: ReplaySnapshot, familiarity: ReadonlyMap<string, CodeFamiliarity> | null): RescoreResult {
  const weights = snapshot.weights ?? DEFAULT_WEIGHTS;
  const halfLife = snapshot.recencyHalfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS;
  const hasSubjectRefs = (snapshot.subjectRefs?.length ?? 0) > 0;
  const base = snapshot.candidates.map((c) => {
    const similarity = num(c.signals?.similarity);
    const verification = num(c.signals?.verification);
    const authorship = clamp01(Math.max(num(c.signals?.authorship), familiarity ? codeAuthorshipScore(familiarity.get(c.ownerId)) : 0));
    const relevance = relevanceOf({ similarity, verification, authorship }, weights);
    const storedQualifies = snapshotCandidateQualifies(snapshot, c);
    const neverMeasured = hasSubjectRefs && !c.subjectEvidence && !c.subjectEvidenceCoverage;
    // A legacy snapshot gates on score (relevance x freshness): scale by the stored freshness.
    const legacyScore = relevance * (typeof c.signals?.freshness === 'number' ? c.signals.freshness : 1);
    const qualifies = (storedQualifies || !neverMeasured) && snapshotCandidateQualifies(snapshot, { ...c, relevance, score: legacyScore });
    // Ages are stored relative to the old reference frame; invert to offsets
    // on one axis so the frame can move when the qualified set changes.
    const offsetDays = typeof c.relativeAgeDays === 'number' && Number.isFinite(c.relativeAgeDays) ? -c.relativeAgeDays : null;
    return { c, authorship, relevance, qualifies, offsetDays };
  });
  const newest = (rows: typeof base): number | null => rows.reduce<number | null>(
    (best, r) => (r.offsetDays !== null && (best === null || r.offsetDays > best) ? r.offsetDays : best), null);
  const referenceDays = newest(base.filter((r) => r.qualifies)) ?? newest(base);
  const candidates: RescoredCandidate[] = base.map((r) => {
    const freshness = r.offsetDays !== null && referenceDays !== null
      ? freshnessOf(r.offsetDays * MS_PER_DAY, referenceDays * MS_PER_DAY, halfLife).freshness
      : num(r.c.signals?.freshness);
    return { ownerId: r.c.ownerId, authorship: r.authorship, relevance: r.relevance, score: clamp01(r.relevance * freshness), qualifies: r.qualifies };
  });
  candidates.sort((a, b) => b.score - a.score || a.ownerId.localeCompare(b.ownerId));
  return {
    candidates,
    top: candidates.find((c) => c.qualifies)?.ownerId ?? null,
    qualified: candidates.filter((c) => c.qualifies).length,
    anyAuthorship: candidates.some((c) => c.authorship > 0),
  };
}

/**
 * Resolve every distinct identifier the questions name in bounded batches, then
 * serve each question from that cache. A batch that fails marks its identifiers
 * unavailable, and a question naming one resolves as `unavailable`, exactly as a
 * live resolver failure would.
 */
export async function prefetchingResolver(questions: readonly string[], resolve: SymbolResolver, chunk = REPLAY_RESOLVE_CHUNK): Promise<SymbolResolver> {
  const distinct = [...new Set(questions.flatMap((q) => extractIdentifierTokens(q)))];
  const resolved = new Map<string, string[]>();
  const failed = new Set<string>();
  for (let i = 0; i < distinct.length; i += chunk) {
    const batch = distinct.slice(i, i + chunk);
    try {
      const byId = await resolve(batch);
      for (const id of batch) resolved.set(id, byId.get(id) ?? []);
    } catch {
      for (const id of batch) failed.add(id);
    }
  }
  return async (identifiers) => {
    if (identifiers.some((id) => failed.has(id))) throw new Error('identifier batch unavailable');
    return new Map(identifiers.map((id) => [id, resolved.get(id) ?? []]));
  };
}

export interface Share { count: number; of: number; share: number }
const share = (count: number, of: number): Share => ({ count, of, share: of > 0 ? count / of : 0 });

/** The population `consultStateRoutingLoader` selects; every report records it. */
export const REPLAY_SELECTOR =
  'harness_shared.consult_state rows with since < created_at <= until whose routing.candidates is a JSON array';

/**
 * The paired cohort efficacy is measured on: routings that are BOTH replayable and
 * code-related, so each is rescored on both arms and the control arm is a
 * same-selector baseline. Unreplayable routings never enter these denominators;
 * they are attrition, reported in `attrition`.
 */
export interface ReplayCohort {
  pairedCodeRelated: number;
  codeSignal: { control: Share; treated: Share };
  topCandidateChanges: Share;
  noQualified: { control: Share; treated: Share };
  /** Of replayable routings: resolution was attempted on every one. */
  resolverUnavailable: Share;
  /** Of paired routings with at least one stored candidate: familiarity was attempted on every one. */
  familiarityUnmeasured: Share;
}

/** Thresholds of plan bar R-6, held here so the test and the recorded measurement apply the same rule. */
export const REPLAY_BAR = { minPairedCohort: 30, maxUnavailableShare: 0.05 } as const;

export interface ReplayBarDecision { pass: boolean; failures: string[] }

export function evaluateReplayBar(
  report: Pick<CodeSignalReplayReport, 'cohort' | 'controlDrift'>,
  bar: { minPairedCohort: number; maxUnavailableShare: number } = REPLAY_BAR,
): ReplayBarDecision {
  const c = report.cohort;
  const failures: string[] = [];
  const pct = (s: Share) => `${s.count}/${s.of}`;
  if (c.pairedCodeRelated < bar.minPairedCohort) failures.push(`paired cohort ${c.pairedCodeRelated} < ${bar.minPairedCohort}`);
  if (report.controlDrift !== 0) failures.push(`controlDrift ${report.controlDrift} != 0`);
  if (!(c.codeSignal.treated.share > c.codeSignal.control.share)) {
    failures.push(`code-signal share did not rise: control ${pct(c.codeSignal.control)}, treated ${pct(c.codeSignal.treated)}`);
  }
  if (c.topCandidateChanges.count < 1) failures.push('no top-candidate change in the paired cohort');
  if (c.noQualified.treated.share > c.noQualified.control.share) {
    failures.push(`no-qualified share rose: control ${pct(c.noQualified.control)}, treated ${pct(c.noQualified.treated)}`);
  }
  if (c.resolverUnavailable.share >= bar.maxUnavailableShare) failures.push(`resolver unavailable ${pct(c.resolverUnavailable)} >= ${bar.maxUnavailableShare}`);
  if (c.familiarityUnmeasured.share >= bar.maxUnavailableShare) failures.push(`familiarity unmeasured ${pct(c.familiarityUnmeasured)} >= ${bar.maxUnavailableShare}`);
  return { pass: failures.length === 0, failures };
}

export interface CodeSignalReplayReport {
  window: { since: string; until: string };
  selector: string;
  /** Build the replay ran from, supplied by the caller (null when not given). */
  buildSha: string | null;
  attrition: { routings: number; replayable: number; unreplayable: number; codeRelated: number; unreplayableCodeRelated: number };
  cohort: ReplayCohort;
  decision: ReplayBarDecision;
  routings: number;
  codeRelated: number;
  resolverUnavailable: number;
  familiarityUnmeasured: number;
  /** Snapshots whose stored relevance does not recompute (older formats); kept at their stored outcome on both sides. */
  unreplayable: number;
  anyCodeSignal: { before: Share; after: Share };
  anyCodeSignalCodeRelated: { before: Share; after: Share };
  topCandidateChanges: Share;
  topCandidateChangesCodeRelated: Share;
  noQualified: { before: Share; after: Share };
  noQualifiedCodeRelated: { before: Share; after: Share };
  /** Routings where the no-code-signal control disagrees with the stored ranking. */
  controlDrift: number;
  examples: Array<{ consultId: string; createdAt: string; files: string[]; before: string | null; after: string | null }>;
}

export interface ReplayDeps {
  loadRoutings: (window: { since: string; until: string }) => Promise<PersistedRouting[]>;
  resolveSymbol: SymbolResolver | null;
  measureFamiliarity: (input: { workspaceId: string; owners: string[]; files: string[]; before: string }) =>
    Promise<{ byOwner: Map<string, CodeFamiliarity>; edits: 'measured' | 'unmeasured'; reads: 'measured' | 'unmeasured' }>;
}

export async function replayCodeSignal(opts: { days?: number; until?: Date; buildSha?: string | null }, deps: ReplayDeps): Promise<CodeSignalReplayReport> {
  const until = opts.until ?? new Date();
  const since = new Date(until.getTime() - (opts.days ?? 30) * MS_PER_DAY);
  const window = { since: since.toISOString(), until: until.toISOString() };
  const routings = await deps.loadRoutings(window);
  const resolveSymbol = deps.resolveSymbol ? await prefetchingResolver(routings.map((r) => r.question), deps.resolveSymbol) : null;

  let codeRelated = 0, resolverUnavailable = 0, familiarityUnmeasured = 0, controlDrift = 0, unreplayable = 0;
  let signalBefore = 0, signalAfter = 0, signalBeforeCode = 0, signalAfterCode = 0;
  let changes = 0, noQBefore = 0, noQAfter = 0, noQBeforeCode = 0, noQAfterCode = 0;
  // Paired cohort (replayable AND code-related) and its attempt denominators.
  let paired = 0, pSignalC = 0, pSignalT = 0, pChanges = 0, pNoQC = 0, pNoQT = 0;
  let replayableN = 0, replayableUnavailable = 0, familiarityAttempts = 0, unreplayableCode = 0;
  const examples: CodeSignalReplayReport['examples'] = [];

  for (const r of routings) {
    const subjects = await resolveQuestionCodeSubjects(r.question, { resolveSymbol });
    if (subjects.resolver === 'unavailable') resolverUnavailable++;
    const isCode = hasCodeSubjects(subjects);
    const replayable = isReplayable(r.snapshot);
    if (!replayable) unreplayable++;
    if (replayable) {
      replayableN++;
      if (subjects.resolver === 'unavailable') replayableUnavailable++;
    } else if (isCode) {
      unreplayableCode++;
    }
    let familiarity: Map<string, CodeFamiliarity> | null = null;
    if (replayable && isCode && r.snapshot.candidates.length > 0) {
      familiarityAttempts++;
      const m = await deps.measureFamiliarity({
        workspaceId: r.workspaceId, owners: r.snapshot.candidates.map((c) => c.ownerId), files: subjects.files, before: r.createdAt,
      });
      if (m.edits === 'unmeasured' || m.reads === 'unmeasured') familiarityUnmeasured++;
      familiarity = m.byOwner;
    }
    const control = replayable ? rescoreSnapshot(r.snapshot, null) : storedResult(r.snapshot);
    const treated = familiarity ? rescoreSnapshot(r.snapshot, familiarity) : control;
    if (replayable && control.top !== storedTop(r.snapshot)) controlDrift++;
    if (control.anyAuthorship) signalBefore++;
    if (treated.anyAuthorship) signalAfter++;
    if (control.qualified === 0) noQBefore++;
    if (treated.qualified === 0) noQAfter++;
    const changed = control.top !== treated.top;
    if (changed) changes++;
    if (isCode) {
      codeRelated++;
      if (control.anyAuthorship) signalBeforeCode++;
      if (treated.anyAuthorship) signalAfterCode++;
      if (control.qualified === 0) noQBeforeCode++;
      if (treated.qualified === 0) noQAfterCode++;
      if (changed && examples.length < REPLAY_EXAMPLE_LIMIT) {
        examples.push({ consultId: r.consultId, createdAt: r.createdAt, files: subjects.files, before: control.top, after: treated.top });
      }
      if (replayable) {
        paired++;
        if (control.anyAuthorship) pSignalC++;
        if (treated.anyAuthorship) pSignalT++;
        if (changed) pChanges++;
        if (control.qualified === 0) pNoQC++;
        if (treated.qualified === 0) pNoQT++;
      }
    }
  }

  const n = routings.length;
  const cohort: ReplayCohort = {
    pairedCodeRelated: paired,
    codeSignal: { control: share(pSignalC, paired), treated: share(pSignalT, paired) },
    topCandidateChanges: share(pChanges, paired),
    noQualified: { control: share(pNoQC, paired), treated: share(pNoQT, paired) },
    resolverUnavailable: share(replayableUnavailable, replayableN),
    familiarityUnmeasured: share(familiarityUnmeasured, familiarityAttempts),
  };
  return {
    window,
    selector: REPLAY_SELECTOR,
    buildSha: opts.buildSha ?? null,
    attrition: { routings: n, replayable: replayableN, unreplayable, codeRelated, unreplayableCodeRelated: unreplayableCode },
    cohort,
    decision: evaluateReplayBar({ cohort, controlDrift }),
    routings: n,
    codeRelated,
    resolverUnavailable,
    familiarityUnmeasured,
    unreplayable,
    anyCodeSignal: { before: share(signalBefore, n), after: share(signalAfter, n) },
    anyCodeSignalCodeRelated: { before: share(signalBeforeCode, codeRelated), after: share(signalAfterCode, codeRelated) },
    topCandidateChanges: share(changes, n),
    topCandidateChangesCodeRelated: share(changes, codeRelated),
    noQualified: { before: share(noQBefore, n), after: share(noQAfter, n) },
    noQualifiedCodeRelated: { before: share(noQBeforeCode, codeRelated), after: share(noQAfterCode, codeRelated) },
    controlDrift,
    examples,
  };
}

/** Production loader: every persisted routing in the window that stored a candidate list (empty lists included). */
export function consultStateRoutingLoader(sql: Sql, workspaceId?: string): ReplayDeps['loadRoutings'] {
  return async ({ since, until }) => {
    const rows = await sql`
      SELECT conversation_id, workspace_id, COALESCE(question, routing->>'query', '') AS question,
             created_at, routing
        FROM harness_shared.consult_state
       WHERE created_at > ${since}::timestamptz AND created_at <= ${until}::timestamptz
         AND jsonb_typeof(routing->'candidates') = 'array'
         AND (${workspaceId ?? null}::text IS NULL OR workspace_id = ${workspaceId ?? null}::text)
       ORDER BY created_at` as unknown as Array<{
        conversation_id: string; workspace_id: string; question: string; created_at: Date | string; routing: ReplaySnapshot;
      }>;
    return rows.map((row) => ({
      consultId: row.conversation_id,
      workspaceId: row.workspace_id,
      question: row.question,
      createdAt: new Date(row.created_at).toISOString(),
      snapshot: row.routing,
    }));
  };
}

/** Production familiarity measure for the replay: the live query, bounded as of the routing, with a replay-sized timeout. */
export function asOfFamiliarity(sql: Sql, timeoutMs = REPLAY_FAMILIARITY_TIMEOUT_MS): ReplayDeps['measureFamiliarity'] {
  return (input) => measureCodeFamiliarity(sql, { ...input, readTimeoutMs: timeoutMs, editTimeoutMs: timeoutMs });
}
