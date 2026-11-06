/** Mutable external publication state beside immutable report editions. */
import type postgres from 'postgres';
import type { ReportShare, ReportShareStore } from './report-sharing';

export function postgresReportShareStore(sql: postgres.Sql): ReportShareStore {
  return {
    async locked(key, work) {
      const connection = await sql.reserve();
      let held = false;
      try {
        const [row] = await connection<{ held: boolean }[]>`SELECT pg_try_advisory_lock(hashtextextended(${key}, 0)) AS held`;
        held = row.held;
        if (!held) throw new Error('A sharing operation is already running. Retry shortly.');
        // Autocommit persists intent BEFORE GitHub, even if the process dies.
        return await work({
          async viewerState(accountId) {
            // Only account-global viewer metadata crosses workspace boundaries;
            // immutable report content and sharing operation IDs remain scoped.
            const [row] = await connection<{ repo_id: number; tree_sha: string; generation: number }[]>`
              SELECT (share->>'repoId')::bigint AS repo_id, share->>'viewerTreeSha' AS tree_sha,
                (share->>'viewerGeneration')::bigint AS generation
              FROM harness_shared.report_library_shares WHERE github_user_id=${accountId}
                AND share->>'repoId' IS NOT NULL AND share->>'viewerTreeSha' IS NOT NULL
                AND share->>'viewerGeneration' IS NOT NULL
              ORDER BY (share->>'viewerGeneration')::bigint DESC LIMIT 1`;
            // State transitions on old reports do not advance this generation.
            return row ? { repoId: Number(row.repo_id), treeSha: row.tree_sha, generation: Number(row.generation) } : null;
          },
          async list(workspaceId, reportId) {
            const rows = await connection<{ share: ReportShare }[]>`SELECT share FROM harness_shared.report_library_shares
              WHERE workspace_id=${workspaceId} AND report_id=${reportId}`;
            return rows.map(row => row.share);
          },
          async get(workspaceId, reportId, accountId) {
            const [found] = await connection<{ share: ReportShare }[]>`
              SELECT share FROM harness_shared.report_library_shares
              WHERE workspace_id=${workspaceId} AND report_id=${reportId} AND github_user_id=${accountId}`;
            return found?.share ?? null;
          },
          async put(share) {
            await connection`INSERT INTO harness_shared.report_library_shares
              (workspace_id,report_id,github_user_id,share) VALUES
              (${share.workspaceId},${share.reportId},${share.accountId},${connection.json(share as unknown as postgres.JSONValue)})
              ON CONFLICT (workspace_id,report_id,github_user_id) DO UPDATE SET share=EXCLUDED.share,updated_at=now()`;
          },
        });
      } finally {
        try { if (held) await connection`SELECT pg_advisory_unlock(hashtextextended(${key}, 0))`; }
        finally { connection.release(); }
      }
    },
  };
}
