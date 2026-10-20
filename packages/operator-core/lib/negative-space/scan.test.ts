import { describe, expect, it, vi } from 'vitest';
import { runNegativeSpaceTick, DEFAULT_WINDOW_DAYS, type NegativeSpaceTickDeps } from './scan';
import type { DemandEntry, ZeroHitRow } from './miner-core';
import type { CaptureImprovementResult } from '../harness/improvements/capture-core';

const zeroHit = (query: string, agent: string, invokedAt = '2026-06-11T10:00:00.000Z'): ZeroHitRow => ({
  toolName: 'docs:search',
  query,
  agent,
  invokedAt,
});

const createdResult = (id: string): CaptureImprovementResult => ({
  ok: true,
  created: true,
  issue: { id } as CaptureImprovementResult['issue'],
  possibleDuplicates: [],
});

// P-002 (silent-intake, D-001): the decline is retired; the surviving
// created:false path is the burst coalesce — same not-filed shape.
const declinedResult: CaptureImprovementResult = {
  ok: true,
  created: false,
  reason: 'coalesced',
  possibleDuplicates: [{ id: 'EI-9', title: 't', state: 'open', severity: 'minor', similarity: 0.8 }],
};

function makeDeps(rows: ZeroHitRow[], over: Partial<NegativeSpaceTickDeps> = {}) {
  const readRows = vi.fn<NegativeSpaceTickDeps['readRows']>(async () => rows);
  const persist = vi.fn<NegativeSpaceTickDeps['persist']>(async (_ws, entries) => entries);
  const capture = vi.fn<NegativeSpaceTickDeps['capture']>(async () => createdResult('EI-100'));
  const markFiled = vi.fn<NegativeSpaceTickDeps['markFiled']>(async () => {});
  const deps: NegativeSpaceTickDeps = { readRows, persist, capture, markFiled, log: () => {}, ...over };
  return { deps, readRows, persist, capture, markFiled };
}

describe('runNegativeSpaceTick', () => {
  it('reads the window, persists the aggregated map, files candidates over the bars, stamps filed ids', async () => {
    const rows = [
      zeroHit('hot query', 'a'),
      zeroHit('hot query', 'b'),
      zeroHit('hot query', 'a'),
      zeroHit('lonely query', 'a'),
    ];
    const { deps, readRows, persist, capture, markFiled } = makeDeps(rows);
    const result = await runNegativeSpaceTick('ws-1', deps, { minMisses: 3, minAgents: 2, maxPerTick: 2 });

    expect(readRows).toHaveBeenCalledWith('ws-1', DEFAULT_WINDOW_DAYS);
    expect(persist).toHaveBeenCalledOnce();
    const persisted = persist.mock.calls[0]![1];
    expect(persisted.map((e) => e.queryNorm).sort()).toEqual(['hot query', 'lonely query']);

    // Only "hot query" crosses both bars (3 misses, 2 agents). Prose query =
    // the judgment-shaped missing-knowledge change (the P-044 gate lane).
    expect(capture).toHaveBeenCalledOnce();
    const input = capture.mock.calls[0]![0];
    expect(input.kind).toBe('change');
    expect(input.findingClass).toBe('negative-space:missing-knowledge');
    expect(input.severity).toBe('minor');
    expect(input.watchdogKey).toBe('negative-space:docs:hot query');
    expect(input.dedupScope).toBe('open');
    expect(input.evidenceAt).toBe('2026-06-11T10:00:00.000Z');
    expect(input.sourceRole).toBe('system');

    expect(markFiled).toHaveBeenCalledWith('ws-1', expect.objectContaining({ queryNorm: 'hot query' }), 'EI-100');
    expect(result).toEqual({ scanned: 4, demandEntries: 2, filed: ['EI-100'], declined: 0 });
  });

  it('honors the per-tick cap and the windowDays option', async () => {
    const rows = ['q-one', 'q-two', 'q-three'].flatMap((q) => [zeroHit(q, 'a'), zeroHit(q, 'b'), zeroHit(q, 'c')]);
    const { deps, readRows, capture } = makeDeps(rows);
    const result = await runNegativeSpaceTick('ws-1', deps, { windowDays: 7, maxPerTick: 1 });
    expect(readRows).toHaveBeenCalledWith('ws-1', 7);
    expect(capture).toHaveBeenCalledOnce();
    expect(result.filed).toHaveLength(1);
  });

  it('a candidate already filed on the persisted map never re-files', async () => {
    const rows = [zeroHit('hot query', 'a'), zeroHit('hot query', 'b'), zeroHit('hot query', 'c')];
    const { deps, capture } = makeDeps(rows, {
      // persist merges a prior filed id back in (the PG leg's carry-forward).
      persist: async (_ws, entries) => entries.map((e) => ({ ...e, candidateImprovementId: 'EI-7' })),
    });
    const result = await runNegativeSpaceTick('ws-1', deps);
    expect(capture).not.toHaveBeenCalled();
    expect(result.filed).toEqual([]);
  });

  it('a capture-core decline counts as declined and never stamps', async () => {
    const rows = [zeroHit('hot query', 'a'), zeroHit('hot query', 'b'), zeroHit('hot query', 'c')];
    const { deps, markFiled } = makeDeps(rows, { capture: async () => declinedResult });
    const result = await runNegativeSpaceTick('ws-1', deps);
    expect(result.declined).toBe(1);
    expect(result.filed).toEqual([]);
    expect(markFiled).not.toHaveBeenCalled();
  });

  it('a capture throw is best-effort — the tick completes and reports it declined', async () => {
    const rows = [zeroHit('hot query', 'a'), zeroHit('hot query', 'b'), zeroHit('hot query', 'c')];
    const { deps } = makeDeps(rows, {
      capture: async () => {
        throw new Error('pg down');
      },
    });
    const result = await runNegativeSpaceTick('ws-1', deps);
    expect(result.declined).toBe(1);
    expect(result.demandEntries).toBe(1);
  });

  it('mine-only mode (maxPerTick 0) persists the map and files nothing', async () => {
    const rows = [zeroHit('hot query', 'a'), zeroHit('hot query', 'b'), zeroHit('hot query', 'c')];
    const { deps, persist, capture } = makeDeps(rows);
    const result = await runNegativeSpaceTick('ws-1', deps, { maxPerTick: 0 });
    expect(persist).toHaveBeenCalledOnce();
    expect(capture).not.toHaveBeenCalled();
    expect(result).toMatchObject({ demandEntries: 1, filed: [] });
  });

  it('does not admit memory:search rows as negative-space demand', async () => {
    const rows: ZeroHitRow[] = ['a', 'b', 'c'].map((agent) => ({
      toolName: 'memory:search',
      query: 'unresolved/identifier-2026',
      agent,
      invokedAt: '2026-06-11T10:00:00.000Z',
    }));
    const probeArtifact = vi.fn(async () => 'plan:should-not-be-probed');
    const { deps, persist, capture } = makeDeps(rows, { probeArtifact });

    const result = await runNegativeSpaceTick('ws-1', deps);

    expect(persist.mock.calls[0]![1]).toEqual([]);
    expect(probeArtifact).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(result).toEqual({ scanned: 3, demandEntries: 0, filed: [], declined: 0 });
  });
});

