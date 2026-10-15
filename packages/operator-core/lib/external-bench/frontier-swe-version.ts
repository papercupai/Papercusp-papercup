/**
 * FrontierSWE task-set ids and the corpus version each one loads — the ONE browser-safe source (no node imports),
 * shared by the server loader (task-sets.ts re-exports these) and the Evaluation surface's version badge
 * (plan benchmark-coverage-frontierswe-v2-2026-10-10 P-016, FSWE-P016-BADGE: a v2 run never renders as v1 or
 * without a version).
 */

/** The v1 (HISTORY) FrontierSWE task-set ids — loaded from task-sets.ts frontierSweTaskSetPath. */
export const FRONTIER_SWE_V1_TASK_SET_IDS = [
  'frontier-swe-pilot',
  'frontier-swe',
  'frontier-swe-cpu',
  'frontier-swe-custom',
] as const;

/** The v2 FrontierSWE task-set ids — loaded from task-sets.ts frontierSweV2TaskSetPath; never mixed with v1 (R-1). */
export const FRONTIER_SWE_V2_TASK_SET_IDS = [
  'frontier-swe-v2-pilot',
  'frontier-swe-v2',
  'frontier-swe-v2-cpu',
  'frontier-swe-v2-custom',
] as const;

export type FrontierSweCorpusVersion = 'v1' | 'v2';

/** Which corpus version a FrontierSWE task-set id loads, or null when it is not a FrontierSWE set (or absent). */
export function frontierSweTaskSetVersion(taskSetId: string | null | undefined): FrontierSweCorpusVersion | null {
  if (!taskSetId) return null;
  if ((FRONTIER_SWE_V2_TASK_SET_IDS as readonly string[]).includes(taskSetId)) return 'v2';
  if ((FRONTIER_SWE_V1_TASK_SET_IDS as readonly string[]).includes(taskSetId)) return 'v1';
  return null;
}

/** Display label for a FrontierSWE run's corpus version ("FrontierSWE v2"), or null for any other task set. */
export function frontierSweVersionLabel(taskSetId: string | null | undefined): string | null {
  const version = frontierSweTaskSetVersion(taskSetId);
  return version ? `FrontierSWE ${version}` : null;
}
