/** scorecards:get — the evidence-first single-card audit read. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dispatchProjectedTool,
  lookupByMcpName,
  readJsonResult,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import { PAYLOAD_TIER_HARD_CEILING_CHARS, PAYLOAD_TIER_RATCHET_CHARS } from '@papercusp/tooldef';
import { DbCallDeadlineError } from '@papercusp/db-org';
import { OrgTxnTimeoutError } from '../../pg-bounded-txn';
import type { SpecTestAdequacyRerunRecipe } from '../../harness/improvements/observation-types';
import { currentStageDiagnosticContext, STAGE_STALL_LOG_MS } from '../../sync/hyperbee/stage-stall-log';

const { doorConstantsMock, gradingAuditRubricMock, recipeHeaderMock } = vi.hoisted(() => ({
  doorConstantsMock: vi.fn(),
  gradingAuditRubricMock: vi.fn(),
  recipeHeaderMock: vi.fn(),
}));
vi.mock('../../context-doors-config', () => ({ getDoorConstantsSync: doorConstantsMock }));

vi.mock('../../rubrics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../rubrics')>();
  return { ...actual, getRubricWithoutSeeding: (...args: unknown[]) => gradingAuditRubricMock(...args) };
});

vi.mock('../../scorecards', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scorecards')>();
  return {
    ...actual,
    readScorecardEvidence: vi.fn(),
    readScorecardRecipeHeader: recipeHeaderMock,
  };
});

import { readScorecardEvidence, readScorecardRecipeHeader } from '../../scorecards';
import { BAKED_DOOR_CONSTANTS, CHARS_PER_TOKEN_ESTIMATE, computeTurnDoors } from '../../context-doors';
import { applyResultDoor, resetResultDoorAggregatesForTests } from '../../result-door';

const readScorecardEvidenceM = vi.mocked(readScorecardEvidence);
const readScorecardRecipeHeaderM = vi.mocked(readScorecardRecipeHeader);
const recipeHeaderOf = (card: Record<string, unknown>) => Object.fromEntries(
  Object.entries(card).filter(([key]) => ![
    'criteria', 'nKeys', 'missingKeys', 'extraKeys', 'rubricResolved',
  ].includes(key)),
);
const { default: getTool, scorecardGetArgs } = await import('./get');
/** The registered output contract, narrowed to the parse surface these cases exercise. */
const resultContract = getTool.result as unknown as {
  safeParse: (value: unknown) => { success: boolean };
};

const makeDispatchContext = (overrides: Partial<UnifiedToolContext> = {}): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: 'default',
  runId: 'scorecards-get-evidence-test',
  isSuperuser: true,
  uiClientId: 'su-scorecards-get-test',
  role: 'su',
  gateBypass: { role: true, capability: true, quota: true },
  transport: 'mcp',
  requestedFormat: 'json',
  contextTier: 'trimmed',
  tx: {},
  ...overrides,
});

const rerunRecipe: SpecTestAdequacyRerunRecipe = {
  schemaVersion: 1,
  evaluator: 'plans:evaluate-spec-test-adequacy',
  classRef: 'plan-class-risk-floor',
  args: {
    harness: 'papercusp',
    slug: 'reconnect-plan',
    classRef: 'plan-class-risk-floor',
    specIds: ['SPEC-003-01'],
    includeDraft: true,
  },
  selection: {
    planSlug: 'reconnect-plan',
    specId: 'SPEC-003-01',
    specRevision: 1,
    specFingerprint: 'sha256:spec-v1',
    evidence: [{ evidenceKind: 'integration fixture', evidenceRef: 'surface:reconnect' }],
  },
  current: { supplied: false, fingerprints: [] },
  derivation: {
    kind: 'listSpecEvidence.currentness',
    classifier: 'classifySpecEvidenceCurrentness',
    unknownWhenMissing: true,
  },
};

const scorecard = {
  issueId: 'EI-audited-card',
  createdAt: '2026-09-08T19:00:00.000Z',
  createdBy: 'su-grader',
  rubricRef: 'spec-test-adequacy',
  rubricRevision: 2,
  criteriaHash: 'criteria-hash-v2',
  rubricCurrentness: {
    state: 'current' as const, reason: 'current' as const, recordedRevision: 2, currentRevision: 2,
    recordedCriteriaHash: 'criteria-hash-v2', currentCriteriaHash: 'criteria-hash-v2',
  },
  evidenceFingerprint: 'evidence-fingerprint-v2',
  rerunRecipe,
  subject: { kind: 'scorecard' as const, ref: 'EI-subject' },
  criteria: Array.from({ length: 8 }, (_, i) => ({
    key: `criterion-${i + 1}`,
    rating: i === 7 ? 'partial' : 'pass',
    evidence: `run probe criterion-${i + 1}: ${'e'.repeat(1200)}`,
  })),
  nKeys: 8,
  missingKeys: [],
  extraKeys: [],
  rubricResolved: true,
  synthesized: false,
  auditTarget: { current: true, superseded: false, supersededBy: null, retracted: false, subjectRubricCurrentness: null },
};

