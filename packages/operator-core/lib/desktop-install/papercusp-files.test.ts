/**
 * papercusp-files.test.ts — resolveShimNode, the node-binary resolver the psu /
 * dispatcher CLI shims exec (writeShim + writeDispatcherShim).
 *
 * Regression guard for WI-3334: on a packaged dogfood install with NO system
 * node, the psu shim execed bare `node` → "node not found". The launcher
 * resolved into the EXTRACTED dev-source tree
 * (`<dev-source>/apps/operator/scripts/psu-launcher.mjs`), whose grandparent has
 * no `bin/node`, AND installPapercuspFiles does NOT run with cwd = the sidecar
 * dir — so BOTH the launcher-adjacent and the cwd anchor missed and the shim
 * fell back to bare `node` (confirmed live on the Linux dogfood VM). The fix adds
 * two cwd-independent anchors that both point at the bundled node regardless of
 * cwd: `$PAPERCUSP_SIDECAR_BIN/node` and `process.execPath`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveShimNode,
  ensureBundledNodeLinked,
  ensureGhLinked,
  repairPapercuspGitCredentialHelpers,
  ensureAgentClisLinked,
  ensurePythonCompatibilityLinked,
  CC_HOOK_FILES,
  type GitConfigRunner,
} from './papercusp-files';

it('ships the managed Codex PreCompact bridge in the CC hook allowlist', () => {
  expect(CC_HOOK_FILES).toContain('precompact-managed-carry.mjs');
});

let tmp: string;
let origExecPath: string;

/** Create an empty file (its parent dirs too) so fs.access / pathExists sees it. */
async function touch(p: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, '');
}
/** process.execPath is a writable string; override it (restored in afterEach). */
function setExecPath(p: string): void {
  process.execPath = p;
}
/** Neutralize the two cwd-independent anchors so a test can exercise the path anchors. */
function disableBundledAnchors(): void {
  vi.stubEnv('PAPERCUSP_SIDECAR_BIN', ''); // falsy → anchor 1 skipped
  setExecPath(path.join(tmp, 'no-such', 'notnode')); // basename !== node → anchor 2 skipped
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'shim-node-'));
  origExecPath = process.execPath;
});
afterEach(async () => {
  setExecPath(origExecPath);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('resolveShimNode', () => {
  it('anchor 1: uses $PAPERCUSP_SIDECAR_BIN/node when set and present (packaged canonical)', async () => {
    const sidecarBin = path.join(tmp, 'sidecar', 'bin');
    const bundled = path.join(sidecarBin, 'node');
    await touch(bundled);
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', sidecarBin);
    setExecPath(path.join(tmp, 'other', 'node')); // exists=no; env anchor must win first anyway
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(tmp, 'elsewhere'));
    // Launcher lives in the extracted dev-source tree (no adjacent bin/node).
    const launcher = path.join(tmp, 'dev-source', 'apps', 'operator', 'scripts', 'psu-launcher.mjs');

    expect(await resolveShimNode(launcher)).toBe(bundled);
  });

  it('anchor 2 (WI-3334): falls to process.execPath (the running bundled node) when SIDECAR_BIN is unset', async () => {
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', '');
    const bundled = path.join(tmp, 'sidecar', 'bin', 'node');
    await touch(bundled);
    setExecPath(bundled); // serve.mjs runs UNDER the bundled node
    // The exact regression layout: launcher in dev-source, cwd is NOT the sidecar.
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(tmp, 'somewhere-else'));
    const launcher = path.join(tmp, 'dev-source', 'apps', 'operator', 'scripts', 'psu-launcher.mjs');

    expect(await resolveShimNode(launcher)).toBe(bundled);
  });

  it('prefers $PAPERCUSP_SIDECAR_BIN/node over process.execPath when both exist', async () => {
    const envNode = path.join(tmp, 'sidecar', 'bin', 'node');
    const execNode = path.join(tmp, 'other-node', 'node');
    await touch(envNode);
    await touch(execNode);
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', path.dirname(envNode));
    setExecPath(execNode);
    const launcher = path.join(tmp, 'dev-source', 'apps', 'operator', 'scripts', 'psu-launcher.mjs');

    expect(await resolveShimNode(launcher)).toBe(envNode);
  });

  it('anchor 3: uses the bundled node next to the launcher when the cwd-independent anchors are absent', async () => {
    disableBundledAnchors();
    const sidecar = path.join(tmp, 'sidecar');
    const launcher = path.join(sidecar, 'scripts', 'psu-launcher.mjs');
    const bundled = path.join(sidecar, 'bin', 'node');
    await touch(bundled);
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(tmp, 'elsewhere'));

    expect(await resolveShimNode(launcher)).toBe(bundled);
  });

  it('anchor 4: falls to cwd/bin/node when only the sidecar cwd has it', async () => {
    disableBundledAnchors();
    // Launcher grandparent has no bin/node; only the (sidecar) cwd does.
    const launcher = path.join(tmp, 'dev-source', 'apps', 'operator', 'scripts', 'psu-launcher.mjs');
    const sidecar = path.join(tmp, 'sidecar');
    const bundled = path.join(sidecar, 'bin', 'node');
    await touch(bundled);
    vi.spyOn(process, 'cwd').mockReturnValue(sidecar);

    expect(await resolveShimNode(launcher)).toBe(bundled);
  });

  it('falls back to bare "node" only when no anchor resolves (dev/unbundled box)', async () => {
    disableBundledAnchors();
    const launcher = path.join(tmp, 'repo', 'apps', 'operator', 'scripts', 'psu-launcher.mjs');
    await fs.mkdir(path.dirname(launcher), { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(tmp, 'no-bundle-cwd'));

    expect(await resolveShimNode(launcher)).toBe('node');
  });
});

