/**
 * own-head-publish.integration.test.ts — G-2a (WI-5146): the worktree→own-
 * namespace first link. Real git end-to-end: a real worktree with real
 * commits, the real bare store (ensurePotGitRepo under a temp
 * PAPERCUSP_HIVE_GIT_ROOT), the real G-10 guard on the transferred range.
 *
 * The failure this file pins down: before this tick existed, every production
 * leg (bootstrap/announce/integrator/worktree-bridge) consumed namespace refs
 * that nothing in production ever wrote — live-caught on the tower↔VM rig
 * 2026-07-17 as "bridged mode produces no bare store at all".
 *
 * Run: npm run test:file -- packages/operator-core/lib/sync/pot-git/own-head-publish.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile, access } from 'node:fs/promises';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  defaultRunGit,
  ensurePotGitRepo,
  hiveGitRepoPath,
  listNamespaces,
  readNamespaceRef,
} from './storage';
import { runOwnHeadPublishTick } from './own-head-publish';

function devicePubkey(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const spki = (publicKey as KeyObject).export({ format: 'der', type: 'spki' }) as Buffer;
  return spki.subarray(spki.length - 32).toString('base64');
}

const HIVE = 'hive-ohp';
const REPO_KEY = 'repo-ohp';
const BRANCH = 'master';

async function git(args: string[], cwd: string): Promise<string> {
  const r = await defaultRunGit(args, cwd);
  expect(r.code, `git ${args.join(' ')}: ${r.stderr}`).toBe(0);
  return r.stdout.trim();
}

async function commitFile(worktree: string, name: string, content: string, msg: string): Promise<string> {
  await writeFile(join(worktree, name), content);
  await git(['add', '-A'], worktree);
  await git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg], worktree);
  return git(['rev-parse', 'HEAD'], worktree);
}

describe('own-head publish (G-2a: worktree head → own namespace, guarded)', () => {
  let root: string;
  let worktree: string;
  let oldRoot: string | undefined;
  const dev = devicePubkey();

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hgohp-'));
    oldRoot = process.env.PAPERCUSP_HIVE_GIT_ROOT;
    process.env.PAPERCUSP_HIVE_GIT_ROOT = join(root, 'store');
    worktree = join(root, 'worktree');
    await git(['init', '-q', '-b', BRANCH, worktree], root);
  });

  afterAll(async () => {
    if (oldRoot === undefined) delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    else process.env.PAPERCUSP_HIVE_GIT_ROOT = oldRoot;
    await rm(root, { recursive: true, force: true });
  });

  it('an unborn branch is a ran:false no-op — no store is created for nothing', async () => {
    const out = await runOwnHeadPublishTick({
      potHomeSlug: HIVE,
      repoKey: REPO_KEY,
      worktreePath: worktree,
      branch: BRANCH,
      devicePubkeyBase64: dev,
    });
    expect(out.ran).toBe(false);
    expect(out.changed).toBe(false);
  });

  it('first publish creates the store and lands the head in the own namespace', async () => {
    const sha = await commitFile(worktree, 'a.txt', 'hello\n', 'first');
    const out = await runOwnHeadPublishTick({
      potHomeSlug: HIVE,
      repoKey: REPO_KEY,
      worktreePath: worktree,
      branch: BRANCH,
      devicePubkeyBase64: dev,
    });
    expect(out.errors, out.errors.join('; ')).toEqual([]);
    expect(out.ran).toBe(true);
    expect(out.changed).toBe(true);
    expect(out.headSha).toBe(sha);
    expect(out.priorSha).toBeNull();

    const repoPath = hiveGitRepoPath(HIVE, REPO_KEY);
    expect(await readNamespaceRef(repoPath, dev, `refs/heads/${BRANCH}`)).toBe(sha);
    // The canonical WORK_REF alias the integrator gates on moves with it.
    expect(await readNamespaceRef(repoPath, dev, 'refs/heads/work')).toBe(sha);
    expect(await listNamespaces(repoPath)).toHaveLength(1);
    // The published commit is a real, connected object in the shared ODB.
    const type = await git(['cat-file', '-t', sha], repoPath);
    expect(type).toBe('commit');
  });

  it('diagnoses a zero-byte bare-store object before transfer and preserves it for recovery', async () => {
    const key = 'corrupt-ohp';
    const corruptWorktree = join(root, 'corrupt-worktree');
    await git(['init', '-q', '-b', BRANCH, corruptWorktree], root);
    await commitFile(corruptWorktree, 'a.txt', 'healthy\n', 'bare corruption control');
    const repoPath = await ensurePotGitRepo(HIVE, key);
    const oid = '1'.repeat(40);
    const objectDir = join(repoPath, 'objects', oid.slice(0, 2));
    const objectPath = join(objectDir, oid.slice(2));
    await mkdir(objectDir, { recursive: true });
    await writeFile(objectPath, '');
    let transfers = 0;
    const runGit: typeof defaultRunGit = async (args, cwd, options) => {
      if (args[0] === 'fetch') transfers++;
      return defaultRunGit(args, cwd, options);
    };
    const input = { potHomeSlug: HIVE, repoKey: key, worktreePath: corruptWorktree,
      branch: BRANCH, devicePubkeyBase64: dev, runGit };
    const failed = await runOwnHeadPublishTick(input);
    expect(failed.errors).toEqual([
      `own-head Git object database corrupt: zero-byte loose object(s): ${oid}; repair required before fetch`,
    ]);
    expect(failed.changed).toBe(false);
    expect(transfers).toBe(0);
    expect(await readFile(objectPath)).toHaveLength(0);
    expect(await listNamespaces(repoPath)).toHaveLength(0);

    // The guard does not delete an object whose only copy might be local.
    // Explicit fixture recovery lets the same production path publish again.
    await rm(objectPath);
    const recovered = await runOwnHeadPublishTick(input);
    expect(recovered.errors).toEqual([]);
    expect(recovered.changed).toBe(true);
    expect(transfers).toBe(1);
    expect(await readNamespaceRef(repoPath, dev, `refs/heads/${BRANCH}`)).toBe(recovered.headSha);
  });

  it('an unmoved head is a free changed:false no-op', async () => {
    const out = await runOwnHeadPublishTick({
      potHomeSlug: HIVE,
      repoKey: REPO_KEY,
      worktreePath: worktree,
      branch: BRANCH,
      devicePubkeyBase64: dev,
    });
    expect(out.ran).toBe(true);
    expect(out.changed).toBe(false);
    expect(out.refused).toBeNull();
  });

  it('a new commit advances the namespace ref to the new head', async () => {
    const sha2 = await commitFile(worktree, 'b.txt', 'more\n', 'second');
    const out = await runOwnHeadPublishTick({
      potHomeSlug: HIVE,
      repoKey: REPO_KEY,
      worktreePath: worktree,
      branch: BRANCH,
      devicePubkeyBase64: dev,
    });
    expect(out.changed).toBe(true);
    expect(out.headSha).toBe(sha2);
    const repoPath = hiveGitRepoPath(HIVE, REPO_KEY);
    expect(await readNamespaceRef(repoPath, dev, `refs/heads/${BRANCH}`)).toBe(sha2);
    expect(await readNamespaceRef(repoPath, dev, 'refs/heads/work')).toBe(sha2);
  });

  it('G-10 refuses a planted credential: ref unchanged, nothing newly advertised', async () => {
    const repoPath = hiveGitRepoPath(HIVE, REPO_KEY);
    const before = await readNamespaceRef(repoPath, dev, `refs/heads/${BRANCH}`);
    const refsBefore = await git(['for-each-ref', '--format=%(refname)'], repoPath);

    // A live-looking secret-shaped token (the secrets-guard's canonical
    // detector class) — a fake GitHub-token shape, NOT an AWS access-key-id:
    // secrets-guard.ts's isDocumentedExample() now deliberately EXEMPTS any
    // aws-access-key-id match ending in the literal "EXAMPLE" (P-402 defect
    // #10, 2026-07-19 — a doc citing AWS's own documented placeholder key
    // was wedging the publish plane), so AWS's own EXAMPLE-suffixed fixture
    // would silently pass the guard here, testing nothing (WI-5163 follow-up
    // — this test itself regressed the moment that exemption landed). This
    // shape exercises the 'github-token' rule, unaffected by that exemption.
    const fakeToken = `ghp_${'A'.repeat(20)}${'1'.repeat(20)}`;
    await commitFile(worktree, 'oops.env', `SOME_TOKEN=${fakeToken}\n`, 'oops secrets');
    const out = await runOwnHeadPublishTick({
      potHomeSlug: HIVE,
      repoKey: REPO_KEY,
      worktreePath: worktree,
      branch: BRANCH,
      devicePubkeyBase64: dev,
    });
    expect(out.ran).toBe(true);
    expect(out.changed).toBe(false);
    expect(out.refused).not.toBeNull();
    expect(out.refused!.refusalCode).toBe('secrets');
    // The namespace ref did not move and no new ref of any kind appeared —
    // the refused objects are unreachable, never servable.
    expect(await readNamespaceRef(repoPath, dev, `refs/heads/${BRANCH}`)).toBe(before);
    expect(await git(['for-each-ref', '--format=%(refname)'], repoPath)).toBe(refsBefore);

    // Roll the bad commit away; the next head publishes cleanly again.
    await git(['reset', '--hard', 'HEAD~1'], worktree);
    const sha3 = await commitFile(worktree, 'c.txt', 'clean\n', 'clean again');
    const out2 = await runOwnHeadPublishTick({
      potHomeSlug: HIVE,
      repoKey: REPO_KEY,
      worktreePath: worktree,
      branch: BRANCH,
      devicePubkeyBase64: dev,
    });
    expect(out2.changed).toBe(true);
    expect(out2.headSha).toBe(sha3);
    expect(await readNamespaceRef(repoPath, dev, `refs/heads/${BRANCH}`)).toBe(sha3);
  });

  it('resolves the checked-out branch when cfg gives none; detached HEAD is a no-op', async () => {
    const repoPath = hiveGitRepoPath(HIVE, REPO_KEY);
    const head = await git(['rev-parse', 'HEAD'], worktree);
    const out = await runOwnHeadPublishTick({
      potHomeSlug: HIVE,
      repoKey: REPO_KEY,
      worktreePath: worktree,
      devicePubkeyBase64: dev,
    });
    expect(out.branch).toBe(BRANCH);
    expect(out.headSha).toBe(head);

    await git(['checkout', '-q', '--detach', 'HEAD'], worktree);
    const detached = await runOwnHeadPublishTick({
      potHomeSlug: HIVE,
      repoKey: REPO_KEY,
      worktreePath: worktree,
      devicePubkeyBase64: dev,
    });
    expect(detached.ran).toBe(false);
    await git(['checkout', '-q', BRANCH], worktree);
    expect(await readNamespaceRef(repoPath, dev, `refs/heads/${BRANCH}`)).toBe(head);
  });

  describe('shallow source worktree (WI-5163: from-repo shallow:true default must not permanently refuse)', () => {
    const REPO_S = 'repo-ohp-shallow';

    it.each(['unshallow', 'transfer'] as const)('reclaims only new partial packs after a failed %s, without publishing a ref', async (leg) => {
      const local = await mkdtemp(join(root, 'failed-fetch-'));
      await git(['init', '-q', '-b', BRANCH, local], root);
      await commitFile(local, 'head.txt', 'head', 'head');
      const key = `failed-${leg}`;
      const bare = await ensurePotGitRepo(HIVE, key);
      const packDir = join(leg === 'unshallow' ? join(local, '.git') : bare, 'objects', 'pack');
      await mkdir(packDir, { recursive: true });
      const preexisting = join(packDir, 'tmp_pack_preexisting');
      const partial = join(packDir, 'tmp_pack_failed-attempt');
      await writeFile(preexisting, 'preserve prior attempt');
      const calls: string[][] = [];
      const device = devicePubkey();
      const out = await runOwnHeadPublishTick({
        potHomeSlug: HIVE, repoKey: key, worktreePath: local,
        branch: BRANCH, devicePubkeyBase64: device,
        runGit: async (args, cwd, options) => {
          calls.push(args);
          if (leg === 'unshallow' && args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') {
            return { code: 0, stdout: 'true\n', stderr: '' };
          }
          if (args[0] === 'fetch') {
            await writeFile(partial, Buffer.alloc(8192, 7));
            return { code: 128, stdout: '', stderr: 'fatal: write error: No space left on device' };
          }
          return defaultRunGit(args, cwd, options);
        },
      });
      expect(out.changed).toBe(false);
      expect(out.errors.join('; ')).toContain('No space left on device');
      expect(await readFile(preexisting, 'utf8')).toBe('preserve prior attempt');
      await expect(access(partial)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(calls.filter((args) => args[0] === 'fetch')).toHaveLength(1);
      expect(await readNamespaceRef(bare, device, `refs/heads/${BRANCH}`)).toBeNull();
    });

    // WI-2142873: the unshallow used to get NETWORK_RUN_GIT_TIMEOUT_MS (600s) —
    // exactly the git-sync post-legs idle deadline — so on a worktree too large to
    // unshallow the guard aborted the whole action every tick and the ref-announce
    // receive leg after it never ran (VM mirror frozen 739m+).
    it('passes the caller-bounded unshallow budget to the fetch and reports a structured failure', async () => {
      const local = await mkdtemp(join(root, 'bounded-unshallow-'));
      await git(['init', '-q', '-b', BRANCH, local], root);
      await commitFile(local, 'head.txt', 'head', 'head');
      const seenTimeouts: Array<number | undefined> = [];
      const out = await runOwnHeadPublishTick({
        potHomeSlug: HIVE, repoKey: 'bounded-unshallow', worktreePath: local,
        branch: BRANCH, devicePubkeyBase64: devicePubkey(),
        unshallowTimeoutMs: 123_000,
        runGit: async (args, cwd, options) => {
          if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') {
            return { code: 0, stdout: 'true\n', stderr: '' };
          }
          if (args[0] === 'fetch' && args.includes('--unshallow')) {
            seenTimeouts.push(options?.timeoutMs);
            return { code: 124, stdout: '', stderr: 'git fetch --quiet --unshallow origin timed out' };
          }
          return defaultRunGit(args, cwd, options);
        },
      });
      expect(seenTimeouts).toEqual([123_000]);
      expect(out.changed).toBe(false);
      expect(out.unshallow?.state).toBe('failed');
      expect(out.unshallow?.error).toContain('timed out');
    });

    it('a deferred unshallow issues NO fetch and returns at once, so later legs keep their budget', async () => {
      const local = await mkdtemp(join(root, 'deferred-unshallow-'));
      await git(['init', '-q', '-b', BRANCH, local], root);
      await commitFile(local, 'head.txt', 'head', 'head');
      const calls: string[][] = [];
      const now = 1_800_000_000_000;
      const out = await runOwnHeadPublishTick({
        potHomeSlug: HIVE, repoKey: 'deferred-unshallow', worktreePath: local,
        branch: BRANCH, devicePubkeyBase64: devicePubkey(),
        unshallowDeferredUntil: now + 60_000,
        now: () => now,
        runGit: async (args, cwd, options) => {
          calls.push(args);
          if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') {
            return { code: 0, stdout: 'true\n', stderr: '' };
          }
          return defaultRunGit(args, cwd, options);
        },
      });
      expect(calls.filter((a) => a[0] === 'fetch')).toHaveLength(0);
      expect(out.unshallow).toEqual({ state: 'deferred', deferredUntil: now + 60_000 });
      expect(out.errors.join('; ')).toContain('unshallow deferred until');
    });

    it('an EXPIRED deferral attempts the unshallow again', async () => {
      const local = await mkdtemp(join(root, 'expired-unshallow-'));
      await git(['init', '-q', '-b', BRANCH, local], root);
      await commitFile(local, 'head.txt', 'head', 'head');
      let unshallowAttempts = 0;
      const now = 1_800_000_000_000;
      const out = await runOwnHeadPublishTick({
        potHomeSlug: HIVE, repoKey: 'expired-unshallow', worktreePath: local,
        branch: BRANCH, devicePubkeyBase64: devicePubkey(),
        unshallowDeferredUntil: now - 1,
        now: () => now,
        runGit: async (args, cwd, options) => {
          if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository') {
            return { code: 0, stdout: 'true\n', stderr: '' };
          }
          if (args[0] === 'fetch' && args.includes('--unshallow')) {
            unshallowAttempts += 1;
            return { code: 128, stdout: '', stderr: 'fatal: unable to access remote' };
          }
          return defaultRunGit(args, cwd, options);
        },
      });
      expect(unshallowAttempts).toBe(1);
      expect(out.unshallow?.state).toBe('failed');
    });

    it('a shallow clone is unshallowed before transfer, so publish lands instead of fail-closing forever', async () => {
      // A real "origin" with enough history that a depth-1 clone is a
      // genuinely graft-truncated shallow repo (parent unreachable).
      const originRoot = await mkdtemp(join(tmpdir(), 'hgohp-origin-'));
      await git(['init', '-q', '-b', BRANCH, originRoot], root);
      await commitFile(originRoot, 'o1.txt', 'v1', 'o1');
      await commitFile(originRoot, 'o2.txt', 'v2', 'o2');
      const originHead = await commitFile(originRoot, 'o3.txt', 'v3', 'o3');

      const shallowWorktree = await mkdtemp(join(tmpdir(), 'hgohp-shallow-'));
      // `file://` (not a bare local path) forces git's smart-protocol clone
      // path — a same-filesystem local-path clone silently IGNORES --depth
      // (git's --local optimization hardlinks the whole .git dir) and would
      // produce a non-shallow clone, defeating this test's whole premise.
      await git(['clone', '-q', '--depth', '1', '--branch', BRANCH, `file://${originRoot}`, shallowWorktree], root);
      expect(await git(['rev-parse', '--is-shallow-repository'], shallowWorktree)).toBe('true');

      const dev2 = devicePubkey();
      const out = await runOwnHeadPublishTick({
        potHomeSlug: HIVE,
        repoKey: REPO_S,
        worktreePath: shallowWorktree,
        branch: BRANCH,
        devicePubkeyBase64: dev2,
      });
      expect(out.errors, out.errors.join('; ')).toEqual([]);
      expect(out.ran).toBe(true);
      expect(out.changed).toBe(true);
      expect(out.refused).toBeNull();
      expect(out.headSha).toBe(originHead);
      // WI-2142873: a success is reported, so the caller clears its backoff.
      expect(out.unshallow).toEqual({ state: 'ok' });
      // The clone itself was unshallowed as a side effect of the fix.
      expect(await git(['rev-parse', '--is-shallow-repository'], shallowWorktree)).toBe('false');

      const repoPath = hiveGitRepoPath(HIVE, REPO_S);
      expect(await readNamespaceRef(repoPath, dev2, `refs/heads/${BRANCH}`)).toBe(originHead);

      await rm(originRoot, { recursive: true, force: true });
      await rm(shallowWorktree, { recursive: true, force: true });
    });

    // WI-2142873: the P-203 Mac VM's July-10 depth-1 clone could never finish
    // unshallowing from GitHub inside the tick budget, so its own head was never
    // published — although the local store already held the history behind the
    // shallow boundary. When the store covers the boundary, publish must land
    // with NO unshallow (no network), even while a failed attempt's backoff is
    // still pending, and the worktree stays shallow.
    it('publishes a shallow clone WITHOUT unshallowing when the store already holds the hidden history', async () => {
      const REPO_C = 'repo-ohp-shallow-covered';
      const originRoot = await mkdtemp(join(tmpdir(), 'hgohp-origin-c-'));
      await git(['init', '-q', '-b', BRANCH, originRoot], root);
      await commitFile(originRoot, 'o1.txt', 'v1', 'o1');
      await commitFile(originRoot, 'o2.txt', 'v2', 'o2');
      await commitFile(originRoot, 'o3.txt', 'v3', 'o3');

      const shallowWorktree = await mkdtemp(join(tmpdir(), 'hgohp-shallow-c-'));
      await git(['clone', '-q', '--depth', '1', '--branch', BRANCH, `file://${originRoot}`, shallowWorktree], root);
      expect(await git(['rev-parse', '--is-shallow-repository'], shallowWorktree)).toBe('true');
      // The device's own new work on top of the shallow boundary.
      const localHead = await commitFile(shallowWorktree, 'local.txt', 'mine', 'local');

      // The store already holds origin's full history (on the VM: the hive
      // mirror, filled by bootstrap / ref-announce from peers).
      const repoPath = await ensurePotGitRepo(HIVE, REPO_C);
      await git(['fetch', '-q', `file://${originRoot}`, `+refs/heads/${BRANCH}:refs/hive/staging`], repoPath);

      const calls: string[][] = [];
      const dev3 = devicePubkey();
      const now = Date.now();
      const out = await runOwnHeadPublishTick({
        potHomeSlug: HIVE,
        repoKey: REPO_C,
        worktreePath: shallowWorktree,
        branch: BRANCH,
        devicePubkeyBase64: dev3,
        now: () => now,
        unshallowDeferredUntil: now + 60_000,
        runGit: async (args, cwd, opts) => {
          calls.push(args);
          if (args[0] === 'fetch' && args.includes('--unshallow')) {
            return { code: 1, stdout: '', stderr: 'unshallow must not run when the store covers the boundary' };
          }
          return defaultRunGit(args, cwd, opts);
        },
      });
      expect(out.errors, out.errors.join('; ')).toEqual([]);
      expect(out.unshallow).toEqual({ state: 'not-needed' });
      expect(calls.some((a) => a.includes('--unshallow'))).toBe(false);
      expect(out.changed).toBe(true);
      expect(out.refused).toBeNull();
      expect(out.headSha).toBe(localHead);
      expect(await readNamespaceRef(repoPath, dev3, `refs/heads/${BRANCH}`)).toBe(localHead);
      // No unshallow happened: the worktree is still shallow.
      expect(await git(['rev-parse', '--is-shallow-repository'], shallowWorktree)).toBe('true');
      // The published history is walkable in the store across the boundary.
      expect(await git(['rev-list', '--count', localHead], repoPath)).toBe('4');

      await rm(originRoot, { recursive: true, force: true });
      await rm(shallowWorktree, { recursive: true, force: true });
    });
  });

  describe('genesis-publish baseline (WI-5395 follow-on: onboarding a pre-existing repo)', () => {
    // A fresh device + repo key so every publish here is a genuine genesis.
    const REPO_G = 'repo-ohp-genesis';

    // WI-5738: this test used to assert that a history above the flood cap is
    // "refused FOREVER" — and that was literally true, which is exactly the
    // defect. A volume cap could never clear itself, because the guard baseline
    // only advances via writeNamespaceRef and writeNamespaceRef only runs after
    // guard.ok. On 2026-07-20 that latched all p2p publishing shut for five
    // days. A volume breach is now DRAINED: the longest admissible prefix is
    // published each tick, so the wedge resolves itself instead of compounding.
    // (genesisBaselineSha remains the right way to onboard a big repo in ONE
    // tick rather than many — see the next test.)
    it('without a baseline, a history above the flood cap DRAINS instead of refusing forever', async () => {
      const dev2 = devicePubkey();
      for (let i = 0; i < 4; i++) await commitFile(worktree, `g${i}.txt`, `v${i}`, `g${i}`);
      const repoPath = hiveGitRepoPath(HIVE, REPO_G);
      const head = await git(['rev-parse', 'HEAD'], worktree);
      const tick = () =>
        runOwnHeadPublishTick({
          potHomeSlug: HIVE,
          repoKey: REPO_G,
          worktreePath: worktree,
          branch: BRANCH,
          devicePubkeyBase64: dev2,
          // Tight flood cap: the FULL history exceeds it, the tip delta does not.
          publishGuardCaps: { maxNewObjects: 6 },
        });

      const first = await tick();
      // The old contract was `changed: false` forever. Now the ref MOVES.
      expect(first.changed).toBe(true);
      expect(first.backlogRemains).toBe(true);
      expect(first.publishedSha).not.toBe(head); // partial — not the whole history
      const afterFirst = await readNamespaceRef(repoPath, dev2, `refs/heads/${BRANCH}`);
      expect(afterFirst).toBe(first.publishedSha);

      // Successive ticks converge on the head — the defining property the old
      // behaviour lacked: the baseline advances, so the wedge is self-clearing.
      for (let i = 0; i < 10; i++) {
        const out = await tick();
        if (!out.changed) break;
      }
      expect(await readNamespaceRef(repoPath, dev2, `refs/heads/${BRANCH}`)).toBe(head);
    });

    it('with a verified already-exposed baseline, genesis judges only the (baseline, head] delta and lands', async () => {
      const dev2 = devicePubkey();
      const repoPath = hiveGitRepoPath(HIVE, REPO_G);
      const head = await git(['rev-parse', 'HEAD'], worktree);
      const baseline = await git(['rev-parse', 'HEAD~1'], worktree); // "origin already serves up to here"
      const out = await runOwnHeadPublishTick({
        potHomeSlug: HIVE,
        repoKey: REPO_G,
        worktreePath: worktree,
        branch: BRANCH,
        devicePubkeyBase64: dev2,
        publishGuardCaps: { maxNewObjects: 6 },
        genesisBaselineSha: baseline,
      });
      expect(out.refused).toBeNull();
      expect(out.changed).toBe(true);
      expect(await readNamespaceRef(repoPath, dev2, `refs/heads/${BRANCH}`)).toBe(head);
    });

    it('after genesis the baseline is IGNORED — incremental publishes keep the strict namespace prior', async () => {
      const dev2 = devicePubkey();
      const first = await runOwnHeadPublishTick({
        potHomeSlug: HIVE,
        repoKey: REPO_G,
        worktreePath: worktree,
        branch: BRANCH,
        devicePubkeyBase64: dev2,
        genesisBaselineSha: await git(['rev-parse', 'HEAD'], worktree),
      });
      expect(first.changed).toBe(true);
      // Advance by one commit; pass a bogus far-back baseline WITH a cap that
      // would refuse a full-history judge — the strict prior (one commit back)
      // must be used instead, so the publish lands.
      const next = await commitFile(worktree, 'g-post.txt', 'post', 'g-post');
      const out = await runOwnHeadPublishTick({
        potHomeSlug: HIVE,
        repoKey: REPO_G,
        worktreePath: worktree,
        branch: BRANCH,
        devicePubkeyBase64: dev2,
        publishGuardCaps: { maxNewObjects: 6 },
        genesisBaselineSha: null,
      });
      expect(out.refused).toBeNull();
      expect(out.changed).toBe(true);
      expect(out.headSha).toBe(next);
      expect(out.priorSha).not.toBeNull();
    });
  });
});
