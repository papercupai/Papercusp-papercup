/**
 * resolveWorkspaceForHarness — the WI-148-aware "which workspace does THIS harness's
 * data live in" derive-or-throw, shared by the per-harness data surfaces (docs records,
 * plan attribution) that used to silently default an omitted workspace to 'default'
 * (workspace-data-isolation-leaks-2026-06-17 P-002 docs sub-part / P-005 / D-003).
 *
 * A harness's per-harness rows (harness_docs, harness_plan_parts, …) are keyed
 * (workspace_id, harness_slug); the workspace is a PROPERTY OF THE HARNESS, never a
 * caller default. Deriving it from the slug is the same SAFE forward half the plans
 * read/write path converged on (resolvePlanScope / fill_workspace_id_from_projects,
 * P-001): operator-home / '*' / 'all' / empty → PAPERCUSP_WORKSPACE_ID (the WI-148
 * part-B flip, in lockstep with migration 295's data move); a concrete slug → the
 * projects projection, then the authoritative harness registry; UNRESOLVABLE → THROW
 * (never a silent cross-workspace 'default').
 *
 * Workspace resolution belongs here so read-only consumers do not load plan
 * mutation, event dispatch, or agent-launch dependencies. Plans re-export this
 * implementation for existing callers.
 */
import { withWorkspace } from '@papercusp/db-org';
import { resolveWorkspaceForHarnessSlug } from '../harness-core';
import { canonicalHarnessSlug, operatorHomeHarnessSlug } from './operator-home-harness';
import { PAPERCUSP_WORKSPACE_ID } from './papercusp-workspace';

/**
 * True for the harness slugs that resolve to the operator-home harness:
 * the empty / unset case, the SU wildcards `'*'` / `'all'`, and the literal
 * operator-home slug. Shared by `fill_workspace_id_from_projects` and
 * `resolvePlanScope` so the "this is the operator home" predicate is defined once.
 */
export function isOperatorHomeScope(raw: string | undefined): boolean {
  const canonical = raw ? canonicalHarnessSlug(raw) : raw;
  return !canonical || canonical === '*' || canonical === 'all' || canonical === operatorHomeHarnessSlug();
}

/** Injectable seam for the projects-table lookup — overridden in unit tests
 *  so the slug→workspace resolution is exercised without a live PG. Returns
 *  the DISTINCT set of workspace_ids that carry the slug. */
export type ProjectsWorkspaceLookup = (slug: string) => Promise<string[]>;

/** Injectable seam for the AUTHORITATIVE-registry fallback (resolveWorkspaceForHarnessSlug):
 *  slug → its workspace_id (or null), used when the projects projection has no row.
 *  Overridden in unit tests so the fallback branch is exercised without a live PG. */
export type RegistryWorkspaceResolver = (slug: string) => Promise<string | null>;

/**
 * Which workspace_id(s) carry `harness_slug` in `harness_shared.projects`.
 *
 * NB (2026-06-18): `harness_shared.projects` is NOT the universal harness
 * registry — it is the org/department blueprint's PROJECTION (business columns
 * owning_dept/vertical/budget_cents; the sole non-test writer is the
 * `execute-action.ts` project-create action), so it is sparse and a hive/generic
 * harness never appears in it. The de-facto AUTHORITATIVE slug→workspace registry
 * is `harness_shared.harness_registry` (resolveProject / resolveWorkspaceForHarnessSlug),
 * which pot:create/harness:create write and the work-items path reads. The older
 * "projects is authoritative" framing (migration 221 leg 1) is STALE — kept here
 * only as the FIRST consult; `fill_workspace_id_from_projects` falls back to the
 * registry when this returns 0 (peers su-a7f66 / su-632e0166, sibling EI-1511).
 * UNIQUE (workspace_id, slug) still holds, so a slug appears at most once per
 * workspace but MAY appear in several (a same-name collision). The cross-workspace
 * read uses the admin-bypass connection (harness_admin, RLS off) because the
 * calling context's workspace GUC is not necessarily the one that owns the slug.
 */
async function lookupProjectWorkspaceIds(slug: string): Promise<string[]> {
  return withWorkspace(
    '',
    async (tx) => {
      const rows = await tx<{ workspace_id: string }[]>`
        SELECT DISTINCT workspace_id
          FROM harness_shared.projects
         WHERE slug = ${slug}
           AND COALESCE(workspace_id, '') <> ''
      `;
      return rows.map((r) => r.workspace_id);
    },
    { bypassRlsForAdmin: true },
  );
}

