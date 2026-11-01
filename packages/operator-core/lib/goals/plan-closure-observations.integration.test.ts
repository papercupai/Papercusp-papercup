import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';

const WORKSPACE = 'plan-closure-observations-test';
const HARNESS = 'papercusp';
const PLAN = 'closure-subject-plan';
const RUBRIC = 'acceptance-closure-subject-plan';

const state = vi.hoisted(() => ({ sql: null as unknown, buildSha: 'abc1234' as string | null }));
vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: state.sql }),
}));
vi.mock('../workspace-registry', () => ({ activeWorkspaceId: () => WORKSPACE }));
vi.mock('../build-info', async (orig) => ({
  ...(await orig<typeof import('../build-info')>()),
  getBuildInfo: () => ({ sha: state.buildSha, version: 'test' }),
}));

const { beginPlanClosureObservation, readPlanClosureObservations } = await import('./plan-closure-observations');
const { resolvePlanClosure } = await import('./plan-closure');
const { compileGoalPlanPlacement } = await import('../goal-launch-settings');

const here = dirname(fileURLToPath(import.meta.url));
const migration = (name: string) => resolve(here, '../../../../libs/papercusp/libs/db/sql', name);

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('plan-closure-observations');
  state.sql = db.sql;
  await db.sql.unsafe(`
    DO $$ BEGIN CREATE ROLE harness_app; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    DO $$ BEGIN CREATE ROLE harness_admin; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE TABLE harness_shared.harness_plans (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      plan_slug text NOT NULL,
      version bigint NOT NULL DEFAULT 1,
      status text NOT NULL DEFAULT 'active',
      acceptance_bar_epoch integer,
      template text,
      template_data jsonb,
      PRIMARY KEY (workspace_id, harness_slug, plan_slug)
    );
    CREATE TABLE harness_shared.plan_items (
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      plan_slug text NOT NULL,
      item_id text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE harness_shared.plan_audits (
      workspace_id text NOT NULL,
      harness_slug text,
      plan_slug text NOT NULL,
      audit_seq integer NOT NULL
    );
    CREATE TABLE harness_shared.spec_evidence_bindings (
      id bigserial PRIMARY KEY,
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      plan_slug text NOT NULL,
      retracted_at timestamptz
    );
    CREATE TABLE harness_shared.engineer_issues (
      workspace_id text NOT NULL,
      issue_id text NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await applyMigrationForTest(db.sql, migration('1284-plan-closure-observations.sql'));
  await applyMigrationForTest(db.sql, migration('1313-plan-closure-observations-rubric-grader.sql'));
  await applyMigrationForTest(db.sql, migration('1612-plan-closure-observations-by-build.sql'));
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  state.buildSha = 'abc1234';
  await db.sql.unsafe(`
    TRUNCATE harness_shared.harness_plans, harness_shared.plan_items, harness_shared.plan_audits,
             harness_shared.engineer_issues, harness_shared.spec_evidence_bindings,
             harness_shared.plan_closure_observations,
             harness_shared.plan_closure_observations_by_build
  `);
  await db.sql`
    INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug, version, acceptance_bar_epoch, template, template_data)
    VALUES (${WORKSPACE}, ${HARNESS}, ${PLAN}, 36, 1, NULL, NULL),
           (${WORKSPACE}, ${HARNESS}, ${RUBRIC}, 10, NULL, 'rubric',
            ${db.sql.json({ kind: 'acceptance', subjectPlan: PLAN })})`;
  await db.sql`INSERT INTO harness_shared.plan_items (workspace_id, harness_slug, plan_slug, item_id)
               VALUES (${WORKSPACE}, ${HARNESS}, ${PLAN}, 'P-001')`;
  await db.sql`INSERT INTO harness_shared.plan_audits (workspace_id, harness_slug, plan_slug, audit_seq)
               VALUES (${WORKSPACE}, ${HARNESS}, ${PLAN}, 5)`;
});

const VERDICT = { satisfied: false, code: 'acceptance_ungraded' as const, message: 'needs an independent grade', buildProvenance: { sha: 'abc1234' } };

async function read(now = new Date()) {
  const reads = await readPlanClosureObservations({ workspaceId: WORKSPACE, planSlugs: [PLAN], sql: db.sql, now });
  return reads.get(PLAN)!;
}

describe('plan closure observations (D-032)', () => {
  it.each([false, true])('rejects another evaluator with unchanged inputs (satisfied=%s)', async (satisfied) => {
    await (await beginPlanClosureObservation(PLAN)).record(HARNESS, {
      ...VERDICT, satisfied, buildProvenance: { sha: 'd740fc3802' },
    });
    expect(await read()).toMatchObject({ status: 'stale', detail: expect.stringContaining('evaluator') });

    // A canonical evaluation by this reader's build restores freshness without
    // amending the rubric, re-vetting it, or changing any plan inputs.
    await (await beginPlanClosureObservation(PLAN)).record(HARNESS, { ...VERDICT, satisfied });
    expect(await read()).toMatchObject({ status: 'fresh', gate: { satisfied } });
  });

  it('rejects unknown evaluator identity on either side', async () => {
    await (await beginPlanClosureObservation(PLAN)).record(HARNESS, {
      ...VERDICT, buildProvenance: { sha: null },
    });
    expect((await read()).status).toBe('stale');
    await (await beginPlanClosureObservation(PLAN)).record(HARNESS, VERDICT);
    state.buildSha = null;
    expect((await read()).status).toBe('stale');
  });

  it('reads each plan input once when returning and comparing its fingerprint', async () => {
    await (await beginPlanClosureObservation(PLAN)).record(HARNESS, VERDICT);
    let statement: { text: string; params: Parameters<typeof db.sql.unsafe>[1] } | undefined;
    const sql = new Proxy(db.sql, {
      apply(target, receiver, args) {
        const strings = args[0] as TemplateStringsArray;
        statement = {
          text: strings.map((part, index) => part + (index < strings.length - 1 ? `$${index + 1}` : '')).join(''),
          params: args.slice(1),
        };
        return Reflect.apply(target, receiver, args);
      },
    });
    const observations = await readPlanClosureObservations({ workspaceId: WORKSPACE, planSlugs: [PLAN], sql });
    expect(observations.get(PLAN)).toMatchObject({ status: 'fresh', gate: { satisfied: false } });
    expect(statement).toBeDefined();

    // Inspect actual PostgreSQL work, not elapsed time or the query's spelling.
    // Inlining the fingerprint doubles this input scan because both the returned
    // value and the freshness comparison expand the same watermark aggregate.
    const [explained] = await db.sql.unsafe(`EXPLAIN (ANALYZE, FORMAT JSON) ${statement!.text}`, statement!.params);
    type PlanNode = { 'Relation Name'?: string; 'Actual Loops': number; Plans?: PlanNode[] };
    const scanLoops = (node: PlanNode): number =>
      (node['Relation Name'] === 'plan_items' ? node['Actual Loops'] : 0)
      + (node.Plans ?? []).reduce((total, child) => total + scanLoops(child), 0);
    expect(scanLoops(explained['QUERY PLAN'][0].Plan)).toBe(1);
  });

  it('keeps a current-build observation fresh after an older runtime overwrites the legacy row', async () => {
    const currentBuild = 'b53aa7a8aa';
    state.buildSha = currentBuild;
    await (await beginPlanClosureObservation(PLAN)).record(HARNESS, {
      ...VERDICT,
      buildProvenance: { sha: currentBuild },
    });
    expect(await read()).toMatchObject({ status: 'fresh', gate: { satisfied: false } });

    // Simulate the still-live release binary: it knows only the legacy table and
    // can overwrite its single plan row after the staging evaluator writes.
    await db.sql`
      UPDATE harness_shared.plan_closure_observations
         SET build_sha = 'd740fc3802',
             satisfied = true,
             observed_at = now() + interval '1 second'
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND plan_slug = ${PLAN}`;

    expect(await read()).toMatchObject({ status: 'fresh', gate: { satisfied: false } });
    const [legacy] = await db.sql`
      SELECT build_sha FROM harness_shared.plan_closure_observations
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND plan_slug = ${PLAN}`;
    expect(legacy.build_sha).toBe('d740fc3802');
  });

  it('reads canonical supersession beside stale and absent acceptance verdicts', async () => {
    await (await beginPlanClosureObservation(PLAN)).record(HARNESS, VERDICT);
    await db.sql`UPDATE harness_shared.harness_plans SET status = 'superseded', version = version + 1
      WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND plan_slug = ${PLAN}`;
    expect(await read()).toMatchObject({ status: 'stale', planStatus: 'superseded' });

    await db.sql`DELETE FROM harness_shared.plan_closure_observations
      WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND plan_slug = ${PLAN}`;
    await db.sql`DELETE FROM harness_shared.plan_closure_observations_by_build
      WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND plan_slug = ${PLAN}`;
    expect(await read()).toMatchObject({ status: 'absent', planStatus: 'superseded' });
  });

  it('keeps qualified same-slug verdicts distinct while the legacy bare slug stays ambiguous', async () => {
    const secondHarness = 'second-harness';
    await db.sql`INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, version, acceptance_bar_epoch)
      VALUES (${WORKSPACE}, ${secondHarness}, ${PLAN}, 2, 1)`;
    const recording = await beginPlanClosureObservation(PLAN);
    await recording.record(HARNESS, { ...VERDICT, satisfied: true });
    await recording.record(secondHarness, VERDICT);
    const observations = await readPlanClosureObservations({ workspaceId: WORKSPACE,
      planSlugs: [PLAN], planRefs: [{ planSlug: PLAN, harnessSlug: HARNESS },
        { planSlug: PLAN, harnessSlug: secondHarness }], sql: db.sql });
    expect(observations.get(`plan:${HARNESS}/${PLAN}`)).toMatchObject({ status: 'fresh', gate: { satisfied: true } });
    expect(observations.get(`plan:${secondHarness}/${PLAN}`)).toMatchObject({ status: 'fresh', gate: { satisfied: false } });
    expect(observations.get(PLAN)?.status).toBe('ambiguous');
    expect(observations.get(`plan:${HARNESS}/${PLAN}`)).not.toEqual(observations.get(`plan:${secondHarness}/${PLAN}`));
  });

  it.each(['shipped-without-closure', 'satisfied-closure'])('outer control catches persisted closure verdict adapter: %s', async (scenario) => {
    const satisfied = scenario === 'satisfied-closure';
    const projected = async (verdictSatisfied: boolean) => {
      await (await beginPlanClosureObservation(PLAN)).record(HARNESS, { ...VERDICT, satisfied: verdictSatisfied });
      const observation = await read();
      expect(observation.status).toBe('fresh');
      if (observation.status !== 'fresh') throw new Error('expected the persisted gate verdict');
      return compileGoalPlanPlacement({
        plan: { harness: HARNESS, slug: PLAN, ambiguousMatches: 1 },
        status: 'shipped', itemStatuses: ['done'], actionableItemId: null, source: {},
        closure: resolvePlanClosure({ planSlug: PLAN, status: 'read', gate: observation.gate }),
      });
    };
    const expectedState = satisfied ? 'terminal' : 'awaiting-closure';
    expect((await projected(satisfied)).state).toBe(expectedState);
    const faulty = await projected(!satisfied);
    expect(() => expect(faulty.state).toBe(expectedState)).toThrowError();
  });
  it('reads absent until the gate records a verdict, then serves it', async () => {
    expect((await read()).status).toBe('absent');

    await (await beginPlanClosureObservation(PLAN)).record(HARNESS, VERDICT);

    const fresh = await read();
    expect(fresh).toMatchObject({
      status: 'fresh',
      gate: { satisfied: false, code: 'acceptance_ungraded', message: 'needs an independent grade' },
    });
    const [stored] = await db.sql`SELECT build_sha, fingerprint FROM harness_shared.plan_closure_observations`;
    expect(stored.build_sha).toBe('abc1234');
    expect(stored.fingerprint).toMatchObject({ planVersion: '36', acceptanceBarEpoch: 1, auditSeq: '5', rubrics: [`${RUBRIC}@10`] });
  });

  it('persists and serves the rubric and grader of a graded verdict (D-039)', async () => {
    await (await beginPlanClosureObservation(PLAN)).record(HARNESS, {
      satisfied: true, rubricId: RUBRIC, gradedBy: 'su-grader', buildProvenance: { sha: 'abc1234' },
    });

    expect(await read()).toMatchObject({
      status: 'fresh', gate: { satisfied: true, rubricId: RUBRIC, gradedBy: 'su-grader' },
    });

    // A later verdict without a grader clears the stored one rather than inheriting it.
    await (await beginPlanClosureObservation(PLAN)).record(HARNESS, VERDICT);
    const [stored] = await db.sql`SELECT rubric_id, graded_by FROM harness_shared.plan_closure_observations`;
    expect(stored).toEqual({ rubric_id: null, graded_by: null });
  });

  it('persisted placement contract: shipped-without-closure', async () => {
    await (await beginPlanClosureObservation(PLAN)).record(HARNESS, VERDICT);

    const observation = await read();
    expect(observation).toMatchObject({
      status: 'fresh', gate: { satisfied: false, code: 'acceptance_ungraded' },
    });
    if (observation.status !== 'fresh') throw new Error('expected the persisted gate verdict');
    const closure = resolvePlanClosure({ planSlug: PLAN, status: 'read', gate: observation.gate });
    expect(closure.evidenceSatisfied).toBe(false);

    expect(compileGoalPlanPlacement({
      plan: { harness: HARNESS, slug: PLAN, ambiguousMatches: 1 },
      status: 'shipped', itemStatuses: ['done'], actionableItemId: null, source: {}, closure,
    })).toMatchObject({
      state: 'awaiting-closure',
      reconciliation: { action: 'close-plan', consistent: false, toolCall: null },
    });
  });

  it('persisted placement contract: satisfied-closure', async () => {
    await (await beginPlanClosureObservation(PLAN)).record(HARNESS, {
      satisfied: true, buildProvenance: { sha: 'abc1234' },
    });

    const observation = await read();
    expect(observation).toMatchObject({ status: 'fresh', gate: { satisfied: true } });
    if (observation.status !== 'fresh') throw new Error('expected the persisted gate verdict');
    const closure = resolvePlanClosure({ planSlug: PLAN, status: 'read', gate: observation.gate });
    expect(closure.evidenceSatisfied).toBe(true);

    expect(compileGoalPlanPlacement({
      plan: { harness: HARNESS, slug: PLAN, ambiguousMatches: 1 },
      status: 'shipped', itemStatuses: ['done'], actionableItemId: null, source: {}, closure,
    })).toMatchObject({
      state: 'terminal',
      reconciliation: { action: 'none', consistent: true, toolCall: null },
    });
  });

  it('goes stale on a grading scorecard, a vetting scorecard, a plan write, an item, an audit or a rubric amend', async () => {
    const changes: Array<[string, () => Promise<unknown>]> = [
      ['scorecardWatermark', () => db.sql`INSERT INTO harness_shared.engineer_issues (workspace_id, issue_id, payload)
        VALUES (${WORKSPACE}, 'EI-1', ${db.sql.json({ observation: { rubricRef: RUBRIC } })})`],
      ['metaScorecardWatermark', () => db.sql`INSERT INTO harness_shared.engineer_issues (workspace_id, issue_id, payload)
        VALUES (${WORKSPACE}, 'EI-2', ${db.sql.json({ observation: { rubricRef: 'meta-acceptance-rubric', subject: { ref: RUBRIC } } })})`],
      ['planVersion', () => db.sql`UPDATE harness_shared.harness_plans SET version = version + 1 WHERE plan_slug = ${PLAN}`],
      ['itemsWatermark', () => db.sql`UPDATE harness_shared.plan_items SET updated_at = now() + interval '1 second'`],
      ['auditSeq', () => db.sql`INSERT INTO harness_shared.plan_audits (workspace_id, harness_slug, plan_slug, audit_seq)
        VALUES (${WORKSPACE}, ${HARNESS}, ${PLAN}, 6)`],
      ['rubrics', () => db.sql`UPDATE harness_shared.harness_plans SET version = version + 1 WHERE plan_slug = ${RUBRIC}`],
      ['specBindings', () => db.sql`INSERT INTO harness_shared.spec_evidence_bindings (workspace_id, harness_slug, plan_slug)
        VALUES (${WORKSPACE}, ${HARNESS}, ${PLAN})`],
      ['specBindings', () => db.sql`UPDATE harness_shared.spec_evidence_bindings SET retracted_at = now()`],
    ];
    for (const [key, change] of changes) {
      await (await beginPlanClosureObservation(PLAN)).record(HARNESS, VERDICT);
      expect((await read()).status, `fresh before ${key}`).toBe('fresh');
      await change();
      const stale = await read();
      expect(stale.status, key).toBe('stale');
      expect(stale.status !== 'fresh' && stale.detail, key).toContain(key);
    }
  });

  it('ignores scorecards for other rubrics and vetting cards for other subjects', async () => {
    await (await beginPlanClosureObservation(PLAN)).record(HARNESS, VERDICT);
    await db.sql`INSERT INTO harness_shared.engineer_issues (workspace_id, issue_id, payload) VALUES
      (${WORKSPACE}, 'EI-3', ${db.sql.json({ observation: { rubricRef: 'acceptance-some-other-plan' } })}),
      (${WORKSPACE}, 'EI-4', ${db.sql.json({ observation: { rubricRef: 'meta-acceptance-rubric', subject: { ref: 'acceptance-some-other-plan' } } })}),
      ('another-workspace', 'EI-5', ${db.sql.json({ observation: { rubricRef: RUBRIC } })})`;
    expect((await read()).status).toBe('fresh');
  });

  it('pairs the verdict with the fingerprint read BEFORE evaluation, so an input changed after it reads stale', async () => {
    // begin resolves only once its fingerprint is read; the gate evaluates after that.
    // An input that changes between the two must never be served as covered.
    const observation = await beginPlanClosureObservation(PLAN);
    await db.sql`INSERT INTO harness_shared.engineer_issues (workspace_id, issue_id, payload)
      VALUES (${WORKSPACE}, 'EI-6', ${db.sql.json({ observation: { rubricRef: RUBRIC } })})`;
    await observation.record(HARNESS, { ...VERDICT, satisfied: true, code: undefined });
    const read1 = await read();
    expect(read1.status).toBe('stale');
    expect(read1.status !== 'fresh' && read1.detail).toContain('scorecardWatermark');
  });

  it('never lets an older evaluation overwrite a newer one', async () => {
    const older = await beginPlanClosureObservation(PLAN);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await beginPlanClosureObservation(PLAN);
    await newer.record(HARNESS, { ...VERDICT, message: 'newer' });
    await older.record(HARNESS, { ...VERDICT, message: 'older' });
    const [stored] = await db.sql`SELECT message FROM harness_shared.plan_closure_observations`;
    expect(stored.message).toBe('newer');
  });

  it('reads stale once the observation is older than the bound', async () => {
    await (await beginPlanClosureObservation(PLAN)).record(HARNESS, VERDICT);
    const later = new Date(Date.now() + 11 * 60_000);
    expect((await read(later)).status).toBe('stale');
  });

  it('skips the write when the subject harness did not resolve', async () => {
    await (await beginPlanClosureObservation(PLAN)).record(undefined, VERDICT);
    await (await beginPlanClosureObservation(PLAN)).record('some-other-harness', VERDICT);
    expect((await read()).status).toBe('absent');
  });

  it('reads ambiguous when the slug resolves in two harnesses', async () => {
    await db.sql`INSERT INTO harness_shared.harness_plans (workspace_id, harness_slug, plan_slug) VALUES (${WORKSPACE}, 'other', ${PLAN})`;
    expect((await read()).status).toBe('ambiguous');
  });
});
