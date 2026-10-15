/**
 * topic-gossip-broadcast-trace-volume.test.ts — EI-18808621019872598.
 *
 * `broadcast()` carried a WI-953 diagnostic that fired on EVERY call. Measured
 * on papercup-bg-host 2026-08-09: 260,319 lines in 24h — 6.4% of that unit's
 * entire 4,076,943-line journal, 42.2 MB/day — for ONE trace, at a broadcast
 * cadence of ~3.4/s.
 *
 * Two reasons that is a defect and not merely untidy:
 *
 *   1. It DESTROYS the signal it exists to carry. The trace's stated job is to
 *      show "an announce went out over zero channels". In a 10-minute window
 *      2038 of 2038 broadcast lines read `0 channel(s) open` — the interesting
 *      condition held continuously, and was indistinguishable from noise
 *      because nothing marked where it STARTED.
 *   2. The volume pushes `journalctl --grep` into a slow reverse scan past
 *      JOURNAL_TIMEOUT_MS, the confirmed root cause of the `logs:read`
 *      false-zero (EI-19980767336148101) — i.e. it broke the tooling used to
 *      read it, and a log-triage tool that answers `matched: 0` for a defect
 *      firing constantly is worse than silence.
 *
 * So the fix is NOT "delete the trace" (that arms the opposite failure — the
 * 50-minute total-pairing-outage above was caught precisely by this line). It
 * is to log on TRANSITION: the first broadcast for a topic, and every later
 * change in the open-channel count.
 *
 * The `PAPERCUSP_SWARM_CHURN_DEBUG` case is this suite's CONTROL: it restores
 * the per-call firehose, proving these assertions can actually SEE the flood
 * they claim to prevent. Without it, a test asserting "1 line" would pass just
 * as happily against a trace that had been deleted outright.
 *
 * Same fake-Protomux + fake-swarm convention as topic-gossip-flap-backoff.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

interface FakeChannel {
  protocol: string;
  id: Buffer | null;
  onopen?: () => void;
  onclose?: () => void;
  closed: boolean;
  sent: unknown[];
  throwOnSend: boolean;
  open(): void;
  pairRemote(): void;
  fireClose(): void;
}
interface FakeMux {
  channels: FakeChannel[];
  createChannel(spec: {
    protocol: string;
    id?: Buffer | null;
    onopen?: () => void;
    onclose?: () => void;
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
        sent: [],
        throwOnSend: false,
        open() {},
        pairRemote() {
          this.onopen?.();
        },
        fireClose() {
          this.closed = true;
          this.onclose?.();
        },
      };
      (ch as unknown as { addMessage: (m: unknown) => { send: (v: unknown) => void } }).addMessage =
        () => ({
          send: (v: unknown) => {
            if (ch.throwOnSend) throw new Error('simulated send failure');
            ch.sent.push(v);
          },
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

const { createTopicGossip } = await import('./topic-gossip');
import type { HyperswarmLike } from './swarm';

const TOPIC = Buffer.alloc(32, 11);
const TOPIC_HEX = TOPIC.toString('hex');

function fakeSwarm() {
  let handler: ((socket: unknown) => void) | null = null;
  const connections = new Set<unknown>();
  const swarm: HyperswarmLike = {
    join() {
      return { refresh: () => {} };
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
    connect(): { userData?: FakeMux } {
      const socket = { userData: undefined as FakeMux | undefined };
      connections.add(socket);
      handler?.(socket);
      return socket;
    },
  };
}

type Frame = { kind: string };

function makeGossip(f: ReturnType<typeof fakeSwarm>) {
  return createTopicGossip<Frame>({
    swarm: f.swarm,
    protocol: 'papercusp/test-gossip',
    onFrame: () => {},
    getHelloFrames: () => [],
    refreshMs: 50,
    fastWindowMs: 200,
    slowRefreshMs: 1000,
    severedEscalationMs: 0,
  });
}

/**
 * The trace is suppressed under VITEST (as every diagnostic in this module is),
 * so a test that simply spied on console.warn would observe ZERO lines and pass
 * against ANY implementation. Lifting the guard for the duration is what makes
 * this suite able to fail at all.
 */
