import { describe, expect, it, vi } from 'vitest';
import { ROUTINE_FALLBACK_MIGRATION_CASES } from './routine-fallback-migration-cases';
import { listDegradationMechanisms } from '../system-health/degradation-watchdog';
import * as recorder from './fallback-observations';
import { readFileSync } from 'node:fs';
import { scanSites } from '../../../../scripts/lib/condition-rail-inventory.mjs';

describe('P-009 original routine fallback producers', () => {
  it('preserves the exact original row identities and own-function rail calls for implemented cases', () => {
    const sites = new Map<string, ReturnType<typeof scanSites>>();
    for (const testCase of ROUTINE_FALLBACK_MIGRATION_CASES) for (const id of testCase.rowIds) {
      const path = id.split('|')[1];
      if (!sites.has(path)) sites.set(path, scanSites(readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8'), path));
      expect(sites.get(path)!.find((site) => site.id === id), id).toMatchObject({ id, onRail: true });
    }
  });
  for (const testCase of ROUTINE_FALLBACK_MIGRATION_CASES) {
    it(testCase.id, async () => {
      const sink = vi.spyOn(recorder, 'observeFallback').mockReturnValue(true);
      try {
        if (testCase.route === 'observation') expect(listDegradationMechanisms().map((m) => m.mechanism)).toContain(testCase.mechanism);
        const result = await testCase.run();
        expect(result.route).toBe(testCase.route);
        if (result.route === 'observation') {
          expect(result.observations.some((o) => o.applied === 0)).toBe(true);
          expect(result.observations.some((o) => o.applied === 1)).toBe(true);
        } else {
          expect(result.openedKeys.length).toBeGreaterThan(0);
          expect(result.openedKeys).toEqual(result.resolvedKeys);
        }
      } finally { sink.mockRestore(); }
    });
  }
});
