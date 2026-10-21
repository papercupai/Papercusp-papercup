/**
 * WI-6554700010019256: fleet:launch-failed:<slug> — a fleet:launch-on-plan call whose
 * response budget expired returns `pending` and finishes DETACHED. Failures that
 * detached completion records must reach the leader as an event instead of sitting
 * in last_launch_transaction until someone polls fleet:status.
 */
import { describe, expect, it, vi } from 'vitest';
import { buildKey, EVENT_CATALOG } from './events/await/catalog';
import { INTEREST_PROFILES } from './interest-profiles';
import { FLEET_ACTIVITY_TRANSITIONS } from './fleet-event-activity';
import {
  deriveFleetLaunchFailedSignal,
  emitFleetLaunchFailedEvent,
  fleetTransitionKey,
  LAUNCH_FAILED_REASON_MAX_CHARS,
  publishDetachedLaunchOutcome,
} from './fleet-transition-events';

const M1 = 'su-368d8ecc-8e08-49eb-87d0-38d31ffc4fa4';
const M2 = 'su-a533a163-4b6b-4b93-a114-77e313ccdf22';
const M3 = 'su-bbcc0a1b-f785-41fe-9357-e301a4e61367';
const M4 = 'su-d6872196-621e-48d5-8d18-63c5dabd390e';

/** The measured 2026-10-21 10:52Z transaction (fleet main-green-sol61-1016): the
 *  canary member died at boot, so waves 2+ never opened. */
function measuredTransaction() {
  return {
    transactionId: 'd3e74853',
    state: 'partial',
    requestedMemberIds: [M1, M2, M3, M4],
    openedMemberIds: [] as string[],
    verifiedMemberIds: [] as string[],
    failed: [
      {
        ownerId: M1,
        phase: 'spawn',
        reason:
          'headless member launched but its agent command died at boot (exit 1) — log tail: ' +
          '\u001b]10;#f4f4f5\u0007\u001b]11;#1e1b4b\u0007\u001b]0;SH: member 1/4\u0007' +
          'psu: POST /api/agent-mcp/console/bootstrap-su (HTTP 400) — su.md tiling is unsound',
      },
    ],
    recovery: {
      retryOwnerIds: [M1, M2, M3, M4],
      nextAction: 'resume from the first unresolved pre-pinned member identity; never relaunch verified members',
    },
  };
}

describe('deriveFleetLaunchFailedSignal', () => {
  it('reports the failed canary AND the members it kept from opening', () => {
    const signal = deriveFleetLaunchFailedSignal(measuredTransaction());
    expect(signal).not.toBeNull();
    expect(signal!.failed.map((f) => f.ownerId)).toEqual([M1]);
    expect(signal!.notOpenedOwnerIds).toEqual([M2, M3, M4]);
    expect(signal!.requested).toBe(4);
    expect(signal!.opened).toBe(0);
    expect(signal!.nextAction).toMatch(/resume from the first unresolved/);
  });

  it('strips terminal escape sequences and caps a log-tail reason', () => {
    const txn = measuredTransaction();
    const signal = deriveFleetLaunchFailedSignal(txn)!;
    expect(signal.failed[0].reason).not.toMatch(/\u001b/);
    expect(signal.failed[0].reason).toContain('bootstrap-su (HTTP 400)');

    txn.failed[0].reason = 'x'.repeat(LAUNCH_FAILED_REASON_MAX_CHARS * 3);
    const capped = deriveFleetLaunchFailedSignal(txn)!;
    expect(capped.failed[0].reason.length).toBe(LAUNCH_FAILED_REASON_MAX_CHARS + 1);
  });

  it('returns null when every requested member opened and verified', () => {
    expect(
      deriveFleetLaunchFailedSignal({
        transactionId: 't',
        state: 'verified',
        requestedMemberIds: [M1, M2],
        openedMemberIds: [M1, M2],
        verifiedMemberIds: [M1, M2],
        failed: [],
      }),
    ).toBeNull();
  });

  it('reports opened-but-unconfirmed members, but not ones that later verified', () => {
    const signal = deriveFleetLaunchFailedSignal({
      requestedMemberIds: [M1, M2],
      openedMemberIds: [M1, M2],
      verifiedMemberIds: [M1],
      unconfirmedMemberIds: [M1, M2],
      failed: [],
    });
    expect(signal).not.toBeNull();
    expect(signal!.unconfirmedOwnerIds).toEqual([M2]);
    expect(signal!.notOpenedOwnerIds).toEqual([]);
  });
});

