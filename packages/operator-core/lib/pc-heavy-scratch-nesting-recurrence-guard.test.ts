import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { pcHeavyFixtureOptions } from './testing/pc-heavy-fixture';

/**
 * WI-75008 / plan tmpdir-scratch-leak-nest-and-sweep-2026-08-27 P-004 (WI-519486)
 * — recurrence guard for the pc-heavy.sh scratch leak fixed by P-001
 * (WI-519483, commit f369131625d4).
 *
 * THE INVARIANT THIS GUARDS (plan R-1 / R-7 / R-8): a `pc-heavy.sh` invocation
 * costs the shared TMPDIR AT MOST ONE top-level dirent, no matter how many
 * times it runs, how many temps it mints internally, or how it dies. Before
 * the P-001 fix, every invocation minted its self-copy FLAT at
 * `${TMPDIR:-/tmp}/pc-heavy-self.<pid>.<rand>.sh` — one new top-level entry
 * PER RUN, ~12x/min fleet-wide, which is exactly how `pc-heavy-self.*` grew
 * to 21,504+ entries (WI-75008) and kept growing at ~4,700/hr even after the
 * fix was committed but before it reached the fleet's release checkout (plan
 * D-001 — landing the patch is not shipping it). WI-38830 is on record as
 * this same CLASS of leak recurring precisely BECAUSE it was never guarded by
 * a test ("a guard that has never failed is not yet a guard") — this file is
 * that guard.
 *
 * Falsifiability (WI-75008's own instruction: falsify in both directions, and
 * prove it via scripts/mutation-probe.sh rather than hand-mutating the shared
 * tree): verified 2026-08-28 in copy-out mode against a mutant that forces
 * `_pc_heavy_scratch_mktemp`'s nested-mkdir branch permanently closed
 * (reverting to the pre-P-001 flat-mint behaviour). The "at most one entry"
 * test below CAUGHT it (three invocations left 3 flat entries, not 1) while
 * the "actually mints scratch" control still passed against the SAME mutant
 * (proving the harness genuinely exercises the code path rather than the
 * mutant merely refusing to run) — both directions, one probe run. See the
 * work-item completion evidence for the exact invocation and its verdict.
 */

// Overridable so falsifiability can be proven against a COPY outside the tree
// (scripts/mutation-probe.sh tier 2) without ever mutating the tracked file —
// same mechanism, same env var, that pc-heavy-retry-stdout-isolation.test.ts
// already established for this script.
const SCRIPT = process.env.PC_HEAVY_SCRIPT ?? resolve(__dirname, '../../../scripts/pc-heavy.sh');

interface RunResult {
  stdout: string;
  stderr: string;
  status: number;
}

let isoTmp: string;
let slotDir: string;

beforeEach(() => {
  // A FRESH isolated TMPDIR per test, never the real shared /tmp — this suite
  // asserts a dirent COUNT, so it must be the only writer to the directory it
  // measures, or the count is meaningless.
  isoTmp = mkdtempSync(join(tmpdir(), 'pc-heavy-nest-guard-tmp-'));
  // The flock slot machinery's OWN state dir, isolated from `isoTmp` on
  // purpose: PC_HEAVY_DIR defaults under XDG_RUNTIME_DIR/`/tmp`, independent
  // of TMPDIR, and must not contaminate the top-level count this suite
  // measures, nor contend with the fleet's real heavy-command slots.
  slotDir = mkdtempSync(join(tmpdir(), 'pc-heavy-nest-guard-slots-'));
});

afterEach(() => {
  rmSync(isoTmp, { recursive: true, force: true });
  rmSync(slotDir, { recursive: true, force: true });
});

