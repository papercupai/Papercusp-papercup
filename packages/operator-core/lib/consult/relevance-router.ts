/**
 * relevance-router.ts — the get_feedback consult relevance router (plan
 * get-feedback-relevance-consults-2026-08-16, P-002; decisions D-002/D-003/D-008).
 *
 * D-002: experts are DISCOVERED, not authored. The responder is selected by
 * embedding the question over real cross-agent turn history
 * (harness_shared.session_turns — the episodic verbatim transcript index),
 * BLENDED with verification/completion evidence and authorship of the code in
 * question, then COMPARED on freshness. Similarity alone ≠ authority.
 *
 * ── The two stages (consult-expert-routing-2026-09-22 D-001 / D-007) ───────
 * Recency is a COMPARISON signal only; it may never decide QUALIFICATION.
 *   Stage 1 QUALIFY — `relevance`, the similarity/verification/authorship blend
 *     renormalized to [0,1]. It carries no time term of any kind, so an expert
 *     who qualifies today still qualifies after weeks idle (an owner's vacation
 *     does not revoke expertise). The two floors apply HERE and only here.
 *   Stage 2 COMPARE — `score` = relevance × freshness, where freshness is
 *     measured RELATIVE to the freshest QUALIFIED candidate in this consult,
 *     never against wall-clock now. A uniform time shift across all candidates
 *     therefore cancels and leaves the ordering untouched.
 * Both properties are STRUCTURAL rather than calibrated: `BlendWeights` has no
 * recency member (a recency weight is unspellable), and the freshness baseline
 * is a per-consult relative quantity (an absolute decay is unreachable). A test
 * can pin them; the types are what stop them being reintroduced.
 * D-007 closes the two remaining time leaks: qualification reads the FULL
 * candidate list rather than the score-ordered snapshot slice, and the
 * verification signal counts committed completions over ALL time (a completion
 * is evidence that does not expire) instead of a trailing 90-day window.
 *
 * D-003: the router must be able to fail HONESTLY. Below the floor the answer
 * is a first-class `no_qualified_responder`, not an error — and that verdict
 * must stay COMMON in practice. Two floors enforce it:
 *   - simFloor: a HARD similarity sub-floor. Track record (verification /
 *     authorship) can never promote an owner whose transcript similarity is
 *     below it — otherwise a prolific-but-irrelevant agent outranks honesty,
 *     which is exactly the retired costumed-expert failure.
 *   - relevanceFloor: the floor the stage-1 relevance must clear to qualify.
 *   Calibration of both is an OPEN plan item (D-003); the defaults here are
 *   deliberately precision-biased, every route persists the floors + weights
 *   in its snapshot (D-008) so calibration has an audit trail to work from.
 *
 * D-008: the routing snapshot { query, floor, candidates: [{ ownerId, score,
 * signals, evidence, liveness }] } is persisted into consult_state.routing at
 * route time and never recomputed in place. This module RETURNS that snapshot;
 * the get_feedback tool (P-003) writes it.
 *
 * Honesty on degraded instruments: when no embedder is available the router
 * CANNOT measure similarity. It therefore keeps semantic qualification empty,
 * marks the snapshot `degraded: 'embed-unavailable'`, and uses the existing
 * session_turns.text_tsv lexical contract as a bounded minimum-fill fallback.
 * Lexical candidates are explicitly marked `fallback: 'lexical'` so a caller
 * can request manual review without presenting token overlap as semantic
 * expertise (cannot-measure ≠ measured-nothing).
 *
 * Dependency seams are injected (sql, embedder, liveness, clock) so the core
 * is testable against a fixture Postgres with a deterministic embedder; the
 * P-003 tool wires the real `buildQueryEmbedder` + presence oracle. This
 * module deliberately does NOT import the embedder (its transitive graph
 * reaches memory/configure, which opens PG at import time).
 */
import type { Sql } from 'postgres';
import { randomUUID } from 'node:crypto';
import { D006_TRANSCRIPT_RULE, restrictedOwnerSql, restrictedTranscriptSummary } from '../personal-vault/transcript-exclusion';
import {
  proseProfilePredicateSql,
  type ProseProfileSelection,
} from '../search/prose-vector-dims';
import { selectRanked, type Selected, type SelectionVia } from '@papercusp/ranked-selection';
import { withIterativeScan } from '@papercusp/search';
import { lexicalLeg } from '../search/lexical/rank';
import { withDeadlineFallback } from '../sync-resolver/attention-counts';
import { categoryOf, searchTools } from '../cupboard/tools-search';
import type { ToolDiscoveryEntry } from '../cupboard/tools-discovery';
import type { RerankScoreFn } from '@papercusp/rerank';
import type { NativeConsultConstraints } from './native-consult';

/** Same shape as `@papercusp/search`'s Embedder, declared locally to keep this
 * module's import graph free of the search engine (only the TYPE is shared). */
export type ConsultEmbedder = (text: string) => Promise<number[]>;

/**
 * Stage-1 (QUALIFY) weights. There is deliberately NO recency member: D-001
 * forbids a time term in qualification, and a weight you cannot spell is a
 * weight nobody can reintroduce by accident. Recency lives in stage 2 as a
 * multiplier, governed by `recencyHalfLifeDays`.
 *
 * The weights need not sum to 1 — relevance renormalizes by their total — so a
 * caller may drop one signal's influence without having to rebalance the rest.
 */
export interface BlendWeights {
  similarity: number;
  verification: number;
  authorship: number;
}

/** Deliberately precision-biased defaults (D-003) — see module header. */
export const DEFAULT_SIM_FLOOR = 0.4;
export const DEFAULT_WEIGHTS: BlendWeights = {
  similarity: 0.55,
  verification: 0.15,
  authorship: 0.15,
};
/**
 * The stage-1 RELEVANCE floor (D-001 §1). Derived, not chosen: it is the
 * pre-D-001 blended floor of 0.5 with the fully-fresh recency contribution
 * (0.15) removed and the surviving weight re-based. So it is EXACTLY the bar a
 * fully-fresh expert had to clear before D-001 — now applied regardless of age,
 * which is the entire point. Written as the arithmetic rather than 0.41 so the
 * derivation stays visible if the weights are ever retuned.
 */
export const DEFAULT_RELEVANCE_FLOOR =
  (0.5 - 0.15) / (DEFAULT_WEIGHTS.similarity + DEFAULT_WEIGHTS.verification + DEFAULT_WEIGHTS.authorship);
/**
 * Stage-2 comparison half-life in days (D-001 §2; default from D-006.2). P-005
 * persists this as an owner-editable setting and the consult layer passes it
 * down per route; this constant is only the fallback for a caller with no
 * setting to read.
 */
export const DEFAULT_RECENCY_HALF_LIFE_DAYS = 7;
/**
 * freshness = FRESHNESS_BASE + FRESHNESS_SPAN × 2^(−relativeAgeDays / H).
 * The non-zero base matters: freshness MULTIPLIES relevance, so a zero floor
 * would let age annihilate a qualified expert's score — re-creating through the
 * ordering the disqualification D-001 removed from the floor.
 */
export const FRESHNESS_BASE = 0.2;
export const FRESHNESS_SPAN = 0.8;
/** Verification saturation: c committed completions (all time) → c / (c + K). */
export const VERIFICATION_SATURATION_K = 4;

export interface TurnEvidence {
  session_id: string;
  turn_idx: number;
  ts: string | null;
  sim: number;
  /** Present only on embed-free lexical fallback evidence. This is the turn's
   * lexical score (BM25, or ts_rank_cd when BM25 is unavailable) divided by the
   * best turn's score for the same question, so it lies in (0, 1] whatever the
   * engine; never a cosine similarity. */
  lexicalRank?: number;
}

/** The liveness annotation returned by the shared presence oracle. */
export interface ConsultLiveness {
  sessionState: string | null;
  /** Heartbeat is fresh, but genuine activity is older than the warm-idle band. */
  warmIdle?: boolean;
  /** The owner is under a currently active, verified loop stand-down pause. */
  ownerPaused?: boolean;
}

/**
 * Backward-compatible liveness seam: older route bindings returned only the
 * session-state string, while the consult:get_feedback binding now preserves
 * the oracle's warmIdle metadata too.
 */
export type ConsultLivenessReading = string | null | ConsultLiveness;

