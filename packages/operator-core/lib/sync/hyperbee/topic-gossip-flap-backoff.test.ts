/**
 * topic-gossip-flap-backoff.test.ts — EI-18808621019872598.
 *
 * The fast-window re-arm in topic-gossip's channel `onclose` was an unbounded
 * amplifier: it re-armed `fastWindowStartMs` to NOW on EVERY last-channel
 * close, and escaping the fast cadence back to the slow keepalive requires
 * `fastWindowMs` of CONTINUOUSLY-open channel — so a link whose channel dies
 * within `refreshMs` re-armed before the window could ever lapse and the
 * refresh loop re-ran a full DHT round every `refreshMs`, forever, with zero
 * backoff. Measured live 2026-08-08: 5,494 connection resets in 188 minutes,
 * 100% on ONE topic (`papercusp/hive-presence`), rate-matched to the 2500ms
 * DEFAULT_REFRESH_MS (48/min predicted vs 46-48/min observed). Because every
 * topic muxes over one socket per peer key, that storm also tore down
 * unrelated bulk transfers riding the same socket.
 *
 * The fix must hold BOTH ends, which is why the first test here is as
 * load-bearing as the rest: the re-arm exists so a healthy link that drops
 * reconnects snappily, so simply deleting it would arm the opposite failure.
 *   1. a SINGLE last-peer loss still grants the full fast window (unchanged);
 *   2. CONSECUTIVE flap-closes decay it toward the slow keepalive;
 *   3. a genuinely-useful channel resets the ladder;
 *   4. `minUsefulChannelMs: 0` restores the pre-fix behavior exactly — which
 *      also serves as this suite's CONTROL: it proves these assertions can
 *      actually see the storm they claim to prevent.
 *
 * Same fake-Protomux + fake-swarm convention as
 * topic-gossip-severed-link-escalation.test.ts, plus a refresh recorder (the
 * observable the storm is measured in).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface FakeChannel {
  protocol: string;
  id: Buffer | null;
  onopen?: () => void;
  onclose?: (isRemote: boolean) => void;
  closed: boolean;
  open(): void;
  pairRemote(): void;
  fireClose(isRemote?: boolean): void;
}
interface FakeMux {
  channels: FakeChannel[];
  createChannel(spec: {
    protocol: string;
    id?: Buffer | null;
    onopen?: () => void;
    onclose?: (isRemote: boolean) => void;
  }): FakeChannel | null;
  pair(opts: { protocol: string }, notify: (id: Buffer | null) => void | Promise<void>): void;
}
function makeMux(): FakeMux {
  const mux: FakeMux = {
    channels: [],
    createChannel(spec) {
      const key = `${spec.protocol}::${spec.id ? spec.id.toString('hex') : ''}`;
      const dup = mux.channels.find(
        (ch) => !ch.closed && `${ch.protocol}::${ch.id ? ch.id.toString('hex') : ''}` === key,
      );
      if (dup) return null;
      const ch: FakeChannel = {
        protocol: spec.protocol,
        id: spec.id ?? null,
        onopen: spec.onopen,
        onclose: spec.onclose,
        closed: false,
        open() {},
        pairRemote() {
          this.onopen?.();
        },
        fireClose(isRemote = true) {
          this.closed = true;
          this.onclose?.(isRemote);
        },
      };
      (ch as unknown as { addMessage: (m: unknown) => { send: (v: unknown) => void } }).addMessage = () => ({
        send: () => {},
      });
      mux.channels.push(ch);
      return ch;
    },
    pair() {},
  };
  return mux;
}
vi.mock('protomux', () => ({
  default: {
    from: (socket: { userData?: unknown }) => socket.userData ?? makeMux(),
  },
}));

const { createTopicGossip, DEFAULT_MIN_USEFUL_CHANNEL_MS, DEFAULT_REFRESH_MS } = await import('./topic-gossip');
import type { HyperswarmLike } from './swarm';

const TOPIC = Buffer.alloc(32, 7);

/** Fake swarm that RECORDS every discovery.refresh() — the DHT round whose
 *  runaway rate is the whole defect. */
