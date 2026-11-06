import type { PlanRevisionSql } from './revisions';
import { planExecutionMeaning } from './plan-execution-meaning';

/** Local authority may survive a same-meaning rewrite, never a scope change.
 * Kept as a leaf so federation does not import the execution-policy readers. */
export async function preservePlanExecutionProgress(tx: PlanRevisionSql,
  scope: { workspaceId: string; harnessSlug: string; planSlug: string },
  before: string, after: string, beforeHash: string, afterHash: string): Promise<void> {
  if (planExecutionMeaning(before) !== planExecutionMeaning(after)) return;
  await tx`SELECT set_config('papercusp.execution_progress',
    ${JSON.stringify([scope.workspaceId, scope.harnessSlug, scope.planSlug, beforeHash, afterHash])}, true)`;
}
