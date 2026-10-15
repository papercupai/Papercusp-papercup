/**
 * Owner-ask dedup for goal lineages (P-006 of plan
 * goal-grading-live-coverage-and-holder-followthrough-2026-10-08).
 *
 * A goal holder that re-orients after a carry-respawn has no memory of the
 * owner question it already opened, so it asks again: the owner then sees two
 * live gates for one decision, answers one, and the other sits open forever.
 * Goal executors (other sessions whose `session_briefs.goal_id` is the same
 * goal) do the same for questions their holder already asked.
 *
 * Before `coord:ask-owner` opens a thread, this module finds an OPEN owner ask
 * from the caller's goal lineage whose question overlaps the new one:
 *
 *  - SAME asker → the caller supersedes its own earlier ask
 *    (`supersedes_conversation_id`), so exactly one gate stays live and it
 *    carries the newest wording.
 *  - ANOTHER session of the same goal → the caller JOINS the existing ask
 *    instead of opening a duplicate. It does NOT supersede it:
 *    `supersedeConversation` refuses a cross-asker supersede of an owner
 *    question (`not_owner`, the WI-1373235 rail — a misidentified id once
 *    retracted an unrelated gate), and that rail stays intact.
 *
 * Overlap = Jaccard over the normalized question-title tokens, reusing the
 * work-item recent-dupe guard's tokenizer and metric (reuse-first, D-003).
 * Distinct questions from one goal stay separate asks.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { jaccardSimilarity, titleTokens } from '../agent-tools/work_items/recent-lexical-dupe-guard.js';

/** Minimum title-token Jaccard for two owner asks to count as the same question. */
export const GOAL_ASK_DEDUP_THRESHOLD = 0.5;

/** How many of the goal's most recent open owner asks are compared. */
export const GOAL_ASK_DEDUP_CANDIDATE_LIMIT = 50;

export interface GoalAskCandidate {
  conversationId: string;
  askerId: string;
  title: string;
  goalId: string;
}

export interface GoalAskOverlap {
  goalId: string;
  conversationId: string;
  askerId: string;
  similarity: number;
  /** True when the open ask was opened by the caller itself. */
  sameAsker: boolean;
}

/**
 * The outcome of the dedup check, reported on every `coord:ask-owner` result
 * so a caller can tell "no overlap" from "not measured".
 */
export type GoalAskDedupOutcome =
  | { status: 'explicit-supersede' }
  | { status: 'not-in-goal' }
  | { status: 'no-overlap'; goalId: string; compared: number }
  | { status: 'superseded'; goalId: string; conversationId: string; similarity: number }
  | { status: 'joined'; goalId: string; conversationId: string; askerId: string; similarity: number }
  | { status: 'unmeasured'; error: string };

/**
 * Pick the open ask that overlaps `question` most strongly, at or above the
 * threshold. A tie keeps the earlier candidate (callers pass newest first, so
 * the newest overlapping ask wins). Pure — exported for tests.
 */
export function pickOverlappingGoalAsk(args: {
  question: string;
  callerId: string;
  candidates: GoalAskCandidate[];
  threshold?: number;
}): GoalAskOverlap | null {
  const threshold = args.threshold ?? GOAL_ASK_DEDUP_THRESHOLD;
  const asked = titleTokens(args.question);
  let best: GoalAskOverlap | null = null;
  for (const c of args.candidates) {
    const similarity = jaccardSimilarity(asked, titleTokens(c.title));
    if (similarity < threshold) continue;
    if (best && similarity <= best.similarity) continue;
    best = {
      goalId: c.goalId,
      conversationId: c.conversationId,
      askerId: c.askerId,
      similarity,
      sameAsker: c.askerId === args.callerId,
    };
  }
  return best;
}

export interface GoalAskCandidateRead {
  /** The caller's goal, or null when the caller's session belongs to no goal. */
  goalId: string | null;
  candidates: GoalAskCandidate[];
}

/**
 * The caller's goal (`session_briefs.goal_id`) and that goal lineage's open
 * `coord:ask-owner` questions, newest first. The lineage is every session whose
 * brief carries the same goal id in the same workspace.
 */
export async function readGoalAskCandidates(args: {
  workspaceId: string;
  ownerId: string;
  limit?: number;
  sql?: Sql;
}): Promise<GoalAskCandidateRead> {
  const sql = args.sql ?? getOrgPg().sql;
  const limit = args.limit ?? GOAL_ASK_DEDUP_CANDIDATE_LIMIT;
  const mine = await sql<{ goal_id: string | null }[]>`
    SELECT goal_id FROM harness_shared.session_briefs
     WHERE workspace_id = ${args.workspaceId} AND owner_id = ${args.ownerId}
     LIMIT 1`;
  const goalId = mine[0]?.goal_id ?? null;
  if (!goalId) return { goalId: null, candidates: [] };
  const rows = await sql<{ id: string; asker_id: string; title: string | null }[]>`
    SELECT c.id, c.asker_id, c.title
      FROM harness_shared.coord_conversations c
      JOIN harness_shared.session_briefs sb
        ON sb.owner_id = c.asker_id AND sb.workspace_id = c.workspace_id
     WHERE c.workspace_id = ${args.workspaceId}
       AND c.kind = 'question'
       AND c.state = 'open'
       AND c.producer = 'coord:ask-owner'
       AND sb.goal_id = ${goalId}
     ORDER BY c.created_at DESC
     LIMIT ${limit}`;
  return {
    goalId,
    candidates: rows.map((r) => ({ conversationId: r.id, askerId: r.asker_id, title: r.title ?? '', goalId })),
  };
}

/**
 * Production resolver behind `CoordOpCaps.findOverlappingGoalAsk`: the goal of
 * the caller plus the overlapping open ask, if any.
 */
export async function findOverlappingGoalAsk(args: {
  workspaceId: string;
  ownerId: string;
  question: string;
  sql?: Sql;
}): Promise<{ goalId: string | null; compared: number; overlap: GoalAskOverlap | null }> {
  const read = await readGoalAskCandidates({ workspaceId: args.workspaceId, ownerId: args.ownerId, sql: args.sql });
  if (!read.goalId) return { goalId: null, compared: 0, overlap: null };
  return {
    goalId: read.goalId,
    compared: read.candidates.length,
    overlap: pickOverlappingGoalAsk({ question: args.question, callerId: args.ownerId, candidates: read.candidates }),
  };
}
