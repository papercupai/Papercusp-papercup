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
