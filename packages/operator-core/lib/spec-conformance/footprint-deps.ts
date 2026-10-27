/**
 * Production adapters for footprint reconciliation (R-5, P-019).
 *
 * - commits: `git log --name-only` over the harness checkout, from the plan's
 *   watermark to HEAD (or a bounded window since the plan was created when no
 *   watermark is stored yet). Paths are superproject-relative: a change INSIDE a
 *   submodule shows up as the gitlink path, so a footprint glob that names files
 *   inside a submodule is matched only when the gitlink itself moves — a known
 *   limit of this reconciler, stated here rather than silently under-reporting.
 * - coverage: completion `filesChanged` of every work-item whose
 *   `source_plan_slug` is the plan, plus active file locks (su-lock-store) held by
 *   an owner currently assigned a non-terminal plan-linked work-item.
 * - driver: the plan's `owner` column.
 * - finding: one condition-keyed work-item per plan via `upsertConditionWorkItem`.
 */
import { getOrgPg } from '@papercusp/db-org';
import { upsertConditionWorkItem } from '../coord/condition-upsert';
import { resolveHarnessRepoRoot } from '../harness/docs/harness-repo';
import { repoHeadSha, runGit } from '../harness/docs/git-runner';
import { ensureBootstrap, getTxPool, readQueue } from '../agent-tools/locks/su-lock-store';
import { acquireWithContentionRetry } from '../agent-tools/locks/contention-retry';
import { TERMINAL_WORK_ITEM_STATES } from '../work-items';
import { normalizeTakenBy } from '../sync/hyperbee/projections/harness-features';
import { SPEC_CONFORMANCE_ACTOR } from './conformance-run-deps';
import type { FootprintCommit, FootprintCommitWindow, FootprintDeps, PlanFootprintCoverage } from './footprint';

type Sql = ReturnType<typeof getOrgPg>['sql'];
const sql = (): Sql => getOrgPg().sql;

/** Upper bound on commits read when the plan has no watermark yet. */
export const FOOTPRINT_DEFAULT_MAX_COMMITS = 500;
const RECORD_SEPARATOR = '\u001e';

/** Parse `git log --format=%x1e%H --name-only` output into commits (oldest first). */
export function parseNameOnlyLog(stdout: string): FootprintCommit[] {
  const commits: FootprintCommit[] = [];
  for (const record of stdout.split(RECORD_SEPARATOR)) {
    const lines = record
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) continue;
    const [sha, ...paths] = lines;
    if (!/^[0-9a-f]{7,64}$/i.test(sha!)) continue;
    commits.push({ sha: sha!, paths });
  }
  return commits.reverse();
}

export interface FootprintDepsInput {
  workspaceId: string;
  harnessSlug: string;
  planSlug: string;
}

export function createFootprintDeps(input: FootprintDepsInput): FootprintDeps {
  return {
    async listCommitsSince(sinceSha): Promise<FootprintCommitWindow> {
      const root = await resolveHarnessRepoRoot(input.harnessSlug);
      if (!root) throw new Error(`spec-conformance footprint: no repo root for harness ${input.harnessSlug}`);
      const headSha = await repoHeadSha(root);
      if (!headSha) throw new Error(`spec-conformance footprint: cannot resolve HEAD in ${root}`);
      const range: string[] = [];
      if (sinceSha) {
        range.push(`${sinceSha}..${headSha}`);
      } else {
        const created = (await sql()`
          SELECT created_at FROM harness_shared.harness_plans
           WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harnessSlug} AND plan_slug = ${input.planSlug}
           LIMIT 1
        `) as Array<{ created_at: Date | string | null }>;
        const since = created[0]?.created_at ? new Date(created[0].created_at).toISOString() : null;
        range.push(`--max-count=${FOOTPRINT_DEFAULT_MAX_COMMITS}`);
        if (since) range.push(`--since=${since}`);
        range.push(headSha);
      }
      const log = await runGit(['log', '--no-renames', '--format=%x1e%H', '--name-only', ...range], root);
      if (log.code !== 0) {
        // A watermark sha git no longer knows (rewritten history) must surface, never read as "no commits".
        throw new Error(`spec-conformance footprint: git log failed (${log.code}): ${log.stderr.trim().slice(0, 300)}`);
      }
      return { headSha, commits: parseNameOnlyLog(log.stdout) };
    },

    async readPlanCoverage(): Promise<PlanFootprintCoverage> {
      const rows = (await sql()`
        SELECT feature_id, taken_by AS assignee, status,
               jsonb_path_query_array(coalesce(payload, '{}'::jsonb), 'strict $.**.filesChanged[*]') AS files
          FROM harness_shared.work_items
         WHERE workspace_id = ${input.workspaceId}
           AND source_plan_slug = ${input.planSlug}
      `) as Array<{ feature_id: string; assignee: string | null; status: string; files: unknown }>;
      const terminal = new Set<string>(TERMINAL_WORK_ITEM_STATES);
      const filesChanged = rows.map((row) => ({
        workItemId: row.feature_id,
        paths: Array.isArray(row.files) ? row.files.filter((p): p is string => typeof p === 'string') : [],
      }));
      const holderItem = new Map<string, string>();
      for (const row of rows) {
        const ownerId = normalizeTakenBy(row.assignee);
        if (ownerId && !terminal.has(row.status) && !holderItem.has(ownerId)) holderItem.set(ownerId, row.feature_id);
      }
      const heldLocks: Array<PlanFootprintCoverage['heldLocks'][number]> = [];
      if (holderItem.size > 0) {
        await ensureBootstrap();
        const lockSql = getTxPool();
        for (const [ownerId, workItemId] of holderItem) {
          const queue = await acquireWithContentionRetry(() =>
            readQueue(lockSql, { coordinationDomain: null, owner: ownerId, includeWaiting: false }),
          );
          for (const lock of queue.active_locks) heldLocks.push({ path: lock.path, ownerId, workItemId });
        }
      }
      return { filesChanged, heldLocks };
    },

    async resolvePlanDriver(): Promise<string | null> {
      const rows = (await sql()`
        SELECT owner FROM harness_shared.harness_plans
         WHERE workspace_id = ${input.workspaceId} AND harness_slug = ${input.harnessSlug} AND plan_slug = ${input.planSlug}
         LIMIT 1
      `) as Array<{ owner: string | null }>;
      const owner = rows[0]?.owner?.trim();
      return owner ? owner : null;
    },

    async upsertOutOfPlanFinding(filing) {
      const footprint = {
        planSlug: input.planSlug,
        harnessSlug: input.harnessSlug,
        windowHeadSha: filing.windowHeadSha,
        uncovered: filing.uncovered,
      };
      const res = await upsertConditionWorkItem(filing.conditionKey, {
        kind: 'bug',
        severity: 'minor',
        harness: input.harnessSlug,
        workspaceId: input.workspaceId,
        createdBy: SPEC_CONFORMANCE_ACTOR,
        title: filing.title,
        summary: filing.summary,
        ...(filing.assignee ? { assignee: filing.assignee } : {}),
        payload: { specConformanceFootprint: footprint },
      });
      if (!res.id) {
        throw new Error(`spec-conformance footprint: out-of-plan finding for ${filing.conditionKey} returned no work-item id`);
      }
      if (!res.created) {
        await sql()`
          UPDATE harness_shared.work_items
             SET payload = jsonb_set(coalesce(payload, '{}'::jsonb), '{specConformanceFootprint}', ${footprint as never}::jsonb)
           WHERE feature_id = ${res.id} AND workspace_id = ${input.workspaceId}
        `;
      }
      return { id: res.id, created: res.created };
    },
  };
}