export interface RoutingCandidate {
  ownerId: string;
  /** Independent, bounded evidence about an explicitly named technical subject.
   * Absence is the legacy/general-question contract, not a failed measurement. */
  subjectEvidence?: { subject: string; status: 'supported' | 'mismatch' | 'unmeasured'; score: number | null };
  /** Every requested source anchor must independently clear its evidence floor. */
  subjectEvidenceCoverage?: {
    status: 'supported' | 'mismatch' | 'unmeasured';
    required: string[];
    evidence: Array<{ subject: string; status: 'supported' | 'mismatch' | 'unmeasured'; score: number | null }>;
    unresolved: string[];
  };
  /**
   * Stage-1 QUALIFICATION score in [0,1] (D-001 §1) — the similarity /
   * verification / authorship blend renormalized by the weight total. Carries
   * NO time term, and is the only number `relevanceFloor` ever sees. On the
   * lexical fallback path it is 0: nothing semantic was measured there, so no
   * relevance exists to claim (read `fallback:'lexical'`, not this zero).
   */
  relevance: number;
  /**
   * Stage-2 COMPARISON score in [0,1] (D-001 §2) = relevance × freshness. This
   * is the ORDERING key and never a qualification input — comparing it against
   * a floor would put recency straight back into eligibility.
   */
  score: number;
  /**
   * Days between the reference candidate's newest matching turn and this one's
   * (0 = the freshest). Relative, so a uniform shift leaves it unchanged; null
   * when this candidate has no dated turn, or when no candidate has one.
   */
  relativeAgeDays: number | null;
  signals: {
    similarity: number;
    verification: number;
    authorship: number;
    /**
     * The stage-2 multiplier actually applied. Comparison-only — persisted so
     * the snapshot can explain an ordering, never so a floor can read it.
     */
    freshness: number;
  };
  /** The matched turns that ground this candidacy — the why-you-were-chosen
   * evidence delivered on the responder wake (D-008 §5). */
  evidence: TurnEvidence[];
  /** sessionState from the presence oracle when a getLiveness dep was wired;
   * 'unknown' otherwise. The consult layer owns the liveness GATE (D-008 §5) —
   * the router only annotates. */
  liveness: string;
  /** Presence oracle's non-fatal warm-idle signal, when measured. */
  warmIdle?: boolean;
  /** Canonical owner-pause signal from the active loop stand-down reader. */
  ownerPaused?: boolean;
  /** Present only when semantic discovery degraded to session_turns.text_tsv.
   * These candidates can be selected only as labeled minimum-fill reviewers. */
  fallback?: 'lexical';
}

export interface RoutingSnapshot {
  query: string;
  /** This routing execution, separate from consultation delivery. */
  measurement?: ExpertiseRoutingReceipt;
  /** Set by consultation creation; absent on legacy rows, never inferred. */
  deliveryIntent?: 'dispatch' | 'retrieval-only';
  /** Complete expanded source refs persisted before the first dispatch. */
  subjectRefs?: string[];
  /** Public-manual document refs that could not be fully expanded. */
  unresolvedSubjectRefs?: string[];
  /**
   * The stage-1 floor actually applied, against `candidate.relevance` (D-001).
   * Deliberately NOT named `floor`: the retired field of that name gated the
   * recency-bearing blended score, so a reader that finds `relevanceFloor` is
   * looking at a two-stage snapshot and one that finds `floor` is looking at a
   * pre-D-001 record. `snapshotCandidateQualifies` is where that split is read.
   */
  relevanceFloor: number;
  simFloor: number;
  weights: BlendWeights;
  /** The stage-2 half-life this route compared with — without it the recorded
   * ordering cannot be re-derived from the recorded signals (D-008). */
  recencyHalfLifeDays: number;
  candidates: RoutingCandidate[];
  computedAt: string;
  /**
   * D-006 / P-013: transcript turns dropped because their owner has held a
   * personal-data disclosure (personal-vault/transcript-exclusion.ts). The
   * answer session forks a routed expert's whole transcript, so such an expert
   * is never routable; counted here rather than silently dropped.
   */
  withheld?: { restricted_turns: number; restricted_owners: number; rule: string };
  /** Set when the instrument itself was degraded — 'embed-unavailable' means
   * similarity could not be measured at all (≠ measured and found nothing). */
  degraded?: 'embed-unavailable' | 'evidence-unavailable';
  subjectValidation?: {
    subject?: string;
    subjects: string[];
    threshold: number;
    evaluated: number;
    unmeasured: number;
    limit: number;
    unresolved: string[];
  };
  /** The bounded retrieval leg used while the semantic instrument was down. */
  fallback?: 'lexical';
  /** Min/max responder-selection provenance (consult-min-max-and-rubric-vetting
   * D-001/D-002/D-003) — stamped by the CONSULT layer at selection time and
   * persisted with the snapshot, so the D-003 honesty feed can always
   * distinguish a floor-qualified responder from a best-available minimum
   * fill. Absent on pre-min/max rows and on a route that did not select at all
   * (an empty grader menu). Acceptance grading STAMPS it — since
   * unified-responder-selection-critique-and-grading-2026-08-30 D-001 the gate
   * selects a menu through the same library as the consult, so "surfaces that
   * route without selecting" is no longer a standing category. */
  selection?: SnapshotSelection;
  /** The named selection policy the consult was opened under (`selection-policies.ts`,
   * e.g. 'rubric-vetting'). Persisted so the generic expiry sweep can tell a review
   * consult from an ordinary one: a silent rubric-vetting consult at half its TTL becomes
   * a pullable review work item instead of cascading
   * (review-system-rework-reduction-2026-09-23 P-014). Absent on rows opened before
   * this field existed and on consults opened without a policy. */
  policy?: string;
  /** A per-review launch constraint copied into every cascade step. */
  reviewerModel?: import('./get-feedback-core').ConsultReviewerModel;
  nativeConsult?: import('./native-consult').NativeConsultConstraints;
  nativeConsultSources?: import('./native-consult').NativeConsultSourceObservation[];
  nativeConsultPool?: RoutingCandidate[];
  /** Candidates removed from this pool because the dispatch walk could not
   * open their transcript (no native file, no archive) — WI-6554700010009982.
   * Present only when at least one was removed, so the disclosure is legible. */
  undispatchableSources?: import('./source-dispatchability').SourceDispatchabilityObservation[];
  /** Consumer copy persists so generic decline/expiry/revival keeps its subject. */
  cascade?:
    | import('./grading-cascade').SourceAuditCascadeMeta
    | import('./grading-cascade').GradingCascadeMeta
    | import('./decision-review').DecisionReviewCascadeMeta;
}

/** How a responder entered the selected set (D-002): 'floor' = cleared both
 * routing floors (the pre-min/max notion of qualified); 'minimum' = did NOT
 * clear the floors but was selected as best-available to honor the caller's
 * minResponders (D-001 §1 / D-003 — labeled, never silent).
 *
 * Re-exported from @papercusp/ranked-selection rather than re-declared: two
 * structurally-identical unions would typecheck against each other today and
 * diverge silently the first time one gains a third member. */
export type { SelectionVia };

export type SelectedResponder = Selected<RoutingCandidate>;

export interface SnapshotSelection {
  min: number;
  max: number;
  selected: Array<{
    ownerId: string;
    via: SelectionVia;
    /** Stage-2 comparison score (relevance × freshness) — the ordering number. */
    score: number;
    /** Stage-1 qualification score. `via` is DERIVED from this, so recording
     * only the comparison score would leave the label unauditable. */
    relevance: number;
    similarity: number;
    liveness: string;
    /** Exact session-turn refs that justified selecting this expert. Kept in
     * the routing snapshot so cascade dispatch can port the same evidence. */
    evidence?: TurnEvidence[];
    fallback?: 'lexical';
    /** WI-39852 revival leg: this selectee's session was DEAD at route time and
     * a carry-respawn was launched to make them reachable (labeled, never
     * silent — the D-002 rule applied to liveness provenance). */
    revived?: boolean;
    /** EI-21809454835305750: a revival spawn is in flight. This provisional
     * marker reserves the one-revival budget before the revived first turn can
     * race the reviver's return. It is replaced by `revived:true` on success
     * and removed on a failed spawn. */
    revivalPending?: boolean;
    /** WI-39861 min-ANSWERS refill: this selectee entered the menu on the ONE
     * post-exhaustion refill round, not at original selection time. */
    refill?: boolean;
  }>;
  /** WI-39861: stamped when the one bounded refill round ran (cascade-core
   * maybeRefillMenu) — its presence is the one-round guard. */
  refill?: { at: string; added: string[]; reason: string };
}

export interface ResponderSelectionParams {
  /** Candidates clearing BOTH floors, best first (RouteResult.qualified). */
  qualified: RoutingCandidate[];
  /** ALL ranked candidates, best first (RoutingSnapshot.candidates) — the
   * minimum-fill pool. A superset of `qualified`. */
  allCandidates: RoutingCandidate[];
  /** Select at least this many even when the floors filter everyone out
   * (D-001 §1; global default 1 per D-003). Clamped to [0, max]. */
  min: number;
  /** Hard cap on the selected set (the cascade menu). */
  max: number;
  /** Caller-owned selectability gate (the consult layer passes its OWNER-PAUSE
   * gate — never a liveness one: D-002 dispatch forks or converts a transcript,
   * so a dead session is selectable). A candidate failing it is skipped for
   * BOTH floor picks and fills — a minimum that can only be filled by the
   * genuinely unusable stays unfilled, and the caller says so honestly. */
  isSelectable?: (c: RoutingCandidate) => boolean;
}

/**
 * D-001 §1 selection: every selectable floor-qualified candidate best-first up
 * to `max`; when fewer than `min` result, fill with the best-scoring remaining
 * selectable candidates (labeled via:'minimum'). Deterministic, pure, shared
 * by every selecting surface (get_feedback, plan-start) so the semantics
 * cannot drift between call sites. Delivery stays a CASCADE regardless — the
 * result is an ordered menu, never a parallel-wake set.
 */
