import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentFact, AssertFactInput } from '../../agent-facts/store';

const h = vi.hoisted(() => {
  const boundedTx = { query: vi.fn(), marker: 'bounded-org-txn' };
  return {
    assertFact: vi.fn<(input: AssertFactInput, inject?: unknown) => Promise<AgentFact>>(),
    boundedTx,
    boundedOrgTxn: vi.fn(async (fn: (tx: typeof boundedTx) => Promise<AgentFact>) => fn(boundedTx)),
    readFrozenRepairMarker: vi.fn(),
    lineageQuery: vi.fn(async (_sql: string, _params: string[]): Promise<Record<string, unknown>[]> => [{ exists: 1 }]),
  };
});

vi.mock('../../agent-facts/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agent-facts/store')>();
  return { ...actual, assertFact: h.assertFact };
});
vi.mock('../../pg-bounded-txn', () => ({ boundedOrgTxn: h.boundedOrgTxn }));
// Keep validation real; replace only the source-resolution database boundary.
vi.mock('../../promotion-lineage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../promotion-lineage')>();
  return { ...actual, validatePromotedFrom: (raw: Parameters<typeof actual.validatePromotedFrom>[0], workspace: string) =>
    actual.validatePromotedFrom(raw, workspace, h.lineageQuery) };
});
vi.mock('../../release/frozen-repair-edit-marker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../release/frozen-repair-edit-marker')>();
  return { ...actual, readFrozenRepairMarker: h.readFrozenRepairMarker };
});

import assertTool from './assert';

function storedFact(input: AssertFactInput): AgentFact {
  return {
    scope: input.scope,
    scopeRef: input.scopeRef ?? null,
    key: input.key,
    body: input.body,
    sourceRef: input.sourceRef ?? null,
    audienceScope: input.audienceScope ?? null,
    sourceProvenance: input.sourceProvenance ?? null,
    confidence: input.confidence ?? null,
    measurement: null,
    kind: input.kind ?? null,
    dependsOn: [...(input.dependsOn ?? [])],
    claim: input.claim ?? null,
    enforcement: input.enforcement ?? null,
    settledBy: input.settledBy ?? null,
    createdBy: input.createdBy,
    updatedAt: '2026-01-01T00:00:00.000Z',
    expiresAt: '2026-01-08T00:00:00.000Z',
  } as AgentFact;
}

describe('facts:assert — own a bounded transaction for the multi-query write', () => {
  beforeEach(() => {
    h.assertFact.mockReset();
    h.assertFact.mockImplementation(async (input) => storedFact(input));
    h.boundedOrgTxn.mockReset();
    h.boundedOrgTxn.mockImplementation(async (fn) => fn(h.boundedTx));
    h.readFrozenRepairMarker.mockReset();
    h.readFrozenRepairMarker.mockReturnValue(null);
    h.lineageQuery.mockReset();
    h.lineageQuery.mockResolvedValue([{ exists: 1 }]);
  });

  it('uses its own bounded transaction instead of the ambient ctx.tx', async () => {
    const ambientTx = { query: vi.fn(), marker: 'ambient-dispatcher-tx' };

    await assertTool.handler(
      { scope: 'owner', scopeRef: 'su-test', key: 'tx-reuse', body: 'keep this conclusion' } as never,
      { isSuperuser: true, uiClientId: 'su-test-tx-reuse', tx: ambientTx } as never,
    );

    expect((assertTool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
    expect(h.boundedOrgTxn).toHaveBeenCalledTimes(1);
    expect(h.assertFact).toHaveBeenCalledTimes(1);
    expect(h.assertFact.mock.calls[0][1]).toBe(h.boundedTx);
    expect(h.assertFact.mock.calls[0][1]).not.toBe(ambientTx);
  });

  it('passes resolved promotion lineage to the canonical fact writer', async () => {
    const promotedFrom = [{ kind: 'work-item', ref: 'WI-123' }];
    await assertTool.handler(
      { scope: 'owner', scopeRef: 'su-test', key: 'promoted-claim', body: 'Source-backed conclusion', promotedFrom } as never,
      { isSuperuser: true, uiClientId: 'su-test', workspaceId: 'lineage-workspace' } as never,
    );
    expect(h.lineageQuery).toHaveBeenCalledWith(expect.stringContaining('harness_shared.work_items'), ['lineage-workspace', 'WI-123']);
    expect(h.assertFact).toHaveBeenCalledWith(expect.objectContaining({
      sourceProvenance: expect.objectContaining({ promotedFrom }),
    }), h.boundedTx);
  });

  it.each(['missing', 'unavailable'])('refuses %s promotion lineage before the fact transaction', async (state) => {
    if (state === 'missing') h.lineageQuery.mockResolvedValue([]);
    else h.lineageQuery.mockRejectedValue(new Error('resolver offline'));
    await expect(assertTool.handler(
      { scope: 'owner', scopeRef: 'su-test', key: 'promoted-claim', body: 'Source-backed conclusion',
        promotedFrom: [{ kind: 'work-item', ref: 'WI-123' }] } as never,
      { isSuperuser: true, uiClientId: 'su-test', workspaceId: 'lineage-workspace' } as never,
    )).rejects.toThrow(state === 'missing' ? 'source missing' : 'resolution unavailable');
    expect(h.boundedOrgTxn).not.toHaveBeenCalled();
    expect(h.assertFact).not.toHaveBeenCalled();
  });

  it('retries the complete bounded transaction on transient contention', async () => {
    let attempts = 0;
    h.boundedOrgTxn.mockImplementation(async (fn) => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error('lock timeout'), { code: '55P03' });
      }
      return fn(h.boundedTx);
    });

    await assertTool.handler(
      { scope: 'owner', scopeRef: 'su-test', key: 'tx-retry', body: 'retry the whole unit' } as never,
      { isSuperuser: true, uiClientId: 'su-test-tx-retry' } as never,
    );

    expect(h.boundedOrgTxn).toHaveBeenCalledTimes(2);
    expect(h.assertFact).toHaveBeenCalledTimes(1);
    expect(h.assertFact.mock.calls[0][1]).toBe(h.boundedTx);
  });

  it('refuses the historical staging-candidate instruction before opening the fact transaction', async () => {
    h.readFrozenRepairMarker.mockReturnValue({
      candidate: 'c'.repeat(40),
      repairHead: 'r'.repeat(40),
      phase: 'repair-in-progress',
      failingPaths: [],
      updatedAtMs: 1_788_763_360_000,
      admittedPaths: [],
      legs: [],
    });

    const out = (await assertTool.handler(
      {
        scope: 'owner',
        scopeRef: 'su-test',
        key: 'stale-candidate-instruction',
        body: 'Then pin whatever staging resolves to at that instant, still never a quoted sha.',
      } as never,
      { isSuperuser: true, uiClientId: 'su-test-frozen-carry' } as never,
    )) as { content: Array<{ text: string }>; isError?: boolean };
    const payload = JSON.parse(out.content[0]!.text);

    expect(out.isError).toBe(true);
    expect(payload).toMatchObject({
      ok: false,
      error: 'frozen_candidate_lineage_violation',
      surface: 'fact',
      unsafeSource: 'staging',
      liveIdentity: {
        candidate: 'c'.repeat(40),
        repairHead: 'r'.repeat(40),
        queueRevision: 1_788_763_360_000,
      },
    });
    expect(h.boundedOrgTxn).not.toHaveBeenCalled();
    expect(h.assertFact).not.toHaveBeenCalled();
  });
});
