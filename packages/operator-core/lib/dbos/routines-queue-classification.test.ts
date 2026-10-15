import { describe, it, expect } from 'vitest';
import {
  ROUTINES_QUEUE,
  ROUTINES_CRITICAL_QUEUE,
  ROUTINES_FLEET_CONTROL_QUEUE,
  ROUTINES_LOOP_QUEUE,
  ROUTINES_RELEASE_QUEUE,
  ROUTINES_DEPLOY_QUEUE,
  ROUTINES_TRIGGERS_QUEUE,
  ROUTINES_HEAVY_QUEUE,
  LOOP_WAKE_TARGET_ROLE,
  CRITICAL_ROUTINE_ACTIONS,
  FLEET_CONTROL_ACTIONS,
  TRIGGER_POLL_ACTIONS,
  TRIGGERS_QUEUE_ACTIONS,
  HEAVY_ROUTINE_ACTIONS,
  DEPLOY_TRIGGER_ACTIONS,
  queueForRoutine,
  shouldFireUnderPoolShed,
} from './routines-queue-classification';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';

/**
 * 2026-06-23 routines-queue-starvation fix: must-never-starve quick actions land on the protected
 * `routines-critical` lane so a saturated shared `routines` queue (long routines holding every slot) cannot
 * starve git-sync (the 7h deploy-freeze) or the deterministic admission floor. EI-21386288922867645 adds a
 * separate latency-isolated loop lane after a five-minute loop
 * sat behind the shared queue for ~11 minutes. Long/unknown system actions and agent roles still default to
 * the shared queue, so neither protected lane can be silently occupied by a new arbitrary routine.
 */
describe('queueForRoutine — the protected critical lane', () => {
  it('routes the critical system action (git-sync) to the protected lane', () => {
    expect(queueForRoutine('system:git-sync')).toBe(ROUTINES_CRITICAL_QUEUE);
    expect(queueForRoutine('system:work-item-admission-fail-open')).toBe(ROUTINES_CRITICAL_QUEUE);
    expect(queueForRoutine('system:work-item-admission-promoter')).toBe(ROUTINES_QUEUE);
  });

  it('routes EVERY critical action in the set to the protected lane', () => {
    for (const action of CRITICAL_ROUTINE_ACTIONS) {
      expect(queueForRoutine(`system:${action}`)).toBe(ROUTINES_CRITICAL_QUEUE);
    }
  });

  it('routes a LONG system action (green-checkpoint, gym, blueprint-run) to the shared queue', () => {
    expect(queueForRoutine('system:green-checkpoint')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('system:gym-cycle')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('system:blueprint-run')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('system:idle-session-reaper')).toBe(ROUTINES_QUEUE);
  });

  it('routes an agent-role routine (non-system target) to the shared queue', () => {
    expect(queueForRoutine('mug')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('worker')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('')).toBe(ROUTINES_QUEUE);
  });

  it('a NON-critical system action whose name merely CONTAINS a critical one is NOT protected (exact match)', () => {
    expect(queueForRoutine('system:git-sync-status')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('system:pre-git-sync')).toBe(ROUTINES_QUEUE);
  });

  it('the protected set contains only the must-never-starve quick actions', () => {
    expect([...CRITICAL_ROUTINE_ACTIONS]).toEqual(['git-sync', 'work-item-admission-fail-open']);
  });
});

describe('queueForRoutine — the latency-isolated loop lane', () => {
  it('routes the exact materialized loop-wake target to routines-loop', () => {
    expect(LOOP_WAKE_TARGET_ROLE).toBe('system:loop-wake');
    expect(queueForRoutine(LOOP_WAKE_TARGET_ROLE)).toBe(ROUTINES_LOOP_QUEUE);
  });

  it('keeps near-miss target names on the shared queue (exact match)', () => {
    expect(queueForRoutine('system:loop-wake-status')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('system:pre-loop-wake')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('loop-wake')).toBe(ROUTINES_QUEUE);
  });
});

