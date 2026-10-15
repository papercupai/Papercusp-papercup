import { describe, expect, it } from 'vitest';
import { assessPgTableGrowth, type PgTableSizeSample } from './pg-table-growth';

const sample = (id: string, at: string, tables: PgTableSizeSample['tables']): PgTableSizeSample => ({
  schemaVersion: 1, id, complete: true, workspaceId: 'ws', host: 'h', measuredAt: at,
  schema: 'harness_shared', database: { name: 'db', oid: '1', server: 'local', port: '5432', schemaOid: '2' },
  tableCount: tables.length, tables,
});

describe('Postgres table growth measurement', () => {
  it('computes complete 24h growth and identifies largest/fastest tables', () => {
    const before = sample('00000000-0000-4000-8000-000000000001', '2026-10-14T00:00:00Z', [
      { oid: '1', name: 'tool_invocations', totalBytes: 100, rows: 1 },
      { oid: '2', name: 'session_turns', totalBytes: 50, rows: 1 },
    ]);
    const after = sample('00000000-0000-4000-8000-000000000002', '2026-10-15T00:00:00Z', [
      { oid: '1', name: 'tool_invocations', totalBytes: 125, rows: 2 },
      { oid: '2', name: 'session_turns', totalBytes: 60, rows: 2 },
    ]);
    const result = assessPgTableGrowth(after, before, {
      workspaceId: 'ws', host: 'h', windowStart: '2026-10-14T00:00:00Z', windowEnd: '2026-10-15T01:00:00Z',
    }, { tool_invocations: 'telemetry retention', session_turns: 'session retention' });
    expect(result.verdict).toBe('pass');
    expect(result.tables.map(t => t.growthBytes)).toEqual([25, 10]);
    expect(result.topGrowers).toEqual(['tool_invocations', 'session_turns']);
    expect(result.unresolved).toEqual([]);
  });

  it('returns unknown for missing history, recreated tables, and unowned growth', () => {
    const before = sample('00000000-0000-4000-8000-000000000003', '2026-10-14T00:00:00Z', [
      { oid: '1', name: 'old_table', totalBytes: 100, rows: 1 },
    ]);
    const after = sample('00000000-0000-4000-8000-000000000004', '2026-10-15T00:00:00Z', [
      { oid: '9', name: 'old_table', totalBytes: 125, rows: 1 },
      { oid: '3', name: 'new_table', totalBytes: 80, rows: 1 },
    ]);
    const result = assessPgTableGrowth(after, before, {
      workspaceId: 'ws', host: 'h', windowStart: '2026-10-14T00:00:00Z', windowEnd: '2026-10-15T01:00:00Z',
    }, {});
    expect(result.verdict).toBe('unknown');
    expect(result.measurementVerdict).toBe('unknown');
    expect(result.unresolved).toEqual(['new_table', 'old_table']);
    expect(assessPgTableGrowth(after, null, {
      workspaceId: 'ws', host: 'h', windowStart: '2026-10-14T00:00:00Z', windowEnd: '2026-10-15T01:00:00Z',
    }).verdict).toBe('unknown');
  });

  it('rejects a cross-database or stale comparison instead of inventing growth', () => {
    const before = sample('00000000-0000-4000-8000-000000000005', '2026-10-10T00:00:00Z', [{ oid: '1', name: 'x', totalBytes: 1, rows: 1 }]);
    const after = sample('00000000-0000-4000-8000-000000000006', '2026-10-15T00:00:00Z', [{ oid: '1', name: 'x', totalBytes: 2, rows: 1 }]);
    expect(assessPgTableGrowth(after, before, { workspaceId: 'ws', host: 'h', windowStart: '2026-10-10T00:00:00Z', windowEnd: '2026-10-15T01:00:00Z' }).verdict).toBe('unknown');
  });
});
