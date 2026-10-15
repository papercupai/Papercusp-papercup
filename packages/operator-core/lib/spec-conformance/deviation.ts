/**
 * Spec deviation transaction (R-17, plan spec-driven-tooling-integration-2026-10-05
 * P-028; formerly spec-conformance-loop-2026-10-14#P-020).
 *
 * A requirement that cannot (or should no longer) be met is not silently ignored and
 * not quietly closed: someone PROPOSES a deviation and someone with the right
 * authority APPROVES it. Both halves are ordinary plan Decisions — the durable,
 * cross-lane ruling surface — each carrying one fenced `deviation` JSON block, so the
 * conformance run (drift-alarm suppression), the closure guard and the retro-fit
 * report all read the same machine record instead of interpreting prose.
 *
 * Authority follows the requirement's PROVENANCE: a requirement whose
 * `intent.sourceRefs` cites the owner (an owner turn, an owner directive) can only be
 * deviated from with an owner turn the turn-provenance ledger verifies as the owner
 * speaking. An agent-sourced requirement can be deviated from on agent authority.
 *
 * Integrity: the `deviation` fence is RESERVED to this transaction. plans:add-decision
 * and plans:set-decision-body refuse a body carrying one (see
 * {@link containsDeviationFence}), and {@link approvedDeviations} re-derives
 * owner-sourcing from the CURRENT requirement text rather than trusting the flag
 * recorded on the approval — so neither a hand-authored block nor a later edit that
 * adds an owner source ref can launder an agent approval into an owner one.
 *
 * Everything here is pure or dependency-injected; the production adapters live in
 * the `plans:conformance` tool.
 */
import { z } from 'zod';
import { splitPlanSections } from '../agent-tools/plans/plan-sections';

export const DEVIATION_FENCE = 'deviation';

const REQUIREMENT_KEY = /^R-\d+$/;
const DECISION_ID = /^D-\d{3,}$/;

/** Verdicts that mean a turn really was the human owner (mirrors OWNER_TURN_VERDICTS). */
export const OWNER_TURN_VERDICT_SET: ReadonlySet<string> = new Set(['owner-typed', 'owner-turn', 'owner-dialog']);

export const deviationProposalSchema = z
  .object({
    op: z.literal('propose'),
    requirement: z.string().regex(REQUIREMENT_KEY),
    reason: z.string().trim().min(1).max(2000),
    proposedBy: z.string().trim().min(1).max(200),
  })
  .strict();

export const deviationApprovalSchema = z
  .object({
    op: z.literal('approve'),
    requirement: z.string().regex(REQUIREMENT_KEY),
    /** The D-NNN of the proposal this approves. */
    proposal: z.string().regex(DECISION_ID),
    approvedBy: z.string().trim().min(1).max(200),
    /** Owner-sourcing of the requirement as judged at approval time (informational). */
    ownerSourced: z.boolean(),
    ownerTurnRef: z.string().trim().min(1).max(300).optional(),
    /** The turn-provenance verdict the ref resolved to at approval time. */
    ownerTurnVerdict: z.string().trim().min(1).max(60).optional(),
  })
  .strict();

export const deviationBlockSchema = z.discriminatedUnion('op', [deviationProposalSchema, deviationApprovalSchema]);

export type DeviationProposal = z.infer<typeof deviationProposalSchema>;
export type DeviationApproval = z.infer<typeof deviationApprovalSchema>;
export type DeviationBlock = z.infer<typeof deviationBlockSchema>;

export interface DeviationRecord {
  decisionId: string;
  block: DeviationBlock;
}

export interface DeviationParseProblem {
  decisionId: string;
  detail: string;
}

const FENCE_RE = /```([A-Za-z0-9_-]*)[^\n]*\n([\s\S]*?)\n```/g;

/** True when a decision body carries a fenced `deviation` block (reserved fence). */
export function containsDeviationFence(text: string): boolean {
  for (const match of text.matchAll(FENCE_RE)) {
    if (match[1] === DEVIATION_FENCE) return true;
  }
  return false;
}

function sectionBody(planContent: string, heading: string): string | null {
  return (
    splitPlanSections(planContent).find(
      (section) => section.heading.trim().toLowerCase() === heading.toLowerCase(),
    )?.body ?? null
  );
}

