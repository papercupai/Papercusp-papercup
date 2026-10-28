import { describe, expect, it, vi } from 'vitest';
import { WORK_ITEM_PRESENTATION_LABELS } from '../../work-item-presentation-contract';

import {
  acceptanceSourceRevision,
  agentReviewEligibility,
  createImplementationReadiness,
  deriveWorkItemIntakeStage,
  deriveWorkItemPresentationStage,
  countWorkItemPresentationStages,
  evaluateImplementationAcceptance,
  hasStrictOwnerAction,
  IMPLEMENTATION_ACCEPTANCE_CONTRACT_VERSION,
  IMPLEMENTATION_ACCEPTANCE_PROPOSAL_FIELDS,
  IMPLEMENTATION_READINESS_SCHEMA_VERSION,
  implementationReadinessIsLegacyEquivalent,
  LEGACY_AGENT_REVIEW_SUBMITTER,
  isStrictOwnerActionCapability,
  readAgentReviewState,
  readAgentReviewRecoverySnapshot,
  agentReviewIsReproductionValidation,
  readImplementationReadiness,
  readStructuredOwnerAsk,
  sealImplementationAcceptance,
  createVerificationTask,
  matchesAgentReviewClaimAdmission,
  mintAgentReviewClaimAdmission,
  readVerificationTask,
  VERIFICATION_TASK_SCHEMA_VERSION,
  verificationConflict,
  verificationParties,
  verificationTaskConflict,
  type ImplementationAcceptanceAuthority,
  type ImplementationAcceptanceContract,
  type ImplementationAcceptanceSource,
  type ImplementationReadinessState,
  WORK_ITEM_INTAKE_PRIMARY_STAGES,
  WORK_ITEM_PRESENTATION_STAGES,
} from './agent-review-policy';

// Copy-out mutation-probe seam: the regular suite imports the real policy, while
// scripts/mutation-probe.sh can point the same behavioral fixtures at a mutated
// copy without ever dirtying the shared checkout.
vi.mock('./agent-review-policy', async (importOriginal) => {
  const probe = process.env.PAPERCUSP_AGENT_REVIEW_POLICY_PROBE;
  return probe ? await import(/* @vite-ignore */ probe) : await importOriginal();
});

const BUG_SOURCE: ImplementationAcceptanceSource = {
  kind: 'bug',
  title: 'Bounded parser drops the trailing token',
  summary: 'The bounded parser drops the last token of every line.',
};

const PROPOSAL = {
  problem: 'The bounded parser drops the trailing token of a line.',
  evidence: ['parser.test.ts trailing-token fixture fails on HEAD'],
  outcome: 'Every token of a line survives parsing.',
  scope: 'Fix the bounded parser defect only.',
  completionCheck: 'The trailing-token regression fixture passes.',
};

const REVIEW_AUTHORITY: ImplementationAcceptanceAuthority = {
  kind: 'agent-review',
  reviewer: 'su-reviewer',
  submittedBy: 'su-author',
  round: 1,
};

/** P-006: the D-023 receipt a bug's acceptance must carry. */
const REPRODUCTION = { kind: 'failing-test', ref: 'packages/operator-core/lib/example.test.ts', buildSha: 'abcdef1' } as const;

function sealedContract(
  source: ImplementationAcceptanceSource = BUG_SOURCE,
  authority: ImplementationAcceptanceAuthority = REVIEW_AUTHORITY,
): ImplementationAcceptanceContract {
  const sealed = sealImplementationAcceptance({
    proposal: PROPOSAL,
    authority,
    reason: 'agent-review-approved (grade 5/5)',
    source,
    acceptedAt: '2026-09-05T00:00:00.000Z',
    reproduction: source.kind === 'bug' ? REPRODUCTION : undefined,
  });
  if (!sealed.ok) throw new Error(`fixture contract must seal: ${JSON.stringify(sealed)}`);
  return sealed.contract;
}

const readinessWith = (
  // `object`, not Record<string, unknown>: fixtures pass interface values and
  // deliberately malformed shapes alike.
  acceptance: object | undefined,
  status: ImplementationReadinessState['status'] = 'ready',
) =>
  createImplementationReadiness({
    status,
    source: 'agent-review',
    reason: status === 'ready' ? 'agent-review-approved' : 'awaiting-agent-review',
    updatedAt: '2026-09-05T00:00:00.000Z',
    ...(acceptance ? { evidence: { acceptance: acceptance as Record<string, unknown> } } : {}),
  });

const acceptedReadiness = (source: ImplementationAcceptanceSource = BUG_SOURCE) => readinessWith(sealedContract(source));

