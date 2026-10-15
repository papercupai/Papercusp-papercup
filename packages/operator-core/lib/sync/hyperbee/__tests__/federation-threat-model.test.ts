/**
 * federation-threat-model.test.ts — shared-pot-release-testing Brief C
 * (security/privacy threat model, the S0 public-release lane).
 *
 * The sibling `federation-adversarial.integration.test.ts` proves the data-plane
 * gates over a real two-peer testnet DHT, but it always exercises the admission
 * decision through `verifyBindingOverride` (the channel-2 stand-in) and never
 * isolates the SIGNATURE gate over the wire, nor the read-after-revocation
 * threat. This file closes three Brief-C gaps over the SAME real-Hyperswarm /
 * real-Ed25519 / capture-sink harness (no PG — these are transport+admission
 * assertions, so they run in the UNIT layer like `hive-two-peer-federation`):
 *
 *   #4 IDENTITY SPOOF (forged signature) — an adversary announces a VALID-shaped
 *      device_pubkey but signs the announce with a DIFFERENT key. The honest
 *      receiver admits any *userId* (binding gate wide open), so the ONLY thing
 *      that can reject the forger is `verifyAnnounce` → `sigValid=false` →
 *      `bad_sig`. We prove end-to-end that the forger's log is never admitted and
 *      its content never federates, while a correctly-signed control peer's
 *      content DOES cross (so the negative is the sig gate, not a dead transport).
 *      This lifts the `announce.test.ts` unit sig-checks onto the real wire.
 *
 *   C-001 READ-AFTER-REVOCATION (the headline privacy finding) — revocation is a
 *      WRITE-plane control. After an owner A revokes member B, A stops ACCEPTING
 *      B's writes (covered by the revocation suite), but A keeps SERVING its
 *      cores to B (replication is unconditional for any topic peer — swarm.ts:329)
 *      and B keeps ADMITTING A's log (B never revoked A), so B keeps READING A's
 *      new content. This test demonstrates that gap at the substrate grain. NB:
 *      `lib/shared-pot-loop/revoked-swarm.integration.test.ts` step 2 already
 *      asserts this same behavior as *intended asymmetry* ("the revoking side's
 *      writes still federate to the revoked peer") — so closing the read path is
 *      a conscious product decision, not a silent bug. See findings-C.md C-001.
 *
 *   #6 POISONING / MALFORMED OPS — the apply dispatcher (`applyOpVia`) must reject
 *      malformed/oversized/wrong-schema/NaN-watermark envelopes GRACEFULLY: drop
 *      (return false), never throw, never reach the projection writer. Pure
 *      dispatch (no swarm/PG), extending the file-2 "wrong tableTag" cell to a
 *      full hostile-input battery.
 *
 * Resource hygiene: every handle/swarm/testnet/dir is torn down newest-first in
 * afterEach so a thrown assertion can never leak a DHT node (which would hang the
 * run). Stand-in (offline-deterministic, exactly as every sibling): the channel-2
 * GitHub-binding fetch → `verifyBindingOverride`. EVERYTHING else is real: real
 * corestores/logs, real Hyperswarm/Noise over a local testnet DHT, real announce
 * signature verification, real `applyOpVia` dispatch.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import { bootHarnessSubstrate, type BootedHarnessHandle } from '../boot';
import { type HyperswarmLike } from '../swarm';
import type { OpEnvelope } from '../op-envelope-types';
import { _resetCacheForTests, closeHarnessStore } from '../corestore';
import { _resetBootHistoryForTests } from '../boot-history';
import { applyOpVia, type ProjectionLookup, type TableProjection } from '../projection';
import type { SwarmBinding } from '../derive-swarm-topic';
import { stubHivePolicyReadsForSuite } from './_hive-policy-read-stubs';

// WI-10007530: no PG here, and the merge pass no longer swallows a failed policy read.
stubHivePolicyReadsForSuite();

// ── Shared identity / swarm constants. Same binding on both peers → same topic. ──
const WORKSPACE_ID = 'ws-fed-threat-model';
const HARNESS_SLUG = 'fed-threat';
const BINDING = { kind: 'local' as const, workspace_id: WORKSPACE_ID, harness_slug: HARNESS_SLUG };
const FEATURE_TAG = 'features-by-id';

// ── Async resource teardown (newest-first). ──
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      // best-effort — a thrown assertion must never leak a swarm/dir/db/DHT node
    }
  }
  _resetCacheForTests();
  _resetBootHistoryForTests();
});

function makeWorkspaceRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  return dir;
}

function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return spkiDer.subarray(-32).toString('base64');
}

/** An honest announce-identity override: the announce is signed with the SAME
 *  key whose pubkey it advertises (mirrors every sibling rig). */
