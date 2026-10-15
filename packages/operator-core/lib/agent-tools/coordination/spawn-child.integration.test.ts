/**
 * spawn-child.integration.test.ts — the promote spawn_child branch against a
 * REAL scratch Postgres (promote-spawn-child-harness-2026-05-31 P-006).
 *
 * Exercises `executeSpawnChild` with the REAL PG deps from
 * `buildDefaultSpawnChildDeps` — seed-plan write (`withPlanLock` →
 * `harness_shared.harness_plans`) and plan start (`op_status='started'`) —
 * asserting the brief's green bar:
 *
 *   • child schema exists,
 *   • child seed plan started, carrying plain Acceptance sub-bullets and no
 *     inline VAL-* block (retired: verification-system-improvements-2026-10-10
 *     P-003 — no harness_plan_assertions table is provisioned here, so a
 *     regression that re-adds the write fails loudly),
 *   • child features carry the seed slug,
 *   • the DISPATCHER would pick them up (the started-plan eligibility gate),
 *   • a re-run is idempotent (D-004 retry).
 *
 * Two seams are simulated (they shell out / need the live operator, out of
 * scope for a scratch-workspace test): `scaffold` (the real one runs
 * `papercusp init` + the marketplace catalog — here it creates the per-harness
 * PG schema + registers the slug, the PG-visible side of doScaffoldHarness)
 * and `importFeatures` (the real one POSTs /features/import over loopback —
 * here it upserts harness_features_consolidated the way the import route's
 * SQLite write + consolidated trigger land it). Everything else is the real
 * code path against real PG.
 *
 * The eligibility probe replicates `readFrontierFeatures`' gating WHERE
 * (lib/dbos/orchestrator-loop.ts) against harness_features_consolidated —
 * view-transparent per that function's own doc: the work_items view's feature
 * half is SELECT * over consolidated.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { HARNESS_FEATURES_CONSOLIDATED_DDL } from '../../../test/_work-items-schema';
import type postgres from 'postgres';
import { applyMigrationsForTest, createFreshPgDb, type FreshPgDb } from '../../../test/_pg-helpers';
import { findValBlocks } from '../plans/val-retirement';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
const reg = vi.hoisted(() => ({ registered: new Set<string>() }));

vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return {
    ...(await orig<typeof import('@papercusp/db-org')>()),
    ...actual,
    getOrgPg: () => ({ sql: h.sql }),
    // Same shape as the real withWorkspace (tx + workspace GUC), bound to the
    // scratch DB. The test client is the table owner, so ENABLE RLS does not
    // filter — workspace scoping is asserted via explicit column predicates.
    withWorkspace: async (ws: string, fn: (tx: postgres.Sql) => Promise<unknown>) =>
      h.sql.begin(async (tx) => {
        await (tx as unknown as postgres.Sql)`SELECT set_config('app.workspace_id', ${ws}, true)`;
        return fn(tx as unknown as postgres.Sql);
      }),
  };
});
vi.mock('../../workspace-registry', async () => {
  const actual = await vi.importActual<typeof import('../../workspace-registry')>('../../workspace-registry');
  return { ...actual, activeWorkspaceId: () => 'default' };
});
vi.mock('../../harness-core', async () => {
  const actual = await vi.importActual<typeof import('../../harness-core')>('../../harness-core');
  return {
    ...actual,
    resolveProject: async (slug: string) =>
      reg.registered.has(slug) ? { slug, path: `/tmp/${slug}` } : null,
  };
});

// P-071/D-063: `startPlan` is gated on the Mug/Kettle tier flag, which is OFF in
// the delivered end state — so the op_status write this suite was written to
// observe no longer happens by default. Hold the axis LIVE for the frontier
// cases below (they assert the DISPATCHER mechanics op_status feeds, which are
// unchanged), and flip it off in the one case that asserts the refusal. The
// gate's own wiring to the real flag is covered by
// `spawn-child-op-status-gate.test.ts` (unit, no Docker).
const MUG_KETTLE = vi.hoisted(() => ({ on: true }));
vi.mock('../../pot/started', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  mugKettleSystemEnabled: async () => MUG_KETTLE.on,
}));

const { executeSpawnChild, buildDefaultSpawnChildDeps, childSeedSlug } = await import('./spawn-child');
const { notifyParentOnDone } = await import('../../dbos/notify-parent-done');
type Deps = import('./spawn-child').SpawnChildDeps;
type ImportPayload = Parameters<Deps['importFeatures']>[1];

const WS = 'default';
const CHILD_SLUG = 'scratch-child';
const DATE = '2026-06-07';
const SEED = childSeedSlug(CHILD_SLUG, DATE);

/** harness_plans — the columns withPlanLock writes + the op_* start columns
 *  (mirrors migration 122 + 125/128 normalize + 284 initiative + 329 template; PK identical). */
