import { describe, it, expect, vi } from 'vitest';
import type { Sql } from 'postgres';
import { runAgentProductivitySweepOnce, agentProductivityConditionKey, IDEATE_PASS_GRACE_MS,
  makeReadAgentProductivity,
  type AgentPresenceCandidate, type AgentCallCensus, type AgentProductivitySweepDeps,
  type AgentIdeateRegistration, type AgentWedgeWave } from './agent-productivity-watchdog';
import type { LivenessVerdict } from '../agent-tools/coordination/liveness-oracle';
import { AGENT_PRODUCTIVITY_GRACE_MS } from '../agent-wedge';

const NOW = 1_800_000_000_000;
const SQL = {} as Sql;

function fixture() {
  let now = NOW;
  const candidate: AgentPresenceCandidate = { ownerId: 'subject', ownerLabel: 'subject', workspaceId: 'fixture',
    agentRole: 'su', fleetSlug: null, source: 'omp-hook-session', host: null, pid: null,
    heartbeatAt: new Date(NOW - 30_000).toISOString(), startedAtMs: NOW - AGENT_PRODUCTIVITY_GRACE_MS - 60_000 };
  let rows = [candidate];
  let measured: AgentCallCensus | undefined = { agentOriginCalls: 0, anyOriginCalls: 0 };
  let alive = true, reg: AgentIdeateRegistration | undefined, pass: number | undefined;
  const open = new Map<string, number>(), escalated: AgentWedgeWave[] = [];
  const broadcast = vi.fn(async (event: { conditionKey?: string; oneShot?: boolean }) => {
    expect(event.oneShot).toBe(true);
    if (!open.has(event.conditionKey!)) open.set(event.conditionKey!, now);
    return true;
  });
  const resolve = vi.fn(async (event: { conditionKey: string }) => open.delete(event.conditionKey));
  const deps: Partial<AgentProductivitySweepDeps> = {
    flagEnabled: async () => true, now: () => now,
    readCandidates: async () => rows,
    resolveLiveness: async () => new Map(alive ? rows.map(row => [row.ownerId, {
      ownerId: row.ownerId, sessionState: 'parked', wakeable: true, liveTurn: false, selfWake: 'loop',
    } as unknown as LivenessVerdict]) : []),
    readProductivity: async () => new Map(measured ? rows.map(row => [row.ownerId, measured!]) : []),
    readIdeateRegistrations: async () => new Map(reg ? rows.map(row => [row.ownerId, reg!]) : []),
    readIdeatePasses: async () => new Map(pass === undefined ? [] : rows.map(row => [row.ownerId, pass!])),
    readHeldClaims: async () => new Map(), resolveGraders: async () => new Map(),
    escalateWave: async wave => { expect(open.size).toBeGreaterThan(0); escalated.push(wave); },
    escalateIdeateWave: async () => {}, notifyIdeateWave: async () => {}, escalateDegenerateWakeWave: async () => {},
    rail: { broadcast, resolve },
    readOpenConditions: async () => [...open].map(([conditionKey, openedAtMs]) => ({ conditionKey, openedAtMs })),
  };
  return { candidate, deps, open, broadcast, resolve, escalated,
    run: () => runAgentProductivitySweepOnce(SQL, { ...deps }),
    rows: (value: AgentPresenceCandidate[]) => { rows = value; },
    measured: (value: AgentCallCensus | undefined) => { measured = value; },
    alive: (value: boolean) => { alive = value; }, time: (value: number) => { now = value; },
    registration: (value: AgentIdeateRegistration | undefined) => { reg = value; },
    pass: (value: number | undefined) => { pass = value; },
  };
}

