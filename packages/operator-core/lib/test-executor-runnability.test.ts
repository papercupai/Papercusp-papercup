import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import {
  createTestRunnabilityAuditor,
  findUnrunnableTests,
  matchesResolvedVitestContract,
  type TestRunnabilityDependencies,
} from './test-executor-runnability';

const ROOT = '/repo';

function route(file: string, cwd = '/repo/packages/example', config: string | null = 'vitest.config.ts') {
  return {
    cwd,
    config,
    absolute: resolve(ROOT, file),
    requested: file,
  };
}

function dependencies(
  overrides: Partial<TestRunnabilityDependencies> = {},
): TestRunnabilityDependencies {
  return {
    discoverRoute: (file) => route(file),
    resolveVitest: async () => ({
      root: '/repo/packages/example',
      include: ['lib/**/*.test.ts'],
      exclude: ['**/*.integration.test.ts'],
    }),
    exists: () => true,
    readPackageScript: (_path, script) =>
      script === 'test:e2e' ? 'playwright test' : 'wdio run wdio.conf.ts',
    ...overrides,
  };
}

describe('test executor runnability', () => {
  it('matches a file against the resolved config root, include, and exclude', () => {
    const config = {
      root: '/repo/packages/example',
      include: ['lib/**/*.{test,spec}.ts'],
      exclude: ['**/*.integration.test.ts'],
    };

    expect(matchesResolvedVitestContract('/repo/packages/example/lib/ok.test.ts', config)).toBe(true);
    expect(
      matchesResolvedVitestContract('/repo/packages/example/lib/no.integration.test.ts', config),
    ).toBe(false);
    expect(matchesResolvedVitestContract('/repo/packages/example/e2e/no.spec.ts', config)).toBe(false);
    expect(matchesResolvedVitestContract('/repo/other/outside.test.ts', config)).toBe(false);
  });

  it('uses config.dir as Vitest\'s matching base when it is present', () => {
    expect(
      matchesResolvedVitestContract('/repo/packages/example/src/ok.test.ts', {
        root: '/repo',
        dir: '/repo/packages/example',
        include: ['src/**/*.test.ts'],
        exclude: [],
      }),
    ).toBe(true);
  });

  it('resolves each owning Vitest config once and rejects excluded tests', async () => {
    const resolveVitest = vi.fn(async () => ({
      root: '/repo/packages/example',
      include: ['lib/**/*.test.ts'],
      exclude: ['**/*.integration.test.ts'],
    }));
    const audit = createTestRunnabilityAuditor(
      ROOT,
      dependencies({
        discoverRoute: (file) => route(file),
        resolveVitest,
      }),
    );

    await expect(audit('packages/example/lib/a.test.ts')).resolves.toMatchObject({
      runnable: true,
      executor: 'vitest',
    });
    await expect(audit('packages/example/lib/b.integration.test.ts')).resolves.toMatchObject({
      runnable: false,
    });
    expect(resolveVitest).toHaveBeenCalledTimes(1);
  });

  it('passes config-less routes to Vitest as explicit defaults', async () => {
    const resolveVitest = vi.fn(async () => ({
      root: '/repo/packages/example',
      include: ['**/*.test.ts'],
      exclude: [],
    }));
    const audit = createTestRunnabilityAuditor(
      ROOT,
      dependencies({
        discoverRoute: (file) => route(file, '/repo/packages/example', null),
        resolveVitest,
      }),
    );

    await audit('packages/example/lib/a.test.ts');
    expect(resolveVitest).toHaveBeenCalledWith({
      root: '/repo/packages/example',
      config: false,
    });
  });

  it('accepts the explicit Playwright and WebdriverIO contracts without Vitest routing', async () => {
    const discoverRoute = vi.fn();
    const audit = createTestRunnabilityAuditor(ROOT, dependencies({ discoverRoute }));

    await expect(audit('apps/operator/e2e/chat.spec.ts')).resolves.toMatchObject({
      runnable: true,
      executor: 'playwright',
    });
    await expect(audit('apps/operator/e2e/ongoing-work-native-collection.spec.mts')).resolves.toMatchObject({
      runnable: true,
      executor: 'playwright',
    });
    await expect(
      audit('tools/perf-test/wdio/specs/smoke.spec.ts'),
    ).resolves.toMatchObject({ runnable: true, executor: 'webdriverio' });
    expect(discoverRoute).not.toHaveBeenCalled();
  });

  it('follows same-package `npm run` chains to the executor — a chained script is not an executor gap', async () => {
    // The shape that produced a false lint:tests red on 2026-09-05 was a `test` chain with the
    // real wdio invocation one hop down. Since WI-10003821 the package's shape is: `test` is the
    // headless node:test suite (the gate runs it), and `test:all` chains to the wdio specs.
    const scripts: Record<string, string> = {
      test: 'npm run test:unit',
      'test:all': 'npm run typecheck && npm run test:unit && npm run test:wdio',
      typecheck: 'tsc --noEmit -p tsconfig.json',
      'test:unit': 'node --import tsx --test perf-report.node-test.ts',
      'test:wdio': 'wdio run wdio.conf.ts',
      'test:e2e': 'npm run-script test:e2e:real',
      'test:e2e:real': 'playwright test',
    };
    const discoverRoute = vi.fn();
    const audit = createTestRunnabilityAuditor(
      ROOT,
      dependencies({ discoverRoute, readPackageScript: (_path, script) => scripts[script] }),
    );

    await expect(audit('tools/perf-test/wdio/specs/smoke.spec.ts')).resolves.toMatchObject({
      runnable: true,
      executor: 'webdriverio',
    });
    await expect(audit('tools/perf-test/wdio/perf-report.node-test.ts')).resolves.toMatchObject({
      runnable: true,
      executor: 'node',
    });
    await expect(audit('apps/operator/e2e/chat.spec.ts')).resolves.toMatchObject({
      runnable: true,
      executor: 'playwright',
    });
    expect(discoverRoute).not.toHaveBeenCalled();
  });

  it('terminates on a cyclic `npm run` chain and fails closed when no executor is reachable', async () => {
    const scripts: Record<string, string> = {
      test: 'npm run test:all',
      'test:all': 'npm test',
    };
    const audit = createTestRunnabilityAuditor(
      ROOT,
      dependencies({ readPackageScript: (_path, script) => scripts[script] }),
    );

    await expect(audit('tools/perf-test/wdio/specs/smoke.spec.ts')).resolves.toMatchObject({
      runnable: false,
      reason: expect.stringContaining('WebdriverIO'),
    });
    await expect(audit('tools/perf-test/wdio/perf-report.node-test.ts')).resolves.toMatchObject({
      runnable: false,
      reason: expect.stringContaining('node --test'),
    });
  });

  it('does not accept a node --test executor that never names the wdio unit file', async () => {
    const scripts: Record<string, string> = {
      test: 'npm run test:unit',
      'test:unit': 'node --import tsx --test other-suite.test.ts',
    };
    const audit = createTestRunnabilityAuditor(
      ROOT,
      dependencies({ readPackageScript: (_path, script) => scripts[script] }),
    );
    await expect(audit('tools/perf-test/wdio/perf-report.node-test.ts')).resolves.toMatchObject({
      runnable: false,
    });
  });

  it('fails closed when an explicit runner entrypoint or discovered route is missing', async () => {
    const explicitAudit = createTestRunnabilityAuditor(
      ROOT,
      dependencies({
        exists: () => false,
      }),
    );
    await expect(explicitAudit('apps/operator/e2e/chat.spec.ts')).resolves.toMatchObject({
      runnable: false,
      reason: expect.stringContaining('Playwright'),
    });
    await expect(explicitAudit('apps/operator/e2e/ongoing-work-native-collection.spec.mts')).resolves.toMatchObject({
      runnable: false,
      reason: expect.stringContaining('Playwright'),
    });

    const failures = await findUnrunnableTests(
      ['packages/example/lib/no-owner.test.ts'],
      ROOT,
      dependencies({
        discoverRoute: () => {
          throw new Error('no Vitest config owns the file');
        },
      }),
    );
    expect(failures).toEqual([
      expect.objectContaining({
        file: 'packages/example/lib/no-owner.test.ts',
        runnable: false,
        reason: 'no Vitest config owns the file',
      }),
    ]);
  });

  it('accepts an explicit Node:test route', async () => {
    const audit = createTestRunnabilityAuditor(
      ROOT,
      dependencies({
        discoverRoute: (file) => ({ ...route(file), runner: 'node' }),
      }),
    );
    await expect(audit('packages/example/lib/node.test.js')).resolves.toMatchObject({
      runnable: true,
      executor: 'node',
    });
  });
});
