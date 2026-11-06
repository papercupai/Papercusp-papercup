/**
 * completion_stats.test.ts — the work_items:completion_stats TOOL (getCompletionIntegrityStats
 * itself has its own PG-backed integration coverage in work-items.integration.test.ts, describe
 * 'WI-1405 — genuine-completions metric'). This pins the tool wiring: it passes `harness`
 * through and returns the stats spread under `{ ok: true, ... }`.
 *
 * In-tree (operator-core, tab-visible).
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/work_items/completion_stats.test.ts
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../work-items', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../work-items')>(),
  getCompletionIntegrityStats: vi.fn(),
}));

import { getCompletionIntegrityStats } from '../../work-items';
const mockStats = vi.mocked(getCompletionIntegrityStats);
const tool = (await import('./completion_stats')).default;

function callTool(args: Record<string, unknown>) {
  // The handler returns the { data } shape (tool-data-shape ratchet P-003), not { content }
  // — the old annotation described a wire shape this tool never returns, so every `res.data`
  // assertion below was a type error the suite carried silently.
  return (
    tool as unknown as { handler: (a: unknown, c?: unknown) => Promise<{ data: Record<string, unknown> }> }
  ).handler(args, {});
}

describe('work_items:completion_stats tool', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes `harness` through to getCompletionIntegrityStats and returns { ok, ...stats }', async () => {
    mockStats.mockResolvedValue({
      harness: 'papercusp',
      population: { kind: 'harness', harness: 'papercusp', window: 'all-time', fleetAttribution: 'none' },
      authorityRecordedCompletions: 6,
      independentlyVerifiedNewChanges: null,
      terminalTotal: 10,
      genuineCompletions: 6,
      dedupOrUnverified: 4,
      gateJudged: 2,
      declaredWorkOutcomes: { introducedChange: 1, verifiedExisting: 2, duplicate: 1, invalidOrExpected: 0, otherNoNewChange: 0, unknown: 6 },
    });
    const res = await callTool({ harness: 'papercusp' });
    expect(mockStats).toHaveBeenCalledWith('papercusp');
    expect(res.data).toEqual({
      ok: true,
      harness: 'papercusp',
      population: { kind: 'harness', harness: 'papercusp', window: 'all-time', fleetAttribution: 'none' },
      authorityRecordedCompletions: 6,
      independentlyVerifiedNewChanges: null,
      terminalTotal: 10,
      genuineCompletions: 6,
      dedupOrUnverified: 4,
      gateJudged: 2,
      declaredWorkOutcomes: { introducedChange: 1, verifiedExisting: 2, duplicate: 1, invalidOrExpected: 0, otherNoNewChange: 0, unknown: 6 },
    });
  });

  // P-013: gateJudged must reach the caller — it is the coverage half of the metric, and a
  // tool that computed it but dropped it on the wire would report the same blind spot the
  // metric exists to expose.
  it('passes gateJudged through (the P-013 coverage half)', async () => {
    mockStats.mockResolvedValue({
      harness: 'papercusp',
      population: { kind: 'harness', harness: 'papercusp', window: 'all-time', fleetAttribution: 'none' },
      authorityRecordedCompletions: 100,
      independentlyVerifiedNewChanges: null,
      terminalTotal: 100,
      genuineCompletions: 100,
      dedupOrUnverified: 0,
      gateJudged: 38,
      declaredWorkOutcomes: { introducedChange: 20, verifiedExisting: 30, duplicate: 10, invalidOrExpected: 5, otherNoNewChange: 5, unknown: 30 },
    });
    const res = await callTool({ harness: 'papercusp' });
    // Fully-evidenced yet only 38% judged — the exact shape that makes coverage a DISTINCT
    // signal from genuineCompletions rather than a restatement of it.
    expect(res.data.genuineCompletions).toBe(100);
    expect(res.data.gateJudged).toBe(38);
    expect(res.data.declaredWorkOutcomes).toMatchObject({ introducedChange: 20, unknown: 30 });
  });
});
