import { describe, expect, it } from 'vitest';
import { computeGreenMainSlo, evaluateGreenMainRecoveryWindow, evaluateGreenMainRepairRoundWindow, evaluateGreenMainAdmissionWindow, GREEN_MAIN_SLO_DEFAULTS, type GreenMainSloQueue } from './green-main-slo';
import type { PipelineEventWindowRead } from '../harness/git-sync/pipeline-events';
import type { FrozenRepairProgress } from './freeze-disposition';

const H = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);

describe('original admission and unfinished-round lifetimes', () => {
  const start = NOW - H;
  const history = (): PipelineEventWindowRead => {
    const heads = ['a', 'b', 'c', 'd', 'e', 'f'].map(c => c.repeat(40));
    return { status: 'complete', total: 1, windowStartMs: start, windowEndMs: NOW, reason: null,
      rows: [{ id: '1', kind: 'green_checkpoint_repair_latency', status: 'converging', createdAtMs: NOW,
        detail: { candidate: heads[0], observedAtMs: NOW,
          repairLatency: { stamps: { openedAtMs: start } },
          repairProgress: { phase: 'awaiting-fixer', rounds: heads.map((head, i) => ({ round: i + 1, head, atMs: start + i * 10 * 60_000 })),
            admissionHistory: { version: 1, repairHead: heads[5],
              admissions: heads.slice(1).map((head, i) => ({ fromRepairHead: heads[i], toRepairHead: head,
                atMs: start + i * 10 * 60_000 + 60_000 })) } },
        } }],
    };
  };
  const progress = (h: PipelineEventWindowRead) => h.rows[0]!.detail.repairProgress as FrozenRepairProgress;
  const result = (h: PipelineEventWindowRead) => evaluateGreenMainAdmissionWindow(h, NOW);
  const assertion = (h: PipelineEventWindowRead, id: string) => result(h).assertions.find(a => a.id === id)!.passed;
  it('measures five distinct original admission-to-verdict rounds', () => {
    const r = result(history());
    expect(r.assertions.every(a => a.passed)).toBe(true);
    expect(r.admissions).toHaveLength(5);
    expect(r.completedRounds).toHaveLength(5);
    expect(r.medianMs).toBe(9 * 60_000);
  });
  it('keeps pending work and tests its age at the window end', () => {
    const h = history(), p = progress(h);
    p.rounds = p.rounds.slice(0, 1);
    const r = result(h);
    expect(r.admissions).toHaveLength(5);
    expect(r.admissions.every(a => a.pending)).toBe(true);
    expect(assertion(h, 'admission-rounds-at-most-45min')).toBe(false);
    expect(assertion(h, 'all-admission-rounds-have-verdicts')).toBe(false);
  });
  it('does not turn a retired pending queue into completed work', () => {
    const h = history(); progress(h).rounds = progress(h).rounds.slice(0, 1); h.rows[0]!.status = 'retired';
    expect(result(h).admissions.every(a => a.pending)).toBe(true);
    expect(assertion(h, 'all-admission-rounds-have-verdicts')).toBe(false);
  });
  it('counts a batch of five admissions sharing one descendant verdict as one round', () => {
    const h = history(), p = progress(h);
    p.rounds = [p.rounds[0]!, { ...p.rounds[5]!, round: 2 }];
    expect(result(h).completedRounds).toHaveLength(1);
    expect(assertion(h, 'at-least-five-consecutive-admission-rounds')).toBe(false);
    expect(result(h).medianMs).toBe(49 * 60_000);
  });
  it('uses a terminal green clock at the exact admitted head', () => {
    const h = history(), p = progress(h);
    p.phase = 'ready-to-promote'; p.rounds.pop();
    h.rows[0]!.detail.repairLatency = { stamps: { openedAtMs: start, lastVerdictAtMs: start + 50 * 60_000 } };
    expect(result(h).assertions.every(a => a.passed)).toBe(true);
    delete (h.rows[0]!.detail.repairLatency as { stamps: { lastVerdictAtMs?: number } }).stamps.lastVerdictAtMs;
    expect(assertion(h, 'original-complete-admission-chains')).toBe(false);
  });
  it('deduplicates overlapping original snapshots', () => {
    const h = history(); h.rows.push({ ...structuredClone(h.rows[0]!), id: '2' }); h.total = 2;
    expect(result(h).assertions.every(a => a.passed)).toBe(true);
    expect(result(h).completedRounds).toHaveLength(5);
  });
  it('enforces the exact 45-minute limit without an extra tick', () => {
    const h = history(), p = progress(h), chain = p.admissionHistory!;
    chain.admissions = chain.admissions.slice(0, 1); chain.repairHead = chain.admissions[0]!.toRepairHead;
    p.rounds = p.rounds.slice(0, 2); p.rounds[1]!.atMs = start + 46 * 60_000;
    expect(assertion(h, 'admission-rounds-at-most-45min')).toBe(true);
    p.rounds[1]!.atMs++;
    expect(assertion(h, 'admission-rounds-at-most-45min')).toBe(false);
  });
  it('fails closed rather than throwing on a malformed original round', () => {
    const h = history(); Object.assign(progress(h).rounds, { 0: null });
    expect(result(h).assertions.every(a => a.passed)).toBe(false);
  });
  it.each(['legacy', 'trimmed-prefix', 'broken-chain', 'wrong-current-head', 'reconstructed',
    'clock-conflict', 'future-admission', 'stale-open-end', 'unknown-version', 'duplicate-head', 'older-verdict'])(
    'rejects %s evidence instead of a healthy retained subset', defect => {
      const h = history(), p = progress(h), chain = p.admissionHistory!;
      if (defect === 'legacy') delete p.admissionHistory;
      if (defect === 'trimmed-prefix') chain.admissions.shift();
      if (defect === 'broken-chain') chain.admissions[2]!.fromRepairHead = 'wrong';
      if (defect === 'wrong-current-head') chain.repairHead = 'wrong';
      if (defect === 'reconstructed') chain.admissions[0]!.provenance = 'reconciled-from-ref';
      if (defect === 'clock-conflict') {
        h.rows.push({ ...structuredClone(h.rows[0]!), id: '2' }); h.total = 2;
        (h.rows[1]!.detail.repairProgress as FrozenRepairProgress).admissionHistory!.admissions[0]!.atMs++;
      }
      if (defect === 'future-admission') chain.admissions[4]!.atMs = NOW + 1;
      if (defect === 'stale-open-end') h.rows[0]!.detail.observedAtMs = NOW - 1;
      if (defect === 'unknown-version') Object.assign(chain, { version: 2 });
      if (defect === 'duplicate-head') chain.admissions[1]!.toRepairHead = chain.admissions[0]!.toRepairHead;
      if (defect === 'older-verdict') chain.admissions[4]!.atMs = start + 51 * 60_000;
      expect(result(h).assertions.every(a => a.passed)).toBe(false);
    });
  it('keeps a missing/capped population and future window unqualified', () => {
    for (const h of [{ ...history(), status: 'capped' as const }, { ...history(), total: 2 },
      { ...history(), windowEndMs: NOW + 1 }]) expect(result(h).assertions.every(a => a.passed)).toBe(false);
  });
});

