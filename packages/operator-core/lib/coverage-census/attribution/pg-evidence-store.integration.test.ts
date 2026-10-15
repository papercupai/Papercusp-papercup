/**
 * The attribution chain against REAL Postgres: observation -> buffer -> flush -> a
 * `coverage_evidence` row joined to the census surface P-003's providers wrote.
 *
 * Plan: deterministic-coverage-census-2026-08-17 (P-004).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE UNIT TESTS. The unit tests cover what a row MEANS
 * (collapse, verdict merge, arming). They cannot cover the three things that can only be wrong
 * against a real database, and each of them fails SILENTLY rather than loudly:
 *
 *   1. THE `ON CONFLICT` TARGET. `coverage_evidence_dedup` is an EXPRESSION index
 *      (`COALESCE(test_file,''), COALESCE(test_case,''), COALESCE(test_run_id,-1)`), and
 *      Postgres matches an ON CONFLICT target to an expression index only by exact expression.
 *      A near-miss does not silently insert a duplicate — it raises, but only against real PG.
 *   2. THE SURFACE JOIN. Evidence is useless unless `surface_ref` resolves via the SAME
 *      (workspace, harness, kind, surface_id) identity the census writes. A mismatch inserts
 *      nothing and reports zero — indistinguishable from "no traffic happened".
 *   3. RETIRED SURFACES. Evidence must not attach to a surface the census has retired.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OrgTestDb } from '../../../test/_org-test-db';
import { createPgEvidenceStore } from './pg-evidence-store';
import { ATTRIBUTION_ENV, resetAttributionArmingForTests, setAmbientTestContext } from './context';
import {
  flushTrafficEvidence,
  recordHttpTraffic,
  recordMcpTraffic,
  resetAttributionSinkForTests,
  setEvidenceStoreForTests,
  attributionStatus,
} from './sink';

const { createOrgTestDb } = await import('../../../test/_org-test-db');

let db: OrgTestDb;

/** Distinct per run so repeated local runs cannot collide in the shared template DB. */
const WS = `ws-attr-${Math.random().toString(36).slice(2, 10)}`;
const HARNESS = 'attribution-probe';

const ROUTE_ID = 'GET /api/widgets/:id';
const TOOL_ID = 'widgets:list';

async function seedSurface(kind: string, surfaceId: string, retired = false): Promise<number> {
  const [row] = await db.adminSql<{ id: string | number }[]>`
    INSERT INTO harness_shared.testing_surfaces
      (workspace_id, harness_slug, kind, surface_id, provider, fidelity, retired_at)
    VALUES (${WS}, ${HARNESS}, ${kind}, ${surfaceId}, 'test-seed', 'declared',
            ${retired ? db.adminSql`now()` : null})
    RETURNING id
  `;
  return Number(row.id);
}

async function evidenceFor(surfaceRef: number) {
  return db.adminSql<
    {
      id: string;
      verdict: string;
      generated: boolean;
      test_file: string | null;
      test_case: string | null;
      test_run_id: string | null;
      details: Record<string, unknown>;
      observed_at: Date;
    }[]
  >`
    SELECT id, verdict, generated, test_file, test_case, test_run_id, details, observed_at
      FROM harness_shared.coverage_evidence
     WHERE surface_ref = ${surfaceRef}
     ORDER BY id
  `;
}

beforeAll(async () => {
  db = await createOrgTestDb();
}, 180_000);

afterAll(async () => {
  // NOT `db?.adminSql\`...\`` — a tagged template is not permitted in an optional chain (TS1358).
  // Deleting the surfaces cascades the evidence (coverage_evidence.surface_ref is ON DELETE
  // CASCADE), so no separate evidence cleanup is needed.
  if (db) {
    await db.adminSql`
      DELETE FROM harness_shared.testing_surfaces
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
    `;
    await db?.cleanup();
  }
});

beforeEach(() => {
  resetAttributionSinkForTests();
  setAmbientTestContext(null);
  process.env[ATTRIBUTION_ENV] = '1';
  process.env.PAPERCUSP_WORKSPACE_ID = WS;
  process.env.PAPERCUSP_TEST_RUN_HARNESS = HARNESS;
  process.env.PAPERCUSP_TEST_RUN_GROUP = 'run-attr-1';
  resetAttributionArmingForTests();
  // The store is pointed at the testcontainer handle. In production it resolves its own
  // connection to the canonical admin URL — see the store's file header for why it must.
  setEvidenceStoreForTests(createPgEvidenceStore({ getSql: () => db.adminSql }));
});

