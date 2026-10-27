/**
 * fetch-transport unit tests — the §5.3 scope-repo serve chokepoint (P-108 /
 * D-018 option b): a path in the scopes/ family is UNSERVABLE without a
 * gate-issued grant bound to that exact path. Refusals resolve pre-spawn
 * (code -1) with the reason in stderr; a genuine grant opens the gate.
 * (Full serve/fetch byte-stream coverage lives in
 * fetch-transport.integration.test.ts — this file only exercises the guard.)
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Duplex, PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { serveUploadPack, fetchOverDuplex, formatExtTransportUrl, extNodeCommand } from './fetch-transport';
import { scopeRepoPath, type ScopeId } from './scope-repo';
import { authorizeScopeRepoServe } from './scope-serve-gate';

const SCOPE: ScopeId = { kind: 'fleet', ownerGithubUserId: 9603, slug: 'p006-rig-fleet' };
const PEER = 279242982;
const REFUSAL_MARK = 'roster-verified serve grant';

const OLD_ROOT = process.env.PAPERCUSP_HIVE_GIT_ROOT;
let tmpRoot: string | null = null;
afterEach(() => {
  if (OLD_ROOT === undefined) delete process.env.PAPERCUSP_HIVE_GIT_ROOT;
  else process.env.PAPERCUSP_HIVE_GIT_ROOT = OLD_ROOT;
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
  tmpRoot = null;
});

function freshRoot(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), 'hg-serve-gate-'));
  process.env.PAPERCUSP_HIVE_GIT_ROOT = tmpRoot;
  return tmpRoot;
}

/**
 * WI-6184: the fetch timeout message must be SELF-DIAGNOSING.
 *
 * A bare "fetch timed out after 120000ms" cannot distinguish the two failures
 * that produce it, and they have OPPOSITE causes:
 *   peer→us 0B   ⇒ the serving side answered NOTHING (a swallowed throw, a
 *                  refusal that never sent its frame, a req never received) —
 *                  investigate the PEER.
 *   peer→us > 0  ⇒ the peer answered and the stream then stalled — investigate
 *                  the TRANSPORT.
 * On the 2-machine rig every cold-join burned the full 120s ceiling reporting
 * only the bare form, which is why the cause stayed invisible across five
 * diagnosis wakes. This asserts the forensic tail is present and correct.
 *
 * A LIVE-but-silent duplex is the deliberate fixture: it must NOT be destroyed
 * (that path fail-fasts by design and would never reach the ceiling), so the
 * write callback is invoked while nothing is ever pushed back. `timedOut` is
 * asserted UNCONDITIONALLY — an `if (res.timedOut)` guard here would let the
 * test pass vacuously if the fetch ever stopped timing out.
 */
