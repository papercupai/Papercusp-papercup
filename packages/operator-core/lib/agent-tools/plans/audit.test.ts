/**
 * plans:audit writer-contract guard (plan-completion-audit-and-acceptance-verdict
 * D-008). These are handler/schema tests, not just coverage-fold tests: they pin
 * the exact boundary that decides whether an auditor actually read code.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { lookupByMcpName } from '@papercusp/agent-mcp';

const { mockOrgSql, mockOrgSqlArray } = vi.hoisted(() => {
  const mockOrgSql = vi.fn();
  const mockOrgSqlArray = vi.fn((values: unknown[]) => values);
  (mockOrgSql as unknown as { array: typeof mockOrgSqlArray }).array = mockOrgSqlArray;
  return { mockOrgSql, mockOrgSqlArray };
});

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: mockOrgSql }) };
});
vi.mock('../_harness-scope', async (orig) => ({
  ...(await orig<typeof import('../_harness-scope')>()),
  harnessScopedCtx: (_h: unknown, ctx: unknown) => ctx,
}));
vi.mock('./slug-scope', async (orig) => ({
  ...(await orig<typeof import('./slug-scope')>()),
  recoverHarnessFromSlugs: vi.fn(),
}));
vi.mock('./_ctx-opts', () => ({ resolveCtxHarnessSlug: () => 'papercusp' }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: () => ({ ownerId: 'su-auditor' }),
}));
vi.mock('../coordination/plan-events', () => ({ emitPlanEventForCaller: vi.fn(async () => {}) }));
vi.mock('../sessions/_shared', async (orig) => {
  const actual = await orig<typeof import('../sessions/_shared')>();
  return { ...actual, resolveSessionTurnRefs: vi.fn() };
});
vi.mock('../../plan-audits', async (orig) => {
  const actual = await orig<typeof import('../../plan-audits')>();
  return {
    ...actual,
    getPlanItemStatuses: vi.fn(),
    // The real helper reads harness_plans through getOrgPg (WI-10005174).
    resolvePlanItemHomeHarness: vi.fn(),
    getEffectiveItemAudits: vi.fn(),
    getLatestActivationAudit: vi.fn(),
    repoCitationContextForHarness: vi.fn(),
    recordPlanAudit: vi.fn(),
    recordCurrentActivationAudit: vi.fn(),
    previewCurrentActivationAudit: vi.fn(),
  };
});
vi.mock('./activation-audit-repair', () => ({
  ensureActivationAuditRepairFiling: vi.fn(),
}));
// `./source` is mocked wholesale, so the factory must cover EVERY export this
// test's import graph reaches — not just the ones audit.ts itself calls.
// add-decision.ts (pulled in via rubrics.ts) imports VALID_PLAN_SLUG, and a
// partial factory makes that read `undefined` and crashes collection before a
// single test runs. The literal is inlined because vi.mock factories are
// hoisted and may not close over top-level variables; keep it in step with the
// real export in ./source.ts.
vi.mock('./source', () => ({
  getPlanRow: vi.fn(),
  VALID_PLAN_SLUG: /^(?:[A-Za-z0-9._-]+|[A-Za-z0-9._-]+@run-\d+)$/,
}));
vi.mock('./spec-clauses-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./spec-clauses-store')>()),
  setSpecClause: vi.fn(),
}));
vi.mock('./get-activation-readiness', () => ({
  previewPlanStartConsult: vi.fn(),
}));
// plan-item-provenance-2026-09-29 P-002: this file's activation fixtures cite turns the
// shared mockOrgSql never returns rows for. Classify every cited ref as owner-typed so
// these tests keep measuring what they were written for; the reverse item-provenance
// check itself (including the real session_turns lookup) is covered by
// audit-item-provenance.test.ts.
vi.mock('../../activation-item-provenance', async (orig) => ({
  ...(await orig<typeof import('../../activation-item-provenance')>()),
  dbRefOriginLookup: () => async (refs: readonly string[]) =>
    new Map(refs.map((ref) => [ref, 'owner-typed' as const])),
}));
// plan-verification-friction-reduction-2026-10-11 P-003: the activation classRef resolver
// reads the plan's acceptance rubric (its persisted class) and its latest spec-quality
// scorecard. beforeEach defaults both to empty, so a supplied classRef passes unchanged.
vi.mock('../../rubrics', async (orig) => ({
  ...(await orig<typeof import('../../rubrics')>()),
  getAcceptanceRubricsForPlan: vi.fn(),
}));
vi.mock('../../scorecards', async (orig) => ({
  ...(await orig<typeof import('../../scorecards')>()),
  listScorecards: vi.fn(),
}));

import {
  CitationGitReadError,
  getEffectiveItemAudits,
  getLatestActivationAudit,
  getPlanItemStatuses,
  recordCurrentActivationAudit,
  previewCurrentActivationAudit,
  recordPlanAudit,
  repoCitationContextForHarness,
  resolvePlanItemHomeHarness,
} from '../../plan-audits';
import { ensureActivationAuditRepairFiling } from './activation-audit-repair';
import { getPlanRow } from './source';
import { setSpecClause } from './spec-clauses-store';
import { previewPlanStartConsult } from './get-activation-readiness';
import { resolveSessionTurnRefs } from '../sessions/_shared';
import { emitPlanEventForCaller } from '../coordination/plan-events';
import { recoverHarnessFromSlugs } from './slug-scope';
import { BUDGET, promptWeight } from '../tool-guidance-budget';
import { productShapingScaffold } from './product-shaping';
import { getAcceptanceRubricsForPlan } from '../../rubrics';
import { listScorecards } from '../../scorecards';
import { SPEC_QUALITY_RUBRIC_REF, specQualitySubjectRef } from './spec-quality';
import type { PlanClassRubricRef } from './spec-test-adequacy';
import tool from './audit';

const mockItems = vi.mocked(getPlanItemStatuses);
const mockResolveHome = vi.mocked(resolvePlanItemHomeHarness);
const mockPrevious = vi.mocked(getEffectiveItemAudits);
const mockPreviousActivation = vi.mocked(getLatestActivationAudit);
const mockContext = vi.mocked(repoCitationContextForHarness);
const mockRecord = vi.mocked(recordPlanAudit);
const mockRecordActivation = vi.mocked(recordCurrentActivationAudit);
const mockPreviewActivation = vi.mocked(previewCurrentActivationAudit);
const mockResolveSourceRefs = vi.mocked(resolveSessionTurnRefs);
const mockRepairFiling = vi.mocked(ensureActivationAuditRepairFiling);
const mockGetPlanRow = vi.mocked(getPlanRow);
const mockSetSpecClause = vi.mocked(setSpecClause);
const mockRecoverHarness = vi.mocked(recoverHarnessFromSlugs);
const mockPreviewPlanStartConsult = vi.mocked(previewPlanStartConsult);
const mockEmitPlanEvent = vi.mocked(emitPlanEventForCaller);
const mockAcceptanceRubrics = vi.mocked(getAcceptanceRubricsForPlan);
const mockListScorecards = vi.mocked(listScorecards);

const ctx = {
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  role: 'operator',
  workspaceId: 'test-workspace',
  tx: vi.fn(),
} as never;

const body = async (items: Array<Record<string, unknown>>, over: Record<string, unknown> = {}) =>
  ((await tool.handler({ slug: 'plan-a', harness: 'papercusp', items, ...over } as never, ctx)) as { data: any }).data;

beforeEach(() => {
  vi.clearAllMocks();
  mockAcceptanceRubrics.mockResolvedValue([]);
  mockListScorecards.mockResolvedValue([]);
  mockItems.mockResolvedValue([{ itemId: 'P-001', status: 'done', itemText: 'ship the audit gate' }]);
  mockResolveHome.mockResolvedValue(null);
  mockSetSpecClause.mockResolvedValue({
    status: 'created',
    specId: 'AUTO-REQ-M-001-P-001',
    revision: 1,
    contentHash: 'c'.repeat(64),
  });
  mockPrevious.mockResolvedValue([]);
  mockPreviousActivation.mockResolvedValue(null);
  mockContext.mockResolvedValue({
    repoRoot: '/repo',
    rootSource: 'canonical-repo',
    deps: {
      statFile: (path) => (path === 'src/gate.ts' ? { isFile: true } : null),
      readFile: (path) => (path === 'src/gate.ts' ? 'export const gate = true;\n' : null),
      blobSha: (path) => (path === 'src/gate.ts' ? '0123456789012345678901234567890123456789' : null),
    },
  });
  mockRecord.mockResolvedValue({ auditSeq: 1, auditedSha: 'head-1' } as Awaited<ReturnType<typeof recordPlanAudit>>);
  mockResolveSourceRefs.mockResolvedValue([
    { ref: 'session_turn:codex:session-full-id:7', ok: true, source: 'index' },
  ]);
  mockRecordActivation.mockResolvedValue({
    ok: true,
    audit: { auditSeq: 2 } as never,
    auditedPlanRevision: { id: 41, seq: 6, contentHash: 'a'.repeat(64) },
  });
  mockPreviewActivation.mockResolvedValue({
    ok: true, preview: true,
    auditedPlanRevision: { id: 41, seq: 6, contentHash: 'a'.repeat(64) },
  });
  mockPreviewPlanStartConsult.mockResolvedValue({
    outcome: 'proceed',
    verdict: 'no_qualified_responder',
  });
  mockRepairFiling.mockResolvedValue({
    conditionKey: 'activation-audit:papercusp/plan-a',
    id: 'EI-ACTIVATION-REPAIR',
    created: true,
  });
  resolvePlanContent(
    `---\ntitle: Plan A\nslug: plan-a\nstatus: draft\ncreated: 2026-08-27\nupdated: 2026-08-27\nowner: test\n---\n\n## Items\n\n- **P-001** \`todo\` Implement the audit gate on staging.\n`,
  );
});

describe('plans:audit exact-slug scope recovery', () => {
  it('recovers the owning harness for a workspace-scoped call that omits harness', async () => {
    mockRecoverHarness.mockResolvedValue({
      status: 'resolved',
      harnessSlug: 'papercusp',
      bySlug: { 'plan-a': 'papercusp' },
    });

    const result = await tool.handler({
      slug: 'plan-a',
      items: [{ itemId: 'P-001', verdict: 'implemented', citations: [{ kind: 'code', path: 'src/gate.ts', symbol: 'gate' }] }],
    } as never, { ...(ctx as never as Record<string, unknown>), harnessSlug: '*' } as never) as { data: any };

    expect(result.data).toMatchObject({
      ok: true,
      slug: 'plan-a',
      coverage: { auditedItems: 1, verifiedItems: 1 },
    });
    expect(mockRecoverHarness).toHaveBeenCalledWith(
      expect.objectContaining({ harnessSlug: '*' }),
      ['plan-a'],
    );
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ harnessSlug: 'papercusp' }));
  });
});

const activationArgs = (over: Record<string, unknown> = {}) => ({
  slug: 'plan-a',
  harness: 'papercusp',
  phase: 'activation',
  classRef: 'plan-class-bugfix',
  sourceRanges: [{ sourceKind: 'codex', sessionId: 'session-full-id', fromTurn: 0, toTurn: 20 }],
  mappings: [{
    id: 'M-001',
    sourceRefs: ['session_turn:codex:session-full-id:7'],
    requirement: 'activation requires a complete source audit',
    planTargets: ['P-001'],
    disposition: 'covered',
  }],
  repairedOmissions: [],
  rejectedOrSuperseded: [],
  unresolvedBlockers: [],
  ...over,
});

/**
 * Single seam for the getPlanRow fixture. PlanRow is ~30 columns wide while these
 * tests read only `content`, so the partial fixture needs one cast — kept HERE, in
 * one place, rather than re-spelled at every call site (lint:mock-cast-escape).
 */