describe('P-010 shared intake presentation', () => {
  const accepted = () => ({ ...BUG_SOURCE, status: 'open', payload: { implementationReadiness: acceptedReadiness() } });

  it('R-10: assignment cannot convert intake to active accepted work, and a hold outranks assignment', () => {
    expect(deriveWorkItemPresentationStage({ ...accepted(), payload: {}, assignee: 'su-worker' }).stage).toBe('unknown');
    expect(deriveWorkItemPresentationStage({ ...accepted(), payload: { implementationReadiness: readinessWith(undefined) },
      status: 'wip', assignee: 'su-worker' }).stage).toBe('candidate');
    expect(deriveWorkItemPresentationStage(accepted()).stage).toBe('accepted-ready');
    expect(deriveWorkItemPresentationStage({ ...accepted(), assignee: 'su-worker' }).stage).toBe('accepted-active');
    expect(deriveWorkItemPresentationStage({ ...accepted(), assignee: 'su-worker' }).reason).toBe('accepted-work-reserved');
    expect(WORK_ITEM_PRESENTATION_LABELS['accepted-active']).toBe('Reserved accepted work');
    expect(deriveWorkItemPresentationStage({ ...accepted(), status: 'wip' }).stage).toBe('accepted-ready');
    expect(deriveWorkItemPresentationStage({ ...accepted(), assignee: 'su-worker', blocked: true }).stage).toBe('accepted-blocked');
    expect(deriveWorkItemPresentationStage({ ...accepted(), payload: { ...accepted().payload, _claimHold: true } }).stage)
      .toBe('accepted-blocked');
    expect(deriveWorkItemPresentationStage({ ...accepted(), title: 'changed after acceptance' }).stage).toBe('candidate');
  });

  it('R-33: a verified successful accepted close is delivery; a duplicate, invalid or legacy close is not', () => {
    for (const status of ['done', 'passed', 'resolved']) {
      expect(deriveWorkItemPresentationStage({ ...accepted(), status, completionAuthority: 'committed' }).stage)
        .toBe('verified-completion');
    }
    for (const status of ['closed', 'dropped', 'deprecated']) {
      expect(deriveWorkItemPresentationStage({ ...accepted(), status, completionAuthority: 'committed' }).stage)
        .toBe('terminal-other');
    }
    // `failed` is retryable in the canonical lifecycle; it is held, not delivered.
    expect(deriveWorkItemPresentationStage({ ...accepted(), status: 'failed', completionAuthority: 'committed' }).stage)
      .toBe('accepted-blocked');
    for (const completionAuthority of [null, 'proposed', 'invalid', 'pending_human']) {
      expect(deriveWorkItemPresentationStage({ ...accepted(), status: 'done', completionAuthority }).stage)
        .toBe('terminal-other');
    }
    expect(deriveWorkItemPresentationStage({ ...accepted(), status: 'done', payload: {}, completionAuthority: 'committed' }).stage)
      .toBe('terminal-other');
  });

  it('R-33: the population partitions once and intake processing cannot inflate remaining bugs or delivered fixes', () => {
    const rows = [
      { ...accepted(), payload: { lane: 'observation', digestConsumed: true }, status: 'done', completionAuthority: 'committed' },
      { ...accepted(), payload: { implementationReadiness: readinessWith(undefined), pairComparisons: 2000 }, assignee: 'su-worker' },
      accepted(), { ...accepted(), assignee: 'su-worker' }, { ...accepted(), blocked: true },
      { ...accepted(), status: 'done', completionAuthority: 'validated' },
      { ...accepted(), status: 'closed', completionAuthority: 'committed' },
      { ...accepted(), payload: {} },
    ];
    const census = countWorkItemPresentationStages(rows);
    expect(census.population).toBe(8);
    expect(WORK_ITEM_PRESENTATION_STAGES.map(stage => census.counts[stage])).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect(Object.values(census.counts).reduce((a, b) => a + b, 0)).toBe(census.population);
    expect(census.remainingBugs).toBe(3);
    expect(census.verifiedCompletions).toBe(1);
    expect(census).toMatchObject({ unit: 'work-item rows', mutuallyExclusive: true, writer: 'deriveWorkItemPresentationStage' });
  });
});

describe('implementation readiness payload', () => {
  it('round-trips a current three-valued verdict with a stable schema version', () => {
    const readiness = createImplementationReadiness({
      status: 'ready',
      source: 'agent-review',
      reason: 'agent-review-approved',
      updatedAt: '2026-09-05T00:00:00.000Z',
      evidence: { review: { submittedBy: 'su-a', reviewer: 'su-b', round: 2, grade: 5 } },
    });
    expect(readiness.schemaVersion).toBe(IMPLEMENTATION_READINESS_SCHEMA_VERSION);
    expect(readImplementationReadiness({ implementationReadiness: readiness })).toEqual(readiness);
  });

  it('keeps absent legacy metadata distinct from malformed enrolled metadata', () => {
    expect(readImplementationReadiness({})).toBeNull();
    expect(
      readImplementationReadiness({
        implementationReadiness: {
          schemaVersion: IMPLEMENTATION_READINESS_SCHEMA_VERSION,
          status: 'ready',
        },
      }),
    ).toBeNull();
  });
});

