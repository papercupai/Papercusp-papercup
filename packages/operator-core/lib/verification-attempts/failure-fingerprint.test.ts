/**
 * WI-10004032 — the attempt fingerprint must read what harnesses actually print.
 *
 * The loop gate (loop-gate.ts) compares fingerprints across a work item's slow attempts:
 * two failures with DIFFERENT fingerprints, or three with the SAME one, trip it. That only
 * works if the same failure fingerprints the same on every run. The fingerprinter used to
 * look for a `VERIFY_RESULT` line that no harness emits, so every verification-harness
 * adopter fell through to "last error-shaped line" — the HARNESS_RESULT line itself, whose
 * run id and evidence path change per run. Two runs of one failure never compared equal.
 *
 * The strongest check here runs the REAL shell half of the contract (bin/vh.sh) twice and
 * fingerprints its real output, so a format change on either side fails this file instead
 * of silently degrading the gate. The calibration cases keep the "distinct" half honest:
 * a fingerprinter that collapsed everything to one key would pass the equality checks.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatSummaryLine, type HarnessRunResult } from '@papercusp/verification-harness';

// The subject is overridable so falsifiability is proved against a frozen COPY (historical
// mode of scripts/mutation-probe.sh), never by mutating the shared tree.
const { failureFingerprint } = (await import(
  process.env.FAILURE_FINGERPRINT_SUBJECT ?? './failure-fingerprint'
)) as typeof import('./failure-fingerprint');

// lib/verification-attempts → lib → operator-core → packages → <repo root>
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../..');
const VH = path.join(ROOT, 'libs/generic/verification-harness/bin/vh.sh');

/** Run a two-phase shell harness through vh.sh; `failWith` picks the failing phase/reason. */
function runVh(failWith: { phase: 'build' | 'ship'; reason: string }): string {
  const root = mkdtempSync(path.join(tmpdir(), 'fp-vh-'));
  const file = path.join(root, 'h.sh');
  writeFileSync(
    file,
    `set -u
source ${JSON.stringify(VH)}
vh_phase build ""
vh_phase ship build
phase_build() { vh_step compile; ${failWith.phase === 'build' ? `vh_fail ${failWith.reason} "boom"; return 1` : ':'}; }
phase_ship() { vh_step upload; ${failWith.phase === 'ship' ? `vh_fail ${failWith.reason} "boom"; return 1` : ':'}; }
vh_init fp-drill ${JSON.stringify(path.join(root, 'ev'))} || exit 2
vh_run build phase_build
vh_run ship phase_ship
vh_finish
`,
  );
  try {
    return execFileSync('bash', [file], { encoding: 'utf8' });
  } catch (err) {
    return (err as { stdout: string }).stdout;
  }
}

describe('failureFingerprint reads the verification-harness contract line', () => {
  it('two real vh.sh runs of the same failure get the same structured fingerprint', () => {
    const a = runVh({ phase: 'ship', reason: 'upload-timeout' });
    const b = runVh({ phase: 'ship', reason: 'upload-timeout' });
    // Precondition: the runs really differ in their volatile tokens (run id, evidence dir).
    const runIdOf = (out: string) => /HARNESS_RESULT .*\brun=(\S+)/.exec(out)?.[1];
    expect(runIdOf(a)).toBeTruthy();
    expect(a).not.toBe(b);

    const fa = failureFingerprint({ exitCode: 1, logTail: a });
    const fb = failureFingerprint({ exitCode: 1, logTail: b });
    expect(fa.source).toBe('structured');
    expect(fa.structured).toEqual({ phase: 'ship', step: 'upload', reasonCode: 'upload-timeout' });
    expect(fa.fingerprint).toBe(fb.fingerprint);
  });

  it('calibration: a different phase or reason is a different fingerprint', () => {
    const ship = failureFingerprint({ exitCode: 1, logTail: runVh({ phase: 'ship', reason: 'upload-timeout' }) });
    const build = failureFingerprint({ exitCode: 1, logTail: runVh({ phase: 'build', reason: 'upload-timeout' }) });
    const reason = failureFingerprint({ exitCode: 1, logTail: runVh({ phase: 'ship', reason: 'auth-refused' }) });
    expect(new Set([ship.fingerprint, build.fingerprint, reason.fingerprint]).size).toBe(3);
  });

  it('reads the TS runner line too, and ignores a passing verdict', () => {
    const result = (runId: string, verdict: 'fail' | 'pass'): HarnessRunResult =>
      ({
        schemaVersion: 1,
        harness: 'ts-drill',
        runId,
        verdict,
        evidenceDir: `/home/x/ev/${runId}`,
        firstFailure: verdict === 'fail' ? { phase: 'leg-a', step: 'clone', reasonCode: 'clone-timeout' } : null,
        phases: [],
      }) as unknown as HarnessRunResult;
    const one = failureFingerprint({ exitCode: 1, logTail: formatSummaryLine(result('20260930T000001Z-11', 'fail')) });
    const two = failureFingerprint({ exitCode: 1, logTail: formatSummaryLine(result('20260930T010203Z-99', 'fail')) });
    expect(one.source).toBe('structured');
    expect(one.fingerprint).toBe(two.fingerprint);

    // A pass line is the run's verdict and names no failure: the fingerprint comes from the log.
    const passed = failureFingerprint({
      exitCode: 1,
      logTail: `Error: upload refused\n${formatSummaryLine(result('20260930T000001Z-11', 'pass'))}`,
    });
    expect(passed.source).toBe('log');
    expect(passed.label).toMatch(/upload refused/);
  });
});

