/**
 * ONE capless admission lifecycle for every provider lane
 * (capless-inference-gateway-2026-08-28, P-010).
 *
 * WHAT THIS REPLACES. The gateway used to run two structurally identical but
 * separately-written admission controllers: a Claude one seeded from a baked
 * `DEFAULT_CONCURRENCY = 24`, and a Codex one seeded from an account-scaled
 * slot formula (`accountScaledCodexConcurrency`) clamped to Claude's configured
 * concurrency, each with its own AIMD controller, its own `applyAdmissionCap`
 * closure, its own floor derivation and its own tier-shedding call. That is the
 * "parallel Claude-default / Codex-special capacity logic" P-010's acceptance
 * forbids: two policies that had to be kept in sync by hand and drifted (the
 * Codex floor silently derived a DIFFERENT floor from the same `deps.aimd`
 * input, and the Codex lane clamped to `min(codexConcurrency, eff)` while the
 * Claude lane did not).
 *
 * WHAT REPLACES IT. One policy implementation, instantiated once, holding one
 * record per lane. Lanes share the CODE PATH and the POLICY; they do not share
 * EVIDENCE. A Codex 429 moves the Codex window and nothing else, which is the
 * "provider-specific outcomes remain isolated" half of the same acceptance
 * criterion. Adding a third provider lane is a registration, not a new
 * controller.
 *
 * WHY IT IS CAPLESS. The window is an unbounded AIMD target: it has a floor and
 * intentionally no maximum, mirroring `CaplessAdaptiveController`'s
 * `desiredWindow`. `initialWindow` is INITIAL STATE, never a ceiling (plan
 * D-002) — a lane whose traffic stays clean grows past whatever it started at,
 * which is what "stable demand grows beyond former ceilings" requires. Nothing
 * in this module reads an environment variable or a configured maximum; a
 * bootstrap number can only ever set where a cold lane STARTS.
 *
 * WHY TIER SHEDDING NO LONGER NEEDS A CAP. Shedding used to be sized as
 * `configuredCap - effective`. With no configured cap the reference point is
 * the lane's OWN high-water mark — evidence the lane produced rather than a
 * number an operator typed. Same shape, same behaviour on the way down, and it
 * keeps working once the window has grown past its seed.
 *
 * HERMETIC BY CONSTRUCTION. Every mutable value lives on the instance and the
 * clock is injected. There are no module-scoped `let` bindings, so two
 * lifecycles in one process (two tests, or a test beside a live gateway) cannot
 * observe each other's windows. That property is asserted directly in the
 * sibling test rather than left to convention — an ambient-state coupling of
 * exactly this kind is what made `governor-causal-lane-scoping.test.ts` flaky
 * under parallel execution (EI-21746976692199819), and the fix there is the
 * same one applied here: bind the gate to the instance, inject the clock.
 */

import { shedTierCaps } from '@papercusp/papercusp-shared/agent';

import { classifyUpstreamOutcome, type UpstreamOutcome, type UpstreamOutcomeClass } from './upstream-outcome-classifier';

/** Provider lanes that admit real upstream inference work. */
export type ProviderLaneId = 'claude' | 'codex';

/**
 * Identifies ONE client request across all of its failover attempts, so the
 * request adds congestion pressure at most once (plan D-001). The gateway passes
 * the request span's id.
 */
export type UpstreamRequestKey = string | number;

/**
 * The only thing the lifecycle needs from a queue. Narrow on purpose: it keeps
 * `PriorityAdmissionQueue` out of this module's type surface, so a unit test
 * registers a two-method stub and a future lane can be backed by something else
 * entirely.
 */
export interface ProviderLaneQueue {
  setMaxConcurrent(n: number): void;
  setTierCap(tier: number, cap: number): void;
  /**
   * Requests WAITING for a slot (`PriorityAdmissionQueue.size`). Optional: a lane
   * that cannot report it simply never takes the deep-queue recovery path.
   */
  readonly size?: number;
}

export interface ProviderLaneRegistration {
  readonly id: ProviderLaneId;
  readonly queue: ProviderLaneQueue;
  /**
   * Steady-state per-tier in-flight caps this lane sheds from, when the
   * priority-tier layer is active. Omitted/empty ⇒ flat queue, and every tier
   * call below is skipped (flag-OFF behaviour stays byte-identical).
   */
  readonly baseTierCaps?: Readonly<Record<number, number>>;
}

/**
 * Window policy. Identical for every lane by construction — the whole point of
 * P-010 is that a provider cannot carry its own capacity arithmetic — so these
 * are lifecycle-wide, not per-lane, options.
 */
