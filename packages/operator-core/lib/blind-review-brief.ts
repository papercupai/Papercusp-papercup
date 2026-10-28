/**
 * The blind gap reviewer's brief (verification-system-improvements-2026-10-10 P-006,
 * D-006, D-039 (6); clause SPEC-P-006-BLIND-BRIEF).
 *
 * A blind reviewer judges whether the shipped product does what the OWNER asked, without
 * the plan's framing. Its brief is therefore built from ONE source only: the owner's own
 * turns cited by the plan's latest activation audit. Everything an agent wrote is left
 * out, on purpose:
 *
 *   - `mappings[].requirement` is the auditor's paraphrase of a turn, so it carries the
 *     plan's framing. Only `mappings[].sourceRefs` is read.
 *   - the plan body, its specs, rubric, scorecards and bound evidence are never inputs.
 *     The builder does not take them as parameters, so it cannot leak them.
 *   - a cited turn an agent wrote (an assistant turn, or a machine-injected loop fire /
 *     wake / synthetic turn recorded with speaker 'user') is dropped and listed in
 *     `excludedRefs`.
 *
 * A user turn whose authorship was never established (verdict `unknown` — most predate
 * turn-origin stamping) is CARRIED, labelled as unverified, in `unverifiedTurns`. Owner
 * directive #2499 (2026-10-27) removed the rule that refused a reviewer unless the owner
 * re-typed their requirements in an authenticated turn: an unverified user turn is far
 * more likely the owner's words than not, and refusing it only made the owner repeat
 * themselves. Verified agent-origin text still never reaches the reviewer.
 *
 * Pure: the caller resolves the cited refs to turns (fetchSourceTurns) and passes them in.
 */
import { isOwnerTurnVerdict, parseOrderSourceRef, type SourceTurn } from './activation-item-provenance';
import { parseTurnRef } from './agent-tools/sessions/_shared';

/** The only part of an activation audit payload the brief reads. */
export interface BlindReviewActivationInput {
  auditSeq: number;
  mappings: ReadonlyArray<{ sourceRefs?: readonly string[] | null }>;
}

export interface BlindReviewBriefTurn {
  ref: string;
  text: string;
}

export interface BlindReviewBrief {
  planSlug: string;
  activationAuditSeq: number;
  /** User turns with an affirmative owner verdict (owner-typed / owner-turn / owner-dialog). */
  ownerTurns: BlindReviewBriefTurn[];
  /** User turns whose authorship was never established (verdict `unknown`); carried, labelled. */
  unverifiedTurns: BlindReviewBriefTurn[];
  /** `not-owner` = an assistant or verified agent-origin turn; `unresolved` = no readable text. */
  excludedRefs: Array<{ ref: string; reason: 'not-owner' | 'unresolved' }>;
  /** The kickoff text handed to the reviewer. */
  text: string;
}

/** A user-speaker turn the classifier could not attribute either way: no owner stamp and
 *  no agent-origin envelope. Verified agent origins (agent-injected, machine-surface,
 *  synthetic) and assistant turns (not-user-turn) are never this. */
export function isUnverifiedUserTurn(turn: Pick<SourceTurn, 'speaker' | 'verdict'>): boolean {
  return turn.speaker === 'user' && turn.verdict === 'unknown';
}

/** Turns a blind brief carries (verified owner plus unverified user turns). */
export function briefTurnCount(brief: Pick<BlindReviewBrief, 'ownerTurns' | 'unverifiedTurns'>): number {
  return brief.ownerTurns.length + brief.unverifiedTurns.length;
}

function refOrder(ref: string): [string, string, number] {
  const parsed = parseTurnRef(ref);
  return parsed ? [parsed.sourceKind, parsed.sessionId, parsed.turnIdx] : ['~', ref, 0];
}

function compareRefs(a: string, b: string): number {
  const [ak, as, ai] = refOrder(a);
  const [bk, bs, bi] = refOrder(b);
  if (ak !== bk) return ak < bk ? -1 : 1;
  if (as !== bs) return as < bs ? -1 : 1;
  return ai - bi;
}

export function buildBlindReviewBrief(input: {
  planSlug: string;
  activation: BlindReviewActivationInput;
  turns: ReadonlyMap<string, SourceTurn>;
}): BlindReviewBrief {
  const refs = [...new Set(input.activation.mappings.flatMap((m) => m.sourceRefs ?? []))].sort(compareRefs);
  const ownerTurns: BlindReviewBriefTurn[] = [];
  const unverifiedTurns: BlindReviewBriefTurn[] = [];
  const carried: Array<BlindReviewBriefTurn & { unverified: boolean }> = [];
  const excludedRefs: BlindReviewBrief['excludedRefs'] = [];
  for (const ref of refs) {
    const turn = input.turns.get(ref);
    if (!turn || turn.text == null) {
      excludedRefs.push({ ref, reason: 'unresolved' });
    } else if (isOwnerTurnVerdict(turn.verdict)) {
      ownerTurns.push({ ref, text: turn.text });
      carried.push({ ref, text: turn.text, unverified: false });
    } else if (isUnverifiedUserTurn(turn) && parseOrderSourceRef(ref) == null) {
      // An `order:<id>` row is never "authorship unknown": it is owner speech only
      // when the hook captured it, and otherwise an agent relay (orderRowVerdict).
      // Carrying a relay as "treat as the owner's words" would brief the reviewer
      // with agent text, so it falls through to the not-owner exclusion below.
      unverifiedTurns.push({ ref, text: turn.text });
      carried.push({ ref, text: turn.text, unverified: true });
    } else {
      excludedRefs.push({ ref, reason: 'not-owner' });
    }
  }
  const seq = input.activation.auditSeq;
  const header = [
    `Blind gap review for plan '${input.planSlug}' (activation audit #${seq}).`,
    '',
    'Below are the owner\'s own words that asked for this work. Run the product and judge whether it does what',
    'they asked. Record every gap you find: something they asked for that is missing, wrong, or only partly done.',
    ...(unverifiedTurns.length ? [
      'Turns marked "origin unverified" were recorded as user turns but their authorship was never established',
      '(most predate turn-origin stamping). Treat them as the owner\'s words unless their text plainly is not.',
    ] : []),
    '',
    `Do NOT read this plan, its specs, rubric, scorecards or evidence: any plans:/rubrics:/scorecards:/acceptance:`,
    `call naming '${input.planSlug}' before your post disqualifies the review.`,
    '',
    `Post with: plans:blind-review { slug: '${input.planSlug}', op: 'post', activationAuditSeq: ${seq},`,
    "  outcome: 'conclusive' | 'inconclusive', gaps: [{ text: '<one gap per entry>' }] } (gaps: [] when none).",
    "Use conclusive only after completing the product review. If access or verification is blocked or incomplete,",
    "post inconclusive even when gaps are empty; an inconclusive receipt cannot satisfy acceptance.",
    '',
    `Owner turns (${carried.length}${unverifiedTurns.length ? `, ${unverifiedTurns.length} origin unverified` : ''}):`,
  ];
  const body = carried.map((t, i) =>
    `\n--- owner turn ${i + 1}${t.unverified ? ' — origin unverified' : ''} (${t.ref}) ---\n${t.text}`);
  return {
    planSlug: input.planSlug,
    activationAuditSeq: seq,
    ownerTurns,
    unverifiedTurns,
    excludedRefs,
    text: header.join('\n') + body.join('\n'),
  };
}
