/**
 * presence-selfwake.test.ts — EI-19407725333778711.
 *
 * The recurrence guard for "a fleet surface reported 11 healthy members while 3
 * of them could never wake again". The cases below are written against the
 * failure, not the implementation: each one asserts a distinction that, if it
 * collapsed, would reproduce the incident.
 */

import { describe, it, expect } from 'vitest';
import type { Sql } from 'postgres';
import { deriveSelfWake, fetchSelfWake, isStrandedMember } from './presence-selfwake';
import { deriveVerdict } from './liveness-oracle';

describe('deriveSelfWake', () => {
  it('reports `loop` when a loop routine is armed', () => {
    expect(deriveSelfWake({ loopArmed: true, standingEventAwait: false })).toBe('loop');
  });

  it('reports `event` for a member parked on a standing wake-await', () => {
    // The member contract's sanctioned park: events:await work-item:claimable.
    expect(deriveSelfWake({ loopArmed: false, standingEventAwait: true })).toBe('event');
  });

  it('reports `none` when neither source exists — THE incident state', () => {
    expect(deriveSelfWake({ loopArmed: false, standingEventAwait: false })).toBe('none');
  });

  it('ranks an armed loop above an await, because a cadence is unconditional', () => {
    // An await depends on a condition that may never fire; a loop does not.
    expect(deriveSelfWake({ loopArmed: true, standingEventAwait: true })).toBe('loop');
  });
});

describe('isStrandedMember', () => {
  it('flags a parked member with no self-wake source', () => {
    // The headline read: indistinguishable from healthy-idle on every other field.
    expect(isStrandedMember({ sessionState: 'parked', selfWake: 'none' })).toBe(true);
  });

  it('flags a LIVE member with no self-wake source', () => {
    // The exact 05:14Z case: live only because a manual wake was in flight, and
    // would strand the instant that turn ended. Counting only `parked` would
    // have missed all three members and re-run the incident.
    expect(isStrandedMember({ sessionState: 'live', selfWake: 'none' })).toBe(true);
  });

  it('does NOT flag a member with an armed loop or a standing await', () => {
    expect(isStrandedMember({ sessionState: 'parked', selfWake: 'loop' })).toBe(false);
    expect(isStrandedMember({ sessionState: 'parked', selfWake: 'event' })).toBe(false);
  });

  it('does NOT flag already-dead members — they are visible elsewhere', () => {
    // Counting them would bury the new signal under noise a leader already acted on.
    expect(isStrandedMember({ sessionState: 'ended', selfWake: 'none' })).toBe(false);
    expect(isStrandedMember({ sessionState: 'suspect', selfWake: 'none' })).toBe(false);
  });

  it('does NOT flag UNKNOWN as stranded', () => {
    // A degraded fetch must never manufacture an escalation-worthy claim.
    expect(isStrandedMember({ sessionState: 'parked', selfWake: undefined })).toBe(false);
    expect(isStrandedMember({ sessionState: 'parked', selfWake: null })).toBe(false);
  });
});

describe('fetchSelfWake — own inbox await classification', () => {
  it('counts a bounded wake-on-timeout await on the own inbox key', async () => {
    const ownerId = 'su-inbox-waiter';
    const queryTexts: string[] = [];
    const sql = (async (strings: TemplateStringsArray) => {
      const query = strings.join('?');
      queryTexts.push(query);
      if (query.includes('FROM harness_shared.routines')) return [];
      if (query.includes('FROM harness_shared.event_awaits')) {
        return query.includes('expires_ts IS NOT NULL') && query.includes("timeout_behavior = 'wake'")
          ? [{ subscriber_id: ownerId }]
          : [];
      }
      return [];
    }) as unknown as Sql;

    const result = await fetchSelfWake([ownerId], sql);

    expect(result.get(ownerId)).toMatchObject({
      loopArmed: false,
      standingEventAwait: true,
      selfWake: 'event',
    });
    const awaitQuery = queryTexts.find((query) => query.includes('FROM harness_shared.event_awaits')) ?? '';
    expect(awaitQuery).toContain('expires_ts IS NOT NULL');
    expect(awaitQuery).toContain("timeout_behavior = 'wake'");
    expect(awaitQuery).toContain('note LIKE');
  });

  it('does not count the always-armed unbounded inbox keepalive', async () => {
    const ownerId = 'su-inbox-keepalive';
    const sql = (async (strings: TemplateStringsArray) => {
      const query = strings.join('?');
      if (query.includes('FROM harness_shared.routines')) return [];
      if (query.includes('FROM harness_shared.event_awaits')) {
        return query.includes('expires_ts IS NOT NULL') && query.includes("timeout_behavior = 'wake'")
          ? []
          : [{ subscriber_id: ownerId }];
      }
      return [];
    }) as unknown as Sql;

    const result = await fetchSelfWake([ownerId], sql);

    expect(result.get(ownerId)).toMatchObject({
      loopArmed: false,
      standingEventAwait: false,
      selfWake: 'none',
    });
  });
});