describe('queueForRoutine — the fleet-control lane (EI-22526486100493483)', () => {
  it('routes every fleet-control action to its dedicated lane', () => {
    expect([...FLEET_CONTROL_ACTIONS]).toEqual([
      'fleet-headcount-governor',
      'fleet-transition-sweep',
      'presence-transition-sweep',
    ]);
    for (const action of FLEET_CONTROL_ACTIONS) {
      expect(queueForRoutine(`system:${action}`)).toBe(ROUTINES_FLEET_CONTROL_QUEUE);
    }
  });

  it('keeps near-miss and unrelated long actions on the shared lane', () => {
    expect(queueForRoutine('system:fleet-headcount-governor-status')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('system:pre-fleet-headcount-governor')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('system:blueprint-run')).toBe(ROUTINES_QUEUE);
  });

  it('does not widen the critical pool-pressure floor', () => {
    expect(shouldFireUnderPoolShed('system:fleet-headcount-governor')).toBe(false);
    expect(CRITICAL_ROUTINE_ACTIONS.has('fleet-headcount-governor')).toBe(false);
  });
});

describe('queueForRoutine — operator-home release-finalizer lane (EI-21446637172005297)', () => {
  it('routes the operator-home green-checkpoint away from four saturated subject-hive slots', () => {
    const home = operatorHomeHarnessSlug();
    expect(queueForRoutine('system:green-checkpoint', home)).toBe(ROUTINES_RELEASE_QUEUE);

    for (const subjectHive of ['sidestage', 'calendar', 'thornbury-iphone', 'hello-world-3']) {
      expect(queueForRoutine('system:green-checkpoint', subjectHive)).toBe(ROUTINES_QUEUE);
    }
  });

  it('does not widen the dedicated lane to other home-hive work or near-miss actions', () => {
    const home = operatorHomeHarnessSlug();
    expect(queueForRoutine('system:gym-cycle', home)).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('system:green-checkpoint-status', home)).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('green-checkpoint', home)).toBe(ROUTINES_QUEUE);
  });

  it('keeps an unscoped green-checkpoint on the shared lane (fail closed)', () => {
    expect(queueForRoutine('system:green-checkpoint')).toBe(ROUTINES_QUEUE);
  });
});

describe('queueForRoutine — bounded heavy/background lane (EI-22469496587311452)', () => {
  it('routes the exact gitnexus reindex action to the serial heavy lane', () => {
    expect([...HEAVY_ROUTINE_ACTIONS]).toEqual(['gitnexus-reindex', 'work-item-admission-bulk-dedup']);
    expect(queueForRoutine('system:gitnexus-reindex')).toBe(ROUTINES_HEAVY_QUEUE);
  });

  // D-005 (work-queue-bulk-cleanup-remediation-2026-10-01): a bulk-dedup stage held a
  // shared-queue slot for 1h53m while the window was 3, and 117 cron routines went
  // overdue. Its fires must never share the housekeeping lane again.
  it('routes bulk-dedup to heavy, protects fail-open, and keeps other admission actions shared', () => {
    expect(queueForRoutine('system:work-item-admission-bulk-dedup')).toBe(ROUTINES_HEAVY_QUEUE);
    expect(queueForRoutine('system:work-item-admission-fail-open')).toBe(ROUTINES_CRITICAL_QUEUE);
    expect(queueForRoutine('system:work-item-admission-promoter')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('system:work-item-admission-bulk-dedup-census')).toBe(ROUTINES_QUEUE);
  });

  it('keeps near-miss and non-system targets on the shared queue (exact match)', () => {
    expect(queueForRoutine('system:gitnexus-reindex-status')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('system:pre-gitnexus-reindex')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('gitnexus-reindex')).toBe(ROUTINES_QUEUE);
  });

  it('does not widen the critical pool-pressure floor', () => {
    expect(shouldFireUnderPoolShed('system:gitnexus-reindex')).toBe(false);
    expect(CRITICAL_ROUTINE_ACTIONS.has('gitnexus-reindex')).toBe(false);
  });
});

