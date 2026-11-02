import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg, markManagedTestDatabase } from '@papercusp/test-config/pg';
import { reactionStartupFeature, type StartupActivityHistoryEntry } from './schedule-inventory';

const state = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, workspace: 'startup-a' }));
vi.mock('@papercusp/db-org', async original => ({ ...(await original<typeof import('@papercusp/db-org')>()), getOrgPg: () => ({ sql: state.sql }) }));
vi.mock('./workspace-registry', () => ({ activeWorkspaceId: () => state.workspace }));
import { readStartupActivityHistory, recordStartupActivityHistory, runObservedBackgroundActivity,
  observedBackgroundActivityStatus, stopObservedBackgroundActivity, collectCurrentStartupActivity,
  readNativeStartupActivity, recordNativeStartupActivityStart } from './startup-activity';

let admin: postgres.Sql;
let database: string;
const featureId = `activity-${'a'.repeat(64)}`;
const event = (over: Partial<StartupActivityHistoryEntry> = {}): StartupActivityHistoryEntry => ({
  featureId, operation: 'policy-change', status: 'completed', at: new Date().toISOString(),
  actor: 'ignored-at-write', trigger: 'settings', source: 'settings', reason: 'user-choice',
  previous: { automatic: true, pausedUntil: null, revision: 1 },
  resulting: { automatic: false, pausedUntil: null, revision: 2 }, ...over,
});

