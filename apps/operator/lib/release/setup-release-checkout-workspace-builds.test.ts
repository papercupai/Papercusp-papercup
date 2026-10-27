/**
 * EI-20453835015280838 — release checkouts must materialize runtime outputs
 * from the exact pinned workspace source before the operator boot preflight.
 *
 * The failure that earned this guard is subtle: @papercusp/sse is a submodule,
 * its dist/ is gitignored, ESM/typecheck consumers load src/, and CommonJS boot
 * consumers load dist/. A developer tree therefore looks healthy while the
 * isolated release tree (correctly cleaned + cloned at its pin) lacks the only
 * files the real boot path can require.
 *
 * This suite locks both halves of the durable fix:
 *   1. the shipped shell block builds from RELEASE_ROOT (never copies a newer
 *      integration-tree artifact across the submodule pin), and
 *   2. a repository-wide detector requires every workspace package that
 *      declares a gitignored bin/main/require/default target to appear in the
 *      block's explicit registry, and
 *   3. the desktop sidecar rebuilds the same registry after its scoped npm
 *      install, which can erase generated outputs behind intact symlinks.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  extractRegisteredRuntimeBuildWorkspaces,
  listIgnoredRuntimeEntryWorkspaces,
} from './runtime-workspace-build-coverage';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../..');
const SCRIPT_PATH = resolve(HERE, '../../bin/release/setup-release-checkout.sh');
const SCRIPT = readFileSync(SCRIPT_PATH, 'utf8');
const SIDECAR_SCRIPT_PATH = resolve(REPO_ROOT, 'papercusp-desktop/bin/build-desktop-sidecar.sh');
const SIDECAR_SCRIPT = readFileSync(SIDECAR_SCRIPT_PATH, 'utf8');

function extractRuntimeBuildBlock(): string {
  const lines = SCRIPT.split('\n');
  const start = lines.findIndex((line) => /^# 3c-2\. Pinned workspace RUNTIME BUILDS/.test(line));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const endRel = rest.findIndex((line) => /^# \d+[a-z]?(-\d+)?\. /.test(line));
  return lines.slice(start, endRel === -1 ? undefined : start + 1 + endRel).join('\n');
}

const REGISTRY = SCRIPT.match(/RUNTIME_BUILD_WORKSPACES=\([\s\S]*?\n\)/)?.[0] ?? '';
const BLOCK = `${REGISTRY}\n${extractRuntimeBuildBlock()}`;
const DEPENDENCY_CLOSURE = SCRIPT.match(
  /# RUNTIME DEPENDENCY CLOSURE\n([\s\S]*?)# END RUNTIME DEPENDENCY CLOSURE/,
)?.[1] ?? '';

function extractSidecarPostInstallRuntimeBuildBlock(): string {
  return SIDECAR_SCRIPT.match(
    /# RUNTIME WORKSPACE DEPENDENCIES[^\n]*\n([\s\S]*?)# END POST-INSTALL RUNTIME BUILDS/,
  )?.[1] ?? '';
}

const SIDECAR_POST_INSTALL_BLOCK = extractSidecarPostInstallRuntimeBuildBlock();

describe('setup-release-checkout pinned workspace runtime builds', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('enrolls registered local toolchains in selected captures and rejects incomplete pins before copying', () => {
    expect(DEPENDENCY_CLOSURE, 'runtime dependency capture closure is missing').not.toBe('');
    const root = mkdtempSync(join(tmpdir(), 'runtime-dependency-closure-'));
    tempRoots.push(root);
    const integrationRoot = join(root, 'integration');
    const generation = join(root, 'generation');
    const capture = join(root, 'capture');
    const scope = join(integrationRoot, 'node_modules/@papercusp');
    mkdirSync(scope, { recursive: true });
    for (const [name, path] of [['omp', 'packages/omp-plugin'], ['sse', 'libs/generic/sse']]) {
      mkdirSync(join(integrationRoot, path, 'node_modules'), { recursive: true });
      symlinkSync(join(integrationRoot, path), join(scope, name));
    }
    const runner = [
      'set -euo pipefail',
      `INTEGRATION_ROOT=${JSON.stringify(integrationRoot)}`,
      `DEPENDENCY_GENERATION_TREE=${JSON.stringify(generation)}`,
      'PINNED_DEPENDENCY_GENERATION_ID=fixture-generation',
      REGISTRY,
      DEPENDENCY_CLOSURE,
      `dependency_generation_configure_workspace_dirs() { printf '%s\\n' "$@" > ${JSON.stringify(capture)}; }`,
      'NODE_MODULES_WORKSPACE_DIRS=(papercusp-desktop)',
      'configure_release_dependency_workspace_dirs',
      'validate_runtime_dependency_toolchains',
    ].join('\n');
    const missing = spawnSync('bash', ['-c', runner], { encoding: 'utf8' });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('missing the package-local toolchain');
    expect(readFileSync(capture, 'utf8').trim().split('\n')).toEqual([
      integrationRoot, 'papercusp-desktop', 'packages/omp-plugin', 'libs/generic/sse',
    ]);
    for (const path of ['packages/omp-plugin', 'libs/generic/sse']) {
      mkdirSync(join(generation, path, 'node_modules'), { recursive: true });
    }
    expect(spawnSync('bash', ['-c', runner], { encoding: 'utf8' }).status).toBe(0);
    const full = runner.replace('NODE_MODULES_WORKSPACE_DIRS=(papercusp-desktop)', 'NODE_MODULES_WORKSPACE_DIRS=()');
    expect(spawnSync('bash', ['-c', full], { encoding: 'utf8' }).status).toBe(0);
    expect(readFileSync(capture, 'utf8').trim()).toBe(integrationRoot);
    expect(SCRIPT.indexOf('    validate_runtime_dependency_toolchains\n'))
      .toBeLessThan(SCRIPT.indexOf('  if pinned_dependency_generation_reuse_safe; then'));
  });

  it('builds registered runtime workspaces from pinned source, never integration output', () => {
    expect(BLOCK, 'the pinned workspace runtime-build block is missing').not.toBe('');

    const root = mkdtempSync(join(tmpdir(), 'setup-runtime-build-'));
    tempRoots.push(root);
    const releaseRoot = join(root, 'release');
    const integrationRoot = join(root, 'integration');
    const packageRoot = join(releaseRoot, 'libs/generic/sse');
    const integrationPackageRoot = join(integrationRoot, 'libs/generic/sse');
    const integrationDist = join(integrationRoot, 'libs/generic/sse/dist');
    const ompRoot = join(releaseRoot, 'packages/omp-plugin');
    const integrationOmpRoot = join(integrationRoot, 'packages/omp-plugin');
    const integrationOmpDist = join(integrationOmpRoot, 'dist');
    const fakeBin = join(root, 'bin');
    const trace = join(root, 'npm-trace');

    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(join(releaseRoot, 'node_modules/@papercusp'), { recursive: true });
    mkdirSync(join(integrationRoot, 'node_modules/@papercusp'), { recursive: true });
    mkdirSync(join(integrationPackageRoot, 'node_modules'), { recursive: true });
    mkdirSync(integrationDist, { recursive: true });
    mkdirSync(ompRoot, { recursive: true });
    mkdirSync(join(integrationOmpRoot, 'node_modules'), { recursive: true });
    mkdirSync(integrationOmpDist, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@papercusp/sse' }));
    writeFileSync(join(packageRoot, 'PINNED_SOURCE'), 'pinned');
    writeFileSync(join(ompRoot, 'package.json'), JSON.stringify({ name: '@papercusp/omp' }));
    writeFileSync(join(ompRoot, 'PINNED_SOURCE'), 'pinned');
    writeFileSync(join(integrationPackageRoot, 'node_modules/PINNED_TOOLCHAIN'), 'typescript-5.9');
    writeFileSync(join(integrationOmpRoot, 'node_modules/PINNED_TOOLCHAIN'), 'esbuild-pinned');
    writeFileSync(join(integrationDist, 'index.js'), 'wrong-newer-integration-output');
    writeFileSync(join(integrationOmpDist, 'native-client.cjs'), 'wrong-newer-integration-output');
    symlinkSync('../../libs/generic/sse', join(releaseRoot, 'node_modules/@papercusp/sse'));
    symlinkSync('../../libs/generic/sse', join(integrationRoot, 'node_modules/@papercusp/sse'));
    symlinkSync('../../packages/omp-plugin', join(releaseRoot, 'node_modules/@papercusp/omp'));
    symlinkSync('../../packages/omp-plugin', join(integrationRoot, 'node_modules/@papercusp/omp'));

    const fakeNpm = join(fakeBin, 'npm');
    writeFileSync(
      fakeNpm,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'case "$*" in',
        '  "--workspace @papercusp/omp pkg get name"|"--workspace @papercusp/sse pkg get name") exit 0 ;;',
        '  "--workspace @papercusp/omp run build")',
        '    printf "%s|%s\\n" "$PWD" "$*" >> "$NPM_TRACE"',
        '    test -f "$PWD/packages/omp-plugin/node_modules/PINNED_TOOLCHAIN"',
        '    mkdir -p "$PWD/packages/omp-plugin/dist"',
        '    printf "native-from-%s\\n" "$(cat "$PWD/packages/omp-plugin/PINNED_SOURCE")" > "$PWD/packages/omp-plugin/dist/native-client.cjs"',
        '    printf "extension-from-%s\\n" "$(cat "$PWD/packages/omp-plugin/PINNED_SOURCE")" > "$PWD/packages/omp-plugin/dist/native-extension.mjs"',
        '    printf "cli-from-%s\\n" "$(cat "$PWD/packages/omp-plugin/PINNED_SOURCE")" > "$PWD/packages/omp-plugin/dist/cli.js"',
        '    ;;',
        '  "--workspace @papercusp/sse run build")',
        '    printf "%s|%s\\n" "$PWD" "$*" >> "$NPM_TRACE"',
        '    test -f "$PWD/libs/generic/sse/node_modules/PINNED_TOOLCHAIN"',
        '    mkdir -p "$PWD/libs/generic/sse/dist"',
        '    printf "built-from-%s\\n" "$(cat "$PWD/libs/generic/sse/PINNED_SOURCE")" > "$PWD/libs/generic/sse/dist/index.js"',
        '    ;;',
        '  *) echo "unexpected fake npm invocation: $*" >&2; exit 1 ;;',
        'esac',
      ].join('\n'),
    );
    chmodSync(fakeNpm, 0o755);

    const runner = join(root, 'run.sh');
    writeFileSync(
      runner,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'log() { echo "[log] $*"; }',
        'sync_one_node_modules() { mkdir -p "$2"; cp -a "$1/." "$2/"; }',
        `RELEASE_ROOT=${JSON.stringify(releaseRoot)}`,
        `INTEGRATION_ROOT=${JSON.stringify(integrationRoot)}`,
        'TARGET_SHA=0123456789abcdef',
        BLOCK,
      ].join('\n'),
    );

    const run = spawnSync('bash', [runner], {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}`, NPM_TRACE: trace },
      encoding: 'utf8',
    });
    expect(run.status, run.stderr).toBe(0);
    expect(readFileSync(trace, 'utf8').trim().split('\n')).toEqual([
      `${releaseRoot}|--workspace @papercusp/omp run build`,
      `${releaseRoot}|--workspace @papercusp/sse run build`,
    ]);
    expect(readFileSync(join(packageRoot, 'node_modules/PINNED_TOOLCHAIN'), 'utf8')).toBe('typescript-5.9');
    expect(readFileSync(join(packageRoot, 'dist/index.js'), 'utf8')).toBe('built-from-pinned\n');
    expect(readFileSync(join(ompRoot, 'dist/native-client.cjs'), 'utf8')).toBe('native-from-pinned\n');
    expect(readFileSync(join(ompRoot, 'dist/native-extension.mjs'), 'utf8')).toBe('extension-from-pinned\n');
    expect(readFileSync(join(ompRoot, 'dist/cli.js'), 'utf8')).toBe('cli-from-pinned\n');
    expect(readFileSync(join(integrationDist, 'index.js'), 'utf8')).toBe('wrong-newer-integration-output');
    expect(BLOCK).not.toContain('run build 1>/dev/null');
  });

  it('covers every workspace package whose declared runtime entry is gitignored', () => {
    const registered = extractRegisteredRuntimeBuildWorkspaces(BLOCK);
    const ignoredEntries = listIgnoredRuntimeEntryWorkspaces(REPO_ROOT);
    expect(ignoredEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: '@papercusp/omp',
          target: 'dist/cli.js',
        }),
      ]),
    );
    const uncovered = ignoredEntries
      .filter(({ name }) => !registered.has(name));
    expect(
      uncovered,
      'A workspace package exposes a gitignored bin/main/require/default entry but the release setup does not ' +
        'build it from pinned source. Add its package name to RUNTIME_BUILD_WORKSPACES; copying integration ' +
        'dist would violate submodule pin isolation.',
    ).toEqual([]);
    expect(registered).toContain('@papercusp/omp');
  });

  it('rebuilds every ignored runtime entry after the desktop scoped install', () => {
    expect(
      SIDECAR_POST_INSTALL_BLOCK,
      'the desktop post-install runtime-build block is missing',
    ).not.toBe('');

    const installIndex = Math.max(
      SIDECAR_SCRIPT.indexOf('node scripts/npm-install-safe.mjs install'),
      SIDECAR_SCRIPT.indexOf('npm install --legacy-peer-deps'),
    );
    const blockIndex = SIDECAR_SCRIPT.indexOf('# POST-INSTALL RUNTIME BUILDS');
    const resolutionGuardIndex = SIDECAR_SCRIPT.indexOf('echo "→ verifying workspace deps resolved"');
    expect(installIndex).toBeGreaterThan(-1);
    expect(blockIndex).toBeGreaterThan(installIndex);
    expect(resolutionGuardIndex).toBeGreaterThan(blockIndex);

    const registered = extractRegisteredRuntimeBuildWorkspaces(SIDECAR_POST_INSTALL_BLOCK);
    expect(registered).toContain('@papercusp/omp');
    const uncovered = listIgnoredRuntimeEntryWorkspaces(REPO_ROOT)
      .filter(({ name }) => !registered.has(name));
    expect(
      uncovered,
      'A workspace package exposes a gitignored runtime entry but the desktop sidecar does not rebuild it ' +
        'after its scoped install. Add it to the post-install RUNTIME_BUILD_WORKSPACES registry.',
    ).toEqual([]);

    const root = mkdtempSync(join(tmpdir(), 'sidecar-post-install-runtime-build-'));
    tempRoots.push(root);
    const fakeBin = join(root, 'bin');
    const packageRoot = join(root, 'libs/generic/sse');
    const ompRoot = join(root, 'packages/omp-plugin');
    const trace = join(root, 'npm-trace');
    const readerMarker = join(root, 'reader-active');
    const leaseTrace = join(root, 'lease-trace');
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(ompRoot, { recursive: true });
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(
      join(root, 'scripts/npm-install-safe.mjs'),
      [
        "#!/usr/bin/env node",
        "import { spawnSync } from 'node:child_process';",
        "import { existsSync, writeFileSync, unlinkSync, appendFileSync } from 'node:fs';",
        "const args = process.argv.slice(2);",
        "let result;",
        "if (args[0] === '--repo-root') {",
        "  if (args[1] !== process.cwd()) throw new Error('reader uses wrong repository');",
        "  args.splice(0, 2);",
        "}",
        "if (args[0] === '--exec-under-lock') {",
        "  if (args[1] !== '--') throw new Error('reader command separator missing');",
        "  writeFileSync(process.env.RUNTIME_READER_MARKER, 'read');",
        "  appendFileSync(process.env.RUNTIME_LEASE_TRACE, 'reader:start\\n');",
        "  try { result = spawnSync(args[2], args.slice(3), { stdio: 'inherit' }); }",
        "  finally { unlinkSync(process.env.RUNTIME_READER_MARKER); appendFileSync(process.env.RUNTIME_LEASE_TRACE, 'reader:end\\n'); }",
        "} else {",
        "  if (existsSync(process.env.RUNTIME_READER_MARKER)) throw new Error('writer attempted during prepared runtime builds');",
        "  result = spawnSync('npm', args, { stdio: 'inherit' });",
        "}",
        'process.exit(result.status ?? 1);',
      ].join('\n'),
    );
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@papercusp/sse',
        devDependencies: { typescript: '~6.0.0' },
      }),
    );
    writeFileSync(
      join(ompRoot, 'package.json'),
      JSON.stringify({
        name: '@papercusp/omp',
        devDependencies: { esbuild: '^0.27.3' },
      }),
    );

    const fakeNpm = join(fakeBin, 'npm');
    writeFileSync(
      fakeNpm,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'trace_npm() { printf "%s|%s\\n" "$PWD" "$(printf "%s" "$1" | tr "\\n" " ")" >> "$NPM_TRACE"; }',
        'case "$*" in',
        '  "install --legacy-peer-deps --no-audit --no-fund --ignore-scripts --include=dev --workspace=@papercusp/web --workspace=@papercusp/operator-vite --workspace=@papercusp/omp --workspace=@papercusp/sse")',
        '    trace_npm "$*"',
        '    test ! -e "$RUNTIME_READER_MARKER"',
        '    mkdir -p "$PWD/libs/generic/sse/node_modules/typescript"',
        '    printf "typescript-6.0.3\\n" > "$PWD/libs/generic/sse/node_modules/PINNED_TOOLCHAIN"',
        '    printf \'{"version":"6.0.3"}\\n\' > "$PWD/libs/generic/sse/node_modules/typescript/package.json"',
        '    ;;',
        '  "--workspace=@papercusp/omp exec -- node -e "*)',
        '    trace_npm "$*"',
        '    test -f "$RUNTIME_READER_MARKER"',
        '    test -f "$PWD/libs/generic/sse/node_modules/PINNED_TOOLCHAIN"',
        '    printf "  ✓ @papercusp/omp: build command owns toolchain validation\\n"',
        '    ;;',
        '  "--workspace @papercusp/omp run build")',
        '    trace_npm "$*"',
        '    test -f "$RUNTIME_READER_MARKER"',
        '    [ "${FAIL_RUNTIME_BUILD:-0}" != 1 ] || exit 9',
        '    mkdir -p "$PWD/packages/omp-plugin/dist"',
        '    printf "rebuilt-native\\n" > "$PWD/packages/omp-plugin/dist/native-client.cjs"',
        '    printf "rebuilt-extension\\n" > "$PWD/packages/omp-plugin/dist/native-extension.mjs"',
        '    printf "rebuilt-cli\\n" > "$PWD/packages/omp-plugin/dist/cli.js"',
        '    ;;',
        '  "--workspace=@papercusp/sse exec -- node -e "*)',
        '    trace_npm "$*"',
        '    test -f "$RUNTIME_READER_MARKER"',
        '    printf "  ✓ @papercusp/sse: TypeScript 6.0.3 satisfies ~6.0.0\\n"',
        '    ;;',
        '  "--workspace @papercusp/sse run build")',
        '    trace_npm "$*"',
        '    test -f "$RUNTIME_READER_MARKER"',
        '    mkdir -p "$PWD/libs/generic/sse/dist"',
        '    printf "rebuilt-after-install\\n" > "$PWD/libs/generic/sse/dist/index.js"',
        '    ;;',
        '  *) echo "unexpected fake npm invocation: $*" >&2; exit 1 ;;',
        'esac',
      ].join('\n'),
    );
    chmodSync(fakeNpm, 0o755);

    const runner = join(root, 'run.sh');
    writeFileSync(
      runner,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'REPO_ROOT="$TEST_RUNTIME_REPO_ROOT"',
        // The block also carries two REAL-REPO environment probes that a fake REPO_ROOT cannot
        // satisfy and that are not this test's subject (the npm trace of the runtime builds):
        //   - the Playwright runtime preflight (EI-25537398622311917): sources the REAL
        //     bundle-host-common.sh — kept real, so its NATIVE_PKGS contract is still exercised —
        //     then probes playwright-core via `node --input-type=module - "$REPO_ROOT"`;
        //   - prepare_vite_native_toolchain: `node --input-type=module -e '…' "$REPO_ROOT"`, which
        //     takes the repo fs-mutex and resolves vite/rolldown from the real install.
        // Stub ONLY the `--input-type=module` form both use; plain `node` calls still run for real.
        'WEB_DIR="$TEST_REAL_WEB_DIR"',
        'node() { if [[ "${1:-}" == --input-type=module ]]; then [[ "${2:-}" == - ]] && cat >/dev/null; return 0; fi; command node "$@"; }',
        'run_sidecar_cached_package() { "$@"; }',
        SIDECAR_POST_INSTALL_BLOCK,
      ].join('\n'),
    );

    const run = spawnSync('bash', [runner], {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}`, NPM_TRACE: trace,
        TEST_RUNTIME_REPO_ROOT: root, TEST_REAL_WEB_DIR: resolve(REPO_ROOT, 'apps/operator'),
        RUNTIME_READER_MARKER: readerMarker, RUNTIME_LEASE_TRACE: leaseTrace },
      encoding: 'utf8',
    });
    expect(run.status, run.stderr).toBe(0);
    const traceLines = readFileSync(trace, 'utf8').trim().split('\n');
    expect(traceLines).toHaveLength(5);
    expect(traceLines[0]).toBe(
      `${root}|install --legacy-peer-deps --no-audit --no-fund --ignore-scripts --include=dev --workspace=@papercusp/web --workspace=@papercusp/operator-vite --workspace=@papercusp/omp --workspace=@papercusp/sse`,
    );
    expect(traceLines[1]).toContain(`${root}|--workspace=@papercusp/omp exec -- node -e `);
    expect(traceLines[2]).toBe(`${root}|--workspace @papercusp/omp run build`);
    expect(traceLines[3]).toContain(`${root}|--workspace=@papercusp/sse exec -- node -e `);
    expect(traceLines[4]).toBe(`${root}|--workspace @papercusp/sse run build`);
    expect(readFileSync(leaseTrace, 'utf8').trim().split('\n')).toEqual(['reader:start', 'reader:end']);
    expect(existsSync(readerMarker)).toBe(false);
    expect(readFileSync(join(packageRoot, 'node_modules/PINNED_TOOLCHAIN'), 'utf8')).toBe(
      'typescript-6.0.3\n',
    );
    expect(readFileSync(join(packageRoot, 'dist/index.js'), 'utf8')).toBe(
      'rebuilt-after-install\n',
    );
    expect(readFileSync(join(ompRoot, 'dist/native-client.cjs'), 'utf8')).toBe('rebuilt-native\n');
    expect(readFileSync(join(ompRoot, 'dist/native-extension.mjs'), 'utf8')).toBe('rebuilt-extension\n');
    expect(readFileSync(join(ompRoot, 'dist/cli.js'), 'utf8')).toBe('rebuilt-cli\n');

    // A compiler failure must unwind the reader and propagate, without a
    // dependency reify/retry that would try to upgrade the held reader.
    writeFileSync(trace, '');
    writeFileSync(leaseTrace, '');
    const failed = spawnSync('bash', [runner], {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ''}`, NPM_TRACE: trace,
        TEST_RUNTIME_REPO_ROOT: root, TEST_REAL_WEB_DIR: resolve(REPO_ROOT, 'apps/operator'),
        RUNTIME_READER_MARKER: readerMarker, RUNTIME_LEASE_TRACE: leaseTrace, FAIL_RUNTIME_BUILD: '1' },
      encoding: 'utf8',
    });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('prepared runtime workspace build failed for @papercusp/omp');
    expect(readFileSync(trace, 'utf8').split('\n').filter(line => line.includes('|install '))).toHaveLength(1);
    expect(readFileSync(leaseTrace, 'utf8').trim().split('\n')).toEqual(['reader:start', 'reader:end']);
    expect(existsSync(readerMarker)).toBe(false);
  });

  it('skips a package present before an older rollback pin registered it as a workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'setup-runtime-build-old-pin-'));
    tempRoots.push(root);
    const releaseRoot = join(root, 'release');
    const packageRoot = join(releaseRoot, 'libs/generic/sse');
    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(join(releaseRoot, 'node_modules/@papercusp'), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@papercusp/sse' }));
    symlinkSync('../../libs/generic/sse', join(releaseRoot, 'node_modules/@papercusp/sse'));
    const runner = join(root, 'run.sh');
    writeFileSync(
      runner,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'log() { echo "[log] $*"; }',
        `RELEASE_ROOT=${JSON.stringify(releaseRoot)}`,
        'TARGET_SHA=0123456789abcdef',
        BLOCK,
      ].join('\n'),
    );

    const run = spawnSync('bash', [runner], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('is not registered at 0123456789');
    expect(existsSync(join(releaseRoot, 'libs/generic/sse/dist'))).toBe(false);
  });
});