/**
 * WI-3334 residual: even with resolveShimNode's anchors, a shim WRITTEN by the
 * dev-source operator (no PAPERCUSP_SIDECAR_BIN, tsx execPath) still baked bare
 * `node` — and nothing created the ~/.local/bin/node the shim's PATH leans on.
 * ensureBundledNodeLinked closes that: the primary operator's install run links
 * the bundled node there so bare `node` resolves regardless of which operator
 * wrote the shim.
 */
describe('ensureBundledNodeLinked', () => {
  const retainedNode = async (p: string) => {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.symlink(origExecPath, p);
  };
  it('links ~/.local/bin/node → the bundled node when resolvable (primary operator run)', async () => {
    const bundled = path.join(tmp, 'sidecar', 'bin', 'node');
    await retainedNode(bundled);
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', path.dirname(bundled));
    const home = path.join(tmp, 'home');

    expect(await ensureBundledNodeLinked(home)).toBe(true);
    const dest = path.join(home, '.local', 'bin', 'node');
    expect(await fs.realpath(dest)).toBe(await fs.realpath(bundled));
  });

  it('is a no-op (false) when no bundled node is resolvable (dev-source operator context)', async () => {
    disableBundledAnchors(); // no SIDECAR_BIN, execPath not node
    const home = path.join(tmp, 'home');

    expect(await ensureBundledNodeLinked(home)).toBe(false);
    // nothing created
    await expect(fs.access(path.join(home, '.local', 'bin', 'node'))).rejects.toThrow();
  });

  it('does NOT clobber an existing working node (user-installed or already linked)', async () => {
    const bundled = path.join(tmp, 'sidecar', 'bin', 'node');
    await retainedNode(bundled);
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', path.dirname(bundled));
    const home = path.join(tmp, 'home');
    const existing = path.join(home, '.local', 'bin', 'node');
    await touch(existing); // a real node already present

    expect(await ensureBundledNodeLinked(home)).toBe(false);
    const st = await fs.lstat(existing);
    expect(st.isSymbolicLink()).toBe(false); // left the user's real file untouched
  });

  it('replaces a DANGLING link (stale from a prior app version) with a fresh one', async () => {
    const bundled = path.join(tmp, 'sidecar', 'bin', 'node');
    await retainedNode(bundled);
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', path.dirname(bundled));
    const home = path.join(tmp, 'home');
    const dest = path.join(home, '.local', 'bin', 'node');
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.symlink(path.join(tmp, 'old-bundle', 'node'), dest); // dangling → old node gone

    expect(await ensureBundledNodeLinked(home)).toBe(true);
    expect(await fs.realpath(dest)).toBe(await fs.realpath(bundled));
  });
});

/**
 * WI-3626: `gh auth setup-git` bakes WHICHEVER path `buildGithubLoginSpec` resolved
 * verbatim into `~/.gitconfig`'s credential helper. Without a stable shim, that
 * resolution falls to an app-bundle-relative path which dangles the instant the app
 * is renamed/replaced (confirmed live: `Papercusp.app` → `Papercusp Server.app`).
 * ensureGhLinked keeps `~/.papercusp/bin/gh` pointed at the CURRENT bundle's gh —
 * refreshed every boot, unlike ensureAgentClisLinked's link-once-if-missing — so an
 * app rename between boots re-points the symlink instead of reproducing the bug.
 */
