/**
 * EI-20249725405239230 — the acceptance-grading no-claim guarantee.
 *
 * WHAT THIS GUARDS, and why a weaker assertion would be worthless. The measured
 * failure was not that a grader was unavailable: it was that the recruited peer
 * DECLINED TWICE, reasoning that a grading request matches no fleet claim spec
 * and so is structurally inadmissible to them. That reasoning is false —
 * `scorecards:emit` declares `capability: 'coord:write'` with
 * `requirePrincipal: false` and gates on no claim, no assignee and no fleet
 * admission — but nothing in the copy said so, and a phantom floor is
 * indistinguishable from a real one to the agent holding it.
 *
 * The briefs already pre-empt the OTHER decline reason ("do not decline solely
 * for lack of prior context"). These tests pin the second one to every path a
 * grader can be reached through, and pin the author-facing refusals that tell a
 * plan author to go find a grader by hand.
 *
 * FALSIFIABILITY. Each test asserts on rendered output containing the
 * single-sourced constant, so deleting the constant from any one render fails
 * that render's test specifically rather than the whole file at import time.
 * The single-sourcing test asserts the gate and the briefs share one string, so
 * re-inlining a divergent copy of the sentence in either place fails.
 */
import { describe, expect, it } from 'vitest';
import type { CascadeSelectionEntry, CascadeWakeContext } from './cascade-core';
import {
  ACCEPTANCE_GRADING_NO_CLAIM_FACT,
  ACCEPTANCE_GRADING_NO_CLAIM_GUIDANCE,
  ACCEPTANCE_GRADING_BAR_SCOPE_GUIDANCE,
  buildAssignedAcceptanceGraderBrief,
  buildMinimumFillAcceptanceGraderBrief,
  gradingCascadeWakeCopy,
  sourceAuditCascadeMetaFromRouting,
  sourceAuditWakeCopy,
  goalTenureGradingMetaFromRouting,
  goalTenureGradingWakeCopy,
  type SourceAuditCascadeMeta,
  type GradingCascadeMeta,
} from './grading-cascade';
import { acceptanceReviewTargetConditionKey } from '../coord/condition-upsert';
import { cascadeWakeCopyForRouting } from './cascade-core';

describe('goal tenure residual grading copy', () => {
  const meta = { flavor: 'goal-tenure-grading' as const, workspaceId: 'ws', goalId: 'goal', holderOwnerIds: ['su-holder'] };
  it('preserves the grading contract on recovery instead of asking for a transcript answer', () => {
    expect(goalTenureGradingMetaFromRouting(JSON.stringify({ cascade: meta }))).toEqual(meta);
    expect(goalTenureGradingMetaFromRouting({ cascade: { ...meta, holderOwnerIds: [] } })).toBeNull();
    const initial = goalTenureGradingWakeCopy(meta, 'conv-tenure');
    expect(cascadeWakeCopyForRouting({ cascade: meta })(wakeCtx({ conversationId: 'conv-tenure' }))).toEqual(initial);
    expect(initial.body).toContain('terminal:true');
    expect(initial.body).toContain('supersede its current goal-grading-computed provisional card');
    expect(initial.body).toContain('if it is no longer active, decline and stop');
    expect(initial.body).toContain('Never count a provisional card, consult reply, or audit as settled grading');
    expect(initial.body).not.toContain('Answer FROM the transcript');
  });
});

const META: GradingCascadeMeta = {
  flavor: 'acceptance-grading',
  planSlug: 'some-plan-2026-09-05',
  rubricId: 'rubric-abc',
  harnessSlug: 'papercusp',
};

const NEXT: CascadeSelectionEntry = {
  ownerId: 'su-grader',
  via: 'floor',
  score: 0.71,
  relevance: 0.74,
  similarity: 0.64,
  liveness: 'live',
};

const wakeCtx = (over: Partial<CascadeWakeContext> = {}): CascadeWakeContext => ({
  question: 'grade it',
  conversationId: 'conv-1',
  position: 2,
  menuSize: 2,
  next: NEXT,
  digest: [],
  ...over,
});

const TARGET = {
  workspaceId: 'ws-test',
  harnessSlug: 'papercusp',
  planSlug: 'plan-a',
  rubricId: 'rubric-a',
  revision: 3,
} as const;

const RESERVATION = {
  conditionKey: acceptanceReviewTargetConditionKey(TARGET),
  id: 'WI-review-a',
};

const SOURCE_AUDIT: SourceAuditCascadeMeta = {
  flavor: 'grading-integrity',
  issueId: 'EI-source-audit',
  reservationKey: 'grading-audit:EI-source-audit',
  reservationReservedAt: '2026-09-23T18:00:00.000Z',
  brief: 'Audit the frozen source evidence.',
};

