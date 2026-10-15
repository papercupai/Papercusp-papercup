/**
 * policy-set route — claim-gate unit tests (shared-hive-owner-enforcement EN-1, the
 * S0 authority property). Drives `runSetPolicy` with injected deps so the gate + the
 * author are tested without GitHub / PG / the keychain.
 *
 * S0: ONLY a `claimed` Hive + a viewer who is a claimant may write policy. A
 * non-claimant → 403, an unclaimed Hive → 403. TEETH (brief EN-1): the non-claimant
 * case asserts 403 AND the SAME setup with the viewer flipped to a claimant asserts
 * 200 — so removing the claimant-membership check (the gate) flips the reject test RED.
 */
import { describe, it, expect, vi } from 'vitest';
import { runSetPolicy, type SetPolicyDeps, type ClaimGateRow } from './policy-set';
import type { ResolvedHivePolicy } from '../../../hive-policy-store';
import routes from './policy-set';

vi.mock('../../../hive-identity', () => ({ isCanonicalHiveOwner: vi.fn().mockResolvedValue(false) }));
vi.mock('../../../identity/resolve-local-github-identity', () => ({ resolveLocalGithubIdentity: vi.fn().mockResolvedValue({ kind: 'ok', githubUserId: 42, githubLogin: 'fixture' }) }));
vi.mock('../../../federated-pot-scope', () => ({ resolveFederatedPotScope: vi.fn().mockResolvedValue('canonical-home') }));
vi.mock('../../../hive-membership-admission', () => ({ approvePendingJoin: vi.fn().mockResolvedValue({ ok: true, status: 'approved' }), denyPendingJoin: vi.fn().mockResolvedValue({ ok: true, status: 'denied' }) }));
vi.mock('../../../sync-sse', () => ({ notifySyncInvalidate: vi.fn().mockResolvedValue(undefined) }));

const WS = 'ws';
const HOME = 'home';
const CLAIMANT = 4242;
const OUTSIDER = 9999;

function resolved(): ResolvedHivePolicy {
  return {
    workspaceId: WS, potHomeSlug: HOME, policy: { membership: 'open' }, policyVersion: 1,
    ownerPubkey: 'pk', signature: 'sig', policyJson: '{"membership":"open"}', fedHlc: 'h', updatedAt: 1,
  };
}

function deps(over: Partial<SetPolicyDeps> = {}): SetPolicyDeps {
  return {
    viewerGithubId: vi.fn(async () => CLAIMANT),
    readClaimGate: vi.fn(async (): Promise<ClaimGateRow | null> => ({ claimStatus: 'claimed', claimedGithubUserIds: [CLAIMANT] })),
    author: vi.fn(async () => ({ ok: true as const, policy: resolved() })),
    ...over,
  };
}

const goodBody = { policy: { membership: 'approval', rate: { opsPerMin: 10 } } };

describe('Workbench desktop membership adapter', () => {
  const ctx = { params: { id: 'local-home' }, principal: null, input: undefined, log: () => {}, signal: new AbortController().signal };
  const route = routes.find(r => r.path === '/pot/:id/membership' && r.method === 'POST')!;
  it('does not admit a contributor from a device that is not the canonical owner', async () => {
    const { isCanonicalHiveOwner } = await import('../../../hive-identity');
    const { approvePendingJoin } = await import('../../../hive-membership-admission');
    vi.mocked(isCanonicalHiveOwner).mockResolvedValue(false); vi.mocked(approvePendingJoin).mockClear();
    const response = await route.handler(new Request('http://localhost/api/pot/local-home/membership', { method: 'POST', body: JSON.stringify({ githubUserId: 99, decision: 'approve' }) }), ctx);
    expect(response.status).toBe(403); expect(approvePendingJoin).not.toHaveBeenCalled();
  });
  it('uses the canonical scope and server identity for owner-approved admission, and rejects an unrelated origin', async () => {
    const { isCanonicalHiveOwner } = await import('../../../hive-identity');
    const { approvePendingJoin } = await import('../../../hive-membership-admission');
    vi.mocked(isCanonicalHiveOwner).mockResolvedValue(true); vi.mocked(approvePendingJoin).mockClear();
    const request = (origin?: string) => new Request('http://localhost/api/pot/local-home/membership', { method: 'POST', headers: origin ? { origin } : {}, body: JSON.stringify({ githubUserId: 99, decision: 'approve', workspace: 'forged-workspace', pot: 'forged-home' }) });
    expect((await route.handler(request('https://unrelated.invalid'), ctx)).status).toBe(403);
    expect(approvePendingJoin).not.toHaveBeenCalled();
    const response = await route.handler(request(), ctx);
    expect(response.status).toBe(200);
    expect(approvePendingJoin).toHaveBeenCalledWith(expect.objectContaining({ potHomeSlug: 'canonical-home', githubUserId: 99, decidedByGithubUserId: 42 }));
  });
});

