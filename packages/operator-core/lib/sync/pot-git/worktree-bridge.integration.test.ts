/**
 * worktree-bridge.integration.test.ts — G-7 end to end (P-031): a SIGNED
 * staging-advance announcement drives fetch (real upload-pack over a socket
 * duplex, the G-2 path) → mirror acceptance (G-5d fence) → object-bridge →
 * ff-only dirty-safe worktree advance (G-7c/G-7b). No swarm.
 *
 * Acceptance pinned here (lane C brief): a ff-advance updates the worktree; a
 * divergent one is refused + surfaced (accepted at the MIRROR level — the
 * watermark still moves — but the worktree stays put); junk envelopes are
 * rejected BEFORE any fetch.
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/pot-git/worktree-bridge.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import { defaultRunGit, ensurePotGitRepo, readNamespaceRef, writeNamespaceRef } from './storage';
import { serveUploadPack } from './fetch-transport';
import { STAGING_REF } from './integrator';
import { type EpochSeq, type SignedStagingAdvance, signStagingAdvance } from './staging-advance';
import {
  type WorktreeBridgeConfig,
  WORKTREE_STAGING_REF,
  bridgeStagingShaToWorktree,
  catchUpWorktreeToWatermark,
  handleStagingAdvance,
} from './worktree-bridge';

async function git(args: string[], cwd: string): Promise<string> {
  const r = await defaultRunGit(args, cwd);
  expect(r.code, `git ${args.join(' ')} failed: ${r.stderr}`).toBe(0);
  return r.stdout.trim();
}

async function initWorktree(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await git(['init', '-q', '-b', 'main'], dir);
  await git(['config', 'user.name', 't'], dir);
  await git(['config', 'user.email', 't@t'], dir);
}

function keypair() {
  const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
  return { pubkeyBase64, sign: async (bytes: Buffer) => signWithPrivateKeyDer(privateKeyDer, bytes) };
}

describe('worktree-bridge (G-7: announcement → fetch → accept → ff worktree advance)', () => {
  let root: string;
  let src: string; // scratch worktree that mints real-content staging commits
  let peerRepo: string; // the integrator machine's bare mirror (serves upload-pack)
  let localMirror: string; // THIS machine's bare mirror
  let wt: string; // this machine's working tree
  let sockPath: string;
  let server: Server;
  let dials = 0;
  const integrator = keypair();
  let s1 = '';
  let s2 = '';
  let s3 = '';

  const openDuplex = (): Promise<Socket> => {
    dials++;
    return new Promise<Socket>((resolve, reject) => {
      const s = connect({ path: sockPath, allowHalfOpen: true });
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
  };

  async function announce(epoch: number, seq: number, sha: string): Promise<SignedStagingAdvance> {
    return signStagingAdvance(
      { devicePubkeyBase64: integrator.pubkeyBase64, epoch, seq, stagingSha: sha, nowMs: 1_000 },
      integrator.sign,
    );
  }

  /** Publish `sha` (already minted in src) into the peer's integrator namespace. */
  async function publishToPeer(sha: string, expectedOld?: string): Promise<void> {
    await git(['fetch', '-q', src, `+refs/heads/main:refs/bridge-src`], peerRepo);
    await writeNamespaceRef(peerRepo, integrator.pubkeyBase64, STAGING_REF, sha, defaultRunGit, expectedOld);
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hgbridge-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    // Mint staging commits with real file content in a scratch worktree.
    src = join(root, 'src');
    await initWorktree(src);
    await writeFile(join(src, 'f.txt'), 'v1\n');
    await git(['add', '.'], src);
    await git(['commit', '-q', '-m', 'S1'], src);
    s1 = await git(['rev-parse', 'HEAD'], src);
    await writeFile(join(src, 'f.txt'), 'v2\n');
    await git(['add', '.'], src);
    await git(['commit', '-q', '-m', 'S2'], src);
    s2 = await git(['rev-parse', 'HEAD'], src);

    peerRepo = await ensurePotGitRepo('hive-b', 'repo-int');
    localMirror = await ensurePotGitRepo('hive-b', 'repo-local');
    await publishToPeer(s1);

    wt = join(root, 'wt');
    await initWorktree(wt);

    sockPath = join(root, 'link.sock');
    server = createServer({ allowHalfOpen: true }, (srvConn) => {
      srvConn.on('error', () => {});
      void serveUploadPack(peerRepo, srvConn);
    });
    await new Promise<void>((r) => server.listen(sockPath, () => r()));
  });

  afterAll(async () => {
    try {
      server.close();
    } catch {
      /* ignore */
    }
    delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
    await rm(root, { recursive: true, force: true });
  });

  function cfg(prior: { epochSeq: EpochSeq | null; stagingSha: string | null }): WorktreeBridgeConfig {
    return {
      bareRepoPath: localMirror,
      worktreePath: wt,
      prior,
      openDuplex,
      accept: { allowLegacy: true, expectedDevice: integrator.pubkeyBase64 },
    };
  }

  let watermark: { epochSeq: EpochSeq | null; stagingSha: string | null } = {
    epochSeq: null,
    stagingSha: null,
  };

  it('first announcement seeds an unborn worktree (fetch → accept → advance)', async () => {
    const dialsBefore = dials;
    const res = await handleStagingAdvance(cfg(watermark), await announce(1, 1, s1));
    expect(res.outcome).toBe('accepted');
    if (res.outcome !== 'accepted') return;
    // The DIAL ACTUALLY FIRED — this is the on-demand fetch's happy path, and it
    // is the only case in this file that takes it. Every other `dials` assertion
    // here is a NEGATIVE one (skip/reject never dialed), so without this positive
    // check a regression that made `s1` locally present would silently demote this
    // test to the skip branch and still pass — the fetch would stop being covered
    // anywhere while the suite stayed green (EI-18682513182543864).
    expect(dials).toBe(dialsBefore + 1);
    expect(res.watermark).toEqual({ epochSeq: { epoch: 1, seq: 1 }, stagingSha: s1 });
    expect(res.advance.outcome, res.advance.detail).toBe('advanced');
    expect(res.advance.from).toBeNull();
    watermark = res.watermark;
    // The worktree followed; the mirror holds the integrator's namespace.
    expect(await git(['rev-parse', 'HEAD'], wt)).toBe(s1);
    expect(await readFile(join(wt, 'f.txt'), 'utf8')).toBe('v1\n');
    expect(await readNamespaceRef(localMirror, integrator.pubkeyBase64, STAGING_REF)).toBe(s1);
    // The BARE-side canonical mirror is pinned too — the ref the GitHub
    // bridge's egress leg reads (github-bridge-tick BRIDGE_CANONICAL_REF);
    // without it a bridged hive's egress silently never runs (WI-3500).
    expect(await git(['rev-parse', '--verify', WORKTREE_STAGING_REF], localMirror)).toBe(s1);
  });

  it('a later announcement ff-advances the worktree', async () => {
    await publishToPeer(s2, s1);
    const res = await handleStagingAdvance(cfg(watermark), await announce(1, 2, s2));
    expect(res.outcome).toBe('accepted');
    if (res.outcome !== 'accepted') return;
    expect(res.advance.outcome, res.advance.detail).toBe('advanced');
    watermark = res.watermark;
    expect(await git(['rev-parse', 'HEAD'], wt)).toBe(s2);
    expect(await readFile(join(wt, 'f.txt'), 'utf8')).toBe('v2\n');
    expect(await git(['rev-parse', '--verify', WORKTREE_STAGING_REF], localMirror)).toBe(s2);
  });

  it('a replayed / stale announcement is rejected BEFORE any fetch', async () => {
    const dialsBefore = dials;
    const res = await handleStagingAdvance(cfg(watermark), await announce(1, 2, s2));
    expect(res).toEqual({ outcome: 'rejected', reason: 'stale-epoch-seq', preFetch: true });
    expect(dials).toBe(dialsBefore); // the pure fence never dialed out
  });

  it('a forged announcement is rejected BEFORE any fetch', async () => {
    const dialsBefore = dials;
    const forger = keypair();
    // Forger with its OWN device fails the device gate…
    const own = await signStagingAdvance(
      { devicePubkeyBase64: forger.pubkeyBase64, epoch: 9, seq: 9, stagingSha: s2, nowMs: 1 },
      forger.sign,
    );
    const r1 = await handleStagingAdvance(cfg(watermark), own);
    expect(r1).toEqual({ outcome: 'rejected', reason: 'wrong-device', preFetch: true });
    // …and forging the INTEGRATOR's identity fails the signature.
    const impersonated = await signStagingAdvance(
      { devicePubkeyBase64: integrator.pubkeyBase64, epoch: 9, seq: 9, stagingSha: s2, nowMs: 1 },
      forger.sign,
    );
    const r2 = await handleStagingAdvance(cfg(watermark), impersonated);
    expect(r2).toEqual({ outcome: 'rejected', reason: 'bad-signature', preFetch: true });
    expect(dials).toBe(dialsBefore);
  });

  it('a divergent worktree is surfaced (manual), while the MIRROR still accepts the advance', async () => {
    // The local machine commits its own work on top of s2 → the worktree head
    // is no longer an ancestor of the next staging.
    await writeFile(join(wt, 'local.txt'), 'local work\n');
    await git(['add', '.'], wt);
    await git(['commit', '-q', '-m', 'local L'], wt);
    const localHead = await git(['rev-parse', 'HEAD'], wt);

    // Integrator publishes s3 (child of s2, sibling of the local commit).
    await writeFile(join(src, 'f.txt'), 'v3\n');
    await git(['add', '.'], src);
    await git(['commit', '-q', '-m', 'S3'], src);
    s3 = await git(['rev-parse', 'HEAD'], src);
    await publishToPeer(s3, s2);

    const res = await handleStagingAdvance(cfg(watermark), await announce(1, 3, s3));
    expect(res.outcome).toBe('accepted'); // staging itself moved: watermark advances
    if (res.outcome !== 'accepted') return;
    expect(res.watermark.stagingSha).toBe(s3);
    expect(res.advance.outcome).toBe('diverged-manual'); // surfaced, not clobbered
    watermark = res.watermark;
    expect(await git(['rev-parse', 'HEAD'], wt)).toBe(localHead); // untouched
    expect(await readFile(join(wt, 'f.txt'), 'utf8')).toBe('v2\n');
  });

  it('REGRESSION (HIGH): a gate-less config THROWS — the watermark-poisoning DoS is unreachable', async () => {
    // The attack: any key self-signs an epoch-1e9 envelope over the CURRENT
    // sha. With no device gate, acceptStagingAdvance checks signature
    // SELF-consistency only — the fence would accept it, the caller would
    // persist the poisoned watermark, and every real advance thereafter would
    // be stale-epoch-seq. The bridge now refuses to run without a device gate.
    const attacker = keypair();
    const poison = await signStagingAdvance(
      { devicePubkeyBase64: attacker.pubkeyBase64, epoch: 1e9, seq: 1, stagingSha: s3, nowMs: 1 },
      attacker.sign,
    );
    const dialsBefore = dials;
    const gateless = { ...cfg(watermark), accept: { allowLegacy: true,} };
    await expect(handleStagingAdvance(gateless, poison)).rejects.toThrow(/device gate/);
    const missing = { ...cfg(watermark) } as { accept?: unknown };
    delete missing.accept;
    await expect(
      handleStagingAdvance(missing as unknown as WorktreeBridgeConfig, poison),
    ).rejects.toThrow(/device gate/);
    expect(dials).toBe(dialsBefore); // it never even dialed out

    // And WITH the gate, the same poison envelope is rejected pre-fetch.
    const gated = await handleStagingAdvance(cfg(watermark), poison);
    expect(gated).toEqual({ outcome: 'rejected', reason: 'wrong-device', preFetch: true });
    expect(dials).toBe(dialsBefore);
  });

  it('EI-14555: an announcement whose sha is ALREADY local does not dial at all (fetch is on-demand)', async () => {
    // s3 was fetched into localMirror by the divergence test above, so a
    // re-announcement of it needs no transport. The dial must be skipped
    // rather than fired-and-wasted: on a self-announcing single-machine box
    // an unconditional dial targets our OWN device pubkey, resolves no
    // socket, and the resulting fetch-failed HOLDS the P-505 fed-event cursor
    // — i.e. wiring openDuplex would wedge the bridge. Proven with a transport
    // that would REJECT if it were ever called.
    const dialsBefore = dials;
    const res = await handleStagingAdvance(
      {
        ...cfg({ epochSeq: { epoch: 1, seq: 2 }, stagingSha: s2 }),
        openDuplex: () => Promise.reject(new Error('must not dial — sha is already local')),
      },
      await announce(1, 3, s3),
    );
    expect(res.outcome).toBe('accepted');
    expect(dials).toBe(dialsBefore);
  });

  it('a dead transport is fetch-failed (retry next announce), never a throw', async () => {
    // Must announce a sha that is genuinely ABSENT from localMirror, otherwise
    // the on-demand skip above short-circuits before the transport is touched.
    await writeFile(join(src, 'f.txt'), 'v4\n');
    await git(['add', '.'], src);
    await git(['commit', '-q', '-m', 'S4'], src);
    const s4 = await git(['rev-parse', 'HEAD'], src);
    await publishToPeer(s4, s3);
    // NB: use the raw runner, not the `git()` helper — that helper asserts
    // exit 0, and here a NONZERO exit is exactly what we're proving.
    expect((await defaultRunGit(['rev-parse', '--verify', '-q', `${s4}^{commit}`], localMirror)).code).not.toBe(0);

    const res = await handleStagingAdvance(
      {
        ...cfg(watermark),
        openDuplex: () => Promise.reject(new Error('swarm unreachable')),
      },
      await announce(1, 4, s4),
    );
    expect(res.outcome).toBe('fetch-failed');
  });

  it('without openDuplex the bridge serves from the local mirror (integrator-machine path)', async () => {
    // A SECOND machine-view: fresh worktree following the SAME local mirror
    // (which already holds s3 from the earlier fetch), no transport at all.
    const wt2 = join(root, 'wt2');
    await initWorktree(wt2);
    const res = await handleStagingAdvance(
      {
        bareRepoPath: localMirror,
        worktreePath: wt2,
        prior: { epochSeq: null, stagingSha: null },
        accept: { allowLegacy: true, expectedDevice: integrator.pubkeyBase64 },
      },
      await announce(1, 3, s3),
    );
    expect(res.outcome).toBe('accepted');
    if (res.outcome !== 'accepted') return;
    expect(res.advance.outcome, res.advance.detail).toBe('advanced');
    expect(await readFile(join(wt2, 'f.txt'), 'utf8')).toBe('v3\n');
  });

  it('a deferred-dirty advance is retried by the sweep via bridgeStagingShaToWorktree', async () => {
    const wt3 = join(root, 'wt3');
    await initWorktree(wt3);
    await writeFile(join(wt3, 'f.txt'), 'in the way\n'); // untracked, in the target tree
    const res = await handleStagingAdvance(
      {
        bareRepoPath: localMirror,
        worktreePath: wt3,
        prior: { epochSeq: null, stagingSha: null },
        accept: { allowLegacy: true, expectedDevice: integrator.pubkeyBase64 },
      },
      await announce(1, 3, s3),
    );
    expect(res.outcome).toBe('accepted');
    if (res.outcome !== 'accepted') return;
    expect(res.advance.outcome).toBe('deferred-dirty'); // watermark persisted anyway
    expect(await readFile(join(wt3, 'f.txt'), 'utf8')).toBe('in the way\n');

    // The dirt drains (autocommit / user removes it) → the sweep retries with
    // the persisted watermark sha and catches the worktree up.
    await rm(join(wt3, 'f.txt'));
    const retried = await bridgeStagingShaToWorktree(localMirror, wt3, integrator.pubkeyBase64, s3);
    expect(retried.outcome, retried.detail).toBe('advanced');
    expect(await readFile(join(wt3, 'f.txt'), 'utf8')).toBe('v3\n');
  });

  // WI-10003772 (P-505 run 25): the retry above was only ever reachable from a
  // NEW announcement, because the git-sync leg returned early on an idle tick.
  // A member that cleaned its dirt stayed on the old staging, and its next
  // commit landed on a stale base. The idle-tick sweep is catchUpWorktreeToWatermark.
  describe('catchUpWorktreeToWatermark (WI-10003772 idle-tick retry sweep)', () => {
    it('a deferred-dirty advance catches up once the dirt drains, with NO new announcement', async () => {
      const wt4 = join(root, 'wt4');
      await initWorktree(wt4);
      const accept = { allowLegacy: true, expectedDevice: integrator.pubkeyBase64 };
      const first = await handleStagingAdvance(
        { bareRepoPath: localMirror, worktreePath: wt4, prior: { epochSeq: null, stagingSha: null }, accept },
        await announce(1, 2, s2),
      );
      expect(first.outcome).toBe('accepted');
      if (first.outcome !== 'accepted') return;
      expect(first.advance.outcome, first.advance.detail).toBe('advanced');

      // Tracked dirt on the very file the next staging edits (the run-24 plant).
      await writeFile(join(wt4, 'f.txt'), 'local edit in progress\n');
      const second = await handleStagingAdvance(
        { bareRepoPath: localMirror, worktreePath: wt4, prior: first.watermark, accept },
        await announce(1, 3, s3),
      );
      expect(second.outcome).toBe('accepted');
      if (second.outcome !== 'accepted') return;
      expect(second.advance.outcome).toBe('deferred-dirty');

      // While still dirty, the sweep stays deferred and touches nothing.
      const whileDirty = await catchUpWorktreeToWatermark(localMirror, wt4, second.watermark.stagingSha);
      expect(whileDirty.outcome).toBe('deferred-dirty');
      expect(await git(['rev-parse', 'HEAD'], wt4)).toBe(s2);
      expect(await readFile(join(wt4, 'f.txt'), 'utf8')).toBe('local edit in progress\n');

      // The dirt is discarded (the drill's exit trap): the next idle tick advances.
      await git(['checkout', '--', 'f.txt'], wt4);
      const caught = await catchUpWorktreeToWatermark(localMirror, wt4, second.watermark.stagingSha);
      expect(caught.outcome, 'detail' in caught ? caught.detail : undefined).toBe('advanced');
      expect(await git(['rev-parse', 'HEAD'], wt4)).toBe(s3);
      expect(await readFile(join(wt4, 'f.txt'), 'utf8')).toBe('v3\n');

      // Steady state: the worktree contains the watermark, so the sweep is a
      // fetch-free `current`, not a repeated advance attempt.
      expect((await catchUpWorktreeToWatermark(localMirror, wt4, s3)).outcome).toBe('current');
      expect((await catchUpWorktreeToWatermark(localMirror, wt4, s2)).outcome).toBe('current');
    });

    it('fetches the canonical pin from the bare mirror when the worktree lacks the object (no device needed)', async () => {
      // refs/hive/staging in the BARE mirror is set by handleStagingAdvance step
      // 3.5 on every acceptance — s3 by now. A worktree that never saw s3 still
      // catches up with no announcing-device pubkey at all.
      expect(await git(['rev-parse', '--verify', WORKTREE_STAGING_REF], localMirror)).toBe(s3);
      const wt5 = join(root, 'wt5');
      await initWorktree(wt5);
      expect((await defaultRunGit(['cat-file', '-e', `${s3}^{commit}`], wt5)).code).not.toBe(0);
      const caught = await catchUpWorktreeToWatermark(localMirror, wt5, s3);
      expect(caught.outcome, 'detail' in caught ? caught.detail : undefined).toBe('advanced');
      expect(await readFile(join(wt5, 'f.txt'), 'utf8')).toBe('v3\n');
    });

    it('a diverged worktree is never rewound: the sweep reports diverged-manual and leaves HEAD alone', async () => {
      const wt6 = join(root, 'wt6');
      await initWorktree(wt6);
      await writeFile(join(wt6, 'own.txt'), 'mine\n');
      await git(['add', '.'], wt6);
      await git(['commit', '-q', '-m', 'unrelated local root'], wt6);
      const localHead = await git(['rev-parse', 'HEAD'], wt6);
      const r = await catchUpWorktreeToWatermark(localMirror, wt6, s3);
      expect(r.outcome).toBe('diverged-manual');
      expect(await git(['rev-parse', 'HEAD'], wt6)).toBe(localHead);
    });

    // WI-10006476 / plan agent-capacity-and-cost-gcp-2026-09-30 D-055 (S6, P-525):
    // a member whose own commit conflicts with the hive head stays forked forever,
    // because the integrator parks it and this ff-only sweep cannot follow. The
    // sweep must NAME the conflicting paths so git-sync can persist and log the fork.
    async function divergedFromS2(name: string, file: string, body: string): Promise<{ wt: string; head: string }> {
      const wt = join(root, name);
      await initWorktree(wt);
      const seeded = await catchUpWorktreeToWatermark(localMirror, wt, s2);
      expect(seeded.outcome, 'detail' in seeded ? seeded.detail : undefined).toBe('advanced');
      await writeFile(join(wt, file), body);
      await git(['add', '.'], wt);
      await git(['commit', '-q', '-m', `member edit ${file}`], wt);
      return { wt, head: await git(['rev-parse', 'HEAD'], wt) };
    }

    it('D-055: a diverged worktree whose commit CONFLICTS with the hive head reports the conflicting paths', async () => {
      const { wt, head } = await divergedFromS2('wt8', 'f.txt', 'member edit of the same line\n');
      const r = await catchUpWorktreeToWatermark(localMirror, wt, s3);
      expect(r.outcome).toBe('diverged-manual');
      expect('conflictPaths' in r ? r.conflictPaths : undefined).toEqual(['f.txt']);
      // The probe never touches the worktree: HEAD, index and file are as committed.
      expect(await git(['rev-parse', 'HEAD'], wt)).toBe(head);
      expect(await git(['status', '--porcelain'], wt)).toBe('');
      expect(await readFile(join(wt, 'f.txt'), 'utf8')).toBe('member edit of the same line\n');
    });

    it('D-055: a diverged worktree that merges CLEANLY reports no conflicting paths (the integrator merges it)', async () => {
      const { wt, head } = await divergedFromS2('wt9', 'own.txt', 'member-only file\n');
      const r = await catchUpWorktreeToWatermark(localMirror, wt, s3);
      expect(r.outcome).toBe('diverged-manual');
      expect('conflictPaths' in r ? r.conflictPaths : undefined).toEqual([]);
      expect(await git(['rev-parse', 'HEAD'], wt)).toBe(head);
      expect(await git(['status', '--porcelain'], wt)).toBe('');
    });

    it('a mirror without the canonical pin is a typed error, never a throw', async () => {
      const bare = join(root, 'empty-mirror.git');
      await mkdir(bare, { recursive: true });
      await git(['init', '-q', '--bare'], bare);
      const wt7 = join(root, 'wt7');
      await initWorktree(wt7);
      const r = await catchUpWorktreeToWatermark(bare, wt7, s3);
      expect(r.outcome).toBe('error');
    });
  });
});
