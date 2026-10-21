/**
 * R-11 (plan-item-types-registry-cupboard-2026-10-20 P-004), on real Postgres: activation seeds
 * one acceptance bar per criterion of an item type's criteria template, and one per criterion of
 * the rubric the type names, each mapped to every plan item of that type. A named rubric that is
 * not installed refuses the seed. Once a plan has left draft with a seeded contract, a re-seed
 * adds no new item-type bar.
 *
 * Item types are stored through the same authoring path `plan-types:define` uses; the named
 * rubric is a workspace rubric row (`template = 'rubric'`) with structured criteria.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { OrgTestDb } from '../../../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    withWorkspace: async <T>(_workspaceId: string, fn: (tx: postgres.Sql) => Promise<T>): Promise<T> =>
      h.sql.begin(async (tx) => fn(tx as unknown as postgres.Sql)) as Promise<T>,
  };
});

const { createOrgTestDb } = await import('../../../../test/_org-test-db');
const { hashPlanContent } = await import('../content-hash');
const { seedAcceptanceBarsInTransaction } = await import('../../../acceptance-bar-seed');
const { defineTypeDefinition } = await import('../../../plan-types/authoring');
const { itemTypeBarKey } = await import('../../../plan-types/item-type-contract');
const { synchronizeAcceptanceBarSubjectRevision } = await import('../../../acceptance-bar-amendment');
import type { SpecClauseSql } from '../spec-clauses-store';

const WORKSPACE = 'acceptance-bar-seed-item-types-test';
const HARNESS = 'papercusp';
const NS = `zzz-itseed-${Math.random().toString(36).slice(2, 8)}`;

/** Carries a two-criterion template. */
const SOURCED = `${NS}/sourced-memo`;
/** Names an installed rubric. */
const REVIEWED = `${NS}/reviewed-memo`;
/** Names a rubric nothing installs. */
const UNINSTALLED = `${NS}/unreviewed-memo`;
const RUBRIC = `${NS}-memo-review-rubric`;
const MISSING_RUBRIC = `${NS}-missing-rubric`;

const TEMPLATE = [
  { key: 'cites-sources', title: 'Cites its sources', description: 'Every claim names the source it rests on.' },
  { key: 'dated', title: 'Dated', description: 'The memo states the date its facts were read.' },
];
const RUBRIC_CRITERIA = [
  { key: 'reproducible', title: 'Reproducible', model: 'A reader can re-run every measurement it reports.' },
  { key: 'bounded', title: 'Bounded', model: 'It states what it did not check.' },
];

let db: OrgTestDb;

/** One requirement BAR plus three items; `deliverables[i]` declares item P-00(i+1)'s type. */
function contentFor(slug: string, deliverables: readonly (string | null)[]): string {
  const items = deliverables.map((deliverable, index) =>
    `- **P-00${index + 1}** \`todo\` Write memo ${index + 1}.${deliverable ? ` deliverable: ${deliverable}` : ''}`).join('\n');
  const itemIds = deliverables.map((_, index) => `P-00${index + 1}`).join(', ');
  return `---
title: ${slug}
slug: ${slug}
status: active
---

## Requirements

**R-1 — Memos are written.** Every memo the plan names exists.

## Design

### Bar-to-work map for this plan

| bar | implementing plan items | evidence plane |
|---|---|---|
| R-1 | ${itemIds} | tree |

## Work

${items}
`;
}