describe('versioned work-item intake stage', () => {
  it.each([
    {
      name: 'observation evidence outranks terminal lifecycle and never becomes bug work',
      input: {
        kind: 'bug',
        status: 'done',
        payload: { lane: 'observation', implementationReadiness: acceptedReadiness() },
      },
      expected: { primaryStage: 'observation', readiness: 'not-applicable', countsAsBugWork: false },
    },
    {
      name: 'unverified current candidate stays in intake',
      input: {
        kind: 'bug',
        status: 'open',
        payload: {
          implementationReadiness: createImplementationReadiness({
            status: 'unknown',
            source: 'agent-review',
            reason: 'awaiting-agent-review',
            updatedAt: '2026-09-05T00:00:00.000Z',
          }),
        },
      },
      expected: { primaryStage: 'candidate', readiness: 'unknown', countsAsBugWork: false },
    },
    {
      name: 'revision-requested candidate stays in intake',
      input: {
        kind: 'bug',
        status: 'open',
        payload: {
          implementationReadiness: createImplementationReadiness({
            status: 'not-ready',
            source: 'agent-review',
            reason: 'agent-review-revision-requested',
            updatedAt: '2026-09-05T00:00:00.000Z',
          }),
        },
      },
      expected: { primaryStage: 'candidate', readiness: 'not-ready', countsAsBugWork: false },
    },
    {
      name: 'ready without executable acceptance remains a candidate',
      input: {
        kind: 'bug',
        status: 'open',
        payload: {
          implementationReadiness: createImplementationReadiness({
            status: 'ready',
            source: 'capture-policy',
            reason: 'legacy-immediate-policy',
            updatedAt: '2026-09-05T00:00:00.000Z',
          }),
        },
      },
      expected: { primaryStage: 'candidate', readiness: 'ready', countsAsBugWork: false },
    },
    {
      name: 'qualifying accepted bug is executable bug work',
      input: {
        kind: 'bug',
        status: 'open',
        payload: { implementationReadiness: acceptedReadiness() },
      },
      expected: { primaryStage: 'accepted', readiness: 'ready', countsAsBugWork: true },
    },
    {
      name: 'accepted non-bug work is not a bug count',
      input: {
        kind: 'feature',
        status: 'open',
        payload: { implementationReadiness: acceptedReadiness({ ...BUG_SOURCE, kind: 'feature' }) },
      },
      expected: { primaryStage: 'accepted', readiness: 'ready', countsAsBugWork: false },
    },
    {
      name: 'R-21: a title edit after acceptance makes it stale and requests re-review',
      input: {
        kind: 'bug',
        status: 'open',
        title: 'Bounded parser drops the trailing token (rescoped)',
        payload: { implementationReadiness: acceptedReadiness() },
      },
      expected: {
        primaryStage: 'candidate',
        reason: 'acceptance-revision-stale',
        acceptance: 'stale-revision',
        reReviewRequested: true,
        countsAsBugWork: false,
      },
    },
    {
      name: 'R-21: a kind change after acceptance makes it stale',
      input: {
        kind: 'change',
        status: 'open',
        payload: { implementationReadiness: acceptedReadiness() },
      },
      expected: { primaryStage: 'candidate', acceptance: 'stale-revision', reReviewRequested: true },
    },
    {
      name: 'fail-closed: acceptance cannot qualify when the current source was not supplied',
      input: {
        kind: 'bug',
        status: 'open',
        title: null,
        payload: { implementationReadiness: acceptedReadiness() },
      },
      expected: { primaryStage: 'candidate', acceptance: 'stale-revision', qualifyingAcceptance: false },
    },
    {
      name: 'R-20: self-review is not acceptance authority',
      input: {
        kind: 'bug',
        status: 'open',
        payload: {
          implementationReadiness: readinessWith({
            ...sealedContract(),
            authority: { ...REVIEW_AUTHORITY, reviewer: 'su-author' },
          }),
        },
      },
      expected: {
        primaryStage: 'candidate',
        reason: 'acceptance-authority-invalid',
        acceptance: 'invalid-authority',
        countsAsBugWork: false,
      },
    },
    {
      name: 'R-20: confidence is never acceptance authority',
      input: {
        kind: 'bug',
        status: 'open',
        payload: {
          implementationReadiness: readinessWith({
            ...sealedContract(),
            authority: { kind: 'confidence', confidence: 0.99 },
          }),
        },
      },
      expected: { primaryStage: 'candidate', acceptance: 'invalid-authority' },
    },
    {
      name: 'R-20: dedup admission is not an allowlisted acceptance policy',
      input: {
        kind: 'bug',
        status: 'open',
        payload: {
          implementationReadiness: readinessWith({
            ...sealedContract(),
            authority: { kind: 'policy', policy: 'duplicate-admission', actor: 'system:dedup' },
          }),
        },
      },
      expected: { primaryStage: 'candidate', acceptance: 'invalid-authority' },
    },
    {
      name: 'an allowlisted existing policy may write qualifying acceptance',
      input: {
        kind: 'bug',
        status: 'open',
        payload: {
          implementationReadiness: readinessWith(
            sealedContract(BUG_SOURCE, {
              kind: 'policy',
              policy: 'trusted-tool-failure-promotion',
              actor: 'system:tool-failure-watchdog',
            }),
          ),
        },
      },
      expected: { primaryStage: 'accepted', acceptance: 'qualifying', countsAsBugWork: true },
    },
    {
      name: 'R-4: a ready verdict missing the completion check stays in intake',
      input: {
        kind: 'bug',
        status: 'open',
        payload: {
          implementationReadiness: readinessWith(
            Object.fromEntries(Object.entries(sealedContract()).filter(([key]) => key !== 'completionCheck')),
          ),
        },
      },
      expected: {
        primaryStage: 'candidate',
        reason: 'ready-without-executable-acceptance',
        acceptance: 'incomplete',
        countsAsBugWork: false,
      },
    },
    {
      name: 'an unsealed producer proposal on an unknown verdict stays in intake',
      input: {
        kind: 'bug',
        status: 'open',
        payload: { implementationReadiness: readinessWith(PROPOSAL, 'unknown') },
      },
      expected: {
        primaryStage: 'candidate',
        reason: 'awaiting-qualifying-acceptance',
        acceptance: 'incomplete',
      },
    },
    {
      name: 'a qualifying contract under a not-ready verdict is not accepted',
      input: {
        kind: 'bug',
        status: 'open',
        payload: { implementationReadiness: readinessWith(sealedContract(), 'not-ready') },
      },
      expected: { primaryStage: 'candidate', acceptance: 'qualifying', qualifyingAcceptance: false },
    },
    {
      name: 'D-009a: a creation-enrollment stamp is a measurable candidate in intake',
      input: {
        kind: 'bug',
        status: 'open',
        payload: {
          implementationReadiness: createImplementationReadiness({
            status: 'unknown',
            source: 'creation-enrollment',
            reason: 'no-acceptance-evidence-at-creation',
            updatedAt: '2026-09-05T00:00:00.000Z',
          }),
        },
      },
      expected: {
        primaryStage: 'candidate',
        readiness: 'unknown',
        reason: 'awaiting-qualifying-acceptance',
        acceptance: 'absent',
      },
    },
    {
      name: 'terminal accepted work remains terminal history',
      input: {
        kind: 'bug',
        status: 'done',
        payload: { implementationReadiness: acceptedReadiness() },
      },
      expected: { primaryStage: 'terminal', readiness: 'ready', countsAsBugWork: true },
    },
    {
      name: 'missing legacy readiness is explicitly unknown',
      input: { kind: 'bug', status: 'open', payload: {} },
      expected: { primaryStage: 'unknown', readiness: 'legacy-missing', countsAsBugWork: false },
    },
    {
      name: 'malformed enrolled readiness is explicitly unknown',
      input: {
        kind: 'bug',
        status: 'open',
        payload: { implementationReadiness: { schemaVersion: 'future-v9', status: 'ready' } },
      },
      expected: { primaryStage: 'unknown', readiness: 'malformed', countsAsBugWork: false },
    },
  ])('$name', ({ input, expected }) => {
    // The current source content the acceptance revision is checked against;
    // a case overrides title (or kind) to model an edit after acceptance.
    const full = { title: BUG_SOURCE.title, summary: BUG_SOURCE.summary, ...input };
    const before = structuredClone(full);
    const decision = deriveWorkItemIntakeStage(full);
    expect(decision).toMatchObject(expected);
    expect(WORK_ITEM_INTAKE_PRIMARY_STAGES.filter((stage) => stage === decision.primaryStage)).toHaveLength(1);
    expect(full).toEqual(before);
  });
});

