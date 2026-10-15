import { describe, expect, it } from 'vitest';
import SecretStream from '@hyperswarm/secret-stream';
import {
  ByocSealedChannel,
  byocSealedContentType,
  type ByocSealedPacket,
} from './byoc-sealed-channel';

async function pair(overrides: {
  clientExpected?: Buffer;
  hostExpected?: Buffer;
  hostVerify?: (remotePublicKey: Buffer) => Promise<boolean>;
  clientPacket?: (packet: ByocSealedPacket) => ByocSealedPacket;
} = {}) {
  const clientKey = SecretStream.keyPair(Buffer.alloc(32, 11));
  const hostKey = SecretStream.keyPair(Buffer.alloc(32, 22));
  const clientPackets: ByocSealedPacket[] = [];
  const hostPackets: ByocSealedPacket[] = [];
  const clientFrames: Record<string, unknown>[] = [];
  const hostFrames: Record<string, unknown>[] = [];
  const errors: Error[] = [];
  // A held relay queues client→host packets; release() hands the whole queue to the host
  // in ONE synchronous loop, the way a relay that batches a websocket read delivers them.
  let holding = false;
  const held: ByocSealedPacket[] = [];
  let holdingToClient = false;
  const heldToClient: ByocSealedPacket[] = [];
  let client!: ByocSealedChannel;
  let host!: ByocSealedChannel;
  client = new ByocSealedChannel({
    initiator: true,
    localKeyPair: clientKey,
    expectedRemotePublicKey: overrides.clientExpected ?? hostKey.publicKey,
    sendPacket(packet) {
      clientPackets.push(packet);
      const relayed = overrides.clientPacket?.(packet) ?? packet;
      if (holding) held.push(relayed);
      else queueMicrotask(() => host.receive(relayed));
    },
    onFrame: (frame) => clientFrames.push(frame),
    onError: (error) => errors.push(error),
  });
  host = new ByocSealedChannel({
    initiator: false,
    localKeyPair: hostKey,
    ...(overrides.hostVerify
      ? { verifyRemotePublicKey: overrides.hostVerify }
      : { expectedRemotePublicKey: overrides.hostExpected ?? clientKey.publicKey }),
    sendPacket(packet) {
      hostPackets.push(packet);
      if (holdingToClient) heldToClient.push(packet);
      else queueMicrotask(() => client.receive(packet));
    },
    onFrame: (frame) => hostFrames.push(frame),
    onError: (error) => errors.push(error),
  });
  const relay = {
    hold() { holding = true; },
    release() {
      holding = false;
      for (const packet of held.splice(0)) host.receive(packet);
    },
    holdToClient() { holdingToClient = true; },
    releaseToClient() {
      holdingToClient = false;
      for (const packet of heldToClient.splice(0)) client.receive(packet);
    },
  };
  return { client, host, clientPackets, hostPackets, clientFrames, hostFrames, errors, clientKey, hostKey, relay };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('BYOC sealed relay channel', () => {
  it('carries content end to end while relay packets expose only the frame type', async () => {
    const p = await pair();
    await Promise.all([p.client.opened, p.host.opened]);
    const marker = 'BYOC_SECRET_4c92';
    await p.client.send({ type: 'pty.input', data: Buffer.from(marker).toString('base64') });
    await p.host.send({ type: 'pty.data', data: Buffer.from(marker + '-reply').toString('base64') });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(p.hostFrames).toEqual([{ type: 'pty.input', data: Buffer.from(marker).toString('base64') }]);
    expect(p.clientFrames).toEqual([{ type: 'pty.data', data: Buffer.from(marker + '-reply').toString('base64') }]);
    expect(p.clientPackets.some((packet) => byocSealedContentType(packet) === 'pty.input')).toBe(true);
    expect(p.hostPackets.some((packet) => byocSealedContentType(packet) === 'pty.data')).toBe(true);
    expect(JSON.stringify([...p.clientPackets, ...p.hostPackets])).not.toContain(marker);
    p.client.close();
    p.host.close();
  });

  it('refuses a remote static key that differs from the independently verified key', async () => {
    const p = await pair({ clientExpected: SecretStream.keyPair(Buffer.alloc(32, 33)).publicKey });
    await expect(p.client.opened).rejects.toThrow(/key|handshake|noise/i);
    expect(p.hostFrames).toEqual([]);
    p.client.close();
    p.host.close();
  });

  it('responder verifier mode accepts any peer key it resolves (one key per paired phone)', async () => {
    const seen: string[] = [];
    const p = await pair({
      hostVerify: async (key) => { seen.push(key.toString('base64')); return true; },
    });
    await Promise.all([p.client.opened, p.host.opened]);
    expect(seen).toEqual([p.clientKey.publicKey.toString('base64')]);
    await p.client.send({ type: 'http.request', id: 'r1' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(p.hostFrames).toEqual([{ type: 'http.request', id: 'r1' }]);
    p.client.close();
    p.host.close();
  });

  it('responder verifier mode refuses a peer key it does not resolve, before any frame', async () => {
    const p = await pair({ hostVerify: async () => false });
    await expect(p.host.opened).rejects.toThrow(/remote key mismatch/);
    expect(p.hostFrames).toEqual([]);
    p.client.close();
    p.host.close();
  });

  for (const verdict of ['accept', 'refuse', 'throw'] as const) {
    it(`holds application frames until asynchronous peer verification resolves: ${verdict}`, async () => {
      let finishVerification!: (value: boolean) => void;
      let failVerification!: (error: Error) => void;
      const verification = new Promise<boolean>((resolve, reject) => {
        finishVerification = resolve;
        failVerification = reject;
      });
      const p = await pair({ hostVerify: () => verification });
      // Observe rejection immediately, so the negative cases never create an
      // unhandled rejection before the assertion below attaches.
      const hostOutcome = p.host.opened.then(() => null, (error: Error) => error);
      try {
        await p.client.opened;
        await p.client.send({ type: 'http.request', id: 'before-verification' });
        await settle();
        expect(p.hostFrames).toEqual([]);
        if (verdict === 'throw') failVerification(new Error('verifier unavailable'));
        else finishVerification(verdict === 'accept');
        const error = await hostOutcome;
        await settle();
        if (verdict === 'accept') {
          expect(error).toBeNull();
          expect(p.errors).toEqual([]);
          expect(p.hostFrames).toEqual([{ type: 'http.request', id: 'before-verification' }]);
        } else {
          expect(error?.message).toMatch(/remote key mismatch/);
          expect(p.errors).toHaveLength(1);
          expect(p.errors[0].message).toMatch(/remote key mismatch/);
          expect(p.hostFrames).toEqual([]);
          const packetCount = p.hostPackets.length;
          // A rejected authorization is terminal, including later relay input.
          for (const packet of p.clientPackets) p.host.receive(packet);
          await expect(p.host.send({ type: 'http.response', id: 'after-rejection' })).rejects.toThrow();
          await settle();
          expect(p.hostPackets).toHaveLength(packetCount);
          expect(p.hostFrames).toEqual([]);
          expect(p.errors).toHaveLength(1);
        }
      } finally {
        finishVerification(false);
        p.client.close();
        p.host.close();
      }
    });
  }

  it('refuses ambiguous key configuration and an initiator-side verifier', () => {
    const k = SecretStream.keyPair(Buffer.alloc(32, 44));
    const base = { localKeyPair: k, sendPacket: () => {}, onFrame: () => {} };
    expect(() => new ByocSealedChannel({ ...base, initiator: false })).toThrow(/exactly one/);
    expect(() => new ByocSealedChannel({ ...base, initiator: false, expectedRemotePublicKey: k.publicKey, verifyRemotePublicKey: async () => true })).toThrow(/exactly one/);
    expect(() => new ByocSealedChannel({ ...base, initiator: true, verifyRemotePublicKey: async () => true })).toThrow(/responder-only/);
  });

  it('detects relay relabelling instead of delivering ciphertext under another allowed type', async () => {
    const p = await pair({
      clientPacket: (packet) => packet.contentType === 'pty.input'
        ? { ...packet, contentType: 'file.write' }
        : packet,
    });
    await Promise.all([p.client.opened, p.host.opened]);
    await p.client.send({ type: 'pty.input', data: 'opaque' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(p.errors.some((error) => /content type mismatch/.test(error.message))).toBe(true);
    p.client.close();
    p.host.close();
  });

  // WI-10007006: one shared pendingType slot meant a burst of packets delivered in one
  // tick checked every decrypted frame against the LAST packet's type.
  it('delivers a same-tick burst of differently-typed frames in order without a type mismatch', async () => {
    const p = await pair();
    await Promise.all([p.client.opened, p.host.opened]);
    p.relay.hold();
    const frames = [
      { type: 'pty.input', data: 'a' },
      { type: 'http.request', id: 'r1' },
      { type: 'pty.resize', cols: 80, rows: 24 },
      { type: 'pty.input', data: 'b' },
    ];
    await Promise.all(frames.map((frame) => p.client.send(frame)));
    p.relay.release();
    await settle();
    expect(p.errors).toEqual([]);
    expect(p.hostFrames).toEqual(frames);
    p.client.close();
    p.host.close();
  });

  // WI-10007006: send() wrote its outbound type into the same slot receive() checks, so a
  // frame arriving while a local send was flushing was judged against the local type.
  it('keeps inbound type checks independent of concurrent outbound sends', async () => {
    const p = await pair();
    await Promise.all([p.client.opened, p.host.opened]);
    // Start a local send, then land an inbound packet `gap` microtask hops into it. Sweeping
    // the gap puts some round's inbound decrypt inside the local flush window whatever the
    // exact hop count of the streams is.
    const rounds = 12;
    for (let gap = 0; gap < rounds; gap += 1) {
      p.relay.holdToClient();
      await p.host.send({ type: 'pty.data', gap });
      const sending = p.client.send({ type: 'pty.input', gap });
      for (let hop = 0; hop < gap; hop += 1) await Promise.resolve();
      p.relay.releaseToClient();
      await sending;
      await settle();
    }
    expect(p.errors).toEqual([]);
    expect(p.clientFrames.map((frame) => frame.gap)).toEqual(Array.from({ length: rounds }, (_, gap) => gap));
    expect(p.hostFrames.map((frame) => frame.gap)).toEqual(Array.from({ length: rounds }, (_, gap) => gap));
    p.client.close();
    p.host.close();
  });

  it('detects relabelling inside a same-tick burst', async () => {
    const p = await pair({
      clientPacket: (packet) => packet.contentType === 'http.request'
        ? { ...packet, contentType: 'pty.input' }
        : packet,
    });
    await Promise.all([p.client.opened, p.host.opened]);
    p.relay.hold();
    await p.client.send({ type: 'pty.input', data: 'a' });
    await p.client.send({ type: 'http.request', id: 'r1' });
    p.relay.release();
    await settle();
    expect(p.hostFrames).toEqual([{ type: 'pty.input', data: 'a' }]);
    expect(p.errors.some((error) => /content type mismatch/.test(error.message))).toBe(true);
    p.client.close();
    p.host.close();
  });

  it('refuses application content whose relay label was stripped to the handshake null type', async () => {
    const p = await pair({
      clientPacket: (packet) => packet.contentType === 'pty.input' ? { ...packet, contentType: null } : packet,
    });
    await Promise.all([p.client.opened, p.host.opened]);
    await p.client.send({ type: 'pty.input', data: 'opaque' });
    await settle();
    expect(p.hostFrames).toEqual([]);
    expect(p.errors.some((error) => /content type mismatch/.test(error.message))).toBe(true);
    p.client.close();
    p.host.close();
  });
});
