import { describe, expect, it } from 'vitest';
import {
  ADMIN_TEST_RUNS_REPORTER_PATH,
  DEFAULT_UNIT_TEST_TIMEOUT_MS,
  gateParticipationConfig,
  sharedHostWorkerCap,
} from '@papercusp/test-config/vitest-config';
import rootConfig, { ROOT_VITEST_TSCONFIG_PROJECTS } from './vitest.config.ts';

describe('repository-root Vitest discovery', () => {
  it('excludes Papercusp scratch and retired trees from direct runs', () => {
    const excludes = (rootConfig.test as { exclude?: string[] } | undefined)?.exclude ?? [];

    expect(excludes).toEqual(
      expect.arrayContaining(['**/.papercusp/**', '**/_retired/**']),
    );
  });

  it('loads the operator workspace aliases for direct root runs', () => {
    expect(ROOT_VITEST_TSCONFIG_PROJECTS).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/[/\\]apps[/\\]operator[/\\]tsconfig\.json$/),
        expect.stringMatching(/[/\\]apps[/\\]operator-vite[/\\]tsconfig\.json$/),
      ]),
    );
    expect(rootConfig.plugins).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'vite-tsconfig-paths' })]),
    );
  });

  it('uses the shared unit deadline and worker cap for direct root runs', () => {
    const test = rootConfig.test as {
      pool?: string;
      testTimeout?: number;
      maxWorkers?: number;
      minWorkers?: number;
    };
    const expectedCap = sharedHostWorkerCap('forks');

    expect(test.pool).toBe('forks');
    expect(test.testTimeout).toBe(
      Number(process.env.VITEST_UNIT_TIMEOUT_MS) || DEFAULT_UNIT_TEST_TIMEOUT_MS,
    );
    expect({ maxWorkers: test.maxWorkers, minWorkers: test.minWorkers }).toEqual({
      maxWorkers: expectedCap.maxWorkers,
      minWorkers: expectedCap.minWorkers,
    });
  });

  it('records direct root runs through the shared test evidence reporters', () => {
    const reporters = (rootConfig.test as { reporters?: string[] } | undefined)?.reporters ?? [];

    expect(reporters).toContain(ADMIN_TEST_RUNS_REPORTER_PATH);
    expect(reporters).toEqual(expect.arrayContaining(gateParticipationConfig().reporters));
  });
});
