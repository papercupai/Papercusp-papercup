import { describe, expect, it } from 'vitest';

import {
  censusAgentSessionProgress,
  evaluateAgentSessionResidue,
  DEFAULT_QUIET_MS,
  type AgentSessionProgressCensus,
} from './agent-session-progress-census';
import type { TaskRow } from './types';

const NOW = Date.parse('2026-08-23T20:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function row(over: Partial<TaskRow> & { taskId: string }): TaskRow {
  return {
    workspaceId: 'papercusp-workspace',
    rootTaskId: over.taskId,
    class: 'agent-session',
    title: `task ${over.taskId}`,
    argv: [],
    confined: true,
    state: 'running',
    startedAt: new Date(NOW - 48 * HOUR).toISOString(),
    lastSeenAt: new Date(NOW).toISOString(),
    logPath: `/logs/${over.taskId}.log`,
    detail: {},
    ...over,
  } as unknown as TaskRow;
}

/** mtime reader over a fixture map; an absent key means "cannot stat". */
function reader(map: Record<string, number | null>) {
  return (path: string) => (path in map ? map[path] : null);
}

/**
 * THE CONTROL — a deliberately WRONG census, kept permanently.
 *
 * This is the naive implementation the real module exists to avoid: it treats an
 * unreadable log as quiet (collapsing instrument failure into subject absence),
 * ignores the min-age floor, and has no degraded concept. It is never used in
 * production; it is here so the assertions below can be shown to DISCRIMINATE.
 * A test that only exercises the real subject cannot tell a working guard from a
 * vacuous one.
 */
function naiveQuietCount(
  rows: readonly TaskRow[],
  statMtimeMs: (p: string) => number | null,
  now = NOW,
): number {
  let quiet = 0;
  for (const r of rows) {
    if (r.class !== 'agent-session') continue;
    const m = r.logPath ? statMtimeMs(r.logPath) : null;
    if (m === null || now - m > DEFAULT_QUIET_MS) quiet += 1; // ← the bug, on purpose
  }
  return quiet;
}

describe('censusAgentSessionProgress', () => {
  it('bounds dead-headless memory residency to 90 minutes while leaving the presence veto to the reaper', () => {
    expect(DEFAULT_QUIET_MS).toBe(90 * 60 * 1000);
    const census = censusAgentSessionProgress([row({ taskId: 'parked' })], {
      now: NOW,
      statMtimeMs: reader({ '/logs/parked.log': NOW - 91 * 60 * 1000 }),
    });
    expect(census.quietRows.map((entry) => entry.taskId)).toEqual(['parked']);
  });

  it('CALIBRATION: separates a working session from a stalled one', () => {
    const rows = [row({ taskId: 'working' }), row({ taskId: 'stalled' })];
    const census = censusAgentSessionProgress(rows, {
      now: NOW,
      statMtimeMs: reader({
        '/logs/working.log': NOW - 5 * 60 * 1000, // 5 min ago
        '/logs/stalled.log': NOW - 71 * HOUR, // the real 71h residue shape
      }),
    });

    expect(census.active).toBe(1);
    expect(census.quiet).toBe(1);
    expect(census.degraded).toBe(false);
    expect(census.quietRows.map((r) => r.taskId)).toEqual(['stalled']);
    expect(census.quietRows[0].quietMinutes).toBe(71 * 60);
    expect(census.rows.map((entry) => entry.logMtimeMs)).toEqual([NOW - 5 * 60 * 1000, NOW - 71 * HOUR]);
  });

  it('an UNREADABLE log is not counted as quiet — and the naive control gets it wrong', () => {
    const rows = [row({ taskId: 'gone' })];
    const stat = reader({}); // nothing stat-able

    const census = censusAgentSessionProgress(rows, { now: NOW, statMtimeMs: stat });

    expect(census.unreadable).toBe(1);
    expect(census.quiet).toBe(0);
    expect(census.rows[0]?.logMtimeMs).toBeNull();

    // The control DOES miscount it — proving this assertion discriminates.
    expect(naiveQuietCount(rows, stat)).toBe(1);
    expect(census.quiet).not.toBe(naiveQuietCount(rows, stat));
  });

  it('a mostly-unreadable population is DEGRADED, and degraded never reads as ok', () => {
    const rows = [
      row({ taskId: 'a' }),
      row({ taskId: 'b' }),
      row({ taskId: 'c' }),
      row({ taskId: 'measurable' }),
    ];
    const census = censusAgentSessionProgress(rows, {
      now: NOW,
      statMtimeMs: reader({ '/logs/measurable.log': NOW - 60 * 1000 }),
    });

    expect(census.unreadable).toBe(3);
    expect(census.degraded).toBe(true);
    expect(census.degradedReason).toMatch(/UNKNOWN, not as a clean census/);

    const verdict = evaluateAgentSessionResidue(census, 0);
    expect(verdict.verdict).toBe('unknown');
    expect(verdict.verdict).not.toBe('ok');
  });

  it('a freshly-spawned session is never residue, however quiet', () => {
    const rows = [
      row({ taskId: 'newborn', startedAt: new Date(NOW - 30 * 1000).toISOString() }),
    ];
    const census = censusAgentSessionProgress(rows, {
      now: NOW,
      statMtimeMs: reader({}), // no log bytes yet — the normal launch case
    });

    expect(census.tooYoung).toBe(1);
    expect(census.quiet).toBe(0);
    expect(census.unreadable).toBe(0);

    // The control counts the healthy newborn as residue.
    expect(naiveQuietCount(rows, reader({}))).toBe(1);
  });

  it('ignores non-agent-session classes and already-terminal rows', () => {
    const rows = [
      row({ taskId: 'bash', class: 'bash' as TaskRow['class'] }),
      row({ taskId: 'done', state: 'exited' as TaskRow['state'] }),
    ];
    const census = censusAgentSessionProgress(rows, {
      now: NOW,
      statMtimeMs: reader({ '/logs/bash.log': NOW - 99 * HOUR, '/logs/done.log': NOW - 99 * HOUR }),
    });

    expect(census.measured).toBe(0);
    expect(census.quiet).toBe(0);
  });

  it('a row with no log_path is reported separately, not as residue', () => {
    const census = censusAgentSessionProgress([row({ taskId: 'nolog', logPath: null })], {
      now: NOW,
      statMtimeMs: reader({}),
    });
    expect(census.noLog).toBe(1);
    expect(census.quiet).toBe(0);
  });
});

