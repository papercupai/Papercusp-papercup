import { afterEach, describe, expect, it, vi } from 'vitest';
import Hyperswarm from 'hyperswarm';
import DHT from 'hyperdht';
import createTestnet from 'hyperdht/testnet.js';
import {
  describeRelayKeyLiveness,
  describeSyncRelayFallback,
  probeRelayKey,
  resolveSyncRelayKeys,
  runRelayLivenessCheck,
  summarizeRelayLiveness,
  syncRelayThroughOption,
  type RelayFindPeerQuery,
  type RelayKeyLiveness,
} from './sync-relay';

const KEY_A = Buffer.alloc(32, 0xaa);
const KEY_B = Buffer.alloc(32, 0xbb);

describe('syncRelayThroughOption (WI-10004827)', () => {
  it('omits relayThrough entirely when no relay is configured', () => {
    // [] is truthy to hyperswarm: passing it would force "relay through nothing".
    expect(syncRelayThroughOption([])).toEqual({});
    expect('relayThrough' in syncRelayThroughOption([])).toBe(false);
  });

  it('passes every configured relay key through, as a copy', () => {
    const keys = [KEY_A, KEY_B];
    const opt = syncRelayThroughOption(keys);
    expect(opt.relayThrough).toEqual([KEY_A, KEY_B]);
    expect(opt.relayThrough).not.toBe(keys);
  });
});

describe('resolveSyncRelayKeys', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns the relay set the reader provides', async () => {
    await expect(resolveSyncRelayKeys(async () => [KEY_A])).resolves.toEqual([KEY_A]);
  });

  it('never throws: a failed read degrades to no relay fallback with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      resolveSyncRelayKeys(async () => {
        throw new Error('pg down');
      }),
    ).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('NO relay fallback'));
  });
});

describe('describeSyncRelayFallback', () => {
  it('names the unreachable-peer consequence when no relay exists', () => {
    expect(describeSyncRelayFallback([])).toContain('will never connect');
    expect(describeSyncRelayFallback([KEY_A])).toContain('1 blind-relay key(s)');
  });
});

describe('hyperswarm relay semantics the fallback depends on (real module)', () => {
  it('relays only on a forced retry after a failed direct connect, never on the first attempt', async () => {
    // Empty bootstrap: the DHT node binds locally and never reaches the network.
    const swarm = new Hyperswarm({ bootstrap: [], ...syncRelayThroughOption([KEY_A, KEY_B]) }) as unknown as {
      dht: { randomized?: boolean };
      _maybeRelayConnection(force: boolean): Buffer[] | null;
      destroy(): Promise<void>;
    };
    try {
      expect(swarm.dht.randomized).toBeFalsy();
      // First attempt: direct (peerInfo.forceRelaying is false).
      expect(swarm._maybeRelayConnection(false)).toBeNull();
      // After HOLEPUNCH_ABORTED / REMOTE_NOT_HOLEPUNCHABLE hyperswarm retries with force.
      expect(swarm._maybeRelayConnection(true)).toEqual([KEY_A, KEY_B]);
    } finally {
      await swarm.destroy();
    }
  });

  it('has no relay at all when the option is omitted', async () => {
    const swarm = new Hyperswarm({ bootstrap: [], ...syncRelayThroughOption([]) }) as unknown as {
      _maybeRelayConnection(force: boolean): Buffer[] | null;
      destroy(): Promise<void>;
    };
    try {
      expect(swarm._maybeRelayConnection(true)).toBeNull();
    } finally {
      await swarm.destroy();
    }
  });
});

/** A fake dht-rpc findPeer query: yields `holders`, then ends with `successes` set. */
function fakeQuery(opts: { holders?: number; successes?: number; fail?: Error; hang?: boolean }): RelayFindPeerQuery & {
  destroyed: boolean;
} {
  const q = {
    successes: undefined as number | undefined,
    destroyed: false,
    destroy() {
      q.destroyed = true;
    },
    async *[Symbol.asyncIterator]() {
      if (opts.fail) throw opts.fail;
      if (opts.hang) {
        await new Promise<void>((resolve) => {
          const tick = setInterval(() => {
            if (q.destroyed) {
              clearInterval(tick);
              resolve();
            }
          }, 5);
        });
        return;
      }
      for (let i = 0; i < (opts.holders ?? 0); i++) yield { from: { host: '10.0.0.1', port: 1 } };
      q.successes = opts.successes;
    },
  };
  return q;
}

describe('probeRelayKey (WI-10004904)', () => {
  it('a key some node announces is live', async () => {
    const dht = { findPeer: () => fakeQuery({ holders: 1, successes: 8 }) };
    await expect(probeRelayKey(dht, KEY_A)).resolves.toEqual({ status: 'live' });
  });

  it('a key no answering node announces is NOT FOUND', async () => {
    const dht = { findPeer: () => fakeQuery({ holders: 0, successes: 8 }) };
    await expect(probeRelayKey(dht, KEY_A)).resolves.toEqual({ status: 'not-found', responders: 8 });
  });

  it('zero holders with zero answers is UNKNOWN, never a dead relay (DHT unreachable)', async () => {
    const dht = { findPeer: () => fakeQuery({ holders: 0, successes: 0 }) };
    const r = await probeRelayKey(dht, KEY_A);
    expect(r.status).toBe('unknown');
  });

  it('an unrecognised query shape (no successes count) is UNKNOWN, not not-found', async () => {
    const dht = { findPeer: () => fakeQuery({ holders: 0 }) };
    expect((await probeRelayKey(dht, KEY_A)).status).toBe('unknown');
  });

  it('a failed lookup is UNKNOWN and carries the error code', async () => {
    const err = Object.assign(new Error('boom'), { code: 'REQUEST_TIMEOUT' });
    const dht = { findPeer: () => fakeQuery({ fail: err }) };
    const r = await probeRelayKey(dht, KEY_A);
    expect(r).toEqual({ status: 'unknown', reason: 'lookup failed: REQUEST_TIMEOUT: boom' });
  });

  it('a synchronous findPeer throw is UNKNOWN', async () => {
    const dht = {
      findPeer: (): RelayFindPeerQuery => {
        throw new Error('dht destroyed');
      },
    };
    expect(await probeRelayKey(dht, KEY_A)).toEqual({ status: 'unknown', reason: 'findPeer threw: dht destroyed' });
  });

  it('a lookup that outlives the bound is UNKNOWN and the query is destroyed', async () => {
    const q = fakeQuery({ hang: true });
    const r = await probeRelayKey({ findPeer: () => q }, KEY_A, 30);
    expect(r).toEqual({ status: 'unknown', reason: 'lookup timed out after 30ms' });
    expect(q.destroyed).toBe(true);
  });
});

