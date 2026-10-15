/**
 * Whole-tenure computed goal-mode-e2e cards — plan
 * goal-grading-live-coverage-and-holder-followthrough-2026-10-08, P-004.
 *
 * P-003 made 23 of the 39 goal-mode-e2e criteria computable from the ledgers
 * (goal-mode-computed-instruments.ts), but they were only evaluated when someone emitted a
 * card. Grading was still sampled in 2h windows by a human grader, and on goal 60d3a8 that
 * sampling covered 22 of 121 holder-tenure hours. This module evaluates the instruments
 * continuously instead:
 *
 *  - A TENURE is a maximal run of one owner's holder-agent, goal-stamped calls for one goal,
 *    split where the holder went quiet for more than COMPUTED_TENURE_GAP_MS. It is derived
 *    from tool_invocations because the holder's agent_modes row disappears once the lease
 *    moves on (resolveHolderGoalForWindow makes the same choice).
 *  - Each tenure gets ONE current computed card: a goal-mode-e2e scorecard authored by
 *    GOAL_COMPUTED_CARD_AUTHOR whose subject window is the whole tenure (start..now while it
 *    is ongoing, start..last call once it ended). It rates every instrumented criterion from
 *    the instruments and every other criterion `unknown`/`not-assessed`. It is never
 *    terminal, so emit stamps it provisional (goal-mode-e2e has violatable criteria): a
 *    working note that never counts as graded coverage.
 *  - The card is re-filed (superseding the previous one, so exactly one stays current) only
 *    when the computed verdicts change, when an ongoing tenure's card is older than
 *    COMPUTED_CARD_REFRESH_MS, or when the tenure ends. That is a rolling evaluation with a
 *    bounded row count, not 2h samples.
 *  - The grader finishes the tenure by superseding the current computed card with a
 *    terminal card. Emit adopts the computed card's settled ratings (pass, and unknown
 *    idle/not-exercised) for every criterion the grader omits, so the grader rates only the
 *    residual criteria: the ones needing judgment, the uninstrumented ones, and computed
 *    fails (each needs a remediation/disregard routing decision only the grader can make).
 *    Once a grader card supersedes a computed card, the tenure is graded and this sweep
 *    stops touching it.
 *
 * Scheduling: rides the goal-owner-report watchdog timer, like the P-002 backlog sweep
 * (D-003: no new scheduler).
 */
import type { Sql } from 'postgres';

import {
  CHILD_PROOF_WINDOW_MS,
  GOAL_MODE_INSTRUMENTED_CRITERIA,
  goalModeInstrumentKey,
  type GoalModeComputedRating,
} from './goal-mode-computed-instruments';

export const GOAL_COMPUTED_CARD_RUBRIC_REF = 'goal-mode-e2e';
/** The createdBy of every computed tenure card. Never a grader: it never counts as one. */
export const GOAL_COMPUTED_CARD_AUTHOR = 'goal-grading-computed';
/** A holder silent this long ends its tenure; a later call starts a new one. */
export const COMPUTED_TENURE_GAP_MS = 4 * 3600_000;
/** How far back holder activity and cards are read. */
export const COMPUTED_TENURE_LOOKBACK_MS = 7 * 24 * 3600_000;
/** Ended tenures older than this are left alone. */
export const COMPUTED_TENURE_ACTIVE_HORIZON_MS = 48 * 3600_000;
/** An ongoing tenure's card is re-filed at least this often, so its window keeps up. */
export const COMPUTED_CARD_REFRESH_MS = 60 * 60_000;
/** Every computed rating's evidence starts with this marker. */
export const COMPUTED_EVIDENCE_PREFIX = '[computed:goal-mode]';
/** The disposition a computed fail carries until the grader's terminal card routes it. */
export const COMPUTED_FAIL_DISREGARD =
  'Provisional computed card: routing this fail (remediation or disregard) is owed by the goal-mode-e2e ' +
  'grader on the terminal card that supersedes this one.';

const MINUTE_MS = 60_000;

// ---------------------------------------------------------------------------
// Tenures
// ---------------------------------------------------------------------------

