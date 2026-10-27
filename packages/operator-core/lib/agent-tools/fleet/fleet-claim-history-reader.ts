/** Shared, index-backed reads over work-item claim-holder history. */
import type postgres from 'postgres';
import type { Sql } from 'postgres';

export interface WorkItemClaimHistoryInput {
  workspaceId: string;
  ownerIds: readonly string[];
  sinceAt: string;
  snapshotAt?: string | null;
  harnessSlug?: string | null;
}

export interface WorkItemClaimHistoryRow {
  ownerId: string;
  workItemId: string;
  at: string;
}

export interface FleetClaimHistoryRead {
  mode: 'global';
  rows: WorkItemClaimHistoryRow[];
  totalTransitions: number;
  distinctOwners: number;
}

export interface PerOwnerClaimHistoryRead {
  mode: 'per-owner';
  rows: WorkItemClaimHistoryRow[];
  totalTransitions: null;
  distinctOwners: null;
}

type ClaimHistoryDbRow = Record<string, unknown> & {
  work_item_id: unknown;
  owner_id: unknown;
  at: unknown;
};

type FleetClaimHistoryDbRow = ClaimHistoryDbRow & {
  total_transitions: string | number;
  distinct_owners: string | number;
};

function count(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapHistoryRows(rows: readonly ClaimHistoryDbRow[]): WorkItemClaimHistoryRow[] {
  return rows
    .filter((row) => row.work_item_id != null && row.owner_id != null && row.at != null)
    .map((row) => ({
      ownerId: String(row.owner_id),
      workItemId: String(row.work_item_id),
      at: String(row.at),
    }));
}

/**
 * Keep the owner test in JSONB containment form so the work_items GIN index can
 * find candidate rows before the lateral history expansion. The exact owner
 * predicate after expansion preserves the reader's row-level semantics.
 */
function matchedHistoryQuery(
  sql: Sql,
  input: WorkItemClaimHistoryInput,
  ownerIds: string[],
): postgres.PendingQuery<Record<string, unknown>[]> {
  // PostgreSQL cannot use the JSONB GIN index for `@> ANY(jsonb[])`. Keep one
  // indexable containment clause per owner and OR them before expanding history.
  const [firstOwner, ...remainingOwners] = ownerIds;
  const ownerContainment = remainingOwners.reduce(
    (predicate, owner) =>
      sql`(${predicate}) OR wi.worked_by_history @> ${JSON.stringify([{ owner }])}::jsonb`,
    sql`wi.worked_by_history @> ${JSON.stringify([{ owner: firstOwner! }])}::jsonb`,
  );
  const harnessPredicate = input.harnessSlug
    ? sql`AND wi.harness_slug = ${input.harnessSlug}`
    : sql``;
  const snapshotPredicate = input.snapshotAt
    ? sql`AND (h.value->>'at')::timestamptz <= ${input.snapshotAt}::timestamptz`
    : sql``;

  return sql<Record<string, unknown>[]>`
    SELECT h.value->>'owner' AS owner_id, wi.feature_id AS work_item_id, h.value->>'at' AS at
      FROM harness_shared.work_items wi
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(wi.worked_by_history) = 'array'
          THEN wi.worked_by_history ELSE '[]'::jsonb END
      ) h(value)
     WHERE wi.workspace_id = ${input.workspaceId}
       AND jsonb_typeof(wi.worked_by_history) = 'array'
       AND wi.worked_by_history <> '[]'::jsonb
       AND (${ownerContainment})
       AND h.value->>'owner' = ANY(${sql.array(ownerIds)}::text[])
       AND (h.value->>'at')::timestamptz >= ${input.sinceAt}::timestamptz
       ${snapshotPredicate}
       ${harnessPredicate}
  `;
}

export function readWorkItemClaimHistory(
  sql: Sql,
  input: WorkItemClaimHistoryInput,
  options: { mode: 'global'; limit: number },
): Promise<FleetClaimHistoryRead>;
export function readWorkItemClaimHistory(
  sql: Sql,
  input: WorkItemClaimHistoryInput,
  options: { mode: 'per-owner'; limit: number },
): Promise<PerOwnerClaimHistoryRead>;
export async function readWorkItemClaimHistory(
  sql: Sql,
  input: WorkItemClaimHistoryInput,
  options: { mode: 'global' | 'per-owner'; limit: number },
): Promise<FleetClaimHistoryRead | PerOwnerClaimHistoryRead> {
  const ownerIds = [...new Set(input.ownerIds.filter(Boolean))];
  if (ownerIds.length === 0) {
    return options.mode === 'global'
      ? { mode: 'global', rows: [], totalTransitions: 0, distinctOwners: 0 }
      : { mode: 'per-owner', rows: [], totalTransitions: null, distinctOwners: null };
  }

  const matched = matchedHistoryQuery(sql, input, ownerIds);
  if (options.mode === 'global') {
    const rows = await sql<FleetClaimHistoryDbRow[]>`
      WITH matched AS MATERIALIZED (${matched}),
      totals AS (
        SELECT count(*)::bigint AS total_transitions,
               count(DISTINCT owner_id)::bigint AS distinct_owners
          FROM matched
      )
      SELECT totals.total_transitions, totals.distinct_owners,
             recent.work_item_id, recent.owner_id, recent.at
        FROM totals
        LEFT JOIN LATERAL (
          SELECT work_item_id, owner_id, at
            FROM matched
           ORDER BY at::timestamptz DESC, work_item_id
           LIMIT ${options.limit}
        ) recent ON true
       ORDER BY recent.at::timestamptz DESC NULLS LAST, recent.work_item_id
    `;
    return {
      mode: 'global',
      rows: mapHistoryRows(rows),
      totalTransitions: count(rows[0]?.total_transitions),
      distinctOwners: count(rows[0]?.distinct_owners),
    };
  }

  const rows = await sql<ClaimHistoryDbRow[]>`
    WITH matched AS MATERIALIZED (${matched}),
    ranked AS (
      SELECT owner_id, work_item_id, at,
             row_number() OVER (
               PARTITION BY owner_id
               ORDER BY at::timestamptz DESC, work_item_id
             ) AS owner_rank
        FROM matched
    )
    SELECT owner_id, work_item_id, at
      FROM ranked
     WHERE owner_rank <= ${options.limit}
     ORDER BY owner_id, at::timestamptz DESC, work_item_id
  `;
  return {
    mode: 'per-owner',
    rows: mapHistoryRows(rows),
    totalTransitions: null,
    distinctOwners: null,
  };
}
