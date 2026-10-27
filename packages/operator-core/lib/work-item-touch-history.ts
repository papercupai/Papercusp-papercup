/** P-009: the reverse view of the existing edit ledger; no git authorship inference. */
import { boundedOrgTxn } from './pg-bounded-txn';

export const WORK_ITEM_TOUCH_FILE_LIMIT = 100;
export const WORK_ITEM_TOUCH_SYMBOL_LIMIT = 100;

export type WorkItemTouchHistory = {
  status: 'available';
  totalFiles: number;
  truncated: boolean;
  files: Array<{
    file: string;
    /** NULL is unknown; [] is a recorded, known-empty symbol set. */
    symbols: string[] | null;
    symbolsIncomplete: boolean;
    symbolsTruncated: boolean;
  }>;
} | {
  status: 'unavailable';
  reason: 'scope-unavailable' | 'ledger-read-failed';
};

export async function readWorkItemTouchHistory(input: {
  workspaceId: string | null | undefined;
  harness: string | null | undefined;
  workItemId: string;
  signal?: AbortSignal;
}): Promise<WorkItemTouchHistory> {
  const { workspaceId, harness } = input;
  if (!workspaceId || !harness) return { status: 'unavailable', reason: 'scope-unavailable' };
  try {
    const rows = await boundedOrgTxn(async (sql) => await sql<Array<{
      file: string;
      symbols_unknown: boolean;
      symbols_all_unknown: boolean;
      symbols: string[];
      total_files: string | number;
    }>>`
      WITH scoped AS MATERIALIZED (
        SELECT file, symbols
          FROM harness_shared.edit_attribution_ledger
         WHERE workspace_id = ${workspaceId}
           AND harness_slug = ${harness}
           AND work_item_id = ${input.workItemId}
      ), files AS (
        SELECT file, bool_or(symbols IS NULL) AS symbols_unknown,
               bool_and(symbols IS NULL) AS symbols_all_unknown
          FROM scoped GROUP BY file
      )
      SELECT f.*, count(*) OVER () AS total_files,
             ARRAY(
               SELECT DISTINCT symbol COLLATE "C"
                 FROM scoped s CROSS JOIN LATERAL unnest(s.symbols) AS u(symbol)
                WHERE s.file = f.file AND symbol IS NOT NULL
                ORDER BY symbol COLLATE "C"
                LIMIT ${WORK_ITEM_TOUCH_SYMBOL_LIMIT + 1}
             ) AS symbols
        FROM files f
       ORDER BY f.file COLLATE "C"
       LIMIT ${WORK_ITEM_TOUCH_FILE_LIMIT}
    `, {
      readOnly: true,
      statementTimeoutMs: 2_000,
      acquireTimeoutMs: 2_000,
      acquireRetries: 0,
      phase: 'work-item-touch-history',
      signal: input.signal,
    });
    const totalFiles = Number(rows[0]?.total_files ?? 0);
    return {
      status: 'available',
      totalFiles,
      truncated: totalFiles > rows.length,
      files: rows.map((row) => ({
        file: row.file,
        symbols: row.symbols_all_unknown ? null : row.symbols.slice(0, WORK_ITEM_TOUCH_SYMBOL_LIMIT),
        symbolsIncomplete: row.symbols_unknown,
        symbolsTruncated: row.symbols.length > WORK_ITEM_TOUCH_SYMBOL_LIMIT,
      })),
    };
  } catch {
    // Includes a not-yet-applied producer migration: never report that as no edits.
    return { status: 'unavailable', reason: 'ledger-read-failed' };
  }
}