afterEach(() => {
  resetAttributionSinkForTests();
  setAmbientTestContext(null);
  delete process.env[ATTRIBUTION_ENV];
  delete process.env.PAPERCUSP_WORKSPACE_ID;
  delete process.env.PAPERCUSP_TEST_RUN_HARNESS;
  delete process.env.PAPERCUSP_TEST_RUN_GROUP;
  resetAttributionArmingForTests();
});

describe('http-route traffic', () => {
  it('publishes coverage invalidation on the same injected database as its evidence', async () => {
    const ref = await seedSurface('http-route', 'GET /api/private-notification');
    const notifications: unknown[] = [];
    const listener = await db.adminSql.listen('sync_invalidate', payload => notifications.push(JSON.parse(payload)));
    try {
      setAmbientTestContext({ file: 'private-notification.test.ts', case: 'keeps the evidence venue' });
      recordHttpTraffic({ method: 'GET', path: '/api/private-notification', status: 'ok', httpStatus: 200 });
      await flushTrafficEvidence();

      expect(await evidenceFor(ref)).toHaveLength(1);
      expect(attributionStatus().lastError).toBeNull();
      await expect.poll(() => notifications).toEqual([{ name: 'testing.coverage' }]);
    } finally {
      await listener.unlisten();
    }
  });

  it('writes one evidence row joined to the census surface', async () => {
    const ref = await seedSurface('http-route', ROUTE_ID);
    setAmbientTestContext({ file: 'packages/operator-core/lib/a.test.ts', case: 'serves a widget' });

    recordHttpTraffic({ method: 'get', path: '/api/widgets/:id', status: 'ok', httpStatus: 200 });
    await flushTrafficEvidence();

    const rows = await evidenceFor(ref);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      verdict: 'pass',
      generated: false,
      test_file: 'packages/operator-core/lib/a.test.ts',
      test_case: 'serves a widget',
      // NULL by design (D-010): the test_runs row does not exist yet at traffic time, and
      // resolving it opportunistically would make the row COUNT depend on flush timing.
      test_run_id: null,
    });
    expect(rows[0].details).toMatchObject({
      runGroupId: 'run-attr-1',
      routeStatus: 'ok',
      httpStatus: 200,
      calls: 1,
    });
  });

  it('an auth rejection is recorded as skip, NOT as coverage', async () => {
    const ref = await seedSurface('http-route', 'GET /api/guarded');
    setAmbientTestContext({ file: 'a.test.ts', case: 'rejects anonymous' });

    recordHttpTraffic({ method: 'GET', path: '/api/guarded', status: 'unauthorized', httpStatus: 401 });
    await flushTrafficEvidence();

    const rows = await evidenceFor(ref);
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toBe('skip');
  });
});

describe('mcp-tool traffic', () => {
  it('writes one evidence row keyed by the bare tool name', async () => {
    const ref = await seedSurface('mcp-tool', TOOL_ID);
    setAmbientTestContext({ file: 'b.test.ts', case: 'lists widgets' });

    recordMcpTraffic({ toolName: TOOL_ID, status: 'ok' });
    await flushTrafficEvidence();

    const rows = await evidenceFor(ref);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ verdict: 'pass', test_case: 'lists widgets' });
  });
});

describe('dedup — the expression-index ON CONFLICT target', () => {
  it('re-observing the SAME binding updates one row instead of inserting a second', async () => {
    const ref = await seedSurface('http-route', 'GET /api/dedup');
    setAmbientTestContext({ file: 'c.test.ts', case: 'hits it twice' });

    recordHttpTraffic({ method: 'GET', path: '/api/dedup', status: 'ok', httpStatus: 200 });
    await flushTrafficEvidence();
    const first = await evidenceFor(ref);
    expect(first).toHaveLength(1);

    // A SECOND flush, as a later run would produce — the row must be refreshed, not duplicated.
    recordHttpTraffic({ method: 'GET', path: '/api/dedup', status: 'error', httpStatus: 500 });
    await flushTrafficEvidence();

    const second = await evidenceFor(ref);
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(first[0].id);
    expect(second[0].verdict).toBe('error');
    expect(second[0].observed_at.getTime()).toBeGreaterThanOrEqual(first[0].observed_at.getTime());
  });

  it('keeps SEPARATE rows for different test cases on one surface', async () => {
    const ref = await seedSurface('http-route', 'GET /api/two-cases');

    setAmbientTestContext({ file: 'd.test.ts', case: 'case one' });
    recordHttpTraffic({ method: 'GET', path: '/api/two-cases', status: 'ok' });
    setAmbientTestContext({ file: 'd.test.ts', case: 'case two' });
    recordHttpTraffic({ method: 'GET', path: '/api/two-cases', status: 'ok' });
    await flushTrafficEvidence();

    const rows = await evidenceFor(ref);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.test_case).sort()).toEqual(['case one', 'case two']);
  });

  it('dedups a NULL test case rather than inserting without limit', async () => {
    // The plain-UNIQUE hazard migration 846 calls out: PostgreSQL treats NULLs as distinct, so
    // without the COALESCE expressions every anonymous observation would insert a new row.
    const ref = await seedSurface('http-route', 'GET /api/anon');

    recordHttpTraffic({ method: 'GET', path: '/api/anon', status: 'ok' });
    await flushTrafficEvidence();
    recordHttpTraffic({ method: 'GET', path: '/api/anon', status: 'ok' });
    await flushTrafficEvidence();

    const rows = await evidenceFor(ref);
    expect(rows).toHaveLength(1);
    expect(rows[0].test_file).toBeNull();
    expect(rows[0].test_case).toBeNull();
  });
});

