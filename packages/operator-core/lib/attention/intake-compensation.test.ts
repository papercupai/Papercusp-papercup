/**
 * P-009 (observation-candidate-acceptance-promotion D-019) — unit coverage for the
 * inverse of an applied intake decision, driven through an in-memory store so
 * every branch is reachable without a database.
 *
 *  - R-9: an unclaimed promotion is reversed and a triage decision reopened
 *    exactly once (a retry is `already-reversed` and writes nothing).
 *  - R-30: owned / active / checkpointed / linked work is never revoked or
 *    deleted; the inverse records a correction instead.
 *  - A failed or mismatched inverse is never hidden: it throws to the caller.
 */
import { describe, expect, it } from 'vitest';

import type { BulkIntakeDecision } from './bulk-dispositions';
import {
  compensateIntakeDecision,
  type IntakeCompensationInput,
  type IntakeCompensationItem,
  type IntakeCompensationStore,
} from './intake-compensation';
import {
  createImplementationReadiness,
  readImplementationReadiness,
} from '../harness/improvements/agent-review-policy';

const RUN = 'run-1';
const ITEM = 'att-1';
const APPLIED_AT = '2026-10-01T10:00:00.000Z';
const NOW = new Date('2026-10-01T12:00:00.000Z');

function decision(disposition: BulkIntakeDecision['disposition'], extra: Partial<BulkIntakeDecision> = {}) {
  return {
    disposition,
    reason: 'judged',
    decidedBy: 'su-reviewer',
    owner: 'engineering',
    targetRef: null,
    missingInformation: null,
    decidedAt: APPLIED_AT,
    workKind: 'fix',
    acceptance: null,
    sourceRevision: 'rev-1',
    ...extra,
  } as BulkIntakeDecision;
}

function item(id: string, over: Partial<IntakeCompensationItem> = {}): IntakeCompensationItem {
  return {
    id,
    harnessSlug: 'papercusp',
    status: 'open',
    takenBy: null,
    takenAt: null,
    firstClaimedAt: null,
    stateChangedAt: null,
    payload: {},
    ...over,
  };
}

interface FakeStore extends IntakeCompensationStore {
  items: Map<string, IntakeCompensationItem>;
  writes: Array<{ id: string; patch: Record<string, unknown>; unset: readonly string[] }>;
  statuses: Array<{ id: string; status: string; reason: string }>;
  locks: string[][];
  checkpoints: Set<string>;
  links: Map<string, number>;
  failWrite?: string;
}

function fakeStore(...seed: IntakeCompensationItem[]): FakeStore {
  const store: FakeStore = {
    items: new Map(seed.map((i) => [i.id, i])),
    writes: [],
    statuses: [],
    locks: [],
    checkpoints: new Set(),
    links: new Map(),
    async lockIntake(ids) {
      store.locks.push([...ids]);
    },
    async lockItem(id) {
      return store.items.get(id) ?? null;
    },
    async hasCheckpoint(i) {
      return store.checkpoints.has(i.id);
    },
    async downstreamLinkCount(id) {
      return store.links.get(id) ?? 0;
    },
    async writePayload(i, patch, unset) {
      if (store.failWrite === i.id) throw new Error(`payload write on ${i.id} failed`);
      if (!Object.keys(patch).length && !unset.length) return;
      store.writes.push({ id: i.id, patch, unset });
      const keep = Object.fromEntries(Object.entries(i.payload).filter(([key]) => !unset.includes(key)));
      i.payload = { ...keep, ...patch };
    },
    async setStatus(i, status, reason) {
      store.statuses.push({ id: i.id, status, reason });
      i.status = status;
    },
    now: () => NOW,
  };
  return store;
}

function input(sourceId: string, d: BulkIntakeDecision | null, over: Partial<IntakeCompensationInput> = {}) {
  return { sourceId, harnessSlug: 'papercusp', runId: RUN, itemId: ITEM, decision: d, ...over };
}

function snapshot(store: FakeStore) {
  return { writes: store.writes.length, statuses: store.statuses.length };
}

