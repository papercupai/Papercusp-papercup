import { beforeEach, describe, expect, it } from 'vitest';
import {
  deriveSignatureFromSummary,
  evaluateLivenessAlarm,
  isEvaluatedLivenessSignature,
  resolveEvidenceFor,
  unobservableLivenessSignatures,
  runLivenessAlarmTick,
  _resetLivenessAlarmDebounce,
  type AlarmDeps,
} from './liveness-alarm';
import { getBuildInfo } from '../build-info';
import type { EscalationRecord } from '../agent-tools/coordination/escalations';
import {
  AGENT_STRANDED_ALARM_THRESHOLD,
  AGENT_WEDGED_ALARM_THRESHOLD,
  summarizeAgentStrand,
  type AgentStrandHealth,
} from './agent-strand-census';
import { coordinationStatus } from './thresholds';
import type { CoordinationHealth, HealthPanel, SystemHealth } from './types';

// P-011(b), plan parked-agent-census-resumption-and-root-cause-2026-10-09 (BAR R-12): a standing
// alarm fires when the wedged-session count exceeds its threshold, and likewise for autonomous
// claim holders with no wake source. 61 loops stalled for days while nothing counted them.

function strand(wedged: number, stranded: number): AgentStrandHealth {
  const verdicts = new Map(
    Array.from({ length: wedged }, (_, i) => [`w-${i}`, { wedged: i % 3 === 0 ? 'unbound-successor' : 'quota-blocked' }] as const),
  );
  return summarizeAgentStrand(verdicts, Array.from({ length: stranded }, (_, i) => `s-${i}`));
}

function coordination(agentStrand: AgentStrandHealth | null | undefined): CoordinationHealth {
  return {
    unansweredAgents: 0,
    unansweredTotal: 0,
    unansweredOldestMs: null,
    criticalContext: 0,
    highContext: 0,
    activeAwaits: 0,
    staleAwaits: 0,
    leaderlessFleets: 0,
    liveFleets: 0,
    orphanedClaims: 0,
    stalledClaims: 0,
    coverageCollisions: 0,
    parkedMembers: 0,
    ...(agentStrand === undefined ? {} : { agentStrand }),
  };
}

function health(panelOver: Partial<HealthPanel<CoordinationHealth | null>>): SystemHealth {
  const p: HealthPanel<CoordinationHealth | null> = {
    key: 'coordination',
    label: 'Coordination',
    status: 'warn',
    summary: 'x',
    metrics: [],
    data: null,
    ...panelOver,
  };
  return {
    workspaceId: 'ws',
    evaluatedAt: 1_000_000,
    overall: 'ok',
    crossMonitor: { queenAlive: true, overwatchAlive: null },
    panels: { coordination: p } as unknown as SystemHealth['panels'],
  };
}

const keys = (h: SystemHealth) => evaluateLivenessAlarm(h, null).map((s) => s.key);

describe('agent-strand alarm observation provenance', () => {
  beforeEach(() => _resetLivenessAlarmDebounce());

  function journey(snapshot: SystemHealth) {
    const records: EscalationRecord[] = [];
    const deps: AlarmDeps = {
      readLast: () => snapshot,
      readSharedHealth: async () => snapshot,
      readAutoloopFireRows: async () => [],
      now: () => 1_000_100,
      escalate: async (input) => {
        records.push({
          msg_id: `agent-strand-${records.length}`,
          from: 'system:infra-liveness-alarm',
          severity: input.severity,
          summary: input.summary,
          body: input.body,
          resolved: null,
          ...input.meta,
        } as EscalationRecord);
      },
      listOpen: async () => records.filter((record) => !record.resolved),
      resolve: async () => {},
      page: async () => {},
      pageResolved: async () => {},
    };
    return { deps, records };
  }

  it('pins the emitting artifact and exact threshold observation without changing dedup identity', async () => {
    const snapshot = health({ data: coordination(strand(AGENT_WEDGED_ALARM_THRESHOLD, 0)) });
    const { deps, records } = journey(snapshot);
    const result = await runLivenessAlarmTick('ws', deps);
    expect(result.fired.map((signal) => signal.key)).toEqual(['agents-wedged']);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      livenessSignature: 'agents-wedged', dedupKind: 'infra-liveness', subjectSignature: 'agents-wedged',
      agentStrandObservation: {
        observedAtMs: 1_000_100, snapshotAtMs: 1_000_000,
        runtime: { ...getBuildInfo(), pid: process.pid },
        wedged: AGENT_WEDGED_ALARM_THRESHOLD,
        wedgedByClass: snapshot.panels.coordination.data!.agentStrand!.wedgedByClass,
        stranded: 0,
        thresholds: { wedged: AGENT_WEDGED_ALARM_THRESHOLD, stranded: AGENT_STRANDED_ALARM_THRESHOLD },
      },
    });
    _resetLivenessAlarmDebounce(); // A different worker has no local cooldown.
    const repeated = await runLivenessAlarmTick('ws', { ...deps, now: () => 1_000_200 });
    expect(repeated.fired).toEqual([]);
    expect(records).toHaveLength(1);
  });

  it('writes no alarm below threshold and preserves an unreadable wedged leg as unknown', async () => {
    const below = journey(health({ data: coordination(strand(AGENT_WEDGED_ALARM_THRESHOLD - 1, 0)) }));
    expect((await runLivenessAlarmTick('ws', below.deps)).fired).toEqual([]);
    expect(below.records).toEqual([]);
    const unreadable = journey(health({ data: coordination({
      ...strand(50, AGENT_STRANDED_ALARM_THRESHOLD), wedgedUnreadable: true,
    }) }));
    expect((await runLivenessAlarmTick('ws', unreadable.deps)).fired.map((signal) => signal.key))
      .toEqual(['agents-stranded']);
    expect(unreadable.records).toHaveLength(1);
    expect(unreadable.records[0]).toMatchObject({
      agentStrandObservation: { wedged: null, wedgedByClass: null, stranded: AGENT_STRANDED_ALARM_THRESHOLD },
    });
  });
});