/**
 * Resolve a harness slug → its workspace_id from the projects/registry source
 * of truth (WI-148 / P-013 workspace-identity reconciliation, the SAFE forward
 * half).
 *
 * Rules (fail-loud, no silent cross-workspace default):
 *   - operator-home / empty / '*' / 'all' / operatorHomeHarnessSlug() → PAPERCUSP_WORKSPACE_ID.
 *     WI-148 PART-B CUTOVER (owner GO 2026-06-16): flipped from DEFAULT_WORKSPACE_ID
 *     to PAPERCUSP_WORKSPACE_ID *in LOCKSTEP* with migration 295, which moves
 *     papercup's plan/feature/issue rows 'default' → 'papercusp-workspace' in the
 *     SAME release. The flip and the data move MUST ship together (either alone
 *     404s every papercup read) — they apply atomically on the :3070 deploy
 *     (migrations-before-serve + papercup-read path-verify → rollback). See WI-148.
 *   - a concrete other slug: look it up in harness_shared.projects.
 *       0 matches  → null (caller decides how to fail).
 *       1 match    → that workspace_id.
 *       2+ matches → THROW (same-name collision across workspaces — fail loud
 *                    rather than silently pick the wrong workspace).
 */
export async function fill_workspace_id_from_projects(
  harnessSlug: string | undefined,
  opts: { lookup?: ProjectsWorkspaceLookup; registryFallback?: RegistryWorkspaceResolver } = {},
): Promise<string | null> {
  const raw = harnessSlug?.trim();
  // WI-148 part-B cutover (owner GO 2026-06-16): papercup → PAPERCUSP_WORKSPACE_ID,
  // in lockstep with migration 295's data move (see the doc-comment above).
  if (isOperatorHomeScope(raw)) return PAPERCUSP_WORKSPACE_ID;

  const lookup = opts.lookup ?? lookupProjectWorkspaceIds;
  const matches = await lookup(raw!);
  const distinct = [...new Set(matches.filter((w) => w && w.trim()))];
  if (distinct.length > 1) {
    throw new Error(
      `fill_workspace_id_from_projects: harness slug '${raw}' resolves to ` +
        `${distinct.length} workspaces (${distinct.join(', ')}). Ambiguous same-name ` +
        `collision across workspaces — pass an explicit workspaceId to disambiguate.`,
    );
  }
  if (distinct.length === 1) return distinct[0]!;
  // 0 rows in harness_shared.projects — expected for a hive/generic harness, which
  // lives only in the AUTHORITATIVE harness registry (the projects table is just
  // the org/department projection — see lookupProjectWorkspaceIds). Fall back to
  // that registry, which is what the work-items path already resolves through, so
  // a hive's plans resolve the same way its work-items do. Active-workspace-first +
  // collision-aware (su-a7f66 / su-632e0166, EI-1511 / P-017). Additive: only turns
  // a former null (→ caller throw) into a resolution; never regresses papercup
  // (isOperatorHomeScope) or explicit-workspaceId callers (both short-circuit earlier).
  const registryFallback = opts.registryFallback ?? resolveWorkspaceForHarnessSlug;
  return await registryFallback(raw!);
}

/**
 * Resolve `harnessSlug` → the workspace_id its data lives in, or THROW when the harness
 * is not registered in any workspace (refusing to silently default — WI-148 / D-003).
 *
 * Pass an explicit `workspaceId` (e.g. a test seam or a caller that already resolved
 * scope) to short-circuit the lookup — it is honored verbatim.
 */
export async function resolveWorkspaceForHarness(
  harnessSlug: string | undefined,
  workspaceId?: string,
): Promise<string> {
  if (workspaceId && workspaceId.trim()) return workspaceId.trim();
  const resolved = await fill_workspace_id_from_projects(harnessSlug);
  if (resolved === null) {
    throw new Error(
      `resolveWorkspaceForHarness: harness '${harnessSlug ?? ''}' is not registered in ` +
        `harness_shared.projects or the harness registry in any workspace, so the workspace ` +
        `its data lives in cannot be resolved. Register the harness, or pass an explicit ` +
        `workspaceId. (Refusing to silently default the workspace — workspace-data-isolation-leaks ` +
        `P-002/P-005, D-003.)`,
    );
  }
  return resolved;
}
