/**
 * Footprint reconciliation (R-5) — flag work that touched a plan's declared
 * footprint without a plan link.
 *
 * A plan's `## Conformance` contract may declare `footprint.paths`: repo-relative
 * globs naming the code the plan owns. One reconciliation:
 *
 *   1. reads the commits since the plan's watermark (`sinceSha`) and keeps every
 *      changed path that matches a footprint glob;
 *   2. treats a path as COVERED when a work-item linked to the plan names it in its
 *      completion `filesChanged`, or an active file lock on it is held by an owner
 *      who holds a plan-linked work-item;
 *   3. records every UNCOVERED path on ONE open out-of-plan finding work-item per
 *      plan (condition-keyed, so repeated sweeps refresh it instead of piling up),
 *      assigned to the plan driver;
 *   4. returns the head it reconciled to, which the sweep (P-023) stores as the
 *      plan's new watermark.
 *
 * A plan with no footprint declared has nothing to reconcile and opens nothing. A
 * malformed contract is refused, never partially read — a partial read would
 * silently shrink what the footprint covers.
 *
 * Pure orchestration over injected dependencies; `footprint-deps.ts` supplies the
 * production adapters (git, the work-item ledger, the lock store, condition upsert).
 *
 * Plan: spec-conformance-loop-2026-10-14 (P-019; R-5).
 */
import { Minimatch } from 'minimatch';
import { parseConformanceContract, type ConformanceProblem } from './conformance-contract';

export interface FootprintCommit {
  sha: string;
  /** Repo-relative paths the commit changed. */
  paths: string[];
}

export interface FootprintCommitWindow {
  /** The head the window ends at; null when the source could not resolve one. */
  headSha: string | null;
  commits: FootprintCommit[];
}

export interface PlanFootprintCoverage {
  /** Completion `filesChanged` of every work-item linked to the plan. */
  filesChanged: ReadonlyArray<{ workItemId: string; paths: ReadonlyArray<string> }>;
  /** Active file locks held by an owner who holds a plan-linked work-item. */
  heldLocks: ReadonlyArray<{ path: string; ownerId: string; workItemId: string }>;
}

export interface UncoveredFootprintPath {
  path: string;
  /** Commits (oldest first) in the window that changed the path. */
  commits: string[];
}

export type FootprintCoverageSource =
  | { kind: 'filesChanged'; workItemId: string }
  | { kind: 'lock'; workItemId: string; ownerId: string };

export interface OutOfPlanFiling {
  conditionKey: string;
  title: string;
  summary: string;
  assignee: string | null;
  uncovered: UncoveredFootprintPath[];
  windowHeadSha: string | null;
}

export interface FootprintDeps {
  listCommitsSince(sinceSha: string | null): Promise<FootprintCommitWindow>;
  readPlanCoverage(): Promise<PlanFootprintCoverage>;
  /** The owner who drives the plan; null when the plan has none on record. */
  resolvePlanDriver(): Promise<string | null>;
  /** File-or-refresh the plan's one out-of-plan finding. */
  upsertOutOfPlanFinding(filing: OutOfPlanFiling): Promise<{ id: string; created: boolean }>;
}

export interface FootprintInput {
  planSlug: string;
  harnessSlug: string;
  planContent: string;
  /** Watermark: reconcile commits after this sha. Null = the source's own default window. */
  sinceSha: string | null;
}

export type FootprintOutcome =
  | {
      ok: true;
      /** False when the plan declares no footprint — nothing was reconciled. */
      declared: boolean;
      globs: string[];
      sinceSha: string | null;
      headSha: string | null;
      commitsScanned: number;
      covered: Array<{ path: string; by: FootprintCoverageSource }>;
      uncovered: UncoveredFootprintPath[];
      finding: { action: 'none' | 'opened' | 'refreshed'; id: string | null };
    }
  | { ok: false; problems: ConformanceProblem[] };

/** Condition key that deduplicates a plan's out-of-plan finding. */
export function outOfPlanConditionKey(harnessSlug: string, planSlug: string): string {
  return `spec-conformance-out-of-plan:${harnessSlug}/${planSlug}`;
}

/** Repo-relative, forward-slash, no leading `./` — the form globs and ledgers compare in. */
export function normalizeRepoPath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/{2,}/g, '/');
}

/**
 * Compile footprint globs ONCE per reconciliation. Building a Minimatch per
 * path × glob pair is a measured main-thread hotspot (WI-10005353).
 */
