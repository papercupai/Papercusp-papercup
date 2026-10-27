/**
 * WI-6554700010029556 (owner #2439) — gate.greenCheckpoint.run: is the gate run alive, and
 * what is it doing right now?
 *
 * The properties pinned here are the ones that would silently regress into a confidently
 * wrong status line: an unmeasured reading rendered as "idle", a pid carried from a
 * snapshot of unbounded age, and a stall rule diverging from certifyCheckpointProgress.
 */
import { describe, expect, it } from 'vitest';

import { certifyCheckpointProgress, DEFAULT_STALL_THRESHOLD_MS } from '../release-trace-progress';
import { mapCheckpointRunInFlight } from '../git-pipeline-position';
import {
  assessRunStatus,
  formatDurationSec,
  projectRunStatusCell,
  type RunStatusReading,
} from './run-status-cell';

const NOW = 1_793_041_000_000;
const STARTED = NOW - (2 * 3600 + 10 * 60) * 1000;

const live = (over: Partial<RunStatusReading> = {}): RunStatusReading => ({
  active: true,
  activeSource: 'run-lock',
  pid: 3_596_127,
  candidate: '8c03b5dcd1564d2f',
  candidateSource: 'in-flight-candidate',
  startedAtMs: STARTED,
  elapsedSec: 2 * 3600 + 10 * 60,
  progressAtMs: NOW - 40_000,
  verdictWrittenAtMs: null,
  currentPhase: 'frozen-repair',
  currentActivity: 'repair-tick-legs',
  currentLeg: { label: 'lint:tsc', index: 7, total: 12 },
  asOfAgeMs: 20_000,
  ...over,
});

describe('assessRunStatus — the truth table', () => {
  it('separates an UNMEASURED reading from a measured idle gate', () => {
    expect(assessRunStatus(null, NOW)).toBe('no-run-reading');
    expect(assessRunStatus(undefined, NOW)).toBe('no-run-reading');
    expect(assessRunStatus({ active: false, activeSource: 'run-lock' }, NOW)).toBe('no-run');
  });

  it('reads an advancing run as running', () => {
    expect(assessRunStatus(live(), NOW)).toBe('running');
  });

  it('reads a published verdict as decided-salvaging, however long the run has gone on', () => {
    expect(assessRunStatus(live({ verdictWrittenAtMs: NOW - 30 * 60_000, progressAtMs: NOW - 3 * 3600_000 }), NOW)).toBe(
      'decided-salvaging',
    );
  });

  it('calls a stale heartbeat on a LIVE authority stalled', () => {
    expect(assessRunStatus(live({ progressAtMs: NOW - DEFAULT_STALL_THRESHOLD_MS - 1 }), NOW)).toBe('stalled');
  });

  it('never calls a cache-only stale heartbeat stalled — it cannot tell advancing from wedged', () => {
    const r = live({ activeSource: undefined, pid: undefined, progressAtMs: NOW - DEFAULT_STALL_THRESHOLD_MS - 1 });
    expect(assessRunStatus(r, NOW)).toBe('progress-unknown');
  });

  it('keeps the D-003 start-time fallback collision progress-unknown, never stalled', () => {
    expect(assessRunStatus(live({ progressAtMs: STARTED }), NOW)).toBe('progress-unknown');
  });

  it('agrees with certifyCheckpointProgress on every active reading (no second stall rule)', () => {
    const readings = [
      live(),
      live({ progressAtMs: NOW - DEFAULT_STALL_THRESHOLD_MS - 1 }),
      live({ progressAtMs: STARTED }),
      live({ progressAtMs: null }),
      live({ activeSource: undefined, asOfAgeMs: 10 * 60_000 }),
    ];
    for (const r of readings) {
      const cert = certifyCheckpointProgress(r, NOW);
      const code = assessRunStatus(r, NOW);
      const expected = cert.verdict === 'progressing' ? 'running' : cert.verdict === 'stalled' ? 'stalled' : 'progress-unknown';
      expect(code).toBe(expected);
    }
  });
});

