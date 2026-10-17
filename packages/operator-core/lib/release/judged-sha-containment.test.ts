import { describe, expect, it } from 'vitest';
import { containmentForPaths, isAncestorAsync, realGitProbe, revParseAsync, type GitProbe } from './judged-sha-containment';

const A = 'a'.repeat(40);

describe('containmentForPaths — the completion evidence a gate-red claim requires', () => {
  const probe = (blobs: Record<string, Record<string, string | null>>): GitProbe => ({
    revParse: () => null,
    isAncestor: () => null,
    blobAt: (_root, ref, path) => blobs[ref]?.[path] ?? null,
  });

  it('equal blobs mean the judged sha carries staging content', () => {
    const git = probe({ [A]: { 'x.ts': 'blob1' }, staging: { 'x.ts': 'blob1' } });
    const [row] = containmentForPaths(['x.ts'], A, '/repo', git, 'staging');
    expect(row.containedInJudgedSha).toBe(true);
  });

  it('different blobs mean the fix is NOT on the judged sha', () => {
    const git = probe({ [A]: { 'x.ts': 'old' }, staging: { 'x.ts': 'fixed' } });
    const [row] = containmentForPaths(['x.ts'], A, '/repo', git, 'staging');
    expect(row.containedInJudgedSha).toBe(false);
    expect(row.judgedBlob).toBe('old');
    expect(row.stagingBlob).toBe('fixed');
  });

  it('a path absent from BOTH refs is not contained — two nulls must not read as equal', () => {
    // The trap this pins: `null === null` would report a file that exists nowhere as
    // "contained", turning a missing fix into positive completion evidence.
    const git = probe({ [A]: {}, staging: {} });
    const [row] = containmentForPaths(['gone.ts'], A, '/repo', git, 'staging');
    expect(row.containedInJudgedSha).toBe(false);
  });

  it('resolves a file inside a submodule through each ref\'s gitlink pin', () => {
    const candidatePin = 'b'.repeat(40);
    const git = {
      ...probe({ [A]: {}, staging: {} }),
      submodulePaths: () => ['papercusp-desktop'],
      gitlinkAt: (_root: string, ref: string) =>
        ({ [A]: candidatePin, staging: candidatePin })[ref] ?? null,
      blobAtInSubmodule: (_root: string, _submodule: string, ref: string, path: string) =>
        ref === candidatePin && path === 'src-tauri/env-sidecars/staging/harness/blueprints/base/prompts/su.md'
          ? 'nested-blob'
          : null,
    } satisfies GitProbe;

    const [row] = containmentForPaths(
      ['papercusp-desktop/src-tauri/env-sidecars/staging/harness/blueprints/base/prompts/su.md'],
      A,
      '/repo',
      git,
      'staging',
    );

    expect(row).toMatchObject({
      containedInJudgedSha: true,
      judgedBlob: 'nested-blob',
      stagingBlob: 'nested-blob',
    });
  });

  it('keeps differing submodule blobs a negative containment verdict', () => {
    const candidatePin = 'b'.repeat(40);
    const stagingPin = 'c'.repeat(40);
    const git = {
      ...probe({ [A]: {}, staging: {} }),
      submodulePaths: () => ['papercusp-desktop'],
      gitlinkAt: (_root: string, ref: string) =>
        ({ [A]: candidatePin, staging: stagingPin })[ref] ?? null,
      blobAtInSubmodule: (_root: string, _submodule: string, ref: string) =>
        ref === candidatePin ? 'old-nested-blob' : ref === stagingPin ? 'new-nested-blob' : null,
    } satisfies GitProbe;

    const [row] = containmentForPaths(['papercusp-desktop/src-tauri/file.ts'], A, '/repo', git, 'staging');

    expect(row).toMatchObject({
      containedInJudgedSha: false,
      judgedBlob: 'old-nested-blob',
      stagingBlob: 'new-nested-blob',
    });
  });

  it('reports every requested path, in order', () => {
    const git = probe({ [A]: { 'a.ts': '1' }, staging: { 'a.ts': '1', 'b.ts': '2' } });
    const rows = containmentForPaths(['a.ts', 'b.ts'], A, '/repo', git, 'staging');
    expect(rows.map((r) => r.path)).toEqual(['a.ts', 'b.ts']);
    expect(rows.map((r) => r.containedInJudgedSha)).toEqual([true, false]);
  });
});

