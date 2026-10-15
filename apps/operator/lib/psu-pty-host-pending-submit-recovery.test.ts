// @vitest-environment node
// EI-25930229050142968: the standalone-Enter recovery of an unconfirmed machine
// submission (EI-25878022553042846) had no count bound. One session pressed
// Enter 393 times over 3.5h while its live nativeStartPending record deferred
// every later wake, so a fleet leader stayed silent for ~2h. These tests pin
// the bound (count + age), the provider-blocked exemption, and the retirement
// that tombstones every coalesced delivery id without allowing a repaste.
import { describe, expect, it } from 'vitest';
import {
  SUBMIT_RECOVERY_MAX_AGE_MS,
  SUBMIT_RECOVERY_MAX_RESUBMITS,
  decidePendingSubmissionRecovery,
  makeDeliveryDedup,
  retirePendingSubmission,
  submitRecoveryMaxAgeMs,
  submitRecoveryMaxResubmits,
} from '../scripts/psu-pty-host.mjs';

const base = { quietMs: 6_000, retryCap: 3, maxResubmits: 8, maxAgeMs: 30 * 60_000 };
const T0 = 1_000_000_000;

/** Drive the decision the way the host's activity tick does: every `tickMs`,
 *  with output going quiet right after each Enter. Returns the Enter count and
 *  the tick time at which the record was retired (or null). */
function simulate({ ticks, tickMs = 1_000, providerBlocked = () => false, maxResubmits = 8 }:
  { ticks: number; tickMs?: number; providerBlocked?: (now: number) => boolean; maxResubmits?: number }) {
  const r = { resubmits: 0, countedResubmits: 0, lastResubmitAtMs: T0, submittedAtMs: T0 };
  let lastOutputAtMs = T0;
  let enters = 0;
  for (let i = 1; i <= ticks; i++) {
    const now = T0 + i * tickMs;
    const d = decidePendingSubmissionRecovery({ ...base, ...r, lastOutputAtMs, now, maxResubmits,
      maxAgeMs: Number.POSITIVE_INFINITY, providerBlocked: providerBlocked(now) });
    if (d.action === 'exhausted') return { enters, retiredAt: now, reason: d.reason, record: r };
    if (d.action === 'resubmit') {
      enters++;
      r.resubmits++;
      if (d.counted) r.countedResubmits++;
      r.lastResubmitAtMs = now;
      lastOutputAtMs = now; // the TUI repaints after each Enter
    }
  }
  return { enters, retiredAt: null, reason: null, record: r };
}

