/**
 * plan-verification-profiles-2026-10-17 R-16 (P-006): rubrics:propose accepts an
 * acceptance rubric for the general plan class.
 *
 * Runs the real tool handler against real Postgres. The class rubric comes from the
 * bundled first-party library (rubrics/plan-class-general), seeded by the ordinary
 * lazy seed pass — nothing here inserts it by hand, so removing or renaming the bundled
 * rubric makes the general case refuse exactly like an unknown class.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';

const h = vi.hoisted(() => ({ sql: null as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...await orig<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../coordination/identity', async (orig) => ({
  ...await orig<typeof import('../coordination/identity')>(),
  resolveAgentIdentity: () => ({ ownerId: 'su-general-class-author' }),
}));

const { createOrgTestDb } = await import('../../../test/_org-test-db');
const { activeWorkspaceId } = await import('../../workspace-registry');
const { getRubric } = await import('../../rubrics');
const proposeTool = (await import('./propose')).default;
let db: Awaited<ReturnType<typeof createOrgTestDb>>;

async function insertSubjectPlan(slug: string): Promise<void> {
  await db.adminSql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
       created, updated, owner, archived, template, origin)
    VALUES (${activeWorkspaceId()}, 'papercusp', ${slug}, '# General plan', md5('# General plan'), 1,
            'General plan subject', 'active', '2026-10-20', '2026-10-20', 'su-test', false, NULL, 'local')`;
}

async function propose(rubricRef: string, subjectPlan: string, classRef: string) {
  return proposeTool.handler(
    {
      rubricRef,
      kind: 'acceptance',
      subjectPlan,
      classRef,
      characteristic: 'plan-acceptance',
      title: `Acceptance for ${subjectPlan}`,
      criteria: [],
    } as never,
    {} as never,
  );
}

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 180_000);
afterAll(async () => { await db?.cleanup(); });

describe('rubrics:propose with the general plan class', () => {
  it('accepts an acceptance rubric whose classRef is plan-class-general', async () => {
    await insertSubjectPlan('general-class-subject');

    await propose('acceptance-general-class-subject', 'general-class-subject', 'plan-class-general');

    const cls = await getRubric('plan-class-general');
    expect(cls?.kind).toBe('standard');
    expect(cls?.criteria.map((c) => c.key)).toContain('audit-citations-spot-checked');

    const stored = await getRubric('acceptance-general-class-subject');
    expect(stored).toMatchObject({ kind: 'acceptance', classRef: 'plan-class-general' });
    // A class-only acceptance rubric inherits the CLASS's scale — proof it bound to the general class.
    expect(stored?.ratingScale).toEqual(cls?.ratingScale);
    expect(stored?.ratingScale).toEqual(['pass', 'partial', 'fail', 'unknown']);
  });

  it('refuses a classRef that names no class rubric', async () => {
    await insertSubjectPlan('unknown-class-subject');

    await expect(propose('acceptance-unknown-class-subject', 'unknown-class-subject', 'plan-class-unknown'))
      .rejects.toThrow(/references classRef 'plan-class-unknown', but no rubric carries that id/);
    expect(await getRubric('acceptance-unknown-class-subject')).toBeNull();
  });
});
