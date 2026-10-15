/**
 * WI-6554700010008412 — a codex quota latch must expire at the provider's stated reset.
 *
 * Incident (2026-10-11, plan parked-agent-census-resumption-and-root-cause-2026-10-09#D-013):
 * 28 codex hosts sharing one ChatGPT login hit "You've hit your usage limit ... try again
 * at Oct 14th, 2026 8:24 PM." The detector is a level check over an output ring, codex has
 * no corroborator, and every wake is deferred while blocked. A walled idle TUI writes too
 * little to evict the banner, so nothing could ever clear the latch, even after the reset.
 * These tests pin the parse of the stated reset and the expiry that lets one deferred wake
 * through (a wall still in place repaints and re-latches).
 */
import { describe, it, expect } from 'vitest';
import {
  makeAuthBlockDetector,
  makeQuotaBlockDetector,
  parseQuotaResetAtMs,
  QUOTA_PROBE_BASE_MS,
  QUOTA_PROBE_MAX_MS,
  QUOTA_RESET_GRACE_MS,
} from '../scripts/psu-pty-host.mjs';

// The task_complete error the walled children recorded (U+2019 apostrophe, as codex emits it).
const INCIDENT_WALL =
  'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit ' +
  'https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 14th, 2026 8:24 PM.';
const INCIDENT_RESET = new Date(2026, 9, 14, 20, 24, 0, 0).getTime();
const BEFORE_RESET = new Date(2026, 9, 11, 0, 5, 0, 0).getTime();

describe('provider detector replay mode follows the replacement child', () => {
  it.each([
    ['quota', makeQuotaBlockDetector, INCIDENT_WALL],
    ['auth', makeAuthBlockDetector, 'Your access token could not be refreshed. Please log out and sign in again.'],
  ] as const)('%s ignores resumed history after a fresh launch, then detects a fresh failure', (_kind, make, wall) => {
    const detector = make({ agent: 'codex', now: () => BEFORE_RESET });
    expect(detector.observe(wall)).toBe('detected');

    detector.reset({ deferUntilSubmit: true });
    expect(detector.observe(wall)).toBeNull();
    expect(detector.isBlocked()).toBe(false);
    detector.observeInput('pasted prompt\r');
    expect(detector.observe(wall)).toBeNull();
    detector.observeInput('\r');
    expect(detector.observe(wall)).toBe('detected');
    expect(detector.isBlocked()).toBe(true);

    detector.reset({ deferUntilSubmit: false });
    expect(detector.observe(wall)).toBe('detected');
  });
});

