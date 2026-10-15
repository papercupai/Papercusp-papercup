/**
 * EI-18682004530991057 (proposal 3) — `completionTreeStamp`: record WHICH COMMIT a
 * completion's verification was observed against.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * `testResult: "172 passed / 0 failed"` names no particular code. Every agent here
 * edits ONE shared working tree, so an unstamped result cannot be distinguished from
 * one describing an older revision — or a tree a peer was halfway through editing when
 * the suite ran. EI-18681435059177620 measured that directly: three measurements of one
 * file were each invalidated by an edit landing on top, producing a false alarm AND a
 * false all-clear within 25 minutes.
 *
 * Measured live 2026-08-12 (EI-20275701671571753): an agent ran the prompt-weight gate
 * against a DIRTY tree holding a half-finished peer edit, read 1604 chars, and filed a
 * fleet-blocking gate red. Neither the pre-edit state (1336) nor the post-edit state
 * (1478) can produce 1604 — the number described a transient that was never committed
 * and never existed for anybody else. A stamped measurement is self-evidently anchored.
 *
 * ── HOW THIS FILE PROVES ITSELF ────────────────────────────────────────────
 * Falsifiability is structural: the suite asserts BOTH directions, so a degenerate
 * implementation cannot pass it. One that always returned `undefined` fails every
 * "RESOLVES" case; one that returned a constant sha fails every "stays SILENT" case.
 * The silent half is the fail-open contract (EI-24 record-and-warn) — absence must mean
 * "not observed", never "clean".
 *
 * Two controls carry most of the weight, because both encode a WRONG stamp rather than
 * a missing one, and a wrong stamp is worse than none (it anchors evidence to code that
 * never produced it):
 *   - the packed-refs EXACT-match control, MEASURED 2026-08-12 to kill a last-path-segment
 *     comparison (`name.split('/').pop() === ref.split('/').pop()`) — the realistic wrong
 *     implementation, since it binds `refs/heads/staging` to `refs/remotes/origin/staging`
 *     and stamps a commit the local tree is not on;
 *   - the read-budget control, which fails any implementation that resolves HEAD by
 *     spawning `git` (see the spawn-free note below).
 *
 * ⚠ What that first control does NOT constrain, established by the same probe rather than
 * assumed: a full-ref `endsWith(ref)`/`includes(ref)` matcher SURVIVES it — and correctly
 * so, because `refs/remotes/origin/staging` does not end with `refs/heads/staging`. The
 * first mutation tried here was exactly that, and it survived; the control is stated in
 * terms of the mutation actually measured, not the one that sounded dangerous. Do not
 * re-broaden this claim without re-running the probe:
 *   scripts/mutation-probe.sh --in-tree --file <complete.ts> \
 *     --mutate "s{name === ref}{name?.split('/').pop() === ref.split('/').pop()}" \
 *     --test 'npm run test:file -- <this file>' --expect caught
 *
 * ⚠ SPAWN-FREE: EI-18808838427010743 (open, CRITICAL) measures each `git` spawn from the
 * bg-host as ~165ms of blocked event loop (fork() from a multi-GB-RSS parent costs
 * ~40ms/GB). work_items:complete is a fleet-wide hot path, so this must never shell out.
 *
 * PURE: the filesystem is injected, so this never touches a real tree.
 */
import { afterEach, describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  completionCheckoutRootForPath,
  completionRepoRootsFromRegistry,
  completionSettlementManifest,
  completionTreeStamp,
  completionTreeStampForClose,
  completionTreeStampForEvidence,
  resolveCanonicalCompletionRoot,
} from './complete';
import {
  committedCloseDowngradedForUnprovenContentIdentity,
  completionTreeContentIdentityMatches,
} from './completion-freshness';

const ROOT = '/repo';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const OTHER_SHA = '0000111122223333444455556666777788889999';
const TEMP_ROOTS: string[] = [];

describe('resolveCanonicalCompletionRoot', () => {
  it('resolves a linked worktree from its .git pointer and commondir', () => {
    const reads: string[] = [];
    const metadata = new Map<string, string>([
      ['/staging/.git', 'gitdir: /canonical/.git/worktrees/staging\n'],
      ['/canonical/.git/worktrees/staging/commondir', '../..\n'],
    ]);

    expect(
      resolveCanonicalCompletionRoot('/staging', {
        readFile: (absPath) => {
          reads.push(absPath);
          return metadata.get(absPath);
        },
      }),
    ).toBe('/canonical');
    expect(reads).toEqual(['/staging/.git', '/canonical/.git/worktrees/staging/commondir']);
  });

  it('fails open to the detected root for malformed or non-worktree metadata', () => {
    expect(
      resolveCanonicalCompletionRoot('/staging', {
        readFile: (absPath) =>
          ({
            '/staging/.git': 'gitdir: /canonical/.git/not-a-worktree\n',
            '/canonical/.git/not-a-worktree/commondir': '../..\n',
          })[absPath],
      }),
    ).toBe('/staging');
    expect(resolveCanonicalCompletionRoot('/repo', { readFile: () => undefined })).toBe('/repo');
  });

  it('orders the canonical checkout first while retaining the detected linked worktree', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'completion-linked-root-order-'));
    TEMP_ROOTS.push(workspaceRoot);
    const canonicalRoot = join(workspaceRoot, 'canonical');
    const detectedRoot = join(workspaceRoot, 'staging');
    const worktreeGitDir = join(canonicalRoot, '.git', 'worktrees', 'staging');
    mkdirSync(worktreeGitDir, { recursive: true });
    mkdirSync(detectedRoot, { recursive: true });
    writeFileSync(join(detectedRoot, '.git'), `gitdir: ${worktreeGitDir}\n`);
    writeFileSync(join(worktreeGitDir, 'commondir'), '../..\n');

    const roots = completionRepoRootsFromRegistry(
      detectedRoot,
      { projects: [] },
      [],
      { homeRoot: join(workspaceRoot, 'empty-home') },
    );
    expect(roots.slice(0, 2)).toEqual([canonicalRoot, detectedRoot]);
  });
});