describe('acceptance review-target reservation identity', () => {
  it('reuses one key for the same typed target and separates revisions', () => {
    expect(acceptanceReviewTargetConditionKey({ ...TARGET })).toBe(RESERVATION.conditionKey);
    expect(acceptanceReviewTargetConditionKey({ ...TARGET, revision: 4 })).not.toBe(RESERVATION.conditionKey);
    expect(acceptanceReviewTargetConditionKey({ ...TARGET, planSlug: 'plan-b' })).not.toBe(RESERVATION.conditionKey);
  });

  it('carries the reservation key and canonical id through every grader brief path', () => {
    expect(buildAssignedAcceptanceGraderBrief(TARGET.planSlug, TARGET.harnessSlug, TARGET.rubricId, RESERVATION)).toEqual(
      expect.stringContaining(RESERVATION.conditionKey),
    );
    expect(buildAssignedAcceptanceGraderBrief(TARGET.planSlug, TARGET.harnessSlug, TARGET.rubricId, RESERVATION)).toContain(
      RESERVATION.id,
    );
    expect(buildMinimumFillAcceptanceGraderBrief(TARGET.planSlug, TARGET.harnessSlug, TARGET.rubricId, RESERVATION)).toContain(
      RESERVATION.conditionKey,
    );
    expect(gradingCascadeWakeCopy({ flavor: 'acceptance-grading', ...TARGET, reservation: RESERVATION })(wakeCtx()).body).toContain(
      RESERVATION.id,
    );
  });
});

describe('acceptance-grading no-claim guidance (EI-20249725405239230)', () => {
  it('states the fact affirmatively rather than only naming the tool', () => {
    // The pre-fix copy already named scorecards:emit; naming the tool is what
    // FAILED to prevent the decline. What was missing is the claim/admission
    // guarantee, so assert on that, not on the tool name.
    expect(ACCEPTANCE_GRADING_NO_CLAIM_FACT).toMatch(/no work-item claim/i);
    expect(ACCEPTANCE_GRADING_NO_CLAIM_FACT).toMatch(/no fleet-scope admission/i);
    expect(ACCEPTANCE_GRADING_NO_CLAIM_FACT).toMatch(/not a reason to decline/i);
  });

  it('carries the fact into the grader-facing rendering', () => {
    expect(ACCEPTANCE_GRADING_NO_CLAIM_GUIDANCE).toContain(ACCEPTANCE_GRADING_NO_CLAIM_FACT);
  });

  // All three grader-facing paths render through graderReadingInstructions.
  // They are asserted SEPARATELY so a future refactor that gives one path its
  // own copy cannot pass on the strength of the other two.
  it('reaches a router-selected (assigned) grader', () => {
    const brief = buildAssignedAcceptanceGraderBrief(META.planSlug, META.harnessSlug, META.rubricId);
    expect(brief).toContain(ACCEPTANCE_GRADING_NO_CLAIM_FACT);
  });

  it('reaches a below-floor minimum-fill grader', () => {
    const brief = buildMinimumFillAcceptanceGraderBrief(META.planSlug, META.harnessSlug, META.rubricId);
    expect(brief).toContain(ACCEPTANCE_GRADING_NO_CLAIM_FACT);
  });

  it('reaches grader k+1 woken by a cascade advance', () => {
    const copy = gradingCascadeWakeCopy(META)(wakeCtx());
    expect(copy.body).toContain(ACCEPTANCE_GRADING_NO_CLAIM_FACT);
  });

  it('reaches a cascade grader woken by expiry with no prior card', () => {
    // The expiry/decline triggers are generic and render from the persisted row,
    // so this is the path most likely to silently lose flavour-specific copy.
    const copy = gradingCascadeWakeCopy(META)(wakeCtx({ digest: [], next: { ...NEXT, via: 'minimum' } }));
    expect(copy.body).toContain(ACCEPTANCE_GRADING_NO_CLAIM_FACT);
  });

  it('renders for a harness-less plan without dropping the guarantee', () => {
    const brief = buildAssignedAcceptanceGraderBrief(META.planSlug, null, META.rubricId);
    expect(brief).toContain(ACCEPTANCE_GRADING_NO_CLAIM_FACT);
  });

  /**
   * FALSIFIABILITY CONTROL (repo tier-2: a deliberately-wrong implementation
   * kept permanently in the test file, rather than mutating the shared tree).
   *
   * Every assertion above is `toContain(FACT)`, which goes VACUOUS if FACT is
   * ever emptied or whitespaced — `toContain('')` is true of every string, so
   * the suite would stay green while the guarantee had silently vanished from
   * all five paths. This control pins the discriminating power itself: the
   * PRE-FIX copy is verbatim what the briefs rendered before EI-20249725405239230,
   * and it must NOT satisfy the assertion the other tests rely on.
   */
  it('control: the assertion discriminates — pre-fix copy does not satisfy it', () => {
    const preFixRendering =
      'Because your session may be in a different hive, keep the plan harness explicit: read the plan ' +
      "(plans:get { slug:\"some-plan\" }) + the acceptance rubric 'rubric-abc' + the completion evidence, " +
      'then emit ONE complete scorecard: scorecards:emit { rubricRef:"rubric-abc", ratings:{ <every ' +
      'criterion key> } } with concrete evidence per rating. The verdict is YOURS — consult if you need ' +
      'to, but the grade is not delegable.';

    // The pre-fix copy DID already name scorecards:emit — which is exactly why
    // naming the tool was never sufficient, and why the assertion must key on
    // the guarantee instead.
    expect(preFixRendering).toContain('scorecards:emit');
    expect(preFixRendering).not.toContain(ACCEPTANCE_GRADING_NO_CLAIM_FACT);

    // Guards the vacuity case directly: an empty FACT would make the line above
    // fail, but state it outright so the reason is legible at the failure site.
    expect(ACCEPTANCE_GRADING_NO_CLAIM_FACT.trim().length).toBeGreaterThan(40);
  });
});

