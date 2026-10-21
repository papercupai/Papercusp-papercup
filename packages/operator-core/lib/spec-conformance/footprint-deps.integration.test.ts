/**
 * WI-6554700010019387: the footprint deps read `harness_shared.harness_plans` by its real key
 * (`plan_slug`). Both queries once filtered on a nonexistent `slug` column, so every plan with a
 * declared `## Conformance` footprint failed each sweep with `column "slug" does not exist`.
 * These cases run the production queries against the fully migrated org schema, so a column
 * the schema does not have fails here instead of in the sweep.
 */
import { join } from 'node:path';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../test/_org-test-db';

const fixture = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
const REPO_ROOT = vi.hoisted(() => ({ path: '' }));

vi.mock('@papercusp/db-org', async (original) => ({
  ...(await original<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: fixture.sql }),
}));
vi.mock('../harness/docs/harness-repo', async (original) => ({
  ...(await original<typeof import('../harness/docs/harness-repo')>()),
  resolveHarnessRepoRoot: async () => REPO_ROOT.path,
}));

const { createOrgTestDb } = await import('../../test/_org-test-db');
const { activeWorkspaceId } = await import('../workspace-registry');
const { createFootprintDeps } = await import('./footprint-deps');

const HARNESS = 'papercusp';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PLAN = `zzz-footprint-deps-${RUN}`;
const OWNER = 'su-footprint-deps-fixture';

let db: OrgTestDb;

beforeAll(async () => {
  REPO_ROOT.path = join(__dirname, '..', '..', '..', '..');
  db = await createOrgTestDb();
  fixture.sql = db.adminSql;
  const content = `# Footprint deps fixture\n\n## Phase 1\n\n- **P-001** \`todo\` x.\n`;
  // created_at in the far future: commits "since" it are zero ONLY if this row is the one read.
  await db.adminSql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
       created, updated, owner, archived, template, origin,
       verification_profile, verification_profile_source, created_at)
    VALUES (${activeWorkspaceId()}, ${HARNESS}, ${PLAN}, ${content}, md5(${content}), 1,
            'Footprint deps fixture', 'active', '2026-10-21', '2026-10-21',
            ${OWNER}, false, NULL, 'local', 'general', 'declared', '2099-01-01T00:00:00Z')`;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('footprint deps read harness_plans by plan_slug (WI-6554700010019387)', () => {
  const deps = () => createFootprintDeps({ workspaceId: activeWorkspaceId(), harnessSlug: HARNESS, planSlug: PLAN });

  it('resolvePlanDriver returns the plan owner', async () => {
    await expect(deps().resolvePlanDriver()).resolves.toBe(OWNER);
  });

  it('resolvePlanDriver is null for a plan that does not exist', async () => {
    const missing = createFootprintDeps({ workspaceId: activeWorkspaceId(), harnessSlug: HARNESS, planSlug: `${PLAN}-missing` });
    await expect(missing.resolvePlanDriver()).resolves.toBeNull();
  });

  it('listCommitsSince(null) bounds the window by the plan created_at', async () => {
    const window = await deps().listCommitsSince(null);
    expect(window.headSha).toMatch(/^[0-9a-f]{40}$/);
    // A future created_at leaves no commit in range. Had the row not been found, the window
    // would fall back to the unbounded --max-count range and return real commits.
    expect(window.commits).toEqual([]);
  });
});
