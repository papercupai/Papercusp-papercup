/**
 * scripts/pc-heavy.sh — PSI freeze/thaw wall-clock accounting (EI-21903376339103215).
 *
 * A pc-heavy PSI freeze SIGSTOPs the whole admitted process tree without pausing wall clock, so
 * any `Date.now()`-based budget inside the frozen subject (a vitest test's own internal deadline,
 * or `scripts/test-files.mjs`'s own watchdog timers) can report a confident timeout that the
 * freeze — not a genuine defect — produced. Confirmed live 2026-08-30: a 191.4s freeze during the
 * P-012 real-backend acceptance matrix consumed 79.8%/63.8% of two test-internal budgets while the
 * subject was healthy, and the resulting timeout red carried no indication that a freeze had
 * occurred — "the reader has to notice a `PC_HEAVY_ADMISSION status=frozen` line elsewhere in the
 * log and do the arithmetic" (the bug's own words).
 *
 * Fix: pc-heavy now accumulates, per admission, the total wall-clock ms it has spent SIGSTOPped
 * and how many freeze episodes contributed to it, and persists both in the admission record file
 * `${PC_HEAVY_ADMISSION_DIR}/${PC_HEAVY_ADMISSION_ID}.state` it already writes on every state
 * transition. A caller that inherits those two env vars (every direct child does — pc-heavy
 * exports them before spawning) can read the file back after thawing and tell whether — and for
 * how long — IT was frozen, even though it could not observe the freeze while it was happening.
 * `scripts/test-files.mjs` is the first such caller: see its own EI-21903376339103215 comments for
 * how it diffs two readings around one run and stamps a `TEST_FILE_FREEZE_QUALIFIER` line next to
 * any timeout-shaped verdict.
 * Terminal PC_HEAVY_ADMISSION diagnostics retain a snapshot before cleanup deletes the live
 * record, including an ongoing freeze on abort. Disabled/unavailable accounting is explicit.
 *
 * This suite drives real freeze -> thaw transitions via `PC_HEAVY_MEM_PSI_OVERRIDE_FILE` (a file
 * pc-heavy polls for its PSI sample, instead of `/proc/pressure/memory`) so the freeze is
 * deterministic and CI-safe rather than a bet on real memory pressure existing on the box.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pcHeavyFixtureOptions } from './testing/pc-heavy-fixture';

// lib -> operator-core -> packages -> <repo root>
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// ⚠ Every reference to the subject MUST go through this constant — the mutation-probe
// (scripts/mutation-probe.sh) points it at a mutated COPY outside the tree so falsifiability can
// be proven without ever mutating the shared working tree. A suite that honours the override on
// only some paths runs happily against the real file and reports a false "MUTANT SURVIVED".
const PC_HEAVY = process.env.PROBE_SCRIPT || join(ROOT, 'scripts', 'pc-heavy.sh');

let dir = '';
let psiOverrideFile = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pcheavy-freeze-'));
  psiOverrideFile = join(dir, 'psi-sample');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Wait for an OBSERVABLE STATE (a record field, a process exit) instead of guessing a wall-clock
 * duration — a fixed sleep is simultaneously a flake risk under fleet contention (too short) and
 * pure wasted time otherwise (too long). Timing out is a real failure, never a silent fall-through:
 * the assertions after it would run against a world that never got prepared.
 */
async function waitFor(label: string, predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started >= timeoutMs) {
      throw new Error(
        `waitFor(${JSON.stringify(label)}) timed out after ${timeoutMs}ms — the state never arrived.`,
      );
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

function readRecordField(recordFile: string, key: string): string | null {
  if (!existsSync(recordFile)) return null;
  const raw = readFileSync(recordFile, 'utf8');
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=');
    if (eq >= 0 && line.slice(0, eq) === key) return line.slice(eq + 1);
  }
  return null;
}

