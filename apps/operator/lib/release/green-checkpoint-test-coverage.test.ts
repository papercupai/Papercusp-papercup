import { describe, expect, it } from 'vitest';
import { buildGreenCheckpointEnv, testFileCoverageScopeEnv } from './green-checkpoint';

describe('P016 gate coverage telemetry scope', () => {
  const cfg = { checkpointRoot: '/repo-checkpoint', integrationRoot: '/repo', releaseRoot: '/repo-release' };
  const target = { workspaceId: 'workspace', installSlug: 'harness' };
  const candidate = 'a'.repeat(40);
  it('uses the judged candidate and separate scoped telemetry without changing CI ledger identity', () => {
    const env = { ...buildGreenCheckpointEnv(null, {}, 'coverage-run'),
      ...testFileCoverageScopeEnv(cfg.checkpointRoot, cfg, candidate, target) };
    expect(JSON.parse(env.PC_TEST_FILE_COVERAGE_SCOPE!)).toEqual({ workspaceId: 'workspace',
      harnessSlug: 'harness', executionRoot: cfg.checkpointRoot, repositoryRoot: cfg.integrationRoot, candidate });
    expect(env.GREEN_CHECKPOINT).toBe('1');
    expect(env.PAPERCUSP_TEST_RUN_SOURCE).toBe('ci');
    expect(env.PAPERCUSP_WORKSPACE_ID).toBeUndefined();
    expect(env.PAPERCUSP_TEST_RUN_HARNESS).toBeUndefined();
  });
  it('does not rebase a local, release, foreign, unscoped or unpinned run', () => {
    for (const root of [cfg.integrationRoot, cfg.releaseRoot, '/foreign'])
      expect(testFileCoverageScopeEnv(root, cfg, candidate, target)).toEqual({});
    expect(testFileCoverageScopeEnv(cfg.checkpointRoot, cfg, null, target)).toEqual({});
    expect(testFileCoverageScopeEnv(cfg.checkpointRoot, cfg, 'unknown', target)).toEqual({});
    expect(testFileCoverageScopeEnv(cfg.checkpointRoot, cfg, candidate, null)).toEqual({});
    const env = buildGreenCheckpointEnv(null, { PC_TEST_FILE_COVERAGE_SCOPE: 'host leak' });
    expect(env.PC_TEST_FILE_COVERAGE_SCOPE).toBeUndefined();
  });
});
