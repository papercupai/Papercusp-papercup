/**
 * federation-refused-op-counter (F1-4 / P-012, federated-scout-gym) — hermetic
 * tests for the per-source refused-op counter: the bump interpolates the right
 * partition, normalizes an empty source, skips an un-attributable bump, and is
 * FAIL-SOFT (a PG error never propagates to the op-apply loop).
 */
import { describe, expect, it, vi } from 'vitest';
import type { OrgSql } from '../../work-items';
import {
  bumpFederationRefusedOp,
  listFederationRefusedOpCounters,
} from './federation-refused-op-counter';

/** Tagged-template sql fake capturing interpolated values per call. */
function fakeSql(rowsToReturn: unknown[] = []): { sql: OrgSql; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const fn = (_s: TemplateStringsArray, ...vals: unknown[]) => {
    calls.push(vals);
    return Promise.resolve(rowsToReturn);
  };
  return { sql: fn as unknown as OrgSql, calls };
}

describe('bumpFederationRefusedOp', () => {
  it('interpolates the (ws, harness, source, tag, reason) partition', async () => {
    const { sql, calls } = fakeSql();
    await bumpFederationRefusedOp(
      {
        workspaceId: 'papercusp-workspace',
        harnessSlug: 'papercusp',
        sourceHive: 'source-log-key-abc',
        tableTag: 'gym-qd-elites-by-niche',
        reason: 'not-federatable',
      },
      sql,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      'papercusp-workspace',
      'papercusp',
      'source-log-key-abc',
      'gym-qd-elites-by-niche',
      'not-federatable',
    ]);
  });

  it('normalizes an empty/absent source to a stable unknown-remote bucket', async () => {
    const { sql, calls } = fakeSql();
    await bumpFederationRefusedOp(
      { workspaceId: 'ws', harnessSlug: 'h', sourceHive: '', tableTag: 'agent-facts-by-key', reason: 'malformed' },
      sql,
    );
    expect(calls[0]?.[2]).toBe('unknown-remote');
    const { sql: sql2, calls: calls2 } = fakeSql();
    await bumpFederationRefusedOp(
      { workspaceId: 'ws', harnessSlug: 'h', sourceHive: null, tableTag: 'agent-facts-by-key', reason: 'malformed' },
      sql2,
    );
    expect(calls2[0]?.[2]).toBe('unknown-remote');
  });

  it('skips an un-attributable bump (empty ws / harness / tag) with no write', async () => {
    const base = { sourceHive: 's', reason: 'malformed' as const };
    for (const partial of [
      { workspaceId: '', harnessSlug: 'h', tableTag: 't' },
      { workspaceId: 'ws', harnessSlug: '', tableTag: 't' },
      { workspaceId: 'ws', harnessSlug: 'h', tableTag: '' },
    ]) {
      const { sql, calls } = fakeSql();
      await bumpFederationRefusedOp({ ...base, ...partial }, sql);
      expect(calls).toHaveLength(0);
    }
  });

  it('is FAIL-SOFT — a PG error never propagates (observability is not load-bearing)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const throwingSql = ((_s: TemplateStringsArray, ..._v: unknown[]) =>
        Promise.reject(new Error('pg down'))) as unknown as OrgSql;
      const recover = vi.fn(async () => {});
      await expect(
        bumpFederationRefusedOp(
          { workspaceId: 'ws', harnessSlug: 'h', sourceHive: 's', tableTag: 't', reason: 'malformed' },
          throwingSql,
          recover,
        ),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledOnce();
      expect(recover).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('listFederationRefusedOpCounters', () => {
  it('maps rows to typed counters (count coerced to number)', async () => {
    const { sql } = fakeSql([
      { source_hive: 'peer-a', table_tag: 'gym-qd-elites-by-niche', reason: 'not-federatable', count: '5' },
      { source_hive: 'peer-b', table_tag: 'agent-facts-by-key', reason: 'malformed', count: 2 },
    ]);
    const out = await listFederationRefusedOpCounters({ workspaceId: 'ws', harnessSlug: 'h' }, sql);
    expect(out).toEqual([
      { sourceHive: 'peer-a', tableTag: 'gym-qd-elites-by-niche', reason: 'not-federatable', count: 5 },
      { sourceHive: 'peer-b', tableTag: 'agent-facts-by-key', reason: 'malformed', count: 2 },
    ]);
  });

  it('returns [] for an empty ws / harness (nothing to read)', async () => {
    const { sql, calls } = fakeSql([{ source_hive: 'x', table_tag: 't', reason: 'r', count: 1 }]);
    expect(await listFederationRefusedOpCounters({ workspaceId: '', harnessSlug: 'h' }, sql)).toEqual([]);
    expect(await listFederationRefusedOpCounters({ workspaceId: 'ws', harnessSlug: '' }, sql)).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
