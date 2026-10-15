/**
 * dbos-sweep-glue.integration.test.ts — plan harness-test-coverage-for-launch
 * P-011 / P-013 (the remaining "full DBOS-sweep glue"): the orchestrator loop
 * body that wires the already-covered constituents together, proven against a
 * REAL DBOS runtime + REAL Postgres frontier read + the REAL owned-carve-out.
 *
 * The constituents each have their own coverage:
 *   - `readFrontierFeatures` SQL ........ read-frontier-features.integration.test.ts (P-011)
 *   - `computeFrontier` ................. orchestrator-loop.test.ts (unit)
 *   - `ensureFeaturePipeline` / dedup ... orchestrator-start.test.ts + orchestrator-dedup.integration (P-008)
 *   - `featurePipelineWorkflow` ......... orchestrator-workflow.test.ts (P-006)
 * What had NO coverage is the GLUE in `dispatchOneHarness`: read the frontier →
 * carve out the features a live pipeline already owns (`durableOwnedFeatureIdsPg`,
 * reading `dbos.workflow_status`) → compute free slots from the per-harness cap,
 * live-count and cost-cap → `ensureFeaturePipeline` each. Plus the two callers:
 * `runOrchestratorTick` (the periodic sweep) and `refillHarnessOnSettle` (the
 * on-completion refill nudge).
 *
 * This is genuine integration: ONE throwaway database holds BOTH the harness
 * frontier tables (harness_shared.*) AND DBOS's own `dbos` schema, because the
 * carve-out reads `dbos.workflow_status` through the same frontier `pg` client —
 * a fake DBOS would fake away the exact thing we want to prove (that a started
 * pipeline is seen as owned and so never double-dispatched).
 *
 * What is mocked, and why it is NOT the glue under test:
 *   - the per-harness GATE inputs (`resolveProject`, `readConfig`,
 *     `parallelMaxWorkers`, `maxFeaturesInFlight`, `evaluateCostCap`) — these are
 *     unit-tested in @papercusp/orchestrator; we drive their OUTPUTS (cap,
 *     overCostCap) to exercise the slot math, keeping `resolvePerHarnessCap` +
 *     the frontier + DBOS real.
 *   - the best-effort side-channels (`convertOpenIssuesToFeatures`,
 *     `loadIssuesOrSeed`/`saveIssues`) — neutralised so the issue-promotion /
 *     stuck-signal writes don't interfere; they have their own paths.
 * The agent runner is the same injected stub the other DBOS tests use (decide →
 * DONE), so no real agent ever spawns.
 *
 * Reuse the maintained work-item and dependency fixtures so frontier reads stay
 * aligned with the scheduler's schema rather than a private column subset.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import type { DBOS as DBOSType } from '@dbos-inc/dbos-sdk';
// eslint-disable-next-line import/no-relative-packages -- reuse the maintained complete test schema
import { HARNESS_FEATURES_CONSOLIDATED_DDL, WORK_ITEM_DEPS_DDL } from '../../../packages/operator-core/test/_work-items-schema';

// Shared, mutable test-control state the mocks + injected runner read. Declared
// via vi.hoisted so the (hoisted) vi.mock factories may close over it.
const ctl = vi.hoisted(() => ({
  /** per-harness concurrency cap resolveHarnessDispatchGate should yield */
  cap: 1,
  /** whether the harness is over its cost cap */
  overCostCap: false,
  /** the test DB url getHarnessAdminUrl() should return (refill uses the default) */
  dbUrl: '',
  /** 'done' → director returns DONE immediately; 'block' → awaits the gate so the
   *  pipeline stays PENDING (owned) while we assert */
  runnerMode: 'done' as 'done' | 'block',
  gate: Promise.resolve() as Promise<void>,
  releaseGate: (() => {}) as () => void,
  /** whether the settled hook should actually refill (off by default) */
  settledEnabled: false,
}));

