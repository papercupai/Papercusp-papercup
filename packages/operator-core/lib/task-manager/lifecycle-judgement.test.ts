import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AGENT_ROLES } from '@papercusp/agent-mcp';
import { resolvePromptFile } from '@papercusp/orchestrator/role-prompt';

import {
  LIFECYCLE_IDLE_QUIET_MS,
  LIFECYCLE_JUDGE_BLUEPRINT_ID,
  LIFECYCLE_JUDGE_EXTRAS,
  LIFECYCLE_JUDGE_INTERVAL_MS,
  LIFECYCLE_JUDGE_RETRY_FLOOR_MS,
  LIFECYCLE_JUDGE_ROLE,
  LIFECYCLE_LAUNCHER_ENDED_GRACE_MS,
  LIFECYCLE_UNACCOUNTED_RESIDUE_GRACE_MS,
  enforceLifecycleVerdicts,
  evaluateLifecycleCandidates,
  lifecycleCandidatePayload,
  lifecycleCandidateSummary,
  lifecycleJudgeBrief,
  lifecycleCandidateConditionKey,
  lifecycleJudgeIntervalKey,
  recordLifecycleVerdictAudit,
  runLifecycleJudgementSweep,
  type LifecycleJudgementDeps,
  type LifecycleVerdictAuditRecord,
  type LifecycleVerdictEnforcementDeps,
  type ProcessLifecycleProbe,
  type ProcessLifecycleVerdict,
  type LifecycleLauncherLiveness,
} from './lifecycle-judgement';
import { isRetiredTierRole } from '../pot/retired-tier-roles';
import type { TaskRow } from './types';

const NOW = Date.parse('2026-09-24T06:00:00.000Z');
const HARNESS_DIR = fileURLToPath(new URL('../../../../libs/papercusp/packages/harness', import.meta.url));

function row(over: Partial<TaskRow> = {}): TaskRow {
  return {
    taskId: 'task-a',
    workspaceId: 'ws-1',
    harnessSlug: 'papercusp',
    parentTaskId: null,
    rootTaskId: 'task-a',
    class: 'sidecar',
    title: 'background sidecar',
    argv: ['node', 'sidecar.js'],
    cwd: '/repo',
    launchedBy: 'su-launcher',
    workItemId: null,
    planSlug: null,
    fleetSlug: null,
    sessionId: null,
    scopeUnit: 'pc-taska.scope',
    cgroupPath: '/sys/fs/cgroup/pc-taska.scope',
    pid: 42,
    processIdentity: '42:1',
    confined: true,
    state: 'running',
    exitCode: null,
    exitReason: null,
    terminalProvenance: null,
    startedAt: new Date(NOW - 12 * 60 * 60_000).toISOString(),
    endedAt: null,
    lastSeenAt: new Date(NOW).toISOString(),
    deadlineAt: null,
    logPath: '/logs/task-a.log',
    lastMemoryBytes: 1024,
    peakMemoryBytes: 2048,
    cpuUsec: 100,
    pidsCurrent: 2,
    pidsEventsMax: 0,
    detail: {},
    ...over,
  };
}

function evaluate(input: {
  rows: TaskRow[];
  nowMs?: number;
  residue?: string[];
  launchers?: Array<[string, string | null | LifecycleLauncherLiveness]>;
  verdicts?: Array<[string, ProcessLifecycleVerdict]>;
  logMtimeMs?: number | null;
}) {
  return evaluateLifecycleCandidates({
    rows: input.rows,
    confirmedResidueTaskIds: new Set(input.residue ?? []),
    launcherStates: new Map((input.launchers ?? []).map(([ownerId, state]) => [
      ownerId,
      typeof state === 'string' ? launcherState(state as LifecycleLauncherLiveness['sessionState']) :
        state ?? launcherState(null, { signalMissing: true }),
    ] as const)),
    latestVerdicts: new Map(input.verdicts ?? []),
    statLogMtimeMs: () => input.logMtimeMs ?? null,
    nowMs: input.nowMs ?? NOW,
  });
}

function launcherState(
  sessionState: LifecycleLauncherLiveness['sessionState'],
  over: Partial<LifecycleLauncherLiveness> = {},
): LifecycleLauncherLiveness {
  return {
    sessionState,
    wakeable: sessionState === 'parked',
    liveTurn: sessionState === 'live',
    ...over,
  };
}

