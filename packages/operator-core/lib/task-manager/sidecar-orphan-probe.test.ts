/**
 * WI-6554700010011963 — the reaper's orphaned-sidecar class and its /proc probe.
 *
 * Incident: on 2026-10-14 sixteen sidecars (LSP daemons of superseded staging
 * generations) outlived the host that launched them and held ~99 GiB, which
 * pushed the desktop into swap and froze it. Each CAUGHT case below has a CONTROL
 * case, so a regression that widens the class (killing a healthy sidecar) fails
 * here as surely as one that narrows it.
 */
import { describe, expect, it } from 'vitest';

import { censusAgentSessionProgress } from './agent-session-progress-census';
import {
  decideReaps,
  executeReaps,
  REAP_SIDECAR_ORPHAN_GRACE_MS,
  sidecarOrphanReason,
  type ReapDecision,
} from './reaper';
import {
  declaredParentFromEnviron,
  probeSidecarParent,
  sidecarOrphanForPass,
  startTicksFromStat,
  type ProcReader,
} from './sidecar-orphan-probe';
import type { TaskRow } from './types';

const NOW = Date.parse('2026-10-14T07:00:00Z');

function sidecar(taskId: string, partial: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId,
    workspaceId: 'papercusp-workspace',
    rootTaskId: taskId,
    class: 'sidecar',
    title: 'lsp-daemon',
    argv: ['node', 'lsp-daemon.mjs'],
    confined: true,
    state: 'running',
    startedAt: new Date(NOW - 3600_000).toISOString(),
    lastSeenAt: new Date(NOW).toISOString(),
    scopeUnit: `pc-${taskId}--lsp.scope`,
    cgroupPath: null,
    logPath: `/logs/${taskId}.log`,
    pid: 4000,
    detail: {},
    ...partial,
  } as TaskRow;
}

function decide(
  rows: TaskRow[],
  orphanFor: ((row: TaskRow) => { reason: string; firstObservedMs: number } | null | 'unreadable') | undefined,
  pids: Record<string, number | null> = {},
) {
  return decideReaps({
    rows,
    census: censusAgentSessionProgress([], { statMtimeMs: () => null, now: NOW }),
    scopePidCount: (r) => (r.taskId in pids ? pids[r.taskId] : 1),
    freshOwners: new Set(),
    logQuietForMs: () => null,
    ...(orphanFor ? { sidecarOrphanFor: orphanFor } : {}),
    now: NOW,
  });
}

const orphanedSince = (ms: number) => () => ({ reason: 'declared parent pid 1516711 is gone', firstObservedMs: NOW - ms });

describe('orphaned-sidecar reap class (decideReaps)', () => {
  it('CAUGHT: reaps a live sidecar orphaned past the grace window', () => {
    const v = decide([sidecar('a')], orphanedSince(REAP_SIDECAR_ORPHAN_GRACE_MS + 1_000));
    expect(v.reap.map((d) => [d.taskId, d.kind])).toEqual([['a', 'orphaned-sidecar']]);
    expect(v.reap[0].why).toContain('declared parent pid 1516711 is gone');
  });

  it('CONTROL: spares an orphan still inside the grace window (its own watch goes first)', () => {
    const v = decide([sidecar('a')], orphanedSince(5_000));
    expect(v.reap).toEqual([]);
    expect(v.spared.map((s) => s.taskId)).toEqual(['a']);
  });

  it('CONTROL: never reaps a sidecar whose parent is alive', () => {
    expect(decide([sidecar('a')], () => null).reap).toEqual([]);
  });

  it('CONTROL: spares (never reaps) when the parent contract is unreadable', () => {
    const v = decide([sidecar('a')], () => 'unreadable');
    expect(v.reap).toEqual([]);
    expect(v.spared[0].why).toMatch(/unreadable/);
  });

  it('CONTROL: the class is off when no probe is supplied', () => {
    expect(decide([sidecar('a')], undefined).reap).toEqual([]);
  });

  it('CONTROL: an empty or unreadable scope is not reaped', () => {
    expect(decide([sidecar('a')], orphanedSince(10 * 60_000), { a: 0 }).reap).toEqual([]);
    expect(decide([sidecar('a')], orphanedSince(10 * 60_000), { a: null }).reap).toEqual([]);
  });

  it('CONTROL: terminal and exempt sidecar rows are not judged', () => {
    const ended = sidecar('a', { state: 'exited', endedAt: new Date(NOW - 3600_000).toISOString() });
    const exempt = sidecar('b', { detail: { autoReapExempt: true } });
    const v = decide([ended, exempt], orphanedSince(10 * 60_000));
    expect(v.reap).toEqual([]);
  });

  it('CONTROL: the probe is never consulted for agent-session rows', () => {
    const agent = sidecar('a', { class: 'agent-session' });
    let asked = 0;
    decide([agent], () => {
      asked += 1;
      return { reason: 'x', firstObservedMs: 0 };
    });
    expect(asked).toBe(0);
  });

  it('closes the still-running ledger row after a successful stop', async () => {
    const closed: string[] = [];
    const d: ReapDecision = { taskId: 'a', scopeUnit: 'pc-a--lsp.scope', logPath: null, kind: 'orphaned-sidecar', why: 'w' };
    const out = await executeReaps([d], {
      archiveTail: async () => null,
      stopUnit: async () => true,
      closeAsReaped: async (taskId) => {
        closed.push(taskId);
      },
    });
    expect(out[0].ok).toBe(true);
    expect(closed).toEqual(['a']);
  });
});