const HARNESS_PLANS_DDL = `
  CREATE TABLE IF NOT EXISTS harness_shared.harness_plans (
    workspace_id text NOT NULL, harness_slug text NOT NULL, plan_slug text NOT NULL,
    title text, status text, created text, updated text, owner text,
    supersedes text[] DEFAULT '{}'::text[] NOT NULL, superseded_by text,
    content text DEFAULT '' NOT NULL, content_hash text DEFAULT '' NOT NULL,
    version bigint DEFAULT 0 NOT NULL,
    op_status text, op_started_at timestamptz, op_updated_at timestamptz,
    current_wave text, op_priority integer,
    archived boolean DEFAULT false NOT NULL, is_legacy boolean DEFAULT false NOT NULL,
    items jsonb DEFAULT '[]'::jsonb NOT NULL, decisions jsonb DEFAULT '[]'::jsonb NOT NULL,
    now_state text, now_next text, origin text DEFAULT 'local' NOT NULL,
    initiative text,
    -- migration 329 (plan-template-mechanism) + 331 (promote-policy): the withPlanLock
    -- seed-plan write records the spawning template + the promote policy; without these
    -- the INSERT fails "column <name> does not exist". The structured plan columns are
    -- read by every withPlanLock write and are nullable for this seed-plan fixture.
    template text, template_data jsonb, input_schema jsonb, promote_policy jsonb,
    -- withPlanLock's read/insert also names these (908 output_schema, the
    -- acceptance-bar contract slug, and forced_past). This fixture fell one migration
    -- behind once already and 42703'd the seed-plan write ("column output_schema does
    -- not exist"); keep it in step with with-plan-lock.ts's SELECT + INSERT lists.
    output_schema jsonb, acceptance_bar_rubric_slug text, forced_past jsonb,
    acceptance_bar_epoch integer, acceptance_bar_cohort text,
    acceptance_bar_seeded_at timestamptz, acceptance_bar_seeded_by text,
    created_at timestamptz DEFAULT now() NOT NULL, updated_at timestamptz DEFAULT now() NOT NULL,
    PRIMARY KEY (workspace_id, harness_slug, plan_slug))`;

/** harness_features_consolidated — the columns the import lands + the
 *  dispatcher eligibility read needs (status/metadata/item_kind/origin/…). */
const HFC_DDL = HARNESS_FEATURES_CONSOLIDATED_DDL;

let db: FreshPgDb;

/** Simulates POST /features/import + the consolidated trigger: upsert by id —
 *  the same id-keyed idempotency the real route has. */
async function fakeImport(childSlug: string, payload: ImportPayload) {
  for (const f of payload) {
    await h.sql`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, summary, status, item_kind,
         metadata, source_plan_slug, source_plan_item_ids, origin)
      VALUES
        (${WS}, ${childSlug}, ${f.id}, ${f.title}, ${f.summary ?? null}, 'todo', 'feature',
         ${JSON.stringify(f.metadata)}::text::jsonb,
         ${f.source_plan_slug}, ${f.source_plan_item_ids ?? null}, 'local')
      ON CONFLICT (harness_slug, feature_id) DO UPDATE SET
        title = EXCLUDED.title, summary = EXCLUDED.summary
    `;
  }
  return { ids: payload.map((f) => f.id), inserted: payload.length, updated: 0 };
}

/** The PG-visible side of doScaffoldHarness: per-harness schema + registration. */
function makeDeps(): Deps {
  const real = buildDefaultSpawnChildDeps({ importFeatures: fakeImport });
  return {
    ...real,
    resolveChild: async (slug) => reg.registered.has(slug),
    scaffold: async (_parentSlug, child) => {
      await h.sql.unsafe(`CREATE SCHEMA IF NOT EXISTS harness_${child.slug.replace(/-/g, '_')}`);
      // Mirror doScaffoldHarness's PG side: register the child in harness_shared.projects
      // so the seed-plan step's resolvePlanScope can resolve its workspace. Post-WI-148 an
      // unregistered concrete slug THROWS instead of defaulting to 'default'.
      await h.sql`
        INSERT INTO harness_shared.projects (slug, workspace_id) VALUES (${child.slug}, ${WS})
        ON CONFLICT (slug) DO UPDATE SET workspace_id = EXCLUDED.workspace_id`;
      reg.registered.add(child.slug);
      return { ok: true as const };
    },
  };
}

