/**
 * mine.test.ts — the regret-mining tick, fully hermetic (injected deps, no
 * PG / no flags / no LLM — the FB-04 layering; gates live in the action).
 * Pins: select→detect→persist flow, known-run skip, transcript-less skip,
 * the dormant replay leg (runner null), the fake-runner replay+score path,
 * filing origin='replay' (D-002) with the minFileScore bar, and mine-only
 * mode (maxFilePerTick 0).
 */
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAX_FILE_PER_TICK, runRegretTick, type RegretTickDeps } from './mine';
import type { SelectionInputRow } from './selection-core';
import type { RegretFindingRecord } from './store';
import type { CandidateReplayScore, RegretCounterfactualRunner } from './counterfactual-core';

const WS = 'ws-1';

function selectionRow(over: Partial<SelectionInputRow> = {}): SelectionInputRow {
  return {
    runId: 'run-bad',
    harnessSlug: 'papercup',
    role: 'worker',
    // failed + rc124 = badness 0.45 — clears the default 0.35 selection bar.
    status: 'failed',
    exitCode: 124,
    durationMs: 60_000,
    startedAt: '2026-06-10T00:00:00.000Z',
    costUsd: null,
    outputTokens: null,
    transcriptBytes: 1000,
    featureAttempts: null,
    ...over,
  };
}

/** A claude-stream body with a clean error loop (3 consecutive Bash failures). */
function errorLoopBody(): string {
  const lines: string[] = [];
  for (let i = 0; i < 3; i++) {
    lines.push(
      JSON.stringify({
        type: 'assistant',
        message: {
          id: `m${i}`,
          role: 'assistant',
          content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `c${i}` } }],
          usage: { output_tokens: 100 },
        },
      }),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, is_error: true }] },
      }),
    );
  }
  return lines.join('\n');
}

function fakeDeps(over: Partial<RegretTickDeps> = {}) {
  const upserted: RegretFindingRecord[] = [];
  const scored: Array<{ runId: string; scores: CandidateReplayScore[] }> = [];
  const filedMarks: Array<{ runId: string; improvementId: string }> = [];
  const capture = vi.fn(async () => ({
    created: true,
    issue: { id: 'EI-900' },
    possibleDuplicates: [],
  }));
  const deps: RegretTickDeps = {
    readRows: async () => [selectionRow()],
    readTranscript: async () => errorLoopBody(),
    listKnownRunIds: async () => new Set<string>(),
    upsertFinding: async (f) => {
      upserted.push(f);
    },
    readPendingReplay: async () => [],
    recordReplayScores: async (_ws, runId, scores) => {
      scored.push({ runId, scores });
    },
    readUnfiledReplayed: async () => [],
    capture: capture as never,
    markFiled: async (_ws, runId, improvementId) => {
      filedMarks.push({ runId, improvementId });
    },
    replayRunner: null,
    nowIso: () => '2026-06-12T12:00:00.000Z',
    log: () => {},
    ...over,
  };
  return { deps, upserted, scored, filedMarks, capture };
}

function replayedFinding(over: Partial<RegretFindingRecord> = {}): RegretFindingRecord {
  return {
    workspaceId: WS,
    runId: 'run-bad',
    harnessSlug: 'papercup',
    role: 'worker',
    badnessScore: 0.45,
    badnessReasons: ['status-failed'],
    divergenceTurn: 0,
    divergenceKind: 'error-loop',
    divergenceEvidence: { runLength: 3 },
    candidateChanges: [
      { id: 'stop-retry-ladder', title: 'Stop retrying', promptDelta: 'HARD RULE: stop.', rationale: 'r', fromTurn: 0 },
    ],
    replayStatus: 'replayed',
    replayScores: [{ candidateId: 'stop-retry-ladder', improvementScore: 0.8, summary: 'recovered', costUsd: 0.1 }],
    reportImprovementId: null,
    minedAt: '2026-06-12T11:00:00.000Z',
    ...over,
  };
}

