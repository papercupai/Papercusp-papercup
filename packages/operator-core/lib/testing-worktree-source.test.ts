import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifierSourceFiles, type VerifierSourceReceipt } from './verifier-source';
import { captureTestSourceSnapshot, captureTestSourceSnapshotAsync, captureWorktreeSnapshotAsync, computeWorktreeDirty, resolveReporterSourceRoot } from './testing-worktree';

const gitProbe = vi.hoisted(() => vi.fn(() => { throw new Error('Git probe must not run for an archive'); }));
const asyncGit = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), execFileSync: gitProbe,
}));
vi.mock('./fleet/git-via-sidecar', () => ({ execFileViaSidecar: asyncGit }));

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  gitProbe.mockClear();
  asyncGit.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function archive() {
  const parent = mkdtempSync(join(tmpdir(), 'testing-source-'));
  roots.push(parent);
  const root = join(parent, 'source');
  mkdirSync(root);
  writeFileSync(join(root, 'journey.ts'), 'export const task = "preference";\n');
  const files = verifierSourceFiles(root);
  const receipt: VerifierSourceReceipt = {
    schemaVersion: 'verifier-source-v1', sourceCommit: 'c'.repeat(40),
    testedInputs: [{ path: files[0].path, sha256: files[0].sha256 }], files,
  };
  const external = join(parent, 'receipt.json');
  writeFileSync(join(root, '.verifier-source.json'), JSON.stringify(receipt));
  writeFileSync(external, JSON.stringify(receipt));
  vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', external);
  return { root, external, receipt };
}

describe('receipt-backed test source snapshots', () => {
  it('stops at the archive marker before an enclosing Git checkout', () => {
    const { root } = archive();
    mkdirSync(join(root, '..', '.git'));
    const project = join(root, 'packages/core/e2e');
    mkdirSync(project, { recursive: true });
    expect(resolveReporterSourceRoot(project)).toBe(root);
  });
  it('attests both source boundaries without Git, including independent runtime dependencies', () => {
    const { root, receipt } = archive();
    const before = captureTestSourceSnapshot(root);
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'runtime.js'), 'dependency output');
    const after = captureTestSourceSnapshot(root);
    expect(before).toEqual({ commit: receipt.sourceCommit, porcelain: '' });
    expect(after).toEqual(before);
    expect(computeWorktreeDirty(before, after)).toBe(false);
    expect(gitProbe).not.toHaveBeenCalled();
  });

  it('marks a run dirty when recorded source changes after its initial snapshot', () => {
    const { root } = archive();
    const before = captureTestSourceSnapshot(root);
    writeFileSync(join(root, 'journey.ts'), 'export const task = "changed";\n');
    const after = captureTestSourceSnapshot(root);
    expect(after).toMatchObject({ commit: null, porcelain: null,
      provenanceError: expect.stringContaining('changed journey.ts') });
    expect(computeWorktreeDirty(before, after)).toBe(true);
    expect(gitProbe).not.toHaveBeenCalled();
  });

  it('refuses missing independent receipts and receipts placed inside the source archive', () => {
    const { root, external } = archive();
    vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', '');
    expect(captureTestSourceSnapshot(root).provenanceError).toContain('missing independent');
    const internal = join(root, 'receipt.json');
    writeFileSync(internal, readFileSync(external));
    vi.stubEnv('VERIFY_TAURI_SOURCE_RECEIPT', internal);
    expect(captureTestSourceSnapshot(root)).toMatchObject({ commit: null, porcelain: null,
      provenanceError: expect.stringContaining('must be outside the archive') });
    expect(gitProbe).not.toHaveBeenCalled();
  });
});