describe('evaluateLifecycleCandidates', () => {
  it('requires the launcher-ended condition to persist for 15 minutes across restart-safe probes', () => {
    const first = evaluate({
      rows: [row({ logPath: null })],
      launchers: [['su-launcher', 'ended']],
    });
    expect(first.candidates).toEqual([]);
    expect(first.probeUpdates).toHaveLength(1);
    expect(first.probeUpdates[0].probe.launcherEndedSinceMs).toBe(NOW);

    const second = evaluate({
      rows: [
        row({
          logPath: null,
          detail: { processLifecycleProbe: first.probeUpdates[0].probe },
        }),
      ],
      nowMs: NOW + LIFECYCLE_LAUNCHER_ENDED_GRACE_MS + 1,
      launchers: [['su-launcher', 'ended']],
    });
    expect(second.candidates).toHaveLength(1);
    expect(second.candidates[0].kinds).toContain('launcher-ended');
  });

  it('requires consistent ended liveness and resets the grace clock on parked, contradictory, or unknown evidence', () => {
    const first = evaluate({
      rows: [row({ logPath: null })],
      launchers: [['su-launcher', launcherState('ended')]],
    });
    const priorProbe = first.probeUpdates[0].probe;
    const afterGrace = NOW + LIFECYCLE_LAUNCHER_ENDED_GRACE_MS + 1;

    const parked = evaluate({
      rows: [row({ logPath: null, detail: { processLifecycleProbe: priorProbe } })],
      nowMs: afterGrace,
      launchers: [['su-launcher', launcherState('parked')]],
    });
    expect(parked.candidates).toEqual([]);
    expect(parked.probeUpdates[0].probe.launcherEndedSinceMs).toBeNull();

    const contradictory = evaluate({
      rows: [row({ logPath: null, detail: { processLifecycleProbe: priorProbe } })],
      nowMs: afterGrace,
      launchers: [['su-launcher', launcherState('ended', { wakeable: true })]],
    });
    expect(contradictory.candidates).toEqual([]);
    expect(contradictory.probeUpdates[0].probe.launcherEndedSinceMs).toBeNull();

    const unknown = evaluate({
      rows: [row({ logPath: null, detail: { processLifecycleProbe: priorProbe } })],
      nowMs: afterGrace,
    });
    expect(unknown.candidates).toEqual([]);
    expect(unknown.probeUpdates[0].probe.launcherEndedSinceMs).toBeNull();
  });

  it('uses a readable old log immediately, but a no-log task gets a first-observation baseline', () => {
    const logIdle = evaluate({
      rows: [row()],
      launchers: [['su-launcher', 'live']],
      logMtimeMs: NOW - LIFECYCLE_IDLE_QUIET_MS - 1,
    });
    expect(logIdle.candidates[0].kinds).toEqual(['old-and-idle']);

    const firstNoLog = evaluate({
      rows: [row({ taskId: 'no-log', rootTaskId: 'no-log', logPath: null })],
      launchers: [['su-launcher', 'live']],
    });
    expect(firstNoLog.candidates).toEqual([]);
    expect(firstNoLog.probeUpdates[0].probe.lastActivityAtMs).toBe(NOW);

    const quietProbe: ProcessLifecycleProbe = firstNoLog.probeUpdates[0].probe;
    const later = evaluate({
      rows: [
        row({
          taskId: 'no-log',
          rootTaskId: 'no-log',
          logPath: null,
          detail: { processLifecycleProbe: quietProbe },
        }),
      ],
      nowMs: NOW + LIFECYCLE_IDLE_QUIET_MS + 1,
      launchers: [['su-launcher', 'live']],
    });
    expect(later.candidates[0].kinds).toContain('old-and-idle');
  });

  it('treats CPU movement as activity and does not infer idleness from missing measurements', () => {
    const probe: ProcessLifecycleProbe = {
      version: 1,
      launcherEndedSinceMs: null,
      logPath: null,
      logMtimeMs: null,
      cpuUsec: 100,
      cpuSampledAtMs: NOW - LIFECYCLE_IDLE_QUIET_MS - 1,
      lastActivityAtMs: NOW - LIFECYCLE_IDLE_QUIET_MS - 1,
    };
    const active = evaluate({
      rows: [row({ logPath: null, cpuUsec: 101, detail: { processLifecycleProbe: probe } })],
      launchers: [['su-launcher', 'live']],
    });
    expect(active.candidates).toEqual([]);
    expect(active.probeUpdates[0].probe.lastActivityAtMs).toBe(NOW);

    const unmeasured = evaluate({
      rows: [row({ logPath: null, cpuUsec: null, detail: { processLifecycleProbe: probe } })],
      launchers: [['su-launcher', 'live']],
    });
    expect(unmeasured.candidates).toEqual([]);
  });

  it('labels unaccounted cgroup CPU as unknown, idle, or active from timestamped samples', () => {
    const taskId = 'unaccounted-cpu';
    const firstAt = NOW - 120_000;
    const first = evaluate({
      rows: [row({
        taskId,
        rootTaskId: taskId,
        state: 'unaccounted',
        logPath: null,
        cpuUsec: 100,
        lastSeenAt: new Date(firstAt).toISOString(),
      })],
      residue: [taskId],
      nowMs: NOW,
    });
    const baseline = first.probeUpdates[0]!.probe;
    expect(baseline.cpuSampledAtMs).toBe(firstAt);
    expect(first.candidates[0]!.metrics.cpuActivity).toEqual({
      state: 'unknown',
      previous: null,
      current: { cpuUsec: 100, sampledAtMs: firstAt },
    });

    const idleAt = NOW;
    const idle = evaluate({
      rows: [row({
        taskId,
        rootTaskId: taskId,
        state: 'unaccounted',
        logPath: null,
        cpuUsec: 100,
        lastSeenAt: new Date(idleAt).toISOString(),
        detail: { processLifecycleProbe: baseline },
      })],
      residue: [taskId],
      nowMs: idleAt,
    });
    expect(idle.candidates[0]!.metrics.cpuActivity).toEqual({
      state: 'idle',
      previous: { cpuUsec: 100, sampledAtMs: firstAt },
      current: { cpuUsec: 100, sampledAtMs: idleAt },
    });
    expect(idle.probeUpdates).toEqual([]);

    const activeAt = NOW + 120_000;
    const active = evaluate({
      rows: [row({
        taskId,
        rootTaskId: taskId,
        state: 'unaccounted',
        logPath: null,
        cpuUsec: 101,
        lastSeenAt: new Date(activeAt).toISOString(),
        detail: { processLifecycleProbe: baseline },
      })],
      residue: [taskId],
      nowMs: activeAt,
    });
    expect(active.candidates[0]!.metrics.cpuActivity).toEqual({
      state: 'active',
      previous: { cpuUsec: 100, sampledAtMs: firstAt },
      current: { cpuUsec: 101, sampledAtMs: activeAt },
    });
    expect(active.probeUpdates[0]!.probe).toMatchObject({
      cpuUsec: 101,
      cpuSampledAtMs: activeAt,
      lastActivityAtMs: activeAt,
    });

    const unknownAt = activeAt + 120_000;
    const unknown = evaluate({
      rows: [row({
        taskId,
        rootTaskId: taskId,
        state: 'unaccounted',
        logPath: null,
        cpuUsec: null,
        lastSeenAt: new Date(unknownAt).toISOString(),
        detail: { processLifecycleProbe: active.probeUpdates[0]!.probe },
      })],
      residue: [taskId],
      nowMs: unknownAt,
    });
    expect(unknown.candidates[0]!.metrics.cpuActivity.state).toBe('unknown');
    expect(unknown.probeUpdates[0]!.probe).toMatchObject({ cpuUsec: null, cpuSampledAtMs: null });
  });

  it('selects only confirmed unaccounted/terminal residue and honors the terminal grace', () => {
    const unaccounted = row({ taskId: 'unaccounted', rootTaskId: 'unaccounted', state: 'unaccounted' });
    const terminal = row({
      taskId: 'terminal',
      rootTaskId: 'terminal',
      state: 'exited',
      endedAt: new Date(NOW - 16 * 60_000).toISOString(),
    });
    const youngTerminal = row({
      taskId: 'young-terminal',
      rootTaskId: 'young-terminal',
      state: 'exited',
      endedAt: new Date(NOW - 2 * 60_000).toISOString(),
    });
    const result = evaluate({
      rows: [unaccounted, terminal, youngTerminal],
      residue: ['unaccounted', 'terminal', 'young-terminal'],
    });
    expect(result.candidates.map((candidate) => [candidate.taskId, candidate.kinds])).toEqual([
      ['unaccounted', ['unaccounted-residue']],
      ['terminal', ['terminal-residue']],
    ]);
  });

  it('reports CPU movement for confirmed terminal residue and marks only that probe for terminal persistence', () => {
    const sampledAtMs = NOW - 120_000;
    const prior: ProcessLifecycleProbe = {
      version: 1,
      launcherEndedSinceMs: null,
      logPath: '/logs/terminal-cpu.log',
      logMtimeMs: NOW - 300_000,
      cpuUsec: 100,
      cpuSampledAtMs: sampledAtMs,
      lastActivityAtMs: sampledAtMs,
    };
    const taskId = 'terminal-cpu';
    const result = evaluate({
      rows: [row({
        taskId,
        state: 'stranded',
        endedAt: new Date(NOW - 16 * 60_000).toISOString(),
        lastSeenAt: new Date(NOW).toISOString(),
        cpuUsec: 101,
        detail: { processLifecycleProbe: prior },
      })],
      residue: [taskId],
    });

    expect(result.candidates[0]!.metrics.cpuActivity).toEqual({
      state: 'active',
      previous: { cpuUsec: 100, sampledAtMs },
      current: { cpuUsec: 101, sampledAtMs: NOW },
    });
    expect(result.probeUpdates).toEqual([{
      taskId,
      terminalResidue: true,
      probe: { ...prior, cpuUsec: 101, cpuSampledAtMs: NOW, lastActivityAtMs: NOW },
    }]);
  });

  it('does not file a confirmed unaccounted scope during its first 15 minutes', () => {
    const young = row({
      taskId: 'young-unaccounted',
      rootTaskId: 'young-unaccounted',
      state: 'unaccounted',
      startedAt: new Date(NOW - 91_000).toISOString(),
      pidsCurrent: 25,
    });
    const unknownAge = row({
      taskId: 'unknown-age',
      rootTaskId: 'unknown-age',
      state: 'unaccounted',
      startedAt: 'invalid',
    });
    const confirmed = ['young-unaccounted', 'unknown-age'];
    expect(evaluate({ rows: [young, unknownAge], residue: confirmed }).candidates).toEqual([]);

    const mature = evaluate({
      rows: [young],
      residue: confirmed,
      nowMs: NOW + LIFECYCLE_UNACCOUNTED_RESIDUE_GRACE_MS - 91_000,
    });
    expect(mature.candidates.map((candidate) => candidate.kinds)).toEqual([['unaccounted-residue']]);
  });

  it('serializes a timestamped host-observed positive and keeps the unknown control unknown', () => {
    const observedAt = new Date(NOW).toISOString();
    const confirmedLive = evaluate({
      rows: [row({ taskId: 'confirmed-live', rootTaskId: 'confirmed-live', state: 'unaccounted' })],
      residue: ['confirmed-live'],
    }).candidates[0]!;
    expect(lifecycleCandidatePayload(confirmedLive, observedAt)).toMatchObject({
      taskId: 'confirmed-live',
      liveness: {
        status: 'present',
        source: 'healthy-task-reconcile',
        observedAt,
      },
    });

    const unconfirmed = evaluate({
      rows: [row({ taskId: 'unconfirmed', rootTaskId: 'unconfirmed' })],
      launchers: [['su-launcher', 'live']],
      logMtimeMs: NOW - LIFECYCLE_IDLE_QUIET_MS - 1,
    }).candidates[0]!;
    expect(unconfirmed.kinds).toContain('old-and-idle');
    expect(lifecycleCandidatePayload(unconfirmed, observedAt).liveness).toEqual({
      status: 'unknown',
      source: 'not-established',
      observedAt: null,
    });
  });

  it('gives unaccounted residue a stable exact-scope verification recipe', () => {
    const candidate = evaluate({
      rows: [row({ taskId: 'unaccounted', state: 'unaccounted', scopeUnit: 'pc-unaccounted.scope' })],
      residue: ['unaccounted'],
    }).candidates[0];
    expect(candidate.scopeUnit).toBe('pc-unaccounted.scope');
    const summary = lifecycleCandidateSummary(candidate);
    expect(summary).toContain('payload.processLifecycleCandidate.scopeUnit');
    expect(summary).toContain('processes:list { scopeUnit, live:true }');
    expect(summary).toContain('live.exactScopeUnitMatches');
    expect(summary).toContain('An empty result is not proof by itself');
    expect(summary).toContain('only live.exactScopeUnitMatches entries with kind "unaccounted"');
    expect(summary).toContain('live.unaccountedCount ?? live.unaccounted');
    expect(summary).toContain('live.unaccountedPidCount ?? live.unaccountedPids');
    expect(summary).toContain('If live.unaccountedGroups is missing or not an array, leave the result unknown');
    expect(summary).toContain('never coerce a missing group list to []');
    expect(summary).toContain('When live.unaccountedGroups is non-empty, require a known-present same-kind control from the unfiltered census');
    expect(summary).toContain('processes:list { scopeUnit, live:true, includeEnded:true }');
    expect(summary).toContain('the ageSec-bearing row is terminal and the default tasks[] filter would hide it');
    expect(summary).toContain('When live.unaccountedGroups is empty, the same-kind control prerequisite is structurally unavailable, not a failed read');
    expect(summary).toContain('independently walk the complete, readable Papercusp cgroupfs subtree');
    expect(summary).toContain('complete, readable Papercusp cgroupfs subtree under /sys/fs/cgroup');
    expect(summary).toContain('exact candidate scopeUnit directory absence');
    expect(summary).toContain('populated peer pc-*.scope');
    expect(summary).toContain('Never use stored cgroupPath, /proc absence, detector reason, or empty filtered output');
    expect(summary).toContain('Do not infer death from these shell readings');
    expect(summary).toContain('readlink /proc/self/ns/pid, the visible numeric /proc PID count, and $$ in the same call');
    expect(summary).toContain('if $$ is tiny or only a few PIDs are visible, discard every /proc absence');
    expect(summary).toContain('When live.unaccountedGroups is non-empty, require a known-present same-kind control from the unfiltered census, read it twice, and confirm tasks[].ageSec advances by elapsed wall time');
    expect(summary).toContain('confined:false does not prove abandonment');
    expect(summary).toContain('payload.processLifecycleCandidate.metrics.cpuActivity');
    expect(summary).not.toContain('pc-unaccounted.scope');

    const noScope = { ...candidate, scopeUnit: null };
    expect(lifecycleCandidateSummary(noScope)).toContain('unfiltered processes:list { live:true }');
    expect(lifecycleCandidateSummary(noScope)).toContain('complete live.unaccountedGroups');
  });

  it('does not let a taskId-filtered live read clear terminal residue', () => {
    const candidate = evaluate({
      rows: [row({
        taskId: 'terminal-residue',
        state: 'exited',
        endedAt: new Date(NOW - 16 * 60_000).toISOString(),
        scopeUnit: 'pc-terminal-residue.scope',
      })],
      residue: ['terminal-residue'],
    }).candidates[0]!;
    const expected = [
      'processes:list { taskId, live:true } omits terminal ledger rows by construction because includeEnded defaults false',
      'an empty tasks array is expected even when the old cgroup is still populated',
      'Never treat a taskId-filtered empty result as absence evidence for terminal or unaccounted residue',
      'processes:list { scopeUnit, live:true }',
      'a matching live.exactScopeUnitMatches entry is positive liveness even when the ledger row is terminal',
      'an empty exact-scope result alone remains unknown',
      'If scopeUnit is missing or any required census/control check is unavailable, leave the decision unknown',
    ];

    const summary = lifecycleCandidateSummary(candidate);
    const brief = lifecycleJudgeBrief([{ id: 'EI-1', taskId: candidate.taskId, harnessSlug: 'papercusp' }]);
    for (const guidance of expected) {
      expect(summary).toContain(guidance);
      expect(brief).toContain(guidance);
    }
    expect(brief).toContain('For launcher-ended and old-and-idle only, use processes:list { taskId, live:true }');
    expect(brief).not.toContain('For other kinds, use processes:list { taskId, live:true }');
  });

  it('rejects capability:bash systemd DBus failures as absence evidence', () => {
    const candidate = evaluate({
      rows: [row({ taskId: 'dbus-absence', state: 'unaccounted', scopeUnit: 'pc-dbus-absence.scope' })],
      residue: ['dbus-absence'],
    }).candidates[0]!;
    const guidance = [
      lifecycleCandidateSummary(candidate),
      lifecycleJudgeBrief([{ id: 'EI-DBUS', taskId: candidate.taskId, harnessSlug: 'papercusp' }]),
    ];

    for (const text of guidance) {
      expect(text).toContain('systemctl --user show/list-units from capability:bash cannot reach the user manager D-Bus');
      expect(text).toContain('Failed to connect to bus: Operation not permitted');
      expect(text).toContain('grep -c masks it as exit 0 with a false zero');
      expect(text).toContain('Treat systemd readings from that sandbox as unknown, never unit-absence evidence');
      expect(text).toContain('query a known-present positive control in the same call');
      expect(text).toContain('discard every negative result and leave the verdict unknown');
    }
  });

  it('keeps the claim subject summary stable across reconciliation refreshes', () => {
    const candidate = evaluate({
      rows: [row({ taskId: 'changing-candidate', state: 'unaccounted', scopeUnit: 'pc-changing.scope' })],
      residue: ['changing-candidate'],
    }).candidates[0]!;
    const summary = lifecycleCandidateSummary(candidate);
    const refreshed = {
      ...candidate,
      scopeUnit: 'pc-replaced.scope',
      kinds: ['old-and-idle'] as typeof candidate.kinds,
      reasons: ['the detector reason changed on a later pass'],
      liveness: {
        status: 'present' as const,
        source: 'healthy-task-reconcile' as const,
        observedAt: new Date(NOW + 300_000).toISOString(),
      },
      metrics: {
        ...candidate.metrics,
        cpuActivity: {
          state: 'active' as const,
          previous: { cpuUsec: 100, sampledAtMs: NOW },
          current: { cpuUsec: 110, sampledAtMs: NOW + 300_000 },
        },
      },
    };

    expect(lifecycleCandidateSummary(refreshed)).toBe(summary);
    expect(summary).toContain('payload.processLifecycleCandidate');
    expect(summary).not.toContain(new Date(NOW).toISOString());
    expect(summary).not.toContain('pc-changing.scope');
    expect(summary).not.toContain('unaccounted-residue');
  });

  it('warns the judge that a task-scoped read cannot clear unaccounted residue', () => {
    const brief = lifecycleJudgeBrief([{ id: 'WI-1', taskId: 'unaccounted', harnessSlug: 'papercusp' }]);
    expect(brief).toContain('live.exactScopeUnitMatches');
    expect(brief).toContain('taskId-filtered processes:list result cannot prove absence');
    expect(brief).toContain('When live.unaccountedGroups is non-empty, require a known-present same-kind control from that census');
    expect(brief).toContain('processes:list { scopeUnit, live:true, includeEnded:true }');
    expect(brief).toContain('the ageSec-bearing row is terminal and the default tasks[] filter would hide it');
    expect(brief).toContain('When live.unaccountedGroups is empty, that same-kind control prerequisite is structurally unavailable, not a failed read');
    expect(brief).toContain('recursively enumerate the complete, readable Papercusp slice subtree under /sys/fs/cgroup by exact scopeUnit');
    expect(brief).toContain('a populated peer pc-*.scope elsewhere in that subtree');
    expect(brief).toContain('Never substitute stored cgroupPath, /proc absence, a detector reason, or empty filtered output');
    expect(brief).toContain('inspect only live.exactScopeUnitMatches entries with kind "unaccounted"');
    expect(brief).toContain('When live.unaccountedGroups is non-empty, require a known-present same-kind control from that census');
    expect(brief).toContain('live.ownedTruncated=false');
    expect(brief).toContain('live.unaccountedCount ?? live.unaccounted matching live.unaccountedGroups.length');
    expect(brief).toContain('live.unaccountedPidCount ?? live.unaccountedPids matching the sum of the listed group PIDs');
    expect(brief).toContain('If live.unaccountedGroups is missing or is not an array, leave the result unknown');
    expect(brief).toContain('never coerce a missing group list to []');
    expect(brief).toContain('usage_usec changed between its timestamps');
    expect(brief).toContain('unknown is not dead');
    expect(brief).toContain('cgroup.procs containing only 0 means at least one task is in the cgroup but hidden from that PID namespace');
    expect(brief).toContain('pids.current counts kernel tasks (including threads), not task-manager process rows');
    expect(brief).toContain('HTTP 502 is not ECONNREFUSED (curl exit 7)');
    expect(brief).toContain('readlink /proc/self/ns/pid, the visible numeric /proc PID count, and $$ in that same call');
    expect(brief).toContain('read it twice, and confirm tasks[].ageSec advances by elapsed wall time');
    expect(brief).toContain('confined:false does not prove abandonment');
  });

  it('excludes agent sessions and human-terminal auto-reap exemptions', () => {
    const result = evaluate({
      rows: [
        row({ taskId: 'agent', rootTaskId: 'agent', class: 'agent-session', state: 'unaccounted' }),
        row({ taskId: 'human', rootTaskId: 'human', state: 'unaccounted', detail: { autoReapExempt: true } }),
      ],
      residue: ['agent', 'human'],
    });
    expect(result.candidates).toEqual([]);
  });

  it('suppresses a keep verdict only until its explicit recheck date', () => {
    const candidate = row({ taskId: 'kept', rootTaskId: 'kept', state: 'unaccounted' });
    const keep: ProcessLifecycleVerdict = {
      taskId: 'kept',
      decision: 'keep',
      reason: 'serves a live tenant',
      keepCount: 2,
      recheckAt: new Date(NOW + 60_000).toISOString(),
    };
    const suppressed = evaluate({ rows: [candidate], residue: ['kept'], verdicts: [['kept', keep]] });
    expect(suppressed.candidates).toEqual([]);
    expect(suppressed.suppressedByKeep).toEqual(['kept']);

    const due = evaluate({
      rows: [candidate],
      residue: ['kept'],
      verdicts: [['kept', keep]],
      nowMs: NOW + 60_001,
    });
    expect(due.candidates).toHaveLength(1);
    expect(due.candidates[0].previousVerdict).toEqual(keep);
  });

  it('suppresses a gone verdict permanently instead of refiling the same task', () => {
    const candidate = row({ taskId: 'gone', rootTaskId: 'gone', state: 'unaccounted' });
    const gone: ProcessLifecycleVerdict = {
      taskId: 'gone',
      decision: 'gone',
      reason: 'fresh inventory found no process',
      keepCount: 0,
      recheckAt: null,
    };
    const result = evaluate({ rows: [candidate], residue: ['gone'], verdicts: [['gone', gone]] });
    expect(result.candidates).toEqual([]);
    expect(result.suppressedByVerdict).toEqual(['gone']);
  });
});

