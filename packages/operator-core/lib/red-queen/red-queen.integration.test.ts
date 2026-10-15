/**
 * red-queen.integration.test.ts — the drill harness against a real MIGRATED
 * Postgres (self-learning-frontier P-031 / FB-20): migration 255 applies, the
 * store round-trips the lifecycle, and — the load-bearing one — a FULL drill
 * cycle runs end-to-end through the REAL machinery (watchdog tick → capture
 * core → digest/triage → heal → resolve) with the zero-leak assertion holding
 * on all three legs:
 *
 *   - the planted artifact is INVISIBLE to a live-workspace collector sweep
 *     (the workspace partition);
 *   - the captured row is INVISIBLE to the organic-default read seam while
 *     the explicit drill opt-in sees it (P-002/D-002);
 *   - the captured row's signal_origin is exactly 'drill'.
 *
 * The pure cycle logic is sandbox.test.ts; this file is the PG truth.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { teardownTestPg } from '@papercusp/test-config/pg';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: h.sql }) };
});

import { collectSmokeFailSignals, runWatchdogTick } from '../harness/improvements/watchdog';
import { readImprovementItems } from '../harness/improvements/read-items';
import { drillClassById } from './drill-classes';
import { defaultDrillCycleDeps, runDrillCycle } from './sandbox';
import {
  expireStaleDrills,
  insertDrillRow,
  readDrillOutcomes,
  readMttshVitalsSnapshot,
  updateDrillDetected,
  updateDrillResolved,
  updateDrillTriaged,
} from './store';
import { SANDBOX_SCOPE, SANDBOX_WORKSPACE_ID } from './types';

const LIVE_WS = 'rq-live-ws-test';

let db: OrgTestDb;

beforeAll(async () => {
  db = await createOrgTestDb();
  h.sql = db.adminSql;
}, 180_000);

afterAll(async () => {
  await db?.cleanup();
  if (!process.env.KEEP_TEST_PG) await teardownTestPg();
});

describe('red_queen_drills store (migration 255)', () => {
  it('round-trips the full lifecycle, FB-23 contract shape included', async () => {
    const { drillId, plantedAt } = await insertDrillRow(h.sql, {
      workspaceId: SANDBOX_WORKSPACE_ID,
      drillClass: 'store-rt',
      collectorFamily: 'smoke-fail',
      expectedWatchdogKey: 'smoke-fail:rt',
      expectedKind: 'bug',
      expectedSeverity: 'major',
      expectedDecision: 'place',
      artifacts: { table: 't' },
      payload: { snapshot: [1, 2] },
    });
    expect(drillId).toBeTruthy();
    expect(Date.parse(plantedAt)).toBeGreaterThan(0);

    await updateDrillDetected(h.sql, drillId, {
      detectedAt: new Date().toISOString(),
      detectedWatchdogKey: 'smoke-fail:rt',
      detectedKind: 'bug',
      issueId: 'EI-RT',
    });
    await updateDrillTriaged(h.sql, drillId, {
      triagedAt: new Date().toISOString(),
      triagedDecision: 'place',
      triagedIdeaType: 'infra-environment',
    });
    await updateDrillResolved(h.sql, drillId, {
      resolvedAt: new Date().toISOString(),
      resolvedWithEvidence: true,
      mttsh: { detectMs: 100, triageMs: 50, fixMs: 25, totalMs: 175 },
      leakCheck: {
        passed: true,
        organicReadClean: true,
        liveCollectorClean: true,
        capturedOriginIsDrill: true,
      },
    });

    const [outcome] = await readDrillOutcomes(h.sql, { workspaceId: SANDBOX_WORKSPACE_ID, classId: 'store-rt' });
    expect(outcome).toMatchObject({
      drillId,
      drillClass: 'store-rt',
      collectorFamily: 'smoke-fail',
      status: 'resolved',
      expectedWatchdogKey: 'smoke-fail:rt',
      expectedKind: 'bug',
      expectedDecision: 'place',
      triagedDecision: 'place',
      triagedIdeaType: 'infra-environment',
      resolvedWithEvidence: true,
      issueId: 'EI-RT',
      mttsh: { detectMs: 100, triageMs: 50, fixMs: 25, totalMs: 175 },
      leakCheckPassed: true,
      origin: 'drill',
    });

    const vitals = await readMttshVitalsSnapshot(h.sql);
    const cls = vitals.classes.find((c) => c.drillClass === 'store-rt');
    expect(cls).toMatchObject({ runs: 1, resolved: 1, totalMs: 175 });
  });

  it('one OPEN drill per class: a second plant rejects on the partial unique index', async () => {
    const input = {
      workspaceId: SANDBOX_WORKSPACE_ID,
      drillClass: 'uq-test',
      collectorFamily: 'smoke-fail',
      expectedWatchdogKey: 'k',
      expectedKind: 'bug' as const,
      expectedSeverity: 'major' as const,
      artifacts: {},
    };
    await insertDrillRow(h.sql, input);
    await expect(insertDrillRow(h.sql, input)).rejects.toThrow(/red_queen_drills_open_class_uq/);
  });

  it('expireStaleDrills flips overdue open drills', async () => {
    const { drillId } = await insertDrillRow(h.sql, {
      workspaceId: SANDBOX_WORKSPACE_ID,
      drillClass: 'expire-test',
      collectorFamily: 'smoke-fail',
      expectedWatchdogKey: 'k2',
      expectedKind: 'bug',
      expectedSeverity: 'major',
      artifacts: {},
    });
    await h.sql`
      UPDATE harness_shared.red_queen_drills
         SET planted_at = now() - interval '30 hours' WHERE id = ${drillId}`;
    const n = await expireStaleDrills(h.sql, SANDBOX_WORKSPACE_ID, 24);
    expect(n).toBeGreaterThanOrEqual(1);
    const [row] = await readDrillOutcomes(h.sql, { workspaceId: SANDBOX_WORKSPACE_ID, classId: 'expire-test' });
    expect(row.status).toBe('expired');
  });
});

describe('a FULL drill cycle through the real machinery (the sandbox round-trip)', () => {
  it('smoke-fail: detect → triage → fix with MTTSH recorded and ZERO leak on all three legs', async () => {
    const cls = drillClassById('smoke-fail')!;
    const deps = defaultDrillCycleDeps(h.sql, LIVE_WS);

    const result = await runDrillCycle(cls, deps);

    expect(result.status, result.reason).toBe('resolved');
    expect(result.ok).toBe(true);
    expect(result.issueId).toBeTruthy();
    expect(result.mttsh?.totalMs).toBeGreaterThanOrEqual(0);
    expect(result.leakCheck).toMatchObject({
      passed: true,
      organicReadClean: true,
      liveCollectorClean: true,
      capturedOriginIsDrill: true,
    });

    // The drill row carries the whole story (the FB-23 contract).
    const expectedWatchdogKey = 'smoke-fail:red-queen-sandbox';
    const [outcome] = await readDrillOutcomes(h.sql, { workspaceId: SANDBOX_WORKSPACE_ID, classId: 'smoke-fail' });
    // Pin detector matching separately from persistence: the detected key proves
    // the planted signal matched; the issue row below proves capture accepted its
    // scope and retained drill provenance.
    expect(outcome).toMatchObject({
      status: 'resolved',
      expectedWatchdogKey,
      detectedWatchdogKey: expectedWatchdogKey,
      issueId: result.issueId,
    });
    expect(outcome.triagedDecision).toBeTruthy();
    expect(outcome.resolvedWithEvidence).toBe(true);

    // The real capture path persisted the matching issue under a valid operator
    // scope and kept signal_origin='drill'.
    const [issueRow] = await h.sql<{ signal_origin: string; state: string; scope: string; watchdog_key: string | null }[]>`
      SELECT signal_origin, state, scope, payload->>'watchdogKey' AS watchdog_key
        FROM harness_shared.engineer_issues
       WHERE issue_id = ${result.issueId!}`;
    expect(issueRow).toMatchObject({
      signal_origin: 'drill',
      state: 'resolved',
      scope: SANDBOX_SCOPE,
      watchdog_key: expectedWatchdogKey,
    });

    // END-TO-END provenance: the organic default NEVER sees it; the explicit
    // drill opt-in does (the P-002 read seam, real listIssues underneath).
    const organic = await readImprovementItems({});
    expect(organic.some((c) => c.id === result.issueId)).toBe(false);
    const drillLane = await readImprovementItems({ origins: ['drill'] });
    expect(drillLane.some((c) => c.id === result.issueId)).toBe(true);

    // Cleanup left no sandbox substrate behind.
    const smoke = await h.sql`SELECT 1 FROM harness_shared.harness_smoke_test WHERE workspace_id = ${SANDBOX_WORKSPACE_ID}`;
    expect(smoke.length).toBe(0);
  }, 60_000);

  it('mid-flight, the planted artifact is INVISIBLE to a live-workspace sweep', async () => {
    const cls = drillClassById('unresolved-escalation')!;
    const planted = await cls.plant(h.sql, { drillId: 'leak-probe' });
    try {
      // The live workspace's own collector — the one the real watchdog runs —
      // must see NOTHING while the sandbox sweep fires.
      const sandboxSignals = await cls.collectors(h.sql, planted, SANDBOX_WORKSPACE_ID)[0].collect();
      const sb = Array.isArray(sandboxSignals) ? sandboxSignals : sandboxSignals.signals;
      expect(sb.length).toBe(1);
      expect(sb[0].origin).toBe('drill');

      const liveSignals = await cls.collectors(h.sql, planted, LIVE_WS)[0].collect();
      const lv = Array.isArray(liveSignals) ? liveSignals : liveSignals.signals;
      expect(lv.length).toBe(0);
    } finally {
      await cls.cleanup(h.sql, planted);
    }
  });

  it('routine-engine-death captures its synthetic metric signal with drill provenance while organic reads suppress it', async () => {
    const before = await h.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM harness_shared.routines`;
    const cls = drillClassById('routine-engine-death')!;
    const planted = await cls.plant(h.sql, { drillId: 'routine-engine-death-capture-guard' });
    try {
      const tick = await runWatchdogTick(
        SANDBOX_WORKSPACE_ID,
        { installSlug: 'red-queen-sandbox', maxPerTick: 5 },
        {
          collectors: cls.collectors(h.sql, planted, SANDBOX_WORKSPACE_ID),
          processAging: async () => [],
          processAutoClose: async () => [],
        },
      );

      expect(tick.status).toBe('ran');
      expect(tick.signals).toBe(1);
      expect(tick.seenKeys).toContain(planted.expectedWatchdogKey);
      expect(tick.captured).toHaveLength(1);

      const [issueId] = tick.captured;
      const [issueRow] = await h.sql<{
        signal_origin: string;
        state: string;
        scope: string;
        watchdog_key: string | null;
      }[]>`
        SELECT signal_origin, state, scope, payload->>'watchdogKey' AS watchdog_key
          FROM harness_shared.engineer_issues
         WHERE issue_id = ${issueId}`;
      expect(issueRow).toMatchObject({
        signal_origin: 'drill',
        state: 'open',
        scope: SANDBOX_SCOPE,
        watchdog_key: planted.expectedWatchdogKey,
      });

      const organic = await readImprovementItems({});
      expect(organic.some((candidate) => candidate.id === issueId)).toBe(false);
      const drillLane = await readImprovementItems({ origins: ['drill'] });
      expect(drillLane.some((candidate) => candidate.id === issueId)).toBe(true);

      const after = await h.sql<{ n: string }[]>`SELECT count(*)::text AS n FROM harness_shared.routines`;
      expect(after[0].n).toBe(before[0].n); // the engine's table is untouched
    } finally {
      await cls.cleanup(h.sql, planted);
    }
  }, 60_000);

  it('the live smoke collector for the LIVE workspace stays quiet across drills (belt and suspenders)', async () => {
    const signals = await collectSmokeFailSignals(h.sql, LIVE_WS);
    expect(signals).toHaveLength(0);
  });
});
