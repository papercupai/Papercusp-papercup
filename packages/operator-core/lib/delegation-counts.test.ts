/**
 * R-5 guard for generic-acceptance-routing-and-live-plan-agent-brief-2026-09-20 P-005.
 *
 * R-5: "Each of the four delegation counts ... is served by one shared live
 * provider whose value tracks the underlying population on the next read."
 * Falsifier: "One of the four delegation counts is served from a source other
 * than the shared provider, or its value does not change on the next read after
 * the underlying population changes."
 *
 * The falsifier has two halves and this file guards BOTH, because each is
 * independently easy to regress:
 *
 *   (a) ONE provider — all four counts come out of `readDelegationCounts`.
 *   (b) NEXT-READ — mutate a population, re-read, the count moved.
 *
 * ⚠ (b) NEEDS A PAIRED CONTROL OR IT PASSES VACUOUSLY. A "the count tracked the
 * population" assertion passes just as happily against a provider that never
 * caches as against one whose cache happens to be cold on the first two reads.
 * `cachingProviderControl` below is a DELIBERATELY WRONG implementation kept
 * permanently in this file: the same assertion must FAIL against it. That is the
 * tier-2 falsifiability pattern from the repo guide — the control lives in the
 * test, so nothing in the shared tree is ever mutated to prove the guard bites.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  readDelegationCounts,
  renderDelegationCount,
  DELEGATION_COUNTS_SCHEMA_VERSION,
  type DelegationCountDeps,
  type DelegationCountContext,
  type PopulationCount,
} from './delegation-counts';
import type { ProviderRead } from './agent-obligation-providers';

/** A mutable stand-in for the four live populations. */
function mutablePopulations() {
  return {
    planExecutionAgents: 3,
    plansAwaitingDelegation: 5,
    plansAwaitingAcceptance: 2,
    activeDrainFleets: 1,
  };
}

/** The CORRECT shape: every call re-reads the population. */
function trackingDeps(pop: ReturnType<typeof mutablePopulations>): DelegationCountDeps {
  const read = (key: keyof typeof pop) => async (): Promise<PopulationCount> => ({
    count: pop[key],
    unmeasured: 0,
  });
  return {
    planExecutionAgents: read('planExecutionAgents'),
    plansAwaitingDelegation: read('plansAwaitingDelegation'),
    plansAwaitingAcceptance: read('plansAwaitingAcceptance'),
    activeDrainFleets: read('activeDrainFleets'),
  };
}

/**
 * THE CONTROL — deliberately wrong, kept permanently.
 *
 * Memoises the first read of each population, which is the single most likely
 * "optimisation" a future editor would add to this provider. The next-read
 * assertion MUST fail against this; if it ever passes, the assertion has stopped
 * measuring anything and the real provider could silently start caching.
 */
function cachingProviderControl(pop: ReturnType<typeof mutablePopulations>): DelegationCountDeps {
  const cache = new Map<string, PopulationCount>();
  const read = (key: keyof typeof pop) => async (): Promise<PopulationCount> => {
    const hit = cache.get(key);
    if (hit) return hit;
    const value = { count: pop[key], unmeasured: 0 };
    cache.set(key, value);
    return value;
  };
  return {
    planExecutionAgents: read('planExecutionAgents'),
    plansAwaitingDelegation: read('plansAwaitingDelegation'),
    plansAwaitingAcceptance: read('plansAwaitingAcceptance'),
    activeDrainFleets: read('activeDrainFleets'),
  };
}

const COUNT_KEYS = [
  'planExecutionAgents',
  'plansAwaitingDelegation',
  'plansAwaitingAcceptance',
  'activeDrainFleets',
] as const;

/**
 * Read one count's numeric value, failing loudly on an unknown.
 *
 * The narrowing `throw` is not dead code: `expect` does not narrow the union for
 * the compiler, and casting past it would let an `unknown` read silently yield
 * `undefined` here — an unknown quietly becoming a number is the exact confusion
 * the three-valued type exists to prevent.
 */
function known(read: ProviderRead<PopulationCount>): number {
  expect(read.status).toBe('known');
  if (read.status !== 'known') throw new Error(`expected a known count, got: ${read.status}`);
  return read.value.count;
}