describe('scorecards:get evidence-first projection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    doorConstantsMock.mockReturnValue(BAKED_DOOR_CONSTANTS);
    gradingAuditRubricMock.mockResolvedValue(null);
    readScorecardRecipeHeaderM.mockResolvedValue({
      kind: 'found', scorecard: recipeHeaderOf(scorecard) as never,
    });
    resetResultDoorAggregatesForTests();
  });

  it('distinguishes live adequacy freshness checks from creation-time grading audits', () => {
    const prompt = getTool as unknown as {
      description: string;
      guidance: { when: string; notWhen: string; chaining: string };
    };
    const guidance = [
      prompt.description,
      prompt.guidance.when,
      prompt.guidance.notWhen,
      prompt.guidance.chaining,
    ].join('\n');

    expect(guidance).toContain('scorecardId');
    expect(guidance).toContain('historicalAuditOnly.asOf');
    expect(guidance).toContain('current-state');
    expect(guidance).toContain('freshness can change after evidence changes');
  });

  it('declares optional result roots with concrete scorecard and paging fields', () => {
    const missingCard = resultContract.safeParse({
      ok: false,
      error: "scorecard 'EI-missing' not found",
    });
    expect(missingCard.success).toBe(true);

    const unknownAuditTarget = resultContract.safeParse({
      ok: true,
      scorecard: {
        ...scorecard,
        auditTarget: {
          ...scorecard.auditTarget,
          current: null,
          subjectRubricCurrentness: {
            state: 'unknown',
            reason: 'live-identity-missing',
            recordedRevision: 4,
            currentRevision: null,
            recordedCriteriaHash: 'criteria-hash-v4',
            currentCriteriaHash: null,
          },
        },
      },
    });
    expect(unknownAuditTarget.success).toBe(true);

    const index = resultContract.safeParse({
      ok: true,
      scorecard: { ...scorecard, criteria: [] },
      evidenceRead: {
        complete: false,
        reason: 'card-exceeds-inline-budget',
        criteria: [{
          key: 'traceability',
          rating: 'pass',
          evidenceChars: 120,
          read: {
            tool: 'scorecards:get',
            args: { issueId: scorecard.issueId, criterionKey: 'traceability', evidenceOffset: 0 },
          },
        }],
      },
    });
    expect(index.success).toBe(true);

    const page = resultContract.safeParse({
      ok: true,
      scorecard: { ...scorecard, criteria: [{ ...scorecard.criteria[0], evidence: 'evidence page' }] },
      evidenceRead: {
        complete: false,
        scope: 'selected-criterion',
        offset: 0,
        totalChars: 120,
        next: {
          tool: 'scorecards:get',
          args: { issueId: scorecard.issueId, criterionKey: 'traceability', evidenceOffset: 13 },
        },
      },
    });
    expect(page.success).toBe(true);
    expect(resultContract.safeParse({ ok: true, scorecard: {} }).success).toBe(false);
  });

  it('surfaces read-time grading-audit stamp currentness', async () => {
    const gradingAudit = {
      state: 'pending' as const,
      metaRubricRef: 'grading-integrity',
      stampedAt: '2026-10-06T00:00:00.000Z',
      rubricRevision: 10,
      criteriaHash: 'hash-before-edit',
    };
    let rubricContext: ReturnType<typeof currentStageDiagnosticContext> = null;
    readScorecardEvidenceM.mockResolvedValue({
      kind: 'found',
      scorecard: { ...scorecard, gradingAudit },
    });
    gradingAuditRubricMock.mockImplementation(async () => {
      rubricContext = currentStageDiagnosticContext();
      return {
        rubricId: 'grading-integrity',
        revision: 12,
        criteriaHash: 'hash-current',
      };
    });
    const metadata = vi.fn();

    const result = await getTool.handler(
      { issueId: scorecard.issueId } as never,
      makeDispatchContext({ metadata }),
    );

    expect(result).toMatchObject({
      data: {
        ok: true,
        scorecard: {
          gradingAuditCurrentness: {
            state: 'stale',
            reason: 'criteria-hash-mismatch',
            recordedRevision: 10,
            currentRevision: 12,
            recordedCriteriaHash: 'hash-before-edit',
            currentCriteriaHash: 'hash-current',
          },
        },
      },
    });
    expect(rubricContext).toMatchObject({
      stage: 'scorecards-get-rubric-read',
      boundary: 'await',
    });
    const diagnostics = (result as {
      data: { diagnostics: { stages: Array<{ stage: string; outcome: string }> } };
    }).data.diagnostics;
    expect(diagnostics.stages).toEqual([
      expect.objectContaining({ stage: 'scorecards-get-evidence-read', outcome: 'fulfilled' }),
      expect.objectContaining({ stage: 'scorecards-get-rubric-read', outcome: 'fulfilled' }),
    ]);
    expect(metadata).toHaveBeenLastCalledWith({ scorecardsGetDiagnostics: diagnostics });
  });

  it('returns bounded phase timings correlated with the PG diagnostic context', async () => {
    let readContext: ReturnType<typeof currentStageDiagnosticContext> = null;
    readScorecardEvidenceM.mockImplementation(async () => {
      readContext = currentStageDiagnosticContext();
      return { kind: 'found', scorecard };
    });
    const metadata = vi.fn();

    const result = await getTool.handler(
      { issueId: scorecard.issueId } as never,
      makeDispatchContext({ metadata }),
    );

    const diagnostics = (result as { data: { diagnostics: Record<string, unknown> } }).data.diagnostics;
    expect(diagnostics).toMatchObject({
      schemaVersion: 'scorecards-get-diagnostics-v1',
      handlerState: 'completed',
      omittedStages: 0,
      stages: [expect.objectContaining({
        stage: 'scorecards-get-evidence-read',
        outcome: 'fulfilled',
      })],
    });
    expect(diagnostics.correlationId).toMatch(/^[a-f0-9-]{36}$/i);
    expect(readContext).toMatchObject({
      stage: 'scorecards-get-evidence-read',
      boundary: 'await',
    });
    expect(JSON.stringify(diagnostics)).not.toContain(scorecard.issueId);
    expect(metadata).toHaveBeenLastCalledWith({ scorecardsGetDiagnostics: diagnostics });
    expect(resultContract.safeParse((result as { data: unknown }).data).success).toBe(true);
  });

  it('records a pending fixed-name stage and logs its correlation before it settles', async () => {
    vi.useFakeTimers();
    const stallLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const metadata = vi.fn();
    let resolveRead!: (value: Awaited<ReturnType<typeof readScorecardEvidence>>) => void;
    readScorecardEvidenceM.mockReturnValueOnce(new Promise((resolve) => { resolveRead = resolve; }));
    const pending = getTool.handler(
      { issueId: 'EI-private-card' } as never,
      makeDispatchContext({ metadata }),
    );

    try {
      await vi.advanceTimersByTimeAsync(STAGE_STALL_LOG_MS);
      const pendingMetadata = metadata.mock.lastCall?.[0]?.scorecardsGetDiagnostics;
      expect(pendingMetadata).toMatchObject({
        handlerState: 'running',
        stages: [expect.objectContaining({
          stage: 'scorecards-get-evidence-read',
          outcome: 'pending',
        })],
      });
      const line = String(stallLog.mock.calls[0]?.[0]);
      expect(line).toContain('STAGE STALL for scorecards:get');
      expect(line).toContain('scorecards-get-evidence-read correlation=');
      expect(line).not.toContain('EI-private-card');

      resolveRead({ kind: 'not_found' });
      await expect(pending).resolves.toMatchObject({
        data: { ok: false, error: "scorecard 'EI-private-card' not found", diagnostics: { handlerState: 'completed' } },
      });
    } finally {
      resolveRead({ kind: 'not_found' });
      stallLog.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps a complete criterion page inside the outer model-facing result door', async () => {
    const evidence = 'e'.repeat(6093);
    const card = {
      ...scorecard,
      criteria: [{ key: 'traceability', rating: 'pass', evidence }],
    };
    readScorecardEvidenceM.mockResolvedValue({ kind: 'found', scorecard: card });
    const scratchRoot = mkdtempSync(join(tmpdir(), 'scorecards-get-result-door-'));
    const previousScratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
    const previousDoorOff = process.env.PAPERCUSP_RESULT_DOOR_OFF;
    process.env.PAPERCUSP_SCRATCH_ROOT = join(scratchRoot, 'scratch');
    delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
    try {
      const response = (await getTool.handler(
        { issueId: card.issueId, criterionKey: 'traceability' } as never,
        makeDispatchContext(),
      )) as { data: unknown };
      const resultText = JSON.stringify(response.data);
      const budgetChars =
        computeTurnDoors(0, BAKED_DOOR_CONSTANTS).resultEach * CHARS_PER_TOKEN_ESTIMATE;
      const unpagedText = JSON.stringify({
        ok: true,
        scorecard: card,
        evidenceRead: { complete: true, scope: 'selected-criterion', offset: 0, totalChars: evidence.length },
      });
      expect(unpagedText.length).toBeGreaterThan(budgetChars);
      const unpaged = applyResultDoor(
        { content: [{ type: 'text' as const, text: unpagedText }], _meta: {} as Record<string, unknown> },
        { toolName: 'scorecards:get', workspaceId: 'scorecards-get-test' },
      );
      const unpagedDoor = (unpaged._meta.resultDoor as { truncated?: boolean } | undefined);
      expect(unpagedDoor?.truncated).toBe(true);
      expect(resultText.length).toBeLessThanOrEqual(budgetChars);

      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text: resultText }], _meta: {} as Record<string, unknown> },
        { toolName: 'scorecards:get', workspaceId: 'scorecards-get-test' },
      );
      const resultDoor = doored._meta.resultDoor as { truncated?: boolean } | undefined;
      expect(resultDoor?.truncated).not.toBe(true);
      const payload = JSON.parse((doored.content[0] as { text: string }).text) as {
        scorecard: { criteria: Array<{ evidence: string }> };
        evidenceRead: {
          complete: boolean;
          offset: number;
          totalChars: number;
          next?: { args: { evidenceOffset: number } };
        };
      };
      expect(payload.evidenceRead).toMatchObject({ complete: false, offset: 0, totalChars: evidence.length });
      expect(payload.scorecard.criteria[0]?.evidence).toBe(evidence.slice(0, payload.scorecard.criteria[0].evidence.length));
      expect(payload.scorecard.criteria[0]?.evidence.length).toBeLessThan(evidence.length);
      expect(payload.evidenceRead.next?.args.evidenceOffset).toBe(payload.scorecard.criteria[0]?.evidence.length);
    } finally {
      if (previousScratchRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
      else process.env.PAPERCUSP_SCRATCH_ROOT = previousScratchRoot;
      if (previousDoorOff === undefined) delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
      else process.env.PAPERCUSP_RESULT_DOOR_OFF = previousDoorOff;
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  it('keeps nested tools:invoke evidence paging truthful under default compact MCP materialization', async () => {
    const evidence = 'e'.repeat(4_331);
    const card = {
      ...scorecard,
      issueId: 'EI-nested-result-door',
      criteria: [{ key: 'fixture-calibration', rating: 'not-applicable', evidence }],
    };
    readScorecardEvidenceM.mockResolvedValue({ kind: 'found', scorecard: card });
    const projected = lookupByMcpName('scorecards:get');
    if (!projected) throw new Error('scorecards:get should be registered');

    const args = { issueId: card.issueId, criterionKey: 'fixture-calibration', evidenceOffset: 0 };
    // MCP defaults to compact, but this object-rooted scorecards payload is
    // intentionally materialized as JSON (there is no top-level array for the
    // compact selector). Exercise that implicit route rather than forcing JSON.
    const compactContext: UnifiedToolContext = {
      ...makeDispatchContext(),
      requestedFormat: undefined,
    };
    const dispatched = await dispatchProjectedTool(
      projected,
      'scorecards:get',
      args,
      compactContext,
      {},
    );
    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    if (!dispatched.result) throw new Error('scorecards:get dispatch should return an MCP result');

    const invokeTool = (await import('../tools/invoke')).default as unknown as {
      handler: (args: unknown, context: unknown) => Promise<{
        content: Array<{ type: 'text'; text: string }>;
        _meta?: Record<string, unknown>;
      }>;
    };
    const nested = dispatched.result as {
      content: Array<{ type: 'text'; text: string }>;
      _meta?: Record<string, unknown>;
    };
    expect(nested.content[0]?.text).not.toMatch(/^format: toon\n/);
    expect(() => JSON.parse(nested.content[0]!.text)).not.toThrow();
    const invoked = await invokeTool.handler(
      { name: 'scorecards:get', args },
      { dispatchTool: async () => nested },
    );
    doorConstantsMock.mockReturnValue({ ...BAKED_DOOR_CONSTANTS, maxTurnFloorTokens: 3_200 });
    const finalResult = applyResultDoor(invoked, {
      toolName: 'tools:invoke',
      nestedTargetToolName: 'scorecards:get',
      workspaceId: 'scorecards-get-test',
    });
    const door = finalResult._meta?.resultDoor as { truncated?: boolean } | undefined;
    expect(door?.truncated).toBe(true);

    const payload = JSON.parse(finalResult.content[0]!.text) as {
      scorecard: { criteria: Array<{ evidence: string }> };
      evidenceRead: {
        complete: boolean;
        offset: number;
        totalChars: number;
        next?: { args: { evidenceOffset: number } };
      };
    };
    const page = payload.scorecard.criteria[0]?.evidence ?? '';
    expect(payload.evidenceRead.offset).toBe(0);
    expect(payload.evidenceRead.totalChars).toBe(evidence.length);
    expect(payload.evidenceRead.complete).toBe(false);
    expect(page.length).toBeLessThan(evidence.length);
    expect(payload.evidenceRead.next?.args.evidenceOffset).toBe(page.length);
    if (payload.evidenceRead.complete) {
      expect(page).toBe(evidence);
      expect(payload.evidenceRead.next).toBeUndefined();
    } else {
      expect(page).toBe(evidence.slice(0, page.length));
      expect(page.length).toBeLessThan(evidence.length);
      expect(payload.evidenceRead.next?.args.evidenceOffset).toBe(page.length);
    }
  });

  it('keeps every exact evidence string recoverable through trimmed projected dispatch', async () => {
    readScorecardEvidenceM.mockResolvedValue({ kind: 'found', scorecard });
    const raw = (await getTool.handler(
      { issueId: scorecard.issueId } as never,
      { isSuperuser: true, uiClientId: 'su-scorecards-get-test', workspaceId: 'default' } as never,
    )) as { data: unknown };
    const rawChars = JSON.stringify(raw.data).length;
    const resultDoorChars =
      computeTurnDoors(0, BAKED_DOOR_CONSTANTS).resultEach * CHARS_PER_TOKEN_ESTIMATE;
    expect(rawChars).toBeLessThan(PAYLOAD_TIER_RATCHET_CHARS);
    expect(rawChars).toBeLessThanOrEqual(resultDoorChars);

    const projected = lookupByMcpName('scorecards:get');
    expect(projected).toBeDefined();
    expect(projected?.ignoreSessionPayloadTier).toBe(true);
    const dispatched = await dispatchProjectedTool(
      projected!,
      'scorecards:get',
      { issueId: scorecard.issueId },
      makeDispatchContext(),
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const payload = readJsonResult<{
      ok: boolean;
      scorecard: { criteria: Array<{ key: string }>; evidenceFingerprint: string };
      evidenceRead: {
        complete: boolean;
        criteria: Array<{ key: string; read: { args: Record<string, unknown> } }>;
      };
      _projection?: unknown;
    }>(dispatched.result!);
    if (!payload) throw new Error('scorecards:get dispatch should return JSON');
    expect(payload?._projection).toBeUndefined();
    expect(payload?.scorecard.criteria).toHaveLength(0);
    expect(payload?.scorecard.evidenceFingerprint).toBe('evidence-fingerprint-v2');
    expect(payload?.evidenceRead.complete).toBe(false);
    expect(payload?.evidenceRead.criteria.map(({ key }) => key)).toEqual(scorecard.criteria.map(({ key }) => key));
    for (const expected of scorecard.criteria) {
      const entry = payload.evidenceRead.criteria.find(({ key }) => key === expected.key)!;
      const page = await dispatchProjectedTool(
        projected!,
        'scorecards:get',
        entry.read.args,
        makeDispatchContext(),
        {},
      );
      expect(page.ok, JSON.stringify(page)).toBe(true);
      const recovered = readJsonResult<{
        scorecard: { criteria: Array<{ key: string; rating: string; evidence: string }> };
        evidenceRead: { complete: boolean };
      }>(page.result!);
      expect(recovered?.evidenceRead.complete).toBe(true);
      expect(recovered?.scorecard.criteria).toEqual([expected]);
    }
  });

  it('returns precise missing/not-scorecard errors without a wide history row', async () => {
    readScorecardEvidenceM.mockResolvedValueOnce({ kind: 'not_found' });
    await expect(getTool.handler({ issueId: 'EI-missing' } as never, makeDispatchContext())).resolves.toMatchObject({
      data: { ok: false, error: "scorecard 'EI-missing' not found" },
    });
    readScorecardEvidenceM.mockResolvedValueOnce({ kind: 'not_scorecard' });
    await expect(getTool.handler({ issueId: 'WI-not-card' } as never, makeDispatchContext())).resolves.toMatchObject({
      data: { ok: false, error: "'WI-not-card' is not a scorecard" },
    });
  });

  it('accepts generic id reads and prefers issueId when both identifiers are supplied', async () => {
    const aliasCard = { ...scorecard, issueId: 'EI-id-alias' };
    readScorecardEvidenceM.mockResolvedValueOnce({ kind: 'found', scorecard: aliasCard });
    const byAlias = await getTool.handler({ id: aliasCard.issueId } as never, makeDispatchContext());
    expect(readScorecardEvidenceM).toHaveBeenLastCalledWith(aliasCard.issueId);
    expect(byAlias).toMatchObject({ data: { ok: true, scorecard: { issueId: aliasCard.issueId } } });

    const preferredCard = { ...scorecard, issueId: 'EI-issue-id-preferred' };
    readScorecardEvidenceM.mockResolvedValueOnce({ kind: 'found', scorecard: preferredCard });
    const byPreferred = await getTool.handler(
      { issueId: preferredCard.issueId, id: 'EI-ignored-alias' } as never,
      makeDispatchContext(),
    );
    expect(readScorecardEvidenceM).toHaveBeenLastCalledWith(preferredCard.issueId);
    expect(byPreferred).toMatchObject({ data: { ok: true, scorecard: { issueId: preferredCard.issueId } } });

    const parsedAlias = scorecardGetArgs.safeParse({ id: aliasCard.issueId });
    expect(parsedAlias.success).toBe(true);
    expect(scorecardGetArgs.safeParse({}).success).toBe(false);
  });

  it('makes oversized cards explicitly incomplete and recovers every probe through bounded dispatch pages', async () => {
    const large = {
      ...scorecard,
      criteria: scorecard.criteria.map((criterion) => ({
        ...criterion,
        evidence: `${'"\\\n🙂'.repeat(4_000)} Re-run exact-probe ${criterion.key} with args={"frozen":true}`,
      })),
    };
    expect(JSON.stringify(large).length).toBeGreaterThan(PAYLOAD_TIER_HARD_CEILING_CHARS);
    readScorecardEvidenceM.mockResolvedValue({ kind: 'found', scorecard: large });
    const read = async (args: Record<string, unknown>) => {
      const dispatched = await dispatchProjectedTool(
        lookupByMcpName('scorecards:get')!, 'scorecards:get', args, makeDispatchContext(), {},
      );
      expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
      const payload = readJsonResult<{
        ok: boolean;
        scorecard: typeof scorecard;
        evidenceRead: {
          complete: boolean;
          criteria?: Array<{ key: string; read: { tool: string; args: Record<string, unknown> } }>;
          next?: { tool: string; args: Record<string, unknown> };
        };
        _projection?: unknown;
      }>(dispatched.result!)!;
      expect(payload._projection).toBeUndefined();
      expect(JSON.stringify(payload).length).toBeLessThan(PAYLOAD_TIER_HARD_CEILING_CHARS);
      return payload;
    };
    const index = await read({ issueId: large.issueId });
    expect(index.evidenceRead.complete).toBe(false);
    expect(index.scorecard.criteria).toEqual([]);
    expect(index.evidenceRead.criteria?.map((entry) => entry.key)).toEqual(large.criteria.map((entry) => entry.key));
    for (const entry of index.evidenceRead.criteria!) {
      let args: Record<string, unknown> | undefined = entry.read.args;
      let recovered = '';
      let pages = 0;
      while (args) {
        expect(++pages).toBeLessThan(30);
        const page = await read(args);
        expect(page.scorecard.criteria).toHaveLength(1);
        expect(page.scorecard.criteria[0].key).toBe(entry.key);
        recovered += page.scorecard.criteria[0].evidence;
        if (!page.evidenceRead.complete) expect(page.evidenceRead.next).toBeDefined();
        args = page.evidenceRead.next?.args;
      }
      expect(pages).toBeGreaterThan(1);
      expect(recovered).toBe(large.criteria.find((criterion) => criterion.key === entry.key)!.evidence);
      expect(recovered).toContain(`Re-run exact-probe ${entry.key}`);
    }
  });

  it('bounds parallel criterion reads and explains how to recover output-door envelopes', () => {
    const tool = lookupByMcpName('scorecards:get');
    const chaining = (tool as unknown as { guidance?: { chaining?: string } }).guidance?.chaining ?? '';
    expect(chaining).toContain('Promise.all');
    expect(chaining).toContain('small Promise.all groups');
    expect(chaining).toContain('papercusp.output-envelope/v1');
    expect(chaining).toContain('capability:read');
    expect(chaining).toContain('before reading scorecard.criteria');
    expect(chaining).toContain('pages sequentially');
    expect(chaining).toContain('Concatenate complete pages');
  });

  it('rejects unknown criterion keys and out-of-range offsets instead of returning empty evidence', async () => {
    readScorecardEvidenceM.mockResolvedValue({ kind: 'found', scorecard });
    await expect(getTool.handler(
      { issueId: scorecard.issueId, criterionKey: 'missing' } as never, makeDispatchContext(),
    )).resolves.toMatchObject({ data: { ok: false, error: 'unknown_criterion' } });
    await expect(getTool.handler(
      { issueId: scorecard.issueId, criterionKey: 'criterion-1', evidenceOffset: 999_999 } as never,
      makeDispatchContext(),
    )).resolves.toMatchObject({ data: { ok: false, error: 'invalid_evidence_offset' } });
  });

  it('pages an oversized criterion index while preserving grading-audit metadata', async () => {
    const gradingAudit = {
      state: 'pending' as const,
      metaRubricRef: 'grading-integrity',
      stampedAt: '2026-10-06T00:00:00.000Z',
      dispatchReservation: { key: 'reservation-key', reservedAt: '2026-10-06T00:00:00.000Z' },
    };
    const largeIndex = {
      ...scorecard,
      gradingAudit,
      criteria: Array.from({ length: 300 }, (_, i) => ({
        key: `criterion-${i}`, rating: 'pass', evidence: 'x'.repeat(200),
      })),
    };
    readScorecardEvidenceM.mockResolvedValue({ kind: 'found', scorecard: largeIndex });
    const read = async (args: Record<string, unknown>) => {
      const dispatched = await dispatchProjectedTool(
        lookupByMcpName('scorecards:get')!, 'scorecards:get', args, makeDispatchContext(), {},
      );
      expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
      return readJsonResult<{
        ok: boolean;
        scorecard: typeof largeIndex;
        evidenceRead: {
          complete: boolean;
          scope?: string;
          totalCriteria?: number;
          criteria?: Array<{ key: string; read: { args: Record<string, unknown> } }>;
          next?: { args: Record<string, unknown> };
        };
        _projection?: unknown;
      }>(dispatched.result!)!;
    };

    let args: Record<string, unknown> | undefined = { issueId: largeIndex.issueId };
    const indexedKeys: string[] = [];
    let pages = 0;
    while (args) {
      expect(++pages).toBeLessThan(30);
      const result = await read(args);
      expect(result.ok).toBe(true);
      expect(result._projection).toBeUndefined();
      expect(JSON.stringify(result).length).toBeLessThan(PAYLOAD_TIER_HARD_CEILING_CHARS);
      expect(result.scorecard.criteria).toEqual([]);
      expect(result.scorecard.gradingAudit).toEqual(gradingAudit);
      expect(result.scorecard.rerunRecipe).toEqual(rerunRecipe);
      expect(result.scorecard.auditTarget).toEqual(scorecard.auditTarget);
      expect(result.evidenceRead).toMatchObject({
        complete: false,
        scope: 'criterion-index',
        totalCriteria: largeIndex.criteria.length,
      });
      expect(result.evidenceRead.criteria?.length).toBeGreaterThan(0);
      indexedKeys.push(...result.evidenceRead.criteria!.map(({ key }) => key));
      args = result.evidenceRead.next?.args;
    }
    expect(pages).toBeGreaterThan(1);
    expect(indexedKeys).toEqual(largeIndex.criteria.map(({ key }) => key));

    const criterionPage = await read({ issueId: largeIndex.issueId, criterionKey: 'criterion-0' });
    expect(criterionPage.scorecard.rerunRecipe).toEqual(rerunRecipe);
  });

  it('preserves oversized scorecard metadata for the result door on index, criterion, and recipe reads', async () => {
    const largeMetadata = {
      ...scorecard,
      issueId: 'EI-large-scorecard-metadata',
      subject: { kind: 'scorecard' as const, ref: `subject:${'s'.repeat(18_000)}` },
      criteria: [{ key: 'criterion-1', rating: 'pass', evidence: 'exact evidence' }],
    };
    readScorecardEvidenceM.mockResolvedValue({ kind: 'found', scorecard: largeMetadata });
    readScorecardRecipeHeaderM.mockResolvedValue({
      kind: 'found', scorecard: recipeHeaderOf(largeMetadata) as never,
    });
    const smallDoors = { ...BAKED_DOOR_CONSTANTS, maxTurnFloorTokens: 3_200 };
    doorConstantsMock.mockReturnValue(smallDoors);
    const scratchRoot = mkdtempSync(join(tmpdir(), 'scorecards-get-large-metadata-'));
    const previousScratchRoot = process.env.PAPERCUSP_SCRATCH_ROOT;
    const previousDoorOff = process.env.PAPERCUSP_RESULT_DOOR_OFF;
    process.env.PAPERCUSP_SCRATCH_ROOT = join(scratchRoot, 'scratch');
    delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
    try {
      const index = await getTool.handler(
        { issueId: largeMetadata.issueId, indexOffset: 0 } as never,
        makeDispatchContext(),
      ) as { data: { ok: boolean; scorecard?: { issueId: string; subject?: { ref: string } }; evidenceRead?: { scope?: string } } };
      expect(index.data.ok).toBe(true);
      expect(index.data.scorecard?.issueId).toBe(largeMetadata.issueId);
      expect(index.data.scorecard?.subject?.ref).toBe(largeMetadata.subject.ref);
      expect(index.data.evidenceRead?.scope).toBe('criterion-index');

      const indexText = JSON.stringify(index.data);
      expect(indexText.length).toBeGreaterThan(
        computeTurnDoors(0, smallDoors).resultEach * CHARS_PER_TOKEN_ESTIMATE,
      );
      const doored = applyResultDoor(
        { content: [{ type: 'text' as const, text: indexText }], _meta: {} as Record<string, unknown> },
        { toolName: 'scorecards:get', workspaceId: 'scorecards-get-test' },
      );
      const resultDoor = doored._meta?.resultDoor as {
        truncated?: boolean;
        spillUri?: string | null;
        spillFailed?: boolean;
        recoveryCursor?: { tool?: string };
      } | undefined;
      expect(resultDoor?.truncated).toBe(true);
      expect(resultDoor?.spillUri).toBeTruthy();
      expect(resultDoor?.spillFailed).toBe(false);
      expect(resultDoor?.recoveryCursor?.tool).toBe('capability:read');

      let args: Record<string, unknown> | undefined = {
        issueId: largeMetadata.issueId,
        criterionKey: 'criterion-1',
      };
      let recovered = '';
      let pages = 0;
      while (args) {
        expect(++pages).toBeLessThan(30);
        const page = await getTool.handler(args as never, makeDispatchContext()) as {
          data: {
            ok: boolean;
            scorecard: { subject?: { ref: string }; criteria: Array<{ key: string; evidence: string }> };
            evidenceRead: { complete: boolean; next?: { args: Record<string, unknown> } };
          };
        };
        expect(page.data.ok).toBe(true);
        expect(page.data.scorecard.subject?.ref).toBe(largeMetadata.subject.ref);
        expect(page.data.scorecard.criteria[0]?.key).toBe('criterion-1');
        recovered += page.data.scorecard.criteria[0]?.evidence ?? '';
        args = page.data.evidenceRead.complete ? undefined : page.data.evidenceRead.next?.args;
      }
      expect(pages).toBeGreaterThan(1);
      expect(recovered).toBe(largeMetadata.criteria[0]?.evidence);

      const recipe = await getTool.handler(
        { issueId: largeMetadata.issueId, rerunRecipeOffset: 0 } as never,
        makeDispatchContext(),
      ) as { data: { ok: boolean; scorecard?: { subject?: { ref: string } }; rerunRecipeRead?: { chunk?: string } } };
      expect(recipe.data.ok).toBe(true);
      expect(recipe.data.scorecard?.subject?.ref).toBe(largeMetadata.subject.ref);
      expect(recipe.data.rerunRecipeRead?.chunk).toBeTruthy();
    } finally {
      if (previousScratchRoot === undefined) delete process.env.PAPERCUSP_SCRATCH_ROOT;
      else process.env.PAPERCUSP_SCRATCH_ROOT = previousScratchRoot;
      if (previousDoorOff === undefined) delete process.env.PAPERCUSP_RESULT_DOOR_OFF;
      else process.env.PAPERCUSP_RESULT_DOOR_OFF = previousDoorOff;
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  it('recovers an oversized replay recipe without hiding audit metadata or criterion evidence', async () => {
    const gradingAudit = {
      state: 'pending' as const,
      metaRubricRef: 'grading-integrity',
      stampedAt: '2026-10-09T00:00:00.000Z',
    };
    const large = {
      ...scorecard,
      gradingAudit,
      rerunRecipe: {
        ...rerunRecipe,
        selection: {
          ...rerunRecipe.selection,
          evidence: Array.from({ length: 90 }, (_, i) => ({
            evidenceKind: 'test', evidenceRef: `binding-${i}: ${'"\\\n🙂'.repeat(40)}`,
          })),
        },
      },
    };
    const encodedRecipe = JSON.stringify(large.rerunRecipe);
    expect(encodedRecipe.length).toBeGreaterThan(16_468);
    readScorecardEvidenceM.mockResolvedValue({ kind: 'found', scorecard: large });
    readScorecardRecipeHeaderM.mockResolvedValue({
      kind: 'found', scorecard: recipeHeaderOf(large) as never,
    });
    const invokeTool = (await import('../tools/invoke')).default;
    const read = async (args: Record<string, unknown>) => {
      const dispatched = await dispatchProjectedTool(
        lookupByMcpName('scorecards:get')!, 'scorecards:get', args, makeDispatchContext(), {},
      );
      expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
      const invoked = await invokeTool.handler(
        { name: 'scorecards:get', args } as never,
        { dispatchTool: async () => dispatched.result } as never,
      );
      const doored = applyResultDoor(invoked as {
        content: Array<{ type: 'text'; text: string }>;
        _meta?: Record<string, unknown>;
      }, {
        toolName: 'tools:invoke', nestedTargetToolName: 'scorecards:get', workspaceId: 'scorecards-get-test',
      });
      expect((doored._meta?.resultDoor as { truncated?: boolean } | undefined)?.truncated).not.toBe(true);
      const result = readJsonResult<{
        ok: boolean;
        scorecard: typeof scorecard & { gradingAudit: typeof gradingAudit };
        evidenceRead: { complete: boolean; scope?: string };
        rerunRecipeRead?: {
          complete: boolean; offset?: number; totalChars: number; chunk?: string;
          read?: { args: Record<string, unknown> }; next?: { args: Record<string, unknown> };
        };
        _projection?: unknown;
      }>(doored)!;
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(result._projection).toBeUndefined();
      expect(result.scorecard.issueId).toBe(large.issueId);
      expect(result.scorecard.subject).toEqual(large.subject);
      expect(result.scorecard.gradingAudit).toEqual(gradingAudit);
      expect(result.scorecard.evidenceFingerprint).toBe(large.evidenceFingerprint);
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(
        computeTurnDoors(0, BAKED_DOOR_CONSTANTS).resultEach * CHARS_PER_TOKEN_ESTIMATE - 256,
      );
      expect(resultContract.safeParse(result).success).toBe(true);
      return result;
    };
    for (const args of [
      { issueId: large.issueId },
      { issueId: large.issueId, indexOffset: 0 },
      { issueId: large.issueId, criterionKey: 'criterion-1' },
    ]) {
      const initial = await read(args);
      expect(initial.rerunRecipeRead).toMatchObject({ complete: false, totalChars: encodedRecipe.length });
      expect(initial.scorecard.rerunRecipe).toBeUndefined();
      if ('criterionKey' in args) expect(initial.scorecard.criteria).toEqual([large.criteria[0]]);
      let next = initial.rerunRecipeRead!.read!.args;
      let recovered = '';
      let pages = 0;
      while (next) {
        expect(++pages).toBeLessThan(150);
        const page = await read(next);
        expect(page.rerunRecipeRead?.offset).toBe(recovered.length);
        expect(page.rerunRecipeRead?.chunk?.length).toBeGreaterThan(0);
        recovered += page.rerunRecipeRead!.chunk;
        if (page.rerunRecipeRead!.complete) {
          expect(page.rerunRecipeRead!.next).toBeUndefined();
          break;
        }
        next = page.rerunRecipeRead!.next!.args;
      }
      expect(pages).toBeGreaterThan(1);
      expect(recovered).toBe(encodedRecipe);
      expect(JSON.parse(recovered)).toEqual(large.rerunRecipe);
    }
    const invalid = await getTool.handler(
      { issueId: large.issueId, rerunRecipeOffset: encodedRecipe.length + 1 } as never, makeDispatchContext(),
    );
    expect(invalid).toMatchObject({ data: { ok: false, error: 'invalid_rerun_recipe_offset' } });
    expect(scorecardGetArgs.safeParse({ issueId: large.issueId, rerunRecipeOffset: 0 }).success).toBe(true);
    expect(scorecardGetArgs.safeParse({
      issueId: large.issueId, rerunRecipeOffset: 0, criterionKey: 'criterion-1',
    }).success).toBe(false);
  });

  it('uses the header-only reader for recipe pages and preserves audit currentness', async () => {
    const gradingAudit = {
      state: 'pending' as const,
      metaRubricRef: 'grading-integrity',
      stampedAt: '2026-10-09T00:00:00.000Z',
    };
    const evidenceBindingCurrentness = {
      state: 'current' as const,
      reason: 'current' as const,
      citedBindingCount: 1,
      retractedBindingIds: [],
      unavailableBindingIds: [],
    };
    const subjectRubricCurrentness = {
      state: 'current' as const,
      reason: 'current' as const,
      recordedRevision: 2,
      currentRevision: 2,
      recordedCriteriaHash: 'subject-hash-v2',
      currentCriteriaHash: 'subject-hash-v2',
    };
    const recipeHeader = {
      ...recipeHeaderOf(scorecard),
      gradingAudit,
      evidenceBindingCurrentness,
      subjectRubricCurrentness,
      supersededBy: 'EI-newer-card',
      auditTarget: {
        ...scorecard.auditTarget,
        current: false,
        superseded: true,
        supersededBy: 'EI-newer-card',
        subjectRubricCurrentness,
        evidenceBindingCurrentness,
      },
    };
    readScorecardRecipeHeaderM.mockResolvedValueOnce({
      kind: 'found', scorecard: recipeHeader as never,
    });

    const response = await getTool.handler(
      { issueId: scorecard.issueId, rerunRecipeOffset: 0 } as never,
      makeDispatchContext(),
    ) as { data: Record<string, unknown> };

    expect(readScorecardRecipeHeaderM).toHaveBeenCalledWith(scorecard.issueId);
    expect(readScorecardEvidenceM).not.toHaveBeenCalled();
    expect(response.data).toMatchObject({
      ok: true,
      scorecard: {
        issueId: scorecard.issueId,
        gradingAudit,
        evidenceBindingCurrentness,
        subjectRubricCurrentness,
        supersededBy: 'EI-newer-card',
        auditTarget: { current: false, superseded: true, supersededBy: 'EI-newer-card' },
      },
      rerunRecipeRead: {
        complete: true,
        chunk: JSON.stringify(rerunRecipe),
      },
    });
    expect(response.data.scorecard).not.toHaveProperty('criteria');
    expect(response.data.scorecard).not.toHaveProperty('nKeys');
    expect(resultContract.safeParse(response.data).success).toBe(true);
  });

  it('preserves typed transient contention failures', async () => {
    readScorecardEvidenceM.mockRejectedValueOnce(new OrgTxnTimeoutError('55P03', new Error('lock timeout')));
    const orgTimeout = await getTool.handler({ issueId: 'EI-card' } as never, makeDispatchContext());
    expect(orgTimeout).toMatchObject({
      data: {
        ok: false,
        error: 'timeout',
        retryable: true,
        pgCode: '55P03',
        diagnostics: {
          handlerState: 'completed',
          stages: [expect.objectContaining({ stage: 'scorecards-get-evidence-read', outcome: 'rejected' })],
        },
      },
    });
    readScorecardEvidenceM.mockRejectedValueOnce(
      new DbCallDeadlineError('boundedPgReadTxn:acquire(admin)', 8000, 8000, 'org-admin'),
    );
    const dbDeadline = await getTool.handler({ issueId: 'EI-card' } as never, makeDispatchContext());
    expect(dbDeadline).toMatchObject({
      data: {
        ok: false,
        error: 'timeout',
        retryable: true,
        diagnostics: {
          handlerState: 'completed',
          stages: [expect.objectContaining({ stage: 'scorecards-get-evidence-read', outcome: 'rejected' })],
        },
      },
    });
  });

  it('retains phase diagnostics when an unexpected read rejection escapes', async () => {
    readScorecardEvidenceM.mockRejectedValueOnce(new Error('private query detail'));
    const metadata = vi.fn();
    await expect(getTool.handler(
      { issueId: 'EI-card' } as never,
      makeDispatchContext({ metadata }),
    )).rejects.toThrow('private query detail');

    const diagnostics = metadata.mock.lastCall?.[0]?.scorecardsGetDiagnostics;
    expect(diagnostics).toMatchObject({
      handlerState: 'failed',
      stages: [expect.objectContaining({ stage: 'scorecards-get-evidence-read', outcome: 'rejected' })],
    });
    expect(JSON.stringify(diagnostics)).not.toContain('private query detail');
  });
});
