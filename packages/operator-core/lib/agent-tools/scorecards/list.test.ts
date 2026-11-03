/**
 * scorecards:list — correctness payloads must survive the ambient trimmed tier.
 *
 * A scorecard's ratings map is the grading evidence, not a browseable row list.
 * If the generic tier shaper trims that nested map before the result door spills
 * it, a partial card can look complete and manufacture a false pass.
 */
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
import type { ScorecardRow } from '../../scorecards';

vi.mock('../../scorecards', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../scorecards')>();
  return {
    ...actual,
    listScorecardPage: vi.fn(async () => ({ rows: [] as ScorecardRow[], hasMore: false })),
  };
});

import { listScorecardPage } from '../../scorecards';

const listScorecardPageM = vi.mocked(listScorecardPage);
const listModule = await import('./list');
const listTool = listModule.default;
const { resolveScorecardListDetail, toRerunRecipeDigest, toScoresOnlyRow } = listModule;

const makeDispatchContext = (): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: 'default',
  runId: 'scorecards-list-completeness-test',
  isSuperuser: true,
  uiClientId: 'su-scorecards-list-test',
  role: 'su',
  gateBypass: { role: true, capability: true, quota: true },
  transport: 'mcp',
  requestedFormat: 'json',
  contextTier: 'trimmed',
  tx: {},
});

