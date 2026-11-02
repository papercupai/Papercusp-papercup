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
vi.mock('./cluster-owner-rpc', () => ({ callOwnerProcess: vi.fn(), ownerRpcAvailable: vi.fn(() => true), registerOwnerRpcHandler: vi.fn() }));
vi.mock('./loopback-fetch', () => ({ loopbackFetch: vi.fn() }));
vi.mock('./auth', async orig => ({ ...await orig<typeof import('./auth')>(), getSessionUser: vi.fn() }));
vi.mock('./schedule-inventory', async orig => ({
  ...await orig<typeof import('./schedule-inventory')>(), collectScheduleInventory: vi.fn(async () => h.rows),
}));

import { createOrgTestDb } from '../test/_org-test-db';
import { setFeatureBackgroundActivityPolicy, setWorkspaceBackgroundActivityPolicy,
  setPaused, setResumed, setBackgroundActivityAutomatic, workspaceBackgroundActivityAllowed, stopFeatureBackgroundActivity,
  registerBackgroundActivityControl } from './device-operator-actions';
import { callOwnerProcess, registerOwnerRpcHandler } from './cluster-owner-rpc';
import { loopbackFetch } from './loopback-fetch';
import { getSessionUser } from './auth';
import { ownHonoPort, probeSibling } from './schedule-federation';
import { readStartupActivityHistory, recordStartupActivityHistory, workspaceBackgroundActivityFeatureId,
  runObservedBackgroundActivity, observedBackgroundActivityStatus, listObservedBackgroundActivities, collectCurrentStartupActivity } from './startup-activity';
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
  it('controls a sync writer by its device-independent workspace admission identity', async () => {
    const row: ScheduleInventoryRow = { ...registration, source: 'in-process', installSlug: null,
      name: 'doc-steward-dispatch', category: 'sync-triggered', detail: { spends: 'llm' } };
    h.rows = [row];
    const id = startupActivityFeatureId(row, { workspaceId: workspace, deviceId: 'settings-device' });
    expect(id).toBe(startupActivityFeatureId(row, { workspaceId: workspace }));
    await expect(setFeatureBackgroundActivityPolicy(id, { action: 'automatic', automatic: false }, 0, user))
      .resolves.toMatchObject({ automatic: false, revision: 1 });
    await expect(workspaceBackgroundActivityAllowed(workspace, id)).resolves.toBe(false);
    await expect(workspaceBackgroundActivityAllowed('another-workspace', startupActivityFeatureId(row, { workspaceId: 'another-workspace' })))
      .resolves.toBe(true);
    expect(await readStartupActivityHistory([id])).toMatchObject([{ operation: 'policy-change', resulting: { automatic: false } }]);
  });

  it.each(['routine', 'event'] as const)('drains a local %s effect with audited settlement and no saved policy mutation', async source => {
    const rule = { id: 'startup-stop-event', on: 'policy:test', fire: 'test:optional', when: () => true, args: () => ({}) };
    if (source === 'event') { registerReactionRule(rule); h.rows = []; }
    const id = source === 'event' ? reactionStartupFeature(rule, workspace).id : featureId;
    await setFeatureBackgroundActivityPolicy(id, { action: 'automatic', automatic: false }, 0, user);
    const before = await readOperatorState('operator_paused', workspace, { fresh: true });
    let finish!: () => void;
    const invocation = runObservedBackgroundActivity({ workspaceId: workspace, featureId: id, source,
      trigger: source === 'event' ? 'event' : 'manual' }, () => new Promise<void>(resolve => { finish = resolve; }));
    try {
      const route = (await import('./endpoint-route/routes/misc/managed-timers')).default;
      const snapshot = async () => (await probeSibling({ port: ownHonoPort(), pid: process.pid, startedAt: 0 }, {
        fetchImpl: async () => route.handler(new Request(`http://127.0.0.1:${ownHonoPort()}/api/internal/managed-timers`), {
          principal: null, input: undefined, params: {}, log: () => {}, signal: new AbortController().signal,
        }),
      }))[0].backgroundActivities;
      expect(listObservedBackgroundActivities()).toContainEqual({ workspaceId: workspace, featureId: id, source,
        running: true, stopStatus: null, cancellable: false });
      expect(await snapshot()).toContainEqual({ workspaceId: workspace, featureId: id, source,
        running: true, stopStatus: null, cancellable: false });
      await expect(stopFeatureBackgroundActivity(id, { ...user, workspace_id: 'other' }))
        .rejects.toMatchObject({ code: 'startup_policy_forbidden' });
      await expect(stopFeatureBackgroundActivity(id, user)).resolves.toMatchObject({
        status: 'draining', policy: { automatic: false, revision: 1 },
      });
      expect(observedBackgroundActivityStatus({ workspaceId: workspace, featureId: id })).toMatchObject({
        running: true, stopStatus: 'draining', cancellable: false,
      });
      expect(await snapshot()).toContainEqual({ workspaceId: workspace, featureId: id, source,
        running: true, stopStatus: 'draining', cancellable: false });
      expect((await readStartupActivityHistory([id])).filter(entry => entry.operation === 'stop').map(entry => entry.status).sort())
        .toEqual(['draining', 'pending']);
      finish();
      await invocation;
      await vi.waitFor(async () => expect((await readStartupActivityHistory([id]))
        .some(entry => entry.operation === 'stop' && entry.status === 'completed')).toBe(true));
      expect(await readOperatorState('operator_paused', workspace, { fresh: true })).toEqual(before);
      expect(observedBackgroundActivityStatus({ workspaceId: workspace, featureId: id })).toBeNull();
      expect(listObservedBackgroundActivities().some(entry => entry.featureId === id)).toBe(false);
      expect((await snapshot())?.some(entry => entry.featureId === id)).toBe(false);
      await expect(stopFeatureBackgroundActivity(id, user)).resolves.toMatchObject({ status: 'unavailable' });
    } finally {
      finish(); await invocation;
      if (source === 'event') unregisterReactionRule(rule.id);
    }
  });

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

  it('drains an actual local callback instead of acknowledging an idle managed registration', async () => {
    configureScheduledRegistry({ setIntervalImpl: () => ({}), clearIntervalImpl: () => {}, log: () => {} });
    managedSetInterval('idle-alongside-callback', 1000, () => {}, { category: 'global-sweep',
      activity: { kind: 'workspace', workspaceId: workspace, featureId } });
    h.rows = [registration, { ...registration, source: 'managed', name: 'idle-alongside-callback',
      detail: { activity: { kind: 'workspace', workspaceId: workspace, featureId }, running: false } }];
    let finish!: () => void;
    const invocation = runObservedBackgroundActivity({ workspaceId: workspace, featureId, source: 'routine', trigger: 'manual' },
      () => new Promise<void>(resolve => { finish = resolve; }));
    try {
      expect(await stopFeatureBackgroundActivity(featureId, user)).toMatchObject({ status: 'draining' });
      expect(getManaged('idle-alongside-callback')!.stopStatus).toBeUndefined();
      expect(listObservedBackgroundActivities()).toContainEqual({ workspaceId: workspace, featureId,
        source: 'routine', running: true, stopStatus: 'draining', cancellable: false });
      const current = await collectCurrentStartupActivity({ getDbosSchedules: async () => [], getRoutines: async () => [],
        getManaged: () => [getManaged('idle-alongside-callback')!], getSiblingManaged: async () => [],
        getExternalProcess: () => [], getSyncTriggered: () => [], getInProcessChecks: () => ({ checks: [], armed: false }),
      }, { native: async () => [], reactions: async () => [], history: async () => [], census: async () => [] });
      expect(current.features.find(feature => feature.id === featureId)).toMatchObject({
        observed: 'running', stop: { status: 'draining', cancellable: false },
      });
      expect((await readStartupActivityHistory([featureId])).some(entry => entry.operation === 'stop' && entry.status === 'completed')).toBe(false);
      finish(); await invocation;
      await vi.waitFor(async () => expect((await readStartupActivityHistory([featureId]))
        .some(entry => entry.operation === 'stop' && entry.status === 'completed')).toBe(true));
    } finally { finish(); await invocation; }
  });

  it('keeps required event controls protected through remote placement and rejects removed rules', async () => {
    const rule = { id: 'remote-required-control', on: 'policy:test', fire: 'cache.bumpTags',
      when: () => true, args: () => ({}) };
    registerReactionRule(rule);
    const id = reactionStartupFeature(rule, workspace).id;
    h.rows = [{ ...registration, source: 'external-process', name: 'event invocation', detail: {
      invocationSource: 'event', activity: { kind: 'workspace', workspaceId: workspace, featureId: id },
      federated: true, reachable: true, pid: 12345, port: ownHonoPort(), running: true,
    } }];
    try {
      await expect(stopFeatureBackgroundActivity(id, user, { headers: new Headers({ cookie: 'papercusp_session=original-session' }) }))
        .rejects.toMatchObject({ code: 'startup_policy_forbidden' });
      await expect(setFeatureBackgroundActivityPolicy(id, { action: 'automatic', automatic: false }, 0, user))
        .rejects.toMatchObject({ code: 'startup_policy_forbidden' });
      expect(callOwnerProcess).not.toHaveBeenCalled();
    } finally { unregisterReactionRule(rule.id); }
    await expect(stopFeatureBackgroundActivity(id, user)).rejects.toMatchObject({ code: 'startup_policy_forbidden' });
    expect(await readStartupActivityHistory([id])).toEqual([]);
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

  const remoteRow = (port = ownHonoPort(), pid = 12345): ScheduleInventoryRow => ({ ...registration,
    source: 'external-process', name: 'remote-optional', detail: {
      activity: { kind: 'workspace', workspaceId: workspace, featureId },
      pid, port, reachable: true, federated: true, running: true,
    } });
  const remoteHeaders = () => new Headers({ cookie: 'unrelated=private; papercusp_session=original-session',
    'x-workspace-id': 'foreign', authorization: 'private-credential' });
  const remotePolicy = { automatic: true, pausedUntil: null, revision: 0 };
  const unmeasuredRemotePolicy = { automatic: null, paused: false, pausedUntil: null, revision: null };

  it('forwards to a discovered primary through owner IPC without copying a principal or unrelated credentials', async () => {
    h.rows = [registration, remoteRow()];
    vi.mocked(callOwnerProcess).mockResolvedValueOnce({ ok: true, result: { status: 'draining', policy: remotePolicy } });
    expect(await stopFeatureBackgroundActivity(featureId, user, { headers: remoteHeaders() }))
      .toEqual({ status: 'draining', policy: remotePolicy });
    expect(callOwnerProcess).toHaveBeenCalledWith({ targetPid: 12345, kind: 'startup-background-stop',
      payload: { featureId, cookie: 'papercusp_session=original-session' } });
    expect(loopbackFetch).not.toHaveBeenCalled();
    // Only the runtime owner can audit that a stop happened; forwarding is not acknowledgment.
    expect(await readStartupActivityHistory([featureId])).toEqual([]);
    expect(await readOperatorState('operator_paused', workspace, { fresh: true })).toBeNull();
  });

  it('reuses the authenticated pause endpoint for another discovered local service with bounded, non-retried delivery', async () => {
    const port = ownHonoPort() === 3271 ? 3272 : 3271;
    h.rows = [remoteRow(port)];
    vi.mocked(loopbackFetch).mockResolvedValueOnce(Response.json({ ok: true, status: 'pending', policy: remotePolicy }));
    expect(await stopFeatureBackgroundActivity(featureId, user, { headers: remoteHeaders() }))
      .toEqual({ status: 'pending', policy: remotePolicy });
    expect(loopbackFetch).toHaveBeenCalledWith(`http://127.0.0.1:${port}/api/agent-mcp/operator-pause-flag`, {
      method: 'PATCH', headers: { cookie: 'papercusp_session=original-session', 'content-type': 'application/json' },
      body: JSON.stringify({ featureId, action: 'stop', runtimePid: 12345 }), signal: expect.any(AbortSignal),
    }, { backoffsMs: [] });
    expect(callOwnerProcess).not.toHaveBeenCalled();
  });

  it('targets the running remote invocation when the same feature has an idle local registration', async () => {
    configureScheduledRegistry({ setIntervalImpl: () => ({}), clearIntervalImpl: () => {}, log: () => {} });
    managedSetInterval('local-idle', 1000, () => {}, { category: 'global-sweep',
      activity: { kind: 'workspace', workspaceId: workspace, featureId } });
    h.rows = [registration, { ...remoteRow(), source: 'managed', name: 'local-idle' }, remoteRow()];
    vi.mocked(callOwnerProcess).mockResolvedValueOnce({ ok: true, result: { status: 'draining', policy: remotePolicy } });
    expect(await stopFeatureBackgroundActivity(featureId, user, { headers: remoteHeaders() }))
      .toMatchObject({ status: 'draining' });
    expect(callOwnerProcess).toHaveBeenCalledOnce();
    expect(getManaged('local-idle')!.stopStatus).toBeUndefined();
    expect(await readStartupActivityHistory([featureId])).toEqual([]);
  });

  it.each(['owner_gone', 'no_handler', 'timeout', 'send_failed'] as const)('keeps %s unknown without a false stop acknowledgment', async code => {
    h.rows = [remoteRow()];
    vi.mocked(callOwnerProcess).mockResolvedValueOnce({ ok: false, code, message: 'private-runtime-body' });
    expect(await stopFeatureBackgroundActivity(featureId, user, { headers: remoteHeaders() }))
      .toEqual({ status: 'unavailable', policy: unmeasuredRemotePolicy, reason: 'runtime-control-unavailable' });
    expect(await readStartupActivityHistory([featureId])).toEqual([]);
  });

  it('refuses missing credentials, forged placement and a local-only request without bouncing it to another owner', async () => {
    h.rows = [remoteRow()];
    for (const options of [{}, { headers: new Headers() }, { headers: remoteHeaders(), runtimePid: 54321 },
      { headers: remoteHeaders(), runtimePid: process.pid }]) {
      expect(await stopFeatureBackgroundActivity(featureId, user, options)).toMatchObject({ status: 'unavailable' });
    }
    await expect(stopFeatureBackgroundActivity(featureId, { ...user, workspace_id: 'foreign' }, { headers: remoteHeaders() }))
      .rejects.toMatchObject({ code: 'startup_policy_forbidden' });
    expect(callOwnerProcess).not.toHaveBeenCalled();
    expect(loopbackFetch).not.toHaveBeenCalled();
  });

  it('re-authenticates at the runtime owner, drains its actual callback and records scoped settlement', async () => {
    registerBackgroundActivityControl();
    const handler = vi.mocked(registerOwnerRpcHandler).mock.calls.at(-1)![1];
    const payload = { featureId, cookie: 'papercusp_session=original-session' };
    vi.mocked(getSessionUser).mockResolvedValueOnce(null);
    await expect(handler(payload, { fromPid: 12345 })).rejects.toThrow('Startup runtime authority unavailable');
    vi.mocked(getSessionUser).mockResolvedValueOnce({ ...user, workspace_id: 'foreign' });
    await expect(handler(payload, { fromPid: 12345 })).rejects.toMatchObject({ code: 'startup_policy_forbidden' });
    vi.mocked(getSessionUser).mockResolvedValueOnce({ ...user, capabilities: [] });
    await expect(handler(payload, { fromPid: 12345 })).rejects.toMatchObject({ code: 'startup_policy_forbidden' });
    let finish!: () => void;
    const pending = runObservedBackgroundActivity({ workspaceId: workspace, featureId, source: 'routine', trigger: 'timer' },
      () => new Promise<void>(resolve => { finish = resolve; }));
    try {
      vi.mocked(getSessionUser).mockResolvedValueOnce(user);
      expect(await handler(payload, { fromPid: 12345 })).toMatchObject({ status: 'draining' });
      expect(vi.mocked(getSessionUser).mock.calls.at(-1)![0]!.get('cookie')).toBe(payload.cookie);
      finish(); await pending;
      await vi.waitFor(async () => expect((await readStartupActivityHistory([featureId]))
        .some(entry => entry.operation === 'stop' && entry.status === 'completed')).toBe(true));
      expect(await readOperatorState('operator_paused', workspace, { fresh: true })).toBeNull();
    } finally { finish(); await pending; }
  });

  it('redacts refused or malformed remote responses instead of asserting completion', async () => {
    h.rows = [remoteRow(ownHonoPort() === 3271 ? 3272 : 3271)];
    for (const response of [Response.json({ secret: 'provider-body' }, { status: 403 }),
      Response.json({ status: 'completed' }), Response.json({ status: 'unexpected', policy: remotePolicy })]) {
      vi.mocked(loopbackFetch).mockResolvedValueOnce(response);
      expect(await stopFeatureBackgroundActivity(featureId, user, { headers: remoteHeaders() }))
        .toEqual({ status: 'unavailable', policy: unmeasuredRemotePolicy, reason: 'runtime-control-unavailable' });
    }
    expect(await readStartupActivityHistory([featureId])).toEqual([]);
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