let warns: string[] = [];
let restoreVitestEnv: (() => void) | null = null;
function observeTraces(): void {
  const prev = process.env.VITEST;
  delete process.env.VITEST;
  restoreVitestEnv = () => {
    if (prev === undefined) delete process.env.VITEST;
    else process.env.VITEST = prev;
  };
  warns = [];
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warns.push(args.map(String).join(' '));
  });
}
/** Only the broadcast trace — this module emits other diagnostics (pairing, flap). */
function broadcastLines(): string[] {
  return warns.filter((l) => l.includes('broadcast on topic'));
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  restoreVitestEnv?.();
  restoreVitestEnv = null;
  delete process.env.PAPERCUSP_SWARM_CHURN_DEBUG;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('broadcast() trace volume (EI-18808621019872598)', () => {
  it('returns false with no paired channel, true after a send, and false when a send throws', () => {
    const f = fakeSwarm();
    const g = makeGossip(f);
    g.joinTopic(TOPIC);

    expect(g.broadcast(TOPIC_HEX, { kind: 'announce' })).toBe(false);

    const socket = f.connect();
    const channel = socket.userData!.channels[0]!;
    channel.pairRemote();
    expect(g.broadcast(TOPIC_HEX, { kind: 'announce' })).toBe(true);
    expect(channel.sent).toHaveLength(1);

    channel.throwOnSend = true;
    expect(g.broadcast(TOPIC_HEX, { kind: 'announce' })).toBe(false);
  });

  it('collapses a run of unchanged broadcasts to ONE line instead of one per call', () => {
    const f = fakeSwarm();
    const g = makeGossip(f);
    g.joinTopic(TOPIC);
    observeTraces();

    for (let i = 0; i < 50; i++) g.broadcast(TOPIC_HEX, { kind: 'announce' });

    // Pre-fix this was 50. The condition (0 channels) never changed, so exactly
    // one line should mark it.
    expect(broadcastLines()).toHaveLength(1);
    expect(broadcastLines()[0]).toContain('0 channel(s) open');
  });

  it('CONTROL — PAPERCUSP_SWARM_CHURN_DEBUG restores the per-call firehose', () => {
    // Proves the assertion above can actually see a flood: without this, a
    // deleted trace would satisfy "exactly 1 line" just as well as a fixed one.
    const f = fakeSwarm();
    const g = makeGossip(f);
    g.joinTopic(TOPIC);
    observeTraces();
    process.env.PAPERCUSP_SWARM_CHURN_DEBUG = '1';

    for (let i = 0; i < 50; i++) g.broadcast(TOPIC_HEX, { kind: 'announce' });

    expect(broadcastLines()).toHaveLength(50);
  });

  it('still reports the CHANGE when the open-channel count moves', () => {
    const f = fakeSwarm();
    const g = makeGossip(f);
    g.joinTopic(TOPIC);
    observeTraces();

    g.broadcast(TOPIC_HEX, { kind: 'announce' }); // 0 channels
    const socket = f.connect();
    socket.userData!.channels[0]!.pairRemote(); // now 1
    g.broadcast(TOPIC_HEX, { kind: 'announce' });
    g.broadcast(TOPIC_HEX, { kind: 'announce' }); // unchanged — must stay silent

    const lines = broadcastLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('0 channel(s) open');
    expect(lines[1]).toContain('1 channel(s) open');
    // The transition is stated explicitly, so a reader never has to diff two
    // log lines separated by hours of unrelated output to see that it moved.
    expect(lines[1]).toContain('(was 0)');
  });

  it('reports a zero-channel broadcast on an UNKNOWN topic too (topicKnown=false)', () => {
    // The `!st` case returns early, but the trace precedes that return: a frame
    // aimed at a topic this node never joined is exactly the silent-drop the
    // diagnostic exists to expose.
    const f = fakeSwarm();
    const g = makeGossip(f);
    observeTraces();

    g.broadcast(TOPIC_HEX, { kind: 'announce' });
    g.broadcast(TOPIC_HEX, { kind: 'announce' });

    expect(broadcastLines()).toHaveLength(1);
    expect(broadcastLines()[0]).toContain('topicKnown=false');
  });

  it('a rejoined topic reports its first broadcast again rather than inheriting the old count', async () => {
    const f = fakeSwarm();
    const g = makeGossip(f);
    g.joinTopic(TOPIC);
    observeTraces();

    g.broadcast(TOPIC_HEX, { kind: 'announce' });
    expect(broadcastLines()).toHaveLength(1);

    await g.leaveTopic(TOPIC);
    g.joinTopic(TOPIC);
    g.broadcast(TOPIC_HEX, { kind: 'announce' });

    // Without the leave-side cleanup the count would still read 0 and this
    // second, post-rejoin broadcast would be silently swallowed.
    expect(broadcastLines()).toHaveLength(2);
  });
});
