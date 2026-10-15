/**
 * Unit tests for the composition ops — the "run a program" surface
 * (coord:vote / coord:deliberate) + the bare ask-owner ladder rung (coord:ask),
 * all proven with DI test-double caps (no DBOS, no PG).
 * Run with: cd packages/operator-core && npx vitest run lib/coord-ops/__tests__/compose.test.ts
 */
import { describe, expect, it, vi } from 'vitest';
import type { CoordOpCaps, CoordOpCtx } from '../types';
import { voteOp, deliberateOp, askOp } from '../ops/compose';

const makeCtx = (caps: Partial<CoordOpCaps>, over: Partial<CoordOpCtx> = {}): CoordOpCtx => ({
  identity: { ownerId: 'owner-1' },
  depth: 0,
  now: () => '2026-01-01T00:00:00.000Z',
  newId: (p) => `${p}-test`,
  caps: caps as CoordOpCaps,
  ...over,
});

describe('voteOp', () => {
  it('runs the "vote" blueprint at depth+1 and maps the outcome', async () => {
    const runProgram = vi.fn().mockResolvedValue({ outcome: 'resolved', resolved: true, decision: 'A' });
    const a = voteOp.argsSchema.parse({ question: 'A or B?', options: ['A', 'B'] });
    const out = await voteOp.run(a, makeCtx({ runProgram }, { depth: 2, callerId: 'caller-1' }));
    expect(out).toEqual({ outcome: 'resolved', resolved: true, decision: 'A' });
    expect(runProgram).toHaveBeenCalledWith(
      expect.objectContaining({ blueprintId: 'vote', depth: 3, callerId: 'caller-1' }),
    );
  });

  it('falls back to the identity owner as the caller', async () => {
    const runProgram = vi.fn().mockResolvedValue({ outcome: 'x', resolved: false });
    const a = voteOp.argsSchema.parse({ question: 'q', options: ['A', 'B'] });
    await voteOp.run(a, makeCtx({ runProgram })); // no callerId
    expect(runProgram).toHaveBeenCalledWith(expect.objectContaining({ callerId: 'owner-1' }));
  });

  it('requires at least two options', () => {
    expect(() => voteOp.argsSchema.parse({ question: 'q', options: ['only-one'] })).toThrow();
  });
});

describe('deliberateOp', () => {
  it('runs the "deliberate" blueprint', async () => {
    const runProgram = vi.fn().mockResolvedValue({ outcome: 'escalated', resolved: false });
    const a = deliberateOp.argsSchema.parse({ question: 'q', options: ['A', 'B'] });
    const out = await deliberateOp.run(a, makeCtx({ runProgram }, { depth: 0 }));
    expect(out.resolved).toBe(false);
    expect(runProgram).toHaveBeenCalledWith(expect.objectContaining({ blueprintId: 'deliberate', depth: 1 }));
  });
});

describe('askOp', () => {
  const baseCaps = () => ({
    openThread: vi.fn().mockResolvedValue({ thread_id: 't1', conversation_id: 'c1' }),
    escalate: vi.fn().mockResolvedValue({ msg_id: 'e1' }),
    sleep: vi.fn().mockResolvedValue(undefined),
    // P-006: caller is in no goal lineage → the ask opens fresh (goal_ask_dedup: not-in-goal).
    findOverlappingGoalAsk: vi.fn().mockResolvedValue({ goalId: null, compared: 0, overlap: null }),
  });

  it('opens a question thread, escalates, and returns the answer when already answered', async () => {
    const caps = { ...baseCaps(), readAnswer: vi.fn().mockResolvedValue({ answered: true, answer: 'do A' }) };
    const a = askOp.argsSchema.parse({ question: 'A or B?' });
    const out = await askOp.run(a, makeCtx(caps));
    expect(out).toEqual({
      answered: true,
      answer: 'do A',
      conversation_id: 'c1',
      goal_ask_dedup: { status: 'not-in-goal' },
    });
    expect(caps.openThread).toHaveBeenCalledWith(expect.objectContaining({ kind: 'question', body: 'A or B?' }));
    expect(caps.escalate).toHaveBeenCalled();
    expect(caps.sleep).not.toHaveBeenCalled(); // answered on the first read
  });

  it('passes a superseded conversation id so a corrected owner ask remains a real gate', async () => {
    const caps = { ...baseCaps(), readAnswer: vi.fn().mockResolvedValue({ answered: false, answer: null }) };
    const a = askOp.argsSchema.parse({ question: 'the corrected question', supersedes_conversation_id: 'conv-old' });
    await askOp.run(a, makeCtx(caps));
    expect(caps.openThread).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'question',
        supersedes_conversation_id: 'conv-old',
      }),
    );
  });

  it('polls until the owner answers', async () => {
    const caps = {
      ...baseCaps(),
      readAnswer: vi
        .fn()
        .mockResolvedValueOnce({ answered: false, answer: null })
        .mockResolvedValueOnce({ answered: true, answer: 'B' }),
    };
    const a = askOp.argsSchema.parse({ question: 'q', poll_ms: 1, timeout_s: 10 });
    const out = await askOp.run(a, makeCtx(caps));
    expect(out.answered).toBe(true);
    expect(out.answer).toBe('B');
    expect(caps.sleep).toHaveBeenCalledTimes(1);
  });

  it('returns answered=false after the bounded wait', async () => {
    const caps = { ...baseCaps(), readAnswer: vi.fn().mockResolvedValue({ answered: false, answer: null }) };
    const a = askOp.argsSchema.parse({ question: 'q', poll_ms: 1, timeout_s: 0.005 }); // maxPolls = ceil(5/1) = 5
    const out = await askOp.run(a, makeCtx(caps));
    expect(out.answered).toBe(false);
    expect(caps.sleep).toHaveBeenCalledTimes(5);
  });

  it('EI-18682693723293580: timeout_s=0 returns immediately with zero polls (the code:run-safe default)', async () => {
    // The agent-facing coord:ask-owner TOOL defaults timeout_s to 0 precisely so a
    // caller inside code:run (foreground, ~55s hard cap) never blocks past its own
    // budget. Pin the mechanism here at the op level: timeout_s=0 must skip the poll
    // loop ENTIRELY (not "one 2s poll" — the old `Math.max(1, …)` floor forced that
    // even at timeout_s=0, defeating the whole point of a non-blocking default).
    const caps = { ...baseCaps(), readAnswer: vi.fn().mockResolvedValue({ answered: false, answer: null }) };
    const a = askOp.argsSchema.parse({ question: 'q', timeout_s: 0 });
    const out = await askOp.run(a, makeCtx(caps));
    expect(out).toEqual({
      answered: false,
      answer: null,
      conversation_id: 'c1',
      goal_ask_dedup: { status: 'not-in-goal' },
    });
    expect(caps.sleep).not.toHaveBeenCalled();
    expect(caps.readAnswer).toHaveBeenCalledTimes(1);
  });

  it('swallows an escalate failure (the thread is the durable ask surface)', async () => {
    const caps = {
      ...baseCaps(),
      escalate: vi.fn().mockRejectedValue(new Error('inbox down')),
      readAnswer: vi.fn().mockResolvedValue({ answered: true, answer: 'ok' }),
    };
    const a = askOp.argsSchema.parse({ question: 'q' });
    await expect(askOp.run(a, makeCtx(caps))).resolves.toMatchObject({ answered: true });
  });
});
