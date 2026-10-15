/**
 * P-006 (plan goal-grading-live-coverage-and-holder-followthrough-2026-10-08):
 * coord:ask-owner from a goal lineage supersedes the caller's own overlapping
 * open ask, joins a goal peer's overlapping open ask, and leaves distinct
 * questions alone.
 */
import { describe, expect, it, vi } from 'vitest';
import { askArgs, askOp } from './coord-ops/ops/compose.js';
import { makeCtx, makeFakeCaps, type FakeCapsConfig } from './coord-ops/test-support.js';
import { pickOverlappingGoalAsk, type GoalAskCandidate } from './coord-ops/goal-ask-dedup.js';

const GOAL = 'work-on-everything-fresh-grading-and-improvement-60d3a8';

// The two owner asks goal 60d3a8 actually had open on 2026-10-08 (different askers,
// different decisions) — a dedup that merged these would be wrong.
const LIVE_DISTINCT: GoalAskCandidate[] = [
  {
    conversationId: 'conv-cupboard',
    askerId: 'su-dd32',
    goalId: GOAL,
    title:
      'Cupboard content-trust plan: 3 of 6 acceptance bars (R-1 digest-pinned installs, R-3 server-side verification, R-4 drift detection) can only be proven against t',
  },
  {
    conversationId: 'conv-cache',
    askerId: 'su-8d81',
    goalId: GOAL,
    title:
      'Cache-efficiency plan (cache-efficiency-and-accounting-2026-09-23): the critical path P-005 -> P-009 -> P-010 is stopped on one decision only you can make (plan',
  },
];

describe('pickOverlappingGoalAsk', () => {
  it('keeps distinct questions from one goal apart', () => {
    expect(
      pickOverlappingGoalAsk({
        question: 'Should the drain fleet resume on goal 60d3a8 now that grading coverage shipped?',
        callerId: 'su-me',
        candidates: LIVE_DISTINCT,
      }),
    ).toBeNull();
  });

  it('matches a rephrased repeat of an open ask and says whose it is', () => {
    const overlap = pickOverlappingGoalAsk({
      question:
        'Cupboard content-trust plan: acceptance bars R-1 digest-pinned installs, R-3 server-side verification and R-4 drift detection can only be proven against the live registry',
      callerId: 'su-me',
      candidates: LIVE_DISTINCT,
    });
    expect(overlap).toMatchObject({ conversationId: 'conv-cupboard', askerId: 'su-dd32', sameAsker: false, goalId: GOAL });
    expect(overlap!.similarity).toBeGreaterThanOrEqual(0.5);
  });

  it('prefers the strongest overlap and flags the caller’s own ask', () => {
    const overlap = pickOverlappingGoalAsk({
      question: 'Approve raising maxAgents for goal 60d3a8 to eight',
      callerId: 'su-me',
      candidates: [
        { conversationId: 'conv-weak', askerId: 'su-peer', goalId: GOAL, title: 'Approve raising maxAgents for goal 60d3a8 budget' },
        { conversationId: 'conv-mine', askerId: 'su-me', goalId: GOAL, title: 'Approve raising maxAgents for goal 60d3a8 to eight?' },
      ],
    });
    expect(overlap).toMatchObject({ conversationId: 'conv-mine', sameAsker: true, similarity: 1 });
  });
});