describe('compensateIntakeDecision — triage decisions (R-9)', () => {
  it.each(['retain', 'reject'] as const)('reopens a %s decision exactly once', async (disposition) => {
    const stored = { disposition, reason: 'judged', runId: RUN, itemId: ITEM, decidedAt: APPLIED_AT };
    const source = item('EI-1', { payload: { intakeDisposition: stored } });
    const store = fakeStore(source);

    const first = await compensateIntakeDecision(input('EI-1', decision(disposition)), store);
    expect(first.outcome).toBe('reversed');
    expect(source.payload.intakeDisposition).toBeUndefined();
    expect(source.payload.intakeDispositionReversed).toEqual([
      { ...stored, reversedAt: NOW.toISOString(), reversedBy: 'bulk-run-reversal' },
    ]);
    expect(store.locks[0]).toEqual(['EI-1']);

    const before = snapshot(store);
    const retry = await compensateIntakeDecision(input('EI-1', decision(disposition)), store);
    expect(retry.outcome).toBe('already-reversed');
    expect(snapshot(store)).toEqual(before);
  });

  it('refuses (source-changed) when the stored disposition belongs to a different run', async () => {
    const source = item('EI-1', {
      payload: { intakeDisposition: { disposition: 'reject', runId: 'run-other', itemId: ITEM } },
    });
    const store = fakeStore(source);
    await expect(compensateIntakeDecision(input('EI-1', decision('reject')), store)).rejects.toThrow(
      /source-changed.*nothing was reverted/,
    );
    expect(store.writes).toEqual([]);
  });
});

describe('compensateIntakeDecision — distinct promotion (R-9 / R-30)', () => {
  function promoted(over: Partial<IntakeCompensationItem> = {}) {
    const receipt = { runId: RUN, itemId: ITEM, mode: 'distinct', promotedAt: APPLIED_AT, key: 'intake-exec:EI-1:rev-1' };
    const source = item('EI-1', {
      payload: {
        intakeExecution: { disposition: 'promote', workItemId: 'EI-2', runId: RUN, itemId: ITEM, at: APPLIED_AT },
      },
    });
    const target = item('EI-2', { payload: { intakePromotion: receipt }, ...over });
    return { source, target, receipt };
  }

  it('drops an unclaimed promoted item, keeps the receipt as history, and is exactly-once', async () => {
    const { source, target, receipt } = promoted();
    const store = fakeStore(source, target);

    const first = await compensateIntakeDecision(input('EI-1', decision('promote')), store);
    expect(first.outcome).toBe('reversed');
    expect(store.statuses).toEqual([
      { id: 'EI-2', status: 'dropped', reason: `intake promotion reversed (run ${RUN} item ${ITEM})` },
    ]);
    // The unique promotion key is freed; the receipt survives as history, never deleted.
    expect(target.payload.intakePromotion).toBeUndefined();
    expect(target.payload.intakePromotionReversed).toEqual([
      { ...receipt, reversedAt: NOW.toISOString(), reversedBy: 'bulk-run-reversal' },
    ]);
    expect(source.payload.intakeExecution).toBeUndefined();
    expect((source.payload.intakeExecutionReversed as unknown[]).length).toBe(1);
    expect(store.locks).toContainEqual(['EI-1', 'EI-2']);

    const before = snapshot(store);
    const retry = await compensateIntakeDecision(input('EI-1', decision('promote')), store);
    expect(retry.outcome).toBe('already-reversed');
    expect(snapshot(store)).toEqual(before);
  });

  it.each([
    ['claimed', { takenBy: 'su-worker', takenAt: '2026-10-01T11:00:00.000Z' }],
    ['previously claimed', { firstClaimedAt: '2026-10-01T11:00:00.000Z' }],
    ['active', { status: 'wip' }],
    ['completed', { status: 'done' }],
  ] as const)('records a correction instead of revoking %s work', async (_label, over) => {
    const { source, target } = promoted(over as Partial<IntakeCompensationItem>);
    const store = fakeStore(source, target);

    const result = await compensateIntakeDecision(input('EI-1', decision('promote')), store);
    expect(result.outcome).toBe('correction-recorded');
    expect(result.note).toMatch(/not revoked/);
    expect(store.statuses).toEqual([]);
    expect(target.payload.intakePromotion).toBeDefined();
    expect(source.payload.intakeExecution).toBeDefined();
    expect(target.payload.intakeCorrections).toEqual([
      expect.objectContaining({ runId: RUN, itemId: ITEM, sourceId: 'EI-1', disposition: 'promote' }),
    ]);

    // A retried undo does not duplicate the correction.
    await compensateIntakeDecision(input('EI-1', decision('promote')), store);
    expect((target.payload.intakeCorrections as unknown[]).length).toBe(1);
  });

  it('records a correction when the promoted item carries a checkpoint or downstream links', async () => {
    for (const mark of ['checkpoint', 'links'] as const) {
      const { source, target } = promoted();
      const store = fakeStore(source, target);
      if (mark === 'checkpoint') store.checkpoints.add('EI-2');
      else store.links.set('EI-2', 2);
      const result = await compensateIntakeDecision(input('EI-1', decision('investigate')), store);
      expect(result.outcome).toBe('correction-recorded');
      expect(store.statuses).toEqual([]);
      const observed = (target.payload.intakeCorrections as Array<{ observed: Record<string, unknown> }>)[0].observed;
      expect(mark === 'checkpoint' ? observed.checkpoint : observed.downstreamLinks).toBe(mark === 'checkpoint' ? true : 2);
    }
  });

  it('never hides a failed inverse: a store failure propagates', async () => {
    const { source, target } = promoted();
    const store = fakeStore(source, target);
    store.failWrite = 'EI-1';
    await expect(compensateIntakeDecision(input('EI-1', decision('promote')), store)).rejects.toThrow(
      'payload write on EI-1 failed',
    );
  });

  it('throws when the promoted item no longer exists', async () => {
    const { source } = promoted();
    const store = fakeStore(source);
    await expect(compensateIntakeDecision(input('EI-1', decision('promote')), store)).rejects.toThrow(
      'promoted item EI-2 no longer exists',
    );
  });
});

