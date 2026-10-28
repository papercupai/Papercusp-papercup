/**
 * Recurrence guard for EI-21590235587564636.
 *
 * The verifier source is read lazily by bash. An in-place peer save during the
 * multi-minute Tauri boot can therefore splice a partial line into the running
 * script even though the source was valid at launch. The SPA snapshot guard
 * protects the bundle served by the rig, but it cannot protect this wrapper's
 * own source. Pin the startup snapshot/re-exec contract on the real script.
 */
import { hermeticSpawnEnv } from "./__tests__/hermetic-spawn-env";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// PROBE_SCRIPT lets scripts/mutation-probe.sh point this guard at a mutated copy.
const SCRIPT = process.env.PROBE_SCRIPT ?? resolve(__dirname, "../../../scripts/verify-tauri-headless.sh");
const src = readFileSync(SCRIPT, "utf8");
const HOST_ENTRY = resolve(__dirname, "../bin/hono-host.ts");
const hostEntrySrc = readFileSync(HOST_ENTRY, "utf8");

const snapshotGuardIdx = src.indexOf("VERIFY_TAURI_SOURCE_SNAPSHOT_PATH=");
const argumentParserIdx = src.indexOf('if [ "${1:-}" = "--help" ]');
const installPreflightIdx = src.indexOf(
  "install_in_flight_preflight || exit $?",
);
const workAllocationIdx = src.indexOf('WORK="$(mktemp -d');
const sourceReexecIdx = src.indexOf(
  'exec bash "$VERIFY_TAURI_SOURCE_SNAPSHOT_PATH" "$@"',
);
const assertionExecIdx = src.lastIndexOf('log "running assertion command: $*"');
const operatorSnapshotIdx = src.indexOf("snapshot_operator_source() {");
const dependencySnapshotSource = src.slice(src.indexOf("snapshot_verifier_pinned_deps() {"), operatorSnapshotIdx);
const spaCleanupSource = src.match(/^cleanup_verifier_spa_snapshot\(\) \{[\s\S]*?^\}/m)?.[0] ?? '';
const operatorSnapshotCallIdx = src.indexOf("verifier_run_step operator-source-snapshot");
const normalizeOperatorSourceTestStub = 'normalize_operator_source_root() { OPERATOR_SOURCE_ROOT="$1"; }; preflight_verifier_runtime_assets() { :; }';
const sourceRefNormalizationTestStub = 'git() { [ -z "${TEST_GIT_LOG:-}" ] || printf "%s\\n" "$*" >> "$TEST_GIT_LOG"; printf "%s\\n" "${TEST_RESOLVED_SOURCE_REF:-commit}"; }; ' + normalizeOperatorSourceTestStub;
const lockCensusStartIdx = src.indexOf("verify_operator_source_lock_census() {");
const lockCensusSource = src.slice(lockCensusStartIdx, operatorSnapshotIdx);
const operatorSnapshotSource = `${src.slice(operatorSnapshotIdx, operatorSnapshotCallIdx)}\n${normalizeOperatorSourceTestStub}`;

function committedSnapshotSource(end = operatorSnapshotCallIdx, testStub = normalizeOperatorSourceTestStub) {
  return `${src.slice(src.indexOf('snapshot_committed_operator_source() {'), end)}\n${testStub}`;
}