describe('original completed repair-round history', () => {
  const start = NOW - H;
  const history = (): PipelineEventWindowRead => ({
    status: 'complete', total: 1, windowStartMs: start, windowEndMs: NOW, reason: null,
    rows: [{ id: '1', kind: 'green_checkpoint_repair_latency', status: 'converging', createdAtMs: NOW,
      detail: { candidate: 'a'.repeat(40), observedAtMs: NOW,
        repairLatency: { stamps: { openedAtMs: start } },
        repairProgress: { phase: 'awaiting-fixer', rounds: [
          { round: 1, head: 'a'.repeat(40), atMs: start },
          { round: 2, head: 'b'.repeat(40), atMs: start + 45 * 60_000 },
        ] },
      } }],
  });
  const passed = (input: PipelineEventWindowRead) => evaluateGreenMainRepairRoundWindow(input, NOW).assertions.every(a => a.passed);
  it('accepts the exact 45-minute bound from original ordinals and clocks', () => {
    const result = evaluateGreenMainRepairRoundWindow(history(), NOW);
    expect(result.assertions.every(a => a.passed)).toBe(true);
    expect(result.intervals).toMatchObject([{ fromRound: 1, toRound: 2, durationMs: 45 * 60_000 }]);
  });
  it('does not let a later fast round hide an earlier slow round', () => {
    const h = history();
    const rounds = (h.rows[0]!.detail.repairProgress as { rounds: Array<{ round: number; head: string; atMs: number }> }).rounds;
    rounds[1]!.atMs = start + 46 * 60_000;
    rounds.push({ round: 3, head: 'c'.repeat(40), atMs: start + 47 * 60_000 });
    expect(evaluateGreenMainRepairRoundWindow(h, NOW).assertions.find(a => a.id === 'completed-repair-rounds-at-most-45min')!.passed).toBe(false);
  });
  it('deduplicates identical overlapping snapshots but rejects conflicting identities', () => {
    const h = history(); h.rows.push({ ...structuredClone(h.rows[0]!), id: '2' }); h.total = 2;
    expect(passed(h)).toBe(true);
    expect(evaluateGreenMainRepairRoundWindow(h, NOW).intervals).toHaveLength(1);
    (h.rows[1]!.detail.repairProgress as { rounds: Array<{ head: string }> }).rounds[1]!.head = 'c'.repeat(40);
    expect(passed(h)).toBe(false);
  });
  it.each(['capped', 'unavailable', 'invalid'] as const)('fails closed for %s reads', status => {
    expect(passed({ ...history(), status })).toBe(false);
  });
  it.each(['missing-progress', 'missing-opening', 'ordinal-gap', 'trimmed-prefix', 'duplicate-ordinal',
    'future-round', 'reversed-clocks', 'missing-head', 'unknown-phase', 'future-snapshot',
    'missing-population', 'duplicate-event', 'empty-rounds', 'empty-ledger'])(
    'rejects %s rather than accepting a healthy retained subset', defect => {
      const h = history(), row = h.rows[0]!;
      const progress = row.detail.repairProgress as { phase: string; rounds: Array<{ round: number; head: string; atMs: number }> };
      if (defect === 'missing-progress') delete row.detail.repairProgress;
      if (defect === 'missing-opening') delete row.detail.repairLatency;
      if (defect === 'ordinal-gap') progress.rounds[1]!.round = 3;
      if (defect === 'trimmed-prefix') progress.rounds[0]!.round = 2;
      if (defect === 'duplicate-ordinal') progress.rounds[1]!.round = 1;
      if (defect === 'future-round') progress.rounds[1]!.atMs = NOW + 1;
      if (defect === 'reversed-clocks') progress.rounds[1]!.atMs = start;
      if (defect === 'missing-head') progress.rounds[1]!.head = '';
      if (defect === 'unknown-phase') progress.phase = 'unknown';
      if (defect === 'future-snapshot') row.detail.observedAtMs = NOW + 1;
      if (defect === 'missing-population') h.total = 2;
      if (defect === 'duplicate-event') { h.rows.push(structuredClone(row)); h.total = 2; }
      if (defect === 'empty-rounds') progress.rounds = [];
      if (defect === 'empty-ledger') { h.rows = []; h.total = 0; }
      expect(passed(h)).toBe(false);
    });
  it('keeps queue incarnations separate and excludes intervals completed before the window', () => {
    const h = history(); const old = structuredClone(h.rows[0]!); old.id = '2';
    old.detail.repairLatency = { stamps: { openedAtMs: start - H } };
    old.detail.repairProgress = { phase: 'awaiting-fixer', rounds: [
      { round: 1, head: 'a'.repeat(40), atMs: start - H }, { round: 2, head: 'b'.repeat(40), atMs: start - 1 },
    ] };
    h.rows.push(old); h.total = 2;
    expect(passed(h)).toBe(true);
    expect(evaluateGreenMainRepairRoundWindow(h, NOW).intervals).toHaveLength(1);
    expect(evaluateGreenMainRepairRoundWindow(h, NOW - 1).assertions[0]!.passed).toBe(false);
  });
});