describe('enforceLifecycleVerdicts', () => {
  const killVerdict = (taskId: string): ProcessLifecycleVerdict => ({
    taskId,
    decision: 'kill',
    reason: 'fresh evidence says this task should end',
    keepCount: 0,
    recheckAt: null,
  });

  function enforcementDeps(over: Partial<LifecycleVerdictEnforcementDeps> = {}): LifecycleVerdictEnforcementDeps {
    return {
      loadTask: async () => null,
      killTask: async (taskId) => ({ ok: true, taskId, action: 'kill' }),
      killScopeUnit: async (scopeUnit) => ({ ok: true, scopeUnit, action: 'kill' }),
      ...over,
    };
  }

  it('routes an unaccounted row only through its exact scope unit', async () => {
    const killTask = vi.fn();
    const killScopeUnit = vi.fn(async (scopeUnit: string) => ({ ok: true as const, scopeUnit, action: 'kill' }));
    const outcome = await enforceLifecycleVerdicts(
      new Map([['orphan', killVerdict('orphan')]]),
      enforcementDeps({
        loadTask: async () =>
          row({ taskId: 'orphan', rootTaskId: 'orphan', state: 'unaccounted', scopeUnit: 'pc-orphan.scope' }),
        killTask,
        killScopeUnit,
      }),
    );
    expect(killScopeUnit).toHaveBeenCalledWith('pc-orphan.scope');
    expect(killTask).not.toHaveBeenCalled();
    expect(outcome[0]).toMatchObject({ target: 'scope-unit', targetId: 'pc-orphan.scope', settled: true });
  });

  it('writes a durable audit intent before scope-unit signalling and settles it with the outcome', async () => {
    const records: LifecycleVerdictAuditRecord[] = [];
    const recordAudit = vi.fn(async (record: LifecycleVerdictAuditRecord) => {
      records.push(record);
      return record.auditId ?? 'audit-row-1';
    });
    const killScopeUnit = vi.fn(async (scopeUnit: string) => {
      expect(records.map((record) => record.phase)).toEqual(['intent']);
      return { ok: true as const, scopeUnit, action: 'kill' };
    });
    const outcome = await enforceLifecycleVerdicts(
      new Map([['orphan', killVerdict('orphan')]]),
      enforcementDeps({
        loadTask: async () =>
          row({ taskId: 'orphan', rootTaskId: 'orphan', state: 'unaccounted', scopeUnit: 'pc-orphan.scope' }),
        killScopeUnit,
        recordAudit,
      }),
      { workspaceId: 'ws-1', harnessSlug: 'papercusp' },
    );

    expect(killScopeUnit).toHaveBeenCalledWith('pc-orphan.scope');
    expect(outcome[0]).toMatchObject({ target: 'scope-unit', targetId: 'pc-orphan.scope', settled: true });
    expect(records.map((record) => record.phase)).toEqual(['intent', 'outcome']);
    expect(records[0]).toMatchObject({ phase: 'intent', taskId: 'orphan', target: 'scope-unit' });
    expect(records[1]).toMatchObject({
      phase: 'outcome',
      auditId: 'audit-row-1',
      outcome: { settled: true, signalled: true },
    });
  });

  it('does not signal a scope unit when its audit intent cannot be written', async () => {
    const killScopeUnit = vi.fn();
    const recordAudit = vi.fn(async () => {
      throw new Error('audit unavailable');
    });

    await expect(
      enforceLifecycleVerdicts(
        new Map([['orphan', killVerdict('orphan')]]),
        enforcementDeps({
          loadTask: async () =>
            row({ taskId: 'orphan', rootTaskId: 'orphan', state: 'unaccounted', scopeUnit: 'pc-orphan.scope' }),
          killScopeUnit,
          recordAudit,
        }),
        { workspaceId: 'ws-1', harnessSlug: 'papercusp' },
      ),
    ).rejects.toThrow('audit unavailable');
    expect(killScopeUnit).not.toHaveBeenCalled();
  });

  it('inserts and settles lifecycle audit rows in the workspace audit log', async () => {
    const calls: Array<{ query: string; values: unknown[] }> = [];
    const sql = {
      unsafe: vi.fn(async (query: string, values: unknown[] = []) => {
        calls.push({ query, values });
        return [{ id: String(values[0]) }];
      }),
    } as never;
    const intent = {
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      taskId: 'orphan',
      verdict: killVerdict('orphan'),
      target: 'scope-unit' as const,
      targetId: 'pc-orphan.scope',
      phase: 'intent' as const,
    };
    const auditId = await recordLifecycleVerdictAudit(intent, sql);
    const outcome = {
      taskId: 'orphan',
      decision: 'kill' as const,
      target: 'scope-unit' as const,
      targetId: 'pc-orphan.scope',
      settled: true,
      signalled: true,
      reapTerminalResidue: false,
    };
    await recordLifecycleVerdictAudit({ ...intent, phase: 'outcome', auditId, outcome }, sql);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.query).toContain('INSERT INTO harness_shared.audit_log');
    expect(calls[0]?.values[2]).toBe('system:task-manager');
    expect(calls[0]?.values[3]).toBe('task.lifecycle.verdict');
    expect(calls[0]?.values[4]).toBe('orphan');
    expect(calls[0]?.values[6]).toBe('ws-1');
    expect(JSON.parse(String(calls[0]?.values[5]))).toMatchObject({
      phase: 'intent',
      taskId: 'orphan',
      harnessSlug: 'papercusp',
      target: 'scope-unit',
      targetId: 'pc-orphan.scope',
    });
    expect(calls[1]?.query).toContain('UPDATE harness_shared.audit_log SET details');
    expect(calls[1]?.values[0]).toBe(auditId);
    expect(JSON.parse(String(calls[1]?.values[1]))).toMatchObject({
      phase: 'outcome',
      outcome: { settled: true, signalled: true },
    });
  });

  it('routes an owned row by task id and positively re-verifies terminal residue', async () => {
    const taskKill = vi.fn(async (taskId: string, opts: { reapTerminalResidue?: boolean }) => ({
      ok: true as const,
      taskId,
      action: 'kill',
      detail: String(Boolean(opts.reapTerminalResidue)),
    }));
    const deps = enforcementDeps({ killTask: taskKill });
    deps.loadTask = async (taskId) =>
      row({
        taskId,
        rootTaskId: taskId,
        state: taskId === 'terminal' ? 'exited' : 'running',
        endedAt: taskId === 'terminal' ? new Date(NOW - 60_000).toISOString() : null,
      });

    const outcomes = await enforceLifecycleVerdicts(
      new Map([
        ['owned', killVerdict('owned')],
        ['terminal', killVerdict('terminal')],
      ]),
      deps,
    );
    expect(taskKill).toHaveBeenNthCalledWith(1, 'owned', { reapTerminalResidue: false });
    expect(taskKill).toHaveBeenNthCalledWith(2, 'terminal', { reapTerminalResidue: true });
    expect(outcomes.map((outcome) => [outcome.taskId, outcome.target, outcome.reapTerminalResidue])).toEqual([
      ['owned', 'task-id', false],
      ['terminal', 'task-id', true],
    ]);
  });
});

