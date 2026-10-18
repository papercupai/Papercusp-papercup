import { papercuspPath } from '@papercusp/host-platform/home';
/**
 * The hosted machine's static Noise keypair for sealed phone traffic
 * (WI-10006956, android-public-release-2026-10-01 D-013 #6).
 *
 * On a BYOC cloud workspace the phone reaches this machine only through the
 * portal relay, and every device-http content frame is sealed end to end with
 * the Noise XX channel in `byoc-sealed-channel.ts`. The phone is the initiator
 * and pins this machine's static public key, which it learns from the pair QR.
 * The relay therefore never holds a key that could open the content.
 *
 * Only the 32-byte seed is persisted, mode 0600, in the same state directory as
 * the BYOC client authorizations. The keypair is derived from it with the same
 * `SecretStream.keyPair` the sealed channel uses, so the key type always matches.
 * The seed is created once and then reused: rotating it would strand every
 * phone already paired with the old public key.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import SecretStream from '@hyperswarm/secret-stream';

export const HOSTED_MACHINE_NOISE_KEY_VERSION = 'hosted-machine-noise-key-v1' as const;
const SEED_BYTES = 32;

export interface HostedMachineNoiseKeyPair {
  publicKey: Buffer;
  secretKey: Buffer;
}

interface StoredSeed {
  version: typeof HOSTED_MACHINE_NOISE_KEY_VERSION;
  seedBase64: string;
  createdAt: string;
}

/** Same base directory rules as `defaultByocClientAuthorizationDirectory`. */
export function defaultHostedMachineNoiseKeyPath(env: NodeJS.ProcessEnv = process.env): string {
  const systemdState = env.STATE_DIRECTORY?.trim();
  if (systemdState?.startsWith('/')) return join(systemdState, 'machine-noise-key.json');
  const configured = env.PAPERCUSP_HOSTED_MACHINE_NOISE_KEY_PATH?.trim();
  if (configured?.startsWith('/')) return configured;
  return papercuspPath('workspace-host', 'machine-noise-key.json');
}

function canonicalSeed(seedBase64: unknown): Buffer {
  if (typeof seedBase64 !== 'string') throw new Error('hosted machine Noise seed must be base64');
  const seed = Buffer.from(seedBase64, 'base64');
  if (seed.length !== SEED_BYTES || seed.toString('base64') !== seedBase64) {
    throw new Error('hosted machine Noise seed must be canonical 32-byte base64');
  }
  return seed;
}

function keyPairFromSeed(seed: Buffer): HostedMachineNoiseKeyPair {
  const pair = SecretStream.keyPair(seed);
  return { publicKey: Buffer.from(pair.publicKey), secretKey: Buffer.from(pair.secretKey) };
}

async function readSeed(path: string): Promise<Buffer | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<StoredSeed>;
  if (parsed.version !== HOSTED_MACHINE_NOISE_KEY_VERSION) {
    throw new Error(`hosted machine Noise key file ${path} has an unknown version`);
  }
  return canonicalSeed(parsed.seedBase64);
}

const inflight = new Map<string, Promise<HostedMachineNoiseKeyPair>>();

/**
 * Load the machine keypair, creating and persisting it on first use.
 *
 * A corrupt file is an error, never a silent regeneration: a new key would
 * break every existing pairing without telling anyone. Concurrent first calls
 * in one process share one creation; across processes the exclusive-create
 * temp file plus rename, then a re-read, makes every caller end on the winner.
 */
export function loadOrCreateHostedMachineNoiseKeyPair(
  path: string = defaultHostedMachineNoiseKeyPath(),
): Promise<HostedMachineNoiseKeyPair> {
  const pending = inflight.get(path);
  if (pending) return pending;
  const work = (async () => {
    const existing = await readSeed(path);
    if (existing) return keyPairFromSeed(existing);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const record: StoredSeed = {
      version: HOSTED_MACHINE_NOISE_KEY_VERSION,
      seedBase64: randomBytes(SEED_BYTES).toString('base64'),
      createdAt: new Date().toISOString(),
    };
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    // Another process may have created the key meanwhile; keep theirs.
    const raced = await readSeed(path);
    if (raced) {
      await unlink(temporary).catch(() => {});
      return keyPairFromSeed(raced);
    }
    await rename(temporary, path);
    const stored = await readSeed(path);
    if (!stored) throw new Error(`hosted machine Noise key file ${path} vanished after creation`);
    return keyPairFromSeed(stored);
  })();
  inflight.set(path, work);
  work.catch(() => inflight.delete(path));
  return work;
}

/** Canonical base64 of a 32-byte Noise public key, as carried in the pair QR. */
export function noisePublicKeyBase64(publicKey: Buffer): string {
  if (publicKey.length !== 32) throw new Error('Noise public key must be 32 bytes');
  return publicKey.toString('base64');
}

/** Validates a phone-supplied Noise public key; returns it unchanged or null. */
export function canonicalNoisePublicKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === 32 && bytes.toString('base64') === value ? value : null;
}
