/**
 * The standalone blind-relay core (plan public-blind-relay-2026-10-01, R-1):
 * a relay started from a seed announces the seed-derived key, and that key is
 * findable on the DHT — the same liveness probe the boot check runs
 * (sync-relay.ts probeRelayKey). Real hyperdht testnet, offline.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import DHT from 'hyperdht';
import createTestnet from 'hyperdht/testnet.js';
import { probeRelayKey, type RelayLookupDht } from '../sync/hyperbee/sync-relay';
import {
  createBlindRelayServer,
  parseRelaySeedHex,
  relayPublicKeyForSeed,
  type BlindRelayServer,
} from './blind-relay-core';

type Testnet = { bootstrap: Array<{ host: string; port: number }>; destroy(): Promise<void> };
type ProberDht = RelayLookupDht & { destroy(): Promise<void> };
const DhtCtor = DHT as unknown as {
  new (opts: { bootstrap: unknown }): ProberDht;
  keyPair(seed?: Buffer): { publicKey: Buffer };
};

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn().catch(() => {});
  }
});

describe('parseRelaySeedHex', () => {
  it('accepts 64 hex chars with surrounding whitespace, any case', () => {
    const seed = randomBytes(32);
    expect(parseRelaySeedHex(`  ${seed.toString('hex').toUpperCase()}\n`).equals(seed)).toBe(true);
  });
  it('refuses a short, long or non-hex seed', () => {
    expect(() => parseRelaySeedHex('ab'.repeat(31))).toThrow(/64 hex/);
    expect(() => parseRelaySeedHex('ab'.repeat(33))).toThrow(/64 hex/);
    expect(() => parseRelaySeedHex('zz'.repeat(32))).toThrow(/64 hex/);
  });
});

describe('createBlindRelayServer (real hyperdht testnet)', () => {
  it('refuses a seed that is not 32 bytes before touching the network', async () => {
    await expect(createBlindRelayServer({ seed: Buffer.alloc(16) })).rejects.toThrow(/32 bytes/);
  });

  it('announces the seed-derived key, and that key is live on the DHT', async () => {
    const testnet = (await createTestnet(3)) as unknown as Testnet;
    cleanups.push(() => testnet.destroy());
    const seed = randomBytes(32);

    const relay: BlindRelayServer = await createBlindRelayServer({ seed, bootstrap: testnet.bootstrap });
    cleanups.push(() => relay.close());

    const expected = DhtCtor.keyPair(seed).publicKey.toString('hex');
    expect(relay.publicKey).toBe(expected);
    expect(await relayPublicKeyForSeed(seed)).toBe(expected);

    const prober = new DhtCtor({ bootstrap: testnet.bootstrap });
    cleanups.push(() => prober.destroy());
    expect(await probeRelayKey(prober, Buffer.from(relay.publicKey, 'hex'), 10_000)).toEqual({ status: 'live' });
  }, 30_000);

  it('the same seed gives the same key across restarts', async () => {
    const testnet = (await createTestnet(3)) as unknown as Testnet;
    cleanups.push(() => testnet.destroy());
    const seed = randomBytes(32);
    const first = await createBlindRelayServer({ seed, bootstrap: testnet.bootstrap });
    const firstKey = first.publicKey;
    await first.close();
    const second = await createBlindRelayServer({ seed, bootstrap: testnet.bootstrap });
    cleanups.push(() => second.close());
    expect(second.publicKey).toBe(firstKey);
  }, 30_000);
});

describe('a peer resetting a relayed stream (WI-10004904: this crashed the VM daemon)', () => {
  type Raw = {
    on(ev: string, cb: (...a: unknown[]) => void): Raw;
    once(ev: string, cb: (...a: unknown[]) => void): Raw;
    write(d: Buffer): unknown;
    destroy(): void;
    connect(socket: unknown, remoteId: number, port: number, host: string): void;
  };
  type RelaySock = {
    on(ev: string, cb: (...a: unknown[]) => void): unknown;
    publicKey: Buffer;
    rawStream: { remotePort: number; remoteHost: string; socket: unknown };
  };
  type PeerDht = ProberDht & { connect(pk: Buffer): RelaySock; createRawStream(o: { framed: boolean }): Raw };
  const PeerCtor = DhtCtor as unknown as { new (o: { bootstrap: unknown }): PeerDht };
  type RelayClientModule = {
    Client: {
      from(s: RelaySock, o: { id: Buffer }): {
        pair(isInitiator: boolean, token: Buffer, stream: Raw): { on(ev: string, cb: (v: unknown) => void): { on(ev: string, cb: (v: unknown) => void): unknown } };
      };
    };
    token(): Buffer;
  };

  /** One peer's relayed leg, wired the way hyperdht's relayConnection() does when holepunching fails. */
  async function pairThroughRelay(
    node: PeerDht,
    relayKey: Buffer,
    isInitiator: boolean,
    token: Buffer,
    br: RelayClientModule,
  ): Promise<Raw> {
    const relaySocket = node.connect(relayKey);
    relaySocket.on('error', () => {});
    const raw = node.createRawStream({ framed: true });
    raw.on('error', () => {});
    const remoteId = await new Promise<number>((resolve, reject) => {
      br.Client.from(relaySocket, { id: relaySocket.publicKey })
        .pair(isInitiator, token, raw)
        .on('error', reject)
        .on('data', (id) => resolve(id as number));
    });
    const { remotePort, remoteHost, socket } = relaySocket.rawStream;
    raw.connect(socket, remoteId, remotePort, remoteHost);
    return raw;
  }

  it('is contained and reported, and the relay keeps serving', async () => {
    const br = (await import('blind-relay')) as unknown as RelayClientModule;
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);
    cleanups.push(async () => void process.off('uncaughtException', onUncaught));

    const testnet = (await createTestnet(3)) as unknown as Testnet;
    cleanups.push(() => testnet.destroy());
    const sessionErrors: unknown[] = [];
    const relay = await createBlindRelayServer({
      seed: randomBytes(32),
      bootstrap: testnet.bootstrap,
      onSessionError: (e) => sessionErrors.push(e),
    });
    cleanups.push(() => relay.close());
    const relayKey = Buffer.from(relay.publicKey, 'hex');

    const nodeA = new PeerCtor({ bootstrap: testnet.bootstrap });
    const nodeB = new PeerCtor({ bootstrap: testnet.bootstrap });
    cleanups.push(() => nodeA.destroy(), () => nodeB.destroy());
    const token = br.token();
    const [legA, legB] = await Promise.all([
      pairThroughRelay(nodeA, relayKey, true, token, br),
      pairThroughRelay(nodeB, relayKey, false, token, br),
    ]);

    type Stats = { pairings: { matched: number }; streams: { active: number; errors: number } };
    // Positive control: the relay really paired the two peers and opened both legs.
    await vi.waitFor(() => expect((relay.stats() as Stats).streams.active).toBe(2), { timeout: 10_000, interval: 50 });
    expect((relay.stats() as Stats).pairings.matched).toBe(1);
    expect(legB).toBeDefined();

    // An abrupt drop (no FIN) resets the relay's leg: its UDX stream errors
    // ECONNRESET, which blind-relay re-emits on the session — the exact stack
    // that killed the VM daemon at 2026-10-01T16:03Z.
    legA.destroy();
    await vi.waitFor(() => expect(sessionErrors.length).toBeGreaterThan(0), { timeout: 15_000, interval: 100 });
    expect((sessionErrors[0] as { code?: string }).code).toBe('ECONNRESET');
    expect((relay.stats() as Stats).streams.errors).toBe(1);

    expect(uncaught).toEqual([]);
    const prober = new DhtCtor({ bootstrap: testnet.bootstrap });
    cleanups.push(() => prober.destroy());
    expect(await probeRelayKey(prober, relayKey, 10_000)).toEqual({ status: 'live' });
  }, 45_000);
});

describe('relay core stays dependency-light', () => {
  it('imports nothing but hyperdht and blind-relay (the daemon bundle ships only those)', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'blind-relay-core.ts'), 'utf8');
    const specifiers = [...src.matchAll(/(?:from\s+|import\()\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(new Set(specifiers)).toEqual(new Set(['hyperdht', 'blind-relay']));
  });
});
