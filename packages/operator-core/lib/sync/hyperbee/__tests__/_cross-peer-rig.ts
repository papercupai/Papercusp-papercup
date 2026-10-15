/**
 * _cross-peer-rig.ts — the shared rig behind the cross-peer coordination suite
 * (cross-peer-coordination.integration.test.ts and its -scale sibling).
 *
 * Two REAL peers-and-up over a local testnet DHT: identities with real Ed25519
 * announce signatures, per-peer corestores + Hyperswarm, per-peer throwaway PG
 * with the REAL presence + coord-message projections, the REAL Hive authority
 * election over each peer's OWN federated roster, and the claim/RPC plumbing.
 *
 * The scale test lives in its OWN file deliberately: a 5-peer mesh reliably
 * stalls (connection events never delivered to late-created swarms) when it
 * shares a worker process with ~9 prior swarm create/destroy cycles — a
 * test-process artifact, not a product path (the product runs ONE long-lived
 * shared swarm per process). Splitting files = fresh vitest worker = clean
 * process state.
 *
 * NOTE: test files using claimVia/startAuthorityRpcServer must mock
 * '@papercusp/db-org' to route getOrgPg() through {@link orgSqlHolder} —
 * the per-"machine" store binding (see either test file's vi.mock block).
 */
import { expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { unsafeFederatedPotScope } from '../../../federated-pot-scope';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import type Corestore from 'corestore';
import { bootHarnessSubstrate, type BootedHarnessHandle } from '../boot';
import type { HiveRekeyBootDeps } from '../hive-epoch-boot-deps';
import { stubHivePolicyReadsForTest } from './_hive-policy-read-stubs';
import type { RemoteLog } from '../peer-log';
import { type HyperswarmLike } from '../swarm';
import type { OpEnvelope } from '../op-envelope-types';
import { _resetCacheForTests, closeHarnessStore } from '../corestore';
import { _resetBootHistoryForTests } from '../boot-history';
import { applyOpVia, type ProjectionLookup, type TableProjection } from '../projection';
import { buildPresenceProjection } from '../projections/presence';
import { buildCoordMessageProjection } from '../projections/coord-message';
import { queryPresenceRowsForHive, routeToAuthorityForHive, type LockAuthorityDeps } from '../../../authority/lock-authority';
import { handleAuthorityRpc, type AuthorityRpcEnvelope } from '../../../authority/authority-op-registry';
import { __resetRemotePeersCacheForTests } from '../../../authority/remote-peers-cache';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { WORK_ITEM_CLAIM_OP_KINDS, acquireClaimLocal } from '../../../work-item-claims';
import type { AcquireResult, AcquireOpts } from '../../../work-item-claims';

export { orgSqlHolder } from './_org-sql-holder';

export const WORKSPACE_ID = 'ws-xpeer-coord';
export const HARNESS_SLUG = 'xpeer-coord';
// WI-6312: branded at the rig's declaration so every consumer certifies once. The rig owns
// this synthetic slug end-to-end — it writes and reads it — so local == federated here.
export const HIVE_SLUG = unsafeFederatedPotScope(
  'shared-hive',
  'cross-peer rig: the rig writes and reads its own synthetic hive slug',
);
export const BINDING = { kind: 'local' as const, workspace_id: WORKSPACE_ID, harness_slug: HARNESS_SLUG };

export const SHARED_PRESENCE_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.shared_presence (
    workspace_id   text DEFAULT ''::text NOT NULL,
    harness_slug   text NOT NULL,
    github_user_id bigint NOT NULL,
    machine_label  text NOT NULL,
    device_pubkey  text NOT NULL,
    intent         text,
    current_view   text,
    last_seen_at   timestamptz DEFAULT now() NOT NULL,
    runs_routines boolean,
    schema_version bigint DEFAULT 1 NOT NULL,
    pot_slug       text,
    fed_ts         bigint,
    fed_hlc        text,
    author_pubkey  text,
    active_routines text[],
    PRIMARY KEY (workspace_id, harness_slug, github_user_id, machine_label)
  )`;
// The 000-baseline coord_event_log + the migration-150 federation columns/index,
// exactly as the coord-message-federation suite stands them up.
export const COORD_EVENT_LOG_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.coord_event_log (
    id bigserial PRIMARY KEY, workspace_id text NOT NULL DEFAULT 'default', surface text NOT NULL,
    writer_key text, msg_id text NOT NULL, body jsonb NOT NULL, ts timestamptz NOT NULL DEFAULT now(),
    superseded_by_msg_id text, superseded_at timestamptz,
    harness_slug text, origin text NOT NULL DEFAULT 'local', author_pubkey text,
    fed_ts bigint, fed_hlc text);
  CREATE UNIQUE INDEX IF NOT EXISTS coord_event_log_fed_uq ON harness_shared.coord_event_log (workspace_id, msg_id)
    WHERE harness_slug IS NOT NULL AND (body->>'notify_kind') IS NULL`;
export const WORK_ITEM_CLAIMS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.work_item_claims (
    workspace_id text NOT NULL, harness_slug text NOT NULL, work_item_id text NOT NULL,
    pot_slug text, claim_id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner text NOT NULL, owner_label text, holder_pubkey text,
    intent text DEFAULT ''::text NOT NULL, ttl_sec integer DEFAULT 1800 NOT NULL,
    acquired_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    expires_ts timestamptz NOT NULL,
    last_activity_ts timestamptz DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT work_item_claims_pkey PRIMARY KEY (workspace_id, harness_slug, work_item_id))`;


// ── async resource teardown (newest-first), drained by each file's afterEach. ──
export const cleanups: Array<() => void | Promise<void>> = [];

let rigHivePolicyStubInstalled = false;
/** Hermetic merge-pass hive-policy + roster reads for the current test (WI-6554700010008561).
 *  mergeOnePass reads both through the PROCESS-GLOBAL org pool, which an integration run must
 *  never open (live :5432 — WI-10006585 refuses it, the pass fails, and fail-on-console reds the
 *  test). Installed ONCE per test at the BOTTOM of the newest-first `cleanups` stack, so it is
 *  restored only after EVERY peer has closed (a teardown can still run a pass). A file that
 *  already calls stubHivePolicyReadsForSuite() is unaffected: re-spying returns the same spy. */
export function ensureRigHivePolicyReadStub(): void {
  if (rigHivePolicyStubInstalled) return;
  rigHivePolicyStubInstalled = true;
  const restore = stubHivePolicyReadsForTest();
  cleanups.unshift(() => {
    restore();
    rigHivePolicyStubInstalled = false;
  });
}

export async function rigAfterEach(): Promise<void> {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      /* a thrown assertion must never leak a swarm/dir/db/DHT node */
    }
  }
  rigHivePolicyStubInstalled = false;
  _resetCacheForTests();
  _resetBootHistoryForTests();
  __resetRemotePeersCacheForTests();
}

export function makeWorkspaceRoot(prefix: string): string {
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
  return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64');
}

export function makeIdentity(login: string, userId: number, keychainId: string) {
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

export function makeSwarm(bootstrap: unknown): HyperswarmLike {
  const swarm = new Hyperswarm({ bootstrap }) as unknown as HyperswarmLike & { destroy(): Promise<void> };
  cleanups.push(async () => {
    try {
      await swarm.destroy();
    } catch {
      /* ignore */
    }
  });
  return swarm;
}

export async function makeTestnet() {
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

export async function pollUntil<T>(
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

/** A per-peer apply that routes federated ops through the REAL projections bound to
 *  THIS peer's `sql`: `presence` (the roster) and `coord-messages` (the
 *  wake-carrying rail) — each peer projects into its OWN throwaway PG. `extra`
 *  appends additional REAL projections (already bound to this peer's `sql`) so a
 *  caller can prove a non-presence table's crossing over the same real rig
 *  (e.g. the log-first feature_claims/queue/working-set/contributors). */
export function buildPeerApply(
  sql: postgres.Sql,
  ownLogKeyHex: string,
  extra: TableProjection<unknown>[] = [],
): (op: OpEnvelope) => Promise<boolean> {
  const projections = [
    buildPresenceProjection({ sql, workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG }) as TableProjection<unknown>,
    buildCoordMessageProjection({ sql, workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG }) as TableProjection<unknown>,
    ...extra,
  ];
  const scoped = new Map<string, TableProjection<unknown>>(projections.map((p) => [p.tableTag, p]));
  const lookup: ProjectionLookup = (tag) => scoped.get(tag) ?? null;
  return (op: OpEnvelope) => applyOpVia(lookup, op, { ownLogKeyHex });
}

export interface PresencePeer {
  handle: BootedHarnessHandle;
}

export async function bootPresencePeer(opts: {
  testnetBootstrap: unknown;
  rootPrefix: string;
  identity: ReturnType<typeof makeIdentity>;
  sql: postgres.Sql;
  /** Conclusive admission predicate over the announcing peer's userId. */
  verify: (userId: number) => 'verified' | 'pending' | 'fail';
  /** Extra REAL projections (bound to THIS peer's `sql`) to wire into the apply
   *  alongside presence + coord-messages — lets a caller prove another table's
   *  crossing over the same real rig. */
  extraProjections?: TableProjection<unknown>[];
  /** WI-3893: passthrough to `bootHarnessSubstrate` — lets a caller intercept a
   *  remote-log open (e.g. hand back a broken/non-attaching stub for the FIRST
   *  admission, then the real `openRemoteLog` on repair) to prove the WI-3684
   *  repair-on-detect path genuinely reconnects over the real wire. Omitted =
   *  the real `openRemoteLog` (today's behavior, byte-identical). */
  openRemoteLogOverride?: (store: Corestore, keyHex: string) => Promise<RemoteLog>;
  /** WI-3893: passthrough — shrinks the connected_never_replicated /
   *  no_replicator / frozen grace window so a test doesn't need minutes of
   *  real wall-clock time to observe an alarm. Omitted = the 3-minute default. */
  replicationStallGraceMs?: number;
  /** Re-key deps for this boot. Omitted = `null`: the rig federates presence /
   *  coord rows, not epoch keys, and the default-ON POT_REKEY build resolves the
   *  Hive scope through the PROCESS-GLOBAL org-admin pool, which an integration
   *  run must never open (it points at live :5432 — WI-10006585 fails it closed,
   *  so every rig consumer without its own db-org mock went red; WI-6554700010008561).
   *  A caller that genuinely exercises re-key passes its own deps here. */
  rekeyDepsOverride?: HiveRekeyBootDeps | null;
}): Promise<PresencePeer> {
  ensureRigHivePolicyReadStub();
  const root = makeWorkspaceRoot(opts.rootPrefix);
  let handle: BootedHarnessHandle | undefined;
  let apply: ((op: OpEnvelope) => Promise<boolean>) | undefined;
  handle = await bootHarnessSubstrate({
    workspaceRoot: root,
    workspaceId: WORKSPACE_ID,
    harnessSlug: HARNESS_SLUG,
    swarmBinding: BINDING,
    swarmOverride: makeSwarm(opts.testnetBootstrap),
    verifyBindingOverride: async (_pk, _login, userId) => opts.verify(userId),
    // ctx, not `handle`: a merge pass can run before bootHarnessSubstrate returns
    // (a rejoining peer already holds admitted logs) — WI-6554700010008561.
    applyOverride: (op, ctx) => {
      apply ??= buildPeerApply(opts.sql, ctx.ownLogKeyHex, opts.extraProjections ?? []);
      return apply(op);
    },
    mergePollMs: 0,
    pendingRetryMs: 0,
    reverifyIntervalMs: 0,
    loadRevokedOverride: async () => new Set(),
    announceIdentityOverride: opts.identity.override,
    rekeyDepsOverride: opts.rekeyDepsOverride === undefined ? null : opts.rekeyDepsOverride,
    ...(opts.openRemoteLogOverride ? { openRemoteLogOverride: opts.openRemoteLogOverride } : {}),
    ...(opts.replicationStallGraceMs !== undefined
      ? { replicationStallGraceMs: opts.replicationStallGraceMs }
      : {}),
  });
  cleanups.push(async () => {
    await handle?.close();
    await closeHarnessStore({ workspaceRoot: root, harnessSlug: HARNESS_SLUG });
  });
  return { handle };
}

export function presenceValue(userId: number, machine: string, pubkey: string) {
  return {
    harness_slug: HARNESS_SLUG,
    github_user_id: userId,
    machine_label: machine,
    device_pubkey: pubkey,
    intent: null,
    current_view: null,
    last_seen_at: Date.now(),
    schema_version: 1,
    hive_slug: HIVE_SLUG,
  };
}

export async function devicePubkeysFor(sql: postgres.Sql): Promise<Set<string>> {
  const rows = await sql<Array<{ device_pubkey: string }>>`
    SELECT device_pubkey FROM harness_shared.shared_presence
     WHERE harness_slug = ${HARNESS_SLUG} AND device_pubkey <> ''
  `;
  return new Set(rows.map((r) => r.device_pubkey));
}

/** Election deps that read THIS peer's federated `shared_presence` (not an injected roster).
 *  `nowFn` is injectable so the failover test can move the clock past `staleMs` without
 *  sleeping — the roster itself stays the REAL federated one. */
export function electionDeps(
  sql: postgres.Sql,
  self: { githubUserId: number; devicePubkey: string },
  nowFn: () => number = () => Date.now(),
): LockAuthorityDeps {
  return {
    now: nowFn,
    staleMs: 600_000,
    // EI-14324: every caller of this shared rig asserts a specific argmin(device_pubkey)
    // winner (idA.devicePubkey < idB.devicePubkey, etc. — see cross-peer-coordination
    // .integration.test.ts's repeated `authorityIsA = idA.devicePubkey < idB.devicePubkey`
    // pattern). Pin argmin here so HRW_RENDEZVOUS_AUTHORITY's default-ON graduation
    // (2026-07-17) can't silently swap in hash-based selection and break every one of
    // them the way it broke WI-5190.
    useHrwRendezvous: false,
    resolveSelf: async () => self,
    fetchHivePresenceRows: (potSlug: string) => queryPresenceRowsForHive(sql as never, potSlug),
  };
}

/**
 * Stand up two Swarms of one Hive, federate their presence over the real wire, and
 * return both peers' handles + DBs once each peer's `shared_presence` holds the
 * OTHER Swarm (federation complete). The shared fixture for every test below.
 */
export async function federateTwoPeerPresence(
  /** Optional builder for EXTRA real projections to wire into each peer's apply
   *  (bound to that peer's `sql`) — lets a caller prove a non-presence table's
   *  crossing over the same connected two-peer rig. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous projection list; TableProjection is invariant in Row, so <unknown> rejects concretely-typed projections.
  extraProjections?: (sql: postgres.Sql) => TableProjection<any>[],
) {
  const dbA: FreshPgDb = await createFreshPgDb('xpeerA');
  cleanups.push(() => dbA.cleanup());
  const dbB: FreshPgDb = await createFreshPgDb('xpeerB');
  cleanups.push(() => dbB.cleanup());
  await dbA.sql.unsafe(SHARED_PRESENCE_DDL);
  await dbB.sql.unsafe(SHARED_PRESENCE_DDL);
  await dbA.sql.unsafe(COORD_EVENT_LOG_DDL);
  await dbB.sql.unsafe(COORD_EVENT_LOG_DDL);

  const testnet = await makeTestnet();
  const idA = makeIdentity('alice', 42, 'kc-alice');
  const idB = makeIdentity('bob', 7, 'kc-bob');

  // Each Swarm admits the OTHER's userId (mutual admission).
  const peerB = await bootPresencePeer({
    testnetBootstrap: testnet.bootstrap,
    rootPrefix: 'xpeer-B-',
    identity: idB,
    sql: dbB.sql,
    verify: (uid) => (uid === idA.userId ? 'verified' : 'fail'),
    extraProjections: extraProjections?.(dbB.sql),
  });
  const peerA = await bootPresencePeer({
    testnetBootstrap: testnet.bootstrap,
    rootPrefix: 'xpeer-A-',
    identity: idA,
    sql: dbA.sql,
    verify: (uid) => (uid === idB.userId ? 'verified' : 'fail'),
    extraProjections: extraProjections?.(dbA.sql),
  });

  expect(peerA.handle.swarm).not.toBeNull();
  expect(peerB.handle.swarm).not.toBeNull();
  expect(peerA.handle.swarm!.topicHex).toBe(peerB.handle.swarm!.topicHex);

  // Each Swarm announces its OWN presence on its OWN peer-log.
  await peerA.handle.append({
    type: 'put',
    table: 'presence',
    hbKey: `${idA.userId}/machine-A`,
    value: presenceValue(idA.userId, 'machine-A', idA.devicePubkey),
    ts: 1000,
    schema_version: 1,
    writerPubkey: idA.devicePubkey,
  });
  await peerB.handle.append({
    type: 'put',
    table: 'presence',
    hbKey: `${idB.userId}/machine-B`,
    value: presenceValue(idB.userId, 'machine-B', idB.devicePubkey),
    ts: 1001,
    schema_version: 1,
    writerPubkey: idB.devicePubkey,
  });

  // Federation is complete when each peer's PG holds the OTHER Swarm's device.
  const federated = await pollUntil(
    async () => {
      await peerA.handle.mergeNow();
      await peerB.handle.mergeNow();
      const devsA = await devicePubkeysFor(dbA.sql);
      const devsB = await devicePubkeysFor(dbB.sql);
      return devsA.has(idB.devicePubkey) && devsB.has(idA.devicePubkey) ? { devsA, devsB } : undefined;
    },
    { timeoutMs: 25_000, intervalMs: 250 },
  );

  return { dbA, dbB, idA, idB, peerA, peerB, federated };
}

/** Spin an in-process authority RPC endpoint over `handleAuthorityRpc`, returning a
 *  handle a partition test can sever (close) and heal (relisten on a new port). */
export async function startAuthorityRpcServer(): Promise<{ addr: () => string; sever: () => Promise<void>; heal: () => Promise<void> }> {
  let server: Server | undefined;
  let port = 0;
  const listen = async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', async () => {
        const env = JSON.parse(raw) as AuthorityRpcEnvelope;
        const result = await handleAuthorityRpc(env);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    port = (server!.address() as { port: number }).port;
  };
  const sever = async () => {
    server?.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  };
  await listen();
  cleanups.push(async () => {
    if (server) await sever();
  });
  // The address keeps resolving after sever — the point: the peer is KNOWN but
  // unreachable (a partition), so the transport maps the refusal to
  // PeerUnreachableError and routing fails open per D-004.
  return { addr: () => `http://127.0.0.1:${port}`, sever, heal: listen };
}

