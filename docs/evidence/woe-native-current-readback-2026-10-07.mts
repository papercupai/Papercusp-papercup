/** Native WOE current readback. Run from a clean, committed source snapshot.
 * Reads the existing real holder card; does not re-grade its historical window.
 * executeOperationalRun owns runtime witnesses, source snapshots and receipt.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { executeOperationalRun } from '../../packages/operator-core/lib/agent-tools/testing/record-run';
import { computeWorkOnEverythingRollup } from '../../packages/operator-core/lib/scorecards';
import { captureWorktreeSnapshotAsync, computeWorktreeDirty, type WorktreeGitSnapshot } from '../../packages/operator-core/lib/testing-worktree';
import { listRuntimeVintage, measureRuntimeVintageEnvironment } from '../../packages/operator-core/lib/runtime-vintage';
import { persistHarnessTestRunsWithIds } from '../../packages/operator-core/lib/testing-run-store';

const exec = promisify(execFile);
const runtimePort = process.env.PAPERCUSP_WOE_READBACK_PORT ?? '3170';
if (runtimePort !== '3070' && runtimePort !== '3170') {
  throw new Error('PAPERCUSP_WOE_READBACK_PORT must name release 3070 or staging 3170');
}
const runtimeUnit = `hono-host:${runtimePort}`;
const cardId = 'EI-24713330305263301';
const rubricRef = 'work-on-everything-stewardship-health';
const keys = ['plan-fleet-materialization', 'steering-through-claim-rails', 'frontier-scope-sovereignty'];
const sourceObservations: WorktreeGitSnapshot[] = [];
async function read(tool: string, args: object) {
  const { stdout } = await exec('ptool', [`--url=http://127.0.0.1:${runtimePort}`, tool, '--json', JSON.stringify(args)],
    { timeout: 45_000, maxBuffer: 256 * 1024 });
  const value = JSON.parse(stdout);
  if (value.ok === false || value._projection?.truncated) throw new Error(`${tool}: incomplete read`);
  return value;
}

const result = await executeOperationalRun({
  filePath: 'docs/evidence/woe-native-current-readback-2026-10-07.mts',
  name: 'WOE current real-card readback with native operational runtime witnesses',
  command: ['env', `PAPERCUSP_WOE_READBACK_PORT=${runtimePort}`, 'npx', 'tsx', 'docs/evidence/woe-native-current-readback-2026-10-07.mts'],
  framework: 'operational', runtimeUnits: [runtimeUnit],
  run: async () => {
    const rubricResponse = await read('rubrics:get', { rubricRef, detail: 'summary' });
    const rubric = rubricResponse.results?.[0]?.rubric;
    const cards = await Promise.all(keys.map(criterionKey => read('scorecards:get', { issueId: cardId, criterionKey })));
    const residueResponse = await read('work_items:get', { id: 'WI-10004612', harness: 'papercusp',
      projection: { pick: ['results[].workItem.state', 'results[].workItem.assignee'] } });
    const residue = residueResponse.results?.[0]?.workItem;
    const assertions: { id: string; passed: boolean; evidence: string }[] = [];
    const check = (id: string, passed: boolean, evidence: unknown) => assertions.push({ id, passed,
      evidence: JSON.stringify(evidence).slice(0, 2000) });
    check('active-rubric-current', rubric?.status === 'active' && Number.isInteger(rubric.revision),
      { revision: rubric?.revision, criteriaHash: rubric?.criteriaHash });
    for (let index = 0; index < keys.length; index++) {
      const value = cards[index];
      const criterion = value.scorecard?.criteria?.find((entry: { key: string }) => entry.key === keys[index]);
      check(`${keys[index]}-exact-live-read`, value.ok === true && value.evidenceRead?.complete === true
        && !!criterion && criterion.evidence.length > 0, { criterion, evidenceRead: value.evidenceRead });
    }
    const card = cards[0].scorecard;
    const materialization = card?.criteria?.find((entry: { key: string }) => entry.key === 'plan-fleet-materialization');
    // Compare a report with independently fetched canonical fields. The
    // counterexamples change only the proposed report, never the real card.
    const matchesMaterializationReport = (report: { rating: string; residueOwner: string }) =>
      report.rating === materialization?.rating && report.residueOwner === residue?.assignee;
    const matchesCardReport = (report: { verdict: string; subjectKind: string; auditState: string }) =>
      report.verdict === card?.rollup?.verdict && report.subjectKind === card?.subject?.kind
        && report.auditState === card?.gradingAudit?.state;
    check('materialization-zero-fails-negative', !matchesMaterializationReport({ rating: 'pass', residueOwner: residue?.assignee }),
      { proposedRating: 'pass', actualRating: materialization?.rating, residueOwner: residue?.assignee });
    check('materialization-residue-owner-negative', !matchesMaterializationReport({ rating: materialization?.rating, residueOwner: '' }),
      { proposedOwner: '', actualOwner: residue?.assignee, workItem: 'WI-10004612' });
    check('materialization-report-exact', matchesMaterializationReport({ rating: 'fail', residueOwner: residue?.assignee }),
      { rating: materialization?.rating, residueOwner: residue?.assignee, workItem: 'WI-10004612' });
    check('existing-fail-retained-negative', !matchesCardReport({ verdict: 'pass', subjectKind: 'agent-run', auditState: 'passed' }),
      { proposedVerdict: 'pass', actualVerdict: card?.rollup?.verdict, cardId });
    check('existing-fail-report-exact', matchesCardReport({ verdict: 'fail', subjectKind: 'agent-run', auditState: 'passed' }),
      { verdict: card?.rollup?.verdict, subject: card?.subject, gradingAudit: card?.gradingAudit, cardId });
    check('materialization-zero-fails-exact', card?.criteria?.[0]?.rating === 'fail'
      && card.rollup?.criticalFailures?.includes('plan-fleet-materialization'), card.rollup);
    check('existing-fail-retained-exact', card?.rollup?.verdict === 'fail'
      && card.subject?.kind === 'agent-run' && card.gradingAudit?.state === 'passed',
      { rollup: card?.rollup, subject: card?.subject, gradingAudit: card?.gradingAudit });
    check('materialization-residue-owner-exact', typeof residue?.assignee === 'string'
      && residue.assignee.length > 0, residue);
    check('historical-rubric-boundary-disclosed', Number.isInteger(card?.rubricRevision)
      && card.rubricRevision < rubric?.revision,
      { historicalRevision: card?.rubricRevision, currentRevision: rubric?.revision,
        limit: 'Current readback retains historical FAIL; no historical re-grade or desktop journey.' });
    const baseline = Object.fromEntries(keys.map(key => [key, { rating: 'pass', evidence: 'control' }]));
    check('severe-control-baseline-pass', computeWorkOnEverythingRollup(rubricRef, baseline, keys)?.verdict === 'pass',
      { keys, ratings: 'all pass' });
    for (const key of keys.slice(1)) {
      const severe = computeWorkOnEverythingRollup(rubricRef, { ...baseline, [key]: { rating: 'severe', evidence: 'control' } }, keys);
      check(`${key}-severe-retained`, severe?.verdict === 'severe', severe);
    }
    return { exitCode: assertions.every(assertion => assertion.passed) ? 0 : 1,
      summary: 'Fresh existing-holder readback and server severe-rollup controls; historical FAIL retained. No new holder card, fixture goal, desktop journey, or shipment claim.', assertions };
  },
}, { workspaceId: 'papercusp-workspace', harnessSlug: 'papercusp', projectDir: process.cwd() }, {
  // Delegate to the SAME real primitives as the executor defaults. Expose the
  // two exact reads rather than infer cleanliness from a later git status.
  snapshot: async root => {
    const started = Date.now();
    const snapshot = await captureWorktreeSnapshotAsync(root);
    sourceObservations.push(snapshot);
    process.stderr.write(`${JSON.stringify({ sourceSnapshot: sourceObservations.length,
      elapsedMs: Date.now() - started, commit: snapshot.commit,
      porcelain: snapshot.porcelain === null ? null : snapshot.porcelain.slice(0, 2000) })}\n`);
    return snapshot;
  },
  readRuntime: async (units, workspaceId) =>
    measureRuntimeVintageEnvironment(await listRuntimeVintage(workspaceId), units),
  persist: persistHarnessTestRunsWithIds,
});
// The shared recorder retains its PG pool; this standalone producer finishes
// only after the durable receipt has returned and stdout has drained.
const sourceClean = sourceObservations.length === 2
  && !computeWorktreeDirty(sourceObservations[0], sourceObservations[1]);
const exitCode = result.ok && result.status === 'pass' && result.runtimeEnvironmentMeasured && sourceClean ? 0 : 1;
process.stdout.write(`${JSON.stringify({ ...result, sourceClean })}\n`, () => process.exit(exitCode));
