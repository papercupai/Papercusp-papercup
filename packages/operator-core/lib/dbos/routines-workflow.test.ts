/**
 * Pins the durable loop-fire result at the DBOS workflow seam. A completed
 * `loop:wake` step with an undefined operation output previously erased whether
 * the fire delivered or was withheld, which made a parked-loop incident look
 * like a healthy workflow completion in DBOS forensics.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LearningLoopHealthSweepReport } from '../harness/routines/learning-loop-health-sweep';

const state = vi.hoisted(() => ({
  stepOutputs: [] as Array<{ name: string; output: unknown }>,
  /** Every tagged-template call on the mocked org pool: joined SQL text + bound values. */
  sqlCalls: [] as Array<{ text: string; values: unknown[] }>,
  loopResult: {
    fired: false,
    reason: 'await-blocking',
    detail: 'owner is parked on a blocking await',
  } as const,
  dbosStarted: true,
  startWorkflow: vi.fn((_workflow: unknown, _options: unknown) => async (..._args: unknown[]) => undefined),
  createDbosClient: vi.fn(),
  clientEnqueue: vi.fn(),
  scheduledTick: undefined as (() => Promise<void>) | undefined,
  scheduledSweepTick: undefined as (() => Promise<void>) | undefined,
  scheduledCrontabs: {} as Record<string, string | undefined>,
  /** Every DBOS.runStep name invoked, including steps a fixture short-circuits. */
  stepNames: [] as string[],
  poolShedFixture: false,
  probe: { rawMs: 3000, admissionMs: 2500, discountMs: 500 },
  recordPoolShedEvent: vi.fn(),
}));

vi.mock('@dbos-inc/dbos-sdk', () => {
  class WorkflowQueue {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
  }

  return {
    WorkflowQueue,
    DBOS: {
      workflowID: 'test-routine-fire',
      runStep: async (fn: () => unknown, config?: { name?: string }) => {
        state.stepNames.push(config?.name ?? '');
        // Execute the real registered scheduler up to its critical-probe return,
        // keeping database occupancy and loop-rebase effects private to this fixture.
        if (state.poolShedFixture && config?.name === 'routine-dispatch-feedback-epoch') {
          return { queues: [] };
        }
        if (state.poolShedFixture && config?.name === 'loop-rebase-sweep') return;
        const output = await fn();
        state.stepOutputs.push({ name: config?.name ?? '', output });
        return output;
      },
      registerWorkflow: (impl: unknown) => impl,
      registerScheduled: (impl: () => Promise<void>, config?: { name?: string; crontab?: string }) => {
        // WI-10000846: two scheduled ticks — keep each under its own name.
        state.scheduledCrontabs[config?.name ?? ''] = config?.crontab;
        if (config?.name === 'routinesSweepTick') state.scheduledSweepTick = impl;
        else state.scheduledTick = impl;
      },
      startWorkflow: state.startWorkflow,
    },
    DBOSClient: { create: state.createDbosClient },
  };
});

vi.mock('./idempotent-register-workflow', () => ({
  idempotentRegisterWorkflow: (_key: string, register: () => unknown) => register(),
  idempotentWorkflowQueue: (_key: string, construct: () => unknown) => construct(),
}));

vi.mock('./queue-concurrency', () => ({ queueConcurrency: (ceiling: number) => ceiling }));

vi.mock('./bootstrap', () => ({
  dbosStarted: () => state.dbosStarted,
  withDbosIdleTxGrace: (url: string) => `${url}?test-idle-grace`,
}));

vi.mock('../embedded-pg-discovery', () => ({
  getHarnessAdminUrlWithSource: () => ({ url: 'postgres://system-db' }),
}));

vi.mock('@papercusp/db-org', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@papercusp/db-org')>();
  return {
    ...actual,
    getOrgPg: () => ({
      sql: Object.assign(
        vi.fn(async (strings: unknown, ...values: unknown[]) => {
          state.sqlCalls.push({ text: Array.isArray(strings) ? strings.join('?') : String(strings), values });
          return { count: 0 };
        }),
        { begin: vi.fn() },
      ),
    }),
    listDueCronRoutines: vi.fn(async () => []),
  };
});

vi.mock('../workspace-als', () => ({
  runWithWorkspace: (_workspaceId: string, fn: () => unknown) => fn(),
  currentRequestWorkspaceId: () => 'routine-probe-fixture',
}));

vi.mock('../harness/routines/claim', () => ({
  claimDueRoutine: vi.fn(),
  claimedRoutineDispatchAllowed: vi.fn(async () => true),
}));

vi.mock('../harness/routines/loop-fire', () => ({
  fireLoopWake: vi.fn(async () => state.loopResult),
}));

vi.mock('./dbos-executor-reaper', () => ({
  clearStaleReaperLastError: vi.fn(async () => {}),
}));

vi.mock('./pool-pressure', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pool-pressure')>();
  return {
    ...actual,
    poolPressure: vi.fn(async () => 'critical'),
    lastPoolProbeMs: () => state.probe.admissionMs,
    lastPoolProbeRawMs: () => state.probe.rawMs,
    lastPoolProbeLoopDelayMs: () => state.probe.discountMs,
    recordPoolShedEvent: state.recordPoolShedEvent,
  };
});

vi.mock('../harness/routines/register-system-actions', () => ({}));
vi.mock('../harness/routines/configure-per-workspace', () => ({}));

import { fireLoopWake } from '../harness/routines/loop-fire';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { registerSystemAction } from '../harness/routines/system-actions';
import {
  createRoutineDispatchController,
  criticalLaneDemandFloor,
  evaluateRoutineDispatchEpoch,
  orderDueRoutinesByAge,
  ROUTINE_FIRE_QUEUES,
  ROUTINE_FIRE_TIMEOUT_MS,
  enqueueRoutineFire,
  routineFireTimeoutMs,
  routineFireWorkflow,
  learningLoopHealthSweepDbosStep,
} from './routines-workflow';
import {
  LOOP_WAKE_TARGET_ROLE,
  CRITICAL_ROUTINE_ACTIONS,
  FLEET_CONTROL_ACTIONS,
  HEAVY_ROUTINE_ACTIONS,
  ROUTINES_CRITICAL_QUEUE,
  ROUTINES_FLEET_CONTROL_QUEUE,
  ROUTINES_HEAVY_QUEUE,
  ROUTINES_LOOP_QUEUE,
  ROUTINES_QUEUE,
  TRIGGERS_QUEUE_ACTIONS,
  queueForRoutine,
} from './routines-queue-classification';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';
import { CaplessAdaptiveController } from '../resource-governor/controller';