describe('compensateIntakeDecision — in-place promotion', () => {
  const acceptance = { problem: 'p', evidence: ['e'], outcome: 'o', scope: 's', completionCheck: 'c' };

  function inPlace(over: Partial<IntakeCompensationItem> = {}) {
    const receipt = { runId: RUN, itemId: ITEM, mode: 'in-place', promotedAt: APPLIED_AT };
    return item('EI-1', {
      payload: {
        implementationReadiness: createImplementationReadiness({
          status: 'ready',
          source: 'agent-review',
          reason: 'intake-promoted',
          updatedAt: APPLIED_AT,
          evidence: { acceptance } as never,
        }),
        intakePromotion: receipt,
        intakeSource: { id: 'EI-1', mode: 'in-place', revision: 'rev-1' },
      },
      ...over,
    });
  }

  it('returns readiness to not-ready, keeps the sealed contract, and is exactly-once', async () => {
    const source = inPlace();
    const store = fakeStore(source);

    const first = await compensateIntakeDecision(input('EI-1', decision('promote')), store);
    expect(first.outcome).toBe('reversed');
    const readiness = readImplementationReadiness(source.payload);
    expect(readiness?.status).toBe('not-ready');
    expect(readiness?.reason).toBe('intake-promotion-reversed');
    expect((readiness?.evidence as Record<string, unknown>).reversedAcceptance).toEqual(acceptance);
    expect((readiness?.evidence as Record<string, unknown>).acceptance).toBeUndefined();
    expect(source.payload.intakePromotion).toBeUndefined();
    expect(source.payload.intakeSource).toBeUndefined();
    expect(store.statuses).toEqual([]);

    const before = snapshot(store);
    expect((await compensateIntakeDecision(input('EI-1', decision('promote')), store)).outcome).toBe(
      'already-reversed',
    );
    expect(snapshot(store)).toEqual(before);
  });

  it('records a correction when the in-place item was taken', async () => {
    const source = inPlace({ takenBy: 'su-worker' });
    const store = fakeStore(source);
    const result = await compensateIntakeDecision(input('EI-1', decision('promote')), store);
    expect(result.outcome).toBe('correction-recorded');
    expect(readImplementationReadiness(source.payload)?.status).toBe('ready');
  });

  it('refuses (source-changed) when no promotion from this run+item is present', async () => {
    const store = fakeStore(item('EI-1'));
    await expect(compensateIntakeDecision(input('EI-1', decision('promote')), store)).rejects.toThrow(
      /source-changed/,
    );
  });
});

