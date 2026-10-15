import { hiveEffectFixture } from './hive-effect-authority.fixture';
/**
 * github-egress.integration.test.ts — P-001 egress core
 * (github-bridge-hive-egress-2026-07-02; S-1/S-2/S-4): canonical refs publish
 * to a real local bare "GitHub" origin, FF-only, never forced, secrets-gated,
 * tags create-only.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/pot-git/github-egress.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultRunGit, ensurePotGitRepo, namespaceRefPath } from './storage';
import { STAGING_REF } from './integrator';
import { egressCanonicalRefs as egressCanonicalRefsUnderTest } from './github-egress';

function devicePubkey(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const spki = (publicKey as KeyObject).export({ format: 'der', type: 'spki' }) as Buffer;
  return spki.subarray(spki.length - 32).toString('base64');
}

/** Commit a file in the scratch WORK repo (a normal worktree repo). */
async function commitFile(work: string, path: string, content: string, msg: string): Promise<string> {
  await writeFile(join(work, path), content);
  const add = await defaultRunGit(['add', '-A'], work);
  expect(add.code, add.stderr).toBe(0);
  const c = await defaultRunGit(
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg],
    work,
  );
  expect(c.code, c.stderr).toBe(0);
  const rev = await defaultRunGit(['rev-parse', 'HEAD'], work);
  expect(rev.code, rev.stderr).toBe(0);
  return rev.stdout.trim();
}

/** Move the work repo's branch head into the store's integrator namespace. */
async function publishToStore(store: string, work: string, branch: string, nsRef: string): Promise<void> {
  const f = await defaultRunGit(['fetch', work, `+refs/heads/${branch}:${nsRef}`], store);
  expect(f.code, f.stderr).toBe(0);
}

async function originSha(origin: string, ref: string): Promise<string | null> {
  const r = await defaultRunGit(['rev-parse', '--verify', '-q', `${ref}^{object}`], origin);
  const sha = r.stdout.trim();
  return r.code === 0 && sha ? sha : null;
}

