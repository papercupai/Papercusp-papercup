/**
 * parked-agent-census-resumption-and-root-cause-2026-10-09 P-011(a) / D-011 —
 * a live psu host is not proof the session can think.
 *
 * The positive psu-host rescue used to hand a session `parked`/`recorded`
 * whenever its host process was alive, even when the host itself reported the
 * child could not take a turn (dead provider auth, quota, an unbound respawn
 * successor, deliveries stuck pending). Every routing surface that trusts the
 * host (recipient-liveness, inbox-wake, fleet:assignments, grading-audit and
 * consult routing, owner-directive routing, gate-ownership) then treated a
 * wedged agent exactly like a healthy parked one.
 *
 * The oracle now judges the host with the SAME judge as the pickup sweep and the
 * stalled-loops guard (turn-proof.ts, D-007) and reports a wedged session as
 * `suspect` + `wedged`. Everything here is PG-free and fs-free: every leg is an
 * injected seam.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  applyHostCondition,
  resolveSessionStates,
  type LivenessSubject,
  type LivenessVerdict,
  type ResolveSessionStatesOpts,
} from './liveness-oracle';
import type { WakeabilitySignals } from './presence-wakeability';
import type { HostTailEvent } from '../../events/await/turn-proof';

const NOW = Date.parse('2026-10-11T03:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const HOST_STARTED_AT = NOW - 2 * 60 * 60_000;

const OWNER = 'su-test-host-condition';

/** A known non-cup subject with a warm heartbeat and no recorded pid to probe. */
const subject: LivenessSubject = {
  ownerId: OWNER,
  heartbeatAt: iso(5_000),
  stale: false,
  agentRole: 'su',
};

const NOT_WAKEABLE: WakeabilitySignals = { wakeable: false, liveTurn: false };
const WAKEABLE: WakeabilitySignals = { wakeable: true, liveTurn: false };
const LIVE_TURN: WakeabilitySignals = { wakeable: true, liveTurn: true };

type HostRecord = {
  startedAt?: number;
  advSessionId?: string | null;
  authBlocked?: boolean;
  quotaBlocked?: boolean;
  lastOutputAt?: number | null;
  execution?: { phase?: string; lastProgressAt?: number | null } | null;
};

const healthyHost: HostRecord = { startedAt: HOST_STARTED_AT, lastOutputAt: NOW - 60 * 60_000 };

function opts(
  wake: WakeabilitySignals,
  host: HostRecord | null,
  tail: readonly HostTailEvent[] | Error = [],
  extra: Partial<ResolveSessionStatesOpts> = {},
) {
  const readHostTailFn = vi.fn(async () => {
    if (tail instanceof Error) throw tail;
    return tail;
  });
  const o: ResolveSessionStatesOpts = {
    nowMs: NOW,
    fetchWakeabilityFn: async () => new Map([[OWNER, wake]]),
    fetchRecordedLiveFn: async () => new Set<string>(),
    fetchRecordedEndedFn: async () => new Set<string>(),
    probePidFn: () => null,
    psuHostPositiveAuthority: true,
    findHostFn: () => host,
    readHostTailFn,
    ...extra,
  };
  return { o, readHostTailFn };
}

async function verdictFor(s: LivenessSubject, o: ResolveSessionStatesOpts): Promise<LivenessVerdict> {
  const out = await resolveSessionStates([s], o);
  const v = out.get(s.ownerId);
  if (!v) throw new Error('oracle dropped the subject');
  return v;
}

/** The two re-polls the host answered `pending`, the oldest past the 600 s pickup window. */
const stuckTail: HostTailEvent[] = [
  { kind: 'duplicate-delivery-id', state: 'pending', ts: iso(40 * 60_000) },
  { kind: 'duplicate-delivery-id', state: 'pending', ts: iso(30 * 60_000) },
];

describe('P-011(a) — host-condition leg (positive control first)', () => {
  it('POSITIVE CONTROL: a healthy live host still rescues a non-wakeable session to `recorded`', async () => {
    // Without this, every wedge assertion below could pass because nothing was
    // ever rescued in this setup. The leg must leave a healthy host alone.
    const { o, readHostTailFn } = opts(NOT_WAKEABLE, healthyHost);
    const v = await verdictFor(subject, o);
    expect(v.sessionState).toBe('recorded');
    expect(v.wedged).toBeUndefined();
    expect(readHostTailFn).toHaveBeenCalledTimes(1);
  });

  it('POSITIVE CONTROL: a healthy live host leaves a wakeable session `parked`', async () => {
    const { o } = opts(WAKEABLE, healthyHost);
    const v = await verdictFor(subject, o);
    expect(v.sessionState).toBe('parked');
    expect(v.wedged).toBeUndefined();
  });
});

