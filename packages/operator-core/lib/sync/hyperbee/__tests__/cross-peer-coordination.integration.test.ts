/**
 * cross-peer-coordination.integration.test.ts — the cross-peer COORDINATION test
 * that closes the gap the authority/claim suites left open.
 *
 * `work-item-claims-two-instance` and `two-instance-hive-authority` prove authority
 * routing + claim/lock serialization, but they INJECT the Hive presence roster (a
 * fixed `fetchHivePresenceRows` array — see their own "Presence is INJECTED" notes).
 * So nothing proved that the roster the authority election runs over actually
 * FEDERATES across peers. This wires the REAL pieces end-to-end over the SAME
 * two-peer testnet-DHT harness the federation suite uses:
 *
 *   1. Two Swarms (alice/bob) each ANNOUNCE their own presence as a `table:'presence'`
 *      op on their OWN peer-log; the REAL `buildPresenceProjection` writes it to each
 *      peer's OWN throwaway `shared_presence` PG.
 *   2. Over the real Hyperswarm wire each Swarm's presence FEDERATES to the other —
 *      so each peer's `shared_presence` ends up holding the OTHER Swarm (mutual
 *      presence federation; the assertion the injected-roster tests can't make).
 *   3. The REAL Hive authority election (`lockAuthorityForHive` over the production
 *      `queryPresenceRowsForHive`) run on EACH peer's FEDERATED roster elects the
 *      SAME Swarm (argmin device_pubkey) — no split-brain.
 *   4. Both Swarms then contend for one work-item, routing the claim to that
 *      federated-presence-elected authority over the real `HttpPeerRpcTransport` →
 *      the authority's single real store grants EXACTLY ONE (cross-peer exactly-once).
 *   5. FAILOVER: the elected authority Swarm departs; its federated presence row
 *      ages past `staleMs` while the survivor keeps heartbeating → the survivor's
 *      election over its OWN federated roster names ITSELF (failover by definition,
 *      D-005 — no election round-trip), and a new claim grants locally.
 *   6. PARTITION (D-004): the authority stays in the fresh roster but its RPC leg is
 *      unreachable → the non-authority Swarm FAILS OPEN (local-advisory grant in its
 *      OWN store, loud warning), the documented optimistic split-brain window is
 *      real (both stores can hold the same item until git-merge), and on heal the
 *      claim path routes `remote-authority` again.
 *   7. THREE-PEER failover consistency + rejoin: with three Swarms federated, the
 *      authority departs → BOTH survivors independently elect the SAME successor
 *      (post-failover no-split-brain — inexpressible in a two-peer rig), a contended
 *      claim between the survivors grants exactly one, and when the departed Swarm
 *      REJOINS (fresh boot, same identity) all three re-converge on the original
 *      argmin authority.
 *   8. LEASE LIFECYCLE across peers: acquire (remote) → contention refused → release
 *      (remote) → the other Swarm re-acquires — the full claim lease serializes at
 *      the federated-elected authority over the real RPC wire.
 *   9. FILE-LOCK routing over the federated roster: the production `routeFileLockOp`
 *      (the locks:acquire/release cutover seam) resolves its Hive scope and routes
 *      lock.acquire/release to the federated-presence-elected authority over the real
 *      RPC wire — grant, cross-wire busy contention (holder faithfully named), and
 *      cross-wire release. STOOD-IN here: the lock store behind the coordinator (the
 *      real-PG store leg is file-lock-authority-e2e's proof).
 *  10. WAKE DELIVERY over the real wire: a coord-message op with `body.wake` appended
 *      on A federates over the actual Hyperswarm wire; B's REAL coord-message
 *      projection applies it origin='remote' and fires the deliver-and-wake fan
 *      EXACTLY ONCE (A's own local apply never fans) — the end-to-end the
 *      coord-message-federation suite chains by hand.
 *  11. SCALE (in cross-peer-coordination-scale.integration.test.ts — own file for a
 *      fresh worker process; see _cross-peer-rig.ts for why): a FIVE-Swarm cascade —
 *      every departure unanimously re-elects, claims serialize at every epoch.
 *
 * Proof boundary: REAL corestores/logs, REAL Hyperswarm/Noise over a local testnet
 * DHT, REAL announce signature verification, REAL presence projection → PG, REAL
 * `lockAuthorityForHive` election, REAL claim store + RPC. STOOD-IN (offline-
 * deterministic, exactly as every sibling): the channel-2 GitHub-binding fetch
 * (`verifyBindingOverride`).
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type postgres from 'postgres';
import {
  WORKSPACE_ID,
  HARNESS_SLUG,
  HIVE_SLUG,
  WORK_ITEM_CLAIMS_DDL,
  cleanups,
  rigAfterEach,
  orgSqlHolder,
  pollUntil,
  presenceValue,
  electionDeps,
  bootPresencePeer,
  federateTwoPeerPresence,
  federatePeerSet,
  startAuthorityRpcServer,
  claimVia,
} from './_cross-peer-rig';
import { stubHivePolicyReadsForSuite } from './_hive-policy-read-stubs';
import {
  lockAuthorityForHive,
  queryPresenceRowsForHive,
  routeToAuthorityForHive,
} from '../../../authority/lock-authority';
import { setPeerRpcTransport, __resetPeerRpcTransportForTests } from '../../../authority/peer-rpc-transport';
import { HttpPeerRpcTransport } from '../../../authority/http-peer-rpc-transport';
import {
  handleAuthorityRpc,
  __resetAuthorityOpsForTests,
  type AuthorityRpcEnvelope,
} from '../../../authority/authority-op-registry';
import { registerWorkItemClaimAuthorityOps } from '../../../work-item-claim-authority-ops';
import { WORK_ITEM_CLAIM_OP_KINDS, getClaim, acquireClaimLocal, releaseClaimLocal } from '../../../work-item-claims';
import type { AcquireResult, AcquireOpts, ReleaseClaimParams } from '../../../work-item-claims';
import { routeFileLockOp, type FileLockRoutingDeps } from '../../../authority/file-lock-routing';
import {
  registerFileLockAuthorityOps,
  FILE_LOCK_OP_KINDS,
  type FileLockAcquireParams,
  type FileLockAcquireResult,
  type FileLockCoordinator,
  type FileLockReleaseParams,
} from '../../../authority/file-lock-authority-ops';
import { type CoordMessageRow } from '../projections/coord-message';

// EI-279: the coord-message projection's deliver-and-wake fan dynamically imports
// wakeRecipients — mock it so the real-wire wake test asserts the fan contract
// without the real await-event pump (same stand-in as coord-message-federation).
vi.mock('../../../agent-tools/coordination/inbox-wake', () => ({
  wakeRecipients: vi.fn(async (recipients: readonly string[]) => ({
    targets: [...recipients],
    keys: [],
    woken: 1,
    staged: 0,
  })),
}));
import { wakeRecipients } from '../../../agent-tools/coordination/inbox-wake';

// getOrgPg → the AUTHORITY's PG (the claim store's single serialization point),
// routed through the rig's holder so it can be rebound per test ("per machine").
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  const { orgSqlHolder } = await import('./_org-sql-holder');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: orgSqlHolder.sql }) };
});

// papercusp-hive-rekey defaults ON (P-011 inversion), so buildHiveRekeyBootDeps
// runs in EVERY substrate boot and calls getHiveBySlug via getOrgPg — which the
// rig's orgSqlHolder doesn't satisfy during bootPresencePeer (each peer's throwaway
// DB has no harness_shared.hives table), throwing "undefined reading unsafe" and
// ABORTING the boot. This suite proves presence/coord/authority FEDERATION, not
// rekey, so force POT_REKEY OFF → buildHiveRekeyBootDeps early-returns null → no
// getHiveBySlug → boot succeeds. (Other boot flags keep their real resolution;
// boot.ts reads them with .catch(()=>false), so delegation is safe.)
vi.mock('@papercusp/flags/server', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/flags/server')>('@papercusp/flags/server');
  return {
    ...actual,
    getFlag: async (key: unknown, scope?: unknown) =>
      key === 'papercusp-hive-rekey'
        ? false
        : (actual.getFlag as (k: unknown, s?: unknown) => Promise<boolean>)(key, scope),
  };
});

// Registered BEFORE the file's own hooks so the stub outlives substrate teardown,
// which can still run a merge pass (WI-6554700010008561 / WI-10007530).
stubHivePolicyReadsForSuite();
afterEach(rigAfterEach);

describe('cross-peer coordination on a shared Hive — presence federation → authority election', () => {
  it(
    'each Swarm announces presence and it FEDERATES to the other peer (both rosters hold both Swarms)',
    async () => {
      const { idA, idB, federated } = await federateTwoPeerPresence();
      expect(federated, "presence did not federate between the two peers within the window").toBeTruthy();
      // B's roster received A's presence over the real wire (and A's received B's).
      expect(federated!.devsB.has(idA.devicePubkey), "A's presence never federated to peer B").toBe(true);
      expect(federated!.devsA.has(idB.devicePubkey), "B's presence never federated to peer A").toBe(true);
    },
    40_000,
  );

  it(
    'the federated roster drives a CONSISTENT Hive authority election on both peers (no split-brain)',
    async () => {
      const { dbA, dbB, idA, idB, federated } = await federateTwoPeerPresence();
      expect(federated).toBeTruthy();

      // Each peer runs the REAL election over ITS OWN federated shared_presence.
      const authA = await lockAuthorityForHive(HIVE_SLUG, electionDeps(dbA.sql, { githubUserId: idA.userId, devicePubkey: idA.devicePubkey }));
      const authB = await lockAuthorityForHive(HIVE_SLUG, electionDeps(dbB.sql, { githubUserId: idB.userId, devicePubkey: idB.devicePubkey }));

      // Deterministic argmin(device_pubkey) — both peers must name the SAME authority.
      const expectedAuthority = idA.devicePubkey < idB.devicePubkey ? idA.devicePubkey : idB.devicePubkey;
      const authoritySeenByA = authA.isSelf ? idA.devicePubkey : authA.peer!.devicePubkey;
      const authoritySeenByB = authB.isSelf ? idB.devicePubkey : authB.peer!.devicePubkey;

      expect(authoritySeenByA).toBe(expectedAuthority);
      expect(authoritySeenByB).toBe(expectedAuthority);
      // Exactly ONE peer considers itself the authority — the other routes to it.
      expect([authA.isSelf, authB.isSelf].filter(Boolean)).toHaveLength(1);
      // Both saw a 2-Swarm live roster (real federation, not a lone self).
      expect(authA.liveCount).toBe(2);
      expect(authB.liveCount).toBe(2);
    },
    40_000,
  );
});

describe('cross-peer coordination on a shared Hive — claim arbitration over the federated-elected authority', () => {
  it(
    'both Swarms contend for one work-item → the federated-presence-elected authority grants EXACTLY ONE',
    async () => {
      const { dbA, dbB, idA, idB, federated } = await federateTwoPeerPresence();
      expect(federated).toBeTruthy();

      // The authority is argmin(device_pubkey) over the FEDERATED roster — host its
      // single claim store + the RPC endpoint on that peer's DB.
      const authorityIsA = idA.devicePubkey < idB.devicePubkey;
      const authorityDb = authorityIsA ? dbA : dbB;
      await authorityDb.sql.unsafe(WORK_ITEM_CLAIMS_DDL);
      orgSqlHolder.sql = authorityDb.sql; // getOrgPg() → the authority's store (what acquireClaimLocal serializes)

      __resetAuthorityOpsForTests();
      registerWorkItemClaimAuthorityOps();
      const server: Server = createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', async () => {
          const env = JSON.parse(raw) as AuthorityRpcEnvelope;
          const result = await handleAuthorityRpc(env);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(result));
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const port = (server.address() as { port: number }).port;
      setPeerRpcTransport(new HttpPeerRpcTransport({ resolveAddress: () => `http://127.0.0.1:${port}` }));
      cleanups.push(() => {
        server.close();
        __resetPeerRpcTransportForTests();
        __resetAuthorityOpsForTests();
      });

      const claim = (sql: postgres.Sql, self: { githubUserId: number; devicePubkey: string }, owner: string) => {
        const payload: AcquireOpts = {
          workspaceId: 'default',
          harnessSlug: HARNESS_SLUG,
          workItemId: 'F-XPEER-1',
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
          electionDeps(sql, self),
        );
      };

      const selfA = { githubUserId: idA.userId, devicePubkey: idA.devicePubkey };
      const selfB = { githubUserId: idB.userId, devicePubkey: idB.devicePubkey };
      // Both Swarms claim the SAME item concurrently — routed to the one authority.
      const [rA, rB] = await Promise.all([claim(dbA.sql, selfA, 'alice'), claim(dbB.sql, selfB, 'bob')]);

      // Exactly ONE Swarm wins the contended item (cross-peer exactly-once).
      const winners = [rA, rB].filter((r) => r.value.ok);
      expect(winners, 'exactly one Swarm must win the contended work-item').toHaveLength(1);
      // The authority's single store records exactly that winner.
      const winningOwner = rA.value.ok ? 'alice' : 'bob';
      const held = await getClaim('default', HARNESS_SLUG, 'F-XPEER-1');
      expect(held?.owner).toBe(winningOwner);
      // The authority Swarm ran locally; the other reached it over the real RPC wire.
      const authorityResult = authorityIsA ? rA : rB;
      const clientResult = authorityIsA ? rB : rA;
      expect(authorityResult.via).toBe('local-authority');
      expect(clientResult.via).toBe('remote-authority');
    },
    45_000,
  );
});

describe('cross-peer coordination on a shared Hive — authority departure (failover by staleness, D-005)', () => {
  it(
    'the elected authority Swarm departs → its federated presence ages out and the SURVIVOR elects itself; a new claim grants locally',
    async () => {
      const { dbA, dbB, idA, idB, peerA, peerB, federated } = await federateTwoPeerPresence();
      expect(federated).toBeTruthy();

      const authorityIsA = idA.devicePubkey < idB.devicePubkey;
      const departed = authorityIsA ? { peer: peerA, id: idA } : { peer: peerB, id: idB };
      const survivor = authorityIsA
        ? { peer: peerB, id: idB, db: dbB, machine: 'machine-B' as const }
        : { peer: peerA, id: idA, db: dbA, machine: 'machine-A' as const };

      // The authority Swarm genuinely goes away (stops announcing + merging).
      await departed.peer.handle.close();

      // HYSTERESIS: socket death alone does NOT depose the authority — within the
      // staleness window the survivor still names the departed Swarm (this is the
      // designed anti-flap window, not a bug).
      const selfSurvivor = { githubUserId: survivor.id.userId, devicePubkey: survivor.id.devicePubkey };
      const preStale = await lockAuthorityForHive(HIVE_SLUG, electionDeps(survivor.db.sql, selfSurvivor));
      expect(preStale.isSelf).toBe(false);
      expect(preStale.peer?.devicePubkey).toBe(departed.id.devicePubkey);

      // The survivor keeps heartbeating: re-announce its presence at VIRTUAL_NOW
      // (a fresh last_seen_at on its own peer-log → its own projected roster). The
      // departed Swarm's row keeps its old last_seen_at and ages out.
      const VIRTUAL_NOW = Date.now() + 601_000;
      await survivor.peer.handle.append({
        type: 'put',
        table: 'presence',
        hbKey: `${survivor.id.userId}/${survivor.machine}`,
        value: { ...presenceValue(survivor.id.userId, survivor.machine, survivor.id.devicePubkey), last_seen_at: VIRTUAL_NOW },
        ts: 2000,
        schema_version: 1,
        writerPubkey: survivor.id.devicePubkey,
      });
      const heartbeatLanded = await pollUntil(
        async () => {
          await survivor.peer.handle.mergeNow();
          const rows = await queryPresenceRowsForHive(survivor.db.sql as never, HIVE_SLUG);
          return rows.some((r) => r.device_pubkey === survivor.id.devicePubkey && r.last_seen_ms >= VIRTUAL_NOW) || undefined;
        },
        { timeoutMs: 15_000, intervalMs: 200 },
      );
      expect(heartbeatLanded, "the survivor's fresh heartbeat never landed in its own roster").toBeTruthy();

      // FAILOVER BY DEFINITION (D-005): at VIRTUAL_NOW the departed Swarm's row is
      // past staleMs; the survivor — over the SAME federated roster — now IS the
      // authority, with the dead Swarm out of the live set. No election round-trip.
      const postStale = await lockAuthorityForHive(HIVE_SLUG, electionDeps(survivor.db.sql, selfSurvivor, () => VIRTUAL_NOW + 1));
      expect(postStale.isSelf, 'the survivor must elect ITSELF once the departed authority is stale').toBe(true);
      expect(postStale.liveCount).toBe(1);

      // Claims continue: the survivor hosts the claim store and grants locally.
      await survivor.db.sql.unsafe(WORK_ITEM_CLAIMS_DDL);
      orgSqlHolder.sql = survivor.db.sql;
      __resetAuthorityOpsForTests();
      registerWorkItemClaimAuthorityOps();
      cleanups.push(() => __resetAuthorityOpsForTests());

      const r = await claimVia(survivor.db.sql, selfSurvivor, 'survivor', 'F-XPEER-FAILOVER-1', () => VIRTUAL_NOW + 1);
      expect(r.via).toBe('local-authority');
      expect(r.value.ok).toBe(true);
      const held = await getClaim('default', HARNESS_SLUG, 'F-XPEER-FAILOVER-1');
      expect(held?.owner).toBe('survivor');
    },
    60_000,
  );
});

describe('cross-peer coordination on a shared Hive — partition fail-open + heal (D-004)', () => {
  it(
    'a partitioned non-authority Swarm FAILS OPEN (loud warning, local-advisory grant in its OWN store); on heal it routes remote again',
    async () => {
      const { dbA, dbB, idA, idB, federated } = await federateTwoPeerPresence();
      expect(federated).toBeTruthy();

      const authorityIsA = idA.devicePubkey < idB.devicePubkey;
      const authority = authorityIsA ? { id: idA, db: dbA, owner: 'authority-swarm' } : { id: idB, db: dbB, owner: 'authority-swarm' };
      const client = authorityIsA ? { id: idB, db: dbB, owner: 'client-swarm' } : { id: idA, db: dbA, owner: 'client-swarm' };
      const selfClient = { githubUserId: client.id.userId, devicePubkey: client.id.devicePubkey };
      const selfAuthority = { githubUserId: authority.id.userId, devicePubkey: authority.id.devicePubkey };

      // Per-machine stores, like real embedded-pg: each Swarm has its OWN claim table.
      await authority.db.sql.unsafe(WORK_ITEM_CLAIMS_DDL);
      await client.db.sql.unsafe(WORK_ITEM_CLAIMS_DDL);

      __resetAuthorityOpsForTests();
      registerWorkItemClaimAuthorityOps();
      const rpc = await startAuthorityRpcServer();
      setPeerRpcTransport(new HttpPeerRpcTransport({ resolveAddress: () => rpc.addr() }));
      cleanups.push(() => {
        __resetPeerRpcTransportForTests();
        __resetAuthorityOpsForTests();
      });

      // Pre-partition sanity: the wire works — the client's claim lands at the
      // authority over RPC. (getOrgPg → h.sql models each machine's OWN embedded
      // store; the RPC handler runs in the authority's "machine", so bind it there.)
      orgSqlHolder.sql = authority.db.sql;
      const r0 = await claimVia(client.db.sql, selfClient, client.owner, 'F-XPEER-PART-0');
      expect(r0.via).toBe('remote-authority');
      expect(r0.value.ok).toBe(true);

      // ── PARTITION: presence stays FRESH (the authority is still in the client's
      // federated roster — this is a network split, not a departure), but the RPC
      // leg is severed.
      await rpc.sever();

      orgSqlHolder.sql = client.db.sql; // the claimant's own machine-local store
      const r1 = await claimVia(client.db.sql, selfClient, client.owner, 'F-XPEER-PART-1');
      // D-004: fail open, loudly — never block on an unreachable peer.
      expect(r1.via).toBe('fail-open');
      expect(r1.value.ok).toBe(true);
      expect(r1.warning, 'fail-open must surface a loud warning').toMatch(/unreachable/);
      const clientHeld = await getClaim('default', HARNESS_SLUG, 'F-XPEER-PART-1');
      expect(clientHeld?.owner).toBe(client.owner);

      // The documented optimistic window IS real: during the split the authority can
      // grant the SAME item in its own store — two grants exist until git-merge
      // reconciles. Asserted deliberately: this is the D-004 trade, not a bug.
      orgSqlHolder.sql = authority.db.sql;
      const r2 = await claimVia(authority.db.sql, selfAuthority, authority.owner, 'F-XPEER-PART-1');
      expect(r2.via).toBe('local-authority');
      expect(r2.value.ok).toBe(true);
      const authorityHeld = await getClaim('default', HARNESS_SLUG, 'F-XPEER-PART-1');
      expect(authorityHeld?.owner).toBe(authority.owner);
      expect(clientHeld?.owner).not.toBe(authorityHeld?.owner);

      // ── HEAL: the RPC leg returns → the client's next claim routes to the
      // authority again (serialized at one point; no lingering fail-open).
      await rpc.heal();
      const r3 = await claimVia(client.db.sql, selfClient, client.owner, 'F-XPEER-PART-2');
      expect(r3.via).toBe('remote-authority');
      expect(r3.value.ok).toBe(true);
      const healedHeld = await getClaim('default', HARNESS_SLUG, 'F-XPEER-PART-2');
      expect(healedHeld?.owner).toBe(client.owner);
    },
    60_000,
  );
});


describe('cross-peer coordination on a shared Hive — THREE-peer failover consistency + rejoin (D-005)', () => {
  it(
    'authority departs → BOTH survivors elect the SAME successor (no split-brain), a contended claim grants exactly one; the departed Swarm rejoins → all three reconverge',
    async () => {
      const trio = await federatePeerSet(3);
      expect(trio.federated, `three-way presence federation did not complete — missing: ${trio.lastMissing}`).toBeTruthy();

      const sorted = [...trio.nodes].sort((a, b) => (a.id.devicePubkey < b.id.devicePubkey ? -1 : 1));
      const [orig, successor, third] = sorted;
      const survivors = [successor, third];

      // Stage 1 — fully connected: all THREE rosters elect the same argmin authority.
      for (const n of trio.nodes) {
        const a = await lockAuthorityForHive(HIVE_SLUG, electionDeps(n.db.sql, n.self));
        const seen = a.isSelf ? n.id.devicePubkey : a.peer!.devicePubkey;
        expect(seen).toBe(orig.id.devicePubkey);
        expect(a.liveCount).toBe(3);
      }

      // Stage 2 — the authority Swarm departs.
      await orig.peer.handle.close();

      // Stage 3 — the survivors keep heartbeating at VIRTUAL_NOW; each fresh
      // heartbeat must FEDERATE to the other survivor (their rosters, not ours).
      const VIRTUAL_NOW = Date.now() + 601_000;
      for (const s of survivors) {
        const seed = trio.seeds.find((x) => x.userId === s.self.githubUserId)!;
        await s.peer.handle.append({
          type: 'put',
          table: 'presence',
          hbKey: `${seed.userId}/${seed.machine}`,
          value: { ...presenceValue(seed.userId, seed.machine, s.id.devicePubkey), last_seen_at: VIRTUAL_NOW },
          ts: 2000 + seed.userId,
          schema_version: 1,
          writerPubkey: s.id.devicePubkey,
        });
      }
      const survivorsFresh = await pollUntil(
        async () => {
          for (const s of survivors) await s.peer.handle.mergeNow();
          for (const s of survivors) {
            const rows = await queryPresenceRowsForHive(s.db.sql as never, HIVE_SLUG);
            for (const other of survivors) {
              if (!rows.some((r) => r.device_pubkey === other.id.devicePubkey && r.last_seen_ms >= VIRTUAL_NOW)) return undefined;
            }
          }
          return true;
        },
        { timeoutMs: 20_000, intervalMs: 200 },
      );
      expect(survivorsFresh, "the survivors' fresh heartbeats never mutually federated").toBeTruthy();

      // Stage 4 — POST-FAILOVER CONSISTENCY: both survivors independently elect the
      // SAME successor (the second-lowest pubkey) over their OWN federated rosters.
      const elections = await Promise.all(
        survivors.map((s) => lockAuthorityForHive(HIVE_SLUG, electionDeps(s.db.sql, s.self, () => VIRTUAL_NOW + 1))),
      );
      for (const e of elections) expect(e.liveCount).toBe(2);
      const seenBySuccessor = elections[0].isSelf ? successor.id.devicePubkey : elections[0].peer!.devicePubkey;
      const seenByThird = elections[1].isSelf ? third.id.devicePubkey : elections[1].peer!.devicePubkey;
      expect(seenBySuccessor).toBe(successor.id.devicePubkey);
      expect(seenByThird).toBe(successor.id.devicePubkey);
      expect([elections[0].isSelf, elections[1].isSelf].filter(Boolean)).toHaveLength(1);

      // Stage 5 — claims continue under the successor: both survivors contend for
      // one item; the successor's store grants EXACTLY ONE.
      await successor.db.sql.unsafe(WORK_ITEM_CLAIMS_DDL);
      orgSqlHolder.sql = successor.db.sql;
      __resetAuthorityOpsForTests();
      registerWorkItemClaimAuthorityOps();
      const rpc = await startAuthorityRpcServer();
      setPeerRpcTransport(new HttpPeerRpcTransport({ resolveAddress: () => rpc.addr() }));
      cleanups.push(() => {
        __resetPeerRpcTransportForTests();
        __resetAuthorityOpsForTests();
      });
      const nowFn = () => VIRTUAL_NOW + 1;
      const [rS, rT] = await Promise.all([
        claimVia(successor.db.sql, successor.self, 'successor-swarm', 'F-XPEER3-1', nowFn),
        claimVia(third.db.sql, third.self, 'third-swarm', 'F-XPEER3-1', nowFn),
      ]);
      expect([rS, rT].filter((r) => r.value.ok)).toHaveLength(1);
      expect(rS.via).toBe('local-authority');
      expect(rT.via).toBe('remote-authority');

      // Stage 6 — REJOIN: the departed Swarm comes back (fresh boot, SAME identity)
      // and heartbeats at VIRTUAL_NOW. Same-identity re-admission must hold.
      const origSeed = trio.seeds.find((x) => x.userId === orig.self.githubUserId)!;
      const rejoined = await bootPresencePeer({
        testnetBootstrap: trio.testnet.bootstrap,
        rootPrefix: `xpeer3-rejoin-${origSeed.login}-`,
        identity: orig.id,
        sql: orig.db.sql,
        verify: (uid) => (trio.admitted.has(uid) ? 'verified' : 'fail'),
      });
      await rejoined.handle.append({
        type: 'put',
        table: 'presence',
        hbKey: `${origSeed.userId}/${origSeed.machine}`,
        value: { ...presenceValue(origSeed.userId, origSeed.machine, orig.id.devicePubkey), last_seen_at: VIRTUAL_NOW },
        ts: 3000,
        schema_version: 1,
        writerPubkey: orig.id.devicePubkey,
      });
      const everyone = [{ ...orig, peer: rejoined }, ...survivors];
      const reconverged = await pollUntil(
        async () => {
          for (const n of everyone) await n.peer.handle.mergeNow();
          for (const n of everyone) {
            const rows = await queryPresenceRowsForHive(n.db.sql as never, HIVE_SLUG);
            for (const m of everyone) {
              if (!rows.some((r) => r.device_pubkey === m.id.devicePubkey && r.last_seen_ms >= VIRTUAL_NOW)) return undefined;
            }
          }
          return true;
        },
        { timeoutMs: 25_000, intervalMs: 250 },
      );
      expect(reconverged, "the rejoined Swarm's heartbeat never federated to all peers").toBeTruthy();

      // Stage 7 — all three independently re-elect the ORIGINAL argmin authority.
      for (const n of everyone) {
        const a = await lockAuthorityForHive(HIVE_SLUG, electionDeps(n.db.sql, n.self, () => VIRTUAL_NOW + 1));
        const seen = a.isSelf ? n.id.devicePubkey : a.peer!.devicePubkey;
        expect(seen).toBe(orig.id.devicePubkey);
        expect(a.liveCount).toBe(3);
      }
    },
    90_000,
  );
});

describe('cross-peer coordination on a shared Hive — claim lease lifecycle across peers', () => {
  it(
    'acquire (remote) → contention refused → release (remote) → the other Swarm re-acquires',
    async () => {
      const { dbA, dbB, idA, idB, federated } = await federateTwoPeerPresence();
      expect(federated).toBeTruthy();

      const authorityIsA = idA.devicePubkey < idB.devicePubkey;
      const authority = authorityIsA ? { id: idA, db: dbA } : { id: idB, db: dbB };
      const client = authorityIsA ? { id: idB, db: dbB } : { id: idA, db: dbA };
      const selfAuthority = { githubUserId: authority.id.userId, devicePubkey: authority.id.devicePubkey };
      const selfClient = { githubUserId: client.id.userId, devicePubkey: client.id.devicePubkey };

      await authority.db.sql.unsafe(WORK_ITEM_CLAIMS_DDL);
      orgSqlHolder.sql = authority.db.sql; // every routed op serializes at the authority's store
      __resetAuthorityOpsForTests();
      registerWorkItemClaimAuthorityOps();
      const rpc = await startAuthorityRpcServer();
      setPeerRpcTransport(new HttpPeerRpcTransport({ resolveAddress: () => rpc.addr() }));
      cleanups.push(() => {
        __resetPeerRpcTransportForTests();
        __resetAuthorityOpsForTests();
      });

      const ITEM = 'F-XPEER-LEASE-1';
      // 1. The non-authority Swarm acquires over the real RPC wire.
      const r1 = await claimVia(client.db.sql, selfClient, 'client-swarm', ITEM);
      expect(r1.via).toBe('remote-authority');
      expect(r1.value.ok).toBe(true);
      const claimId = r1.value.ok ? r1.value.claim.claimId : '';

      // 2. The authority Swarm contends while the lease is live → refused, and the
      //    conflict faithfully names the cross-peer holder.
      const r2 = await claimVia(authority.db.sql, selfAuthority, 'authority-swarm', ITEM);
      expect(r2.via).toBe('local-authority');
      expect(r2.value.ok).toBe(false);
      if (!r2.value.ok) expect(r2.value.conflict.owner).toBe('client-swarm');

      // 3. The holder RELEASES over the same routed authority leg.
      const releasePayload: ReleaseClaimParams = {
        workspaceId: 'default',
        harnessSlug: HARNESS_SLUG,
        workItemId: ITEM,
        potSlug: HIVE_SLUG,
        claimId,
        owner: 'client-swarm',
      };
      const r3 = await routeToAuthorityForHive<boolean>(
        HIVE_SLUG,
        {
          local: () => releaseClaimLocal(releasePayload),
          remote: { kind: WORK_ITEM_CLAIM_OP_KINDS.release, payload: releasePayload, decode: (raw): boolean => raw as boolean },
        },
        electionDeps(client.db.sql, selfClient),
      );
      expect(r3.via).toBe('remote-authority');
      expect(r3.value).toBe(true);

      // 4. The lease is gone → the previously-refused Swarm now acquires.
      const r4 = await claimVia(authority.db.sql, selfAuthority, 'authority-swarm', ITEM);
      expect(r4.value.ok).toBe(true);
      const held = await getClaim('default', HARNESS_SLUG, ITEM);
      expect(held?.owner).toBe('authority-swarm');
    },
    60_000,
  );
});

describe('cross-peer coordination on a shared Hive — file-lock ops route over the federated roster (P-009)', () => {
  it(
    "a non-authority Swarm's lock.acquire routes to the federated-elected HIVE authority over the wire: grant → cross-wire busy → cross-wire release",
    async () => {
      const { dbA, dbB, idA, idB, federated } = await federateTwoPeerPresence();
      expect(federated).toBeTruthy();

      const authorityIsA = idA.devicePubkey < idB.devicePubkey;
      const authority = authorityIsA ? { id: idA, db: dbA } : { id: idB, db: dbB };
      const client = authorityIsA ? { id: idB, db: dbB } : { id: idA, db: dbA };
      const selfAuthority = { githubUserId: authority.id.userId, devicePubkey: authority.id.devicePubkey };
      const selfClient = { githubUserId: client.id.userId, devicePubkey: client.id.devicePubkey };

      // The authority "machine" hosts a minimal in-memory FileLockCoordinator behind
      // the REAL registered handlers (the FileLockCoordinator seam is the documented
      // test-injection point; the real-PG store leg is file-lock-authority-e2e's proof).
      const heldLocks = new Map<string, { owner: string; lockId: string }>();
      const coordinator: FileLockCoordinator = {
        acquire: async (p) => {
          const busy = p.paths
            .filter((path) => heldLocks.has(path) && heldLocks.get(path)!.owner !== p.owner)
            .map((path) => ({ path, owner: heldLocks.get(path)!.owner }));
          if (busy.length) return { ok: false, busy };
          const lockId = `lock-${p.owner}`;
          for (const path of p.paths) heldLocks.set(path, { owner: p.owner, lockId });
          return { ok: true, lockId, expiresTs: new Date(Date.now() + p.ttlSec * 1000).toISOString() };
        },
        release: async (p) => {
          const released: string[] = [];
          for (const [path, l] of heldLocks) {
            if (l.owner === p.owner && (!p.lockId || l.lockId === p.lockId)) {
              heldLocks.delete(path);
              released.push(path);
            }
          }
          return { ok: true, released };
        },
        queue: async () => [],
      };
      __resetAuthorityOpsForTests();
      registerFileLockAuthorityOps(coordinator);
      const rpc = await startAuthorityRpcServer();
      setPeerRpcTransport(new HttpPeerRpcTransport({ resolveAddress: () => rpc.addr() }));
      cleanups.push(() => {
        __resetPeerRpcTransportForTests();
        __resetAuthorityOpsForTests();
      });

      const DOMAIN = '/repo/xpeer-shared-checkout';
      const PATH = 'libs/contended.ts';
      // The PRODUCTION routing entry (the locks:acquire/release cutover seam), with its
      // domain→harness→Hive resolution injected and the election reading the caller's
      // OWN federated roster. skipRemotePeersFastPath forces the full authority path
      // (the cache layer has its own suite).
      const routingDeps = (sql: postgres.Sql, self: { githubUserId: number; devicePubkey: string }): FileLockRoutingDeps => ({
        ...electionDeps(sql, self),
        domainToHarnessSlug: () => HARNESS_SLUG,
        harnessToPotSlug: () => HIVE_SLUG,
        skipRemotePeersFastPath: true,
      });
      const lockAcquire = (who: { sql: postgres.Sql; self: { githubUserId: number; devicePubkey: string } }, owner: string) => {
        const payload: FileLockAcquireParams = {
          owner,
          paths: [PATH],
          intent: `xpeer file-lock test (${owner})`,
          ttlSec: 600,
          coordinationDomain: DOMAIN,
        };
        return routeFileLockOp<FileLockAcquireResult>(
          DOMAIN,
          {
            local: () => coordinator.acquire(payload),
            remote: { kind: FILE_LOCK_OP_KINDS.acquire, payload, decode: (raw): FileLockAcquireResult => raw as FileLockAcquireResult },
          },
          routingDeps(who.sql, who.self),
        );
      };

      // 1. The non-authority Swarm acquires → routed over the REAL wire, granted.
      const g1 = await lockAcquire({ sql: client.db.sql, self: selfClient }, 'client-agent');
      expect(g1.via).toBe('remote-authority');
      expect(g1.value.ok).toBe(true);
      const grantedLockId = g1.value.lockId!;

      // 2. The authority Swarm contends for the SAME path → busy, with the cross-peer
      //    holder faithfully named (the per-edit hook's "who holds this" answer).
      const g2 = await lockAcquire({ sql: authority.db.sql, self: selfAuthority }, 'authority-agent');
      expect(g2.via).toBe('local-authority');
      expect(g2.value.ok).toBe(false);
      expect(g2.value.busy).toEqual([{ path: PATH, owner: 'client-agent' }]);

      // 3. The holder releases over the same routed leg → the path frees.
      const releasePayload: FileLockReleaseParams = { owner: 'client-agent', lockId: grantedLockId, coordinationDomain: DOMAIN };
      const rel = await routeFileLockOp<{ ok: boolean; released?: string[] }>(
        DOMAIN,
        {
          local: () => coordinator.release(releasePayload),
          remote: {
            kind: FILE_LOCK_OP_KINDS.release,
            payload: releasePayload,
            decode: (raw): { ok: boolean; released?: string[] } => raw as { ok: boolean; released?: string[] },
          },
        },
        routingDeps(client.db.sql, selfClient),
      );
      expect(rel.via).toBe('remote-authority');
      expect(rel.value.ok).toBe(true);
      expect(rel.value.released).toEqual([PATH]);

      // 4. The previously-busy Swarm now acquires.
      const g3 = await lockAcquire({ sql: authority.db.sql, self: selfAuthority }, 'authority-agent');
      expect(g3.value.ok).toBe(true);
    },
    60_000,
  );
});

describe('cross-peer coordination on a shared Hive — deliver-and-wake over the real wire (EI-279)', () => {
  it(
    "a coord-message with body.wake federates A→B over the actual swarm; B's projection applies it origin='remote' and fires the wake fan EXACTLY once",
    async () => {
      const { dbA, dbB, idA, peerA, peerB, federated } = await federateTwoPeerPresence();
      expect(federated).toBeTruthy();
      vi.mocked(wakeRecipients).mockClear();

      // A "sends" a deliver-and-wake message — both legs of the production send:
      // (1) the local PG write coord:send performs (origin='local'), then (2) the
      // op the substrate-outbox capture→reshape chain appends on A's OWN peer-log.
      const MSG_ID = 'wake-e2e-1';
      const row: CoordMessageRow = {
        harness_slug: HARNESS_SLUG,
        msg_id: MSG_ID,
        surface: 'messages',
        writer_key: 'su-A',
        body: {
          ts: '2026-06-11T00:00:00Z',
          msg_id: MSG_ID,
          from: 'su-A',
          to: ['su-B'],
          kind: 'message',
          summary: 'cross-peer wake ping',
          wake: true,
        },
        ts: 1_700_000_000_000,
      };
      await dbA.sql`
        INSERT INTO harness_shared.coord_event_log (workspace_id, surface, writer_key, msg_id, body, harness_slug, origin)
        VALUES (${WORKSPACE_ID}, 'messages', 'su-A', ${MSG_ID}, ${dbA.sql.json(row.body as never)}, ${HARNESS_SLUG}, 'local')
      `;
      await peerA.handle.append({
        type: 'put',
        table: 'coord-messages',
        hbKey: MSG_ID,
        value: row,
        ts: 5000,
        schema_version: 1,
        writerPubkey: idA.devicePubkey,
      });

      // The op crosses the REAL wire and B's REAL projection lands it origin='remote'.
      const onB = await pollUntil(
        async () => {
          await peerA.handle.mergeNow(); // A applies its own op (origin='local')
          await peerB.handle.mergeNow(); // B merges A's log → the remote apply under test
          const rows = await dbB.sql<Array<{ origin: string; summary: string }>>`
            SELECT origin, body->>'summary' AS summary FROM harness_shared.coord_event_log WHERE msg_id = ${MSG_ID}
          `;
          return rows.length ? rows[0] : undefined;
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(onB, 'the wake message never federated to peer B').toBeTruthy();
      expect(onB!.origin).toBe('remote');
      expect(onB!.summary).toBe('cross-peer wake ping');

      // The deliver-and-wake fan fired on B EXACTLY once, for the envelope's
      // recipients — and A's own (origin='local') apply never fanned, so the
      // TOTAL across both peers is one.
      expect(wakeRecipients).toHaveBeenCalledTimes(1);
      expect(vi.mocked(wakeRecipients).mock.calls[0][0]).toEqual(['su-B']);

      // A's own store holds exactly ONE copy, still origin='local': the EI-117 echo
      // breaker (skipOwnOps) must NOT re-apply A's own log op over its original write
      // — a broken breaker would flip it to 'remote' (and double-fan, caught above).
      const onARows = await dbA.sql<Array<{ origin: string }>>`
        SELECT origin FROM harness_shared.coord_event_log WHERE msg_id = ${MSG_ID}
      `;
      expect(onARows).toHaveLength(1);
      expect(onARows[0].origin).toBe('local');
    },
    60_000,
  );
});
