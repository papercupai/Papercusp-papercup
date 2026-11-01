/**
 * classifyStalledLoopHost — the stalled-loops guard's host verdict
 * (parked-agent-census-resumption-and-root-cause-2026-10-09 P-007).
 *
 * The verdict decides whether a turn-stalled loop is DISARMED or kept armed for the next wake's
 * child recycle. Its two inputs are shared with other callers on purpose:
 *   - the condition comes from turn-proof.ts `hostRecoverableCondition` (the P-006 pickup sweep);
 *   - wake-recoverability comes from `decideQuotaWakeRecovery` (the executor's inject-time gate).
 * So these tests pin the COMBINATION, not either half; each half has its own suite.
 */
import { describe, expect, it } from 'vitest';
import {
  AUTH_RECOVERY_MAX_PER_WINDOW,
  AUTH_RECOVERY_WINDOW_MS,
  classifyStalledLoopHost,
  type StalledLoopHostReading,
} from './host-recovery-eligibility';

const OWNER = 'su-stalled';
const NOW = 100 * AUTH_RECOVERY_WINDOW_MS;

type Host = NonNullable<StalledLoopHostReading['host']>;

/** A headless, agent-launched, recovery-capable host — the shape the executor will recycle. */
const recyclable: Host = {
  ownerId: OWNER,
  bridgeTty: false,
  launchedBy: 'su-leader',
  caps: ['quota-recovery', 'auth-recovery'],
};

const reading = (host: Host | null, events: unknown[] = []): StalledLoopHostReading => ({
  host,
  events: events as StalledLoopHostReading['events'],
});

const MIN = 60_000;
const WINDOW = 10 * MIN;
/** An ISO host-event timestamp `min` minutes from NOW (psu-pty-host writes ISO strings). */
const at = (min: number) => new Date(NOW + min * MIN).toISOString();
/** Three `pending` re-polls, the oldest 45 minutes old, no turn since (D-007 (c)). */
const stuckTail = [
  { kind: 'duplicate-delivery-id', state: 'pending', ts: at(-45) },
  { kind: 'duplicate-delivery-id', state: 'pending', ts: at(-30) },
  { kind: 'duplicate-delivery-id', state: 'pending', ts: at(-15) },
];

const authRecoveryAt = (startedAtMs: number) => ({
  kind: 'quota-recovery-started',
  recoveryOwnerId: OWNER,
  cause: 'auth',
  startedAtMs,
});

