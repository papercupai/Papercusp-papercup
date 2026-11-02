/**
 * The three declared providers driven END-TO-END through `runCensus` into REAL Postgres.
 * Plan: deterministic-coverage-census-2026-08-17 (P-003).
 *
 * WHY THIS EXISTS SEPARATELY FROM providers.test.ts. That file proves each provider enumerates
 * the right population; pg-store.integration.test.ts proves the store writes rows correctly. But
 * neither exercises the SEAM between them — registration lookup, retirement scoping, and the
 * upsert path all running together over the real registries. That seam is where the census
 * either becomes a live ledger or silently does nothing, and it is exactly what the routine runs.
 *
 * THE ASSERTION THAT MATTERS MOST IS THE SECOND RUN. A census whose surface identities are
 * unstable still passes every single-run test: it inserts rows, reports success, looks healthy.
 * Its failure only appears on run two, as a churn of retire+recreate that resets `first_seen` and
 * permanently defeats the new-surface gate. So the idempotence test below is not a nicety — it is
 * the one that can actually catch the failure mode this system is most vulnerable to.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { runCensus } from '@papercusp/testing-shell/census';
import type { OrgTestDb } from '../../test/_org-test-db';
import { createPgCensusStore } from './pg-store';
import { censusProviders } from './provider-registry';

const { createOrgTestDb } = await import('../../test/_org-test-db');

let db: OrgTestDb;
let store: ReturnType<typeof createPgCensusStore>;

/** Distinct per run so repeated local runs cannot collide in the shared template DB. */
const WS = `ws-census-e2e-${Math.random().toString(36).slice(2, 10)}`;
const HARNESS = 'census-e2e-probe';
const scope = { workspaceId: WS, harnessSlug: HARNESS };

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));

beforeAll(async () => {
  db = await createOrgTestDb();
  store = createPgCensusStore({ getSql: () => db.adminSql });

  // A pot must REGISTER a provider to run it (D-004: registration is pot-level). Without these
  // rows runCensus correctly does nothing, so seeding them is part of the scenario, not setup
  // noise — it is what `harness:generate-from-repo` / a template does for a real pot.
  for (const provider of ['hono-routes', 'mcp-tools', 'sync-queries']) {
    await db.adminSql`
      INSERT INTO harness_shared.census_provider_registrations
        (workspace_id, harness_slug, provider, config, enabled, source)
      VALUES (${WS}, ${HARNESS}, ${provider}, '{}'::jsonb, true, 'manual')
    `;
  }
}, 180_000);

afterAll(async () => {
  if (db) {
    await db.adminSql`DELETE FROM harness_shared.testing_surfaces WHERE workspace_id = ${WS}`;
    await db.adminSql`DELETE FROM harness_shared.census_provider_registrations WHERE workspace_id = ${WS}`;
    await db?.cleanup();
  }
});

describe('runCensus with the three declared providers', () => {
  it('populates the ledger from the live registries on a first run', async () => {
    const report = await runCensus({ scope, store, providers: censusProviders(), repoRoot });

    expect(report.ranProviders.sort()).toEqual(['hono-routes', 'mcp-tools', 'sync-queries']);
    expect(report.failedProviders).toEqual([]);
    expect(report.unimplementedProviders).toEqual([]);
    expect(report.disabledProviders).toEqual([]);

    // Nothing existed before, so a first run must be pure insert. A retirement here would mean
    // the diff retired rows it had just created.
    expect(report.applied?.retired).toBe(0);
    expect(report.applied?.upserted).toBeGreaterThan(0);
    expect(report.retirementBlocked).toBeNull();

    const [{ n }] = await db.adminSql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM harness_shared.testing_surfaces
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
    `;
    expect(Number(n)).toBe(report.applied?.upserted);

    // Every declared kind must actually be represented — a provider that ran "successfully" but
    // contributed nothing would otherwise pass unnoticed.
    const kinds = await db.adminSql<{ kind: string; n: string }[]>`
      SELECT kind, count(*)::text AS n FROM harness_shared.testing_surfaces
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
       GROUP BY kind
    `;
    expect(kinds.map((k) => k.kind).sort()).toEqual(['http-route', 'mcp-tool', 'sync-query']);
    for (const k of kinds) expect(Number(k.n)).toBeGreaterThan(0);

    const [registered] = await db.adminSql<{ source_file: string; attrs: Record<string, unknown> }[]>`
      SELECT source_file, attrs FROM harness_shared.testing_surfaces
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
         AND kind = 'mcp-tool' AND surface_id = 'coord:declare-intent'
    `;
    expect(registered?.source_file).toBe('packages/operator-core/lib/agent-tools/coordination/tools/declare-intent.ts');
    expect(registered?.attrs).toMatchObject({
      expose: { mcp: { name: 'coord:declare-intent' } },
      capabilities: ['coord:write'],
      authorization: { requirePrincipal: false },
    });
    expect(registered?.attrs).toHaveProperty('providerVersion');

    const [disabledTimeout] = await db.adminSql<{ attrs: Record<string, unknown> }[]>`
      SELECT attrs FROM harness_shared.testing_surfaces
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND kind = 'http-route'
         AND attrs->>'timeoutDeclared' = 'true' AND attrs->'timeoutSec' = 'null'::jsonb
       LIMIT 1
    `;
    expect(disabledTimeout?.attrs).toMatchObject({ hasDefinition: true, timeoutDeclared: true, timeoutSec: null });
    expect(disabledTimeout?.attrs).toHaveProperty('cors');
  }, 180_000);

  it('is idempotent — a second run retires nothing and preserves first_seen', async () => {
    const before = await db.adminSql<{ id: string; first_seen: Date }[]>`
      SELECT id, first_seen FROM harness_shared.testing_surfaces
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
       ORDER BY id
    `;
    expect(before.length).toBeGreaterThan(0);

    const report = await runCensus({ scope, store, providers: censusProviders(), repoRoot });

    // The identities were stable, so nothing disappeared from the world between the two runs.
    expect(report.failedProviders).toEqual([]);
    expect(report.applied?.retired).toBe(0);
    expect(report.diff.retires).toEqual([]);

    const after = await db.adminSql<{ id: string; first_seen: Date }[]>`
      SELECT id, first_seen FROM harness_shared.testing_surfaces
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
       ORDER BY id
    `;

    // Same rows, same ids — not a churn of retire + recreate wearing the same count.
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.map((r) => r.first_seen.toISOString())).toEqual(
      before.map((r) => r.first_seen.toISOString()),
    );
  }, 180_000);

  it('runs only the providers a pot registered', async () => {
    // Disabling one must remove it from the run WITHOUT retiring its surfaces: a disabled
    // provider's kinds are not retirable, precisely so turning a provider off does not read as
    // "every surface it owned was deleted".
    await db.adminSql`
      UPDATE harness_shared.census_provider_registrations SET enabled = false
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND provider = 'sync-queries'
    `;

    const report = await runCensus({ scope, store, providers: censusProviders(), repoRoot });

    expect(report.ranProviders.sort()).toEqual(['hono-routes', 'mcp-tools']);
    expect(report.disabledProviders).toEqual(['sync-queries']);
    expect(report.applied?.retired).toBe(0);

    const [{ n }] = await db.adminSql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM harness_shared.testing_surfaces
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
         AND kind = 'sync-query' AND retired_at IS NULL
    `;
    expect(Number(n)).toBeGreaterThan(0);

    await db.adminSql`
      UPDATE harness_shared.census_provider_registrations SET enabled = true
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND provider = 'sync-queries'
    `;
  }, 180_000);
});
