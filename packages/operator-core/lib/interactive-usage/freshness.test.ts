import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import {
  evaluateInteractiveUsageFreshness,
  INTERACTIVE_USAGE_INGEST_LAG_THRESHOLD_MS,
  INTERACTIVE_USAGE_FRESHNESS_WINDOW_MS,
  isInteractiveUsageUnmeasuredReason,
  readInteractiveUsageFreshness,
} from './freshness';

const NOW = 1_800_000_000_000;

describe('interactive usage freshness', () => {
  it('uses ingested_at and accepts the recent-window boundary', () => {
    expect(evaluateInteractiveUsageFreshness(NOW - INTERACTIVE_USAGE_FRESHNESS_WINDOW_MS, NOW)).toMatchObject({
      status: 'fresh', ageMs: INTERACTIVE_USAGE_FRESHNESS_WINDOW_MS,
    });
  });

  it('marks samples older than the shared window stale', () => {
    expect(evaluateInteractiveUsageFreshness(NOW - INTERACTIVE_USAGE_FRESHNESS_WINDOW_MS - 1, NOW)).toMatchObject({
      status: 'stale', ageMs: INTERACTIVE_USAGE_FRESHNESS_WINDOW_MS + 1,
    });
  });

  it('treats absent or invalid freshness data as unavailable', () => {
    expect(evaluateInteractiveUsageFreshness(null, NOW)).toMatchObject({ status: 'unavailable', lastIngestedAtMs: null });
    expect(evaluateInteractiveUsageFreshness('bad', NOW)).toMatchObject({ status: 'unavailable' });
    expect(isInteractiveUsageUnmeasuredReason('interactive-usage-stale')).toBe(true);
    expect(isInteractiveUsageUnmeasuredReason('interactive-usage-unavailable')).toBe(true);
    expect(isInteractiveUsageUnmeasuredReason('no-lineage-samples')).toBe(false);
  });

  it('reads the workspace interactive ingested_at watermark, not event ts', async () => {
    const query = vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => [
      { latest_ingested_at: String(NOW - 1_000) },
    ]);
    const result = await readInteractiveUsageFreshness(query as unknown as Sql, { workspaceId: 'ws-1', nowMs: NOW });
    const queryText = query.mock.calls[0]?.[0].join(' ') ?? '';
    expect(queryText).toContain('MAX(ingested_at)');
    expect(queryText).toContain("source = 'interactive'");
    expect(queryText).not.toContain('MAX(ts)');
    expect(result).toMatchObject({ status: 'fresh', lastIngestedAtMs: NOW - 1_000 });
  });

  it('scopes the interactive watermark to the requested goal', async () => {
    const query = vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => [
      {
        latest_ingested_at: String(NOW - 31 * 60_000),
        max_recent_ingest_lag_ms: String(20 * 60_000),
      },
    ]);
    const result = await readInteractiveUsageFreshness(query as unknown as Sql, {
      workspaceId: 'ws-1', goalId: 'goal-1', nowMs: NOW,
    });
    const queryText = query.mock.calls[0]?.[0].join(' ') ?? '';
    expect(queryText).toContain('goal_id =');
    expect(queryText).toContain('ingested_at - COALESCE(ts, ingested_at)');
    expect(query.mock.calls[0]?.slice(1)).toContain('goal-1');
    expect(result).toMatchObject({
      status: 'stale',
      lastIngestedAtMs: NOW - 31 * 60_000,
      maxRecentIngestLagMs: 20 * 60_000,
    });
  });

  it('marks a fresh receipt watermark stale when event-to-receipt lag exceeds 15 minutes', () => {
    const justOverThreshold = evaluateInteractiveUsageFreshness(
      NOW - 1_000,
      NOW,
      INTERACTIVE_USAGE_FRESHNESS_WINDOW_MS,
      INTERACTIVE_USAGE_INGEST_LAG_THRESHOLD_MS + 1,
    );
    expect(justOverThreshold).toMatchObject({
      status: 'stale',
      maxRecentIngestLagMs: INTERACTIVE_USAGE_INGEST_LAG_THRESHOLD_MS + 1,
      lagThresholdMs: INTERACTIVE_USAGE_INGEST_LAG_THRESHOLD_MS,
      lagWindowMs: INTERACTIVE_USAGE_FRESHNESS_WINDOW_MS,
    });
    expect(justOverThreshold.reason).toContain('maximum recent interactive usage ingest lag');

    expect(evaluateInteractiveUsageFreshness(
      NOW - 1_000,
      NOW,
      INTERACTIVE_USAGE_FRESHNESS_WINDOW_MS,
      INTERACTIVE_USAGE_INGEST_LAG_THRESHOLD_MS,
    ).status).toBe('fresh');
  });

  it('returns unavailable when the freshness read fails', async () => {
    const query = vi.fn(async () => { throw new Error('db unavailable'); });
    await expect(readInteractiveUsageFreshness(query as unknown as Sql, { workspaceId: 'ws-1', nowMs: NOW }))
      .resolves.toMatchObject({ status: 'unavailable', reason: expect.stringContaining('db unavailable') });
  });

});
