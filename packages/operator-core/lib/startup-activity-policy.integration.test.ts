import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { OrgTestDb } from '../test/_org-test-db';
import type { SessionUser } from './auth';
import type { ScheduleInventoryRow } from './schedule-inventory';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, rows: [] as ScheduleInventoryRow[] }));
vi.mock('@papercusp/db-org', async orig => ({
  ...await orig<typeof import('@papercusp/db-org')>(), getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => 'startup-policy-test' }));
vi.mock('./sync-sse', () => ({ notifySyncInvalidate: vi.fn(async () => {}) }));
vi.mock('./schedule-inventory', async orig => ({
  ...await orig<typeof import('./schedule-inventory')>(), collectScheduleInventory: vi.fn(async () => h.rows),
}));

import { createOrgTestDb } from '../test/_org-test-db';
import { setFeatureBackgroundActivityPolicy, setWorkspaceBackgroundActivityPolicy,
  setPaused, setResumed, setBackgroundActivityAutomatic, workspaceBackgroundActivityAllowed, stopFeatureBackgroundActivity } from './device-operator-actions';
import { readStartupActivityHistory, recordStartupActivityHistory, workspaceBackgroundActivityFeatureId } from './startup-activity';
import { readOperatorState, updateOperatorState, writeOperatorState } from './operator-state-pg';
import { reactionStartupFeature, startupActivityFeatureId } from './schedule-inventory';
import { notifySyncInvalidate } from './sync-sse';
import { registerSystemAction } from './harness/routines/system-actions';
import { registerReactionRule, unregisterReactionRule } from './events/registry';
import { configureScheduledRegistry, managedSetInterval, getManaged, resetScheduledRegistry } from '@papercusp/scheduled-registry';

const workspace = 'startup-policy-test';
const user: SessionUser = { id: '03ffddab-83cb-44a2-93e5-d16429c72a2f', username: 'private-user',
  display_name: 'Private', has_password: false, workspace_id: workspace, capabilities: ['*'] };
const registration: ScheduleInventoryRow = { source: 'routines', installSlug: 'test', name: 'optional-startup-test',
  scope: 'operator', tier: 'durable', category: 'routine', cadence: 'timer', armed: true,
  lastFire: null, nextFire: null, lastError: null, groupSlug: null,
  detail: { targetRole: 'system:startup-test-optional' } };
const featureId = startupActivityFeatureId(registration, { workspaceId: workspace });
const change = (automatic = false, revision = 0, principal = user) =>
  setFeatureBackgroundActivityPolicy(featureId, { action: 'automatic', automatic }, revision, principal);
let db: OrgTestDb;

beforeAll(async () => { db = await createOrgTestDb(); h.sql = db.adminSql; }, 180_000);
afterAll(async () => { await db?.cleanup(); });
beforeEach(async () => {
  resetScheduledRegistry();
  await db.adminSql`DELETE FROM harness_shared.operator_paused`;
  await db.adminSql`DELETE FROM harness_shared.audit_log WHERE action = 'background-activity'`;
  h.rows = [registration];
  vi.clearAllMocks();
});

