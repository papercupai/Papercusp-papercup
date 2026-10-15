import { describe, expect, it, vi } from 'vitest';
import { actionableConditionFor } from '../coord/actionable-conditions';
import { resolveConditionHarness } from '../coord/condition-bridge';
import {
  MAX_ROUTED_LEGS,
  frozenRepairLegConditionKey,
  planFrozenRepairLegRouting,
} from './frozen-repair-agent-routing';
import { routeFrozenRepairLegs, type FrozenRepairLegRoutingDeps } from './frozen-repair-leg-routing';

const CAND = 'c'.repeat(40);
const HEAD = 'h'.repeat(40);
const queue = (failingTests: string[]) => ({ candidate: CAND, repairHead: HEAD, failingTests });
const key = (entry: string, pipeline = 'papercusp') => frozenRepairLegConditionKey(pipeline, entry);

describe('planFrozenRepairLegRouting (P-013 / D-029)', () => {
  it('opens one claimable item per failing leg, keyed so the bridge files it under the pipeline', () => {
    const plan = planFrozenRepairLegRouting({
      pipeline: 'papercusp',
      queue: queue(['packages/a/x.test.ts', 'lint:tsc']),
      openLegKeys: [],
    });
    expect(plan.open.map((o) => o.conditionKey)).toEqual([key('packages/a/x.test.ts'), key('lint:tsc')]);
    expect(plan.resolve).toEqual([]);
    for (const o of plan.open) {
      expect(actionableConditionFor(o.conditionKey)?.severity).toBe('major');
      expect(resolveConditionHarness(o.conditionKey, null)).toBe('papercusp');
    }
  });

  it('never opens a second item for a leg that is already open', () => {
    const plan = planFrozenRepairLegRouting({
      pipeline: 'papercusp',
      queue: queue(['packages/a/x.test.ts', 'lint:tsc']),
      openLegKeys: [key('packages/a/x.test.ts')],
    });
    expect(plan.open.map((o) => o.entry)).toEqual(['lint:tsc']);
  });

  it('resolves an open leg once it leaves the failing set, and leaves other pipelines alone', () => {
    const plan = planFrozenRepairLegRouting({
      pipeline: 'papercusp',
      queue: queue(['lint:tsc']),
      openLegKeys: [key('packages/a/x.test.ts'), key('lint:tsc'), key('lint:tsc', 'portal')],
    });
    expect(plan.resolve).toEqual([key('packages/a/x.test.ts')]);
    expect(plan.open).toEqual([]);
  });

  it('a gone queue (null) resolves every open leg of the pipeline', () => {
    const plan = planFrozenRepairLegRouting({
      pipeline: 'papercusp',
      queue: null,
      openLegKeys: [key('a/b.test.ts'), key('lint:tsc')],
    });
    expect(plan.resolve).toEqual([key('a/b.test.ts'), key('lint:tsc')].sort());
    expect(plan.open).toEqual([]);
  });

  it(`routes at most ${MAX_ROUTED_LEGS} legs, de-duplicated, and the next one when a routed leg clears`, () => {
    const entries = Array.from({ length: MAX_ROUTED_LEGS + 3 }, (_, i) => `pkg/t${i}.test.ts`);
    const first = planFrozenRepairLegRouting({
      pipeline: 'papercusp',
      queue: queue([...entries, entries[0]!]),
      openLegKeys: [],
    });
    expect(first.open).toHaveLength(MAX_ROUTED_LEGS);
    const second = planFrozenRepairLegRouting({
      pipeline: 'papercusp',
      queue: queue(entries.slice(1)),
      openLegKeys: first.open.map((o) => o.conditionKey),
    });
    expect(second.resolve).toEqual([key(entries[0]!)]);
    expect(second.open.map((o) => o.entry)).toEqual([entries[MAX_ROUTED_LEGS]]);
  });

  it('the body carries the leg, both shas, the failure tail and a path-exact admit call', () => {
    const plan = planFrozenRepairLegRouting({
      pipeline: 'papercusp',
      queue: queue(['packages/a/x.test.ts', 'lint:tsc']),
      openLegKeys: [],
      failureTails: new Map([['packages/a/x.test.ts', 'AssertionError: expected 2 to be 3']]),
    });
    const [test, lint] = plan.open;
    expect(test!.body).toContain(CAND);
    expect(test!.body).toContain(HEAD);
    expect(test!.body).toContain('AssertionError: expected 2 to be 3');
    expect(test!.body).toContain("release:repair-queue { op: 'admit', paths: ['packages/a/x.test.ts'] }");
    expect(test!.summary).toContain('no gate ownership needed');
    // A leg name is not a path, so its admit call names the files the fixer changed.
    expect(lint!.body).not.toContain("paths: ['lint:tsc']");
    expect(lint!.body).toContain('none recorded for this leg');
  });
});

