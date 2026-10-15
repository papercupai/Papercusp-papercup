/**
 * P-010 conformance suite: Claude and Codex run the SAME admission lifecycle.
 *
 * The acceptance criterion is deliberately a PARAMETERIZED suite rather than
 * two provider-specific test blocks — a suite that has to be written twice is
 * exactly the duplication P-010 deletes, and two hand-kept copies are how the
 * retired Claude/Codex controllers drifted apart in the first place. Every case
 * below runs unchanged against every registered lane.
 *
 * Each negative assertion carries a CALIBRATION control in the same test, so a
 * suite that silently stopped exercising the subject cannot pass vacuously.
 */

import { describe, expect, it } from 'vitest';

import {
  INITIAL_PROVIDER_ADMISSION_WINDOW,
  PROVIDER_ADMISSION_LIFECYCLE_SCHEMA_VERSION,
  ProviderAdmissionLifecycle,
  type ProviderLaneId,
  type ProviderLaneQueue,
} from './provider-admission-lifecycle';

/** The ceilings P-010 retires. Named here so the "grows beyond" cases cite the real numbers. */
const RETIRED_CLAUDE_DEFAULT_CONCURRENCY = 24;
const RETIRED_CODEX_SLOTS_PER_ACCOUNT = 4;

class RecordingQueue implements ProviderLaneQueue {
  maxConcurrent: number | null = null;
  readonly tierCaps = new Map<number, number>();
  readonly maxConcurrentHistory: number[] = [];

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = n;
    this.maxConcurrentHistory.push(n);
  }

  setTierCap(tier: number, cap: number): void {
    this.tierCaps.set(tier, cap);
  }
}

const LANES: readonly ProviderLaneId[] = ['claude', 'codex'];

function makeLifecycle(
  options: {
    tiered?: boolean;
    now?: () => number;
    healthyAccountsFor?: (lane: ProviderLaneId) => number | null | undefined;
  } = {},
) {
  const queues = new Map<ProviderLaneId, RecordingQueue>();
  for (const id of LANES) queues.set(id, new RecordingQueue());
  const lifecycle = new ProviderAdmissionLifecycle({
    lanes: LANES.map((id) => ({
      id,
      queue: queues.get(id)!,
      ...(options.tiered ? { baseTierCaps: { 1: 4, 2: 3, 3: 2, 4: 2 } } : {}),
    })),
    now: options.now ?? (() => 1_000),
    ...(options.healthyAccountsFor ? { healthyAccountsFor: options.healthyAccountsFor } : {}),
  });
  return { lifecycle, queues };
}

/** Drive `count` clean outcomes through one lane. */
function succeed(lifecycle: ProviderAdmissionLifecycle, lane: ProviderLaneId, count: number): void {
  for (let i = 0; i < count; i += 1) lifecycle.recordSuccess(lane);
}

/** Drive `count` throttles through one lane. */
/** `count` congested 429s that nothing routed around, each from its own (unkeyed) request. */
function throttle(lifecycle: ProviderAdmissionLifecycle, lane: ProviderLaneId, count: number): void {
  for (let i = 0; i < count; i += 1) {
    lifecycle.recordOutcome(lane, { kind: 'rate-limited', scope: 'transient', routedAround: false });
  }
}