function depsForRunner(over: Partial<LifecycleJudgementDeps> = {}): LifecycleJudgementDeps {
  return {
    loadRows: async () => [],
    resolveLauncherStates: async () => new Map(),
    statLogMtimeMs: () => null,
    readLatestVerdicts: async () => new Map(),
    enforceVerdicts: async () => [],
    persistProbes: async (updates) => updates.length,
    upsertCandidate: async (_key, candidate) => ({ id: `WI-${candidate.taskId}` }),
    listOpenCandidateItems: async () => [],
    claimOpenCandidateItems: async (items) => items.map((item) => ({ ...item })),
    releaseCandidateItems: async () => {},
    spawnJudge: async () => ({ ok: true, spawnId: 'spawn-1' }),
    ...over,
  };
}

describe('runLifecycleJudgementSweep', () => {
  it('files one condition-keyed item per task and hands every open item to one interval-idempotent judge', async () => {
    const candidate = row({ taskId: 'residue-a', rootTaskId: 'residue-a', state: 'unaccounted' });
    const upsert = vi.fn(async (_key: string, c: { taskId: string }) => ({ id: `WI-${c.taskId}` }));
    const actualLaunches = new Set<string>();
    const spawn = vi.fn(async (input: Parameters<LifecycleJudgementDeps['spawnJudge']>[0]) => {
      const deduped = actualLaunches.has(input.idempotencyKey);
      actualLaunches.add(input.idempotencyKey);
      return { ok: true, spawnId: 'spawn-1', deduped };
    });
    const deps = depsForRunner({
      loadRows: async () => [candidate],
      upsertCandidate: upsert as LifecycleJudgementDeps['upsertCandidate'],
      listOpenCandidateItems: async () => [
        { id: 'WI-residue-a', taskId: 'residue-a', harnessSlug: 'papercusp' },
        { id: 'WI-left-open', taskId: 'older-task', harnessSlug: 'other-harness' },
      ],
      spawnJudge: spawn as LifecycleJudgementDeps['spawnJudge'],
    });

    const input = {
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
      confirmedResidueTaskIds: ['residue-a'],
      nowMs: NOW,
    };
    const first = await runLifecycleJudgementSweep(input, deps);
    const replay = await runLifecycleJudgementSweep(input, deps);

    expect(upsert).toHaveBeenCalledWith(
      lifecycleCandidateConditionKey('residue-a'),
      expect.objectContaining({ taskId: 'residue-a' }),
      'papercusp',
    );
    expect(first.openItems).toEqual(['WI-residue-a', 'WI-left-open']);
    expect(first.judge.idempotencyKey).toBe(lifecycleJudgeIntervalKey('ws-1', NOW));
    expect(replay.judge.idempotencyKey).toBe(first.judge.idempotencyKey);
    expect(actualLaunches.size).toBe(1);
    expect(spawn.mock.calls[0][0].brief).toContain('WI-left-open | taskId=older-task');
    expect(spawn.mock.calls[0][0].brief).toContain('NEVER signal a process');
    // vacuous-negative-ok: the judge must never be told to kill processes; pins the retired instruction out
    expect(spawn.mock.calls[0][0].brief).not.toContain('call processes:kill with');
  });

  it('changes the launch key only when the one-hour interval changes', () => {
    const current = lifecycleJudgeIntervalKey('ws-1', NOW);
    expect(current).toMatch(/^process-lifecycle-judge:v5:ws-1:/);
    expect(lifecycleJudgeIntervalKey('ws-1', NOW + LIFECYCLE_JUDGE_INTERVAL_MS - 1)).toBe(current);
    expect(lifecycleJudgeIntervalKey('ws-1', NOW + LIFECYCLE_JUDGE_INTERVAL_MS)).not.toBe(current);
  });

  it('preclaims candidates before spawn so the next hourly sweep skips them', async () => {
    const candidate = {
      id: 'WI-open',
      taskId: 'task-open',
      harnessSlug: 'papercusp',
      takenBy: null,
      assignee: null,
    };
    const order: string[] = [];
    let claimedBy: string | null = null;
    const claim = vi.fn(async (
      items: Parameters<LifecycleJudgementDeps['claimOpenCandidateItems']>[0],
      assignee: Parameters<LifecycleJudgementDeps['claimOpenCandidateItems']>[1],
    ) => {
      order.push('claim');
      claimedBy = assignee;
      return items.map((item) => ({ ...item, takenBy: assignee, assignee }));
    });
    const spawn = vi.fn(async (input: Parameters<LifecycleJudgementDeps['spawnJudge']>[0]) => {
      order.push('spawn');
      return { ok: true, spawnId: input.spawnId };
    });
    const deps = depsForRunner({
      listOpenCandidateItems: async () => [{ ...candidate, takenBy: claimedBy, assignee: claimedBy }],
      claimOpenCandidateItems: claim,
      spawnJudge: spawn,
    });

    const first = await runLifecycleJudgementSweep(
      { workspaceId: 'ws-1', harnessSlug: 'papercusp', nowMs: NOW },
      deps,
    );
    const nextHour = await runLifecycleJudgementSweep(
      { workspaceId: 'ws-1', harnessSlug: 'papercusp', nowMs: NOW + LIFECYCLE_JUDGE_INTERVAL_MS },
      deps,
    );

    const spawnId = spawn.mock.calls[0]![0].spawnId;
    const judgeOwnerId = `system:operator/${spawnId}`;
    expect(order).toEqual(['claim', 'spawn']);
    expect(claim).toHaveBeenCalledWith([candidate], judgeOwnerId);
    expect(claim.mock.calls[0]![1]).toBe(judgeOwnerId);
    expect(spawn.mock.calls[0]![0].spawnId).toBe(spawnId);
    expect(first.openItems).toEqual(['WI-open']);
    expect(first.judge.attempted).toBe(true);
    expect(nextHour.openItems).toEqual([]);
    expect(nextHour.judge.attempted).toBe(false);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('compare-and-releases its preclaim when child spawn fails', async () => {
    const candidate = {
      id: 'WI-open',
      taskId: 'task-open',
      harnessSlug: 'papercusp',
      takenBy: null,
      assignee: null,
    };
    const order: string[] = [];
    const claim = vi.fn(async (
      items: Parameters<LifecycleJudgementDeps['claimOpenCandidateItems']>[0],
      assignee: Parameters<LifecycleJudgementDeps['claimOpenCandidateItems']>[1],
    ) => {
      order.push('claim');
      return items.map((item) => ({ ...item, takenBy: assignee, assignee }));
    });
    const spawn = vi.fn(async (_input: Parameters<LifecycleJudgementDeps['spawnJudge']>[0]) => {
      order.push('spawn');
      return { ok: false, spawnId: null, error: 'child boot failed' };
    });
    const release = vi.fn(async (
      _items: Parameters<LifecycleJudgementDeps['releaseCandidateItems']>[0],
      _expectedAssignee: Parameters<LifecycleJudgementDeps['releaseCandidateItems']>[1],
    ) => {
      order.push('release');
    });
    await runLifecycleJudgementSweep(
      { workspaceId: 'ws-1', harnessSlug: 'papercusp', nowMs: NOW },
      depsForRunner({
        listOpenCandidateItems: async () => [candidate],
        claimOpenCandidateItems: claim,
        releaseCandidateItems: release,
        spawnJudge: spawn,
      }),
    );

    const spawnId = spawn.mock.calls[0]![0].spawnId;
    const judgeOwnerId = `system:operator/${spawnId}`;
    expect(order).toEqual(['claim', 'spawn', 'release']);
    expect(claim).toHaveBeenCalledWith([candidate], judgeOwnerId);
    expect(release).toHaveBeenCalledWith(
      [{ ...candidate, takenBy: judgeOwnerId, assignee: judgeOwnerId }],
      judgeOwnerId,
    );
    expect(spawn.mock.calls[0]![0].spawnId).toBe(spawnId);
  });

  it('does not launch a second judge across an interval boundary for candidates claimed in either work-item family', async () => {
    const spawn = vi.fn(async (_input: Parameters<LifecycleJudgementDeps['spawnJudge']>[0]) =>
      ({ ok: true, spawnId: 'spawn-free' }));
    const result = await runLifecycleJudgementSweep(
      { workspaceId: 'ws-1', harnessSlug: 'papercusp', nowMs: NOW + LIFECYCLE_JUDGE_INTERVAL_MS },
      depsForRunner({
        listOpenCandidateItems: async () => [
          { id: 'WI-held-a', taskId: 'task-a', harnessSlug: 'papercusp', takenBy: 'queen-a' },
          { id: 'WI-held-b', taskId: 'task-b', harnessSlug: 'papercusp', assignee: 'queen-a' },
          { id: 'WI-free', taskId: 'task-c', harnessSlug: 'papercusp', takenBy: null },
        ],
        spawnJudge: spawn,
      }),
    );
    expect(result.openItems).toEqual(['WI-free']);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0][0].brief).toContain('WI-free | taskId=task-c');
    expect(spawn.mock.calls[0][0].brief).not.toContain('WI-held');
  });

  it('skips dispatch entirely while all open candidates are claimed, retaining reaper recovery', async () => {
    const spawn = vi.fn(async () => ({ ok: true, spawnId: 'unwanted' }));
    const result = await runLifecycleJudgementSweep(
      { workspaceId: 'ws-1', harnessSlug: 'papercusp', nowMs: NOW + LIFECYCLE_JUDGE_INTERVAL_MS },
      depsForRunner({
        listOpenCandidateItems: async () => [
          { id: 'WI-held-feature', taskId: 'task-a', harnessSlug: 'papercusp', takenBy: 'queen-a' },
          { id: 'WI-held-issue', taskId: 'task-b', harnessSlug: 'papercusp', assignee: 'queen-a' },
        ],
        spawnJudge: spawn,
      }),
    );
    expect(result.openItems).toEqual([]);
    expect(result.judge.attempted).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    const source = readFileSync(new URL('./lifecycle-judgement.ts', import.meta.url), 'utf8');
    expect(source).toContain("AND (taken_by IS NULL OR taken_by = '')");
    // WI-10005157: this used to pin an assignee predicate, but harness_shared.work_items has
    // no assignee column (only the engineer_issues view does), so every real pass threw 42703.
    // The real-schema guard is lifecycle-judgement.integration.test.ts.
    expect(source).not.toMatch(/AND \(assignee IS NULL/);
  });

  it('launches for an earlier open candidate even when this sweep finds no current candidate', async () => {
    const spawn = vi.fn(async () => ({ ok: true, spawnId: 'spawn-existing' }));
    const result = await runLifecycleJudgementSweep(
      { workspaceId: 'ws-1', harnessSlug: 'papercusp', nowMs: NOW },
      depsForRunner({
        listOpenCandidateItems: async () => [{ id: 'WI-existing', taskId: 'existing-task', harnessSlug: 'papercusp' }],
        spawnJudge: spawn,
      }),
    );
    expect(result.candidates).toBe(0);
    expect(result.judge.attempted).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('does not refile or relaunch a successfully enforced kill verdict in the same sweep', async () => {
    const candidate = row({ taskId: 'settled-kill', rootTaskId: 'settled-kill', state: 'unaccounted' });
    const upsert = vi.fn();
    const spawn = vi.fn(async () => ({ ok: true, spawnId: 'should-not-spawn' }));
    const verdict: ProcessLifecycleVerdict = {
      taskId: 'settled-kill',
      decision: 'kill',
      reason: 'confirmed residue',
      keepCount: 0,
      recheckAt: null,
    };
    const result = await runLifecycleJudgementSweep(
      {
        workspaceId: 'ws-1',
        harnessSlug: 'papercusp',
        confirmedResidueTaskIds: ['settled-kill'],
        nowMs: NOW,
      },
      depsForRunner({
        loadRows: async () => [candidate],
        readLatestVerdicts: async () => new Map([['settled-kill', verdict]]),
        enforceVerdicts: async () => [
          {
            taskId: 'settled-kill',
            decision: 'kill',
            target: 'scope-unit',
            targetId: 'pc-settled-kill.scope',
            settled: true,
            signalled: true,
            reapTerminalResidue: false,
          },
        ],
        upsertCandidate: upsert,
        listOpenCandidateItems: async () => [
          { id: 'WI-stale-open', taskId: 'settled-kill', harnessSlug: 'papercusp' },
        ],
        spawnJudge: spawn,
      }),
    );
    expect(result.candidates).toBe(0);
    expect(result.suppressedByVerdict).toBe(1);
    expect(result.openItems).toEqual([]);
    expect(upsert).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('loads and honors a keep verdict for a recovered open item missing from current task rows', async () => {
    const verdict: ProcessLifecycleVerdict = {
      taskId: 'recovered-task',
      decision: 'keep',
      reason: 'still active',
      keepCount: 4,
      recheckAt: new Date(NOW + LIFECYCLE_JUDGE_RETRY_FLOOR_MS).toISOString(),
      decidedAt: new Date(NOW - 2 * LIFECYCLE_JUDGE_RETRY_FLOOR_MS).toISOString(),
    };
    const readLatest = vi.fn(async (_workspaceId: string, taskIds: readonly string[]) =>
      taskIds.includes('recovered-task')
        ? new Map([['recovered-task', verdict]])
        : new Map<string, ProcessLifecycleVerdict>());
    const claim = vi.fn(async (items: Parameters<LifecycleJudgementDeps['claimOpenCandidateItems']>[0]) =>
      items.map((item) => ({ ...item })));
    const spawn = vi.fn(async (input: Parameters<LifecycleJudgementDeps['spawnJudge']>[0]) =>
      ({ ok: true, spawnId: input.spawnId }));
    const result = await runLifecycleJudgementSweep(
      { workspaceId: 'ws-1', harnessSlug: 'papercusp', nowMs: NOW },
      depsForRunner({
        readLatestVerdicts: readLatest,
        listOpenCandidateItems: async () => [{
          id: 'WI-recovered',
          taskId: 'recovered-task',
          harnessSlug: 'papercusp',
          lastReleasedAt: new Date(NOW - 2 * LIFECYCLE_JUDGE_RETRY_FLOOR_MS),
        }],
        claimOpenCandidateItems: claim,
        spawnJudge: spawn,
      }),
    );

    expect(readLatest.mock.calls.map((call) => call[1])).toEqual([[], ['recovered-task']]);
    expect(result.suppressedByKeep).toBe(1);
    expect(result.suppressedByRetryFloor).toBe(0);
    expect(result.openItems).toEqual([]);
    expect(claim).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('prevents a second recovered-row claim under a new judge owner after a recent release', async () => {
    let lastReleasedAt = new Date(NOW - 2 * LIFECYCLE_JUDGE_RETRY_FLOOR_MS);
    const claimOwners: string[] = [];
    const claim = vi.fn(async (
      items: Parameters<LifecycleJudgementDeps['claimOpenCandidateItems']>[0],
      assignee: Parameters<LifecycleJudgementDeps['claimOpenCandidateItems']>[1],
    ) => {
      claimOwners.push(assignee);
      return items.map((item) => ({ ...item, takenBy: assignee, assignee }));
    });
    const spawn = vi.fn(async (input: Parameters<LifecycleJudgementDeps['spawnJudge']>[0]) =>
      ({ ok: true, spawnId: input.spawnId }));
    const deps = depsForRunner({
      listOpenCandidateItems: async () => [{
        id: 'WI-released',
        taskId: 'released-task',
        harnessSlug: 'papercusp',
        lastReleasedAt,
      }],
      claimOpenCandidateItems: claim,
      spawnJudge: spawn,
    });

    const first = await runLifecycleJudgementSweep(
      { workspaceId: 'ws-1', harnessSlug: 'papercusp', nowMs: NOW },
      deps,
    );
    // The first judge has released the same stable condition row; its next owner id will differ.
    lastReleasedAt = new Date(NOW);
    const retry = await runLifecycleJudgementSweep(
      { workspaceId: 'ws-1', harnessSlug: 'papercusp', nowMs: NOW + 5 * 60_000 },
      deps,
    );

    expect(first.judge.attempted).toBe(true);
    expect(claimOwners).toHaveLength(1);
    expect(claimOwners[0]).toMatch(/^system:operator\/s-/);
    expect(first.suppressedByRetryFloor).toBe(0);
    expect(retry.suppressedByRetryFloor).toBe(1);
    expect(retry.openItems).toEqual([]);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh retry-floor epoch when the latest keepCount advances', async () => {
    let verdict: ProcessLifecycleVerdict = {
      taskId: 'epoch-task',
      decision: 'keep',
      reason: 'first keep epoch is due',
      keepCount: 4,
      recheckAt: new Date(NOW - LIFECYCLE_JUDGE_RETRY_FLOOR_MS).toISOString(),
      decidedAt: new Date(NOW - 2 * LIFECYCLE_JUDGE_RETRY_FLOOR_MS).toISOString(),
    };
    const readLatest = async (_workspaceId: string, taskIds: readonly string[]) =>
      taskIds.includes('epoch-task')
        ? new Map([['epoch-task', verdict]])
        : new Map<string, ProcessLifecycleVerdict>();
    const spawn = vi.fn(async (input: Parameters<LifecycleJudgementDeps['spawnJudge']>[0]) =>
      ({ ok: true, spawnId: input.spawnId }));
    const deps = depsForRunner({
      readLatestVerdicts: readLatest,
      listOpenCandidateItems: async () => [{
        id: 'WI-epoch',
        taskId: 'epoch-task',
        harnessSlug: 'papercusp',
        lastReleasedAt: new Date(NOW - 2 * LIFECYCLE_JUDGE_RETRY_FLOOR_MS),
      }],
      spawnJudge: spawn,
    });

    const dueOldEpoch = await runLifecycleJudgementSweep(
      { workspaceId: 'ws-1', harnessSlug: 'papercusp', nowMs: NOW },
      deps,
    );
    verdict = {
      ...verdict,
      reason: 'new keep count starts a new retry epoch',
      keepCount: 5,
      recheckAt: new Date(NOW).toISOString(),
      decidedAt: new Date(NOW).toISOString(),
    };
    const freshEpoch = await runLifecycleJudgementSweep(
      { workspaceId: 'ws-1', harnessSlug: 'papercusp', nowMs: NOW + 5 * 60_000 },
      deps,
    );
    const afterFloor = await runLifecycleJudgementSweep(
      { workspaceId: 'ws-1', harnessSlug: 'papercusp', nowMs: NOW + LIFECYCLE_JUDGE_RETRY_FLOOR_MS + 1 },
      deps,
    );

    expect(dueOldEpoch.judge.attempted).toBe(true);
    expect(freshEpoch.suppressedByRetryFloor).toBe(1);
    expect(freshEpoch.openItems).toEqual([]);
    expect(afterFloor.judge.attempted).toBe(true);
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});

describe('task-reconcile production wiring', () => {
  const lifecycleSource = readFileSync(new URL('./lifecycle-judgement.ts', import.meta.url), 'utf8');
  const actionSource = readFileSync(new URL('../harness/routines/task-reconcile-action.ts', import.meta.url), 'utf8');

  it('keeps the lifecycle sweep on the existing task-reconcile routine', () => {
    expect(actionSource).toContain("registerSystemAction('task-reconcile'");
    expect(actionSource).toContain('runLifecycleJudgementSweep({');
    expect(lifecycleSource).toContain('harness_slug, taken_by, last_released_at');
    expect(actionSource).toContain('confirmedResidueTaskIds');
    expect(actionSource).toContain('intervalMs: LIFECYCLE_SWEEP_INTERVAL_MS');
  });

  it('launches a supported prompted operator through the durable interval idempotency seam', () => {
    expect(AGENT_ROLES).toContain(LIFECYCLE_JUDGE_ROLE);
    expect(LIFECYCLE_JUDGE_ROLE).toBe('operator');
    expect(isRetiredTierRole(LIFECYCLE_JUDGE_ROLE)).toBe(false);
    expect(LIFECYCLE_JUDGE_EXTRAS).toEqual(['BLUEPRINT_ID=coding']);
    const promptPath = resolvePromptFile(
      {
        harnessDir: HARNESS_DIR,
        phase: '',
        dept: '',
        blueprintId: LIFECYCLE_JUDGE_BLUEPRINT_ID,
      },
      LIFECYCLE_JUDGE_ROLE,
    );
    expect(promptPath).toMatch(/blueprints\/coding\/prompts\/operator\.md$/);
    expect(readFileSync(promptPath!, 'utf8').trim().length).toBeGreaterThan(0);
    expect(lifecycleSource).toContain('role: LIFECYCLE_JUDGE_ROLE');
    expect(lifecycleSource).toContain('extras: [...LIFECYCLE_JUDGE_EXTRAS]');
    expect(lifecycleSource).toContain("tier: 'quick'");
    expect(lifecycleSource).toContain("accountOverride: 'auto'");
    expect(lifecycleSource).toContain('idempotencyKey,');
    expect(lifecycleSource).toContain("spawnCaller: 'task-manager/lifecycle-judgement'");
  });
});
