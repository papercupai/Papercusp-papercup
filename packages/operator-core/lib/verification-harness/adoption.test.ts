/**
 * R-11 (expensive-verification-loops-2026-09-29, P-006): the named expensive harnesses declare
 * and run through the verification-harness contract — the hive-git drill, release-local.sh,
 * verify-tauri-headless.sh and the LLM scenario battery.
 *
 * For each shell harness this reads its declaration (the vh_phase lines and the vh_init name),
 * then DRY-RUNS its phase listing: a bash process sources the real vh.sh, replays exactly those
 * declaration lines and calls vh_init against a temp evidence root, which writes contract.json
 * and asks the shared planner (src/cli.ts) for the plan. It then checks that every declared phase
 * is entered by the harness and that the run is finalized, so the declaration cannot drift from
 * the sections that actually run. The LLM battery is checked the same way through its TS
 * contract: the real scenario catalogue is planned, and llm-test.ts must run through it.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { parseSelectionArgs, planSelection, runHarness, validateContract,
  type HarnessRunResult, type RunHarnessArgs } from '@papercusp/verification-harness';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { LLM_BATTERY_HARNESS, llmBatteryContract } from '../llm-testing/battery-harness';
import { SCENARIOS } from '../llm-testing/scenarios';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const VH_SH = path.join(REPO_ROOT, 'libs/generic/verification-harness/bin/vh.sh');

interface ShellHarness {
  file: string;
  name: string;
  phases: string[];
  /** The command that opens a phase section (vh_begin, or the harness's own wrapper). */
  entry: string;
}

const SHELL_HARNESSES: ShellHarness[] = [
  {
    file: 'scripts/verify-tauri-headless.sh',
    name: 'verify-tauri-headless',
    phases: ['prepare', 'boot', 'assert'],
    // Since 77a4afdfc8 (2026-10-16) phases open through verifier_begin_phase, which emits the
    // native controller's VH_BEGIN marker and then calls `vh_begin "$1"` itself.
    entry: 'verifier_begin_phase',
  },
  {
    file: 'papercusp-desktop/bin/release-local.sh',
    name: 'release-local',
    phases: ['bump', 'sidecar', 'gates', 'build', 'tag'],
    entry: 'vh_begin',
  },
  {
    file: 'papercusp-desktop/bin/hive-git-drill.sh',
    name: 'hive-git-drill',
    phases: ['setup', 'mode', 'leg-a', 'leg-b', 'leg-c', 'physical', 'leg-d', 'leg-f'],
    entry: 'drill_phase',
  },
];

/**
 * VH_ADOPTION_OVERRIDE=<repo-relative harness path>=<absolute copy> reads a copy instead of the
 * tracked file, so scripts/mutation-probe.sh can prove this test falsifiable in copy-out mode
 * (a mutant never touches the shared tree).
 */
function harnessSource(file: string): string {
  const override = process.env.VH_ADOPTION_OVERRIDE ?? '';
  const eq = override.indexOf('=');
  const target = eq > 0 && override.slice(0, eq) === file ? override.slice(eq + 1) : path.join(REPO_ROOT, file);
  return readFileSync(target, 'utf8');
}

const tmpRoots: string[] = [];
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true });
});

/** Declaration lines only: vh_phase / vh_scope calls, including a `for … vh_phase` loop. */
function declarationLines(src: string): string[] {
  return src
    .split('\n')
    .filter((l) => /^\s*(vh_phase|vh_scope)\s/.test(l) || /^\s*for\s+\w+\s+in\s.*;\s*do\s+vh_phase\s/.test(l));
}

function dryRunPhaseListing(h: ShellHarness, src: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), `vh-adoption-${h.name}-`));
  tmpRoots.push(root);
  const script = [
    'set -u',
    `source ${JSON.stringify(VH_SH)}`,
    ...declarationLines(src),
    `vh_init ${h.name} "$VH_ADOPTION_ROOT" || exit 3`,
    'printf "VH_TEST_RUN_DIR=%s\\n" "$VH_RUN_DIR"',
  ].join('\n');
  const res = spawnSync('bash', ['-c', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, VH_ADOPTION_ROOT: root, VH_LOG_FD: '1', VH_FAIL_OPEN: '0', VH_DISABLE: '0' },
    timeout: 60_000,
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  return { status: res.status, out, root };
}

