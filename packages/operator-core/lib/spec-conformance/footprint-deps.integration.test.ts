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
import { configureLocks, locksHost, type LocksHost } from '@papercusp/locks';
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
const { reconcilePlanFootprint } = await import('./footprint');
const { ensureBootstrap, getTxPool, tryAcquire, _resetForTests } = await import('../agent-tools/locks/su-lock-store');
const { inWorkspaceTxn } = await import('../agent-tools/locks/in-workspace-txn');

const HARNESS = 'papercusp';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PLAN = `zzz-footprint-deps-${RUN}`;
const OWNER = 'su-footprint-deps-fixture';
const LOCK_DOMAIN = `footprint-claims-${RUN}`;
const activeClaims = [
  { id: `WI-footprint-active-${RUN}`, kind: 'feature', owner: `su-footprint-feature-${RUN}`, file: 'src/active-feature.ts' },
  { id: `EI-footprint-active-${RUN}`, kind: 'bug', owner: `su-footprint-issue-${RUN}`, file: 'src/active-issue.ts' },
];
const terminalClaims = [
  { id: `WI-footprint-done-${RUN}`, kind: 'feature', owner: `su-footprint-done-feature-${RUN}`, file: 'src/done-feature.ts' },
  { id: `EI-footprint-done-${RUN}`, kind: 'bug', owner: `su-footprint-done-issue-${RUN}`, file: 'src/done-issue.ts' },
];

let db: OrgTestDb;
let priorLocksHost: LocksHost | undefined;
let locksReady = false;

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
  // Reuse the real lock store against this fixture's PostgreSQL instance. Its
  // own side database and unique domain keep test claims out of product state.
  priorLocksHost = locksHost();
  await _resetForTests();
  configureLocks({ ...priorLocksHost, getAdminBaseUrl: () => db.adminDsn });
  await ensureBootstrap();
  locksReady = true;
  for (const row of [...activeClaims, ...terminalClaims]) {
    const done = terminalClaims.includes(row);
    await db.adminSql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, title, status, taken_by, source_plan_slug, payload)
      VALUES (${activeWorkspaceId()}, ${HARNESS}, ${row.id}, ${row.kind}, 'Footprint claim fixture',
              ${done ? 'done' : 'wip'}, ${row.owner}, ${PLAN},
              ${db.adminSql.json(done ? { completion: { filesChanged: [row.file, 17] } } : {})})`;
  }
  await db.adminSql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, item_kind, title, status, taken_by, source_plan_slug)
    VALUES (${activeWorkspaceId()}, ${HARNESS}, ${`WI-footprint-unassigned-${RUN}`}, 'feature',
            'Unassigned fixture', 'open', 'unassigned', ${PLAN})`;
  for (const row of [...activeClaims, ...terminalClaims,
    { owner: 'unassigned', file: 'src/unassigned.ts' },
    { owner: `su-footprint-unrelated-${RUN}`, file: 'src/unrelated.ts' }]) {
    const grant = await inWorkspaceTxn(LOCK_DOMAIN, row.owner, tx => tryAcquire(tx, {
      coordinationDomain: LOCK_DOMAIN, owner: row.owner, ownerLabel: row.owner,
      paths: [row.file], intent: 'footprint integration fixture', ttlSec: 1200,
    }), { paths: [row.file] });
    expect(grant.ok).toBe(true);
  }
}, 180_000);

afterAll(async () => {
  try {
    if (locksReady) await getTxPool()`DELETE FROM agent_file_locks WHERE coordination_domain = ${LOCK_DOMAIN}`;
  } finally {
    await _resetForTests();
    if (priorLocksHost) configureLocks(priorLocksHost);
    await db?.cleanup();
  }
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

  it('readPlanCoverage reads both feature and issue completion files from the physical claim ledger', async () => {
    const coverage = await deps().readPlanCoverage();
    for (const row of terminalClaims) {
      expect(coverage.filesChanged.find(item => item.workItemId === row.id)?.paths).toEqual([row.file]);
    }
  });

  it('readPlanCoverage includes active feature and issue locks while excluding terminal and unassigned owners', async () => {
    const coverage = await deps().readPlanCoverage();
    expect(coverage.heldLocks).toHaveLength(activeClaims.length);
    expect(coverage.heldLocks).toEqual(expect.arrayContaining(activeClaims.map(row => ({
      path: row.file, ownerId: row.owner, workItemId: row.id,
    }))));
  });

  it('readPlanCoverage distinguishes a missing plan from a database projection failure', async () => {
    const missing = createFootprintDeps({ workspaceId: activeWorkspaceId(), harnessSlug: HARNESS, planSlug: `${PLAN}-missing` });
    await expect(missing.readPlanCoverage()).resolves.toEqual({ filesChanged: [], heldLocks: [] });
  });

  it('reconciles a declared footprint through real completion and active-lock coverage for both families', async () => {
    const sha = 'a'.repeat(40);
    const paths = [...activeClaims, ...terminalClaims].map(row => row.file);
    const outcome = await reconcilePlanFootprint({
      planSlug: PLAN, harnessSlug: HARNESS, sinceSha: null,
      planContent: '## Conformance\n\n```conformance\n{"footprint":{"paths":["src/**"]}}\n```\n',
    }, {
      ...deps(),
      // The commit window is deterministic; coverage and lock reads are real.
      listCommitsSince: async () => ({ headSha: sha, commits: [{ sha, paths }] }),
    });
    expect(outcome).toMatchObject({
      ok: true, declared: true, commitsScanned: 1, uncovered: [], finding: { action: 'none', id: null },
      covered: expect.arrayContaining([
        ...terminalClaims.map(row => ({ path: row.file, by: { kind: 'filesChanged', workItemId: row.id } })),
        ...activeClaims.map(row => ({ path: row.file, by: { kind: 'lock', workItemId: row.id, ownerId: row.owner } })),
      ]),
    });
    expect(outcome).toHaveProperty('covered.length', paths.length);
  });
});