describe('deriveVerdict — self-wake is orthogonal to the existing axes', () => {
  const recorded = new Set<string>();
  const noPid = () => null;
  const now = Date.parse('2026-08-03T06:00:00Z');
  const subject = { ownerId: 'su-1', heartbeatAt: '2026-08-03T05:59:50Z', stale: false };

  it('omits the fields entirely when the leg did not run — UNKNOWN, not `none`', () => {
    const v = deriveVerdict(subject, { wakeable: true, liveTurn: false }, recorded, now, noPid);
    expect(v.sessionState).toBe('parked');
    // Absent, not false/'none'. A `?? false` default here would let a reader
    // mistake "not fetched" for "nothing will wake this agent".
    expect('selfWake' in v).toBe(false);
    expect('loopArmed' in v).toBe(false);
    expect(v.selfWake).toBeUndefined();
  });

  it('carries the self-wake fields through when the leg ran', () => {
    const v = deriveVerdict(subject, { wakeable: true, liveTurn: false }, recorded, now, noPid, undefined, {
      loopArmed: true,
      standingEventAwait: false,
      selfWake: 'loop',
    });
    expect(v.selfWake).toBe('loop');
    expect(v.loopArmed).toBe(true);
  });

  it('does NOT let selfWake perturb sessionState — the axes stay separate', () => {
    // A push-wakeable, parked agent is `parked` whether or not it can self-wake.
    // The incident's members read `parked`/`live` correctly; the bug was that
    // NOTHING carried the second fact. Folding selfWake into sessionState would
    // repeat the EI-12699 conflation this module's header warns about.
    const armed = deriveVerdict(subject, { wakeable: true, liveTurn: false }, recorded, now, noPid, undefined, {
      loopArmed: true,
      standingEventAwait: false,
      selfWake: 'loop',
    });
    const stranded = deriveVerdict(subject, { wakeable: true, liveTurn: false }, recorded, now, noPid, undefined, {
      loopArmed: false,
      standingEventAwait: false,
      selfWake: 'none',
    });
    expect(armed.sessionState).toBe('parked');
    expect(stranded.sessionState).toBe('parked');
    expect(stranded.wakeable).toBe(true); // a PUSH still lands — a different axis
    expect(stranded.selfWake).toBe('none'); // …but nothing will push unprompted
  });

  it('reproduces the incident row: healthy on every legacy field, stranded on the new one', () => {
    const v = deriveVerdict(
      { ownerId: 'su-03c663c4', heartbeatAt: '2026-08-03T05:59:55Z', stale: false },
      { wakeable: true, liveTurn: true },
      recorded,
      now,
      noPid,
      undefined,
      { loopArmed: false, standingEventAwait: false, selfWake: 'none' },
    );
    // Every field a leader had on 2026-08-03 said this member was fine:
    expect(v.sessionState).toBe('live');
    expect(v.heartbeatFresh).toBe(true);
    expect(v.wakeable).toBe(true);
    expect(v.confirmLiveness).toBe(false);
    // …and the one field that would have caught it:
    expect(isStrandedMember(v)).toBe(true);
  });
});
