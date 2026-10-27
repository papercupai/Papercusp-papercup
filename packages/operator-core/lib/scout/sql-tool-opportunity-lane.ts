/** Ephemeral pull intake shared by Scout/Queen. Never attach this to CorpusDigest:
 * that object, its ref baseline and downstream cycle artifacts are persisted. */
import { pullSqlToolCandidates, type SqlCandidatePullContext } from '../sql-tool-candidate-pull';

export async function readSqlToolOpportunityLane(ctx: SqlCandidatePullContext,
  args: { harness?: string; limit?: number } = {}) {
  return await pullSqlToolCandidates(ctx, args);
}
