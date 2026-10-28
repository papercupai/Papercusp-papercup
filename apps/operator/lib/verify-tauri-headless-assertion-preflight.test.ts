/**
 * Recurrence guard for EI-21974634479405756.
 *
 * Assertion commands run only after the verifier has built and booted a Tauri
 * instance. A malformed tauri-agent-tools invocation must be rejected before
 * that expensive boundary, with no tool or cargo process started.
 */
import { hermeticSpawnEnv } from './__tests__/hermetic-spawn-env';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');
const SCRIPT = resolve(ROOT, 'scripts/verify-tauri-headless.sh');
const src = readFileSync(SCRIPT, 'utf8');

function runAssertion(assertionSource: string, useBashC = false, command?: string[], env: NodeJS.ProcessEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-tauri-assertion-preflight.'));
  const assertion = join(dir, 'assertion.sh');
  const tool = join(dir, 'tauri-agent-tools');
  const cargo = join(dir, 'cargo');
  const invocations = join(dir, 'invocations');
  writeFileSync(assertion, assertionSource);
  writeFileSync(invocations, '');
  // This test measures argv rejection, not shared dependency installation or
  // restricted-hold census. Keep those preceding seams inside the fixture;
  // their real behavior is covered by their own canonical suites/native rig.
  mkdirSync(join(dir, 'scripts/lib'), { recursive: true });
  mkdirSync(join(dir, 'papercusp-desktop/bin/lib'), { recursive: true });
  writeFileSync(join(dir, 'scripts/lib/committed-source-loader.mjs'), '');
  writeFileSync(join(dir, 'scripts/restricted-hold-tree-gate.mjs'), 'process.exit(0);\n');
  writeFileSync(join(dir, 'scripts/lib/spa-require-built.sh'), '');
  writeFileSync(join(dir, 'papercusp-desktop/bin/lib/federation-asserts.sh'), '');
  writeFileSync(join(dir, 'scripts/lib/verify-tauri-assertion-env.mjs'),
    readFileSync(join(ROOT, 'scripts/lib/verify-tauri-assertion-env.mjs')));
  // Deadline admission precedes argv preflight in the real entrypoint. Keep
  // its maintained pure helpers so the fixture reaches the boundary it tests.
  for (const helper of ['verify-tauri-deadline.mjs', 'task-deadline.mjs']) {
    writeFileSync(join(dir, 'scripts/lib', helper), readFileSync(join(ROOT, 'scripts/lib', helper)));
  }
  // The copied helper dynamically imports shell-quote. Mirror the real
  // repository dependency resolution from the synthetic REPO_DIR so the
  // fixture exercises command grammar rather than a missing-parser failure.
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  writeFileSync(
    tool,
    '#!/usr/bin/env bash\nprintf "tool invoked\\n" >> "$VERIFY_TEST_INVOCATIONS"\nexit 0\n',
  );
  writeFileSync(
    cargo,
    '#!/usr/bin/env bash\nprintf "cargo invoked\\n" >> "$VERIFY_TEST_INVOCATIONS"\nexit 0\n',
  );
  chmodSync(tool, 0o755);
  chmodSync(cargo, 0o755);

  const args = command ?? (useBashC ? ['bash', '-c', assertionSource] : [assertion]);
  const result = spawnSync('bash', [SCRIPT, '--', ...args], {
    cwd: ROOT,
    env: {
      ...hermeticSpawnEnv(),
      PAPERCUSP_REPO_DIR: dir,
      PAPERCUSP_SID: 'test-assertion-preflight',
      PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID: '',
      PAPERCUSP_TASK_DEADLINE_EPOCH_MS: '',
      PAPERCUSP_APP_OPERATION_LIVE_PROFILE: '',
      TMPDIR: dir,
      VERIFY_TEST_INVOCATIONS: invocations,
      VERIFY_TAURI_AGENT_TOOLS_BIN: tool,
      VERIFY_TAURI_CARGO_BIN: cargo,
      ...env,
    },
    encoding: 'utf8',
    timeout: 15_000,
    killSignal: 'SIGKILL',
  });

  return { dir, invocations, result };
}