export function claimVia(
  sql: postgres.Sql,
  self: { githubUserId: number; devicePubkey: string },
  owner: string,
  workItemId: string,
  nowFn?: () => number,
) {
  const payload: AcquireOpts = {
    workspaceId: 'default',
    harnessSlug: HARNESS_SLUG,
    workItemId,
    potSlug: HIVE_SLUG,
    owner,
    holderPubkey: self.devicePubkey,
  };
  return routeToAuthorityForHive<AcquireResult>(
    HIVE_SLUG,
    {
      local: (): Promise<AcquireResult> => acquireClaimLocal(payload),
      remote: { kind: WORK_ITEM_CLAIM_OP_KINDS.acquire, payload, decode: (raw): AcquireResult => raw as AcquireResult },
    },
    electionDeps(sql, self, nowFn),
  );
}

export interface PeerNode {
  id: ReturnType<typeof makeIdentity>;
  db: FreshPgDb;
  peer: PresencePeer;
  machine: string;
  self: { githubUserId: number; devicePubkey: string };
}

/** N Swarms of one Hive federated over the real wire — every peer's roster holds ALL
 *  N devices. The fixture for the multi-peer consistency assertions a two-peer rig
 *  cannot express. Returns nodes + the testnet bootstrap (for rejoin/scale legs). */