describe('one verification stage, kind-specific checks (P-006 / D-019)', () => {
  const CHANGE_SOURCE: ImplementationAcceptanceSource = { ...BUG_SOURCE, kind: 'change' };
  const POLICY_AUTHORITY: ImplementationAcceptanceAuthority = {
    kind: 'policy',
    policy: 'trusted-tool-failure-promotion',
    actor: 'system:test',
  };
  const seal = (
    source: ImplementationAcceptanceSource,
    authority: ImplementationAcceptanceAuthority,
    reproduction?: unknown,
  ) =>
    sealImplementationAcceptance({ proposal: PROPOSAL, authority, reason: 'approved', source, reproduction });
  const evaluate = (contract: object, source: ImplementationAcceptanceSource) =>
    evaluateImplementationAcceptance({ implementationReadiness: readinessWith(contract) }, source);

  it('refuses a bug with no reproduction receipt, or one that does not parse, at the seal', () => {
    expect(seal(BUG_SOURCE, REVIEW_AUTHORITY)).toEqual({ ok: false, refusal: 'reproduction-missing' });
    expect(seal(BUG_SOURCE, REVIEW_AUTHORITY, { ...REPRODUCTION, buildSha: 'not-a-sha' })).toEqual({
      ok: false,
      refusal: 'reproduction-missing',
    });
    expect(seal(BUG_SOURCE, REVIEW_AUTHORITY, { ...REPRODUCTION, kind: 'hunch' })).toEqual({
      ok: false,
      refusal: 'reproduction-missing',
    });
  });

  it('accepts a bug with a receipt under either authority, recording the receipt as its verification', () => {
    for (const authority of [REVIEW_AUTHORITY, POLICY_AUTHORITY]) {
      const sealed = seal(BUG_SOURCE, authority, REPRODUCTION);
      expect(sealed.ok).toBe(true);
      if (!sealed.ok) continue;
      expect(sealed.contract.verification).toEqual({ check: 'reproduction', receipt: REPRODUCTION });
      expect(evaluate(sealed.contract, BUG_SOURCE)).toMatchObject({ state: 'qualifying' });
    }
  });

  it.each(['change', 'feature'] as const)('accepts a %s only through proposal review (agent-review authority)', (kind) => {
    const source: ImplementationAcceptanceSource = { ...CHANGE_SOURCE, kind };
    expect(seal(source, POLICY_AUTHORITY, REPRODUCTION)).toEqual({ ok: false, refusal: 'proposal-review-missing' });
    const sealed = seal(source, REVIEW_AUTHORITY);
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(sealed.contract.verification).toEqual({ check: 'proposal-review' });
    expect(evaluate(sealed.contract, source)).toMatchObject({ state: 'qualifying' });
  });

  it('reads a bug contract without its reproduction verification as incomplete', () => {
    const { verification: _dropped, ...withoutVerification } = sealedContract();
    expect(evaluate(withoutVerification, BUG_SOURCE)).toMatchObject({ state: 'incomplete', missing: ['verification'] });
    expect(evaluate({ ...sealedContract(), verification: { check: 'proposal-review' } }, BUG_SOURCE)).toMatchObject({
      state: 'incomplete',
      missing: ['verification'],
    });
    expect(
      evaluate({ ...sealedContract(), verification: { check: 'reproduction', receipt: { kind: 'failing-test' } } }, BUG_SOURCE),
    ).toMatchObject({ state: 'incomplete', missing: ['verification'] });
  });

  it('keeps a pre-P-006 change contract (agent-review authority, no verification marker) qualifying', () => {
    const { verification: _dropped, ...legacy } = sealedContract(CHANGE_SOURCE);
    expect(evaluate(legacy, CHANGE_SOURCE)).toMatchObject({ state: 'qualifying' });
    // …but a change sealed under policy authority is not proposal review.
    expect(evaluate({ ...legacy, authority: POLICY_AUTHORITY }, CHANGE_SOURCE)).toMatchObject({
      state: 'incomplete',
      missing: ['verification'],
    });
  });
});