describe('sidecarOrphanReason (pure)', () => {
  const base = { declaredPid: 77, parentAlive: true, parentStartTicks: 100, sidecarStartTicks: 200 };
  it('alive parent that started before the sidecar is not an orphan', () => {
    expect(sidecarOrphanReason(base)).toBeNull();
  });
  it('dead parent is an orphan', () => {
    expect(sidecarOrphanReason({ ...base, parentAlive: false })).toMatch(/is gone/);
  });
  it('a live pid that started AFTER the sidecar is a recycled pid', () => {
    expect(sidecarOrphanReason({ ...base, parentStartTicks: 300 })).toMatch(/recycled/);
  });
  it('unreadable start times fall back to liveness only', () => {
    expect(sidecarOrphanReason({ ...base, parentStartTicks: null, sidecarStartTicks: null })).toBeNull();
  });
});

function statLine(pid: number, comm: string, startTicks: number): string {
  // 52 fields; field 22 (starttime) is the 20th after "pid (comm) ".
  const after = Array.from({ length: 50 }, (_, i) => (i === 19 ? String(startTicks) : '0'));
  after[0] = 'S';
  return `${pid} (${comm}) ${after.join(' ')}`;
}

function fakeProc(procs: Record<number, { env?: string; start?: number; comm?: string }>): ProcReader {
  return {
    environ: (pid) => procs[pid]?.env ?? (procs[pid] ? '' : null),
    stat: (pid) => (procs[pid] && procs[pid].start !== undefined ? statLine(pid, procs[pid].comm ?? 'node', procs[pid].start!) : null),
    alive: (pid) => pid in procs,
  };
}

describe('the /proc probe', () => {
  it('reads starttime past a comm containing spaces and parens', () => {
    expect(startTicksFromStat(statLine(5, 'tsc (worker) x', 4242))).toBe(4242);
    expect(startTicksFromStat(null)).toBeNull();
  });

  it('extracts the declared parent from a NUL-separated environ', () => {
    expect(declaredParentFromEnviron('A=1\0PAPERCUSP_DESKTOP_PARENT_PID=1516711\0B=2')).toBe(1516711);
    expect(declaredParentFromEnviron('A=1\0B=2')).toBeNull();
    expect(declaredParentFromEnviron('PAPERCUSP_DESKTOP_PARENT_PID=abc')).toBeNull();
  });

  it('no declared parent ⇒ no contract (null), never judged', () => {
    expect(probeSidecarParent(4000, fakeProc({ 4000: { env: 'A=1', start: 10 } }))).toBeNull();
  });

  it('live sidecar with unreadable environ ⇒ unreadable', () => {
    const proc: ProcReader = { environ: () => null, stat: () => null, alive: () => true };
    expect(probeSidecarParent(4000, proc)).toBe('unreadable');
  });

  it('measures a dead declared parent', () => {
    const p = probeSidecarParent(4000, fakeProc({ 4000: { env: 'PAPERCUSP_DESKTOP_PARENT_PID=99', start: 500 } }));
    expect(p).toEqual({ declaredPid: 99, parentAlive: false, parentStartTicks: null, sidecarStartTicks: 500 });
  });
});

describe('sidecarOrphanForPass (first-seen tracking across ticks)', () => {
  const orphanProc = fakeProc({ 4000: { env: 'PAPERCUSP_DESKTOP_PARENT_PID=99', start: 500 } });
  const healthyProc = fakeProc({
    4000: { env: 'PAPERCUSP_DESKTOP_PARENT_PID=99', start: 500 },
    99: { start: 100 },
  });

  it('keeps the FIRST observation time, so the grace window can elapse', () => {
    const seen = new Map<string, number>();
    const r = sidecar('a');
    const t1 = sidecarOrphanForPass([r], NOW, orphanProc, seen)(r);
    const t2 = sidecarOrphanForPass([r], NOW + 90_000, orphanProc, seen)(r);
    expect(t1).toMatchObject({ firstObservedMs: NOW });
    expect(t2).toMatchObject({ firstObservedMs: NOW });
  });

  it('forgets a row that is no longer orphaned', () => {
    const seen = new Map<string, number>();
    const r = sidecar('a');
    sidecarOrphanForPass([r], NOW, orphanProc, seen);
    expect(sidecarOrphanForPass([r], NOW + 1, healthyProc, seen)(r)).toBeNull();
    expect(seen.size).toBe(0);
  });

  it('end to end: first tick spares, a tick past the grace reaps', () => {
    const seen = new Map<string, number>();
    const r = sidecar('a');
    const first = decide([r], sidecarOrphanForPass([r], NOW, orphanProc, seen));
    expect(first.reap).toEqual([]);
    const later = NOW + REAP_SIDECAR_ORPHAN_GRACE_MS + 30_000;
    const v = decideReaps({
      rows: [r],
      census: censusAgentSessionProgress([], { statMtimeMs: () => null, now: later }),
      scopePidCount: () => 2,
      freshOwners: new Set(),
      logQuietForMs: () => null,
      sidecarOrphanFor: sidecarOrphanForPass([r], later, orphanProc, seen),
      now: later,
    });
    expect(v.reap.map((d) => d.kind)).toEqual(['orphaned-sidecar']);
  });
});
