import { describe, expect, it } from 'vitest';
import type { Trial } from '../../test/_paired-operation-benchmark';
import { P013_DISPATCH_STEPS, attributeDispatchSteps, type WarmDispatchStepRow } from './operation-performance-driver';

// D-047: the attribution must credit each warm sample's steps to the trial that ran it.
// A misaligned split would put one arm's step costs on the other and point a fix at the
// wrong code, so misalignment must throw rather than average out.
function trial(arm: Trial['arm'], mode: Trial['mode'], concurrency: 1 | 8, repetition: number, samples: number): Trial {
  const dist = { count: samples, p50: 0, p95: 0, p99: 0 };
  return {
    arm, mode, concurrency, repetition, samples, wallMs: 0, throughputPerSec: 0,
    phasesMs: { ingressToAccepted: dist, acceptedToDispatch: dist, dispatchToTerminal: dist,
      terminalToBusinessEvent: dist, total: dist },
    persistence: { dbRoundTrips: null, dbBytes: null, durableSteps: null },
  };
}
const control = (claim: number): WarmDispatchStepRow => ({ arm: 'control', steps: { admissionSettle: 1, claim } });
const candidate = (eventsRead: number): WarmDispatchStepRow => ({
  arm: 'candidate', steps: { eventsRead, pinRead: 2, launchInserts: 3, admissionSettle: 1, claim: 5 },
});

describe('P-013 workload A dispatch-step attribution (D-047)', () => {
  it('splits rows into warm trials in execution order, skipping cold trials, per arm', () => {
    const trials = [
      trial('control', 'warm', 1, 0, 2), trial('candidate', 'warm', 1, 0, 2),
      trial('control', 'cold', 1, 0, 50), trial('candidate', 'cold', 1, 0, 50),
      trial('candidate', 'warm', 8, 1, 3), trial('control', 'warm', 8, 1, 1),
    ];
    const rows = [control(10), control(20), candidate(7), candidate(9),
      candidate(100), candidate(200), candidate(300), control(40)];
    const out = attributeDispatchSteps(trials, rows);
    expect(out.map((row) => `${row.arm}@c${row.concurrency}r${row.repetition}x${row.samples}`))
      .toEqual(['control@c1r0x2', 'candidate@c1r0x2', 'candidate@c8r1x3', 'control@c8r1x1']);
    // Control runs only the two shared steps; the candidate-only steps are absent, not zero.
    expect(Object.keys(out[0]!.stepsMs)).toEqual(['admissionSettle', 'claim']);
    expect(Object.keys(out[1]!.stepsMs)).toEqual([...P013_DISPATCH_STEPS]);
    expect(out[2]!.stepsMs.eventsRead?.p50).toBe(200);
    expect(out[2]!.stepsMs.eventsRead?.p99).toBeGreaterThanOrEqual(200);
    expect(out[3]!.stepsMs.claim?.p50).toBe(40);
  });

  it('attributes D-050 interleaved (ABBA-chunked) rows to each arm of the block', () => {
    // Exactly what runPairedBenchmark produces with interleaveChunks=2 and 4 warm samples:
    // rep 0 leads with control (A B | B A), rep 1 with candidate (B A | A B); both trials of a
    // block are pushed after it ends. Before the D-050 fix this threw "(4/4 rows)" (a7, 2026-10-01).
    const trials = [
      trial('control', 'warm', 1, 0, 4), trial('candidate', 'warm', 1, 0, 4),
      trial('control', 'cold', 1, 0, 50), trial('candidate', 'cold', 1, 0, 50),
      trial('candidate', 'warm', 1, 1, 4), trial('control', 'warm', 1, 1, 4),
    ];
    const rows = [control(1), control(2), candidate(10), candidate(20), candidate(30), candidate(40), control(3), control(4),
      candidate(50), candidate(60), control(5), control(6), control(7), control(8), candidate(70), candidate(80)];
    const out = attributeDispatchSteps(trials, rows);
    expect(out.map((row) => `${row.arm}@r${row.repetition}x${row.samples}`))
      .toEqual(['control@r0x4', 'candidate@r0x4', 'candidate@r1x4', 'control@r1x4']);
    expect(out[0]!.stepsMs.claim?.p50).toBe(2);
    expect(out[1]!.stepsMs.eventsRead?.p50).toBe(20);
    expect(out[2]!.stepsMs.eventsRead?.p50).toBe(60);
    expect(out[3]!.stepsMs.claim?.p50).toBe(6);
    // Every control row lands on a control trial, never on the candidate's.
    expect(Object.keys(out[0]!.stepsMs)).toEqual(['admissionSettle', 'claim']);
    expect(Object.keys(out[2]!.stepsMs)).toEqual([...P013_DISPATCH_STEPS]);
  });

  it('refuses an interleaved block whose arm counts are off, even when the block total is right', () => {
    const trials = [trial('control', 'warm', 1, 0, 2), trial('candidate', 'warm', 1, 0, 2)];
    expect(() => attributeDispatchSteps(trials, [control(1), candidate(1), control(2), control(3)]))
      .toThrow(/do not align with the control warm trial c1 rep 0 \(3\/2 rows\)/);
  });

  it('refuses rows from the wrong arm instead of crediting them to the trial', () => {
    expect(() => attributeDispatchSteps([trial('control', 'warm', 1, 0, 2)], [control(1), candidate(1)]))
      .toThrow(/do not align with the control warm trial/);
  });

  it('refuses leftover or missing rows', () => {
    expect(() => attributeDispatchSteps([trial('control', 'warm', 1, 0, 1)], [control(1), control(2)]))
      .toThrow(/belong to no warm trial/);
    expect(() => attributeDispatchSteps([trial('control', 'warm', 1, 0, 2)], [control(1)]))
      .toThrow(/1\/2 rows/);
  });

  it('refuses a step recorded for only some samples of a trial', () => {
    const partial: WarmDispatchStepRow = { arm: 'candidate', steps: { admissionSettle: 1, claim: 5 } };
    expect(() => attributeDispatchSteps([trial('candidate', 'warm', 1, 0, 2)], [candidate(1), partial]))
      .toThrow(/eventsRead missing from some candidate samples/);
  });
});