describe('runSetPolicy claim gate (S0 authority)', () => {
  it('passes the reviewed version to the owner author and reports concurrent changes as conflict', async () => {
    const d = deps({ author: vi.fn(async () => ({ ok: false as const, code: 'policy_version_conflict' as const })) });
    const res = await runSetPolicy(WS, HOME, { ...goodBody, expectedPolicyVersion: 7 }, d);
    expect(res.status).toBe(409);
    expect(d.author).toHaveBeenCalledWith(expect.objectContaining({ expectedPolicyVersion: 7 }));
    expect((await runSetPolicy(WS, HOME, { ...goodBody, expectedPolicyVersion: -1 }, d)).status).toBe(400);
  });
  it('claimed Hive + claimant viewer → 200, author invoked with the coerced policy', async () => {
    const d = deps();
    const res = await runSetPolicy(WS, HOME, goodBody, d);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(d.author).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS, potHomeSlug: HOME }));
  });

  it('TEETH: claimed Hive + NON-claimant viewer → 403; flipping viewer to a claimant → 200', async () => {
    // Same Hive/gate; only the viewer identity differs. The 403 is caused SOLELY by the
    // claimant-membership check — remove it and this reject flips to 200 (RED).
    const gate = async (): Promise<ClaimGateRow> => ({ claimStatus: 'claimed', claimedGithubUserIds: [CLAIMANT] });

    const reject = await runSetPolicy(WS, HOME, goodBody, deps({ viewerGithubId: async () => OUTSIDER, readClaimGate: gate }));
    expect(reject.status).toBe(403);
    expect(reject.body.ok).toBe(false);
    if (!reject.body.ok) expect(reject.body.error).toBe('not_a_claimant');

    const allow = await runSetPolicy(WS, HOME, goodBody, deps({ viewerGithubId: async () => CLAIMANT, readClaimGate: gate }));
    expect(allow.status).toBe(200); // proves the gate (not something else) blocked the outsider
  });

  it('unclaimed Hive → 403 (provisional owner can\'t lock down)', async () => {
    const res = await runSetPolicy(WS, HOME, goodBody, deps({
      readClaimGate: async () => ({ claimStatus: 'unclaimed', claimedGithubUserIds: [] }),
    }));
    expect(res.status).toBe(403);
    if (!res.body.ok) expect(res.body.error).toBe('hive_unclaimed');
  });

  it('no binding at all → 403', async () => {
    const res = await runSetPolicy(WS, HOME, goodBody, deps({ readClaimGate: async () => null }));
    expect(res.status).toBe(403);
  });

  it('missing gh-auth (viewer null) → 401', async () => {
    const res = await runSetPolicy(WS, HOME, goodBody, deps({ viewerGithubId: async () => null }));
    expect(res.status).toBe(401);
  });

  it('claimant but this Swarm does NOT hold the Hive key → 409 not_owner_swarm', async () => {
    const res = await runSetPolicy(WS, HOME, goodBody, deps({
      author: async () => ({ ok: false as const, code: 'not_owner_swarm', detail: 'no key' }),
    }));
    expect(res.status).toBe(409);
    if (!res.body.ok) expect(res.body.error).toBe('not_owner_swarm');
  });

  it('bad body / invalid policy → 400 (and the author is never called)', async () => {
    const d = deps();
    expect((await runSetPolicy(WS, HOME, {}, d)).status).toBe(400); // no policy key
    expect((await runSetPolicy(WS, HOME, { policy: { membership: 'tyrant' } }, d)).status).toBe(400);
    expect(d.author).not.toHaveBeenCalled();
  });
});