describe('routeFrozenRepairLegs', () => {
  const fakeDeps = (open: string[], over: Partial<FrozenRepairLegRoutingDeps> = {}) => {
    const deps = {
      readOpenConditionKeys: vi.fn(async (prefix: string) => open.filter((k) => k.startsWith(prefix))),
      readFailureTails: vi.fn(async () => new Map<string, string>()),
      broadcastOpen: vi.fn(async () => true),
      broadcastResolved: vi.fn(async () => true),
      ...over,
    };
    return deps;
  };

  it('a steady-state tick reads no tails and broadcasts nothing', async () => {
    const deps = fakeDeps([key('lint:tsc')]);
    const out = await routeFrozenRepairLegs({ pipeline: 'papercusp', queue: queue(['lint:tsc']) }, deps);
    expect(out).toMatchObject({ opened: [], resolved: [] });
    expect(deps.readFailureTails).not.toHaveBeenCalled();
    expect(deps.broadcastOpen).not.toHaveBeenCalled();
    expect(deps.broadcastResolved).not.toHaveBeenCalled();
  });

  it('opens new legs with their tails and resolves departed legs in ONE message', async () => {
    const deps = fakeDeps([key('old/gone.test.ts')], {
      readFailureTails: vi.fn(async () => new Map([['new/x.test.ts', 'boom']])),
    });
    const out = await routeFrozenRepairLegs({ pipeline: 'papercusp', queue: queue(['new/x.test.ts']) }, deps);
    expect(deps.readFailureTails).toHaveBeenCalledWith({
      candidate: CAND,
      repairHead: HEAD,
      entries: ['new/x.test.ts'],
    });
    expect(deps.broadcastOpen).toHaveBeenCalledTimes(1);
    // `...over` widens each field to the deps signature, so read the calls through vi.mocked.
    const opened = vi.mocked(deps.broadcastOpen).mock.calls[0]![0];
    expect(opened).toMatchObject({ conditionKey: key('new/x.test.ts') });
    expect(opened.body).toContain('boom');
    expect(deps.broadcastResolved).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.broadcastResolved).mock.calls[0]![0]).toMatchObject({
      conditionKeys: [key('old/gone.test.ts')],
    });
    expect(out).toMatchObject({ opened: [key('new/x.test.ts')], resolved: [key('old/gone.test.ts')] });
  });

  it('a failing tail read still opens the item, without the tail', async () => {
    const deps = fakeDeps([], {
      readFailureTails: vi.fn(async () => {
        throw new Error('pg down');
      }),
    });
    const out = await routeFrozenRepairLegs({ pipeline: 'papercusp', queue: queue(['a/b.test.ts']) }, deps);
    expect(out.opened).toEqual([key('a/b.test.ts')]);
  });

  it('a lost broadcast is not reported as opened, so the next tick retries it', async () => {
    const deps = fakeDeps([], { broadcastOpen: vi.fn(async () => false) });
    const out = await routeFrozenRepairLegs({ pipeline: 'papercusp', queue: queue(['a/b.test.ts']) }, deps);
    expect(out.opened).toEqual([]);
    expect(out.plan.open).toHaveLength(1);
  });
});
