/** R4 live acceptance reuses canonical bindings, artifacts, native runs and runtime
 * witnesses. Stored METHOD results never become current product observations. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { parseTestRunExecutionDetails, stableRecordedRuntimeEnvironment } from '@papercusp/test-config/execution-details';
import type { listSpecEvidence } from '../agent-tools/plans/spec-evidence-store';
import type { readHarnessTestRunEvidence } from '../testing-run-store';
import type { loadTextArtifact } from '../text-artifacts';
import { listRuntimeVintage, measureRuntimeVintageEnvironment, type RuntimeVintageRow } from '../runtime-vintage';
import { moduleRepoRoot } from '../module-repo-root';
import { runGit } from '../harness/docs/git-runner';
import {
  assessDreamActionDecisions, assessGymAdmissionDecisions, assessDreamR2ClauseAssertions,
  assessDreamControlObservationCurrentness, controlObservationScopeSchema,
  type DreamControlObservations,
} from './dream-control-observations';

export const DREAM_CONTROL_LIVE_INSTRUMENT_KEY = 'dream:current-control-operational-edition';
export const DREAM_CONTROL_SOURCE_PLAN = 'dream-loaded-control-observations-2026-10-17';
export const DREAM_CONTROL_LIVE_SPEC = 'AUTO-BAR-R-4-P-002';
export const DREAM_CONTROL_RUNTIME_UNITS = ['hono-host:3170', 'hono-host:3271'];
export const DREAM_CONTROL_LIVE_TEST = 'packages/operator-core/lib/dream/dream-control-observations.live.e2e.test.ts';
export const DREAM_CONTROL_LIVE_FIXTURE = 'packages/operator-core/test/fixtures/dream-control-observations-live.json';
const apiSources = ['packages/operator-core/lib/dream/dream-control-observations.ts',
  'packages/operator-core/lib/sync-resolver/index.ts'];
const backgroundSources = ['packages/operator-core/lib/dream/dream-cycle-action.ts',
  'packages/operator-core/lib/dream/dream-config.ts', 'packages/operator-core/lib/harness/routines/gym-actions.ts',
  'packages/operator-core/lib/scout/run.ts', 'packages/operator-core/lib/scout/scheduler.ts'];
export const DREAM_CONTROL_LIVE_SOURCES = [...apiSources, ...backgroundSources,
  DREAM_CONTROL_LIVE_TEST, DREAM_CONTROL_LIVE_FIXTURE];
const clauseIds = ['r2:dream-action-decisions', 'r2:gym-admission-decisions', 'r2:full-admission-and-spend',
  'r2:scout-zero-route-lens-cap-provenance', 'r2:actual-attempts-or-explicit-policy-skips'];
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
/** This exact digest is retained as a native passed assertion, not a caller label. */
export const dreamControlEditionDigest = (edition: { consumedAt: string; observation: unknown }) =>
  digest(JSON.stringify({ consumedAt: edition.consumedAt, observation: edition.observation }));
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{7,64}$/);
const editionPin = z.object({ relPath: z.string().min(1).max(500), sha256: sha }).strict();
const artifactSchema = z.object({
  schemaVersion: z.literal(1), kind: z.literal('dream-control-operational-method-edition'),
  pinnedCommit: z.string().regex(/^[a-f0-9]{40}$/),
  sourceFiles: z.array(z.object({ path: z.string().min(1), sha256: sha }).strict()).min(1).max(50),
  nativeOperationalRun: z.object({ ok: z.literal(true), runGroupId: z.string().startsWith('operational-native:'),
    testRunIds: z.tuple([z.number().int().positive()]), status: z.literal('pass'), runtimeEnvironmentMeasured: z.literal(true) }).passthrough(),
  edition: z.object({ consumedAt: z.string().datetime(), observation: z.unknown() }).passthrough(),
}).passthrough();

