/**
 * plans:audit activation — reverse item provenance (plan-item-provenance-2026-09-29
 * P-002; R-2 and R-3).
 *
 * Handler-level: the real resolver and the real session_turns origin lookup run; only
 * the database, the plan row and the audit writers are mocked. The session_turns rows
 * are served by query text, so each test states exactly which turns exist and who
 * spoke them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    getEffectiveItemAudits: vi.fn(),
    getLatestActivationAudit: vi.fn(),
    repoCitationContextForHarness: vi.fn(),
    recordPlanAudit: vi.fn(),
    recordCurrentActivationAudit: vi.fn(),
  };
});
vi.mock('./activation-audit-repair', () => ({
  ensureActivationAuditRepairFiling: vi.fn(),
}));
// Mocked wholesale: the factory must cover every export the import graph reaches
// (see the same note in audit.test.ts).
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
// plan-verification-friction-reduction-2026-10-11 P-003: the activation classRef resolver
// reads the acceptance rubric and spec-quality cards; with neither, a supplied classRef passes.
vi.mock('../../rubrics', async (orig) => ({
  ...(await orig<typeof import('../../rubrics')>()),
  getAcceptanceRubricsForPlan: vi.fn(async () => []),
}));
vi.mock('../../scorecards', async (orig) => ({
  ...(await orig<typeof import('../../scorecards')>()),
  listScorecards: vi.fn(async () => []),
}));

import { getLatestActivationAudit, recordCurrentActivationAudit, type ActivationAuditPayload, type PlanAudit } from '../../plan-audits';
import { mockImplementationTyped, mockResolvedTyped } from '../../testing/typed-mock';
import { ensureActivationAuditRepairFiling } from './activation-audit-repair';
import { getPlanRow, type PlanRow } from './source';
import { setSpecClause } from './spec-clauses-store';
import { previewPlanStartConsult } from './get-activation-readiness';
import { resolveSessionTurnRefs } from '../sessions/_shared';
import { classifyHitTurnOrigin } from '../sessions/turn-origin';
import tool from './audit';

const mockPreviousActivation = vi.mocked(getLatestActivationAudit);
const mockRecordActivation = vi.mocked(recordCurrentActivationAudit);
const mockResolveSourceRefs = vi.mocked(resolveSessionTurnRefs);
const mockGetPlanRow = vi.mocked(getPlanRow);

const ctx = {
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  role: 'operator',
  workspaceId: 'test-workspace',
  tx: vi.fn(),
} as never;

const SESSION = 'session-full-id';
const ref = (turn: number) => `session_turn:codex:${SESSION}:${turn}`;

/** Turn 3: the owner typed it. Turn 4: the agent's own reply. Turn 5: a loop-fire replay
 *  of the agent's goal — recorded with speaker='user', which is exactly the trap. Turn 6
 *  is cited but absent from the corpus (origin unknown). */
const OWNER_HEAD = 'Please make the activation audit refuse plan items nobody asked for.';
const LOOP_FIRE_HEAD = '⟦turn-origin:loop-fire nonce:71c4d88911627947⟧\nCarry the plan to shipped: also add a GUI badge.';
const TURNS: Record<number, { speaker: string; head: string; turn_origin_verdict?: string }> = {
  3: { speaker: 'user', head: OWNER_HEAD },
  4: { speaker: 'assistant', head: 'I will also add a GUI badge for every item.' },
  5: { speaker: 'user', head: LOOP_FIRE_HEAD },
  7: { speaker: 'user', head: 'Implement the existing plan.', turn_origin_verdict: 'unenrolled-origin' },
};

const planContent = (items: string[]) =>
  `---\ntitle: Plan A\nslug: plan-a\nstatus: draft\ncreated: 2026-09-29\nupdated: 2026-09-29\nowner: test\n---\n\n## Items\n\n${items.join('\n')}\n`;
const TWO_ITEMS = planContent([
  '- **P-001** `todo` Refuse unsourced items at activation.',
  '- **P-002** `todo` Add a GUI badge per item.',
]);

const mapping = (id: string, turns: number[], targets: string[]) => ({
  id,
  sourceRefs: turns.map(ref),
  requirement: `requirement ${id}`,
  planTargets: targets,
  disposition: 'covered' as const,
});

const activationArgs = (over: Record<string, unknown> = {}) => ({
  slug: 'plan-a',
  harness: 'papercusp',
  phase: 'activation',
  classRef: 'plan-class-bugfix',
  sourceRanges: [{ sourceKind: 'codex', sessionId: SESSION, fromTurn: 0, toTurn: 20 }],
  mappings: [mapping('M-001', [3], ['P-001'])],
  repairedOmissions: [],
  rejectedOrSuperseded: [],
  unresolvedBlockers: [],
  ...over,
});