describe('parseQuotaResetAtMs (WI-6554700010008412)', () => {
  it('parses the incident copy as a local-time instant', () => {
    expect(parseQuotaResetAtMs(INCIDENT_WALL, 'codex', BEFORE_RESET)).toBe(INCIDENT_RESET);
  });

  it('parses the clause after ANSI styling and terminal line wraps', () => {
    const wrapped =
      '\x1b[31m■ You’ve hit your usage limit.\x1b[0m Upgrade to Pro or try again\r\n  at Oct 14th,\r\n 2026 8:24 PM.';
    expect(parseQuotaResetAtMs(wrapped, 'codex', BEFORE_RESET)).toBe(INCIDENT_RESET);
  });

  it('parses a relative duration from the moment it is read', () => {
    const now = BEFORE_RESET;
    const text = 'You’ve hit your usage limit. Try again in 2 days 3 hours 5 minutes.';
    expect(parseQuotaResetAtMs(text, 'codex', now)).toBe(
      now + 2 * 86_400_000 + 3 * 3_600_000 + 5 * 60_000,
    );
  });

  it('reads a bare time already past as tomorrow, and a yearless past date as next year', () => {
    const now = new Date(2026, 9, 11, 21, 0, 0, 0).getTime();
    expect(parseQuotaResetAtMs('try again at 8:24 PM.', 'codex', now)).toBe(
      new Date(2026, 9, 12, 20, 24, 0, 0).getTime(),
    );
    expect(parseQuotaResetAtMs('try again at Oct 9th 5:13 PM.', 'codex', now)).toBe(
      new Date(2027, 9, 9, 17, 13, 0, 0).getTime(),
    );
  });

  it('uses the newest statement when the window holds an older wall too', () => {
    const text =
      'usage limit reached; try again at Oct 9th, 2026 5:13 PM. ... ' + INCIDENT_WALL;
    expect(parseQuotaResetAtMs(text, 'codex', BEFORE_RESET)).toBe(INCIDENT_RESET);
  });

  it('never returns a reset that is not in the future, and never parses other products', () => {
    const after = INCIDENT_RESET + 1;
    expect(parseQuotaResetAtMs(INCIDENT_WALL, 'codex', after)).toBeNull();
    expect(parseQuotaResetAtMs(INCIDENT_WALL, 'claude', BEFORE_RESET)).toBeNull();
    expect(parseQuotaResetAtMs(INCIDENT_WALL, '', BEFORE_RESET)).toBeNull();
    expect(parseQuotaResetAtMs('You’ve hit your usage limit.', 'codex', BEFORE_RESET)).toBeNull();
    expect(parseQuotaResetAtMs('try again at 25:99 PM', 'codex', BEFORE_RESET)).toBeNull();
    expect(parseQuotaResetAtMs('try again in a while', 'codex', BEFORE_RESET)).toBeNull();
  });
});

