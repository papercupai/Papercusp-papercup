/**
 * join-hive-from-repo-incremental-federation.integration.test.ts
 *
 * WI-971 (from-repo joiner incremental federation) — live-PG proof that
 * `joinHiveAsView`'s step "2c/2c′" (join-hive.ts ~L415-470) actually wires the
 * outbox drain for a from-repo join, rather than only being covered by
 * join-hive.test.ts's MOCKED rekeyHarness/mutateRegistry unit tests.
 *
 * SCOPE (fallback path per the WI-3542 investigation — see known-limitations.mdx
 * WI-971 section): a full two-real-substrate-peer content round-trip through
 * `joinHiveAsView` end-to-end (real GitHub clone, real attestation, real
 * Hyperswarm/testnet DHT on BOTH the per-member join AND the rekeyed home view)
 * is a materially larger rig than this fix warrants proving alone, and is
 * tracked separately (see the follow-up WI filed alongside this test). THIS
 * test proves the two claims that were previously ONLY unit-tested with fakes:
 *
 *   1. REGISTRY PERSISTENCE IS REAL: `mutateHarnessRegistry`/`loadHarnessRegistry`
 *      run UNMOCKED against a real, migrated Postgres (env-routed getOrgPg, the
 *      same plumbing owner-content-to-joiner-faithful.repro.integration.test.ts
 *      uses) — the home-view + member registry rows this fix depends on for its
 *      rekey targets are genuinely committed, not an in-memory fake.
 *   2. THE REKEY CALL IS ORDERED AFTER THE REGISTRY COMMIT (the actual bug this
 *      fix closes): `rekeyHarness` is stubbed to itself perform a REAL
 *      `loadHarnessRegistry` read (not just record its args) at the moment
 *      join-hive.ts invokes it. If 2c′/2c fired before the registry mutate
 *      committed (the WI-971 regression shape — rekey resolving a binding that
 *      doesn't exist yet), the home-view / member slug would be ABSENT from
 *      that real read and the assertion fails. The stub also asserts it is
 *      called for BOTH the home-view slug (2c′) and every joined member slug
 *      (2c), in that order — the exact wiring WI-971 added.
 *
 * The from-repo `joinLink` (GitHub clone/attestation) is stubbed — unrelated to
 * WI-971's registry/rekey wiring and already covered elsewhere (join-link
 * route tests). `parseHarnessLink` is REAL (unmocked) — the member link shape
 * must be genuinely valid for `joinHiveAsView` to reach the registry/rekey path
 * at all.
 *
 * RUN (integration layer — real testcontainer PG):
 *   cd packages/operator-core && npx vitest run --config vitest.integration.config.ts \
 *     --include '**\/join-hive-from-repo-incremental-federation.integration.test.ts'
 */

import { afterEach, describe, it, expect } from 'vitest';
import { joinHiveAsView, type JoinHiveDeps } from './join-hive';
import { loadHarnessRegistry, mutateHarnessRegistry } from '../harness-registry';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { _resetForTests as resetDbOrgPools } from '@papercusp/db-org';
// eslint-disable-next-line import/no-relative-packages -- clears the env-URL cache the pool resolver memoizes
import { _resetUrlCacheForTests } from '../../../../libs/papercusp/libs/db/src/connection';
import { _resetHarnessAdminUrlCacheForTests } from '../embedded-pg-discovery';

const WORKSPACE_ID = 'ws-wi971-from-repo';
const TOPIC = 'b'.repeat(64);
const HIVE_PUBKEY = 'h'.repeat(43) + '=';
const OWNER_DEVICE_PUBKEY = Buffer.alloc(32, 7).toString('base64');
const link = (repo: string, id: number) =>
  `papercusp://harness?topic=${TOPIC}&github=acme%2F${repo}&repo_id=${id}`;

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      /* best-effort */
    }
  }
});