/**
 * Fully typed row fixtures for the two seams. audit.ts reads only `content` from the
 * PlanRow and `auditSeq` + `activation` from the previous PlanAudit, but each fixture
 * is a complete row so a new required field fails HERE at compile time rather than as
 * a runtime surprise (lint:mock-cast-escape; typed-mock.ts).
 */
const planRowFixture = (content: string): PlanRow => ({
  workspaceId: 'workspace', harnessSlug: 'papercusp', planSlug: 'plan-a', content,
  contentHash: 'content-hash', version: 1, title: null, status: null, created: null,
  updated: null, owner: null, initiative: null, template: null, templateData: null,
  inputSchema: null, outputSchema: null, supersedes: [], supersededBy: null,
  opStatus: null, opStartedAt: null, opUpdatedAt: null, currentWave: null, opPriority: null,
  archived: false, isLegacy: false, updatedAt: '2026-09-30T00:00:00.000Z', items: [],
  decisions: [], nowState: null, nowNext: null, nowNote: null, promotePolicy: null, forcedPast: null,
  schedule: null, scheduleActive: false, scheduledAt: null, expiresAt: null, tzid: null,
  templateSlug: null, runSeq: null,
});
const previousAuditFixture = (
  previous: { auditSeq: number; activation: ActivationAuditPayload },
): PlanAudit => ({
  planSlug: 'plan-a', harnessSlug: 'papercusp', auditSeq: previous.auditSeq,
  createdBy: 'test-author', createdAt: '2026-09-30T00:00:00.000Z', auditKind: 'activation',
  auditedSha: null, activation: previous.activation, auditedPlanRevision: null,
  items: [], findings: [], summary: null,
});
const resolvePlanContent = (content: string): void => {
  mockResolvedTyped(mockGetPlanRow, planRowFixture(content));
};
const resolvePreviousActivation = (previousAudit: { auditSeq: number; activation: ActivationAuditPayload }): void => {
  mockResolvedTyped(mockPreviousActivation, previousAuditFixture(previousAudit));
};

const run = async (args: Record<string, unknown>) =>
  ((await tool.handler(args as never, ctx)) as { data: any }).data;

const storedActivation = () => (mockRecordActivation.mock.calls[0]?.[0] as { activation: any } | undefined)?.activation;

beforeEach(() => {
  vi.clearAllMocks();
  mockOrgSql.mockImplementation((...args: unknown[]) => {
    const first = args[0];
    if (!Array.isArray(first) || !('raw' in first)) return first;
    const text = (first as unknown as string[]).join('?');
    // The item-provenance origin lookup: serve only the turns the query asked for.
    if (text.includes('AS head') && text.includes('harness_shared.session_turns')) {
      const wantedTurns = (args.find((value, index) => index > 0 && Array.isArray(value) &&
        value.every((entry) => typeof entry === 'number')) ?? []) as number[];
      return Promise.resolve(
        wantedTurns
          .filter((turn) => TURNS[turn])
          .map((turn) => ({ source_kind: 'codex', session_id: SESSION, turn_idx: turn, ...TURNS[turn] })),
      );
    }
    return Promise.resolve([]);
  });
  mockImplementationTyped(mockResolveSourceRefs, async (_sql, _ws, refs) =>
    refs.map((value) => ({ ref: value, ok: true, source: 'index' as const })));
  mockPreviousActivation.mockResolvedValue(null);
  resolvePlanContent(TWO_ITEMS);
  vi.mocked(setSpecClause).mockResolvedValue({
    status: 'created',
    specId: 'AUTO-REQ-M-001-P-001',
    revision: 1,
    contentHash: 'c'.repeat(64),
  });
  mockRecordActivation.mockResolvedValue({
    ok: true,
    audit: { auditSeq: 1 } as never,
    auditedPlanRevision: { id: 41, seq: 6, contentHash: 'a'.repeat(64) },
  });
  vi.mocked(previewPlanStartConsult).mockResolvedValue({ outcome: 'proceed', verdict: 'no_qualified_responder' });
  vi.mocked(ensureActivationAuditRepairFiling).mockResolvedValue({
    conditionKey: 'activation-audit:papercusp/plan-a',
    id: 'EI-ACTIVATION-REPAIR',
    created: true,
  });
});

describe('fixture calibration', () => {
  it('classifies the fixture turns the way the assertions below assume', () => {
    // If the classifier's envelope grammar changes, these fail HERE rather than letting
    // the refusal tests below pass or fail for an unrelated reason.
    expect(['owner-typed', 'owner-turn', 'owner-dialog']).toContain(classifyHitTurnOrigin('user', OWNER_HEAD).verdict);
    expect(classifyHitTurnOrigin('assistant', TURNS[4].head).verdict).toBe('not-user-turn');
    expect(classifyHitTurnOrigin('user', LOOP_FIRE_HEAD).verdict).toBe('agent-injected');
  });
});