describe('runNegativeSpaceTick — kind fidelity at the filing edge (frontier P-044 / FB-18)', () => {
  const SLUG = 'local-hive-orchestration-2026-06-06';
  const slugRows = (agents: string[]): ZeroHitRow[] =>
    agents.map((agent) => ({ toolName: 'plans:search', query: SLUG, agent, invokedAt: '2026-06-11T10:00:00.000Z' }));

  it('an exact slug that EXISTS files the bug-shaped resolution gap (the EI-397 shape)', async () => {
    const probeArtifact = vi.fn(async () => `plan:${SLUG}`);
    const { deps, capture } = makeDeps(slugRows(['a', 'b', 'c']), { probeArtifact });
    await runNegativeSpaceTick('ws-1', deps);

    expect(probeArtifact).toHaveBeenCalledWith('plans', SLUG);
    expect(capture).toHaveBeenCalledOnce();
    const input = capture.mock.calls[0]![0];
    expect(input.kind).toBe('bug');
    expect(input.findingClass).toBe('negative-space:resolution-gap');
    expect(input.severity).toBe('major');
    expect(input.title).toBe(`Resolution gap: plans searches for "${SLUG}" zero-hit although it exists`);
    expect(input.body).toContain('Correct state');
    expect(input.body).toContain(`plan:${SLUG}`);
    // The signal identity is the same regardless of shape — classification
    // must never fork the cross-tick dedup key.
    expect(input.watchdogKey).toBe(`negative-space:plans:${SLUG}`);
  });

  it('an exact slug that does NOT exist stays the judgment-shaped missing-knowledge change', async () => {
    const { deps, capture } = makeDeps(slugRows(['a', 'b', 'c']), { probeArtifact: async () => null });
    await runNegativeSpaceTick('ws-1', deps);
    const input = capture.mock.calls[0]![0];
    expect(input.kind).toBe('change');
    expect(input.findingClass).toBe('negative-space:missing-knowledge');
    expect(input.severity).toBe('minor');
  });

  it('prose queries are never probed (only reference-shaped identifiers can be resolution gaps)', async () => {
    const probeArtifact = vi.fn(async () => 'doc:should-not-matter');
    const rows = [zeroHit('hot query', 'a'), zeroHit('hot query', 'b'), zeroHit('hot query', 'c')];
    const { deps, capture } = makeDeps(rows, { probeArtifact });
    await runNegativeSpaceTick('ws-1', deps);
    expect(probeArtifact).not.toHaveBeenCalled();
    expect(capture.mock.calls[0]![0].kind).toBe('change');
  });

  it('a probe failure degrades to the change shape — never a falsely-confident bug, never an aborted candidate', async () => {
    const { deps, capture } = makeDeps(slugRows(['a', 'b', 'c']), {
      probeArtifact: async () => {
        throw new Error('pg down');
      },
    });
    const result = await runNegativeSpaceTick('ws-1', deps);
    expect(result.filed).toEqual(['EI-100']);
    expect(capture.mock.calls[0]![0].kind).toBe('change');
  });

  it('no probe wired (legacy deps) keeps every candidate change-shaped', async () => {
    const { deps, capture } = makeDeps(slugRows(['a', 'b', 'c']));
    await runNegativeSpaceTick('ws-1', deps);
    expect(capture.mock.calls[0]![0].kind).toBe('change');
  });
});
