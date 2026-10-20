/**
 * affected-tests-coverage-passthrough.test.ts — P-009 part (a),
 * plan design-to-code-coverage-seam-2026-09-02, decision D-028.
 *
 * `scripts/affected-tests.mjs` is the runner every automated test path enters, and
 * until this change it had NO Vitest-flag passthrough and HARD-REJECTED unrecognized
 * flags. That is why `libs/test-config/src/vitest-config.ts`'s coverage provider block
 * — complete, functional, verified by hand — had never produced a single byte of
 * coverage in CI, and why P-009's stated premise ("fed by the lcov P-007 emits") was
 * false: there was no producer to be fed by.
 *
 * These tests drive the REAL runner in `--print-affected` mode (it selects and prints;
 * it runs no suite), because the passthrough's correctness is entirely about which
 * tasks receive the flag — a question no unit of the module can answer alone.
 *
 * The controls are the load-bearing part:
 *   • WITHOUT `--coverage`, no command may mention it — otherwise every assertion
 *     below passes on a runner that appends the flag unconditionally.
 *   • A near-miss flag must STILL be refused — otherwise "we extended KNOWN_FLAGS"
 *     is indistinguishable from "we disabled the unknown-flag refusal", and the
 *     refusal is exactly what protects the nightly's `--all --integration` step.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// lib/__tests__ → lib → operator-core → packages → <repo root>
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const AFFECTED_TESTS = join(REPO_ROOT, 'scripts/affected-tests.mjs');

/** A real, stable source file whose workspace runs vitest. */
const CHANGED = 'packages/operator-core/lib/tsc-diagnostics.ts';

interface Emitted {
  status: number | null;
  stdout: string;
  stderr: string;
  cmds: Array<{ workspace: string; command: string }>;
  /** `<workspace>::<script>` of every repo-wide invariant guard (AFFECTED_GUARD lines). */
  guards: Set<string>;
}

function runPrintAffected(extra: string[]): Emitted {
  const r = spawnSync(
    'node',
    [AFFECTED_TESTS, '--changed-paths', CHANGED, '--print-affected', ...extra],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      timeout: 300_000,
      killSignal: 'SIGKILL',
    },
  );
  const stdout = r.stdout ?? '';
  return {
    status: r.status,
    stdout,
    stderr: r.stderr ?? '',
    cmds: stdout
      .split('\n')
      .filter((l) => l.startsWith('AFFECTED_WS_CMD\t'))
      .map((l) => l.split('\t'))
      .map(([, workspace, command]) => ({ workspace, command })),
    guards: new Set(
      stdout
        .split('\n')
        .filter((l) => l.startsWith('AFFECTED_GUARD\t'))
        .map((l) => l.split('\t'))
        .map(([, workspace, script]) => `${workspace}::${script}`),
    ),
  };
}

/**
 * The workspace dir and script name a printed command would run — parsed out of
 * the command itself so this test reads the same string a consumer would.
 * Both shapes: `npm run --silent --workspace <dir> <script>` (a real workspace)
 * and `npm --prefix <dir> run --silent <script>` (a standalone package).
 */
function parseCommand(command: string): { dir: string; script: string } | null {
  const tokens = command.replace(/'/g, '').split(/\s+/);
  const cut = tokens.indexOf('--');
  const head = cut >= 0 ? tokens.slice(0, cut) : tokens;
  const ws = head.indexOf('--workspace');
  if (ws >= 0) return { dir: head[ws + 1], script: head[head.length - 1] };
  const prefix = head.indexOf('--prefix');
  if (prefix >= 0) return { dir: head[prefix + 1], script: head[head.length - 1] };
  return null;
}

/** Mirrors scriptRunsVitestDirectly() in the runner — the rule under test. */
function scriptRunsVitestDirectly(dir: string, script: string): boolean {
  const pkgPath = join(REPO_ROOT, dir, 'package.json');
  if (!existsSync(pkgPath)) return false;
  const text: string = JSON.parse(readFileSync(pkgPath, 'utf8'))?.scripts?.[script] ?? '';
  return /(^|[\s;&|])vitest(\s|$)/.test(text);
}

describe('affected-tests.mjs --coverage passthrough (P-009 part a)', () => {
  it('accepts --coverage instead of rejecting it as an unknown flag', () => {
    const run = runPrintAffected(['--coverage']);
    expect(run.status, `--coverage was rejected:\n${run.stderr}`).toBe(0);
  });

  it('STILL refuses a near-miss flag — the refusal was extended, not disabled', () => {
    // If this ever passes, KNOWN_FLAGS is no longer a closed set and the nightly's
    // `--all --integration` step loses the protection that made P-007 stop.
    const run = runPrintAffected(['--coverag']);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/unrecognized flag/);
  });

  it('forwards --coverage to the vitest tasks, and to no others', () => {
    const run = runPrintAffected(['--coverage']);
    expect(run.status, run.stderr).toBe(0);
    expect(run.cmds.length, 'no AFFECTED_WS_CMD lines to judge').toBeGreaterThan(0);

    let instrumented = 0;
    for (const { workspace, command } of run.cmds) {
      const parsed = parseCommand(command);
      expect(parsed, `unparseable AFFECTED_WS_CMD for ${workspace}: ${command}`).not.toBeNull();
      const carries = command.includes('-- --coverage');
      // Both runner rules: a repo-wide invariant guard is never instrumented (it would
      // clobber the workspace's real lcov), even when its script is a direct `vitest run`.
      const isGuard = run.guards.has(`${workspace}::${parsed!.script}`);
      const shouldCarry = !isGuard && scriptRunsVitestDirectly(parsed!.dir, parsed!.script);
      expect(
        carries,
        `${workspace} :: ${parsed!.script} — coverage forwarding disagrees with whether the ` +
          `script invokes vitest directly and is not a repo-wide invariant guard ` +
          `(guard=${isGuard}; command: ${command})`,
      ).toBe(shouldCarry);
      if (carries) instrumented += 1;
    }
    // Calibration: without at least one instrumented task the loop above proves
    // only that nothing was instrumented, which every broken passthrough satisfies.
    expect(instrumented, 'no task received --coverage — the assertion above is vacuous')
      .toBeGreaterThan(0);
  });

  it('reports what it instrumented and skipped, so a partial report is never silent', () => {
    const run = runPrintAffected(['--coverage']);
    expect(run.stderr).toMatch(/COVERAGE_PASSTHROUGH instrumented=\d+ skipped=\d+ of=\d+/);
    const match = /COVERAGE_PASSTHROUGH instrumented=(\d+)/.exec(run.stderr);
    expect(Number(match?.[1] ?? 0)).toBeGreaterThan(0);
  });

  it('CONTROL: without --coverage nothing mentions coverage at all', () => {
    const run = runPrintAffected([]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.cmds.length).toBeGreaterThan(0);
    for (const { workspace, command } of run.cmds) {
      expect(command, `${workspace} carries --coverage without being asked`).not.toContain(
        '--coverage',
      );
    }
    expect(run.stderr).not.toContain('COVERAGE_PASSTHROUGH');
  });

  it('CONTROL: the default AFFECTED_WS_CMD shape is unchanged for existing consumers', () => {
    // green-checkpoint and sync-batch-delta-check parse these lines; adding the
    // extraArgs parameter must not alter the string when there are none.
    const run = runPrintAffected([]);
    for (const { command } of run.cmds) {
      expect(command).not.toContain(' -- ');
      expect(command).toMatch(/^npm (--prefix \S+ run --silent|run --silent --workspace \S+) \S+$/);
    }
  });
});
