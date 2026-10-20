/**
 * R-18 (plan-verification-profiles-2026-10-17 P-007): the nine filed non-code bugs stay fixed.
 *
 * Each case replays one filed bug's shape on a `general` plan in real Postgres and runs the gate
 * that originally refused it. The original refusals were the symptom of one design gap: a
 * non-code deliverable got through only by one of six exemptions decided in different places,
 * so each new gate forgot one. With the verification-profile resolver, the plan's stamped
 * profile plus the item's declared deliverable decides which modules apply, and every gate reads
 * that one answer.
 *
 * A replay that merely stops refusing would also pass if the gate had been switched off, so each
 * family carries a CONTROL that shows the same gate still refusing the shape it should refuse:
 * zero citations, a coding plan, or a declared code item.
 *
 *   bug                    | shape                                                  | gate replayed
 *   -----------------------|--------------------------------------------------------|---------------------------
 *   WI-6554700010015803    | manual non-code requirement, completed item            | requirement realization
 *   EI-25749234179776072   | exempt administrative item with no acceptance BAR      | requirement realization
 *   EI-25803818621690104   | docs item targeted by a covered activation mapping     | requirement realization
 *   EI-25335518570307363   | non-code rubric outcome asked for source containment   | ship gate, code-truth family
 *   EI-25354905476476419   | runtime BAR proof demanded from exempt inventory scope | proof floor
 *   EI-23793489732627099   | non-code clause can never reach an all-pass verdict    | spec-test adequacy
 *   EI-25355398614298321   | non-automated exempt clauses with no executable proof  | spec-test adequacy
 *   EI-25459145080002565   | a docs deliverable could only be registered as `task`  | plans:add-item deliverable
 *   EI-25342785339330316   | code work inherited the non-code exemption             | ship gate, code_deliverable_unverified
 *
 * The spec-test-adequacy cases call the pure evaluator, but the `codeDeliverable` they pass is
 * READ from the plan in Postgres by `readClauseCodeDeliverables`, the function both completion
 * and ship use. That read is the part a unit test cannot see.
 *
 * R-19 (same item), last describe: the mixed end-to-end flow. A CODING plan whose code item
 * cites code and whose declared doc item cites only an artifact passes the real plans:audit and
 * the real plans:set-plan-status shipped. Its control leaves the doc item undeclared, so the
 * coding default makes it a code item, and the same artifact citation no longer ships it.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
// The throwaway harness is registered without a source root (same as mixed-plan-ship), so root
// SELECTION points at the canonical repo through the function's own no-harness branch. Citation
// RESOLUTION against that root stays real.
vi.mock('../../../plan-audits', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../plan-audits')>();
  return {
    ...actual,
    repoCitationContextForHarness: (_harnessSlug: unknown, citations?: Parameters<typeof actual.repoCitationContextForHarness>[1]) =>
      actual.repoCitationContextForHarness(null, citations),
  };
});
import { dispatchProjectedTool, lookupByMcpName } from '@papercusp/agent-mcp';
import '../new';
import '../add-item';
import '../set-status';
import '../set-plan-status';
import '../audit';
import blindReviewTool from '../blind-review';
import { ensureFirstPartyRubricsSeeded, __resetRubricSeedStateForTests } from '../../../rubrics';
import { DEFAULT_WORKSPACE_ID } from '../../../workspace-registry';
import { evaluatePlanAcceptanceGate } from '../../../plan-acceptance-gate';
import { clauseDeliverableKey, readClauseCodeDeliverables } from '../../../plan-verification-escape';
import { evaluateSpecTestAdequacy, requiredProofFloor, type SpecEvidenceForAdequacy } from '../spec-test-adequacy';
import type { SpecClauseRevision } from '../spec-clauses-store';
import { hashPlanContent } from '../content-hash';
import { runWithWorkspace } from '../../../workspace-als';
import { setupPlanPgFixture, cleanupPlans, registerHarnessProject, type PlanPgFixture } from './_pg-tool-fixture';

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HARNESS = `zzz-noncode-${RUN}`;
const WS = DEFAULT_WORKSPACE_ID;
/** An untouched plan the artifact citations point at, so its content hash cannot move. */
const EVIDENCE_PLAN = 'zzz-noncode-evidence-2026-10-20';

let fx: PlanPgFixture;
let admin: postgres.Sql;
let auditSeq = 0;

