/**
 * WI-4440: the psu/ptool CLI shim must resolve its target launcher at RUN
 * time from the active integration/release root, never bake in whichever
 * operator tree happened to run installPapercuspFiles last.
 *
 * On a dev box both the green release operator (:3070) and the staging
 * operator (:3170) call installPapercuspFiles() on their own boot — the OLD
 * shim hardcoded an absolute launcher path, so the shared ~/.papercusp/bin/psu
 * silently flipped between the release and staging launcher depending on
 * which operator booted last (observed live 2026-07-12: an identical `psu
 * --fork` command 10 minutes apart resolved to two different launcher trees).
 *
 * The fix (writeShim / shimRuntimeOptions) makes the shim a small bash
 * script that resolves its launcher at EXEC time: an explicit per-process
 * override env, then PAPERCUSP_INTEGRATION_ROOT, then PAPERCUSP_RELEASE_ROOT,
 * then the install-time fallback (captured release root + the literal
 * launcher path passed to installPapercuspFiles). It also prints the
 * resolved launcher path to stderr so a stale/wrong resolution is visible
 * instead of a silent no-op.
 */
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { shimRuntimeOptions, writeShim } from './papercusp-files';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'shim-runtime-'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('shimRuntimeOptions (WI-4440)', () => {
  it('does NOT derive any fallback from the live PAPERCUSP_INTEGRATION_ROOT — only the release root + the literal install-time launcher path are captured', async () => {
    // The whole point of runtime resolution is that the integration root is
    // read live at exec time (via the shim script), never baked at install
    // time — embedding it here would recreate the exact boot-order race
    // this shim exists to fix. Use a launcher path OUTSIDE the integration
    // root so a false pass can't hide behind the literal-launcher-path
    // fallback (which legitimately always includes launcherPath itself).
    vi.stubEnv('PAPERCUSP_INTEGRATION_ROOT', '/some/integration/tree');
    vi.stubEnv('PAPERCUSP_RELEASE_ROOT', '/some/release/tree');
    const launcherPath = '/opt/packaged/apps/operator/scripts/psu-launcher.mjs';
    const opts = shimRuntimeOptions(launcherPath, 'PAPERCUSP_PSU_LAUNCHER');
    for (const fallback of opts.fallbackLaunchers) {
      expect(fallback).not.toContain('/some/integration/tree');
    }
    // The release root DOES seed an install-time fallback candidate.
    expect(
      opts.fallbackLaunchers.some((f) => f.startsWith('/some/release/tree')),
    ).toBe(true);
    // The literal launcher path passed in is always the final fallback.
    expect(opts.fallbackLaunchers).toContain(launcherPath);
  });

  it('falls back to the literal launcher path when no release root is set', () => {
    vi.stubEnv('PAPERCUSP_RELEASE_ROOT', '');
    const launcherPath = '/opt/papercusp/apps/operator/scripts/psu-launcher.mjs';
    const opts = shimRuntimeOptions(launcherPath, 'PAPERCUSP_PSU_LAUNCHER');
    expect(opts.fallbackLaunchers).toEqual([launcherPath]);
  });
});

