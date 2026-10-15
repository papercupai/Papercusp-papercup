import { describe, expect, it } from 'vitest';
import {
  applyExternalBlockerUpdate,
  attachExternalBlockerReachability,
  activeExternalBlockers,
  externalBlockerCapabilityPolicy,
  ownerAskDefaultDisclosure,
  readExternalBlockers,
  readExternalBlockersWithReachability,
  updateExternalBlockerHistory,
} from './external-blockers';

const T1 = '2026-07-13T08:00:00.000Z';
const T2 = '2026-07-13T09:00:00.000Z';

describe('typed external blocker history', () => {
  it.each(['event', 'gate', 'runtime', 'human'] as const)('gives a %s blocker a named next action and registered re-check date', (kind) => {
    const { blockers } = updateExternalBlockerHistory({}, { kind, ref: 'condition:one' }, 'su-a', T1);
    expect(blockers[0]?.ref).toBe('condition:one');
    expect(blockers[0]?.nextVerb?.trim()).toBeTruthy();
    expect(blockers[0]?.recheckAt).toBe(kind === 'human' ? '2026-07-14T08:00:00.000Z' : T2);
  });

  it('preserves a re-check on reassertion, accepts an explicit replacement, and refuses invalid dates', () => {
    const first = updateExternalBlockerHistory({}, { kind: 'event', ref: 'condition:one', nextVerb: 'events:await', recheckAt: T2 }, 'su-a', T1);
    const retained = updateExternalBlockerHistory({ externalBlockers: first.blockers }, { kind: 'event', ref: 'condition:one' }, 'su-b', T2);
    expect(retained.blockers[0]).toMatchObject({ nextVerb: 'events:await', recheckAt: T2 });
    const replaced = updateExternalBlockerHistory({ externalBlockers: retained.blockers }, { kind: 'event', ref: 'condition:one', recheckAt: '2026-07-14T08:00:00Z' }, 'su-b', T2);
    expect(replaced.blockers[0]?.recheckAt).toBe('2026-07-14T08:00:00.000Z');
    expect(() => updateExternalBlockerHistory({}, { kind: 'event', ref: 'condition:one', recheckAt: 'tomorrow' }, 'su-a', T1)).toThrow('recheckAt');
    expect(() => updateExternalBlockerHistory({}, { kind: 'event', ref: ' ' }, 'su-a', T1)).toThrow('ref must name');
    expect(updateExternalBlockerHistory({ externalBlockers: first.blockers }, { kind: 'event', ref: 'condition:one', clear: true }, 'su-b', T2).blockers[0]?.recheckAt).toBe(T2);
  });

  it('adds a typed event blocker without touching sibling payload/dependency history', () => {
    const payload = { plan_item: { item_id: 'P-008' }, internalDependencyHistory: ['WI-1'] };
    const out = updateExternalBlockerHistory(
      payload,
      {
        kind: 'event',
        capability: 'live-dependency',
        ref: 'deploy:ready:staging',
        summary: 'staging deploy must finish',
        nextVerb: 'events:await',
      },
      'su-a',
      T1,
    );
    expect(out.changed).toBe(true);
    expect(out.blockers).toEqual([
      expect.objectContaining({
        kind: 'event',
        capability: 'live-dependency',
        ref: 'deploy:ready:staging',
        status: 'active',
        createdAt: T1,
        createdBy: 'su-a',
      }),
    ]);
    expect(payload).toEqual({ plan_item: { item_id: 'P-008' }, internalDependencyHistory: ['WI-1'] });
  });

  it('clears in place, preserving the blocker as history', () => {
    const active = updateExternalBlockerHistory(
      {},
      { kind: 'gate', ref: 'release-green', summary: 'release gate red' },
      'su-a',
      T1,
    );
    const cleared = updateExternalBlockerHistory(
      { externalBlockers: active.blockers },
      { kind: 'gate', ref: 'release-green', clear: true, evidence: 'gate rerun green' },
      'su-b',
      T2,
    );
    expect(cleared.blockers).toEqual([
      expect.objectContaining({
        status: 'cleared',
        createdAt: T1,
        clearedAt: T2,
        clearedBy: 'su-b',
        evidence: 'gate rerun green',
      }),
    ]);
    expect(activeExternalBlockers({ externalBlockers: cleared.blockers })).toEqual([]);
  });

  it('is defensive against malformed federated payload rows', () => {
    expect(readExternalBlockers({ externalBlockers: [null, {}, { kind: 'event' }] })).toEqual([]);
    expect(readExternalBlockers(null)).toEqual([]);
  });

  it('infers a conservative capability for legacy rows while marking provenance', () => {
    const legacy = {
      kind: 'human',
      ref: 'owner-choice',
      summary: 'choose a direction',
      status: 'active',
      createdAt: T1,
      createdBy: 'su-a',
      updatedAt: T1,
    };
    expect(readExternalBlockers({ externalBlockers: [legacy] })).toEqual([
      expect.objectContaining({
        capability: 'product-decision',
        capabilitySource: 'legacy-inferred',
      }),
    ]);
  });

  it('mechanically clears standing approval under AUTO but not missing physical capability', () => {
    const approval = applyExternalBlockerUpdate(
      {},
      { kind: 'human', capability: 'approval-auto-clearable', ref: 'deploy-approval' },
      'su-auto',
      { autoAuthority: true },
      T1,
    );
    expect(approval.autoCleared).toBe(true);
    expect(approval.blockers).toEqual([
      expect.objectContaining({ status: 'cleared', capability: 'approval-auto-clearable' }),
    ]);

    const device = applyExternalBlockerUpdate(
      {},
      { kind: 'human', capability: 'physical-device', ref: 'live-mic' },
      'su-auto',
      { autoAuthority: true },
      T1,
    );
    expect(device.autoCleared).toBe(false);
    expect(device.blockers[0]).toMatchObject({ status: 'active', capability: 'physical-device' });
    expect(externalBlockerCapabilityPolicy('physical-device')).toMatchObject({
      autoClearable: false,
      requiresOwnerCapability: true,
      resolutionOwner: 'device-holder',
    });
  });

  it('attaches reachability evidence without clearing or rewriting blocker history', () => {
    const blocker = updateExternalBlockerHistory(
      {},
      { kind: 'event', ref: 'deploy:ready:staging' },
      'su-a',
      T1,
    ).blockers[0]!;
    const out = attachExternalBlockerReachability(blocker, {
      verdict: 'unknown',
      basis: 'missing-registration',
      authoritative: false,
      evidence: 'no producer registration or catalogued resolver was found',
      checkedAt: T2,
    });
    expect(out.status).toBe('active');
    expect(out.reachability).toMatchObject({ verdict: 'unknown', authoritative: false });
    expect(blocker.reachability).toBeUndefined();
  });

  it('resolves event/gate blockers but never guesses runtime or human reachability', async () => {
    const payload = {
      externalBlockers: [
        updateExternalBlockerHistory({}, { kind: 'event', ref: 'release:green' }, 'su-a', T1).blockers[0],
        updateExternalBlockerHistory({}, { kind: 'runtime', ref: 'service-x' }, 'su-a', T1).blockers[0],
      ],
    };
    const out = await readExternalBlockersWithReachability(payload, {
      resolveEvent: async () => ({
        verdict: 'reachable',
        basis: 'live-resolver',
        authoritative: true,
        evidence: 'catalogued emitter',
        checkedAt: T2,
      }),
    });
    expect(out[0]!.reachability).toMatchObject({ verdict: 'reachable', authoritative: true });
    expect(out[1]!.reachability).toBeUndefined();
  });
});