function ctx(): never {
  return {
    workspaceId: WS,
    harnessSlug: HARNESS,
    runId: 'plans-non-code-regressions',
    role: 'su',
    principal: { kind: 'agent', slug: 'su-noncode-author', workspaceId: WS },
    gateBypass: { role: true, capability: true, quota: true },
    transport: 'mcp',
    requestedFormat: 'json',
    requestedStructured: true,
  } as never;
}

async function call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const projected = lookupByMcpName(tool);
  expect(projected, `${tool} must be registered in the projection registry`).toBeTruthy();
  const d = await runWithWorkspace(WS, () =>
    dispatchProjectedTool(projected!, tool, { harness: HARNESS, ...args }, ctx(), {}));
  const structured = (d.result as { structuredContent?: unknown } | undefined)?.structuredContent;
  let res: Record<string, unknown>;
  if (structured && typeof structured === 'object') res = structured as Record<string, unknown>;
  else {
    const text = (d.result as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text;
    try {
      res = text ? (JSON.parse(text) as Record<string, unknown>) : { error: d.error ?? null };
    } catch {
      res = { text };
    }
  }
  const results = (res as { results?: Record<string, unknown>[] }).results;
  return (Array.isArray(results) && results[0]) || res;
}

function brief(x: unknown): string {
  return JSON.stringify(x).slice(0, 1500);
}

type Mapping = { id: string; requirement: string; planTargets: string[] };

/** Record an activation audit over the plan's current content, with the given mappings. */
async function auditActivation(slug: string, mappings: Mapping[]): Promise<void> {
  const [row] = await admin<{ content: string }[]>`
    SELECT content FROM harness_shared.harness_plans
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`;
  expect(row, `plan ${slug} must exist`).toBeTruthy();
  auditSeq += 1;
  const activation = {
    sourceRanges: [],
    mappings: mappings.map((m) => ({ ...m, sourceRefs: [], disposition: 'covered' })),
    repairedOmissions: [],
    rejectedOrSuperseded: [],
    unresolvedBlockers: [],
  };
  await admin`
    INSERT INTO harness_shared.plan_audits
      (workspace_id, harness_slug, plan_slug, audit_seq, created_by, audit_kind,
       activation, audited_plan_revision_id, audited_plan_revision_seq,
       audited_plan_content_hash, items, findings)
    VALUES
      (${WS}, ${HARNESS}, ${slug}, ${auditSeq}, 'su-test', 'activation',
       ${JSON.stringify(activation)}::text::jsonb,
       ${auditSeq}, ${auditSeq}, ${hashPlanContent(row!.content)}, '[]'::jsonb, '[]'::jsonb)`;
}

type ItemSpec = { text: string; deliverable?: 'code' | 'doc' | 'decision' | 'research' | 'operation' };

/** A plan with the given items, an activation audit carrying `mappings`, and every item done. */
async function makeFinishedPlan(
  slug: string,
  profile: 'coding' | 'general',
  items: ItemSpec[],
  mappings: Mapping[] = [],
): Promise<void> {
  const created = await call('plans:new', { slug, title: `Noncode ${slug}`, verificationProfile: profile, force: true });
  expect(created.ok, brief(created)).toBe(true);
  const added = await call('plans:add-item', { slug, phase: 'Phase 1', importance: 'normal', items });
  expect(added.ok, brief(added)).toBe(true);
  await auditActivation(slug, mappings);
  for (let i = 1; i <= items.length; i += 1) {
    const item = `P-${String(i).padStart(3, '0')}`;
    const res = await call('plans:set-status', { slug, item, status: 'done', note: 'fixture: delivered' });
    expect(res.ok, brief(res)).toBe(true);
  }
}

type Citation = Record<string, unknown>;

const EXTERNAL: Citation = { kind: 'external', url: 'https://example.com/vendor-memo', snapshotHash: 'b'.repeat(64) };
const ARTIFACT: Citation = { kind: 'artifact', ref: `plan:${EVIDENCE_PLAN}` };

/** One completion audit through the real `plans:audit` tool; it stamps what ship compares. */
async function auditCompletion(slug: string, items: Record<string, Citation[]>): Promise<Record<string, unknown>> {
  return call('plans:audit', {
    slug,
    phase: 'completion',
    items: Object.entries(items).map(([itemId, citations]) => ({ itemId, verdict: 'implemented', citations })),
  });
}

