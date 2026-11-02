/**
 * routines.test.ts — routines:list + routines:set (live-configurability-audit P-002).
 *
 * Mocks getOrgPg/workspace/home-harness/cron + the control harness (separately covered), so no PG.
 * Asserts: list maps rows (cron from trigger_config, iso timestamps) · set is operator/architect-
 * gated · set requires cron|active · an invalid cron is rejected BEFORE any DB touch · pause
 * (active:false) runs through the harness · dryRun does not apply.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/routines/routines.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
// The live tool barrel installs the built-in cells before any door is dispatched.
// This file imports the door directly, so reproduce that bootstrap explicitly.
import '../cell-registrations-wiring';

// Declare the mock's PARAMETERS, not just its return: `vi.fn(async () => …)` is a
// zero-arg signature, so `sqlMock.mock.calls` types as `[][]` and `.flat()` collapses
// to `never[]`. Every `typeof v === 'string'` guard below then narrows `never` (which
// has no properties) and TS rejects `.startsWith` / `.includes` — 5 errors that had
// nothing to do with the assertions themselves. Typing the rest args as `unknown[]`
// gives `.flat()` an `unknown[]`, which those guards narrow correctly. (WI-3616 drive-by:
// these 5 were the entire operator-core typecheck overage, 228 vs baseline 224.)
const {
  sqlMock,
  controlMock,
  resourceQueueMock,
  deadPidMock,
  lockTxnSqlMock,
  resourcePoolBeginMock,
  boundedOrgTxnMock,
} = vi.hoisted(() => {
  const sqlMock = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
  const lockTxnSqlMock = vi.fn(async (..._args: unknown[]) => [] as unknown[]);
  return {
    sqlMock,
    controlMock: vi.fn(async (spec: any, opts: any = {}) => {
      const prev = await spec.capturePrev();
      if (opts.dryRun) return { dryRun: true, applied: false, prev, preview: spec.describe?.(prev) };
      const next = await spec.apply();
      const verify = spec.verify ? await spec.verify(next) : undefined;
      return { dryRun: false, applied: true, prev, next, verify, auditId: 'aud-1' };
    }),
    resourceQueueMock: vi.fn(async (..._args: unknown[]) => ({
      holders: [] as Array<{ owner: string; mode: 'shared' | 'exclusive'; status: 'held' | 'draining' }>,
      draining: false,
      queue: [],
    })),
    deadPidMock: vi.fn((_pid: number) => false),
    lockTxnSqlMock,
    resourcePoolBeginMock: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(lockTxnSqlMock)),
    boundedOrgTxnMock: vi.fn(async (fn: (tx: unknown) => Promise<unknown>, _opts?: unknown) => fn(sqlMock)),
  };
});
vi.mock('../locks/su-lock-store', () => ({
  getTxPool: vi.fn(() => ({ begin: resourcePoolBeginMock }) as never),
  readResourceQueue: resourceQueueMock,
}));
vi.mock('../locks/resource-acquire-wait', () => ({ isPidDefinitivelyDead: deadPidMock }));
vi.mock('@papercusp/db-org', async (orig) => ({ ...(await orig<Record<string, unknown>>()), getOrgPg: () => ({ sql: sqlMock }) }));
vi.mock('../../pg-bounded-txn', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  boundedOrgTxn: boundedOrgTxnMock,
}));
vi.mock('../../workspace-registry', async (orig) => ({ ...(await orig<Record<string, unknown>>()), activeWorkspaceId: () => 'default' }));
vi.mock('../../harness/operator-home-harness', async (orig) => ({ ...(await orig<Record<string, unknown>>()), operatorHomeHarnessSlug: () => 'home-harness' }));
vi.mock('../../harness/routines/cron', async (orig) => ({ ...(await orig<Record<string, unknown>>()), computeNextFireAt: vi.fn(() => new Date('2030-01-01T00:00:00Z')) }));
vi.mock('../../gateway-control/control-harness', () => ({ runControlMutation: controlMock }));
vi.mock('../../release-checkpoint-config', () => ({
  readQualificationAdmission: vi.fn(async () => ({ status: 'clear' as const })),
}));
// P-004: partial mock via importOriginal. This module also owns
// CHECKPOINT_QUIESCENCE_PAUSE_MARKER, which release-pause-ttl.ts imports as the ONE
// definition of the serializer quiescence hold (never a hand-copied literal). A
// whole-module replacement here silently deletes that constant, and the failure
// surfaces far away, inside routines:list's pause projection.
vi.mock('../../release/checkpoint-serializer-authority', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readCheckpointSerializerAuthority: vi.fn(async () => ({ status: 'none' as const, reason: 'routine-not-paused' as const })),
}));
vi.mock('../../coord/gate-ownership', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readGateOwnership: vi.fn(async () => ({
    assessment: 'unowned' as const,
    eventKey: 'gate-red-streak:home-harness',
    workItem: null,
    claimState: 'no-object' as const,
    unknown: null,
    takenBy: null,
    takenAt: null,
    lastProgressAt: null,
    expiresAt: null,
    holderSessionState: null,
    duplicates: [],
    thread: { status: 'not-applicable' as const, reason: 'no owner' },
  })),
}));
vi.mock('../../release-checkpoint-launch', () => ({
  // WI-10005268: routines:set probes through the off-loop async form.
  checkActiveCheckpointRunAsync: vi.fn(async () => ({
    active: false,
    unit: 'papercusp-green-checkpoint',
    systemd: { scope: 'user' as const, argv: [], load_state: 'loaded', known: true, invocation_id: null },
  })),
}));
vi.mock('../../harness/routines/release-actions', () => ({
  resolveIntegrationRoot: vi.fn(() => '/integration-root'),
}));

import { computeNextFireAt } from '../../harness/routines/cron';
import { readQualificationAdmission } from '../../release-checkpoint-config';
import { readCheckpointSerializerAuthority } from '../../release/checkpoint-serializer-authority';
import { checkActiveCheckpointRunAsync } from '../../release-checkpoint-launch';
import { resolveIntegrationRoot } from '../../harness/routines/release-actions';
import { readGateOwnership } from '../../coord/gate-ownership';
const cronM = vi.mocked(computeNextFireAt);
const admissionM = vi.mocked(readQualificationAdmission);
const serializerM = vi.mocked(readCheckpointSerializerAuthority);
const activeRunM = vi.mocked(checkActiveCheckpointRunAsync);
const rootM = vi.mocked(resolveIntegrationRoot);
const gateOwnershipM = vi.mocked(readGateOwnership);

const listModule = await import('./list');
const listTool = listModule.default;
const {
  attestGateHealth,
  deriveGitSyncFreshness,
  deriveGitSyncExclusions,
  isHealthRecordKey,
  deriveOriginFreshness,
  applyDerivedGitSyncHeadline,
} = listModule;
const setTool = (await import('./set')).default;
const { TURN_HOLD_INTENT, RESTRICTED_HOLD_INTENT } = await import('../../personal-vault/git-sync-hold');

type Out = { content?: { text: string }[]; data?: unknown };
// routines:list returns a {data} envelope (context-trimming-tiers P-023);
// routines:set still self-serializes content[] — handle both.
const body = (o: unknown) => {
  const out = o as Out;
  return out.data !== undefined ? out.data : JSON.parse(out.content![0]!.text);
};

const gitSyncRoutineRow = (metadata: Record<string, unknown>) => ({
  install_slug: 'home-harness',
  name: 'git-sync',
  trigger_kind: 'cron',
  trigger_config: { cron: '0 */3 * * * *' },
  target_role: 'system:git-sync',
  active: true,
  next_fire_at: new Date(Date.now() + 60_000),
  last_fired_at: new Date(Date.now() - 60_000),
  group_slug: null,
  metadata,
});

beforeEach(() => {
  vi.clearAllMocks();
  resourceQueueMock.mockReset();
  resourceQueueMock.mockResolvedValue({ holders: [], draining: false, queue: [] });
  lockTxnSqlMock.mockReset();
  lockTxnSqlMock.mockResolvedValue([]);
  resourcePoolBeginMock.mockReset();
  resourcePoolBeginMock.mockImplementation(async (fn) => fn(lockTxnSqlMock));
  boundedOrgTxnMock.mockReset();
  boundedOrgTxnMock.mockImplementation(async (fn) => fn(sqlMock));
  deadPidMock.mockReset();
  deadPidMock.mockReturnValue(false);
  cronM.mockReturnValue(new Date('2030-01-01T00:00:00Z'));
  admissionM.mockResolvedValue({ status: 'clear' });
  serializerM.mockResolvedValue({ status: 'none', reason: 'routine-not-paused' });
  gateOwnershipM.mockResolvedValue({
    assessment: 'unowned',
    eventKey: 'gate-red-streak:home-harness',
    workItem: null,
    claimState: 'no-object',
    unknown: null,
    takenBy: null,
    takenAt: null,
    lastProgressAt: null,
    expiresAt: null,
    holderSessionState: null,
    duplicates: [],
    thread: { status: 'not-applicable', reason: 'no owner' },
  } as never);
  activeRunM.mockResolvedValue({
    active: false,
    unit: 'papercusp-green-checkpoint',
    systemd: { scope: 'user', argv: [], load_state: 'loaded', known: true, invocation_id: null },
  });
  rootM.mockReturnValue('/integration-root');
  sqlMock.mockResolvedValue([]);
});

