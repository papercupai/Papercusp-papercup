// WI-10004062 — the physical drill's TOWER producer must run a pinned commit,
// never the shared working tree.
//
// The VM always ran an immutable git-archive snapshot, but the tower ran
// physical-drill-producer.ts (and its whole import closure) straight out of the
// shared tree that parallel builders edit. A peer's mid-run edit aborted one rig
// run, and an uncommitted edit refused the next before any phase (2026-09-30,
// WI-10004055 retries #1 and #2). hive-git-physical-probe.sh now resolves ONE
// commit, extracts it into a run-private tower snapshot, and the scenario is
// handed that snapshot. These tests EXECUTE the probe's real PINNED-SOURCE block
// against a fixture repository whose working tree is dirty, and pin the ordering
// that keeps every tower producer call on the snapshot.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, 'papercusp-desktop', 'bin', 'hive-git-drill.sh'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('could not locate papercusp-desktop/bin/hive-git-drill.sh');
}

const vmRig = join(repoRoot(), 'papercusp-desktop', 'bin', 'vm-rig');
const probe = readFileSync(join(vmRig, 'hive-git-physical-probe.sh'), 'utf8');
const scenario = readFileSync(join(vmRig, 'hive-git-physical-scenario.sh'), 'utf8');
const PRODUCER_REL = 'packages/operator-core/lib/sync/pot-git/physical-drill-producer.ts';

function pinnedSourceBlock(): string {
  const start = probe.indexOf('run_source_overlay_js() {');
  const end = probe.indexOf('# PINNED-SOURCE-END');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return probe.slice(start, end);
}

