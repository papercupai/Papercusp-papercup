import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { BehaviorContractGroup, WorkItemBehaviorContract } from '../agent-tools/plans/behavior-contract-resolver';
import type { SpecClauseRevision } from '../agent-tools/plans/spec-clauses-store';

/**
 * P-011, the rubric/testing read surface. The behaviour under test is NOT "does it return
 * a verdict" — it is the D-020 honesty property, which is the only thing standing between
 * this query and a confidently wrong answer.
 *
 * `specTestAdequacyCompletionGate` grades its `freshness` criterion by comparing each
 * stored evidence fingerprint against fingerprints the CALLER attests at close time about
 * its own working tree (`attestation.current`). A READ has no such tree and cannot have
 * them. With them absent, `compareFingerprint` returns `unknown` — deliberately not
 * `stale` — so the clause verdict degrades to `unknown` and `wouldBlock` names freshness.
 *
 * Two failure modes follow, and both are silent:
 *
 *   1. FABRICATION — a later "fix" supplies `current` fingerprints so the panel stops
 *      showing unknowns. That invents an attestation on the caller's behalf and would let
 *      this read report a close as CLEAR that the real gate then refuses. The resolver
 *      must therefore never pass `current` at all, and the tests below assert that
 *      directly rather than trusting the comment.
 *
 *   2. FLATTENING — a renderer reads `unknown` as a failure. The defence is that every row
 *      carries `verdictIsLowerBound: true`, so the caveat travels WITH the data.
 *
 * The permanent negative control at the bottom is a deliberately-wrong resolver that
 * fabricates `current`. It exists so the guard above is provably falsifiable: if the
 * assertion ever stops having teeth, the control passes and the suite fails.
 */

let rows: unknown[] = [];
const sqlSpy = vi.fn(async () => rows);

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: sqlSpy }),
}));

// P-004: the clause-deliverable read is a DB query; fake the I/O, keep the key helper real.
const deliverableSpy = vi.fn<typeof import('../plan-verification-escape').readClauseCodeDeliverables>(
  async () => new Map(),
);
vi.mock('../plan-verification-escape', async (orig) => ({
  ...(await orig<typeof import('../plan-verification-escape')>()),
  readClauseCodeDeliverables: (...a: Parameters<typeof deliverableSpy>) => deliverableSpy(...a),
}));

const gateSpy = vi.fn();
vi.mock('../agent-tools/work_items/spec-test-adequacy-gate', () => ({
  specTestAdequacyCompletionGate: (...a: unknown[]) => gateSpy(...a),
}));

const contractSpy = vi.fn<(...a: unknown[]) => Promise<WorkItemBehaviorContract>>();
const stampSpy = vi.fn();
// ⚠ `enforcedClausesOf` and ENFORCEABLE_LIFECYCLE_STATUSES come from importActual, NOT a
// stub. Only the two DATABASE-touching functions are substituted.
//
// This mock briefly carried a hand-written `enforcedClausesOf` that re-implemented the
// filter (`lifecycleStatus === 'accepted' || 'active'`, eligibility re-derived inline).
// It passed — and it made this file assert against a COPY of the enforced-set rule while
// claiming to cover the real one. That is the exact drift this module was just refactored
// to eliminate, reintroduced one layer down where it is harder to see: the real selector
// could change and every test here would still be green.
//
// The rule is a pure function of the contract, so there is no reason to fake it. Fake the
// I/O; run the logic.
vi.mock('../agent-tools/plans/behavior-contract-resolver', async (orig) => ({
  ...(await orig<typeof import('../agent-tools/plans/behavior-contract-resolver')>()),
  resolveWorkItemBehaviorContract: (...a: unknown[]) => contractSpy(...a),
  planStampOf: (...a: unknown[]) => stampSpy(...a),
}));

// spec-test-adequacy is NOT mocked on purpose: `requiredProofFloor` is a pure function and
// the rubric-ref constants are the derived source this module enumerates its args from.
// Substituting a fake would test a copy of the rule instead of the rule.
import { resolveWorkItemSpecAdequacy } from './work-item-spec-adequacy';
import { PLAN_CLASS_RUBRIC_REFS, SPEC_TEST_ADEQUACY_RUBRIC_REF } from '../agent-tools/plans/spec-test-adequacy';