async function blockerCodes(slug: string): Promise<{ codes: string[]; messages: string }> {
  const verdict = await runWithWorkspace(WS, () =>
    evaluatePlanAcceptanceGate(slug, { harnessSlug: HARNESS, collectAllBlockers: true }));
  const list = verdict.satisfied ? [] : (verdict.blockers ?? []);
  return { codes: list.map((b) => b.code), messages: JSON.stringify(list) };
}

/**
 * Refusal families every plan owes whatever its profile (the acceptance ceremony, blind review,
 * independent verification). Same list as general-plan-ship.integration.test.ts.
 */
const PROFILE_INDEPENDENT = new RegExp(
  '^(' +
    [
      'acceptance_rubric_missing', 'acceptance_rubric_ambiguous', 'acceptance_rubric_unvetted',
      'acceptance_rubric_revision_unreadable', 'acceptance_rubric_vetted_after_grading',
      'acceptance_lineage_unreadable', 'acceptance_ungraded', 'self_graded_only', 'acceptance_bar_not_met',
      'acceptance_not_recorded', 'acceptance_bar_contract_not_ready',
    ].join('|') +
    ')$|^(blind_review_|independent_verification_)',
);

/**
 * The code-truth refusals (JSON) that make a done code item unshippable. plans:audit records no
 * entry for a code item cited only with generic evidence, so the gate may report the item as
 * audit_coverage_stale ('no audit entry') rather than code_deliverable_unverified. Either way it
 * is refused by name.
 */
const CODE_TRUTH = new Set([
  'code_deliverable_unverified', 'implemented_without_code', 'audit_coverage_stale',
  'audit_citations_unresolved', 'acceptance_unaudited',
]);
async function codeTruthRefusals(slug: string): Promise<string> {
  const verdict = await runWithWorkspace(WS, () =>
    evaluatePlanAcceptanceGate(slug, { harnessSlug: HARNESS, collectAllBlockers: true }));
  const list = verdict.satisfied ? [] : (verdict.blockers ?? []);
  return JSON.stringify(list.filter((b) => CODE_TRUTH.has(b.code)).map((b) => ({ code: b.code, message: b.message })));
}

async function codeDeliverableOf(slug: string, itemId: string): Promise<boolean | undefined> {
  const map = await runWithWorkspace(WS, () =>
    readClauseCodeDeliverables({ harnessSlug: HARNESS, workspaceId: WS, clauses: [{ planSlug: slug, planItemId: itemId }] }));
  return map.get(clauseDeliverableKey(slug, itemId));
}

function clause(slug: string, over: Partial<SpecClauseRevision> = {}): SpecClauseRevision {
  return {
    planSlug: slug,
    specId: 'SPEC-P-001',
    sourceValId: 'VAL-P-001',
    currentRevision: 1,
    revision: 1,
    planItemId: 'P-001',
    behavior: 'The supplier inventory lists every active contract.',
    behaviorClass: 'happy-path',
    // No fixture named: 'integration fixture' declares fixture use, which makes fixture
    // calibration applicable whatever the deliverable is (see spec-test-adequacy.test.ts P-004).
    requiredEvidence: ['reviewed runbook'],
    requiredTestLayers: ['integration'],
    mutationRequired: false,
    lifecycleStatus: 'active',
    supersedes: null,
    exemption: null,
    falsifier: null,
    contentHash: 'sha256:noncode-v1',
    createdBy: 'su-test',
    createdAt: '2026-10-20T00:00:00.000Z',
    acceptedBy: 'reviewer',
    acceptedAt: '2026-10-20T00:01:00.000Z',
    acceptanceRef: 'D-001',
    ...over,
  };
}

