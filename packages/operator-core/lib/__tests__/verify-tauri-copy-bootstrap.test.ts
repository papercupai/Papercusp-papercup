import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repo = resolve(import.meta.dirname, '../../../..');
const source = readFileSync(process.env.VERIFY_TAURI_SOURCE_PATH || join(repo, 'scripts/verify-tauri-headless.sh'), 'utf8');
const copyFunction = source.match(/^snapshot_verifier_pinned_deps\(\) \{[\s\S]*?^\}/m)?.[0];
if (!copyFunction) throw new Error('Native dependency-copy admission not found');
let stage: string;

beforeAll(() => {
  stage = mkdtempSync(join(tmpdir(), 'tauri-copy-bootstrap-'));
  mkdirSync(join(stage, 'scripts'), { recursive: true });
  // Preserve the production source graph, but install no packages. This
  // catches an accidental scheduler/toolchain import before dependency copy.
  cpSync(join(repo, 'scripts/lib'), join(stage, 'scripts/lib'), { recursive: true });
  cpSync(join(repo, 'scripts/check-vitest-config-enrollment.mjs'), join(stage, 'scripts/check-vitest-config-enrollment.mjs'));
  writeFileSync(join(stage, 'cgroup-fixture.mjs'), [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    'const original = fs.readFileSync;',
    'fs.readFileSync = (path, ...args) => {',
    "  if (String(path) === '/proc/self/cgroup') return '0::/fixture.scope\\n';",
    "  if (String(path) === '/sys/fs/cgroup/fixture.scope/memory.max') {",
    "    if (process.env.FIXTURE_MEMORY === 'unreadable') throw new Error('unreadable fixture');",
    '    return process.env.FIXTURE_MEMORY;',
    '  }',
    '  return original(path, ...args);',
    '};',
    'syncBuiltinESMExports();',
  ].join('\n'));
});
afterAll(() => { if (stage) rmSync(stage, { recursive: true, force: true }); });

function probe(memory: string) {
  const env = { ...process.env, NODE_OPTIONS: '--import=' + join(stage, 'cgroup-fixture.mjs'),
    NODE_PATH: '', STAGED_ROOT: stage, WORK: join(stage, 'work'), REPO_DIR: repo,
    VERIFY_TAURI_DEPENDENCY_SNAPSHOT_MODE: 'copy', FIXTURE_MEMORY: memory };
  return spawnSync('bash', ['-c', [
    'set -euo pipefail',
    // Only the actual payload copy is replaced. The production Node import,
    // memory measurement, rejection and shell return path all execute.
    'bash() { echo COPY_FIXTURE_ALLOCATED; }',
    copyFunction!,
    'snapshot_verifier_pinned_deps "$STAGED_ROOT" "$STAGED_ROOT/papercusp-desktop/bin/lib/pinned-deps.sh"',
  ].join('\n')], { cwd: stage, env, encoding: 'utf8', timeout: 10_000 });
}

describe('native dependency-copy bootstrap before node_modules', () => {
  it('measures a finite task limit before admitting the copy without installed packages', () => {
    const result = probe(String(8 * 1024 * 1024 * 1024));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('VERIFY_TAURI_COPY_MEMORY_MAX_MB=8192');
    expect(result.stdout).toContain('COPY_FIXTURE_ALLOCATED');
  });

  it.each(['max', 'unreadable'])('refuses %s limits before allocating a copy', memory => {
    const result = probe(memory);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('VERIFY_TAURI_COPY_MEMORY_UNBOUNDED');
    expect(result.stdout).not.toContain('COPY_FIXTURE_ALLOCATED');
  });
});