describe('makeQuotaBlockDetector reset expiry (WI-6554700010008412)', () => {
  it('holds the incident latch until the stated reset, then expires it once', () => {
    let now = BEFORE_RESET;
    const expired: Array<{ resetAtMs: number | null; blockedSinceMs: number | null }> = [];
    const d = makeQuotaBlockDetector({
      agent: 'codex',
      now: () => now,
      probeBaseMs: Number.POSITIVE_INFINITY, // isolate the stated-reset path
      onExpire: (e) => expired.push(e),
    });
    expect(d.observe(INCIDENT_WALL)).toBe('detected');
    expect(d.resetAtMs()).toBe(INCIDENT_RESET);
    expect(d.snapshot()).toMatchObject({ quotaBlocked: true, quotaResetAtMs: INCIDENT_RESET });

    // Idle screen: a little chrome, never enough to evict the banner.
    now = INCIDENT_RESET + QUOTA_RESET_GRACE_MS - 1;
    expect(d.observe(' ◦ ')).toBeNull();
    expect(d.isBlocked()).toBe(true);
    expect(expired).toHaveLength(0);

    now = INCIDENT_RESET + QUOTA_RESET_GRACE_MS;
    expect(d.isBlocked()).toBe(false);
    expect(expired).toEqual([
      expect.objectContaining({ resetAtMs: INCIDENT_RESET, blockedSinceMs: BEFORE_RESET }),
    ]);
    expect(d.snapshot()).toMatchObject({ quotaBlocked: false, quotaResetAtMs: null });

    // The stale window was dropped: more idle chrome cannot re-latch the old wall.
    expect(d.observe(' ◦ ')).toBeNull();
    expect(d.isBlocked()).toBe(false);
    expect(expired).toHaveLength(1);
  });

  it('re-latches with the new reset when the wall is still up on the next turn', () => {
    let now = BEFORE_RESET;
    const d = makeQuotaBlockDetector({ agent: 'codex', now: () => now, probeBaseMs: Number.POSITIVE_INFINITY });
    d.observe(INCIDENT_WALL);
    now = INCIDENT_RESET + QUOTA_RESET_GRACE_MS;
    expect(d.isBlocked()).toBe(false);

    const later = 'You’ve hit your usage limit. Try again in 3 hours.';
    expect(d.observe(later)).toBe('detected');
    expect(d.resetAtMs()).toBe(now + 3 * 3_600_000);
    expect(d.isBlocked()).toBe(true);
  });

  it('picks up a reset clause that arrives in a later chunk than the matched words', () => {
    const d = makeQuotaBlockDetector({ agent: 'codex', now: () => BEFORE_RESET });
    expect(d.observe('■ You’ve hit your usage limit. Upgrade to Pro or ')).toBe('detected');
    expect(d.resetAtMs()).toBeNull();
    expect(d.observe('try again at Oct 14th, 2026 8:24 PM.')).toBeNull();
    expect(d.resetAtMs()).toBe(INCIDENT_RESET);
  });

  it('keeps the fail-closed level when no reset is stated and probing is off (control)', () => {
    let now = BEFORE_RESET;
    const d = makeQuotaBlockDetector({ agent: 'codex', now: () => now, probeBaseMs: Number.POSITIVE_INFINITY });
    d.observe('You’ve hit your usage limit.');
    now = INCIDENT_RESET + 30 * 86_400_000;
    expect(d.isBlocked()).toBe(true);
    expect(d.snapshot()).toMatchObject({ quotaBlocked: true, quotaResetAtMs: null });
  });

  // D-014: on 2026-10-11 the stated reset was Oct 14 but credits were back by
  // 04:25Z Oct 11. Only a probe can see that.
  it('probes a latched codex wall before its stated reset, backing off while it stays walled', () => {
    let now = BEFORE_RESET;
    const released: Array<{ reason: string; probe: number | null }> = [];
    const d = makeQuotaBlockDetector({
      agent: 'codex',
      now: () => now,
      onExpire: (e: { reason: string; probe: number | null }) => released.push(e),
    });
    d.observe(INCIDENT_WALL);
    now += QUOTA_PROBE_BASE_MS - 1;
    expect(d.isBlocked()).toBe(true);
    now += 1;
    expect(d.isBlocked()).toBe(false); // first probe: one deferred wake goes through
    expect(released).toEqual([expect.objectContaining({ reason: 'probe', probe: 1 })]);

    // The probe turn hits the wall again: re-latch, next probe waits twice as long.
    expect(d.observe(INCIDENT_WALL)).toBe('detected');
    now += QUOTA_PROBE_BASE_MS;
    expect(d.isBlocked()).toBe(true);
    now += QUOTA_PROBE_BASE_MS;
    expect(d.isBlocked()).toBe(false);
    expect(released.at(-1)).toMatchObject({ reason: 'probe', probe: 2 });

    // The backoff is capped.
    for (let i = 0; i < 6; i++) {
      d.observe(INCIDENT_WALL);
      now += QUOTA_PROBE_MAX_MS;
      expect(d.isBlocked()).toBe(false);
    }
  });

  it('starts a new episode at the base interval once a wall returns long after the last probe', () => {
    let now = BEFORE_RESET;
    const d = makeQuotaBlockDetector({ agent: 'codex', now: () => now });
    d.observe(INCIDENT_WALL);
    now += QUOTA_PROBE_BASE_MS;
    expect(d.isBlocked()).toBe(false);
    now += QUOTA_PROBE_MAX_MS + 1; // the account worked for hours
    d.observe(INCIDENT_WALL);
    now += QUOTA_PROBE_BASE_MS;
    expect(d.isBlocked()).toBe(false);
  });

  it('never probes a claude wall (its TUI auto-continues at the reset)', () => {
    let now = BEFORE_RESET;
    const d = makeQuotaBlockDetector({ agent: 'claude', now: () => now });
    d.observe("You've hit your weekly limit.");
    now += 30 * 86_400_000;
    expect(d.isBlocked()).toBe(true);
  });

  it('clears the parsed reset on recycle', () => {
    const d = makeQuotaBlockDetector({ agent: 'codex', now: () => BEFORE_RESET });
    d.observe(INCIDENT_WALL);
    d.reset();
    expect(d.resetAtMs()).toBeNull();
    expect(d.isBlocked()).toBe(false);
  });
});