describe('acceptance-grading BAR evidence scope guidance (EI-24820671809444052)', () => {
  it('uses the criterion plane and scope, and pins the tree-positive/deployed-denial case', () => {
    expect(ACCEPTANCE_GRADING_BAR_SCOPE_GUIDANCE).toContain('`evidencePlane` and `requiredScope`');
    expect(ACCEPTANCE_GRADING_BAR_SCOPE_GUIDANCE).toContain('specific declared scope dimension and evidence plane');
    expect(ACCEPTANCE_GRADING_BAR_SCOPE_GUIDANCE).toContain(
      'for a tree-plane R-3 requiring the current-build portal, a current-build tree positive with a deployed-only 403 remains healthy',
    );
    expect(ACCEPTANCE_GRADING_BAR_SCOPE_GUIDANCE).toContain('unless deployed proof is explicitly required');
  });

  it('reaches assigned, minimum-fill, and cascade-woken graders', () => {
    expect(buildAssignedAcceptanceGraderBrief(META.planSlug, META.harnessSlug, META.rubricId)).toContain(
      ACCEPTANCE_GRADING_BAR_SCOPE_GUIDANCE,
    );
    expect(buildMinimumFillAcceptanceGraderBrief(META.planSlug, META.harnessSlug, META.rubricId)).toContain(
      ACCEPTANCE_GRADING_BAR_SCOPE_GUIDANCE,
    );
    expect(gradingCascadeWakeCopy(META)(wakeCtx()).body).toContain(ACCEPTANCE_GRADING_BAR_SCOPE_GUIDANCE);
  });
});

describe('grading-integrity reservation epoch guidance', () => {
  it('preserves the exact dispatch lease and tells a later auditor to stop on mismatch', () => {
    expect(sourceAuditCascadeMetaFromRouting({ cascade: SOURCE_AUDIT })).toEqual(SOURCE_AUDIT);
    const legacy = sourceAuditCascadeMetaFromRouting({
      cascade: { ...SOURCE_AUDIT, reservationReservedAt: undefined },
    });
    expect(legacy).toMatchObject({ flavor: 'grading-integrity', issueId: SOURCE_AUDIT.issueId });
    expect(legacy?.reservationReservedAt).toBeUndefined();

    const copy = sourceAuditWakeCopy(SOURCE_AUDIT, 'conv-source-audit');
    expect(copy.body).toContain("key 'grading-audit:EI-source-audit'");
    expect(copy.body).toContain("reservedAt '2026-09-23T18:00:00.000Z'");
    expect(copy.body).toContain('Before reading criterion evidence');
    expect(copy.body).toContain('If it does not, report the current state and stop.');

    const legacyCopy = sourceAuditWakeCopy(legacy!, 'conv-legacy-source-audit');
    expect(legacyCopy.body).toContain('Legacy grading-audit route');
    expect(legacyCopy.body).toContain('report the missing epoch and stop');
  });

  // EI-24004666155292652: the brief said "a consult reply does not settle it" but never said the
  // emit ITSELF closes the consult (closeSourceAuditConsults → closed_answered), so an auditor read
  // the consult as still open and burned four refusals trying to reply. Both route flavours (epoch
  // and legacy) must carry the auto-close fact.
  it('tells the auditor a successful emit auto-closes the consult so it does not try to reply', () => {
    const legacy = sourceAuditCascadeMetaFromRouting({
      cascade: { ...SOURCE_AUDIT, reservationReservedAt: undefined },
    });
    for (const meta of [SOURCE_AUDIT, legacy!]) {
      const { body } = sourceAuditWakeCopy(meta, 'conv-source-audit');
      expect(body).toContain('A successful emit ALSO closes this consult');
      expect(body).toContain('closed_answered');
      expect(body).toContain('do not call consult:close');
    }
  });

  it('control: the brief fact stays attached to the real settle path (closeSourceAuditConsults → closed_answered)', async () => {
    // The sentence above is only true while the settle helper really closes the consult. Pin the
    // claim to its source so the copy cannot outlive the behaviour it describes.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../grading-audit-routing.ts', import.meta.url), 'utf8');
    const settle = src.slice(src.indexOf('export async function closeSourceAuditConsults'));
    expect(settle).toContain("SET state = 'closed_answered'");
    expect(settle).toContain("routing->'cascade'->>'flavor' = 'grading-integrity'");
  });
});