describe('P-011(a) — each cannot-take-a-turn class reads suspect + wedged', () => {
  it('dead provider auth on the host record → suspect, wedged auth-blocked', async () => {
    const { o } = opts(WAKEABLE, { ...healthyHost, authBlocked: true });
    const v = await verdictFor(subject, o);
    expect(v.sessionState).toBe('suspect');
    expect(v.wedged).toBe('auth-blocked');
    expect(v.confirmLiveness).toBe(true);
  });

  it('quota/403 on the host record → suspect, wedged quota-blocked', async () => {
    const { o } = opts(NOT_WAKEABLE, { ...healthyHost, quotaBlocked: true });
    const v = await verdictFor(subject, o);
    expect(v.sessionState).toBe('suspect');
    expect(v.wedged).toBe('quota-blocked');
  });

  it('an unbound respawn successor in the current host process → suspect, wedged unbound-successor', async () => {
    const tail: HostTailEvent[] = [
      { kind: 'respawn-binding-unconfirmed', reason: 'successor-native-id-missing', ts: iso(20 * 60_000) },
    ];
    const { o } = opts(NOT_WAKEABLE, healthyHost, tail);
    const v = await verdictFor(subject, o);
    expect(v.sessionState).toBe('suspect');
    expect(v.wedged).toBe('unbound-successor');
  });

  it('deliveries stuck pending past the pickup window with no turn → suspect, wedged pending-turn-stuck', async () => {
    const { o } = opts(WAKEABLE, healthyHost, stuckTail);
    const v = await verdictFor(subject, o);
    expect(v.sessionState).toBe('suspect');
    expect(v.wedged).toBe('pending-turn-stuck');
  });
});

describe('P-011(a) — the judge stays precise (D-007), so a healthy session is never wedged', () => {
  it('an unconfirmed binding with a non-unbindable reason (superseded) is NOT wedged', async () => {
    const tail: HostTailEvent[] = [
      { kind: 'respawn-binding-unconfirmed', reason: 'superseded', ts: iso(20 * 60_000) },
    ];
    const { o } = opts(NOT_WAKEABLE, healthyHost, tail);
    expect((await verdictFor(subject, o)).sessionState).toBe('recorded');
  });

  it('an unbindable binding from a PREDECESSOR host process is NOT wedged', async () => {
    const tail: HostTailEvent[] = [
      { kind: 'respawn-binding-unconfirmed', reason: 'successor-native-id-missing', ts: iso(3 * 60 * 60_000) },
    ];
    const { o } = opts(NOT_WAKEABLE, healthyHost, tail);
    expect((await verdictFor(subject, o)).wedged).toBeUndefined();
  });

  it('a turn delivered after the pending re-polls clears the stuck verdict', async () => {
    const tail: HostTailEvent[] = [...stuckTail, { kind: 'turn-delivered', ts: iso(5 * 60_000) }];
    const { o } = opts(WAKEABLE, healthyHost, tail);
    expect((await verdictFor(subject, o)).sessionState).toBe('parked');
  });

  it('a host visibly mid-turn is NOT stuck even with old pending re-polls', async () => {
    const busy: HostRecord = { ...healthyHost, lastOutputAt: NOW - 30_000 };
    const { o } = opts(WAKEABLE, busy, stuckTail);
    expect((await verdictFor(subject, o)).wedged).toBeUndefined();
  });

  it('a LIVE turn outranks a stale host auth flag: the session stays live', async () => {
    const { o } = opts(LIVE_TURN, { ...healthyHost, authBlocked: true });
    const v = await verdictFor(subject, o);
    expect(v.sessionState).toBe('live');
    expect(v.wedged).toBeUndefined();
  });
});

describe('P-011(a) — scope of the leg', () => {
  it('a cup subject is never judged (nursery-governed, not psu-hosted)', async () => {
    const { o, readHostTailFn } = opts(WAKEABLE, { ...healthyHost, authBlocked: true });
    const v = await verdictFor({ ...subject, agentRole: 'cup' }, o);
    expect(v.wedged).toBeUndefined();
    expect(readHostTailFn).not.toHaveBeenCalled();
  });

  it('no live host → nothing to judge, no tail read', async () => {
    const { o, readHostTailFn } = opts(WAKEABLE, null, [], { psuHostPositiveAuthority: false });
    const v = await verdictFor(subject, o);
    expect(v.sessionState).toBe('parked');
    expect(readHostTailFn).not.toHaveBeenCalled();
  });

  it('defaults OFF for a caller that does not trust the host (no positive authority, no opt-in)', async () => {
    const { o, readHostTailFn } = opts(WAKEABLE, { ...healthyHost, authBlocked: true }, [], {
      psuHostPositiveAuthority: false,
    });
    const v = await verdictFor(subject, o);
    expect(v.sessionState).toBe('parked');
    expect(readHostTailFn).not.toHaveBeenCalled();
  });

  it('hostCondition: true opts a non-trusting caller in', async () => {
    const { o } = opts(WAKEABLE, { ...healthyHost, authBlocked: true }, [], {
      psuHostPositiveAuthority: false,
      hostCondition: true,
    });
    const v = await verdictFor(subject, o);
    expect(v.sessionState).toBe('suspect');
    expect(v.wedged).toBe('auth-blocked');
  });

  it('hostCondition: false opts a trusting caller out', async () => {
    const { o, readHostTailFn } = opts(WAKEABLE, { ...healthyHost, authBlocked: true }, [], {
      hostCondition: false,
    });
    expect((await verdictFor(subject, o)).sessionState).toBe('parked');
    expect(readHostTailFn).not.toHaveBeenCalled();
  });

  it('an unreadable tail still surfaces the record flag, and never invents a tail verdict', async () => {
    const boom = new Error('EIO');
    const authOnly = opts(WAKEABLE, { ...healthyHost, authBlocked: true }, boom);
    expect((await verdictFor(subject, authOnly.o)).wedged).toBe('auth-blocked');
    const clean = opts(WAKEABLE, healthyHost, boom);
    expect((await verdictFor(subject, clean.o)).sessionState).toBe('parked');
  });
});