describe('classifyStalledLoopHost (P-007)', () => {
  it('no live host → no-host (the pre-P-007 disarm applies unchanged)', () => {
    expect(classifyStalledLoopHost(reading(null), OWNER, NOW)).toEqual({ kind: 'no-host' });
  });

  it('a host reporting no wall → healthy, even with a confirmed binding in its tail', () => {
    expect(classifyStalledLoopHost(reading(recyclable), OWNER, NOW)).toEqual({ kind: 'healthy' });
    expect(
      classifyStalledLoopHost(
        reading(recyclable, [{ kind: 'respawn-binding-unconfirmed' }, { kind: 'respawn-binding-confirmed' }]),
        OWNER,
        NOW,
      ),
    ).toEqual({ kind: 'healthy' });
  });

  it('THE CASE: a dead provider login on a recyclable host → recoverable-on-wake, cause auth', () => {
    expect(classifyStalledLoopHost(reading({ ...recyclable, authBlocked: true }), OWNER, NOW)).toEqual({
      kind: 'recoverable-on-wake',
      condition: 'auth-blocked',
      cause: 'auth',
    });
  });

  it('a quota wall on a recyclable host → recoverable-on-wake, cause quota', () => {
    expect(classifyStalledLoopHost(reading({ ...recyclable, quotaBlocked: true }), OWNER, NOW)).toEqual({
      kind: 'recoverable-on-wake',
      condition: 'quota-blocked',
      cause: 'quota',
    });
  });

  it('auth outranks quota when both are reported', () => {
    expect(
      classifyStalledLoopHost(reading({ ...recyclable, authBlocked: true, quotaBlocked: true }), OWNER, NOW),
    ).toMatchObject({ kind: 'recoverable-on-wake', condition: 'auth-blocked', cause: 'auth' });
  });

  it('auth recoveries exhausted inside the window → needs-relaunch naming the dead SHARED login', () => {
    const events = Array.from({ length: AUTH_RECOVERY_MAX_PER_WINDOW }, (_, i) => authRecoveryAt(NOW - 1000 * (i + 1)));
    const verdict = classifyStalledLoopHost(reading({ ...recyclable, authBlocked: true }, events), OWNER, NOW);
    expect(verdict).toMatchObject({ kind: 'needs-relaunch', condition: 'auth-blocked' });
    expect(verdict.kind === 'needs-relaunch' && verdict.why).toContain('auth-recovery-exhausted');
    expect(verdict.kind === 'needs-relaunch' && verdict.remedy).toContain('re-authenticate');
  });

  it('auth recoveries OUTSIDE the window do not count against the bound', () => {
    const events = Array.from({ length: AUTH_RECOVERY_MAX_PER_WINDOW }, () =>
      authRecoveryAt(NOW - AUTH_RECOVERY_WINDOW_MS - 1),
    );
    expect(classifyStalledLoopHost(reading({ ...recyclable, authBlocked: true }, events), OWNER, NOW)).toMatchObject({
      kind: 'recoverable-on-wake',
    });
  });

  it('an interactive (bridged) host is never recycled → needs-relaunch with the owner-restart remedy', () => {
    const verdict = classifyStalledLoopHost(reading({ ...recyclable, authBlocked: true, bridgeTty: true }), OWNER, NOW);
    expect(verdict).toMatchObject({ kind: 'needs-relaunch', condition: 'auth-blocked' });
    expect(verdict.kind === 'needs-relaunch' && verdict.why).toContain('not-headless');
    expect(verdict.kind === 'needs-relaunch' && verdict.remedy).toContain('owner must restart');
  });

  it('a host that is not agent-launched, or lacks the capability, is not predicted recoverable', () => {
    expect(
      classifyStalledLoopHost(reading({ ...recyclable, authBlocked: true, launchedBy: null }), OWNER, NOW),
    ).toMatchObject({ kind: 'needs-relaunch', why: expect.stringContaining('not-agent-launched') });
    expect(
      classifyStalledLoopHost(reading({ ...recyclable, authBlocked: true, caps: ['quota-recovery'] }), OWNER, NOW),
    ).toMatchObject({ kind: 'needs-relaunch', why: expect.stringContaining('host-capability-missing') });
  });

  it('a discovery record naming another owner is never recycled for this one', () => {
    expect(
      classifyStalledLoopHost(reading({ ...recyclable, authBlocked: true, ownerId: 'su-other' }), OWNER, NOW),
    ).toMatchObject({ kind: 'needs-relaunch', why: expect.stringContaining('wrong-owner') });
  });

  it('an UNBOUND successor is never wake-recoverable, even on a fully recyclable host', () => {
    const unbound = [
      { kind: 'respawn-binding-confirmed', ts: at(-20) },
      { kind: 'respawn-binding-unconfirmed', reason: 'successor-native-id-missing', ts: at(-10) },
    ];
    const refused = [{ kind: 'successor-unbindable-refused', ts: at(-5) }];
    for (const events of [unbound, refused]) {
      const verdict = classifyStalledLoopHost(reading(recyclable, events), OWNER, NOW);
      expect(verdict).toMatchObject({ kind: 'needs-relaunch', condition: 'unbound-successor' });
      expect(verdict.kind === 'needs-relaunch' && verdict.why).toContain('deferred-successor-unbindable');
    }
  });

  it('D-007: an unconfirmed binding that ended for another reason, or a predecessor host, is healthy', () => {
    // A binding WAIT that ended (superseded) is not an unbindable child.
    expect(
      classifyStalledLoopHost(
        reading(recyclable, [{ kind: 'respawn-binding-unconfirmed', reason: 'superseded', ts: at(-10) }]),
        OWNER,
        NOW,
      ),
    ).toEqual({ kind: 'healthy' });
    // The tail is per owner: an unbindable child of a host process that has since been
    // relaunched says nothing about the current one.
    expect(
      classifyStalledLoopHost(
        reading({ ...recyclable, startedAt: NOW - 5 * MIN }, [
          { kind: 'respawn-binding-unconfirmed', reason: 'successor-native-id-missing', ts: at(-10) },
        ]),
        OWNER,
        NOW,
      ),
    ).toEqual({ kind: 'healthy' });
    // A turn the host delivered after the unconfirmed binding proves the child was bindable.
    expect(
      classifyStalledLoopHost(
        reading(recyclable, [
          { kind: 'respawn-binding-unconfirmed', reason: 'successor-native-id-missing', ts: at(-10) },
          { kind: 'turn-delivered', ts: at(-9) },
        ]),
        OWNER,
        NOW,
      ),
    ).toEqual({ kind: 'healthy' });
  });

  it('D-007: a host re-polling pending deliveries past the window with no turn → needs-relaunch pending-turn-stuck', () => {
    const verdict = classifyStalledLoopHost(reading(recyclable, stuckTail), OWNER, NOW, WINDOW);
    expect(verdict).toMatchObject({ kind: 'needs-relaunch', condition: 'pending-turn-stuck' });
    expect(verdict.kind === 'needs-relaunch' && verdict.why).toContain('3 times over 45m');
    expect(verdict.kind === 'needs-relaunch' && verdict.remedy).toContain('P-012');
  });

  it('D-007: a cold loop carry-respawn retry is a stuck turn when its routineId is present', () => {
    const events = [-45, -30, -15].map((min) => ({
      kind: 'duplicate-delivery-id', state: 'pending', mode: 'carry-respawn',
      routineId: 'rt-cold-loop', fireNumber: 15, ts: at(min),
    }));
    expect(classifyStalledLoopHost(reading(recyclable, events), OWNER, NOW, WINDOW)).toMatchObject({
      kind: 'needs-relaunch', condition: 'pending-turn-stuck',
    });
  });

  it('D-007: the same pending tail on a visibly busy host is healthy (a long turn pends its wakes)', () => {
    expect(
      classifyStalledLoopHost(reading({ ...recyclable, lastOutputAt: NOW - MIN }, stuckTail), OWNER, NOW, WINDOW),
    ).toEqual({ kind: 'healthy' });
    expect(
      classifyStalledLoopHost(
        reading({ ...recyclable, execution: { phase: 'running', lastProgressAt: NOW - MIN } }, stuckTail),
        OWNER,
        NOW,
        WINDOW,
      ),
    ).toEqual({ kind: 'healthy' });
  });

  it('D-007: a host wall outranks a stuck pipeline, so the recovery that clears the cause still runs', () => {
    expect(classifyStalledLoopHost(reading({ ...recyclable, authBlocked: true }, stuckTail), OWNER, NOW, WINDOW)).toEqual({
      kind: 'recoverable-on-wake',
      condition: 'auth-blocked',
      cause: 'auth',
    });
  });

  it('every needs-relaunch verdict carries a non-empty remedy', () => {
    const shapes: Array<[Host, unknown[]]> = [
      [{ ...recyclable, authBlocked: true, bridgeTty: true }, []],
      [{ ...recyclable, quotaBlocked: true, launchedBy: null }, []],
      [{ ...recyclable, quotaBlocked: true, caps: [] }, []],
      [{ ...recyclable, authBlocked: true, ownerId: 'su-other' }, []],
      [recyclable, [{ kind: 'successor-unbindable-refused', ts: at(-1) }]],
      [recyclable, stuckTail],
    ];
    for (const [host, events] of shapes) {
      const verdict = classifyStalledLoopHost(reading(host, events), OWNER, NOW);
      expect(verdict.kind).toBe('needs-relaunch');
      expect(verdict.kind === 'needs-relaunch' && verdict.remedy.length).toBeGreaterThan(10);
    }
  });
});
