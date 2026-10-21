/** R-9 pilot: immutable spec bindings hold the freeze; the item holds only its pointer. */
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { withWorkspace } from '@papercusp/db-org';
import { ANY_FAMILY_TERMINAL_STATES } from '../../work-item-dispatch-states';
import { parseTestRunExecutionDetails } from '@papercusp/test-config/execution-details';
import { areAcceptanceLineageRelated } from '../../acceptance-author-identity';
import { parseWorkedByHistory } from '../../work-item-prior-work';
import type { WorkItem } from '../../work-items';
import { readPlanBySlug } from '../plans/source';
import {
  listSpecEvidence, measureRepoFilesEvidenceAtRoot, repoFilesEvidenceMeasurementSchema,
  resolveMeasurementRoot,
} from '../plans/spec-evidence-store';
import { readMeasurementPin } from '../plans/evidence-measurement-pin';
import { fingerprintRepoFileSetAtCommit } from '../plans/committed-tree-reader';
import { changedFrozenTests, readFrozenTestFiles, type FrozenTestFile } from './frozen-tests-hash';

export const frozenTestsRegistrationSchema = z.object({
  bindingId: z.number().int().positive().describe('Independent author\'s current manual spec binding; measurement sourcePaths and testPaths must be exactly the frozen tests.'),
  redRunIds: z.array(z.number().int().positive()).min(1).max(32),
  expectedRevision: z.number().int().nonnegative(),
  decisionId: z.string().regex(/^D-\d+$/).optional().describe('Required for re-freeze: Decision with a frozen-tests JSON fence naming itemId, fromRevision, toRevision, previousBindingId, bindingId and reason.'),
}).strict();
type Registration = z.infer<typeof frozenTestsRegistrationSchema>;
type Manifest = { revision: number; bindingId: number; planSlug: string; redRunIds: number[]; frozenAt: string; decisionId?: string };
type Scope = { workspaceId: string; harnessSlug: string; planSlug: string };
type Evidence = Awaited<ReturnType<typeof listSpecEvidence>>[number];

export interface FrozenTestsDeps {
  plan: typeof readPlanBySlug;
  evidence: typeof listSpecEvidence;
  root: typeof resolveMeasurementRoot;
  related: (a: string, b: string, workspaceId: string) => Promise<boolean>;
}
const defaults: FrozenTestsDeps = {
  plan: readPlanBySlug, evidence: listSpecEvidence, root: resolveMeasurementRoot,
  related: (a, b, workspaceId) => areAcceptanceLineageRelated(a, b, { workspaceId }),
};
/** Test seam replaces read boundaries only; manifest writes always use the real transaction. */
export const frozenTestsTestSeams: { deps?: FrozenTestsDeps } = {};
const depsNow = () => frozenTestsTestSeams.deps ?? defaults;
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
const manifestSchema = z.object({ revision: z.number().int().positive(), bindingId: z.number().int().positive(), planSlug: z.string().min(1),
  redRunIds: z.array(z.number().int().positive()).min(1).max(32), frozenAt: z.string().datetime(), decisionId: z.string().optional() }).strict();
const failed = (code: string, message: string) => ({ ok: false as const, code, error: message });

function planStamp(item: WorkItem): string | null {
  const payload = item.payload as { plan_item?: { plan_slug?: unknown } } | null;
  return item.sourcePlanSlug ?? (typeof payload?.plan_item?.plan_slug === 'string' ? payload.plan_item.plan_slug : null);
}
function manifestOf(item: WorkItem): Manifest | null {
  const parsed = manifestSchema.safeParse((item.payload as Record<string, unknown> | null)?._frozenTests);
  return parsed.success ? parsed.data : null;
}

