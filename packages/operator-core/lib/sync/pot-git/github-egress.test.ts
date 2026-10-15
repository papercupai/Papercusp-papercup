import { hiveEffectFixture } from './hive-effect-authority.fixture';
import { describe, expect, it } from 'vitest';

import { egressCanonicalRefs as egressCanonicalRefsUnderTest } from './github-egress';
import type { RunGit } from './storage';

const SHA = 'a'.repeat(40);
const REMOTE = 'https://github.com/acme/widgets.git';
const REF = 'refs/heads/staging';

describe('egressCanonicalRefs credential write preflight', () => {
  it('classifies a DNS failure from ls-remote as transient', async () => {
    const runGit: RunGit = async (args) => {
      if (args[0] === 'ls-remote') {
        return { code: 128, stdout: '', stderr: 'fatal: unable to access URL: Could not resolve host: github.com' };
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    };

    const result = await egressCanonicalRefs({
      repoPath: '/repo',
      remoteUrl: REMOTE,
      refs: [{ sha: SHA, remoteRef: REF }],
      runGit,
      scanSecrets: false,
    });

    expect(result.ok).toBe(false);
    expect(result.remoteErrors).toEqual([
      {
        message: expect.stringContaining('Could not resolve host: github.com'),
        transient: true,
      },
    ]);
  });

  it('records a DNS fetch failure as transient transport trouble, not a non-FF', async () => {
    const remoteSha = 'b'.repeat(40);
    const runGit: RunGit = async (args) => {
      if (args[0] === 'ls-remote') return { code: 0, stdout: `${remoteSha} ${REF}\n`, stderr: '' };
      if (args[0] === 'cat-file') return { code: 1, stdout: '', stderr: '' };
      if (args[0] === 'fetch') {
        return { code: 128, stdout: '', stderr: 'fatal: unable to access URL: Could not resolve host: github.com' };
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    };

    const result = await egressCanonicalRefs({
      repoPath: '/repo',
      remoteUrl: REMOTE,
      refs: [{ sha: SHA, remoteRef: REF }],
      runGit,
      scanSecrets: false,
    });

    expect(result.ok).toBe(false);
    expect(result.rejectedNonFF).toEqual([]);
    expect(result.remoteErrors).toEqual([
      {
        message: expect.stringContaining('Could not resolve host: github.com'),
        transient: true,
      },
    ]);
  });

  it('records an unverified-account rejection without attempting the real push', async () => {
    const calls: string[][] = [];
    const runGit: RunGit = async (args) => {
      calls.push(args);
      if (args[0] === 'ls-remote') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'push' && args[1] === '--dry-run') {
        return {
          code: 1,
          stdout: '',
          stderr: 'remote: You must verify your email address.\nfatal: unable to access repository',
        };
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    };

    const result = await egressCanonicalRefs({
      repoPath: '/repo',
      remoteUrl: REMOTE,
      refs: [{ sha: SHA, remoteRef: REF }],
      runGit,
      scanSecrets: false,
    });

    expect(result.ok).toBe(false);
    expect(result.pushed).toEqual([]);
    expect(result.remoteErrors).toEqual([
      {
        message: expect.stringContaining('You must verify your email address'),
        transient: false,
      },
    ]);
    expect(calls.filter((args) => args[0] === 'push')).toEqual([['push', '--dry-run', REMOTE, `${SHA}:${REF}`]]);
  });

  it('performs the real push only after the write preflight succeeds', async () => {
    const calls: string[][] = [];
    const runGit: RunGit = async (args) => {
      calls.push(args);
      if (args[0] === 'ls-remote') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'push') return { code: 0, stdout: '', stderr: '' };
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    };

    const result = await egressCanonicalRefs({
      repoPath: '/repo',
      remoteUrl: REMOTE,
      refs: [{ sha: SHA, remoteRef: REF }],
      runGit,
      scanSecrets: false,
    });

    expect(result.ok).toBe(true);
    expect(result.pushed).toEqual([{ remoteRef: REF, from: null, to: SHA }]);
    expect(calls.filter((args) => args[0] === 'push')).toEqual([
      ['push', '--dry-run', REMOTE, `${SHA}:${REF}`],
      ['push', REMOTE, `${SHA}:${REF}`],
    ]);
  });

  it('classifies a losing same-target CAS race as up-to-date after re-reading the remote', async () => {
    const oldSha = 'b'.repeat(40);
    const calls: string[][] = [];
    let lsRemoteReads = 0;
    const runGit: RunGit = async (args) => {
      calls.push(args);
      if (args[0] === 'ls-remote') {
        lsRemoteReads += 1;
        return {
          code: 0,
          stdout: `${lsRemoteReads === 1 ? oldSha : SHA} ${REF}\n`,
          stderr: '',
        };
      }
      if (args[0] === 'cat-file' || args[0] === 'merge-base') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'push' && args[1] === '--dry-run') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'push') {
        return {
          code: 1,
          stdout: '',
          stderr: `remote: error: cannot lock ref ${REF}: is at ${SHA} but expected ${oldSha}`,
        };
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    };

    const result = await egressCanonicalRefs({
      repoPath: '/repo',
      remoteUrl: REMOTE,
      refs: [{ sha: SHA, remoteRef: REF }],
      runGit,
      scanSecrets: false,
    });

    expect(result.ok).toBe(true);
    expect(result.upToDate).toEqual([REF]);
    expect(result.pushed).toEqual([]);
    expect(result.rejectedNonFF).toEqual([]);
    expect(result.remoteErrors).toEqual([]);
    expect(calls.filter((args) => args[0] === 'ls-remote')).toHaveLength(2);
  });
});

function egressCanonicalRefs(input: Parameters<typeof egressCanonicalRefsUnderTest>[0]) {
  return egressCanonicalRefsUnderTest({ ...hiveEffectFixture(), ...input });
}
