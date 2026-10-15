/**
 * feature-views.ts getAudit (per-harness fallback) + brainstorm.ts promote
 * (feature target) — WI-5381 (WI-4995 part b) regression tests.
 *
 * Proves the harnessQuery migration resolves BOTH `feature_audit` and
 * `harness_features` to the CORRECT per-harness schema (never a sibling
 * harness's same-named table) in BOTH connection modes, mirroring
 * archives-clear-features.integration.test.ts's method. Also proves
 * brainstorm.ts's promote-to-feature mints an F-IDEA id that is unique across
 * sibling harnesses (scope-unique-identifiers P-005 replaced the per-harness
 * MAX + 1 counter) and lands in the target schema. Real Postgres (testcontainer;
 * Docker required). Run:
 *   npx vitest run --config vitest.integration.config.ts lib/endpoint-route/routes/harness/feature-views-audit-and-brainstorm-promote.integration.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres, { type Sql } from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { slugToSchemaName, _resetForTests } from '@papercusp/db-org';
import { _resetUrlCacheForTests } from '../../../../../../libs/papercusp/libs/db/src/connection';
import type { ProjectEntry } from '../../../harness-registry';

const SLUG_A = 'fvbp-test-a';
const SLUG_B = 'fvbp-test-b';
const SCHEMA_A = slugToSchemaName(SLUG_A);
const SCHEMA_B = slugToSchemaName(SLUG_B);

// Both feature-views.ts and brainstorm.ts resolve their project via
// harness-core's resolveProject/resolvePhasedProject, which hit the
// filesystem-backed harness registry — irrelevant to the DB-scoping
// property under test, so stub just those two exports and keep every
// other real export (harnessDir, safeRead, ...) via importActual, so a
// route file's other unused imports still resolve normally.
vi.mock('../../../harness-core', async () => {
  const actual = await vi.importActual<typeof import('../../../harness-core')>('../../../harness-core');
  const projectFor = (slug: string): ProjectEntry => ({ slug, path: `/tmp/fvbp-${slug}` });
  return {
    ...actual,
    resolveProject: vi.fn(async (slug: string) => projectFor(slug)),
    resolvePhasedProject: vi.fn(async (slug: string) => projectFor(slug)),
  };
});

// notifySyncInvalidate (Postgres LISTEN/NOTIFY-backed SSE invalidation) is
// orthogonal to the harness-scoping property under test here, and reliably
// throws "notifySyncInvalidate is not a function" specifically in the POOLED
// (PAPERCUSP_PGBOUNCER=1) describe.each iteration — reproduced deterministically
// with only the promote tests selected (no getAudit interaction), so it is a
// module-resolution artifact of this test file's mid-process DIRECT→POOLED env
// flip (production never flips PGBOUNCER on a live process), not a bug in the
// harnessTransaction/auditFeatureChange migration under test. auditFeatureChange's
// fire-and-forget call reaches it AFTER a real, unmocked DB write to
// harness_shared.feature_audit_consolidated (provisionSharedAuditTable below),
// so the write-correctness property this suite cares about stays fully exercised;
// only the downstream UI-refresh notification is stubbed, so it can never turn
// into an uncaught console.warn that vitest-fail-on-console flags as a failure.
vi.mock('../../../sync-sse', () => ({
  notifySyncInvalidate: vi.fn(async () => {}),
  stopInvalidationListener: vi.fn(async () => {}),
}));

import feature_views_routes from './feature-views';
import brainstorm_routes from './brainstorm';

type Route = { path: string; handler: (req: Request, ctx: unknown) => Promise<Response> };
const byPath = (routes: unknown[], path: string): Route => {
  const r = (routes as Route[]).find((x) => x.path === path);
  if (!r) throw new Error(`no route for ${path}`);
  return r;
};

const getAuditRoute = byPath(feature_views_routes, '/harness/:slug/features/:id/audit');
const promoteRoute = byPath(brainstorm_routes, '/harness/:slug/brainstorm/promote');

async function getAudit(slug: string, id: string) {
  const req = new Request(`http://127.0.0.1/api/harness/${slug}/features/${id}/audit`);
  const res = await getAuditRoute.handler(req, { params: { slug, id } });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function promoteFeature(slug: string, content: string) {
  const req = new Request(`http://127.0.0.1/api/harness/${slug}/brainstorm/promote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: 'feature', content }),
  });
  const res = await promoteRoute.handler(req, { params: { slug } });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

let db: MigratedTestDb;
let obs: Sql;

const savedEnv = {
  url: process.env.HARNESS_DATABASE_URL,
  adminUrl: process.env.HARNESS_ADMIN_DATABASE_URL,
  pgbouncer: process.env.PAPERCUSP_PGBOUNCER,
};

async function provisionSchema(schema: string) {
  await obs.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  await obs.unsafe(`
    CREATE TABLE IF NOT EXISTS ${schema}.harness_features (
      feature_id text PRIMARY KEY,
      harness_slug text NOT NULL,
      title text,
      summary text,
      status text,
      attempts int,
      claims jsonb,
      notes text,
      metadata jsonb,
      kind text,
      project_id text,
      expected_cost_cents bigint,
      tags jsonb,
      needs_human_review boolean,
      ts bigint,
      created_ts bigint,
      updated_ts bigint
    )`);
  await obs.unsafe(`
    CREATE TABLE IF NOT EXISTS ${schema}.feature_audit (
      id serial PRIMARY KEY,
      harness_slug text NOT NULL,
      feature_id text NOT NULL,
      ts bigint,
      field text,
      old_value text,
      new_value text,
      actor text
    )`);
}

async function resetSchemas() {
  for (const schema of [SCHEMA_A, SCHEMA_B]) {
    await obs.unsafe(`TRUNCATE ${schema}.harness_features, ${schema}.feature_audit`);
  }
  await obs.unsafe(`TRUNCATE harness_shared.feature_audit_consolidated`);
}

// brainstorm.ts's promote handler fire-and-forget-audits every mutation via
// auditFeatureChange() (feature-audit.ts), which writes to
// harness_shared.feature_audit_consolidated through the ADMIN pool
// (getOrgPg(), now pointed at this fresh test db via HARNESS_ADMIN_DATABASE_URL
// below) — provision the real shared-schema table so that best-effort insert
// succeeds against THIS isolated db instead of either erroring (console.warn,
// which vitest-fail-on-console turns into a failure) or, pre-fix, silently
// writing test rows into the real box's live Postgres.
async function provisionSharedAuditTable() {
  await obs.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_shared`);
  await obs.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.feature_audit_consolidated (
      id bigserial PRIMARY KEY,
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      feature_id text NOT NULL,
      ts bigint NOT NULL,
      field text NOT NULL,
      old_value text,
      new_value text,
      actor text
    )`);
}

beforeAll(async () => {
  db = await createFreshTestDb({ prefix: 'fvbp' });
  process.env.HARNESS_DATABASE_URL = db.url;
  process.env.HARNESS_ADMIN_DATABASE_URL = db.url;
  process.env.PAPERCUSP_PGBOUNCER = '0';
  _resetUrlCacheForTests();
  await _resetForTests();

  obs = postgres(db.url, { max: 1, onnotice: () => {} });
  await provisionSchema(SCHEMA_A);
  await provisionSchema(SCHEMA_B);
  await provisionSharedAuditTable();
}, 120_000);

afterEach(async () => {
  await resetSchemas();
});

afterAll(async () => {
  await _resetForTests().catch(() => {});
  await obs?.end({ timeout: 5 }).catch(() => {});
  await db?.drop().catch(() => {});
  if (savedEnv.url === undefined) delete process.env.HARNESS_DATABASE_URL;
  else process.env.HARNESS_DATABASE_URL = savedEnv.url;
  if (savedEnv.adminUrl === undefined) delete process.env.HARNESS_ADMIN_DATABASE_URL;
  else process.env.HARNESS_ADMIN_DATABASE_URL = savedEnv.adminUrl;
  if (savedEnv.pgbouncer === undefined) delete process.env.PAPERCUSP_PGBOUNCER;
  else process.env.PAPERCUSP_PGBOUNCER = savedEnv.pgbouncer;
  _resetUrlCacheForTests();
});

describe.each([
  ['DIRECT', '0'],
  ['POOLED', '1'],
] as const)('%s mode', (_label, pgbouncer) => {
  beforeAll(async () => {
    process.env.PAPERCUSP_PGBOUNCER = pgbouncer;
    await _resetForTests();
  });
  afterAll(async () => {
    process.env.PAPERCUSP_PGBOUNCER = '0';
    await _resetForTests();
  });

  describe('getAudit (feature-views.ts, per-harness fallback)', () => {
    it('returns only the target harness schema\'s audit rows, leaving a sibling harness\'s same-id rows unseen', async () => {
      await obs.unsafe(`
        INSERT INTO ${SCHEMA_A}.feature_audit (harness_slug, feature_id, ts, field, old_value, new_value, actor)
        VALUES ('${SLUG_A}', 'F-001', 1000, 'status', '"todo"', '"open"', 'agent-a')`);
      await obs.unsafe(`
        INSERT INTO ${SCHEMA_B}.feature_audit (harness_slug, feature_id, ts, field, old_value, new_value, actor)
        VALUES ('${SLUG_B}', 'F-001', 2000, 'status', '"todo"', '"closed"', 'agent-b')`);

      const { status, body } = await getAudit(SLUG_A, 'F-001');
      expect(status).toBe(200);
      expect(body.count).toBe(1);
      expect(body.audit).toMatchObject([{ actor: 'agent-a', new: 'open' }]);
    });

    it('returns an empty (not error) result for a harness/feature with no audit rows', async () => {
      const { status, body } = await getAudit(SLUG_B, 'F-none');
      expect(status).toBe(200);
      expect(body.count).toBe(0);
      expect(body.audit).toEqual([]);
    });
  });

  describe('promote (brainstorm.ts, target=feature)', () => {
    it('creates the F-IDEA row ONLY in the target harness schema, sibling harness untouched', async () => {
      const { status, body } = await promoteFeature(SLUG_A, 'A brand new idea\nsome more detail');
      expect(status).toBe(200);
      expect(body).toMatchObject({ ok: true, target: 'feature' });
      const id = (body as { id: string }).id;
      expect(id).toMatch(/^F-IDEA-\d+$/);

      const [rowA] = await obs.unsafe(
        `SELECT feature_id, title, notes, status, metadata FROM ${SCHEMA_A}.harness_features WHERE feature_id = '${id}'`,
      ) as unknown as Array<{ feature_id: string; title: string; notes: string; status: string; metadata: unknown }>;
      expect(rowA).toMatchObject({ feature_id: id, title: 'A brand new idea', notes: 'some more detail', status: 'todo' });
      expect(rowA.metadata).toMatchObject({ source: 'brainstorm' });

      const [{ n: sideB }] = await obs.unsafe(`SELECT count(*)::int AS n FROM ${SCHEMA_B}.harness_features`) as unknown as { n: number }[];
      expect(sideB).toBe(0); // sibling harness schema untouched — proves schema scoping
    });

    it('mints ids that never repeat across sibling harnesses of one workspace (scope-unique-identifiers P-005)', async () => {
      // The id used to be MAX(F-IDEA-n) + 1 over the target harness's own rows, so
      // a fresh harness B minted F-IDEA-001 while A already held F-IDEA-001 — the
      // same feature id under two harnesses of one workspace. Seed A's legacy
      // ids, then promote into both: no minted id may equal any existing one or
      // each other.
      await obs.unsafe(`
        INSERT INTO ${SCHEMA_A}.harness_features (feature_id, harness_slug, title, status, attempts, needs_human_review, ts, created_ts, updated_ts)
        VALUES ('F-IDEA-001', '${SLUG_A}', 'old idea 1', 'todo', 0, false, 1, 1, 1),
               ('F-IDEA-002', '${SLUG_A}', 'old idea 2', 'todo', 0, false, 1, 1, 1)`);

      const { body: bodyB } = await promoteFeature(SLUG_B, 'fresh idea in B');
      const { body: bodyA } = await promoteFeature(SLUG_A, 'third idea in A');
      const idB = (bodyB as { id: string }).id;
      const idA = (bodyA as { id: string }).id;
      expect(idB).toMatch(/^F-IDEA-\d+$/);
      expect(idA).toMatch(/^F-IDEA-\d+$/);
      expect(new Set(['F-IDEA-001', 'F-IDEA-002', idA, idB]).size).toBe(4);

      // Each row still lands in its own harness schema.
      const [{ n: inB }] = await obs.unsafe(
        `SELECT count(*)::int AS n FROM ${SCHEMA_B}.harness_features WHERE feature_id = '${idB}'`,
      ) as unknown as { n: number }[];
      const [{ n: inA }] = await obs.unsafe(
        `SELECT count(*)::int AS n FROM ${SCHEMA_A}.harness_features WHERE feature_id = '${idA}'`,
      ) as unknown as { n: number }[];
      expect(inB).toBe(1);
      expect(inA).toBe(1);
    });
  });
});