export interface HolderTenure {
  workspaceId: string;
  goalId: string;
  ownerId: string;
  startMs: number;
  /** The tenure's last holder call. */
  lastMs: number;
  /** True while the holder still holds the goal and has called within the gap. */
  ongoing: boolean;
  /** The subject window end: now while ongoing, the last call once ended. */
  endMs: number;
}

/**
 * PURE: split one goal's holder activity into tenures. `activity` is (owner, epoch ms)
 * for holder-agent goal-stamped calls (minute buckets are fine). A tenure is ongoing only
 * when its owner is the goal's current lease holder, the goal is active, it is that
 * owner's latest run, and the last call is within the gap of now.
 */
export function deriveHolderTenures(input: {
  workspaceId: string;
  goalId: string;
  activity: ReadonlyArray<{ ownerId: string; atMs: number }>;
  nowMs: number;
  currentHolderOwnerId: string | null;
  goalActive: boolean;
  gapMs?: number;
}): HolderTenure[] {
  const gapMs = input.gapMs ?? COMPUTED_TENURE_GAP_MS;
  const byOwner = new Map<string, number[]>();
  for (const { ownerId, atMs } of input.activity) {
    if (!ownerId || !Number.isFinite(atMs) || atMs > input.nowMs) continue;
    const list = byOwner.get(ownerId);
    if (list) list.push(atMs);
    else byOwner.set(ownerId, [atMs]);
  }
  const tenures: HolderTenure[] = [];
  for (const [ownerId, times] of byOwner) {
    times.sort((a, b) => a - b);
    const runs: Array<{ startMs: number; lastMs: number }> = [];
    for (const at of times) {
      const run = runs[runs.length - 1];
      if (run && at - run.lastMs <= gapMs) run.lastMs = at;
      else runs.push({ startMs: at, lastMs: at });
    }
    runs.forEach((run, index) => {
      const ongoing =
        input.goalActive &&
        ownerId === input.currentHolderOwnerId &&
        index === runs.length - 1 &&
        input.nowMs - run.lastMs <= gapMs;
      // A tenure of one call still has a window: pad it to a minute so start < end.
      const endMs = ongoing ? input.nowMs : Math.max(run.lastMs, run.startMs + MINUTE_MS);
      tenures.push({ workspaceId: input.workspaceId, goalId: input.goalId, ownerId, ...run, ongoing, endMs });
    });
  }
  return tenures.sort((a, b) => a.startMs - b.startMs || a.ownerId.localeCompare(b.ownerId));
}

// ---------------------------------------------------------------------------
// Ratings
// ---------------------------------------------------------------------------

export interface ComputedCardRating {
  rating: 'pass' | 'fail' | 'unknown';
  evidence: string;
  unknownReason?: 'idle' | 'not-exercised' | 'not-assessed';
  disregard?: string;
}

/**
 * PURE: one complete rating map for the rubric's criteria. Instrumented criteria carry the
 * instrument verdict; a `needs-judgment` unknown and every uninstrumented criterion read
 * `unknown`/`not-assessed`, which is what they are on this card: not yet assessed.
 */
export function buildComputedTenureRatings(
  criterionKeys: readonly string[],
  computed: Readonly<Record<string, GoalModeComputedRating>>,
): Record<string, ComputedCardRating> {
  const out: Record<string, ComputedCardRating> = {};
  for (const key of criterionKeys) {
    const measured = GOAL_MODE_INSTRUMENTED_CRITERIA.includes(key) ? computed[key] : undefined;
    if (!measured) {
      out[key] = {
        rating: 'unknown',
        unknownReason: 'not-assessed',
        evidence: `${COMPUTED_EVIDENCE_PREFIX} No computed instrument for this criterion; it is residual and needs the grader.`,
      };
      continue;
    }
    const tag = `${COMPUTED_EVIDENCE_PREFIX} ${goalModeInstrumentKey(key)}:`;
    if (measured.verdict === 'pass') {
      out[key] = { rating: 'pass', evidence: `${tag} ${measured.reason}` };
    } else if (measured.verdict === 'fail') {
      out[key] = { rating: 'fail', evidence: `${tag} ${measured.reason}`, disregard: COMPUTED_FAIL_DISREGARD };
    } else if (measured.unknownReason === 'idle' || measured.unknownReason === 'not-exercised') {
      out[key] = { rating: 'unknown', unknownReason: measured.unknownReason, evidence: `${tag} ${measured.reason}` };
    } else {
      out[key] = {
        rating: 'unknown',
        unknownReason: 'not-assessed',
        evidence: `${tag} needs grader judgment: ${measured.reason}`,
      };
    }
  }
  return out;
}

