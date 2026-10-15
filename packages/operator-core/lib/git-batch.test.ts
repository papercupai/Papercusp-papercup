// EI-24852529885337741 — runGitBatch runs N read-only gits from ONE `sh` (one host fork).
// Real git + real sh against a throwaway repo: the framing, per-command attribution and
// argv-quoting are shell behaviour, so a mock would test nothing.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildGitBatchInvocation,
  buildGitBatchScript,
  isReadOnlyGitBatchExec,
  parseHelperFrames,
  runGitBatch,
} from './git-batch';
import { commitRefFromBatch } from './dev-deploy-state';

let tmp: string;
let repo: string;

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-batch-'));
  repo = path.join(tmp, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('commit', '-q', '-m', 'first subject');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  git('add', 'b.txt');
  git('commit', '-q', '-m', 'second subject');
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('runGitBatch', () => {
  it('recognizes only the exact dev-deploy read-only batch invocation for lazy sidecar admission', () => {
    const safe = buildGitBatchInvocation([
      { repo, args: ['log', '-1', '--format=%H%n%ct%n%s', 'main^{commit}'] },
      { repo, args: ['rev-list', '--count', 'main~1..main'] },
    ], 'dev-deploy-state');
    expect(isReadOnlyGitBatchExec({ command: 'sh', args: safe.args })).toBe(true);

    const appendedShell = [...safe.args];
    appendedShell[1] += '\n touch /tmp/untrusted';
    expect(isReadOnlyGitBatchExec({ command: 'sh', args: appendedShell })).toBe(false);
    expect(isReadOnlyGitBatchExec({ command: 'bash', args: safe.args })).toBe(false);
    expect(isReadOnlyGitBatchExec({ command: 'sh', args: buildGitBatchInvocation([
      { repo, args: ['fetch', 'origin'] },
    ], 'dev-deploy-state').args })).toBe(false);
    expect(isReadOnlyGitBatchExec({ command: 'sh', args: buildGitBatchInvocation([
      { repo, args: ['log', '-1', '--output=/tmp/untrusted', 'HEAD'] },
    ], 'dev-deploy-state').args })).toBe(false);
    expect(isReadOnlyGitBatchExec({ command: 'sh', args: buildGitBatchInvocation([
      { repo, args: ['log', '-1', '--format=%H%n%ct%n%s', 'HEAD'] },
    ], 'other-caller').args })).toBe(false);
  });

  it('returns each command’s stdout and exit, in order, identical to running them one by one', async () => {
    const cmds = [
      { repo, args: ['log', '-1', '--format=%H%n%ct%n%s', 'main^{commit}'] },
      { repo, args: ['rev-list', '--count', 'main~1..main'] },
      { repo, args: ['rev-parse', 'HEAD'] },
    ];
    const results = await runGitBatch(cmds);
    expect(results).toHaveLength(3);
    cmds.forEach((cmd, i) => {
      expect(results[i]).toMatchObject({ code: 0, stdout: git(...cmd.args) });
    });
  });

  it('attributes a failure to its own command: exit code and stderr, neighbours unaffected', async () => {
    const [ok1, bad, ok2] = await runGitBatch([
      { repo, args: ['rev-parse', 'HEAD'] },
      { repo, args: ['log', '-1', '--format=%H', 'no-such-branch^{commit}'] },
      { repo, args: ['rev-list', '--count', 'HEAD'] },
    ]);
    expect(ok1).toMatchObject({ code: 0, stderr: '' });
    expect(bad?.code).not.toBe(0);
    expect(bad?.stdout).toBe('');
    expect(bad?.stderr).toMatch(/unknown revision|bad revision/);
    expect(ok2).toMatchObject({ code: 0, stdout: '2\n', stderr: '' });
  });

  it('passes values as argv, never as shell text', async () => {
    const marker = path.join(tmp, 'pwned');
    const format = `$(touch ${marker}) "q" 'x' \`id\` ;|& %s`;
    const [r] = await runGitBatch([{ repo, args: ['log', '-1', `--format=${format}`] }]);
    expect(r?.code).toBe(0);
    expect(r?.stdout).toBe(`$(touch ${marker}) "q" 'x' \`id\` ;|& second subject\n`);
    expect(fs.existsSync(marker)).toBe(false);
    // The script text carries only positional references.
    const { script, argv } = buildGitBatchScript([{ repo, args: ['log', `--format=${format}`] }]);
    expect(script).not.toContain(marker);
    expect(argv).toEqual([repo, 'log', `--format=${format}`]);
  });

  it('reports a command that never completed as null (helper timed out), keeping finished ones', async () => {
    // `hash-object --stdin` blocks on the helper's open stdin until the timeout kills it.
    const [done, stuck, never] = await runGitBatch(
      [
        { repo, args: ['rev-parse', 'HEAD'] },
        { repo, args: ['hash-object', '--stdin'] },
        { repo, args: ['rev-parse', 'HEAD'] },
      ],
      { timeoutMs: 1_500 },
    );
    expect(done).toMatchObject({ code: 0, stdout: git('rev-parse', 'HEAD') });
    expect(stuck).toBeNull();
    expect(never).toBeNull();
  });

  it('forks nothing for an empty batch', async () => {
    expect(await runGitBatch([])).toEqual([]);
  });

  it('ignores frames carrying a different nonce', () => {
    const nonce = 'a'.repeat(32);
    const forged = `x\u0000${'b'.repeat(32)} o0 0\u0000y\u0000${nonce} o0 0\u0000`;
    expect(parseHelperFrames(forged, nonce)).toEqual([
      { tag: 'o0', exit: 0, out: `x\u0000${'b'.repeat(32)} o0 0\u0000y` },
    ]);
  });
});

describe('commitRefFromBatch', () => {
  it('parses a successful log -1 into a CommitRef', async () => {
    const [r] = await runGitBatch([{ repo, args: ['log', '-1', '--format=%H%n%ct%n%s', 'main^{commit}'] }]);
    const out = commitRefFromBatch(repo, 'main', r ?? null);
    expect(out.unknown).toBeNull();
    expect(out.ref?.sha).toBe(git('rev-parse', 'main').trim());
    expect(out.ref?.subject).toBe('second subject');
    expect(out.ref?.committedAtMs).toBe(Number(git('log', '-1', '--format=%ct').trim()) * 1000);
  });

  it('classifies an absent ref as not-applicable, from that command’s own stderr', async () => {
    const [r] = await runGitBatch([{ repo, args: ['log', '-1', '--format=%H%n%ct%n%s', 'origin/main^{commit}'] }]);
    const out = commitRefFromBatch(repo, 'origin/main', r ?? null);
    expect(out.ref).toBeNull();
    expect(out.unknown?.code).toBe('not-applicable');
  });

  it('classifies a helper that never completed as resolver-failed, never as absent', () => {
    const out = commitRefFromBatch(repo, 'main', null);
    expect(out.ref).toBeNull();
    expect(out.unknown?.code).toBe('resolver-failed');
  });
});
