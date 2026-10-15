/**
 * package-goal-e2e.integration.test — P-016 of work-on-everything-goal-2026-08-23
 * (WI-41138): the FRONT HALF of the closeout E2E against a real Postgres — the
 * "fresh workspace" chain the plan's acceptance rubric leg A describes:
 *
 *   fresh workspace (empty goals table, the bundled floor on DISK only)
 *     → the REAL bundled package resolves (no install row needed — D-002's floor)
 *     → startGoalFromPackage with typed inputs (P-021 gate, P-025 property binding)
 *     → MINTS the instance through the REAL deps (insertGoalRow, ensure/validate
 *       property datatypes against a real datatype_registry)
 *     → activates through the REAL startGoalById (the D-006 primitive)
 *     → attaches the holder via the REAL setMode (agent_modes + audit row)
 *     → briefs the holder from the REAL package body (STANDING polarity, worklist
 *       duty, the D-011 GRADE-stacking duty).
 *
 * THE BRIDGE TO THE BACK HALF (kill → respawn → stable, pause-not-swept):
 * goal-holder-respawn.integration.test.ts (P-010, WI-41132) already proves those
 * END-TO-END over a row it seeds by hand as `RESPAWN_SETTINGS = { holder:
 * { requireLive: true, onLoss: 'respawn' } }`, standing, budget-windowed. This
 * file asserts the row the REAL start door mints from the REAL bundled package
 * has EXACTLY that proven shape — so the two integration suites compose into the
 * full P-016 chain without either faking the other's half.
 *
 * Injected seams — each one is the OTHER test's subject, never an untested gap:
 *  - `launch`: returns a pre-pinned ownerId without opening a process — the
 *    launch door's own contract, pinned by goal-holder-launch-action.test.ts
 *    (and the same stub goal-holder-respawn.integration.test.ts uses);
 *  - `resolveHolders`: 'unheld' for a goal that has never started — the real
 *    fold over zero rows, pinned by holder.test.ts ("unheld: no goal-mode row");
 *  - `readReadiness`: actionable (the package declares no blockers; the real
 *    edges read is pinned by goal-deps tests and start-goal-by-id.test.ts);
 *  - `drainEnabled: false`: drain-fleet auto-mint rows are pinned by
 *    start-from-package.test.ts ("mints the drain fleet when the flag is on").
 *
 * Fixture: createOrgTestDb() applies the FULL real migration set (same fixture
 * as datatype-registry.integration.test.ts), so this file cannot fall a column
 * behind the live schema — the hand-rolled-DDL drift trap (EI-21270668928342264,
 * bitten twice) is structurally avoided here, not just patched.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';

import { startGoalFromPackage, DEFAULT_DEPS, type StartGoalFromPackageDeps } from './start-from-package';
import { DEFAULT_START_GOAL_BY_ID_DEPS, startGoalById } from './start-goal-by-id';
import { resolveGoalHoldersFromRows } from './holder';
import { buildGoalKickoffBrief } from '../agent-tools/goals/start';
import { resolveLocalGoalPackage } from '../cupboard/goal-package-store';
import { STANDING_GOAL_KILL_POLARITY } from './kill-criterion';
import { GOAL_MODE } from '../modes/goal-session';
import { setMode } from '../modes/store';

const WS = 'ws-woe-p016';
const HARNESS = 'papercusp-p016';
const REF = 'work-on-everything';
const HOLDER = 'su-p016-holder';

const { createOrgTestDb } = await import('../../test/_org-test-db');

let db: Awaited<ReturnType<typeof createOrgTestDb>>;
let rootSql: postgres.Sql;

beforeAll(async () => {
  db = await createOrgTestDb();
  rootSql = db.adminSql;
}, 120_000);

afterAll(async () => {
  await db?.cleanup();
});

beforeEach(async () => {
  // Fresh-workspace semantics: everything scoped to WS starts empty.
  await rootSql`DELETE FROM harness_shared.agent_usage_samples WHERE workspace_id = ${WS}`;
  await rootSql`DELETE FROM harness_shared.agent_mode_changes WHERE workspace_id = ${WS}`;
  await rootSql`DELETE FROM harness_shared.agent_modes WHERE workspace_id = ${WS}`;
  await rootSql`DELETE FROM harness_shared.goals WHERE workspace_id = ${WS}`;
  await rootSql`DELETE FROM harness_shared.datatype_registry WHERE workspace_id = ${WS}`;
});

/** The REAL deps, with only the documented seams overridden. */
function e2eDeps(
  capture: { kickoffPrompt: string | null; launched: string[] },
  recordUsage = true,
): StartGoalFromPackageDeps {
  return {
    ...DEFAULT_DEPS,
    startById: async (sql, input) => {
      // Use the same priced interactive-sample fixture as the holder-liveness
      // integration suite. The real budget resolver needs measured spend;
      // an empty ledger must keep refusing instead of being treated as zero.
      if (recordUsage) {
        const ts = Date.now();
        await sql`
          INSERT INTO harness_shared.agent_usage_samples
            (workspace_id, ts, bucket_key, provider, model_class, source, ingested_at,
             harness_slug, goal_id, cost_usd)
          VALUES (${input.workspaceId}, ${ts}, ${'test:package-goal'}, ${'anthropic'}, ${'test'},
                  ${'interactive'}, ${ts}, ${HARNESS}, ${input.goalId}, ${0.01})`;
      }
      return await startGoalById(sql, input, {
        ...DEFAULT_START_GOAL_BY_ID_DEPS,
        launch: async (launchInput) => {
          capture.launched.push(launchInput.goalId);
          capture.kickoffPrompt = launchInput.kickoffPrompt ?? null;
          return { ownerId: HOLDER, warnings: [] };
        },
        resolveHolders: async (_sql, { workspaceId, goalId }) =>
          resolveGoalHoldersFromRows(goalId, workspaceId, [], new Map()),
        // REAL builder (EI-21566842357792802): this e2e asserts the PACKAGE
        // brief survives to the launch door, so the default must be the genuine
        // one — a stub here could mask the package brief being dropped in favour
        // of a built default.
        buildBrief: buildGoalKickoffBrief,
        readReadiness: async () => ({
          actionable: true,
          premiseInvalidated: false,
          blockers: [],
        }),
        // REAL attach: the same setMode the production default wraps.
        attach: async ({ sql, workspaceId, goalId, ownerId, setBy }) => {
          const res = await setMode({
            workspaceId,
            ownerId,
            modeId: GOAL_MODE,
            enabled: true,
            reason: `p016 e2e: started package goal ${goalId}`,
            setBy,
            subject: goalId,
            sql: sql as postgres.Sql,
          });
          return { ok: res.ok, error: res.ok ? null : 'mode store refused' };
        },
        stampAgentOwner: async (sql, { workspaceId, goalId, ownerId }) => {
          await sql`
            UPDATE harness_shared.goals
               SET metadata = COALESCE(metadata, '{}'::jsonb)
                              || jsonb_build_object('agentOwnerId', ${ownerId}::text)
             WHERE id = ${goalId} AND workspace_id = ${workspaceId}`;
        },
      });
    },
    drainEnabled: async () => false,
  };
}

