/**
 * freshness.test.ts — scorecards:freshness subjectPlan resolution (EI-22084134815763318).
 *
 * scorecards:freshness previously required a caller to already know the generated rubricRef;
 * callers repeatedly guessed `subjectPlan` (the plan slug they actually know) here too,
 * mirroring rubrics:list's own subjectPlan filter (the sibling fix, EI-22084090899431625), and
 * got a hard schema rejection ("Unrecognized subjectPlan; rubricRef required"). subjectPlan now
 * resolves to the plan's single ACTIVE acceptance rubric via listRubrics() — reusing the same
 * resolver the sibling fix already exposes rather than duplicating the filter logic. This pins
 * the resolution contract: exactly one candidate resolves silently, zero/many is a clear
 * ok:false (never a guess), and rubricRef/subjectPlan stay mutually exclusive at the schema.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/scorecards/freshness.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchProjectedTool, lookupByMcpName, readJsonResult, type UnifiedToolContext } from '@papercusp/agent-mcp';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'me' }) }));
// Partial mock, NOT a full replacement: `../../rubrics` is a large module whose other
// exports (getRubric, autoRatifyRubricOnFirstScorecard, ...) are consumed transitively
// through the unmocked overwatch/scorecard-backstop.ts -> harness/improvements/capture-core.ts
// chain that COORDINATION_RUBRIC_REF pulls in below. Spreading `real` keeps every other
// export intact (as the sibling emit.*.test.ts files in this dir already do) so only
// `listRubrics` is actually stubbed.
vi.mock('../../rubrics', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../rubrics')>();
  return { ...real, listRubrics: vi.fn() };
});
vi.mock('../../scorecard-freshness', () => ({
  checkScorecardFreshness: vi.fn(),
  interpretOverwatchEmission: vi.fn(),
}));
vi.mock('../../overwatch/snapshot', () => ({ getOverwatchLiveness: vi.fn() }));

import { listRubrics } from '../../rubrics';
import { checkScorecardFreshness } from '../../scorecard-freshness';
import { mockResolvedTyped } from '../../testing/typed-mock';

const listRubricsM = vi.mocked(listRubrics);
const checkScorecardFreshnessM = vi.mocked(checkScorecardFreshness);

const freshnessTool = (await import('./freshness')).default;

const runTool = async (args: unknown) => {
  const out = (await freshnessTool.handler(args as never, {} as never)) as {
    data: { ok: boolean; error?: string; resolvedFromSubjectPlan?: unknown };
  };
  return out.data;
};

const rubric = (rubricId: string) => ({
  rubricId,
  workspaceId: 'default',
  kind: 'acceptance' as const,
  gradingAuthority: 'independent' as const,
  subjectPlan: 'irrelevant-for-this-mock',
  characteristic: 'plan-acceptance',
  title: rubricId,
  description: '',
  criteria: [],
  ratingScale: ['pass', 'fail', 'unknown'],
  methodRef: null,
  status: 'active' as const,
  createdBy: null,
  proposedBy: null,
  ratifiedBy: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});

const FRESHNESS_STUB = {
  rubricRef: 'stub',
  since: '2026-01-01T00:00:00Z',
  status: 'fresh' as const,
  rubricKnown: true,
  emitted: true,
  complete: true,
  count: 1,
  partialCount: 0,
  lastEmittedAt: '2026-01-01T00:00:00Z',
  lastCompleteAt: '2026-01-01T00:00:00Z',
  latestMissingKeys: [] as string[],
  latestExtraKeys: [] as string[],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockResolvedTyped(checkScorecardFreshnessM, FRESHNESS_STUB);
});

describe('scorecards:freshness — args schema (rubricRef / subjectPlan mutual exclusivity)', () => {
  it('refuses when neither rubricRef nor subjectPlan is given', async () => {
    await expect(freshnessTool.args.parseAsync({})).rejects.toThrow(/rubricRef or subjectPlan/i);
  });

  it('refuses when BOTH rubricRef and subjectPlan are given', async () => {
    await expect(freshnessTool.args.parseAsync({ rubricRef: 'r', subjectPlan: 'p' })).rejects.toThrow(
      /mutually exclusive/i,
    );
  });

  it('accepts rubricRef alone', async () => {
    await expect(freshnessTool.args.parseAsync({ rubricRef: 'r' })).resolves.toBeTruthy();
  });

  it('accepts subjectPlan alone', async () => {
    await expect(freshnessTool.args.parseAsync({ subjectPlan: 'p' })).resolves.toBeTruthy();
  });
});

describe('scorecards:freshness — subjectPlan resolution (EI-22084134815763318)', () => {
  it('passes through unknown-rubric as a non-actionable freshness result', async () => {
    mockResolvedTyped(checkScorecardFreshnessM, {
      ...FRESHNESS_STUB,
      status: 'unknown-rubric',
      rubricKnown: false,
      emitted: false,
      complete: false,
      count: 0,
      lastEmittedAt: null,
      lastCompleteAt: null,
    });
    const body = await runTool({ rubricRef: 'missing-rubric' });
    expect(body).toMatchObject({
      ok: true,
      freshness: {
        status: 'unknown-rubric',
        rubricKnown: false,
        emitted: false,
        complete: false,
      },
    });
  });

  it('resolves subjectPlan to the single ACTIVE acceptance rubric and threads it to checkScorecardFreshness', async () => {
    mockResolvedTyped(listRubricsM, [rubric('my-plan-2026-09-01-acceptance')]);
    const body = await runTool({ subjectPlan: 'my-plan-2026-09-01' });
    expect(listRubricsM).toHaveBeenCalledWith({
      subjectPlan: 'my-plan-2026-09-01',
      kind: 'acceptance',
      status: 'active',
    });
    expect(checkScorecardFreshnessM).toHaveBeenCalledWith(
      expect.objectContaining({ rubricRef: 'my-plan-2026-09-01-acceptance' }),
    );
    expect(body).toMatchObject({
      ok: true,
      resolvedFromSubjectPlan: {
        subjectPlan: 'my-plan-2026-09-01',
        rubricRef: 'my-plan-2026-09-01-acceptance',
      },
    });
  });

  it('a subjectPlan with NO active acceptance rubric returns a clear ok:false, never a guess', async () => {
    listRubricsM.mockResolvedValue([]);
    const body = await runTool({ subjectPlan: 'no-such-plan' });
    expect(checkScorecardFreshnessM).not.toHaveBeenCalled();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/no ACTIVE acceptance rubric/i);
    expect(body.error).toContain('no-such-plan');
  });

  it('a subjectPlan resolving to MULTIPLE active rubrics is ambiguous, never a silent pick', async () => {
    mockResolvedTyped(listRubricsM, [rubric('acceptance-a'), rubric('acceptance-b')]);
    const body = await runTool({ subjectPlan: 'ambiguous-plan' });
    expect(checkScorecardFreshnessM).not.toHaveBeenCalled();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/ambiguous/i);
    expect(body.error).toContain('acceptance-a');
    expect(body.error).toContain('acceptance-b');
  });

  it('rubricRef passed directly never calls listRubrics (no unnecessary resolution)', async () => {
    const body = await runTool({ rubricRef: 'direct-ref' });
    expect(listRubricsM).not.toHaveBeenCalled();
    expect(checkScorecardFreshnessM).toHaveBeenCalledWith(expect.objectContaining({ rubricRef: 'direct-ref' }));
    expect(body).toMatchObject({ ok: true });
    expect(body.resolvedFromSubjectPlan).toBeUndefined();
  });
});

const context = (role: string): UnifiedToolContext => ({
  log: vi.fn(),
  signal: new AbortController().signal,
  progress: vi.fn(),
  emit: vi.fn(),
  workspaceId: 'default',
  runId: 'freshness-judge-access-test',
  role,
  transport: 'mcp',
  requestedFormat: 'json',
});

describe('scorecards:freshness independent grading access', () => {
  beforeEach(() => vi.clearAllMocks());

  it('allows a judge through real dispatch and preserves the complete freshness verdict', async () => {
    const freshness = {
      rubricRef: 'memory-recall-health',
      since: '2026-10-09T00:00:00Z',
      status: 'fresh' as const,
      rubricKnown: true,
      emitted: true,
      complete: true,
      count: 1,
      partialCount: 0,
      lastEmittedAt: '2026-10-09T01:00:00Z',
      lastCompleteAt: '2026-10-09T01:00:00Z',
      latestMissingKeys: [],
      latestExtraKeys: [],
    };
    vi.mocked(checkScorecardFreshness).mockResolvedValue(freshness);
    const target = lookupByMcpName('scorecards:freshness')!;
    expect(target.effect).toBe('read');
    const result = await dispatchProjectedTool(target, 'scorecards:freshness', {
      rubricRef: 'memory-recall-health', since: freshness.since,
    }, context('judge'), {});
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(readJsonResult(result.result!)).toMatchObject({ ok: true, freshness });
    expect(checkScorecardFreshness).toHaveBeenCalledWith(expect.objectContaining({
      rubricRef: 'memory-recall-health', since: freshness.since,
    }));
  });

  it('still refuses an unlisted role before calling the freshness reader', async () => {
    const result = await dispatchProjectedTool(lookupByMcpName('scorecards:freshness')!,
      'scorecards:freshness', { rubricRef: 'memory-recall-health' }, context('unlisted-role'), {});
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('role_not_allowed');
    expect(checkScorecardFreshness).not.toHaveBeenCalled();
  });
});