describe('github-egress (P-001: canonical refs → GitHub, FF-only, secrets-gated)', () => {
  let root: string;
  let store: string;
  let origin: string;
  let work: string;
  const integrator = devicePubkey();
  let stagingNsRef: string;
  let sha1: string;
  let sha2: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hg-egress-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = join(root, 'store');
    store = await ensurePotGitRepo('hive-bridge', 'repo-1');
    stagingNsRef = namespaceRefPath(integrator, STAGING_REF);

    origin = join(root, 'origin.git');
    const initOrigin = await defaultRunGit(['init', '--bare', '-q', origin], root);
    expect(initOrigin.code, initOrigin.stderr).toBe(0);

    work = join(root, 'work');
    const initWork = await defaultRunGit(['init', '-q', '-b', 'main', work], root);
    expect(initWork.code, initWork.stderr).toBe(0);

    sha1 = await commitFile(work, 'a.txt', 'hello\n', 'c1');
    await publishToStore(store, work, 'main', stagingNsRef);
  });

  afterAll(async () => {
    delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  it('first egress creates the remote branch (from: null)', async () => {
    const r = await egressCanonicalRefs({
      repoPath: store,
      remoteUrl: origin,
      refs: [{ sha: sha1, remoteRef: 'refs/heads/staging' }],
    });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.pushed).toEqual([{ remoteRef: 'refs/heads/staging', from: null, to: sha1 }]);
    expect(await originSha(origin, 'refs/heads/staging')).toBe(sha1);
  });

  it('re-egress of the same sha is upToDate (no push)', async () => {
    const r = await egressCanonicalRefs({
      repoPath: store,
      remoteUrl: origin,
      refs: [{ sha: sha1, remoteRef: 'refs/heads/staging' }],
    });
    expect(r.ok).toBe(true);
    expect(r.pushed).toEqual([]);
    expect(r.upToDate).toEqual(['refs/heads/staging']);
  });

  it('fast-forward advance pushes from→to', async () => {
    sha2 = await commitFile(work, 'a.txt', 'hello world\n', 'c2');
    await publishToStore(store, work, 'main', stagingNsRef);
    const r = await egressCanonicalRefs({
      repoPath: store,
      remoteUrl: origin,
      refs: [{ sha: sha2, remoteRef: 'refs/heads/staging' }],
    });
    expect(r.errors).toEqual([]);
    expect(r.pushed).toEqual([{ remoteRef: 'refs/heads/staging', from: sha1, to: sha2 }]);
    expect(await originSha(origin, 'refs/heads/staging')).toBe(sha2);
  });

  it('a diverged origin is rejectedNonFF and NEVER overwritten (S-4)', async () => {
    // Simulate a GitHub-side rewrite: an unrelated root commit replaces staging.
    const tree = await defaultRunGit(['hash-object', '-w', '-t', 'tree', '/dev/null'], origin);
    expect(tree.code, tree.stderr).toBe(0);
    const alien = await defaultRunGit(
      ['-c', 'user.name=x', '-c', 'user.email=x@x', 'commit-tree', tree.stdout.trim(), '-m', 'alien'],
      origin,
    );
    expect(alien.code, alien.stderr).toBe(0);
    const alienSha = alien.stdout.trim();
    const move = await defaultRunGit(['update-ref', 'refs/heads/staging', alienSha], origin);
    expect(move.code, move.stderr).toBe(0);

    const r = await egressCanonicalRefs({
      repoPath: store,
      remoteUrl: origin,
      refs: [{ sha: sha2, remoteRef: 'refs/heads/staging' }],
    });
    expect(r.pushed).toEqual([]);
    expect(r.rejectedNonFF).toHaveLength(1);
    expect(r.rejectedNonFF[0].remoteRef).toBe('refs/heads/staging');
    expect(r.rejectedNonFF[0].remoteSha).toBe(alienSha);
    // Origin untouched — the divergence is P-006's to reconcile, never forced.
    expect(await originSha(origin, 'refs/heads/staging')).toBe(alienSha);

    // Restore origin to the canonical line for the following tests.
    const restore = await defaultRunGit(['update-ref', 'refs/heads/staging', sha2], origin);
    expect(restore.code, restore.stderr).toBe(0);
  });

  it('a secret in the published delta BLOCKS egress (nothing leaves)', async () => {
    // Constructed at runtime so no token-shaped literal lives in the source.
    const fakeToken = `ghp_${'a'.repeat(40)}`;
    const secretSha = await commitFile(work, 'oops.env', `token=${fakeToken}\n`, 'c3-secret');
    await publishToStore(store, work, 'main', stagingNsRef);

    const r = await egressCanonicalRefs({
      repoPath: store,
      remoteUrl: origin,
      refs: [{ sha: secretSha, remoteRef: 'refs/heads/staging' }],
    });
    expect(r.pushed).toEqual([]);
    expect(r.blockedSecrets).toHaveLength(1);
    expect(r.blockedSecrets[0].remoteRef).toBe('refs/heads/staging');
    expect(r.blockedSecrets[0].findings.some((f) => f.rule === 'github-token')).toBe(true);
    // Origin still at the pre-secret sha.
    expect(await originSha(origin, 'refs/heads/staging')).toBe(sha2);
  });

  it('a secret committed THEN DELETED in the range still blocks (history scan)', async () => {
    // work head currently carries the secret commit; delete the file on top —
    // the endpoint diff sha2..head is now clean, but history is not.
    const rmFile = await defaultRunGit(['rm', '-q', 'oops.env'], work);
    expect(rmFile.code, rmFile.stderr).toBe(0);
    const c = await defaultRunGit(
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'c4-remove-secret'],
      work,
    );
    expect(c.code, c.stderr).toBe(0);
    const head = (await defaultRunGit(['rev-parse', 'HEAD'], work)).stdout.trim();
    await publishToStore(store, work, 'main', stagingNsRef);

    const r = await egressCanonicalRefs({
      repoPath: store,
      remoteUrl: origin,
      refs: [{ sha: head, remoteRef: 'refs/heads/staging' }],
    });
    expect(r.pushed).toEqual([]);
    expect(r.blockedSecrets).toHaveLength(1);
    expect(r.blockedSecrets[0].findings.some((f) => f.rule === 'github-token')).toBe(true);
  });

  // WI-5738: this used to assert "scan-overflow fails closed" — the ref was
  // blocked outright once the delta exceeded maxScanFiles. That posture was the
  // bug: because the scanned range is baselined on the REMOTE's current head, a
  // ref that overflowed once could never un-overflow (the range only shrinks
  // through the push being refused), so a merely LARGE backlog was refused
  // forever with an empty findings list. maxScanFiles is now a per-tick BUDGET:
  // the verified prefix is pushed and the rest drains on later ticks. The
  // safety invariant is unchanged — nothing unscanned is ever pushed.
  it('scan budget makes PARTIAL progress instead of failing closed (WI-5738)', async () => {
    const r = await egressCanonicalRefs({
      repoPath: store,
      remoteUrl: origin,
      refs: [{ sha: sha2, remoteRef: 'refs/heads/overflow-probe' }],
      maxScanFiles: 1, // sha2's history introduces >1 blob
    });
    expect(r.blockedSecrets).toEqual([]); // a big range is not a leak
    const landed = await originSha(origin, 'refs/heads/overflow-probe');
    expect(landed).not.toBeNull(); // progress was made…
    expect(landed).not.toBe(sha2); // …but only as far as the budget verified
    expect(r.errors.join(' ')).toMatch(/scan budget/);

    // Draining is monotone: repeated ticks converge on the target.
    for (let i = 0; i < 5; i++) {
      const again = await egressCanonicalRefs({
        repoPath: store,
        remoteUrl: origin,
        refs: [{ sha: sha2, remoteRef: 'refs/heads/overflow-probe' }],
        maxScanFiles: 1,
      });
      expect(again.blockedSecrets).toEqual([]);
      if ((await originSha(origin, 'refs/heads/overflow-probe')) === sha2) break;
    }
    expect(await originSha(origin, 'refs/heads/overflow-probe')).toBe(sha2);
  });

  it('release tags are create-only: new tag pushes, an existing tag never moves', async () => {
    const r1 = await egressCanonicalRefs({
      repoPath: store,
      remoteUrl: origin,
      refs: [],
      tags: [{ name: 'release-1', sha: sha1 }],
    });
    expect(r1.errors).toEqual([]);
    expect(r1.tagsPushed).toEqual(['release-1']);
    expect(await originSha(origin, 'refs/tags/release-1')).toBe(sha1);

    const r2 = await egressCanonicalRefs({
      repoPath: store,
      remoteUrl: origin,
      refs: [],
      tags: [
        { name: 'release-1', sha: sha2 }, // exists at sha1 → rejected
        { name: 'release-1', sha: sha1 }, // duplicate at same sha → upToDate
      ],
    });
    expect(r2.tagsPushed).toEqual([]);
    expect(r2.tagsRejected).toHaveLength(1);
    expect(r2.tagsRejected[0].name).toBe('release-1');
    expect(r2.upToDate).toContain('refs/tags/release-1');
    expect(await originSha(origin, 'refs/tags/release-1')).toBe(sha1);
  });

  it('an unreachable remote folds into errors (ok:false), never throws', async () => {
    const r = await egressCanonicalRefs({
      repoPath: store,
      remoteUrl: join(root, 'no-such-origin.git'),
      refs: [{ sha: sha1, remoteRef: 'refs/heads/staging' }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.remoteErrors).toHaveLength(1);
    expect(r.remoteErrors[0]?.transient).toBe(false);
    expect(r.pushed).toEqual([]);
  });

  it('a remote permission failure with Git\'s generic trailer stays a structured transport error', async () => {
    const r = await egressCanonicalRefs({
      repoPath: store,
      remoteUrl: origin,
      refs: [{ sha: sha2, remoteRef: 'refs/heads/transport-probe' }],
      runGit: async (args, cwd, options) => {
        if (args[0] === 'push') {
          return {
            code: 128,
            stdout: '',
            stderr:
              "remote: Permission to repository denied.\n" +
              "error: failed to push some refs to 'https://example.invalid/repo.git'",
          };
        }
        return defaultRunGit(args, cwd, options);
      },
    });
    expect(r.ok).toBe(false);
    expect(r.pushed).toEqual([]);
    expect(r.rejectedNonFF).toEqual([]);
    expect(r.remoteErrors).toEqual([
      {
        message:
          "push preflight refs/heads/transport-probe: remote: Permission to repository denied.\n" +
          "error: failed to push some refs to 'https://example.invalid/repo.git'",
        transient: false,
      },
    ]);
  });
});