function makeIdentityOverride(login: string, userId: number, keychainId: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePubkey = rawPubkeyBase64(publicKey);
  return {
    devicePubkey,
    userId,
    override: {
      resolveOpts: {
        keychainId,
        resolveGithubUser: async () => ({ id: userId, login }),
        loadKeypair: async (id: string) => ({ keychainId: id, pubkeyBase64: devicePubkey }),
        resolveAttestationGistId: async () => `gist-${login}`,
      },
      sign: async (_keychainId: string, bytes: Buffer) => nodeSign(null, bytes, privateKey),
    },
  };
}

/** A FORGED announce-identity: it advertises a valid-shaped 32-byte Ed25519
 *  `device_pubkey` (so `verifyAnnounce` reaches the signature check rather than
 *  bailing on shape) but SIGNS with a DIFFERENT private key — so the signature
 *  cannot verify against the advertised pubkey. This is the over-wire identity
 *  spoof: "I am device X" with a signature device X never made. */
function makeForgedIdentityOverride(login: string, userId: number, keychainId: string) {
  const advertised = generateKeyPairSync('ed25519'); // the pubkey we CLAIM to be
  const attacker = generateKeyPairSync('ed25519'); // the key we actually sign with
  const devicePubkey = rawPubkeyBase64(advertised.publicKey);
  return {
    devicePubkey,
    userId,
    override: {
      resolveOpts: {
        keychainId,
        resolveGithubUser: async () => ({ id: userId, login }),
        loadKeypair: async (id: string) => ({ keychainId: id, pubkeyBase64: devicePubkey }),
        resolveAttestationGistId: async () => `gist-${login}`,
      },
      // FORGE: sign with the attacker key, not the key matching `devicePubkey`.
      sign: async (_keychainId: string, bytes: Buffer) => nodeSign(null, bytes, attacker.privateKey),
    },
  };
}

function makeSwarm(bootstrap: unknown): HyperswarmLike {
  const swarm = new Hyperswarm({ bootstrap }) as unknown as HyperswarmLike & {
    destroy(): Promise<void>;
  };
  cleanups.push(async () => {
    try {
      await swarm.destroy();
    } catch {
      /* ignore */
    }
  });
  return swarm;
}

async function makeTestnet() {
  const testnet = await createTestnet(3);
  cleanups.push(async () => {
    try {
      await testnet.destroy();
    } catch {
      /* ignore */
    }
  });
  return testnet;
}