export interface ProviderAdmissionWindowPolicy {
  /**
   * Where a COLD lane starts. Initial state, never a ceiling (D-002): the lane
   * grows past it whenever traffic stays clean.
   */
  readonly initialWindow?: number;
  /** Never contract below this. Clamped to >= 1. */
  readonly minimumWindow?: number;
  /** Additive-increase step earned per clean run. */
  readonly increaseStep?: number;
  /** Consecutive clean successes that earn ONE additive increase. */
  readonly healthySamplesPerIncrease?: number;
  /**
   * Multiplicative-decrease factor applied when congestion pressure trips. Clamped
   * to at least {@link MIN_CONTRACTION_FRACTION}: one contraction removes at most a
   * quarter of the window (owner directive #1830: "be less aggressive").
   */
  readonly contractionFraction?: number;
  /**
   * Net congestion pressure (distinct congested requests minus successes, floored
   * at 0) that trips ONE contraction. A leaky bucket, so a lone transient 429 or a
   * lone slow prompt among successes never shrinks a lane.
   */
  readonly contractionThreshold?: number;
}

export interface ProviderAdmissionLifecycleOptions extends ProviderAdmissionWindowPolicy {
  readonly lanes: readonly ProviderLaneRegistration[];
  /**
   * Live count of healthy (serviceable, non-walled) accounts on a lane, or null when
   * unknown. A contraction never takes a lane below this count, so congestion can
   * never throttle a lane to fewer requests than it has usable accounts
   * (plan gateway-admission-congestion-only-2026-10-13#P-002, "a floor sized to
   * healthy accounts"; WI-6554700010012367). It is read at contraction time only:
   * it never raises a window, and null, zero or a count at or below
   * `minimumWindow` leaves the configured floor in charge.
   */
  readonly healthyAccountsFor?: (lane: ProviderLaneId) => number | null | undefined;
  /** Injected clock. Present so the lifecycle never reads an ambient one. */
  readonly now?: () => number;
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/** Per-lane observability, surfaced on `/stats`. */
export interface ProviderLaneWindowSnapshot {
  readonly lane: ProviderLaneId;
  /** The live admission window this lane is running at. */
  readonly window: number;
  /** Highest window this lane has ever held — evidence, not a configured cap. */
  readonly observedPeak: number;
  readonly minimumWindow: number;
  /** Leaky-bucket throttle pressure; resets each time it trips a contraction. */
  readonly pressure: number;
  /** Clean-success progress toward the next additive increase. */
  readonly cleanStreak: number;
  readonly contractions: number;
  readonly expansions: number;
  /** Requests whose transport failure added congestion pressure (once per request). */
  readonly hardFailures: number;
  /** Outcomes the classifier ruled account-scoped (out-of-usage, weekly wall, auth): the window ignored them. */
  readonly accountScopedOutcomes: number;
  /** Outcomes the classifier ruled neutral (routed-around 429, client error, cancel). */
  readonly neutralOutcomes: number;
  /** Congestion outcomes dropped because the same request had already added its one unit of pressure. */
  readonly dedupedCongestion: number;
  /** EPOCH for `contractions` / `expansions` / `hardFailures`: epoch-ms of this lane's REGISTRATION.
   *
   *  These counters are monotonic for the life of the PROCESS, not for the life of the deployment: a lane
   *  is registered exactly once per `ProviderAdmissionLifecycle` (`#register` throws on a duplicate) and is
   *  never evicted, so they only ever reset when the gateway process restarts. Publishing the epoch is what
   *  stops a consumer reading `contractions: 0` on a freshly-restarted gateway as "this lane has never
   *  contracted" — the misreading recorded in EI-21842988251907640. */
  readonly countersSinceMs: number;
  readonly lastChangeAtMs: number | null;
}

export interface ProviderAdmissionLifecycleSnapshot {
  readonly schemaVersion: typeof PROVIDER_ADMISSION_LIFECYCLE_SCHEMA_VERSION;
  readonly lanes: readonly ProviderLaneWindowSnapshot[];
}

export const PROVIDER_ADMISSION_LIFECYCLE_SCHEMA_VERSION = 'provider-admission-lifecycle-v1' as const;

/**
 * Where a cold provider lane starts when the caller supplies no seed.
 *
 * This is the ONLY number in the capless gateway that resembles the retired
 * `DEFAULT_CONCURRENCY = 24`, and the difference is the whole point: it is a
 * starting position both lanes share, not a maximum either lane is held to, and
 * not a per-provider formula. A lane that never sees a throttle leaves it
 * behind within minutes of steady traffic.
 */
export const INITIAL_PROVIDER_ADMISSION_WINDOW = 8;

const DEFAULT_MINIMUM_WINDOW = 4;
const DEFAULT_INCREASE_STEP = 1;
const DEFAULT_HEALTHY_SAMPLES_PER_INCREASE = 5;
/**
 * The smallest fraction of the window a contraction may keep: one contraction
 * removes at most 25% (WI-6554700010011426). The old 0.5 halved the window on every
 * trip, so a few slow prompts pinned the Codex lane at its floor of 4 with 100+
 * requests queued while upstream answered in seconds.
 */
export const MIN_CONTRACTION_FRACTION = 0.75;
const DEFAULT_CONTRACTION_FRACTION = MIN_CONTRACTION_FRACTION;
const DEFAULT_CONTRACTION_THRESHOLD = 6;
/**
 * How long a request's "already pressured" mark is remembered. It must outlive one
 * request's whole failover ladder (several TTFB deadlines back to back); after that
 * the mark is only memory.
 */
const PRESSURED_REQUEST_TTL_MS = 30 * 60_000;
/** Hard bound on remembered request keys per lane, so a herd cannot grow the map without limit. */
const PRESSURED_REQUEST_MAX_KEYS = 8_192;

function positiveInt(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback;
}

function fraction(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 && value < 1 ? value : fallback;
}

interface LaneState {
  readonly id: ProviderLaneId;
  readonly queue: ProviderLaneQueue;
  readonly baseTierCaps: Record<number, number>;
  readonly tiered: boolean;
  window: number;
  observedPeak: number;
  pressure: number;
  cleanStreak: number;
  contractions: number;
  expansions: number;
  hardFailures: number;
  accountScopedOutcomes: number;
  neutralOutcomes: number;
  dedupedCongestion: number;
  /** Requests that already added their one unit of congestion pressure → epoch-ms they did (insertion-ordered). */
  readonly pressuredRequests: Map<UpstreamRequestKey, number>;
  /** Epoch-ms at which this lane was registered — the reset point for the counters above. */
  readonly countersSinceMs: number;
  lastChangeAtMs: number | null;
}

/**
 * One lifecycle, many lanes. Construct it once per gateway and register every
 * provider queue on it; never construct one per provider (that is the duplicate
 * state this class exists to delete).
 */
export class ProviderAdmissionLifecycle {
  readonly #lanes = new Map<ProviderLaneId, LaneState>();
  readonly #now: () => number;
  readonly #log: (level: 'info' | 'warn' | 'error', message: string) => void;
  readonly #minimumWindow: number;
  readonly #healthyAccountsFor: ((lane: ProviderLaneId) => number | null | undefined) | undefined;
  readonly #initialWindow: number;
  readonly #increaseStep: number;
  readonly #healthySamplesPerIncrease: number;
  readonly #contractionFraction: number;
  readonly #contractionThreshold: number;

