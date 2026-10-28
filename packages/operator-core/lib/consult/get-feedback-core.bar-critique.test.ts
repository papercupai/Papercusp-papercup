/**
 * get-feedback-core.bar-critique.test.ts — SPEC-P-007-CRITIQUE-REF at the UNIT layer.
 *
 * plans:start counts a plan's bar-critiques by consult_state.origin_task_ref =
 * plan slug, so a bar-critique must carry an exact registered plan ref in its
 * workspace and harness. Both acceptance and getFeedbackCore refuse missing or
 * unregistered refs with `bar_critique_requires_plan` before routing or writes. The integration suite
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

type RegisteredPlan = { workspaceId: string; harnessSlug: string; planSlug: string };

function planValidationDeps(registered: RegisteredPlan[]) {
  const touched: string[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!strings.join(' ').includes('FROM harness_shared.harness_plans')) {
      touched.push('sql-other');
      return Promise.resolve([]);
    }
    touched.push('plan-lookup');
    const [workspaceId, harnessSlug, planSlug] = values;
    return Promise.resolve(registered.some(plan => plan.workspaceId === workspaceId &&
      plan.harnessSlug === harnessSlug && plan.planSlug === planSlug) ? [{ one: 1 }] : []);
  }) as unknown as Sql;
  const deps = {
    getSql: () => sql,
    route: async () => { touched.push('route'); throw new Error(TOUCHED); },
    open: async () => { touched.push('open'); throw new Error(TOUCHED); },
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

  it.each([
    ['existing work-item id', 'WI-1', [{ workspaceId: 'ws-unit', harnessSlug: 'papercusp', planSlug: 'some-real-plan' }]],
    ['incident id', 'EI-123', [{ workspaceId: 'ws-unit', harnessSlug: 'papercusp', planSlug: 'some-real-plan' }]],
    ['unregistered slug', 'not-a-plan', [{ workspaceId: 'ws-unit', harnessSlug: 'papercusp', planSlug: 'some-real-plan' }]],
    ['plan from another harness', 'shared-plan', [{ workspaceId: 'ws-unit', harnessSlug: 'other-harness', planSlug: 'shared-plan' }]],
    ['plan from another workspace', 'foreign-plan', [{ workspaceId: 'other-workspace', harnessSlug: 'papercusp', planSlug: 'foreign-plan' }]],
  ] as const)('SPEC-P-007-CRITIQUE-REF: refuses %s before routing or opening', async (_label, originTaskRef, registered) => {
    const { deps, touched } = planValidationDeps([...registered]);
    const out = await settle(
      getFeedbackCore(request({ policy: BAR_CRITIQUE_POLICY, originTaskRef, harnessSlug: 'papercusp' }), deps),
    );
    expect(out.value).toMatchObject({ error: 'bar_critique_requires_plan' });
    expect(touched).toEqual(['plan-lookup']);
  });

  it('SPEC-P-007-CRITIQUE-REF control: an exact registered plan in the selected scope passes the guard', async () => {
    const { deps, touched } = planValidationDeps([
      { workspaceId: 'ws-unit', harnessSlug: 'papercusp', planSlug: 'some-real-plan' },
    ]);
    const out = await settle(getFeedbackCore(request({ policy: BAR_CRITIQUE_POLICY,
      originTaskRef: 'some-real-plan', harnessSlug: 'papercusp' }), deps));
    expect(out.thrown).toContain(TOUCHED);
    expect(touched[0]).toBe('plan-lookup');
    expect(touched.at(-1)).toBe('route');
  });

  it('SPEC-P-007-CRITIQUE-REF requires a concrete harness even when the slug exists elsewhere', async () => {
    const { deps, touched } = planValidationDeps([
      { workspaceId: 'ws-unit', harnessSlug: 'papercusp', planSlug: 'some-real-plan' },
    ]);
    const out = await settle(getFeedbackCore(request({ policy: BAR_CRITIQUE_POLICY,
      originTaskRef: 'some-real-plan' }), deps));
    expect(out.value).toMatchObject({ error: 'bar_critique_requires_plan' });
    expect(touched).toEqual([]);
  });

  it('SPEC-P-007-CRITIQUE-REF control: a non-bar-critique consult without an origin ref is not refused by this guard', async () => {
    const { deps } = trippedDeps();
    const out = await settle(getFeedbackCore(request({}), deps));
    expect((out.value as { error?: string } | undefined)?.error).not.toBe('bar_critique_requires_plan');
  });
});