/** The evidence a non-code deliverable honestly has: a manual observation, no test run. */
function manualEvidence(slug: string, specId = 'SPEC-P-001'): SpecEvidenceForAdequacy {
  return {
    // A real work-item id: lineage is durable only for a ref matching the durable work-item form.
    workItemId: 'WI-6554700010017307',
    planSlug: slug,
    specId,
    specRevision: 1,
    specFingerprint: 'sha256:noncode-v1',
    evidenceKind: 'manual',
    evidenceRef: 'work-item:WI-6554700010017307',
    fingerprints: {
      sourceFingerprint: 'git:abc', testFingerprint: null, fixtureFingerprint: null,
      rubricFingerprint: null, environmentFingerprint: null,
    },
    coverageEvidenceRef: null,
    testRunId: null,
    details: {
      adequacy: {
        fixtureCalibrated: true, falsifiable: true, pathReachable: true,
        oracleIndependent: true, collected: true, skipped: false, executed: true, outcome: 'passed', targeted: true,
      },
    },
    currentness: {
      comparisonSupplied: true,
      provenance: 'server-measured',
      overall: 'current',
      dimensions: {
        spec: 'current', source: 'current', test: 'current', fixture: 'current',
        rubric: 'current', environment: 'current', coverageEvidence: 'current', testRun: 'current',
      },
      staleReasons: [],
      unknownReasons: [],
    },
  };
}

beforeAll(async () => {
  fx = await setupPlanPgFixture({ isolated: true });
  admin = fx.admin;
  await registerHarnessProject(admin, WS, HARNESS);
  const evidencePlan = await call('plans:new', { slug: EVIDENCE_PLAN, title: 'Vendor comparison memo', verificationProfile: 'general', force: true });
  expect(evidencePlan.ok, brief(evidencePlan)).toBe(true);
}, 180_000);

afterAll(async () => {
  if (admin) {
    await admin`DELETE FROM harness_shared.plan_audits WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}`.catch(() => {});
    await cleanupPlans(admin, WS, HARNESS).catch(() => {});
  }
  await fx?.dispose();
});

describe('requirement realization: a covered requirement on a non-code item is realized by generic evidence', () => {
  const items: ItemSpec[] = [
    { text: 'Record the supplier inventory census' },
    { text: 'Consolidate the duplicate vendor records' },
    { text: 'Write the vendor onboarding runbook', deliverable: 'doc' },
  ];
  const mappings: Mapping[] = [
    // WI-6554700010015803: an explicitly manual requirement, discharged by a completed item.
    { id: 'M-001', requirement: 'The supplier census is recorded by hand.', planTargets: ['P-001'] },
    // EI-25749234179776072: an administrative outcome that, by decision, has no acceptance BAR.
    { id: 'M-002', requirement: 'Duplicate vendor records are consolidated.', planTargets: ['P-002'] },
    // EI-25803818621690104: a docs item that is the target of a covered mapping.
    { id: 'M-003', requirement: 'Onboarding is documented.', planTargets: ['P-003'] },
  ];

  it('raises no requirement_unrealized for any of the three replayed shapes', async () => {
    const slug = 'zzz-noncode-realized-2026-10-20';
    await makeFinishedPlan(slug, 'general', items, mappings);
    const audit = await auditCompletion(slug, { 'P-001': [EXTERNAL], 'P-002': [EXTERNAL], 'P-003': [ARTIFACT] });
    expect(audit.ok, brief(audit)).toBe(true);

    const { codes, messages } = await blockerCodes(slug);
    expect(codes, messages).not.toContain('requirement_unrealized');
    expect(codes.filter((code) => !PROFILE_INDEPENDENT.test(code)), messages).toEqual([]);
  });

  // CONTROL: the realization check is still on. The same plan with the docs item cited by
  // nothing is refused for exactly that item, so the case above is the evidence's doing.
  it('control: the same mappings with an uncited docs item are refused requirement_unrealized', async () => {
    const slug = 'zzz-noncode-unrealized-2026-10-20';
    await makeFinishedPlan(slug, 'general', items, mappings);
    const audit = await auditCompletion(slug, { 'P-001': [EXTERNAL], 'P-002': [EXTERNAL], 'P-003': [] });
    // The audit may refuse an uncited implemented item itself; either refusal is the control.
    if (audit.ok === true) {
      const { codes, messages } = await blockerCodes(slug);
      expect(codes, messages).toContain('requirement_unrealized');
      expect(messages).toContain('P-003');
    } else {
      expect(brief(audit)).toMatch(/P-003/);
    }
  });
});