describe('realGitProbe — the documented rev-parse footgun must not reach callers', () => {
  const root = process.cwd();

  it('returns null (never the echoed ref string) for a path absent from the ref', () => {
    // A bare `git rev-parse <ref>:<missing>` PRINTS "<ref>:<missing>" to stdout before
    // exiting 128. Without --verify --quiet + a sha shape check, that string is captured
    // as though it were a blob sha, and the containment comparison silently goes wrong.
    const absent = realGitProbe.blobAt(root, 'HEAD', 'definitely/not/a/real/path-xyz.ts');
    expect(absent).toBeNull();
  });

  it('resolves a real path at HEAD to a sha-shaped value (positive control)', () => {
    const present = realGitProbe.blobAt(root, 'HEAD', 'package.json');
    expect(present).toMatch(/^[0-9a-f]{40,64}$/);
  });

  it('reports an unresolvable ref as null rather than a guess', () => {
    expect(realGitProbe.revParse(root, 'no-such-ref-xyz')).toBeNull();
  });

  it('HEAD resolves (positive control for the same instrument)', () => {
    expect(realGitProbe.revParse(root, 'HEAD')).toMatch(/^[0-9a-f]{40,64}$/);
  });

  it('isAncestor answers true for HEAD vs itself, and null for a bogus object', () => {
    const head = realGitProbe.revParse(root, 'HEAD');
    expect(head).not.toBeNull();
    expect(realGitProbe.isAncestor(root, head as string, head as string)).toBe(true);
    // A bad object must be UNKNOWN (null), not false.
    expect(realGitProbe.isAncestor(root, 'f'.repeat(40), head as string)).toBeNull();
  });
});

describe('revParseAsync — live callers must not block the operator event loop', () => {
  const root = process.cwd();

  it('runs the next event-loop timer while ref resolution is still pending', async () => {
    let commandFinished = false;
    let timerRan = false;
    const probe = revParseAsync(root, 'HEAD', async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      return A;
    }).then((result) => {
      commandFinished = true;
      return result;
    });

    await new Promise<void>((resolve) => setTimeout(() => {
      timerRan = true;
      resolve();
    }, 0));

    expect(timerRan).toBe(true);
    expect(commandFinished).toBe(false);
    await expect(probe).resolves.toBe(A);
  });

  it('returns null for invalid output or a failed Git command', async () => {
    await expect(revParseAsync(root, 'HEAD', async () => 'not-a-sha')).resolves.toBeNull();
    await expect(revParseAsync(root, 'HEAD', async () => {
      throw new Error('git is unavailable');
    })).resolves.toBeNull();
  });
});

describe('isAncestorAsync — live callers must not block the operator event loop', () => {
  const root = process.cwd();

  it('runs the next event-loop timer while an ancestry command is still pending', async () => {
    let commandFinished = false;
    let timerRan = false;
    const probe = isAncestorAsync(root, 'a'.repeat(40), 'b'.repeat(40), async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }).then((result) => {
      commandFinished = true;
      return result;
    });

    await new Promise<void>((resolve) => setTimeout(() => {
      timerRan = true;
      resolve();
    }, 0));

    expect(timerRan).toBe(true);
    expect(commandFinished).toBe(false);
    await expect(probe).resolves.toBe(true);
  });

  it('keeps true, non-ancestor, and probe-failure results distinct', async () => {
    const head = realGitProbe.revParse(root, 'HEAD');
    expect(head).not.toBeNull();
    await expect(isAncestorAsync(root, head as string, head as string)).resolves.toBe(true);

    const notAncestor = Object.assign(new Error('not an ancestor'), { code: 1 });
    await expect(isAncestorAsync(root, 'a'.repeat(40), 'b'.repeat(40), async () => {
      throw notAncestor;
    })).resolves.toBe(false);

    const unavailable = Object.assign(new Error('git is unavailable'), { code: 'ENOENT' });
    await expect(isAncestorAsync(root, 'a'.repeat(40), 'b'.repeat(40), async () => {
      throw unavailable;
    })).resolves.toBeNull();
  });
});
