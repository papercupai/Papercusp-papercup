import { describe, expect, it, vi } from 'vitest';
import { escalateAlarm, resolveAlarm } from './alarm-attention';
import { isActionableConditionKey } from './coord/actionable-conditions';
import { mockReturnOnceTyped } from './testing/typed-mock';
const { readLatestConditionEnvelopeMock, broadcastResolvedMock } = vi.hoisted(() => ({
  readLatestConditionEnvelopeMock: vi.fn(async (_conditionKey: string) => null as null | Record<string, unknown>),
  broadcastResolvedMock: vi.fn(async () => true),
}));
vi.mock('./agent-tools/coordination/tools/conditions', () => ({
  readLatestConditionEnvelope: readLatestConditionEnvelopeMock,
  readConditionEnvelopes: vi.fn(async () => []),
  computeConditionStates: vi.fn(() => []),
}));
vi.mock('./severe-event-broadcast', () => ({
  broadcastSevereEvent: vi.fn(async () => true),
  broadcastSevereEventResolved: broadcastResolvedMock,
}));

const request = {
  title: 'Test alarm',
  body: 'attention required',
  cooldownMs: 60_000,
  source: 'alarm-attention-test',
  conditionKey: 'alarm:test',
};

describe('escalateAlarm', () => {
  it('preserves detector evidence without allowing it to replace the condition identity', async () => {
    const notify = vi.fn(async () => {});
    await escalateAlarm({ ...request, data: { host: 'fixture-host', consumers: { '/': ['postgres'] }, conditionKey: 'wrong' } }, {
      notify, recentlyEscalated: async () => false,
    });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({
      data: { host: 'fixture-host', consumers: { '/': ['postgres'] }, conditionKey: request.conditionKey },
    }));
  });
  it('delivers when the durable cooldown is clear', async () => {
    const notify = vi.fn(async () => {});
    const result = await escalateAlarm(request, {
      notify,
      recentlyEscalated: async () => false,
    });

    expect(result).toBe(true);
    // The injected seam receives the SAME input production delivers: urgency and routing
    // data included (WI-6554700010009741 — a {title, body}-only seam hid both from tests).
    expect(notify).toHaveBeenCalledWith({
      kind: 'intervention',
      title: request.title,
      body: request.body,
      importance: 'urgent',
      data: { conditionKey: request.conditionKey },
    });
  });

  it('suppresses a repeat while the durable cooldown is active', async () => {
    const notify = vi.fn(async () => {});
    const result = await escalateAlarm(request, {
      notify,
      recentlyEscalated: async () => true,
    });

    expect(result).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('fails open when the delivery rail throws without escaping the alarm tick', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await escalateAlarm(request, {
      notify: async () => {
        throw new Error('push rail down');
      },
      recentlyEscalated: async () => false,
    });

    expect(result).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[alarm-attention-test] escalation failed'));
    warn.mockRestore();
  });

  it('broadcasts alarm conditions without making them scheduler-actionable', async () => {
    const broadcast = vi.fn(async () => true);
    const notify = vi.fn(async () => {});
    const conditionKey = 'alarm:replication-slot';
    expect(isActionableConditionKey(conditionKey)).toBe(false);
    expect(await escalateAlarm({ ...request, conditionKey }, {
      broadcast, notify, recentlyEscalated: async () => true,
    })).toBe(false);
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ conditionKey }));
    expect(notify).not.toHaveBeenCalled();
    const resolve = vi.fn(async () => true);
    expect(await resolveAlarm(conditionKey, request.source, { resolve })).toBe(true);
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ conditionKey }));
  });

  it('keeps owner delivery and recovery best effort when condition delivery fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const notify = vi.fn(async () => {});
    const fail = async () => { throw new Error('condition rail unavailable'); };
    try {
      expect(await escalateAlarm({ ...request, conditionKey: 'alarm:test' }, {
        broadcast: fail, notify, recentlyEscalated: async () => false,
      })).toBe(true);
      expect(notify).toHaveBeenCalledOnce();
      expect(await resolveAlarm('alarm:test', request.source, { resolve: fail })).toBe(false);
    } finally { warn.mockRestore(); }
  });
});

describe('default alarm recovery', () => {
  it('resolves a long-open condition from the exact-key read when it is outside the shared fold window', async () => {
    vi.clearAllMocks();
    const conditionKey = 'alarm:old-one-shot';
    readLatestConditionEnvelopeMock.mockResolvedValue({ condition_key: conditionKey });

    expect(await resolveAlarm(conditionKey, request.source)).toBe(true);
    expect(readLatestConditionEnvelopeMock).toHaveBeenCalledWith(conditionKey);
    expect(broadcastResolvedMock).toHaveBeenCalledWith({
      conditionKey,
      summary: `${request.source} recovered`,
    });
  });

  it('does not resolve a condition whose latest exact-key envelope is already a resolution', async () => {
    vi.clearAllMocks();
    const conditionKey = 'alarm:already-resolved';
    readLatestConditionEnvelopeMock.mockResolvedValue({
      condition_key: conditionKey,
      resolves_condition: conditionKey,
    });

    expect(await resolveAlarm(conditionKey, request.source)).toBe(false);
    expect(broadcastResolvedMock).not.toHaveBeenCalled();
  });

  it('retains the bounded condition fold when the exact-key lookup has no PG fast path', async () => {
    vi.clearAllMocks();
    const conditionKey = 'alarm:legacy-transport';
    readLatestConditionEnvelopeMock.mockResolvedValue(null);
    const { computeConditionStates } = await import('./agent-tools/coordination/tools/conditions');
    mockReturnOnceTyped(vi.mocked(computeConditionStates), [
      {
        condition_key: conditionKey,
        open: true,
        from: 'test',
        category: null,
        first_seen: '2026-10-14T00:00:00.000Z',
        open_since: '2026-10-14T00:00:00.000Z',
        last_seen: '2026-10-14T00:00:00.000Z',
        alarm_count: 1,
        latest_summary: null,
        latest_body: null,
        resolved_at: null,
        resolved_summary: null,
      },
    ]);

    expect(await resolveAlarm(conditionKey, request.source)).toBe(true);
    expect(broadcastResolvedMock).toHaveBeenCalledWith(expect.objectContaining({ conditionKey }));
  });
});
