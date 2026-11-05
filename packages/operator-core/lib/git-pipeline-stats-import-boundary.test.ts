import { expect, it, vi } from 'vitest';

// Healthy and paused snapshots have no repair owner to inspect. A throwing
// factory guards module evaluation without a host-dependent timing threshold.
vi.mock('./release/gate-red-ownership', () => {
  throw new Error('pipeline health eagerly loaded red-gate ownership');
});
vi.mock('./release/fixer-liveness', () => {
  throw new Error('pipeline health eagerly loaded fixer liveness');
});

it('loads pipeline health without evaluating optional repair controls', async () => {
  const { computePipelineHealth } = await import('./why-chain');
  const { gitPipelineSnapshot } = await import('./git-pipeline-stats');
  expect(computePipelineHealth).toBeTypeOf('function');
  expect(gitPipelineSnapshot).toBeTypeOf('function');
});
