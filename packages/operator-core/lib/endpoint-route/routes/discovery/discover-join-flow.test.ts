/**
 * discover-join-flow.test.ts — the END-TO-END discover→join FLOW integration test
 * (campaign shared-hive-public-release-2026-06-22, Lane T2).
 *
 * The per-route unit tests (set-pot / join-pot / join-invite / pots) each pin
 * one route's validation + forwarding against a MOCKED composition. This file
 * instead exercises the WHOLE flow over the REAL `HiveDirectory` so the seam
 * between the pieces is covered:
 *
 *   set-pot visibility → which topic the announce lands on
 *     (public → the GLOBAL directory topic; invite → a SECRET-gated topic;
 *      private → never on the wire)
 *   → discovery:pots (GET /api/discovery/pots) lists a DISCOVERED public hive
 *   → join-pot forwards the DISCOVERED memberLinks into joinHiveAsView
 *   → join-invite (secret) surfaces an invite hive a global browser can't see
 *   → a PRIVATE hive is never discoverable (and a forged private frame is
 *     rejected by verifyHiveAnnounce — defense in depth).
 *
 * Two real `HiveDirectory` instances (an OWNER that announces + a JOINER that
 * browses) are wired through an in-memory topic-scoped gossip "bus": the owner's
 * `broadcast(topicHex, frame)` is delivered to a joiner's `ingestAnnounce` ONLY
 * when the joiner is subscribed to that topic. This models the directory's
 * topic-scoped gossip exactly (deriveDirectoryTopic vs deriveInviteTopic) with no
 * swarm, keychain, or PG — so it is a fast, deterministic `.test.ts` (picked up by
 * `test:affected` AND its `:integration` superset), NOT a Docker/testcontainers
 * `.integration.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';

// ── module mocks (hoisted, file-wide) — only the heavy compositions + ambient
//    singletons the routes reach; the directory/topic/announce modules stay REAL.
const joinHiveAsView = vi.fn();
const bustProjectsLiteCache = vi.fn();
const ensureHiveDirectoryWired = vi.fn();
vi.mock('../../../workspace-registry', () => ({ activeWorkspaceId: () => 'ws-test' }));
// The directory also folds in JOINED remote views from the harness registry
// (discovery-hive-rows joinedRemoteRows), which reads org PG. This suite is about
// DISCOVERED hives, so the registry is empty: no joined rows, no live database.
vi.mock('../../../harness-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../harness-registry')>()),
  loadHarnessRegistry: vi.fn(async () => ({ projects: [] })),
}));
vi.mock('../../../harness/join-hive', () => ({
  joinHiveAsView: (...a: unknown[]) => joinHiveAsView(...a),
}));
vi.mock('../../../harness/projects-lite', () => ({
  bustProjectsLiteCache: (...a: unknown[]) => bustProjectsLiteCache(...a),
  buildProjectsLitePayload: vi.fn(async () => ({ projects: [] })),
}));
vi.mock('../../../hive-directory-boot', () => ({
  ensureHiveDirectoryWired: (...a: unknown[]) => ensureHiveDirectoryWired(...a),
}));

import {
  HiveDirectory,
  type HiveDirectoryDeps,
  type LocalHiveDescriptor,
} from '../../../hive-directory';
import {
  configureHiveDirectoryForTest,
  __resetHiveDirectorySingleton,
} from '../../../hive-directory-deps';
import {
  deriveDirectoryTopic,
  deriveInviteTopic,
  hiveTopicAsHex,
} from '../../../sync/hyperbee/derive-hive-topic';
import { buildHiveAnnounce, type HiveAnnounceBody } from '../../../sync/hyperbee/hive-announce';
import { formatHiveInviteLink } from '../../../harness/hive-invite-link';
import hivesRoute from './pots';
import joinHiveRoute from './join-pot';
import joinInviteRoute from './join-invite';

const NOW = 1_700_000_000_000;
const MEMBER_TOPIC = 'a'.repeat(64);
const MEMBER_LINK = 'papercusp://harness?topic=' + 'b'.repeat(64);
// A 64-hex invite secret — matches SECRET_RE + the 256-bit mint strength.
const INVITE_SECRET = 'c'.repeat(64);

/** Raw 32-byte Ed25519 pubkey → base64 (== a hive announce's owner_device_pubkey). */
function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64');
}