/** PURE: the verdict identity of a rating map (evidence prose excluded). */
export function computedRatingsSignature(ratings: Readonly<Record<string, { rating: string; unknownReason?: string }>>): string {
  return Object.keys(ratings)
    .sort()
    .map((key) => `${key}=${ratings[key]!.rating}${ratings[key]!.unknownReason ? `/${ratings[key]!.unknownReason}` : ''}`)
    .join(';');
}

/** A computed rating the grader may leave to the computed card: settled facts only. */
export function isAdoptableComputedRating(entry: { rating?: string; unknownReason?: string; evidence?: string } | undefined): boolean {
  if (!entry || typeof entry.evidence !== 'string' || !entry.evidence.startsWith(COMPUTED_EVIDENCE_PREFIX)) return false;
  if (entry.rating === 'pass') return true;
  return entry.rating === 'unknown' && (entry.unknownReason === 'idle' || entry.unknownReason === 'not-exercised');
}

/**
 * PURE: the grader's residual ratings merged over a computed card. Every criterion the
 * grader omitted and the computed card settled (isAdoptableComputedRating) is adopted with
 * its evidence; anything else stays missing, so the completeness check names it. Supplied
 * ratings always win.
 */
export function mergeComputedTenureRatings<R extends Record<string, unknown>>(input: {
  supplied: Readonly<Record<string, R>>;
  computed: Readonly<Record<string, { rating?: string; unknownReason?: string; evidence?: string }>>;
  criterionKeys: readonly string[];
  computedCardId: string;
}): { ratings: Record<string, R>; adoptedKeys: string[]; residualKeys: string[] } {
  const ratings: Record<string, R> = { ...input.supplied };
  const adoptedKeys: string[] = [];
  const residualKeys: string[] = [];
  for (const key of input.criterionKeys) {
    if (ratings[key] !== undefined) continue;
    const entry = input.computed[key];
    if (isAdoptableComputedRating(entry)) {
      ratings[key] = {
        rating: entry!.rating,
        ...(entry!.unknownReason ? { unknownReason: entry!.unknownReason } : {}),
        evidence: `${entry!.evidence} (adopted from computed card ${input.computedCardId})`,
      } as unknown as R;
      adoptedKeys.push(key);
    } else {
      residualKeys.push(key);
    }
  }
  return { ratings, adoptedKeys, residualKeys };
}

export interface ComputedCardForAdoption {
  createdBy: string | null;
  subject: { ref?: string; windowStart?: string; windowEnd?: string } | null;
  ratings: Record<string, { rating?: string; unknownReason?: string; evidence?: string }>;
}

/**
 * The grader side of P-004: when a goal-mode-e2e emit supersedes a COMPUTED tenure card for
 * the identical subject window, adopt that card's settled ratings for every criterion the
 * grader omitted. Returns null (emit proceeds unchanged) for any other supersede: a
 * different rubric, a non-computed card, or a different subject or window, so adoption can
 * never import a rating graded over another window.
 */
