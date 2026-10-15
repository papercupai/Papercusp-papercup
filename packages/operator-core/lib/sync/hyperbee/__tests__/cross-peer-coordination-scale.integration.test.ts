/**
 * cross-peer-coordination-scale.integration.test.ts — the SCALE leg of the
 * cross-peer coordination suite (assertion 11 of the main file's ledger).
 *
 * Lives in its OWN file deliberately: a 5-peer mesh reliably stalls (connection
 * events never delivered to late-created swarms) when it shares a worker process
 * with the main suite's ~20 prior swarm create/destroy cycles — a test-process
 * artifact, not a product path (the product runs ONE long-lived shared swarm per
 * process). Own file = fresh vitest worker = clean process state. Rig + proof
 * boundary: _cross-peer-rig.ts.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
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
  federatePeerSet,
  startAuthorityRpcServer,
  claimVia,
  type PeerNode,
} from './_cross-peer-rig';
import { stubHivePolicyReadsForSuite } from './_hive-policy-read-stubs';
import { lockAuthorityForHive, queryPresenceRowsForHive } from '../../../authority/lock-authority';
import { setPeerRpcTransport, __resetPeerRpcTransportForTests } from '../../../authority/peer-rpc-transport';
import { HttpPeerRpcTransport } from '../../../authority/http-peer-rpc-transport';
import { __resetAuthorityOpsForTests } from '../../../authority/authority-op-registry';
import { registerWorkItemClaimAuthorityOps } from '../../../work-item-claim-authority-ops';
import { buildHiveRekeyBootDeps } from '../hive-epoch-boot-deps';

const rekeyFixture = vi.hoisted(() => ({ enabled: false }));

// getOrgPg → the CURRENT epoch's authority store, via the rig's holder.
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  const { orgSqlHolder } = await import('./_org-sql-holder');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: orgSqlHolder.sql }) };
});

// Match the companion coordination suite: this rig exercises presence, election
// and claims without the Hive registry/keychain needed for rekey composition.
// Keep other flag reads real and production's enabled-rekey fail-closed path intact.
vi.mock('@papercusp/flags/server', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/flags/server')>('@papercusp/flags/server');
  return {
    ...actual,
    getFlag: async (key: unknown, scope?: unknown) =>
      key === 'papercusp-hive-rekey'
        ? rekeyFixture.enabled
        : (actual.getFlag as (k: unknown, s?: unknown) => Promise<boolean>)(key, scope),
  };
});

// Registered BEFORE the file's own hooks so the stub outlives substrate teardown,
// which can still run a merge pass (WI-6554700010008561 / WI-10007530).
stubHivePolicyReadsForSuite();
beforeEach(() => {
  rekeyFixture.enabled = false;
  orgSqlHolder.sql = undefined as unknown as typeof orgSqlHolder.sql;
});
afterEach(rigAfterEach);

describe('cross-peer scale boot fixture boundary', () => {
  it('boots the coordination-only off-path before the authority SQL holder exists', async () => {
    expect(orgSqlHolder.sql).toBeUndefined();
    await expect(buildHiveRekeyBootDeps({ workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG })).resolves.toBeNull();
  });

  it('still fails closed when rekey is enabled without its SQL dependency', async () => {
    rekeyFixture.enabled = true;
    await expect(buildHiveRekeyBootDeps({ workspaceId: WORKSPACE_ID, harnessSlug: HARNESS_SLUG })).rejects.toThrow(
      // The registry read (Hive-scope lookup) is the first SQL use, so it fails there — before
      // any Hive is confirmed (WI-6554700010008455 split this out of the compose phase).
      /failed closed \(resolve Hive scope\): sql is not a function/,
    );
  });
});

describe('cross-peer coordination on a shared Hive — FIVE-Swarm cascading failover (scale)', () => {
  it(
    'each authority departure is followed by UNANIMOUS re-election among all survivors, and claims serialize at every epoch, down to a single Swarm',
    async () => {
      const fleet = await federatePeerSet(5, 75_000);
      expect(fleet.federated, `five-way presence federation did not complete — missing: ${fleet.lastMissing}`).toBeTruthy();

      // Ascending pubkey = the deterministic succession order (argmin elects index 0).
      let alive = [...fleet.nodes].sort((a, b) => (a.id.devicePubkey < b.id.devicePubkey ? -1 : 1));

      // Round 0 — fully connected: all FIVE rosters elect the same authority.
      for (const n of fleet.nodes) {
        const a = await lockAuthorityForHive(HIVE_SLUG, electionDeps(n.db.sql, n.self));
        const seen = a.isSelf ? n.id.devicePubkey : a.peer!.devicePubkey;
        expect(seen).toBe(alive[0].id.devicePubkey);
        expect(a.liveCount).toBe(5);
      }

      // One claim store per Swarm (the per-machine embedded-pg model) + one RPC
      // endpoint that always fronts the CURRENT epoch's authority store (h.sql
      // rebound each round).
      for (const n of fleet.nodes) await n.db.sql.unsafe(WORK_ITEM_CLAIMS_DDL);
      __resetAuthorityOpsForTests();
      registerWorkItemClaimAuthorityOps();
      const rpc = await startAuthorityRpcServer();
      setPeerRpcTransport(new HttpPeerRpcTransport({ resolveAddress: () => rpc.addr() }));
      cleanups.push(() => {
        __resetPeerRpcTransportForTests();
        __resetAuthorityOpsForTests();
      });

      // The cascade: kill the sitting authority; survivors heartbeat one staleness
      // window later; EVERY survivor must independently elect the SAME successor.
      // Round-k clock = now + k*601s, so each prior round's rows (including the
      // freshly-departed authority's last heartbeat) age out exactly one window.
      for (let round = 1; alive.length > 1; round++) {
        await alive[0].peer.handle.close();
        alive = alive.slice(1);
        const VN = Date.now() + round * 601_000;

        for (const s of alive) {
          const seed = fleet.seeds.find((x) => x.userId === s.self.githubUserId)!;
          await s.peer.handle.append({
            type: 'put',
            table: 'presence',
            hbKey: `${seed.userId}/${seed.machine}`,
            value: { ...presenceValue(seed.userId, seed.machine, s.id.devicePubkey), last_seen_at: VN },
            ts: 10_000 * round + seed.userId,
            schema_version: 1,
            writerPubkey: s.id.devicePubkey,
          });
        }
        const fresh = await pollUntil(
          async () => {
            for (const s of alive) await s.peer.handle.mergeNow();
            for (const s of alive) {
              const rows = await queryPresenceRowsForHive(s.db.sql as never, HIVE_SLUG);
              for (const other of alive) {
                if (!rows.some((r) => r.device_pubkey === other.id.devicePubkey && r.last_seen_ms >= VN)) return undefined;
              }
            }
            return true;
          },
          { timeoutMs: 20_000, intervalMs: 200 },
        );
        expect(fresh, `round ${round}: survivor heartbeats never mutually federated`).toBeTruthy();

        const clock = () => VN + 1;
        const elections = await Promise.all(
          alive.map((s) => lockAuthorityForHive(HIVE_SLUG, electionDeps(s.db.sql, s.self, clock))),
        );
        elections.forEach((e, i) => {
          const seen = e.isSelf ? alive[i].id.devicePubkey : e.peer!.devicePubkey;
          expect(seen, `round ${round}: survivor ${i} disagreed on the successor`).toBe(alive[0].id.devicePubkey);
          expect(e.liveCount).toBe(alive.length);
        });
        expect(elections.filter((e) => e.isSelf)).toHaveLength(1);

        // Claims serialize at THIS epoch's authority.
        orgSqlHolder.sql = alive[0].db.sql;
        const clockedClaim = (n: PeerNode, owner: string) => claimVia(n.db.sql, n.self, owner, `F-CASCADE-${round}`, clock);
        if (alive.length >= 2) {
          const [rAuth, rPeer] = await Promise.all([
            clockedClaim(alive[0], `auth-r${round}`),
            clockedClaim(alive[1], `peer-r${round}`),
          ]);
          expect([rAuth, rPeer].filter((r) => r.value.ok)).toHaveLength(1);
          expect(rAuth.via).toBe('local-authority');
          expect(rPeer.via).toBe('remote-authority');
        } else {
          const r = await clockedClaim(alive[0], 'last-swarm');
          expect(r.via).toBe('local-authority');
          expect(r.value.ok).toBe(true);
        }
      }
      expect(alive).toHaveLength(1);
    },
    150_000,
  );
});