describe('ensureGhLinked', () => {
  it('links ~/.papercusp/bin/gh → the bundled gh when resolvable via PAPERCUSP_SIDECAR_BIN', async () => {
    const bundled = path.join(tmp, 'sidecar', 'bin', 'gh');
    await touch(bundled);
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', path.dirname(bundled));
    const home = path.join(tmp, 'home');
    const binDir = path.join(home, '.papercusp', 'bin');

    expect(await ensureGhLinked(home, binDir)).toBe(true);
    const dest = path.join(binDir, 'gh');
    expect(await fs.realpath(dest)).toBe(await fs.realpath(bundled));
  });

  it('is a no-op (false) when no bundled gh is resolvable this run', async () => {
    disableBundledAnchors();
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(tmp, 'no-bundle-cwd'));
    const home = path.join(tmp, 'home');
    const binDir = path.join(home, '.papercusp', 'bin');

    expect(await ensureGhLinked(home, binDir, [])).toBe(false);
    await expect(fs.access(path.join(binDir, 'gh'))).rejects.toThrow();
  });

  it('repairs a dangling stable shim from a canonical system gh when no bundle is visible', async () => {
    disableBundledAnchors();
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(tmp, 'no-bundle-cwd'));
    const home = path.join(tmp, 'home');
    const binDir = path.join(home, '.papercusp', 'bin');
    const dest = path.join(binDir, 'gh');
    const systemBin = path.join(tmp, 'usr', 'bin');
    const systemGh = path.join(systemBin, 'gh');
    await touch(systemGh);
    await fs.mkdir(binDir, { recursive: true });
    await fs.symlink(path.join(tmp, 'retired-bundle', 'sidecar', 'bin', 'gh'), dest);

    expect(await ensureGhLinked(home, binDir, [binDir, systemBin])).toBe(true);
    expect(await fs.realpath(dest)).toBe(await fs.realpath(systemGh));
  });

  it('is idempotent (false, no write) once already pointed at the current bundle', async () => {
    const bundled = path.join(tmp, 'sidecar', 'bin', 'gh');
    await touch(bundled);
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', path.dirname(bundled));
    const home = path.join(tmp, 'home');
    const binDir = path.join(home, '.papercusp', 'bin');

    expect(await ensureGhLinked(home, binDir)).toBe(true); // first run creates it
    expect(await ensureGhLinked(home, binDir)).toBe(false); // second run: already correct
  });

  it('THE REGRESSION: re-points the symlink when the app bundle was renamed between boots', async () => {
    const oldBundled = path.join(tmp, 'Papercusp.app', 'Contents', 'Resources', 'sidecar', 'bin', 'gh');
    await touch(oldBundled);
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', path.dirname(oldBundled));
    const home = path.join(tmp, 'home');
    const binDir = path.join(home, '.papercusp', 'bin');
    expect(await ensureGhLinked(home, binDir)).toBe(true); // first boot: old bundle

    // Simulate an app rename: the old bundle is gone, a new one exists at a
    // DIFFERENT path (Papercusp.app -> Papercusp Server.app).
    await fs.rm(path.dirname(path.dirname(path.dirname(path.dirname(oldBundled)))), { recursive: true, force: true });
    const newBundled = path.join(tmp, 'Papercusp Server.app', 'Contents', 'Resources', 'sidecar', 'bin', 'gh');
    await touch(newBundled);
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', path.dirname(newBundled));

    expect(await ensureGhLinked(home, binDir)).toBe(true); // second boot: re-points
    const dest = path.join(binDir, 'gh');
    expect(await fs.realpath(dest)).toBe(await fs.realpath(newBundled));
  });

  it('does not clobber an existing link when this run cannot resolve a source (dev box)', async () => {
    const bundled = path.join(tmp, 'sidecar', 'bin', 'gh');
    await touch(bundled);
    vi.stubEnv('PAPERCUSP_SIDECAR_BIN', path.dirname(bundled));
    const home = path.join(tmp, 'home');
    const binDir = path.join(home, '.papercusp', 'bin');
    await ensureGhLinked(home, binDir); // establish a working link

    disableBundledAnchors();
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(tmp, 'no-bundle-cwd'));
    expect(await ensureGhLinked(home, binDir)).toBe(false); // no source this run — leave it alone
    const dest = path.join(binDir, 'gh');
    expect(await fs.realpath(dest)).toBe(await fs.realpath(bundled)); // still the old, still-valid link
  });
});