afterEach(() => {
  for (const root of TEMP_ROOTS.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('completionSettlementManifest', () => {
  const identity = {
    path: 'src/fix.ts',
    workingTreeBlobSha: 'b'.repeat(40),
    headBlobSha: 'c'.repeat(40),
  };
  it('derives a versioned, deterministic receipt from server-stamped evidence', () => {
    const evidence = {
      filesChanged: ['src/fix.ts'],
      testsRun: 'npm test',
      treeStamp: { repositoryRoot: '/repo/../repo', headSha: SHA, contentIdentity: [identity] },
    };
    const first = completionSettlementManifest(evidence);
    expect(first).toEqual(
      completionSettlementManifest({
        treeStamp: evidence.treeStamp,
        testsRun: evidence.testsRun,
        filesChanged: evidence.filesChanged,
      }),
    );
    expect(first).toMatchObject({
      version: 1,
      generation: 1,
      repositoryRoot: ROOT,
      headSha: SHA,
      normalizedPaths: ['src/fix.ts'],
      contentIdentity: [identity],
    });
    expect(first?.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('preserves identical relative paths owned by distinct checkouts', () => {
    const samePath = 'src/fix.ts';
    const siblingHead = 'd'.repeat(40);
    const receipt = completionSettlementManifest({
      treeStamp: {
        repositoryRoot: ROOT,
        headSha: SHA,
        contentIdentity: [
          identity,
          {
            path: samePath,
            workingTreeBlobSha: 'e'.repeat(40),
            headBlobSha: 'f'.repeat(40),
            repositoryRoot: '/sibling',
            headSha: siblingHead,
          },
        ],
      },
    });

    expect(receipt?.normalizedPaths).toEqual([samePath, samePath]);
    expect(receipt?.contentIdentity).toEqual([
      identity,
      {
        path: samePath,
        workingTreeBlobSha: 'e'.repeat(40),
        headBlobSha: 'f'.repeat(40),
        repositoryRoot: '/sibling',
        headSha: siblingHead,
      },
    ]);
  });
  it('does not invent a receipt without server-observed content identities', () => {
    expect(
      completionSettlementManifest({
        filesChanged: ['src/fix.ts'],
        treeStamp: { repositoryRoot: ROOT, headSha: SHA },
      }),
    ).toBeUndefined();
  });

  it('omits out-of-repo artifacts from settlement paths while retaining repo-backed proof', () => {
    const artifact = {
      path: '/tmp/proof.png',
      workingTreeBlobSha: null,
      headBlobSha: null,
      outOfRepoArtifact: true as const,
    };
    const evidence = {
      filesChanged: ['src/fix.ts', artifact.path],
      treeStamp: { repositoryRoot: ROOT, headSha: SHA, contentIdentity: [identity, artifact] },
    };

    expect(completionSettlementManifest(evidence)).toMatchObject({
      normalizedPaths: ['src/fix.ts'],
      contentIdentity: [identity],
    });
  });

  it('does not create a settlement receipt for an artifact-only completion', () => {
    expect(
      completionSettlementManifest({
        filesChanged: ['/tmp/proof.png'],
        treeStamp: {
          repositoryRoot: ROOT,
          headSha: SHA,
          contentIdentity: [
            { path: '/tmp/proof.png', workingTreeBlobSha: null, headBlobSha: null, outOfRepoArtifact: true },
          ],
        },
      }),
    ).toBeUndefined();
  });
});

/** Build a probe over a pretend git dir; also records every path read. */
function probeOver(files: Record<string, string>, repoRoot: string | null = ROOT) {
  const reads: string[] = [];
  return {
    reads,
    probe: {
      repoRoot,
      readFile: (abs: string): string | undefined => {
        reads.push(abs);
        return files[abs];
      },
    },
  };
}

describe('completionTreeStamp (EI-18682004530991057)', () => {
  describe('RESOLVES the head sha', () => {
    it('follows a symbolic HEAD to a loose ref', async () => {
      const { probe } = probeOver({
        '/repo/.git/HEAD': 'ref: refs/heads/staging\n',
        '/repo/.git/refs/heads/staging': `${SHA}\n`,
      });
      expect(await completionTreeStamp(probe)).toEqual({ repositoryRoot: ROOT, headSha: SHA });
    });

    it('reads a detached HEAD directly', async () => {
      const { probe } = probeOver({ '/repo/.git/HEAD': `${SHA}\n` });
      expect(await completionTreeStamp(probe)).toEqual({ repositoryRoot: ROOT, headSha: SHA });
    });

    it('falls back to packed-refs when the loose ref has been packed away', async () => {
      const { probe } = probeOver({
        '/repo/.git/HEAD': 'ref: refs/heads/staging\n',
        '/repo/.git/packed-refs':
          '# pack-refs with: peeled fully-peeled sorted\n' +
          `${OTHER_SHA} refs/heads/main\n` +
          `${SHA} refs/heads/staging\n`,
      });
      expect(await completionTreeStamp(probe)).toEqual({ repositoryRoot: ROOT, headSha: SHA });
    });

    it('follows a `.git` FILE to its gitdir (a worktree or submodule checkout)', async () => {
      const { probe } = probeOver({
        '/repo/.git': 'gitdir: /elsewhere/worktrees/wt1\n',
        '/elsewhere/worktrees/wt1/HEAD': 'ref: refs/heads/feature\n',
        '/elsewhere/worktrees/wt1/refs/heads/feature': `${SHA}\n`,
      });
      expect(await completionTreeStamp(probe)).toEqual({ repositoryRoot: ROOT, headSha: SHA });
    });

    it('accepts a 64-char sha256 object id', async () => {
      const sha256 = 'f'.repeat(64);
      const { probe } = probeOver({ '/repo/.git/HEAD': `${sha256}\n` });
      expect(await completionTreeStamp(probe)).toEqual({ repositoryRoot: ROOT, headSha: sha256 });
    });
  });

  describe('stays SILENT when it cannot observe (fail-open — absence never means "clean")', () => {
    it('when there is no repo root', async () => {
      const { probe } = probeOver({}, null);
      expect(await completionTreeStamp(probe)).toBeUndefined();
    });

    it('when HEAD is absent', async () => {
      const { probe } = probeOver({});
      expect(await completionTreeStamp(probe)).toBeUndefined();
    });

    it('when HEAD is present but empty', async () => {
      const { probe } = probeOver({ '/repo/.git/HEAD': '   \n' });
      expect(await completionTreeStamp(probe)).toBeUndefined();
    });

    it('when HEAD holds neither a sha nor a ref', async () => {
      const { probe } = probeOver({ '/repo/.git/HEAD': 'something unexpected\n' });
      expect(await completionTreeStamp(probe)).toBeUndefined();
    });

    it('when the ref resolves nowhere — no loose ref and no packed-refs', async () => {
      const { probe } = probeOver({ '/repo/.git/HEAD': 'ref: refs/heads/staging\n' });
      expect(await completionTreeStamp(probe)).toBeUndefined();
    });

    it('when the loose ref exists but is not shaped like a sha', async () => {
      const { probe } = probeOver({
        '/repo/.git/HEAD': 'ref: refs/heads/staging\n',
        '/repo/.git/refs/heads/staging': 'not-a-sha\n',
      });
      expect(await completionTreeStamp(probe)).toBeUndefined();
    });

    it('when a truncated/short sha is offered — a partial id must not be stamped as full', async () => {
      const { probe } = probeOver({ '/repo/.git/HEAD': 'a1b2c3d\n' });
      expect(await completionTreeStamp(probe)).toBeUndefined();
    });

    it('when `.git` is a readable FILE that is not a gitdir pointer', async () => {
      const { probe } = probeOver({ '/repo/.git': 'total nonsense\n' });
      expect(await completionTreeStamp(probe)).toBeUndefined();
    });

    it('when the probe throws — evidence-stamping must never fail a close', async () => {
      expect(
        await completionTreeStamp({
          repoRoot: ROOT,
          readFile: () => {
            throw new Error('EIO');
          },
        }),
      ).toBeUndefined();
    });

    it('when repoRoot is EXPLICITLY null, without falling back to detection', async () => {
      // Distinct from omitting the key: an explicit null means "I could not resolve a
      // root, do not guess". Collapsing the two would judge against the wrong tree.
      const { probe, reads } = probeOver({ '/repo/.git/HEAD': `${SHA}\n` }, null);
      expect(await completionTreeStamp(probe)).toBeUndefined();
      expect(reads).toEqual([]);
    });
  });

  describe('controls — a WRONG stamp is worse than none', () => {
    it('matches packed-refs by EXACT ref name, never by suffix', async () => {
      // The killer case: a suffix/`includes` matcher binds refs/heads/staging to the
      // REMOTE-tracking ref and stamps a commit the local tree is not on. origin/staging
      // is listed FIRST so a naive scan hits it before any correct entry.
      const { probe } = probeOver({
        '/repo/.git/HEAD': 'ref: refs/heads/staging\n',
        '/repo/.git/packed-refs': `${OTHER_SHA} refs/remotes/origin/staging\n` + `${SHA} refs/heads/staging\n`,
      });
      expect(await completionTreeStamp(probe)).toEqual({ repositoryRoot: ROOT, headSha: SHA });
    });

    it('does NOT stamp the remote ref when the local branch is absent entirely', async () => {
      const { probe } = probeOver({
        '/repo/.git/HEAD': 'ref: refs/heads/staging\n',
        '/repo/.git/packed-refs': `${OTHER_SHA} refs/remotes/origin/staging\n`,
      });
      expect(await completionTreeStamp(probe)).toBeUndefined();
    });

    it('prefers the loose ref over a stale packed-refs entry for the same name', async () => {
      // Git's own precedence. Inverting it stamps the commit the branch used to be on.
      const { probe } = probeOver({
        '/repo/.git/HEAD': 'ref: refs/heads/staging\n',
        '/repo/.git/refs/heads/staging': `${SHA}\n`,
        '/repo/.git/packed-refs': `${OTHER_SHA} refs/heads/staging\n`,
      });
      expect(await completionTreeStamp(probe)).toEqual({ repositoryRoot: ROOT, headSha: SHA });
    });

    it('ignores the peeled-tag (`^`) continuation lines in packed-refs', async () => {
      const { probe } = probeOver({
        '/repo/.git/HEAD': 'ref: refs/heads/staging\n',
        '/repo/.git/packed-refs':
          `${OTHER_SHA} refs/tags/v1\n` + `^${'b'.repeat(40)}\n` + `${SHA} refs/heads/staging\n`,
      });
      expect(await completionTreeStamp(probe)).toEqual({ repositoryRoot: ROOT, headSha: SHA });
    });

    it('reads HEAD within a tight budget before async content identity lookup', async () => {
      // This case has no declared paths, so reading the current HEAD stays a direct
      // filesystem observation. Content identities use the separate nonblocking Git
      // stream covered by completion-head-blob-resolution.test.ts.
      const { probe, reads } = probeOver({
        '/repo/.git/HEAD': 'ref: refs/heads/staging\n',
        '/repo/.git/refs/heads/staging': `${SHA}\n`,
      });
      expect(await completionTreeStamp(probe)).toEqual({ repositoryRoot: ROOT, headSha: SHA });
      expect(reads).toEqual(['/repo/.git', '/repo/.git/HEAD', '/repo/.git/refs/heads/staging']);
      expect(reads.length).toBeLessThanOrEqual(3);
    });
  });
});

describe('completionTreeStamp — committed submodule content identity', () => {
  it('resolves a declared descendant through the superproject gitlink', async () => {
    const root = mkdtempSync(join(tmpdir(), 'completion-submodule-'));
    TEMP_ROOTS.push(root);
    const submodule = join(root, 'libs', 'nested');
    const changed = join(submodule, 'src', 'fix.ts');
    mkdirSync(join(submodule, 'src'), { recursive: true });

    const git = (cwd: string, args: string[]) =>
      execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      }).trim();
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'completion-test@example.invalid']);
    git(root, ['config', 'user.name', 'Completion Test']);
    git(submodule, ['init', '-q']);
    git(submodule, ['config', 'user.email', 'completion-test@example.invalid']);
    git(submodule, ['config', 'user.name', 'Completion Test']);
    writeFileSync(changed, 'export const fixed = true;\n');
    git(submodule, ['add', 'src/fix.ts']);
    git(submodule, ['commit', '-qm', 'nested fix']);
    const submoduleHead = git(submodule, ['rev-parse', 'HEAD']);

    writeFileSync(join(root, 'README.md'), 'parent\n');
    git(root, ['add', 'README.md']);
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${submoduleHead},libs/nested`]);
    git(root, ['commit', '-qm', 'pin nested repo']);

    const stamp = await completionTreeStamp({ repoRoot: root, filesChanged: ['libs/nested/src/fix.ts'] });
    expect(stamp?.contentIdentity).toEqual([
      expect.objectContaining({
        path: 'libs/nested/src/fix.ts',
        workingTreeBlobSha: expect.any(String),
        headBlobSha: expect.any(String),
      }),
    ]);
    expect(stamp?.contentIdentity?.[0]?.workingTreeBlobSha).toBe(stamp?.contentIdentity?.[0]?.headBlobSha);
  });

  it('resolves a nested descendant when the superproject recursive tree exceeds the read buffer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'completion-large-submodule-'));
    TEMP_ROOTS.push(root);
    const submodule = join(root, 'libs', 'nested');
    const changed = join(submodule, 'src', 'fix.ts');
    mkdirSync(join(submodule, 'src'), { recursive: true });

    const git = (cwd: string, args: string[]) =>
      execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      }).trim();
    git(root, ['init', '-q']);
    git(root, ['config', 'user.email', 'completion-test@example.invalid']);
    git(root, ['config', 'user.name', 'Completion Test']);
    git(submodule, ['init', '-q']);
    git(submodule, ['config', 'user.email', 'completion-test@example.invalid']);
    git(submodule, ['config', 'user.name', 'Completion Test']);
    writeFileSync(changed, 'export const fixed = true;\n');
    git(submodule, ['add', 'src/fix.ts']);
    git(submodule, ['commit', '-qm', 'nested fix']);
    const submoduleHead = git(submodule, ['rev-parse', 'HEAD']);

    writeFileSync(join(root, 'README.md'), 'parent\n');
    const wideTree = join(root, 'wide-tree');
    mkdirSync(wideTree, { recursive: true });
    for (let index = 0; index < 5000; index += 1) {
      writeFileSync(join(wideTree, `file-${String(index).padStart(5, '0')}.txt`), 'x\n');
    }
    git(root, ['add', 'README.md', 'wide-tree']);
    git(root, ['update-index', '--add', '--cacheinfo', `160000,${submoduleHead},libs/nested`]);
    git(root, ['commit', '-qm', 'pin nested repo and wide tree']);
    expect(Buffer.byteLength(git(root, ['ls-tree', '-r', '-z', 'HEAD']), 'utf8')).toBeGreaterThan(256 * 1024);

    const stamp = await completionTreeStamp({ repoRoot: root, filesChanged: ['libs/nested/src/fix.ts'] });
    expect(stamp?.contentIdentity).toEqual([
      expect.objectContaining({
        path: 'libs/nested/src/fix.ts',
        workingTreeBlobSha: expect.any(String),
        headBlobSha: expect.any(String),
      }),
    ]);
    expect(stamp?.contentIdentity?.[0]?.workingTreeBlobSha).toBe(stamp?.contentIdentity?.[0]?.headBlobSha);
  });
});

describe('completionTreeStampForEvidence (EI-20460682854560939)', () => {
  const OPERATOR_ROOT = '/operator';
  const SIDESTAGE_ROOT = '/sidestage';
  const OPERATOR_SHA = '1111111111111111111111111111111111111111';
  const SIDESTAGE_SHA = '2222222222222222222222222222222222222222';
  const files = {
    '/operator/.git/HEAD': OPERATOR_SHA,
    '/sidestage/.git/HEAD': SIDESTAGE_SHA,
  };
  const readFile = (abs: string): string | undefined => files[abs as keyof typeof files];

  it('discovers and stamps an unregistered independent sibling checkout', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'completion-tree-stamp-sibling-'));
    TEMP_ROOTS.push(workspaceRoot);
    const operatorRoot = join(workspaceRoot, 'papercusp');
    const sidestageRoot = join(workspaceRoot, 'sidestage');
    mkdirSync(join(operatorRoot, '.git'), { recursive: true });
    mkdirSync(join(sidestageRoot, '.git'), { recursive: true });
    mkdirSync(join(sidestageRoot, 'apps', 'web', 'src'), { recursive: true });
    writeFileSync(join(operatorRoot, '.git', 'HEAD'), `${OPERATOR_SHA}\n`);
    writeFileSync(join(sidestageRoot, '.git', 'HEAD'), `${SIDESTAGE_SHA}\n`);
    writeFileSync(join(sidestageRoot, 'apps', 'web', 'src', 'BuyerTab.thumbnail.test.tsx'), 'test\n');

    // homeRoot pinned to workspaceRoot (same value) so the EI-22188958812917965 $HOME-tier
    // scan is a no-op here — this fixture asserts only the conventional workspace-tier
    // sibling, and must not pick up whatever real sibling checkouts happen to sit under
    // the machine's actual home directory.
    const roots = completionRepoRootsFromRegistry(operatorRoot, { projects: [] }, [], { homeRoot: workspaceRoot });
    expect(roots).toEqual([operatorRoot, sidestageRoot]);
    expect(
      await completionTreeStampForEvidence({ filesChanged: ['apps/web/src/BuyerTab.thumbnail.test.tsx'] }, roots),
    ).toEqual({ repositoryRoot: sidestageRoot, headSha: SIDESTAGE_SHA });
  });

  it('stamps the registered sibling checkout that owns the declared changed file', async () => {
    expect(
      await completionTreeStampForEvidence(
        { filesChanged: ['apps/web/src/BuyerTab.thumbnail.test.tsx'] },
        [OPERATOR_ROOT, SIDESTAGE_ROOT],
        {
          exists: (abs) => abs === '/sidestage/apps/web/src/BuyerTab.thumbnail.test.tsx',
          readFile,
        },
      ),
    ).toEqual({ repositoryRoot: SIDESTAGE_ROOT, headSha: SIDESTAGE_SHA });
  });

  it('resolves the conventional `<repoName>/`-prefixed cross-repo form against its own root (EI-21850619651553189)', async () => {
    // The measured incident shape: `sidestage/apps/web/...` (the prose/plan-title
    // convention) rather than a path already relative to the sidestage checkout. A plain
    // `resolve(root, declaredPath)` can never escape ANY root for a relative path, so this
    // form used to resolve to a nonexistent subpath under every candidate — including the
    // sidestage root itself (wrongly `/sidestage/sidestage/...`) — and the completion never
    // reached authority:'committed'.
    expect(
      await completionTreeStampForEvidence(
        { filesChanged: ['sidestage/apps/web/src/BuyerTab.thumbnail.test.tsx'] },
        [OPERATOR_ROOT, SIDESTAGE_ROOT],
        {
          exists: (abs) => abs === '/sidestage/apps/web/src/BuyerTab.thumbnail.test.tsx',
          readFile,
        },
      ),
    ).toEqual({ repositoryRoot: SIDESTAGE_ROOT, headSha: SIDESTAGE_SHA });
  });

  it('does NOT let a prefixed path resolve against an UNRELATED root merely because the prefix parses', async () => {
    // The stripped candidate exists nowhere (neither its plain nor stripped form), so this
    // must stay a genuine zero-match tie — falling back to the primary root, never silently
    // latching onto the sidestage root just because the string happens to start with its name.
    expect(
      await completionTreeStampForEvidence(
        { filesChanged: ['sidestage/apps/web/src/does-not-exist.tsx'] },
        [OPERATOR_ROOT, SIDESTAGE_ROOT],
        { exists: () => false, readFile },
      ),
    ).toEqual({ repositoryRoot: OPERATOR_ROOT, headSha: OPERATOR_SHA });
  });

  it('stamps the owning checkout when filesChanged uses an absolute path', async () => {
    const absolutePath = `${SIDESTAGE_ROOT}/apps/web/src/BuyerTab.thumbnail.test.tsx`;
    expect(
      await completionTreeStampForEvidence({ filesChanged: [absolutePath] }, [OPERATOR_ROOT, SIDESTAGE_ROOT], {
        exists: (abs) => abs === absolutePath,
        readFile,
      }),
    ).toEqual({ repositoryRoot: SIDESTAGE_ROOT, headSha: SIDESTAGE_SHA });
  });

  it('prefers the nested submodule for an absolute path despite an unrelated dirty file', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'completion-tree-stamp-nested-'));
    TEMP_ROOTS.push(workspaceRoot);
    const operatorRoot = join(workspaceRoot, 'papercusp');
    const submoduleRoot = join(operatorRoot, 'papercusp-desktop');
    const changedPath = join(submoduleRoot, 'src', 'fix.ts');
    const unrelatedDirtyPath = join(submoduleRoot, 'tmp', 'unrelated.ts');
    mkdirSync(join(operatorRoot, '.git'), { recursive: true });
    mkdirSync(join(submoduleRoot, '.git'), { recursive: true });
    mkdirSync(join(submoduleRoot, 'src'), { recursive: true });
    mkdirSync(join(submoduleRoot, 'tmp'), { recursive: true });
    writeFileSync(join(operatorRoot, '.git', 'HEAD'), `${OPERATOR_SHA}\n`);
    writeFileSync(join(submoduleRoot, '.git', 'HEAD'), `${SIDESTAGE_SHA}\n`);
    writeFileSync(changedPath, 'fixed\n');
    writeFileSync(unrelatedDirtyPath, 'unrelated dirty work\n');

    expect(completionCheckoutRootForPath(changedPath)).toBe(submoduleRoot);
    expect(
      await completionTreeStampForEvidence({ filesChanged: [changedPath] }, [operatorRoot, submoduleRoot], {
        exists: (abs) => abs === changedPath || abs === unrelatedDirtyPath,
        readFile: (abs) => {
          if (abs === join(operatorRoot, '.git', 'HEAD')) return `${OPERATOR_SHA}\n`;
          if (abs === join(submoduleRoot, '.git', 'HEAD')) return `${SIDESTAGE_SHA}\n`;
          return undefined;
        },
      }),
    ).toMatchObject({ repositoryRoot: submoduleRoot });
  });

  it('resolves a relative path to an independent nested repository', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'completion-tree-stamp-relative-nested-'));
    TEMP_ROOTS.push(workspaceRoot);
    const operatorRoot = join(workspaceRoot, 'papercusp');
    const nestedRoot = join(operatorRoot, 'papercusp-desktop');
    const changedPath = join(nestedRoot, 'bin', 'mac-vm-health.sh');
    mkdirSync(join(nestedRoot, 'bin'), { recursive: true });

    const git = (cwd: string, args: string[]) =>
      execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      }).trim();
    git(operatorRoot, ['init', '-q']);
    git(operatorRoot, ['config', 'user.email', 'completion-test@example.invalid']);
    git(operatorRoot, ['config', 'user.name', 'Completion Test']);
    writeFileSync(join(operatorRoot, 'README.md'), 'parent\n');
    git(operatorRoot, ['add', 'README.md']);
    git(operatorRoot, ['commit', '-qm', 'parent']);

    git(nestedRoot, ['init', '-q']);
    git(nestedRoot, ['config', 'user.email', 'completion-test@example.invalid']);
    git(nestedRoot, ['config', 'user.name', 'Completion Test']);
    writeFileSync(changedPath, '#!/bin/sh\necho healthy\n');
    git(nestedRoot, ['add', 'bin/mac-vm-health.sh']);
    git(nestedRoot, ['commit', '-qm', 'nested fix']);

    const stamp = await completionTreeStampForEvidence({ filesChanged: ['papercusp-desktop/bin/mac-vm-health.sh'] }, [
      operatorRoot,
    ]);

    expect(stamp?.repositoryRoot).toBe(nestedRoot);
    expect(stamp?.contentIdentity).toEqual([
      expect.objectContaining({
        path: 'bin/mac-vm-health.sh',
        workingTreeBlobSha: expect.any(String),
        headBlobSha: expect.any(String),
      }),
    ]);
    expect(stamp?.contentIdentity?.[0]?.workingTreeBlobSha).toBe(stamp?.contentIdentity?.[0]?.headBlobSha);
  });

  it('keeps the primary checkout on a tie so legacy completions do not change repositories', async () => {
    expect(
      await completionTreeStampForEvidence({ filesChanged: ['shared/path.ts'] }, [OPERATOR_ROOT, SIDESTAGE_ROOT], {
        exists: (abs) => abs.endsWith('/shared/path.ts'),
        readFile,
      }),
    ).toEqual({ repositoryRoot: OPERATOR_ROOT, headSha: OPERATOR_SHA });
  });

  it('keeps the primary checkout when the completion declares no resolvable files', async () => {
    expect(
      await completionTreeStampForEvidence({ filesChanged: ['missing.ts'] }, [OPERATOR_ROOT, SIDESTAGE_ROOT], {
        exists: () => false,
        readFile,
      }),
    ).toEqual({ repositoryRoot: OPERATOR_ROOT, headSha: OPERATOR_SHA });
  });

  it('fails closed when any declared changed path is invalid', async () => {
    expect(
      await completionTreeStampForEvidence({ filesChanged: ['src/fix.ts', '*.ts'] }, [OPERATOR_ROOT], {
        exists: () => true,
        readFile,
      }),
    ).toBeUndefined();
  });

  it('records per-path working-tree and HEAD blob identities', async () => {
    const workingTree = Buffer.from('dirty-but-present\n');
    const headBlob = '3'.repeat(40);
    const result = await completionTreeStampForEvidence({ filesChanged: ['src/fix.ts'] }, [OPERATOR_ROOT], {
      exists: () => true,
      readFile,
      readBytes: () => workingTree,
      headBlobs: () => new Map([['src/fix.ts', { status: 'resolved' as const, sha: headBlob }]]),
    });

    expect(result).toMatchObject({
      repositoryRoot: OPERATOR_ROOT,
      headSha: OPERATOR_SHA,
      contentIdentity: [{ path: 'src/fix.ts', headBlobSha: headBlob }],
    });
    expect(result?.contentIdentity?.[0]?.workingTreeBlobSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result?.contentIdentity?.[0]?.workingTreeBlobSha).not.toBe(headBlob);
    // WI-42441: a RESOLVED path carries no unresolvable reason — that field is reserved
    // for the server failing to read HEAD, so its presence stays a reliable signal.
    expect(result?.contentIdentity?.[0]?.headBlobUnresolvable).toBeUndefined();
  });

  it('carries the reason forward when the HEAD side could not be resolved (WI-42441)', async () => {
    const reason = "submodule 'libs/papercusp' could not be read at abc123456789";
    const result = await completionTreeStampForEvidence({ filesChanged: ['src/fix.ts'] }, [OPERATOR_ROOT], {
      exists: () => true,
      readFile,
      readBytes: () => Buffer.from('present\n'),
      headBlobs: () => new Map([['src/fix.ts', { status: 'unresolvable' as const, reason }]]),
    });

    expect(result?.contentIdentity?.[0]?.headBlobSha).toBeNull();
    expect(result?.contentIdentity?.[0]?.headBlobUnresolvable).toBe(reason);
  });

  it('leaves a genuinely absent path with no reason, so it stays the closer‑side case', async () => {
    const result = await completionTreeStampForEvidence({ filesChanged: ['src/fix.ts'] }, [OPERATOR_ROOT], {
      exists: () => true,
      readFile,
      readBytes: () => Buffer.from('present\n'),
      headBlobs: () => new Map([['src/fix.ts', { status: 'absent' as const }]]),
    });

    expect(result?.contentIdentity?.[0]?.headBlobSha).toBeNull();
    expect(result?.contentIdentity?.[0]?.headBlobUnresolvable).toBeUndefined();
  });

  it('records a null HEAD blob when a dirty worktree path is absent from HEAD', async () => {
    const result = await completionTreeStampForEvidence({ filesChanged: ['src/new-fix.ts'] }, [OPERATOR_ROOT], {
      exists: () => true,
      readFile,
      readBytes: () => Buffer.from('new fix\n'),
      headBlobs: () => new Map(),
    });

    expect(result?.contentIdentity).toEqual([expect.objectContaining({ path: 'src/new-fix.ts', headBlobSha: null })]);
  });
});

/**
 * EI-21937921955988010 — a completion may span SEVERAL repositories, and may cite
 * artifacts that live in none.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * WI-1409555 (built the phone suite app and wired it into the Portal) declared 30
 * paths in THREE classes at once: 2 papercusp-relative (`infra/phone-app/...`), 23
 * absolute paths inside two INDEPENDENT suite-app checkouts (phone-app and portal,
 * each its own git repo under ~/.papercusp-workspaces/<ws>/.papercusp/apps/*), and 5
 * screenshot artifacts under ~/.papercusp/evidence/WI-1409555/ that belong to no repo
 * at all.
 *
 * Measured live 2026-08-31: that close stored `has_tree_stamp=false` — NO stamp
 * whatsoever, `identity_rows=0` — and landed `authority='proposed'`,
 * `countsTowardBurnDown=false`. Two independent causes, and BOTH had to be fixed:
 *   - the stamp was single-repo BY TYPE, so paths in a second checkout could never be
 *     proven; and
 *   - `completionTreeStampForEvidence` bailed all-or-nothing when ANY declared path
 *     failed to resolve under the one selected root, so the unprovable paths discarded
 *     the proof of every provable one — leaving no diagnostic naming which paths were
 *     at fault. The close read as sloppy or fabricated citations rather than as a
 *     structural gap, which is the dangerous part.
 *
 * The artifact class is not an edge case: `verifiedHow: 'live-drove-ui'` REQUIRES the
 * closer to cite exactly those screenshots, so the floor demanded a citation it then
 * counted as unproven — UI-verified work could not reach `committed` however clean its
 * code side was.
 *
 * ── HOW THIS PROVES ITSELF ─────────────────────────────────────────────────
 * Both directions, because the failure mode of a fix here is a floor that has been
 * LOOSENED rather than made cross-repo aware. The last two cases are the controls: an
 * implementation must accept an explicitly classified artifacts-only close, while an
 * implementation that ignored artifact entries too broadly would excuse a genuine
 * content mismatch. The latter must still be refused.
 *
 * PURE: every filesystem and git read is injected.
 */
describe('completionTreeStampForEvidence — multi-repository completions (EI-21937921955988010)', () => {
  const PAPERCUSP = '/operator';
  const PHONE = '/suite/phone-app';
  const PORTAL = '/suite/portal';
  const PAPERCUSP_SHA = '1'.repeat(40);
  const PHONE_SHA = '2'.repeat(40);
  const PORTAL_SHA = '3'.repeat(40);
  // Redacted user (`<user>`): this only has to be an ABSOLUTE path outside every repo
  // root, which is what the out-of-repo branch under test keys on — a real home path
  // named one machine and tripped check-no-box-identity.mjs.
  const ARTIFACT = '/home/<user>/.papercusp/evidence/WI-1409555/phone-dialer.png';

  const declared = [
    'infra/phone-app/deploy.sh',
    `${PHONE}/apps/sidecar/src/api.ts`,
    `${PORTAL}/app/layout.tsx`,
    ARTIFACT,
  ];

  const heads: Record<string, string> = {
    [`${PAPERCUSP}/.git/HEAD`]: PAPERCUSP_SHA,
    [`${PHONE}/.git/HEAD`]: PHONE_SHA,
    [`${PORTAL}/.git/HEAD`]: PORTAL_SHA,
  };

  // `workingTreeBlobSha` is computed from the REAL bytes the probe returns, so a match
  // has to be asserted against the real Git blob hash of that content — a placeholder
  // sha on the HEAD side could never equal it, which would make every case here read as
  // a mismatch for a reason that has nothing to do with the behavior under test.
  const CONTENT = 'content\n';
  const blobShaOf = (content: string) =>
    createHash('sha1')
      .update(Buffer.from(`blob ${Buffer.byteLength(content)}\0`, 'utf8'))
      .update(Buffer.from(content))
      .digest('hex');
  const MATCHING_BLOB = blobShaOf(CONTENT);

  const probe = (blob: (repoRoot: string) => string) => ({
    exists: (abs: string) =>
      abs === `${PAPERCUSP}/infra/phone-app/deploy.sh` ||
      abs === `${PHONE}/apps/sidecar/src/api.ts` ||
      abs === `${PORTAL}/app/layout.tsx` ||
      abs === ARTIFACT,
    isCheckoutRoot: (abs: string) => abs === PAPERCUSP || abs === PHONE || abs === PORTAL,
    readFile: (abs: string): string | undefined => heads[abs],
    readBytes: () => Buffer.from(CONTENT),
    headBlobs: (repoRoot: string, _sha: string, paths: readonly string[]) =>
      new Map(paths.map((path) => [path, { status: 'resolved' as const, sha: blob(repoRoot) }])),
  });

  // Every repository's working tree agrees with its own HEAD.
  const matching = probe(() => MATCHING_BLOB);

  it('stamps EVERY owning checkout instead of discarding the whole stamp', async () => {
    const stamp = await completionTreeStampForEvidence({ filesChanged: declared }, [PAPERCUSP], matching);

    // The regression itself: this used to be `undefined`.
    expect(stamp).toBeDefined();
    // The primary (highest-match) root stays the top-level identity, so existing
    // readers are unchanged.
    expect(stamp?.repositoryRoot).toBe(PAPERCUSP);
    expect(stamp?.headSha).toBe(PAPERCUSP_SHA);
    expect(stamp?.contentIdentity).toHaveLength(4);

    const byPath = new Map((stamp?.contentIdentity ?? []).map((entry) => [entry.path, entry]));

    // A path in the primary checkout carries no per-entry root: the top-level pair is it.
    expect(byPath.get('infra/phone-app/deploy.sh')).toMatchObject({ headBlobSha: MATCHING_BLOB });
    expect(byPath.get('infra/phone-app/deploy.sh')?.repositoryRoot).toBeUndefined();

    // Paths in the two independent suite checkouts are proven against THEIR OWN HEADs.
    expect(byPath.get('apps/sidecar/src/api.ts')).toMatchObject({
      repositoryRoot: PHONE,
      headSha: PHONE_SHA,
    });
    expect(byPath.get('app/layout.tsx')).toMatchObject({
      repositoryRoot: PORTAL,
      headSha: PORTAL_SHA,
    });

    // The screenshot is CLASSIFIED, not counted unproven.
    expect(byPath.get(ARTIFACT)).toMatchObject({
      outOfRepoArtifact: true,
      workingTreeBlobSha: null,
      headBlobSha: null,
    });
  });

  it('lets a clean mixed-class completion reach committed authority', async () => {
    const stamp = await completionTreeStampForEvidence({ filesChanged: declared }, [PAPERCUSP], matching);

    expect(completionTreeContentIdentityMatches(stamp?.contentIdentity)).toBe(true);
    expect(committedCloseDowngradedForUnprovenContentIdentity('committed', declared, stamp)).toBe(false);
  });

  it('allows an artifacts-only completion to qualify as committed', async () => {
    const stamp = await completionTreeStampForEvidence({ filesChanged: [ARTIFACT] }, [PAPERCUSP], matching);

    // The explicit out-of-repo classification is the proof for this non-code
    // deliverable; there is no repository settlement receipt to wait for.
    expect(stamp?.contentIdentity).toEqual([expect.objectContaining({ outOfRepoArtifact: true })]);
    expect(completionTreeContentIdentityMatches(stamp?.contentIdentity)).toBe(true);
    expect(committedCloseDowngradedForUnprovenContentIdentity('committed', [ARTIFACT], stamp)).toBe(false);
  });

  it('CONTROL: an artifact citation does not excuse a real content mismatch elsewhere', async () => {
    // The phone-app checkout's working tree no longer matches its HEAD.
    const drifted = probe((repoRoot) => (repoRoot === PHONE ? 'a'.repeat(40) : MATCHING_BLOB));
    const stamp = await completionTreeStampForEvidence({ filesChanged: declared }, [PAPERCUSP], drifted);

    expect(stamp?.contentIdentity).toHaveLength(4);
    expect(completionTreeContentIdentityMatches(stamp?.contentIdentity)).toBe(false);
    expect(committedCloseDowngradedForUnprovenContentIdentity('committed', declared, stamp)).toBe(true);
  });
});

describe('completionTreeStampForClose — one stamp route for every close (EI-24814178215040083)', () => {
  // Measured 2026-10-01 (WI-10005066): a close whose ONLY filesChanged entry was the owner's
  // tunnel config (~/.cloudflared/…, in no repository) persisted treeStamp
  // { repositoryRoot, headSha } with NO contentIdentity, so both authority floors read it as
  // unproven and pinned it at `proposed` forever. No path was unresolved and none named a
  // checkout, so registeredRepoRoots was never computed and complete.ts fell back to the
  // single-repo completionTreeStamp, which drops an absolute out-of-checkout path.
  const tempRepoWithHead = (): { repoRoot: string; outside: string } => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'completion-close-route-'));
    TEMP_ROOTS.push(workspaceRoot);
    const repoRoot = join(workspaceRoot, 'repo');
    mkdirSync(join(repoRoot, '.git'), { recursive: true });
    writeFileSync(join(repoRoot, '.git', 'HEAD'), `${SHA}\n`);
    const outsideDir = join(workspaceRoot, 'home', '.cloudflared');
    mkdirSync(outsideDir, { recursive: true });
    const outside = join(outsideDir, 'tunnel.yml');
    writeFileSync(outside, 'ingress: []\n');
    return { repoRoot, outside };
  };

  it('records an out-of-repo-only deliverable as an artifact the authority floor accepts', async () => {
    const { repoRoot, outside } = tempRepoWithHead();
    const stamp = await completionTreeStampForClose({ filesChanged: [outside] }, undefined, repoRoot);

    expect(stamp?.headSha).toBe(SHA);
    expect(stamp?.contentIdentity).toEqual([
      { path: outside, workingTreeBlobSha: null, headBlobSha: null, outOfRepoArtifact: true },
    ]);
    expect(completionTreeContentIdentityMatches(stamp?.contentIdentity)).toBe(true);
    expect(committedCloseDowngradedForUnprovenContentIdentity('committed', [outside], stamp)).toBe(false);
  });

  it('control: the retired single-repo route drops the path, and the floor downgrades that stamp', async () => {
    // The defect this guards against, stated as a fact about the old route rather than
    // assumed: if this ever stops downgrading, the test above has lost its witness.
    const { repoRoot, outside } = tempRepoWithHead();
    const legacy = await completionTreeStamp({ repoRoot, filesChanged: [outside], filesDeleted: [] });

    expect(legacy?.headSha).toBe(SHA);
    expect(legacy?.contentIdentity ?? []).not.toContainEqual(expect.objectContaining({ path: outside }));
    expect(committedCloseDowngradedForUnprovenContentIdentity('committed', [outside], legacy)).toBe(true);
  });

  it('stays silent without any root, exactly like the route it replaced', async () => {
    expect(await completionTreeStampForClose({ filesChanged: ['/nowhere/x.yml'] }, undefined, null)).toBeUndefined();
  });

  it('retries an unreadable serving submodule against the registered source checkout', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'completion-close-submodule-fallback-'));
    TEMP_ROOTS.push(workspaceRoot);
    const submoduleOrigin = join(workspaceRoot, 'test-config-origin');
    const servingRoot = join(workspaceRoot, 'papercusp-release');
    const canonicalRoot = join(workspaceRoot, 'papercusp');
    const changedPath = 'libs/test-config/src/fix.ts';
    const content = 'export const fixed = true;\n';
    const git = (cwd: string, ...args: string[]) =>
      execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      }).trim();
    const initRepo = (root: string) => {
      mkdirSync(root, { recursive: true });
      git(root, 'init', '-q');
      git(root, 'config', 'user.email', 'completion-test@example.invalid');
      git(root, 'config', 'user.name', 'Completion Test');
    };

    initRepo(submoduleOrigin);
    mkdirSync(join(submoduleOrigin, 'src'), { recursive: true });
    writeFileSync(join(submoduleOrigin, 'src', 'fix.ts'), content);
    git(submoduleOrigin, 'add', 'src/fix.ts');
    git(submoduleOrigin, 'commit', '-qm', 'submodule fix');
    const submoduleSha = git(submoduleOrigin, 'rev-parse', 'HEAD');

    initRepo(canonicalRoot);
    writeFileSync(join(canonicalRoot, 'README.md'), 'canonical workspace\n');
    git(canonicalRoot, 'add', 'README.md');
    git(canonicalRoot, 'commit', '-qm', 'canonical root');
    git(canonicalRoot, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', submoduleOrigin, 'libs/test-config');
    git(canonicalRoot, 'add', '.');
    git(canonicalRoot, 'commit', '-qm', 'pin test-config');

    // The release checkout has the pinned gitlink and extracted source files, but no
    // initialized submodule object store — the state measured on :3070 in EI-24804091288346310.
    initRepo(servingRoot);
    writeFileSync(join(servingRoot, 'README.md'), 'release checkout\n');
    mkdirSync(join(servingRoot, 'libs/test-config/src'), { recursive: true });
    writeFileSync(join(servingRoot, changedPath), content);
    git(servingRoot, 'add', 'README.md');
    git(servingRoot, 'update-index', '--add', '--cacheinfo', `160000,${submoduleSha},libs/test-config`);
    git(servingRoot, 'commit', '-qm', 'release gitlink');

    const stamp = await completionTreeStampForClose(
      { filesChanged: [changedPath] },
      undefined,
      servingRoot,
      async () => [servingRoot, canonicalRoot],
    );

    expect(stamp?.repositoryRoot).toBe(join(canonicalRoot, 'libs/test-config'));
    expect(stamp?.headSha).toBe(submoduleSha);
    expect(stamp?.contentIdentity).toEqual([
      expect.objectContaining({
        path: 'src/fix.ts',
        workingTreeBlobSha: expect.any(String),
        headBlobSha: expect.any(String),
      }),
    ]);
    expect(stamp?.contentIdentity?.[0]?.workingTreeBlobSha).toBe(stamp?.contentIdentity?.[0]?.headBlobSha);
    expect(stamp?.contentIdentity?.[0]?.headBlobUnresolvable).toBeUndefined();
  });

  it('complete.ts stamps every close through completionTreeStampForClose, never the single-repo route', () => {
    // Overridable so scripts/mutation-probe.sh can point the guard at a historical snapshot.
    const subject = process.env.COMPLETE_TS_GUARD_SUBJECT ?? fileURLToPath(new URL('./complete.ts', import.meta.url));
    const source = readFileSync(subject, 'utf8');
    expect(source).toMatch(/completionTreeStampForClose\(\s*completionEvidenceBeforeStamp,/);
    expect(source).not.toMatch(/await completionTreeStamp\(\{/);
  });
});