describe('original red-to-green recovery history', () => {
  function history(durations = [H, 2 * H, 3 * H, 4 * H, 8 * H]): PipelineEventWindowRead {
    const rows: PipelineEventWindowRead['rows'] = [];
    let at = NOW;
    const add = (status: string, time: number) => rows.push({ id: `event-${rows.length}`, kind: 'green_checkpoint',
      status, createdAtMs: time, detail: { gateFireId: `fire-${rows.length}`, runId: `run-${rows.length}`, candidate: 'a'.repeat(40) } });
    add('advanced', at);
    for (const duration of durations) { add('not-green', at + 1); at += duration + 1; add('up-to-date', at); }
    return { status: 'complete', total: rows.length, rows, reason: null, windowStartMs: NOW, windowEndMs: at };
  }
  const evaluate = (h: PipelineEventWindowRead) => evaluateGreenMainRecoveryWindow(h, h.windowEndMs);
  const passed = (h: PipelineEventWindowRead, id: string) => evaluate(h).assertions.find(a => a.id === id)!.passed;
  it('uses the first red through actual green and the original population', () => {
    const h = history();
    const result = evaluate(h);
    expect(result.assertions.every(a => a.passed)).toBe(true);
    expect(result.medianMs).toBe(3 * H);
    expect(result.p90Ms).toBe(8 * H);
    expect(result.eventIds).toEqual(h.rows.map(row => row.id));
  });
  it('does not reset an outage on a repeated red, skip or promotion failure', () => {
    const h = history([9 * H]);
    h.rows.splice(2, 0, ...['not-green', 'skipped-locked', 'not-fast-forward'].map((status, i) => ({
      id: `interior-${i}`, kind: 'green_checkpoint' as const, status, createdAtMs: NOW + (i + 1) * H,
      detail: { gateFireId: `interior-${i}` },
    }))); h.total = h.rows.length;
    expect(evaluate(h).episodes[0]!.durationMs).toBe(9 * H);
    expect(passed(h, 'recovery-p90-at-most-8h')).toBe(false);
  });
  it('fails median and p90 independently', () => {
    expect(passed(history([5 * H]), 'recovery-median-at-most-4h')).toBe(false);
    expect(passed(history([H, H, H, H, 9 * H]), 'recovery-median-at-most-4h')).toBe(true);
    expect(passed(history([H, H, H, H, 9 * H]), 'recovery-p90-at-most-8h')).toBe(false);
  });
  it('preserves a red episode that began before the observation window', () => {
    const h = history([9 * H]); h.windowStartMs = NOW + 7 * H;
    expect(evaluate(h).episodes[0]!.redAtMs).toBe(NOW + 1);
    expect(passed(h, 'recovery-p90-at-most-8h')).toBe(false);
  });
  it('keeps an unfinished red in the population instead of grading only completed episodes', () => {
    const h = history([H]); h.rows.push({ id: 'unfinished', kind: 'green_checkpoint', status: 'not-green',
      createdAtMs: h.windowEndMs, detail: { gateFireId: 'unfinished' } }); h.total! += 1;
    expect(evaluate(h).openRedEventId).toBe('unfinished');
    expect(passed(h, 'all-red-episodes-closed')).toBe(false);
    expect(passed(h, 'recovery-median-at-most-4h')).toBe(false);
  });
  it('collapses matching producer/fallback receipts, rejecting conflicting measured identities', () => {
    const h = history([H]); const original = h.rows[2]!;
    h.rows.push({ ...original, id: 'fallback' }); h.total! += 1;
    expect(evaluate(h).episodes).toHaveLength(1);
    expect(passed(h, 'qualified-recovery-verdicts')).toBe(true);
    h.rows.at(-1)!.detail = { ...original.detail, candidate: 'b'.repeat(40) };
    expect(passed(h, 'qualified-recovery-verdicts')).toBe(false);
  });
  it.each(['capped', 'invalid', 'unavailable'] as const)('rejects a %s healthy subset', status => {
    const h = history(); h.status = status;
    expect(passed(h, 'recovery-median-at-most-4h')).toBe(false);
  });
  it('rejects absent, duplicate or count-inconsistent populations', () => {
    const h = history(); h.rows = []; h.total = 0;
    expect(passed(h, 'complete-recovery-population')).toBe(false);
    const duplicate = history(); duplicate.rows[1]!.id = duplicate.rows[0]!.id;
    expect(passed(duplicate, 'complete-recovery-population')).toBe(false);
    const count = history(); count.total! += 1;
    expect(passed(count, 'complete-recovery-population')).toBe(false);
  });
  it('rejects unknown statuses, absent fire identity and missing left-boundary evidence', () => {
    const h = history(); h.rows[1]!.status = 'unrecognized';
    expect(passed(h, 'qualified-recovery-verdicts')).toBe(false);
    const unidentified = history(); delete unidentified.rows[1]!.detail.gateFireId;
    expect(passed(unidentified, 'qualified-recovery-verdicts')).toBe(false);
    const boundary = history(); boundary.rows.shift(); boundary.total! -= 1;
    expect(passed(boundary, 'recovery-left-boundary-known')).toBe(false);
  });
  it('rejects a future endpoint and invalid row clock', () => {
    const h = history();
    expect(evaluateGreenMainRecoveryWindow(h, h.windowEndMs - 1).assertions[0]!.passed).toBe(false);
    h.rows[1]!.createdAtMs = NaN;
    expect(passed(h, 'complete-recovery-population')).toBe(false);
  });
  it('does not infer recovery from a window containing only green verdicts', () => {
    const h = history([]); h.windowEndMs += H;
    expect(passed(h, 'nonempty-recovery-sample')).toBe(false);
  });
});