describe('implementation acceptance contract (R-4 / R-20 / R-21)', () => {
  it('seals a complete proposal bound to the judged source revision', () => {
    const contract = sealedContract();
    expect(contract).toEqual({
      contractVersion: IMPLEMENTATION_ACCEPTANCE_CONTRACT_VERSION,
      ...PROPOSAL,
      authority: REVIEW_AUTHORITY,
      reason: 'agent-review-approved (grade 5/5)',
      sourceRevision: acceptanceSourceRevision(BUG_SOURCE),
      acceptedAt: '2026-09-05T00:00:00.000Z',
      verification: { check: 'reproduction', receipt: REPRODUCTION },
    });
    expect(evaluateImplementationAcceptance({ implementationReadiness: readinessWith(contract) }, BUG_SOURCE)).toMatchObject({
      state: 'qualifying',
      contract,
    });
  });

  it.each(IMPLEMENTATION_ACCEPTANCE_PROPOSAL_FIELDS.map((field) => ({ field })))(
    'refuses — never defaults — a proposal missing $field',
    ({ field }) => {
      const proposal: Record<string, unknown> = { ...PROPOSAL, [field]: field === 'evidence' ? ['  '] : '   ' };
      expect(
        sealImplementationAcceptance({ proposal, authority: REVIEW_AUTHORITY, reason: 'approved', source: BUG_SOURCE }),
      ).toEqual({ ok: false, refusal: 'incomplete', missing: [field] });
      delete proposal[field];
      expect(
        sealImplementationAcceptance({ proposal, authority: REVIEW_AUTHORITY, reason: 'approved', source: BUG_SOURCE }),
      ).toEqual({ ok: false, refusal: 'incomplete', missing: [field] });
    },
  );

  it('refuses a missing reason and confidence never substitutes for a field', () => {
    const { scope: _scope, ...withoutScope } = PROPOSAL;
    expect(
      sealImplementationAcceptance({
        proposal: { ...withoutScope, confidence: 1, deduplicated: true } as never,
        authority: REVIEW_AUTHORITY,
        reason: ' ',
        source: BUG_SOURCE,
      }),
    ).toEqual({ ok: false, refusal: 'incomplete', missing: ['scope', 'reason'] });
  });

  it.each([
    { name: 'self-review', authority: { ...REVIEW_AUTHORITY, reviewer: 'su-author' } },
    { name: 'round zero', authority: { ...REVIEW_AUTHORITY, round: 0 } },
    { name: 'blank reviewer', authority: { ...REVIEW_AUTHORITY, reviewer: '  ' } },
    { name: 'a non-allowlisted policy', authority: { kind: 'policy', policy: 'explicit-assignment', actor: 'su-x' } },
    { name: 'an allowlisted policy without an actor', authority: { kind: 'policy', policy: 'trusted-tool-failure-promotion', actor: '' } },
    { name: 'a confidence score', authority: { kind: 'confidence', confidence: 0.99 } },
  ])('refuses $name as acceptance authority', ({ authority }) => {
    expect(
      sealImplementationAcceptance({
        proposal: PROPOSAL,
        authority: authority as ImplementationAcceptanceAuthority,
        reason: 'approved',
        source: BUG_SOURCE,
      }),
    ).toEqual({ ok: false, refusal: 'invalid-authority' });
  });

  it('revision changes with kind, title or body and treats a null body as empty', () => {
    const base = acceptanceSourceRevision(BUG_SOURCE);
    expect(base).toMatch(/^src-v1:[0-9a-f]{64}$/);
    expect(acceptanceSourceRevision({ ...BUG_SOURCE, kind: 'change' })).not.toBe(base);
    expect(acceptanceSourceRevision({ ...BUG_SOURCE, title: `${BUG_SOURCE.title}.` })).not.toBe(base);
    expect(acceptanceSourceRevision({ ...BUG_SOURCE, summary: `${BUG_SOURCE.summary} More.` })).not.toBe(base);
    expect(acceptanceSourceRevision({ ...BUG_SOURCE, summary: null })).toBe(
      acceptanceSourceRevision({ ...BUG_SOURCE, summary: '' }),
    );
  });

  it('reports the seal fields a bare proposal is missing, and an array authority as missing', () => {
    expect(evaluateImplementationAcceptance({ implementationReadiness: readinessWith(PROPOSAL) }, BUG_SOURCE)).toEqual({
      state: 'incomplete',
      missing: ['contractVersion', 'authority', 'reason', 'sourceRevision', 'acceptedAt'],
    });
    expect(
      evaluateImplementationAcceptance(
        { implementationReadiness: readinessWith({ ...sealedContract(), authority: [REVIEW_AUTHORITY] }) },
        BUG_SOURCE,
      ),
    ).toEqual({ state: 'incomplete', missing: ['authority'] });
    expect(evaluateImplementationAcceptance({ implementationReadiness: readinessWith(undefined) }, BUG_SOURCE)).toEqual({
      state: 'absent',
      missing: [],
    });
  });
});