const ADMISSION_ID = 'test-admission-fixed';

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    PC_HEAVY_DIR: dir,
    PC_HEAVY_IONICE: '', // skip ionice in tests (same hermeticity reasoning as the sibling suite)
    // Fixed, predictable admission id so the test can compute the record file path directly
    // instead of parsing it back out of the child's own environment.
    PC_HEAVY_ADMISSION_ID: ADMISSION_ID,
    PC_HEAVY_PSI_ADMISSION: '1',
    PC_HEAVY_MEM_PSI_OVERRIDE_FILE: psiOverrideFile,
    PC_HEAVY_MEM_PSI_BACKOFF: '5',
    PC_HEAVY_MEM_PSI_RECOVER: '2',
    PC_HEAVY_MEM_PSI_RECOVERY_SEC: '1',
    PC_HEAVY_MEM_PSI_SAMPLE_SEC: '1',
    // No victim-size floor: the fixture's `sleep` child reports no real cgroup memory of its own,
    // and this suite is about freeze-DURATION accounting, not victim election sizing.
    PC_HEAVY_MEM_PSI_MIN_VICTIM_MIB: '0',
    // No scarcity floor either, and for the same reason: this suite is about
    // freeze-DURATION accounting, not the scarcity DECISION. The floor reads the
    // MEMAVAIL override below (4096 GiB — set to keep the admission slot clamp
    // non-binding) and would correctly conclude memory is ample, decline the
    // freeze, and leave the freeze/thaw cases below waiting forever on a
    // state=frozen that never arrives. The decision itself is asserted in
    // pc-heavy-psi-scarcity-gate.test.ts.
    PC_HEAVY_MEM_PSI_MIN_AVAIL_GIB: '0',
    PC_HEAVY_MEMAVAIL_GIB_OVERRIDE: '4096',
    PC_HEAVY_CGROUP_MEMORY_MAX_MIB_OVERRIDE: 'max',
    PC_HEAVY_CGROUP_MEMORY_CURRENT_MIB_OVERRIDE: '100',
    ...extra,
  };
}

function recordFilePath(): string {
  return join(dir, 'psi-admissions', `${ADMISSION_ID}.state`);
}

function startAdmission(extra: Record<string, string> = {}) {
  const finishFile = join(dir, 'finish');
  const startedFile = join(dir, 'started');
  const child = spawn('bash', [PC_HEAVY, 'sh', '-c',
    ': > "$2"; while [ ! -e "$1" ]; do sleep 0.05; done', '_', finishFile, startedFile],
  pcHeavyFixtureOptions(dir, baseEnv(extra)));
  let stderr = '';
  let closed = false;
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const result = new Promise<{ code: number | null; signal: string | null }>((resolveExit, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => { closed = true; resolveExit({ code, signal }); });
  });
  return {
    child, result, startedFile,
    finish: () => writeFileSync(finishFile, ''),
    diagnostics: () => stderr,
    terminal: () => {
      const lines = stderr.split('\n').filter((line) =>
        line.startsWith('PC_HEAVY_ADMISSION ') && line.includes('reason=cleanup '));
      expect(lines, `one terminal snapshot must survive cleanup; stderr: ${stderr}`).toHaveLength(1);
      return Object.fromEntries(lines[0].split(' ').slice(1).map((field) => field.split('=')));
    },
    stop: async () => {
      if (!closed) {
        child.kill('SIGTERM');
        try {
          await waitFor('pc-heavy fixture closed after SIGTERM', () => closed, 10_000);
        } finally {
          if (!closed) child.kill('SIGKILL');
        }
      }
    },
  };
}