describe('repairPapercuspGitCredentialHelpers (WI-38006)', () => {
  function inMemoryGitConfig(initial: Record<string, string[]>): {
    values: Record<string, string[]>;
    calls: string[][];
    runner: GitConfigRunner;
  } {
    const values = Object.fromEntries(Object.entries(initial).map(([key, helpers]) => [key, [...helpers]]));
    const calls: string[][] = [];
    const runner: GitConfigRunner = async (args) => {
      calls.push([...args]);
      const operation = args[2];
      const key = args[3];
      if (operation === '--get-all') {
        const helpers = values[key];
        return helpers
          ? { code: 0, stdout: `${helpers.join('\n')}\n` }
          : { code: 1, stdout: '' };
      }
      if (operation === '--replace-all') {
        const replacement = args[4];
        const matcher = new RegExp(args[5]);
        values[key] = (values[key] ?? []).map((helper) => (matcher.test(helper) ? replacement : helper));
        return { code: 0, stdout: '' };
      }
      return { code: 2, stdout: '' };
    };
    return { values, calls, runner };
  }

  it('replaces stale helpers for github + gist while preserving blank resets and user helpers', async () => {
    const home = path.join(tmp, 'home');
    const binDir = path.join(home, '.papercusp', 'bin');
    await touch(path.join(binDir, 'gh'));
    const staleGithub = '!/Applications/Papercusp.app/Contents/Resources/sidecar/bin/gh auth git-credential';
    const staleGist = '!/Applications/Papercusp GUI.app/Contents/Resources/sidecar/bin/gh auth git-credential';
    const config = inMemoryGitConfig({
      'credential.https://github.com.helper': ['', staleGithub, 'osxkeychain'],
      'credential.https://gist.github.com.helper': ['', staleGist, '!/opt/custom-gh auth git-credential'],
    });
    const stable = `!${path.join(binDir, 'gh')} auth git-credential`;

    expect(await repairPapercuspGitCredentialHelpers(home, binDir, config.runner)).toBe(2);
    expect(config.values['credential.https://github.com.helper']).toEqual(['', stable, 'osxkeychain']);
    expect(config.values['credential.https://gist.github.com.helper']).toEqual([
      '',
      stable,
      '!/opt/custom-gh auth git-credential',
    ]);
  });

  it('is idempotent after an app rename has been reconciled to the stable shim', async () => {
    const home = path.join(tmp, 'home with spaces');
    const binDir = path.join(home, '.papercusp', 'bin');
    await touch(path.join(binDir, 'gh'));
    const config = inMemoryGitConfig({
      'credential.https://github.com.helper': [
        '',
        '!/Applications/Papercusp Server.app/Contents/Resources/sidecar/bin/gh auth git-credential',
      ],
    });

    expect(await repairPapercuspGitCredentialHelpers(home, binDir, config.runner)).toBe(1);
    expect(await repairPapercuspGitCredentialHelpers(home, binDir, config.runner)).toBe(0);
    expect(config.calls.filter((args) => args[2] === '--replace-all')).toHaveLength(1);
  });

  it('does nothing when the stable gh shim is unavailable', async () => {
    const home = path.join(tmp, 'home');
    const binDir = path.join(home, '.papercusp', 'bin');
    const runner = vi.fn<GitConfigRunner>();

    expect(await repairPapercuspGitCredentialHelpers(home, binDir, runner)).toBe(0);
    expect(runner).not.toHaveBeenCalled();
  });
});

/**
 * WI-37920 / P-006 — the INSTALLER half of "a backend that IS installed cannot be
 * launched, but only from inside a desktop-spawned terminal".
 *
 * `~/.papercusp/bin` is prepended to every spawned terminal's PATH, so a shim
 * there is what makes `psu --agent=X` work when the window's own PATH is the
 * desktop session's. Two gaps, both measured 2026-08-11:
 *   • `omp` was not in the loop at all — a bun-installed omp never got a shim.
 *   • the search list was hand-rolled here and did not include `~/.bun/bin`,
 *     which is where `bun add -g` puts things and which `~/.bashrc` adds to PATH
 *     BELOW its "if not running interactively, return" early-exit.
 * The fix routes both through `backendSearchDirs` — one list, three consumers
 * (this installer, psu's detection, the operator's spawn-PATH injection).
 */