describe('routines:list', () => {
  it('adds a structured marker when trimmed health clips a nested string', () => {
    const shaped = listTool.shape!.trimmed!({
      count: 1,
      routines: [{ name: 'git-sync', health: { explanation: 'H'.repeat(10_000) } }],
    }, { args: {} } as never) as { routines: Array<{ health: Record<string, unknown> }> };

    expect(shaped.routines[0]?.health.healthTruncated).toBe(true);
    expect(String(shaped.routines[0]?.health.explanation)).toContain('[TRUNCATED');
  });

  it('projects scheduled action, run creation, and current plan scan coverage separately', async () => {
    const now = Date.now();
    const scheduledRow = {
      id: 'cleanup-routine',
      install_slug: 'papercusp',
      name: 'plan-cleanup-sweep',
      trigger_kind: 'cron',
      trigger_config: { cron: '17 41 9 * * *', max_plans: 100 },
      target_role: 'system:plan-cleanup-sweep',
      active: true,
      next_fire_at: new Date(now + 60_000),
      last_fired_at: new Date(now - 2 * 60 * 60_000),
      group_slug: null,
      metadata: null,
    };
    sqlMock
      .mockResolvedValueOnce([scheduledRow])
      .mockResolvedValueOnce([{
        routine_id: 'cleanup-routine',
        workflow_uuid: 'workflow-cleanup',
        output: JSON.stringify({ json: { diagnostics: {
          outcome: 'started', runId: 'run-1', phase: 'running', requested: 250, accepted: 100, truncated: 150,
        } } }),
        error: null,
        completed_at_epoch_ms: String(now - 60 * 60_000),
      }])
      .mockResolvedValueOnce([{
        install_slug: 'papercusp',
        eligible_plan_count: '250',
        scanned_plan_count: '250',
        fresh_plan_count: '245',
        freshness_window_days: '4',
        freshness_max_plans: '100',
        oldest_last_scanned_at: new Date(now - 4 * 24 * 60 * 60_000),
        newest_last_scanned_at: new Date(now - 2 * 24 * 60 * 60_000),
        latest_run_id: 'run-1',
        latest_run_phase: 'running',
        latest_run_created_at: new Date(now - 2 * 60 * 60_000),
        latest_run_updated_at: new Date(now - 60 * 60_000),
        latest_run_seed_plan_count: '100',
        latest_run_requested_plan_count: '250',
        latest_run_accepted_plan_count: '100',
        latest_run_truncated_plan_count: '150',
      }]);

    const result = body(await listTool.handler(
      { installSlug: 'papercusp', name: 'plan-cleanup-sweep' } as never,
      { role: 'su' } as never,
    ));
    const health = result.routines[0]?.health;
    expect(health.plan_cleanup_freshness).toMatchObject({
      read_status: 'available',
      execution: {
        scheduled_claim_at: scheduledRow.last_fired_at.toISOString(),
        action_result: { read_status: 'available', outcome: 'started', run_id: 'run-1', phase: 'running' },
      },
      latest_scheduled_run: {
        run_id: 'run-1',
        phase: 'running',
        seed_plan_count: 100,
        requested_plan_count: 250,
        accepted_plan_count: 100,
        truncated_plan_count: 150,
      },
      run_record_matches_action: true,
      coverage: {
        eligible_plan_count: 250,
        scanned_plan_count: 250,
        fresh_plan_count: 245,
        stale_plan_count: 5,
        never_scanned_plan_count: 0,
        max_plans_per_run: 100,
        freshness_window_ms: 4 * 24 * 60 * 60_000,
        freshness_status: 'stale',
      },
    });
    const trimmed = listTool.shape!.trimmed!({ count: result.count, routines: result.routines }, { args: {} } as never) as {
      routines: Array<{ health: { plan_cleanup_freshness: { coverage: { freshness_status: string } } } }>;
    };
    expect(trimmed.routines[0]?.health.plan_cleanup_freshness.coverage.freshness_status).toBe('stale');
    expect(boundedOrgTxnMock).toHaveBeenCalledTimes(2);
    expect(boundedOrgTxnMock.mock.calls[1]?.[1]).toMatchObject({
      acquireTimeoutMs: 5_000,
      statementTimeoutMs: 5_000,
      lockTimeoutMs: 750,
      readOnly: true,
    });
    const freshnessCall = sqlMock.mock.calls[2]!;
    const freshnessQuery = (freshnessCall[0] as TemplateStringsArray).join(' ');
    expect(freshnessQuery).toContain('harness_shared.harness_plans');
    expect(freshnessQuery).toContain('harness_shared.attention_bulk_runs');
    expect(freshnessQuery).toContain("r.phase IN ('review', 'running', 'complete')");
    expect(freshnessQuery).toContain('CEIL(c.eligible_plan_count::numeric / h.max_plans)');
    expect(freshnessQuery).toContain('r.requested_by =');
    expect(freshnessCall.slice(1)).toContain('system:plan-cleanup-sweep');
  });

  it('surfaces plan-cleanup coverage read failure as unavailable, never as zero uncovered plans', async () => {
    sqlMock
      .mockResolvedValueOnce([{
        id: 'cleanup-routine',
        install_slug: 'papercusp',
        name: 'plan-cleanup-sweep',
        trigger_kind: 'cron',
        trigger_config: { cron: '17 41 9 * * *' },
        target_role: 'system:plan-cleanup-sweep',
        active: true,
        next_fire_at: null,
        last_fired_at: new Date(),
        group_slug: null,
        metadata: null,
      }])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('coverage statement timeout'));

    const result = body(await listTool.handler(
      { installSlug: 'papercusp', name: 'plan-cleanup-sweep' } as never,
      { role: 'su' } as never,
    ));
    expect(result.routines[0]?.health?.plan_cleanup_freshness).toMatchObject({
      read_status: 'unavailable',
      unavailable_reason: expect.stringContaining('coverage statement timeout'),
      execution: {
        action_result: { read_status: 'no_completed_result_in_8_day_window' },
      },
    });
    expect(result.routines[0]?.health?.plan_cleanup_freshness).not.toHaveProperty('coverage');
  });

  it('keeps the plan-cleanup history query off unpinned routine listings', async () => {
    sqlMock.mockResolvedValueOnce([{
      id: 'cleanup-routine',
      install_slug: 'papercusp',
      name: 'plan-cleanup-sweep',
      trigger_kind: 'cron',
      trigger_config: { cron: '17 41 9 * * *' },
      target_role: 'system:plan-cleanup-sweep',
      active: true,
      next_fire_at: null,
      last_fired_at: null,
      group_slug: null,
      metadata: null,
    }]);

    const result = body(await listTool.handler({} as never, { role: 'su' } as never));
    expect(sqlMock).toHaveBeenCalledTimes(1);
    expect(result.routines[0]?.health).toBeNull();
  });

  // WI-6554700010018198 / WI-6554700010018409: git-sync's attribution-outage evidence is read
  // from this tool, so both keys must survive the healthOf allowlist, a zero counter included.
  it.each([7, 0])('surfaces git-sync attribution health (consecutive_zero_attribution_ticks=%i)', async (ticks) => {
    const lastAttribution = {
      at: Date.now() - 60_000,
      repos: [{ scope: 'libs/sub', agentGroupCount: 3, agentCommitCount: 0, failedGroups: 3, error: 'index.lock' }],
    };
    cronM.mockImplementation((_cron, from) => new Date(from.getTime() + 3 * 60_000));
    sqlMock.mockResolvedValue([
      gitSyncRoutineRow({
        last_status: 'synced',
        last_synced_at: Date.now() - 60_000,
        consecutive_zero_attribution_ticks: ticks,
        last_attribution: lastAttribution,
      }),
    ]);

    const result = body(await listTool.handler(
      { installSlug: 'home-harness', name: 'git-sync' } as never,
      { role: 'su' } as never,
    ));

    expect(result.routines[0]?.health).toMatchObject({
      consecutive_zero_attribution_ticks: ticks,
      last_attribution: lastAttribution,
    });
  });

  it('bounds the conditional DBOS read and returns unavailable when that phase times out', async () => {
    sqlMock.mockResolvedValueOnce([{ ...gitSyncRoutineRow({}), install_slug: 'other-harness' }]);
    boundedOrgTxnMock.mockRejectedValueOnce(Object.assign(new Error('statement timeout'), { code: '57014' }));
    const metadata = vi.fn();

    const result = body(await listTool.handler(
      { installSlug: 'other-harness', name: 'git-sync' } as never,
      { role: 'su', metadata } as never,
    ));

    expect(boundedOrgTxnMock).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        acquireTimeoutMs: 5_000,
        statementTimeoutMs: 5_000,
        lockTimeoutMs: 750,
        readOnly: true,
      }),
    );
    expect(result.routines[0]?.lastFire).toEqual({ unavailable: expect.stringContaining('statement timeout') });
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({
      routinesListPhases: expect.objectContaining({
        schemaVersion: 'routines-list-phase-timings-v1',
        lastFireLookupMs: expect.any(Number),
        lastFireUnavailableCount: 1,
      }),
    }));
  });

  it('bounds stale git-sync queue reads and records a failed phase as unverified', async () => {
    deadPidMock.mockReturnValue(true);
    sqlMock.mockResolvedValueOnce([{
      ...gitSyncRoutineRow({
        git_sync_activity: {
          active: true,
          owner: 'system:git-sync:12345:fire',
          owner_pid: 12345,
        },
      }),
      install_slug: 'other-harness',
    }]);
    resourceQueueMock.mockRejectedValueOnce(Object.assign(new Error('statement timeout'), { code: '57014' }));
    const metadata = vi.fn();

    const result = body(await listTool.handler(
      { installSlug: 'other-harness' } as never,
      { role: 'su', metadata } as never,
    ));

    expect(resourcePoolBeginMock).toHaveBeenCalledTimes(1);
    expect(lockTxnSqlMock).toHaveBeenCalledTimes(2);
    const timeoutSetup = lockTxnSqlMock.mock.calls[1]?.[0] as TemplateStringsArray;
    expect(timeoutSetup.join('')).toContain("set_config('statement_timeout'");
    expect(timeoutSetup.join('')).toContain("set_config('lock_timeout'");
    expect(resourceQueueMock).toHaveBeenCalledWith(
      lockTxnSqlMock,
      { coordinationDomain: 'default', resource: 'git-sync:other-harness' },
    );
    expect(result.routines[0]?.health).toMatchObject({
      git_sync_freshness: {
        execution: {
          owner_reconciliation: {
            status: 'unverified',
            lock_state: 'unknown',
          },
        },
      },
    });
    expect(metadata).toHaveBeenCalledWith(expect.objectContaining({
      routinesListPhases: expect.objectContaining({
        resourceQueueReadCount: 1,
        resourceQueueReadFailures: 1,
        resourceQueueReadMaxMs: expect.any(Number),
      }),
    }));
  });

  it('derives degraded git-sync health when last_synced_at is older than three scheduled intervals', () => {
    const now = Date.parse('2026-08-27T18:00:00.000Z');
    cronM.mockImplementation((_cron, from) => new Date(from.getTime() + 3 * 60_000));
    expect(
      deriveGitSyncFreshness({ last_status: 'synced', last_synced_at: now - 10 * 60_000 }, '0 */3 * * * *', true, now),
    ).toEqual({
      status: 'degraded',
      measured_at: '2026-08-27T18:00:00.000Z',
      last_synced_at: '2026-08-27T17:50:00.000Z',
      age_ms: 10 * 60_000,
      cadence_ms: 3 * 60_000,
      stale_after_ms: 9 * 60_000,
      missed_intervals: 3,
      raw_last_status: 'synced',
      in_flight: null,
      // WI-10002019 — kept EXHAUSTIVE on purpose: this is the one assertion that pins the
      // whole returned contract, so a field added or renamed here has to be declared
      // rather than silently absorbed by a toMatchObject.
      scheduler: {
        status: 'not-firing',
        last_completed_at: '2026-08-27T17:50:00.000Z',
        age_ms: 10 * 60_000,
        cadence_ms: 3 * 60_000,
        stale_after_ms: 9 * 60_000,
        missed_intervals: 3,
        stalled_behind_in_flight_fire: false,
      },
      execution: {
        status: 'unknown',
        phase: null,
        started_at: null,
        age_ms: null,
        last_progress_at: null,
        progress_age_ms: null,
        holds_exclusive_locks: [],
        locks_reported: false,
        owner_reconciliation: null,
      },
      safe_to_restart: false,
      safe_to_restart_reason:
        'This row carries no git_sync_activity marker, so whether a fire is in flight is UNMEASURED — reported unsafe by default, because a wrong "safe" destroys in-flight work irrecoverably while a wrong "unsafe" only declines a restart.',
      warning:
        'No completed git-sync outcome for more than 3 scheduled intervals; the raw last_status may describe an older successful tick.',
    });
  });

  // EI-21807573331912223. The completed-outcome clock cannot see a fire that is STILL
  // RUNNING: last_synced_at only moves on completion, so for the first three intervals of
  // a wedged fire the row reads fresh AND green while every scheduled tick behind it is
  // skipping and nothing is being committed. Measured 2026-08-29: one fire held the lock
  // ~34 minutes against a 63-second healthy baseline.
  it('reports a fire wedged past the stale window as degraded even while the last COMPLETED outcome is still recent', () => {
    const now = Date.parse('2026-08-29T16:58:00.000Z');
    cronM.mockImplementation((_cron, from) => new Date(from.getTime() + 3 * 60_000));
    const verdict = deriveGitSyncFreshness(
      {
        last_status: 'synced',
        // Fresh by the completed-outcome clock on its own — 2 minutes, well inside the
        // 9-minute window. Only the in-flight leg can convict this row.
        last_synced_at: now - 2 * 60_000,
        git_sync_activity: { active: true, phase: 'local-sync', started_at: now - 34 * 60_000 },
      },
      '0 */3 * * * *',
      true,
      now,
    );
    expect(verdict).toMatchObject({
      status: 'degraded',
      age_ms: 2 * 60_000,
      raw_last_status: 'synced',
      in_flight: {
        active: true,
        phase: 'local-sync',
        started_at: '2026-08-29T16:24:00.000Z',
        age_ms: 34 * 60_000,
        long_running_age_ms: 34 * 60_000,
        last_progress_at: '2026-08-29T16:24:00.000Z',
        progress_age_ms: 34 * 60_000,
        stuck: true,
      },
    });
    const warning = String(verdict.warning);
    expect(warning).toContain("activity marker has been active for 34m (phase 'local-sync')");
    expect(warning).toContain('owner PID and exclusive lease have not both been proven stale');
    expect(warning).toContain('safe_to_restart is false');
    expect(warning).not.toContain('There IS a live process holding that lock');
    // WI-24822134605202882: a stale clock does not prove its recorded fire owner is dead.
    // The destructive action stays contraindicated until both PID and lock evidence agree.
    expect(verdict).toMatchObject({ execution: { status: 'stuck' }, safe_to_restart: false });
  });

  it('does not mark a long-running local-sync fire stuck while the writer heartbeat shows recent progress', () => {
    const now = Date.parse('2026-08-29T16:58:00.000Z');
    cronM.mockImplementation((_cron, from) => new Date(from.getTime() + 3 * 60_000));
    const verdict = deriveGitSyncFreshness(
      {
        last_status: 'synced',
        last_synced_at: now - 2 * 60_000,
        git_sync_activity: {
          active: true,
          phase: 'local-sync',
          started_at: now - 34 * 60_000,
          updated_at: now - 1 * 60_000,
        },
      },
      '0 */3 * * * *',
      true,
      now,
    );
    expect(verdict).toMatchObject({
      status: 'fresh',
      in_flight: {
        active: true,
        phase: 'local-sync',
        age_ms: 34 * 60_000,
        long_running_age_ms: 34 * 60_000,
        last_progress_at: '2026-08-29T16:57:00.000Z',
        progress_age_ms: 1 * 60_000,
        stuck: false,
      },
      warning: null,
    });
  });

  it('projects bounded Git command diagnostics for a live fire without argv or environment data', () => {
    const now = Date.parse('2026-08-29T16:58:00.000Z');
    cronM.mockImplementation((_cron, from) => new Date(from.getTime() + 3 * 60_000));
    const verdict = deriveGitSyncFreshness(
      {
        last_status: 'synced',
        last_synced_at: now - 10 * 60_000,
        git_sync_activity: {
          active: true,
          phase: 'local-sync',
          started_at: now - 5 * 60_000,
          updated_at: now - 15_000,
          owner_pid: 129472,
          workflow_id: 'git-sync-workflow-7',
          git_commands: {
            scope: 'local-sync-runner',
            active_count: 2,
            omitted_count: 0,
            active: [
              {
                id: 7,
                subcommand: 'commit-tree',
                cwd: '/repo/superproject',
                cwd_truncated: true,
                started_at: now - 20_000,
                argv: ['--private-argument'],
                env: { PRIVATE_TOKEN: 'active-secret' },
              },
              { id: 'invalid', cwd: '/repo/child', started_at: now - 1_000, argv: ['private'] },
            ],
            completed_count: 1,
            completed_omitted_count: 0,
            completed: [
              {
                id: 6,
                subcommand: 'status',
                cwd: '/repo/superproject',
                started_at: now - 2_000,
                completed_at: now - 1_500,
                duration_ms: 500,
                status: 'succeeded',
                exit_code: 0,
                env: { PRIVATE_TOKEN: 'completed-secret' },
              },
            ],
          },
        },
      },
      '0 */3 * * * *',
      true,
      now,
    );

    const execution = verdict.execution as Record<string, unknown>;
    expect(execution).toMatchObject({
      status: 'in-flight',
      owner_pid: 129472,
      workflow_id: 'git-sync-workflow-7',
      git_commands: {
        scope: 'local-sync-runner',
        active_count: 2,
        omitted_count: 1,
        active: [{
          id: 7,
          subcommand: 'commit-tree',
          cwd: '/repo/superproject',
          cwd_truncated: true,
          started_at: now - 20_000,
        }],
        completed_count: 1,
        completed_omitted_count: 0,
        completed: [{
          id: 6,
          subcommand: 'status',
          cwd: '/repo/superproject',
          started_at: now - 2_000,
          completed_at: now - 1_500,
          duration_ms: 500,
          status: 'succeeded',
          exit_code: 0,
        }],
      },
    });
    const projected = JSON.stringify(execution.git_commands);
    expect(projected).not.toContain('PRIVATE_TOKEN');
    expect(projected).not.toContain('private-argument');
    expect(projected).not.toContain('active-secret');
    expect(projected).not.toContain('completed-secret');
  });

  it('CONTROL: the same row WITHOUT the in-flight marker reads fresh — proving the check above convicts on the wedged fire, not on the clock', () => {
    const now = Date.parse('2026-08-29T16:58:00.000Z');
    cronM.mockImplementation((_cron, from) => new Date(from.getTime() + 3 * 60_000));
    expect(
      deriveGitSyncFreshness(
        { last_status: 'synced', last_synced_at: now - 2 * 60_000 },
        '0 */3 * * * *',
        true,
        now,
      ),
    ).toMatchObject({ status: 'fresh', in_flight: null, warning: null });
  });

  // WI-10002019 — the COMPOSITION defect. These two rows are deliberately a PAIR: they
  // carry the SAME `status:'degraded'` roll-up and the OPPOSITE correct action. That is
  // the whole bug — a reader deciding "can I restart git-sync?" from the composed scalar
  // gets the destructive answer on the row where it destroys a live sweep. Keeping both
  // halves makes the guard falsifiable in both directions: deriving safe_to_restart from
  // `status` (or from the scheduler leg) breaks the IDLE row, and dropping the execution
  // check breaks the IN-FLIGHT row. A single-row test would pass under either mutation.
  describe('WI-10002019: scheduler and execution legs are independent, and safe_to_restart follows execution alone', () => {
    const NOW = Date.parse('2026-08-29T16:58:00.000Z');
    const staleClock = { last_status: 'synced', last_synced_at: NOW - 30 * 60_000 };

    it('a STALE scheduler clock with a LIVE advancing fire is NOT safe to restart, however stale the clock looks', () => {
      cronM.mockImplementation((_cron, from) => new Date(from.getTime() + 3 * 60_000));
      const verdict = deriveGitSyncFreshness(
        {
          ...staleClock,
          // Advancing: progress 30s ago against a 9-minute window, so NOT stuck. The
          // completed-outcome clock is stale precisely BECAUSE this fire holds the lock.
          git_sync_activity: {
            active: true,
            phase: 'local-sync',
            started_at: NOW - 5 * 60_000,
            updated_at: NOW - 30_000,
          },
        },
        '0 */3 * * * *',
        true,
        NOW,
      );
      expect(verdict).toMatchObject({
        status: 'degraded',
        scheduler: { status: 'not-firing', stalled_behind_in_flight_fire: true },
        execution: { status: 'in-flight', phase: 'local-sync', age_ms: 5 * 60_000 },
        safe_to_restart: false,
      });
      // Asserted by phrase rather than by the whole string: the load-bearing property is
      // that an unresolved active marker keeps restart unsafe, not the exact prose.
      const warning = String(verdict.warning);
      expect(warning).toContain('an active marker remains');
      expect(warning).toContain('Owner liveness and lock state have not both been proven stale');
      expect(warning).toContain('Keep the restart verdict unsafe');
      expect(warning).not.toContain('the raw last_status may describe an older successful tick');
    });

    it('CALIBRATION: the same stale clock with NO fire running reads the same degraded status but IS safe to restart', () => {
      cronM.mockImplementation((_cron, from) => new Date(from.getTime() + 3 * 60_000));
      const verdict = deriveGitSyncFreshness(
        {
          ...staleClock,
          git_sync_activity: {
            active: false,
            phase: 'complete',
            started_at: NOW - 31 * 60_000,
            completed_at: NOW - 30 * 60_000,
          },
        },
        '0 */3 * * * *',
        true,
        NOW,
      );
      expect(verdict).toMatchObject({
        // Identical roll-up to the row above — which is exactly why the roll-up cannot
        // be the restart decision.
        status: 'degraded',
        scheduler: { status: 'not-firing', stalled_behind_in_flight_fire: false },
        execution: { status: 'idle' },
        safe_to_restart: true,
      });
      // Here the generic wording is CORRECT: the scheduler really has stopped.
      expect(String(verdict.warning)).toContain('the raw last_status may describe an older successful tick');
    });

    it('an UNMEASURED execution leg (no activity marker) reports unsafe, because a wrong "safe" is the irrecoverable one', () => {
      cronM.mockImplementation((_cron, from) => new Date(from.getTime() + 3 * 60_000));
      const verdict = deriveGitSyncFreshness(staleClock, '0 */3 * * * *', true, NOW);
      expect(verdict).toMatchObject({
        execution: { status: 'unknown', holds_exclusive_locks: [], locks_reported: false },
        safe_to_restart: false,
      });
      expect(String(verdict.safe_to_restart_reason)).toContain('UNMEASURED');
    });

    it('reports writer-named locks, and distinguishes "none reported" from "reported none"', () => {
      cronM.mockImplementation((_cron, from) => new Date(from.getTime() + 3 * 60_000));
      const withLocks = deriveGitSyncFreshness(
        {
          ...staleClock,
          git_sync_activity: {
            active: true,
            started_at: NOW - 60_000,
            updated_at: NOW - 10_000,
            locks: ['git-sync:papercusp', 'workspace:papercusp', 7],
          },
        },
        '0 */3 * * * *',
        true,
        NOW,
      );
      // The non-string entry is dropped rather than stringified — a lock name this
      // derivation cannot vouch for must not appear as one.
      expect(withLocks).toMatchObject({
        execution: {
          status: 'in-flight',
          holds_exclusive_locks: ['git-sync:papercusp', 'workspace:papercusp'],
          locks_reported: true,
        },
        safe_to_restart: false,
      });

      const withoutLocks = deriveGitSyncFreshness(
        { ...staleClock, git_sync_activity: { active: true, started_at: NOW - 60_000, updated_at: NOW - 10_000 } },
        '0 */3 * * * *',
        true,
        NOW,
      );
      // Same empty array, opposite meaning — which is why locks_reported exists.
      expect(withoutLocks).toMatchObject({
        execution: { holds_exclusive_locks: [], locks_reported: false },
      });
    });

    it('a paused routine reports an inactive scheduler leg without claiming its execution leg is idle', () => {
      cronM.mockImplementation((_cron, from) => new Date(from.getTime() + 3 * 60_000));
      const verdict = deriveGitSyncFreshness(
        {
          ...staleClock,
          git_sync_activity: { active: true, started_at: NOW - 60_000, updated_at: NOW - 10_000 },
        },
        '0 */3 * * * *',
        false,
        NOW,
      );
      // Pausing the SCHEDULER does not stop a fire already running, so the execution
      // leg — and therefore the restart verdict — is unaffected by the active flag.
      expect(verdict).toMatchObject({
        status: 'inactive',
        scheduler: { status: 'inactive' },
        execution: { status: 'in-flight' },
        safe_to_restart: false,
      });
    });

    // PERMANENT NEGATIVE CONTROL — tier-2 falsifiability, no tree mutation and so no
    // sweep race. It models the PRE-FIX READER, who had only the composed scalar and
    // read 'degraded' as "this routine is stalled, restart it". Kept in the file for
    // good: if anyone re-derives safe_to_restart from `status` (or from the scheduler
    // leg), the control and the real subject converge and this test goes red. The
    // calibration is built in — the control must produce the SAME verdict on both rows,
    // which is what proves it is faithful rather than trivially always-true.
    it('CONTROL: the composed scalar cannot tell a live fire from a stalled scheduler; the execution leg can', () => {
      cronM.mockImplementation((_cron, from) => new Date(from.getTime() + 3 * 60_000));
      const preFixReaderWouldRestart = (verdict: Record<string, unknown>): boolean =>
        verdict.status === 'degraded';

      const liveFire = deriveGitSyncFreshness(
        {
          ...staleClock,
          git_sync_activity: { active: true, started_at: NOW - 5 * 60_000, updated_at: NOW - 30_000 },
        },
        '0 */3 * * * *',
        true,
        NOW,
      );
      const stalledScheduler = deriveGitSyncFreshness(
        { ...staleClock, git_sync_activity: { active: false, completed_at: NOW - 30 * 60_000 } },
        '0 */3 * * * *',
        true,
        NOW,
      );

      // The defect, reproduced: one verdict, both rows, and on the first row it is the
      // action that drops the exclusive lock mid-write.
      expect(preFixReaderWouldRestart(liveFire)).toBe(true);
      expect(preFixReaderWouldRestart(stalledScheduler)).toBe(true);
      expect(liveFire.status).toBe(stalledScheduler.status);

      // The fix: the rows separate, and it is the destructive one that is refused.
      expect(liveFire.safe_to_restart).toBe(false);
      expect(stalledScheduler.safe_to_restart).toBe(true);
    });
  });

  it('does not convict a fire that is in flight but still INSIDE the stale window, nor a completed one', () => {
    const now = Date.parse('2026-08-29T16:58:00.000Z');
    cronM.mockImplementation((_cron, from) => new Date(from.getTime() + 3 * 60_000));
    expect(
      deriveGitSyncFreshness(
        {
          last_status: 'synced',
          last_synced_at: now - 2 * 60_000,
          git_sync_activity: { active: true, phase: 'local-sync', started_at: now - 4 * 60_000 },
        },
        '0 */3 * * * *',
        true,
        now,
      ),
    ).toMatchObject({ status: 'fresh', in_flight: { active: true, age_ms: 4 * 60_000, stuck: false } });

    // A COMPLETED marker carries a started_at from long ago; age must not be computed off
    // it, or every healthy row would convict itself the moment its last fire got old.
    expect(
      deriveGitSyncFreshness(
        {
          last_status: 'synced',
          last_synced_at: now - 2 * 60_000,
          git_sync_activity: {
            active: false,
            phase: 'complete',
            started_at: now - 34 * 60_000,
            completed_at: now - 2 * 60_000,
          },
        },
        '0 */3 * * * *',
        true,
        now,
      ),
    ).toMatchObject({
      status: 'fresh',
      in_flight: { active: false, phase: 'complete', started_at: null, age_ms: null, stuck: false },
    });
  });

  it('keeps a recent completed git-sync outcome fresh and reports missing proof as unknown', () => {
    const now = Date.parse('2026-08-27T18:00:00.000Z');
    cronM.mockImplementation((_cron, from) => new Date(from.getTime() + 3 * 60_000));
    expect(
      deriveGitSyncFreshness({ last_status: 'nothing', last_synced_at: now - 2 * 60_000 }, '0 */3 * * * *', true, now),
    ).toMatchObject({ status: 'fresh', missed_intervals: 0, raw_last_status: 'nothing', warning: null });
    expect(deriveGitSyncFreshness({ last_status: 'synced' }, '0 */3 * * * *', true, now)).toMatchObject({
      status: 'unknown',
      last_synced_at: null,
      raw_last_status: 'synced',
    });
  });

  describe('EI-24822134605202882 per-fire owner reconciliation', () => {
    const readFreshness = async (identity: Record<string, unknown>) => {
      const now = Date.now();
      cronM.mockImplementation((_cron, from) => new Date(from.getTime() + 3 * 60_000));
      sqlMock.mockResolvedValue([
        gitSyncRoutineRow({
          last_status: 'synced',
          last_synced_at: now - 30 * 60_000,
          git_sync_activity: {
            active: true,
            phase: 'local-sync',
            started_at: now - 20 * 60_000,
            updated_at: now - 10 * 60_000,
            ...identity,
          },
        }),
      ]);
      const result = body(
        await listTool.handler(
          { installSlug: 'home-harness', name: 'git-sync' } as never,
          { role: 'su' } as never,
        ),
      ) as { routines: Array<{ health: { git_sync_freshness: any } }> };
      return result.routines[0]!.health.git_sync_freshness;
    };

    it('calls an active marker stale only when its dead owner has no exclusive resource lease', async () => {
      const pid = 9_876_543;
      const owner = `system:git-sync:${pid}:fire-1`;
      deadPidMock.mockReturnValue(true);
      resourceQueueMock.mockResolvedValue({ holders: [], draining: false, queue: [] });

      const freshness = await readFreshness({ owner, owner_pid: pid });

      expect(deadPidMock).toHaveBeenCalledWith(pid);
      expect(resourceQueueMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ resource: 'git-sync:home-harness' }),
      );
      expect(freshness).toMatchObject({
        execution: {
          status: 'idle',
          owner_reconciliation: {
            status: 'stale',
            owner_pid: pid,
            lock_state: 'absent',
            matching_owner_lock: false,
          },
        },
        in_flight: { active: false, stale_marker: true },
        safe_to_restart: true,
      });
    });

    it('keeps an inactive marker unsafe while a newer exclusive resource lease remains', async () => {
      const pid = 9_876_548;
      const owner = 'system:git-sync:' + pid + ':older-fire';
      resourceQueueMock.mockClear();
      resourceQueueMock.mockResolvedValue({
        holders: [{ owner: 'system:git-sync:' + (pid + 1) + ':newer-fire', mode: 'exclusive', status: 'held' }],
        draining: false,
        queue: [],
      });

      const freshness = await readFreshness({ active: false, owner, owner_pid: pid });

      expect(resourceQueueMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ resource: 'git-sync:home-harness' }),
      );
      expect(freshness).toMatchObject({
        execution: {
          status: 'unknown',
          owner_reconciliation: {
            status: 'unverified',
            owner_pid: pid,
            lock_state: 'held',
            matching_owner_lock: false,
          },
        },
        safe_to_restart: false,
      });
    });

    it('allows an inactive marker to be idle only after confirming no exclusive resource lease', async () => {
      const pid = 9_876_549;
      const owner = 'system:git-sync:' + pid + ':completed-fire';
      resourceQueueMock.mockClear();
      resourceQueueMock.mockResolvedValue({ holders: [], draining: false, queue: [] });

      const freshness = await readFreshness({ active: false, owner, owner_pid: pid });

      expect(resourceQueueMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ resource: 'git-sync:home-harness' }),
      );
      expect(freshness).toMatchObject({
        execution: { status: 'idle', owner_reconciliation: null },
        safe_to_restart: true,
      });
    });

    it('keeps an inactive marker unsafe when the resource lease cannot be read', async () => {
      const pid = 9_876_550;
      const owner = 'system:git-sync:' + pid + ':older-fire';
      resourceQueueMock.mockClear();
      resourceQueueMock.mockRejectedValue(new Error('resource queue unavailable'));

      const freshness = await readFreshness({ active: false, owner, owner_pid: pid });

      expect(freshness).toMatchObject({
        execution: {
          status: 'unknown',
          owner_reconciliation: {
            status: 'unverified',
            owner_pid: pid,
            lock_state: 'unknown',
            matching_owner_lock: null,
          },
        },
        safe_to_restart: false,
      });
      expect(String(freshness.safe_to_restart_reason)).toContain('resource lock could not be read');
    });

    it('keeps a definitively dead marker unsafe while either matching or other exclusive lease remains', async () => {
      const pid = 9_876_544;
      const owner = `system:git-sync:${pid}:fire-2`;
      for (const leaseOwner of [owner, `system:git-sync:${pid + 1}:newer-fire`]) {
        deadPidMock.mockClear();
        deadPidMock.mockReturnValue(true);
        resourceQueueMock.mockClear();
        resourceQueueMock.mockResolvedValue({
          holders: [{ owner: leaseOwner, mode: 'exclusive', status: 'held' }],
          draining: false,
          queue: [],
        });

        const freshness = await readFreshness({ owner, owner_pid: pid });

        expect(freshness.execution.owner_reconciliation).toMatchObject({
          status: 'unverified',
          owner_pid: pid,
          lock_state: 'held',
          matching_owner_lock: leaseOwner === owner,
        });
        expect(freshness.safe_to_restart).toBe(false);
      }
    });

    it('keeps missing or mismatched per-fire identity unsafe without probing the PID or lock queue', async () => {
      const pid = 9_876_545;
      const malformedIdentities = [
        { owner_pid: pid },
        { owner: `system:git-sync:${pid}:fire-3` },
        { owner: `system:git-sync:${pid + 1}:fire-3`, owner_pid: pid },
      ];
      for (const identity of malformedIdentities) {
        deadPidMock.mockClear();
        resourceQueueMock.mockClear();

        const freshness = await readFreshness(identity);

        expect(freshness.execution.owner_reconciliation).toMatchObject({
          status: 'unverified',
          lock_state: 'unknown',
          matching_owner_lock: null,
        });
        expect(freshness.safe_to_restart).toBe(false);
        expect(deadPidMock).not.toHaveBeenCalled();
        expect(resourceQueueMock).not.toHaveBeenCalled();
      }
    });

    it('keeps a live or unprovable PID unsafe and does not infer that the resource lease is absent', async () => {
      const pid = 9_876_546;
      deadPidMock.mockReturnValue(false);

      const freshness = await readFreshness({ owner: `system:git-sync:${pid}:fire-4`, owner_pid: pid });

      expect(freshness.execution.owner_reconciliation).toMatchObject({
        status: 'unverified',
        owner_pid: pid,
        lock_state: 'not-checked',
        matching_owner_lock: null,
      });
      expect(freshness.safe_to_restart).toBe(false);
      expect(resourceQueueMock).not.toHaveBeenCalled();
    });

    it('keeps the marker unsafe when the dead owner is known but the resource queue cannot be read', async () => {
      const pid = 9_876_547;
      deadPidMock.mockReturnValue(true);
      resourceQueueMock.mockRejectedValue(new Error('resource queue unavailable'));

      const freshness = await readFreshness({ owner: `system:git-sync:${pid}:fire-5`, owner_pid: pid });

      expect(freshness.execution.owner_reconciliation).toMatchObject({
        status: 'unverified',
        owner_pid: pid,
        lock_state: 'unknown',
        matching_owner_lock: null,
      });
      expect(freshness.safe_to_restart).toBe(false);
    });
  });

  // EI-21807573331912223. This test previously asserted `last_status: 'synced'` on a row
  // the tool had ALREADY judged degraded — i.e. it pinned the bug in place. A sibling that
  // disagrees is not a fix: git_sync_freshness carried the correct verdict throughout the
  // 2026-08-29 incident and simply was not the field anyone read.
  it('OVERRIDES the headline last_status with the derived verdict, preserving the writer value', async () => {
    const now = Date.now();
    cronM.mockImplementation((_cron, from) => new Date(from.getTime() + 3 * 60_000));
    sqlMock.mockResolvedValue([
      {
        install_slug: 'home-harness',
        name: 'git-sync',
        trigger_kind: 'cron',
        trigger_config: { cron: '0 */3 * * * *' },
        target_role: 'system:git-sync',
        active: true,
        next_fire_at: new Date(now + 60_000),
        last_fired_at: new Date(now - 60_000),
        group_slug: null,
        metadata: { last_status: 'synced', last_synced_at: now - 10 * 60_000, consecutive_error_ticks: 0 },
      },
    ]);

    const b = body(
      await listTool.handler({ installSlug: 'home-harness', name: 'git-sync' } as never, { role: 'su' } as never),
    );
    expect(b.routines[0].health).toMatchObject({
      last_status: 'degraded (derived — see git_sync_freshness; raw: synced)',
      consecutive_error_ticks: 0,
      git_sync_freshness: {
        status: 'degraded',
        raw_last_status: 'synced',
        missed_intervals: 3,
      },
    });
    // The whole point of the override: the headline can no longer be read as success.
    expect(b.routines[0].health.last_status).not.toBe('synced');
  });

  // EI-21900560691158244. git-sync WRITES last_skipped_paths/last_skip_reason/last_oversized
  // specifically so a lock holder can tell their file is stranded; the healthOf allowlist
  // dropped all three, so the one reader agents call discarded the evidence written for them.
  it('surfaces the excluded paths the writer records, with TRUE counts and a bounded sample', () => {
    const skipped = Array.from({ length: 14 }, (_, i) => `packages/app/file-${i}.ts`);
    const out = deriveGitSyncExclusions({
      last_status: 'synced',
      last_skip_reason: 'locked-path',
      last_skipped_at: Date.parse('2026-08-30T17:30:00.000Z'),
      last_skipped_paths: skipped,
      last_oversized: ['superproject:artifacts/huge.bin'],
    });
    expect(out).toMatchObject({
      skip_reason: 'locked-path',
      skipped_at: '2026-08-30T17:30:00.000Z',
      // The COUNT is the true total even though the sample is capped — a bounded
      // measurement must never be readable as the whole population.
      skipped_count: 14,
      skipped_sample_truncated: true,
      oversized_count: 1,
      oversized_sample: ['superproject:artifacts/huge.bin'],
      oversized_sample_truncated: false,
    });
    expect((out.skipped_sample as string[])).toHaveLength(10);
    expect(out.warning).toContain('14 path(s) excluded');
    expect(out.warning).toContain('locked-path');
  });

  // WI-6554700010008512: a skip tick restamps last_skipped_at / last_skip_reason (shared with the
  // stall and staleness alarms) but no longer clears the sweep's paths
  // (SKIP_TICK_KEEPS_SWEEP_EXCLUSIONS), so the time and reason reported BESIDE those paths must
  // come from the sweep that wrote them — never from a later tick.
  describe('WI-6554700010008512: sweep paths keep the sweep stamp across skip ticks', () => {
    const sweepAt = Date.parse('2026-10-11T09:00:00.000Z');
    const tickAt = Date.parse('2026-10-11T09:45:00.000Z');

    it('reports the sweep time and reason, not the later skip tick, beside the sweep paths', () => {
      const out = deriveGitSyncExclusions({
        last_status: 'skipped',
        last_skip_reason: 'held_exclusive',
        last_skipped_at: tickAt,
        last_exclusions_at: sweepAt,
        last_skipped_paths: ['superproject:packages/app/legacy.ts'],
      });
      expect(out).toMatchObject({
        skipped_at: '2026-10-11T09:00:00.000Z',
        skip_reason: 'locked-path',
        skipped_count: 1,
        sweep_at: '2026-10-11T09:00:00.000Z',
      });
      expect(out.warning).not.toContain('held_exclusive');
    });

    it('trusts the recorded reason when the sweep itself wrote it', () => {
      const out = deriveGitSyncExclusions({
        last_status: 'synced',
        last_skip_reason: 'migration-reservation',
        last_skipped_at: sweepAt,
        last_exclusions_at: sweepAt,
        last_skipped_paths: ['superproject:packages/app/legacy.ts'],
      });
      expect(out).toMatchObject({ skipped_at: '2026-10-11T09:00:00.000Z', skip_reason: 'migration-reservation' });
    });

    it('still reports the skip tick itself when the sweep left no paths', () => {
      const out = deriveGitSyncExclusions({
        last_status: 'skipped',
        last_skip_reason: 'held_exclusive',
        last_skipped_at: tickAt,
        last_exclusions_at: sweepAt,
        last_skipped_paths: [],
      });
      expect(out).toMatchObject({
        skipped_at: '2026-10-11T09:45:00.000Z',
        skip_reason: 'held_exclusive',
        skipped_count: 0,
      });
    });
  });

  // WI-10006505: the fixture above uses strings, but git-sync-action persists GitSyncSkippedPath
  // OBJECTS. `stringList` dropped every one, so the real row always read skipped_count: 0, and a
  // migration-guard deferral was labelled with the writer's hard-coded 'locked-path'.
  it('counts the OBJECT entries the writer actually persists and names each guard reason', () => {
    const sweepAt = Date.now();
    const out = deriveGitSyncExclusions({
      last_status: 'synced',
      last_skip_reason: 'locked-path',
      last_exclusions_at: sweepAt,
      last_synced_at: sweepAt,
      last_skipped_paths: [
        { scope: 'superproject', path: 'a.ts', owner: 'su-a', intent: 'edit a' },
        { scope: 'superproject', path: 'b.ts', reason: 'migration-dependency-fence', detail: 'fenced' },
        { scope: 'libs/papercusp', path: 'libs/db/sql/1234-x.sql', reason: 'migration-reservation', detail: 'r' },
      ],
    });
    expect(out).toMatchObject({
      skipped_count: 3,
      skipped_sample: ['superproject:a.ts', 'superproject:b.ts', 'libs/papercusp:libs/db/sql/1234-x.sql'],
      skip_reason: 'locked-path, migration-dependency-fence, migration-reservation',
    });
    expect(out.warning).toContain('3 path(s) excluded');
    expect(out.warning).toContain('release the corresponding file lock(s)');
    expect(out.warning).toContain('next-migration.mjs');
  });

  it('does not tell a migration-guard-only deferral to release file locks', () => {
    const out = deriveGitSyncExclusions({
      last_status: 'synced',
      last_skip_reason: 'locked-path',
      last_skipped_paths: [{ scope: 'superproject', path: 'b.ts', reason: 'migration-dependency-fence', detail: 'f' }],
    });
    expect(out.skip_reason).toBe('migration-dependency-fence');
    expect(out.warning).not.toContain('release the corresponding file lock(s)');
  });

  it('marks a degraded skip-only sweep stale and suppresses remedies for its old paths', () => {
    const now = Date.parse('2026-10-23T01:00:00.000Z');
    const sweepAt = now - 4 * 60 * 60_000;
    const out = deriveGitSyncExclusions(
      {
        last_status: 'synced',
        last_skip_reason: 'locked-path',
        last_skipped_at: sweepAt,
        last_exclusions_at: sweepAt,
        last_synced_at: sweepAt,
        last_skipped_paths: [
          { scope: 'superproject', path: 'packages/app/old.ts', owner: 'su-a', intent: 'edit old.ts' },
        ],
      },
      { status: 'degraded' },
      now,
    );

    expect(out).toMatchObject({
      sweep_stale: true,
      skipped_count: 1,
      skipped_sample: ['superproject:packages/app/old.ts'],
    });
    expect(out.warning).toContain('stale or unknown sweep vintage');
    expect(out.warning).toContain('Wait for a fresh completed sweep');
    expect(out.warning).not.toContain('release the corresponding file lock(s)');
    expect(out.warning).not.toContain("completionAuthority:'proposed'");
  });

  it('treats an expired, stamp-matched exclusion sweep as historical and non-actionable', () => {
    const now = Date.parse('2026-10-23T01:00:00.000Z');
    const sweepAt = now - 2 * 60 * 60_000;
    const out = deriveGitSyncExclusions(
      {
        last_status: 'synced',
        last_skip_reason: 'locked-path',
        last_skipped_at: sweepAt,
        last_exclusions_at: sweepAt,
        last_synced_at: sweepAt,
        last_skipped_paths: [
          {
            scope: 'superproject',
            path: 'packages/app/old.ts',
            owner: 'su-a',
            intent: TURN_HOLD_INTENT,
            heldSince: new Date(sweepAt - 10 * 60_000).toISOString(),
          },
        ],
      },
      { status: 'fresh' },
      now,
    );

    expect(out).toMatchObject({
      sweep_stale: true,
      sweep_age_ms: 2 * 60 * 60_000,
      skipped_count: 1,
      turn_holds: { count: 1 },
    });
    expect(out.warning).toContain('stale or unknown sweep vintage');
    expect(out.warning).toContain('Wait for a fresh completed sweep');
    expect(out.warning).not.toContain('use locks:acquire to hold a change across turns');
    expect(out.warning).not.toContain("completionAuthority:'proposed'");
  });

  it('treats legacy skip records without an exclusion stamp as stale even when freshness is recent', () => {
    const now = Date.parse('2026-10-23T01:00:00.000Z');
    const out = deriveGitSyncExclusions(
      {
        last_status: 'synced',
        last_skip_reason: 'locked-path',
        last_skipped_at: now - 30 * 60_000,
        last_synced_at: now - 60_000,
        last_skipped_paths: ['packages/app/legacy.ts'],
      },
      { status: 'fresh' },
      now,
    );

    expect(out).toMatchObject({ sweep_stale: true, skipped_count: 1 });
    expect(out.warning).toContain('stale or unknown sweep vintage');
    expect(out.warning).not.toContain('release the corresponding file lock(s)');
  });

  it('keeps byte-exclusion remedies gated by whole-sweep freshness', () => {
    const now = Date.parse('2026-10-23T01:00:00.000Z');
    const sweepAt = now - 60_000;
    const metadata = {
      last_status: 'synced',
      last_exclusions_at: sweepAt,
      last_synced_at: sweepAt,
      last_oversized: ['superproject:artifacts/huge.bin'],
    };

    const stale = deriveGitSyncExclusions(metadata, { status: 'degraded' }, now);
    expect(stale).toMatchObject({ sweep_stale: true, oversized_count: 1 });
    expect(stale.warning).toContain('byte-exclusion data is from a stale or unknown sweep vintage');
    expect(stale.warning).not.toContain('gitignore or remove the per-file oversized blob(s)');

    const fresh = deriveGitSyncExclusions(metadata, { status: 'fresh' }, now);
    expect(fresh).toMatchObject({ sweep_stale: false, oversized_count: 1 });
    expect(fresh.warning).toContain('gitignore or remove the per-file oversized blob(s)');
  });

  // git-sync-turn-scoped-commit-hold-2026-10-11 P-003: a turn hold is not a lock. It is
  // reported with its holder and age, and its holder is never told to locks:release.
  it('reports turn-held paths with holder and age, and never tells their holder to release a lock', () => {
    const now = Date.parse('2026-10-11T05:00:00.000Z');
    const out = deriveGitSyncExclusions(
      {
        last_status: 'synced',
        last_skip_reason: 'locked-path',
        last_exclusions_at: now,
        last_synced_at: now,
        last_skipped_paths: [
          { scope: 'superproject', path: 'a.ts', owner: 'su-a', intent: TURN_HOLD_INTENT, heldSince: '2026-10-11T04:50:00.000Z' },
          { scope: 'superproject', path: 'b.ts', owner: 'su-a', intent: TURN_HOLD_INTENT },
          { scope: 'superproject', path: 'c.ts', owner: 'su-r', intent: RESTRICTED_HOLD_INTENT },
        ],
      },
      null,
      now,
    );
    expect(out.skip_reason).toBe('turn-hold, restricted-hold');
    expect(out.turn_holds).toEqual({
      count: 2,
      holders: ['su-a'],
      sample: [
        { path: 'superproject:a.ts', holder: 'su-a', held_since: '2026-10-11T04:50:00.000Z', age_sec: 600 },
        { path: 'superproject:b.ts', holder: 'su-a', held_since: null, age_sec: null },
      ],
      sample_truncated: false,
      max_age_sec: 3600,
    });
    expect(out.warning).toContain("commit on the first sweep after their editor's turn ends");
    expect(out.warning).toContain('personal disclosure');
    expect(out.warning).not.toContain('release the corresponding file lock(s)');
  });

  it('still tells a real lock holder to release, beside a turn hold', () => {
    const sweepAt = Date.now();
    const out = deriveGitSyncExclusions({
      last_status: 'synced',
      last_exclusions_at: sweepAt,
      last_synced_at: sweepAt,
      last_skipped_paths: [
        { scope: 'superproject', path: 'a.ts', owner: 'su-a', intent: 'edit a' },
        { scope: 'superproject', path: 'b.ts', owner: 'su-b', intent: TURN_HOLD_INTENT },
      ],
    });
    expect(out.skip_reason).toBe('locked-path, turn-hold');
    expect(out.warning).toContain('release the corresponding file lock(s)');
    expect((out.turn_holds as { count: number }).count).toBe(1);
  });

  // The negative control for the test above: the block must still be EMITTED when nothing
  // was excluded, so "nothing was skipped" cannot be confused with "this reader does not
  // report skips" — the exact silence-equals-absence shape this field repairs.
  it('emits the exclusions block with zero counts and a null warning when nothing was excluded', () => {
    const out = deriveGitSyncExclusions({ last_status: 'synced', last_synced_at: Date.now() });
    expect(out).toMatchObject({
      skip_reason: null,
      skipped_at: null,
      skipped_count: 0,
      skipped_sample: [],
      skipped_sample_truncated: false,
      oversized_count: 0,
      oversized_sample: [],
      warning: null,
    });
    // Present-and-zero, never absent: an omitted block is unreadable as a measurement.
    expect(out).toHaveProperty('skipped_count');
  });

  // The wiring test. The derivation above can be perfectly correct and still ship inert if
  // the tool never calls it — which is precisely how the original defect survived: the
  // writer was right, the reader's allowlist silently dropped it.
  it('includes git_sync_exclusions in the health the TOOL actually returns', async () => {
    const now = Date.now();
    cronM.mockImplementation((_cron, from) => new Date(from.getTime() + 3 * 60_000));
    sqlMock.mockResolvedValue([
      {
        install_slug: 'home-harness',
        name: 'git-sync',
        trigger_kind: 'cron',
        trigger_config: { cron: '0 */3 * * * *' },
        target_role: 'system:git-sync',
        active: true,
        next_fire_at: new Date(now + 60_000),
        last_fired_at: new Date(now - 60_000),
        group_slug: null,
        metadata: {
          // A HEALTHY headline and a fresh clock — the case the old reader rendered as
          // unqualified success while the holder's file sat uncommitted.
          last_status: 'synced',
          last_synced_at: now - 30_000,
          last_skip_reason: 'locked-path',
          last_skipped_at: now - 30_000,
          last_skipped_paths: ['packages/operator-core/lib/mine.ts'],
        },
      },
    ]);

    const b = body(
      await listTool.handler({ installSlug: 'home-harness', name: 'git-sync' } as never, { role: 'su' } as never),
    );
    expect(b.routines[0].health.last_status).toBe('synced');
    expect(b.routines[0].health.git_sync_freshness.status).toBe('fresh');
    // Everything reads healthy — and the excluded path is now visible anyway.
    expect(b.routines[0].health.git_sync_exclusions).toMatchObject({
      skip_reason: 'locked-path',
      skipped_count: 1,
      skipped_sample: ['packages/operator-core/lib/mine.ts'],
    });
    expect(b.routines[0].health.git_sync_exclusions.warning).toContain('last completed sweep');
  });

  it.each([0, 8168])('surfaces content-error totals and full-evidence reference beside a preview (%i omitted)', async (omitted) => {
    const now = Date.now();
    cronM.mockImplementation((_cron, from) => new Date(from.getTime() + 3 * 60_000));
    sqlMock.mockResolvedValue([
      {
        install_slug: 'home-harness',
        name: 'git-sync',
        trigger_kind: 'cron',
        trigger_config: { cron: '0 */3 * * * *' },
        target_role: 'system:git-sync',
        active: true,
        next_fire_at: new Date(now + 60_000),
        last_fired_at: new Date(now - 60_000),
        group_slug: null,
        metadata: {
          last_status: 'quarantined',
          last_synced_at: now - 30_000,
          consecutive_content_error_ticks: 1,
          last_content_errors: ['root/docs/evidence/bad.json [identity-leak]'],
          last_content_error_count: omitted + 1,
          last_content_errors_omitted: omitted,
          last_content_errors_artifact: 'git-sync/content-errors/sha256.json',
          last_content_error_signature: 'stable-file-detector-signature',
        },
      },
    ]);

    const b = body(
      await listTool.handler({ installSlug: 'home-harness', name: 'git-sync' } as never, { role: 'su' } as never),
    );
    expect(b.routines[0].health.consecutive_content_error_ticks).toBe(1);
    expect(b.routines[0].health.last_content_errors).toEqual(['root/docs/evidence/bad.json [identity-leak]']);
    expect(b.routines[0].health.last_content_error_signature).toBe('stable-file-detector-signature');
    expect(b.routines[0].health).toMatchObject({
      last_content_error_count: omitted + 1,
      last_content_errors_omitted: omitted,
      last_content_errors_artifact: 'git-sync/content-errors/sha256.json',
    });
  });

  it('clips a huge legacy content-error signature while preserving remediation fields', async () => {
    const now = Date.now();
    const hugeSignature = Array.from({ length: 20_000 }, (_, index) =>
      'superproject\u001fdocs/file-' + index + '.md\u001fmdx',
    ).join('\u001e');
    cronM.mockImplementation((_cron, from) => new Date(from.getTime() + 3 * 60_000));
    sqlMock.mockResolvedValue([
      {
        install_slug: 'home-harness',
        name: 'git-sync',
        trigger_kind: 'cron',
        trigger_config: { cron: '0 */3 * * * *' },
        target_role: 'system:git-sync',
        active: true,
        next_fire_at: new Date(now + 60_000),
        last_fired_at: new Date(now - 60_000),
        group_slug: null,
        metadata: {
          last_status: 'quarantined',
          last_synced_at: now - 30_000,
          consecutive_content_error_ticks: 3,
          last_content_errors: ['root/docs/evidence/bad.json [identity-leak]'],
          last_content_error_count: 20_001,
          last_content_errors_omitted: 20_000,
          last_content_errors_artifact: 'git-sync/content-errors/sha256.json',
          last_content_error_signature: hugeSignature,
        },
      },
    ]);

    const raw = body(
      await listTool.handler({ installSlug: 'home-harness', name: 'git-sync' } as never, { role: 'su' } as never),
    );
    expect(raw.routines[0].health.last_content_error_signature.length).toBeGreaterThan(4_800);
    const b = listTool.shape!.trimmed!({
      count: 1,
      routines: [{
        ...raw.routines[0],
        health: {
          consecutive_content_error_ticks: raw.routines[0].health.consecutive_content_error_ticks,
          last_content_error_signature: raw.routines[0].health.last_content_error_signature,
          last_content_error_count: raw.routines[0].health.last_content_error_count,
          last_content_errors_omitted: raw.routines[0].health.last_content_errors_omitted,
          last_content_errors_artifact: raw.routines[0].health.last_content_errors_artifact,
        },
      }],
    }, { args: {} } as never) as {
      routines: Array<{ health: Record<string, unknown> }>;
    };
    const health = b.routines[0].health;
    const signature = health.last_content_error_signature as string;
    expect(signature.length).toBeLessThanOrEqual(1_000);
    expect(signature).toContain('[TRUNCATED +');
    expect(health).toMatchObject({
      consecutive_content_error_ticks: 3,
      last_content_error_count: 20_001,
      last_content_errors_omitted: 20_000,
      last_content_errors_artifact: 'git-sync/content-errors/sha256.json',
    });
    expect(JSON.stringify(health).length).toBeLessThanOrEqual(2_600);
    expect(JSON.stringify(b.routines).length).toBeLessThanOrEqual(4_200);
  });

  it('surfaces the git-sync head_sha through the callable health reader', async () => {
    const now = Date.now();
    cronM.mockImplementation((_cron, from) => new Date(from.getTime() + 3 * 60_000));
    sqlMock.mockResolvedValue([
      {
        install_slug: 'home-harness',
        name: 'git-sync',
        trigger_kind: 'cron',
        trigger_config: { cron: '0 */3 * * * *' },
        target_role: 'system:git-sync',
        active: true,
        next_fire_at: new Date(now + 60_000),
        last_fired_at: new Date(now - 60_000),
        group_slug: 'git-sync',
        metadata: {
          head_sha: 'abc123',
          last_status: 'synced',
          last_synced_at: now - 30_000,
        },
      },
    ]);

    const b = body(
      await listTool.handler({ installSlug: 'home-harness', name: 'git-sync' } as never, { role: 'su' } as never),
    );
    expect(b.routines[0].health).toMatchObject({ head_sha: 'abc123' });
  });

  it('leaves the headline last_status untouched when the derived verdict is not degraded', async () => {
    const now = Date.now();
    cronM.mockImplementation((_cron, from) => new Date(from.getTime() + 3 * 60_000));
    sqlMock.mockResolvedValue([
      {
        install_slug: 'home-harness',
        name: 'git-sync',
        trigger_kind: 'cron',
        trigger_config: { cron: '0 */3 * * * *' },
        target_role: 'system:git-sync',
        active: true,
        next_fire_at: new Date(now + 60_000),
        last_fired_at: new Date(now - 60_000),
        group_slug: null,
        metadata: { last_status: 'synced', last_synced_at: now - 60_000 },
      },
    ]);

    const b = body(
      await listTool.handler({ installSlug: 'home-harness', name: 'git-sync' } as never, { role: 'su' } as never),
    );
    expect(b.routines[0].health).toMatchObject({
      last_status: 'synced',
      git_sync_freshness: { status: 'fresh' },
    });
  });

  it('does not touch last_status on a NON-git-sync routine — the override is scoped to the row that earned it', async () => {
    const now = Date.now();
    sqlMock.mockResolvedValue([
      {
        install_slug: 'home-harness',
        name: 'green-checkpoint',
        trigger_kind: 'cron',
        trigger_config: { cron: '0 0 * * * *' },
        target_role: 'system:green-checkpoint',
        active: true,
        next_fire_at: new Date(now + 60_000),
        last_fired_at: new Date(now - 10 * 60 * 60_000),
        group_slug: null,
        metadata: { last_status: 'synced' },
      },
    ]);

    const b = body(await listTool.handler({ installSlug: 'home-harness' } as never, { role: 'su' } as never));
    expect(b.routines[0].health).toMatchObject({ last_status: 'synced' });
    expect(b.routines[0].health.git_sync_freshness).toBeUndefined();
  });

  it('maps rows (cron from trigger_config, iso timestamps)', async () => {
    sqlMock.mockResolvedValue([
      {
        install_slug: 'home-harness',
        name: 'git-sync',
        trigger_kind: 'cron',
        trigger_config: { cron: '0 */10 * * * *' },
        target_role: 'system:git-sync',
        active: true,
        next_fire_at: new Date('2030-01-01T00:00:00Z'),
        last_fired_at: null,
      },
    ]);
    const b = body(await listTool.handler({} as never, { role: 'su' } as never));
    expect(b.count).toBe(1);
    expect(b.routines[0]).toMatchObject({ name: 'git-sync', cron: '0 */10 * * * *', active: true, lastFiredAt: null });
  });

  it('projects the measured acceptance backlog on the paused grading routine', async () => {
    sqlMock
      .mockResolvedValueOnce([
        {
          install_slug: 'home-harness',
          name: 'acceptance-grading-sweep',
          trigger_kind: 'cron',
          trigger_config: { cron: null },
          target_role: 'system:acceptance-grading-sweep',
          active: false,
          next_fire_at: null,
          last_fired_at: new Date('2026-09-15T16:04:31.763Z'),
          group_slug: null,
          metadata: { pause: { reason: 'owner paused background LLM spend', pausedAtMs: Date.parse('2026-09-15T16:04:03.666Z') } },
        },
      ])
      .mockResolvedValueOnce([{ depth: '218', oldest_plan_updated_at: new Date('2026-08-31T16:37:20.000Z') }]);
    const b = body(await listTool.handler({ name: 'acceptance-grading-sweep' } as never, { role: 'su' } as never));
    expect(b.routines[0].acceptanceBacklog).toEqual({
      depth: 218,
      oldestPlanUpdatedAt: '2026-08-31T16:37:20.000Z',
    });
  });

  it('accepts harness as a compatibility alias for installSlug and rejects conflicting filters', async () => {
    expect(listTool.args.safeParse({ harness: 'papercusp' }).success).toBe(true);
    expect(listTool.args.safeParse({ installSlug: 'papercusp', harness: 'papercusp' }).success).toBe(true);
    expect(listTool.args.safeParse({ installSlug: 'papercusp', harness: 'sidestage' }).success).toBe(false);

    await listTool.handler({ harness: 'papercusp' } as never, { role: 'su' } as never);
    expect(sqlMock.mock.calls.flat()).toContain('papercusp');
  });

  /*
   * EI-20206183390542424 — `limit` was REJECTED here while every sibling list surface
   * (work_items:list, issues:list, and locks:list as of 2026-09-05) accepts it.
   *
   * Measured in harness_shared.tool_invocations: 29 calls from 23 DISTINCT agents passed
   * `limit` to this tool and got invalid_args — the single largest rejected-key cluster
   * on it, still firing the day this was written. The tool's own truncation notice told
   * callers to "narrow with installSlug/name/group, rollup:true" while omitting the one
   * verb they actually reached for, and the CAP=60 shape proved the capability already
   * existed — callers simply had no way to ask for less.
   *
   * The contract that makes a bounded read safe is the second assertion, not the first:
   * `limit` narrows routines[] ONLY and `count` keeps the TRUE total. Without that, a
   * narrowed read is indistinguishable from a genuinely smaller fleet — the same
   * bounded-measurement-read-as-a-verdict failure this file already guards elsewhere.
   */
  it('accepts limit, bounds routines[] by it, and keeps count the true total', async () => {
    expect(listTool.args.safeParse({ limit: 2 }).success).toBe(true);
    expect(listTool.args.safeParse({ limit: 0 }).success).toBe(false);
    expect(listTool.args.safeParse({ limit: 501 }).success).toBe(false);

    const row = (name: string) => ({
      install_slug: 'home-harness',
      name,
      trigger_kind: 'cron',
      trigger_config: { cron: '0 * * * * *' },
      target_role: 'system:noop',
      active: true,
      next_fire_at: null,
      last_fired_at: null,
    });
    sqlMock.mockResolvedValue([row('a'), row('b'), row('c')]);

    const bounded = body(await listTool.handler({ limit: 2 } as never, { role: 'su' } as never));
    expect(bounded.routines).toHaveLength(2);
    expect(bounded.routines.map((r: { name: string }) => r.name)).toEqual(['a', 'b']);
    expect(bounded.count).toBe(3);

    // Control: an omitted limit must not silently bound the read.
    sqlMock.mockResolvedValue([row('a'), row('b'), row('c')]);
    const unbounded = body(await listTool.handler({} as never, { role: 'su' } as never));
    expect(unbounded.routines).toHaveLength(3);
    expect(unbounded.count).toBe(3);
  });

  /*
   * EI-19336000265007219 — a DELIBERATE PAUSE must be distinguishable from a STALL.
   *
   * routines:set has recorded metadata.pause { reason, pausedBy, pausedAtMs } on every
   * pause since EI-18654017982759582, which existed because a routine paused during an
   * incident had TWICE sat silently paused for days: "nothing durable said WHO paused
   * it or WHY, so a responder could not tell a stuck bug from a deliberate hold".
   *
   * But this tool never SELECTed `metadata`, so the responder that record was written
   * for still saw a bare active:false. It happened a third time — improvement-implement,
   * paused 2026-07-28T03:40Z via the Agents pane, noticed five days later and filed as a
   * suspected stall by an agent who correctly hedged "may be an intentional pause ... not
   * obviously documented anywhere I found". The answer was one column over in the row
   * they had already queried.
   *
   * These tests pin the READ side, because a durable record nobody reads is just a
   * quieter silence.
   */
  it('surfaces the deliberate-pause record on a paused routine (EI-19336000265007219)', async () => {
    sqlMock.mockResolvedValue([
      {
        install_slug: 'papercusp',
        name: 'improvement-implement',
        trigger_kind: 'cron',
        trigger_config: { cron: '0 */30 * * * *' },
        target_role: 'system:improvement-implement',
        active: false,
        next_fire_at: null,
        last_fired_at: new Date('2026-07-28T03:30:01Z'),
        metadata: {
          pause: { reason: 'Paused via the Agents pane', pausedBy: 'loopback', pausedAtMs: 1785210000297 },
        },
      },
    ]);
    const b = body(await listTool.handler({} as never, { role: 'su' } as never));
    expect(b.routines[0].paused).toEqual({
      reason: 'Paused via the Agents pane',
      by: 'loopback',
      at: '2026-07-28T03:40:00.297Z',
      // P-004: an UNGROUPED routine's pause is not TTL-governed, and `finite:false`
      // states that positively — the loud case, because nothing will re-arm it.
      autoResumesAt: null,
      finite: false,
    });
  });

  it('P-004: reports the auto-resume deadline on a release-group pause', async () => {
    const pausedAtMs = Date.parse('2026-08-31T10:00:00.000Z');
    sqlMock.mockResolvedValue([
      {
        install_slug: 'papercusp',
        name: 'green-checkpoint',
        trigger_kind: 'cron',
        trigger_config: { cron: '0 15 * * * *' },
        target_role: 'system:green-checkpoint',
        active: false,
        next_fire_at: null,
        last_fired_at: null,
        group_slug: 'release',
        metadata: { pause: { reason: 'deploy surgery', pausedBy: 'su-x', pausedAtMs, expiresAtMs: pausedAtMs + 3_600_000 } },
      },
    ]);
    const b = body(await listTool.handler({} as never, { role: 'su' } as never));
    expect(b.routines[0].paused).toMatchObject({
      finite: true,
      autoResumesAt: new Date(pausedAtMs + 3_600_000).toISOString(),
    });
  });

  it('P-004: applies the default release TTL to a LEGACY pause that carries no expiry', async () => {
    const pausedAtMs = Date.parse('2026-08-31T10:00:00.000Z');
    sqlMock.mockResolvedValue([
      {
        install_slug: 'papercusp',
        name: 'green-checkpoint',
        trigger_kind: 'cron',
        trigger_config: { cron: '0 15 * * * *' },
        target_role: 'system:green-checkpoint',
        active: false,
        next_fire_at: null,
        last_fired_at: null,
        group_slug: 'release',
        metadata: { pause: { reason: 'legacy hold', pausedBy: 'su-x', pausedAtMs } },
      },
    ]);
    const b = body(await listTool.handler({} as never, { role: 'su' } as never));
    expect(b.routines[0].paused).toMatchObject({
      finite: true,
      autoResumesAt: new Date(pausedAtMs + 4 * 3_600_000).toISOString(),
    });
  });

  /**
   * P-002 (sql-escape-tool-routing-2026-08-12). The sibling of the pause tests
   * above, and the same defect one field family over: this tool already SELECTs
   * `metadata`, so 112 distinct agents hand-writing
   * `SELECT metadata->'gate_health' FROM harness_shared.routines` (722 calls in
   * 14 days — the largest raw-SQL cluster in the audit) were querying a row it
   * had already fetched and thrown away.
   */
  it('surfaces gate_health on the green-checkpoint routine (P-002 — the 112-agent cluster)', async () => {
    sqlMock.mockResolvedValue([
      {
        install_slug: 'papercusp',
        name: 'green-checkpoint',
        trigger_kind: 'cron',
        trigger_config: { cron: '0 0 * * * *' },
        target_role: 'system:green-checkpoint',
        active: true,
        next_fire_at: new Date('2026-08-12T17:00:00Z'),
        last_fired_at: new Date('2026-08-12T16:00:00Z'),
        metadata: {
          gate_health: {
            inFlightRetriage: null,
            observedAt: Date.parse('2026-08-12T16:00:00.000Z'),
            observedCandidate: 'abc123',
            candidateCommittedAt: Date.parse('2026-08-12T15:30:00.000Z'),
            commitsBehindTip: 4,
            consecutiveReds: 3,
          },
          git_sync_activity: {
            active: true,
            phase: 'post-legs',
            started_at: 1786550000000,
            updated_at: 1786550005000,
            completed_at: null,
            outcome_status: 'synced',
          },
          last_status: 'red',
          consecutive_error_ticks: 2,
          fire_count: 411,
          pause: null,
        },
      },
    ]);
    const b = body(await listTool.handler({} as never, { role: 'su' } as never));
    expect(b.routines[0].health).toMatchObject({
      gate_health: { observedCandidate: 'abc123', consecutiveReds: 3 },
      git_sync_activity: { active: true, phase: 'post-legs', outcome_status: 'synced' },
      last_status: 'red',
      consecutive_error_ticks: 2,
      fire_count: 411,
    });
    expect(b.routines[0].health.gate_health.readAttestation).toMatchObject({
      snapshotObservedAt: '2026-08-12T16:00:00.000Z',
      observedCandidate: 'abc123',
      candidateCommittedAt: '2026-08-12T15:30:00.000Z',
      candidateAgeAtObservationMs: 30 * 60_000,
      commitsBehindTip: 4,
    });
    expect(b.routines[0].health.gate_health.readAttestation.snapshotAgeMs).toEqual(expect.any(Number));
    expect(b.routines[0].health.gate_health.readAttestation.snapshotAge).toMatch(/ ago$/);
  });

  it('renders a deterministic read-time age and candidate attestation without rewriting raw fields', () => {
    const observedAt = Date.parse('2026-08-12T16:00:00.000Z');
    const candidateCommittedAt = Date.parse('2026-08-12T15:30:00.000Z');
    const raw = {
      observedAt,
      observedCandidate: 'abc123',
      candidateCommittedAt,
      commitsBehindTip: 4,
      failingTests: ['a.test.ts'],
    };

    const result = attestGateHealth(raw, Date.parse('2026-08-12T17:30:00.000Z')) as Record<string, unknown>;
    expect(result).toMatchObject({ ...raw, failingTests: ['a.test.ts'] });
    expect(result.readAttestation).toEqual({
      snapshotObservedAt: '2026-08-12T16:00:00.000Z',
      snapshotAgeMs: 90 * 60_000,
      snapshotAge: '1h30m ago',
      observedCandidate: 'abc123',
      candidateCommittedAt: '2026-08-12T15:30:00.000Z',
      candidateAgeAtObservationMs: 30 * 60_000,
      commitsBehindTip: 4,
    });
    expect(result.failingTestsAttestation).toEqual({
      candidate: 'abc123',
      inFlightCandidate: null,
      staleAgainstInFlight: null,
      warning: null,
    });
  });

  it('P-013: an UNRECOGNIZED gate_health field survives the read — the convergence projection needs no wiring here', () => {
    // `attestGateHealth` returns `{ ...gateHealth, <attestations> }`, a SPREAD. That is the ONLY
    // reason `gate_health.convergence` (written by writeFrozenCandidateRepairQueue) reaches a
    // reader without this function being taught about it.
    //
    // This is a guard, not a demonstration. EI-19343516395023183 records the sibling failure in
    // this exact family: `parseInFlightRetriage` returns an EXPLICIT object literal, so
    // `charged`/`totalRefires`/`absoluteCeiling` were persisted by both writers and reached no
    // reader at all — for months, silently, while every consumer rendered a confidently wrong
    // number. If someone later refactors this spread into a field-by-field literal "to make the
    // shape explicit", the convergence projection dies the same silent death. This test fails first.
    const convergence = {
      candidate: 'abc123',
      repairHead: 'def456',
      phase: 'awaiting-fixer',
      openedAtMs: 1,
      ageMs: 2,
      attempts: 1,
      admissionRounds: 2,
      failingFirst: 5,
      failingNow: 1,
      shrinkTotal: 4,
      shrinkPerRound: [{ round: 1, failingCount: 5, delta: null }],
      converging: true,
      observedAtMs: 3,
    };
    const result = attestGateHealth({ observedCandidate: 'abc123', convergence }, Date.now()) as Record<
      string,
      unknown
    >;
    // Byte-identical, not merely present: a reader computes shrink from these numbers.
    expect(result.convergence).toEqual(convergence);
  });

  it('marks cached failingTests as belonging to a prior verdict when another candidate is in flight', () => {
    const now = Date.parse('2026-08-12T17:30:00.000Z');
    const result = attestGateHealth(
      {
        observedAt: now - 60_000,
        observedCandidate: 'oldcandidate1234567890',
        failingTests: ['lint:tsc'],
        inFlightCandidate: {
          candidate: 'newcandidateabcdef1234',
          candidateSource: 'tip',
          base: 'basecandidate1234',
          selectedAtMs: now - 30_000,
          quietCutApplied: false,
          tipAtSelection: 'newcandidateabcdef1234',
          refireDepth: 0,
          pid: 1234,
          observedAtMs: now - 5_000,
        },
      },
      now,
    ) as Record<string, unknown>;

    expect(result.failingTests).toEqual(['lint:tsc']);
    expect(result.failingTestsAttestation).toEqual({
      candidate: 'oldcandidate1234567890',
      inFlightCandidate: 'newcandidateabcdef1234',
      staleAgainstInFlight: true,
      warning:
        'These failingTests describe terminal verdict oldcandidate1234567890, not the active run newcandidateabcdef1234; do not triage them as current-run failures.',
    });
  });

  it('attests failingTests as current when short and full candidate shas identify the same run', () => {
    const now = Date.parse('2026-08-12T17:30:00.000Z');
    const result = attestGateHealth(
      {
        observedCandidate: 'abc123def456',
        failingTests: ['lib/red.test.ts'],
        inFlightCandidate: {
          candidate: 'abc123def4567890abcdef',
          candidateSource: 'tip',
          base: null,
          selectedAtMs: now - 30_000,
          quietCutApplied: false,
          tipAtSelection: null,
          refireDepth: 0,
          pid: 1234,
          observedAtMs: now - 5_000,
        },
      },
      now,
    ) as Record<string, unknown>;

    expect(result.failingTestsAttestation).toEqual({
      candidate: 'abc123def456',
      inFlightCandidate: 'abc123def4567890abcdef',
      staleAgainstInFlight: false,
      warning: null,
    });
  });

  it('does not invent provenance for a legacy or malformed gate-health blob', () => {
    const result = attestGateHealth(
      { observedAt: 'not-a-timestamp', failingTests: ['a.test.ts'] },
      Date.parse('2026-08-12T17:30:00.000Z'),
    ) as Record<string, unknown>;
    expect(result.failingTests).toEqual(['a.test.ts']);
    expect(result.failingTestsAttestation).toEqual({
      candidate: null,
      inFlightCandidate: null,
      staleAgainstInFlight: null,
      warning: null,
    });
    expect(result.readAttestation).toEqual({
      snapshotObservedAt: null,
      snapshotAgeMs: null,
      snapshotAge: null,
      observedCandidate: null,
      candidateCommittedAt: null,
      candidateAgeAtObservationMs: null,
      commitsBehindTip: null,
    });
    // WI-1752145: no abort block ⇒ no attestation invented for one.
    expect(result.inconclusiveAttestation).toBeNull();
  });

  /**
   * ⭐ WI-1752145 — `routines:list` is the surface the originating incident was measured on.
   *
   * `readAttestation.snapshotAgeMs` is derived from the TOP-LEVEL `observedAt`, which an
   * aborting tick does not advance (release-actions.ts writes `inconclusive` through a scoped
   * jsonb_set on purpose, so an abort cannot disturb the verdict counters). The consequence
   * nothing reported: the two vintages under one payload drift without bound, and the honest
   * age beside `inconclusive.status` described a DIFFERENT observation entirely.
   *
   * Measured live 2026-08-31 — top-level `observedAt` vs `inconclusive.observedAtMs`:
   * portal +2h55m, oddsmith +5.7 DAYS, readinglist +5.6 DAYS, hello-world-3 +4s.
   */
  it('⭐ WI-1752145: attests a STALE abort block against its OWN vintage, not the verdict’s', () => {
    const now = Date.parse('2026-08-31T15:00:00.000Z');
    const result = attestGateHealth(
      {
        // The verdict is FRESH — this is the trap. Reading the snapshot age would say
        // "1 minute old" about a payload whose abort record is three hours stale.
        observedAt: now - 60_000,
        consecutiveReds: 77,
        inconclusive: { status: 'migrations-pending', candidate: 'deadbeefcafe', observedAtMs: now - 3 * 60 * 60_000 },
      },
      now,
    ) as Record<string, unknown>;

    expect(result.readAttestation).toMatchObject({ snapshotAgeMs: 60_000 });
    expect(result.inconclusiveAttestation).toMatchObject({
      status: 'migrations-pending',
      ageMs: 3 * 60 * 60_000,
      age: '3h ago',
      stale: true,
    });
    expect((result.inconclusiveAttestation as { warning: string }).warning).toContain('LATCHED');
  });

  it('⭐ WI-1752145: does NOT mark a fresh abort stale, and reports an unstamped one as unknown', () => {
    const now = Date.parse('2026-08-31T15:00:00.000Z');

    // NEGATIVE DIRECTION #1 — without this, a projection that always warns would pass.
    const fresh = attestGateHealth(
      { observedAt: now, inconclusive: { status: 'error', observedAtMs: now - 4_000 } },
      now,
    ) as Record<string, unknown>;
    expect(fresh.inconclusiveAttestation).toMatchObject({ status: 'error', age: '4s ago', stale: false, warning: null });

    // NEGATIVE DIRECTION #2 — an unstamped record is UNKNOWN vintage. Rendering that as
    // `stale: false` would manufacture exactly the confident non-measurement this fixes.
    const unstamped = attestGateHealth(
      { observedAt: now, inconclusive: { status: 'cancelled' } },
      now,
    ) as Record<string, unknown>;
    const att = unstamped.inconclusiveAttestation as { stale: boolean | null; ageMs: number | null; warning: string };
    expect(att.stale).toBeNull();
    expect(att.ageMs).toBeNull();
    expect(att.warning).toContain('NO observation timestamp');
  });

  it('stamps only the operator-home gate-health row with its registry-derived re-read handle', async () => {
    const row = (install_slug: string, consecutiveReds: number) => ({
      install_slug,
      name: 'green-checkpoint',
      trigger_kind: 'cron',
      trigger_config: { cron: '0 0 * * * *' },
      target_role: 'system:green-checkpoint',
      active: true,
      next_fire_at: new Date('2026-08-12T17:00:00Z'),
      last_fired_at: new Date('2026-08-12T16:00:00Z'),
      group_slug: null,
      metadata: { gate_health: { consecutiveReds } },
    });
    sqlMock.mockResolvedValue([row('home-harness', 2), row('sidestage', 7)]);

    const b = body(await listTool.handler({} as never, { role: 'su', harnessSlug: 'papercusp' } as never));
    expect(b.routines[0].plane?.cells).toEqual([
      expect.objectContaining({
        path: 'health.gate_health.consecutiveReds',
        cell: 'gate.greenCheckpoint.verdict',
        reread: { tool: 'state:read', args: { cell: 'gate.greenCheckpoint.verdict' } },
      }),
    ]);
    expect(b.routines[1]).not.toHaveProperty('plane');
  });

  /**
   * EI-20747395137280903 — the FOURTH instance of the defect {@link healthOf}'s own header
   * predicted ("a per-field fix here is what guarantees a fourth instance").
   *
   * A routine whose `system:` action is registered NOWHERE fires on schedule and does nothing,
   * forever. The detector for it has always worked and has always written its findings to
   * `metadata.validation`; that key simply was not in the projection's allowlist, so the only
   * witness was a `console.error` in journalctl. Every surface an agent would naturally check
   * — `active`, `nextFireAt`, `lastFiredAt` — reports a perfectly healthy routine, which is
   * precisely why this needs a POSITIVE assertion rather than trust in the log.
   *
   * Measured when this landed: 4 routines were live in this state with 210 skipped fires
   * between them.
   */
  it('surfaces metadata.validation so a silently-dead routine stops reading as healthy (EI-20747395137280903)', async () => {
    sqlMock.mockResolvedValue([
      {
        install_slug: 'papercusp',
        name: 'coverage-census',
        trigger_kind: 'interval',
        trigger_config: { interval_sec: 900 },
        target_role: 'system:coverage-census',
        // Every one of these reads HEALTHY. That is the bug this test pins.
        active: true,
        next_fire_at: new Date('2026-08-18T13:30:00Z'),
        last_fired_at: new Date('2026-08-18T13:12:11Z'),
        metadata: {
          validation: {
            'unregistered-system-action': {
              occurrences: 25,
              firstSeenMs: 1787028895814,
              lastSeenMs: 1787057475766,
            },
          },
        },
      },
    ]);
    const b = body(await listTool.handler({} as never, { role: 'su' } as never));
    expect(b.routines[0].health).toMatchObject({
      validation: {
        'unregistered-system-action': { occurrences: 25 },
      },
    });
  });

  /**
   * EI-21297913810967409 — the same defect as the test above, one subsystem over, and the READER
   * half of that fix.
   *
   * The five release watchdogs (green-stall, the stranded-pause scan, main-behind-staging, and
   * both release-trigger guards) each swallow their own failure as a `console.warn (non-fatal)`,
   * so a guard that CANNOT RUN and a guard that ran and found nothing are indistinguishable —
   * both are silence. One of them had been dead for as long as it had existed, querying a column
   * that does not exist (EI-21291109975568717), with no witness but a console line.
   *
   * Each pass now records onto the routine row it watches. That write is proven against real
   * Postgres in release/watchdog-health.integration.test.ts; what THIS test pins is the other
   * end — that the recorded marker actually reaches a reader. Drop the key from the allowlist
   * and the watchdogs go back to writing evidence nobody ever sees, which is the whole bug.
   */
  it('surfaces metadata.watchdog_health so a broken release watchdog stops reading as healthy (EI-21297913810967409)', async () => {
    sqlMock.mockResolvedValue([
      {
        install_slug: 'papercusp',
        name: 'green-checkpoint',
        trigger_kind: 'cron',
        trigger_config: { cron: '15 * * * *' },
        target_role: 'system:green-checkpoint',
        // As with the test above: every one of these reads HEALTHY while the watchdog that
        // would notice otherwise cannot run at all.
        active: true,
        next_fire_at: new Date('2026-08-24T03:15:00Z'),
        last_fired_at: new Date('2026-08-24T02:15:00Z'),
        metadata: {
          watchdog_health: {
            'paused-green-checkpoint': {
              lastError: 'column cp.revoked_at does not exist',
              lastErrorAt: '2026-08-24T02:15:04.000Z',
              consecutiveFailures: 12,
            },
          },
        },
      },
    ]);
    const b = body(await listTool.handler({} as never, { role: 'su' } as never));
    expect(b.routines[0].health).toMatchObject({
      watchdog_health: {
        'paused-green-checkpoint': { consecutiveFailures: 12 },
      },
    });
  });

  /**
   * EI-22499535458977879 — the FIFTH instance, and the one the fix is shaped by.
   *
   * `gitnexus-reindex` records its own failure streak, LadybugDB utilization and the
   * embeddings-coverage verdict into `metadata.gitnexus_health` on every tick. The key was
   * not in the allowlist, so `routines:list` answered `health: null` for it on both :3070
   * and :3170 — the reader could not see a subsystem's own record of whether it was
   * working. Found only because an acceptance grader happened to check ONE routine.
   *
   * This pins the concrete instance; the test below pins the class.
   */
  it('surfaces metadata.gitnexus_health so the reindex routine stops reading as health:null (EI-22499535458977879)', async () => {
    sqlMock.mockResolvedValue([
      {
        install_slug: 'papercusp',
        name: 'gitnexus-reindex',
        trigger_kind: 'cron',
        trigger_config: { cron: '0 35 * * * *' },
        target_role: 'system:gitnexus-reindex',
        // As with every instance before it: all four of these read HEALTHY.
        active: true,
        next_fire_at: new Date('2026-09-06T15:35:00Z'),
        last_fired_at: new Date('2026-09-06T14:40:32Z'),
        // Shape copied from the live row (workspace papercusp-workspace, 2026-09-06).
        metadata: {
          gitnexus_health: {
            alerted: false,
            consecutiveFailures: 0,
            lastSuccessAt: 1788698646792,
            dbUtilization: 0.07743704319000244,
            vectorSearch: { degraded: false, expected: true, embeddings: 215253 },
          },
        },
      },
    ]);
    const b = body(await listTool.handler({} as never, { role: 'su' } as never));
    expect(b.routines[0].health).toMatchObject({
      gitnexus_health: { consecutiveFailures: 0, vectorSearch: { embeddings: 215253 } },
    });
  });

  /**
   * ⭐ THE GUARD THAT ENDS THE CYCLE. Every previous fix here appended one literal and the
   * header predicted the next instance; four arrived. This asserts the PROPERTY instead:
   * a `<subsystem>_health` key this file has never heard of is projected anyway.
   *
   * `quasar_health` is invented — it exists in no writer, anywhere. If someone replaces the
   * convention with a fifth hard-coded string, this test fails, which is the only way to
   * tell a derived reader apart from a transcribed one that happens to be current today.
   *
   * The three keys beside it are REAL blobs that were being dropped alongside the filed
   * one, so this also pins that the fix was applied to the class rather than the instance:
   * `project_history_health` and `intake_health` each carry a `consecutiveFailures` /
   * `last_error` that no agent could read, and the bare `health` is the admission canary's.
   */
  it('⭐ projects an UNKNOWN <subsystem>_health key, and the three real blobs dropped beside the filed one (EI-22499535458977879)', async () => {
    sqlMock.mockResolvedValue([
      {
        install_slug: 'papercusp',
        name: 'multi-health',
        trigger_kind: 'interval',
        trigger_config: { interval_sec: 900 },
        target_role: 'system:multi-health',
        active: true,
        next_fire_at: null,
        last_fired_at: null,
        metadata: {
          project_history_health: { alerted: false, consecutiveFailures: 0 },
          intake_health: { last_outcome: 'ok', total_scans: 7089 },
          health: { dead_target: { state: 'root-missing', parked: false } },
          // Invented. No writer emits this; it is here to prove the reader derives.
          quasar_health: { consecutiveFailures: 3 },
        },
      },
    ]);
    const b = body(await listTool.handler({} as never, { role: 'su' } as never));
    expect(b.routines[0].health).toMatchObject({
      project_history_health: { consecutiveFailures: 0 },
      intake_health: { total_scans: 7089 },
      health: { dead_target: { state: 'root-missing' } },
      quasar_health: { consecutiveFailures: 3 },
    });
  });

  /**
   * The predicate's own near-miss calibration. `endsWith('_health')` is easy to write in a
   * way that also swallows unrelated keys, and the echo control below cannot catch that
   * because it only sends one obviously-unrelated key. These are the boundary cases:
   * a word CONTAINING "health" is not a health record, and a bare `_health` names no
   * subsystem.
   */
  it('CALIBRATION: the health convention selects real blobs and rejects near-misses', () => {
    for (const key of ['health', 'gate_health', 'gitnexus_health', 'project_history_health', 'intake_health']) {
      expect(isHealthRecordKey(key), `${key} is a health record`).toBe(true);
    }
    for (const key of ['healthy', 'health_check', 'last_health_at', 'unhealthy', '_health', 'stealth']) {
      expect(isHealthRecordKey(key), `${key} is NOT a health record`).toBe(false);
    }
  });

  /**
   * The calibration control for the test above. A `toMatchObject` assertion on a projected
   * field passes for the WRONG reason if the projection ever starts echoing metadata wholesale
   * — so prove the allowlist is still an allowlist by sending a key that must NOT come through.
   * Without this, widening `healthOf` to `return metadata` would leave both tests green.
   */
  it('still filters non-operational metadata keys — the allowlist is not an echo', async () => {
    sqlMock.mockResolvedValue([
      {
        install_slug: 'papercusp',
        name: 'coverage-census',
        trigger_kind: 'interval',
        trigger_config: { interval_sec: 900 },
        target_role: 'system:coverage-census',
        active: true,
        next_fire_at: null,
        last_fired_at: null,
        metadata: {
          validation: { 'unregistered-system-action': { occurrences: 25 } },
          // Real key from this table, deliberately not operational — and one of the
          // biggest (measured max 16,613 chars), which is why the allowlist exists at all.
          residue_census: { huge: 'x'.repeat(64) },
        },
      },
    ]);
    const b = body(await listTool.handler({} as never, { role: 'su' } as never));
    expect(b.routines[0].health).toHaveProperty('validation');
    expect(b.routines[0].health).not.toHaveProperty('residue_census');
  });

  it('reports health:null for a routine carrying no operational metadata — the field stays cheap', async () => {
    // The projection must not turn every ordinary row into a bag of nulls: the
    // trimmed payload is what an agent sees by default, and this tool lists
    // hundreds of rows.
    sqlMock.mockResolvedValue([
      {
        install_slug: 'papercusp',
        name: 'plain',
        trigger_kind: 'cron',
        trigger_config: { cron: '0 0 * * * *' },
        target_role: 'system:plain',
        active: true,
        next_fire_at: null,
        last_fired_at: null,
        metadata: { armed_at: null, some_unrelated_key: 'x' },
      },
    ]);
    const b = body(await listTool.handler({} as never, { role: 'su' } as never));
    expect(b.routines[0].health).toBeNull();
  });

  it('reports paused:null for an inactive routine with NO pause record — the case that IS worth investigating', async () => {
    // The distinction is the whole point: this row and the one above are both
    // active:false, and only the pause record tells them apart.
    sqlMock.mockResolvedValue([
      {
        install_slug: 'papercusp',
        name: 'never-armed',
        trigger_kind: 'cron',
        trigger_config: { cron: '0 0 * * * *' },
        target_role: 'system:never-armed',
        active: false,
        next_fire_at: null,
        last_fired_at: null,
        metadata: {},
      },
    ]);
    const b = body(await listTool.handler({} as never, { role: 'su' } as never));
    expect(b.routines[0]).toMatchObject({ active: false, paused: null });
  });

  it('tolerates a malformed/partial pause record rather than throwing', async () => {
    // Defensive: metadata is free-form jsonb written by several call sites, and a
    // read surface that throws on a surprise shape is worse than one that degrades.
    sqlMock.mockResolvedValue([
      {
        install_slug: 'papercusp',
        name: 'odd',
        trigger_kind: 'cron',
        trigger_config: {},
        target_role: 'system:odd',
        active: false,
        next_fire_at: null,
        last_fired_at: null,
        metadata: { pause: { reason: 42, pausedAtMs: 'not-a-number' } },
      },
    ]);
    const b = body(await listTool.handler({} as never, { role: 'su' } as never));
    // P-004: an unparseable `pausedAtMs` leaves the hold UNDATABLE, so no auto-resume
    // can be derived — reported as finite:false rather than an invented deadline.
    expect(b.routines[0].paused).toEqual({ reason: null, by: null, at: null, autoResumesAt: null, finite: false });
  });

  it('KEEPS `paused` in the trimmed projection — dropping it would reinstate the bug by default', async () => {
    // trimmed is the tier an agent sees unless it asks for full, so this is where the
    // fix actually has to land. Asserted explicitly so a future trim-slimming edit
    // cannot quietly remove it.
    const trimmed = listTool.shape!.trimmed!({
      count: 1,
      routines: [
        {
          installSlug: 'papercusp',
          name: 'improvement-implement',
          cron: '0 */30 * * * *',
          active: false,
          nextFireAt: null,
          group: null,
          paused: { reason: 'Paused via the Agents pane', by: 'loopback', at: '2026-07-28T03:40:00.297Z' },
        },
      ],
    }, { args: {} } as never) as { routines: Array<Record<string, unknown>> };
    expect(trimmed.routines[0].paused).toMatchObject({ reason: 'Paused via the Agents pane' });
  });

  it('EI-20503768406496801: KEEPS `health` and `lastFiredAt` in the trimmed projection — the gate-health read must work on the DEFAULT tier', async () => {
    // The same defect as `paused` above, one field over. This shaper REBUILDS each
    // row from an allowlist, so a field added to the row mapper never arrives here —
    // it vanishes, and only on the tier agents get by default. Both fields below are
    // promised by this tool's own `returns` block, and CLAUDE.md's tool-routing table
    // sends agents here for gate health specifically so they stop hand-writing
    // `SELECT metadata->'gate_health' FROM harness_shared.routines`. Trimmed away, the
    // documented answer was simply absent and the only way back was that raw SQL.
    const trimmed = listTool.shape!.trimmed!({
      count: 2,
      routines: [
        {
          installSlug: 'sidestage',
          name: 'green-checkpoint',
          cron: '0 15 * * * *',
          active: true,
          nextFireAt: '2026-08-18T15:15:00.000Z',
          lastFiredAt: '2026-08-18T14:15:00.000Z',
          group: null,
          paused: null,
          health: { gate_health: { consecutive_reds: 3 }, last_status: 'error' },
        },
        {
          installSlug: 'papercusp',
          name: 'consult-expiry-sweep',
          cron: '0 */5 * * * *',
          active: true,
          nextFireAt: '2026-08-18T15:05:00.000Z',
          lastFiredAt: null,
          group: null,
          paused: null,
          // An ACTIVE routine whose handler is registered nowhere: active/nextFireAt
          // both read healthy and this key is the only tell.
          health: { validation: { 'unregistered-system-action': true } },
        },
      ],
    }, { args: {} } as never) as { routines: Array<Record<string, unknown>> };

    // The gate-health read, on the default tier.
    expect(trimmed.routines[0].health).toMatchObject({ gate_health: { consecutive_reds: 3 } });
    // lastFiredAt survives — and it is not redundant with nextFireAt: a STALLED routine
    // keeps advancing nextFireAt while lastFiredAt stays put, so the divergence between
    // the two IS the stall signal. Dropping one side made the pair unreadable.
    expect(trimmed.routines[0].lastFiredAt).toBe('2026-08-18T14:15:00.000Z');
    expect(trimmed.routines[0].nextFireAt).toBe('2026-08-18T15:15:00.000Z');
    // The silently-dead-routine tell survives too.
    expect(trimmed.routines[1].health).toMatchObject({
      validation: { 'unregistered-system-action': true },
    });

    // CONTROL: a row genuinely carrying neither must still say so explicitly rather
    // than omitting the keys — otherwise "no health" and "health was trimmed" are
    // indistinguishable to the reader, which is the ambiguity that hid this bug.
    const bare = listTool.shape!.trimmed!({
      count: 1,
      routines: [
        {
          installSlug: 'papercusp',
          name: 'git-sync',
          cron: '0 */2 * * * *',
          active: true,
          nextFireAt: '2026-08-18T15:00:00.000Z',
          lastFiredAt: null,
          group: 'release',
          paused: null,
          health: null,
        },
      ],
    }, { args: {} } as never) as { routines: Array<Record<string, unknown>> };
    expect(bare.routines[0]).toHaveProperty('health', null);
    expect(bare.routines[0]).toHaveProperty('lastFiredAt', null);
  });

  it('EI-25418215735104183: bounds nested health strings, arrays, and the total trimmed routine rows', () => {
    const lastError = 'spill evidence '.repeat(900);
    const heldLocks = Array.from({ length: 35 }, (_, index) => `git-sync-lock-${index}`);
    const routines = Array.from({ length: 12 }, (_, index) => ({
      installSlug: 'papercusp',
      name: `git-sync-${index}`,
      cron: '0 */2 * * * *',
      active: true,
      nextFireAt: null,
      group: 'release',
      paused: null,
      lastFiredAt: null,
      lastFire: null,
      health: {
        last_error: lastError,
        git_sync_freshness: {
          execution: { holds_exclusive_locks: heldLocks },
          safe_to_restart: false,
        },
      },
    }));
    // Before the bound, routines:list passed this nested health object through unchanged.
    expect(JSON.stringify(routines[0]!.health).length).toBeGreaterThan(4_800);
    const trimmed = listTool.shape!.trimmed!({ count: routines.length, routines }, { args: {} } as never) as {
      count: number;
      routines: Array<Record<string, unknown>>;
    };
    const firstHealth = trimmed.routines[0]!.health as {
      last_error: string;
      git_sync_freshness: {
        execution: { holds_exclusive_locks: unknown[] };
        safe_to_restart: boolean;
      };
    };
    const locks = firstHealth.git_sync_freshness.execution.holds_exclusive_locks;

    expect(firstHealth.last_error).toContain('[TRUNCATED +');
    expect(firstHealth.last_error.length).toBeLessThanOrEqual(1_000);
    expect(firstHealth.git_sync_freshness.safe_to_restart).toBe(false);
    expect(locks).toHaveLength(21);
    expect(locks.slice(0, 20)).toEqual(heldLocks.slice(0, 20));
    expect(locks[20]).toMatchObject({ __papercusp_truncated__: true, reason: 'array-items', omitted: 15 });
    expect(trimmed.routines.at(-1)).toMatchObject({
      installSlug: '(truncated)',
      name: expect.stringContaining('showing '),
    });
    expect(trimmed.count).toBe(routines.length);
    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(4_800);
    expect(routines[0]!.health.last_error).toBe(lastError);
    expect(routines[0]!.health.git_sync_freshness.execution.holds_exclusive_locks).toBe(heldLocks);
  });

  it('preserves git_sync_activity when earlier health diagnostics exhaust the nested budget', () => {
    const activity = {
      active: true,
      phase: 'local-sync',
      started_at: 1_798_267_200_000,
    };
    const row = {
      installSlug: 'papercusp',
      name: 'git-sync',
      cron: '0 */2 * * * *',
      active: true,
      nextFireAt: null,
      group: 'release',
      paused: null,
      lastFiredAt: null,
      lastFire: null,
      health: {
        last_error: 'earlier diagnostic '.repeat(1_500),
        diagnostic_details: 'additional detail '.repeat(1_500),
        git_sync_activity: activity,
      },
    };

    const trimmed = listTool.shape!.trimmed!({ count: 1, routines: [row] }, { args: {} } as never) as {
      count: number;
      routines: Array<Record<string, unknown>>;
    };
    const health = trimmed.routines[0]!.health as Record<string, unknown>;
    const assertActivityPreserved = (projected: Record<string, unknown>) =>
      expect(projected.git_sync_activity).toEqual(activity);
    // Control for the observed pre-fix all-or-nothing fallback: the guard must reject
    // a health-json-budget marker that replaces the complete oversized health object.
    const preFixHealth = { __papercusp_truncated__: true, reason: 'health-json-budget' };

    expect(() => assertActivityPreserved(preFixHealth)).toThrow();
    assertActivityPreserved(health);
    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(4_800);
  });

  it('CONTROL: the PRE-FIX allowlist is caught — proving the guard above can fail', async () => {
    // A guard that has never failed is a guard nobody has tested. Rather than mutate
    // production code in this shared tree to prove it (the sweep-race the repo
    // forbids), the pre-fix shaper is kept here PERMANENTLY as a deliberately-wrong
    // control: this is the exact 7-key allowlist as it stood before
    // EI-20503768406496801, and the assertions above are re-run against it.
    const preFixTrim = (rows: Array<Record<string, unknown>>) =>
      rows.map((r) => ({
        installSlug: r.installSlug ?? null,
        name: r.name ?? null,
        cron: r.cron ?? null,
        active: r.active === true,
        nextFireAt: r.nextFireAt ?? null,
        group: r.group ?? null,
        paused: r.paused ?? null,
      }));

    const row = {
      installSlug: 'sidestage',
      name: 'green-checkpoint',
      cron: '0 15 * * * *',
      active: true,
      nextFireAt: '2026-08-18T15:15:00.000Z',
      lastFiredAt: '2026-08-18T14:15:00.000Z',
      group: null,
      paused: null,
      health: { gate_health: { consecutive_reds: 3 } },
    };

    // The control drops exactly what the reporter observed missing...
    const stale = preFixTrim([row])[0] as Record<string, unknown>;
    expect(stale).not.toHaveProperty('health');
    expect(stale).not.toHaveProperty('lastFiredAt');

    // ...while the REAL shaper keeps them. If a future edit re-slims the allowlist,
    // the real shaper starts behaving like this control and the test above reds.
    const live = listTool.shape!.trimmed!({ count: 1, routines: [row] }, {
      args: {},
    } as never) as { routines: Array<Record<string, unknown>> };
    expect(live.routines[0]).toHaveProperty('health');
    expect(live.routines[0]).toHaveProperty('lastFiredAt');
  });

  // EI-21924434989535557: an acceptance-rubric grader launches as role `judge` and
  // needs this read-only routine/gate-health surface to RE-MEASURE a criterion (e.g.
  // "is the target routine active and its gate health non-degraded") instead of
  // quoting the implementer's recorded figures. Before the fix, `judge` was absent
  // from the allowlist and the grader's call returned `role_not_allowed`, forcing
  // that criterion to `unknown` — indistinguishable on the card from "genuinely
  // unestablished". Regression guard: nothing here re-narrows the allowlist and
  // silently reopens the gap.
  it('EI-21924434989535557: grants role `judge` read access, so acceptance graders can RE-MEASURE routine/gate health', () => {
    expect(listTool.agentRoles).toContain('judge');
  });

  // EI-7242: `q` was previously not a recognized arg at all — zod silently
  // stripped it and the query ran unfiltered (the whole catalog came back).
  it('accepts a `q` free-text filter and passes it through as an ILIKE pattern (EI-7242)', async () => {
    await listTool.handler({ q: 'git-sync' } as never, { role: 'su' } as never);
    const flatArgs = sqlMock.mock.calls.flat();
    expect(flatArgs).toContain('%git-sync%');
  });

  it('omits the `q` filter (passes null) when not provided — no accidental narrowing', async () => {
    await listTool.handler({} as never, { role: 'su' } as never);
    const flatArgs = sqlMock.mock.calls.flat();
    expect(flatArgs.some((v) => typeof v === 'string' && v.startsWith('%') && v.endsWith('%'))).toBe(false);
  });

  it('passes through group_slug as `group` on each row', async () => {
    sqlMock.mockResolvedValue([
      {
        install_slug: 'papercusp',
        name: 'git-sync',
        trigger_kind: 'cron',
        trigger_config: { cron: '0 */10 * * * *' },
        target_role: 'system:git-sync',
        active: true,
        next_fire_at: null,
        last_fired_at: null,
        group_slug: 'git-sync',
      },
    ]);
    const b = body(await listTool.handler({} as never, { role: 'su' } as never));
    expect(b.routines[0]).toMatchObject({ name: 'git-sync', group: 'git-sync' });
  });

  // WI-5018: rollup:true switches to the per-group aggregate query — a distinct SELECT
  // shape (group_slug/description/steward/review_cadence/last_reviewed_at + counts), not
  // the raw routines rows.
  it('rollup:true returns a per-group aggregate with reviewDue computed from review_cadence + last_reviewed_at', async () => {
    const overdue = new Date(Date.now() - 100 * 86_400_000); // 100 days ago, cadence 90d -> due
    sqlMock.mockResolvedValue([
      {
        group_slug: 'health',
        description: 'Cleanup + integrity sweeps.',
        steward: null,
        review_cadence: '90d',
        last_reviewed_at: overdue,
        count: '12',
        active_count: '10',
        most_recent_fire: null,
      },
    ]);
    const b = body(await listTool.handler({ rollup: true } as never, { role: 'su' } as never));
    expect(b.rollup).toHaveLength(1);
    expect(b.rollup[0]).toMatchObject({
      group: 'health',
      count: 12,
      activeCount: 10,
      inactiveCount: 2,
      reviewDue: true,
    });
  });

  it('group:"" (ungrouped-only) passes groupFilterActive=true and groupIsNull=true to the query, distinctly from a normal group filter', async () => {
    await listTool.handler({ group: '' } as never, { role: 'su' } as never);
    const emptyGroupArgs = sqlMock.mock.calls.flat();
    sqlMock.mockClear();
    await listTool.handler({ group: 'health' } as never, { role: 'su' } as never);
    const namedGroupArgs = sqlMock.mock.calls.flat();
    // Both narrow (groupFilterActive:true in both), but group:'' passes groupIsNull:true
    // while group:'health' passes groupIsNull:false and the literal slug 'health' as groupVal.
    expect(emptyGroupArgs.filter((v) => v === true).length).toBeGreaterThan(
      namedGroupArgs.filter((v) => v === true).length,
    );
    expect(namedGroupArgs).toContain('health');
  });
});