const BASE = { workspaceId: 'ws', harnessSlug: 'papercusp', workItemId: 'WI-1' };

const itemRow = {
  feature_id: 'WI-1',
  harness_slug: 'papercusp',
  item_kind: 'change',
  payload: {},
  source_plan_slug: 'p',
  source_plan_item_ids: ['P-001'],
};

/** Only the fields `requiredProofFloor` and the clause view actually read. */
const clause = (over: Partial<SpecClauseRevision> = {}): SpecClauseRevision => ({
  planSlug: 'p',
  specId: 'SPEC-1',
  sourceValId: null,
  currentRevision: 3,
  revision: 3,
  planItemId: 'P-001',
  behavior: 'does the thing',
  behaviorClass: 'happy-path',
  lifecycleStatus: 'active',
  requiredTestLayers: ['l3'],
  requiredEvidence: [],
  mutationRequired: false,
  falsifier: null,
  supersedes: null,
  exemption: null,
  contentHash: 'a'.repeat(64),
  createdBy: 'su-test',
  createdAt: '2026-08-20T00:00:00.000Z',
  acceptedBy: 'su-test',
  acceptedAt: '2026-08-20T00:00:00.000Z',
  acceptanceRef: null,
  ...over,
});

const behaviorContractGroup = (over: Partial<BehaviorContractGroup> = {}): BehaviorContractGroup => ({
  planSlug: 'p',
  via: 'plan-stamp',
  edges: [],
  clauses: [clause()],
  staleEdges: [],
  planStatus: 'active',
  eligibility: { enforcing: true, lane: 'enforceable', adoption: 'adopted' },
  ...over,
});

const contract = (over: Partial<WorkItemBehaviorContract> = {}): WorkItemBehaviorContract => ({
  workItemId: 'WI-1',
  groups: [behaviorContractGroup()],
  enforceable: [clause()],
  impact: { required: true, resolved: true, report: null, reason: 'resolved' },
  ...over,
});

beforeEach(() => {
  rows = [itemRow];
  sqlSpy.mockClear();
  gateSpy.mockReset();
  stampSpy.mockReset();
  contractSpy.mockReset();
  stampSpy.mockReturnValue({ planSlug: 'p', harnessSlug: 'papercusp' });
  contractSpy.mockResolvedValue(contract());
  gateSpy.mockResolvedValue({ ok: true, applicable: true, checked: ['SPEC-1@3'] });
});

/** Pull the attestation the resolver handed the gate, if any. */
const attestationPassed = () =>
  (gateSpy.mock.calls[0]?.[0] as { attestation?: Record<string, unknown> } | undefined)?.attestation;

