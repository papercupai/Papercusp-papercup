/**
 * Completion field requirements per deliverable kind
 * (plan-verification-profiles-2026-10-17 R-13, P-004; D-009).
 *
 * work_items:complete owes tests-run evidence (`testsRun` / `testResult`) only for a CODE
 * deliverable. A close of a work item whose linked plan item resolves to a non-code
 * deliverable (the general profile's default, or a declared non-code kind) is not graded
 * down for omitting it. `verifiedHow` is still required: it says how the deliverable was
 * checked.
 *
 * Every case drives the real handler against a migrated private PostgreSQL. The plan rows
 * are the only fixture: the deliverable is resolved from them by the same reader complete.ts
 * uses, so changing the profile or the declared deliverable is the only variable.
 */
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../../../../test/_org-test-db';

const fixture = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (original) => ({
  ...await original<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: fixture.sql }),
  withWorkspace: async <T>(workspaceId: string, callback: (sql: postgres.Sql) => Promise<T>): Promise<T> =>
    fixture.sql.begin(async (transaction) => {
      await transaction`SELECT set_config('app.workspace_id', ${workspaceId}, true)`;
      return callback(transaction as unknown as postgres.Sql);
    }) as Promise<T>,
}));
// A fixture completion must not release this host's real edit locks.
vi.mock('../../../work-item-lock-release', () => ({
  releaseReclaimedWorkItemLocks: async () => ({ releases: [], failures: 0, skipped: null }),
}));

const { createOrgTestDb } = await import('../../../../test/_org-test-db');
const { activeWorkspaceId } = await import('../../../workspace-registry');
const { createWorkItem, getWorkItem } = await import('../../../work-items');
const { drainDetached } = await import('../../../detached-imports');
const { default: complete } = await import('../complete');

const OWNER = 'su-complete-deliverable-fields-fixture';
const HARNESS = 'papercusp';
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A close that says how the deliverable was checked but names no test run or result. */
const NO_TESTS_NOTE = {
  summary: 'Wrote the onboarding runbook and walked a reviewer through it.',
  verifiedHow: 'manual' as const,
  filesChanged: [],
};
// Reject fixture schema errors before allocating a database.
const closeTemplate = complete.args.parse({
  id: 'WI-123',
  harness: HARNESS,
  state: 'done',
  assumptions: 'none',
  completion: NO_TESTS_NOTE,
  changeKinds: ['no-code-change'],
  changeKindReason: 'deliverable-fields fixture close; the deliverable is a document',
});

type Result = {
  ok?: boolean;
  completionAuthority?: string;
  authorityWarning?: string;
  error?: unknown;
};

let db: OrgTestDb;
let planSeq = 0;

async function seedPlanItem(profile: 'coding' | 'general', deliverable: string | null): Promise<string> {
  planSeq += 1;
  const slug = `zzz-deliverable-fields-${RUN}-${planSeq}`;
  const content = `# Deliverable fields fixture ${planSeq}\n\n## Items\n\n- [ ] **P-001** Write the onboarding runbook.\n`;
  await db.adminSql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
       created, updated, owner, archived, template, origin,
       verification_profile, verification_profile_source)
    VALUES (${activeWorkspaceId()}, ${HARNESS}, ${slug}, ${content}, md5(${content}), 1,
            ${`Deliverable fields fixture ${planSeq}`}, 'active', '2026-10-20', '2026-10-20',
            ${OWNER}, false, NULL, 'local', ${profile}, 'declared')`;
  await db.adminSql`
    INSERT INTO harness_shared.plan_items
      (workspace_id, harness_slug, plan_slug, item_id, seq, item_text, status, deliverable)
    VALUES (${activeWorkspaceId()}, ${HARNESS}, ${slug}, 'P-001', 1, 'Write the onboarding runbook.',
            'wip', ${deliverable})`;
  return slug;
}

async function closeWithoutTests(planSlug: string): Promise<Result> {
  const item = await createWorkItem({
    kind: 'task',
    title: `Deliverable fields fixture for ${planSlug}`,
    harness: HARNESS,
    workspaceId: activeWorkspaceId(),
    createdBy: OWNER,
    assignee: OWNER,
    sourcePlanSlug: planSlug,
    sourcePlanItemIds: ['P-001'],
  });
  const args = structuredClone(closeTemplate);
  args.id = item.id;
  const response = await complete.handler(args as never, {
    uiClientId: OWNER,
    isSuperuser: true,
    workspaceId: activeWorkspaceId(),
    harnessSlug: HARNESS,
    runId: `complete-deliverable-fields-${RUN}`,
    log: () => {},
  } as never);
  await drainDetached();
  const result = (response as { data?: { results?: Result[] } }).data?.results?.[0];
  expect(result, JSON.stringify(response)).toBeDefined();
  // The stored row carries the same authority the reply reported.
  const stored = await getWorkItem(item.id, HARNESS);
  expect(stored?.state, JSON.stringify(result)).toBe('done');
  return result!;
}

/** The reply's explanation names the tests-run requirement. */
const ASKS_FOR_TESTS = /`testsRun`/;

beforeAll(async () => {
  db = await createOrgTestDb();
  fixture.sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  await drainDetached();
  await db?.cleanup();
});

describe('R-13: work_items:complete asks for tests-run evidence only on code deliverables', () => {
  it('accepts a close without testsRun when the linked item is a general plan default (non-code) deliverable', async () => {
    const result = await closeWithoutTests(await seedPlanItem('general', null));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.completionAuthority, JSON.stringify(result)).toBe('committed');
    expect(result.authorityWarning ?? '', JSON.stringify(result)).not.toMatch(ASKS_FOR_TESTS);
  });

  it('accepts a close without testsRun when the linked item declares a non-code deliverable on a coding plan', async () => {
    const result = await closeWithoutTests(await seedPlanItem('coding', 'doc'));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(result.completionAuthority, JSON.stringify(result)).toBe('committed');
    expect(result.authorityWarning ?? '', JSON.stringify(result)).not.toMatch(ASKS_FOR_TESTS);
  });

  it('control: the same close on a coding plan default (code) deliverable is graded down for the missing tests-run field', async () => {
    const result = await closeWithoutTests(await seedPlanItem('coding', null));
    expect(result.completionAuthority, JSON.stringify(result)).toBe('proposed');
    expect(result.authorityWarning ?? '', JSON.stringify(result)).toMatch(ASKS_FOR_TESTS);
  });

  it('control: a declared code deliverable on a general plan still owes tests-run evidence', async () => {
    const result = await closeWithoutTests(await seedPlanItem('general', 'code'));
    expect(result.completionAuthority, JSON.stringify(result)).toBe('proposed');
    expect(result.authorityWarning ?? '', JSON.stringify(result)).toMatch(ASKS_FOR_TESTS);
  });
});