// ── shared per-test state ─────────────────────────────────────────────────────
let clock: { ms: number };
/** topicHex → the directories subscribed to it (the gossip bus). */
let bus: Map<string, Set<HiveDirectory>>;
let owner: HiveDirectory; // announces its owned hives
let joiner: HiveDirectory; // the GET /discovery/pots singleton — browses
let ownerPubkeyB64: string;
let ownerSign: (bytes: Buffer) => Promise<Buffer>;

function subscribe(dir: HiveDirectory, topicHex: string): void {
  let set = bus.get(topicHex);
  if (!set) {
    set = new Set();
    bus.set(topicHex, set);
  }
  set.add(dir);
}

function ownerDeps(): HiveDirectoryDeps {
  return {
    sign: (bytes) => ownerSign(bytes),
    verifyAttestation: async () => true,
    now: () => clock.ms,
    // Topic-scoped gossip: deliver only to peers subscribed to THIS topic.
    broadcast: async (topicHex, frame) => {
      for (const dir of bus.get(topicHex) ?? []) await dir.ingestAnnounce(frame);
    },
  };
}

function joinerDeps(): HiveDirectoryDeps {
  return {
    sign: async (b) => b, // unused on the browsing side
    verifyAttestation: async () => true,
    now: () => clock.ms,
    broadcast: async () => {},
  };
}

function registerOwnedHive(
  over: Partial<LocalHiveDescriptor> & Pick<LocalHiveDescriptor, 'potId' | 'visibility'>,
): void {
  owner.registerLocalHive({
    title: over.potId,
    description: 'd',
    ownerGithubLogin: 'alice',
    ownerGithubUserId: 1,
    ownerDevicePubkey: ownerPubkeyB64,
    attestationGistId: 'gist-1',
    createdAt: NOW - 1000,
    memberTopics: [MEMBER_TOPIC],
    memberLinks: [MEMBER_LINK],
    ...over,
  });
}