describe('implementationReadinessIsLegacyEquivalent (D-011 creation enrollment)', () => {
  const stamp = (overrides: Partial<ImplementationReadinessState> = {}) => ({
    implementationReadiness: {
      ...createImplementationReadiness({
        status: 'unknown',
        source: 'creation-enrollment',
        reason: 'no-acceptance-evidence-at-creation',
        updatedAt: '2026-09-05T00:00:00.000Z',
      }),
      ...overrides,
    },
  });

  it('treats an absent key and a well-formed creation stamp as the legacy exception only', () => {
    expect(implementationReadinessIsLegacyEquivalent({})).toBe(true);
    expect(implementationReadinessIsLegacyEquivalent(null)).toBe(true);
    expect(implementationReadinessIsLegacyEquivalent(stamp())).toBe(true);
    expect(implementationReadinessIsLegacyEquivalent(stamp({ source: 'capture-policy' }))).toBe(false);
    expect(implementationReadinessIsLegacyEquivalent(stamp({ status: 'ready' }))).toBe(false);
    expect(implementationReadinessIsLegacyEquivalent(stamp({ reason: '' }))).toBe(false);
    expect(implementationReadinessIsLegacyEquivalent({ implementationReadiness: null })).toBe(false);
  });
});

describe('readAgentReviewState', () => {
  it('accepts only complete, versionable routing state', () => {
    expect(
      readAgentReviewState({
        agentReview: {
          status: 'pending',
          submittedBy: 'su-filer',
          ledgerIdeaId: 'WI-7',
          round: 1,
        },
      }),
    ).toEqual({
      status: 'pending',
      submittedBy: 'su-filer',
      ledgerIdeaId: 'WI-7',
      round: 1,
    });

    expect(readAgentReviewState({ agentReview: { status: 'pending', round: 1 } })).toBeNull();
    expect(
      readAgentReviewState({ agentReview: { status: 'unknown', submittedBy: 'su', ledgerIdeaId: 'WI-7', round: 1 } }),
    ).toBeNull();
    expect(
      readAgentReviewState({ agentReview: { status: 'approved', submittedBy: 'su', ledgerIdeaId: 'WI-7', round: 0 } }),
    ).toBeNull();
  });

  it('keeps revisionKind only on a revision-requested round and only for a known kind (D-006 / D-007)', () => {
    const base = { submittedBy: 'su-filer', ledgerIdeaId: 'WI-7', round: 1 };
    expect(readAgentReviewState({ agentReview: { ...base, status: 'revision-requested', revisionKind: 'reproduction' } }))
      .toEqual({ ...base, status: 'revision-requested', revisionKind: 'reproduction' });
    expect(readAgentReviewState({ agentReview: { ...base, status: 'revision-requested', revisionKind: 'content' } }))
      .toEqual({ ...base, status: 'revision-requested', revisionKind: 'content' });
    // A stale kind on any other status, or an unknown kind, is dropped rather than trusted.
    expect(readAgentReviewState({ agentReview: { ...base, status: 'pending', revisionKind: 'reproduction' } }))
      .toEqual({ ...base, status: 'pending' });
    expect(readAgentReviewState({ agentReview: { ...base, status: 'revision-requested', revisionKind: 'whatever' } }))
      .toEqual({ ...base, status: 'revision-requested' });
    expect(agentReviewIsReproductionValidation({ agentReview: { ...base, status: 'pending', revisionKind: 'reproduction' } }))
      .toBe(false);
  });

  it('accepts only an independent, complete revision-request recovery snapshot', () => {
    const snapshot = {
      id: 'WI-7',
      harness: 'papercusp',
      review: {
        status: 'revision-requested' as const,
        submittedBy: 'su-filer',
        ledgerIdeaId: 'WI-7',
        round: 2,
        revisionKind: 'content' as const,
      },
      reviewer: 'su-reviewer',
      grade: 2,
      feedback: 'Add the missing regression case.',
      parties: { reporters: ['su-filer'], implementers: ['su-implementer'] },
    };
    expect(readAgentReviewRecoverySnapshot(snapshot)).toEqual(snapshot);
    expect(readAgentReviewRecoverySnapshot({ ...snapshot, reviewer: 'su-filer' })).toBeNull();
    expect(readAgentReviewRecoverySnapshot({ ...snapshot, grade: 4 })).toBeNull();
    expect(readAgentReviewRecoverySnapshot({ ...snapshot, review: { ...snapshot.review, status: 'approved' } }))
      .toBeNull();
    expect(readAgentReviewRecoverySnapshot({ ...snapshot, parties: { reporters: [], implementers: [] } }))
      .toBeNull();
    expect(readAgentReviewRecoverySnapshot({ ...snapshot, parties: { reporters: ['su-filer'], implementers: ['su-reviewer'] } }))
      .toBeNull();
  });

  it('preserves only a well-formed reviewer-visible source revision pin', () => {
    const base = { status: 'pending', submittedBy: 'su-filer', ledgerIdeaId: 'WI-7', round: 1 };
    const revision = acceptanceSourceRevision(BUG_SOURCE);
    expect(readAgentReviewState({ agentReview: { ...base, reviewedSourceRevision: revision } }))
      .toEqual({ ...base, reviewedSourceRevision: revision });
    expect(readAgentReviewState({ agentReview: { ...base, reviewedSourceRevision: 'src-v1:bad' } }))
      .toEqual(base);
  });
});