export function selectResponders(params: ResponderSelectionParams): SelectedResponder[] {
  // Delegates to @papercusp/ranked-selection so this algorithm has ONE
  // implementation (unified-responder-selection-critique-and-grading-2026-08-30
  // D-001). The signature is preserved deliberately: every existing caller
  // (get_feedback, plan-start) is unchanged by the move, and acceptance grading
  // — the one selecting flow that never used this and hard-coded a single pick
  // — joins them by consuming the same library.
  return selectRanked<RoutingCandidate>({
    qualified: params.qualified,
    allCandidates: params.allCandidates,
    bounds: { min: params.min, max: params.max },
    identity: (c) => c.ownerId,
    ...(params.isSelectable ? { isSelectable: params.isSelectable } : {}),
  });
}

/** The SnapshotSelection record for a selected set — the persisted provenance
 * half of selectResponders (D-002: labeled, never silent). */
export function selectionSnapshot(min: number, max: number, selected: SelectedResponder[]): SnapshotSelection {
  return {
    min,
    max,
    selected: selected.map((s) => ({
      ownerId: s.candidate.ownerId,
      via: s.via,
      score: s.candidate.score,
      relevance: s.candidate.relevance,
      similarity: s.candidate.signals.similarity,
      liveness: s.candidate.liveness,
      ...(s.candidate.evidence.length > 0 ? { evidence: s.candidate.evidence } : {}),
      ...(s.candidate.fallback ? { fallback: s.candidate.fallback } : {}),
    })),
  };
}

export interface RouteResult {
  /**
   * `no_qualified_responder` is a MEASURED absence — similarity was computed and
   * nobody cleared the floor. `relevance_unmeasured` is the opposite epistemic
   * state: the embedder was unavailable, so relevance was never measured at all
   * and this route has no claim to make about the peer population. Keeping them
   * distinct is what lets a caller tell "retrying is pointless" from "retrying
   * is the whole fix" (EI-21485716602970457).
   */
  verdict: 'routed' | 'no_qualified_responder' | 'relevance_unmeasured';
  /** Candidates clearing BOTH floors, best first (≤ maxQualified). */
  qualified: RoutingCandidate[];
  snapshot: RoutingSnapshot;
  /** The question embedding this route was computed from (null on
   * embed-unavailable degrade). P-006: the consult layer stores it on the
   * consult_state row (retrieval-cache forward-fill) and runs the
   * archive-first lookup with it — computed ONCE here, never re-embedded. */
  queryVec: number[] | null;
  /** Exact profile that produced queryVec; null iff the semantic instrument
   * was unavailable or its identity could not be established. */
  queryProfile: ProseProfileSelection | null;
  /** Human-readable mode projection for queryVec. Exact comparability comes
   * from queryProfile; this remains useful for operators and legacy readers. */
  queryMode: string | null;
}

export interface ConsultRouteParams {
  telemetry?: { caller: string; policy: string; buildSha: string | null; correlationId?: string };
  workspaceId: string;
  /** The asking agent — excluded from candidacy ("no one knows more than you
   * do" must be reachable, D-003). */
  requesterId: string;
  question: string;
  /** Optional exact durable subject whose transcript mentions may justify this route. */
  subjectRef?: string | null;
  /** Every source ref must have supported transcript evidence for floor qualification. */
  subjectRefs?: string[];
  /** Refs to public-manual documents whose source anchors could not be read completely. */
  unresolvedSubjectRefs?: string[];
  /** Internal native acceptance population, applied before retrieval bounds.
   * Registration is a hint; dispatch still resolves the exact live source. */
  nativeConsult?: NativeConsultConstraints;
  /** Additional owners excluded from candidacy — D-007(7) manual cascade: a
   * decliner is excluded on the requester's re-call, never auto-cascaded. */
  excludeOwners?: string[];
  /** Stage-1 floor on `relevance` (default DEFAULT_RELEVANCE_FLOOR). */
  relevanceFloor?: number;
  simFloor?: number;
  weights?: Partial<BlendWeights>;
  /** Stage-2 half-life in days (D-001 §2). P-005's persisted setting arrives
   * here; omitted falls back to DEFAULT_RECENCY_HALF_LIFE_DAYS. */
  recencyHalfLifeDays?: number;
  /**
   * Max candidates recorded in the SNAPSHOT (default 8). D-007(a): this bounds
   * the persisted audit record only — never who is eligible to qualify. It used
   * to cut the score-ordered list BEFORE the floor ran, which silently dropped
   * aged-but-relevant experts before they were ever measured against it.
   */
  maxCandidates?: number;
  /** Max qualified responders returned (default 3; v1 delivery uses the top one). */
  maxQualified?: number;
  /** Turn rows fetched from the index (default 200). */
  turnLimit?: number;
  /** Evidence turns kept per candidate (default 3). */
  evidencePerOwner?: number;
}

export interface ConsultRouteDeps {
  /** Same local crossencoder as prose search; no hosted credential required. */
  scoreSubjectEvidence?: (subject: string, texts: string[], deadline: number) => Promise<Array<number | null>>;
  recordTelemetry?: (receipt: ExpertiseRoutingReceipt) => void | Promise<void>;
  monotonicNow?: () => number;
  measure?: <T>(stage: ExpertiseRoutingStage, work: () => Promise<T>) => Promise<T>;
  getSql: () => Sql;
  /** null = no embedder available this host right now (honest degrade). */
  embed: ConsultEmbedder | null;
  embeddingProfile: ProseProfileSelection | null;
  embeddingMode: string | null;
  /** Presence oracle: ownerId → sessionState. Optional; default 'unknown'. */
  /** `null` for an owner the liveness oracle could not measure
   *  (EI-18771777750306094 — the oracle reports an unknown IN BAND rather than
   *  omitting the owner). Both readings land on the same `?? 'unknown'` at the
   *  two use sites below, so this widening is type-level only. */
  getLiveness?: (ownerIds: string[]) => Promise<Record<string, ConsultLivenessReading>>;
  now?: () => Date;
}

/** Infer source paths from filename shape or explicit path notation. An
 * unmarked prose pair such as before/after cannot identify repository code.
 * Extensionless paths remain usable when quoted, rooted or directory-marked.
 * Capped so the SQL stays bounded. */
export function extractPathTokens(question: string, cap = 4): string[] {
  const seen = new Set<string>();
  for (const match of question.matchAll(/(?:\.{1,2}\/|\/)?(?:[\w@.-]+\/)+[\w.-]+\/?/g)) {
    const m = match[0];
    // Trim trailing punctuation a sentence contributes ("...in foo/bar.ts.")
    const t = m.replace(/[.,;:!?)]+$/, '');
    const quoted = question[match.index - 1] === '`' && question[match.index + m.length] === '`';
    const marked = quoted || t.startsWith('/') || /^\.{1,2}\//.test(t) || t.endsWith('/');
    const filename = /(?:^|\/)[^/]*\.[a-z0-9_-]+$/i.test(t);
    if (t.length >= 3 && (marked || filename)) seen.add(t);
    if (seen.size >= cap) break;
  }
  return [...seen];
}

export const SUBJECT_EVIDENCE_MIN_SCORE = 0.5;
export const SUBJECT_EVIDENCE_OWNER_LIMIT = 8;
export const SUBJECT_EVIDENCE_TEXT_LIMIT = 4_000;
export const SUBJECT_EVIDENCE_TIMEOUT_MS = 4_000;

/** Narrow the corpus before bounded retrieval/validation can spend its budget
 * on incompatible sources. This does not assert liveness or boundary safety:
 * the exact native resolver and pre-dispatch source observation remain required.
 * Ended history can survive a registry reanchor; live evidence must name the
 * current registered native incarnation so old turns cannot borrow a live owner. */
function nativeSourcePopulationSql(sql: Sql, params: ConsultRouteParams) {
  const constraint = params.nativeConsult;
  if (!constraint) return sql`TRUE`;
  const state = constraint.sourceState === 'live'
    ? sql`a.ended_at IS NULL AND
        CASE WHEN a.agent = 'omp' THEN COALESCE(a.omp_thread_id, a.session_id)
             ELSE a.session_id END = session_turns.session_id`
    : sql`a.ended_at IS NOT NULL`;
  const claimed = constraint.requireSourcePlanClaims ? sql`EXISTS (
    SELECT 1 FROM harness_shared.plan_item_claims c
     WHERE c.workspace_id = a.workspace_id AND c.owner = a.coord_owner_id
       AND c.expires_ts > clock_timestamp()
  )` : sql`TRUE`;
  return sql`session_turns.source_kind = ${constraint.sourceBackend} AND EXISTS (
    SELECT 1 FROM harness_shared.adv_sessions a
     WHERE a.workspace_id = ${params.workspaceId}
       AND a.coord_owner_id = session_turns.owner
       AND a.agent = ${constraint.sourceBackend}
       AND a.role IS NULL
       AND ${state}
       AND ${claimed}
  )`;
}

/** Name the problem's primary tool/path, independently of generic decision words.
 * A crossencoder can recognise a paraphrase without an exact identifier mention. */
export function expertiseSubject(question: string): string | null {
  // Do not treat key:boolean/null options such as `acknowledgeExisting:true`
  // as tool names when scanning the full question for a primary action.
  const tool = question.match(/\b[a-z][a-z0-9_-]*:(?!true\b|false\b|null\b|undefined\b)[a-z][a-z0-9_-]*\b/i)?.[0];
  return tool ?? extractPathTokens(question, 1)[0] ?? null;
}

