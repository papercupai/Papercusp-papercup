/**
 * handlerPhaseRollup (papercusp-performance-audit-2026-10-12 P-001): the per-phase
 * rollup dev:telemetry { phasesFor } reports over the handler-phases-v1 record the
 * dispatcher persists in tool_invocations.metadata_json.handlerPhases
 * (libs/generic/tooldef/src/dispatch-stack.ts, phase-tracker.ts).
 *
 * Every expected number below is computed by hand from the seeded rows, not read
 * back from the implementation, so the test fails if the coverage or percentile
 * arithmetic changes.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrgTestDb } from '../test/_org-test-db';

const h = vi.hoisted(() => ({ sql: null as unknown }));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: h.sql }) }));

const { handlerPhaseRollup } = await import('./dev-data');
const { createOrgTestDb } = await import('../test/_org-test-db');

const WS = 'ws-handler-phases';
const OTHER_WS = 'ws-handler-phases-other';
const HOUR = 60 * 60 * 1000;

let nextId = 1;

interface Phase {
  phase: string;
  startMs: number;
  durationMs: number;
}

function phasesRecord(elapsedMs: number, attributedMs: number, phases: Phase[] | string) {
  return {
    schemaVersion: 'handler-phases-v1',
    unit: 'ms',
    timing: 'wall-time-possibly-concurrent',
    elapsedMs,
    attributedMs,
    phases,
    pending: [],
    omittedCompletedCount: 0,
  };
}

async function seed(
  db: OrgTestDb,
  opts: { workspaceId?: string; toolName: string; agoMs?: number; metadata: Record<string, unknown> | null },
) {
  const invokedAt = new Date(Date.now() - (opts.agoMs ?? HOUR)).toISOString();
  const metadata = opts.metadata == null ? null : JSON.stringify(opts.metadata);
  await db.adminSql`
    INSERT INTO harness_shared.tool_invocations
      (id, workspace_id, harness_slug, plugin_name, tool_name, role, spawn_id,
       invoked_at, window_key, status, transport, metadata_json)
    VALUES
      (${nextId++}, ${opts.workspaceId ?? WS}, 'h1', 'core', ${opts.toolName}, 'worker', ${`sp-${nextId}`},
       ${invokedAt}::timestamptz, 'w', 'ok', 'mcp', ${metadata}::jsonb)`;
}

describe('handlerPhaseRollup (P-001)', () => {
  let db: OrgTestDb;

  beforeAll(async () => {
    db = await createOrgTestDb();
    h.sql = db.adminSql;

    // Three coord:orient calls in WS that carry handlerPhases.
    //   A: 950 of 1000 ms attributed (0.95)   read 650 + decorate 300
    //   B: 1000 of 2000 ms attributed (0.50)  read 1000
    //   C: 900 of 1000 ms attributed (0.90)   read 400 + decorate 500
    await seed(db, {
      toolName: 'coord:orient',
      metadata: {
        dispatchStages: { schemaVersion: 'dispatch-stages-v1' },
        handlerPhases: phasesRecord(1000, 950, [
          { phase: 'read', startMs: 0, durationMs: 650 },
          { phase: 'decorate', startMs: 650, durationMs: 300 },
        ]),
      },
    });
    await seed(db, {
      toolName: 'coord:orient',
      metadata: { handlerPhases: phasesRecord(2000, 1000, [{ phase: 'read', startMs: 0, durationMs: 1000 }]) },
    });
    await seed(db, {
      toolName: 'coord:orient',
      metadata: {
        handlerPhases: phasesRecord(1000, 900, [
          { phase: 'read', startMs: 0, durationMs: 400 },
          { phase: 'decorate', startMs: 400, durationMs: 500 },
        ]),
      },
    });

    // Rows the WS-scoped 24 h rollup must exclude.
    await seed(db, { toolName: 'coord:orient', metadata: { dispatchStages: { schemaVersion: 'dispatch-stages-v1' } } });
    await seed(db, { toolName: 'coord:orient', metadata: null });
    await seed(db, {
      toolName: 'work_items:list',
      metadata: { handlerPhases: phasesRecord(500, 500, [{ phase: 'list:query', startMs: 0, durationMs: 500 }]) },
    });
    await seed(db, {
      toolName: 'coord:orient',
      agoMs: 30 * HOUR,
      metadata: { handlerPhases: phasesRecord(1000, 0, [{ phase: 'stale', startMs: 0, durationMs: 1 }]) },
    });
    await seed(db, {
      toolName: 'coord:orient',
      workspaceId: OTHER_WS,
      metadata: { handlerPhases: phasesRecord(1000, 0, [{ phase: 'other-ws', startMs: 0, durationMs: 7 }]) },
    });

    // A malformed record: phases is not an array. It still counts toward coverage,
    // contributes no phase rows, and must not make the query throw.
    await seed(db, {
      toolName: 'fleet:assignments',
      metadata: { handlerPhases: phasesRecord(800, 400, 'not-an-array') },
    });
  }, 180_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  it('computes coverage over calls that carried handlerPhases, scoped by tool, workspace and window', async () => {
    const r = await handlerPhaseRollup({ toolName: 'coord:orient', workspaceIds: [WS], hours: 24 });

    expect(r.tool_name).toBe('coord:orient');
    expect(r.hours).toBe(24);
    expect(r.calls_with_phases).toBe(3);
    // (950 + 1000 + 900) / (1000 + 2000 + 1000) = 2850 / 4000 = 0.7125
    expect(r.coverage_total).toBeCloseTo(0.7125, 2);
    // per-call ratios 0.95, 0.50, 0.90 -> median 0.90
    expect(r.coverage_p50).toBeCloseTo(0.9, 3);
    // 0.95 and 0.90 meet the >= 0.9 bar (0.90 is the inclusive boundary); 0.50 does not
    expect(r.coverage_ge_90_share).toBeCloseTo(2 / 3, 3);
  });

  it('aggregates named phases with count, p50, p95 and total, largest total first', async () => {
    const r = await handlerPhaseRollup({ toolName: 'coord:orient', workspaceIds: [WS], hours: 24 });

    // read: 650, 1000, 400 -> total 2050, p50 650, p95 = 650 + 0.9 * (1000 - 650) = 965
    // decorate: 300, 500 -> total 800, p50 400, p95 = 300 + 0.95 * (500 - 300) = 490
    expect(r.phases).toEqual([
      { phase: 'read', count: 3, p50_ms: 650, p95_ms: 965, total_ms: 2050 },
      { phase: 'decorate', count: 2, p50_ms: 400, p95_ms: 490, total_ms: 800 },
    ]);
    // the out-of-window and other-workspace phase names never leak in
    expect(r.phases.map((p) => p.phase)).not.toContain('stale');
    expect(r.phases.map((p) => p.phase)).not.toContain('other-ws');
  });

  it('widens to every listed workspace when several are passed', async () => {
    const r = await handlerPhaseRollup({ toolName: 'coord:orient', workspaceIds: [WS, OTHER_WS], hours: 24 });

    expect(r.calls_with_phases).toBe(4);
    // (2850 + 0) / (4000 + 1000) = 0.57
    expect(r.coverage_total).toBeCloseTo(0.57, 3);
    expect(r.phases.find((p) => p.phase === 'other-ws')).toEqual({
      phase: 'other-ws',
      count: 1,
      p50_ms: 7,
      p95_ms: 7,
      total_ms: 7,
    });
  });

  it('includes an older call once the window covers it', async () => {
    const r = await handlerPhaseRollup({ toolName: 'coord:orient', workspaceIds: [WS], hours: 48 });

    expect(r.calls_with_phases).toBe(4);
    expect(r.phases.map((p) => p.phase)).toContain('stale');
  });

  it('counts a record whose phases field is not an array without producing phase rows', async () => {
    const r = await handlerPhaseRollup({ toolName: 'fleet:assignments', workspaceIds: [WS], hours: 24 });

    expect(r.calls_with_phases).toBe(1);
    expect(r.coverage_total).toBeCloseTo(0.5, 3);
    expect(r.phases).toEqual([]);
  });

  it('returns nulls, not zeros, when no call carried handlerPhases', async () => {
    const r = await handlerPhaseRollup({ toolName: 'scheduler:get_next', workspaceIds: [WS], hours: 24 });

    expect(r).toEqual({
      tool_name: 'scheduler:get_next',
      hours: 24,
      calls_with_phases: 0,
      coverage_total: null,
      coverage_p50: null,
      coverage_ge_90_share: null,
      phases: [],
    });
  });

  it('clamps the window to 1..336 hours', async () => {
    expect((await handlerPhaseRollup({ toolName: 'coord:orient', workspaceIds: [WS], hours: 0 })).hours).toBe(1);
    expect((await handlerPhaseRollup({ toolName: 'coord:orient', workspaceIds: [WS], hours: 10_000 })).hours).toBe(336);
  });
});