beforeAll(async () => {
  const url = await getTestPg();
  database = `startup_history_${randomBytes(5).toString('hex')}`;
  admin = postgres(url, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${database}"`);
  await markManagedTestDatabase(admin, database);
  const target = new URL(url); target.pathname = `/${database}`;
  state.sql = postgres(target.toString(), { max: 2, onnotice: () => {} });
  await state.sql`CREATE SCHEMA harness_shared`;
  // Exact existing audit_log columns used by the production reader and writer.
  await state.sql`CREATE TABLE harness_shared.audit_log (
    id text PRIMARY KEY, ts bigint NOT NULL, actor text NOT NULL, action text NOT NULL,
    subject text NOT NULL, details jsonb NOT NULL, workspace_id text NOT NULL)`;
});
afterAll(async () => {
  await state.sql?.end({ timeout: 5 });
  if (database) await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin?.end({ timeout: 5 });
});
beforeEach(async () => { state.workspace = 'startup-a'; await state.sql`TRUNCATE harness_shared.audit_log`; });

describe('scoped startup activity audit history', () => {
  it.each([
    ['manual', 'native', 'user-choice'], ['login', 'native', 'automatic-start'],
    ['boot', 'native', 'automatic-start'], ['supervisor', 'supervisor', 'service-recovery'],
    ['upgrade', 'native', 'invocation'], ['repair', 'native', 'invocation'], ['unknown', 'native', 'invocation'],
  ] as const)('records a listening native backend with %s provenance and its inventory identity', async (trigger, source, reason) => {
    const native = await readNativeStartupActivity({ platform: 'darwin' });
    const serverId = native.features[0]!.id;
    const at = new Date(Date.now() - 60_000).toISOString();
    await recordNativeStartupActivityStart(trigger, at);
    expect(await readStartupActivityHistory(native.features.map(row => row.id))).toEqual([
      expect.objectContaining({ featureId: serverId, operation: 'start', status: 'running',
        trigger, source, reason, at, previous: null, resulting: null, actor: expect.stringMatching(/^system:[a-f0-9]{64}$/) }),
    ]);
    state.workspace = 'startup-b';
    expect(await readStartupActivityHistory([serverId])).toEqual([]);
  });

  it('drains every current callback once without cancelling or waiting for a future invocation', async () => {
    const scope = { workspaceId: 'startup-a', featureId, source: 'routine' as const, trigger: 'timer' as const };
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    let finishFuture!: () => void;
    const first = runObservedBackgroundActivity(scope, () => new Promise<void>(resolve => { finishFirst = resolve; }));
    const second = runObservedBackgroundActivity(scope, () => new Promise<void>(resolve => { finishSecond = resolve; }));
    let future: Promise<void> | undefined;
    try {
      expect(observedBackgroundActivityStatus(scope)).toEqual({ running: true, stopStatus: null, cancellable: false });
      const stop = stopObservedBackgroundActivity(scope);
      expect(stop.status).toBe('draining');
      expect(stopObservedBackgroundActivity(scope).settled).toBe(stop.settled);
      expect(observedBackgroundActivityStatus(scope)?.stopStatus).toBe('draining');
      let acknowledged = false;
      void stop.settled.then(() => { acknowledged = true; });
      finishFirst();
      await first;
      expect(acknowledged).toBe(false);
      future = runObservedBackgroundActivity(scope, () => new Promise<void>(resolve => { finishFuture = resolve; }));
      const nextStop = stopObservedBackgroundActivity(scope);
      expect(nextStop.settled).not.toBe(stop.settled);
      finishSecond();
      await expect(stop.settled).resolves.toBe('completed');
      expect(observedBackgroundActivityStatus(scope)?.running).toBe(true);
      finishFuture();
      await expect(nextStop.settled).resolves.toBe('completed');
      await Promise.all([second, future]);
      expect(observedBackgroundActivityStatus(scope)).toBeNull();
      expect(stopObservedBackgroundActivity(scope).status).toBe('unavailable');
    } finally {
      finishFirst(); finishSecond(); finishFuture?.();
      await Promise.all([first, second, future]);
    }
  });

  it('isolates workspace and feature controls and reports a failed drain after the callback rejects', async () => {
    const scope = { workspaceId: 'startup-a', featureId, source: 'event' as const, trigger: 'event' as const };
    let fail!: (error: Error) => void;
    const failure = new Error('private effect failure');
    const invocation = runObservedBackgroundActivity(scope, () => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const result = expect(invocation).rejects.toBe(failure);
    try {
      expect(stopObservedBackgroundActivity({ ...scope, workspaceId: 'startup-b' }).status).toBe('unavailable');
      expect(stopObservedBackgroundActivity({ ...scope, featureId: `activity-${'b'.repeat(64)}` }).status).toBe('unavailable');
      const stop = stopObservedBackgroundActivity(scope);
      fail(failure);
      await expect(stop.settled).resolves.toBe('failed');
      await result;
      expect(observedBackgroundActivityStatus(scope)).toBeNull();
      expect(JSON.stringify(await readStartupActivityHistory([featureId]))).not.toContain('private');
    } finally { fail(failure); await result; }
  });

  it('does not project an old stop onto later work that overlaps its settlement', async () => {
    const scope = { workspaceId: 'startup-a', featureId, source: 'routine' as const, trigger: 'timer' as const };
    let finishOld!: () => void;
    let finishNew!: () => void;
    const old = runObservedBackgroundActivity(scope, () => new Promise<void>(resolve => { finishOld = resolve; }));
    const stop = stopObservedBackgroundActivity(scope);
    const next = runObservedBackgroundActivity(scope, () => new Promise<void>(resolve => { finishNew = resolve; }));
    try {
      finishOld();
      await expect(stop.settled).resolves.toBe('completed');
      expect(observedBackgroundActivityStatus(scope)).toEqual({ running: true, stopStatus: null, cancellable: false });
    } finally { finishOld(); finishNew(); await Promise.all([old, next]); }
  });

  it('releases a synchronous failed invocation and refuses unidentified runtime targets', async () => {
    const scope = { workspaceId: 'startup-a', featureId, source: 'event' as const, trigger: 'event' as const };
    await expect(runObservedBackgroundActivity(scope, () => { throw new Error('effect failed'); })).rejects.toThrow('effect failed');
    expect(observedBackgroundActivityStatus(scope)).toBeNull();
    for (const workspaceId of ['', ' ', '*']) {
      expect(() => stopObservedBackgroundActivity({ ...scope, workspaceId })).toThrow('identified invocation');
    }
    expect(() => stopObservedBackgroundActivity({ ...scope, featureId: 'untrusted' })).toThrow('identified invocation');
  });

  it('projects actual local event activity and draining without treating absence as idle', async () => {
    const feature = reactionStartupFeature({ id: 'observed-event', on: 'test:observed', fire: 'test:optional' }, 'startup-a');
    const scope = { workspaceId: 'startup-a', featureId: feature.id, source: 'event' as const, trigger: 'event' as const };
    const snapshot = () => collectCurrentStartupActivity({
      getDbosSchedules: async () => [], getRoutines: async () => [], getManaged: () => [],
      getInProcessChecks: () => ({ checks: [], armed: false }), getExternalProcess: () => [],
      getSiblingManaged: async () => [], getSyncTriggered: () => [],
    }, { native: async () => [], reactions: async () => [structuredClone(feature)],
      policy: async () => feature.desired, history: async () => [], census: async () => [] });
    expect((await snapshot()).features[0]?.observed).toBe('unknown');
    let finish!: () => void;
    const invocation = runObservedBackgroundActivity(scope, () => new Promise<void>(resolve => { finish = resolve; }));
    try {
      expect((await snapshot()).features[0]).toMatchObject({ observed: 'running', stop: { status: null, cancellable: false } });
      const stop = stopObservedBackgroundActivity(scope);
      expect((await snapshot()).features[0]).toMatchObject({ observed: 'running', stop: { status: 'draining', cancellable: false } });
      finish();
      await stop.settled;
      expect((await snapshot()).features[0]?.observed).toBe('unknown');
    } finally { finish(); await invocation; }
  });

  it.each(['manual', 'unknown'] as const)('keeps %s provenance distinct from automatic starts', async trigger => {
    await runObservedBackgroundActivity({ workspaceId: 'startup-a', featureId, source: 'routine', trigger }, async () => {});
    expect(await readStartupActivityHistory([featureId])).toEqual([expect.objectContaining({ trigger,
      reason: trigger === 'manual' ? 'user-choice' : 'invocation',
    })]);
  });

  it('records an asynchronous invocation failure without leaking or swallowing it', async () => {
    const failure = new Error('secret callback rejection');
    await expect(runObservedBackgroundActivity({ workspaceId: 'startup-a', featureId, source: 'timer', trigger: 'timer' },
      async () => { throw failure; })).rejects.toBe(failure);
    const history = await readStartupActivityHistory([featureId]);
    expect(history.map(row => row.status).sort()).toEqual(['failed', 'running']);
    expect(JSON.stringify(history)).not.toContain('secret');
  });

  it.each(['routine', 'event', 'timer', 'sync'] as const)('observes an actual %s invocation in its explicit workspace', async source => {
    let release!: (value: string) => void;
    const invoke = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
    const pending = runObservedBackgroundActivity({ workspaceId: 'startup-b', featureId, source,
      trigger: source === 'event' ? 'event' : source === 'sync' ? 'sync' : 'timer' }, invoke);
    expect(invoke).toHaveBeenCalledOnce();
    await vi.waitFor(async () => expect(await state.sql`SELECT id FROM harness_shared.audit_log`).toHaveLength(1));
    expect(await readStartupActivityHistory([featureId])).toEqual([]);
    state.workspace = 'startup-b';
    expect(await readStartupActivityHistory([featureId])).toEqual([expect.objectContaining({ operation: 'start', status: 'running', source,
      trigger: source === 'event' ? 'event' : source === 'sync' ? 'sync' : 'timer' })]);
    release('value');
    await expect(pending).resolves.toBe('value');
  });

  it('retains callback failures and redacts audit failures without repeating effects', async () => {
    const failure = new Error('private callback payload');
    await expect(runObservedBackgroundActivity({ workspaceId: 'startup-a', featureId, source: 'event', trigger: 'event' },
      () => { throw failure; })).rejects.toBe(failure);
    expect(await readStartupActivityHistory([featureId])).toEqual([expect.objectContaining({ status: 'failed' })]);
    expect(JSON.stringify(await state.sql`SELECT details FROM harness_shared.audit_log`)).not.toContain('private');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await state.sql`ALTER TABLE harness_shared.audit_log RENAME TO unavailable_audit`;
      const invoke = vi.fn(async () => 'effect-result');
      await expect(runObservedBackgroundActivity({ workspaceId: 'startup-a', featureId, source: 'routine', trigger: 'timer' }, invoke))
        .resolves.toBe('effect-result');
      expect(invoke).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith('[background-activity] invocation history unavailable');
    } finally {
      await state.sql`ALTER TABLE harness_shared.unavailable_audit RENAME TO audit_log`;
      warn.mockRestore();
    }
  });

  it('records actor reason and previous preference', async () => {
    const entry = event();
    await recordStartupActivityHistory({ ...entry, secret: 'credential=private' } as StartupActivityHistoryEntry, 'credential=private');
    const rows = await readStartupActivityHistory([featureId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ previous: entry.previous, resulting: entry.resulting, source: 'settings', reason: 'user-choice' });
    expect(rows[0]!.actor).toMatch(/^user:[a-f0-9]{64}$/);
    const stored = await state.sql`SELECT details, actor FROM harness_shared.audit_log`;
    expect(JSON.stringify(stored)).not.toContain('credential');
    expect(JSON.stringify(stored)).not.toContain('secret');
  });

  it('records actual-start causal codes and pending failed or draining outcomes without assuming cancellation', async () => {
    for (const status of ['pending', 'running', 'draining', 'failed'] as const)
      await recordStartupActivityHistory(event({ operation: 'start', status, trigger: 'timer', source: 'timer', reason: 'automatic-start', previous: null, resulting: null }), 'timer-owner', 'system');
    const rows = await readStartupActivityHistory([featureId]);
    expect(rows.map(row => row.status).sort()).toEqual(['draining', 'failed', 'pending', 'running']);
    expect(rows.every(row => row.trigger === 'timer' && row.reason === 'automatic-start')).toBe(true);
    expect(rows.every(row => row.actor.startsWith('system:'))).toBe(true);
  });

  it('excludes another workspace and foreign feature even when both contain valid records', async () => {
    await recordStartupActivityHistory(event(), 'user-a');
    state.workspace = 'startup-b';
    await recordStartupActivityHistory(event(), 'user-b');
    await recordStartupActivityHistory(event({ featureId: `activity-${'b'.repeat(64)}` }), 'user-b');
    expect(await readStartupActivityHistory([featureId])).toHaveLength(1);
    state.workspace = 'startup-a';
    const result = await readStartupActivityHistory([featureId]);
    expect(result).toHaveLength(1);
    expect(result[0]!.actor).not.toBe((await state.sql`SELECT actor FROM harness_shared.audit_log WHERE workspace_id='startup-b' LIMIT 1`)[0]!.actor);
  });

  it('bounds pages to 100 and excludes records older than 30 days or in the future', async () => {
    const now = Date.now();
    for (let i = 0; i < 103; i++) await recordStartupActivityHistory(event({ at: new Date(now - i).toISOString() }), 'user');
    await recordStartupActivityHistory(event({ at: new Date(now - 31 * 86_400_000).toISOString() }), 'old');
    await recordStartupActivityHistory(event({ at: new Date(now + 86_400_000).toISOString() }), 'future');
    expect(await readStartupActivityHistory([featureId], 1000)).toHaveLength(100);
    expect(await readStartupActivityHistory([featureId], 2)).toHaveLength(2);
    expect(await readStartupActivityHistory([featureId], Number.NaN)).toHaveLength(100);
  });

  it('strips undeclared fields on read, rejects unsafe codes on write and fails closed on malformed stored history', async () => {
    await recordStartupActivityHistory(event(), 'user');
    await state.sql`UPDATE harness_shared.audit_log SET details = jsonb_set(details, '{startupActivity,private}', '"token"')`;
    expect(JSON.stringify(await readStartupActivityHistory([featureId]))).not.toContain('token');
    await expect(recordStartupActivityHistory(event({ reason: 'secret' as never }), 'user')).rejects.toThrow();
    await expect(recordStartupActivityHistory(event({ trigger: 'https://private.example' }), 'user')).rejects.toThrow();
    await expect(recordStartupActivityHistory(event(), '')).rejects.toThrow('actor identity');
    await expect(recordStartupActivityHistory(event({ previous: null }), 'user')).rejects.toThrow('previous and resulting');
    await expect(recordStartupActivityHistory(event({ resulting: { automatic: true, pausedUntil: null, revision: 1 } }), 'user')).rejects.toThrow('previous and resulting');
    await state.sql`UPDATE harness_shared.audit_log SET details = jsonb_set(details, '{startupActivity,actor}', '"credential"')`;
    await expect(readStartupActivityHistory([featureId])).rejects.toThrow('record unavailable');
    state.workspace = '';
    await expect(readStartupActivityHistory([featureId])).rejects.toThrow('workspace identity');
  });
});