  constructor(options: ProviderAdmissionLifecycleOptions) {
    this.#now = options.now ?? (() => Date.now());
    this.#log = options.log ?? (() => {});
    // A FLOOR MAY NEVER EXCEED THE STARTING WINDOW. A default floor sized for a
    // 24-slot pool is nonsense over a 2-slot one, and raising the caller's seed to
    // meet it would silently hand back a bigger window than was asked for — the kind
    // of quiet override that makes an admission bug impossible to read off the call
    // site. The retired Codex controller clamped its floor this way (`min(cap-1,
    // floor)`) and the Claude one did not; that asymmetry was the drift, and this is
    // the half of it that was right.
    this.#initialWindow = positiveInt(options.initialWindow, INITIAL_PROVIDER_ADMISSION_WINDOW);
    this.#minimumWindow = Math.min(
      positiveInt(options.minimumWindow, DEFAULT_MINIMUM_WINDOW),
      this.#initialWindow,
    );
    this.#increaseStep = positiveInt(options.increaseStep, DEFAULT_INCREASE_STEP);
    this.#healthySamplesPerIncrease = positiveInt(
      options.healthySamplesPerIncrease,
      DEFAULT_HEALTHY_SAMPLES_PER_INCREASE,
    );
    this.#contractionFraction = Math.max(
      MIN_CONTRACTION_FRACTION,
      fraction(options.contractionFraction, DEFAULT_CONTRACTION_FRACTION),
    );
    this.#contractionThreshold = positiveInt(options.contractionThreshold, DEFAULT_CONTRACTION_THRESHOLD);
    this.#healthyAccountsFor = options.healthyAccountsFor;

    for (const lane of options.lanes) this.#register(lane);
  }

  /**
   * The floor a contraction respects on one lane: the configured minimum, raised to
   * the lane's live healthy-account count when that count is known and larger. A
   * throwing or non-finite reader is treated as unknown, never as zero.
   */
  #floorFor(lane: ProviderLaneId): number {
    let healthy: number | null | undefined;
    try {
      healthy = this.#healthyAccountsFor?.(lane);
    } catch {
      healthy = null;
    }
    return typeof healthy === 'number' && Number.isFinite(healthy) && healthy > this.#minimumWindow
      ? Math.floor(healthy)
      : this.#minimumWindow;
  }

  #register(registration: ProviderLaneRegistration): void {
    if (this.#lanes.has(registration.id)) {
      throw new Error(`provider-admission-lifecycle: lane ${registration.id} registered twice`);
    }
    const baseTierCaps: Record<number, number> = { ...(registration.baseTierCaps ?? {}) };
    const state: LaneState = {
      id: registration.id,
      queue: registration.queue,
      baseTierCaps,
      tiered: Object.keys(baseTierCaps).length > 0,
      window: this.#initialWindow,
      observedPeak: this.#initialWindow,
      pressure: 0,
      cleanStreak: 0,
      contractions: 0,
      expansions: 0,
      hardFailures: 0,
      accountScopedOutcomes: 0,
      neutralOutcomes: 0,
      dedupedCongestion: 0,
      pressuredRequests: new Map(),
      // The counters above start at zero HERE, so registration time is their epoch. Recorded rather than
      // inferred so a reader never has to guess whether a 0 means "never" or "not since this process".
      // Uses the injected clock (assigned first in the constructor, before any #register call) rather than
      // Date.now(), so the epoch is deterministic under test like every other timestamp this class emits.
      countersSinceMs: this.#now(),
      lastChangeAtMs: null,
    };
    this.#lanes.set(registration.id, state);
    // Publish the starting window immediately so a lane never serves traffic at
    // whatever its queue was constructed with.
    this.#apply(state);
  }

  #lane(id: ProviderLaneId): LaneState {
    const lane = this.#lanes.get(id);
    if (!lane) throw new Error(`provider-admission-lifecycle: lane ${id} is not registered`);
    return lane;
  }

  /**
   * Push a lane's window onto its queue and re-derive its tier caps.
   *
   * Shedding is sized against the lane's own high-water mark rather than a
   * configured cap: `observedPeak - window` is how far this lane has pulled
   * back from the most it has ever sustained.
   */
  #apply(lane: LaneState): void {
    const window = Math.max(this.#minimumWindow, Math.floor(lane.window));
    lane.window = window;
    if (window > lane.observedPeak) lane.observedPeak = window;
    lane.queue.setMaxConcurrent(window);
    if (!lane.tiered) return;
    const shed = shedTierCaps(lane.baseTierCaps, lane.observedPeak - window);
    for (const [tier, cap] of Object.entries(shed)) lane.queue.setTierCap(Number(tier), cap);
  }

  /**
   * A clean upstream outcome on this lane.
   *
   * Recovery is FASTER while demand is waiting and nothing is congested: with
   * requests queued for a slot and zero pressure, every clean success earns an
   * increase, not every Nth. A lane contracted by a passing burst therefore
   * reopens at the rate its own successes prove capacity, instead of crawling back
   * one slot per `healthySamplesPerIncrease` successes while 100+ requests wait.
   */
  recordSuccess(id: ProviderLaneId): void {
    const lane = this.#lane(id);
    if (lane.pressure > 0) lane.pressure -= 1;
    lane.cleanStreak += 1;
    const demandWaiting = lane.pressure === 0 && (lane.queue.size ?? 0) > 0;
    if (!demandWaiting && lane.cleanStreak < this.#healthySamplesPerIncrease) return;
    lane.cleanStreak = 0;
    lane.expansions += 1;
    lane.lastChangeAtMs = this.#now();
    lane.window += this.#increaseStep;
    this.#apply(lane);
    this.#log(
      'info',
      `inference-gateway: ${id} admission window → ${lane.window} (capless expansion${demandWaiting ? ', demand waiting' : ''}, peak ${lane.observedPeak})`,
    );
  }

  /**
   * THE entry point for every non-success upstream outcome, on every lane
   * (P-001). The shared classifier decides what the window hears:
   *
   *  - `account-scoped` (out-of-usage, weekly wall, auth) — counted, never shrinks
   *    the window: the account is parked by the router, not by admission;
   *  - `neutral` (a routed-around 429, a client error, a cancel) — counted only;
   *  - `congestion` (a 429 nothing could route around, a transport/TTFB failure) —
   *    adds pressure, at most ONCE per request (`requestKey`, plan D-001), and the
   *    window contracts only once that pressure is SUSTAINED across
   *    `contractionThreshold` distinct requests net of successes (P-002);
   *  - `success` — same as {@link recordSuccess}.
   *
   * A missing `requestKey` means the caller cannot identify the request; each
   * such outcome then counts on its own (it still needs the sustained threshold).
   */
  recordOutcome(id: ProviderLaneId, outcome: UpstreamOutcome, requestKey?: UpstreamRequestKey): UpstreamOutcomeClass {
    const lane = this.#lane(id);
    const verdict = classifyUpstreamOutcome(outcome);
    switch (verdict) {
      case 'success':
        this.recordSuccess(id);
        break;
      case 'account-scoped':
        lane.accountScopedOutcomes += 1;
        break;
      case 'neutral':
        lane.neutralOutcomes += 1;
        break;
      case 'congestion':
        this.#addCongestion(lane, outcome.kind === 'transport-failure', requestKey);
        break;
    }
    return verdict;
  }

  #addCongestion(lane: LaneState, transport: boolean, requestKey: UpstreamRequestKey | undefined): void {
    if (requestKey !== undefined) {
      const now = this.#now();
      this.#prunePressured(lane, now);
      if (lane.pressuredRequests.has(requestKey)) {
        // The same request failing over again is ONE slow request, not more
        // congestion: this is what stops a few huge prompts walking the window
        // down one failover attempt at a time.
        lane.dedupedCongestion += 1;
        return;
      }
      lane.pressuredRequests.set(requestKey, now);
    }
    if (transport) lane.hardFailures += 1;
    lane.pressure += 1;
    if (lane.pressure < this.#contractionThreshold) return;
    this.#contract(lane, transport ? 'sustained upstream transport failures' : 'sustained upstream throttle');
  }

  #prunePressured(lane: LaneState, now: number): void {
    const marks = lane.pressuredRequests;
    for (const [key, at] of marks) {
      // Insertion-ordered, so the first live entry ends the sweep.
      if (now - at <= PRESSURED_REQUEST_TTL_MS && marks.size < PRESSURED_REQUEST_MAX_KEYS) break;
      marks.delete(key);
    }
  }

  #contract(lane: LaneState, reason: string): void {
    lane.pressure = 0;
    lane.cleanStreak = 0;
    // Round UP so one contraction never removes more than the configured share;
    // but always remove at least one slot, or a small window could never contract.
    // Never below the lane's healthy-account floor (P-002).
    const floor = this.#floorFor(lane.id);
    const next = Math.max(
      floor,
      Math.min(lane.window - 1, Math.ceil(lane.window * this.#contractionFraction)),
    );
    if (next >= lane.window) return;
    lane.contractions += 1;
    lane.lastChangeAtMs = this.#now();
    lane.window = next;
    this.#apply(lane);
    this.#log(
      'warn',
      `inference-gateway: ${lane.id} admission window → ${lane.window} (${reason}; floor ${floor}, peak ${lane.observedPeak})`,
    );
  }

  /** The live admission window for one lane. */
  windowFor(id: ProviderLaneId): number {
    return this.#lane(id).window;
  }

  /** Registered lane ids, in registration order. */
  lanes(): readonly ProviderLaneId[] {
    return [...this.#lanes.keys()];
  }

  snapshotFor(id: ProviderLaneId): ProviderLaneWindowSnapshot {
    const lane = this.#lane(id);
    return Object.freeze({
      lane: lane.id,
      window: lane.window,
      observedPeak: lane.observedPeak,
      minimumWindow: this.#floorFor(lane.id),
      pressure: lane.pressure,
      cleanStreak: lane.cleanStreak,
      contractions: lane.contractions,
      expansions: lane.expansions,
      hardFailures: lane.hardFailures,
      accountScopedOutcomes: lane.accountScopedOutcomes,
      neutralOutcomes: lane.neutralOutcomes,
      dedupedCongestion: lane.dedupedCongestion,
      countersSinceMs: lane.countersSinceMs,
      lastChangeAtMs: lane.lastChangeAtMs,
    });
  }

  snapshot(): ProviderAdmissionLifecycleSnapshot {
    return Object.freeze({
      schemaVersion: PROVIDER_ADMISSION_LIFECYCLE_SCHEMA_VERSION,
      lanes: [...this.#lanes.keys()].map((id) => this.snapshotFor(id)),
    });
  }
}
