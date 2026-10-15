import type { ToolResult } from '@papercusp/tooldef';
import { describe, expect, it } from 'vitest';

import gradeIdeaTool, { gradeIdeaAbortCompletionReceipt, toToolResult, type GradeIdeaOutcome } from '../grade-idea';

/**
 * WI-10005670 — `blender:grade-idea` completion receipt. 5 calls in 8 days reported a bare
 * `timeout` ("handler returned but signal had aborted") although the grade had landed. The
 * resolver reads the handler's OWN returned outcome, so a late return is reported as the
 * recorded grade (or the designed refusal) instead of a retryable timeout.
 *
 * The resolver is fed the REAL `toToolResult` envelope (not a hand-built one), so a change to
 * the tool's result shape that breaks the parse fails here instead of in production.
 */

const outcome = (over: Partial<GradeIdeaOutcome> = {}): GradeIdeaOutcome =>
  ({
    applied: true,
    gradedBy: 'su-grader',
    ideaId: 'idea-1',
    idea: {
      ideaId: 'idea-1',
      lens: null,
      rail: null,
      routedRef: null,
      title: null,
      routedAt: null,
      humanGrade: 4,
      humanFeedback: null,
      gradedBy: 'su-grader',
      gradedAt: '2026-10-02T10:00:00.000Z',
      origin: null,
      createdBy: null,
      workspaceId: null,
    },
    ...over,
  }) as GradeIdeaOutcome;

const attempt = { callId: 'call-1', toolName: 'blender:grade-idea' };

describe('blender:grade-idea abort-completion receipt (WI-10005670)', () => {
  it('declares the dispatch budget so nested tools:invoke leaves room for its completion receipt', () => {
    expect(gradeIdeaTool.timeoutSec).toBe(60);
  });

  it('is declared on the tool (the dispatcher only consults a declared resolver)', () => {
    expect(gradeIdeaTool.abortCompletionReceipt).toBe(gradeIdeaAbortCompletionReceipt);
  });

  it('reports a late APPLIED grade as recorded, naming the ledger row and its stamp', () => {
    const receipt = gradeIdeaTool.abortCompletionReceipt?.({ ideaId: 'idea-1', grade: 4 }, toToolResult(outcome()), attempt);
    expect(receipt).toEqual({
      status: 'recorded',
      effectRef: 'blender-grade-idea:idea-1:2026-10-02T10:00:00.000Z',
    });
  });

  it('still records when the summary row is absent (effect identity falls back to the idea id)', () => {
    const receipt = gradeIdeaAbortCompletionReceipt({}, toToolResult(outcome({ idea: null })));
    expect(receipt).toEqual({ status: 'recorded', effectRef: 'blender-grade-idea:idea-1' });
  });

  it('reports a late designed refusal as not-recorded with its reason, never as a timeout', () => {
    for (const reason of ['owner-grade-sovereign', 'no-self-grade'] as const) {
      const receipt = gradeIdeaAbortCompletionReceipt({}, toToolResult(outcome({ applied: false, reason })));
      expect(receipt).toEqual({ status: 'not-recorded', reason });
    }
  });

  it('fails closed when the result cannot prove which idea or what verdict', () => {
    const unparseable: ToolResult = { content: [{ type: 'text', text: 'not json' }] };
    expect(gradeIdeaAbortCompletionReceipt({}, unparseable)).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['missing-idea-id'],
    });
    expect(gradeIdeaAbortCompletionReceipt({}, toToolResult(outcome({ ideaId: null })))).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['missing-idea-id'],
    });
    // applied:false with NO reason is not a stated verdict — it must not read as "nothing landed".
    const noVerdict = toToolResult(outcome({ applied: false, reason: undefined }));
    expect(gradeIdeaAbortCompletionReceipt({}, noVerdict)).toMatchObject({
      status: 'recovery-incomplete',
      failures: ['missing-applied-verdict'],
    });
  });
});
