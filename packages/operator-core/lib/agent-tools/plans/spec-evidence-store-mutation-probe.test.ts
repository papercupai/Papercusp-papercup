import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const lockState = vi.hoisted(() => ({
  activeLocks: [] as Array<{ coordinationDomain: string; path: string; intent: string }>,
  calls: [] as Array<{ coordinationDomain: string; paths: string[] }>,
}));

vi.mock('../locks/su-lock-store', () => ({
  ensureBootstrap: vi.fn(async () => undefined),
  getTxPool: vi.fn(() => ({})),
  readQueue: vi.fn(async (_pool: unknown, args: { coordinationDomain: string; paths: string[] }) => {
    lockState.calls.push(args);
    return {
      active_locks: lockState.activeLocks.filter(
        (lock) => lock.coordinationDomain === args.coordinationDomain && args.paths.includes(lock.path),
      ),
      waiting: [],
      completed: [],
    };
  }),
}));

const { measureRepoFilesEvidenceDetailedAtRoot } = await import('./spec-evidence-store');

let root: string;
let nestedRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'spec-evidence-probe-lock-'));
  nestedRoot = join(root, 'libs', 'papercusp');
  mkdirSync(join(root, '.git'));
  mkdirSync(nestedRoot, { recursive: true });
  writeFileSync(join(nestedRoot, '.git'), 'gitdir: ../.git/modules/papercusp\n');
  writeFileSync(join(nestedRoot, 'source.ts'), 'export const value = 1;\n');
  lockState.activeLocks = [];
  lockState.calls = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const measurement = {
  schemaVersion: 1 as const,
  kind: 'repo-files' as const,
  sourcePaths: ['libs/papercusp/source.ts'],
};

describe('repo-file evidence mutation-probe fence', () => {
  it('refuses globbed fixture SQL while its owning repository has a mutation-probe lock', async () => {
    writeFileSync(join(nestedRoot, 'input.sql'), 'SELECT 1;\n');
    lockState.activeLocks = [{ coordinationDomain: resolve(nestedRoot), path: 'input.sql', intent: 'mutation probe' }];
    await expect(measureRepoFilesEvidenceDetailedAtRoot(root, {
      ...measurement, fixtureGlobs: ['libs/papercusp/*.sql'],
    })).rejects.toThrow(`repo_measurement_mutation_probe_active:${resolve(nestedRoot)}:input.sql`);
  });

  it('measures nested-repository files when no mutation-probe lock is active', async () => {
    const result = await measureRepoFilesEvidenceDetailedAtRoot(root, measurement);

    expect(result.files.map((file) => file.path)).toEqual(['libs/papercusp/source.ts']);
    expect(lockState.calls).toEqual([
      { coordinationDomain: resolve(nestedRoot), paths: ['source.ts'], includeWaiting: false },
      { coordinationDomain: resolve(nestedRoot), paths: ['source.ts'], includeWaiting: false },
    ]);
  });

  it('refuses a file fingerprint while its nested-repository mutation-probe lock is live', async () => {
    lockState.activeLocks = [{
      coordinationDomain: resolve(nestedRoot),
      path: 'source.ts',
      intent: 'mutation probe',
    }];

    await expect(measureRepoFilesEvidenceDetailedAtRoot(root, measurement))
      .rejects.toThrow(`repo_measurement_mutation_probe_active:${resolve(nestedRoot)}:source.ts`);
  });

  it('rechecks locks after reading so a probe that starts mid-measurement cannot bind its mutant', async () => {
    const lockStore = await import('../locks/su-lock-store');
    const readQueue = vi.mocked(lockStore.readQueue);
    readQueue.mockImplementationOnce(async () => ({ active_locks: [], waiting: [], completed: [] } as never));
    readQueue.mockImplementationOnce(async (_pool, args) => ({
      active_locks: [{
        coordination_domain: args.coordinationDomain,
        path: 'source.ts',
        intent: 'mutation probe',
      }],
      waiting: [],
      completed: [],
    } as never));

    await expect(measureRepoFilesEvidenceDetailedAtRoot(root, measurement))
      .rejects.toThrow(/repo_measurement_mutation_probe_active/);
  });
});
