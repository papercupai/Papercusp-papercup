import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as recorder from './fallback-observations';
import { HOST_STARTUP_MIGRATION_CASES } from './host-startup-migration-cases';
import { getDegradationMechanism } from '../system-health/degradation-watchdog';

beforeEach(() => { vi.spyOn(recorder, 'observeFallback').mockReturnValue(true); });
afterEach(() => { recorder._resetFallbackObservationsForTests(); vi.restoreAllMocks(); });

describe('P-012 real startup producers', () => {
  for (const testCase of HOST_STARTUP_MIGRATION_CASES) {
    it(testCase.id, async () => {
      const result = await testCase.run();
      expect(getDegradationMechanism(testCase.mechanism!)).toBeDefined();
      expect(result.route).toBe('observation');
      if (result.route === 'observation') {
        expect(result.observations.some((row) => row.applied === 0)).toBe(true);
        expect(result.observations.some((row) => row.applied === 1)).toBe(true);
      }
    });
  }
});