const scratch = mkdtempSync(join(tmpdir(), 'hive-git-pinned-source-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

/** A superproject + one libs/ submodule repo, committed, then dirtied. */
function buildFixture(): string {
  const root = join(scratch, 'repo');
  write(join(root, 'package.json'), JSON.stringify({ name: 'fixture', workspaces: ['packages/*', 'libs/*'] }));
  write(join(root, 'tsconfig.base.json'), '{}\n');
  write(join(root, 'scripts', 'noop.sh'), '#!/bin/sh\n');
  write(join(root, 'libs', 'README.md'), 'libs\n');
  write(
    join(root, 'packages', 'operator-core', 'package.json'),
    JSON.stringify({ name: '@papercusp/operator-core', dependencies: { '@papercusp/fixture-sub': '*' } }),
  );
  write(join(root, PRODUCER_REL), '// COMMITTED-PRODUCER-BYTES\n');
  write(join(root, '.gitmodules'), '[submodule "libs/fixture-sub"]\n\tpath = libs/fixture-sub\n\turl = ./fixture-sub\n');
  // Installed dependency trees: a hoisted third-party module and a package-local
  // (non-hoisted) one the snapshot must mirror instead of resolving upward.
  write(join(root, 'node_modules', 'hoisted-dep', 'index.js'), 'module.exports = 1;\n');
  write(join(root, 'packages', 'operator-core', 'node_modules', '@scope', 'pinned', 'index.js'), 'module.exports = 2;\n');
  git(root, 'init', '-q');
  git(root, 'add', 'package.json', 'tsconfig.base.json', 'scripts', 'libs/README.md', 'packages/operator-core/package.json', PRODUCER_REL, '.gitmodules');
  git(root, 'commit', '-qm', 'fixture');

  const sub = join(root, 'libs', 'fixture-sub');
  write(join(sub, 'package.json'), JSON.stringify({ name: '@papercusp/fixture-sub' }));
  write(join(sub, 'index.ts'), 'export const committed = true;\n');
  git(sub, 'init', '-q');
  git(sub, 'add', '.');
  git(sub, 'commit', '-qm', 'sub');
  git(root, 'add', 'libs/fixture-sub');
  git(root, 'commit', '-qm', 'pin fixture submodule');

  // The failure this fix removes: an uncommitted edit in the shared tree.
  write(join(root, PRODUCER_REL), '// UNCOMMITTED-PEER-EDIT\n');
  write(join(sub, 'index.ts'), 'export const committed = false;\n');
  return root;
}

describe('hive-git-physical-probe.sh — the tower producer runs a pinned commit (WI-10004062)', () => {
  it('stages the committed bytes, not the dirty working tree, with a complete dependency overlay', () => {
    const root = buildFixture();
    const tmp = join(scratch, 'tmp');
    mkdirSync(tmp, { recursive: true });
    const harness = [
      'set -euo pipefail',
      `REPO_ROOT='${root}'`,
      'local_source_out=""',
      'fail() { printf "FAIL: %s\\n" "$*" >&2; exit 1; }',
      pinnedSourceBlock(),
      'printf "PRODUCER=%s\\n" "$PRODUCER"',
      'printf "BYTES=%s\\n" "$(cat "$PRODUCER")"',
      'printf "SUB=%s\\n" "$(cat "$tower_source/libs/fixture-sub/index.ts")"',
      'printf "WS_LINK=%s\\n" "$(readlink -f "$tower_source/node_modules/@papercusp/fixture-sub")"',
      'printf "NESTED_LINK=%s\\n" "$(readlink "$tower_source/packages/operator-core/node_modules/@scope/pinned")"',
      'printf "HOISTED_LINK=%s\\n" "$(readlink "$tower_source/node_modules/hoisted-dep")"',
      'printf "REPO_DIR=%s\\n" "$PAPERCUSP_REPO_DIR"',
      'printf "TOWER_SOURCE=%s\\n" "$tower_source"',
      // Resolved here, while the snapshot exists: the exit trap removes it before the assertions run.
      'printf "TOWER_SOURCE_REAL=%s\\n" "$(readlink -f "$tower_source")"',
      'printf "SHA=%s\\n" "$source_sha"',
    ].join('\n');
    const run = spawnSync('bash', ['-c', harness], { encoding: 'utf8', env: { ...process.env, TMPDIR: tmp } });
    expect(run.stderr).not.toContain('FAIL:');
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
    const out = Object.fromEntries(
      run.stdout.trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    const towerSource = out.TOWER_SOURCE;

    expect(out.BYTES).toBe('// COMMITTED-PRODUCER-BYTES');
    expect(out.SUB).toBe('export const committed = true;');
    expect(out.PRODUCER).toBe(join(towerSource, PRODUCER_REL));
    expect(out.PRODUCER.startsWith(`${root}/`)).toBe(false);
    expect(out.SHA).toBe(git(root, 'rev-parse', 'HEAD').trim());
    // Workspace imports resolve INTO the snapshot; third-party ones into the install.
    expect(out.WS_LINK).toBe(join(out.TOWER_SOURCE_REAL, 'libs', 'fixture-sub'));
    expect(out.HOISTED_LINK).toBe(join(root, 'node_modules', 'hoisted-dep'));
    expect(out.NESTED_LINK).toBe(join(root, 'packages', 'operator-core', 'node_modules', '@scope', 'pinned'));
    // Repo-aware producer modes still inspect the live repository.
    expect(out.REPO_DIR).toBe(root);
    // The run names what it pinned and what it left out.
    expect(run.stderr).toContain('pinned source');
    expect(run.stderr).toContain('uncommitted pot-git edits are NOT part of this run');
    // The early trap removes the multi-hundred-MB snapshot on exit.
    expect(existsSync(towerSource)).toBe(false);
  });

  it('keeps every tower producer call behind the pin, in the probe and the scenario', () => {
    const pin = probe.indexOf('PRODUCER="$tower_source/');
    expect(pin).toBeGreaterThan(-1);
    const calls = [...probe.matchAll(/"\$TSX" "\$PRODUCER"/g)].map((m) => m.index ?? -1);
    expect(calls.length).toBeGreaterThan(0);
    for (const at of calls) expect(at).toBeGreaterThan(pin);
    // Both hosts stage the ONE pinned commit.
    expect(probe).toContain('stage_pinned_source tower tar -xf - -C "$tower_source"');
    expect(probe).toContain('stage_pinned_source VM ssh');
    expect(probe).toContain('HIVE_GIT_PHYSICAL_TOWER_SOURCE="$tower_source"');

    const gate = scenario.indexOf('PRODUCER="$TOWER_SOURCE/');
    expect(gate).toBeGreaterThan(-1);
    expect(scenario).toContain('HIVE_GIT_PHYSICAL_TOWER_SOURCE is unset');
    expect(scenario).toContain('*/hive-git-physical-tower-source.*) ;;');
    expect(gate).toBeLessThan(scenario.lastIndexOf('verify_physical_vm_source\n'));
    expect(gate).toBeLessThan(scenario.lastIndexOf('run_all_phases\n'));
  });
});