async function getHives(): Promise<{ status: number; body: any }> {
  const res = (await hivesRoute.handler(
    new Request('http://127.0.0.1/api/discovery/pots') as never,
    {} as never,
  )) as Response;
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function postJoinHive(body: unknown): Promise<{ status: number; body: any }> {
  const req = new Request('http://127.0.0.1/api/discovery/join-pot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = (await joinHiveRoute.handler(req as never, {} as never)) as Response;
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function postJoinInvite(body: unknown): Promise<{ status: number; body: any }> {
  const req = new Request('http://127.0.0.1/api/discovery/join-invite', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = (await joinInviteRoute.handler(req as never, {} as never)) as Response;
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeEach(() => {
  joinHiveAsView.mockReset();
  joinHiveAsView.mockResolvedValue({ ok: true, members: [{ slug: 'm', ok: true }], viewSlug: 'acme' });
  bustProjectsLiteCache.mockReset();
  ensureHiveDirectoryWired.mockReset();

  clock = { ms: NOW };
  bus = new Map();
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  ownerPubkeyB64 = rawPubkeyBase64(publicKey);
  ownerSign = async (bytes) => nodeSign(null, bytes, privateKey);

  owner = new HiveDirectory(ownerDeps());
  // configureHiveDirectoryForTest installs the singleton the GET /discovery/pots
  // route reads via getHiveDirectory().
  joiner = configureHiveDirectoryForTest(joinerDeps());
  // The joiner browses the global directory by default.
  subscribe(joiner, hiveTopicAsHex(deriveDirectoryTopic()));
});

afterEach(() => {
  __resetHiveDirectorySingleton();
});

describe('discover→join flow (shared-hive-release T2)', () => {
  describe('set-pot visibility → announce topic', () => {
    it('public → announced on the GLOBAL directory topic, discovered by a browsing peer', async () => {
      registerOwnedHive({ potId: 'acme', visibility: 'public' });
      const frame = await owner.announceLocalHive('acme');
      expect(frame).not.toBeNull();
      // The peer subscribed to the global topic discovered it.
      expect(joiner.listDiscoveredHives().map((h) => h.potId)).toContain('acme');
    });

    it('invite → announced on the SECRET-gated topic only, invisible to a global browser', async () => {
      registerOwnedHive({ potId: 'inv', visibility: 'invite', inviteSecret: INVITE_SECRET });
      await owner.announceLocalHive('inv');

      // The invite topic is distinct from the global directory topic …
      const inviteHex = hiveTopicAsHex(deriveInviteTopic(INVITE_SECRET));
      const globalHex = hiveTopicAsHex(deriveDirectoryTopic());
      expect(inviteHex).not.toBe(globalHex);
      // … so a peer browsing ONLY the global directory never sees it.
      expect(joiner.listDiscoveredHives().map((h) => h.potId)).not.toContain('inv');

      // A peer that holds the secret joins the invite topic → the owner's
      // (periodic) re-announce now reaches it (newer ts keeps LWW happy).
      subscribe(joiner, inviteHex);
      clock.ms += 1000;
      await owner.announceLocalHive('inv');
      expect(joiner.listDiscoveredHives().map((h) => h.potId)).toContain('inv');
    });

    it('private → never announces (no frame on any topic, nothing discovered)', async () => {
      registerOwnedHive({ potId: 'priv', visibility: 'private' });
      const frame = await owner.announceLocalHive('priv');
      expect(frame).toBeNull();
      expect(joiner.listDiscoveredHives()).toHaveLength(0);
      // It is also skipped by the fresh-pair snapshot build (no topic to send on).
      expect(await owner.buildOwnedAnnounces()).toHaveLength(0);
    });

    it('a forged private announce on the wire is rejected by verify (never ingested)', async () => {
      // Defense in depth: even a correctly-signed frame whose visibility is
      // `private` must be refused by verifyHiveAnnounce, so it can never be
      // ingested + listed.
      const body: HiveAnnounceBody = {
        hive_id: 'sneaky',
        title: 'S',
        description: 'd',
        owner_github_login: 'alice',
        owner_github_user_id: 1,
        owner_device_pubkey: ownerPubkeyB64,
        attestation_gist_id: 'gist-1',
        member_topics: [MEMBER_TOPIC],
        visibility: 'private',
        created_at: NOW - 1000,
        ts: clock.ms,
      };
      const frame = await buildHiveAnnounce(body, ownerSign);
      const res = await joiner.ingestAnnounce(frame);
      expect(res.accepted).toBe(false);
      expect(joiner.listDiscoveredHives()).toHaveLength(0);
    });
  });

  describe('discovery:pots (GET /api/discovery/pots)', () => {
    it('lists a discovered public hive with its memberLinks', async () => {
      registerOwnedHive({ potId: 'acme', visibility: 'public' });
      await owner.announceLocalHive('acme');

      const { status, body } = await getHives();
      expect(status).toBe(200);
      expect(body.count).toBe(1);
      expect(body.rows[0]).toMatchObject({
        potId: 'acme',
        visibility: 'public',
        memberLinks: [MEMBER_LINK],
      });
    });

    it('never lists a private hive (it never reaches the directory)', async () => {
      registerOwnedHive({ potId: 'acme', visibility: 'public' });
      registerOwnedHive({ potId: 'priv', visibility: 'private' });
      // reannounceAll broadcasts the public hive + skips the private one.
      await owner.reannounceAll();

      const { body } = await getHives();
      expect(body.rows.map((r: { potId: string }) => r.potId)).toEqual(['acme']);
      expect(body.rows.every((r: { visibility: string }) => r.visibility !== 'private')).toBe(true);
    });
  });

  describe('join-pot handoff', () => {
    it('forwards the DISCOVERED memberLinks into joinHiveAsView (discover→join)', async () => {
      registerOwnedHive({ potId: 'acme', visibility: 'public' });
      await owner.announceLocalHive('acme');

      // Drive the panel's flow: browse the directory, then Join with the row's links.
      const { body: listing } = await getHives();
      const row = listing.rows[0];
      const { status, body } = await postJoinHive({ potId: row.potId, memberLinks: row.memberLinks });

      expect(status).toBe(200);
      expect(body).toMatchObject({ ok: true });
      expect(joinHiveAsView).toHaveBeenCalledTimes(1);
      expect(joinHiveAsView.mock.calls[0][0]).toMatchObject({
        potId: 'acme',
        memberLinks: [MEMBER_LINK],
        workspaceId: 'ws-test',
      });
      expect(bustProjectsLiteCache).toHaveBeenCalledTimes(1);
    });
  });

  describe('join-invite via secret', () => {
    it('400s a malformed invite link without wiring the directory', async () => {
      const { status, body } = await postJoinInvite({ link: 'not-a-link' });
      expect(status).toBe(400);
      expect(body).toMatchObject({ code: 'invalid_link' });
      expect(ensureHiveDirectoryWired).not.toHaveBeenCalled();
    });

    it('503s when the directory cannot be wired (gh-unauthenticated)', async () => {
      ensureHiveDirectoryWired.mockResolvedValue(null);
      const link = formatHiveInviteLink({ secret: INVITE_SECRET, title: 'Inv' });
      const { status, body } = await postJoinInvite({ link });
      expect(status).toBe(503);
      expect(body).toMatchObject({ code: 'directory_unavailable' });
    });

    it('secret-gated discovery: joining the invite topic surfaces the owner’s invite hive', async () => {
      registerOwnedHive({ potId: 'inv', visibility: 'invite', inviteSecret: INVITE_SECRET, title: 'Inv' });
      // Invisible to a global browser before the invite is accepted.
      expect(joiner.listDiscoveredHives().map((h) => h.potId)).not.toContain('inv');

      // The wiring's joinInviteTopic subscribes the browser to the invite topic;
      // the owner is announcing there, so the hive becomes visible.
      const joinInviteTopic = vi.fn(async (secret: string) => {
        subscribe(joiner, hiveTopicAsHex(deriveInviteTopic(secret)));
        clock.ms += 1000;
        await owner.announceLocalHive('inv');
      });
      const confirmInviteAnnounce = vi.fn(async () => {
        const hive = joiner.listDiscoveredHives().find((h) => h.potId === 'inv');
        return hive
          ? { found: true, peersOnTopic: 1, hive: { potId: hive.potId } }
          : { found: false, peersOnTopic: 0 };
      });
      ensureHiveDirectoryWired.mockResolvedValue({ joinInviteTopic, confirmInviteAnnounce });

      const link = formatHiveInviteLink({ secret: INVITE_SECRET, pubkeyBase64: ownerPubkeyB64, title: 'Inv' });
      const { status, body } = await postJoinInvite({ link });

      expect(status).toBe(200);
      expect(body).toMatchObject({ ok: true, joined: true, found: true, subscribed: true });
      expect(joinInviteTopic).toHaveBeenCalledWith(INVITE_SECRET);
      // The secret-gated discovery actually landed the invite hive in the directory.
      expect(joiner.listDiscoveredHives().map((h) => h.potId)).toContain('inv');
    });

    it('honest no-op: subscribed but nothing announcing → joined:false / subscribed:true', async () => {
      const joinInviteTopic = vi.fn(async () => {}); // subscribe only; no announcer
      const confirmInviteAnnounce = vi.fn(async () => ({ found: false, peersOnTopic: 0 }));
      ensureHiveDirectoryWired.mockResolvedValue({ joinInviteTopic, confirmInviteAnnounce });

      const link = formatHiveInviteLink({ secret: INVITE_SECRET });
      const { status, body } = await postJoinInvite({ link });

      expect(status).toBe(200);
      expect(body).toMatchObject({ ok: true, joined: false, found: false, subscribed: true });
    });
  });
});