describe('ensureAgentClisLinked (WI-37920 / P-006)', () => {
  it('links a BUN-installed omp — the install location the hand-rolled list missed', async () => {
    const home = path.join(tmp, 'home');
    const binDir = path.join(home, '.papercusp', 'bin');
    await fs.mkdir(binDir, { recursive: true });
    const src = path.join(home, '.bun', 'bin', 'omp');
    await touch(src);

    const linked = await ensureAgentClisLinked(home, binDir);

    expect(
      linked,
      'a bun-installed omp must get a ~/.papercusp/bin shim — otherwise psu inside a ' +
        'desktop terminal reports "the omp backend (`omp`) is not installed" while the ' +
        "same binary works in the user's interactive shell.",
    ).toContain('omp');
    expect(await fs.realpath(path.join(binDir, 'omp'))).toBe(await fs.realpath(src));
  });

  it.each([
    ['claude', path.join('.local', 'bin')],
    ['codex', path.join('.npm-global', 'bin')],
    ['omp', path.join('.cargo', 'bin')],
  ])('links %s found under ~/%s', async (agent, relDir) => {
    const home = path.join(tmp, 'home');
    const binDir = path.join(home, '.papercusp', 'bin');
    await fs.mkdir(binDir, { recursive: true });
    const src = path.join(home, relDir, agent);
    await touch(src);

    expect(await ensureAgentClisLinked(home, binDir)).toContain(agent);
    expect(await fs.realpath(path.join(binDir, agent))).toBe(await fs.realpath(src));
  });

  it('never links binDir to ITSELF (binDir is in the shared search list)', async () => {
    // Sharing one list means ~/.papercusp/bin is now among the search dirs. Without
    // the self-link guard a dest could resolve to itself.
    const home = path.join(tmp, 'home');
    const binDir = path.join(home, '.papercusp', 'bin');
    await fs.mkdir(binDir, { recursive: true });
    const linked = await ensureAgentClisLinked(home, binDir);
    for (const agent of linked) {
      const dest = path.join(binDir, agent);
      expect(await fs.realpath(dest)).not.toBe(dest);
    }
  });

  it('is idempotent — an existing shim is left exactly as it is', async () => {
    const home = path.join(tmp, 'home');
    const binDir = path.join(home, '.papercusp', 'bin');
    await fs.mkdir(binDir, { recursive: true });
    const first = path.join(home, '.bun', 'bin', 'omp');
    await touch(first);
    await ensureAgentClisLinked(home, binDir);

    // A second install location appears; the established shim must not be re-pointed.
    await touch(path.join(home, '.local', 'bin', 'omp'));
    expect(await ensureAgentClisLinked(home, binDir)).not.toContain('omp');
    expect(await fs.realpath(path.join(binDir, 'omp'))).toBe(await fs.realpath(first));
  });

  it('does NOT shim the shebang interpreter (bun) into the PREPENDED dir', async () => {
    // ~/.papercusp/bin outranks the user's own PATH, so a `bun` shim here would
    // shadow the user's bun for every command they run — worse than the bug being
    // fixed. The interpreter is handled by the spawn-time PATH APPEND instead
    // (console-spawn's buildPathExport), which cannot shadow anything.
    const home = path.join(tmp, 'home');
    const binDir = path.join(home, '.papercusp', 'bin');
    await fs.mkdir(binDir, { recursive: true });
    await touch(path.join(home, '.bun', 'bin', 'omp'));
    await touch(path.join(home, '.bun', 'bin', 'bun'));

    await ensureAgentClisLinked(home, binDir);

    await expect(fs.access(path.join(binDir, 'bun'))).rejects.toThrow();
  });
});

describe('ensurePythonCompatibilityLinked (EI-22568296159914561)', () => {
  it('links ~/.papercusp/bin/python → python3 from the managed search locations', async () => {
    vi.stubEnv('PATH', '');
    const home = path.join(tmp, 'home');
    const binDir = path.join(home, '.papercusp', 'bin');
    const python3 = path.join(home, '.local', 'bin', 'python3');
    await touch(python3);

    expect(await ensurePythonCompatibilityLinked(home, binDir, [path.dirname(python3)])).toBe(true);
    expect(await fs.realpath(path.join(binDir, 'python'))).toBe(await fs.realpath(python3));
  });

  it('preserves an existing python entry instead of replacing it', async () => {
    vi.stubEnv('PATH', '');
    const home = path.join(tmp, 'home');
    const binDir = path.join(home, '.papercusp', 'bin');
    const existing = path.join(binDir, 'python');
    const python3 = path.join(home, '.local', 'bin', 'python3');
    await touch(existing);
    await touch(python3);

    expect(await ensurePythonCompatibilityLinked(home, binDir, [path.dirname(python3)])).toBe(false);
    expect((await fs.lstat(existing)).isSymbolicLink()).toBe(false);
  });

  it('does not create a compatibility entry when python3 is unavailable', async () => {
    vi.stubEnv('PATH', '');
    const home = path.join(tmp, 'home');
    const binDir = path.join(home, '.papercusp', 'bin');

    expect(await ensurePythonCompatibilityLinked(home, binDir, [])).toBe(false);
    await expect(fs.lstat(path.join(binDir, 'python'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
