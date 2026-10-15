/**
 * Tests for installPapercuspFiles (P-006 of
 * desktop-app-install-integration-2026-05-23).
 *
 * Covers:
 *   - First install: token + agent_id minted, playbook + extension copied
 *   - Re-run: token + agent_id reused; playbook + extension refreshed
 *   - Token + agent_id files written mode 0600
 *   - Missing source files don't crash (logged via *Written=false)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { composeSuStackSource, suSessionBinding } from '@papercusp/orchestrator/blueprint';
import {
  installPapercuspFiles,
  projectHistoryDispatcherExec,
  projectHistoryLauncherCandidates,
  operatorAppRootForPrompts,
  resolveOperatorAppRootFromModuleDir,
  resolveInstallPaths,
  renderSuPlaybook,
  provisionRtk,
  readPinnedRtkVersion,
  rtkInstallerCandidates,
  type RtkInstallOutcome,
} from '../papercusp-files';

const execFileAsync = promisify(execFile);

/**
 * Assert that EVERY line where a shim invokes its launcher runs it with `nodePath`.
 *
 * There are two shapes. The plain shims end in `exec <node> "$launcher" "$@"`. The psu
 * shim (WI-38292) runs the same invocation inside a re-exec loop and deliberately does
 * NOT `exec` — bash has to survive the swap so the terminal's foreground process group
 * outlives it. Asserting the INVOCATION rather than the `exec ` prefix keeps the guard
 * meaningful across both, and this is what the guard was always about: an end user's
 * plain Terminal has no `node` on PATH, so a bare `node …` fails with "command not
 * found". Checking every match (not just that one exists) makes it stronger than the
 * `toContain` it replaces — the loop must not smuggle in a second, unresolved
 * interpreter.
 */
function expectLauncherInterpreter(shim: string, nodePath: string): void {
  const invocations = shim.match(/^[ \t]*(?:exec )?(?:"[^"]*"|\S+) "\$launcher" "\$@"$/gm) ?? [];
  expect(invocations.length).toBeGreaterThan(0);
  for (const line of invocations) {
    expect(line).toContain(JSON.stringify(nodePath));
  }
}

let tmpHome: string;
let tmpAppRoot: string;

beforeEach(async () => {
  tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'pcusp-install-home-'));
  tmpAppRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pcusp-install-app-'));
  // Lay out a fake operator app tree with the sources the installer looks for.
  await fs.mkdir(path.join(tmpAppRoot, 'prompts'), { recursive: true });
  await fs.mkdir(path.join(tmpAppRoot, 'scripts', 'hooks', 'omp'), { recursive: true });
  await fs.writeFile(path.join(tmpAppRoot, 'prompts', 'papercusp-su-engineer.tools.md'), '# Playbook v1\n');
  await fs.writeFile(path.join(tmpAppRoot, 'scripts', 'hooks', 'omp', 'coord-hook.ts'), '// coord-hook v1\n');
  // psu/ptool launcher sources the shim writer points at (A2). Dev names —
  // the bundled `psu.mjs` test below adds the bundled name explicitly.
  await fs.writeFile(path.join(tmpAppRoot, 'scripts', 'psu-launcher.mjs'), '// psu-launcher v1\n');
  await fs.writeFile(path.join(tmpAppRoot, 'scripts', 'ptool.mjs'), '// ptool v1\n');
});

