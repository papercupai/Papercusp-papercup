import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { SevereEventBroadcast } from '../severe-event-broadcast';
import { DEFAULT_SIGNAL_ABSENCE_MS } from '../system-health/condition-staleness-alarm';
import {
  CONNECTOR_SOURCE_ALARM_REFRESH_MS,
  connectorSourceAlarm,
  connectorSourceAlarmKey,
  isFreshOpenAlarm,
  runConnectorSourceHealthCheck,
  type ConnectorSourceHealthDeps,
  type UnhealthyConnectorSource,
} from './connector-source-health';

const sql = {} as postgres.Sql;
const WS = 'papercusp-workspace';
const T0 = Date.parse('2026-10-21T06:00:00.000Z');
const MIN = 60_000;

function source(overrides: Partial<UnhealthyConnectorSource> = {}): UnhealthyConnectorSource {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'gcal',
    status: 'degraded',
    providerAccountId: 'super@papercusp.com',
    lastError: 'provider_google_oauth_provider_not_registered',
    failureCount: 16,
    lastSuccessAt: new Date('2026-10-20T15:41:00.000Z'),
    nextAttemptAt: new Date('2026-10-21T06:30:00.000Z'),
    ...overrides,
  };
}

/**
 * A fake condition log with the severe-event rail's semantics: a broadcast whose summary repeats the
 * open alarm is a heartbeat (it refreshes `ts` but is not a new message); a resolution closes the key.
 */
function conditionLog(clock: { now: number }) {
  const latest = new Map<string, Record<string, unknown>>();
  const messages: SevereEventBroadcast[] = [];
  const heartbeats: string[] = [];
  const resolutions: string[] = [];
  const deps: ConnectorSourceHealthDeps = {
    now: () => clock.now,
    readLatest: async (key) => latest.get(key) ?? null,
    broadcast: async (event) => {
      const key = event.conditionKey!;
      const prior = latest.get(key);
      const repeat = !!prior && !('resolves_condition' in prior) && prior.summary === event.summary;
      if (repeat) heartbeats.push(key);
      else messages.push(event);
      latest.set(key, { condition_key: key, summary: event.summary, ts: new Date(clock.now).toISOString() });
      return true;
    },
    resolve: async (key) => {
      const prior = latest.get(key);
      if (!prior || 'resolves_condition' in prior) return false;
      resolutions.push(key);
      latest.set(key, { condition_key: key, resolves_condition: key, ts: new Date(clock.now).toISOString() });
      return true;
    },
  };
  return { deps, messages, heartbeats, resolutions };
}