describe('agents-wedged / agents-stranded alarm', () => {
  it('fires agents-wedged as a blocker AT the threshold, naming the classes', () => {
    const sigs = evaluateLivenessAlarm(health({ data: coordination(strand(AGENT_WEDGED_ALARM_THRESHOLD, 0)) }), null);
    const s = sigs.find((x) => x.key === 'agents-wedged');
    expect(s?.severity).toBe('blocker');
    expect(s?.summary).toContain(`${AGENT_WEDGED_ALARM_THRESHOLD} agent session(s) cannot take a turn`);
    expect(s?.summary).toContain('quota-blocked');
    expect(s?.summary).toContain('unbound-successor');
  });

  it('does not fire one below the threshold', () => {
    expect(keys(health({ data: coordination(strand(AGENT_WEDGED_ALARM_THRESHOLD - 1, AGENT_STRANDED_ALARM_THRESHOLD - 1)) }))).toEqual([]);
  });

  it('fires agents-stranded AT its threshold, independently of the wedged count', () => {
    const k = keys(health({ data: coordination(strand(0, AGENT_STRANDED_ALARM_THRESHOLD)) }));
    expect(k).toEqual(['agents-stranded']);
  });

  it('the live 2026-10-11 reading (41 wedged, 32 stranded) raises both', () => {
    expect(keys(health({ data: coordination(strand(41, 32)) })).sort()).toEqual(['agents-stranded', 'agents-wedged']);
  });

  it('an unreadable leg raises nothing for that leg and is unobservable, not recovered', () => {
    const s: AgentStrandHealth = { ...strand(50, 50), wedgedUnreadable: true };
    const h = health({ data: coordination(s) });
    expect(keys(h)).toEqual(['agents-stranded']);
    const un = unobservableLivenessSignatures(h);
    expect(un.has('agents-wedged')).toBe(true);
    expect(un.has('agents-stranded')).toBe(false);
  });

  it('a computed panel MISSING the census (an older build wrote it) keeps both alarms open', () => {
    const un = unobservableLivenessSignatures(health({ data: coordination(undefined) }));
    expect(un.has('agents-wedged')).toBe(true);
    expect(un.has('agents-stranded')).toBe(true);
  });

  it('an errored coordination panel keeps both alarms open', () => {
    const un = unobservableLivenessSignatures(health({ status: 'unknown', error: 'boom', data: null }));
    expect(un.has('agents-wedged')).toBe(true);
    expect(un.has('agents-stranded')).toBe(true);
  });

  it('a readable census below threshold is an observed recovery', () => {
    const h = health({ data: coordination(strand(1, 1)) });
    expect(keys(h)).toEqual([]);
    expect(unobservableLivenessSignatures(h).has('agents-wedged')).toBe(false);
    expect(resolveEvidenceFor('agents-wedged', h)).toContain('wedged=1');
    expect(resolveEvidenceFor('agents-stranded', h)).toContain('stranded=1');
  });

  it('both signatures are registered for auto-resolve and classify from their own summaries', () => {
    expect(isEvaluatedLivenessSignature('agents-wedged')).toBe(true);
    expect(isEvaluatedLivenessSignature('agents-stranded')).toBe(true);
    for (const s of evaluateLivenessAlarm(health({ data: coordination(strand(41, 32)) }), null)) {
      expect(deriveSignatureFromSummary(`[infra-liveness] ${s.summary}`)).toBe(s.key);
    }
  });
});

describe('coordinationStatus with the agent-strand census', () => {
  it('warns on any wedged or stranded session but never goes crit (the alarm owns paging)', () => {
    expect(coordinationStatus(coordination(strand(0, 0)))).toBe('ok');
    expect(coordinationStatus(coordination(strand(1, 0)))).toBe('warn');
    expect(coordinationStatus(coordination(strand(0, 1)))).toBe('warn');
    expect(coordinationStatus(coordination(strand(500, 500)))).toBe('warn');
    expect(coordinationStatus(coordination(undefined))).toBe('ok');
  });
});