type Binding = Awaited<ReturnType<typeof listSpecEvidence>>[number];
export interface DreamControlLiveInput {
  workspaceId: string; harnessSlug: string; planSlug: string; windowStart: string; windowEnd: string;
}
export interface DreamControlLiveMeasurement {
  verdict: 'pass' | 'fail' | 'unknown'; reason: string; evidenceRefs: string[];
  bindingId?: number; editionSha256?: string; capturedAt?: string; consumedAt?: string; expiresAt?: string;
  clauses?: ReturnType<typeof assessDreamR2ClauseAssertions>['clauses'];
}
export interface DreamControlLiveDeps {
  now?: () => number;
  bindings?: typeof listSpecEvidence;
  artifact?: typeof loadTextArtifact;
  runs?: typeof readHarnessTestRunEvidence;
  runtimes?: (workspaceId: string, units: string[]) => Promise<RuntimeVintageRow[]>;
  runtimeFingerprint?: typeof measureRuntimeVintageEnvironment;
  source?: (ref: string, path: string) => Promise<string | null>;
}
const sameCommit = (a: string | null, b: string) =>
  commit.safeParse(a).success && commit.safeParse(b).success && (a!.startsWith(b) || b.startsWith(a!));

export async function measureDreamControlLiveEdition(
  input: DreamControlLiveInput, deps: DreamControlLiveDeps = {},
): Promise<DreamControlLiveMeasurement> {
  const refs: string[] = [];
  const result: Partial<DreamControlLiveMeasurement> = {};
  const unknown = (reason: string): DreamControlLiveMeasurement => ({ ...result, verdict: 'unknown', reason, evidenceRefs: refs });
  const now = deps.now ?? Date.now;
  try {
    const startedAt = now();
    const start = Date.parse(input.windowStart), end = Date.parse(input.windowEnd);
    if (!input.workspaceId.trim() || input.workspaceId === '*' || input.harnessSlug !== 'papercusp'
      || input.planSlug !== DREAM_CONTROL_SOURCE_PLAN || !Number.isFinite(start) || !Number.isFinite(end)
      || start >= end || end > startedAt || end - start > 31 * 86_400_000) return unknown('exact-plan-workspace-harness-and-window-required');
    const bindings = deps.bindings ?? (await import('../agent-tools/plans/spec-evidence-store')).listSpecEvidence;
    const rows = await bindings({ workspaceId: input.workspaceId,
      harnessSlug: input.harnessSlug, planSlugs: [input.planSlug], specIds: [DREAM_CONTROL_LIVE_SPEC],
      evidenceKinds: ['operational'], current: true, limit: 2 });
    // Latest edition wins; never hunt backwards for a green historical edition.
    const binding: Binding | undefined = [...rows].sort((a, b) => b.id - a.id)[0];
    if (!binding) return unknown('canonical-live-binding-required');
    result.bindingId = binding.id;
    refs.push(`spec-evidence:${binding.id}`);
    const dims = binding.currentness.dimensions;
    if (binding.planSlug !== input.planSlug || binding.specId !== DREAM_CONTROL_LIVE_SPEC
      || binding.specRevision !== binding.currentRevision || binding.withdrawal || binding.provisionalProofBase
      || binding.currentness.overall !== 'current' || binding.currentness.provenance !== 'server-measured'
      || !binding.currentness.comparisonSupplied || binding.currentness.staleReasons.length || binding.currentness.unknownReasons.length
      || !['spec', 'source', 'test', 'fixture', 'environment', 'testRun'].every(key => dims[key as keyof typeof dims] === 'current')
      || !Object.values(dims).every(state => state === 'current' || state === 'not-applicable')
      || binding.serverMeasurement?.status !== 'measured'
      || binding.serverMeasurement.attestedDimensions?.length) return unknown('binding-not-independently-current');
    const pin = editionPin.safeParse(binding.details?.dreamLiveEdition);
    if (!pin.success || !pin.data.relPath.startsWith('verification/') || pin.data.relPath.split('/').some(p => !p || p === '.' || p === '..')
      || pin.data.relPath.includes('\\')) return unknown('canonical-edition-pin-required');
    const loadArtifact = deps.artifact ?? (await import('../text-artifacts')).loadTextArtifact;
    const bytes = await loadArtifact(input.harnessSlug, pin.data.relPath);
    if (bytes === null || Buffer.byteLength(bytes) > 256 * 1024 || digest(bytes) !== pin.data.sha256) return unknown('canonical-edition-hash-mismatch');
    result.editionSha256 = pin.data.sha256;
    refs.push(`artifact:${input.harnessSlug}/${pin.data.relPath}#sha256:${pin.data.sha256}`);
    const artifact = artifactSchema.parse(JSON.parse(bytes));
    const { observation: raw, consumedAt } = artifact.edition;
    const observation = raw as DreamControlObservations;
    const scope = controlObservationScopeSchema.parse(observation?.scope);
    if (scope.workspaceId !== input.workspaceId || scope.potSlug !== input.harnessSlug
      || scope.since !== input.windowStart || scope.until !== input.windowEnd
      || scope.actionJournalUnit !== 'papercusp-bg-host.service' || scope.gymJournalUnit !== scope.actionJournalUnit
      || !scope.expectedActionRuntime || !scope.expectedGymRuntime
      || !isDeepStrictEqual(scope.expectedActionRuntime, scope.expectedGymRuntime)
      || scope.expectedRuntime.host !== 'port-3170' || scope.expectedActionRuntime.host !== 'port-3271'
      || scope.expectedRuntime.processId === scope.expectedActionRuntime.processId) return unknown('independent-api-and-background-scope-required');
    const captured = Date.parse(observation.capturedAt), consumed = Date.parse(consumedAt), expires = Date.parse(observation.expiresAt);
    Object.assign(result, { capturedAt: observation.capturedAt, consumedAt, expiresAt: observation.expiresAt });
    if (![captured, consumed, expires].every(Number.isFinite) || end > captured || consumed < captured || consumed >= expires
      || consumed > startedAt || expires - captured !== 60_000 || startedAt < captured || startedAt >= expires)
      return unknown('original-capture-consumer-and-live-ttl-required');
    const readRuns = deps.runs ?? (await import('../testing-run-store')).readHarnessTestRunEvidence;
    const runs = await readRuns({ workspaceId: input.workspaceId,
      harnessSlug: input.harnessSlug, runGroupId: artifact.nativeOperationalRun.runGroupId,
      testRunIds: artifact.nativeOperationalRun.testRunIds, filePath: DREAM_CONTROL_LIVE_TEST });
    const run = runs?.length === 1 ? runs[0] : undefined;
    const execution = parseTestRunExecutionDetails(run?.execution_details);
    const witness = stableRecordedRuntimeEnvironment(execution?.runtimeEnvironmentBefore, execution?.runtimeEnvironmentAfter);
    if (!run || run.id !== binding.testRunId || run.id !== artifact.nativeOperationalRun.testRunIds[0]
      || run.workspace_id !== input.workspaceId || run.harness_slug !== input.harnessSlug
      || run.run_group_id !== artifact.nativeOperationalRun.runGroupId || run.file_path !== DREAM_CONTROL_LIVE_TEST
      || run.status !== 'pass' || run.framework !== 'operational' || run.worktree_dirty !== false
      || run.commit_sha !== artifact.pinnedCommit || !execution || execution.worktreeDirty || execution.collectionFailed
      || execution.workspaceId !== input.workspaceId || execution.harnessSlug !== input.harnessSlug
      || execution.filePath !== DREAM_CONTROL_LIVE_TEST || execution.runGroupId !== run.run_group_id
      || execution.commitSha !== run.commit_sha || execution.passed < 1 || execution.failed !== 0 || execution.skipped !== 0
      || !execution.operational || !witness || !isDeepStrictEqual([...witness.units].sort(), [...DREAM_CONTROL_RUNTIME_UNITS].sort())
      || !execution.passedCaseTitles?.includes(`method:edition-sha256:${dreamControlEditionDigest(artifact.edition)}`)
      || Date.parse(execution.runtimeEnvironmentBefore!.observedAt) > captured
      || Date.parse(execution.runtimeEnvironmentAfter!.observedAt) < consumed
      || !run.finished_at || new Date(run.finished_at).getTime() < consumed || new Date(run.finished_at).getTime() > startedAt)
      return unknown('native-run-does-not-attest-exact-edition');
    refs.push(`test-run:${run.id}`);
    const runtimes = await (deps.runtimes ?? ((ws, units) => listRuntimeVintage(ws, undefined, units)))(input.workspaceId, DREAM_CONTROL_RUNTIME_UNITS);
    if ((deps.runtimeFingerprint ?? measureRuntimeVintageEnvironment)(runtimes, DREAM_CONTROL_RUNTIME_UNITS) !== witness.fingerprint)
      return unknown('current-native-runtime-witness-mismatch');
    for (const [unit, expected] of [[DREAM_CONTROL_RUNTIME_UNITS[0], scope.expectedRuntime],
      [DREAM_CONTROL_RUNTIME_UNITS[1], scope.expectedActionRuntime]] as const) {
      const current = runtimes.filter(row => row.unit === unit);
      if (current.length !== 1 || current[0].workspaceId !== input.workspaceId
        || current[0].extra.kernelProcessIdentity !== expected.processId || !sameCommit(current[0].treeSha, expected.buildSha))
        return unknown('current-api-or-background-identity-mismatch');
      refs.push(`runtime-vintage:${unit}:${expected.processId}:${expected.buildSha}`);
    }
    const measuredCommit = binding.serverMeasurement.measuredAtCommit;
    if (!measuredCommit || !commit.safeParse(measuredCommit).success) return unknown('current-source-commit-required');
    const files = new Map(artifact.sourceFiles.map(file => [file.path, file.sha256]));
    if (files.size !== artifact.sourceFiles.length || DREAM_CONTROL_LIVE_SOURCES.some(path => !files.has(path))
      || artifact.sourceFiles.some(file => !/^[a-zA-Z0-9_./-]+$/.test(file.path) || file.path.split('/').some(p => !p || p === '.' || p === '..')))
      return unknown('complete-source-test-and-fixture-identities-required');
    const source = deps.source ?? (async (ref: string, path: string) => {
      const found = await runGit(['show', `${ref}:${path}`], moduleRepoRoot(import.meta.url));
      return found.code === 0 ? found.stdout : null;
    });
    const checks = artifact.sourceFiles.flatMap(file => {
      const builds = [artifact.pinnedCommit, measuredCommit,
        ...(apiSources.includes(file.path) ? [scope.expectedRuntime.buildSha] : []),
        ...(backgroundSources.includes(file.path) ? [scope.expectedActionRuntime!.buildSha] : [])];
      return [...new Set(builds)].map(async ref => {
        if (!commit.safeParse(ref).success) return false;
        const body = await source(ref, file.path);
        return body !== null && digest(body) === file.sha256;
      });
    });
    if (!(await Promise.all(checks)).every(Boolean)) return unknown('source-test-fixture-or-loaded-build-hash-mismatch');
    // Re-evaluate retained journal decisions through the maintained reader; saved
    // derived assessments and green clause labels cannot replace raw decisions.
    if ('actionDecisions' in observation && observation.actionDecisions.status === 'observed') {
      const actual = assessDreamActionDecisions(observation.actionDecisions.value.journal, scope);
      if (!isDeepStrictEqual(actual, observation.actionDecisions.value.assessment)) return unknown('dream-journal-assessment-mismatch');
    }
    if ('gymDecisions' in observation && observation.gymDecisions.status === 'observed') {
      const actual = assessGymAdmissionDecisions(observation.gymDecisions.value.journal, scope);
      if (!isDeepStrictEqual(actual, observation.gymDecisions.value.assessment)) return unknown('gym-journal-assessment-mismatch');
    }
    const clauses = assessDreamR2ClauseAssertions(observation, consumed);
    if (!isDeepStrictEqual(clauses, observation.r2Assertions) || !isDeepStrictEqual(clauses.clauses.map(c => c.id), clauseIds))
      return unknown('missing-or-inconsistent-product-clause');
    for (const clause of clauses.clauses) {
      for (const ref of clause.rawRefs) {
        const resolved = ref.slice(1).split('/').reduce<unknown>((v, key) =>
          v && typeof v === 'object' && Object.hasOwn(v, key) ? (v as Record<string, unknown>)[key] : undefined, observation);
        if (!ref.startsWith('/') || resolved === undefined) return unknown('unresolved-raw-reference');
      }
    }
    result.clauses = clauses.clauses;
    const current = assessDreamControlObservationCurrentness(observation, scope, now());
    if (!current.current) return unknown(current.reason ?? 'observation-no-longer-current');
    return { ...result, verdict: clauses.clauses.some(c => c.status === 'fail') ? 'fail'
      : clauses.healthy ? 'pass' : 'unknown', reason: clauses.healthy ? 'all-five-live-product-clauses-observed'
        : 'product-clauses-failed-or-unresolved', evidenceRefs: refs };
  } catch (error) {
    return unknown(`live-evidence-unavailable:${error instanceof Error ? error.message : String(error)}`);
  }
}
