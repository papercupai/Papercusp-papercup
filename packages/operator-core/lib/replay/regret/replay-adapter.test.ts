/**
 * replay-adapter.test.ts — the regret ⇄ replay bridge (P-021 / FB-07 over
 * P-020 / FB-06), fully faked (runner / judge / store / glue — zero LLM/PG):
 *   - turn mapping: tool-call-order anchor (walked back over narration),
 *     text-prefix fallback, proportional last resort;
 *   - priceFinding: one governed battery per finding, improvement = candidate
 *     − baseline composite / 10, substrate refusal ⇒ null (stays pending),
 *     empty transcript ⇒ empty pricing (consumed).
 */
import { describe, expect, it, vi } from 'vitest';
import type { JudgeLlmCall } from '@papercusp/eval-battery';
import { cutTranscript, parseTranscriptJsonl } from '../transcript';
import type { ReplayRunner, ReplayStore } from '../types';
import { parseTranscript } from './transcript-core';
import type { CandidateChange } from './counterfactual-core';
import {
  DEFAULT_REGRET_REPLAY_MODEL,
  governedRegretRunner,
  mapDivergenceTurnToReplayIndex,
} from './replay-adapter';
import { LEARNING_MODEL_SPEC } from '../../learning/model-policy';

const CANDIDATE: CandidateChange = {
  id: 'stop-retry-ladder',
  title: 'Stop retrying',
  promptDelta: 'HARD RULE: after 2 consecutive failures, stop and change approach.',
  rationale: 'error loop burned the session',
  fromTurn: 1,
};

function assistantLine(id: string, text: string, tool?: { id: string; command: string }): string {
  const content: unknown[] = [{ type: 'text', text }];
  if (tool) content.push({ type: 'tool_use', id: tool.id, name: 'Bash', input: { command: tool.command } });
  return JSON.stringify({ type: 'assistant', message: { id, role: 'assistant', content, usage: { output_tokens: 100 } } });
}

function toolResultLine(toolUseId: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: true, content: [] }] },
  });
}

const STREAM = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'Fix the flaky auth test' } }),
  assistantLine('m0', 'Looking at the failing test first.', { id: 't0', command: 'run tests' }),
  toolResultLine('t0'),
  assistantLine('m1', 'Retrying the same command now.', { id: 't1', command: 'run tests' }),
  toolResultLine('t1'),
  assistantLine('m2', 'Retrying once more, same way.', { id: 't2', command: 'run tests' }),
  toolResultLine('t2'),
].join('\n');

describe('mapDivergenceTurnToReplayIndex', () => {
  it('anchors on tool-call order, walking back over the turn’s own narration', () => {
    const mine = parseTranscript(STREAM);
    const theirs = parseTranscriptJsonl(STREAM, 'fixture');
    const idx = mapDivergenceTurnToReplayIndex(mine, 1, theirs);
    const { context, continuation } = cutTranscript(theirs, idx);
    // The divergence turn's narration belongs to the CONTINUATION, not the context.
    expect(context.some((t) => t.text.includes('Retrying the same command'))).toBe(false);
    expect(continuation.some((t) => t.text.includes('Retrying the same command'))).toBe(true);
    // The prior turn's work stays in the context.
    expect(context.some((t) => t.text.includes('Looking at the failing test'))).toBe(true);
  });

  it('falls back to a text-prefix match for tool-less transcripts', () => {
    const body = [
      assistantLine('m0', 'Planning the approach quietly first.'),
      assistantLine('m1', 'A sudden very long expansion of scope begins here.'),
    ].join('\n');
    const mine = parseTranscript(body);
    const theirs = parseTranscriptJsonl(body, 'fixture');
    const idx = mapDivergenceTurnToReplayIndex(mine, 1, theirs);
    expect(theirs.turns[idx].text).toContain('sudden very long expansion');
  });

  it('clamps into cutTranscript’s valid range as a last resort', () => {
    const body = [assistantLine('m0', 'one'), assistantLine('m1', 'two')].join('\n');
    const mine = parseTranscript(body);
    const theirs = parseTranscriptJsonl(body, 'fixture');
    // Turn 0 with short text and no tools → proportional path, clamped ≥ 1.
    const idx = mapDivergenceTurnToReplayIndex(mine, 0, theirs);
    expect(idx).toBeGreaterThanOrEqual(1);
    expect(idx).toBeLessThan(theirs.turns.length);
  });
});