describe('surfaces the census does not know', () => {
  it('counts an unmatched surface and creates NO surface row for it', async () => {
    recordHttpTraffic({ method: 'GET', path: '/api/never-censused', status: 'ok' });
    await flushTrafficEvidence();

    expect(attributionStatus().unmatchedSurfaces).toBe(1);
    const [{ count }] = await db.adminSql<{ count: string }[]>`
      SELECT count(*)::text AS count
        FROM harness_shared.testing_surfaces
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
         AND surface_id = 'GET /api/never-censused'
    `;
    expect(count).toBe('0');
  });

  it('does not attach evidence to a RETIRED surface', async () => {
    const ref = await seedSurface('http-route', 'GET /api/retired', true);
    recordHttpTraffic({ method: 'GET', path: '/api/retired', status: 'ok' });
    await flushTrafficEvidence();

    expect(await evidenceFor(ref)).toHaveLength(0);
    expect(attributionStatus().unmatchedSurfaces).toBe(1);
  });
});

describe('scope resolution (D-011)', () => {
  it('falls back to the census scope — never to a guess — when no env pin is set', async () => {
    // ⚠ THIS TEST ASSERTED THE OPPOSITE UNTIL D-011, AND THAT IS THE POINT.
    //
    // It used to prove the layer REFUSED when `PAPERCUSP_WORKSPACE_ID` was unset, and it
    // passed — while the same condition held in every real run, so the refusal it was
    // guarding fired universally and the layer wrote nothing, ever. A green test over a
    // condition that is meant to be exceptional is worth very little if nobody checks how
    // often the condition actually holds. (Measured 2026-08-18: `harness_slug` NULL on 100%
    // of 7,202 `test_runs` rows in 90 minutes; neither operator host had the vars.)
    //
    // The invariant that actually matters is unchanged, and is what this now asserts: an
    // unpinned run must not write evidence onto a surface belonging to a DIFFERENT scope.
    // It just gets there by resolving the census's own scope instead of refusing — so the
    // probe's synthetic surface (seeded under WS/HARNESS) is correctly not matched, and the
    // miss is COUNTED rather than silently inserted.
    const ref = await seedSurface('http-route', 'GET /api/no-scope');
    delete process.env.PAPERCUSP_WORKSPACE_ID;
    delete process.env.PAPERCUSP_TEST_RUN_HARNESS;

    recordHttpTraffic({ method: 'GET', path: '/api/no-scope', status: 'ok' });
    await flushTrafficEvidence();

    const status = attributionStatus();
    // No row on the probe's surface — the resolved scope is the box's, not the probe's.
    expect(await evidenceFor(ref)).toHaveLength(0);
    // ...and it got there by RESOLVING, not by refusing. This is the assertion that would
    // have caught the original defect: a refusal here means the resolver is back to
    // returning null, i.e. the layer is inert again.
    expect(status.lastError).toBeNull();
    // The miss is reported, so "wrote nothing" is never mistaken for "covered nothing".
    expect(status.unmatchedSurfaces).toBe(1);
    expect(status.written).toBe(0);
  });

  it('honours an explicit env pin over the ambient census scope', async () => {
    // The pin is what makes a cross-process run attributable: a test fork driving another
    // workspace's operator is the one case where the ambient answer is wrong.
    const ref = await seedSurface('http-route', 'GET /api/pinned');
    setAmbientTestContext({ file: 'packages/operator-core/lib/pinned.test.ts', case: 'pinned' });

    recordHttpTraffic({ method: 'GET', path: '/api/pinned', status: 'ok' });
    await flushTrafficEvidence();

    // beforeEach pins WS/HARNESS, which is where the surface was seeded — so it MATCHES.
    expect(await evidenceFor(ref)).toHaveLength(1);
    expect(attributionStatus().unmatchedSurfaces).toBe(0);
  });
});
