import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { HarnessRegistry } from '../harness-registry';
import { filterTrackedRelativeScratchPaths } from './checkpoint-relative-scratch';

function registryAt(repoRoot: string): HarnessRegistry {
  return {
    projects: [{ slug: 'papercusp', path: repoRoot } as HarnessRegistry['projects'][number]],
  };
}

describe('checkpoint relative scratch-path warning filter', () => {
  it('suppresses only a path definitely tracked by the exact registered harness checkout', async () => {
    const repoRoot = mkdtempSync(nodePath.join(tmpdir(), 'papercusp-tracked-scratch-'));
    try {
      execFileSync('git', ['init', '-q', repoRoot], { stdio: 'ignore' });
      mkdirSync(nodePath.join(repoRoot, 'scratchpad'), { recursive: true });
      writeFileSync(nodePath.join(repoRoot, 'scratchpad', 'tracked.md'), 'tracked');
      execFileSync('git', ['-C', repoRoot, 'add', '--', 'scratchpad/tracked.md'], { stdio: 'ignore' });

      const refs = await filterTrackedRelativeScratchPaths(
        'The report is in `scratchpad/tracked.md`; another file is `scratchpad/untracked.md`.',
        { workspaceId: 'ws-1', harness: 'papercusp' },
        { loadRegistry: async () => registryAt(repoRoot) },
      );

      expect(refs).toEqual(['scratchpad/untracked.md']);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('keeps the warning when Git ownership is unknown or its probe throws', async () => {
    const repoRoot = mkdtempSync(nodePath.join(tmpdir(), 'papercusp-unknown-scratch-'));
    try {
      const prose = 'The report is in `scratchpad/unknown.md`.';
      const scope = { workspaceId: 'ws-1', harness: 'papercusp' };
      const loadRegistry = async () => registryAt(repoRoot);

      await expect(
        filterTrackedRelativeScratchPaths(prose, scope, { loadRegistry, isTracked: () => undefined }),
      ).resolves.toEqual(['scratchpad/unknown.md']);
      await expect(
        filterTrackedRelativeScratchPaths(prose, scope, {
          loadRegistry,
          isTracked: () => {
            throw new Error('git unavailable');
          },
        }),
      ).resolves.toEqual(['scratchpad/unknown.md']);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('keeps the warning when the harness registry cannot resolve its checkout', async () => {
    const prose = 'The report is in `scratchpad/unknown-root.md`.';
    await expect(
      filterTrackedRelativeScratchPaths(prose, { workspaceId: 'ws-1', harness: 'papercusp' }, {
        // A successful registry read with no entry for this exact harness is the
        // normal unresolved-root case; a thrown loader logs through the timeout
        // wrapper and trips this suite's fail-on-console guard.
        loadRegistry: async () => ({ projects: [] }) as HarnessRegistry,
      }),
    ).resolves.toEqual(['scratchpad/unknown-root.md']);
  });
});
