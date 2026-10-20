/**
 * plan-verification-profiles-2026-10-17 R-16 (P-006): rubrics:propose accepts an
 * acceptance rubric for the general plan class.
 *
 * Runs the real tool handler against real Postgres. The class rubric comes from the
 * bundled first-party library (rubrics/plan-class-general), seeded by the ordinary
 * first-party seed pass (ensureFirstPartyRubricsSeeded, driven explicitly because the
 * lazy on-read hook is off under vitest). Nothing here inserts it by hand, so removing
 * or renaming the bundled rubric makes the general case refuse exactly like an unknown class.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { SpecClauseRevision } from '../plans/spec-clauses-store';

const h = vi.hoisted(() => ({
  sql: null as unknown as postgres.Sql,
  appSql: null as unknown as postgres.Sql,
}));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...await orig<typeof import('@papercusp/db-org')>(),
  getOrgPg: () => ({ sql: h.sql }),
  // proposeRubric and the first-party seed both WRITE through withPlanLock → withWorkspace.
  // Without this mock those writes escape the testcontainer onto the real org PG (the
  // _org-test-db.ts pattern, as in rubrics-first-party-seed.integration.test.ts).
  withWorkspace: <T,>(ws: string, cb: (tx: unknown) => Promise<T>): Promise<T> =>
    h.appSql.begin(async (tx) => {
      await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
      return cb(tx);
    }) as Promise<T>,
}));
vi.mock('../coordination/identity', async (orig) => ({
  ...await orig<typeof import('../coordination/identity')>(),
  resolveAgentIdentity: () => ({ ownerId: 'su-general-class-author' }),
}));

const { createOrgTestDb } = await import('../../../test/_org-test-db');
const { activeWorkspaceId } = await import('../../workspace-registry');
const { getRubric, ensureFirstPartyRubricsSeeded, __resetRubricSeedStateForTests } = await import('../../rubrics');
const proposeTool = (await import('./propose')).default;
const { evaluatePlanSpecQuality } = await import('../plans/spec-quality');
const { isPlanClassRubricRef } = await import('../../plan-class-refs');
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
  h.appSql = db.appSql;
  // In a real process the loadAllRubrics choke point seeds the bundled library on the
  // first read; under vitest that auto-hook is guarded off, so drive the ordinary seed
  // pass explicitly. It still reads the bundled rubrics/ dirs, so removing or renaming
  // rubrics/plan-class-general makes the general case refuse like an unknown class.
  __resetRubricSeedStateForTests();
  await ensureFirstPartyRubricsSeeded();
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

/**
 * plan-verification-profiles-2026-10-17 SPEC-P-006 (D-007): the general variant of
 * spec-quality lives in the plan-class-specialization branch of the evaluator. A general
 * plan's non-code deliverables are verified by generic citations, not test runs, so a
 * clause that declares no test layer must not fail the class fit. The class ref is read
 * back from the seeded store, so the evaluation runs against the class that actually
 * ships, not a hand-typed string.
 */
describe('spec-quality under the general plan class', () => {
  function noLayerClause(specId: string, planItemId: string): SpecClauseRevision {
    return {
      planSlug: 'general-quality-plan',
      specId,
      sourceValId: null,
      currentRevision: 1,
      revision: 1,
      planItemId,
      behavior: 'The quarterly vendor review report lists every active vendor with its renewal date.',
      behaviorClass: 'happy-path',
      requiredEvidence: [],
      requiredTestLayers: [],
      mutationRequired: false,
      lifecycleStatus: 'active',
      supersedes: null,
      exemption: null,
      falsifier: null,
      contentHash: `sha256:${specId}`,
      createdBy: 'author',
      createdAt: '2026-10-20T00:00:00.000Z',
      acceptedBy: 'reviewer',
      acceptedAt: '2026-10-20T00:01:00.000Z',
      acceptanceRef: 'D-001',
    };
  }

  it('passes plan-class-specialization for a clause that declares no test layer', async () => {
    const cls = await getRubric('plan-class-general');
    expect(cls?.kind).toBe('standard');
    const classRef = cls?.rubricId;
    expect(isPlanClassRubricRef(classRef)).toBe(true);
    if (!isPlanClassRubricRef(classRef)) throw new Error('seeded general class is not a plan class ref');

    const clause = noLayerClause('SPEC-GENERAL-P-001', 'P-001');
    expect(clause.requiredTestLayers).toEqual([]);
    const result = evaluatePlanSpecQuality({
      planSlug: 'general-quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [clause],
      classRef,
    });

    expect(result.ratings['plan-class-specialization']).toMatchObject({ rating: 'pass' });
    expect(result.ratings['plan-class-specialization'].evidence).toContain('no test layer is required of a general plan');
    expect(result.wouldBlock).not.toContain('plan-class-specialization');
  });

  it('still fails plan-class-specialization when the general plan has no active clause and no exemption', async () => {
    const result = evaluatePlanSpecQuality({
      planSlug: 'general-quality-plan',
      harnessSlug: 'papercusp',
      planItemIds: ['P-001'],
      clauses: [],
      classRef: 'plan-class-general',
    });

    expect(result.ratings['plan-class-specialization']).toMatchObject({ rating: 'fail' });
  });
});