export async function adoptComputedTenureRatings<R extends Record<string, unknown>>(
  input: {
    rubricRef: string;
    supersedes: string | undefined;
    subject: { ref?: string; windowStart?: string; windowEnd?: string } | undefined;
    supplied: Readonly<Record<string, R>> | undefined;
    criterionKeys: readonly string[];
  },
  deps: { readCard: (issueId: string) => Promise<ComputedCardForAdoption | null> },
): Promise<{ ratings: Record<string, R>; adoptedKeys: string[]; residualKeys: string[]; computedCardId: string } | null> {
  if (input.rubricRef !== GOAL_COMPUTED_CARD_RUBRIC_REF || !input.supersedes || !input.supplied || !input.subject?.ref) {
    return null;
  }
  const card = await deps.readCard(input.supersedes);
  if (!card || card.createdBy !== GOAL_COMPUTED_CARD_AUTHOR || !card.subject) return null;
  const sameInstant = (a: string | undefined, b: string | undefined) =>
    typeof a === 'string' && typeof b === 'string' && Date.parse(a) === Date.parse(b) && Number.isFinite(Date.parse(a));
  if (
    card.subject.ref !== input.subject.ref ||
    !sameInstant(card.subject.windowStart, input.subject.windowStart) ||
    !sameInstant(card.subject.windowEnd, input.subject.windowEnd)
  ) {
    return null;
  }
  return {
    ...mergeComputedTenureRatings({
      supplied: input.supplied,
      computed: card.ratings,
      criterionKeys: input.criterionKeys,
      computedCardId: input.supersedes,
    }),
    computedCardId: input.supersedes,
  };
}

// ---------------------------------------------------------------------------
// Card lifecycle
// ---------------------------------------------------------------------------

export interface TenureCardRow {
  issueId: string;
  createdMs: number;
  createdBy: string | null;
  subjectRef: string;
  windowStartMs: number;
  windowEndMs: number;
  /** The card this one supersedes, if any. */
  supersedes: string | null;
  ratingsSignature: string;
}

export interface TenureCardState {
  /** The current (unsuperseded) computed card for this tenure, if any. */
  current: TenureCardRow | null;
  /** A non-computed card superseded one of this tenure's computed cards: grading is done. */
  graded: boolean;
}

/**
 * PURE: locate a tenure's card state among the cards for its owner. A computed card
 * belongs to the tenure when its window overlaps [start - gap, end]: that keeps the
 * identity stable even when the lookback truncates a very long tenure's start.
 */
export function tenureCardState(
  tenure: HolderTenure,
  cards: readonly TenureCardRow[],
  gapMs: number = COMPUTED_TENURE_GAP_MS,
): TenureCardState {
  const supersededBy = new Map<string, TenureCardRow>();
  for (const card of cards) if (card.supersedes) supersededBy.set(card.supersedes, card);
  const mine = cards.filter(
    (card) =>
      card.createdBy === GOAL_COMPUTED_CARD_AUTHOR &&
      card.subjectRef === tenure.ownerId &&
      card.windowStartMs <= tenure.endMs &&
      card.windowEndMs >= tenure.startMs - gapMs,
  );
  const graded = mine.some((card) => {
    const next = supersededBy.get(card.issueId);
    return next !== undefined && next.createdBy !== GOAL_COMPUTED_CARD_AUTHOR;
  });
  const current = mine
    .filter((card) => !supersededBy.has(card.issueId))
    .sort((a, b) => b.createdMs - a.createdMs)[0] ?? null;
  return { current, graded };
}

export type TenureCardAction =
  | { action: 'skip'; reason: 'graded' | 'settled' }
  | { action: 'evaluate' };

/** PURE: does this tenure need its instruments evaluated this tick? */
export function tenureNeedsEvaluation(tenure: HolderTenure, state: TenureCardState, nowMs: number): TenureCardAction {
  if (state.graded) return { action: 'skip', reason: 'graded' };
  const current = state.current;
  if (
    current &&
    !tenure.ongoing &&
    current.windowEndMs === tenure.endMs &&
    nowMs - tenure.endMs > CHILD_PROOF_WINDOW_MS + COMPUTED_CARD_REFRESH_MS
  ) {
    return { action: 'skip', reason: 'settled' };
  }
  return { action: 'evaluate' };
}

export type TenureCardEmitDecision =
  | { emit: false; reason: 'unchanged' }
  | { emit: true; supersedes: string | null; reason: 'first' | 'verdicts-changed' | 'tenure-ended' | 'refresh' };