describe('agentReviewEligibility (abolish-human-review D-003)', () => {
  it.each(['bug', 'change', 'task', 'feature'])('admits preserved %s work-item kinds', (kind) => {
    expect(agentReviewEligibility({ kind, payload: {} })).toEqual({ eligible: true });
  });

  it('keeps observations and non-review kinds out of the lane', () => {
    expect(agentReviewEligibility({ kind: 'chunk', payload: {} })).toEqual({
      eligible: false,
      reason: 'not-review-kind',
    });
    expect(agentReviewEligibility({ kind: 'change', payload: { lane: 'observation' } })).toEqual({
      eligible: false,
      reason: 'observation',
    });
  });

  it('exports a stable non-owner sentinel for unattributed migrated revisions', () => {
    expect(LEGACY_AGENT_REVIEW_SUBMITTER).toBe('system:legacy-agent-review');
  });

  it('keeps remote-owned rows on peer reconciliation', () => {
    expect(agentReviewEligibility({ kind: 'change', origin: 'remote', payload: {} })).toEqual({
      eligible: false,
      reason: 'remote-owned',
    });
  });

  it.each(['credential', 'physical-device', 'external-service-action'] as const)(
    'keeps strict %s needs on the owner-capability path',
    (humanCapability) => {
      expect(agentReviewEligibility({ kind: 'change', payload: { humanCapability } })).toEqual({
        eligible: false,
        reason: 'owner-capability',
      });
      expect(
        agentReviewEligibility({
          kind: 'change',
          payload: {
            externalBlockers: [
              {
                kind: 'human',
                capability: humanCapability,
                capabilitySource: 'explicit',
                ref: `test:${humanCapability}`,
                summary: 'required',
                status: 'active',
                createdAt: '2026-08-20T00:00:00.000Z',
                createdBy: 'su-filer',
                updatedAt: '2026-08-20T00:00:00.000Z',
              },
            ],
          },
        }),
      ).toEqual({ eligible: false, reason: 'owner-capability' });
    },
  );

  it('recognizes product-decision as a strict structured owner capability', () => {
    expect(isStrictOwnerActionCapability('product-decision')).toBe(true);
    expect(
      readStructuredOwnerAsk({
        externalBlockers: [
          {
            kind: 'human',
            capability: 'product-decision',
            capabilitySource: 'explicit',
            ref: 'decision:scope',
            summary: 'Choose the supported scope.',
            nextVerb: 'Record the product decision.',
            status: 'active',
            createdAt: '2026-08-20T00:00:00.000Z',
            createdBy: 'su-filer',
            updatedAt: '2026-08-20T00:00:00.000Z',
          },
        ],
      }),
    ).toMatchObject({
      question: 'Choose the supported scope.',
      askedOf: 'product-owner',
      askedBy: 'su-filer',
      unblockedBy: 'Record the product decision.',
    });
  });

  it('keeps product decisions agent-reviewable', () => {
    expect(
      agentReviewEligibility({
        kind: 'change',
        payload: { humanCapability: 'product-decision' },
      }),
    ).toEqual({ eligible: true });
    expect(hasStrictOwnerAction({ humanCapability: 'product-decision' })).toBe(false);
  });
});

