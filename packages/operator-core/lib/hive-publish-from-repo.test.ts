/**
 * hive-publish-from-repo.test.ts — the visibility-gated publish step (P-007).
 * All seams faked. Verifies the D-002/D-003/D-004 gates: public = directory +
 * Cupboard rows per member repo; invite = secret-topic announce only, NO
 * Cupboard; private never reaches this module.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  publishCreatedHive,
  resolveHiveMemberJoinLinks,
  type PublishCreatedHiveDeps,
} from './hive-publish-from-repo';
import { parseHarnessLink } from './harness/url-scheme';
import { parseHiveInviteLink } from './harness/hive-invite-link';
import {
  deriveHiveFederationTopic,
  topicAsHex,
} from './sync/hyperbee/derive-swarm-topic';
import type { ProjectEntry } from './harness-registry';

// Records the identityMode the DEFAULT owner resolver asks for (WI-10006697). Every other
// test injects resolveOwner, so this mock is only reached when a test omits it.
const identityCalls = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('./sync/hyperbee/local-announce-identity', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveLocalAnnounceIdentity: async (opts: Record<string, unknown>) => {
    identityCalls.push(opts);
    return { githubLogin: 'alice', githubUserId: 1, devicePubkeyBase64: 'dpk', attestationGistId: 'gist' };
  },
}));

const HIVE_PUBKEY = Buffer.alloc(32, 7).toString('base64');
/** Hardening P-006: a real hex secret so the invite-link artifact round-trips. */
const INVITE_SECRET = 'c0ffee'.repeat(8); // 48 hex chars

function members(): ProjectEntry[] {
  return [
    { slug: 'shop-hive', path: '/hives/shop-hive', harness_kind: 'hive' },
    {
      slug: 'shop',
      path: '/clones/shop',
      hive_slug: 'shop-hive',
      github_remote: 'https://github.com/acme/shop.git',
      github_repository_id: 100,
      github_default_branch: 'main',
    },
    {
      slug: 'docs',
      path: '/clones/docs',
      hive_slug: 'shop-hive',
      github_remote: 'https://github.com/acme/docs.git',
      // no repo id — should be skipped by the Cupboard + local-binding legs
    },
  ];
}

function fakes(over: Partial<PublishCreatedHiveDeps> = {}) {
  const calls = {
    savedMeta: [] as Record<string, unknown>[],
    published: [] as Record<string, unknown>[],
    listings: [] as Record<string, unknown>[],
    localBindings: [] as Record<string, unknown>[],
    rekeyed: [] as Array<{ ws: string; slug: string }>,
  };
  const deps: PublishCreatedHiveDeps = {
    saveMeta: async (meta) => {
      calls.savedMeta.push(meta as unknown as Record<string, unknown>);
    },
    ensureWired: async () => null,
    resolveOwner: async () => ({
      githubLogin: 'alice',
      githubUserId: 1,
      devicePubkey: 'dpk',
      attestationGistId: 'gist',
    }),
    loadPubkey: async () => HIVE_PUBKEY,
    loadRegistry: async () => ({ projects: members() }),
    deriveMemberRepos: async () => ['acme/shop#100', 'acme/docs'],
    publishDirectory: async (_dir, meta) => {
      calls.published.push(meta as unknown as Record<string, unknown>);
      return { registered: true, announced: true, reachablePeers: 2, visibility: meta.visibility };
    },
    getDirectory: () => ({}) as never,
    publishListing: async (input) => {
      calls.listings.push(input);
      return { ok: true };
    },
    createLocalBinding: async (input) => {
      calls.localBindings.push(input as unknown as Record<string, unknown>);
    },
    rekeyHarness: async (ws, slug) => {
      calls.rekeyed.push({ ws, slug });
    },
    now: () => 1_700_000_000_000,
    randomSecret: () => INVITE_SECRET,
    ...over,
  };
  return { deps, calls };
}