describe('coord:ask-owner goal-lineage dedup', () => {
  const question = 'Approve raising maxAgents for goal 60d3a8 to eight?';
  const args = () => askArgs.parse({ question, timeout_s: 0 });

  function setup(goalAsk?: FakeCapsConfig['goalAsk']) {
    const fake = makeFakeCaps({ goalAsk });
    const ctx = makeCtx(fake.caps);
    return { ...fake, ctx, me: ctx.identity.ownerId };
  }

  it('opens normally (no supersede) when the caller belongs to no goal', async () => {
    const { calls, ctx } = setup();
    const r = await askOp.run(args(), ctx);
    expect(calls.openThread).toHaveLength(1);
    expect(calls.openThread[0]!.supersedes_conversation_id).toBeUndefined();
    expect(r.goal_ask_dedup).toEqual({ status: 'not-in-goal' });
  });

  it('opens normally when the goal has no overlapping open ask', async () => {
    const { calls, ctx } = setup(() => ({ goalId: GOAL, compared: 2, overlap: null }));
    const r = await askOp.run(args(), ctx);
    expect(calls.openThread).toHaveLength(1);
    expect(calls.openThread[0]!.supersedes_conversation_id).toBeUndefined();
    expect(r.goal_ask_dedup).toEqual({ status: 'no-overlap', goalId: GOAL, compared: 2 });
  });

  it('supersedes the caller’s OWN overlapping open ask instead of opening a duplicate', async () => {
    let me = '';
    const { calls, ctx, me: owner } = setup(() => ({
      goalId: GOAL,
      compared: 1,
      overlap: { goalId: GOAL, conversationId: 'conv-old', askerId: me, similarity: 0.9, sameAsker: true },
    }));
    me = owner;
    const r = await askOp.run(args(), ctx);
    expect(calls.openThread).toHaveLength(1);
    expect(calls.openThread[0]!.supersedes_conversation_id).toBe('conv-old');
    expect(r.goal_ask_dedup).toMatchObject({ status: 'superseded', conversationId: 'conv-old', goalId: GOAL });
  });

  it('JOINS a goal peer’s overlapping open ask: no new thread, no new escalation, waits on the existing gate', async () => {
    const { calls, ctx } = setup(() => ({
      goalId: GOAL,
      compared: 1,
      overlap: { goalId: GOAL, conversationId: 'conv-peer', askerId: 'su-peer', similarity: 0.8, sameAsker: false },
    }));
    const r = await askOp.run(args(), ctx);
    expect(calls.openThread).toHaveLength(0);
    expect(calls.escalate).toHaveLength(0);
    expect(calls.readAnswer).toEqual([{ conversationId: 'conv-peer', askerId: 'su-peer' }]);
    expect(r.conversation_id).toBe('conv-peer');
    expect(r.goal_ask_dedup).toMatchObject({ status: 'joined', askerId: 'su-peer', conversationId: 'conv-peer' });
  });

  it('never runs the dedup read when the caller names an explicit supersede', async () => {
    const goalAsk = vi.fn(() => ({ goalId: GOAL, compared: 0, overlap: null }));
    const { calls, ctx } = setup(goalAsk);
    const r = await askOp.run(askArgs.parse({ question, timeout_s: 0, supersedes_conversation_id: 'conv-x' }), ctx);
    expect(goalAsk).not.toHaveBeenCalled();
    expect(calls.openThread[0]!.supersedes_conversation_id).toBe('conv-x');
    expect(r.goal_ask_dedup).toEqual({ status: 'explicit-supersede' });
  });

  it('reports a failed dedup read as unmeasured and still opens the ask', async () => {
    const { calls, ctx } = setup(() => {
      throw new Error('pg down');
    });
    const r = await askOp.run(args(), ctx);
    expect(calls.openThread).toHaveLength(1);
    expect(r.goal_ask_dedup).toEqual({ status: 'unmeasured', error: 'pg down' });
  });

  it('falls back to a fresh ask when the auto-supersede target closed in between', async () => {
    let me = '';
    const fake = setup(() => ({
      goalId: GOAL,
      compared: 1,
      overlap: { goalId: GOAL, conversationId: 'conv-answered', askerId: me, similarity: 1, sameAsker: true },
    }));
    me = fake.me;
    const opened: Array<string | undefined> = [];
    fake.caps.openThread = async (input) => {
      opened.push(input.supersedes_conversation_id);
      if (input.supersedes_conversation_id) throw new Error('cannot supersede conv-answered (already_terminal)');
      return { thread_id: 'thr-new', conversation_id: 'conv-new' };
    };
    const r = await askOp.run(args(), fake.ctx);
    expect(opened).toEqual(['conv-answered', undefined]);
    expect(r.conversation_id).toBe('conv-new');
    expect(r.goal_ask_dedup).toMatchObject({ status: 'unmeasured' });
    expect(r.goal_ask_dedup!.error).toContain('already_terminal');
  });
});
