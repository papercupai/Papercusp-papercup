/**
 * Unit tests for `runBootstrapLeg` (P-205/WI-3591 — the G-8 cold-clone bootstrap
 * leg wired into `system:git-sync`'s handleGitSync as `git-sync:bootstrap`).
 * Mocks the leg's direct dependencies only (harness-registry, hive-membership-store,
 * usage-actor, hive-git storage/bootstrap, db-org) — everything else `git-sync-action.ts`
 * imports at module scope is left real since this leg never calls into it.
 *
 * Asserts: (1) the SELF-GATE — no-op when the local repo already has any namespace,
 * or when no hive member has an attested device pubkey; (2) the happy-path call
 * shape into `bootstrapFromPeer` (repo path, a Duplex, selfDevicePubkey) and the
 * routine-metadata patch recorded under the `bootstrap` key; (3) never-throws when
 * `bootstrapFromPeer` itself rejects (fail-soft, matches every sibling leg's contract).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type FakeDuplex = { on: (ev: string, cb: () => void) => void };
type FakeBootedHarness = {
  swarm?: { topicHex?: string } | null;
  openHiveGitDuplexToDevice?: (device: string, request: unknown) => Promise<unknown>;
};
type BootstrapOutcome = {
  ok: boolean;
  namespaces: string[];
  skippedExisting: string[];
  skippedSelf: string | null;
  stderr: string;
};
type RegistryProject = {
  slug: string;
  hive_slug?: string;
  self_repo?: boolean;
  github_repository_id?: number;
  github_remote?: string;
};

const {
  loadHarnessRegistryMock,
  listHiveMembersMock,
  hiveGitRepoPathMock,
  listNamespacesMock,
  ensurePotGitRepoMock,
  bootstrapFromPeerMock,
  hasPendingQuarantineMock,
  resolveServingIdentityMock,
  saveHarnessRegistryMock,
  unsafeMock,
  sqlTagMock,
  getBootedHarnessMock,
  bootSingleHarnessMock,
  getPgRelocatedHarnessEndpointMock,
  openHiveGitDuplexViaExistingSidecarMock,
  workspacesRootMock,
  openHiveGitDuplexToDeviceMock,
  loadCachedLocalAnnounceIdentityMock,
  contentPeerCountForTopicMock,
  lastContentAnnounceRecvMsMock,
} = vi.hoisted(() => ({
  loadHarnessRegistryMock: vi.fn<() => Promise<{ projects: RegistryProject[] }>>(async () => ({
    projects: [{ slug: 'shop-hive', hive_slug: 'shop-hive', self_repo: true }],
  })),
  saveHarnessRegistryMock: vi.fn(async (_reg: { projects: RegistryProject[] }) => {}),
  listHiveMembersMock: vi.fn(async (_ws: string, _hive: string) => [
    { deviceAttestations: [{ device_pubkey: 'cGVlci1kZXZpY2UtcHVia2V5LWJhc2U2NC0zMmJ5dGVzISE=' }] },
  ]),
  hiveGitRepoPathMock: vi.fn((potHomeSlug: string, repoKey: string) => `/repos/${potHomeSlug}/${repoKey}`),
  listNamespacesMock: vi.fn(async (_repoPath: string) => [] as string[]),
  // WI-6189: staged-but-unfinished ladder work. Default false = "nothing left
  // pending", which is the pre-ladder assumption every existing case here was
  // written under, so those cases keep their original meaning.
  hasPendingQuarantineMock: vi.fn(async (_repoPath: string) => false),
  // G-8 cold-start (WI-3496 rig finding): the leg must ensure the bare store
  // exists BEFORE any read against it — mirrors the real helper's return.
  ensurePotGitRepoMock: vi.fn(async (potHomeSlug: string, repoKey: string) => `/repos/${potHomeSlug}/${repoKey}`),
  // DIAL-REGISTRY (WI-3583/P-302): getBootedHarness is dynamically imported
  // (see git-sync-action.ts's own comment on why) so it must be mocked here
  // too, or the dynamic import pulls in boot-all.ts's real module graph —
  // which reaches back into '../../harness-registry' for exports this file's
  // OWN partial mock of that module doesn't define (deregisterEphemeralForeignHarness
  // et al), crashing with a confusing "no export is defined on the mock" error
  // that looks unrelated to this leg. Defaults to "no live swarm join yet" —
  // the same fail-soft floor the real code falls back to — so the existing
  // happy-path assertions below (any Duplex, selfDevicePubkey passed through)
  // stay valid without a real swarm.
  getBootedHarnessMock: vi.fn((_ws: string, _hive: string) => null as FakeBootedHarness | null),
  // WI-5247: resolveHiveGitTopicHex demand-boots when getBootedHarness misses
  // (a harness never booted this process, not just an evicted one) — mocked
  // as a resolved no-op so the existing fail-soft-stub assertions stay valid.
  bootSingleHarnessMock: vi.fn(async (_ws: string, _hive: string) => ({ state: 'booted' as const })),
  getPgRelocatedHarnessEndpointMock: vi.fn(async (_ws: string, _hive: string) => null as {
    socketPath: string;
    advertisedAt: number;
  } | null),
  openHiveGitDuplexViaExistingSidecarMock: vi.fn(async (_opts: unknown) => ({
    on: (_ev: string, _cb: () => void) => {},
    destroyed: false,
  })),
  workspacesRootMock: vi.fn(() => '/workspaces'),
  openHiveGitDuplexToDeviceMock: vi.fn(async (_topic: Buffer, _device: string, _req: unknown) => {
    const d = { on: (_ev: string, _cb: () => void) => {} };
    return d;
  }),
  // Mirrors the REAL bootstrapFromPeer → fetchOverDuplex contract: it always
  // attaches an 'error' listener to the duplex before ever awaiting anything
  // (fetch-transport.ts's own fix for the DIAL-REGISTRY GAP idiom's
  // pre-destroyed stub duplex) — a mock that ignored the duplex entirely
  // would falsely "pass" while masking an unhandled-error crash the real
  // call chain no longer has.
  bootstrapFromPeerMock: vi.fn<
    (repoPath: string, duplex: FakeDuplex, opts: Record<string, unknown>) => Promise<BootstrapOutcome>
  >(async (_repoPath, duplex, _opts) => {
    // Mimic the REAL bootstrapFromPeer's timing: it awaits dropQuarantine/
    // listNamespaces BEFORE fetchOverDuplex ever attaches an 'error' listener
    // — so a stub destroyed WITHOUT its own no-op listener emits an UNHANDLED
    // 'error' in this gap (live-caught: crash-looped the tower bg-host,
    // WI-3496). Deferring one macrotask here makes the stub-path tests below
    // genuine regression tests for that; attaching synchronously would mask it.
    await new Promise((r) => setImmediate(r));
    duplex.on('error', () => {});
    return {
      ok: true,
      namespaces: ['abcd1234'],
      skippedExisting: [],
      skippedSelf: null,
      stderr: '',
    };
  }),
  resolveServingIdentityMock: vi.fn(
    async (): Promise<{ githubUserId: number; devicePubkey: string } | null> => ({
      githubUserId: 1,
      devicePubkey: 'c2VsZi1kZXZpY2UtcHVia2V5LWJhc2U2NC0zMmJ5dGVzISEhISE=',
    }),
  ),
  // gh-INDEPENDENT self-identity: resolveUsageActor returns null whenever `gh`
  // is unauthenticated / rate-limited, so the leg falls back to the persisted,
  // keychain-verified announce-identity cache (no network). Default null — the
  // happy path uses the actor's devicePubkey and never reaches this `??` arm.
  loadCachedLocalAnnounceIdentityMock: vi.fn(async () => null as { devicePubkeyBase64?: string } | null),
  // WI-37574: discriminator (2) of the persistent-miss escalation. Both are
  // dynamically imported by the escalation branch (same reason as
  // getBootedHarness above — a static import would drag swarm.ts's real module
  // graph in, and swarm.ts imports two symbols from peer-dial-registry that the
  // partial mock on L179 does not provide). Defaults = the unpaired case.
  contentPeerCountForTopicMock: vi.fn((_topicHex?: string) => 0),
  lastContentAnnounceRecvMsMock: vi.fn((_topicHex: string) => null as number | null),
  unsafeMock: vi.fn(async (_text: string, _params: unknown[]) => []),
  // EI-18775478513129278: the `sql` TEMPLATE-TAG call (distinct from `sql.unsafe`,
  // used by patchRoutineMetadata) — the "dialed but outcome===null" path reads the
  // prior `bootstrap` metadata through this before writing, to carry forward
  // durable on-disk progress instead of clobbering it with 0/null. Default resolves
  // empty (no prior row), matching every existing test's assumption of a fresh routine.
  sqlTagMock: vi.fn(async (..._parts: unknown[]) => [] as unknown[]),
}));

// WI-6364: `saveHarnessRegistry` is reached through adopt-refused-repo-key.ts
// (the re-key adoption below). It MUST be in this mock even though no
// pre-WI-6364 case touches it — vitest throws on ANY missing key the moment the
// module is accessed, with an error naming an unrelated module.
/* EI-18795996821389029 — derived, NOT hand-listed, for the same reason storage is
 * (see the comment above that mock). harness-registry exports 13 values; this file
 * only cares about 2. When it was a literal object the other 11 were UNDEFINED on
 * the mock, and the line-84 comment below records that already biting: boot-all's
 * real graph reaches back here for `deregisterEphemeralForeignHarness` et al and
 * crashes with "no export is defined on the mock" — an error naming a module this
 * leg never mentions, which is why it reads as unrelated. Deriving the stub set from
 * the real export list closes that whole class for this module.
 *
 * The inert stub MATCHES THE REAL FUNCTION'S SHAPE rather than blanket-async as the
 * storage mock does: harness-registry is a near-even 7-async/6-sync split, so a
 * blanket `async () => undefined` would hand a Promise to callers of the sync
 * helpers (dedupeProjectsBySlug, isEphemeralForeignProject, ...) — trading an absent
 * export for a wrong-typed one. Non-function exports keep their real values. */
vi.mock('../../harness-registry', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const inert = Object.fromEntries(
    Object.entries(actual).map(([k, v]) => {
      if (typeof v !== 'function') return [k, v];
      return [
        k,
        v.constructor.name === 'AsyncFunction'
          ? vi.fn(async () => undefined)
          : vi.fn(() => undefined),
      ];
    }),
  );
  return {
    ...inert,
    loadHarnessRegistry: loadHarnessRegistryMock,
    saveHarnessRegistry: saveHarnessRegistryMock,
  };
});
vi.mock('../../hive-membership-store', () => ({ listHiveMembers: listHiveMembersMock }));
/* Storage is fully stubbed (no real git/fs from a unit test), but the stub set is
 * derived from the REAL export list so a new export in storage.ts cannot silently
 * break this file. An ABSENT export throws inside runBootstrapLeg, whose catch
 * swallows it into a console.warn — vitest-fail-on-console then reds this file with
 * a cascade of misleading "called 0 times" assertions (the leg aborted before
 * dialing), and the green gate with it. That is EI-18748959711888135: adding
 * `sweepStalePackTmpFiles` to storage.ts red-pinned the fleet gate.
 * Every export the test does not care about becomes an inert vi.fn(); non-function
 * exports (timeouts, thresholds) keep their real values; the explicit stubs below
 * override the generated ones. */
