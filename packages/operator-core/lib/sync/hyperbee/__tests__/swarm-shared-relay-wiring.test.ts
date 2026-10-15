/**
 * WI-10004827 recurrence guard — the shared sync swarm must be CONSTRUCTED with the
 * blind-relay fallback.
 *
 * sync-relay.test.ts pins the helpers and hyperswarm's fallback-only semantics, but
 * neither would notice if `buildSharedSwarm()` stopped spreading
 * `syncRelayThroughOption(relayKeys)` into `new Swarm(...)`: every helper test stays
 * green while same-NAT peers silently go back to never connecting (measured
 * 2026-10-01: two netns behind one NAT fail HOLEPUNCH_ABORTED on every dial without
 * the relay, and connect relayed through a GCP blind relay with it).
 *
 * This drives the REAL getSharedSwarm() → sync-relay → voice-relay key path, mocking
 * only the leaves (the hyperswarm constructor, the relay-key reader, the seed load).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
// The real constructor emits fallback observations; this suite isolates its sink.
vi.mock('../../../degradation/fallback-observations', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../degradation/fallback-observations')>(),
  observeFallback: vi.fn(() => true),
}));

/** Options passed to each `new Swarm(...)` in a test. */
const constructedWith: Array<Record<string, unknown>> = [];

vi.mock('hyperswarm', () => ({
  default: class FakeSwarm {
    connections = new Set<unknown>();
    constructor(opts: Record<string, unknown> = {}) {
      constructedWith.push(opts);
    }
    setMaxListeners(): void {}
    on(): void {}
    off(): void {}
  },
}));

/** What the voice relay registry (env ∪ PG voice_relay) returns this test. */
let relayKeys: Buffer[] = [];
vi.mock('../../../voice-node/voice-relay', () => ({
  getVoiceRelayKeys: async () => relayKeys,
}));

vi.mock('../../../identity/swarm-keypair', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../identity/swarm-keypair')>();
  return { ...actual, loadOrGenerateSwarmSeed: async () => Buffer.alloc(32, 7) };
});

vi.mock('protomux', () => ({
  default: class FakeProtomux {
    static from(): unknown {
      return new FakeProtomux();
    }
    createChannel(): unknown {
      return { addMessage: () => ({ send: () => {} }), open: () => {}, close: () => {} };
    }
  },
}));

vi.mock('compact-encoding', () => ({ default: { json: {} } }));

const { getSharedSwarm, _setSharedSwarmForTests } = await import('../swarm');

const KEY_A = Buffer.alloc(32, 0xaa);
const KEY_B = Buffer.alloc(32, 0xbb);

beforeEach(() => {
  constructedWith.length = 0;
  relayKeys = [];
  _setSharedSwarmForTests(null);
});

describe('WI-10004827: getSharedSwarm() wires the blind-relay fallback', () => {
  it('passes every configured relay key to the Hyperswarm constructor as relayThrough', async () => {
    relayKeys = [KEY_A, KEY_B];
    await getSharedSwarm();

    expect(constructedWith).toHaveLength(1);
    expect(constructedWith[0].relayThrough).toEqual([KEY_A, KEY_B]);
  });

  it('omits relayThrough entirely when no relay is configured ([] would be truthy to hyperswarm)', async () => {
    relayKeys = [];
    await getSharedSwarm();

    expect(constructedWith).toHaveLength(1);
    expect('relayThrough' in constructedWith[0]).toBe(false);
  });
});