/**
 * WI-1918: the topic-fallback claim gate. A from-repo Hive's binding rows are
 * keyed by MEMBER slug (hive-publish-from-repo step 6), so the home-slug lookup
 * misses and — before the fallback — the gate returned null forever
 * (hive_unclaimed 403 even after a legitimate claimBinding). The fallback
 * resolves the hive pubkey → federation topic → accepts CLAIMED member bindings
 * on that topic (claimants = union). TEETH: the member-claimed case asserts a
 * claimed gate, and the same setup with no claimed member rows asserts null —
 * removing the fallback flips the first test RED.
 */
import { readClaimGateWithTopicFallback, type ClaimGateReadSeams } from './policy-set';

describe('readClaimGateWithTopicFallback (WI-1918)', () => {
  const PK = 'cHVia2V5LWJ5dGVzLWZvci10ZXN0LW9ubHk='; // any base64 — topic derivation just needs bytes

  function seams(over: Partial<ClaimGateReadSeams> = {}): ClaimGateReadSeams {
    return {
      querySlugRow: vi.fn(async () => null),
      queryClaimedTopicRows: vi.fn(async () => [
        { claimStatus: 'claimed' as const, claimedGithubUserIds: [1, 2] },
        { claimStatus: 'claimed' as const, claimedGithubUserIds: [2, 3] },
      ]),
      loadPubkey: vi.fn(async () => PK),
      ...over,
    };
  }

  it('direct slug row wins — no fallback consulted', async () => {
    const s = seams({
      querySlugRow: vi.fn(async () => ({ claimStatus: 'claimed' as const, claimedGithubUserIds: [7] })),
    });
    const gate = await readClaimGateWithTopicFallback(WS, HOME, s);
    expect(gate).toEqual({ claimStatus: 'claimed', claimedGithubUserIds: [7] });
    expect(s.loadPubkey).not.toHaveBeenCalled();
  });

  it('member-slug-keyed rows (from-repo hive): claimed member bindings on the hive topic pass the gate, claimants unioned', async () => {
    const s = seams();
    const gate = await readClaimGateWithTopicFallback(WS, HOME, s);
    expect(gate).toEqual({ claimStatus: 'claimed', claimedGithubUserIds: [1, 2, 3] });
    expect(s.queryClaimedTopicRows).toHaveBeenCalledTimes(1);
  });

  it('no claimed member rows ⇒ null (unclaimed 403 semantics preserved)', async () => {
    const s = seams({ queryClaimedTopicRows: vi.fn(async () => []) });
    expect(await readClaimGateWithTopicFallback(WS, HOME, s)).toBeNull();
  });

  it('no hive pubkey (not the owner swarm / unknown hive) ⇒ null, topic query never runs', async () => {
    const s = seams({ loadPubkey: vi.fn(async () => null) });
    expect(await readClaimGateWithTopicFallback(WS, HOME, s)).toBeNull();
    expect(s.queryClaimedTopicRows).not.toHaveBeenCalled();
  });

  it('pubkey loader throwing ⇒ null, never a 500 path', async () => {
    const s = seams({ loadPubkey: vi.fn(async () => { throw new Error('keychain sealed'); }) });
    expect(await readClaimGateWithTopicFallback(WS, HOME, s)).toBeNull();
  });
});
