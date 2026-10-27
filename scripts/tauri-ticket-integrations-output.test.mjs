import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('screenshot failures retain both diagnostic channels and reject missing images', () => {
  const source = readFileSync(new URL('./tauri-surface-verify-ticket-integrations.sh', import.meta.url), 'utf8');
  const helper = source.match(/^capture_screenshot\(\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(helper);
  const dir = mkdtempSync(join(tmpdir(), 'ticket-native-capture-'));
  try {
    const cli = join(dir, 'bridge');
    writeFileSync(cli, '#!/bin/sh\necho capture-detail\necho adapter-failed >&2\nexit 7\n', { mode: 0o700 });
    const target = join(dir, 'capture.png');
    const run = () => spawnSync('bash', ['-c', helper + '\ncapture_screenshot "$1"', 'verifier', target], {
      env: { ...process.env, T: cli, VERIFY_TAURI_PID: '123' }, encoding: 'utf8',
    });
    const failed = run();
    assert.equal(failed.status, 7);
    assert.match(failed.stderr, /adapter-failed/);
    assert.match(failed.stderr, /capture-detail/);
    assert.match(readFileSync(target + '.stderr.log', 'utf8'), /adapter-failed/);
    assert.match(readFileSync(target + '.stdout.log', 'utf8'), /capture-detail/);
    writeFileSync(cli, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    assert.equal(run().status, 1, 'a successful CLI exit without an image is not evidence');
    writeFileSync(cli, '#!/bin/sh\nprintf image > "$5"\n', { mode: 0o700 });
    assert.equal(run().status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