async function implementers(scope: Scope, id: string): Promise<string[]> {
  return withWorkspace(scope.workspaceId, async tx => {
    const rows = await tx<Array<{ taken_by: string | null; terminal_owner: string | null; last_released_by: string | null; worked_by_history: unknown }>>`
      SELECT taken_by, terminal_owner, last_released_by, worked_by_history
      FROM harness_shared.work_items WHERE workspace_id=${scope.workspaceId}
        AND harness_slug=${scope.harnessSlug} AND feature_id=${id}`;
    const row = rows[0];
    if (!row || (row.worked_by_history != null && !Array.isArray(row.worked_by_history))) throw new Error('frozen_tests_implementer_history_unavailable');
    return [...new Set([row.taken_by, row.terminal_owner, row.last_released_by,
      ...parseWorkedByHistory(row.worked_by_history)].filter((id): id is string => Boolean(id)))];
  });
}
async function independent(scope: Scope, item: WorkItem, author: string, deps: FrozenTestsDeps): Promise<boolean> {
  const authors = [...new Set([item.assignee, ...(await implementers(scope, item.id))].filter((id): id is string => Boolean(id)))];
  if (!authors.length) throw new Error('frozen_tests_implementer_unassigned');
  if (!author) return false;
  for (const builder of authors) if (builder === author || await deps.related(author, builder, scope.workspaceId)) return false;
  return true;
}
function freezeFiles(binding: Evidence): FrozenTestFile[] | null {
  const measurement = repoFilesEvidenceMeasurementSchema.safeParse(binding.details.currentMeasurement);
  const pin = readMeasurementPin(binding.details);
  if (!measurement.success || !pin || measurement.data.rootHarnessSlug || measurement.data.sourceGlobs || !measurement.data.testPaths) return null;
  const paths = [...new Set(measurement.data.testPaths)].sort();
  if (JSON.stringify(paths) !== JSON.stringify([...new Set(measurement.data.sourcePaths)].sort())) return null;
  const files = pin.files.filter(file => file.dimension === 'test' && paths.includes(file.path) && !file.rootHarnessSlug);
  if (files.length !== paths.length || paths.some(path => !files.some(file => file.path === path))) return null;
  return files.map(({ path, sha256 }) => ({ path, sha256 }));
}
async function freezeBinding(scope: Scope, item: WorkItem, bindingId: number, deps: FrozenTestsDeps) {
  const rows = await deps.evidence({ workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug,
    planSlugs: [scope.planSlug], workItemIds: [item.id], bindingIds: [bindingId] });
  const binding = rows.find(row => row.id === bindingId && row.workItemId === item.id && row.planSlug === scope.planSlug);
  if (!binding || binding.evidenceKind !== 'manual' || binding.withdrawal || binding.currentness.overall !== 'current'
    || binding.serverMeasurement?.status !== 'measured') throw new Error('frozen_tests_binding_unavailable_or_stale');
  const files = freezeFiles(binding);
  if (!files?.length) throw new Error('frozen_tests_binding_requires_test_only_measurement_pin');
  if (!await independent(scope, item, binding.createdBy, deps)) throw new Error('frozen_tests_author_in_implementer_lineage');
  const root = await deps.root(scope.workspaceId, scope.harnessSlug, binding.details.currentMeasurement as never);
  const changed = changedFrozenTests(files, await readFrozenTestFiles(root, files.map(file => file.path)));
  if (changed.length) throw new Error(`frozen_tests_changed:${changed.join(',')}`);
  return { binding, files, root };
}

