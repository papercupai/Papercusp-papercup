/**
 * degradation-watchdog against REAL Postgres, end to end through the condition rail
 * (degradation-signals-on-condition-rail-2026-10-11 P-003; BARs R-2 and R-8).
 *
 * WHY THIS FILE EXISTS. degradation-watchdog.test.ts proves the decision logic with
 * injected deps. It cannot prove the claims the plan actually rests on, because every
 * one of them is a property of the real rail:
 *
 *   1. A collapse recorded through `observeFallback` reaches the sweep through the real
 *      durable table and the real trailing-window reader.
 *   2. "One alarm per episode" holds across sweeps because the open key is read back
 *      from the durable condition fold (`readConditionEnvelopes` ->
 *      `computeConditionStates`), not from process memory. A faked
 *      `readOpenConditionKeys` would make this tautological.
 *   3. The acting consumer named in the signal-actor registry (R-8:
 *      `system:condition-bridge`) really acts: condition-staleness-alarm's tick, wired
 *      to the real `reconcileConditions`, mints exactly ONE owning work-item for the
 *      `degraded:` key, adopts it on the next tick, and settles it once the watchdog
 *      broadcasts recovery.
 *
 * Everything on that path is real. Only these seams are replaced:
 *   - `getOrgPg` routes to the throwaway DB's RLS-bypass admin client. work_items is
 *     workspace-RLS'd (migration 402) and this test is about the rail, not RLS.
 *   - `coordScopeWorkspace` is pinned so the bridge's work-items and coord links share
 *     one partition (same reasoning as condition-bridge.integration.test.ts).
 *   - `resolveWorkItemPot` is identity: the fresh DB registers no pots.
 *   - The operation-worker receipt read returns "none"; it fails closed on a fixture
 *     with no live sessions and is unrelated to the bridge.
 *   - The staleness tick's escalation and source-health legs are stubbed. They decide
 *     staleness reminders and infra/git-sync reconciliation, neither of which a fresh
 *     `degraded:` condition touches.
 *
 * Run with:
 *   npm run test:file -- packages/operator-core/lib/system-health/degradation-watchdog.integration.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { setupBaselineCoordFixture, type BaselineCoordFixture } from '../_baseline-coord-fixture';
import { ANY_FAMILY_TERMINAL_STATES } from '../work-item-dispatch-states';
import { recordGateReuseDecision } from '../../../../scripts/lib/test-pass-reuse.mjs';
import { armTargetedTaskReuse } from '../../../../scripts/lib/targeted-task-reuse.mjs';
import { broadcastSevereEvent } from '../severe-event-broadcast';

const WS = 'ws-degradation-watchdog-it';
const H = 'papercusp';
const MECHANISM = 'gate-pass-reuse';
const SCOPE = 'lane-unit';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await orig<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../agent-tools/coordination/log', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, coordScopeWorkspace: () => WS };
});
vi.mock('../pot-membership', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveWorkItemPot: async ({ rawSlug }: { rawSlug?: string | null }) => rawSlug ?? null,
  };
});
vi.mock('../blueprint/operation-worker-binding', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, readActiveOperationWorkerClaimBinding: async () => ({ status: 'none' }) };
});

// Imported AFTER the mocks are registered (vi.mock is hoisted).
const { observeFallback, flushFallbackObservations, readFallbackWindowsByScope, _resetFallbackObservationsForTests } = await import(
  '../degradation/fallback-observations'
);
const { CONDITIONS_FAST_PATH_ROW_CAP } = await import('../agent-tools/coordination/tools/conditions');
const { runDegradationSweepOnce, degradationConditionKey, getDegradationMechanism, _resetDegradationPruneClockForTests } =
  await import('./degradation-watchdog');
const { runConditionStalenessTick } = await import('./condition-staleness-alarm');
const { reconcileConditions } = await import('../coord/condition-bridge');
// Warm the stubbed receipt module before the first terminal transition imports it
// lazily (see the WI-10004742 note in condition-bridge.integration.test.ts).
await import('../blueprint/operation-worker-binding');

let db: OrgTestDb;
let coordination: BaselineCoordFixture | undefined;
let savedWsEnv: string | undefined;

/** The condition-staleness tick exactly as production wires it, minus the legs this test does not cover. */
function tick() {
  return runConditionStalenessTick({
    bridgeConditions: reconcileConditions,
    homeHarness: () => H,
    escalate: async () => undefined,
    listOpen: async () => [],
    resolve: async () => undefined,
    readHealthByKey: async () => new Map(),
    readGitSyncHealthByKey: async () => new Map(),
  });
}

