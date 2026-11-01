import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('screenshots resolve the verifier PID to its Tauri window and retain diagnostics', () => {
  const source = readFileSync(new URL('./tauri-surface-verify-ticket-integrations.sh', import.meta.url), 'utf8');
  const helper = source.match(/^capture_screenshot\(\) \{[\s\S]*?(?=^fail\(\) \{)/m)?.[0]?.trimEnd();
  assert.ok(helper);
  const dir = mkdtempSync(join(tmpdir(), 'ticket-native-capture-'));
  try {
    const cli = join(dir, 'bridge');
    const argsFile = join(dir, 'screenshot-args.txt');
    writeFileSync(cli, `#!/bin/sh
if [ "$1" = "list-windows" ]; then
  printf '%s\\n' '[{"windowId":"900","pid":123,"name":"helper","width":40,"height":20,"tauri":false},{"windowId":"901","pid":456,"name":"foreign app","width":3000,"height":2000,"tauri":true},{"windowId":"902","pid":123,"name":"Papercusp","width":1280,"height":800,"tauri":true}]'
  exit 0
fi
if [ "$1" = "screenshot" ]; then
  printf '%s\\n' "$@" > "$CAPTURE_ARGS_FILE"
  if [ "$SCREENSHOT_FAIL" = "1" ]; then
    echo capture-detail
    echo adapter-failed >&2
    exit 7
  fi
  printf image > "$5"
  exit 0
fi
exit 99
`, { mode: 0o700 });
    const target = join(dir, 'capture.png');
    const run = (screenshotFail) => spawnSync('bash', ['-c', helper + '\ncapture_screenshot "$1"', 'verifier', target], {
      env: { ...process.env, T: cli, VERIFY_TAURI_PID: '123', CAPTURE_ARGS_FILE: argsFile, SCREENSHOT_FAIL: screenshotFail }, encoding: 'utf8',
    });
    const failed = run('1');
    assert.equal(failed.status, 7);
    assert.match(failed.stderr, /adapter-failed/);
    assert.match(failed.stderr, /capture-detail/);
    assert.match(readFileSync(target + '.stderr.log', 'utf8'), /adapter-failed/);
    assert.match(readFileSync(target + '.stdout.log', 'utf8'), /capture-detail/);
    assert.deepEqual(readFileSync(argsFile, 'utf8').trim().split('\n'), [
      'screenshot', '--window-id', '902', '--output', target,
    ], 'the selected OS window belongs to the verifier PID, not a larger foreign window');
    assert.equal(run('0').status, 0);
    assert.equal(readFileSync(target, 'utf8'), 'image');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('screenshot refuses to fall back when the verifier PID has no visible Tauri window', () => {
  const source = readFileSync(new URL('./tauri-surface-verify-ticket-integrations.sh', import.meta.url), 'utf8');
  const helper = source.match(/^capture_screenshot\(\) \{[\s\S]*?(?=^fail\(\) \{)/m)?.[0]?.trimEnd();
  assert.ok(helper);
  const dir = mkdtempSync(join(tmpdir(), 'ticket-native-no-window-'));
  try {
    const cli = join(dir, 'bridge');
    const argsFile = join(dir, 'screenshot-args.txt');
    writeFileSync(cli, `#!/bin/sh
if [ "$1" = "list-windows" ]; then
  printf '%s\\n' '[{"windowId":"901","pid":456,"name":"foreign app","width":1200,"height":800,"tauri":true}]'
  exit 0
fi
if [ "$1" = "screenshot" ]; then
  printf '%s\\n' "$@" > "$CAPTURE_ARGS_FILE"
fi
exit 0
`, { mode: 0o700 });
    const target = join(dir, 'capture.png');
    const result = spawnSync('bash', ['-c', helper + '\ncapture_screenshot "$1"', 'verifier', target], {
      env: { ...process.env, T: cli, VERIFY_TAURI_PID: '123', CAPTURE_ARGS_FILE: argsFile }, encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no-owned-tauri-window:pid=123/);
    assert.match(result.stderr, /Could not resolve a visible Tauri window/);
    assert.equal(existsSync(argsFile), false, 'must not capture a similarly named or unrelated window');
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