describe('pc-heavy PSI freeze accounting persists frozen wall-clock time (EI-21903376339103215)', () => {
  it('is syntactically valid bash', () => {
    expect(() => execFileSync('bash', ['-n', PC_HEAVY], { timeout: 10_000, killSignal: 'SIGKILL' })).not.toThrow();
  });

  it('records frozen_total_ms > 0 and frozen_episodes >= 1 after a real freeze/thaw cycle', async () => {
    // Above PC_HEAVY_MEM_PSI_BACKOFF (5) -> pc-heavy elects this admission as the freeze victim.
    writeFileSync(psiOverrideFile, '10\n');
    const recordFile = recordFilePath();

    const admission = startAdmission();

    try {
      await waitFor('freeze engaged (state=frozen persisted)', () => readRecordField(recordFile, 'state') === 'frozen');

      // Hold a real episode long enough to assert a non-trivial duration.
      await new Promise((r) => setTimeout(r, 1500));

      // Drop below PC_HEAVY_MEM_PSI_RECOVER (2) so pc-heavy thaws it after PC_HEAVY_MEM_PSI_RECOVERY_SEC.
      writeFileSync(psiOverrideFile, '0\n');

      // Read the accounting the INSTANT the state flips back off 'frozen' — pc-heavy's own EXIT
      // trap removes this record file once the whole admission (and its child) terminates
      // (`_psi_remove_record` at cleanup), so waiting for full process exit before reading would
      // race that cleanup and read back a MISSING file — which a naive `Number(null)` silently
      // reads as `0`, indistinguishable from "genuinely never frozen". Read while it still exists.
      await waitFor('thawed (state back to active)', () => readRecordField(recordFile, 'state') === 'active');

      const frozenTotalMsRaw = readRecordField(recordFile, 'frozen_total_ms');
      const frozenEpisodesRaw = readRecordField(recordFile, 'frozen_episodes');
      // Fail LOUDLY on a missing field rather than let `Number(null) === 0` masquerade as a
      // genuine zero-freeze reading — exactly the bug that made this test's first draft pass for
      // the wrong reason (it read the record AFTER cleanup had already deleted it).
      expect(frozenTotalMsRaw, 'frozen_total_ms field must be present in the record file').not.toBeNull();
      expect(frozenEpisodesRaw, 'frozen_episodes field must be present in the record file').not.toBeNull();
      const frozenTotalMs = Number(frozenTotalMsRaw);
      const frozenEpisodes = Number(frozenEpisodesRaw);
      expect(Number.isFinite(frozenTotalMs)).toBe(true);
      expect(frozenTotalMs).toBeGreaterThanOrEqual(1000);
      expect(frozenEpisodes).toBeGreaterThanOrEqual(1);
      admission.finish();
      expect(await admission.result).toEqual({ code: 0, signal: null });
      expect(existsSync(recordFile)).toBe(false);
      expect(admission.terminal()).toMatchObject({
        status: 'completed', admissionId: ADMISSION_ID, freezeMeasurement: 'measured',
        frozenTotalMs: frozenTotalMsRaw, frozenEpisodes: frozenEpisodesRaw, frozenOngoingMs: '0',
      });
    } finally {
      await admission.stop();
    }
  }, 30_000);

  it('records frozen_total_ms=0 / frozen_episodes=0 when PSI never crosses backoff (negative control)', async () => {
    // Always below PC_HEAVY_MEM_PSI_BACKOFF -> this admission is never frozen at all. Proves the
    // new fields are genuinely additive accounting, never a spurious positive on a clean run.
    writeFileSync(psiOverrideFile, '0\n');
    const recordFile = recordFilePath();

    const admission = startAdmission();
    try {
      await waitFor('never-frozen admission registered', () => readRecordField(recordFile, 'state') === 'active');
      expect(readRecordField(recordFile, 'frozen_total_ms')).toBe('0');
      expect(readRecordField(recordFile, 'frozen_episodes')).toBe('0');
      admission.finish();
      expect(await admission.result).toEqual({ code: 0, signal: null });
      expect(existsSync(recordFile)).toBe(false);
      expect(admission.terminal()).toMatchObject({
        status: 'completed', freezeMeasurement: 'measured',
        frozenTotalMs: '0', frozenEpisodes: '0', frozenOngoingMs: '0',
      });
    } finally {
      await admission.stop();
    }
  }, 15_000);

  it('retains an ongoing freeze when aborted and preserves the established signal result', async () => {
    writeFileSync(psiOverrideFile, '10\n');
    const admission = startAdmission();
    try {
      await waitFor('freeze engaged before abort', () => readRecordField(recordFilePath(), 'state') === 'frozen');
      expect(readRecordField(recordFilePath(), 'frozen_total_ms')).toBe('0');
      expect(readRecordField(recordFilePath(), 'frozen_episodes')).toBe('0');
      // Signal the owning monitor, whose TERM trap emits the established 143
      // result. Killing the outer wrapper instead reports SIGTERM to Node and
      // exercises the separate outer-wrapper-exited path.
      const workloadPid = readRecordField(recordFilePath(), 'pid');
      expect(workloadPid).toMatch(/^\d+$/);
      const workloadStat = readFileSync(`/proc/${workloadPid}/stat`, 'utf8');
      const fields = workloadStat.slice(workloadStat.lastIndexOf(')') + 2).split(' ');
      expect(fields[19]).toBe(readRecordField(recordFilePath(), 'start_ticks'));
      const monitorPid = fields[1];
      const monitorArgs = readFileSync(`/proc/${monitorPid}/cmdline`, 'utf8').split('\0');
      expect(monitorArgs.slice(2, 5)).toEqual([
        '--pc-heavy-internal-preempt-run', String(admission.child.pid),
        join(dir, 'exclusive-materialization.intent'),
      ]);
      // The public wrapper runs a private self-snapshot to survive concurrent
      // edits; verify its source rather than assuming the canonical argv path.
      expect(readFileSync(monitorArgs[1], 'utf8')).toBe(readFileSync(PC_HEAVY, 'utf8'));
      process.kill(Number(monitorPid), 'SIGTERM');
      expect((await admission.result).code).toBe(143);
      expect(existsSync(recordFilePath())).toBe(false);
      const terminal = admission.terminal();
      expect(terminal).toMatchObject({ status: 'aborted', freezeMeasurement: 'measured', frozenEpisodes: '1' });
      expect(Number(terminal.frozenOngoingMs)).toBeGreaterThan(0);
      expect(terminal.frozenTotalMs).toBe(terminal.frozenOngoingMs);
      expect(admission.diagnostics().split('\n')).toContain('PC_HEAVY_RESULT status=undetermined reason=signal exit=143');
    } finally {
      await admission.stop();
    }
  }, 30_000);

  it('reports disabled accounting as unknown instead of a measured zero', async () => {
    const admission = startAdmission({ PC_HEAVY_PSI_ADMISSION: '0' });
    try {
      await waitFor('workload started with accounting disabled', () => existsSync(admission.startedFile));
      admission.finish();
      expect(await admission.result).toEqual({ code: 0, signal: null });
      expect(existsSync(recordFilePath())).toBe(false);
      expect(admission.terminal()).toMatchObject({
        status: 'completed', freezeMeasurement: 'disabled',
        frozenTotalMs: 'unknown', frozenEpisodes: 'unknown', frozenOngoingMs: 'unknown',
      });
    } finally {
      await admission.stop();
    }
  }, 15_000);

  it('reports unavailable accounting honestly when the controller cannot initialize', async () => {
    const blockedDirectory = join(dir, 'psi-admissions');
    writeFileSync(blockedDirectory, '');
    const admission = startAdmission();
    try {
      await waitFor('workload started without controller', () => existsSync(admission.startedFile));
      admission.finish();
      expect(await admission.result).toEqual({ code: 0, signal: null });
      expect(admission.terminal()).toMatchObject({
        status: 'completed', freezeMeasurement: 'unavailable',
        frozenTotalMs: 'unknown', frozenEpisodes: 'unknown', frozenOngoingMs: 'unknown',
      });
    } finally {
      await admission.stop();
    }
  }, 15_000);

  it('the persisted fields are named as the caller (scripts/test-files.mjs) expects them', () => {
    // Pins the exact field names against silent rename drift — test-files.mjs's
    // readPcHeavyFrozenTotalMs() parses this literal key. A rename on one side without the other
    // would make the qualifier permanently read as "no freeze", passing silently.
    const source = readFileSync(PC_HEAVY, 'utf8');
    expect(source).toContain("printf 'frozen_total_ms=%s\\n'");
    expect(source).toContain("printf 'frozen_episodes=%s\\n'");
  });
});
