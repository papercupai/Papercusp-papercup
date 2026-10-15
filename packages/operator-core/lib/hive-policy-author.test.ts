/**
 * hive-policy-author — unit tests (shared-hive-owner-enforcement EN-1, build step 3).
 *
 * Drives the OWNER-side sign+write with injected seams. The key teeth: the signature
 * the author produces VERIFIES over the canonical signed bytes for the bumped version
 * (author ↔ schema ↔ ed25519 agree — the "sign" half of the S0 roundtrip), the version
 * is monotone, and a Swarm without the Hive key is refused.
 */
import { describe, it, expect, vi } from 'vitest';
import { authorHivePolicy, mutateHivePolicy, type AuthorHivePolicySeams } from './hive-policy-author';
import { canonicalizeHivePolicy, hivePolicySignedBytes, type HivePolicy } from './hive-policy-schema';
import type { ResolvedHivePolicy } from './hive-policy-store';
import { generateEd25519KeypairDer, signWithPrivateKeyDer, verifyEd25519 } from './identity/ed25519';

const WS = 'ws';
const HOME = 'home';

/**
 * EI-19311807188719573 / WI-6915: `resolveWorkspaceId` DEFAULTS to the real
 * `resolveHiveWorkspaceId`, which opens the live `org-admin` Postgres pool. Every test
 * below injects the other seams, so an un-injected resolver was the ONE escaped mock —
 * these unit tests were silently reading the developer's real database on every run
 * until the no-real-PG rail surfaced it.
 *
 * Identity resolver for the cases that are NOT exercising the resolution step. The two
 * WI-5321/WI-5061 tests deliberately inject their own asserting version instead — do
 * not replace those with this one, it would erase what they exist to prove.
 */
const IDENTITY_RESOLVE: NonNullable<AuthorHivePolicySeams['resolveWorkspaceId']> = async (ws) => ws;

function writeCapture() {
  const writes: Array<{ workspaceId: string; policyJson: string; signature: string; ownerPubkey: string; policyVersion: number }> = [];
  const write: AuthorHivePolicySeams['write'] = async (input) => {
    writes.push(input);
    const resolved: ResolvedHivePolicy = {
      workspaceId: input.workspaceId, potHomeSlug: input.potHomeSlug,
      policy: JSON.parse(input.policyJson), policyVersion: input.policyVersion,
      ownerPubkey: input.ownerPubkey, signature: input.signature, policyJson: input.policyJson,
      fedHlc: 'h', updatedAt: 1,
    };
    return resolved;
  };
  return { writes, write };
}

