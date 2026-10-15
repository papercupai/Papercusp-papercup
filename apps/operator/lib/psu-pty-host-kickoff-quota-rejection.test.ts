/**
 * EI-25925116860039557: a launch kickoff that the provider answers with a
 * usage-limit wall must be refused, not reported as an opened member.
 *
 * Measured 2026-10-14 on su-d648b4f9: turn-delivered (confirmed native) at
 * 03:01:27.290Z, then "You've hit your weekly limit" latched the quota detector at
 * 03:01:29.810Z. The success receipt had already been published, and the member
 * deferred every wake for 75 minutes. The host now holds the receipt for a
 * grace window after delivery; these tests pin that window's verdict and the
 * lever the 502 refusal names.
 */
import { describe, it, expect } from 'vitest';
import {
  awaitKickoffQuotaRejection,
  KICKOFF_QUOTA_REJECTION_GRACE_MS,
} from '../scripts/psu-pty-host.mjs';
import { kickoffQuotaLeverNote } from '@papercusp/operator-core/lib/console-spawn';

/** A virtual clock: sleep advances time instantly so the window is exercised
 *  without real waiting. */
function virtualClock(startMs: number) {
  let t = startMs;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

describe('awaitKickoffQuotaRejection (EI-25925116860039557)', () => {
  it('rejects when the wall latches 2.5s after delivery (the su-d648b4f9 timeline)', async () => {
    const deliveredAtMs = 1_000_000;
    const clock = virtualClock(deliveredAtMs);
    const wallAtMs = deliveredAtMs + 2_520;
    const verdict = await awaitKickoffQuotaRejection({
      isQuotaBlocked: () => clock.now() >= wallAtMs,
      deliveredAtMs,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(verdict.rejected).toBe(true);
    expect(verdict.stopped).toBe(false);
    expect(verdict.waitedMs).toBeGreaterThanOrEqual(2_520);
    expect(verdict.waitedMs).toBeLessThan(KICKOFF_QUOTA_REJECTION_GRACE_MS);
  });

  it('accepts a healthy kickoff once the grace window after delivery has passed', async () => {
    const deliveredAtMs = 5_000;
    const clock = virtualClock(deliveredAtMs);
    const verdict = await awaitKickoffQuotaRejection({
      isQuotaBlocked: () => false,
      deliveredAtMs,
      graceMs: 10_000,
      pollMs: 250,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(verdict).toEqual({ rejected: false, waitedMs: 10_000, stopped: false });
    // Bounded: it never sleeps past the deadline.
    expect(clock.sleeps.reduce((a, b) => a + b, 0)).toBe(10_000);
  });

  it('measures the window from delivery, so slow proof verification does not extend it', async () => {
    const deliveredAtMs = 0;
    // Proof verification already consumed 12s, past the 10s window.
    const clock = virtualClock(12_000);
    const verdict = await awaitKickoffQuotaRejection({
      isQuotaBlocked: () => false,
      deliveredAtMs,
      graceMs: 10_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(verdict.rejected).toBe(false);
    expect(clock.sleeps).toEqual([]);
  });

  it('still rejects a wall that latched during proof verification, even past the window', async () => {
    const clock = virtualClock(12_000);
    const verdict = await awaitKickoffQuotaRejection({
      isQuotaBlocked: () => true,
      deliveredAtMs: 0,
      graceMs: 10_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(verdict.rejected).toBe(true);
  });

  it('stops early on host shutdown without claiming a rejection', async () => {
    const clock = virtualClock(0);
    let stop = false;
    const verdict = await awaitKickoffQuotaRejection({
      isQuotaBlocked: () => false,
      deliveredAtMs: 0,
      graceMs: 10_000,
      pollMs: 250,
      now: clock.now,
      sleep: async (ms: number) => {
        await clock.sleep(ms);
        if (clock.now() >= 1_000) stop = true;
      },
      shouldStop: () => stop,
    });
    expect(verdict).toMatchObject({ rejected: false, stopped: true });
  });

  it('treats a throwing detector as not blocked (fail-open toward the existing proof)', async () => {
    const clock = virtualClock(0);
    const verdict = await awaitKickoffQuotaRejection({
      isQuotaBlocked: () => {
        throw new Error('detector unavailable');
      },
      deliveredAtMs: 0,
      graceMs: 500,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(verdict.rejected).toBe(false);
  });
});

describe('kickoffQuotaLeverNote (EI-25925116860039557)', () => {
  it.each([
    'kickoff-not-submitted:provider-quota-rejected',
    'kickoff-not-submitted:submit-verification-aborted-quota-blocked',
  ])('names account:auto as the lever for %s', (reason) => {
    expect(kickoffQuotaLeverNote(reason)).toContain("account:'auto'");
  });

  it.each([
    'kickoff-not-submitted:submit-verification-aborted-human-input',
    'kickoff-not-submitted:superseded',
    null,
    undefined,
  ])('adds nothing for a non-quota refusal (%s)', (reason) => {
    expect(kickoffQuotaLeverNote(reason)).toBe('');
  });
});