// Drive the per-harness gate (cap + cost) without touching the filesystem.
vi.mock('@papercusp/operator-core/lib/harness-core', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/operator-core/lib/harness-core')>('@papercusp/operator-core/lib/harness-core');
  return {
    ...actual,
    // Any slug resolves to a dummy project so resolveHarnessDispatchGate proceeds
    // to the (mocked) config helpers; the path is never read (readConfig is mocked).
    resolveProject: async (slug: string) => ({ slug, path: `/tmp/glue-${slug}` }),
  };
});
vi.mock('@papercusp/orchestrator', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/orchestrator')>('@papercusp/orchestrator');
  return {
    ...actual, // keep durableOwnedFeatureIdsPg, parseDecision, dispatchAuditorLane REAL
    // P-006 (dispatch lift): resolveDispatchPolicy only consults parallelMaxWorkers
    // when config EXPLICITLY sets parallelWorkers.max (else it defers to the
    // blueprint's dispatch.concurrency, default 1). Declare it so the per-harness
    // cap comes from the (mocked) parallelMaxWorkers → ctl.cap, the test's intent.
    readConfig: () => ({ parallelWorkers: { max: ctl.cap } }),
    parallelMaxWorkers: () => ctl.cap,
    maxFeaturesInFlight: () => null,
    evaluateCostCap: () => ({ total: 0, cap: null, overCap: ctl.overCostCap, warned: false, shouldPause: false }),
  };
});
// The dispatch gate's config source moved from config.json (the mocked legacy
// `readConfig` above) to the blueprint ⊕ PG instance overrides
// (deprecate-harness-config-json-2026-06-06). Deliver the test cap through the
// NEW seam too — otherwise the unmocked read finds no blueprint in the test DB,
// the config is "silent", and the cap silently floors to 1 (this regressed the
// suite 2026-06-05/06: cap=2 scenarios started exactly one feature).
vi.mock('@papercusp/operator-core/lib/harness-effective-config', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/operator-core/lib/harness-effective-config')>('@papercusp/operator-core/lib/harness-effective-config');
  return {
    ...actual,
    readEffectiveHarnessConfig: async () => ({ parallelWorkers: { max: ctl.cap } }),
  };
});
// The dispatch gate also resolves the harness's effective blueprint from PG
// (orchestrator-loop.ts resolveHarnessDispatchGate → getEffectiveBlueprint). This
// fixture hand-rolls its DDL and has no harness_shared.blueprints relation, so the
// real resolver throws, the gate logs a warning and falls back to null, and
// vitest-fail-on-console fails the test (WI-10004634). Return that same null
// directly: dispatch then comes from the mocked effective config above, which is
// the behaviour these sweep-glue scenarios assert.
vi.mock('@papercusp/operator-core/lib/blueprint/project-to-pg', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/operator-core/lib/blueprint/project-to-pg')>('@papercusp/operator-core/lib/blueprint/project-to-pg');
  return { ...actual, getEffectiveBlueprint: async () => null };
});
// Neutralise the best-effort side-channels (own coverage; not the sweep glue).
vi.mock('@papercusp/operator-core/lib/promote-issue', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/operator-core/lib/promote-issue')>('@papercusp/operator-core/lib/promote-issue');
  return { ...actual, convertOpenIssuesToFeatures: async () => ({ promoted: [] }) };
});
vi.mock('@papercusp/operator-core/lib/harness-issues', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/operator-core/lib/harness-issues')>('@papercusp/operator-core/lib/harness-issues');
  return { ...actual, loadIssuesOrSeed: async () => ({ issues: [], nextId: 1 }), saveIssues: async () => {} };
});
// refillHarnessOnSettle dispatches via the DEFAULT adminUrl → point it at the test DB.
vi.mock('@papercusp/operator-core/lib/embedded-pg-discovery', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/operator-core/lib/embedded-pg-discovery')>('@papercusp/operator-core/lib/embedded-pg-discovery');
  return { ...actual, getHarnessAdminUrl: () => ctl.dbUrl };
});
// Only STARTED hives get their work placed (placement-started-gate, start-hive-wake
// P-004): resolveTickHarnesses filters its env candidates by listStartedPots, which
// reads the `operator_settings` KV on getOrgPg()'s connection — a DIFFERENT DB than
// this test's fresh ctl.dbUrl. These tests exercise the DISPATCH sweep, not the
// start-gate (that has its own coverage in orchestrator-tick-harnesses.test.ts), so
// mark whatever the test env-pins as started (read at call time, so it tracks the
// test's PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES / PAPERCUSP_WORKSPACE_ID).
// NOTE: this module lives at lib/pot/started.ts (listStartedPots) — the
// pot->hive->pot lexicon churn left this mock pointed at a since-deleted
// lib/hive/started path exporting a since-renamed listStartedHives, which
// silently orphaned the mock (nothing imports that path anymore) so the REAL
// listStartedPots ran unmocked against the empty test DB (EI-9441).
vi.mock('@papercusp/operator-core/lib/pot/started', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/operator-core/lib/pot/started')>('@papercusp/operator-core/lib/pot/started');
  return {
    ...actual,
    listStartedPots: async () => {
      const ws = process.env.PAPERCUSP_WORKSPACE_ID ?? 'default';
      return (process.env.PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s && s !== 'none' && s !== '*')
        .map((installSlug) => ({ workspaceId: ws, installSlug }));
    },
  };
});