vi.mock('../../sync/pot-git/storage', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // Inert stubs resolve a promise rather than returning undefined: storage's exports
  // are overwhelmingly `async`, and callers fire-and-forget them
  // (`sweepStalePackTmpFiles(...).catch(...)`), which throws on a bare vi.fn().
  // A test that needs a SYNC return value stubs that export explicitly, below.
  const inert = Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === 'function' ? vi.fn(async () => undefined) : v,
    ]),
  );
  return {
    ...inert,
    hiveGitRepoPath: hiveGitRepoPathMock,
    listNamespaces: listNamespacesMock,
    ensurePotGitRepo: ensurePotGitRepoMock,
    // Deterministic base64→hex, mirroring the real mapping's shape without the
    // raw-32 length check (the fixture pubkeys are readable strings, not real keys).
    deviceNamespaceKey: (b64: string) => Buffer.from(b64, 'base64').toString('hex'),
  };
});
vi.mock('../../sync/pot-git/bootstrap', () => ({
  bootstrapFromPeer: bootstrapFromPeerMock,
  hasPendingQuarantine: hasPendingQuarantineMock,
}));
async function servingFixture(request: import('../../sync/pot-git/serving-capability').GitServingRequest) {
  const actor = await resolveServingIdentityMock();
  if (!actor) return { status: 'unknown', retryable: true, reason: 'serving identity unavailable in fixture' };
  const now = Date.now();
  return { status: 'ready', capability: { ...request, v: 1, runtimeId: 'fixture-owner',
    identity: { devicePubkeyBase64: actor.devicePubkey, githubUserId: actor.githubUserId, keychainId: 'fixture-key' },
    context: { ...request.scope, store_generation: 'sg2-1-' + 'a'.repeat(40) }, issuedAtMs: now, expiresAtMs: now + 30_000 } };
}
vi.mock('../../hive-store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getHiveBySlug: async () => ({ pubkeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }),
}));
vi.mock('../../sync/hyperbee/boot-all', () => ({
  getBootedHarness: (...args: Parameters<typeof getBootedHarnessMock>) => {
    const handle = getBootedHarnessMock(...args);
    return handle ? { ...handle, getGitServingCapability: servingFixture } : null;
  },
  bootSingleHarness: bootSingleHarnessMock,
}));
vi.mock('../../sync/hyperbee/substrate-booted-handles-pg', () => ({
  getPgRelocatedHarnessEndpoint: getPgRelocatedHarnessEndpointMock,
  getPgGitServingCapability: servingFixture,
}));
vi.mock('../../sync/hyperbee/remote-booted-harness', () => ({
  openHiveGitDuplexViaExistingSidecar: openHiveGitDuplexViaExistingSidecarMock,
}));
vi.mock('../../workspace-registry', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, workspacesRoot: workspacesRootMock };
});
vi.mock('../../sync/pot-git/peer-dial-registry', () => ({ openHiveGitDuplexToDevice: openHiveGitDuplexToDeviceMock }));
vi.mock('../../sync/hyperbee/local-announce-identity', () => ({ loadCachedLocalAnnounceIdentity: loadCachedLocalAnnounceIdentityMock }));
vi.mock('../../sync/hyperbee/swarm', () => ({
  contentPeerCountForTopic: contentPeerCountForTopicMock,
  lastContentAnnounceRecvMs: lastContentAnnounceRecvMsMock,
}));
vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // WI-6372: `sql` is now used in BOTH of postgres.js's two calling
  // conventions by this leg — as a TEMPLATE TAG (the convergence probe's
  // fed-event + prior-state reads) and as `sql.unsafe(...)`
  // (patchRoutineMetadata). A bare `{ unsafe }` object satisfies only the
  // second: the tag call then dies "sql is not a function" inside the leg's
  // fail-soft catch, which becomes a console.warn, which vitest-fail-on-console
  // reds this ENTIRE file with — 24 misleading failures naming everything
  // except the mock. Same trap as the storage stub set above.
  const sql = Object.assign(sqlTagMock, { unsafe: unsafeMock });
  return { ...actual, getOrgPg: () => ({ sql }) };
});

// Import AFTER the mocks so the module resolves the mocked deps.
import { runBootstrapLeg } from './git-sync-action';
import { GitSyncLeaseLostError } from './git-sync-lease-fence';
import { __resetNoSuchRepoBackoffForTest } from './no-such-repo-backoff';

const SLUG = 'shop-hive';
const WS = 'ws-1';

/** Every override below must keep consuming the duplex (attach a no-op
 *  'error' listener) exactly like the real fetchOverDuplex chain does now —
 *  see the vi.hoisted() comment above for why. */
const bootstrapOutcome = (result: BootstrapOutcome) => async (_repoPath: string, duplex: FakeDuplex, _opts: Record<string, unknown>): Promise<BootstrapOutcome> => {
  await new Promise((r) => setImmediate(r)); // real-timing gap — see vi.hoisted comment
  duplex.on('error', () => {});
  return result;
};
const bootstrapRejection = (err: Error) => async (_repoPath: string, duplex: FakeDuplex, _opts: Record<string, unknown>): Promise<BootstrapOutcome> => {
  await new Promise((r) => setImmediate(r)); // real-timing gap — see vi.hoisted comment
  duplex.on('error', () => {});
  throw err;
};

const SELF_DEVICE = 'c2VsZi1kZXZpY2UtcHVia2V5LWJhc2U2NC0zMmJ5dGVzISEhISE=';
const PEER_DEVICE = 'cGVlci1kZXZpY2UtcHVia2V5LWJhc2U2NC0zMmJ5dGVzISE=';
// Distinct-prefixed peers for the multi-candidate iteration / cap tests below
// (the leg logs device.slice(0,8) into the dialLog, so the prefixes differ).
const PEER_DEVICE_2 = 'ZGV2LXR3by1wdWJrZXktYmFzZTY0LTMyYnl0ZXMtISEhIQ==';
const PEER_DEVICE_3 = 'dGhyZWUtZGV2LXB1YmtleS1iYXNlNjQtMzJieXRlcy0hIQ==';
const PEER_DEVICE_4 = 'Zm91ci1kZXZpY2UtcHVia2V5LWJhc2U2NC0zMmJ5dGVzIQ==';

/** A fake dial-registry duplex: `destroyed:true` models a registry miss (the
 *  pre-destroyed decoy — "no live dial path"); `destroyed:false` a live socket
 *  the leg then hands to bootstrapFromPeer. */
const dialDuplex = (destroyed: boolean) => ({ on: (_ev: string, _cb: () => void) => {}, destroyed });

beforeEach(() => {
  loadHarnessRegistryMock.mockClear();
  saveHarnessRegistryMock.mockClear();
  listHiveMembersMock.mockClear();
  hiveGitRepoPathMock.mockClear();
  listNamespacesMock.mockClear();
  bootstrapFromPeerMock.mockClear();
  hasPendingQuarantineMock.mockClear();
  hasPendingQuarantineMock.mockResolvedValue(false);
  resolveServingIdentityMock.mockClear();
  unsafeMock.mockClear();
  sqlTagMock.mockClear();
  sqlTagMock.mockResolvedValue([]); // default: no prior routine row
  getBootedHarnessMock.mockClear();
  bootSingleHarnessMock.mockClear();
  getPgRelocatedHarnessEndpointMock.mockClear();
  getPgRelocatedHarnessEndpointMock.mockResolvedValue(null);
  openHiveGitDuplexViaExistingSidecarMock.mockClear();
  openHiveGitDuplexViaExistingSidecarMock.mockResolvedValue(dialDuplex(false));
  workspacesRootMock.mockClear();
  workspacesRootMock.mockReturnValue('/workspaces');
  openHiveGitDuplexToDeviceMock.mockClear();
  loadCachedLocalAnnounceIdentityMock.mockClear();
  loadCachedLocalAnnounceIdentityMock.mockResolvedValue(null); // default: cache empty (actor path is used)
  resolveServingIdentityMock.mockResolvedValue({ githubUserId: 1, devicePubkey: SELF_DEVICE });
  loadHarnessRegistryMock.mockResolvedValue({
    projects: [{ slug: SLUG, hive_slug: SLUG, self_repo: true }],
  });
  listHiveMembersMock.mockResolvedValue([
    { deviceAttestations: [{ device_pubkey: PEER_DEVICE }] },
  ]);
  listNamespacesMock.mockResolvedValue([]);
  bootstrapFromPeerMock.mockImplementation(bootstrapOutcome({
    ok: true,
    namespaces: ['abcd1234'],
    skippedExisting: [],
    skippedSelf: null,
    stderr: '',
  }));
  getBootedHarnessMock.mockReturnValue(null); // default: no live swarm join — the fail-soft floor
  openHiveGitDuplexToDeviceMock.mockImplementation(async () => ({ on: (_ev: string, _cb: () => void) => {} }));
  // EI-15333: the backoff map is module-scope state shared across every test
  // in this file — clear it each test or an earlier no-such-repo test would
  // silently starve a later test's dial of the same (slug, peer) pair.
  __resetNoSuchRepoBackoffForTest();
});