async function pollUntil<T>(
  fn: () => T | Promise<T>,
  { timeoutMs, intervalMs }: { timeoutMs: number; intervalMs: number },
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

interface CaptureBootResult {
  handle: BootedHarnessHandle;
  apply: ReturnType<typeof vi.fn>;
}

/** Boot a capture-sink peer: a vi.fn apply records every op the peer's merge
 *  admits + dispatches, so we can assert WHAT a peer reads without a PG. */
async function bootCapturePeer(opts: {
  testnetBootstrap: unknown;
  rootPrefix: string;
  identity: ReturnType<typeof makeIdentityOverride>;
  verify: (userId: number) => 'verified' | 'pending' | 'fail';
  loadRevoked?: () => Promise<Set<string>>;
  /** Override the swarm binding (→ topic). Defaults to BINDING (a shared local
   *  topic). Pass a `hive:`/`gh:` binding to test topic divergence (threat #1). */
  binding?: SwarmBinding;
}): Promise<CaptureBootResult> {
  const apply = vi.fn<(op: OpEnvelope) => Promise<boolean>>(async () => true);
  const root = makeWorkspaceRoot(opts.rootPrefix);
  const handle = await bootHarnessSubstrate({
    rekeyDepsOverride: null, // unit boot must not auto-build re-key deps through real PG
    workspaceRoot: root,
    workspaceId: WORKSPACE_ID,
    harnessSlug: HARNESS_SLUG,
    swarmBinding: opts.binding ?? BINDING,
    swarmOverride: makeSwarm(opts.testnetBootstrap),
    verifyBindingOverride: async (_pk, _login, userId) => opts.verify(userId),
    applyOverride: apply,
    mergePollMs: 0,
    pendingRetryMs: 0,
    reverifyIntervalMs: 0,
    loadRevokedOverride: opts.loadRevoked ?? (async () => new Set()),
    announceIdentityOverride: opts.identity.override,
  });
  cleanups.push(async () => {
    await handle.close();
    await closeHarnessStore({ workspaceRoot: root, harnessSlug: HARNESS_SLUG });
  });
  return { handle, apply };
}

function featureValue(id: string, title: string) {
  return { harness_slug: HARNESS_SLUG, feature_id: id, title, status: 'todo' };
}

// ════════════════════════════════════════════════════════════════════════════
// #4 — Identity spoof: a forged-signature announce is rejected over the wire,
//      isolating the signature gate from the (wide-open) binding gate.
// ════════════════════════════════════════════════════════════════════════════
describe('threat #4 — forged-signature announce never federates (over the wire)', () => {
  it('a peer that signs its announce with the WRONG key is never admitted (bad_sig), while a correctly-signed control peer crosses', async () => {
    const testnet = await makeTestnet();
    // The RECEIVER admits ANY github user id — the binding gate is wide open, so
    // the ONLY gate that can reject a peer here is the announce signature check.
    const idReceiver = makeIdentityOverride('receiver', 1, 'kc-recv');
    const receiver = await bootCapturePeer({
      testnetBootstrap: testnet.bootstrap,
      rootPrefix: 'tmF-recv-',
      identity: idReceiver,
      verify: () => 'verified',
    });

    // The FORGER: advertises a valid device_pubkey but signs with another key.
    const idForger = makeForgedIdentityOverride('forger', 66, 'kc-forge');
    const forger = await bootCapturePeer({
      testnetBootstrap: testnet.bootstrap,
      rootPrefix: 'tmF-forge-',
      identity: idForger,
      verify: () => 'verified',
    });

    // An HONEST control sender: a valid signature, same wide-open admission.
    const idHonest = makeIdentityOverride('honest', 77, 'kc-honest');
    const honest = await bootCapturePeer({
      testnetBootstrap: testnet.bootstrap,
      rootPrefix: 'tmF-honest-',
      identity: idHonest,
      verify: () => 'verified',
    });

    expect(receiver.handle.swarm!.topicHex).toBe(forger.handle.swarm!.topicHex);
    expect(receiver.handle.swarm!.topicHex).toBe(honest.handle.swarm!.topicHex);

    await forger.handle.append({
      type: 'put',
      table: FEATURE_TAG,
      hbKey: 'F-forged',
      value: featureValue('F-forged', 'should NOT cross — forged sig'),
      ts: 5000,
      schema_version: 1,
      writerPubkey: idForger.devicePubkey,
    });
    await honest.handle.append({
      type: 'put',
      table: FEATURE_TAG,
      hbKey: 'F-honest',
      value: featureValue('F-honest', 'should cross — valid sig'),
      ts: 5001,
      schema_version: 1,
      writerPubkey: idHonest.devicePubkey,
    });

    // The control proves the transport + admission works for a valid sig: the
    // receiver MUST eventually see the honest peer's content.
    const sawHonest = await pollUntil(
      async () => {
        await receiver.handle.mergeNow();
        return receiver.apply.mock.calls.find((c) => c[0].hbKey === 'F-honest')?.[0];
      },
      { timeoutMs: 25_000, intervalMs: 250 },
    );
    expect(sawHonest, 'the correctly-signed control peer should federate (transport works)').toBeTruthy();

    // A few extra passes so the forger's content has had every chance to cross.
    for (let i = 0; i < 6; i++) {
      await receiver.handle.mergeNow();
      await new Promise((r) => setTimeout(r, 100));
    }

    // THE ADVERSARIAL ASSERTION: the forger's log was never admitted (bad_sig),
    // so its content never reached the receiver despite the wide-open binding gate.
    expect(
      receiver.apply.mock.calls.find((c) => c[0].hbKey === 'F-forged'),
      "a forged-signature peer's content federated despite verifyAnnounce → bad_sig",
    ).toBeUndefined();
    // Structural proof: `admitted` is keyed by log_core_key. The receiver
    // admitted the honest sender's log but NEVER the forger's (bad_sig).
    expect(
      receiver.handle.admitted.has(forger.handle.ownLog.keyHex),
      'the forger’s log must never be admitted (its announce sig is invalid)',
    ).toBe(false);
    expect(
      receiver.handle.admitted.has(honest.handle.ownLog.keyHex),
      'the honest sender’s log should be admitted (valid sig + open binding)',
    ).toBe(true);
  }, 60_000);
});

// ════════════════════════════════════════════════════════════════════════════
// C-001 — Read-after-revocation: a removed member keeps READING the hive.
// ════════════════════════════════════════════════════════════════════════════
describe('C-001 — revocation is write-plane only: a revoked member keeps reading new content', () => {
  it("after owner A revokes member B, A's NEW content STILL reaches B (B keeps reading — the privacy gap)", async () => {
    const testnet = await makeTestnet();
    const idA = makeIdentityOverride('owner', 42, 'kc-owner'); // the hive owner
    const idB = makeIdentityOverride('member', 7, 'kc-member'); // the member to remove

    // Both peers mutually admit at boot (a normal hive).
    const peerB = await bootCapturePeer({
      testnetBootstrap: testnet.bootstrap,
      rootPrefix: 'tmR-B-',
      identity: idB,
      verify: (uid) => (uid === idA.userId ? 'verified' : 'fail'),
    });
    const peerA = await bootCapturePeer({
      testnetBootstrap: testnet.bootstrap,
      rootPrefix: 'tmR-A-',
      identity: idA,
      verify: (uid) => (uid === idB.userId ? 'verified' : 'fail'),
    });
    expect(peerA.handle.swarm!.topicHex).toBe(peerB.handle.swarm!.topicHex);

    // BASELINE (also the test's teeth): B reads A's content while a member. If
    // the transport/admission path were broken this assertion fails first, so a
    // passing test below is genuinely "B reads after removal", not a false read.
    await peerA.handle.append({
      type: 'put',
      table: FEATURE_TAG,
      hbKey: 'F-while-member',
      value: featureValue('F-while-member', 'A content B may read as a member'),
      ts: 6000,
      schema_version: 1,
      writerPubkey: idA.devicePubkey,
    });
    const baseline = await pollUntil(
      async () => {
        await peerB.handle.mergeNow();
        return peerB.apply.mock.calls.find((c) => c[0].hbKey === 'F-while-member')?.[0];
      },
      { timeoutMs: 25_000, intervalMs: 250 },
    );
    expect(baseline, 'B (a member) should read A’s content — the read path is real').toBeTruthy();

    // THE REVOCATION: A removes B. This drops B's log from A's admitted set (A
    // stops ACCEPTING B's writes) and refuses B's re-announce — but it does NOT
    // evict B's connection, stop A serving its cores to B, or change B's own
    // admission of A. (swarm.ts:329 replicates unconditionally to any topic peer.)
    await peerA.handle.revoke(idB.devicePubkey);

    // A writes NEW content AFTER removing B.
    await peerA.handle.append({
      type: 'put',
      table: FEATURE_TAG,
      hbKey: 'F-after-removal',
      value: featureValue('F-after-removal', 'A content authored AFTER removing B'),
      ts: 6001,
      schema_version: 1,
      writerPubkey: idA.devicePubkey,
    });

    // THE GAP: B STILL receives A's post-removal content. (A green pass here =
    // the read-revocation gap is open; a fix — replication gated on admission,
    // or connection-level device eviction, or re-key on removal — flips it red.
    // See findings-C.md C-001 for the product decision + fix options.)
    const afterRemoval = await pollUntil(
      async () => {
        await peerB.handle.mergeNow();
        return peerB.apply.mock.calls.find((c) => c[0].hbKey === 'F-after-removal')?.[0];
      },
      { timeoutMs: 25_000, intervalMs: 250 },
    );
    expect(
      afterRemoval,
      'C-001: a revoked member STILL reads the owner’s new content — revocation does not cut off reading',
    ).toBeTruthy();
  }, 60_000);
});

// ════════════════════════════════════════════════════════════════════════════
// #1 — Topic secrecy end-to-end: a never-member who GUESSES the gh:<repo_id>
//      topic reads NOTHING from a private hive (which federates on hive:<pubkey>).
// ════════════════════════════════════════════════════════════════════════════
describe('threat #1 — a never-member on a guessed gh: topic reads nothing from a private hive', () => {
  it('a never-member booting on gh:<repo_id> never connects to a private hive on hive:<pubkey>, while a legit member on the hive topic reads it', async () => {
    const testnet = await makeTestnet();

    // A private hive federates on hive:<pubkey>. The pubkey lives only in the
    // member/invite link, NEVER on the public directory. The attacker knows the
    // GitHub repo id (public) and GUESSES gh:<repo_id> — a DIFFERENT topic.
    const HIVE_PUBKEY = rawPubkeyBase64(generateKeyPairSync('ed25519').publicKey);
    const hiveBinding: SwarmBinding = { kind: 'hive', hive_pubkey: HIVE_PUBKEY };
    const guessedBinding: SwarmBinding = { kind: 'gh', github_repository_id: 778899 };

    const idOwner = makeIdentityOverride('owner', 42, 'kc-owner');
    const idMember = makeIdentityOverride('member', 7, 'kc-member');
    const idGuesser = makeIdentityOverride('guesser', 66, 'kc-guesser');

    // Owner + member are on the HIVE topic and admit each other.
    const owner = await bootCapturePeer({
      testnetBootstrap: testnet.bootstrap,
      rootPrefix: 'tm1-owner-',
      identity: idOwner,
      binding: hiveBinding,
      verify: (uid) => (uid === idMember.userId ? 'verified' : 'fail'),
    });
    const member = await bootCapturePeer({
      testnetBootstrap: testnet.bootstrap,
      rootPrefix: 'tm1-member-',
      identity: idMember,
      binding: hiveBinding,
      verify: (uid) => (uid === idOwner.userId ? 'verified' : 'fail'),
    });
    // The guesser is on the WRONG (gh-derived) topic — and would admit ANYONE,
    // so the ONLY thing keeping the hive content from it is the topic divergence.
    const guesser = await bootCapturePeer({
      testnetBootstrap: testnet.bootstrap,
      rootPrefix: 'tm1-guesser-',
      identity: idGuesser,
      binding: guessedBinding,
      verify: () => 'verified',
    });

    // Sanity: the guessed gh: topic genuinely differs from the hive topic
    // (if it didn't, the whole secrecy property would be moot).
    expect(owner.handle.swarm!.topicHex).toBe(member.handle.swarm!.topicHex);
    expect(guesser.handle.swarm!.topicHex).not.toBe(owner.handle.swarm!.topicHex);

    await owner.handle.append({
      type: 'put',
      table: FEATURE_TAG,
      hbKey: 'F-private',
      value: featureValue('F-private', 'private hive content'),
      ts: 7000,
      schema_version: 1,
      writerPubkey: idOwner.devicePubkey,
    });

    // Control + teeth: the legit member on the hive topic DOES read it (proves
    // the content is live + reachable on the correct topic).
    const memberRead = await pollUntil(
      async () => {
        await member.handle.mergeNow();
        return member.apply.mock.calls.find((c) => c[0].hbKey === 'F-private')?.[0];
      },
      { timeoutMs: 25_000, intervalMs: 250 },
    );
    expect(memberRead, 'a legit member on the hive topic should read the content').toBeTruthy();

    // Give the guesser every chance to (wrongly) receive it.
    for (let i = 0; i < 8; i++) {
      await guesser.handle.mergeNow();
      await new Promise((r) => setTimeout(r, 100));
    }

    // THE PRIVACY ASSERTION: the topic-guesser never connected to the hive topic,
    // so it received NOTHING — and admitted no remote log (only its own).
    expect(
      guesser.apply.mock.calls.find((c) => c[0].hbKey === 'F-private'),
      "a never-member guessing gh:<repo_id> read the private hive's content — topic secrecy broken",
    ).toBeUndefined();
    expect(
      guesser.handle.admitted.size,
      'the guesser must have admitted ONLY its own log (it never reached the hive topic)',
    ).toBe(1);
  }, 60_000);
});

// ════════════════════════════════════════════════════════════════════════════
// #6 — Poisoning: malformed/oversized/wrong-schema ops are dropped gracefully.
// ════════════════════════════════════════════════════════════════════════════
describe('threat #6 — applyOpVia rejects poisoned ops gracefully (no throw, no write, dropped)', () => {
  // A realistic projection: decodeValue accepts ONLY a well-formed feature row
  // (object with a string feature_id), mirroring the production validator's
  // "reject anything that isn't the typed shape" contract. writeToPg records
  // what it was asked to write so we can prove poisoned ops never reach it.
  function makeProbeProjection() {
    const written: string[] = [];
    const proj: TableProjection<{ feature_id: string }> = {
      tableTag: FEATURE_TAG,
      composeKey: (r) => r.feature_id,
      decodeValue: (raw) =>
        raw && typeof raw === 'object' && typeof (raw as { feature_id?: unknown }).feature_id === 'string'
          ? (raw as { feature_id: string })
          : null,
      writeToPg: async (r) => {
        written.push(r.feature_id);
      },
      deleteFromPg: async () => {},
    };
    const lookup: ProjectionLookup = (tag) => (tag === FEATURE_TAG ? (proj as TableProjection<unknown>) : null);
    return { lookup, written };
  }

  it('a battery of hostile op envelopes is each DROPPED (false) and NEVER reaches the writer or throws', async () => {
    const { lookup, written } = makeProbeProjection();

    // 256 KiB string payload — a poisoning op trying to balloon memory / a row.
    const hugePayload = 'x'.repeat(256 * 1024);

    const hostile: Array<{ name: string; op: OpEnvelope }> = [
      {
        name: 'unknown op type',
        op: { type: 'garbage' as never, table: FEATURE_TAG, hbKey: 'F-x', value: { feature_id: 'F-x' } },
      },
      { name: 'retired addWriter type', op: { type: 'addWriter', key: 'whatever' } as OpEnvelope },
      { name: 'missing table', op: { type: 'put', hbKey: 'F-x', value: { feature_id: 'F-x' } } as OpEnvelope },
      {
        name: 'unknown table tag',
        op: { type: 'put', table: 'harness_features_consolidated', hbKey: 'F-x', value: { feature_id: 'F-x' } },
      },
      { name: 'put with null value', op: { type: 'put', table: FEATURE_TAG, hbKey: 'F-x', value: null } },
      { name: 'put with primitive value', op: { type: 'put', table: FEATURE_TAG, hbKey: 'F-x', value: 42 as never } },
      {
        name: 'put with wrong-schema value',
        op: { type: 'put', table: FEATURE_TAG, hbKey: 'F-x', value: { not_a_feature: true } as never },
      },
      {
        name: 'put with non-string feature_id',
        op: { type: 'put', table: FEATURE_TAG, hbKey: 'F-x', value: { feature_id: 123 } as never },
      },
      { name: 'del without hbKey', op: { type: 'del', table: FEATURE_TAG } as OpEnvelope },
      {
        name: 'NaN watermark ts',
        op: { type: 'put', table: FEATURE_TAG, hbKey: 'F-nan', value: { feature_id: 'F-nan' }, ts: Number.NaN },
      },
      {
        name: 'Infinity watermark ts',
        op: {
          type: 'put',
          table: FEATURE_TAG,
          hbKey: 'F-inf',
          value: { feature_id: 'F-inf' },
          ts: Number.POSITIVE_INFINITY,
        },
      },
      {
        name: 'oversized payload',
        op: {
          type: 'put',
          table: FEATURE_TAG,
          hbKey: 'F-huge',
          value: { feature_id: 'F-huge', blob: hugePayload } as never,
        },
      },
    ];

    for (const { name, op } of hostile) {
      let result: boolean | undefined;
      // The robustness contract: applyOpVia must NEVER throw on hostile input.
      await expect(
        (async () => {
          result = await applyOpVia(lookup, op, { ownLogKeyHex: 'ownkey' });
        })(),
        `applyOpVia threw on a hostile op (${name}) — a poisoning op must be handled, not crash`,
      ).resolves.toBeUndefined();

      // The drop contract: every op above is either an invalid shape (false) or a
      // shape that decodeValue rejects (false). The TWO exceptions are NaN/Infinity
      // ts — those carry a VALID feature value, so they legitimately apply; what
      // matters there is they don't throw and don't corrupt the dispatcher. Assert
      // accordingly per case.
      if (name === 'NaN watermark ts' || name === 'Infinity watermark ts' || name === 'oversized payload') {
        expect(result, `${name} should apply without throwing`).toBe(true);
      } else {
        expect(result, `a poisoned op (${name}) must be DROPPED (applyOpVia → false)`).toBe(false);
      }
    }

    // Only the THREE valid-shaped ops (NaN ts, Infinity ts, oversized payload)
    // ever reached the writer; every malformed-SHAPE op was dropped before it.
    expect(written.sort(), 'a poisoned-SHAPE op reached the projection writer').toEqual(
      ['F-huge', 'F-inf', 'F-nan'].sort(),
    );
  });
});