/** Judge fake mirroring FB-06's: candidate continuations outscore the baseline. */
const fakeJudge: JudgeLlmCall = async ({ messages }) => {
  const user = messages[0]?.content ?? '';
  const isCandidate = user.includes(`variant: ${CANDIDATE.title}`);
  const score = isCandidate ? { d1: 9, d2: 8, d3: 9 } : { d1: 4, d2: 4, d3: 5 };
  return {
    text: JSON.stringify({ ...score, rationale: isCandidate ? 'recovered' : 'thrash' }),
    costUsd: 0.01,
    inputTokens: 100,
    outputTokens: 20,
  };
};

const fakeRunner: ReplayRunner = async () => ({
  outputText: 'Stopped the retry ladder; re-read the doc; fixed the mock clock. Green.',
  costUsd: 0.05,
  inputTokens: 500,
  outputTokens: 80,
  replayed: true,
});

const noopStore: ReplayStore = {
  startRun: async () => {},
  finishRun: async () => {},
  recordScore: async () => {},
  markFailed: async () => {},
};

function makeRunner(glueOver: Record<string, unknown> = {}) {
  const recordSpend = vi.fn(async () => ({}) as never);
  const runner = governedRegretRunner({
    batteryDeps: { runner: fakeRunner, llmCall: fakeJudge, store: noopStore, now: () => 1_000 },
    glue: {
      enabled: async () => true,
      preflight: async () => ({ allow: true, remainingUsd: 5 }),
      getSql: async () => ({}) as never,
      reserve: async (_sql, q) => ({ ok: true, clamped: false, headroomUsd: 5,
        reservation: { id: 'res-regret', workspaceId: q.workspaceId, loopId: q.loopId,
          potSlug: null, attemptKind: 'evaluation', requestedUsd: q.requestedUsd,
          reservedUsd: q.requestedUsd, usedUsd: 0, status: 'open', signalOrigin: 'replay',
          runRef: q.runRef ?? null, note: null, createdAt: 0, settledAt: null } }),
      settle: recordSpend as never,
      log: () => {},
      ...glueOver,
    },
    log: () => {},
  });
  return { runner, recordSpend };
}

const priceReq = {
  workspaceId: 'ws-1',
  harnessSlug: 'papercup',
  runId: 'run-bad',
  jsonlBody: STREAM,
  divergenceTurn: 1,
  changes: [CANDIDATE],
  budgetUsd: 1,
};

describe('governedRegretRunner.priceFinding', () => {
  it('pins replay continuations to the canonical learning model', () => {
    expect(DEFAULT_REGRET_REPLAY_MODEL).toBe(LEARNING_MODEL_SPEC);
  });

  it('prices candidates vs the baseline echo: improvement = Δcomposite / 10', async () => {
    const { runner, recordSpend } = makeRunner();
    const pricing = await runner.priceFinding(priceReq);
    expect(pricing).not.toBeNull();
    expect(pricing!.scores).toHaveLength(1);
    // candidate 0.5*9+0.3*8+0.2*9 = 8.7; baseline 0.5*4+0.3*4+0.2*5 = 4.2.
    expect(pricing!.scores[0]).toMatchObject({ candidateId: 'stop-retry-ladder' });
    expect(pricing!.scores[0].improvementScore).toBeCloseTo(0.45, 5);
    expect(pricing!.costUsd).toBeGreaterThan(0);
    // The SUBSTRATE ledgers the spend (loop frontier:replay-harness) — once.
    expect(recordSpend).toHaveBeenCalledTimes(1);
  });

  it('substrate refusal (replay flag dark) ⇒ null — the finding stays pending', async () => {
    const { runner, recordSpend } = makeRunner({ enabled: async () => false });
    const pricing = await runner.priceFinding(priceReq);
    expect(pricing).toBeNull();
    expect(recordSpend).not.toHaveBeenCalled();
  });

  it('an unreplayable (empty) transcript ⇒ empty pricing, zero spend', async () => {
    const { runner } = makeRunner();
    const pricing = await runner.priceFinding({ ...priceReq, jsonlBody: '' });
    expect(pricing).toEqual({ scores: [], costUsd: 0 });
  });
});