describe('fetchOverDuplex — timeout forensics', () => {
  it('names what it was waiting on when a live-but-silent peer never answers', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'hg-fetch-timeout-'));
    try {
      execFileSync('git', ['init', '--quiet', '--bare', repo]);
      // Alive, writable, never readable: the peer that accepts our request and
      // says nothing back.
      const silent = new Duplex({
        read() {},
        write(_chunk, _enc, cb) {
          cb();
        },
      });
      const res = await fetchOverDuplex(repo, silent, ['+refs/heads/work:refs/heads/never'], {
        timeoutMs: 4_000,
      });
      expect(res.timedOut, `expected the ceiling to fire; got: ${res.stderr}`).toBe(true);
      expect(res.code).toBe(-1);
      // The forensic tail — each field, so a partial regression is caught.
      expect(res.stderr).toMatch(/fetch timed out after 4000ms/);
      expect(res.stderr).toMatch(/us→peer \d+B/);
      expect(res.stderr).toMatch(/bridge=(yes|no)/);
      expect(res.stderr).toMatch(/gitChild=(spawned|none)/);
      // The load-bearing assertion: this peer sent nothing, and the message
      // must say so rather than leaving the reader to guess.
      expect(res.stderr).toMatch(/peer→us 0B/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('serveUploadPack — scope-repo serve gate', () => {
  it('refuses a scope-family path with NO grant (pre-spawn, code -1)', async () => {
    freshRoot();
    const res = await serveUploadPack(scopeRepoPath('my-hive', SCOPE), new PassThrough());
    expect(res.code).toBe(-1);
    expect(res.stderr).toContain(REFUSAL_MARK);
  });

  it('refuses a MALFORMED path inside the scopes/ family (gate is broader than the parse)', async () => {
    const root = freshRoot();
    const res = await serveUploadPack(
      join(root, 'my-hive', 'scopes', 'oops', 'x.git'),
      new PassThrough(),
    );
    expect(res.code).toBe(-1);
    expect(res.stderr).toContain(REFUSAL_MARK);
  });

  it('refuses a forged grant object (right fields, wrong mint)', async () => {
    freshRoot();
    const repoPath = scopeRepoPath('my-hive', SCOPE);
    const res = await serveUploadPack(repoPath, new PassThrough(), {
      scopeServeGrant: { repoPath, scopeId: 'fleet:9603/p006-rig-fleet', peerGithubUserId: PEER },
    });
    expect(res.code).toBe(-1);
    expect(res.stderr).toContain(REFUSAL_MARK);
  });

  it('refuses a genuine grant bound to a DIFFERENT scope repo', async () => {
    freshRoot();
    const other = await authorizeScopeRepoServe({
      repoPath: scopeRepoPath('my-hive', { kind: 'fleet', ownerGithubUserId: 9603, slug: 'other' }),
      peerGithubUserId: PEER,
      isScopeMember: () => true,
    });
    if (!other.ok) throw new Error('setup grant failed');
    const res = await serveUploadPack(scopeRepoPath('my-hive', SCOPE), new PassThrough(), {
      scopeServeGrant: other.grant,
    });
    expect(res.code).toBe(-1);
    expect(res.stderr).toContain(REFUSAL_MARK);
  });

  it('a genuine matching grant passes the gate (any failure is from git, not the guard)', async () => {
    freshRoot();
    const repoPath = scopeRepoPath('my-hive', SCOPE);
    const d = await authorizeScopeRepoServe({
      repoPath,
      peerGithubUserId: PEER,
      isScopeMember: () => true,
    });
    if (!d.ok) throw new Error('grant refused in setup');
    const duplex = new PassThrough();
    duplex.end(); // repo does not exist — upload-pack exits on its own
    const res = await serveUploadPack(repoPath, duplex, { scopeServeGrant: d.grant });
    expect(res.stderr).not.toContain(REFUSAL_MARK);
  });

  it('a NON-scope repo under the root serves without any grant (gate does not over-trigger)', async () => {
    const root = freshRoot();
    const duplex = new PassThrough();
    duplex.end();
    const res = await serveUploadPack(join(root, 'my-hive', 'repo.git'), duplex);
    expect(res.stderr).not.toContain(REFUSAL_MARK);
  });

  it('runs the upload-pack lifetime through the supplied governed execution seam', async () => {
    const root = freshRoot();
    const repoPath = join(root, 'my-hive', 'governed.git');
    mkdirSync(repoPath, { recursive: true });
    execFileSync('git', ['init', '--quiet', '--bare', repoPath]);
    const duplex = new PassThrough();
    duplex.end();
    const events: string[] = [];
    const res = await serveUploadPack(repoPath, duplex, {
      governedExecution: async (run) => {
        events.push('admit');
        const result = await run();
        events.push('release');
        return result;
      },
    });
    expect(events).toEqual(['admit', 'release']);
    // The empty request is intentionally not a protocol success; this test is
    // about wrapper ordering, so only assert that the transport settled with
    // its normal typed result rather than rejecting.
    expect(typeof res.code).toBe('number');
  });
});

describe('fetchOverDuplex — pre-destroyed duplex (WI-3496)', () => {
  it('fails fast (code -1) on an already-destroyed duplex instead of hanging to the ceiling', async () => {
    // The openHiveGitDuplexToDevice "no live dial path" contract hands callers
    // a duplex whose 'error' already fired into its own no-op listener ticks
    // before fetchOverDuplex could attach one — the sync .destroyed check must
    // catch it, or the fetch burns the full outer timeout (live-observed 120s
    // per G-8 bootstrap tick on the rig).
    const { fetchOverDuplex } = await import('./fetch-transport');
    const dead = new PassThrough();
    dead.on('error', () => {});
    dead.destroy(new Error('no live connection to device xyz'));
    const started = Date.now();
    const res = await fetchOverDuplex('/nonexistent/repo.git', dead, ['+refs/*:refs/*'], {
      timeoutMs: 10_000,
    });
    expect(res.code).toBe(-1);
    expect(res.timedOut).toBe(false);
    expect(res.stderr).toContain('duplex already destroyed before fetch began');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('names the stub REASON it was destroyed with, not a generic "no live dial path"', async () => {
    // Every dial leg destroys its fail-soft stub with a distinct reason; the
    // transport must surface it or a dead registry, a backoff skip and a
    // missing swarm join all print identically (the P-203 rig stall).
    const { fetchOverDuplex } = await import('./fetch-transport');
    const dead = new PassThrough();
    dead.on('error', () => {});
    dead.destroy(new Error('no-such-repo backoff: dcJWGlbQ definitively refused gh-1; next dial in 1700s'));
    const res = await fetchOverDuplex('/nonexistent/repo.git', dead, ['+refs/*:refs/*'], {
      timeoutMs: 10_000,
    });
    expect(res.code).toBe(-1);
    expect(res.stderr).toContain(
      'duplex already destroyed before fetch began (no-such-repo backoff: dcJWGlbQ definitively refused gh-1; next dial in 1700s)',
    );
    expect(res.stderr).not.toContain('(no live dial path)');
  });

  it('falls back to "no live dial path" when the stub carried no reason', async () => {
    const { fetchOverDuplex } = await import('./fetch-transport');
    const dead = new PassThrough();
    dead.on('error', () => {});
    dead.destroy();
    const res = await fetchOverDuplex('/nonexistent/repo.git', dead, ['+refs/*:refs/*'], {
      timeoutMs: 10_000,
    });
    expect(res.code).toBe(-1);
    expect(res.stderr).toContain('duplex already destroyed before fetch began (no live dial path)');
  });
});

/**
 * WI-37735 — the ext:: command line is SPACE-SPLIT by git.
 *
 * These assert the escaping RULES; that git actually reconstructs the tokens
 * from them is proved end-to-end (real `git fetch`, real upload-pack, bridge
 * under a directory whose name has a space) in fetch-transport.integration.test.ts.
 * Both halves are needed: this file cannot prove git agrees with us, and the
 * integration test alone would not pin the percent-first ordering.
 */
describe('formatExtTransportUrl — git ext:: token escaping (WI-37735)', () => {
  it('leaves space-free tokens exactly as they were', () => {
    expect(formatExtTransportUrl(['node', '/opt/pc/git-ext-bridge.mjs', '/tmp/x/s.sock'])).toBe(
      'ext::node /opt/pc/git-ext-bridge.mjs /tmp/x/s.sock',
    );
  });

  it("escapes a space inside a token as git's literal-space sequence '% '", () => {
    // The exact shape that shipped broken: the packaged macOS app's own path.
    const bridge = '/Applications/Papercusp GUI.app/Contents/Resources/sidecar/git-ext-bridge.mjs';
    const url = formatExtTransportUrl(['node', bridge, '/tmp/s.sock']);
    expect(url).toBe(
      'ext::node /Applications/Papercusp% GUI.app/Contents/Resources/sidecar/git-ext-bridge.mjs /tmp/s.sock',
    );
    // Splitting on UNESCAPED spaces (what git does) must yield 3 tokens, not 4.
    expect(splitExtCommandLikeGit(url.slice('ext::'.length))).toEqual([
      'node',
      bridge,
      '/tmp/s.sock',
    ]);
  });

  it('escapes percent BEFORE space, so a literal % can never forge an escape', () => {
    // '%' first: ' ' -> '% ' would otherwise be re-escaped into '%% '.
    expect(formatExtTransportUrl(['a b'])).toBe('ext::a% b');
    expect(formatExtTransportUrl(['100%'])).toBe('ext::100%%');
    // A path that literally contains git's own escape sequences round-trips.
    const nasty = '/tmp/od%d 50%/%s %G bridge.mjs';
    const url = formatExtTransportUrl(['node', nasty]);
    expect(splitExtCommandLikeGit(url.slice('ext::'.length))).toEqual(['node', nasty]);
  });

  it('never emits a bare % that git would read as a %s/%S/%G/%V directive', () => {
    const url = formatExtTransportUrl(['node', '/tmp/%s%G%V/bridge.mjs']);
    // Every % in the output is part of '%%' or '% ' — no directive survives.
    expect(url.replace(/%%/g, '').replace(/% /g, '')).not.toContain('%');
  });
});

/**
 * EI-20078551747038927 — the interpreter token must be an ABSOLUTE path.
 *
 * git execs the ext:: command with whatever PATH the sidecar carries, and on a
 * packaged install that is not guaranteed to contain node at all (observed on
 * the macOS 0.0.14 VM: `node: command not found` in a non-interactive shell
 * while the app ran its own bundled runtime). The fetch fail-softs by contract,
 * so getting this wrong is silent — hence a direct guard rather than relying on
 * the integration test, which passes either way on a dev box that HAS node.
 */
describe('extNodeCommand — the ext:: interpreter token (EI-20078551747038927)', () => {
  const origExecPath = process.execPath;
  let tmp: string | null = null;

  afterEach(() => {
    process.execPath = origExecPath;
    vi.unstubAllEnvs();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  function touch(p: string): string {
    mkdirSync(dirname(p), { recursive: true });
    symlinkSync(origExecPath, p);
    return p;
  }

  it('resolves the bundled node to an absolute path — never the bare `node` that shipped', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'extnode-'));
    const sidecarBin = join(tmp, 'Papercusp GUI.app', 'Contents', 'Resources', 'sidecar', 'bin');
    const bundled = touch(join(sidecarBin, 'node'));
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', sidecarBin);

    const cmd = await extNodeCommand();
    expect(cmd).toBe(bundled);
    expect(cmd).not.toBe('node');
  });

  it('the resolved token survives git ext:: parsing even with a space in the install path', async () => {
    // The two fixes compose: WI-37735 escapes the token, this one makes it absolute.
    tmp = mkdtempSync(join(tmpdir(), 'extnode-'));
    const sidecarBin = join(tmp, 'Papercusp GUI.app', 'Contents', 'Resources', 'sidecar', 'bin');
    const bundled = touch(join(sidecarBin, 'node'));
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', sidecarBin);

    const url = formatExtTransportUrl([await extNodeCommand(), '/tmp/x/bridge.mjs', '/tmp/x/s.sock']);
    expect(splitExtCommandLikeGit(url.slice('ext::'.length))).toEqual([
      bundled,
      '/tmp/x/bridge.mjs',
      '/tmp/x/s.sock',
    ]);
  });

  it('refuses an unmeasured PATH fallback when no retained Node is visible', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'extnode-'));
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', '');
    // PATH may contain Bun named node. Neither that token nor the desktop
    // executable establishes the explicit retained Node boundary.
    process.execPath = touch(join(tmp, 'MacOS', 'papercusp-desktop'));

    await expect(extNodeCommand()).rejects.toThrow(/retained Node/);
  });

  it('returns a fail-soft fetch refusal before spawning git when retained Node is absent', async () => {
    tmp = mkdtempSync(join(tmpdir(), 'extnode-'));
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', '');
    process.execPath = touch(join(tmp, 'MacOS', 'papercusp-desktop'));
    const silent = new Duplex({ read() {}, write(_chunk, _enc, cb) { cb(); } });

    const result = await fetchOverDuplex(tmp, silent, ['+refs/heads/work:refs/heads/test'], {
      timeoutMs: 2_000,
    });
    expect(result.code).toBe(-1);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toMatch(/retained Node/);
    silent.destroy();
  });
});

/**
 * Reference decoder for git's ext:: command parsing (git-remote-ext(1)): split
 * on UNESCAPED spaces, with '% ' a literal space and '%%' a literal percent.
 * Deliberately written from the manpage rather than from the escaper, so the
 * tests above are a round-trip against the SPEC and not against themselves.
 */
function splitExtCommandLikeGit(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '%' && cmd[i + 1] === ' ') {
      cur += ' ';
      i++;
    } else if (c === '%' && cmd[i + 1] === '%') {
      cur += '%';
      i++;
    } else if (c === ' ') {
      out.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}
