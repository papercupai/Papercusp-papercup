import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '../../../..');
const source = readFileSync(process.env.VERIFY_TAURI_SOURCE_PATH || resolve(repo, 'scripts/verify-tauri-headless.sh'), 'utf8');
const launcher = source.match(/write_and_launch_tauri\(\) \{[\s\S]*?\n\}/)?.[0];
if (!launcher) throw new Error('Maintained native launcher was not found');

describe('native desktop binary readiness', () => {
  it.each([
    ['missing log', undefined, false],
    ['compiler output', 'Compiling papercusp-desktop v0.1.0\n', false],
    ['plain running marker', 'Running `/tmp/debug/papercusp-desktop`\n', true],
    ['colorized running marker', '\u001b[1m\u001b[92m     Running\u001b[0m `/tmp/debug/papercusp-desktop`\n', true],
  ] as const)('quietly classifies %s', (_name, contents, ready) => {
    const definitions = source.match(/^strip_ansi\(\) \{[^\n]*\}\ndesktop_binary_started\(\) \{[\s\S]*?^\}/m)?.[0];
    if (!definitions) throw new Error('Maintained desktop readiness predicate was not found');
    const dir = mkdtempSync(resolve(tmpdir(), 'tauri-startup-readiness-'));
    try {
      const log = resolve(dir, 'cargo.log');
      if (contents !== undefined) writeFileSync(log, contents);
      // Execute the production functions, including Bash redirection failures.
      const result = spawnSync('bash', ['-c', [
        'set -o pipefail', 'LOG=$1', definitions, 'desktop_binary_started',
      ].join('\n'), 'startup-readiness', log], { encoding: 'utf8', timeout: 5_000 });
      expect(result.status, result.stderr).toBe(ready ? 0 : 1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('native Playwright assertion source preflight', () => {
  function preflight(...args: string[]) {
    const dir = mkdtempSync(resolve(tmpdir(), 'tauri-assertion-source-'));
    try {
      const helper = resolve(dir, 'preflight.mjs');
      // Exercise these exact helper bytes. A child inherits NODE_OPTIONS, whose
      // committed-source loader otherwise replaces an edited helper with HEAD.
      writeFileSync(helper, readFileSync(resolve(repo, 'scripts/lib/verify-tauri-assertion-env.mjs')));
      symlinkSync(resolve(repo, 'node_modules'), resolve(dir, 'node_modules'));
      return spawnSync(process.execPath, [helper, '--command', ...args], { encoding: 'utf8', timeout: 10_000 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it.each([
    ['bash', '-c', 'cd apps/operator && npx playwright test e2e/example.spec.mts'],
    ['sh', '-c', 'npx playwright test --config playwright.config.mts'],
    ['npx', 'playwright', 'test', 'e2e/example.spec.mts'],
    ['bash', '-c', 'cd "$OPERATOR_SOURCE_ROOT/apps/operator" && npx playwright test --config /tmp/shared/playwright.config.mts'],
    ['bash', '-c', 'cd "$OPERATOR_SOURCE_ROOT/apps/operator" && cd /tmp/shared && npx playwright test e2e/example.spec.mts'],
    ['bash', '-c', 'cd "$OPERATOR_SOURCE_ROOT/apps/operator" && npx playwright test --config=/tmp/shared/playwright.config.mts'],
    ['bash', '-c', 'cd "$OPERATOR_SOURCE_ROOT/apps/operator" && npx playwright test -c /tmp/shared/playwright.config.mts'],
    ['bash', '-c', 'cd "$OPERATOR_SOURCE_ROOT/apps/operator" && npx playwright test -c/tmp/shared/playwright.config.mts'],
    ['bash', '-c', 'cd "$OPERATOR_SOURCE_ROOT/apps/operator" && npx playwright test --config ../../../../shared/playwright.config.mts'],
    ['bash', '-c', 'cd "$OPERATOR_SOURCE_ROOT/../shared" && npx playwright test e2e/example.spec.mts'],
    ['bash', '-c', 'cd \'$OPERATOR_SOURCE_ROOT/apps/operator\' && npx playwright test e2e/example.spec.mts'],
    ['bash', '-c', 'npx playwright test --config "$OPERATOR_SOURCE_ROOT/../shared/playwright.config.mts"'],
    ['bash', '-c', 'cd "$OPERATOR_SOURCE_ROOT/apps/operator"; npx playwright test e2e/example.spec.mts'],
    ['bash', '-c', 'cd "$OPERATOR_SOURCE_ROOT/apps/operator" || npx playwright test e2e/example.spec.mts'],
    ['bash', '-c', 'cd "$OPERATOR_SOURCE_ROOT/apps/operator"\nnpx playwright test e2e/example.spec.mts'],
    ['bash', '-c', 'npx "playwright" "test" e2e/example.spec.mts'],
    ['bash', '-c', 'npx playwright test e2e/example.spec.mts # cd "$OPERATOR_SOURCE_ROOT/apps/operator"'],
    ['bash', '-c', '# cd "$OPERATOR_SOURCE_ROOT/apps/operator"\nnpx playwright test e2e/example.spec.mts'],
    ['bash', '-lc', 'npx playwright test e2e/example.spec.mts'],
    ['bash', '--noprofile', '-c', 'npx playwright test e2e/example.spec.mts'],
  ])('rejects unpinned Playwright source before native preparation: %j', (...args) => {
    const result = preflight(...args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('OPERATOR_SOURCE_ROOT');
  });

  it.each([
    ['/tmp/shared/node_modules/.bin/playwright', 'test', '--config', '/tmp/shared/playwright.config.mts'],
    ['npx', '@playwright/test', 'test', '--config', '/tmp/shared/playwright.config.mts'],
    ['node', '/tmp/shared/node_modules/playwright/cli.js', 'test'],
    ['bash', '-c', '/tmp/shared/node_modules/.bin/playwright test --config /tmp/shared/playwright.config.mts'],
    ['bash', '-c', 'cd "$OPERATOR_SOURCE_ROOT/apps/operator" && /tmp/shared/node_modules/.bin/playwright test --config /tmp/shared/playwright.config.mts'],
    ['bash', '-c', 'npx @playwright/test test --config /tmp/shared/playwright.config.mts'],
    ['bash', '-c', 'cd "$OPERATOR_SOURCE_ROOT/apps/operator" && npx @playwright/test test --config /tmp/shared/playwright.config.mts'],
    ['bash', '-c', 'npx @playwright/test@1.57.0 test'],
    ['bash', '-c', 'npx playwright@1.57.0 test'],
    ['bash', '-c', 'npx playwright-core test'],
    ['bash', '-c', 'node /tmp/shared/node_modules/playwright/cli.js test'],
    ['bash', '-c', 'node /tmp/shared/node_modules/@playwright/test/cli.js test'],
    ['bash', '-c', 'node /tmp/shared/node_modules/playwright-core/cli.js test'],
    ['bash', '-c', './node_modules/.bin/playwright test'],
    ['bash', '-c', 'npm exec -- @playwright/test test'],
  ])('rejects unsupported Playwright CLI forms before native preparation: %j', (...args) => {
    const result = preflight(...args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('OPERATOR_SOURCE_ROOT');
  });

  it.each([
    'cd "$OPERATOR_SOURCE_ROOT/apps/operator" && npx playwright test e2e/example.spec.mts',
    'cd "${OPERATOR_SOURCE_ROOT}/apps/operator" && npx playwright test e2e/example.spec.mts',
    'npx playwright test --config "$OPERATOR_SOURCE_ROOT/apps/operator/playwright.config.mts"',
    'cd "$OPERATOR_SOURCE_ROOT/apps/operator" && npx playwright test --config playwright.config.mts',
    'cd "$OPERATOR_SOURCE_ROOT/apps/operator" && npx playwright test --config="$OPERATOR_SOURCE_ROOT/apps/operator/playwright.config.mts"',
    'cd /tmp/shared && cd "$OPERATOR_SOURCE_ROOT/apps/operator" && npx playwright test e2e/example.spec.mts',
    'cd "$OPERATOR_SOURCE_ROOT/apps/operator" && cd .. && pnpm exec playwright test --config operator/playwright.config.mts',
    'cd -- "$OPERATOR_SOURCE_ROOT/apps/operator" && npm exec playwright test -c playwright.config.mts',
    'cd "$OPERATOR_SOURCE_ROOT/apps/operator" && npx "playwright" "test" e2e/example.spec.mts',
  ])('accepts the owned source root without expanding it before boot: %s', command => {
    expect(preflight('bash', '-c', command).status).toBe(0);
  });

  it('keeps non-Playwright assertion commands available', () => {
    expect(preflight('bash', '-c', 'printf assertion').status).toBe(0);
  });

  it.each([
    ['bash', '-lc', 'cd "$OPERATOR_SOURCE_ROOT/apps/operator" && npx playwright test e2e/example.spec.mts'],
    ['bash', '--noprofile', '-c', 'cd "$OPERATOR_SOURCE_ROOT/apps/operator" && npx playwright test e2e/example.spec.mts'],
  ])('checks the effective command with additional shell flags: %j', (...args) => {
    expect(preflight(...args).status).toBe(0);
  });
});

describe('pinned native dependency donor preflight', () => {
  function preflight(kind: 'missing' | 'file' | 'symlink' | 'physical', pinned = true) {
    const dir = mkdtempSync(resolve(tmpdir(), 'tauri-donor-preflight-'));
    const donor = resolve(dir, 'installed-donor');
    const capture = resolve(dir, 'node-called');
    const start = source.indexOf('install_in_flight_preflight() {');
    const end = source.indexOf('\ninstall_in_flight_preflight ||', start);
    if (start < 0 || end < 0) throw new Error('Install preflight was not found');
    const preparation = source.slice(start, end);
    mkdirSync(donor);
    if (kind === 'file') writeFileSync(resolve(donor, 'node_modules'), 'not an install');
    if (kind === 'physical') mkdirSync(resolve(donor, 'node_modules'));
    if (kind === 'symlink') {
      mkdirSync(resolve(dir, 'shared-dependencies'));
      symlinkSync(resolve(dir, 'shared-dependencies'), resolve(donor, 'node_modules'));
    }
    writeFileSync(resolve(dir, 'node'), '#!/bin/sh\nprintf called > "$FIXTURE_CAPTURE"\n', { mode: 0o755 });
    try {
      const result = spawnSync('bash', ['-c', `
REPO_DIR="$FIXTURE_DONOR"
${preparation}
install_in_flight_preflight
`], { encoding: 'utf8', timeout: 10_000, env: { ...process.env,
        PATH: `${dir}:${process.env.PATH}`, FIXTURE_DONOR: donor, FIXTURE_CAPTURE: capture,
        VERIFY_TAURI_SOURCE_REF: pinned ? 'exact-pin' : '',
        VERIFY_TAURI_SOURCE_REPO_DIR: resolve(dir, 'separate-frozen-source') } });
      return { ...result, inspectedInstall: existsSync(capture) };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  it.each(['missing', 'file', 'symlink'] as const)('rejects a %s dependency install before preparation', kind => {
    const result = preflight(kind);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('VERIFY_TAURI_DEPENDENCY_DONOR_INVALID');
    expect(result.inspectedInstall).toBe(false);
  });

  it('accepts a physical donor independent of the frozen source location', () => {
    const result = preflight('physical');
    expect(result.status, result.stderr).toBe(0);
    expect(result.inspectedInstall).toBe(true);
  });

  it('preserves the unpinned install diagnostic', () => {
    const result = preflight('missing', false);
    expect(result.status, result.stderr).toBe(0);
    expect(result.inspectedInstall).toBe(true);
  });
});

function executeLauncher(isolated: boolean) {
  const dir = mkdtempSync(resolve(tmpdir(), 'tauri-launcher-'));
  const capture = resolve(dir, 'npm.json');
  writeFileSync(resolve(dir, 'npm'), `#!/usr/bin/env node
require('node:fs').writeFileSync(process.env.FIXTURE_CAPTURE, JSON.stringify({
  pid: process.pid,
  args: process.argv.slice(2),
  env: Object.fromEntries(['PAPERCUSP_CLUSTER', 'PAPERCUSP_SPAWNER_SIDECAR',
    'PAPERCUSP_OPERATOR_URL', 'PAPERCUSP_DEV_HOST_DIAGNOSTIC_DIR',
    'XDG_SESSION_TYPE', 'GH_TOKEN', 'DATABASE_URL'].map(key => [key, process.env[key] ?? null]))
}));
`, { mode: 0o755 });
  try {
    const launchedPid = execFileSync('bash', ['-c', `
set -euo pipefail
WORK="$FIXTURE_DIR"
DESKTOP_DIR="$FIXTURE_DIR"
LOG="$FIXTURE_DIR/tauri.log"
BOOT_ATTEMPTS=1
DEV_PORT=12345
PTY_PORT=12346
DISPLAY_NUM=91
ISOLATED_DB="$FIXTURE_ISOLATED"
WINDOW_GEOMETRY=''
ISOLATED_UNSET_LINE='-u GH_TOKEN'
NATIVE_TERMINAL=1
VERIFY_TAURI_TRACE_SESSION_CHAT_CSS=0
TAURI_OWNER_SID=fixture-owner
TAURI_LAUNCH_PROVENANCE=fixture-provenance
MEMORY_LIMIT_MB=2048
NATIVE_CARGO_DISK_RESERVATION_FILE="$FIXTURE_DIR/disk-reservation"
OPERATOR_SOURCE_ENV_LINE=''
SPA_ENV_LINE=''
ISOLATED_ENV_LINE='DATABASE_URL=postgresql://fixture/isolated'
VERIFY_SCOPE_BASE=fixture
LAUNCH_PREFIX=()
verify_tauri_dev_url() { printf 'http://127.0.0.1:%s' "$1"; }
start_verify_process() {
  bash "$3" > "$2" 2>&1 &
  VERIFY_STARTED_PROCESS_PID=$!
}
${launcher}
write_and_launch_tauri
wait "$TAURI_PID"
printf '%s' "$TAURI_PID"
`], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FIXTURE_DIR: dir,
      FIXTURE_CAPTURE: capture, FIXTURE_ISOLATED: isolated ? '1' : '0', GH_TOKEN: 'must-be-removed' },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
    return { ...JSON.parse(readFileSync(capture, 'utf8')), launchedPid: Number(launchedPid) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('maintained native generated launcher', () => {
  it.each([true, false])('executes npm with the complete environment (isolated=%s)', (isolated) => {
    const result = executeLauncher(isolated);
    expect(result.launchedPid).toBe(result.pid);
    expect(result.args.slice(0, 5)).toEqual(['run', 'tauri', '--', 'dev', '--no-watch']);
    const config = JSON.parse(result.args[6]);
    expect(config.build.devUrl).toBe(`http://127.0.0.1:12345${isolated ? '?verify-tauri-isolated=1' : ''}`);
    expect(result.env).toMatchObject({ PAPERCUSP_CLUSTER: '0', PAPERCUSP_SPAWNER_SIDECAR: '0',
      PAPERCUSP_OPERATOR_URL: 'http://127.0.0.1:12345', XDG_SESSION_TYPE: 'x11',
      GH_TOKEN: null, DATABASE_URL: 'postgresql://fixture/isolated' });
    expect(result.env.PAPERCUSP_DEV_HOST_DIAGNOSTIC_DIR).toContain('/phases/boot/operator-startup/attempt-1');
  });
  it('accepts the maintained launcher before expensive preparation', () => {
    expect(checkPreflight(source)).toBe('accepted');
  });

  it.each(['PAPERCUSP_DEV_HOST_DIAGNOSTIC_DIR', 'PAPERCUSP_TRACE_FIRST_SESSION_CHAT_CSS',
    'PAPERCUSP_CLUSTER', 'PAPERCUSP_OPERATOR_BASE', 'PAPERCUSP_OPERATOR_URL'])
  ('rejects an over-escaped %s continuation before boot', (key) => {
    const corrupted = source.split('\n').map(line =>
      line.startsWith(`  ${key}=`) ? line.replace(/\\+$/, '\\'.repeat(4)) : line).join('\n');
    expect(corrupted).not.toBe(source);
    expect(checkPreflight(corrupted)).toMatchObject({ status: 2,
      stderr: expect.stringContaining('VERIFY_TAURI_LAUNCHER_INVALID') });
  });
});

function checkPreflight(candidate: string) {
  const start = source.indexOf('validate_tauri_launcher_preflight() {');
  const end = source.indexOf('\nvalidate_tauri_launcher_preflight ||', start);
  if (start < 0 || end < 0) throw new Error('Launcher preflight was not found');
  const dir = mkdtempSync(resolve(tmpdir(), 'tauri-launch-preflight-'));
  const file = resolve(dir, 'verifier.sh');
  writeFileSync(file, candidate);
  try {
    execFileSync('bash', ['-c', source.slice(start, end) + '\nvalidate_tauri_launcher_preflight', file],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
    return 'accepted';
  } catch (error) {
    const failure = error as { status?: number; stderr?: string };
    return { status: failure.status, stderr: String(failure.stderr ?? '') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('frozen native SPA preparation', () => {
  function prepare(options: { pinned?: boolean; missingBuilder?: boolean; buildExit?: number;
    incomplete?: boolean; external?: boolean; sourceVolumeFull?: boolean;
    prebuildExit?: number; sourceExit?: number } = {}) {
    const dir = mkdtempSync(resolve(tmpdir(), 'tauri-spa-preflight-'));
    const frozen = resolve(dir, 'frozen');
    const app = resolve(frozen, 'apps/operator-vite');
    const capture = resolve(dir, 'build.json');
    const events = resolve(dir, 'events.jsonl');
    const preparation = source.match(/prepare_verifier_spa\(\) \{[\s\S]*?\n\}/)?.[0];
    if (!preparation) throw new Error('Frozen SPA preparation was not found');
    mkdirSync(resolve(app, 'bin'), { recursive: true });
    mkdirSync(resolve(frozen, 'scripts'), { recursive: true });
    if (!options.missingBuilder) writeFileSync(resolve(app, 'bin/vite-build-singleflight'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(resolve(frozen, 'scripts/pc-heavy.sh'), '#!/bin/bash\n[ "$1" != -- ] || shift\nexec "$@"\n');
    writeFileSync(resolve(frozen, 'scripts/source-preview.mjs'), `
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify({ step: 'verify', args: process.argv.slice(2) }) + '\\n');
process.exit(${options.sourceExit ?? 0});
`);
    writeFileSync(resolve(dir, 'npm'), `#!/usr/bin/env node
const fs = require('node:fs');
const step = process.argv.at(-1);
fs.appendFileSync(process.env.FIXTURE_EVENTS, JSON.stringify({ step }) + '\\n');
if (step === 'prebuild') process.exit(${options.prebuildExit ?? 0});
fs.writeFileSync(process.env.FIXTURE_CAPTURE, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2),
  out: process.env.VITE_BUILD_OUT_ROOT, command: process.env.VITE_BUILD_CMD ?? null,
  viteOut: process.env.PAPERCUSP_VITE_OUT_DIR, finalOut: process.env.PAPERCUSP_VITE_FINAL_OUT_DIR,
  lock: process.env.VITE_BUILD_LOCK ?? null, snapshot: process.env.VITE_BUILD_SNAPSHOT_DIR ?? null,
  retain: process.env.PAPERCUSP_RETAIN_DIST_CHUNKS }));
if (${Boolean(options.sourceVolumeFull)} && process.env.VITE_BUILD_OUT_ROOT === ${JSON.stringify(app)}) process.exit(28);
if (${options.buildExit ?? 0}) process.exit(${options.buildExit ?? 0});
fs.mkdirSync(process.env.VITE_BUILD_OUT_ROOT + '/dist/assets', { recursive: true });
fs.writeFileSync(process.env.VITE_BUILD_OUT_ROOT + '/dist/index.html', 'frozen HTML');
if (!${Boolean(options.incomplete)}) fs.writeFileSync(process.env.VITE_BUILD_OUT_ROOT + '/dist/assets/app.js', 'frozen UI');
`, { mode: 0o755 });
    try {
      const result = spawnSync('bash', ['-c', `set -euo pipefail
OPERATOR_SOURCE_ROOT="$FIXTURE_FROZEN"
WORK="$FIXTURE_DIR"
log() { :; }
${preparation}
prepare_verifier_spa
printf '%s' "$VERIFIER_SPA_DIST"
`], { encoding: 'utf8', timeout: 15_000, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`,
        FIXTURE_DIR: dir, FIXTURE_FROZEN: frozen, FIXTURE_CAPTURE: capture, FIXTURE_EVENTS: events,
        VERIFY_TAURI_SOURCE_RECEIPT: resolve(dir, 'source-receipt.json'),
        VERIFY_TAURI_SOURCE_REF: options.pinned === false ? '' : 'committed-pin',
        PAPERCUSP_SHARED_SPA_DIST: options.external ? resolve(dir, 'unbound-donor-dist') : '',
        VITE_BUILD_CMD: 'unbound-command', VITE_BUILD_LOCK: 'donor-lock', VITE_BUILD_SNAPSHOT_DIR: 'donor-snapshot' } });
      return { status: result.status, stderr: result.stderr, selected: result.stdout,
        expected: resolve(dir, 'verifier-spa/dist'), outputRoot: resolve(dir, 'verifier-spa'), frozen, app,
        sourceOutputExists: existsSync(resolve(app, 'dist')),
        events: existsSync(events) ? readFileSync(events, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [],
        receipt: resolve(dir, 'source-receipt.json'),
        build: existsSync(capture) ? JSON.parse(readFileSync(capture, 'utf8')) : null };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  it('builds from pinned source into the admitted work directory and selects only that artifact', () => {
    const result = prepare();
    expect(result.status, result.stderr).toBe(0);
    expect(result.selected).toBe(result.expected);
    expect(result.build).toEqual({ cwd: result.frozen, args: ['--ignore-scripts', '--workspace', '@papercusp/operator-vite', 'run', 'build'],
      out: result.outputRoot, viteOut: result.expected, finalOut: result.expected,
      command: null, lock: null, snapshot: null, retain: '0' });
    expect(result.events).toEqual([{ step: 'prebuild' }, { step: 'verify',
      args: ['verifier-verify', '--out', result.frozen, '--receipt', result.receipt, '--runtime-artifacts'] },
    { step: 'build' }]);
    expect(result.sourceOutputExists).toBe(false);
    expect(source.indexOf('vh_run_step verifier-spa-build')).toBeLessThan(source.indexOf('vh_run_step verifier-host-bundle'));
    expect(source.indexOf('vh_run_step verifier-spa-build')).toBeLessThan(source.indexOf('vh_step isolated-database-prepare'));
  });

  it('builds on the admitted work volume when the source volume refuses output allocation', () => {
    const result = prepare({ sourceVolumeFull: true });
    expect(result.status, result.stderr).toBe(0);
    expect(result.selected).toBe(result.expected);
    expect(result.sourceOutputExists).toBe(false);
  });

  it.each([
    [{ prebuildExit: 19 }, ['prebuild']],
    [{ sourceExit: 23 }, ['prebuild', 'verify']],
  ] as const)('rejects prebuild/source failures before the expensive SPA build (%j)', (options, steps) => {
    const result = prepare(options);
    expect(result.status).toBe('prebuildExit' in options ? options.prebuildExit : options.sourceExit);
    expect(result.events.map(event => event.step)).toEqual(steps);
    expect(result.build).toBeNull();
    expect(result.selected).toBe('');
  });

  it.each([
    [{ missingBuilder: true }, 3, 'VERIFY_TAURI_SPA_BUILD_MISSING'],
    [{ incomplete: true }, 3, 'VERIFY_TAURI_SPA_BUILD_INCOMPLETE'],
    [{ external: true }, 3, 'VERIFY_TAURI_SPA_UNBOUND'],
    [{ buildExit: 17 }, 17, ''],
    [{ buildExit: 28 }, 28, ''],
  ] as const)('refuses boot when frozen SPA preparation fails (%j)', (options, status, marker) => {
    const result = prepare(options);
    expect(result.status).toBe(status);
    expect(result.selected).toBe('');
    expect(result.stderr).toContain(marker);
    if ('missingBuilder' in options || 'external' in options) expect(result.build).toBeNull();
  });

  it('preserves the existing unpinned artifact selection without building', () => {
    const result = prepare({ pinned: false });
    expect(result.status).toBe(0);
    expect(result.selected).toBe('');
    expect(result.build).toBeNull();
  });
});