describe.each(LANES)('provider admission lifecycle conformance — %s lane', (lane) => {
  it('publishes its starting window to the queue at registration', () => {
    const { lifecycle, queues } = makeLifecycle();
    expect(queues.get(lane)!.maxConcurrent).toBe(INITIAL_PROVIDER_ADMISSION_WINDOW);
    expect(lifecycle.windowFor(lane)).toBe(INITIAL_PROVIDER_ADMISSION_WINDOW);
  });

  it('starts both lanes from the SAME window — no provider-specific seed arithmetic', () => {
    const { lifecycle } = makeLifecycle();
    const windows = LANES.map((id) => lifecycle.windowFor(id));
    expect(new Set(windows).size).toBe(1);
    // Calibration: the assertion above is only meaningful if more than one lane exists.
    expect(LANES.length).toBeGreaterThan(1);
  });

  it('grows past every retired ceiling under sustained clean traffic', () => {
    const { lifecycle, queues } = makeLifecycle();
    succeed(lifecycle, lane, 400);

    const window = lifecycle.windowFor(lane);
    expect(window).toBeGreaterThan(INITIAL_PROVIDER_ADMISSION_WINDOW);
    expect(window).toBeGreaterThan(RETIRED_CLAUDE_DEFAULT_CONCURRENCY);
    expect(window).toBeGreaterThan(RETIRED_CODEX_SLOTS_PER_ACCOUNT);
    expect(queues.get(lane)!.maxConcurrent).toBe(window);

    // CALIBRATION: a lane that received no successes must still sit at the seed,
    // proving the growth above came from the recorded outcomes and not from a
    // lifecycle that simply publishes a large number.
    const other = LANES.find((id) => id !== lane)!;
    expect(lifecycle.windowFor(other)).toBe(INITIAL_PROVIDER_ADMISSION_WINDOW);
  });

  it('contracts multiplicatively under sustained throttling but never below the floor', () => {
    const { lifecycle } = makeLifecycle();
    succeed(lifecycle, lane, 400);
    const grown = lifecycle.windowFor(lane);

    throttle(lifecycle, lane, 6);
    const contracted = lifecycle.windowFor(lane);
    expect(contracted).toBeLessThan(grown);

    throttle(lifecycle, lane, 600);
    const floored = lifecycle.windowFor(lane);
    expect(floored).toBeGreaterThanOrEqual(1);
    expect(floored).toBe(lifecycle.snapshotFor(lane).minimumWindow);

    // CALIBRATION: the floor claim is vacuous unless a contraction actually ran.
    expect(lifecycle.snapshotFor(lane).contractions).toBeGreaterThan(0);
  });

  // WI-6554700010012367 (plan gateway-admission-congestion-only-2026-10-13 P-002, "a floor
  // sized to healthy accounts"): the 2026-10-13 incident pinned the Codex lane at a static
  // floor of 4 while more accounts than that were healthy and upstream answered in seconds.
  it('never contracts a lane below its count of healthy accounts', () => {
    const healthy = 12;
    const { lifecycle } = makeLifecycle({ healthyAccountsFor: (id) => (id === lane ? healthy : null) });
    succeed(lifecycle, lane, 400);
    expect(lifecycle.windowFor(lane)).toBeGreaterThan(healthy);

    throttle(lifecycle, lane, 600);
    expect(lifecycle.windowFor(lane)).toBe(healthy);
    expect(lifecycle.snapshotFor(lane).minimumWindow).toBe(healthy);
    // CALIBRATION: contractions really ran and stopped AT the healthy count.
    expect(lifecycle.snapshotFor(lane).contractions).toBeGreaterThan(0);

    // CONTROL: the identical storm with no healthy-account reader falls to the static
    // floor, below the healthy count, so the assertion above is not vacuous.
    const control = makeLifecycle();
    succeed(control.lifecycle, lane, 400);
    throttle(control.lifecycle, lane, 600);
    expect(control.lifecycle.windowFor(lane)).toBeLessThan(healthy);
  });

  it('treats an unknown, zero or throwing healthy-account reader as the configured floor', () => {
    const control = makeLifecycle();
    succeed(control.lifecycle, lane, 400);
    throttle(control.lifecycle, lane, 600);
    const staticFloor = control.lifecycle.windowFor(lane);

    const readers: Array<() => number | null | undefined> = [
      () => null,
      () => undefined,
      () => 0,
      () => Number.NaN,
      () => {
        throw new Error('pool unavailable');
      },
    ];
    for (const reader of readers) {
      const { lifecycle } = makeLifecycle({ healthyAccountsFor: reader });
      succeed(lifecycle, lane, 400);
      throttle(lifecycle, lane, 600);
      expect(lifecycle.windowFor(lane)).toBe(staticFloor);
      expect(lifecycle.snapshotFor(lane).contractions).toBeGreaterThan(0);
    }
  });

  it('absorbs an isolated throttle without contracting', () => {
    const { lifecycle } = makeLifecycle();
    const before = lifecycle.windowFor(lane);
    throttle(lifecycle, lane, 1);
    expect(lifecycle.windowFor(lane)).toBe(before);
    expect(lifecycle.snapshotFor(lane).contractions).toBe(0);
    // CALIBRATION: the throttle was genuinely recorded, it just did not trip.
    expect(lifecycle.snapshotFor(lane).pressure).toBe(1);
  });

  // WI-6554700010011426 (plan gateway-admission-congestion-only-2026-10-13 P-002):
  // the old contract was "contracts immediately when an admitted request dies hard",
  // and it pinned the Codex window at its floor while upstream answered in seconds.
  it('needs SUSTAINED transport failures across distinct requests before contracting', () => {
    const { lifecycle } = makeLifecycle();
    succeed(lifecycle, lane, 400);
    const grown = lifecycle.windowFor(lane);
    for (let request = 1; request <= 5; request += 1) {
      lifecycle.recordOutcome(lane, { kind: 'transport-failure' }, `req-${request}`);
    }
    expect(lifecycle.windowFor(lane)).toBe(grown);
    lifecycle.recordOutcome(lane, { kind: 'transport-failure' }, 'req-6');
    expect(lifecycle.windowFor(lane)).toBeLessThan(grown);
    expect(lifecycle.snapshotFor(lane).hardFailures).toBe(6);
  });

  it('removes at most a quarter of the window per contraction', () => {
    const { lifecycle } = makeLifecycle();
    succeed(lifecycle, lane, 400);
    const grown = lifecycle.windowFor(lane);
    throttle(lifecycle, lane, 6);
    const contracted = lifecycle.windowFor(lane);
    expect(contracted).toBeLessThan(grown);
    expect(contracted).toBeGreaterThanOrEqual(Math.ceil(grown * 0.75));
  });

  it('clamps a configured contraction fraction so it can never remove more than 25%', () => {
    const queue = new RecordingQueue();
    const lifecycle = new ProviderAdmissionLifecycle({
      lanes: [{ id: lane, queue }],
      initialWindow: 40,
      contractionFraction: 0.5,
      contractionThreshold: 1,
      now: () => 1_000,
    });
    throttle(lifecycle, lane, 1);
    expect(lifecycle.windowFor(lane)).toBe(30);
  });

  it('sheds tier caps against its own high-water mark, not a configured cap', () => {
    const { lifecycle, queues } = makeLifecycle({ tiered: true });
    succeed(lifecycle, lane, 400);
    const queue = queues.get(lane)!;
    const peak = lifecycle.snapshotFor(lane).observedPeak;
    // At the peak nothing is shed: the lane is running at the most it has held.
    expect(queue.tierCaps.get(4)).toBe(2);

    throttle(lifecycle, lane, 6);
    expect(lifecycle.snapshotFor(lane).observedPeak).toBe(peak);
    // Tier 1 is protected; the sheddable bands give up headroom first.
    expect(queue.tierCaps.get(1)).toBe(4);
    expect(queue.tierCaps.get(4)!).toBeLessThan(2);
  });

  it('reports a snapshot a status consumer can read', () => {
    const { lifecycle } = makeLifecycle();
    const snapshot = lifecycle.snapshot();
    expect(snapshot.schemaVersion).toBe(PROVIDER_ADMISSION_LIFECYCLE_SCHEMA_VERSION);
    expect(snapshot.lanes.map((l) => l.lane)).toEqual([...LANES]);
    expect(snapshot.lanes.find((l) => l.lane === lane)!.window).toBe(lifecycle.windowFor(lane));
  });
});

