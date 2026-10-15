/**
 * plan-events.test.ts — the plan-event host adapter, over the coordLog seam.
 *
 * coordLog (append/read) and resolveAgentIdentity are mocked, so the envelope-construction,
 * best-effort-swallow, and read-filter logic are exercised without PG. filterPlanEvents is the
 * real pure implementation from @papercusp/coordination/core.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoordEnvelope } from '@papercusp/coordination/core';

vi.mock('./log', () => ({ coordLog: { appendLine: vi.fn(), readLines: vi.fn(), readLinesBounded: vi.fn() } }));
vi.mock('./identity', () => ({ resolveAgentIdentity: vi.fn() }));
vi.mock('../../events/await/engine', () => ({ emitAwaitedEvent: vi.fn() }));

import {
  emitPlanEvent,
  emitPlanEventForCaller,
  planEventChangesAcceptance,
  readPlanEvents,
  READ_PLAN_EVENTS_BOUND,
} from './plan-events';
import { coordLog } from './log';
import { resolveAgentIdentity } from './identity';
import { emitAwaitedEvent } from '../../events/await/engine';

const mockLog = coordLog as unknown as {
  appendLine: ReturnType<typeof vi.fn>;
  readLines: ReturnType<typeof vi.fn>;
  readLinesBounded: ReturnType<typeof vi.fn>;
};
const mockResolve = resolveAgentIdentity as unknown as ReturnType<typeof vi.fn>;
const mockAwaitedEvent = emitAwaitedEvent as unknown as ReturnType<typeof vi.fn>;

/** The envelope passed to coordLog.appendLine on the most recent call. */
function lastEnv(): CoordEnvelope {
  const calls = mockLog.appendLine.mock.calls;
  return calls[calls.length - 1][2] as CoordEnvelope;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('emitPlanEvent — envelope construction', () => {
  it('builds a plan_event broadcast from the identity owner and appends to the plan-events surface', async () => {
    await emitPlanEvent({
      planSlug: 'my-plan',
      event: 'status_changed',
      identity: { ownerId: 'agent-7', workspaceId: 'ws' } as never,
    });
    expect(mockLog.appendLine).toHaveBeenCalledTimes(1);
    const [surface, writerKey] = mockLog.appendLine.mock.calls[0];
    expect(surface).toBe('plan-events');
    expect(writerKey).toBe('agent-7'); // writerKey === env.from
    const env = lastEnv();
    expect(env.from).toBe('agent-7');
    expect(env.to).toEqual(['*']);
    expect(env.kind).toBe('plan_event');
    expect(env.plan_slug).toBe('my-plan');
    expect(env.event).toBe('status_changed');
    expect(typeof env.ts).toBe('string');
    expect(typeof env.msg_id).toBe('string');
  });

  it('falls back to from="system" when no identity is given', async () => {
    await emitPlanEvent({ planSlug: 'p', event: 'created' });
    expect(lastEnv().from).toBe('system');
    expect(mockLog.appendLine.mock.calls[0][1]).toBe('system');
  });

  it('includes before/after/detail only when !== undefined (null IS kept)', async () => {
    await emitPlanEvent({
      planSlug: 'p',
      event: 'item_status_changed',
      before: null, // null !== undefined → KEPT
      after: undefined, // dropped
      detail: 'moved to wip',
    });
    const env = lastEnv();
    expect('before' in env).toBe(true);
    expect(env.before).toBeNull();
    expect('after' in env).toBe(false); // undefined → omitted entirely
    expect(env.detail).toBe('moved to wip');
  });

  it('omits before/after/detail entirely when all are undefined', async () => {
    await emitPlanEvent({ planSlug: 'p', event: 'created' });
    const env = lastEnv();
    expect('before' in env).toBe(false);
    expect('after' in env).toBe(false);
    expect('detail' in env).toBe(false);
  });
});

describe('emitPlanEventForCaller — best-effort', () => {
  it('resolves the caller identity and emits with its owner', async () => {
    mockResolve.mockReturnValue({ ownerId: 'caller-1', workspaceId: 'ws' });
    await emitPlanEventForCaller({} as never, { planSlug: 'p', event: 'created' });
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(lastEnv().from).toBe('caller-1');
    expect(mockAwaitedEvent).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'plan:acceptance:p', source: 'caller-1' }),
    );
  });

  it('swallows an identity-resolution failure and emits as system', async () => {
    mockResolve.mockImplementation(() => { throw new Error('no identity'); });
    // P-004: the emit returns the event's msg_id (the id a Now note records).
    const msgId = await emitPlanEventForCaller({} as never, { planSlug: 'p', event: 'created' });
    expect(msgId).toBe(lastEnv().msg_id);
    expect(lastEnv().from).toBe('system'); // null identity → system, the write still happened
  });

  it('never throws when the underlying append fails (observability, not state)', async () => {
    mockResolve.mockReturnValue({ ownerId: 'caller-1', workspaceId: 'ws' });
    mockLog.appendLine.mockRejectedValueOnce(new Error('pg down'));
    // A failed append yields no event id: null, never a throw.
    await expect(emitPlanEventForCaller({} as never, { planSlug: 'p', event: 'created' })).resolves.toBeNull();
    expect(mockAwaitedEvent).toHaveBeenCalledWith(expect.objectContaining({ key: 'plan:acceptance:p' }));
  });

  it('does not mislabel goal-only property/package traffic as a plan acceptance change', async () => {
    expect(planEventChangesAcceptance('property_changed')).toBe(false);
    expect(planEventChangesAcceptance('package_updated')).toBe(false);
    await emitPlanEventForCaller({} as never, { planSlug: 'goal-id', event: 'property_changed' });
    expect(mockAwaitedEvent).not.toHaveBeenCalled();
  });
});