function fakeSwarm() {
  let handler: ((socket: unknown) => void) | null = null;
  const refreshed: Buffer[] = [];
  const connections = new Set<unknown>();
  const swarm: HyperswarmLike = {
    join(t: Buffer) {
      return {
        refresh: () => {
          refreshed.push(t);
        },
      };
    },
    leave() {},
    on(_e: 'connection', l: (s: unknown) => void) {
      handler = l;
    },
    off() {
      handler = null;
    },
    connections,
  };
  return {
    swarm,
    refreshed,
    /** A fresh peer socket — i.e. exactly what a successful re-dial produces. */
    connect(): { userData?: FakeMux } {
      const socket = { userData: undefined as FakeMux | undefined };
      connections.add(socket);
      handler?.(socket);
      return socket;
    },
  };
}

type Frame = { kind: string };

/** Params chosen so one fast window spans several refresh ticks, exactly as
 *  production's 30_000 / 2_500 does. */
const REFRESH_MS = 50;
const FAST_WINDOW_MS = 200;
const SLOW_REFRESH_MS = 1000;
const MIN_USEFUL_MS = 100;

function makeGossip(f: ReturnType<typeof fakeSwarm>, minUsefulChannelMs?: number) {
  return createTopicGossip<Frame>({
    swarm: f.swarm,
    protocol: 'papercusp/test-gossip',
    onFrame: () => {},
    getHelloFrames: () => [],
    refreshMs: REFRESH_MS,
    fastWindowMs: FAST_WINDOW_MS,
    slowRefreshMs: SLOW_REFRESH_MS,
    severedEscalationMs: 0, // isolate the cadence ladder from the EI-13317 ladder
    minUsefulChannelMs,
  });
}

/** Pair a fresh peer, hold the channel open `aliveMs`, then let it die —
 *  one turn of the observed storm cycle. */
