/**
 * Physical-row pinning for issue-family work-item writes (WI-10006010).
 *
 * A LEAF module, for the same reason as `work-items-orphan-author.ts`: its callers are the
 * write paths in `work-items.ts` / `issues-engineer.ts`, and their unit tests mock those
 * modules wholesale — a helper defined there would be `undefined` at the call sites it
 * protects.
 *
 * THE DEFECT THIS CLOSES
 * ----------------------
 * The physical identity of a `harness_shared.work_items` row is
 * `(workspace_id, harness_slug, feature_id)`. The same `feature_id` legitimately exists
 * under more than one `harness_slug`: a re-homed item and the stale copy a federation peer
 * re-sent (`operator:<ws>` beside `papercusp`), a pot-member copy, test fixtures. Measured
 * 2026-10-03: 100 such ids in one store, 14 with a non-terminal side.
 *
 * The issue-family state writer and the four origin self-heals keyed every UPDATE on
 * `feature_id` alone, so a close of ONE row rewrote every twin. Observed: closing 11
 * `operator:papercusp-workspace` rows as `dropped` flipped 3 sibling `papercusp` rows that
 * other agents had closed `done/committed` to `dropped/proposed`, and stamped the closer's
 * id as `terminal_owner` on all 11.
 *
 * THE RULE (scope-unique-identifiers-2026-07-26 P-013, requirement R-5)
 * -----------------------------------------------------------------------
 * A work-item id names ONE row in a workspace (R-1; migration 1443 cleared the twins and
 * 1444 makes the database refuse new ones). Every by-id read and write therefore picks
 * its physical row with {@link choosePhysicalSlug}:
 *   1. exactly one row → that row, whatever harness the caller passed (harness is an
 *      attribute of an item, not part of its id, so a stale or loose harness never turns
 *      a resolvable id into "not found");
 *   2. several rows and the caller named a harness that matches exactly one → that row;
 *   3. several rows otherwise → refuse with {@link WorkItemIdAmbiguousError}, naming every
 *      candidate harness. It used to take the most recently updated row, which is how
 *      a write meant for one item silently landed on its twin (R-5's falsifier).
 * A sibling row is never written.
 */
import type { Sql, TransactionSql } from 'postgres';

import { ISSUE_FAMILY_KINDS_SQL_LIST } from './work-nature/agent-work-predicate';
/**
 * A by-id lookup found more than one row for the id in one workspace and the caller did not
 * name a harness that picks exactly one. Thrown instead of choosing a row, so every caller
 * reports the ambiguity rather than reading or writing the wrong item.
 */
export class WorkItemIdAmbiguousError extends Error {
  readonly code = 'work_item_id_ambiguous' as const;
  /** What `candidates` lists: harness slugs in one workspace, or workspace ids. */
  readonly scope: 'harness' | 'workspace' = 'harness';
  constructor(
    readonly id: string,
    readonly workspaceId: string | null,
    /** Every physical `harness_slug` holding the id, sorted. */
    readonly candidates: readonly string[],
    /** The harness the caller passed, if any (it matched none or several of them). */
    readonly harness: string | null,
  ) {
    super(
      `work_item '${id}' is ambiguous${workspaceId ? ` in workspace '${workspaceId}'` : ''}: ` +
        `${candidates.length} rows under harnesses [${candidates.join(', ')}]` +
        (harness ? `, and harness '${harness}' does not pick exactly one` : '') +
        `. Pass harness to choose one. Work-item ids are meant to be unique per workspace, ` +
        `so this is a twin that needs merging (plan scope-unique-identifiers-2026-07-26).`,
    );
    this.name = 'WorkItemIdAmbiguousError';
  }
}

/**
 * WI-6554700010008365 (P-013 residue): a by-id lookup whose id the ambient workspace does NOT
 * hold, while two or more OTHER workspaces do. Falling back to the one workspace that holds an
 * id is deliberate (EI-15486: a routine tick can resolve the wrong ambient workspace). Taking
 * the freshest of several is a recency choice between other workspaces' rows, so it is refused.
 * Same `code` as the harness twin refusal, so every existing handler surfaces it; here
 * `candidates` are workspace ids.
 */
export class WorkItemWorkspaceAmbiguousError extends WorkItemIdAmbiguousError {
  override readonly scope = 'workspace' as const;
  constructor(
    id: string,
    readonly ambientWorkspaceId: string,
    workspaces: readonly string[],
  ) {
    super(id, null, workspaces, null);
    this.message =
      `work_item '${id}' is not in the current workspace '${ambientWorkspaceId}', and ` +
      `${workspaces.length} other workspaces hold it [${workspaces.join(', ')}]. Read or write it ` +
      `in its own workspace; choosing the most recent of several workspaces is refused.`;
    this.name = 'WorkItemWorkspaceAmbiguousError';
  }
}

/** Every workspace holding the id, read as `array_agg(workspace_id) OVER ()` before LIMIT. */
export interface WorkspaceCensus {
  __all_ws?: string[] | null;
}

/**
 * Refuse a by-id choice that fell back from the ambient workspace to one of SEVERAL others.
 * A choice in the ambient workspace, or the only workspace holding the id, passes.
 */
export function assertWorkspaceChoice(
  id: string,
  ambient: string,
  chosen: string | null | undefined,
  allWorkspaces: readonly string[] | null | undefined,
): void {
  if (!chosen || chosen === ambient) return;
  const distinct = [...new Set(allWorkspaces ?? [])].sort();
  if (distinct.length > 1) throw new WorkItemWorkspaceAmbiguousError(id, ambient, distinct);
}

