/**
 * Recurrence guard for EI-20209569220764298.
 *
 * Help is a query-only CLI path. It must return usage before resolving the
 * repository, checking session provenance, creating a work directory, or
 * allocating any Xvfb/Tauri resources.
 */
import { hermeticSpawnEnv } from './__tests__/hermetic-spawn-env';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');
const SCRIPT = resolve(ROOT, 'scripts/verify-tauri-headless.sh');

describe('EI-20209569220764298 — verify-tauri-headless help is side-effect-free', () => {
  it.each(['--help', '-h'])('prints usage without booting for %s', (flag) => {
    const scratch = mkdtempSync(join(tmpdir(), 'verify-tauri-headless-help.'));

    try {
      const result = spawnSync('bash', [SCRIPT, flag], {
        cwd: ROOT,
        env: {
          ...hermeticSpawnEnv(),
          PAPERCUSP_REPO_DIR: join(scratch, 'missing-repo'),
          PAPERCUSP_SID: '',
          TMPDIR: scratch,
        },
        encoding: 'utf8',
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Usage:');
      expect(result.stdout).toContain('assertion-command');
      expect(result.stderr).toBe('');
      expect(readdirSync(scratch)).toEqual([]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