const resolvePlanContent = (content: string): void => {
  mockGetPlanRow.mockResolvedValue({ content } as never);
};

// EI-23806095672871173 fixtures. Both carry P-001 so plan-target validation passes
// and the BAR gate is the only thing under test, and both carry a valid
// `## Requirements` so parseRequirementBars succeeds — that is what makes the
// refusal land on `bar_mapping_missing` (the exact reported code) rather than on
// `bar_requirements_missing`.
const barPlanWithoutDesign = `---
title: Plan A
slug: plan-a
status: draft
created: 2026-08-27
updated: 2026-08-27
owner: test
---

## Requirements

**R-1 — Persist the canonical promise.** One acceptance criterion remains the BAR authority.

## Items

- **P-001** \`todo\` Implement the audit gate on staging.
`;

const barPlanWithDesign = `${barPlanWithoutDesign}
## Design

### Bar-to-work map for this plan

| bar | implementing plan items | evidence plane |
|---|---|---|
| R-1 | P-001 | tree |
`;

// review-system-rework-reduction P-003: a never-seeded post-epoch plan must carry a complete
// METHOD/check/layer contract for the activation writer (and so its preview) to accept it.
const barPlanCompleteWithDesign = barPlanWithDesign.replace(
  '**R-1 — Persist the canonical promise.** One acceptance criterion remains the BAR authority.',
  '**R-1 — Persist the canonical promise.**\n```requirement\n' + JSON.stringify({
    intent: { request: 'Keep one BAR authority.' },
    acceptance: { condition: 'One acceptance criterion remains the BAR authority.',
      falsifier: 'A second criterion claims the same BAR.', requiredTestLayers: ['unit'] },
    verification: { method: 'Run the focused audit test.',
      check: { kind: 'tests', files: ['packages/operator-core/lib/agent-tools/plans/audit.test.ts'] } },
  }) + '\n```',
);

// spec-conformance-loop-2026-10-14 R-1 / D-003: the activation gate refuses every
// plan whose requirement compiles to no executable check, BAR epoch or not. The prose
// fixtures above exercise the BAR map, not conformance, so this variant gives R-1 a
// runnable `violatedWhen` falsifier (outside the requirement block, so the BAR hash is
// unchanged) and leaves the BAR behaviour under test exactly as it was.
const withR1Conformance = (planContent: string) => `${planContent}
## Conformance

\`\`\`conformance
${JSON.stringify({ requirements: { 'R-1': { violatedWhen: [{
    id: 'second-bar-authority',
    failureMode: 'A second criterion claims the same BAR.',
    stage: 'implementation',
    check: { kind: 'tests', files: ['packages/operator-core/lib/agent-tools/plans/audit.test.ts'] },
  }] } } })}
\`\`\`
`;

const COMPLETE_CONVERSATION_OBLIGATION_IDS = [
  'M-001', // requirement
  'M-002', // scope boundary
  'M-003', // constraint
  'M-004', // correction
  'M-005', // rejected alternative
  'M-006', // decision
  'M-007', // dependency
  'M-008', // sequencing
  'M-009', // acceptance condition
  'M-010', // open question
  'M-011', // promised follow-up
] as const;

function missingConversationObligations(mappings: Array<{ id: string; disposition: string }>): string[] {
  const explicitlyAccountedFor = new Set(
    mappings
      .filter((mapping) => mapping.disposition !== 'open')
      .map((mapping) => mapping.id),
  );
  return COMPLETE_CONVERSATION_OBLIGATION_IDS.filter((id) => !explicitlyAccountedFor.has(id));
}