/** Duck-typed so a module-split copy of the class (a mocked or re-bundled module) still matches. */
export function isWorkItemIdAmbiguousError(err: unknown): err is WorkItemIdAmbiguousError {
  return (
    err instanceof WorkItemIdAmbiguousError ||
    (typeof err === 'object' &&
      err !== null &&
      (err as { code?: unknown }).code === 'work_item_id_ambiguous' &&
      Array.isArray((err as { candidates?: unknown }).candidates))
  );
}

/** What {@link choosePhysicalSlug} decided. */
export type PhysicalSlugChoice =
  | { kind: 'none' }
  | { kind: 'unique'; slug: string }
  /** Several rows; the caller's harness picked `slug`. `twins` are the rows it did not pick. */
  | { kind: 'named'; slug: string; twins: string[] }
  | { kind: 'ambiguous'; candidates: string[] };

/**
 * Decide which physical row a by-id read or write may use, from every `harness_slug` that
 * holds the id in one workspace. Order-independent: recency never decides (R-5).
 */
export function choosePhysicalSlug(
  slugs: readonly string[],
  harness?: string | null,
): PhysicalSlugChoice {
  const candidates = [...new Set(slugs)].sort();
  if (candidates.length === 0) return { kind: 'none' };
  if (candidates.length === 1) return { kind: 'unique', slug: candidates[0]! };
  const want = harnessPreference(harness);
  if (want) {
    const named = candidates.filter((slug) => harnessSlugMatches(slug, want));
    if (named.length === 1) {
      return { kind: 'named', slug: named[0]!, twins: candidates.filter((slug) => slug !== named[0]) };
    }
  }
  return { kind: 'ambiguous', candidates };
}

/** Strip the `harness:` scope prefix a caller may pass. */
function bareHarness(harness: string): string {
  return harness.startsWith('harness:') ? harness.slice('harness:'.length) : harness;
}

/**
 * Normalise a caller-supplied harness to a usable selector: blank, `*` (the "any harness"
 * wildcard) and null all mean "no preference".
 */
export function harnessPreference(harness: string | null | undefined): string | null {
  if (!harness) return null;
  const trimmed = harness.trim();
  if (!trimmed || trimmed === '*') return null;
  return trimmed;
}

/**
 * Does the physical `harness_slug` belong to the harness a caller named? Physical slugs are
 * stored both bare (`papercusp`) and prefixed (`harness:papercusp`), and a caller may pass
 * either form or a non-harness physical slug verbatim (`operator:papercusp-workspace`).
 */
export function harnessSlugMatches(slug: string, harness: string): boolean {
  if (slug === harness) return true;
  const want = bareHarness(harness);
  return slug === want || slug === `harness:${want}`;
}

/**
 * Pick the one physical slug a write may touch. Returns null when there is no row at all and
 * throws {@link WorkItemIdAmbiguousError} when the id has several rows the caller's harness
 * does not disambiguate — never a recency guess.
 */
export function pickPhysicalSlug(
  slugs: readonly string[],
  harness?: string | null,
  subject: { id: string; workspaceId?: string | null } = { id: '(unknown)' },
): string | null {
  const choice = choosePhysicalSlug(slugs, harness);
  switch (choice.kind) {
    case 'none':
      return null;
    case 'unique':
    case 'named':
      return choice.slug;
    case 'ambiguous':
      throw new WorkItemIdAmbiguousError(
        subject.id,
        subject.workspaceId ?? null,
        choice.candidates,
        harnessPreference(harness),
      );
  }
}

/**
 * The twin census a by-id read selects beside its columns, computed by a window aggregate
 * before LIMIT so detecting twins costs no extra round trip:
 *   `workspace_id AS __ws, array_agg(<slug column>) OVER (PARTITION BY workspace_id) AS __ws_slugs`
 */
export interface TwinCensus {
  __ws?: string | null;
  __ws_slugs?: string[] | null;
}

/**
 * Strip the {@link TwinCensus} from a by-id read's row, refusing the row when its census holds
 * several slugs `harness` does not narrow to one (P-013 / R-5). A row without a census (a
 * mocked or legacy read) is treated as unique.
 */
export function stripTwinCensus<T extends object>(
  id: string,
  row: T & TwinCensus,
  harness?: string | null,
): T {
  const { __ws, __ws_slugs, ...rest } = row;
  const choice = choosePhysicalSlug(__ws_slugs ?? [], harness);
  if (choice.kind === 'ambiguous') {
    throw new WorkItemIdAmbiguousError(id, __ws ?? null, choice.candidates, harnessPreference(harness));
  }
  return rest as T;
}

/** The org pool or a transaction handle (`boundedOrgTxn` passes the same type). */
type SlugReader = Sql | TransactionSql;

/**
 * Resolve the single issue-family physical row a write for `(workspaceId, id)` may touch.
 * Returns its `harness_slug`, or null when the id has no issue-family row in that workspace
 * (the caller's own lookup then reports not-found exactly as before). Throws
 * {@link WorkItemIdAmbiguousError} when several rows hold the id and `harness` does not
 * pick exactly one.
 */
export async function resolveIssuePhysicalSlug(
  sql: SlugReader,
  workspaceId: string,
  id: string,
  harness?: string | null,
): Promise<string | null> {
  if (!workspaceId || !id) return null;
  const rows = await sql<{ harness_slug: string }[]>`
    SELECT harness_slug
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND feature_id = ${id}
       AND item_kind IN (${sql.unsafe(ISSUE_FAMILY_KINDS_SQL_LIST)})`;
  return pickPhysicalSlug(
    rows.map((r) => r.harness_slug),
    harness,
    { id, workspaceId },
  );
}