function runAssertionPreflightOnly(assertionSource: string) {
  const start = src.indexOf('validate_assertion_command_preflight() {');
  const end = src.indexOf('\n\nvalidate_assertion_command_preflight || exit $?', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);

  return spawnSync('bash', ['-c', [
    src.slice(start, end),
    'ASSERTION_MODE=1',
    'ASSERTION_ARGS=(bash -c "$VERIFY_TEST_ASSERTION_SOURCE")',
    'validate_assertion_command_preflight',
  ].join('\n')], {
    env: { ...hermeticSpawnEnv(), REPO_DIR: ROOT, VERIFY_TEST_ASSERTION_SOURCE: assertionSource },
    encoding: 'utf8',
    timeout: 15_000,
    killSignal: 'SIGKILL',
  });
}

function runManifestPreflight(actual: string, claimed: string, claimedRoot?: string, heredocLines: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-tauri-env-manifest.'));
  const assertion = join(dir, 'assertion.sh');
  const manifest = join(dir, 'manifest.json');
  const source = [
    '#!/usr/bin/env bash',
    `# VERIFY_TAURI_ASSERTION_ENV_MANIFEST=${manifest}`,
    `D=${dir}`,
    'export GST_DEBUG_FILE="$D/' + actual + '"',
    ...heredocLines,
    '',
  ].join('\n');
  writeFileSync(assertion, source);
  writeFileSync(manifest, JSON.stringify({
    assertionSha256: createHash('sha256').update(source).digest('hex'),
    diagnosticEnv: { GST_DEBUG_FILE: join(dir, claimed) },
    diagnosticLogRoot: claimedRoot ?? join(dir, 'current'),
  }));
  const start = src.indexOf('validate_assertion_command_preflight() {');
  const end = src.indexOf('\n\nvalidate_assertion_command_preflight || exit $?', start);
  const result = spawnSync('bash', ['-c', [
    src.slice(start, end),
    'ASSERTION_MODE=1',
    'ASSERTION_ARGS=(bash "$VERIFY_TEST_ASSERTION_PATH")',
    'validate_assertion_command_preflight',
  ].join('\n')], {
    env: {
      ...hermeticSpawnEnv(),
      REPO_DIR: ROOT,
      VERIFY_TEST_ASSERTION_PATH: assertion,
    },
    encoding: 'utf8',
    timeout: 15_000,
    killSignal: 'SIGKILL',
  });
  rmSync(dir, { recursive: true, force: true });
  return result;
}

