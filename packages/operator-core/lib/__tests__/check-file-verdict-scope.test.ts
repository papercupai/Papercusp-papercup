/**
 * check-file-verdict-scope.test.ts — EI-20093615847114656 regression guard.
 *
 * ## The gap this covers
 *
 * `scripts/check-ungated-mug-kettle.mjs --check-file <path>` inspects ONE family
 * (role-doors, via `inspectFile`). It returns before `collectCensus()`, so the eight
 * census families — ui, tool, flag, spawn-role, prompt, wake, system-action,
 * blueprint-launch — are structurally invisible to it.
 *
 * It used to answer `no role-parameterized door detected in X — nothing to gate`, exit 0.
 * That is a verdict about the FILE phrased from one family's evidence, and it was measured
 * (2026-08-10) answering exit 0 on:
 *
 *   - `apps/operator/app/adv/hud/GoalSessionsRail.tsx` while the FULL guard was failing on
 *     that exact file (`ui|GoalSessionsRail`) — the leg that froze `main` for ~3.4h; and
 *   - `libs/flags/src/types.ts`, which carries 31 `flag|…` surfaces in the guard's own
 *     baseline.
 *
 * The failure mode is not "an agent was careless". It fires precisely when someone is under
 * pressure: a red gate leg names a file, the natural next move is to scope the guard to that
 * file, and the guard answers clean. A peer issued a retraction off that green. The header
 * advertises `--check-file` as "the falsifiability seam", which invites exactly this use.
 *
 * ## What this asserts, and what it does not
 *
 * It asserts BEHAVIOR through the real CLI, never source text, on files created OUTSIDE the
 * repo (os.tmpdir()) so the shared tree is never mutated — git-sync commits every few minutes
 * and an exclusive lock does not pause it (EI-19450431506682666). Four independent ways the
 * bug reopens:
 *
 *   1. the clean-bill phrasing returns — the original bug, and the one that reads as green;
 *   2. the un-inspected families stop being named, so a reader cannot tell what was skipped;
 *   3. `--full` starts ANSWERING for a path the census cannot see (out-of-tree), which is
 *      this same bug one level up: unmeasurable reported as measured-clean;
 *   4. the role-door exit codes drift — `scripts/mutation-probe.sh` reads the guard's exit
 *      code as its verdict, so a change there silently breaks falsifiability proofs.
 *
 * It does NOT assert the census RESULTS for a file (`--full` costs a ~33s whole-tree scan);
 * the full guard's own suite covers that.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

/**
 * `PROBE_SCRIPT` is the falsifiability seam, and it is REQUIRED for this file to be
 * probe-able at all: `scripts/mutation-probe.sh` mutates a COPY and points the test at it
 * via `--test 'PROBE_SCRIPT={} …'`. A test that hardcoded the tracked path would run against
 * the untouched original, so every mutant would falsely "survive" and the probe would prove
 * nothing while reporting success (EI-20035128684317484).
 */
const GUARD = process.env.PROBE_SCRIPT || path.join(REPO_ROOT, 'scripts', 'check-ungated-mug-kettle.mjs');

/** The exact phrase that made the false green readable as a verdict. */
const CLEAN_BILL_PHRASE = /nothing to gate/i;

/** Run the guard, capturing stdout+stderr and the exit code without throwing. */
function runGuard(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('node', [GUARD, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
      killSignal: 'SIGKILL',
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

let tmpDir: string;
let plainFile: string;
let roleDoorFile: string;

beforeAll(() => {
  // OUTSIDE the repo on purpose: never mutate the shared tree to test a guard.
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-check-file-'));

  // A file with NO role-door. In-tree this shape routinely DOES carry census surfaces
  // (a `ui` badge, a `flag` constant) — which is the whole point: role-door silence is
  // not evidence about them.
  plainFile = path.join(tmpDir, 'PlainSurface.tsx');
  fs.writeFileSync(plainFile, 'export const Pane = () => <div>agentPaneKind</div>;\n');

  // Both halves of a role-door (role from external input + reaching a launch primitive),
  // and no gate symbol — so the guard must still fail it.
  roleDoorFile = path.join(tmpDir, 'door.ts');
  fs.writeFileSync(
    roleDoorFile,
    'export async function handler(body: { role: string }) {\n' +
      '  const role = body.role;\n' +
      '  return spawnAgentInHarness(role);\n' +
      '}\n',
  );
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('check-ungated-mug-kettle --check-file: a verdict may not be broader than what it measured', () => {
  it('does NOT report a clean bill when only the role-door family was inspected', () => {
    const { code, out } = runGuard(['--check-file', plainFile]);

    // The exact regression: absence of a role-door reported as a positive verdict.
    expect(out).not.toMatch(CLEAN_BILL_PHRASE);
    // Exit 0 is CORRECT here and must be preserved — no role-door was found, and
    // mutation-probe.sh reads this code. The bug was the PHRASING, not the code.
    expect(code).toBe(0);
  });

  it('names the families it did not inspect, so the reader can tell what was skipped', () => {
    const { out } = runGuard(['--check-file', plainFile]);

    expect(out).toMatch(/NOT A CLEAN BILL/i);
    // Every census family must be named. If a family is added to the census and not
    // here, this fails — which is the point: the disclosure must not silently go stale.
    for (const family of [
      'ui',
      'tool',
      'flag',
      'spawn-role',
      'prompt',
      'wake',
      'system-action',
      'blueprint-launch',
    ]) {
      expect(out).toContain(family);
    }
    // …and it must point at the way to actually check them.
    expect(out).toMatch(/--full/);
  });

  it('REFUSES --full for a path the census cannot see, rather than answering clean', () => {
    // The census walks SCAN_ROOTS under REPO_ROOT, so an out-of-tree copy is invisible.
    // Answering "no census surfaces" here would be this same bug one level up.
    const { code, out } = runGuard(['--check-file', plainFile, '--full']);

    expect(code).toBe(2);
    expect(out).not.toMatch(CLEAN_BILL_PHRASE);
    expect(out).toMatch(/outside the repo/i);
  });

  it('still fails an ungated role-door with exit 1 (mutation-probe.sh reads this code)', () => {
    const { code, out } = runGuard(['--check-file', roleDoorFile]);

    expect(code).toBe(1);
    expect(out).toMatch(/UNGATED ROLE-DOOR/);
  });

  it('still passes a GATED role-door with exit 0', () => {
    const gated = path.join(tmpDir, 'gated-door.ts');
    fs.writeFileSync(
      gated,
      'import { isRetiredTierRole } from "./retired-tier-roles";\n' +
        'export async function handler(body: { role: string }) {\n' +
        '  const role = body.role;\n' +
        '  if (isRetiredTierRole(role)) return null;\n' +
        '  return spawnAgentInHarness(role);\n' +
        '}\n',
    );

    const { code, out } = runGuard(['--check-file', gated]);
    expect(code).toBe(0);
    expect(out).toMatch(/GATED/);
  });

  it('the full guard sets a failing process status when it reports NEW UNGATED findings', () => {
    const source = fs.readFileSync(GUARD, 'utf8');
    const start = source.indexOf('if (offenders.length) {');
    const end = source.indexOf('\nif (activeGuidanceFailed(activeGuidance)) {', start);

    expect(start, 'the full guard must retain its offender-reporting branch').toBeGreaterThan(-1);
    expect(end, 'the offender branch must end before the guidance verdict').toBeGreaterThan(start);
    expect(source.slice(start, end)).toMatch(/process\.exitCode\s*=\s*1/);
  });
});
