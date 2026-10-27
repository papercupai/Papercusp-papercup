/**
 * fetch-transport.integration.test.ts — G-2 native git protocol-v2 fetch over a
 * duplex, end to end with REAL bare repos + REAL upload-pack/fetch (git on PATH,
 * no network, no swarm). The duplex is a plain unix-socket connection standing in
 * for a per-fetch Protomux sub-stream, so the whole transport path runs offline:
 *
 *   git fetch (client) → ext bridge → unix sock → clientConn ⇄ srvConn →
 *   serveUploadPack → git upload-pack (server).
 *
 * Run: cd packages/operator-core && npx vitest run --config vitest.integration.config.ts lib/sync/pot-git/fetch-transport.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, copyFile, symlink } from 'node:fs/promises';
import { execFile, execFileSync } from 'node:child_process';
import {
  defaultRunGit,
  ensurePotGitRepo,
  writeNamespaceRef,
  readNamespaceRef,
  deleteNamespaceRef,
} from './storage';
import {
  serveUploadPack,
  fetchOverDuplex,
  fetchPeerNamespace,
  peerNamespaceRefspec,
  formatExtTransportUrl,
  extNodeCommand,
} from './fetch-transport';

function devicePubkey(): string {
  const { publicKey } = generateKeyPairSync('ed25519');
  const spki = (publicKey as KeyObject).export({ format: 'der', type: 'spki' }) as Buffer;
  return spki.subarray(spki.length - 32).toString('base64');
}

async function mintCommit(repoPath: string, msg: string): Promise<string> {
  const tree = await defaultRunGit(['hash-object', '-w', '-t', 'tree', '/dev/null'], repoPath);
  expect(tree.code, tree.stderr).toBe(0);
  const c = await defaultRunGit(
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', tree.stdout.trim(), '-m', msg],
    repoPath,
  );
  expect(c.code, c.stderr).toBe(0);
  return c.stdout.trim();
}

/** Stand up a unix-socket "link": each `connect` yields a duplex whose peer end
 *  is handed to serveUploadPack against `serverRepo`. Returns a connect() that
 *  gives the CLIENT-side duplex. */
function makeLink(serverRepo: string, sockPath: string): { server: Server; dialClient: () => Promise<Socket> } {
  // allowHalfOpen:true on BOTH ends — the duplex must survive a one-directional
  // FIN so the in-band-delimited pack flushes fully (see fetch-transport.ts).
  const server = createServer({ allowHalfOpen: true }, (srvConn) => {
    srvConn.on('error', () => {});
    void serveUploadPack(serverRepo, srvConn);
  });
  return {
    server,
    dialClient: () =>
      new Promise<Socket>((resolve, reject) => {
        const s = connect({ path: sockPath, allowHalfOpen: true });
        s.once('connect', () => resolve(s));
        s.once('error', reject);
      }),
  };
}