/**
 * EI-22702954391733746 — the health surface must not report a clean bill while origin is frozen.
 *
 * Measured 2026-09-08: throughout an ~8h egress freeze this surface read `last_status:'synced'`,
 * `git_sync_freshness:'fresh'`, `warning:null`, while origin sat 26 commits behind. Nothing was
 * wrong with the freshness verdict — it answers a DIFFERENT question (did the LOCAL commit stage
 * run on schedule), and on a bridged pot the member is commit-only by design, so a healthy local
 * stage is compatible with an arbitrarily stale origin. The origin verdict already existed, latched
 * on the same row by origin-freshness-watchdog, and was dropped by healthOf's allowlist.
 */
describe('routines:list origin-freshness headline (EI-22702954391733746)', () => {
  const FROZEN_ROW = {
    last_status: 'synced',
    of_alerted: 'true',
    of_alerted_cause: 'integrator-backlog',
    of_origin_sha: '00d844e2674033fd41884ac1c4d20d3c71c79596',
    of_integrator_backlog_sweeps: '6',
    of_stall_sweeps: '0',
  };

  it('REGRESSION: an origin alarm overrides a healthy-looking headline even when freshness is FRESH', () => {
    const originFreshness = deriveOriginFreshness(FROZEN_ROW);
    expect(originFreshness).toMatchObject({ alerted: true, cause: 'integrator-backlog' });

    // The exact outage shape: the local-commit verdict is genuinely fresh, so a headline gated
    // on `freshness.status === 'degraded'` would stay silent — which is what happened for 8h.
    const health = applyDerivedGitSyncHeadline(
      { last_status: 'synced' },
      { status: 'fresh' },
      originFreshness,
    );

    expect(health.last_status).not.toBe('synced');
    expect(String(health.last_status)).toContain('origin-freshness ALARMING');
    expect(String(health.last_status)).toContain('integrator-backlog');
    expect(String(health.last_status)).toContain('raw: synced'); // writer value preserved, never lost
  });

  it('NEGATIVE CONTROL: leaves the headline alone when origin-freshness is not alarming', () => {
    const originFreshness = deriveOriginFreshness({ ...FROZEN_ROW, of_alerted: 'false' });
    expect(originFreshness).toMatchObject({ alerted: false });

    const health = applyDerivedGitSyncHeadline({ last_status: 'synced' }, { status: 'fresh' }, originFreshness);
    expect(health.last_status).toBe('synced');
  });

  it('preserves the pre-existing freshness-degraded override when origin is fine', () => {
    const health = applyDerivedGitSyncHeadline(
      { last_status: 'synced' },
      { status: 'degraded' },
      deriveOriginFreshness({ ...FROZEN_ROW, of_alerted: 'false' }),
    );
    expect(String(health.last_status)).toContain('see git_sync_freshness');
  });

  it('returns null for a row the origin watchdog does not judge — absent measurement, not health', () => {
    // A legacy/p2p pot carries no of_* keys. Rendering that as `alerted:false` would assert a
    // clean origin verdict nobody computed.
    expect(deriveOriginFreshness({ last_status: 'synced' })).toBeNull();
    expect(deriveOriginFreshness(null)).toBeNull();
  });
});

