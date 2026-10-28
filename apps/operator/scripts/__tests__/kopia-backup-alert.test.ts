import { describe, expect, it } from 'vitest';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const SCRIPT = resolve(__dirname, '..', 'systemd', 'kopia-backup-alert.sh');

describe('kopia-backup-alert notification payload', () => {
  it('JSON-encodes quotes, backslashes, and newlines in the reason and paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'kopia-backup-alert-json-'));
    const repo = join(root, 'repo');
    const script = join(repo, 'apps', 'operator', 'scripts', 'systemd', 'kopia-backup-alert.sh');
    const dump = join(root, 'dump "quoted" \\backslash\nwith newline');
    const marker = join(dump, 'ALERT-BACKUP-FAILING');
    const bin = join(root, 'bin');
    const capture = join(root, 'mcp-call-argv.bin');
    const reason = 'backup "failed" \\with backslash\nand another line';

    try {
      mkdirSync(join(repo, 'apps', 'operator', 'scripts', 'systemd'), { recursive: true });
      mkdirSync(join(repo, 'scripts'), { recursive: true });
      mkdirSync(bin, { recursive: true });
      execFileSync('git', ['init', '--quiet', repo]);
      copyFileSync(SCRIPT, script);
      chmodSync(script, 0o755);
      writeFileSync(join(repo, 'scripts', 'mcp-call.mjs'), '');

      const nodeShim = [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'if [[ "$1" == "scripts/mcp-call.mjs" ]]; then',
        '  shift',
        "  printf '%s\\000' \"$@\" > \"$KOPIA_ALERT_CAPTURE\"",
        '  exit 0',
        'fi',
        'exec "$KOPIA_ALERT_REAL_NODE" "$@"',
        '',
      ].join('\n');
      writeFileSync(join(bin, 'node'), nodeShim);
      chmodSync(join(bin, 'node'), 0o755);
      writeFileSync(join(bin, 'notify-send'), '#!/usr/bin/env bash\nexit 0\n');
      chmodSync(join(bin, 'notify-send'), 0o755);

      const result = spawnSync('bash', [script, reason], {
        encoding: 'utf8',
        timeout: 15_000,
        env: {
          ...process.env,
          PATH: [bin, process.env.PATH ?? ''].join(delimiter),
          KOPIA_ALERT_CAPTURE: capture,
          KOPIA_ALERT_REAL_NODE: process.execPath,
          PAPERCUSP_HOST_PG_DUMP_DIR: dump,
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(existsSync(marker)).toBe(true);

      const argv = readFileSync(capture).toString('utf8').split('\0');
      expect(argv.pop()).toBe('');
      expect(argv[0]).toBe('coord:send');
      expect(argv.slice(2)).toEqual([
        '--client',
        'system-backup-alert',
        '--harness',
        'papercusp',
        '--workspace',
        'papercusp-workspace',
      ]);
      expect(JSON.parse(argv[1] ?? '')).toEqual({
        to: ['*'],
        expects: 'none',
        conditionKey: 'papercusp-db-backup-failing',
        summary: 'BACKUP FAILING: ' + reason,
        body: [{
          text: 'papercusp-db-backup is not producing usable dumps. See ' + marker +
            ' and ' + dump + '/db-backup.log. EI-10733 is the last time this rotted silently — for 30 days.',
        }],
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