describe('pot-git fetch transport (real upload-pack ↔ fetch over a duplex)', () => {
  let root: string;
  let serverRepo: string;
  let clientRepo: string;
  let sockPath: string;
  let server: Server;
  let dialClient: () => Promise<Socket>;
  const devA = devicePubkey();
  let workSha = '';

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'hgxport-'));
    process.env.PAPERCUSP_HIVE_GIT_ROOT = root;
    serverRepo = await ensurePotGitRepo('hive-x', 'repo-1');
    clientRepo = await ensurePotGitRepo('hive-x', 'repo-1-mirror');
    // The server (device A) writes a commit into its OWN namespace.
    workSha = await mintCommit(serverRepo, 'A work 1');
    await writeNamespaceRef(serverRepo, devA, 'refs/heads/work', workSha);
    sockPath = join(root, 'link.sock');
    const link = makeLink(serverRepo, sockPath);
    server = link.server;
    dialClient = link.dialClient;
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

  it('peerNamespaceRefspec forces the peer namespace subtree onto itself', () => {
    const rs = peerNamespaceRefspec(devA);
    expect(rs.startsWith('+refs/namespaces/')).toBe(true);
    const hex = rs.slice(1).split(':')[0].replace('/*', '');
    expect(rs).toBe(`+${hex}/*:${hex}/*`);
  });

  it('fetches a peer device namespace into the local mirror (objects + ref transfer)', async () => {
    // The mirror has nothing yet.
    expect(await readNamespaceRef(clientRepo, devA, 'refs/heads/work')).toBeNull();
    const conn = await dialClient();
    const res = await fetchPeerNamespace(clientRepo, conn, devA, { timeoutMs: 30_000 });
    expect(res.stderr).not.toMatch(/timed out/);
    expect(res.code, res.stderr).toBe(0);
    // The namespace ref + its object are now in the mirror's ODB.
    expect(await readNamespaceRef(clientRepo, devA, 'refs/heads/work')).toBe(workSha);
    const cat = await defaultRunGit(['cat-file', '-e', workSha], clientRepo);
    expect(cat.code).toBe(0);
  });

  it('an advanced peer head incrementally fetches (only the new commit)', async () => {
    // Advance A's namespace head to a child commit.
    const child = await defaultRunGit(
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit-tree', `${workSha}^{tree}`, '-p', workSha, '-m', 'A work 2'],
      serverRepo,
    );
    expect(child.code, child.stderr).toBe(0);
    const sha2 = child.stdout.trim();
    await writeNamespaceRef(serverRepo, devA, 'refs/heads/work', sha2, defaultRunGit, workSha);
    const conn = await dialClient();
    const res = await fetchOverDuplex(clientRepo, conn, [peerNamespaceRefspec(devA)], { timeoutMs: 30_000 });
    expect(res.code, res.stderr).toBe(0);
    expect(await readNamespaceRef(clientRepo, devA, 'refs/heads/work')).toBe(sha2);
  });

  it('WI-39953: authoritative peer fetch prunes a receiver-only stale namespace ref', async () => {
    const staleSha = await mintCommit(serverRepo, 'handoff that the peer later deleted');
    await writeNamespaceRef(serverRepo, devA, 'refs/rad/handoff', staleSha);

    const initial = await fetchPeerNamespace(clientRepo, await dialClient(), devA, { timeoutMs: 30_000 });
    expect(initial.code, initial.stderr).toBe(0);
    expect(await readNamespaceRef(clientRepo, devA, 'refs/rad/handoff')).toBe(staleSha);

    // Negative control: after the authoritative peer deletes the ref, the
    // receiver still has the exact stale state that broke strict Phase A.
    await deleteNamespaceRef(serverRepo, devA, 'refs/rad/handoff');
    expect(await readNamespaceRef(serverRepo, devA, 'refs/rad/handoff')).toBeNull();
    expect(await readNamespaceRef(clientRepo, devA, 'refs/rad/handoff')).toBe(staleSha);

    const refreshed = await fetchPeerNamespace(clientRepo, await dialClient(), devA, { timeoutMs: 30_000 });
    expect(refreshed.code, refreshed.stderr).toBe(0);
    expect(await readNamespaceRef(clientRepo, devA, 'refs/rad/handoff')).toBeNull();
    // Pruning is scoped to the fetched peer namespace and leaves refs that the
    // peer still advertises intact.
    expect(await readNamespaceRef(clientRepo, devA, 'refs/heads/work')).toBe(
      await readNamespaceRef(serverRepo, devA, 'refs/heads/work'),
    );
  });

  /**
   * EI-18765930091826096 recurrence guard: fetchOverDuplex OWNS the duplex.
   *
   * The ABANDONED path is the only one that distinguishes this, which is exactly
   * why the leak survived so long. On a HEALTHY fetch both halves of the duplex
   * are ended by the pipes anyway (the peer's end-frame ends the readable side,
   * `conn.pipe(duplex)` ends the writable side), so node auto-destroys it and an
   * `expect(duplex.destroyed)` there passes with the release REVERTED — a
   * vacuous assertion, confirmed by mutation testing.
   *
   * Here nothing ever answers, so the ceiling is the only thing that can settle
   * the fetch and NOTHING else can end the duplex. In production that duplex is
   * a pot-git FrameDuplex whose write-end sends the `end` frame that reaps the
   * peer's `git upload-pack`, and whose close releases the session that would
   * otherwise keep absorbing the peer's pack forever.
   */
  it('EI-18765930091826096: a fetch that gives up RELEASES its duplex (the peer must be told, or its upload-pack never stops)', async () => {
    const stalled = new PassThrough();
    const res = await fetchOverDuplex(clientRepo, stalled, [peerNamespaceRefspec(devA)], {
      timeoutMs: 750,
    });
    expect(res.timedOut, res.stderr).toBe(true);
    // Ending the write side is what reaches the peer; destroying is what frees
    // the session. Assert both, since they fix different halves of the leak.
    expect(stalled.writableEnded, 'the peer was never told we gave up').toBe(true);
    await vi.waitFor(() => expect(stalled.destroyed, 'the duplex was never released').toBe(true), {
      timeout: 5_000,
    });
  });

  /**
   * WI-37735 recurrence guard — the ONE end-to-end proof, because the dev tree
   * can never expose this bug on its own.
   *
   * The client half hands git an `ext::` command line, and git splits it on
   * UNESCAPED spaces. The bridge script lives beside fetch-transport.ts, so its
   * path is space-free in this repo and space-BEARING on every real macOS
   * install (`/Applications/Papercusp GUI.app/…`). 0.0.14 shipped with the
   * unescaped form and every ref-announce receive-fetch on macOS died
   * `Cannot find module '/Applications/Papercusp'`.
   *
   * The negative control is the load-bearing half: without it this test passes
   * with the escaping reverted, since nothing else here has a space in its path
   * — which is exactly how the defect reached users.
   */
  it('WI-37735: fetches through a bridge whose path contains a space (and the unescaped form still breaks)', async () => {
    const spacedDir = join(root, 'Papercusp GUI.app', 'Contents', 'Resources', 'sidecar');
    await mkdir(spacedDir, { recursive: true });
    const spacedBridge = join(spacedDir, 'git-ext-bridge.mjs');
    await copyFile(join(dirname(fileURLToPath(import.meta.url)), 'git-ext-bridge.mjs'), spacedBridge);

    const mirror = await ensurePotGitRepo('hive-x', 'repo-1-spaced-mirror');
    const head = await readNamespaceRef(serverRepo, devA, 'refs/heads/work');
    expect(head, 'server namespace head must exist for this fetch to mean anything').toBeTruthy();
    expect(await readNamespaceRef(mirror, devA, 'refs/heads/work')).toBeNull();

    const gitFetch = (url: string) =>
      defaultRunGit(
        [
          '-c',
          'protocol.ext.allow=always',
          '-c',
          'protocol.version=2',
          'fetch',
          '--no-write-fetch-head',
          url,
          peerNamespaceRefspec(devA),
        ],
        mirror,
        // Match fetchOverDuplex's plain-interpreter protocol boundary. An
        // inherited test loader can otherwise fail in git's temporary GIT_DIR
        // before the negative control reaches the unescaped script path.
        { timeoutMs: 30_000, env: { NODE_OPTIONS: '', BUN_OPTIONS: '', TSX_TSCONFIG_PATH: '' } },
      );

    // NEGATIVE CONTROL: the exact string 0.0.14 shipped.
    const unescaped = await gitFetch(`ext::node ${spacedBridge} ${sockPath}`);
    expect(unescaped.code, 'the unescaped form must still fail, or this test proves nothing').not.toBe(0);
    expect(unescaped.stderr).toMatch(/Cannot find module/);
    expect(await readNamespaceRef(mirror, devA, 'refs/heads/work')).toBeNull();

    // THE FIX: same paths, escaped for git.
    const escaped = await gitFetch(formatExtTransportUrl(['node', spacedBridge, sockPath]));
    expect(escaped.code, escaped.stderr).toBe(0);
    expect(escaped.stderr).not.toMatch(/Cannot find module/);
    expect(await readNamespaceRef(mirror, devA, 'refs/heads/work')).toBe(head);
  });

  /**
   * EI-20078551747038927: the ext:: INTERPRETER token must be an absolute path.
   *
   * git execs the ext command itself, inheriting whatever PATH the sidecar
   * carries — and a packaged install is not guaranteed to have node on it at
   * all. On the macOS 0.0.14 VM a non-interactive shell had NO node
   * (`node: command not found`) while the app was running its own bundled
   * runtime at `…/Contents/Resources/sidecar/bin/node`.
   *
   * The node-less PATH is the load-bearing half: every other test here runs on
   * a dev box that HAS node, so a bare `node` token passes them all — which is
   * exactly how this survives review. Removing the negative control makes this
   * test pass with the fix reverted.
   */
  it('EI-20078551747038927: fetches with NO node on PATH (and the bare-`node` token still breaks)', async () => {
    // A PATH carrying git (+sh) but deliberately NOT node.
    const binDir = join(root, 'nodeless-bin');
    await mkdir(binDir, { recursive: true });
    const gitPath = execFileSync('sh', ['-c', 'command -v git']).toString().trim();
    await symlink(gitPath, join(binDir, 'git'));
    await symlink(execFileSync('sh', ['-c', 'command -v sh']).toString().trim(), join(binDir, 'sh'));

    // The packaged layout main.rs exports: $PAPERCUSP_SIDECAR_BIN/node.
    const sidecarBin = join(root, 'Papercusp GUI.app', 'Contents', 'Resources', 'sidecar', 'bin');
    await mkdir(sidecarBin, { recursive: true });
    await symlink(process.execPath, join(sidecarBin, 'node'));

    const bridge = join(dirname(fileURLToPath(import.meta.url)), 'git-ext-bridge.mjs');
    const mirror = await ensurePotGitRepo('hive-x', 'repo-1-nodeless-mirror');
    const head = await readNamespaceRef(serverRepo, devA, 'refs/heads/work');
    expect(head, 'server namespace head must exist for this fetch to mean anything').toBeTruthy();
    expect(await readNamespaceRef(mirror, devA, 'refs/heads/work')).toBeNull();

    const fetchWithoutNodeOnPath = (url: string) =>
      new Promise<{ code: number; stderr: string }>((resolve) => {
        execFile(
          gitPath,
          [
            '-c',
            'protocol.ext.allow=always',
            '-c',
            'protocol.version=2',
            'fetch',
            '--no-write-fetch-head',
            url,
            peerNamespaceRefspec(devA),
          ],
          { cwd: mirror, env: { ...process.env, PATH: binDir, NODE_OPTIONS: '', BUN_OPTIONS: '',
            TSX_TSCONFIG_PATH: '' }, timeout: 30_000 },
          (err, _stdout, stderr) =>
            resolve({ code: err ? Number((err as NodeJS.ErrnoException).code ?? 1) : 0, stderr: String(stderr) }),
        );
      });

    // NEGATIVE CONTROL: the bare `node` token — the form that shipped.
    const bare = await fetchWithoutNodeOnPath(formatExtTransportUrl(['node', bridge, sockPath]));
    expect(bare.code, 'a bare `node` must fail with no node on PATH, or this test proves nothing').not.toBe(0);
    // ...and fail for the RIGHT reason: the interpreter, not some unrelated breakage.
    expect(bare.stderr, `expected a node-resolution failure, got: ${bare.stderr}`).toMatch(/node/i);
    expect(await readNamespaceRef(mirror, devA, 'refs/heads/work')).toBeNull();

    // THE FIX, through the REAL call site: fetchOverDuplex builds the ext:: URL
    // itself, so scrubbing PATH here (git inherits our env) is what pins line-759
    // behaviour. Reverting that token to a bare `node` fails THIS assertion —
    // asserting on extNodeCommand() alone would not, since the call site could
    // still hardcode `node` and pass.
    vi.stubEnv('PATH', binDir);
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', sidecarBin);
    let fixed: { code: number; stderr: string };
    try {
      expect(await extNodeCommand()).toBe(join(sidecarBin, 'node'));
      const conn = await dialClient();
      fixed = await fetchOverDuplex(mirror, conn, [peerNamespaceRefspec(devA)], { timeoutMs: 30_000 });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(fixed.code, fixed.stderr).toBe(0);
    expect(await readNamespaceRef(mirror, devA, 'refs/heads/work')).toBe(head);
  }, 60_000);

  it('serveUploadPack refuses a repo outside the pot-git root (defense in depth)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'hgoutside-'));
    try {
      // A throwaway duplex — the guard should fire before any git runs.
      const res = await serveUploadPack(outside, new PassThrough());
      expect(res.code).toBe(-1);
      expect(res.stderr).toMatch(/outside the pot-git root/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
