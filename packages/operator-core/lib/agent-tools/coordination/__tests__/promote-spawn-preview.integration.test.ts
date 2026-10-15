/**
 * promote-spawn-preview.integration.test.ts — the plans:promote HANDLER's
 * spawn_child PREVIEW path against the baseline-schema PG
 * (promote-spawn-child-harness-2026-05-31 P-003/P-006).
 *
 * The brief's bar: `apply:false` is a PURE preview — it reports what a
 * spawn_child apply would create (child slug, seed plan, feature count) with
 * NO side effects. This drives the real tool handler (default export) end to
 * end: plan read from harness_plans → policy parse → wave build → spawn_child
 * partition → preview payload; then asserts nothing was written anywhere a
 * spawn apply would write (no child plan row, no assertions, no consolidated
 * features, no PG schema), and the parent plan row is byte-unchanged.
 *
 * Also covers the pure-spawn relaxation: a policy whose ONLY wave spawns a
 * child needs no target_harness / harness_slug at all (previously
 * harness_slug_required).
 *
 * Same fixture as the plans tool-suite integration tests: the
 * baseline-schema DB via setupPlanPgFixture() (inject('baselineSchemaDsn')).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import promoteTool from '../tools/promote';
import { childSeedSlug } from '../spawn-child';
// plans:promote resolves a papercup-harness plan at the papercup-primary workspace
// (PAPERCUSP_WORKSPACE_ID, flipped from 'default' on 2026-06-16 — WI-148 part-B /
// migration 295). Seed + verify there, not the fixture's generic 'default', or the
// tool's readPlanBySlug looks in the wrong workspace → plan_not_found.
import { PAPERCUSP_WORKSPACE_ID } from '../../../harness/papercusp-workspace';
import { operatorHomeHarnessSlug } from '../../../harness/operator-home-harness';
import {
  setupPlanPgFixture,
  seedPlan,
  type PlanPgFixture,
} from '../../plans/__tests__/_pg-tool-fixture';

// plans:promote reads the plan at the operator-home scope (no harness arg on the
// tool → resolvePlanScope returns operatorHomeHarnessSlug() / PAPERCUSP_WORKSPACE_ID).
// Seed under that home slug — 'papercusp' post papercup→papercusp migration
// (LEGACY_DEFAULT_HOME_HARNESS flipped 2026-06-20) — not the stale 'papercup'
// literal, or the tool's readPlanBySlug looks in the wrong harness → plan_not_found.
const PARENT_HARNESS = operatorHomeHarnessSlug();
const RUN = Math.random().toString(36).slice(2, 8);
const MIXED_SLUG = `zzz-spawn-preview-mixed-${RUN}-2026-06-07`;
const PURE_SLUG = `zzz-spawn-preview-pure-${RUN}-2026-06-07`;
const CHILD = `zzz-spawn-prevu-child-${RUN}`;
const TODAY = new Date().toISOString().slice(0, 10);
const SEED = childSeedSlug(CHILD, TODAY);

function mixedPlan(): string {
  return `---
title: Spawn Preview Mixed Plan
slug: ${MIXED_SLUG}
created: 2026-06-07
updated: 2026-06-07
status: active
---

# Spawn Preview Mixed Plan

## Now

**State:** Test fixture.

**Next:** Preview only.

## Phase 1

- **P-001** \`todo\` Parent-side work.
- **P-002** \`todo\` Child-side work.

## Promote

\`\`\`yaml
target_harness: zzz-spawn-preview-target
waves:
  - id: stay
    features:
      - title: "Stays in the parent"
        from_items: [P-001]
  - id: extract
    spawn_child:
      slug: ${CHILD}
      template: node-cli
      goal: "Preview-only child"
    features:
      - title: "Goes to the child"
        from_items: [P-002]
        acceptance: ["child builds"]
      - title: "Also goes to the child"
\`\`\`
`;
}

function pureSpawnPlan(): string {
  return `---
title: Spawn Preview Pure Plan
slug: ${PURE_SLUG}
created: 2026-06-07
updated: 2026-06-07
status: active
---

# Spawn Preview Pure Plan

## Now

**State:** Test fixture.

**Next:** Preview only.

## Promote

\`\`\`yaml
waves:
  - id: extract
    spawn_child:
      slug: ${CHILD}
      template: node-cli
    features:
      - title: "Everything goes to the child"
\`\`\`
`;
}

let fx: PlanPgFixture;
let admin: postgres.Sql;

function makeCtx() {
  return {
    log: () => {},
    progress: () => {},
    metadata: () => {},
    signal: new AbortController().signal,
    // promote reads the source plan from the caller's scope (ctxToPlanSourceOpts),
    // so match the workspace used by seedPlan above instead of the fixture's
    // unrelated default workspace.
    workspaceId: PAPERCUSP_WORKSPACE_ID,
    principal: { kind: 'agent', slug: 'agent-spawn-preview-test', workspaceId: PAPERCUSP_WORKSPACE_ID },
  } as never;
}

async function runPromote(args: Record<string, unknown>): Promise<{ data: any; isError: boolean }> {
  const res = (await promoteTool.handler(args as never, makeCtx())) as {
    content: { text: string }[];
    isError?: boolean;
  };
  return { data: JSON.parse(res.content[0].text), isError: Boolean(res.isError) };
}

beforeAll(async () => {
  fx = await setupPlanPgFixture();
  admin = fx.admin;
  await seedPlan(admin, PAPERCUSP_WORKSPACE_ID, PARENT_HARNESS, MIXED_SLUG, mixedPlan());
  await seedPlan(admin, PAPERCUSP_WORKSPACE_ID, PARENT_HARNESS, PURE_SLUG, pureSpawnPlan());
}, 120_000);

afterAll(async () => {
  // Targeted cleanup — the baseline DB is shared; only remove this run's rows.
  await admin`
    DELETE FROM harness_shared.harness_plans
     WHERE plan_slug IN (${MIXED_SLUG}, ${PURE_SLUG}, ${SEED})
  `.catch(() => {});
  await fx.dispose();
});

describe('plans:promote spawn_child preview (apply:false)', () => {
  it('reports the would-be child (slug, seed plan, feature count) for a mixed policy', async () => {
    const { data, isError } = await runPromote({ slug: MIXED_SLUG, all_waves: true, apply: false });
    expect(isError).toBe(false);
    expect(data.ok).toBe(true);
    expect(data.mode).toBe('preview');
    // 1 parent feature + 2 child features built across the waves.
    expect(data.preview.feature_count).toBe(3);
    expect(data.preview.spawn_children).toHaveLength(1);
    expect(data.preview.spawn_children[0]).toMatchObject({
      child_slug: CHILD,
      seed_plan_slug: SEED,
      feature_count: 2,
      wave: 'extract',
      template: 'node-cli',
      child_already_exists: false,
    });
  });

  it('a pure-spawn policy needs no target_harness (previously harness_slug_required)', async () => {
    const { data, isError } = await runPromote({ slug: PURE_SLUG, all_waves: true, apply: false });
    expect(isError).toBe(false);
    expect(data.ok).toBe(true);
    expect(data.preview.feature_count).toBe(1);
    expect(data.preview.spawn_children).toHaveLength(1);
    expect(data.preview.spawn_children[0].child_slug).toBe(CHILD);
  });

  it('is PURE — no seed plan, no assertions, no features, no schema, parent untouched', async () => {
    // Run both previews again so any accidental write would have had two chances.
    await runPromote({ slug: MIXED_SLUG, all_waves: true, apply: false });
    await runPromote({ slug: PURE_SLUG, wave: 'extract', apply: false });

    const seedRows = await admin`
      SELECT 1 FROM harness_shared.harness_plans WHERE plan_slug = ${SEED}
    `;
    expect(seedRows).toHaveLength(0);

    const valRows = await admin`
      SELECT 1 FROM harness_shared.harness_plan_assertions
       WHERE val_id LIKE ${'VAL-' + SEED + '%'} OR harness_slug = ${CHILD}
    `;
    expect(valRows).toHaveLength(0);

    const featRows = await admin`
      SELECT 1 FROM harness_shared.harness_features_consolidated WHERE harness_slug = ${CHILD}
    `;
    expect(featRows).toHaveLength(0);

    const schemaRows = await admin`
      SELECT 1 FROM information_schema.schemata
       WHERE schema_name = ${'harness_' + CHILD.replace(/-/g, '_')}
    `;
    expect(schemaRows).toHaveLength(0);

    // The parent plan row is byte-identical: version + content untouched.
    const parent = await admin<{ version: number; content: string }[]>`
      SELECT version::int AS version, content FROM harness_shared.harness_plans
       WHERE workspace_id = ${PAPERCUSP_WORKSPACE_ID} AND harness_slug = ${PARENT_HARNESS}
         AND plan_slug = ${MIXED_SLUG}
    `;
    expect(parent[0].version).toBe(1);
    expect(parent[0].content).toBe(mixedPlan());
  });
});