describe('resolveWorkItemSpecAdequacy — D-020 lower-bound honesty', () => {
  it('NEVER supplies caller-attested evidence fingerprints to the gate', async () => {
    await resolveWorkItemSpecAdequacy({ ...BASE, classRef: 'plan-class-bugfix' });
    // The whole property in one assertion: a read may choose the class, but it may not
    // attest anything about a working tree it cannot see.
    expect(attestationPassed()).toEqual({ classRef: 'plan-class-bugfix' });
    expect(attestationPassed()).not.toHaveProperty('current');
  });

  it('flags every row as a lower bound, including a fully satisfied one', async () => {
    // The dangerous row is the GREEN one: a reader who sees ok:true is most likely to
    // treat it as settled, when freshness was merely never established.
    const out = (await resolveWorkItemSpecAdequacy({ ...BASE, classRef: 'plan-class-bugfix' })) as Array<
      Record<string, unknown>
    >;
    expect(out[0].verdictIsLowerBound).toBe(true);
    expect((out[0].verdict as Record<string, unknown>).ok).toBe(true);
  });

  it('passes NO attestation at all when the reader supplied no class', async () => {
    gateSpy.mockResolvedValue({
      ok: false,
      applicable: true,
      retryable: true,
      checked: [],
      reason: 'current spec-test-adequacy attestation required for SPEC-1@3; pass specAdequacy.classRef',
    });
    const out = (await resolveWorkItemSpecAdequacy(BASE)) as Array<Record<string, unknown>>;
    // Reproducing the real first refusal is the POINT of the classRef-less call: it is how
    // a caller discovers what to attest without performing a write to find out.
    expect(attestationPassed()).toBeUndefined();
    expect(out[0].attestationSupplied).toBe(false);
    expect((out[0].verdict as Record<string, string>).blockerReason).toContain('attestation required');
  });

  it('leaves requiredProofFloor null rather than guessing a class', async () => {
    const out = (await resolveWorkItemSpecAdequacy(BASE)) as Array<Record<string, unknown>>;
    const clauses = out[0].clauses as Array<Record<string, unknown>>;
    expect(clauses).toHaveLength(1);
    // The floor is a function of (clause, class). With no class there is no floor, and a
    // fabricated one would misreport l3 work as l4-blocked or the reverse.
    expect(clauses[0].requiredProofFloor).toBeNull();
  });

  it('computes the floor from the real rule once a class is supplied', async () => {
    // plan-class-bugfix demands l4 of every automated clause — asserted against the real
    // requiredProofFloor, not a restatement of it.
    const out = (await resolveWorkItemSpecAdequacy({ ...BASE, classRef: 'plan-class-bugfix' })) as Array<
      Record<string, unknown>
    >;
    expect((out[0].clauses as Array<Record<string, unknown>>)[0].requiredProofFloor).toBe('l4');
  });

  it('shows floor none when the clause plan item resolves to a non-code deliverable (P-004)', async () => {
    // The view must show the floor the gate applies; the gate reads the same resolver.
    deliverableSpy.mockResolvedValueOnce(new Map([['p\u0000P-001', false]]));
    const out = (await resolveWorkItemSpecAdequacy({ ...BASE, classRef: 'plan-class-bugfix' })) as Array<
      Record<string, unknown>
    >;
    expect((out[0].clauses as Array<Record<string, unknown>>)[0].requiredProofFloor).toBe('none');
  });
});

describe('resolveWorkItemSpecAdequacy — verdict passthrough', () => {
  it('carries the gate refusal VERBATIM, unparsed', async () => {
    const reason = 'SPEC-1@3: unknown [freshness]; SPEC-2@1: no current terminal complete scorecard';
    gateSpy.mockResolvedValue({ ok: false, applicable: true, retryable: true, checked: [], reason });
    const out = (await resolveWorkItemSpecAdequacy({ ...BASE, classRef: 'plan-class-feature-ship' })) as Array<
      Record<string, unknown>
    >;
    // Verbatim, not split on '; '. The gate owns this string's shape; re-parsing a
    // producer we control is how a renderer silently rots when the format shifts.
    expect((out[0].verdict as Record<string, unknown>).blockerReason).toBe(reason);
  });

  it('reports no blocker when the gate is satisfied', async () => {
    const out = (await resolveWorkItemSpecAdequacy({ ...BASE, classRef: 'plan-class-feature-ship' })) as Array<
      Record<string, unknown>
    >;
    expect((out[0].verdict as Record<string, unknown>).blockerReason).toBeNull();
  });

  it('surfaces an advisory impactReport even on a PASSING verdict (D-017)', async () => {
    gateSpy.mockResolvedValue({
      ok: true,
      applicable: true,
      checked: ['SPEC-1@3'],
      impactReport: 'coverage edges pinned to superseded revisions: p/SPEC-9 edge@1 vs current@2.',
    });
    const out = (await resolveWorkItemSpecAdequacy({ ...BASE, classRef: 'plan-class-feature-ship' })) as Array<
      Record<string, unknown>
    >;
    const verdict = out[0].verdict as Record<string, unknown>;
    // Populated independently of `ok` — a renderer keying the report off a refusal would
    // hide exactly the condition D-013 asked P-016 to report.
    expect(verdict.ok).toBe(true);
    expect(verdict.impactReport).toContain('superseded revisions');
  });

  it('reports the ROLE the item is graded under', async () => {
    const out = (await resolveWorkItemSpecAdequacy({ ...BASE, classRef: 'plan-class-migration' })) as Array<
      Record<string, unknown>
    >;
    expect(out[0].rubricRef).toBe(SPEC_TEST_ADEQUACY_RUBRIC_REF);
    expect(out[0].classRef).toBe('plan-class-migration');
  });
});

