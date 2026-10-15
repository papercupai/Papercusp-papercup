// Plan benchmark-coverage-frontierswe-v2-2026-10-10 P-020 / D-008: pre-grade evidence-integrity check.
import { describe, it, expect } from 'vitest';
import {
  checkContainerEvidenceIntegrity, FRONTIER_SWE_PROTECTED_PATHS, normalizeProtectedPath, parseDockerDiff,
  protectedPathViolations,
} from './evidence-integrity';
import { makeFrontierSweCloneGradeSeam } from './frontier-swe-seam';
import type { ProcExec } from './grader/swe-bench-pro';
import type { BenchTask } from './types';

function fakeExec(diff: { stdout?: string; code?: number; throws?: boolean }) {
  const calls: string[][] = [];
  const exec: ProcExec = async (_cmd, args) => {
    calls.push(args);
    if (args[0] === 'diff') {
      if (diff.throws) throw new Error('docker daemon gone');
      return { stdout: diff.stdout ?? '', stderr: diff.code ? 'no such container' : '', code: diff.code ?? 0 };
    }
    if (args[0] === 'exec' && args.includes('cat')) return { stdout: '0.5', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  };
  return { exec, calls };
}

const task = (graderMeta: Record<string, unknown> = {}): BenchTask => ({
  instanceId: 'cranelift-codegen-opt', repo: 'x', baseCommit: 'c', problemStatement: 'p',
  graderMeta: { dockerImage: 'img', ...graderMeta },
} as unknown as BenchTask);

const handle = { containerId: 'cid', image: 'img', instanceId: 'cranelift-codegen-opt' };

describe('parseDockerDiff', () => {
  it('parses A/C/D entries, including paths with spaces', () => {
    expect(parseDockerDiff('C /app\nA /app/my file.py\nD /tmp/x\n')).toEqual([
      { kind: 'C', path: '/app' }, { kind: 'A', path: '/app/my file.py' }, { kind: 'D', path: '/tmp/x' }]);
  });
  it('refuses an unrecognized line rather than reading it as clean', () => {
    expect(() => parseDockerDiff('C /app\nError: permission denied\n')).toThrow(/unrecognized docker diff line/);
  });
  // Fixture calibration (FSWE-P020-TAMPER@1): the fakeExec diffs below stand in for real
  // `docker diff`. These bytes were captured verbatim from Docker 29.4.0 on 2026-10-11
  // (debian:stable-slim; the container created /tests and /solution, appended to
  // /tests/test.sh, deleted /etc/motd, wrote "/solution/solve me.sh"). If the real
  // format drifts from the fixture shape, this case fails instead of the fixtures lying.
  it('parses real captured docker diff output and flags its protected writes', () => {
    const real = 'A /solution\nA /solution/solve me.sh\nC /etc\nD /etc/motd\nA /tests\nA /tests/test.sh\n';
    const entries = parseDockerDiff(real);
    expect(entries).toHaveLength(6);
    expect(protectedPathViolations(entries, FRONTIER_SWE_PROTECTED_PATHS).map((e) => e.path))
      .toEqual(['/solution', '/solution/solve me.sh', '/tests', '/tests/test.sh']);
  });
});

describe('protectedPathViolations', () => {
  const entries = parseDockerDiff('C /logs\nA /logs/agent/run.txt\nA /logs/verifier\nA /logs/verifier/reward.txt\nA /testsuite/x\nA /tests\n');
  it('matches a protected path and anything under it, but not a sibling prefix or a parent change', () => {
    expect(protectedPathViolations(entries, FRONTIER_SWE_PROTECTED_PATHS).map((e) => e.path))
      .toEqual(['/logs/verifier', '/logs/verifier/reward.txt', '/tests']);
  });
  it('normalizes trailing slashes and rejects unsafe paths', () => {
    expect(normalizeProtectedPath('/app/fixtures/')).toBe('/app/fixtures');
    for (const bad of ['/', 'app/x', '/app/../etc', '//x']) expect(() => normalizeProtectedPath(bad)).toThrow();
  });
});

describe('checkContainerEvidenceIntegrity', () => {
  it('clean when nothing protected changed', async () => {
    const { exec } = fakeExec({ stdout: 'C /app\nA /app/solution.rs\n' });
    expect(await checkContainerEvidenceIntegrity(exec, 'cid', FRONTIER_SWE_PROTECTED_PATHS)).toMatchObject({ verdict: 'clean' });
  });
  it.each([
    [{ code: 1 }, /docker diff exit 1/],
    [{ throws: true }, /docker daemon gone/],
    [{ stdout: 'garbage\n' }, /unrecognized/],
  ])('an unreadable diff %o is unverifiable, never clean', async (diff, error) => {
    const r = await checkContainerEvidenceIntegrity(fakeExec(diff).exec, 'cid', FRONTIER_SWE_PROTECTED_PATHS);
    expect(r.verdict).toBe('unverifiable');
    expect(r.verdict === 'unverifiable' && r.error).toMatch(error);
  });
});

describe('FrontierSWE seam grade() integrity gate', () => {
  it('a pre-planted reward file is invalid, and no verifier or staging runs', async () => {
    const { exec, calls } = fakeExec({ stdout: 'A /logs/verifier/reward.txt\n' });
    const g = await makeFrontierSweCloneGradeSeam({ version: 'v', exec, repoDir: '/vendor/fswe' }).grade(task(), handle);
    expect(g).toMatchObject({ resolved: null, score: null, graderStatus: 'invalid',
      detail: { integrity: { verdict: 'tampered', violations: [{ kind: 'A', path: '/logs/verifier/reward.txt' }] } } });
    expect(calls).toEqual([['diff', 'cid']]);
  });
  // FSWE-P020-TAMPER@1 falsifier: "A trial that edited tests/test.sh receives a numeric score."
  it.each([
    ['C /tests/test.sh\n', '/tests/test.sh'],
    ['C /root/tests/test.sh\n', '/root/tests/test.sh'],
    ['D /tests/test.sh\n', '/tests/test.sh'],
    ['A /solution/solve.sh\n', '/solution/solve.sh'],
  ])('an edited verifier file (%j) is invalid with no score, and the verifier never runs', async (stdout, path) => {
    const { exec, calls } = fakeExec({ stdout });
    const g = await makeFrontierSweCloneGradeSeam({ version: 'v', exec, repoDir: '/vendor/fswe' }).grade(task(), handle);
    expect(g).toMatchObject({ resolved: null, score: null, graderStatus: 'invalid',
      detail: { integrity: { verdict: 'tampered', violations: [{ path }] } } });
    expect(calls).toEqual([['diff', 'cid']]);
  });
  it('a task-declared fixture under /app is protected; the rest of /app is the submission', async () => {
    const meta = { protectedPaths: ['/app/bench/expected'] };
    const touched = await makeFrontierSweCloneGradeSeam({ version: 'v', exec: fakeExec({ stdout: 'C /app/bench/expected/out.json\n' }).exec })
      .grade(task(meta), handle);
    expect(touched.graderStatus).toBe('invalid');
    const free = await makeFrontierSweCloneGradeSeam({ version: 'v', exec: fakeExec({ stdout: 'C /app/src/lib.rs\n' }).exec })
      .grade(task(meta), handle);
    expect(free.graderStatus).not.toBe('invalid');
    expect(free.detail).toMatchObject({ integrity: { verdict: 'clean' } });
  });
  it('a malformed protectedPaths declaration or an unreadable diff is a grader error, not a score', async () => {
    const bad = await makeFrontierSweCloneGradeSeam({ version: 'v', exec: fakeExec({}).exec }).grade(task({ protectedPaths: '/app' }), handle);
    expect(bad).toMatchObject({ graderStatus: 'error', score: null, detail: { integrity: { verdict: 'unverifiable' } } });
    const down = await makeFrontierSweCloneGradeSeam({ version: 'v', exec: fakeExec({ code: 1 }).exec }).grade(task(), handle);
    expect(down).toMatchObject({ graderStatus: 'error', score: null });
  });
  it('the check runs BEFORE v1 staging copies /tests in (our own staging must not read as tampering)', async () => {
    const { exec, calls } = fakeExec({ stdout: '' });
    await makeFrontierSweCloneGradeSeam({ version: 'v', exec, repoDir: '/vendor/fswe' }).grade(task(), handle);
    const diffAt = calls.findIndex((c) => c[0] === 'diff');
    const cpAt = calls.findIndex((c) => c[0] === 'cp');
    expect(diffAt).toBe(0);
    expect(cpAt).toBeGreaterThan(diffAt);
  });
});