describe('plans:audit D-008 writer contract', () => {
  it('keeps shaping warnings advisory while completion still resolves and records code evidence', async () => {
    resolvePlanContent('# Plan A\n' + productShapingScaffold() + '\n## Items\n- **P-001** `todo` Implement the audit gate.');
    const preview = await tool.handler({ slug: 'plan-a', harness: 'papercusp', phase: 'shaping' } as never, ctx) as { data: any };
    expect(preview.data).toMatchObject({ ok: true, dryRun: true, productShaping: { status: 'incomplete', advisory: true } });
    expect(preview.data.productShaping.diagnostics.length).toBeGreaterThan(0);
    expect(mockRecord).not.toHaveBeenCalled();

    const completion = await body([{ itemId: 'P-001', verdict: 'implemented', citations: [{ kind: 'code', path: 'src/gate.ts', symbol: 'gate' }] }], { phase: 'completion', dryRun: false });
    expect(completion).toMatchObject({ ok: true, coverage: { verifiedItems: 1 } });
    expect(mockContext).toHaveBeenCalled();
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ items: [expect.objectContaining({
      itemId: 'P-001', citations: [expect.objectContaining({ path: 'src/gate.ts', blobSha: expect.any(String) })],
    })] }));

    const activation = await tool.handler(activationArgs() as never, ctx) as { data: any };
    expect(activation.data).toMatchObject({ ok: true, phase: 'activation', sourceRefsResolved: 1 });
    expect(mockResolveSourceRefs).toHaveBeenCalled();
    expect(mockRecordActivation).toHaveBeenCalled();
  });

  it('keeps full completion verification mandatory after an advisory shaping preview', async () => {
    resolvePlanContent('# Plan A\n' + productShapingScaffold() + '\n## Items\n- **P-001** `todo` Implement the audit gate.');
    const preview = await tool.handler({ slug: 'plan-a', harness: 'papercusp', phase: 'shaping' } as never, ctx) as { data: any };
    expect(preview.data.productShaping).toMatchObject({ status: 'incomplete', advisory: true });

    const completion = await body([{ itemId: 'P-001', verdict: 'implemented', citations: [] }], { phase: 'completion', dryRun: false });
    expect(completion).toMatchObject({ ok: false, error: 'audit_invalid' });
    expect(completion.problems).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'uncited_verdict' })]));
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it.each([
    ['doc', { kind: 'doc', ref: '/internal/docs/gate', reason: 'the document describes it' }],
    ['none', { kind: 'none', reason: 'no source was inspected' }],
  ])('refuses implemented backed only by a %s declaration', async (_kind, citation) => {
    const result = await body([{ itemId: 'P-001', verdict: 'implemented', citations: [citation] }]);

    expect(result).toMatchObject({ ok: false, error: 'audit_invalid' });
    expect(result.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ itemId: 'P-001', code: 'implemented_without_code' })]),
    );
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('requires a reason for the metered not-code escape hatch', async () => {
    const result = await body([{ itemId: 'P-001', verdict: 'not-code', citations: [] }]);

    expect(result).toMatchObject({ ok: false, error: 'audit_invalid' });
    expect(result.problems).toEqual(
      expect.arrayContaining([expect.objectContaining({ itemId: 'P-001', code: 'not_code_without_reason' })]),
    );
    expect(mockRecord).not.toHaveBeenCalled();
  });

  // WI-10005174: itemIds are validated against the items of the harness that OWNS the
  // plan. A same-slug plan in another harness must not lend its item ids.
  it('validates itemIds against the items of the resolved home harness only', async () => {
    mockResolveHome.mockResolvedValue('email');
    mockItems.mockImplementation(async (_slug, scope) =>
      scope?.harnessSlug === 'email'
        ? [{ itemId: 'P-001', status: 'done', itemText: 'email item' }]
        : [
            { itemId: 'P-001', status: 'done', itemText: 'email item' },
            { itemId: 'P-009', status: 'done', itemText: 'other harness item' },
          ],
    );

    const result = await body([
      { itemId: 'P-009', verdict: 'not-code', citations: [], note: 'pure process item' },
    ]);

    expect(mockResolveHome).toHaveBeenCalledWith('plan-a', expect.anything());
    expect(mockItems).toHaveBeenCalledWith('plan-a', { harnessSlug: 'email' });
    // P-009 exists only in the other harness's same-slug plan, so it is unknown here.
    expect(result).toMatchObject({ ok: false, error: 'audit_invalid' });
    expect(result.problems).toEqual([expect.objectContaining({ itemId: 'P-009', code: 'unknown_item' })]);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('rejects work-item intent as a citation kind at the live input schema', () => {
    const parsed = tool.args.safeParse({
      slug: 'plan-a',
      items: [{ itemId: 'P-001', verdict: 'implemented', citations: [{ kind: 'workitem', ref: 'WI-1' }] }],
    });

    expect(parsed.success).toBe(false);
  });

  it.each(['code', 'test'] as const)('requires path for ref-only %s citations at the live input schema', (kind) => {
    const parsed = tool.args.safeParse({
      slug: 'plan-a',
      items: [{ itemId: 'P-001', verdict: 'implemented', citations: [{ kind, ref: 'evidence-ref' }] }],
    });

    expect(parsed.success).toBe(false);
  });

  it('admits classRef at both phases of the live input schema (completion ignores it, P-003)', () => {
    const completion = {
      slug: 'plan-a',
      items: [{ itemId: 'P-001', verdict: 'not-code', citations: [], note: 'No code deliverable.' }],
    };

    expect(tool.args.safeParse(completion).success).toBe(true);
    expect(tool.args.safeParse({ ...completion, classRef: 'plan-class-bugfix' }).success).toBe(true);
    expect(tool.args.safeParse({ ...completion, classRef: 'not-a-class' }).success).toBe(false);
    expect(tool.args.safeParse({
      slug: 'plan-a',
      phase: 'activation',
      classRef: 'plan-class-bugfix',
    }).success).toBe(true);
  });

  it('projects path as required for code/test citation branches', () => {
    const projected = lookupByMcpName('plans:audit');
    const schema = projected?.inputSchema as {
      properties?: {
        items?: {
          items?: {
            properties?: {
              citations?: { items?: { anyOf?: Array<{ properties?: { kind?: { const?: string }; path?: unknown }; required?: string[] }> } };
            };
          };
        };
      };
    };
    const branches = schema.properties?.items?.items?.properties?.citations?.items?.anyOf ?? [];
    expect(branches).toEqual(expect.arrayContaining([
      expect.objectContaining({ properties: expect.objectContaining({ kind: expect.objectContaining({ const: 'code' }) }), required: expect.arrayContaining(['path']) }),
      expect.objectContaining({ properties: expect.objectContaining({ kind: expect.objectContaining({ const: 'test' }) }), required: expect.arrayContaining(['path']) }),
    ]));
  });

  it('records a resolving code citation with blob provenance and reports it verified', async () => {
    const result = await body([
      { itemId: 'P-001', verdict: 'implemented', citations: [{ kind: 'code', path: 'src/gate.ts', symbol: 'gate' }] },
    ]);

    expect(result).toMatchObject({
      ok: true,
      coverage: { auditedItems: 1, verifiedItems: 1, verifiedRatio: 1, unverifiedItemIds: [] },
    });
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            itemId: 'P-001',
            citations: [expect.objectContaining({ kind: 'code', path: 'src/gate.ts', blobSha: expect.any(String) })],
          }),
        ],
      }),
    );
  });

  it('previews a completion audit without recording an audit or plan event', async () => {
    const result = await body([
      { itemId: 'P-001', verdict: 'implemented', citations: [{ kind: 'code', path: 'src/gate.ts', symbol: 'gate' }] },
    ], { dryRun: true });

    expect(result).toMatchObject({
      ok: true,
      phase: 'completion',
      dryRun: true,
      preview: true,
      coverage: { auditedItems: 1, verifiedItems: 1, verifiedRatio: 1, unverifiedItemIds: [] },
      itemsAuditedThisPass: 1,
    });
    expect(mockRecord).not.toHaveBeenCalled();
    expect(mockEmitPlanEvent).not.toHaveBeenCalled();
  });

  // proof-freshness-pinned-candidate-2026-10-06 P-019: a peer's uncommitted edit to a
  // cited file used to refuse the whole item (citation_audited_sha_mismatch). The audit
  // now records the COMMITTED blob at auditedSha and reports the working-tree drift.
  it('records the blob at auditedSha, not the working-tree blob, and notes the drift', async () => {
    const currentBlobSha = '0'.repeat(40);
    const auditedBlobSha = '1'.repeat(40);
    mockContext.mockResolvedValue({
      repoRoot: '/repo',
      rootSource: 'canonical-repo',
      deps: {
        statFile: (path) => (path === 'src/gate.ts' ? { isFile: true } : null),
        readFile: (path) => (path === 'src/gate.ts' ? 'export const gate = true;\n' : null),
        blobSha: (path) => (path === 'src/gate.ts' ? currentBlobSha : null),
        blobShaAt: (path, sha) =>
          path === 'src/gate.ts' && sha === 'a'.repeat(40) ? auditedBlobSha : null,
      },
    });

    const result = await body(
      [{ itemId: 'P-001', verdict: 'implemented', citations: [{ kind: 'code', path: 'src/gate.ts', symbol: 'gate' }] }],
      { auditedSha: 'a'.repeat(40) },
    );

    expect(result).toMatchObject({ ok: true });
    expect(result.problems).toBeUndefined();
    expect(result.note).toContain('1 cited file(s) differ in the working tree');
    expect(result.note).toContain('src/gate.ts');
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({
      items: [expect.objectContaining({
        itemId: 'P-001',
        citations: [expect.objectContaining({ path: 'src/gate.ts', blobSha: auditedBlobSha })],
      })],
    }));
  });

  it('pins repo-file doc citations to auditedSha without counting them as verification', async () => {
    const currentBlobSha = '0'.repeat(40);
    const auditedBlobSha = '1'.repeat(40);
    mockContext.mockResolvedValue({
      repoRoot: '/repo',
      rootSource: 'canonical-repo',
      deps: {
        statFile: (path) => (path === 'docs/guide.md' ? { isFile: true } : null),
        readFile: (path) => (path === 'docs/guide.md' ? '# Current guide\n' : null),
        blobSha: (path) => (path === 'docs/guide.md' ? currentBlobSha : null),
        blobShaAt: (path, sha) =>
          path === 'docs/guide.md' && sha === 'a'.repeat(40) ? auditedBlobSha : null,
      },
    });

    const result = await body(
      [{
        itemId: 'P-001',
        verdict: 'not-code',
        note: 'This item delivers a guide.',
        citations: [{ kind: 'doc', path: 'docs/guide.md' }],
      }],
      { auditedSha: 'a'.repeat(40) },
    );

    expect(result).toMatchObject({ ok: true, coverage: { verifiedItems: 0, unverifiedItemIds: ['P-001'] } });
    expect(result.note).toContain('1 cited file(s) differ in the working tree');
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({
      items: [expect.objectContaining({
        itemId: 'P-001',
        citations: [expect.objectContaining({ kind: 'doc', path: 'docs/guide.md', blobSha: auditedBlobSha })],
      })],
    }));
  });

  it('adds no drift note when the working tree matches auditedSha', async () => {
    const blob = '2'.repeat(40);
    mockContext.mockResolvedValue({
      repoRoot: '/repo',
      rootSource: 'canonical-repo',
      deps: {
        statFile: (path) => (path === 'src/gate.ts' ? { isFile: true } : null),
        readFile: (path) => (path === 'src/gate.ts' ? 'export const gate = true;\n' : null),
        blobSha: (path) => (path === 'src/gate.ts' ? blob : null),
        blobShaAt: (path) => (path === 'src/gate.ts' ? blob : null),
      },
    });

    const result = await body(
      [{ itemId: 'P-001', verdict: 'implemented', citations: [{ kind: 'code', path: 'src/gate.ts', symbol: 'gate' }] }],
      { auditedSha: 'a'.repeat(40) },
    );

    expect(result).toMatchObject({ ok: true });
    expect(result.note ?? '').not.toContain('differ in the working tree');
  });

  it('still refuses a cited file that is absent at auditedSha (uncommitted is not evidence)', async () => {
    mockContext.mockResolvedValue({
      repoRoot: '/repo',
      rootSource: 'canonical-repo',
      deps: {
        statFile: (path) => (path === 'src/gate.ts' ? { isFile: true } : null),
        readFile: (path) => (path === 'src/gate.ts' ? 'export const gate = true;\n' : null),
        blobSha: (path) => (path === 'src/gate.ts' ? '3'.repeat(40) : null),
        blobShaAt: () => null,
      },
    });

    const result = await body(
      [{ itemId: 'P-001', verdict: 'implemented', citations: [{ kind: 'code', path: 'src/gate.ts', symbol: 'gate' }] }],
      { auditedSha: 'a'.repeat(40) },
    );

    expect(result).toMatchObject({ ok: false, error: 'audit_invalid' });
    expect(result.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: 'P-001', code: 'citation_audited_sha_unresolvable' }),
    ]));
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('reports an operational audited-SHA Git failure separately from a missing citation', async () => {
    mockContext.mockResolvedValue({
      repoRoot: '/repo',
      rootSource: 'canonical-repo',
      deps: {
        statFile: (path) => (path === 'src/gate.ts' ? { isFile: true } : null),
        readFile: (path) => (path === 'src/gate.ts' ? 'export const gate = true;\n' : null),
        blobSha: (path) => (path === 'src/gate.ts' ? '3'.repeat(40) : null),
        blobShaAt: async () => {
          throw new CitationGitReadError('Git citation read failed (no exit status): repository unavailable');
        },
      },
    });

    const result = await body(
      [{ itemId: 'P-001', verdict: 'implemented', citations: [{ kind: 'code', path: 'src/gate.ts', symbol: 'gate' }] }],
      { auditedSha: 'a'.repeat(40) },
    );

    expect(result).toMatchObject({ ok: false, error: 'audit_invalid' });
    expect(result.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: 'P-001', code: 'citation_audited_sha_unavailable' }),
    ]));
    expect(result.problems).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: 'P-001', code: 'citation_audited_sha_unresolvable' }),
    ]));
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('does not add a stale blob conflict when an invalid fresh citation has carried history', async () => {
    mockItems.mockResolvedValue([
      { itemId: 'P-002', status: 'done', itemText: 'ship the second gate' },
      { itemId: 'P-003', status: 'done', itemText: 'ship the third gate' },
      { itemId: 'P-005', status: 'done', itemText: 'ship the fifth gate' },
    ]);
    mockPrevious.mockResolvedValue([
      ...['P-002', 'P-005'].map((itemId) => ({
        entry: {
          itemId,
          verdict: 'implemented' as const,
          citations: [{
            kind: 'code' as const,
            path: 'src/gate.ts',
            blobSha: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
          }],
          auditedSha: 'old-head',
          auditedAt: '2026-08-20T12:00:00.000Z',
          itemTextHash: 'a'.repeat(64),
        },
        auditSeq: 4,
      })),
    ]);

    const result = await body([
      { itemId: 'P-002', verdict: 'implemented', citations: [{ kind: 'code', path: 'src/gate.ts', symbol: 'missingGateSymbol' }] },
      { itemId: 'P-003', verdict: 'implemented', citations: [{ kind: 'code', path: 'src/gate.ts', symbol: 'gate' }] },
      { itemId: 'P-005', verdict: 'implemented', citations: [{ kind: 'code', path: 'src/gate.ts', symbol: 'missingGateSymbol' }] },
    ]);

    expect(result).toMatchObject({
      ok: true,
      partial: true,
      rejectedItemIds: ['P-002', 'P-005'],
      itemsCarriedForward: 2,
      carriedItemIds: ['P-002', 'P-005'],
    });
    expect(result.problems).toEqual([
      expect.objectContaining({ itemId: 'P-002', code: 'citation_symbol_not_found' }),
      expect.objectContaining({ itemId: 'P-005', code: 'citation_symbol_not_found' }),
    ]);
    expect(result.problems).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'citation_blob_sha_conflict' }),
    ]));
    expect(mockRecord).toHaveBeenCalledTimes(1);
    // RecordAuditInput is a union; `items` lives on the completion arm, which is what this
    // path records (the activation arm carries `activation` instead).
    const recordedAudit = mockRecord.mock.calls[0]?.[0] as
      | import('../../plan-audits').RecordCompletionAuditInput
      | undefined;
    expect(recordedAudit?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: 'P-002', carriedFrom: 4, auditedSha: 'old-head' }),
      expect.objectContaining({ itemId: 'P-003', auditedSha: null }),
      expect.objectContaining({ itemId: 'P-005', carriedFrom: 4, auditedSha: 'old-head' }),
    ]));
  });

  it('still refuses divergent blob provenance across fresh entries', async () => {
    mockItems.mockResolvedValue([
      { itemId: 'P-001', status: 'done', itemText: 'ship the first gate' },
      { itemId: 'P-002', status: 'done', itemText: 'ship the second gate' },
    ]);
    let blobShaCalls = 0;
    mockContext.mockResolvedValue({
      repoRoot: '/repo',
      rootSource: 'canonical-repo',
      deps: {
        statFile: (path) => (path === 'src/gate.ts' ? { isFile: true } : null),
        readFile: (path) => (path === 'src/gate.ts' ? 'export const gate = true;\n' : null),
        blobSha: (path) => {
          if (path !== 'src/gate.ts') return null;
          blobShaCalls += 1;
          return blobShaCalls === 1 ? '0'.repeat(40) : '1'.repeat(40);
        },
      },
    });

    const result = await body([
      { itemId: 'P-001', verdict: 'implemented', citations: [{ kind: 'code', path: 'src/gate.ts' }] },
      { itemId: 'P-002', verdict: 'implemented', citations: [{ kind: 'code', path: 'src/gate.ts' }] },
    ]);

    expect(result).toMatchObject({ ok: false, error: 'audit_invalid' });
    expect(result.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'citation_blob_sha_conflict',
        detail: expect.stringContaining('src/gate.ts'),
      }),
    ]));
    expect(result.problems.find((problem: { code: string }) => problem.code === 'citation_blob_sha_conflict')?.detail)
      .toMatch(/P-001.*P-002|P-002.*P-001/);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('reports an unresolvable citation separately from a harness-root failure', async () => {
    mockContext.mockResolvedValue({
      kind: 'citation_unresolvable',
      citations: [{
        path: 'src/gate.ts',
        symbol: 'missingGateSymbol',
        reason: 'symbol_not_found',
        detail: 'missingGateSymbol not in src/gate.ts',
      }],
    });

    const result = await body([
      { itemId: 'P-001', verdict: 'implemented', citations: [{ kind: 'code', path: 'src/gate.ts', symbol: 'missingGateSymbol' }] },
    ]);

    expect(result).toMatchObject({
      ok: false,
      error: 'citation_unresolvable',
      citations: [{ path: 'src/gate.ts', symbol: 'missingGateSymbol', reason: 'symbol_not_found' }],
    });
    expect(result.message).toContain('the harness source root is not the cause');
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it('records valid items from a mixed batch and returns only the rejected item problems', async () => {
    mockItems.mockResolvedValue([
      { itemId: 'P-001', status: 'done', itemText: 'ship the audit gate' },
      { itemId: 'P-002', status: 'done', itemText: 'ship the second gate' },
    ]);
    const resolvingContext = {
      repoRoot: '/repo',
      rootSource: 'canonical-repo' as const,
      deps: {
        statFile: (path: string) => (path === 'src/gate.ts' ? { isFile: true } : null),
        readFile: (path: string) => (path === 'src/gate.ts' ? 'export const gate = true;\n' : null),
        blobSha: (path: string) => (path === 'src/gate.ts' ? '0123456789012345678901234567890123456789' : null),
      },
    };
    mockContext.mockImplementation(async (_harness, citations) => {
      if ((citations ?? []).some((citation) => citation.path === 'src/missing.ts')) {
        return {
          kind: 'citation_unresolvable',
          citations: [{ path: 'src/missing.ts', reason: 'file_not_found' }],
        };
      }
      return resolvingContext;
    });

    const result = await body([
      { itemId: 'P-001', verdict: 'implemented', citations: [{ kind: 'code', path: 'src/gate.ts', symbol: 'gate' }] },
      { itemId: 'P-002', verdict: 'implemented', citations: [{ kind: 'code', path: 'src/missing.ts' }] },
    ]);

    expect(result).toMatchObject({
      ok: true,
      partial: true,
      itemsAuditedThisPass: 1,
      rejectedItemIds: ['P-002'],
    });
    expect(result.problems).toEqual([
      expect.objectContaining({ itemId: 'P-002', code: 'citation_file_not_found' }),
    ]);
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({
      items: [expect.objectContaining({ itemId: 'P-001' })],
    }));
    expect((mockRecord.mock.calls[0]![0] as { items?: unknown[] }).items).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ itemId: 'P-002' })]),
    );
  });
});