describe('runRegretTick — detect leg', () => {
  it('mines a fresh bad session: divergence + candidates persisted as pending', async () => {
    const { deps, upserted } = fakeDeps();
    const result = await runRegretTick(WS, deps);
    expect(result.mined).toBe(1);
    expect(upserted).toHaveLength(1);
    expect(upserted[0]).toMatchObject({
      runId: 'run-bad',
      divergenceKind: 'error-loop',
      divergenceTurn: 0,
      replayStatus: 'pending',
      reportImprovementId: null,
    });
    expect(upserted[0].candidateChanges.length).toBeGreaterThan(0);
    expect(upserted[0].minedAt).toBe('2026-06-12T12:00:00.000Z');
  });

  it('skips already-mined runs (idempotent re-tick)', async () => {
    const { deps, upserted } = fakeDeps({ listKnownRunIds: async () => new Set(['run-bad']) });
    const result = await runRegretTick(WS, deps);
    expect(result.mined).toBe(0);
    expect(result.skippedKnown).toBe(1);
    expect(upserted).toHaveLength(0);
  });

  it('a transcript-less session persists as skipped (selection evidence still lands)', async () => {
    const { deps, upserted } = fakeDeps({ readTranscript: async () => null });
    await runRegretTick(WS, deps);
    expect(upserted[0]).toMatchObject({ replayStatus: 'skipped', divergenceKind: null, candidateChanges: [] });
  });

  it('a per-session failure never aborts the tick', async () => {
    const { deps, upserted } = fakeDeps({
      readRows: async () => [selectionRow({ runId: 'boom' }), selectionRow({ runId: 'ok' })],
      readTranscript: async (runId) => {
        if (runId === 'boom') throw new Error('pg hiccup');
        return errorLoopBody();
      },
    });
    const result = await runRegretTick(WS, deps);
    expect(result.mined).toBe(1);
    expect(upserted.map((f) => f.runId)).toEqual(['ok']);
  });
});

describe('runRegretTick — replay leg', () => {
  it('stays dormant with no runner wired (pre-frontier:replay-landed)', async () => {
    const { deps, scored } = fakeDeps({
      readPendingReplay: async () => [replayedFinding({ replayStatus: 'pending', replayScores: null })],
    });
    const result = await runRegretTick(WS, deps, { replayBudgetUsd: 5 });
    expect(result.replayed).toBe(0);
    expect(scored).toHaveLength(0);
  });

  it('prices pending findings through the runner under the per-cycle budget', async () => {
    const requests: Array<{ budgetUsd: number; divergenceTurn: number; jsonlBody: string }> = [];
    const runner: RegretCounterfactualRunner = {
      priceFinding: async (req) => {
        requests.push({ budgetUsd: req.budgetUsd, divergenceTurn: req.divergenceTurn, jsonlBody: req.jsonlBody });
        expect(req).toMatchObject({ workspaceId: WS, runId: 'run-bad' });
        expect(req.changes).toHaveLength(1);
        return {
          scores: [{ candidateId: 'stop-retry-ladder', improvementScore: 0.7, summary: 'better', costUsd: 0.2 }],
          costUsd: 0.25,
        };
      },
    };
    const { deps, scored } = fakeDeps({
      replayRunner: runner,
      readPendingReplay: async () => [replayedFinding({ replayStatus: 'pending', replayScores: null })],
    });
    const result = await runRegretTick(WS, deps, { replayBudgetUsd: 2 });
    expect(result.replayed).toBe(1);
    expect(result.replayCostUsd).toBeCloseTo(0.25);
    expect(scored[0].scores[0]).toMatchObject({ candidateId: 'stop-retry-ladder', improvementScore: 0.7 });
    expect(requests[0].budgetUsd).toBeCloseTo(2); // one pending finding → whole budget
    expect(requests[0].divergenceTurn).toBe(0);
    expect(requests[0].jsonlBody.length).toBeGreaterThan(0); // transcript re-read for the case
  });

  it('a substrate refusal (null pricing) leaves the finding pending', async () => {
    const runner: RegretCounterfactualRunner = { priceFinding: async () => null };
    const { deps, scored } = fakeDeps({
      replayRunner: runner,
      readPendingReplay: async () => [replayedFinding({ replayStatus: 'pending', replayScores: null })],
    });
    const result = await runRegretTick(WS, deps, { replayBudgetUsd: 2 });
    expect(result.replayed).toBe(0);
    expect(result.replayCostUsd).toBe(0);
    expect(scored).toHaveLength(0);
  });

  it('zero budget keeps the runner idle even when wired', async () => {
    const runner: RegretCounterfactualRunner = { priceFinding: vi.fn() as never };
    const { deps } = fakeDeps({
      replayRunner: runner,
      readPendingReplay: async () => [replayedFinding({ replayStatus: 'pending', replayScores: null })],
    });
    const result = await runRegretTick(WS, deps, { replayBudgetUsd: 0 });
    expect(result.replayed).toBe(0);
    expect(runner.priceFinding).not.toHaveBeenCalled();
  });
});

