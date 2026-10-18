/** Regression coverage for EI-20041922041407287.
 *
 * Cargo already reports the distinction between a compiler diagnostic and an
 * externally killed rustc process. The native reporter must preserve it as a
 * machine-readable result instead of collapsing both cases into "error".
 */
import { describe, expect, it } from 'vitest';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import {
  assessCargoDiskAdmission,
  cargoTestRunReceipt,
  cargoCoverageOutputPath,
  cargoRunExitCode,
  CARGO_CACHE_TAG,
  CARGO_DISK_REFUSAL_EXIT_CODE,
  CARGO_PERCENT_FLOOR_BYPASS_BYTES,
  cargoDiskPolicyFromEnv,
  classifyAffectedCargoFailure,
  classifyCargoRun,
  detectCargoTermination,
  DEFAULT_CARGO_DISK_POLICY,
  DEFAULT_CARGO_RECLAIM_POLICY,
  ensureCargoCacheTag,
  findStaleBuildScriptOutputs,
  formatCargoDiskRefusal,
  formatCargoResultLine,
  diskProbePathFor,
  parseCargoTestResultLines,
  parseCargoMeasuredTestResults,
  pruneStaleBuildScriptOutputs,
  reclaimInactiveCargoArtifacts,
  resolveCargoBin,
  resolveCargoTargetDir,
  buildCargoExecutionDetails,
  cargoWorktreeProvenance,
  UNMEASURED_CARGO_WORKTREE,
  resolveCargoMutationPhase,
  resolveCargoTestRunScope,
  resolveCargoTestRunSource,
  shouldRunAffectedCargoSuite,
  stripCargoTerminalControlSequences,
// @ts-ignore -- runtime reporter module intentionally tested from TypeScript.
} from '../../../../scripts/lib/cargo-result.mjs';
import { parseTestRunExecutionDetails } from '@papercusp/test-config/execution-details';
import { mutationFailureLines } from '../agent-tools/plans/spec-evidence-store';
import { describeWorktreeDirt } from '../../../../libs/test-config/src/admin-test-runs-reporter';

const GIB = 1024 ** 3;
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const REPORTER_SOURCE = readFileSync(resolve(TEST_DIR, '../../../../scripts/report-cargo-tests.mjs'), 'utf8');
const AFFECTED_TESTS_SOURCE = readFileSync(resolve(TEST_DIR, '../../../../scripts/affected-tests.mjs'), 'utf8');
const VERIFY_SOURCE = readFileSync(resolve(TEST_DIR, '../../../../scripts/verify-tauri-headless.sh'), 'utf8');
const RIG_SOURCE = readFileSync(resolve(TEST_DIR, '../../../../papercusp-desktop/bin/lib/deb-hetzner-rig.sh'), 'utf8');
// Reporter subprocesses below exercise Cargo argument forwarding and result recording, not
// the host's disk state. Keep their admission policy independent of live headroom. The
// refusal case sets an intentionally restrictive threshold and covers the real CLI gate.
const PERMISSIVE_REPORTER_DISK_ENV = Object.freeze({
  PAPERCUSP_DISK_ALARM_FREE_PCT: '0.001',
  PAPERCUSP_DISK_ALARM_FREE_GB: '0.01',
  PAPERCUSP_CARGO_DISK_ALARM_PERCENT_FLOOR_BYPASS_GB: '0.01',
});

