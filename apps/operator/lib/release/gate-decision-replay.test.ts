import { describe, expect, it, vi } from 'vitest';
import { captureGateSuiteVerdictReplay, captureGateDecisionReplay, gateReplayCanonical,
  type GateSuiteVerdictReplay } from '@papercusp/operator-core/lib/release/gate-hygiene-split';
import { createFrozenCandidateQueue, markFrozenCandidateVerificationRed,
  markFrozenRepairVerificationGreen } from '@papercusp/operator-core/lib/release/frozen-candidate-repair-queue';
import { selectFrozenRepairAdmissionPaths, frozenRepairRoundExecution } from '@papercusp/operator-core/lib/release/frozen-candidate-repair-queue';
import { assessFrozenLineagePromotion } from '@papercusp/operator-core/lib/release/frozen-lineage-promotion';
import { runPerfGate } from './perf-gate';
import { runDeltaGate } from './delta-gate';
import { runDesktopPerfGate, DEFAULT_QUIET_WINDOW } from './desktop-perf-gate';
import { decideReadyAdvance } from './git-ops';
import { checkRecordedGateVerdict, recordedGateDecision } from './gate-decision-replay';
import { interpretRepairHeadMeasurements } from './green-checkpoint';

const candidate = 'a'.repeat(40);
const snapshot = (): GateSuiteVerdictReplay => captureGateSuiteVerdictReplay({
  candidate, runId: 'observed-run', measuredAtMs: 1_800_000_000_000,
}, { green: true, infraFault: false, failures: [], rootScripts: null, failingCasesByFile: null });

