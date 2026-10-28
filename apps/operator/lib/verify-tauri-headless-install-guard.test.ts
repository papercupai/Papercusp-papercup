/**
 * Recurrence guard for EI-21107555111779921.
 *
 * `npm run install:safe` rewrites the shared root node_modules while holding
 * the repo-keyed fs mutex. The verifier must identify that condition before
 * its own dependency preflight and before it allocates a work directory or
 * isolated desktop resources; otherwise a transient missing package is
 * misreported as a Tauri/operator boot failure.
 */
import { hermeticSpawnEnv } from './__tests__/hermetic-spawn-env';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { repoLockName } from '../../../scripts/npm-install-safe.mjs';

const ROOT = resolve(__dirname, '../../..');
const SCRIPT = resolve(ROOT, 'scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');

describe('EI-21107555111779921 — verifier detects install-safe transitions', () => {
  it('runs the install preflight before dependency resolution and work allocation', () => {
    const preflightIdx = src.indexOf('install_in_flight_preflight || exit $?');
    const dependencyIdx = src.indexOf('VERIFY_TAURI_AGENT_TOOLS_BIN="$(resolve_tauri_agent_tools)"');
    const workIdx = src.indexOf('WORK="$(mktemp -d');

    expect(preflightIdx).toBeGreaterThan(-1);
    expect(preflightIdx).toBeLessThan(dependencyIdx);
    expect(preflightIdx).toBeLessThan(workIdx);
    expect(src).toContain('peekFsMutexSync');
    expect(src).toContain('repoLockName(repoRoot)');
  });

  it('fails fast with the install diagnosis even when another preflight would fail', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'verify-tauri-install-guard.'));
    const lockRoot = join(scratch, 'locks');
    const lockDir = join(lockRoot, `${repoLockName(ROOT)}.lock`);
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'owner.json'),
      JSON.stringify({ pid: 424242, host: hostname(), startedAt: new Date().toISOString(), name: repoLockName(ROOT) }),
    );

    try {
      const missingTool = join(scratch, 'missing-tauri-agent-tools');
      const result = spawnSync('bash', [SCRIPT, '--boot-only'], {
        cwd: ROOT,
        env: {
          ...hermeticSpawnEnv(),
          PAPERCUSP_REPO_DIR: ROOT,
          PAPERCUSP_SID: 'test-install-preflight',
          // Keep this unit test on the install/dependency preflight path; a
          // detached capability:bash marker would intentionally stop --boot-only
          // first with the task-lifetime guard (exit 2).
          PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: '',
          // The runner's own task deadline would trip the verifier's deadline
          // admission (exit 2) before the preflight under test (WI-6554700010030899).
          PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '',
          PAPERCUSP_FS_MUTEX_LOCK_DIR: lockRoot,
          TMPDIR: scratch,
          VERIFY_TAURI_AGENT_TOOLS_BIN: missingTool,
        },
        encoding: 'utf8',
      });

      expect(result.status).toBe(75);
      expect(result.stderr).toContain('VERIFY_TAURI_INSTALL_IN_PROGRESS');
      expect(result.stderr).toContain('retry after install:safe releases the repo mutex');
      expect(result.stderr).not.toContain('VERIFY_TAURI_AGENT_TOOLS_BIN is not executable');
      expect(readdirSync(scratch)).toEqual(['locks']);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