describe('connector source health alarm (WI-6554700010018612)', () => {
  it('re-signals well inside the signal-absence window, so a still-broken source is never auto-resolved', () => {
    expect(CONNECTOR_SOURCE_ALARM_REFRESH_MS * 2).toBeLessThanOrEqual(DEFAULT_SIGNAL_ABSENCE_MS);
  });

  it('one degraded episode: exactly one condition, quiet ticks, a refresh, then resolved on recovery', async () => {
    const clock = { now: T0 };
    const log = conditionLog(clock);
    let rows = [source()];
    const deps = { ...log.deps, listUnhealthy: async () => rows };
    const key = connectorSourceAlarmKey(rows[0].id);

    // Tick 1: the source is degraded and has no condition yet.
    expect(await runConnectorSourceHealthCheck(sql, { workspaceId: WS }, deps)).toEqual({
      unhealthy: 1, signalled: 1, resolved: 0, errors: [],
    });
    expect(log.messages).toHaveLength(1);
    expect(log.messages[0]).toMatchObject({
      conditionKey: key,
      summary: 'Connector source gcal for super@papercusp.com is degraded',
    });
    expect(log.messages[0].body).toContain('provider_google_oauth_provider_not_registered');
    expect(log.messages[0].body).toContain('Consecutive failures: 16');
    expect(log.messages[0]).not.toHaveProperty('route');

    // Ticks every minute for the next 29 minutes write nothing at all.
    for (let minute = 1; minute < 30; minute += 1) {
      clock.now = T0 + minute * MIN;
      expect((await runConnectorSourceHealthCheck(sql, { workspaceId: WS }, deps)).signalled).toBe(0);
    }
    expect(log.messages).toHaveLength(1);
    expect(log.heartbeats).toHaveLength(0);

    // Past the refresh interval the condition is refreshed, still as the SAME condition.
    clock.now = T0 + 31 * MIN;
    expect((await runConnectorSourceHealthCheck(sql, { workspaceId: WS }, deps)).signalled).toBe(1);
    expect(log.messages).toHaveLength(1);
    expect(log.heartbeats).toEqual([key]);

    // A clean pass brought it back: no longer listed, and its condition is resolved.
    rows = [];
    clock.now = T0 + 40 * MIN;
    expect(await runConnectorSourceHealthCheck(sql, { workspaceId: WS, recovered: [source().id] }, deps))
      .toEqual({ unhealthy: 0, signalled: 0, resolved: 1, errors: [] });
    expect(log.resolutions).toEqual([key]);

    // A later failure is a new episode, so it is a new message.
    rows = [source()];
    clock.now = T0 + 50 * MIN;
    await runConnectorSourceHealthCheck(sql, { workspaceId: WS }, deps);
    expect(log.messages).toHaveLength(2);
  });

  it('a status change is new information and is broadcast at once', async () => {
    const clock = { now: T0 };
    const log = conditionLog(clock);
    let rows = [source()];
    const deps = { ...log.deps, listUnhealthy: async () => rows };
    await runConnectorSourceHealthCheck(sql, { workspaceId: WS }, deps);
    rows = [source({ status: 'error', lastError: 'reconnect_required: invalid_grant', nextAttemptAt: null })];
    clock.now = T0 + MIN;
    await runConnectorSourceHealthCheck(sql, { workspaceId: WS }, deps);
    expect(log.messages.map((m) => m.summary)).toEqual([
      'Connector source gcal for super@papercusp.com is degraded',
      'Connector source gcal for super@papercusp.com is error',
    ]);
  });

  it('routes the statuses only the account owner can clear to the human', () => {
    for (const status of ['error', 'reconnect_required']) {
      const event = connectorSourceAlarm(source({ status, nextAttemptAt: null }));
      expect(event.route).toEqual({ ownerSelector: 'human', reason: expect.stringContaining('reconnect') });
      expect(event.body).toContain('Next attempt: none scheduled');
      expect(event.body).toContain('reconnects the account');
    }
    expect(connectorSourceAlarm(source({ status: 'degraded' }))).not.toHaveProperty('route');
  });

  it('one source failing to signal never stops the others, and is reported', async () => {
    const a = source({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
    const b = source({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', kind: 'contacts' });
    const broadcast = vi.fn(async (event: SevereEventBroadcast) => {
      if (event.conditionKey === connectorSourceAlarmKey(a.id)) throw new Error('coord down');
      return true;
    });
    const result = await runConnectorSourceHealthCheck(sql, { workspaceId: WS }, {
      listUnhealthy: async () => [a, b],
      readLatest: async () => null,
      broadcast,
      now: () => T0,
    });
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ unhealthy: 2, signalled: 1, resolved: 0, errors: [`${a.id}: coord down`] });
  });

  it('an unreadable condition log still broadcasts (a duplicate costs less than a lost alarm)', async () => {
    const broadcast = vi.fn(async () => true);
    await runConnectorSourceHealthCheck(sql, { workspaceId: WS }, {
      listUnhealthy: async () => [source()],
      readLatest: async () => { throw new Error('pg timeout'); },
      broadcast,
      now: () => T0,
    });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });
});

describe('isFreshOpenAlarm', () => {
  const key = connectorSourceAlarmKey('s1');
  const summary = 'Connector source gmail for a@b.c is degraded';
  const at = (minutesAgo: number) => new Date(T0 - minutesAgo * MIN).toISOString();

  it('is fresh only for an open alarm with the same key and summary inside the refresh interval', () => {
    expect(isFreshOpenAlarm({ condition_key: key, summary, ts: at(5) }, key, summary, T0)).toBe(true);
    expect(isFreshOpenAlarm({ condition_key: key, summary, ts: at(31) }, key, summary, T0)).toBe(false);
    expect(isFreshOpenAlarm({ condition_key: key, summary: 'other', ts: at(5) }, key, summary, T0)).toBe(false);
    expect(isFreshOpenAlarm({ condition_key: key, summary, resolves_condition: key, ts: at(5) }, key, summary, T0)).toBe(false);
    expect(isFreshOpenAlarm({ condition_key: key, summary, ts: 'not a time' }, key, summary, T0)).toBe(false);
    expect(isFreshOpenAlarm(null, key, summary, T0)).toBe(false);
  });
});