describe('failureFingerprint reads the hive-git drill summary where the drill prints it', () => {
  const drillLine = (runDir: string) =>
    `  ✗ physical E/G adapter failed (exit 1) in phase D (phase_d): observe did not converge — evidence kept in ${runDir}`;

  it('the embedded drill summary fingerprints the same across runs with different evidence dirs', () => {
    const a = failureFingerprint({
      exitCode: 1,
      logTail: drillLine('/home/u/.papercusp-drill-physical-runs/20260929T233636Z-152216-rc1'),
    });
    const b = failureFingerprint({
      exitCode: 1,
      logTail: drillLine('/home/u/.papercusp-drill-physical-runs/20260930T011502Z-7781-rc1'),
    });
    expect(a.source).toBe('log');
    expect(a.label).toBe('phase D (phase_d): observe did not converge');
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('calibration: a different drill phase is a different fingerprint; the bare summary line still reads', () => {
    const d = failureFingerprint({ exitCode: 1, logTail: drillLine('/r/1') });
    const e = failureFingerprint({
      exitCode: 1,
      logTail: '  ✗ physical E/G adapter failed (exit 1) in phase E (phase_e): observe did not converge — evidence kept in /r/1',
    });
    expect(d.fingerprint).not.toBe(e.fingerprint);
    const bare = failureFingerprint({ exitCode: 1, logTail: 'phase D (phase_d): observe did not converge' });
    expect(bare.fingerprint).toBe(d.fingerprint);
  });
});

// WI-10004209: every failed capability:bash job log ends with the runner's own marker lines.
// Two different drill failures (PDS runs 8 and 9) both fingerprinted to that marker.
describe('failureFingerprint never fingerprints the capability:bash runner markers', () => {
  const jobEnd = (exit: number, at: string) =>
    [
      `[capability:bash] JOB END: status=failed exit=${exit} at ${at} — this line was recorded by the transient-service runner; its file-backed sink survives loss of the operator host and is authoritative for durable output.`,
      `[capability:bash] JOB END: status=failed exit=${exit} at ${at} — this line marks the job reaching an OBSERVED terminal state; if it is ABSENT, no terminal marker has been durably recorded yet: the job may still be running, or it may have died before its close handler wrote JOB END.`,
    ].join('\n');

  it('a log holding only runner markers falls through to the exit code, so different exits differ', () => {
    const run8 = failureFingerprint({ exitCode: 4, exitReason: 'exited', logTail: jobEnd(4, '2026-09-30T07:35:01.000Z') });
    const run9 = failureFingerprint({ exitCode: 1, exitReason: 'exited', logTail: jobEnd(1, '2026-09-30T08:03:44.000Z') });
    expect(run8.source).toBe('exit');
    expect(run8.label).not.toContain('JOB END');
    expect(run8.fingerprint).not.toBe(run9.fingerprint);
  });

  it('the attempt’s own failure line wins over the markers after it', () => {
    const a = failureFingerprint({
      exitCode: 1,
      logTail: `phase A (phase_a_storage_join): Phase A rejected: tower is missing physical device namespace 28d2b6a3 (VM)\n${jobEnd(1, '2026-09-30T09:11:51.000Z')}`,
    });
    const b = failureFingerprint({
      exitCode: 1,
      logTail: `vm git-sync:run failed: MCP_RESULT_TIMEOUT after 120s\n${jobEnd(1, '2026-09-30T08:18:47.000Z')}`,
    });
    expect(a.source).toBe('log');
    expect(a.label).toContain('Phase A rejected');
    expect(b.source).toBe('log');
    expect(b.label).toContain('MCP_RESULT_TIMEOUT');
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('pins the skipped prefix to the markers bash-jobs.ts actually writes', async () => {
    const { RUNNER_MARKER_PREFIX } = await import('./failure-fingerprint');
    const src = readFileSync(path.join(ROOT, 'packages/operator-core/lib/agent-tools/capability/bash-jobs.ts'), 'utf8');
    const markers = [...src.matchAll(/export const JOB_LOG_\w+_MARKER_PREFIX = '([^']+)'/g)].map((m) => m[1]!);
    expect(markers.length).toBeGreaterThanOrEqual(2);
    for (const m of markers) expect(m.startsWith(RUNNER_MARKER_PREFIX)).toBe(true);
  });
});

describe('failureFingerprint never fingerprints passing test lines', () => {
  it.each([
    '✔ the mac leg cannot finish without the provenance its receipt reads as an oracle (Nms)',
    'ok 17 - the mac leg cannot finish without the provenance its receipt reads as an oracle (Nms)',
  ])('falls through when a passing line contains failure-shaped text: %s', (line) => {
    const result = failureFingerprint({ exitCode: 1, exitReason: 'exited', logTail: line });
    expect(result.source).toBe('exit');
    expect(result.label).not.toContain('cannot finish');
  });

  it('still prefers a real error line when a passing line follows it', () => {
    const result = failureFingerprint({
      exitCode: 1,
      logTail: 'Error: upload refused\n✔ the mac leg cannot finish without the provenance its receipt reads as an oracle (Nms)',
    });
    expect(result.source).toBe('log');
    expect(result.label).toContain('upload refused');
  });
});
