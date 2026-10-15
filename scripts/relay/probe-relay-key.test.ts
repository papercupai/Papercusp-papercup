/**
 * probe-relay-key (plan public-blind-relay-2026-10-01, P-004): the probe must run
 * the SAME check the swarm runs at boot, so its output is a faithful record of
 * the boot liveness line — and its exit code must follow the per-key verdicts
 * (provision-relay-vm.sh verify reads only the exit code).
 */
/// <reference path="../../packages/operator-core/lib/sync/hyperbee/holepunch.d.ts" />
import { describe, expect, it } from 'vitest';
import DHT from 'hyperdht';
import createTestnet from 'hyperdht/testnet.js';
import { main } from './probe-relay-key';

type RealDht = {
  findPeer(k: Buffer): never;
  createServer(): { listen(kp: unknown): Promise<void>; close(): Promise<void> };
  ready(): Promise<void>;
  destroy(): Promise<void>;
};
const DhtCtor = DHT as unknown as {
  new (opts: { bootstrap: unknown }): RealDht;
  keyPair(): { publicKey: Buffer };
};

function capture() {
  const lines: string[] = [];
  const json: Array<Record<string, unknown>> = [];
  return {
    lines,
    json,
    log: { info: (l: string) => lines.push(l), warn: (l: string) => lines.push(l) },
    emit: (l: string) => json.push(JSON.parse(l) as Record<string, unknown>),
  };
}

describe('probe-relay-key main (local hyperdht testnet, offline)', () => {
  it('prints the boot-format liveness line and exits 0 for a served key, 1 once a key is not found', async () => {
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
      const servedHex = served.publicKey.toString('hex');

      const live = capture();
      expect(await main([servedHex], { dht: prober, log: live.log, emit: live.emit, timeoutMs: 10_000 })).toBe(0);
      expect(live.lines).toContain(`[swarm] relay ${servedHex.slice(0, 8)} is live on the DHT`);
      expect(live.json).toEqual([{ key: servedHex, status: 'live' }]);

      const mixed = capture();
      const deadHex = DhtCtor.keyPair().publicKey.toString('hex');
      expect(
        await main([servedHex, deadHex], { dht: prober, log: mixed.log, emit: mixed.emit, timeoutMs: 10_000 }),
      ).toBe(1);
      expect(mixed.lines.some((l) => l.includes(`relay ${deadHex.slice(0, 8)} is NOT on the DHT`))).toBe(true);
      expect(mixed.json.map((r) => r.status)).toEqual(['live', 'not-found']);
    } finally {
      await server.close();
      await prober.destroy();
      await testnet.destroy();
    }
  }, 30_000);

  it('exits 2 (unknown) when the DHT reaches no node, never 1', async () => {
    const isolated = new DhtCtor({ bootstrap: [] });
    try {
      const out = capture();
      const hex = DhtCtor.keyPair().publicKey.toString('hex');
      expect(await main([hex], { dht: isolated, log: out.log, emit: out.emit, timeoutMs: 5_000 })).toBe(2);
      expect(out.json.map((r) => r.status)).toEqual(['unknown']);
    } finally {
      await isolated.destroy();
    }
  }, 15_000);

  it('refuses a non-hex key before touching the DHT', async () => {
    await expect(main(['not-a-key'], { dht: {} as never })).rejects.toThrow(/not a 64-hex relay key/);
  });
});