export async function federatePeerSet(count: number, federateTimeoutMs = 30_000) {
  const seeds = Array.from({ length: count }, (_, i) => ({
    login: `peer${i + 1}`,
    userId: 100 + i,
    kc: `kc-peer${i + 1}`,
    machine: `machine-${i + 1}`,
    ts: 1000 + i,
  }));
  const testnet = await makeTestnet();
  const nodes: PeerNode[] = [];
  for (const s of seeds) {
    const db = await createFreshPgDb(`xpeer3-${s.login}`);
    cleanups.push(() => db.cleanup());
    await db.sql.unsafe(SHARED_PRESENCE_DDL);
    const id = makeIdentity(s.login, s.userId, s.kc);
    nodes.push({ id, db, machine: s.machine, peer: undefined as never, self: { githubUserId: s.userId, devicePubkey: id.devicePubkey } });
  }
  const admitted = new Set(seeds.map((s) => s.userId));
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].peer = await bootPresencePeer({
      testnetBootstrap: testnet.bootstrap,
      rootPrefix: `xpeer3-${seeds[i].login}-`,
      identity: nodes[i].id,
      sql: nodes[i].db.sql,
      verify: (uid) => (admitted.has(uid) ? 'verified' : 'fail'),
    });
  }
  for (let i = 0; i < nodes.length; i++) {
    await nodes[i].peer.handle.append({
      type: 'put',
      table: 'presence',
      hbKey: `${seeds[i].userId}/${seeds[i].machine}`,
      value: presenceValue(seeds[i].userId, seeds[i].machine, nodes[i].id.devicePubkey),
      ts: seeds[i].ts,
      schema_version: 1,
      writerPubkey: nodes[i].id.devicePubkey,
    });
  }
  const allPubkeys = new Set(nodes.map((n) => n.id.devicePubkey));
  let lastMissing = '';
  const federated = await pollUntil(
    async () => {
      const missing: string[] = [];
      for (const n of nodes) await n.peer.handle.mergeNow();
      for (let i = 0; i < nodes.length; i++) {
        const devs = await devicePubkeysFor(nodes[i].db.sql);
        for (const m of nodes) {
          if (!devs.has(m.id.devicePubkey)) missing.push(`${seeds[i].login}⊉${seeds[nodes.indexOf(m)].login}`);
        }
      }
      lastMissing = missing.join(' ');
      return missing.length === 0 || undefined;
    },
    { timeoutMs: federateTimeoutMs, intervalMs: 250 },
  );
  return { nodes, seeds, testnet, admitted, federated, lastMissing };
}