describe('scorecards:list correctness payload', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps every criterion through an ambient trimmed dispatch', async () => {
    const rerunRecipe = {
      schemaVersion: 1,
      evaluator: 'plans:evaluate-spec-test-adequacy',
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
    const ratings = Object.fromEntries(
      Array.from({ length: 7 }, (_, i) => [
        `criterion-${i + 1}`,
        { rating: i < 4 ? 'healthy' : 'degraded', evidence: `evidence-${i + 1} ${'e'.repeat(1200)}` },
      ]),
    );
    const scorecard = {
      issueId: 'EI-scorecard-test',
      createdAt: '2026-08-25T00:00:00.000Z',
      createdBy: 'su-test',
      rubricRef: 'acceptance-test-rubric',
      ratings,
      nKeys: 7,
      missingKeys: [],
      extraKeys: [],
      rubricResolved: true,
      rerunRecipe,
      synthesized: false,
      score10: 7.9,
      linkedItems: [],
    } as unknown as ScorecardRow;
    listScorecardPageM.mockResolvedValue({ rows: [scorecard], hasMore: true });

    // detail:'full' — this guard is about the EVIDENCE-bearing payload surviving the result door
    // untrimmed; the default browse read (no subjectRef) is the lean 'scores' mode (P-010).
    const raw = (await listTool.handler(
      { rubricRef: 'acceptance-test-rubric', detail: 'full' } as never,
      { isSuperuser: true, uiClientId: 'su-scorecards-list-test', workspaceId: 'default' } as never,
    )) as { data: unknown };
    expect(raw.data).toMatchObject({
      ok: true,
      count: 1,
      hasMore: true,
      truncatedByLimit: true,
      nextCursor: { createdAt: scorecard.createdAt, issueId: scorecard.issueId },
    });
    const rawChars = JSON.stringify(raw).length;
    expect(rawChars).toBeGreaterThan(PAYLOAD_TIER_RATCHET_CHARS);
    expect(rawChars).toBeLessThan(PAYLOAD_TIER_HARD_CEILING_CHARS);

    const projected = lookupByMcpName('scorecards:list');
    expect(projected).toBeDefined();
    expect(projected?.ignoreSessionPayloadTier).toBe(true);

    const dispatched = await dispatchProjectedTool(
      projected!,
      'scorecards:list',
      { rubricRef: 'acceptance-test-rubric', detail: 'full' },
      makeDispatchContext(),
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    const payload = readJsonResult<{
      ok: boolean;
      count: number;
      hasMore: boolean;
      truncatedByLimit: boolean;
      nextCursor: { createdAt: string; issueId: string } | null;
      scorecards: Array<{
        ratings: Record<string, unknown>;
        nKeys: number;
        missingKeys: string[];
        rerunRecipe?: unknown;
      }>;
      _projection?: unknown;
    }>(dispatched.result!);
    expect(payload?._projection).toBeUndefined();
    expect(payload?.count).toBe(1);
    expect(payload?.hasMore).toBe(true);
    expect(payload?.truncatedByLimit).toBe(true);
    expect(payload?.nextCursor).toEqual({ createdAt: scorecard.createdAt, issueId: scorecard.issueId });
    expect(payload?.scorecards[0]?.nKeys).toBe(7);
    expect(Object.keys(payload?.scorecards[0]?.ratings ?? {})).toHaveLength(7);
    expect(payload?.scorecards[0]?.missingKeys).toEqual([]);
    expect(payload?.scorecards[0]?.rerunRecipe).toEqual(rerunRecipe);
  });

  // WI-6554700010008923 (oversized-tool-results-reduction-2026-10-12#P-010): a browse read (no
  // subjectRef) defaults to 'scores'. It must keep EVERY criterion key and the completeness fields
  // (EI-21437537919383948) and drop only the evidence prose that made a limit:200 read ~7.7 MB.
  it("browse reads default to 'scores': every criterion key and rating kept, evidence dropped", async () => {
    const ratings = Object.fromEntries(
      Array.from({ length: 7 }, (_, i) => [
        `criterion-${i + 1}`,
        {
          rating: i < 4 ? 'healthy' : 'degraded',
          evidence: `evidence-${i + 1} ${'e'.repeat(1200)}`,
          evidenceRef: `ref-${i + 1}`,
          ...(i === 5 ? { remediation: 'WI-1 tracks this' } : {}),
        },
      ]),
    );
    const row = {
      issueId: 'EI-lean', createdAt: '2026-10-12T00:00:00.000Z', rubricRef: 'r', ratings,
      nKeys: 7, missingKeys: ['criterion-8'],
    } as unknown as ScorecardRow;
    listScorecardPageM.mockResolvedValueOnce({ rows: [row], hasMore: false });

    const lean = (await listTool.handler(
      { rubricRef: 'r' } as never,
      { isSuperuser: true, uiClientId: 'su-scorecards-list-test', workspaceId: 'default' } as never,
    )) as { data: { detail: string; evidenceOmitted?: string; scorecards: Array<Record<string, unknown>> } };
    expect(lean.data.detail).toBe('scores');
    expect(lean.data.evidenceOmitted).toContain("detail:'full'");
    const card = lean.data.scorecards[0] as { ratings: Record<string, Record<string, unknown>>; nKeys: number; missingKeys: string[] };
    expect(Object.keys(card.ratings)).toHaveLength(7);
    expect(card.nKeys).toBe(7);
    expect(card.missingKeys).toEqual(['criterion-8']);
    expect(card.ratings['criterion-1']).toEqual({ rating: 'healthy' });
    expect(card.ratings['criterion-6']).toEqual({ rating: 'degraded', remediation: 'WI-1 tracks this' });
    expect(JSON.stringify(lean.data).length).toBeLessThan(2_000);

    // A subjectRef read drills into one subject's card: full evidence by default.
    listScorecardPageM.mockResolvedValueOnce({ rows: [row], hasMore: false });
    const drilled = (await listTool.handler(
      { rubricRef: 'r', subjectRef: 'EI-subject' } as never,
      { isSuperuser: true, uiClientId: 'su-scorecards-list-test', workspaceId: 'default' } as never,
    )) as { data: { detail: string; evidenceOmitted?: string; scorecards: Array<{ ratings: Record<string, { evidence?: string }> }> } };
    expect(drilled.data.detail).toBe('full');
    expect(drilled.data.evidenceOmitted).toBeUndefined();
    expect(drilled.data.scorecards[0].ratings['criterion-1'].evidence).toContain('evidence-1');
  });

  it('resolveScorecardListDetail: explicit detail wins; otherwise subjectRef ⇒ full, browse ⇒ scores', () => {
    expect(resolveScorecardListDetail(undefined, undefined)).toBe('scores');
    expect(resolveScorecardListDetail(undefined, 'EI-1')).toBe('full');
    expect(resolveScorecardListDetail('full', undefined)).toBe('full');
    expect(resolveScorecardListDetail('scores', 'EI-1')).toBe('scores');
    expect(toScoresOnlyRow(null)).toBeNull();
    expect(toScoresOnlyRow({ issueId: 'x' })).toEqual({ issueId: 'x' });
  });

  // WI-6554700010009929: in 'scores' mode the rerun recipe was ~70% of each row. Browse keeps the
  // recipe IDENTITY and sizes every other field; the replay body returns with detail:'full'.
  it("'scores' digests rerunRecipe to its identity plus omittedChars; 'full' keeps the replay body", async () => {
    const rerunRecipe = {
      schemaVersion: 1,
      evaluator: 'plans:evaluate-spec-test-adequacy',
      evaluatorBuild: 'abc1234',
      classRef: 'plan-class-feature-ship',
      derivation: { kind: 'evaluator', note: 'd' },
      args: { slug: 'p', current: 'a'.repeat(2_400) },
      current: { files: 'c'.repeat(1_800) },
      selection: { keys: 's'.repeat(600) },
    };
    const row = {
      issueId: 'EI-recipe', createdAt: '2026-10-13T00:00:00.000Z', rubricRef: 'spec-test-adequacy',
      ratings: { 'criterion-1': { rating: 'pass', evidence: 'e'.repeat(500) } }, nKeys: 1, missingKeys: [],
      rerunRecipe,
    } as unknown as ScorecardRow;

    listScorecardPageM.mockResolvedValueOnce({ rows: [row], hasMore: false });
    const lean = (await listTool.handler(
      { rubricRef: 'spec-test-adequacy' } as never,
      { isSuperuser: true, uiClientId: 'su-scorecards-list-test', workspaceId: 'default' } as never,
    )) as { data: { evidenceOmitted?: string; scorecards: Array<{ rerunRecipe: Record<string, unknown> }> } };
    const digest = lean.data.scorecards[0].rerunRecipe;
    expect(digest).toEqual({
      schemaVersion: 1,
      evaluator: 'plans:evaluate-spec-test-adequacy',
      evaluatorBuild: 'abc1234',
      classRef: 'plan-class-feature-ship',
      derivation: { kind: 'evaluator', note: 'd' },
      omittedChars: {
        args: JSON.stringify(rerunRecipe.args).length,
        current: JSON.stringify(rerunRecipe.current).length,
        selection: JSON.stringify(rerunRecipe.selection).length,
      },
    });
    expect(lean.data.evidenceOmitted).toContain('rerunRecipe');
    expect(JSON.stringify(lean.data).length).toBeLessThan(1_200); // the ~5KB replay body is gone

    listScorecardPageM.mockResolvedValueOnce({ rows: [row], hasMore: false });
    const full = (await listTool.handler(
      { rubricRef: 'spec-test-adequacy', detail: 'full' } as never,
      { isSuperuser: true, uiClientId: 'su-scorecards-list-test', workspaceId: 'default' } as never,
    )) as { data: { scorecards: Array<{ rerunRecipe: unknown }> } };
    expect(full.data.scorecards[0].rerunRecipe).toEqual(rerunRecipe);

    // A recipe-less or non-object recipe passes through untouched.
    expect(toRerunRecipeDigest(undefined)).toBeUndefined();
    expect(toRerunRecipeDigest('opaque')).toBe('opaque');
    expect(toRerunRecipeDigest({ schemaVersion: 1 })).toEqual({ schemaVersion: 1 });
  });

  it('accepts the returned keyset cursor and passes it to the scorecard page reader', async () => {
    const cursor = { createdAt: '2026-08-24T00:00:00.000Z', issueId: 'EI-scorecard-previous-page' };
    listScorecardPageM.mockResolvedValueOnce({ rows: [], hasMore: false });

    const result = (await listTool.handler(
      { rubricRef: 'acceptance-test-rubric', cursor } as never,
      { isSuperuser: true, uiClientId: 'su-scorecards-list-test', workspaceId: 'default' } as never,
    )) as { data: Record<string, unknown> };

    expect(listScorecardPageM).toHaveBeenCalledWith(
      expect.objectContaining({ rubricRef: 'acceptance-test-rubric', before: cursor, includeLinks: true }),
    );
    expect(result.data).toMatchObject({ ok: true, hasMore: false, nextCursor: null });
  });

  it('forwards provisional:true as the provisionalOnly page filter (WI-6554700010009935)', async () => {
    const ctx = { isSuperuser: true, uiClientId: 'su-scorecards-list-test', workspaceId: 'default' } as never;
    listScorecardPageM.mockResolvedValueOnce({ rows: [], hasMore: false });
    await listTool.handler(
      listTool.args.parse({ rubricRef: 'grading-integrity', subjectRef: 'EI-terminal', provisional: true }) as never,
      ctx,
    );
    expect(listScorecardPageM).toHaveBeenLastCalledWith(
      expect.objectContaining({ rubricRef: 'grading-integrity', subjectRef: 'EI-terminal', provisionalOnly: true }),
    );

    listScorecardPageM.mockResolvedValueOnce({ rows: [], hasMore: false });
    await listTool.handler(listTool.args.parse({ rubricRef: 'grading-integrity' }) as never, ctx);
    expect(listScorecardPageM.mock.lastCall?.[0]?.provisionalOnly).toBeUndefined();
    expect(listTool.args.safeParse({ provisional: 'yes' }).success).toBe(false);
  });

  it('returns a typed retryable envelope when the bounded read exhausts contention retries', async () => {
    listScorecardPageM.mockRejectedValueOnce(new OrgTxnTimeoutError('55P03', new Error('lock timeout')));

    const result = (await listTool.handler(
      { subjectRef: 'EI-subject' } as never,
      { isSuperuser: true, uiClientId: 'su-scorecards-list-test', workspaceId: 'default' } as never,
    )) as { data: Record<string, unknown> };

    expect(result.data).toMatchObject({
      ok: false,
      error: 'timeout',
      retryable: true,
      pgCode: '55P03',
    });
    expect(result.data.message).toContain('retry shortly');
  });

  it('returns a typed retryable envelope when acquisition misses its deadline', async () => {
    listScorecardPageM.mockRejectedValueOnce(
      new DbCallDeadlineError('boundedPgReadTxn:acquire(admin)', 8000, 8000, 'org-admin'),
    );

    const result = (await listTool.handler(
      { subjectRef: 'EI-subject' } as never,
      { isSuperuser: true, uiClientId: 'su-scorecards-list-test', workspaceId: 'default' } as never,
    )) as { data: Record<string, unknown> };

    expect(result.data).toMatchObject({
      ok: false,
      error: 'timeout',
      retryable: true,
    });
    expect(result.data.pgCode).toBeUndefined();
    expect(result.data.message).toContain('retry shortly');
  });

  it('accepts a harness compatibility hint without filtering the workspace-wide read', async () => {
    listScorecardPageM.mockResolvedValueOnce({ rows: [], hasMore: false });

    const projected = lookupByMcpName('scorecards:list');
    expect(projected).toBeDefined();
    const dispatched = await dispatchProjectedTool(
      projected!,
      'scorecards:list',
      { rubricRef: 'acceptance-test-rubric', harness: 'papercusp' },
      makeDispatchContext(),
      {},
    );

    expect(dispatched.ok, JSON.stringify(dispatched)).toBe(true);
    expect(readJsonResult(dispatched.result!)).toMatchObject({
      ok: true,
      count: 0,
      hasMore: false,
      truncatedByLimit: false,
      nextCursor: null,
      scorecards: [],
    });
    expect(listScorecardPageM).toHaveBeenCalledWith({
      rubricRef: 'acceptance-test-rubric',
      includeLinks: true,
      finalizedOnly: true,
    });
  });

  it('documents the scalar subjectRef list filter separately from emit\'s structured subject', () => {
    const projected = lookupByMcpName('scorecards:list');
    expect(projected).toBeDefined();
    expect(projected?.description).toContain('subjectRef');
    expect(projected?.description).toContain('scorecards:emit');
    expect(projected?.description).toContain('composite `spec-set:<classRef>:<specSetHash>:<planKey>`');
    expect(projected?.description).toContain('not a plan or pot slug');
    expect(projected?.guidance?.when).toContain('subjectRef');
    expect(projected?.guidance?.when).toContain('subject:{kind,ref}');
    expect(projected?.guidance?.when).toContain('exact composite `spec-set:<classRef>:<specSetHash>:<planKey>` subject ref');
    expect(projected?.guidance?.chaining).toContain('subjectRef: "EI-123"');

    const subjectRefDescription = (
      listTool as unknown as { args: { shape: { subjectRef: { description?: string } } } }
    ).args.shape.subjectRef.description;
    expect(subjectRefDescription).toContain('composite `spec-set:<classRef>:<specSetHash>:<planKey>`');
    expect(subjectRefDescription).toContain('not the plan or pot slug');
  });
});