beforeEach(() => {
  state.stepOutputs.length = 0;
  state.stepNames.length = 0;
  state.sqlCalls.length = 0;
  vi.clearAllMocks();
  state.poolShedFixture = false;
  state.dbosStarted = true;
  state.createDbosClient.mockResolvedValue({ enqueue: state.clientEnqueue });
  state.clientEnqueue.mockResolvedValue({ workflowID: 'routine:rt_home_git_sync' });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('evaluateRoutineDispatchEpoch — capless delayed-feedback admission (EI-224330)', () => {
  const START = 1_700_000_000_000;
  const queue = (epoch: ReturnType<typeof evaluateRoutineDispatchEpoch>, queueName: string) => {
    const found = epoch.queues.find((item) => item.queueName === queueName);
    if (!found) throw new Error(`missing ${queueName} decision`);
    return found;
  };

  it('regains git-sync dispatch capacity within the freshness window after a cold bg-host restart', () => {
    const controller = createRoutineDispatchController();
    const windows = Array.from({ length: 12 }, (_, tick) =>
      queue(
        evaluateRoutineDispatchEpoch({
          pressure: 'ok',
          probeMs: 4,
          inFlightByQueue: { [ROUTINES_CRITICAL_QUEUE]: 0 },
          activeQueues: [ROUTINES_CRITICAL_QUEUE],
          controller,
          atMs: START + tick * 30_000,
        }),
        ROUTINES_CRITICAL_QUEUE,
      ),
    );
    // A cold scheduler stays bounded while feedback is delayed, then reaches
    // the capacity needed to revisit 67 installs within a three-minute cycle.
    expect(windows.slice(0, 2).map((lane) => lane.availableStarts)).toEqual([1, 1]);
    expect(windows[11].availableStarts).toBeGreaterThanOrEqual(12);

    const critical = queue(
      evaluateRoutineDispatchEpoch({
        pressure: 'critical',
        probeMs: 2_800,
        inFlightByQueue: { [ROUTINES_CRITICAL_QUEUE]: 0 },
        activeQueues: [ROUTINES_CRITICAL_QUEUE],
        controller,
        atMs: START + 12 * 30_000,
      }),
      ROUTINES_CRITICAL_QUEUE,
    );
    expect(critical.availableStarts).toBe(1);
    // A zero-occupancy class has no attributed database demand to contract;
    // the explicit critical floor still prevents a recovered window bursting.
    expect(critical.desiredWindow).toBe(windows[11].desiredWindow);
  });

  it('bounds a many-clean-probe delayed-signal burst to current feedback credit', () => {
    const epoch = evaluateRoutineDispatchEpoch({
      pressure: 'ok',
      probeMs: 4,
      inFlightByQueue: {},
      activeQueues: [
        ROUTINES_QUEUE,
        ROUTINES_LOOP_QUEUE,
        ROUTINES_CRITICAL_QUEUE,
        ROUTINES_FLEET_CONTROL_QUEUE,
      ],
      controller: new CaplessAdaptiveController(),
      atMs: START,
    });

    // Live failure admitted 47 shared + 27 loop + 10 critical starts because each
    // immediate probe ran before its preceding async enqueue materialized. A cold
    // epoch has one start of feedback credit per active queue, regardless of how
    // many due rows the loop can enumerate synchronously.
    expect(queue(epoch, ROUTINES_QUEUE).availableStarts).toBe(1);
    expect(queue(epoch, ROUTINES_LOOP_QUEUE).availableStarts).toBe(1);
    expect(queue(epoch, ROUTINES_CRITICAL_QUEUE).availableStarts).toBe(1);
    expect(queue(epoch, ROUTINES_FLEET_CONTROL_QUEUE).availableStarts).toBe(1);
    expect([
      Math.min(47, queue(epoch, ROUTINES_QUEUE).availableStarts),
      Math.min(27, queue(epoch, ROUTINES_LOOP_QUEUE).availableStarts),
      Math.min(10, queue(epoch, ROUTINES_CRITICAL_QUEUE).availableStarts),
    ]).toEqual([1, 1, 1]);
  });

  it('earns new routine credit after three healthy ticks when a restart recovers six admitted fires', () => {
    const controller = createRoutineDispatchController();
    const epochs = Array.from({ length: 3 }, (_, tick) => evaluateRoutineDispatchEpoch({
      pressure: 'ok',
      probeMs: 4,
      inFlightByQueue: { [ROUTINES_QUEUE]: 6 },
      activeQueues: [ROUTINES_QUEUE, ROUTINES_LOOP_QUEUE],
      controller,
      atMs: START + tick * 30_000,
    }));
    expect(epochs.map(epoch => queue(epoch, ROUTINES_QUEUE).availableStarts)).toEqual([0, 0, 3]);
    // A busy class cannot bootstrap credit into an unrelated empty queue.
    expect(epochs.slice(0, 2).map(epoch => queue(epoch, ROUTINES_LOOP_QUEUE).availableStarts)).toEqual([1, 1]);
  });

  it('does not use recovered occupancy to lift a cold routine window under pool pressure', () => {
    for (const pressure of ['elevated', 'critical'] as const) {
      const epoch = evaluateRoutineDispatchEpoch({
        pressure,
        probeMs: pressure === 'critical' ? 2_800 : 800,
        inFlightByQueue: { [ROUTINES_QUEUE]: 6 },
        activeQueues: [ROUTINES_QUEUE],
        controller: createRoutineDispatchController(),
        atMs: START,
      });
      expect(queue(epoch, ROUTINES_QUEUE).desiredWindow).toBe(1);
      expect(queue(epoch, ROUTINES_QUEUE).availableStarts).toBe(0);
    }
  });

  it('probes upward without a configured maximum after sustained healthy epochs', () => {
    const controller = new CaplessAdaptiveController({ healthySamplesPerIncrease: 1 });
    const first = evaluateRoutineDispatchEpoch({
      pressure: 'ok',
      probeMs: 3,
      inFlightByQueue: {},
      activeQueues: [ROUTINES_QUEUE],
      controller,
      atMs: START,
    });
    const second = evaluateRoutineDispatchEpoch({
      pressure: 'ok',
      probeMs: 2,
      inFlightByQueue: {},
      activeQueues: [ROUTINES_QUEUE],
      controller,
      atMs: START + 30_000,
    });
    expect(queue(first, ROUTINES_QUEUE).desiredWindow).toBe(2);
    expect(queue(second, ROUTINES_QUEUE).desiredWindow).toBe(3);
  });

  // WI-10001738. `elevated` used to be actionable, so it contracted exactly like
  // `critical`. Contraction is multiplicative and recovery is +1 per healthy tick, so
  // with bg-host's measured 40min mix (75 ok / 22 elevated / 19 critical) the window was
  // knocked to its floor of 1 roughly every third tick and never rose above 3. At
  // window=1 a queue starts ONE routine per tick against ~50 git-sync installs, which
  // froze 30+ routines fleet-wide (worst 8h49m) and with them the green gate.
  it('HOLDS the window on elevated feedback instead of contracting it', () => {
    const controller = new CaplessAdaptiveController({ healthySamplesPerIncrease: 1 });
    const climb = [0, 1, 2].map((i) =>
      evaluateRoutineDispatchEpoch({
        pressure: 'ok',
        probeMs: 3,
        inFlightByQueue: { [ROUTINES_QUEUE]: 4 },
        activeQueues: [ROUTINES_QUEUE],
        controller,
        atMs: START + i * 30_000,
      }),
    );
    const climbed = queue(climb[2], ROUTINES_QUEUE).desiredWindow;
    expect(climbed).toBeGreaterThan(1);

    const elevated = evaluateRoutineDispatchEpoch({
      pressure: 'elevated',
      probeMs: 400,
      inFlightByQueue: { [ROUTINES_QUEUE]: 4 },
      activeQueues: [ROUTINES_QUEUE],
      controller,
      atMs: START + 3 * 30_000,
    });
    // The whole point: elevated must not TEAR THE WINDOW DOWN. Before the fix this
    // asserted equal-to-a-smaller-number; a revert makes it contract and fails here.
    expect(queue(elevated, ROUTINES_QUEUE).desiredWindow).toBe(climbed);

    // ...and it must still stop UPWARD probing — the early warning doing its job.
    const stillElevated = evaluateRoutineDispatchEpoch({
      pressure: 'elevated',
      probeMs: 500,
      inFlightByQueue: { [ROUTINES_QUEUE]: 4 },
      activeQueues: [ROUTINES_QUEUE],
      controller,
      atMs: START + 4 * 30_000,
    });
    expect(queue(stillElevated, ROUTINES_QUEUE).desiredWindow).toBe(climbed);
  });

  it('still contracts on critical, so the elevated hold is not a blanket opt-out', () => {
    const controller = new CaplessAdaptiveController({ healthySamplesPerIncrease: 1 });
    [0, 1, 2].forEach((i) =>
      evaluateRoutineDispatchEpoch({
        pressure: 'ok',
        probeMs: 3,
        inFlightByQueue: { [ROUTINES_QUEUE]: 4 },
        activeQueues: [ROUTINES_QUEUE],
        controller,
        atMs: START + i * 30_000,
      }),
    );
    const beforeCritical = evaluateRoutineDispatchEpoch({
      pressure: 'elevated',
      probeMs: 400,
      inFlightByQueue: { [ROUTINES_QUEUE]: 4 },
      activeQueues: [ROUTINES_QUEUE],
      controller,
      atMs: START + 3 * 30_000,
    });
    const held = queue(beforeCritical, ROUTINES_QUEUE).desiredWindow;

    const critical = evaluateRoutineDispatchEpoch({
      pressure: 'critical',
      probeMs: 2_800,
      inFlightByQueue: { [ROUTINES_QUEUE]: 2 },
      activeQueues: [ROUTINES_QUEUE],
      controller,
      atMs: START + 4 * 30_000,
    });
    expect(queue(critical, ROUTINES_QUEUE).desiredWindow).toBeLessThan(held);
  });

  it('multiplicatively contracts the database-attributed class on critical feedback', () => {
    const epoch = evaluateRoutineDispatchEpoch({
      pressure: 'critical',
      probeMs: 2_800,
      inFlightByQueue: { [ROUTINES_QUEUE]: 4 },
      activeQueues: [ROUTINES_QUEUE],
      controller: new CaplessAdaptiveController({ initialWindow: 8, contractionCooldownMs: 0 }),
      atMs: START,
    });
    expect(queue(epoch, ROUTINES_QUEUE)).toMatchObject({
      desiredWindow: 4,
      effectiveWindow: 4,
      controllerAvailableStarts: 0,
      availableStarts: 0,
      controllerProtected: false,
    });
  });

  // WI-10006946. Measured 2026-10-06 on the tower bg-host: the cold-started window sat at
  // 4-7 after restarts and critical halvings while 74 git-sync routines on a 10-min cron
  // needed ~8 concurrent fires; supply fell below demand and 31 routines went overdue.
  describe('critical-lane demand floor (WI-10006946)', () => {
    it('derives the floor from cron demand x tick-rounded mean run (Little’s law)', () => {
      // 74 routines x 6 fires/h + papercusp every 3 min (20/h) = 464 fires/h.
      // A 45 s mean run occupies a slot for two 30 s ticks: 464/h x 60 s = 7.73 -> 8.
      expect(
        criticalLaneDemandFloor({ firesPerHour: 464, routineCount: 75, meanRunMs: 45_000, tickMs: 30_000 }),
      ).toBe(8);
      // Slower fires need proportionally more concurrency.
      expect(
        criticalLaneDemandFloor({ firesPerHour: 464, routineCount: 75, meanRunMs: 95_000, tickMs: 30_000 }),
      ).toBe(16);
      // No finished fire yet: occupancy is one tick, never zero.
      expect(criticalLaneDemandFloor({ firesPerHour: 464, routineCount: 75, meanRunMs: null, tickMs: 30_000 })).toBe(4);
      // One routine can never have two fires in flight.
      expect(
        criticalLaneDemandFloor({ firesPerHour: 464, routineCount: 3, meanRunMs: 600_000, tickMs: 30_000 }),
      ).toBe(3);
      // No demand, no floor.
      expect(criticalLaneDemandFloor({ firesPerHour: 0, routineCount: 75, meanRunMs: 45_000, tickMs: 30_000 })).toBe(0);
      expect(criticalLaneDemandFloor({ firesPerHour: 464, routineCount: 0, meanRunMs: 45_000, tickMs: 30_000 })).toBe(0);
    });

    it('a cold controller admits the demand floor on its first tick instead of one start', () => {
      const epoch = evaluateRoutineDispatchEpoch({
        pressure: 'ok',
        probeMs: 4,
        inFlightByQueue: { [ROUTINES_CRITICAL_QUEUE]: 0 },
        activeQueues: [ROUTINES_CRITICAL_QUEUE],
        controller: createRoutineDispatchController(),
        atMs: START,
        minimumWindowByQueue: { [ROUTINES_CRITICAL_QUEUE]: 8 },
      });
      expect(queue(epoch, ROUTINES_CRITICAL_QUEUE)).toMatchObject({
        minimumWindow: 8,
        desiredWindow: 8,
        availableStarts: 8,
      });
    });

    it('elevated pressure holds at the floor rather than below it', () => {
      const epoch = evaluateRoutineDispatchEpoch({
        pressure: 'elevated',
        probeMs: 400,
        inFlightByQueue: { [ROUTINES_CRITICAL_QUEUE]: 3 },
        activeQueues: [ROUTINES_CRITICAL_QUEUE],
        controller: new CaplessAdaptiveController({ initialWindow: 4 }),
        atMs: START,
        minimumWindowByQueue: { [ROUTINES_CRITICAL_QUEUE]: 8 },
      });
      expect(queue(epoch, ROUTINES_CRITICAL_QUEUE).desiredWindow).toBe(8);
      expect(queue(epoch, ROUTINES_CRITICAL_QUEUE).availableStarts).toBe(5);
    });

    it('critical pressure still clamps the lane to one in-flight start, and contraction stops at the floor', () => {
      const controller = new CaplessAdaptiveController({ initialWindow: 16, contractionCooldownMs: 0 });
      const critical = evaluateRoutineDispatchEpoch({
        pressure: 'critical',
        probeMs: 2_800,
        inFlightByQueue: { [ROUTINES_CRITICAL_QUEUE]: 0 },
        activeQueues: [ROUTINES_CRITICAL_QUEUE],
        controller,
        atMs: START,
        minimumWindowByQueue: { [ROUTINES_CRITICAL_QUEUE]: 8 },
      });
      // The floor never widens what critical pressure admits.
      expect(queue(critical, ROUTINES_CRITICAL_QUEUE).availableStarts).toBe(1);

      const occupied = evaluateRoutineDispatchEpoch({
        pressure: 'critical',
        probeMs: 2_800,
        inFlightByQueue: { [ROUTINES_CRITICAL_QUEUE]: 12 },
        activeQueues: [ROUTINES_CRITICAL_QUEUE],
        controller,
        atMs: START + 30_000,
        minimumWindowByQueue: { [ROUTINES_CRITICAL_QUEUE]: 8 },
      });
      // An occupied, attributable lane halves 16 -> 8, and a second halving stops at 8.
      expect(queue(occupied, ROUTINES_CRITICAL_QUEUE).desiredWindow).toBe(8);
      expect(queue(occupied, ROUTINES_CRITICAL_QUEUE).availableStarts).toBe(0);
      const again = evaluateRoutineDispatchEpoch({
        pressure: 'critical',
        probeMs: 2_800,
        inFlightByQueue: { [ROUTINES_CRITICAL_QUEUE]: 12 },
        activeQueues: [ROUTINES_CRITICAL_QUEUE],
        controller,
        atMs: START + 60_000,
        minimumWindowByQueue: { [ROUTINES_CRITICAL_QUEUE]: 8 },
      });
      expect(queue(again, ROUTINES_CRITICAL_QUEUE).desiredWindow).toBe(8);

      // Without the floor the same feedback keeps halving: the floor is what holds it.
      const unfloored = new CaplessAdaptiveController({ initialWindow: 16, contractionCooldownMs: 0 });
      for (const atMs of [START, START + 30_000]) {
        evaluateRoutineDispatchEpoch({
          pressure: 'critical',
          probeMs: 2_800,
          inFlightByQueue: { [ROUTINES_CRITICAL_QUEUE]: 12 },
          activeQueues: [ROUTINES_CRITICAL_QUEUE],
          controller: unfloored,
          atMs,
        });
      }
      expect(unfloored.snapshot(START + 30_000).classes[0].desiredWindow).toBe(4);
    });

    it('other queues are unaffected by the critical-lane floor', () => {
      const epoch = evaluateRoutineDispatchEpoch({
        pressure: 'ok',
        probeMs: 4,
        inFlightByQueue: {},
        activeQueues: [ROUTINES_QUEUE, ROUTINES_CRITICAL_QUEUE],
        controller: new CaplessAdaptiveController(),
        atMs: START,
        minimumWindowByQueue: { [ROUTINES_CRITICAL_QUEUE]: 8 },
      });
      expect(queue(epoch, ROUTINES_QUEUE)).toMatchObject({ minimumWindow: 0, availableStarts: 1 });
      expect(queue(epoch, ROUTINES_CRITICAL_QUEUE).availableStarts).toBe(8);
    });
  });

  it('subtracts actual ENQUEUED/PENDING occupancy before admitting this tick', () => {
    const epoch = evaluateRoutineDispatchEpoch({
      pressure: 'ok',
      probeMs: 4,
      inFlightByQueue: { [ROUTINES_QUEUE]: 3 },
      activeQueues: [ROUTINES_QUEUE],
      controller: new CaplessAdaptiveController({ initialWindow: 5, healthySamplesPerIncrease: 99 }),
      atMs: START,
    });
    expect(queue(epoch, ROUTINES_QUEUE)).toMatchObject({
      desiredWindow: 5,
      inFlight: 3,
      availableStarts: 2,
    });
  });

  it('keeps exactly one critical liveness floor while retaining database attribution', () => {
    const controller = new CaplessAdaptiveController({ initialWindow: 16, contractionCooldownMs: 0 });
    const empty = evaluateRoutineDispatchEpoch({
      pressure: 'critical',
      probeMs: 3_000,
      inFlightByQueue: {},
      activeQueues: [ROUTINES_QUEUE, ROUTINES_CRITICAL_QUEUE],
      controller,
      atMs: START,
    });
    expect(queue(empty, ROUTINES_QUEUE).availableStarts).toBe(0);
    expect(queue(empty, ROUTINES_CRITICAL_QUEUE)).toMatchObject({
      availableStarts: 1,
      controllerProtected: false,
    });

    const occupied = evaluateRoutineDispatchEpoch({
      pressure: 'critical',
      probeMs: 3_100,
      inFlightByQueue: { [ROUTINES_CRITICAL_QUEUE]: 1 },
      activeQueues: [ROUTINES_CRITICAL_QUEUE],
      controller,
      atMs: START + 30_000,
    });
    expect(queue(occupied, ROUTINES_CRITICAL_QUEUE)).toMatchObject({
      inFlight: 1,
      availableStarts: 0,
      controllerProtected: false,
    });
    expect(queue(occupied, ROUTINES_CRITICAL_QUEUE).desiredWindow).toBeLessThan(16);
  });

  it('keeps the oldest due rows ahead of new arrivals when backlog grows faster than dispatch credits', () => {
    const due = Array.from({ length: 15 }, (_, index) => ({
      id: 'old-' + String(index).padStart(2, '0'),
      nextFireAt: new Date(index * 1_000),
      targetRole: 'system:git-sync',
      installSlug: 'papercusp',
    }));
    const firstEpoch = orderDueRoutinesByAge(due).slice(0, 4);
    const firstEpochIds = new Set(firstEpoch.map((row) => row.id));
    const nextEpochDue = [
      ...due.filter((row) => !firstEpochIds.has(row.id)),
      ...Array.from({ length: 8 }, (_, index) => ({
        id: 'new-0-' + index,
        nextFireAt: new Date(100_000 + index),
        targetRole: 'system:git-sync',
        installSlug: 'papercusp',
      })),
    ];
    const secondEpoch = orderDueRoutinesByAge(nextEpochDue).slice(0, 4);

    expect(firstEpoch.map((row) => row.id)).toEqual(['old-00', 'old-01', 'old-02', 'old-03']);
    expect(secondEpoch.map((row) => row.id)).toEqual(['old-04', 'old-05', 'old-06', 'old-07']);
  });

  it('reads indexed DBOS occupancy and gates feedback credit before claim/start', () => {
    const source = readFileSync(resolve(__dirname, 'routines-workflow.ts'), 'utf8');
    const reader =
      source.split('export async function readRoutineFireInFlightByQueue')[1]?.split('/** Direct physical')[0] ?? '';
    expect(reader).toContain('queue_name = ANY(${[...ROUTINE_FIRE_QUEUES]}::text[])');
    expect(reader).toContain("status IN ('ENQUEUED', 'PENDING')");
    expect(reader).toContain("name = 'routineFire'");
    expect(reader).toContain('GROUP BY queue_name');

    const impl = source.split('async function routinesTickImpl(): Promise<void> {')[1] ?? '';
    const epoch = impl.indexOf("name: 'routine-dispatch-feedback-epoch'");
    const dueByAge = impl.indexOf('const dueByAge = orderDueRoutinesByAge(due);');
    const loop = impl.indexOf('for (const r of dueByAge) {');
    const budget = impl.indexOf('const remainingStarts = remainingStartsByQueue.get(queueName) ?? 0');
    const claim = impl.indexOf('claimDueRoutine(sql, r)');
    const start = impl.indexOf('DBOS.startWorkflow');
    const spend = impl.indexOf('remainingStartsByQueue.set(queueName, remainingStarts - 1)');
    expect(epoch).toBeGreaterThan(-1);
    expect(epoch).toBeLessThan(dueByAge);
    expect(dueByAge).toBeLessThan(loop);
    expect(loop).toBeLessThan(budget);
    expect(budget).toBeLessThan(claim);
    expect(claim).toBeLessThan(start);
    expect(start).toBeLessThan(spend);
    expect(impl).not.toContain('evaluateRoutineDispatchAdmission');
  });
});

describe('routinesTickImpl — loop rebase survives critical pool shed (EI-21859486764076047)', () => {
  it('runs loop-rebase before the critical-shed early return', () => {
    const source = readFileSync(resolve(__dirname, 'routines-workflow.ts'), 'utf8');
    const shedSection = source.split('// EI-11171 critical-routine floor (cont.):')[1] ?? '';
    const branch = shedSection.match(/if \(poolCritical\) \{[\s\S]*?return;\n  \}/)?.[0] ?? '';
    expect(branch).toContain('await runLoopRebaseSweep(sql);');
    expect(source).toContain('async function runLoopRebaseSweep');
  });
});

describe('routinesTickImpl — probe evidence', () => {
  it.each([
    { name: 'slow completed probe', rawMs: 3000, admissionMs: 2500, discountMs: 500, netMs: 2500 },
    { name: 'timeout-floor admission', rawMs: 1000, admissionMs: 2000, discountMs: 500, netMs: 500 },
  ])('reports $name without asserting connection starvation', async (probe) => {
    state.poolShedFixture = true;
    state.probe = probe;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(state.scheduledTick).toBeTypeOf('function');
      await state.scheduledTick!();
      const warning = warn.mock.calls.find(([line]) => String(line).startsWith('[routines-tick]'));
      expect(warning).toBeDefined();
      const [line, detail] = warning!;
      expect(line).toContain('slow pool probe');
      expect(line).not.toMatch(/starvation|CPU-bound/);
      expect(detail).toMatchObject({
        probeRawMs: probe.rawMs,
        probeNetMs: probe.netMs,
        probeAdmissionMs: probe.admissionMs,
        loopP99DiscountMs: probe.discountMs,
        criticalProbeMs: 2000,
      });
      expect(detail.shedCount).toBeGreaterThan(0);
      expect(state.recordPoolShedEvent).toHaveBeenCalledWith(expect.any(String), detail.shedCount);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('WI-10000846 — dispatch is decoupled from the periodic sweeps', () => {
  it('schedules the dispatch tick and the sweep tick separately, offset from each other', () => {
    expect(state.scheduledTick).toBeTypeOf('function');
    expect(state.scheduledSweepTick).toBeTypeOf('function');
    expect(state.scheduledSweepTick).not.toBe(state.scheduledTick);
    expect(state.scheduledCrontabs).toMatchObject({
      routinesTick: '*/30 * * * * *',
      routinesSweepTick: '15,45 * * * * *',
    });
  });

  it('under a critical pool the dispatch tick runs no sweep; the sweep tick runs exactly the loop-rebase floor', async () => {
    state.poolShedFixture = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await state.scheduledTick!();
      // Positive control: the dispatch tick really ran its dispatch steps in this fixture.
      expect(state.stepNames).toContain('routine-dispatch-feedback-epoch');
      expect(state.stepNames).not.toContain('loop-rebase-sweep');
      state.stepNames.length = 0;
      await state.scheduledSweepTick!();
      expect(state.stepNames).toEqual(['loop-rebase-sweep']);
    } finally {
      warn.mockRestore();
    }
  });

  it('every DBOS step in routinesTickImpl is a dispatch step', () => {
    const source = readFileSync(resolve(__dirname, 'routines-workflow.ts'), 'utf8');
    const dispatch =
      source.split('async function routinesTickImpl(): Promise<void> {')[1]?.split('async function routinesSweepTickImpl')[0] ?? '';
    const stepNames = [...dispatch.matchAll(/\{\s*name:\s*'([^']+)'\s*\}/g)].map((m) => m[1]);
    // Positive control so an extraction miss cannot pass vacuously.
    expect(stepNames).toContain('claim-routine');
    // A sweep added here delays every dispatch slot by its runtime: put it in routinesSweepTickImpl.
    expect(new Set(stepNames)).toEqual(new Set(['list-due-routines', 'routine-dispatch-feedback-epoch', 'claim-routine']));
  });
});

describe('learning-loop-health-sweep — durable operation output', () => {
  it('returns the workspace-scoped classifier report as its DBOS step output', async () => {
    const report: LearningLoopHealthSweepReport = {
      schemaVersion: 'learning-loop-health-sweep/v1',
      workspaceId: 'papercusp-workspace',
      observedAtMs: 1_791_280_000_000,
      processStartedAtMs: 1_791_279_000_000,
      runStatus: 'completed',
      candidateCount: 1,
      candidates: [
        {
          blueprintId: 'regret',
          alwaysOn: true,
          singletonRow: null,
          legacyRow: null,
          collision: false,
          active: true,
          lastFiredAt: '2026-10-06T00:00:00.000Z',
          daysSinceFire: 0,
          activityLastAt: null,
          daysSinceActivity: null,
          activitySource: null,
          activityDetail: null,
          status: 'firing',
          expectedMaterialized: true,
          pauseAcknowledged: false,
          selectedForEscalation: false,
        },
      ],
      escalations: [],
    };
    await DBOS.runStep(() => learningLoopHealthSweepDbosStep(async () => report), {
      name: 'learning-loop-health-sweep',
    });
    expect(state.stepOutputs).toContainEqual({ name: 'learning-loop-health-sweep', output: report });

    const source = readFileSync(resolve(__dirname, 'routines-workflow.ts'), 'utf8');
    const stepAt = source.lastIndexOf("await DBOS.runStep(", source.indexOf("{ name: 'learning-loop-health-sweep' }"));
    const stepEnd = source.indexOf("{ name: 'learning-loop-health-sweep' }", stepAt);
    const step = source.slice(stepAt, stepEnd);

    expect(stepAt).toBeGreaterThan(-1);
    expect(stepEnd).toBeGreaterThan(stepAt);
    expect(step).toContain('learningLoopHealthSweepDbosStep');
  });
});

describe('routineFireWorkflow — durable loop:wake output', () => {
  it('registers every isolated routine lane at boot', () => {
    // Every lane queueForRoutine can return MUST be registered here, or a fire enqueued
    // onto it is never consumed (WI-41662 added routines-triggers).
    expect(ROUTINE_FIRE_QUEUES).toEqual([
      'routines',
      'routines-heavy',
      'routines-critical',
      'routines-fleet-control',
      'routines-loop',
      'routines-triggers',
      'routines-release',
      'routines-deploy',
    ]);
  });

  // Recurrence guard (WI-41662). Adding a lane is TWO edits — route to it in
  // queueForRoutine, and register it here so DBOS listens. Doing only the first
  // enqueues fires onto a queue nothing consumes: the routine then never runs at
  // all, and — exactly like the starvation this lane was added to fix — nothing
  // fails and last_fired_at keeps advancing, so it reads perfectly healthy.
  // Drive the classifier over every routable target and assert its lane is registered.
  it('registers EVERY lane queueForRoutine can return (no routable-but-unconsumed queue)', () => {
    const routableTargets = [
      LOOP_WAKE_TARGET_ROLE,
      ...[...CRITICAL_ROUTINE_ACTIONS].map((a) => `system:${a}`),
      ...[...FLEET_CONTROL_ACTIONS].map((a) => `system:${a}`),
      ...[...HEAVY_ROUTINE_ACTIONS].map((a) => `system:${a}`),
      ...[...TRIGGERS_QUEUE_ACTIONS].map((a) => `system:${a}`),
      'system:green-checkpoint',
      'mug',
      '',
    ];
    for (const target of routableTargets) {
      expect(ROUTINE_FIRE_QUEUES).toContain(queueForRoutine(target));
    }
    expect(queueForRoutine('system:gitnexus-reindex')).toBe(ROUTINES_HEAVY_QUEUE);
    expect(queueForRoutine('system:work-item-admission-bulk-dedup')).toBe(ROUTINES_HEAVY_QUEUE);
    expect(ROUTINE_FIRE_QUEUES).toContain(queueForRoutine('system:green-checkpoint', operatorHomeHarnessSlug()));
  });

  it('checkpoints and returns the complete LoopFireResult from the DBOS step', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await routineFireWorkflow(
      'rt_papercusp_loop_su-pinned',
      'papercusp-workspace',
      'papercusp',
      'su',
      {},
      { carry: 'cold' },
      'loop-su-pinned',
      300,
      'su-pinned',
    );

    expect(fireLoopWake).toHaveBeenCalledWith({
      routineId: 'rt_papercusp_loop_su-pinned',
      routineName: 'loop-su-pinned',
      workspaceId: 'papercusp-workspace',
      installSlug: 'papercusp',
      targetOwnerId: 'su-pinned',
      payloadTemplate: { carry: 'cold' },
      intervalSec: 300,
    });
    expect(state.stepOutputs).toEqual([
      {
        name: 'routine-fire-start',
        output: {
          routineId: 'rt_papercusp_loop_su-pinned',
          workspaceId: 'papercusp-workspace',
          installSlug: 'papercusp',
          targetRole: 'su',
          routineName: 'loop-su-pinned',
        },
      },
      { name: 'routine-fire-active-fence', output: true },
      { name: 'loop:wake', output: state.loopResult },
      { name: 'clear-reaper-last-error', output: undefined },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fire WITHHELD (await-blocking'));
    warn.mockRestore();
  });

  it('passes the exact routine and DBOS workflow identities to scheduled system actions', async () => {
    const action = vi.fn(async () => undefined);
    registerSystemAction('test-routine-fire-identity', action, { scheduling: 'on-demand' });

    await routineFireWorkflow(
      'rt_papercusp_test_identity',
      'papercusp-workspace',
      'papercusp',
      'system:test-routine-fire-identity',
      {},
      null,
    );

    expect(action).toHaveBeenCalledWith(expect.objectContaining({
      routineId: 'rt_papercusp_test_identity',
      workflowId: 'test-routine-fire',
    }));
  });

  // WI-10004472 recurrence guard. A multi-step (ownSteps) action whose DBOS recovery
  // replay could not reproduce its recorded step sequence reports `replayAbandoned`.
  // Any further DBOS operation in that fire lands on a function id recorded under a
  // different name and fails the workflow with DBOSUnexpectedStepError, so the engine
  // must end the fire with NO settle and NO clear-reaper-last-error step.
  it('ends an ownSteps fire with no further DBOS step when the action abandons its replay (WI-10004472)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const action = vi.fn(async () => ({ replayAbandoned: { reason: 'exclusive_pending' } }));
    registerSystemAction('test-replay-abandoned', action, { ownSteps: true, scheduling: 'on-demand' });

    await routineFireWorkflow(
      'rt_papercusp_test_replay_abandoned',
      'papercusp-workspace',
      'papercusp',
      'system:test-replay-abandoned',
      {},
      null,
    );

    expect(action).toHaveBeenCalledTimes(1);
    expect(state.stepOutputs.map((s) => s.name)).toEqual(['routine-fire-start', 'routine-fire-active-fence']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('recovery replay ABANDONED (exclusive_pending)'));
    warn.mockRestore();
  });

  it('control: an ownSteps fire that completes normally still records its settle and reaper-clear steps', async () => {
    const action = vi.fn(async () => undefined);
    registerSystemAction('test-replay-completes', action, { ownSteps: true, scheduling: 'on-demand' });

    await routineFireWorkflow(
      'rt_papercusp_test_replay_completes',
      'papercusp-workspace',
      'papercusp',
      'system:test-replay-completes',
      {},
      null,
    );

    expect(state.stepOutputs.map((s) => s.name)).toEqual([
      'routine-fire-start',
      'routine-fire-active-fence',
      'system:test-replay-completes:settle',
      'clear-reaper-last-error',
    ]);
  });

  // WI-10005164 recurrence guard: a fail-soft sub-pass failure (`softError`) must reach
  // `last_error` without failing the fire. Before it, task-reconcile's lifecycle sweep
  // threw on every pass for a day while the routine's last_error stayed empty.
  const lastErrorWrites = () =>
    state.sqlCalls.filter((c) => c.text.includes("jsonb_build_object('last_error'"));
  const lastErrorClears = () => state.sqlCalls.filter((c) => c.text.includes("- 'last_error'"));

  it('records a single-step action softError as runner last_error, and does not clear it (WI-10005164)', async () => {
    registerSystemAction('test-soft-error', vi.fn(async () => ({ softError: 'task-lifecycle sub-pass failing' })), {
      scheduling: 'on-demand',
    });

    await routineFireWorkflow('rt_papercusp_test_soft', 'papercusp-workspace', 'papercusp', 'system:test-soft-error', {}, null);

    expect(lastErrorWrites().map((c) => c.values)).toEqual([['task-lifecycle sub-pass failing', 'rt_papercusp_test_soft']]);
    expect(lastErrorClears()).toEqual([]);
  });

  it('records an ownSteps action softError in its settle step, with the same step sequence (WI-10005164)', async () => {
    registerSystemAction('test-soft-error-own', vi.fn(async () => ({ softError: 'sub-pass failing' })), {
      ownSteps: true,
      scheduling: 'on-demand',
    });

    await routineFireWorkflow('rt_papercusp_test_soft_own', 'papercusp-workspace', 'papercusp', 'system:test-soft-error-own', {}, null);

    expect(state.stepOutputs.map((s) => s.name)).toEqual([
      'routine-fire-start',
      'routine-fire-active-fence',
      'system:test-soft-error-own:settle',
      'clear-reaper-last-error',
    ]);
    expect(lastErrorWrites().map((c) => c.values)).toEqual([['sub-pass failing', 'rt_papercusp_test_soft_own']]);
    expect(lastErrorClears()).toEqual([]);
  });

  it('control: a clean single-step fire clears runner last_error and writes none', async () => {
    registerSystemAction('test-soft-error-clean', vi.fn(async () => ({ diagnostics: { ok: true } })), {
      scheduling: 'on-demand',
    });

    await routineFireWorkflow('rt_papercusp_test_clean', 'papercusp-workspace', 'papercusp', 'system:test-soft-error-clean', {}, null);

    expect(lastErrorWrites()).toEqual([]);
    expect(lastErrorClears()).toHaveLength(1);
  });
});

describe('enqueueRoutineFire — on-demand durable dispatch', () => {
  const routine = {
    id: 'rt_home_git_sync',
    workspaceId: 'workspace-1',
    installSlug: 'home',
    name: 'git-sync',
    targetRole: 'system:git-sync',
    triggerConfig: { cron: '*/3 * * * * *' },
    payloadTemplate: null,
    rescheduleIntervalSec: null,
    targetOwnerId: null,
  } as Parameters<typeof enqueueRoutineFire>[0];

  it('uses the live routine dispatch classification and stable deduplication key', async () => {
    const result = await enqueueRoutineFire(routine);

    expect(result).toMatchObject({
      ok: true,
      status: 'enqueued',
      routineId: routine.id,
      deduplicationId: `routine:${routine.id}`,
      queueName: ROUTINES_CRITICAL_QUEUE,
    });
    expect(state.startWorkflow).toHaveBeenCalledWith(
      routineFireWorkflow,
      expect.objectContaining({
        queueName: ROUTINES_CRITICAL_QUEUE,
        enqueueOptions: { deduplicationID: `routine:${routine.id}` },
      }),
    );
  });

  it('reports an active DBOS deduplication conflict as already queued', async () => {
    state.startWorkflow.mockImplementationOnce(() => {
      throw Object.assign(new Error('duplicate workflow'), { dbosErrorCode: 28 });
    });

    await expect(enqueueRoutineFire(routine)).resolves.toMatchObject({
      ok: true,
      status: 'deduplicated',
      deduplicationId: `routine:${routine.id}`,
    });
  });

  it('uses a pinned DBOS client when the request host has no local DBOS runtime', async () => {
    state.dbosStarted = false;
    vi.stubEnv('PAPERCUSP_HOSTED_PROVISIONING_DBOS_APP_VERSION', '');
    vi.stubEnv('DBOS__APPVERSION', '');

    await expect(enqueueRoutineFire(routine)).resolves.toMatchObject({
      ok: true,
      status: 'enqueued',
      deduplicationId: `routine:${routine.id}`,
    });
    expect(state.createDbosClient).toHaveBeenCalledWith({
      systemDatabaseUrl: 'postgres://system-db?test-idle-grace',
      systemDatabaseSchemaName: 'dbos',
    });
    expect(state.clientEnqueue).toHaveBeenCalledWith(
      {
        queueName: ROUTINES_CRITICAL_QUEUE,
        workflowName: 'routineFire',
        deduplicationID: `routine:${routine.id}`,
        workflowTimeoutMS: routineFireTimeoutMs(routine.targetRole),
        appVersion: 'bg-host-v1',
      },
      routine.id,
      routine.workspaceId,
      routine.installSlug,
      routine.targetRole,
      routine.triggerConfig,
      routine.payloadTemplate,
      routine.name,
      routine.rescheduleIntervalSec,
      routine.targetOwnerId,
    );
    expect(state.startWorkflow).not.toHaveBeenCalled();
  });

  it('uses the configured DBOS primary version when present', async () => {
    state.dbosStarted = false;
    vi.stubEnv('PAPERCUSP_HOSTED_PROVISIONING_DBOS_APP_VERSION', 'primary-v2');

    await enqueueRoutineFire(routine);

    expect(state.clientEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ appVersion: 'primary-v2' }),
      routine.id,
      routine.workspaceId,
      routine.installSlug,
      routine.targetRole,
      routine.triggerConfig,
      routine.payloadTemplate,
      routine.name,
      routine.rescheduleIntervalSec,
      routine.targetOwnerId,
    );
  });

  it('treats a DBOS client deduplication conflict as already queued', async () => {
    state.dbosStarted = false;
    state.clientEnqueue.mockRejectedValueOnce(
      Object.assign(new Error('duplicate workflow'), { dbosErrorCode: 28 }),
    );

    await expect(enqueueRoutineFire(routine)).resolves.toMatchObject({
      ok: true,
      status: 'deduplicated',
      deduplicationId: `routine:${routine.id}`,
    });
    expect(state.startWorkflow).not.toHaveBeenCalled();
  });
});

describe('routineFireTimeoutMs — per-action deadline seam', () => {
  it('uses a registered long-action deadline while retaining the two-hour default elsewhere', () => {
    const longTimeout = 24 * 60 * 60_000;
    registerSystemAction('test-long-running-routine', async () => {}, { routineTimeoutMs: longTimeout });

    expect(routineFireTimeoutMs('system:test-long-running-routine')).toBe(longTimeout);
    expect(routineFireTimeoutMs('system:unknown-action')).toBe(ROUTINE_FIRE_TIMEOUT_MS);
    expect(routineFireTimeoutMs('agent-role')).toBe(ROUTINE_FIRE_TIMEOUT_MS);
  });

  it('fails closed on an absent, non-positive, fractional, or unsafe configured value', () => {
    registerSystemAction('test-invalid-routine-timeout', async () => {}, { routineTimeoutMs: 0 });
    registerSystemAction('test-fractional-routine-timeout', async () => {}, { routineTimeoutMs: 1.5 });
    registerSystemAction('test-unsafe-routine-timeout', async () => {}, {
      routineTimeoutMs: Number.MAX_SAFE_INTEGER + 1,
    });

    expect(routineFireTimeoutMs('system:test-invalid-routine-timeout')).toBe(ROUTINE_FIRE_TIMEOUT_MS);
    expect(routineFireTimeoutMs('system:test-fractional-routine-timeout')).toBe(ROUTINE_FIRE_TIMEOUT_MS);
    expect(routineFireTimeoutMs('system:test-unsafe-routine-timeout')).toBe(ROUTINE_FIRE_TIMEOUT_MS);
  });
});
