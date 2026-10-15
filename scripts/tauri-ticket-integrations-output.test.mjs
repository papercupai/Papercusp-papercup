import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('native eval preserves true, false and JSON values while retaining CLI warning diagnostics', () => {
  const source = readFileSync(new URL('./tauri-surface-verify-ticket-integrations.sh', import.meta.url), 'utf8');
  const helper = source.match(/^ev\(\).*$/m)?.[0];
  assert.ok(helper, 'exercise the maintained verifier helper');
  const dir = mkdtempSync(join(tmpdir(), 'ticket-native-output-'));
  try {
    const cli = join(dir, 'bridge');
    writeFileSync(cli, '#!/bin/sh\nprintf "native CLI warning\\n" >&2\nprintf "%s\\n" "$4"\n', { mode: 0o700 });
    for (const value of ['true', 'false', '["linear","asana"]']) {
      const result = spawnSync('bash', ['-c', helper + '\nev "$1"', 'verifier', value], {
        env: { ...process.env, T: cli, VERIFY_TAURI_PID: '123' }, encoding: 'utf8',
      });
      assert.equal(result.status, 0);
      assert.equal(result.stdout.trim(), value, 'diagnostics must not corrupt the boolean/JSON assertion channel');
      assert.match(result.stderr, /native CLI warning/, 'diagnostics remain available for failure evidence');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