describe('decidePendingSubmissionRecovery (EI-25930229050142968)', () => {
  it('stops after the configured number of counted Enters instead of pressing Enter forever', () => {
    // The incident cadence: ~30s per Enter for 100+ minutes. 4h of ticks here.
    const out = simulate({ ticks: 4 * 3_600 });
    expect(out.enters).toBe(8);
    expect(out.retiredAt).not.toBeNull();
    expect(out.reason).toBe('max-resubmits');
  });

  it('gives the last Enter its full retry window before retiring', () => {
    const r = { resubmits: 8, countedResubmits: 8, submittedAtMs: T0, lastResubmitAtMs: T0 + 100_000 };
    const retryMs = 6_000 * 3;
    const early = decidePendingSubmissionRecovery({ ...base, ...r, lastOutputAtMs: T0 + 100_000,
      now: T0 + 100_000 + retryMs - 1 });
    expect(early.action).toBe('wait');
    const due = decidePendingSubmissionRecovery({ ...base, ...r, lastOutputAtMs: T0 + 100_000,
      now: T0 + 100_000 + retryMs });
    expect(due).toMatchObject({ action: 'exhausted', reason: 'max-resubmits' });
  });

  it('keeps the original backoff: waits for quiet output and the previous retry window', () => {
    const r = { resubmits: 1, countedResubmits: 1, submittedAtMs: T0, lastResubmitAtMs: T0 };
    expect(decidePendingSubmissionRecovery({ ...base, ...r, lastOutputAtMs: T0 + 10_000, now: T0 + 12_000 }))
      .toMatchObject({ action: 'wait', retryMs: 12_000 });
    expect(decidePendingSubmissionRecovery({ ...base, ...r, lastOutputAtMs: T0, now: T0 + 11_999 }).action)
      .toBe('wait');
    expect(decidePendingSubmissionRecovery({ ...base, ...r, lastOutputAtMs: T0, now: T0 + 12_000 }))
      .toMatchObject({ action: 'resubmit', counted: true });
  });

  it('never spends the budget or retires while the provider is quota/auth-blocked', () => {
    const blockedUntil = T0 + 3_600_000;
    const out = simulate({ ticks: 2 * 3_600, providerBlocked: now => now < blockedUntil });
    // Enters during the block are allowed (the composer may accept one when the
    // block lifts) but are not counted; after the block, 8 counted Enters remain.
    expect(out.record.countedResubmits).toBe(8);
    expect(out.enters).toBeGreaterThan(8);
    expect(out.reason).toBe('max-resubmits');
    expect(out.retiredAt).toBeGreaterThan(blockedUntil);

    const old = { resubmits: 50, countedResubmits: 0, submittedAtMs: T0, lastResubmitAtMs: T0 };
    expect(decidePendingSubmissionRecovery({ ...base, ...old, lastOutputAtMs: T0,
      now: T0 + 10 * 3_600_000, providerBlocked: true })).toMatchObject({ action: 'resubmit', counted: false });
  });

  it('retires a submission older than the age bound even when output never goes quiet', () => {
    const r = { resubmits: 0, countedResubmits: 0, submittedAtMs: T0, lastResubmitAtMs: T0 };
    const now = T0 + base.maxAgeMs;
    expect(decidePendingSubmissionRecovery({ ...base, ...r, lastOutputAtMs: now - 1, now }))
      .toMatchObject({ action: 'exhausted', reason: 'max-age' });
    expect(decidePendingSubmissionRecovery({ ...base, ...r, lastOutputAtMs: now - 1, now: now - 1 }).action)
      .toBe('wait');
  });

  it('reads its bounds from the session env with module defaults as fallback', () => {
    expect(submitRecoveryMaxResubmits({})).toBe(SUBMIT_RECOVERY_MAX_RESUBMITS);
    expect(submitRecoveryMaxResubmits({ PAPERCUSP_PSU_PTY_SUBMIT_RECOVERY_MAX_CR: '2' })).toBe(2);
    expect(submitRecoveryMaxAgeMs({})).toBe(SUBMIT_RECOVERY_MAX_AGE_MS);
    expect(submitRecoveryMaxAgeMs({ PAPERCUSP_PSU_PTY_SUBMIT_RECOVERY_MAX_AGE_MS: '5000' })).toBe(5_000);
    expect(simulate({ ticks: 3_600, maxResubmits: 2 }).enters).toBe(2);
  });
});

describe('retirePendingSubmission (EI-25930229050142968)', () => {
  it('removes every coalesced id and tombstones it so a durable retry cannot repaste', () => {
    const dedup = makeDeliveryDedup();
    const shared = { marker: 'm1' };
    const other = { marker: 'm2' };
    const pending = new Map<string, unknown>([['d1', shared], ['d2', shared], ['d3', other]]);
    for (const id of ['d1', 'd2', 'd3']) dedup.markPending(id);

    expect(retirePendingSubmission(pending, shared, dedup).sort()).toEqual(['d1', 'd2']);
    // A wake for an unrelated delivery is no longer deferred by the retired record.
    expect([...pending.keys()]).toEqual(['d3']);
    // The host answers a superseded duplicate with deferred-native-turn-start-superseded.
    expect(dedup.state('d1')).toBe('superseded');
    expect(dedup.state('d2')).toBe('superseded');
    expect(dedup.state('d3')).toBe('pending');
    // A tombstone is never resurrected as pending by a retry.
    dedup.markPending('d1');
    expect(dedup.state('d1')).toBe('superseded');
  });

  it('is a no-op for a record that is no longer pending', () => {
    const dedup = makeDeliveryDedup();
    const pending = new Map<string, unknown>([['d1', { marker: 'm' }]]);
    expect(retirePendingSubmission(pending, { marker: 'other' }, dedup)).toEqual([]);
    expect(pending.size).toBe(1);
  });
});
