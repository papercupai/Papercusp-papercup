/**
 * Evidence binds itself from the test ledger (agent-paperwork-and-restart-tax-reduction-2026-10-15
 * P-002 / R-2).
 *
 * WHY. A requirement whose verification is `check: { kind: 'tests', files: [...] }` names the
 * exact files that prove it, and every run of those files already lands in
 * `harness_shared.test_runs`. Binding that run by hand (`plans:bind-spec-evidence
 * { fromTestRun }`) was pure transcription — the agent copied an id the ledger already held —
 * and an unbound clause refused the work-item's close. This sweep does the binding instead.
 *
 * WHAT COUNTS AS QUALIFYING. For each enforceable spec clause projected from a requirement
 * (`source_bar_key`), on a live plan, with a work-item edge at its current revision, and each
 * test file the requirement's LIVE block names (P-001: the plan, never the rubric copy):
 *  - the LATEST terminal run of that file in the plan's harness (pass | fail | error; mutation
 *    probes excluded — they are R-3's evidence, bound with their own causal controls);
 *  - a clean, commit-stamped PASS binds, through `bindSpecEvidenceItems` — the same pipeline an agent call runs,
 *    including its refusal of a run that predates the code (`test_run_source_modified_after_run`)
 *    — with `supersedeAtRevision`, so the older proof for the same file is retracted;
 *  - the run must have executed code a COMMIT contains: the ledger records a clean checkout
 *    and its commit, and every measured path is committed in the current checkout. A dirty run
 *    cannot establish this from the declared path subset alone; use the existing
 *    `lint:as-committed` runner to record a qualifying pass. Dirty/unknown passes never replace
 *    clean proof. An uncommitted measured path DEFERS the bind until git-sync;
 *  - a FAIL or ERROR newer than a live binding's run RETRACTS that binding, whoever authored it:
 *    the store re-checks file fingerprints, not later outcomes, so without this a passing proof
 *    would stay current over a newer failure.
 *
 * SAFETY. Bounded (AUTOBIND_MAX_ACTIONS_PER_RUN writes per tick), idempotent (a run already bound
 * is a no-op; exact replays dedupe in the store), every write attributed to AUTOBIND_ACTOR_ID and
 * every retraction stamped with the run that superseded it. Never throws from the sweep entry.
 */
import { withWorkspace } from '@papercusp/db-org';
import { pinModuleState } from '@papercusp/module-singleton';
import { parseRequirementBars } from '../../acceptance-bar-seed';
import { loadHarnessRegistry, resolveHarnessContentPath } from '../../harness-registry';
import { activeWorkspaceId } from '../../workspace-registry';
import { expandTestRunBinding, type TestRunBindingInput, type TestRunBindingScope } from './bind-from-test-run';
import { bindSpecEvidenceItems } from './bind-spec-evidence';
import { defaultGitRunner, type GitRunner } from './evidence-measurement-pin';
import { repoFilesEvidenceMeasurementSchema, retractSpecEvidence,
  type RepoFilesEvidenceMeasurement } from './spec-evidence-store';

export const AUTOBIND_ACTOR_ID = 'system:spec-evidence-autobind';
export const AUTOBIND_LIVE_PLAN_STATUSES = ['ready', 'active', 'awaiting-acceptance'] as const;
export const AUTOBIND_MAX_ACTIONS_PER_RUN = 50;
export const AUTOBIND_RUN_LOOKBACK_DAYS = 14;

/** One (clause revision, named test file) pair the sweep keeps bound. */
export interface AutobindTarget {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
  specId: string;
  specRevision: number;
  workItemId: string;
  barKey: string;
  testFile: string;
}

export interface AutobindLedgerRun {
  id: number;
  filePath: string;
  status: 'pass' | 'fail' | 'error';
  finishedAt: string;
  commitSha: string | null;
  worktreeDirty: boolean | null;
}

/** A live (un-retracted) `test` binding on the target's logical clause revision. */
export interface AutobindLiveBinding {
  id: number;
  evidenceRef: string;
  testRunId: number | null;
  observedAt: string;
  measurement?: unknown;
  createdBy?: string | null;
}