describe('authorHivePolicy', () => {
  it('refuses a stale reviewed version before signing or writing', async () => {
    const sign = async () => { throw new Error('must not sign'); };
    const write = async () => { throw new Error('must not write'); };
    expect(await authorHivePolicy({ workspaceId: WS, potHomeSlug: HOME, policy: {}, expectedPolicyVersion: 4 }, {
      resolveWorkspaceId: IDENTITY_RESOLVE, loadOwnerPubkey: async () => 'key', readCurrent: async () => ({ policyVersion: 5 } as ResolvedHivePolicy), sign, write,
    })).toMatchObject({ ok: false, code: 'policy_version_conflict' });
  });
  it('signs the bumped version and the signature VERIFIES over the canonical bytes', async () => {
    const kp = generateEd25519KeypairDer();
    const { writes, write } = writeCapture();
    const policy: HivePolicy = { membership: 'allowlist', allowlist: ['octocat'], rate: { opsPerMin: 5 } };

    const res = await authorHivePolicy({ workspaceId: WS, potHomeSlug: HOME, policy }, {
      resolveWorkspaceId: IDENTITY_RESOLVE,
      readCurrent: async () => ({ policyVersion: 5 } as ResolvedHivePolicy), // current v5 → author writes v6
      loadOwnerPubkey: async () => kp.pubkeyBase64,
      sign: async (_ws, _slug, bytes) => signWithPrivateKeyDer(kp.privateKeyDer, bytes),
      write,
    });

    expect(res.ok).toBe(true);
    expect(writes).toHaveLength(1);
    expect(writes[0].policyVersion).toBe(6); // monotone bump
    expect(writes[0].ownerPubkey).toBe(kp.pubkeyBase64);

    // The produced signature verifies over the SAME bytes a member's projection recomputes.
    const expectedBytes = hivePolicySignedBytes({
      workspaceId: WS, potHomeSlug: HOME, policyVersion: 6,
      canonicalPolicyJson: canonicalizeHivePolicy(policy),
    });
    expect(writes[0].policyJson).toBe(canonicalizeHivePolicy(policy));
    expect(verifyEd25519(expectedBytes, kp.pubkeyBase64, Buffer.from(writes[0].signature, 'base64'))).toBe(true);
  });

  it('first author (no current policy) starts at version 1', async () => {
    const kp = generateEd25519KeypairDer();
    const { writes, write } = writeCapture();
    await authorHivePolicy({ workspaceId: WS, potHomeSlug: HOME, policy: {} }, {
      resolveWorkspaceId: IDENTITY_RESOLVE,
      readCurrent: async () => null,
      loadOwnerPubkey: async () => kp.pubkeyBase64,
      sign: async (_ws, _slug, bytes) => signWithPrivateKeyDer(kp.privateKeyDer, bytes),
      write,
    });
    expect(writes[0].policyVersion).toBe(1);
  });

  it('a Swarm without the Hive key is refused (not_owner_swarm) — never writes', async () => {
    const write = vi.fn();
    const res = await authorHivePolicy({ workspaceId: WS, potHomeSlug: HOME, policy: {} }, {
      resolveWorkspaceId: IDENTITY_RESOLVE,
      loadOwnerPubkey: async () => null, // not the owner Swarm
      write: write as never,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('not_owner_swarm');
    expect(write).not.toHaveBeenCalled();
  });

  it('sign throwing (key not held) maps to not_owner_swarm', async () => {
    const res = await authorHivePolicy({ workspaceId: WS, potHomeSlug: HOME, policy: {} }, {
      resolveWorkspaceId: IDENTITY_RESOLVE,
      loadOwnerPubkey: async () => 'pk',
      readCurrent: async () => null,
      sign: async () => { throw new Error('hive private key not held'); },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('not_owner_swarm');
  });

  it('WI-5321/WI-5061: resolves the ambient workspaceId to the Hive\'s TRUE (historical) one before every other seam — keychain lookup, sign, AND the signature binding all agree', async () => {
    const kp = generateEd25519KeypairDer();
    const { writes, write } = writeCapture();
    const TRUE_WS = 'default'; // the pre-WI-5321 workspace the row+key actually live under
    const seen: { loadOwnerPubkey: string[]; readCurrent: string[]; sign: string[] } = {
      loadOwnerPubkey: [], readCurrent: [], sign: [],
    };

    const res = await authorHivePolicy({ workspaceId: WS, potHomeSlug: HOME, policy: {} }, {
      resolveWorkspaceId: async (ambientWs, slug) => {
        expect(ambientWs).toBe(WS); // resolver receives the RAW ambient id, unresolved
        expect(slug).toBe(HOME);
        return TRUE_WS;
      },
      loadOwnerPubkey: async (ws) => { seen.loadOwnerPubkey.push(ws); return kp.pubkeyBase64; },
      readCurrent: async (ws) => { seen.readCurrent.push(ws); return null; },
      sign: async (ws, _slug, bytes) => { seen.sign.push(ws); return signWithPrivateKeyDer(kp.privateKeyDer, bytes); },
      write,
    });

    expect(res.ok).toBe(true);
    // Every downstream seam got the RESOLVED (true) workspace, never the raw ambient one.
    expect(seen.loadOwnerPubkey).toEqual([TRUE_WS]);
    expect(seen.readCurrent).toEqual([TRUE_WS]);
    expect(seen.sign).toEqual([TRUE_WS]);
    expect(writes[0].workspaceId).toBe(TRUE_WS);
    // The signature verifies over bytes bound to the RESOLVED workspaceId — consistent
    // with what a member's projection will recompute against the row's own workspace_id.
    const expectedBytes = hivePolicySignedBytes({
      workspaceId: TRUE_WS, potHomeSlug: HOME, policyVersion: 1,
      canonicalPolicyJson: canonicalizeHivePolicy({}),
    });
    expect(verifyEd25519(expectedBytes, kp.pubkeyBase64, Buffer.from(writes[0].signature, 'base64'))).toBe(true);
  });

});

describe('mutateHivePolicy (EN-3 ban/takedown write accessor)', () => {
  it('appends to moderation.bannedGithubIds while PRESERVING unknown keys + re-signs', async () => {
    const kp = generateEd25519KeypairDer();
    const { writes, write } = writeCapture();
    const current: ResolvedHivePolicy = {
      workspaceId: WS, potHomeSlug: HOME,
      policy: { membership: 'approval', moderation: { bannedGithubIds: ['1'] }, futureKnob: 'keep' },
      policyVersion: 2, ownerPubkey: kp.pubkeyBase64, signature: 's', policyJson: '{}', fedHlc: 'h', updatedAt: 1,
    };

    const res = await mutateHivePolicy({
      workspaceId: WS, potHomeSlug: HOME,
      mutate: (p) => ({ ...p, moderation: { ...p.moderation, bannedGithubIds: [...(p.moderation?.bannedGithubIds ?? []), '2'] } }),
    }, {
      resolveWorkspaceId: IDENTITY_RESOLVE,
      readCurrent: async () => current,
      loadOwnerPubkey: async () => kp.pubkeyBase64,
      sign: async (_ws, _slug, bytes) => signWithPrivateKeyDer(kp.privateKeyDer, bytes),
      write,
    });

    expect(res.ok).toBe(true);
    const written = JSON.parse(writes[0].policyJson) as HivePolicy;
    expect(written.moderation?.bannedGithubIds).toEqual(['1', '2']);
    expect(written.futureKnob).toBe('keep'); // forward-compat preserved through the mutate
    expect(writes[0].policyVersion).toBe(3); // bumped from current 2
  });

  it('WI-5321/WI-5061: resolves the ambient workspaceId BEFORE its own readCurrent, and threads the resolved id into authorHivePolicy', async () => {
    const kp = generateEd25519KeypairDer();
    const { writes, write } = writeCapture();
    const TRUE_WS = 'default';
    const readCurrentSeen: string[] = [];

    const res = await mutateHivePolicy({
      workspaceId: WS, potHomeSlug: HOME,
      mutate: (p) => ({ ...p, moderation: { ...p.moderation, takedownList: ['ref-1'] } }),
    }, {
      // Called twice (once by mutateHivePolicy itself, once inside the authorHivePolicy
      // it delegates to) — mirror the real resolver's idempotent fast path: resolving
      // an already-resolved id is a no-op, so both calls converge on TRUE_WS.
      resolveWorkspaceId: async (ambientWs) => (ambientWs === WS ? TRUE_WS : ambientWs),
      readCurrent: async (ws) => { readCurrentSeen.push(ws); return null; },
      loadOwnerPubkey: async () => kp.pubkeyBase64,
      sign: async (_ws, _slug, bytes) => signWithPrivateKeyDer(kp.privateKeyDer, bytes),
      write,
    });

    expect(res.ok).toBe(true);
    // Called twice (mutateHivePolicy's own read for `mutate()`'s input, then again
    // inside authorHivePolicy's version-bump step) — BOTH with the resolved id, never
    // the raw ambient one, else one of them would read the wrong (empty) policy row.
    expect(readCurrentSeen).toEqual([TRUE_WS, TRUE_WS]);
    expect(writes[0].workspaceId).toBe(TRUE_WS);
  });
});
