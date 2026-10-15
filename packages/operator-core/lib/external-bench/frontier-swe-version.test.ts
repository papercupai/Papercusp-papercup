import { describe, expect, it } from 'vitest';
import {
  FRONTIER_SWE_V1_TASK_SET_IDS,
  FRONTIER_SWE_V2_TASK_SET_IDS,
  frontierSweTaskSetVersion,
  frontierSweVersionLabel,
} from './frontier-swe-version';
import * as taskSets from './task-sets';

describe('FrontierSWE task-set version (P-016, browser-safe shared source)', () => {
  it('classifies every v2 id as v2 and every v1 id as v1; the two id sets never overlap', () => {
    for (const id of FRONTIER_SWE_V2_TASK_SET_IDS) expect(frontierSweTaskSetVersion(id)).toBe('v2');
    for (const id of FRONTIER_SWE_V1_TASK_SET_IDS) expect(frontierSweTaskSetVersion(id)).toBe('v1');
    const v1 = new Set<string>(FRONTIER_SWE_V1_TASK_SET_IDS);
    expect(FRONTIER_SWE_V2_TASK_SET_IDS.filter(id => v1.has(id))).toEqual([]);
  });

  it('returns null for non-FrontierSWE, empty and missing task-set ids', () => {
    for (const id of ['swe-bench-pro', 'frontier-swe-v3', 'frontier-swe-v2-extra', '', null, undefined]) {
      expect(frontierSweTaskSetVersion(id)).toBeNull();
      expect(frontierSweVersionLabel(id)).toBeNull();
    }
  });

  it('labels a v2 run "FrontierSWE v2" and a v1 run "FrontierSWE v1"', () => {
    expect(frontierSweVersionLabel('frontier-swe-v2-cpu')).toBe('FrontierSWE v2');
    expect(frontierSweVersionLabel('frontier-swe-pilot')).toBe('FrontierSWE v1');
  });

  it('task-sets.ts re-exports this single source rather than a second copy', () => {
    expect(taskSets.frontierSweTaskSetVersion).toBe(frontierSweTaskSetVersion);
    expect(taskSets.FRONTIER_SWE_V2_TASK_SET_IDS).toBe(FRONTIER_SWE_V2_TASK_SET_IDS);
    expect(taskSets.FRONTIER_SWE_V1_TASK_SET_IDS).toBe(FRONTIER_SWE_V1_TASK_SET_IDS);
  });
});
