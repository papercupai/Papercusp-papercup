import { describe, expect, it, vi } from 'vitest';
import {
  holderBlockerInterestEventKeys,
  reconcileInterestEventAwaits,
  type InterestAutoArmDeps,
} from './interest-auto-arm';

function deps(active: any[] = []): InterestAutoArmDeps {
  return {
    captureHandle: vi.fn(async () => ({ handle: { kind: 'psu-socket' } as any, note: 'reachable' })),
    listActive: vi.fn(async () => active),
    register: vi.fn(async (input: any) => ({ ...input, id: 40 + Math.random() })) as any,
    cancel: vi.fn(async () => true),
  };
}

describe('reconcileInterestEventAwaits', () => {
  it.each([
    ['unfiltered', null],
    ['filtered', { result: { equals: 'ready' } }],
  ])('preserves an explicit bounded %s wake without changing its control state', async (_name, payloadFilter) => {
    const manual = {
      id: 12, eventKey: 'work-item:done:WI-source', policy: 'wake', once: true,
      wakeHandle: null, boundTo: null, expiresTs: '2030-01-01T00:00:00.000Z',
      timeoutBehavior: 'expire', payloadFilter, note: 'explicit source wait',
    };
    const before = structuredClone(manual);
    const d = deps([manual]);
    const out = await reconcileInterestEventAwaits(
      { ownerId: 'agent-1', eventKeys: [manual.eventKey], boundTo: { kind: 'work-item-blocked', ref: 'WI-1' }, note: 'blocked holder' },
      d,
    );
    expect(out.await_ids).toEqual([manual.id]);
    expect(d.register).not.toHaveBeenCalled();
    expect(d.cancel).not.toHaveBeenCalled();
    expect(manual).toEqual(before);
  });

  it('keeps explicit predicate siblings and retires only this lifecycle’s redundant wake', async () => {
    const binding = { kind: 'work-item-blocked', ref: 'WI-1' } as const;
    const eventKey = 'work-item:done:WI-source';
    const d = deps([
      { id: 12, eventKey, policy: 'wake', once: true, boundTo: null, payloadFilter: { result: { equals: 'one' } } },
      { id: 13, eventKey, policy: 'wake', once: true, boundTo: null, payloadFilter: { result: { equals: 'two' } } },
      { id: 14, eventKey, policy: 'wake', once: true, wakeHandle: {}, boundTo: binding },
      { id: 15, eventKey: 'manual:other', policy: 'wake', once: true, boundTo: null },
    ]);
    const out = await reconcileInterestEventAwaits(
      { ownerId: 'agent-1', eventKeys: [eventKey], boundTo: binding, note: 'blocked holder' }, d,
    );
    expect(out.await_ids).toEqual([12, 13]);
    expect(d.cancel).toHaveBeenCalledExactlyOnceWith({ awaitId: 14, subscriberId: 'agent-1' });
    expect(d.register).not.toHaveBeenCalled();
  });

  it('does not adopt a composed leaf as an independent lifecycle wake', async () => {
    const eventKey = 'work-item:done:WI-source';
    const d = deps([{ id: 12, eventKey, policy: 'wake', once: true, wakeHandle: {}, boundTo: null, rootId: 3 }]);
    const out = await reconcileInterestEventAwaits(
      { ownerId: 'agent-1', eventKeys: [eventKey], boundTo: { kind: 'work-item-blocked', ref: 'WI-1' }, note: 'blocked holder' }, d,
    );
    expect(out.await_ids).not.toContain(12);
    expect(d.cancel).not.toHaveBeenCalled();
    expect(d.register).toHaveBeenCalledOnce();
  });

  it('is idempotent and returns an events:cancel handle for the exact lifecycle edges', async () => {
    const d = deps([
      { id: 7, eventKey: 'claim:released:WI-1', policy: 'wake', once: true, wakeHandle: {}, boundTo: { kind: 'work-item-claim', ref: 'WI-1' } },
    ]);
    const out = await reconcileInterestEventAwaits(
      { ownerId: 'agent-1', eventKeys: ['claim:released:WI-1', 'claim:released:WI-1'], boundTo: { kind: 'work-item-claim', ref: 'WI-1' }, note: 'claim holder' },
      d,
    );
    expect(out).toMatchObject({ event_keys: ['claim:released:WI-1'], await_ids: [7], cancel: { tool: 'events:cancel', args: { await_ids: [7] } } });
    expect(d.register).not.toHaveBeenCalled();
  });

  it('cancels stale bound keys and registers missing one-shot wakes', async () => {
    const d = deps([
      { id: 8, eventKey: 'work-item:done:old', policy: 'wake', once: true, wakeHandle: {}, boundTo: { kind: 'work-item-blocked', ref: 'WI-2' } },
    ]);
    const out = await reconcileInterestEventAwaits(
      { ownerId: 'agent-2', eventKeys: ['work-item:done:new'], boundTo: { kind: 'work-item-blocked', ref: 'WI-2' }, note: 'blocked holder' },
      d,
    );
    expect(d.cancel).toHaveBeenCalledWith({ awaitId: 8, subscriberId: 'agent-2' });
    expect(d.register).toHaveBeenCalledWith(expect.objectContaining({ eventKey: 'work-item:done:new', once: true, boundTo: { kind: 'work-item-blocked', ref: 'WI-2' } }));
    expect(out.cancel?.args.await_ids).toHaveLength(1);
  });
});

describe('holderBlockerInterestEventKeys', () => {
  it('never arms the holder on release of its own claim', () => {
    expect(holderBlockerInterestEventKeys('WI-1', ['WI-BLOCKER'])).toEqual([
      'work-item:done:WI-BLOCKER',
      'work-item:unblocked:WI-1',
    ]);
    expect(holderBlockerInterestEventKeys('WI-1', ['WI-1'])).not.toContain('claim:released:WI-1');
  });

  it('does not create a wake when the holder has no unresolved blockers', () => {
    expect(holderBlockerInterestEventKeys('WI-1', [])).toEqual([]);
  });
});