/** Compare the registered primary action, excluding operational notes that can
 * make an unrelated system look like expertise. Names and dotted versions stay
 * intact; a sentence boundary needs punctuation followed by a new capitalised
 * sentence. A missing contract is unknown, never a bare-name expertise proof. */
function subjectEvidenceAction(toolDescription?: string | null): string | null {
  const action = toolDescription?.trim().split(/(?<=[.!?])\s+(?=[A-Z])/u, 1)[0];
  return action ? action.slice(0, 1_500) : null;
}

const TOOL_SUBJECT_PATTERN = /^[a-z][a-z0-9_-]*:[a-z][a-z0-9_-]*$/i;

export function subjectEvidenceQuery(subject: string, toolDescription?: string | null): string | null {
  if (!TOOL_SUBJECT_PATTERN.test(subject)) {
    // Compare the primary question with competing primary actions, rather than
    // letting secondary delivery/recovery instructions qualify an unrelated
    // passage. Keep all context preceding the question; retrieval and responder
    // briefs continue to receive the full request.
    const end = subject.indexOf('?');
    return end < 0 ? subject : subject.slice(0, end + 1);
  }
  const action = subjectEvidenceAction(toolDescription);
  return action ? `${subject}\n${action}` : null;
}

/** An explicit contextual adjunct is not the issue the question asks about.
 * Keep the full question, but measure its interrogative clause independently:
 * matching only the context cannot establish evidence for that issue. Unknown
 * syntax stays intact; this is not a domain-keyword or lexical-overlap gate. */
function subjectEvidenceTargets(query: string): string[] {
  const issue = query.match(/^(?:for|in|with|regarding|about|given)\b[\s\S]*?,\s*((?:what|which|who|whose|where|when|why|how|can|could|should|does|do|is|are|will|would)\b[\s\S]*)$/i)?.[1];
  return issue ? [query, issue] : [query];
}

export const SUBJECT_EVIDENCE_CONTRAST_LIMIT = 3;
export interface SubjectContract { name: string; description: string }

/** Reuse tool discovery to nominate contrasting systems, never to establish
 * expertise. Nominate the same primary action that the crossencoder scores:
 * operational notes otherwise crowd real competing systems out of the cap. */
export function subjectContrasts(subject: string, text: string, contracts: readonly SubjectContract[]): SubjectContract[] {
  const entries: ToolDiscoveryEntry[] = contracts.filter(c => c.description.trim() && categoryOf(c.name) !== categoryOf(subject))
    .map(c => ({ tool: c.name, category: categoryOf(c.name), description: subjectEvidenceAction(c.description)!,
      status: 'available', provider: { kind: 'builtin', name: c.name } }));
  return searchTools(entries, text, { limit: SUBJECT_EVIDENCE_CONTRAST_LIMIT })
    .map(c => ({ name: c.tool, description: c.description! }));
}

/** A relevance score is not a probability of expertise. Require the named
 * contract to beat the strongest competing system as well as the original
 * evidence floor. Equal contracts leave attribution unmeasured. The midpoint
 * preserves the preregistered 0.5 decision boundary; this changes evidence,
 * never transcript similarity floors. */
export function contrastedSubjectScore(target: number | null, contrasts: readonly (number | null)[]): number | null {
  if (target === null || !Number.isFinite(target) || target < 0 || target > 1 || !contrasts.length ||
    contrasts.some(s => s === null || !Number.isFinite(s) || s < 0 || s > 1)) return null;
  const strongest = Math.max(...contrasts as number[]);
  if (target === strongest) return null;
  return Math.min(target, 0.5 + (target - strongest) / 2);
}

let subjectScorer: Promise<RerankScoreFn> | null = null;
export async function scoreSubjectEvidence(subject: string, texts: string[], deadline: number,
  deps: { scorer?: RerankScoreFn; contracts?: readonly SubjectContract[] } = {}): Promise<Array<number | null>> {
  const { listAllProjectedTools } = await import('@papercusp/tooldef');
  const contracts = deps.contracts ?? listAllProjectedTools().flatMap(t => t.expose.mcp
    ? [{ name: t.expose.mcp.name, description: t.description }] : []);
  const query = subjectEvidenceQuery(subject, contracts.find(c => c.name === subject)?.description);
  if (!query) return texts.map(() => null);
  if (!deps.scorer && !subjectScorer) {
    subjectScorer = import('../memory/embed-sidecar-wiring').then(async ({ buildSidecarAwareReranker }) => {
      return buildSidecarAwareReranker();
    }).catch(error => { subjectScorer = null; throw error; });
  }
  const scorer = deps.scorer ?? await subjectScorer!;
  // Explicit source paths identify code directly. A natural question has no
  // registered target contract, but still needs the same competing-action
  // qualification: absolute similarity overcredits generic procedural overlap.
  if (!TOOL_SUBJECT_PATTERN.test(subject) && extractPathTokens(subject).includes(subject)) {
    return scorer(query, texts, { deadline });
  }
  const targets = TOOL_SUBJECT_PATTERN.test(subject) ? [query] : subjectEvidenceTargets(query);
  // At most 24 passages × (2 targets + 3 contrasts), all on the same 4s deadline.
  // Reverse retrieval asks which contract explains THIS passage, avoiding the
  // procedural vocabulary that made broad tool descriptions and natural
  // questions false friends. For a natural question the full query is retained.
  return Promise.all(texts.map(async text => {
    const contrasts = subjectContrasts(subject, text, contracts);
    if (!contrasts.length || Date.now() >= deadline) return null;
    const scores = await scorer(text, [...targets, ...contrasts.map(c => subjectEvidenceQuery(c.name, c.description)!)], { deadline })
      .catch(() => null);
    if (scores === null) return null;
    if (scores.length !== contrasts.length + targets.length) return null;
    const alternatives = scores.slice(targets.length);
    const qualified = scores.slice(0, targets.length).map(target => contrastedSubjectScore(target, alternatives));
    return qualified.some(score => score === null) ? null : Math.min(...qualified as number[]);
  }));
}

/** Build a case-insensitive whole-reference matcher for transcript evidence.
 * Slug punctuation stays inside the token, so a suffixed slug is not exact. */