/**
 * EI-23909857328600541 (measured 2026-09-22T01:50Z): release-trigger — the ONLY thing that
 * promotes a green `main` to the live operator — fell through to the shared `routines` lane.
 * Two unrelated fires on that lane (orphaned-mcp-reaper, gate-watcher-tick) sat PENDING for
 * 49 and 37 minutes; because ROUTINE_FIRE_TIMEOUT_MS is 2h a hung fire keeps its durable slot
 * that long, so the dispatch epoch reported `inFlight=3, available=0` and withheld
 * release-trigger indefinitely. 41 routines were overdue and 426 green commits sat undeployed
 * behind a live certification that nothing remained to launch. Same starvation shape as
 * git-sync (2026-06-23), the loop lane, and the trigger polls — so it gets the same remedy.
 */
describe('queueForRoutine — the deploy-launcher lane (EI-23909857328600541)', () => {
  it('routes the deploy launcher off the shared lane onto its own', () => {
    expect(queueForRoutine('system:release-trigger')).toBe(ROUTINES_DEPLOY_QUEUE);
    expect(queueForRoutine('system:release-trigger')).not.toBe(ROUTINES_QUEUE);
  });

  it('keeps the set exact — near-miss and non-system targets stay shared', () => {
    expect([...DEPLOY_TRIGGER_ACTIONS]).toEqual(['release-trigger']);
    expect(queueForRoutine('system:release-trigger-status')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('system:pre-release-trigger')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('release-trigger')).toBe(ROUTINES_QUEUE);
  });

  it('does NOT ride the critical lane, whose actions must be quick and must-never-starve', () => {
    expect(CRITICAL_ROUTINE_ACTIONS.has('release-trigger')).toBe(false);
    expect(queueForRoutine('system:release-trigger')).not.toBe(ROUTINES_CRITICAL_QUEUE);
    expect(shouldFireUnderPoolShed('system:release-trigger')).toBe(false);
  });

  it('does NOT share the serial release lane with the ~25m home green-checkpoint', () => {
    // routines-release is serial for the home finalizer; a 15-minute trigger queued behind
    // a ~25-minute gate fire would be starved by construction.
    expect(queueForRoutine('system:release-trigger')).not.toBe(ROUTINES_RELEASE_QUEUE);
    expect(queueForRoutine('system:green-checkpoint', operatorHomeHarnessSlug())).toBe(
      ROUTINES_RELEASE_QUEUE,
    );
  });

  it('isolates the launcher from the lanes that actually starved it', () => {
    // The two fires that held the slots, and the third stuck lane, must all resolve
    // somewhere other than the deploy lane.
    for (const starver of ['system:orphaned-mcp-reaper', 'system:gate-watcher-tick']) {
      expect(queueForRoutine(starver)).toBe(ROUTINES_QUEUE);
      expect(queueForRoutine(starver)).not.toBe(ROUTINES_DEPLOY_QUEUE);
    }
    expect(queueForRoutine('system:connector-sync')).toBe(ROUTINES_TRIGGERS_QUEUE);
  });
});

/**
 * WI-41662: external-source polls starved 4–18min EVERY HOUR behind green-checkpoint's ~25m
 * hourly fire on the shared queue (13 stalls in one measured day, onset clock-locked to :14–:16
 * past the hour, both Google polls freezing and resuming together while git-sync's dedicated
 * lane ran through). These polls are quick and per-minute, and their latency IS the product
 * behaviour, so they get a bounded lane on the same principle as routines-loop.
 */
describe('queueForRoutine — the external-source poll lane (WI-41662)', () => {
  it('routes EVERY trigger-poll action to the dedicated lane', () => {
    for (const action of TRIGGER_POLL_ACTIONS) {
      expect(queueForRoutine(`system:${action}`)).toBe(ROUTINES_TRIGGERS_QUEUE);
    }
  });

  it('routes the measured-starved polls specifically (the regression this lane exists for)', () => {
    // Gmail (P-008) and Google Calendar (P-009) sync moved onto the provider connector, so
    // their lane is connector-sync's.
    expect(queueForRoutine('system:connector-sync')).toBe(ROUTINES_TRIGGERS_QUEUE);
  });

  it('keeps the LONG routine that starved them OFF this lane — else the starvation returns inside it', () => {
    expect(queueForRoutine('system:green-checkpoint')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('system:gym-cycle')).toBe(ROUTINES_QUEUE);
  });

  it('keeps near-miss names on the shared queue (exact match)', () => {
    expect(queueForRoutine('system:connector-sync-status')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('system:pre-pr-poll')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('connector-sync')).toBe(ROUTINES_QUEUE);
  });

  it('does NOT widen the critical floor — a poll still sheds under PG-pool pressure', () => {
    for (const action of TRIGGER_POLL_ACTIONS) {
      expect(shouldFireUnderPoolShed(`system:${action}`)).toBe(false);
    }
  });

  it('the poll lane and the critical lane are disjoint sets', () => {
    for (const action of TRIGGER_POLL_ACTIONS) {
      expect(CRITICAL_ROUTINE_ACTIONS.has(action)).toBe(false);
    }
  });
});