const SPAWN_OPTS = {
  child: { slug: CHILD_SLUG, template: 'node-cli', goal: 'Scratch child for the spawn e2e' },
  waveId: 'extract',
  parentSlug: 'papercup',
  parentPlanSlug: 'parent-plan-2026-06-01',
  features: [
    { title: 'Feature one', acceptance: ['one verifies'], from_items: ['P-001'] },
    { title: 'Feature two', acceptance: ['two verifies', 'two also builds'] },
  ],
  date: DATE,
};

/**
 * The dispatcher's plan-gated eligibility read, replicated verbatim from
 * readFrontierFeatures (lib/dbos/orchestrator-loop.ts) — features with no plan
 * are always eligible; plan features only when their plan is op_status='started'.
 * Queried against consolidated directly (the work_items view's feature half is
 * SELECT * over consolidated — view-transparent, per that function's doc).
 */
async function dispatcherEligibleIds(slug: string): Promise<string[]> {
  const rows = await h.sql<{ feature_id: string }[]>`
    SELECT feature_id
      FROM harness_shared.harness_features_consolidated
     WHERE workspace_id = ${WS}
       AND harness_slug = ${slug}
       AND item_kind = 'feature'
       AND (
         (metadata->>'source_plan') IS NULL
         OR (metadata->>'source_plan') IN (
           SELECT plan_slug
             FROM harness_shared.harness_plans
            WHERE workspace_id = ${WS}
              AND harness_slug = ${slug}
              AND op_status = 'started'
         )
       )
       AND (origin = 'local' OR origin IS NULL OR audit_verdict = 'admit')
     ORDER BY feature_id
  `;
  return rows.map((r) => r.feature_id);
}

beforeAll(async () => {
  db = await createFreshPgDb('spawn-child');
  h.sql = db.sql;
  await db.sql.unsafe(HARNESS_PLANS_DDL);
  await db.sql.unsafe(HFC_DDL);
  // The seed-plan write reads harness_shared.plan_audits (activation-audit
  // preservation). Apply the REAL migrations through the self-auditing helper,
  // so a later structural migration on that table fails this fixture loudly
  // instead of 42P01/42703-ing the seed write into a warning (EI-25654810864485091).
  await applyMigrationsForTest(db.sql, ['832-plan-audits.sql', '938-plan-activation-audits.sql'], {
    label: 'spawn-child.integration plan_audits',
    runtimeTables: ['harness_shared.plan_audits'],
  });
  // The seed-plan step resolves the child's workspace from harness_shared.projects
  // (resolvePlanScope, WI-148). The scaffold dep registers the child here; create
  // the table (slug + workspace_id; parent_slug for the P-004 completion test).
  await db.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.projects (
      slug text PRIMARY KEY, workspace_id text, parent_slug text)`);
  // The seed frontmatter carries `template: child-seed` (D-038), so a brand-new seed
  // write takes withPlanLock's EI-14579 resurrection check, which reads
  // plan_revisions for prior history. Without the table that read 42P01s the seed
  // write into a warning. Shape mirrors 000-baseline + 1107 (content_snapshot_hash).
  await db.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.plan_revisions (
      id bigserial PRIMARY KEY,
      workspace_id text NOT NULL,
      harness_slug text NOT NULL,
      plan_slug text NOT NULL,
      seq integer NOT NULL,
      content_hash text NOT NULL,
      content_snapshot text NOT NULL,
      content_snapshot_hash text,
      rationale text,
      author_kind text,
      author_id text,
      session_id text,
      session_kind text,
      created_at bigint,
      UNIQUE (workspace_id, harness_slug, plan_slug, seq))`);
  // resolvePlanScope's registry FALLBACK (EI-1511: projects is the org-blueprint
  // projection, sparse by design) now reads the AUTHORITATIVE slug→workspace
  // registry — the harness_registry operator-state row (workspace_id, payload
  // {projects:[{slug,…}]}, updated_at; operator-state-pg per-key table shape).
  // Missing it 42P01s the seed-plan write (broke the 2026-07-05 gate). Empty is
  // fine — the scaffold path registers the child, and an empty registry just
  // falls through exactly like a no-match.
  await db.sql.unsafe(`
    CREATE TABLE IF NOT EXISTS harness_shared.harness_registry (
      workspace_id text PRIMARY KEY, payload jsonb, updated_at bigint)`);
  // resolvePlanScope's Hive gate (plans are Hive-scoped) resolves the child's hive
  // home from this payload (potHomeSlugForHarness: harness_kind 'hive' ⇒ itself).
  // Production registration (papercusp init / pot:create) stamps the entry; the
  // stubbed scaffold dep here doesn't, so declare the child a hive home up front —
  // BEFORE anything reads the registry (loadHarnessRegistry read-cache would pin
  // an earlier empty read).
  await db.sql`
    INSERT INTO harness_shared.harness_registry (workspace_id, payload, updated_at)
    VALUES (${WS}, ${JSON.stringify({ projects: [{ slug: CHILD_SLUG, harness_kind: 'hive' }] })}::text::jsonb,
            ${Date.now()})
    ON CONFLICT (workspace_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`;
}, 90_000);