describe('EI-21974634479405756 — assertion command preflight', () => {
  const parkedProfile = resolve(ROOT, 'packages/operator-core/test/parked-agent-audit.live-profile.json');

  it('budgets preparation before copying or native allocation', () => {
    const { dir, invocations, result } = runAssertion('true', true, undefined, {
      PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(Date.now() + 1_500_000),
      VERIFY_TAURI_PREPARE_ESTIMATE_MS: '1200000',
      VERIFY_TAURI_ASSERT_ESTIMATE_MS: '180000',
      VERIFY_TAURI_BUDGET_FROM: '',
    });
    try {
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain('TASK_DEADLINE_REFUSAL');
      expect(result.stderr).toContain('knownEstimateMs=2460000');
      expect(result.stderr).toContain('unknownTasks=0');
      expect(readFileSync(invocations, 'utf8')).toBe('');
      expect(readdirSync(dir).filter(entry => entry.startsWith('verify-tauri-headless.'))).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps a larger calibrated preparation estimate and deducts elapsed preparation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-tauri-budget-floor.'));
    const calibration = join(dir, 'phases.jsonl');
    writeFileSync(calibration, JSON.stringify({ phase: 'prepare', status: 'passed', elapsedMs: 120000 }) + '\n');
    try {
      const result = spawnSync(process.execPath, [resolve(ROOT, 'scripts/lib/verify-tauri-deadline.mjs'),
        'prepare', '1', '0', '0', '30'], {
        encoding: 'utf8', timeout: 15_000, env: { ...hermeticSpawnEnv(),
          PAPERCUSP_TASK_DEADLINE_EPOCH_MS: String(Date.now() + 200_000),
          VERIFY_TAURI_PREPARE_ESTIMATE_MS: '1', VERIFY_TAURI_BUDGET_FROM: calibration,
        },
      });
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain('knownEstimateMs=240000');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['0', '-1', '1.5', 'NaN'])('rejects an invalid preparation forecast before allocating (%s)', estimate => {
    const { dir, invocations, result } = runAssertion('true', true, undefined, {
      VERIFY_TAURI_PREPARE_ESTIMATE_MS: estimate, VERIFY_TAURI_BUDGET_FROM: '',
    });
    try {
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain('Invalid VERIFY_TAURI_PREPARE_ESTIMATE_MS');
      expect(readFileSync(invocations, 'utf8')).toBe('');
      expect(readdirSync(dir).filter(entry => entry.startsWith('verify-tauri-headless.'))).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['', '   '])('rejects a missing live-profile app workspace before native preparation (%j)', workspace => {
    const { dir, invocations, result } = runAssertion('true', true, undefined, {
      PAPERCUSP_APP_OPERATION_LIVE_PROFILE: parkedProfile,
      PAPERCUSP_WORKSPACE: workspace,
      PAPERCUSP_TEST_RUN_WORKSPACE: 'ledger-only',
      VERIFY_TAURI_ISOLATED_DB: '0',
    });
    try {
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain('PAPERCUSP_WORKSPACE is required before verifier preparation (live profile)');
      expect(readFileSync(invocations, 'utf8')).toBe('');
      expect(readdirSync(dir).filter(entry => entry.startsWith('verify-tauri-headless.'))).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([
    { isolated: '0', workspace: 'app-workspace', sid: 'caller', current: '0', owner: '', status: 0 },
    { isolated: '1', workspace: '', sid: 'caller', current: '0', owner: '', status: 0 },
    { isolated: '1', workspace: '', sid: '', current: '0', owner: '', status: 2 },
    { isolated: '1', workspace: '', sid: 'caller', current: '1', owner: '', status: 2 },
    { isolated: '0', workspace: 'app-workspace', sid: 'caller', current: '1', owner: 'actual-owner', status: 0 },
  ])('checks caller inputs and defers only verifier-generated isolated values ($isolated/$sid/$current)', value => {
    const result = spawnSync(process.execPath,
      [resolve(ROOT, 'scripts/lib/verify-tauri-assertion-env.mjs'), '--command', 'bash', '-c', 'true'], {
        encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL', env: {
          ...hermeticSpawnEnv(), PAPERCUSP_APP_OPERATION_LIVE_PROFILE: parkedProfile,
          VERIFY_TAURI_ISOLATED_DB: value.isolated, PAPERCUSP_WORKSPACE: value.workspace,
          PAPERCUSP_SID: value.sid, PAPERCUSP_PARKED_CURRENT_LIVE: value.current,
          PAPERCUSP_PARKED_AUDIT_OWNER: value.owner,
        },
      });
    expect(result.status, result.stderr).toBe(value.status);
    if (value.status === 2) expect(result.stderr).toContain(
      `${value.sid ? 'PAPERCUSP_PARKED_AUDIT_OWNER' : 'PAPERCUSP_SID'} is required before verifier preparation`);
  });

  it.each(['caller', ' caller '])('refuses the authenticated caller as a parked target before native preparation (%j)', owner => {
    const { dir, invocations, result } = runAssertion('true', true, undefined, {
      PAPERCUSP_APP_OPERATION_LIVE_PROFILE: parkedProfile,
      PAPERCUSP_WORKSPACE: 'app-workspace', VERIFY_TAURI_ISOLATED_DB: '0',
      PAPERCUSP_SID: 'caller', PAPERCUSP_PARKED_CURRENT_LIVE: '1',
      PAPERCUSP_PARKED_AUDIT_OWNER: owner,
    });
    try {
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain('PAPERCUSP_PARKED_AUDIT_OWNER must differ from PAPERCUSP_SID');
      expect(readFileSync(invocations, 'utf8')).toBe('');
      expect(readdirSync(dir).filter(entry => entry.startsWith('verify-tauri-headless.'))).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('allows the caller target when the parked-current check is disabled', () => {
    const result = spawnSync(process.execPath,
      [resolve(ROOT, 'scripts/lib/verify-tauri-assertion-env.mjs'), '--command', 'bash', '-c', 'true'], {
        encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL', env: {
          ...hermeticSpawnEnv(), PAPERCUSP_APP_OPERATION_LIVE_PROFILE: parkedProfile,
          PAPERCUSP_WORKSPACE: 'app-workspace', VERIFY_TAURI_ISOLATED_DB: '0',
          PAPERCUSP_SID: 'caller', PAPERCUSP_PARKED_CURRENT_LIVE: '0', PAPERCUSP_PARKED_AUDIT_OWNER: 'caller',
        },
      });
    expect(result.status, result.stderr).toBe(0);
  });

  it('refuses an unreadable live profile before allocating the native rig', () => {
    const { dir, invocations, result } = runAssertion('true', true, undefined, {
      PAPERCUSP_APP_OPERATION_LIVE_PROFILE: '/missing/live-profile.json',
    });
    try {
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain('live profile could not be read');
      expect(readFileSync(invocations, 'utf8')).toBe('');
      expect(readdirSync(dir).filter(entry => entry.startsWith('verify-tauri-headless.'))).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['reports', 'dao-workbench'])('rejects a missing native %s ledger before cargo, bridge or resource allocation', driver => {
    const { dir, invocations, result } = runAssertion('', false,
      [process.execPath, '--import', 'tsx', resolve(ROOT, 'scripts/tauri-surface-verify-' + driver + '.mts'), '--e2e'],
      { PAPERCUSP_TEST_RUNS_DB_URL: '' });
    try {
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain('PAPERCUSP_TEST_RUNS_DB_URL is required before verifier preparation');
      expect(readFileSync(invocations, 'utf8')).toBe('');
      expect(readdirSync(dir).filter(entry => entry.startsWith('verify-tauri-headless.'))).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['', '   '])('rejects empty inherited prerequisites without leaking other values (%j)', value => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-tauri-required-env.'));
    const assertion = join(dir, 'driver.mts');
    writeFileSync(assertion, '// VERIFY_TAURI_ASSERTION_REQUIRED_ENV=PAPERCUSP_TEST_RUNS_DB_URL,VERIFY_TEST_SECOND\n');
    try {
      const result = spawnSync(process.execPath,
        [resolve(ROOT, 'scripts/lib/verify-tauri-assertion-env.mjs'), '--command', 'node', '--import', 'tsx', assertion],
        { encoding: 'utf8', env: { ...hermeticSpawnEnv(), PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://user:fixture-secret@ledger/db',
          VERIFY_TEST_SECOND: value }, timeout: 15_000, killSignal: 'SIGKILL' });
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain('VERIFY_TEST_SECOND is required before verifier preparation');
      expect(`${result.stdout}${result.stderr}`).not.toContain('fixture-secret');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['reports', 'dao-workbench'])('rejects a missing %s caller workspace before native preparation', driver => {
    const { dir, invocations, result } = runAssertion('', false,
      [process.execPath, '--import', 'tsx', resolve(ROOT, 'scripts/tauri-surface-verify-' + driver + '.mts'), '--e2e'],
      { PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://synthetic:fixture@ledger/db', PAPERCUSP_TEST_RUN_WORKSPACE: '' });
    try {
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain('PAPERCUSP_TEST_RUN_WORKSPACE is required before verifier preparation');
      expect(readFileSync(invocations, 'utf8')).toBe('');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(['reports', 'dao-workbench'])('accepts configured %s without starting its assertion or exposing credentials', driver => {
    const start = src.indexOf('validate_assertion_command_preflight() {');
    const end = src.indexOf('\n\nvalidate_assertion_command_preflight || exit $?', start);
    const result = spawnSync('bash', ['-c', [src.slice(start, end),
      'ASSERTION_MODE=1',
      'ASSERTION_ARGS=(node --import tsx "$REPO_DIR/scripts/tauri-surface-verify-' + driver + '.mts" --e2e)',
      'validate_assertion_command_preflight',
    ].join('\n')], { encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL', env: { ...hermeticSpawnEnv(), REPO_DIR: ROOT,
      PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://user:fixture-secret@ledger/db', PAPERCUSP_TEST_RUN_WORKSPACE: 'native-owner-fixture',
      PAPERCUSP_TEST_RUN_GROUP: 'native-owner-fixture-run' } });
    expect(result.status, result.stderr).toBe(0);
    const expectedPrerequisites = driver === 'reports' ? '3 prerequisite(s)' : '2 prerequisite(s)';
    expect(result.stdout).toContain(expectedPrerequisites);
    expect(`${result.stdout}${result.stderr}`).not.toContain('fixture-secret');
  });

  it('runs before workdir/resource allocation and checks shell syntax', () => {
    const preflight = src.indexOf('validate_assertion_command_preflight || exit $?');
    const work = src.indexOf('WORK="$(mktemp -d');

    expect(preflight).toBeGreaterThan(-1);
    expect(preflight).toBeLessThan(work);
    expect(src).toContain('bash -n -- "$source_path"');
    expect(src).toContain('tauri-agent-tools --pid/--port must follow its subcommand');
  });

  it('rejects a malformed file-backed CLI invocation without starting cargo or the tool', () => {
    const { dir, invocations, result } = runAssertion(
      '#!/usr/bin/env bash\nset -e\ntauri-agent-tools --port "$P" eval true\n',
    );

    try {
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain('VERIFY_TAURI_ASSERTION_INVALID');
      expect(result.stderr).toContain(
        'tauri-agent-tools --pid/--port must follow its subcommand',
      );
      expect(result.stderr).toContain('offending command');
      expect(readFileSync(invocations, 'utf8')).toBe('');
      expect(
        readdirSync(dir).filter((entry) => entry.startsWith('verify-tauri-headless.')),
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects the same option-order mistake in an inline bash -c assertion', () => {
    const { dir, invocations, result } = runAssertion(
      'tauri-agent-tools --pid "$P" check --selector body',
      true,
    );

    try {
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain('VERIFY_TAURI_ASSERTION_INVALID');
      expect(result.stderr).toContain('must follow its subcommand');
      expect(readFileSync(invocations, 'utf8')).toBe('');
      expect(
        readdirSync(dir).filter((entry) => entry.startsWith('verify-tauri-headless.')),
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an unqualified bridge probe before starting the verifier', () => {
    const { dir, invocations, result } = runAssertion('tauri-agent-tools probe', true);

    try {
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain('must pin --pid to "$VERIFY_TAURI_PID"');
      expect(readFileSync(invocations, 'utf8')).toBe('');
      expect(
        readdirSync(dir).filter((entry) => entry.startsWith('verify-tauri-headless.')),
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not accept a caller-supplied PID that could select a different bridge', () => {
    const result = runAssertionPreflightOnly('tauri-agent-tools probe --pid "$OTHER_PID"');
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('must pin --pid to "$VERIFY_TAURI_PID"');
  });

  it('accepts the verifier-owned PID as a negative control', () => {
    const result = runAssertionPreflightOnly(
      'tauri-agent-tools probe --pid "$VERIFY_TAURI_PID"',
    );
    expect(result.status, result.stderr).toBe(0);
  });

  it('accepts executable and PID aliases derived from verifier-owned values', () => {
    const result = runAssertionPreflightOnly([
      'TOOL="$VERIFY_TAURI_AGENT_TOOLS_BIN"',
      'PID="$VERIFY_TAURI_PID"',
      '"$TOOL" probe --pid "$PID"',
    ].join('\n'));
    expect(result.status, result.stderr).toBe(0);
  });

  it('does not treat command output plus quoted snapshot prose as a bridge invocation', () => {
    const result = runAssertionPreflightOnly([
      'ROUTES="$(printf "%s" tauri-agent-tools)"',
      'TOOL="$VERIFY_TAURI_AGENT_TOOLS_BIN"',
      'echo "$ROUTES $TOOL" | grep -q "sourcesArray=true" || fail "trigger snapshot route did not return sources[]"',
    ].join('\n'));

    expect(result.status, result.stderr).toBe(0);
  });

  it('still rejects an actual bridge alias invocation when its arguments mention snapshot prose', () => {
    const result = runAssertionPreflightOnly([
      'TOOL="$VERIFY_TAURI_AGENT_TOOLS_BIN"',
      '"$TOOL" probe "snapshot route"',
    ].join('\n'));

    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('must pin --pid to "$VERIFY_TAURI_PID"');
  });

  it('rejects invalid shell syntax before any verifier dependency is executed', () => {
    const { dir, invocations, result } = runAssertion(
      '#!/usr/bin/env bash\nif then\n  echo never\nfi\n',
    );

    try {
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain('VERIFY_TAURI_ASSERTION_INVALID');
      expect(result.stderr).toContain('invalid shell syntax');
      expect(readFileSync(invocations, 'utf8')).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('WI-10002829 — assertion environment manifest preflight', () => {
  it('rejects an assertion copied from an older diagnostic before verifier preparation', () => {
    const result = runManifestPreflight('old/gst.%p.log', 'current/gst.%p.log');
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('GST_DEBUG_FILE differs from manifest diagnosticEnv');
    expect(src.indexOf('validate_assertion_command_preflight || exit $?'))
      .toBeLessThan(src.indexOf('shared_schema_readiness_preflight || exit $?'));
    expect(src.indexOf('validate_assertion_command_preflight || exit $?'))
      .toBeLessThan(src.indexOf('WORK="$(mktemp -d'));
    expect(src).toContain('sha256sum -- "$ASSERTION_ENV_MANIFEST_PATH" >> "$ASSERTION_INPUT_MANIFEST"');
  });

  it('rejects an internally inconsistent manifest even when the export agrees', () => {
    const result = runManifestPreflight('current/gst.%p.log', 'current/gst.%p.log', '/dev/shm/other');
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('GST_DEBUG_FILE parent differs from manifest diagnosticLogRoot');
  });

  it('accepts a matching immutable assertion and manifest', () => {
    const result = runManifestPreflight('current/gst.%p.log', 'current/gst.%p.log');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('VERIFY_TAURI_ASSERTION_ENV_OK 1 binding(s)');
  });

  it('ignores Python assignments inside a quoted heredoc', () => {
    const result = runManifestPreflight(
      'current/gst.%p.log',
      'current/gst.%p.log',
      undefined,
      ["python3 - <<'PY'", "D=Path('not a shell assignment')", 'PY'],
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('VERIFY_TAURI_ASSERTION_ENV_OK 1 binding(s)');
  });

  it('does not let a heredoc spoof a manifest export', () => {
    const result = runManifestPreflight(
      'old/gst.%p.log',
      'current/gst.%p.log',
      undefined,
      ["python3 - <<'PY'", 'export GST_DEBUG_FILE="$D/current/gst.%p.log"', 'PY'],
    );
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('GST_DEBUG_FILE differs from manifest diagnosticEnv');
  });
});