describe('queueForRoutine — bounded trigger and import handlers', () => {
  it('routes trigger dispatch and personal-vault import with the existing source-poll lane', () => {
    expect([...TRIGGERS_QUEUE_ACTIONS]).toEqual([
      ...TRIGGER_POLL_ACTIONS,
      'external-trigger-dispatch',
      'personal-vault-import',
    ]);
    for (const action of ['external-trigger-dispatch', 'personal-vault-import']) {
      expect(queueForRoutine(`system:${action}`)).toBe(ROUTINES_TRIGGERS_QUEUE);
      expect(shouldFireUnderPoolShed(`system:${action}`)).toBe(false);
      expect(CRITICAL_ROUTINE_ACTIONS.has(action)).toBe(false);
    }
  });

  it('keeps unrelated and near-miss handlers on the ordinary queue', () => {
    expect(queueForRoutine('system:external-trigger-dispatch-status')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('system:personal-vault-import-status')).toBe(ROUTINES_QUEUE);
    expect(queueForRoutine('system:blueprint-run')).toBe(ROUTINES_QUEUE);
  });
});

/**
 * EI-11171 critical-routine floor: when routinesTickImpl sheds on critical PG-pool starvation it
 * must still fire the protected critical-queue routine (git-sync) — the old bare `return` skipped
 * the whole fire loop and silently re-armed the 7h git-sync-starvation freeze class. This predicate
 * is the floor: exactly the protected lane fires under a shed; everything else sheds with the sweeps.
 */
describe('shouldFireUnderPoolShed — the critical-routine floor (EI-11171)', () => {
  it('FIRES git-sync under a shed (the must-never-starve floor)', () => {
    expect(shouldFireUnderPoolShed('system:git-sync')).toBe(true);
    expect(shouldFireUnderPoolShed('system:work-item-admission-fail-open')).toBe(true);
    expect(shouldFireUnderPoolShed('system:work-item-admission-promoter')).toBe(false);
  });

  it('FIRES every protected critical action under a shed', () => {
    for (const action of CRITICAL_ROUTINE_ACTIONS) {
      expect(shouldFireUnderPoolShed(`system:${action}`)).toBe(true);
    }
  });

  it('SHEDS every non-critical routine (long system actions, agent roles) under a shed', () => {
    expect(shouldFireUnderPoolShed('system:green-checkpoint')).toBe(false);
    expect(shouldFireUnderPoolShed('system:gym-cycle')).toBe(false);
    expect(shouldFireUnderPoolShed('system:blueprint-run')).toBe(false);
    expect(shouldFireUnderPoolShed(LOOP_WAKE_TARGET_ROLE)).toBe(false);
    expect(shouldFireUnderPoolShed('mug')).toBe(false);
    expect(shouldFireUnderPoolShed('worker')).toBe(false);
    expect(shouldFireUnderPoolShed('')).toBe(false);
  });

  it('SHEDS a near-miss name that merely contains a critical action (exact match, no false floor)', () => {
    expect(shouldFireUnderPoolShed('system:git-sync-status')).toBe(false);
    expect(shouldFireUnderPoolShed('system:pre-git-sync')).toBe(false);
  });

  it('is exactly the protected-lane predicate (floor === critical queue)', () => {
    for (const role of ['system:git-sync', LOOP_WAKE_TARGET_ROLE, 'system:green-checkpoint', 'mug', '']) {
      expect(shouldFireUnderPoolShed(role)).toBe(
        queueForRoutine(role) === ROUTINES_CRITICAL_QUEUE,
      );
    }
  });
});
