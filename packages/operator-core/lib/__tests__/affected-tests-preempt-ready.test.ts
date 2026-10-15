/**
 * Regression guards for the once-only `test:affected` after-ready barrier
 * (EI-21361599312981776).
 *
 * The wrapper must remain preemptible while affected-tests is still deriving or
 * previewing work, then protect the run only after its task plan is final and
 * immediately before the first task shard starts. These tests exercise the
 * cheap early exits and pin the expensive execution boundary structurally.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS = resolve(REPO_ROOT, 'scripts/affected-tests.mjs');
const PC_HEAVY_SRC = readFileSync(resolve(REPO_ROOT, 'scripts/pc-heavy.sh'), 'utf8');
const PACKAGE_JSON = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};
const source = readFileSync(AFFECTED_TESTS, 'utf8');

function runAffected(args: string[], marker: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [AFFECTED_TESTS, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      AFFECTED_RETRY_FAILED: '0',
      PC_HEAVY_PREEMPT_READY_FILE: marker,
    },
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

describe('affected-tests after-ready publication boundary (EI-21361599312981776)', () => {
  it.each([
    ['dry preview', ['--changed-paths', 'scripts/affected-tests.mjs', '--dry'], 0],
    ['print-affected enumeration', ['--changed-paths', 'scripts/affected-tests.mjs', '--print-affected'], 0],
    ['unknown-flag refusal', ['--changed-paths', 'scripts/affected-tests.mjs', '--dry-rnu'], 1],
  ])('does not publish the execution marker on the %s early exit', (_name, args, expectedStatus) => {
    const dir = mkdtempSync(join(tmpdir(), 'affected-ready-early-'));
    const marker = join(dir, 'ready-marker');
    try {
      const result = runAffected(args, marker);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(expectedStatus);
      expect(existsSync(marker), `an early exit must not publish ${marker}`).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('publishes exactly after all early exits and immediately before the first task shard', () => {
    const publication = source.indexOf('publishPreemptReadyMarker();');
    const emptyTasks = source.indexOf('if (!tasks.length)');
    const dryExit = source.indexOf('if (dry) {');
    const initialPool = source.indexOf('initialPool = await runBudgetedTaskShards');

    expect(publication).toBeGreaterThan(emptyTasks);
    expect(publication).toBeGreaterThan(dryExit);
    expect(initialPool).toBeGreaterThan(publication);
    // WI-1490656 wrapped the shard call in a try/catch so an admission-starvation throw is
    // reported as a refusal instead of dying as an uncaught top-level rejection. The
    // adjacency this pins is unchanged and deliberately still exact: ONLY the `try {` opener
    // may sit between publication and the first shard, so no future early-exit or extra
    // statement can slip into the window this test exists to keep empty. (The `let
    // initialPool;` declaration lives ABOVE the publication for exactly this reason.)
    expect(source.slice(publication, initialPool)).toBe('publishPreemptReadyMarker();\ntry {\n  ');
  });

  it('cleans a published marker from the process-exit path', () => {
    const exitHandler = source.indexOf('process.on("exit", (code) => {');
    const cleanup = source.indexOf('cleanupPreemptReadyMarker();', exitHandler);
    const abort = source.indexOf('emitAbortMarker(', exitHandler);

    expect(exitHandler).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(exitHandler);
    expect(abort).toBeGreaterThan(cleanup);
    expect(source).toContain('flag: "wx"');
  });

  it('does not forward the outer barrier paths into nested workspace-test routers', () => {
    // The marker is owned by affected-tests itself. A nested test-files router
    // that inherits the path sees the live parent and correctly refuses EEXIST,
    // producing exit 75 without running any tests.
    expect(source).toContain('delete childEnv.PC_HEAVY_PREEMPT_READY_FILE;');
    expect(source).toContain('delete childEnv.PC_HEAVY_PSI_FINALIZATION_FILE;');
  });
});

describe('once-only package wiring', () => {
  it('scopes every affected-test entry point to this harness before nested test routers run', () => {
    for (const name of ['test', 'test:affected', 'test:related', 'test:affected:integration', 'test:all', 'test:all:integration', 'test:integration-only']) {
      expect(PACKAGE_JSON.scripts?.[name], `${name} would produce unbindable test runs and trigger an unscoped-router warning`)
        .toMatch(/^PAPERCUSP_TEST_RUN_HARNESS=papercusp /);
    }
    // A standalone focused test still requires its caller to declare the target harness.
    expect(PACKAGE_JSON.scripts?.['test:file']).not.toContain('PAPERCUSP_TEST_RUN_HARNESS=');
  });

  it('holds every test entry point under the shared dependency install reader mutex', () => {
    // Safe installs serialize writers. Test processes must hold the matching read
    // lease for their full run so npm reification cannot hollow node_modules while
    // Vitest or a workspace runtime is resolving packages.
    for (const name of ['test', 'test:file', 'test:affected', 'test:related', 'test:affected:integration', 'test:all', 'test:all:integration', 'test:integration-only']) {
      expect(PACKAGE_JSON.scripts?.[name], `${name} can observe a package-manager reify in progress`)
        .toContain('scripts/npm-install-safe.mjs --exec-under-lock --');
    }
  });

  it('creates one proof group outside the fresh-attempt retry loop', () => {
    const proofGroup = PC_HEAVY_SRC.indexOf('export AFFECTED_TASK_VERDICT_PROOF_GROUP="$_resume_proof_group"');
    const retryLoop = PC_HEAVY_SRC.indexOf('while [ "$_retry_attempt" -le "$_retry_limit" ]; do');
    expect(proofGroup).toBeGreaterThan(-1);
    expect(retryLoop).toBeGreaterThan(proofGroup);
    expect(PC_HEAVY_SRC.match(/export AFFECTED_TASK_VERDICT_PROOF_GROUP=/g)).toHaveLength(1);
    expect(PC_HEAVY_SRC).toContain('_resume_proof_group="$PAPERCUSP_TEST_RUN_GROUP"');
    expect(PC_HEAVY_SRC).toContain('_resume_proof_group="pc-heavy-resume-');
  });

  it('opts test:affected variants into bounded, resumable after-ready execution', () => {
    for (const name of ['test:affected', 'test:affected:integration']) {
      expect(PACKAGE_JSON.scripts?.[name]).toContain('PC_HEAVY_PREEMPT_AFTER_READY=1');
      expect(PACKAGE_JSON.scripts?.[name]).toContain('PC_HEAVY_RETRY_PREEMPTIONS=3');
      expect(PACKAGE_JSON.scripts?.[name]).toContain('AFFECTED_TASK_VERDICT_RESUME=1');
    }
  });

  it('does not silently widen the barrier to related or all-workspace sweeps', () => {
    for (const name of ['test:related', 'test:all', 'test:all:integration', 'test:integration-only']) {
      expect(PACKAGE_JSON.scripts?.[name]).not.toContain('PC_HEAVY_PREEMPT_AFTER_READY=1');
      expect(PACKAGE_JSON.scripts?.[name]).not.toContain('PC_HEAVY_RETRY_PREEMPTIONS=3');
      expect(PACKAGE_JSON.scripts?.[name]).not.toContain('AFFECTED_TASK_VERDICT_RESUME=1');
    }
  });
});