/**
 * WI-6554700010011426 — plan gateway-admission-congestion-only-2026-10-13 P-001/P-002
 * (the P-006 regression set for those items). Owner rule: only congestion shrinks
 * the window; an out-of-usage error blocks the ACCOUNT and leaves the window alone;
 * when it does shrink, be less aggressive; Claude and Codex follow the same rule.
 */
describe.each(LANES)('congestion-only admission policy — %s lane', (lane) => {
  it('one request with N failover attempts adds congestion pressure ONCE', () => {
    const { lifecycle } = makeLifecycle();
    for (let attempt = 0; attempt < 12; attempt += 1) {
      lifecycle.recordOutcome(lane, { kind: 'transport-failure' }, 'one-huge-prompt');
    }
    const snap = lifecycle.snapshotFor(lane);
    expect(snap.pressure).toBe(1);
    expect(snap.hardFailures).toBe(1);
    expect(snap.dedupedCongestion).toBe(11);
    expect(snap.contractions).toBe(0);
  });

  it('an out-of-usage / weekly-wall 429 leaves the window unchanged, however many arrive', () => {
    const { lifecycle } = makeLifecycle();
    succeed(lifecycle, lane, 100);
    const before = lifecycle.windowFor(lane);
    for (let request = 0; request < 50; request += 1) {
      const verdict = lifecycle.recordOutcome(
        lane,
        { kind: 'rate-limited', scope: 'account', routedAround: false },
        `walled-${request}`,
      );
      expect(verdict).toBe('account-scoped');
    }
    expect(lifecycle.windowFor(lane)).toBe(before);
    expect(lifecycle.snapshotFor(lane).pressure).toBe(0);
    expect(lifecycle.snapshotFor(lane).accountScopedOutcomes).toBe(50);
  });

  it('a 429 that was failed over to another account is neutral', () => {
    const { lifecycle } = makeLifecycle();
    for (let request = 0; request < 20; request += 1) {
      lifecycle.recordOutcome(lane, { kind: 'rate-limited', scope: 'transient', routedAround: true }, `r-${request}`);
    }
    expect(lifecycle.snapshotFor(lane).pressure).toBe(0);
    expect(lifecycle.snapshotFor(lane).neutralOutcomes).toBe(20);
    expect(lifecycle.snapshotFor(lane).contractions).toBe(0);
  });

  it('a few large-prompt timeouts, each failing over many times, leave the window open', () => {
    // The 2026-10-13 incident: a handful of huge prompts hit the TTFB deadline on
    // every account they failed over to, while ordinary traffic kept succeeding.
    const { lifecycle } = makeLifecycle();
    succeed(lifecycle, lane, 100);
    const before = lifecycle.windowFor(lane);
    for (const prompt of ['big-1', 'big-2', 'big-3', 'big-4']) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        lifecycle.recordOutcome(lane, { kind: 'transport-failure' }, prompt);
        lifecycle.recordSuccess(lane);
      }
    }
    expect(lifecycle.windowFor(lane)).toBeGreaterThanOrEqual(before);
    expect(lifecycle.snapshotFor(lane).contractions).toBe(0);
  });

  it('a many-request herd (the 2026-10-12 mass resume) still contracts', () => {
    const { lifecycle } = makeLifecycle();
    succeed(lifecycle, lane, 400);
    const grown = lifecycle.windowFor(lane);
    for (let request = 0; request < 200; request += 1) {
      lifecycle.recordOutcome(lane, { kind: 'transport-failure' }, `herd-${request}`);
    }
    const snap = lifecycle.snapshotFor(lane);
    expect(snap.window).toBeLessThan(grown);
    expect(snap.contractions).toBeGreaterThan(1);
  });

  it('recovers on every clean success while demand is queued and pressure is zero', () => {
    const queue = new RecordingQueue() as RecordingQueue & { size: number };
    queue.size = 120;
    const lifecycle = new ProviderAdmissionLifecycle({ lanes: [{ id: lane, queue }], now: () => 1_000 });
    const start = lifecycle.windowFor(lane);
    succeed(lifecycle, lane, 10);
    expect(lifecycle.windowFor(lane)).toBe(start + 10);
    // CALIBRATION: with nothing waiting, growth is back to one step per clean run.
    queue.size = 0;
    succeed(lifecycle, lane, 10);
    expect(lifecycle.windowFor(lane)).toBe(start + 10 + 2);
  });

  it('does not take the fast path while congestion pressure is outstanding', () => {
    const queue = new RecordingQueue() as RecordingQueue & { size: number };
    queue.size = 120;
    const lifecycle = new ProviderAdmissionLifecycle({ lanes: [{ id: lane, queue }], now: () => 1_000 });
    const start = lifecycle.windowFor(lane);
    throttle(lifecycle, lane, 3);
    succeed(lifecycle, lane, 2);
    expect(lifecycle.windowFor(lane)).toBe(start);
  });

  it('forgets a request mark after its TTL, so the map stays bounded', () => {
    let now = 1_000;
    const { lifecycle } = makeLifecycle({ now: () => now });
    lifecycle.recordOutcome(lane, { kind: 'transport-failure' }, 'stale');
    succeed(lifecycle, lane, 1);
    now += 31 * 60_000;
    lifecycle.recordOutcome(lane, { kind: 'transport-failure' }, 'stale');
    expect(lifecycle.snapshotFor(lane).hardFailures).toBe(2);
  });
});