describe('writeShim (WI-4440) — the generated script resolves at run time, not install time', () => {
  it('checks PAPERCUSP_CANONICAL_TREE before the serving integration and release roots', async () => {
    const shimPath = path.join(tmp, 'psu');
    const launcherPath = path.join(tmp, 'release', 'apps', 'operator', 'scripts', 'psu-launcher.mjs');
    const runtime = shimRuntimeOptions(launcherPath, 'PAPERCUSP_PSU_LAUNCHER');
    await writeShim(shimPath, launcherPath, 'superuser launcher (psu)', runtime);
    const body = await fs.readFile(shimPath, 'utf8');

    // The declared edit tree wins when it differs from the serving mirror,
    // then the release root.
    const canonicalIdx = body.indexOf('PAPERCUSP_CANONICAL_TREE');
    const integrationIdx = body.indexOf('PAPERCUSP_INTEGRATION_ROOT');
    const releaseIdx = body.indexOf('PAPERCUSP_RELEASE_ROOT');
    expect(canonicalIdx).toBeGreaterThan(-1);
    expect(integrationIdx).toBeGreaterThan(-1);
    expect(releaseIdx).toBeGreaterThan(-1);
    expect(canonicalIdx).toBeLessThan(integrationIdx);
    expect(integrationIdx).toBeLessThan(releaseIdx);

    // The explicit per-process override is checked first of all.
    const explicitIdx = body.indexOf('PAPERCUSP_PSU_LAUNCHER');
    expect(explicitIdx).toBeGreaterThan(-1);
    expect(explicitIdx).toBeLessThan(integrationIdx);

    // Refuses to silently resolve nothing: an unresolved launcher exits
    // non-zero with a message naming the override env, not a bare crash.
    expect(body).toContain('no launcher found');
    expect(body).toContain('return 127');
  });

  it('prints the resolved launcher path to stderr — a stale resolution is visible, not a silent no-op', async () => {
    const shimPath = path.join(tmp, 'psu');
    const launcherPath = path.join(tmp, 'release', 'apps', 'operator', 'scripts', 'psu-launcher.mjs');
    const runtime = shimRuntimeOptions(launcherPath, 'PAPERCUSP_PSU_LAUNCHER');
    await writeShim(shimPath, launcherPath, 'superuser launcher (psu)', runtime);
    const body = await fs.readFile(shimPath, 'utf8');
    expect(body).toContain('launcher="$(resolve_launcher)"');
    expect(body).toMatch(/superuser launcher \(psu\): launcher/);
    expect(body).toContain('>&2');
  });

  it('keeps HTTP-only inspector publication on the launcher without exporting it to native children', async () => {
    const shimPath = path.join(tmp, 'psu');
    const launcherPath = path.join(tmp, 'psu-launcher.mjs');
    await fs.writeFile(launcherPath, `
      import { execFileSync } from 'node:child_process';
      process.stdout.write(JSON.stringify({
        nodeOptions: process.env.NODE_OPTIONS,
        execArgv: process.execArgv,
        childNodeOptions: execFileSync(process.execPath,
          ['-e', 'process.stdout.write(process.env.NODE_OPTIONS ?? "")'], { encoding: 'utf8' }),
      }));
    `);
    await writeShim(
      shimPath,
      launcherPath,
      'superuser launcher (psu)',
      shimRuntimeOptions(launcherPath, 'PAPERCUSP_PSU_LAUNCHER'),
    );
    const inherited = '--max-old-space-size=131072 --expose-gc';
    const result = spawnSync(shimPath, [], {
      encoding: 'utf8',
      env: { ...process.env, HOME: tmp, NODE_OPTIONS: inherited, PAPERCUSP_PSU_LAUNCHER: launcherPath },
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      nodeOptions: inherited,
      execArgv: ['--inspect-publish-uid=http'],
      childNodeOptions: inherited,
    });

    const explicit = spawnSync(shimPath, [], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: tmp,
        NODE_OPTIONS: '--inspect-publish-uid=http,stderr',
        PAPERCUSP_PSU_LAUNCHER: launcherPath,
      },
    });
    expect(explicit.status).toBe(0);
    expect(JSON.parse(explicit.stdout)).toEqual({
      nodeOptions: '--inspect-publish-uid=http,stderr',
      execArgv: [],
      childNodeOptions: '--inspect-publish-uid=http,stderr',
    });
  });

  it('executes the canonical edit-tree launcher when the serving mirror differs', async () => {
    const shimPath = path.join(tmp, 'ptool');
    const canonicalRoot = path.join(tmp, 'canonical');
    const servingRoot = path.join(tmp, 'serving-mirror');
    const canonicalLauncher = path.join(canonicalRoot, 'apps', 'operator', 'scripts', 'ptool.mjs');
    const servingLauncher = path.join(servingRoot, 'apps', 'operator', 'scripts', 'ptool.mjs');
    await fs.mkdir(path.dirname(canonicalLauncher), { recursive: true });
    await fs.mkdir(path.dirname(servingLauncher), { recursive: true });
    await fs.writeFile(canonicalLauncher, "process.stdout.write('canonical');\n");
    await fs.writeFile(servingLauncher, "process.stdout.write('serving-mirror');\n");

    vi.stubEnv('PAPERCUSP_RELEASE_ROOT', '');
    const runtime = shimRuntimeOptions(servingLauncher, 'PAPERCUSP_PTOOL_LAUNCHER');
    await writeShim(shimPath, servingLauncher, 'defineTool CLI (ptool)', runtime);
    const result = spawnSync(shimPath, [], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: tmp,
        PAPERCUSP_PTOOL_LAUNCHER: '',
        PAPERCUSP_CANONICAL_TREE: canonicalRoot,
        PAPERCUSP_INTEGRATION_ROOT: servingRoot,
        PAPERCUSP_RELEASE_ROOT: '',
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('canonical');
    expect(result.stderr).toContain(canonicalLauncher);
    expect((await fs.readFile(shimPath, 'utf8'))).not.toContain('--inspect-publish-uid=http');
  });

  it('an explicit per-process override wins outright when the file exists', async () => {
    const shimPath = path.join(tmp, 'psu');
    const overridePath = path.join(tmp, 'override-launcher.mjs');
    await fs.mkdir(path.dirname(overridePath), { recursive: true });
    await fs.writeFile(overridePath, '// override launcher\n');
    const launcherPath = path.join(tmp, 'release', 'apps', 'operator', 'scripts', 'psu-launcher.mjs');
    const runtime = shimRuntimeOptions(launcherPath, 'PAPERCUSP_PSU_LAUNCHER');
    await writeShim(shimPath, launcherPath, 'superuser launcher (psu)', runtime);
    const body = await fs.readFile(shimPath, 'utf8');

    // The generated resolver checks the override env + `-f` existence before
    // ever consulting PAPERCUSP_INTEGRATION_ROOT / PAPERCUSP_RELEASE_ROOT.
    const overrideCheckIdx = body.indexOf('${PAPERCUSP_PSU_LAUNCHER:-}');
    const integrationIdx = body.indexOf('PAPERCUSP_INTEGRATION_ROOT');
    expect(overrideCheckIdx).toBeGreaterThan(-1);
    expect(overrideCheckIdx).toBeLessThan(integrationIdx);
  });
});