describe('P-014 downstream recorded verdict replay', () => {
  it('replays selective failed measurements and refuses to discharge their unresolved frontier', () => {
    const queue = createFrozenCandidateQueue({ candidate, base: null, nowMs: 100 });
    const prior = snapshot(); prior.suiteMeasured = false;
    const decision = recordedGateDecision('repair-measurements', interpretRepairHeadMeasurements, [{
      queue, fileList: [{ workspace: 'product', file: 'product.test.ts' }], gateList: [],
      fileRun: { pass: false, summary: 'measured group red' }, gateRun: undefined,
      selection: selectFrozenRepairAdmissionPaths(queue), radiusCoverageComplete: false, radiusNote: 'measured radius',
      executed: frozenRepairRoundExecution({ mode: 'targeted', fileKeys: ['product::product.test.ts'], gateIds: [], radiusMode: 'cumulative' }),
    }], prior.decisions!);
    expect(decision).toMatchObject({ kind: 'red', failingTests: expect.arrayContaining(['product.test.ts']) });
    expect(checkRecordedGateVerdict(JSON.parse(JSON.stringify(prior))).ok).toBe(true);
    prior.decisions![0]!.expected = { kind: 'green' };
    expect(checkRecordedGateVerdict(prior).ok).toBe(false);
  });
  it('replays a selective-only verdict without inventing a canonical suite measurement', () => {
    const prior = snapshot(); prior.suiteMeasured = false;
    // An irrelevant suite placeholder must not be interpreted as a real measured pass.
    prior.expected.disposition = 'red';
    prior.decisions!.push(captureGateDecisionReplay('frozen-verdict-head', ['new-head', 'old-head'], false));
    expect(checkRecordedGateVerdict(prior)).toMatchObject({ ok: true, detail: expect.stringContaining('no canonical suite') });
    prior.decisions![0]!.expected = true;
    expect(checkRecordedGateVerdict(prior).ok).toBe(false);
  });

  it('replays host perf against the measured clock without reading signals again', async () => {
    const readSignals = vi.fn(async () => null);
    const now = vi.fn(() => 1_800_000_000_000);
    const result = await runPerfGate({ enabled: true, block: true }, candidate, { readSignals, now });
    const prior = snapshot(); prior.decisions!.push(result.replay!);
    expect(checkRecordedGateVerdict(JSON.parse(JSON.stringify(prior))).ok).toBe(true);
    expect(readSignals).toHaveBeenCalledTimes(1);
    expect(now).toHaveBeenCalledTimes(1);
    result.replay!.expected = { action: 'block' };
    expect(checkRecordedGateVerdict(prior)).toMatchObject({ ok: false, detail: expect.stringContaining('host-perf') });
  });

  it('replays missing delta proof as an armed block, without IO', async () => {
    const readVerdicts = vi.fn(async () => []);
    const result = await runDeltaGate({ enabled: true, block: true, maxAgeMs: 100 }, candidate,
      { readFlagEnabled: async () => true, readVerdicts, now: () => 1000 });
    expect(result.action).toBe('block');
    const prior = snapshot(); prior.decisions!.push(result.replay!);
    expect(checkRecordedGateVerdict(prior).ok).toBe(true);
    expect(readVerdicts).toHaveBeenCalledTimes(1);
  });

  it('records a disabled desktop gate without touching its IO', async () => {
    const readLatestRun = vi.fn(async () => null);
    const result = await runDesktopPerfGate({ enabled: false, block: false, quiet: DEFAULT_QUIET_WINDOW, maxAgeMs: 1000 },
      { candidateSha: candidate, io: { readLatestRun } });
    const prior = snapshot(); prior.decisions!.push(result.replay!);
    expect(checkRecordedGateVerdict(prior).ok).toBe(true);
    expect(readLatestRun).not.toHaveBeenCalled();
  });

  it.each([
    [null, candidate, false, 'created'],
    [candidate, candidate, false, 'already-at-candidate'],
    ['b'.repeat(40), candidate, true, 'fast-forwarded'],
    ['b'.repeat(40), candidate, false, 'not-fast-forward'],
  ] as const)('replays the observed release ancestry %s -> %s', (from, to, ancestry, reason) => {
    const prior = snapshot();
    const decision = recordedGateDecision('ready-advance', decideReadyAdvance, [from, to, ancestry], prior.decisions!);
    expect(decision.reason).toBe(reason);
    expect(checkRecordedGateVerdict(prior).ok).toBe(true);
    prior.decisions![0]!.expected = { ...decision, advanced: !decision.advanced };
    expect(checkRecordedGateVerdict(prior).ok).toBe(false);
  });

  it('captures the fresh queue passed to a verdict reducer, not the pre-suite row', () => {
    const queue = createFrozenCandidateQueue({ candidate, base: '0'.repeat(40), nowMs: 100 });
    const prior = snapshot();
    const red = recordedGateDecision('frozen-candidate-red', markFrozenCandidateVerificationRed,
      [queue, { failingTests: ['b.test.ts'], nowMs: 200 }], prior.decisions!);
    recordedGateDecision('frozen-repair-green', markFrozenRepairVerificationGreen,
      [{ ...red, phase: 'ready-to-verify' }, { repairHead: red.repairHead, nowMs: 300 }], prior.decisions!);
    queue.failingTests.push('later-admission.test.ts');
    red.failingTests.push('later-red.test.ts');
    expect(checkRecordedGateVerdict(JSON.parse(JSON.stringify(prior))).ok).toBe(true);
    expect(prior.decisions![0]!.args[0]).toMatchObject({ failingTests: [] });
    prior.decisions![1]!.expected = { phase: 'awaiting-fixer' };
    expect(checkRecordedGateVerdict(prior).ok).toBe(false);
  });

  it.each([true, false, null] as const)('replays the measured frozen-lineage membership %s', measured => {
    const prior = snapshot();
    recordedGateDecision('frozen-lineage', assessFrozenLineagePromotion, [{ candidate,
      repairHead: 'b'.repeat(40), judged: 'b'.repeat(40), judgedDescendsFromCandidate: true,
      judgedOnLineageRef: measured }], prior.decisions!);
    expect(checkRecordedGateVerdict(prior).ok).toBe(true);
  });

  it('fails closed on an unsupported decision tag', () => {
    const prior = snapshot(); prior.decisions!.push({ kind: 'unknown-code', args: [], expected: true });
    expect(() => checkRecordedGateVerdict(prior)).toThrow('unsupported');
  });

  it('allows an exact intentional baseline transition and retains the previous measurement', () => {
    const accepted = snapshot();
    accepted.decisions!.push(captureGateDecisionReplay('ready-advance', [null, candidate, false],
      decideReadyAdvance(null, candidate, false)));
    const previous = JSON.parse(JSON.stringify(accepted)) as GateSuiteVerdictReplay;
    previous.decisions![0]!.expected = { advanced: false, from: null, to: candidate, reason: 'not-fast-forward' };
    expect(checkRecordedGateVerdict(previous).ok).toBe(false);
    const transition = { decisionRef: 'green-main-cycle-time-2026-10-08#D-006', reason: 'reviewed policy correction',
      previous: gateReplayCanonical(previous), accepted: gateReplayCanonical(accepted) };
    expect(checkRecordedGateVerdict(previous, [transition])).toMatchObject({ ok: true,
      detail: expect.stringContaining(transition.decisionRef) });
    expect(previous.decisions![0]!.expected).toMatchObject({ advanced: false });
    expect(checkRecordedGateVerdict({ ...previous, runId: 'another-measurement' }, [transition]).ok).toBe(false);
    expect(checkRecordedGateVerdict(previous, [{ ...transition, decisionRef: '' }]).ok).toBe(false);
    expect(checkRecordedGateVerdict(previous, [{ ...transition, accepted: transition.previous }]).ok).toBe(false);
  });
});
