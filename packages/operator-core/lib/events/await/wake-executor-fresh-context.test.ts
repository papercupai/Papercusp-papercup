/**
 * Unit tests for the wake-executor fresh-context fork (bee-context-efficiency P-005).
 *
 * Covers the two decision functions whose wrong answer either strands a wake or
 * reloads a drained bee's dead transcript:
 *   - freshContextWarmInjectTarget: payload-marker parsing (null/non-object/partial/valid)
 *   - runFreshContextWarmInject: flag gate, spawn-not-admitted, spawn-throw, the
 *     non-fatal releaseClaim failure, lineage of the fresh spawn, and the fail-soft
 *     `false` (caller falls through to --resume) on every failure path.
 *   - defaultFreshContextEnabled: flag read + catch→false.
 *
 * All IO is behind the module's DI seams (deps) or the mocked flags server — no real
 * spawn / DB / flag store fires. A custom `log` sink keeps the console clean
 * (operator-core is fail-on-console).
 *
 * Run: cd packages/operator-core && npx vitest run lib/events/await/wake-executor-fresh-context.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const flagH = vi.hoisted(() => ({
  getFlag: vi.fn<(key: string, scope: string) => Promise<boolean>>(() => Promise.resolve(false)),
}));
vi.mock('@papercusp/flags', () => ({ FLAGS: { CUP_FRESH_CONTEXT_WARM_INJECT: 'bee_fresh_context_warm_inject' } }));
vi.mock('@papercusp/flags/server', () => ({ getFlag: flagH.getFlag }));

import {
  defaultFreshContextEnabled,
  freshContextWarmInjectTarget,
  runFreshContextWarmInject,
  type FreshContextDeps,
  type FreshContextTarget,
} from './wake-executor-fresh-context';
import type { DeliveryWork } from './types';

function makeDelivery(payload: unknown, over: Partial<DeliveryWork> = {}): DeliveryWork {
  return {
    id: 1,
    workspaceId: 'ws-1',
    awaitId: 10,
    subscriberId: 'spawn-exited-bee',
    eventKey: 'work-item:placed:WI-1',
    payload,
    summary: null,
    status: 'pending',
    channel: null,
    attempts: 0,
    lastError: null,
    nextAttemptAt: '',
    createdAt: '',
    deliveredAt: null,
    urgent: false,
    minSleepSec: null,
    coalescedCount: 1,
    source: null,
    wakeHandle: null,
    note: null,
    turnProof: null,
    turnStartedAt: null,
    pickupDeadlineAt: null,
    ...over,
  };
}

const VALID_TARGET: FreshContextTarget = { workItemId: 'WI-1', harness: 'papercup', brief: 'do the thing' };

describe('freshContextWarmInjectTarget', () => {
  it('returns null for a null / undefined / non-object payload', () => {
    expect(freshContextWarmInjectTarget(makeDelivery(null))).toBeNull();
    expect(freshContextWarmInjectTarget(makeDelivery(undefined))).toBeNull();
    expect(freshContextWarmInjectTarget(makeDelivery('a string'))).toBeNull();
    expect(freshContextWarmInjectTarget(makeDelivery(42))).toBeNull();
  });

  it('returns null when the work-item marker is missing or non-string', () => {
    expect(freshContextWarmInjectTarget(makeDelivery({ freshContextHarness: 'papercup' }))).toBeNull();
    expect(
      freshContextWarmInjectTarget(makeDelivery({ freshContextWorkItem: 123, freshContextHarness: 'papercup' })),
    ).toBeNull();
  });

  it('returns null when the harness marker is missing', () => {
    expect(freshContextWarmInjectTarget(makeDelivery({ freshContextWorkItem: 'WI-1' }))).toBeNull();
  });

  it('parses a valid marker, defaulting brief to null when absent or non-string', () => {
    expect(
      freshContextWarmInjectTarget(makeDelivery({ freshContextWorkItem: 'WI-9', freshContextHarness: 'sheets' })),
    ).toEqual({ workItemId: 'WI-9', harness: 'sheets', brief: null });
    expect(
      freshContextWarmInjectTarget(
        makeDelivery({ freshContextWorkItem: 'WI-9', freshContextHarness: 'sheets', freshContextBrief: 99 }),
      ),
    ).toEqual({ workItemId: 'WI-9', harness: 'sheets', brief: null });
  });

  it('preserves a string brief', () => {
    expect(
      freshContextWarmInjectTarget(
        makeDelivery({ freshContextWorkItem: 'WI-9', freshContextHarness: 'sheets', freshContextBrief: 'ship it' }),
      ),
    ).toEqual({ workItemId: 'WI-9', harness: 'sheets', brief: 'ship it' });
  });
});

describe('runFreshContextWarmInject', () => {
  let spawnFreshBee: ReturnType<typeof vi.fn>;
  let releaseClaim: ReturnType<typeof vi.fn>;
  let log: (m: string) => void;
  let logMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    spawnFreshBee = vi.fn(async () => ({ ok: true, spawnId: 'spawn-fresh-bee' }));
    releaseClaim = vi.fn(async () => {});
    logMock = vi.fn();
    log = logMock as (m: string) => void;
  });
  afterEach(() => vi.clearAllMocks());

  const deps = (over: Partial<FreshContextDeps> = {}): FreshContextDeps => ({
    enabled: async () => true,
    spawnFreshBee: spawnFreshBee as FreshContextDeps['spawnFreshBee'],
    releaseClaim: releaseClaim as FreshContextDeps['releaseClaim'],
    ...over,
  });

  it('returns false and does not spawn when the flag is disabled', async () => {
    const r = await runFreshContextWarmInject(makeDelivery(null), VALID_TARGET, deps({ enabled: async () => false }), log);
    expect(r).toBe(false);
    expect(spawnFreshBee).not.toHaveBeenCalled();
  });

  it('returns false (fail-soft) when the enabled check throws', async () => {
    const r = await runFreshContextWarmInject(
      makeDelivery(null),
      VALID_TARGET,
      deps({ enabled: async () => { throw new Error('flag store down'); } }),
      log,
    );
    expect(r).toBe(false);
    expect(spawnFreshBee).not.toHaveBeenCalled();
  });

  it('spawns a fresh bee with the right lineage + target and returns true on success', async () => {
    const d = makeDelivery(null, { workspaceId: 'ws-7', subscriberId: 'spawn-old-bee' });
    const r = await runFreshContextWarmInject(d, VALID_TARGET, deps(), log);
    expect(r).toBe(true);
    expect(spawnFreshBee).toHaveBeenCalledTimes(1);
    expect(spawnFreshBee).toHaveBeenCalledWith({
      workspaceId: 'ws-7',
      harness: 'papercup',
      workItemId: 'WI-1',
      brief: 'do the thing',
      parentSpawnId: 'spawn-old-bee', // the fresh bee succeeds the exited one
    });
    expect(releaseClaim).toHaveBeenCalledWith('WI-1', 'papercup');
  });

  it('returns false and skips releaseClaim when the spawn is not admitted (over-cap)', async () => {
    spawnFreshBee.mockResolvedValueOnce({ ok: false, spawnId: null });
    const r = await runFreshContextWarmInject(makeDelivery(null), VALID_TARGET, deps(), log);
    expect(r).toBe(false);
    expect(releaseClaim).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining('not admitted'));
  });

  it('returns false (fail-soft) when the spawn throws', async () => {
    spawnFreshBee.mockRejectedValueOnce(new Error('spawn boom'));
    const r = await runFreshContextWarmInject(makeDelivery(null), VALID_TARGET, deps(), log);
    expect(r).toBe(false);
    expect(releaseClaim).not.toHaveBeenCalled();
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining('errored'));
  });

  it('still returns true when the (non-fatal) claim release fails after a successful spawn', async () => {
    releaseClaim.mockRejectedValueOnce(new Error('release hiccup'));
    const r = await runFreshContextWarmInject(makeDelivery(null), VALID_TARGET, deps(), log);
    expect(r).toBe(true); // the fresh bee is up; the stale claim release is best-effort
    expect(logMock).toHaveBeenCalledWith(expect.stringContaining('release claim'));
  });

  it('defaults the log sink to a no-op (never throws without a logger)', async () => {
    spawnFreshBee.mockResolvedValueOnce({ ok: false });
    const r = await runFreshContextWarmInject(makeDelivery(null), VALID_TARGET, deps());
    expect(r).toBe(false);
  });
});

describe('defaultFreshContextEnabled', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns the flag value', async () => {
    flagH.getFlag.mockResolvedValueOnce(true);
    expect(await defaultFreshContextEnabled()).toBe(true);
  });

  it('fails soft to false when the flag read rejects', async () => {
    flagH.getFlag.mockRejectedValueOnce(new Error('flag store down'));
    expect(await defaultFreshContextEnabled()).toBe(false);
  });
});