function queue(overrides: Partial<GreenMainSloQueue> = {}): GreenMainSloQueue {
  return {
    candidate: 'c'.repeat(40),
    openedAtMs: NOW - 20 * H,
    phase: 'ready-to-verify',
    convergenceRounds: [
      { round: 1, head: 'h1', failingCount: 5, atMs: NOW - 19 * H },
      { round: 2, head: 'h2', failingCount: 3, atMs: NOW - 16 * H },
      { round: 3, head: 'h3', failingCount: 4, atMs: NOW - 15 * H },
    ],
    admissions: [
      { atMs: NOW - 18 * H, actor: 'su-a', source: { ref: 'staging', sha: 's1' }, fromRepairHead: 'h1', toRepairHead: 'a1', paths: ['x.ts'], unchanged: [], blobs: {} },
      { atMs: NOW - 15.5 * H, actor: 'su-b', source: { ref: 'staging', sha: 's2' }, fromRepairHead: 'h2', toRepairHead: 'a2', paths: ['y.ts'], unchanged: [], blobs: {} },
    ],
    lastAdmittedAtMs: NOW - 3 * H,
    ...overrides,
  };
}

const base = { installSlug: 'papercusp', nowMs: NOW };

describe('computeGreenMainSlo — metrics from their named populations', () => {
  it('computes all six metrics', () => {
    const slo = computeGreenMainSlo({
      ...base,
      lastGreenAtMs: NOW - 30 * H,
      lastVerdictAtMs: NOW - 1 * H,
      queue: queue(),
      syncTallies: [{ fleet: 'drain-a', judgedBatches: 10, redBatches: 1 }],
    });
    expect(slo.metrics.timeSinceGreenMs).toBe(30 * H);
    expect(slo.metrics.timeSinceVerdictMs).toBe(1 * H);
    // Round gaps: 19h→16h = 3h, 16h→15h = 1h. Last is 1h; median of [3h, 1h] is 2h.
    expect(slo.metrics.roundCycleTime).toEqual({ lastMs: 1 * H, medianMs: 2 * H, intervals: 2 });
    // ready-to-verify with an admission no run has started: idle since that admission.
    expect(slo.metrics.queueIdleMs).toBe(3 * H);
    expect(slo.metrics.roundsToConverge).toEqual({ rounds: 3, converged: false });
    // a1 sits between rounds 1 (5) and 2 (3): fewer failures. a2 sits between 2 (3) and 3 (4): red added.
    expect(slo.metrics.redAddingAdmissions).toEqual({ count: 1, judged: 2, heads: ['a2'], attribution: 'window' });
    expect(slo.metrics.perSyncRedRate).toEqual([{ fleet: 'drain-a', judgedBatches: 10, redBatches: 1, rate: 0.1 }]);
  });

  it('idle excludes time inside a running suite: an admission whose run started is not idle', () => {
    const slo = computeGreenMainSlo({
      ...base,
      lastGreenAtMs: NOW - H,
      lastVerdictAtMs: NOW - H,
      queue: queue({ lastResumeRunStartedAtMs: NOW - 2 * H }),
    });
    expect(slo.metrics.queueIdleMs).toBe(0);
  });

  it('a red awaiting a fixer counts as idle from the newest red', () => {
    const slo = computeGreenMainSlo({
      ...base,
      lastGreenAtMs: NOW - H,
      lastVerdictAtMs: NOW - H,
      queue: queue({ phase: 'awaiting-fixer', lastAdmittedAtMs: undefined }),
    });
    expect(slo.metrics.queueIdleMs).toBe(15 * H);
  });

  it('reports unknown as null, never as zero or an empty list', () => {
    const slo = computeGreenMainSlo({ ...base, lastGreenAtMs: null, lastVerdictAtMs: null, queue: null, syncTallies: null });
    expect(slo.metrics.timeSinceGreenMs).toBeNull();
    expect(slo.metrics.timeSinceVerdictMs).toBeNull();
    expect(slo.metrics.queueIdleMs).toBeNull();
    expect(slo.metrics.roundsToConverge).toBeNull();
    expect(slo.metrics.redAddingAdmissions).toBeNull();
    expect(slo.metrics.perSyncRedRate).toBeNull();
    expect(slo.breaches).toEqual([]);
  });

  it('a fleet with no judged batches has a null rate, not 0%', () => {
    const slo = computeGreenMainSlo({
      ...base,
      lastGreenAtMs: NOW,
      lastVerdictAtMs: NOW,
      queue: null,
      syncTallies: [{ fleet: null, judgedBatches: 0, redBatches: 0 }],
    });
    expect(slo.metrics.perSyncRedRate?.[0].rate).toBeNull();
  });
});