describe('compensateIntakeDecision — merge', () => {
  function merged(sourceOver: Partial<IntakeCompensationItem> = {}, pointerOver: Record<string, unknown> = {}) {
    const pointer = {
      disposition: 'merge',
      workItemId: 'EI-9',
      distinctRemedy: null,
      runId: RUN,
      itemId: ITEM,
      at: APPLIED_AT,
      ...pointerOver,
    };
    const source = item('EI-1', {
      status: 'dropped',
      stateChangedAt: '2026-10-01T10:00:01.000Z',
      payload: { intakeExecution: pointer },
      ...sourceOver,
    });
    const target = item('EI-9', {
      payload: {
        intakeMergedSources: [
          { sourceId: 'EI-0', runId: 'run-0', itemId: 'att-0', evidence: ['older'] },
          { sourceId: 'EI-1', runId: RUN, itemId: ITEM, evidence: ['kept'] },
        ],
      },
    });
    return { source, target };
  }

  it('reopens a source the merge closed, marks (never deletes) the merged evidence, exactly once', async () => {
    const { source, target } = merged();
    const store = fakeStore(source, target);

    const first = await compensateIntakeDecision(input('EI-1', decision('merge', { targetRef: 'EI-9' })), store);
    expect(first.outcome).toBe('reversed');
    expect(store.statuses).toEqual([
      { id: 'EI-1', status: 'open', reason: `intake merge reversed (run ${RUN} item ${ITEM})` },
    ]);
    expect(target.payload.intakeMergedSources).toEqual([
      { sourceId: 'EI-0', runId: 'run-0', itemId: 'att-0', evidence: ['older'] },
      { sourceId: 'EI-1', runId: RUN, itemId: ITEM, evidence: ['kept'], reversed: true, reversedAt: NOW.toISOString() },
    ]);
    expect(source.payload.intakeExecution).toBeUndefined();

    const before = snapshot(store);
    expect(
      (await compensateIntakeDecision(input('EI-1', decision('merge', { targetRef: 'EI-9' })), store)).outcome,
    ).toBe('already-reversed');
    expect(snapshot(store)).toEqual(before);
  });

  it('does not reopen an observation, a distinct-remedy source, or a close that predates the merge', async () => {
    const cases = [
      merged({ payload: {} }, {}),
      merged({}, { distinctRemedy: 'its own fix' }),
      merged({ stateChangedAt: '2026-10-01T09:00:00.000Z' }),
    ];
    // An observation is retained as evidence: lane comes through the payload.
    cases[0].source.payload = {
      lane: 'observation',
      intakeExecution: { disposition: 'merge', workItemId: 'EI-9', distinctRemedy: null, runId: RUN, itemId: ITEM, at: APPLIED_AT },
    };
    for (const { source, target } of cases) {
      const store = fakeStore(source, target);
      const result = await compensateIntakeDecision(input('EI-1', decision('merge', { targetRef: 'EI-9' })), store);
      expect(result.outcome).toBe('reversed');
      expect(store.statuses).toEqual([]);
      expect(source.status).toBe('dropped');
    }
  });
});

describe('compensateIntakeDecision — guards', () => {
  it('throws without a recorded decision, for a missing source, and for a non-invertible disposition', async () => {
    const store = fakeStore(item('EI-1'));
    await expect(compensateIntakeDecision(input('EI-1', null), store)).rejects.toThrow('no recorded intake decision');
    await expect(compensateIntakeDecision(input('EI-404', decision('reject')), store)).rejects.toThrow(
      'source EI-404 no longer exists',
    );
    await expect(compensateIntakeDecision(input('EI-1', decision('retry')), store)).rejects.toThrow(
      "cannot invert disposition 'retry'",
    );
    expect(store.writes).toEqual([]);
    expect(store.statuses).toEqual([]);
  });
});
