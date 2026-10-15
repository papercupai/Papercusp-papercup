/**
 * get-feedback-core.bar-critique.test.ts — SPEC-P-007-CRITIQUE-REF at the UNIT layer.
 *
 * plans:start counts a plan's bar-critiques by consult_state.origin_task_ref =
 * plan slug, so a bar-critique opened without an explicit origin ref could never
 * count. getFeedbackCore must refuse it with `bar_critique_requires_plan` BEFORE
 * it routes, opens, or writes anything. The integration suite
 * (get-feedback-core.integration.test.ts) proves no consult row lands in real
 * Postgres; this file pins the same guard on the real function with every
 * collaborator wired to fail loudly if touched, plus controls showing the guard
 * is specific to the bar-critique policy and to a missing/blank ref.
 */
import { describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { getFeedbackCore, type GetFeedbackDeps, type GetFeedbackRequest } from './get-feedback-core';
import { BAR_CRITIQUE_POLICY } from './selection-policies';

const TOUCHED = 'COLLABORATOR_TOUCHED';

function trippedDeps() {
  const touched: string[] = [];
  const sql = ((..._args: unknown[]) => {
    touched.push('sql');
    throw new Error(TOUCHED);
  }) as unknown as Sql;
  const deps = {
    getSql: () => sql,
    route: async () => {
      touched.push('route');
      throw new Error(TOUCHED);
    },
    open: async () => {
      touched.push('open');
      throw new Error(TOUCHED);
    },
  } as unknown as GetFeedbackDeps;
  return { deps, touched };
}

function request(extra: Partial<GetFeedbackRequest>): GetFeedbackRequest {
  return {
    workspaceId: 'ws-unit',
    requesterId: 'su-requester',
    question: 'Are these acceptance bars falsifiable?',
    ...extra,
  } as GetFeedbackRequest;
}

async function settle(p: Promise<unknown>): Promise<{ value?: unknown; thrown?: string }> {
  try {
    return { value: await p };
  } catch (e) {
    return { thrown: String(e) };
  }
}

describe('getFeedbackCore bar-critique origin guard (SPEC-P-007-CRITIQUE-REF, unit)', () => {
  const missing: Array<[string, Partial<GetFeedbackRequest>]> = [
    ['omitted', {}],
    ['null', { originTaskRef: null }],
    ['blank', { originTaskRef: '' }],
    ['whitespace-only', { originTaskRef: '   ' }],
  ];

  for (const [label, extra] of missing) {
    it(`SPEC-P-007-CRITIQUE-REF: refuses a bar-critique whose origin ref is ${label}, touching no collaborator`, async () => {
      const { deps, touched } = trippedDeps();
      const out = await settle(getFeedbackCore(request({ policy: BAR_CRITIQUE_POLICY, ...extra } as Partial<GetFeedbackRequest>), deps));
      expect(out.thrown).toBeUndefined();
      expect(out.value).toMatchObject({ error: 'bar_critique_requires_plan' });
      expect((out.value as { hint?: string }).hint).toContain('origin_task_ref');
      expect(touched).toEqual([]);
    });
  }

  it('SPEC-P-007-CRITIQUE-REF control: a bar-critique WITH a plan slug passes the guard', async () => {
    const { deps } = trippedDeps();
    const out = await settle(
      getFeedbackCore(request({ policy: BAR_CRITIQUE_POLICY, originTaskRef: 'some-plan-2026-10-10' } as Partial<GetFeedbackRequest>), deps),
    );
    expect((out.value as { error?: string } | undefined)?.error).not.toBe('bar_critique_requires_plan');
  });

  it('SPEC-P-007-CRITIQUE-REF control: a non-bar-critique consult without an origin ref is not refused by this guard', async () => {
    const { deps } = trippedDeps();
    const out = await settle(getFeedbackCore(request({}), deps));
    expect((out.value as { error?: string } | undefined)?.error).not.toBe('bar_critique_requires_plan');
  });
});