describe('R-5 — one shared live provider for the four delegation counts', () => {
  it('serves ALL FOUR counts from a single provider call', async () => {
    const pop = mutablePopulations();
    const counts = await readDelegationCounts({
      workspaceId: 'ws-1',
      deps: trackingDeps(pop),
    });

    expect(counts.schemaVersion).toBe(DELEGATION_COUNTS_SCHEMA_VERSION);
    // Falsifier half (a): a count served from somewhere else would be absent here.
    for (const key of COUNT_KEYS) {
      expect(counts[key], `${key} must be served by the shared provider`).toBeDefined();
      expect(counts[key].status).toBe('known');
    }
    expect(known(counts.planExecutionAgents)).toBe(3);
    expect(known(counts.plansAwaitingDelegation)).toBe(5);
    expect(known(counts.plansAwaitingAcceptance)).toBe(2);
    expect(known(counts.activeDrainFleets)).toBe(1);
    expect(counts.degradedSources).toEqual([]);
  });

  it('tracks EVERY population on the next read', async () => {
    const pop = mutablePopulations();
    const deps = trackingDeps(pop);

    const before = await readDelegationCounts({ workspaceId: 'ws-1', deps });
    expect(known(before.planExecutionAgents)).toBe(3);

    // Mutate every underlying population — including the falsifier's own worked
    // example, "end one plan-execution agent".
    pop.planExecutionAgents -= 1;
    pop.plansAwaitingDelegation += 2;
    pop.plansAwaitingAcceptance = 0;
    pop.activeDrainFleets += 4;

    const after = await readDelegationCounts({ workspaceId: 'ws-1', deps });
    expect(known(after.planExecutionAgents)).toBe(2);
    expect(known(after.plansAwaitingDelegation)).toBe(7);
    expect(known(after.plansAwaitingAcceptance)).toBe(0);
    expect(known(after.activeDrainFleets)).toBe(5);
  });

  it('CONTROL: the next-read assertion FAILS against a caching provider', async () => {
    const pop = mutablePopulations();
    const deps = cachingProviderControl(pop);

    const before = await readDelegationCounts({ workspaceId: 'ws-1', deps });
    expect(known(before.planExecutionAgents)).toBe(3);

    pop.planExecutionAgents -= 1;

    const after = await readDelegationCounts({ workspaceId: 'ws-1', deps });
    // The control is stale BY CONSTRUCTION. Asserting the stale value here is
    // what proves the test above is capable of failing: if the real provider
    // ever started caching, that test would produce exactly this number.
    expect(known(after.planExecutionAgents)).toBe(3);
    expect(known(after.planExecutionAgents)).not.toBe(2);
  });

  it('CALIBRATION: the tracking and control providers disagree after a mutation', async () => {
    // Guards against both fixtures silently becoming the same thing — the way a
    // paired control quietly stops being a control.
    const popA = mutablePopulations();
    const popB = mutablePopulations();
    const tracking = trackingDeps(popA);
    const caching = cachingProviderControl(popB);

    await readDelegationCounts({ workspaceId: 'ws-1', deps: tracking });
    await readDelegationCounts({ workspaceId: 'ws-1', deps: caching });
    popA.activeDrainFleets = 99;
    popB.activeDrainFleets = 99;

    const trackedAfter = await readDelegationCounts({ workspaceId: 'ws-1', deps: tracking });
    const cachedAfter = await readDelegationCounts({ workspaceId: 'ws-1', deps: caching });
    expect(known(trackedAfter.activeDrainFleets)).toBe(99);
    expect(known(cachedAfter.activeDrainFleets)).toBe(1);
    expect(known(trackedAfter.activeDrainFleets)).not.toBe(
      known(cachedAfter.activeDrainFleets),
    );
  });
});