let DBOS: typeof DBOSType;
let loop: typeof import('@papercusp/operator-core/lib/dbos/orchestrator-loop');
let pg: postgres.Sql;
let adminUri: string;
let dbName: string;

const WS = 'ws-glue';

/** Seed one feature row into the frontier table. */
async function seed(
  slug: string,
  featureId: string,
  opts: { order?: number; status?: string; origin?: string; sourcePlan?: string | null } = {},
): Promise<void> {
  const { order = 1, status = 'todo', origin = 'local', sourcePlan = null } = opts;
  const metadata = sourcePlan ? pg.json({ source_plan: sourcePlan }) : null;
  await pg`
    INSERT INTO harness_shared.harness_features_consolidated
      (harness_slug, feature_id, status, metadata, workspace_id, origin, audit_verdict, feature_order)
    VALUES (${slug}, ${featureId}, ${status}, ${metadata}, ${WS}, ${origin}, null, ${order})`;
}

/** Live (PENDING/ENQUEUED) pipeline workflow ids for a harness. */
async function liveIds(slug: string): Promise<string[]> {
  const live = await DBOS.listWorkflows({ workflow_id_prefix: `pipeline:${slug}:`, status: ['PENDING', 'ENQUEUED'] });
  return live.map((w) => w.workflowID);
}

/** Poll until `pred()` is true (or time out). For the async DBOS state writes. */
async function waitFor(pred: () => Promise<boolean>, timeoutMs = 10_000, stepMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}

/** Arm block-mode: started pipelines stay PENDING until the gate is released. */
function armBlock(): void {
  ctl.runnerMode = 'block';
  ctl.gate = new Promise<void>((resolve) => {
    ctl.releaseGate = resolve;
  });
}

