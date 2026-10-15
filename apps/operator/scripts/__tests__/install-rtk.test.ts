/**
 * install-rtk.sh (WI-6554700010009291, owner directives #1759 / #1764).
 *
 * RTK disappeared once because nobody owned its binary: it lived in the
 * Homebrew prefix, the prefix was rebuilt, and both RTK seams fail open on a
 * missing binary, so nothing noticed. The installer now provisions a pinned,
 * sha256-verified release. These tests run the real script against a FAKE
 * release served from a local directory (file:// URLs, no network) and pin:
 *  - a verified release installs and reports the pinned version;
 *  - a checksum mismatch refuses and leaves nothing behind;
 *  - an already-current binary is left alone with no download attempted;
 *  - install-standalone-mcp.sh actually invokes the installer, so the
 *    provisioning cannot be dropped from the main install path unnoticed.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPTS = join(__dirname, '..');
const INSTALLER = join(SCRIPTS, 'install-rtk.sh');
const PINNED_VERSION = /^RTK_VERSION="([^"]+)"$/m.exec(readFileSync(INSTALLER, 'utf8'))![1]!;
const ASSET = 'rtk-x86_64-unknown-linux-musl.tar.gz';

let root: string;
let releaseDir: string;
let installDir: string;

/** Build a fake release tarball whose `rtk` prints `rtk <version>`. Returns its sha256. */
function fakeRelease(version: string): string {
  const stage = join(root, 'stage');
  mkdirSync(stage, { recursive: true });
  const bin = join(stage, 'rtk');
  writeFileSync(bin, `#!/bin/sh\n[ "$1" = --version ] && echo "rtk ${version}"\n`);
  chmodSync(bin, 0o755);
  const tar = spawnSync('tar', ['-czf', join(releaseDir, ASSET), '-C', stage, 'rtk']);
  expect(tar.status).toBe(0);
  return createHash('sha256').update(readFileSync(join(releaseDir, ASSET))).digest('hex');
}

function runInstaller(env: Record<string, string>) {
  return spawnSync('bash', [INSTALLER], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: root,
      TMPDIR: root,
      RTK_INSTALL_DIR: installDir,
      RTK_INSTALL_URL_BASE: `file://${releaseDir}`,
      RTK_INSTALL_PLATFORM: 'Linux x86_64',
      ...env,
    },
    timeout: 30_000,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'install-rtk-'));
  releaseDir = join(root, 'release');
  installDir = join(root, 'bin');
  mkdirSync(releaseDir);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('install-rtk.sh', () => {
  it('installs a sha256-verified release that reports the pinned version', () => {
    const sha = fakeRelease(PINNED_VERSION);
    const res = runInstaller({ RTK_INSTALL_EXPECTED_SHA256: sha });
    expect(res.status, res.stderr).toBe(0);
    const installed = spawnSync(join(installDir, 'rtk'), ['--version'], { encoding: 'utf8' });
    expect(installed.stdout.trim()).toBe(`rtk ${PINNED_VERSION}`);
  });

  it('refuses a release whose sha256 does not match, and installs nothing', () => {
    fakeRelease(PINNED_VERSION);
    const res = runInstaller({ RTK_INSTALL_EXPECTED_SHA256: '0'.repeat(64) });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/sha256 mismatch/);
    expect(existsSync(join(installDir, 'rtk'))).toBe(false);
  });

  it('refuses the real pinned hash for a tampered (fake) asset', () => {
    fakeRelease(PINNED_VERSION);
    const res = runInstaller({});
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/sha256 mismatch/);
  });

  it('leaves an already-current binary alone without downloading', () => {
    mkdirSync(installDir);
    const bin = join(installDir, 'rtk');
    writeFileSync(bin, `#!/bin/sh\necho "rtk ${PINNED_VERSION}"\n`);
    chmodSync(bin, 0o755);
    // No asset exists in releaseDir, so any download attempt would fail.
    const res = runInstaller({});
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/already installed/);
  });

  it('replaces an outdated binary', () => {
    mkdirSync(installDir);
    const bin = join(installDir, 'rtk');
    writeFileSync(bin, '#!/bin/sh\necho "rtk 0.0.1"\n');
    chmodSync(bin, 0o755);
    const sha = fakeRelease(PINNED_VERSION);
    const res = runInstaller({ RTK_INSTALL_EXPECTED_SHA256: sha });
    expect(res.status, res.stderr).toBe(0);
    expect(spawnSync(bin, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe(`rtk ${PINNED_VERSION}`);
  });

  it('exits 2 on a platform with no pinned release', () => {
    const res = runInstaller({ RTK_INSTALL_PLATFORM: 'Plan9 mips' });
    expect(res.status).toBe(2);
  });

  it('pins a sha256 for every supported platform', () => {
    const source = readFileSync(INSTALLER, 'utf8');
    const pins = [...source.matchAll(/pinned="([0-9a-f]+)"/g)].map((m) => m[1]!);
    expect(pins).toHaveLength(4);
    for (const pin of pins) expect(pin).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('install-standalone-mcp.sh provisions rtk', () => {
  it('invokes install-rtk.sh on every install', () => {
    const main = readFileSync(join(SCRIPTS, 'install-standalone-mcp.sh'), 'utf8');
    expect(main).toMatch(/RTK_INSTALLER="\$\{SCRIPT_DIR\}\/install-rtk\.sh"/);
    expect(main).toMatch(/bash "\$RTK_INSTALLER"/);
  });
});
