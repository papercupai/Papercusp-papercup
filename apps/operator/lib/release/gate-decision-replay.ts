/** P-014: replay the real pure decision seams; this module never performs IO/actuation. */
import {
  captureGateDecisionReplay, checkGateSuiteVerdictReplay, gateDecisionSignature,
  gateReplayCanonical, acceptedGateReplayTransition,
  decideGateSuite, gateActionBlocks, gateVerdictAppliesToHead,
  type GateDecisionReplay, type GateSuiteVerdictReplay, type GateReplayBaselineTransition,
} from '@papercusp/operator-core/lib/release/gate-hygiene-split';
import { evaluatePerfSignals } from '@papercusp/operator-core/lib/system-health/perf-budgets';
import { assessFrozenLineagePromotion } from '@papercusp/operator-core/lib/release/frozen-lineage-promotion';
import {
  decideFrozenCandidateRepairQueue, decideFrozenConvergenceCycleEntry,
  markFrozenCandidateVerificationRed, markFrozenRepairVerificationRed,
  markFrozenRepairVerificationGreen, recordFrozenRepairSupersededRed,
} from '@papercusp/operator-core/lib/release/frozen-candidate-repair-queue';
import { evaluatePerfGate } from './perf-gate';
import { evaluateDesktopPerfGate } from './desktop-perf-gate';
import { evaluateDeltaGate } from './delta-gate';
import { evaluateCupboardHygieneGate, evaluateCupboardHygieneScan } from './cupboard-hygiene-gate';
import { decideReadyAdvance } from './git-ops';
import { interpretRepairHeadMeasurements, classifyRedAgainstTip, desktopPerfDetectorAbsent } from './green-checkpoint';

const evaluators = {
  'host-perf': (signals: Parameters<typeof evaluatePerfSignals>[0], now: number,
    budgets: Parameters<typeof evaluatePerfSignals>[2], policy: Parameters<typeof evaluatePerfGate>[1], candidate?: string) =>
    evaluatePerfGate(evaluatePerfSignals(signals, now, budgets), policy, candidate),
  'desktop-perf': evaluateDesktopPerfGate,
  'delta': evaluateDeltaGate,
  'cupboard-hygiene': evaluateCupboardHygieneGate,
  'cupboard-scan': evaluateCupboardHygieneScan,
  'ready-advance': decideReadyAdvance,
  'post-gate-action': gateActionBlocks,
  'frozen-verdict-head': gateVerdictAppliesToHead,
  'frozen-lineage': assessFrozenLineagePromotion,
  'frozen-queue': decideFrozenCandidateRepairQueue,
  'frozen-cycle': decideFrozenConvergenceCycleEntry,
  'frozen-candidate-red': markFrozenCandidateVerificationRed,
  'frozen-repair-red': markFrozenRepairVerificationRed,
  'frozen-repair-green': markFrozenRepairVerificationGreen,
  'frozen-superseded-red': recordFrozenRepairSupersededRed,
  'repair-measurements': interpretRepairHeadMeasurements,
  'red-against-tip': classifyRedAgainstTip,
  'desktop-detector': desktopPerfDetectorAbsent,
};

export function recordedGateDecision<A extends unknown[], R>(kind: keyof typeof evaluators,
  evaluate: (...args: A) => R, args: A, trace: GateDecisionReplay[]): R {
  // Snapshot BEFORE evaluation too: a future mutating reducer cannot rewrite its input.
  const captured = captureGateDecisionReplay(kind, args, null);
  const result = evaluate(...args);
  captured.expected = captureGateDecisionReplay(kind, [], result).expected;
  trace.push(captured);
  return result;
}

function replayDecision(entry: GateDecisionReplay): unknown {
  if (!Object.hasOwn(evaluators, entry.kind)) throw new Error(`unsupported recorded gate decision: ${entry.kind}`);
  // The tag selects a pure evaluator. Malformed argument shapes throw and fail the canary closed.
  const evaluate = evaluators[entry.kind as keyof typeof evaluators] as (...args: unknown[]) => unknown;
  return gateDecisionSignature(evaluate(...entry.args));
}

export function checkRecordedGateVerdict(replay: GateSuiteVerdictReplay,
  transitions?: readonly GateReplayBaselineTransition[]): { ok: boolean; detail: string } {
  const suite = replay.suiteMeasured === false ? { ok: true, detail: 'no canonical suite was measured in this recorded verdict' }
    : checkGateSuiteVerdictReplay(replay);
  const current = { ...replay, expected: undefined, decisions: undefined };
  const changes: string[] = [];
  if (!suite.ok) changes.push('suite');
  const decisions = (replay.decisions ?? []).map((entry, index) => {
    const expected = replayDecision(entry);
    if (gateReplayCanonical(expected) !== gateReplayCanonical(entry.expected)) changes.push(`${index}:${entry.kind}`);
    return { ...entry, expected };
  });
  if (changes.length === 0) return { ok: true, detail: `${suite.detail}; ${decisions.length} downstream decisions reproduced${replay.decisions === undefined ? ' (legacy capture; next measurement adds downstream observations)' : ''}` };
  // A transition must cover this exact measurement, including unchanged inputs and every decision.
  const accepted = { ...current, expected: replay.suiteMeasured === false ? replay.expected : decideGateSuite(replay.input).signature, decisions };
  const transition = acceptedGateReplayTransition(replay, accepted, transitions);
  return transition ? { ok: true, detail: `intentional gate baseline transition ${transition}; changed ${changes.join(', ')}` }
    : { ok: false, detail: `recorded gate verdict changed for ${replay.candidate}: ${changes.join(', ')}` };
}