beforeAll(async () => {
  // Carve-out on (DBOS is default unless =0); no scheduled cron (gated at import).
  process.env.PAPERCUSP_DBOS_ORCHESTRATOR = '1';
  process.env.PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES = 'none';
  delete process.env.PAPERCUSP_WORKSPACE_ID;

  adminUri = await getTestPg();
  dbName = `dbos_glue_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
    await markManagedTestDatabase(admin, dbName);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  ctl.dbUrl = u.toString();

  pg = postgres(ctl.dbUrl, { max: 4, onnotice: () => {} });
  await pg.unsafe('CREATE SCHEMA IF NOT EXISTS harness_shared');
  await pg.unsafe(HARNESS_FEATURES_CONSOLIDATED_DDL).simple();
  await pg.unsafe(WORK_ITEM_DEPS_DDL).simple();
  await pg.unsafe(`
    ALTER TABLE harness_shared.harness_plans ADD COLUMN IF NOT EXISTS op_priority INT;
    -- Non-work-item links remain separate from canonical work_item_deps.
    CREATE TABLE harness_shared.coord_links (
      id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
      workspace_id text DEFAULT 'default' NOT NULL,
      src_kind text NOT NULL, src_ref text NOT NULL,
      dst_kind text NOT NULL, dst_ref text NOT NULL,
      rel text NOT NULL, created_by text, created_at timestamptz DEFAULT now() NOT NULL
    );
  `);

  ({ DBOS } = await import('@dbos-inc/dbos-sdk'));
  DBOS.setConfig({
    name: 'papercusp-test',
    systemDatabaseUrl: ctl.dbUrl,
    systemDatabaseSchemaName: 'dbos',
    applicationVersion: 'test-v1',
    runAdminServer: false, // avoid the admin-server EADDRINUSE on this shared box
  });

  // Register the workflow + queue, then the loop module (which registers the tick
  // workflow — the cron is gated off by HARNESSES='none'). After setConfig, before launch.
  const wf = await import('@papercusp/operator-core/lib/dbos/orchestrator-workflow');
  loop = await import('@papercusp/operator-core/lib/dbos/orchestrator-loop');

  // Injected agent runner: the director decides DONE; in block-mode it parks on the
  // gate first so the pipeline stays PENDING (owned) for the assertion.
  wf.setPipelineInvokeRunner(async (_slug, role, _feature) => {
    if (role === 'director') {
      if (ctl.runnerMode === 'block') await ctl.gate;
      return { output: 'DONE', exitCode: 0 };
    }
    return { output: `ran ${role}`, exitCode: 0 };
  });
  // The real refill seam, gated so only the refill test arms it.
  wf.setPipelineSettledHook((slug, ws) => {
    if (ctl.settledEnabled && ws) loop.refillHarnessOnSettle(slug, ws);
  });

  await DBOS.launch();
}, 120_000);

afterEach(async () => {
  // Release any parked pipeline so DBOS can drain; reset to defaults.
  ctl.releaseGate();
  ctl.runnerMode = 'done';
  ctl.settledEnabled = false;
  ctl.cap = 1;
  ctl.overCostCap = false;
  // Let released directors finish their step so nothing lingers into the next test.
  await new Promise((r) => setTimeout(r, 50));
});

afterAll(async () => {
  try {
    await DBOS.shutdown();
  } catch {
    /* best-effort */
  }
  await pg?.end({ timeout: 5 }).catch(() => {});
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  } catch {
    /* best-effort */
  } finally {
    await admin.end({ timeout: 5 });
  }
});

describe('dispatchOneHarness — the DBOS sweep glue (P-011/P-013)', () => {
  it('fills free slots up to the per-harness cap in frontier order, and no further', async () => {
    const slug = 'glue-cap';
    ctl.cap = 2;
    await seed(slug, 'F-A1', { order: 1 });
    await seed(slug, 'F-A2', { order: 2 });
    await seed(slug, 'F-A3', { order: 3 });

    const r = await loop.dispatchOneHarness(slug, WS, ctl.dbUrl);

    // cap=2, 3 ready → start exactly the top two by feature_order; F-A3 left behind.
    expect(r.harness).toBe(slug);
    expect(r.started.sort()).toEqual(['F-A1', 'F-A2']);
    expect(r.started).not.toContain('F-A3');

    // …and real DBOS pipelines exist for those two only.
    const ids = await DBOS.listWorkflows({ workflow_id_prefix: `pipeline:${slug}:` });
    const wf = ids.map((w) => w.workflowID).sort();
    expect(wf).toEqual([`pipeline:${slug}:F-A1:e0`, `pipeline:${slug}:F-A2:e0`]);
  }, 60_000);

  it('carves out features a live pipeline already owns — a re-sweep with free slots starts nothing', async () => {
    const slug = 'glue-owned';
    ctl.cap = 4; // generous: slots stay free after the first sweep
    armBlock(); // started pipelines park PENDING (owned)
    await seed(slug, 'F-B1', { order: 1 });
    await seed(slug, 'F-B2', { order: 2 });

    const first = await loop.dispatchOneHarness(slug, WS, ctl.dbUrl);
    expect(first.started.sort()).toEqual(['F-B1', 'F-B2']);

    // Both pipelines are now live/owned (PENDING) — confirm before the re-sweep.
    expect(await waitFor(async () => (await liveIds(slug)).length === 2)).toBe(true);

    // Re-sweep: cap-4 leaves slots=4-2=2 FREE, but both features are owned, so the
    // carve-out removes them from the candidate set → nothing new is started.
    const second = await loop.dispatchOneHarness(slug, WS, ctl.dbUrl);
    expect(second.started).toEqual([]);

    // And no duplicate (e1) pipeline was minted for either feature.
    const all = (await DBOS.listWorkflows({ workflow_id_prefix: `pipeline:${slug}:` })).map((w) => w.workflowID).sort();
    expect(all).toEqual([`pipeline:${slug}:F-B1:e0`, `pipeline:${slug}:F-B2:e0`]);
  }, 60_000);

  it('starts nothing when the harness is over its cost cap, even with ready work', async () => {
    const slug = 'glue-cost';
    ctl.cap = 4;
    ctl.overCostCap = true;
    await seed(slug, 'F-C1', { order: 1 });
    await seed(slug, 'F-C2', { order: 2 });

    const r = await loop.dispatchOneHarness(slug, WS, ctl.dbUrl);
    expect(r.started).toEqual([]);
    expect(await DBOS.listWorkflows({ workflow_id_prefix: `pipeline:${slug}:` })).toHaveLength(0);
  }, 60_000);

  it('keeps a feature blocked until its canonical dependency settles', async () => {
    const slug = 'glue-dependency';
    ctl.cap = 2;
    await seed(slug, 'F-BLOCKER', { order: 1, status: 'wip' });
    await seed(slug, 'F-DEPENDENT', { order: 2 });
    await pg`
      INSERT INTO harness_shared.work_item_deps
        (workspace_id, blocked_kind, blocked_ref, blocker_kind, blocker_ref)
      VALUES ('default', 'feature', ${`${slug}#F-DEPENDENT`}, 'feature', ${`${slug}#F-BLOCKER`})`;

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const blocked = await loop.dispatchOneHarness(slug, WS, ctl.dbUrl);
      expect(blocked.started).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`[dbos-orchestrator] ${slug} frontier STUCK`),
      );
    } finally {
      warn.mockRestore();
    }
    expect(await DBOS.listWorkflows({ workflow_id_prefix: `pipeline:${slug}:` })).toHaveLength(0);

    await pg`
      UPDATE harness_shared.work_items SET status = 'done'
       WHERE workspace_id = ${WS} AND harness_slug = ${slug} AND feature_id = 'F-BLOCKER'`;
    const released = await loop.dispatchOneHarness(slug, WS, ctl.dbUrl);
    expect(released.started).toEqual(['F-DEPENDENT']);
    expect((await DBOS.listWorkflows({ workflow_id_prefix: `pipeline:${slug}:` })).map(w => w.workflowID))
      .toEqual([`pipeline:${slug}:F-DEPENDENT:e0`]);
  }, 60_000);

  it('is fail-safe: an unreachable schema returns {started:[]} instead of throwing', async () => {
    const slug = 'glue-fail';
    ctl.cap = 4;
    await seed(slug, 'F-D1', { order: 1 });

    // A bad admin url makes the frontier read throw inside dispatchOneHarness; the
    // per-harness try/catch must isolate it (a bad slug can't sink the whole sweep).
    // Since audit P-035 the catch WARNS instead of swallowing silently (a dropped
    // schema must not look like "no work") — expect the warn explicitly.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await loop.dispatchOneHarness(slug, WS, 'postgresql://nobody:nobody@127.0.0.1:1/none');
      expect(r).toEqual({ harness: slug, started: [] });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(`[dbos-dispatch] ${slug} tick failed (non-fatal):`),
        expect.anything(),
      );
    } finally {
      warn.mockRestore();
    }
  }, 60_000);
});

describe('runOrchestratorTick — the periodic sweep wrapper (P-011)', () => {
  it('sweeps the env-resolved harness in the pinned workspace and starts its ready features', async () => {
    const slug = 'glue-tick';
    ctl.cap = 2;
    armBlock();
    await seed(slug, 'F-T1', { order: 1 });
    await seed(slug, 'F-T2', { order: 2 });

    // Pin the workspace + scope the sweep to just this harness (read at call time;
    // no cron was scheduled because import-time HARNESSES was 'none').
    process.env.PAPERCUSP_WORKSPACE_ID = WS;
    process.env.PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES = slug;
    try {
      const results = await loop.runOrchestratorTick();
      const mine = results.find((x) => x.harness === slug);
      expect(mine).toBeDefined();
      expect(mine!.started.sort()).toEqual(['F-T1', 'F-T2']);
    } finally {
      delete process.env.PAPERCUSP_WORKSPACE_ID;
      process.env.PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES = 'none';
    }
  }, 60_000);
});

describe('refillHarnessOnSettle — the on-completion refill nudge (P-013)', () => {
  it('immediately dispatches the harness (via the default admin url) on a fresh tick', async () => {
    const slug = 'glue-refill';
    ctl.cap = 1;
    await seed(slug, 'F-R1', { order: 1 });

    // Fire the nudge — fire-and-forget; it setImmediate→dispatchOneHarness(slug, ws)
    // resolving the admin url through getHarnessAdminUrl() (mocked to the test DB).
    loop.refillHarnessOnSettle(slug, WS);

    const appeared = await waitFor(async () =>
      (await DBOS.listWorkflows({ workflow_id_prefix: `pipeline:${slug}:F-R1:` })).length > 0,
    );
    expect(appeared).toBe(true);
  }, 60_000);
});
