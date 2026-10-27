/**
 * hive-epoch-crypto-impl.test — the v1 crypto foundation (Move 2 / C-001 read-plane
 * re-key). Exercises the REAL sodium-native crypto with REAL Ed25519 device keys;
 * only the keychain (OS-secret / file I/O) is mocked in-memory so the test is hermetic.
 *
 * The headline assertion is the CUT-OFF: a key wrapped only to the REMAINING members
 * cannot be unwrapped by a REMOVED member's device key — the crypto basis for
 * "member-remove / go-private cuts reads".
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Hoisted in-memory keychain backing the mock (vi.mock factories are hoisted).
const { mem } = vi.hoisted(() => ({ mem: new Map<string, Buffer>() }));
const DEVICE_SVC = 'papercusp-device-keypair';

vi.mock('../../identity/keychain', () => ({
  keychainStore: vi.fn(async (id: string, der: Buffer, serviceName: string = DEVICE_SVC) => {
    mem.set(serviceName + ':' + id, Buffer.from(der));
  }),
  keychainLoad: vi.fn(async (id: string, serviceName: string = DEVICE_SVC) => {
    const v = mem.get(serviceName + ':' + id);
    return v ? { kind: 'ok', value: v } : { kind: 'error', error: { kind: 'not_found' } };
  }),
  keychainDelete: async (id: string, serviceName: string = DEVICE_SVC) => {
    mem.delete(serviceName + ':' + id);
  },
}));

const { createHiveEpochCrypto } = await import('./hive-epoch-crypto-impl');
const { generateEd25519KeypairDer } = await import('../../identity/ed25519');
const { keychainStore, keychainLoad } = await import('../../identity/keychain');
import type { OpAAD } from './hive-epoch-crypto';

/** Register a device: fresh Ed25519 keypair, private key in the (mock) keychain. */
async function makeDevice(keychainId: string): Promise<{ keychainId: string; pubkeyBase64: string }> {
  const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
  await keychainStore(keychainId, privateKeyDer);
  return { keychainId, pubkeyBase64 };
}

const AD = (over: Partial<OpAAD> = {}): OpAAD => ({ potId: 'hive-1', epoch: 1, opId: 'features:F-1:alice', ...over });

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
});