describe('provider outcome isolation', () => {
  it('keeps one provider’s throttle storm off every other lane', () => {
    const { lifecycle } = makeLifecycle();
    succeed(lifecycle, 'claude', 400);
    succeed(lifecycle, 'codex', 400);
    const claudeBefore = lifecycle.windowFor('claude');
    const codexBefore = lifecycle.windowFor('codex');
    expect(claudeBefore).toBe(codexBefore);

    throttle(lifecycle, 'codex', 60);

    // FALSIFIER: the retired design fed both providers' outcomes into one
    // controller, so a Codex storm moved the Claude queue. If the lanes ever
    // share evidence again this assertion fails.
    expect(lifecycle.windowFor('claude')).toBe(claudeBefore);
    expect(lifecycle.windowFor('codex')).toBeLessThan(codexBefore);
    expect(lifecycle.snapshotFor('claude').contractions).toBe(0);
    // CALIBRATION: the storm was real.
    expect(lifecycle.snapshotFor('codex').contractions).toBeGreaterThan(0);
  });

  it('lets one lane grow while another is contracted', () => {
    const { lifecycle } = makeLifecycle();
    throttle(lifecycle, 'codex', 60);
    succeed(lifecycle, 'claude', 400);
    expect(lifecycle.windowFor('claude')).toBeGreaterThan(RETIRED_CLAUDE_DEFAULT_CONCURRENCY);
    expect(lifecycle.windowFor('codex')).toBe(lifecycle.snapshotFor('codex').minimumWindow);
  });
});