describe('plans:audit phase:activation', () => {
  it('publishes the canonical Requirements BAR syntax required by activation seeding', () => {
    const guidance = [
      tool.description,
      tool.guidance?.when,
      tool.guidance?.returns,
      tool.guidance?.chaining,
    ].join('\n');

    expect(guidance).toContain('## Requirements');
    expect(guidance).toContain('**R-N — Title.** outcome');
    expect(guidance).toContain('fenced `requirement` JSON block');
    expect(guidance).toContain('ordinary bullet lists do not satisfy the BAR parser');
  });

  it('publishes the required planTargets destination grammar on the nested field', () => {
    const projected = lookupByMcpName('plans:audit');
    expect(projected).toBeDefined();
    const schema = projected?.inputSchema as {
      properties?: {
        mappings?: {
          items?: {
            properties?: {
              planTargets?: { description?: string };
            };
          };
        };
      };
    };
    const description = schema.properties?.mappings?.items?.properties?.planTargets?.description;

    expect(description).toContain('R-N');
    expect(description).toContain('P-NNN');
    expect(description).toContain('D-NNN');
    expect(description).toContain('section:<heading>');
    expect(description).toContain('section: prefix is required');
  });

  it('publishes the activation blocker contract on the live schema and guidance', () => {
    const projected = lookupByMcpName('plans:audit');
    // EI-24379978800956217: compact tool discovery can omit late optional
    // field descriptions, so the bounded top-level description must carry the
    // refusal rule even when callers never request the full JSON schema.
    expect(projected?.description?.slice(0, 320)).toContain('any nonempty `unresolvedBlockers` list refuses the audit and records nothing');
    const schema = projected?.inputSchema as {
      properties?: {
        unresolvedBlockers?: { description?: string };
        summary?: { description?: string };
      };
    };
    const blockerDescription = schema.properties?.unresolvedBlockers?.description;
    const summaryDescription = schema.properties?.summary?.description;
    expect(blockerDescription).toContain('Any nonempty array blocks activation');
    expect(blockerDescription).toContain('nothing is recorded');
    expect(blockerDescription).toContain('covered mapping');
    expect(summaryDescription).toContain('resolved conditional/live-environment limitations');
  });

  it('refuses a non-final main wait with an actionable item diagnostic', async () => {
    mockGetPlanRow.mockResolvedValue({
      content: `---\ntitle: Plan A\nslug: plan-a\nstatus: draft\ncreated: 2026-08-27\nupdated: 2026-08-27\nowner: test\n---\n\n## Items\n\n- **P-001** \`todo\` Wait for green-checkpoint before continuing implementation.\n`,
    } as never);

    const result = ((await tool.handler(activationArgs() as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({
      ok: false,
      phase: 'activation',
      error: 'staging_first_guard_failed',
      problems: [expect.objectContaining({ itemId: 'P-001', code: 'non_final_deployed_main_wait' })],
    });
    expect(result.problems[0].detail).toContain('name the deployed-only property');
    expect(mockResolveSourceRefs).not.toHaveBeenCalled();
    expect(mockRecordActivation).not.toHaveBeenCalled();
  });

  it.each([
    '- **P-001** `todo` Final shipment verification waits for green main and :3070.',
    '- **P-001** `todo` Wait for :3070 before closing the deployed-only restart continuity check because staging cannot exercise the deployed-host supervisor restart.',
  ])('records activation for a valid final or reasoned deployed-only item: %s', async (item) => {
    mockGetPlanRow.mockResolvedValue({
      content: `---\ntitle: Plan A\nslug: plan-a\nstatus: draft\ncreated: 2026-08-27\nupdated: 2026-08-27\nowner: test\n---\n\n## Items\n\n${item}\n`,
    } as never);

    const result = ((await tool.handler(activationArgs() as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: true, phase: 'activation' });
    expect(mockResolveSourceRefs).toHaveBeenCalled();
    expect(mockRecordActivation).toHaveBeenCalled();
  });

  it('admits an omitted classRef and omitted or empty coverage arrays for carry-forward re-audits', () => {
    // P-003: an omitted classRef is derived in the handler, so the schema no longer refuses it.
    expect(tool.args.safeParse({ slug: 'plan-a', harness: 'papercusp', phase: 'activation' }).success).toBe(true);
    expect(tool.args.safeParse({
      slug: 'plan-a',
      harness: 'papercusp',
      phase: 'activation',
      classRef: 'plan-class-bugfix',
      sourceRanges: [],
      mappings: [],
    }).success).toBe(true);
  });

  it('keeps first activation audits nonempty in handler validation', async () => {
    const result = ((await tool.handler({
      slug: 'plan-a',
      harness: 'papercusp',
      phase: 'activation',
      classRef: 'plan-class-bugfix',
    } as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({
      ok: false,
      phase: 'activation',
      error: 'activation_audit_invalid',
      problems: expect.arrayContaining([
        expect.objectContaining({ code: 'source_ranges_required' }),
        expect.objectContaining({ code: 'mappings_required' }),
      ]),
    });
    expect(mockResolveSourceRefs).not.toHaveBeenCalled();
    expect(mockRecordActivation).not.toHaveBeenCalled();
  });

  it('carries prior coverage when a re-audit has no new source ranges or mappings', async () => {
    mockPreviousActivation.mockResolvedValue({
      auditSeq: 7,
      activation: {
        sourceRanges: [{ sourceKind: 'codex', sessionId: 'prior-session', fromTurn: 1, toTurn: 9 }],
        mappings: [{
          id: 'M-001',
          sourceRefs: ['session_turn:codex:prior-session:4'],
          requirement: 'the original owner boundary remains represented',
          planTargets: ['P-001'],
          disposition: 'covered',
        }],
        repairedOmissions: ['prior repair'],
        rejectedOrSuperseded: [],
        unresolvedBlockers: [],
      },
    } as never);
    mockResolveSourceRefs.mockImplementation(async (_sql, _workspaceId, refs) =>
      refs.map((ref) => ({ ref, ok: true as const, source: 'index' as const })),
    );

    const result = ((await tool.handler({
      slug: 'plan-a',
      harness: 'papercusp',
      phase: 'activation',
      classRef: 'plan-class-bugfix',
      summary: 'decision-only re-audit',
    } as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({
      ok: true,
      phase: 'activation',
      mappings: 1,
      sourceRanges: 1,
      carriedMappings: 1,
      carriedMappingIds: ['M-001'],
      coverageBaseAuditSeq: 7,
      sourceRefsResolved: 1,
    });
    expect(mockRecordActivation).toHaveBeenCalledWith(expect.objectContaining({
      activation: expect.objectContaining({
        sourceRanges: [{ sourceKind: 'codex', sessionId: 'prior-session', fromTurn: 1, toTurn: 9 }],
        mappings: [expect.objectContaining({ id: 'M-001' })],
      }),
    }));
  });

  it('reports a pending BAR amendment without running the legacy clause deriver', async () => {
    mockRecordActivation.mockResolvedValue({
      ok: true,
      audit: { auditSeq: 8 } as never,
      auditedPlanRevision: { id: 42, seq: 7, contentHash: 'b'.repeat(64) },
      barSeed: null,
      barSeedPendingAmendment: {
        rubricSlug: 'acceptance-plan-a',
        previousSubjectPlanRevision: 6,
        currentSubjectPlanRevision: 7,
        currentPlanContentHash: 'b'.repeat(64),
        reason: 'acceptance_bar_source_changed',
      },
    });

    const result = ((await tool.handler(activationArgs() as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({
      ok: true,
      phase: 'activation',
      auditSeq: 8,
      barSeedPendingAmendment: {
        rubricSlug: 'acceptance-plan-a',
        previousSubjectPlanRevision: 6,
        currentSubjectPlanRevision: 7,
        currentPlanContentHash: 'b'.repeat(64),
        reason: 'acceptance_bar_source_changed',
      },
    });
    expect(result.derivedSpecClauses).toBeNull();
    expect(mockItems).not.toHaveBeenCalled();
    expect(mockSetSpecClause).not.toHaveBeenCalled();
  });

  it('uses callable org SQL when skipWorkspaceTx leaves ctx.tx absent', async () => {
    const noTxCtx = {
      ...(ctx as unknown as Record<string, unknown>),
      tx: undefined,
    } as never;

    const result = ((await tool.handler(activationArgs() as never, noTxCtx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: true, phase: 'activation' });
    expect(mockResolveSourceRefs).toHaveBeenCalledWith(
      mockOrgSql,
      'test-workspace',
      ['session_turn:codex:session-full-id:7'],
    );
  });

  it('publishes the complete activation workflow and runtime materiality taxonomy on the tool surface', () => {
    const guidance = [
      tool.description,
      tool.guidance?.when,
      tool.guidance?.returns,
      tool.guidance?.chaining,
    ].join('\n');

    expect(guidance).toContain('COMPLETE source conversation');
    expect(guidance).toContain('audited/current revision id/seq/contentHash');
    for (const obligation of [
      'requirement', 'boundary', 'constraint', 'correction', 'rejection', 'decision',
      'dependency', 'sequence', 'acceptance condition', 'open question', 'follow-up',
    ]) {
      expect(guidance).toContain(obligation);
    }
    for (const material of [
      'requirements', 'scope', 'constraints', 'decisions', 'dependencies', 'sequencing',
      'acceptance criteria', 'open questions', 'promised follow-ups',
    ]) {
      expect(guidance).toContain(material);
    }
    for (const cosmetic of ['spelling', 'formatting', 'cosmetic-only wording']) {
      expect(guidance).toContain(cosmetic);
    }
  });

  it('stays within the shared prompt-weight budget', () => {
    // promptWeight takes the loose { description, guidance } shape; a RoleToolDefinition's richer
    // guidance type is not directly assignable under TS6, so narrow through unknown.
    expect(promptWeight(tool as unknown as Parameters<typeof promptWeight>[0])).toBeLessThanOrEqual(BUDGET);
  });

  it('resolves every source ref and returns the exact server-captured revision', async () => {
    const result = ((await tool.handler(activationArgs() as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({
      ok: true,
      phase: 'activation',
      auditSeq: 2,
      sourceRefsResolved: 1,
      auditedPlanRevision: { id: 41, seq: 6, contentHash: 'a'.repeat(64) },
    });
    expect(mockResolveSourceRefs).toHaveBeenCalledWith(
      expect.anything(),
      'test-workspace',
      ['session_turn:codex:session-full-id:7'],
    );
    expect(mockRecordActivation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'test-workspace',
        planSlug: 'plan-a',
        classRef: 'plan-class-bugfix',
        activation: expect.objectContaining({ mappings: [expect.objectContaining({ id: 'M-001' })] }),
      }),
    );
    // Was `expect(mockItems).not.toHaveBeenCalled()` until P-019 / D-047 wired draft
    // spec-clause derivation into this branch, which reads plan items for its liveness
    // filter. "Never called" was only ever a proxy for the invariant that MATTERS and is
    // asserted directly below: an activation audit's outcome does not depend on plan
    // items being readable. Read here, but only AFTER the audit is durably recorded.
    expect(mockItems).toHaveBeenCalledWith('plan-a', { harnessSlug: null });
    expect(mockRecordActivation.mock.invocationCallOrder[0]!).toBeLessThan(
      mockItems.mock.invocationCallOrder[0]!,
    );
  });

  // WI-10005174: the ctx harness is only a CANDIDATE; plan_items is keyed by the
  // plan's own harness, so the derivation must read the RESOLVED home's items.
  it('reads draft-derivation items from the home harness resolved for the plan', async () => {
    mockResolveHome.mockResolvedValue('email');

    await tool.handler(activationArgs() as never, ctx);

    expect(mockResolveHome).toHaveBeenCalledWith('plan-a', expect.anything());
    expect(mockItems).toHaveBeenCalledWith('plan-a', { harnessSlug: 'email' });
  });

  it('returns the side-effect-free plans:start consult preview after recording activation', async () => {
    const result = ((await tool.handler(activationArgs() as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({
      ok: true,
      phase: 'activation',
      activationReadiness: {
        consult: { outcome: 'proceed', verdict: 'no_qualified_responder' },
      },
    });
    expect(mockPreviewPlanStartConsult).toHaveBeenCalledWith({
      workspaceId: 'test-workspace',
      requesterId: 'su-auditor',
      planSlug: 'plan-a',
      planContent: expect.stringContaining('slug: plan-a'),
    });
    expect(mockRecordActivation.mock.invocationCallOrder[0]!).toBeLessThan(
      mockPreviewPlanStartConsult.mock.invocationCallOrder[0]!,
    );
  });

  it('previews activation validation without recording audit, repair, clause, consult, or event writes', async () => {
    const result = ((await tool.handler({ ...activationArgs(), dryRun: true } as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({
      ok: true,
      phase: 'activation',
      dryRun: true,
      preview: true,
      sourceRanges: 1,
      mappings: 1,
      sourceRefsResolved: 1,
    });
    expect(mockRecordActivation).not.toHaveBeenCalled();
    expect(mockRepairFiling).not.toHaveBeenCalled();
    expect(mockItems).not.toHaveBeenCalled();
    expect(mockSetSpecClause).not.toHaveBeenCalled();
    expect(mockPreviewPlanStartConsult).not.toHaveBeenCalled();
    expect(mockEmitPlanEvent).not.toHaveBeenCalled();
  });

  // EI-23806095672871173. The preview answered `ok:true, "validation passed"` while
  // the identical dryRun:false call refused `bar_mapping_missing`: BAR seeding is a
  // precondition on the PLAN, not on the payload, so an ok scoped to the payload was
  // being read as a verdict on the call. These three pin BOTH directions, because the
  // obvious fix (check unconditionally) trades this false PASS for a worse false REFUSAL.
  //
  // This is observable here only because the check calls the unmocked pure
  // validateAcceptanceBarSource. The original defect could NOT be caught at this layer:
  // it lived behind recordCurrentActivationAudit, which this file mocks wholesale.
  it('previews the BAR-seed refusal the writer would raise, for a plan under the contract', async () => {
    resolvePlanContent(barPlanWithoutDesign);
    mockOrgSql.mockResolvedValue([{ acceptance_bar_epoch: '1' }]);

    const result = ((await tool.handler({ ...activationArgs(), dryRun: true } as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({
      ok: false,
      phase: 'activation',
      dryRun: true,
      preview: true,
      error: 'bar_mapping_missing',
    });
    expect(result.message).toContain('BAR seed problem(s)');
    // A preview must still write nothing, including on its new refusal path.
    expect(mockRecordActivation).not.toHaveBeenCalled();
    expect(mockEmitPlanEvent).not.toHaveBeenCalled();
  });

  it('previews the missing-Requirements refusal for a contract plan', async () => {
    resolvePlanContent([
      '---',
      'title: Plan A',
      'slug: plan-a',
      'status: draft',
      'created: 2026-08-27',
      'updated: 2026-08-27',
      'owner: test',
      '---',
      '',
      '## Items',
      '',
      "- **P-001** `todo` Implement the audit gate on staging.",
      '',
    ].join('\n'));
    mockOrgSql.mockResolvedValue([{ acceptance_bar_epoch: '1' }]);

    const result = ((await tool.handler({ ...activationArgs(), dryRun: true } as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({
      ok: false,
      phase: 'activation',
      dryRun: true,
      preview: true,
      error: 'bar_requirements_missing',
      problems: [expect.objectContaining({ code: 'bar_requirements_missing' })],
    });
    expect(result.message).toContain('plan has no ## Requirements section');
    expect(mockRecordActivation).not.toHaveBeenCalled();
    expect(mockEmitPlanEvent).not.toHaveBeenCalled();
  });

  it('does NOT demand a Bar-to-work map from a plan whose acceptance_bar_epoch is NULL', async () => {
    // The writer wraps EVERY BAR branch in `if (current.acceptance_bar_epoch != null)`
    // (plan-audits.ts:2182, closing 2319), so a plan outside the contract correctly
    // carries no map. Measured 2026-09-20: 1916 of 2044 plans have a NULL epoch, so
    // checking unconditionally would false-refuse ~94% of activation previews.
    resolvePlanContent(withR1Conformance(barPlanWithoutDesign));
    mockOrgSql.mockResolvedValue([{ acceptance_bar_epoch: null }]);

    const result = ((await tool.handler({ ...activationArgs(), dryRun: true } as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: true, phase: 'activation', dryRun: true, preview: true });
  });

  it('refuses a NULL-epoch preview whose requirement compiles to no executable check (spec-conformance R-1, D-003)', async () => {
    // D-003: no legacy-cohort exemption — a plan outside the BAR contract is still
    // refused when a requirement has no runnable done-when check, falsifier, or
    // approved unenforced declaration. Pair with the passing test above: the only
    // difference is the ## Conformance falsifier.
    resolvePlanContent(barPlanWithoutDesign);
    mockOrgSql.mockResolvedValue([{ acceptance_bar_epoch: null }]);

    const result = ((await tool.handler({ ...activationArgs(), dryRun: true } as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({
      ok: false,
      phase: 'activation',
      dryRun: true,
      preview: true,
      error: 'conformance_requirement_unenforced',
      problems: [expect.objectContaining({ code: 'conformance_requirement_unenforced', barKey: 'R-1' })],
    });
    expect(result.message).toContain('Unenforced requirement(s): R-1');
    expect(mockRecordActivation).not.toHaveBeenCalled();
    expect(mockEmitPlanEvent).not.toHaveBeenCalled();
  });

  it('refuses the recording write for an unenforced requirement and records nothing (spec-conformance R-1)', async () => {
    resolvePlanContent(barPlanWithoutDesign);
    mockOrgSql.mockResolvedValue([{ acceptance_bar_epoch: null }]);

    const result = ((await tool.handler(activationArgs() as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: false, phase: 'activation', error: 'conformance_requirement_unenforced' });
    expect(result).not.toHaveProperty('dryRun');
    expect(mockRecordActivation).not.toHaveBeenCalled();
    expect(mockEmitPlanEvent).not.toHaveBeenCalled();
  });

  it('passes the preview for a contract plan that DOES carry a Bar-to-work map', async () => {
    // Calibration control: without this, the refusal above would also pass against a
    // check that simply refused whenever the epoch is set.
    resolvePlanContent(barPlanCompleteWithDesign);
    mockOrgSql
      .mockResolvedValueOnce([{ acceptance_bar_epoch: '1' }])
      .mockResolvedValueOnce([]);

    const result = ((await tool.handler({ ...activationArgs(), dryRun: true } as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: true, phase: 'activation', dryRun: true, preview: true });
  });

  it('previews the evidence-plane conflict that BAR seeding refuses', async () => {
    const conflictingPlan = barPlanCompleteWithDesign
      .replace(
        '"falsifier":"A second criterion claims the same BAR.","requiredTestLayers"',
        '"falsifier":"A second criterion claims the same BAR.","evidencePlane":"tree","requiredTestLayers"',
      )
      .replace('| R-1 | P-001 | tree |', '| R-1 | P-001 | live |');
    resolvePlanContent(conflictingPlan);
    mockOrgSql.mockResolvedValue([{ acceptance_bar_epoch: '1' }]);
    mockPreviewActivation.mockResolvedValue({ ok: true, preview: true } as never);

    const result = ((await tool.handler({ ...activationArgs(), dryRun: true } as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({
      ok: false,
      phase: 'activation',
      dryRun: true,
      preview: true,
      error: 'bar_evidence_plane_invalid',
      problems: [expect.objectContaining({
        code: 'bar_evidence_plane_invalid',
        barKey: 'R-1',
        detail: 'R-1 has conflicting Acceptance and map evidence planes',
      })],
    });
    expect(mockPreviewActivation).not.toHaveBeenCalled();
    expect(mockRecordActivation).not.toHaveBeenCalled();
    expect(mockEmitPlanEvent).not.toHaveBeenCalled();
  });

  it('previews the writer contract-completeness refusal for a never-seeded prose BAR (P-003)', async () => {
    resolvePlanContent(barPlanWithDesign);
    mockOrgSql
      .mockResolvedValueOnce([{ acceptance_bar_epoch: '1', acceptance_bar_cohort: 'post-epoch', acceptance_bar_rubric_slug: null }])
      .mockResolvedValueOnce([]);
    mockPreviewActivation.mockResolvedValue({ ok: false, error: 'bar_contract_method_missing',
      message: 'R-1 has no METHOD/check/layers', problems: [{ code: 'bar_contract_method_missing',
        barKey: 'R-1', detail: 'R-1 has no METHOD/check/layers',
        contractGaps: ['method_missing', 'check_missing', 'test_layers_missing'] }] });

    const result = ((await tool.handler({ ...activationArgs(), dryRun: true } as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: false, preview: true, error: 'bar_contract_method_missing' });
    expect(result.problems[0].contractGaps).toEqual(['method_missing', 'check_missing', 'test_layers_missing']);
    expect(mockRecordActivation).not.toHaveBeenCalled();
  });

  it('delegates seeded-plan completeness to the same transactional decision as the writer', async () => {
    resolvePlanContent(withR1Conformance(barPlanWithDesign));
    mockOrgSql
      .mockResolvedValueOnce([{ acceptance_bar_epoch: '1', acceptance_bar_cohort: 'post-epoch',
        acceptance_bar_rubric_slug: 'acceptance-plan-a' }])
      .mockResolvedValueOnce([]);

    const result = ((await tool.handler({ ...activationArgs(), dryRun: true } as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: true, preview: true });
    expect(mockPreviewActivation).toHaveBeenCalledWith(expect.objectContaining({ planSlug: 'plan-a', activation: expect.any(Object) }));
  });

  it('propagates successor completeness refusals even when the subject already has a rubric pin', async () => {
    resolvePlanContent(barPlanWithDesign);
    mockOrgSql.mockResolvedValueOnce([{ acceptance_bar_epoch: '1',
      acceptance_bar_rubric_slug: 'retired-acceptance-plan-a' }]).mockResolvedValueOnce([]);
    mockPreviewActivation.mockResolvedValue({ ok: false, error: 'bar_contract_method_missing',
      message: 'The authored successor lacks a METHOD for R-1.' });
    const result = ((await tool.handler({ ...activationArgs(), dryRun: true } as never, ctx)) as { data: any }).data;
    expect(result).toMatchObject({ ok: false, preview: true, error: 'bar_contract_method_missing' });
    expect(mockRecordActivation).not.toHaveBeenCalled();
    expect(mockEmitPlanEvent).not.toHaveBeenCalled();
  });

  it('previews the writer projection conflict for a live generated identity outside the current map', async () => {
    resolvePlanContent(barPlanWithDesign);
    mockOrgSql
      .mockResolvedValueOnce([{ acceptance_bar_epoch: '1' }])
      .mockResolvedValueOnce([{
        spec_id: 'AUTO-BAR-R-9-P-999',
        source_bar_key: 'R-9',
        lifecycle_status: 'active',
      }]);

    const result = ((await tool.handler({ ...activationArgs(), dryRun: true } as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({
      ok: false,
      phase: 'activation',
      dryRun: true,
      preview: true,
      error: 'bar_projection_conflict',
    });
    expect(result.message).toContain('AUTO-BAR-R-9-P-999');
    expect(mockRecordActivation).not.toHaveBeenCalled();
  });

  it('names the safe repair for a retired but still-pinned projection conflict', async () => {
    resolvePlanContent(barPlanWithDesign);
    mockOrgSql
      .mockResolvedValueOnce([{ acceptance_bar_epoch: '1' }])
      .mockResolvedValueOnce([{
        spec_id: 'AUTO-BAR-R-9-P-999',
        source_bar_key: 'R-9',
        lifecycle_status: 'retired',
      }]);

    const result = ((await tool.handler({ ...activationArgs(), dryRun: true } as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: false, preview: true, error: 'bar_projection_conflict' });
    expect(result.problems[0].detail).toContain("lifecycleStatus:'superseded'");
    expect(result.problems[0].detail).toContain('sourceBar:null');
    expect(result.message).toContain('plans:set-specs');
  });

  it('does not treat a superseded unpinned generated identity as a live preview conflict', async () => {
    resolvePlanContent(barPlanCompleteWithDesign);
    mockOrgSql
      .mockResolvedValueOnce([{ acceptance_bar_epoch: '1' }])
      .mockResolvedValueOnce([{
        spec_id: 'AUTO-BAR-R-9-P-999',
        source_bar_key: null,
        lifecycle_status: 'superseded',
      }]);

    const result = ((await tool.handler({ ...activationArgs(), dryRun: true } as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: true, phase: 'activation', dryRun: true, preview: true });
  });

  it('records the activation audit even when plan items are unreadable, and reports the derivation', async () => {
    // getPlanItemStatuses swallows its own errors and answers [] — an EMPTY list means
    // UNKNOWN, not "this plan has no items" (D-040). The deriver fails OPEN on unknown
    // rather than skipping every mapping, because skipping would make a failed read
    // indistinguishable from a plan with no realizing mappings. setSpecClause's
    // plan_item_not_found is the backstop that keeps an invalid target from landing.
    mockItems.mockResolvedValue([]);

    const result = ((await tool.handler(activationArgs() as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: true, phase: 'activation', auditSeq: 2 });
    expect(result.derivedSpecClauses).toMatchObject({ attempted: 1, created: 1, skipped: [] });
  });

  it('a derivation failure is REPORTED, never propagated — the audit is already recorded', async () => {
    // The audit is durably written before derivation runs. Throwing here would turn a
    // successful audit into a caller-visible failure and invite a retry that re-records
    // nothing — strictly worse than deriving no clauses.
    mockSetSpecClause.mockRejectedValue(new Error('spec clause store unavailable'));

    const result = ((await tool.handler(activationArgs() as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: true, phase: 'activation', auditSeq: 2 });
    expect(result.derivedSpecClauses).toEqual({ error: 'spec clause store unavailable' });
  });

  it('reports the P-017 under-read verdict, flagging a declared-but-uncited requirement turn', async () => {
    // The fixture declares turns 0-20 and cites only turn 7. Turn 12 carries obligation
    // language and nothing maps it — exactly the self-chosen-denominator gap P-017 opens up.
    mockOrgSql.mockResolvedValue([
      { source_kind: 'codex', session_id: 'session-full-id', turn_idx: 7, speaker: 'user', text: 'the audit must record a complete source range' },
      { source_kind: 'codex', session_id: 'session-full-id', turn_idx: 12, speaker: 'user', text: 'it should never accept a citation outside the declared range' },
    ]);

    const result = ((await tool.handler(activationArgs() as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: true, phase: 'activation' });
    expect(result.underRead).toMatchObject({
      advisory: true,
      declaredTurns: 21,
      suppliedTurns: 2,
      citedTurns: 1,
      uncitedTurns: 1,
    });
    expect(result.underRead.candidates).toEqual([
      expect.objectContaining({
        ref: 'session_turn:codex:session-full-id:12',
        signals: expect.arrayContaining(['constraint']),
      }),
    ]);
    // 19 of 21 declared turns were never supplied, so this verdict is a FLOOR — an empty
    // candidate list here would NOT have meant "nothing was under-read".
    expect(result.underRead.unsuppliedTurns).toBe(19);
  });

  it('keeps source-kind/session-id pairs aligned in both detector queries', async () => {
    mockOrgSql.mockImplementation((...args: unknown[]) => {
      const first = args[0];
      if (!Array.isArray(first) || !('raw' in first)) return first;
      const text = (first as unknown as string[]).join('?');
      if (text.includes('MIN(turns.turn_idx)')) {
        return Promise.resolve([
          { source_kind: 'codex', session_id: 'session-full-id', min_turn: 0, max_turn: 20 },
          { source_kind: 'claude', session_id: 'session-b', min_turn: 0, max_turn: 30 },
        ]);
      }
      return Promise.resolve([]);
    });

    const result = ((await tool.handler(activationArgs({
      sourceRanges: [
        { sourceKind: 'codex', sessionId: 'session-full-id', fromTurn: 0, toTurn: 20 },
        { sourceKind: 'claude', sessionId: 'session-b', fromTurn: 0, toTurn: 30 },
      ],
    }) as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: true, phase: 'activation' });
    expect(result.sourceSpan).toMatchObject({
      unmeasuredSessions: [],
      gapTurns: 0,
    });
    // The real postgres tagged template must serialize each JS array as one
    // array parameter. Direct interpolation expands a multi-value array into
    // comma-separated SQL and causes the production syntax error near `,`.
    expect(mockOrgSqlArray).toHaveBeenCalledTimes(4);
    expect(mockOrgSqlArray).toHaveBeenNthCalledWith(1, ['codex', 'claude']);
    expect(mockOrgSqlArray).toHaveBeenNthCalledWith(2, ['session-full-id', 'session-b']);
    expect(mockOrgSqlArray).toHaveBeenNthCalledWith(3, ['codex', 'claude']);
    expect(mockOrgSqlArray).toHaveBeenNthCalledWith(4, ['session-full-id', 'session-b']);
    const unnestCalls = mockOrgSql.mock.calls.filter(([strings]) => (
      Array.isArray(strings) &&
      'raw' in strings &&
      (strings as string[]).join('?').includes('FROM unnest(')
    ));
    expect(unnestCalls).toHaveLength(2);
    for (const [, ...values] of unnestCalls) {
      expect(values).toContainEqual(['codex', 'claude']);
      expect(values).toContainEqual(['session-full-id', 'session-b']);
    }
    const queryTexts = unnestCalls.map(([strings]) => (strings as string[]).join('?'));
    expect(queryTexts.every((text) => !text.includes('(source_kind, session_id) IN'))).toBe(true);
    // File-backed Codex/Claude/OMP transcripts live in the host-global `default`
    // corpus even when the plan belongs to a concrete workspace. Both independent
    // detector reads must therefore mirror the canonical session-consumer scope or a
    // non-default plan reports 0 supplied turns and an unmeasured source span.
    expect(queryTexts).toHaveLength(2);
    expect(queryTexts.every((text) => (
      text.includes("(turns.workspace_id = ? OR turns.workspace_id = 'default')")
    ))).toBe(true);
  });

  it('an under-read read failure is REPORTED, never propagated — the audit is already recorded', async () => {
    mockOrgSql.mockRejectedValue(new Error('session_turns unavailable'));

    const result = ((await tool.handler(activationArgs() as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: true, phase: 'activation', auditSeq: 2 });
    expect(result.underRead).toEqual({ error: 'session_turns unavailable' });
  });

  it('reports the P-018 source-span verdict, flagging turns the audit never declared', async () => {
    // Two different queries share the one sql mock, so route by statement text rather
    // than by call order — the `sql(values)` IN-clause helper is also a call on it, which
    // makes positional mocking fragile in a way that would silently mis-attribute rows.
    mockOrgSql.mockImplementation((...args: unknown[]) => {
      const first = args[0];
      if (!Array.isArray(first) || !('raw' in first)) return first; // the sql(values) helper
      const text = (first as unknown as string[]).join('?');
      if (text.includes('MIN(turns.turn_idx)')) {
        // The fixture declares turns 0-20; the transcript actually runs to 40.
        return Promise.resolve([
          { source_kind: 'codex', session_id: 'session-full-id', min_turn: 0, max_turn: 40 },
        ]);
      }
      return Promise.resolve([]);
    });

    const result = ((await tool.handler(activationArgs() as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: true, phase: 'activation' });
    expect(result.sourceSpan).toMatchObject({
      advisory: true,
      transcriptTurns: 41,
      declaredTurns: 21,
      gapTurns: 20,
      unmeasuredSessions: [],
    });
    // A TAIL gap: the audit stopped reading at turn 20 of a 40-turn conversation, which
    // is where corrections and reversals live.
    expect(result.sourceSpan.gaps).toEqual([
      expect.objectContaining({ position: 'tail', fromTurn: 21, toTurn: 40, turnCount: 20 }),
    ]);
  });

  it('an unmeasurable session makes the span verdict inconclusive rather than clean', async () => {
    // Zero gaps here must NOT read as "fully spanned" — the extent query returned nothing,
    // so the detector could not see the session it was asked about.
    mockOrgSql.mockImplementation((...args: unknown[]) => {
      const first = args[0];
      if (!Array.isArray(first) || !('raw' in first)) return first;
      return Promise.resolve([]);
    });

    const result = ((await tool.handler(activationArgs() as never, ctx)) as { data: any }).data;

    expect(result.sourceSpan.gaps).toEqual([]);
    expect(result.sourceSpan.unmeasuredSessions).toEqual(['codex::session-full-id']);
  });

  it('a source-span read failure is REPORTED, never propagated', async () => {
    mockOrgSql.mockImplementation((...args: unknown[]) => {
      const first = args[0];
      if (!Array.isArray(first) || !('raw' in first)) return first;
      const text = (first as unknown as string[]).join('?');
      if (text.includes('MIN(turns.turn_idx)')) return Promise.reject(new Error('extent read failed'));
      return Promise.resolve([]);
    });

    const result = ((await tool.handler(activationArgs() as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: true, phase: 'activation', auditSeq: 2 });
    expect(result.sourceSpan).toEqual({ error: 'extent read failed' });
  });

  it('derives DRAFT clauses only, so a derivation pass can never gate another plan ship', async () => {
    // plan-spec-coverage-gate enforces only {accepted, active}. An enforceable lifecycle
    // here would let this bulk pass refuse ships it has no business judging.
    await tool.handler(activationArgs() as never, ctx);

    expect(mockSetSpecClause).toHaveBeenCalledWith(
      expect.objectContaining({
        planSlug: 'plan-a',
        planItemId: 'P-001',
        lifecycleStatus: 'draft',
        behaviorClass: 'happy-path',
        expectedRevision: 0,
      }),
    );
    expect(mockSetSpecClause.mock.calls[0]![0]).not.toHaveProperty('falsifier');
  });

  it('carries prior activation mappings and source ranges into a partial additive re-audit', async () => {
    mockPreviousActivation.mockResolvedValue({
      auditSeq: 7,
      activation: {
        sourceRanges: [{ sourceKind: 'codex', sessionId: 'prior-session', fromTurn: 1, toTurn: 9 }],
        mappings: [{
          id: 'M-001',
          sourceRefs: ['session_turn:codex:prior-session:4'],
          requirement: 'the original owner boundary remains represented',
          planTargets: ['P-001'],
          disposition: 'covered',
        }],
        repairedOmissions: ['prior repair'],
        rejectedOrSuperseded: [],
        unresolvedBlockers: [],
      },
    } as never);
    mockResolveSourceRefs.mockImplementation(async (_sql, _workspaceId, refs) =>
      refs.map((ref) => ({ ref, ok: true as const, source: 'index' as const })),
    );

    const result = ((await tool.handler(activationArgs({
      sourceRanges: [{ sourceKind: 'codex', sessionId: 'session-full-id', fromTurn: 0, toTurn: 20 }],
      mappings: [{
        id: 'M-002',
        sourceRefs: ['session_turn:codex:session-full-id:7'],
        requirement: 'the new material change is mapped additively',
        planTargets: ['P-001'],
        disposition: 'repaired',
      }],
      repairedOmissions: ['new repair'],
    }) as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({
      ok: true,
      phase: 'activation',
      mappings: 2,
      sourceRanges: 2,
      carriedMappings: 1,
      carriedMappingIds: ['M-001'],
      coverageBaseAuditSeq: 7,
    });
    expect(mockRecordActivation).toHaveBeenCalledWith(expect.objectContaining({
      activation: expect.objectContaining({
        mappings: [
          expect.objectContaining({ id: 'M-001' }),
          expect.objectContaining({ id: 'M-002' }),
        ],
        repairedOmissions: ['prior repair', 'new repair'],
      }),
    }));
  });

  it('refuses reuse of a stable mapping id for a different requirement', async () => {
    mockPreviousActivation.mockResolvedValue({
      auditSeq: 7,
      activation: {
        sourceRanges: [{ sourceKind: 'codex', sessionId: 'session-full-id', fromTurn: 0, toTurn: 20 }],
        mappings: [{
          id: 'M-001',
          sourceRefs: ['session_turn:codex:session-full-id:7'],
          requirement: 'the original owner boundary remains represented',
          planTargets: ['P-001'],
          disposition: 'covered',
        }],
        repairedOmissions: [],
        rejectedOrSuperseded: [],
        unresolvedBlockers: [],
      },
    } as never);

    const result = ((await tool.handler(activationArgs({
      mappings: [{
        id: 'M-001',
        sourceRefs: ['session_turn:codex:session-full-id:7'],
        requirement: 'a different requirement tried to steal the old id',
        planTargets: ['P-001'],
        disposition: 'covered',
      }],
    }) as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({
      ok: false,
      phase: 'activation',
      error: 'activation_coverage_regression',
      previousAuditSeq: 7,
      conflicts: [expect.objectContaining({ mappingId: 'M-001', code: 'mapping_id_reused' })],
    });
    expect(mockResolveSourceRefs).not.toHaveBeenCalled();
    expect(mockRecordActivation).not.toHaveBeenCalled();
  });

  it('refuses a source ref that sessions:read cannot resolve', async () => {
    mockResolveSourceRefs.mockResolvedValue([
      { ref: 'session_turn:codex:session-full-id:7', ok: false, reason: 'not_found' },
    ]);

    const result = ((await tool.handler(activationArgs() as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: false, phase: 'activation', error: 'source_refs_unresolved' });
    expect(mockRecordActivation).not.toHaveBeenCalled();
  });

  it.each([
    ['an open mapping', {
      mappings: [{
        id: 'M-001',
        sourceRefs: ['session_turn:codex:session-full-id:7'],
        requirement: 'The owner constraint has no plan target.',
        planTargets: ['section:Open questions'],
        disposition: 'open',
      }],
    }],
    ['an unresolved blocker', {
      unresolvedBlockers: ['The owner constraint has no plan target.'],
    }],
  ])('refuses %s and returns a claimable repair lane', async (_label, over) => {
    const result = ((await tool.handler(activationArgs(over) as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({
      ok: false,
      phase: 'activation',
      error: 'activation_blocked',
      repairWorkItem: 'EI-ACTIVATION-REPAIR',
      repairFiling: { conditionKey: 'activation-audit:papercusp/plan-a', created: true },
    });
    expect(result.message).toContain('Any nonempty unresolvedBlockers list blocks and records nothing');
    expect(mockRepairFiling).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'test-workspace',
      harnessSlug: 'papercusp',
      planSlug: 'plan-a',
      activation: expect.objectContaining({ unresolvedBlockers: expect.any(Array) }),
    }));
    expect(mockResolveSourceRefs).not.toHaveBeenCalled();
    expect(mockRecordActivation).not.toHaveBeenCalled();
  });

  it('refuses a canonical ref outside every declared source range', async () => {
    const result = ((await tool.handler(activationArgs({
      sourceRanges: [{ sourceKind: 'codex', sessionId: 'session-full-id', fromTurn: 8, toTurn: 20 }],
    }) as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: false, phase: 'activation', error: 'activation_audit_invalid' });
    expect(result.problems).toEqual([
      expect.objectContaining({ itemId: 'M-001', code: 'source_ref_outside_range' }),
    ]);
    expect(mockResolveSourceRefs).not.toHaveBeenCalled();
  });

  it('normalizes a source-kind-prefixed session selector before matching canonical refs', async () => {
    const result = ((await tool.handler(activationArgs({
      sourceRanges: [{ sourceKind: 'codex', sessionId: 'codex:session-full-id', fromTurn: 0, toTurn: 20 }],
    }) as never, ctx)) as { data: any }).data;

    expect(result).toMatchObject({ ok: true, phase: 'activation', sourceRefsResolved: 1 });
    expect(mockRecordActivation).toHaveBeenCalledWith(expect.objectContaining({
      activation: expect.objectContaining({
        sourceRanges: [{ sourceKind: 'codex', sessionId: 'session-full-id', fromTurn: 0, toTurn: 20 }],
      }),
    }));
  });

  it('persists an externally-censused scattered conversation map with no missing obligation', async () => {
    const mappings = [
      {
        id: 'M-001',
        sourceRefs: ['session_turn:codex:session-full-id:4'],
        requirement: 'Requirement: the export must remain backward compatible.',
        planTargets: ['P-001'],
        disposition: 'covered',
      },
      {
        id: 'M-002',
        sourceRefs: ['session_turn:codex:session-full-id:18'],
        requirement: 'Scope boundary: completion audit behavior remains backward compatible.',
        planTargets: ['section:Requirements'],
        disposition: 'covered',
      },
      {
        id: 'M-003',
        sourceRefs: ['session_turn:codex:session-full-id:34'],
        requirement: 'Constraint: audit references must be directly retrievable.',
        planTargets: ['P-001'],
        disposition: 'covered',
      },
      {
        id: 'M-004',
        sourceRefs: ['session_turn:codex:session-full-id:57', 'session_turn:codex:session-full-id:61'],
        requirement: 'Correction: use the canonical reader rather than the earlier proposed copy.',
        planTargets: ['D-001'],
        disposition: 'repaired',
      },
      {
        id: 'M-005',
        sourceRefs: ['session_turn:codex:session-full-id:82'],
        requirement: 'Rejected alternative: never add a parallel plan-review verb.',
        planTargets: ['D-004'],
        disposition: 'rejected',
      },
      {
        id: 'M-006',
        sourceRefs: ['session_turn:codex:session-full-id:101'],
        requirement: 'Decision: the audit remains after later edits.',
        planTargets: ['D-002'],
        disposition: 'covered',
      },
      {
        id: 'M-007',
        sourceRefs: ['session_turn:codex:session-full-id:119'],
        requirement: 'Dependency: canonical session refs land before activation audit writes.',
        planTargets: ['P-003'],
        disposition: 'covered',
      },
      {
        id: 'M-008',
        sourceRefs: ['session_turn:codex:session-full-id:132'],
        requirement: 'Sequencing: repair omissions before recording the activation audit.',
        planTargets: ['section:Phase 2 — Audit and activation behavior'],
        disposition: 'covered',
      },
      {
        id: 'M-009',
        sourceRefs: ['session_turn:codex:session-full-id:143'],
        requirement: 'Acceptance condition: cosmetic edits preserve the audit.',
        planTargets: ['section:Requirements'],
        disposition: 'covered',
      },
      {
        id: 'M-010',
        sourceRefs: ['session_turn:codex:session-full-id:167'],
        requirement: 'Open question resolved: the editing agent judges semantic materiality.',
        planTargets: ['D-002'],
        disposition: 'covered',
      },
      {
        id: 'M-011',
        sourceRefs: ['session_turn:codex:session-full-id:198'],
        requirement: 'A promised follow-up must remain represented in the execution plan.',
        planTargets: ['P-006'],
        disposition: 'covered',
      },
    ];
    const refs = mappings.flatMap((mapping) => mapping.sourceRefs);
    mockResolveSourceRefs.mockImplementation(async (_sql, _workspaceId, requested) =>
      requested.map((ref) => ({ ref, ok: true as const, source: 'index' as const })),
    );

    const result = ((await tool.handler(activationArgs({
      sourceRanges: [{ sourceKind: 'codex', sessionId: 'session-full-id', fromTurn: 0, toTurn: 220 }],
      mappings,
      repairedOmissions: ['Replaced the superseded copy design with the canonical reader.'],
      rejectedOrSuperseded: ['Rejected automatic invalidation after cosmetic edits.'],
    }) as never, ctx)) as { data: any }).data;

    expect(missingConversationObligations(mappings)).toEqual([]);
    expect(result).toMatchObject({ ok: true, phase: 'activation', sourceRefsResolved: refs.length });
    expect(mockResolveSourceRefs).toHaveBeenCalledWith(expect.anything(), 'test-workspace', refs);
    expect(mockRecordActivation).toHaveBeenCalledWith(expect.objectContaining({
      activation: expect.objectContaining({
        mappings,
        repairedOmissions: ['Replaced the superseded copy design with the canonical reader.'],
        rejectedOrSuperseded: ['Rejected automatic invalidation after cosmetic edits.'],
        unresolvedBlockers: [],
      }),
    }));
  });

  it('the external completeness oracle catches one omitted obligation before writer acceptance', () => {
    const mappings = COMPLETE_CONVERSATION_OBLIGATION_IDS.slice(0, -1).map((id) => ({
      id,
      disposition: 'covered',
    }));

    expect(missingConversationObligations(mappings)).toEqual(['M-011']);
  });
});

// plan-verification-friction-reduction-2026-10-11 P-003 (rubric R-3): an activation audit
// derives an omitted classRef from the plan's latest spec-quality evaluation, a completion
// audit ignores a stray classRef, and either way the class must match the plan's persisted
// acceptance class.
describe('plans:audit activation classRef derivation (P-003)', () => {
  type AcceptanceRubricRows = Awaited<ReturnType<typeof getAcceptanceRubricsForPlan>>;
  type ScorecardRows = Awaited<ReturnType<typeof listScorecards>>;
  // One cast seam per fixture shape: the resolver reads only rubricId/classRef from a rubric
  // and issueId/subject.ref from a scorecard, so the wide row types are filled partially here.
  const acceptanceRubric = (classRef: PlanClassRubricRef): AcceptanceRubricRows =>
    [{ rubricId: 'acceptance-plan-a', classRef }] as unknown as AcceptanceRubricRows;
  /** Spec-quality cards for plan-a, NEWEST FIRST (the order listScorecards returns). */
  const specQualityCards = (...classRefs: PlanClassRubricRef[]): ScorecardRows =>
    classRefs.map((classRef, index) => ({
      issueId: `EI-SPEC-QUALITY-${index}`,
      createdAt: `2026-10-11T0${9 - index}:00:00.000Z`,
      createdBy: 'su-author',
      subject: { ref: specQualitySubjectRef('plan-a', classRef, `${index}`.repeat(64)), kind: 'spec-set' },
    })) as unknown as ScorecardRows;
  const activationWithoutClassRef = () => {
    const { classRef: _omitted, ...args } = activationArgs();
    return args;
  };
  const run = async (args: Record<string, unknown>) =>
    ((await tool.handler(args as never, ctx)) as { data: any }).data;

  it('derives classRef from the latest spec-quality evaluation when an activation call omits it', async () => {
    mockListScorecards.mockResolvedValue(specQualityCards('plan-class-feature-ship', 'plan-class-bugfix'));

    const result = await run(activationWithoutClassRef());

    expect(result).toMatchObject({
      ok: true,
      phase: 'activation',
      classRefResolution: { classRef: 'plan-class-feature-ship', source: 'derived', evaluationScorecardId: 'EI-SPEC-QUALITY-0' },
    });
    expect(mockListScorecards).toHaveBeenCalledWith(expect.objectContaining({
      rubricRef: SPEC_QUALITY_RUBRIC_REF,
      subjectRefLike: expect.stringMatching(/^spec-set:%:[0-9a-f]{16}$/),
    }));
    // The newest card's class seeds the BARs; the older bugfix evaluation is not used.
    expect(mockRecordActivation).toHaveBeenCalledWith(expect.objectContaining({ classRef: 'plan-class-feature-ship' }));

    // A plan with no evaluation record still refuses, naming the tool that creates one.
    mockListScorecards.mockResolvedValue([]);
    mockRecordActivation.mockClear();
    const refused = await run(activationWithoutClassRef());
    expect(refused).toMatchObject({
      ok: false,
      phase: 'activation',
      error: 'activation_audit_invalid',
      problems: [expect.objectContaining({
        code: 'class_ref_required',
        detail: expect.stringContaining('plans:evaluate-spec-quality'),
      })],
    });
    expect(mockRecordActivation).not.toHaveBeenCalled();
  });

  it('accepts a completion-phase audit carrying classRef and notes that it was ignored', async () => {
    const items = [{ itemId: 'P-001', verdict: 'implemented', citations: [{ kind: 'code', path: 'src/gate.ts', symbol: 'gate' }] }];
    expect(tool.args.safeParse({ slug: 'plan-a', harness: 'papercusp', items, classRef: 'plan-class-bugfix' }).success)
      .toBe(true);

    const result = await body(items, { classRef: 'plan-class-bugfix' });

    expect(result).toMatchObject({ ok: true, slug: 'plan-a', coverage: { auditedItems: 1, verifiedItems: 1 } });
    expect(result.note).toContain("classRef 'plan-class-bugfix' was ignored");
    expect(mockRecord).toHaveBeenCalled();
    // Completion never consults the class sources.
    expect(mockListScorecards).not.toHaveBeenCalled();
    expect(mockAcceptanceRubrics).not.toHaveBeenCalled();
  });

  it("refuses an activation whose classRef differs from the plan's persisted acceptance class", async () => {
    mockAcceptanceRubrics.mockResolvedValue(acceptanceRubric('plan-class-feature-ship'));

    // A supplied classRef that disagrees with the persisted class.
    const supplied = await run(activationArgs({ classRef: 'plan-class-bugfix' }));
    expect(supplied).toMatchObject({
      ok: false,
      phase: 'activation',
      error: 'activation_audit_invalid',
      problems: [expect.objectContaining({
        code: 'class_ref_mismatch',
        detail: expect.stringContaining("supplied classRef 'plan-class-bugfix' differs from plan 'plan-a's persisted acceptance class 'plan-class-feature-ship'"),
      })],
    });
    expect(mockAcceptanceRubrics).toHaveBeenCalledWith('plan-a', expect.objectContaining({ harnessSlug: 'papercusp', strict: true }));

    // A derived classRef whose evaluation ran under a different class.
    mockListScorecards.mockResolvedValue(specQualityCards('plan-class-bugfix'));
    const derived = await run(activationWithoutClassRef());
    expect(derived).toMatchObject({
      ok: false,
      problems: [expect.objectContaining({
        code: 'class_ref_mismatch',
        detail: expect.stringContaining("derived classRef 'plan-class-bugfix'"),
      })],
    });
    expect(mockPreviewActivation).not.toHaveBeenCalled();
    expect(mockRecordActivation).not.toHaveBeenCalled();

    // Control: the matching class proceeds, so the refusals above are about the mismatch alone.
    const matching = await run(activationArgs({ classRef: 'plan-class-feature-ship' }));
    expect(matching).toMatchObject({ ok: true, phase: 'activation' });
    expect(mockRecordActivation).toHaveBeenCalledWith(expect.objectContaining({ classRef: 'plan-class-feature-ship' }));
  });
});