describe('joinHiveAsView (WI-971) — real-PG registry + rekey-ordering proof', () => {
  it(
    'commits home-view + member registry rows to REAL Postgres, then rekeys the home view (2c′) and each member (2c) AFTER that commit is visible',
    async () => {
      const orgDb: OrgTestDb = await createOrgTestDb();
      const prevAdminUrl = process.env.HARNESS_ADMIN_DATABASE_URL;
      const prevAppUrl = process.env.HARNESS_DATABASE_URL;
      const prevWs = process.env.PAPERCUSP_WORKSPACE_ID;
      const prevSkipDisc = process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
      const prevPgb = process.env.PAPERCUSP_PGBOUNCER;
      process.env.HARNESS_ADMIN_DATABASE_URL = orgDb.adminDsn;
      process.env.HARNESS_DATABASE_URL = orgDb.appDsn;
      process.env.PAPERCUSP_WORKSPACE_ID = WORKSPACE_ID;
      process.env.PAPERCUSP_SKIP_PG_DISCOVERY = '1';
      // pgbouncer default-on rewrites the getOrgPg URL to :6432 on a server-class
      // host, bypassing this throwaway testcontainer DB — force it off, same as
      // owner-content-to-joiner-faithful.repro.integration.test.ts.
      process.env.PAPERCUSP_PGBOUNCER = '0';
      _resetUrlCacheForTests();
      _resetHarnessAdminUrlCacheForTests();
      await resetDbOrgPools();
      cleanups.push(async () => {
        if (prevAdminUrl === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL;
        else process.env.HARNESS_ADMIN_DATABASE_URL = prevAdminUrl;
        if (prevAppUrl === undefined) delete process.env.HARNESS_DATABASE_URL;
        else process.env.HARNESS_DATABASE_URL = prevAppUrl;
        if (prevWs === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
        else process.env.PAPERCUSP_WORKSPACE_ID = prevWs;
        if (prevSkipDisc === undefined) delete process.env.PAPERCUSP_SKIP_PG_DISCOVERY;
        else process.env.PAPERCUSP_SKIP_PG_DISCOVERY = prevSkipDisc;
        if (prevPgb === undefined) delete process.env.PAPERCUSP_PGBOUNCER;
        else process.env.PAPERCUSP_PGBOUNCER = prevPgb;
        _resetUrlCacheForTests();
        _resetHarnessAdminUrlCacheForTests();
        await resetDbOrgPools();
        await orgDb?.cleanup();
      });

      // ── The rekey spy: on EVERY call, do a REAL loadHarnessRegistry read (the
      //    same real getOrgPg-backed function join-hive.ts's default rekeyHarness
      //    dep transitively depends on via boot-all → harness-registry reads) and
      //    assert the slug it's being asked to rekey is ALREADY committed and
      //    visible. This is what proves ordering, not just call recording — a
      //    regression that fired 2c/2c′ before the mutateRegistry commit (or
      //    against a stale cached read) would see the slug ABSENT here. ──
      const rekeyCalls: string[] = [];
      const rekeyHarness = async (ws: string, slug: string): Promise<void> => {
        rekeyCalls.push(slug);
        const fresh = await loadHarnessRegistry(ws, { fresh: true });
        const row = fresh.projects.find((p) => p.slug === slug);
        expect(
          row,
          `rekeyHarness(${slug}) fired but the registry commit for '${slug}' was not yet visible ` +
            'via a real loadHarnessRegistry read — this is the exact WI-971 ordering regression',
        ).toBeTruthy();
      };

      // Stub the from-repo clone/attestation (unrelated to WI-971), but still
      // REALLY register the member's harness-registry row via the real
      // mutateHarnessRegistry — exactly what production's handleJoinLink does
      // as part of a real per-member join. Without this, join-hive.ts's later
      // `cur.projects.map` stamping step (which only UPDATES existing rows,
      // never creates one) would have nothing to stamp `hive_slug` onto.
      const joinLinkStub: JoinHiveDeps['joinLink'] = async ({ slug }) => {
        await mutateHarnessRegistry(
          (reg) => ({
            ...reg,
            projects: reg.projects.some((p) => p.slug === slug)
              ? reg.projects
              : [...reg.projects, { slug, path: `/tmp/joined/${slug}` }],
          }),
          WORKSPACE_ID,
        );
        return { ok: true, detail: 'joined' };
      };

      const res = await joinHiveAsView(
        {
          potId: 'acme-hive',
          hivePubkey: HIVE_PUBKEY,
          memberLinks: [link('widgets', 5001), link('sprockets', 5002)],
          workspaceId: WORKSPACE_ID,
        },
        {
          joinLink: joinLinkStub,
          loadRegistry: loadHarnessRegistry,
          mutateRegistry: mutateHarnessRegistry,
          ensureDir: async () => {},
          rekeyHarness,
          // Best-effort deps unrelated to WI-971's registry/rekey wiring:
          seedGitSync: async () => ({
            seeded: false,
            reason: 'ineligible',
          }),
          upsertHiveIdentity: async () => {},
          resolveHivePubkey: async () => HIVE_PUBKEY,
          resolveOwnerDevicePubkey: async () => OWNER_DEVICE_PUBKEY,
          getLocalHive: async () => null,
        },
      );

      expect(res.ok).toBe(true);
      expect(res.potSlug).toBeTruthy();
      const potSlug = res.potSlug!;
      expect(res.members.map((m) => m.ok)).toEqual([true, true]);
      const memberSlugs = res.members.map((m) => m.slug);

      // ── Claim 1: the home-view + both member rows are REALLY committed —
      //    read again, fresh, from Postgres (not the deps' in-memory return). ──
      const committed = await loadHarnessRegistry(WORKSPACE_ID, { fresh: true });
      const homeRow = committed.projects.find((p) => p.slug === potSlug);
      expect(homeRow).toMatchObject({
        harness_kind: 'hive',
        remote_hive: true,
        hive_pubkey: HIVE_PUBKEY,
        owner_device_pubkey: OWNER_DEVICE_PUBKEY,
      });
      for (const slug of memberSlugs) {
        const memberRow = committed.projects.find((p) => p.slug === slug);
        expect(memberRow, `member row for '${slug}' missing from real Postgres`).toMatchObject({
          hive_slug: potSlug,
        });
      }

      // ── Claim 2: rekeyHarness fired for the home view (2c′) FIRST, then every
      //    joined member (2c), in that order — the exact wiring shape WI-971
      //    added — and (proven inside the stub above) each call's slug was
      //    already visible via a real registry read at call time. ──
      expect(rekeyCalls[0]).toBe(potSlug);
      expect(rekeyCalls.slice(1)).toEqual(memberSlugs);
    },
    // Pays the first-time org-template build (~280 migrations) inside the body.
    120_000,
  );
});