describe('Cargo reporter CLI usage (EI-25299812440954833)', () => {
  it('explains libtest forwarding and rejects a missing manifest before running Cargo', () => {
    const reporterPath = resolve(TEST_DIR, '../../../../scripts/report-cargo-tests.mjs');
    for (const args of [[], ['--coverage']]) {
      const result = spawnSync(process.execPath, [reporterPath, ...args], {
        encoding: 'utf8', timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('[-- <libtest args>]');
      expect(result.stderr).toContain('Arguments after -- go to the libtest test binary');
      expect(result.stderr).toContain('Cargo flags such as --all-targets are not supported');
      expect(result.stderr).not.toContain('<cargo test args>');
      expect(result.stdout).toBe('');
    }
    expect(REPORTER_SOURCE).toContain('[-- <libtest args>]');
    expect(REPORTER_SOURCE).toContain('Cargo.toml -- --nocapture');
    expect(REPORTER_SOURCE).not.toContain('<cargo test args>');
  });

  it('forwards supported libtest arguments after Cargo -- in normal and coverage runs', () => {
    const root = mkdtempSync(join(tmpdir(), 'cargo-cli-args-'));
    const manifest = join(root, 'Cargo.toml');
    const argvFile = join(root, 'argv.json');
    const reporterPath = resolve(TEST_DIR, '../../../../scripts/report-cargo-tests.mjs');
    try {
      writeFileSync(manifest, '[package]\nname="cli-fixture"\nversion="0.0.0"\n');
      writeFileSync(join(root, 'cargo'), [
        '#!/usr/bin/env node',
        "require('node:fs').writeFileSync(process.env.CARGO_CLI_ARGV_FILE, JSON.stringify(process.argv.slice(2)));",
        "console.log('test fixture ... ok');",
      ].join('\n'), { mode: 0o755 });
      for (const coverage of [false, true]) {
        const result = spawnSync(process.execPath, [
          reporterPath, '--manifest-path', manifest,
          ...(coverage ? ['--coverage', '--coverage-output', join(root, 'coverage.lcov')] : []),
          '--', '--nocapture', '--exact', 'fixture',
        ], {
          encoding: 'utf8', timeout: 10_000,
          env: {
            ...process.env, ...PERMISSIVE_REPORTER_DISK_ENV, PATH: `${root}:${process.env.PATH ?? ''}`,
            CARGO_TARGET_DIR: join(root, 'target'), CARGO_CLI_ARGV_FILE: argvFile,
            // Keep this fake-Cargo invocation away from the live test ledger.
            PAPERCUSP_TEST_RUNS_DB_URL: 'postgres://fixture:fixture@127.0.0.1:1/fixture',
            HARNESS_ADMIN_DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1:1/fixture',
          },
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).not.toContain('shared test-run reporter helpers unavailable');
        const args = JSON.parse(readFileSync(argvFile, 'utf8')) as string[];
        expect(args[0]).toBe(coverage ? 'llvm-cov' : 'test');
        expect(args.slice(args.indexOf('--') + 1)).toEqual([
          '--test-threads=4', '--nocapture', '--exact', 'fixture',
        ]);
        expect(args.slice(0, args.indexOf('--'))).toContain('--manifest-path');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 25_000);
});

describe('Cargo reporter ledger destination (EI-26344781297566924)', () => {
  const invocation = {
    schemaVersion: 1, probeInvocationId: 'cargo-reporter-fixture', mode: 'copy-out',
    subjectPath: 'src/main.rs', mutateExpression: 's/original/mutated/', againstCommit: null,
    subjectBeforeSha256: 'a'.repeat(64), subjectAfterSha256: 'b'.repeat(64),
    mutantDiff: '-original\n+mutated\n', mutantDiffTruncated: false,
    testCommandSha256: 'c'.repeat(64), testCommand: 'cargo test --manifest-path Cargo.toml',
  };
  it.each([
    ['explicit ledger', ' postgresql://ledger.example/evidence ', 'postgresql://ledger.example/evidence', 'baseline', 'valid', 'p032-cargo-ledger'],
    ['runtime fallback', undefined, 'postgresql://runtime.example/private', 'copy-baseline', 'valid'],
    ['blank ledger fallback', '  ', 'postgresql://runtime.example/private', 'mutant', 'valid'],
    ['ordinary run', undefined, 'postgresql://runtime.example/private', undefined, 'valid', "cargo ordinary: owner's run"],
    ['empty run group', undefined, 'postgresql://runtime.example/private', undefined, 'valid', ''],
    ['malformed descriptor', undefined, 'postgresql://runtime.example/private', 'mutant', 'malformed'],
    ['unknown descriptor field', undefined, 'postgresql://runtime.example/private', 'mutant', 'unknown-field'],
    ['absent descriptor', undefined, 'postgresql://runtime.example/private', 'mutant', 'absent'],
  ])('records the real CLI inserts in the %s', (_label, ledgerUrl, expectedUrl, phase, descriptorKind, runGroup) => {
    const root = mkdtempSync(join(tmpdir(), 'cargo-ledger-destination-'));
    const inserts = join(root, 'inserts.jsonl');
    const loader = join(root, 'loader.mjs');
    const postgres = join(root, 'postgres.mjs');
    const receipts = join(root, 'receipts.jsonl');
    try {
      writeFileSync(join(root, 'Cargo.toml'), '[package]\nname="ledger-fixture"\nversion="0.0.0"\n');
      mkdirSync(join(root, 'src'));
      const source = join(root, 'src/main.rs');
      writeFileSync(source, '#[test] fn fixture() {}\n');
      writeFileSync(join(root, 'cargo'), [
        '#!/usr/bin/env node',
        `const source = ${JSON.stringify(source)}, binary = ${JSON.stringify(join(root, 'target/debug/deps/fixture-123'))};`,
        "if (process.argv[2] === 'metadata') console.log(JSON.stringify({ packages: [{ targets: [{ name: 'fixture', src_path: source }] }] }));",
        'else {',
        "console.log(JSON.stringify({ reason: 'compiler-artifact', target: { src_path: source }, executable: binary }));",
        "console.log('     Running unittests src/main.rs (' + binary + ')');",
        "console.log('running 1 test\\ntest fixture ... ok\\ntest result: ok. 1 passed; 0 failed; 0 ignored');",
        '}',
      ].join('\n'), { mode: 0o755 });
      writeFileSync(postgres, `
        import { appendFileSync } from 'node:fs';
        export default function postgres(url) {
          const sql = async (_strings, ...values) => {
            const execution = values.find(value => value?.schemaVersion === 1 && 'mutationPhase' in value);
            const query = _strings.map((part, index) => part + (index < values.length ? '__value_' + index + '__' : '')).join('');
            const columns = query.match(/INSERT INTO harness_shared.test_runs\\s*\\(([^)]+)\\)/)[1].split(',').map(column => column.trim());
            const slots = query.match(/VALUES\\s*\\(([^)]+)\\)/)[1].split(',');
            const groupSlot = slots[columns.indexOf('run_group_id')]?.match(/__value_(\\d+)__/);
            const runGroupId = groupSlot ? values[Number(groupSlot[1])] : '__missing_run_group_id__';
            appendFileSync(process.env.CARGO_LEDGER_INSERTS, JSON.stringify({ url, execution, runGroupId }) + '\\n');
            return [{ id: '70001' }];
          };
          sql.json = value => value;
          sql.end = async () => {};
          return sql;
        }
      `);
      writeFileSync(loader, `
        import { registerHooks } from 'node:module';
        import { pathToFileURL } from 'node:url';
        registerHooks({ resolve(specifier, context, nextResolve) {
          if (specifier === 'postgres') return {
            url: pathToFileURL(${JSON.stringify(postgres)}).href, shortCircuit: true,
          };
          return nextResolve(specifier, context);
        }});
      `);
      const result = spawnSync(process.execPath, [
        '--import', loader, resolve(TEST_DIR, '../../../../scripts/report-cargo-tests.mjs'),
        '--manifest-path', join(root, 'Cargo.toml'),
      ], {
        encoding: 'utf8', timeout: 15_000,
        env: {
          ...process.env, ...PERMISSIVE_REPORTER_DISK_ENV,
          PATH: `${root}:${process.env.PATH ?? ''}`, CARGO_TARGET_DIR: join(root, 'target'),
          CARGO_LEDGER_INSERTS: inserts, PAPERCUSP_TEST_RUN_RECEIPT_FILE: receipts,
          PAPERCUSP_TEST_RUN_GROUP: runGroup,
          PAPERCUSP_TEST_RUNS_DB_URL: ledgerUrl,
          HARNESS_ADMIN_DATABASE_URL: 'postgresql://runtime.example/private',
          PAPERCUSP_PG_PORT: '25432',
          PAPERCUSP_MUTATION_PROBE: phase ? '1' : '0',
          PAPERCUSP_MUTATION_PHASE: phase,
          PAPERCUSP_MUTATION_DESCRIPTOR: descriptorKind === 'absent' ? undefined
            : descriptorKind === 'malformed' ? '{broken'
              : JSON.stringify(descriptorKind === 'unknown-field' ? { ...invocation, unknown: true } : invocation),
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('inserted 2/2 rows');
      const recorded = readFileSync(inserts, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(recorded.map(row => row.url)).toEqual([expectedUrl, expectedUrl]);
      // EI-26347306867077217: queryable SQL and strict details must identify
      // the same run, including aggregates and runs without a group override.
      expect(recorded.map(row => row.runGroupId)).toEqual([runGroup ?? null, runGroup ?? null]);
      for (const row of recorded) {
        expect(parseTestRunExecutionDetails(row.execution)).toMatchObject({ runGroupId: runGroup ?? null });
      }
      // EI-26345752138365143: inspect the INSERT payload, not a hand-built
      // execution-details object. The shared descriptor parser rejects invalid
      // exports; the aggregate cannot invent a source-file hash.
      if (phase && descriptorKind === 'valid') {
        expect(recorded.map(row => row.execution.mutation)).toEqual([
          { ...invocation, leg: phase, testFileSha256: createHash('sha256').update(readFileSync(source)).digest('hex') },
          { ...invocation, leg: phase, testFileSha256: null },
        ]);
      } else {
        expect(recorded.every(row => row.execution.mutation === undefined)).toBe(true);
      }
      expect(readFileSync(receipts, 'utf8').trim().split('\n').map(line => JSON.parse(line)))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ status: 'pass', outcome: 'inserted', id: '70001' }),
        ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});

const SIGTERM_CARGO_OUTPUT = `
error: could not compile \`papercusp-desktop\` (bin "papercusp-desktop" test)

Caused by:
  process didn't exit successfully: \`/usr/bin/rustc --crate-name papercusp_desktop\` (signal: 15, SIGTERM: termination signal)
`;

describe('Cargo measured passing cases and layers (P-002)', () => {
  it('records real virtual-workspace target paths and excludes a real inherited child harness', () => {
    const root = mkdtempSync(join(tmpdir(), 'cargo-workspace-reporter-'));
    const receiptFile = join(root, 'receipts.ndjson');
    try {
      writeFileSync(join(root, 'Cargo.toml'), '[workspace]\nmembers = ["a", "b"]\nresolver = "2"\n');
      for (const name of ['a', 'b']) {
        mkdirSync(join(root, name, 'src'), { recursive: true });
        writeFileSync(join(root, name, 'Cargo.toml'), `[package]\nname = "reporter-fixture-${name}"\nversion = "0.0.0"\nedition = "2021"\n`);
        writeFileSync(join(root, name, 'src/lib.rs'), `
          #[cfg(test)] mod tests {
            #[test] fn same() {}
            ${name === 'a' ? `#[test] fn reentrant() {
              if std::env::var_os("REPORTER_FIXTURE_CHILD").is_none() {
                let status = std::process::Command::new(std::env::current_exe().unwrap())
                  .env("REPORTER_FIXTURE_CHILD", "1")
                  .args(["--exact", "tests::reentrant"]).status().unwrap();
                assert!(status.success());
              }
            }` : ''}
          }
        `);
      }
      const result = spawnSync(process.execPath, [
        '--import', 'tsx', resolve(TEST_DIR, '../../../../scripts/report-cargo-tests.mjs'),
        '--manifest-path', join(root, 'Cargo.toml'),
      ], {
        encoding: 'utf8', timeout: 90_000,
        env: { ...process.env, ...PERMISSIVE_REPORTER_DISK_ENV, CARGO_TARGET_DIR: join(root, 'target'), CARGO_BUILD_JOBS: '1',
          PAPERCUSP_TEST_RUNS_DB_URL: 'postgres://fixture:fixture@127.0.0.1:1/fixture',
          HARNESS_ADMIN_DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1:1/fixture',
          PAPERCUSP_TEST_RUN_RECEIPT_FILE: receiptFile },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('parsed 3 test results;');
      const receipts = readFileSync(receiptFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(receipts.map(r => r.filePath).sort()).toEqual([
        '. (cargo aggregate)', 'a/src/lib.rs::tests::reentrant',
        'a/src/lib.rs::tests::same', 'b/src/lib.rs::tests::same',
      ]);
      expect(receipts.every(r => r.status === 'pass')).toBe(true);
      // The DB is intentionally unreachable: failed recording must not fail Cargo.
      expect(receipts.every(r => r.outcome === 'failed')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 100_000);

  it('uses unique metadata for llvm-cov headers and refuses ambiguous package attribution', () => {
    const output = [
      '     Running tests/shared.rs (/target/debug/deps/shared-123abc)',
      'running 1 test', 'test contract ... ok', 'test result: ok. 1 passed',
    ].join('\n');
    const targets = [{ name: 'shared', src_path: '/mobile/a/tests/shared.rs' }];
    expect(parseCargoMeasuredTestResults(output, { root: '/mobile', targets })[0])
      .toMatchObject({ testFilePath: 'a/tests/shared.rs', testLayer: 'integration' });
    expect(parseCargoMeasuredTestResults(output, { root: '/mobile', targets: [
      ...targets, { name: 'shared', src_path: '/mobile/b/tests/shared.rs' },
    ] })[0]).not.toHaveProperty('testFilePath');
  });

  it('counts the outer libtest run, excluding inherited reentrant child output', () => {
    const rows = parseCargoMeasuredTestResults([
      '     Running unittests src/lib.rs (target/debug/deps/bindings-123)',
      'running 2 tests',
      'test independent ... ok',
      'running 1 test',
      'test reentrant ... FAILED',
      'test result: FAILED. 0 passed; 1 failed',
      'test reentrant ... ok',
      'test result: ok. 2 passed; 0 failed',
    ].join('\n'));
    expect(rows).toEqual([
      { name: 'independent', outcome: 'ok', testLayer: 'unit' },
      { name: 'reentrant', outcome: 'ok', testLayer: 'unit' },
    ]);
  });

  it('attributes identical workspace case names to their exact compiler targets', () => {
    const artifact = (pkg: string, executable: string) => JSON.stringify({
      reason: 'compiler-artifact', executable,
      target: { src_path: `/mobile/crates/${pkg}/src/lib.rs` },
    });
    const rows = parseCargoMeasuredTestResults([
      artifact('a', '/target/debug/deps/shared-111'),
      artifact('b', '/target/debug/deps/shared-222'),
      '     Running unittests src/lib.rs (/target/debug/deps/shared-111)',
      'running 1 test', 'test tests::same ... ok',
      'test result: ok. 1 passed; 0 failed',
      '     Running unittests src/lib.rs (/target/debug/deps/shared-222)',
      'running 1 test', 'test tests::same ... FAILED',
      'test result: FAILED. 0 passed; 1 failed',
    ].join('\n'), { root: '/mobile' });
    expect(rows).toEqual([
      { name: 'tests::same', outcome: 'ok', testLayer: 'unit', testFilePath: 'crates/a/src/lib.rs' },
      { name: 'tests::same', outcome: 'FAILED', testLayer: 'unit', testFilePath: 'crates/b/src/lib.rs' },
    ]);
  });

  it('keeps partial outer failures without treating captured stdout as executed cases', () => {
    expect(parseCargoMeasuredTestResults([
      '     Running tests/contract.rs (target/debug/deps/contract-123)',
      'running 2 tests', 'test broken ... FAILED',
      '---- broken stdout ----', 'test invented ... ok',
      'test result: FAILED. 0 passed; 1 failed',
      '     Running tests/crashed.rs (target/debug/deps/crashed-123)',
      'running 2 tests', 'test before_crash ... ok',
    ].join('\n'))).toEqual([
      { name: 'broken', outcome: 'FAILED', testLayer: 'integration' },
      { name: 'before_crash', outcome: 'ok', testLayer: 'integration' },
    ]);
  });

  it('records ignored tests with their libtest reason without inventing passing results', () => {
    const output = [
      '     Running tests/live_smoke.rs (target/debug/deps/live_smoke-123)',
      'test live_p0_contract_smoke ... ignored, needs a live operator, two workspaces and one-time pair token',
      'test malformed_pass ... ok, unrelated text',
      'test malformed_failure ... FAILED, unrelated text',
      'test real_pass ... ok',
    ].join('\n');
    expect(parseCargoTestResultLines(output)).toEqual([
      { name: 'live_p0_contract_smoke', outcome: 'ignored' },
      { name: 'real_pass', outcome: 'ok' },
    ]);
    expect(parseCargoMeasuredTestResults(output)).toEqual([
      { name: 'live_p0_contract_smoke', outcome: 'ignored', testLayer: 'integration' },
      { name: 'real_pass', outcome: 'ok', testLayer: 'integration' },
    ]);
  });

  it('distinguishes unit, integration and unannounced results from target headers', () => {
    const rows = parseCargoMeasuredTestResults([
      'test unannounced ... ok',
      '     Running unittests src/lib.rs (target/debug/deps/core-123)',
      'test tests::unit ... ok',
      'test tests::ignored ... ignored',
      'test result: ok. 1 passed; 0 failed; 1 ignored',
      '     Running tests/client_test.rs (target/debug/deps/client_test-123)',
      'test null_status ... ok',
      'test rejected ... FAILED',
      'test result: FAILED. 1 passed; 1 failed',
      '   Doc-tests core',
      'test src/lib.rs - example (line 2) ... ok',
      'test trailing ... ok',
    ].join('\n'));
    expect(rows).toEqual([
      { name: 'unannounced', outcome: 'ok' },
      { name: 'tests::unit', outcome: 'ok', testLayer: 'unit' },
      { name: 'tests::ignored', outcome: 'ignored', testLayer: 'unit' },
      { name: 'null_status', outcome: 'ok', testLayer: 'integration' },
      { name: 'rejected', outcome: 'FAILED', testLayer: 'integration' },
      { name: 'trailing', outcome: 'ok' },
    ]);
  });

  it('persists passing case identity and measured layer in the strict ledger contract', () => {
    const detail = buildCargoExecutionDetails({
      root: '/mobile', filePath: 'core::null_status', passed: 1,
      passedCaseTitles: ['null_status', 'null_status', 'bad\ntitle', 'extra'],
      testLayer: 'integration', env: {},
    });
    expect(parseTestRunExecutionDetails(detail)).toMatchObject({
      passedCaseTitles: ['null_status'], testLayer: 'integration',
    });
    const crash = buildCargoExecutionDetails({ root: '/mobile', filePath: 'aggregate',
      passed: 1, collectionFailed: true, passedCaseTitles: ['unexecuted'], env: {} });
    expect(crash).not.toHaveProperty('passedCaseTitles');
    expect(crash).not.toHaveProperty('testLayer');
    expect(REPORTER_SOURCE).toContain('parseCargoMeasuredTestResults(combinedOutput ?? combined, { root: REPO_ROOT, targets })');
    expect(REPORTER_SOURCE).toContain('passedCaseTitles: r.outcome');
    expect(REPORTER_SOURCE).toContain('testRunReporter?.setRunRoot?.(REPO_ROOT)');
  });
});

const SIGKILL_CARGO_OUTPUT = `
error: could not compile \`papercusp-desktop\` (bin "papercusp-desktop" test)
Caused by:
  process didn't exit successfully: \`/usr/bin/rustc --crate-name papercusp_desktop\` (signal: 9, SIGKILL: kill)
`;

describe('cargo test_runs rows are attributed to a harness/workspace (WI-10006828)', () => {
  const VITEST_REPORTER_SOURCE = readFileSync(
    resolve(TEST_DIR, '../../../../libs/test-config/src/admin-test-runs-reporter.ts'),
    'utf8',
  );

  /** The `process.env.X ||` chain inside one named resolver in the vitest reporter. */
  function vitestPrecedence(fnName: string): string[] {
    const start = VITEST_REPORTER_SOURCE.indexOf(`export function ${fnName}(`);
    expect(start, `${fnName} must exist in admin-test-runs-reporter.ts`).toBeGreaterThanOrEqual(0);
    const body = VITEST_REPORTER_SOURCE.slice(start, VITEST_REPORTER_SOURCE.indexOf('\n}\n', start));
    return [...body.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]);
  }

  it('resolves the harness and workspace with the same precedence as the vitest reporter', () => {
    const harnessKeys = vitestPrecedence('resolveTestRunHarnessSlug');
    const workspaceKeys = vitestPrecedence('resolveTestRunWorkspaceId');
    // Calibration: an empty list would make every assertion below vacuous.
    expect(harnessKeys.length).toBeGreaterThanOrEqual(2);
    expect(workspaceKeys.length).toBeGreaterThanOrEqual(2);

    for (const [field, keys] of [['harnessSlug', harnessKeys], ['workspaceId', workspaceKeys]] as const) {
      expect(resolveCargoTestRunScope({})[field]).toBeNull();
      // Each key alone resolves; and each key beats every key after it.
      keys.forEach((key, i) => {
        expect(resolveCargoTestRunScope({ [key]: `v-${key}` })[field]).toBe(`v-${key}`);
        const env = Object.fromEntries(keys.slice(i).map((k) => [k, `v-${k}`]));
        expect(resolveCargoTestRunScope(env)[field]).toBe(`v-${key}`);
      });
      // An empty string falls through, exactly like the `||` chain it mirrors.
      expect(resolveCargoTestRunScope({ [keys[0]]: '', [keys[1]]: 'second' })[field]).toBe('second');
    }
  });

  it('the reporter INSERT writes harness_slug and workspace_id from the resolved scope', () => {
    const insert = REPORTER_SOURCE.slice(REPORTER_SOURCE.indexOf('INSERT INTO harness_shared.test_runs'));
    const columns = insert.slice(insert.indexOf('(') + 1, insert.indexOf(')')).split(',').map((c) => c.trim());
    expect(columns).toContain('harness_slug');
    expect(columns).toContain('workspace_id');
    const values = insert.slice(insert.indexOf('VALUES'));
    const valueList = values.slice(values.indexOf('(') + 1, values.indexOf('\n        `')).trim();
    // Column and value lists must stay aligned, with the scope values in the matching slots.
    const valueSlots = valueList.replace(/\)\s*$/, '').split(',').map((v) => v.trim());
    expect(valueSlots).toHaveLength(columns.length);
    expect(valueSlots[columns.indexOf('harness_slug')]).toBe('${harnessSlug}');
    expect(valueSlots[columns.indexOf('workspace_id')]).toBe('${workspaceId}');
    expect(REPORTER_SOURCE).toMatch(/const \{ harnessSlug, workspaceId \} = resolveCargoTestRunScope\(\)/);
    // The probe phase rides in execution_details, and the row source comes from the shared rule.
    expect(columns).toContain('execution_details');
    expect(valueSlots[columns.indexOf('execution_details')]).toContain('executionDetails');
    expect(REPORTER_SOURCE).toMatch(/const executionDetails = buildCargoExecutionDetails\(\{ \.\.\.row\.execution,/);
    expect(REPORTER_SOURCE).toMatch(/const source = resolveCargoTestRunSource\(\)/);
  });

  it('a mutation probe records cargo rows as source=mutation-probe, like the vitest reporter', () => {
    // Pinned to the vitest reporter's own rule so the two cannot drift apart silently.
    expect(VITEST_REPORTER_SOURCE).toMatch(
      /if \(process\.env\.PAPERCUSP_MUTATION_PROBE === '1'\) return 'mutation-probe';/,
    );
    expect(resolveCargoTestRunSource({})).toBe('local');
    expect(resolveCargoTestRunSource({ CI: '1' })).toBe('ci');
    expect(resolveCargoTestRunSource({ CI: '1', PAPERCUSP_MUTATION_PROBE: '1' })).toBe('mutation-probe');
    expect(resolveCargoTestRunSource({ PAPERCUSP_TEST_RUN_SOURCE: 'admin-ui' })).toBe('admin-ui');
    expect(resolveCargoTestRunSource({ PAPERCUSP_TEST_RUN_SOURCE: 'bogus' })).toBe('local');
    expect(resolveCargoTestRunSource({ PAPERCUSP_MUTATION_PROBE: '1', PAPERCUSP_TEST_RUN_SOURCE: 'ci' }))
      .toBe('mutation-probe');
  });

  it('records the probe phase, and no phase outside a probe', () => {
    expect(resolveCargoMutationPhase({})).toBeNull();
    expect(resolveCargoMutationPhase({ PAPERCUSP_MUTATION_PHASE: 'mutant' })).toBeNull();
    expect(resolveCargoMutationPhase({ PAPERCUSP_MUTATION_PROBE: '1' })).toBeNull();
    expect(resolveCargoMutationPhase({ PAPERCUSP_MUTATION_PROBE: '1', PAPERCUSP_MUTATION_PHASE: ' mutant ' }))
      .toBe('mutant');
  });

  it('writes Cargo mutation-probe receipt lines using the shared receipt helper (WI-10006990)', () => {
    const receipt = cargoTestRunReceipt({
      filePath: 'papercusp-desktop/src-tauri::tests::recovery_page',
      status: 'fail',
      returnedId: 20865149,
    });
    expect(receipt).toEqual({
      filePath: 'papercusp-desktop/src-tauri::tests::recovery_page',
      status: 'fail',
      outcome: 'inserted',
      id: '20865149',
    });
    expect(cargoTestRunReceipt({ filePath: 'c::test', status: 'pass', error: 'pg_insert_timeout_2000ms' }))
      .toEqual({ filePath: 'c::test', status: 'pass', outcome: 'timeout', reason: 'pg_insert_timeout_2000ms' });
    expect(cargoTestRunReceipt({ filePath: 'c::test', status: 'fail', error: 'pg_unavailable' }))
      .toEqual({ filePath: 'c::test', status: 'fail', outcome: 'failed', reason: 'pg_unavailable' });
    expect(cargoTestRunReceipt({ filePath: 'c::test', status: 'fail' }))
      .toEqual({ filePath: 'c::test', status: 'fail', outcome: 'failed', reason: 'insert_returned_no_id' });

    expect(REPORTER_SOURCE).toContain('RETURNING id');
    expect(REPORTER_SOURCE).toMatch(/appendTestRunReceipts\?\.\(process\.env, receipts\)/);
    expect(REPORTER_SOURCE).toMatch(/returnedId: returned\?\.\[0\]\?\.id/);
  });

  // WI-10006849: the contract parser is strict, and the spec evaluator reads failed-case
  // identity ONLY from a record it accepts — a partial record silently erased every cargo
  // mutant's failing case, so no cargo clause could ever prove falsifiability.
  it('writes execution_details the shared contract parser accepts, naming the failed cargo case', () => {
    const probe = { PAPERCUSP_MUTATION_PROBE: '1', PAPERCUSP_MUTATION_PHASE: 'mutant' };
    const failedRow = buildCargoExecutionDetails({
      root: '/repo', filePath: 'papercusp-desktop/src-tauri::tests::tracker_measures', failed: 1,
      failedCaseTitles: ['tests::tracker_measures'], harnessSlug: 'papercusp', workspaceId: 'ws', env: probe,
    });
    expect(parseTestRunExecutionDetails(failedRow)).toMatchObject({
      failed: 1, failedCaseTitles: ['tests::tracker_measures'], mutationPhase: 'mutant', harnessSlug: 'papercusp',
    });
    // The evaluator's own line derivation turns that identity into a declarable case prefix.
    expect(mutationFailureLines('thread panicked at src/main.rs:1:1:', failedRow))
      .toEqual(['tests::tracker_measures: (recorded failed assertion)']);

    const passRow = buildCargoExecutionDetails({ root: '/repo', filePath: 'c::tests::ok', passed: 1, env: {} });
    expect(parseTestRunExecutionDetails(passRow)).toMatchObject({ passed: 1, failed: 0, mutationPhase: null });
    expect(passRow).not.toHaveProperty('failedCaseTitles');

    // A crashed binary is a collection failure: it may name no failed case.
    const crashed = buildCargoExecutionDetails({
      root: '/repo', filePath: 'c (cargo aggregate)', collectionFailed: true, failed: 0, failedCaseTitles: ['x'], env: {},
    });
    expect(parseTestRunExecutionDetails(crashed)).toBeDefined();
    expect(crashed).not.toHaveProperty('failedCaseTitles');

    // Titles beyond the failed count, duplicates and control characters are never recorded.
    const aggregate = buildCargoExecutionDetails({
      root: '/repo', filePath: 'c (cargo aggregate)', failed: 2,
      failedCaseTitles: ['tests::a', 'tests::a', 'bad\ntitle', 'tests::b', 'tests::c'], env: {},
    });
    expect(aggregate.failedCaseTitles).toEqual(['tests::a', 'tests::b']);
    expect(parseTestRunExecutionDetails(aggregate)).toBeDefined();

    // The partial record this replaces is exactly what the parser rejects.
    expect(parseTestRunExecutionDetails({ mutationPhase: 'mutant' })).toBeUndefined();
  });
});

describe('cargo result classification (EI-20041922041407287)', () => {
  it('recognizes SIGTERM as an externally killed compiler, not a compile failure', () => {
    const result = classifyCargoRun({ code: 101, output: SIGTERM_CARGO_OUTPUT, resultCount: 0 });

    expect(result).toEqual({
      status: 'killed',
      termination: { signal: 15, signalName: 'SIGTERM' },
    });
    expect(formatCargoResultLine(result)).toBe(
      'CARGO_RESULT status=killed signal=15 signalName=SIGTERM cause=killed-by-signal',
    );
  });

  it('recognizes SIGKILL and preserves the signal number', () => {
    expect(detectCargoTermination(SIGKILL_CARGO_OUTPUT)).toEqual({ signal: 9, signalName: 'SIGKILL' });
  });

  it('keeps a real rustc diagnostic in the failed bucket', () => {
    const output = 'error[E0308]: mismatched types\nerror: could not compile `papercusp-desktop`';

    expect(classifyCargoRun({ code: 101, output, resultCount: 0 })).toEqual({
      status: 'failed',
      termination: null,
    });
  });

  it('does not classify a passing test run as killed even if its output mentions SIGTERM', () => {
    expect(
      classifyCargoRun({
        code: 0,
        output: 'test result: ok. 351 passed; 0 failed\n(note: SIGTERM is handled by the harness)',
        resultCount: 351,
      }),
    ).toEqual({ status: 'passed', termination: null });
  });
});

describe('cargo reporter empty-suite exit guard (EI-21554799836880302)', () => {
  it('fails a zero-result run even when Cargo exits successfully', () => {
    expect(cargoRunExitCode({ code: 0, resultCount: 0 })).toBe(1);
    expect(REPORTER_SOURCE).toContain('process.exit(cargoRunExitCode({ code, resultCount: results.length }));');
  });

  it('preserves Cargo failures and successful measured runs', () => {
    expect(cargoRunExitCode({ code: 101, resultCount: 0 })).toBe(101);
    expect(cargoRunExitCode({ code: 0, resultCount: 695 })).toBe(0);
    expect(cargoRunExitCode({ code: null, resultCount: 0 })).toBe(1);
  });
});

describe('cargo test result parsing', () => {
  it('keeps result counts and names aligned when terminal control output prefixes lines', () => {
    const output = [
      'running 3 tests',
      'test native_console::tests::plain ... ok',
      '\u001b]0;cargo test\u0007\u001b[2Ktest native_console::tests::oneliner_keeps_quoted_greeting_parseable ... ok',
      '\u001b[32mtest native_console::tests::ignored_case ... ignored\u001b[0m',
      'test result: ok. 2 passed; 0 failed; 1 ignored',
    ].join('\n');

    expect(stripCargoTerminalControlSequences(output)).not.toContain('\u001b');
    const results = parseCargoTestResultLines(output) as Array<{
      name: string;
      outcome: 'ok' | 'FAILED' | 'ignored';
    }>;

    expect(results).toHaveLength(3);
    expect(results.map(({ name }) => name)).toEqual([
      'native_console::tests::plain',
      'native_console::tests::oneliner_keeps_quoted_greeting_parseable',
      'native_console::tests::ignored_case',
    ]);
    expect(results.map(({ outcome }) => outcome)).toEqual(['ok', 'ok', 'ignored']);
    expect(REPORTER_SOURCE).toContain('const results = measuredResults;');
  });
});

describe('cargo coverage output placement (P-010, design-to-code-coverage-seam-2026-09-02)', () => {
  const manifest = '/repo/papercusp-desktop/src-tauri/Cargo.toml';

  // These assert the CONTRACT with scripts/merge-coverage.ts's discovery walk,
  // not a literal string. That walker finds inputs by looking for a directory
  // named `coverage` holding `lcov.info`, and derives the workspace the records
  // are relative to as dirname(dirname(file)). Both halves must hold or the
  // Rust records re-anchor against the wrong root — a silent mis-merge, not an
  // error. Asserting the literal path would pass while the coupling rotted.
  it('writes where merge-coverage looks: <crateDir>/coverage/lcov.info', () => {
    const out = cargoCoverageOutputPath(manifest) as string;

    expect(basename(out)).toBe('lcov.info');
    expect(basename(dirname(out))).toBe('coverage');
    // the workspace merge-coverage will attribute these records to
    expect(dirname(dirname(out))).toBe('/repo/papercusp-desktop/src-tauri');
  });

  it('never nests the report under target/, which every tree-walker prunes', () => {
    const out = cargoCoverageOutputPath(manifest) as string;

    // cargo-llvm-cov's own default lands in target/. merge-coverage.ts and
    // affected-tests.mjs both prune `target`, so a report written there is
    // structurally invisible: the Rust leg contributes zero files and every
    // command still exits 0 — a gate that goes green having measured nothing.
    expect(out.split('/')).not.toContain('target');
  });

  it('creates the output directory BEFORE spawning Cargo, not after the suite', () => {
    // Measured 2026-09-03: cargo-llvm-cov does not create --output-path's
    // parent. It ran all 386 tests green and only then died with
    // `failed to create file 'coverage/lcov.info': No such file or directory`,
    // discarding a complete instrumented run. The mkdir must therefore precede
    // the spawn, not follow the run.
    const mkdirAt = REPORTER_SOURCE.indexOf('mkdirSync(dirname(coverage.outputPath)');
    const spawnAt = REPORTER_SOURCE.indexOf('const child = spawn(resolveCargoBin()');

    expect(mkdirAt).toBeGreaterThan(-1);
    expect(spawnAt).toBeGreaterThan(-1);
    expect(mkdirAt).toBeLessThan(spawnAt);
  });

  it('runs the same harness under llvm-cov, so the stdout parser still applies', () => {
    // `cargo llvm-cov` wraps `cargo test` and passes its harness output
    // through, which is what lets every parser and per-test ledger row below
    // work unchanged. If this ever became a separate runner, the per-test rows
    // would silently stop being recorded.
    expect(REPORTER_SOURCE).toContain("'llvm-cov',");
    expect(REPORTER_SOURCE).toContain('const results = measuredResults;');
  });
});

describe('affected-runner Cargo selection (EI-21851033142703518)', () => {
  it('does not couple a scoped JS workspace verdict to unrelated Cargo admission', () => {
    expect(
      shouldRunAffectedCargoSuite({
        affectedWorkspaceNames: ['@papercusp/pot-app-seam'],
      }),
    ).toBe(false);
  });

  it('still runs Cargo for desktop-related and explicit all-workspace invocations', () => {
    expect(
      shouldRunAffectedCargoSuite({
        affectedWorkspaceNames: ['@papercusp/desktop'],
      }),
    ).toBe(true);
    expect(shouldRunAffectedCargoSuite({ runAll: true })).toBe(true);
  });

  it('honours an explicit desktop exclusion even under --all and wires the policy into production', () => {
    expect(
      shouldRunAffectedCargoSuite({
        runAll: true,
        affectedWorkspaceNames: ['@papercusp/desktop'],
        excludedWorkspaceNames: ['@papercusp/desktop'],
      }),
    ).toBe(false);
    expect(AFFECTED_TESTS_SOURCE).toContain('shouldRunAffectedCargoSuite({');
    expect(AFFECTED_TESTS_SOURCE).toContain('if (RUN_CARGO_SUITE)');
  });
});

describe('cargo disk admission (EI-21047688909295463)', () => {
  it('refuses before spawning the Cargo test command when the configured absolute disk floor is unmet', () => {
    const root = mkdtempSync(join(tmpdir(), 'cargo-admission-refusal-'));
    const markerFile = join(root, 'cargo-spawned');
    const reporterPath = resolve(TEST_DIR, '../../../../scripts/report-cargo-tests.mjs');
    try {
      writeFileSync(join(root, 'Cargo.toml'), '[package]\nname="admission-fixture"\nversion="0.0.0"\n');
      mkdirSync(join(root, 'target'), { recursive: true });
      writeFileSync(join(root, 'cargo'), [
        '#!/usr/bin/env node',
        "if (process.argv[2] === 'test') require('node:fs').writeFileSync(process.env.CARGO_CLI_MARKER_FILE, 'spawned');",
      ].join('\n'), { mode: 0o755 });

      const result = spawnSync(process.execPath, [
        reporterPath, '--manifest-path', join(root, 'Cargo.toml'),
      ], {
        encoding: 'utf8', timeout: 15_000,
        env: {
          ...process.env,
          PATH: `${root}:${process.env.PATH ?? ''}`,
          CARGO_TARGET_DIR: join(root, 'target'),
          CARGO_CLI_MARKER_FILE: markerFile,
          PAPERCUSP_TEST_RUNS_DB_URL: 'postgres://fixture:fixture@127.0.0.1:1/fixture',
          HARNESS_ADMIN_DATABASE_URL: 'postgres://fixture:fixture@127.0.0.1:1/fixture',
          PAPERCUSP_DISK_ALARM_FREE_GB: '1000000000',
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(CARGO_DISK_REFUSAL_EXIT_CODE);
      expect(result.stderr).toContain('REFUSED before spawning Cargo');
      expect(existsSync(markerFile)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a new native suite below the standing 10% free-space floor', () => {
    const result = assessCargoDiskAdmission({
      totalBytes: 2_000 * GIB,
      freeBytes: 80 * GIB,
    });

    expect(result).toMatchObject({
      allowed: false,
      status: 'blocked',
      reasons: ['free-percent'],
      usedPct: 96,
      freeGiB: 80,
    });
    expect(formatCargoDiskRefusal(result)).toContain('REFUSED before spawning Cargo');
    expect(CARGO_DISK_REFUSAL_EXIT_CODE).toBe(75);
    expect(
      formatCargoResultLine({
        status: 'error',
        cause: 'low-disk-admission-refused',
        disk: { usedPct: result.usedPct!, freeGiB: result.freeGiB! },
      }),
    ).toBe('CARGO_RESULT status=error cause=low-disk-admission-refused diskUsedPct=96 diskFreeGiB=80');
  });

  it('allows a suite above both the percentage and absolute floors', () => {
    expect(
      assessCargoDiskAdmission({ totalBytes: 2_000 * GIB, freeBytes: 240 * GIB }),
    ).toMatchObject({ allowed: true, status: 'ok', reasons: [], usedPct: 88, freeGiB: 240 });
  });

  it('EI-21149612505559395: allows a huge filesystem with conservative absolute headroom despite a low free percentage', () => {
    const result = assessCargoDiskAdmission({
      totalBytes: 7.3 * 1024 * GIB,
      freeBytes: 284 * GIB,
    });

    expect(CARGO_PERCENT_FLOOR_BYPASS_BYTES).toBe(128 * GIB);
    expect(result).toMatchObject({
      allowed: true,
      status: 'ok',
      reasons: [],
      usedPct: 96,
      freeGiB: 284,
      percentFloorBypassGiB: 128,
    });
  });

  it('never lets the percentage bypass weaken the hard absolute free-space floor', () => {
    expect(
      assessCargoDiskAdmission({ totalBytes: 20 * GIB, freeBytes: 4 * GIB }),
    ).toMatchObject({ allowed: false, status: 'blocked', reasons: ['free-bytes'] });
  });

  it('reuses the disk alarm tuning keys and their positive-number fallback', () => {
    expect(
      cargoDiskPolicyFromEnv({
        PAPERCUSP_DISK_ALARM_FREE_PCT: '12.5',
        PAPERCUSP_DISK_ALARM_FREE_GB: '8',
      }),
    ).toEqual({ freePctMin: 0.125, freeBytesMin: 8 * GIB, percentFloorBypassBytes: 128 * GIB });
    expect(
      cargoDiskPolicyFromEnv({ PAPERCUSP_DISK_ALARM_FREE_PCT: '0', PAPERCUSP_DISK_ALARM_FREE_GB: '-1' }),
    ).toEqual({ freePctMin: 0.1, freeBytesMin: 5 * GIB, percentFloorBypassBytes: 128 * GIB });
  });

  it('EI-21901389541963783: percentFloorBypassBytes is env-tunable via its own key, defaulting to the unchanged 128 GiB constant', () => {
    expect(cargoDiskPolicyFromEnv({})).toEqual({
      freePctMin: 0.1,
      freeBytesMin: 5 * GIB,
      percentFloorBypassBytes: 128 * GIB,
    });
    expect(
      cargoDiskPolicyFromEnv({ PAPERCUSP_CARGO_DISK_ALARM_PERCENT_FLOOR_BYPASS_GB: '96' }),
    ).toEqual({ freePctMin: 0.1, freeBytesMin: 5 * GIB, percentFloorBypassBytes: 96 * GIB });
    // A non-positive override falls back to the unchanged default, exactly like the two existing keys.
    expect(
      cargoDiskPolicyFromEnv({ PAPERCUSP_CARGO_DISK_ALARM_PERCENT_FLOOR_BYPASS_GB: '0' }),
    ).toEqual({ freePctMin: 0.1, freeBytesMin: 5 * GIB, percentFloorBypassBytes: 128 * GIB });
  });

  it('EI-21901389541963783: an env-tuned percentFloorBypassBytes actually changes the admission verdict and the refusal message', () => {
    const tightPolicy = cargoDiskPolicyFromEnv({
      PAPERCUSP_CARGO_DISK_ALARM_PERCENT_FLOOR_BYPASS_GB: '50',
    });
    // 60 GiB free clears a 50 GiB bypass floor but would refuse against the default 128 GiB floor.
    const result = assessCargoDiskAdmission({ totalBytes: 2_000 * GIB, freeBytes: 60 * GIB }, tightPolicy);
    expect(result).toMatchObject({ allowed: true, status: 'ok', reasons: [], percentFloorBypassGiB: 50 });
    expect(
      assessCargoDiskAdmission({ totalBytes: 2_000 * GIB, freeBytes: 60 * GIB }, DEFAULT_CARGO_DISK_POLICY),
    ).toMatchObject({ allowed: false, status: 'blocked', reasons: ['free-percent'] });
  });

  it('fails open when statfs values are unreadable instead of manufacturing a disk verdict', () => {
    expect(
      assessCargoDiskAdmission({ totalBytes: Number.NaN, freeBytes: Number.NaN }),
    ).toMatchObject({ allowed: true, status: 'unknown', reasons: ['invalid-statfs'], usedPct: null, freeGiB: null });
  });

  it('wires the disk decision and refusal ahead of the executable Cargo spawn', () => {
    const statfsAt = REPORTER_SOURCE.indexOf('statfsSync(diskProbePath)');
    const refusalAt = REPORTER_SOURCE.indexOf('if (!diskAdmission.allowed)');
    const spawnAt = REPORTER_SOURCE.indexOf('spawn(resolveCargoBin()');

    expect(statfsAt).toBeGreaterThan(-1);
    expect(refusalAt).toBeGreaterThan(statfsAt);
    expect(spawnAt).toBeGreaterThan(refusalAt);
    expect(REPORTER_SOURCE).toContain("cause: 'low-disk-admission-refused'");
    expect(REPORTER_SOURCE).toContain('code: CARGO_DISK_REFUSAL_EXIT_CODE');
  });
});

describe('D-002 rule 1: the admission policy the guard APPLIES has not been loosened', () => {
  // Reading the constants at their definition site does NOT answer this: the literal can
  // survive while the value assessCargoDiskAdmission() actually enforces moves underneath it
  // (a shadowed default parameter, a second default, a caller-supplied policy). Measured
  // 2026-09-09: halving the applied floor to freePctMin 0.05 while leaving every literal
  // untouched passed all 57 pre-existing tests in this file. So each threshold below is
  // pinned BEHAVIOURALLY, through a default-path call with no policy argument, by a pair of
  // cases that straddle it — the refusing side is what goes red when the guard gets quieter.

  it('applies exactly { freePctMin 0.1, freeBytesMin 5 GiB, percentFloorBypass 128 GiB } on the default path', () => {
    expect(DEFAULT_CARGO_DISK_POLICY).toEqual({
      freePctMin: 0.1,
      freeBytesMin: 5 * GIB,
      percentFloorBypassBytes: 128 * GIB,
    });

    // The policy carried back out of a default-path call is the one that decided it.
    const applied = assessCargoDiskAdmission({ totalBytes: 2_000 * GIB, freeBytes: 240 * GIB });
    expect(applied.policy).toEqual({
      freePctMin: 0.1,
      freeBytesMin: 5 * GIB,
      percentFloorBypassBytes: 128 * GIB,
    });
    expect(applied.percentFloorBypassGiB).toBe(128);
  });

  it('pins the applied 10% free-percentage floor from both sides', () => {
    // 1 TiB keeps both cases under the 128 GiB absolute-headroom bypass, so the percentage
    // floor — not the bypass — is what decides them.
    expect(
      assessCargoDiskAdmission({ totalBytes: 1_000 * GIB, freeBytes: 99 * GIB }),
    ).toMatchObject({ allowed: false, status: 'blocked', reasons: ['free-percent'] });
    expect(
      assessCargoDiskAdmission({ totalBytes: 1_000 * GIB, freeBytes: 101 * GIB }),
    ).toMatchObject({ allowed: true, status: 'ok', reasons: [] });
  });

  it('pins the applied 5 GiB absolute free-bytes floor from both sides', () => {
    // Both cases sit far above the percentage floor, so free-bytes is the deciding leg.
    expect(
      assessCargoDiskAdmission({ totalBytes: 20 * GIB, freeBytes: 4.9 * GIB }),
    ).toMatchObject({ allowed: false, status: 'blocked', reasons: ['free-bytes'] });
    expect(
      assessCargoDiskAdmission({ totalBytes: 20 * GIB, freeBytes: 5.1 * GIB }),
    ).toMatchObject({ allowed: true, status: 'ok', reasons: [] });
  });

  it('pins the applied 128 GiB absolute-headroom bypass from both sides', () => {
    // A 10 TiB filesystem puts both cases far below 10% free, so only the bypass can admit.
    expect(
      assessCargoDiskAdmission({ totalBytes: 10_000 * GIB, freeBytes: 127 * GIB }),
    ).toMatchObject({ allowed: false, status: 'blocked', reasons: ['free-percent'] });
    expect(
      assessCargoDiskAdmission({ totalBytes: 10_000 * GIB, freeBytes: 129 * GIB }),
    ).toMatchObject({ allowed: true, status: 'ok', reasons: [] });
  });

  it('EI-21047688909295463: the deliberate 2 TiB / 80 GiB host still REFUSES', () => {
    // The behavioural witness for these constants. A host on which this admits proves the
    // policy moved even when the literals look untouched.
    expect(
      assessCargoDiskAdmission({ totalBytes: 2_000 * GIB, freeBytes: 80 * GIB }),
    ).toMatchObject({ allowed: false, status: 'blocked', reasons: ['free-percent'] });
  });
});

describe('disk admission measures the mount Cargo writes to (WI-212675)', () => {
  const manifest = '/checkouts/papercusp/papercusp-desktop/src-tauri/Cargo.toml';

  it('probes the resolved target directory, never the manifest, and keys reservations + reclaim on it', () => {
    // Source pins: the probe, the reservation read and the reclaim sweep all key
    // on the target's path. `statfsSync(manifestAbs)` WAS the pre-fix probe, so its
    // absence is the property under test, not a style preference.
    expect(REPORTER_SOURCE).toContain('resolveCargoTargetDir(manifestAbs)');
    expect(REPORTER_SOURCE).toContain('diskProbePathFor(cargoTargetDir)');
    expect(REPORTER_SOURCE).toContain('statfsSync(diskProbePath)');
    expect(REPORTER_SOURCE).toContain('readReservedBytes(diskProbePath)');
    expect(REPORTER_SOURCE).toContain('configuredTargetDir: cargoTargetDir');
    expect(REPORTER_SOURCE).not.toContain('statfsSync(manifestAbs)');
    expect(REPORTER_SOURCE).not.toContain('readReservedBytes(manifestAbs)');
  });

  it('resolves the target with Cargo precedence: env, then metadata, then <manifest dir>/target', () => {
    const metadata = () => '/mnt/data/cargo-target';
    expect(
      resolveCargoTargetDir(manifest, { env: { CARGO_TARGET_DIR: 'rel/target' }, cwd: '/work', metadata }),
    ).toBe('/work/rel/target');
    expect(
      resolveCargoTargetDir(manifest, { env: { CARGO_TARGET_DIR: '  ' }, cwd: '/work', metadata }),
    ).toBe('/mnt/data/cargo-target');
    expect(
      resolveCargoTargetDir(manifest, { env: {}, cwd: '/work', metadata: () => { throw new Error('no cargo'); } }),
    ).toBe('/checkouts/papercusp/papercusp-desktop/src-tauri/target');
    expect(
      resolveCargoTargetDir(manifest, { env: {}, cwd: '/work', metadata: () => null }),
    ).toBe('/checkouts/papercusp/papercusp-desktop/src-tauri/target');
  });

  it('walks a not-yet-created target up to its nearest existing ancestor for statfs', () => {
    const existing = new Set(['/', '/mnt', '/mnt/data']);
    const exists = (p: string) => existing.has(p);
    expect(diskProbePathFor('/mnt/data/cargo-target/debug', { exists })).toBe('/mnt/data');
    expect(diskProbePathFor('/mnt/data', { exists })).toBe('/mnt/data');
    expect(diskProbePathFor('/nowhere/at/all', { exists })).toBe('/');
  });

  it('names the probed mount in the refusal, and leaves a probe-less admission message unchanged', () => {
    const admission = assessCargoDiskAdmission({ totalBytes: 2000 * GIB, freeBytes: 80 * GIB });
    expect(formatCargoDiskRefusal(admission)).toContain('filesystem is ');
    expect(formatCargoDiskRefusal({ ...admission, probePath: '/mnt/data' })).toContain('filesystem at /mnt/data is ');
  });

  it('CONTROL: the pre-fix manifest-mount resolver is rejected by the scenario the fix must pass', () => {
    // Permanent deliberately-wrong implementation (mutation-probe tier "module
    // logic"): the old behaviour measured the manifest's own directory. The
    // property — "the probed path lies under the configured target's mount" —
    // must reject it, or the assertions above are not discriminating.
    const manifestMountResolver = (manifestAbs: string) => dirname(manifestAbs);
    const existing = new Set([
      '/', '/mnt', '/mnt/data',
      '/checkouts', '/checkouts/papercusp', '/checkouts/papercusp/papercusp-desktop',
      '/checkouts/papercusp/papercusp-desktop/src-tauri',
    ]);
    const exists = (p: string) => existing.has(p);
    const configuredTarget = '/mnt/data/cargo-target';
    const probedUnderTarget = (resolver: (m: string) => string) =>
      diskProbePathFor(resolver(manifest), { exists }).startsWith('/mnt/data');

    expect(
      probedUnderTarget((m) => resolveCargoTargetDir(m, { env: {}, cwd: '/work', metadata: () => configuredTarget })),
    ).toBe(true);
    expect(probedUnderTarget(manifestMountResolver)).toBe(false);
  });
});

describe('isolated Cargo target cleanup (EI-21048920599909117)', () => {
  it('finds rustup Cargo even when the worker PATH omits ~/.cargo/bin', () => {
    const home = mkdtempSync(resolve(tmpdir(), 'papercusp-cargo-home-'));
    const cargo = resolve(home, '.cargo/bin/cargo');
    try {
      mkdirSync(dirname(cargo), { recursive: true });
      writeFileSync(cargo, '#!/bin/sh\n');
      expect(resolveCargoBin({ PATH: '' }, home)).toBe(cargo);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('initializes the canonical tag so Cargo clean accepts a producer-created target', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'papercusp-cargo-cache-tag-'));
    const targetDir = resolve(root, 'isolated-target');
    const manifestPath = resolve(root, 'Cargo.toml');

    try {
      // The assertion is about Cargo's real CACHEDIR.TAG parser, not the desktop workspace. Using
      // that live manifest coupled this pure-lane guard to concurrent Cargo work in the shared
      // checkout: the affected suite observed the child terminate with status:null while the same
      // test passed alone. A minimal temporary crate exercises the identical `cargo clean`
      // validation path without joining another lane's workspace locks or target discovery.
      mkdirSync(resolve(root, 'src'), { recursive: true });
      writeFileSync(
        manifestPath,
        '[package]\nname = "papercusp-cargo-tag-fixture"\nversion = "0.0.0"\nedition = "2021"\n',
      );
      writeFileSync(resolve(root, 'src/lib.rs'), 'pub fn fixture() {}\n');

      ensureCargoCacheTag(targetDir);
      writeFileSync(resolve(targetDir, 'sentinel'), 'safe-to-remove\n');
      expect(readFileSync(resolve(targetDir, 'CACHEDIR.TAG'), 'utf8')).toBe(CARGO_CACHE_TAG);

      const clean = spawnSync(
        resolveCargoBin(),
        ['clean', '--manifest-path', manifestPath, '--target-dir', targetDir],
        { encoding: 'utf8', timeout: 300_000, killSignal: 'SIGKILL' },
      );

      expect(
        clean.status,
        JSON.stringify({ error: clean.error?.message, signal: clean.signal, stderr: clean.stderr, stdout: clean.stdout }),
      ).toBe(0);
      expect(clean.stderr).not.toContain('invalid signature in `CACHEDIR.TAG` file');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs tag initialization after disk admission and before the Cargo child starts', () => {
    const admissionAt = REPORTER_SOURCE.indexOf('if (!diskAdmission.allowed)');
    const tagAt = REPORTER_SOURCE.indexOf('ensureCargoCacheTag(resolve(REPO_ROOT, configuredTargetDir))');
    const spawnAt = REPORTER_SOURCE.indexOf('spawn(resolveCargoBin()');

    expect(admissionAt).toBeGreaterThan(-1);
    expect(tagAt).toBeGreaterThan(admissionAt);
    expect(spawnAt).toBeGreaterThan(tagAt);
  });
});

describe('stale build-script outputs after a MOVED target dir (WI-212675, gate run 7f876d2d)', () => {
  // The real shape: ~/.cargo-target was moved to /mnt/data/cargo-target; cargo replayed
  // tauri's cached `…PERMISSION_FILES_PATH=/home/…/.cargo-target/…/out/…` to
  // papercusp-desktop's build.rs, which panicked on the vanished path (exit 101, 0 results).
  const setup = () => {
    const targetDir = mkdtempSync(resolve(tmpdir(), 'cargo-target-moved-'));
    const oldTarget = mkdtempSync(resolve(tmpdir(), 'cargo-target-old-'));
    rmSync(oldTarget, { recursive: true, force: true }); // the OLD address no longer exists
    const liveSibling = mkdtempSync(resolve(tmpdir(), 'cargo-target-sibling-'));
    const siblingOut = join(liveSibling, 'debug', 'build', 'ring-fedcba9876543210', 'out');
    mkdirSync(siblingOut, { recursive: true });
    writeFileSync(join(siblingOut, 'table.rs'), '', 'utf8'); // the referenced file really exists
    const build = join(targetDir, 'debug', 'build');
    const write = (crate: string, lines: string[]) => {
      mkdirSync(join(build, crate), { recursive: true });
      writeFileSync(join(build, crate, 'output'), `${lines.join('\n')}\n`, 'utf8');
    };
    const stalePath = `${oldTarget}/debug/build/tauri-0123456789abcdef/out/tauri-core-path-permission-files`;
    write('tauri-0123456789abcdef', [
      `cargo:core:path__CORE_PLUGIN___PERMISSION_FILES_PATH=${stalePath}`,
      'cargo:rerun-if-changed=build.rs',
    ]);
    // Controls, each ignored for a DIFFERENT reason:
    write('ring-fedcba9876543210', [
      // (b) inside THIS target dir — the normal, healthy case.
      `cargo:rustc-env=RING_CORE_PREFIX=${targetDir}/debug/build/ring-fedcba9876543210/out/ring_core.h`,
      // (a) an absolute path with NO build segment — a deleted source is cargo's own business.
      `cargo:rerun-if-changed=${oldTarget}/src/gone.c`,
    ]);
    write('mime-abcdef0123456789', [
      // (c) a LIVE sibling target dir — exists, so not stale.
      `cargo:rustc-env=MIME_TABLE=${siblingOut}/table.rs`,
    ]);
    const cleanup = () => {
      for (const d of [targetDir, liveSibling]) rmSync(d, { recursive: true, force: true });
    };
    return { targetDir, build, stalePath, cleanup };
  };

  it('names exactly the build dir whose replayed metadata points into a vanished target dir', () => {
    const { targetDir, build, stalePath, cleanup } = setup();
    try {
      const stale = findStaleBuildScriptOutputs(targetDir);
      expect(stale).toHaveLength(1);
      expect(stale[0]).toMatchObject({
        dir: join(build, 'tauri-0123456789abcdef'),
        profile: 'debug',
        crate: 'tauri-0123456789abcdef',
        staleRefs: [stalePath],
      });
    } finally {
      cleanup();
    }
  });

  it('prunes only that dir, and afterwards reports nothing stale', () => {
    const { targetDir, build, cleanup } = setup();
    try {
      const dry = pruneStaleBuildScriptOutputs(targetDir, { dryRun: true, pathIsLive: () => false });
      expect(dry).toMatchObject({ found: 1, dryRun: true, skipped: [] });
      expect(dry.pruned.map((p: { crate: string }) => p.crate)).toEqual(['tauri-0123456789abcdef']);
      expect(existsSync(join(build, 'tauri-0123456789abcdef'))).toBe(true); // dry run removed nothing

      const real = pruneStaleBuildScriptOutputs(targetDir, { pathIsLive: () => false });
      expect(real).toMatchObject({ found: 1, dryRun: false, skipped: [] });
      expect(real.pruned).toHaveLength(1);
      expect(existsSync(join(build, 'tauri-0123456789abcdef'))).toBe(false);
      expect(existsSync(join(build, 'ring-fedcba9876543210', 'output'))).toBe(true);
      expect(existsSync(join(build, 'mime-abcdef0123456789', 'output'))).toBe(true);
      expect(findStaleBuildScriptOutputs(targetDir)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('skips wholesale while another process holds the target dir — never deletes under a live build', () => {
    const { targetDir, build, cleanup } = setup();
    try {
      const held = pruneStaleBuildScriptOutputs(targetDir, { pathIsLive: () => true });
      expect(held.found).toBe(1);
      expect(held.pruned).toEqual([]);
      expect(held.skipped).toEqual([
        { path: join(build, 'tauri-0123456789abcdef'), reason: 'target dir in use by another process' },
      ]);
      expect(existsSync(join(build, 'tauri-0123456789abcdef', 'output'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('the runner prunes before spawning cargo and reports it on the [report-cargo-tests] channel', () => {
    // Pinned to source, like the sibling disk-admission guards: the call must sit AFTER the
    // target dir is resolved and BEFORE the cargo child is spawned.
    const resolveAt = REPORTER_SOURCE.indexOf('const cargoTargetDir = resolveCargoTargetDir(manifestAbs);');
    const pruneAt = REPORTER_SOURCE.indexOf('pruneStaleBuildScriptOutputs(cargoTargetDir)');
    const spawnAt = REPORTER_SOURCE.indexOf('return new Promise((resolvePromise) => {', pruneAt);
    expect(resolveAt).toBeGreaterThan(-1);
    expect(pruneAt).toBeGreaterThan(resolveAt);
    expect(spawnAt).toBeGreaterThan(pruneAt);
    expect(REPORTER_SOURCE).toContain('[report-cargo-tests] stale build-script outputs (moved target dir)');
  });
});

describe('bounded inactive artifact reclaim (EI-21150371868241728)', () => {
  const stalePolicy = {
    ...DEFAULT_CARGO_RECLAIM_POLICY,
    ephemeralTtlMs: 1,
    cargoTtlMs: 1,
    minCargoArtifactBytes: 0,
    maxBytes: 1024 * 1024,
  };

  function age(path: string) {
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(path, old, old);
  }

  it('reclaims stale verifier/rig dirs, but preserves live, kept, and provisioned rigs', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'papercusp-cargo-reclaim-'));
    const staleVerify = resolve(root, 'verify-tauri-headless.stale');
    const staleRigWithoutLedger = resolve(root, 'deb-hzfed.no-ledger');
    const staleRigWithLedger = resolve(root, 'deb-hzfed.provisioned');
    const liveVerify = resolve(root, 'verify-tauri-headless.live');
    const keptRig = resolve(root, 'deb-hzfed.keep');

    try {
      for (const path of [staleVerify, staleRigWithoutLedger, staleRigWithLedger, liveVerify, keptRig]) {
        mkdirSync(path, { recursive: true });
        writeFileSync(resolve(path, 'payload'), 'x');
        age(path);
      }
      writeFileSync(resolve(staleRigWithLedger, 'servers'), '12345\n');
      writeFileSync(resolve(keptRig, '.papercusp-keep'), 'operator requested retention\n');

      const result = reclaimInactiveCargoArtifacts({
        tmpDir: root,
        cargoRoots: [],
        now: Date.now(),
        policy: stalePolicy,
        pathIsLive: (path: string) => path === liveVerify,
      });

      expect(result.reclaimed).toBe(2);
      expect(result.bytesReclaimed).toBeGreaterThan(0);
      expect(() => readFileSync(resolve(staleVerify, 'payload'))).toThrow();
      expect(() => readFileSync(resolve(staleRigWithoutLedger, 'payload'))).toThrow();
      expect(readFileSync(resolve(staleRigWithLedger, 'servers'), 'utf8')).toBe('12345\n');
      expect(readFileSync(resolve(liveVerify, 'payload'), 'utf8')).toBe('x');
      expect(readFileSync(resolve(keptRig, 'payload'), 'utf8')).toBe('x');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies the entry cap across ephemeral workdirs before scanning Cargo roots', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'papercusp-cargo-reclaim-cap-'));
    try {
      for (let i = 0; i < 3; i++) {
        const path = resolve(root, `verify-tauri-headless.${i}`);
        mkdirSync(path);
        writeFileSync(resolve(path, 'payload'), 'x');
        age(path);
      }

      const result = reclaimInactiveCargoArtifacts({
        tmpDir: root,
        cargoRoots: [],
        now: Date.now(),
        policy: { ...stalePolicy, maxEntries: 2 },
        pathIsLive: () => false,
      });

      expect(result.reclaimed).toBe(2);
      expect(result.skipped.length).toBe(0);
      expect(
        [0, 1, 2].filter((i) => existsSync(resolve(root, `verify-tauri-headless.${i}`))),
      ).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reclaims an inactive private Cargo target, but respects a held slot and keep marker', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'papercusp-cargo-target-reclaim-'));
    const privateTarget = resolve(root, '.cargo-target-pid123');
    const heldTarget = resolve(root, '.cargo-target-dev2');
    const keptTarget = resolve(root, '.cargo-target-pid456');

    try {
      for (const path of [privateTarget, heldTarget, keptTarget]) {
        mkdirSync(resolve(path, 'release', 'bundle'), { recursive: true });
        writeFileSync(resolve(path, 'release', 'bundle', 'artifact'), 'x');
        age(path);
      }
      writeFileSync(resolve(keptTarget, '.papercusp-keep'), 'keep\n');

      const result = reclaimInactiveCargoArtifacts({
        tmpDir: root,
        cargoRoots: [privateTarget, heldTarget, keptTarget],
        now: Date.now(),
        policy: { ...stalePolicy, maxEntries: 4 },
        pathIsLive: () => false,
        slotLockIsHeld: (path: string) => path === heldTarget,
      });

      expect(result.reclaimed).toBe(1);
      expect(() => readFileSync(resolve(privateTarget))).toThrow();
      expect(readFileSync(resolve(heldTarget, 'release', 'bundle', 'artifact'), 'utf8')).toBe('x');
      expect(readFileSync(resolve(keptTarget, 'release', 'bundle', 'artifact'), 'utf8')).toBe('x');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reclaims an explicitly configured tagged target with a non-legacy basename, but never an untagged one', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'papercusp-configured-cargo-reclaim-'));
    const configuredTarget = resolve(root, 'cargo-target');
    const untaggedTarget = resolve(root, 'other-target');

    try {
      for (const target of [configuredTarget, untaggedTarget]) {
        mkdirSync(resolve(target, 'debug'), { recursive: true });
        writeFileSync(resolve(target, 'debug', 'artifact'), 'x');
        age(resolve(target, 'debug'));
        age(target);
      }
      ensureCargoCacheTag(configuredTarget);
      age(configuredTarget);

      const configured = reclaimInactiveCargoArtifacts({
        tmpDir: root,
        cargoRoots: [configuredTarget],
        configuredTargetDir: configuredTarget,
        now: Date.now(),
        policy: { ...stalePolicy, maxEntries: 4 },
        pathIsLive: () => false,
        slotLockIsHeld: () => false,
      });
      const untagged = reclaimInactiveCargoArtifacts({
        tmpDir: root,
        cargoRoots: [untaggedTarget],
        configuredTargetDir: untaggedTarget,
        now: Date.now(),
        policy: { ...stalePolicy, maxEntries: 4 },
        pathIsLive: () => false,
        slotLockIsHeld: () => false,
      });

      expect(configured.reclaimed).toBe(1);
      expect(existsSync(resolve(configuredTarget, 'debug'))).toBe(false);
      expect(untagged.reclaimed).toBe(0);
      expect(existsSync(resolve(untaggedTarget, 'debug', 'artifact'))).toBe(true);
      expect(untagged.skipped).toContainEqual({
        path: untaggedTarget,
        reason: 'configured target lacks canonical CACHEDIR.TAG',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves a live target slot without letting it veto unrelated configured-target profiles', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'papercusp-configured-slot-reclaim-'));
    const configuredTarget = resolve(root, 'cargo-target');
    const slots = resolve(configuredTarget, '.papercusp-target-slots');
    const inactiveSlot = resolve(slots, 'dev2');
    const liveSlot = resolve(slots, 'dev3');

    try {
      const staleDebug = resolve(configuredTarget, 'debug');
      const liveRelease = resolve(configuredTarget, 'release');
      for (const path of [staleDebug, liveRelease, inactiveSlot, liveSlot]) {
        mkdirSync(path, { recursive: true });
        writeFileSync(resolve(path, 'artifact'), 'x');
        age(path);
      }
      ensureCargoCacheTag(configuredTarget);
      age(configuredTarget);

      const rootCalls: string[][] = [];
      const result = reclaimInactiveCargoArtifacts({
        tmpDir: root,
        cargoRoots: [configuredTarget],
        configuredTargetDir: configuredTarget,
        now: Date.now(),
        policy: { ...stalePolicy, maxEntries: 4 },
        pathIsLive: (path: string, ignoredSubtrees: string[] = []) => {
          if (path === configuredTarget) {
            rootCalls.push(ignoredSubtrees);
            return !ignoredSubtrees.includes(slots);
          }
          return path === liveRelease;
        },
        slotLockIsHeld: (path: string) => path === liveSlot,
      });

      expect(rootCalls).toEqual([[slots]]);
      expect(existsSync(staleDebug)).toBe(false);
      expect(existsSync(inactiveSlot)).toBe(false);
      expect(readFileSync(resolve(liveRelease, 'artifact'), 'utf8')).toBe('x');
      expect(readFileSync(resolve(liveSlot, 'artifact'), 'utf8')).toBe('x');
      expect(result.reclaimed).toBe(2);
      expect(result.skipped).toContainEqual({
        path: liveRelease,
        reason: 'live descriptor or executable',
      });
      expect(result.skipped).toContainEqual({
        path: liveSlot,
        reason: 'target slot is held',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('stamps producer ownership and keeps explicit rig retention visible to the reaper', () => {
    expect(VERIFY_SOURCE).toContain('write_run_marker "$$"');
    expect(VERIFY_SOURCE).toContain('write_run_marker "$PORT_LOCK_KEEPER_PID"');
    expect(RIG_SOURCE).toContain('rig_write_run_marker "$$"');
    expect(RIG_SOURCE).toContain('RIG_WORK/.papercusp-keep');
  });
});

/**
 * P-001 (test-suite-recovery-2026-08-27).
 *
 * The reproduced host: a 1875 GiB volume at 96% used with 78 GiB free. Admission
 * refused with reason `free-percent`, and the reclaim that is supposed to rescue
 * exactly this case returned `scanned: 2, reclaimed: 0` while ~67 GiB of the
 * suite's OWN stale Cargo output sat on the same mount.
 *
 * The cause was reach, not policy: `cargoArtifactCandidates` offered only
 * `release/bundle` and `<triple>/release`, so the Cargo PROFILE directories --
 * `debug/` above all, which is where `cargo test` builds -- were unreachable. A
 * host starved by the native test suite could therefore never reclaim its way
 * back in. These tests pin the corrected reach, and pin that it did not come at
 * the cost of the guards or the absolute floor.
 */
describe('native-suite admission reclaim reaches its own producer output (P-001)', () => {
  const stalePolicy = {
    ...DEFAULT_CARGO_RECLAIM_POLICY,
    cargoTtlMs: 1,
    ephemeralTtlMs: 1,
    minCargoArtifactBytes: 0,
  };

  function age(path: string, agoMs = 60_000) {
    const old = (Date.now() - agoMs) / 1000;
    utimesSync(path, old, old);
  }

  function seedProfile(target: string, profile: string) {
    const dir = resolve(target, profile);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'artifact'), 'x');
    return dir;
  }

  it('reclaims the stale debug profile that `cargo test` fills, which the release-only candidate set could never offer', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'papercusp-cargo-profile-'));
    const target = resolve(root, '.cargo-target');

    try {
      const debug = seedProfile(target, 'debug');
      const release = seedProfile(target, 'release');
      age(debug);
      age(release);
      age(target);

      const result = reclaimInactiveCargoArtifacts({
        tmpDir: root,
        cargoRoots: [target],
        now: Date.now(),
        policy: stalePolicy,
        pathIsLive: () => false,
        slotLockIsHeld: () => false,
      });

      // The whole point of the fix: `debug/` is now reachable at all.
      expect(existsSync(debug)).toBe(false);
      expect(existsSync(release)).toBe(false);
      expect(result.reclaimed).toBeGreaterThanOrEqual(2);
      expect(result.bytesReclaimed).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('still protects a warm profile directory that is younger than the TTL', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'papercusp-cargo-warm-'));
    const target = resolve(root, '.cargo-target');

    try {
      const warm = seedProfile(target, 'debug');
      const stale = seedProfile(target, 'release');
      age(stale, 60_000);
      age(target, 60_000);
      // `warm` keeps its just-written mtime.

      const result = reclaimInactiveCargoArtifacts({
        tmpDir: root,
        cargoRoots: [target],
        now: Date.now(),
        policy: { ...stalePolicy, cargoTtlMs: 30_000 },
        pathIsLive: () => false,
        slotLockIsHeld: () => false,
      });

      expect(readFileSync(resolve(warm, 'artifact'), 'utf8')).toBe('x');
      expect(existsSync(stale)).toBe(false);
      expect(result.skipped.some((s: { path: string; reason: string }) =>
        s.path === warm && s.reason === 'younger than ttl')).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('spends a peer target before the one this run is about to build into, and stops at the admission budget', () => {
    const home = mkdtempSync(resolve(tmpdir(), 'papercusp-cargo-order-'));
    const active = resolve(home, '.cargo-target');
    const peer = resolve(home, '.cargo-target-dev1');
    const realHome = process.env.HOME;

    try {
      for (const target of [active, peer]) {
        seedProfile(target, 'debug');
        age(resolve(target, 'debug'));
        age(target);
      }
      process.env.HOME = home;

      // A budget that is satisfied by the very first reclaim, exactly as the
      // reporter's `stopWhen: () => readDiskAdmission().allowed` behaves once
      // one artifact has freed enough space.
      const result = reclaimInactiveCargoArtifacts({
        tmpDir: home,
        configuredTargetDir: active,
        now: Date.now(),
        policy: stalePolicy,
        pathIsLive: () => false,
        slotLockIsHeld: () => false,
        stopWhen: () => true,
      });

      expect(result.reclaimed).toBe(1);
      expect(result.stoppedEarly).toBe(true);
      // The peer's stale output is spent; this run's target survives untouched.
      expect(existsSync(resolve(peer, 'debug'))).toBe(false);
      expect(readFileSync(resolve(active, 'debug', 'artifact'), 'utf8')).toBe('x');
    } finally {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('degrades to the exhaustive sweep when the budget predicate throws instead of stopping on a bad read', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'papercusp-cargo-budget-'));
    const target = resolve(root, '.cargo-target');

    try {
      for (const profile of ['debug', 'release']) {
        seedProfile(target, profile);
        age(resolve(target, profile));
      }
      age(target);

      const result = reclaimInactiveCargoArtifacts({
        tmpDir: root,
        cargoRoots: [target],
        now: Date.now(),
        policy: stalePolicy,
        pathIsLive: () => false,
        slotLockIsHeld: () => false,
        stopWhen: () => { throw new Error('statfs unreadable'); },
      });

      expect(result.stoppedEarly).toBe(false);
      expect(result.reclaimed).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports only blocks this delete can actually free when a Cargo artifact is hardlinked elsewhere', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'papercusp-cargo-hardlink-accounting-'));
    const target = resolve(root, '.cargo-target');
    const debug = resolve(target, 'debug');
    const shared = resolve(root, 'shared-artifact');
    const privateArtifact = resolve(debug, 'private-artifact');

    try {
      mkdirSync(debug, { recursive: true });
      // Make the externally-linked file large enough that directory metadata
      // cannot obscure the distinction between apparent and physically freed
      // bytes on filesystems with small directory allocations.
      writeFileSync(shared, Buffer.alloc(1024 * 1024));
      linkSync(shared, resolve(debug, 'shared-artifact'));
      writeFileSync(privateArtifact, 'private');
      age(debug);
      age(target);

      const sharedBlocks = Number(statSync(shared).blocks) * 512;
      const privateBlocks = Number(statSync(privateArtifact).blocks) * 512;
      expect(sharedBlocks).toBeGreaterThan(0);
      expect(privateBlocks).toBeGreaterThan(0);

      const result = reclaimInactiveCargoArtifacts({
        tmpDir: root,
        cargoRoots: [target],
        now: Date.now(),
        policy: stalePolicy,
        pathIsLive: () => false,
        slotLockIsHeld: () => false,
      });

      expect(existsSync(debug)).toBe(false);
      expect(existsSync(shared)).toBe(true);
      expect(result.reclaimed).toBe(1);
      expect(result.bytesReclaimed).toBeGreaterThanOrEqual(privateBlocks);
      expect(result.bytesReclaimed).toBeLessThan(sharedBlocks + privateBlocks);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reaches producer output without lowering either admission floor', () => {
    // The reproduced host shape, pinned as arithmetic rather than prose: the
    // percentage leg is what refuses, and the absolute floor is untouched.
    const reproduced = assessCargoDiskAdmission({ totalBytes: 1875 * GIB, freeBytes: 78 * GIB });
    expect(reproduced).toMatchObject({ allowed: false, reasons: ['free-percent'], usedPct: 96 });

    // Neither constant may be relaxed to make the reproduced host pass; the fix
    // is the reclaim's reach, so these stay exactly where their own evidence put
    // them (128 GiB is ~3-5x the measured 24-40 GiB native target footprint).
    expect(CARGO_PERCENT_FLOOR_BYPASS_BYTES).toBe(128 * GIB);
    expect(DEFAULT_CARGO_RECLAIM_POLICY.maxBytes).toBe(128 * GIB);
    expect(cargoDiskPolicyFromEnv({})).toEqual({
      freePctMin: 0.1,
      freeBytesMin: 5 * GIB,
      percentFloorBypassBytes: 128 * GIB,
    });

    // The reporter must spend the budget on the admission path, not sweep blindly.
    expect(REPORTER_SOURCE).toContain('stopWhen: () => readDiskAdmission().allowed');
  });
});

describe('admission reclaim age gate is decoupled from producer liveness (WI-954677)', () => {
  // The measured recurrence: WI-41462 was closed 2026-08-25 for this refusal and
  // it was back by 2026-08-30 (95% used, 99 GiB free). The artifact that cleared
  // it by hand — ~/.cargo-target/debug, 26 GiB — was 66 MINUTES old, so the 24h
  // age gate made the single largest reclaimable candidate permanently
  // ineligible on any host that runs `cargo test` more than once a day.
  const SIXTY_SIX_MINUTES = 66 * 60_000;

  function seedAgedProfile(target: string, profile: string, ageMs: number) {
    const dir = resolve(target, profile);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'artifact'), 'x');
    const old = (Date.now() - ageMs) / 1000;
    utimesSync(dir, old, old);
    return dir;
  }

  function ageDir(path: string, ageMs: number) {
    const old = (Date.now() - ageMs) / 1000;
    utimesSync(path, old, old);
  }

  function sweep(target: string, root: string, policy: Record<string, number>) {
    return reclaimInactiveCargoArtifacts({
      tmpDir: root,
      cargoRoots: [target],
      now: Date.now(),
      policy: { ...DEFAULT_CARGO_RECLAIM_POLICY, minCargoArtifactBytes: 0, ...policy },
      pathIsLive: () => false,
      slotLockIsHeld: () => false,
    });
  }

  it('reclaims a 66-minute-old debug profile under the blocked-admission age gate, and provably would NOT under the old 24h one', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'papercusp-cargo-agegate-'));
    try {
      const target = resolve(root, '.cargo-target');
      const debug = seedAgedProfile(target, 'debug', SIXTY_SIX_MINUTES);
      ageDir(target, SIXTY_SIX_MINUTES);

      // CONTROL FIRST — the old policy must FAIL to reclaim it. Without this the
      // assertion below would pass just as well against a broken sweep that
      // deletes everything, and would prove nothing about the age gate.
      const underOldTtl = sweep(target, root, { cargoTtlMs: 24 * 3_600_000 });
      expect(existsSync(debug)).toBe(true);
      expect(underOldTtl.reclaimed).toBe(0);
      expect(
        underOldTtl.skipped.some(
          (s: { path: string; reason: string }) => s.reason === 'younger than ttl',
        ),
      ).toBe(true);

      // THE FIX: the admission path's short age gate reaches the same artifact.
      const underAdmissionTtl = sweep(target, root, { cargoTtlMs: 10 * 60_000 });
      expect(existsSync(debug)).toBe(false);
      expect(underAdmissionTtl.reclaimed).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does NOT let a short age gate shrink the live-producer heartbeat window', () => {
    // This is the regression the obvious one-line fix introduces. `canReclaim`
    // used ONE ttl for both "old enough to reclaim" and "heartbeat still fresh",
    // so lowering the age gate to reach a stale artifact also narrowed the
    // window in which a running build is recognised as alive. A heartbeat 30
    // minutes old is live under the 24h heartbeat window but would read as
    // abandoned under a 10-minute one — so if anyone re-couples the two values,
    // this test deletes a live build's target and fails.
    const root = mkdtempSync(resolve(tmpdir(), 'papercusp-cargo-heartbeat-'));
    try {
      const target = resolve(root, '.cargo-target');
      const debug = seedAgedProfile(target, 'debug', SIXTY_SIX_MINUTES);
      ageDir(target, SIXTY_SIX_MINUTES);

      const beat = resolve(debug, '.heartbeat');
      writeFileSync(beat, 'alive');
      ageDir(beat, 30 * 60_000);
      // Re-age the DIRECTORY last: writing .heartbeat into it just bumped its
      // mtime to now, which would park the sweep on 'younger than ttl' and let
      // this test pass without ever reaching the heartbeat check it exists to
      // pin. (Observed: it did exactly that on the first run.)
      ageDir(debug, SIXTY_SIX_MINUTES);

      const result = sweep(target, root, {
        cargoTtlMs: 10 * 60_000,
        heartbeatTtlMs: 24 * 3_600_000,
      });

      expect(existsSync(debug)).toBe(true);
      expect(result.reclaimed).toBe(0);
      expect(
        result.skipped.some((s: { path: string; reason: string }) => s.reason === 'fresh heartbeat'),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the reporter reclaiming on the blocked path with an age gate well under a day', () => {
    // Pins the call site itself: the sweep is reached only when admission is
    // already blocked, and it must not inherit the 24h default there. The two
    // defaults stay put — this fix is about the admission path's override, not
    // about weakening the periodic janitor.
    expect(REPORTER_SOURCE).toContain('policy: { cargoTtlMs: 10 * 60_000 }');
    expect(DEFAULT_CARGO_RECLAIM_POLICY.heartbeatTtlMs).toBe(24 * 3_600_000);
    expect(DEFAULT_CARGO_RECLAIM_POLICY.cargoTtlMs).toBe(24 * 3_600_000);
  });
});

describe('affected-tests cargo failure labelling (EI-21950408988436927)', () => {
  // TWO-SIDED ON PURPOSE. The bug was a MISLABEL, so a one-sided test that only
  // checks "75 is called an admission refusal" passes just as happily against a
  // helper that calls EVERYTHING an admission refusal — which would forgive real
  // Rust reds. Every case below therefore asserts both what the class IS and what
  // it is NOT, and the ordinary-failure case is the control.

  it('labels an exit-75 refusal as an infrastructure refusal that never ran, not a Rust test failure', () => {
    const result = classifyAffectedCargoFailure({ code: CARGO_DISK_REFUSAL_EXIT_CODE, output: '' });

    expect(result).toMatchObject({
      kind: 'admission-refused',
      reason: 'disk-admission-refused',
      termination: null,
    });
    // The message is the whole point of the fix: it is what a triager reads before
    // deciding whether to go open papercusp-desktop source.
    expect(result.message).toContain('DID NOT RUN');
    expect(result.message).toContain('nothing to triage in papercusp-desktop');
    expect(result.message).not.toMatch(/exited with code/);
    // ...and it must not be reported through the generic non-vitest channel, which is
    // exactly how it read before this fix.
    expect(result.reason).not.toBe('non-vitest');
  });

  it('leaves an ordinary non-zero cargo exit as a plain failure — not relabelled, not forgiven', () => {
    const result = classifyAffectedCargoFailure({ code: 1, output: 'error[E0308]: mismatched types' });

    expect(result).toMatchObject({ kind: 'failed', reason: 'non-vitest', termination: null });
    expect(result.kind).not.toBe('admission-refused');
    expect(result.message).toBe('>>> cargo test suite exited with code 1');
    expect(result.message).not.toContain('DID NOT RUN');
  });

  it('still reports a signal kill as an external termination rather than a compiler diagnostic', () => {
    const result = classifyAffectedCargoFailure({ code: 101, output: SIGKILL_CARGO_OUTPUT });

    expect(result).toMatchObject({
      kind: 'killed-by-signal',
      reason: 'killed-by-signal:SIGKILL',
      termination: { signal: 9, signalName: 'SIGKILL' },
    });
    expect(result.message).toContain('not a compiler diagnostic');
  });

  it('prefers the observed signal over the exit code when a refusal code carries kill evidence', () => {
    // Precedence matches classifyCargoRun: a signal is observed in cargo's own output
    // and is the more specific claim, so it must not be masked by the numeric code.
    expect(
      classifyAffectedCargoFailure({ code: CARGO_DISK_REFUSAL_EXIT_CODE, output: SIGTERM_CARGO_OUTPUT }).kind,
    ).toBe('killed-by-signal');
  });

  it('GATES every failure class — a suite that never ran must not let the gate go green', () => {
    // The forgiving direction is the dangerous one: relabelling an admission refusal is
    // correct, dropping it from the verdict would ship unverified Rust. Held explicitly
    // so a later "unstick the gate" edit has to break a test to do it.
    for (const input of [
      { code: CARGO_DISK_REFUSAL_EXIT_CODE, output: '' },
      { code: 1, output: '' },
      { code: 101, output: SIGKILL_CARGO_OUTPUT },
      { code: null, output: '' },
    ]) {
      expect(classifyAffectedCargoFailure(input).gating).toBe(true);
    }
  });

  it('wires the wrapper through the shared classifier instead of re-inlining the exit code', () => {
    // The branch only runs once cargo has already failed, so nothing else exercises the
    // call site. Pin it: a re-inlined `status === 75` would make the helper — and every
    // assertion above — dead code while the wrapper misreported again.
    expect(AFFECTED_TESTS_SOURCE).toContain('classifyAffectedCargoFailure({');
    expect(AFFECTED_TESTS_SOURCE).toContain('reason: cargoFailureClass.reason');
    expect(AFFECTED_TESTS_SOURCE).not.toMatch(/cargoRun\.status === 75/);
    // The task NAME must stay stable — repair-queue / GATE_HELD_BY consumers match on it.
    expect(AFFECTED_TESTS_SOURCE).toContain('"papercusp-desktop :: cargo test"');
  });

  it('counts a quarantined Cargo failure in AFFECTED_TESTS_RESULT without gating the run', () => {
    // A real failing Cargo leg is deliberately too expensive for this unit suite. Scope the
    // source assertion to the executable cargo-failure branch so the regression cannot be
    // satisfied by the unrelated Vitest quarantine counter above.
    const cargoFailureStart = AFFECTED_TESTS_SOURCE.indexOf('if (cargoRun.status !== 0) {');
    const cargoFailureEnd = AFFECTED_TESTS_SOURCE.indexOf('  } catch (err) {', cargoFailureStart);
    expect(cargoFailureStart).toBeGreaterThanOrEqual(0);
    expect(cargoFailureEnd).toBeGreaterThan(cargoFailureStart);
    const cargoFailureBlock = AFFECTED_TESTS_SOURCE.slice(cargoFailureStart, cargoFailureEnd);

    expect(cargoFailureBlock).toContain(
      'if (cargoFailureClass.gating && !quarantined.has("papercusp-desktop"))',
    );
    expect(cargoFailureBlock).toContain('} else if (cargoFailureClass.gating) {');
    expect(cargoFailureBlock).toContain('quarantinedFailed++;');
    expect(cargoFailureBlock).toContain(
      'papercusp-desktop :: cargo test (quarantined failure — not gating)',
    );
    // The terminal marker must consume that same counter, or the observed failure would still
    // be absent from the machine-readable verdict despite the branch recording it.
    expect(AFFECTED_TESTS_SOURCE).toContain(
      'quarantinedFailed=${quarantinedFailed} timedOutTasks=${timedOutTasks}',
    );
  });

  // ── falsifiability controls ────────────────────────────────────────────────
  // A guard that has never failed is a guard nobody has tested, and this one guards a
  // branch that runs only when cargo has ALREADY failed — so it will not fail on its
  // own for months. The subject is an imported module, so the controls are deliberately
  // WRONG implementations kept permanently here rather than an in-tree mutation (which
  // this repo's shared checkout can commit mid-probe).
  //
  // Each control is wrong in exactly ONE dimension, and each is CALIBRATED: it must
  // still pass the cases it does not regress, so a control that fails everything —
  // which would make the assertions look strong for the wrong reason — is itself caught.

  /** The pre-fix wrapper: every non-signal failure collapsed into the generic channel. */
  function mislabellingControl({ code, output = '' }: { code: number | null; output?: string }) {
    const termination = detectCargoTermination(output);
    if (termination) {
      return {
        kind: 'killed-by-signal' as const,
        reason: `killed-by-signal:${termination.signalName}`,
        gating: true as const,
        message: `>>> cargo test suite was killed by ${termination.signalName} — not a compiler diagnostic.`,
      };
    }
    return {
      kind: 'failed' as const,
      reason: 'non-vitest',
      gating: true as const,
      message: `>>> cargo test suite exited with code ${code}`,
    };
  }

  /** The tempting "unstick the gate" edit: correctly labelled, wrongly forgiven. */
  function forgivingControl(input: { code: number | null; output?: string }) {
    const real = classifyAffectedCargoFailure(input);
    return { ...real, gating: real.kind === 'admission-refused' ? false : real.gating };
  }

  it('CONTROL: the pre-fix mislabelling is caught — and is still right about the cases it did not regress', () => {
    const refusal = mislabellingControl({ code: CARGO_DISK_REFUSAL_EXIT_CODE });
    // Caught: this is precisely what the admission-refusal case asserts must not happen.
    expect(refusal.reason).toBe('non-vitest');
    expect(refusal.kind).not.toBe('admission-refused');
    expect(refusal.message).toMatch(/exited with code/);
    expect(refusal.message).not.toContain('nothing to triage in papercusp-desktop');

    // Calibration — the control is wrong ONLY about the refusal. If these drifted, the
    // assertions above would be passing against a uniformly broken control instead of a
    // targeted one, and would prove nothing.
    expect(mislabellingControl({ code: 1 })).toMatchObject({ kind: 'failed', reason: 'non-vitest' });
    expect(mislabellingControl({ code: 101, output: SIGKILL_CARGO_OUTPUT })).toMatchObject({
      kind: 'killed-by-signal',
      reason: 'killed-by-signal:SIGKILL',
    });
  });

  it('CONTROL: a refusal dropped from the verdict is caught by the gating assertion', () => {
    // The dangerous direction — shipping unverified Rust because the suite "did not
    // really fail". The gating loop above is what stands in front of it.
    expect(forgivingControl({ code: CARGO_DISK_REFUSAL_EXIT_CODE }).gating).toBe(false);
    // Calibration: still gating on a real red, so the control is not simply inert.
    expect(forgivingControl({ code: 1 }).gating).toBe(true);
  });
});

// WI-10006749: on 2026-10-06 a reclaim under disk pressure deleted <target>/release whole,
// minutes after a build, and with it the test-artifact .deb archived inside it.
// papercusp-desktop/bin/build-and-archive-deb.sh now archives under
// <target>/.papercusp-deb-archive/<profile>/. This pins the other half of that contract: no
// reclaim candidate may ever contain that directory.
describe('deb archives survive a full reclaim of the Cargo target (WI-10006749)', () => {
  it('reclaims every stale profile but never <target>/.papercusp-deb-archive', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'papercusp-deb-archive-reclaim-'));
    const target = resolve(root, 'cargo-target');
    const archived = resolve(target, '.papercusp-deb-archive', 'release', 'archive', 'x-Papercusp Server.deb');
    const testArtifact = resolve(target, '.papercusp-deb-archive', 'release', 'test-artifacts', 'x-TEST-ARTIFACT-Papercusp Server.deb');
    // The old location, inside a candidate. Its deletion is the calibration that this reclaim
    // really had the authority to delete an archive left where the script used to put it.
    const oldLocation = resolve(target, 'release', 'bundle', 'deb', 'test-artifacts', 'old-TEST-ARTIFACT.deb');
    try {
      for (const f of [archived, testArtifact, oldLocation]) {
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, 'deb');
      }
      ensureCargoCacheTag(target);
      const old = (Date.now() - 60_000) / 1000;
      for (const d of [
        dirname(oldLocation),
        resolve(target, 'release', 'bundle', 'deb'),
        resolve(target, 'release', 'bundle'),
        resolve(target, 'release'),
        dirname(archived),
        dirname(testArtifact),
        resolve(target, '.papercusp-deb-archive', 'release'),
        resolve(target, '.papercusp-deb-archive'),
        target,
      ]) {
        utimesSync(d, old, old);
      }

      const result = reclaimInactiveCargoArtifacts({
        tmpDir: root,
        cargoRoots: [target],
        configuredTargetDir: target,
        now: Date.now(),
        policy: {
          ...DEFAULT_CARGO_RECLAIM_POLICY,
          cargoTtlMs: 1,
          heartbeatTtlMs: 1,
          minCargoArtifactBytes: 0,
          maxBytes: 1024 * 1024,
          maxEntries: 50,
        },
        pathIsLive: () => false,
        slotLockIsHeld: () => false,
      });

      expect(result.reclaimed).toBeGreaterThan(0);
      expect(existsSync(oldLocation)).toBe(false);
      expect(readFileSync(archived, 'utf8')).toBe('deb');
      expect(readFileSync(testArtifact, 'utf8')).toBe('deb');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('cargo rows record the MEASURED worktree, never the column default (WI-10006860)', () => {
  // test_runs.worktree_dirty is NOT NULL DEFAULT false, and spec freshness rates a run current
  // only when it is false. A reporter that omits the column claims every cargo run — an in-tree
  // mutant included — came from a clean tree.
  const SHA = 'a'.repeat(40);
  const clean = { commit: SHA, porcelain: '' };
  const provenanceOf = (before: unknown, after: unknown) =>
    cargoWorktreeProvenance({ before, after, describeDirt: describeWorktreeDirt });
  const detailsFor = (worktree: unknown) =>
    parseTestRunExecutionDetails(buildCargoExecutionDetails({
      root: '/repo', filePath: 'papercusp-desktop/src-tauri::tests::x', passed: 1, harnessSlug: 'papercusp',
      workspaceId: 'papercusp-workspace', env: {}, ...(worktree === undefined ? {} : { worktree }),
    }));

  it('a clean, unmoved tree is recorded clean with its commit, and still parses under the strict contract', () => {
    const worktree = provenanceOf(clean, clean);
    expect(worktree).toEqual({ commitSha: SHA, worktreeDirty: false, worktreeDirtyReason: null });
    const details = detailsFor(worktree);
    expect(details).not.toBeNull();
    expect(details?.worktreeDirty).toBe(false);
    expect(details?.commitSha).toBe(SHA);
    expect(details?.worktreeDirtyReason).toBeUndefined();
  });

  it.each([
    ['an uncommitted file', clean, { commit: SHA, porcelain: ' M papercusp-desktop/src-tauri/src/main.rs' }, /porcelain line/],
    ['a moved HEAD', clean, { commit: 'b'.repeat(40), porcelain: '' }, /HEAD moved/],
    ['an unreadable git status', clean, { commit: SHA, porcelain: null }, /unreadable/],
    ['an unreadable HEAD', { commit: null, porcelain: '' }, clean, /HEAD unreadable/],
  ])('%s is recorded dirty with the reason the vitest reporter would name', (_label, before, after, reason) => {
    const worktree = provenanceOf(before, after);
    expect(worktree.worktreeDirty).toBe(true);
    expect(worktree.worktreeDirtyReason).toMatch(reason);
    const details = detailsFor(worktree);
    expect(details?.worktreeDirty).toBe(true);
    expect(details?.worktreeDirtyReason).toMatch(reason);
  });

  it('a missing snapshot, describer, or throwing describer is dirty, never clean', () => {
    expect(cargoWorktreeProvenance({ before: null, after: clean, describeDirt: describeWorktreeDirt })).toEqual(UNMEASURED_CARGO_WORKTREE);
    expect(cargoWorktreeProvenance({ before: clean, after: clean, describeDirt: undefined })).toEqual(UNMEASURED_CARGO_WORKTREE);
    const thrown = cargoWorktreeProvenance({ before: clean, after: clean, describeDirt: () => { throw new Error('boom'); } });
    expect(thrown.worktreeDirty).toBe(true);
    expect(thrown.worktreeDirtyReason).toMatch(/boom/);
    expect(detailsFor(undefined)?.worktreeDirty).toBe(true);
  });

  it('the reporter snapshots around the cargo spawn and INSERTs commit_sha and worktree_dirty from it', () => {
    const insert = REPORTER_SOURCE.slice(REPORTER_SOURCE.indexOf('INSERT INTO harness_shared.test_runs'));
    const columns = insert.slice(0, insert.indexOf('VALUES'));
    expect(columns).toMatch(/\bcommit_sha\b/);
    expect(columns).toMatch(/\bworktree_dirty\b/);
    expect(insert).toMatch(/\$\{worktree\.commitSha\}, \$\{worktree\.worktreeDirty\}/);
    const before = REPORTER_SOURCE.indexOf('const worktreeBefore = await snapshotWorktree(');
    const spawnCall = REPORTER_SOURCE.indexOf('await runCargoTest(manifestAbs');
    const provenance = REPORTER_SOURCE.indexOf('cargoWorktreeProvenance({', spawnCall);
    expect(before).toBeGreaterThan(-1);
    expect(spawnCall).toBeGreaterThan(before);
    expect(provenance).toBeGreaterThan(spawnCall);
    expect(REPORTER_SOURCE).toMatch(/tsImport\('\.\.\/libs\/test-config\/src\/admin-test-runs-reporter\.ts', import\.meta\.url\)/);
  });
});
