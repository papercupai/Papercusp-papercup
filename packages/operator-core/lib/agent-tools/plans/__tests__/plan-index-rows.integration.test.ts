/**
 * plan-index-rows.integration.test.ts — the invariant guard for migration 675.
 *
 * `harness_plans.content` is canonical; `plan_items` / `plan_decisions` are a
 * DERIVED index recomputed on every write. The whole change rests on one
 * property: those rows can never drift from what `deriveIndexFromContent`
 * produces for the current `content`. This test is the recurrence guard for
 * that property — it is what should fail if someone later adds a plan write
 * path that forgets to maintain the index.
 *
 * It covers the cases that actually break derived indexes in practice:
 *   - create populates rows
 *   - an edit REPLACES rows (a status flip follows; a renamed id does not linger)
 *   - REMOVING the last item clears rows (the delete-then-insert path — the one
 *     an "upsert only" implementation silently gets wrong)
 *   - ordering is preserved explicitly (`seq`), since a table is unordered
 *   - deleting the plan cascades (no orphaned index rows)
 *   - the rows agree with the jsonb column they replace
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { withPlanLock } from '../with-plan-lock';
import { writePlanIndexRows } from '../plan-index-rows';
import { rubricTemplateDataAuthoringSchema } from '../rubric-template';
import { setupPlanPgFixture, registerHarnessProject, type PlanPgFixture } from './_pg-tool-fixture';
import { buildAcceptanceBarSeed } from '../../../acceptance-bar-seed';

const HARNESS = `zzz-planidx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SLUG = 'plan-index-rows-probe';

let fx: PlanPgFixture;
let admin: postgres.Sql;
let wsId: string;

function body(opts: { items: string[]; decisions?: string[] }): string {
  return `---
title: plan index probe
slug: ${SLUG}
status: draft
created: 2026-07-26
updated: 2026-07-26
---

# plan index probe

## Now

**State:** probing
**Next:** probing

## Requirements

**R-1 — Preserve the approved outcome.** Progress-only writes keep this acceptance BAR current.

## Design

### Bar-to-work map for this plan

| bar | implementing plan items | evidence plane |
|---|---|---|
| R-1 | P-001 | tree |

## Phase 1 — probe

${opts.items.join('\n')}

## Decisions

${(opts.decisions ?? []).join('\n\n')}
`;
}

async function write(md: string): Promise<void> {
  const res = await withPlanLock<{ ok: boolean; code?: string }>(
    null,
    { slug: SLUG, intent: 'plan-index-rows test write', harnessSlug: HARNESS, workspaceId: wsId, ttlSec: 30 },
    async () => ({ newBody: md, value: { ok: true } }),
  );
  if (res.kind !== 'applied') throw new Error(`plan write failed: ${JSON.stringify(res)}`);
  // This helper exercises index synchronization, not activation. Keep the fixture
  // draft so the central activation gate cannot turn a refusal into a false success.
  expect(res.value.ok).toBe(true);
}

async function itemRows(): Promise<Array<{ item_id: string; seq: number; status: string; item_text: string; blocked_by: string[] }>> {
  return admin`
    SELECT item_id, seq, status, item_text, blocked_by
      FROM harness_shared.plan_items
     WHERE workspace_id = ${wsId} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
     ORDER BY seq
  ` as unknown as Promise<Array<{ item_id: string; seq: number; status: string; item_text: string; blocked_by: string[] }>>;
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  wsId = fx.workspaceId;
  await registerHarnessProject(admin, wsId, HARNESS);
});

afterAll(async () => {
  await admin`DELETE FROM harness_shared.harness_plans WHERE workspace_id = ${wsId} AND harness_slug = ${HARNESS}`;
  await fx.dispose();
});

describe('migration 675 — plan_items / plan_decisions stay in lockstep with content', () => {
  it('populates rows on create, in document order', async () => {
    await write(
      body({
        items: [
          '- **P-001** `todo` first item',
          '- **P-002** `wip` second item',
          '- **P-003** `todo` third item',
        ],
        decisions: [
          '### D-001 — a decision\nDate: 2026-07-26\nAffects: target-plan, second-plan\nthe body',
        ],
      }),
    );

    const rows = await itemRows();
    expect(rows.map((r) => r.item_id)).toEqual(['P-001', 'P-002', 'P-003']);
    // `seq` must be dense and ordered — a table has no implicit order, so if
    // this regresses the UI silently reorders the plan.
    expect(rows.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(rows.find((r) => r.item_id === 'P-002')?.status).toBe('wip');

    const decisions = await admin`
      SELECT decision_id, seq, title, affects FROM harness_shared.plan_decisions
       WHERE workspace_id = ${wsId} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
    `;
    expect(decisions.length).toBe(1);
    expect(decisions[0].decision_id).toBe('D-001');
    expect(decisions[0].affects).toEqual(['target-plan', 'second-plan']);
  });

  it('an edit REPLACES the rows rather than accumulating them', async () => {
    await write(
      body({
        items: [
          '- **P-001** `done` first item',
          '- **P-002** `wip` second item',
          '- **P-003** `todo` third item',
        ],
        decisions: ['### D-001 — a decision\nDate: 2026-07-26\nthe body'],
      }),
    );

    const rows = await itemRows();
    expect(rows.length).toBe(3);
    expect(rows.find((r) => r.item_id === 'P-001')?.status).toBe('done');
  });

  it('REMOVING items deletes their rows — the case an upsert-only writer gets wrong', async () => {
    await write(body({ items: ['- **P-001** `done` first item'] }));

    const rows = await itemRows();
    expect(rows.map((r) => r.item_id)).toEqual(['P-001']);

    // and removing the LAST item must leave zero rows, not the previous set
    await write(body({ items: [] }));
    expect((await itemRows()).length).toBe(0);

    const decisions = await admin`
      SELECT count(*)::int AS n FROM harness_shared.plan_decisions
       WHERE workspace_id = ${wsId} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
    `;
    expect(decisions[0].n).toBe(0);
  });

  it('rows agree with the jsonb column they replace', async () => {
    await write(
      body({
        items: [
          '- **P-001** `todo` alpha',
          '- **P-002** `blocked` beta',
        ],
      }),
    );

    // BOTH sides must be scoped in CTEs before the join. Putting the
    // workspace/harness/plan predicates in a FULL OUTER JOIN's ON clause does
    // NOT restrict which plan_items rows participate — every other plan's rows
    // come through unmatched (x.* NULL) and read as mismatches. That bug made
    // this test pass alone and fail in the suite.
    const mismatches = await admin`
      WITH expect AS (
        SELECT e->>'id' AS item_id,
               COALESCE(NULLIF(e->>'status',''),'todo') AS status,
               COALESCE(e->>'text','') AS item_text
          FROM harness_shared.harness_plans p,
               LATERAL jsonb_array_elements(p.items) AS e
         WHERE p.workspace_id = ${wsId} AND p.harness_slug = ${HARNESS} AND p.plan_slug = ${SLUG}
      ), got AS (
        SELECT item_id, status, item_text
          FROM harness_shared.plan_items
         WHERE workspace_id = ${wsId} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
      )
      SELECT count(*)::int AS n
        FROM expect x
        FULL OUTER JOIN got a ON a.item_id = x.item_id
       WHERE a.item_id IS NULL OR x.item_id IS NULL
          OR a.status IS DISTINCT FROM x.status
          OR a.item_text IS DISTINCT FROM x.item_text
    `;
    expect(mismatches[0].n).toBe(0);
  });

  it('deleting the plan cascades — no orphaned index rows', async () => {
    expect((await itemRows()).length).toBeGreaterThan(0);

    await admin`
      DELETE FROM harness_shared.harness_plans
       WHERE workspace_id = ${wsId} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
    `;

    expect((await itemRows()).length).toBe(0);
    const decisions = await admin`
      SELECT count(*)::int AS n FROM harness_shared.plan_decisions
       WHERE workspace_id = ${wsId} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
    `;
    expect(decisions[0].n).toBe(0);
  });
});

// WI-6554700010008467: a census on 2026-10-11 found 27 plans whose plan_items
// matched content while harness_plans.items held removed items and stale
// statuses. writePlanIndexRows is the only plan_items writer, so it now writes
// the jsonb twins as well. These tests drive it directly, as a caller that forgot
// the jsonb would.
describe('writePlanIndexRows keeps the jsonb twins equal to the rows', () => {
  const scope = () => ({ workspaceId: wsId, harnessSlug: HARNESS, planSlug: SLUG });
  const asTx = (sql: postgres.Sql) => sql as unknown as Parameters<typeof writePlanIndexRows>[0];
  const item = (id: string, text: string, status: string) => ({
    id, text, status, importance: '', blockedBy: [], decisionRefs: [], phase: null,
  });
  // The BAR describe below creates this plan fresh; leave no row behind.
  afterAll(async () => {
    await admin`
      DELETE FROM harness_shared.harness_plans
       WHERE workspace_id = ${wsId} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
    `;
  });
  // xmin is the id of the transaction that wrote the current row version. Any
  // executed UPDATE (even a no-op SET) writes a new version and moves it; an
  // UPDATE whose WHERE filters the row out does not.
  async function jsonbRow(): Promise<{ items: unknown; decisions: unknown; xmin: string }> {
    const rows = await admin`
      SELECT items, decisions, xmin::text AS xmin FROM harness_shared.harness_plans
       WHERE workspace_id = ${wsId} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
    `;
    return rows[0] as unknown as { items: unknown; decisions: unknown; xmin: string };
  }

  it('overwrites a stale jsonb even when the caller wrote only the rows', async () => {
    await write(body({ items: ['- **P-001** `todo` first item', '- **P-002** `todo` second item'] }));
    // The drift the census measured: jsonb keeps an item content no longer has.
    await admin`
      UPDATE harness_shared.harness_plans
         SET items = ${JSON.stringify([{ id: 'P-001', status: 'todo' }, { id: 'P-099', status: 'done' }])}::text::jsonb
       WHERE workspace_id = ${wsId} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}
    `;
    const nextItems = [item('P-001', 'first item', 'done'), item('P-002', 'second item', 'wip')];
    const nextDecisions = [{ id: 'D-001', title: 'kept', body: 'b', date: null, itemRefs: [], affects: [] }];
    await writePlanIndexRows(asTx(admin), scope(), { items: nextItems, decisions: nextDecisions });

    const row = await jsonbRow();
    expect(row.items).toEqual(nextItems);
    expect(row.decisions).toEqual(nextDecisions);
    const rows = await itemRows();
    expect(rows.map((r) => [r.item_id, r.status])).toEqual([
      ['P-001', 'done'],
      ['P-002', 'wip'],
    ]);
  });

  it('leaves the plan row untouched when the jsonb already matches', async () => {
    const same = [item('P-001', 'first item', 'done')];
    await writePlanIndexRows(asTx(admin), scope(), { items: same, decisions: [] });
    const before = await jsonbRow();
    await writePlanIndexRows(asTx(admin), scope(), { items: same, decisions: [] });
    const after = await jsonbRow();
    // No new row version, so emit_change_notify_trg does not fire. updated_at
    // cannot detect this: its trigger ignores items/decisions, so it stays put
    // with or without the guard (mutation probe 2, test_runs:21044378).
    expect(after.xmin).toBe(before.xmin);
    expect(after.items).toEqual(same);

    // Calibration: a write that DOES change the jsonb must move xmin, or the
    // equality above would pass whether or not the guard exists.
    const changed = [item('P-001', 'first item', 'wip')];
    await writePlanIndexRows(asTx(admin), scope(), { items: changed, decisions: [] });
    const rewritten = await jsonbRow();
    expect(rewritten.xmin).not.toBe(after.xmin);
    expect(rewritten.items).toEqual(changed);
  });
});

describe('acceptance BAR subject pin follows BAR-neutral writes only', () => {
  it.each([
    ['completion backlink', 'done', 'alpha — note: ← WI-100 completed (done)', 'done', 'alpha — note: ← EI-200 completed (done)', true],
    ['todo → wip', 'todo', 'alpha', 'wip', 'alpha', true],
    ['wip → blocked', 'wip', 'alpha', 'blocked', 'alpha', true],
    ['blocked → needs-human', 'blocked', 'alpha', 'needs-human', 'alpha', true],
    ['needs-human → done + backlink', 'needs-human', 'alpha', 'done', 'alpha — note: ← WI-100 completed (done)', true],
    ['dropped remains semantic', 'todo', 'alpha', 'dropped', 'alpha', false],
    // Only Requirements + Bar-to-work map content is canonical BAR source.
    // Phase item prose is therefore neutral while the mapped item remains live.
    ['item implementation prose', 'done', 'alpha — note: ← WI-100 completed (done)', 'done', 'beta — note: ← WI-100 completed (done)', true],
    ['authored item note', 'done', 'alpha — note: strict acceptance', 'done', 'alpha — note: relaxed acceptance', true],
  ])('%s preserves the appropriate revision boundary', async (_label, beforeStatus, before, afterStatus, after, follows) => {
    const rubricSlug = `${SLUG}-acceptance`;
    const initial = body({ items: [`- **P-001** \`${beforeStatus}\` ${before}`] });
    await write(initial);
    const [subject] = await admin`
      SELECT version FROM harness_shared.harness_plans
       WHERE workspace_id = ${wsId} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;
    const priorVersion = Number(subject.version);
    const seeded = buildAcceptanceBarSeed({
      planSlug: SLUG,
      planContent: initial,
      actorId: 'su-author',
      declaredAt: '2026-09-05T00:00:00.000Z',
      cohort: 'legacy-backfilled',
      backfilled: true,
      adoptionEpoch: 1,
      subjectPlanRevision: priorVersion,
      planStatus: 'draft',
      rubricSlug,
      rubricRevision: 25,
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) throw new Error(seeded.message);
    const data = rubricTemplateDataAuthoringSchema.parse(seeded.templateData);
    if (!data.barSetHash) throw new Error('canonical acceptance BAR seed omitted barSetHash');
    const barSetHash = data.barSetHash;
    await admin`
      INSERT INTO harness_shared.harness_plans
        (workspace_id, harness_slug, plan_slug, content, version, template, template_data)
      VALUES (${wsId}, ${HARNESS}, ${rubricSlug}, '', 25, 'rubric', ${JSON.stringify(data)}::text::jsonb)
      ON CONFLICT (workspace_id, harness_slug, plan_slug) DO UPDATE
        SET template_data = EXCLUDED.template_data, version = 25`;
    await admin`
      UPDATE harness_shared.harness_plans
         SET acceptance_bar_epoch = 1, acceptance_bar_cohort = 'legacy-backfilled',
             acceptance_bar_rubric_slug = ${rubricSlug}, acceptance_bar_rubric_revision = 25,
             acceptance_bar_set_hash = ${barSetHash}, acceptance_bar_seeded_at = now(),
             acceptance_bar_seeded_by = 'su-author'
       WHERE workspace_id = ${wsId} AND harness_slug = ${HARNESS} AND plan_slug = ${SLUG}`;

    await write(body({ items: [`- **P-001** \`${afterStatus}\` ${after}`] }));
    const [rubric] = await admin`
      SELECT version, template_data FROM harness_shared.harness_plans
       WHERE workspace_id = ${wsId} AND harness_slug = ${HARNESS} AND plan_slug = ${rubricSlug}`;
    expect(Number(rubric.version)).toBe(25);
    expect(rubric.template_data).toEqual({
      ...data,
      barContract: { ...data.barContract, subjectPlanRevision: follows ? priorVersion + 1 : priorVersion },
    });
  });
});