describe('runRegretTick — filing leg (D-002: origin=replay)', () => {
  it('files a replayed finding clearing the bar, origin=replay, and marks it filed', async () => {
    const { deps, capture, filedMarks } = fakeDeps({
      readRows: async () => [],
      readUnfiledReplayed: async () => [replayedFinding()],
    });
    const result = await runRegretTick(WS, deps);
    expect(result.filed).toEqual(['EI-900']);
    expect(capture).toHaveBeenCalledTimes(1);
    const input = (capture.mock.calls as unknown as unknown[][])[0]?.[0] as Record<string, unknown>;
    expect(input).toMatchObject({
      // No tools pinned in this fixture's evidence → the judgment-shaped
      // process counterfactual (frontier P-044 kind fidelity).
      kind: 'change',
      findingClass: 'regret:process-counterfactual',
      severity: 'minor',
      origin: 'replay', // the D-002 invariant — a regret report never reads organic
      watchdogKey: 'regret:run-bad',
      dedupScope: 'open',
      createdBy: 'system:regret-mine',
    });
    expect(String(input.title)).toContain('error-loop');
    expect(filedMarks).toEqual([{ runId: 'run-bad', improvementId: 'EI-900' }]);
  });

  it('an error-loop finding with pinned tools files the bug shape (frontier P-044 kind fidelity)', async () => {
    const { deps, capture } = fakeDeps({
      readRows: async () => [],
      readUnfiledReplayed: async () => [
        replayedFinding({ divergenceEvidence: { runLength: 3, tools: ['Bash'] } }),
      ],
    });
    const result = await runRegretTick(WS, deps);
    expect(result.filed).toEqual(['EI-900']);
    const input = (capture.mock.calls as unknown as unknown[][])[0]?.[0] as Record<string, unknown>;
    expect(input).toMatchObject({
      kind: 'bug',
      findingClass: 'regret:tool-error-loop',
      severity: 'major',
      origin: 'replay', // bug-shaped or not, a replay row never reads organic (D-002)
      watchdogKey: 'regret:run-bad',
    });
    expect(String(input.title)).toContain('Tool error loop: Bash');
    expect(String(input.body)).toContain('Correct state');
  });

  it('a best score below minFileScore never files', async () => {
    const { deps, capture } = fakeDeps({
      readRows: async () => [],
      readUnfiledReplayed: async () => [
        replayedFinding({
          // 0.05 = half a composite point — under the 0.1 default bar.
          replayScores: [{ candidateId: 'stop-retry-ladder', improvementScore: 0.05, summary: 'no help', costUsd: 0.1 }],
        }),
      ],
    });
    const result = await runRegretTick(WS, deps);
    expect(result.filed).toEqual([]);
    expect(capture).not.toHaveBeenCalled();
  });

  it('passes the filing bar to the queue read so SQL filters before LIMIT', async () => {
    const readUnfiledReplayed = vi.fn(async (_workspaceId: string, _limit: number, _minFileScore: number) => []);
    const { deps } = fakeDeps({ readRows: async () => [], readUnfiledReplayed });

    await runRegretTick(WS, deps, { minFileScore: 0.35 });

    expect(readUnfiledReplayed).toHaveBeenCalledWith(WS, DEFAULT_MAX_FILE_PER_TICK, 0.35);
  });

  it('maxFilePerTick 0 is mine-only: nothing files, nothing is even read', async () => {
    const readUnfiledReplayed = vi.fn(async () => [replayedFinding()]);
    const { deps, capture } = fakeDeps({ readRows: async () => [], readUnfiledReplayed });
    const result = await runRegretTick(WS, deps, { maxFilePerTick: 0 });
    expect(result.filed).toEqual([]);
    expect(capture).not.toHaveBeenCalled();
    expect(readUnfiledReplayed).not.toHaveBeenCalled();
  });

  it('a capture decline counts, marks nothing, and never throws', async () => {
    const { deps, filedMarks } = fakeDeps({
      readRows: async () => [],
      readUnfiledReplayed: async () => [replayedFinding()],
      capture: vi.fn(async () => ({ created: false, reason: 'likely-duplicate', possibleDuplicates: [] })) as never,
    });
    const result = await runRegretTick(WS, deps);
    expect(result.declined).toBe(1);
    expect(filedMarks).toEqual([]);
  });
});