afterAll(async () => {
  await db?.cleanup();
});

describe('executeSpawnChild against real PG (scratch workspace)', () => {
  it('scaffold → seed plan → import → start: the full green bar', async () => {
    const r = await executeSpawnChild(SPAWN_OPTS, makeDeps());

    expect(r.warnings).toEqual([]);
    expect(r).toMatchObject({
      child_slug: CHILD_SLUG,
      seed_plan_slug: SEED,
      scaffold: 'created',
      seed_plan: 'created',
      feature_ids: ['F-SCRATCH-CHILD-SEED-001', 'F-SCRATCH-CHILD-SEED-002'],
      started: true,
    });
    // The retired VAL step left no field behind on the result.
    expect(r).not.toHaveProperty('assertions_written');

    // 1. Child schema exists.
    const schemas = await db.sql<{ schema_name: string }[]>`
      SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'harness_scratch_child'
    `;
    expect(schemas).toHaveLength(1);

    // 2. Child seed plan exists in the CHILD's plans scope and is STARTED.
    const plans = await db.sql<
      { plan_slug: string; status: string; op_status: string; version: number; content: string }[]
    >`
      SELECT plan_slug, status, op_status, version::int AS version, content
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${CHILD_SLUG}
    `;
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ plan_slug: SEED, status: 'active', op_status: 'started', version: 1 });
    expect(plans[0].content).toContain('- **P-001** `todo` Feature one');
    // Acceptance rides as plain sub-bullets in the persisted body (P-003) …
    expect(plans[0].content).toMatch(/^ {2}- \*\*Acceptance:\*\* one verifies$/m);
    expect(plans[0].content.match(/^ {2}- \*\*Acceptance:\*\* /gm)).toHaveLength(3);
    // … and the persisted body carries no inline VAL-* block. Positive control:
    // the same detector finds one in a body that does carry it, so the empty
    // result above is a real absence, not a broken instrument.
    expect(findValBlocks(plans[0].content)).toEqual([]);
    expect(findValBlocks('- **P-001** `todo` x\n  - **[VAL-x-001]**\n    - **Verify:** y')).toHaveLength(1);

    // 3. Child features carry the seed slug (column + the dispatcher's metadata key).
    const feats = await db.sql<
      { feature_id: string; source_plan_slug: string; meta_plan: string; claims: string | null }[]
    >`
      SELECT feature_id, source_plan_slug, metadata->>'source_plan' AS meta_plan, claims
        FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${WS} AND harness_slug = ${CHILD_SLUG}
       ORDER BY feature_id
    `;
    expect(feats.map((f) => f.feature_id)).toEqual(['F-SCRATCH-CHILD-SEED-001', 'F-SCRATCH-CHILD-SEED-002']);
    for (const f of feats) {
      expect(f.source_plan_slug).toBe(SEED);
      expect(f.meta_plan).toBe(SEED);
    }
    // 4. No feature carries VAL-* claims: there are no VAL ids to name (P-003).
    for (const f of feats) expect(f.claims).toBeNull();

    // 5. THE DISPATCHER WOULD PICK THEM UP: the started seed plan makes the
    //    features pass readFrontierFeatures' plan gate.
    expect(await dispatcherEligibleIds(CHILD_SLUG)).toEqual([
      'F-SCRATCH-CHILD-SEED-001',
      'F-SCRATCH-CHILD-SEED-002',
    ]);
  });

  it('the started plan is the load-bearing gate — an unstarted plan is ineligible', async () => {
    await db.sql`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, title, status, item_kind, metadata, origin)
      VALUES (${WS}, ${CHILD_SLUG}, 'F-ORPHAN-001', 'orphan', 'todo', 'feature',
              ${JSON.stringify({ source_plan: 'never-started-plan' })}::text::jsonb, 'local')
    `;
    const eligible = await dispatcherEligibleIds(CHILD_SLUG);
    expect(eligible).not.toContain('F-ORPHAN-001');
    expect(eligible).toEqual(['F-SCRATCH-CHILD-SEED-001', 'F-SCRATCH-CHILD-SEED-002']);
  });

  it('P-004: afterDone builtin posts a Completion to the sealed parent once the queue drains', async () => {
    // The PG side doScaffoldHarness seals: projects.parent_slug = caller.
    await db.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS harness_shared.projects (slug text PRIMARY KEY, parent_slug text)`);
    await db.sql`
      INSERT INTO harness_shared.projects (slug, parent_slug) VALUES (${CHILD_SLUG}, 'papercup')
      ON CONFLICT (slug) DO UPDATE SET parent_slug = EXCLUDED.parent_slug`;
    // retire-work-item-mail-surface-2026-07-26 P-006: the send used to ride
    // dispatchAction → doSendMessage (a per-harness `messages` table write) —
    // that verb was retired; the builtin now calls `sendMessage` (the same
    // primitive `coord:send` uses) directly. This scratch DB doesn't provision
    // the full coord plane (coord_event_log etc.), so inject a stub `send` via
    // the DI seam and assert on ITS captured call, same as notify-parent-done's
    // own unit test.
    const send = vi.fn(async () => ({}) as never);

    // Queue NOT drained (a sibling feature is still todo) → no message.
    const early = await notifyParentOnDone({
      harnessSlug: CHILD_SLUG,
      workspaceId: WS,
      featureId: 'F-SCRATCH-CHILD-SEED-001',
      deps: { send },
    });
    expect(early).toMatchObject({ notified: false, parent: 'papercup', reason: 'queue_not_drained' });
    expect(send).not.toHaveBeenCalled();

    // Drain the queue → the Completion is sent to the parent via sendMessage.
    await db.sql`
      UPDATE harness_shared.harness_features_consolidated
         SET status = 'passed'
       WHERE workspace_id = ${WS} AND harness_slug = ${CHILD_SLUG}`;
    const done = await notifyParentOnDone({
      harnessSlug: CHILD_SLUG,
      workspaceId: WS,
      featureId: 'F-SCRATCH-CHILD-SEED-002',
      deps: { send },
    });
    expect(done).toEqual({ notified: true, parent: 'papercup' });

    expect(send).toHaveBeenCalledTimes(1);
    const [identity, options] = send.mock.calls[0] as unknown as [
      { ownerId: string },
      { to: string[]; summary: string; body: string },
    ];
    expect(identity.ownerId).toBe(`harness-afterdone:${CHILD_SLUG}`);
    expect(options).toMatchObject({ to: ['papercup'] });
    expect(options.summary).toBe(`mission DONE: ${CHILD_SLUG}`);
    expect(options.body).toContain('F-SCRATCH-CHILD-SEED-002');
  });

  it('P-004: a harness with no sealed parent notifies no one', async () => {
    const r = await notifyParentOnDone({ harnessSlug: 'parentless', workspaceId: WS });
    expect(r).toEqual({ notified: false, reason: 'no_parent' });
  });

  it('re-running the same spawn is idempotent (D-004 retry): no duplicates, no version churn', async () => {
    const r = await executeSpawnChild(SPAWN_OPTS, makeDeps());
    expect(r.scaffold).toBe('already_existed');
    expect(r.seed_plan).toBe('already_existed');
    expect(r.started).toBe(true);
    expect(r.feature_ids).toEqual(['F-SCRATCH-CHILD-SEED-001', 'F-SCRATCH-CHILD-SEED-002']);

    const plans = await db.sql<{ n: number; v: number }[]>`
      SELECT count(*)::int AS n, max(version)::int AS v
        FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${CHILD_SLUG}
    `;
    expect(plans[0]).toEqual({ n: 1, v: 1 }); // existing seed kept, no rewrite

    const feats = await db.sql<{ n: number }[]>`
      SELECT count(*)::int AS n
        FROM harness_shared.harness_features_consolidated
       WHERE workspace_id = ${WS} AND harness_slug = ${CHILD_SLUG}
         AND feature_id LIKE 'F-SCRATCH-CHILD-SEED-%'
    `;
    expect(feats[0].n).toBe(2); // deterministic ids upserted, not duplicated
  });
});