export function compileFootprint(globs: ReadonlyArray<string>): (path: string) => boolean {
  const matchers = globs.map((glob) => new Minimatch(normalizeRepoPath(glob), { dot: true }));
  return (path: string) => {
    const candidate = normalizeRepoPath(path);
    return matchers.some((matcher) => matcher.match(candidate));
  };
}

function findingSummary(input: {
  planSlug: string;
  uncovered: UncoveredFootprintPath[];
  sinceSha: string | null;
  headSha: string | null;
}): string {
  const lines = [
    `Commits changed paths inside the declared footprint of plan ${input.planSlug} with no plan-linked work-item covering them`,
    `(no plan-linked completion names the path in filesChanged and no plan-linked holder has it locked).`,
    `Window: ${input.sinceSha ?? '(source default)'}..${input.headSha ?? '(unknown head)'}.`,
    '',
    ...input.uncovered.map((entry) => `- \`${entry.path}\` — ${entry.commits.map((sha) => sha.slice(0, 12)).join(', ')}`),
    '',
    'Link the work to the plan (or record a deviation) so the change is accounted for.',
  ];
  return lines.join('\n');
}

export async function reconcilePlanFootprint(input: FootprintInput, deps: FootprintDeps): Promise<FootprintOutcome> {
  const parsed = parseConformanceContract(input.planContent);
  if (!parsed.ok) return { ok: false, problems: parsed.problems };

  const globs = (parsed.contract.footprint?.paths ?? []).map(normalizeRepoPath).filter((glob) => glob.length > 0);
  if (globs.length === 0) {
    return {
      ok: true,
      declared: false,
      globs: [],
      sinceSha: input.sinceSha,
      headSha: null,
      commitsScanned: 0,
      covered: [],
      uncovered: [],
      finding: { action: 'none', id: null },
    };
  }

  const inFootprint = compileFootprint(globs);
  const window = await deps.listCommitsSince(input.sinceSha);
  const touched = new Map<string, string[]>();
  for (const commit of window.commits) {
    for (const raw of commit.paths) {
      const path = normalizeRepoPath(raw);
      if (!path || !inFootprint(path)) continue;
      const shas = touched.get(path) ?? [];
      if (!shas.includes(commit.sha)) shas.push(commit.sha);
      touched.set(path, shas);
    }
  }

  const coverageByPath = new Map<string, FootprintCoverageSource>();
  if (touched.size > 0) {
    const coverage = await deps.readPlanCoverage();
    for (const entry of coverage.filesChanged) {
      for (const raw of entry.paths) {
        const path = normalizeRepoPath(raw);
        if (touched.has(path) && !coverageByPath.has(path)) {
          coverageByPath.set(path, { kind: 'filesChanged', workItemId: entry.workItemId });
        }
      }
    }
    for (const lock of coverage.heldLocks) {
      const path = normalizeRepoPath(lock.path);
      if (touched.has(path) && !coverageByPath.has(path)) {
        coverageByPath.set(path, { kind: 'lock', workItemId: lock.workItemId, ownerId: lock.ownerId });
      }
    }
  }

  const covered: Array<{ path: string; by: FootprintCoverageSource }> = [];
  const uncovered: UncoveredFootprintPath[] = [];
  for (const [path, commits] of [...touched.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const by = coverageByPath.get(path);
    if (by) covered.push({ path, by });
    else uncovered.push({ path, commits });
  }

  let finding: { action: 'none' | 'opened' | 'refreshed'; id: string | null } = { action: 'none', id: null };
  if (uncovered.length > 0) {
    const assignee = await deps.resolvePlanDriver();
    const filed = await deps.upsertOutOfPlanFinding({
      conditionKey: outOfPlanConditionKey(input.harnessSlug, input.planSlug),
      title: `Out-of-plan footprint change: ${input.planSlug} (${uncovered.length} path${uncovered.length === 1 ? '' : 's'})`.slice(0, 300),
      summary: findingSummary({ planSlug: input.planSlug, uncovered, sinceSha: input.sinceSha, headSha: window.headSha }),
      assignee,
      uncovered,
      windowHeadSha: window.headSha,
    });
    finding = { action: filed.created ? 'opened' : 'refreshed', id: filed.id };
  }

  return {
    ok: true,
    declared: true,
    globs,
    sinceSha: input.sinceSha,
    headSha: window.headSha,
    commitsScanned: window.commits.length,
    covered,
    uncovered,
    finding,
  };
}