/**
 * WI-5738 — egress must make PARTIAL PROGRESS instead of latching shut.
 *
 * Before this, `egressCanonicalRefs` scanned (origin, target] as ONE set and
 * refused the whole push on any finding or on exceeding maxScanFiles. Since the
 * baseline IS origin's current head, that refusal was terminal: the range could
 * only shrink through the push it was blocking. One accidental commit froze
 * origin/staging for five days (2026-07-20) while every health surface read green.
 */
describe('github-egress WI-5738 — incremental scan, partial progress, exemptions', () => {
  let root: string;
  let store: string;
  let origin: string;
  let work: string;
  const integrator = devicePubkey();
  let stagingNsRef: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hg-egress-inc-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = join(root, 'store');
    store = await ensurePotGitRepo('hive-bridge-inc', 'repo-1');
    stagingNsRef = namespaceRefPath(integrator, STAGING_REF);
    origin = join(root, 'origin.git');
    expect((await defaultRunGit(['init', '--bare', '-q', origin], root)).code).toBe(0);
    work = join(root, 'work');
    expect((await defaultRunGit(['init', '-q', '-b', 'main', work], root)).code).toBe(0);
  });

  afterAll(async () => {
    delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  const fakeKey = ['AKIA', 'EGRESSEGRESSEGRE'].join('');

  it('pushes the clean PREFIX and blocks at the exact offending commit', async () => {
    const c1 = await commitFile(work, 'a.txt', 'one\n', 'c1');
    const c2 = await commitFile(work, 'b.txt', 'two\n', 'c2');
    const leaky = await commitFile(work, 'leak.env', `AWS_ACCESS_KEY_ID=${fakeKey}\n`, 'leak');
    const c4 = await commitFile(work, 'd.txt', 'four\n', 'c4');
    await publishToStore(store, work, 'main', stagingNsRef);

    const r = await egressCanonicalRefs({
      repoPath: store,
      remoteUrl: origin,
      refs: [{ sha: c4, remoteRef: 'refs/heads/staging' }],
    });

    // The clean prefix SHIPPED — the old behaviour pushed nothing at all.
    expect(r.pushed).toEqual([{ remoteRef: 'refs/heads/staging', from: null, to: c2 }]);
    expect(await originSha(origin, 'refs/heads/staging')).toBe(c2);
    // …and the block names the exact commit, not "somewhere in this range".
    expect(r.blockedSecrets).toHaveLength(1);
    expect(r.blockedSecrets[0].blockedAtCommit).toBe(leaky);
    expect(r.blockedSecrets[0].advancedTo).toBe(c2);
    expect(r.blockedSecrets[0].findings[0].path).toBe('leak.env');
    void c1;
  });

  it('a runtime PATH-PREFIX exemption clears the block and the backlog drains fully', async () => {
    const head = (await defaultRunGit(['rev-parse', 'HEAD'], work)).stdout.trim();
    const r = await egressCanonicalRefs({
      repoPath: store,
      remoteUrl: origin,
      refs: [{ sha: head, remoteRef: 'refs/heads/staging' }],
      workspaceId: 'ws-test',
      // A DIRECTORY prefix — the shape the 2026-07-20 incident needed and that
      // exact-path-only matching could not express (4,174 files under one dir).
      loadPathExemptions: async () => new Set(['leak.env']),
    });
    expect(r.blockedSecrets).toEqual([]);
    expect(r.exemptedFindings).toHaveLength(1);
    expect(r.exemptedFindings[0].path).toBe('leak.env');
    expect(await originSha(origin, 'refs/heads/staging')).toBe(head);
  });

  it('egress consults NO runtime exemptions when workspaceId is omitted', async () => {
    let called = false;
    await commitFile(work, 'leak2.env', `AWS_ACCESS_KEY_ID=${fakeKey}\n`, 'leak2');
    const head = (await defaultRunGit(['rev-parse', 'HEAD'], work)).stdout.trim();
    await publishToStore(store, work, 'main', stagingNsRef);
    const r = await egressCanonicalRefs({
      repoPath: store,
      remoteUrl: origin,
      refs: [{ sha: head, remoteRef: 'refs/heads/staging' }],
      loadPathExemptions: async () => {
        called = true;
        return new Set(['leak2.env']);
      },
    });
    expect(called).toBe(false);
    expect(r.blockedSecrets).toHaveLength(1);
  });

  it('a scan BUDGET now drains over ticks instead of refusing forever (was: overflow)', async () => {
    // maxScanFiles:1 makes every commit exhaust the budget immediately. The old
    // code returned overflow=true and blocked the ref permanently; now each tick
    // ships a verified prefix and the next resumes from it.
    const target = (await defaultRunGit(['rev-parse', 'HEAD'], work)).stdout.trim();
    const before = await originSha(origin, 'refs/heads/staging');
    let last = before;
    for (let tick = 0; tick < 6; tick++) {
      const r = await egressCanonicalRefs({
        repoPath: store,
        remoteUrl: origin,
        refs: [{ sha: target, remoteRef: 'refs/heads/staging' }],
        maxScanFiles: 1,
        workspaceId: 'ws-test',
        loadPathExemptions: async () => new Set(['leak.env', 'leak2.env']),
      });
      expect(r.blockedSecrets).toEqual([]);
      const now = await originSha(origin, 'refs/heads/staging');
      expect(now).not.toBeNull();
      last = now;
      if (now === target) break;
    }
    expect(last).toBe(target); // fully drained — never a permanent refusal
  });

  it('persists a DAG-safe scan cursor across ticks without pushing a side-branch commit', async () => {
    const cursorWork = join(root, 'cursor-work');
    const initCursorWork = await defaultRunGit(['init', '-q', '-b', 'main', cursorWork], root);
    expect(initCursorWork.code, initCursorWork.stderr).toBe(0);
    const common = await commitFile(cursorWork, 'base.txt', 'common base\n', 'common base');
    const base = await commitFile(cursorWork, 'base.txt', 'remote base\n', 'remote base');
    const sideStart = await defaultRunGit(['checkout', '-b', 'cursor-side', common], cursorWork);
    expect(sideStart.code, sideStart.stderr).toBe(0);
    const sideSha = await commitFile(cursorWork, 'cursor-side.txt', 'safe side history\n', 'cursor side');

    const mainStart = await defaultRunGit(['checkout', '-b', 'cursor-main', base], cursorWork);
    expect(mainStart.code, mainStart.stderr).toBe(0);
    const merge = await defaultRunGit(
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'merge', '--no-ff', 'cursor-side', '-m', 'merge side history'],
      cursorWork,
    );
    expect(merge.code, merge.stderr).toBe(0);
    const target = (await defaultRunGit(['rev-parse', 'HEAD'], cursorWork)).stdout.trim();
    const cursorStore = await ensurePotGitRepo('hive-bridge-cursor', 'repo-1');
    const cursorStagingNsRef = namespaceRefPath(integrator, STAGING_REF);
    await publishToStore(cursorStore, cursorWork, 'cursor-main', cursorStagingNsRef);

    const cursorOrigin = join(root, 'cursor-origin.git');
    const initCursorOrigin = await defaultRunGit(['init', '--bare', '-q', cursorOrigin], root);
    expect(initCursorOrigin.code, initCursorOrigin.stderr).toBe(0);
    const setRemoteBase = await defaultRunGit(
      ['push', cursorOrigin, base + ':refs/heads/cursor-probe'],
      cursorWork,
    );
    expect(setRemoteBase.code, setRemoteBase.stderr).toBe(0);

    const first = await egressCanonicalRefs({
      repoPath: cursorStore,
      remoteUrl: cursorOrigin,
      refs: [{ sha: target, remoteRef: 'refs/heads/cursor-probe' }],
      maxScanFiles: 1,
    });

    expect(first.pushed).toEqual([]);
    expect(first.scanProgress).toMatchObject({
      version: 1,
      baseSha: base,
      targetSha: target,
      lastScannedCommitSha: sideSha,
    });
    expect(await originSha(cursorOrigin, 'refs/heads/cursor-probe')).toBe(base);

    const cursor = first.scanProgress;
    if (!cursor) throw new Error('expected a persisted scan cursor after the first budget slice');
    const second = await egressCanonicalRefs({
      repoPath: cursorStore,
      remoteUrl: cursorOrigin,
      refs: [{ sha: target, remoteRef: 'refs/heads/cursor-probe' }],
      maxScanFiles: 1,
      scanProgress: cursor,
    });

    expect(second.pushed).toEqual([{ remoteRef: 'refs/heads/cursor-probe', from: base, to: target }]);
    expect(second.scanProgress).toBeNull();
    expect(await originSha(cursorOrigin, 'refs/heads/cursor-probe')).toBe(target);
  });

  /**
   * EI-18655490965643060 recurrence guard. readScannableBlobs used to spawn
   * `cat-file -s` + `cat-file -p` PER BLOB, serially — so the scan cost 2xB
   * sequential git process spawns. On the live backlog that was ~5m15s for one
   * budget slice, and because the leg runs inside the git-sync DBOS workflow on
   * the routines-critical queue it blocked every subsequent git-sync fire for
   * the harness, presenting exactly like a wedged pipeline.
   *
   * The invariant is the one that matters: blob reads are BATCHED, so the spawn
   * count is O(1) in the number of blobs, not O(B). Asserting a small constant
   * (rather than a ratio) is what makes the per-blob shape impossible to
   * reintroduce silently.
   */
  it('reads blobs in a BOUNDED number of git spawns — O(1) in blob count, not O(B)', async () => {
    const manyBlobs = join(root, 'many');
    const initMany = await defaultRunGit(['init', '-q', '-b', 'main', manyBlobs], root);
    expect(initMany.code, initMany.stderr).toBe(0);

    const BLOBS = 40;
    for (let i = 0; i < BLOBS; i++) {
      await writeFile(join(manyBlobs, `f${i}.txt`), `content number ${i}\n`);
    }
    const add = await defaultRunGit(['add', '-A'], manyBlobs);
    expect(add.code, add.stderr).toBe(0);
    const commit = await defaultRunGit(
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'many blobs'],
      manyBlobs,
    );
    expect(commit.code, commit.stderr).toBe(0);
    const target = (await defaultRunGit(['rev-parse', 'HEAD'], manyBlobs)).stdout.trim();

    const manyStore = await ensurePotGitRepo('hive-bridge', 'repo-many');
    const manyNsRef = namespaceRefPath(integrator, STAGING_REF);
    await publishToStore(manyStore, manyBlobs, 'main', manyNsRef);

    const manyOrigin = join(root, 'origin-many.git');
    const initManyOrigin = await defaultRunGit(['init', '--bare', '-q', manyOrigin], root);
    expect(initManyOrigin.code, initManyOrigin.stderr).toBe(0);

    let stdinSpawns = 0;
    const { defaultRunGitStdin } = await import('./storage');
    const r = await egressCanonicalRefs({
      repoPath: manyStore,
      remoteUrl: manyOrigin,
      refs: [{ sha: target, remoteRef: 'refs/heads/staging' }],
      runGitStdin: async (args, cwd, stdin, opts) => {
        stdinSpawns += 1;
        return defaultRunGitStdin(args, cwd, stdin, opts);
      },
    });
    // The scan must actually have happened (otherwise the assertion is vacuous).
    expect(r.errors).toEqual([]);
    expect(stdinSpawns).toBeGreaterThan(0);
    // 40 blobs in ONE commit ⇒ at most 2 batched spawns (batch-check + batch).
    // The old per-blob shape would have been 80.
    expect(stdinSpawns).toBeLessThanOrEqual(2);
  });
});

function egressCanonicalRefs(input: Parameters<typeof egressCanonicalRefsUnderTest>[0]) {
  return egressCanonicalRefsUnderTest({ ...hiveEffectFixture(), ...input });
}