/** Every `deviation` block recorded under `## Decisions`, keyed to its decision. */
export function parseDeviationRecords(planContent: string): {
  records: DeviationRecord[];
  problems: DeviationParseProblem[];
} {
  const body = sectionBody(planContent, 'Decisions') ?? '';
  const records: DeviationRecord[] = [];
  const problems: DeviationParseProblem[] = [];
  const heads = [...body.matchAll(/^###\s+(D-\d{3,})\b.*$/gm)];
  heads.forEach((head, index) => {
    const decisionId = head[1]!;
    const start = head.index! + head[0].length;
    const end = index + 1 < heads.length ? heads[index + 1]!.index! : body.length;
    const chunk = body.slice(start, end);
    for (const fence of chunk.matchAll(FENCE_RE)) {
      if (fence[1] !== DEVIATION_FENCE) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(fence[2]!);
      } catch (error) {
        problems.push({ decisionId, detail: `deviation block is not valid JSON: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
      const parsed = deviationBlockSchema.safeParse(raw);
      if (!parsed.success) {
        problems.push({
          decisionId,
          detail: `deviation block invalid: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'} ${issue.message}`).join('; ')}`,
        });
        continue;
      }
      records.push({ decisionId, block: parsed.data });
    }
  });
  return { records, problems };
}

/**
 * `intent.sourceRefs` per requirement key, read straight from each `**R-N — …**`
 * requirement fence. Unparseable blocks are skipped here — the BAR seed already
 * refuses them with a precise diagnostic.
 */
export function requirementSourceRefs(planContent: string): Map<string, string[]> {
  const body = sectionBody(planContent, 'Requirements') ?? '';
  const out = new Map<string, string[]>();
  for (const match of body.matchAll(/^\*\*(R-\d+)\b[^\n]*\n```requirement[^\n]*\n([\s\S]*?)\n```/gm)) {
    const key = match[1]!;
    try {
      const parsed = JSON.parse(match[2]!) as { intent?: { sourceRefs?: unknown } };
      const refs = parsed.intent?.sourceRefs;
      out.set(key, Array.isArray(refs) ? refs.filter((ref): ref is string => typeof ref === 'string') : []);
    } catch {
      out.set(key, []);
    }
  }
  return out;
}

/**
 * Does this source ref cite the OWNER? Deliberately inclusive: a requirement whose
 * provenance is ambiguous between owner and agent is treated as owner-sourced, because
 * the costly error (R-17's falsifier) is an agent approving away an owner requirement,
 * while the cheap error is asking the owner once more. Plan-item (`P-006`) and decision
 * (`D-021 §1`) refs are agent-authored structure, not owner speech.
 */
export function isOwnerSourceRef(ref: string): boolean {
  const value = ref.trim();
  if (/^(?:[a-z0-9-]+#)?[PD]-\d{3,}\b/i.test(value)) return false;
  return (
    /^session_turn:/i.test(value) ||
    /\[turn:/i.test(value) ||
    /\[owner:/i.test(value) ||
    /\bowner\b/i.test(value) ||
    /\bdirective\s*#\d+/i.test(value)
  );
}

export function isOwnerSourcedRequirement(planContent: string, requirement: string): boolean {
  return (requirementSourceRefs(planContent).get(requirement) ?? []).some(isOwnerSourceRef);
}

export function requirementKeys(planContent: string): Set<string> {
  return new Set(requirementSourceRefs(planContent).keys());
}

export interface ApprovedDeviation {
  requirement: string;
  proposal: string;
  approval: string;
}

/**
 * Requirements carrying a VALID approved deviation. Valid means: the approval names an
 * existing proposal Decision for the same requirement, and — when the requirement is
 * owner-sourced in the CURRENT plan text — the approval records an owner turn ref whose
 * recorded verdict is an owner verdict.
 */
export function approvedDeviationList(planContent: string): ApprovedDeviation[] {
  const { records } = parseDeviationRecords(planContent);
  const proposals = new Map<string, DeviationProposal>();
  for (const record of records) {
    if (record.block.op === 'propose') proposals.set(record.decisionId, record.block);
  }
  const out: ApprovedDeviation[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const block = record.block;
    if (block.op !== 'approve') continue;
    const proposal = proposals.get(block.proposal);
    if (!proposal || proposal.requirement !== block.requirement) continue;
    if (isOwnerSourcedRequirement(planContent, block.requirement)) {
      if (!block.ownerTurnRef || !block.ownerTurnVerdict || !OWNER_TURN_VERDICT_SET.has(block.ownerTurnVerdict)) continue;
    }
    if (seen.has(block.requirement)) continue;
    seen.add(block.requirement);
    out.push({ requirement: block.requirement, proposal: block.proposal, approval: record.decisionId });
  }
  return out;
}

export function approvedDeviations(planContent: string): Set<string> {
  return new Set(approvedDeviationList(planContent).map((entry) => entry.requirement));
}

// ── The transaction ──────────────────────────────────────────────────────────

export interface OwnerTurnVerification {
  verified: boolean;
  verdict: string | null;
  detail: string;
}

export interface AppendDecisionInput {
  slug: string;
  title: string;
  body: string;
  refs: string[];
}

export type AppendDecisionResult =
  | { ok: true; decisionId: string; ref: string }
  | { ok: false; error: string; message?: string };

export interface DeviationDeps {
  readPlanContent(slug: string): Promise<string | null>;
  verifyOwnerTurn(ref: string): Promise<OwnerTurnVerification>;
  appendDecision(input: AppendDecisionInput): Promise<AppendDecisionResult>;
}

export type DeviationRefusalCode =
  | 'plan_not_found'
  | 'deviation_requirement_unknown'
  | 'deviation_already_approved'
  | 'deviation_proposal_unknown'
  | 'deviation_proposal_mismatch'
  | 'deviation_owner_turn_required'
  | 'deviation_owner_turn_unverified'
  | 'deviation_decision_write_failed';

export type DeviationResult =
  | {
      ok: true;
      op: 'propose-deviation' | 'approve-deviation';
      slug: string;
      requirement: string;
      decisionId: string;
      ref: string;
      ownerSourced: boolean;
      next: string;
    }
  | { ok: false; error: DeviationRefusalCode; message: string; slug: string; requirement: string; [key: string]: unknown };

function refuse(
  slug: string,
  requirement: string,
  error: DeviationRefusalCode,
  message: string,
  extra: Record<string, unknown> = {},
): DeviationResult {
  return { ok: false, error, message, slug, requirement, ...extra };
}

function fenced(block: DeviationBlock): string {
  return '```' + DEVIATION_FENCE + '\n' + JSON.stringify(block, null, 2) + '\n```';
}

export interface ProposeDeviationInput {
  slug: string;
  requirement: string;
  reason: string;
  actor: string;
}

export async function proposeDeviation(input: ProposeDeviationInput, deps: DeviationDeps): Promise<DeviationResult> {
  const { slug, requirement } = input;
  const content = await deps.readPlanContent(slug);
  if (content === null) return refuse(slug, requirement, 'plan_not_found', `plan ${slug} not found`);
  if (!requirementKeys(content).has(requirement)) {
    return refuse(slug, requirement, 'deviation_requirement_unknown', `${requirement} is not a requirement block under ## Requirements in ${slug}`);
  }
  const existing = approvedDeviationList(content).find((entry) => entry.requirement === requirement);
  if (existing) {
    return refuse(slug, requirement, 'deviation_already_approved',
      `${requirement} already has an approved deviation (${slug}#${existing.approval} approving ${slug}#${existing.proposal})`,
      { approval: existing.approval, proposal: existing.proposal });
  }
  const ownerSourced = isOwnerSourcedRequirement(content, requirement);
  const block: DeviationProposal = { op: 'propose', requirement, reason: input.reason.trim(), proposedBy: input.actor };
  const written = await deps.appendDecision({
    slug,
    title: `Deviation proposed for ${requirement}`,
    body: `${input.reason.trim()}\n\n${fenced(block)}`,
    refs: [requirement],
  });
  if (!written.ok) {
    return refuse(slug, requirement, 'deviation_decision_write_failed', written.message ?? written.error, { cause: written.error });
  }
  return {
    ok: true,
    op: 'propose-deviation',
    slug,
    requirement,
    decisionId: written.decisionId,
    ref: written.ref,
    ownerSourced,
    next: ownerSourced
      ? `${requirement} is owner-sourced: approve with plans:conformance { op:'approve-deviation', proposal:'${written.decisionId}', ownerTurnRef:'[turn:…]' } citing the owner turn that approves it.`
      : `approve with plans:conformance { op:'approve-deviation', proposal:'${written.decisionId}' }.`,
  };
}

export interface ApproveDeviationInput {
  slug: string;
  requirement: string;
  proposal: string;
  actor: string;
  ownerTurnRef?: string;
}

export async function approveDeviation(input: ApproveDeviationInput, deps: DeviationDeps): Promise<DeviationResult> {
  const { slug, requirement, proposal } = input;
  const content = await deps.readPlanContent(slug);
  if (content === null) return refuse(slug, requirement, 'plan_not_found', `plan ${slug} not found`);
  if (!requirementKeys(content).has(requirement)) {
    return refuse(slug, requirement, 'deviation_requirement_unknown', `${requirement} is not a requirement block under ## Requirements in ${slug}`);
  }
  const { records } = parseDeviationRecords(content);
  const proposalRecord = records.find((record) => record.decisionId === proposal && record.block.op === 'propose');
  if (!proposalRecord) {
    return refuse(slug, requirement, 'deviation_proposal_unknown',
      `${slug}#${proposal} is not a deviation proposal; record one with plans:conformance { op:'propose-deviation' } first`);
  }
  if (proposalRecord.block.requirement !== requirement) {
    return refuse(slug, requirement, 'deviation_proposal_mismatch',
      `${slug}#${proposal} proposes a deviation for ${proposalRecord.block.requirement}, not ${requirement}`);
  }
  const existing = approvedDeviationList(content).find((entry) => entry.requirement === requirement);
  if (existing) {
    return refuse(slug, requirement, 'deviation_already_approved',
      `${requirement} already has an approved deviation (${slug}#${existing.approval})`,
      { approval: existing.approval, proposal: existing.proposal });
  }

  const ownerSourced = isOwnerSourcedRequirement(content, requirement);
  let ownerTurnVerdict: string | undefined;
  if (ownerSourced) {
    if (!input.ownerTurnRef) {
      return refuse(slug, requirement, 'deviation_owner_turn_required',
        `${requirement} is owner-sourced (intent.sourceRefs: ${(requirementSourceRefs(content).get(requirement) ?? []).join(', ')}); ` +
          'approving a deviation needs ownerTurnRef — the [turn:…] anchor of the owner turn that approves it. Ask the owner (coord:ask-owner) and cite their answer.');
    }
    const verification = await deps.verifyOwnerTurn(input.ownerTurnRef);
    if (!verification.verified || !verification.verdict || !OWNER_TURN_VERDICT_SET.has(verification.verdict)) {
      return refuse(slug, requirement, 'deviation_owner_turn_unverified',
        `ownerTurnRef ${input.ownerTurnRef} did not verify as an owner turn (${verification.verdict ?? 'unresolved'}): ${verification.detail}`,
        { ownerTurnRef: input.ownerTurnRef, verdict: verification.verdict });
    }
    ownerTurnVerdict = verification.verdict;
  }

  const block: DeviationApproval = {
    op: 'approve',
    requirement,
    proposal,
    approvedBy: input.actor,
    ownerSourced,
    ...(ownerSourced && input.ownerTurnRef ? { ownerTurnRef: input.ownerTurnRef } : {}),
    ...(ownerTurnVerdict ? { ownerTurnVerdict } : {}),
  };
  const authority = ownerSourced ? `owner approval ${input.ownerTurnRef}` : `agent approval by ${input.actor}`;
  const written = await deps.appendDecision({
    slug,
    title: `Deviation approved for ${requirement}`,
    body: `Approves the deviation proposed in ${slug}#${proposal} (${authority}).\n\n${fenced(block)}`,
    refs: [requirement, proposal],
  });
  if (!written.ok) {
    return refuse(slug, requirement, 'deviation_decision_write_failed', written.message ?? written.error, { cause: written.error });
  }
  return {
    ok: true,
    op: 'approve-deviation',
    slug,
    requirement,
    decisionId: written.decisionId,
    ref: written.ref,
    ownerSourced,
    next: `${requirement}'s drift alarm is suppressed and closure no longer requires it green; the conformance run picks this up on its next pass.`,
  };
}
