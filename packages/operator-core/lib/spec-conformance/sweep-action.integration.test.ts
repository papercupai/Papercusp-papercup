/** R-23: execute the recurring sweep through the timer and persist its fire receipt. */
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { listActiveEphemeralRoutines, recordEphemeralFire } from '@papercusp/db-org';
import { configureScheduledRegistry, resetScheduledRegistry } from '@papercusp/scheduled-registry';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import {
  armEphemeralExecutor, armedEphemeralIds, disarmEphemeralExecutor, refreshEphemeralExecutor,
  type EphemeralExecutorDeps, type EphemeralRoutineSpec,
} from '../dbos/ephemeral-executor';
import {
  runSpecConformanceSweepAction, specConformanceSweepRoutineRow,
  SPEC_CONFORMANCE_SWEEP_TARGET_ROLE, type SpecConformanceSweepDeps,
} from './sweep-action';

let db: FreshPgDb;
let ticks: Array<() => void>;
const row = specConformanceSweepRoutineRow({ installSlug: 'conformance-test', workspaceId: 'ws', active: true });

beforeAll(async () => {
  db = await createFreshPgDb('conformance-recurring-fire');
  await db.sql.unsafe(`CREATE TABLE harness_shared.routines (
    id text PRIMARY KEY, workspace_id text NOT NULL, install_slug text NOT NULL,
    name text NOT NULL, target_role text NOT NULL, trigger_kind text NOT NULL,
    trigger_config jsonb, payload_template jsonb, concurrency text, catchup text,
    tier text NOT NULL, active boolean NOT NULL, last_fired_at timestamptz,
    next_fire_at timestamptz, reschedule_interval_sec integer, target_owner_id text,
    metadata jsonb, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
  )`);
}, 120_000);
afterAll(async () => { await db?.cleanup(); });
afterEach(() => { disarmEphemeralExecutor(); resetScheduledRegistry(); });
beforeEach(async () => {
  await db.sql`DELETE FROM harness_shared.routines`;
  await db.sql`INSERT INTO harness_shared.routines ${db.sql(row)}`;
  ticks = [];
  configureScheduledRegistry({
    setIntervalImpl: cb => { ticks.push(cb); return { unref() {} }; },
    clearIntervalImpl: () => {}, setTimeoutImpl: () => ({ unref() {} }),
  });
});

function fixture() {
  const runConformance: SpecConformanceSweepDeps['runConformance'] = vi.fn(async plan => ({
    planSlug: plan.planSlug, harnessSlug: plan.harnessSlug, ledgerRef: 'test-run:conformance',
    applicable: true, contractProblems: [], executed: 1, testRunIds: [101],
    requirements: [], unbound: [], unevaluable: [], alarmsOpened: [], alarmsClosed: [],
  }));
  const sweep: SpecConformanceSweepDeps = {
    listPlans: async () => [{ harnessSlug: 'conformance-test', planSlug: 'one-plan',
      content: '## Requirements\n\n**R-1 — Recurring check.**\n```requirement\n' + JSON.stringify({
        intent: { request: 'Run the check.', sourceRefs: ['owner directive #1'] },
        acceptance: { condition: 'check passes', falsifier: 'check does not run', requiredTestLayers: ['unit'] },
        verification: { method: 'test', check: { kind: 'tests', files: ['check.test.ts'] } },
      }) + '\n```\n\n## Phase 1\n- **P-001** `todo` Check.\n' }],
    readWatermarks: async () => new Map(), lastTransitions: async () => new Map(),
    footprintWindow: async () => ({ headSha: 'unchanged', commits: [] }),
    reconcileFootprint: async () => { throw new Error('fixture declares no footprint'); },
    runConformance, writeWatermark: vi.fn(async () => {}), now: Date.now,
  };
  const receipts: unknown[] = [];
  const deps: EphemeralExecutorDeps = {
    list: async () => (await listActiveEphemeralRoutines(db.sql)).map((r): EphemeralRoutineSpec => ({
      id: r.id, workspaceId: r.workspaceId, installSlug: r.installSlug, name: r.name,
      targetRole: r.targetRole, intervalSec: Number(r.triggerConfig.interval_sec),
      payloadTemplate: r.payloadTemplate, triggerConfig: r.triggerConfig,
    })),
    fire: async r => {
      expect(r.targetRole).toBe(SPEC_CONFORMANCE_SWEEP_TARGET_ROLE);
      const receipt = await runSpecConformanceSweepAction({
        workspaceId: r.workspaceId, installSlug: r.installSlug,
        triggerConfig: r.triggerConfig, payloadTemplate: r.payloadTemplate,
      }, sweep);
      receipts.push(receipt);
      return receipt;
    },
    recordFire: (r, error) => recordEphemeralFire(db.sql, r.id, error), log: () => {},
  };
  return { deps, runConformance, receipts };
}

it('a scheduled conformance fire runs the check and records durable liveness', async () => {
  const { deps, runConformance, receipts } = fixture();
  await armEphemeralExecutor(deps);
  expect(armedEphemeralIds()).toEqual([row.id]);
  ticks[0]!();
  await vi.waitFor(async () => {
    const [stored] = await db.sql`SELECT last_fired_at FROM harness_shared.routines WHERE id=${row.id}`;
    expect(stored!.last_fired_at).not.toBeNull();
  }, { timeout: 5000 });
  expect(runConformance).toHaveBeenCalledTimes(1);
  expect(receipts).toEqual([{ diagnostics: { specConformanceSweep: {
    scanned: 1, candidates: 1, ran: [{ key: 'conformance-test/one-plan', triggers: ['never-run'], ok: true }],
    failed: 0, deferred: 0, idle: 0, skipped: 0, footprintProbeErrors: 0,
  } } }]);
  const [stored] = await db.sql`SELECT metadata->>'last_error' AS error,
    (SELECT count(*)::int FROM harness_shared.routines) AS count FROM harness_shared.routines WHERE id=${row.id}`;
  expect(stored).toMatchObject({ error: null, count: 1 });
});

it('a disabled conformance routine never fires or acquires a fire receipt', async () => {
  await db.sql`UPDATE harness_shared.routines SET active=false WHERE id=${row.id}`;
  const { deps, runConformance, receipts } = fixture();
  await armEphemeralExecutor(deps);
  expect(armedEphemeralIds()).toEqual([]);
  for (const tick of ticks) tick();
  await refreshEphemeralExecutor();
  expect(runConformance).not.toHaveBeenCalled();
  expect(receipts).toEqual([]);
  const [stored] = await db.sql`SELECT last_fired_at FROM harness_shared.routines WHERE id=${row.id}`;
  expect(stored!.last_fired_at).toBeNull();
});