async function observe(eligible: number, applied: number, reason: string, scope = SCOPE): Promise<void> {
  const correlationId = randomUUID();
  expect(observeFallback(MECHANISM, { eligible, applied, reason, scope }, {
    workspaceId: 'default', processTag: 'gate-reuse:green-checkpoint',
    correlationId,
  })).toBe(true);
  const flushed = await flushFallbackObservations();
  const rows = await db.adminSql<Array<{ reason: string; scope: string | null; samples: number; eligible: number; applied: number; workspace_id: string; process_tag: string | null; correlation_id: string | null }>>`
    SELECT reason, scope, samples, eligible, applied, workspace_id, process_tag, correlation_id
      FROM harness_shared.fallback_observations
     WHERE mechanism = ${MECHANISM} AND workspace_id = 'default'
       AND process_tag = 'gate-reuse:green-checkpoint' AND correlation_id = ${correlationId}
     ORDER BY id
  `;
  // The writer batches process-wide observations. Verify this call's exact row rather than
  // assuming its flush count excludes other producers that shared the batch.
  expect(flushed).toMatchObject({ failed: 0 });
  expect(rows).toMatchObject([{ reason, scope, samples: 1, eligible, applied,
    workspace_id: 'default', process_tag: 'gate-reuse:green-checkpoint', correlation_id: correlationId }]);
  expect(rows).toHaveLength(1);
}

/** Every work-item currently holding this condition key. */
async function holdersOf(key: string): Promise<string[]> {
  const rows = await db.adminSql<{ feature_id: string }[]>`
    SELECT feature_id FROM harness_shared.work_items WHERE condition_key = ${key} ORDER BY feature_id`;
  return rows.map((r) => r.feature_id);
}

/** Work-items minted for ANY degraded: key, with their status. */
async function degradedItems(): Promise<Array<{ feature_id: string; status: string; title: string }>> {
  return db.adminSql<Array<{ feature_id: string; status: string; title: string }>>`
    SELECT feature_id, status, title FROM harness_shared.work_items
     WHERE title LIKE ${'[degraded:%'} ORDER BY feature_id`;
}

