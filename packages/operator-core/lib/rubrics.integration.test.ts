/**
 * rubrics.integration.test.ts — the PLANS-BACKED rubrics store end-to-end against the
 * real migrated Postgres (plan-templates-and-rubric-v2-2026-06-20 P-006/P-007).
 *
 * v2: a RUBRIC IS A PLAN. The store reads/writes `template: rubric` plans
 * (harness_shared.harness_plans), NOT the dropped v1 standalone table. This suite drives
 * the full surface over the real schema (createOrgTestDb applies the whole migration set,
 * so withPlanLock's content + template_data writes hit the production column layout):
 *   • READS — a rubric-template plan resolves as a Rubric; template_data (incl. a
 *     per-criterion ratingScale override) round-trips; plan status → rubric status; an
 *     instance plan (template_slug) is excluded; a malformed plan degrades (skipped);
 *   • WRITES — proposeRubric authors a draft (proposed) rubric-template plan; ratifyRubric
 *     promotes it active; status:'active' authors a ratified rubric directly; re-propose
 *     is an idempotent upsert (no duplicate PK row);
 *   • list/get/search over the plan rows (active-first ordering, status/characteristic
 *     filters, in-process token search).
 *
 * Docker-gated (`*.integration.test.ts`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';
import { runWithWorkspace } from './workspace-als';
import { activeWorkspaceId } from './workspace-registry';
import { OrgTxnTimeoutError } from './pg-bounded-txn';
import { PLAN_ADVISORY_LOCK_NAMESPACE, planAdvisoryLockKey } from './agent-tools/plans/plan-lock-key';
import { hashPlanContent } from './agent-tools/plans/content-hash';
import { listLocalRubrics } from './cupboard/rubric-store';
import setTemplateDataTool from './agent-tools/plans/set-template-data';

const h = vi.hoisted(() => ({
  sql: undefined as unknown as postgres.Sql,
  shortIdleTimeoutMs: undefined as number | undefined,
  coveredWorkItemLookups: undefined as string[] | undefined,
}));

const MAX_BOUNDED_LOCK_BUSY_RETRIES = 2;
const retryBoundedLockBusy = async <T>(operation: () => Promise<T>): Promise<T> => {
  let retries = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (
        !(error instanceof OrgTxnTimeoutError) ||
        error.timeoutSource !== 'pg' ||
        error.pgCode !== '55P03' ||
        retries >= MAX_BOUNDED_LOCK_BUSY_RETRIES
      ) {
        throw error;
      }
      retries += 1;
      await new Promise((resolve) => setTimeout(resolve, 20 * retries));
    }
  }
};

// The re-pointed writes go through withPlanLock → withWorkspace; the reads through
// getOrgPg. Mock BOTH onto the migrated throwaway DB's admin (RLS-bypass) client — the
// withPlanLock advisory xact-lock needs a real transaction, which `.begin` provides.
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: async <T>(ws: string, cb: (tx: postgres.Sql) => Promise<T> | T): Promise<T> =>
      h.sql.begin(async (tx) => {
        await tx`SELECT set_config('app.workspace_id', ${ws}, true)`;
        if (h.shortIdleTimeoutMs !== undefined) {
          await tx`SELECT set_config('idle_in_transaction_session_timeout', ${`${h.shortIdleTimeoutMs}ms`}, true)`;
        }
        const measuredTx = new Proxy(tx, {
          apply(target, thisArg, args) {
            const query = Array.isArray(args[0]) ? args[0].join('') : '';
            if (h.coveredWorkItemLookups && query.includes('SELECT w.feature_id AS work_item_id') &&
                query.includes('w.source_plan_item_ids')) {
              h.coveredWorkItemLookups.push(String(args[4]));
            }
            return Reflect.apply(target, thisArg, args);
          },
        });
        return cb(measuredTx as unknown as postgres.Sql);
      }) as Promise<T>,
  };
});

const rubrics = await import('./rubrics');
const { createOrgTestDb } = await import('../test/_org-test-db');

let db: OrgTestDb;

const sampleCriteria = [
  {
    key: 'placement-health',
    title: 'Placement health',
    model: 'The Queen places every ready, unblocked frontier item onto a live bee within a cadence.',
    method: 'Count ready work_items with no claim older than the cadence; check fleet:assignments load balance.',
    driftMarkers: 'A growing backlog of ready-but-unplaced items; bees idle while the frontier is non-empty.',
  },
  {
    key: 'ideation-diversity',
    title: 'Ideation diversity',
    model: 'Scout lens weights drift away from uniform as grades steer ideation.',
    method: 'Inspect lens_weights; off-uniform 0.25 means grades are steering.',
    ratingScale: ['healthy', 'degraded', 'broken', 'unknown', 'n/a'], // per-criterion override
    driftMarkers: 'Lens weights stuck uniform; repeated near-identical ideas.',
  },
];

// Permanent tier-1 mutation control (CLAUDE.md): this is the deliberately WRONG,
// pre-EI-21296891484659125 status resolver. It calibrates against a brand-new acceptance
// rubric below, then stays `active` after retirement so the real writer's preservation
// assertion demonstrably distinguishes the guarded path without mutating production code.
const deliberatelyUnguardedAcceptanceProposeStatus = (
  explicit?: 'proposed' | 'active' | 'retired',
): 'proposed' | 'active' | 'retired' => explicit ?? 'active';

const rubricData = {
  characteristic: 'hive-coordination',
  criteria: [
    {
      key: 'placement-health',
      title: 'Placement health',
      model: 'The Queen places ready frontier items onto live bees within a cadence.',
      method: 'Count ready work_items with no claim older than the cadence.',
      driftMarkers: 'A growing backlog of ready-but-unplaced items.',
      ratingScale: ['healthy', 'degraded', 'broken', 'unknown', 'n/a'],
    },
  ],
  ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
  methodRef: 'pot-coordination-health-runbook',
  description: 'How well the loop is turning.',
};

/** Insert a rubric-template plan row directly (admin/bypass) — the read leg's input,
 *  for read-path edge cases that the write path can't author (malformed data, an
 *  instance plan, a specific status). Provides the NOT-NULL plan columns minimally.
 *  Defaults the workspace to activeWorkspaceId() — the SAME scope the store reads from
 *  (rubricsScopeWorkspace, WI-976) — so seed + read stay symmetric on any env (a
 *  hardcoded 'default' here would mismatch the store's active-workspace scope). Pass an
 *  explicit workspaceId to exercise cross-workspace scoping. */
async function insertRubricPlan(
  slug: string,
  opts: {
    status?: string;
    data?: unknown;
    title?: string;
    templateSlug?: string | null;
    archived?: boolean;
    workspaceId?: string;
    version?: number;
  } = {},
) {
  await db.adminSql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
       created, updated, owner, archived, template, template_data, template_slug, origin)
    VALUES (${opts.workspaceId ?? activeWorkspaceId()}, 'papercusp', ${slug}, '', md5(${slug}), ${opts.version ?? 1}, ${opts.title ?? slug},
            ${opts.status ?? 'active'}, '2026-06-20', '2026-06-20', 'queen-1', ${opts.archived ?? false},
            'rubric', ${JSON.stringify(opts.data ?? rubricData)}::text::jsonb, ${opts.templateSlug ?? null}, 'local')`;
}

async function withPlanRevisionInsertFailure<T>(
  planSlug: string,
  run: () => Promise<T>,
  onlyRubricRevision?: number,
): Promise<T> {
  if (!/^[a-z0-9-]+$/.test(planSlug)) throw new Error(`unsafe test plan slug: ${planSlug}`);
  if (onlyRubricRevision !== undefined && !Number.isSafeInteger(onlyRubricRevision)) {
    throw new Error('unsafe test rubric revision');
  }
  const suffix = Math.random().toString(36).slice(2, 10);
  const functionName = `rubric_revision_failure_${suffix}`;
  const triggerName = `${functionName}_trigger`;
  try {
    await db.adminSql.unsafe(`
      CREATE FUNCTION harness_shared.${functionName}() RETURNS trigger
      LANGUAGE plpgsql AS $revision_failure$
      BEGIN
        IF NEW.plan_slug = '${planSlug}' ${onlyRubricRevision === undefined ? ''
          : `AND position('"rubricRevision": ${onlyRubricRevision},' in NEW.content_snapshot) > 0`} THEN
          RAISE EXCEPTION 'injected plan_revisions insert failure';
        END IF;
        RETURN NEW;
      END;
      $revision_failure$`);
    await db.adminSql.unsafe(`
      CREATE TRIGGER ${triggerName} BEFORE INSERT ON harness_shared.plan_revisions
      FOR EACH ROW EXECUTE FUNCTION harness_shared.${functionName}()`);
    return await run();
  } finally {
    await db.adminSql.unsafe(`DROP TRIGGER IF EXISTS ${triggerName} ON harness_shared.plan_revisions`);
    await db.adminSql.unsafe(`DROP FUNCTION IF EXISTS harness_shared.${functionName}()`);
  }
}

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  // Wipe the migration-seeded rubric plan (mig 338) + any prior test rows so each
  // case asserts against a clean rubric set. CASCADE: plan_items/plan_decisions
  // (and any future table) hold FKs into harness_plans, and a bare TRUNCATE of a
  // referenced table is refused by Postgres (WI-39618).
  await db.adminSql`TRUNCATE harness_shared.harness_plans CASCADE`;
});

describe('reads — a rubric-template plan resolves as a Rubric', () => {
  it('getRubric resolves a rubric-template plan; template_data + per-criterion scale round-trip', async () => {
    await insertRubricPlan('queen-placement-health');
    const r = await rubrics.getRubric('queen-placement-health');
    expect(r).not.toBeNull();
    expect(r!.rubricId).toBe('queen-placement-health');
    expect(r!.characteristic).toBe('hive-coordination');
    expect(r!.status).toBe('active'); // plan status 'active' → rubric 'active'
    expect(r!.criteria).toHaveLength(1);
    expect(r!.criteria[0].key).toBe('placement-health');
    expect(r!.criteria[0].ratingScale).toContain('n/a');
    expect(r!.methodRef).toBe('pot-coordination-health-runbook');
  });

  it('resolves an explicit id before the capped shared-library scan', async () => {
    await insertRubricPlan('direct-id-fast-path');
    const originalSql = h.sql;
    const statements: string[] = [];
    const observe = (client: postgres.Sql): postgres.Sql => new Proxy(client, {
      apply(target, thisArg, args) {
        const statement = (args[0] as TemplateStringsArray).join(' ');
        if (statement.includes('FROM harness_shared.harness_plans')) statements.push(statement);
        return Reflect.apply(target, thisArg, args);
      },
    });
    // Preserve the native SQL surface and observe the REAL bounded transaction.
    // A bare callable drops .begin and makes the production read fail closed.
    h.sql = new Proxy(originalSql, {
      get(target, property, receiver) {
        if (property !== 'begin') return Reflect.get(target, property, receiver);
        return (run: (tx: postgres.Sql) => Promise<unknown>) =>
          target.begin((tx) => run(observe(tx as unknown as postgres.Sql)));
      },
    });
    try {
      const rubric = await rubrics.getRubric('direct-id-fast-path');
      expect(rubric?.rubricId).toBe('direct-id-fast-path');
      expect(statements).toHaveLength(1);
      expect(statements[0]).toContain('plan_slug =');
      // Still a point read, not the library scan. LIMIT 2 (not 1) so a slug held by two
      // harnesses is observable and refused (WI-6554700010008395).
      expect(statements[0]).toContain('LIMIT 2');
      expect(statements[0]).not.toContain('LIMIT 500');
    } finally {
      h.sql = originalSql;
    }
  });

  it('projects harness_plans.version as revision across every rubric read path', async () => {
    await insertRubricPlan('versioned-standard', { version: 7 });
    await insertRubricPlan('versioned-plan-acceptance', {
      version: 11,
      data: {
        ...rubricData,
        kind: 'acceptance',
        subjectPlan: 'subject-plan-for-versioned-acceptance',
      },
    });
    await insertRubricPlan('versioned-goal-acceptance', {
      version: 13,
      data: {
        ...rubricData,
        kind: 'acceptance',
        subjectGoal: 'goal-for-versioned-acceptance',
      },
    });

    expect((await rubrics.listRubrics({})).find((r) => r.rubricId === 'versioned-standard')?.revision).toBe(7);
    expect((await rubrics.getRubric('versioned-standard'))?.revision).toBe(7);
    expect((await rubrics.getRubric('versioned-plan-acceptance'))?.revision).toBe(11);
    expect((await rubrics.getAcceptanceRubricsForPlan('subject-plan-for-versioned-acceptance'))[0]?.revision).toBe(11);
    expect((await rubrics.getAcceptanceRubricForGoal('goal-for-versioned-acceptance'))?.revision).toBe(13);
  });

  it('class-only acceptance rubrics inherit the class scale and hash the live class revision', async () => {
    const subjectPlan = 'class-only-acceptance-subject';
    const classRef = 'class-only-acceptance-class';
    const classScale = ['pass', 'partial', 'fail', 'unknown'];

    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
         created, updated, owner, archived, template, origin)
      VALUES (${activeWorkspaceId()}, 'papercusp', ${subjectPlan}, '# Subject plan', md5('# Subject plan'), 1,
              'Class-only acceptance subject', 'active', '2026-09-04', '2026-09-04', 'su-test', false, NULL, 'local')`;
    await insertRubricPlan(classRef, {
      version: 7,
      data: { ...rubricData, ratingScale: classScale },
      title: 'Class-only acceptance class',
    });

    const acceptance = await rubrics.proposeRubric({
      rubricId: 'class-only-acceptance',
      kind: 'acceptance',
      subjectPlan,
      classRef,
      characteristic: 'plan-acceptance',
      title: 'Class-only acceptance',
      criteria: [],
      by: 'author-a',
    });

    expect(acceptance.ratingScale).toEqual(classScale);
    expect(acceptance.criteria).toEqual([]);
    const [stored] = await db.adminSql<{ template_data: { ratingScale: string[] } }[]>`
      SELECT template_data
        FROM harness_shared.harness_plans
       WHERE plan_slug = 'class-only-acceptance'
         AND template = 'rubric'`;
    expect(stored.template_data.ratingScale).toEqual(classScale);
    const [profile] = await db.adminSql<Array<{
      verification_profile: string | null;
      verification_profile_source: string | null;
    }>>`
      SELECT verification_profile, verification_profile_source
        FROM harness_shared.harness_plans
       WHERE plan_slug = 'class-only-acceptance' AND template = 'rubric'`;
    expect(profile?.verification_profile).toMatch(/^(coding|general)$/);
    expect(profile?.verification_profile_source).toBe('harness-default');

    const hashAtClassRevision7 = acceptance.criteriaHash;
    expect(hashAtClassRevision7).toEqual((await rubrics.getRubric('class-only-acceptance'))?.criteriaHash);

    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET version = 8, updated_at = now()
       WHERE plan_slug = ${classRef}
         AND template = 'rubric'`;
    const reread = await rubrics.getRubric('class-only-acceptance');
    expect(reread?.ratingScale).toEqual(classScale);
    expect(reread?.criteriaHash).not.toBe(hashAtClassRevision7);
  });

  it('does not fabricate a ratifier for active acceptance rubrics while preserving the standard legacy fallback', async () => {
    await insertRubricPlan('legacy-standard-rubric');
    await insertRubricPlan('plan-acceptance-rubric', {
      data: {
        ...rubricData,
        kind: 'acceptance',
        subjectPlan: 'subject-plan-for-acceptance',
      },
    });

    const standard = await rubrics.getRubric('legacy-standard-rubric');
    expect(standard?.kind).toBe('standard');
    expect(standard?.ratifiedBy).toBe('queen-1'); // legacy active standard row fallback

    const acceptance = await rubrics.getRubric('plan-acceptance-rubric');
    expect(acceptance?.kind).toBe('acceptance');
    expect(acceptance?.status).toBe('active');
    expect(acceptance?.ratifiedBy).toBeNull(); // acceptance rubrics are never ratified
  });

  it('listRubrics includes it; a draft plan maps to a proposed rubric', async () => {
    await insertRubricPlan('active-r', { status: 'active' });
    await insertRubricPlan('draft-r', { status: 'draft' });
    const all = await rubrics.listRubrics({});
    expect(all.map((r) => r.rubricId).sort()).toEqual(['active-r', 'draft-r']);
    expect((await rubrics.listRubrics({ status: 'active' })).map((r) => r.rubricId)).toEqual(['active-r']);
    expect((await rubrics.listRubrics({ status: 'proposed' })).map((r) => r.rubricId)).toEqual(['draft-r']);
  });

  it('searchRubrics finds a rubric-template plan by characteristic / title', async () => {
    await insertRubricPlan('queen-placement-health');
    expect((await rubrics.searchRubrics('coordination')).map((r) => r.rubricId)).toContain('queen-placement-health');
    expect(await rubrics.searchRubrics('zzznotarubric')).toEqual([]);
  });

  it('excludes per-run INSTANCE plans (template_slug IS NOT NULL)', async () => {
    await insertRubricPlan('an-instance', { templateSlug: 'some-template' });
    expect(await rubrics.getRubric('an-instance')).toBeNull();
    expect(await rubrics.listRubrics({})).toEqual([]);
  });

  it('degrades a malformed rubric-template plan to null (skipped, not surfaced broken)', async () => {
    await insertRubricPlan('broken-r', { data: { characteristic: 'x', criteria: [], ratingScale: [] } });
    expect(await rubrics.getRubric('broken-r')).toBeNull();
    expect(await rubrics.listRubrics({})).toEqual([]);
  });

  it('strict acceptance lookup distinguishes an unreadable existing rubric from absence', async () => {
    await insertRubricPlan('unreadable-acceptance', { data: {
      kind: 'acceptance', subjectPlan: 'unreadable-subject', subjectHarnessSlug: 'papercusp',
      characteristic: 'unreadable-subject', criteria: [], ratingScale: [],
    } });
    await expect(rubrics.getAcceptanceRubricsForPlan('unreadable-subject', { strict: true }))
      .rejects.toThrow('could not be decoded');
    await expect(rubrics.getAcceptanceRubricsForPlan('absent-subject', { strict: true }))
      .resolves.toEqual([]);
    await expect(rubrics.getAcceptanceRubricsForPlan('unreadable-subject')).resolves.toEqual([]);
  });

  it('strict acceptance lookup reports a forward-schema contract as unreadable rather than missing', async () => {
    const data = {
      ...rubricData,
      kind: 'acceptance', subjectPlan: 'forward-schema-subject', subjectHarnessSlug: 'papercusp',
      barSetHash: 'a'.repeat(64),
      barContract: {
        schemaVersion: 1, adoptionEpoch: 1, cohort: 'post-epoch', subjectPlanRevision: 1,
        seededAt: '2026-10-26T00:00:00.000Z', seededBy: 'newer-writer',
      },
    };
    await insertRubricPlan('forward-schema-acceptance', { data });
    // Establish a readable control, then vary only the known contract version.
    await expect(rubrics.getAcceptanceRubricsForPlan(data.subjectPlan, { strict: true }))
      .resolves.toEqual([expect.objectContaining({ rubricId: 'forward-schema-acceptance' })]);
    await db.adminSql`UPDATE harness_shared.harness_plans
      SET template_data = jsonb_set(template_data, '{barContract,schemaVersion}', '2'::jsonb)
      WHERE workspace_id=${activeWorkspaceId()} AND harness_slug='papercusp'
        AND plan_slug='forward-schema-acceptance'`;
    await expect(rubrics.getAcceptanceRubricsForPlan(data.subjectPlan, { strict: true }))
      .rejects.toThrow('could not be decoded');
    await expect(rubrics.getAcceptanceRubricsForPlan(data.subjectPlan)).resolves.toEqual([]);
    await expect(rubrics.getAcceptanceRubricsForPlan('absent-forward-schema-subject', { strict: true }))
      .resolves.toEqual([]);
  });
});

describe('rubric refs are workspace-unique — a slug held by two harnesses refuses (WI-6554700010008395)', () => {
  /** The PK is (workspace_id, harness_slug, plan_slug), so the schema admits this twin. */
  async function insertTwinInSecondHarness(slug: string) {
    await insertRubricPlan(slug);
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
         created, updated, owner, archived, template, template_data, template_slug, origin)
      VALUES (${activeWorkspaceId()}, 'zz-second-hive', ${slug}, '', md5(${slug}), 1, ${slug},
              'active', '2026-06-20', '2026-06-20', 'queen-1', false,
              'rubric', ${JSON.stringify(rubricData)}::text::jsonb, null, 'local')`;
  }

  it('getRubric and getRubricWithoutSeeding throw RubricRefAmbiguousError naming both harnesses', async () => {
    await insertTwinInSecondHarness('twin-rubric');
    for (const read of [rubrics.getRubric, rubrics.getRubricWithoutSeeding]) {
      const error = await read('twin-rubric').then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(rubrics.RubricRefAmbiguousError);
      expect((error as InstanceType<typeof rubrics.RubricRefAmbiguousError>).harnesses).toEqual([
        'papercusp',
        'zz-second-hive',
      ]);
    }
  });

  it('the revision read fails closed (ok:false), and a pinned-revision read throws', async () => {
    await insertTwinInSecondHarness('twin-rubric-rev');
    await expect(rubrics.readRubricPlanRevision('twin-rubric-rev')).resolves.toEqual({ ok: false, revision: null });
    await expect(rubrics.getRubric('twin-rubric-rev', 1)).rejects.toBeInstanceOf(rubrics.RubricRefAmbiguousError);
  });

  it('CONTROL: the same slug in ONE harness still resolves, so the refusal is about the twin', async () => {
    await insertRubricPlan('single-rubric');
    await expect(rubrics.getRubric('single-rubric')).resolves.toMatchObject({ rubricId: 'single-rubric' });
    await expect(rubrics.readRubricPlanRevision('single-rubric')).resolves.toEqual({ ok: true, revision: 1 });
  });
});

describe('writes — propose / ratify author + promote a rubric-template plan', () => {
  it('refuses to overwrite an ordinary plan whose slug collides with rubricId', async () => {
    const body = `---
title: Existing work plan
status: draft
created: 2026-08-26
updated: 2026-08-26
---

# Existing work plan

## Now

Preserve this plan body.
`;
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
         created, updated, owner, archived, template, origin)
      VALUES (${activeWorkspaceId()}, 'papercusp', 'colliding-work-plan', ${body}, md5(${body}), 1,
              'Existing work plan', 'draft', '2026-08-26', '2026-08-26', 'su-test', false, null, 'local')`;

    await expect(
      rubrics.proposeRubric({
        rubricId: 'colliding-work-plan',
        characteristic: 'acceptance',
        title: 'Would overwrite the plan',
        criteria: sampleCriteria,
        by: 'su-test',
      }),
    ).rejects.toThrow(/collides with an existing non-rubric plan/);

    const [preserved] = await db.adminSql<{ content: string; template: string | null; version: number }[]>`
      SELECT content, template, version
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${activeWorkspaceId()}
         AND harness_slug = 'papercusp'
         AND plan_slug = 'colliding-work-plan'`;
    expect(preserved).toEqual({ content: body, template: null, version: 1 });
  });

  it('propose creates a PROPOSED rubric (draft plan) with criteria + default rating scale', async () => {
    const r = await rubrics.proposeRubric({
      rubricId: 'pot-coordination-health',
      characteristic: 'hive-coordination',
      title: 'Hive coordination health',
      description: 'How well the placement/ideation/observation loop is turning.',
      criteria: sampleCriteria,
      methodRef: 'pot-coordination-health-runbook',
      by: 'su-test',
    });
    expect(r.status).toBe('proposed');
    expect(r.ratingScale).toEqual(['healthy', 'degraded', 'broken', 'unknown']);
    expect(r.criteria).toHaveLength(2);
    expect(r.criteria[0].key).toBe('placement-health');
    expect(r.criteria[1].ratingScale).toContain('n/a'); // per-criterion override round-trips
    expect(r.proposedBy).toBe('su-test'); // the plan owner
    expect(r.ratifiedBy).toBeNull(); // not yet active
    expect(r.methodRef).toBe('pot-coordination-health-runbook');
    // it lands as a queryable rubric-template plan, not a duplicate
    expect((await rubrics.listRubrics({})).map((x) => x.rubricId)).toEqual(['pot-coordination-health']);
  });

  it('guards normalized BAR projections on proposal and amendment while preserving unchanged legacy BARs', async () => {
    const subjectPlan = 'acceptance-bar-atomicity-subject';
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
         created, updated, owner, archived, template, origin)
      VALUES (${activeWorkspaceId()}, 'papercusp', ${subjectPlan}, '', md5(${subjectPlan}), 1,
              'Acceptance BAR atomicity subject', 'active', '2026-09-04', '2026-09-04', 'su-test', false, NULL, 'local')`;

    const criterion = (bar: string) => ({
      key: 'R-1',
      barKey: 'R-1',
      title: 'Request outcome',
      evidencePlane: 'tree' as const,
      // Deliberately author only the read alias. The writer must canonicalize it
      // to `model` before checking the exact behavior projected into AUTO-BAR.
      bar: `Request outcome. ${bar}`,
      method: 'Observe the request response at the public boundary.',
      driftMarkers: 'An accepted request does not produce the expected response.',
      check: { kind: 'instrument' as const, instrumentKey: 'none' },
    });
    const bundled = [criterion('A valid event is accepted and its payload is streamed.')];

    await expect(
      rubrics.proposeRubric({
        rubricId: 'non-atomic-bar-proposal',
        kind: 'acceptance',
        subjectPlan,
        characteristic: 'plan-acceptance',
        title: 'Non-atomic proposal',
        criteria: bundled,
        by: 'atomicity-author',
      }),
    ).rejects.toThrow('acceptance_bar_non_atomic_projection');
    expect(await rubrics.getRubric('non-atomic-bar-proposal')).toBeNull();

    const accepted = await rubrics.proposeRubric({
      rubricId: 'atomic-bar-amendment',
      kind: 'acceptance',
      subjectPlan,
      characteristic: 'plan-acceptance',
      title: 'Atomic BAR amendment',
      criteria: [criterion('A request is accepted.')],
      by: 'atomicity-author',
    });
    const priorRevision = accepted.revision;
    await expect(
      rubrics.amendRubric({
        rubricId: accepted.rubricId,
        criteria: bundled,
        by: 'atomicity-author',
      }),
    ).rejects.toThrow('acceptance_bar_non_atomic_projection');
    expect((await rubrics.getRubric(accepted.rubricId))?.revision).toBe(priorRevision);
    expect((await rubrics.getRubric(accepted.rubricId))?.criteria[0]?.model)
      .toBe('Request outcome. A request is accepted.');

    const legacySlug = 'unchanged-legacy-non-atomic-bar';
    const legacySubjectPlan = 'acceptance-bar-atomicity-legacy-subject';
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
         created, updated, owner, archived, template, origin)
      VALUES (${activeWorkspaceId()}, 'papercusp', ${legacySubjectPlan}, '', md5(${legacySubjectPlan}), 1,
              'Legacy acceptance BAR subject', 'active', '2026-09-04', '2026-09-04', 'su-test', false, NULL, 'local')`;
    const legacyBehavior = 'The request is accepted. Its payload is returned.';
    await insertRubricPlan(legacySlug, {
      data: {
        ...rubricData,
        kind: 'acceptance',
        subjectPlan: legacySubjectPlan,
        ratingScale: ['pass', 'fail', 'unknown'],
        criteria: [{
          key: 'legacy-outcome',
          title: 'Legacy outcome',
          model: legacyBehavior,
          method: 'Observe the stored response behavior.',
          driftMarkers: 'The request is not accepted or its payload is not returned.',
          check: { kind: 'instrument', instrumentKey: 'none' },
        }],
      },
    });
    const legacyBefore = (await rubrics.getRubric(legacySlug))!;
    const legacyAfter = await rubrics.proposeRubric({
      rubricId: legacySlug,
      kind: 'acceptance',
      subjectPlan: legacySubjectPlan,
      characteristic: legacyBefore.characteristic,
      title: legacyBefore.title,
      description: legacyBefore.description,
      criteria: legacyBefore.criteria,
      ratingScale: legacyBefore.ratingScale,
      methodRef: 'legacy-outcome-runbook',
      by: 'legacy-editor',
    });
    expect(legacyAfter.methodRef).toBe('legacy-outcome-runbook');
    expect(legacyAfter.criteria[0]?.model).toBe(legacyBehavior);
  });

  it('persists and reads normalized unpinned standard-rubric composition refs', async () => {
    const parent = await rubrics.proposeRubric({
      rubricId: 'composition-parent',
      characteristic: 'composition',
      title: 'Composition parent',
      criteria: sampleCriteria,
      status: 'active',
      by: 'parent-author',
    });
    expect(parent.status).toBe('active');

    const composed = await rubrics.proposeRubric({
      rubricId: 'composition-child',
      characteristic: 'composition',
      title: 'Composition child',
      criteria: sampleCriteria,
      composes: [' composition-parent ', 'composition-parent'],
      by: 'child-author',
    });
    expect(composed.composes).toEqual(['composition-parent']);

    const [stored] = await db.adminSql<{ template_data: { composes?: string[] } }[]>`
      SELECT template_data
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${activeWorkspaceId()}
         AND harness_slug = 'papercusp'
         AND plan_slug = 'composition-child'
         AND template = 'rubric'`;
    expect(stored.template_data.composes).toEqual(['composition-parent']);
    expect((await rubrics.getRubric('composition-child'))?.composes).toEqual(['composition-parent']);
  });

  it('validates composition targets live on propose and amend, preserving the prior edge on refusal', async () => {
    const validInput = {
      characteristic: 'composition-validation',
      title: 'Composition validation',
      criteria: sampleCriteria,
      by: 'composition-author',
    } as const;

    await expect(
      rubrics.proposeRubric({ rubricId: 'composition-dangling', ...validInput, composes: ['does-not-exist'] }),
    ).rejects.toThrow(/composes unknown rubric/i);
    expect(await rubrics.getRubric('composition-dangling')).toBeNull();

    await expect(
      rubrics.proposeRubric({ rubricId: 'composition-self', ...validInput, composes: ['composition-self'] }),
    ).rejects.toThrow(/cannot compose itself/i);
    expect(await rubrics.getRubric('composition-self')).toBeNull();

    const subjectPlan = 'composition-acceptance-subject';
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
         created, updated, owner, archived, template, template_data, template_slug, origin)
      VALUES (${activeWorkspaceId()}, 'papercusp', ${subjectPlan}, '', md5(${subjectPlan}), 1,
              'Composition acceptance subject', 'active', '2026-09-04', '2026-09-04', 'su-test',
              false, NULL, '{}'::text::jsonb, NULL, 'local')`;
    await rubrics.proposeRubric({
      rubricId: 'composition-acceptance-parent',
      kind: 'acceptance',
      subjectPlan,
      characteristic: 'composition-validation',
      title: 'Composition acceptance parent',
      criteria: [
        {
          key: 'outcome',
          title: 'Outcome',
          driftMarkers: 'the outcome regresses',
          check: { kind: 'instrument', instrumentKey: 'none' },
        },
      ],
      by: 'acceptance-author',
    });

    await expect(
      rubrics.proposeRubric({
        rubricId: 'composition-non-standard',
        ...validInput,
        composes: ['composition-acceptance-parent'],
      }),
    ).rejects.toThrow(/composes non-standard rubric/i);
    expect(await rubrics.getRubric('composition-non-standard')).toBeNull();

    await rubrics.proposeRubric({
      rubricId: 'composition-parent',
      characteristic: 'composition-validation',
      title: 'Composition parent',
      criteria: sampleCriteria,
      status: 'active',
      by: 'parent-author',
    });
    await rubrics.proposeRubric({
      rubricId: 'composition-amendment',
      ...validInput,
      composes: ['composition-parent'],
    });
    await expect(
      rubrics.amendRubric({
        rubricId: 'composition-amendment',
        composes: ['does-not-exist'],
        by: 'composition-author',
      }),
    ).rejects.toThrow(/composes unknown rubric/i);
    expect((await rubrics.getRubric('composition-amendment'))?.composes).toEqual(['composition-parent']);

    const amended = await rubrics.amendRubric({
      rubricId: 'composition-amendment',
      composes: [' composition-parent ', 'composition-parent'],
      by: 'composition-author',
    });
    expect(amended?.composes).toEqual(['composition-parent']);
  });

  it('ratify flips proposed → active and records the TRUE ratifier, not the author (EI-10751)', async () => {
    await rubrics.proposeRubric({
      rubricId: 'x',
      characteristic: 'c',
      title: 'X',
      criteria: sampleCriteria,
      by: 'author-a',
    });
    const active = await rubrics.ratifyRubric('x', 'queen-1');
    expect(active?.status).toBe('active');
    // The old projection collapsed ratifiedBy onto the plan owner — a fabricated
    // self-ratification record that made D-012 (author ≠ ratifier) unrecordable.
    expect(active?.ratifiedBy).toBe('queen-1');
    expect(active?.proposedBy).toBe('author-a');
    expect(active?.createdBy).toBe('author-a');
  });

  it('propose + ratify EACH record a plan_revisions audit row (EI-10443 — rubric writes were unauditable)', async () => {
    // Before EI-10443 the rubric write path went through withPlanLock with NO afterWrite,
    // so the plan revision spine had ZERO rows for every rubric plan — the destructive
    // loss-guard strip that filed this bug left no audit trail (couldn't be detected or
    // recovered via plans:revisions). propose then ratify must EACH append one revision,
    // attributed to the right actor, with the flip captured in the snapshot.
    await rubrics.proposeRubric({
      rubricId: 'audited-rubric',
      characteristic: 'hive-coordination',
      title: 'Audited',
      criteria: sampleCriteria,
      by: 'author-a',
    });
    const afterPropose = await db.adminSql<
      {
        seq: number;
        content_hash: string;
        author_id: string;
        author_kind: string;
        rationale: string | null;
        content_snapshot: string;
      }[]
    >`
      SELECT seq, content_hash, author_id, author_kind, rationale, content_snapshot
        FROM harness_shared.plan_revisions
       WHERE plan_slug = 'audited-rubric' ORDER BY seq ASC`;
    expect(afterPropose).toHaveLength(1); // the bug: this was 0
    expect(afterPropose[0].author_id).toBe('author-a'); // the proposer of record
    expect(afterPropose[0].author_kind).toBe('agent'); // a rubric write is an agent/Queen action
    expect(afterPropose[0].rationale).toContain('propose');
    expect(afterPropose[0].content_snapshot).toMatch(/status:\s*draft/); // proposed → draft plan
    // The markdown plan body intentionally keeps rubric fields in template_data;
    // the revision snapshot must nevertheless remain self-contained and retain
    // the criterion's grading prose for forensic comparison/recovery.
    expect(afterPropose[0].content_snapshot).toContain('Structured rubric data (`template_data`)');
    expect(afterPropose[0].content_snapshot).toContain(sampleCriteria[0].model);
    expect(afterPropose[0].content_snapshot).toContain(sampleCriteria[0].method);
    expect(afterPropose[0].content_snapshot).toContain(sampleCriteria[0].driftMarkers);
    expect(afterPropose[0].content_snapshot).toContain('"ratingScale"');
    const snapshotJson = afterPropose[0].content_snapshot.match(/~~~json\s*\n([\s\S]*?)\n~~~/)?.[1];
    expect(snapshotJson).toBeTruthy();
    const snapshot = JSON.parse(snapshotJson!) as {
      schemaVersion: number;
      templateData: { characteristic: string };
      criteriaHash: string;
    };
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.templateData.characteristic).toBe('hive-coordination');
    expect(snapshot.criteriaHash).toMatch(/^[a-f0-9]{64}$/);
    const [proposedPlan] = await db.adminSql<{ content_hash: string }[]>`
      SELECT content_hash FROM harness_shared.harness_plans WHERE plan_slug = 'audited-rubric'`;
    expect(afterPropose[0].content_hash).toBe(proposedPlan.content_hash); // canonical body hash, not enriched snapshot hash

    await rubrics.ratifyRubric('audited-rubric', 'queen-1');
    const afterRatify = await db.adminSql<
      { seq: number; content_hash: string; author_id: string; rationale: string | null; content_snapshot: string }[]
    >`
      SELECT seq, content_hash, author_id, rationale, content_snapshot
        FROM harness_shared.plan_revisions
       WHERE plan_slug = 'audited-rubric' ORDER BY seq ASC`;
    expect(afterRatify).toHaveLength(2); // a SECOND revision — the status-flip is now audited
    const ratifyRev = afterRatify[1];
    expect(ratifyRev.author_id).toBe('queen-1'); // the ratifier, not the author
    expect(ratifyRev.rationale).toContain('ratify');
    expect(ratifyRev.content_snapshot).toMatch(/status:\s*active/); // the destructive-class flip is captured
    expect(ratifyRev.content_snapshot).toContain(sampleCriteria[0].model); // structured prose survives the status flip
    const [activePlan] = await db.adminSql<{ content_hash: string }[]>`
      SELECT content_hash FROM harness_shared.harness_plans WHERE plan_slug = 'audited-rubric'`;
    expect(ratifyRev.content_hash).toBe(activePlan.content_hash);
  });

  it('rolls back a rubric plan write when its strict revision insert fails', async () => {
    const rubricId = 'strict-revision-failure-rubric';
    await expect(
      withPlanRevisionInsertFailure(rubricId, () => rubrics.proposeRubric({
        rubricId,
        characteristic: 'hive-coordination',
        title: 'Strict revision failure',
        criteria: sampleCriteria,
        by: 'failure-test',
      })),
    ).rejects.toThrow(/plan revision unavailable/);

    const plans = await db.adminSql`SELECT 1 FROM harness_shared.harness_plans WHERE plan_slug=${rubricId}`;
    const revisions = await db.adminSql`SELECT 1 FROM harness_shared.plan_revisions WHERE plan_slug=${rubricId}`;
    expect(plans).toHaveLength(0);
    expect(revisions).toHaveLength(0);
  });

  it('addresses committed rubric versions independently of the audit sequence', async () => {
    const rubricId = 'offset-standard-rubric';
    await insertRubricPlan(rubricId, { version: 7 });
    const proposed = await rubrics.proposeRubric({
      rubricId, characteristic: 'hive-coordination', title: 'Offset standard',
      criteria: sampleCriteria, by: 'author-a',
    });
    const [existingPlanProfile] = await db.adminSql<Array<{
      verification_profile: string | null;
      verification_profile_source: string | null;
    }>>`
      SELECT verification_profile, verification_profile_source
        FROM harness_shared.harness_plans
       WHERE plan_slug = ${rubricId} AND template = 'rubric'`;
    expect(existingPlanProfile).toEqual({ verification_profile: null, verification_profile_source: null });
    expect(proposed.revision).toBe(8);
    const ratified = await rubrics.ratifyRubric(rubricId, 'independent-reviewer');
    expect(ratified?.revision).toBe(9);
    const before = await db.adminSql<{ seq: number; content_snapshot: string }[]>`
      SELECT seq, content_snapshot FROM harness_shared.plan_revisions
       WHERE plan_slug = ${rubricId} ORDER BY seq`;
    expect(before.map((row) => row.seq)).toEqual([1, 2]);
    expect((await rubrics.getRubric(rubricId, 8))?.criteria).toEqual(proposed.criteria);
    expect((await rubrics.getRubric(rubricId, 9))?.criteriaHash).toBe(ratified?.criteriaHash);
    expect(await rubrics.getRubric(rubricId, 1)).toBeNull();

    const changed = sampleCriteria.map((criterion, i) => i === 0
      ? { ...criterion, method: 'A scoped gap review may find existing plans sufficient; no new-idea quota.' }
      : criterion);
    await rubrics.proposeRubric({
      rubricId, characteristic: 'hive-coordination', title: 'Offset standard',
      criteria: changed, by: 'author-a',
    });
    expect((await rubrics.getRubric(rubricId, 8))?.criteria).toEqual(proposed.criteria);
    expect((await rubrics.getRubric(rubricId, 9))?.criteriaHash).toBe(ratified?.criteriaHash);
    const preserved = await db.adminSql<{ seq: number; content_snapshot: string }[]>`
      SELECT seq, content_snapshot FROM harness_shared.plan_revisions
       WHERE plan_slug = ${rubricId} AND seq <= 2 ORDER BY seq`;
    expect(preserved).toEqual(before);
  });

  it('resolves only a proved current legacy snapshot when version and sequence diverge', async () => {
    const rubricId = 'legacy-offset-standard';
    const initial = await rubrics.proposeRubric({
      rubricId, characteristic: 'hive-coordination', title: 'Legacy offset',
      criteria: sampleCriteria, status: 'active', by: 'author-a',
    });
    // Simulate a pre-version-stamp enriched snapshot and an unrecorded version
    // bump. The body and structured data still have independent immutable proof.
    await db.adminSql`
      UPDATE harness_shared.plan_revisions
         SET content_snapshot = regexp_replace(content_snapshot, '\n  "rubricRevision": [0-9]+,', '', 'g')
       WHERE plan_slug = ${rubricId}`;
    await db.adminSql`UPDATE harness_shared.harness_plans SET version = 7 WHERE plan_slug = ${rubricId}`;
    const current = await rubrics.getRubric(rubricId, 7);
    expect(current?.criteriaHash).toBe(initial.criteriaHash);
    expect(current?.revision).toBe(7);
    // A legacy sequence number is not proof that this was rubric version 1.
    expect(await rubrics.getRubric(rubricId, 1)).toBeNull();
    // A matching markdown hash alone cannot prove structured grading content.
    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET template_data = jsonb_set(template_data, '{criteria,0,method}', '"Unrecorded new instructions"')
       WHERE plan_slug = ${rubricId}`;
    expect(await rubrics.getRubric(rubricId, 7)).toBeNull();
  });

  it.each(['propose', 'amend', 'ratify', 'retire'] as const)(
    'preserves a proved legacy rubric preimage when %s advances its version (EI-25394374042899729)',
    async (write) => {
      const rubricId = `legacy-preimage-${write}`;
      const initial = await rubrics.proposeRubric({
        rubricId, characteristic: 'hive-coordination', title: 'Legacy preimage',
        criteria: sampleCriteria, by: 'author-a',
      });
      await db.adminSql`
        UPDATE harness_shared.plan_revisions
           SET content_snapshot = regexp_replace(content_snapshot, '\n  "rubricRevision": [0-9]+,', '', 'g')
         WHERE plan_slug = ${rubricId}`;
      // The audit sequence is 1 while the authoritative plan version is 7.
      await db.adminSql`UPDATE harness_shared.harness_plans SET version = 7 WHERE plan_slug = ${rubricId}`;
      const before = await db.adminSql<{ seq: number; content_hash: string; content_snapshot: string }[]>`
        SELECT seq, content_hash, content_snapshot FROM harness_shared.plan_revisions
         WHERE plan_slug = ${rubricId} ORDER BY seq`;
      expect((await rubrics.getRubric(rubricId, 7))?.criteriaHash).toBe(initial.criteriaHash);
      expect(await rubrics.getRubric(rubricId, 1)).toBeNull();
      const changed = sampleCriteria.map((criterion, i) => i === 0
        ? { ...criterion, method: 'Changed grading procedure after the legacy contract.' }
        : criterion);
      if (write === 'propose') {
        await rubrics.proposeRubric({
          rubricId, characteristic: 'hive-coordination', title: 'Legacy preimage',
          criteria: changed, by: 'author-a',
        });
      } else if (write === 'amend') {
        await rubrics.amendRubric({
          rubricId, by: 'author-a',
          criterion: { key: sampleCriteria[0].key, field: 'method', mode: 'append', text: 'New procedure.' },
        });
      } else if (write === 'ratify') {
        await rubrics.ratifyRubric(rubricId, 'independent-reviewer');
      } else {
        await rubrics.retireRubric(rubricId, 'independent-reviewer', 'test retirement');
      }
      const historical = await rubrics.getRubric(rubricId, 7);
      expect(historical?.revision).toBe(7);
      expect(historical?.criteria).toEqual(initial.criteria);
      expect(historical?.criteriaHash).toBe(initial.criteriaHash);
      expect(await rubrics.getRubric(rubricId, 1)).toBeNull();
      const after = await db.adminSql<{ seq: number; content_hash: string; content_snapshot: string }[]>`
        SELECT seq, content_hash, content_snapshot FROM harness_shared.plan_revisions
         WHERE plan_slug = ${rubricId} ORDER BY seq`;
      expect(after.slice(0, before.length)).toEqual(before); // Append only; retain authentic raw evidence.
      expect(after.map((row) => rubrics.inspectRubricRevisionSnapshot(row.content_snapshot).rubricRevision))
        .toEqual([undefined, 7, 8]);
      expect(after[1]!.content_hash).toBe(before[0]!.content_hash);
      expect(rubrics.parseRubricRevisionTemplateData(after[1]!.content_snapshot))
        .toEqual(rubrics.parseRubricRevisionTemplateData(before[0]!.content_snapshot));
    },
  );

  it('rolls back legacy preimage capture and the advance when revision insertion fails', async () => {
    const rubricId = 'legacy-preimage-rollback';
    await rubrics.proposeRubric({
      rubricId, characteristic: 'hive-coordination', title: 'Legacy rollback',
      criteria: sampleCriteria, by: 'author-a',
    });
    await db.adminSql`
      UPDATE harness_shared.plan_revisions
         SET content_snapshot = regexp_replace(content_snapshot, '\n  "rubricRevision": [0-9]+,', '', 'g')
       WHERE plan_slug = ${rubricId}`;
    await db.adminSql`UPDATE harness_shared.harness_plans SET version = 7 WHERE plan_slug = ${rubricId}`;
    const before = await db.adminSql`SELECT * FROM harness_shared.harness_plans WHERE plan_slug = ${rubricId}`;
    const beforeRevisions = await db.adminSql`SELECT * FROM harness_shared.plan_revisions WHERE plan_slug = ${rubricId}`;
    // Fail the NEW version insert after the legacy preimage insert succeeded.
    await expect(withPlanRevisionInsertFailure(rubricId, () => rubrics.ratifyRubric(rubricId, 'reviewer'), 8))
      .rejects.toThrow(/plan revision unavailable/);
    expect(await db.adminSql`SELECT * FROM harness_shared.harness_plans WHERE plan_slug = ${rubricId}`)
      .toEqual(before);
    expect(await db.adminSql`SELECT * FROM harness_shared.plan_revisions WHERE plan_slug = ${rubricId}`)
      .toEqual(beforeRevisions);
    expect((await rubrics.getRubric(rubricId, 7))?.revision).toBe(7);
  });

  it.each(['structured-data', 'body-hash'] as const)(
    'does not bind an unproved legacy preimage after %s drift', async (drift) => {
      const rubricId = `legacy-unproved-${drift}`;
      await rubrics.proposeRubric({
        rubricId, characteristic: 'hive-coordination', title: 'Unproved legacy',
        criteria: sampleCriteria, by: 'author-a',
      });
      await db.adminSql`
        UPDATE harness_shared.plan_revisions
           SET content_snapshot = regexp_replace(content_snapshot, '\n  "rubricRevision": [0-9]+,', '', 'g')
         WHERE plan_slug = ${rubricId}`;
      await db.adminSql`UPDATE harness_shared.harness_plans SET version = 7 WHERE plan_slug = ${rubricId}`;
      if (drift === 'structured-data') {
        await db.adminSql`
          UPDATE harness_shared.harness_plans SET template_data =
            jsonb_set(template_data, '{criteria,0,method}', '"Unrecorded grading procedure"')
           WHERE plan_slug = ${rubricId}`;
      } else {
        await db.adminSql`
          UPDATE harness_shared.plan_revisions SET content_hash = 'unproved'
           WHERE plan_slug = ${rubricId}`;
      }
      expect(await rubrics.getRubric(rubricId, 7)).toBeNull();
      await rubrics.ratifyRubric(rubricId, 'independent-reviewer');
      expect(await rubrics.getRubric(rubricId, 7)).toBeNull();
      const rows = await db.adminSql<{ content_snapshot: string }[]>`
        SELECT content_snapshot FROM harness_shared.plan_revisions
         WHERE plan_slug = ${rubricId} ORDER BY seq`;
      expect(rows.map((row) => rubrics.inspectRubricRevisionSnapshot(row.content_snapshot).rubricRevision))
        .toEqual([undefined, 8]);
    },
  );

  it('does not infer legacy historical versions even when sequence counters align', async () => {
    const rubricId = 'aligned-legacy-standard';
    await rubrics.proposeRubric({
      rubricId, characteristic: 'hive-coordination', title: 'Legacy aligned',
      criteria: sampleCriteria, by: 'author-a',
    });
    const current = await rubrics.ratifyRubric(rubricId, 'independent-reviewer');
    await db.adminSql`
      UPDATE harness_shared.plan_revisions
         SET content_snapshot = regexp_replace(content_snapshot, '\n  "rubricRevision": [0-9]+,', '', 'g')
       WHERE plan_slug = ${rubricId}`;
    expect(await rubrics.getRubric(rubricId, 1)).toBeNull();
    expect((await rubrics.getRubric(rubricId, 2))?.criteriaHash).toBe(current?.criteriaHash);
  });

  it('backfills only the exact current non-first-party standard rubric version', async () => {
    const rubricId = 'legacy-current-standard-backfill';
    const write = (criteria: typeof sampleCriteria) => rubrics.proposeRubric({
      rubricId,
      characteristic: 'hive-coordination',
      title: 'Legacy current standard backfill',
      criteria,
      by: 'su-test',
    });
    await write(sampleCriteria);
    const changedCriteria = sampleCriteria.map((criterion, index) => index === 0
      ? { ...criterion, method: 'Read the current claim ledger and verify its owner.' }
      : criterion);
    const current = await write(changedCriteria);
    const currentRevision = Number(current.revision);
    expect(currentRevision).toBeGreaterThan(1);

    const [plan] = await db.adminSql<{ content: string; content_hash: string; owner: string; template_data: unknown }[]>`
      SELECT content, content_hash, owner, template_data
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp'
         AND plan_slug = ${rubricId}`;
    expect(plan!.owner).toBe('su-test');
    const priorRows = await db.adminSql<{
      id: number; seq: number; content_snapshot: string; content_hash: string; author_id: string;
    }[]>`
      SELECT id, seq, content_snapshot, content_hash, author_id
        FROM harness_shared.plan_revisions
       WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp'
         AND plan_slug = ${rubricId}
       ORDER BY seq ASC`;
    expect(priorRows.length).toBeGreaterThan(1);

    // Model the pre-snapshot history: immutable rows retain their hashes and
    // provenance, but their stored snapshots contain only rubric markdown.
    await db.adminSql`
      UPDATE harness_shared.plan_revisions
         SET content_snapshot = ${plan!.content}
       WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp'
         AND plan_slug = ${rubricId}`;
    const legacyRows = await db.adminSql<{
      id: number; seq: number; content_snapshot: string; content_hash: string; author_id: string;
    }[]>`
      SELECT id, seq, content_snapshot, content_hash, author_id
        FROM harness_shared.plan_revisions
       WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp'
         AND plan_slug = ${rubricId}
       ORDER BY seq ASC`;
    expect(legacyRows.every((row) => row.content_snapshot === plan!.content)).toBe(true);

    const scope = { workspaceId: activeWorkspaceId(), harnessSlug: 'papercusp' };
    const historical = await rubrics.repairLegacyRubricRevisionSnapshots(rubricId, scope, {
      dryRun: true,
      rubricRevision: currentRevision - 1,
    });
    expect(historical).toMatchObject({ status: 'not_eligible', currentRevision });

    const preview = await rubrics.repairLegacyRubricRevisionSnapshots(rubricId, scope, {
      dryRun: true,
      rubricRevision: currentRevision,
    });
    expect(preview).toMatchObject({ status: 'dry_run', currentRevision, revisionsToRepair: 1 });

    const identity = {
      ownerId: 'test-current-standard-rubric-backfill',
      ownerLabel: 'test-current-standard-rubric-backfill',
      source: 'static-client' as const,
      workspaceId: null,
      userId: null,
    };
    const applied = await rubrics.repairLegacyRubricRevisionSnapshots(rubricId, scope, {
      dryRun: false,
      rubricRevision: currentRevision,
      identity,
    });
    expect(applied).toMatchObject({ status: 'repaired', currentRevision, revisionsRepaired: 1 });

    const afterRows = await db.adminSql<{
      id: number; seq: number; content_snapshot: string; content_hash: string; author_id: string;
    }[]>`
      SELECT id, seq, content_snapshot, content_hash, author_id
        FROM harness_shared.plan_revisions
       WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp'
         AND plan_slug = ${rubricId}
       ORDER BY seq ASC`;
    expect(afterRows.slice(0, legacyRows.length)).toEqual(legacyRows);
    expect(afterRows).toHaveLength(legacyRows.length + 1);
    expect(afterRows.at(-1)!.content_snapshot).toContain(`"rubricRevision": ${currentRevision},`);
    expect((await rubrics.getRubric(rubricId, currentRevision))?.criteriaHash).toBe(current.criteriaHash);
    expect(await rubrics.getRubric(rubricId, currentRevision - 1)).toBeNull();
  });

  it('appends an exact current first-party snapshot without rewriting divergent history', async () => {
    rubrics.__resetRubricSeedStateForTests();
    try {
      const rubricId = 'fleet-execution-health';
      const source = listLocalRubrics().find(
        (candidate) => candidate.rubricId === rubricId && candidate.source === 'first-party',
      );
      if (!source) throw new Error(`bundled first-party rubric ${rubricId} is unavailable`);
      // Seed only the row under test; the global seed pass spans unrelated rubric content.
      await rubrics.provisionPinnedRubric(source, activeWorkspaceId());
      const [seeded] = await db.adminSql<{
        version: number;
        content: string;
        content_hash: string;
        owner: string;
        template: string;
        template_slug: string | null;
        archived: boolean;
        template_data: unknown;
      }[]>`
        SELECT version, content, content_hash, owner, template, template_slug, archived, template_data
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp'
           AND plan_slug = ${rubricId}`;
      expect(seeded).toBeDefined();
      const targetRevision = Number(seeded!.version) + 1;
      const updatedBody = `${seeded!.content}\n\n# Current-version backfill fixture\n`;
      const updatedHash = hashPlanContent(updatedBody);
      await db.adminSql`
        UPDATE harness_shared.harness_plans
           SET version = ${targetRevision}, content = ${updatedBody}, content_hash = ${updatedHash}
         WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp'
           AND plan_slug = ${rubricId}`;

      const scope = { workspaceId: activeWorkspaceId(), harnessSlug: 'papercusp' };
      const priorRows = await db.adminSql<{
        seq: number;
        content_hash: string;
        content_snapshot: string;
        author_id: string;
      }[]>`
        SELECT seq, content_hash, content_snapshot, author_id
          FROM harness_shared.plan_revisions
         WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp'
           AND plan_slug = ${rubricId}
         ORDER BY seq ASC`;
      expect(priorRows.length).toBeGreaterThan(0);

      const wholeChain = await rubrics.repairLegacyRubricRevisionSnapshots(rubricId, scope, { dryRun: true });
      expect(wholeChain).toMatchObject({ status: 'not_eligible', revisionsToRepair: 0 });

      const preview = await rubrics.repairLegacyRubricRevisionSnapshots(rubricId, scope, {
        dryRun: true,
        rubricRevision: targetRevision,
      });
      expect(preview).toMatchObject({
        status: 'dry_run',
        currentRevision: targetRevision,
        revisionsToRepair: 1,
        revisionsRepaired: 0,
      });
      const stillPrior = await db.adminSql<{ seq: number; content_snapshot: string; author_id: string }[]>`
        SELECT seq, content_snapshot, author_id
          FROM harness_shared.plan_revisions
         WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp'
           AND plan_slug = ${rubricId}
         ORDER BY seq ASC`;
      expect(stillPrior).toEqual(priorRows.map(({ seq, content_snapshot, author_id }) => ({ seq, content_snapshot, author_id })));

      const identity = {
        ownerId: 'test-current-rubric-backfill',
        ownerLabel: 'test-current-rubric-backfill',
        source: 'static-client' as const,
        workspaceId: null,
        userId: null,
      };
      const applied = await rubrics.repairLegacyRubricRevisionSnapshots(rubricId, scope, {
        dryRun: false,
        rubricRevision: targetRevision,
        identity,
      });
      expect(applied).toMatchObject({
        status: 'repaired',
        revisionsToRepair: 1,
        revisionsRepaired: 1,
      });
      expect(applied.revisionSeq).toBe(priorRows.at(-1)!.seq + 1);

      const afterRows = await db.adminSql<{
        seq: number;
        content_hash: string;
        content_snapshot: string;
        author_id: string;
      }[]>`
        SELECT seq, content_hash, content_snapshot, author_id
          FROM harness_shared.plan_revisions
         WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp'
           AND plan_slug = ${rubricId}
         ORDER BY seq ASC`;
      expect(afterRows.slice(0, priorRows.length)).toEqual(priorRows);
      expect(afterRows).toHaveLength(priorRows.length + 1);
      expect(afterRows.at(-1)).toMatchObject({
        seq: applied.revisionSeq,
        content_hash: updatedHash,
        author_id: identity.ownerId,
      });
      expect(afterRows.at(-1)!.content_snapshot).toContain(`"rubricRevision": ${targetRevision},`);
      expect((await rubrics.getRubric(rubricId, targetRevision))?.revision).toBe(targetRevision);

      const repeated = await rubrics.repairLegacyRubricRevisionSnapshots(rubricId, scope, {
        dryRun: false,
        rubricRevision: targetRevision,
        identity,
      });
      expect(repeated).toMatchObject({ status: 'already_repaired', revisionsRepaired: 0 });
      expect(await db.adminSql`SELECT id FROM harness_shared.plan_revisions WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp' AND plan_slug = ${rubricId}`)
        .toHaveLength(priorRows.length + 1);
    } finally {
      rubrics.__resetRubricSeedStateForTests();
    }
  });

  it('WI-10006335: a latest revision with no structured snapshot falls through to the backfill instead of throwing', async () => {
    rubrics.__resetRubricSeedStateForTests();
    const rubricId = 'fleet-execution-health';
    // The previous case backfills this same rubric, leaving a `"rubricRevision": N,`
    // marker that would claim this case's target revision and reject it early. Start
    // (and finish) from a never-provisioned rubric so the case is order-independent.
    const clearRubric = async () => {
      await db.adminSql`
        DELETE FROM harness_shared.plan_revisions
         WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp' AND plan_slug = ${rubricId}`;
      await db.adminSql`
        DELETE FROM harness_shared.harness_plans
         WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp' AND plan_slug = ${rubricId}`;
    };
    await clearRubric();
    try {
      const source = listLocalRubrics().find(
        (candidate) => candidate.rubricId === rubricId && candidate.source === 'first-party',
      );
      if (!source) throw new Error(`bundled first-party rubric ${rubricId} is unavailable`);
      await rubrics.provisionPinnedRubric(source, activeWorkspaceId());
      const [seeded] = await db.adminSql<{ version: number; content: string }[]>`
        SELECT version, content
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp'
           AND plan_slug = ${rubricId}`;
      expect(seeded).toBeDefined();
      const targetRevision = Number(seeded!.version) + 1;
      const updatedBody = `${seeded!.content}\n\n# Markdown-only latest revision fixture\n`;
      const updatedHash = hashPlanContent(updatedBody);
      await db.adminSql`
        UPDATE harness_shared.harness_plans
           SET version = ${targetRevision}, content = ${updatedBody}, content_hash = ${updatedHash}
         WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp'
           AND plan_slug = ${rubricId}`;
      // The LATEST revision carries the live content hash but no structured snapshot
      // (a legacy markdown-only row), so parseRubricRevisionSnapshot returns null for it.
      // The hash equality is what reaches the already-repaired comparison; before the
      // fix that comparison dereferenced the null parse and threw a TypeError.
      await db.adminSql`
        INSERT INTO harness_shared.plan_revisions
          (workspace_id, harness_slug, plan_slug, seq, content_hash, content_snapshot,
           rationale, author_kind, author_id, created_at)
        SELECT ${activeWorkspaceId()}, 'papercusp', ${rubricId}, COALESCE(MAX(seq), 0) + 1, ${updatedHash},
               '# markdown-only legacy rubric revision', 'test', 'agent', 'test', 1
          FROM harness_shared.plan_revisions
         WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp'
           AND plan_slug = ${rubricId}`;

      const scope = { workspaceId: activeWorkspaceId(), harnessSlug: 'papercusp' };
      const preview = await rubrics.repairLegacyRubricRevisionSnapshots(rubricId, scope, {
        dryRun: true,
        rubricRevision: targetRevision,
      });
      // An unparseable latest snapshot is not evidence of a prior repair.
      expect(preview.reason).toBeUndefined();
      expect(preview).toMatchObject({
        status: 'dry_run',
        currentRevision: targetRevision,
        revisionsToRepair: 1,
        revisionsRepaired: 0,
      });
    } finally {
      await clearRubric();
      rubrics.__resetRubricSeedStateForTests();
    }
  });

  it('reads an immutable historical rubric revision without falling back to current template_data', async () => {
    const rubricId = 'revision-addressed-rubric';
    await rubrics.proposeRubric({
      rubricId,
      characteristic: 'hive-coordination',
      title: 'Revision v1',
      criteria: sampleCriteria,
      status: 'active',
      by: 'author-a',
    });
    const v2Criteria = [
      ...sampleCriteria,
      {
        key: 'new-criterion',
        title: 'New criterion',
        model: 'The second revision carries an additional measurable contract.',
        method: 'Read the second revision snapshot and count this criterion.',
        driftMarkers: 'The criterion disappears from the current rubric.',
      },
    ];
    const current = await rubrics.proposeRubric({
      rubricId,
      characteristic: 'hive-coordination',
      title: 'Revision v2',
      criteria: v2Criteria,
      status: 'active',
      by: 'author-a',
    });

    expect(current.revision).toBe(2);
    const historical = await rubrics.getRubric(rubricId, 1);
    expect(historical).not.toBeNull();
    expect(historical!.revision).toBe(1);
    expect(historical!.title).toBe('Revision v2'); // current plan-row metadata is preserved
    expect(historical!.criteria).toHaveLength(sampleCriteria.length);
    expect(historical!.criteria.some((criterion) => criterion.key === 'new-criterion')).toBe(false);
    expect(historical!.criteriaHash).toBeTruthy();
    expect(historical!.criteriaHash).not.toBe(current.criteriaHash);
    expect(await rubrics.getRubric(rubricId, 99)).toBeNull();

    const [firstRevision] = await db.adminSql<{ content_snapshot: string }[]>`
      SELECT content_snapshot FROM harness_shared.plan_revisions
       WHERE plan_slug = ${rubricId} AND seq = 1`;
    const firstSnapshotJson = firstRevision.content_snapshot.match(/~~~json\s*\n([\s\S]*?)\n~~~/)?.[1];
    expect(firstSnapshotJson).toBeTruthy();
    const firstSnapshot = JSON.parse(firstSnapshotJson!) as { schemaVersion: number; criteriaHash: string };
    expect(firstSnapshot.schemaVersion).toBe(2);
    expect(historical!.criteriaHash).toBe(firstSnapshot.criteriaHash);

    // Simulate a revision written under an older hash algorithm: the structured
    // rubric is valid, but its pinned hash is deliberately different from the
    // current computation. Historical reads must honor the stored attestation.
    const [currentPlanRow] = await db.adminSql<{ template_data: Record<string, unknown> }[]>`
      SELECT template_data FROM harness_shared.harness_plans WHERE plan_slug = ${rubricId}`;
    const pinnedHash = '86b552e2de1bee03a65047056f772438998264572eb06b98983623178303ea5d';
    const pinnedSnapshot =
      '# pinned historical rubric\n\n' +
      '## Structured rubric data (`template_data`)\n\n' +
      '~~~json\n' +
      JSON.stringify(
        { schemaVersion: 2, rubricRevision: 3, templateData: currentPlanRow.template_data, criteriaHash: pinnedHash },
        null,
        2,
      ) +
      '\n~~~\n';
    await db.adminSql`
      INSERT INTO harness_shared.plan_revisions
        (workspace_id, harness_slug, plan_slug, seq, content_hash, content_snapshot,
         rationale, author_kind, author_id, created_at)
      VALUES (${activeWorkspaceId()}, 'papercusp', ${rubricId}, 3, md5('pinned'),
              ${pinnedSnapshot}, 'test', 'agent', 'test', 1)`;
    expect((await rubrics.getRubric(rubricId, 3))?.criteriaHash).toBe(pinnedHash);

    // A revision row without the enriched structured snapshot is not safe to grade:
    // the historical read must fail closed instead of using the current row.
    await db.adminSql`
      INSERT INTO harness_shared.plan_revisions
        (workspace_id, harness_slug, plan_slug, seq, content_hash, content_snapshot,
         rationale, author_kind, author_id, created_at)
      VALUES (${activeWorkspaceId()}, 'papercusp', ${rubricId}, 4, md5('malformed'),
              '# malformed historical rubric', 'test', 'agent', 'test', 1)`;
    expect(await rubrics.getRubric(rubricId, 4)).toBeNull();
  });

  it('ratify PRESERVES every criterion replication drill in template_data (EI-10443 — the status-flip must not strip them)', async () => {
    // The reported bug: rubrics:ratify's status-flip write DESTROYED criterion.replication
    // drills from template_data — whole-document revalidation silently dropped the then-
    // unknown key. WI-4287 made `replication` a first-class schema field, and ratifyRubric
    // now merges the RAW stored template_data through verbatim (only stamping ratifiedBy)
    // while the body write leaves template_data untouched on conflict — so the drills
    // survive. This pins that exact regression: a ratify must not lose a single drill.
    const criteriaWithDrills = [
      {
        key: 'placement-health',
        title: 'Placement health',
        model: 'The Queen places ready frontier items onto live bees within a cadence.',
        method: 'Count ready work_items with no claim older than the cadence.',
        driftMarkers: 'A growing backlog of ready-but-unplaced items.',
        replication:
          'DRILL A: seed 3 ready work_items → run placement → assert each lands on a live bee within the cadence → cleanup the seeded rows.',
      },
      {
        key: 'ideation-diversity',
        title: 'Ideation diversity',
        model: 'Scout lens weights drift away from uniform as grades steer ideation.',
        method: 'Inspect lens_weights; off-uniform 0.25 means grades are steering.',
        driftMarkers: 'Lens weights stuck uniform; repeated near-identical ideas.',
        replication:
          'DRILL B: propose N ideas → grade one lens up → assert lens_weights move off 0.25 → reset the weights.',
      },
    ];
    const expectedDrills = criteriaWithDrills.map((c) => c.replication);
    await rubrics.proposeRubric({
      rubricId: 'drills-rubric',
      characteristic: 'hive-coordination',
      title: 'Drills',
      criteria: criteriaWithDrills,
      by: 'author-a',
    });
    // Sanity: propose persisted every drill into the RAW template_data.
    const readDrills = async () => {
      const [row] = await db.adminSql<{ template_data: { criteria: { key: string; replication?: string }[] } }[]>`
        SELECT template_data FROM harness_shared.harness_plans
         WHERE plan_slug = 'drills-rubric' AND template = 'rubric'`;
      return row.template_data.criteria.map((c) => c.replication);
    };
    expect(await readDrills()).toEqual(expectedDrills);

    // Ratify with a DIFFERENT identity (D-012 author ≠ ratifier).
    const active = await rubrics.ratifyRubric('drills-rubric', 'queen-1');
    expect(active?.status).toBe('active');

    // The exact EI-10443 regression: every drill SURVIVES the status-flip write in the
    // RAW stored template_data (not silently stripped by the write pipeline)…
    expect(await readDrills()).toEqual(expectedDrills);
    // …and the projected rubric carries them too.
    expect(active?.criteria.map((c) => c.replication)).toEqual(expectedDrills);
  });

  it('D-012 enforced on persisted provenance: the proposer cannot ratify their own proposal', async () => {
    await rubrics.proposeRubric({
      rubricId: 'selfy',
      characteristic: 'c',
      title: 'S',
      criteria: sampleCriteria,
      by: 'author-a',
    });
    await expect(rubrics.ratifyRubric('selfy', 'author-a')).rejects.toThrow(
      /author ≠ ratifier|cannot ratify their own/i,
    );
    expect((await rubrics.getRubric('selfy'))?.status).toBe('proposed'); // nothing flipped
  });

  it('a re-propose moves the proposer of record to the reviser and DROPS the old ratification', async () => {
    await rubrics.proposeRubric({
      rubricId: 'rev',
      characteristic: 'c',
      title: 'v1',
      criteria: sampleCriteria,
      by: 'author-a',
    });
    await rubrics.ratifyRubric('rev', 'queen-1');
    const revised = await rubrics.proposeRubric({
      rubricId: 'rev',
      characteristic: 'c',
      title: 'v2',
      criteria: sampleCriteria,
      by: 'reviewer-b',
    });
    expect(revised.proposedBy).toBe('reviewer-b'); // NOT the plan owner (author-a)
    expect(revised.status).toBe('proposed'); // a revision needs re-ratification…
    expect(revised.ratifiedBy).toBeNull(); // …and the stale ratification is gone
    // The cross-party ratify then records honestly.
    const active = await rubrics.ratifyRubric('rev', 'author-a'); // a ≠ b, allowed
    expect(active?.ratifiedBy).toBe('author-a');
    expect(active?.proposedBy).toBe('reviewer-b');
  });

  it('amendRubric on an ACTIVE rubric preserves the ratifier of record (status is preserved, so provenance must be too)', async () => {
    await rubrics.proposeRubric({
      rubricId: 'amendee',
      characteristic: 'c',
      title: 'A',
      criteria: sampleCriteria,
      by: 'author-a',
    });
    await rubrics.ratifyRubric('amendee', 'queen-1');
    const amended = await rubrics.amendRubric({
      rubricId: 'amendee',
      criterion: { key: 'placement-health', field: 'title', mode: 'replace', text: 'Placement health (amended)' },
      by: 'author-a',
    });
    expect(amended?.status).toBe('active');
    expect(amended?.ratifiedBy).toBe('queen-1'); // not dropped, not the amender
    expect(amended?.proposedBy).toBe('author-a');
  });

  it('amendRubric preserves hand-authored plan requirements, items, and decisions', async () => {
    const rubricId = 'amend-preserves-plan-narrative';
    await rubrics.proposeRubric({
      rubricId,
      characteristic: 'narrative-preservation',
      title: 'Narrative preservation',
      criteria: sampleCriteria,
      by: 'author-a',
    });

    const [before] = await db.adminSql<{ content: string; created: string }[]>`
      SELECT content, created::text AS created
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${activeWorkspaceId()}
         AND harness_slug = 'papercusp'
         AND plan_slug = ${rubricId}`;
    expect(before).toBeDefined();
    const enriched = `${before.content}\n## Requirements\n- Preserve P-003 evidence.\n\n## Decisions\n### D-001 — Keep the acceptance context\n`;
    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET content = ${enriched}, content_hash = md5(${enriched}), version = version + 1
       WHERE workspace_id = ${activeWorkspaceId()}
         AND harness_slug = 'papercusp'
         AND plan_slug = ${rubricId}`;

    const amended = await rubrics.amendRubric({
      rubricId,
      criterion: { key: 'placement-health', field: 'title', mode: 'replace', text: 'Placement health (amended)' },
      by: 'author-a',
    });
    expect(amended?.rubricId).toBe(rubricId);

    const [after] = await db.adminSql<{ content: string; created: string }[]>`
      SELECT content, created::text AS created
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${activeWorkspaceId()}
         AND harness_slug = 'papercusp'
         AND plan_slug = ${rubricId}`;
    expect(after.content).toContain('## Requirements');
    expect(after.content).toContain('Preserve P-003 evidence.');
    expect(after.content).toContain('### D-001 — Keep the acceptance context');
    expect(after.created).toBe(before.created);
    // Plan frontmatter uses `draft` for the rubric status `proposed`.
    expect(after.content).toMatch(/status:\s*draft/);
  });

  it('serializes concurrent amendments from the locked current snapshot (EI-21395928602431222)', async () => {
    const rubricId = 'concurrent-amendments';
    const criteria = Array.from({ length: 5 }, (_, index) => ({
      key: `criterion-${index}`,
      title: `Criterion ${index}`,
      model: `Model ${index}`,
      method: `Method ${index}`,
      driftMarkers: `Drift ${index}`,
    }));
    await rubrics.proposeRubric({
      rubricId,
      characteristic: 'concurrency',
      title: 'Concurrent amendments',
      criteria,
      by: 'seed-author',
    });

    await Promise.all(
      criteria.map((criterion, index) =>
        retryBoundedLockBusy(() => rubrics.amendRubric({
          rubricId,
          criterion: {
            key: criterion.key,
            field: 'replication',
            mode: 'replace',
            text: `REPLICATION DRILL ${index}: amend criterion ${index} and verify the persisted field.`,
          },
          ...(index === 0 ? { methodRef: 'concurrent-amendments-runbook' } : {}),
          by: `amender-${index}`,
        })),
      ),
    );

    const [row] = await db.adminSql<
      {
        template_data: { methodRef?: string; criteria: { key: string; replication?: string }[] };
      }[]
    >`
      SELECT template_data
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${activeWorkspaceId()}
         AND harness_slug = 'papercusp'
         AND plan_slug = ${rubricId}`;
    expect(row.template_data.methodRef).toBe('concurrent-amendments-runbook');
    expect(row.template_data.criteria).toEqual(
      criteria.map((criterion, index) => ({
        ...criterion,
        replication: `REPLICATION DRILL ${index}: amend criterion ${index} and verify the persisted field.`,
      })),
    );
  });

  it('retries only a bounded number of PostgreSQL lock-busy amendment results', async () => {
    const lockBusy = new OrgTxnTimeoutError('55P03', new Error('lock timeout'));
    let attempts = 0;
    await expect(
      retryBoundedLockBusy(async () => {
        attempts += 1;
        if (attempts < MAX_BOUNDED_LOCK_BUSY_RETRIES + 1) throw lockBusy;
        return 'committed';
      }),
    ).resolves.toBe('committed');
    expect(attempts).toBe(MAX_BOUNDED_LOCK_BUSY_RETRIES + 1);

    attempts = 0;
    await expect(
      retryBoundedLockBusy(async () => {
        attempts += 1;
        throw lockBusy;
      }),
    ).rejects.toBe(lockBusy);
    expect(attempts).toBe(MAX_BOUNDED_LOCK_BUSY_RETRIES + 1);

    const statementTimeout = new OrgTxnTimeoutError('57014', new Error('statement timeout'));
    attempts = 0;
    await expect(
      retryBoundedLockBusy(async () => {
        attempts += 1;
        throw statementTimeout;
      }),
    ).rejects.toBe(statementTimeout);
    expect(attempts).toBe(1);
  });

  it('ratify of an unknown rubric returns null', async () => {
    expect(await rubrics.ratifyRubric('nope', 'q')).toBeNull();
  });

  it('status:active authors a ratified rubric directly', async () => {
    const r = await rubrics.proposeRubric({
      rubricId: 'seeded',
      characteristic: 'c',
      title: 'Seeded',
      criteria: sampleCriteria,
      status: 'active',
      by: 'seed',
    });
    expect(r.status).toBe('active');
    expect(r.ratifiedBy).toBe('seed');
  });

  it('acceptance re-propose tolerates blank optional prose from the legacy projection', async () => {
    const subjectPlan = 'acceptance-roundtrip-subject';
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
         created, updated, owner, archived, template, template_data, template_slug, origin)
      VALUES (${activeWorkspaceId()}, 'papercusp', ${subjectPlan}, '', md5(${subjectPlan}), 1,
              'Acceptance round-trip subject', 'active', '2026-08-22', '2026-08-22', 'su-test',
              false, NULL, '{}'::text::jsonb, NULL, 'local')`;
    // Migration 1111 stamps every newly inserted ordinary plan into the strict
    // post-epoch cohort. This case models a legacy read projection, so preserve
    // that fixture identity explicitly before authoring its pre-contract rubric.
    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET acceptance_bar_epoch = NULL, acceptance_bar_cohort = NULL
       WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp'
         AND plan_slug = ${subjectPlan}`;

    const first = await rubrics.proposeRubric({
      rubricId: 'acceptance-empty-prose',
      kind: 'acceptance',
      subjectPlan,
      characteristic: 'acceptance-roundtrip',
      title: 'Acceptance round-trip',
      // Acceptance criteria may omit model/method, but the authoring contract
      // requires a concrete drift marker so the outcome remains falsifiable.
      criteria: [
        {
          key: 'outcome',
          title: 'Outcome',
          model: '',
          method: '',
          driftMarkers: 'the outcome regresses',
          check: { kind: 'instrument', instrumentKey: 'none' },
        },
      ],
      by: 'su-test',
    });
    expect(first.status).toBe('active');

    const [stored] = await db.adminSql<{ template_data: { criteria: Record<string, unknown>[] } }[]>`
      SELECT template_data FROM harness_shared.harness_plans
       WHERE plan_slug = 'acceptance-empty-prose' AND template = 'rubric'`;
    expect(stored.template_data.criteria[0]).toEqual({
      key: 'outcome',
      title: 'Outcome',
      driftMarkers: 'the outcome regresses',
      check: { kind: 'instrument', instrumentKey: 'none' },
    });

    // getRubric maps the optional fields back to '' for the legacy Rubric shape. A
    // read → re-propose must accept that projection instead of rejecting the revision.
    const fromRead = await rubrics.getRubric('acceptance-empty-prose');
    const revised = await rubrics.proposeRubric({
      rubricId: fromRead!.rubricId,
      kind: fromRead!.kind,
      subjectPlan: fromRead!.subjectPlan!,
      characteristic: fromRead!.characteristic,
      title: fromRead!.title,
      criteria: fromRead!.criteria,
      by: 'su-reviser',
    });
    expect(revised.status).toBe('active');
  });

  it('canonicalizes BAR alias metadata and persists only the server-derived hash', async () => {
    const subjectPlan = 'canonical-bar-subject';
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
         created, updated, owner, archived, template, template_data, template_slug, origin)
      VALUES (${activeWorkspaceId()}, 'papercusp', ${subjectPlan}, '', md5(${subjectPlan}), 1,
              'Canonical BAR subject', 'draft', '2026-09-04', '2026-09-04', 'su-test',
              false, NULL, '{}'::text::jsonb, NULL, 'local')`;

    const bar = 'The activation path produces coverage-evidence rows.';
    const proposed = await rubrics.proposeRubric({
      rubricId: 'canonical-bar-rubric',
      kind: 'acceptance',
      subjectPlan,
      characteristic: 'plan-acceptance',
      title: 'Canonical BAR rubric',
      criteria: [
        {
          key: 'activation-outcome',
          title: 'Coverage activation exists',
          bar,
          barKey: 'R-7',
          barHash: '0'.repeat(64), // caller value must never become authority
          role: 'outcome',
          mandatory: true,
          requiredScope: ['surface:coverage-row', 'cohort:post-epoch', 'surface:coverage-row'],
          evidencePlane: 'tree',
          passRatings: ['PASS', 'pass'],
          driftMarkers: 'No coverage-evidence row exists for the activation path.',
          check: { kind: 'instrument', instrumentKey: 'none' },
          barProvenance: {
            lifecycle: 'pre-implementation',
            declaredAt: '2026-09-04T12:00:00.000Z',
            declaredBy: 'su-test',
          },
        },
      ],
      ratingScale: ['pass', 'fail', 'unknown'],
      by: 'su-test',
    });

    const criterion = proposed.criteria[0]!;
    expect(criterion.model).toBe(bar);
    expect(criterion.bar).toBe(bar);
    expect(criterion.barHash).toMatch(/^[a-f0-9]{64}$/);
    expect(criterion.barHash).not.toBe('0'.repeat(64));
    expect(criterion.requiredScope).toEqual(['cohort:post-epoch', 'surface:coverage-row']);
    expect(criterion.passRatings).toEqual(['pass']);

    const [stored] = await db.adminSql<{ template_data: { criteria: Record<string, unknown>[] } }[]>`
      SELECT template_data FROM harness_shared.harness_plans
       WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp'
         AND plan_slug = 'canonical-bar-rubric'`;
    expect(stored.template_data.criteria[0]).not.toHaveProperty('bar');
    expect(stored.template_data.criteria[0]).toMatchObject({
      model: bar,
      barKey: 'R-7',
      barHash: criterion.barHash,
      role: 'outcome',
      mandatory: true,
    });
  });

  it('refuses a second active acceptance rubric for the same subject plan', async () => {
    const subjectPlan = 'acceptance-unique-subject';
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
         created, updated, owner, archived, template, template_data, template_slug, origin)
      VALUES (${activeWorkspaceId()}, 'papercusp', ${subjectPlan}, '', md5(${subjectPlan}), 1,
              'Acceptance uniqueness subject', 'active', '2026-08-22', '2026-08-22', 'su-test',
              false, NULL, '{}'::text::jsonb, NULL, 'local')`;

    await rubrics.proposeRubric({
      rubricId: 'acceptance-unique-first',
      kind: 'acceptance',
      subjectPlan,
      characteristic: 'acceptance-uniqueness',
      title: 'Acceptance uniqueness first',
      criteria: [
        {
          key: 'outcome',
          title: 'Outcome',
          driftMarkers: 'the outcome regresses',
          check: { kind: 'instrument', instrumentKey: 'none' },
        },
      ],
      by: 'su-first',
    });

    const refusal = await rubrics
      .proposeRubric({
        rubricId: 'acceptance-unique-second',
        kind: 'acceptance',
        subjectPlan,
        characteristic: 'acceptance-uniqueness',
        title: 'Acceptance uniqueness second',
        criteria: [
          {
            key: 'outcome',
            title: 'Outcome',
            driftMarkers: 'the outcome regresses',
            check: { kind: 'instrument', instrumentKey: 'none' },
          },
        ],
        by: 'su-second',
      })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toMatch(/already has an active acceptance rubric.*acceptance-unique-first/i);
    expect((refusal as Error).message).toMatch(
      /rubrics:get.*acceptance-unique-first.*rubrics:propose.*same rubricRef.*revision in place/i,
    );
    expect((refusal as Error).message).not.toContain('Retire the existing contract before proposing a replacement');

    const rows = await db.adminSql<{ count: string }[]>`
      SELECT count(*)::text AS count
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${activeWorkspaceId()}
         AND template = 'rubric'
         AND template_data->>'kind' = 'acceptance'
         AND template_data->>'subjectPlan' = ${subjectPlan}`;
    expect(rows[0]?.count).toBe('1');
  });

  it('acceptance amend tolerates omitted optional prose from the legacy projection', async () => {
    const subjectPlan = 'acceptance-amend-subject';
    const rubricId = 'acceptance-amend-empty-prose';
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
         created, updated, owner, archived, template, template_data, template_slug, origin)
      VALUES (${activeWorkspaceId()}, 'papercusp', ${subjectPlan}, '', md5(${subjectPlan}), 1,
              'Acceptance amend subject', 'active', '2026-08-22', '2026-08-22', 'su-test',
              false, NULL, '{}'::text::jsonb, NULL, 'local')`;
    // Keep this legacy-projection fixture outside the server-owned BAR epoch;
    // an adopted subject without barContract is intentionally refused by the
    // persistence guard and belongs in the recovery-path coverage below.
    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET acceptance_bar_epoch = NULL, acceptance_bar_cohort = NULL
       WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp'
         AND plan_slug = ${subjectPlan}`;

    const first = await rubrics.proposeRubric({
      rubricId,
      kind: 'acceptance',
      subjectPlan,
      characteristic: 'acceptance-amend',
      title: 'Acceptance amend',
      criteria: [
        {
          key: 'outcome-a',
          title: 'Outcome A',
          driftMarkers: 'outcome A regresses',
          check: { kind: 'instrument', instrumentKey: 'none' },
        },
        { key: 'outcome-b', title: 'Outcome B', driftMarkers: 'outcome B regresses' },
      ],
      by: 'su-test',
    });
    expect(first.status).toBe('active');

    // amendRubric reads the legacy Rubric projection, where omitted acceptance prose
    // comes back as empty strings, then delegates the whole-document write to propose.
    // The write must normalize those blanks back to omissions instead of applying the
    // standard rubric's required model/method/driftMarkers validation.
    const amended = await rubrics.amendRubric({
      rubricId,
      methodRef: '/internal/docs/testing/agent-e2e',
      by: 'su-amender',
    });
    expect(amended).toMatchObject({
      rubricId,
      kind: 'acceptance',
      subjectPlan,
      status: 'active',
      methodRef: '/internal/docs/testing/agent-e2e',
    });
    // amendRubric returns `Rubric | null`; assert the non-null contract explicitly
    // rather than leaning on `!`, so a null return fails HERE with a readable
    // message instead of as a downstream property access on null.
    expect(amended).not.toBeNull();
    expect(amended!.criteria.map((criterion) => criterion.key)).toEqual(['outcome-a', 'outcome-b']);

    const [stored] = await db.adminSql<{ template_data: { criteria: Record<string, unknown>[]; methodRef: string } }[]>`
      SELECT template_data FROM harness_shared.harness_plans
       WHERE plan_slug = ${rubricId} AND template = 'rubric'`;
    expect(stored.template_data.methodRef).toBe('/internal/docs/testing/agent-e2e');
    expect(stored.template_data.criteria).toEqual([
      {
        key: 'outcome-a',
        title: 'Outcome A',
        driftMarkers: 'outcome A regresses',
        check: { kind: 'instrument', instrumentKey: 'none' },
      },
      { key: 'outcome-b', title: 'Outcome B', driftMarkers: 'outcome B regresses' },
    ]);
  });

  it('acceptance re-propose preserves a retired contract and its superseded rubric plan (EI-21296891484659125)', async () => {
    const subjectPlan = 'retired-acceptance-subject';
    const rubricId = 'retired-acceptance-contract';
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
         created, updated, owner, archived, template, template_data, template_slug, origin)
      VALUES (${activeWorkspaceId()}, 'papercusp', ${subjectPlan}, '', md5(${subjectPlan}), 1,
              'Retired acceptance subject', 'active', '2026-08-22', '2026-08-22', 'su-test',
              false, NULL, '{}'::text::jsonb, NULL, 'local')`;
    // This regression starts from the same pre-adoption legacy contract as the
    // original incident. Clear the paired marker the insert trigger adds so the
    // test exercises retirement preservation, not orphaned-contract recovery.
    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET acceptance_bar_epoch = NULL, acceptance_bar_cohort = NULL
       WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp'
         AND plan_slug = ${subjectPlan}`;

    const initialCriteria = [
      {
        key: 'original-outcome',
        title: 'Original outcome',
        driftMarkers: 'the original outcome regresses',
        check: { kind: 'instrument' as const, instrumentKey: 'none' },
      },
    ];
    const first = await rubrics.proposeRubric({
      rubricId,
      kind: 'acceptance',
      subjectPlan,
      characteristic: 'retired-acceptance-contract',
      title: 'Retired acceptance contract',
      criteria: initialCriteria,
      by: 'su-author',
    });
    // Calibration: the real writer and permanent wrong control agree for a NEW acceptance
    // rubric. The distinguishing case begins only after the lifecycle retirement below.
    expect(first.status).toBe(deliberatelyUnguardedAcceptanceProposeStatus());

    const workspaceId = activeWorkspaceId();
    await db.adminSql.begin(async (tx) => {
      await tx`
        SELECT set_config('papercusp.plan_shipment_acceptance_gate_receipt', jsonb_build_object(
          'schemaVersion', 1, 'transactionId', txid_current()::text,
          'workspaceId', ${workspaceId}::text, 'harnessSlug', 'papercusp'::text, 'planSlug', ${subjectPlan}::text
        )::text, true)`;
      await tx`
        UPDATE harness_shared.harness_plans
           SET status = 'shipped'
         WHERE workspace_id = ${workspaceId} AND harness_slug = 'papercusp'
           AND plan_slug = ${subjectPlan}`;
    });
    expect(await rubrics.retireAcceptanceRubricForPlan(subjectPlan, 'su-shipper')).toBe(rubricId);
    expect((await rubrics.getRubric(rubricId))?.status).toBe('retired');

    // The unguarded implementation silently chooses active because the agent-facing path
    // has no status argument. Keep this wrong control permanently: if the production guard
    // disappears, the assertions below fail on the exact pre-fix behavior.
    expect(deliberatelyUnguardedAcceptanceProposeStatus()).toBe('active');
    const revised = await rubrics.proposeRubric({
      rubricId,
      kind: 'acceptance',
      subjectPlan,
      characteristic: 'retired-acceptance-contract',
      title: 'Retired acceptance contract',
      criteria: [
        ...initialCriteria,
        { key: 'added-after-ship', title: 'Added after ship', driftMarkers: 'the added-after-ship outcome regresses' },
      ],
      by: 'su-reviser',
    });

    expect(revised.status).toBe('retired');
    expect(revised.criteria.map((criterion) => criterion.key)).toEqual(['original-outcome', 'added-after-ship']);
    const [rubricPlan] = await db.adminSql<{ status: string }[]>`
      SELECT status
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp'
         AND plan_slug = ${rubricId}`;
    expect(rubricPlan.status).toBe('superseded');
  });

  it('re-propose is an idempotent upsert — updates content, never a duplicate row', async () => {
    await rubrics.proposeRubric({
      rubricId: 'seed',
      characteristic: 'c',
      title: 'v1',
      criteria: sampleCriteria,
      status: 'active',
      by: 'seed',
    });
    const r2 = await rubrics.proposeRubric({
      rubricId: 'seed',
      characteristic: 'c',
      title: 'v2',
      criteria: sampleCriteria,
      status: 'active',
      by: 'seed',
    });
    expect(r2.title).toBe('v2');
    expect(r2.status).toBe('active');
    const all = await rubrics.listRubrics({});
    expect(all.filter((x) => x.rubricId === 'seed')).toHaveLength(1); // ON CONFLICT, not a second row
  });

  it('re-propose PERSISTS changed template_data — criteria/scale/description, not just the body (EI-11070 regression)', async () => {
    // v1: 2 criteria, 4-value scale, short description.
    await rubrics.proposeRubric({
      rubricId: 'drift-check',
      characteristic: 'c',
      title: 'Drift v1',
      description: 'short v1 description',
      criteria: sampleCriteria,
      ratingScale: ['healthy', 'degraded', 'broken', 'unknown'],
      status: 'active',
      by: 'seed',
    });
    // ATOMICITY (EI-11070): body + template_data land in ONE version bump. A fresh propose
    // is version 1 — the former two-transaction split bumped it to 2 (body, then a separate
    // template_data write), which is exactly the non-atomic seam the combined write closes.
    const [afterV1] = await db.adminSql<{ version: number }[]>`
      SELECT version FROM harness_shared.harness_plans WHERE plan_slug = 'drift-check' AND template = 'rubric'`;
    expect(Number(afterV1.version)).toBe(1);
    // v2: 3 criteria, a DIFFERENT 6-value scale, a longer description — the whole
    // template_data document changes. The pre-EI-11070 bug landed the body write
    // (title/status/updated_at) but SILENTLY skipped this template_data write, so the
    // row kept v1's 2 criteria / 4-value scale / short description while reporting ok.
    const threeCriteria = [
      ...sampleCriteria,
      {
        key: 'third-criterion',
        title: 'Third',
        model: 'a third model',
        method: 'a third method',
        driftMarkers: 'third drift',
      },
    ];
    const sixValueScale = ['exemplary', 'pass', 'partial', 'fail', 'severe', 'unknown'];
    const r2 = await rubrics.proposeRubric({
      rubricId: 'drift-check',
      characteristic: 'c',
      title: 'Drift v2',
      description: 'a substantially longer v2 description that differs from v1',
      criteria: threeCriteria,
      ratingScale: sixValueScale,
      status: 'active',
      by: 'seed',
    });
    // The returned projection reflects the new content…
    expect(r2.criteria).toHaveLength(3);
    expect(r2.ratingScale).toEqual(sixValueScale);
    expect(r2.description).toContain('longer v2');
    // …AND the RAW template_data jsonb in the DB actually changed (the bug left it at v1).
    const [row] = await db.adminSql<
      { version: number; template_data: { criteria: unknown[]; ratingScale: string[]; description: string } }[]
    >`
      SELECT version, template_data FROM harness_shared.harness_plans
       WHERE plan_slug = 'drift-check' AND template = 'rubric'`;
    expect(row.template_data.criteria).toHaveLength(3);
    expect(row.template_data.ratingScale).toEqual(sixValueScale);
    expect(row.template_data.description).toContain('longer v2');
    // One more atomic bump: the re-propose is a single version increment (1 → 2), not two.
    expect(Number(row.version)).toBe(2);
    // …and the read projection resolves the new document too.
    const got = await rubrics.getRubric('drift-check');
    expect(got?.criteria).toHaveLength(3);
    expect(got?.ratingScale).toEqual(sixValueScale);
  });

  it('re-propose preserves the stored ratingScale when the whole-document input omits it', async () => {
    const storedScale = ['pass', 'partial', 'fail', 'not-measured'];
    await rubrics.proposeRubric({
      rubricId: 'preserve-omitted-scale',
      characteristic: 'c',
      title: 'Scale v1',
      criteria: sampleCriteria,
      ratingScale: storedScale,
      status: 'active',
      by: 'author-a',
    });

    const revised = await rubrics.proposeRubric({
      rubricId: 'preserve-omitted-scale',
      characteristic: 'c',
      title: 'Scale v2',
      criteria: sampleCriteria,
      status: 'active',
      by: 'reviewer-b',
    });

    expect(revised.ratingScale).toEqual(storedScale);
    const [row] = await db.adminSql<{ template_data: { ratingScale: string[] } }[]>`
      SELECT template_data
        FROM harness_shared.harness_plans
       WHERE plan_slug = 'preserve-omitted-scale'
         AND template = 'rubric'`;
    expect(row.template_data.ratingScale).toEqual(storedScale);
  });

  it('a malformed propose is rejected fail-loud, never persisting a half-state', async () => {
    await expect(
      rubrics.proposeRubric({ rubricId: 'bad', characteristic: '', title: 'Bad', criteria: [], by: 'x' }),
    ).rejects.toThrow(/invalid rubric data/i);
    expect(await rubrics.getRubric('bad')).toBeNull(); // nothing written
  });
});

describe('autoRatifyRubricOnFirstScorecard — grading a proposed rubric IS adoption (WI-5415)', () => {
  it('ratifies a PROPOSED rubric the first time a DIFFERENT agent grades it', async () => {
    await rubrics.proposeRubric({
      rubricId: 'gr',
      characteristic: 'c',
      title: 'Gr',
      criteria: sampleCriteria,
      by: 'author-a',
    });
    const result = await rubrics.autoRatifyRubricOnFirstScorecard('gr', 'grader-b');
    expect(result?.status).toBe('active');
    expect(result?.ratifiedBy).toBe('grader-b');
    expect(result?.proposedBy).toBe('author-a');
    const stored = await rubrics.getRubric('gr');
    expect(stored?.status).toBe('active'); // durably persisted, not just returned
  });

  it('D-012: is a no-op when the grader IS the rubric proposer — stays proposed', async () => {
    await rubrics.proposeRubric({
      rubricId: 'self',
      characteristic: 'c',
      title: 'Self',
      criteria: sampleCriteria,
      by: 'author-a',
    });
    const result = await rubrics.autoRatifyRubricOnFirstScorecard('self', 'author-a');
    expect(result).toBeNull();
    const stored = await rubrics.getRubric('self');
    expect(stored?.status).toBe('proposed'); // left untouched, awaiting a different ratifier
  });

  it('is a no-op on an already-ACTIVE rubric (nothing to adopt)', async () => {
    await rubrics.proposeRubric({
      rubricId: 'already',
      characteristic: 'c',
      title: 'Already',
      criteria: sampleCriteria,
      status: 'active',
      by: 'author-a',
    });
    const result = await rubrics.autoRatifyRubricOnFirstScorecard('already', 'grader-b');
    expect(result).toBeNull();
    const stored = await rubrics.getRubric('already');
    expect(stored?.ratifiedBy).toBe('author-a'); // the original ratification is untouched
  });

  it('returns null (never throws) for an unknown rubricId', async () => {
    await expect(rubrics.autoRatifyRubricOnFirstScorecard('nope', 'grader-b')).resolves.toBeNull();
  });
});

describe('list / get / search over written rubrics', () => {
  beforeEach(async () => {
    await rubrics.proposeRubric({
      rubricId: 'active-a',
      characteristic: 'hive-coordination',
      title: 'Active A',
      criteria: sampleCriteria,
      status: 'active',
      by: 's',
    });
    await rubrics.proposeRubric({
      rubricId: 'proposed-b',
      characteristic: 'memory-recall',
      title: 'Proposed B',
      criteria: sampleCriteria,
      by: 's',
    });
  });

  it('list orders active-first, then proposed', async () => {
    const all = await rubrics.listRubrics({});
    expect(all.map((r) => r.rubricId)).toEqual(['active-a', 'proposed-b']);
  });

  it('paginates the ordered result and stops with a null nextOffset', async () => {
    const first = await rubrics.listRubricsPage({ limit: 1 });
    expect(first.rubrics.map((r) => r.rubricId)).toEqual(['active-a']);
    expect(first.hasMore).toBe(true);
    expect(first.nextOffset).toBe(1);

    const second = await rubrics.listRubricsPage({ limit: 1, offset: first.nextOffset! });
    expect(second.rubrics.map((r) => r.rubricId)).toEqual(['proposed-b']);
    expect(second.hasMore).toBe(false);
    expect(second.nextOffset).toBeNull();
    expect((await rubrics.listRubrics({ limit: 1, offset: 1 })).map((r) => r.rubricId)).toEqual(['proposed-b']);
  });

  it('continues beyond the former 500-row SQL cap', async () => {
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
         created, updated, owner, archived, template, template_data, template_slug, origin)
      SELECT ${activeWorkspaceId()}, 'papercusp', 'rubric-page-' || lpad(series.id::text, 3, '0'),
             '', md5('rubric-page-' || lpad(series.id::text, 3, '0')), 1,
             'Rubric page ' || series.id::text, 'active',
             '2026-06-20', '2026-06-20', 'queen-1', false, 'rubric',
             ${JSON.stringify(rubricData)}::text::jsonb, NULL, 'local'
        FROM generate_series(1, 501) AS series(id)`;

    const first = await rubrics.listRubricsPage({ limit: 500 });
    expect(first.rubrics).toHaveLength(500);
    expect(first.hasMore).toBe(true);
    expect(first.nextOffset).toBe(500);

    const second = await rubrics.listRubricsPage({ limit: 500, offset: first.nextOffset! });
    const ids = [...first.rubrics, ...second.rubrics].map((r) => r.rubricId);
    expect(second.rubrics).toHaveLength(3);
    expect(second.hasMore).toBe(false);
    expect(second.nextOffset).toBeNull();
    expect(ids).toHaveLength(503);
    expect(new Set(ids).size).toBe(503);
    expect(ids).toContain('rubric-page-501');
  });

  it('filters acceptance rubrics by subjectPlan before the bounded page limit', async () => {
    const targetPlan = 'acceptance-subject-past-page-cap';
    await insertRubricPlan('acceptance-page-target', {
      data: { ...rubricData, kind: 'acceptance', subjectPlan: targetPlan },
    });
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
         created, updated, owner, archived, template, template_data, template_slug, origin)
      SELECT ${activeWorkspaceId()}, 'papercusp', 'acceptance-page-noise-' || lpad(series.id::text, 3, '0'),
             '', md5('acceptance-page-noise-' || lpad(series.id::text, 3, '0')), 1,
             'Acceptance page noise ' || series.id::text, 'active',
             '2026-06-20', '2026-06-20', 'queen-1', false, 'rubric',
             ${JSON.stringify({ ...rubricData, kind: 'acceptance' })}::text::jsonb ||
               jsonb_build_object('subjectPlan', 'another-plan-' || series.id::text),
             NULL, 'local'
        FROM generate_series(1, 501) AS series(id)`;
    const page = await rubrics.listRubricsPage({ kind: 'acceptance', subjectPlan: targetPlan, limit: 1 });

    expect(page.rubrics.map((rubric) => rubric.rubricId)).toEqual(['acceptance-page-target']);
    expect(page.hasMore).toBe(false);
    expect(page.nextOffset).toBeNull();
  });

  it('list filters by status and by characteristic', async () => {
    expect((await rubrics.listRubrics({ status: 'active' })).map((r) => r.rubricId)).toEqual(['active-a']);
    expect((await rubrics.listRubrics({ characteristic: 'memory-recall' })).map((r) => r.rubricId)).toEqual([
      'proposed-b',
    ]);
  });

  it('get returns the full criteria; unknown id → null', async () => {
    const got = await rubrics.getRubric('active-a');
    expect(got?.criteria).toHaveLength(2);
    expect(got?.criteria[0].model).toContain('Queen places');
    expect(await rubrics.getRubric('missing')).toBeNull();
  });

  it('search matches over title / characteristic, and misses cleanly', async () => {
    expect((await rubrics.searchRubrics('coordination')).map((r) => r.rubricId)).toContain('active-a');
    expect((await rubrics.searchRubrics('memory')).map((r) => r.rubricId)).toContain('proposed-b');
    expect(await rubrics.searchRubrics('zzzznotarubric')).toEqual([]);
  });
});

// WI-976 regression — the store must scope reads/writes to the ACTIVE workspace
// (activeWorkspaceId()), NOT a hardcoded literal. The live bug (rubrics:list returned 0 so
// the Overwatch could not emit its required scorecard) was INVISIBLE to every other case
// in this suite: the test env's activeWorkspaceId() is 'default' — the same literal the
// buggy rubricsScopeWorkspace() hardcoded — so the read scope + the seed workspace always
// coincided and no mismatch could arise. In production the active workspace is
// 'papercusp-workspace' (where all plans + coord live), so the hardcoded 'default' scope
// missed the real rubric plan. This case pins a NON-'default' workspace to prove the scope
// FOLLOWS activeWorkspaceId(): a regression back to a hardcoded scope makes the reads below
// return [] / null and fails here.
describe('workspace scope follows activeWorkspaceId (WI-976 regression)', () => {
  it('resolves the rubric from the active workspace and isolates other workspaces', async () => {
    await insertRubricPlan('alpha-rubric', { workspaceId: 'ws-alpha' });
    await insertRubricPlan('beta-rubric', { workspaceId: 'ws-beta' });
    // Read pinned to ws-alpha → only ws-alpha's rubric (never ws-beta's; never []).
    const alpha = await runWithWorkspace('ws-alpha', () => rubrics.listRubrics({}));
    expect(alpha.map((r) => r.rubricId)).toEqual(['alpha-rubric']);
    const beta = await runWithWorkspace('ws-beta', () => rubrics.listRubrics({}));
    expect(beta.map((r) => r.rubricId)).toEqual(['beta-rubric']);
    // getRubric follows the same scope — ws-alpha cannot see ws-beta's rubric.
    expect(await runWithWorkspace('ws-alpha', () => rubrics.getRubric('beta-rubric'))).toBeNull();
    expect((await runWithWorkspace('ws-alpha', () => rubrics.getRubric('alpha-rubric')))?.rubricId).toBe(
      'alpha-rubric',
    );
  });
});

// ─── EI-21972673091438558: the template_data PERSISTENCE BOUNDARY ────────────────────
// A rubric IS a plan row and its criteria live in `template_data`. TWO doors write that
// column; only `rubrics:propose` used to be guarded. `plans:set-template-data` validates
// STRUCTURE ONLY — a criteria array of length 1 satisfies its zod schema exactly as well
// as one of length 27 — so a live rubric could be gutted through it without a word.
//
// The rules are unit-pinned in agent-tools/plans/rubric-loss-guard.test.ts. THESE cases
// pin the WIRING: that the guard actually runs on the generic door, against the row the
// transaction is replacing, and that a refusal leaves the stored rubric intact. Driving
// the SAME withPlanLock + evaluateSetTemplateData pair the tool handler uses is the point
// — asserting on the guard function alone would pass even if nothing called it.
describe('template_data persistence boundary — the set-template-data door', () => {
  // `authorMethods` performs the authoring step a real caller performs after
  // seeding (see the note at the end of this helper). It is OPT-IN because it
  // writes template_data, which advances clause revisions — cases that assert
  // exact revision numbers or history counts want the bare seed.
  async function seedBarContract(
    subject: string,
    opts: {
      authorMethods?: boolean;
      evidencePlane?: 'tree' | 'live';
      planStatus?: 'active' | 'draft';
      /** Replace the default two-BAR plan body (Requirements, map, Work) — frontmatter is kept. */
      body?: string;
      /** Plan items to insert for `body`; defaults to the two-BAR fixture's P-001/P-002. */
      itemIds?: string[];
    } = {},
  ) {
    const { seedAcceptanceBarsInTransaction } = await import('./acceptance-bar-seed');
    const { hashPlanContent } = await import('./agent-tools/plans/content-hash');
    const workspaceId = activeWorkspaceId();
    const planStatus = opts.planStatus ?? 'active';
    const body = opts.body ?? `## Requirements\n\n**R-1 — First outcome.** The first outcome holds.\n\n**R-2 — Second outcome.** The second outcome holds.\n\n## Design\n\n### Bar-to-work map for this plan\n\n| bar | implementing plan items | evidence plane |\n|---|---|---|\n| R-1 | P-001 | tree |\n| R-2 | P-002 | tree |\n\n## Work\n\n- **P-001** \`done\` first outcome\n- **P-002** \`done\` second outcome\n`;
    const content = `---\ntitle: METHOD pins\nslug: ${subject}\nstatus: ${planStatus}\n---\n\n${body}`;
    const seededContent = opts.evidencePlane === 'live' ? content.replaceAll('| tree |', '| live |') : content;
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id,harness_slug,plan_slug,content,content_hash,version,title,status,owner,acceptance_bar_epoch,acceptance_bar_cohort)
      VALUES (${workspaceId},'papercusp',${subject},${seededContent},${hashPlanContent(seededContent)},1,'METHOD pins',${planStatus},'su-test',1,'post-epoch')`;
    for (const [index, item] of (opts.itemIds ?? ['P-001', 'P-002']).entries()) {
      await db.adminSql`INSERT INTO harness_shared.plan_items
        (workspace_id,harness_slug,plan_slug,item_id,seq,status,item_text)
        VALUES (${workspaceId},'papercusp',${subject},${item},${index},'done',${item})`;
    }
    // The acceptance rubric this seed writes links to a STANDARD-kind class
    // rubric, and `assertAcceptanceLinksResolve` refuses a dangling classRef.
    // Nothing else in this file seeds one, so seed it here (idempotently — the
    // suite reuses one database across these cases).
    const [classRubricSeeded] = await db.adminSql`
      SELECT 1 FROM harness_shared.harness_plans
       WHERE workspace_id=${workspaceId} AND harness_slug='papercusp'
         AND plan_slug='plan-class-feature-ship'`;
    if (!classRubricSeeded) {
      await insertRubricPlan('plan-class-feature-ship', { workspaceId, title: 'Plan class — feature ship' });
    }
    const seeded = await db.adminSql.begin((tx) =>
      seedAcceptanceBarsInTransaction({
        executor: tx as never,
        workspaceId,
        harnessSlug: 'papercusp',
        planSlug: subject,
        planContent: seededContent,
        planTitle: 'METHOD pins',
        planStatus,
        planVersion: 1,
        adoptionEpoch: 1,
        cohort: 'post-epoch',
        classRef: 'plan-class-feature-ship',
        actorId: 'su-test',
        now: new Date('2026-09-05T00:00:00Z'),
      }),
    );
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) throw new Error(seeded.message);
    // acceptance-bar-seed deliberately leaves METHOD/checks blank for the author
    // to fill against as-built work — it seeds the literal placeholder "Fill
    // METHOD/checks against as-built work before grading". `check` is part of
    // ACCEPTANCE_BAR_MEANING_FIELDS, so authoring it through the generic
    // plans:set-template-data door is correctly refused as an unapproved BAR
    // meaning change. Use the canonical amendment door so the fixture represents
    // the approved, ready-to-amend contract that real callers would create.
    if (opts.authorMethods) {
      const current = await rubrics.getRubric(seeded.rubricSlug);
      if (!current) throw new Error(`seeded rubric '${seeded.rubricSlug}' did not resolve`);
      const amendment: Parameters<typeof rubrics.amendRubric>[0] = {
        rubricId: seeded.rubricSlug,
        actorId: 'method-author',
        reason: 'Author METHOD and deterministic checks for the seeded acceptance contract.',
        criteria: current.criteria.map((criterion) => ({
          ...criterion,
          method: 'Execute the seeded acceptance fixture.',
          // Later amendment cases require integration coverage without changing
          // the check set, so seed both conventional test layers up front.
          check: { kind: 'tests' as const, files: [
            'packages/operator-core/lib/acceptance-bar-seed.test.ts',
            'packages/operator-core/lib/rubrics.integration.test.ts',
          ] },
          requiredTestLayers: ['unit'],
        })),
      };
      await rubrics.amendRubric({ ...amendment, approvalRef: await postApproval(amendment) });
    }
    return { ...seeded, workspaceId, subject };
  }

  it('refreshes a stale stored BAR readiness Now after a canonical acceptance amendment', async () => {
    const seeded = await seedBarContract('stale-readiness-now-after-amendment', { authorMethods: true });
    const staleState =
      '⚠ BAR READINESS BLOCKED (2026-10-24, after decision-added): bar_snapshot_cohort_incomplete, ' +
      'bar_snapshot_rubric_missing, bar_snapshot_bar_set_empty. Next repair: repair seed. ' +
      '(re-evaluated in the same write by the scope-write cascade, P-030/P-031)';
    const staleNote = {
      state: staleState,
      next: 'repair seed',
      author: 'su-test',
      writtenAt: '2026-10-24T12:00:00.000Z',
      eventId: null,
      rationale: null,
      source: 'set-now',
    };
    await db.adminSql`UPDATE harness_shared.harness_plans
       SET now_note = ${JSON.stringify(staleNote)}::text::jsonb,
           now_state = ${staleNote.state}, now_next = ${staleNote.next}
     WHERE workspace_id = ${seeded.workspaceId} AND harness_slug = 'papercusp' AND plan_slug = ${seeded.subject}`;

    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    const amendment = {
      rubricId: seeded.rubricSlug,
      actorId: 'amendment-actor',
      reason: 'Change the BAR meaning and refresh the subject plan readiness note.',
      criterion: {
        key: before.criteria[0]!.key,
        field: 'driftMarkers' as const,
        mode: 'replace' as const,
        text: 'The first outcome is absent after the amendment commits.',
      },
    };
    await rubrics.amendRubric({ ...amendment, approvalRef: await postApproval(amendment) });

    const [after] = await db.adminSql<{ now_note: Record<string, unknown>; now_state: string; now_next: string }[]>`
      SELECT now_note, now_state, now_next FROM harness_shared.harness_plans
       WHERE workspace_id = ${seeded.workspaceId} AND harness_slug = 'papercusp' AND plan_slug = ${seeded.subject}`;
    // Authoring METHODs repairs the old seed failures, but it does not vet the
    // amended criteria. The refresh must replace obsolete advice with the current
    // blocker rather than clear a contract that still needs independent vetting.
    expect(after!.now_note).toMatchObject({ source: 'set-now' });
    expect(after!.now_note.state).toContain('BAR READINESS BLOCKED');
    expect(after!.now_note.state).toContain('bar_snapshot_vetting_missing');
    for (const obsoleteCode of ['bar_snapshot_cohort_incomplete', 'bar_snapshot_rubric_missing', 'bar_snapshot_bar_set_empty']) {
      expect(after!.now_note.state).not.toContain(obsoleteCode);
    }
    expect(after!.now_note.next).toContain('Vet the current acceptance-rubric criteria');
    expect(after!.now_note.next).not.toContain('repair seed');
    expect(after!.now_state).toBe(after!.now_note.state);
    expect(after!.now_next).toBe(after!.now_note.next);
  });

  it('authors an unstarted successor without changing the historical subject pin, and still refuses a pinned orphan', async () => {
    const seeded = await seedBarContract('successor-authoring-subject');
    await db.adminSql`UPDATE harness_shared.harness_plans SET status='superseded'
      WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.rubricSlug}`;
    const [historicalBefore] = await db.adminSql`SELECT content, version, status, template_data
      FROM harness_shared.harness_plans WHERE workspace_id=${seeded.workspaceId}
      AND harness_slug='papercusp' AND plan_slug=${seeded.rubricSlug}`;
    const [subjectBefore] = await db.adminSql`SELECT version, acceptance_bar_rubric_slug,
      acceptance_bar_rubric_revision, acceptance_bar_set_hash FROM harness_shared.harness_plans
      WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.subject}`;
    const successor = await rubrics.proposeRubric({
      rubricId: 'acceptance-successor-authoring',
      kind: 'acceptance',
      subjectPlan: seeded.subject,
      subjectHarnessSlug: 'papercusp',
      classRef: 'plan-class-feature-ship',
      characteristic: 'successor-authoring',
      title: 'Successor author preparation',
      criteria: [{
        key: 'successor-state', title: 'Successor state', model: 'The successor preserves its author procedure.',
        method: 'Read the preserved procedure.', driftMarkers: 'The preserved procedure is missing.',
        check: { kind: 'tests', files: ['packages/operator-core/lib/agent-tools/plans/rubric-loss-guard.test.ts'] },
      }],
      by: 'successor-author',
    });
    const amendment = {
      rubricId: successor.rubricId,
      criterion: { key: 'successor-state', field: 'method' as const, mode: 'append' as const,
        text: 'REPLICATION DRILL: read the stored author procedure through rubrics:get.' },
      expectedRubricRevision: successor.revision,
    };
    const authored = await rubrics.amendRubric(amendment);
    expect(authored?.criteria[0]?.method).toContain('REPLICATION DRILL');
    expect(authored?.barContract).toBeUndefined();
    const [historicalAfter] = await db.adminSql`SELECT content, version, status, template_data
      FROM harness_shared.harness_plans WHERE workspace_id=${seeded.workspaceId}
      AND harness_slug='papercusp' AND plan_slug=${seeded.rubricSlug}`;
    const [subjectAfter] = await db.adminSql`SELECT version, acceptance_bar_rubric_slug,
      acceptance_bar_rubric_revision, acceptance_bar_set_hash FROM harness_shared.harness_plans
      WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.subject}`;
    expect(historicalAfter).toEqual(historicalBefore);
    expect(subjectAfter).toEqual(subjectBefore);

    await db.adminSql`UPDATE harness_shared.harness_plans SET acceptance_bar_rubric_slug=${successor.rubricId}
      WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.subject}`;
    await expect(rubrics.amendRubric({ ...amendment, expectedRubricRevision: authored?.revision }))
      .rejects.toThrow(/missing its server-owned barContract/);
  });

  it('restores an orphaned started BAR contract from the pinned revision snapshot (WI-6554700010018395)', async () => {
    const seeded = await seedBarContract('orphan-restore-subject', { authorMethods: true });
    const started = await rubrics.getRubric(seeded.rubricSlug);
    if (!started?.revision || !started.barContract || !started.barSetHash) {
      throw new Error(`seeded rubric '${seeded.rubricSlug}' did not start a contract`);
    }
    const [pinBefore] = await db.adminSql`SELECT acceptance_bar_rubric_revision, acceptance_bar_set_hash
      FROM harness_shared.harness_plans WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp'
      AND plan_slug=${seeded.subject}`;
    expect(Number(pinBefore!.acceptance_bar_rubric_revision)).toBe(started.revision);
    expect(pinBefore!.acceptance_bar_set_hash).toBe(started.barSetHash);

    // A healthy contract is not a restore target: the flag is not a general rewrite door.
    await expect(rubrics.amendRubric({
      rubricId: seeded.rubricSlug, actorId: 'restorer', reason: 'not orphaned', restoreOrphanedBarContract: true,
    })).rejects.toThrow(/acceptance_bar_restore_not_orphaned/);

    // What a whole-document propose on a pre-guard build left behind (2026-10-18, :3070
    // d740fc3802): the next revision with the server-owned contract fields gone.
    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET template_data = (template_data - 'barContract' - 'barSetHash')
               || jsonb_build_object('criteria', (
                    SELECT jsonb_agg(c - 'barProvenance') FROM jsonb_array_elements(template_data->'criteria') c)),
             version = version + 1
       WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.rubricSlug}`;
    const orphan = await rubrics.getRubric(seeded.rubricSlug);
    expect(orphan?.barContract).toBeUndefined();
    expect(orphan?.revision).toBe(started.revision + 1);
    // Without the opt-in the guard still refuses every write to the orphan, and now names the door.
    await expect(rubrics.amendRubric({
      rubricId: seeded.rubricSlug,
      criterion: { key: started.criteria[0]!.key, field: 'method', mode: 'append', text: 'extra' },
    })).rejects.toThrow(/restoreOrphanedBarContract/);

    const restored = await rubrics.amendRubric({
      rubricId: seeded.rubricSlug, actorId: 'restorer', reason: 'restore the pinned contract',
      restoreOrphanedBarContract: true,
    });
    expect(restored?.revision).toBe(started.revision + 2);
    expect(restored?.barSetHash).toBe(started.barSetHash);
    expect(restored?.barContract?.adoptionEpoch).toBe(started.barContract.adoptionEpoch);
    expect(restored?.barContract?.cohort).toBe(started.barContract.cohort);
    expect(restored?.criteria.map((c) => [c.barKey, c.barHash])).toEqual(
      started.criteria.map((c) => [c.barKey, c.barHash]),
    );
    expect(restored?.criteria.every((c) => c.barProvenance !== undefined)).toBe(true);
    const [pinAfter] = await db.adminSql`SELECT acceptance_bar_rubric_revision, acceptance_bar_set_hash, content
      FROM harness_shared.harness_plans WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp'
      AND plan_slug=${seeded.subject}`;
    expect(Number(pinAfter!.acceptance_bar_rubric_revision)).toBe(started.revision + 2);
    expect(pinAfter!.acceptance_bar_set_hash).toBe(started.barSetHash);
    expect(String(pinAfter!.content)).toContain(`Restored-Contract-From: rubric revision ${started.revision}`);

    // Restored means restored: a second restore is refused, ordinary amendment works again.
    await expect(rubrics.amendRubric({
      rubricId: seeded.rubricSlug, actorId: 'restorer', reason: 'again', restoreOrphanedBarContract: true,
    })).rejects.toThrow(/acceptance_bar_restore_not_orphaned/);
  });

  it('resolves a legacy current revision after an in-place subject pin advance, still failing closed on grading drift (WI-10006667)', async () => {
    const seeded = await seedBarContract('legacy-subject-pin-advance');
    const current = await rubrics.getRubric(seeded.rubricSlug);
    if (!current?.revision) throw new Error(`seeded rubric '${seeded.rubricSlug}' did not resolve`);
    expect((await rubrics.getRubric(seeded.rubricSlug, current.revision))?.criteriaHash).toBe(current.criteriaHash);
    // Make the rubric's revision history legacy (no explicit rubricRevision stamp), so
    // only the current-version proof branch of getRubricAtRevision can resolve it.
    await db.adminSql`
      UPDATE harness_shared.plan_revisions
         SET content_snapshot = regexp_replace(content_snapshot, '\n  "rubricRevision": [0-9]+,', '', 'g')
       WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.rubricSlug}`;
    expect((await rubrics.getRubric(seeded.rubricSlug, current.revision))?.criteriaHash).toBe(current.criteriaHash);
    // The production writer (acceptance-bar-amendment.ts, advanceAcceptanceBarSubjectRevision)
    // advances ONLY this pin, in place, at the same rubric version and without a snapshot.
    const advancedPin = Number(current.barContract?.subjectPlanRevision ?? 1) + 7;
    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET template_data = jsonb_set(template_data, '{barContract,subjectPlanRevision}', to_jsonb(${advancedPin}::integer))
       WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.rubricSlug}`;
    const pinned = await rubrics.getRubric(seeded.rubricSlug, current.revision);
    expect(pinned?.revision).toBe(current.revision);
    expect(pinned?.criteriaHash).toBe(current.criteriaHash);
    expect(pinned?.barContract?.subjectPlanRevision).toBe(advancedPin);
    // An unrecorded grading change alongside the pin advance must still fail closed.
    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET template_data = jsonb_set(template_data, '{criteria,0,method}', '"Unrecorded new instructions"')
       WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.rubricSlug}`;
    expect(await rubrics.getRubric(seeded.rubricSlug, current.revision)).toBeNull();
  });

  it('rolls back both BAR plan rows and the first revision when the subject revision insert fails', async () => {
    const seeded = await seedBarContract('strict-bar-revision-failure-subject', { authorMethods: true });
    const rubric = await rubrics.getRubric(seeded.rubricSlug);
    if (!rubric) throw new Error(`seeded rubric '${seeded.rubricSlug}' did not resolve`);
    const [rubricBefore] = await db.adminSql`
      SELECT content, content_hash, version, template_data FROM harness_shared.harness_plans
       WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.rubricSlug}`;
    const [subjectBefore] = await db.adminSql`
      SELECT content, content_hash, version, acceptance_bar_rubric_revision, acceptance_bar_set_hash
        FROM harness_shared.harness_plans
       WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.subject}`;
    const planSlugs = [seeded.rubricSlug, seeded.subject];
    const revisionsBefore = await db.adminSql<{ plan_slug: string; seq: number; content_hash: string }[]>`
      SELECT plan_slug, seq, content_hash FROM harness_shared.plan_revisions
       WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp'
         AND plan_slug=ANY(${planSlugs}::text[]) ORDER BY plan_slug, seq`;
    const amendment = {
      rubricId: seeded.rubricSlug,
      actorId: 'revision-failure-amender',
      reason: 'Verify the two-plan write rolls back when revision capture fails.',
      criterion: {
        key: rubric.criteria[0]!.key,
        field: 'driftMarkers' as const,
        mode: 'replace' as const,
        text: 'The first outcome is missing after commit.',
      },
    };
    const approvalRef = await postApproval(amendment, 'outside-reviewer');

    await expect(
      withPlanRevisionInsertFailure(seeded.subject, () =>
        rubrics.amendRubric({ ...amendment, approvalRef, approvedBy: 'outside-reviewer' }),
      ),
    ).rejects.toThrow(/plan revision unavailable/);

    const [rubricAfter] = await db.adminSql`
      SELECT content, content_hash, version, template_data FROM harness_shared.harness_plans
       WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.rubricSlug}`;
    const [subjectAfter] = await db.adminSql`
      SELECT content, content_hash, version, acceptance_bar_rubric_revision, acceptance_bar_set_hash
        FROM harness_shared.harness_plans
       WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.subject}`;
    const revisionsAfter = await db.adminSql<{ plan_slug: string; seq: number; content_hash: string }[]>`
      SELECT plan_slug, seq, content_hash FROM harness_shared.plan_revisions
       WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp'
         AND plan_slug=ANY(${planSlugs}::text[]) ORDER BY plan_slug, seq`;
    expect(rubricAfter).toEqual(rubricBefore);
    expect(subjectAfter).toEqual(subjectBefore);
    expect(revisionsAfter).toEqual(revisionsBefore);
  });

  it('names the offending BAR and missing Requirements record in an amendment refusal', async () => {
    const seeded = await seedBarContract('amendment-missing-requirement');
    const [subject] = await db.adminSql<{ content: string }[]>`
      SELECT content FROM harness_shared.harness_plans
       WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp'
         AND plan_slug=${seeded.subject}`;
    const content = subject!.content.replace('| R-2 | P-002 | tree |', '| R-2 | P-002 | tree |\n| R-8 | P-001 | tree |');
    await db.adminSql`
      UPDATE harness_shared.harness_plans SET content=${content}, version=version+1
       WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp'
         AND plan_slug=${seeded.subject}`;

    await expect(rubrics.previewAcceptanceBarAmendment({
      rubricId: seeded.rubricSlug,
      actorId: 'missing-requirement-preview',
      reason: 'Diagnose an invalid BAR map before amending.',
      classRef: 'plan-class-feature-ship',
    })).rejects.toThrow(/acceptance_bar_amendment_mapping_invalid:bar_mapping_requirement_missing.*R-8.*no Requirements record/);
  });

  it('refuses a changed automated BAR without a test layer before approval or proof', async () => {
    const seeded = await seedBarContract('amendment-missing-proof-layer');
    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    const testsWithoutLayer = {
      rubricId: seeded.rubricSlug,
      actorId: 'method-author',
      reason: 'Bind the real unit check without declaring its proof layer.',
      criteria: before.criteria.map((criterion) => ({
        ...criterion,
        method: 'Run the focused unit test.',
        check: { kind: 'tests' as const, files: ['packages/operator-core/lib/acceptance-bar-seed.test.ts'] },
      })),
    };
    await expect(rubrics.previewAcceptanceBarAmendment(testsWithoutLayer)).rejects.toThrow(
      /acceptance_bar_amendment_test_layers_missing.*R-1.*requiredTestLayers/,
    );
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(before.revision);

    const withUnitLayer = {
      ...testsWithoutLayer,
      criteria: testsWithoutLayer.criteria.map((criterion) => ({
        ...criterion,
        requiredTestLayers: ['unit'],
      })),
    };
    const preview = await rubrics.previewAcceptanceBarAmendment(withUnitLayer);
    expect(preview?.changedBars).toEqual(['R-1', 'R-2']);
    expect(preview?.criterionChanges).toHaveLength(2);
    for (const change of preview!.criterionChanges!) {
      expect(change.before).toEqual(before.criteria.find((criterion) => criterion.barKey === change.barKey));
      expect(change.after).toMatchObject({
        barKey: change.barKey,
        method: 'Run the focused unit test.',
        requiredTestLayers: ['unit'],
        check: { kind: 'tests', files: ['packages/operator-core/lib/acceptance-bar-seed.test.ts'] },
      });
    }

    // WI-10006536: 'component' is not a layer the run ledger records, so it can never pass
    // correct-layer — refused at the amendment door, before approval or any revision write.
    const withComponentLayer = {
      ...testsWithoutLayer,
      criteria: testsWithoutLayer.criteria.map((criterion) => ({
        ...criterion,
        requiredTestLayers: ['component', 'unit'],
      })),
    };
    await expect(rubrics.previewAcceptanceBarAmendment(withComponentLayer)).rejects.toThrow(
      /acceptance_bar_amendment_test_layer_unrecordable.*R-1.*component/,
    );
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(before.revision);

    const manual = {
      ...testsWithoutLayer,
      criteria: testsWithoutLayer.criteria.map((criterion) => ({
        ...criterion,
        check: { kind: 'instrument' as const, instrumentKey: 'none' },
      })),
    };
    expect((await rubrics.previewAcceptanceBarAmendment(manual))?.changedBars).toEqual(['R-1', 'R-2']);

    const manualWithTestLayer = {
      ...manual,
      criteria: manual.criteria.map((criterion) => ({
        ...criterion,
        requiredTestLayers: ['unit'],
      })),
    };
    await expect(rubrics.previewAcceptanceBarAmendment(manualWithTestLayer)).rejects.toThrow(
      /acceptance_bar_amendment_check_layer_mismatch.*R-1.*explicitly manual.*unit/,
    );
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(before.revision);
  });

  it('refuses unit-only check files for an e2e BAR during preview before any revision write', async () => {
    const seeded = await seedBarContract('amendment-unit-check-e2e-layer');
    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    const unitCheckForE2e = {
      rubricId: seeded.rubricSlug,
      actorId: 'check-layer-preview-author',
      reason: 'A source unit test cannot discharge the declared end-to-end obligation.',
      criteria: before.criteria.map((criterion) => ({
        ...criterion,
        method: 'Run the declared end-to-end proof.',
        requiredTestLayers: ['e2e'],
        check: { kind: 'tests' as const, files: ['packages/operator-core/lib/acceptance-bar-seed.test.ts'] },
      })),
    };

    await expect(rubrics.previewAcceptanceBarAmendment(unitCheckForE2e)).rejects.toThrow(
      /acceptance_bar_amendment_check_layer_mismatch.*R-1.*e2e.*acceptance-bar-seed\.test\.ts is unit/,
    );
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(before.revision);
    const [subject] = await db.adminSql<{ version: number }[]>`
      SELECT version FROM harness_shared.harness_plans
       WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp'
         AND plan_slug=${seeded.subject}`;
    expect(subject!.version).toBe(before.barContract!.subjectPlanRevision);
  });

  // EI-24372605712471072: a BAR on a plan that has not started may name the test file its
  // own items will write. The seed already allowed that; amendment used to refuse it.
  describe('planned proof paths on an un-started subject plan', () => {
    const plannedTest = 'packages/operator-core/lib/planned-by-the-subject-plan-ei24372605712471072.test.ts';
    const bindPlanned = (
      rubricId: string,
      criteria: NonNullable<Awaited<ReturnType<typeof rubrics.getRubric>>>['criteria'],
    ) => ({
      rubricId,
      actorId: 'method-author',
      reason: 'Bind each BAR to the test file the plan will write.',
      criteria: criteria.map((criterion) => ({
        ...criterion,
        method: `Run the focused unit test in ${plannedTest}.`,
        check: { kind: 'tests' as const, files: [plannedTest] },
        requiredTestLayers: ['unit'],
      })),
    });

    it('a draft subject plan accepts the planned file, names it on the preview, and persists the check', async () => {
      const seeded = await seedBarContract('planned-proof-draft', { planStatus: 'draft' });
      const before = (await rubrics.getRubric(seeded.rubricSlug))!;
      const amendment = bindPlanned(seeded.rubricSlug, before.criteria);

      const preview = await rubrics.previewAcceptanceBarAmendment(amendment);
      expect(preview?.changedBars).toEqual(['R-1', 'R-2']);
      const planned = preview!.plannedPaths;
      expect(new Set(planned.map((p) => p.path))).toEqual(new Set([plannedTest]));
      expect(new Set(planned.map((p) => p.kind))).toEqual(new Set(['tests-check', 'method-citation']));

      const after = await rubrics.amendRubric({ ...amendment, approvalRef: await postApproval(amendment) });
      expect(after?.criteria.map((criterion) => criterion.check)).toEqual([
        { kind: 'tests', files: [plannedTest] },
        { kind: 'tests', files: [plannedTest] },
      ]);
    });

    it('a started subject plan still refuses the same amendment', async () => {
      const seeded = await seedBarContract('planned-proof-active');
      const before = (await rubrics.getRubric(seeded.rubricSlug))!;
      await expect(
        rubrics.previewAcceptanceBarAmendment(bindPlanned(seeded.rubricSlug, before.criteria)),
      ).rejects.toThrow(/invalid_args: proposeRubric:.*planned-by-the-subject-plan-ei24372605712471072/s);
      expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(before.revision);
    });
  });

  it('refuses a live-plane manual BAR changed to tests without a layer', async () => {
    const seeded = await seedBarContract('amendment-live-missing-proof-layer', { evidencePlane: 'live' });
    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    const manual: Parameters<typeof rubrics.amendRubric>[0] = {
      rubricId: seeded.rubricSlug,
      actorId: 'method-author',
      reason: 'Declare the live BARs explicitly manual.',
      criteria: before.criteria.map((criterion) => ({
        ...criterion,
        method: 'Inspect the live state.',
        check: { kind: 'instrument' as const, instrumentKey: 'none' },
      })),
    };
    await rubrics.amendRubric({ ...manual, approvalRef: await postApproval(manual) });
    const current = (await rubrics.getRubric(seeded.rubricSlug))!;
    expect(current.criteria[0]?.evidencePlane).toBe('live');
    expect(current.criteria[0]?.check).toEqual({ kind: 'instrument', instrumentKey: 'none' });

    const testsWithoutLayer: Parameters<typeof rubrics.previewAcceptanceBarAmendment>[0] = {
      rubricId: seeded.rubricSlug,
      actorId: 'method-author',
      reason: 'Change a live manual check to tests without declaring its proof layer.',
      requirement: {
        key: 'r-1',
        verification: {
          check: { kind: 'tests', files: ['packages/operator-core/lib/acceptance-bar-seed.test.ts'] },
        },
      },
    };
    await expect(rubrics.previewAcceptanceBarAmendment(testsWithoutLayer)).rejects.toThrow(
      /acceptance_bar_amendment_test_layers_missing.*R-1.*requiredTestLayers/,
    );
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(current.revision);
  });

  it('advances meaningRevision on a meaning-changing cross-plan amendment', async () => {
    const seeded = await seedBarContract('meaning-revision-change', { authorMethods: true });
    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    const priorMeaningRevision = before.barContract?.meaningRevision;
    expect(priorMeaningRevision).toBeGreaterThan(0);

    const amendment: Parameters<typeof rubrics.amendRubric>[0] = {
      rubricId: seeded.rubricSlug,
      actorId: 'meaning-author',
      reason: 'Change the declared BAR outcome meaning.',
      criteria: before.criteria.map((criterion) =>
        criterion.barKey === 'R-1'
          ? { ...criterion, driftMarkers: 'The revised outcome is absent.' }
          : criterion,
      ),
    };
    const after = await rubrics.amendRubric({
      ...amendment,
      approvalRef: await postApproval(amendment),
    });

    expect(after?.barContract?.meaningRevision).toBe(after?.revision);
    expect(after?.barContract?.meaningRevision).toBeGreaterThan(priorMeaningRevision!);
  });

  it.each(['active', 'accepted', 'exempt'] as const)(
    'activation re-audit preserves an unchanged %s clause and its exact evidence revision',
    async (lifecycleStatus) => {
      const { workspaceId, subject, rubricSlug } = await seedBarContract(`reaudit-${lifecycleStatus}`);
      const { listSpecClauses, setSpecClause, specClauseContentHash } =
        await import('./agent-tools/plans/spec-clauses-store');
      const { recordCurrentActivationAudit } = await import('./plan-audits');
      const scope = { harnessSlug: 'papercusp', planSlug: subject };
      const initial = await listSpecClauses(scope);
      expect(initial).toHaveLength(2);
      expect(initial.map((clause) => clause.lifecycleStatus)).toEqual(['draft', 'draft']);
      const draft = initial[0]!;
      const exemption =
        lifecycleStatus === 'exempt' ? { reason: 'This clause requires a non-automated review.' } : undefined;
      const write = {
        ...draft,
        ...scope,
        expectedRevision: draft.revision,
        lifecycleStatus,
        ...(exemption ? { exemption } : {}),
        actorId: 'clause-reviewer',
      };
      expect(await setSpecClause(write)).toMatchObject({ status: 'revised', revision: 2 });
      const before = await listSpecClauses(scope);
      const reviewed = before[0]!;
      expect(reviewed).toMatchObject({ lifecycleStatus, revision: 2, exemption: exemption ?? null });
      if (lifecycleStatus === 'exempt') {
        expect(reviewed).toMatchObject({ acceptedBy: null, acceptedAt: null });
      } else {
        expect(reviewed).toMatchObject({ acceptedBy: 'clause-reviewer' });
        expect(reviewed.acceptedAt).not.toBeNull();
      }
      // Permanent pre-fix control: the old re-audit projection either demoted
      // a reviewed clause or preserved `exempt` while dropping its paired
      // exemption payload. Both change the current evidence revision.
      const preFixReplay =
        lifecycleStatus === 'exempt'
          ? { ...write, exemption: undefined }
          : { ...write, lifecycleStatus: 'draft' as const };
      expect(specClauseContentHash(preFixReplay)).not.toBe(reviewed.contentHash);

      await db.adminSql`
        INSERT INTO harness_shared.plan_revisions
          (workspace_id, harness_slug, plan_slug, seq, content_hash, content_snapshot,
           rationale, author_kind, author_id, created_at)
        SELECT workspace_id, harness_slug, plan_slug, 1, content_hash, content,
               'activation fixture', 'agent', 'su-test', 1
          FROM harness_shared.harness_plans
         WHERE workspace_id=${workspaceId} AND harness_slug='papercusp' AND plan_slug=${subject}`;
      const rubricBefore = await rubrics.getRubric(rubricSlug);
      const audit = await recordCurrentActivationAudit({
        workspaceId,
        harnessSlug: 'papercusp',
        planSlug: subject,
        createdBy: 'audit-reviewer',
        classRef: 'plan-class-feature-ship',
        activation: {
          sourceRanges: [{ sourceKind: 'codex', sessionId: 'reaudit-fixture', fromTurn: 0, toTurn: 0 }],
          mappings: ['P-001', 'P-002'].map((item, index) => ({
            id: `M-00${index + 1}`,
            sourceRefs: ['session_turn:codex:reaudit-fixture:0'],
            requirement: `Preserve outcome ${index + 1}`,
            planTargets: [item],
            disposition: 'covered' as const,
          })),
          repairedOmissions: [],
          rejectedOrSuperseded: [],
          unresolvedBlockers: [],
        },
      });
      expect(audit.ok).toBe(true);
      // Exact equality includes the revision, content hash, acceptance author,
      // acceptance time, and the untouched sibling's draft lifecycle.
      expect(await listSpecClauses(scope)).toEqual(before);
      expect(await listSpecClauses({ ...scope, includeHistory: true })).toHaveLength(3);
      expect((await rubrics.getRubric(rubricSlug))?.revision).toBe(rubricBefore?.revision);
    },
  );

  it.each(['class', 'method'] as const)(
    'preserves authored atomic clauses across a %s-only rubric revision',
    async (change) => {
      const seeded = await seedBarContract(`atomic-preservation-${change}`);
      const { listSpecClauses, setSpecClause } = await import('./agent-tools/plans/spec-clauses-store');
      const scope = { harnessSlug: 'papercusp', planSlug: seeded.subject };
      const draft = (await listSpecClauses(scope))[0]!;
      const authored = {
        behavior: 'The selected task remains complete after restarting the application.',
        behaviorClass: 'lifecycle' as const,
        requiredEvidence: ['Restart the application and read the selected task.'],
        requiredTestLayers: ['e2e', 'integration'],
        falsifier: {
          observation: 'The completed task reopens after restart.',
          probeMethod: 'Restart after completing one task.',
        },
        lifecycleStatus: 'accepted' as const,
      };
      await setSpecClause({
        ...draft,
        ...scope,
        ...authored,
        expectedRevision: draft.revision,
        actorId: 'atomic-author',
      });
      const before = (await listSpecClauses(scope))[0]!;
      const rubricBefore = await rubrics.getRubric(seeded.rubricSlug);
      if (change === 'class') {
        // Re-affirm the SEEDED class, do not swap to a different one. amendRubric
        // deliberately refuses to REPLACE an existing acceptance class (rubrics.ts
        // — "an existing acceptance class cannot be replaced through this
        // amendment"): the class defines the bar-set the rubric inherits, so
        // swapping it mid-flight would invalidate the BAR contract. That guard
        // landed 2026-09-06 and this fixture predates it, which is why it began
        // refusing. A class-only revision is legal as an initial assignment or a
        // re-affirmation, and the re-affirmation still writes a full revision
        // (only an all-fields-undefined patch is "nothing to amend"), so this
        // keeps exercising what the test is named for: authored atomic clauses
        // surviving a rubric revision whose ONLY input is classRef.
        await rubrics.amendRubric({ rubricId: seeded.rubricSlug, classRef: 'plan-class-feature-ship' });
      } else {
        await rubrics.amendRubric({
          rubricId: seeded.rubricSlug,
          criterion: {
            key: rubricBefore!.criteria[0]!.key,
            field: 'method',
            mode: 'append',
            text: 'Inspect the restart evidence.',
          },
        });
      }
      const rubricAfter = await rubrics.getRubric(seeded.rubricSlug);
      const after = (await listSpecClauses(scope))[0]!;
      expect(rubricAfter!.barSetHash).toBe(rubricBefore!.barSetHash);
      expect(after).toMatchObject(authored);
      // P-001 keeps the clause's stable identity when only rubric-wide provenance changes.
      expect(after.sourceBar).toEqual(before.sourceBar);
      expect(after.acceptanceRef).toBe(before.acceptanceRef);
      expect(after.contentHash).toBe(before.contentHash);
      expect(after.revision).toBe(before.revision);
    },
  );

  // `check` rides with `layers`: both are verification contract (HOW the promise is
  // proven), so an amendment adding the structured check the ship gate demands must
  // not erase the atomic clause either (WI-10002563). model/falsifier/plane are
  // meaning changes and still re-project.
  it.each(['layers', 'check', 'model', 'falsifier', 'plane'] as const)(
    'preserves reviewed scenarios and causal pairing only for verification-contract changes (%s)',
    async (change) => {
      const alternateUnitCheck = 'packages/operator-core/lib/acceptance-bar-contract-completeness.test.ts';
      const seeded = await seedBarContract(`atomic-layer-preservation-${change}`, { authorMethods: true });
      const { listSpecClauses, setSpecClause } = await import('./agent-tools/plans/spec-clauses-store');
      const scope = { harnessSlug: 'papercusp', planSlug: seeded.subject };
      const draft = (await listSpecClauses(scope))[0]!;
      const authored = {
        behavior: 'The selected task remains complete after restarting the application.',
        behaviorClass: 'lifecycle' as const,
        requiredEvidence: ['tree', 'Restart the application and read the selected task.'],
        requiredTestLayers: ['e2e', 'integration'],
        mutationRequired: true,
        falsifier: {
          observation: 'The completed task reopens after restart.',
          probeMethod: 'Restart after completing one task; compare the broken and repaired cases.',
          causalPairing: 'one-to-one' as const,
          requiredScenarios: ['restart.broken', 'restart.repaired'],
        },
        lifecycleStatus: 'accepted' as const,
      };
      await setSpecClause({
        ...draft,
        ...scope,
        ...authored,
        expectedRevision: draft.revision,
        actorId: 'atomic-author',
      });
      const before = (await listSpecClauses(scope))[0]!;
      const rubricBefore = (await rubrics.getRubric(seeded.rubricSlug))!;
      const amendment = {
        rubricId: seeded.rubricSlug,
        actorId: 'amendment-actor',
        reason: 'Require unit and integration proof without replacing the reviewed behavior.',
        criteria: rubricBefore.criteria.map((criterion) =>
          criterion.barKey === before.sourceBar!.barKey
            ? {
                ...criterion,
                requiredTestLayers: ['unit', 'integration'],
                method: `${criterion.method}\nInspect unit and integration proof.`,
                ...(change === 'check'
                  ? { check: { kind: 'tests' as const, files: ['packages/operator-core/lib/rubrics.integration.test.ts', alternateUnitCheck] } }
                  : {}),
                ...(change === 'model' ? { model: 'The changed outcome holds.', bar: undefined } : {}),
                ...(change === 'falsifier' ? { driftMarkers: 'The changed outcome is absent.' } : {}),
                ...(change === 'plane' ? { evidencePlane: 'live' as const } : {}),
              }
            : criterion,
        ),
      };
      const rubricAfter = (await rubrics.amendRubric({ ...amendment, approvalRef: await postApproval(amendment) }))!;
      const after = (await listSpecClauses(scope)).find((clause) => clause.specId === before.specId)!;

      expect(rubricAfter.barSetHash).not.toBe(rubricBefore.barSetHash);
      if (change === 'check') {
        // The check really moved the BAR hash; preservation is not a no-op read.
        expect(rubricAfter.criteria.find((entry) => entry.barKey === before.sourceBar!.barKey)!.check)
          .toEqual({ kind: 'tests', files: ['packages/operator-core/lib/rubrics.integration.test.ts', alternateUnitCheck] });
      }
      if (change === 'layers' || change === 'check') {
        expect(after).toMatchObject({
          ...authored,
          requiredEvidence: before.requiredEvidence,
          requiredTestLayers: ['e2e', 'integration', 'unit'],
        });
      } else {
        const criterion = rubricAfter.criteria.find((entry) => entry.barKey === before.sourceBar!.barKey)!;
        expect(after.behavior).toBe(criterion.model);
        expect(after.falsifier).toEqual({ observation: criterion.driftMarkers });
        // WI-6554700010009658 replaces parent layers on every projection while
        // retaining the atomic clause's authored extras. A meaning change drops
        // its reviewed behavior/falsifier refinement, but not that extra e2e proof.
        expect(after.requiredTestLayers).toEqual(['e2e', 'integration', 'unit']);
        expect(after.behaviorClass).not.toBe('lifecycle');
        if (change === 'plane') expect(after.requiredEvidence).toContain('live');
      }
      expect(after.revision).toBe(before.revision + 1);
      expect(after.sourceBar).toMatchObject({
        rubricRevision: rubricAfter.revision,
        barSetHash: rubricAfter.barSetHash,
        barHash: rubricAfter.criteria.find((criterion) => criterion.barKey === before.sourceBar!.barKey)!.barHash,
      });
      expect(after.acceptanceRef).toBe(`${seeded.rubricSlug}@${rubricAfter.revision}:${before.sourceBar!.barKey}`);
      expect(
        (await listSpecClauses({ ...scope, includeHistory: true })).find(
          (clause) => clause.specId === before.specId && clause.revision === before.revision,
        ),
      ).toEqual({ ...before, currentRevision: after.revision });
      if (change === 'layers') {
        const replacement = {
          ...amendment,
          reason: 'Replace the canonical layers while retaining the atomic e2e requirement.',
          criteria: rubricAfter.criteria.map((criterion) =>
            criterion.barKey === before.sourceBar!.barKey
              // A RECORDED layer: 'component' (used here before WI-10006536) is now refused at
              // the amendment door because no test run can ever record it.
              ? { ...criterion, requiredTestLayers: ['unit'] }
              : criterion,
          ),
        };
        await rubrics.amendRubric({ ...replacement, approvalRef: await postApproval(replacement) });
        const replaced = (await listSpecClauses(scope)).find((clause) => clause.specId === before.specId)!;
        expect(replaced.requiredTestLayers).toEqual(['e2e', 'unit']);
        expect(replaced.behavior).toBe(before.behavior);
        expect(replaced.falsifier).toEqual(before.falsifier);
        expect(replaced.behaviorClass).toBe(before.behaviorClass);
      }
    },
  );

  it('previews a missing class bind without vetting an incomplete started BAR contract', async () => {
    const seeded = await seedBarContract('class-bind-preview-subject');
    const before = await rubrics.getRubric(seeded.rubricSlug);
    expect(before?.classRef).toBe('plan-class-feature-ship');

    // Model the repair this lane exists for: the acceptance contract has started,
    // but its class metadata was never persisted. The seeded fixture deliberately
    // leaves METHOD/check fields unfinished, as a draft plan does in production.
    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET template_data = template_data - 'classRef'
       WHERE workspace_id = ${seeded.workspaceId}
         AND harness_slug = 'papercusp'
         AND plan_slug = ${seeded.rubricSlug}`;
    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET status = 'draft'
       WHERE workspace_id = ${seeded.workspaceId}
         AND harness_slug = 'papercusp'
         AND plan_slug = ${seeded.subject}`;
    const [subject] = await db.adminSql<{ version: number }[]>`
      SELECT version
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${seeded.workspaceId}
         AND harness_slug = 'papercusp'
         AND plan_slug = ${seeded.subject}`;

    const preview = await rubrics.previewAcceptanceBarAmendment({
      rubricId: seeded.rubricSlug,
      actorId: 'class-bind-preview-actor',
      reason: 'Bind the plan class before spec-quality evaluation.',
      classRef: 'plan-class-feature-ship',
      expectedRubricRevision: before!.revision,
      expectedSubjectPlanRevision: Number(subject!.version),
    });

    expect(preview).toMatchObject({
      changedBars: [],
      approvalRequired: false,
      priorBarSetHash: before!.barSetHash,
      nextBarSetHash: before!.barSetHash,
      revisionMovement: {
        rubric: { from: before!.revision, to: before!.revision! + 1 },
        subject: { from: Number(subject!.version), to: Number(subject!.version) },
      },
    });
    expect(preview!.changes).not.toContainEqual(expect.objectContaining({ kind: 'meaning' }));
    expect((await rubrics.getRubric(seeded.rubricSlug))?.classRef).toBeUndefined();

    const applied = await rubrics.amendRubric({
      rubricId: seeded.rubricSlug,
      actorId: 'class-bind-preview-actor',
      classRef: 'plan-class-feature-ship',
      expectedRubricRevision: before!.revision,
    });
    expect(applied?.classRef).toBe('plan-class-feature-ship');
  });

  it.each(['plan-class-investigation', 'plan-class-general'])(
    'promotes adopted %s acceptance to shipment without losing BARs or prior standards',
    async (priorClass) => {
      const seeded = await seedBarContract(`class-promotion-${priorClass}`, { authorMethods: true });
      for (const ref of [priorClass, 'class-promotion-prior-standard']) {
        const [existing] = await db.adminSql`
          SELECT 1 FROM harness_shared.harness_plans
           WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${ref}`;
        if (!existing) await insertRubricPlan(ref, { workspaceId: seeded.workspaceId });
      }
      // Reproduce a research contract that has already adopted its BARs. The
      // repair must use the amendment writer rather than rebuild this document.
      await db.adminSql`
        UPDATE harness_shared.harness_plans
           SET template_data=template_data || ${JSON.stringify({
             classRef: priorClass, composes: ['class-promotion-prior-standard'],
           })}::text::jsonb
         WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp'
           AND plan_slug=${seeded.rubricSlug}`;
      const before = (await rubrics.getRubric(seeded.rubricSlug))!;
      const [subjectBefore] = await db.adminSql<{
        version: number; content: string; acceptance_bar_seeded_at: Date | string; acceptance_bar_seeded_by: string;
      }[]>`
        SELECT version, content, acceptance_bar_seeded_at, acceptance_bar_seeded_by FROM harness_shared.harness_plans
         WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.subject}`;
      const amendment = {
        rubricId: seeded.rubricSlug, actorId: 'class-promotion-actor',
        classRef: 'plan-class-feature-ship',
        reason: 'The research now includes customer implementation and verified shipment.',
        expectedRubricRevision: before.revision,
        expectedSubjectPlanRevision: Number(subjectBefore!.version),
      };
      const preview = await rubrics.previewAcceptanceBarAmendment(amendment);
      expect(preview).toMatchObject({
        changedBars: [], approvalRequired: false,
        priorBarSetHash: before.barSetHash, nextBarSetHash: before.barSetHash,
        revisionMovement: {
          rubric: { from: before.revision, to: before.revision! + 1 },
          subject: { from: Number(subjectBefore!.version), to: Number(subjectBefore!.version) },
        },
      });
      expect((await rubrics.getRubric(seeded.rubricSlug))?.classRef).toBe(priorClass);

      const after = (await rubrics.amendRubric(amendment))!;
      expect(after.classRef).toBe('plan-class-feature-ship');
      expect(after.composes).toEqual(['class-promotion-prior-standard', priorClass]);
      expect(after.criteria).toEqual(before.criteria);
      expect(after.barSetHash).toBe(before.barSetHash);
      // The prior semantic amendment advanced the subject's seed authority.
      // deriveContract canonicalizes these two fields from that subject row;
      // class promotion must retain the remaining adopted-contract identity.
      const seededAt = subjectBefore!.acceptance_bar_seeded_at;
      expect(after.barContract).toEqual({
        ...before.barContract,
        seededAt: seededAt instanceof Date ? seededAt.toISOString() : new Date(seededAt).toISOString(),
        seededBy: subjectBefore!.acceptance_bar_seeded_by,
      });
      expect(after.createdBy).toBe(before.createdBy);
      expect(after.status).toBe(before.status);
      expect(after.revision).toBe(before.revision! + 1);
      const [subjectAfter] = await db.adminSql<{
        version: number; content: string; acceptance_bar_rubric_revision: number; acceptance_bar_set_hash: string;
      }[]>`
        SELECT version, content, acceptance_bar_rubric_revision, acceptance_bar_set_hash
          FROM harness_shared.harness_plans
         WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.subject}`;
      expect(Number(subjectAfter!.version)).toBe(Number(subjectBefore!.version));
      expect(subjectAfter!.content).toBe(subjectBefore!.content);
      expect(Number(subjectAfter!.acceptance_bar_rubric_revision)).toBe(after.revision);
      expect(subjectAfter!.acceptance_bar_set_hash).toBe(before.barSetHash);
      await expect(rubrics.amendRubric({
        ...amendment, classRef: priorClass, expectedRubricRevision: after.revision,
        reason: 'Attempt to return to the exempt research profile.',
      })).rejects.toThrow(/existing acceptance class cannot be replaced/);
      expect((await rubrics.getRubric(seeded.rubricSlug))?.revision).toBe(after.revision);
    },
  );

  it('refuses a cross-plan dry-run for an unstarted legacy rubric instead of fabricating BAR hashes', async () => {
    const seeded = await seedBarContract('unstarted-dry-run-preview', { authorMethods: true });
    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET template_data = template_data - 'barContract' - 'barSetHash'
       WHERE workspace_id = ${seeded.workspaceId}
         AND harness_slug = 'papercusp'
         AND plan_slug = ${seeded.rubricSlug}`;

    await expect(
      rubrics.previewAcceptanceBarAmendment({
        rubricId: seeded.rubricSlug,
        actorId: 'legacy-preview-actor',
        reason: 'Narrow the falsifier without inventing a started contract.',
        criterion: {
          key: before.criteria[0]!.key,
          field: 'driftMarkers',
          mode: 'replace',
          text: 'The evidence package is incomplete or stale.',
        },
        expectedRubricRevision: before.revision,
      }),
    ).rejects.toThrow(/dryRun previews only the cross-plan transaction.*expectedRubricRevision/);

    const after = (await rubrics.getRubric(seeded.rubricSlug))!;
    expect(after.revision).toBe(before.revision);
    expect(after.criteria).toEqual(before.criteria);
  });

  it('previews the semantic amendment that repairs an audited pending subject-revision pin', async () => {
    const seeded = await seedBarContract('pending-subject-revision-amendment', { authorMethods: true });
    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    const [subjectBefore] = await db.adminSql<{ content: string; version: number }[]>`
      SELECT content, version
        FROM harness_shared.harness_plans
       WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp'
         AND plan_slug=${seeded.subject}`;
    const nextContent = subjectBefore!.content.replace(
      '**R-1 — First outcome.** The first outcome holds.',
      '**R-1 — First outcome.** The first outcome holds after the audited repair.',
    );
    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET content=${nextContent}, content_hash=md5(${nextContent}), version=version+1
       WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp'
         AND plan_slug=${seeded.subject}`;

    const { readAcceptanceBarContractSnapshot } = await import('./acceptance-bar-contract-snapshot');
    const stale = await readAcceptanceBarContractSnapshot(seeded.subject, {}, { harnessSlug: 'papercusp' });
    expect(stale.completeness.problems.map((problem) => problem.code)).toContain(
      'bar_snapshot_rubric_revision_mismatch',
    );

    const criteria = before.criteria.map((criterion) => {
      if (criterion.barKey !== 'R-1') return criterion;
      const { bar: _bar, barHash: _barHash, ...canonical } = criterion;
      return {
        ...canonical,
        model: 'First outcome. The first outcome holds after the audited repair.',
      };
    });
    const currentSubjectRevision = Number(subjectBefore!.version) + 1;
    const preview = await rubrics.previewAcceptanceBarAmendment({
      rubricId: seeded.rubricSlug,
      actorId: 'pending-amendment-actor',
      reason: 'Repair the audited subject revision and its acceptance BAR atomically.',
      expectedRubricRevision: before.revision,
      expectedSubjectPlanRevision: currentSubjectRevision,
      criteria,
    });

    expect(preview).toMatchObject({
      changedBars: ['R-1'],
      approvalRequired: true,
      revisionMovement: {
        rubric: { from: before.revision, to: before.revision! + 1 },
        subject: { from: currentSubjectRevision, to: currentSubjectRevision + 1 },
      },
    });
    expect(preview!.approval.bars).toEqual([
      expect.objectContaining({ barKey: 'R-1', priorBarHash: before.criteria[0]!.barHash }),
    ]);
    // Preview is read-only: the stored mismatch remains pending until an
    // outside-lineage approval authorizes the real amendment transaction.
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(before.revision);
    const [subjectAfter] = await db.adminSql<{ version: number }[]>`
      SELECT version
        FROM harness_shared.harness_plans
       WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp'
         AND plan_slug=${seeded.subject}`;
    expect(Number(subjectAfter!.version)).toBe(currentSubjectRevision);
  });

  it('rebinds terminal work items from superseded BAR revisions without rewriting history', async () => {
    const seeded = await seedBarContract('terminal-rebind-subject', { authorMethods: true });
    const { workspaceId, subject } = seeded;
    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    const explicitWorkItemId = 'WI-rubrics-terminal-rebind-explicit';
    const provenanceWorkItemId = 'WI-rubrics-terminal-rebind-provenance';

    // One terminal item is discoverable only through its existing historical edge;
    // the other is discoverable through canonical plan provenance. Both must be
    // carried forward when the BAR revision changes, even though neither item is
    // claimable anymore.
    await db.adminSql`
      DELETE FROM harness_shared.work_item_spec_revision_edges
       WHERE workspace_id=${workspaceId} AND harness_slug='papercusp'
         AND work_item_id = ANY(${[explicitWorkItemId, provenanceWorkItemId]}::text[])`;
    await db.adminSql`
      DELETE FROM harness_shared.work_items
       WHERE workspace_id=${workspaceId} AND harness_slug='papercusp'
         AND feature_id = ANY(${[explicitWorkItemId, provenanceWorkItemId]}::text[])`;
    await db.adminSql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, title, status,
         source_plan_slug, source_plan_item_ids, payload)
      VALUES
        (${workspaceId}, 'papercusp', ${explicitWorkItemId}, 'feature', 'Terminal explicit coverage', 'done',
         NULL, NULL, '{}'::jsonb),
        (${workspaceId}, 'papercusp', ${provenanceWorkItemId}, 'feature', 'Terminal provenance coverage', 'done',
         ${subject}, ARRAY['P-002'], ${JSON.stringify({ plan_item: { slug: subject, item: 'P-002' } })}::jsonb)`;
    await db.adminSql`
      INSERT INTO harness_shared.work_item_spec_revision_edges
        (workspace_id, harness_slug, work_item_id, plan_slug, spec_id,
         spec_revision, spec_fingerprint, created_by)
      SELECT c.workspace_id, c.harness_slug, ${explicitWorkItemId}, c.plan_slug,
             c.spec_id, c.current_revision, r.content_hash, 'terminal-rebind-fixture'
        FROM harness_shared.plan_spec_clauses c
        JOIN harness_shared.plan_spec_clause_revisions r
          ON r.workspace_id=c.workspace_id AND r.harness_slug=c.harness_slug
         AND r.plan_slug=c.plan_slug AND r.spec_id=c.spec_id AND r.revision=c.current_revision
       WHERE c.workspace_id=${workspaceId} AND c.harness_slug='papercusp'
         AND c.plan_slug=${subject} AND r.source_bar_key='R-1'`;
    await db.adminSql`
      INSERT INTO harness_shared.work_item_spec_revision_edges
        (workspace_id, harness_slug, work_item_id, plan_slug, spec_id,
         spec_revision, spec_fingerprint, created_by)
      SELECT c.workspace_id, c.harness_slug, ${provenanceWorkItemId}, c.plan_slug,
             c.spec_id, c.current_revision, r.content_hash, 'terminal-rebind-fixture'
        FROM harness_shared.plan_spec_clauses c
        JOIN harness_shared.plan_spec_clause_revisions r
          ON r.workspace_id=c.workspace_id AND r.harness_slug=c.harness_slug
         AND r.plan_slug=c.plan_slug AND r.spec_id=c.spec_id AND r.revision=c.current_revision
       WHERE c.workspace_id=${workspaceId} AND c.harness_slug='papercusp'
         AND c.plan_slug=${subject} AND r.source_bar_key='R-2'`;

    const priorEdges = await db.adminSql<{ work_item_id: string; spec_id: string; spec_revision: number }[]>`
      SELECT work_item_id, spec_id, spec_revision
        FROM harness_shared.work_item_spec_revision_edges
       WHERE workspace_id=${workspaceId} AND harness_slug='papercusp' AND plan_slug=${subject}
       ORDER BY work_item_id, spec_id`;
    expect(priorEdges).toHaveLength(2);

    const amendment = {
      rubricId: seeded.rubricSlug,
      actorId: 'terminal-rebind-actor',
      reason: 'Refresh terminal work-item coverage after a BAR meaning change.',
      criterion: {
        key: before.criteria[0]!.key,
        field: 'driftMarkers' as const,
        mode: 'replace' as const,
        text: 'The terminal coverage edge still points at a superseded BAR revision.',
      },
    };
    const after = await rubrics.amendRubric({
      ...amendment,
      approvalRef: await postApproval(amendment),
    });
    expect(after!.revision).toBe(before.revision! + 1);

    const edges = await db.adminSql<
      {
        work_item_id: string;
        spec_id: string;
        spec_revision: number;
        current_revision: number;
      }[]
    >`
      SELECT e.work_item_id, e.spec_id, e.spec_revision, c.current_revision
        FROM harness_shared.work_item_spec_revision_edges e
        JOIN harness_shared.plan_spec_clauses c
          ON c.workspace_id=e.workspace_id AND c.harness_slug=e.harness_slug
         AND c.plan_slug=e.plan_slug AND c.spec_id=e.spec_id
       WHERE e.workspace_id=${workspaceId} AND e.harness_slug='papercusp'
         AND e.plan_slug=${subject}
         AND e.work_item_id = ANY(${[explicitWorkItemId, provenanceWorkItemId]}::text[])
       ORDER BY e.work_item_id, e.spec_id, e.spec_revision`;
    // R-1 changed and gets a new edge beside its historical edge. R-2 kept its
    // stable revision, so its original terminal-work edge remains current.
    expect(edges).toHaveLength(3);
    expect(edges.filter((edge) => edge.spec_revision === edge.current_revision)).toEqual([
      expect.objectContaining({ work_item_id: explicitWorkItemId, spec_id: 'AUTO-BAR-R-1-P-001' }),
      expect.objectContaining({ work_item_id: provenanceWorkItemId, spec_id: 'AUTO-BAR-R-2-P-002' }),
    ]);
    expect(edges.filter((edge) => edge.spec_revision !== edge.current_revision)).toEqual([
      expect.objectContaining({ work_item_id: explicitWorkItemId, spec_id: 'AUTO-BAR-R-1-P-001' }),
    ]);
  });

  // EI-23454038580165889 / P-008. With P-001, an unchanged BAR no longer mints a
  // provenance-only clause revision, so its proof stays on the same current revision.
  // A changed BAR does mint a revision and must not inherit its old proof. These
  // assertions guard both sides of that stable-identity contract.
  it('keeps unchanged-bar proof on its stable clause revision and strands only the CHANGED bar (P-001/P-008)', async () => {
    const seeded = await seedBarContract('carry-unchanged-bar-evidence', { authorMethods: true });
    const { workspaceId, subject } = seeded;
    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    const changedSpecId = 'AUTO-BAR-R-1-P-001'; // R-1 — this bar's MEANING changes
    const unchangedSpecId = 'AUTO-BAR-R-2-P-002'; // R-2 — untouched; its proof must survive
    const changedWorkItemId = 'WI-carry-changed-bar';
    const unchangedWorkItemId = 'WI-carry-unchanged-bar';

    const readClauses = async () => {
      const rows = await db.adminSql<{ spec_id: string; revision: number; content_hash: string }[]>`
        SELECT c.spec_id, c.current_revision AS revision, r.content_hash
          FROM harness_shared.plan_spec_clauses c
          JOIN harness_shared.plan_spec_clause_revisions r
            ON r.workspace_id=c.workspace_id AND r.harness_slug=c.harness_slug
           AND r.plan_slug=c.plan_slug AND r.spec_id=c.spec_id AND r.revision=c.current_revision
         WHERE c.workspace_id=${workspaceId} AND c.harness_slug='papercusp'
           AND c.plan_slug=${subject} AND c.spec_id = ANY(${[changedSpecId, unchangedSpecId]}::text[])`;
      return new Map(rows.map((row) => [row.spec_id, { ...row, revision: Number(row.revision) }]));
    };
    const clauseBefore = await readClauses();
    expect([...clauseBefore.keys()].sort()).toEqual([changedSpecId, unchangedSpecId]);

    await db.adminSql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, item_kind, title, status,
         source_plan_slug, source_plan_item_ids, payload)
      VALUES
        (${workspaceId}, 'papercusp', ${changedWorkItemId}, 'feature', 'Changed bar coverage', 'done',
         ${subject}, ARRAY['P-001'], ${JSON.stringify({ plan_item: { slug: subject, item: 'P-001' } })}::jsonb),
        (${workspaceId}, 'papercusp', ${unchangedWorkItemId}, 'feature', 'Unchanged bar coverage', 'done',
         ${subject}, ARRAY['P-002'], ${JSON.stringify({ plan_item: { slug: subject, item: 'P-002' } })}::jsonb)
      ON CONFLICT DO NOTHING`;

    const { specEvidenceBindingFingerprint } = await import('./agent-tools/plans/spec-evidence-store');
    const observedAt = new Date('2026-09-10T00:00:00Z');
    const prover = 'carry-fixture-prover';
    for (const [specId, workItemId] of [
      [changedSpecId, changedWorkItemId],
      [unchangedSpecId, unchangedWorkItemId],
    ] as const) {
      const clause = clauseBefore.get(specId)!;
      // The binding FK points at the edge, so the edge must exist first.
      await db.adminSql`
        INSERT INTO harness_shared.work_item_spec_revision_edges
          (workspace_id,harness_slug,work_item_id,plan_slug,spec_id,spec_revision,spec_fingerprint,created_by)
        VALUES (${workspaceId},'papercusp',${workItemId},${subject},${specId},
                ${clause.revision},${clause.content_hash},'carry-fixture')
        ON CONFLICT DO NOTHING`;
      const canonical = {
        workspaceId,
        harnessSlug: 'papercusp',
        workItemId,
        planSlug: subject,
        specId,
        specRevision: clause.revision,
        specFingerprint: clause.content_hash,
        evidenceKind: 'test',
        evidenceRef: `vitest:${specId}`,
        sourceFingerprint: 'source-fingerprint-fixture',
        testFingerprint: 'test-fingerprint-fixture',
        fixtureFingerprint: null,
        rubricFingerprint: null,
        environmentFingerprint: null,
        coverageEvidenceRef: null,
        testRunId: null,
        details: {},
      };
      await db.adminSql`
        INSERT INTO harness_shared.spec_evidence_bindings
          (workspace_id,harness_slug,work_item_id,plan_slug,spec_id,spec_revision,spec_fingerprint,
           evidence_kind,evidence_ref,source_fingerprint,test_fingerprint,details,observed_at,
           binding_fingerprint,created_by)
        VALUES (${workspaceId},'papercusp',${workItemId},${subject},${specId},
                ${clause.revision},${clause.content_hash},'test',${`vitest:${specId}`},
                ${canonical.sourceFingerprint},${canonical.testFingerprint},'{}'::jsonb,${observedAt},
                ${specEvidenceBindingFingerprint(canonical as never)},${prover})`;
    }

    // Change EXACTLY ONE bar's meaning. R-2 is passed through byte-identically.
    const criteria = before.criteria.map((criterion) => {
      if (criterion.barKey !== 'R-1') return criterion;
      const { bar: _bar, barHash: _barHash, ...canonical } = criterion;
      return { ...canonical, model: 'First outcome. Rewritten so R-1 alone changes meaning.' };
    });
    const amendment = {
      rubricId: seeded.rubricSlug,
      actorId: 'carry-unchanged-actor',
      reason: 'Change one BAR so an unchanged BAR proof must survive the global re-projection.',
      criteria,
    };
    const preview = await rubrics.previewAcceptanceBarAmendment(amendment);
    expect(preview).toMatchObject({ changedBars: ['R-1'] });

    const after = await rubrics.amendRubric({ ...amendment, approvalRef: await postApproval(amendment) });
    expect(after!.revision).toBe(before.revision! + 1);

    const clauseAfter = await readClauses();
    // P-001 keeps the unchanged bar's clause revision stable; only R-1 gets a
    // new revision because its meaning changed.
    expect(clauseAfter.get(unchangedSpecId)!.revision).toBe(clauseBefore.get(unchangedSpecId)!.revision);
    expect(clauseAfter.get(changedSpecId)!.revision).toBeGreaterThan(clauseBefore.get(changedSpecId)!.revision);

    const bindings = await db.adminSql<
      {
        spec_id: string;
        spec_revision: number;
        binding_fingerprint: string;
        created_by: string;
        observed_at: Date;
      }[]
    >`
      SELECT spec_id, spec_revision, binding_fingerprint, created_by, observed_at
        FROM harness_shared.spec_evidence_bindings
       WHERE workspace_id=${workspaceId} AND harness_slug='papercusp' AND plan_slug=${subject}
       ORDER BY spec_id, spec_revision`;
    const at = (specId: string, revision: number) =>
      bindings.filter((row) => row.spec_id === specId && Number(row.spec_revision) === revision);

    // UNCHANGED bar: its proof remains bound to the same current clause revision.
    const preserved = at(unchangedSpecId, clauseAfter.get(unchangedSpecId)!.revision);
    expect(preserved).toHaveLength(1);
    // CHANGED bar: different meaning, so its proof is NOT carried and must be re-run.
    expect(at(changedSpecId, clauseAfter.get(changedSpecId)!.revision)).toHaveLength(0);
    // Append-only: both originals survive at their old revisions.
    expect(at(unchangedSpecId, clauseBefore.get(unchangedSpecId)!.revision)).toHaveLength(1);
    expect(at(changedSpecId, clauseBefore.get(changedSpecId)!.revision)).toHaveLength(1);

    // The unchanged proof stays attached to its original fingerprint because
    // the clause revision did not move.
    const nextClause = clauseAfter.get(unchangedSpecId)!;
    expect(preserved[0]!.binding_fingerprint).toBe(
      specEvidenceBindingFingerprint({
        workspaceId,
        harnessSlug: 'papercusp',
        workItemId: unchangedWorkItemId,
        planSlug: subject,
        specId: unchangedSpecId,
        specRevision: nextClause.revision,
        specFingerprint: nextClause.content_hash,
        evidenceKind: 'test',
        evidenceRef: `vitest:${unchangedSpecId}`,
        sourceFingerprint: 'source-fingerprint-fixture',
        testFingerprint: 'test-fingerprint-fixture',
        fixtureFingerprint: null,
        rubricFingerprint: null,
        environmentFingerprint: null,
        coverageEvidenceRef: null,
        testRunId: null,
        details: {},
      } as never),
    );

    // The proof was observed when it was observed: the carry is not a new
    // observation by the amending actor.
    expect(new Date(preserved[0]!.observed_at).toISOString()).toBe(observedAt.toISOString());
    expect(preserved[0]!.created_by).toBe(prover);
  });

  it('applies an identical METHOD edit through the amendment transaction when stored BAR hashes are legacy', async () => {
    const seeded = await seedBarContract('legacy-hash-method-apply', { authorMethods: true });
    const { workspaceId, subject } = seeded;
    const canonical = (await rubrics.getRubric(seeded.rubricSlug))!;
    const [stored] = await db.adminSql<{ template_data: { criteria: Array<Record<string, unknown>> } }[]>`
      SELECT template_data FROM harness_shared.harness_plans
       WHERE workspace_id=${workspaceId} AND harness_slug='papercusp'
         AND plan_slug=${seeded.rubricSlug}`;
    const { hashPlanContent } = await import('./agent-tools/plans/content-hash');
    const legacyHashByBar = new Map(
      canonical.criteria.map((criterion) => [
        criterion.barKey!,
        rubrics.computeAcceptanceBarHash({ ...criterion, check: undefined }),
      ]),
    );
    const legacyBarSetHash = hashPlanContent(
      JSON.stringify([...legacyHashByBar.entries()].sort(([a], [b]) => a.localeCompare(b))),
    );
    const legacyTemplateData = {
      ...stored!.template_data,
      criteria: stored!.template_data.criteria.map((criterion) => ({
        ...criterion,
        barHash: legacyHashByBar.get(String(criterion.barKey ?? criterion.key)),
      })),
      barSetHash: legacyBarSetHash,
    };
    const { listSpecClauses, setSpecClause } = await import('./agent-tools/plans/spec-clauses-store');
    const clauses = await listSpecClauses({ harnessSlug: 'papercusp', planSlug: subject });
    await db.adminSql.begin(async (tx) => {
      await tx`
        UPDATE harness_shared.harness_plans
           SET template_data=${JSON.stringify(legacyTemplateData)}::text::jsonb
         WHERE workspace_id=${workspaceId} AND harness_slug='papercusp'
           AND plan_slug=${seeded.rubricSlug}`;
      await tx`
        UPDATE harness_shared.harness_plans
           SET acceptance_bar_set_hash=${legacyBarSetHash}
         WHERE workspace_id=${workspaceId} AND harness_slug='papercusp'
           AND plan_slug=${subject}`;
      for (const clause of clauses) {
        const result = await setSpecClause(
          {
            ...clause,
            planSlug: subject,
            expectedRevision: clause.revision,
            sourceBar: {
              ...clause.sourceBar!,
              barHash: legacyHashByBar.get(clause.sourceBar!.barKey)!,
              barSetHash: legacyBarSetHash,
            },
            actorId: 'legacy-hash-fixture',
          },
          { executor: tx as never, workspaceId, harnessSlug: 'papercusp' },
        );
        expect(result.status).toBe('revised');
      }
    });

    const legacy = (await rubrics.getRubric(seeded.rubricSlug))!;
    expect(legacy.barSetHash).toBe(legacyBarSetHash);
    expect(legacy.criteria.map((criterion) => criterion.barHash)).not.toEqual(
      canonical.criteria.map((criterion) => criterion.barHash),
    );
    const amendment = {
      rubricId: seeded.rubricSlug,
      actorId: 'hash-migration-author',
      reason: 'Recompute legacy BAR hashes under the current canonical algorithm.',
      expectedRubricRevision: legacy.revision,
      criterion: {
        key: legacy.criteria[0]!.key,
        field: 'method' as const,
        mode: 'replace' as const,
        text: legacy.criteria[0]!.method!,
      },
    };
    const preview = await rubrics.previewAcceptanceBarAmendment(amendment);
    expect(preview).toMatchObject({ approvalRequired: true, changedBars: ['R-1', 'R-2'] });

    const applied = (await rubrics.amendRubric({
      ...amendment,
      approvalRef: await postApproval(amendment),
    }))!;
    expect(applied.revision).toBe(legacy.revision! + 1);
    expect(applied.barSetHash).toBe(canonical.barSetHash);
    expect(applied.criteria.map((criterion) => criterion.barHash)).toEqual(
      canonical.criteria.map((criterion) => criterion.barHash),
    );
  });

  async function explicitAmendmentSubject(subject: string, evidencePlane?: 'tree' | 'live') {
    const seeded = await seedBarContract(subject, { authorMethods: true, evidencePlane });
    const rubric = (await rubrics.getRubric(seeded.rubricSlug))!;
    const [row] = await db.adminSql<{ content: string; version: number }[]>`SELECT content, version
      FROM harness_shared.harness_plans WHERE workspace_id=${seeded.workspaceId}
      AND harness_slug='papercusp' AND plan_slug=${subject}`;
    let content = row!.content;
    for (const [index, criterion] of rubric.criteria.entries()) {
      const sections = {
        intent: { request: `Retain outcome ${index + 1}.`, sourceRefs: ['session_turn:fixture'] },
        acceptance: { condition: criterion.model, falsifier: criterion.driftMarkers,
          requiredScope: criterion.requiredScope, evidencePlane: criterion.evidencePlane,
          requiredTestLayers: criterion.requiredTestLayers },
        verification: { method: criterion.method, check: criterion.check },
      };
      content = content.replace(
        `**R-${index + 1} — ${index === 0 ? 'First' : 'Second'} outcome.** The ${index === 0 ? 'first' : 'second'} outcome holds.`,
        `**R-${index + 1} — ${index === 0 ? 'First' : 'Second'} outcome.**\n\`\`\`requirement\n${JSON.stringify(sections)}\n\`\`\``,
      );
    }
    await db.adminSql`UPDATE harness_shared.harness_plans SET content=${content}, content_hash=${hashPlanContent(content)}
      WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${subject}`;
    return { ...seeded, rubric, content, subjectRevision: Number(row!.version) };
  }

  it('EI-267115: reads the contract snapshot before holding either amendment plan lock', async () => {
    const seeded = await explicitAmendmentSubject('snapshot-outside-amendment-transaction');
    const snapshots = await import('./acceptance-bar-contract-snapshot');
    const phases: string[] = [];
    let lockAvailability: boolean[] = [];
    const stop = new Error('snapshot-boundary-measured');
    const reader = vi.spyOn(snapshots, 'readAcceptanceBarContractSnapshot').mockImplementationOnce(async () => {
      lockAvailability = await db.adminSql.begin(async (tx) => {
        const availability: boolean[] = [];
        for (const slug of [seeded.rubricSlug, seeded.subject]) {
          const [row] = await tx<{ available: boolean }[]>`SELECT pg_try_advisory_xact_lock(
            hashtext(${PLAN_ADVISORY_LOCK_NAMESPACE}),
            hashtext(${planAdvisoryLockKey(seeded.workspaceId, 'papercusp', slug)})) AS available`;
          availability.push(row!.available);
        }
        return availability;
      });
      throw stop;
    });
    try {
      await expect(rubrics.amendRubric({
        rubricId: seeded.rubricSlug, actorId: 'snapshot-boundary-author',
        reason: 'Measure the independent snapshot reader transaction boundary.',
        expectedRubricRevision: seeded.rubric.revision,
        expectedSubjectPlanRevision: seeded.subjectRevision,
        criterion: { key: seeded.rubric.criteria[0]!.key, field: 'method', mode: 'replace',
          text: 'Run the updated deterministic fixture.' },
        onPhase: (phase) => phases.push(phase),
      })).rejects.toThrow(stop);
      expect(reader).toHaveBeenCalledOnce();
      expect(phases.at(-1)).toBe('acceptance-contract-snapshot');
      expect(lockAvailability).toEqual([true, true]);
    } finally {
      reader.mockRestore();
    }
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(seeded.rubric.revision);
  });

  it('EI-267115: survives a real PostgreSQL idle-transaction timeout during independent snapshot reads', async () => {
    const seeded = await explicitAmendmentSubject('snapshot-idle-timeout');
    const amendment = {
      rubricId: seeded.rubricSlug, actorId: 'snapshot-idle-author',
      reason: 'Keep independent snapshot work outside the guarded amendment transaction.',
      expectedRubricRevision: seeded.rubric.revision,
      expectedSubjectPlanRevision: seeded.subjectRevision,
      criterion: { key: seeded.rubric.criteria[0]!.key, field: 'method' as const, mode: 'replace' as const,
        text: 'Run the updated deterministic idle-timeout fixture.' },
    };
    const approvalRef = await postApproval(amendment);
    // Calibrate the failure mechanism on the real server, independent of the
    // amender. This fixture changes only its own transaction-local setting.
    await expect(db.adminSql.begin(async (tx) => {
      await tx`SELECT set_config('idle_in_transaction_session_timeout', '1000ms', true)`;
      await db.adminSql`SELECT pg_sleep(2)`;
      await tx`SELECT 1`;
    })).rejects.toThrow(/CONNECTION_CLOSED|idle-in-transaction timeout/i);

    const snapshots = await import('./acceptance-bar-contract-snapshot');
    const originalRead = snapshots.readAcceptanceBarContractSnapshot;
    const phases: string[] = [];
    const snapshotPhases: Array<string | undefined> = [];
    const snapshotLockAvailability: boolean[][] = [];
    const reader = vi.spyOn(snapshots, 'readAcceptanceBarContractSnapshot').mockImplementation(async (...args) => {
      const phase = phases.at(-1);
      snapshotPhases.push(phase);
      snapshotLockAvailability.push(await db.adminSql.begin(async (tx) => {
        const availability: boolean[] = [];
        for (const slug of [seeded.rubricSlug, seeded.subject]) {
          const [row] = await tx<{ available: boolean }[]>`SELECT pg_try_advisory_xact_lock(
            hashtext(${PLAN_ADVISORY_LOCK_NAMESPACE}),
            hashtext(${planAdvisoryLockKey(seeded.workspaceId, 'papercusp', slug)})) AS available`;
          availability.push(row!.available);
        }
        return availability;
      }));
      try {
        const snapshot = await originalRead(...args);
        if (phase === 'acceptance-contract-snapshot') await db.adminSql`SELECT pg_sleep(2)`;
        return snapshot;
      } finally {
        // With preparation outside the transaction the subsequent write uses
        // its normal production guard; never widen that guard to pass the test.
        h.shortIdleTimeoutMs = undefined;
      }
    });
    h.shortIdleTimeoutMs = 1000;
    try {
      const after = (await rubrics.amendRubric({ ...amendment, approvalRef,
        onPhase: (phase) => phases.push(phase),
      }))!;
      // The second read refreshes Now after the amendment commits. Both reads
      // must stay outside the guarded transaction and its two advisory locks.
      expect(reader).toHaveBeenCalledTimes(2);
      expect(snapshotPhases).toEqual(['acceptance-contract-snapshot', 'acceptance-now-readiness-refresh']);
      expect(snapshotLockAvailability).toEqual([[true, true], [true, true]]);
      expect(after.revision).toBe(seeded.rubric.revision! + 1);
      expect(after.criteria[0]!.method).toBe(amendment.criterion.text);
      const [subject] = await db.adminSql<{ version: number }[]>`SELECT version
        FROM harness_shared.harness_plans WHERE workspace_id=${seeded.workspaceId}
          AND harness_slug='papercusp' AND plan_slug=${seeded.subject}`;
      expect(Number(subject!.version)).toBe(seeded.subjectRevision + 1);
    } finally {
      h.shortIdleTimeoutMs = undefined;
      reader.mockRestore();
    }
  });

  it.each(['subject', 'rubric', 'clause', 'item', 'composition'] as const)(
    'EI-267115: refuses a stale %s source after independent snapshot preparation without amendment writes', async (source) => {
      const seeded = await explicitAmendmentSubject(`snapshot-race-${source}`);
      const composition = source === 'composition'
        ? (await rubrics.proposeRubric({ rubricId: 'snapshot-race-parent', characteristic: 'snapshot-race-parent',
            title: 'Reusable snapshot parent', criteria: sampleCriteria, by: 'snapshot-parent-author' })).rubricId
        : undefined;
      const snapshots = await import('./acceptance-bar-contract-snapshot');
      const originalRead = snapshots.readAcceptanceBarContractSnapshot;
      let sourcesAfterRace: unknown;
      const readPlans = () => db.adminSql`SELECT plan_slug, content, content_hash, version, template_data
        FROM harness_shared.harness_plans WHERE workspace_id=${seeded.workspaceId}
          AND harness_slug='papercusp' AND plan_slug=ANY(${[seeded.subject, seeded.rubricSlug]}::text[])
        ORDER BY plan_slug`;
      const reader = vi.spyOn(snapshots, 'readAcceptanceBarContractSnapshot').mockImplementationOnce(async (...args) => {
        const snapshot = await originalRead(...args);
        if (source === 'subject' || source === 'rubric') {
          const slug = source === 'subject' ? seeded.subject : seeded.rubricSlug;
          await db.adminSql`UPDATE harness_shared.harness_plans SET version=version+1
            WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${slug}`;
        } else if (source === 'clause') {
          const { listSpecClauses, setSpecClause } = await import('./agent-tools/plans/spec-clauses-store');
          const scope = { harnessSlug: 'papercusp', planSlug: seeded.subject };
          const clause = (await listSpecClauses(scope))[0]!;
          const changed = await setSpecClause({ ...clause, ...scope, expectedRevision: clause.revision,
            behavior: `${clause.behavior} Concurrent source change.`, actorId: 'snapshot-race-author' });
          expect(changed.status).toBe('revised');
        } else if (source === 'item') {
          await db.adminSql`UPDATE harness_shared.plan_items SET status='dropped'
            WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp'
              AND plan_slug=${seeded.subject} AND item_id='P-001'`;
        } else {
          await db.adminSql`UPDATE harness_shared.harness_plans SET version=version+1
            WHERE workspace_id=${seeded.workspaceId} AND plan_slug=${composition!}`;
        }
        sourcesAfterRace = [...await readPlans()];
        return snapshot;
      });
      // A deliberately regressed transaction boundary must fail promptly:
      // otherwise its independent UPDATE can wait behind its own plan lock
      // until Vitest times out and strands the following fixture cleanup.
      h.shortIdleTimeoutMs = 1000;
      try {
        await expect(rubrics.amendRubric({ rubricId: seeded.rubricSlug, actorId: 'snapshot-race-author',
          reason: 'Revalidate every governing source after independent reads.',
          ...(composition ? { composes: [composition] } : {}),
          criterion: { key: seeded.rubric.criteria[0]!.key, field: 'method', mode: 'replace',
            text: 'Run the updated deterministic fixture.' },
        })).rejects.toThrow('acceptance_bar_amendment_revision_conflict');
        expect(reader).toHaveBeenCalledOnce();
      } finally {
        h.shortIdleTimeoutMs = undefined;
        reader.mockRestore();
      }
      expect([...await readPlans()]).toEqual(sourcesAfterRace);
    },
  );

  it('EI-261580: persists a provenance-only amendment with its authenticated authority', async () => {
    const seeded = await explicitAmendmentSubject('provenance-only-amendment-subject');
    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    if (before.revision === undefined) throw new Error('The persisted rubric must have a revision');
    expect(before.criteria.map((criterion) => criterion.barProvenance?.lifecycle)).toEqual([
      'pre-implementation', 'pre-implementation',
    ]);
    const criteria = before.criteria.map((criterion) => ({
      ...criterion,
      barProvenance: { ...criterion.barProvenance!, lifecycle: 'legacy-backfilled' as const },
    }));
    const amendment = {
      rubricId: seeded.rubricSlug,
      actorId: 'provenance-correction-author',
      reason: 'Correct the post-implementation declaration without changing the acceptance promise.',
      expectedRubricRevision: before.revision,
      expectedSubjectPlanRevision: seeded.subjectRevision,
      idempotencyKey: 'provenance-only-amendment',
      criteria,
    };
    expect(await rubrics.previewAcceptanceBarAmendment(amendment)).toMatchObject({
      changedBars: [], approvalRequired: false, nextBarSetHash: before.barSetHash,
      revisionMovement: {
        rubric: { from: before.revision, to: before.revision + 1 },
        subject: { from: seeded.subjectRevision, to: seeded.subjectRevision + 1 },
      },
    });
    await expect(rubrics.amendRubric({ ...amendment, faultInjection: 'after-rubric' })).rejects.toThrow();
    expect((await rubrics.getRubric(seeded.rubricSlug))!.criteria).toEqual(before.criteria);

    const amended = (await rubrics.amendRubric(amendment))!;
    const reread = (await rubrics.getRubric(seeded.rubricSlug))!;
    expect(amended.criteria.map((criterion) => criterion.barProvenance)).toEqual(
      before.criteria.map((criterion) => ({ ...criterion.barProvenance!, lifecycle: 'legacy-backfilled' })),
    );
    expect(reread.criteria).toEqual(amended.criteria);
    expect(reread.barSetHash).toBe(before.barSetHash);
    expect(reread.barContract!.meaningRevision).toBe(before.barContract!.meaningRevision);
    expect((await rubrics.amendRubric(amendment))!.revision).toBe(reread.revision);
  });

  it('repairs a stale canonical map without amending the rubric or disturbing proof projections', async () => {
    const seeded = await explicitAmendmentSubject('stale-map-repair-subject', 'live');
    const { validateAcceptanceBarSource } = await import('./acceptance-bar-seed');
    const staleContent = seeded.content.replace('| R-1 | P-001 | live |', '| R-1 | P-001 | tree |');
    expect(staleContent).not.toBe(seeded.content);
    expect(validateAcceptanceBarSource(staleContent).ok).toBe(false);
    await db.adminSql`UPDATE harness_shared.harness_plans SET content=${staleContent}, content_hash=${hashPlanContent(staleContent)}
      WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.subject}`;
    const projections = () => db.adminSql`SELECT * FROM harness_shared.plan_spec_clause_revisions
      WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.subject}
      ORDER BY spec_id, revision`;
    const beforeProjections = await projections();
    const repair = { rubricId: seeded.rubricSlug, actorId: 'projection-repair-author',
      reason: 'Repair the stale map from the unchanged canonical contract.', criteria: seeded.rubric.criteria,
      expectedRubricRevision: seeded.rubric.revision, expectedSubjectPlanRevision: seeded.subjectRevision };
    expect(await rubrics.previewAcceptanceBarAmendment(repair)).toMatchObject({
      changedBars: [], approvalRequired: false,
      revisionMovement: { rubric: { from: seeded.rubric.revision, to: seeded.rubric.revision },
        subject: { from: seeded.subjectRevision, to: seeded.subjectRevision + 1 } },
      invalidatedScorecardIds: [],
    });
    await expect(rubrics.amendRubric({ ...repair, faultInjection: 'after-rubric' })).rejects.toThrow();
    const [rollback] = await db.adminSql`SELECT content, version FROM harness_shared.harness_plans
      WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.subject}`;
    expect(rollback!.content).toBe(staleContent);
    expect(Number(rollback!.version)).toBe(seeded.subjectRevision);
    const after = (await rubrics.amendRubric(repair))!;
    expect(after).toMatchObject({ revision: seeded.rubric.revision, criteria: seeded.rubric.criteria,
      barSetHash: seeded.rubric.barSetHash,
      barContract: { ...seeded.rubric.barContract, subjectPlanRevision: seeded.subjectRevision + 1 } });
    expect(await projections()).toEqual(beforeProjections);
    const [row] = await db.adminSql`SELECT content, version FROM harness_shared.harness_plans
      WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.subject}`;
    expect(row!.content).toBe(seeded.content);
    expect(Number(row!.version)).toBe(seeded.subjectRevision + 1);
    expect(validateAcceptanceBarSource(row!.content).ok).toBe(true);
    await rubrics.amendRubric({ ...repair, expectedSubjectPlanRevision: seeded.subjectRevision + 1 });
    const [again] = await db.adminSql`SELECT version FROM harness_shared.harness_plans
      WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.subject}`;
    expect(Number(again!.version)).toBe(seeded.subjectRevision + 1);
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(seeded.rubric.revision);
  });

  it.each(['meaning', 'method'] as const)('WI-6554700010017552: preserves unrelated historical source during a targeted %s amendment', async (kind) => {
    const seeded = await explicitAmendmentSubject(`preserve-historical-${kind}-subject`);
    const historical = seeded.content.replace('The second outcome holds.', 'The historical second outcome includes retained snapshots.');
    expect(historical).not.toBe(seeded.content);
    const protectedBlock = (content: string) => {
      const start = content.indexOf('**R-2 — Second outcome.**');
      expect(start).toBeGreaterThan(-1);
      const end = content.indexOf('\n## ', start);
      return content.slice(start, end < 0 ? undefined : end);
    };
    await db.adminSql`UPDATE harness_shared.harness_plans SET content=${historical}, content_hash=${hashPlanContent(historical)}
      WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.subject}`;
    const amendment = {
      rubricId: seeded.rubricSlug, actorId: 'targeted-amendment-author', reason: 'Change only the first requirement; retain the second historical source.',
      expectedRubricRevision: seeded.rubric.revision, expectedSubjectPlanRevision: seeded.subjectRevision,
      criterion: { key: seeded.rubric.criteria[0]!.key, field: kind === 'meaning' ? 'model' as const : 'method' as const,
        mode: 'replace' as const, text: kind === 'meaning' ? 'The first amended outcome holds.' : 'Run the first updated fixture and retain its result.' },
    };
    const preview = await rubrics.previewAcceptanceBarAmendment(amendment);
    expect(preview).toMatchObject({ requirementsDrift: {
      rerenderedOnApply: ['R-1'],
      entries: expect.arrayContaining([{ barKey: 'R-2', changedByAmendment: false, kind: 'text-differs', fields: ['model'] }]),
    } });
    await rubrics.amendRubric({ ...amendment, ...(kind === 'meaning' ? { approvalRef: await postApproval(amendment) } : {}) });
    const [row] = await db.adminSql`SELECT content FROM harness_shared.harness_plans
      WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.subject}`;
    expect(protectedBlock(row!.content)).toBe(protectedBlock(historical));
    expect(row!.content).toContain(amendment.criterion.text);
    const after = (await rubrics.getRubric(seeded.rubricSlug))!;
    expect(after.criteria[1]).toEqual(seeded.rubric.criteria[1]);
  });

  it('repairs stale explicit Requirements on an unchanged amendment without changing BAR meaning', async () => {
    const seeded = await explicitAmendmentSubject('stale-requirement-repair-subject');
    const { parseRequirementBars } = await import('./acceptance-bar-seed');
    const original = parseRequirementBars(seeded.content);
    expect(original.ok).toBe(true);
    const staleContent = seeded.content.replace(
      JSON.stringify({ method: seeded.rubric.criteria[0]!.method, check: seeded.rubric.criteria[0]!.check }),
      JSON.stringify({ method: 'Superseded verification procedure.', check: { kind: 'instrument', instrumentKey: 'none' } }),
    );
    expect(staleContent).not.toBe(seeded.content);
    await db.adminSql`UPDATE harness_shared.harness_plans
      SET content=${staleContent}, content_hash=${hashPlanContent(staleContent)}
      WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.subject}`;
    const amendment = {
      rubricId: seeded.rubricSlug, actorId: 'projection-repair-author',
      reason: 'Repair an older amendment writer\'s stale Requirements from the canonical rubric.',
      expectedRubricRevision: seeded.rubric.revision, expectedSubjectPlanRevision: seeded.subjectRevision,
      criteria: seeded.rubric.criteria,
    };
    expect(await rubrics.previewAcceptanceBarAmendment(amendment)).toMatchObject({
      changedBars: [], approvalRequired: false, requirementsDrift: { rerenderedOnApply: ['R-1'] },
      revisionMovement: { subject: { from: seeded.subjectRevision, to: seeded.subjectRevision + 1 } },
    });
    await expect(rubrics.amendRubric({ ...amendment, faultInjection: 'after-rubric' })).rejects.toThrow();
    const [rolledBack] = await db.adminSql`SELECT content, version FROM harness_shared.harness_plans
      WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.subject}`;
    expect(rolledBack!.content).toBe(staleContent);
    expect(Number(rolledBack!.version)).toBe(seeded.subjectRevision);
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(seeded.rubric.revision);

    const after = (await rubrics.amendRubric(amendment))!;
    expect(after.criteria).toEqual(seeded.rubric.criteria);
    expect(after.barSetHash).toBe(seeded.rubric.barSetHash);
    expect(after.barContract!.meaningRevision).toBe(seeded.rubric.barContract!.meaningRevision);
    const [row] = await db.adminSql`SELECT content, version, acceptance_bar_rubric_revision FROM harness_shared.harness_plans
      WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.subject}`;
    const repaired = parseRequirementBars(row!.content);
    expect(repaired.ok).toBe(true);
    if (repaired.ok && original.ok) {
      expect(repaired.bars).toEqual(original.bars);
    }
    expect(Number(row!.version)).toBe(seeded.subjectRevision + 1);
    expect(Number(row!.acceptance_bar_rubric_revision)).toBe(after.revision);
  });

  it('EI-25970739425963382: commits a METHOD-only requirement update atomically without changing BAR meaning', async () => {
    const seeded = await explicitAmendmentSubject('method-render-subject');
    const method = 'Run the updated exact fixture and retain its result.';
    const amendment = { rubricId: seeded.rubricSlug, actorId: 'method-author', reason: 'Keep the explicit requirement procedure current.',
      expectedRubricRevision: seeded.rubric.revision, expectedSubjectPlanRevision: seeded.subjectRevision,
      criterion: { key: seeded.rubric.criteria[0]!.key, field: 'method' as const, mode: 'replace' as const, text: method } };
    const preview = await rubrics.previewAcceptanceBarAmendment(amendment);
    expect(preview).toMatchObject({ changedBars: [], approvalRequired: false,
      requirementsDrift: { rerenderedOnApply: ['R-1'] },
      revisionMovement: { subject: { from: seeded.subjectRevision, to: seeded.subjectRevision + 1 } } });
    await expect(rubrics.amendRubric({ ...amendment, faultInjection: 'after-rubric' })).rejects.toThrow();
    const [unchanged] = await db.adminSql`SELECT content, version FROM harness_shared.harness_plans
      WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.subject}`;
    expect(unchanged!.content).toBe(seeded.content);
    expect(Number(unchanged!.version)).toBe(seeded.subjectRevision);
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(seeded.rubric.revision);
    const after = (await rubrics.amendRubric(amendment))!;
    expect(after.criteria.map((c) => c.barHash)).toEqual(seeded.rubric.criteria.map((c) => c.barHash));
    expect(after.barContract!.meaningRevision).toBe(seeded.rubric.barContract!.meaningRevision);
    const [row] = await db.adminSql`SELECT content, version, acceptance_bar_rubric_revision FROM harness_shared.harness_plans
      WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.subject}`;
    const { parseRequirementBars } = await import('./acceptance-bar-seed');
    const parsed = parseRequirementBars(row!.content);
    expect(parsed.ok && parsed.bars[0]!.criterion?.method).toBe(method);
    expect(Number(row!.version)).toBe(seeded.subjectRevision + 1);
    expect(Number(row!.acceptance_bar_rubric_revision)).toBe(after.revision);
  });

  it('WI-6554700010018006: a check-only requirement patch re-renders the plan block the closure guard parses', async () => {
    // Observed live: an amend of requirement.verification.check.files applied on a build without
    // the apply-time re-render left the plan block naming the OLD file, and the spec-conformance
    // closure guard (which parses the PLAN block, conformance-contract.ts bar.criterion.check)
    // refused completion with conformance_done_when_not_passing against a file that never existed.
    const seeded = await explicitAmendmentSubject('check-files-render-subject');
    const { parseRequirementBars } = await import('./acceptance-bar-seed');
    const key = seeded.rubric.criteria[0]!.key;
    const files = ['packages/operator-core/lib/acceptance-bar-amendment-requirements-drift.test.ts'];
    const seededBlock = parseRequirementBars(seeded.content);
    expect(seededBlock.ok && (seededBlock.bars[0]!.criterion?.check as { files?: string[] } | undefined)?.files)
      .not.toEqual(files);
    const amendment = { rubricId: seeded.rubricSlug, actorId: 'check-author', reason: 'Name the test that proves the outcome.',
      expectedRubricRevision: seeded.rubric.revision, expectedSubjectPlanRevision: seeded.subjectRevision,
      requirement: { key, verification: { check: { kind: 'tests' as const, files } } } };
    const preview = await rubrics.previewAcceptanceBarAmendment(amendment);
    expect(preview).toMatchObject({ requirementsDrift: { rerenderedOnApply: ['R-1'] } });
    const after = (await rubrics.amendRubric({ ...amendment, approvalRef: await postApproval(amendment) }))!;
    expect(after.criteria[0]!.check).toMatchObject({ kind: 'tests', files });
    const [row] = await db.adminSql`SELECT content, version, acceptance_bar_rubric_revision FROM harness_shared.harness_plans
      WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.subject}`;
    const parsed = parseRequirementBars(row!.content);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.bars[0]!.criterion?.check).toMatchObject({ kind: 'tests', files });
      expect(parsed.bars[1]!.criterion?.check).toEqual(seeded.rubric.criteria[1]!.check);
    }
    expect(Number(row!.version)).toBe(seeded.subjectRevision + 1);
    expect(Number(row!.acceptance_bar_rubric_revision)).toBe(after.revision);

    const { default: rubricsGetTool } = await import('./agent-tools/rubrics/get');
    const currentRead = (await rubricsGetTool.handler(
      { rubricRef: seeded.rubricSlug, detail: 'full' },
      { isSuperuser: true, uiClientId: 'rubrics-live-readback-integration-test', workspaceId: seeded.workspaceId } as never,
    )) as {
      data: {
        results: Array<{
          ok: boolean;
          rubric?: { criteria: Array<{ key: string; check?: unknown }> };
          liveRequirements?: { source: string; subjectPlanVersion: number; live: string[]; changed: string[] };
        }>;
      };
    };
    expect(currentRead.data.results[0]).toMatchObject({
      ok: true,
      rubricRef: seeded.rubricSlug,
      liveRequirements: {
        source: 'live-plan',
        subjectPlanVersion: Number(row!.version),
        live: [],
        changed: [],
      },
    });
    const currentCriterion = currentRead.data.results[0]?.rubric?.criteria.find((criterion) => criterion.key === key);
    expect(currentCriterion?.check).toMatchObject({ kind: 'tests', files });
  });

  it('EI-27697322830922884: current/exact reads and a read-amend roundtrip preserve bindings over stale live checks', async () => {
    const seeded = await explicitAmendmentSubject('live-check-downgrade-subject', 'live');
    // The legacy fixture adds Intent to its plan blocks after seeding. Adopt it
    // canonically first, so this test reaches the binding guard, not the promise guard.
    const authoring = {
      rubricId: seeded.rubricSlug, actorId: 'binding-author', reason: 'Bind the maintained suites and registered instrument.',
      criteria: seeded.rubric.criteria.map((criterion, index) => ({
        ...criterion,
        intent: { request: `Retain outcome ${index + 1}.`, sourceRefs: ['session_turn:fixture'] },
        ...(index === 1 ? {
          check: { kind: 'instrument' as const, instrumentKey: 'code-intel:coupling-shadow-window' },
        } : {}),
      })),
    };
    const bound = (await rubrics.amendRubric({ ...authoring, approvalRef: await postApproval(authoring) }))!;
    const { default: rubricsGetTool } = await import('./agent-tools/rubrics/get');
    type ReadResult = {
      rubric: NonNullable<Awaited<ReturnType<typeof rubrics.getRubric>>>;
      liveRequirements?: { live: string[]; changed: string[]; kept: Array<{ barKey: string; reason: string }> };
    };
    const read = async (revision?: number) => {
      const response = await rubricsGetTool.handler(
        { rubricRef: seeded.rubricSlug, detail: 'full', ...(revision === undefined ? {} : { revision }) },
        { isSuperuser: true, uiClientId: 'rubric-binding-integrity-test', workspaceId: seeded.workspaceId } as never,
      ) as { data: { results: ReadResult[] } };
      return response.data.results[0]!;
    };
    const baseline = await read();
    expect(baseline.liveRequirements).toMatchObject({ live: ['R-1', 'R-2'], changed: [], kept: [] });
    const [subject] = await db.adminSql`SELECT content, version FROM harness_shared.harness_plans
      WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.subject}`;
    const stale = subject!.content.replace(
      JSON.stringify(bound.criteria[0]!.check),
      JSON.stringify({ kind: 'tests', files: ['packages/operator-core/lib/acceptance-bar-seed.test.ts'] }),
    ).replace(
      JSON.stringify(bound.criteria[1]!.check),
      JSON.stringify({ kind: 'instrument', instrumentKey: 'none' }),
    );
    expect(stale).not.toBe(subject!.content);
    // Simulate a historical writer leaving same-kind stale checks in the plan.
    await db.adminSql`UPDATE harness_shared.harness_plans SET content=${stale}, content_hash=${hashPlanContent(stale)}
      WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.subject}`;
    const current = await read();
    const exact = await read(bound.revision!);
    expect(current.rubric.revision).toBe(exact.rubric.revision);
    expect(current.rubric.criteriaHash).toBe(exact.rubric.criteriaHash);
    expect(current.rubric.criteria).toEqual(exact.rubric.criteria);
    expect(current.liveRequirements).toMatchObject({ live: [], changed: [], kept: [
      { barKey: 'R-1', reason: 'check-binding-downgraded' },
      { barKey: 'R-2', reason: 'check-binding-downgraded' },
    ] });
    expect(exact.liveRequirements).toBeUndefined();
    const roundtrip = {
      rubricId: seeded.rubricSlug, actorId: 'binding-author', reason: 'Repair stale plan checks from the complete current read.',
      criteria: current.rubric.criteria,
      expectedRubricRevision: bound.revision, expectedSubjectPlanRevision: Number(subject!.version),
    };
    expect(await rubrics.previewAcceptanceBarAmendment(roundtrip)).toMatchObject({
      changedBars: [], changes: [], approvalRequired: false,
      requirementsDrift: { rerenderedOnApply: ['R-1', 'R-2'] },
    });
    const repaired = (await rubrics.amendRubric(roundtrip))!;
    expect(repaired.criteria).toEqual(exact.rubric.criteria);
    // Projection repair advances subjectPlanRevision, which is part of the
    // full-template criteriaHash. Check BAR meaning and the immutable snapshot.
    expect(repaired).toMatchObject({
      revision: bound.revision,
      barSetHash: exact.rubric.barSetHash,
      barContract: { meaningRevision: exact.rubric.barContract!.meaningRevision },
    });
    expect((await read()).rubric.criteria).toEqual(exact.rubric.criteria);
    const immutableAfterRepair = await read(bound.revision!);
    expect(immutableAfterRepair.rubric.criteria).toEqual(exact.rubric.criteria);
    expect(immutableAfterRepair.rubric.criteriaHash).toBe(exact.rubric.criteriaHash);
    const [after] = await db.adminSql`SELECT content FROM harness_shared.harness_plans
      WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.subject}`;
    const { parseRequirementBars } = await import('./acceptance-bar-seed');
    const parsed = parseRequirementBars(after!.content);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.bars.map((bar) => bar.criterion!.check)).toEqual(bound.criteria.map((criterion) => criterion.check));
  });

  it('EI-25970739425963382: renders method edits beside a meaning change while only that meaning changes BAR identity', async () => {
    const seeded = await explicitAmendmentSubject('mixed-render-subject');
    const method = 'Run the second current fixture and retain its result.';
    const criteria = seeded.rubric.criteria.map((criterion, index) => {
      const { bar: _bar, barHash: _barHash, ...canonical } = criterion;
      return index === 0 ? { ...canonical, model: 'The first revised outcome holds.' } : { ...canonical, method };
    });
    const amendment = { rubricId: seeded.rubricSlug, actorId: 'method-author', reason: 'Change the first outcome and the second procedure.', criteria };
    const preview = await rubrics.previewAcceptanceBarAmendment(amendment);
    expect(preview).toMatchObject({ changedBars: ['R-1'], requirementsDrift: { rerenderedOnApply: ['R-1', 'R-2'] } });
    const after = (await rubrics.amendRubric({ ...amendment, approvalRef: await postApproval(amendment) }))!;
    expect(after.criteria[0]!.barHash).not.toBe(seeded.rubric.criteria[0]!.barHash);
    expect(after.criteria[1]!.barHash).toBe(seeded.rubric.criteria[1]!.barHash);
    const [row] = await db.adminSql`SELECT content FROM harness_shared.harness_plans
      WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.subject}`;
    const { parseRequirementBars } = await import('./acceptance-bar-seed');
    const parsed = parseRequirementBars(row!.content);
    expect(parsed.ok && parsed.bars[1]!.criterion?.method).toBe(method);
  });

  it('updates the BAR set pin without churning stable clause revisions on a METHOD edit, then rolls back a late refusal', async () => {
    const seeded = await seedBarContract('method-pin-subject', { authorMethods: true });
    const { workspaceId, subject } = seeded;
    const before = await rubrics.getRubric(seeded.rubricSlug);
    const data = await storedTemplateData(seeded.rubricSlug);
    const preview = await rubrics.previewAcceptanceBarAmendment({
      rubricId: seeded.rubricSlug,
      actorId: 'method-author',
      criterion: { key: before!.criteria[0]!.key, field: 'method', mode: 'replace', text: 'Run the current fixture.' },
    });
    expect(preview).toMatchObject({
      approvalRequired: false,
      priorBarSetHash: before!.barSetHash,
      nextBarSetHash: before!.barSetHash,
      cohortDisposition: { cohort: 'post-epoch', action: 'preserve' },
    });
    expect(preview!.changes).toContainEqual(expect.objectContaining({ barKey: 'R-1', kinds: ['method-only'] }));
    expect(preview!.sourceSnapshotHash).toMatch(/^[a-f0-9]{64}$/);
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(before!.revision);
    const next = {
      ...data,
      criteria: data.criteria.map((criterion) => ({
        ...criterion,
        method: 'Execute the current integration fixture.',
      })),
    };
    const projectionsBefore = await db.adminSql`SELECT r.source_rubric_revision FROM harness_shared.plan_spec_clauses c
      JOIN harness_shared.plan_spec_clause_revisions r USING (workspace_id,harness_slug,plan_slug,spec_id)
      WHERE c.workspace_id=${workspaceId} AND c.harness_slug='papercusp' AND c.plan_slug=${subject}
        AND r.revision=c.current_revision ORDER BY c.spec_id`;
    const [historyBefore] = await db.adminSql`SELECT count(*)::int AS n FROM harness_shared.plan_spec_clause_revisions
      WHERE workspace_id=${workspaceId} AND harness_slug='papercusp' AND plan_slug=${subject}`;
    const written = await setTemplateDataDoor(seeded.rubricSlug, next);
    expect(written.kind).toBe('applied');
    const after = await rubrics.getRubric(seeded.rubricSlug);
    expect(after!.barSetHash).toBe(before!.barSetHash);
    expect(after!.criteria.map((criterion) => criterion.barHash)).toEqual(
      before!.criteria.map((criterion) => criterion.barHash),
    );
    const [pin] = await db.adminSql`SELECT acceptance_bar_rubric_revision FROM harness_shared.harness_plans
      WHERE workspace_id=${workspaceId} AND harness_slug='papercusp' AND plan_slug=${subject}`;
    expect(Number(pin.acceptance_bar_rubric_revision)).toBe(after!.revision);
    const projections = await db.adminSql`SELECT r.source_rubric_revision FROM harness_shared.plan_spec_clauses c
      JOIN harness_shared.plan_spec_clause_revisions r USING (workspace_id,harness_slug,plan_slug,spec_id)
      WHERE c.workspace_id=${workspaceId} AND c.harness_slug='papercusp' AND c.plan_slug=${subject}
        AND r.revision=c.current_revision ORDER BY c.spec_id`;
    expect(projections).toHaveLength(2);
    expect(projections.map((row) => Number(row.source_rubric_revision))).toEqual(
      projectionsBefore.map((row) => Number(row.source_rubric_revision)),
    );
    const [history] = await db.adminSql`SELECT count(*)::int AS n FROM harness_shared.plan_spec_clause_revisions
      WHERE workspace_id=${workspaceId} AND harness_slug='papercusp' AND plan_slug=${subject}`;
    // A method-only write advances the rubric and plan-level BAR pin, while
    // unchanged clause meanings retain their revisions and evidence identities.
    expect(Number(history.n)).toBe(Number(historyBefore!.n));

    // Append a divergent projection in this isolated database to trigger a
    // refusal AFTER the rubric UPDATE, preserving the immutable prior rows.
    const { setSpecClause } = await import('./agent-tools/plans/spec-clauses-store');
    // DERIVE the CAS baseline rather than hardcoding it. This was `2`, which was
    // correct only while seeding wrote exactly one clause revision; once
    // seedBarContract({ authorMethods: true }) added the authoring write a real
    // caller performs, the clause sits at 3 (seed + author + amend) and the
    // hardcoded baseline failed as a CAS 'conflict' — a stale fixture, not a
    // defect in the store. Reading it keeps the next fixture change from
    // re-stranding this the same way.
    const [clauseRow] = await db.adminSql`SELECT current_revision FROM harness_shared.plan_spec_clauses
      WHERE workspace_id=${workspaceId} AND harness_slug='papercusp'
        AND plan_slug=${subject} AND spec_id='AUTO-BAR-R-1-P-001'`;
    const divergent = await db.adminSql.begin((tx) =>
      setSpecClause(
        {
          planSlug: subject,
          specId: 'AUTO-BAR-R-1-P-001',
          expectedRevision: Number(clauseRow!.current_revision),
          planItemId: 'P-001',
          behavior: after!.criteria[0]!.model,
          behaviorClass: 'happy-path',
          lifecycleStatus: 'draft',
          actorId: 'fixture',
          sourceBar: {
            barKey: 'R-999',
            barHash: after!.criteria[0]!.barHash!,
            barSetHash: after!.barSetHash!,
            rubricSlug: seeded.rubricSlug,
            rubricRevision: after!.revision!,
            evidencePlane: 'tree',
          },
        },
        { executor: tx as never, workspaceId, harnessSlug: 'papercusp' },
      ),
    );
    expect(divergent.status).toBe('revised');
    await expect(setTemplateDataDoor(seeded.rubricSlug, next)).rejects.toThrow(/acceptance_bar_revision_/);
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(after!.revision);
  });

  it('revises the changed BAR and preserves the stable unchanged projection on a semantic amendment', async () => {
    const seeded = await seedBarContract('semantic-pin-subject', { authorMethods: true });
    const { workspaceId, subject } = seeded;
    const before = await rubrics.getRubric(seeded.rubricSlug);
    const amendment = {
      rubricId: seeded.rubricSlug,
      criterion: {
        key: before!.criteria[0]!.key,
        field: 'driftMarkers' as const,
        mode: 'replace' as const,
        text: 'The first outcome is absent after the transaction commits.',
      },
      actorId: 'amendment-actor',
      reason: 'Make the falsifier observable.',
      approvedBy: 'outside-reviewer',
    };
    await expect(rubrics.amendRubric({ ...amendment, approvalRef: 'fixture:outside-approval' })).rejects.toThrow(
      'acceptance_bar_approval_required',
    );
    const approvalRef = await postApproval(amendment, 'outside-reviewer', {
      certifies: 'all changed BAR hashes were checked against source',
      doesNotCertify: ['runtime deployment', 'unrelated plan items'],
    });
    await expect(rubrics.amendRubric({ ...amendment, approvalRef, approvedBy: 'spoofed-reviewer' })).rejects.toThrow(
      'acceptance_bar_approval_author_mismatch',
    );
    const accepted = {
      ...amendment,
      approvalRef,
      approvedAt: '2000-01-01T00:00:00Z',
      idempotencyKey: 'semantic-amendment-replay',
      expectedRubricRevision: before!.revision,
    };
    const projectionsBefore = await db.adminSql`SELECT c.spec_id, r.source_rubric_revision, r.source_bar_set_hash
      FROM harness_shared.plan_spec_clauses c
      JOIN harness_shared.plan_spec_clause_revisions r USING (workspace_id,harness_slug,plan_slug,spec_id)
      WHERE c.workspace_id=${workspaceId} AND c.harness_slug='papercusp' AND c.plan_slug=${subject}
        AND r.revision=c.current_revision ORDER BY c.spec_id`;
    const [historyBefore] = await db.adminSql`SELECT count(*)::int AS n FROM harness_shared.plan_spec_clause_revisions
      WHERE workspace_id=${workspaceId} AND harness_slug='papercusp' AND plan_slug=${subject}`;
    const after = await rubrics.amendRubric(accepted);
    expect(after).not.toBeNull();
    const current = await rubrics.getRubric(seeded.rubricSlug);
    expect(current!.barSetHash).not.toBe(before!.barSetHash);
    expect(current!.criteria[1]!.barHash).toBe(before!.criteria[1]!.barHash);
    // EI-24352619832794123: the amendment receipt must include the delegated
    // class revision in its grading identity, just like a fresh read and the
    // immutable snapshot. Matching BAR hashes alone did not detect this drift.
    expect(after!.criteriaHash).toBe(current!.criteriaHash);
    const frozen = await rubrics.getRubric(seeded.rubricSlug, after!.revision);
    expect(frozen!.criteriaHash).toBe(after!.criteriaHash);
    const replayed = await rubrics.amendRubric(accepted);
    expect(replayed!.barSetHash).toBe(current!.barSetHash);
    expect(replayed!.criteriaHash).toBe(after!.criteriaHash);
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(current!.revision);
    // Hold both advisory locks in another transaction. An exact retry must
    // reconcile from the committed subject decision before attempting either
    // lock; otherwise this reproduces the incident's 55P03 response.
    const replayedWhileLocksHeld = await db.adminSql.begin(async (tx) => {
      for (const planSlug of [seeded.rubricSlug, seeded.subject].sort()) {
        await tx`SELECT pg_advisory_xact_lock(
          hashtext(${PLAN_ADVISORY_LOCK_NAMESPACE}),
          hashtext(${planAdvisoryLockKey(seeded.workspaceId, 'papercusp', planSlug)}))`;
      }
      return rubrics.amendRubric(accepted);
    });
    expect(replayedWhileLocksHeld!.barSetHash).toBe(current!.barSetHash);
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(current!.revision);
    await expect(
      rubrics.amendRubric({ ...accepted, reason: 'Reuse the token for a different request.' }),
    ).rejects.toThrow('acceptance_bar_amendment_replay_conflict');
    const projections = await db.adminSql`SELECT c.spec_id, r.source_rubric_revision, r.source_bar_set_hash
      FROM harness_shared.plan_spec_clauses c
      JOIN harness_shared.plan_spec_clause_revisions r USING (workspace_id,harness_slug,plan_slug,spec_id)
      WHERE c.workspace_id=${workspaceId} AND c.harness_slug='papercusp' AND c.plan_slug=${subject}
        AND r.revision=c.current_revision ORDER BY c.spec_id`;
    expect(projections).toHaveLength(2);
    expect(Number(projections[0]!.source_rubric_revision)).toBe(current!.revision);
    expect(projections[0]!.source_bar_set_hash).toBe(current!.barSetHash);
    // R-2's meaning did not change, so P-001 leaves its projection and historical
    // provenance intact while the plan and rubric carry the new BAR-set pin.
    expect(Number(projections[1]!.source_rubric_revision)).toBe(
      Number(projectionsBefore[1]!.source_rubric_revision),
    );
    expect(projections[1]!.source_bar_set_hash).toBe(projectionsBefore[1]!.source_bar_set_hash);
    const [subjectBeforeFailure] = await db.adminSql`SELECT content, version, acceptance_bar_rubric_revision
      FROM harness_shared.harness_plans WHERE workspace_id=${workspaceId}
        AND harness_slug='papercusp' AND plan_slug=${subject}`;
    expect(Number(subjectBeforeFailure.acceptance_bar_rubric_revision)).toBe(current!.revision);
    expect(subjectBeforeFailure.content).toContain('Approved-By: outside-reviewer');
    expect(subjectBeforeFailure.content).toContain('Certifies: all changed BAR hashes were checked against source');
    expect(subjectBeforeFailure.content).toContain('Does-Not-Certify: runtime deployment, unrelated plan items');
    expect(subjectBeforeFailure.content).not.toContain('Approved-At: 2000-01-01');
    const nextAmendment = {
      ...amendment,
      criterion: { ...amendment.criterion, text: 'The first outcome is absent or has the wrong value.' },
    };
    await expect(rubrics.amendRubric({ ...nextAmendment, approvalRef })).rejects.toThrow(
      'acceptance_bar_approval_stale_or_mismatched',
    );
    await expect(
      rubrics.amendRubric({
        ...nextAmendment,
        approvalRef: await postApproval(nextAmendment),
        faultInjection: 'after-projection',
      }),
    ).rejects.toThrow('acceptance_bar_amendment_fault_injected:after-projection');
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(current!.revision);
    const [subjectAfterFailure] = await db.adminSql`SELECT content, version, acceptance_bar_rubric_revision
      FROM harness_shared.harness_plans WHERE workspace_id=${workspaceId}
        AND harness_slug='papercusp' AND plan_slug=${subject}`;
    expect(subjectAfterFailure).toEqual(subjectBeforeFailure);
    const [history] = await db.adminSql`SELECT count(*)::int AS n FROM harness_shared.plan_spec_clause_revisions
      WHERE workspace_id=${workspaceId} AND harness_slug='papercusp' AND plan_slug=${subject}`;
    // Only the changed R-1 projection gets a new clause revision.
    expect(Number(history.n)).toBe(Number(historyBefore!.n) + 1);
  });

  it('dry-run BAR previews complete while a writer holds both plan locks', async () => {
    const seeded = await seedBarContract('preview-under-write-locks', { authorMethods: true });
    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    let releaseLocks!: () => void;
    const release = new Promise<void>((resolve) => { releaseLocks = resolve; });
    const lockHolder = db.adminSql.begin(async (tx) => {
      for (const planSlug of [seeded.rubricSlug, seeded.subject].sort()) {
        await tx`SELECT pg_advisory_xact_lock(
          hashtext(${PLAN_ADVISORY_LOCK_NAMESPACE}),
          hashtext(${planAdvisoryLockKey(seeded.workspaceId, 'papercusp', planSlug)}))`;
      }
      await tx`SELECT plan_slug FROM harness_shared.harness_plans
        WHERE workspace_id = ${seeded.workspaceId} AND harness_slug = 'papercusp'
          AND plan_slug = ANY(${[seeded.rubricSlug, seeded.subject]}::text[])
        FOR UPDATE`;
      signalLocked();
      await release;
    });
    await locked;

    const previewPromise = rubrics.previewAcceptanceBarAmendment({
      rubricId: seeded.rubricSlug,
      criteria: before.criteria,
      actorId: 'preview-requester',
      approvedBy: 'outside-reviewer',
      reason: 'Screen a reviewer while the source plans are being written.',
    });
    let completed = false;
    try {
      completed = await Promise.race([
        previewPromise.then(() => true, () => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3500)),
      ]);
    } finally {
      releaseLocks();
      await lockHolder;
    }
    const preview = await previewPromise;
    expect(completed).toBe(true);
    expect(preview).not.toBeNull();
    expect(preview?.approverEligibility).toBeDefined();
  });

  it.each([
    { code: 'bar_snapshot_source_unavailable', source: 'evidence', detail: 'canonical evidence read failed', truncated: false },
    { code: 'bar_snapshot_source_truncated', source: 'lineage', detail: 'lineage read reached its 500-row contract limit', truncated: true },
  ] as const)('names the $source source when a dry-run refuses $code without writing', async (problem) => {
    const seeded = await seedBarContract(`preview-${problem.source}-incomplete`, { authorMethods: true });
    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    const readPlans = () => db.adminSql`SELECT plan_slug, content, version, template_data
      FROM harness_shared.harness_plans WHERE workspace_id=${seeded.workspaceId}
        AND harness_slug='papercusp' AND plan_slug=ANY(${[seeded.rubricSlug, seeded.subject]}::text[])
      ORDER BY plan_slug`;
    const plansBefore = await readPlans();
    const snapshots = await import('./acceptance-bar-contract-snapshot');
    const complete = await snapshots.readAcceptanceBarContractSnapshot(seeded.subject, {}, { harnessSlug: 'papercusp' });
    const reader = vi.spyOn(snapshots, 'readAcceptanceBarContractSnapshot').mockResolvedValueOnce({
      ...complete,
      completeness: {
        complete: false,
        truncated: problem.truncated,
        problems: [{ code: problem.code, source: problem.source, severity: 'error', detail: problem.detail }],
      },
    });
    const amendment = {
      rubricId: seeded.rubricSlug,
      criteria: before.criteria,
      actorId: 'preview-requester',
      reason: 'Diagnose an incomplete canonical source without changing the source gate.',
    };
    try {
      await expect(rubrics.previewAcceptanceBarAmendment(amendment)).rejects.toThrow(
        `acceptance_bar_amendment_preview_source_incomplete:${problem.code}: ${problem.source}: ${problem.detail}`,
      );
      expect(reader).toHaveBeenCalledOnce();
    } finally {
      reader.mockRestore();
    }
    expect(await readPlans()).toEqual(plansBefore);
    // Complete sources remain previewable; diagnostics must not force an unconditional refusal.
    expect(await rubrics.previewAcceptanceBarAmendment(amendment)).not.toBeNull();
    expect(await readPlans()).toEqual(plansBefore);
  });

  it('refuses a dry-run when a generated projection conflict would make apply fail', async () => {
    const seeded = await seedBarContract('dry-run-projection-conflict', { authorMethods: true });
    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    const { listSpecClauses, setSpecClause } = await import('./agent-tools/plans/spec-clauses-store');
    const scope = { harnessSlug: 'papercusp', planSlug: seeded.subject };
    const clause = (await listSpecClauses(scope)).find((entry) => entry.specId === 'AUTO-BAR-R-1-P-001');
    expect(clause).toBeDefined();

    // Keep the generated identity but break its pair. The apply projection sees R-1/P-001
    // missing, tries to create it at revision 0, and refuses because this row already exists.
    // setSpecClause appends a revision; the history table deliberately rejects UPDATE.
    const malformed = await setSpecClause({
      ...clause!,
      ...scope,
      expectedRevision: clause!.revision,
      planItemId: 'P-002',
      actorId: 'preview-requester',
    });
    expect(malformed.status).toBe('revised');

    const amendment = {
      rubricId: seeded.rubricSlug,
      actorId: 'preview-requester',
      reason: 'Preview a changed BAR against the current projection set.',
      criteria: before.criteria.map((criterion) =>
        criterion.barKey === 'R-1'
          ? { ...criterion, model: 'The updated first outcome remains true.', bar: undefined }
          : criterion,
      ),
    };

    await expect(rubrics.previewAcceptanceBarAmendment(amendment)).rejects.toThrow(
      `acceptance_bar_revision_projection_conflict:AUTO-BAR-R-1-P-001:conflict:expected=0:actual=${clause!.revision + 1}`,
    );
  });

  it('adds a declared BAR with structured checks through the existing atomic amendment path', async () => {
    const seeded = await seedBarContract('criteria-set-addition-subject', { authorMethods: true });
    const before = await rubrics.getRubric(seeded.rubricSlug);
    const [subject] = await db.adminSql<{ content: string; version: number }[]>`
      SELECT content, version FROM harness_shared.harness_plans
       WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp'
         AND plan_slug=${seeded.subject}`;
    const nextContent = subject!.content
      .replace('\n\n## Design', '\n\n**R-3 — Third outcome.** The third outcome holds.\n\n## Design')
      .replace('| R-2 | P-002 | tree |', '| R-2 | P-002 | tree |\n| R-3 | P-003 | tree |')
      .replace(
        '- **P-002** `done` second outcome',
        '- **P-002** `done` second outcome\n- **P-003** `todo` third outcome',
      );
    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET content=${nextContent}, content_hash=md5(${nextContent}), version=version+1
       WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp'
         AND plan_slug=${seeded.subject}`;
    await db.adminSql`
      INSERT INTO harness_shared.plan_items
        (workspace_id,harness_slug,plan_slug,item_id,seq,status,item_text)
      VALUES (${seeded.workspaceId},'papercusp',${seeded.subject},'P-003',3,'todo','third outcome')`;
    // Advance the rubric's subject-plan pin to match the version bumped above.
    // The readiness gate refuses when `barContract.subjectPlanRevision !==
    // plan.revision` (acceptance-bar-contract-snapshot.ts, third clause of
    // bar_snapshot_rubric_revision_mismatch). Real callers never hit that,
    // because every plan write goes through the door that re-pins it — this
    // fixture edits harness_plans with raw SQL, so it has to re-pin too. Mirror
    // the production writer exactly (acceptance-bar-amendment.ts:130) rather
    // than inventing a fixture-only re-pin that could drift from it.
    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET template_data = jsonb_set(template_data, '{barContract,subjectPlanRevision}',
               to_jsonb(${Number(subject!.version) + 1}::int))
       WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp'
         AND plan_slug=${seeded.rubricSlug}`;

    const check = {
      kind: 'tests' as const,
      files: ['packages/operator-core/lib/acceptance-bar-amendment.test.ts'],
    };
    const criteria = [
      ...before!.criteria.map((criterion) => ({
        ...criterion,
        method: `Run the focused test for ${criterion.barKey}.`,
        check,
      })),
      rubrics.normalizeAcceptanceBarCriterion({
        key: 'r-3',
        title: 'Third outcome',
        model: 'Third outcome. The third outcome holds.',
        method: 'Run the focused test for R-3.',
        driftMarkers: 'R-3 is falsified when the third outcome is absent.',
        barKey: 'R-3',
        role: 'outcome',
        mandatory: true,
        requiredScope: ['tree'],
        evidencePlane: 'tree',
        requiredTestLayers: ['unit'],
        passRatings: ['healthy'],
        barProvenance: {
          lifecycle: 'legacy-backfilled',
          declaredAt: '2026-09-05T12:00:00.000Z',
          declaredBy: 'amendment-actor',
        },
        check,
      }),
    ];
    const amendment = {
      rubricId: seeded.rubricSlug,
      actorId: 'amendment-actor',
      reason: 'Add the newly declared R-3 and bind runnable checks across the complete set.',
      expectedRubricRevision: before!.revision,
      expectedSubjectPlanRevision: Number(subject!.version) + 1,
      criteria,
    };
    const preview = await rubrics.previewAcceptanceBarAmendment(amendment);
    expect(preview).toMatchObject({
      // The fixture's authored check uses the seed test path; this amendment
      // intentionally binds the complete set to a different runnable check,
      // so R-1 and R-2 change alongside the newly declared R-3.
      changedBars: ['R-1', 'R-2', 'R-3'],
      approvalRequired: true,
      projectionCount: 3,
      // rubric starts at 2, not 1: seeding now authors METHOD/check first.
      revisionMovement: { rubric: { from: 2, to: 3 }, subject: { from: 3, to: 4 } },
    });
    expect(preview!.approval.bars.map(({ barKey }) => barKey)).toEqual(['R-1', 'R-2', 'R-3']);
    expect(preview!.approval.bars).toContainEqual(expect.objectContaining({ barKey: 'R-3', priorBarHash: null }));
    // P-039 (review-system-rework-reduction-2026-09-23, R-9): the real dry run carries the ship
    // readiness delta. R-3 is new and owes automated proof; R-1/R-2 keep a tests check, so nothing
    // flips and the amendment is not a floor-only raise.
    expect(preview!.readinessDelta).toMatchObject({
      phase: 'ship',
      before: { barCount: 2 },
      after: { barCount: 3 },
      flippedToAutomated: [],
      flippedToManual: [],
      raisesProofFloorOnly: false,
    });
    expect(preview!.readinessDelta.bars).toContainEqual(
      expect.objectContaining({ barKey: 'R-3', contractBefore: null, contractAfter: 'automated' }),
    );
    expect(preview!.readinessDelta.summary).toMatch(/^Ship readiness: \d+ of 2 BAR\(s\) blocking before, \d+ of 3 after/);
    expect(preview!.changes).toContainEqual(expect.objectContaining({ barKey: 'R-3', kinds: ['added'] }));

    const approvalRef = await postApproval(amendment);
    const after = await rubrics.amendRubric({ ...amendment, approvalRef });
    expect(after!.criteria).toHaveLength(3);
    expect(after!.criteria.every((criterion) => criterion.method && criterion.check?.kind === 'tests')).toBe(true);
    const projections = await db.adminSql<
      Array<{
        spec_id: string;
        source_bar_key: string;
        plan_item_id: string;
        source_rubric_revision: number;
      }>
    >`
      SELECT c.spec_id, r.source_bar_key, r.plan_item_id, r.source_rubric_revision
        FROM harness_shared.plan_spec_clauses c
        JOIN harness_shared.plan_spec_clause_revisions r USING (workspace_id,harness_slug,plan_slug,spec_id)
       WHERE c.workspace_id=${seeded.workspaceId} AND c.harness_slug='papercusp'
         AND c.plan_slug=${seeded.subject} AND r.revision=c.current_revision
       ORDER BY c.spec_id`;
    expect(projections).toHaveLength(3);
    expect(projections).toContainEqual(
      expect.objectContaining({
        spec_id: 'AUTO-BAR-R-3-P-003',
        source_bar_key: 'R-3',
        plan_item_id: 'P-003',
        // DERIVED, not hardcoded: the projection is stamped with the rubric revision the
        // amendment produced. The concrete arithmetic is already asserted above by
        // revisionMovement { rubric: { from: 2, to: 3 } }, so deriving here loses no coverage
        // and survives the next seedBarContract() fixture change (same pattern as the
        // source_rubric_revision assertions at the atomic-author and semantic-replay tests).
        source_rubric_revision: after!.revision,
      }),
    );
    const [pinned] = await db.adminSql<
      Array<{
        version: number;
        acceptance_bar_rubric_revision: number;
        acceptance_bar_set_hash: string;
      }>
    >`
      SELECT version, acceptance_bar_rubric_revision, acceptance_bar_set_hash
        FROM harness_shared.harness_plans
       WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp'
         AND plan_slug=${seeded.subject}`;
    // The raw fixture edit bumps the authored subject from the queried version,
    // and the accepted BAR amendment pins the subsequent subject revision.
    expect(Number(pinned!.version)).toBe(Number(subject!.version) + 2);
    // DERIVED, matching this file's own convention for this exact property (the atomic-author
    // test asserts it as after!.revision, the replay test as current!.revision) and the
    // barSetHash line directly below. The concrete arithmetic stays pinned by revisionMovement
    // above; hardcoding it here only re-encoded how many times the fixture authored first.
    expect(Number(pinned!.acceptance_bar_rubric_revision)).toBe(after!.revision);
    expect(pinned!.acceptance_bar_set_hash).toBe(after!.barSetHash);
  });

  it('projects every newly mapped plan item when an existing BAR expands', async () => {
    const seeded = await seedBarContract('criteria-set-expansion-subject', { authorMethods: true });
    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    const [subject] = await db.adminSql<{ content: string; version: number }[]>`
      SELECT content, version FROM harness_shared.harness_plans
       WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp'
         AND plan_slug=${seeded.subject}`;
    const nextContent = subject!.content
      .replace(
        '**R-1 — First outcome.** The first outcome holds.',
        '**R-1 — First outcome.** The first outcome holds after expansion.',
      )
      .replace('| R-1 | P-001 | tree |', '| R-1 | P-001, P-002 | tree |');
    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET content=${nextContent}, content_hash=md5(${nextContent}), version=version+1
       WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp'
         AND plan_slug=${seeded.subject}`;
    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET template_data = jsonb_set(template_data, '{barContract,subjectPlanRevision}',
               to_jsonb(${Number(subject!.version) + 1}::int))
       WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp'
         AND plan_slug=${seeded.rubricSlug}`;

    const criteria = before.criteria.map((criterion) => {
      if (criterion.barKey !== 'R-1') return criterion;
      const { bar: _bar, barHash: _barHash, ...canonical } = criterion;
      return { ...canonical, model: 'The first outcome holds after expansion.' };
    });
    const amendment = {
      rubricId: seeded.rubricSlug,
      actorId: 'amendment-actor',
      reason: 'Expand R-1 across both implementing plan items.',
      expectedRubricRevision: before.revision,
      expectedSubjectPlanRevision: Number(subject!.version) + 1,
      criteria,
    };
    const preview = await rubrics.previewAcceptanceBarAmendment(amendment);
    expect(preview).toMatchObject({ changedBars: ['R-1'], projectionCount: 3 });

    const after = await rubrics.amendRubric({ ...amendment, approvalRef: await postApproval(amendment) });
    const projections = await db.adminSql<Array<{ source_bar_key: string; plan_item_id: string }>>`
      SELECT r.source_bar_key, r.plan_item_id
        FROM harness_shared.plan_spec_clauses c
        JOIN harness_shared.plan_spec_clause_revisions r USING (workspace_id,harness_slug,plan_slug,spec_id)
       WHERE c.workspace_id=${seeded.workspaceId} AND c.harness_slug='papercusp'
         AND c.plan_slug=${seeded.subject} AND r.revision=c.current_revision
       ORDER BY r.source_bar_key,r.plan_item_id`;
    expect(after!.revision).toBe(before.revision! + 1);
    expect(projections).toEqual([
      { source_bar_key: 'R-1', plan_item_id: 'P-001' },
      { source_bar_key: 'R-1', plan_item_id: 'P-002' },
      { source_bar_key: 'R-2', plan_item_id: 'P-002' },
    ]);
  });

  async function postApproval(
    input: Parameters<typeof rubrics.amendRubric>[0],
    author = 'outside-reviewer',
    receiptFields: { certifies?: string; doesNotCertify?: string[] } = {},
  ) {
    const preview = await rubrics.previewAcceptanceBarAmendment(input);
    expect(preview).not.toBeNull();
    const receipt = { ...preview!.approval, ...receiptFields };
    const workspaceId = activeWorkspaceId();
    const thread = `approval-${preview!.approval.subjectPlan}`;
    await db.adminSql`INSERT INTO harness_shared.coord_threads (workspace_id,thread_id,parent_kind,parent_ref)
      VALUES (${workspaceId},${thread},'plan',${preview!.approval.subjectPlan}) ON CONFLICT DO NOTHING`;
    const [post] = await db.adminSql`INSERT INTO harness_shared.coord_thread_posts
      (workspace_id,thread_id,author_id,body) VALUES
      (${workspaceId},${thread},${author},${JSON.stringify(receipt)}) RETURNING id`;
    return `thread-post:${post.id}`;
  }

  it('reuses covered work-item lookups across clauses without losing explicit or legacy bindings', async () => {
    const subject = 'amend-covered-lookup-reuse';
    const seeded = await seedBarContract(subject, {
      authorMethods: true,
      body: `## Requirements

**R-1 — First outcome.** The first outcome holds.

**R-2 — Second outcome.** The second outcome holds.

**R-3 — Third outcome.** The third outcome holds.

## Design

### Bar-to-work map for this plan

| bar | implementing plan items | evidence plane |
|---|---|---|
| R-1 | P-001 | tree |
| R-2 | P-001 | tree |
| R-3 | P-002 | tree |

## Work

- **P-001** \`done\` first two outcomes
- **P-002** \`done\` third outcome
`,
    });
    const canonicalId = 'F-amend-covered-canonical';
    const legacyId = 'F-amend-covered-legacy';
    const explicitId = 'F-amend-covered-explicit';
    await db.adminSql`INSERT INTO harness_shared.work_items
      (workspace_id,harness_slug,feature_id,item_kind,title,status,source_plan_slug,source_plan_item_ids,payload)
      VALUES
        (${seeded.workspaceId},'papercusp',${canonicalId},'feature','Canonical coverage','done',${subject},ARRAY['P-001'],'{}'::jsonb),
        (${seeded.workspaceId},'papercusp',${legacyId},'feature','Legacy coverage','done',NULL,NULL,
          ${JSON.stringify({ plan_item: { slug: subject, item: 'P-002' } })}::jsonb),
        (${seeded.workspaceId},'papercusp',${explicitId},'feature','Explicit coverage','done',NULL,NULL,'{}'::jsonb)`;
    await db.adminSql`INSERT INTO harness_shared.work_item_spec_revision_edges
      (workspace_id,harness_slug,work_item_id,plan_slug,spec_id,spec_revision,spec_fingerprint,created_by)
      SELECT c.workspace_id,c.harness_slug,${explicitId},c.plan_slug,c.spec_id,c.current_revision,r.content_hash,'test-author'
        FROM harness_shared.plan_spec_clauses c
        JOIN harness_shared.plan_spec_clause_revisions r
          ON r.workspace_id=c.workspace_id AND r.harness_slug=c.harness_slug AND r.plan_slug=c.plan_slug
         AND r.spec_id=c.spec_id AND r.revision=c.current_revision
       WHERE c.workspace_id=${seeded.workspaceId} AND c.harness_slug='papercusp' AND c.plan_slug=${subject}
         AND r.source_bar_key='R-1'`;
    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    const amendment = {
      rubricId: seeded.rubricSlug,
      actorId: 'amendment-actor',
      reason: 'Change all three outcomes while preserving every projected work-item binding.',
      criteria: before.criteria.map((criterion) => {
        const { bar: _bar, barHash: _barHash, ...canonical } = criterion;
        return { ...canonical, driftMarkers: `${criterion.driftMarkers} A required work-item binding is missing.` };
      }),
    };
    const approvalRef = await postApproval(amendment);
    h.coveredWorkItemLookups = [];
    try {
      await rubrics.amendRubric({ ...amendment, approvalRef });
      expect(h.coveredWorkItemLookups.sort()).toEqual(['P-001', 'P-002']);
    } finally {
      h.coveredWorkItemLookups = undefined;
    }
    const edges = await db.adminSql<{ bar: string; work_item_id: string }[]>`
      SELECT r.source_bar_key AS bar,e.work_item_id
        FROM harness_shared.work_item_spec_revision_edges e
        JOIN harness_shared.plan_spec_clauses c
          ON c.workspace_id=e.workspace_id AND c.harness_slug=e.harness_slug AND c.plan_slug=e.plan_slug
         AND c.spec_id=e.spec_id AND c.current_revision=e.spec_revision
        JOIN harness_shared.plan_spec_clause_revisions r
          ON r.workspace_id=c.workspace_id AND r.harness_slug=c.harness_slug AND r.plan_slug=c.plan_slug
         AND r.spec_id=c.spec_id AND r.revision=c.current_revision
       WHERE e.workspace_id=${seeded.workspaceId} AND e.harness_slug='papercusp' AND e.plan_slug=${subject}
       ORDER BY r.source_bar_key,e.work_item_id`;
    expect(edges).toEqual([
      { bar: 'R-1', work_item_id: canonicalId },
      { bar: 'R-1', work_item_id: explicitId },
      { bar: 'R-2', work_item_id: canonicalId },
      { bar: 'R-3', work_item_id: legacyId },
    ]);
  });

  it('authors unified sections through proposal preflight and stores only canonical promise and method fields', async () => {
    const workspaceId = activeWorkspaceId();
    const subject = 'unified-proposal-subject';
    await db.adminSql`INSERT INTO harness_shared.harness_plans
      (workspace_id,harness_slug,plan_slug,content,content_hash,version,title,status,owner)
      VALUES (${workspaceId},'papercusp',${subject},'# Export',md5('# Export'),1,'Export','active','su-test')`;
    const proposed = await rubrics.proposeRubric({
      rubricId: 'unified-proposal-acceptance',
      kind: 'acceptance',
      subjectPlan: subject,
      characteristic: 'plan-acceptance',
      title: 'Complete export',
      by: 'requirement-author',
      criteria: [
        {
          key: 'complete-export',
          title: 'Complete export',
          intent: { request: 'Export every record.', sourceRefs: ['request:export'] },
          acceptance: {
            condition: 'The export contains every selected record.',
            falsifier: 'A selected record is missing.',
            requiredScope: ['tree'],
            requiredTestLayers: ['integration'],
            evidencePlane: 'tree',
            role: 'outcome',
            mandatory: true,
            passRatings: ['healthy'],
          },
          verification: {
            method: 'Run the export fixture.',
            check: { kind: 'tests', files: ['packages/operator-core/lib/acceptance-bar-seed.test.ts'] },
          },
        },
      ],
    });
    expect(proposed.criteria[0]).toMatchObject({
      key: 'complete-export',
      intent: { request: 'Export every record.', sourceRefs: ['request:export'] },
      model: 'The export contains every selected record.',
      driftMarkers: 'A selected record is missing.',
      method: 'Run the export fixture.',
      requiredTestLayers: ['integration'],
      check: { kind: 'tests', files: ['packages/operator-core/lib/acceptance-bar-seed.test.ts'] },
    });
    const stored = await storedTemplateData(proposed.rubricId);
    expect(stored.criteria[0]).not.toHaveProperty('acceptance');
    expect(stored.criteria[0]).not.toHaveProperty('verification');
  });

  it('rejects a method substitution after an outside-lineage BAR amendment preview was approved', async () => {
    const seeded = await seedBarContract('approval-method-substitution-subject', { authorMethods: true });
    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    const key = before.criteria[0]!.key;
    const amendment = {
      rubricId: seeded.rubricSlug,
      actorId: 'amendment-actor',
      reason: 'Change the outcome while preserving the reviewed verification method.',
      requirement: {
        key,
        acceptance: { condition: 'The first outcome holds after the approved change.' },
        verification: { method: 'Reviewer-approved method.' },
      },
    };
    const preview = await rubrics.previewAcceptanceBarAmendment(amendment);
    expect(preview).toMatchObject({ approvalRequired: true });

    const approvalRef = await postApproval(amendment);
    const substituted = {
      ...amendment,
      requirement: {
        ...amendment.requirement,
        verification: { method: 'Different method than the outside reviewer previewed.' },
      },
      approvalRef,
    };
    await expect(rubrics.amendRubric(substituted)).rejects.toThrow('acceptance_bar_approval_patch_mismatched');
    const exactPreview = await rubrics.amendRubric({ ...amendment, approvalRef });
    expect(exactPreview!.criteria[0]!).toMatchObject({
      model: amendment.requirement.acceptance.condition,
      method: amendment.requirement.verification.method,
    });
  });

  it('keeps an isolated method-only amendment approval-free', async () => {
    const seeded = await seedBarContract('method-only-no-approval-subject', { authorMethods: true });
    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    const amendment = {
      rubricId: seeded.rubricSlug,
      actorId: 'method-author',
      reason: 'Clarify the verification procedure without changing the outcome.',
      requirement: {
        key: before.criteria[0]!.key,
        verification: { method: 'Run the focused fixture and compare every output record.' },
      },
    };
    const preview = await rubrics.previewAcceptanceBarAmendment(amendment);
    expect(preview).toMatchObject({ approvalRequired: false, changedBars: [] });
    const after = await rubrics.amendRubric(amendment);
    expect(after!.criteria[0]!.method).toBe(amendment.requirement.verification.method);
    expect(after!.barSetHash).toBe(before.barSetHash);
  });

  it('amends unified proof depth with approval, preserves BAR identity for methods, and retains projection history', async () => {
    const seeded = await seedBarContract('unified-amendment-subject', { authorMethods: true });
    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    const key = before.criteria[0]!.key;
    const amendment = {
      rubricId: seeded.rubricSlug,
      actorId: 'amendment-actor',
      reason: 'Require integration proof of the outcome.',
      requirement: { key, acceptance: { requiredTestLayers: ['integration'] } },
    };
    const proofDepthPreview = await rubrics.previewAcceptanceBarAmendment(amendment);
    expect(proofDepthPreview!.changes).toContainEqual(
      expect.objectContaining({
        barKey: 'R-1',
        kinds: ['bar-meaning'],
        fields: ['requiredTestLayers'],
      }),
    );
    await expect(rubrics.amendRubric(amendment)).rejects.toThrow('acceptance_bar_approval_required');
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(before.revision);
    const changed = (await rubrics.amendRubric({ ...amendment, approvalRef: await postApproval(amendment) }))!;
    expect(changed.revision).toBe(before.revision! + 1);
    expect(changed.criteria[0]!.barKey).toBe(before.criteria[0]!.barKey);
    expect(changed.criteria[0]!.barHash).not.toBe(before.criteria[0]!.barHash);
    expect(changed.criteria[1]).toEqual(before.criteria[1]);

    const method = {
      method: 'Run the integration fixture and compare every output record.',
      check: { kind: 'tests' as const, files: [
        'packages/operator-core/lib/acceptance-bar-seed.test.ts',
        'packages/operator-core/lib/rubrics.integration.test.ts',
      ] },
    };
    const preview = await rubrics.previewAcceptanceBarAmendment({
      rubricId: seeded.rubricSlug,
      actorId: 'method-author',
      requirement: { key, verification: method },
    });
    expect(preview).toMatchObject({ approvalRequired: false, nextBarSetHash: changed.barSetHash });
    const verified = (await rubrics.amendRubric({
      rubricId: seeded.rubricSlug,
      actorId: 'method-author',
      requirement: { key, verification: method },
    }))!;
    expect(verified.barSetHash).toBe(changed.barSetHash);
    expect(verified.criteria[0]).toMatchObject({ ...method, barHash: changed.criteria[0]!.barHash });
    expect(verified.criteria[1]).toEqual(changed.criteria[1]);

    // The complete-set door must normalize before its transaction's check/path
    // preflight too; no flat method/check is supplied by this caller.
    const replaced = (await rubrics.amendRubric({
      rubricId: seeded.rubricSlug,
      actorId: 'method-author',
      criteria: verified.criteria.map(
        ({ model, bar: _bar, driftMarkers, method: oldMethod, check, replication, ...criterion }) => ({
          ...criterion,
          acceptance: { condition: model, falsifier: driftMarkers },
          verification: { method: oldMethod, ...(check ? { check } : {}), ...(replication ? { replication } : {}) },
        }),
      ),
    }))!;
    expect(replaced.barSetHash).toBe(verified.barSetHash);
    expect(replaced.criteria[0]).toMatchObject(method);
    expect(replaced.revision).toBeGreaterThan(changed.revision!);
    const revisions = await db.adminSql`SELECT r.source_bar_key, r.required_test_layers, r.revision,
      r.source_rubric_revision FROM harness_shared.plan_spec_clauses c
      JOIN harness_shared.plan_spec_clause_revisions r USING (workspace_id,harness_slug,plan_slug,spec_id)
      WHERE c.workspace_id=${seeded.workspaceId} AND c.harness_slug='papercusp' AND c.plan_slug=${seeded.subject}
      ORDER BY c.spec_id,r.revision`;
    const first = revisions.filter((row) => row.source_bar_key === 'R-1');
    expect(first[0]!.required_test_layers).toEqual([]);
    expect(first.at(-1)!.required_test_layers).toEqual(['integration']);
    // Later verification-method edits do not churn the meaning revision, so the
    // clause stays pinned to the rubric revision that changed its required layers.
    expect(Number(first.at(-1)!.source_rubric_revision)).toBe(changed.revision);
    expect(first.length).toBeGreaterThan(2);
    expect(revisions.filter((row) => row.source_bar_key === 'R-2').at(-1)!.required_test_layers).toEqual(['unit']);
  });

  // D-002 (review-routing-through-relevance-router-2026-09-26, P-009): an amendment whose every
  // change is mechanically additive skips the outside-lineage approval; a removal or a rewording
  // keeps it, and so does a mixed amendment. The replacement case above (['unit'] → ['integration'])
  // drops a layer, so it still requires approval.
  async function subjectContent(subject: string) {
    const [row] = await db.adminSql`SELECT content FROM harness_shared.harness_plans
      WHERE workspace_id=${activeWorkspaceId()} AND harness_slug='papercusp' AND plan_slug=${subject}`;
    return String(row!.content);
  }
  // `model` is canonical and `bar` is its alias; a reword must drop the alias or match it.
  function reword<T extends { bar?: unknown }>({ bar: _bar, ...criterion }: T, model: string) {
    return { ...criterion, model };
  }

  it('preserves a proved legacy acceptance preimage before a started-BAR amendment', async () => {
    const seeded = await seedBarContract('legacy-acceptance-preimage-subject', { authorMethods: true });
    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    const templateData = await storedTemplateData(seeded.rubricSlug);
    const [latest] = await db.adminSql<{ id: string; content_snapshot: string }[]>`
      SELECT id, content_snapshot FROM harness_shared.plan_revisions
       WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp'
         AND plan_slug = ${seeded.rubricSlug} ORDER BY seq DESC LIMIT 1`;
    const body = latest!.content_snapshot.split('## Structured rubric data (`template_data`)')[0]!.trimEnd();
    const legacySnapshot = `${body}\n\n## Structured rubric data (\`template_data\`)\n\n~~~json\n${JSON.stringify(templateData, null, 2)}\n~~~\n`;
    await db.adminSql`UPDATE harness_shared.plan_revisions SET content_snapshot = ${legacySnapshot}
      WHERE id = ${latest!.id} AND workspace_id = ${activeWorkspaceId()}`;
    await rubrics.amendRubric({
      rubricId: seeded.rubricSlug, actorId: 'amendment-actor',
      reason: 'Require an additional recorded layer.',
      requirement: { key: before.criteria[0]!.key, acceptance: { requiredTestLayers: ['unit', 'integration'] } },
    });
    const historical = await rubrics.getRubric(seeded.rubricSlug, before.revision!);
    expect(historical?.revision).toBe(before.revision);
    expect(historical?.criteria).toEqual(before.criteria);
    const [original] = await db.adminSql<{ content_snapshot: string }[]>`
      SELECT content_snapshot FROM harness_shared.plan_revisions WHERE id = ${latest!.id}
       AND workspace_id = ${activeWorkspaceId()}`;
    expect(original!.content_snapshot).toBe(legacySnapshot);
  });

  it('applies a started-BAR amendment that only grows required test layers without approval', async () => {
    const seeded = await seedBarContract('additive-layer-amendment-subject', { authorMethods: true });
    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    const key = before.criteria[0]!.key;
    const amendment = {
      rubricId: seeded.rubricSlug,
      actorId: 'amendment-actor',
      reason: 'Also require integration proof of the outcome.',
      requirement: { key, acceptance: { requiredTestLayers: ['unit', 'integration'] } },
    };
    const preview = (await rubrics.previewAcceptanceBarAmendment(amendment))!;
    expect(preview).toMatchObject({
      changedBars: ['R-1'],
      approvalRequired: false,
      approvalClassification: { additiveBars: ['R-1'], reviewedBars: [] },
    });
    const changed = (await rubrics.amendRubric(amendment))!;
    expect(changed.revision).toBe(before.revision! + 1);
    // The canonical writer stores required layers sorted.
    expect(changed.criteria[0]!.requiredTestLayers).toEqual(['integration', 'unit']);
    expect(changed.criteria[0]!.barHash).not.toBe(before.criteria[0]!.barHash);
    expect(changed.criteria[1]).toEqual(before.criteria[1]);
    expect(await subjectContent(seeded.subject)).toContain(
      'Approval: not required — every change is additive (R-1)',
    );
  });

  it('applies a first check and proof layer to seeded BARs without approval', async () => {
    const seeded = await seedBarContract('additive-check-amendment-subject');
    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    expect(before.criteria.every((criterion) => !criterion.check)).toBe(true);
    const amendment: Parameters<typeof rubrics.amendRubric>[0] = {
      rubricId: seeded.rubricSlug,
      actorId: 'method-author',
      reason: 'Author METHOD and deterministic checks for the seeded acceptance contract.',
      criteria: before.criteria.map((criterion) => ({
        ...criterion,
        method: 'Execute the seeded acceptance fixture.',
        check: { kind: 'tests' as const, files: ['packages/operator-core/lib/acceptance-bar-seed.test.ts'] },
        requiredTestLayers: ['unit'],
      })),
    };
    const preview = (await rubrics.previewAcceptanceBarAmendment(amendment))!;
    expect(preview.changedBars).toEqual(['R-1', 'R-2']);
    expect(preview.approvalRequired).toBe(false);
    expect(preview.approvalClassification).toEqual({ additiveBars: ['R-1', 'R-2'], reviewedBars: [] });
    const applied = (await rubrics.amendRubric(amendment))!;
    expect(applied.revision).toBe(before.revision! + 1);
    expect(applied.criteria.map((criterion) => criterion.check?.kind)).toEqual(['tests', 'tests']);
    expect(await subjectContent(seeded.subject)).toContain(
      'Approval: not required — every change is additive (R-1, R-2)',
    );
  });

  it('still requires approval for a started-BAR prose rewording', async () => {
    const seeded = await seedBarContract('reworded-bar-amendment-subject', { authorMethods: true });
    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    const amendment: Parameters<typeof rubrics.amendRubric>[0] = {
      rubricId: seeded.rubricSlug,
      actorId: 'amendment-actor',
      reason: 'Loosen the first outcome.',
      criteria: before.criteria.map((criterion) =>
        criterion.barKey === 'R-1' ? reword(criterion, 'The first outcome usually holds.') : criterion,
      ),
    };
    const preview = (await rubrics.previewAcceptanceBarAmendment(amendment))!;
    expect(preview.changedBars).toEqual(['R-1']);
    expect(preview.approvalRequired).toBe(true);
    expect(preview.approvalClassification).toEqual({
      additiveBars: [],
      reviewedBars: [{ barKey: 'R-1', reason: expect.stringMatching(/changed$/) }],
    });
    await expect(rubrics.amendRubric(amendment)).rejects.toThrow('acceptance_bar_approval_required');
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(before.revision);
    const approved = (await rubrics.amendRubric({ ...amendment, approvalRef: await postApproval(amendment) }))!;
    expect(approved.revision).toBe(before.revision! + 1);
    expect(await subjectContent(seeded.subject)).not.toContain('Approval: not required');
  });

  it('still requires approval when an additive change is mixed with a rewording', async () => {
    const seeded = await seedBarContract('mixed-bar-amendment-subject', { authorMethods: true });
    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    const amendment: Parameters<typeof rubrics.amendRubric>[0] = {
      rubricId: seeded.rubricSlug,
      actorId: 'amendment-actor',
      reason: 'Add integration proof to R-1 and reword R-2.',
      criteria: before.criteria.map((criterion) =>
        criterion.barKey === 'R-1'
          ? { ...criterion, requiredTestLayers: ['unit', 'integration'] }
          : reword(criterion, 'The second outcome usually holds.'),
      ),
    };
    const preview = (await rubrics.previewAcceptanceBarAmendment(amendment))!;
    expect(preview.changedBars).toEqual(['R-1', 'R-2']);
    expect(preview.approvalRequired).toBe(true);
    expect(preview.approvalClassification.additiveBars).toEqual(['R-1']);
    expect(preview.approvalClassification.reviewedBars.map((bar) => bar.barKey)).toEqual(['R-2']);
    await expect(rubrics.amendRubric(amendment)).rejects.toThrow('acceptance_bar_approval_required');
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(before.revision);
  });

  it('previews structural plane amendments without writes and requires an actual outside-lineage approval', async () => {
    const seeded = await seedBarContract('plane-approval-subject', { authorMethods: true });
    const before = await rubrics.getRubric(seeded.rubricSlug);
    const amendment = {
      rubricId: seeded.rubricSlug,
      actorId: 'amendment-actor',
      reason: 'Require observed live behavior.',
      criterionEvidencePlane: { key: before!.criteria[0]!.key, evidencePlane: 'live' as const },
    };
    const noOpScreen = await rubrics.previewAcceptanceBarAmendment({
      ...amendment,
      criterionEvidencePlane: { key: before!.criteria[0]!.key, evidencePlane: 'tree' as const },
      approvedBy: 'outside-reviewer',
    });
    expect(noOpScreen!.changedBars).toEqual([]);
    expect(noOpScreen!.approvalRequired).toBe(false);
    expect(noOpScreen!.approverEligibility).toEqual({
      approvedBy: 'outside-reviewer',
      eligible: true,
      relatedImplementer: null,
      eligibleWithUnrelatedApplier: true,
      approvalRequired: false,
      reason: 'no bar meaning changed',
    });
    expect(noOpScreen!.implementers).toBeUndefined();
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(before!.revision);

    const noOpSelfScreen = await rubrics.previewAcceptanceBarAmendment({
      ...amendment,
      criterionEvidencePlane: { key: before!.criteria[0]!.key, evidencePlane: 'tree' as const },
      approvedBy: 'amendment-actor',
    });
    expect(noOpSelfScreen!.approverEligibility).toEqual({
      approvedBy: 'amendment-actor',
      eligible: null,
      selfScreen: true,
      note: 'Self-screening cannot establish eligibility; have a different requester screen this candidate.',
      approvalRequired: false,
      reason: 'no bar meaning changed',
    });

    const preview = await rubrics.previewAcceptanceBarAmendment(amendment);
    expect(preview!.changedBars).toEqual(['R-1']);
    expect(preview!.projectionCount).toBe(2);
    expect(preview!.changes).toContainEqual(
      expect.objectContaining({ barKey: 'R-1', kinds: ['bar-meaning', 'evidence-plane'] }),
    );
    // rubric starts at 2, not 1: seeding now authors METHOD/check first.
    expect(preview!.revisionMovement).toMatchObject({ rubric: { from: 2, to: 3 }, subject: { from: 2, to: 3 } });
    expect(preview!.approval.bars[0]!.priorBarHash).toBe(before!.criteria[0]!.barHash);
    expect(preview!.approval.bars[0]!.nextBarHash).not.toBe(before!.criteria[0]!.barHash);
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(before!.revision);
    // EI-23806582233421348: the independence verdict must be reachable from the PREVIEW,
    // so an ineligible reviewer is discovered before a review wake is spent on them.
    // The two screens below are a CONTROL PAIR and both halves are load-bearing: an
    // implementation that always answered `eligible:false` would satisfy the first
    // assertion alone, and the apply calls immediately after independently confirm that
    // each screen predicted the right outcome for the same two identities.
    const ineligibleScreen = await rubrics.previewAcceptanceBarAmendment({
      ...amendment,
      approvedBy: 'amendment-actor',
    });
    expect(ineligibleScreen!.implementers).toContain('amendment-actor');
    expect(ineligibleScreen!.independencePopulation).toContainEqual({
      ownerId: 'amendment-actor',
      relation: 'caller',
    });
    // A self-screen cannot distinguish caller lineage from durable implementer lineage, so it
    // must return an explicit non-verdict instead of a confident false.
    expect(ineligibleScreen!.approverEligibility).toEqual({
      approvedBy: 'amendment-actor',
      eligible: null,
      selfScreen: true,
      note: 'Self-screening cannot establish eligibility; have a different requester screen this candidate.',
    });
    // The other half of that pair, and it is load-bearing: a DURABLE relation must not be
    // reported as curable, or `eligibleWithUnrelatedApplier` would be vacuously true for
    // everyone and the distinction above would carry no information.
    const durableImplementer = ineligibleScreen!.implementers!.find((id) => id !== 'amendment-actor');
    expect(durableImplementer).toBeTruthy();
    const durableScreen = await rubrics.previewAcceptanceBarAmendment({
      ...amendment,
      approvedBy: durableImplementer!,
    });
    expect(durableScreen!.approverEligibility).toMatchObject({
      eligible: false,
      relatedImplementer: durableImplementer!,
      eligibleWithUnrelatedApplier: false,
    });
    expect(durableScreen!.approverEligibility).not.toHaveProperty('selfScreen');
    if (durableScreen!.approverEligibility && 'relatedVia' in durableScreen!.approverEligibility) {
      expect(durableScreen!.approverEligibility.relatedVia).not.toBe('caller');
    }
    const eligibleScreen = await rubrics.previewAcceptanceBarAmendment({
      ...amendment,
      approvedBy: 'outside-reviewer',
    });
    expect(eligibleScreen!.implementers).not.toContain('outside-reviewer');
    expect(eligibleScreen!.approverEligibility).toEqual({
      approvedBy: 'outside-reviewer',
      eligible: true,
      relatedImplementer: null,
      eligibleWithUnrelatedApplier: true,
    });
    const reviewerPreview = await rubrics.previewAcceptanceBarAmendment({
      ...amendment,
      actorId: 'outside-reviewer',
    });
    expect(reviewerPreview!.implementers).toContain('outside-reviewer');
    expect(reviewerPreview!.independencePopulation).toContainEqual({
      ownerId: 'outside-reviewer',
      relation: 'caller',
    });
    // Naming no approver asks no eligibility question, so none is answered — but the
    // independence population is still published for a caller screening candidates.
    const unscreened = await rubrics.previewAcceptanceBarAmendment(amendment);
    expect(unscreened!.approverEligibility).toBeUndefined();
    expect(unscreened!.implementers).toContain('amendment-actor');
    await expect(
      rubrics.amendRubric({ ...amendment, approvalRef: await postApproval(amendment, 'amendment-actor') }),
    ).rejects.toThrow('acceptance_bar_approval_in_implementer_lineage');
    const approvalRef = await postApproval(amendment);
    const after = await rubrics.amendRubric({ ...amendment, approvalRef });
    expect(after!.criteria[0]!.evidencePlane).toBe('live');
    const projections = await db.adminSql`SELECT r.source_bar_key, r.evidence_plane, r.required_evidence
      FROM harness_shared.plan_spec_clauses c
      JOIN harness_shared.plan_spec_clause_revisions r USING (workspace_id,harness_slug,plan_slug,spec_id)
      WHERE c.workspace_id=${seeded.workspaceId} AND c.harness_slug='papercusp' AND c.plan_slug=${seeded.subject}
        AND r.revision=c.current_revision ORDER BY c.spec_id`;
    expect(projections[0]!.evidence_plane).toBe('live');
    expect(projections[0]!.required_evidence).toContain('live');
    expect(projections[1]!.evidence_plane).toBe('tree');
  });

  it('screens a reviewer from durable lineage without reconstructing the amendment candidate', async () => {
    const seeded = await seedBarContract('approver-route-precheck');
    const [audit] = await db.adminSql<Array<{ next_seq: number }>>`
      SELECT COALESCE(MAX(audit_seq), 0)::int + 1 AS next_seq
        FROM harness_shared.plan_audits
       WHERE workspace_id = ${seeded.workspaceId}
         AND harness_slug = 'papercusp'
         AND plan_slug = ${seeded.subject}`;
    await db.adminSql`
      INSERT INTO harness_shared.plan_audits
        (workspace_id, harness_slug, plan_slug, audit_seq, created_by, audit_kind,
         activation, audited_plan_revision_id, audited_plan_revision_seq, audited_plan_content_hash)
      VALUES (${seeded.workspaceId}, 'papercusp', ${seeded.subject}, ${audit!.next_seq},
              'su-precheck-implementer', 'completion', NULL, NULL, NULL, NULL)`;

    const implementer = await rubrics.checkAcceptanceBarApproverEligibility({
      rubricId: seeded.rubricSlug,
      ownerId: 'su-precheck-implementer',
    });
    expect(implementer).toMatchObject({
      eligible: false,
      reason: 'related_to_plan_implementer',
      eligibleWithUnrelatedApplier: false,
    });

    const external = await rubrics.checkAcceptanceBarApproverEligibility({
      rubricId: seeded.rubricSlug,
      ownerId: 'su-precheck-external-reviewer',
    });
    expect(external).toMatchObject({
      eligible: true,
      reason: 'eligible',
      eligibleWithUnrelatedApplier: true,
    });

    const sameAsApplier = await rubrics.checkAcceptanceBarApproverEligibility({
      rubricId: seeded.rubricSlug,
      ownerId: 'su-precheck-applier',
      applierId: 'su-precheck-applier',
    });
    expect(sameAsApplier).toMatchObject({
      eligible: false,
      reason: 'related_to_applier',
      eligibleWithUnrelatedApplier: true,
    });
  });

  it('METHOD review screens related sources and freshly reserved answerers with the same canonical lineage rule', async () => {
    const seeded = await seedBarContract('method-review-native-independence');
    const target = { rubricId: seeded.rubricSlug, applierId: 'amendment-actor' };
    // The applier is part of the canonical population even without an audit row.
    const sources = ['amendment-actor', 'method-independent-source'].map(ownerId => ({ ownerId, score: 0.9 }));
    const { filterAmendmentReviewRoute } = await import('./consult/acceptance-bar-amendment-review');
    const screen = await rubrics.resolveAcceptanceBarApproverScreen(target);
    const route = await filterAmendmentReviewRoute({ qualified: sources, snapshot: { candidates: sources } } as never, screen.check);
    expect(route.qualified.map(c => c.ownerId)).toEqual(['method-independent-source']);
    expect(route.snapshot.candidates.map(c => c.ownerId)).toEqual(['method-independent-source']);
    for (const [source, answerer] of [
      ['amendment-actor', 'method-related-answerer'],
      ['method-independent-source', 'method-independent-answerer'],
    ]) {
      // The dispatch stamp exists BEFORE the actual-answerer check/spawn. Its
      // canonical edge follows the source, independent of a requester launcher.
      await db.adminSql`INSERT INTO harness_shared.consult_state
        (workspace_id, conversation_id, requester_id, responder_id, state, question, latency_contract, routing)
        VALUES (${seeded.workspaceId}, ${`conv-${answerer}`}, 'amendment-actor', ${source!},
          'awaiting_responder', 'current method', 'hard-blocked',
          ${db.adminSql.json({ policy: 'method-review', methodReviewRubricRef: seeded.rubricSlug,
            selection: { selected: [{ ownerId: source, answeringOwnerId: answerer, via: 'minimum' }] } } as never)})`;
      const actual = await rubrics.checkAcceptanceBarApproverEligibility({ ...target, ownerId: answerer! });
      expect(actual.eligible).toBe(source === 'method-independent-source');
    }
  });

  it('P-005: the apply accepts an approval from a routed fork the applier requested, and still refuses an ordinary child', async () => {
    // review-routing-through-relevance-router-2026-09-26 P-005. The applier REQUESTS a routed
    // amendment review, and the consult dispatcher records the requester as the answering
    // fork's launcher (get-feedback-prod passes launchedBy = requester). The fork answers from
    // an OUTSIDE expert's transcript, so its lineage is that source's, not the requester's.
    // The ordinary child is the control: the same launch edge without a consult-dispatch edge
    // IS lineage, so the apply must still refuse it. Without it, a guard that ignored launch
    // edges entirely would pass this test.
    const seeded = await seedBarContract('routed-fork-approval-subject', { authorMethods: true });
    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    const amendment = {
      rubricId: seeded.rubricSlug,
      actorId: 'amendment-actor',
      reason: 'Move the BAR to live evidence.',
      criterionEvidencePlane: { key: before.criteria[0]!.key, evidencePlane: 'live' as const },
    };
    await db.adminSql`INSERT INTO harness_shared.adv_sessions ${db.adminSql([
      {
        workspace_id: seeded.workspaceId,
        mode: 'console',
        coord_owner_id: 'su-routed-review-fork',
        launch_spec: { launchedBy: 'amendment-actor' },
      },
      {
        workspace_id: seeded.workspaceId,
        mode: 'console',
        coord_owner_id: 'su-applier-ordinary-child',
        launch_spec: { launchedBy: 'amendment-actor' },
      },
    ] as never)}`;
    await db.adminSql`INSERT INTO harness_shared.consult_state ${db.adminSql([
      {
        workspace_id: seeded.workspaceId,
        conversation_id: 'conv-routed-fork-approval',
        requester_id: 'amendment-actor',
        responder_id: 'su-routed-review-expert',
        state: 'awaiting_responder',
        question: 'q',
        latency_contract: 'hard-blocked',
        routing: db.adminSql.json({
          policy: 'acceptance-bar-amendment-review',
          selection: {
            selected: [
              { ownerId: 'su-routed-review-expert', via: 'floor', answeringOwnerId: 'su-routed-review-fork' },
            ],
          },
        } as never),
      },
    ] as never)}`;

    await expect(
      rubrics.checkAcceptanceBarApproverEligibility({
        rubricId: seeded.rubricSlug,
        ownerId: 'su-routed-review-fork',
        applierId: 'amendment-actor',
      }),
    ).resolves.toMatchObject({ eligible: true, reason: 'eligible' });
    await expect(
      rubrics.amendRubric({ ...amendment, approvalRef: await postApproval(amendment, 'su-applier-ordinary-child') }),
    ).rejects.toThrow("acceptance_bar_approval_in_implementer_lineage: 'su-applier-ordinary-child' is related to 'amendment-actor'");
    const after = await rubrics.amendRubric({
      ...amendment,
      approvalRef: await postApproval(amendment, 'su-routed-review-fork'),
    });
    expect(after!.criteria[0]!.evidencePlane).toBe('live');
  });

  it('validates a supplied approval receipt during dry-run preview', async () => {
    const seeded = await seedBarContract('dry-run-approval-receipt-subject', { authorMethods: true });
    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    const approvedAmendment = {
      rubricId: seeded.rubricSlug,
      actorId: 'amendment-actor',
      reason: 'Move the BAR to live evidence.',
      criterionEvidencePlane: { key: before.criteria[0]!.key, evidencePlane: 'live' as const },
    };
    const approvalRef = await postApproval(approvedAmendment);

    await expect(
      rubrics.previewAcceptanceBarAmendment({ ...approvedAmendment, approvalRef }),
    ).resolves.toMatchObject({ approvalRequired: true, changedBars: ['R-1'] });

    await expect(
      rubrics.previewAcceptanceBarAmendment({
        ...approvedAmendment,
        criterionEvidencePlane: { ...approvedAmendment.criterionEvidencePlane, evidencePlane: 'deployed' },
        approvalRef,
      }),
    ).rejects.toThrow('acceptance_bar_approval_stale_or_mismatched');

    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(before.revision);
  });

  it('serializes competing BAR amendments and refuses the stale CAS without partial writes', async () => {
    const seeded = await seedBarContract('concurrent-bar-subject', { authorMethods: true });
    const before = await rubrics.getRubric(seeded.rubricSlug);
    const inputs = ['live', 'deployed'].map((evidencePlane) => ({
      rubricId: seeded.rubricSlug,
      actorId: 'amendment-actor',
      reason: `Require ${evidencePlane} evidence.`,
      expectedRubricRevision: before!.revision,
      criterionEvidencePlane: { key: before!.criteria[0]!.key, evidencePlane: evidencePlane as 'live' | 'deployed' },
    }));
    const first = { ...inputs[0]!, approvalRef: await postApproval(inputs[0]!) };
    const second = { ...inputs[1]!, approvalRef: await postApproval(inputs[1]!) };
    const [historyBefore] = await db.adminSql`SELECT count(*)::int AS n FROM harness_shared.plan_spec_clause_revisions
      WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.subject}`;
    const results = await Promise.allSettled([rubrics.amendRubric(first), rubrics.amendRubric(second)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refusal = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    // The loser is refused by whichever serialization mechanism reaches it
    // first, and BOTH are correct outcomes of this path: the revision CAS when
    // it gets far enough to compare, or the row lock while the winner still
    // holds it. amendRubric takes a BLOCKING `SELECT ... FOR UPDATE`
    // (acceptance-bar-amendment.ts:97) under a 5s lock_timeout
    // (txn-timeouts-config.ts), so when the winning transaction outlives that
    // window the lock refuses first and the CAS branch is unreachable — which
    // made this assertion fail for an environment reason while the system did
    // exactly what the test is named for (serialize, admit one, write nothing
    // partial). Those invariants are still asserted, above and below.
    // This is NOT a loosening: the stale-CAS refusal is pinned
    // DETERMINISTICALLY by the sequential test immediately below, where no
    // competing lock holder exists, so the specific code is still covered.
    // When the lock path wins, the cross-plan transaction boundary must expose
    // the same typed timeout contract as the rest of operator-core rather than
    // leaking the raw PostgresError.
    if (refusal.reason instanceof OrgTxnTimeoutError) {
      expect(refusal.reason.pgCode).toBe('55P03');
    } else {
      expect(String(refusal.reason)).toMatch(/acceptance_bar_amendment_revision_conflict/);
    }
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(before!.revision! + 1);
    const [history] = await db.adminSql`SELECT count(*)::int AS n FROM harness_shared.plan_spec_clause_revisions
      WHERE workspace_id=${seeded.workspaceId} AND harness_slug='papercusp' AND plan_slug=${seeded.subject}`;
    // The winner changes R-1 only; R-2 retains its stable clause revision.
    expect(Number(history.n)).toBe(Number(historyBefore!.n) + 1);
  });

  it('refuses a stale expectedRubricRevision with the revision-conflict code when no lock competes', async () => {
    const seeded = await seedBarContract('sequential-stale-cas-subject', { authorMethods: true });
    const before = await rubrics.getRubric(seeded.rubricSlug);
    const inputs = ['live', 'deployed'].map((evidencePlane) => ({
      rubricId: seeded.rubricSlug,
      actorId: 'amendment-actor',
      reason: `Require ${evidencePlane} evidence.`,
      expectedRubricRevision: before!.revision,
      criterionEvidencePlane: { key: before!.criteria[0]!.key, evidencePlane: evidencePlane as 'live' | 'deployed' },
    }));
    // Both approvals are minted against the PRE-amendment state, so once the
    // first amendment lands the second carries a genuinely stale
    // expectedRubricRevision.
    const first = { ...inputs[0]!, approvalRef: await postApproval(inputs[0]!) };
    const second = { ...inputs[1]!, approvalRef: await postApproval(inputs[1]!) };
    await rubrics.amendRubric(first);
    // Sequential, so no competing row lock exists and the revision CAS is
    // always REACHED. This is the deterministic home of the specific-code
    // assertion that the concurrent test above cannot make reliably: there the
    // 5s lock_timeout can refuse the loser first (see the comment there), here
    // nothing holds the lock, so the conflict code is the only possible refusal.
    await expect(rubrics.amendRubric(second)).rejects.toThrow(/acceptance_bar_amendment_revision_conflict/);
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(before!.revision! + 1);
  });

  // EI-24358433996857425 (acceptance-bar-atomic-retirement-2026-10-15 P-001). An approved
  // amendment that RETIRES a started BAR whose only mapped work was dropped must reconcile
  // the plan source inside the same amendment. Pre-fix, the amendment validated the
  // ORIGINAL source's Bar-to-work map first, so `bar_mapping_dropped_only: R-2` refused
  // before the removal exemption below it could run: the retirement was unreachable on
  // preview AND apply. The two CONTROLS are calibration and pass both before and after the
  // fix: a SURVIVING dropped-only BAR stays refused, and an unapproved removal stays refused.
  async function seedDroppedOnlyBar(subject: string) {
    const seeded = await seedBarContract(subject, { authorMethods: true });
    const workspaceId = activeWorkspaceId();
    const original = await subjectSource(subject);
    const dropped = original.replace('- **P-002** `done` second outcome', '- **P-002** `dropped` second outcome');
    expect(dropped).not.toBe(original);
    await db.adminSql`UPDATE harness_shared.harness_plans
       SET content = ${dropped}, content_hash = ${hashPlanContent(dropped)}
     WHERE workspace_id = ${workspaceId} AND harness_slug = 'papercusp' AND plan_slug = ${subject}`;
    await db.adminSql`UPDATE harness_shared.plan_items SET status = 'dropped'
     WHERE workspace_id = ${workspaceId} AND harness_slug = 'papercusp'
       AND plan_slug = ${subject} AND item_id = 'P-002'`;
    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    expect(before.criteria.map((criterion) => criterion.barKey)).toEqual(['R-1', 'R-2']);
    return { ...seeded, before, sourceBefore: dropped };
  }

  async function subjectSource(subject: string): Promise<string> {
    const [row] = await db.adminSql<{ content: string }[]>`
      SELECT content FROM harness_shared.harness_plans
       WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp' AND plan_slug = ${subject}`;
    return row!.content;
  }

  async function subjectClauses(subject: string) {
    const { listSpecClauses } = await import('./agent-tools/plans/spec-clauses-store');
    return listSpecClauses({ harnessSlug: 'papercusp', planSlug: subject });
  }

  /** Every durable member an amendment can touch: both plan rows (source, hash, version,
   *  template data, adoption pin), clause pointers, immutable clause history, proof bindings,
   *  work-binding edges and plan revision history. A refusal must leave all of it equal. */
  async function amendmentStateVector(seeded: { workspaceId: string; subject: string; rubricSlug: string }) {
    const scope = { ws: seeded.workspaceId, subject: seeded.subject };
    const plans = await db.adminSql`
      SELECT plan_slug, content, content_hash, version, template_data, acceptance_bar_rubric_slug,
             acceptance_bar_rubric_revision, acceptance_bar_set_hash, acceptance_bar_verified_revision
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${scope.ws} AND harness_slug = 'papercusp'
         AND plan_slug IN (${seeded.subject}, ${seeded.rubricSlug})
       ORDER BY plan_slug`;
    const pointers = await db.adminSql`
      SELECT spec_id, current_revision FROM harness_shared.plan_spec_clauses
       WHERE workspace_id = ${scope.ws} AND harness_slug = 'papercusp' AND plan_slug = ${scope.subject}
       ORDER BY spec_id`;
    const history = await db.adminSql`
      SELECT spec_id, revision, content_hash, lifecycle_status, source_bar_key, accepted_by
        FROM harness_shared.plan_spec_clause_revisions
       WHERE workspace_id = ${scope.ws} AND harness_slug = 'papercusp' AND plan_slug = ${scope.subject}
       ORDER BY spec_id, revision`;
    const bindings = await db.adminSql`
      SELECT spec_id, spec_revision, binding_fingerprint FROM harness_shared.spec_evidence_bindings
       WHERE workspace_id = ${scope.ws} AND harness_slug = 'papercusp' AND plan_slug = ${scope.subject}
       ORDER BY spec_id, spec_revision, binding_fingerprint`;
    const edges = await db.adminSql`
      SELECT work_item_id, spec_id, spec_revision FROM harness_shared.work_item_spec_revision_edges
       WHERE workspace_id = ${scope.ws} AND harness_slug = 'papercusp' AND plan_slug = ${scope.subject}
       ORDER BY work_item_id, spec_id, spec_revision`;
    const revisions = await db.adminSql`
      SELECT plan_slug, count(*)::int AS n FROM harness_shared.plan_revisions
       WHERE workspace_id = ${scope.ws} AND harness_slug = 'papercusp'
         AND plan_slug IN (${seeded.subject}, ${seeded.rubricSlug})
       GROUP BY plan_slug ORDER BY plan_slug`;
    return { plans, pointers, history, bindings, edges, revisions };
  }

  // acceptance-bar-atomic-retirement-2026-10-15 R-11: the SUBJECT-plan CAS, pinned
  // deterministically. The stale-CAS cases above pass only expectedRubricRevision, so a
  // regression that dropped the subject comparison survived every case in this file.
  it('R-11: a stale expectedSubjectPlanRevision is refused with the revision-conflict code and writes nothing', async () => {
    const seeded = await seedBarContract('sequential-stale-subject-cas-subject', { authorMethods: true });
    const before = (await rubrics.getRubric(seeded.rubricSlug))!;
    const live = {
      rubricId: seeded.rubricSlug,
      actorId: 'amendment-actor',
      reason: 'Require live evidence.',
      criterionEvidencePlane: { key: before.criteria[0]!.key, evidencePlane: 'live' as const },
    };
    // The approval reviews the change itself; the CAS is the caller's freshness claim.
    const approvalRef = await postApproval(live);
    const stateBefore = await amendmentStateVector(seeded);
    const subjectRevision = Number(stateBefore.plans.find((row) => row.plan_slug === seeded.subject)!.version);
    await expect(rubrics.amendRubric({ ...live, approvalRef, expectedSubjectPlanRevision: subjectRevision - 1 }))
      .rejects.toThrow(/acceptance_bar_amendment_revision_conflict: subject plan/);
    expect(await amendmentStateVector(seeded)).toEqual(stateBefore);
    // Calibration: the same approved input at the live subject revision applies.
    await rubrics.amendRubric({ ...live, approvalRef, expectedSubjectPlanRevision: subjectRevision });
    expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(before.revision! + 1);
  });

  // acceptance-bar-atomic-retirement-2026-10-15 R-33: a malformed-source refusal leaves the
  // complete durable state vector unchanged, on preview (which runs on the pool with no
  // wrapping transaction) AND on apply. The R-27 population here is a Bar-to-work map row
  // for a BAR with no Requirements record.
  it('R-33: a malformed-source refusal on preview and on apply leaves the complete durable state unchanged', async () => {
    const seeded = await seedBarContract('malformed-source-no-write-subject');
    const original = await subjectSource(seeded.subject);
    const malformed = original.replace('| R-2 | P-002 | tree |', '| R-2 | P-002 | tree |\n| R-8 | P-001 | tree |');
    expect(malformed).not.toBe(original);
    await db.adminSql`UPDATE harness_shared.harness_plans
       SET content = ${malformed}, content_hash = ${hashPlanContent(malformed)}
     WHERE workspace_id = ${seeded.workspaceId} AND harness_slug = 'papercusp' AND plan_slug = ${seeded.subject}`;
    // An explicit unchanged full-set resubmission: a real apply input (not "nothing to amend")
    // that needs no approval, so both calls reach the proposed-source validation.
    const input = {
      rubricId: seeded.rubricSlug,
      actorId: 'malformed-source-actor',
      reason: 'Resubmit the unchanged criteria over a malformed map.',
      criteria: (await rubrics.getRubric(seeded.rubricSlug))!.criteria,
    };
    const refusal = /acceptance_bar_amendment_mapping_invalid:bar_mapping_requirement_missing.*R-8/;
    const stateBefore = await amendmentStateVector(seeded);
    expect(stateBefore.pointers.length).toBeGreaterThan(0);

    await expect(rubrics.previewAcceptanceBarAmendment(input)).rejects.toThrow(refusal);
    expect(await amendmentStateVector(seeded)).toEqual(stateBefore);
    await expect(rubrics.amendRubric(input)).rejects.toThrow(refusal);
    expect(await amendmentStateVector(seeded)).toEqual(stateBefore);
  });

  // acceptance-bar-atomic-retirement-2026-10-15 R-27 / R-32: the malformed-source populations
  // at the production amendment boundary. Every case seeds the two-BAR contract, corrupts
  // the stored subject source, and resubmits the unchanged criteria (an apply input that
  // needs no approval, so preview AND apply both reach the proposed-source validation).
  const R2_RECORD = '**R-2 — Second outcome.** The second outcome holds.';
  const R2_MAP_ROW = '| R-2 | P-002 | tree |';

  async function seedMalformedSource(subject: string, malform: (source: string) => string) {
    const seeded = await seedBarContract(subject);
    const original = await subjectSource(seeded.subject);
    const malformed = malform(original);
    expect(malformed).not.toBe(original);
    await db.adminSql`UPDATE harness_shared.harness_plans
       SET content = ${malformed}, content_hash = ${hashPlanContent(malformed)}
     WHERE workspace_id = ${seeded.workspaceId} AND harness_slug = 'papercusp' AND plan_slug = ${seeded.subject}`;
    const input = {
      rubricId: seeded.rubricSlug,
      actorId: 'malformed-source-actor',
      reason: 'Resubmit the unchanged criteria over a malformed source.',
      criteria: (await rubrics.getRubric(seeded.rubricSlug))!.criteria,
    };
    return { seeded, input };
  }

  /** Send `input` through preview, then apply. Each must REFUSE (a resolved call is reported
   *  as `accepted`, which fails every refusal pattern) and leave the complete durable state
   *  vector unchanged. Returns both refusal messages. */
  async function refusalsAtBoundary(malformedSource: Awaited<ReturnType<typeof seedMalformedSource>>) {
    const { seeded, input } = malformedSource;
    const stateBefore = await amendmentStateVector(seeded);
    expect(stateBefore.pointers.length).toBeGreaterThan(0);
    const settle = (call: Promise<unknown>) => call.then(() => 'accepted', (error: Error) => error.message);
    const preview = await settle(rubrics.previewAcceptanceBarAmendment(input));
    expect(await amendmentStateVector(seeded)).toEqual(stateBefore);
    const apply = await settle(rubrics.amendRubric(input));
    expect(await amendmentStateVector(seeded)).toEqual(stateBefore);
    return { preview, apply };
  }

  /** An actionable domain result: one line, inside the maintained budget, no parser stack. */
  function expectActionableRefusal(message: string) {
    expect(message).not.toContain('\n');
    expect(message).not.toMatch(/\bat [\w.<>$]+ \((?:file:|node:|\/)|node:internal|ZodError/);
    expect(message.length).toBeLessThanOrEqual(rubrics.ACCEPTANCE_BAR_AMENDMENT_REFUSAL_BUDGET.maxMessageChars);
  }

  it.each([
    {
      population: 'a Requirements record line that is not `**R-N — Title.** outcome`',
      malform: (source: string) => source.replace(R2_RECORD, '**R-2 Second outcome** The second outcome holds.'),
      refusal: /^acceptance_bar_amendment_requirements_invalid:bar_requirement_parse_failed: malformed requirement record: \*\*R-2 Second outcome\*\*/,
    },
    {
      population: 'a titled Requirements record with no outcome statement',
      malform: (source: string) => source.replace(R2_RECORD, '**R-2 — Second outcome.**'),
      refusal: /^acceptance_bar_amendment_requirements_invalid:bar_requirement_parse_failed: R-2: R-2 has a title but no outcome statement$/,
    },
    {
      population: 'a Requirements record whose requirement block is not JSON',
      malform: (source: string) => source.replace(R2_RECORD, '**R-2 — Second outcome.**\n\n```requirement\n{not json}\n```'),
      refusal: /^acceptance_bar_amendment_requirements_invalid:bar_requirement_parse_failed: R-2: R-2: .*JSON/,
    },
    {
      population: 'a Requirements record whose requirement block fails the requirement schema',
      malform: (source: string) =>
        source.replace(R2_RECORD, '**R-2 — Second outcome.**\n\n```requirement\n{"acceptance":{"condition":7}}\n```'),
      refusal: /^acceptance_bar_amendment_requirements_invalid:bar_requirement_parse_failed: R-2: R-2: \S/,
    },
    {
      population: 'a duplicated Requirements record',
      malform: (source: string) =>
        source.replace(R2_RECORD, `${R2_RECORD}\n\n**R-2 — Second outcome, again.** A second record for the same key.`),
      refusal: /^acceptance_bar_amendment_requirements_invalid:bar_key_duplicate: R-2: duplicate requirement key R-2$/,
    },
    {
      population: 'a Bar-to-work map row whose item cell is not P-NNN ids',
      malform: (source: string) => source.replace(R2_MAP_ROW, '| R-2 | the second item | tree |'),
      refusal: /^acceptance_bar_amendment_mapping_invalid:bar_mapping_invalid: R-2: R-2 mapping must contain only one or more P-NNN ids/,
    },
    {
      population: 'a Bar-to-work map row with an unknown evidence plane',
      malform: (source: string) => source.replace(R2_MAP_ROW, '| R-2 | P-002 | orbit |'),
      refusal: /^acceptance_bar_amendment_mapping_invalid:bar_evidence_plane_invalid: R-2: R-2 evidence plane must be tree, deployed, or live/,
    },
    {
      population: 'a duplicated Bar-to-work map row',
      malform: (source: string) => source.replace(R2_MAP_ROW, `${R2_MAP_ROW}\n${R2_MAP_ROW}`),
      refusal: /^acceptance_bar_amendment_mapping_invalid:bar_mapping_duplicate: R-2: Bar-to-work map has duplicate row R-2$/,
    },
  ])('R-27: preview and apply refuse $population with the parser domain code, the offending key and no write', async ({ malform, refusal }) => {
    const subject = `malformed-boundary-${Math.random().toString(36).slice(2, 10)}-subject`;
    const { preview, apply } = await refusalsAtBoundary(await seedMalformedSource(subject, malform));
    expect(preview).toMatch(refusal);
    expect(apply).toBe(preview);
    expectActionableRefusal(preview);
  });

  // R-32: oversized malformed input. Before the budget, a map refusal echoed every offending
  // cell in full (one 5 KB title cell per row) and a Requirements refusal listed one bare code
  // per malformed record. The maintained bound is ACCEPTANCE_BAR_AMENDMENT_REFUSAL_BUDGET
  // (rubrics.ts): at most maxProblems problems, each detail clipped to maxDetailChars, a
  // count of the rest, and never more than maxMessageChars in total.
  const OVERSIZED_CELL = 'x'.repeat(5_000);
  const OVERSIZED_ROWS = 300;
  it.each([
    {
      population: 'Requirements source with 300 malformed 5 KB record lines',
      malform: (source: string) => source.replace(R2_RECORD, [
        R2_RECORD,
        ...Array.from({ length: OVERSIZED_ROWS }, (_, index) => `**R-${index + 10} ${OVERSIZED_CELL}**`),
      ].join('\n\n')),
      // The parser itself quotes at most 160 characters of a malformed record line.
      firstProblem: /^bar_requirement_parse_failed: malformed requirement record: \*\*R-10 x+$/,
      prefix: 'acceptance_bar_amendment_requirements_invalid',
    },
    {
      population: 'Bar-to-work map with 300 malformed 5 KB title cells',
      malform: (source: string) => source.replace(R2_MAP_ROW, [
        R2_MAP_ROW,
        ...Array.from({ length: OVERSIZED_ROWS }, (_, index) => `| R-${index + 10} — ${OVERSIZED_CELL} | P-001 | tree |`),
      ].join('\n')),
      firstProblem: /^bar_mapping_invalid: R-10: Bar-to-work map first cell must be the bare R-10 key, not its title \(received "R-10 — x+…$/,
      prefix: 'acceptance_bar_amendment_mapping_invalid',
    },
  ])('R-32: an oversized malformed $population is refused at the boundary inside the maintained result budget', async ({ malform, firstProblem, prefix }) => {
    const budget = rubrics.ACCEPTANCE_BAR_AMENDMENT_REFUSAL_BUDGET;
    const subject = `malformed-oversized-${Math.random().toString(36).slice(2, 10)}-subject`;
    const { preview, apply } = await refusalsAtBoundary(await seedMalformedSource(subject, malform));
    expect(apply).toBe(preview);
    expect(preview.startsWith(`${prefix}:`)).toBe(true);
    expectActionableRefusal(preview);

    const parts = preview.slice(prefix.length + 1).split('; ');
    const tail = parts.pop()!;
    const measurement = {
      chars: preview.length,
      bytes: Buffer.byteLength(preview, 'utf8'),
      shownProblems: parts.length,
      omittedProblems: Number(/^\+(\d+) more problem\(s\) not shown$/.exec(tail)?.[1] ?? Number.NaN),
      longestShownProblem: Math.max(...parts.map((part) => part.length)),
      budget,
    };
    console.info(`R-32 boundary result measurement ${JSON.stringify(measurement)}`);
    expect(measurement.shownProblems).toBe(budget.maxProblems);
    expect(measurement.omittedProblems).toBe(OVERSIZED_ROWS - budget.maxProblems);
    expect(measurement.chars).toBeLessThanOrEqual(budget.maxMessageChars);
    expect(measurement.bytes).toBeLessThanOrEqual(budget.maxMessageChars + 2 * (budget.maxProblems + 1));
    expect(parts[0]).toMatch(firstProblem);
    for (const part of parts) {
      const detail = part.split(': ').slice(1).join(': ');
      expect(detail.length).toBeLessThanOrEqual(budget.maxDetailChars + 'R-NNN: '.length);
    }
  });

  it('retires a started BAR whose only mapped work was dropped, reconciling its Requirements record and map row in the same amendment (EI-24358433996857425)', async () => {
    const { subject, rubricSlug, before, sourceBefore } = await seedDroppedOnlyBar('dropped-only-retire-subject');
    const clausesBefore = await subjectClauses(subject);
    const amendment = {
      rubricId: rubricSlug,
      actorId: 'amendment-actor',
      reason: 'Retire R-2: the only work that discharged it was dropped.',
      criteria: before.criteria.filter((criterion) => criterion.barKey !== 'R-2'),
    };

    const preview = await rubrics.previewAcceptanceBarAmendment(amendment);
    expect(preview!.changedBars).toEqual(['R-2']);
    // A preview persists nothing: not the rubric, not the source, not a projection.
    expect((await rubrics.getRubric(rubricSlug))!.revision).toBe(before.revision);
    expect(await subjectSource(subject)).toBe(sourceBefore);
    expect(await subjectClauses(subject)).toEqual(clausesBefore);

    // Unauthorized: an approval from the implementer lineage is refused with no partial write.
    await expect(
      rubrics.amendRubric({ ...amendment, approvalRef: await postApproval(amendment, 'amendment-actor') }),
    ).rejects.toThrow('acceptance_bar_approval_in_implementer_lineage');
    expect((await rubrics.getRubric(rubricSlug))!.revision).toBe(before.revision);
    expect(await subjectSource(subject)).toBe(sourceBefore);

    const after = await rubrics.amendRubric({ ...amendment, approvalRef: await postApproval(amendment) });
    expect(after!.criteria.map((criterion) => criterion.barKey)).toEqual(['R-1']);
    expect(after!.revision).toBe(before.revision! + 1);

    // The source is reconciled with the retirement: R-2's Requirements record and map row
    // are gone, everything else (the survivor, the dropped item's history) is preserved.
    const source = await subjectSource(subject);
    expect(source).not.toMatch(/\*\*R-2\b/);
    expect(source).not.toMatch(/^\| R-2 \|/m);
    expect(source).toMatch(/\*\*R-1 — First outcome\.\*\*/);
    expect(source).toMatch(/^\| R-1 \| P-001 \| tree \|$/m);
    expect(source).toContain('- **P-002** `dropped` second outcome');

    // Canonical generated retirement: the dropped pair is superseded with its BAR pin
    // cleared, and the survivor's projection keeps its BAR.
    const clauses = await subjectClauses(subject);
    expect(clauses.find((clause) => clause.specId === 'AUTO-BAR-R-2-P-002')).toMatchObject({
      lifecycleStatus: 'superseded',
      sourceBar: null,
    });
    expect(clauses.find((clause) => clause.specId === 'AUTO-BAR-R-1-P-001')?.sourceBar).toMatchObject({ barKey: 'R-1' });
  });

  it('CONTROL: a SURVIVING BAR whose only mapped work was dropped is still refused on preview and apply, with nothing persisted', async () => {
    const { subject, rubricSlug, before, sourceBefore } = await seedDroppedOnlyBar('dropped-only-survivor-subject');
    const clausesBefore = await subjectClauses(subject);
    // A METHOD-only edit needs no approval, so the apply reaches the source mapping check.
    const amendment = {
      rubricId: rubricSlug,
      actorId: 'amendment-actor',
      reason: 'Edit R-1 METHOD while R-2 still maps only dropped work.',
      criterion: { key: before.criteria[0]!.key, field: 'method' as const, mode: 'replace' as const, text: 'Re-run the seeded fixture.' },
    };
    await expect(rubrics.previewAcceptanceBarAmendment(amendment)).rejects.toThrow(/bar_mapping_dropped_only: R-2/);
    await expect(rubrics.amendRubric(amendment)).rejects.toThrow(/bar_mapping_dropped_only: R-2/);
    expect((await rubrics.getRubric(rubricSlug))!.revision).toBe(before.revision);
    expect(await subjectSource(subject)).toBe(sourceBefore);
    expect(await subjectClauses(subject)).toEqual(clausesBefore);
  });

  it('CONTROL: removing a started BAR without an outside approval is refused, with nothing persisted', async () => {
    const { subject, rubricSlug, before, sourceBefore } = await seedDroppedOnlyBar('dropped-only-unapproved-subject');
    const clausesBefore = await subjectClauses(subject);
    await expect(rubrics.amendRubric({
      rubricId: rubricSlug,
      actorId: 'amendment-actor',
      reason: 'Retire R-2 without review.',
      criteria: before.criteria.filter((criterion) => criterion.barKey !== 'R-2'),
    })).rejects.toThrow('acceptance_bar_approval_required');
    expect((await rubrics.getRubric(rubricSlug))!.criteria.map((criterion) => criterion.barKey)).toEqual(['R-1', 'R-2']);
    expect(await subjectSource(subject)).toBe(sourceBefore);
    expect(await subjectClauses(subject)).toEqual(clausesBefore);
  });

  // acceptance-bar-atomic-retirement-2026-10-15 R-15..R-23 (the D-006-shaped fixture). The
  // two-BAR cases above prove the mechanism; this one proves the PARTITION at the size of the
  // real carrier (thread-post:1183897): retiring R-3/R-4/R-5/R-6, whose mapped work was all
  // dropped, removes exactly five generated projections while twenty survivor projections and
  // twenty-four authored clauses keep their obligations, and a simultaneous R-1 falsifier change
  // is identified as changed meaning. Evidence is seeded so the carry is observable: unchanged
  // R-2/R-7 proof must survive as observed, changed R-1 proof must not follow the new revision.
  const D006_MAP: Record<string, string[]> = {
    'R-1': ['P-001', 'P-008', 'P-009', 'P-010', 'P-011', 'P-012', 'P-013'],
    'R-2': ['P-002', 'P-014', 'P-015', 'P-016', 'P-017', 'P-018', 'P-019'],
    'R-3': ['P-003'],
    'R-4': ['P-004'],
    'R-5': ['P-005', 'P-006'],
    'R-6': ['P-007'],
    'R-7': ['P-020', 'P-021', 'P-022', 'P-023', 'P-024', 'P-025'],
  };
  const D006_RETIRED = ['R-3', 'R-4', 'R-5', 'R-6'];
  const D006_ITEMS = Array.from({ length: 25 }, (_, index) => `P-${String(index + 1).padStart(3, '0')}`);
  const D006_DROPPED = D006_RETIRED.flatMap((barKey) => D006_MAP[barKey]!);

  function d006Body(): string {
    const bars = Object.keys(D006_MAP);
    const requirements = bars.map((barKey) => `**${barKey} — Outcome ${barKey}.** Outcome ${barKey} holds.`).join('\n\n');
    const rows = bars.map((barKey) => `| ${barKey} | ${D006_MAP[barKey]!.join(', ')} | tree |`).join('\n');
    const work = D006_ITEMS.map((item) => `- **${item}** \`done\` work ${item}`).join('\n');
    return `## Requirements\n\n${requirements}\n\n## Design\n\n### Bar-to-work map for this plan\n\n| bar | implementing plan items | evidence plane |\n|---|---|---|\n${rows}\n\n## Work\n\n${work}\n`;
  }

  it('D-006 partition: an approved retirement supersedes exactly its five generated projections and keeps 20 survivors, 24 authored clauses and unchanged-BAR proof', async () => {
    const subject = 'd006-shaped-retirement-subject';
    const seeded = await seedBarContract(subject, { authorMethods: true, body: d006Body(), itemIds: D006_ITEMS });
    const { workspaceId, rubricSlug } = seeded;
    const { setSpecClause } = await import('./agent-tools/plans/spec-clauses-store');
    const { acceptanceBarSourceFingerprint } = await import('./acceptance-bar-amendment-requirements-drift');
    const { specEvidenceBindingFingerprint } = await import('./agent-tools/plans/spec-evidence-store');

    // Twenty-four authored clauses, spread across every item INCLUDING the dropped ones, so an
    // automatic exemption keyed on the retiring work would be visible. AUTHORED-P-002-security
    // is the independent P-002 security obligation the repair must not discharge (R-19).
    const authoredIds: string[] = [];
    for (let index = 0; index < 24; index++) {
      const planItemId = index === 0 ? 'P-002' : D006_ITEMS[index % D006_ITEMS.length]!;
      const specId = index === 0 ? 'AUTHORED-P-002-security' : `AUTHORED-${String(index).padStart(2, '0')}-${planItemId}`;
      const written = await setSpecClause({
        harnessSlug: 'papercusp',
        planSlug: subject,
        specId,
        expectedRevision: 0,
        planItemId,
        behavior: index === 0 ? 'Only the authorized principal can read the P-002 secret.' : `Authored obligation ${index} holds for ${planItemId}.`,
        behaviorClass: index === 0 ? 'authorization' : 'failure',
        requiredEvidence: ['integration trace'],
        requiredTestLayers: ['integration'],
        lifecycleStatus: 'active',
        falsifier: { observation: `Authored obligation ${index} is observably violated.` },
        actorId: 'authored-fixture',
      });
      expect(written).toMatchObject({ status: 'created' });
      authoredIds.push(specId);
    }

    // The D-006 shape: every item mapped by a retiring BAR was dropped.
    const original = await subjectSource(subject);
    let dropped = original;
    for (const item of D006_DROPPED) {
      dropped = dropped.replace(`- **${item}** \`done\``, `- **${item}** \`dropped\``);
    }
    expect(dropped).not.toBe(original);
    await db.adminSql`UPDATE harness_shared.harness_plans
       SET content = ${dropped}, content_hash = ${hashPlanContent(dropped)}
     WHERE workspace_id = ${workspaceId} AND harness_slug = 'papercusp' AND plan_slug = ${subject}`;
    await db.adminSql`UPDATE harness_shared.plan_items SET status = 'dropped'
     WHERE workspace_id = ${workspaceId} AND harness_slug = 'papercusp'
       AND plan_slug = ${subject} AND item_id = ANY(${D006_DROPPED}::text[])`;

    const before = (await rubrics.getRubric(rubricSlug))!;
    expect(before.criteria.map((criterion) => criterion.barKey)).toEqual(Object.keys(D006_MAP));
    const clausesBefore = await subjectClauses(subject);
    const byId = (clauses: Awaited<ReturnType<typeof subjectClauses>>) => new Map(clauses.map((clause) => [clause.specId, clause]));
    const beforeById = byId(clausesBefore);
    const generatedIds = (barKeys: string[]) => barKeys.flatMap((barKey) => D006_MAP[barKey]!.map((item) => `AUTO-BAR-${barKey}-${item}`));
    const retiredIds = generatedIds(D006_RETIRED);
    const survivorIds = generatedIds(['R-1', 'R-2', 'R-7']);
    const unchangedSurvivorIds = generatedIds(['R-2', 'R-7']);
    expect(retiredIds).toHaveLength(5);
    expect(survivorIds).toHaveLength(20);
    expect(clausesBefore).toHaveLength(49);
    for (const specId of [...retiredIds, ...survivorIds, ...authoredIds]) expect(beforeById.has(specId)).toBe(true);

    // Existing proof: one changed-BAR clause (R-1), two unchanged-BAR clauses (R-2, R-7).
    const observedAt = new Date('2026-09-10T00:00:00Z');
    const prover = 'd006-fixture-prover';
    const provenIds = ['AUTO-BAR-R-1-P-001', 'AUTO-BAR-R-2-P-002', 'AUTO-BAR-R-7-P-020'];
    for (const specId of provenIds) {
      const clause = beforeById.get(specId)!;
      const workItemId = `WI-d006-${specId}`;
      await db.adminSql`INSERT INTO harness_shared.work_items
          (workspace_id, harness_slug, feature_id, item_kind, title, status, source_plan_slug, source_plan_item_ids, payload)
        VALUES (${workspaceId}, 'papercusp', ${workItemId}, 'feature', ${`Proof for ${specId}`}, 'done',
                ${subject}, ARRAY[${clause.planItemId}], ${JSON.stringify({ plan_item: { slug: subject, item: clause.planItemId } })}::jsonb)
        ON CONFLICT DO NOTHING`;
      await db.adminSql`INSERT INTO harness_shared.work_item_spec_revision_edges
          (workspace_id,harness_slug,work_item_id,plan_slug,spec_id,spec_revision,spec_fingerprint,created_by)
        VALUES (${workspaceId},'papercusp',${workItemId},${subject},${specId},${clause.revision},${clause.contentHash},'d006-fixture')
        ON CONFLICT DO NOTHING`;
      const canonical = {
        workspaceId, harnessSlug: 'papercusp', workItemId, planSlug: subject, specId,
        specRevision: clause.revision, specFingerprint: clause.contentHash,
        evidenceKind: 'test', evidenceRef: `vitest:${specId}`,
        sourceFingerprint: 'source-fingerprint-fixture', testFingerprint: 'test-fingerprint-fixture',
        fixtureFingerprint: null, rubricFingerprint: null, environmentFingerprint: null,
        coverageEvidenceRef: null, testRunId: null, details: {},
      };
      await db.adminSql`INSERT INTO harness_shared.spec_evidence_bindings
          (workspace_id,harness_slug,work_item_id,plan_slug,spec_id,spec_revision,spec_fingerprint,
           evidence_kind,evidence_ref,source_fingerprint,test_fingerprint,details,observed_at,binding_fingerprint,created_by)
        VALUES (${workspaceId},'papercusp',${workItemId},${subject},${specId},${clause.revision},${clause.contentHash},
                'test',${`vitest:${specId}`},${canonical.sourceFingerprint},${canonical.testFingerprint},'{}'::jsonb,
                ${observedAt},${specEvidenceBindingFingerprint(canonical as never)},${prover})`;
    }
    const readBindings = () => db.adminSql<{ spec_id: string; spec_revision: number; binding_fingerprint: string; created_by: string; observed_at: Date }[]>`
      SELECT spec_id, spec_revision, binding_fingerprint, created_by, observed_at
        FROM harness_shared.spec_evidence_bindings
       WHERE workspace_id=${workspaceId} AND harness_slug='papercusp' AND plan_slug=${subject}
       ORDER BY spec_id, spec_revision`;
    const bindingsBefore = await readBindings();
    expect(bindingsBefore).toHaveLength(3);

    // One amendment retires R-3..R-6 AND changes R-1's falsifier (driftMarkers).
    const criteria = before.criteria
      .filter((criterion) => !D006_RETIRED.includes(criterion.barKey!))
      .map((criterion) => {
        if (criterion.barKey !== 'R-1') return criterion;
        const { bar: _bar, barHash: _barHash, ...canonical } = criterion;
        return { ...canonical, driftMarkers: 'R-1 is observably violated by a NEW counterexample.' };
      });
    const amendment = {
      rubricId: rubricSlug,
      actorId: 'd006-amendment-actor',
      reason: 'Retire R-3..R-6 (their only mapped work was dropped) and sharpen the R-1 falsifier.',
      criteria,
    };
    const sourceBefore = await subjectSource(subject);
    const preview = await rubrics.previewAcceptanceBarAmendment(amendment);
    expect([...preview!.changedBars].sort()).toEqual(['R-1', ...D006_RETIRED]);
    expect((await rubrics.getRubric(rubricSlug))!.revision).toBe(before.revision);
    expect(await subjectSource(subject)).toBe(sourceBefore);
    expect(await subjectClauses(subject)).toEqual(clausesBefore);
    const proposedSourceHash = (preview!.approval as { proposedSourceHash?: string }).proposedSourceHash;
    expect(proposedSourceHash).toEqual(expect.any(String));

    const after = await rubrics.amendRubric({ ...amendment, approvalRef: await postApproval(amendment) });
    expect(after!.criteria.map((criterion) => criterion.barKey)).toEqual(['R-1', 'R-2', 'R-7']);
    expect(after!.revision).toBe(before.revision! + 1);

    // The source carries no Requirements record or map row for any retired BAR, survivors and
    // the dropped items' history remain, and it is exactly the source the reviewer approved.
    const sourceAfter = await subjectSource(subject);
    for (const barKey of D006_RETIRED) {
      expect(sourceAfter).not.toMatch(new RegExp(`\\*\\*${barKey}\\b`));
      expect(sourceAfter).not.toMatch(new RegExp(`^\\| ${barKey} \\|`, 'm'));
    }
    for (const barKey of ['R-1', 'R-2', 'R-7']) {
      expect(sourceAfter).toContain(`| ${barKey} | ${D006_MAP[barKey]!.join(', ')} | tree |`);
    }
    for (const item of D006_DROPPED) expect(sourceAfter).toContain(`- **${item}** \`dropped\``);
    expect(acceptanceBarSourceFingerprint(sourceAfter)).toBe(proposedSourceHash);

    const clausesAfter = await subjectClauses(subject);
    const afterById = byId(clausesAfter);
    expect(clausesAfter).toHaveLength(49);

    // R-15: exactly the five retiring projections changed lifecycle, and they are superseded.
    const lifecycleChanged = clausesAfter.filter((clause) => clause.lifecycleStatus !== beforeById.get(clause.specId)!.lifecycleStatus);
    expect(lifecycleChanged.map((clause) => clause.specId).sort()).toEqual([...retiredIds].sort());
    for (const specId of retiredIds) {
      const retired = afterById.get(specId)!;
      const prior = beforeById.get(specId)!;
      expect(retired.lifecycleStatus).toBe('superseded');
      // R-16: no current linkage, falsifier or acceptanceRef survives on a retired projection.
      expect(retired).toMatchObject({ sourceBar: null, falsifier: null, acceptanceRef: null });
      expect(retired.revision).toBeGreaterThan(prior.revision);
      // R-17: the original generated revision is immutable history, byte-for-byte.
      const [history] = await db.adminSql<{ content_hash: string; source_bar_key: string | null }[]>`
        SELECT content_hash, source_bar_key FROM harness_shared.plan_spec_clause_revisions
         WHERE workspace_id=${workspaceId} AND harness_slug='papercusp' AND plan_slug=${subject}
           AND spec_id=${specId} AND revision=${prior.revision}`;
      expect(history).toEqual({ content_hash: prior.contentHash, source_bar_key: prior.sourceBar!.barKey });
    }

    // R-18: all twenty survivors keep their lifecycle, BAR pin and falsifier; R-2/R-7 survivors are
    // not even revised. R-20: R-7's projections are untouched, so nothing discharged them.
    for (const specId of survivorIds) {
      const survivor = afterById.get(specId)!;
      const prior = beforeById.get(specId)!;
      expect(survivor.lifecycleStatus).toBe(prior.lifecycleStatus);
      expect(survivor.exemption).toBeNull();
      expect(survivor.sourceBar?.barKey).toBe(prior.sourceBar!.barKey);
      expect(survivor.falsifier).not.toBeNull();
    }
    for (const specId of unchangedSurvivorIds) {
      const survivor = afterById.get(specId)!;
      const prior = beforeById.get(specId)!;
      expect({ revision: survivor.revision, contentHash: survivor.contentHash, acceptedBy: survivor.acceptedBy })
        .toEqual({ revision: prior.revision, contentHash: prior.contentHash, acceptedBy: prior.acceptedBy });
    }

    // R-19 + R-21: every authored clause, including the independent P-002 security clause and the
    // ones on dropped items, is byte-identical: still active, not exempted, and still accepted only
    // by its author (the writer stamps the author on an active create), never by the amendment.
    for (const specId of authoredIds) {
      const authored = afterById.get(specId)!;
      const prior = beforeById.get(specId)!;
      expect({
        revision: authored.revision, contentHash: authored.contentHash, lifecycleStatus: authored.lifecycleStatus,
        exemption: authored.exemption, acceptedBy: authored.acceptedBy, acceptedAt: authored.acceptedAt,
      }).toEqual({
        revision: prior.revision, contentHash: prior.contentHash, lifecycleStatus: 'active', exemption: null,
        acceptedBy: 'authored-fixture', acceptedAt: prior.acceptedAt,
      });
    }

    // R-22 + R-23: no observation is fabricated (same rows, same prover, same timestamp). Unchanged
    // R-2/R-7 proof is still on the current revision; changed R-1 proof is NOT on its new revision.
    const bindingsAfter = await readBindings();
    expect(bindingsAfter).toEqual(bindingsBefore);
    const onCurrent = (specId: string) =>
      bindingsAfter.filter((row) => row.spec_id === specId && Number(row.spec_revision) === afterById.get(specId)!.revision);
    expect(onCurrent('AUTO-BAR-R-2-P-002')).toHaveLength(1);
    expect(onCurrent('AUTO-BAR-R-7-P-020')).toHaveLength(1);
    expect(afterById.get('AUTO-BAR-R-1-P-001')!.revision).toBeGreaterThan(beforeById.get('AUTO-BAR-R-1-P-001')!.revision);
    expect(onCurrent('AUTO-BAR-R-1-P-001')).toHaveLength(0);
    for (const row of bindingsAfter) {
      expect(row.created_by).toBe(prover);
      expect(new Date(row.observed_at).toISOString()).toBe(observedAt.toISOString());
    }
  });

  // EI-24358433996857425 Part B (acceptance-bar-atomic-retirement-2026-10-15 R-6/R-8/R-28): the
  // mapping-only case. R-2's MEANING is kept; only the work that discharges it moves off the
  // dropped item. Every BAR hash is unchanged, so changedBars is [] and the approval, the
  // idempotency identity and the projection rebinding all have to be carried by the explicit delta.
  const moveR2 = (next: string[], prior: string[] = ['P-002']) => ({
    barKey: 'R-2',
    prior: { planItemIds: prior, evidencePlane: 'tree' as const },
    next: { planItemIds: next, evidencePlane: 'tree' as const },
  });

  async function postReceipt(subject: string, receipt: unknown, author = 'outside-reviewer') {
    const workspaceId = activeWorkspaceId();
    const thread = `approval-${subject}`;
    await db.adminSql`INSERT INTO harness_shared.coord_threads (workspace_id,thread_id,parent_kind,parent_ref)
      VALUES (${workspaceId},${thread},'plan',${subject}) ON CONFLICT DO NOTHING`;
    const [post] = await db.adminSql`INSERT INTO harness_shared.coord_thread_posts
      (workspace_id,thread_id,author_id,body) VALUES
      (${workspaceId},${thread},${author},${JSON.stringify(receipt)}) RETURNING id`;
    return `thread-post:${post.id}`;
  }

  it('R-6/R-8: a mapping-only delta previews one atomic derivation, needs outside approval of that delta, and re-projects the moved pair on apply (EI-24358433996857425 Part B)', async () => {
    const { subject, rubricSlug, before, sourceBefore } = await seedDroppedOnlyBar('mapping-delta-move-subject');
    const clausesBefore = await subjectClauses(subject);
    const amendment = {
      rubricId: rubricSlug,
      actorId: 'amendment-actor',
      reason: 'Move R-2 off the dropped P-002 onto P-001; R-2 meaning is unchanged.',
      barMappingDelta: [moveR2(['P-001'])],
    };

    const preview = (await rubrics.previewAcceptanceBarAmendment(amendment))!;
    expect(preview.changedBars).toEqual([]);
    expect(preview.approvalRequired).toBe(true);
    expect(preview.nextBarSetHash).toBe(before.barSetHash);
    const r2Hash = before.criteria.find((criterion) => criterion.barKey === 'R-2')!.barHash;
    // The reviewed object names the moved BAR at its unchanged hash, the proposed source, and the delta.
    expect(preview.approval).toMatchObject({
      bars: [{ barKey: 'R-2', priorBarHash: r2Hash, nextBarHash: r2Hash }],
      proposedSourceHash: preview.sourceDerivation.proposedSourceFingerprint,
      mappingDelta: [moveR2(['P-001'])],
    });
    // R-6: the delta is part of the same source derivation as the (empty) retirement set.
    expect(preview.sourceDerivation).toMatchObject({
      retired: [],
      removedMapRows: [],
      mappingDelta: [{ ...moveR2(['P-001']), retiredProjections: ['AUTO-BAR-R-2-P-002'], addedProjections: ['AUTO-BAR-R-2-P-001'] }],
    });
    expect(preview.sourceDerivation.proposedSourceFingerprint)
      .not.toBe(preview.sourceDerivation.baselineSourceFingerprint);
    expect(preview.revisionMovement).toEqual({
      rubric: { from: before.revision, to: before.revision! + 1 },
      subject: { from: expect.any(Number), to: expect.any(Number) },
    });
    // A preview persists nothing.
    expect((await rubrics.getRubric(rubricSlug))!.revision).toBe(before.revision);
    expect(await subjectSource(subject)).toBe(sourceBefore);
    expect(await subjectClauses(subject)).toEqual(clausesBefore);

    // A map move is never additive: without an approval it is refused, with no write.
    await expect(rubrics.amendRubric(amendment)).rejects.toThrow('acceptance_bar_approval_required');
    expect(await subjectSource(subject)).toBe(sourceBefore);

    const after = (await rubrics.amendRubric({ ...amendment, approvalRef: await postApproval(amendment) }))!;
    const rubricAfter = (await rubrics.getRubric(rubricSlug))!;
    expect(rubricAfter.revision).toBe(before.revision! + 1);
    expect(rubricAfter.barSetHash).toBe(before.barSetHash);
    expect(after.criteria.find((criterion) => criterion.barKey === 'R-2')!.barHash).toBe(r2Hash);

    // R-8: apply wrote exactly the reviewed source: the moved row, nothing else of the map.
    const source = await subjectSource(subject);
    expect(source).toMatch(/^\| R-2 \| P-001 \| tree \|$/m);
    expect(source).toMatch(/^\| R-1 \| P-001 \| tree \|$/m);
    expect(source).toContain('- **P-002** `dropped` second outcome');
    expect(source).toContain('Mapping delta: R-2 P-002 (tree) → P-001 (tree)');
    expect(source).toContain(`Approval-Ref: `);

    // The pair moved: the dropped item's projection is superseded and the new pair is bound to R-2.
    const clauses = await subjectClauses(subject);
    expect(clauses.find((clause) => clause.specId === 'AUTO-BAR-R-2-P-002')).toMatchObject({
      lifecycleStatus: 'superseded',
      sourceBar: null,
    });
    expect(clauses.find((clause) => clause.specId === 'AUTO-BAR-R-2-P-001')?.sourceBar).toMatchObject({
      barKey: 'R-2',
      barHash: r2Hash,
    });
    expect(clauses.find((clause) => clause.specId === 'AUTO-BAR-R-1-P-001')?.sourceBar).toMatchObject({ barKey: 'R-1' });
  });

  it('R-28: an approval for another map, or one that omits the delta, cannot authorize the move even though changedBars is []', async () => {
    const { subject, rubricSlug, before, sourceBefore } = await seedDroppedOnlyBar('mapping-delta-approval-subject');
    const amendment = {
      rubricId: rubricSlug,
      actorId: 'amendment-actor',
      reason: 'Move R-2 off the dropped P-002 onto P-001.',
      barMappingDelta: [moveR2(['P-001'])],
    };
    // Another map: R-2 onto P-001 AND the dropped P-002. Its own preview is a valid review object.
    const otherMap = { ...amendment, barMappingDelta: [moveR2(['P-001', 'P-002'])] };
    await expect(rubrics.amendRubric({ ...amendment, approvalRef: await postApproval(otherMap) }))
      .rejects.toThrow(/acceptance_bar_approval_(patch|source|mapping)_mismatched/);

    // The isolating case: same BARs, same hashes, same proposed source, only the delta missing.
    // Pre-fix nothing bound the map, so this receipt would have authorized the move.
    const { mappingDelta: _delta, ...withoutDelta } = (await rubrics.previewAcceptanceBarAmendment(amendment))!.approval;
    await expect(rubrics.amendRubric({ ...amendment, approvalRef: await postReceipt(subject, withoutDelta) }))
      .rejects.toThrow('acceptance_bar_approval_mapping_mismatched');
    // And a receipt that reviewed a different prior for the same row.
    const correct = (await rubrics.previewAcceptanceBarAmendment(amendment))!.approval;
    const forged = { ...correct, mappingDelta: [moveR2(['P-001'], ['P-001'])] };
    await expect(rubrics.amendRubric({ ...amendment, approvalRef: await postReceipt(subject, forged) }))
      .rejects.toThrow('acceptance_bar_approval_mapping_mismatched');

    expect((await rubrics.getRubric(rubricSlug))!.revision).toBe(before.revision);
    expect(await subjectSource(subject)).toBe(sourceBefore);
  });

  // SPEC-P-004 (acceptance-bar-atomic-retirement-2026-10-15): the clause's own falsifier probe.
  // Obtain an approval for ONE mapping change, apply a DIFFERENT mapping change under that same
  // approval reference, then read the result, the rubric revision, the plan source and its
  // clauses. The final apply of the approved map under the same reference calibrates the
  // fixture: the approval itself is valid, so the refusal is caused by the map difference alone.
  it('SPEC-P-004: an amendment whose declared mapping change differs from the change its approval reviewed is refused without writing', async () => {
    const { subject, rubricSlug, before, sourceBefore } = await seedDroppedOnlyBar('mapping-delta-spec-p004-subject');
    const clausesBefore = await subjectClauses(subject);
    const reviewed = {
      rubricId: rubricSlug,
      actorId: 'amendment-actor',
      reason: 'Move R-2 off the dropped P-002 onto P-001.',
      barMappingDelta: [moveR2(['P-001'])],
    };
    const approvalRef = await postApproval(reviewed);

    const different = { ...reviewed, barMappingDelta: [moveR2(['P-001', 'P-002'])], approvalRef };
    await expect(rubrics.amendRubric(different)).rejects.toThrow(/acceptance_bar_approval_(patch|source|mapping)_mismatched/);
    expect((await rubrics.getRubric(rubricSlug))!.revision).toBe(before.revision);
    expect(await subjectSource(subject)).toBe(sourceBefore);
    expect(await subjectClauses(subject)).toEqual(clausesBefore);

    // Calibration: the same approval reference DOES authorize the map it reviewed.
    await rubrics.amendRubric({ ...reviewed, approvalRef });
    expect((await rubrics.getRubric(rubricSlug))!.revision).toBe(before.revision! + 1);
    expect(await subjectSource(subject)).toMatch(/^\| R-2 \| P-001 \| tree \|$/m);
  });

  it('R-28: the idempotency identity binds the delta — a replay is a no-op, the same key with another map is a conflict', async () => {
    const { subject, rubricSlug, before } = await seedDroppedOnlyBar('mapping-delta-replay-subject');
    const amendment = {
      rubricId: rubricSlug,
      actorId: 'amendment-actor',
      reason: 'Move R-2 off the dropped P-002 onto P-001.',
      idempotencyKey: 'mapping-delta-replay-1',
      barMappingDelta: [moveR2(['P-001'])],
    };
    const approvalRef = await postApproval(amendment);
    await rubrics.amendRubric({ ...amendment, approvalRef });
    const applied = await subjectSource(subject);
    expect((await rubrics.getRubric(rubricSlug))!.revision).toBe(before.revision! + 1);

    await rubrics.amendRubric({ ...amendment, approvalRef });
    expect((await rubrics.getRubric(rubricSlug))!.revision).toBe(before.revision! + 1);
    expect(await subjectSource(subject)).toBe(applied);

    await expect(rubrics.amendRubric({ ...amendment, approvalRef, barMappingDelta: [moveR2(['P-001', 'P-002'])] }))
      .rejects.toThrow('acceptance_bar_amendment_replay_conflict');
    expect(await subjectSource(subject)).toBe(applied);
  });

  it('R-6 COUNTER: a delta whose prior is not the locked row, or that targets a BAR this amendment retires, refuses with nothing persisted', async () => {
    const { subject, rubricSlug, before, sourceBefore } = await seedDroppedOnlyBar('mapping-delta-refusal-subject');
    const clausesBefore = await subjectClauses(subject);
    const base = { rubricId: rubricSlug, actorId: 'amendment-actor', reason: 'Refused map move.' };
    // The caller believes R-2 maps P-001 + P-002; the locked row maps only P-002.
    const stalePrior = [moveR2(['P-001'], ['P-001', 'P-002'])];
    await expect(rubrics.previewAcceptanceBarAmendment({ ...base, barMappingDelta: stalePrior }))
      .rejects.toThrow(/mapping_delta_prior_mismatch: R-2 delta prior is P-001, P-002 \(tree\), but the locked row is P-002 \(tree\)/);
    await expect(rubrics.amendRubric({ ...base, barMappingDelta: stalePrior }))
      .rejects.toThrow('mapping_delta_prior_mismatch');
    await expect(rubrics.previewAcceptanceBarAmendment({
      ...base,
      criteria: before.criteria.filter((criterion) => criterion.barKey !== 'R-2'),
      barMappingDelta: [moveR2(['P-001'])],
    })).rejects.toThrow('acceptance_bar_amendment_mapping_delta_bar_changed: R-2');
    await expect(rubrics.previewAcceptanceBarAmendment({
      ...base,
      barMappingDelta: [{ ...moveR2(['P-001']), barKey: 'R-9' }],
    })).rejects.toThrow('acceptance_bar_amendment_mapping_delta_unknown_bar: R-9');
    expect((await rubrics.getRubric(rubricSlug))!.revision).toBe(before.revision);
    expect(await subjectSource(subject)).toBe(sourceBefore);
    expect(await subjectClauses(subject)).toEqual(clausesBefore);
  });

  // SPEC-P-003 (acceptance-bar-atomic-retirement-2026-10-15): a refused or rolled-back
  // amendment leaves the plan source unchanged. Both new source paths are covered: the
  // retirement of a dropped-only BAR (P-001) and the explicit map move (P-002). Each fault
  // fires AFTER the subject-source rewrite inside the amendment transaction (rubrics.ts:
  // 'after-projection', then 'after-rebind'). The subject row's content, content_hash and
  // version are compared before the outcome is checked, so a fault that is swallowed and
  // committed fails on the source itself. The unfaulted apply at the end calibrates the
  // fixture: the same approved input DOES rewrite the source.
  async function subjectRow(subject: string) {
    const [row] = await db.adminSql<{ content: string; content_hash: string; version: number | string }[]>`
      SELECT content, content_hash, version FROM harness_shared.harness_plans
       WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp' AND plan_slug = ${subject}`;
    return { content: row!.content, contentHash: row!.content_hash, version: Number(row!.version) };
  }

  it('SPEC-P-003: a refused or rolled-back retirement or map move leaves the plan source, content hash and revision unchanged', async () => {
    const retire = await seedDroppedOnlyBar('spec-p003-rollback-retire-subject');
    const move = await seedDroppedOnlyBar('spec-p003-rollback-move-subject');
    const cases = [
      {
        seeded: retire,
        amendment: {
          rubricId: retire.rubricSlug,
          actorId: 'amendment-actor',
          reason: 'Retire R-2: the only work that discharged it was dropped.',
          criteria: retire.before.criteria.filter((criterion) => criterion.barKey !== 'R-2'),
        },
        // What the calibration apply must have written: R-2 gone from the rubric and the map.
        expectWritten: (content: string, barKeys: (string | undefined)[]) => {
          expect(barKeys).toEqual(['R-1']);
          expect(content).not.toMatch(/^\| R-2 \|/m);
        },
      },
      {
        seeded: move,
        amendment: {
          rubricId: move.rubricSlug,
          actorId: 'amendment-actor',
          reason: 'Move R-2 off the dropped P-002 onto P-001; R-2 meaning is unchanged.',
          barMappingDelta: [moveR2(['P-001'])],
        },
        // What the calibration apply must have written: R-2 kept, its map row moved to P-001.
        expectWritten: (content: string, barKeys: (string | undefined)[]) => {
          expect(barKeys).toEqual(['R-1', 'R-2']);
          expect(content).toMatch(/^\| R-2 \| P-001 \| tree \|$/m);
          expect(content).not.toMatch(/^\| R-2 \| P-002 \|/m);
        },
      },
    ];
    const settle = (call: Promise<unknown>) => call.then(() => 'committed', (error: Error) => error.message);
    for (const { seeded, amendment, expectWritten } of cases) {
      const rowBefore = await subjectRow(seeded.subject);
      const clausesBefore = await subjectClauses(seeded.subject);
      // R-13: every durable member the amendment can touch, not only the subject row: both
      // plan rows (template data, adoption pins), clause pointers and immutable history,
      // proof bindings, work-binding edges and plan revision history.
      const vectorBefore = await amendmentStateVector(seeded);
      expect(rowBefore.contentHash).toBe(hashPlanContent(rowBefore.content));

      // Refused: no outside approval.
      const refused = await settle(rubrics.amendRubric(amendment));
      expect(await subjectRow(seeded.subject)).toEqual(rowBefore);
      expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(seeded.before.revision);
      expect(await subjectClauses(seeded.subject)).toEqual(clausesBefore);
      expect(await amendmentStateVector(seeded)).toEqual(vectorBefore);
      expect(refused).toMatch(/acceptance_bar_approval_required/);

      // Rolled back: approved, but a fault fires at each existing fault point of the apply
      // path in order (rubrics.ts injectAmendmentFault): after the decision is composed,
      // after the rubric row is written, after the clause projection, after the rebind.
      const approvalRef = await postApproval(amendment);
      for (const stage of ['after-decision', 'after-rubric', 'after-projection', 'after-rebind'] as const) {
        const outcome = await settle(rubrics.amendRubric({ ...amendment, approvalRef, faultInjection: stage }));
        expect(await subjectRow(seeded.subject)).toEqual(rowBefore);
        expect((await rubrics.getRubric(seeded.rubricSlug))!.revision).toBe(seeded.before.revision);
        expect(await subjectClauses(seeded.subject)).toEqual(clausesBefore);
        expect(await amendmentStateVector(seeded)).toEqual(vectorBefore);
        expect(outcome).toMatch(new RegExp(`acceptance_bar_amendment_fault_injected:${stage}`));
      }

      // Calibration: the same approved input, unfaulted, rewrites the source, and the state
      // vector observes the write, so the equality checks above cannot pass vacuously.
      await rubrics.amendRubric({ ...amendment, approvalRef });
      expect(await amendmentStateVector(seeded)).not.toEqual(vectorBefore);
      const applied = await subjectRow(seeded.subject);
      expect(applied.version).toBeGreaterThan(rowBefore.version);
      expect(applied.contentHash).not.toBe(rowBefore.contentHash);
      expect(applied.contentHash).toBe(hashPlanContent(applied.content));
      const rubricApplied = (await rubrics.getRubric(seeded.rubricSlug))!;
      expect(rubricApplied.revision).toBe(seeded.before.revision! + 1);
      expectWritten(applied.content, rubricApplied.criteria.map((criterion) => criterion.barKey));
    }
  });

  /** Read the rubric's stored template_data straight off the row, so a resubmission is
   *  schema-valid by construction rather than by a hand-written fixture that can drift. */
  async function storedTemplateData(slug: string): Promise<{ criteria: { key: string }[] }> {
    const rows = await db.adminSql<{ template_data: { criteria: { key: string }[] } }[]>`
      SELECT template_data FROM harness_shared.harness_plans
       WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp'
         AND plan_slug = ${slug}`;
    return rows[0]!.template_data;
  }

  /** The exact pair `plans:set-template-data`'s handler runs (set-template-data.ts). */
  async function setTemplateDataDoor(slug: string, data: unknown) {
    const { withPlanLock } = await import('./agent-tools/plans/with-plan-lock');
    const { evaluateSetTemplateData } = await import('./agent-tools/plans/set-template-data');
    return withPlanLock(null as never, { slug, intent: 'plans:set-template-data' }, async (current, meta) =>
      evaluateSetTemplateData(current, data, slug, meta?.inputSchema ?? null),
    );
  }

  async function seedRubric(slug: string) {
    await rubrics.proposeRubric({
      rubricId: slug,
      characteristic: 'queen-coordination',
      title: 'Guarded rubric',
      criteria: sampleCriteria,
      by: 'author-a',
    });
  }

  it('REFUSES a set-template-data write that would silently delete a stored criterion', async () => {
    await seedRubric('guarded-rubric');
    const before = await storedTemplateData('guarded-rubric');
    expect(before.criteria.length).toBeGreaterThan(1);

    // The whole bug in one object: structurally valid, one criterion shorter.
    const gutted = { ...before, criteria: before.criteria.slice(0, 1) };
    const droppedKey = before.criteria[1]!.key;

    await expect(setTemplateDataDoor('guarded-rubric', gutted)).rejects.toThrow(
      new RegExp(`SILENTLY LOSE[\\s\\S]*${droppedKey}`),
    );

    // The refusal rolls back inside the lock — the stored rubric is untouched.
    const after = await storedTemplateData('guarded-rubric');
    expect(after.criteria.map((c) => c.key)).toEqual(before.criteria.map((c) => c.key));
    expect((await rubrics.getRubric('guarded-rubric'))?.criteria).toHaveLength(before.criteria.length);
  });

  it("cannot CLEAR a rubric's template_data through this door either", async () => {
    await seedRubric('clearable-rubric');
    // A clear erases every criterion at once, so it must never reach the column. This
    // door stops it one step EARLIER than the loss-guard — the registry schema refuses
    // `null` where an object is required — which is why the assertion is on the door's
    // structured rejection, not on a throw. The boundary's own clear-refusal (for any
    // future door that does hand `data: null` down) is unit-pinned in
    // agent-tools/plans/rubric-loss-guard.test.ts.
    const result = await setTemplateDataDoor('clearable-rubric', null);
    expect(result.kind).toBe('applied');
    expect((result as { value: { ok: boolean } }).value.ok).toBe(false);
    expect((await storedTemplateData('clearable-rubric')).criteria.length).toBeGreaterThan(1);
  });

  it('still ACCEPTS an additive write — how P-001 added its criterion through this door', async () => {
    await seedRubric('growable-rubric');
    const before = await storedTemplateData('growable-rubric');
    const added = {
      ...before,
      criteria: [
        ...before.criteria,
        {
          key: 'portfolio-activity-floor',
          title: 'Portfolio activity floor',
          model: 'A standing goal with zero portfolio acts in its graded window is FAILING, not unknown.',
          method: 'Count portfolio acts by the holder inside the graded window; zero over >=60min scores fail.',
          driftMarkers: 'A window scored `unknown` while the ledger was available and returned zero acts.',
        },
      ],
    };
    const result = await setTemplateDataDoor('growable-rubric', added);
    expect(result.kind).toBe('applied');
    expect((result as { value: { ok: boolean } }).value.ok).toBe(true);
    expect((await storedTemplateData('growable-rubric')).criteria.map((c) => c.key)).toContain(
      'portfolio-activity-floor',
    );
  });

  it('records an exact projectable rubric snapshot when set-template-data advances the plan version', async () => {
    const slug = 'versioned-template-data-rubric';
    await seedRubric(slug);
    const before = await rubrics.getRubric(slug);
    if (!before) throw new Error(`seeded rubric '${slug}' did not resolve`);
    const priorData = await storedTemplateData(slug) as unknown as {
      [key: string]: unknown;
      criteria: Array<Record<string, unknown>>;
    };
    const revisedMethod = 'Read the exact committed set-template-data revision snapshot.';
    const nextData = {
      ...priorData,
      criteria: priorData.criteria.map((criterion, index) =>
        index === 0 ? { ...criterion, method: revisedMethod } : criterion,
      ),
    };

    const response = await setTemplateDataTool.handler(
      { harness: 'papercusp', slug, data: nextData, rationale: 'Exercise the real rubric writer.' } as never,
      {
        isSuperuser: true,
        uiClientId: 'su-rubric-template-data-integration',
        workspaceId: activeWorkspaceId(),
        harnessSlug: 'papercusp',
      } as never,
    );
    expect(response).toHaveProperty('content');
    if (!('content' in response)) throw new Error('template data handler must return text content');
    const responseText = response.content.find((part) => part.type === 'text')?.text;
    expect(responseText).toBeTruthy();
    const written = JSON.parse(responseText!) as {
      ok: boolean;
      version: number;
      revision: { seq: number } | null;
    };
    expect(written.ok).toBe(true);
    expect(written.version).toBe(before.revision! + 1);
    expect(written.revision).toEqual({ seq: 2 });

    const historical = await rubrics.getRubric(slug, before.revision!);
    expect(historical?.criteria).toEqual(before.criteria);
    const current = await rubrics.getRubric(slug, written.version);
    expect(current?.revision).toBe(written.version);
    expect(current?.criteria[0]?.method).toBe(revisedMethod);

    const [snapshotRow] = await db.adminSql<{ seq: number; content_snapshot: string }[]>`
      SELECT seq, content_snapshot FROM harness_shared.plan_revisions
       WHERE workspace_id = ${activeWorkspaceId()} AND harness_slug = 'papercusp'
         AND plan_slug = ${slug} ORDER BY seq DESC LIMIT 1`;
    const snapshotJson = snapshotRow.content_snapshot.match(/~~~json\s*\n([\s\S]*?)\n~~~/)?.[1];
    expect(snapshotJson).toBeTruthy();
    expect(JSON.parse(snapshotJson!)).toMatchObject({
      schemaVersion: 2,
      rubricRevision: written.version,
      templateData: nextData,
    });
  });

  it("leaves a NON-rubric plan's structured data alone (the guard is scoped, not global)", async () => {
    // A parameterized plan writes template_data too, and its input VALUES may perfectly
    // well contain a shrinking `criteria` array. The guard keys off the plan being a
    // rubric, not off the data merely looking like one — otherwise every plan-input
    // write becomes collateral damage. This plan declares its own JSON Schema (mig 714)
    // so the write genuinely APPLIES rather than bouncing off a missing-schema refusal,
    // which would prove nothing about the guard.
    await db.adminSql`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status,
         created, updated, owner, archived, template, template_data, input_schema, origin)
      VALUES (${activeWorkspaceId()}, 'papercusp', 'plain-plan',
              ${'---\nslug: plain-plan\ntitle: Plain\nstatus: active\ncreated: 2026-06-20\nupdated: 2026-06-20\n---\n\n## Now\n\nwork\n'},
              md5('plain-plan'), 1, 'Plain', 'active', '2026-06-20', '2026-06-20', 'queen-1', false,
              NULL, ${JSON.stringify({ criteria: [{ key: 'a' }, { key: 'b' }] })}::text::jsonb,
              ${JSON.stringify({ type: 'object' })}::text::jsonb, 'local')`;
    const result = await setTemplateDataDoor('plain-plan', { criteria: [] });
    expect(result.kind).toBe('applied');
    expect((result as { value: { ok: boolean } }).value.ok).toBe(true);
    const after = await storedTemplateData('plain-plan');
    expect(after.criteria).toEqual([]);
  });
});