/** Carry an authored recipe, never old fingerprints or calibration attestations, to a NEW run. */
export function prepareAutobindInput(
  target: AutobindTarget,
  run: AutobindLedgerRun,
  derived: RepoFilesEvidenceMeasurement,
  live: readonly AutobindLiveBinding[],
): { ok: true; input: TestRunBindingInput } | { ok: false; error: string; message: string } {
  const recipes: RepoFilesEvidenceMeasurement[] = [];
  let authoredRecipe = false;
  const refuse = (error: string, message: string) => ({ ok: false as const, error, message });
  for (const binding of bindingsForTarget(target, live)) {
    if (binding.measurement == null) continue;
    const parsed = repoFilesEvidenceMeasurementSchema.safeParse(binding.measurement);
    if (!parsed.success) return refuse('autobind_recipe_unverified', `Binding ${binding.id} has an invalid measurement recipe; author a complete recipe before automatic binding.`);
    const recipe = parsed.data;
    if (recipe.runtimeUnits || recipe.completedRuntime || recipe.artifactReceiptPath || recipe.nativeInstrumentKey ||
        recipe.rootHarnessSlug !== derived.rootHarnessSlug ||
        recipe.testPaths?.some(file => normalizeTestRef(file) !== normalizeTestRef(target.testFile))) {
      return refuse('autobind_recipe_incompatible', `Binding ${binding.id} requires execution or root evidence that cannot be inherited by this run.`);
    }
    recipes.push(recipe);
    if (binding.createdBy && binding.createdBy !== AUTOBIND_ACTOR_ID) authoredRecipe = true;
  }
  const fixtureRecipes = recipes.filter(recipe => recipe.fixturePaths?.length || recipe.fixtureGlobs?.length);
  if (fixtureRecipes.length === 0 && !authoredRecipe) {
    return refuse('autobind_fixture_recipe_required', 'No measured fixture recipe exists for this clause and test file. Bind its complete recipe once; automatic binding must not freeze an incomplete first recipe.');
  }
  const fixtureRoots = new Set(fixtureRecipes.map(recipe => recipe.fixtureRootHarnessSlug ?? target.harnessSlug));
  if (fixtureRoots.size > 1) return refuse('autobind_recipe_incompatible', 'Prior fixture recipes use different harness roots; automatic binding cannot merge them.');
  const union = (values: Array<readonly string[] | undefined>) => [...new Set(values.flatMap(value => value ?? []))].sort();
  const sourceGlobs = union([derived.sourceGlobs, ...recipes.map(recipe => recipe.sourceGlobs)]);
  const fixturePaths = union(fixtureRecipes.map(recipe => recipe.fixturePaths));
  const fixtureGlobs = union(fixtureRecipes.map(recipe => recipe.fixtureGlobs));
  const fixtureRootHarnessSlug = fixtureRecipes.find(recipe => recipe.fixtureRootHarnessSlug)?.fixtureRootHarnessSlug;
  // A whole-tree census binding keeps its registered tree instrument; dropping it would
  // leave the new binding unmeasurable (the broad-scan guard refuses it).
  const treeInstrumentKeys = [...new Set(recipes.flatMap(recipe => recipe.treeInstrumentKey ? [recipe.treeInstrumentKey] : []))];
  if (treeInstrumentKeys.length > 1) {
    return refuse('autobind_recipe_incompatible', 'Prior recipes name different tree instruments; automatic binding cannot merge them.');
  }
  const treeInstrumentKey = treeInstrumentKeys[0];
  const input: TestRunBindingInput = {
    workItemId: target.workItemId, specId: target.specId, specRevision: target.specRevision, fromTestRun: run.id,
    sourcePaths: union([derived.sourcePaths, ...recipes.map(recipe => recipe.sourcePaths)]),
    ...(sourceGlobs.length ? { sourceGlobs } : {}),
    ...(treeInstrumentKey ? { treeInstrumentKey } : {}),
    ...(fixturePaths.length ? { fixturePaths } : {}),
    ...(fixtureGlobs.length ? { fixtureGlobs } : {}),
    ...(fixtureRootHarnessSlug ? { fixtureRootHarnessSlug } : {}),
  };
  const measurement = repoFilesEvidenceMeasurementSchema.safeParse({
    ...derived, sourcePaths: input.sourcePaths,
    ...(input.sourceGlobs ? { sourceGlobs: input.sourceGlobs } : {}),
    ...(input.treeInstrumentKey ? { treeInstrumentKey: input.treeInstrumentKey } : {}),
    ...(input.fixturePaths ? { fixturePaths: input.fixturePaths } : {}),
    ...(input.fixtureGlobs ? { fixtureGlobs: input.fixtureGlobs } : {}),
    ...(input.fixtureRootHarnessSlug ? { fixtureRootHarnessSlug: input.fixtureRootHarnessSlug } : {}),
  });
  return measurement.success ? { ok: true, input }
    : refuse('autobind_recipe_unverified', 'The combined measured recipe exceeds supported bounds; author a complete bounded recipe before automatic binding.');
}