const BASE = {
  workspaceId: 'ws',
  potSlug: 'shop-hive',
  title: 'acme/shop',
  description: 'Hive for acme/shop',
} as const;

describe('publishCreatedHive (P-007)', () => {
  it('public: saves meta, announces with pubkey + member repos + links, registers Cupboard rows + local bindings', async () => {
    const { deps, calls } = fakes();
    const out = await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);

    expect(out.announced).toBe(true);
    expect(calls.savedMeta[0]).toMatchObject({ potId: 'shop-hive', visibility: 'public' });

    const announced = calls.published[0];
    expect(announced.hivePubkey).toBe(HIVE_PUBKEY);
    expect(announced.memberRepos).toEqual(['acme/shop#100', 'acme/docs']);
    // one-click link only for the id-bearing member, over the HIVE federation topic
    const links = announced.memberLinks as string[];
    expect(links).toHaveLength(1);
    expect(links[0]).toContain('papercusp://harness?');
    expect(links[0]).toContain('repo_id=100');
    // WI-259 guard (EI-1746 / green-rig coverage): the one-click link MUST carry
    // the OWNER's HIVE-PUBKEY topic. The joiner persists this `topic=` verbatim
    // (join-shared-harness) and federates on it (the `topic:` binding carrier). A
    // regression that built the link from the gh-repo topic (or any other) would
    // strand the joiner on a DIFFERENT swarm topic than the owner → the join-merge
    // backfill lands but incremental writes NEVER cross (the from-repo A→B stall).
    // Pin topic == deriveHiveFederationTopic(hivePubkey), not just "a topic exists".
    const linkTopic = /[?&]topic=([0-9a-f]{64})/i.exec(links[0])?.[1];
    expect(linkTopic).toBe(topicAsHex(deriveHiveFederationTopic(HIVE_PUBKEY)));

    // Cupboard: one row per id-bearing member repo, carrying the hive identity.
    expect(out.cupboard).toMatchObject({ attempted: true, rowsCreated: 1, rowsFailed: 0 });
    expect(calls.listings[0]).toMatchObject({
      listing_kind: 'harness',
      github_repository_id: 100,
      hive_pubkey: HIVE_PUBKEY,
      hive_title: 'acme/shop',
    });

    expect(out.localBindings).toEqual({ created: 1, existed: 0, failed: 0 });
    expect(calls.localBindings[0]).toMatchObject({ harness_slug: 'shop', privacy: 'shared-public' });
  });

  it('publish forces lazy directory wiring so a recent failed list/read probe cannot strand the announce', async () => {
    const ensureWired = async (_workspaceId: string, opts?: { force?: boolean }) => {
      expect(opts).toEqual({ force: true });
      return null;
    };
    const { deps } = fakes({ ensureWired });
    await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);
  });

  it('invite: announces on the secret topic, returns the secret, NO Cupboard rows (D-003)', async () => {
    const { deps, calls } = fakes();
    const out = await publishCreatedHive({ ...BASE, visibility: 'invite' }, deps);
    expect(out.inviteSecret).toBe(INVITE_SECRET);
    expect(calls.savedMeta[0]).toMatchObject({ visibility: 'invite', inviteSecret: INVITE_SECRET });
    expect(out.cupboard).toEqual({ attempted: false, skipped: 'invite' });
    expect(calls.listings).toEqual([]);
    // local rows still land (a LOCAL row leaks nothing off-box)
    expect(calls.localBindings[0]).toMatchObject({ privacy: 'shared-private' });
  });

  it('invite: formats the FULL invite-link artifact — pubkey + secret + title (hardening P-006/D-006)', async () => {
    const { deps } = fakes();
    const out = await publishCreatedHive({ ...BASE, visibility: 'invite' }, deps);
    expect(out.hivePubkey).toBe(HIVE_PUBKEY);
    expect(out.inviteLink).toBeDefined();
    expect(out.inviteLink!.startsWith('papercusp://pot?')).toBe(true);
    expect(parseHiveInviteLink(out.inviteLink!)).toEqual({
      secret: INVITE_SECRET,
      pubkeyBase64: HIVE_PUBKEY,
      title: 'acme/shop',
    });
  });

  it('invite without a loadable pubkey: the invite link degrades to secret-only and still parses (P-006)', async () => {
    const { deps } = fakes({ loadPubkey: async () => null });
    const out = await publishCreatedHive({ ...BASE, visibility: 'invite' }, deps);
    expect(out.hivePubkey).toBeUndefined();
    expect(parseHiveInviteLink(out.inviteLink!)).toEqual({
      secret: INVITE_SECRET,
      title: 'acme/shop',
    });
  });

  it('public: outcome carries the hive pubkey but mints no invite secret/link (P-006)', async () => {
    const { deps } = fakes();
    const out = await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);
    expect(out.hivePubkey).toBe(HIVE_PUBKEY);
    expect(out.inviteSecret).toBeUndefined();
    expect(out.inviteLink).toBeUndefined();
  });

  it('public: the OUTCOME surfaces the same member-join links + pubkey the announce carried — a fresh hive yields a join target (WI-931)', async () => {
    const { deps, calls } = fakes();
    const out = await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);
    // The from-repo `created` response can now hand a joiner everything POST
    // /api/discovery/join-pot needs — { potId, memberLinks, hivePubkey } —
    // WITHOUT a second directory round-trip. Same set the announce broadcast.
    expect(out.memberLinks).toEqual(calls.published[0].memberLinks);
    expect(out.hivePubkey).toBe(HIVE_PUBKEY);
    // …and those links pass discovery/join-pot's body validation (non-empty
    // strings, ≤ 64 — the exact gate that 400s "potId and memberLinks[] required").
    const links = out.memberLinks!;
    expect(links.length).toBeGreaterThan(0);
    expect(links.length).toBeLessThanOrEqual(64);
    expect(links.every((l) => typeof l === 'string' && l.length > 0)).toBe(true);
    expect(links[0]).toContain('papercusp://harness?');
  });

  it('invite: the OUTCOME also surfaces member-join links + pubkey (the secret-topic join target — WI-931)', async () => {
    const { deps, calls } = fakes();
    const out = await publishCreatedHive({ ...BASE, visibility: 'invite' }, deps);
    expect(out.memberLinks).toEqual(calls.published[0].memberLinks);
    expect(out.memberLinks!.length).toBeGreaterThan(0);
    expect(out.hivePubkey).toBe(HIVE_PUBKEY);
  });

  it('no hive pubkey: the outcome carries no member links (nothing joinable — WI-931)', async () => {
    const { deps } = fakes({ loadPubkey: async () => null });
    const out = await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);
    expect(out.memberLinks).toBeUndefined();
  });

  it('public + private repo: Cupboard skipped (the public registry refuses private repos)', async () => {
    const { deps, calls } = fakes();
    const out = await publishCreatedHive({ ...BASE, visibility: 'public', repoIsPrivate: true }, deps);
    expect(out.cupboard).toEqual({ attempted: false, skipped: 'private_repo' });
    expect(calls.listings).toEqual([]);
    expect(out.announced).toBe(true); // the directory announce still happens
  });

  it('no hive pubkey: no member links, Cupboard skipped, no local rows (no joinable topic)', async () => {
    const { deps, calls } = fakes({ loadPubkey: async () => null });
    const out = await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);
    expect(out.cupboard).toMatchObject({ skipped: 'no_hive_pubkey' });
    expect(calls.published[0].memberLinks).toBeUndefined();
    expect(out.localBindings).toEqual({ created: 0, existed: 0, failed: 0 });
  });

  it('BINDING_EXISTS counts as existed, other failures as failed', async () => {
    const { deps } = fakes({
      createLocalBinding: async () => {
        const e = new Error('exists') as Error & { code: string };
        e.code = 'BINDING_EXISTS';
        throw e;
      },
    });
    const out = await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);
    expect(out.localBindings).toEqual({ created: 0, existed: 1, failed: 0 });
  });

  it('auto-claims created rows via the worker claim path when permitted (hardening D-002)', async () => {
    const claimed: (string | number)[] = [];
    const { deps } = fakes({
      publishListing: async () => ({ ok: true, data: { id: 'listing-1' } }),
      claimListing: async (id) => {
        claimed.push(id);
        return { ok: true, status: 200 };
      },
    });
    const out = await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);
    expect(out.cupboard).toMatchObject({ rowsCreated: 1, rowsClaimed: 1 });
    expect(claimed).toEqual(['listing-1']);
  });

  it('insufficient permission leaves the row provisional — no claim, no error (D-002)', async () => {
    const { deps } = fakes({
      publishListing: async () => ({ ok: true, data: { id: 'listing-2' } }),
      claimListing: async () => ({ ok: false, status: 403, error: 'insufficient_permission' }),
    });
    const out = await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);
    expect(out.cupboard).toMatchObject({ rowsCreated: 1, rowsClaimed: 0, rowsFailed: 0 });
    expect(out.cupboard.errors).toBeUndefined();
  });

  it('a create response without an id skips the claim quietly', async () => {
    const { deps } = fakes({
      publishListing: async () => ({ ok: true }),
      claimListing: async () => {
        throw new Error('must not be called');
      },
    });
    const out = await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);
    expect(out.cupboard).toMatchObject({ rowsCreated: 1, rowsClaimed: 0 });
  });

  it('cupboard row failures are reported, never thrown', async () => {
    const { deps } = fakes({ publishListing: async () => ({ ok: false, error: 'gh_auth_required' }) });
    const out = await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);
    expect(out.cupboard).toMatchObject({ attempted: true, rowsCreated: 0, rowsFailed: 1 });
    expect(out.cupboard.errors?.[0]).toContain('gh_auth_required');
  });

  it('republishHiveAfterMemberAdd: scoped rows for the new member only; existing rows untouched (P-009)', async () => {
    const { deps, calls } = fakes({
      getMeta: async () => ({
        potId: 'shop-hive',
        title: 'acme/shop',
        description: '',
        visibility: 'public' as const,
        memberTopics: [],
        createdAt: 1,
      }),
      loadRegistry: async () => ({
        projects: [
          ...members(),
          {
            slug: 'newrepo',
            path: '/clones/newrepo',
            hive_slug: 'shop-hive',
            github_remote: 'https://github.com/acme/newrepo.git',
            github_repository_id: 200,
          },
        ],
      }),
      deriveMemberRepos: async () => ['acme/shop#100', 'acme/newrepo#200'],
    });
    const { republishHiveAfterMemberAdd } = await import('./hive-publish-from-repo');
    const out = await republishHiveAfterMemberAdd(
      { workspaceId: 'ws', potSlug: 'shop-hive', onlyRepoIds: [200] },
      deps,
    );
    if ('skipped' in out) throw new Error('expected a publish outcome');
    expect(out.announced).toBe(true);
    // announce carries ALL member repos (content), but new rows are scoped
    expect(calls.published[0].memberRepos).toEqual(['acme/shop#100', 'acme/newrepo#200']);
    expect(calls.listings).toHaveLength(1);
    expect(calls.listings[0]).toMatchObject({ github_repository_id: 200 });
    expect(calls.localBindings).toHaveLength(1);
    expect(calls.localBindings[0]).toMatchObject({ harness_slug: 'newrepo' });
  });

  it('republishHiveAfterMemberAdd: an unpublished/private hive is left untouched', async () => {
    const { deps, calls } = fakes({ getMeta: async () => null });
    const { republishHiveAfterMemberAdd } = await import('./hive-publish-from-repo');
    const out = await republishHiveAfterMemberAdd({ workspaceId: 'ws', potSlug: 'x' }, deps);
    expect(out).toEqual({ skipped: 'unpublished_hive' });
    expect(calls.published).toEqual([]);
  });

  it('saveMeta failure aborts with an error (nothing announced)', async () => {
    const { deps, calls } = fakes({
      saveMeta: async () => {
        throw new Error('pg down');
      },
    });
    const out = await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);
    expect(out.announced).toBe(false);
    expect(out.error).toContain('save_meta_failed');
    expect(calls.published).toEqual([]);
  });

  it('saveMeta failure on an invite hive still hands back the secret + a secret-only link (P-006)', async () => {
    const { deps } = fakes({
      saveMeta: async () => {
        throw new Error('pg down');
      },
    });
    const out = await publishCreatedHive({ ...BASE, visibility: 'invite' }, deps);
    expect(out.error).toContain('save_meta_failed');
    expect(out.inviteSecret).toBe(INVITE_SECRET);
    expect(parseHiveInviteLink(out.inviteLink!)).toEqual({
      secret: INVITE_SECRET,
      title: 'acme/shop',
    });
  });
});