function exactSubjectMentionPattern(subjectRef: string): string {
  const escaped = subjectRef.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
  return '(^|[^[:alnum:]_.-])' + escaped + '($|[^[:alnum:]_.-])';
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Each lexical-fallback row's score divided by the best row's score for the same question,
 * so `lexicalRank` lies in (0, 1] under either engine. A BM25 score is unbounded: clamped
 * as-is it would read 1 for nearly every owner and leave the owner order to the id
 * tie-break. Dividing by the best score keeps the order and is engine-independent.
 */
export function relativeLexicalRanks<T extends { lexicalRank: number | string }>(
  rows: readonly T[],
): Array<T & { lexicalRank: number }> {
  const scores = rows.map((r) => Number(r.lexicalRank));
  const top = Math.max(0, ...scores.filter(Number.isFinite));
  return rows.map((r, i) => {
    const score = scores[i]!;
    return { ...r, lexicalRank: top > 0 && Number.isFinite(score) ? clamp01(score / top) : 0 };
  });
}

const MS_PER_DAY = 86_400_000;

/**
 * Stage 1 (D-001 §1): the recency-free qualification score, renormalized by the
 * weight total so the floor keeps its calibrated meaning whatever the weights
 * are. Pure and exported because the cascade re-derives it from a PERSISTED
 * snapshot — one implementation, or the two drift and a refill gets labeled
 * `floor` when the route itself would have said `minimum`.
 */
export function relevanceOf(
  signals: { similarity: number; verification: number; authorship: number },
  weights: BlendWeights,
): number {
  const total = weights.similarity + weights.verification + weights.authorship;
  if (!(total > 0)) return 0;
  return clamp01(
    (weights.similarity * signals.similarity +
      weights.verification * signals.verification +
      weights.authorship * signals.authorship) /
      total,
  );
}

/**
 * Stage 2 (D-001 §2): freshness measured against `referenceMs` — the newest
 * matching turn of the freshest QUALIFIED candidate in this consult — never
 * against wall-clock now. That is what makes a uniform time shift cancel.
 */
export function freshnessOf(
  newestMs: number | null,
  referenceMs: number | null,
  halfLifeDays: number,
): { freshness: number; relativeAgeDays: number | null } {
  // Nobody in this consult has a dated turn: there is no age information, so
  // differentiating on it would be inventing a signal. Everyone is equally fresh.
  if (referenceMs === null) return { freshness: 1, relativeAgeDays: null };
  // This candidate alone is undated. It cannot be shown to be fresh, so it gets
  // the base rather than a free pass — but the base, not 0 (see FRESHNESS_BASE).
  if (newestMs === null) return { freshness: FRESHNESS_BASE, relativeAgeDays: null };
  // Clamped at 0: an UNQUALIFIED candidate may be fresher than the qualified
  // reference, and "fresher than fully fresh" is not a thing.
  const relativeAgeDays = Math.max(0, (referenceMs - newestMs) / MS_PER_DAY);
  // The H→0 limit, written out rather than left to produce Infinity/NaN: decay
  // becomes a step from fully-fresh to the base.
  if (!(halfLifeDays > 0)) {
    return { freshness: relativeAgeDays > 0 ? FRESHNESS_BASE : 1, relativeAgeDays };
  }
  return {
    freshness: clamp01(FRESHNESS_BASE + FRESHNESS_SPAN * Math.pow(2, -relativeAgeDays / halfLifeDays)),
    relativeAgeDays,
  };
}

/** Newest of a timestamp set, or null when none is dated. Spelled out rather
 * than `Math.max(...)` because that returns -Infinity on an empty list, which
 * would read as a real (impossibly old) reference point. */
function maxTimestamp(values: Array<number | null>): number | null {
  let best: number | null = null;
  for (const v of values) if (v !== null && (best === null || v > best)) best = v;
  return best;
}

export interface RoutingFloors {
  /** Applied to stage-1 `relevance` — never to the comparison `score`. */
  relevanceFloor: number;
  simFloor: number;
}

/**
 * THE qualification predicate. Both floors read stage-1 numbers only, so no
 * caller can qualify on the recency-bearing comparison score by mistake.
 */
export function meetsRoutingFloors(
  candidate: { relevance: number; signals: { similarity: number }; subjectEvidence?: RoutingCandidate['subjectEvidence']; subjectEvidenceCoverage?: RoutingCandidate['subjectEvidenceCoverage'] },
  floors: RoutingFloors,
): boolean {
  return (!candidate.subjectEvidence || candidate.subjectEvidence.status === 'supported') &&
    (!candidate.subjectEvidenceCoverage || candidate.subjectEvidenceCoverage.status === 'supported') &&
    candidate.signals.similarity >= floors.simFloor && candidate.relevance >= floors.relevanceFloor;
}

/**
 * The same verdict, re-derived from a PERSISTED routing snapshot whose shape is
 * only known at runtime (the cascade's refill labeling reads consult_state.routing
 * back as loose JSON).
 *
 * Two snapshot generations exist in that column and they are not interchangeable:
 * a two-stage record carries `relevanceFloor` + per-candidate `relevance`, while
 * a pre-D-001 record carries `floor` + a blended `score` that INCLUDED recency.
 * Applying either rule to the other's record mislabels a responder's provenance,
 * so the generation is read from the snapshot rather than assumed. This is
 * reading a historical record on its own terms, not a compatibility shim on new
 * code: nothing writes the legacy shape any more, and the branch dies with the
 * last unexpired pre-D-001 consult.
 */
export function snapshotCandidateQualifies(
  snapshot: { relevanceFloor?: unknown; floor?: unknown; simFloor?: unknown } | null | undefined,
  candidate: { relevance?: unknown; score?: unknown; signals?: { similarity?: unknown } | null; subjectEvidence?: { status?: unknown } | null; subjectEvidenceCoverage?: { status?: unknown } | null } | null | undefined,
): boolean {
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  if (candidate?.subjectEvidence && candidate.subjectEvidence.status !== 'supported') return false;
  if (candidate?.subjectEvidenceCoverage && candidate.subjectEvidenceCoverage.status !== 'supported') return false;
  const simFloor = num(snapshot?.simFloor);
  const similarity = num(candidate?.signals?.similarity) ?? 0;
  // An unreadable floor must never admit anyone: a missing floor is an unknown
  // bar, and guessing one relabels a minimum fill as a qualified expert.
  if (simFloor === null || similarity < simFloor) return false;
  const relevanceFloor = num(snapshot?.relevanceFloor);
  if (relevanceFloor !== null) return (num(candidate?.relevance) ?? 0) >= relevanceFloor;
  const legacyFloor = num(snapshot?.floor);
  if (legacyFloor !== null) return (num(candidate?.score) ?? 0) >= legacyFloor;
  return false;
}

/**
 * The number a persisted record's floor ACTUALLY compared against, for display:
 * `relevance` on a two-stage record, the blended `score` on a pre-D-001 one.
 *
 * Needed because the cascade's wake copy renders entries read straight out of
 * consult_state.routing, where the TypeScript type is a claim about what we
 * WRITE, not a guarantee about what is already stored — every row written
 * before D-001 has no `relevance` at all, and `entry.relevance.toFixed(2)` on
 * one of those throws mid-wake. Unlike `snapshotCandidateQualifies`, which must
 * know the record's generation to pick the right FLOOR, this only needs the
 * comparable number, so it can fall through by presence.
 */
export function qualifyingScoreOf(entry: { relevance?: unknown; score?: unknown } | null | undefined): number {
  const r = entry?.relevance;
  if (typeof r === 'number' && Number.isFinite(r)) return r;
  const s = entry?.score;
  return typeof s === 'number' && Number.isFinite(s) ? s : 0;
}

/**
 * The persisted snapshot is bounded by `maxCandidates`, but it is also the
 * record that has to EXPLAIN the route's own verdict (D-008) and the pool the
 * cascade refills from. So every responder actually returned as qualified is
 * kept even when the score-ordered cut would have dropped it — D-007(a) let
 * qualification see the full list, and a snapshot that omitted the result would
 * put back exactly the invisibility that change removed. Ranked order is
 * preserved.
 */
function boundedSnapshot(
  ranked: RoutingCandidate[],
  mustKeep: RoutingCandidate[],
  maxCandidates: number,
): RoutingCandidate[] {
  const head = ranked.slice(0, maxCandidates);
  const missing = new Set(mustKeep.map((c) => c.ownerId));
  for (const c of head) missing.delete(c.ownerId);
  if (missing.size === 0) return head;
  return ranked.filter((c, i) => i < maxCandidates || missing.has(c.ownerId));
}

function annotateLiveness(
  reading: ConsultLivenessReading | undefined,
): Pick<RoutingCandidate, 'liveness' | 'warmIdle' | 'ownerPaused'> {
  if (reading !== null && typeof reading === 'object') {
    return {
      liveness: reading.sessionState ?? 'unknown',
      ...(typeof reading.warmIdle === 'boolean' ? { warmIdle: reading.warmIdle } : {}),
      ...(typeof reading.ownerPaused === 'boolean' ? { ownerPaused: reading.ownerPaused } : {}),
    };
  }
  return { liveness: reading ?? 'unknown' };
}

/**
 * Route a consult question to qualified responders. One embedding + at most
 * three bounded SQL reads; returns the D-008 snapshot for the caller to
 * persist into consult_state.routing.
 */
/**
 * D-006 / P-013: an expert who has ever held a personal-data disclosure is not
 * a routable transcript source (the answer session forks its WHOLE transcript).
 * Both routing queries exclude such experts in SQL (`restrictedOwnerSql`), so
 * they never take a candidate slot. The count reported for them covers every
 * such expert and does not depend on the question — a per-question count would
 * confirm a guess about a restricted transcript's content. Throws
 * `disclosure_ledger_unavailable` when the ledger cannot be read: a consult is
 * refused, never routed unfiltered.
 */
async function restrictedExpertsWithheld(
  sql: unknown,
  params: Pick<ConsultRouteParams, 'workspaceId' | 'requesterId' | 'excludeOwners'>,
): Promise<RoutingSnapshot['withheld']> {
  const summary = await restrictedTranscriptSummary(sql as Sql, {
    workspaceId: params.workspaceId,
    excludeOwners: [params.requesterId, ...(params.excludeOwners ?? [])],
  });
  if (summary.owners === 0) return undefined;
  return { restricted_turns: summary.turns, restricted_owners: summary.owners, rule: D006_TRANSCRIPT_RULE };
}

export type ExpertiseRoutingStage = 'disclosure' | 'embedding' | 'transcripts' | 'verification' | 'authorship' | 'liveness' | 'ranking' | 'evidence';
export interface ExpertiseRoutingReceipt {
  schemaVersion: 1;
  correlationId: string;
  workspaceId: string;
  requesterId: string;
  caller: string;
  policy: string;
  buildSha: string | null;
  startedAt: string;
  durationMs: number;
  outcome: 'returned' | 'degraded' | 'threw';
  verdict: RouteResult['verdict'] | null;
  errorCode: string | null;
  /** Missing means not exercised, never a zero-duration observation. */
  stages: Partial<Record<ExpertiseRoutingStage, {
    durationMs: number;
    outcome: 'returned' | 'threw';
    /** Safe structured cause for failed stages, including recovered failures.
     * Absent on legacy receipts and successful stages; never raw error text. */
    errorCode?: string;
  }>>;
}

function routingErrorCode(error: unknown): string {
  // Sidecar wrappers retain the provider cause. Bound traversal for malformed
  // or cyclic chains, and do not let diagnostic getters replace route behavior.
  try {
    for (let depth = 0; depth < 4 && error && typeof error === 'object'; depth++) {
      const cause = error as { code?: unknown; name?: unknown; cause?: unknown };
      if (typeof cause.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(cause.code)) return cause.code;
      if (cause.name === 'AbortError') return 'ABORT_ERR';
      if (cause.name === 'TimeoutError') return 'ETIMEDOUT';
      error = cause.cause;
    }
  } catch { /* diagnostics must not replace the original result or exception */ }
  return 'routing_exception';
}

/** Measure the shared seam, including exceptions before a consult row exists. */
export async function routeConsult(params: ConsultRouteParams, deps: ConsultRouteDeps): Promise<RouteResult> {
  const clock = deps.monotonicNow ?? (() => performance.now());
  const started = clock();
  const receipt: ExpertiseRoutingReceipt = {
    schemaVersion: 1, correlationId: params.telemetry?.correlationId ?? randomUUID(),
    workspaceId: params.workspaceId, requesterId: params.requesterId,
    caller: params.telemetry?.caller ?? 'unattributed', policy: params.telemetry?.policy ?? 'unknown',
    buildSha: params.telemetry?.buildSha ?? null,
    startedAt: (deps.now?.() ?? new Date()).toISOString(), durationMs: 0,
    outcome: 'threw', verdict: null, errorCode: null, stages: {},
  };
  const elapsed = (at: number) => Math.max(0, Math.round((clock() - at) * 10) / 10);
  const measure: NonNullable<ConsultRouteDeps['measure']> = async (stage, work) => {
    const at = clock();
    try {
      const value = await work();
      receipt.stages[stage] = { durationMs: elapsed(at), outcome: 'returned' };
      return value;
    } catch (error) {
      receipt.stages[stage] = { durationMs: elapsed(at), outcome: 'threw', errorCode: routingErrorCode(error) };
      throw error;
    }
  };
  try {
    const result = await routeConsultCore(params, { ...deps, measure });
    receipt.verdict = result.verdict;
    receipt.outcome = result.snapshot.degraded || Object.values(receipt.stages).some(s => s.outcome === 'threw')
      ? 'degraded' : 'returned';
    receipt.durationMs = elapsed(started);
    if (params.telemetry || deps.recordTelemetry) result.snapshot.measurement = structuredClone(receipt);
    return result;
  } catch (error) {
    // Raw error text can contain questions, SQL values or credentials.
    receipt.errorCode = routingErrorCode(error);
    throw error;
  } finally {
    if (receipt.outcome === 'threw') receipt.durationMs = elapsed(started);
    if (deps.recordTelemetry) {
      try {
        // Diagnostics never change routing or extend its acknowledgement.
        void Promise.resolve(deps.recordTelemetry(structuredClone(receipt))).catch(() => {});
      } catch { /* synchronous recorder failures are diagnostic, too */ }
    }
  }
}

async function routeConsultCore(
  params: ConsultRouteParams,
  deps: ConsultRouteDeps,
): Promise<RouteResult> {
  const measure: NonNullable<ConsultRouteDeps['measure']> = deps.measure ?? ((_stage, work) => work());
  // `now` stamps the snapshot. It is deliberately NOT read by any scoring path
  // any more: stage 1 has no time term and stage 2 compares candidates against
  // each other, so wall-clock cannot reach the ranking (D-001).
  const now = deps.now ? deps.now() : new Date();
  const floors: RoutingFloors = {
    relevanceFloor: params.relevanceFloor ?? DEFAULT_RELEVANCE_FLOOR,
    simFloor: params.simFloor ?? DEFAULT_SIM_FLOOR,
  };
  const weights: BlendWeights = { ...DEFAULT_WEIGHTS, ...params.weights };
  const recencyHalfLifeDays = params.recencyHalfLifeDays ?? DEFAULT_RECENCY_HALF_LIFE_DAYS;
  const maxCandidates = params.maxCandidates ?? 8;
  const maxQualified = params.maxQualified ?? 3;
  const turnLimit = params.turnLimit ?? 200;
  const evidencePerOwner = params.evidencePerOwner ?? 3;
  const subjectRef = params.subjectRef?.trim() || null;
  const subjectPattern = subjectRef ? exactSubjectMentionPattern(subjectRef) : null;
  const inferredSubject = expertiseSubject(params.question);
  // Natural questions still require problem-specific evidence. Reducing one to
  // generic procedural words, or skipping validation when no code is named,
  // lets unrelated continuation history borrow semantic qualification.
  const subjectRefs = [...new Set((params.subjectRefs !== undefined ? params.subjectRefs : [inferredSubject ?? params.question])
    .map(ref => ref.trim()).filter(Boolean))];
  const unresolvedSubjectRefs = [...new Set((params.unresolvedSubjectRefs ?? []).map(ref => ref.trim()).filter(Boolean))];

  const base: Omit<RoutingSnapshot, 'candidates'> = {
    query: params.question,
    ...(subjectRefs.length ? { subjectRefs } : {}),
    ...(unresolvedSubjectRefs.length ? { unresolvedSubjectRefs } : {}),
    relevanceFloor: floors.relevanceFloor,
    simFloor: floors.simFloor,
    weights,
    recencyHalfLifeDays,
    computedAt: now.toISOString(),
  };

  const sql = deps.getSql();
  const withheld = await measure('disclosure', () => restrictedExpertsWithheld(sql, params));
  if (withheld) base.withheld = withheld;
  const notRestricted = (sql as unknown as Sql)`NOT ${restrictedOwnerSql(sql as unknown as Sql, 'session_turns')}`;
  const nativePopulation = nativeSourcePopulationSql(sql as unknown as Sql, params);
  const vec = deps.embed && deps.embeddingProfile
    ? await measure('embedding', () => deps.embed!(params.question)).catch(() => null)
    : null;
  if (!vec || vec.length === 0) {
    // The semantic instrument is unavailable, but the session-turn corpus still
    // has the same bounded lexical contract as search: the first 20k chars,
    // ranked best-first by the shared lexical seam (BM25 over
    // `session_turns_bm25`, else `ts_rank_cd` over `text_tsv`; plan
    // bm25-lexical-search-evoke-adoption-2026-10-10 P-005). This is retrieval
    // provenance, not a semantic qualification path: qualified stays empty and
    // every candidate is labeled as lexical fallback for the
    // minimum-fill/manual-review layer.
    let lexicalRows: Array<{
      owner: string;
      session_id: string;
      turn_idx: number;
      ts: string | Date | null;
      lexicalRank: number;
    }> = [];
    try {
      const pg = sql as unknown as Sql;
      const tq = pg`plainto_tsquery('english', ${params.question})`;
      lexicalRows = (await measure('transcripts', async () => {
        const leg = await lexicalLeg(pg, {
          table: 'session_turns',
          query: params.question,
          legacy: { score: pg`ts_rank_cd(text_tsv, ${tq})`, match: pg`text_tsv @@ ${tq}` },
        });
        return sql`
        SELECT owner, session_id, turn_idx,
               COALESCE(ts, ingested_at) AS ts,
               ${leg.score} AS "lexicalRank"
          FROM harness_shared.session_turns
         WHERE (workspace_id = ${params.workspaceId} OR workspace_id = 'default')
           AND owner IS NOT NULL
           AND owner <> ALL(${[params.requesterId, ...(params.excludeOwners ?? [])]}::text[])
           AND (turn_origin_verdict IS NULL OR turn_origin_verdict NOT IN ('agent-injected', 'machine-surface'))
           AND ${leg.match}
           AND (${subjectPattern}::text IS NULL OR COALESCE(text, '') ~* ${subjectPattern})
           AND ${notRestricted}
           AND ${nativePopulation}
      ORDER BY ${leg.order}, COALESCE(ts, ingested_at) DESC
         LIMIT ${turnLimit}
      `;
      })) as unknown as Array<{
        owner: string;
        session_id: string;
        turn_idx: number;
        ts: string | Date | null;
        lexicalRank: number;
      }>;
      lexicalRows = relativeLexicalRanks(lexicalRows);
    } catch {
      // A partially migrated host may not have text_tsv yet. The semantic
      // instrument is already degraded, so preserve an honest empty result and
      // let the core expose its bounded manual-review/park contract instead of
      // turning a recoverable fallback miss into a consult failure.
      lexicalRows = [];
    }

    const byOwner = new Map<string, { ranks: number[]; newestTs: number | null; evidence: TurnEvidence[] }>();
    for (const r of lexicalRows) {
      let owner = byOwner.get(r.owner);
      if (!owner) {
        owner = { ranks: [], newestTs: null, evidence: [] };
        byOwner.set(r.owner, owner);
      }
      const lexicalRank = Number(r.lexicalRank);
      owner.ranks.push(lexicalRank);
      const tsMs = r.ts ? new Date(r.ts as string).getTime() : null;
      if (tsMs !== null && (owner.newestTs === null || tsMs > owner.newestTs)) owner.newestTs = tsMs;
      if (owner.evidence.length < evidencePerOwner) {
        owner.evidence.push({
          session_id: r.session_id,
          turn_idx: r.turn_idx,
          ts: tsMs !== null ? new Date(tsMs).toISOString() : null,
          // `sim` is retained for the shared evidence shape, but remains zero:
          // no cosine similarity was measured on this path.
          sim: 0,
          lexicalRank,
        });
      }
    }

    const owners = [...byOwner.keys()];
    let livenessByOwner: Record<string, ConsultLivenessReading> = {};
    if (deps.getLiveness && owners.length > 0) {
      livenessByOwner = await measure('liveness', () => deps.getLiveness!(owners)).catch(() => ({}));
    }
    // No candidate can qualify on this path (similarity was never measured), so
    // the stage-2 reference is the freshest candidate overall — freshness stays
    // relative here too, purely as an audit signal.
    const snapshotCandidates = await measure('ranking', async () => {
    const lexicalReferenceMs = maxTimestamp([...byOwner.values()].map((o) => o.newestTs));
    const candidates: RoutingCandidate[] = owners.map((ownerId) => {
      const owner = byOwner.get(ownerId)!;
      const lexicalRank = clamp01(Math.max(...owner.ranks));
      const { freshness, relativeAgeDays } = freshnessOf(
        owner.newestTs,
        lexicalReferenceMs,
        recencyHalfLifeDays,
      );
      return {
        ownerId,
        // Relevance is 0 because none was MEASURED: the embedder is down, so
        // there is no similarity term and therefore no stage-1 score to claim.
        // Read `fallback:'lexical'` for what these candidates are; this zero is
        // the honest "never floor-qualified", not a low relevance.
        relevance: 0,
        // Score is the lexical rank on this path. It is intentionally not
        // blended with semantic weights NOR multiplied by freshness: the caller
        // must be able to see that this is a token-match minimum-fill
        // candidate, not a qualified expert being ranked by the D-001 stages.
        score: lexicalRank,
        relativeAgeDays,
        signals: { similarity: 0, verification: 0, authorship: 0, freshness },
        evidence: owner.evidence,
        ...annotateLiveness(livenessByOwner[ownerId]),
        fallback: 'lexical' as const,
      };
    });
    candidates.sort((a, b) => b.score - a.score || a.ownerId.localeCompare(b.ownerId));
    return candidates.slice(0, maxCandidates);
    });
    return {
      // NOT `no_qualified_responder`: that verdict asserts a MEASURED conclusion
      // about the peer population, and on this path nothing was measured — the
      // embedder is down, so similarity was never computed and no candidate was
      // ever ranked against the floor. Emitting the measured verdict here makes
      // an instrument failure indistinguishable from a real finding, and the
      // caller's rational response to the two is opposite (retry vs. don't).
      // EI-21485716602970457.
      verdict: 'relevance_unmeasured',
      qualified: [],
      snapshot: { ...base, candidates: snapshotCandidates, degraded: 'embed-unavailable', fallback: 'lexical' },
      queryVec: null,
      queryProfile: null,
      queryMode: null,
    };
  }

  const qVec = JSON.stringify(vec);

  // 1) Top-K turns by cosine similarity over the cross-agent transcript index.
  //    - `workspace_id = $ws OR 'default'`: the operational corpus lives at
  //      'default' (the session ingesters are workspace-blind); this is the
  //      same predicate the session_turn SearchSource uses.
  //    - machine-injected and machine-surface turns (loop fires, orient payloads,
  //      injected briefs) are excluded: every agent receives near-identical
  //      injected boilerplate, so matches there measure the injector, not the
  //      agent's engagement. NULL verdict (not yet classified) passes —
  //      over-filtering starves the router.
  //    - withIterativeScan: without it the HNSW scan stops at hnsw.ef_search
  //      and silently under-returns (WI-37603).
  const fetchedTurnRows = (await measure('transcripts', () => withIterativeScan(sql as never, (s) => {
    const tx = s as unknown as Sql;
    const turnFilter = tx`(workspace_id = ${params.workspaceId} OR workspace_id = 'default')
       AND text_embedding IS NOT NULL
       AND ${proseProfilePredicateSql(tx, deps.embeddingProfile, 'text_embedding_profile', 'text_embedding_mode')}
       AND owner IS NOT NULL
       AND owner <> ALL(${[params.requesterId, ...(params.excludeOwners ?? [])]}::text[])
       AND (turn_origin_verdict IS NULL OR turn_origin_verdict NOT IN ('agent-injected', 'machine-surface'))
       AND (${subjectPattern}::text IS NULL OR COALESCE(text, '') ~* ${subjectPattern})
       AND ${notRestricted}
       AND ${nativePopulation}`;
    const columns = tx`owner, session_id, turn_idx, COALESCE(ts, ingested_at) AS ts,
      left(COALESCE(text, ''), ${SUBJECT_EVIDENCE_TEXT_LIMIT}) AS "subjectText"`;
    if (params.nativeConsult?.sourceState === 'live') {
      // A global HNSW scan can exhaust max_scan_tuples before encountering
      // any of these sparse current incarnations, even with iterative scan.
      // Use indexed native-session lookups first, then rank their exact
      // eligible population. Keep the canonical eligibility predicate above.
      return tx`WITH native_sources AS MATERIALIZED (
        SELECT DISTINCT a.coord_owner_id AS native_owner,
          CASE WHEN a.agent = 'omp' THEN COALESCE(a.omp_thread_id, a.session_id)
               ELSE a.session_id END AS native_session_id
          FROM harness_shared.adv_sessions a
         WHERE a.workspace_id = ${params.workspaceId}
           AND a.agent = ${params.nativeConsult.sourceBackend}
           AND a.role IS NULL AND a.ended_at IS NULL
      ), native_turns AS MATERIALIZED (
        SELECT ${columns}, text_embedding
          FROM native_sources n
          CROSS JOIN LATERAL (
            SELECT * FROM harness_shared.session_turns
             WHERE session_id = n.native_session_id AND owner = n.native_owner
               AND ${turnFilter}
            OFFSET 0
          ) session_turns
      ) SELECT owner, session_id, turn_idx, ts, "subjectText",
               1 - (text_embedding <=> ${qVec}::vector) AS sim
          FROM native_turns
      ORDER BY text_embedding <=> ${qVec}::vector
         LIMIT ${turnLimit}`;
    }
    return tx`SELECT ${columns}, 1 - (text_embedding <=> ${qVec}::vector) AS sim
        FROM harness_shared.session_turns
       WHERE ${turnFilter}
    ORDER BY text_embedding <=> ${qVec}::vector
       LIMIT ${turnLimit}`;
  }))) as unknown as Array<{
    owner: string;
    session_id: string;
    turn_idx: number;
    ts: string | Date | null;
    sim: number;
    subjectText: string;
  }>;
  const turnRows = fetchedTurnRows;

  if (turnRows.length === 0) {
    return {
      verdict: 'no_qualified_responder',
      qualified: [],
      snapshot: { ...base, candidates: [] },
      queryVec: vec,
      queryProfile: deps.embeddingProfile,
      queryMode: deps.embeddingMode,
    };
  }

  // 2) Aggregate per owner: max similarity, newest evidence turn, top evidence.
  const byOwner = new Map<string, { sims: number[]; newestTs: number | null; evidence: TurnEvidence[] }>();
  for (const r of turnRows) {
    let o = byOwner.get(r.owner);
    if (!o) {
      o = { sims: [], newestTs: null, evidence: [] };
      byOwner.set(r.owner, o);
    }
    const sim = Number(r.sim);
    o.sims.push(sim);
    const tsMs = r.ts ? new Date(r.ts as string).getTime() : null;
    if (tsMs !== null && (o.newestTs === null || tsMs > o.newestTs)) o.newestTs = tsMs;
    if (o.evidence.length < evidencePerOwner) {
      o.evidence.push({
        session_id: r.session_id,
        turn_idx: r.turn_idx,
        ts: tsMs !== null ? new Date(tsMs).toISOString() : null,
        sim,
      });
    }
  }
  const owners = [...byOwner.keys()];

  // 3) Verification: committed completions per owner, over ALL time.
  //    authority='committed' is the evidence-backed close — a bare "done"
  //    assertion lands 'proposed' and does not count (D-002: earned, not
  //    asserted).
  //
  //    ⚠ The 90-day window this query used to carry is GONE, deliberately
  //    (consult-expert-routing-2026-09-22 D-007b). It was a second, quieter
  //    copy of the defect D-001 removed from the blend weights: a trailing
  //    window decays with inactivity, so an idle expert's verification signal
  //    shrank and could drop them below the floor — the vacation case, one
  //    signal over and on a slower clock. A completion is evidence that does
  //    not expire. Do not reintroduce a time predicate here; if the signal
  //    needs bounding, bound it by COUNT saturation (VERIFICATION_SATURATION_K
  //    already does) rather than by age.
  //
  //    ⚠ The column is `authority`, NOT `completion_authority`, and the date
  //    column is `closed_ts` (bigint epoch-ms), NOT `closed_at` (EI-20816404371786180).
  //    Both wrong names were live here and killed EVERY consult:get_feedback call
  //    with `column "completion_authority" does not exist` — which, because the
  //    acceptance-rubric VETTING gate requires a consult, meant no plan in the
  //    workspace could ship. The name is misleading on purpose-of-record:
  //    678-rename-authority-to-completion-authority.sql is named for that rename
  //    but is COMMENT-ONLY — the rename was ABANDONED (D-009), because the column
  //    is exposed through the consolidated views and is therefore rename-proof.
  //    Do not "restore" the longer name here; change the schema first or not at all.
  //    (`closed_at` DOES exist on harness_shared.consult_state — that is why the
  //    other consult modules use it correctly and only this query was wrong.)
  const verRows = (await measure('verification', () => sql`
    SELECT terminal_owner AS owner, count(*)::int AS c
      FROM harness_shared.work_items
     WHERE terminal_owner = ANY(${owners}::text[])
       AND authority = 'committed'
  GROUP BY terminal_owner
  `)) as unknown as Array<{ owner: string; c: number }>;
  const verByOwner = new Map(verRows.map((r) => [r.owner, r.c]));

  // 4) Authorship: only when the question names code paths. Matches the
  //    candidate owners' completed work-items' recorded paths.
  const pathTokens = extractPathTokens(params.question);
  const authByOwner = new Map<string, number>();
  if (pathTokens.length > 0) {
    const patterns = pathTokens.map((t) => `%${t}%`);
    const authRows = (await measure('authorship', () => sql`
      SELECT terminal_owner AS owner, count(DISTINCT feature_id)::int AS c
        FROM harness_shared.work_items w,
             LATERAL jsonb_array_elements_text(w.payload->'paths') AS p(path)
       WHERE terminal_owner = ANY(${owners}::text[])
         AND jsonb_typeof(w.payload->'paths') = 'array'
         AND p.path ILIKE ANY(${patterns}::text[])
    GROUP BY terminal_owner
    `)) as unknown as Array<{ owner: string; c: number }>;
    for (const r of authRows) authByOwner.set(r.owner, r.c);
  }

  // Similar words and a general completion history do not establish expertise
  // in a named system. Validate a bounded above-floor pool against its primary
  // subject; keep mismatches/unmeasured candidates for labelled minimum fill.
  const subjectCoverageByOwner = new Map<string, NonNullable<RoutingCandidate['subjectEvidenceCoverage']>>();
  if (subjectRefs.length || unresolvedSubjectRefs.length) {
    const eligible = owners.filter(ownerId => {
      const similarity = clamp01(Math.max(...byOwner.get(ownerId)!.sims));
      const c = verByOwner.get(ownerId) ?? 0;
      return meetsRoutingFloors({ relevance: relevanceOf({ similarity,
        verification: c / (c + VERIFICATION_SATURATION_K), authorship: clamp01((authByOwner.get(ownerId) ?? 0) / 2) }, weights),
        signals: { similarity } }, floors);
    }).sort((a, b) => Math.max(...byOwner.get(b)!.sims) - Math.max(...byOwner.get(a)!.sims) || a.localeCompare(b));
    const unmeasuredEvidence = subjectRefs.map(subject => ({ subject, status: 'unmeasured' as const, score: null }));
    for (const ownerId of eligible) subjectCoverageByOwner.set(ownerId, {
      status: 'unmeasured', required: subjectRefs, evidence: unmeasuredEvidence.map(row => ({ ...row })),
      unresolved: unresolvedSubjectRefs,
    });
    const boundedOwners = eligible.slice(0, SUBJECT_EVIDENCE_OWNER_LIMIT);
    const passages = boundedOwners.flatMap(ownerId => turnRows.filter(r => r.owner === ownerId)
      .slice(0, Math.min(evidencePerOwner, 3)).map(r => ({ ownerId, text: r.subjectText })));
    const usable = passages.filter(p => typeof p.text === 'string' && p.text.trim());
    if (usable.length && subjectRefs.length) {
      try {
        const deadline = Date.now() + SUBJECT_EVIDENCE_TIMEOUT_MS;
        const { value: scoreBySubject } = await measure('evidence', () => withDeadlineFallback((async () => {
          const all: Array<Array<number | null>> = [];
          for (const subject of subjectRefs) {
            if (Date.now() >= deadline) {
              all.push(usable.map(() => null));
              continue;
            }
            const scores = await (deps.scoreSubjectEvidence ?? scoreSubjectEvidence)(subject, usable.map(p => p.text), deadline)
              .catch(() => usable.map(() => null));
            all.push(scores.length === usable.length ? scores : usable.map(() => null));
          }
          return all;
        })(), SUBJECT_EVIDENCE_TIMEOUT_MS, () => subjectRefs.map(() => usable.map(() => null))));
        for (const ownerId of boundedOwners) {
          const evidence = subjectRefs.map((subject, subjectIndex) => {
            const scores = scoreBySubject[subjectIndex] ?? [];
            const observed = usable.flatMap((p, passageIndex) => p.ownerId === ownerId &&
              typeof scores[passageIndex] === 'number' && Number.isFinite(scores[passageIndex]) &&
              scores[passageIndex]! >= 0 && scores[passageIndex]! <= 1 ? [scores[passageIndex] as number] : []);
            if (!observed.length) return { subject, status: 'unmeasured' as const, score: null };
            const score = Math.max(...observed);
            return { subject, status: score >= SUBJECT_EVIDENCE_MIN_SCORE ? 'supported' as const : 'mismatch' as const, score };
          });
          const status = unresolvedSubjectRefs.length || evidence.some(row => row.status === 'unmeasured')
            ? 'unmeasured'
            : evidence.some(row => row.status === 'mismatch') ? 'mismatch' : 'supported';
          subjectCoverageByOwner.set(ownerId, { status, required: subjectRefs, evidence, unresolved: unresolvedSubjectRefs });
        }
      } catch { /* unknown remains explicit, including capped or unavailable owners */ }
    }
    const coverage = [...subjectCoverageByOwner.values()];
    const unmeasured = coverage.filter(row => row.status === 'unmeasured').length;
    base.subjectValidation = {
      ...(subjectRefs.length === 1 ? { subject: subjectRefs[0] } : {}),
      subjects: subjectRefs,
      threshold: SUBJECT_EVIDENCE_MIN_SCORE,
      evaluated: coverage.length - unmeasured,
      unmeasured,
      limit: SUBJECT_EVIDENCE_OWNER_LIMIT,
      unresolved: unresolvedSubjectRefs,
    };
    if (unmeasured) base.degraded = 'evidence-unavailable';
  }

  // 5) Liveness annotation (never a gate here — D-008 §5).
  let livenessByOwner: Record<string, ConsultLivenessReading> = {};
  if (deps.getLiveness) {
    livenessByOwner = await measure('liveness', () => deps.getLiveness!(owners)).catch(() => ({}));
  }

  // 6) STAGE 1 — QUALIFY, with no time term anywhere (D-001 §1).
  const { qualified, snapshotCandidates } = await measure('ranking', async () => {
  const scored = owners.map((ownerId) => {
    const o = byOwner.get(ownerId)!;
    const similarity = clamp01(Math.max(...o.sims));
    const c = verByOwner.get(ownerId) ?? 0;
    const verification = clamp01(c / (c + VERIFICATION_SATURATION_K));
    const authorship = clamp01((authByOwner.get(ownerId) ?? 0) / 2);
    const signals = { similarity, verification, authorship };
    return {
      ownerId,
      signals,
      relevance: relevanceOf(signals, weights),
      newestTs: o.newestTs,
      evidence: o.evidence,
      ...(subjectCoverageByOwner.has(ownerId) ? {
        subjectEvidenceCoverage: subjectCoverageByOwner.get(ownerId)!,
        ...(subjectCoverageByOwner.get(ownerId)!.evidence.length === 1
          ? { subjectEvidence: subjectCoverageByOwner.get(ownerId)!.evidence[0] }
          : {}),
      } : {}),
    };
  });

  // D-007(a): the floor sees EVERY candidate, not the top-`maxCandidates` slice.
  // The slice used to happen first, and because it was ordered by the
  // recency-bearing score it could evict an aged-but-highly-relevant expert
  // before the floor ever measured them — a recency disqualification hiding in
  // the pagination rather than in the weights.
  const qualifiedIds = new Set(
    scored.filter((s) => meetsRoutingFloors(s, floors)).map((s) => s.ownerId),
  );

  // 7) STAGE 2 — COMPARE (D-001 §2). The reference point is the freshest
  //    QUALIFIED candidate in THIS consult; with nobody qualified there is no
  //    qualified frame to measure against, so the freshest candidate overall
  //    orders the minimum-fill pool. Either way it is a property OF THE SET, so
  //    shifting every candidate's history by the same amount shifts the
  //    reference identically and the ordering is untouched.
  const referenceMs =
    maxTimestamp(scored.filter((s) => qualifiedIds.has(s.ownerId)).map((s) => s.newestTs)) ??
    maxTimestamp(scored.map((s) => s.newestTs));

  const candidates: RoutingCandidate[] = scored.map((s) => {
    const { freshness, relativeAgeDays } = freshnessOf(s.newestTs, referenceMs, recencyHalfLifeDays);
    return {
      ownerId: s.ownerId,
      relevance: s.relevance,
      score: clamp01(s.relevance * freshness),
      relativeAgeDays,
      signals: { ...s.signals, freshness },
      evidence: s.evidence,
      ...(s.subjectEvidence ? { subjectEvidence: s.subjectEvidence } : {}),
      ...(s.subjectEvidenceCoverage ? { subjectEvidenceCoverage: s.subjectEvidenceCoverage } : {}),
      ...annotateLiveness(livenessByOwner[s.ownerId]),
    };
  });
  // Tie-break by ownerId so an equal-score pair has ONE stable order — without
  // it the winner depends on Map insertion order, i.e. on row order from the
  // vector scan, and the same question can route to different peers.
  candidates.sort((a, b) => b.score - a.score || a.ownerId.localeCompare(b.ownerId));

  const qualified = candidates.filter((c) => qualifiedIds.has(c.ownerId)).slice(0, maxQualified);
  const snapshotCandidates = boundedSnapshot(candidates, qualified, maxCandidates);
  return { qualified, snapshotCandidates };
  });

  return {
    verdict: qualified.length > 0 ? 'routed' : base.degraded === 'evidence-unavailable' ? 'relevance_unmeasured' : 'no_qualified_responder',
    qualified,
    snapshot: { ...base, candidates: snapshotCandidates },
    queryVec: vec,
    queryProfile: deps.embeddingProfile,
    queryMode: deps.embeddingMode,
  };
}
