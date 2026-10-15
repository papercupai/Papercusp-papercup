import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  git: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFileSync: mocks.git }));
import { captureTestSourceSnapshot, computeWorktreeDirty } from '@papercusp/operator-core/lib/testing-worktree';

describe('Playwright source snapshots inside a mutation probe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('PAPERCUSP_MUTATION_PROBE', '1');
    vi.stubEnv('PAPERCUSP_MUTATION_PROBE_ORIGIN_ROOT', '/committed-proof');
    vi.stubEnv('PAPERCUSP_MUTATION_PROBE_SUBJECT', '/committed-proof/src/subject.ts');
    mocks.git.mockImplementation((_bin, args) => args[1] === '--show-toplevel' ? '/committed-proof'
      : args[0] === 'rev-parse' ? 'snapshot-sha' : ' M src/subject.ts');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('synchronously exempts the declared overlay subject before the native hook can start tests', () => {
    const before = captureTestSourceSnapshot('/committed-proof');
    const after = captureTestSourceSnapshot('/committed-proof');
    expect(before).not.toBeInstanceOf(Promise);
    expect(before).toEqual({ commit: 'snapshot-sha', porcelain: '' });
    expect(computeWorktreeDirty(before, after)).toBe(false);
  });

  it.each([
    { commit: 'snapshot-sha', porcelain: ' M src/unrelated.ts' },
    { commit: 'snapshot-sha', porcelain: null },
    { commit: null, porcelain: '' },
  ])('keeps unrelated edits or unavailable probe provenance dirty: %j', (after) => {
    const before = captureTestSourceSnapshot('/committed-proof');
    mocks.git.mockImplementation((_bin, args) => {
      if (args[1] === '--show-toplevel') return '/committed-proof';
      const value = args[0] === 'rev-parse' ? after.commit : after.porcelain;
      if (value === null) throw new Error('Git snapshot unavailable');
      return value;
    });
    const observed = captureTestSourceSnapshot('/committed-proof');
    expect(computeWorktreeDirty(before, observed)).toBe(true);
  });

  it('does not trust an origin or subject environment variable outside a marked probe', () => {
    vi.stubEnv('PAPERCUSP_MUTATION_PROBE', '0');
    const observed = captureTestSourceSnapshot('/committed-proof');
    expect(observed.porcelain).toBe('M src/subject.ts');
    expect(mocks.git).toHaveBeenCalledWith('git', expect.any(Array), expect.objectContaining({ cwd: '/committed-proof' }));
  });

  it.each([
    { code: 'ETIMEDOUT', status: null, signal: 'SIGTERM', stderr: '', expected: 'code=ETIMEDOUT' },
    { code: undefined, status: 128, signal: null, stderr: Buffer.from('fatal: invalid repository\n'), expected: 'status=128' },
  ])('preserves the actual Git failure mechanism while keeping missing status dirty: $expected', (failure) => {
    mocks.git.mockImplementation((_bin, args) => {
      if (args[0] === 'rev-parse') return 'snapshot-sha';
      throw Object.assign(new Error('Git failed'), failure);
    });
    const observed = captureTestSourceSnapshot('/committed-proof');
    expect(observed.commit).toBe('snapshot-sha');
    expect(observed.porcelain).toBeNull();
    expect(observed.provenanceError).toContain('git status --porcelain --untracked-files=all failed after');
    expect(observed.provenanceError).toContain('budget=2000ms');
    expect(observed.provenanceError).toContain(failure.expected);
    if (failure.stderr.length) expect(observed.provenanceError).toContain('fatal: invalid repository');
    expect(computeWorktreeDirty({ commit: 'snapshot-sha', porcelain: '' }, observed)).toBe(true);
  });

  it('bounds failure diagnostics without mistaking an unreadable snapshot for clean', () => {
    mocks.git.mockImplementation(() => { throw Object.assign(new Error('Git failed'), {
      status: 128, stderr: 'x'.repeat(5_000),
    }); });
    const observed = captureTestSourceSnapshot('/committed-proof');
    expect(observed.provenanceError!.length).toBeLessThanOrEqual(500);
    expect(observed.commit).toBeNull();
    expect(observed.porcelain).toBeNull();
  });
});
