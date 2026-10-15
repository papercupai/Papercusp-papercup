/**
 * experiment:run integration (`experiment-registry-invocation-api` P-062) — drives
 * run-core through the REAL `runGovernedReplay` → `runReplayBattery` → judge →
 * compareArms chain. Only the LLM (replay runner + judge) and the flag/governor/PG
 * boundaries are faked, so the whole wiring (arm→variant mapping, the synthetic
 * battery, the engine loop, scoring, the compareArms verdict, result normalization)
 * is exercised end-to-end at $0, deterministically.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestRegistry, type JudgeLlmCall } from '@papercusp/eval-battery';
import { runGovernedReplay, type ReplayGlueDeps } from '../replay/governed';
import type { ReplayRunner, ReplayStore } from '../replay/types';
import { _resetExperimentRegistration } from './descriptors';
import { runExperiment, type RunExperimentDeps } from './run-core';

/** A no-op cell store (avoids PgReplayStore / PG in the substrate). */
const noopStore: ReplayStore = {
  startRun: async () => {},
  finishRun: async () => {},
  recordScore: async () => {},
  markFailed: async () => {},
};

/** Flag ON + governor ALLOW + no real PG/spend ledger — so the substrate actually runs. */
const passGlue: ReplayGlueDeps = {
  enabled: async () => true,
  preflight: async () => ({ allow: true, remainingUsd: 1 }),
  getSql: async () => ({}) as never,
  reserve: async (_sql, q) => ({ ok: true, clamped: false, headroomUsd: 1,
    reservation: { id: 'res-experiment', workspaceId: q.workspaceId, loopId: q.loopId,
      potSlug: null, attemptKind: 'evaluation', requestedUsd: q.requestedUsd,
      reservedUsd: q.requestedUsd, usedUsd: 0, status: 'open', signalOrigin: 'replay',
      runRef: q.runRef ?? null, note: null, createdAt: 0, settledAt: null } }),
  settle: (async () => ({ ok: false, reason: 'not-found', reservation: null })) as ReplayGlueDeps['settle'],
  log: () => {},
};

/** A fake continuation runner — fixed small cost per cell. */
const fakeRunner: ReplayRunner = async () => ({
  outputText: 'I will implement the change and then run the tests to verify.',
  costUsd: 0.001,
  inputTokens: 10,
  outputTokens: 20,
  replayed: true,
});

/** A fake judge that rewards the candidate (its label rides in the distilled trace). */
const fakeJudge: JudgeLlmCall = async (opts) => {
  const isCandidate = opts.messages.some((m) => m.content.includes('terser'));
  return {
    json: { d1: isCandidate ? 9 : 5, d2: 7, d3: 7, rationale: isCandidate ? 'crisper' : 'baseline' },
    text: '',
    costUsd: 0.0005,
    inputTokens: 5,
    outputTokens: 5,
  };
};

const deps: RunExperimentDeps = {
  runGovernedReplay,
  replayRunner: fakeRunner,
  judge: fakeJudge,
  now: () => 0,
  glue: passGlue,
  store: noopStore,
};

describe('experiment:run end-to-end over the real replay substrate ($0)', () => {
  beforeEach(() => {
    resetTestRegistry();
    _resetExperimentRegistration();
  });

  it('scores baseline vs candidate and produces a compareArms verdict', async () => {
    const out = await runExperiment(
      {
        testId: 'replay',
        batteryId: 'it-1',
        arms: [
          { id: 'cand', label: 'terser', knobs: { 'overlay.systemOverlay': 'Be terser.' } },
          // no explicit baseline arm — run-core prepends the historical-baseline anchor
        ],
        cases: [{ caseId: 'c1', context: 'mid-task context', intent: 'finish the task' }],
        repeats: 1,
      },
      { workspaceId: 'ws' },
      deps,
    );

    expect(out.ok).toBe(true);
    const result = out.result!;
    expect(result.testId).toBe('replay');

    // Both arms ran through the real engine + real judge.
    const byId = Object.fromEntries(result.arms.map((a) => [a.id, a]));
    expect(byId.baseline?.scored).toBe(1);
    expect(byId.cand?.scored).toBe(1);

    // Real composite via DEFAULT_REPLAY_RUBRIC weights {d1:.5,d2:.3,d3:.2}:
    //   baseline d1=5,d2=7,d3=7 → 6.0 ; candidate d1=9 → 8.0.
    expect(byId.baseline?.meanScore).toBeCloseTo(6.0, 5);
    expect(byId.cand?.meanScore).toBeCloseTo(8.0, 5);

    // The compareArms verdict ran and picked the candidate (Δ2.0).
    expect(result.comparison).not.toBeNull();
    expect(result.winner).toBe('cand');

    // Real spend was summed from the fake runner + judge costs (2 arms × 1 cell).
    expect(result.totalCostUsd).toBeGreaterThan(0);
  });
});
