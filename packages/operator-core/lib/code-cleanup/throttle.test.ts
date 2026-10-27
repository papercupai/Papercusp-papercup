import { describe, expect, it, vi } from 'vitest';
import type { AdmissionDeps, AdmissionInput } from './admission';
import {
  admitCampaignRound, attributeReds, campaignOutcome, DEFAULT_REGRESSION_THRESHOLD, DEFAULT_REGRESSION_WINDOW_MS,
  evaluateRegressionThrottle, initialThrottleState, resetRegressionThrottle,
  type GateRed, type LandedBatch,
} from './throttle';

const NOW = new Date('2026-10-27T06:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 24 * 60 * 60_000);

const batches: LandedBatch[] = [
  { batchId: 'scheduler#0', workItemId: 'EI-1', editedFiles: ['lib/scheduler/a.ts', 'lib/scheduler/b.ts'], commits: ['c1'], linesRemoved: 40 },
  { batchId: 'coord#0', workItemId: 'EI-2', editedFiles: ['lib/coord/c.ts'], commits: ['c2'], linesRemoved: 25 },
];
const red = (id: string, radius: string[], at = daysAgo(1), commit: string | null = null): GateRed =>
  ({ id, testFile: `${id}.test.ts`, at, affectedRadius: radius, attributedCommit: commit });

describe('cleanup campaign regression throttle (R-9)', () => {
  it('defaults to a threshold of 2 attributed reds within 7 days', () => {
    expect(DEFAULT_REGRESSION_THRESHOLD).toBe(2);
    expect(DEFAULT_REGRESSION_WINDOW_MS).toBe(7 * 24 * 60 * 60_000);
  });

  it('attributes a red to a batch only when its affected radius meets a file the batch edited', () => {
    const got = attributeReds([
      red('r1', ['lib/scheduler/b.ts', 'lib/other.ts']),
      red('r2', ['lib/other.ts']),
      red('r3', ['lib/coord/c.ts', 'lib/scheduler/a.ts']),
    ], batches, 'ledger');
    expect(got.map(r => [r.redId, r.batchIds])).toEqual([['r1', ['scheduler#0']], ['r3', ['coord#0', 'scheduler#0']]]);
  });

  it('attributes by commit on user repos', () => {
    const got = attributeReds([red('r1', [], daysAgo(1), 'c2'), red('r2', ['lib/coord/c.ts'], daysAgo(1), 'zz')], batches, 'commit');
    expect(got.map(r => [r.redId, r.batchIds])).toEqual([['r1', ['coord#0']]]);
  });

  it('stays open at the threshold and trips above it: no new batches, review becomes required', () => {
    const at2 = evaluateRegressionThrottle({ state: initialThrottleState('off'), batches, mode: 'ledger', now: NOW,
      reds: [red('r1', ['lib/scheduler/a.ts']), red('r2', ['lib/coord/c.ts'])] });
    expect(at2).toMatchObject({ count: 2, tripped: false, state: { throttled: false, review: 'off' } });

    const at3 = evaluateRegressionThrottle({ state: initialThrottleState('off'), batches, mode: 'ledger', now: NOW,
      reds: [red('r1', ['lib/scheduler/a.ts']), red('r2', ['lib/coord/c.ts']), red('r3', ['lib/scheduler/b.ts'])] });
    expect(at3).toMatchObject({ count: 3, tripped: true, state: { throttled: true, review: 'required', reviewBeforeTrip: 'off', trippedAt: NOW } });
  });

  it('counts a red once however many batches it touches, and never counts a red outside every radius', () => {
    const r = evaluateRegressionThrottle({ state: initialThrottleState('off'), batches, mode: 'ledger', now: NOW, reds: [
      red('r1', ['lib/scheduler/a.ts', 'lib/coord/c.ts']), red('r1', ['lib/scheduler/a.ts']),
      red('x1', ['lib/elsewhere.ts']), red('x2', ['lib/elsewhere2.ts']), red('x3', []),
      red('r2', ['lib/coord/c.ts']),
    ] });
    expect(r.counted.map(c => c.redId)).toEqual(['r1', 'r2']);
    expect(r.tripped).toBe(false);
  });

  it('ignores reds older than the window', () => {
    const r = evaluateRegressionThrottle({ state: initialThrottleState('off'), batches, mode: 'ledger', now: NOW, reds: [
      red('old1', ['lib/scheduler/a.ts'], daysAgo(8)), red('old2', ['lib/scheduler/a.ts'], daysAgo(9)),
      red('r1', ['lib/scheduler/a.ts'], daysAgo(6)), red('r2', ['lib/coord/c.ts'], daysAgo(1)),
    ] });
    expect(r).toMatchObject({ count: 2, tripped: false });
  });

  it('honours a custom threshold and window', () => {
    const r = evaluateRegressionThrottle({ state: initialThrottleState('off'), batches, mode: 'ledger', now: NOW, threshold: 0,
      windowMs: 60 * 60_000, reds: [red('r1', ['lib/scheduler/a.ts'], new Date(NOW.getTime() - 30 * 60_000))] });
    expect(r).toMatchObject({ count: 1, tripped: true });
  });

  it('stays throttled while more reds arrive; only a reset clears it', () => {
    const tripped = evaluateRegressionThrottle({ state: initialThrottleState('off'), batches, mode: 'ledger', now: NOW,
      reds: ['a', 'b', 'c'].map(id => red(id, ['lib/scheduler/a.ts'])) }).state;
    const again = evaluateRegressionThrottle({ state: tripped, batches, mode: 'ledger', now: NOW, reds: [] });
    expect(again).toMatchObject({ tripped: false, state: { throttled: true, review: 'required' } });
  });

  it('refuses a reset by an agent or any other non-owner principal', () => {
    const tripped = evaluateRegressionThrottle({ state: initialThrottleState('off'), batches, mode: 'ledger', now: NOW,
      reds: ['a', 'b', 'c'].map(id => red(id, ['lib/scheduler/a.ts'])) }).state;
    for (const who of ['su-4dec493b-e31f-4bb3-a183-948a34e1f92a', 'role:operator', 'service:green-checkpoint', 'owner', '']) {
      expect(resetRegressionThrottle(tripped, who, NOW)).toMatchObject({ ok: false, code: 'not-owner' });
    }
  });

  it('lets an owner principal reset it: review returns to its pre-trip value and earlier reds do not re-trip', () => {
    const reds = ['a', 'b', 'c'].map(id => red(id, ['lib/scheduler/a.ts']));
    const tripped = evaluateRegressionThrottle({ state: initialThrottleState('off'), batches, mode: 'ledger', now: NOW, reds }).state;
    const later = new Date(NOW.getTime() + 60_000);
    const reset = resetRegressionThrottle(tripped, 'user:avi', later);
    expect(reset).toMatchObject({ ok: true, state: { throttled: false, review: 'off', resetBy: 'user:avi', resetAt: later } });
    if (!reset.ok) throw new Error('reset refused');
    const after = evaluateRegressionThrottle({ state: reset.state, batches, mode: 'ledger', now: later, reds });
    expect(after).toMatchObject({ count: 0, tripped: false, state: { throttled: false } });
    expect(resetRegressionThrottle(reset.state, 'admin:loopback', later)).toMatchObject({ ok: false, code: 'not-throttled' });
  });

  it('keeps review required after a reset when it was required before the trip', () => {
    const tripped = evaluateRegressionThrottle({ state: initialThrottleState('required'), batches, mode: 'ledger', now: NOW,
      reds: ['a', 'b', 'c'].map(id => red(id, ['lib/scheduler/a.ts'])) }).state;
    const reset = resetRegressionThrottle(tripped, 'admin:loopback', NOW);
    expect(reset).toMatchObject({ ok: true, state: { review: 'required' } });
  });
});

describe('admission under the throttle (R-9 with R-7)', () => {
  const input: AdmissionInput = {
    campaignId: 'camp-1', self: 'su-runner', running: [], now: NOW,
    candidates: [{ id: 'b1', targetFiles: ['a.ts'] }, { id: 'b2', targetFiles: ['b.ts'] }],
  };
  const deps = (): AdmissionDeps & { acquire: ReturnType<typeof vi.fn> } => ({
    liveLocks: vi.fn(async () => []),
    editsSince: vi.fn(async () => []),
    acquire: vi.fn(async (b: { id: string }) => ({ ok: true as const, lockId: `lock-${b.id}` })),
  });

  it('starts no batch and takes no lock while throttled', async () => {
    const d = deps();
    const state = { ...initialThrottleState('off'), throttled: true, review: 'required' as const, reviewBeforeTrip: 'off' as const, trippedAt: NOW };
    const r = await admitCampaignRound(input, d, state);
    expect(r.throttled).toBe(true);
    expect(r.admitted).toEqual([]);
    expect(r.skipped.map(s => [s.batchId, s.reason])).toEqual([['b1', 'campaign-throttled'], ['b2', 'campaign-throttled']]);
    expect(d.acquire).not.toHaveBeenCalled();
  });

  it('admits as usual when not throttled', async () => {
    const d = deps();
    const r = await admitCampaignRound(input, d, initialThrottleState('off'));
    expect(r).toMatchObject({ throttled: false });
    expect(r.admitted.map(a => a.batchId)).toEqual(['b1', 'b2']);
  });
});

describe('campaign outcome metrics (P-008 outcome rubric)', () => {
  it('reports batches landed, lines removed and attributed reds per landed batch', () => {
    const attributed = attributeReds([red('r1', ['lib/scheduler/a.ts']), red('r1', ['lib/coord/c.ts'])], batches, 'ledger');
    expect(campaignOutcome(batches, attributed)).toEqual({ batchesLanded: 2, linesRemoved: 65, attributedReds: 1, regressionRate: 0.5 });
    expect(campaignOutcome([], [])).toEqual({ batchesLanded: 0, linesRemoved: 0, attributedReds: 0, regressionRate: 0 });
  });
});