describe('scoped startup policy and atomic history (real PostgreSQL)', () => {
  it.each([false, true])('stops only the current managed invocation with acknowledged cancellation=%s and unchanged policy', async cancellable => {
    const tick: { fire?: () => void } = {};
    let finish!: () => void;
    let signal!: AbortSignal;
    configureScheduledRegistry({ setIntervalImpl: cb => { tick.fire = cb; return {}; }, clearIntervalImpl: () => {},
      setTimeoutImpl: () => ({}), log: () => {} });
    managedSetInterval('local-optional', 100, context => {
      signal = context.signal;
      return new Promise<void>(resolve => { finish = resolve; });
    }, { category: 'global-sweep', cancellable, activity: { kind: 'workspace', workspaceId: workspace, featureId } });
    // Inventory order must not hide a local invocation behind its durable registration.
    h.rows = [registration, { ...registration, source: 'managed', name: 'local-optional', detail: {
      activity: { kind: 'workspace', workspaceId: workspace, featureId }, running: true,
    } }];
    await writeOperatorState('operator_paused', { paused: false, backgroundActivity: {
      version: 1, revision: 9, automatic: true, pausedUntil: null, features: {},
    } }, workspace);
    const before = await readOperatorState('operator_paused', workspace, { fresh: true });
    tick.fire!();
    const result = await stopFeatureBackgroundActivity(featureId, user);
    expect(result.status).toBe(cancellable ? 'pending' : 'draining');
    expect(signal.aborted).toBe(cancellable);
    expect(getManaged('local-optional')!.running).toBe(true);
    expect((await readStartupActivityHistory([featureId])).some(entry => entry.operation === 'stop' && entry.status === 'completed')).toBe(false);
    finish();
    await vi.waitFor(async () => expect((await readStartupActivityHistory([featureId]))
      .some(entry => entry.operation === 'stop' && entry.status === 'completed')).toBe(true));
    expect(getManaged('local-optional')!.running).toBe(false);
    expect(await readOperatorState('operator_paused', workspace, { fresh: true })).toEqual(before);
    await expect(workspaceBackgroundActivityAllowed(workspace, featureId)).resolves.toBe(true);
    resetScheduledRegistry();
  });

  it('does not stop another workspace, required control, or an unsupported runtime', async () => {
    await expect(stopFeatureBackgroundActivity(featureId, { ...user, workspace_id: 'other' }))
      .rejects.toMatchObject({ code: 'startup_policy_forbidden' });
    expect(await stopFeatureBackgroundActivity(featureId, user)).toMatchObject({ status: 'unavailable' });
    expect(await readStartupActivityHistory([featureId])).toEqual([]);
    registerSystemAction('startup-stop-recovery', async () => {}, { requiredForControl: 'Keeps settings available' });
    h.rows = [{ ...registration, detail: { targetRole: 'system:startup-stop-recovery' } }];
    await expect(stopFeatureBackgroundActivity(featureId, user)).rejects.toMatchObject({ code: 'startup_policy_forbidden' });
  });
  it('commits a feature disable and redacted before/after history together', async () => {
    const policy = await change();
    expect(policy).toMatchObject({ automatic: false, revision: 1 });
    await expect(workspaceBackgroundActivityAllowed(workspace, featureId)).resolves.toBe(false);
    const history = await readStartupActivityHistory([featureId]);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ featureId, operation: 'policy-change', status: 'completed',
      previous: { automatic: true, revision: 0 }, resulting: { automatic: false, revision: 1 },
      source: 'settings', trigger: 'settings', reason: 'user-choice' });
    expect(history[0]!.actor).toMatch(/^user:[a-f0-9]{64}$/);
    expect(JSON.stringify(history)).not.toMatch(/private-user|03ffddab/);
  });

  it('fills an omitted legacy feature map without losing its policy or audit', async () => {
    await writeOperatorState('operator_paused', { paused: false, backgroundActivity: {
      version: 1, revision: 3, automatic: false, pausedUntil: null,
    } }, workspace);
    await expect(change(false, 3)).resolves.toMatchObject({ automatic: false, revision: 4 });
    expect(await readStartupActivityHistory([featureId])).toMatchObject([{
      previous: { automatic: false, revision: 3 }, resulting: { automatic: false, revision: 4 },
    }]);
    expect(await readOperatorState('operator_paused', workspace, { fresh: true })).toMatchObject({
      backgroundActivity: { automatic: false, revision: 4, features: { [featureId]: { automatic: false } } },
    });
  });

  it('rolls back a policy change when the audit insert fails, without notifying success', async () => {
    await db.adminSql`ALTER TABLE harness_shared.audit_log ADD CONSTRAINT startup_test_audit_failure
      CHECK (action <> 'background-activity') NOT VALID`;
    try {
      await expect(change()).rejects.toThrow();
      expect(await db.adminSql`SELECT payload FROM harness_shared.operator_paused`).toHaveLength(0);
      expect(await readStartupActivityHistory([featureId])).toEqual([]);
      expect(notifySyncInvalidate).not.toHaveBeenCalled();
    } finally { await db.adminSql`ALTER TABLE harness_shared.audit_log DROP CONSTRAINT startup_test_audit_failure`; }
  });

  it('rolls back an inserted history row when a later transaction step fails', async () => {
    await expect(updateOperatorState<{ paused?: boolean }>('operator_paused', {}, () => ({ paused: true }), workspace, async (tx) => {
      await recordStartupActivityHistory({ featureId, operation: 'pause', status: 'completed',
        at: new Date().toISOString(), actor: 'user', trigger: 'settings', source: 'settings', reason: 'user-choice',
        previous: null, resulting: null }, user.id, 'user', { sql: tx, workspaceId: workspace });
      throw new Error('later companion failed');
    })).rejects.toThrow('later companion failed');
    expect(await db.adminSql`SELECT payload FROM harness_shared.operator_paused`).toHaveLength(0);
    expect(await readStartupActivityHistory([featureId])).toEqual([]);
    expect(notifySyncInvalidate).not.toHaveBeenCalled();
  });

  it('serializes concurrent first writers; a stale revision cannot overwrite the winner', async () => {
    const results = await Promise.allSettled([change(false), change(true)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await readStartupActivityHistory([featureId])).toHaveLength(1);
    expect(await readOperatorState('operator_paused', workspace, { fresh: true })).toMatchObject({
      backgroundActivity: { revision: 1 },
    });
  });

  it('preserves a newer disable across stale and current feature resume', async () => {
    await change(false);
    await expect(setFeatureBackgroundActivityPolicy(featureId, { action: 'resume' }, 0, user))
      .rejects.toMatchObject({ code: 'startup_policy_conflict' });
    await setFeatureBackgroundActivityPolicy(featureId, { action: 'pause', until: new Date(Date.now() + 60_000).toISOString() }, 1, user);
    await setFeatureBackgroundActivityPolicy(featureId, { action: 'resume' }, 2, user);
    await expect(workspaceBackgroundActivityAllowed(workspace, featureId)).resolves.toBe(false);
    expect(await readStartupActivityHistory([featureId])).toHaveLength(3);
  });

  it('records effective feature policy while preserving its independent choice under workspace controls', async () => {
    await setWorkspaceBackgroundActivityPolicy({ action: 'automatic', automatic: false }, 0, user);
    await setWorkspaceBackgroundActivityPolicy({ action: 'pause', until: null }, 1, user);
    await expect(change(true, 2)).resolves.toMatchObject({ automatic: false, paused: true, revision: 3 });
    expect(await readStartupActivityHistory([featureId])).toMatchObject([{
      previous: { automatic: false, paused: true, revision: 2 },
      resulting: { automatic: false, paused: true, revision: 3 },
    }]);
    expect(await readOperatorState('operator_paused', workspace, { fresh: true })).toMatchObject({
      backgroundActivity: { features: { [featureId]: { automatic: true } } },
    });
    await setWorkspaceBackgroundActivityPolicy({ action: 'resume' }, 3, user);
    await setWorkspaceBackgroundActivityPolicy({ action: 'automatic', automatic: true }, 4, user);
    await expect(workspaceBackgroundActivityAllowed(workspace, featureId)).resolves.toBe(true);
  });

  it('preserves unknown stored fields while stripping them from responses and audit', async () => {
    const root = { paused: true, privateRoot: 'secret-root', backgroundActivity: {
      version: 1, revision: 4, automatic: false, pausedUntil: null, futurePolicy: 'secret-policy', features: {
        [featureId]: { automatic: true, paused: true, pausedUntil: null, revision: 4, futureFeature: 'secret-feature' },
      },
    } };
    await writeOperatorState('operator_paused', root, workspace);
    const result = await change(false, 4);
    const stored = await readOperatorState('operator_paused', workspace, { fresh: true });
    expect(stored).toMatchObject({ privateRoot: 'secret-root', paused: true,
      backgroundActivity: { automatic: false, futurePolicy: 'secret-policy', features: {
        [featureId]: { automatic: false, paused: true, futureFeature: 'secret-feature' },
      } } });
    expect(JSON.stringify([result, await readStartupActivityHistory([featureId])])).not.toMatch(/secret|future/);
  });

  it.each([
    { ...user, workspace_id: 'another-workspace' }, { ...user, capabilities: [] },
    { ...user, capabilities: ['workspace:view'] }, { ...user, id: '' },
  ])('denies an unauthorized session before looking up registrations or writing', async principal => {
    await expect(change(false, 0, principal)).rejects.toMatchObject({ code: 'startup_policy_forbidden' });
    const { collectScheduleInventory } = await import('./schedule-inventory');
    expect(collectScheduleInventory).not.toHaveBeenCalled();
    expect(await db.adminSql`SELECT payload FROM harness_shared.operator_paused`).toHaveLength(0);
  });

  it('accepts existing workspace:operate authority without the local wildcard', async () => {
    await expect(change(false, 0, { ...user, capabilities: ['workspace:operate'] })).resolves.toMatchObject({ revision: 1 });
  });

  it('controls a registered event rule using its inventory and admission identity with atomic history', async () => {
    const rule = { id: 'startup-policy-event-test', on: 'policy:test', fire: 'test:optional',
      when: () => true, args: () => ({}) };
    registerReactionRule(rule);
    const id = reactionStartupFeature(rule, workspace).id;
    try {
      await expect(setFeatureBackgroundActivityPolicy(id, { action: 'automatic', automatic: false }, 0, user))
        .resolves.toMatchObject({ automatic: false, revision: 1 });
      await expect(workspaceBackgroundActivityAllowed(workspace, id)).resolves.toBe(false);
      await expect(workspaceBackgroundActivityAllowed('another-workspace', reactionStartupFeature(rule, 'another-workspace').id))
        .resolves.toBe(true);
      expect(await readStartupActivityHistory([id])).toMatchObject([{
        previous: { automatic: true, revision: 0 }, resulting: { automatic: false, revision: 1 },
      }]);
      await expect(setFeatureBackgroundActivityPolicy(reactionStartupFeature(rule, 'another-workspace').id,
        { action: 'resume' }, 1, user)).rejects.toMatchObject({ code: 'startup_policy_forbidden' });
      unregisterReactionRule(rule.id);
      await expect(setFeatureBackgroundActivityPolicy(id, { action: 'resume' }, 1, user))
        .rejects.toMatchObject({ code: 'startup_policy_forbidden' });
      expect(await readStartupActivityHistory([id])).toHaveLength(1);
    } finally { unregisterReactionRule(rule.id); }
  });

  it('keeps required event control actions available without writing an ineffective preference', async () => {
    const rule = { id: 'startup-policy-control-event-test', on: 'policy:test', fire: 'cache.bumpTags',
      when: () => true, args: () => ({}) };
    registerReactionRule(rule);
    const id = reactionStartupFeature(rule, workspace).id;
    try {
      await expect(setFeatureBackgroundActivityPolicy(id, { action: 'automatic', automatic: false }, 0, user))
        .rejects.toMatchObject({ code: 'startup_policy_forbidden' });
      expect(await readStartupActivityHistory([id])).toEqual([]);
      expect(await db.adminSql`SELECT payload FROM harness_shared.operator_paused`).toHaveLength(0);
    } finally { unregisterReactionRule(rule.id); }
  });

  it('refuses an orphan, a required recovery action, a device, and a foreign managed binding', async () => {
    h.rows = [];
    await expect(change()).rejects.toMatchObject({ code: 'startup_policy_forbidden' });
    registerSystemAction('startup-test-required', async () => {}, { requiredForControl: 'Keeps settings reachable' });
    h.rows = [{ ...registration, detail: { targetRole: 'system:startup-test-required' } }];
    await expect(change()).rejects.toMatchObject({ code: 'startup_policy_forbidden' });
    h.rows = [{ ...registration, source: 'managed', detail: {} }];
    let id = startupActivityFeatureId(h.rows[0]!, { workspaceId: workspace });
    await expect(setFeatureBackgroundActivityPolicy(id, { action: 'resume' }, 0, user)).rejects.toMatchObject({ code: 'startup_policy_forbidden' });
    h.rows = [{ ...registration, source: 'managed', detail: { activity: {
      kind: 'workspace', workspaceId: 'another-workspace', featureId,
    } } }];
    await expect(change()).rejects.toMatchObject({ code: 'startup_policy_forbidden' });
    expect(await readStartupActivityHistory([featureId])).toEqual([]);
  });

  it('rejects invalid changes and newer saved formats without changing state or history', async () => {
    await expect(setFeatureBackgroundActivityPolicy(featureId, { action: 'pause', until: '2000-01-01T00:00:00Z' }, 0, user))
      .rejects.toMatchObject({ code: 'startup_policy_invalid' });
    await writeOperatorState('operator_paused', { backgroundActivity: { version: 2, future: 'preserve' } }, workspace);
    await expect(change()).rejects.toThrow();
    expect(await readOperatorState('operator_paused', workspace, { fresh: true })).toEqual({ backgroundActivity: { version: 2, future: 'preserve' } });
    expect(await readStartupActivityHistory([featureId])).toEqual([]);
  });

  it('audits workspace lifecycle atomically and preserves disables, feature pauses and unknown fields', async () => {
    await writeOperatorState('operator_paused', { paused: false, future: 'secret-root', backgroundActivity: {
      version: 1, revision: 0, automatic: true, pausedUntil: null, future: 'secret-policy', features: {
        [featureId]: { automatic: false, paused: true, pausedUntil: null, revision: 0, future: 'secret-feature' },
      },
    } }, workspace);
    const globalId = workspaceBackgroundActivityFeatureId(workspace);
    const set = (change: Parameters<typeof setWorkspaceBackgroundActivityPolicy>[0], revision: number) =>
      setWorkspaceBackgroundActivityPolicy(change, revision, user);
    await set({ action: 'pause', until: '2099-01-01T00:00:00Z' }, 0);
    await set({ action: 'automatic', automatic: false }, 1);
    await expect(set({ action: 'resume' }, 1)).rejects.toMatchObject({ code: 'startup_policy_conflict' });
    const policy = await set({ action: 'resume' }, 2);
    expect(policy).toEqual({ automatic: false, paused: false, pausedUntil: null, revision: 3 });
    await expect(workspaceBackgroundActivityAllowed(workspace)).resolves.toBe(false);
    const stored = await readOperatorState('operator_paused', workspace, { fresh: true });
    expect(stored).toMatchObject({ future: 'secret-root', backgroundActivity: { future: 'secret-policy',
      features: { [featureId]: { automatic: false, paused: true, future: 'secret-feature' } } } });
    const history = await readStartupActivityHistory([globalId]);
    expect(history).toHaveLength(3);
    expect(history.find(entry => entry.operation === 'pause')).toMatchObject({ previous: { revision: 0, paused: false },
      resulting: { revision: 1, paused: true, pausedUntil: '2099-01-01T00:00:00Z' } });
    expect(history.find(entry => entry.operation === 'resume')).toMatchObject({ previous: { automatic: false, revision: 2 },
      resulting: { automatic: false, revision: 3, paused: false } });
    expect(history.every(entry => entry.actor.startsWith('user:'))).toBe(true);
    expect(JSON.stringify([policy, history])).not.toMatch(/private-user|03ffddab|secret|future/);
    expect(await readStartupActivityHistory([featureId])).toEqual([]);
  });

  it('rolls back workspace controls when the history insert fails', async () => {
    await db.adminSql`ALTER TABLE harness_shared.audit_log ADD CONSTRAINT startup_test_workspace_audit_failure
      CHECK (action <> 'background-activity') NOT VALID`;
    try {
      await expect(setWorkspaceBackgroundActivityPolicy({ action: 'automatic', automatic: false }, 0, user)).rejects.toThrow();
      expect(await db.adminSql`SELECT payload FROM harness_shared.operator_paused`).toHaveLength(0);
      expect(notifySyncInvalidate).not.toHaveBeenCalled();
    } finally { await db.adminSql`ALTER TABLE harness_shared.audit_log DROP CONSTRAINT startup_test_workspace_audit_failure`; }
  });

  it('denies unauthorized workspace changes and leaves other workspaces untouched', async () => {
    await writeOperatorState('operator_paused', { paused: true }, 'another-workspace');
    for (const principal of [{ ...user, workspace_id: 'another-workspace' }, { ...user, capabilities: [] }])
      await expect(setWorkspaceBackgroundActivityPolicy({ action: 'resume' }, 0, principal))
        .rejects.toMatchObject({ code: 'startup_policy_forbidden' });
    await setWorkspaceBackgroundActivityPolicy({ action: 'automatic', automatic: false }, 0, user);
    expect(await readOperatorState('operator_paused', 'another-workspace', { fresh: true })).toEqual({ paused: true });
  });

  it('audits existing trusted pause/resume/automatic writers without changing their contract', async () => {
    await setPaused('device-private', null, 0);
    await setResumed(1);
    await setBackgroundActivityAutomatic(false, 2);
    const history = await readStartupActivityHistory([workspaceBackgroundActivityFeatureId(workspace)]);
    expect(history).toHaveLength(3);
    expect(history.every(entry => entry.actor.startsWith('system:'))).toBe(true);
    expect(JSON.stringify(history)).not.toContain('device-private');
    expect(history.map(entry => entry.resulting?.revision).sort()).toEqual([1, 2, 3]);
  });
});
