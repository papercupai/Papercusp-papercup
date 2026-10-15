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
 *   - a cited turn whose origin verdict is not owner speech (an assistant turn, a
 *     machine-injected loop fire recorded with speaker 'user', an unknown origin) is
 *     dropped and listed in `excludedRefs`.
 *
 * Pure: the caller resolves the cited refs to turns (fetchSourceTurns) and passes them in.
 */
import { isOwnerTurnVerdict, type SourceTurn } from './activation-item-provenance';
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
  ownerTurns: BlindReviewBriefTurn[];
  excludedRefs: Array<{ ref: string; reason: 'not-owner' | 'unresolved' }>;
  /** The kickoff text handed to the reviewer. */
  text: string;
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
  const excludedRefs: BlindReviewBrief['excludedRefs'] = [];
  for (const ref of refs) {
    const turn = input.turns.get(ref);
    if (!turn || turn.text == null) {
      excludedRefs.push({ ref, reason: 'unresolved' });
    } else if (!isOwnerTurnVerdict(turn.verdict)) {
      excludedRefs.push({ ref, reason: 'not-owner' });
    } else {
      ownerTurns.push({ ref, text: turn.text });
    }
  }
  const seq = input.activation.auditSeq;
  const header = [
    `Blind gap review for plan '${input.planSlug}' (activation audit #${seq}).`,
    '',
    'Below are the owner\'s own words that asked for this work. Run the product and judge whether it does what',
    'they asked. Record every gap you find: something they asked for that is missing, wrong, or only partly done.',
    '',
    `Do NOT read this plan, its specs, rubric, scorecards or evidence: any plans:/rubrics:/scorecards:/acceptance:`,
    `call naming '${input.planSlug}' before your post disqualifies the review.`,
    '',
    `Post with: plans:blind-review { slug: '${input.planSlug}', op: 'post', activationAuditSeq: ${seq},`,
    "  gaps: [{ text: '<one gap per entry>' }] }   (gaps: [] when you found none).",
    '',
    `Owner turns (${ownerTurns.length}):`,
  ];
  const body = ownerTurns.map((t, i) => `\n--- owner turn ${i + 1} (${t.ref}) ---\n${t.text}`);
  return {
    planSlug: input.planSlug,
    activationAuditSeq: seq,
    ownerTurns,
    excludedRefs,
    text: header.join('\n') + body.join('\n'),
  };
}