describe('plans:audit activation — first audit is enforced (R-2)', () => {
  it('refuses item_provenance_missing naming the item no mapping or declaration backs, and records nothing', async () => {
    const result = await run(activationArgs());

    expect(result).toMatchObject({
      ok: false,
      error: 'item_provenance_missing',
      unresolvedItems: ['P-002'],
      problems: [expect.objectContaining({ itemId: 'P-002', code: 'no_mapping' })],
    });
    expect(result.message).toContain('P-002');
    expect(mockRecordActivation).not.toHaveBeenCalled();
  });

  it('records the audit with a stored per-item check once every item resolves', async () => {
    const result = await run(activationArgs({
      itemProvenance: [{ itemId: 'P-002', kind: 'derived', from: ['P-001'] }],
    }));

    expect(result).toMatchObject({
      ok: true,
      phase: 'activation',
      itemProvenance: { enforced: true, unresolved: [], counts: { owner: 1, derived: 1, 'agent-added': 0, unresolved: 0 } },
    });
    // D-005: the per-ref verdicts the labels were computed from are persisted with them.
    expect(storedActivation()?.itemProvenanceCheck).toEqual({
      version: 1,
      enforced: true,
      items: { 'P-001': 'owner', 'P-002': 'derived' },
      unresolved: [],
      refOrigins: { [ref(3)]: classifyHitTurnOrigin('user', OWNER_HEAD).verdict },
    });
    expect(storedActivation()?.itemProvenance).toEqual([{ itemId: 'P-002', kind: 'derived', from: ['P-001'] }]);
  });

  it('accepts an agent-added item only with its reason, and labels it agent-added', async () => {
    const result = await run(activationArgs({
      itemProvenance: [{ itemId: 'P-002', kind: 'agent-added', reason: 'A badge makes the new label visible to the owner.' }],
    }));

    expect(result).toMatchObject({ ok: true, itemProvenance: { enforced: true, unresolved: [] } });
    expect(storedActivation()?.itemProvenanceCheck.items).toEqual({ 'P-001': 'owner', 'P-002': 'agent-added' });
  });

  it('refuses item_provenance_invalid for a declaration naming an item the plan does not have', async () => {
    const result = await run(activationArgs({
      itemProvenance: [
        { itemId: 'P-002', kind: 'derived', from: ['P-001'] },
        { itemId: 'P-009', kind: 'agent-added', reason: 'stale id' },
      ],
    }));

    expect(result).toMatchObject({
      ok: false,
      error: 'item_provenance_invalid',
      problems: [expect.objectContaining({ itemId: 'P-009', code: 'provenance_item_unknown' })],
    });
    expect(mockRecordActivation).not.toHaveBeenCalled();
  });

  it('keeps a derived item unresolved when its source is not itself owner-backed', async () => {
    const result = await run(activationArgs({
      mappings: [mapping('M-001', [4], ['P-001'])],
      itemProvenance: [{ itemId: 'P-002', kind: 'derived', from: ['P-001'] }],
    }));

    expect(result).toMatchObject({ ok: false, error: 'item_provenance_missing', unresolvedItems: ['P-001', 'P-002'] });
    expect(result.problems).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemId: 'P-002', code: 'derived_source_not_owner_backed' }),
    ]));
  });

  it('rejects itemProvenance on a completion audit', () => {
    expect(tool.args.safeParse({
      slug: 'plan-a',
      harness: 'papercusp',
      phase: 'completion',
      items: [{ itemId: 'P-001', verdict: 'implemented', citations: [{ kind: 'code', path: 'src/gate.ts' }] }],
      itemProvenance: [{ itemId: 'P-001', kind: 'agent-added', reason: 'x' }],
    }).success).toBe(false);
  });
});

describe('plans:audit activation — only owner turns count as owner evidence (R-3)', () => {
  it('does not accept an assistant turn, a loop-fire replay or an unreadable turn as owner provenance', async () => {
    const result = await run(activationArgs({
      mappings: [
        mapping('M-001', [4], ['P-001']),
        mapping('M-002', [5, 6], ['P-002']),
      ],
    }));

    expect(result).toMatchObject({ ok: false, error: 'item_provenance_missing', unresolvedItems: ['P-001', 'P-002'] });
    expect(result.problems).toEqual([
      expect.objectContaining({ itemId: 'P-001', code: 'no_owner_ref' }),
      expect.objectContaining({ itemId: 'P-002', code: 'no_owner_ref' }),
    ]);
    // The lookup ran as ONE query with array-typed parameters.
    expect(mockOrgSqlArray).toHaveBeenCalledWith([4, 5, 6]);
  });

  it('accepts the same item once a mapping cites the owner turn', async () => {
    const result = await run(activationArgs({
      mappings: [mapping('M-001', [4, 3], ['P-001', 'P-002'])],
    }));

    expect(result).toMatchObject({ ok: true, itemProvenance: { enforced: true, counts: { owner: 2, unresolved: 0 } } });
  });
});