describe('hermetic by construction (EI-21746976692199819 recurrence guard)', () => {
  it('does not share admission state between two lifecycles in one process', () => {
    const first = makeLifecycle();
    const second = makeLifecycle();

    succeed(first.lifecycle, 'claude', 400);
    throttle(second.lifecycle, 'claude', 60);

    // Neither instance may observe the other's window. An ambient module-scoped
    // gate — the coupling that made governor-causal-lane-scoping.test.ts flaky
    // under parallel execution — fails here deterministically instead of once
    // every few runs.
    expect(first.lifecycle.windowFor('claude')).toBeGreaterThan(RETIRED_CLAUDE_DEFAULT_CONCURRENCY);
    expect(second.lifecycle.windowFor('claude')).toBe(second.lifecycle.snapshotFor('claude').minimumWindow);
    expect(first.queues.get('claude')!.maxConcurrent).not.toBe(second.queues.get('claude')!.maxConcurrent);
  });

  it('reads only the injected clock', () => {
    let ticks = 0;
    const { lifecycle } = makeLifecycle({
      now: () => {
        ticks += 1;
        return 5_000;
      },
    });
    succeed(lifecycle, 'claude', 400);
    expect(ticks).toBeGreaterThan(0);
    expect(lifecycle.snapshotFor('claude').lastChangeAtMs).toBe(5_000);
  });
});