describe('HiveEpochCrypto v1 — deriveEpochKey', () => {
  it('is idempotent for a given (hive, epoch) and yields a 32-byte key', async () => {
    const c = createHiveEpochCrypto();
    const k1 = await c.deriveEpochKey('hive-1', 1);
    const k2 = await c.deriveEpochKey('hive-1', 1);
    expect(k1.length).toBe(32);
    expect(Buffer.from(k1).equals(Buffer.from(k2))).toBe(true); // persisted → same key
  });

  it('mints a DIFFERENT fresh key per epoch (the cut-off depends on non-derivability)', async () => {
    const c = createHiveEpochCrypto();
    const e1 = await c.deriveEpochKey('hive-1', 1);
    const e2 = await c.deriveEpochKey('hive-1', 2);
    expect(Buffer.from(e1).equals(Buffer.from(e2))).toBe(false);
  });

  it('mints a different key per hive', async () => {
    const c = createHiveEpochCrypto();
    const a = await c.deriveEpochKey('hive-a', 1);
    const b = await c.deriveEpochKey('hive-b', 1);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it.each(
    (['io_error', 'decryption_failed'] as const).flatMap(errorKind =>
      [false, true].map(preexisting => ({ errorKind, preexisting })),
    ),
  )('preserves key state after $errorKind (preexisting: $preexisting)', async ({ errorKind, preexisting }) => {
    const c = createHiveEpochCrypto();
    const original = preexisting ? await c.deriveEpochKey('hive-1', 1) : undefined;
    const ciphertext = original ? await c.encryptOp(Buffer.from('existing content'), original, AD()) : undefined;
    const before = new Map([...mem].map(([id, value]) => [id, Buffer.from(value)]));
    vi.mocked(keychainStore).mockClear();
    vi.mocked(keychainLoad).mockResolvedValueOnce({
      kind: 'error', error: { kind: errorKind, reason: 'fixture keychain read failure' },
    });

    const outcome = await c.deriveEpochKey('hive-1', 1).then(
      () => ({ kind: 'resolved' }),
      error => ({ kind: 'rejected', message: String(error) }),
    );
    expect({ outcome, writes: vi.mocked(keychainStore).mock.calls.length, persisted: mem }).toEqual({
      outcome: { kind: 'rejected', message: expect.stringContaining(errorKind) }, writes: 0, persisted: before,
    });
    if (original && ciphertext) {
      const recovered = await c.deriveEpochKey('hive-1', 1);
      expect(Buffer.from(recovered)).toEqual(Buffer.from(original));
      expect(Buffer.from(await c.decryptOp(ciphertext, recovered, AD())).toString()).toBe('existing content');
    }
  });
});

describe('HiveEpochCrypto v1 — encryptOp/decryptOp (AEAD)', () => {
  it('round-trips a payload under the epoch key + AAD', async () => {
    const c = createHiveEpochCrypto();
    const key = await c.deriveEpochKey('hive-1', 1);
    const payload = Buffer.from('a federated op payload', 'utf8');
    const ct = await c.encryptOp(payload, key, AD());
    expect(Buffer.from(ct).equals(payload)).toBe(false); // actually encrypted
    const pt = await c.decryptOp(ct, key, AD());
    expect(Buffer.from(pt).toString('utf8')).toBe('a federated op payload');
  });

  it('FAILS to decrypt under a different epoch key (post-boundary content unreadable with the old key)', async () => {
    const c = createHiveEpochCrypto();
    const epoch1 = await c.deriveEpochKey('hive-1', 1);
    const epoch2 = await c.deriveEpochKey('hive-1', 2);
    const ct = await c.encryptOp(Buffer.from('epoch-2 content'), epoch2, AD({ epoch: 2 }));
    await expect(c.decryptOp(ct, epoch1, AD({ epoch: 2 }))).rejects.toThrow();
  });

  it('FAILS to decrypt when the AAD does not match (no cross-row/epoch replay)', async () => {
    const c = createHiveEpochCrypto();
    const key = await c.deriveEpochKey('hive-1', 1);
    const ct = await c.encryptOp(Buffer.from('x'), key, AD({ opId: 'features:F-1:alice' }));
    await expect(c.decryptOp(ct, key, AD({ opId: 'features:F-9:mallory' }))).rejects.toThrow();
  });

  it('FAILS to decrypt a tampered ciphertext', async () => {
    const c = createHiveEpochCrypto();
    const key = await c.deriveEpochKey('hive-1', 1);
    const ct = Buffer.from(await c.encryptOp(Buffer.from('x'), key, AD()));
    ct[ct.length - 1] ^= 1; // flip a tag byte
    await expect(c.decryptOp(ct, key, AD())).rejects.toThrow();
  });
});

describe('HiveEpochCrypto v1 — wrap/unwrap + the CUT-OFF', () => {
  it('wraps an epoch key to a member and that member unwraps it back', async () => {
    const c = createHiveEpochCrypto();
    const b = await makeDevice('device-B');
    const key = await c.deriveEpochKey('hive-1', 1);
    const blob = await c.wrapKeyToMember(key, b.pubkeyBase64);
    expect(Buffer.from(blob).equals(Buffer.from(key))).toBe(false); // wrapped, not plaintext
    const unwrapped = await c.unwrapEpochKey(blob, b.keychainId);
    expect(Buffer.from(unwrapped).equals(Buffer.from(key))).toBe(true);
  });

  it('CUT-OFF: a REMOVED member (not wrapped to) cannot unwrap the new epoch key', async () => {
    const c = createHiveEpochCrypto();
    const remaining = await makeDevice('device-remaining');
    const removed = await makeDevice('device-removed');
    const newEpochKey = await c.deriveEpochKey('hive-1', 2); // post-boundary epoch
    // Owner wraps ONLY to the remaining member (the removed one is never wrapped to).
    const blob = await c.wrapKeyToMember(newEpochKey, remaining.pubkeyBase64);
    // Remaining member: gets the key.
    await expect(c.unwrapEpochKey(blob, remaining.keychainId)).resolves.toBeDefined();
    // Removed member: holds the topic + old keys + this very blob, but its device key
    // cannot open a seal addressed to someone else → fail-closed.
    await expect(c.unwrapEpochKey(blob, removed.keychainId)).rejects.toThrow();
  });

  it('END-TO-END cut-off: removed member can replicate the ciphertext but cannot read post-boundary content', async () => {
    const c = createHiveEpochCrypto();
    const remaining = await makeDevice('device-remaining');
    const removed = await makeDevice('device-removed');

    // Boundary: epoch advances to 2; owner encrypts new content under epoch-2 key,
    // wraps the key to the remaining member only.
    const epoch2 = await c.deriveEpochKey('hive-1', 2);
    const ad = AD({ epoch: 2, opId: 'plans:p1:owner' });
    const ciphertext = await c.encryptOp(Buffer.from('post-removal secret'), epoch2, ad);
    const wrappedForRemaining = await c.wrapKeyToMember(epoch2, remaining.pubkeyBase64);

    // Remaining member: unwrap → decrypt → reads the content.
    const keyR = await c.unwrapEpochKey(wrappedForRemaining, remaining.keychainId);
    expect(Buffer.from(await c.decryptOp(ciphertext, keyR, ad)).toString()).toBe('post-removal secret');

    // Removed member: has the SAME replicated ciphertext + the wrapped blob, but cannot
    // get the epoch-2 key → cannot decrypt. This is the C-001 read cut-off, crypto-enforced.
    await expect(c.unwrapEpochKey(wrappedForRemaining, removed.keychainId)).rejects.toThrow();
  });

  it('rejects a malformed member pubkey', async () => {
    const c = createHiveEpochCrypto();
    const key = await c.deriveEpochKey('hive-1', 1);
    await expect(c.wrapKeyToMember(key, Buffer.alloc(10).toString('base64'))).rejects.toThrow(/32-byte/);
  });

  it('unwrap fails closed when the device key is absent from the keychain', async () => {
    const c = createHiveEpochCrypto();
    const b = await makeDevice('device-B');
    const blob = await c.wrapKeyToMember(await c.deriveEpochKey('hive-1', 1), b.pubkeyBase64);
    await expect(c.unwrapEpochKey(blob, 'device-NEVER-REGISTERED')).rejects.toThrow();
  });
});

describe('HiveEpochCrypto v1 — P-007 threat-model battery (remaining-member convergence + all-post-removal-content cut-off)', () => {
  it('MULTIPLE remaining members CONVERGE on the same post-boundary content; the removed peer is cut off', async () => {
    const c = createHiveEpochCrypto();
    const remaining1 = await makeDevice('device-remaining-1');
    const remaining2 = await makeDevice('device-remaining-2');
    const removed = await makeDevice('device-removed');

    // Boundary: epoch advances to 2. The owner mints the fresh epoch-2 key and wraps it to
    // the REMAINING members only — the removed peer is never wrapped to.
    const epoch2 = await c.deriveEpochKey('hive-1', 2);
    const ad = AD({ epoch: 2, opId: 'plans:p2:owner' });
    const ciphertext = await c.encryptOp(Buffer.from('post-boundary shared content'), epoch2, ad);
    const wrap1 = await c.wrapKeyToMember(epoch2, remaining1.pubkeyBase64);
    const wrap2 = await c.wrapKeyToMember(epoch2, remaining2.pubkeyBase64);

    // Each remaining member independently unwraps ITS OWN sealed blob and decrypts the SAME
    // federated op. The wrapped blobs differ (sealed to different devices)…
    expect(Buffer.from(wrap1).equals(Buffer.from(wrap2))).toBe(false);
    const k1 = await c.unwrapEpochKey(wrap1, remaining1.keychainId);
    const k2 = await c.unwrapEpochKey(wrap2, remaining2.keychainId);
    // …but both recover the IDENTICAL epoch key, so the post-boundary view CONVERGES.
    expect(Buffer.from(k1).equals(Buffer.from(k2))).toBe(true);
    const pt1 = await c.decryptOp(ciphertext, k1, ad);
    const pt2 = await c.decryptOp(ciphertext, k2, ad);
    expect(Buffer.from(pt1).toString()).toBe('post-boundary shared content');
    expect(
      Buffer.from(pt1).equals(Buffer.from(pt2)),
      'remaining members read identical plaintext — the surviving membership converges',
    ).toBe(true);

    // The removed peer holds neither member's device secret → it can open NEITHER blob.
    await expect(c.unwrapEpochKey(wrap1, removed.keychainId)).rejects.toThrow();
    await expect(c.unwrapEpochKey(wrap2, removed.keychainId)).rejects.toThrow();
  });

  it('a removed peer HOLDING ITS OLD KEY gets undecryptable ciphertext for ALL post-removal content', async () => {
    const c = createHiveEpochCrypto();
    const remaining = await makeDevice('device-remaining');
    const removed = await makeDevice('device-removed');

    // Pre-boundary epoch 1: the soon-to-be-removed peer is a legitimate member and is wrapped
    // the epoch-1 key — this is the "removed peer holding old key" of the threat model. It
    // unwraps + retains that stale key (the only key it will EVER hold).
    const epoch1 = await c.deriveEpochKey('hive-1', 1);
    const removedOldKey = await c.unwrapEpochKey(
      await c.wrapKeyToMember(epoch1, removed.pubkeyBase64),
      removed.keychainId,
    );
    expect(Buffer.from(removedOldKey).equals(Buffer.from(epoch1))).toBe(true);

    // Boundary → epoch 2: the fresh key is wrapped to the REMAINING member only; the removed
    // peer is never wrapped to, so it can never advance past its stale epoch-1 key.
    const epoch2 = await c.deriveEpochKey('hive-1', 2);
    const wrap2ForRemaining = await c.wrapKeyToMember(epoch2, remaining.pubkeyBase64);
    const remainingKey = await c.unwrapEpochKey(wrap2ForRemaining, remaining.keychainId);

    // ALL post-removal content: a batch of distinct epoch-2 ops the owner writes after the
    // boundary. The removed peer replicates every ciphertext (it holds the topic) but decrypts
    // NONE with its old epoch-1 key; the remaining member decrypts every one (non-vacuous).
    const postRemovalOps = ['F-10:owner', 'plans:p3:owner', 'issues:i7:owner', 'features:F-2:bob'];
    for (const opId of postRemovalOps) {
      const ad = AD({ epoch: 2, opId });
      const ct = await c.encryptOp(Buffer.from(`secret for ${opId}`), epoch2, ad);
      // Remaining member: reads it (proves the content is genuinely readable, not garbage).
      expect(Buffer.from(await c.decryptOp(ct, remainingKey, ad)).toString()).toBe(`secret for ${opId}`);
      // Removed peer holding ONLY the stale epoch-1 key: cannot decrypt ANY post-removal op.
      await expect(
        c.decryptOp(ct, removedOldKey, ad),
        `removed peer must not read post-removal op ${opId} with its stale epoch-1 key`,
      ).rejects.toThrow();
    }

    // …and it never obtains the epoch-2 key, because it was never wrapped to.
    await expect(c.unwrapEpochKey(wrap2ForRemaining, removed.keychainId)).rejects.toThrow();
  });
});