describe('verifier lane: the verifier-conflict rule (P-007 / D-021)', () => {
  const REVIEW = { status: 'pending', submittedBy: 'su-submitter', ledgerIdeaId: 'WI-7', round: 1 } as const;
  const subject = {
    id: 'EI-1',
    harness: 'papercusp',
    kind: 'bug',
    title: 'Reviewable issue',
    summary: 'Initial issue body.',
    createdBy: 'su-filer',
    terminalOwner: 'su-closer',
    payload: {
      _ei: { created_by: 'improvement-triage' },
      agentReview: REVIEW,
      verification: {
        schemaVersion: VERIFICATION_TASK_SCHEMA_VERSION,
        subject: 'EI-0',
        check: 'reproduction',
        reporters: ['su-task-reporter', ' su-task-reporter '],
        implementers: ['su-task-implementer'],
      },
    },
  };

  it('collects every reporter and implementer recorded on the row', () => {
    const parties = verificationParties(subject);
    expect([...parties.reporters].sort()).toEqual(
      ['improvement-triage', 'su-filer', 'su-submitter', 'su-task-reporter'].sort(),
    );
    expect([...parties.implementers].sort()).toEqual(['su-closer', 'su-task-implementer'].sort());
  });

  // SPEC-P-007: verification work is refused to its reporter and to its implementer.
  it('refuses the reporter and the implementer', () => {
    const parties = verificationParties(subject);
    expect(verificationConflict(parties, 'su-filer')).toBe('reporter');
    expect(verificationConflict(parties, 'improvement-triage')).toBe('reporter');
    expect(verificationConflict(parties, ' su-submitter ')).toBe('reporter');
    expect(verificationConflict(parties, 'su-closer')).toBe('implementer');
    expect(verificationConflict(parties, 'su-task-implementer')).toBe('implementer');
  });

  // SPEC-P-007-B: an independent verifier may take it.
  it('lets an independent verifier through', () => {
    expect(verificationConflict(verificationParties(subject), 'su-verifier')).toBeNull();
    expect(verificationConflict(verificationParties(subject), '   ')).toBeNull();
  });

  it('gates a claim on the TASK parties only, so the reviewer who filed the task may run it', () => {
    expect(verificationTaskConflict(subject.payload, 'su-task-reporter')).toBe('reporter');
    expect(verificationTaskConflict(subject.payload, 'su-task-implementer')).toBe('implementer');
    // The row's own filer/closer are not task parties: the task filer is the deciding reviewer.
    expect(verificationTaskConflict(subject.payload, 'su-filer')).toBeNull();
    expect(verificationTaskConflict(subject.payload, 'su-verifier')).toBeNull();
    expect(verificationTaskConflict({}, 'su-task-reporter')).toBeNull();
  });

  it('ignores a verification block that is not a current, complete one', () => {
    const base = subject.payload.verification;
    expect(readVerificationTask({ verification: { ...base, schemaVersion: 'verification-task-v0' } })).toBeNull();
    expect(readVerificationTask({ verification: { ...base, subject: '  ' } })).toBeNull();
    expect(readVerificationTask({ verification: { ...base, check: 'vibes' } })).toBeNull();
    expect(readVerificationTask({ verification: { ...base, reporters: 'su-task-reporter' } })).toEqual(
      createVerificationTask({ subject: 'EI-0', check: 'reproduction', reporters: [], implementers: ['su-task-implementer'] }),
    );
  });

  it('mints and matches a review admission only for an independent reviewer', () => {
    const mint = (reviewer: string) =>
      mintAgentReviewClaimAdmission({
        itemId: subject.id,
        reviewer,
        harnessSlug: 'papercusp',
        review: REVIEW,
        source: subject,
        parties: verificationParties(subject),
      });
    expect(mint('su-filer')).toBeNull();
    expect(mint('su-closer')).toBeNull();
    const admission = mint('su-verifier');
    expect(admission).not.toBeNull();
    expect(matchesAgentReviewClaimAdmission(admission, subject, 'su-verifier')).toBe(true);
    expect(admission).toMatchObject({ reviewedSourceRevision: acceptanceSourceRevision(subject) });
    // The row writer re-derives the revision: editing its body after capability minting refuses it.
    expect(matchesAgentReviewClaimAdmission(admission, { ...subject, summary: 'Corrected issue body.' }, 'su-verifier'))
      .toBe(false);
    // Re-derived from the row at the writer: a row whose closer is now the reviewer refuses.
    expect(
      matchesAgentReviewClaimAdmission(admission, { ...subject, terminalOwner: 'su-verifier' }, 'su-verifier'),
    ).toBe(false);
  });
});
