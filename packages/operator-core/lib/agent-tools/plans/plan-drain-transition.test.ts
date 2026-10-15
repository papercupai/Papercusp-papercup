import { describe, expect, it, vi } from 'vitest';
import type { evaluateBlindReviewGate } from '../../blind-review-gate';
import { planDrainTransitionMutationGated } from './plan-drain-transition';

/** An authored-shape plan whose only item is already terminal: the graph warrants
 *  `awaiting-acceptance`, so the only thing that can stop the move is the gate. */
function drainedBody(slug: string): string {
  return [
    '---',
    'title: Drained plan',
    `slug: ${slug}`,
    'status: active',
    '---',
    '',
    '## Phase 1',
    '',
    '- **P-001** `done` final implementation item',
    '',
  ].join('\n');
}

function evaluateStub(satisfied: boolean) {
  return vi.fn(async () => ({ satisfied })) as unknown as typeof evaluateBlindReviewGate &
    ReturnType<typeof vi.fn>;
}

describe('planDrainTransitionMutationGated: plan-run instances (WI-6554700010009790)', () => {
  it('control: moves an authored plan whose last item is done to awaiting-acceptance', async () => {
    const evaluate = evaluateStub(true);
    const out = await planDrainTransitionMutationGated(
      drainedBody('bug-triage'),
      { planSlug: 'bug-triage', harnessSlug: 'papercusp', workspaceId: 'ws-a' },
      { evaluate },
    );
    expect(out.value).toMatchObject({ applied: true, to: 'awaiting-acceptance' });
    expect(out.newBody).not.toBeNull();
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('asks the gate about the caller\'s locked scope, never the ambient workspace (WI-6554700010010577)', async () => {
    const evaluate = evaluateStub(true);
    await planDrainTransitionMutationGated(
      drainedBody('bug-triage'),
      { planSlug: 'bug-triage', harnessSlug: 'calendar', workspaceId: 'ws-registered' },
      { evaluate },
    );
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ planSlug: 'bug-triage', harnessSlug: 'calendar', workspaceId: 'ws-registered' }),
    );
  });

  it('never moves a <template>@run-<token> instance, so no acceptance carry is filed and the run reconciler can still retire it', async () => {
    const slug = 'bug-triage@run-933051162668500852';
    const evaluate = evaluateStub(true);
    const out = await planDrainTransitionMutationGated(
      drainedBody(slug),
      { planSlug: slug, harnessSlug: 'papercusp', workspaceId: 'ws-a' },
      { evaluate },
    );
    expect(out).toEqual({ newBody: null, value: { applied: false, skipped: 'plan_run_instance' } });
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('does not treat an authored slug that merely contains @run- as an instance', async () => {
    const slug = 'notes-on-@run-handling';
    const evaluate = evaluateStub(true);
    const out = await planDrainTransitionMutationGated(
      drainedBody(slug),
      { planSlug: slug, harnessSlug: 'papercusp', workspaceId: 'ws-a' },
      { evaluate },
    );
    expect(out.value.skipped).not.toBe('plan_run_instance');
  });
});