async function verifyRedCalibration(scope: Scope, root: string, files: FrozenTestFile[], runIds: number[], before: string) {
  const rows = await withWorkspace(scope.workspaceId, tx => tx<Array<{
    id: number; file_path: string; status: string; execution_details: unknown; commit_sha: string | null;
    worktree_dirty: boolean | null; finished_at: Date | string;
  }>>`SELECT id,file_path,status,execution_details,commit_sha,worktree_dirty,finished_at
    FROM harness_shared.test_runs WHERE workspace_id=${scope.workspaceId} AND harness_slug=${scope.harnessSlug}
      AND id=ANY(${runIds}::bigint[])`);
  const covered = new Set<string>();
  for (const row of rows) {
    const execution = parseTestRunExecutionDetails(row.execution_details);
    if (!execution || !['fail','failed'].includes(row.status) || execution.failed < 1 || !execution.failedCaseTitles?.length
      || execution.skipped || execution.collectionFailed || row.worktree_dirty !== false || execution.worktreeDirty
      || !row.commit_sha?.match(/^[a-f0-9]{40}$/) || execution.commitSha !== row.commit_sha
      || execution.workspaceId !== scope.workspaceId || execution.harnessSlug !== scope.harnessSlug
      || new Date(row.finished_at).getTime() > Date.parse(before)) continue;
    const path = isAbsolute(row.file_path) ? relative(root, row.file_path)
      : files.some(file => file.path === row.file_path) ? row.file_path : relative(root, resolve(execution.root, row.file_path));
    const frozen = files.find(file => file.path === path);
    if (!frozen) continue;
    const measured = await fingerprintRepoFileSetAtCommit(root, row.commit_sha, [path]);
    if (measured.files[0]?.sha256 === frozen.sha256) covered.add(path);
  }
  if (files.some(file => !covered.has(file.path))) throw new Error('frozen_tests_red_calibration_missing_or_wrong_bytes');
}

