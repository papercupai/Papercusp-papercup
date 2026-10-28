/**
 * Recurrence guard for EI-21281971092880743.
 *
 * capability:bash can omit ~/.cargo/bin from PATH. Warm target slots hide the
 * omission because they reuse an existing desktop binary; a cold slot invokes
 * cargo metadata and otherwise fails only after the verifier has allocated its
 * rig. Keep cargo resolution and PATH repair before that allocation boundary.
 */
import { hermeticSpawnEnv } from './__tests__/hermetic-spawn-env';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');
const SCRIPT = resolve(ROOT, 'scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');

describe('EI-21281971092880743 — verify-tauri-headless cargo preflight', () => {
  it('resolves cargo and repairs PATH before allocating a verifier work dir', () => {
    const resolveIdx = src.indexOf('VERIFY_TAURI_CARGO_BIN="$(resolve_cargo)"');
    const workIdx = src.indexOf('WORK="$(mktemp -d');

    expect(resolveIdx).toBeGreaterThan(-1);
    expect(resolveIdx).toBeLessThan(workIdx);
    expect(src).toContain('command -v cargo');
    expect(src).toContain('"${HOME:-}/.cargo/bin/cargo"');
    expect(src).toContain('VERIFY_TAURI_CARGO_BIN is not executable');
    expect(src).toContain(
      'PATH="$VERIFY_TAURI_CARGO_BIN_DIR:${PATH:-/usr/local/bin:/usr/bin:/bin}"',
    );
    expect(src).toContain(
      'Install Rust with rustup so ~/.cargo/bin/cargo exists, or set VERIFY_TAURI_CARGO_BIN',
    );
  });

  it('prefers the explicit override and resolves the managed cargo fallback', () => {
    const resolver = src.match(/^resolve_cargo\(\) \{[\s\S]*?^\}/m)?.[0];
    expect(resolver, 'resolve_cargo() must remain directly testable').toBeTruthy();

    const dir = mkdtempSync(join(tmpdir(), 'verify-tauri-cargo-path.'));
    const override = join(dir, 'override-cargo');
    const managedDir = join(dir, '.cargo', 'bin');
    const managed = join(managedDir, 'cargo');
    try {
      mkdirSync(managedDir, { recursive: true });
      writeFileSync(override, '#!/usr/bin/env bash\nexit 0\n');
      writeFileSync(managed, '#!/usr/bin/env bash\nexit 0\n');
      chmodSync(override, 0o755);
      chmodSync(managed, 0o755);

      const explicit = spawnSync(
        '/bin/bash',
        ['-c', `${resolver}\nVERIFY_TAURI_CARGO_BIN="$1"; resolve_cargo`, '_', override],
        { env: { HOME: dir, PATH: '' }, encoding: 'utf8' },
      );
      expect(explicit.status).toBe(0);
      expect(explicit.stdout.trim()).toBe(override);

      const fallback = spawnSync('/bin/bash', ['-c', `${resolver}\nresolve_cargo`], {
        env: { HOME: dir, PATH: '' },
        encoding: 'utf8',
      });
      expect(fallback.status).toBe(0);
      expect(fallback.stdout.trim()).toBe(managed);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails with named remediation before creating a verifier work dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-tauri-cargo-missing.'));
    const fakeAgentTools = join(dir, 'tauri-agent-tools');
    const missingCargo = join(dir, 'missing-cargo');
    try {
      writeFileSync(fakeAgentTools, '#!/usr/bin/env bash\nexit 0\n');
      chmodSync(fakeAgentTools, 0o755);
      const result = spawnSync('bash', [SCRIPT, '--boot-only'], {
        cwd: ROOT,
        env: {
          ...hermeticSpawnEnv(),
          PAPERCUSP_REPO_DIR: ROOT,
          PAPERCUSP_SID: 'test-cargo-preflight',
          // Exercise cargo resolution itself rather than the managed-task
          // --boot-only lifetime refusal inherited from capability:inspect.
          PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: '',
          // The runner's own task deadline would trip the verifier's deadline
          // admission (exit 2) before the preflight under test (WI-6554700010030899).
          PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '',
          TMPDIR: dir,
          VERIFY_TAURI_AGENT_TOOLS_BIN: fakeAgentTools,
          VERIFY_TAURI_CARGO_BIN: missingCargo,
        },
        encoding: 'utf8',
      });

      expect(result.status).toBe(127);
      expect(result.stderr).toContain(
        `VERIFY_TAURI_CARGO_BIN is not executable: ${missingCargo}`,
      );
      expect(result.stderr).toContain('Install Rust/cargo or set VERIFY_TAURI_CARGO_BIN');
      expect(
        readdirSync(dir).filter((entry) => entry.startsWith('verify-tauri-headless.')),
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