describe('emitFleetLaunchFailedEvent', () => {
  it('fires fleet:launch-failed:<slug> with the per-member dispositions in the payload', async () => {
    const emit = vi.fn(async () => ({}));
    const signal = deriveFleetLaunchFailedSignal(measuredTransaction())!;
    await expect(
      emitFleetLaunchFailedEvent('main-green-sol61-1016', signal, { emit: emit as never }),
    ).resolves.toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
    const arg = (emit.mock.calls[0] as unknown[])[0] as {
      key: string;
      summary: string;
      payload: Record<string, unknown>;
      source: string;
    };
    expect(arg.key).toBe('fleet:launch-failed:main-green-sol61-1016');
    expect(arg.source).toBe('fleet');
    expect(arg.payload).toMatchObject({
      fleetSlug: 'main-green-sol61-1016',
      transition: 'launch-failed',
      notOpenedOwnerIds: [M2, M3, M4],
    });
    expect(arg.summary).toMatch(/1 failed, 3 never opened, 0 unconfirmed of 4 requested/);
    expect(arg.summary).toContain(M1);
  });

  it('never rejects, and skips a launch with no fleet slug', async () => {
    const signal = deriveFleetLaunchFailedSignal(measuredTransaction())!;
    const throwing = vi.fn(async () => {
      throw new Error('engine down');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(
        emitFleetLaunchFailedEvent('f', signal, { emit: throwing as never }),
      ).resolves.toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('launch-failed for f emit failed: engine down'));
    } finally {
      warn.mockRestore();
    }
    const emit = vi.fn(async () => ({}));
    await expect(emitFleetLaunchFailedEvent(null, signal, { emit: emit as never })).resolves.toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('publishDetachedLaunchOutcome', () => {
  it('reads the transaction only AFTER the detached completion settles', async () => {
    // At call time the launch looks clean (nothing requested yet recorded as failed);
    // the completion then records the failure in place, exactly as completeLaunch does.
    const txn = { ...measuredTransaction(), failed: [] as ReturnType<typeof measuredTransaction>['failed'] };
    txn.requestedMemberIds = [M1];
    txn.openedMemberIds = [M1];
    txn.verifiedMemberIds = [M1];
    let settle!: () => void;
    const completion = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const emit = vi.fn(async () => ({}));
    const published = publishDetachedLaunchOutcome(completion, 'f', txn, { emit: emit as never });

    txn.requestedMemberIds = [M1, M2, M3, M4];
    txn.openedMemberIds = [];
    txn.verifiedMemberIds = [];
    txn.failed = measuredTransaction().failed;
    settle();

    await expect(published).resolves.toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
    const arg = (emit.mock.calls[0] as unknown[])[0] as { payload: { notOpenedOwnerIds: string[] } };
    expect(arg.payload.notOpenedOwnerIds).toEqual([M2, M3, M4]);
  });

  it('still publishes when the detached completion rejects', async () => {
    const emit = vi.fn(async () => ({}));
    await expect(
      publishDetachedLaunchOutcome(Promise.reject(new Error('boom')), 'f', measuredTransaction(), {
        emit: emit as never,
      }),
    ).resolves.toBe(true);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('emits nothing for a launch that fully verified', async () => {
    const emit = vi.fn(async () => ({}));
    await expect(
      publishDetachedLaunchOutcome(Promise.resolve(), 'f', {
        requestedMemberIds: [M1],
        openedMemberIds: [M1],
        verifiedMemberIds: [M1],
        failed: [],
      }, { emit: emit as never }),
    ).resolves.toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
});

describe('fleet-launch-failed wiring', () => {
  it('is a catalogued family whose key matches the transition key', () => {
    expect(EVENT_CATALOG.some((f) => f.family === 'fleet-launch-failed' && f.exists)).toBe(true);
    expect(buildKey('fleet-launch-failed', { slug: 's' })).toBe(fleetTransitionKey('s', 'launch-failed'));
  });

  it('is auto-armed for every fleet leader', () => {
    const row = INTEREST_PROFILES.find(
      (r) => r.context === 'fleet-leader' && r.watch.kind === 'event' && r.watch.family === 'fleet-launch-failed',
    );
    expect(row?.tier).toBe('auto-arm');
  });

  it('is projected onto the fleet activity ledger', () => {
    expect(FLEET_ACTIVITY_TRANSITIONS).toContain('launch-failed');
  });
});