describe('relay liveness reporting', () => {
  const live: RelayKeyLiveness = { status: 'live' };
  const dead: RelayKeyLiveness = { status: 'not-found', responders: 5 };
  const unknown: RelayKeyLiveness = { status: 'unknown', reason: 'x' };

  it('only a confirmed not-found warns, and it names the key and PEER_NOT_FOUND', () => {
    const d = describeRelayKeyLiveness(KEY_A, dead);
    expect(d.level).toBe('warn');
    expect(d.line).toContain('relay aaaaaaaa is NOT on the DHT');
    expect(d.line).toContain('PEER_NOT_FOUND');
    expect(describeRelayKeyLiveness(KEY_A, live).level).toBe('info');
    expect(describeRelayKeyLiveness(KEY_A, unknown).level).toBe('info');
  });

  it('all keys dead => the fallback is INERT (warn)', () => {
    const s = summarizeRelayLiveness([{ key: KEY_A, liveness: dead }]);
    expect(s).toEqual(expect.objectContaining({ level: 'warn' }));
    expect(s?.line).toContain('relay fallback is INERT');
  });

  it('any live key => info; dead + unconfirmed => may-be-inert warn; all unknown => info', () => {
    expect(summarizeRelayLiveness([{ key: KEY_A, liveness: dead }, { key: KEY_B, liveness: live }])?.level).toBe(
      'info',
    );
    const mixed = summarizeRelayLiveness([{ key: KEY_A, liveness: dead }, { key: KEY_B, liveness: unknown }]);
    expect(mixed?.level).toBe('warn');
    expect(mixed?.line).toContain('may be INERT');
    expect(summarizeRelayLiveness([{ key: KEY_A, liveness: unknown }])?.level).toBe('info');
    expect(summarizeRelayLiveness([])).toBeNull();
  });

  it('runRelayLivenessCheck logs per key + summary, and is UNKNOWN on a swarm without a DHT', async () => {
    const lines: Array<[string, string]> = [];
    const log = { info: (l: string) => lines.push(['info', l]), warn: (l: string) => lines.push(['warn', l]) };
    const swarm = { dht: { findPeer: () => fakeQuery({ holders: 0, successes: 4 }) } };
    const results = await runRelayLivenessCheck(swarm, [KEY_A], { log });
    expect(results?.[0]?.liveness).toEqual({ status: 'not-found', responders: 4 });
    expect(lines.filter(([lvl]) => lvl === 'warn')).toHaveLength(2);

    lines.length = 0;
    expect(await runRelayLivenessCheck({}, [KEY_A], { log })).toBeNull();
    expect(lines).toEqual([['info', expect.stringContaining('relay liveness UNKNOWN')]]);

    lines.length = 0;
    expect(await runRelayLivenessCheck(swarm, [], { log })).toEqual([]);
    expect(lines).toEqual([]);
  });
});

describe('relay liveness against the real hyperdht module (local testnet, offline)', () => {
  type RealDht = {
    findPeer(k: Buffer): RelayFindPeerQuery;
    createServer(): { listen(kp: unknown): Promise<void>; close(): Promise<void> };
    destroy(): Promise<void>;
  };
  const DhtCtor = DHT as unknown as {
    new (opts: { bootstrap: unknown }): RealDht;
    keyPair(): { publicKey: Buffer };
  };

  it('a served key is live, an unserved key is not-found', async () => {
    const testnet = (await createTestnet(3)) as unknown as {
      bootstrap: unknown;
      nodes: RealDht[];
      destroy(): Promise<void>;
    };
    const server = testnet.nodes[2]!.createServer();
    const prober = new DhtCtor({ bootstrap: testnet.bootstrap });
    try {
      const served = DhtCtor.keyPair();
      await server.listen(served);
      expect(await probeRelayKey(prober, served.publicKey, 10_000)).toEqual({ status: 'live' });
      const r = await probeRelayKey(prober, DhtCtor.keyPair().publicKey, 10_000);
      expect(r.status).toBe('not-found');
    } finally {
      await server.close();
      await prober.destroy();
      await testnet.destroy();
    }
  }, 30_000);

  it('a DHT that reaches no node reports UNKNOWN, never not-found', async () => {
    const isolated = new DhtCtor({ bootstrap: [] });
    try {
      const r = await probeRelayKey(isolated, DhtCtor.keyPair().publicKey, 5_000);
      expect(r.status).toBe('unknown');
    } finally {
      await isolated.destroy();
    }
  }, 15_000);
});