async function flapOnce(
  f: ReturnType<typeof fakeSwarm>,
  aliveMs: number,
  isRemote = true,
): Promise<void> {
  const socket = f.connect();
  const ch = socket.userData!.channels[0]!;
  ch.pairRemote();
  await vi.advanceTimersByTimeAsync(aliveMs);
  ch.fireClose(isRemote);
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('createTopicGossip fast-window flap backoff (EI-18808621019872598)', () => {
  it('the default threshold sits above one fast refresh round', () => {
    // The whole discrimination is "did this channel outlive a DHT round".
    // A default at or under DEFAULT_REFRESH_MS would classify a storm-cycle
    // channel as healthy and restore the amplifier.
    expect(DEFAULT_MIN_USEFUL_CHANNEL_MS).toBeGreaterThan(DEFAULT_REFRESH_MS);
  });

  it('a SINGLE last-peer loss still re-arms the FULL fast window (the re-arm’s real purpose)', async () => {
    const f = fakeSwarm();
    const g = makeGossip(f, MIN_USEFUL_MS);
    g.joinTopic(TOPIC);
    // Burn the join's own fast window so the next refreshes can only come from
    // the re-arm under test.
    await vi.advanceTimersByTimeAsync(FAST_WINDOW_MS + REFRESH_MS);

    await flapOnce(f, 0); // an immediate drop — but the FIRST one
    const n = f.refreshed.length;
    await vi.advanceTimersByTimeAsync(FAST_WINDOW_MS - REFRESH_MS);
    // Ticks inside the freshly-granted window: snappy rediscovery preserved.
    expect(f.refreshed.length).toBeGreaterThanOrEqual(n + 3);
    await g.close();
  });

  it('CONSECUTIVE flap-closes decay the window until the topic rides the slow keepalive', async () => {
    const f = fakeSwarm();
    const g = makeGossip(f, MIN_USEFUL_MS);
    g.joinTopic(TOPIC);

    // 200 → 200 (first loss is free) → 100 → 50 → below refreshMs ⇒ 0.
    for (let i = 0; i < 5; i++) await flapOnce(f, 10);

    const n = f.refreshed.length;
    await vi.advanceTimersByTimeAsync(SLOW_REFRESH_MS / 2);
    // Pre-fix this window held ~10 full DHT rounds; now at most the one slow
    // keepalive that may fall due inside it.
    expect(f.refreshed.length - n).toBeLessThanOrEqual(1);
    await g.close();
  });

  it('records Protomux local versus remote-or-stream close attribution on flap warnings', async () => {
    vi.stubEnv('VITEST', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = fakeSwarm();
    const g = makeGossip(f, MIN_USEFUL_MS);
    g.joinTopic(TOPIC);

    await flapOnce(f, 10, true); // first flap is intentionally quiet
    await flapOnce(f, 10, true);
    await flapOnce(f, 10, false);

    const flapWarnings = warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes(' flapping '));
    expect(
      flapWarnings.some((message) => message.includes('closeSource=remote-or-stream (Protomux isRemote=true)')),
    ).toBe(true);
    expect(
      flapWarnings.some((message) => message.includes('closeSource=local-channel-close (Protomux isRemote=false)')),
    ).toBe(true);

    await g.close();
    warn.mockRestore();
  });

  it('CONTROL: minUsefulChannelMs 0 keeps the pre-fix amplifier — the same script storms', async () => {
    // Calibration for the test above: without this, an assertion of "few
    // refreshes" would also pass if the refresh loop were simply broken.
    const f = fakeSwarm();
    const g = makeGossip(f, 0);
    g.joinTopic(TOPIC);

    for (let i = 0; i < 5; i++) await flapOnce(f, 10);

    const n = f.refreshed.length;
    await vi.advanceTimersByTimeAsync(SLOW_REFRESH_MS / 2);
    // The 5th close re-armed a FULL window like every one before it, so the
    // same measurement window that yields ≤1 above yields a whole fast window
    // of DHT rounds here. (The count is one window's worth, not the storm's
    // whole 5,494, because this script stops flapping — live, each of those
    // rounds re-dials and produces the next flap, which is what makes the
    // un-decayed re-arm self-sustaining.)
    expect(f.refreshed.length - n).toBeGreaterThanOrEqual(3);
    await g.close();
  });

  it('a channel that NEVER paired does not touch the window in either direction', async () => {
    // openTopicChannel runs for every socket, so peers that did not join this
    // topic contribute closed/rejected channels that never pair. Counting them
    // as flaps would decay a fresh join's window — the one window discovery
    // most needs — and re-arming on them (the pre-fix behavior) is the same
    // amplifier wearing the never-paired face.
    const f = fakeSwarm();
    const g = makeGossip(f, MIN_USEFUL_MS);
    g.joinTopic(TOPIC);
    await vi.advanceTimersByTimeAsync(FAST_WINDOW_MS + REFRESH_MS); // burn the join window

    const n = f.refreshed.length;
    for (let i = 0; i < 4; i++) {
      const socket = f.connect();
      socket.userData!.channels[0]!.fireClose(); // closed without ever pairing
    }
    await vi.advanceTimersByTimeAsync(FAST_WINDOW_MS);
    // No fast window was granted (pre-fix each of these re-armed a full one)…
    expect(f.refreshed.length - n).toBe(0);

    // …and none was spent either: a real peer's loss still gets the full window.
    await flapOnce(f, 0);
    const m = f.refreshed.length;
    await vi.advanceTimersByTimeAsync(FAST_WINDOW_MS - REFRESH_MS);
    expect(f.refreshed.length).toBeGreaterThanOrEqual(m + 3);
    await g.close();
  });

  it('a genuinely-useful channel RESETS the ladder — a healthy link never pays for an earlier bad patch', async () => {
    const f = fakeSwarm();
    const g = makeGossip(f, MIN_USEFUL_MS);
    g.joinTopic(TOPIC);

    for (let i = 0; i < 5; i++) await flapOnce(f, 10); // decayed to 0
    const decayed = f.refreshed.length;
    await vi.advanceTimersByTimeAsync(SLOW_REFRESH_MS / 2);
    expect(f.refreshed.length - decayed).toBeLessThanOrEqual(1);

    // Now a channel that actually lives: its close must restore the full window.
    await flapOnce(f, MIN_USEFUL_MS + REFRESH_MS);
    const n = f.refreshed.length;
    await vi.advanceTimersByTimeAsync(FAST_WINDOW_MS - REFRESH_MS);
    expect(f.refreshed.length).toBeGreaterThanOrEqual(n + 3);
    await g.close();
  });
});