describe('async worktree snapshots', () => {
  it('keeps independent archive custody and refuses changed source without ambient Git', async () => {
    const { root, receipt } = archive();
    await expect(captureTestSourceSnapshotAsync(root)).resolves.toEqual({ commit: receipt.sourceCommit, porcelain: '' });
    writeFileSync(join(root, 'journey.ts'), 'changed source');
    const after = await captureTestSourceSnapshotAsync(root);
    expect(after.provenanceError).toContain('changed journey.ts');
    expect(computeWorktreeDirty({ commit: receipt.sourceCommit, porcelain: '' }, after)).toBe(true);
    expect(asyncGit).not.toHaveBeenCalled();
    expect(gitProbe).not.toHaveBeenCalled();
  });

  it('uses async Git reads, honors mutation-probe origin roots, and stays responsive while they settle', async () => {
    vi.stubEnv('PAPERCUSP_MUTATION_PROBE', '1');
    vi.stubEnv('PAPERCUSP_MUTATION_PROBE_ORIGIN_ROOT', '/probe-origin');
    asyncGit.mockImplementation(async (_command: string, args: string[]) => {
      await new Promise<void>(resolve => setImmediate(resolve));
      return args.includes('status')
        ? { stdout: '', stderr: '' }
        : { stdout: `${'a'.repeat(40)}\n`, stderr: '' };
    });

    let timerFired = false;
    setTimeout(() => { timerFired = true; }, 0);
    const pending = captureWorktreeSnapshotAsync('/requested-root');
    await new Promise<void>(resolve => setTimeout(resolve, 0));

    await expect(pending).resolves.toEqual({ commit: 'a'.repeat(40), porcelain: '' });
    expect(timerFired).toBe(true);
    expect(asyncGit).toHaveBeenCalledTimes(3);
    expect(asyncGit.mock.calls.map(([, , options]) => options.cwd)).toEqual([
      '/probe-origin', '/probe-origin', '/probe-origin',
    ]);
    expect(gitProbe).not.toHaveBeenCalled();
  });

  it('awaits status beyond the sync budget without blocking or certifying early', async () => {
    vi.useFakeTimers();
    asyncGit.mockImplementation(async (_command: string, args: string[]) => {
      if (args.includes('status')) await new Promise(resolve => setTimeout(resolve, 2_100));
      return { stdout: args.includes('status') ? '' : 'a'.repeat(40), stderr: '' };
    });
    let finished = false;
    const pending = captureTestSourceSnapshotAsync('/clean-checkout').then(result => { finished = true; return result; });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toEqual({ commit: 'a'.repeat(40), porcelain: '' });
    expect(asyncGit.mock.calls).toHaveLength(3);
    for (const [command, args, options] of asyncGit.mock.calls) {
      expect(command).toBe('git');
      expect(args[0]).toBe('--no-optional-locks');
      expect(options).toMatchObject({ cwd: '/clean-checkout', timeoutMs: 30_000,
        env: { GIT_OPTIONAL_LOCKS: '0' } });
    }
    expect(gitProbe).not.toHaveBeenCalled();
  });

  it.each(['status failure', 'changed HEAD', 'untracked source'])(
    'keeps %s fail-closed', async scenario => {
      let heads = 0;
      asyncGit.mockImplementation(async (_command: string, args: string[]) => {
        if (args.includes('status')) {
          if (scenario === 'status failure') throw new Error('child timeout: terminated and drained');
          return { stdout: scenario === 'untracked source' ? '?? source.ts\n' : '', stderr: '' };
        }
        return { stdout: (++heads === 2 && scenario === 'changed HEAD' ? 'b' : 'a').repeat(40), stderr: '' };
      });
      const after = await captureTestSourceSnapshotAsync('/checkout');
      expect(computeWorktreeDirty({ commit: 'a'.repeat(40), porcelain: '' }, after)).toBe(true);
      if (scenario === 'status failure') {
        expect(after.porcelain).toBeNull();
        expect(after.provenanceError).toContain('child timeout: terminated and drained');
      } else if (scenario === 'changed HEAD') {
        expect(after.commit).toBeNull();
        expect(after.provenanceError).toContain('HEAD changed');
      } else expect(after.porcelain).toBe('?? source.ts');
    },
  );
});