describe('EI-26928176238125992 — one admission for frozen SPA preparation', () => {
  const prepare = src.match(/prepare_verifier_spa\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';

  it.each([0, 37])('freezes a qualified candidate through the early validator and preserves refusal: %s', status => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'verifier-candidate-spa-'));
    try {
      const result = spawnSync('bash', ['-c', [
        'set -eu', 'log() { :; }',
        'node() { printf "%s\\n" "$@" > "$TEST_ROOT/args"; return "$TEST_STATUS"; }',
        prepare, 'prepare_verifier_spa || exit $?',
        '[ "$VERIFIER_SPA_DIST" = "$WORK/verifier-spa/dist" ]',
      ].join('\n')], { encoding: 'utf8', timeout: 5_000, env: {
        ...hermeticSpawnEnv(), TEST_ROOT: fixture, TEST_STATUS: String(status), WORK: resolve(fixture, 'work'),
        VERIFY_TAURI_SOURCE_REF: 'selected-commit', VERIFY_TAURI_SOURCE_REPO_DIR: '/selected/source',
        PAPERCUSP_SHARED_SPA_DIST: '/private/candidate/spa',
      } });
      expect(result.status, result.stderr).toBe(status);
      expect(readFileSync(resolve(fixture, 'args'), 'utf8').trim().split('\n')).toEqual([
        '/selected/source/scripts/lib/verify-tauri-native-env.mjs', '--candidate-spa', '/selected/source',
        resolve(fixture, 'work/verifier-spa/dist'),
      ]);
      const earlyCheck = src.indexOf('--candidate-spa "$VERIFY_TAURI_SOURCE_REPO_DIR" || exit $?');
      expect(earlyCheck).toBeGreaterThan(0);
      expect(earlyCheck).toBeLessThan(workAllocationIdx);
      expect(earlyCheck).toBeLessThan(operatorSnapshotCallIdx);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.each(['none', 'admission', 'prebuild', 'verify', 'build'])('admits once and stops at the first failed phase: %s', failure => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'verifier-spa-admission-'));
    const frozen = resolve(fixture, 'source');
    const order = resolve(fixture, 'order');
    const receipt = resolve(fixture, 'source-receipt.json');
    const output = resolve(fixture, 'work/verifier-spa/dist');
    const script = (path: string, body: string) => {
      mkdirSync(resolve(path, '..'), { recursive: true });
      writeFileSync(path, `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
    };
    try {
      writeFileSync(receipt, 'original source receipt');
      script(resolve(frozen, 'apps/operator-vite/bin/vite-build-singleflight'), 'exit 0');
      script(resolve(frozen, 'apps/operator/scripts/setup-porcupine-runtime.sh'), 'echo seed >> "$ORDER"');
      script(resolve(frozen, 'scripts/pc-heavy.sh'), [
        'echo admission >> "$ORDER"',
        '[ "$FAIL_STEP" != admission ] || exit 23',
        '[ "$1" = -- ]; shift',
        'export PC_HEAVY_BYPASS=1',
        '"$@"',
      ].join('\n'));
      script(resolve(fixture, 'bin/npm'), [
        'phase="${!#}"',
        '[ "$PC_HEAVY_BYPASS" = 1 ]',
        '[ "$PAPERCUSP_RETAIN_DIST_CHUNKS" = 0 ]',
        '[ "$PAPERCUSP_VITE_OUT_DIR" = "$EXPECTED_DIST" ]',
        '[ "$PAPERCUSP_VITE_FINAL_OUT_DIR" = "$EXPECTED_DIST" ]',
        '[ "$VITE_BUILD_OUT_ROOT/dist" = "$EXPECTED_DIST" ]',
        '[ -z "${VITE_BUILD_CMD+x}${VITE_BUILD_LOCK+x}${VITE_BUILD_SNAPSHOT_DIR+x}" ]',
        'echo "$phase" >> "$ORDER"',
        '[ "$FAIL_STEP" != "$phase" ] || exit 17',
        'if [ "$phase" = build ]; then mkdir -p "$EXPECTED_DIST/assets"; printf index > "$EXPECTED_DIST/index.html"; printf asset > "$EXPECTED_DIST/assets/entry.js"; fi',
      ].join('\n'));
      script(resolve(fixture, 'bin/node'), [
        '[ "$PC_HEAVY_BYPASS" = 1 ]',
        '[ "$*" = "scripts/source-preview.mjs verifier-verify --out $OPERATOR_SOURCE_ROOT --receipt $VERIFY_TAURI_SOURCE_RECEIPT --runtime-artifacts" ]',
        'echo verify >> "$ORDER"',
        '[ "$FAIL_STEP" != verify ] || exit 19',
      ].join('\n'));
      const result = spawnSync('bash', ['-c', [
        'set -eu',
        'log() { :; }',
        prepare,
        'prepare_verifier_spa || exit $?',
        '[ "$VERIFIER_SPA_DIST" = "$EXPECTED_DIST" ]',
      ].join('\n')], { encoding: 'utf8', timeout: 5_000, env: {
        ...hermeticSpawnEnv(), PATH: `${fixture}/bin:${process.env.PATH}`,
        WORK: resolve(fixture, 'work'), REPO_DIR: resolve(fixture, 'donor'),
        OPERATOR_SOURCE_ROOT: frozen, VERIFY_TAURI_SOURCE_RECEIPT: receipt,
        VERIFY_TAURI_SOURCE_REF: 'fixture-commit', PAPERCUSP_SHARED_SPA_DIST: '',
        ORDER: order, EXPECTED_DIST: output, FAIL_STEP: failure,
        VITE_BUILD_CMD: 'inherited-command', VITE_BUILD_LOCK: 'inherited-lock', VITE_BUILD_SNAPSHOT_DIR: 'inherited-output',
      } });
      expect(result.status, result.stderr).toBe(failure === 'none' ? 0 : failure === 'admission' ? 23 : failure === 'verify' ? 19 : 17);
      const phases = ['prebuild', 'verify', 'build'];
      const completed = failure === 'none' ? phases : failure === 'admission' ? [] : phases.slice(0, phases.indexOf(failure) + 1);
      expect(readFileSync(order, 'utf8').trim().split('\n')).toEqual(['seed', 'admission', ...completed]);
      expect(readFileSync(receipt, 'utf8')).toBe('original source receipt');
      expect(existsSync(resolve(output, 'index.html'))).toBe(failure === 'none');
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
});

describe('WI-6554700010027579 — committed native runtime asset inputs', () => {
  const setupSource = readFileSync(resolve(__dirname, '../scripts/setup-porcupine-runtime.sh'), 'utf8');
  const model = 'pinned fixture wake-word model\n';
  const digest = createHash('sha256').update(model).digest('hex');
  const setup = setupSource.replace(/^PORCUPINE_SHA256="[a-f0-9]+"/m, `PORCUPINE_SHA256="${digest}"`);
  const preflight = src.match(/preflight_verifier_runtime_assets\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';

  it.each(['valid', 'missing', 'corrupt'])('checks the selected commit pin without network or output mutation: %s', mode => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'verifier-model-preflight-'));
    try {
      const work = resolve(fixture, 'work');
      const donor = resolve(fixture, 'donor');
      mkdirSync(work); mkdirSync(resolve(donor, 'apps/operator/public/porcupine'), { recursive: true });
      const cached = resolve(donor, 'apps/operator/public/porcupine/porcupine_params.pv');
      if (mode !== 'missing') writeFileSync(cached, mode === 'valid' ? model : 'wrong model');
      writeFileSync(resolve(fixture, 'selected-setup.sh'), setup);
      const result = spawnSync('bash', ['-c', [
        'set -euo pipefail',
        'WORK="$TEST_ROOT/work"; REPO_DIR="$TEST_ROOT/donor"; VERIFY_TAURI_SOURCE_REF=selected-commit',
        'git() { printf "%s\\n" "$*" > "$TEST_ROOT/git-args"; cat "$TEST_ROOT/selected-setup.sh"; }',
        'curl() { echo unexpected-network >&2; return 99; }; export -f curl',
        preflight, 'preflight_verifier_runtime_assets /selected/source',
      ].join('\n')], { encoding: 'utf8', timeout: 5_000, env: { ...hermeticSpawnEnv(), TEST_ROOT: fixture } });
      expect(result.status, result.stderr).toBe(mode === 'valid' ? 0 : 1);
      expect(readFileSync(resolve(fixture, 'git-args'), 'utf8')).toContain(
        '-C /selected/source cat-file blob selected-commit:apps/operator/scripts/setup-porcupine-runtime.sh');
      expect(result.stderr).not.toContain('unexpected-network');
      expect(existsSync(resolve(fixture, 'public'))).toBe(false);
      if (mode !== 'valid') expect(result.stderr).toContain('required cached model');
      const committed = committedSnapshotSource();
      expect(committed.indexOf('preflight_verifier_runtime_assets "$source_repo"')).toBeGreaterThan(0);
      expect(committed.indexOf('preflight_verifier_runtime_assets "$source_repo"'))
        .toBeLessThan(committed.indexOf('verifier-measure'));
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.each(['valid', 'corrupt', 'missing'])('seeds only copied checksum-valid bytes before SPA prebuild: %s', mode => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'verifier-model-seed-'));
    try {
      const app = resolve(fixture, 'apps/operator');
      mkdirSync(resolve(app, 'scripts'), { recursive: true });
      const helper = resolve(app, 'scripts/setup-porcupine-runtime.sh');
      writeFileSync(helper, setup);
      const cached = resolve(fixture, 'cached.pv');
      if (mode !== 'missing') writeFileSync(cached, mode === 'valid' ? model : 'corrupt donor');
      const result = spawnSync('bash', ['-c',
        'curl() { echo unexpected-network >&2; return 99; }; export -f curl; bash "$1" --source "$2"',
        'fixture', helper, cached], { encoding: 'utf8', timeout: 5_000 });
      expect(result.status, result.stderr).toBe(mode === 'valid' ? 0 : 1);
      expect(result.stderr).not.toContain('unexpected-network');
      const dest = resolve(app, 'public/porcupine/porcupine_params.pv');
      expect(existsSync(dest)).toBe(mode === 'valid');
      if (mode === 'valid') {
        expect(readFileSync(dest, 'utf8')).toBe(model);
        writeFileSync(cached, 'later donor change');
        expect(readFileSync(dest, 'utf8')).toBe(model);
      }
      const build = src.match(/prepare_verifier_spa\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
      expect(build.indexOf('setup-porcupine-runtime.sh" --source')).toBeGreaterThan(0);
      expect(build.indexOf('setup-porcupine-runtime.sh" --source'))
        .toBeLessThan(build.indexOf('run prebuild'));
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
});

describe('EI-25695165283875278 — assertion artifacts survive snapshot teardown', () => {
  function finishFixture(exitCode: number, options: { copyFails?: boolean; stopFails?: boolean; cleanupFails?: boolean; noArtifacts?: boolean; noHarness?: boolean } = {}) {
    const fixture = mkdtempSync(resolve(tmpdir(), 'verifier-retained-artifacts-'));
    const source = resolve(fixture, 'source snapshot/operator-source');
    const work = resolve(fixture, 'work');
    const evidence = options.noHarness ? work : resolve(fixture, 'retained evidence');
    const attachment = 'apps/operator/test-results/native-statements/attachments/unavailable.json';
    mkdirSync(source, { recursive: true });
    mkdirSync(work);
    if (!options.noArtifacts) {
      mkdirSync(resolve(source, 'apps/operator/test-results/native-statements/attachments'), { recursive: true });
      mkdirSync(resolve(source, 'apps/operator/playwright-report'), { recursive: true });
      writeFileSync(resolve(source, attachment), '{"before":null,"after":null}\n');
      writeFileSync(resolve(source, 'apps/operator/playwright-report/index.html'), '<html>passed</html>');
      writeFileSync(resolve(source, 'apps/operator/junit-e2e.xml'), '<testsuite failures="0"/>');
    }
    const retention = src.match(/retain_assertion_artifacts\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    const bootRetention = src.match(/retain_boot_attempt_evidence\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    const cleanup = src.match(/cleanup_operator_source_snapshot\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    const teardown = src.match(/teardown\(\) \{[\s\S]*?\n\}/)?.[0] ?? '';
    const result = spawnSync('bash', ['-c', [
      'set -uo pipefail',
      'WORK="$TEST_WORK"; OPERATOR_SOURCE_ROOT="$TEST_SOURCE"; OPERATOR_SOURCE_WORK="$(dirname "$TEST_SOURCE")"',
      'VH_RUN_DIR="$TEST_EVIDENCE"; ASSERTION_MODE=1; SIGNAL_EXIT_CODE=0; ISOLATED_PG_PID=""; BRIDGE_PID=""; TAURI_LAUNCH_PROVENANCE=test-provenance; VERIFY_SCOPE_BASE=test-scope',
      'release_verifier_disk_reservations() { :; }; log() { echo "$*" >&2; }',
      'vh_capture_phase_stop() { :; }; vh_step() { :; }; vh_exit() { echo "verdict:$1"; }; capture_isolated_pg_diagnostics() { :; }; reap_frozen_source_survivors() { :; }',
      `write_stop_script() { printf '#!/bin/sh\\nexit ${options.stopFails ? 37 : 0}\\n' > "$WORK/stop.sh"; chmod +x "$WORK/stop.sh"; }`,
      'wait_owned_ports_free() { :; }; fed_release_port_locks() { :; }; display_lock_release() { :; }',
      'cleanup_assertion_script_snapshot() { :; }; cleanup_verifier_source_snapshot() { :; }',
      options.copyFails ? 'cp() { return 1; }' : '',
      retention, bootRetention, cleanup, spaCleanupSource,
      options.cleanupFails ? 'cleanup_operator_source_snapshot() { return 1; }' : '',
      teardown, `(exit ${exitCode}); teardown`,
    ].join('\n')], {
      encoding: 'utf8', timeout: 10_000,
      env: { ...hermeticSpawnEnv(), TEST_SOURCE: source, TEST_WORK: work, TEST_EVIDENCE: options.noHarness ? '' : evidence },
    });
    return { fixture, source, evidence, attachment, result };
  }

  it.each([0, 23])('retains exact Playwright attachments and reports before deleting source (exit=%s)', exitCode => {
    const run = finishFixture(exitCode);
    try {
      expect(run.result.status, run.result.stderr).toBe(exitCode);
      expect(run.result.stdout).toContain(`verdict:${exitCode}`);
      expect(existsSync(run.source)).toBe(false);
      const retained = resolve(run.evidence, 'phases/assert/artifacts');
      expect(readFileSync(resolve(retained, run.attachment), 'utf8')).toBe('{"before":null,"after":null}\n');
      expect(readFileSync(resolve(retained, 'apps/operator/playwright-report/index.html'), 'utf8')).toBe('<html>passed</html>');
      expect(readFileSync(resolve(retained, 'apps/operator/junit-e2e.xml'), 'utf8')).toBe('<testsuite failures="0"/>');
    } finally { rmSync(run.fixture, { recursive: true, force: true }); }
  });

  it.each([0, 23])('keeps the original evidence and fails a successful run when copying fails (exit=%s)', exitCode => {
    const run = finishFixture(exitCode, { copyFails: true });
    try {
      expect(run.result.status).toBe(exitCode || 1);
      expect(existsSync(run.source)).toBe(true);
      expect(readFileSync(resolve(run.source, run.attachment), 'utf8')).toBe('{"before":null,"after":null}\n');
      expect(run.result.stderr).toContain('assertion artifact retention failed');
    } finally { rmSync(run.fixture, { recursive: true, force: true }); }
  });

  it.each(['stopFails', 'cleanupFails'] as const)('records a failing terminal verdict when %s after passing assertions', failure => {
    const run = finishFixture(0, { [failure]: true });
    try {
      expect(run.result.status, run.result.stderr).toBe(1);
      expect(run.result.stdout).toContain('verdict:1');
      expect(run.result.stdout).not.toContain('verdict:0');
      expect(existsSync(run.source)).toBe(true);
    } finally { rmSync(run.fixture, { recursive: true, force: true }); }
  });

  it('retains artifacts with instrumentation disabled in the surviving work directory', () => {
    const run = finishFixture(0, { noHarness: true });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(readFileSync(resolve(run.evidence, 'phases/assert/artifacts', run.attachment), 'utf8')).toBe('{"before":null,"after":null}\n');
    } finally { rmSync(run.fixture, { recursive: true, force: true }); }
  });

  it('does not create an empty artifact tree when assertions produce no report', () => {
    const run = finishFixture(0, { noArtifacts: true });
    try {
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(existsSync(resolve(run.evidence, 'phases/assert/artifacts'))).toBe(false);
      expect(existsSync(run.source)).toBe(false);
    } finally { rmSync(run.fixture, { recursive: true, force: true }); }
  });

  it('guards boot-only cleanup with the persisted reaper and keeps assertion cleanup in teardown', () => {
    const stop = src.slice(src.indexOf('write_stop_script() {'), src.indexOf('# let the one EXIT trap own cleanup.'));
    expect(stop).toContain('if [ "\\$SOURCE_CLEANUP_FAILED" -eq 0 ] && [ "$ASSERTION_MODE" -eq 0 ] && [ -n "$OPERATOR_SOURCE_WORK" ]; then');
    expect(stop).toContain('source "$WORK/frozen-source-reaper.sh"');
    expect(stop).toContain('reap_frozen_source_survivors "$OPERATOR_SOURCE_ROOT" "$TAURI_LAUNCH_PROVENANCE"');
    expect(stop).toContain('rm -rf -- "$OPERATOR_SOURCE_WORK"');
    expect(stop).toContain('SOURCE_CLEANUP_FAILED=1');
    expect(stop).toContain('exit 1');
    const teardown = src.slice(src.indexOf('teardown() {'), src.indexOf('\nverify_assertion_input_integrity()'));
    expect(teardown).toContain('"$WORK/stop.sh" >"$WORK/stop.log" 2>&1 || stop_rc=$?');
    expect(teardown).toContain('log "FATAL: generated stop script failed (exit=$stop_rc)"');
    expect(teardown).toContain('cleanup_operator_source_snapshot || {');
  });

  it('normalizes the frozen source root in both snapshot routes', () => {
    const committedStart = src.indexOf('snapshot_committed_operator_source() {');
    const committedEnd = src.indexOf('verifier_run_step operator-source-snapshot', committedStart);
    const committed = committedSnapshotSource(committedEnd);
    expect(operatorSnapshotSource).toContain('normalize_operator_source_root "$snapshot_root"');
    expect(committed).toContain('normalize_operator_source_root "$snapshot_root"');
  });

  it('resolves the source root to its physical absolute path', () => {
    const normalizerStart = src.indexOf('normalize_operator_source_root() {');
    const normalizerEnd = src.indexOf('\ncleanup_operator_source_snapshot() {', normalizerStart);
    const normalizer = src.slice(normalizerStart, normalizerEnd);
    const fixture = mkdtempSync(resolve(tmpdir(), 'verifier-source-root-normalization-'));
    const physicalRoot = resolve(fixture, 'physical source');
    const aliasRoot = resolve(fixture, 'source alias');
    mkdirSync(physicalRoot);
    symlinkSync(physicalRoot, aliasRoot);
    try {
      const result = spawnSync('bash', ['-c', [
        'set -euo pipefail',
        normalizer,
        'normalize_operator_source_root "$TEST_ROOT"',
        'printf "%s\\n" "$OPERATOR_SOURCE_ROOT"',
      ].join('\n')], { encoding: 'utf8', env: { ...hermeticSpawnEnv(), TEST_ROOT: aliasRoot } });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(physicalRoot);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
});

describe("EI-25270951515189161 — verifier snapshots avoid active source edits", () => {
  it('qualifies committed Git source before dependencies and refuses the archive-only regression', () => {
    const committed = committedSnapshotSource(operatorSnapshotCallIdx, sourceRefNormalizationTestStub);
    const fixture = mkdtempSync(resolve(tmpdir(), 'verifier-bundle-checkout-contract-'));
    try {
      for (const archiveOnly of [false, true]) {
        const orderFile = resolve(fixture, archiveOnly ? 'archive-order' : 'checkout-order');
        const result = spawnSync('bash', ['-c', [
          'set -euo pipefail',
          'REPO_DIR=/canonical; WORK="$TEST_ROOT"; OPERATOR_SNAPSHOT_PARENT="$TEST_ROOT"',
          'VERIFY_TAURI_SOURCE_REF=commit; VERIFY_TAURI_SOURCE_INPUTS=apps/operator/ui.ts',
          'write_run_marker() { :; }; reserve_verifier_disk() { :; }; log() { :; }',
          // Model the existing exporter/fence contract: a source receipt alone
          // cannot qualify bundle inputs against independently held Git objects.
          'node() {',
          '  printf "%s\\n" "$*" >> "$TEST_ORDER"',
          '  if [[ "$*" == *verifier-measure* ]]; then echo 4096; fi',
          '  if [[ "$*" == *verifier-prepare* ]]; then',
          '    case " $* " in *" --git-checkout "*) ;; *) echo "independently verified Git checkout required" >&2; return 2 ;; esac',
          '  fi',
          '}',
          'cp() { printf \'%s\\n\' \'papercusp_pinned_deps_snapshot_locked() { echo deps >> "$TEST_ORDER"; }\' > "${!#}"; }',
          dependencySnapshotSource,
          archiveOnly ? committed.replace('--git-checkout', '') : committed,
          'snapshot_committed_operator_source',
        ].join('\n')], { encoding: 'utf8', timeout: 10_000,
          env: { ...hermeticSpawnEnv(), TEST_ROOT: fixture, TEST_ORDER: orderFile } });
        const order = readFileSync(orderFile, 'utf8');
        if (archiveOnly) {
          expect(result.status).toBe(1);
          expect(result.stderr).toContain('independently verified Git checkout required');
          expect(order).not.toContain('verifier-verify');
          expect(order).not.toContain('\ndeps\n');
        } else {
          expect(result.status, result.stderr).toBe(0);
          expect(order.indexOf('verifier-verify')).toBeGreaterThan(order.indexOf('verifier-prepare'));
          expect(order.indexOf('\ndeps\n')).toBeGreaterThan(order.indexOf('verifier-verify'));
        }
      }
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.each([false, true])('preserves the invoked source repository through re-exec while keeping the dependency donor separate (distinct=%s)', distinct => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'verifier-source-donor-contract-'));
    const sourceRepo = resolve(fixture, 'tested source');
    const donor = distinct ? resolve(fixture, 'live donor') : sourceRepo;
    const scripts = resolve(sourceRepo, 'scripts');
    const temp = resolve(fixture, 'temporary wrapper');
    const inputsFile = resolve(fixture, 'complete inputs.json');
    mkdirSync(scripts, { recursive: true });
    mkdirSync(donor, { recursive: true });
    mkdirSync(temp);
    writeFileSync(inputsFile, JSON.stringify(['apps/operator/ui.ts', 'path with,comma.ts']));
    const paths = src.slice(src.indexOf('SCRIPT_DIR="'), src.indexOf('DESKTOP_DIR="$REPO_DIR/papercusp-desktop"'));
    const committed = committedSnapshotSource(operatorSnapshotCallIdx, sourceRefNormalizationTestStub);
    const runner = resolve(scripts, 'verify-tauri-headless.sh');
    // Execute the production startup/re-exec and snapshot functions. Substitute
    // only the exporter and dependency copy: a dirty donor must fail if it is
    // accidentally used as the tested source, before allocation or export.
    writeFileSync(runner, [
      '#!/usr/bin/env bash', 'set -euo pipefail',
      src.slice(snapshotGuardIdx, argumentParserIdx), paths,
      'WORK="$TEST_ROOT"; OPERATOR_SNAPSHOT_PARENT="$TEST_ROOT"',
      'VERIFY_TAURI_SOURCE_REF=commit; unset VERIFY_TAURI_SOURCE_INPUTS',
      'VERIFY_TAURI_SOURCE_INPUTS_FILE="$TEST_INPUTS_FILE"',
      'write_run_marker() { :; }; reserve_verifier_disk() { :; }; log() { :; }',
      'node() { printf "%s\\n" "$@" >> "$WORK/order"; if [[ "$*" == *verifier-inputs-check* && "$*" == *"--repo $TEST_DONOR"* && "$TEST_DISTINCT" = 1 ]]; then echo "dirty tested-input mismatch: apps/operator/ui.ts" >&2; return 2; fi; [[ "$*" != *verifier-measure* ]] || echo 4096; }',
      'cp() { printf \'%s\\n\' \'papercusp_pinned_deps_snapshot_locked() { printf "deps:%s\\n" "$1" >> "$WORK/order"; }\' > "${!#}"; }',
      dependencySnapshotSource, committed,
      'snapshot_committed_operator_source',
      'printf "donor:%s\\n" "$REPO_DIR" >> "$WORK/order"',
    ].join('\n'));
    const env: NodeJS.ProcessEnv = {
      ...hermeticSpawnEnv(), TMPDIR: temp, PAPERCUSP_REPO_DIR: donor,
      TEST_ROOT: fixture, TEST_DONOR: donor, TEST_DISTINCT: distinct ? '1' : '0', TEST_INPUTS_FILE: inputsFile,
    };
    delete env.VERIFY_TAURI_SOURCE_SNAPSHOT_PATH;
    delete env.VERIFY_TAURI_ORIGINAL_REPO_DIR;
    delete env.VERIFY_TAURI_SOURCE_REPO_DIR;
    try {
      const result = spawnSync('bash', [runner], { env, encoding: 'utf8', timeout: 10_000 });
      expect(result.status, result.stderr).toBe(0);
      const order = readFileSync(resolve(fixture, 'order'), 'utf8');
      for (const command of ['verifier-inputs-check', 'verifier-measure', 'verifier-prepare']) {
        expect(order).toContain(`${sourceRepo}/scripts/source-preview.mjs\n${command}\n--repo\n${sourceRepo}\n--ref\ncommit\n`);
      }
      expect(order).toContain(`--inputs-file\n${inputsFile}\n`);
      expect(order).toContain('--tauri-inputs\n');
      expect(order).toContain(`deps:${donor}\n`);
      expect(order).toContain(`donor:${donor}\n`);
      expect(readFileSync(inputsFile, 'utf8')).toBe(JSON.stringify(['apps/operator/ui.ts', 'path with,comma.ts']));
      expect(readdirSync(temp)).toEqual([]);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it('resolves symbolic committed refs before writing and checking the source receipt', () => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'verifier-source-ref-normalization-'));
    const commit = '0123456789abcdef0123456789abcdef01234567';
    const gitLog = resolve(fixture, 'git.log');
    try {
      const result = spawnSync('bash', ['-c', [
        'set -euo pipefail',
        'REPO_DIR=/canonical; WORK="$TEST_ROOT"; OPERATOR_SNAPSHOT_PARENT="$TEST_ROOT"',
        'VERIFY_TAURI_SOURCE_REF=HEAD; VERIFY_TAURI_SOURCE_INPUTS=apps/operator/ui.ts',
        'write_run_marker() { :; }; reserve_verifier_disk() { :; }; log() { :; }',
        'node() { printf "%s\\n" "$@" >> "$WORK/order"; [[ "$*" != *verifier-measure* ]] || echo 4096; }',
        'cp() { printf \'%s\\n\' \'papercusp_pinned_deps_snapshot_locked() { echo deps >> "$WORK/order"; }\' > "${!#}"; }',
        dependencySnapshotSource,
        committedSnapshotSource(operatorSnapshotCallIdx, sourceRefNormalizationTestStub),
        'snapshot_committed_operator_source',
        'printf "normalized:%s\\n" "$VERIFY_TAURI_SOURCE_REF" >> "$WORK/order"',
      ].join('\n')], { encoding: 'utf8', timeout: 10_000, env: {
        ...hermeticSpawnEnv(), TEST_ROOT: fixture, TEST_GIT_LOG: gitLog, TEST_RESOLVED_SOURCE_REF: commit,
      } });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(gitLog, 'utf8')).toContain('-C /canonical rev-parse --verify --quiet HEAD^{commit}');
      const order = readFileSync(resolve(fixture, 'order'), 'utf8');
      expect(order).toContain('--ref\n' + commit + '\n');
      expect(order).not.toContain('--ref\nHEAD\n');
      expect(order).toContain('normalized:' + commit + '\n');
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it('passes file-backed inputs intact alongside mandatory tooling, before receipt verification and dependencies', () => {
    const end = operatorSnapshotCallIdx;
    const fixture = mkdtempSync(resolve(tmpdir(), 'verifier-file-input-contract-'));
    const inputsFile = resolve(fixture, 'complete inputs.json');
    writeFileSync(inputsFile, JSON.stringify(['apps/operator/ui.ts', 'path with,comma.ts']));
    try {
      const result = spawnSync('bash', ['-c', [
        'set -euo pipefail',
        'REPO_DIR=/canonical; WORK="$TEST_ROOT"; OPERATOR_SNAPSHOT_PARENT="$TEST_ROOT"',
        'VERIFY_TAURI_SOURCE_REF=commit; unset VERIFY_TAURI_SOURCE_INPUTS',
        'VERIFY_TAURI_SOURCE_INPUTS_FILE="$TEST_INPUTS_FILE"',
        'write_run_marker() { :; }; reserve_verifier_disk() { :; }; log() { :; }',
        'node() { printf "%s\\n" "$@" >> "$WORK/order"; [[ "$*" != *verifier-measure* ]] || echo 4096; }',
        'cp() { printf \'%s\\n\' \'papercusp_pinned_deps_snapshot_locked() { echo deps >> "$WORK/order"; }\' > "${!#}"; }',
        dependencySnapshotSource,
        committedSnapshotSource(end, sourceRefNormalizationTestStub),
        'snapshot_committed_operator_source',
      ].join('\n')], { encoding: 'utf8', env: { ...hermeticSpawnEnv(), TEST_ROOT: fixture, TEST_INPUTS_FILE: inputsFile } });
      expect(result.status, result.stderr).toBe(0);
      const order = readFileSync(resolve(fixture, 'order'), 'utf8');
      expect(order).toContain(`--inputs-file\n${inputsFile}\n`);
      // The mandatory tooling profile is owned by source-preview (TAURI_VERIFIER_INPUTS).
      expect(order).toContain('--tauri-inputs\n');
      expect(order.indexOf('verifier-inputs-check')).toBeLessThan(order.indexOf('verifier-measure'));
      expect(order.indexOf('verifier-verify')).toBeGreaterThan(order.indexOf('verifier-prepare'));
      expect(order.indexOf('\ndeps\n')).toBeGreaterThan(order.indexOf('verifier-verify'));
      expect(readFileSync(inputsFile, 'utf8')).toBe(JSON.stringify(['apps/operator/ui.ts', 'path with,comma.ts']));
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it("keeps committed preparation independent of live census and verifies before donor mutation", () => {
    const end = operatorSnapshotCallIdx;
    const committed = committedSnapshotSource(end, sourceRefNormalizationTestStub);
    const fixture = mkdtempSync(resolve(tmpdir(), 'verifier-committed-contract-'));
    try {
      const result = spawnSync('bash', ['-c', [
        'set -euo pipefail',
        'REPO_DIR=/canonical; WORK="$TEST_ROOT"; OPERATOR_SNAPSHOT_PARENT="$TEST_ROOT"',
        'VERIFY_TAURI_SOURCE_REF=commit; VERIFY_TAURI_SOURCE_INPUTS=apps/operator/ui.ts',
        'write_run_marker() { :; }; reserve_verifier_disk() { :; }; log() { :; }',
        'node() { printf "%s\\n" "$*" >> "$WORK/order"; [[ "$*" != *verifier-measure* ]] || echo 4096; if [[ "$*" == *verifier-verify* ]] && [ "$TEST_TAMPER" = 1 ]; then return 2; fi; }',
        'cp() { printf \'%s\\n\' \'papercusp_pinned_deps_snapshot_locked() { echo "deps:$1:$2" >> "$WORK/order"; }\' > "${!#}"; }',
        dependencySnapshotSource,
        committed,
        'snapshot_committed_operator_source',
        'printf "desktop:%s\\n" "$DESKTOP_DIR" >> "$WORK/order"',
      ].join('\n')], { encoding: 'utf8', env: { ...hermeticSpawnEnv(), TEST_ROOT: fixture, TEST_TAMPER: '0' } });
      expect(result.status, result.stderr).toBe(0);
      const order = readFileSync(resolve(fixture, 'order'), 'utf8');
      expect(order.indexOf('verifier-verify')).toBeGreaterThan(order.indexOf('verifier-prepare'));
      expect(order.indexOf('deps:/canonical:')).toBeGreaterThan(order.indexOf('verifier-verify'));
      expect(order).toMatch(/desktop:.*operator-source\/papercusp-desktop/);
      const refused = spawnSync('bash', ['-c', [
        'set -euo pipefail',
        'REPO_DIR=/canonical; WORK="$TEST_ROOT"; OPERATOR_SNAPSHOT_PARENT="$TEST_ROOT"',
        'VERIFY_TAURI_SOURCE_REF=commit; VERIFY_TAURI_SOURCE_INPUTS=apps/operator/ui.ts',
        'write_run_marker() { :; }; reserve_verifier_disk() { :; }; log() { :; }',
        'node() { [[ "$*" != *verifier-measure* ]] || echo 4096; [[ "$*" != *verifier-verify* ]]; }',
        'cp() { echo mutation-after-refusal >&2; return 99; }',
        dependencySnapshotSource,
        committed, 'snapshot_committed_operator_source',
      ].join('\n')], { encoding: 'utf8', env: { ...hermeticSpawnEnv(), TEST_ROOT: fixture } });
      expect(refused.status).toBe(1);
      expect(refused.stderr).not.toContain('mutation-after-refusal');
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it.each(['admit', 'capacity-refusal', 'unmeasured', 'empty'])('admits measured committed source before creating or exporting it: %s', mode => {
    const end = operatorSnapshotCallIdx;
    const fixture = mkdtempSync(resolve(tmpdir(), 'verifier-source-size-contract-'));
    try {
      const result = spawnSync('bash', ['-c', [
        'set -euo pipefail',
        'REPO_DIR=/canonical; WORK="$TEST_ROOT"; OPERATOR_SNAPSHOT_PARENT="$TEST_ROOT"',
        'VERIFY_TAURI_SOURCE_REF=commit; VERIFY_TAURI_SOURCE_INPUTS=apps/operator/ui.ts',
        'write_run_marker() { :; }; log() { :; }',
        'node() { echo "$*" >> "$WORK/order"; if [[ "$*" == *verifier-measure* ]]; then case "$TEST_MODE" in unmeasured) echo unknown ;; empty) echo 0 ;; *) echo 5242880 ;; esac; fi; }',
        'reserve_verifier_disk() { echo "reserve:$1" >> "$WORK/order"; test "$1" = 5242880; test "$TEST_MODE" != capacity-refusal || return 7; }',
        'cp() { printf \'%s\\n\' \'papercusp_pinned_deps_snapshot_locked() { echo deps >> "$WORK/order"; }\' > "${!#}"; }',
        dependencySnapshotSource,
        committedSnapshotSource(end, sourceRefNormalizationTestStub), 'snapshot_committed_operator_source',
      ].join('\n')], { encoding: 'utf8', env: { ...hermeticSpawnEnv(), TEST_ROOT: fixture, TEST_MODE: mode } });
      const order = readFileSync(resolve(fixture, 'order'), 'utf8');
      if (mode === 'admit') {
        expect(result.status, result.stderr).toBe(0);
        expect(order.indexOf('reserve:5242880')).toBeGreaterThan(order.indexOf('verifier-measure'));
        expect(order.indexOf('verifier-prepare')).toBeGreaterThan(order.indexOf('reserve:5242880'));
      } else {
        expect(result.status).toBe(mode === 'capacity-refusal' ? 7 : 1);
        expect(order).not.toContain('verifier-prepare');
        expect(order).not.toContain('\ndeps\n');
        expect(readdirSync(fixture).some(name => name.startsWith('verify-tauri-headless.'))).toBe(false);
      }
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it('rejects stale tested inputs before measuring or reserving snapshot space', () => {
    const end = operatorSnapshotCallIdx;
    const fixture = mkdtempSync(resolve(tmpdir(), 'verifier-source-input-refusal-'));
    try {
      const result = spawnSync('bash', ['-c', [
        'set -euo pipefail',
        'REPO_DIR=/canonical; WORK="$TEST_ROOT"; OPERATOR_SNAPSHOT_PARENT="$TEST_ROOT"',
        'VERIFY_TAURI_SOURCE_REF=commit; VERIFY_TAURI_SOURCE_INPUTS=apps/operator/ui.ts',
        'write_run_marker() { :; }; log() { :; }',
        'node() { echo "$*" >> "$WORK/order"; [[ "$*" != *verifier-inputs-check* ]]; }',
        'reserve_verifier_disk() { echo "reserve:$1" >> "$WORK/order"; }',
        'cp() { echo mutation-after-refusal >&2; return 99; }',
        committedSnapshotSource(end, sourceRefNormalizationTestStub),
        'status=0; snapshot_committed_operator_source || status=$?',
        'printf "status=%s\\n" "$status" >> "$WORK/order"',
      ].join('\n')], { encoding: 'utf8', env: { ...hermeticSpawnEnv(), TEST_ROOT: fixture } });
      expect(result.status, result.stderr).toBe(0);
      const order = readFileSync(resolve(fixture, 'order'), 'utf8');
      expect(order).toContain('verifier-inputs-check');
      expect(order).toContain('status=1');
      expect(order).not.toContain('verifier-measure');
      expect(order).not.toContain('reserve:');
      expect(order).not.toContain('verifier-prepare');
      expect(readdirSync(fixture).some(name => name.startsWith('verify-tauri-headless.'))).toBe(false);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  function queryLocks(
    response: string,
    failPtool = false,
    trimByDefault = false,
    projectedResponse = "",
  ) {
    const fixture = mkdtempSync(resolve(tmpdir(), "verifier-source-lock-census-"));
    const repo = resolve(fixture, "repo");
    const queryPath = resolve(fixture, "query.json");
    const argsPath = resolve(fixture, "ptool-args.txt");
    mkdirSync(repo, { recursive: true });
    try {
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            "set -uo pipefail",
            "ptool() {",
            '  printf "%s\\n" "$*" > "$TEST_PTOOL_ARGS_PATH"',
            '  cat > "$TEST_PTOOL_QUERY_PATH"',
            '  [ "$TEST_PTOOL_FAIL" != 1 ] || return 7',
            '  if [ "$TEST_PTOOL_PROJECTED_TRUNCATION" = 1 ] && [[ "$*" == *--projection* ]]; then',
            '    printf "%s" "$TEST_PTOOL_PROJECTED_RESPONSE"',
            '    return 0',
            '  fi',
            '  if [ "$TEST_PTOOL_TRIM_DEFAULT" = 1 ] && ! node -e \'const fs = require("node:fs"); const q = JSON.parse(fs.readFileSync(process.env.TEST_PTOOL_QUERY_PATH, "utf8")); process.exit(q.payloadTier === "full" ? 0 : 1)\'; then',
            '    printf \'%s\' \'{"active_locks":[],"_projection":{"truncated":true}}\'',
            '    return 0',
            '  fi',
            '  printf "%s" "$TEST_PTOOL_RESPONSE"',
            "}",
            'log() { printf "%s\\n" "$*" >&2; }',
            lockCensusSource,
            'verify_operator_source_lock_census "fixture"',
          ].join("\n"),
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...hermeticSpawnEnv(),
            REPO_DIR: repo,
            PAPERCUSP_WORKSPACE: "fixture-workspace",
            TEST_PTOOL_RESPONSE: response,
            TEST_PTOOL_FAIL: failPtool ? "1" : "0",
            TEST_PTOOL_TRIM_DEFAULT: trimByDefault ? "1" : "0",
            TEST_PTOOL_PROJECTED_TRUNCATION: projectedResponse ? "1" : "0",
            TEST_PTOOL_PROJECTED_RESPONSE: projectedResponse,
            TEST_PTOOL_QUERY_PATH: queryPath,
            TEST_PTOOL_ARGS_PATH: argsPath,
          },
        },
      );
      return {
        ...result,
        query: existsSync(queryPath) ? JSON.parse(readFileSync(queryPath, "utf8")) : null,
        ptoolArgs: existsSync(argsPath) ? readFileSync(argsPath, "utf8") : "",
        coordinationDomain: repo,
      };
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }

  it("queries a complete lock census for the repo's runtime source roots", () => {
    expect(lockCensusStartIdx).toBeGreaterThan(-1);
    const result = queryLocks(JSON.stringify({ active_locks: [] }));
    expect(result.status, result.stderr).toBe(0);
    expect(result.query.coordination_domain).toBe(result.coordinationDomain);
    expect(result.query.payloadTier).toBe("full");
    expect(result.query.paths).toEqual(
      expect.arrayContaining(["apps/operator", "packages", "libs", "scripts"]),
    );
    expect(result.ptoolArgs).toContain("--workspace=fixture-workspace");
    expect(result.ptoolArgs).toContain("locks:queue");
    expect(result.stderr).toContain("verified no active source-file locks");
  });

  it("refuses an active runtime-source edit and reports its holder", () => {
    const result = queryLocks(JSON.stringify({
      active_locks: [{
        path: "packages/operator-core/lib/dbos/routines-workflow.ts",
        owner: "su-peer",
        intent: "mid-edit regression fixture",
        lock_id: "lock-fixture",
      }],
    }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("active source-file locks");
    expect(result.stderr).toContain("packages/operator-core/lib/dbos/routines-workflow.ts");
    expect(result.stderr).toContain("owner=su-peer");
    expect(result.stderr).toContain("lock_id=lock-fixture");
  });

  it("avoids projection truncation and still refuses a lock beyond the result-door window", () => {
    const active_locks = Array.from({ length: 13 }, (_, i) => ({
      path: `packages/operator-core/lib/fixture-${i}.test.ts`,
      owner: "su-peer",
      lock_id: `lock-${i}`,
    }));
    active_locks.push({
      path: "packages/operator-core/lib/runtime.ts",
      owner: "su-runtime-holder",
      lock_id: "runtime-lock",
    });
    const result = queryLocks(
      JSON.stringify({ active_locks }),
      false,
      true,
      JSON.stringify({
        active_locks: active_locks.slice(0, 12),
        _projection: { truncated: true },
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("active source-file locks");
    expect(result.stderr).toContain("owner=su-runtime-holder");
    expect(result.stderr).not.toContain("incomplete or unrecognized census");
    expect(result.ptoolArgs).not.toContain("--projection");
  });

  it("continues to fail closed if a full-tier census is nevertheless partial", () => {
    const result = queryLocks(JSON.stringify({
      active_locks: [],
      _projection: { truncated: true },
    }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("incomplete or unrecognized census");
  });

  it("ignores a test-only lock outside the host bundle's runtime graph", () => {
    const result = queryLocks(JSON.stringify({
      active_locks: [{
        path: "packages/operator-core/lib/verify-tauri-headless-source-snapshot.test.ts",
        owner: "su-peer",
        intent: "test edit",
        lock_id: "test-lock",
      }],
    }));
    expect(result.status, result.stderr).toBe(0);
  });

  it("fails closed when the live lock census cannot be read", () => {
    const result = queryLocks("{}", true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not read the live verifier source lock census");
  });

  it("checks locks both before and after the shared-tree rsync copy", () => {
    expect(operatorSnapshotSource).toContain('verify_operator_source_lock_census "before copy"');
    const beforeCopy = operatorSnapshotSource.indexOf('verify_operator_source_lock_census "before copy"');
    const rsyncCopy = operatorSnapshotSource.indexOf('rsync -a --delete "${source_filters[@]}"');
    const afterCopy = operatorSnapshotSource.indexOf('verify_operator_source_lock_census "after copy"');
    expect(beforeCopy).toBeGreaterThan(-1);
    expect(rsyncCopy).toBeGreaterThan(beforeCopy);
    expect(afterCopy).toBeGreaterThan(rsyncCopy);
  });
});

describe("EI-25270951515189161 — frozen host bundle import smoke runs before Tauri", () => {
  const smokeStartIdx = src.indexOf("smoke_verifier_operator_host() {");
  const smokeEndIdx = src.indexOf("\nprepare_verifier_spa() {", smokeStartIdx);
  if (smokeStartIdx < 0 || smokeEndIdx < 0) throw new Error('Maintained host smoke function boundary was not found');
  const smokeSource = src.slice(smokeStartIdx, smokeEndIdx);

  function runSmoke(bundleSource: string, timeoutSec: number | string | null = 3, arenaCap?: string,
    configuredBudget?: string, inheritedEnv: NodeJS.ProcessEnv = hermeticSpawnEnv()) {
    const fixture = mkdtempSync(resolve(tmpdir(), "verifier-host-import-smoke-"));
    const bundle = resolve(fixture, "hono-host.mjs");
    writeFileSync(bundle, bundleSource);
    try {
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            "set -uo pipefail",
            'log() { printf "%s\\n" "$*" >&2; }',
            smokeSource,
            timeoutSec === null ? 'smoke_verifier_operator_host' : 'smoke_verifier_operator_host "$TEST_TIMEOUT_SEC"',
          ].join("\n"),
        ],
        {
          encoding: "utf8",
          timeout: 8_000,
          env: {
            ...inheritedEnv,
            // These standalone .mjs fixtures are outside the selected checkout.
            // Test-runner preloads can execute before the smoke's own preload,
            // changing both the failure cause and the timed import budget.
            NODE_OPTIONS: undefined,
            MALLOC_ARENA_MAX: arenaCap,
            HOST_IMPORT_TIMEOUT: undefined,
            VERIFY_TAURI_HOST_IMPORT_TIMEOUT: configuredBudget,
            OPERATOR_HOST_BUNDLE: bundle,
            VH_PHASE_DIR: resolve(fixture, "phase"),
            TEST_TIMEOUT_SEC: String(timeoutSec),
          },
        },
      );
      const evidenceDir = resolve(fixture, "phase/host-import-smoke");
      return {
        ...result,
        smokeEvidence: existsSync(resolve(evidenceDir, "result.json"))
          ? JSON.parse(readFileSync(resolve(evidenceDir, "result.json"), "utf8"))
          : null,
        smokeOutput: existsSync(resolve(evidenceDir, "output.log"))
          ? readFileSync(resolve(evidenceDir, "output.log"), "utf8") : null,
        retainedBundle: existsSync(resolve(evidenceDir, "hono-host.mjs"))
          ? readFileSync(resolve(evidenceDir, "hono-host.mjs"), "utf8") : null,
      };
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }

  it("imports the bundle with the smoke-only argument and accepts its marker", () => {
    const result = runSmoke(
      "if (!process.argv.includes('--papercusp-import-smoke')) throw new Error('missing smoke flag');\n" +
        "console.log('PAPERCUSP_HOST_IMPORT_SMOKE_OK');\n",
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('vh_run_step: command not found');
    expect(result.stderr).toContain("import smoke passed");
    expect(result.smokeEvidence).toMatchObject({ exitCode: 0, outcome: "passed" });
    expect(result.smokeOutput).toContain("PAPERCUSP_HOST_IMPORT_SMOKE_START");
    expect(result.retainedBundle).toBeNull();
  });

  it.each([[undefined, 60], ["90", 90]])("uses the bounded cold-import phase budget (%s)", (configuredBudget, expected) => {
    const result = runSmoke("console.log('PAPERCUSP_HOST_IMPORT_SMOKE_OK');\n", null, undefined, configuredBudget);
    expect(result.status, result.stderr).toBe(0);
    expect(result.smokeEvidence).toMatchObject({ timeoutSec: expected, outcome: "passed" });
  });

  it.each(["0", "301", "infinity"])("refuses an invalid cold-import budget before starting Node (%s)", configuredBudget => {
    const result = runSmoke("console.log('PAPERCUSP_HOST_IMPORT_SMOKE_OK');\n", null, undefined, configuredBudget);
    expect(result.status).toBe(1);
    expect(result.smokeEvidence).toBeNull();
    expect(result.smokeOutput).toBeNull();
  });

  it("accepts a measured delayed import with its own phase budget and still rejects an insufficient budget", () => {
    const delayed = "await new Promise(resolve => setTimeout(resolve, 1500));\nconsole.log('PAPERCUSP_HOST_IMPORT_SMOKE_OK');\n";
    const sufficient = runSmoke(delayed, 3);
    expect(sufficient.status, sufficient.stderr).toBe(0);
    expect(sufficient.smokeEvidence.elapsedMs).toBeGreaterThanOrEqual(1500);
    const insufficient = runSmoke(delayed, 1);
    expect(insufficient.status).toBe(1);
    expect(insufficient.smokeEvidence).toMatchObject({ exitCode: 124, outcome: "process-failed" });
  });

  it('isolates the standalone smoke fixture from a failing outer-runner preload', () => {
    const result = runSmoke("console.log('PAPERCUSP_HOST_IMPORT_SMOKE_OK');\n", 3, undefined, undefined, {
      ...hermeticSpawnEnv(),
      NODE_OPTIONS: '--import=data:text/javascript,throw%20new%20Error(%22outer%20runner%20preload%20leaked%22)',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.smokeEvidence).toMatchObject({ exitCode: 0, outcome: 'passed' });
    expect(result.smokeOutput).not.toContain('outer runner preload leaked');
  });

  it.each([undefined, "4"])("sets the arena cap before import and preserves a configured cap (%s)", arenaCap => {
    const result = runSmoke(
      `if (process.env.MALLOC_ARENA_MAX !== ${JSON.stringify(arenaCap ?? "2")}) throw new Error('launcher would re-exec');\n` +
        "console.log('PAPERCUSP_HOST_IMPORT_SMOKE_OK');\n",
      3,
      arenaCap,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.smokeEvidence).toMatchObject({ exitCode: 0, outcome: "passed" });
    expect(result.smokeOutput).not.toContain("launcher would re-exec");
  });

  it("surfaces a module-init ReferenceError before the Tauri launch", () => {
    const result = runSmoke("throw new ReferenceError('pinModuleState is not defined');\n");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("failed before Tauri startup");
    expect(result.stderr).toContain("pinModuleState is not defined");
    expect(result.smokeEvidence).toMatchObject({ exitCode: 1, outcome: "process-failed" });
    expect(result.retainedBundle).toContain("pinModuleState is not defined");
  });

  it("records entry into Node before an entry-bundle parse error", () => {
    const result = runSmoke("const = invalid;\n");
    expect(result.status).toBe(1);
    expect(result.smokeOutput).toContain("PAPERCUSP_HOST_IMPORT_SMOKE_START\n");
    expect(result.smokeOutput).toContain("SyntaxError");
    expect(result.retainedBundle).toBe("const = invalid;\n");
  });

  it("terminates an import smoke that exceeds its deadline", () => {
    const result = runSmoke("setInterval(() => {}, 1000);\n", 1);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("failed before Tauri startup (exit 124)");
    expect(result.smokeOutput).toContain("PAPERCUSP_HOST_IMPORT_SMOKE_START");
    expect(result.smokeEvidence).toMatchObject({ exitCode: 124, timeoutSec: 1, outcome: "process-failed" });
    expect(result.smokeEvidence.elapsedMs).toBeGreaterThanOrEqual(900);
    expect(result.smokeEvidence.bundleSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.retainedBundle).toBe("setInterval(() => {}, 1000);\n");
  });

  it("retains a zero-exit bundle that did not reach the success marker", () => {
    const result = runSmoke("console.log('early exit');\n");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("returned without its success marker");
    expect(result.smokeEvidence).toMatchObject({ exitCode: 0, outcome: "missing-marker" });
    expect(result.retainedBundle).toBe("console.log('early exit');\n");
  });

  it("places the smoke-only exit after module imports and before host side effects", () => {
    const smokeGuard = hostEntrySrc.indexOf(
      "if (process.argv.includes('--papercusp-import-smoke')) {",
    );
    const finalImport = hostEntrySrc.indexOf(
      "import { notifySystemdReady } from '@papercusp/operator-core/lib/systemd-readiness';",
    );
    const firstHostSideEffect = hostEntrySrc.indexOf("installStdioPeerGuard();");
    expect(finalImport).toBeGreaterThan(-1);
    expect(smokeGuard).toBeGreaterThan(finalImport);
    expect(firstHostSideEffect).toBeGreaterThan(smokeGuard);
    expect(hostEntrySrc).toContain("PAPERCUSP_HOST_IMPORT_SMOKE_OK");
  });

  it("runs the import smoke after the bundle build and before configuring Tauri", () => {
    const bundleCall = src.indexOf("build_verifier_operator_host || {");
    const smokeCall = src.indexOf("smoke_verifier_operator_host || {");
    const tauriConfig = src.indexOf("TAURI_CONFIG=");
    expect(bundleCall).toBeGreaterThan(-1);
    expect(smokeCall).toBeGreaterThan(bundleCall);
    expect(tauriConfig).toBeGreaterThan(smokeCall);
    expect(smokeSource).toContain('timeout --signal=TERM --kill-after=1s');
    expect(smokeSource).toContain('"$OPERATOR_HOST_BUNDLE" --papercusp-import-smoke');
  });
});

describe("EI-21590235587564636 — verifier source is immutable for the run", () => {
  it.each([true, false])("checks the original-repository SPA helper before allocating resources (present=%s)", (present) => {
    const fixture = mkdtempSync(resolve(tmpdir(), "verifier-helper-origin-"));
    try {
      const repo = resolve(fixture, "repo");
      const scripts = resolve(repo, "scripts");
      const temp = resolve(fixture, "temporary-launch-root");
      mkdirSync(resolve(scripts, "lib"), { recursive: true });
      mkdirSync(temp);
      writeFileSync(resolve(scripts, "lib/spa-require-built.sh"),
        readFileSync(resolve(SCRIPT, "../lib/spa-require-built.sh")));
      if (!present) rmSync(resolve(scripts, "lib/spa-require-built.sh"));
      // Execute the production snapshot/re-exec, path resolution and helper
      // loader without allocating a display or building an operator fixture.
      const paths = src.slice(src.indexOf('SCRIPT_DIR="'),
        src.indexOf('DESKTOP_DIR="$REPO_DIR/papercusp-desktop"'));
      const loaderMatch = src.match(
        /^ {0,2}if ! \. "[^\n]*\/lib\/spa-require-built\.sh"; then[\s\S]*?^ {0,2}fi/m,
      );
      expect(loaderMatch, "production helper loader must remain identifiable").not.toBeNull();
      expect(src.indexOf(loaderMatch![0])).toBeLessThan(workAllocationIdx);
      const runner = resolve(scripts, "verify-tauri-headless.sh");
      writeFileSync(runner, [
        '#!/usr/bin/env bash', 'set -euo pipefail',
        src.slice(snapshotGuardIdx, argumentParserIdx), paths,
        'log() { printf "%s\\n" "$*" >&2; }', 'WORK=""',
        loaderMatch![0],
        'declare -F spa_require_built_gate >/dev/null',
        'printf "HELPER_LOADED_FROM_ORIGINAL_REPO\\n"',
      ].join('\n'));
      const env: NodeJS.ProcessEnv = { ...hermeticSpawnEnv(), TMPDIR: temp };
      delete env.PAPERCUSP_REPO_DIR;
      delete env.VERIFY_TAURI_SOURCE_SNAPSHOT_PATH;
      delete env.VERIFY_TAURI_ORIGINAL_REPO_DIR;
      const result = spawnSync('bash', [runner], { env, encoding: 'utf8', timeout: 10_000 });
      expect(result.status, result.stderr).toBe(present ? 0 : 1);
      if (present) expect(result.stdout.trim()).toBe('HELPER_LOADED_FROM_ORIGINAL_REPO');
      else {
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain(`FATAL: cannot load ${scripts}/lib/spa-require-built.sh`);
      }
      expect(existsSync(resolve(temp, "lib/spa-require-built.sh"))).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("captures and syntax-checks the source before parsing arguments or allocating resources", () => {
    expect(snapshotGuardIdx).toBeGreaterThan(-1);
    expect(argumentParserIdx).toBeGreaterThan(snapshotGuardIdx);
    expect(src).toContain(
      'cp -- "$VERIFY_TAURI_SOURCE_PATH" "$VERIFY_TAURI_SOURCE_SNAPSHOT_PATH"',
    );
    expect(src).toContain('bash -n -- "$VERIFY_TAURI_SOURCE_SNAPSHOT_PATH"');
    expect(installPreflightIdx).toBeGreaterThan(snapshotGuardIdx);
    expect(workAllocationIdx).toBeGreaterThan(snapshotGuardIdx);
  });

  it("re-execs the frozen copy before the mutable checkout can reach the long-lived path", () => {
    expect(sourceReexecIdx).toBeGreaterThan(snapshotGuardIdx);
    expect(sourceReexecIdx).toBeLessThan(argumentParserIdx);
    expect(sourceReexecIdx).toBeLessThan(assertionExecIdx);
    expect(src).toContain(
      "export VERIFY_TAURI_SOURCE_SNAPSHOT_PATH VERIFY_TAURI_ORIGINAL_REPO_DIR",
    );
    // A temp snapshot changes BASH_SOURCE[0]; preserve the original repo root
    // so the re-exec still loads the intended desktop sidecar and dependencies.
    expect(src).toContain(
      'VERIFY_TAURI_ORIGINAL_REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)',
    );
  });

  it("cleans the source snapshot on both normal teardown and boot-only handoff", () => {
    expect(src).toContain("cleanup_verifier_source_snapshot");
    const teardownIdx = src.indexOf("teardown() {");
    expect(
      src.indexOf("cleanup_verifier_source_snapshot", teardownIdx),
    ).toBeGreaterThan(teardownIdx);
    const bootOnlyExitIdx = src.indexOf(
      "cleanup_verifier_source_snapshot\n  exit 0",
      argumentParserIdx,
    );
    expect(bootOnlyExitIdx).toBeGreaterThan(argumentParserIdx);
  });
});

describe("EI-22586651291409125 — derived indexes stay out of the immutable operator snapshot", () => {
  it("excludes and defensively removes .gitnexus before the isolated sidecar boots", () => {
    expect(operatorSnapshotIdx).toBeGreaterThan(-1);
    expect(operatorSnapshotCallIdx).toBeGreaterThan(operatorSnapshotIdx);
    expect(operatorSnapshotSource).toContain("--exclude='.gitnexus'");
    expect(operatorSnapshotSource).toContain('"$snapshot_root/.gitnexus"');
  });
});

describe("EI-22587788892654404 — a repo-local temp root cannot enter its own snapshot", () => {
  it("excludes and defensively removes local Papercusp state before the isolated sidecar boots", () => {
    expect(operatorSnapshotSource).toContain("--exclude='.papercusp'");
    expect(operatorSnapshotSource).toContain('"$snapshot_root/.papercusp"');
  });
});

describe("EI-22616267024724225 — frozen verifier hosts exclude the tsx runtime loader", () => {
  const bundleFunctionIdx = src.indexOf("build_verifier_operator_host() {");
  const bundleCallIdx = src.indexOf(
    "verifier_run_step verifier-host-bundle build_verifier_operator_host",
  );
  const launchEnvIdx = src.indexOf('OPERATOR_SOURCE_ENV_LINE="');

  it("builds the maintained host bundle only after the source/dependency snapshot is frozen", () => {
    expect(bundleFunctionIdx).toBeGreaterThan(operatorSnapshotCallIdx);
    expect(bundleCallIdx).toBeGreaterThan(bundleFunctionIdx);
    expect(operatorSnapshotSource).toContain(
      'snapshot_verifier_pinned_deps "$snapshot_root"',
    );
    expect(dependencySnapshotSource).toContain('papercusp_pinned_deps_snapshot_locked "$REPO_DIR" "$snapshot_root"');
    expect(src.slice(bundleFunctionIdx, bundleCallIdx)).toContain(
      "apps/operator/bin/bundle-host.sh",
    );
    expect(src.slice(bundleFunctionIdx, bundleCallIdx)).toContain(
      'bin/hono-host.ts "$OPERATOR_HOST_BUNDLE"',
    );
    expect(src.slice(bundleFunctionIdx, bundleCallIdx)).toContain(
      '[ -s "$OPERATOR_HOST_BUNDLE" ]',
    );
    expect(src.slice(bundleFunctionIdx, bundleCallIdx)).toContain(
      'bash "$bundle_script" e2e/_fake-llm-fixture-child.ts "$fixture_bundle"',
    );
    expect(src.slice(bundleFunctionIdx, bundleCallIdx)).toContain(
      '[ -s "$fixture_bundle" ]',
    );
    expect(readFileSync(resolve(__dirname, '../../../scripts/source-preview.mjs'), 'utf8'))
      .toContain("'apps/operator/e2e/_fake-llm-fixture-child.ts'");
  });

  it("hands the private plain-node entry to the existing dev-operator launcher", () => {
    expect(launchEnvIdx).toBeGreaterThan(bundleCallIdx);
    expect(src.slice(launchEnvIdx, launchEnvIdx + 500)).toContain(
      'PAPERCUSP_DEV_HOST_ENTRY=\\"$OPERATOR_HOST_BUNDLE\\"',
    );
    expect(src).toContain('OPERATOR_HOST_BUNDLE=""');
    expect(
      src.slice(
        src.indexOf("cleanup_operator_source_snapshot() {"),
        operatorSnapshotIdx,
      ),
    ).toContain('OPERATOR_HOST_BUNDLE=""');
  });
});

describe("EI-22590231221058313 — workspace runtime exports survive the snapshot", () => {
  function requireSnapshot(output: "dist" | "build", blanketExclude = false) {
    const fixture = mkdtempSync(resolve(tmpdir(), "verifier-runtime-export-"));
    const donor = resolve(fixture, "donor");
    const copy = resolve(fixture, "copy");
    try {
      const runtime = resolve(donor, "libs/runtime");
      mkdirSync(resolve(runtime, output), { recursive: true });
      writeFileSync(
        resolve(runtime, "package.json"),
        JSON.stringify({
          name: "@fixture/runtime",
          exports: { require: `./${output}/index.js` },
        }),
      );
      writeFileSync(
        resolve(runtime, output, "index.js"),
        "module.exports = 42;\n",
      );
      const excluded = ["dist", "build", "apps/operator-vite/dist"];
      for (const path of excluded) {
        mkdirSync(resolve(donor, path), { recursive: true });
        writeFileSync(resolve(donor, path, "artifact.js"), "unrelated output");
      }
      mkdirSync(copy);
      const filters = [
        ...operatorSnapshotSource.matchAll(/--exclude='([^']+)'/g),
      ].map((match) => `--exclude=${match[1]}`);
      expect(filters.length).toBeGreaterThan(0);
      const snapshot = spawnSync(
        "rsync",
        [
          "-a",
          ...filters,
          ...(blanketExclude ? [`--exclude=${output}`] : []),
          `${donor}/`,
          `${copy}/`,
        ],
        { encoding: "utf8" },
      );
      expect(snapshot.status, snapshot.stderr).toBe(0);
      // The pinned dependency helper preserves relative workspace symlinks.
      mkdirSync(resolve(copy, "node_modules/@fixture"), { recursive: true });
      symlinkSync(
        "../../libs/runtime",
        resolve(copy, "node_modules/@fixture/runtime"),
      );
      const result = spawnSync(
        process.execPath,
        ["-e", "console.log(require('@fixture/runtime'))"],
        {
          cwd: copy,
          encoding: "utf8",
        },
      );
      return {
        ...result,
        excluded: excluded.map((path) => existsSync(resolve(copy, path))),
      };
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }

  it.each(["dist", "build"] as const)(
    "resolves a workspace package's %s entrypoint from the copy",
    (output) => {
      const result = requireSnapshot(output);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("42");
      expect(result.excluded).toEqual([false, false, false]);
    },
  );

  it("detects the original blanket-exclusion failure", () => {
    const result = requireSnapshot("dist", true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MODULE_NOT_FOUND");
  });
});

describe("dependency snapshot root follows the selected maintained mode", () => {
  const chooserStart = src.indexOf("select_verifier_snapshot_root() {");
  const chooserEnd = src.indexOf(
    '\nverifier_run_step verifier-snapshot-root ',
    chooserStart,
  );

  it.each([false, true])('qualifies a real Git checkout on a distinct temporary device (separate donor=%s)', separateDonor => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'verifier-real-checkout-root-'));
    const sourceRepo = resolve(fixture, 'source');
    const donor = separateDonor ? resolve(fixture, 'donor') : sourceRepo;
    const preferred = resolve(fixture, 'preferred');
    mkdirSync(sourceRepo); mkdirSync(donor, { recursive: true }); mkdirSync(preferred);
    writeFileSync(resolve(sourceRepo, '.gitignore'), '.papercusp/\n');
    writeFileSync(resolve(sourceRepo, 'source.txt'), 'committed source\n');
    const git = (args: string[]) => {
      const result = spawnSync('git', ['-C', sourceRepo, ...args], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    try {
      git(['init', '-q']); git(['add', '.gitignore', 'source.txt']);
      git(['-c', 'user.name=Verifier fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
      const ref = git(['rev-parse', 'HEAD']);
      const committed = committedSnapshotSource();
      // Use the real guarded checkout API at the exporter boundary. Only source
      // measurement and dependency preparation are replaced for this tiny repo.
      const cloneProgram = 'const { createScratchClone } = await import(process.env.TEST_CLONE_MODULE); await createScratchClone({ source: process.env.TEST_SOURCE, ref: process.env.TEST_REF, destination: process.argv[1] });';
      const result = spawnSync('bash', ['-c', [
        'set -euo pipefail; REPO_DIR="$TEST_DONOR"; WORK="$TEST_ROOT"',
        'VERIFY_TAURI_SOURCE_REPO_DIR="$TEST_SOURCE"; VERIFY_TAURI_SOURCE_REF="$TEST_REF"',
        'VERIFY_TAURI_SOURCE_INPUTS=source.txt',
        'stat() { if [ "$4" = / ]; then echo 3; elif [ "$4" = "$TMPDIR" ]; then echo 2; else echo 1; fi; }',
        src.slice(chooserStart, chooserEnd),
        'OPERATOR_SNAPSHOT_PARENT="$(select_verifier_snapshot_root)"',
        'write_run_marker() { :; }; reserve_verifier_disk() { :; }; log() { :; }',
        'snapshot_verifier_pinned_deps() { :; }',
        'node() { shift; case "$1" in',
        '  verifier-measure) echo 4096 ;;',
        '  verifier-prepare) while [ "$#" -gt 0 ]; do if [ "$1" = --out ]; then shift; dest="$1"; fi; shift; done;',
        '    "$TEST_NODE" --experimental-strip-types --input-type=module -e "$TEST_CLONE_PROGRAM" "$dest" ;;',
        '  *) : ;; esac; }',
        committed,
        'snapshot_committed_operator_source',
        'git -C "$OPERATOR_SOURCE_ROOT" rev-parse HEAD',
        'cat "$OPERATOR_SOURCE_ROOT/source.txt"',
        'printf "bulk:%s\\n" "$TMPDIR"',
      ].join('\n')], { encoding: 'utf8', timeout: 15_000, env: {
        ...hermeticSpawnEnv(), TMPDIR: preferred, TEST_SOURCE: sourceRepo, TEST_DONOR: donor,
        TEST_ROOT: fixture, TEST_REF: ref, TEST_NODE: process.execPath,
        VERIFY_TAURI_DEPENDENCY_SNAPSHOT_MODE: 'hardlink',
        TEST_CLONE_PROGRAM: cloneProgram,
        TEST_CLONE_MODULE: resolve(__dirname, '../../../packages/operator-core/lib/scratch-git-clone.ts'),
      } });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(ref);
      expect(result.stdout).toContain('committed source\n');
      expect(result.stdout).toContain(`bulk:${preferred}\n`);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  function chooseRoot(crossDevice: boolean, fallbackCrossDevice = false, mode = "hardlink") {
    const fixture = mkdtempSync(resolve(tmpdir(), "verifier-work-root-"));
    const donor = resolve(fixture, "donor");
    const preferred = resolve(fixture, "preferred");
    mkdirSync(donor);
    mkdirSync(preferred);
    try {
      expect(chooserStart).toBeGreaterThan(-1);
      expect(chooserEnd).toBeGreaterThan(chooserStart);
      // Exercise the actual shell chooser with deterministic mount identities.
      // No snapshot/build process is launched, and no real mount is required.
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            "stat() {",
            '  if [ "$4" = / ]; then printf "3\\n";',
            '  elif [ "$4" = "$REPO_DIR" ]; then printf "1\\n";',
            '  elif [ "$4" = "$TMPDIR" ]; then printf "%s\\n" "$TEST_PREFERRED_DEVICE";',
            '  else printf "%s\\n" "$TEST_FALLBACK_DEVICE"; fi',
            "}",
            src.slice(chooserStart, chooserEnd),
            "select_verifier_snapshot_root",
          ].join("\n"),
        ],
        {
          encoding: "utf8",
          env: {
            ...hermeticSpawnEnv(),
            REPO_DIR: donor,
            TMPDIR: preferred,
            VERIFY_TAURI_DEPENDENCY_SNAPSHOT_MODE: mode,
            TEST_PREFERRED_DEVICE: crossDevice ? "2" : "1",
            TEST_FALLBACK_DEVICE: fallbackCrossDevice ? "2" : "1",
          },
        },
      );
      return { ...result, donor, preferred };
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }

  it("retains a requested temporary root on the donor filesystem", () => {
    const result = chooseRoot(false);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(result.preferred);
  });

  it("uses excluded repository-local scratch when /tmp is on another filesystem", () => {
    const result = chooseRoot(true);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(resolve(result.donor, ".papercusp/scratch"));
  });

  it("refuses a fallback that is also mounted on a different filesystem", () => {
    const result = chooseRoot(true, true);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "no verifier snapshot root on the dependency donor filesystem",
    );
  });

  it("permits a cross-device root only for an explicit independent copy", () => {
    const result = chooseRoot(true, true, "copy");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(result.preferred);
  });

  it("refuses an unsupported mode before allocating a fallback", () => {
    const result = chooseRoot(true, false, "reflink");
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("must be hardlink or copy");
  });

  it("keeps bulk payloads on TMPDIR and gives both roots the same cleanup and owner", () => {
    expect(src).toContain(
      'WORK="$(mktemp -d "${TMPDIR:-/tmp}/verify-tauri-headless.XXXXXX")"',
    );
    expect(operatorSnapshotSource).toContain(
      'snapshot_root="$OPERATOR_SOURCE_WORK/operator-source"',
    );
    expect(src).toContain(
      'cp -- "$WORK/.papercusp-run" "$OPERATOR_SOURCE_WORK/.papercusp-run"',
    );
    expect(src).toContain(
      'snapshot_operator_source || { snapshot_rc=$?; cleanup_operator_source_snapshot; exit "$snapshot_rc"; }',
    );
    expect(src).toContain('if [ -n "${OPERATOR_SOURCE_WORK:-}" ]; then');
    expect(src).toContain('reap_frozen_source_survivors "$frozen_source_root" "$TAURI_LAUNCH_PROVENANCE"');
    expect(src).toContain('rm -rf -- "$OPERATOR_SOURCE_WORK"');
  });
});

describe("EI-22589054433344154 — aggregate disk admission precedes bulk allocation", () => {
  const reservationStart = src.indexOf("reserve_verifier_disk() {");
  const releaseStart = src.indexOf("release_verifier_disk_reservations() {");
  const releaseEnd = src.indexOf(
    "cleanup_operator_source_snapshot() {",
    releaseStart,
  );

  function reserve(
    sameMount: boolean,
    freeSource: number,
    freeBulk: number,
    isolated = true,
    mode = "hardlink",
    badFootprint = false,
  ) {
    const fixture = mkdtempSync(resolve(tmpdir(), "verifier-disk-admission-"));
    try {
      const desktop = resolve(fixture, "desktop");
      mkdirSync(resolve(desktop, "bin/lib"), { recursive: true });
      mkdirSync(resolve(fixture, "source"));
      mkdirSync(resolve(fixture, "bulk"));
      // Sparse donors exercise the real apparent-size measurement without
      // allocating GiBs. Include a nested tree that source filtering omits.
      for (const [rel, bytes] of [["node_modules", 2 * 1024 ** 3], ["papercusp-desktop/node_modules", 1024 ** 3]] as const) {
        mkdirSync(resolve(fixture, rel), { recursive: true });
        const file = resolve(fixture, rel, "payload");
        writeFileSync(file, "");
        // Exceed the whole-GiB boundary explicitly: tmpfs directory metadata
        // can have zero apparent size, unlike disk-backed directory entries.
        truncateSync(file, bytes + 8192);
      }
      writeFileSync(resolve(desktop, "bin/lib/pinned-deps.sh"),
        readFileSync(resolve(__dirname, "../../../papercusp-desktop/bin/lib/pinned-deps.sh"), "utf8"));
      // WI-41095: pinned-deps.sh sources dependency-generation.sh relative to its
      // own path (desktop/bin/lib/../../../apps/...). Give the copied helper the
      // real release dir at that layout so its .mjs siblings resolve too.
      mkdirSync(resolve(fixture, "apps/operator/bin"), { recursive: true });
      symlinkSync(resolve(__dirname, "../bin/release"), resolve(fixture, "apps/operator/bin/release"));
      // Exercise the real shared reservation writer with deterministic device
      // measurements. Each test has a private ledger and reserves no real disk.
      writeFileSync(
        resolve(desktop, "bin/lib/disk-preflight.sh"),
        [
          `. ${JSON.stringify(resolve(__dirname, "../../../papercusp-desktop/bin/lib/disk-preflight.sh"))}`,
          'papercusp_mount_key() { if [ "$TEST_SAME_MOUNT" = 1 ] || [ "$1" = "$OPERATOR_SNAPSHOT_PARENT" ]; then printf source; else printf bulk; fi; }',
          'papercusp_free_gb() { if [ "$TEST_SAME_MOUNT" = 1 ] || [ "$1" = "$OPERATOR_SNAPSHOT_PARENT" ]; then printf "%s" "$TEST_FREE_SOURCE"; else printf "%s" "$TEST_FREE_BULK"; fi; }',
        ].join("\n"),
      );
      return spawnSync(
        "bash",
        [
          "-c",
          [
            "VERIFIER_DISK_RESERVATIONS=()",
            ...(badFootprint ? ['du() { echo unknown; }'] : []),
            spaCleanupSource,
            src.slice(releaseStart, releaseEnd),
            src.slice(reservationStart, operatorSnapshotIdx),
            "reserve_verifier_disk 1073741824",
            "status=$?",
            'printf "status=%s claims=%s\\n" "$status" "${#VERIFIER_DISK_RESERVATIONS[@]}"',
            'for f in "${VERIFIER_DISK_RESERVATIONS[@]}"; do sed -n "/^gb=/p" "$f"; done',
            "release_verifier_disk_reservations",
            'find "$PAPERCUSP_DISK_RESERVATION_DIR" -name "*.res" -print',
            'exit "$status"',
          ].join("\n"),
        ],
        {
          encoding: "utf8",
          env: {
            ...hermeticSpawnEnv(),
            DESKTOP_DIR: desktop,
            REPO_DIR: fixture,
            OPERATOR_SNAPSHOT_PARENT: resolve(fixture, "source"),
            WORK: resolve(fixture, "bulk"),
            PAPERCUSP_DISK_RESERVATION_DIR: resolve(fixture, "ledger"),
            VERIFY_TAURI_ISOLATED_DB: isolated ? "1" : "0",
            VERIFY_TAURI_DEPENDENCY_SNAPSHOT_MODE: mode,
            TEST_SAME_MOUNT: sameMount ? "1" : "0",
            TEST_FREE_SOURCE: String(freeSource),
            TEST_FREE_BULK: String(freeBulk),
          },
        },
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }

  it("refuses aggregate demand even when each individual payload would fit", () => {
    const result = reserve(true, 10, 10);
    expect(result.status).toBe(28);
    expect(result.stdout).toBe("status=28 claims=0\n");
    expect(result.stderr).toContain("need ~11GB");
  });

  it("reserves separate source and bulk demands and releases both", () => {
    const result = reserve(false, 3, 10);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("status=0 claims=2\ngb=2\ngb=9\n");
  });

  it("rolls back the source reservation when bulk admission fails", () => {
    const result = reserve(false, 3, 8);
    expect(result.status).toBe(28);
    expect(result.stdout).toBe("status=28 claims=0\n");
  });

  it("omits the database budget for a read-only shared-database run", () => {
    const result = reserve(true, 3, 3, false);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("status=0 claims=1\ngb=3\n");
  });

  it("reserves the complete independent dependency footprint alongside bulk demand", () => {
    const result = reserve(true, 20, 20, true, "copy");
    expect(result.status, result.stderr).toBe(0);
    // 1 GiB source + >3 GiB apparent dependency bytes + metadata = 6;
    // the isolated DB/profile consumes another 9 GiB on this same mount.
    expect(result.stdout).toBe("status=0 claims=1\ngb=15\n");
  });

  it("refuses capacity that pays for source metadata but cannot pay for the copied dependencies", () => {
    const result = reserve(true, 11, 11, true, "copy");
    expect(result.status).toBe(28);
    expect(result.stdout).toBe("status=28 claims=0\n");
  });

  it("refuses an unmeasured copy footprint without publishing a reservation", () => {
    const result = reserve(true, 20, 20, true, "copy", true);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("status=1 claims=0\n");
    expect(result.stderr).toContain("dependency footprint is unmeasured");
  });

  it("estimates with the copy filters and admits before rsync can allocate bytes", () => {
    const snapshotCommands = operatorSnapshotSource.replace(/\\\n\s*/g, "");
    expect(
      snapshotCommands.indexOf('reserve_verifier_disk "$source_bytes"'),
    ).toBeLessThan(
      snapshotCommands.indexOf(
        'rsync -a --delete "${source_filters[@]}"',
      ),
    );
    expect(snapshotCommands).toContain(
      'rsync -an --stats "${source_filters[@]}"',
    );
    expect(src.slice(src.indexOf('BOOT_ONLY_ENV="$WORK/env.sh"'))).toContain(
      "release_verifier_disk_reservations",
    );
  });
});

describe("independent copy memory admission precedes native preparation", () => {
  const start = src.indexOf('preflight_verifier_copy_memory() {');
  const end = src.indexOf('\n# EI-25558788631579977:', start);

  it.each([null, 0, 4096])('checks the selected copy ceiling before allocating native capacity (%s)', limit => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const fixture = mkdtempSync(resolve(tmpdir(), 'verifier-copy-memory-'));
    mkdirSync(resolve(fixture, 'scripts/lib'), { recursive: true });
    writeFileSync(resolve(fixture, 'scripts/lib/task-cgroup-limits.mjs'),
      `export function readTaskCgroupMemoryMaxMb() { return ${limit}; }`);
    try {
      const result = spawnSync('bash', ['-c', [
        'verifier_run_step() { shift; "$@"; }',
        src.slice(start, end),
        'echo native-capacity-started',
      ].join('\n')], { encoding: 'utf8', timeout: 10_000, env: {
        ...hermeticSpawnEnv(), REPO_DIR: fixture, VERIFY_TAURI_DEPENDENCY_SNAPSHOT_MODE: 'copy',
      } });
      expect(result.status, result.stderr).toBe(limit ? 0 : 2);
      expect(result.stdout.includes('native-capacity-started')).toBe(Boolean(limit));
      expect(result.stderr).toContain(limit ? 'VERIFY_TAURI_COPY_MEMORY_MAX_MB=4096' : 'VERIFY_TAURI_COPY_MEMORY_UNBOUNDED');
      expect(end).toBeLessThan(src.indexOf('preflight_native_cargo() {'));
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });

  it('retains the hardlink route without requiring a copy ceiling', () => {
    const result = spawnSync('bash', ['-c', [
      'verifier_run_step() { shift; "$@"; }', src.slice(start, end),
    ].join('\n')], { encoding: 'utf8', timeout: 10_000, env: {
      ...hermeticSpawnEnv(), REPO_DIR: '/unused', VERIFY_TAURI_DEPENDENCY_SNAPSHOT_MODE: 'hardlink',
    } });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
  });
});

describe("native copy callers preserve frozen helpers and bounded admission", () => {
  function snapshot(mode: string, bounded = true) {
    const fixture = mkdtempSync(resolve(tmpdir(), "verifier-copy-helper-"));
    const frozen = resolve(fixture, "frozen");
    const helper = resolve(frozen, "papercusp-desktop/bin/lib/pinned-deps.sh");
    mkdirSync(resolve(frozen, "scripts/lib"), { recursive: true });
    mkdirSync(resolve(frozen, "papercusp-desktop/bin/lib"), { recursive: true });
    writeFileSync(resolve(frozen, "scripts/lib/task-cgroup-limits.mjs"),
      `export function readTaskCgroupMemoryMaxMb() { return ${bounded ? 4096 : "null"}; }`);
    writeFileSync(resolve(frozen, "scripts/pc-heavy.sh"),
      'echo admission >> "$WORK/order"\nshift\n"$@"');
    writeFileSync(helper, [
      'echo "helper:${BASH_SOURCE[0]}" >> "$WORK/order"',
      'papercusp_pinned_deps_snapshot_locked() { printf "locked:%s:%s:%s\\n" "$1" "$2" "$3" >> "$WORK/order"; }',
      'if [ "${BASH_SOURCE[0]}" = "$0" ]; then shift; papercusp_pinned_deps_snapshot_locked "$@"; fi',
    ].join("\n"));
    try {
      const before = readFileSync(helper, "utf8");
      const result = spawnSync("bash", ["-c", [
        "set -euo pipefail", dependencySnapshotSource,
        'snapshot_verifier_pinned_deps "$TEST_FROZEN" "$TEST_HELPER"',
      ].join("\n")], { encoding: "utf8", timeout: 10_000, env: {
        ...hermeticSpawnEnv(), WORK: fixture, REPO_DIR: "/canonical-donor",
        TEST_FROZEN: frozen, TEST_HELPER: helper,
        VERIFY_TAURI_DEPENDENCY_SNAPSHOT_MODE: mode,
      } });
      const order = existsSync(resolve(fixture, "order")) ? readFileSync(resolve(fixture, "order"), "utf8") : "";
      expect(readFileSync(helper, "utf8")).toBe(before);
      return { ...result, order, helper, frozen };
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }

  it("runs the frozen copy helper in its original layout under heavy admission and the donor mutex", () => {
    const result = snapshot("copy");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("VERIFY_TAURI_COPY_MEMORY_MAX_MB=4096");
    expect(result.order).toBe(`admission\nhelper:${result.helper}\nlocked:/canonical-donor:${result.frozen}:copy\n`);
  });

  it("refuses an unbounded copy before admission or any helper execution", () => {
    const result = snapshot("copy", false);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("VERIFY_TAURI_COPY_MEMORY_UNBOUNDED");
    expect(result.order).toBe("");
  });

  it("keeps the default hardlink call and donor mutex without copy admission", () => {
    const result = snapshot("", false);
    expect(result.status, result.stderr).toBe(0);
    expect(result.order).toContain(`locked:/canonical-donor:${result.frozen}:hardlink\n`);
    expect(result.order).not.toContain("admission");
  });

  it("uses the same maintained helper seam in both source routes, with copy tooling in committed provenance", () => {
    expect(operatorSnapshotSource.match(/snapshot_verifier_pinned_deps "\$snapshot_root"/g)).toHaveLength(2);
    const committed = src.slice(src.indexOf("snapshot_committed_operator_source() {"), operatorSnapshotCallIdx);
    // The committed route asks source-preview for its owned tooling profile.
    expect(committed).toContain("--tauri-inputs");
    const previewSrc = readFileSync(resolve(__dirname, "../../../scripts/source-preview.mjs"), "utf8");
    const profile = previewSrc.slice(
      previewSrc.indexOf("export const TAURI_VERIFIER_INPUTS"),
      previewSrc.indexOf("]);", previewSrc.indexOf("export const TAURI_VERIFIER_INPUTS")),
    );
    for (const path of ["scripts/pc-heavy.sh", "scripts/lib/budgeted-task-scheduler.mjs", "apps/operator/bin/release/dependency-generation.sh"]) {
      expect(profile).toContain(`'${path}'`);
    }
  });
});

describe("P-008 J1G — a file vanishing from the live tree does not fail the snapshot", () => {
  // Measured 2026-09-30T03:17Z: a peer's atomic-write temp file under docs/evidence
  // vanished mid-copy, rsync exited 24 and the whole L7 run died in prepare.
  const copyStart = operatorSnapshotSource.indexOf("local snapshot_rc=0");
  const copyEnd = operatorSnapshotSource.indexOf("\n  fi\n", copyStart) + 5;
  const copyBlock = operatorSnapshotSource.slice(copyStart, copyEnd);

  function copyWithRsyncExit(rc: number) {
    const script = [
      "set -uo pipefail",
      "source_filters=(); REPO_DIR=/nonexistent; snapshot_root=/nonexistent",
      "verify_operator_source_lock_census() { return 0; }",
      // The production copy now goes through the shared heavy-admission seam.
      // This fixture tests rsync disposition, so forward its actual command
      // through that seam without acquiring a real host-wide build slot.
      'vh_probe_admitted_exec() { shift; [ "$1" != -- ] || shift; "$@"; }',
      `rsync() { return ${rc}; }`,
      `copy() {\n${copyBlock}\necho copied\n}`,
      "copy",
    ].join("\n");
    return spawnSync("bash", ["-c", script], { encoding: "utf8" });
  }

  it("lifts the real copy block", () => {
    expect(copyStart).toBeGreaterThan(-1);
    expect(copyBlock).toContain('rsync -a --delete "${source_filters[@]}"');
    expect(copyBlock).toContain("FATAL: could not copy");
  });

  it.each([0, 24])("keeps the snapshot when rsync exits %i", (rc) => {
    const result = copyWithRsyncExit(rc);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("copied");
  });

  it.each([23, 12])("still refuses a snapshot when rsync exits %i", (rc) => {
    const result = copyWithRsyncExit(rc);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("copied");
    expect(result.stderr).toContain(`rsync exit ${rc}`);
  });
});

describe("WI-6554700010008536 — the frozen pinned-deps helper keeps its relative imports resolvable", () => {
  // The REAL helper's import line, so this guard follows pinned-deps.sh if the import moves.
  const helperSrc = readFileSync(
    resolve(__dirname, "../../../papercusp-desktop/bin/lib/pinned-deps.sh"),
    "utf8",
  );
  const importLine = helperSrc
    .split("\n")
    .find((line) =>
      /source "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)\/.*dependency-generation\.sh"/.test(line),
    );

  it("pinned-deps.sh still sources dependency-generation.sh relative to BASH_SOURCE", () => {
    expect(
      importLine,
      "pinned-deps.sh no longer imports dependency-generation.sh relative to BASH_SOURCE; re-check the verifier's helper staging",
    ).toBeTruthy();
  });

  it("hardlink mode stages the helper so the generation import and its .mjs siblings resolve inside the snapshot", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "verifier-pinned-helper-layout-"));
    try {
      const snapshot = resolve(fixture, "snapshot");
      const release = resolve(snapshot, "apps/operator/bin/release");
      mkdirSync(release, { recursive: true });
      writeFileSync(
        resolve(release, "dependency-generation.sh"),
        'dependency_generation_probe() { [ -f "$(dirname "${BASH_SOURCE[0]}")/dependency-lock-tree-audit.mjs" ] && echo generation-sibling-ok; }\n',
      );
      writeFileSync(resolve(release, "dependency-lock-tree-audit.mjs"), "");
      const helper = resolve(fixture, "donor/papercusp-desktop/bin/lib/pinned-deps.sh");
      mkdirSync(resolve(helper, ".."), { recursive: true });
      writeFileSync(
        helper,
        [
          "papercusp_pinned_deps_snapshot_locked() (",
          `  ${(importLine ?? "false").trim()}`,
          "  dependency_generation_probe || return 1",
          '  echo "locked:$1:$2:$3"',
          ")",
          "",
        ].join("\n"),
      );
      const work = resolve(fixture, "work");
      mkdirSync(work);
      const result = spawnSync(
        "bash",
        [
          "-c",
          [
            "set -euo pipefail",
            'REPO_DIR=/donor; WORK="$TEST_WORK"',
            dependencySnapshotSource,
            'snapshot_verifier_pinned_deps "$TEST_SNAPSHOT" "$TEST_HELPER"',
          ].join("\n"),
        ],
        {
          encoding: "utf8",
          env: {
            ...hermeticSpawnEnv(),
            TEST_WORK: work,
            TEST_SNAPSHOT: snapshot,
            TEST_HELPER: helper,
            VERIFY_TAURI_DEPENDENCY_SNAPSHOT_MODE: "hardlink",
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("generation-sibling-ok");
      expect(result.stdout).toContain(`locked:/donor:${snapshot}:hardlink`);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