describe('computeGreenMainSlo — recurring non-verdict reasons (P-029)', () => {
  it('preserves independent reason counts and alarms only at the daily threshold', () => {
    const nonVerdictReasons = {
      windowHours: 24 as const,
      sinceMs: NOW - 24 * H,
      measuredAtMs: NOW,
      reasons: [
        { reason: 'skipped-joined-attempt', count: 6, latestAtMs: NOW - H },
        { reason: 'skipped-memory-budget', count: 5, latestAtMs: NOW - H },
      ],
    };
    const slo = computeGreenMainSlo({ ...base, lastGreenAtMs: NOW, lastVerdictAtMs: NOW, queue: null, nonVerdictReasons });
    expect(slo.metrics.nonVerdictReasons).toEqual(nonVerdictReasons);
    expect(slo.breaches).toEqual([expect.objectContaining({
      metric: 'non-verdict-reason', subject: 'skipped-joined-attempt', value: 6, threshold: 6,
    })]);
  });

  it('keeps an unreadable ledger distinct from a measured empty population', () => {
    const input = { ...base, lastGreenAtMs: NOW, lastVerdictAtMs: NOW, queue: null };
    expect(computeGreenMainSlo(input).metrics.nonVerdictReasons).toBeNull();
    expect(computeGreenMainSlo({ ...input, nonVerdictReasons: {
      windowHours: 24, sinceMs: NOW - 24 * H, measuredAtMs: NOW, reasons: [],
    } }).metrics.nonVerdictReasons?.reasons).toEqual([]);
  });
});