describe('agent productivity durable conditions', () => {
  it.each([true, false, '', ' ', null, undefined, Number.NaN, -1, 1.5, '1.5', 'NaN', '9007199254740992'])
    ('preserves unmeasured raw SQL counts %s instead of coercing them into recovery', async value => {
      const sql = (async () => [{ owner_id: 'subject', agent_calls: value, any_calls: '5', recent_calls: '5',
        recent_telemetry_calls: '0', recent_work_calls: '5', recent_progress_calls: '5' }]) as unknown as Sql;
      const h = fixture(); await h.run();
      h.deps.readProductivity = makeReadAgentProductivity(sql);
      await h.run(); expect(h.open.size).toBe(1); expect(h.resolve).not.toHaveBeenCalled();
    });

  it('accepts exact nonnegative numeric SQL count strings as measured recovery', async () => {
    const sql = (async () => [{ owner_id: 'subject', agent_calls: '1', any_calls: '5', recent_calls: '5',
      recent_telemetry_calls: '0', recent_work_calls: '5', recent_progress_calls: '5' }]) as unknown as Sql;
    const h = fixture(); await h.run(); h.deps.readProductivity = makeReadAgentProductivity(sql);
    await h.run(); expect(h.open.size).toBe(0);
  });

  it('opens before legacy reporting, preserves a phase transition, recovers and rearms after restart', async () => {
    const h = fixture();
    const nb = agentProductivityConditionKey('never-booted', h.candidate);
    const bnw = agentProductivityConditionKey('booted-never-worked', h.candidate);
    await h.run(); expect([...h.open.keys()]).toEqual([nb]);
    await h.run(); expect(h.open.size).toBe(1); expect(h.broadcast).toHaveBeenCalledTimes(2);
    h.measured({ agentOriginCalls: 0, anyOriginCalls: 4 }); await h.run();
    expect([...h.open.keys()]).toEqual([nb, bnw]);
    h.measured({ agentOriginCalls: 1, anyOriginCalls: 5 }); await h.run();
    expect(h.open.size).toBe(0); expect(h.resolve).toHaveBeenCalledTimes(2);
    h.measured({ agentOriginCalls: 0, anyOriginCalls: 0 }); await h.run(); expect(h.open.has(nb)).toBe(true);
  });

  it.each(['absent', 'foreign-workspace', 'replacement', 'missing-census', 'unknown-liveness',
    'stale-heartbeat', 'future-heartbeat', 'future-start', 'negative-count', 'nan-count', 'string-count',
    'fraction-count', 'failed-ledger', 'newer-episode', 'disabled'])('preserves an episode with %s evidence', async kind => {
    const h = fixture(); await h.run();
    h.measured({ agentOriginCalls: 1, anyOriginCalls: 5 });
    if (kind === 'absent') h.rows([]);
    if (kind === 'foreign-workspace') h.rows([{ ...h.candidate, workspaceId: 'foreign' }]);
    if (kind === 'replacement') h.rows([{ ...h.candidate, startedAtMs: h.candidate.startedAtMs + 1 }]);
    if (kind === 'missing-census') h.measured(undefined);
    if (kind === 'unknown-liveness') h.alive(false);
    if (kind === 'stale-heartbeat') h.rows([{ ...h.candidate, heartbeatAt: new Date(NOW - 11 * 60_000).toISOString() }]);
    if (kind === 'future-heartbeat') h.rows([{ ...h.candidate, heartbeatAt: new Date(NOW + 1).toISOString() }]);
    if (kind === 'future-start') h.rows([{ ...h.candidate, startedAtMs: NOW + 1 }]);
    if (kind === 'negative-count') h.measured({ agentOriginCalls: -1, anyOriginCalls: 5 });
    if (kind === 'nan-count') h.measured({ agentOriginCalls: Number.NaN, anyOriginCalls: 5 });
    if (kind === 'string-count') h.measured({ agentOriginCalls: '1' as unknown as number, anyOriginCalls: 5 });
    if (kind === 'fraction-count') h.measured({ agentOriginCalls: 0.5, anyOriginCalls: 5 });
    if (kind === 'failed-ledger') h.deps.readOpenConditions = async () => { throw new Error('ledger unavailable'); };
    if (kind === 'newer-episode') for (const key of h.open.keys()) h.open.set(key, NOW + 1);
    if (kind === 'disabled') h.deps.flagEnabled = async () => false;
    await h.run(); expect(h.open.size).toBe(1); expect(h.resolve).not.toHaveBeenCalled();
  });

  it('preserves quiet or malformed windows and recovers progress independently of ideate silence', async () => {
    const h = fixture();
    const reg = { setAtMs: NOW - IDEATE_PASS_GRACE_MS - 1, setBy: 'launcher', ownerDirected: true };
    h.registration(reg);
    const bad = { agentOriginCalls: 100, anyOriginCalls: 120, recentCalls: 100,
      recentTelemetryCalls: 90, recentWorkCalls: 1, recentProgressCalls: 1 };
    h.measured(bad); await h.run(); expect(h.open.size).toBe(2);
    h.measured({ ...bad, recentCalls: 0, recentTelemetryCalls: 0, recentWorkCalls: 0, recentProgressCalls: 0 });
    await h.run(); expect(h.open.size).toBe(2);
    h.measured({ ...bad, recentCalls: Number.NaN }); await h.run(); expect(h.open.size).toBe(2);
    h.measured({ ...bad, recentWorkCalls: 10 }); await h.run();
    expect([...h.open.keys()]).toEqual([agentProductivityConditionKey('ideate', h.candidate, reg.setAtMs)]);
    h.pass(reg.setAtMs - 1); await h.run(); expect(h.open.size).toBe(1);
    h.pass(NOW + 1); await h.run(); expect(h.open.size).toBe(1);
    h.registration(undefined); h.pass(NOW); await h.run(); expect(h.open.size).toBe(1);
    h.registration(reg); await h.run(); expect(h.open.size).toBe(0);
  });

  it('contains delivery and resolution failures while preserving reports and siblings', async () => {
    const h = fixture(); h.rows([h.candidate, { ...h.candidate, ownerId: 'sibling' }]);
    h.broadcast.mockRejectedValueOnce(new Error('delivery refused'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await h.run(); expect(result.wedged).toBe(2); expect(h.open.size).toBe(1);
      expect(h.escalated).toHaveLength(1); expect(warn).toHaveBeenCalledWith(expect.stringContaining('delivery refused'));
    } finally { warn.mockRestore(); }
    h.measured({ agentOriginCalls: 1, anyOriginCalls: 5 });
    h.resolve.mockResolvedValueOnce(false); await h.run(); expect(h.open.size).toBe(1);
    await h.run(); expect(h.open.size).toBe(0);
  });

  it('recovers through the production durable-envelope reader after an in-memory restart', async () => {
    const h = fixture(); await h.run();
    const key = [...h.open.keys()][0];
    const conditions = await import('../agent-tools/coordination/tools/conditions');
    const read = vi.spyOn(conditions, 'readConditionEnvelopes').mockResolvedValue([
      { ts: new Date(NOW).toISOString(), condition_key: key },
      { ts: new Date(NOW).toISOString(), condition_key: 'alarm:agent-productivity:foreign' },
    ]);
    h.deps.readOpenConditions = undefined;
    h.measured({ agentOriginCalls: 1, anyOriginCalls: 5 });
    try {
      await h.run(); expect(read).toHaveBeenCalledOnce(); expect(h.open.size).toBe(0);
      expect(h.resolve).toHaveBeenCalledWith(expect.objectContaining({ conditionKey: key }));
    } finally { read.mockRestore(); }
  });
});