describe('a failed count is an explicit unknown, never a zero', () => {
  it('maps a throwing source to unknown and leaves the others known', async () => {
    const pop = mutablePopulations();
    const deps: DelegationCountDeps = {
      ...trackingDeps(pop),
      plansAwaitingAcceptance: async () => {
        throw new Error('relation "harness_shared.harness_plans" does not exist');
      },
    };

    const counts = await readDelegationCounts({ workspaceId: 'ws-1', deps });

    expect(counts.plansAwaitingAcceptance.status).toBe('unknown');
    if (counts.plansAwaitingAcceptance.status === 'unknown') {
      const { failure } = counts.plansAwaitingAcceptance;
      expect(failure.code).toBe('delegation-count-unreadable:plans-awaiting-acceptance');
      expect(failure.detail).toContain('does not exist');
      // The retry text exists to stop a reader collapsing this into "zero".
      expect(failure.retry).toContain('NOT zero');
    }
    // A degraded source must not contaminate the others.
    expect(known(counts.planExecutionAgents)).toBe(3);
    expect(counts.degradedSources).toEqual(['plans-awaiting-acceptance']);
  });

  it('maps a TIMED-OUT source to unknown rather than falling back to 0', async () => {
    // The bounded-timeout fallback is the sneakiest false-zero path: a zero
    // fallback would render as "nothing awaiting delegation" on a slow database.
    const pop = mutablePopulations();
    const deps: DelegationCountDeps = {
      ...trackingDeps(pop),
      plansAwaitingDelegation: () => new Promise<PopulationCount>(() => {}),
    };

    // The degradation warning is EXPECTED here, so it is asserted rather than
    // silenced — a timeout that degraded quietly would be its own defect.
    // The gate's pure lane can share a fork across files, so a co-resident
    // source may emit an unrelated warning while this process-global spy is active.
    const expectedWarningLabel = 'delegation-counts:plans-awaiting-delegation';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { counts, sourceWarningMessages } = await (async () => {
      try {
        const counts = await readDelegationCounts({
          workspaceId: 'ws-1',
          sourceTimeoutMs: 20,
          deps,
        });
        const sourceWarningMessages = warn.mock.calls
          .map(([message]) => String(message))
          .filter((message) => message.includes(expectedWarningLabel));
        return { counts, sourceWarningMessages };
      } finally {
        warn.mockRestore();
      }
    })();

    expect(sourceWarningMessages).toHaveLength(1);
    expect(sourceWarningMessages[0]).toContain(expectedWarningLabel);

    expect(counts.plansAwaitingDelegation.status).toBe('unknown');
    expect(renderDelegationCount(counts.plansAwaitingDelegation)).toBe('unknown (not measured)');
    expect(renderDelegationCount(counts.plansAwaitingDelegation)).not.toBe('0');
    expect(counts.degradedSources).toEqual(['plans-awaiting-delegation']);
  });

  it('CONTROL: a zero-valued count is NOT reported as unknown', async () => {
    // The dual of the two tests above — proves they distinguish "measured zero"
    // from "unmeasured", instead of calling everything unknown.
    const pop = { ...mutablePopulations(), plansAwaitingDelegation: 0 };
    const counts = await readDelegationCounts({
      workspaceId: 'ws-1',
      deps: trackingDeps(pop),
    });
    expect(counts.plansAwaitingDelegation.status).toBe('known');
    expect(known(counts.plansAwaitingDelegation)).toBe(0);
    expect(renderDelegationCount(counts.plansAwaitingDelegation)).toBe('0');
  });
});

describe('unmeasured residue survives aggregation', () => {
  it('keeps the unmeasured subject count ON the aggregate', async () => {
    const deps: DelegationCountDeps = {
      ...trackingDeps(mutablePopulations()),
      planExecutionAgents: async () => ({ count: 4, unmeasured: 3 }),
    };
    const counts = await readDelegationCounts({ workspaceId: 'ws-1', deps });

    expect(counts.planExecutionAgents.status).toBe('known');
    // 4 alone would read as a complete census; the residue must stay visible.
    expect(renderDelegationCount(counts.planExecutionAgents)).toBe('4 (+3 unmeasured)');
  });
});

describe('every dep shares ONE context per call, and a fresh one on the next call', () => {
  it('hands all four deps the same presence reader within a call, and a new one across calls', async () => {
    // This is the structural property the three presence-derived counts depend
    // on: if two of them read presence separately, an agent that ends between
    // the reads is simultaneously counted and not counted. Identity of the
    // `presence` reader is what makes them one snapshot — and its CHANGE across
    // calls is what keeps R-5's next-read property intact.
    const perCall: Array<Set<DelegationCountContext['presence']>> = [];
    const capture = (bucket: Set<DelegationCountContext['presence']>) =>
      async (ctx: DelegationCountContext): Promise<PopulationCount> => {
        bucket.add(ctx.presence);
        return { count: 0, unmeasured: 0 };
      };
    const depsFor = (bucket: Set<DelegationCountContext['presence']>): DelegationCountDeps => ({
      planExecutionAgents: capture(bucket),
      plansAwaitingDelegation: capture(bucket),
      plansAwaitingAcceptance: capture(bucket),
      activeDrainFleets: capture(bucket),
    });

    const first = new Set<DelegationCountContext['presence']>();
    perCall.push(first);
    await readDelegationCounts({ workspaceId: 'ws-1', deps: depsFor(first) });

    const second = new Set<DelegationCountContext['presence']>();
    perCall.push(second);
    await readDelegationCounts({ workspaceId: 'ws-1', deps: depsFor(second) });

    // All four deps in one call saw exactly one presence reader.
    expect(first.size).toBe(1);
    expect(second.size).toBe(1);
    // ...and the next call built a new one, so nothing carries over.
    const [a] = [...first];
    const [b] = [...second];
    expect(a).not.toBe(b);
  });
});
