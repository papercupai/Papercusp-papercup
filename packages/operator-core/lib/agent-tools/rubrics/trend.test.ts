import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listAllProjectedTools } from '@papercusp/agent-mcp';
import { schemaToText } from '../../cupboard/tools-discovery';

vi.mock('../coordination/identity', () => ({ resolveAgentIdentity: () => ({ ownerId: 'me' }) }));
vi.mock('../../scorecards', () => ({ scorecardTrend: vi.fn() }));

import { scorecardTrend } from '../../scorecards';
import trendTool from './trend';

beforeEach(() => vi.clearAllMocks());

describe('rubrics:trend public reference contract', () => {
  it('publishes rubricRef as required in the discovery schema', () => {
    const projected = listAllProjectedTools().find((tool) => tool.expose.mcp?.name === 'rubrics:trend');
    expect(projected).toBeDefined();
    const schema = projected!.discoveryInputSchema ?? projected!.inputSchema;
    expect((schema as { required?: string[] }).required ?? []).toContain('rubricRef');
    expect(schemaToText(schema)).toContain('rubricRef:string');
    expect(schemaToText(schema)).not.toContain('rubricRef?:');
  });

  it.each([undefined, ''])('rejects a missing or empty reference %s before aggregation', (rubricRef) => {
    const parsed = trendTool.args.safeParse({
      ...(rubricRef === undefined ? {} : { rubricRef }),
      sourceHive: 'papercusp',
      limit: 12,
      observationMaxAgeSec: 86400,
      includeDefinition: false,
    });
    expect(parsed.success).toBe(false);
    expect(scorecardTrend).not.toHaveBeenCalled();
  });
});

describe('rubrics:trend observation age contract', () => {
  it('forwards the validated explicit horizon and returns the age verdict', async () => {
    const result = {
      rubricRef: 'test-rubric', scorecardCount: 0,
      sample: { limit: 500, inputCount: 0, examinedCount: 0, hasMore: false, excludedCounts: {} }, window: {}, criteria: [],
      unknownBreakdown: { total: 0, graderIncomplete: 0, instrumentUnavailable: 0, byReason: {} },
      supersededExcluded: 0, preContractResetExcluded: 0, provisionalExcluded: 0, gradingAuditPendingExcluded: 0,
      staleness: { stale: false, staleCriteria: [], judgedCriteria: 0, assessed: false, reason: 'empty' },
      observationAge: {
        status: 'unknown' as const, horizonSec: 3600, asOf: '2026-10-05T12:00:00.000Z', reason: 'empty',
        coverage: { population: 'retained-scorecards' as const, total: 0, timed: 0, missing: 0, invalid: 0, future: 0 },
      },
    };
    vi.mocked(scorecardTrend).mockResolvedValue(result);
    const args = trendTool.args.parse({ rubricRef: 'test-rubric', observationMaxAgeSec: 3600 });
    const response = await trendTool.handler(args, {} as never);
    expect(scorecardTrend).toHaveBeenCalledWith(expect.objectContaining({
      rubricRef: 'test-rubric', observationMaxAgeSec: 3600,
    }));
    const content = (response as { content: Array<{ text: string }> }).content;
    expect(JSON.parse(content[0].text).trend.observationAge).toEqual(result.observationAge);
  });

  it('leaves the horizon optional for existing callers', () => {
    expect(trendTool.args.parse({ rubricRef: 'test-rubric' })).not.toHaveProperty('observationMaxAgeSec');
  });

  it.each([0, -1, NaN, Infinity])('rejects invalid public horizons %s', (horizon) => {
    expect(trendTool.args.safeParse({ rubricRef: 'test-rubric', observationMaxAgeSec: horizon }).success).toBe(false);
  });
});
