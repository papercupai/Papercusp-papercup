import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import SecretStream from '@hyperswarm/secret-stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ByocSealedChannel } from './byoc-sealed-channel';
import {
  canonicalNoisePublicKey,
  defaultHostedMachineNoiseKeyPath,
  loadOrCreateHostedMachineNoiseKeyPair,
  noisePublicKeyBase64,
} from './hosted-machine-noise-key';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'machine-noise-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('hosted machine Noise keypair', () => {
  it('creates a 0600 seed once and returns the same keypair on every later load', async () => {
    const path = join(dir, 'nested', 'machine-noise-key.json');
    const first = await loadOrCreateHostedMachineNoiseKeyPair(path);
    expect(first.publicKey).toHaveLength(32);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(await readFile(path, 'utf8')) as { seedBase64: string };
    expect(stored.seedBase64).not.toContain(first.publicKey.toString('base64'));
    // A fresh path string forces a real re-read instead of the in-process promise.
    const again = await loadOrCreateHostedMachineNoiseKeyPair(join(dir, 'nested', '.', 'machine-noise-key.json'));
    expect(again.publicKey.equals(first.publicKey)).toBe(true);
  });

  it('shares one creation between concurrent first calls', async () => {
    const path = join(dir, 'k.json');
    const [a, b] = await Promise.all([
      loadOrCreateHostedMachineNoiseKeyPair(path),
      loadOrCreateHostedMachineNoiseKeyPair(path),
    ]);
    expect(a.publicKey.equals(b.publicKey)).toBe(true);
  });

  it('refuses a corrupt key file instead of silently regenerating a key', async () => {
    const path = join(dir, 'bad.json');
    await writeFile(path, JSON.stringify({ version: 'hosted-machine-noise-key-v1', seedBase64: 'short' }));
    await expect(loadOrCreateHostedMachineNoiseKeyPair(path)).rejects.toThrow(/canonical 32-byte/);
  });

  it('derives a key the sealed channel accepts: a phone pinning it completes the handshake', async () => {
    const machine = await loadOrCreateHostedMachineNoiseKeyPair(join(dir, 'm.json'));
    const phone = SecretStream.keyPair(Buffer.alloc(32, 7));
    const received: unknown[] = [];
    let host: ByocSealedChannel;
    const client = new ByocSealedChannel({
      initiator: true,
      localKeyPair: phone,
      expectedRemotePublicKey: Buffer.from(noisePublicKeyBase64(machine.publicKey), 'base64'),
      sendPacket: (packet) => host.receive(packet),
      onFrame: () => {},
      onError: (error) => { throw error; },
    });
    host = new ByocSealedChannel({
      initiator: false,
      localKeyPair: machine,
      expectedRemotePublicKey: phone.publicKey,
      sendPacket: (packet) => client.receive(packet),
      onFrame: (frame) => received.push(frame),
      onError: (error) => { throw error; },
    });
    client.send({ type: 'device.ping' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toEqual([{ type: 'device.ping' }]);
  });

  it('validates phone keys as canonical 32-byte base64', () => {
    const good = Buffer.alloc(32, 3).toString('base64');
    expect(canonicalNoisePublicKey(good)).toBe(good);
    expect(canonicalNoisePublicKey(Buffer.alloc(31).toString('base64'))).toBeNull();
    expect(canonicalNoisePublicKey(`${good.slice(0, -1)}`)).toBeNull();
    expect(canonicalNoisePublicKey(42)).toBeNull();
  });

  it('stores under the systemd state directory when one is provided', () => {
    expect(defaultHostedMachineNoiseKeyPath({ STATE_DIRECTORY: '/var/lib/x' })).toBe('/var/lib/x/machine-noise-key.json');
  });
});
