/**
 * presence-gossip-wiring integration (real PG + fake swarm/Protomux) — the
 * P-004/P-005 READER + WRITER bindings end-to-end
 * (cross-machine-coord-parity-and-trust-2026-07-01 P-025 residual (a)).
 *
 * Drives REAL device-signed frames through the wiring singleton's actual
 * pipeline — verify → pot_members gate → shared_presence /
 * shared_session_presence writers — over the same fake-swarm/Protomux harness
 * directory-swarm.test.ts uses (the real-wire semantics are the 2-machine
 * verify, P-025 residual (b)). Pins:
 *   • a member device's signed put frame lands in shared_presence;
 *   • a NON-member device's validly-signed frame is dropped (fail-closed);
 *   • a sessions frame lands in shared_session_presence with hive_slug pinned
 *     to the RECEIVER's binding (sender-declared hive never trusted);
 *   • a del frame removes the presence row (leave tombstone);
 *   • the writer leg broadcasts a verifiable signed frame + hello snapshot.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { startDedicatedNativePg, type DedicatedNativePg } from '@papercusp/test-config/pg';
import type { SignedPresenceFrame } from '../presence-gossip';

// ── Protomux fake (the directory-swarm.test.ts harness, trimmed) ──
interface FakeChannel {
  protocol: string;
  id: Buffer | null;
  onopen?: () => void;
  sent: unknown[];
  throwOnSend: boolean;
  inbound?: (frame: unknown) => void;
  open(): void;
  pairRemote(): void;
}
const allChannels: FakeChannel[] = [];
interface FakeMux {
  channels: FakeChannel[];
  notify: ((id: Buffer | null) => void | Promise<void>) | null;
  createChannel(spec: { protocol: string; id?: Buffer | null; onopen?: () => void; onclose?: () => void }): FakeChannel | null;
  pair(opts: { protocol: string }, notify: (id: Buffer | null) => void | Promise<void>): void;
}
function makeMux(): FakeMux {
  const mux: FakeMux = {
    channels: [],
    notify: null,
    createChannel(spec) {
      const key = `${spec.protocol}::${spec.id ? spec.id.toString('hex') : ''}`;
      if (mux.channels.find((c) => `${c.protocol}::${c.id ? c.id.toString('hex') : ''}` === key)) return null;
      const ch: FakeChannel = {
        protocol: spec.protocol,
        id: spec.id ?? null,
        onopen: spec.onopen,
        sent: [],
        throwOnSend: false,
        open() {},
        pairRemote() {
          this.onopen?.();
        },
      };
      (ch as unknown as { addMessage: (m: { onmessage?: (f: unknown) => void }) => { send: (v: unknown) => void } }).addMessage = (m) => {
        ch.inbound = m.onmessage;
        return {
          send: (v: unknown) => {
            if (ch.throwOnSend) throw new Error('simulated send failure');
            ch.sent.push(v);
          },
        };
      };
      mux.channels.push(ch);
      allChannels.push(ch);
      return ch;
    },
    pair(_o, notify) {
      mux.notify = notify;
    },
  };
  return mux;
}
vi.mock('protomux', () => ({
  default: { from: (s: { userData?: unknown }) => (s.userData ? s.userData : makeMux()) },
}));

const {
  registerPresenceGossipTopic,
  broadcastPresencePut,
  broadcastSessions,
  broadcastPresenceDel,
  invalidatePresenceGossipMemberCache,
  __setPresenceGossipWiringDeps,
  __resetPresenceGossipWiring,
} = await import('../presence-gossip-wiring');
const { buildPresencePutFrame, buildPresenceDelFrame, buildSessionsFrame, verifyPresenceFrame } =
  await import('../presence-gossip');
import type { SharedPresenceRow } from '../projections/presence';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(HERE, '../../../../../../libs/papercusp/libs/db/sql');
const stripMeta = (s: string) =>
  s.split('\n').filter((l) => !/^(begin|commit);$/i.test(l.trim()) && !l.trim().startsWith('\\')).join('\n');

const WS = 'ws_pgw';
const HELLO_WS = 'ws_pgw_hello';
const HIVE = 'hive-home';
const TOPIC = Buffer.alloc(32, 5);
const TOPIC_HEX = TOPIC.toString('hex');
const T0 = Date.now();

function makeDevice() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = (publicKey as KeyObject).export({ format: 'der', type: 'spki' }) as Buffer;
  return {
    pubB64: spki.subarray(spki.length - 32).toString('base64'),
    sign: async (bytes: Buffer) => nodeSign(null, bytes, privateKey),
  };
}
const member = makeDevice();
const member2 = makeDevice(); // a SECOND device of the same user (gh 42) — for the H2 cross-device del test
const stranger = makeDevice();

const row = (over?: Partial<SharedPresenceRow>): SharedPresenceRow => ({
  harness_slug: HIVE,
  github_user_id: 42,
  machine_label: 'laptop',
  device_pubkey: member.pubB64,
  intent: 'gossip presence e2e',
  current_view: null,
  last_seen_at: T0,
  schema_version: 1,
  hive_slug: HIVE,
  ...over,
});

async function settle(check: () => Promise<boolean>, ms = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('presence-gossip wiring (real PG, fake swarm)', () => {
  let db: FreshPgDb;
  let dedicatedPg: DedicatedNativePg | undefined;
  const priorAdminUrl = process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
  let channel: FakeChannel;
  const admittedDevices = new Map<string, number>([
    [member.pubB64, 42],
    [member2.pubB64, 42],
  ]);

  beforeAll(async () => {
    dedicatedPg = await startDedicatedNativePg({ baseDir: '/dev/shm/pcv' });
    process.env.PAPERCUSP_TEST_PG_ADMIN_URL = dedicatedPg.getConnectionUri();
    db = await createFreshPgDb('presence_gossip_wiring');
    await db.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
    // shared_presence (baseline shape + the pot_slug hive-scope key (mig 187 →
    // renamed pot_slug by the D-007 pot-rename expand/contract) + LWW guard cols)
    // with the conflict target the projection upserts on.
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.shared_presence (
        workspace_id text NOT NULL DEFAULT '',
        harness_slug text NOT NULL,
        github_user_id bigint NOT NULL,
        machine_label text NOT NULL,
        device_pubkey text NOT NULL,
        intent text,
        current_view text,
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        schema_version bigint NOT NULL DEFAULT 1,
        pot_slug text,
        fed_ts bigint,
        fed_hlc text,
        author_pubkey text,
        -- The projection's upsert writes runs_routines (the cadence-owner leg).
        -- Omitting it here made every put SILENTLY fail to land: applyPut's PG
        -- error is swallowed best-effort, so the symptom was "expected undefined
        -- to be 'gossip presence e2e'" with no hint of a schema mismatch. Keep
        -- this column list in step with projections/presence.ts's INSERT.
        runs_routines boolean,
        active_routines text[],
        PRIMARY KEY (workspace_id, harness_slug, github_user_id, machine_label));
    `);
    await db.sql.unsafe(stripMeta(readFileSync(resolve(SQL_DIR, '434-shared-session-presence.sql'), 'utf8')));
    // P-301: the fleet-membership columns the session-presence writer now sets.
    await db.sql.unsafe(
      stripMeta(readFileSync(resolve(SQL_DIR, '479-shared-session-presence-fleet-slug.sql'), 'utf8')),
    );
    // D-007 pot-rename: mig 434 creates shared_session_presence.hive_slug, but the
    // session-presence writer now sets the pot_slug column (expand added it; S3
    // drops hive_slug). Rename in-place so this hand-rolled table matches the
    // post-contract production shape a single migrated column: pot_slug.
    await db.sql.unsafe(
      `ALTER TABLE harness_shared.shared_session_presence RENAME COLUMN hive_slug TO pot_slug`,
    );

    // Fake swarm + injected deps: the member device is attested; nobody revoked.
    let handler: ((s: unknown) => void) | null = null;
    const swarm = {
      join: () => ({ refresh: () => {} }),
      leave: async () => {},
      on: (_e: string, l: (s: unknown) => void) => {
        handler = l;
      },
      off: () => {},
      connections: new Set<unknown>(),
    };
    __setPresenceGossipWiringDeps({
      getSwarm: async () => swarm as never,
      sql: db.sql,
      listHiveMembers: (async () =>
        [...new Set(admittedDevices.values())].map((githubUserId) => ({
          githubUserId,
          deviceAttestations: [...admittedDevices]
            .filter(([, owner]) => owner === githubUserId)
            .map(([device_pubkey]) => ({ device_pubkey })),
          revokedPubkeys: [],
        }))) as never,
      loadRevokedHivePubkeys: (async () => []) as never,
    });

    expect(await registerPresenceGossipTopic({ topicHex: TOPIC_HEX, workspaceId: WS, potHomeSlug: HIVE })).toBe(true);
    // A peer connects; the gossip opens + pairs the topic channel.
    const socket: { userData?: FakeMux } = {};
    swarm.connections.add(socket);
    handler!(socket);
    channel = allChannels.find((c) => c.id?.equals(TOPIC))!;
    expect(channel).toBeDefined();
    channel.pairRemote();
  }, 60_000);

  afterAll(async () => {
    try {
      await __resetPresenceGossipWiring();
    } finally {
      try {
        await db?.cleanup();
      } finally {
        try {
          await dedicatedPg?.stop();
        } finally {
          if (priorAdminUrl === undefined) delete process.env.PAPERCUSP_TEST_PG_ADMIN_URL;
          else process.env.PAPERCUSP_TEST_PG_ADMIN_URL = priorAdminUrl;
        }
      }
    }
  });

  it('pair-time hello sends a signed session snapshot over a short-lived channel', async () => {
    const helloTopic = Buffer.alloc(32, 6);
    const helloTopicHex = helloTopic.toString('hex');
    expect(
      await registerPresenceGossipTopic({
        topicHex: helloTopicHex,
        workspaceId: HELLO_WS,
        potHomeSlug: HIVE,
        writer: {
          devicePubkey: member.pubB64,
          sign: member.sign,
          githubUserId: 42,
          machineLabel: 'hello-laptop',
          potSlug: HIVE,
          getOwnRow: async () => row({ machine_label: 'hello-laptop' }),
          getOwnSessions: async () => [
            {
              owner_id: 'su-pair-hello',
              kind: 'su',
              intent: 'pair hello',
              plan_slug: null,
              harness_slug: HIVE,
              last_active_ms: T0,
            },
          ],
        },
      }),
    ).toBe(true);
    const helloChannel = allChannels.find((candidate) => candidate.id?.equals(helloTopic));
    expect(helloChannel).toBeDefined();
    helloChannel!.pairRemote();
    await settle(async () => Promise.resolve(helloChannel!.sent.length >= 2));
    const helloFrames = helloChannel!.sent.slice(0, 2) as SignedPresenceFrame[];
    expect(helloFrames.map((frame) => frame.kind)).toEqual(['put', 'sessions']);
    expect(helloFrames.every((frame) => verifyPresenceFrame(frame, { nowMs: Date.now() }))).toBe(true);

    helloChannel!.inbound!(helloFrames[1]);
    await settle(async () =>
      (await db.sql`SELECT 1 FROM harness_shared.shared_session_presence WHERE workspace_id=${HELLO_WS} AND owner_id='su-pair-hello'`).length === 1,
    );
    const sessions = await db.sql<{ owner_id: string; pot_slug: string }[]>`
      SELECT owner_id, pot_slug FROM harness_shared.shared_session_presence WHERE workspace_id=${HELLO_WS} AND owner_id='su-pair-hello'`;
    expect(sessions).toEqual([{ owner_id: 'su-pair-hello', pot_slug: HIVE }]);
  });

  it('a member device\'s signed put frame lands in shared_presence', async () => {
    channel.inbound!(await buildPresencePutFrame(row(), T0, member.sign));
    await settle(async () =>
      (await db.sql`SELECT 1 FROM harness_shared.shared_presence WHERE workspace_id=${WS} AND github_user_id=42`).length > 0,
    );
    const rows = await db.sql<{ intent: string; origin?: string }[]>`
      SELECT intent FROM harness_shared.shared_presence WHERE workspace_id=${WS} AND github_user_id=42`;
    expect(rows[0]?.intent).toBe('gossip presence e2e');
  });

  it('L9: a put frame\'s hive_slug is PINNED to the receiver binding (spoofed sender hive ignored)', async () => {
    // The put path previously trusted the sender-declared row.hive_slug; an admitted
    // member could plant a presence row under a FOREIGN hive scope (which the per-hive
    // lock authority scopes by). applyPut now pins hive_slug to binding.potHomeSlug,
    // exactly as the sessions path already does.
    // gh 42 = the member's ATTESTED id (H3 requires it); a distinct machine_label
    // so this is its own row. The spoofed hive_slug must still be pinned to HIVE.
    channel.inbound!(
      await buildPresencePutFrame(
        row({ github_user_id: 42, machine_label: 'desktop', hive_slug: 'evil-foreign-hive' }),
        T0,
        member.sign,
      ),
    );
    await settle(async () =>
      (await db.sql`SELECT 1 FROM harness_shared.shared_presence WHERE workspace_id=${WS} AND machine_label='desktop'`).length > 0,
    );
    const [pinned] = await db.sql<{ pot_slug: string }[]>`
      SELECT pot_slug FROM harness_shared.shared_presence WHERE workspace_id=${WS} AND machine_label='desktop'`;
    expect(pinned.pot_slug).toBe(HIVE); // never 'evil-foreign-hive'
  });

  it('a NON-member device\'s validly-signed frame is dropped — and SAYS SO (fail-closed member gate)', async () => {
    // EI-18769392276881557: the drop must also be VISIBLE. A silent fail-closed
    // gate is what made WI-559 unreadable — a node rejecting every inbound frame
    // looked exactly like a node nobody was sending to. The warning is asserted
    // here (rather than silenced) because new console output IS a behavior change.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      channel.inbound!(
        await buildPresencePutFrame(
          row({ device_pubkey: stranger.pubB64, github_user_id: 666, machine_label: 'evil' }),
          T0,
          stranger.sign,
        ),
      );
      await new Promise((r) => setTimeout(r, 300));
      expect(
        await db.sql`SELECT 1 FROM harness_shared.shared_presence WHERE workspace_id=${WS} AND github_user_id=666`,
      ).toHaveLength(0);

      const line = warn.mock.calls.map((c) => String(c[0])).find((m) => m.includes('REJECTED'));
      expect(line, 'the fail-closed drop must be reported, not silent').toBeDefined();
      // The admitted-set size is what distinguishes "the gate is defending itself"
      // from "this node can admit NOBODY" (the WI-559 misconfiguration).
      expect(line).toContain('2 admitted device(s) known');
      expect(line).toContain('not an attested device');
    } finally {
      warn.mockRestore();
    }
  });

  it('a pot_members change invalidation admits the next frame immediately instead of waiting for the 30s TTL', async () => {
    // The prior test populated the cache while `stranger` was absent. Model the
    // pot_members projection applying a new attestation, then fire the same
    // invalidation hook production uses. Without the hook this frame is still
    // rejected from the stale two-device cache until MEMBER_CACHE_TTL_MS.
    admittedDevices.set(stranger.pubB64, 666);
    expect(invalidatePresenceGossipMemberCache(WS, HIVE)).toBe(1);

    channel.inbound!(
      await buildPresencePutFrame(
        row({ device_pubkey: stranger.pubB64, github_user_id: 666, machine_label: 'new-member' }),
        T0 + 25,
        stranger.sign,
      ),
    );
    await settle(async () =>
      (
        await db.sql`SELECT 1 FROM harness_shared.shared_presence WHERE workspace_id=${WS} AND github_user_id=666 AND machine_label='new-member'`
      ).length > 0,
    );
    expect(
      await db.sql`SELECT 1 FROM harness_shared.shared_presence WHERE workspace_id=${WS} AND github_user_id=666 AND machine_label='new-member'`,
    ).toHaveLength(1);
  });

  it('H3: a put frame whose github_user_id ≠ the signer device\'s ATTESTED id is dropped (real membership gate, not just fail-closed-on-stranger)', async () => {
    // member is a REAL admitted device (attested as gh 42 in listHiveMembers),
    // unlike the stranger test above — this proves the wiring's identity check
    // is per-DEVICE-ATTESTED-id, not merely "is this device_pubkey a member".
    channel.inbound!(
      await buildPresencePutFrame(
        row({ github_user_id: 999, machine_label: 'imposter' }),
        T0 + 50,
        member.sign,
      ),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(
      await db.sql`SELECT 1 FROM harness_shared.shared_presence WHERE workspace_id=${WS} AND machine_label='imposter'`,
    ).toHaveLength(0);
  });

  it('H1: a sessions frame whose github_user_id ≠ the signer device\'s ATTESTED id is dropped (real membership gate, no foreign-user session announce)', async () => {
    // Same admitted device (member, attested gh 42) now tries to announce a
    // sessions batch UNDER a foreign gh 999 — incl. a spoofed victim owner_id.
    // The real wiring must drop the whole frame, not just re-scope it.
    channel.inbound!(
      await buildSessionsFrame(
        { devicePubkey: member.pubB64, githubUserId: 999, machineLabel: 'laptop', potSlug: HIVE },
        [
          { owner_id: 'mug', kind: 'su', intent: null, plan_slug: null, harness_slug: HIVE, last_active_ms: T0 },
          { owner_id: 'su-victim-uuid', kind: 'su', intent: null, plan_slug: null, harness_slug: HIVE, last_active_ms: T0 },
        ],
        T0 + 500,
        member.sign,
      ),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(
      await db.sql`SELECT 1 FROM harness_shared.shared_session_presence WHERE workspace_id=${WS} AND owner_id IN ('mug', 'su-victim-uuid')`,
    ).toHaveLength(0);
  });

  it('a sessions frame lands with hive_slug PINNED to the receiver binding (sender hive ignored)', async () => {
    channel.inbound!(
      await buildSessionsFrame(
        { devicePubkey: member.pubB64, githubUserId: 42, machineLabel: 'laptop', potSlug: 'evil-foreign-hive' },
        [
          { owner_id: 'su-remote-1', kind: 'su', intent: 'x', plan_slug: null, harness_slug: HIVE, last_active_ms: T0 },
          { owner_id: 's-bee-9', kind: 'cup', intent: null, plan_slug: 'p', harness_slug: HIVE, last_active_ms: T0 },
        ],
        T0 + 1000,
        member.sign,
      ),
    );
    await settle(async () =>
      (await db.sql`SELECT 1 FROM harness_shared.shared_session_presence WHERE workspace_id=${WS}`).length >= 2,
    );
    const rows = await db.sql<{ owner_id: string; pot_slug: string }[]>`
      SELECT owner_id, pot_slug FROM harness_shared.shared_session_presence WHERE workspace_id=${WS} ORDER BY owner_id`;
    expect(rows.map((r) => r.owner_id)).toEqual(['s-bee-9', 'su-remote-1']);
    expect(rows.every((r) => r.pot_slug === HIVE)).toBe(true); // never 'evil-foreign-hive'
  });

  it('H2: a member device CANNOT evict another device\'s presence row (cross-device del is device-scoped)', async () => {
    // Device A (member) owns a row; device B (member2, same user gh 42, also
    // admitted) signs a del targeting A's (gh 42, laptop) row. Even though B is a
    // valid member and the del is validly self-signed + user-matched, the delete is
    // scoped to B's OWN device_pubkey — so A's row (owned by device A) SURVIVES.
    channel.inbound!(await buildPresencePutFrame(row({ machine_label: 'laptop' }), T0 + 100, member.sign));
    await settle(async () =>
      (await db.sql`SELECT 1 FROM harness_shared.shared_presence WHERE workspace_id=${WS} AND github_user_id=42 AND machine_label='laptop'`).length > 0,
    );
    channel.inbound!(
      await buildPresenceDelFrame(
        member2.pubB64, // device B signs a del for device A's row
        { github_user_id: 42, machine_label: 'laptop', harness_slug: HIVE },
        T0 + 200,
        member2.sign,
      ),
    );
    await new Promise((r) => setTimeout(r, 300));
    // A's row is untouched — B's del could not reach a row it does not own.
    expect(
      await db.sql`SELECT device_pubkey FROM harness_shared.shared_presence WHERE workspace_id=${WS} AND github_user_id=42 AND machine_label='laptop'`,
    ).toHaveLength(1);
  });

  it('a del frame removes the presence row (leave tombstone)', async () => {
    channel.inbound!(
      await buildPresenceDelFrame(
        member.pubB64,
        { github_user_id: 42, machine_label: 'laptop', harness_slug: HIVE },
        T0 + 2000,
        member.sign,
      ),
    );
    // Scoped to the 'laptop' row: the L9-pin test above left a distinct (gh 42,
    // 'desktop') row that this del does not target — so the del removing ONLY
    // (gh 42, laptop) is itself the correct, machine-scoped behavior.
    await settle(async () =>
      (await db.sql`SELECT 1 FROM harness_shared.shared_presence WHERE workspace_id=${WS} AND github_user_id=42 AND machine_label='laptop'`).length === 0,
    );
    expect(
      await db.sql`SELECT 1 FROM harness_shared.shared_presence WHERE workspace_id=${WS} AND github_user_id=42 AND machine_label='laptop'`,
    ).toHaveLength(0);
  });

  it('writer helpers report actual channel send outcomes; hello serves the current row', async () => {
    expect(
      await registerPresenceGossipTopic({
        topicHex: TOPIC_HEX,
        workspaceId: WS,
        potHomeSlug: HIVE,
        writer: {
          devicePubkey: member.pubB64,
          sign: member.sign,
          githubUserId: 42,
          machineLabel: 'laptop',
          potSlug: HIVE,
          getOwnRow: async () => row({ intent: 'writer beat' }),
          getOwnSessions: async () => [],
        },
      }),
    ).toBe(true);
    const before = channel.sent.length;
    expect(await broadcastPresencePut(TOPIC_HEX, row({ intent: 'writer beat' }))).toBe(true);
    expect(await broadcastSessions(TOPIC_HEX, [])).toBe(true);
    expect(
      await broadcastPresenceDel(TOPIC_HEX, {
        github_user_id: 42,
        machine_label: 'laptop',
        harness_slug: HIVE,
      }),
    ).toBe(true);
    expect(channel.sent.length).toBe(before + 3);
    const frame = channel.sent[before] as never;
    expect(verifyPresenceFrame(frame, { nowMs: Date.now() })).toBe(true);

    channel.throwOnSend = true;
    expect(await broadcastPresencePut(TOPIC_HEX, row({ intent: 'missed writer beat' }))).toBe(false);
    expect(await broadcastSessions(TOPIC_HEX, [])).toBe(false);
    expect(
      await broadcastPresenceDel(TOPIC_HEX, {
        github_user_id: 42,
        machine_label: 'laptop',
        harness_slug: HIVE,
      }),
    ).toBe(false);
  });
});