// EI-681: the "go shared" reboot — publishing a hive must boot + swarm-join +
// start the outbox drain for the just-bound local member harnesses, or an
// owner's feature writes sit in substrate_outbox undrained and never federate.
describe('hive publish — go-shared reboot of local member harnesses (EI-681)', () => {
  it('re-keys the HIVE-HOME harness (A-003 a′) + the id-bearing local members (not id-less members)', async () => {
    const { deps, calls } = fakes();
    await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);
    // A-003 (a′): the hive-HOME harness (meta.potId='shop-hive') is re-keyed FIRST
    // so its hive_members/hive_settings outbox drains + it joins the topic. This is
    // SAFE on the shared topic now — dc9db's (a′) announce extension carries multiple
    // log announces per topic + the boot.ts slug-filter prevents cross-merge. Then the
    // members: shop (id=100) re-keys; docs (no repo id) is skipped (step 6 bound no
    // row for it).
    expect(calls.rekeyed).toEqual([
      { ws: 'ws', slug: 'shop-hive' },
      { ws: 'ws', slug: 'shop' },
    ]);
  });

  it('republishHiveAfterMemberAdd: re-keys the hive-home (A-003) + ONLY the new member (onlyRepoIds scope)', async () => {
    const { deps, calls } = fakes({
      getMeta: async () => ({
        potId: 'shop-hive',
        title: 'acme/shop',
        description: '',
        visibility: 'public' as const,
        memberTopics: [],
        createdAt: 1,
      }),
      loadRegistry: async () => ({
        projects: [
          ...members(),
          {
            slug: 'newrepo',
            path: '/clones/newrepo',
            hive_slug: 'shop-hive',
            github_remote: 'https://github.com/acme/newrepo.git',
            github_repository_id: 200,
          },
        ],
      }),
    });
    const { republishHiveAfterMemberAdd } = await import('./hive-publish-from-repo');
    await republishHiveAfterMemberAdd(
      { workspaceId: 'ws', potSlug: 'shop-hive', onlyRepoIds: [200] },
      deps,
    );
    // A-003 (a′): the hive-home re-keys on EVERY (re)publish (NOT onlyRepoIds-gated);
    // the member re-key stays onlyRepoIds-scoped to the new member.
    expect(calls.rekeyed).toEqual([
      { ws: 'ws', slug: 'shop-hive' },
      { ws: 'ws', slug: 'newrepo' },
    ]);
  });

  it('a reboot failure (sync throw or async reject) NEVER fails the publish, and never skips a later member', async () => {
    const rekeyed: string[] = [];
    const { deps } = fakes({
      loadRegistry: async () => ({
        projects: [
          ...members(),
          {
            slug: 'extra',
            path: '/clones/extra',
            hive_slug: 'shop-hive',
            github_remote: 'https://github.com/acme/extra.git',
            github_repository_id: 300,
          },
        ],
      }),
      deriveMemberRepos: async () => ['acme/shop#100', 'acme/extra#300'],
      // 'shop' throws SYNCHRONOUSLY (the harder case — a plain .catch can't
      // swallow it); 'extra' must still be rebooted and the publish must succeed.
      rekeyHarness: (_ws: string, slug: string) => {
        if (slug === 'shop') throw new Error('boom (sync)');
        rekeyed.push(slug);
        return Promise.resolve();
      },
    });
    const out = await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);
    expect(out.announced).toBe(true); // publish unaffected by the reboot throw
    // hive-home ('shop-hive') re-keys first, then the member loop: 'shop' throws
    // (caught), 'extra' still re-keys. The throw on 'shop' skips neither.
    expect(rekeyed).toEqual(['shop-hive', 'extra']);
  });

  it('async-rejecting reboot does not fail the publish', async () => {
    const { deps } = fakes({ rekeyHarness: async () => Promise.reject(new Error('reject')) });
    const out = await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);
    expect(out.announced).toBe(true);
  });

  it('no joinable topic (no hive pubkey) → no reboots', async () => {
    const { deps, calls } = fakes({ loadPubkey: async () => null });
    await publishCreatedHive({ ...BASE, visibility: 'public' }, deps);
    expect(calls.rekeyed).toEqual([]);
  });
});