async function insertSubject(planSlug: string, content: string, itemCount: number): Promise<void> {
  await db.adminSql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status, owner,
       acceptance_bar_epoch, acceptance_bar_cohort, verification_profile, verification_profile_source)
    VALUES (${WORKSPACE}, ${HARNESS}, ${planSlug}, ${content}, ${hashPlanContent(content)}, 1,
            ${planSlug}, 'active', 'su-test', 1, 'post-epoch', 'general', 'declared')`;
  for (let seq = 1; seq <= itemCount; seq += 1) {
    await db.adminSql`
      INSERT INTO harness_shared.plan_items
        (workspace_id, harness_slug, plan_slug, item_id, seq, status, item_text)
      VALUES (${WORKSPACE}, ${HARNESS}, ${planSlug}, ${`P-00${seq}`}, ${seq}, 'todo', ${`memo ${seq}`})`;
  }
}

function seed(planSlug: string, planContent: string, actorId: string) {
  return db.adminSql.begin((tx) => seedAcceptanceBarsInTransaction({
    workspaceId: WORKSPACE,
    harnessSlug: HARNESS,
    planSlug,
    planContent,
    planTitle: planSlug,
    planStatus: 'active',
    planVersion: 1,
    adoptionEpoch: 1,
    cohort: 'post-epoch' as const,
    actorId,
    now: new Date('2026-10-21T00:00:00Z'),
    executor: tx as unknown as SpecClauseSql,
  }));
}

/** barKey -> the plan items it is projected onto. */
function projected(result: { projections: Array<{ barKey: string; planItemId: string }> }): Map<string, string[]> {
  const byBar = new Map<string, string[]>();
  for (const { barKey, planItemId } of result.projections) {
    byBar.set(barKey, [...(byBar.get(barKey) ?? []), planItemId].sort());
  }
  return byBar;
}

async function seededCriteria(rubricSlug: string): Promise<Array<{ barKey?: string; title?: string; model?: string }>> {
  const [row] = await db.adminSql<{ template_data: { criteria?: Array<{ barKey?: string; title?: string; model?: string }> } }[]>`
    SELECT template_data FROM harness_shared.harness_plans
     WHERE workspace_id = ${WORKSPACE} AND plan_slug = ${rubricSlug} AND template = 'rubric'`;
  return row?.template_data.criteria ?? [];
}

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
  const itemType = (id: string, extra: Record<string, unknown>) =>
    ({ schemaVersion: 1, id, revision: 1, title: id, modules: ['generic-core'], ...extra });
  for (const definition of [
    itemType(SOURCED, { criteriaTemplate: TEMPLATE }),
    itemType(REVIEWED, { rubricRef: RUBRIC }),
    itemType(UNINSTALLED, { rubricRef: MISSING_RUBRIC }),
  ]) {
    const stored = await defineTypeDefinition(db.adminSql, { workspaceId: WORKSPACE, kind: 'item-type', definition, createdBy: 'su-test' });
    expect(stored, JSON.stringify(stored)).toMatchObject({ ok: true, typeId: definition.id });
  }
  const rubricContent = `---\ntitle: Memo review\nslug: ${RUBRIC}\n---\n\nMemo review rubric.\n`;
  await db.adminSql`
    INSERT INTO harness_shared.harness_plans
      (workspace_id, harness_slug, plan_slug, content, content_hash, version, title, status, owner,
       template, template_slug, archived, template_data)
    VALUES (${WORKSPACE}, ${HARNESS}, ${RUBRIC}, ${rubricContent}, ${hashPlanContent(rubricContent)}, 1,
            'Memo review', 'active', 'su-test', 'rubric', NULL, false,
            ${JSON.stringify({ criteria: RUBRIC_CRITERIA })}::text::jsonb)`;
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('R-11: activation seeds acceptance bars from item-type criteria', () => {
  it('seeds one bar per criteria-template entry and per named-rubric criterion, mapped to the items of that type', async () => {
    const planSlug = `${NS}-typed-plan`;
    const content = contentFor(planSlug, [SOURCED, REVIEWED, SOURCED]);
    await insertSubject(planSlug, content, 3);
    const result = await seed(planSlug, content, 'su-seeder');
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result));

    const byBar = projected(result);
    // The template's bars cover both items of that type and no other.
    expect(byBar.get(itemTypeBarKey(SOURCED, 'cites-sources'))).toEqual(['P-001', 'P-003']);
    expect(byBar.get(itemTypeBarKey(SOURCED, 'dated'))).toEqual(['P-001', 'P-003']);
    // The named rubric's criteria become bars on the item that names it.
    expect(byBar.get(itemTypeBarKey(REVIEWED, 'reproducible'))).toEqual(['P-002']);
    expect(byBar.get(itemTypeBarKey(REVIEWED, 'bounded'))).toEqual(['P-002']);
    // The requirement BAR is still seeded alongside them.
    expect(byBar.get('R-1')).toEqual(['P-001', 'P-002', 'P-003']);
    expect([...byBar.keys()].filter((key) => key.startsWith('T-'))).toHaveLength(4);

    const criteria = await seededCriteria(result.rubricSlug);
    const cites = criteria.find((criterion) => criterion.barKey === itemTypeBarKey(SOURCED, 'cites-sources'));
    expect(cites, JSON.stringify(criteria)).toMatchObject({ title: 'Cites its sources', model: TEMPLATE[0]!.description });
    const reproducible = criteria.find((criterion) => criterion.barKey === itemTypeBarKey(REVIEWED, 'reproducible'));
    expect(reproducible, JSON.stringify(criteria)).toMatchObject({ title: 'Reproducible', model: RUBRIC_CRITERIA[0]!.model });
  });

  // D-010: every BAR-seed rebuild must derive the item-type bars the way activation does. A
  // neutral post-activation write (here an item status change, as plans:set-status makes)
  // rebuilds the seed with preserveExistingBars; without the item-type bars that rebuild
  // refuses bar_rubric_conflict and the contract's subject-revision pin never advances.
  it('a neutral plan write after activation keeps the item-type bars and advances the contract pin', async () => {
    const planSlug = `${NS}-neutral-write-plan`;
    const before = contentFor(planSlug, [SOURCED, REVIEWED]);
    await insertSubject(planSlug, before, 2);
    const seeded = await seed(planSlug, before, 'su-seeder');
    expect(seeded.ok, JSON.stringify(seeded)).toBe(true);
    if (!seeded.ok) throw new Error(JSON.stringify(seeded));

    const after = before.replace('- **P-001** `todo`', '- **P-001** `wip`');
    expect(after).not.toBe(before);
    await db.adminSql`
      UPDATE harness_shared.harness_plans
         SET content = ${after}, content_hash = ${hashPlanContent(after)}, version = 2
       WHERE workspace_id = ${WORKSPACE} AND harness_slug = ${HARNESS} AND plan_slug = ${planSlug}`;

    const advanced = await db.adminSql.begin((tx) => synchronizeAcceptanceBarSubjectRevision(tx as never, {
      workspaceId: WORKSPACE, harnessSlug: HARNESS, planSlug,
      previousBody: before, nextBody: after, previousVersion: 1, nextVersion: 2,
    }));
    expect(advanced, 'the neutral write must advance the bar contract').toBe(true);

    const [rubric] = await db.adminSql<{ template_data: { barContract?: { subjectPlanRevision?: number }; criteria?: Array<{ barKey?: string }> } }[]>`
      SELECT template_data FROM harness_shared.harness_plans
       WHERE workspace_id = ${WORKSPACE} AND plan_slug = ${seeded.rubricSlug} AND template = 'rubric'`;
    expect(rubric?.template_data.barContract?.subjectPlanRevision).toBe(2);
    const typeBars = (rubric?.template_data.criteria ?? []).map((criterion) => criterion.barKey).filter((key) => key?.startsWith('T-'));
    expect(typeBars.sort()).toEqual([
      itemTypeBarKey(SOURCED, 'cites-sources'), itemTypeBarKey(SOURCED, 'dated'),
      itemTypeBarKey(REVIEWED, 'bounded'), itemTypeBarKey(REVIEWED, 'reproducible'),
    ].sort());
  });

  it('refuses the seed when an item type names a rubric that is not installed', async () => {
    const planSlug = `${NS}-uninstalled-rubric-plan`;
    const content = contentFor(planSlug, [UNINSTALLED]);
    await insertSubject(planSlug, content, 1);
    const result = await seed(planSlug, content, 'su-seeder');
    expect(result.ok, JSON.stringify(result)).toBe(false);
    expect(JSON.stringify(result)).toContain('bar_requirement_parse_failed');
    expect(JSON.stringify(result)).toContain(MISSING_RUBRIC);
    const [rubric] = await db.adminSql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM harness_shared.harness_plans
       WHERE workspace_id = ${WORKSPACE} AND template = 'rubric'
         AND template_data->>'subjectPlan' = ${planSlug}`;
    expect(rubric!.n, 'a refused seed writes no acceptance rubric').toBe(0);
  });

  it('control: a plan that declares no registry type seeds only its requirement bars', async () => {
    const planSlug = `${NS}-untyped-plan`;
    const content = contentFor(planSlug, [null, null]);
    await insertSubject(planSlug, content, 2);
    const result = await seed(planSlug, content, 'su-seeder');
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) throw new Error(JSON.stringify(result));
    expect([...projected(result).keys()]).toEqual(['R-1']);
  });

  it('a re-seed of a plan that has left draft with a seeded contract adds no item-type bar', async () => {
    const planSlug = `${NS}-reseed-plan`;
    const untyped = contentFor(planSlug, [null, null]);
    await insertSubject(planSlug, untyped, 2);
    const first = await seed(planSlug, untyped, 'su-seeder');
    expect(first.ok, JSON.stringify(first)).toBe(true);
    if (!first.ok) throw new Error(JSON.stringify(first));

    // The same active plan now declares a criteria-template type on P-001.
    const typed = contentFor(planSlug, [SOURCED, null]);
    const reseed = await seed(planSlug, typed, 'su-reauditor');
    expect(reseed.ok, JSON.stringify(reseed)).toBe(true);
    if (!reseed.ok) throw new Error(JSON.stringify(reseed));
    expect([...projected(reseed).keys()].filter((key) => key.startsWith('T-'))).toEqual([]);
    expect(reseed.barSetHash).toBe(first.barSetHash);
    const criteria = await seededCriteria(reseed.rubricSlug);
    expect(criteria.some((criterion) => criterion.barKey?.startsWith('T-')), JSON.stringify(criteria)).toBe(false);
  });
});
