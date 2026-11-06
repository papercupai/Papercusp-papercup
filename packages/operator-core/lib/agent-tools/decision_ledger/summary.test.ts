import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import summaryTool from './summary';
import { summarizeDecisionLedger } from '../../decision-ledger/read';
import { getCompletionIntegrityStats } from '../../work-items';
import { activeWorkspaceId } from '../../workspace-registry';
import { resolveAgentIdentity } from '../coordination/identity';

// PG-free unit: the roll-up math has its own suite; this pins the TOOL — the
// workspace precedence, the optional layer + sinceHours→sinceMs spread, and the
// { workspaceId, summary } envelope (B-13 / P-113).
vi.mock('../../decision-ledger/read', () => ({ readDecisionLedger: vi.fn(), summarizeDecisionLedger: vi.fn() }));
vi.mock('../../work-items', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../work-items')>(),
  getCompletionIntegrityStats: vi.fn(),
}));
vi.mock('../../workspace-registry', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../workspace-registry')>(),
  activeWorkspaceId: vi.fn(() => 'ws-active'),
  resolveConcreteWorkspaceId: vi.fn((...candidates: Array<string | null | undefined>) =>
    candidates.find((candidate) => typeof candidate === 'string' && candidate.trim() && candidate.trim() !== '*')?.trim() ?? 'ws-active',
  ),
}));
vi.mock('../coordination/identity', async (importOriginal) => ({
  ...await importOriginal<typeof import('../coordination/identity')>(),
  resolveAgentIdentity: vi.fn(),
}));

const mockSummarize = vi.mocked(summarizeDecisionLedger);
const mockCompletionStats = vi.mocked(getCompletionIntegrityStats);
const mockActiveWs = vi.mocked(activeWorkspaceId);
const mockIdentity = vi.mocked(resolveAgentIdentity);

const NOW = 1_700_000_000_000;
const SUMMARY = { total: 7, byPosture: { auto: 3, gated: 4 } };

function callTool(args: Record<string, unknown>, ctx: Record<string, unknown> = {}) {
  return (
    summaryTool as unknown as {
      handler: (a: unknown, c: unknown) => Promise<{ content: Array<{ text: string }> }>;
    }
  ).handler(args, ctx);
}

describe('decision_ledger:summary tool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    mockIdentity.mockReturnValue({ ownerId: 'su-test' } as ReturnType<typeof resolveAgentIdentity>);
    mockActiveWs.mockReturnValue('ws-active');
    mockSummarize.mockResolvedValue(SUMMARY as unknown as Awaited<ReturnType<typeof summarizeDecisionLedger>>);
    mockCompletionStats.mockResolvedValue({
      harness: 'papercusp',
      population: { kind: 'harness', harness: 'papercusp', window: 'all-time', fleetAttribution: 'none' },
      authorityRecordedCompletions: 6,
      independentlyVerifiedNewChanges: null,
      terminalTotal: 9,
      genuineCompletions: 6,
      dedupOrUnverified: 3,
      gateJudged: 2,
      declaredWorkOutcomes: { introducedChange: 1, verifiedExisting: 1, duplicate: 0, invalidOrExpected: 0, otherNoNewChange: 0, unknown: 7 },
    });
  });
  afterEach(() => vi.useRealTimers());

  it('summarizes the active workspace with no filters by default', async () => {
    await callTool({});
    expect(mockSummarize).toHaveBeenCalledWith('ws-active', {});
  });

  it('passes layer + the sinceHours→sinceMs window and honors workspace precedence', async () => {
    await callTool({ layer: 'action', sinceHours: 48 }, { workspaceId: 'ws-ctx' });
    expect(mockSummarize).toHaveBeenCalledWith('ws-ctx', { layer: 'action', sinceMs: NOW - 48 * 3_600_000 });
  });

  it('returns { workspaceId, summary }', async () => {
    const res = await callTool({ workspace: 'ws-x' });
    expect(JSON.parse(res.content[0].text)).toEqual({ workspaceId: 'ws-x', summary: SUMMARY });
  });

  it('includes completionStats when `harness` is provided', async () => {
    const res = await callTool({ workspace: 'ws-x', harness: 'papercusp' });
    expect(mockCompletionStats).toHaveBeenCalledWith('papercusp');
    expect(JSON.parse(res.content[0].text)).toEqual({
      workspaceId: 'ws-x',
      summary: SUMMARY,
      completionStats: {
        harness: 'papercusp',
        population: { kind: 'harness', harness: 'papercusp', window: 'all-time', fleetAttribution: 'none' },
        authorityRecordedCompletions: 6,
        independentlyVerifiedNewChanges: null,
        terminalTotal: 9,
        genuineCompletions: 6,
        dedupOrUnverified: 3,
        gateJudged: 2,
        declaredWorkOutcomes: { introducedChange: 1, verifiedExisting: 1, duplicate: 0, invalidOrExpected: 0, otherNoNewChange: 0, unknown: 7 },
      },
    });
  });
});
