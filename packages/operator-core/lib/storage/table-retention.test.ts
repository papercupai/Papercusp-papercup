import { describe, expect, it } from 'vitest';
import { retentionDaysForTable, tableRetentionTargets, TABLE_RETENTION_TARGETS } from './table-retention';

describe('durable-headroom table retention policy', () => {
  it('keeps routing, tool and telemetry tables for 30 days', () => {
    for (const table of ['route-invocations', 'tool-invocations', 'agent-activity', 'harness-run-output']) {
      expect(retentionDaysForTable(table), table).toBe(30);
    }
    expect(retentionDaysForTable('memory-recall-query-text')).toBe(3);
    expect(retentionDaysForTable('code-intel-research-trails')).toBe(7);
  });

  it('projects the same policy shape consumed by the existing scheduled janitor', () => {
    expect(tableRetentionTargets()).toEqual(TABLE_RETENTION_TARGETS.map(({ category, retentionDays }) => ({
      category, retention_days: retentionDays,
    })));
    expect(tableRetentionTargets()).toHaveLength(6);
  });

  it('does not assign a retention horizon to the lossless session archive', () => {
    expect(retentionDaysForTable('session-archive-files')).toBeNull();
  });
});