/** Alarm envelopes (not resolutions) carrying this key on the coord message surface. */
async function alarmCount(key: string): Promise<number> {
  const [row] = await db.adminSql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM harness_shared.coord_event_log
     WHERE surface = 'messages' AND body->>'condition_key' = ${key} AND NOT (body ? 'resolves_condition')`;
  return row.n;
}

beforeAll(async () => {
  savedWsEnv = process.env.PAPERCUSP_WORKSPACE_ID;
  process.env.PAPERCUSP_WORKSPACE_ID = WS;
  db = await createOrgTestDb();
  h.sql = db.adminSql;
  // Route every OTHER pool (app client, admin URL, withWorkspace) at the same throwaway DB.
  coordination = await setupBaselineCoordFixture({ dsn: db.adminDsn });
}, 300_000);

afterAll(async () => {
  try {
    await coordination?.dispose();
  } finally {
    await db?.cleanup();
    if (savedWsEnv === undefined) delete process.env.PAPERCUSP_WORKSPACE_ID;
    else process.env.PAPERCUSP_WORKSPACE_ID = savedWsEnv;
  }
}, 120_000);

beforeEach(async () => {
  _resetFallbackObservationsForTests();
  _resetDegradationPruneClockForTests();
  await db.adminSql`
    TRUNCATE harness_shared.fallback_observations, harness_shared.coord_event_log,
             harness_shared.coord_links, harness_shared.work_items RESTART IDENTITY CASCADE`;
});

describe('degradation watchdog on the real condition rail (R-2, R-8)', () => {
  it('does not merge local Papercusp observations into green-checkpoint pass-reuse health', async () => {
    const task = '@papercusp/web::test';
    const key = degradationConditionKey(MECHANISM, task, 'dirty-checkout');
    expect(observeFallback(MECHANISM, { eligible: 1, applied: 0, reason: 'dirty-checkout', scope: task }, {
      workspaceId: WS, processTag: 'gate-reuse',
    })).toBe(true);
    expect(await flushFallbackObservations()).toMatchObject({ written: 1, failed: 0 });
    expect((await runDegradationSweepOnce({ prune: null })).opened).toEqual([]);

    expect(observeFallback(MECHANISM, { eligible: 1, applied: 0, reason: 'dirty-checkout', scope: task }, {
      workspaceId: 'default', processTag: 'gate-reuse:green-checkpoint',
    })).toBe(true);
    expect(await flushFallbackObservations()).toMatchObject({ written: 1, failed: 0 });
    expect((await runDegradationSweepOnce({ prune: null })).opened).toEqual([key]);
  }, 120_000);

  it('uses disjoint adjacent windows at the boundary', async () => {
    const boundary = new Date(Date.now() - 5 * 60_000);
    expect(observeFallback(MECHANISM, { eligible: 1, applied: 0, reason: 'otherRunner', scope: 'boundary-task' }, {
      workspaceId: 'default', processTag: 'gate-reuse:green-checkpoint', observedAt: boundary,
    })).toBe(true);
    expect(await flushFallbackObservations()).toMatchObject({ written: 1, failed: 0 });

    const prior = await readFallbackWindowsByScope(MECHANISM, 60_000, {
      sql: db.adminSql, workspaceId: 'default', processTag: 'gate-reuse:green-checkpoint', now: boundary,
    });
    const current = await readFallbackWindowsByScope(MECHANISM, 60_000, {
      sql: db.adminSql, workspaceId: 'default', processTag: 'gate-reuse:green-checkpoint', now: new Date(boundary.getTime() + 60_000),
    });
    expect(prior).toEqual([]);
    expect(current).toMatchObject([{ scope: 'boundary-task', window: { eligible: 1, applied: 0 } }]);
  }, 120_000);

  it('does not reopen a superseded session condition from predecessor observations', async () => {
    const owner = `su-${randomUUID()}`;
    const conditionKey = degradationConditionKey('compaction-force-respawn', owner, 'force-unavailable');
    const sessionStartedAt = new Date(Date.now() + 30_000);
    const sweepAt = new Date(sessionStartedAt.getTime() + 3_000);
    const mechanism = getDegradationMechanism('compaction-force-respawn');
    if (!mechanism) throw new Error('compaction-force-respawn mechanism is not registered');

    expect(observeFallback('compaction-force-respawn', {
      eligible: 8, applied: 0, reason: 'force-unavailable', scope: owner,
    }, {
      workspaceId: WS,
      observedAt: new Date(sessionStartedAt.getTime() - 60_000),
    })).toBe(true);
    await flushFallbackObservations();
    expect(await broadcastSevereEvent({
      summary: `Degraded compaction force for ${owner}`,
      body: 'Predecessor session observations opened this condition.',
      conditionKey,
      oneShot: true,
    })).toBe(true);

    await db.adminSql`
      INSERT INTO harness_shared.adv_sessions
        (workspace_id, coord_owner_id, mode, agent, session_id, started_at)
      VALUES (${WS}, ${owner}, 'omp', 'codex', ${`fixture-${owner}`}, ${sessionStartedAt})
    `;
    expect(observeFallback('compaction-force-respawn', {
      eligible: 1, applied: 1, reason: 'applied', scope: owner,
    }, {
      workspaceId: WS,
      observedAt: new Date(sessionStartedAt.getTime() + 1_000),
    })).toBe(true);
    await flushFallbackObservations();

    const scoped = await readFallbackWindowsByScope('compaction-force-respawn', 60 * 60 * 1000, {
      sql: db.adminSql, workspaceId: WS, now: sweepAt, sessionOwnerScope: true,
    });
    expect(scoped.map(({ scope, window }) => [scope, window.samples, window.eligible, window.applied]))
      .toEqual([[owner, 1, 1, 1]]);

    const first = await runDegradationSweepOnce({
      mechanisms: () => [mechanism],
      readEndedSessionOwners: async () => new Set(),
      prune: null,
      now: () => sweepAt,
    });
    expect(first.resolved).toEqual([conditionKey]);
    expect(first.opened).toEqual([]);
    expect(await alarmCount(conditionKey)).toBe(1);

    const second = await runDegradationSweepOnce({
      mechanisms: () => [mechanism],
      readEndedSessionOwners: async () => new Set(),
      prune: null,
      now: () => sweepAt,
    });
    expect(second.opened).toEqual([]);
    expect(await alarmCount(conditionKey)).toBe(1);
  }, 120_000);

  it('drives armTargetedTaskReuse through its proof-read timeout and bridges the yield-decline condition to one owner item', async () => {
    const task = '@fixture/lane-ws::test:lane-stateful';
    const key = degradationConditionKey(MECHANISM, task, 'yield-decline');
    const priorAt = new Date(Date.now() - 70 * 60_000);
    for (let i = 0; i < 20; i++) {
      expect(observeFallback(MECHANISM, { eligible: 1, applied: 1, reason: 'applied', scope: task }, {
        workspaceId: 'default', processTag: 'gate-reuse:green-checkpoint', observedAt: priorAt,
      })).toBe(true);
    }
    // Identical observations coalesce into ONE row whose `samples` is 20 (WI-6554700010009713);
    // the window readers sum(samples), so this is still 20 decisions of prior evidence.
    expect(await flushFallbackObservations()).toMatchObject({ written: 1, failed: 0 });

    const root = mkdtempSync(join(tmpdir(), 'degradation-watchdog-reuse-it-'));
    let armed: Awaited<ReturnType<typeof armTargetedTaskReuse>> | undefined;
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture-root', workspaces: ['packages/*'] }));
      const pkgDir = join(root, 'packages/lane-ws');
      mkdirSync(pkgDir, { recursive: true });
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
        name: '@fixture/lane-ws',
        scripts: { 'test:lane-stateful': 'vitest run --passWithNoTests' },
      }));
      const laneSplit = join(root, 'libs/test-config/src');
      mkdirSync(laneSplit, { recursive: true });
      writeFileSync(join(laneSplit, 'lane-split.ts'), [
        'export function isUnitTestFile(file) { return file.endsWith(".test.ts"); }',
        'export function classifyLanes(_root, files) { return { stateful: files }; }',
      ].join('\n'));

      const writer = { observeFallback, flushFallbackObservations };
      armed = await armTargetedTaskReuse({
        root,
        workspace: '@fixture/lane-ws',
        script: 'test:lane-stateful',
        expectedSha: 'a'.repeat(40),
        env: {
          GREEN_CHECKPOINT: '1',
          PAPERCUSP_TEST_RUN_SOURCE: 'ci',
          PAPERCUSP_TEST_RUN_GROUP: '64eab084-4e87-4e2b-99bd-3be2eb7c191f',
          PAPERCUSP_WORKSPACE_ID: WS,
          AFFECTED_TEST_REUSE_AUDIT_RATE: '0',
          AFFECTED_RECORD_EXECUTED_SOURCES: '0',
        },
        deps: {
          git: (_root, args) => args[0] === 'rev-parse' ? `${'a'.repeat(40)}\n` : '',
          runnerIdentity: () => 'proof-v3 test-runner',
          connect: async () => ({ query: async () => ({ rows: [] }), end: async () => undefined }) as never,
          loadProofs: async () => new Promise(() => undefined),
          recordReuse: (label, decision, context) => recordGateReuseDecision(label, decision, { runContext: context.runContext, runGroupId: context.runGroupId, writer }),
        },
      });

      expect(armed.reused).toBe(0);
      expect(armed.lines[0]).toMatch(/applied=false reason=proofs-unavailable\(reuse-proof_read_timed_out\)/);
      const sweep = await runDegradationSweepOnce({ prune: null });
      expect(sweep.errors).toEqual([]);
      expect(sweep.opened).toEqual([key]);
      expect(await alarmCount(key)).toBe(1);

      await tick();
      const items = await holdersOf(key);
      expect(items).toHaveLength(1);
      const [item] = await degradedItems();
      expect(item).toMatchObject({ feature_id: items[0], status: expect.not.stringMatching(/done|closed|resolved/) });
      expect(item.title).toContain(key);
    } finally {
      armed?.finish();
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  it('P-004: shared full-suite/repair recorder, durable window and real bridge detect otherRunner collapse and settle recovery', async () => {
    const task = '@fixture/operator-core::test:lane-stateful';
    const key = degradationConditionKey(MECHANISM, task, 'otherRunner');
    const writer = { observeFallback, flushFallbackObservations };
    const gateContext = { runContext: 'green-checkpoint' as const, writer };
    expect(await recordGateReuseDecision(task, { summary: { candidates: 100, reused: 0, otherRunner: 100 } }, gateContext)).toBe(true);
    expect((await runDegradationSweepOnce()).opened).toEqual([key]);
    expect((await runDegradationSweepOnce()).opened).toEqual([]);
    await tick();
    const items = await holdersOf(key);
    expect(items).toHaveLength(1);
    expect(await alarmCount(key)).toBe(1);
    // Both producers use the same task scope, so later successful primary decisions
    // recover its existing episode rather than creating a separate round-specific key.
    expect(await recordGateReuseDecision(task, { summary: { candidates: 200, reused: 200 } }, gateContext)).toBe(true);
    expect((await runDegradationSweepOnce()).resolved).toEqual([key]);
    await tick();
    expect(await holdersOf(key)).toEqual([]);
    expect((await degradedItems()).map((row) => row.feature_id)).toEqual(items);
    expect(ANY_FAMILY_TERMINAL_STATES).toContain((await degradedItems())[0].status);
  }, 180_000);

  it('P-004: one hard repair-round fail-open reason alarms below the generic candidate floor and recovers', async () => {
    const task = '@fixture/operator-core::test:lane-stateful';
    const key = degradationConditionKey(MECHANISM, task, 'proofs-unavailable');
    const writer = { observeFallback, flushFallbackObservations };

    const gateContext = { runContext: 'green-checkpoint' as const, writer };
    expect(await recordGateReuseDecision(task, { offReason: 'proofs-unavailable' }, gateContext)).toBe(true);
    expect((await runDegradationSweepOnce()).opened).toEqual([key]);

    // A later measurable decision on this task settles the same condition.
    expect(await recordGateReuseDecision(task, { summary: { candidates: 1, reused: 1 } }, gateContext)).toBe(true);
    expect((await runDegradationSweepOnce()).resolved).toEqual([key]);
  }, 180_000);

  it('recovers an old degraded episode outside the bounded aggregate condition window', async () => {
    const task = '@fixture/operator-core::test:old-open-episode';
    const key = degradationConditionKey(MECHANISM, task, 'otherRunner');

    // Seed one old open degraded episode, then saturate the cross-family
    // aggregate reader with newer unrelated condition alarms. The family
    // reader used by degradation recovery must still find the first key.
    expect(await broadcastSevereEvent({
      conditionKey: key,
      oneShot: true,
      summary: 'old degraded episode',
      body: 'regression fixture',
    })).toBe(true);
    await db.adminSql`
      INSERT INTO harness_shared.coord_event_log (workspace_id, surface, msg_id, body, ts)
      SELECT ${WS}, 'messages', 'degraded-window-filler-' || g::text,
             jsonb_build_object('condition_key', 'degraded:unrelated:' || g::text, 'one_shot', true),
             CURRENT_TIMESTAMP + (g * INTERVAL '1 millisecond')
        FROM generate_series(1, ${CONDITIONS_FAST_PATH_ROW_CAP + 1}) AS g
    `;

    // Recovery is scope keyed: write the healthy sample for the same task whose
    // old episode was recovered, rather than the unrelated default fixture scope.
    await observe(20, 20, 'applied', task);
    const sweep = await runDegradationSweepOnce({ prune: null });
    expect(sweep.errors).toEqual([]);
    expect(sweep.resolved).toEqual([key]);
    expect(await alarmCount(key)).toBe(1);
  }, 180_000);

  it('the seed mechanism is registered scope-keyed, so this test exercises the shipped registration', () => {
    expect(getDegradationMechanism(MECHANISM)).toMatchObject({ mechanism: MECHANISM, scopeKeyed: true });
  });

  it('collapse opens ONE degraded: condition, the bridge mints ONE owning item, recovery settles it', async () => {
    const key = degradationConditionKey(MECHANISM, SCOPE, 'proofs-unavailable');
    expect(key).toBe(`degraded:${MECHANISM}:${SCOPE}:proofs-unavailable`);

    // ── Collapse: 40 eligible, 0 applied, one dominant reason ──
    await observe(40, 0, 'proofs-unavailable');

    const s1 = await runDegradationSweepOnce();
    expect(s1.errors).toEqual([]);
    expect(s1.evaluated).toContainEqual({ mechanism: MECHANISM, scope: SCOPE, verdict: 'collapsed' });
    expect(s1.opened).toEqual([key]);

    // Two more sweeps over the same collapsed window: the open key comes back from
    // the durable fold, so neither re-alarms nor resolves.
    for (let i = 0; i < 2; i++) {
      const again = await runDegradationSweepOnce();
      expect(again.errors).toEqual([]);
      expect(again.opened).toEqual([]);
      expect(again.resolved).toEqual([]);
    }
    expect(await alarmCount(key)).toBe(1);

    // The alarm declared itself one-shot, so the staleness guard will not read the
    // deliberate silence after it as recovery.
    const [alarm] = await db.adminSql<{ body: Record<string, unknown> }[]>`
      SELECT body FROM harness_shared.coord_event_log
       WHERE surface = 'messages' AND body->>'condition_key' = ${key}`;
    expect(alarm.body).toMatchObject({ condition_key: key, one_shot: true, category: 'degradation' });

    // ── The acting consumer acts (R-8): one owning item, adopted on the next tick ──
    const t1 = await tick();
    const mint = t1.bridged.acquired.find((a) => a.conditionKey === key);
    expect(mint, JSON.stringify(t1.bridged)).toMatchObject({ created: true });
    const wi = mint!.workItem!;
    expect(await holdersOf(key)).toEqual([wi]);

    const t2 = await tick();
    expect(t2.bridged.acquired.find((a) => a.conditionKey === key)).toMatchObject({ workItem: wi, created: false });
    const open = await degradedItems();
    expect(open.map((r) => r.feature_id)).toEqual([wi]);
    expect(ANY_FAMILY_TERMINAL_STATES).not.toContain(open[0].status);
    expect(open[0].title).toContain(key);

    // ── Recovery: 200 applied of 200 more brings the window to 200/240 >= 0.5 ──
    await observe(200, 200, 'applied');
    const s4 = await runDegradationSweepOnce();
    expect(s4.errors).toEqual([]);
    expect(s4.evaluated).toContainEqual({ mechanism: MECHANISM, scope: SCOPE, verdict: 'recovered' });
    expect(s4.resolved).toEqual([key]);
    expect(s4.opened).toEqual([]);

    const t3 = await tick();
    expect(t3.bridged.released.find((r) => r.released === wi)).toMatchObject({ released: wi, settled: true });
    const [settled] = await degradedItems();
    expect(settled.feature_id).toBe(wi);
    expect(ANY_FAMILY_TERMINAL_STATES).toContain(settled.status);
    expect(await holdersOf(key)).toEqual([]);

    // A recovered window stays quiet: no re-open, no second item.
    const s5 = await runDegradationSweepOnce();
    expect(s5.opened).toEqual([]);
    await tick();
    expect((await degradedItems()).map((r) => r.feature_id)).toEqual([wi]);
  }, 180_000);

  it('negative control: 19 ordinary candidate failures are insufficient evidence', async () => {
    await observe(19, 0, 'otherRunner');
    const s = await runDegradationSweepOnce();
    expect(s.errors).toEqual([]);
    expect(s.evaluated).toContainEqual({ mechanism: MECHANISM, scope: SCOPE, verdict: 'insufficient' });
    expect(s.opened).toEqual([]);
    const t = await tick();
    expect(t.bridged.acquired).toEqual([]);
    expect(await degradedItems()).toEqual([]);
  }, 120_000);
});
