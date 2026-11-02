import { describe, expect, it } from 'vitest';
import { planAcceptanceRepairAction } from '../../plan-acceptance-gate';
import type { AcceptanceBarSnapshotCode } from '../../acceptance-bar-contract-snapshot';
import type { AcceptanceBarLifecycleVerdict } from '../../acceptance-bar-lifecycle-evaluator';
import getPlan from './get';
import setPlanStatus from './set-plan-status';
import getScorecard from '../scorecards/get';

const lifecycle = (code: AcceptanceBarSnapshotCode, action = 'Measured repair.'): AcceptanceBarLifecycleVerdict => ({
  phase: 'ship' as const,
  applicable: true,
  satisfied: false,
  codes: [code],
  blockingBars: [],
  contractCodes: [code],
  codeAttribution: [{ code, barKeys: [] }],
  staleGradingScorecardId: null,
  message: 'inspect',
  nextRepair: { code, barKey: null, action },
});

describe('plans:set-plan-status structured acceptance repair routes (P-026)', () => {
  it('keeps umbrella contract failures diagnostic when no measured mutation is safe', () => {
    for (const code of [
      'bar_snapshot_source_unavailable',
      'bar_snapshot_rubric_unresolved',
      'bar_snapshot_plan_ambiguous',
      'bar_snapshot_proof_inadequate',
      'bar_snapshot_grading_missing',
    ] as const) {
      expect(
        planAcceptanceRepairAction(
          'plan-a',
          { satisfied: false, code: 'acceptance_bar_contract_not_ready', acceptanceBarLifecycle: lifecycle(code) },
          { harnessSlug: 'papercusp' },
        ),
      ).toEqual({
        kind: 'diagnostic',
        nextVerb: {
          name: 'plans:get',
          args: { slug: 'plan-a', harness: 'papercusp', mode: 'meta', shipReadiness: true },
        },
        instruction: 'Measured repair.',
      });
    }
  });

  it('routes measured BAR contract defects to amend only after a scoped read', () => {
    const action = planAcceptanceRepairAction(
      'plan-a',
      {
        satisfied: false,
        code: 'acceptance_bar_contract_not_ready',
        acceptanceBarLifecycle: lifecycle('bar_snapshot_method_missing', 'Fill the BAR METHOD/check contract.'),
      },
      { harnessSlug: 'papercusp' },
    );
    expect(action).toMatchObject({
      kind: 'contract-repair',
      repairVerb: 'rubrics:amend',
      nextVerb: {
        name: 'plans:get',
        args: { slug: 'plan-a', harness: 'papercusp', mode: 'meta', shipReadiness: true },
      },
    });
    expect(action.instruction).toContain('dryRun');
    expect(action.instruction).not.toContain('approvalRef');
  });

  it.each(['acceptance_ungraded', 'self_graded_only'] as const)(
    'routes %s through the existing idempotent recruiter',
    (code) => {
      expect(
        planAcceptanceRepairAction('plan-a', { satisfied: false, code }, { harnessSlug: 'papercusp' }),
      ).toMatchObject({
        kind: 'independent-grading',
        nextVerb: {
          name: 'plans:set-plan-status',
          args: {
            slug: 'plan-a',
            harness: 'papercusp',
            status: 'shipped',
          },
        },
      });
    },
  );

  // EI-24032136322947460: the gate cannot see whether the acceptance-grading-sweep
  // is running, so its default text must not promise that the sweep recovers a
  // stalled grading. It names the one recovery that always exists (a retry re-runs
  // recruitment) and points at the ship result's `acceptanceGrader.recovery`, which
  // carries the manual route when the sweep is paused or inactive.
  it.each(['acceptance_ungraded', 'self_graded_only'] as const)(
    'does not claim the grading sweep owns recovery for %s',
    (code) => {
      const { instruction } = planAcceptanceRepairAction('plan-a', { satisfied: false, code });
      expect(instruction).not.toMatch(/sweep own/i);
      expect(instruction).toMatch(/re-runs the idempotent grader recruiter/);
      expect(instruction).toContain('acceptanceGrader.recovery');
      expect(instruction).toContain('Do not self-grade or launch a parallel reviewer.');
    },
  );

  it('routes a graded result to the exact author-verdict predecessor', () => {
    expect(
      planAcceptanceRepairAction('plan-a', {
        satisfied: false,
        code: 'acceptance_not_recorded',
        gradingRef: 'EI-grade',
      }),
    ).toMatchObject({
      kind: 'author-verdict',
      repairVerb: 'scorecards:emit',
      nextVerb: { name: 'scorecards:get', args: { issueId: 'EI-grade' } },
    });
  });

  it('routes rejected grading to an author verdict without fabricating a grading id', () => {
    expect(
      planAcceptanceRepairAction('plan-a', {
        satisfied: false,
        code: 'acceptance_rejected',
      }),
    ).toMatchObject({
      kind: 'author-verdict',
      repairVerb: 'scorecards:emit',
      nextVerb: { name: 'plans:get' },
    });
  });

  it('routes a measured vetting defect to read-before-vetting', () => {
    expect(
      planAcceptanceRepairAction('plan-a', {
        satisfied: false,
        code: 'acceptance_bar_contract_not_ready',
        acceptanceBarLifecycle: lifecycle('bar_snapshot_vetting_missing'),
      }),
    ).toMatchObject({
      kind: 'rubric-vetting',
      repairVerb: 'consult:get_feedback',
      nextVerb: { name: 'plans:get' },
    });
  });

  it('routes a satisfied gate to shipment and an already-shipped plan to terminal', () => {
    expect(planAcceptanceRepairAction('plan-a', { satisfied: true }, {}, 'awaiting-acceptance')).toMatchObject({
      kind: 'shipment',
      nextVerb: {
        name: 'plans:set-plan-status',
        args: { slug: 'plan-a', status: 'shipped', expectedCurrent: 'awaiting-acceptance' },
      },
    });
    expect(planAcceptanceRepairAction('plan-a', { satisfied: true, skipped: 'already-shipped' })).toEqual({
      kind: 'terminal',
      nextVerb: null,
      instruction: 'Already shipped; do not reopen acceptance.',
    });
  });

  it('keeps an exempt standing rubric active instead of recommending its retirement', () => {
    for (const status of ['draft', 'ready', 'active']) {
      const action = planAcceptanceRepairAction('standing-rubric', {
        satisfied: true, skipped: 'rubric-template-plan',
      }, { harnessSlug: 'papercusp' }, status);
      expect(action).toMatchObject({ kind: 'diagnostic', nextVerb: null });
      expect(action.instruction).toContain('Keep it active');
      expect(action.instruction).toContain('shipped retires the rubric');
    }
  });

  it('does not infer a carried lifecycle for a legacy or unmeasured subject', () => {
    for (const status of ['ready', 'active', undefined]) {
      const action = planAcceptanceRepairAction('plan-a', { satisfied: true }, {}, status);
      expect(action.nextVerb?.args).not.toHaveProperty('expectedCurrent');
    }
  });

  it('never copies a repair from a different lifecycle phase', () => {
    const observation = lifecycle('bar_snapshot_method_missing');
    observation.codes = ['bar_snapshot_source_unavailable'];
    expect(planAcceptanceRepairAction('p', {
      satisfied: false, code: 'acceptance_bar_contract_not_ready',
      acceptanceBarLifecycle: observation, message: 'Read failed.',
    })).toMatchObject({ kind: 'diagnostic', instruction: 'Read failed.' });
  });

  it('routes the blocking pre-grading repair before a later author verdict', () => {
    const ship = lifecycle('bar_snapshot_author_verdict_missing', 'Record the author verdict.');
    const preGrading = { ...lifecycle('bar_snapshot_vetting_missing', 'Vet the current rubric first.'),
      phase: 'pre-grading' as const };
    expect(planAcceptanceRepairAction('p', {
      satisfied: false, code: 'acceptance_bar_contract_not_ready',
      acceptanceBarLifecycle: ship, blockingPhase: 'pre-grading', blockingPhaseLifecycle: preGrading,
    })).toMatchObject({
      kind: 'rubric-vetting', repairVerb: 'consult:get_feedback', instruction: 'Vet the current rubric first.',
    });
  });

  it('never proposes an author verdict while pre-grading proof is missing', () => {
    const preGrading = { ...lifecycle('bar_snapshot_proof_missing', 'Bind current proof for R-1.'),
      phase: 'pre-grading' as const };
    const action = planAcceptanceRepairAction('p', {
      satisfied: false, code: 'acceptance_bar_contract_not_ready',
      acceptanceBarLifecycle: lifecycle('bar_snapshot_author_verdict_missing', 'Record acceptance.'),
      blockingPhase: 'pre-grading', blockingPhaseLifecycle: preGrading,
    });
    expect(action).toMatchObject({ kind: 'diagnostic', instruction: 'Bind current proof for R-1.' });
    expect(action).not.toHaveProperty('repairVerb');
  });

  it('keeps the evidence cohort and scope but never automatically replays force', () => {
    const current = [{ evidenceKind: 'test' as const, evidenceRef: 'test:1', sourceFingerprint: 'sha:1' }];
    for (const satisfied of [false, true]) {
      const action = planAcceptanceRepairAction('p', { satisfied }, {
        harnessSlug: 'home', current, force: { reason: 'old waiver' },
      });
      expect(action.nextVerb?.args).toMatchObject({ slug: 'p', harness: 'home', current });
      expect(action.nextVerb?.args).not.toHaveProperty('force');
    }
  });

  it('produces calls accepted by the real next-verb schemas, not placeholder writes', () => {
    const routes = [
      planAcceptanceRepairAction('p', { satisfied: false }),
      planAcceptanceRepairAction('p', { satisfied: false, code: 'acceptance_ungraded' }),
      planAcceptanceRepairAction('p', { satisfied: true }),
      planAcceptanceRepairAction('p', { satisfied: false, code: 'acceptance_not_recorded', gradingRef: 'EI-123' }),
    ];
    const schemas = new Map<string, { safeParse: (value: unknown) => { success: boolean } }>([
      ['plans:get', getPlan.args],
      ['plans:set-plan-status', setPlanStatus.args],
      ['scorecards:get', getScorecard.args],
    ]);
    for (const { nextVerb } of routes) {
      expect(nextVerb).not.toBeNull();
      expect(schemas.get(nextVerb!.name)!.safeParse(nextVerb!.args).success).toBe(true);
    }
  });
});
