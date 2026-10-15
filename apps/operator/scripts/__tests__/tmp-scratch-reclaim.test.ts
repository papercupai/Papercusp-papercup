import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../../..');
const SCRIPT = join(ROOT, 'scripts/reclaim-tmp-scratch-residue.sh');

describe('retired name-only scratch actor', () => {
  it('remains a valid compatibility entry for installed timers', () => {
    const result = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    expect(result.status).toBe(0);
  });

  it.each([{ args: [] }, { args: ['--execute'] }])('does not bypass the age/lease/holder-aware executor: %j', ({ args }) => {
    const root = mkdtempSync(join(tmpdir(), 'scratch-compat-'));
    try {
      const paths = ['papercusp-affected-tests-old.log', 'arbitrary-build-copy'].map((name) => join(root, name));
      for (const path of paths) {
        writeFileSync(path, 'keep');
        utimesSync(path, new Date(0), new Date(0));
      }
      const result = spawnSync('bash', [SCRIPT, '--root', root, '--max-age-min', '240', ...args], { encoding: 'utf8', timeout: 10_000 });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('delegated=diskRetentionReclaim class=tmp-scratch execute=0');
      for (const path of paths) expect(existsSync(path)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('documents the scheduled owner and preserves a compatible hardened timer entry', () => {
    const help = spawnSync('bash', [SCRIPT, '--help'], { encoding: 'utf8' });
    expect(help.stdout).toContain('diskRetentionReclaim');
    const service = readFileSync(join(ROOT, 'apps/operator/scripts/systemd/papercup-tmp-scratch-reclaim.service'), 'utf8');
    expect(service).toContain('PrivateTmp=no');
    expect(service).toContain('NoNewPrivileges=yes');
    expect(service).toContain('scripts/reclaim-tmp-scratch-residue.sh --execute');
  });
});