afterEach(async () => {
  // installPapercuspFiles refreshes the Linux desktop database in a detached,
  // best-effort child. On a loaded gate that child can briefly recreate
  // mimeinfo.cache while the fixture tree is being removed. Match the focused
  // Linux launcher tests' bounded retry so cleanup observes that documented
  // lifecycle instead of turning it into an ENOTEMPTY suite failure.
  await fs.rm(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  await fs.rm(tmpAppRoot, { recursive: true, force: true });
});

describe('installPapercuspFiles', () => {
  it('first install: mints token + agent_id, copies playbook + extension', async () => {
    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });

    expect(result.minted.token).toBe(true);
    expect(result.minted.agentId).toBe(true);
    expect(result.playbookWritten).toBe(true);
    expect(result.extensionWritten).toBe(true);

    const token = (await fs.readFile(result.tokenPath, 'utf8')).trim();
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);

    const agentId = (await fs.readFile(result.agentIdPath, 'utf8')).trim();
    expect(agentId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const playbook = await fs.readFile(result.playbookPath, 'utf8');
    expect(playbook).toBe('# Playbook v1\n');

    const ext = await fs.readFile(result.extensionPath, 'utf8');
    expect(ext).toBe('// coord-hook v1\n');
  });

  it('re-run: reuses existing token + agent_id, refreshes playbook + extension', async () => {
    const first = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    const tokenBefore = (await fs.readFile(first.tokenPath, 'utf8')).trim();
    const agentIdBefore = (await fs.readFile(first.agentIdPath, 'utf8')).trim();

    // Update source files in place — simulates an app update.
    await fs.writeFile(path.join(tmpAppRoot, 'prompts', 'papercusp-su-engineer.tools.md'), '# Playbook v2\n');
    await fs.writeFile(path.join(tmpAppRoot, 'scripts', 'hooks', 'omp', 'coord-hook.ts'), '// coord-hook v2\n');

    const second = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });

    expect(second.minted.token).toBe(false);
    expect(second.minted.agentId).toBe(false);

    const tokenAfter = (await fs.readFile(second.tokenPath, 'utf8')).trim();
    const agentIdAfter = (await fs.readFile(second.agentIdPath, 'utf8')).trim();
    expect(tokenAfter).toBe(tokenBefore);
    expect(agentIdAfter).toBe(agentIdBefore);

    const playbook = await fs.readFile(second.playbookPath, 'utf8');
    expect(playbook).toBe('# Playbook v2\n');

    const ext = await fs.readFile(second.extensionPath, 'utf8');
    expect(ext).toBe('// coord-hook v2\n');
  });

  it('token file written with mode 0600', async () => {
    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    const tokenStat = await fs.stat(result.tokenPath);
    expect(tokenStat.mode & 0o777).toBe(0o600);
    const agentStat = await fs.stat(result.agentIdPath);
    expect(agentStat.mode & 0o777).toBe(0o600);
  });

  it('writes executable psu + ptool shims pointing at the resolved launchers (A2)', async () => {
    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });

    expect(result.psuShimWritten).toBe(true);
    expect(result.ptoolShimWritten).toBe(true);
    expect(result.psuLauncherSource).toBe(path.join(tmpAppRoot, 'scripts', 'psu-launcher.mjs'));
    expect(result.ptoolLauncherSource).toBe(path.join(tmpAppRoot, 'scripts', 'ptool.mjs'));

    // Shim lands at ~/.papercusp/bin/psu, executable, and execs the launcher.
    expect(result.psuPath).toBe(path.join(tmpHome, '.papercusp', 'bin', 'psu'));
    const psu = await fs.readFile(result.psuPath, 'utf8');
    expect(psu).toMatch(/^#!\/usr\/bin\/env bash\n/);
    expect(psu).toContain('PAPERCUSP_PSU_LAUNCHER');
    expect(psu).toContain('PAPERCUSP_INTEGRATION_ROOT');
    expect(psu).toContain('PAPERCUSP_RELEASE_ROOT');
    expectLauncherInterpreter(psu, process.execPath);
    expect(psu).toContain(JSON.stringify(result.psuLauncherSource));
    // The shim exposes both supported Claude install locations: the bundled
    // sidecar bin (Windows WSL's npm global prefix) and ~/.local/bin (the
    // official claude.ai installer). Neither is on the minimal distro's login
    // PATH by default.
    expect(psu).toContain(
      `export PATH=${JSON.stringify(path.dirname(process.execPath))}:"$HOME/.local/bin:$PATH"`,
    );
    expect((await fs.stat(result.psuPath)).mode & 0o777).toBe(0o755);
    expect((await fs.stat(result.ptoolPath)).mode & 0o777).toBe(0o755);
  });

  it('quotes a packaged sidecar bin path containing spaces on the shim PATH', async () => {
    const sidecarBin = path.join(tmpHome, 'Papercusp Server', 'sidecar', 'bin');
    await fs.mkdir(sidecarBin, { recursive: true });
    await fs.writeFile(path.join(sidecarBin, 'node'), '');
    const priorSidecarBin = process.env.PAPERCUSP_SIDECAR_BIN;
    process.env.PAPERCUSP_SIDECAR_BIN = sidecarBin;
    try {
      const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
      const psu = await fs.readFile(result.psuPath, 'utf8');
      expect(psu).toContain(
        `export PATH=${JSON.stringify(sidecarBin)}:"$HOME/.local/bin:$PATH"`,
      );
    } finally {
      if (priorSidecarBin == null) delete process.env.PAPERCUSP_SIDECAR_BIN;
      else process.env.PAPERCUSP_SIDECAR_BIN = priorSidecarBin;
    }
  });

  it('resolves the integration launcher at runtime and falls back to the release launcher', async () => {
    const integrationRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pcusp-install-integration-'));
    const releaseRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pcusp-install-release-'));
    const integrationLauncher = path.join(integrationRoot, 'apps', 'operator', 'scripts', 'psu-launcher.mjs');
    const releaseLauncher = path.join(releaseRoot, 'apps', 'operator', 'scripts', 'psu-launcher.mjs');
    await fs.mkdir(path.dirname(integrationLauncher), { recursive: true });
    await fs.mkdir(path.dirname(releaseLauncher), { recursive: true });
    await fs.writeFile(integrationLauncher, 'console.log("integration");\n');
    await fs.writeFile(releaseLauncher, 'console.log("release");\n');

    const priorIntegrationRoot = process.env.PAPERCUSP_INTEGRATION_ROOT;
    const priorReleaseRoot = process.env.PAPERCUSP_RELEASE_ROOT;
    process.env.PAPERCUSP_RELEASE_ROOT = releaseRoot;
    delete process.env.PAPERCUSP_INTEGRATION_ROOT;
    try {
      const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
      // The test runner may itself be a psu session with an explicit launcher.
      // That override outranks both roots and would execute the real agent CLI.
      const baseEnv = { ...process.env, PAPERCUSP_PSU_LAUNCHER: '', PAPERCUSP_RELEASE_ROOT: releaseRoot };

      const integration = await execFileAsync(result.psuPath, [], {
        env: { ...baseEnv, PAPERCUSP_INTEGRATION_ROOT: integrationRoot },
        timeout: 5_000,
      });
      expect(integration.stdout.trim()).toBe('integration');
      expect(integration.stderr).toContain(integrationLauncher);

      const releaseFallback = await execFileAsync(result.psuPath, [], {
        env: {
          ...baseEnv,
          PAPERCUSP_INTEGRATION_ROOT: '',
          PAPERCUSP_RELEASE_ROOT: '',
        },
        timeout: 5_000,
      });
      expect(releaseFallback.stdout.trim()).toBe('release');
      expect(releaseFallback.stderr).toContain(releaseLauncher);
    } finally {
      if (priorIntegrationRoot === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
      else process.env.PAPERCUSP_INTEGRATION_ROOT = priorIntegrationRoot;
      if (priorReleaseRoot === undefined) delete process.env.PAPERCUSP_RELEASE_ROOT;
      else process.env.PAPERCUSP_RELEASE_ROOT = priorReleaseRoot;
      await fs.rm(integrationRoot, { recursive: true, force: true });
      await fs.rm(releaseRoot, { recursive: true, force: true });
    }
  });

  it('writes an executable psu-sentinel shim that execs the resolved psu shim (WI-4244)', async () => {
    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });

    expect(result.psuShimWritten).toBe(true);
    expect(result.psuSentinelShimWritten).toBe(true);
    expect(result.psuSentinelPath).toBe(path.join(tmpHome, '.papercusp', 'bin', 'psu-sentinel'));

    const sentinel = await fs.readFile(result.psuSentinelPath, 'utf8');
    expect(sentinel).toMatch(/^#!\/usr\/bin\/env bash\n/);
    // Registers the current zellij pane for voice-transcript routing.
    expect(sentinel).toContain('ZELLIJ_PANE_ID');
    expect(sentinel).toContain('ZELLIJ_SESSION_NAME');
    expect(sentinel).toContain('$HOME/.papercusp/sentinel-pane');
    // Applies a staged per-session model override.
    expect(sentinel).toContain('$HOME/.papercusp/sentinel-model');
    expect(sentinel).toContain('--model=$spec');
    // …and with NO override staged, defaults to a FAST spec (papercup-fast,
    // voice-public-release-readiness D-007) instead of the heavy workspace
    // default that made voice turns time out against a slow pane.
    expect(sentinel).toContain("spec='sonnet:medium'");
    expect(sentinel).toContain('model_args=("--model=$spec")');
    // Execs the ALREADY-RESOLVED psu shim's concrete path, not a bare `psu`
    // relying on PATH resolution a second time.
    expect(sentinel).toContain(`exec ${JSON.stringify(result.psuPath)} --no-picker --agent=claude --role=papercup`);
    expect((await fs.stat(result.psuSentinelPath)).mode & 0o777).toBe(0o755);
  });

  it('writes an executable psu-sentinel-deep shim for the deep-brain pane (voice-release P-014)', async () => {
    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });

    expect(result.psuShimWritten).toBe(true);
    expect(result.psuSentinelDeepShimWritten).toBe(true);
    expect(result.psuSentinelDeepPath).toBe(path.join(tmpHome, '.papercusp', 'bin', 'psu-sentinel-deep'));

    const deep = await fs.readFile(result.psuSentinelDeepPath, 'utf8');
    expect(deep).toMatch(/^#!\/usr\/bin\/env bash\n/);
    // Registers the current zellij pane — to the DEEP registration file, never
    // the front-end's sentinel-pane (voice routing must keep hitting the fast
    // pane only).
    expect(deep).toContain('ZELLIJ_PANE_ID');
    expect(deep).toContain('ZELLIJ_SESSION_NAME');
    expect(deep).toContain('$HOME/.papercusp/sentinel-deep-pane');
    expect(deep).not.toContain('$HOME/.papercusp/sentinel-pane');
    // Applies the deep pane's own staged model override…
    expect(deep).toContain('$HOME/.papercusp/sentinel-deep-model');
    expect(deep).toContain('model_args=("--model=$spec")');
    // …and with NO override staged, defaults to the HEAVY spec (D-006: depth
    // is this session's contract — the exact opposite of the front pane's
    // sonnet:medium fast default).
    expect(deep).toContain("spec='opus:xhigh'");
    expect(deep).not.toContain("spec='sonnet:medium'");
    // Execs the ALREADY-RESOLVED psu shim as the hidden papercup-deep role.
    expect(deep).toContain(`exec ${JSON.stringify(result.psuPath)} --no-picker --agent=claude --role=papercup-deep`);
    expect((await fs.stat(result.psuSentinelDeepPath)).mode & 0o777).toBe(0o755);
  });

  it('writes the `papercusp` dispatcher shim when the onboard concierge resolves (P-014)', async () => {
    // No concierge in the base fixture → dispatcher not written, no throw.
    let result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    expect(result.papercuspCliWritten).toBe(false);
    expect(result.onboardLauncherSource).toBe('');

    // A dev install with onboarding but no usable History launcher must not
    // advertise a route that falls through to usage.
    await fs.writeFile(path.join(tmpAppRoot, 'scripts', 'onboard.mjs'), '// bundled concierge\n');
    result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    let cli = await fs.readFile(result.papercuspCliPath, 'utf8');
    expect(cli).toContain('usage: papercusp <setup|tutorial>');
    expect(cli).not.toContain('project-history)');

    // Bundled concierge + generator present → dispatcher lands with onboarding
    // and the portable Project History subcommand.
    await fs.writeFile(path.join(tmpAppRoot, 'scripts', 'project-history.mjs'), '// bundled generator\n');
    result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    expect(result.papercuspCliWritten).toBe(true);
    const launcher = path.join(tmpAppRoot, 'scripts', 'onboard.mjs');
    const projectHistoryLauncher = path.join(tmpAppRoot, 'scripts', 'project-history.mjs');
    expect(result.onboardLauncherSource).toBe(launcher);
    expect(result.projectHistoryLauncherSource).toBe(projectHistoryLauncher);
    expect(result.papercuspCliPath).toBe(path.join(tmpHome, '.papercusp', 'bin', 'papercusp'));
    cli = await fs.readFile(result.papercuspCliPath, 'utf8');
    expect(cli).toMatch(/^#!\/usr\/bin\/env bash\n/);
    // `setup` + `tutorial` open the unified shell on their tab (#4); `onboard` is the
    // back-compat linear concierge.
    expect(cli).toContain(
      `setup)    shift; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(launcher)} --tab=setup "$@" ;;`,
    );
    expect(cli).toContain(
      `tutorial) shift; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(launcher)} --tutorial "$@" ;;`,
    );
    expect(cli).toContain(
      `onboard)  shift; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(launcher)} "$@" ;;`,
    );
    expect(cli).toContain(
      `project-history) shift; exec ${JSON.stringify(process.execPath)} ${JSON.stringify(projectHistoryLauncher)} "$@" ;;`,
    );
    expect(cli).toContain('usage: papercusp <setup|tutorial|project-history>');
    expect((await fs.stat(result.papercuspCliPath)).mode & 0o777).toBe(0o755);
  });

  it('routes an unbundled dev install through the canonical source CLI', () => {
    const operatorRoot = path.join(path.sep, 'repo', 'apps', 'operator');
    const sourceCli = path.join(path.sep, 'repo', 'libs', 'papercusp', 'packages', 'cli', 'bin', 'papercusp');

    expect(projectHistoryLauncherCandidates(operatorRoot, false)).toContain(sourceCli);
    expect(projectHistoryLauncherCandidates(operatorRoot, true)).not.toContain(sourceCli);
    expect(projectHistoryDispatcherExec('/sidecar/bin/node', sourceCli)).toBe(
      `${JSON.stringify(sourceCli)} project-history`,
    );
  });

  it('resolves the operator app root from the module layout, independent of cwd (EI-19445483716744925)', async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../');
    const sourceModuleDir = path.join(repoRoot, 'packages', 'operator-core', 'lib', 'desktop-install');
    const expectedSourceRoot = path.join(repoRoot, 'apps', 'operator');

    // The source module is below packages/operator-core, so the old fixed two-hop
    // resolver returned packages/operator-core instead of this app root.
    expect(resolveOperatorAppRootFromModuleDir(sourceModuleDir)).toBe(expectedSourceRoot);
    expect(operatorAppRootForPrompts()).toBe(expectedSourceRoot);

    // A bundled module is rooted at sidecar/ and receives the runtime-only app
    // tree under sidecar/apps/operator.
    const sidecarRoot = path.join(tmpAppRoot, 'sidecar');
    const packagedAppRoot = path.join(sidecarRoot, 'apps', 'operator');
    await fs.mkdir(packagedAppRoot, { recursive: true });
    expect(resolveOperatorAppRootFromModuleDir(path.join(sidecarRoot, 'serve.mjs'))).toBe(packagedAppRoot);

    // dist-host is already below apps/operator; it must resolve to that nearest
    // app root rather than walking above it.
    const distHostRoot = path.join(tmpAppRoot, 'release', 'apps', 'operator');
    await fs.mkdir(path.join(distHostRoot, 'dist-host'), { recursive: true });
    expect(resolveOperatorAppRootFromModuleDir(path.join(distHostRoot, 'dist-host'))).toBe(distHostRoot);
  });

  /**
   * WI-39140 / P-006 regression.
   *
   * The test above pins the tsx SOURCE layout, where resolveOperatorAppRoot()
   * returns `<repo>/apps/operator`. Production uses a packaged sidecar layout,
   * so the source-root test alone cannot prove the bundled source fallback. The
   * mismatch was invisible: the candidate resolver returned no source, the
   * dispatcher was written WITHOUT its `project-history` case, and the install
   * reported success. It shipped on a green deploy with nothing failing.
   *
   * Both anchors below were MEASURED on the deployed operator (pid running
   * `<release>/apps/operator/dist-host/hono-host.mjs`), not assumed.
   */
  const RELEASE_REPO = path.join(path.sep, 'release');
  const RELEASE_SOURCE_CLI = path.join(RELEASE_REPO, 'libs', 'papercusp', 'packages', 'cli', 'bin', 'papercusp');
  // resolveOperatorAppRoot() walks up 2 from the module dir. The esbuild bundle
  // lives at `apps/operator/dist-host/`, one level DEEPER than the source file it
  // replaces, so the same two hops land one level HIGH — on `<release>/apps`.
  const BUNDLED_APP_ROOT = path.join(RELEASE_REPO, 'apps');
  const DEPLOYED_CWD = path.join(RELEASE_REPO, 'apps', 'operator');

  it('resolves the source CLI from the BUNDLED app root and the deployed cwd (WI-39140/P-006)', () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(DEPLOYED_CWD);
    try {
      expect(projectHistoryLauncherCandidates(BUNDLED_APP_ROOT, false)).toContain(RELEASE_SOURCE_CLI);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  /**
   * PERMANENT CALIBRATION CONTROL — keeps the test above from passing vacuously.
   *
   * This reimplements the RETIRED fixed-hop resolution and asserts it misses the
   * real production anchors. It is a pure function of path strings, so it stays
   * true forever. If someone reverts the upward walk to a fixed number of `..`
   * hops, the test above goes red rather than silently shipping a dispatcher with
   * the feature missing again.
   */
  it('CONTROL: the retired fixed-hop resolution misses both production anchors', () => {
    const rel = path.join('libs', 'papercusp', 'packages', 'cli', 'bin', 'papercusp');
    const retiredFixedHop = [
      path.resolve(BUNDLED_APP_ROOT, '..', '..', rel), // -> <workspace>/libs/... (one level too high)
      path.resolve(DEPLOYED_CWD, rel), // -> <release>/apps/operator/libs/... (cwd is not the repo root)
    ];
    expect(retiredFixedHop).not.toContain(RELEASE_SOURCE_CLI);
  });

  it('writes a macOS "Papercusp Tutorial & Setup.app" wrapper on darwin once the dispatcher resolves (WI-2197)', async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    try {
      // No concierge yet → dispatcher not written → no .app wrapper either.
      let result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
      expect(result.papercuspCliWritten).toBe(false);
      expect(result.macTutorialAppWritten).toBe(false);
      expect(
        await fs
          .access(result.macTutorialAppPath)
          .then(() => true)
          .catch(() => false),
      ).toBe(false);

      const legacyAppPath = path.join(tmpHome, 'Applications', 'Papercusp Tutorial.app');
      await fs.mkdir(legacyAppPath, { recursive: true });
      await fs.writeFile(path.join(legacyAppPath, 'legacy-marker'), 'old wrapper\n');

      await fs.writeFile(path.join(tmpAppRoot, 'scripts', 'onboard.mjs'), '// bundled concierge\n');
      result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
      expect(result.papercuspCliWritten).toBe(true);
      expect(result.macTutorialAppWritten).toBe(true);
      expect(result.macTutorialAppPath).toBe(path.join(tmpHome, 'Applications', 'Papercusp Tutorial & Setup.app'));
      expect(
        await fs
          .access(legacyAppPath)
          .then(() => true)
          .catch(() => false),
      ).toBe(false);

      const plist = await fs.readFile(path.join(result.macTutorialAppPath, 'Contents', 'Info.plist'), 'utf8');
      expect(plist).toContain('<key>CFBundleName</key><string>Papercusp Tutorial &amp; Setup</string>');
      expect(plist).toContain('<key>CFBundleExecutable</key><string>papercusp-tutorial</string>');

      const execPath = path.join(result.macTutorialAppPath, 'Contents', 'MacOS', 'papercusp-tutorial');
      const exec = await fs.readFile(execPath, 'utf8');
      expect(exec).toMatch(/^#!\/bin\/bash\n/);
      expect(exec).toContain('"$HOME/.papercusp/bin/papercusp" tutorial');
      expect(exec).toContain('open -na "$TERM_APP"');
      expect((await fs.stat(execPath)).mode & 0o777).toBe(0o755);
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    }
  });

  it('does not write the macOS Tutorial.app wrapper on non-darwin platforms', async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      await fs.writeFile(path.join(tmpAppRoot, 'scripts', 'onboard.mjs'), '// bundled concierge\n');
      const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
      expect(result.papercuspCliWritten).toBe(true);
      expect(result.macTutorialAppWritten).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', { value: origPlatform, configurable: true });
    }
  });

  it('prefers the bundled psu.mjs over the dev psu-launcher.mjs (A2)', async () => {
    // A packaged sidecar ships scripts/psu.mjs alongside the dev source; the
    // bundled name must win so end users run the self-contained bundle.
    await fs.writeFile(path.join(tmpAppRoot, 'scripts', 'psu.mjs'), '// bundled psu\n');
    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    expect(result.psuLauncherSource).toBe(path.join(tmpAppRoot, 'scripts', 'psu.mjs'));
    const psu = await fs.readFile(result.psuPath, 'utf8');
    expect(psu).toContain(path.join(tmpAppRoot, 'scripts', 'psu.mjs'));
  });

  it('shim runs the BUNDLED sidecar node (absolute path) when PAPERCUSP_SIDECAR_BIN points at it (A2)', async () => {
    // A packaged sidecar exports PAPERCUSP_SIDECAR_BIN so the shim can use the
    // bundled Node by absolute path — an end user's plain Terminal has no `node`
    // on PATH, so a bare `exec node …` fails with "command not found: node".
    await fs.writeFile(path.join(tmpAppRoot, 'scripts', 'psu.mjs'), '// bundled psu\n');
    const bundledNode = path.join(tmpAppRoot, 'bin', 'node');
    await fs.mkdir(path.dirname(bundledNode), { recursive: true });
    await fs.writeFile(bundledNode, '#!/bin/sh\n', { mode: 0o755 });
    const priorSidecarBin = process.env.PAPERCUSP_SIDECAR_BIN;
    process.env.PAPERCUSP_SIDECAR_BIN = path.dirname(bundledNode);
    try {
      const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
      const psu = await fs.readFile(result.psuPath, 'utf8');
      const launcher = path.join(tmpAppRoot, 'scripts', 'psu.mjs');
      expectLauncherInterpreter(psu, bundledNode);
      expect(psu).toContain(JSON.stringify(launcher));
      // Not the PATH fallback. The old spelling of this guard was `not.toContain('exec
      // "node"')`, which WI-38292 made vacuously true — psu no longer execs at all — so
      // it is matched against the invocation instead, where it can still fail.
      expect(psu).not.toMatch(/^[ \t]*(?:exec )?"?node"? "\$launcher"/m);
    } finally {
      if (priorSidecarBin === undefined) {
        delete process.env.PAPERCUSP_SIDECAR_BIN;
      } else {
        process.env.PAPERCUSP_SIDECAR_BIN = priorSidecarBin;
      }
    }
  });

  // CONTROL for expectLauncherInterpreter itself. The guard it replaced was a literal
  // `exec <node> "$launcher" "$@"` match, which WI-38292 broke by design when the psu
  // shim stopped exec'ing; a replacement that quietly matched nothing would have looked
  // just as green. These deliberately-wrong shims must make it fail.
  it('expectLauncherInterpreter rejects an unresolved interpreter and a shim it cannot read', () => {
    const nodePath = '/opt/pcusp/bin/node';
    // The PATH fallback the guard exists to forbid.
    expect(() => expectLauncherInterpreter('exec "node" "$launcher" "$@"', nodePath)).toThrow();
    // A loop that resolves node once, then re-invokes it unresolved on the second pass —
    // the failure mode that checking only the FIRST match would miss.
    expect(() =>
      expectLauncherInterpreter(
        `while :; do\n  ${JSON.stringify(nodePath)} "$launcher" "$@"\n  node "$launcher" "$@"\ndone\n`,
        nodePath,
      ),
    ).toThrow();
    // No invocation at all — a shim shape the regex does not understand must fail loudly
    // rather than vacuously pass.
    expect(() => expectLauncherInterpreter('#!/usr/bin/env bash\nexit 0\n', nodePath)).toThrow();
    // Calibration: the real shapes must still PASS, or the three failures above prove
    // nothing but that the matcher is broken.
    expect(() =>
      expectLauncherInterpreter(`exec ${JSON.stringify(nodePath)} "$launcher" "$@"`, nodePath),
    ).not.toThrow();
    expect(() => expectLauncherInterpreter(`  ${JSON.stringify(nodePath)} "$launcher" "$@"`, nodePath)).not.toThrow();
  });

  it('missing psu launcher: psuShimWritten=false, no throw, other artifacts land (A2)', async () => {
    await fs.rm(path.join(tmpAppRoot, 'scripts', 'psu-launcher.mjs'));
    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    expect(result.psuShimWritten).toBe(false);
    expect(result.psuLauncherSource).toBe('');
    // ptool still resolved, and the rest of the install still landed.
    expect(result.ptoolShimWritten).toBe(true);
    expect(result.minted.token).toBe(true);
    expect(result.playbookWritten).toBe(true);
    // WI-4244: sentinel execs psu — with no psu shim to exec, it must not
    // write a dangling shim either. Same for the deep-brain twin (P-014).
    expect(result.psuSentinelShimWritten).toBe(false);
    expect(result.psuSentinelDeepShimWritten).toBe(false);
  });

  it('missing playbook source: playbookWritten=false, no throw', async () => {
    await fs.rm(path.join(tmpAppRoot, 'prompts', 'papercusp-su-engineer.tools.md'));
    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    expect(result.playbookWritten).toBe(false);
    expect(result.playbookSource).toBe('');
    // Other artifacts still landed
    expect(result.minted.token).toBe(true);
    expect(result.extensionWritten).toBe(true);
  });

  it('missing extension source: extensionWritten=false, no throw', async () => {
    await fs.rm(path.join(tmpAppRoot, 'scripts', 'hooks', 'omp', 'coord-hook.ts'));
    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    expect(result.extensionWritten).toBe(false);
    expect(result.extensionSource).toBe('');
    expect(result.playbookWritten).toBe(true);
  });

  it('splices the OMP overlay into a marker-model base playbook', async () => {
    // Regression guard (2026-05-30 marker split): the base carries a
    // CLIENT-TOOLING-OVERLAY marker, NOT the tooling section. The
    // desktop/OMP playbook must have the OMP overlay spliced in — not
    // be raw-copied with a literal marker + no tooling.
    const MARKER = '<!-- PAPERCUSP-SU:CLIENT-TOOLING-OVERLAY -->';
    await fs.writeFile(
      path.join(tmpAppRoot, 'prompts', 'papercusp-su-engineer.tools.md'),
      `# Base\n\n${MARKER}\n\n## Tail\n`,
    );
    await fs.writeFile(
      path.join(tmpAppRoot, 'prompts', 'papercusp-su.omp.md'),
      '## OMP tooling\nUse omp:sessions etc.',
    );

    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    const playbook = await fs.readFile(result.playbookPath, 'utf8');

    expect(playbook).not.toContain(MARKER); // literal marker never ships
    expect(playbook).toContain('## OMP tooling'); // overlay spliced in
    expect(playbook).toContain('# Base');
    expect(playbook).toContain('## Tail');
  });

  it('marker base with NO overlay file: marker is removed, not shipped literally', async () => {
    const MARKER = '<!-- PAPERCUSP-SU:CLIENT-TOOLING-OVERLAY -->';
    await fs.writeFile(
      path.join(tmpAppRoot, 'prompts', 'papercusp-su-engineer.tools.md'),
      `# Base\n${MARKER}\n## Tail\n`,
    );
    // No papercusp-su.omp.md written.

    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    const playbook = await fs.readFile(result.playbookPath, 'utf8');
    expect(playbook).not.toContain(MARKER);
    expect(playbook).toContain('# Base');
    expect(playbook).toContain('## Tail');
  });

  it('projects the canonical deploy-pipeline note into the ENGINEER playbook at the project-guide anchor', async () => {
    // recipes-reuse-activation follow-up: a cross-cutting behavioral note (DEPLOY_PIPELINE_NOTE)
    // lives in ONE source and is PROJECTED into su (engineer) — not hand-mirrored, not loose in
    // CLAUDE.md. A base carrying the project-guide marker (the injection anchor) gets it.
    await fs.writeFile(
      path.join(tmpAppRoot, 'prompts', 'papercusp-su-engineer.tools.md'),
      `# Base\n\n<!-- PAPERCUSP-SU:PROJECT-GUIDE -->\n\n## Tail\n`,
    );

    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    const playbook = await fs.readFile(result.playbookPath, 'utf8');

    // the canonical DEPLOY_PIPELINE_NOTE is projected in, incl. the owner-directed
    // staging-first acceptance contract and "a RED gate is everyone's job to FIX" directive...
    expect(playbook).toContain('## The deploy pipeline is ASYNC');
    expect(playbook).toContain('DEFAULT implementation and plan-item acceptance plane');
    expect(playbook).toContain('reserved ONLY for final promotion and shipment verification');
    expect(playbook).toContain('held or red green-checkpoint gate does NOT block non-final work');
    expect(playbook).toContain('explicitly names the deployed-only property');
    expect(playbook).toContain('do NOT ask the owner');
    expect(playbook).toContain('even if it is not your lane');
    // ...exactly once (one source, one projection)...
    expect(playbook.split('## The deploy pipeline is ASYNC').length - 1).toBe(1);
    // ...sitting in the body BEFORE the project-guide slot, not appended at the very end.
    expect(playbook.indexOf('do NOT ask the owner')).toBeLessThan(playbook.indexOf('## Tail'));
  });

  it('projects the canonical wait-loop note into the ENGINEER playbook at the project-guide anchor', async () => {
    // owner directive 2026-06-23: the "waiting? arm a self-wake LOOP — never sleep on an event that
    // may never fire" directive lives in ONE source (WAIT_LOOP_NOTE) and is PROJECTED into su
    // (engineer) alongside the deploy note — not hand-mirrored, not loose in CLAUDE.md.
    await fs.writeFile(
      path.join(tmpAppRoot, 'prompts', 'papercusp-su-engineer.tools.md'),
      `# Base\n\n<!-- PAPERCUSP-SU:PROJECT-GUIDE -->\n\n## Tail\n`,
    );

    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    const playbook = await fs.readFile(result.playbookPath, 'utf8');

    // the canonical WAIT_LOOP_NOTE is projected in...
    expect(playbook).toContain('## Waiting on something? Arm a self-wake LOOP');
    expect(playbook).toContain('loop:arm');
    // ...including the keep-working-while-you-wait bullet (owner directive 2026-09-26, WI-10003276)...
    expect(playbook).toContain('SECOND, keep working while you wait');
    // ...exactly once (one source, one projection)...
    expect(playbook.split('## Waiting on something? Arm a self-wake LOOP').length - 1).toBe(1);
    // ...sitting in the body BEFORE the project-guide slot, not appended at the very end.
    expect(playbook.indexOf('Arm a self-wake LOOP')).toBeLessThan(playbook.indexOf('## Tail'));
  });

  it('projects the canonical peer-wake note into the ENGINEER playbook at the project-guide anchor', async () => {
    // owner directive 2026-06-24: the "you can WAKE a peer; a parked agent sleeps until something
    // re-invokes it, so handing work off is not enough" directive lives in ONE source (PEER_WAKE_NOTE)
    // and is PROJECTED into su (engineer) alongside the deploy + wait-loop notes — not hand-mirrored.
    await fs.writeFile(
      path.join(tmpAppRoot, 'prompts', 'papercusp-su-engineer.tools.md'),
      `# Base\n\n<!-- PAPERCUSP-SU:PROJECT-GUIDE -->\n\n## Tail\n`,
    );

    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    const playbook = await fs.readFile(result.playbookPath, 'utf8');

    // the canonical PEER_WAKE_NOTE is projected in...
    expect(playbook).toContain('## You can WAKE a peer');
    expect(playbook).toContain('coord:wake');
    // ...exactly once (one source, one projection)...
    expect(playbook.split('## You can WAKE a peer').length - 1).toBe(1);
    // ...sitting in the body BEFORE the project-guide slot, not appended at the very end.
    expect(playbook.indexOf('You can WAKE a peer')).toBeLessThan(playbook.indexOf('## Tail'));
  });

  it('splices the GENERATED workspace map at its marker (staging-branch-pipeline-2026-06-06)', async () => {
    const MARKER = '<!-- PAPERCUSP-SU:WORKSPACE-MAP -->';
    await fs.writeFile(
      path.join(tmpAppRoot, 'prompts', 'papercusp-su-engineer.tools.md'),
      `# Base\n\n${MARKER}\n\n## Tail\n`,
    );

    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    const playbook = await fs.readFile(result.playbookPath, 'utf8');

    expect(playbook).not.toContain(MARKER); // literal marker never ships
    // Config-derived content (resolveWorkspaceMapConfig env/git seams):
    expect(playbook).toContain('Where to work');
    expect(playbook).toContain('automation-only');
    expect(playbook).toContain('## Tail');
  });

  it('removes the PROJECT-GUIDE marker on the install path even when no guide resolves (P-001)', async () => {
    // The install path's project-guide candidates walk up from <appRoot>/prompts
    // — in the fake tmp tree no repo CLAUDE.md exists there, so the marker must
    // be REMOVED, never shipped literally. (Guide-present splicing is covered by
    // the renderSuPlaybook tests below, which control the source path directly.)
    const GUIDE_MARKER = '<!-- PAPERCUSP-SU:PROJECT-GUIDE -->';
    await fs.writeFile(
      path.join(tmpAppRoot, 'prompts', 'papercusp-su-engineer.tools.md'),
      `# Base\n\n${GUIDE_MARKER}\n\n## Tail\n`,
    );
    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    const playbook = await fs.readFile(result.playbookPath, 'utf8');
    expect(playbook).not.toContain(GUIDE_MARKER);
    expect(playbook).toContain('# Base');
    expect(playbook).toContain('## Tail');
  });

  it('resolveInstallPaths returns expected layout', () => {
    const p = resolveInstallPaths('/tmp/somehome');
    expect(p.papercuspDir).toBe('/tmp/somehome/.papercusp');
    expect(p.tokenPath).toBe('/tmp/somehome/.papercusp/superuser-token');
    expect(p.agentIdPath).toBe('/tmp/somehome/.papercusp/su-agent-id');
    expect(p.playbookPath).toBe('/tmp/somehome/.papercusp/engineer-collaborator.md');
    expect(p.extensionPath).toBe('/tmp/somehome/.papercusp/papercusp-coord.ts');
    expect(p.psuSentinelPath).toBe('/tmp/somehome/.papercusp/bin/psu-sentinel');
    expect(p.psuSentinelDeepPath).toBe('/tmp/somehome/.papercusp/bin/psu-sentinel-deep');
  });

  it('auto-discover mode: when operatorAppRoot is absent, falls back to process.cwd()-rooted candidates', async () => {
    // No explicit operatorAppRoot: only opts.playbookSource and
    // opts.extensionSource override the candidate list. We force both
    // via explicit non-existent paths to confirm the override-without-
    // root branch reports missing rather than crashing.
    const result = await installPapercuspFiles({
      home: tmpHome,
      playbookSource: '/nonexistent/playbook.md',
      extensionSource: '/nonexistent/coord.ts',
    });
    expect(result.playbookWritten).toBe(false);
    expect(result.extensionWritten).toBe(false);
    // Token + agent_id still mint correctly in the no-source case.
    expect(result.minted.token).toBe(true);
    expect(result.minted.agentId).toBe(true);
  });

  it('boot-smoke: resolveOperatorAppRoot does not crash on ESM __dirname access (WI-110)', async () => {
    // Verify the fix for ESM __dirname ReferenceError: calling installPapercuspFiles
    // with no explicit operatorAppRoot triggers resolveOperatorAppRoot, which must
    // not crash even though __dirname is undefined in ESM modules.
    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    expect(result.minted.token).toBe(true); // Reached completion without crashing.
  });

  it('reuses token already present from a prior install with no trailing newline', async () => {
    const paths = resolveInstallPaths(tmpHome);
    await fs.mkdir(paths.papercuspDir, { recursive: true });
    await fs.writeFile(paths.tokenPath, 'preexisting-token-12345', { mode: 0o600 });

    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    expect(result.minted.token).toBe(false);
    const token = (await fs.readFile(result.tokenPath, 'utf8')).trim();
    expect(token).toBe('preexisting-token-12345');
  });

  it('dist-host layout: auto-discovery finds hooks + extension when cwd IS the operator app root', async () => {
    // The dev-api service runs `node dist-host/hono-host.mjs` with
    // WorkingDirectory=<appRoot>: the module dir collapses to <appRoot>/dist-host;
    // the resolver now recognizes the nearest <appRoot> directly. The plain-cwd
    // candidates remain defense-in-depth for older/partially unpacked bundles;
    // without them, hook enrollment once silently skipped — the live :3070 install
    // endpoint returned ok with zero hooks while every psu launch on the box lost
    // its turn-start memory delta (2026-07-12).
    const ccDir = path.join(tmpAppRoot, 'scripts', 'hooks', 'cc');
    await fs.mkdir(ccDir, { recursive: true });
    await fs.writeFile(path.join(ccDir, 'pretooluse-locks-acquire.sh'), '#!/bin/bash\n', {
      mode: 0o755,
    });
    await fs.writeFile(path.join(ccDir, 'userpromptsubmit-memory.sh'), '#!/bin/bash\n', {
      mode: 0o755,
    });
    const prevCwd = process.cwd();
    process.chdir(tmpAppRoot);
    // Auto-discovery can resolve the live repository hook sources. Another agent may be
    // editing one while this suite runs, in which case the installer correctly warns
    // that the source bytes are uncommitted. That environmental warning is unrelated to
    // this layout assertion; allow only that specific warning and keep other warnings
    // subject to vitest-fail-on-console.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await installPapercuspFiles({ home: tmpHome });
      for (const [message] of warn.mock.calls) {
        expect(String(message)).toMatch(/^\[desktop-install\] cc hooks: \d+ file\(s\) UNCOMMITTED in .+ NOT contained in sha=/);
      }
      expect(result.claudeHooksInstalled).toContain('pretooluse-locks-acquire.sh');
      expect(result.claudeHooksInstalled).toContain('userpromptsubmit-memory.sh');
      expect(result.claudeSettingsMerged).toBe(true);
      expect(result.extensionWritten).toBe(true);
      const settings = JSON.parse(await fs.readFile(path.join(tmpHome, '.claude', 'settings.json'), 'utf8'));
      expect(JSON.stringify(settings.hooks?.UserPromptSubmit ?? [])).toContain('userpromptsubmit-memory.sh');
    } finally {
      warn.mockRestore();
      process.chdir(prevCwd);
    }
  });

  it('EI-18755593630003816: hook install writes atomically — no leftover temp file, full content lands', async () => {
    // Regression guard for a non-atomic in-place fs.writeFile that let a
    // concurrent PreToolUse hook invocation on this box observe a torn/
    // truncated pretooluse-bash-resource-gate.sh mid-write and hard-refuse
    // with a spurious shell-syntax error. installClaudeHooks must write via a
    // same-directory temp file + rename(), never a direct truncating write to
    // the live hook path — asserted here behaviorally: after install, the
    // destination is byte-identical to the source and no `*.tmp` artifact is
    // left behind in the hooks directory (a leftover tmp file would mean the
    // rename step was skipped or the write path reverted to in-place).
    const ccDir = path.join(tmpAppRoot, 'scripts', 'hooks', 'cc');
    await fs.mkdir(ccDir, { recursive: true });
    const gateSrc = '#!/bin/bash\n# resource gate\npython3 <<\'PYEOF\'\nprint("(hi)")\nPYEOF\n';
    await fs.writeFile(path.join(ccDir, 'pretooluse-locks-acquire.sh'), '#!/bin/bash\n', {
      mode: 0o755,
    });
    await fs.writeFile(path.join(ccDir, 'pretooluse-bash-resource-gate.sh'), gateSrc, {
      mode: 0o755,
    });

    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    expect(result.claudeHooksInstalled).toContain('pretooluse-bash-resource-gate.sh');

    const destDir = path.join(tmpHome, '.papercusp', 'hooks', 'cc');
    const dest = path.join(destDir, 'pretooluse-bash-resource-gate.sh');
    const written = await fs.readFile(dest, 'utf8');
    expect(written).toBe(gateSrc); // full content, never a truncated prefix

    const leftovers = (await fs.readdir(destDir)).filter((n) => n.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('EI-18755593630003816: the sibling OMP hook path (coord-hook extension) also writes atomically', async () => {
    // The CC-hook fix above (installClaudeHooks) landed first; the EI explicitly also
    // asks for "the sibling OMP hook path" — copyIfExists(), the only writer of
    // paths.extensionPath (~/.papercusp/papercusp-coord.ts, the OMP coord-hook
    // extension installed on every psu launch/bootstrap same as the CC hooks). Assert
    // the same behavioral contract: full content lands, and no leftover `*.tmp`
    // artifact is left beside it (a leftover would mean the rename step never ran).
    const extSrc = path.join(tmpAppRoot, 'scripts', 'hooks', 'omp', 'coord-hook.ts');
    const content = '// coord-hook v2 — a bit longer this time\nexport const x = 1;\n';
    await fs.writeFile(extSrc, content);

    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    expect(result.extensionWritten).toBe(true);

    const written = await fs.readFile(result.extensionPath, 'utf8');
    expect(written).toBe(content); // full content, never a truncated prefix

    const leftovers = (await fs.readdir(path.dirname(result.extensionPath))).filter((n) => n.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('EI-20228871846415832: renamed coord entry installs its relative OMP companions', async () => {
    const ompDir = path.join(tmpAppRoot, 'scripts', 'hooks', 'omp');
    await fs.writeFile(
      path.join(ompDir, 'coord-hook.ts'),
      "import { stashAdvisory } from './non-preempting-delivery';\nexport { stashAdvisory };\n",
    );
    await fs.writeFile(path.join(ompDir, 'non-preempting-delivery.ts'), 'export const stashAdvisory = () => {};\n');

    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    const installRoot = path.join(tmpHome, '.papercusp');

    expect(result.extensionWritten).toBe(true);
    expect(await fs.readFile(path.join(installRoot, 'papercusp-coord.ts'), 'utf8')).toContain(
      'non-preempting-delivery',
    );
    expect(await fs.readFile(path.join(installRoot, 'non-preempting-delivery.ts'), 'utf8')).toContain('stashAdvisory');
  });
});

describe('renderSuPlaybook (psu-only-launch-unification P-011)', () => {
  const MARKER = '<!-- PAPERCUSP-SU:CLIENT-TOOLING-OVERLAY -->';

  beforeEach(async () => {
    // The shared base already exists from the outer beforeEach as
    // `# Playbook v1`; replace it with a marker-model base + per-agent
    // overlays so the splice picks the RIGHT client overlay.
    await fs.writeFile(
      path.join(tmpAppRoot, 'prompts', 'papercusp-su-engineer.tools.md'),
      `# Engineer base\n\n${MARKER}\n\n## Tail\n`,
    );
    await fs.writeFile(path.join(tmpAppRoot, 'prompts', 'papercusp-su.claude.md'), '## CLAUDE tooling');
    await fs.writeFile(path.join(tmpAppRoot, 'prompts', 'papercusp-su.omp.md'), '## OMP tooling');
    await fs.writeFile(
      path.join(tmpAppRoot, 'prompts', 'papercusp-su.codex.md'),
      '## CODEX tooling\n\nptool tools:find',
    );
    await fs.writeFile(
      path.join(tmpAppRoot, 'prompts', 'papercusp-su-power.tools.md'),
      `# Power base\n\n${MARKER}\n\n## Tail\n`,
    );
  });

  it('splices the per-agent overlay (claude ≠ omp) into the base, marker never shipped', async () => {
    const claude = await renderSuPlaybook({ agent: 'claude', operatorAppRoot: tmpAppRoot });
    expect(claude.text).toContain('# Engineer base');
    expect(claude.text).toContain('## CLAUDE tooling');
    expect(claude.text).not.toContain('## OMP tooling');
    expect(claude.text).not.toContain(MARKER);
    expect(claude.baseSource).toBe(path.join(tmpAppRoot, 'prompts', 'papercusp-su-engineer.tools.md'));
    expect(claude.overlaySource).toBe(path.join(tmpAppRoot, 'prompts', 'papercusp-su.claude.md'));

    const omp = await renderSuPlaybook({ agent: 'omp', operatorAppRoot: tmpAppRoot });
    expect(omp.text).toContain('## OMP tooling');
    expect(omp.text).not.toContain('## CLAUDE tooling');
  });

  it('renders Codex output advice from the launch policy and retires it when exec is denied', async () => {
    const baseText = `# Output guidance fixture\n${MARKER}\n<!-- PAPERCUSP-SU:RESULT-DOOR -->`;
    const before = await renderSuPlaybook({ agent: 'codex', operatorAppRoot: tmpAppRoot, baseText });
    expect(before.text).toContain('Print only the fields you will use');
    expect(before.text).toContain('// @exec:');
    expect(before.text).not.toContain('Every tool result is capped at');
    const after = await renderSuPlaybook({ agent: 'codex', operatorAppRoot: tmpAppRoot, baseText,
      nativeToolPolicy: { deniedNames: ['functions.exec'] } });
    expect(after.text).not.toContain('// @exec:');
    expect(after.text).not.toContain('Codex native tool output');
    expect(after.text).toContain("Papercusp's per-result door defaults to");
    const claude = await renderSuPlaybook({ agent: 'claude', operatorAppRoot: tmpAppRoot, baseText });
    expect(claude.text).not.toContain('// @exec:');
  });

  it('profile selects the base file (power → papercusp-su-power.tools.md)', async () => {
    const power = await renderSuPlaybook({ agent: 'claude', profile: 'power', operatorAppRoot: tmpAppRoot });
    expect(power.text).toContain('# Power base');
    expect(power.baseSource).toBe(path.join(tmpAppRoot, 'prompts', 'papercusp-su-power.tools.md'));
  });

  it('splices the Codex discovery fallback into the rendered playbook', async () => {
    const codex = await renderSuPlaybook({ agent: 'codex', operatorAppRoot: tmpAppRoot });
    expect(codex.text).not.toContain(MARKER);
    expect(codex.text).toContain('# Engineer base');
    expect(codex.text).toContain('ptool tools:find');
    expect(codex.overlaySource).toBe(path.join(tmpAppRoot, 'prompts', 'papercusp-su.codex.md'));
  });

  it('keeps the canonical Claude overlay explicit that trimmed tools are an initial seed', async () => {
    const canonicalOverlay = await fs.readFile(
      new URL('../../../../../apps/operator/prompts/papercusp-su.claude.md', import.meta.url),
      'utf8',
    );
    expect(canonicalOverlay).toContain('initial seed');
    expect(canonicalOverlay).toContain('tools:invoke({ name, args })');
    expect(canonicalOverlay).not.toContain('You load the full catalog');
  });

  it('keeps the Codex ptool fallback from passing an empty harness scope', async () => {
    const canonicalOverlay = await fs.readFile(
      new URL('../../../../../apps/operator/prompts/papercusp-su.codex.md', import.meta.url),
      'utf8',
    );
    expect(canonicalOverlay).toContain('Never put a shell command containing `${...}` inside a');
    expect(canonicalOverlay).toContain('V8 resolves it before `exec_command` starts');
    expect(canonicalOverlay).toContain('Keep that command in a normal JavaScript string');
    expect(canonicalOverlay).toContain('ptool_scope=(--workspace="${PAPERCUSP_WORKSPACE}")');
    expect(canonicalOverlay).toContain('if [[ -n "${PAPERCUSP_HARNESS_SLUG:-}" ]]');
    expect(canonicalOverlay).toContain('ptool_scope+=(--harness="${PAPERCUSP_HARNESS_SLUG}")');
    expect(canonicalOverlay).toContain('"${ptool_scope[@]}"');
    expect(canonicalOverlay).not.toContain('--harness="$PAPERCUSP_HARNESS_SLUG"');
  });

  it('keeps Codex ptool JSON replay on a shell-safe stdin/file path', async () => {
    const canonicalOverlay = await fs.readFile(
      new URL('../../../../../apps/operator/prompts/papercusp-su.codex.md', import.meta.url),
      'utf8',
    );
    expect(canonicalOverlay).toContain('ptool tools:find --json - "${ptool_scope[@]}" <<\'JSON\'');
    expect(canonicalOverlay).toContain("ptool <group:verb> --json - <<'JSON'");
    // b9482e800e reworded this to "Use the quoted heredoc, or `--json-file` for anything large".
    expect(canonicalOverlay).toContain('`--json-file` for anything large');
    expect(canonicalOverlay).not.toContain("ptool tools:find --json '{");
    expect(canonicalOverlay).not.toContain("ptool <group:verb> --json '{...}'");
  });

  it('throws when the base profile file is missing', async () => {
    await expect(renderSuPlaybook({ agent: 'claude', profile: 'ghost', operatorAppRoot: tmpAppRoot })).rejects.toThrow(
      /papercusp-su-ghost\.tools\.md/,
    );
  });

  // domain-generic-hive-architecture-2026-06-18 P-025 — the GENERIC profile (non-coding work
  // hive) has no bespoke base file by design; it falls back to the engineer base (its DISTINCT
  // behavior — no papercup CLAUDE.md splice — lives in role-launch-spec, not here). Unlike a
  // typo'd profile ('ghost' above), 'generic' must NOT throw.
  it('P-025: generic profile falls back to the engineer base (does not throw)', async () => {
    const generic = await renderSuPlaybook({ agent: 'claude', profile: 'generic', operatorAppRoot: tmpAppRoot });
    expect(generic.text).toContain('# Engineer base');
  });

  // operating-modes consolidation (owner directives 2026-06-24 + 2026-06-30): the one canonical
  // operating-modes clause (operating-modes-policy.ts) — AUTO act-don't-ask + the IDEATE
  // invent-vs-patch switch + the AUTO×IDEATE composition table — is spliced into BOTH the
  // engineer + power su bases at AUTO_MODE_MARKER (the AUTO half used to be hand-copied into
  // papercusp-su-engineer.tools.md only; power had none).
  // identities-v1 P-021 (D-008): the marker now splices the KERNEL half of the modes (state,
  // registration, the implication table, the authority split); the AUTO / IDEATE / DRAIN /
  // AUDIT DEFINITIONS are identity layers bound by registry state, absent from a modes-off render.
  it('splices the kernel operating-modes stub at the AUTO-MODE marker (engineer + power) — no definition rides along', async () => {
    const AUTO_MARKER = '<!-- PAPERCUSP-SU:AUTO-MODE -->';
    for (const [profile, baseName, label] of [
      ['engineer', 'papercusp-su-engineer.tools.md', '# Engineer base'],
      ['power', 'papercusp-su-power.tools.md', '# Power base'],
    ] as const) {
      await fs.writeFile(
        path.join(tmpAppRoot, 'prompts', baseName),
        `${label}\n\n${AUTO_MARKER}\n\n${MARKER}\n\n## Tail\n`,
      );
      const r = await renderSuPlaybook({ agent: 'claude', profile, operatorAppRoot: tmpAppRoot });
      expect(r.text).toContain('## Operating modes — state in the registry, definitions as identity layers');
      expect(r.text).toContain("mode:set { mode:'auto', reason, ownerDirected:true }");
      // the definitions are NOT in a modes-off render (P-021 acceptance)
      expect(r.text).not.toContain('## AUTO mode — the owner\'s switch for "act, don\'t ask"');
      expect(r.text).not.toContain('AUTO mode + the engine loop are the two halves');
      expect(r.text).not.toContain('## IDEATE mode — the owner\'s switch for "invent net-new, don\'t just patch"');
      expect(r.text).not.toContain('IDEATE × AUTO compose');
      // the generated marker comment must never ship literally
      expect(r.text).not.toContain(AUTO_MARKER);
    }
  });

  it('AUTO-MODE marker absent → stub omitted, no literal marker (opt-out base)', async () => {
    // The beforeEach fixture base carries NO auto-mode marker — a base may opt out.
    const r = await renderSuPlaybook({ agent: 'claude', operatorAppRoot: tmpAppRoot });
    expect(r.text).not.toContain('## Operating modes');
    expect(r.text).not.toContain('## AUTO mode');
    expect(r.text).not.toContain('## IDEATE mode');
    expect(r.text).not.toContain('<!-- PAPERCUSP-SU:AUTO-MODE -->');
  });
});

describe('renderSuPlaybook project-guide splice (psu-isolation P-001 / D-002)', () => {
  const GUIDE_MARKER = '<!-- PAPERCUSP-SU:PROJECT-GUIDE -->';

  // identities-v1-2026-08-30 P-022: the per-audience seam. The composer receives the
  // RESOLVED default guide and returns what THIS wearer gets; omitted ⇒ byte-identical.
  it('P-022: composeProjectGuide receives the resolved default and its output is what splices', async () => {
    const guidePath = path.join(tmpAppRoot, 'PROJECT_CLAUDE.md');
    await fs.writeFile(guidePath, '# Repo conventions\nUse nuqs for state.\n');
    const seen: { text: string; source: string }[] = [];
    const r = await renderSuPlaybook({
      agent: 'claude',
      operatorAppRoot: tmpAppRoot,
      projectGuideSource: guidePath,
      composeProjectGuide: async (resolved) => {
        seen.push(resolved);
        return {
          text: `${resolved.text}\n## Addressed guidance\n\nLEADER ONLY\n`,
          truncated: false,
          addressed: { tokens: ['blueprint:su.fleet-leader'], partKeys: ['lead-1'], addedChars: 40 },
        };
      },
    });
    expect(seen).toEqual([{ text: '# Repo conventions\nUse nuqs for state.\n', source: guidePath }]);
    expect(r.text).toContain('Use nuqs for state.');
    expect(r.text).toContain('LEADER ONLY');
    expect(r.projectGuideAddressed).toEqual({ tokens: ['blueprint:su.fleet-leader'], partKeys: ['lead-1'], addedChars: 40 });
  });

  it('P-022: no composer ⇒ byte-identical to the plain splice; no guide ⇒ the composer is never called', async () => {
    const guidePath = path.join(tmpAppRoot, 'PROJECT_CLAUDE.md');
    await fs.writeFile(guidePath, '# Repo conventions\nUse nuqs for state.\n');
    const plain = await renderSuPlaybook({ agent: 'claude', operatorAppRoot: tmpAppRoot, projectGuideSource: guidePath });
    const passthrough = await renderSuPlaybook({
      agent: 'claude',
      operatorAppRoot: tmpAppRoot,
      projectGuideSource: guidePath,
      composeProjectGuide: async (resolved) => ({ text: resolved.text, truncated: false, addressed: null }),
    });
    expect(passthrough.text).toBe(plain.text);
    expect(plain.projectGuideAddressed).toBeNull();
    expect(passthrough.projectGuideAddressed).toBeNull();
    const calls: unknown[] = [];
    const none = await renderSuPlaybook({
      agent: 'claude',
      operatorAppRoot: tmpAppRoot,
      projectGuideSource: '',
      composeProjectGuide: async (resolved) => {
        calls.push(resolved);
        return { text: resolved.text, truncated: false, addressed: null };
      },
    });
    expect(calls).toEqual([]);
    expect(none.projectGuideSource).toBe('');
  });

  beforeEach(async () => {
    await fs.writeFile(
      path.join(tmpAppRoot, 'prompts', 'papercusp-su-engineer.tools.md'),
      `# Engineer base\n\n${GUIDE_MARKER}\n`,
    );
  });

  it('splices an explicit project guide at the marker; marker never shipped', async () => {
    const guidePath = path.join(tmpAppRoot, 'PROJECT_CLAUDE.md');
    await fs.writeFile(guidePath, '# Repo conventions\nUse nuqs for state.\n');
    const r = await renderSuPlaybook({
      agent: 'claude',
      operatorAppRoot: tmpAppRoot,
      projectGuideSource: guidePath,
    });
    expect(r.text).not.toContain(GUIDE_MARKER);
    expect(r.text).toContain('Project guide — repo conventions'); // wrapper header
    expect(r.text).toContain('Use nuqs for state.'); // guide body
    expect(r.projectGuideSource).toBe(guidePath);
  });

  it('explicit empty source ("") → no guide spliced, marker removed', async () => {
    const r = await renderSuPlaybook({
      agent: 'claude',
      operatorAppRoot: tmpAppRoot,
      projectGuideSource: '',
    });
    expect(r.text).not.toContain(GUIDE_MARKER);
    expect(r.text).not.toContain('Project guide — repo conventions');
    expect(r.projectGuideSource).toBe('');
  });

  it('auto-resolves the repo CLAUDE.md by walking up from the prompts dir (engineer default)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcusp-guide-root-'));
    const promptsDir = path.join(root, 'apps', 'operator', 'prompts');
    await fs.mkdir(promptsDir, { recursive: true });
    await fs.writeFile(path.join(promptsDir, 'papercusp-su-engineer.tools.md'), `# Base\n\n${GUIDE_MARKER}\n`);
    await fs.writeFile(path.join(root, 'CLAUDE.md'), '# Papercup guide\nTauri only.\n');
    try {
      const r = await renderSuPlaybook({ agent: 'claude', operatorAppRoot: path.join(root, 'apps', 'operator') });
      expect(r.text).toContain('Tauri only.');
      expect(r.projectGuideSource).toBe(path.join(root, 'CLAUDE.md'));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('base WITHOUT the marker: the (large) guide is neither read nor spliced', async () => {
    await fs.writeFile(path.join(tmpAppRoot, 'prompts', 'papercusp-su-engineer.tools.md'), `# No marker base\n`);
    const guidePath = path.join(tmpAppRoot, 'PROJECT_CLAUDE.md');
    await fs.writeFile(guidePath, '# Should NOT appear\n');
    const r = await renderSuPlaybook({
      agent: 'claude',
      operatorAppRoot: tmpAppRoot,
      projectGuideSource: guidePath,
    });
    expect(r.text).not.toContain('Should NOT appear');
    expect(r.projectGuideSource).toBe('');
  });
});

/**
 * SHARED BASE NOTES reach the LIVE base — the recurrence guard for a 12-day silent drop.
 *
 * WHAT BROKE (2026-08-09). `injectSharedBaseNotes` bundles five clauses authored once in code
 * — deploy-pipeline, wait-loop, peer-wake, COUPLING and state-plane — and anchored them on
 * PROJECT_GUIDE_MARKER, which doubled as its "is this a real su playbook?" test. The LEGACY
 * `.tools.md` bases carry that marker; the BLUEPRINT base does not, and never did. When
 * SU_BLUEPRINT_PERSONA made the blueprint base live, the injector hit its `return text` no-op
 * and shipped NONE of the five, silently, on every interactive render. Measured before the
 * fix: the coupling clause appeared in 6 of 5211 rendered launch contexts.
 *
 * ⚠ WHY THIS TEST RENDERS THE REAL FILE. Every sibling test above builds a synthetic base in
 * a tmp dir, and not one of them could have caught this — a hand-built fixture cannot tell
 * you whether the marker exists in the base that actually ships. Only a check against the
 * PRODUCER can, which is the same lesson `deriveCouplingsFromRoster` records about
 * `current_files` being a real field that is always empty. So this reads the blueprint su.md
 * from the repo, exactly as `buildSuLaunchSpec` resolves it when SU_BLUEPRINT_PERSONA is ON.
 *
 * ⚠ AND WHY IT PASSES `baseSource` EXPLICITLY. `renderSuPlaybook({})` renders the LEGACY base
 * (EI-7075) — which carries PROJECT_GUIDE_MARKER, so the notes land and the test would go
 * green while the live path stayed broken. That false negative is the exact trap this guard
 * exists to close; do not "simplify" it by dropping the argument.
 *
 * The fix deliberately needs NO marker in the base: eligibility is derived from the base
 * being a real su playbook, so a base that never mentions the bundle still receives it. That
 * also keeps the blueprint `.md` unchanged, which matters operationally — prompts go live
 * immediately while operator-core waits for a deploy, so a base edit that only the NEW code
 * understands would leak a raw marker into every live render during the window between them.
 */
describe('shared base notes reach the LIVE blueprint base (recurrence guard)', () => {
  const blueprintBase = new URL(
    '../../../../../libs/papercusp/packages/harness/blueprints/base/prompts/su.md',
    import.meta.url,
  );
  const blueprintHarness = new URL(
    '../../../../../libs/papercusp/packages/harness/',
    import.meta.url,
  );
  const mechanicalDedupClauses = [
    "work_items:get { id, harness: '<item-harness>' }",
    'authoritative claim/state and stored checkpoint',
    'any references it contains for omitted detail',
    'work_items:checkpoint { id, unchanged:true, contentHash }',
    'not rerun a test matrix solely to reconstruct saved proof',
    'authoritative write responses, state reads',
    'not hand-written copies',
    'do NOT send a second completion FYI',
  ] as const;
  const expectMechanicalDedupContract = (text: string) => {
    for (const clause of mechanicalDedupClauses) expect(text).toContain(clause);
  };

  it('keeps current-procedure verification distinct from coord bootstrap', async () => {
    const { text } = await renderSuPlaybook({
      agent: 'claude',
      baseSource: fileURLToPath(blueprintBase),
    });

    // The canonical clause is prose and may be hard-wrapped differently as it evolves;
    // pin its evidence contract, not one historical line break.
    expect(text).toMatch(/verify a current\s+procedure/);
    expect(text).toMatch(/content-bearing read of the relevant current\s+docs, source, or status surface/);
    expect(text).toMatch(/`coord:orient` is\s+coordination bootstrap, not documentation verification/);
    expect(text).toMatch(/injected prompt text or a bare\s+`\{ ok: true \}` result does not satisfy the gate/);
    expect(text).toMatch(/first call returns no procedure\s+evidence, keep reading until one does/);
  });

  it('P-005 renders the mechanical-dedup contract in full and fleet guidance', async () => {
    const baseText = await fs.readFile(fileURLToPath(blueprintBase), 'utf8');
    const memberBase = composeSuStackSource({
      suText: baseText,
      harnessDir: fileURLToPath(blueprintHarness),
      binding: suSessionBinding({ fleetRole: 'member' }),
    }).text;
    const [full, fleet, member] = await Promise.all([
      renderSuPlaybook({ agent: 'claude', baseSource: fileURLToPath(blueprintBase) }),
      renderSuPlaybook({ agent: 'claude', baseSource: fileURLToPath(blueprintBase), tier: 'fleet' }),
      renderSuPlaybook({
        agent: 'claude',
        baseSource: fileURLToPath(blueprintBase),
        baseText: memberBase,
        tier: 'fleet',
      }),
    ]);

    for (const text of [full.text, fleet.text, member.text]) expectMechanicalDedupContract(text);
  });

  it('P-005 copy-out mutants fail when any mechanical-dedup clause is removed', async () => {
    const { text } = await renderSuPlaybook({ agent: 'claude', baseSource: fileURLToPath(blueprintBase) });
    for (const clause of mechanicalDedupClauses) {
      expect(text, `positive control must contain ${clause}`).toContain(clause);
      expect(() => expectMechanicalDedupContract(text.replace(clause, ''))).toThrow();
    }
  });

  it('renders all five shared notes, and leaks no marker', async () => {
    const { text } = await renderSuPlaybook({
      agent: 'claude',
      baseSource: fileURLToPath(blueprintBase),
    });
    // One assertion per note, named, so a future drop says WHICH clause went missing rather
    // than "the bundle changed".
    expect(text, 'coupling note (D-061/D-062: owner said ALL agents)').toContain('## Coupling');
    expect(text, 'coupling note must teach the declaration verb').toContain('coord:couple');
    expect(text, 'coupling note must teach the DECOUPLE trigger (D-062)').toContain('coord:decouple');
    expect(text, 'peer-wake note').toMatch(/wake/i);
    expect(text, 'state-plane note').toContain('state:read');
    // EI-20684628463114889: gateway-routed psu sessions cannot use Claude's native
    // Artifact connector. Keep the capability wall and durable fallback in the
    // live rendered prompt so an empty WebFetch shell is not mistaken for content.
    expect(text, 'gateway Artifact capability guard').toContain('ANTHROPIC_AUTH_TOKEN');
    expect(text, 'gateway Artifact capability guard').toContain('native `Artifact` connector is unavailable');
    expect(text, 'gateway Artifact capability guard').toContain('empty client-rendered shell');
    // No internal marker may ever reach a rendered prompt (psu-prompt-isolation).
    expect(text).not.toContain('PAPERCUSP-SU:SHARED-BASE-NOTES');
  });

  it('renders the complete activation-audit workflow with runtime materiality parity', async () => {
    const { text } = await renderSuPlaybook({
      agent: 'claude',
      baseSource: fileURLToPath(blueprintBase),
    });

    expect(text).toContain('Audit the complete source conversation before activating a draft plan');
    expect(text).toContain("plans:audit { phase:'activation', ... }");
    expect(text).toContain('map each to a plan section, D-NNN, or P-NNN');
    expect(text).toContain('`activationAudit` metadata');
    expect(text).toContain('audited/current revisions');
    for (const obligation of [
      'requirement', 'scope boundary', 'constraint', 'correction', 'rejected', 'decision',
      'dependency', 'sequence', 'acceptance condition', 'unresolved question', 'promised follow-up',
    ]) {
      expect(text).toMatch(new RegExp(obligation.replaceAll(' ', '\\s+')));
    }
    for (const material of [
      'requirements', 'scope', 'constraints', 'decisions', 'dependencies', 'sequencing',
      'acceptance criteria', 'open questions', 'promised follow-ups',
    ]) {
      expect(text).toContain(material);
    }
    for (const cosmetic of ['Spelling', 'formatting', 'cosmetic-only']) {
      expect(text).toContain(cosmetic);
    }
  });

  it('ABM-P002: every live blueprint tier renders the universal anti-babysitting contract', async () => {
    const renders = await Promise.all([
      renderSuPlaybook({ agent: 'claude', baseSource: fileURLToPath(blueprintBase) }),
      renderSuPlaybook({ agent: 'claude', baseSource: fileURLToPath(blueprintBase), tier: 'fleet' }),
    ]);

    for (const { text } of renders) {
      expect(text).toContain('## Anti-babysitting rule — monitoring is not work by default');
      expect(text).toContain('AUTO authorizes execution; it does not create a monitoring mission');
      expect(text).toContain('Fixing is work;\nwatching someone else fix is not');
      expect(text).toContain('The interactive owner explicitly requested ongoing monitoring');
      expect(text).toContain('holds the work-item or leadership role');
      expect(text).toContain('No other live agent already owns and is progressing');
      expect(text).toContain('The transition unlocks a concrete action');
      expect(text).toContain('named stop condition and a bounded no-delta budget');
      expect(text).toContain('do not create a parallel supervisor');
      expect(text).toContain('do not arm a fallback loop');
      expect(text).toContain('one no-delta wake is terminal: `loop:end`');
      expect(text).toContain("system routines or a registered fleet leader's\nreal supervision duties");
      expect(text).toContain('A red release/CI gate has exactly ONE fixer');
      expect(text).toContain("state:read { cell: 'gate.greenCheckpoint.ownership' }");
      expect(text).toContain('Scope this exclusivity to `LIVE_GATE_OPS` only');
      expect(text).toContain('you are DONE\n  with `LIVE_GATE_OPS`, not with every gate-related task');
      expect(text).toContain('does **not** reserve `GATE_SYSTEM_DEV`');
      expect(text).toContain('continues under its own work-item/plan lane and file locks');
      expect(text).toContain('end the whole task only when every remaining step genuinely depends');
      expect(text).not.toContain("a days-red gate is everyone's problem");
    }
  });

  it.each(['claude', 'codex', 'omp'] as const)(
    '%s renders self-owned gate responsibility before the peer stand-down rule in both tiers',
    async (agent) => {
      const renders = await Promise.all([
        renderSuPlaybook({ agent, baseSource: fileURLToPath(blueprintBase) }),
        renderSuPlaybook({ agent, baseSource: fileURLToPath(blueprintBase), tier: 'fleet' }),
      ]);

      for (const { text } of renders) {
        // Assert booleans so a regression does not dump the entire assembled persona.
        expect(text.includes('Compare `gate.ownership.takenBy` with your own verified owner identity')).toBe(true);
        expect(text.includes('Held by YOU ⇒ continue `LIVE_GATE_OPS`')).toBe(true);
        expect(text.includes('Held by ANOTHER live agent ⇒ you are DONE')).toBe(true);
        expect(text.includes('Never stand down merely because your own claim is held-live')).toBe(true);
        expect(text.indexOf('Held by YOU')).toBeLessThan(text.indexOf('Held by ANOTHER'));
        expect(/Held by a live agent ⇒ you are DONE/.test(text)).toBe(false);
      }
    },
  );

  /**
   * THE CONTROL. Without it this suite passes even if `injectSharedBaseNotes` were changed to
   * append unconditionally — which would push the notes into minimal/test bases that are
   * meant to stay bare, breaking the no-append contract every other section here honours.
   * A guard with no control tells you the notes are SOMEWHERE, not that the anchoring works.
   */
  it('a base carrying NEITHER anchor is still returned untouched', async () => {
    const bare = path.join(tmpAppRoot, 'prompts', 'papercusp-su-bare.tools.md');
    await fs.writeFile(bare, '# Bare base\n\nnothing here.\n');
    const { text } = await renderSuPlaybook({ agent: 'claude', baseSource: bare });
    expect(text).not.toContain('## Coupling');
    expect(text).not.toContain('coord:couple');
  });
});

/**
 * WI-6554700010009448: a desktop install provisions the pinned RTK binary. Every RTK
 * seam looks for ~/.local/bin/rtk and fails OPEN without it, so a removed provisioning
 * step is silent at runtime. These fail if the installer stops handing install-rtk.sh
 * to provisioning, if provisioning stops running it, or if the sidecar stops shipping it.
 */
describe('RTK binary provisioning (WI-6554700010009448)', () => {
  const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
  const REAL_INSTALLER = path.join(REPO_ROOT, 'apps', 'operator', 'scripts', 'install-rtk.sh');
  const ok: RtkInstallOutcome = { exitCode: 0, signal: null, stderrTail: '' };

  async function writeFakeInstaller(version = '9.9.9'): Promise<string> {
    const script = path.join(tmpAppRoot, 'scripts', 'install-rtk.sh');
    await fs.writeFile(script, `#!/usr/bin/env bash\nRTK_VERSION="${version}"\nexit 0\n`);
    return script;
  }

  it('installPapercuspFiles hands the shipped install-rtk.sh to provisioning and reports its status', async () => {
    const script = await writeFakeInstaller();
    const provision = vi.fn(async () => ({
      result: { status: 'started' as const, script, pinnedVersion: '9.9.9' },
      done: null,
    }));
    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot, provisionRtk: provision });
    expect(provision).toHaveBeenCalledTimes(1);
    expect(provision).toHaveBeenCalledWith({ home: tmpHome, script });
    expect(result.rtkProvision).toEqual({ status: 'started', script, pinnedVersion: '9.9.9' });
  });

  it('by default installs nothing into an overridden home (the seams read the real one)', async () => {
    await writeFakeInstaller();
    const result = await installPapercuspFiles({ home: tmpHome, operatorAppRoot: tmpAppRoot });
    expect(result.rtkProvision.status).toBe('home-override');
    await expect(fs.access(path.join(tmpHome, '.local', 'bin', 'rtk'))).rejects.toThrow();
  });

  it('runs nothing when ~/.local/bin/rtk already reports the pinned version', async () => {
    const script = await writeFakeInstaller('9.9.9');
    const runScript = vi.fn(async () => ok);
    const probeVersion = vi.fn(async () => '9.9.9');
    const h = await provisionRtk({ home: tmpHome, realHome: tmpHome, script, probeVersion, runScript });
    expect(h.result).toEqual({ status: 'current', script, pinnedVersion: '9.9.9' });
    expect(probeVersion).toHaveBeenCalledWith(path.join(tmpHome, '.local', 'bin', 'rtk'));
    expect(runScript).not.toHaveBeenCalled();
  });

  it('starts the script in the background when rtk is missing or outdated, one run at a time', async () => {
    const script = await writeFakeInstaller('9.9.9');
    let finish: (o: RtkInstallOutcome) => void = () => {};
    const runScript = vi.fn(() => new Promise<RtkInstallOutcome>((resolve) => (finish = resolve)));
    const probeVersion = async () => '9.9.8';
    const first = await provisionRtk({ home: tmpHome, realHome: tmpHome, script, probeVersion, runScript });
    expect(first.result.status).toBe('started');
    expect(runScript).toHaveBeenCalledWith(script, tmpHome);
    const second = await provisionRtk({ home: tmpHome, realHome: tmpHome, script, probeVersion, runScript });
    expect(second.result.status).toBe('in-flight');
    expect(second.done).toBe(first.done);
    expect(runScript).toHaveBeenCalledTimes(1);
    finish(ok);
    await expect(first.done).resolves.toEqual(ok);
    // The run is over, so a later install may start another.
    const third = await provisionRtk({ home: tmpHome, realHome: tmpHome, script, probeVersion, runScript });
    expect(third.result.status).toBe('started');
    finish(ok);
    await third.done;
  });

  it('logs a failed run and lets the next install retry', async () => {
    const script = await writeFakeInstaller();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runScript = vi.fn(async () => ({ exitCode: 1, signal: null, stderrTail: '✗ rtk: download failed: x\n' }));
    const h = await provisionRtk({ home: tmpHome, realHome: tmpHome, script, probeVersion: async () => null, runScript });
    await h.done;
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('download failed');
    const again = await provisionRtk({ home: tmpHome, realHome: tmpHome, script, probeVersion: async () => null, runScript });
    expect(again.result.status).toBe('started');
    await again.done;
    warn.mockRestore();
  });

  it('skips Windows and a layout with no shipped script, without running anything', async () => {
    const runScript = vi.fn(async () => ok);
    const script = await writeFakeInstaller();
    const win = await provisionRtk({ home: tmpHome, realHome: tmpHome, script, platform: 'win32', runScript });
    expect(win.result.status).toBe('unsupported-platform');
    const none = await provisionRtk({ home: tmpHome, realHome: tmpHome, script: null, platform: 'linux', runScript });
    expect(none.result.status).toBe('script-missing');
    expect(runScript).not.toHaveBeenCalled();
  });

  it('resolves install-rtk.sh where the sidecar ships it, and reads its pin from the real script', async () => {
    const appRoot = path.join(REPO_ROOT, 'apps', 'operator');
    expect(rtkInstallerCandidates(appRoot, true)).toEqual([REAL_INSTALLER]);
    expect(readPinnedRtkVersion(await fs.readFile(REAL_INSTALLER, 'utf8'))).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('build-desktop-sidecar.sh ships install-rtk.sh to the path provisioning resolves', async () => {
    const build = await fs.readFile(path.join(REPO_ROOT, 'papercusp-desktop', 'bin', 'build-desktop-sidecar.sh'), 'utf8');
    expect(build).toMatch(/RTK_INSTALLER_SRC="\$WEB_DIR\/scripts\/install-rtk\.sh"/);
    expect(build).toMatch(/cp -a "\$RTK_INSTALLER_SRC" "\$SIDECAR_DIR\/apps\/operator\/scripts\/install-rtk\.sh"/);
  });

  it('end to end: the real install-rtk.sh installs a fake pinned release, then the next call is current', async () => {
    const pinned = readPinnedRtkVersion(await fs.readFile(REAL_INSTALLER, 'utf8'));
    const releaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pcusp-rtk-release-'));
    try {
      const stage = path.join(releaseDir, 'stage');
      await fs.mkdir(stage);
      await fs.writeFile(path.join(stage, 'rtk'), `#!/bin/sh\necho "rtk ${pinned}"\n`, { mode: 0o755 });
      const asset = 'rtk-x86_64-unknown-linux-musl.tar.gz';
      const tar = spawnSync('tar', ['-czf', path.join(releaseDir, asset), '-C', stage, 'rtk']);
      expect(tar.status).toBe(0);
      const sha = createHash('sha256')
        .update(await fs.readFile(path.join(releaseDir, asset)))
        .digest('hex');
      vi.stubEnv('RTK_INSTALL_URL_BASE', `file://${releaseDir}`);
      vi.stubEnv('RTK_INSTALL_PLATFORM', 'Linux x86_64');
      vi.stubEnv('RTK_INSTALL_EXPECTED_SHA256', sha);
      vi.stubEnv('RTK_INSTALL_DIR', '');

      const first = await provisionRtk({ home: tmpHome, realHome: tmpHome, script: REAL_INSTALLER, platform: 'linux' });
      expect(first.result).toEqual({ status: 'started', script: REAL_INSTALLER, pinnedVersion: pinned });
      const outcome = await first.done;
      expect(outcome?.exitCode).toBe(0);

      const second = await provisionRtk({ home: tmpHome, realHome: tmpHome, script: REAL_INSTALLER, platform: 'linux' });
      expect(second.result.status).toBe('current');
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(releaseDir, { recursive: true, force: true });
    }
  });
});
