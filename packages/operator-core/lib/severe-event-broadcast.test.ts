/**
 * severe-event-broadcast — the opt-in severe-events topic rail + the
 * WI-1444 condition lifecycle (conditionKey stamping + resolution supersede).
 * sendMessage mocked. Pins:
 *   • broadcastSevereEvent → to:['@topic:severe-events'], default category 'severe-event';
 *   • conditionKey stamps extra.condition_key (the inbox-annotation join key);
 *   • WI-7309: extra.emitter (pid / startedAt / uptimeSec / cwd) is stamped
 *     UNCONDITIONALLY, and the body carries a rendered trailer — so "which
 *     process fired this alarm" is a field read rather than an hour of streak
 *     arithmetic cross-referenced against `ps`;
 *   • broadcastSevereEventResolved → category 'severe-event-resolved' +
 *     extra.resolves_condition + extra.condition_key (same key, so a
 *     resolution row is itself queryable by condition);
 *   • both are fail-soft: a sendMessage rejection returns false, never throws
 *     (a broadcast failure must never break the watchdog sweep that calls it).
 *
 * Run: cd packages/operator-core && npx vitest run lib/severe-event-broadcast.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const M = vi.hoisted(() => ({
  sendMessage: vi.fn(async (..._args: unknown[]) => ({ to: [] }) as unknown),
  wakeRecipients: vi.fn(async (..._args: unknown[]) => ({}) as unknown),
  wakeModuleLoads: 0,
  // WI-37625: the retirement flag the `@role:mug` delivery gate reads. Defaults to
  // FALSE because default-OFF IS the delivered end state (D-020) — the tier being ON is
  // the reversible testing escape hatch, not the baseline.
  mugKettleSystemEnabled: vi.fn(async () => false),
  // WI-6554700010011878: the key's newest condition envelope. Defaults to null (no prior
  // envelope), so every pre-existing test sees an unchanged broadcast.
  readLatestConditionEnvelope: vi.fn(async (_key: string) => null as Record<string, unknown> | null),
}));
vi.mock('./agent-tools/coordination/messages', () => ({ sendMessage: M.sendMessage }));
vi.mock('./agent-tools/coordination/condition-state', () => ({
  readLatestConditionEnvelope: M.readLatestConditionEnvelope,
}));
vi.mock('./agent-tools/coordination/inbox-wake', () => {
  M.wakeModuleLoads++;
  return { wakeRecipients: M.wakeRecipients };
});
vi.mock('./pot/started', () => ({ mugKettleSystemEnabled: M.mugKettleSystemEnabled }));

import {
  broadcastSevereEvent,
  broadcastSevereEventResolved,
  broadcastSevereEventResolvedMany,
  isRepeatOfOpenOneShotAlarm,
} from './severe-event-broadcast';

const wakeModuleLoadsOnImport = M.wakeModuleLoads;

beforeEach(() => {
  vi.clearAllMocks();
  M.readLatestConditionEnvelope.mockImplementation(async () => null);
  M.sendMessage.mockImplementation(async (..._args: unknown[]) => ({ to: [] }) as unknown);
  M.wakeRecipients.mockImplementation(async (..._args: unknown[]) => ({}) as unknown);
});

describe('broadcastSevereEvent', () => {
  it('loads condition delivery without loading the optional wake engine', () => {
    expect(wakeModuleLoadsOnImport).toBe(0);
  });

  it('reuses the atomic message identity only for the same original alarm resolution', async () => {
    for (const alarmMessageId of ['original-1', 'original-1', 'original-2'])
      await broadcastSevereEventResolved({ conditionKey: 'alarm:test', summary: 'ended', alarmMessageId });
    const ids = M.sendMessage.mock.calls.map(([, options]) => (options as Record<string, unknown>).msgId);
    expect(ids[0]).toEqual(ids[1]);
    expect(ids[0]).not.toEqual(ids[2]);
    expect(ids[0]).toMatch(/^condition-resolution-[a-f0-9]{64}$/);
  });
  it('persists original episode evidence beside the authoritative emitter stamp', async () => {
    const data = { id: 7, timerKey: 'held#7', heldMs: 310_000, producerRun: 'original', emitter: 'untrusted' };
    await broadcastSevereEvent({ summary: 'held', conditionKey: 'alarm:managed-tick:original:7', oneShot: true, data });
    const [, opts] = M.sendMessage.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts.extra).toMatchObject({
      condition_key: 'alarm:managed-tick:original:7', one_shot: true, data,
      emitter: { pid: process.pid },
    });
  });
  it('routes to the stable severe-events topic with the default category', async () => {
    const ok = await broadcastSevereEvent({ summary: 's', body: 'b' });
    expect(ok).toBe(true);
    expect(M.sendMessage).toHaveBeenCalledTimes(1);
    const [identity, opts] = M.sendMessage.mock.calls[0] as [
      { ownerId: string },
      Record<string, unknown>,
    ];
    expect(identity.ownerId).toBe('system-watchdog');
    expect(opts).toMatchObject({ to: ['@topic:severe-events'], summary: 's', category: 'severe-event' });
    // The caller's body is preserved verbatim as the PREFIX; WI-7309 appends the
    // emitter trailer after it.
    expect(String(opts.body)).toMatch(/^b/);
    // No condition stamp unless the caller opts into the lifecycle — but the WI-7309
    // emitter stamp is unconditional, so `extra` itself is always present now.
    expect((opts.extra as Record<string, unknown>).condition_key).toBeUndefined();
  });

  it('stamps extra.condition_key when conditionKey is passed (WI-1444)', async () => {
    await broadcastSevereEvent({ summary: 's', conditionKey: 'git-sync-stall:papercusp' });
    const [, opts] = M.sendMessage.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts.extra).toMatchObject({ condition_key: 'git-sync-stall:papercusp' });
  });

  // WI-7309 — the recurrence guard. Without emitter identity, a false alarm from a
  // long-lived host running frozen pre-fix code is INDISTINGUISHABLE from a real one,
  // and attribution costs hours. These pin the field so it cannot be silently dropped.
  describe('emitter identity (WI-7309)', () => {
    it('stamps extra.emitter unconditionally — no conditionKey, no route, nothing opted in', async () => {
      await broadcastSevereEvent({ summary: 's' });
      const [, opts] = M.sendMessage.mock.calls[0] as [unknown, Record<string, unknown>];
      const emitter = (opts.extra as Record<string, unknown>).emitter as Record<string, unknown>;
      expect(emitter).toBeDefined();
      expect(emitter.pid).toBe(process.pid);
      expect(typeof emitter.cwd).toBe('string');
      expect(typeof emitter.host).toBe('string');
      // The process identity is best-effort on non-Linux hosts, but when present it
      // is the PID-reuse guard used by one-shot condition reconciliation.
      if (emitter.processIdentity != null) expect(typeof emitter.processIdentity).toBe('string');
      expect(typeof emitter.uptimeSec).toBe('number');
      expect(emitter.uptimeSec as number).toBeGreaterThanOrEqual(0);
      // startedAt must be a real ISO instant, not in the future — it is THE discriminator
      // for "did this process start before the fix landed", so a malformed value is useless.
      const startedAt = Date.parse(String(emitter.startedAt));
      expect(Number.isNaN(startedAt)).toBe(false);
      expect(startedAt).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it('appends a body trailer naming the pid AND the interpretation rule', async () => {
      await broadcastSevereEvent({ summary: 's', body: 'original body' });
      const [, opts] = M.sendMessage.mock.calls[0] as [unknown, Record<string, unknown>];
      const body = String(opts.body);
      expect(body).toContain('original body');
      expect(body).toContain(`pid ${process.pid}`);
      // The rule is the load-bearing half: raw numbers alone did not prevent the
      // 2026-08-03 misattribution — a reader has to know what an old start time MEANS.
      expect(body).toMatch(/PREDATES/);
      expect(body).toMatch(/no hot-reload/);
    });

    it('stamps the emitter even when the caller passes no body at all', async () => {
      await broadcastSevereEvent({ summary: 's' });
      const [, opts] = M.sendMessage.mock.calls[0] as [unknown, Record<string, unknown>];
      expect(String(opts.body)).toContain(`pid ${process.pid}`);
      expect(String(opts.body)).not.toContain('undefined');
    });

    it('carries the same trailer onto the directed route, not just the broadcast', async () => {
      M.sendMessage.mockImplementation(
        async (..._args: unknown[]) => ({ to: ['owner-1'] }) as unknown,
      );
      await broadcastSevereEvent({
        summary: 's',
        body: 'b',
        route: { ownerSelector: 'owner-1', reason: 'owns it' },
      });
      // call 0 = the '*' broadcast, call 1 = the directed route.
      expect(M.sendMessage).toHaveBeenCalledTimes(2);
      const [, routed] = M.sendMessage.mock.calls[1] as [unknown, Record<string, unknown>];
      expect(String(routed.body)).toContain(`pid ${process.pid}`);
    });
  });

  it('fail-soft: a sendMessage rejection returns false, never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      M.sendMessage.mockRejectedValueOnce(new Error('pg down'));
      await expect(broadcastSevereEvent({ summary: 's' })).resolves.toBe(false);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('broadcastSevereEvent — EI-10060 route leg (additive, opt-in)', () => {
  it('no route ⇒ only the topic notice fires; no directed send, no wake', async () => {
    await broadcastSevereEvent({ summary: 's' });
    expect(M.sendMessage).toHaveBeenCalledTimes(1); // the broadcast alone
    expect(M.wakeRecipients).not.toHaveBeenCalled();
  });

  it('a route ⇒ a SEPARATE directed send to the owner selector, in ADDITION to the topic notice', async () => {
    M.sendMessage
      .mockImplementationOnce(async () => ({ to: ['topic-subscriber'] })) // the topic delivery
      .mockImplementationOnce(async () => ({ to: ['su-mug-1'] })); // the directed route call

    await broadcastSevereEvent({
      summary: 'health tick frozen',
      route: { ownerSelector: '@role:mug', reason: 'fleet-health role' },
    });

    expect(M.sendMessage).toHaveBeenCalledTimes(2);
    const [, broadcastOpts] = M.sendMessage.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(broadcastOpts).toMatchObject({ to: ['@topic:severe-events'], summary: 'health tick frozen' });
    const [, routeOpts] = M.sendMessage.mock.calls[1] as [unknown, Record<string, unknown>];
    // WI-37625: with the Mug tier retired (the default), a `@role:mug` route is redirected
    // to the owner — that slot is drained only by a Mug spawn, so the routed "you are on
    // the hook" leg used to dead-end while the broadcast still looked healthy.
    expect(routeOpts).toMatchObject({
      to: ['human'],
      expectsReply: true,
    });
    expect(routeOpts.summary).toContain('fleet-health role');
    expect(routeOpts.summary).toContain('health tick frozen');
    expect(routeOpts.summary).toContain('the Mug tier is retired');
  });

  /**
   * CALIBRATION for the gate above. Without this, `gateMugSelector` could simply return
   * 'human' unconditionally — every other assertion in this file would still pass, and
   * the escape hatch would be silently dead. This is the case that fails if the gate
   * stops reading the flag at all.
   */
  it('preserves the legacy @role:mug slot when the tier is switched ON (WI-37625)', async () => {
    M.mugKettleSystemEnabled.mockResolvedValueOnce(true);
    M.sendMessage
      .mockImplementationOnce(async () => ({ to: ['topic-subscriber'] }))
      .mockImplementationOnce(async () => ({ to: ['su-mug-1'] }));

    await broadcastSevereEvent({
      summary: 'health tick frozen',
      route: { ownerSelector: '@role:mug', reason: 'fleet-health role' },
    });

    const [, routeOpts] = M.sendMessage.mock.calls[1] as [unknown, Record<string, unknown>];
    expect(routeOpts).toMatchObject({ to: ['@role:mug'] });
    expect(routeOpts.summary).not.toContain('the Mug tier is retired');
  });

  /**
   * The gate must be NARROW — it exists to redirect one dead slot, not to re-route
   * severe-event ownership generally. A `@fleet-leader:` selector resolves to a live
   * leader at send time and was never affected by the retirement.
   */
  it('leaves a non-Mug owner selector untouched (WI-37625)', async () => {
    M.sendMessage
      .mockImplementationOnce(async () => ({ to: ['topic-subscriber'] }))
      .mockImplementationOnce(async () => ({ to: ['su-leader-2'] }));

    await broadcastSevereEvent({
      summary: 's',
      route: { ownerSelector: '@fleet-leader:drain-crew', reason: 'fleet-scoped condition' },
    });

    const [, routeOpts] = M.sendMessage.mock.calls[1] as [unknown, Record<string, unknown>];
    expect(routeOpts).toMatchObject({ to: ['@fleet-leader:drain-crew'] });
    expect(routeOpts.summary).toContain('fleet-scoped condition');
    expect(routeOpts.summary).not.toContain('the Mug tier is retired');
  });

  it('wakes whoever the route resolved to LIVE (env.to from sendMessage), not the raw selector', async () => {
    M.sendMessage
      .mockImplementationOnce(async () => ({ to: ['topic-subscriber'] }))
      .mockImplementationOnce(async () => ({ to: ['su-live-mug-session'] }));

    await broadcastSevereEvent({
      summary: 's',
      route: { ownerSelector: '@role:mug', reason: 'r' },
    });

    expect(M.wakeRecipients).toHaveBeenCalledTimes(1);
    const [recipients] = M.wakeRecipients.mock.calls[0] as [string[]];
    expect(recipients).toEqual(['su-live-mug-session']);
  });

  it('a role slot with NO live holder (env.to empty — durable park only) skips the wake, no error', async () => {
    M.sendMessage
      .mockImplementationOnce(async () => ({ to: ['topic-subscriber'] }))
      .mockImplementationOnce(async () => ({ to: [] })); // parked, nobody live

    await expect(
      broadcastSevereEvent({ summary: 's', route: { ownerSelector: '@role:mug', reason: 'r' } }),
    ).resolves.toBe(true);
    expect(M.wakeRecipients).not.toHaveBeenCalled();
  });

  it('a route delivery failure is fail-soft: the broadcast itself still reports success', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      M.sendMessage
        .mockImplementationOnce(async () => ({ to: ['topic-subscriber'] })) // the topic notice succeeds
        .mockImplementationOnce(async () => {
          throw new Error('route send failed');
        });
      await expect(
        broadcastSevereEvent({ summary: 's', route: { ownerSelector: '@role:mug', reason: 'r' } }),
      ).resolves.toBe(true);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('broadcastSevereEventResolved (WI-1444)', () => {
  it('broadcasts the all-clear with resolves_condition + condition_key', async () => {
    const ok = await broadcastSevereEventResolved({
      conditionKey: 'green-stall:papercusp',
      summary: 'green-checkpoint RECOVERED on papercusp',
    });
    expect(ok).toBe(true);
    const [identity, opts] = M.sendMessage.mock.calls[0] as [
      { ownerId: string },
      Record<string, unknown>,
    ];
    expect(identity.ownerId).toBe('system-watchdog');
    expect(opts).toMatchObject({
      to: ['@topic:severe-events'],
      category: 'severe-event-resolved',
      extra: {
        resolves_condition: 'green-stall:papercusp',
        condition_key: 'green-stall:papercusp',
      },
    });
  });

  it('fail-soft: a sendMessage rejection returns false, never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      M.sendMessage.mockRejectedValueOnce(new Error('pg down'));
      await expect(
        broadcastSevereEventResolved({ conditionKey: 'k', summary: 's' }),
      ).resolves.toBe(false);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('broadcastSevereEventResolvedMany (EI-9030b — one coalesced all-clear)', () => {
  it('sends ONE message carrying every condition key (plural) + the singular first-key stamp', async () => {
    const keys = ['git-sync-stall:x', 'git-sync-stall:y', 'git-sync-stall:z'];
    const ok = await broadcastSevereEventResolvedMany({
      conditionKeys: keys,
      summary: 'git-sync RECOVERED on 3 harnesses',
    });
    expect(ok).toBe(true);
    expect(M.sendMessage).toHaveBeenCalledTimes(1); // ONE message, not one per harness
    const [, opts] = M.sendMessage.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts).toMatchObject({
      to: ['@topic:severe-events'],
      category: 'severe-event-resolved',
      extra: {
        resolves_conditions: keys,
        resolves_condition: 'git-sync-stall:x',
        condition_key: 'git-sync-stall:x',
      },
    });
  });

  it('a 0-key call is a no-op (no message sent) and returns true', async () => {
    const ok = await broadcastSevereEventResolvedMany({ conditionKeys: [], summary: 's' });
    expect(ok).toBe(true);
    expect(M.sendMessage).not.toHaveBeenCalled();
  });

  it('fail-soft: a sendMessage rejection returns false, never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      M.sendMessage.mockRejectedValueOnce(new Error('pg down'));
      await expect(
        broadcastSevereEventResolvedMany({ conditionKeys: ['k'], summary: 's' }),
      ).resolves.toBe(false);
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});

// WI-6554700010011878 — the one-shot contract is enforced at this chokepoint. Measured
// 2026-10-14: 75% of the 30-day condition log was one-shot re-alarms repeating a still-open
// key's summary, which overflowed the condition fold window and re-woke routed owners on
// every watchdog tick.
describe('broadcastSevereEvent — one-shot contract (WI-6554700010011878)', () => {
  const key = 'alarm:ungraded-filings:stale:scout';
  const summary = 'scout has at least 10 filing(s) ungraded > 2d';
  const openAlarm = (s: string) => ({ condition_key: key, summary: s, one_shot: true, ts: 't1' });

  it('does not re-send a oneShot alarm that repeats its open key: no broadcast, no routed send, no wake', async () => {
    M.readLatestConditionEnvelope.mockResolvedValue(openAlarm(summary));
    const ok = await broadcastSevereEvent({
      summary,
      conditionKey: key,
      oneShot: true,
      route: { ownerSelector: 'su-owner-1', reason: 'owns scout grading' },
    });
    expect(ok).toBe(true); // the alarm is still in effect
    expect(M.readLatestConditionEnvelope).toHaveBeenCalledWith(key);
    expect(M.sendMessage).not.toHaveBeenCalled();
    expect(M.wakeRecipients).not.toHaveBeenCalled();
  });

  it('sends the first alarm of a key (no prior envelope)', async () => {
    await broadcastSevereEvent({ summary, conditionKey: key, oneShot: true });
    expect(M.sendMessage).toHaveBeenCalledOnce();
    const [, opts] = M.sendMessage.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts.extra).toMatchObject({ condition_key: key, one_shot: true });
  });

  it('sends a changed summary, because it is new information', async () => {
    M.readLatestConditionEnvelope.mockResolvedValue(openAlarm('scout has at least 9 filing(s) ungraded > 2d'));
    await broadcastSevereEvent({ summary, conditionKey: key, oneShot: true });
    expect(M.sendMessage).toHaveBeenCalledOnce();
  });

  it('sends after a singular resolution: a new episode', async () => {
    M.readLatestConditionEnvelope.mockResolvedValue({ condition_key: key, resolves_condition: key, summary });
    await broadcastSevereEvent({ summary, conditionKey: key, oneShot: true });
    expect(M.sendMessage).toHaveBeenCalledOnce();
  });

  it('sends after a batched resolution that names the key in resolves_conditions only', async () => {
    M.readLatestConditionEnvelope.mockResolvedValue({
      condition_key: 'other', resolves_condition: 'other', resolves_conditions: ['other', key], summary,
    });
    await broadcastSevereEvent({ summary, conditionKey: key, oneShot: true });
    expect(M.sendMessage).toHaveBeenCalledOnce();
  });

  it('suppresses a repeated level-triggered alarm with an empty-audience heartbeat', async () => {
    M.readLatestConditionEnvelope.mockResolvedValue(openAlarm(summary));
    await broadcastSevereEvent({
      summary,
      conditionKey: key,
      route: { ownerSelector: 'su-owner-1', reason: 'owns scout grading' },
    });
    expect(M.readLatestConditionEnvelope).toHaveBeenCalledWith(key);
    expect(M.sendMessage).toHaveBeenCalledOnce();
    const [, opts] = M.sendMessage.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(opts).toMatchObject({ to: [], summary, category: 'severe-event' });
    expect(opts.extra).toMatchObject({ condition_key: key, condition_heartbeat: true });
    expect((opts.extra as Record<string, unknown>).one_shot).toBeUndefined();
    expect(M.wakeRecipients).not.toHaveBeenCalled();
  });

  it('fails OPEN: a read failure still broadcasts', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      M.readLatestConditionEnvelope.mockRejectedValueOnce(new Error('pg down'));
      await expect(broadcastSevereEvent({ summary, conditionKey: key, oneShot: true })).resolves.toBe(true);
      expect(M.sendMessage).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it('isRepeatOfOpenOneShotAlarm: only an open alarm for the same key with the same summary is a repeat', () => {
    expect(isRepeatOfOpenOneShotAlarm(null, key, summary)).toBe(false);
    expect(isRepeatOfOpenOneShotAlarm(openAlarm(summary), key, summary)).toBe(true);
    expect(isRepeatOfOpenOneShotAlarm(openAlarm(summary), 'another-key', summary)).toBe(false);
    expect(isRepeatOfOpenOneShotAlarm(openAlarm('older words'), key, summary)).toBe(false);
    expect(isRepeatOfOpenOneShotAlarm({ ...openAlarm(summary), resolves_condition: key }, key, summary)).toBe(false);
    expect(isRepeatOfOpenOneShotAlarm({ ...openAlarm(summary), resolves_conditions: [key] }, key, summary)).toBe(false);
  });
});