function refreezeDecision(content: string, decisionId: string, item: WorkItem, previous: Manifest, next: Registration): boolean {
  // Parse only the named Decision, never a matching-looking fence elsewhere in the plan.
  const decisions = content.split(/(?=^### D-\d+\b)/m);
  const section = decisions.find(text => new RegExp(`^### ${decisionId}\\b`).test(text));
  for (const match of section?.matchAll(/```frozen-tests\s*\n([\s\S]*?)\n```/g) ?? []) {
    try {
      const record = JSON.parse(match[1]!);
      if (record.itemId === item.id && record.fromRevision === previous.revision
        && record.toRevision === previous.revision + 1 && record.previousBindingId === previous.bindingId
        && record.bindingId === next.bindingId && typeof record.reason === 'string' && record.reason.trim()) return true;
    } catch { /* A malformed fence cannot authorize replacement. */ }
  }
  return false;
}

export async function registerFrozenTests(input: { item: WorkItem; actorId: string; scope: Scope; registration: Registration }) {
  const { item, actorId, scope, registration } = input;
  const deps = depsNow();
  try {
    if (planStamp(item) !== scope.planSlug) throw new Error('frozen_tests_plan_link_mismatch');
    const plan = await deps.plan(scope.planSlug, { workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug });
    if (plan?.parsed.frontmatter.frozenTests !== 'pilot') throw new Error('frozen_tests_plan_not_opted_in');
    const previous = manifestOf(item);
    if ((previous?.revision ?? 0) !== registration.expectedRevision) throw new Error('frozen_tests_revision_conflict');
    const frozen = await freezeBinding(scope, item, registration.bindingId, deps);
    if (frozen.binding.createdBy !== actorId) throw new Error('frozen_tests_only_binding_author_can_register');
    if (previous) {
      if (!registration.decisionId || !refreezeDecision(plan.row.content, registration.decisionId, item, previous, registration)) throw new Error('frozen_tests_refreeze_decision_required');
      const old = await deps.evidence({ workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug,
        planSlugs: [scope.planSlug], workItemIds: [item.id], bindingIds: [previous.bindingId], includeRetracted: true });
      const author = old.find(row => row.id === previous.bindingId)?.createdBy;
      if (!author || (author !== actorId && !await deps.related(author, actorId, scope.workspaceId))) throw new Error('frozen_tests_refreeze_requires_original_author');
    }
    await verifyRedCalibration(scope, frozen.root, frozen.files, registration.redRunIds, frozen.binding.createdAt);
    const manifest: Manifest = { revision: registration.expectedRevision + 1, bindingId: registration.bindingId, planSlug: scope.planSlug,
      redRunIds: registration.redRunIds, frozenAt: new Date().toISOString(), ...(registration.decisionId ? { decisionId: registration.decisionId } : {}) };
    const rows = await withWorkspace(scope.workspaceId, tx => tx<Array<{ feature_id: string }>>`
      UPDATE harness_shared.work_items SET payload=jsonb_set(COALESCE(payload,'{}'::jsonb),'{_frozenTests}',${JSON.stringify(manifest)}::text::jsonb)
      WHERE workspace_id=${scope.workspaceId} AND harness_slug=${scope.harnessSlug} AND feature_id=${item.id}
        AND COALESCE((payload #>> '{_frozenTests,revision}')::int,0)=${registration.expectedRevision}
        AND NOT (status = ANY(${[...ANY_FAMILY_TERMINAL_STATES]}::text[])) RETURNING feature_id`);
    if (!rows.length) throw new Error('frozen_tests_revision_conflict_or_terminal_item');
    return { ok: true as const, id: item.id, frozenTests: { ...manifest, files: frozen.files, author: actorId } };
  } catch (error) { return failed('frozen_tests_registration_refused', errorText(error)); }
}

export async function frozenTestsClosureRefusal(input: { item: WorkItem; scope: Scope; plan?: Awaited<ReturnType<typeof readPlanBySlug>> }) {
  const { item, scope } = input;
  const deps = depsNow();
  try {
    const plan = input.plan ?? await deps.plan(scope.planSlug, { workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug });
    if (!plan) throw new Error('frozen_tests_plan_unavailable');
    if (plan.parsed.frontmatter.frozenTests !== 'pilot') return null;
    const manifest = manifestOf(item);
    if (!manifest || manifest.planSlug !== scope.planSlug) throw new Error('frozen_tests_manifest_required');
    const frozen = await freezeBinding(scope, item, manifest.bindingId, deps);
    await verifyRedCalibration(scope, frozen.root, frozen.files, manifest.redRunIds, frozen.binding.createdAt);
    const proof = await deps.evidence({ workspaceId: scope.workspaceId, harnessSlug: scope.harnessSlug,
      planSlugs: [scope.planSlug], workItemIds: [item.id], evidenceKinds: ['test'] });
    const covered = new Set<string>();
    for (const row of proof) {
      const run = row.testRunExecution;
      if (row.workItemId !== item.id || row.planSlug !== scope.planSlug || row.withdrawal
        || row.currentness.overall !== 'current' || row.serverMeasurement?.status !== 'measured'
        || !run || !['pass','passed'].includes(run.status ?? '') || run.passed < 1 || run.failed || run.skipped || run.collectionFailed
        || Date.parse(row.observedAt) < Date.parse(manifest.frozenAt)) continue;
      const measurement = repoFilesEvidenceMeasurementSchema.safeParse(row.details.currentMeasurement);
      if (!measurement.success || measurement.data.rootHarnessSlug) continue;
      // The working tree must match too; a committed HEAD measurement alone cannot see an in-flight edit.
      const actual = await measureRepoFilesEvidenceAtRoot(frozen.root, measurement.data);
      if (actual.sourceFingerprint !== row.fingerprints.sourceFingerprint || actual.testFingerprint !== row.fingerprints.testFingerprint) continue;
      const recordedPath = (row.details.testRun as { filePath?: unknown } | undefined)?.filePath;
      const path = typeof recordedPath === 'string' ? recordedPath : run.filePath;
      const runPath = isAbsolute(path) ? relative(frozen.root, path) : path;
      if (measurement.data.testPaths?.includes(runPath) && frozen.files.some(file => file.path === runPath)) covered.add(runPath);
    }
    if (frozen.files.some(file => !covered.has(file.path))) throw new Error('frozen_tests_passing_current_run_required');
    return null;
  } catch (error) { return failed('frozen_tests_completion_refused', errorText(error)); }
}