describe('routines:set', () => {
  it('rejects a role without operator-config write authority (e.g. bee)', async () => {
    await expect(
      setTool.handler({ name: 'git-sync', active: false } as never, { role: 'cup' } as never),
    ).rejects.toThrow(/operator, architect, or mug/i);
  });

  it('accepts the queen (operator-equivalent, EI-2204)', async () => {
    sqlMock.mockResolvedValue([{ trigger_config: { cron: '0 */10 * * * *' }, active: false, next_fire_at: null }]);
    const b = body(
      await setTool.handler(
        { name: 'git-sync', active: false, reason: 'test pause' } as never,
        { role: 'mug' } as never,
      ),
    );
    expect(b).toMatchObject({ ok: true, applied: true });
  });

  it('requires cron, active, triggerConfig, payloadTemplate, or group', async () => {
    await expect(
      setTool.handler({ name: 'git-sync' } as never, { role: 'operator' } as never),
    ).rejects.toThrow(/requires cron, active, triggerConfig, payloadTemplate, and\/or group/i);
  });

  // WI-5018: assigning a group auto-creates it (blank metadata) in routine_groups —
  // the FK requires the row to exist; routines:group-set is where a steward fills it in.
  it('assigns a group — auto-creates the group row (INSERT ... ON CONFLICT DO NOTHING) then writes group_slug', async () => {
    sqlMock.mockResolvedValue([{ trigger_config: { cron: '0 */10 * * * *' }, active: true, next_fire_at: null, group_slug: null }]);
    const b = body(
      await setTool.handler({ name: 'git-sync', group: 'git-sync' } as never, { role: 'operator' } as never),
    );
    expect(b).toMatchObject({ ok: true, applied: true });
    const calls = sqlMock.mock.calls.map((c) => c.flat().join(' '));
    expect(calls.some((c) => c.includes('routine_groups') && c.includes('ON CONFLICT'))).toBe(true);
    expect(calls.some((c) => c.includes('group_slug') && c.includes('git-sync'))).toBe(true);
  });

  it('clears a group with group:null (ungroup) — no auto-create INSERT fires', async () => {
    sqlMock.mockResolvedValue([{ trigger_config: { cron: '0 */10 * * * *' }, active: true, next_fire_at: null, group_slug: 'health' }]);
    const b = body(
      await setTool.handler({ name: 'git-sync', group: null } as never, { role: 'operator' } as never),
    );
    expect(b).toMatchObject({ ok: true, applied: true });
    const calls = sqlMock.mock.calls.map((c) => c.flat().join(' '));
    expect(calls.some((c) => c.includes('routine_groups') && c.includes('ON CONFLICT'))).toBe(false);
  });

  // WI-4482: the scout singleton's run knobs live in payload_template, NOT trigger_config —
  // so retuning budget.maxIdeators had no sanctioned path and required the raw
  // `UPDATE harness_shared.routines` the playbook forbids.
  it('DEEP-merges a payload_template patch — retunes one nested knob without clobbering its siblings', async () => {
    // The live scout singleton payload shape: budget + models + cadence under `payload`.
    sqlMock.mockResolvedValue([
      {
        trigger_config: { cron: '0 */30 * * * *' },
        payload_template: {
          blueprintId: 'scout',
          cycleTimeoutMs: 600000,
          payload: {
            budget: { maxCostUsd: 1, maxIdeators: 1, maxCriticsPerIdea: 1 },
            models: { ideator: 'chatgpt:5.5', critic: 'chatgpt:5.5' },
            cadence: { idleThreshold: 0.5, frictionThreshold: 3 },
          },
        },
        active: true,
        next_fire_at: null,
      },
    ]);
    const b = body(
      await setTool.handler(
        {
          name: 'bp-singleton-scout-0',
          installSlug: '@singleton',
          payloadTemplate: { payload: { budget: { maxIdeators: 4, maxCriticsPerIdea: 2 } } },
        } as never,
        { role: 'operator' } as never,
      ),
    );
    expect(b).toMatchObject({ ok: true, applied: true });
    const wrote = sqlMock.mock.calls
      .flat()
      .find((v) => typeof v === 'string' && v.includes('maxIdeators')) as string | undefined;
    expect(wrote).toBeDefined();
    const written = JSON.parse(wrote!);
    // The two patched keys applied...
    expect(written.payload.budget.maxIdeators).toBe(4);
    expect(written.payload.budget.maxCriticsPerIdea).toBe(2);
    // ...the UNPATCHED sibling key inside the SAME nested object survived...
    expect(written.payload.budget.maxCostUsd).toBe(1);
    // ...and the sibling OBJECTS survived. A shallow Object.assign of { payload: {...} } would
    // have replaced `payload` wholesale and silently dropped models + cadence — turning a
    // one-key retune into a config wipe. This assertion is the whole reason the merge is deep.
    expect(written.payload.models).toEqual({ ideator: 'chatgpt:5.5', critic: 'chatgpt:5.5' });
    expect(written.payload.cadence).toEqual({ idleThreshold: 0.5, frictionThreshold: 3 });
    expect(written.blueprintId).toBe('scout');
    expect(written.cycleTimeoutMs).toBe(600000);
  });

  it('name-only resolves a unique workspace singleton when the operator-home row is absent', async () => {
    const singleton = {
      trigger_config: { cron: '0 */30 * * * *' },
      payload_template: { blueprintId: 'scout' },
      active: true,
      next_fire_at: null,
    };
    sqlMock.mockResolvedValueOnce([]); // no home-harness row
    sqlMock.mockResolvedValueOnce([{ install_slug: '@singleton' }]); // unique name candidate
    sqlMock.mockResolvedValueOnce([singleton]); // resolved singleton snapshot
    sqlMock.mockResolvedValueOnce([singleton]); // apply() re-read
    sqlMock.mockResolvedValueOnce([]); // UPDATE
    sqlMock.mockResolvedValueOnce([singleton]); // verify() re-read

    const b = body(
      await setTool.handler(
        { name: 'bp-singleton-scout-0', payloadTemplate: { payload: { budget: { maxIdeators: 4 } } } } as never,
        { role: 'operator' } as never,
      ),
    );

    expect(b).toMatchObject({ ok: true, applied: true, routine: '@singleton/bp-singleton-scout-0' });
  });

  it('name-only refuses when the same routine name exists under multiple installs', async () => {
    sqlMock.mockResolvedValueOnce([]); // no home-harness row
    sqlMock.mockResolvedValueOnce([{ install_slug: '@singleton' }, { install_slug: 'another-harness' }]);

    await expect(
      setTool.handler(
        { name: 'bp-singleton-scout-0', active: true } as never,
        { role: 'operator' } as never,
      ),
    ).rejects.toThrow(/ambiguous.*@singleton.*another-harness.*installSlug/i);
    // Ambiguity is rejected while resolving the target, before the control harness
    // is constructed and before any UPDATE can be issued.
    expect(controlMock).not.toHaveBeenCalled();
    expect(sqlMock.mock.calls.some((call) => call.some((value) => typeof value === 'string' && value.includes('UPDATE harness_shared.routines')))).toBe(false);
  });

  it('payload_template arrays and scalars REPLACE (a patched list is the new list, not a merge)', async () => {
    sqlMock.mockResolvedValue([
      { trigger_config: {}, payload_template: { payload: { lenses: ['a', 'b', 'c'], n: 1 } }, active: true, next_fire_at: null },
    ]);
    await setTool.handler(
      { name: 'r', payloadTemplate: { payload: { lenses: ['z'], n: 9 } } } as never,
      { role: 'operator' } as never,
    );
    const wrote = sqlMock.mock.calls.flat().find((v) => typeof v === 'string' && v.includes('lenses')) as string;
    const written = JSON.parse(wrote);
    expect(written.payload.lenses).toEqual(['z']);
    expect(written.payload.n).toBe(9);
  });

  // EI-22136767702523358: Postgres jsonb does NOT preserve JS object insertion order on a
  // round-trip (it reorders object keys by length-then-lexical for its binary encoding). A
  // payloadTemplate patch that ADDS a new (shorter) key — e.g. `model` — is appended LAST by
  // deepMergePlain's in-memory merge, but comes back FIRST on the verify-phase re-read. The old
  // `verify` compared `JSON.stringify(cur.payloadTemplate) === JSON.stringify(next.payloadTemplate)`
  // directly, so this reordering alone (same keys, same values, different order) made a
  // successful write misread as a mismatch — auto-reverting every additive override in
  // production (confirmed live: both work-item-admission-promoter and -delta-sweep). The fix
  // routes the comparison through `stableJson` (routine-snapshot.ts), the same order-independent
  // primitive `routineSnapEqual` already uses for a whole-snapshot compare.
  it('verify treats a payload_template equal after a simulated jsonb key-reorder round-trip — a successful additive patch is not misread as a mismatch', async () => {
    const original = { trigger_config: { cron: '0 */30 * * * *' }, payload_template: { batchSize: 20, recentTerminalDays: 30 }, active: true, next_fire_at: null };
    // Same content as `original`, but with the new `model` key (shorter than the other two)
    // reordered to the FRONT — exactly what a real jsonb round-trip does, and the opposite of
    // where deepMergePlain places a newly-added key (last).
    const reordered = { trigger_config: { cron: '0 */30 * * * *' }, payload_template: { model: 'claude-opus-5:xhigh', batchSize: 20, recentTerminalDays: 30 }, active: true, next_fire_at: null };
    sqlMock.mockResolvedValueOnce([original]); // capturePrev's read
    sqlMock.mockResolvedValueOnce([original]); // apply()'s internal prev re-read
    sqlMock.mockResolvedValueOnce([]); // the UPDATE write itself — return value unused
    sqlMock.mockResolvedValueOnce([reordered]); // verify()'s cur re-read — simulated jsonb reorder
    const b = body(
      await setTool.handler(
        { name: 'work-item-admission-promoter', payloadTemplate: { model: 'claude-opus-5:xhigh' } } as never,
        { role: 'operator' } as never,
      ),
    );
    expect(b.verify).toMatchObject({ ok: true });
  });

  // CONTROL: proves the test above actually exercises the reordering bug rather than passing
  // vacuously — with the PRE-FIX raw JSON.stringify comparison, the same reordered read fails.
  it('CONTROL: the pre-fix raw JSON.stringify comparison DOES fail on the same reordering — proving the test above is falsifiable', () => {
    // `next`: deepMergePlain's actual in-memory result — the new key `model` is APPENDED LAST.
    const next: Record<string, unknown> = { batchSize: 20, recentTerminalDays: 30 };
    next.model = 'claude-opus-5:xhigh';
    // `cur`: the same content as read back from a real jsonb round-trip — Postgres reorders
    // object keys by length-then-lexical, so the short `model` key comes back FIRST.
    const cur = { model: 'claude-opus-5:xhigh', batchSize: 20, recentTerminalDays: 30 };
    expect(JSON.stringify(cur) === JSON.stringify(next)).toBe(false);
  });

  it('patches trigger_config (P-017) — merges the patch, preserves cron, ignores a cron key in the patch', async () => {
    sqlMock.mockResolvedValue([{ trigger_config: { cron: '0 */10 * * * *', throttle_min: 8 }, active: true, next_fire_at: null }]);
    const b = body(
      await setTool.handler(
        { name: 'claim-discipline', triggerConfig: { throttle_min: 4, cron: 'EVIL' } } as never,
        { role: 'operator' } as never,
      ),
    );
    expect(b).toMatchObject({ ok: true, applied: true });
    // The UPDATE wrote the merged trigger_config: the caps patch (throttle_min:4) applied, cron preserved
    // (0 */10) — the `cron: 'EVIL'` key in the patch was ignored (cron only via the validated arg).
    const wrote = sqlMock.mock.calls.some((c) =>
      c.some((v) => typeof v === 'string' && v.includes('"throttle_min":4') && v.includes('"cron":"0 */10') && !v.includes('EVIL')),
    );
    expect(wrote).toBe(true);
  });

  it('rejects an invalid cron before any DB touch', async () => {
    cronM.mockReturnValue(null);
    await expect(
      setTool.handler({ name: 'git-sync', cron: 'nope' } as never, { role: 'operator' } as never),
    ).rejects.toThrow(/invalid cron/i);
    expect(sqlMock).not.toHaveBeenCalled();
  });

  it('pauses a routine (active:false) through the harness', async () => {
    sqlMock.mockResolvedValue([{ trigger_config: { cron: '0 */10 * * * *' }, active: false, next_fire_at: null }]);
    const b = body(
      await setTool.handler(
        { name: 'git-sync', active: false, reason: 'manual deploy surgery' } as never,
        { role: 'operator' } as never,
      ),
    );
    expect(b).toMatchObject({ ok: true, applied: true, routine: 'home-harness/git-sync', verify: { ok: true } });
  });

  it('dryRun does not apply', async () => {
    sqlMock.mockResolvedValue([{ trigger_config: { cron: '0 */10 * * * *' }, active: false, next_fire_at: null }]);
    const b = body(
      await setTool.handler(
        { name: 'git-sync', active: false, dryRun: true, reason: 'manual deploy surgery' } as never,
        { role: 'operator' } as never,
      ),
    );
    expect(b).toMatchObject({ dryRun: true, applied: false });
  });

  it('returns a non-retryable stale_target when the routine disappears after capture and before apply', async () => {
    const row = { trigger_config: { cron: '0 */10 * * * *' }, active: true, next_fire_at: null };
    sqlMock.mockResolvedValueOnce([row]); // control harness capturePrev
    sqlMock.mockResolvedValueOnce([]); // apply's second read sees the deleted row

    const b = body(
      await setTool.handler(
        { name: 'git-sync', installSlug: 'papercusp', active: false, reason: 'race regression' } as never,
        { role: 'operator' } as never,
      ),
    );

    expect(b).toEqual({
      ok: false,
      routine: 'papercusp/git-sync',
      error: 'stale_target',
      disposition: 'stale_target',
      retryable: false,
      applied: false,
      message: expect.stringContaining('disappeared after its snapshot was captured'),
    });
    expect(sqlMock.mock.calls.some((call) => call.some((value) => typeof value === 'string' && value.includes('UPDATE harness_shared.routines')))).toBe(false);
  });

  it('dryRun previews trigger_config current and proposed values for an ephemeral interval retune', async () => {
    sqlMock.mockResolvedValue([
      {
        trigger_config: { interval_sec: 600, batch_size: 25 },
        active: true,
        next_fire_at: null,
      },
    ]);
    const b = body(
      await setTool.handler(
        {
          name: 'acceptance-grading-sweep',
          installSlug: 'papercusp',
          triggerConfig: { interval_sec: 60 },
          dryRun: true,
        } as never,
        { role: 'operator' } as never,
      ),
    );

    expect(b).toMatchObject({
      dryRun: true,
      applied: false,
      preview: {
        current: {
          triggerConfig: { interval_sec: 600, batch_size: 25 },
        },
        proposed: {
          triggerConfig: { interval_sec: 60, batch_size: 25 },
        },
      },
    });
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('blocks a peer green-checkpoint resume while the serializer hold is active', async () => {
    serializerM.mockResolvedValue({
      status: 'held',
      itemId: 'WI-40086',
      ownerId: 'su-serializer',
      pauseReason: 'D-012/D-013 live quiescence hold under WI-40086: exact qualification',
      holdReason: 'D-016 sole serializer hold: exact qualification',
    });

    await expect(
      setTool.handler({ name: 'green-checkpoint', active: true } as never, { role: 'operator' } as never),
    ).rejects.toThrow(/serializer hold.*WI-40086.*su-serializer/i);
    expect(controlMock).not.toHaveBeenCalled();
  });

  it('blocks a peer resume in the reclaim-to-hold window when the live gate owner already claimed the incident', async () => {
    gateOwnershipM.mockResolvedValue({
      assessment: 'held-live',
      eventKey: 'gate-red-streak:home-harness',
      workItem: 'WI-40086',
      claimState: 'held',
      unknown: null,
      takenBy: 'su-gate-owner',
      takenAt: '2026-08-26T14:30:17.000Z',
      lastProgressAt: null,
      expiresAt: null,
      holderSessionState: 'live',
      duplicates: [],
      thread: { status: 'not-read', reason: 'not needed by resume guard' },
    } as never);

    await expect(
      setTool.handler(
        { name: 'green-checkpoint', active: true, dryRun: true } as never,
        { role: 'operator', ownerId: 'su-peer' } as never,
      ),
    ).rejects.toThrow(/live gate owner su-gate-owner holds WI-40086/i);
    expect(controlMock).not.toHaveBeenCalled();
  });

  it('allows the operator-home green-checkpoint resume when admission is clear, authority is free, and no run is active', async () => {
    sqlMock.mockResolvedValue([
      {
        trigger_config: { cron: '0 */10 * * * *' },
        active: false,
        next_fire_at: null,
        metadata: { pause: { reason: 'manual pause', pausedBy: 'su-owner', pausedAtMs: 1 } },
      },
    ]);

    const b = body(
      await setTool.handler({ name: 'green-checkpoint', active: true } as never, { role: 'operator' } as never),
    );
    expect(b).toMatchObject({ ok: true, applied: true, routine: 'home-harness/green-checkpoint' });
    expect(rootM).toHaveBeenCalledOnce();
    expect(admissionM).toHaveBeenCalledOnce();
    expect(serializerM).toHaveBeenCalledWith({ installSlug: 'home-harness' });
    expect(activeRunM).toHaveBeenCalledWith('/integration-root');
  });

  it('applies the same green-checkpoint resume guard to dryRun', async () => {
    serializerM.mockResolvedValue({
      status: 'held',
      itemId: 'WI-40086',
      ownerId: 'su-serializer',
      pauseReason: 'D-012/D-013 live quiescence hold under WI-40086: exact qualification',
      holdReason: 'D-016 sole serializer hold: exact qualification',
    });

    await expect(
      setTool.handler(
        { name: 'green-checkpoint', active: true, dryRun: true } as never,
        { role: 'operator' } as never,
      ),
    ).rejects.toThrow(/serializer hold/i);
    expect(controlMock).not.toHaveBeenCalled();
  });

  // EI-18654017982759582: a pause with no recorded reason/owner is exactly how release-trigger
  // silently stayed off for days (twice) — require a reason up front.
  it('rejects active:false with no reason', async () => {
    await expect(
      setTool.handler({ name: 'release-trigger', active: false } as never, { role: 'operator' } as never),
    ).rejects.toThrow(/requires a `reason`/);
  });

  it('persists metadata.pause { reason, pausedBy, pausedAtMs } on pause, preserving other metadata keys', async () => {
    sqlMock.mockResolvedValue([
      { trigger_config: { cron: '0 */10 * * * *' }, active: true, next_fire_at: null, metadata: { gate_health: { lastGreenAt: 123 } } },
    ]);
    const b = body(
      await setTool.handler(
        { name: 'release-trigger', active: false, reason: 'pausing for incident triage' } as never,
        { role: 'operator', ownerId: 'su-test-1' } as never,
      ),
    );
    expect(b).toMatchObject({ ok: true, applied: true });
    const wrote = sqlMock.mock.calls.flat().find((v) => typeof v === 'string' && v.includes('"pause"')) as string;
    const written = JSON.parse(wrote);
    expect(written.pause).toMatchObject({ reason: 'pausing for incident triage', pausedBy: 'su-test-1' });
    expect(typeof written.pause.pausedAtMs).toBe('number');
    // The concurrently-written gate_health key from another writer survives untouched.
    expect(written.gate_health).toEqual({ lastGreenAt: 123 });
  });

  // EI-19370236916382521: the DARK_FLAGS_REVIEW_BY analog for a deliberately-paused
  // always-on learning loop — "re-affirm it explicitly rather than letting this alarm
  // re-fire silently" needs somewhere durable to land.
  it('persists metadata.pause.reviewBy when passed alongside active:false', async () => {
    sqlMock.mockResolvedValue([
      { trigger_config: { cron: '0 20 6 1 * *' }, active: true, next_fire_at: null, metadata: {} },
    ]);
    const b = body(
      await setTool.handler(
        {
          name: 'bp-singleton-iq-battery-0',
          installSlug: '@singleton',
          active: false,
          reason: 're-affirmed: deliberate owner pause, part of a broader Agents-pane sweep',
          reviewBy: '2026-11-01T00:00:00.000Z',
        } as never,
        { role: 'operator', ownerId: 'su-test-1' } as never,
      ),
    );
    expect(b).toMatchObject({ ok: true, applied: true });
    const wrote = sqlMock.mock.calls.flat().find((v) => typeof v === 'string' && v.includes('"pause"')) as string;
    const written = JSON.parse(wrote);
    expect(written.pause).toMatchObject({
      reason: 're-affirmed: deliberate owner pause, part of a broader Agents-pane sweep',
      pausedBy: 'su-test-1',
      reviewBy: '2026-11-01T00:00:00.000Z',
    });
  });

  it('omits reviewBy from metadata.pause entirely when not passed — a plain pause stays a plain pause', async () => {
    sqlMock.mockResolvedValue([
      { trigger_config: { cron: '0 */10 * * * *' }, active: true, next_fire_at: null, metadata: {} },
    ]);
    const b = body(
      await setTool.handler(
        { name: 'release-trigger', active: false, reason: 'pausing for incident triage' } as never,
        { role: 'operator', ownerId: 'su-test-1' } as never,
      ),
    );
    expect(b).toMatchObject({ ok: true, applied: true });
    const wrote = sqlMock.mock.calls.flat().find((v) => typeof v === 'string' && v.includes('"pause"')) as string;
    const written = JSON.parse(wrote);
    expect('reviewBy' in written.pause).toBe(false);
  });

  it('moves metadata.pause to lastPause on resume (active:true)', async () => {
    sqlMock.mockResolvedValue([
      {
        trigger_config: { cron: '0 */10 * * * *' },
        active: false,
        next_fire_at: null,
        metadata: { pause: { reason: 'r', pausedBy: 'su-x', pausedAtMs: 1 } },
      },
    ]);
    const b = body(
      await setTool.handler({ name: 'release-trigger', active: true } as never, { role: 'operator' } as never),
    );
    expect(b).toMatchObject({ ok: true, applied: true });
    const wrote = sqlMock.mock.calls.flat().find((v) => typeof v === 'string' && v.includes('lastPause')) as string;
    const written = JSON.parse(wrote);
    expect(written.pause).toBeUndefined();
    expect(written.lastPause).toMatchObject({ reason: 'r', pausedBy: 'su-x' });
    expect(typeof written.lastPause.resumedAtMs).toBe('number');
  });
});