describe('WI-6554700010008461 — a host record without authBlocked is an unknown self-report', () => {
  // Measured 2026-10-11: hosts started before P-004 never write `authBlocked`. Three codex
  // sessions on such hosts had every wake turn end `unauthorized`, yet the oracle read the
  // missing field as healthy and called them parked. The codex rollout is the corroboration.
  const oldCodeHost: HostRecord = { ...healthyHost, advSessionId: '38238' };
  const unauthorized = {
    code: 'unauthorized',
    rawCode: 'unauthorized',
    message:
      'Your access token could not be refreshed because you have since logged out or signed in to another ' +
      'account. Please sign in again.',
  };

  it('POSITIVE CONTROL: an old host whose latest codex turn succeeded stays parked', async () => {
    const readProviderErrorFn = vi.fn(async () => null);
    const { o } = opts(WAKEABLE, oldCodeHost, [], { readProviderErrorFn });
    const v = await verdictFor(subject, o);
    expect(v.sessionState).toBe('parked');
    expect(v.wedged).toBeUndefined();
    // The rollout WAS consulted, so the parked verdict is a reading, not a skipped check.
    expect(readProviderErrorFn).toHaveBeenCalledTimes(1);
  });

  it('an old host whose latest codex turn since host start ended unauthorized → suspect, wedged auth-blocked', async () => {
    const readProviderErrorFn = vi.fn(async () => unauthorized);
    const { o } = opts(WAKEABLE, oldCodeHost, [], { readProviderErrorFn });
    const v = await verdictFor(subject, o);
    expect(v.sessionState).toBe('suspect');
    expect(v.wedged).toBe('auth-blocked');
    // Scoped to THIS host's child: the codex home outlives a host process.
    expect(readProviderErrorFn).toHaveBeenCalledWith('38238', HOST_STARTED_AT, 64 * 1024);
  });

  it('the same reading also wedges a non-wakeable session the host would otherwise rescue to recorded', async () => {
    const { o } = opts(NOT_WAKEABLE, oldCodeHost, [], { readProviderErrorFn: async () => unauthorized });
    const v = await verdictFor(subject, o);
    expect(v.sessionState).toBe('suspect');
    expect(v.wedged).toBe('auth-blocked');
  });

  it('a host that reports authBlocked:false is trusted; the rollout is never read', async () => {
    const readProviderErrorFn = vi.fn(async () => unauthorized);
    const { o } = opts(WAKEABLE, { ...oldCodeHost, authBlocked: false }, [], { readProviderErrorFn });
    const v = await verdictFor(subject, o);
    expect(v.sessionState).toBe('parked');
    expect(readProviderErrorFn).not.toHaveBeenCalled();
  });

  it('a quota terminal is not corroborated: walls lift at the provider reset (D-014)', async () => {
    const { o } = opts(WAKEABLE, oldCodeHost, [], {
      readProviderErrorFn: async () => ({ code: 'usage_limit_exceeded', rawCode: 'usageLimitExceeded', message: null }),
    });
    const v = await verdictFor(subject, o);
    expect(v.sessionState).toBe('parked');
    expect(v.wedged).toBeUndefined();
  });

  it('an unreadable rollout is no reading, never a wedge', async () => {
    const { o } = opts(WAKEABLE, oldCodeHost, [], {
      readProviderErrorFn: async () => {
        throw new Error('EACCES');
      },
    });
    expect((await verdictFor(subject, o)).sessionState).toBe('parked');
  });
});

describe('applyHostCondition (pure)', () => {
  const base: LivenessVerdict = {
    ownerId: OWNER,
    sessionState: 'parked',
    wakeable: true,
    liveTurn: false,
    confirmLiveness: false,
    heartbeatFresh: true,
  };

  it('moves every eligible state to suspect and names the condition', () => {
    for (const s of ['parked', 'draining', 'recorded'] as const) {
      const v = applyHostCondition({ ...base, sessionState: s }, 'unbound-successor');
      expect(v.sessionState).toBe('suspect');
      expect(v.wedged).toBe('unbound-successor');
      expect(v.confirmLiveness).toBe(true);
    }
  });

  it('leaves live, already-terminal and unknown verdicts unchanged', () => {
    for (const s of ['live', 'suspect', 'ended', null] as const) {
      const v = { ...base, sessionState: s };
      expect(applyHostCondition(v, 'auth-blocked')).toBe(v);
    }
  });

  it('a null condition is a no-op', () => {
    expect(applyHostCondition(base, null)).toBe(base);
  });
});
