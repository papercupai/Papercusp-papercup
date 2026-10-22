import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { deploymentPositionForPathsMock, gitPipelinePosition } = vi.hoisted(() => ({
  deploymentPositionForPathsMock: vi.fn(),
  gitPipelinePosition: vi.fn(),
}));
vi.mock('../../git-pipeline-position', () => ({ gitPipelinePosition }));
vi.mock('../../deployment-position', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../deployment-position')>();
  return { ...actual, deploymentPositionForPaths: deploymentPositionForPathsMock };
});

import {
  deploymentPositionForEvidence,
  DEPLOYMENT_POSITION_EVIDENCE_TIMEOUT_MS,
} from './deployment-position';

function position(path: string, overrides: Record<string, unknown> = {}) {
  return {
    targetSha: `${path}-sha`,
    deployedSha: 'deployed-sha',
    positions: { committedLocal: true, onStaging: true, inMain: true, deployed: true },
    blockedOn: null,
    positionsUnknown: [],
    ...overrides,
  };
}

beforeEach(() => {
  deploymentPositionForPathsMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('deploymentPositionForEvidence', () => {
  it('returns no signal when completion evidence is absent and an explicit unknown when paths are absent', async () => {
    await expect(deploymentPositionForEvidence(null)).resolves.toBeUndefined();
    await expect(deploymentPositionForEvidence({ verifiedHow: 'unit' })).resolves.toMatchObject({
      paths: [],
      unknownPaths: [],
      totalPaths: 0,
      truncated: false,
      unknownReason: 'no-filesChanged',
    });
  });

  it('collects top-level and nested filesChanged paths before delegating to the shared reader', async () => {
    const expected = {
      paths: [
        { path: 'src/a.ts', ...position('src/a.ts') },
        { path: 'src/b.ts', ...position('src/b.ts') },
      ],
      unknownPaths: [],
      totalPaths: 2,
      truncated: false,
    };
    deploymentPositionForPathsMock.mockResolvedValue(expected);

    const result = await deploymentPositionForEvidence({
      filesChanged: ['src/a.ts'],
      verification: { filesChanged: ['src/b.ts', 'src/a.ts'] },
    });

    expect(deploymentPositionForPathsMock).toHaveBeenCalledTimes(1);
    expect(deploymentPositionForPathsMock.mock.calls[0]?.[0]).toEqual(['src/a.ts', 'src/b.ts']);
    expect(deploymentPositionForPathsMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(deploymentPositionForPathsMock.mock.calls[0]?.[1]?.deadlineMs).toBeGreaterThan(Date.now());
    expect(result).toEqual(expected);
  });

  it('degrades to an honest timeout unknown and aborts the shared read when it never settles', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const paths = ['src/a.ts', 'src/b.ts'];
    let signal: AbortSignal | undefined;
    deploymentPositionForPathsMock.mockImplementation(
      (_paths: string[], options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        return new Promise(() => {});
      },
    );
    vi.useFakeTimers();
    const resultPromise = deploymentPositionForEvidence({ filesChanged: paths });
    await Promise.resolve();
    const startedSharedRead = deploymentPositionForPathsMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(DEPLOYMENT_POSITION_EVIDENCE_TIMEOUT_MS);
    const result = await resultPromise;
    warnSpy.mockRestore();

    expect(startedSharedRead).toBe(1);
    expect(signal?.aborted).toBe(true);
    expect(result).toEqual({
      paths: [],
      unknownPaths: paths,
      totalPaths: 2,
      truncated: false,
      unknownReason: 'timeout',
    });
  });

  it('resolves promptly (well inside the timeout) when gitPipelinePosition answers fast', async () => {
    const expected = {
      paths: [{ path: 'src/a.ts', ...position('src/a.ts') }],
      unknownPaths: [],
      totalPaths: 1,
      truncated: false,
    };
    deploymentPositionForPathsMock.mockResolvedValue(expected);
    const start = Date.now();

    const result = await deploymentPositionForEvidence({ filesChanged: ['src/a.ts'] });

    expect(Date.now() - start).toBeLessThan(DEPLOYMENT_POSITION_EVIDENCE_TIMEOUT_MS);
    expect(result?.unknownReason).toBeUndefined();
    expect(deploymentPositionForPathsMock).toHaveBeenCalledTimes(1);
    expect(result?.paths).toHaveLength(1);
    expect(result).toEqual(expected);
  });
});