describe('projectRunStatusCell — the published shape', () => {
  it('is always an object, and its unmeasured answer is explicit', () => {
    const p = projectRunStatusCell(null, NOW);
    expect(p).toMatchObject({ code: 'no-run-reading', unmeasured: true, active: null, pid: null, pidVerified: false });
    expect(p.summary).toMatch(/NOT MEASURED/);
    expect(p.summary).toMatch(/NOT "no run in flight"/);
  });

  it('puts liveness, pid, phase, leg, elapsed and heartbeat in ONE line for a live run', () => {
    const p = projectRunStatusCell(live(), NOW);
    expect(p).toMatchObject({
      code: 'running',
      active: true,
      pid: 3_596_127,
      pidVerified: true,
      phase: 'frozen-repair',
      activity: 'repair-tick-legs',
      leg: { label: 'lint:tsc', index: 7, total: 12 },
      progressAgeSec: 40,
    });
    expect(p.summary).toContain('ALIVE (pid 3596127, verified by run-lock)');
    expect(p.summary).toContain('2h10m in');
    expect(p.summary).toContain('leg 7/12 lint:tsc');
    expect(p.summary).toContain('last progress 40s ago');
    expect(p.summary).toContain('judging 8c03b5dcd156');
  });

  it('never reports a pid that no live authority verified on this read', () => {
    const p = projectRunStatusCell(live({ activeSource: undefined }), NOW);
    expect(p.pid).toBeNull();
    expect(p.pidVerified).toBe(false);
    expect(p.summary).toMatch(/liveness not verified on this read/);
  });

  it('reports how the last manual run ended when nothing is in flight', () => {
    const p = projectRunStatusCell(
      {
        active: false,
        activeSource: 'run-lock',
        asOfAgeMs: 500_000,
        terminalEvidence: { observedAtMs: NOW - 3 * 3600_000, serviceResult: 'exit-code', exitStatus: '1', abnormal: true },
      },
      NOW,
    );
    expect(p.code).toBe('no-run');
    expect(p.lastManualRun).toEqual({ abnormal: true, serviceResult: 'exit-code', exitStatus: '1', observedAtMs: NOW - 3 * 3600_000 });
    expect(p.summary).toBe(
      'No gate run is in flight (the live run lock says so on this read). The most recent manual run ended ABNORMALLY (exit-code, exit status 1, 3h ago).',
    );
  });

  it('names the stall and points at diagnosis, not at a second run', () => {
    const p = projectRunStatusCell(live({ progressAtMs: NOW - 15 * 60_000 }), NOW);
    expect(p.code).toBe('stalled');
    expect(p.summary).toMatch(/STALLED/);
    expect(p.summary).toMatch(/never fire a second run/);
  });

  it('flags an in-flight auto-refire so the reader goes to the retriage cell before acting', () => {
    const p = projectRunStatusCell(live({ inRetriageWindow: true }), NOW);
    expect(p.inRetriageWindow).toBe(true);
    expect(p.summary).toMatch(/gate\.greenCheckpoint\.retriage/);
  });
});

describe('mapCheckpointRunInFlight — pid threading', () => {
  it('carries the lock-verified pid onto the mapped leg, and the projection reports it', () => {
    const leg = mapCheckpointRunInFlight(null, NOW, null, { held: true, elapsedSec: 600, source: 'run-lock', pid: 4242 });
    expect(leg).toMatchObject({ active: true, activeSource: 'run-lock', pid: 4242 });
    expect(projectRunStatusCell(leg, NOW)).toMatchObject({ pid: 4242, pidVerified: true });
  });

  it('carries a process-authority pid when the lock is not yet taken', () => {
    const leg = mapCheckpointRunInFlight(null, NOW, null, {
      held: true,
      elapsedSec: 30,
      source: 'process-authority',
      processAuthority: { workspace: 'w', harness: 'papercusp', cgroupPath: '/x', pid: 777 },
    });
    expect(leg).toMatchObject({ active: true, pid: 777 });
  });

  it('attaches no pid when the lock says no run is held', () => {
    const leg = mapCheckpointRunInFlight(null, NOW, null, { held: false, elapsedSec: null, source: 'run-lock' });
    expect(leg).not.toHaveProperty('pid');
    expect(projectRunStatusCell(leg, NOW).code).toBe('no-run');
  });
});

describe('formatDurationSec', () => {
  it('renders the form a human quotes', () => {
    expect(formatDurationSec(45)).toBe('45s');
    expect(formatDurationSec(7 * 60)).toBe('7m');
    expect(formatDurationSec(2 * 3600)).toBe('2h');
    expect(formatDurationSec(2 * 3600 + 10 * 60)).toBe('2h10m');
    expect(formatDurationSec(-5)).toBe('0s');
  });
});