describe.each(SHELL_HARNESSES)('$file adopts the contract', (h) => {
  const src = harnessSource(h.file);

  it('sources the shared vh.sh and names itself with vh_init', () => {
    expect(src).toMatch(/^[^#\n]*libs\/generic\/verification-harness\/bin\/vh\.sh/m);
    expect(src).toMatch(/^\s*source\s+"\$VH_SH"/m);
    expect(src).toMatch(new RegExp(`^\\s*vh_init\\s+${h.name}\\s`, 'm'));
  });

  it('dry-runs its phase listing through the real vh.sh + planner', () => {
    const { status, out, root } = dryRunPhaseListing(h, src);
    expect(status, `dry run failed:\n${out}`).toBe(0);
    const runLine = out.split('\n').find((l) => l.startsWith(`VH_RUN harness=${h.name} `));
    expect(runLine, `no VH_RUN line:\n${out}`).toBeDefined();
    const plan = runLine!.match(/ plan=(\S+)/)?.[1] ?? '';
    expect(plan.split(',')).toEqual(h.phases.map((p) => `${p}:run`));

    const runDirs = readdirSync(root).filter((d) => d !== 'latest');
    expect(runDirs).toHaveLength(1);
    const contract = JSON.parse(readFileSync(path.join(root, runDirs[0]!, 'contract.json'), 'utf8')) as {
      name: string;
      phases: { id: string }[];
    };
    expect(contract.name).toBe(h.name);
    expect(contract.phases.map((p) => p.id)).toEqual(h.phases);
  });

  it('enters every declared phase and finalizes the run', () => {
    for (const phase of h.phases) {
      expect(src, `${h.file} never enters phase ${phase} via ${h.entry}`).toMatch(
        new RegExp(`^\\s*(if\\s+)?${h.entry}\\s+${phase.replace(/-/g, '\\-')}(\\s|;|$)`, 'm'),
      );
    }
    // vh_bracket_trap finalizes from the EXIT trap; vh_exit is the call from the script's own handler.
    expect(src).toMatch(/^\s*(vh_bracket_trap|.*\bvh_exit\s+"?\$)/m);
  });
});

describe('the GOAL Tauri driver adopts the contract', () => {
  it.each([false, true])('runs the native phase and propagates its verdict (assertion fails: %s)', async (fails) => {
    const source = harnessSource('scripts/tauri-surface-verify-goal-report.mts');
    const footer = source.slice(source.indexOf('const selection = parseSelectionArgs('));
    const root = mkdtempSync(path.join(os.tmpdir(), 'vh-adoption-goal-tauri-'));
    tmpRoots.push(root);
    const native = vi.fn(async () => {
      if (fails) throw new Error('isolated native assertion refused');
    });
    const processFixture: { argv: string[]; exitCode?: number } = {
      argv: ['node', 'driver.mts', '--only=native'],
    };
    let measured: HarnessRunResult | undefined;
    // Execute the actual driver handoff through the real runner. The native
    // body is the seam: these tests start no display, fixture DB or recorder.
    await runInNewContext('(async () => {\n' + footer + '\n})()', {
      parseSelectionArgs, defaultEvidenceRoot: () => root,
      runGoalReportNative: native, process: processFixture,
      runHarness: async (args: RunHarnessArgs) => {
        measured = await runHarness({ ...args, guardRails: [] });
        return measured;
      },
    });
    expect(native).toHaveBeenCalledTimes(1);
    expect(native).toHaveBeenCalledWith(measured?.phases[0]?.evidenceDir);
    expect(measured?.harness).toBe('goal-report-tauri');
    expect(measured?.verdict).toBe(fails ? 'fail' : 'pass');
    expect(measured?.phases).toEqual([expect.objectContaining({
      phase: 'native', status: fails ? 'failed' : 'passed', step: 'isolated-runtime-preconditions',
    })]);
    expect(processFixture.exitCode).toBe(fails ? 1 : 0);
    const persisted = JSON.parse(readFileSync(path.join(measured!.evidenceDir, 'result.json'), 'utf8'));
    expect(persisted.verdict).toBe(measured?.verdict);
    if (fails) expect(persisted.phases[0].detail).toContain('isolated native assertion refused');
  });
});

describe('the DAO HR native delegate adopts the contract', () => {
  it.each([false, true])('records the native verdict and propagates failure (%s)', async (fails) => {
    const source = harnessSource('scripts/tauri-surface-verify-dao-hr.mts');
    const footer = source.slice(source.indexOf('const selection = parseSelectionArgs('));
    const root = mkdtempSync(path.join(os.tmpdir(), 'vh-adoption-dao-hr-'));
    tmpRoots.push(root);
    const native = vi.fn(async () => {
      if (fails) throw new Error('DAO HR native assertion refused');
    });
    // `env` is required: since 376951c831 the footer reads process.env.PAPERCUSP_DAO_HR_NATIVE_MUTATION
    // (its mutation-probe hook); a fixture without it throws before runNativeE2e is ever called.
    const processFixture: { argv: string[]; env: Record<string, string | undefined>; exitCode?: number } = {
      argv: ['node', 'driver.mts', '--only=native'],
      env: {},
    };
    let measured: HarnessRunResult | undefined;
    await runInNewContext('(async () => {\n' + footer + '\n})()', {
      parseSelectionArgs, defaultEvidenceRoot: () => root, runNativeE2e: native,
      process: processFixture,
      runHarness: async (args: RunHarnessArgs) => {
        measured = await runHarness({ ...args, guardRails: [] });
        return measured;
      },
    });
    expect(native).toHaveBeenCalledExactlyOnceWith(
      ['packages/operator-core/lib/dao-hr/native.e2e.test.ts'], { runtimeUnit: 'dao-hr-native-desktop' },
    );
    expect(measured?.harness).toBe('dao-hr-tauri');
    expect(measured?.verdict).toBe(fails ? 'fail' : 'pass');
    expect(processFixture.exitCode).toBe(fails ? 1 : 0);
    const persisted = JSON.parse(readFileSync(path.join(measured!.evidenceDir, 'result.json'), 'utf8'));
    expect(persisted.verdict).toBe(measured?.verdict);
    if (fails) expect(persisted.phases[0].detail).toContain('DAO HR native assertion refused');
  });
});

describe('the tutorial voice asset native delegate adopts the contract', () => {
  it.each([false, true])('records the delegated shell verdict and propagates failure (%s)', (fails) => {
    const source = harnessSource('scripts/tauri-surface-verify-tutorial-voice-assets.sh');
    const footer = source.slice(source.indexOf('vh_run native run_native'));
    const root = mkdtempSync(path.join(os.tmpdir(), 'vh-adoption-tutorial-assets-'));
    tmpRoots.push(root);
    const script = [
      'set -euo pipefail',
      `source ${JSON.stringify(VH_SH)}`,
      ...declarationLines(source),
      'vh_init tutorial-voice-assets "$VH_ADOPTION_ROOT"',
      'vh_bracket_trap',
      `run_native() { return ${fails ? 7 : 0}; }`,
      footer,
    ].join('\n');
    const result = spawnSync('bash', ['-c', script], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, VH_ADOPTION_ROOT: root, VH_LOG_FD: '1', VH_FAIL_OPEN: '0', VH_DISABLE: '0' },
    });
    expect(result.status, result.stderr).toBe(fails ? 1 : 0);
    const runDir = readdirSync(root).find(dir => dir !== 'latest');
    expect(runDir).toBeDefined();
    const persisted = JSON.parse(readFileSync(path.join(root, runDir!, 'result.json'), 'utf8'));
    expect(persisted.verdict).toBe(fails ? 'fail' : 'pass');
    expect(persisted.phases).toEqual([expect.objectContaining({
      phase: 'native', status: fails ? 'failed' : 'passed',
    })]);
  });
});

describe('the LLM scenario battery adopts the contract', () => {
  it('plans every real scenario as a phase', () => {
    const contract = llmBatteryContract(SCENARIOS);
    expect(contract.name).toBe(LLM_BATTERY_HARNESS);
    validateContract(contract);
    const plan = planSelection(contract, { only: null, from: null }, null);
    expect(plan).toHaveLength(SCENARIOS.length);
    expect(plan.every((p) => p.action === 'run')).toBe(true);
    expect(plan.map((p) => p.phase)).toEqual(SCENARIOS.map((s) => s.id));
    const first = SCENARIOS[0]!.id;
    expect(planSelection(contract, { only: [first], from: null }, null).filter((p) => p.action === 'run')).toEqual([
      { phase: first, action: 'run' },
    ]);
  });

  it('llm-test.ts runs its scenarios through runScenarioBattery', () => {
    const src = harnessSource('apps/operator/bin/llm-test.ts');
    expect(src).toMatch(/import\s*\{[^}]*\brunScenarioBattery\b[^}]*\}\s*from\s*'@papercusp\/operator-core\/lib\/llm-testing\/battery-harness'/);
    const calls = src.match(/await runScenarioBattery\(\{\s*scenarios\b/g) ?? [];
    expect(calls).toHaveLength(1);
  });
});