// Owner-attention ledger (EI-23783029010995961): what happens if the owner never answers.
describe('owner-ask default disclosure', () => {
  const ask = (extra: Record<string, unknown> = {}) =>
    updateExternalBlockerHistory(
      {},
      {
        kind: 'human',
        capability: 'product-decision',
        ref: 'decision:pricing',
        summary: 'Pick the pricing tier.',
        nextVerb: 'work_items:set_blocker { clear: true }',
        ...extra,
      },
      'su-a',
      T1,
    );

  it('persists defaultIfUnanswered and decideBy (trimmed) on create', () => {
    const { blockers } = ask({ defaultIfUnanswered: '  proceeds with the cheaper tier  ', decideBy: '2026-10-15T00:00:00Z' });
    expect(blockers[0]).toMatchObject({
      defaultIfUnanswered: 'proceeds with the cheaper tier',
      decideBy: '2026-10-15T00:00:00Z',
    });
  });

  it('updates the declared default on a re-assert without dropping it when omitted', () => {
    const first = ask({ defaultIfUnanswered: 'stays parked' });
    const reasserted = updateExternalBlockerHistory(
      { externalBlockers: first.blockers },
      { kind: 'human', capability: 'product-decision', ref: 'decision:pricing', summary: 'Pick the tier (reworded).' },
      'su-a',
      T2,
    );
    expect(reasserted.blockers[0]).toMatchObject({ defaultIfUnanswered: 'stays parked', summary: 'Pick the tier (reworded).' });
    const changed = updateExternalBlockerHistory(
      { externalBlockers: first.blockers },
      { kind: 'human', ref: 'decision:pricing', defaultIfUnanswered: 'proceeds with option A', decideBy: '2026-11-01T00:00:00Z' },
      'su-a',
      T2,
    );
    expect(changed.blockers[0]).toMatchObject({ defaultIfUnanswered: 'proceeds with option A', decideBy: '2026-11-01T00:00:00Z' });
  });

  it('survives the defensive read of a stored payload', () => {
    const { blockers } = ask({ defaultIfUnanswered: 'stays parked', decideBy: '2026-10-15T00:00:00Z' });
    expect(readExternalBlockers({ externalBlockers: blockers })[0]).toMatchObject({
      defaultIfUnanswered: 'stays parked',
      decideBy: '2026-10-15T00:00:00Z',
    });
  });

  it('discloses the default and its date to the owner', () => {
    const { blockers } = ask({ defaultIfUnanswered: 'proceeds with the cheaper tier', decideBy: '2026-10-15T00:00:00Z' });
    expect(ownerAskDefaultDisclosure({ externalBlockers: blockers })).toBe(
      'Default if unanswered: proceeds with the cheaper tier (decide by 2026-10-15T00:00:00Z)',
    );
  });

  it('says "no default declared" for a legacy ask rather than inventing one', () => {
    const { blockers } = ask();
    expect(blockers[0]!.defaultIfUnanswered).toBeUndefined();
    expect(ownerAskDefaultDisclosure({ externalBlockers: blockers })).toBe(
      'No default declared — the item stays parked until you answer.',
    );
  });

  it('is silent for non-human blockers, cleared asks, and payloads with no blockers', () => {
    const event = updateExternalBlockerHistory({}, { kind: 'event', ref: 'release:green' }, 'su-a', T1);
    expect(ownerAskDefaultDisclosure({ externalBlockers: event.blockers })).toBeNull();
    const open = ask({ defaultIfUnanswered: 'stays parked' });
    const cleared = updateExternalBlockerHistory(
      { externalBlockers: open.blockers },
      { kind: 'human', ref: 'decision:pricing', clear: true },
      'su-b',
      T2,
    );
    expect(ownerAskDefaultDisclosure({ externalBlockers: cleared.blockers })).toBeNull();
    expect(ownerAskDefaultDisclosure({})).toBeNull();
    expect(ownerAskDefaultDisclosure(null)).toBeNull();
  });

  it('collapses identical disclosures from several asks on one item', () => {
    const a = ask({ defaultIfUnanswered: 'stays parked' });
    const b = updateExternalBlockerHistory(
      { externalBlockers: a.blockers },
      { kind: 'human', capability: 'credential', ref: 'credential:prod-db', defaultIfUnanswered: 'stays parked' },
      'su-a',
      T2,
    );
    expect(ownerAskDefaultDisclosure({ externalBlockers: b.blockers })).toBe('Default if unanswered: stays parked');
  });
});