describe('ship gate: non-code outcomes are not asked for code containment', () => {
  // EI-25335518570307363: a non-code rubric outcome was asked for server source/test containment.
  it('raises no code-only refusal for a general plan whose items cite only generic evidence', async () => {
    const slug = 'zzz-noncode-no-containment-2026-10-20';
    await makeFinishedPlan(slug, 'general', [
      { text: 'Publish the acceptance rubric outcome report', deliverable: 'research' },
      { text: 'Decide the vendor shortlist', deliverable: 'decision' },
    ]);
    const audit = await auditCompletion(slug, { 'P-001': [ARTIFACT], 'P-002': [EXTERNAL] });
    expect(audit.ok, brief(audit)).toBe(true);
    const { codes, messages } = await blockerCodes(slug);
    expect(codes.filter((code) => !PROFILE_INDEPENDENT.test(code)), messages).toEqual([]);
  });

  // EI-25342785339330316 runs the other way: code work inherited the non-code exemption. In a
  // general plan a declared code item still owes code verification at ship.
  it('refuses a declared code item in a general plan that cites only generic evidence', async () => {
    const slug = 'zzz-noncode-code-item-2026-10-20';
    await makeFinishedPlan(slug, 'general', [
      { text: 'Write the vendor onboarding runbook' },
      { text: 'Ship the account import script', deliverable: 'code' },
    ]);
    const audit = await auditCompletion(slug, { 'P-001': [EXTERNAL], 'P-002': [EXTERNAL] });
    if (audit.ok === true) {
      const refusals = await codeTruthRefusals(slug);
      expect(refusals, refusals).not.toBe('[]');
      expect(refusals).toContain('P-002');
      // CONTROL inside the case: the undeclared runbook item on the same evidence is not refused.
      expect(refusals).not.toMatch(/P-001\b/);
    } else {
      // The audit refuses generic-only evidence for a declared code deliverable (D-006).
      expect(brief(audit)).toMatch(/P-002/);
      expect(brief(audit)).not.toMatch(/P-001\b[^"]*implemented_without_code/);
    }
  });
});

describe('proof floor and spec-test adequacy read the deliverable from Postgres', () => {
  const generalSlug = 'zzz-noncode-adequacy-general-2026-10-20';
  const codingSlug = 'zzz-noncode-adequacy-coding-2026-10-20';
  const adequacyItems: ItemSpec[] = [
    { text: 'Record the supplier inventory census' },
    { text: 'Triage the vendor complaints to a disposition' },
  ];

  beforeAll(async () => {
    await makeFinishedPlan(generalSlug, 'general', adequacyItems);
    await makeFinishedPlan(codingSlug, 'coding', adequacyItems);
  }, 120_000);

  it('reads both general-plan items as non-code and both coding-plan items as code', async () => {
    expect(await codeDeliverableOf(generalSlug, 'P-001')).toBe(false);
    expect(await codeDeliverableOf(generalSlug, 'P-002')).toBe(false);
    expect(await codeDeliverableOf(codingSlug, 'P-001')).toBe(true);
    expect(await codeDeliverableOf(codingSlug, 'P-002')).toBe(true);
  });

  // EI-25354905476476419: runtime BAR proof was demanded from explicitly exempt inventory scope.
  // A BAR-projected clause with a mutation-required runtime layer on the inventory item.
  it('requires no executable proof floor for an inventory clause in a general plan', async () => {
    const projected = clause(generalSlug, { mutationRequired: true, requiredTestLayers: ['integration', 'e2e'] });
    const floor = requiredProofFloor(projected, 'plan-class-general', undefined, await codeDeliverableOf(generalSlug, 'P-001'));
    expect(floor).toBe('none');

    const control = clause(codingSlug, { mutationRequired: true, requiredTestLayers: ['integration', 'e2e'] });
    const codeFloor = requiredProofFloor(control, 'plan-class-feature-ship', undefined, await codeDeliverableOf(codingSlug, 'P-001'));
    expect(codeFloor).not.toBe('none');
  });

  // EI-23793489732627099: a non-code clause (a triage-to-disposition item) projected with a
  // behavior class that would require L3/L4 could never reach an all-pass verdict.
  it('grades a layered triage clause pass on manual evidence in a general plan', async () => {
    const triage = clause(generalSlug, { specId: 'SPEC-P-002', planItemId: 'P-002', behavior: 'Every complaint reaches a disposition.' });
    const result = evaluateSpecTestAdequacy({
      clause: triage,
      evidence: [manualEvidence(generalSlug, 'SPEC-P-002')],
      classRef: 'plan-class-general',
      codeDeliverable: await codeDeliverableOf(generalSlug, 'P-002'),
    });
    expect(result.ratings['correct-layer'].rating).toBe('not-applicable');
    expect(result.wouldBlock, brief(result.ratings)).toEqual([]);
    expect(result.verdict).toBe('pass');
  });

  it('control: the same triage clause and evidence in a coding plan does not pass', async () => {
    const triage = clause(codingSlug, { specId: 'SPEC-P-002', planItemId: 'P-002', behavior: 'Every complaint reaches a disposition.' });
    const result = evaluateSpecTestAdequacy({
      clause: triage,
      evidence: [manualEvidence(codingSlug, 'SPEC-P-002')],
      classRef: 'plan-class-feature-ship',
      codeDeliverable: await codeDeliverableOf(codingSlug, 'P-002'),
    });
    expect(result.verdict).not.toBe('pass');
  });

  // EI-25355398614298321: explicit, current non-automated exempt clauses could not be graded
  // (the evaluator found no executable binding to select). A non-code deliverable owes no
  // executable binding: its honest manual evidence grades pass.
  it('grades a non-automated exempt inventory clause pass on its manual evidence', async () => {
    const exempt = clause(generalSlug, {
      behaviorClass: 'non-automated',
      lifecycleStatus: 'exempt',
      requiredEvidence: [],
      requiredTestLayers: [],
      exemption: {
        justification: 'Read-only inventory of supplier contracts; no runtime behavior.',
        provenance: 'D-001',
      } as SpecClauseRevision['exemption'],
    });
    const result = evaluateSpecTestAdequacy({
      clause: exempt,
      evidence: [manualEvidence(generalSlug)],
      classRef: 'plan-class-general',
      codeDeliverable: await codeDeliverableOf(generalSlug, 'P-001'),
    });
    expect(result.wouldBlock, brief(result.ratings)).toEqual([]);
    expect(result.verdict).toBe('pass');
  });
});

describe('plans:add-item declares a non-code deliverable at definition time', () => {
  // EI-25459145080002565: a docs deliverable could only be registered as work-item kind `task`
  // (work_items:create kind 'docs' is unknown_kind). The deliverable is now declared on the
  // plan item itself.
  it('accepts deliverable doc, stores it, and resolves it as non-code even in a coding plan', async () => {
    const slug = 'zzz-noncode-declared-doc-2026-10-20';
    const created = await call('plans:new', { slug, title: 'Noncode declared doc', verificationProfile: 'coding', force: true });
    expect(created.ok, brief(created)).toBe(true);
    const added = await call('plans:add-item', {
      slug, phase: 'Phase 1', importance: 'normal',
      items: [{ text: 'Write the plan-authoring guide', deliverable: 'doc' }, { text: 'Build the exporter' }],
    });
    expect(added.ok, brief(added)).toBe(true);
    expect(brief(added)).not.toContain('unknown_kind');

    const rows = await admin<{ item_id: string; deliverable: string | null }[]>`
      SELECT item_id, deliverable FROM harness_shared.plan_items
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}
       ORDER BY item_id`;
    expect(rows.map((r) => [r.item_id, r.deliverable])).toEqual([['P-001', 'doc'], ['P-002', null]]);
    expect(await codeDeliverableOf(slug, 'P-001')).toBe(false);
    // CONTROL: the undeclared sibling keeps the coding default.
    expect(await codeDeliverableOf(slug, 'P-002')).toBe(true);
  });
});

/**
 * R-19 (P-007): the mixed end-to-end flow. A CODING plan whose code item cites code and whose
 * declared doc item cites only an artifact goes through the real plans:audit and the real
 * plans:set-plan-status shipped. Same ceremony switches as general-plan-ship's 'ships once the
 * profile-independent ceremony is out of the way': the acceptance-rubric gate is turned off
 * because grading is profile-independent and covered there (R-12), and the per-plan blind gap
 * review stays ON and is satisfied by a real counted review from an agent outside the plan's
 * implementer population. The positive case must actually ship; no alternative outcome passes.
 */
describe('R-19: a coding plan whose doc items cite artifacts ships', () => {
  const RUBRIC_GATE_ENV = 'PAPERCUSP_FLAG_PAPERCUSP_ACCEPTANCE_RUBRIC_COMPLETION_GATE';
  const REAL_CODE: Citation = { kind: 'code', path: 'packages/operator-core/lib/plan-acceptance-gate.ts' };
  /** An agent outside the plan's implementer population that has never read the plan. */
  const BLIND_REVIEWER = 'su-noncode-blind-reviewer';
  let prevRubricGateEnv: string | undefined;

  /**
   * Record a counted blind gap review with no gaps for the plan's latest activation audit, through
   * the real `plans:blind-review` handler. Asserts the review counts and satisfies the door, so a
   * later ship refusal cannot be the blind review.
   */
  async function recordBlindReview(slug: string): Promise<void> {
    const reviewerCtx = {
      log: () => {},
      progress: () => {},
      metadata: () => {},
      emit: () => {},
      signal: new AbortController().signal,
      workspaceId: WS,
      principal: { kind: 'agent', slug: BLIND_REVIEWER, workspaceId: WS },
      ownerId: BLIND_REVIEWER,
      coordOwnerId: BLIND_REVIEWER,
    } as never;
    const res = (await runWithWorkspace(WS, () => blindReviewTool.handler(
      { harness: HARNESS, slug, op: 'post', gaps: [] } as never, reviewerCtx,
    ))) as { content?: Array<{ text: string }> };
    const posted = JSON.parse(res.content?.[0]?.text ?? '{}') as Record<string, unknown>;
    expect(posted, brief(posted)).toMatchObject({ ok: true, counts: true, door: { satisfied: true } });
  }

  beforeAll(async () => {
    prevRubricGateEnv = process.env[RUBRIC_GATE_ENV];
    __resetRubricSeedStateForTests();
    await runWithWorkspace(WS, () => ensureFirstPartyRubricsSeeded());
  }, 120_000);

  afterEach(() => {
    if (prevRubricGateEnv === undefined) delete process.env[RUBRIC_GATE_ENV];
    else process.env[RUBRIC_GATE_ENV] = prevRubricGateEnv;
  });

  async function storedStatus(slug: string): Promise<string | null> {
    const [row] = await admin<{ status: string | null }[]>`
      SELECT status FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = ${slug}`;
    return row?.status ?? null;
  }

  it('ships a coding plan whose code item cites code and whose doc item cites an artifact', async () => {
    process.env[RUBRIC_GATE_ENV] = '0';
    const slug = 'zzz-noncode-mixed-ships-2026-10-20';
    await makeFinishedPlan(slug, 'coding', [
      { text: 'Build the supplier exporter' },
      { text: 'Write the exporter runbook', deliverable: 'doc' },
    ]);
    expect(await codeDeliverableOf(slug, 'P-001')).toBe(true);
    expect(await codeDeliverableOf(slug, 'P-002')).toBe(false);

    const audit = await auditCompletion(slug, { 'P-001': [REAL_CODE], 'P-002': [ARTIFACT] });
    expect(audit.ok, brief(audit)).toBe(true);
    await recordBlindReview(slug);
    const { codes, messages } = await blockerCodes(slug);
    expect(codes, messages).toEqual([]);

    const res = await call('plans:set-plan-status', { slug, status: 'shipped' });
    expect(res.ok, brief(res)).toBe(true);
    expect(await storedStatus(slug)).toBe('shipped');
  });

  it('control: the same plan with the runbook undeclared does not ship on its artifact citation', async () => {
    process.env[RUBRIC_GATE_ENV] = '0';
    const slug = 'zzz-noncode-mixed-undeclared-2026-10-20';
    await makeFinishedPlan(slug, 'coding', [
      { text: 'Build the supplier exporter' },
      { text: 'Write the exporter runbook' },
    ]);
    expect(await codeDeliverableOf(slug, 'P-002')).toBe(true);
    // Same ceremony as the positive case, so the only variable is the undeclared deliverable.
    await recordBlindReview(slug);

    const audit = await auditCompletion(slug, { 'P-001': [REAL_CODE], 'P-002': [ARTIFACT] });
    if (audit.ok === true) {
      const refusals = await codeTruthRefusals(slug);
      expect(refusals, refusals).not.toBe('[]');
      expect(refusals).toContain('P-002');
      expect(refusals).not.toMatch(/P-001\b/);
      const res = await call('plans:set-plan-status', { slug, status: 'shipped' });
      expect(res.ok, brief(res)).not.toBe(true);
      expect(String(res.error ?? res.code ?? ''), brief(res)).not.toMatch(PROFILE_INDEPENDENT);
    } else {
      expect(brief(audit)).toMatch(/P-002/);
    }
    expect(await storedStatus(slug)).not.toBe('shipped');
  });
});
