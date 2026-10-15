/**
 * The daily bulk-dedup driver (WI-10004722, plan
 * work-queue-bulk-cleanup-remediation-2026-10-01 P-005): it arms exactly one
 * bounded run when nothing is in flight, never stacks a second pass, and is
 * registered as a STANDING action so a missing routine row is loud.
 */
import { describe, expect, it, vi } from 'vitest';
import { getSystemActionEntry } from './system-actions';
import type { SystemActionCtx } from './system-actions';
import { TARGET_ROLE_SPEND } from '../../automation/routine-classification';
import { BESPOKE_ACTIVE_SEEDS } from './bespoke-active-seeds-check';
import {
  queueForRoutine,
  ROUTINES_CRITICAL_QUEUE,
  ROUTINES_HEAVY_QUEUE,
  ROUTINES_QUEUE,
} from '../../dbos/routines-queue-classification';
import {
  BULK_DEDUP_SCHEDULED_ROUTINE_NAME,
  DEFAULT_DRIVER_MAX_STAGES,
  driverRunControls,
  makeWorkItemAdmissionBulkDedupDriverAction,
  runBulkDedupDriver,
  WORK_ITEM_ADMISSION_BULK_DEDUP_DRIVER,
  type BulkDedupDriverDeps,
} from './work-item-admission-bulk-dedup-driver-action';

function ctx(payloadTemplate: Record<string, unknown> | null = { maxStages: 2 }): SystemActionCtx {
  return { installSlug: 'papercusp', workspaceId: 'ws-1', triggerConfig: { cron: '0 17 0 * * *' }, payloadTemplate };
}

const enqueued = {
  ok: true as const,
  enqueued: true as const,
  runId: 'bulk-dedup-scheduled-1',
  routineId: 'rt_papercusp_work_item_admission_bulk_dedup_scheduled',
  nextFireAt: '2026-10-01T04:17:00.000Z',
  targetRole: 'system:work-item-admission-bulk-dedup',
  completionEvidence: { query: 'workItemAdmission.runs', expectedRunPrefix: 'bulk-dedup-scheduled-1', terminalStates: ['complete', 'failed'] },
};

function deps(overrides: Partial<BulkDedupDriverDeps> = {}): BulkDedupDriverDeps {
  return {
    inFlight: vi.fn(async () => ({ inFlight: false as const })),
    enqueue: vi.fn(async () => enqueued),
    newRunId: vi.fn(() => 'bulk-dedup-scheduled-1'),
    invalidate: vi.fn(async () => {}),
    log: vi.fn(),
    ...overrides,
  };
}