describe('plans:audit activation — re-audits', () => {
  const previous = (check?: ActivationAuditPayload['itemProvenanceCheck']) => ({
    auditSeq: 1,
    activation: {
      sourceRanges: [{ sourceKind: 'codex' as const, sessionId: SESSION, fromTurn: 0, toTurn: 20 }],
      mappings: [mapping('M-001', [3], ['P-001'])],
      repairedOmissions: [],
      rejectedOrSuperseded: [],
      unresolvedBlockers: [],
      ...(check ? { itemProvenanceCheck: check } : {}),
    },
  });

  it('records a legacy plan (earlier audit predates item provenance) unenforced, with the gap as a warning', async () => {
    resolvePreviousActivation(previous());

    const result = await run(activationArgs({ mappings: undefined, sourceRanges: undefined }));

    expect(result).toMatchObject({ ok: true, itemProvenance: { enforced: false, unresolved: ['P-002'] } });
    expect(result.itemProvenance.warning).toContain('P-002');
    expect(storedActivation()?.itemProvenanceCheck).toMatchObject({ enforced: false, unresolved: ['P-002'] });
  });

  it('ratchets a legacy plan onto enforcement once every item resolves', async () => {
    resolvePreviousActivation(previous());

    const result = await run(activationArgs({
      mappings: undefined,
      sourceRanges: undefined,
      itemProvenance: [{ itemId: 'P-002', kind: 'agent-added', reason: 'Visible label for the owner.' }],
    }));

    expect(result).toMatchObject({ ok: true, itemProvenance: { enforced: true, unresolved: [] } });
  });

  it.each([false, true])('explains an unresolved supplied derivation from an unenrolled source (dryRun=%s)', async (dryRun) => {
    const prior = previous();
    prior.activation.mappings = [mapping('M-001', [7], ['P-001'])];
    resolvePreviousActivation(prior);
    const declaration = { itemId: 'P-002', kind: 'derived', from: ['P-001'] };

    const result = await run(activationArgs({
      mappings: undefined, sourceRanges: undefined, dryRun, itemProvenance: [declaration],
    }));

    expect(result).toMatchObject({
      ok: true, itemProvenance: { enforced: false, counts: { derived: 0, unresolved: 2 }, unresolved: ['P-001', 'P-002'] },
    });
    expect(result.itemProvenance.warning).toContain('P-001: its mappings cite only assistant, machine-injected or unreadable turns');
    expect(result.itemProvenance.warning).toContain('P-002: it is declared derived, but none of its sources is owner-backed');
    expect(result.itemProvenance.warning).not.toContain('declare them via itemProvenance');
    if (dryRun) {
      expect(mockRecordActivation).not.toHaveBeenCalled();
    } else {
      expect(storedActivation()?.itemProvenance).toEqual([declaration]);
      expect(storedActivation()?.itemProvenanceCheck.refOrigins).toEqual({ [ref(7)]: 'unknown' });
    }
  });

  it('refuses a re-audit of an enforced plan that gained an unsourced item', async () => {
    resolvePreviousActivation(previous({
      version: 1,
      enforced: true,
      items: { 'P-001': 'owner' },
      unresolved: [],
      refOrigins: { [ref(3)]: 'owner-turn' },
    }));

    const result = await run(activationArgs({ mappings: undefined, sourceRanges: undefined }));

    expect(result).toMatchObject({ ok: false, error: 'item_provenance_missing', unresolvedItems: ['P-002'] });
    expect(mockRecordActivation).not.toHaveBeenCalled();
  });

  // WI-10006324: the carried declaration used to fail provenance_item_unknown forever.
  it('stays re-auditable after a provenance-declared item is dropped, retiring the carried declaration', async () => {
    const declared = previous();
    resolvePreviousActivation({
      ...declared,
      activation: {
        ...declared.activation,
        itemProvenance: [{ itemId: 'P-002', kind: 'agent-added', reason: 'Visible label for the owner.' }],
      },
    });
    resolvePlanContent(planContent([
      '- **P-001** `todo` Refuse unsourced items at activation.',
      '- **P-002** `dropped` Add a GUI badge per item.',
    ]));

    const result = await run(activationArgs({ mappings: undefined, sourceRanges: undefined }));

    expect(result).toMatchObject({ ok: true, itemProvenance: { unresolved: [] } });
    expect(storedActivation()?.itemProvenance ?? []).toEqual([]);
    expect(storedActivation()?.rejectedOrSuperseded).toContain(
      'itemProvenance for P-002 retired: P-002 is dropped or absent from the current plan revision');
  });
});