describe('computeGreenMainSlo — owner pages (AUTO-BAR-R-14)', () => {
  const pages = (lastGreenAtMs: number | null, lastVerdictAtMs: number | null) =>
    computeGreenMainSlo({ ...base, lastGreenAtMs, lastVerdictAtMs, queue: null }).breaches.filter((b) => b.severity === 'page');

  it('pages the owner once main has been red for 12 hours', () => {
    const [page] = pages(NOW - 12 * H, NOW - H);
    expect(page.metric).toBe('time-since-green');
    expect(page.episodeKey).toBe(`green-main-slo:papercusp:time-since-green:${NOW - 12 * H}`);
  });

  it('does not page at 11h59m red', () => {
    expect(pages(NOW - 12 * H + 60_000, NOW - H)).toEqual([]);
  });

  it('pages after 6 hours with no verdict of any kind', () => {
    const [page] = pages(NOW - H, NOW - 6 * H);
    expect(page.metric).toBe('time-since-verdict');
    expect(page.episodeKey).toBe(`green-main-slo:papercusp:time-since-verdict:${NOW - 6 * H}`);
  });

  it('does not page at 5h59m without a verdict, or on a gate that never rendered one', () => {
    expect(pages(NOW - H, NOW - 6 * H + 60_000)).toEqual([]);
    expect(pages(null, null)).toEqual([]);
  });

  it('keeps one episode key for the whole red episode, and a new key after a new green', () => {
    const lastGreen = NOW - 13 * H;
    const at12 = computeGreenMainSlo({ ...base, nowMs: lastGreen + 12 * H, lastGreenAtMs: lastGreen, lastVerdictAtMs: null, queue: null });
    const at40 = computeGreenMainSlo({ ...base, nowMs: lastGreen + 40 * H, lastGreenAtMs: lastGreen, lastVerdictAtMs: null, queue: null });
    expect(at40.breaches[0].episodeKey).toBe(at12.breaches[0].episodeKey);
    const nextEpisode = computeGreenMainSlo({ ...base, nowMs: NOW + 20 * H, lastGreenAtMs: NOW, lastVerdictAtMs: null, queue: null });
    expect(nextEpisode.breaches[0].episodeKey).not.toBe(at12.breaches[0].episodeKey);
  });

  it('pages on both limbs at once when main is red and the gate is also silent', () => {
    expect(pages(NOW - 13 * H, NOW - 7 * H).map((p) => p.metric)).toEqual(['time-since-green', 'time-since-verdict']);
  });
});

