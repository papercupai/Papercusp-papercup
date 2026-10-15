import { describe, expect, it, vi } from 'vitest';
import { classifyExternalConditionReachability, readEventConditionReachability } from './external-condition-reachability';
import type { ComposedNodeRow } from './events/await/compose-store';

const NOW = '2026-08-27T12:00:00.000Z';

describe('external condition reachability', () => {
  it('treats a fire latch as authoritative satisfaction', () => {
    expect(classifyExternalConditionReachability({ firedAt: '2026-08-27T11:00:00.000Z' }, NOW)).toMatchObject({
      verdict: 'reachable',
      basis: 'fired',
      authoritative: true,
    });
  });

  it('treats a live resolver as reachable', () => {
    expect(classifyExternalConditionReachability({ liveResolver: true }, NOW)).toMatchObject({
      verdict: 'reachable',
      basis: 'live-resolver',
      authoritative: true,
    });
  });

  it.each([
    ['cancelled', 'cancelled-registration'],
    ['expired', 'expired-registration'],
  ] as const)('uses authoritative %s producer registration evidence', (registration, basis) => {
    expect(classifyExternalConditionReachability({ registration }, NOW)).toMatchObject({
      verdict: 'impossible',
      basis,
      authoritative: true,
    });
  });

  it('keeps missing registration unknown regardless of condition age', () => {
    const recent = classifyExternalConditionReachability({ registration: 'missing' }, NOW);
    const muchLater = classifyExternalConditionReachability({ registration: 'missing' }, '2036-08-27T12:00:00.000Z');
    expect(recent).toMatchObject({ verdict: 'unknown', basis: 'missing-registration', authoritative: false });
    expect(muchLater.verdict).toBe('unknown');
  });

  it('uses an announcement fire when the unconditional latch is unavailable', async () => {
    const reachability = await readEventConditionReachability('fleet:test:gate', {
      requireSpecificCondition: true,
      now: new Date(NOW),
      inspect: async () => ({
        announcements: [{ firedAt: '2026-08-27T11:30:00.000Z', firedReason: 'event', supersededAt: null }] as never,
        waiters: [],
        deliveries: [],
        fireLatch: null,
        composedRoot: null,
      }),
    });
    expect(reachability).toMatchObject({ verdict: 'reachable', basis: 'fired', authoritative: true });
  });

  it('does not treat an expired announcement timestamp as a successful condition fire', async () => {
    const reachability = await readEventConditionReachability('fleet:test:gate', {
      now: new Date(NOW),
      inspect: async () => ({
        announcements: [{
          firedAt: '2026-08-27T11:59:59.000Z',
          firedReason: 'expired',
          expiresTs: '2026-08-27T11:59:59.000Z',
          supersededAt: null,
          cancelledAt: null,
        }] as never,
        waiters: [],
        deliveries: [],
        fireLatch: null,
        composedRoot: null,
      }),
    });

    expect(reachability).toMatchObject({
      verdict: 'impossible',
      basis: 'expired-registration',
      authoritative: true,
    });
    expect(reachability.evidence).toContain('registration expired');
  });

  it.each([
    'work-item:claimable', 'release:deployed', 'release:deployed:abc123',
    'coord:inbox-wake:park-owner', 'fleet:item-completed:test', 'work-item:unblocked',
    'work-item:unblocked:*',
  ])('keeps a fired broad or incomplete trigger unverified for a specific condition: %s', async (trigger) => {
    const inspect = async () => ({
      announcements: [{ firedAt: '2026-08-27T11:30:00.000Z', firedReason: 'event', supersededAt: null }] as never,
      waiters: [], deliveries: [], fireLatch: null, composedRoot: null,
    });
    // The ordinary reachability reader still reports the wake itself truthfully.
    expect((await readEventConditionReachability(trigger, { inspect })).basis).toBe('fired');
    const condition = await readEventConditionReachability(trigger, { inspect, requireSpecificCondition: true });
    expect(condition).toMatchObject({ verdict: 'unknown', authoritative: false });
    expect(condition.basis).not.toBe('fired');
    expect(condition.evidence).toContain('specific release condition');
  });

  it('accepts an exact required subject key without requiring an announcement', async () => {
    const reachability = await readEventConditionReachability('work-item:unblocked:WI-specific', {
      requireSpecificCondition: true,
      inspect: async () => ({ announcements: [], waiters: [], deliveries: [], composedRoot: null,
        fireLatch: { lastFiredAt: '2026-08-27T11:30:00.000Z' } as never }),
    });
    expect(reachability).toMatchObject({ verdict: 'reachable', basis: 'fired', authoritative: true });
  });

  it('does not reuse a historical fire latch for a fresh announcement generation', async () => {
    const reachability = await readEventConditionReachability('invented:key', {
      now: new Date(NOW),
      inspect: async () => ({
        announcements: [
          {
            causalGeneration: 2,
            firedAt: null,
            supersededAt: null,
            cancelledAt: null,
            expiresTs: '2026-08-27T13:00:00.000Z',
          },
          {
            causalGeneration: 1,
            firedAt: '2026-08-27T11:30:00.000Z',
            firedReason: 'event',
            supersededAt: '2026-08-27T11:45:00.000Z',
          },
        ] as never,
        waiters: [],
        deliveries: [],
        fireLatch: { lastFiredAt: '2026-08-27T11:30:00.000Z' } as never,
        composedRoot: null,
      }),
    });
    expect(reachability).toMatchObject({ verdict: 'reachable', basis: 'live-resolver', authoritative: true });
    expect(reachability.evidence).not.toContain('event fired at');
  });

  it('does not treat a cancelled consumer await as a cancelled producer registration', async () => {
    const reachability = await readEventConditionReachability('invented:key', {
      now: new Date(NOW),
      inspect: async () => ({
        announcements: [],
        waiters: [{ cancelledAt: '2026-08-27T11:30:00.000Z' }] as never,
        deliveries: [],
        fireLatch: null,
        composedRoot: null,
      }),
    });
    expect(reachability).toMatchObject({ verdict: 'unknown', basis: 'missing-registration' });
  });

  it('recognizes an active composed-root anchor without cataloguing synthetic keys', async () => {
    const loadComposedRoot = vi.fn(async (rootId: number): Promise<ComposedNodeRow | null> => ({
      id: rootId,
      rootId,
      parentId: null,
      subscriberId: 'su-composed',
      requiredCount: 1,
      firedCount: 0,
      firedAt: null,
      spec: { any: [{ event: 'gate:green' }] },
      wakeHandle: null,
      note: null,
      expiresTs: '2026-08-27T13:00:00.000Z',
      timeoutBehavior: 'wake',
      cancelledAt: null,
    }));
    const loadComposedRootAnchor = vi.fn(async (rootId: number) => ({
      awaitId: rootId + 1000,
      subscriberId: 'su-composed',
      wakeHandle: null,
    }));
    const inspect = async () => ({
      announcements: [],
      waiters: [],
      deliveries: [],
      fireLatch: null,
      composedRoot: null,
    });

    const reachability = await readEventConditionReachability('composed-root:395', {
      now: new Date(NOW),
      inspect,
      loadComposedRoot,
      loadComposedRootAnchor,
    });

    expect(reachability).toMatchObject({ verdict: 'reachable', basis: 'live-resolver', authoritative: true });
    expect(loadComposedRoot).toHaveBeenCalledWith(395);
    expect(loadComposedRootAnchor).toHaveBeenCalledWith(395);
  });

  it('does not treat an arbitrary composed-root key as reachable', async () => {
    const loadComposedRoot = vi.fn(async (): Promise<ComposedNodeRow | null> => null);
    const loadComposedRootAnchor = vi.fn(async () => null);
    const reachability = await readEventConditionReachability('composed-root:395', {
      now: new Date(NOW),
      inspect: async () => ({
        announcements: [],
        waiters: [],
        deliveries: [],
        fireLatch: null,
        composedRoot: null,
      }),
      loadComposedRoot,
      loadComposedRootAnchor,
    });

    expect(reachability).toMatchObject({ verdict: 'unknown', basis: 'missing-registration', authoritative: false });
    expect(loadComposedRoot).toHaveBeenCalledWith(395);
    expect(loadComposedRootAnchor).not.toHaveBeenCalled();
  });

  describe('predicate-watch keys (EI-25832685839560534)', () => {
    const PREDICATE_ID = '42b3467b-b631-44a3-99bd-3d3a9a994da7';
    const PREDICATE_KEY = `predicate:${PREDICATE_ID}`;
    const emptyInspect = async () => ({
      announcements: [],
      waiters: [],
      deliveries: [],
      fireLatch: null,
      composedRoot: null,
    });

    it('treats an active predicate watch on the exact key as a live producer', async () => {
      const loadPredicateWatch = vi.fn(async () => ({ eventKey: PREDICATE_KEY, active: true }));
      const reachability = await readEventConditionReachability(PREDICATE_KEY, {
        now: new Date(NOW),
        inspect: emptyInspect,
        loadPredicateWatch,
      });

      expect(reachability).toMatchObject({ verdict: 'reachable', basis: 'live-resolver', authoritative: true });
      expect(loadPredicateWatch).toHaveBeenCalledWith(PREDICATE_ID);
    });

    it('keeps an inactive predicate watch unknown', async () => {
      const reachability = await readEventConditionReachability(PREDICATE_KEY, {
        now: new Date(NOW),
        inspect: emptyInspect,
        loadPredicateWatch: async () => ({ eventKey: PREDICATE_KEY, active: false }),
      });

      expect(reachability).toMatchObject({ verdict: 'unknown', basis: 'missing-registration', authoritative: false });
    });

    it('does not accept a row whose event key differs from the awaited key', async () => {
      const reachability = await readEventConditionReachability(PREDICATE_KEY, {
        now: new Date(NOW),
        inspect: emptyInspect,
        loadPredicateWatch: async () => ({ eventKey: 'predicate:some-other-id', active: true }),
      });

      expect(reachability).toMatchObject({ verdict: 'unknown', basis: 'missing-registration' });
    });

    it('keeps a missing predicate watch row unknown', async () => {
      const reachability = await readEventConditionReachability(PREDICATE_KEY, {
        now: new Date(NOW),
        inspect: emptyInspect,
        loadPredicateWatch: async () => null,
      });

      expect(reachability).toMatchObject({ verdict: 'unknown', basis: 'missing-registration' });
    });

    it('never loads a predicate watch for a non-predicate key or a bare prefix', async () => {
      const loadPredicateWatch = vi.fn(async () => ({ eventKey: 'predicate:', active: true }));
      for (const key of ['composed-root:395', 'predicate:']) {
        const reachability = await readEventConditionReachability(key, {
          now: new Date(NOW),
          inspect: emptyInspect,
          loadComposedRoot: async () => null,
          loadComposedRootAnchor: async () => null,
          loadPredicateWatch,
        });
        expect(reachability.verdict).toBe('unknown');
      }
      expect(loadPredicateWatch).not.toHaveBeenCalled();
    });

    it('lets an active predicate watch satisfy requireSpecificCondition, and only an active one', async () => {
      const live = await readEventConditionReachability(PREDICATE_KEY, {
        now: new Date(NOW),
        inspect: emptyInspect,
        loadPredicateWatch: async () => ({ eventKey: PREDICATE_KEY, active: true }),
        requireSpecificCondition: true,
      });
      expect(live).toMatchObject({ verdict: 'reachable', basis: 'live-resolver' });

      const inactive = await readEventConditionReachability(PREDICATE_KEY, {
        now: new Date(NOW),
        inspect: emptyInspect,
        loadPredicateWatch: async () => ({ eventKey: PREDICATE_KEY, active: false }),
        requireSpecificCondition: true,
      });
      expect(inactive).toMatchObject({ verdict: 'unknown', basis: 'unmeasured' });
      expect(inactive.evidence).toContain('subject-bound evidence is required');
    });

    it('fails soft to unmeasured when the predicate watch lookup throws', async () => {
      const reachability = await readEventConditionReachability(PREDICATE_KEY, {
        now: new Date(NOW),
        inspect: emptyInspect,
        loadPredicateWatch: async () => {
          throw new Error('pg down');
        },
      });

      expect(reachability).toMatchObject({ verdict: 'unknown', basis: 'unmeasured', authoritative: false });
      expect(reachability.evidence).toContain('pg down');
    });
  });
});