describe('resolveWorkItemSpecAdequacy — the empty cases stay distinguishable', () => {
  it('labels a missing work-item row and never calls the gate', async () => {
    rows = [];
    const out = (await resolveWorkItemSpecAdequacy(BASE)) as Array<Record<string, unknown>>;
    expect(out[0].unavailableReason).toBe('work-item-not-found');
    expect(gateSpy).not.toHaveBeenCalled();
  });

  it('distinguishes a FAILED gate from an item the gate does not judge', async () => {
    gateSpy.mockRejectedValue(new Error('boom'));
    const out = (await resolveWorkItemSpecAdequacy(BASE)) as Array<Record<string, unknown>>;
    // Both render as "no blockers". Only the label separates "nothing to prove here" from
    // "we could not find out" — collapsing them is a false all-clear on a hard gate.
    expect(out[0].unavailableReason).toBe('resolver-unavailable');
  });

  it('still answers when the contract resolver fails, without inventing clauses', async () => {
    contractSpy.mockRejectedValue(new Error('boom'));
    const out = (await resolveWorkItemSpecAdequacy({ ...BASE, classRef: 'plan-class-bugfix' })) as Array<
      Record<string, unknown>
    >;
    // The gate's own verdict is the authority; the clause list is decoration. Losing the
    // decoration must not suppress the verdict.
    expect(out[0].unavailableReason).toBeNull();
    expect(out[0].clauses).toEqual([]);
    expect((out[0].verdict as Record<string, unknown>).ok).toBe(true);
  });

  it('excludes clauses outside the ENFORCED lifecycle', async () => {
    contractSpy.mockResolvedValue(
      contract({
        groups: [behaviorContractGroup({ clauses: [clause(), clause({ specId: 'SPEC-D', lifecycleStatus: 'draft' })] })],
        enforceable: [],
      }),
    );
    const out = (await resolveWorkItemSpecAdequacy({ ...BASE, classRef: 'plan-class-bugfix' })) as Array<
      Record<string, unknown>
    >;
    const ids = (out[0].clauses as Array<Record<string, unknown>>).map((c) => c.specId);
    // A draft clause listed beside a floor implies an enforcement that does not exist.
    expect(ids).toEqual(['SPEC-1']);
  });
});

describe('args schema', () => {
  it('accepts every plan-class rubric ref, derived from the source constant', async () => {
    const { workItemSpecAdequacyArgsSchema } = await import('./work-item-spec-adequacy');
    for (const ref of PLAN_CLASS_RUBRIC_REFS) {
      expect(workItemSpecAdequacyArgsSchema.parse({ ...BASE, classRef: ref }).classRef).toBe(ref);
    }
    // Enumerated FROM the constant, so a rubric added there is accepted here with no edit.
    expect(workItemSpecAdequacyArgsSchema.safeParse({ ...BASE, classRef: 'plan-class-invented' }).success).toBe(
      false,
    );
  });
});

/**
 * PERMANENT NEGATIVE CONTROL — never delete, never "fix".
 *
 * A deliberately-wrong resolver that fabricates the caller's evidence attestation, which
 * is failure mode 1 in the module header. It proves the guard above can actually fail: if
 * the `not.toHaveProperty('current')` assertion ever loses its teeth, this control stops
 * being caught and the expectation below fails loudly.
 */
describe('negative control — a resolver that fabricates the attestation IS caught', () => {
  const fabricating = (classRef: string) => ({
    attestation: { classRef, current: [{ evidenceKind: 'test', evidenceRef: 'x', testFingerprint: 'faked' }] },
  });

  it('the fabricated shape trips the same assertion the real resolver passes', () => {
    const bad = fabricating('plan-class-bugfix').attestation;
    expect(bad).toHaveProperty('current');
    expect(() => expect(bad).not.toHaveProperty('current')).toThrow();
  });
});