describe('computeGreenMainSlo — alerts on breach (AUTO-BAR-R-13)', () => {
  const alerts = (input: Parameters<typeof computeGreenMainSlo>[0]) =>
    computeGreenMainSlo(input).breaches.filter((b) => b.severity === 'alert').map((b) => b.metric);

  it('alerts on a slow round, an idle queue, a red-adding admission and a red-heavy fleet', () => {
    const q = queue({
      convergenceRounds: [
        { round: 1, head: 'h1', failingCount: 3, atMs: NOW - 10 * H },
        { round: 2, head: 'h2', failingCount: 6, atMs: NOW - 5 * H },
      ],
      admissions: [{ atMs: NOW - 8 * H, actor: 'su-a', source: { ref: 'staging', sha: 's' }, fromRepairHead: 'h1', toRepairHead: 'a9', paths: [], unchanged: [], blobs: {} }],
    });
    const result = computeGreenMainSlo({ ...base, lastGreenAtMs: NOW - H, lastVerdictAtMs: NOW - H, queue: q,
      syncTallies: [{ fleet: 'f', judgedBatches: 10, redBatches: 3 }] });
    expect(result.breaches.filter(b => b.severity === 'alert').map(b => b.metric)).toEqual(
      ['round-cycle-time', 'queue-idle', 'red-adding-admission', 'per-sync-red-rate']);
    const admission = result.breaches.find(b => b.metric === 'red-adding-admission');
    expect(admission?.title).toBe('A round after admission recorded more failures on papercusp');
    expect(admission?.detail).toMatch(/association, not that the admission caused the increase/);
  });

  it('raises nothing when every metric is inside its target', () => {
    const q = queue({
      convergenceRounds: [
        { round: 1, head: 'h1', failingCount: 3, atMs: NOW - 2 * H },
        { round: 2, head: 'h2', failingCount: 1, atMs: NOW - 1 * H },
      ],
      admissions: [],
      lastAdmittedAtMs: NOW - 30 * 60_000,
    });
    expect(
      alerts({ ...base, lastGreenAtMs: NOW - H, lastVerdictAtMs: NOW - H, queue: q, syncTallies: [{ fleet: 'f', judgedBatches: 10, redBatches: 2 }] }),
    ).toEqual([]);
  });

  it('does not call a red rate over too few batches a breach', () => {
    expect(
      alerts({ ...base, lastGreenAtMs: NOW, lastVerdictAtMs: NOW, queue: null, syncTallies: [{ fleet: 'f', judgedBatches: GREEN_MAIN_SLO_DEFAULTS.perSyncRedMinBatches - 1, redBatches: 4 }] }),
    ).toEqual([]);
  });
});