describe('readPlanEvents — bounded storage read + filterPlanEvents (EI-1737 / P-005)', () => {
  const planEvt = (over: Partial<CoordEnvelope>): CoordEnvelope => ({
    ts: '2026-06-23T12:00:00.000Z', msg_id: 'm', from: 'x', to: ['*'], kind: 'plan_event',
    plan_slug: 'p', event: 'created', ...over,
  });

  it('reads BOUNDED (newest-N) and pushes since_ts + a single plan_slug into the storage read', async () => {
    mockLog.readLinesBounded.mockResolvedValue([]);
    // single plan_slug + since_ts → both pushed down
    await readPlanEvents({ since_ts: '2026-06-23T00:00:00.000Z', planSlugs: ['solo'] });
    expect(mockLog.readLinesBounded).toHaveBeenLastCalledWith('plan-events', {
      limit: READ_PLAN_EVENTS_BOUND,
      kinds: ['plan_event'],
      sinceTs: '2026-06-23T00:00:00.000Z',
      planSlug: 'solo',
    });
    // MULTIPLE plan_slugs → NOT pushed down (filterPlanEvents handles the multi-slug set)
    await readPlanEvents({ planSlugs: ['a', 'b'] });
    expect(mockLog.readLinesBounded).toHaveBeenLastCalledWith('plan-events', {
      limit: READ_PLAN_EVENTS_BOUND,
      kinds: ['plan_event'],
    });
    // no args → just the bound + kind
    await readPlanEvents();
    expect(mockLog.readLinesBounded).toHaveBeenLastCalledWith('plan-events', {
      limit: READ_PLAN_EVENTS_BOUND,
      kinds: ['plan_event'],
    });
    // an explicit limit overrides the default bound (still clamped ≤1000 in storage)
    await readPlanEvents({ limit: 50 });
    expect(mockLog.readLinesBounded).toHaveBeenLastCalledWith('plan-events', {
      limit: 50,
      kinds: ['plan_event'],
    });
  });

  it('drops non-plan_event lines, filters by planSlugs/events, and sorts ascending', async () => {
    mockLog.readLinesBounded.mockResolvedValue([
      planEvt({ msg_id: 'c', ts: '2026-06-23T12:00:02.000Z', plan_slug: 'keep', event: 'created' }),
      planEvt({ msg_id: 'a', ts: '2026-06-23T12:00:00.000Z', plan_slug: 'keep', event: 'created' }),
      planEvt({ msg_id: 'b', ts: '2026-06-23T12:00:01.000Z', plan_slug: 'drop', event: 'created' }),
      { ts: '2026-06-23T12:00:03.000Z', msg_id: 'msg', from: 'x', to: ['*'], kind: 'message' } as CoordEnvelope,
    ]);
    const rows = await readPlanEvents({ planSlugs: ['keep'] });
    expect(rows.map((r) => r.msg_id)).toEqual(['a', 'c']); // 'drop' filtered, 'message' dropped, ts-ascending
  });
});
