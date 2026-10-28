/**
 * acceptance-runtime-plane-not-main-2026-09-23 P-005/P-006 — a carried dependency on
 * main / :3070 / a deploy must travel WITH its probe.
 *
 * The motivating note rode ~5 cold wakes: "R-3 needs main before it can be graded" — the
 * code ran in bg-host, which no deploy touches. Positive cases are phrased the way those
 * notes were; negative cases pin the precision rule this module lives by (a lint that fires
 * on the corrected behaviour gets tuned out).
 */
import { describe, expect, it } from 'vitest';
import {
  PROVENANCE_LINT_DEPLOY_DEPENDENCY_NOTE,
  lintCarrySurfaceProvenance,
  provenanceLintField,
} from './carry-surface-provenance-lint';
import { withCarryNoteChecks } from './carry-note';

const kinds = (text: string) => lintCarrySurfaceProvenance(text).matches.map((m) => m.kind);

describe('unprobed-deploy-dependency', () => {
  it.each([
    'R-3 needs main before it can be graded',
    'Waiting on the deploy to :3070, then re-grade R-1',
    'blocked on green main — resume after release:deployed',
    'Wait for the release deployment before the maintenance window.',
    'Acceptance is pending deployment; nothing else to do',
    "can't grade R-3 until it lands on main",
    'R-3 needs the fix to be deployed before it can be graded',
  ])('flags: %s', (line) => {
    expect(kinds(line)).toContain('unprobed-deploy-dependency');
  });

  it.each([
    // a probe on the same line
    'R-3 needs main? re-check: dev:pipeline_position { path } → servingRuntimes shows bg-host has it',
    'waiting on the deploy — measured: :3070 /api/health be8396c6dd lacks the blob',
    // hedged / tagged / questioned
    'R-3 probably needs main [inferred]',
    '[self-imposed] hold R-9 until the deploy lands (final shipment bar)',
    'check whether R-3 actually needs main',
    '#2127 (why agents wait for :3070 before acceptance; answered by this plan)',
    // the corrected premise
    'R-3 does not need main — bg-host already runs it',
    'no longer blocked on the deploy',
    // unrelated uses of "main"
    'the main risk is the parser; fix it first',
    'merged the main loop refactor',
    'Wait for the release event before acquiring shared leases or reading refs.',
    'Wait for resource:released:git-sync before acquiring shared leases or reading refs.',
  ])('does not flag: %s', (line) => {
    expect(kinds(line)).not.toContain('unprobed-deploy-dependency');
  });

  it('does not treat a main.rs source path as the release branch or its probe', () => {
    expect(
      kinds('Acceptance is blocked by the dirty source file apps/operator/src/main.rs while sync progresses.'),
    ).not.toContain('unprobed-deploy-dependency');

    const note =
      'Acceptance is pending deployment before grading.\n' +
      'The only probe was an inspection of apps/operator/src/main.rs.';
    expect(kinds(note)).toContain('unprobed-deploy-dependency');
  });

  it('does not mistake a deployed-artifact code task for a release dependency', () => {
    const line = 'AgenticMail and VirtualBox remediation sources are outside this repo; Kopia backup-lock/RPO work remains on WI-10004971. Do not attribute any of these failed services to the host freeze. Need implement a Papercusp-side deployed model-path prerequisite check with a recurrence guard; the unrelated host artifacts remain unresolved.';
    expect(kinds(line)).not.toContain('unprobed-deploy-dependency');
  });

  it('does not join a held gate transition to a later deployment disclaimer across a semicolon', () => {
    const note =
      'EI-25421911577420059 remains open and held by this session; no direct trace ties the historical stall to a cause. ' +
      'EI-25233283196255077 remains held pending the other live gate owner\'s transition; no gate/deploy read was made.';
    expect(kinds(note)).not.toContain('unprobed-deploy-dependency');

    // Positive control: the same required/action and deployment vocabulary still fires
    // when it appears in one uninterrupted clause.
    expect(kinds('This item is pending deployment to main before grading.')).toContain(
      'unprobed-deploy-dependency',
    );
  });

  it('does not treat an unestablished deployment-skew explanation as a release dependency', () => {
    const line =
      'The triggering verifier exception and deployment-skew explanation remain unestablished. ' +
      'Keep this item open and claim-held until exact retained evidence satisfies the release condition.';
    expect(kinds(line)).not.toContain('unprobed-deploy-dependency');
  });

  it('a checks row in the same write that probes the release plane clears the narrative line', () => {
    const note = withCarryNoteChecks('Waiting on the deploy to finish R-3.', [
      { claim: 'R-3 is blocked on the :3070 deploy', recheck: 'dev:pipeline_position { path } → servingRuntimes' },
    ]);
    expect(kinds(note)).not.toContain('unprobed-deploy-dependency');
  });

  it('a checks row about something else does not clear it', () => {
    const note = withCarryNoteChecks('Waiting on the deploy to finish R-3.', [
      { claim: 'the ingest routine fired at 00:18Z', recheck: 'routines:list { name }' },
    ]);
    expect(kinds(note)).toContain('unprobed-deploy-dependency');
  });

  it('an all-deploy-dependency write gets its own note; a mixed write keeps the louder one', () => {
    expect(provenanceLintField('R-3 needs main before grading')?.note).toBe(PROVENANCE_LINT_DEPLOY_DEPENDENCY_NOTE);
    expect(PROVENANCE_LINT_DEPLOY_DEPENDENCY_NOTE).toMatch(/servingRuntimes/);
    const mixed = provenanceLintField('R-3 needs main before grading\nThe owner said to wait for main');
    expect(mixed?.note).not.toBe(PROVENANCE_LINT_DEPLOY_DEPENDENCY_NOTE);
  });
});