describe('runBootstrapLeg', () => {
  /* Recurrence guard for EI-18748959711888135 — asserts the CLASS, not the instance.
   * `sweepStalePackTmpFiles` was added to storage.ts while this file's mock was a
   * literal object; the absent export threw inside runBootstrapLeg's catch, surfaced
   * only as a console.warn, and vitest-fail-on-console turned it into 28 failures
   * here (mostly misleading "called 0 times" — the leg aborted before dialing) plus
   * a red fleet gate. The factory is now derived from the real export list; this
   * fails if anyone reverts it to a hand-listed object and misses an export. */
  /* The assertion is shared so a third derived mock is ~5 lines, not a copy-paste of
   * the detection logic (which is where the self-check would quietly get dropped).
   *
   * Specifiers stay STATIC at each call site on purpose: vitest resolves `import()`
   * against its mock registry using the literal specifier, so passing a variable
   * path here would compare the real module against ITSELF and pass unconditionally —
   * a guard that can only succeed, which is worse than no guard because it reads
   * as coverage. */
  const expectStubCoversRealExports = (
    label: string,
    real: Record<string, unknown>,
    stub: Record<string, unknown>,
  ) => {
    const missingFrom = (m: Record<string, unknown>) => Object.keys(real).filter((k) => !(k in m));
    expect(missingFrom(stub), `${label}: mock omits real export(s)`).toEqual([]);
    // Exercise the detection itself against a deliberately incomplete stub, so this
    // guard cannot silently stop detecting (a guard whose failure path never runs is
    // indistinguishable from no guard).
    const probeKey = Object.keys(real)[0]!;
    const incomplete = { ...stub };
    delete incomplete[probeKey];
    expect(missingFrom(incomplete), `${label}: the guard stopped detecting`).toEqual([probeKey]);
  };

  it('EI-18748959711888135: the storage stub exposes every real storage export', async () => {
    expectStubCoversRealExports(
      'storage',
      await vi.importActual<Record<string, unknown>>('../../sync/pot-git/storage'),
      (await import('../../sync/pot-git/storage')) as unknown as Record<string, unknown>,
    );
  });

  /* EI-18795996821389029 — same class, one module over. This one is not hypothetical:
   * the mock listed 2 of 13 exports, and the comment at the top of this file records
   * boot-all's real graph already crashing on the missing
   * `deregisterEphemeralForeignHarness`. */
  it('EI-18795996821389029: the harness-registry stub exposes every real export', async () => {
    expectStubCoversRealExports(
      'harness-registry',
      await vi.importActual<Record<string, unknown>>('../../harness-registry'),
      (await import('../../harness-registry')) as unknown as Record<string, unknown>,
    );
  });

  it('self-gates as a no-op when the local repo already has a peer MEMBER namespace (warm repo)', async () => {
    // Warm = the namespace of an attested member device other than self —
    // the mocked deviceNamespaceKey is base64→hex, so PEER_DEVICE's hex it is.
    const peerHex = Buffer.from(PEER_DEVICE, 'base64').toString('hex');
    listNamespacesMock.mockResolvedValue([peerHex]);
    await runBootstrapLeg(SLUG, WS);
    expect(ensurePotGitRepoMock).toHaveBeenCalledWith(SLUG, SLUG, expect.any(Function));
    expect(bootstrapFromPeerMock).not.toHaveBeenCalled();
  });

  /**
   * WI-6372 (fix D) — THE PLACEMENT TEST. The convergence probe MUST run on the
   * WARM path, i.e. ABOVE the gate the test directly above proves is a no-op.
   *
   * This is the whole fix, expressed as a regression guard. A seeded-but-STALE
   * joiner — the WI-6364 shape, and the only machine that actually needs a
   * convergence verdict — satisfies the warm gate on EVERY tick and so never
   * reaches any code below it. Move this probe under the gate (an easy,
   * innocent-looking refactor: "it's part of bootstrapping, put it with the
   * bootstrap") and it silently stops firing on precisely the broken case while
   * continuing to pass every other test in this file. That is the 7-day silent
   * failure restored, so it gets an explicit test rather than a comment.
   */
  it('WI-6372: the convergence probe runs on the WARM path — above the gate, not below it', async () => {
    const peerHex = Buffer.from(PEER_DEVICE, 'base64').toString('hex');
    listNamespacesMock.mockResolvedValue([peerHex]);
    await runBootstrapLeg(SLUG, WS);
    // Warm: the leg returned before dialing or writing any bootstrap record...
    expect(bootstrapFromPeerMock).not.toHaveBeenCalled();
    expect(routinesPatchCallsWithKey('bootstrap')).toHaveLength(0);
    // ...and the convergence verdict was STILL computed and persisted.
    const convergencePatches = routinesPatchCallsWithKey('convergence');
    expect(convergencePatches).toHaveLength(1);
    const patched = routinePatchBodyStrict(convergencePatches[0]![0], convergencePatches[0]![1])
      .convergence as Record<string, unknown>;
    expect(patched).toMatchObject({
      // Health has no judgeable observation, and exact release acceptance is
      // independently fail-closed for the named peer rather than inheriting the
      // legacy `converged:true` warm-up result.
      converged: true,
      healthState: 'unknown',
      judged: 0,
      releaseConsistency: {
        state: 'unknown',
        expectedDevicePubkeys: [PEER_DEVICE],
        currentDevicePubkeys: [],
        issues: [expect.objectContaining({ devicePubkeyBase64: PEER_DEVICE, code: 'missing-announcement' })],
      },
    });
  });

  /**
   * WI-6189, live-caught on the P-302 rig 2026-07-26 in the tick right AFTER
   * the first successful cold join.
   *
   * The resumable ladder made bootstrap incremental: it seeds all-or-nothing
   * PER NAMESPACE, so a store can hold a fully-seeded peer namespace while a
   * DIFFERENT device's history is still mid-ladder in quarantine. The warm gate
   * predates that — it asked only "does a peer namespace exist?", which was
   * equivalent back when bootstrap was all-or-nothing. Post-ladder it declares
   * a PARTIAL join complete: the rig seeded 5 namespaces, still had 4 quarantine
   * refs, and returned warm on every later tick — the ladder never ran again and
   * the store stayed permanently shallow.
   *
   * That is the worst shape of failure this feature can have: not a visible
   * error, but a partial cold-join that reports success and silently strands the
   * rest of the history forever.
   */
  it('WI-6189: a seeded peer namespace does NOT mean warm while quarantine work is still pending', async () => {
    const peerHex = Buffer.from(PEER_DEVICE, 'base64').toString('hex');
    listNamespacesMock.mockResolvedValue([peerHex]); // one namespace fully seeded…
    hasPendingQuarantineMock.mockResolvedValue(true); // …another still mid-ladder

    await runBootstrapLeg(SLUG, WS);

    // Must keep laddering — returning here is what strands the unfinished ones.
    expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(1);
  });

  it('WI-6189: a fail-soft quarantine probe falls back to warm rather than re-dialing forever', async () => {
    // The probe shells out to git; if that throws we must not flip a genuinely
    // warm store into re-dialing a peer on every single tick.
    const peerHex = Buffer.from(PEER_DEVICE, 'base64').toString('hex');
    listNamespacesMock.mockResolvedValue([peerHex]);
    hasPendingQuarantineMock.mockRejectedValue(new Error('git exploded'));

    await runBootstrapLeg(SLUG, WS);

    expect(bootstrapFromPeerMock).not.toHaveBeenCalled();
  });

  it('WI-6189: pending quarantine alone does NOT bypass the other gates (no attested peer ⇒ still a no-op)', async () => {
    // Guards the obvious over-correction: the quarantine check must refine the
    // warm gate, never become an independent reason to dial.
    hasPendingQuarantineMock.mockResolvedValue(true);
    listHiveMembersMock.mockResolvedValue([]);

    await runBootstrapLeg(SLUG, WS);

    expect(bootstrapFromPeerMock).not.toHaveBeenCalled();
  });

  it('WI-3496 part 2: a non-member namespace (github-ingress, same-tick earlier leg) does NOT count as warm — still bootstraps', async () => {
    // runGithubBridgeLeg runs BEFORE this leg in the same tick and writes a
    // locally-synthesized ingress namespace on the very first tick of a
    // GitHub-bridged repo — counting it as warm made every bridged pot skip
    // G-8 cold-join forever (live-caught on the P-302 rig).
    listNamespacesMock.mockResolvedValue(['1n6re551n6re55deadbeef00']);
    await runBootstrapLeg(SLUG, WS);
    expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(1);
  });

  it('G-8 cold start (WI-3496): ensures the bare store exists BEFORE reading namespaces', async () => {
    await runBootstrapLeg(SLUG, WS);
    expect(ensurePotGitRepoMock).toHaveBeenCalledWith(SLUG, SLUG, expect.any(Function));
    const ensureOrder = ensurePotGitRepoMock.mock.invocationCallOrder[0];
    const listOrder = listNamespacesMock.mock.invocationCallOrder[0];
    expect(ensureOrder).toBeLessThan(listOrder);
  });

  it('WI-3496: our OWN namespace does not count as warm — still bootstraps from the peer', async () => {
    // own-head-publish created only the self namespace (its key = the mocked
    // base64→hex of the self device pubkey); a cold-join from a peer must
    // still run or the store never gains any peer namespace.
    const selfHex = Buffer.from('c2VsZi1kZXZpY2UtcHVia2V5LWJhc2U2NC0zMmJ5dGVzISEhISE=', 'base64').toString('hex');
    listNamespacesMock.mockResolvedValue([selfHex]);
    await runBootstrapLeg(SLUG, WS);
    expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(1);
  });

  it('self-gates as a no-op when no hive member has an attested device pubkey', async () => {
    listHiveMembersMock.mockResolvedValue([{ deviceAttestations: [] }]);
    await runBootstrapLeg(SLUG, WS);
    expect(listHiveMembersMock).toHaveBeenCalledWith(WS, SLUG);
    expect(bootstrapFromPeerMock).not.toHaveBeenCalled();
  });

  it('calls bootstrapFromPeer with the resolved repo path, a Duplex, and selfDevicePubkey on the happy path', async () => {
    await runBootstrapLeg(SLUG, WS);
    expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(1);
    const [repoPath, duplex, opts] = bootstrapFromPeerMock.mock.calls[0];
    expect(repoPath).toBe(`/repos/${SLUG}/${SLUG}`);
    expect(duplex).toBeTruthy();
    expect((opts as Record<string, unknown>).selfDevicePubkey).toBe('c2VsZi1kZXZpY2UtcHVia2V5LWJhc2U2NC0zMmJ5dGVzISEhISE=');
  });

  /* WI-10006972: the leg runs under the per-install lease, and every write it
   * starts against the bare store must check that lease first. */
  describe('WI-10006972: per-install lease guard', () => {
    const lost = new GitSyncLeaseLostError(SLUG, 'refused', `git-sync:${SLUG}: held by another fire`);

    it('forwards the guard to the ladder and fences its own store writes', async () => {
      let tripped = false;
      let guardCalls = 0;
      const beforeGitCommand = (): void => {
        guardCalls++;
        if (tripped) throw lost;
      };
      await runBootstrapLeg(SLUG, WS, { beforeGitCommand });

      expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(1);
      // Forwarded as-is, so bootstrapFromPeer fences its fetches and ref writes.
      expect((bootstrapFromPeerMock.mock.lastCall?.[2] as Record<string, unknown>).beforeGitCommand).toBe(
        beforeGitCommand,
      );
      expect(guardCalls).toBeGreaterThan(0); // the pack-temp sweep checked it

      // The runGit handed to the leg's own store writer checks the guard BEFORE
      // spawning git: once tripped, it refuses without running anything.
      const runGit = (ensurePotGitRepoMock.mock.lastCall as unknown[] | undefined)?.[2] as (
        args: string[],
        cwd: string,
      ) => Promise<unknown>;
      expect(runGit).toBeTypeOf('function');
      tripped = true;
      await expect(runGit(['init', '--bare'], '/nonexistent-store')).rejects.toBe(lost);
    });

    it('rethrows a lease loss to the lease owner instead of logging it as a leg failure', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        bootstrapFromPeerMock.mockRejectedValueOnce(lost);
        await expect(runBootstrapLeg(SLUG, WS, { beforeGitCommand: () => {} })).rejects.toBe(lost);
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('bootstrap-tick failed'));

        // CONTROL: any other error is still swallowed and logged, as before.
        bootstrapFromPeerMock.mockRejectedValueOnce(new Error('dial exploded'));
        await expect(runBootstrapLeg(SLUG, WS, { beforeGitCommand: () => {} })).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('bootstrap-tick failed: dial exploded'));
      } finally {
        warn.mockRestore();
      }
    });

    it('a guard already tripped at the first write stops the leg before it touches the store', async () => {
      await expect(
        runBootstrapLeg(SLUG, WS, {
          beforeGitCommand: () => {
            throw lost;
          },
        }),
      ).rejects.toBe(lost);
      expect(listNamespacesMock).not.toHaveBeenCalled();
      expect(bootstrapFromPeerMock).not.toHaveBeenCalled();
    });
  });

  /* WI-6284 recurrence guards. The bootstrap leg logged every FAILURE and every
   * PARTIAL, and said nothing at all on success — so the single event this whole
   * feature exists to produce was its only silent outcome. Live cost, 2026-07-27:
   * a deliberate cold-join drill on the P-302 rig succeeded (2 namespaces in 2
   * rungs, history complete) and emitted no line, so the drill was checkpointed
   * as "may never have run" and the verdict had to be re-derived from routine
   * metadata a wake later. These two tests assert the CLASS: every terminal
   * outcome of this leg both logs and stamps which path produced it. */
  it('WI-6284: a SUCCESSFUL dialed cold join LOGS the completion (success was the only silent outcome)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
      openHiveGitDuplexToDeviceMock.mockImplementation(async () => dialDuplex(false));
      bootstrapFromPeerMock.mockImplementation(bootstrapOutcome({
        ok: true,
        namespaces: ['ns-a', 'ns-b'],
        skippedExisting: [],
        skippedSelf: null,
        stderr: '',
        steps: 2,
        shallow: false,
      } as BootstrapOutcome));
      await runBootstrapLeg(SLUG, WS);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('FETCH COMPLETE; RELEASE CONSISTENCY UNKNOWN'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('UNKNOWN: 0/1 expected peer(s) exact'));
      // The counts must be IN the line — a bare "it worked" would not have
      // settled the rig question either.
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('seeded 2 namespace(s) in 2 rung(s)'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('history complete'));
    } finally {
      logSpy.mockRestore();
    }
  });

  /**
   * The `harness_shared.routines` metadata patch, selected BY ITS SQL TEXT rather than by call
   * index. EI-18777176681958978: the membership read now resolves the federated pot scope
   * first (a joiner's local handle reads an empty roster), and that resolution issues its own
   * reads through this same `sql.unsafe` mock — so `calls[0]` is no longer guaranteed to be
   * the routines patch. Asserting on the patch itself is also what these tests actually mean;
   * a global call COUNT was only ever a proxy for it.
   */
  function routinesPatchCallsWithKey(key: string): Array<[string, unknown[]]> {
    return unsafeMock.mock.calls
      .filter((c) => String(c[0]).includes('harness_shared.routines'))
      .filter((c) => {
        // WI-6372: SQL TEXT alone no longer identifies the patch. The
        // convergence probe writes its own routines patch through the SAME
        // `patchRoutineMetadata` (hence byte-identical SQL) and, being ABOVE
        // the warm gate, writes it FIRST — so selecting by text or by index
        // silently returned the convergence record to tests asserting about
        // the bootstrap one. Select by the metadata KEY each test actually
        // means; a third leg-level patch can then be added without touching
        // any of these assertions.
        const body = routinePatchBodyOrNull(String(c[0]), c[1] as unknown[]);
        return body !== null && key in body;
      })
      .map((c) => [String(c[0]), c[1] as unknown[]] as [string, unknown[]]);
  }
  function routinesPatchCalls(): Array<[string, unknown[]]> {
    return routinesPatchCallsWithKey('bootstrap');
  }
  function routinesPatch(): { text: string; params: unknown[] } {
    const [call] = routinesPatchCalls();
    // EI-18804080252964845: this message is only trustworthy because
    // routinePatchBodyOrNull THROWS on a patch-shaped row it cannot read. While the
    // parse was swallowed to `false`, a malformed row was filtered out and surfaced
    // here as an absent write — a missing-write symptom for a malformed-read cause,
    // which points at whoever last touched the writer instead of at the param shape.
    if (!call) throw new Error('expected a harness_shared.routines metadata patch; none was issued');
    return { text: call[0], params: call[1] };
  }

  /**
   * EI-18804080252964845: the JSONB patch body out of a `patchRoutineMetadata` call,
   * with the bind index DERIVED from the statement's own `|| $N::jsonb` placeholder
   * rather than hard-coded here.
   *
   * The index is a truth the SQL owns (`SET metadata = COALESCE(...) || $3::jsonb`).
   * EI-18799539619330782 centralised the hand-maintained copy of it; deriving it
   * removes the copy, so the next param reorder is zero edits instead of one.
   *
   * Every failure mode is LOUD, because the one thing this must never do is answer
   * "no such patch" when it means "I could not read this patch".
   */
  function routinePatchBodyStrict(text: string, params: unknown[]): Record<string, unknown> {
    const bind = /\|\|\s*\$(\d+)::jsonb/.exec(text);
    if (!bind) {
      throw new Error(
        `routines metadata patch: statement no longer binds its body as '|| $N::jsonb', so the ` +
          `patch param cannot be located (patchRoutineMetadata SQL shape changed?). SQL: ${text}`,
      );
    }
    const index = Number(bind[1]) - 1;
    const raw = params[index];
    try {
      return JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      throw new Error(
        `routines metadata patch: SQL binds the body as $${bind[1]}::jsonb, but params[${index}] ` +
          `is not JSON (patchRoutineMetadata param shape changed?). Got ${JSON.stringify(String(raw))}; ` +
          `params=${JSON.stringify(params.map((p) => String(p)))}`,
      );
    }
  }

  /**
   * The classifier used to SELECT rows: `null` means "not a routines metadata patch"
   * (a SELECT, or some other write against the table) and is quietly excluded — that
   * is the legitimate job the old blanket `catch { return false }` was also doing.
   * A row that IS patch-shaped but unreadable throws instead of vanishing.
   */
  function routinePatchBodyOrNull(text: string, params: unknown[]): Record<string, unknown> | null {
    if (!/UPDATE\s+harness_shared\.routines/i.test(text)) return null;
    return routinePatchBodyStrict(text, params);
  }

  /** The bootstrap-key patch body — the shape 11 assertions below actually want. */
  function routinesPatchBody(): Record<string, unknown> {
    const { text, params } = routinesPatch();
    return routinePatchBodyStrict(text, params);
  }

  /**
   * EI-18804080252964845 — FALSIFIABILITY CONTROLS for the matcher above.
   *
   * The original defect was invisible *because* it was silent: a patch whose body
   * param had moved was swallowed to `false`, dropped from the filtered set, and
   * reported by `routinesPatch()` as an ABSENT WRITE. Three tests then failed with
   * dial-path names while a peer held this file's lock editing dial-path logic — so
   * the evidence read as "the peer broke it" and every part of that was wrong.
   *
   * These pin all four branches. Two of them must STAY quiet: a matcher that threw on
   * every unfamiliar row would break the row SELECTION this filter exists to do, which
   * is the job the blanket `catch` was also (correctly) performing.
   *
   * Calibration against reality is the 11 assertions below, which run this same code
   * over genuinely-recorded `patchRoutineMetadata` calls — so if the real statement
   * ever stops binding its body as `|| $N::jsonb`, they fail loudly with a named cause
   * rather than these synthetic cases passing against a copy that has drifted.
   */
  describe('routines metadata patch matcher (EI-18804080252964845)', () => {
    /** Verbatim shape of the non-history branch of `patchRoutineMetadata`. */
    const PATCH_SQL = `UPDATE harness_shared.routines
        SET metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb, updated_at = now()
      WHERE install_slug = $1 AND workspace_id = $2 AND target_role = 'system:git-sync'`;
    const BODY = JSON.stringify({ bootstrap: { ok: true } });

    it('reads the body at the index the SQL itself binds', () => {
      expect(routinePatchBodyOrNull(PATCH_SQL, [SLUG, WS, BODY])).toMatchObject({
        bootstrap: { ok: true },
      });
    });

    it('NAMES a moved patch param instead of reporting an absent write', () => {
      // Exactly the EI-18799539619330782 reorder, replayed: the body is still at the
      // OLD params[1] while the SQL binds $3. Before the fix this returned `false`.
      const shifted = [SLUG, BODY, WS];
      expect(() => routinePatchBodyOrNull(PATCH_SQL, shifted)).toThrow(/param shape changed/i);
      // The whole point: it must NOT be able to masquerade as an absent write.
      expect(() => routinePatchBodyOrNull(PATCH_SQL, shifted)).not.toThrow(/none was issued/i);
    });

    it('NAMES a changed SQL shape rather than silently excluding the row', () => {
      const noBind = `UPDATE harness_shared.routines SET metadata = $9::text WHERE install_slug = $1`;
      expect(() => routinePatchBodyOrNull(noBind, [SLUG, WS, '{}'])).toThrow(/SQL shape changed/i);
    });

    it('still excludes a non-patch routines row quietly', () => {
      const read = `SELECT metadata FROM harness_shared.routines WHERE install_slug = $1`;
      expect(routinePatchBodyOrNull(read, [SLUG])).toBeNull();
    });
  });

  it('WI-6284: the bootstrap metadata record NAMES the path that produced it (dialed vs no-topic stub)', async () => {
    // Dialed: a real peer duplex.
    getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
    openHiveGitDuplexToDeviceMock.mockImplementation(async () => dialDuplex(false));
    await runBootstrapLeg(SLUG, WS);
    expect(routinesPatchBody().bootstrap).toMatchObject({ path: 'dialed' });

    // No live swarm topic: the destroyed-stub no-op. Previously indistinguishable
    // from the above except by which optional keys happened to be present.
    unsafeMock.mockClear();
    getBootedHarnessMock.mockReturnValue(null);
    await runBootstrapLeg(SLUG, WS);
    expect(routinesPatchBody().bootstrap).toMatchObject({
      path: 'no-topic-stub',
    });
  });

  it('patches routine metadata under the bootstrap key with the outcome summary', async () => {
    await runBootstrapLeg(SLUG, WS);
    expect(routinesPatchCalls()).toHaveLength(1); // patched exactly once
    const { text, params } = routinesPatch();
    expect(text).toContain('harness_shared.routines');
    expect(params[0]).toBe(SLUG);
    const patch = routinePatchBodyStrict(text, params);
    expect(patch.bootstrap).toMatchObject({ ok: true, namespaceCount: 1, skippedExisting: 0 });
  });

  it('EI-18799556647570956: the bootstrap record is stamped with a writer identity (pid+instance+sha) on BOTH the dialed and no-topic-stub paths, so a stale-process race is self-evident instead of reading as a regression', async () => {
    // Dialed path.
    getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
    openHiveGitDuplexToDeviceMock.mockImplementation(async () => dialDuplex(false));
    await runBootstrapLeg(SLUG, WS);
    const dialedWriter = routinesPatchBody().bootstrap as { writer?: unknown };
    expect(dialedWriter.writer).toMatchObject({ pid: process.pid });
    expect(dialedWriter.writer).toHaveProperty('instance');
    expect(dialedWriter.writer).toHaveProperty('sha');
    expect(typeof (dialedWriter.writer as { instance: unknown }).instance).toBe('string');

    // No-topic-stub path — same stamp shape, so a reader can tell the two apart
    // from the SAME field regardless of which leg last wrote the record.
    unsafeMock.mockClear();
    getBootedHarnessMock.mockReturnValue(null);
    await runBootstrapLeg(SLUG, WS);
    const stubWriter = routinesPatchBody().bootstrap as { writer?: unknown };
    expect(stubWriter.writer).toMatchObject({ pid: process.pid });
    expect(stubWriter.writer).toHaveProperty('instance');
    expect(stubWriter.writer).toHaveProperty('sha');
  });

  it('falls back to ctx-derived potHomeSlug from entry.slug when hive_slug is absent but self_repo is true', async () => {
    loadHarnessRegistryMock.mockResolvedValue({
      projects: [{ slug: SLUG, self_repo: true }],
    });
    await runBootstrapLeg(SLUG, WS);
    expect(ensurePotGitRepoMock).toHaveBeenCalledWith(SLUG, SLUG, expect.any(Function));
  });

  it('no-ops (no throw) when the registry has no matching entry for slug', async () => {
    loadHarnessRegistryMock.mockResolvedValue({ projects: [] });
    await expect(runBootstrapLeg(SLUG, WS)).resolves.toBeUndefined();
    expect(bootstrapFromPeerMock).not.toHaveBeenCalled();
  });

  it('never throws when bootstrapFromPeer rejects (fail-soft)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      bootstrapFromPeerMock.mockImplementation(bootstrapRejection(new Error('boom')));
      await expect(runBootstrapLeg(SLUG, WS)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('bootstrap-tick failed'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('self-gates as a no-op when the only attested member device IS this device (no peer to bootstrap from)', async () => {
    listHiveMembersMock.mockResolvedValue([{ deviceAttestations: [{ device_pubkey: SELF_DEVICE }] }]);
    await runBootstrapLeg(SLUG, WS);
    expect(bootstrapFromPeerMock).not.toHaveBeenCalled();
    expect(openHiveGitDuplexToDeviceMock).not.toHaveBeenCalled();
  });

  it('P-302: dials the peer device over the real duplex when a live swarm topic exists (WI-3583 wiring)', async () => {
    getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
    await runBootstrapLeg(SLUG, WS);
    expect(openHiveGitDuplexToDeviceMock).toHaveBeenCalledTimes(1);
    const [topic, device, req] = openHiveGitDuplexToDeviceMock.mock.calls[0];
    expect(Buffer.isBuffer(topic) && (topic as Buffer).toString('hex')).toBe('deadbeef');
    expect(device).toBe(PEER_DEVICE); // dials a peer, never self (WI-1559 squat guard stays in bootstrapFromPeer)
    expect((req as { repoKey: string }).repoKey).toBe(SLUG);
    expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(1);
  });

  it('EI-20438405483051865: uses the relocated sidecar dial when swarm is intentionally null in the main process', async () => {
    const sidecarDial = vi.fn(async () => dialDuplex(false));
    getBootedHarnessMock.mockReturnValue({
      swarm: null,
      openHiveGitDuplexToDevice: sidecarDial,
    });

    await runBootstrapLeg(SLUG, WS);

    expect(sidecarDial).toHaveBeenCalledTimes(1);
    expect(sidecarDial).toHaveBeenCalledWith(
      PEER_DEVICE,
      expect.objectContaining({ repoKey: SLUG }),
    );
    expect(openHiveGitDuplexToDeviceMock).not.toHaveBeenCalled();
    expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(1);
  });

  it('EI-20438405483051865: uses a fresh exact sidecar advertisement when the process-local registry misses', async () => {
    getBootedHarnessMock.mockReturnValue(null);
    getPgRelocatedHarnessEndpointMock.mockResolvedValue({
      socketPath: '/tmp/substrate-owner.sock',
      advertisedAt: 5_000,
    });

    await runBootstrapLeg(SLUG, WS);

    expect(getPgRelocatedHarnessEndpointMock).toHaveBeenCalledWith(WS, SLUG);
    expect(openHiveGitDuplexViaExistingSidecarMock).toHaveBeenCalledWith({
      socketPath: '/tmp/substrate-owner.sock',
      workspaceRoot: '/workspaces/ws-1',
      workspaceId: WS,
      harnessSlug: SLUG,
      devicePubkeyBase64: PEER_DEVICE,
      request: expect.objectContaining({ repoKey: SLUG }),
    });
    expect(bootSingleHarnessMock).not.toHaveBeenCalled();
    expect(openHiveGitDuplexToDeviceMock).not.toHaveBeenCalled();
    expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(1);
  });

  // ── WI-5168: federated repoKey (repo-identity.ts's canonicalRepoKey) ──────
  // A device's LOCAL install `slug` for the same upstream repo can differ from
  // a peer's (join-pot derives it from that device's own registry — e.g. a
  // tower registers 'hello-world-3', a joining VM registers 'hello-world' for
  // the SAME octocat/Hello-World), so keying the bare-store path AND the wire
  // repoKey on `slug` meant a G-8 fetch asked the peer for a repoKey the peer
  // never created its store under — NEVER rendezvousing for two devices whose
  // install slugs differ. These assert the store path + wire repoKey both key
  // on the FEDERATED identity (github_repository_id) instead, whenever it's
  // known — independent of what this device happens to call the repo locally.
  it('WI-5168: keys the bare store + wire repoKey on github_repository_id, NOT the local slug, when known', async () => {
    getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
    loadHarnessRegistryMock.mockResolvedValue({
      projects: [{ slug: 'hello-world-3', hive_slug: 'hello-world-3', self_repo: true, github_repository_id: 1296269 }],
    });
    await runBootstrapLeg('hello-world-3', WS);
    expect(ensurePotGitRepoMock).toHaveBeenCalledWith('hello-world-3', 'gh-1296269', expect.any(Function));
    expect(openHiveGitDuplexToDeviceMock).toHaveBeenCalledTimes(1);
    const [, , req] = openHiveGitDuplexToDeviceMock.mock.calls[0];
    expect((req as { repoKey: string }).repoKey).toBe('gh-1296269');
  });

  it('WI-5168: two devices with DIFFERENT local slugs for the SAME github_repository_id resolve to the IDENTICAL repoKey', async () => {
    // Simulates the exact live-caught defect: tower + VM registered the same
    // upstream under different install slugs. Both must derive the same
    // wire+store repoKey for G-8 to ever rendezvous.
    getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
    loadHarnessRegistryMock.mockResolvedValue({
      projects: [{ slug: 'hello-world-3', hive_slug: 'hello-world-3', self_repo: true, github_repository_id: 1296269 }],
    });
    await runBootstrapLeg('hello-world-3', WS);
    const towerRepoKey = (openHiveGitDuplexToDeviceMock.mock.calls[0][2] as { repoKey: string }).repoKey;
    openHiveGitDuplexToDeviceMock.mockClear();
    ensurePotGitRepoMock.mockClear();
    loadHarnessRegistryMock.mockResolvedValue({
      projects: [{ slug: 'hello-world', hive_slug: 'hello-world', self_repo: true, github_repository_id: 1296269 }],
    });
    await runBootstrapLeg('hello-world', WS);
    const vmRepoKey = (openHiveGitDuplexToDeviceMock.mock.calls[0][2] as { repoKey: string }).repoKey;
    expect(towerRepoKey).toBe(vmRepoKey);
    expect(towerRepoKey).toBe('gh-1296269');
  });

  it('WI-5168: falls back to owner/repo from github_remote when github_repository_id is not yet known', async () => {
    getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
    loadHarnessRegistryMock.mockResolvedValue({
      projects: [{
        slug: SLUG,
        hive_slug: SLUG,
        self_repo: true,
        github_remote: 'https://github.com/octocat/Hello-World.git',
      }],
    });
    await runBootstrapLeg(SLUG, WS);
    expect(ensurePotGitRepoMock).toHaveBeenCalledWith(SLUG, 'gh-octocat--hello-world', expect.any(Function));
  });

  it('WI-5168: falls back to the local slug when neither github_repository_id nor github_remote is known (pre-existing, non-regressed limitation)', async () => {
    await runBootstrapLeg(SLUG, WS); // default fixture: no github coords at all
    expect(ensurePotGitRepoMock).toHaveBeenCalledWith(SLUG, SLUG, expect.any(Function));
  });

  it('falls back to the pre-WI-3583 destroyed stub (never dials) when no live swarm topic exists', async () => {
    getBootedHarnessMock.mockReturnValue(null);
    await runBootstrapLeg(SLUG, WS);
    expect(openHiveGitDuplexToDeviceMock).not.toHaveBeenCalled();
    expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(1);
  });

  it('WI-5247: demand-boots the substrate when getBootedHarness misses (never-booted-this-process, not just evicted)', async () => {
    // Before the fix, a harness that was simply never booted this process
    // (as opposed to evicted-then-reboot-on-access) got a permanent null
    // from getBootedHarness with NOTHING registering demand for it — this
    // tick is exactly that demand signal and must fire a background boot.
    getBootedHarnessMock.mockReturnValue(null);
    await runBootstrapLeg(SLUG, WS);
    expect(bootSingleHarnessMock).toHaveBeenCalledWith(WS, SLUG);
  });

  it('WI-3496: a joined member resolves the live swarm by its local install slug, not the pot-home slug', async () => {
    const potHomeSlug = 'shop-hive-home';
    loadHarnessRegistryMock.mockResolvedValue({
      projects: [{
        slug: SLUG,
        hive_slug: potHomeSlug,
        self_repo: false,
        github_repository_id: 1_296_269,
      }],
    });
    getBootedHarnessMock.mockImplementation((_workspaceId, installSlug) =>
      installSlug === SLUG ? { swarm: { topicHex: 'deadbeef' } } : null,
    );
    openHiveGitDuplexToDeviceMock.mockImplementation(async () => dialDuplex(false));

    await runBootstrapLeg(SLUG, WS);

    expect(ensurePotGitRepoMock).toHaveBeenCalledWith(potHomeSlug, 'gh-1296269', expect.any(Function));
    expect(getBootedHarnessMock).toHaveBeenCalledWith(WS, SLUG);
    expect(getBootedHarnessMock).not.toHaveBeenCalledWith(WS, potHomeSlug);
    expect(bootSingleHarnessMock).not.toHaveBeenCalled();
    expect(openHiveGitDuplexToDeviceMock).toHaveBeenCalled();
  });

  it('WI-5247: does NOT demand-boot when getBootedHarness already returns a live handle', async () => {
    getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
    await runBootstrapLeg(SLUG, WS);
    expect(bootSingleHarnessMock).not.toHaveBeenCalled();
  });

  it('never throws and skips the DB patch when bootstrapFromPeer reports ok:false', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      bootstrapFromPeerMock.mockImplementation(bootstrapOutcome({
        ok: false,
        namespaces: [],
        skippedExisting: [],
        skippedSelf: null,
        stderr: 'fetch-failed: no live connection',
      }));
      await expect(runBootstrapLeg(SLUG, WS)).resolves.toBeUndefined();
      expect(routinesPatchCalls()).toHaveLength(1); // metadata is still patched with ok:false
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('bootstrap-tick reported errors'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  // ── Multi-candidate iteration + gh-free self-fallback (P-303 reverse-leg fix) ──
  // Before this fix a single `.find()` pick wedged G-8 permanently whenever its
  // one chosen candidate was offline/stale (a live registered peer sat unused),
  // and self-identification rode on `gh` reachability — an undefined self let
  // `find(d => d !== undefined)` pick THIS device's own attestation, so every
  // tick decoyed itself. Live-caught on the P-303 reverse-leg drill 2026-07-17.

  it('iterates to the next candidate when the first has no live dial path (destroyed decoy duplex)', async () => {
    getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
    listHiveMembersMock.mockResolvedValue([
      { deviceAttestations: [{ device_pubkey: PEER_DEVICE }, { device_pubkey: PEER_DEVICE_2 }] },
    ]);
    // First device: registry miss (pre-destroyed decoy); second: a live socket.
    openHiveGitDuplexToDeviceMock.mockImplementation(async (_t: Buffer, device: string) =>
      dialDuplex(device === PEER_DEVICE),
    );
    await runBootstrapLeg(SLUG, WS);
    // Dialed both, in order; only the live (second) one reached bootstrapFromPeer.
    expect(openHiveGitDuplexToDeviceMock).toHaveBeenCalledTimes(2);
    expect(openHiveGitDuplexToDeviceMock.mock.calls[0][1]).toBe(PEER_DEVICE);
    expect(openHiveGitDuplexToDeviceMock.mock.calls[1][1]).toBe(PEER_DEVICE_2);
    expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(1);
    const patch = routinesPatchBody();
    expect((patch.bootstrap as { ok?: boolean }).ok).toBe(true);
  });

  it('iterates past a LIVE candidate whose fetch fails (ok:false) to a later one that succeeds', async () => {
    getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
    listHiveMembersMock.mockResolvedValue([
      { deviceAttestations: [{ device_pubkey: PEER_DEVICE }, { device_pubkey: PEER_DEVICE_2 }] },
    ]);
    openHiveGitDuplexToDeviceMock.mockImplementation(async () => dialDuplex(false)); // both live
    bootstrapFromPeerMock
      .mockImplementationOnce(bootstrapOutcome({ ok: false, namespaces: [], skippedExisting: [], skippedSelf: null, stderr: 'fetch-failed: half-dead channel' }))
      .mockImplementationOnce(bootstrapOutcome({ ok: true, namespaces: ['abcd1234'], skippedExisting: [], skippedSelf: null, stderr: '' }));
    await runBootstrapLeg(SLUG, WS);
    expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(2); // first failed → tried the second
    const patch = routinesPatchBody();
    expect((patch.bootstrap as { ok?: boolean }).ok).toBe(true); // the final (successful) outcome wins
  });

  it('surfaces the peer refuse reason in the dialLog when a LIVE dial fails (duplex.errored)', async () => {
    // The dialing box already RECEIVES the peer's refuse over the wire
    // (serve-wiring handleRefuse destroys the client duplex with
    // `pot-git serve refused: <reason>`), retained on `duplex.errored`. The
    // tick log must show it so the reverse-leg cause is diagnosable HERE — not
    // only via a cross-machine serve.log read (P-303 drill 2026-07-17).
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
      listHiveMembersMock.mockResolvedValue([{ deviceAttestations: [{ device_pubkey: PEER_DEVICE }] }]);
      // A live socket that carries a retained destroy-error, exactly as a
      // refused FrameDuplex does (`.errored` set synchronously by .destroy(err)).
      openHiveGitDuplexToDeviceMock.mockImplementation(async () => ({
        on: (_ev: string, _cb: () => void) => {},
        destroyed: false,
        errored: new Error('pot-git serve refused: no-such-repo'),
      }));
      bootstrapFromPeerMock.mockImplementation(
        bootstrapOutcome({ ok: false, namespaces: [], skippedExisting: [], skippedSelf: null, stderr: 'duplex already destroyed before fetch began (no live dial path)' }),
      );
      await runBootstrapLeg(SLUG, WS);
      const warnMsg = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('bootstrap-tick reported errors'));
      expect(warnMsg).toBeTruthy();
      expect(warnMsg).toContain(`${PEER_DEVICE.slice(0, 8)}:failed(pot-git serve refused: no-such-repo)`);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('caps live fetch attempts at MAX_LIVE_ATTEMPTS (3) even with more failing candidates', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
      listHiveMembersMock.mockResolvedValue([
        { deviceAttestations: [PEER_DEVICE, PEER_DEVICE_2, PEER_DEVICE_3, PEER_DEVICE_4].map((d) => ({ device_pubkey: d })) },
      ]);
      openHiveGitDuplexToDeviceMock.mockImplementation(async () => dialDuplex(false)); // all live
      bootstrapFromPeerMock.mockImplementation(
        bootstrapOutcome({ ok: false, namespaces: [], skippedExisting: [], skippedSelf: null, stderr: 'fetch-failed: no upload-pack' }),
      );
      await runBootstrapLeg(SLUG, WS);
      // 4 live+failing candidates → only 3 attempts (the 4th short-circuits at
      // the loop top), and no 4th dial is even opened.
      expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(3);
      expect(openHiveGitDuplexToDeviceMock).toHaveBeenCalledTimes(3);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('bootstrap-tick reported errors'));
    } finally {
      warnSpy.mockRestore();
    }
  });

  // Anchored on the stable `bootstrap-tick` token (what the runbook greps for) and
  // on the dialLog entries — NOT on the prose. EI-18740968796318403 reworded this
  // warning (the old "no live dial path" phrasing was actively misleading: it means
  // a registry miss AT SAMPLE TIME, not an unreachable peer) and broke these two
  // assertions, which is the "test quotes emitted wording, has no drift guard"
  // failure mode. The dialLog signature below is the behaviour worth pinning.
  it('warns listing EVERY candidate when all are registry misses (dialLog signature)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
      listHiveMembersMock.mockResolvedValue([
        { deviceAttestations: [{ device_pubkey: PEER_DEVICE }, { device_pubkey: PEER_DEVICE_2 }] },
      ]);
      openHiveGitDuplexToDeviceMock.mockImplementation(async () => dialDuplex(true)); // all no-path
      await runBootstrapLeg(SLUG, WS);
      expect(bootstrapFromPeerMock).not.toHaveBeenCalled();
      const warnMsg = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('bootstrap-tick'));
      expect(warnMsg).toBeTruthy();
      expect(warnMsg).toContain(`${PEER_DEVICE.slice(0, 8)}:no-path`);
      expect(warnMsg).toContain(`${PEER_DEVICE_2.slice(0, 8)}:no-path`);
      const patch = routinesPatchBody();
      expect((patch.bootstrap as { ok?: boolean }).ok).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  /**
   * EI-18775478513129278, live-caught on the WI-6299 cold-join drill: a tick that
   * gets NO live dial at all (every candidate a registry miss, `outcome` stays
   * null) used to force namespaceCount/quarantineRefs/phase/shallow/deepenNext to
   * 0/null on the SAME write path exercised above — silently erasing the record
   * of every rung a PRIOR tick had actually climbed and durably landed on disk,
   * even though nothing on disk regressed. `rungs:0`/`ok:false` are honest for
   * THIS tick (nothing was dialed); the durable progress fields must instead
   * carry forward the last-recorded values.
   */
  it('EI-18775478513129278: a no-dial tick carries forward the PRIOR durable progress instead of zeroing it', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
      listHiveMembersMock.mockResolvedValue([{ deviceAttestations: [{ device_pubkey: PEER_DEVICE }] }]);
      openHiveGitDuplexToDeviceMock.mockImplementation(async () => dialDuplex(true)); // registry miss — no live dial
      sqlTagMock.mockResolvedValue([
        {
          bootstrap: {
            phase: 'deepen',
            namespaceCount: 1,
            quarantineRefs: 4,
            shallow: true,
            deepenNext: 128,
          },
        },
      ]);

      await runBootstrapLeg(SLUG, WS);

      expect(bootstrapFromPeerMock).not.toHaveBeenCalled(); // genuinely no dial this tick
      const patch = routinesPatchBody().bootstrap as Record<string, unknown>;
      // Honest per-tick facts: nothing was dialed, so nothing climbed THIS tick.
      expect(patch).toMatchObject({ ok: false, rungs: 0, path: 'dialed' });
      // Carried forward from the prior tick's durable disk state — NOT zeroed.
      expect(patch).toMatchObject({
        namespaceCount: 1,
        quarantineRefs: 4,
        phase: 'deepen',
        shallow: true,
        deepenNext: 128,
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('unavailable serving authority uses cached identity only to exclude self from bootstrap candidates', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
    resolveServingIdentityMock.mockResolvedValue(null); // owner has no current serving authority
    loadCachedLocalAnnounceIdentityMock.mockResolvedValue({ devicePubkeyBase64: SELF_DEVICE });
    listHiveMembersMock.mockResolvedValue([
      { deviceAttestations: [{ device_pubkey: SELF_DEVICE }, { device_pubkey: PEER_DEVICE }] },
    ]);
    openHiveGitDuplexToDeviceMock.mockImplementation(async () => dialDuplex(false));
    await runBootstrapLeg(SLUG, WS);
    expect(loadCachedLocalAnnounceIdentityMock).toHaveBeenCalled(); // the `??` fallback arm was taken
    // self filtered out → only the peer is dialed, carrying the cache-derived
    // selfDevicePubkey (not undefined, which used to let find() pick self).
    expect(openHiveGitDuplexToDeviceMock).toHaveBeenCalledTimes(1);
    expect(openHiveGitDuplexToDeviceMock.mock.calls[0][1]).toBe(PEER_DEVICE);
    expect((bootstrapFromPeerMock.mock.calls[0][2] as Record<string, unknown>).selfDevicePubkey).toBe(SELF_DEVICE);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('serving unavailable'));
    warn.mockRestore();
  });

  it('unavailable serving authority and cache miss still allow read-only bootstrap', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
    resolveServingIdentityMock.mockResolvedValue(null);
    loadCachedLocalAnnounceIdentityMock.mockResolvedValue(null); // nothing cached either
    listHiveMembersMock.mockResolvedValue([{ deviceAttestations: [{ device_pubkey: PEER_DEVICE }] }]);
    openHiveGitDuplexToDeviceMock.mockImplementation(async () => dialDuplex(false));
    await expect(runBootstrapLeg(SLUG, WS)).resolves.toBeUndefined();
    expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(1);
    expect((bootstrapFromPeerMock.mock.calls[0][2] as Record<string, unknown>).selfDevicePubkey).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('serving unavailable'));
    warn.mockRestore();
  });

  // ── EI-15333: no-such-repo dial backoff ──
  // A peer that definitively refuses a bootstrap dial with `no-such-repo`
  // (it genuinely has no store for this repo) used to be re-dialed every
  // single tick forever — a wasted live handshake plus an identical
  // permanent error line. It should back off instead: not be live-dialed
  // again for a bounded window, without disturbing dialing of OTHER
  // candidates or of a DIFFERENT repo/slug.

  it('EI-15333: does not re-dial a peer within the backoff window after a no-such-repo refusal', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
      listHiveMembersMock.mockResolvedValue([{ deviceAttestations: [{ device_pubkey: PEER_DEVICE }] }]);
      openHiveGitDuplexToDeviceMock.mockImplementation(async () => ({
        on: (_ev: string, _cb: () => void) => {},
        destroyed: false,
        errored: new Error('pot-git serve refused: no-such-repo'),
      }));
      bootstrapFromPeerMock.mockImplementation(
        bootstrapOutcome({ ok: false, namespaces: [], skippedExisting: [], skippedSelf: null, stderr: 'no-such-repo' }),
      );

      // First tick: a real live dial happens and refuses no-such-repo.
      await runBootstrapLeg(SLUG, WS);
      expect(openHiveGitDuplexToDeviceMock).toHaveBeenCalledTimes(1);
      expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(1);

      // Second tick (same process, backoff window still open): the peer is
      // skipped WITHOUT a live dial — the leg falls straight to the "no live
      // dial path" branch since it's the only candidate.
      warnSpy.mockClear();
      await runBootstrapLeg(SLUG, WS);
      expect(openHiveGitDuplexToDeviceMock).toHaveBeenCalledTimes(1); // unchanged — no new dial
      expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(1); // unchanged
      const warnMsg = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('bootstrap-tick'));
      expect(warnMsg).toContain(`${PEER_DEVICE.slice(0, 8)}:backoff(no-such-repo)`);
    } finally {
      warnSpy.mockRestore();
    }
  });

  // ── WI-6364 (fix C): a superseded-store refusal RE-KEYS this device ──
  // The peer refused because the key we asked for names a store IT ABANDONED,
  // and named the store it actually writes. That refusal is the one repair
  // channel needing nothing but the dial we already made — see
  // adopt-refused-repo-key.ts.

  it('WI-6364: a superseded-repo-key refusal adopts the peer-named key and stops the tick', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
      // TWO candidates: the tick must STOP after the re-key rather than dial on
      // under a key it has just replaced.
      listHiveMembersMock.mockResolvedValue([
        { deviceAttestations: [{ device_pubkey: PEER_DEVICE }, { device_pubkey: PEER_DEVICE_2 }] },
      ]);
      openHiveGitDuplexToDeviceMock.mockImplementation(async () => ({
        on: (_ev: string, _cb: () => void) => {},
        destroyed: false,
        errored: new Error('pot-git serve refused: superseded-repo-key:gh-1223568103'),
      }));
      bootstrapFromPeerMock.mockImplementation(
        bootstrapOutcome({ ok: false, namespaces: [], skippedExisting: [], skippedSelf: null, stderr: 'refused' }),
      );

      await runBootstrapLeg(SLUG, WS);

      // The registry was re-keyed onto the peer's key, stamped 'peer' so the
      // boot backfill cannot re-derive over it.
      expect(saveHarnessRegistryMock).toHaveBeenCalledTimes(1);
      const saved = saveHarnessRegistryMock.mock.calls[0]![0] as { projects: RegistryProject[] };
      const entry = saved.projects.find((p) => p.slug === SLUG) as Record<string, unknown>;
      expect(entry.pot_repo_key).toBe('gh-1223568103');
      expect(entry.pot_repo_key_source).toBe('peer');

      // Broke out — the second candidate was never dialed under the dead key.
      expect(openHiveGitDuplexToDeviceMock).toHaveBeenCalledTimes(1);

      // And it SAYS SO. A silent re-key is how the original divergence went
      // unnoticed for 7 days; this line is the whole point of the branch.
      const msg = logSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('RE-KEYED'));
      expect(msg).toContain('gh-1223568103');
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('WI-6364: a NON-superseded refusal never touches the registry', async () => {
    // The guard that keeps this off the hot path: every other refusal reason
    // (and every generic dial failure) must short-circuit before any registry
    // read, or a re-key becomes reachable from a transient error.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
      listHiveMembersMock.mockResolvedValue([{ deviceAttestations: [{ device_pubkey: PEER_DEVICE }] }]);
      openHiveGitDuplexToDeviceMock.mockImplementation(async () => ({
        on: (_ev: string, _cb: () => void) => {},
        destroyed: false,
        errored: new Error('pot-git serve refused: no-such-repo'),
      }));
      bootstrapFromPeerMock.mockImplementation(
        bootstrapOutcome({ ok: false, namespaces: [], skippedExisting: [], skippedSelf: null, stderr: 'no-such-repo' }),
      );

      await runBootstrapLeg(SLUG, WS);

      expect(saveHarnessRegistryMock).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('EI-15333: a generic (non-no-such-repo) dial failure does NOT arm the backoff — retried next tick', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
      listHiveMembersMock.mockResolvedValue([{ deviceAttestations: [{ device_pubkey: PEER_DEVICE }] }]);
      openHiveGitDuplexToDeviceMock.mockImplementation(async () => dialDuplex(false)); // live, no .errored
      bootstrapFromPeerMock.mockImplementation(
        bootstrapOutcome({ ok: false, namespaces: [], skippedExisting: [], skippedSelf: null, stderr: 'fetch-failed: half-dead channel' }),
      );

      await runBootstrapLeg(SLUG, WS);
      await runBootstrapLeg(SLUG, WS);
      // Both ticks actually dialed — no backoff was armed for a non-no-such-repo failure.
      expect(openHiveGitDuplexToDeviceMock).toHaveBeenCalledTimes(2);
      expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('EI-15333: backoff on one peer does not block dialing a DIFFERENT candidate', async () => {
    getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
    listHiveMembersMock.mockResolvedValue([
      { deviceAttestations: [{ device_pubkey: PEER_DEVICE }, { device_pubkey: PEER_DEVICE_2 }] },
    ]);
    openHiveGitDuplexToDeviceMock.mockImplementation(async (_t: Buffer, device: string) => ({
      on: (_ev: string, _cb: () => void) => {},
      destroyed: false,
      errored: device === PEER_DEVICE ? new Error('pot-git serve refused: no-such-repo') : undefined,
    }));
    bootstrapFromPeerMock
      .mockImplementationOnce(bootstrapOutcome({ ok: false, namespaces: [], skippedExisting: [], skippedSelf: null, stderr: 'no-such-repo' }))
      .mockImplementation(bootstrapOutcome({ ok: true, namespaces: ['abcd1234'], skippedExisting: [], skippedSelf: null, stderr: '' }));

    await runBootstrapLeg(SLUG, WS); // arms backoff on PEER_DEVICE, succeeds via PEER_DEVICE_2
    expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(2);

    // Reset and re-run: PEER_DEVICE_2's namespace is now present locally
    // (as bootstrapFromPeer's real effect would leave it), so the warm gate
    // short-circuits before any dialing on this next tick — never even
    // reaching the point where PEER_DEVICE's backoff would matter.
    const peer2Hex = Buffer.from(PEER_DEVICE_2, 'base64').toString('hex');
    listNamespacesMock.mockResolvedValue([peer2Hex]);
    openHiveGitDuplexToDeviceMock.mockClear();
    bootstrapFromPeerMock.mockClear();
    await runBootstrapLeg(SLUG, WS);
    expect(openHiveGitDuplexToDeviceMock).not.toHaveBeenCalled(); // warm — no dialing needed at all
  });

  // ── WI-6418: ONE in-flight ladder per repo ─────────────────────────────────
  // ~12 staggered git-sync routines all reach this leg for the SAME repo, so a
  // fetch drive landed roughly every ~15s in aggregate. Each opened its own
  // session, and the serve side — whose cap counts same-repo serves across EVERY
  // connection — then refused (or, pre-WI-6412, superseded) the transfer already
  // streaming. A multi-GB pot needs ~175s, so it restarted forever at ANY
  // throughput: the ceiling is a PERIOD, not a RATE, which is why three rounds of
  // measured throughput work moved it by exactly zero.
  //
  // The second tick must STAND DOWN, not queue behind the first: joining would
  // hand it the first drive's result, which was driven by a different candidate
  // set, so it would report success for work that never covered its own input.
  it('WI-6418: a concurrent tick for the same repo stands down instead of opening a second session', async () => {
    getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
    listNamespacesMock.mockResolvedValue([]); // cold — the warm gate must not short-circuit
    listHiveMembersMock.mockResolvedValue([{ deviceAttestations: [{ device_pubkey: PEER_DEVICE }] }]);

    let sawDial!: () => void;
    const dialed = new Promise<void>((resolve) => {
      sawDial = resolve;
    });
    openHiveGitDuplexToDeviceMock.mockImplementation(async () => {
      sawDial();
      return dialDuplex(false); // live
    });

    // Hold the first ladder open so the second tick genuinely OVERLAPS it —
    // without this the first would finish and the guard would never be exercised.
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const succeed = bootstrapOutcome({
      ok: true,
      namespaces: ['abcd1234'],
      skippedExisting: [],
      skippedSelf: null,
      stderr: '',
    });
    bootstrapFromPeerMock.mockImplementationOnce(
      async (repoPath: string, duplex: FakeDuplex, opts: Record<string, unknown>) => {
        await held;
        return succeed(repoPath, duplex, opts);
      },
    );

    const first = runBootstrapLeg(SLUG, WS);
    await dialed; // the first tick is now inside the coalescer, mid-transfer

    await runBootstrapLeg(SLUG, WS); // the concurrent tick — must add nothing

    // The whole point of the fix: ONE session for this repo, not two.
    expect(openHiveGitDuplexToDeviceMock).toHaveBeenCalledTimes(1);
    expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(1);

    finish();
    await first;
    expect(bootstrapFromPeerMock).toHaveBeenCalledTimes(1); // the stood-down tick never ran one

    // And the entry is RELEASED on completion — a leaked key would wedge every
    // future tick for this repo, which is strictly worse than the bug being fixed.
    openHiveGitDuplexToDeviceMock.mockClear();
    bootstrapFromPeerMock.mockClear();
    bootstrapFromPeerMock.mockImplementationOnce(succeed);
    await runBootstrapLeg(SLUG, WS);
    expect(openHiveGitDuplexToDeviceMock).toHaveBeenCalledTimes(1);
  });

  /**
   * WI-37226 — the PERSISTENT-miss signal.
   *
   * The miss warning has always ended "persistent misses across many ticks are the
   * real signal", and nothing counted them: every miss logged identically, so a churn
   * blip and a dead federation were indistinguishable in the log. Measured cost
   * (EI-18808621019872598): "418/418 ticks failed over 2h17m across 39 repos, zero
   * advanced" was only establishable by hand-counting journal lines after the fact.
   *
   * These tests pin the run-length arithmetic AND — deliberately — that the escalation
   * asserts NO CAUSE. Upgrading a long run to a diagnosis ("the peer is dark") is the
   * exact move that cost EI-18740968796318403 and the WI-6299 drill a wrong root cause.
   */
  describe('WI-37226: persistent-miss run-length', () => {
    /** A tick where every candidate is a registry miss → `outcome` stays null. */
    async function missTick(prior: Record<string, unknown> | null): Promise<Record<string, unknown>> {
      unsafeMock.mockClear();
      getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
      listHiveMembersMock.mockResolvedValue([{ deviceAttestations: [{ device_pubkey: PEER_DEVICE }] }]);
      openHiveGitDuplexToDeviceMock.mockImplementation(async () => dialDuplex(true));
      sqlTagMock.mockResolvedValue(prior ? [{ bootstrap: prior }] : []);
      await runBootstrapLeg(SLUG, WS);
      return routinesPatchBody().bootstrap as Record<string, unknown>;
    }

    it('counts CONSECUTIVE misses across ticks and stamps when the run started', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const first = await missTick(null);
        expect(first.consecutiveMisses).toBe(1);
        expect(typeof first.firstMissAt).toBe('number');

        // A second miss extends the run and PRESERVES the original start stamp —
        // duration is what makes the escalation meaningful if the cadence changes.
        const second = await missTick({ consecutiveMisses: 1, firstMissAt: 1_000 });
        expect(second.consecutiveMisses).toBe(2);
        expect(second.firstMissAt).toBe(1_000);
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('a real dial ENDS the run — including one that errored (it proved a live path existed)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        unsafeMock.mockClear();
        getBootedHarnessMock.mockReturnValue({ swarm: { topicHex: 'deadbeef' } });
        listHiveMembersMock.mockResolvedValue([{ deviceAttestations: [{ device_pubkey: PEER_DEVICE }] }]);
        openHiveGitDuplexToDeviceMock.mockImplementation(async () => dialDuplex(false)); // live dial
        bootstrapFromPeerMock.mockImplementation(
          bootstrapOutcome({ ok: false, namespaces: [], skippedExisting: [], skippedSelf: null, stderr: 'fetch-failed' }),
        );
        sqlTagMock.mockResolvedValue([{ bootstrap: { consecutiveMisses: 9, firstMissAt: 1_000 } }]);

        await runBootstrapLeg(SLUG, WS);

        const patch = routinesPatchBody().bootstrap as Record<string, unknown>;
        expect(patch.consecutiveMisses).toBe(0);
        expect(patch.firstMissAt).toBeNull();
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('ESCALATES at the threshold, reporting run length + duration', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        // 5 prior misses + this one = 6 = BOOTSTRAP_PERSISTENT_MISS_THRESHOLD.
        await missTick({ consecutiveMisses: 5, firstMissAt: Date.now() - 62 * 60_000 });
        const warnMsg = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('bootstrap-tick'));
        expect(warnMsg).toContain('PERSISTENT-MISS ESCALATION');
        expect(warnMsg).toContain('6 consecutive ticks');
        expect(warnMsg).toMatch(/~6[12]m/); // wall-clock duration, not just a count
      } finally {
        warnSpy.mockRestore();
      }
    });

    /**
     * FALSIFIABILITY CONTROL — keep this. It encodes the pre-fix behaviour boundary:
     * if the escalation branch is ever made unconditional (or the threshold dropped to
     * 1), a single churn miss starts shouting and this test is what catches it. The
     * escalation is only worth anything because the ordinary case stays quiet.
     */
    it('does NOT escalate below the threshold — a single miss stays the quiet case', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await missTick(null); // run length 1
        const warnMsg = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('bootstrap-tick'));
        expect(warnMsg).toBeTruthy();
        expect(warnMsg).not.toContain('PERSISTENT-MISS ESCALATION');
        // Still says what a miss means, and now shows progress toward escalation.
        expect(warnMsg).toContain('registry miss at sample time');
        expect(warnMsg).toContain('1/6 before escalation');
      } finally {
        warnSpy.mockRestore();
      }
    });

    /**
     * The escalation must raise CONFIDENCE THAT SOMETHING IS WRONG without inventing a
     * cause. This tree has twice paid for the opposite (EI-18740968796318403, WI-6299):
     * a miss reads like "the peer is unreachable" and is not. So: it offers the rig
     * preflight as a CHECK TO RUN, and says in as many words that it names no cause.
     */
    it('escalation names CHECKS TO RUN, never a diagnosis', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        await missTick({ consecutiveMisses: 5, firstMissAt: Date.now() - 60 * 60_000 });
        const warnMsg = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('bootstrap-tick'))!;
        expect(warnMsg).toContain('This log names NO cause');
        // the kcpassword/loginwindow class is offered as a discriminating PROBE…
        expect(warnMsg).toContain('preflight-login.sh');
        // …and never asserted as the conclusion.
        expect(warnMsg).not.toMatch(/kcpassword (drift )?detected|the peer is (dark|down|at the loginwindow)/i);
      } finally {
        warnSpy.mockRestore();
      }
    });

    /**
     * WI-37574. Discriminator (2) — "is any swarm connection present at all" — is the
     * one of the three this PROCESS can answer from memory: (1) needs the rig over SSH
     * and (3) needs a topic comparison, but the content-announce peer count for this
     * exact topic is an O(1) Map read we are already holding. Asking the READER for it
     * cost two consecutive wakes a manual journal dig on EI-18808621019872598, and its
     * absence invited the wrong reading ("pot-git pairing is COMPLETELY down", i.e. a
     * swarm fault) when the swarm was healthy and simply had no peer.
     *
     * Note what is asserted: a MEASUREMENT plus the conditional reading the log already
     * spelled out — never a cause. The "names no cause" test above is the pair to this
     * one and must keep passing.
     */
    it('escalation ANSWERS discriminator (2) in-band — unpaired topic reads as reachability', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      contentPeerCountForTopicMock.mockReturnValue(0);
      lastContentAnnounceRecvMsMock.mockReturnValue(null);
      try {
        await missTick({ consecutiveMisses: 5, firstMissAt: Date.now() - 60 * 60_000 });
        const warnMsg = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('bootstrap-tick'))!;
        // The measurement, scoped to THIS topic. Anchored to the "at this instant:"
        // slot on purpose — the static Reading: clause after it legitimately contains
        // the literal strings "contentPeers=0" and "lastAnnounceRecv=never" as prose,
        // so an unanchored toContain would pass on the explanation alone and measure
        // nothing.
        expect(warnMsg).toMatch(/at this instant: contentPeers=0 lastAnnounceRecv=never/);
        // and it is read as EVIDENCE, still naming no cause
        expect(warnMsg).toContain('This log names NO cause');
        expect(warnMsg).not.toMatch(/the peer is (dark|down|at the loginwindow)/i);
      } finally {
        warnSpy.mockRestore();
      }
    });

    /**
     * FALSIFIABILITY CONTROL for the test above. If the escalation ever hardcodes the
     * unpaired strings (or stops calling the accessors at all), the test above still
     * passes while measuring nothing — this case is what fails. The two readings must
     * DIFFER, because the whole point of discriminator (2) is that it routes the
     * investigation two different ways.
     */
    it('…and a PAIRED topic reads the other way — registry/topic, not reachability', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      contentPeerCountForTopicMock.mockReturnValue(3);
      lastContentAnnounceRecvMsMock.mockReturnValue(Date.now() - 4 * 60_000);
      try {
        await missTick({ consecutiveMisses: 5, firstMissAt: Date.now() - 60 * 60_000 });
        const warnMsg = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('bootstrap-tick'))!;
        expect(warnMsg).toMatch(/at this instant: contentPeers=3 lastAnnounceRecv=~?4m ago/);
        // the measured slot must NOT read "never" here (the prose Reading: clause
        // still mentions it, hence the anchor)
        expect(warnMsg).not.toMatch(/at this instant: contentPeers=\d+ lastAnnounceRecv=never/);
        // the accessors are scoped to the topic under investigation, not process-global
        expect(contentPeerCountForTopicMock).toHaveBeenCalledWith('deadbeef');
      } finally {
        contentPeerCountForTopicMock.mockReturnValue(0);
        lastContentAnnounceRecvMsMock.mockReturnValue(null);
        warnSpy.mockRestore();
      }
    });

    /**
     * A logging path must never throw, and an unreadable measurement must NOT render as
     * a zero — "0 peers" and "could not measure" route the investigation to opposite
     * conclusions. This is the same unknown-is-not-absent rule that the surrounding
     * codebase pays for repeatedly (a `.get('timers', [])` turning not_found into a
     * false `total 0`).
     */
    it('an unreadable swarm degrades to UNKNOWN — never to a fabricated zero', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      contentPeerCountForTopicMock.mockImplementation(() => {
        throw new Error('swarm module unavailable');
      });
      try {
        await missTick({ consecutiveMisses: 5, firstMissAt: Date.now() - 60 * 60_000 });
        const warnMsg = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('bootstrap-tick'))!;
        expect(warnMsg).toContain('PERSISTENT-MISS ESCALATION'); // the tick survived
        expect(warnMsg).toMatch(/at this instant: contentPeers=UNKNOWN/);
        // the fabricated-zero regression this case exists to catch (anchored, since
        // the prose Reading: clause legitimately says "contentPeers=0")
        expect(warnMsg).not.toMatch(/at this instant: contentPeers=0/);
      } finally {
        contentPeerCountForTopicMock.mockReset();
        contentPeerCountForTopicMock.mockReturnValue(0);
        warnSpy.mockRestore();
      }
    });

    /**
     * The no-topic-stub writer replaces the WHOLE `bootstrap` key, so omitting these
     * fields DELETES them — and a deleted run reads as "the run ended", silently
     * clearing a live escalation. That writer attempts no dial, so it can neither
     * extend a run nor end one. (Same accidental-erasure class as WI-6284 /
     * EI-18799556647570956, with a field where the erasure would actually mislead.)
     */
    it('the no-topic-stub writer CARRIES the run forward instead of zeroing it', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        unsafeMock.mockClear();
        getBootedHarnessMock.mockReturnValue({ swarm: {} }); // no topicHex → stub path
        sqlTagMock.mockResolvedValue([{ bootstrap: { consecutiveMisses: 7, firstMissAt: 1_000 } }]);

        await runBootstrapLeg(SLUG, WS);

        const patch = routinesPatchBody().bootstrap as Record<string, unknown>;
        expect(patch.path).toBe('no-topic-stub');
        expect(patch.consecutiveMisses).toBe(7);
        expect(patch.firstMissAt).toBe(1_000);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
