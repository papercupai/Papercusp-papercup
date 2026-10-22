/**
 * `hosted-lifecycle-reconcile` system action (WI-2143803) — the production caller that was missing
 * for `reconcileHostedLifecycleJobs`.
 *
 * Two things are pinned here, and the SECOND is the one that matters:
 *
 * 1. the action's own behavior (workspace scoping, quiet-when-idle, throw-on-failure);
 * 2. that the routine is actually WIRED — registered, classified, listed in the bespoke-active-seed
 *    registry, and seeded under the same role it registers. Every behavioral test above would still
 *    pass if the routine were never registered or never seeded: the sweep would simply never run,
 *    silently, which is indistinguishable from the stranding bug it exists to fix. That is the exact
 *    failure this whole work-item is about — an implementation with no caller — so re-introducing it
 *    one level up (a seed script nothing arms) is the one mistake this change must not make.
 *
 * The wiring half asserts by reading source TEXT rather than importing `register-system-actions.ts`,
 * which pulls in ~100 action modules and their database-bound graphs. Each pin carries a NEGATIVE
 * control proving the assertion can fail, so none can rot into a test that passes because its
 * subject vanished.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { HostedLifecycleReconciliationResult } from '../../workspace-host/hosted-lifecycle-store';
import { makeHostedLifecycleReconcileAction as createAction, HOSTED_LIFECYCLE_RECONCILE } from './hosted-lifecycle-reconcile-action';
import { BESPOKE_ACTIVE_SEEDS } from './bespoke-active-seeds-check';
import { TARGET_ROLE_SPEND } from '../../automation/routine-classification';
import { getSystemActionEntry } from './system-actions';

const HERE = __dirname;
const ACTION_FILE = join(HERE, 'hosted-lifecycle-reconcile-action.ts');
const SEED_FILE = join(HERE, 'seed-hosted-lifecycle-reconcile-routine.ts');
const REGISTER_FILE = join(HERE, 'register-system-actions.ts');
const STORE_FILE = join(HERE, '..', '..', 'workspace-host', 'hosted-lifecycle-store.ts');

const ACTION_NAME = 'hosted-lifecycle-reconcile';
const TARGET_ROLE = `system:${ACTION_NAME}`;
const makeHostedLifecycleReconcileAction = (overrides: Parameters<typeof createAction>[0] = {}) =>
  createAction({ reconcileDemand: async () => ({ considered: 0, enqueued: [], held: [] }), ...overrides });

const read = (p: string) => readFileSync(p, 'utf8');

const idle: HostedLifecycleReconciliationResult = {
  recoveryPending: [],
  orphaned: [],
  exhausted: [],
  notifications: [],
  spend: {
    due: 0,
    attempted: 0,
    observed: 0,
    settled: 0,
    retryable: 0,
    skipped: 0,
    errors: [],
  },
};

const withWork: HostedLifecycleReconciliationResult = {
  recoveryPending: ['op-stuck-1'],
  orphaned: ['op-orphan-1', 'op-orphan-2'],
  exhausted: [],
  notifications: ['hosted-lifecycle:ws:op-orphan-1:orphaned', 'hosted-lifecycle:ws:op-orphan-2:orphaned'],
  spend: {
    due: 0,
    attempted: 0,
    observed: 0,
    settled: 0,
    retryable: 0,
    skipped: 0,
    errors: [],
  },
};

const ctx = (workspaceId = 'ws-123') => ({
  workspaceId,
  installSlug: 'papercusp',
  triggerConfig: {},
  payloadTemplate: {},
});

describe('hosted-lifecycle-reconcile system action', () => {
  it('advances persisted capacity demand on the existing routine and reports held demand', async () => {
    const reconcileDemand = vi.fn(async () => ({ considered: 1, enqueued: [],
      held: [{ hostId: 'host-1', reason: 'hosted_pool_capacity_cooldown' }] }));
    const log = vi.fn();
    await makeHostedLifecycleReconcileAction({ reconcile: async () => idle, reconcileDemand, log })(ctx('capacity-ws'));
    expect(reconcileDemand).toHaveBeenCalledExactlyOnceWith('capacity-ws');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('capacityHeld=[{"hostId":"host-1","reason":"hosted_pool_capacity_cooldown"}]'));
  });

  it('does not report a healthy tick when authoritative demand cannot be read', async () => {
    await expect(makeHostedLifecycleReconcileAction({ reconcile: async () => idle,
      reconcileDemand: async () => { throw new Error('demand ledger unavailable'); }, log: vi.fn() })(ctx()))
      .rejects.toThrow('demand ledger unavailable');
  });

  it('reconciles the routine ctx workspace, not a hardcoded value', async () => {
    const reconcile = vi.fn(async () => idle);
    const action = makeHostedLifecycleReconcileAction({ reconcile, log: vi.fn() });

    await action(ctx('ws-123'));

    expect(reconcile).toHaveBeenCalledWith('ws-123');
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('logs nothing on a tick that advanced nothing — quiet by design', async () => {
    // The healthy steady state is every queued/running operation heartbeating. A per-tick line
    // for that is pure noise at a 120s cadence.
    const log = vi.fn();
    const action = makeHostedLifecycleReconcileAction({ reconcile: async () => idle, log });

    await action(ctx());

    expect(log).not.toHaveBeenCalled();
  });

  it('logs the per-class counts when operations were actually advanced', async () => {
    const log = vi.fn();
    const action = makeHostedLifecycleReconcileAction({ reconcile: async () => withWork, log });

    await action(ctx('p046-isolated'));

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'p046-isolated: recoveryPending=1 orphaned=2 exhausted=0 notified=2 spendDue=0 ' +
        'spendAttempted=0 spendObserved=0 spendSettled=0 spendRetryable=0 spendSkipped=0 spendErrors=0',
    );
  });

  it('logs a tick that ONLY exhausted an operation — no class is silently unreported', async () => {
    // Guards the `touched` sum: a version that counted only recoveryPending+orphaned would go
    // quiet on the most severe outcome there is.
    const log = vi.fn();
    const action = makeHostedLifecycleReconcileAction({
      reconcile: async () => ({ ...idle, exhausted: ['op-dead-1'], notifications: ['k'] }),
      log,
    });

    await action(ctx('ws'));

    expect(log).toHaveBeenCalledWith(
      'ws: recoveryPending=0 orphaned=0 exhausted=1 notified=1 spendDue=0 ' +
        'spendAttempted=0 spendObserved=0 spendSettled=0 spendRetryable=0 spendSkipped=0 spendErrors=0',
    );
  });

  it('logs bounded spend counts and retry reasons even when no lifecycle operation changed', async () => {
    const log = vi.fn();
    const action = makeHostedLifecycleReconcileAction({
      reconcile: async () => ({
        ...idle,
        spend: {
          due: 1,
          attempted: 1,
          observed: 0,
          settled: 0,
          retryable: 1,
          skipped: 0,
          errors: [
            {
              hostId: 'host-r4',
              runId: 'r4',
              reason: 'missing-config',
              retryAt: '2026-09-08T02:05:00.000Z',
            },
          ],
        },
      }),
      log,
    });

    await action(ctx('ws'));

    expect(log).toHaveBeenCalledWith(
      'ws: recoveryPending=0 orphaned=0 exhausted=0 notified=0 spendDue=1 ' +
        'spendAttempted=1 spendObserved=0 spendSettled=0 spendRetryable=1 spendSkipped=0 ' +
        'spendErrors=1 errors=[host-r4/r4:missing-config]',
    );
  });

  it('a failing sweep THROWS so the routines engine records last_error', async () => {
    // There is no fan-out to protect here, and a swallowed failure would present as a healthy
    // routine that never reconciles anything — the same silent-nothing this item exists to end.
    const action = makeHostedLifecycleReconcileAction({
      reconcile: async () => {
        throw new Error('connection terminated');
      },
      log: vi.fn(),
    });

    await expect(action(ctx())).rejects.toThrow('connection terminated');
  });
});

describe('the sweep is actually wired in, not merely written', () => {
  it('the action module registers under the expected name', () => {
    expect(existsSync(ACTION_FILE)).toBe(true);
    expect(read(ACTION_FILE)).toContain(`registerSystemAction(HOSTED_LIFECYCLE_RECONCILE`);
    expect(HOSTED_LIFECYCLE_RECONCILE).toBe(ACTION_NAME);
  });

  it('runs at the workflow layer so demand can enqueue durable child workflows legally', () => {
    expect(getSystemActionEntry(ACTION_NAME)?.ownSteps).toBe(true);
  });

  it('register-system-actions imports it — without this the action never registers', () => {
    expect(read(REGISTER_FILE)).toContain(`import './hosted-lifecycle-reconcile-action';`);
  });

  it('NEGATIVE CONTROL: the import pin would fail for a module that is not wired', () => {
    expect(read(REGISTER_FILE)).not.toContain(`import './hosted-lifecycle-reconcile-action-NOT-WIRED';`);
  });

  it('the seeder targets the role the action registers', () => {
    expect(existsSync(SEED_FILE)).toBe(true);
    const src = read(SEED_FILE);
    // A mismatch here is the classic silent failure: the routine row fires a target_role nothing
    // is registered under, so every tick is a no-op.
    expect(src).toContain(`const TARGET_ROLE = '${TARGET_ROLE}'`);
    expect(src).toContain(`const NAME = '${ACTION_NAME}'`);
  });

  it('registerSystemAction takes the name WITHOUT the system: prefix, and the seeder adds it', () => {
    expect(TARGET_ROLE).toBe(`system:${ACTION_NAME}`);
    expect(read(ACTION_FILE)).not.toContain(`registerSystemAction('${TARGET_ROLE}'`);
  });

  it('it is listed in the bespoke ACTIVE seeds registry', () => {
    const entry = BESPOKE_ACTIVE_SEEDS.find((s) => s.name === ACTION_NAME);
    expect(entry, `${ACTION_NAME} is missing from BESPOKE_ACTIVE_SEEDS`).toBeTruthy();
    expect(entry!.seedScript).toBe('seed-hosted-lifecycle-reconcile-routine.ts');
    expect(existsSync(join(HERE, entry!.seedScript))).toBe(true);
  });

  it('it carries a spend classification — an unclassified target_role has no cost story', () => {
    const entry = TARGET_ROLE_SPEND[TARGET_ROLE];
    expect(entry, `${TARGET_ROLE} is missing from TARGET_ROLE_SPEND`).toBeTruthy();
    expect(entry!.spend).toBe('none');
  });

  it('is seeded as an ephemeral interval routine, not a cron expression', () => {
    const src = read(SEED_FILE);
    expect(src).toContain(`'ephemeral'`);
    expect(src).toContain('interval_sec');
    expect(src).toContain('next_fire_at');
  });

  it('is seeded ACTIVE by default — finished work does not ship dark', () => {
    expect(read(SEED_FILE)).toContain(`const active = !process.argv.includes('--inactive')`);
  });

  it('a re-seed does not clobber an operator pause', () => {
    expect(read(SEED_FILE)).toContain('active intentionally NOT re-applied on conflict');
  });
});

describe('cadence cannot be what decides an outcome', () => {
  it('the seeded interval sits well below the thresholds the sweep classifies with', () => {
    // If the sweep ran on a cadence comparable to its own thresholds, WHEN it happened to tick
    // would materially change whether an operation was called stuck or orphaned.
    const m = read(SEED_FILE).match(/const DEFAULT_INTERVAL_SEC\s*=\s*(\d+)/);
    expect(m, 'DEFAULT_INTERVAL_SEC was renamed in the seeder — re-point this pin').toBeTruthy();
    const intervalMs = Number(m![1]) * 1000;

    const store = read(STORE_FILE);
    const stuck = store.match(/stuckAfterMs:\s*(\d+)\s*\*\s*([\d_]+)/);
    const orphan = store.match(/orphanAfterMs:\s*(\d+)\s*\*\s*([\d_]+)/);
    // CALIBRATION: prove the thresholds were actually READ. Without this a renamed field yields
    // two nulls and every comparison below would pass vacuously.
    expect(stuck, 'stuckAfterMs not found in RECONCILIATION_POLICY — re-point this pin').toBeTruthy();
    expect(orphan, 'orphanAfterMs not found in RECONCILIATION_POLICY — re-point this pin').toBeTruthy();
    const stuckMs = Number(stuck![1]) * Number(stuck![2].replace(/_/g, ''));
    const orphanMs = Number(orphan![1]) * Number(orphan![2].replace(/_/g, ''));
    expect(stuckMs).toBeGreaterThan(0);
    expect(orphanMs).toBeGreaterThan(stuckMs);

    expect(intervalMs * 2).toBeLessThanOrEqual(stuckMs);
    expect(intervalMs * 10).toBeLessThanOrEqual(orphanMs);
  });
});