describe('registration contract', () => {
  it('refuses a lane registered twice', () => {
    expect(
      () =>
        new ProviderAdmissionLifecycle({
          lanes: [
            { id: 'claude', queue: new RecordingQueue() },
            { id: 'claude', queue: new RecordingQueue() },
          ],
        }),
    ).toThrow(/registered twice/);
  });

  it('refuses an unregistered lane rather than inventing a window', () => {
    const lifecycle = new ProviderAdmissionLifecycle({
      lanes: [{ id: 'claude', queue: new RecordingQueue() }],
    });
    expect(() => lifecycle.windowFor('codex')).toThrow(/not registered/);
  });

  it('opens at exactly the requested seed, never rounded UP to meet a larger default floor', () => {
    // REGRESSION (found by gateway-priority-tiers.test.ts hanging): the default floor is
    // sized for a large pool, so `max(floor, seed)` silently handed a caller that asked
    // for 2 slots a 4-slot queue. A test reserving 1 of 2 slots then saw three requests
    // admitted and waited forever. A floor is a MINIMUM the window contracts to, never a
    // reason to enlarge what the caller opened with.
    const queue = new RecordingQueue();
    const lifecycle = new ProviderAdmissionLifecycle({
      lanes: [{ id: 'claude', queue }],
      initialWindow: 2,
      // deliberately larger than the seed, exactly like the production default
      minimumWindow: 4,
    });
    expect(lifecycle.windowFor('claude')).toBe(2);
    expect(queue.maxConcurrent).toBe(2);
    // The floor is clamped DOWN to the seed rather than the seed being raised.
    expect(lifecycle.snapshotFor('claude').minimumWindow).toBe(2);
    // CALIBRATION: an un-clamped floor would have produced 4 here.
    expect(queue.maxConcurrent).not.toBe(4);
  });

  it('treats an explicit seed as initial state, not a ceiling', () => {
    const queue = new RecordingQueue();
    const lifecycle = new ProviderAdmissionLifecycle({
      lanes: [{ id: 'claude', queue }],
      initialWindow: 3,
      minimumWindow: 2,
    });
    expect(lifecycle.windowFor('claude')).toBe(3);
    succeed(lifecycle, 'claude', 200);
    // FALSIFIER: a seed that behaved as a cap would pin this at 3.
    expect(lifecycle.windowFor('claude')).toBeGreaterThan(3);
  });

  /**
   * RECURRENCE GUARD for EI-21842988251907640.
   *
   * `contractions`/`expansions` are monotonic for the life of the PROCESS, not of the deployment: a lane is
   * registered once and never evicted, so they reset only when the gateway restarts. They surface on GET
   * /stats as `aimd.decreases`/`aimd.increases`, whose shared type once documented them as LIFETIME counts.
   * A reader therefore took `decreases: 0` on a freshly-restarted gateway to mean "this lane has never
   * contracted". `countersSinceMs` is the epoch that makes the scope readable AT THE READ SITE.
   *
   * This case reproduces the misreading rather than merely asserting the field exists: deleting
   * `countersSinceMs` makes it fail to compile/assert, and — more importantly — the two lifecycles below are
   * INDISTINGUISHABLE on the counters alone, which is precisely why the epoch has to be published.
   */
  it('publishes the counter epoch, so a post-restart 0 cannot be read as "never contracted"', () => {
    const before = makeLifecycle({ now: () => 1_000 });
    throttle(before.lifecycle, 'claude', 6);
    const contracted = before.lifecycle.snapshotFor('claude');
    expect(contracted.contractions).toBeGreaterThan(0);
    expect(contracted.countersSinceMs).toBe(1_000);

    // A RESTART: same lane, brand-new process, counters back at zero.
    const after = makeLifecycle({ now: () => 9_000 });
    const restarted = after.lifecycle.snapshotFor('claude');
    expect(restarted.contractions).toBe(0);

    // THE CONTROL that makes this test worth having: a lane that has genuinely never contracted in a
    // long-running process is ALSO at 0, so the counter alone cannot separate the two cases...
    const neverContracted = makeLifecycle({ now: () => 1_000 }).lifecycle.snapshotFor('claude');
    expect(neverContracted.contractions).toBe(restarted.contractions);
    // ...and the epoch is the only thing that does. If this assertion is deleted or the field removed, the
    // ambiguity that caused EI-21842988251907640 is silently back.
    expect(restarted.countersSinceMs).not.toBe(neverContracted.countersSinceMs);
    expect(restarted.countersSinceMs).toBe(9_000);
  });
});
