/**
 * SWE-bench Verified task-set loader unit tests (benchmark-arms-su-vs-queen-expansion-2026-06-16 P-006).
 *
 * Focus: the verified loaders (`verified-pilot-10` / `swe-bench-verified` / `swe-bench-verified-custom`) —
 * that they read the verified JSONL, map it through {@link verifiedRowToBenchTask} (NOT the Pro
 * rowToBenchTask), carry `benchmark: 'swe-bench-verified'`, derive the swebench-harness grader inputs
 * (FAIL_TO_PASS/PASS_TO_PASS parsed as REAL JSON arrays, test_patch, version, environment_setup_commit, the
 * informational sweb.eval image name), preserve the UN-prefixed instance_id, and that knownTaskSets()
 * advertises the sets. Uses temp fixtures + the env overrides so it is host-independent (no network).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { knownTaskSets, loadBenchTaskSet, verifiedRowToBenchTask } from './task-sets';

let dir: string;

// A representative Verified row (the schema written to swe-bench-verified/tasks.jsonl): un-prefixed
// instance_id, REAL JSON-array FAIL_TO_PASS/PASS_TO_PASS (double-quoted), test_patch + version +
// environment_setup_commit, an upstream effort label, and the derived tier.
const ROW_ASTROPY = {
  instance_id: 'astropy__astropy-12907',
  repo: 'astropy/astropy',
  base_commit: 'd16bfe05a744909de4b27f5875fe0d4ed41ce607',
  problem_statement: 'separability_matrix does not compute separability correctly',
  fail_to_pass: '["astropy/modeling/tests/test_separable.py::test_separable[compound_model6-result6]"]',
  pass_to_pass: '["astropy/modeling/tests/test_separable.py::test_coord_matrix"]',
  test_patch: 'diff --git a/astropy/modeling/tests/test_separable.py b/...',
  version: '4.3',
  environment_setup_commit: '298ccb478e6bf092953bca67a3d29dc6c35f6752',
  created_at: '2022-03-03T15:14:54Z',
  swebench_difficulty: '15 min - 1 hour',
  tier: 'medium' as const,
};
const ROW_FLASK = {
  instance_id: 'pallets__flask-5014',
  repo: 'pallets/flask',
  base_commit: '7ee9ceb71e868944a46e1ff00b506772829b2dcd',
  problem_statement: 'Require a non-empty name for Blueprints',
  fail_to_pass: '["tests/test_blueprints.py::test_empty_name_not_allowed"]',
  pass_to_pass: '["tests/test_blueprints.py::test_blueprint_specific_error_handling"]',
  test_patch: 'diff --git a/tests/test_blueprints.py b/...',
  version: '2.3',
  environment_setup_commit: '',
  created_at: '2023-04-22T10:00:00Z',
  swebench_difficulty: '<15 min fix',
  tier: 'easy' as const,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'verified-'));
  writeFileSync(
    join(dir, 'tasks.jsonl'),
    [JSON.stringify(ROW_ASTROPY), JSON.stringify(ROW_FLASK)].join('\n') + '\n',
    'utf8',
  );
  writeFileSync(join(dir, 'verified-pilot-10.jsonl'), JSON.stringify(ROW_ASTROPY) + '\n', 'utf8');
  process.env.PAPERCUSP_BENCH_VERIFIED_JSONL = join(dir, 'tasks.jsonl');
  process.env.PAPERCUSP_BENCH_VERIFIED_PILOT_JSONL = join(dir, 'verified-pilot-10.jsonl');
});

afterEach(() => {
  delete process.env.PAPERCUSP_BENCH_VERIFIED_JSONL;
  delete process.env.PAPERCUSP_BENCH_VERIFIED_PILOT_JSONL;
  rmSync(dir, { recursive: true, force: true });
});

describe('swe-bench-verified task sets', () => {
  it('loads the full verified set with the verified family + un-prefixed instance ids', async () => {
    const tasks = await loadBenchTaskSet('swe-bench-verified');
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.benchmark === 'swe-bench-verified')).toBe(true);
    // instance_id stays un-prefixed (no `instance_` prefix — that's a Pro-ism)
    expect(tasks.map((t) => t.instanceId).sort()).toEqual(['astropy__astropy-12907', 'pallets__flask-5014']);
  });

  it('loads the 10-instance pilot subset', async () => {
    const tasks = await loadBenchTaskSet('verified-pilot-10');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].instanceId).toBe('astropy__astropy-12907');
    expect(tasks[0].benchmark).toBe('swe-bench-verified');
  });

  it('derives the swebench-harness grader inputs (image name + JSON-array FAIL_TO_PASS/PASS_TO_PASS)', async () => {
    const tasks = await loadBenchTaskSet('swe-bench-verified');
    const astropy = tasks.find((t) => t.instanceId === 'astropy__astropy-12907')!;
    // image name: docker.io/swebench namespace, lowercased instance id, NO jefzda
    expect(astropy.graderMeta.image_name).toBe('swebench/sweb.eval.x86_64.astropy__astropy-12907');
    // FAIL_TO_PASS / PASS_TO_PASS parsed as REAL JSON arrays (not the Pro Python-ish literal)
    expect(astropy.graderMeta.FAIL_TO_PASS).toEqual([
      'astropy/modeling/tests/test_separable.py::test_separable[compound_model6-result6]',
    ]);
    expect(astropy.graderMeta.PASS_TO_PASS).toEqual([
      'astropy/modeling/tests/test_separable.py::test_coord_matrix',
    ]);
    // version + environment_setup_commit + test_patch threaded for the harness
    expect(astropy.graderMeta.version).toBe('4.3');
    expect(astropy.graderMeta.environment_setup_commit).toBe('298ccb478e6bf092953bca67a3d29dc6c35f6752');
    expect(astropy.graderMeta.test_patch).toMatch(/^diff --git/);
    expect(astropy.graderMeta.upstream_repo).toBe('astropy/astropy');
  });

  it('carries the tier + upstream difficulty label both first-class and inside graderMeta', () => {
    const t = verifiedRowToBenchTask(ROW_ASTROPY);
    expect(t.tier).toBe('medium');
    expect(t.graderMeta.tier).toBe('medium');
    expect(t.graderMeta.swebench_difficulty).toBe('15 min - 1 hour');
  });

  it('carries the upstream created_at as createdAt for the contamination policy, and omits it when absent (D-007)', () => {
    expect(verifiedRowToBenchTask({ ...ROW_ASTROPY, created_at: '2023-01-02T03:04:05Z' }).createdAt).toBe('2023-01-02T03:04:05Z');
    const { created_at: _omit, ...undated } = ROW_ASTROPY as typeof ROW_ASTROPY & { created_at?: string };
    expect('createdAt' in verifiedRowToBenchTask(undated)).toBe(false);
  });

  it('does NOT leak the gold patch into the task (un-gameable)', () => {
    const t = verifiedRowToBenchTask(ROW_ASTROPY);
    // the verified row schema never persists `patch`; the BenchTask must not expose it anywhere
    expect(JSON.stringify(t)).not.toContain('"patch"');
  });

  it('filters to explicit ids for swe-bench-verified-custom', async () => {
    const tasks = await loadBenchTaskSet('swe-bench-verified-custom', ['pallets__flask-5014']);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].instanceId).toBe('pallets__flask-5014');
  });

  it('rejects swe-bench-verified-custom with no ids', async () => {
    await expect(loadBenchTaskSet('swe-bench-verified-custom', [])).rejects.toThrow(/non-empty taskIds/);
  });

  it('is advertised by knownTaskSets with on-disk counts', () => {
    const sets = knownTaskSets();
    const full = sets.find((s) => s.id === 'swe-bench-verified');
    const pilot = sets.find((s) => s.id === 'verified-pilot-10');
    expect(full).toBeDefined();
    expect(full!.count).toBe(2);
    expect(full!.label).toMatch(/verified/i);
    expect(pilot).toBeDefined();
    expect(pilot!.count).toBe(1);
  });
});
