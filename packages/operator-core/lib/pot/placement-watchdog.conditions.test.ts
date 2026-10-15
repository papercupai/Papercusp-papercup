import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { readRealPgRailBlocks } from '@papercusp/test-config/silenced-console-census';
vi.mock('../pot-control-policy', () => ({ placementOverride: () => undefined }));
import { reconcileOnePot, placementConditionKey, placementConfig, type PlacementConditionDeps } from './placement-watchdog';

const NOW = 1_900_000_000_000;
function fixture() {
  const key = placementConditionKey('workspace', 'pot', 'harness', 'WI-1', 'cursed');
  const open = new Map([[key, NOW - 1]]);
  let rows: Array<{ status: string; holder_live: boolean; downstream: number; payload?: unknown }> =
    [{ status: 'done', holder_live: false, downstream: 1 }];
  let failed = false;
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const sql = (async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.join(''); queries.push({ text, values });
    if (text.includes('SELECT f.status, f.payload')) {
      if (failed) throw new Error('subject query unavailable');
      return rows;
    }
    return []; // No historical Mug or candidate: only durable exact recovery can run.
  }) as unknown as Sql;
  const resolve = vi.fn(async ({ conditionKey }: { conditionKey: string }) => open.delete(conditionKey));
  const deps: PlacementConditionDeps = { rail: { resolve }, readOpenConditions: async () =>
    [...open].map(([conditionKey, openedAtMs]) => ({ conditionKey, openedAtMs })) };
  return { key, open, sql, queries, resolve, deps, rows: (value: typeof rows) => { rows = value; },
    fail: () => { failed = true; },
    run: (workspace = 'workspace', pot = 'pot', now = NOW) =>
      reconcileOnePot(sql, workspace, pot, placementConfig(), now, () => false, deps) };
}

describe('placement durable condition recovery', () => {
  beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { expect(readRealPgRailBlocks().blocked).toBe(0); vi.restoreAllMocks(); });
  it('recovers an exact terminal subject after restart without its old Mug or cup', async () => {
    const h = fixture(); await h.run();
    expect(h.open.size).toBe(0); expect(h.resolve).toHaveBeenCalledTimes(1);
    const read = h.queries.find(query => query.text.includes('SELECT f.status, f.payload'))!;
    expect(read.text).toContain('f.workspace_id ='); expect(read.text).toContain('f.harness_slug =');
    expect(read.text).toContain('f.feature_id =');
    expect(read.values).toContain('workspace'); expect(read.values).toContain('harness');
    expect(read.values).toContain('WI-1');
  });

  it.each(['missing', 'duplicate', 'failed-query', 'failed-ledger', 'foreign-workspace', 'foreign-pot',
    'future-episode', 'unknown-clock', 'invalid-key', 'unknown-kind', 'unknown-harness', 'parked',
    'claim-parked', 'unknown-holder', 'unknown-status', 'unknown-ledger', 'unknown-now', 'quiet-subject'])('preserves %s evidence', async kind => {
    const h = fixture();
    if (kind === 'missing') h.rows([]);
    if (kind === 'duplicate') h.rows([{ status: 'done', holder_live: false, downstream: 0 },
      { status: 'done', holder_live: false, downstream: 0 }]);
    if (kind === 'failed-query') h.fail();
    if (kind === 'failed-ledger') h.deps.readOpenConditions = async () => { throw new Error('rail unreadable'); };
    if (kind === 'unknown-ledger') h.deps.readOpenConditions = async () => undefined as never;
    if (kind === 'future-episode') h.open.set(h.key, NOW + 1);
    if (kind === 'unknown-clock') h.open.set(h.key, Number.NaN);
    if (kind === 'invalid-key' || kind === 'unknown-kind' || kind === 'unknown-harness') {
      h.open.clear(); h.open.set(kind === 'invalid-key' ? 'alarm:pot-placement:%bad' :
        placementConditionKey('workspace', 'pot', kind === 'unknown-harness' ? null : 'harness', 'WI-1',
          kind === 'unknown-kind' ? 'invalid' as 'cursed' : 'cursed'), NOW - 1);
    }
    if (kind === 'parked') h.rows([{ status: 'blocked', holder_live: true, downstream: 1 }]);
    if (kind === 'claim-parked') h.rows([{ status: 'open', holder_live: true, downstream: 1,
      payload: { _claimHold: true } }]);
    if (kind === 'unknown-holder') h.rows([{ status: 'open', holder_live: 'true' as unknown as boolean, downstream: 1 }]);
    if (kind === 'unknown-status') h.rows([{ status: 'unknown', holder_live: true, downstream: 1 }]);
    if (kind === 'quiet-subject') h.rows([{ status: 'open', holder_live: false, downstream: 1 }]);
    await h.run(kind === 'foreign-workspace' ? 'other' : 'workspace', kind === 'foreign-pot' ? 'other' : 'pot',
      kind === 'unknown-now' ? Number.NaN : NOW);
    expect(h.open.size).toBe(1); expect(h.resolve).not.toHaveBeenCalled();
    if (kind === 'failed-query' || kind === 'invalid-key') expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('condition recovery failed'));
    else expect(console.warn).not.toHaveBeenCalled();
  });

  it('a live holder clears attempts while a stuck blocker remains until its downstream is measured clear', async () => {
    const h = fixture();
    const stranded = placementConditionKey('workspace', 'pot', 'harness', 'WI-1', 'stranded');
    h.open.set(stranded, NOW - 1); h.rows([{ status: 'failing', holder_live: true, downstream: 1 }]);
    await h.run(); expect([...h.open.keys()]).toEqual([stranded]);
    for (const count of [Number.NaN, -1, 0.5, '0' as unknown as number]) {
      h.rows([{ status: 'failing', holder_live: true, downstream: count }]); await h.run();
      expect(h.open.has(stranded)).toBe(true);
    }
    h.rows([{ status: 'failing', holder_live: false, downstream: 0 }]); await h.run(); expect(h.open.size).toBe(0);
  });

  it('failed keyed resolution retains the episode and retries on the next measured reading', async () => {
    const h = fixture(); h.resolve.mockRejectedValueOnce(new Error('resolve unavailable'));
    await h.run(); expect(h.open.size).toBe(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('resolve unavailable'));
    await h.run(); expect(h.open.size).toBe(0);
  });

  it('a blocker returning to a recognized working state clears its stuck episode without completing downstream', async () => {
    const h = fixture(); h.open.clear();
    const key = placementConditionKey('workspace', 'pot', 'harness', 'WI-1', 'stranded');
    h.open.set(key, NOW - 1); h.rows([{ status: 'wip', holder_live: false, downstream: 1 }]);
    await h.run(); expect(h.open.size).toBe(0);
  });
});
