/**
 * Regression coverage for setup-release-checkout.sh's `--help` path
 * (EI-24760202132078287).
 *
 * `--help` used to fall through the arg parser to `unknown arg: --help` and exit 2,
 * so an operator had no safe way to discover the CLI without reading its parser.
 * Locked here: `-h`/`--help` exits 0, prints the header's usage block, and touches
 * nothing — the release root is never created, even when it is the only arg that
 * would otherwise be acted on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT_PATH =
  process.env.PROBE_SCRIPT ?? join(__dirname, '../../bin/release/setup-release-checkout.sh');

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'setup-release-help-'));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function run(...args: string[]) {
  const releaseRoot = join(scratch, 'release');
  const r = spawnSync('bash', [SCRIPT_PATH, ...args, '--release', releaseRoot], {
    cwd: scratch,
    encoding: 'utf8',
    // A non-repo integration root: any path past usage handling would fail on it.
    env: { ...process.env, PAPERCUSP_INTEGRATION_ROOT: scratch },
  });
  return { ...r, releaseRoot };
}

describe('setup-release-checkout.sh --help', () => {
  it.each(['--help', '-h'])('%s prints usage, exits 0 and touches nothing', (flag) => {
    const r = run(flag);
    expect(r.stderr).not.toContain('unknown arg');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage:');
    expect(r.stdout).toContain('setup-release-checkout.sh [--ref <commit-ish>]');
    expect(r.stdout).toContain('--source-integrity allow-live-tree|object-sourced');
    expect(r.stdout).toContain('Env overrides: PAPERCUSP_INTEGRATION_ROOT, PAPERCUSP_RELEASE_ROOT.');
    expect(r.stdout).not.toContain('[setup-release]');
    expect(existsSync(r.releaseRoot)).toBe(false);
  });

  it('documents every flag the parser accepts', () => {
    const r = run('--help');
    for (const flag of [
      '--ref', '--node-modules', '--node-modules-copy', '--node-modules-generation',
      '--node-modules-generation-id', '--node-modules-generation-token',
      '--node-modules-workspace-dir', '--dependency-generation-root', '--source-integrity',
      '--integration', '--release', '--build-spa', '--prepare-existing', '--source-only',
    ]) {
      expect(r.stdout).toContain(`[${flag}`);
    }
  });

  it('still rejects a genuinely unknown arg with exit 2', () => {
    const r = run('--bogus');
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('unknown arg: --bogus');
  });
});