export type AutobindDecision =
  | { kind: 'noop'; target: AutobindTarget; reason: 'no-terminal-run' | 'run-not-committed' | 'already-bound' | 'newer-proof-bound' | 'nothing-to-retract' }
  | { kind: 'bind'; target: AutobindTarget; run: AutobindLedgerRun }
  | { kind: 'retract'; target: AutobindTarget; run: AutobindLedgerRun; bindingIds: number[] };

export function normalizeTestRef(ref: string): string {
  return ref.trim().replaceAll('\\', '/').replace(/\/{2,}/g, '/').replace(/^\.\//, '').replace(/^test-run:/, '');
}

/** Which live bindings prove THIS target's file. */
export function bindingsForTarget(target: AutobindTarget, live: readonly AutobindLiveBinding[]): AutobindLiveBinding[] {
  const file = normalizeTestRef(target.testFile);
  return live.filter((binding) => normalizeTestRef(binding.evidenceRef) === file);
}

/**
 * The pure rule. `latestRun` is the newest terminal ledger run of the target's file; `live` are
 * the live test bindings already filtered to the target's file.
 */
export function decideAutobind(
  target: AutobindTarget,
  latestRun: AutobindLedgerRun | null,
  live: readonly AutobindLiveBinding[],
): AutobindDecision {
  if (!latestRun) return { kind: 'noop', target, reason: 'no-terminal-run' };
  if (latestRun.status === 'pass') {
    if (latestRun.worktreeDirty !== false || !/^[0-9a-f]{40,64}$/i.test(latestRun.commitSha ?? '')) {
      return { kind: 'noop', target, reason: 'run-not-committed' };
    }
    if (live.some((binding) => binding.testRunId != null && binding.testRunId > latestRun.id)) {
      return { kind: 'noop', target, reason: 'newer-proof-bound' };
    }
    return live.some((binding) => binding.testRunId === latestRun.id)
      ? { kind: 'noop', target, reason: 'already-bound' }
      : { kind: 'bind', target, run: latestRun };
  }
  const failedAt = Date.parse(latestRun.finishedAt);
  const superseded = live.filter((binding) =>
    binding.testRunId != null ? binding.testRunId < latestRun.id : Date.parse(binding.observedAt) < failedAt,
  );
  return superseded.length === 0
    ? { kind: 'noop', target, reason: 'nothing-to-retract' }
    : { kind: 'retract', target, run: latestRun, bindingIds: superseded.map((binding) => binding.id) };
}

export type AutobindOutcome =
  | { kind: 'bound'; target: AutobindTarget; runId: number }
  | { kind: 'retracted'; target: AutobindTarget; runId: number; bindingIds: number[] }
  | { kind: 'deferred'; target: AutobindTarget; runId: number; reason: 'code-not-committed'; paths: string[] }
  | { kind: 'refused'; target: AutobindTarget; runId: number; error: string; message?: string };

export interface AutobindDeps {
  loadTargets(workspaceId: string): Promise<AutobindTarget[]>;
  loadLatestRuns(workspaceId: string, targets: readonly AutobindTarget[]): Promise<Map<string, AutobindLedgerRun>>;
  loadLiveBindings(workspaceId: string, targets: readonly AutobindTarget[]): Promise<Map<string, AutobindLiveBinding[]>>;
  /** The measured paths of binding this run, or the expansion's refusal (e.g. the run predates the code). */
  measuredPaths(
    target: AutobindTarget,
    run: AutobindLedgerRun,
    live: readonly AutobindLiveBinding[],
  ): Promise<{ ok: true; root: string; paths: string[]; input?: TestRunBindingInput } | { ok: false; error: string; message: string }>;
  /** Paths among `paths` with uncommitted changes in `root`. */
  uncommittedPaths(root: string, paths: readonly string[]): Promise<string[]>;
  bind(target: AutobindTarget, run: AutobindLedgerRun, input?: TestRunBindingInput): Promise<{ ok: true } | { ok: false; error: string; message?: string }>;
  retract(target: AutobindTarget, bindingId: number, reason: string): Promise<void>;
}

export const runKey = (harnessSlug: string, file: string) => `${harnessSlug}\u0000${normalizeTestRef(file)}`;

/** A revision changes the clause, not the identity of its authored fixture recipe. */
export function recipeBindingsForTarget(
  target: AutobindTarget, bindings: ReadonlyMap<string, readonly AutobindLiveBinding[]>,
): AutobindLiveBinding[] {
  const matching: AutobindLiveBinding[] = [];
  for (const [key, rows] of bindings) {
    const [harness, plan, spec] = key.split('\u0000');
    if (harness === target.harnessSlug && plan === target.planSlug && spec === target.specId) {
      matching.push(...bindingsForTarget(target, rows));
    }
  }
  return matching;
}
// Match adequacy's logical evidence identity: the work-item is the binding's
// origin, not a separate proof. A same-receipt bind on another item can otherwise
// append weaker metadata over richer manual proof, and repeat after retraction.
export const clauseKey = (t: Pick<AutobindTarget, 'harnessSlug' | 'planSlug' | 'specId' | 'specRevision'>) =>
  [t.harnessSlug, t.planSlug, t.specId, t.specRevision].join('\u0000');

export interface AutobindRunResult {
  targets: number;
  decisions: Record<AutobindDecision['kind'], number>;
  outcomes: AutobindOutcome[];
  truncatedByLimit: boolean;
  summary: string;
}

/** Decide every target, then act on at most `maxActions` of them. */
export async function runSpecEvidenceAutobind(
  workspaceId: string,
  deps: AutobindDeps,
  maxActions = AUTOBIND_MAX_ACTIONS_PER_RUN,
): Promise<AutobindRunResult> {
  const targets = await deps.loadTargets(workspaceId);
  const [runs, bindings] = targets.length
    ? await Promise.all([deps.loadLatestRuns(workspaceId, targets), deps.loadLiveBindings(workspaceId, targets)])
    : [new Map<string, AutobindLedgerRun>(), new Map<string, AutobindLiveBinding[]>()];
  const decisions = targets.map((target) =>
    decideAutobind(
      target,
      runs.get(runKey(target.harnessSlug, target.testFile)) ?? null,
      bindingsForTarget(target, bindings.get(clauseKey(target)) ?? []),
    ),
  );
  const counts: AutobindRunResult['decisions'] = { noop: 0, bind: 0, retract: 0 };
  for (const decision of decisions) counts[decision.kind] += 1;
  const actionable = decisions.filter((decision) => decision.kind !== 'noop');
  const outcomes: AutobindOutcome[] = [];
  for (const decision of actionable.slice(0, maxActions)) {
    if (decision.kind === 'retract') {
      const reason =
        `superseded by ${decision.run.status} test-run ${decision.run.id} of ${decision.target.testFile} ` +
        `(finished ${decision.run.finishedAt}); a later failing run must not leave earlier proof current (${AUTOBIND_ACTOR_ID})`;
      for (const id of decision.bindingIds) await deps.retract(decision.target, id, reason);
      outcomes.push({ kind: 'retracted', target: decision.target, runId: decision.run.id, bindingIds: decision.bindingIds });
      continue;
    }
    if (decision.kind !== 'bind') continue;
    const measured = await deps.measuredPaths(decision.target, decision.run,
      recipeBindingsForTarget(decision.target, bindings));
    if (!measured.ok) {
      outcomes.push({ kind: 'refused', target: decision.target, runId: decision.run.id, error: measured.error, message: measured.message });
      continue;
    }
    const dirty = await deps.uncommittedPaths(measured.root, measured.paths);
    if (dirty.length > 0) {
      outcomes.push({ kind: 'deferred', target: decision.target, runId: decision.run.id, reason: 'code-not-committed', paths: dirty });
      continue;
    }
    // Source measurement can take long enough for an explicit proof to arrive.
    // Re-read at the write boundary instead of appending from the sweep snapshot.
    // The reader also guards the remaining race without mutating audit history.
    const current = await deps.loadLiveBindings(workspaceId, [decision.target]);
    const refreshed = decideAutobind(decision.target, decision.run,
      bindingsForTarget(decision.target, current.get(clauseKey(decision.target)) ?? []));
    if (refreshed.kind === 'noop') {
      counts.bind -= 1;
      counts.noop += 1;
      continue;
    }
    const bound = await deps.bind(decision.target, decision.run, measured.input);
    outcomes.push(
      bound.ok
        ? { kind: 'bound', target: decision.target, runId: decision.run.id }
        : { kind: 'refused', target: decision.target, runId: decision.run.id, error: bound.error, ...(bound.message ? { message: bound.message } : {}) },
    );
  }
  const tally = (kind: AutobindOutcome['kind']) => outcomes.filter((o) => o.kind === kind).length;
  const truncatedByLimit = actionable.length > maxActions;
  return {
    targets: targets.length,
    decisions: counts,
    outcomes,
    truncatedByLimit,
    summary:
      `${targets.length} target(s); bound=${tally('bound')} retracted=${tally('retracted')} ` +
      `deferred=${tally('deferred')} refused=${tally('refused')}${truncatedByLimit ? ` (capped at ${maxActions})` : ''}`,
  };
}

// ── default deps ─────────────────────────────────────────────────────────────

const memo = pinModuleState('@papercusp/operator-core.spec-evidence-autobind.plan-files', () => ({
  /** plan ref → { content hash, barKey → named test files } */
  plans: new Map<string, { contentHash: string; files: Map<string, string[]> }>(),
}));

/** barKey → named test files, from a plan's live `requirement` blocks. */
export function requirementTestFiles(planContent: string): Map<string, string[]> {
  const parsed = parseRequirementBars(planContent);
  const files = new Map<string, string[]>();
  if (!parsed.ok) return files;
  for (const bar of parsed.bars) {
    const check = (bar.criterion as { check?: { kind?: unknown; files?: unknown } } | undefined)?.check;
    if (check?.kind !== 'tests' || !Array.isArray(check.files)) continue;
    const named = check.files.filter((file): file is string => typeof file === 'string' && file.trim().length > 0);
    if (named.length > 0) files.set(bar.barKey, [...new Set(named.map(normalizeTestRef))]);
  }
  return files;
}

interface ClauseRow {
  harness_slug: string;
  plan_slug: string;
  content_hash: string | null;
  spec_id: string;
  current_revision: number;
  source_bar_key: string;
  work_item_id: string;
}

async function harnessRoot(workspaceId: string, harnessSlug: string): Promise<string> {
  const root = resolveHarnessContentPath(await loadHarnessRegistry(workspaceId), harnessSlug);
  if (!root) throw new Error(`autobind_harness_root_unavailable:${harnessSlug}`);
  return root;
}

export function defaultAutobindDeps(git: GitRunner = defaultGitRunner): AutobindDeps {
  return {
    async loadTargets(workspaceId) {
      const clauses = await withWorkspace(workspaceId, (tx) => tx<ClauseRow[]>`
        SELECT p.harness_slug, p.plan_slug, p.content_hash, c.spec_id, c.current_revision,
               r.source_bar_key, e.work_item_id
          FROM harness_shared.harness_plans p
          JOIN harness_shared.plan_spec_clauses c
            ON c.workspace_id = p.workspace_id AND c.harness_slug = p.harness_slug AND c.plan_slug = p.plan_slug
          JOIN harness_shared.plan_spec_clause_revisions r
            ON r.workspace_id = c.workspace_id AND r.harness_slug = c.harness_slug AND r.plan_slug = c.plan_slug
           AND r.spec_id = c.spec_id AND r.revision = c.current_revision
          JOIN harness_shared.work_item_spec_revision_edges e
            ON e.workspace_id = c.workspace_id AND e.harness_slug = c.harness_slug AND e.plan_slug = c.plan_slug
           AND e.spec_id = c.spec_id AND e.spec_revision = c.current_revision
         WHERE p.workspace_id = ${workspaceId}
           AND p.status = ANY(${[...AUTOBIND_LIVE_PLAN_STATUSES]}::text[])
           AND p.archived IS NOT TRUE
           AND r.source_bar_key IS NOT NULL
           AND r.lifecycle_status IN ('accepted', 'active')`);
      const stale = new Map<string, { harnessSlug: string; planSlug: string }>();
      for (const row of clauses) {
        const ref = `${workspaceId}/${row.harness_slug}/${row.plan_slug}`;
        if (memo.plans.get(ref)?.contentHash !== (row.content_hash ?? '')) {
          stale.set(ref, { harnessSlug: row.harness_slug, planSlug: row.plan_slug });
        }
      }
      for (const [ref, plan] of stale) {
        const [row] = await withWorkspace(workspaceId, (tx) => tx<{ content: string | null; content_hash: string | null }[]>`
          SELECT content, content_hash FROM harness_shared.harness_plans
           WHERE workspace_id = ${workspaceId} AND harness_slug = ${plan.harnessSlug} AND plan_slug = ${plan.planSlug}`);
        memo.plans.set(ref, { contentHash: row?.content_hash ?? '', files: requirementTestFiles(row?.content ?? '') });
      }
      return clauses.flatMap((row) => {
        const files = memo.plans.get(`${workspaceId}/${row.harness_slug}/${row.plan_slug}`)?.files.get(row.source_bar_key) ?? [];
        return files.map((testFile) => ({
          workspaceId,
          harnessSlug: row.harness_slug,
          planSlug: row.plan_slug,
          specId: row.spec_id,
          specRevision: Number(row.current_revision),
          workItemId: row.work_item_id,
          barKey: row.source_bar_key,
          testFile,
        }));
      });
    },
    async loadLatestRuns(workspaceId, targets) {
      const harnesses = [...new Set(targets.map((t) => t.harnessSlug))];
      const files = [...new Set(targets.map((t) => normalizeTestRef(t.testFile)))];
      const rows = await withWorkspace(workspaceId, (tx) => tx<
        { id: string | number; harness_slug: string; file_path: string; status: AutobindLedgerRun['status']; finished_at: Date | string;
          commit_sha: string | null; worktree_dirty: boolean | null }[]
      >`
        SELECT DISTINCT ON (harness_slug, file_path) id, harness_slug, file_path, status, finished_at, commit_sha, worktree_dirty
          FROM harness_shared.test_runs
         WHERE workspace_id = ${workspaceId}
           AND harness_slug = ANY(${harnesses}::text[])
           AND file_path = ANY(${files}::text[])
           AND status IN ('pass', 'fail', 'error')
           AND (status <> 'pass' OR (worktree_dirty IS FALSE AND commit_sha ~* '^[0-9a-f]{40,64}$'))
           AND finished_at IS NOT NULL
           AND source <> 'mutation-probe'
           AND started_at > now() - make_interval(days => ${AUTOBIND_RUN_LOOKBACK_DAYS})
         ORDER BY harness_slug, file_path, finished_at DESC, id DESC`);
      return new Map(
        rows.map((row) => [
          runKey(row.harness_slug, row.file_path),
          {
            id: Number(row.id),
            filePath: row.file_path,
            status: row.status,
            finishedAt: new Date(row.finished_at).toISOString(),
            commitSha: row.commit_sha,
            worktreeDirty: row.worktree_dirty,
          },
        ]),
      );
    },
    async loadLiveBindings(workspaceId, targets) {
      const plans = [...new Set(targets.map((t) => t.planSlug))];
      const specs = [...new Set(targets.map((t) => t.specId))];
      const rows = await withWorkspace(workspaceId, (tx) => tx<
        { id: string | number; harness_slug: string; plan_slug: string; spec_id: string; spec_revision: number;
          work_item_id: string; evidence_ref: string; test_run_id: string | number | null; observed_at: Date | string;
          details: { currentMeasurement?: unknown } | null; created_by: string | null }[]
      >`
        SELECT id, harness_slug, plan_slug, spec_id, spec_revision, work_item_id, evidence_ref, test_run_id, observed_at, details, created_by
          FROM harness_shared.spec_evidence_bindings
         WHERE workspace_id = ${workspaceId}
           AND plan_slug = ANY(${plans}::text[])
           AND spec_id = ANY(${specs}::text[])
           AND evidence_kind = 'test'
           AND retracted_at IS NULL`);
      const byClause = new Map<string, AutobindLiveBinding[]>();
      for (const row of rows) {
        const key = clauseKey({
          harnessSlug: row.harness_slug,
          planSlug: row.plan_slug,
          specId: row.spec_id,
          specRevision: Number(row.spec_revision),
        });
        const list = byClause.get(key) ?? [];
        list.push({
          id: Number(row.id),
          evidenceRef: row.evidence_ref,
          testRunId: row.test_run_id == null ? null : Number(row.test_run_id),
          observedAt: new Date(row.observed_at).toISOString(),
          measurement: row.details?.currentMeasurement,
          createdBy: row.created_by,
        });
        byClause.set(key, list);
      }
      return byClause;
    },
    async measuredPaths(target, run, live) {
      const scope: TestRunBindingScope = { workspaceId: target.workspaceId, harnessSlug: target.harnessSlug };
      const expansion = await expandTestRunBinding(
        { workItemId: target.workItemId, specId: target.specId, specRevision: target.specRevision, fromTestRun: run.id },
        scope,
      );
      if (!expansion.ok) return { ok: false, error: expansion.error, message: expansion.message };
      const prepared = prepareAutobindInput(target, run, expansion.binding.measurement, live);
      if (!prepared.ok) return prepared;
      const complete = await expandTestRunBinding(prepared.input, scope);
      if (!complete.ok) return { ok: false, error: complete.error, message: complete.message };
      const measurement = complete.binding.measurement;
      const root = await harnessRoot(target.workspaceId, measurement.rootHarnessSlug ?? target.harnessSlug);
      // The binder separately measures external fixture roots; inline fixture paths also take
      // part in the local uncommitted-path preflight instead of arriving only at the write.
      const localFixtures = !prepared.input.fixtureRootHarnessSlug || prepared.input.fixtureRootHarnessSlug === target.harnessSlug
        ? prepared.input.fixturePaths ?? [] : [];
      return { ok: true, root, input: prepared.input,
        paths: [...new Set([...measurement.testPaths, ...measurement.sourcePaths, ...localFixtures])].sort() };
    },
    async uncommittedPaths(root, paths) {
      if (paths.length === 0) return [];
      const out = await git(root, ['status', '--porcelain', '--untracked-files=all', '--', ...paths]);
      return out
        .split('\n')
        .map((line) => line.slice(3).trim())
        .filter(Boolean);
    },
    async bind(target, run, input) {
      if (!input) return { ok: false, error: 'autobind_recipe_unverified', message: 'The prepared measurement recipe is required before automatic binding.' };
      const result = await bindSpecEvidenceItems({
        harnessSlug: target.harnessSlug,
        actorId: AUTOBIND_ACTOR_ID,
        workspaceId: target.workspaceId,
        slug: target.planSlug,
        items: [input],
        supersedeAtRevision: true,
      });
      const first = (result as { results?: Array<{ ok?: boolean; error?: string; message?: string }> }).results?.[0];
      return first?.ok
        ? { ok: true }
        : { ok: false, error: first?.error ?? 'bind_failed', ...(first?.message ? { message: first.message } : {}) };
    },
    async retract(target, bindingId, reason) {
      await retractSpecEvidence({ harnessSlug: target.harnessSlug, bindingId, reason, actorId: AUTOBIND_ACTOR_ID });
    },
  };
}

/** The scheduled entry: the active workspace, default deps, never throws. */
export async function runSpecEvidenceAutobindOnce(
  opts: { workspaceId?: string; deps?: AutobindDeps } = {},
): Promise<AutobindRunResult | { error: string; summary: string }> {
  try {
    return await runSpecEvidenceAutobind(opts.workspaceId ?? activeWorkspaceId(), opts.deps ?? defaultAutobindDeps());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message, summary: `skipped (non-fatal): ${message}` };
  }
}
