import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  buildOnboardingSetupSpec,
  buildFrameworkInstallSpec,
  buildInstallSpec,
  resolveConciergeScript,
} from './setup-pty-commands';

const HOME = '/home/tester';

describe('buildFrameworkInstallSpec', () => {
  it('claude on linux curls the official installer', () => {
    const spec = buildFrameworkInstallSpec('claude', 'linux', HOME);
    expect(spec.command).toBe('bash');
    const script = spec.args.join(' ');
    expect(script).toContain('https://claude.ai/install.sh');
    // Only the chosen framework — no meridian/codex spill-over.
    expect(script).not.toContain('@rynfar/meridian');
    expect(script).not.toContain('@openai/codex');
  });

  it('codex on linux installs @openai/codex into the shared runtime prefix', () => {
    const spec = buildFrameworkInstallSpec('codex', 'linux', HOME);
    const script = spec.args.join(' ');
    expect(script).toContain('npm install --prefix ~/.papercusp/runtime');
    expect(script).toContain('@openai/codex@latest');
    expect(script).not.toContain('claude.ai/install');
  });

  it('runtime installs bootstrap a package.json so npm --prefix behaves', () => {
    for (const framework of ['codex'] as const) {
      const script = buildFrameworkInstallSpec(framework, 'linux', HOME).args.join(' ');
      expect(script).toContain('npm init -y');
    }
  });

  it.each(['linux', 'darwin'])('codex on %s offers the official standalone installer when npm is absent', (os) => {
    const script = buildFrameworkInstallSpec('codex', os, HOME).args[1];
    expect(script).toContain('if command -v npm');
    expect(script).toContain('https://chatgpt.com/codex/install.sh');
    expect(script).toContain('set -e -o pipefail');
  });

  it.skipIf(process.platform === 'win32')('executes the Codex standalone install branch with no npm on PATH', () => {
    const root = mkdtempSync(join(tmpdir(), 'psu-codex-no-npm-'));
    try {
      const bins = join(root, 'bin');
      mkdirSync(bins);
      symlinkSync('/bin/sh', join(bins, 'sh'));
      const upstream = join(root, 'stub-official-installer.sh');
      writeFileSync(upstream, '#!/bin/sh\n/bin/mkdir -p "$HOME/.local/bin"\nprintf "installed without npm" > "$HOME/.local/bin/codex"\n');
      // Stub only the download; execute the generated installer shell unchanged.
      writeFileSync(join(bins, 'curl'), '#!/bin/sh\n/bin/cat "$CODEX_STUB_INSTALLER"\n', { mode: 0o755 });
      const spec = buildFrameworkInstallSpec('codex', process.platform, root);
      const result = spawnSync('/bin/bash', spec.args, {
        cwd: root, encoding: 'utf8',
        env: { HOME: root, PATH: bins, CODEX_STUB_INSTALLER: upstream },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(join(root, '.local/bin/codex'), 'utf8')).toBe('installed without npm');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('win32 uses powershell for claude and codex', () => {
    for (const framework of ['claude', 'codex'] as const) {
      const spec = buildFrameworkInstallSpec(framework, 'win32', HOME);
      expect(spec.command).toBe('powershell.exe');
    }
    expect(buildFrameworkInstallSpec('claude', 'win32', HOME).args.join(' ')).toContain(
      'https://claude.ai/install.ps1',
    );
    const claudeScript = buildFrameworkInstallSpec('claude', 'win32', HOME).args.join(' ');
    const progressGuard = "$ProgressPreference = 'SilentlyContinue'";
    expect(claudeScript).toContain(progressGuard);
    expect(claudeScript.indexOf(progressGuard)).toBeLessThan(
      claudeScript.indexOf('Invoke-WebRequest'),
    );
    expect(buildFrameworkInstallSpec('codex', 'win32', HOME).args.join(' ')).toContain(
      '@openai/codex@latest',
    );
  });

});

describe('onboarding concierge spec (P-003)', () => {
  it('resolveConciergeScript walks the fallback chain from cwd', () => {
    const hit = '/srv/operator/scripts/onboard-launcher.mjs';
    expect(resolveConciergeScript('/srv/operator', (p) => p === hit)).toBe(hit);
    expect(
      resolveConciergeScript('/srv/repo', (p) => p === '/srv/repo/apps/operator/scripts/onboard-launcher.mjs'),
    ).toBe('/srv/repo/apps/operator/scripts/onboard-launcher.mjs');
    expect(resolveConciergeScript('/nowhere', () => false)).toBeNull();
  });

  it('resolveConciergeScript finds the PACKAGED name onboard.mjs (build renames it)', () => {
    // build-desktop-sidecar.sh esbuilds onboard-launcher.mjs -> scripts/onboard.mjs.
    // The packaged sidecar has ONLY onboard.mjs (no -launcher). Regression guard
    // for the live Windows bug (2026-07-04) where the resolver missed it and the
    // Onboarding Console dead-ended on its GUI-wizard fallback.
    const packaged = '/mnt/c/App/sidecar/scripts/onboard.mjs';
    expect(resolveConciergeScript('/mnt/c/App/sidecar', (p) => p === packaged)).toBe(packaged);
    // onboard.mjs one level up (cwd/../scripts) also resolves.
    const up = '/mnt/c/App/sidecar/../scripts/onboard.mjs';
    expect(resolveConciergeScript('/mnt/c/App/sidecar', (p) => p === up)).toBe(up);
  });

  it('buildOnboardingSetupSpec opens the unified shell on the SETUP tab (owner 2026-07-07), absolute node + threaded origin', () => {
    const spec = buildOnboardingSetupSpec(
      '/srv/operator/scripts/onboard-launcher.mjs',
      'http://127.0.0.1:3070',
      HOME,
      '/usr/local/bin/node',
    );
    // The Tauri pty child inherits NO PATH — a bare `node` would not resolve.
    expect(spec.command).toBe('/usr/local/bin/node');
    // --tab=setup routes onboard-launcher straight to the unified Tutorial|Setup
    // shell on the Setup tab (NOT the linear chat concierge) — the first thing
    // onboarding shows is the setup checklist.
    expect(spec.args).toEqual(['/srv/operator/scripts/onboard-launcher.mjs', '--tab=setup']);
    expect(spec.env.PAPERCUSP_OPERATOR_URL).toBe('http://127.0.0.1:3070');
    expect(spec.cwd).toBe(HOME);
  });
});

describe('buildInstallSpec (wizard all-in-one)', () => {
  it('installs claude + codex on linux, never meridian (decommissioned)', () => {
    const script = buildInstallSpec('linux', HOME).args.join(' ');
    expect(script).toContain('claude.ai/install.sh');
    expect(script).toContain('@openai/codex');
    expect(script).not.toContain('@rynfar/meridian');
  });

  it('windows suppresses Invoke-WebRequest progress records before downloading', () => {
    const script = buildInstallSpec('win32', 'C:\\Users\\u').args.join(' ');
    const progressGuard = "$ProgressPreference = 'SilentlyContinue'";
    expect(script).toContain(progressGuard);
    expect(script.indexOf(progressGuard)).toBeLessThan(script.indexOf('Invoke-WebRequest'));
  });
});