function runPcHeavy(command: string, label: string): RunResult {
  // Strip every inherited pc-heavy control var. This suite is routinely run BY
  // pc-heavy itself (`npm run test:file` / `test:affected` are both `bash
  // scripts/pc-heavy.sh ...`, and the green-checkpoint gate runs the
  // latter), and an inherited PC_HEAVY_SCRATCH_ROOT or PC_HEAVY_NO_SELF_COPY
  // would silently invalidate the whole measurement. Same defensive shape as
  // pc-heavy-retry-stdout-isolation.test.ts, found there by calibration, not
  // by reasoning.
  //
  // ⚠ The pattern must match the LEADING-UNDERSCORE spelling too. pc-heavy's
  // self-copy latch is `_PC_HEAVY_SELF_COPIED` (pc-heavy.sh:358), which
  // `startsWith('PC_HEAVY_')` does NOT match — so under a parent pc-heavy the
  // latch was inherited, the self-copy block at pc-heavy.sh:355 was skipped
  // entirely, and no `self.*` was ever minted. That silently broke the two
  // tests below while the "at most one entry" test kept passing VACUOUSLY on
  // zero mints — the exact vacuous pass its control exists to catch. Measured
  // 2026-08-29: same invocation, clean env -> `pc-heavy/self.<pid>.<rand>.sh`;
  // with `_PC_HEAVY_SELF_COPIED=1` inherited -> `pc-heavy/` empty.
  const cleanEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^_?PC_HEAVY_/.test(key)) cleanEnv[key] = value;
  }

  const env = {
    ...cleanEnv,
    TMPDIR: isoTmp,
    PC_HEAVY_DIR: slotDir,
    PC_HEAVY_SLOTS: '4',
    // None of these throttles are what this suite is about; disable every
    // one so a busy shared host cannot make the measurement flaky or slow.
    PC_HEAVY_GATE_RESERVE: '0',
    PC_HEAVY_MEM_CLAMP: '0',
    PC_HEAVY_PSI_ADMISSION: '0',
  };

  try {
    const stdout = execFileSync('bash', [SCRIPT, 'sh', '-c', command, label], {
      encoding: 'utf-8',
      timeout: 120_000,
      // stdio 'pipe' matches how every real caller (test:file, test:affected,
      // lint:tsc) actually invokes this script.
      stdio: ['ignore', 'pipe', 'pipe'],
      ...pcHeavyFixtureOptions(isoTmp, env),
    });
    return { stdout, stderr: '', status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', status: err.status ?? -1 };
  }
}

function topLevelEntries(dir: string): string[] {
  return readdirSync(dir).sort();
}

describe('pc-heavy scratch nesting bounds shared TMPDIR growth (plan P-004)', () => {
  it('R-1/R-8: three separate invocations cost the shared TMPDIR exactly ONE new top-level entry, never one per invocation', () => {
    const before = topLevelEntries(isoTmp);
    expect(before, 'the isolated TMPDIR must start empty or this measurement is contaminated').toHaveLength(0);

    for (let i = 0; i < 3; i++) {
      const run = runPcHeavy('true', `guard-run-${i}`);
      expect(run.status, `invocation ${i + 1} must succeed (stderr: ${run.stderr})`).toBe(0);
    }

    const after = topLevelEntries(isoTmp);
    // Pre-P-001 this was 3 — one flat `pc-heavy-self.*` entry per invocation,
    // the exact defect measured in WI-75008 (21,504 entries, ~17k/day).
    // Post-fix it must be exactly 1: the single nested "pc-heavy" parent,
    // reused across every invocation regardless of count.
    expect(
      after,
      'three invocations must leave exactly one top-level entry — the nested "pc-heavy" parent, reused — never one flat entry per run',
    ).toEqual(['pc-heavy']);
  });

  it('control: the invocation actually mints scratch under the nested parent (a no-op run would pass the assertion above vacuously)', () => {
    const run = runPcHeavy('true', 'guard-control');
    expect(run.status, `control invocation must succeed (stderr: ${run.stderr})`).toBe(0);

    const nested = join(isoTmp, 'pc-heavy');
    const entries = readdirSync(nested);
    expect(entries.length, 'the self-copy site must have actually minted scratch under the nested parent').toBeGreaterThan(0);
    expect(
      entries.some((e) => e.startsWith('self.')),
      'the minted entry must carry the "self.<pid>.<rand>.sh" shape the sweep relies on to check creator-pid liveness',
    ).toBe(true);
  });

  it('R-4: fails open to the historical flat shape when the nested parent specifically is blocked, never a hard failure', () => {
    // Occupy "pc-heavy" with a plain FILE so `mkdir -p "$TMPDIR/pc-heavy"`
    // fails with EEXIST while the surrounding TMPDIR stays writable — this
    // isolates R-4's actual failure mode (the nested parent is blocked) from
    // an unrelated one (the whole TMPDIR is unwritable), which would also
    // break the fail-open fallback and prove nothing about R-4 specifically.
    writeFileSync(join(isoTmp, 'pc-heavy'), '');

    const run = runPcHeavy('true', 'guard-fail-open');
    expect(run.status, `a blocked nested parent must still fail OPEN, not refuse to run (stderr: ${run.stderr})`).toBe(0);

    const entries = readdirSync(isoTmp);
    expect(
      entries.some((e) => e.startsWith('pc-heavy-self.')),
      'a blocked nested parent must fall back to the historical flat "pc-heavy-self.*" shape (R-4), keeping the run\'s scratch greppable/diagnosable in the degraded case',
    ).toBe(true);
  });
});