/** PURE: given the freshly computed signature, file a card or leave the current one. */
export function decideTenureCardEmit(input: {
  tenure: HolderTenure;
  current: TenureCardRow | null;
  signature: string;
  nowMs: number;
  windowStartMs: number;
}): TenureCardEmitDecision {
  const { current } = input;
  if (!current) return { emit: true, supersedes: null, reason: 'first' };
  if (current.ratingsSignature !== input.signature) {
    return { emit: true, supersedes: current.issueId, reason: 'verdicts-changed' };
  }
  if (!input.tenure.ongoing) {
    return current.windowEndMs === input.tenure.endMs && current.windowStartMs === input.windowStartMs
      ? { emit: false, reason: 'unchanged' }
      : { emit: true, supersedes: current.issueId, reason: 'tenure-ended' };
  }
  return input.nowMs - current.windowEndMs >= COMPUTED_CARD_REFRESH_MS
    ? { emit: true, supersedes: current.issueId, reason: 'refresh' }
    : { emit: false, reason: 'unchanged' };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Holder-agent goal-stamped activity for one goal, in minute buckets. */
export async function readGoalHolderActivity(
  input: { workspaceId: string; goalId: string; sinceMs: number },
  deps: { sql: Sql },
): Promise<Array<{ ownerId: string; atMs: number }>> {
  const rows = await deps.sql<{ owner: string; minute: Date }[]>`
    SELECT coord_owner_id AS owner, date_trunc('minute', invoked_at) AS minute
      FROM harness_shared.tool_invocations
     WHERE workspace_id = ${input.workspaceId}
       AND goal_id = ${input.goalId}
       AND goal_actor_class = 'holder-agent'
       AND coord_owner_id IS NOT NULL
       AND invoked_at >= ${new Date(input.sinceMs)}
     GROUP BY 1, 2`;
  return rows.map((row) => ({ ownerId: row.owner, atMs: new Date(row.minute).getTime() }));
}

/** Every goal-mode-e2e card (any author) whose subject is one of these owners. */
export async function readTenureCards(
  input: { workspaceId: string; ownerIds: readonly string[]; sinceMs: number },
  deps: { sql: Sql },
): Promise<TenureCardRow[]> {
  if (input.ownerIds.length === 0) return [];
  const rows = await deps.sql<{
    feature_id: string;
    created_ts: string;
    created_by: string | null;
    ref: string;
    ws: string | null;
    we: string | null;
    supersedes: string | null;
    ratings: Record<string, { rating?: string; unknownReason?: string }> | null;
  }[]>`
    SELECT feature_id,
           created_ts::text AS created_ts,
           payload -> '_ei' ->> 'created_by' AS created_by,
           payload -> 'observation' -> 'subject' ->> 'ref' AS ref,
           payload -> 'observation' -> 'subject' ->> 'windowStart' AS ws,
           payload -> 'observation' -> 'subject' ->> 'windowEnd' AS we,
           payload -> 'observation' ->> 'supersedes' AS supersedes,
           payload -> 'observation' -> 'ratings' AS ratings
      FROM harness_shared.work_items
     WHERE workspace_id = ${input.workspaceId}
       AND lane = 'observation'
       AND payload -> 'observation' ->> 'rubricRef' = ${GOAL_COMPUTED_CARD_RUBRIC_REF}
       AND payload -> 'observation' -> 'subject' ->> 'ref' = ANY(${input.ownerIds as string[]})
       AND created_ts >= ${input.sinceMs}`;
  return rows
    .map((row) => ({
      issueId: row.feature_id,
      createdMs: Number(row.created_ts),
      createdBy: row.created_by?.trim() || null,
      subjectRef: row.ref,
      windowStartMs: row.ws ? Date.parse(row.ws) : NaN,
      windowEndMs: row.we ? Date.parse(row.we) : NaN,
      supersedes: row.supersedes?.trim() || null,
      ratingsSignature: computedRatingsSignature(
        Object.fromEntries(
          Object.entries(row.ratings ?? {}).map(([key, value]) => [
            key,
            { rating: String(value?.rating ?? ''), ...(value?.unknownReason ? { unknownReason: value.unknownReason } : {}) },
          ]),
        ),
      ),
    }))
    .filter((row) => Number.isFinite(row.windowStartMs) && Number.isFinite(row.windowEndMs) && Number.isFinite(row.createdMs));
}