// GA leaked-invite OUTER gate (shared-hive-public-release-readiness, security-review
// note #1 — the "unguessable" half). The strict PARSER floor is locked in
// hive-invite-link.test.ts, but the real DEFAULT mint is injectable and STUBBED in
// every test above (randomSecret: () => INVITE_SECRET), so nothing else asserts the
// SHIPPED secret is actually 256-bit CSPRNG *and* accepted by that same strict parser.
// A refactor of the default to randomUUID() (hyphens → fails SECRET_RE → an unparseable
// invite link) or to a shorter/low-entropy token would silently weaken or break invites,
// uncaught. Lock the real default here by running publishCreatedHive with `randomSecret`
// left undefined — `...over` spreads it last, so the deps drop the fake and
// publishCreatedHive falls through to its `randomBytes(32).toString('hex')` default while
// every other seam stays faked + hermetic.
describe('invite-secret mint strength — the real default CSPRNG (GA leaked-invite outer gate)', () => {
  const realMint = () => fakes({ randomSecret: undefined }); // → randomBytes(32) default

  it('mints a 256-bit (64 hex) secret that the SAME strict parser an invitee runs accepts', async () => {
    const { deps } = realMint();
    const out = await publishCreatedHive({ ...BASE, visibility: 'invite' }, deps);
    expect(out.inviteSecret).toMatch(/^[0-9a-f]{64}$/); // exactly 256 bits, lowercase hex
    // The artifact the owner hands out must round-trip through parseHiveInviteLink
    // (SECRET_RE 32–128 hex) — proving the mint cannot drift off the accepted format.
    const parsed = parseHiveInviteLink(out.inviteLink!);
    expect(parsed).not.toBeNull();
    expect(parsed!.secret).toBe(out.inviteSecret);
  });

  it('is unguessable: independent mints are distinct (CSPRNG, not a fixed/low-entropy constant)', async () => {
    const a = await publishCreatedHive({ ...BASE, visibility: 'invite' }, realMint().deps);
    const b = await publishCreatedHive({ ...BASE, visibility: 'invite' }, realMint().deps);
    expect(a.inviteSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(b.inviteSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(a.inviteSecret).not.toBe(b.inviteSecret); // a constant/low-entropy mint would collide
  });
});

describe('resolveHiveMemberJoinLinks (WI-10006697: the soak JOIN_BODY is minted from the product)', () => {
  const OPTS = { workspaceId: 'ws', potSlug: 'shop-hive' } as const;

  it('returns the SAME member-join links the directory announce carries, owner-bound', async () => {
    const pub = fakes();
    await publishCreatedHive({ ...BASE, visibility: 'public' }, pub.deps);
    const announced = pub.calls.published[0].memberLinks as string[];
    expect(announced.length).toBe(1);

    const { deps } = fakes();
    const out = await resolveHiveMemberJoinLinks(OPTS, deps);
    expect(out.links).toEqual(announced);
    expect(out.members).toEqual([{ slug: 'shop', link: announced[0] }]);
    expect(out.hivePubkey).toBe(HIVE_PUBKEY);
    expect(out.ownerBound).toBe(true);
    const link = parseHarnessLink(out.links[0])!;
    expect(link).toMatchObject({ github: 'acme/shop', repoId: 100, hivePubkey: HIVE_PUBKEY, ownerDevicePubkey: 'dpk' });
    expect(link.topic).toBe(topicAsHex(deriveHiveFederationTopic(HIVE_PUBKEY)));
  });

  it('has no side effect: no meta write, no announce, no Cupboard row, no local binding, no rekey', async () => {
    const { deps, calls } = fakes();
    await resolveHiveMemberJoinLinks(OPTS, deps);
    expect(calls).toEqual({ savedMeta: [], published: [], listings: [], localBindings: [], rekeyed: [] });
  });

  it('never emits a link to the hive HOME, even when the home has a GitHub remote and id (D-047)', async () => {
    const { deps } = fakes({
      loadRegistry: async () => ({
        projects: [
          ...members(),
          {
            slug: 'shop-hive',
            path: '/hives/shop-hive-clone',
            github_remote: 'https://github.com/acme/shop-hive.git',
            github_repository_id: 999,
          },
        ],
      }),
    });
    const out = await resolveHiveMemberJoinLinks(OPTS, deps);
    expect(out.links.map((l) => parseHarnessLink(l)!.repoId)).toEqual([100]);
  });

  it('an unresolvable owner still yields links, without the binding, and says so', async () => {
    const { deps } = fakes({
      resolveOwner: async () => {
        throw new Error('no device identity');
      },
    });
    const out = await resolveHiveMemberJoinLinks(OPTS, deps);
    expect(out.ownerBound).toBe(false);
    expect(out.links.length).toBe(1);
    const link = parseHarnessLink(out.links[0])!;
    expect(link.repoId).toBe(100);
    expect(link.hivePubkey).toBeUndefined();
    expect(link.ownerDevicePubkey).toBeUndefined();
  });

  it('no hive pubkey: no links (nothing joinable) and not owner-bound', async () => {
    const { deps } = fakes({ loadPubkey: async () => null });
    const out = await resolveHiveMemberJoinLinks(OPTS, deps);
    expect(out).toEqual({ links: [], members: [], hivePubkey: null, ownerBound: false });
  });

  it('the default owner resolver is LOAD-ONLY: a read never creates or repairs device identity', async () => {
    identityCalls.length = 0;
    const { deps } = fakes();
    const out = await resolveHiveMemberJoinLinks(OPTS, { ...deps, resolveOwner: undefined });
    expect(identityCalls.map((c) => c.identityMode)).toEqual(['load-only']);
    expect(out.ownerBound).toBe(true);
    expect(parseHarnessLink(out.links[0])!.ownerDevicePubkey).toBe('dpk');
  });

  it('the announce path keeps its default (authoring) owner resolver', async () => {
    identityCalls.length = 0;
    const { deps } = fakes();
    await publishCreatedHive({ ...BASE, visibility: 'public' }, { ...deps, resolveOwner: undefined });
    expect(identityCalls.length).toBeGreaterThan(0);
    expect(identityCalls.every((c) => c.identityMode === undefined)).toBe(true);
  });
});