describe('evaluateAgentSessionResidue', () => {
  const clean = (quiet: number): AgentSessionProgressCensus => ({
    rows: Array.from({ length: 90 }, (_, i) => {
      const quietIndex = i - (90 - quiet);
      const isQuiet = quietIndex >= 0;
      return {
        taskId: isQuiet ? `q${quietIndex}` : `a${i}`,
        logPath: isQuiet ? `/logs/q${quietIndex}.log` : `/logs/a${i}.log`,
        logMtimeMs: isQuiet ? NOW - (4260 - quietIndex) * 60_000 : NOW - 5 * 60_000,
        disposition: isQuiet ? 'quiet' as const : 'active' as const,
        quietMinutes: isQuiet ? 4260 - quietIndex : 5,
        startedAt: new Date(NOW - 71 * HOUR).toISOString(),
      };
    }),
    measured: 90,
    active: 90 - quiet,
    quiet,
    tooYoung: 0,
    noLog: 0,
    unreadable: 0,
    quietRows: Array.from({ length: quiet }, (_, i) => ({
      taskId: `q${i}`,
      logPath: `/logs/q${i}.log`,
      logMtimeMs: NOW - (4260 - i) * 60_000,
      disposition: 'quiet' as const,
      quietMinutes: 4260 - i,
      startedAt: new Date(NOW - 71 * HOUR).toISOString(),
    })),
    degraded: false,
    degradedReason: null,
  });

  it('the 2026-08-23 post-reap baseline (90 live, 0 quiet) passes at threshold 0', () => {
    expect(evaluateAgentSessionResidue(clean(0), 0).verdict).toBe('ok');
  });

  it('fires once residue exceeds the threshold, naming the worst offender', () => {
    const result = evaluateAgentSessionResidue(clean(33), 0);
    expect(result.verdict).toBe('exceeded');
    expect(result.quiet).toBe(33);
    expect(result.summary).toContain('q0');
    // The guard must never read as a licence to kill.
    expect(result.summary).toContain('REPORT ONLY');
    expect(result.summary).toContain('processes:kill { taskId }');
  });

  it('tolerates a threshold above the observed count', () => {
    expect(evaluateAgentSessionResidue(clean(2), 5).verdict).toBe('ok');
  });
});