describe('P-016 front half: the bundled floor in a fresh workspace', () => {
  it('resolves work-on-everything from DISK with the standing semantics intact', () => {
    const pkg = resolveLocalGoalPackage(REF);
    expect(pkg).not.toBeNull();
    expect(pkg!.standing).toBe(true);
    expect(pkg!.budgetWindowSec).toBe(604_800);
    expect(pkg!.propertySchema).toMatchObject({
      worklist: { datatype: 'plan-ref-list' },
    });
  });
});

describe('P-016 front half: typed start → mint → attach → brief (real seams)', () => {
  it('one call yields an active GOAL-mode holder row briefed with the standing clause', async () => {
    const capture = { kickoffPrompt: null as string | null, launched: [] as string[] };
    const res = await startGoalFromPackage(
      rootSql,
      { workspaceId: WS, ref: REF, harness: HARNESS, inputs: null },
      e2eDeps(capture),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.adopted).toBe(false); // fresh workspace: MINT, no stub to adopt
    expect(res.ownerId).toBe(HOLDER);
    expect(capture.launched).toEqual([res.goalId]);

    // The minted row, read back from real PG.
    const [row] = await rootSql<
      Array<{
        status: string;
        standing: boolean;
        budget_window_sec: number | null;
        launch_settings: Record<string, unknown> | null;
        property_schema: Record<string, unknown>;
        metadata: Record<string, unknown> | null;
        install_slug: string;
      }>
    >`SELECT status, standing, budget_window_sec, launch_settings, property_schema,
             metadata, install_slug
        FROM harness_shared.goals WHERE id = ${res.goalId} AND workspace_id = ${WS}`;
    expect(row.status).toBe('active');
    expect(row.standing).toBe(true);
    expect(row.install_slug).toBe(HARNESS);
    expect(row.budget_window_sec).toBe(604_800);
    // THE BRIDGE: exactly the shape goal-holder-respawn.integration.test.ts
    // (P-010) seeds as RESPAWN_SETTINGS and proves kill→respawn-recoverable.
    expect(row.launch_settings).toMatchObject({
      holder: { requireLive: true, onLoss: 'respawn' },
    });
    expect(row.property_schema).toMatchObject({ worklist: { datatype: 'plan-ref-list' } });
    expect(row.metadata).toMatchObject({ goalPackageRef: REF, agentOwnerId: HOLDER });

    // REAL setMode wrote the holder row (P-010's readers consume this exact shape).
    const modes = await rootSql<
      Array<{ owner_id: string; mode: string; subject: string | null }>
    >`SELECT owner_id, mode, subject FROM harness_shared.agent_modes
       WHERE workspace_id = ${WS} AND mode = ${GOAL_MODE} AND subject = ${res.goalId}`;
    expect(modes).toHaveLength(1);
    expect(modes[0].owner_id).toBe(HOLDER);

    // The kickoff brief came from the REAL package body via the REAL builder.
    const brief = capture.kickoffPrompt ?? '';
    expect(brief).toContain('Work on everything');
    expect(brief).toContain(STANDING_GOAL_KILL_POLARITY); // D-003/P-008 standing clause
    expect(brief).toContain('worklist'); // P-025 worklist duty travels in the body
    expect(brief).toContain('Stack the GRADE overlay'); // D-011 GRADE-stacking duty
    // Existing-goal activation must carry the same server-composed portfolio
    // snapshot as goals:start, even when package content supplies an explicit
    // kickoff brief.
    expect(brief).toContain('GOAL PORTFOLIO SNAPSHOT —');
  });

  it('the P-025 datatype was ensured in the registry as a REAL row', async () => {
    const capture = { kickoffPrompt: null as string | null, launched: [] as string[] };
    const res = await startGoalFromPackage(rootSql, { workspaceId: WS, ref: REF, harness: HARNESS }, e2eDeps(capture));
    expect(res.ok).toBe(true);
    const rows = await rootSql<Array<{ id: string }>>`SELECT id FROM harness_shared.datatype_registry
       WHERE workspace_id = ${WS} AND id = 'plan-ref-list'`;
    expect(rows).toHaveLength(1);
  });

  it('refuses a package launch when its declared budget has no usage measurement', async () => {
    const capture = { kickoffPrompt: null as string | null, launched: [] as string[] };
    await expect(startGoalFromPackage(
      rootSql,
      { workspaceId: WS, ref: REF, harness: HARNESS },
      e2eDeps(capture, false),
    )).rejects.toThrow('spend CANNOT BE MEASURED');
    expect(capture.launched).toEqual([]);
    expect(await rootSql`SELECT 1 FROM harness_shared.agent_usage_samples WHERE workspace_id = ${WS}`).toEqual([]);
  });

  it('minting with no harness refuses and leaves the fresh workspace EMPTY', async () => {
    const capture = { kickoffPrompt: null as string | null, launched: [] as string[] };
    const res = await startGoalFromPackage(rootSql, { workspaceId: WS, ref: REF }, e2eDeps(capture));
    expect(res.ok).toBe(false);
    expect(capture.launched).toHaveLength(0);
    const [{ count }] = await rootSql<
      Array<{ count: string }>
    >`SELECT count(*)::text AS count FROM harness_shared.goals WHERE workspace_id = ${WS}`;
    expect(Number(count)).toBe(0);
  });
});