describe('work-item admission bulk-dedup driver', () => {
  it('isolates the scheduled bulk stage on the heavy lane while admission housekeeping stays off it', () => {
    expect(queueForRoutine(enqueued.targetRole, 'papercusp')).toBe(ROUTINES_HEAVY_QUEUE);
    for (const action of ['work-item-admission-promoter', 'work-item-admission-bulk-dedup-census']) {
      expect(queueForRoutine(`system:${action}`, 'papercusp')).toBe(ROUTINES_QUEUE);
    }
    // EI-25209690807142935: the fail-open runner backs the admission-pending claim-floor guarantee, so it
    // rides the epoch-limiter-exempt critical lane — never the heavy lane the bulk stage saturates.
    expect(queueForRoutine('system:work-item-admission-fail-open', 'papercusp')).toBe(ROUTINES_CRITICAL_QUEUE);
  });

  it('is a registered STANDING action with an llm spend class and a bespoke seed row', () => {
    expect(getSystemActionEntry(WORK_ITEM_ADMISSION_BULK_DEDUP_DRIVER)).toMatchObject({ scheduling: 'standing' });
    expect(TARGET_ROLE_SPEND[`system:${WORK_ITEM_ADMISSION_BULK_DEDUP_DRIVER}`]).toMatchObject({ spend: 'llm' });
    expect(BESPOKE_ACTIVE_SEEDS).toContainEqual(
      expect.objectContaining({
        name: WORK_ITEM_ADMISSION_BULK_DEDUP_DRIVER,
        seedScript: 'seed-work-item-admission-bulk-dedup-driver-routine.ts',
      }),
    );
  });

  it('arms one bounded run on the fixed scheduled routine when nothing is in flight', async () => {
    const d = deps();
    const outcome = await runBulkDedupDriver(ctx({ maxStages: 3, maxPairsPerStage: 512, pairsPerCall: 100 }), d);
    expect(outcome.kind).toBe('enqueued');
    expect(d.enqueue).toHaveBeenCalledTimes(1);
    expect(d.enqueue).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-1', installSlug: 'papercusp' }), {
      runId: 'bulk-dedup-scheduled-1',
      routineName: BULK_DEDUP_SCHEDULED_ROUTINE_NAME,
      controls: { maxStages: 3, maxPairsPerStage: 512, pairsPerCall: 100 },
    });
  });

  it('skips without arming anything while any bulk-dedup pass is in flight', async () => {
    const d = deps({
      inFlight: vi.fn(async () => ({
        inFlight: true as const,
        reason: 'admission-run-open' as const,
        ref: 'stage-open',
        detail: 'bulk-stage started 2026-10-01T09:00:00.000Z and has not finished',
      })),
    });
    const action = makeWorkItemAdmissionBulkDedupDriverAction(d);
    await action(ctx());
    expect(d.enqueue).not.toHaveBeenCalled();
    expect(d.invalidate).not.toHaveBeenCalled();
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('skipped — a bulk-dedup pass is in flight (admission-run-open stage-open'));
  });

  it('defaults the stage budget when the payload omits it, so a run is never unbounded', () => {
    expect(driverRunControls(null)).toEqual({ maxStages: DEFAULT_DRIVER_MAX_STAGES });
    expect(driverRunControls({})).toEqual({ maxStages: DEFAULT_DRIVER_MAX_STAGES });
    expect(driverRunControls({ fullCorpusPairThreshold: 0, model: ' strong ' })).toEqual({
      maxStages: DEFAULT_DRIVER_MAX_STAGES,
      fullCorpusPairThreshold: 0,
      model: 'strong',
    });
  });

  it('fails the fire loudly on a malformed seed instead of arming a run with bad controls', async () => {
    const d = deps();
    await expect(runBulkDedupDriver(ctx({ maxStages: 0 }), d)).rejects.toThrow(/payload\.maxStages must be a positive integer/);
    await expect(runBulkDedupDriver(ctx({ pairsPerCall: 'lots' }), d)).rejects.toThrow(/payload\.pairsPerCall/);
    expect(d.inFlight).not.toHaveBeenCalled();
    expect(d.enqueue).not.toHaveBeenCalled();
  });

  it('reports a still-live scheduled fire as not re-armed, and invalidates the ledger after an enqueue', async () => {
    const live = deps({
      enqueue: vi.fn(async () => ({
        ok: false as const,
        enqueued: false as const,
        alreadyRunning: true as const,
        reason: 'already_running' as const,
        runId: 'bulk-dedup-scheduled-1',
        routineId: 'rt_papercusp_work_item_admission_bulk_dedup_scheduled',
        workflowUuid: 'wf-1',
        workflowStatus: 'PENDING' as const,
        message: 'still live',
      })),
    });
    await makeWorkItemAdmissionBulkDedupDriverAction(live)(ctx());
    expect(live.log).toHaveBeenCalledWith(expect.stringContaining('not re-armed'));

    const fresh = deps();
    await makeWorkItemAdmissionBulkDedupDriverAction(fresh)(ctx());
    expect(fresh.invalidate).toHaveBeenCalledTimes(1);
    expect(fresh.log).toHaveBeenCalledWith(expect.stringContaining('enqueued run=bulk-dedup-scheduled-1'));
  });
});
