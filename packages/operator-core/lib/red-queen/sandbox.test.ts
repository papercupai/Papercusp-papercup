/**
 * sandbox.test.ts — the drill cycle runner, end to end over injected deps
 * (self-learning-frontier P-031 / FB-20). No PG: a fake drill class + a fake
 * store + scripted tick/triage/resolve legs pin the lifecycle, the MTTSH
 * math, the leak-check recording, and the always-cleanup contract.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import type { EngineerIssue } from '../issues-engineer';
import type { WatchdogTickResult } from '../harness/improvements/watchdog';
import { runDrillCycle, runRedQueenTick, type DrillCycleDeps } from './sandbox';
import { SANDBOX_WORKSPACE_ID, type DrillClass, type DrillOutcome } from './types';

const SQL = {} as Sql;
const KEY = 'smoke-fail:red-queen-sandbox';

function fakeClass(over: Partial<DrillClass> = {}): DrillClass & { healed: { v: boolean }; cleaned: { v: boolean } } {
  const healed = { v: false };
  const cleaned = { v: false };
  return {
    id: 'fake-drill',
    collectorFamily: 'smoke-fail',
    description: 'test drill',
    plant: async () => ({
      expectedWatchdogKey: KEY,
      expectedKind: 'bug' as const,
      expectedSeverity: 'major' as const,
      expectedDecision: 'place' as const,
      artifacts: { table: 't' },
    }),
    collectors: (_sql, _planted, ws) =>
      ws === SANDBOX_WORKSPACE_ID && !healed.v
        ? [{
            name: 'fake',
            collect: async () => [{ source: 'smoke-fail' as const, key: 'red-queen-sandbox', title: 't', body: 'b', severity: 'major' as const, origin: 'drill' as const }],
          }]
        : [{ name: 'fake', collect: async () => [] }],
    heal: async () => { healed.v = true; },
    cleanup: async () => { cleaned.v = true; },
    healed,
    cleaned,
    ...over,
  };
}

const issue = (id: string, over: Partial<EngineerIssue> = {}): EngineerIssue =>
  ({
    id,
    title: 'Smoke test failing in harness red-queen-sandbox',
    kind: 'bug',
    state: 'open',
    severity: 'major',
    scope: 'harness:red-queen-sandbox',
    payload: { watchdogKey: KEY },
    signalOrigin: 'drill',
    createdAt: '2026-06-12T10:00:00.000Z',
    updatedAt: '2026-06-12T10:00:00.000Z',
    ...over,
  }) as EngineerIssue;

const ranTick = (captured: string[]): WatchdogTickResult => ({
  status: 'ran',
  signals: captured.length,
  captured,
  declinedDuplicates: 0,
  deferred: 0,
  knownOpen: 0,
  knownOpenKeys: [],
  staleResolved: 0,
  staleResolvedKeys: [],
  standing: 0,
  standingKeys: [],
  refileEligibleKeys: [],
  metricSuppressed: 0,
  metricSuppressedKeys: [],
  seenKeys: [],
  collectors: [],
  selfEscalations: [],
  agingEscalations: [],
});

function fakeDeps(over: Partial<DrillCycleDeps> = {}) {
  let t = 1_000_000;
  const stamps: Record<string, unknown[]> = { insert: [], detected: [], triaged: [], resolved: [], failed: [] };
  const drillCandidate = {
    id: 'iss-1',
    kind: 'bug' as const,
    scope: 'harness:red-queen-sandbox',
    title: 'Smoke test failing in harness red-queen-sandbox',
    severity: 'major' as const,
    state: 'open' as const,
    createdAt: '2026-06-12T10:00:00.000Z',
    updatedAt: '2026-06-12T10:00:00.000Z',
    watchdogKey: KEY,
    origin: 'drill' as const,
  };
  const deps: DrillCycleDeps = {
    sql: SQL,
    liveWorkspaceId: 'live-ws',
    runTick: vi.fn(async () => ranTick(['iss-1'])),
    getIssue: vi.fn(async (id: string) => issue(id)),
    // The triage leg reads the DRILL lane; the leak check reads the ORGANIC
    // lane (no opts.origins) — organic comes back clean by default.
    readItems: vi.fn(async (opts) => (opts.origins?.includes('drill') ? [drillCandidate] : [])),
    applyTriage: vi.fn(async (input) => ({ ok: true, id: input.id, decision: input.decision })),
    resolve: vi.fn(async (input) => ({ ok: true, id: input.id, outcome: 'fixed' as const, state: 'resolved' as const })),
    store: {
      insert: vi.fn(async () => {
        stamps.insert.push(1);
        return { drillId: 'drill-1', plantedAt: new Date(1_000_000).toISOString() };
      }),
      detected: vi.fn(async (_sql, id, d) => { stamps.detected.push({ id, ...d }); }),
      triaged: vi.fn(async (_sql, id, d) => { stamps.triaged.push({ id, ...d }); }),
      resolved: vi.fn(async (_sql, id, d) => { stamps.resolved.push({ id, ...d }); }),
      failed: vi.fn(async (_sql, id, e) => { stamps.failed.push({ id, e }); }),
      expireStale: vi.fn(async () => 0),
      readOutcomes: vi.fn(async () => [] as DrillOutcome[]),
    },
    now: () => { t += 500; return t; },
    log: () => {},
    ...over,
  };
  return { deps, stamps };
}

describe('runDrillCycle', () => {
  it('happy path: plant → detect → triage → heal+resolve → MTTSH + leak check recorded, cleanup ALWAYS', async () => {
    const cls = fakeClass();
    const { deps, stamps } = fakeDeps();
    const r = await runDrillCycle(cls, deps);

    expect(r.status).toBe('resolved');
    expect(r.ok).toBe(true);
    expect(r.issueId).toBe('iss-1');
    // Lifecycle stamps, in order.
    expect(stamps.insert).toHaveLength(1);
    expect(stamps.detected).toHaveLength(1);
    expect(stamps.triaged).toHaveLength(1);
    expect(stamps.resolved).toHaveLength(1);
    expect(stamps.failed).toHaveLength(0);
    // The triage leg routed through the REAL pure path with the planted truth.
    expect(stamps.triaged[0]).toMatchObject({ triagedDecision: 'place' });
    // MTTSH segments from the injected clock — monotone and complete.
    expect(r.mttsh).toBeTruthy();
    expect(r.mttsh!.totalMs).toBeGreaterThan(0);
    expect(r.mttsh!.totalMs).toBeGreaterThanOrEqual(r.mttsh!.fixMs!);
    // Leak check: all three legs clean.
    expect(r.leakCheck).toMatchObject({
      passed: true,
      organicReadClean: true,
      liveCollectorClean: true,
      capturedOriginIsDrill: true,
    });
    expect(cls.healed.v).toBe(true);
    expect(cls.cleaned.v).toBe(true);
  });

  it('preserves the owner-escalation target for an operator-scoped infrastructure drill', async () => {
    const watchdogKey = 'fire-circuit-open:red-queen-sandbox';
    const cls = fakeClass({
      plant: async () => ({
        expectedWatchdogKey: watchdogKey,
        expectedKind: 'bug',
        expectedSeverity: 'major',
        expectedDecision: 'gate',
        artifacts: { table: 'autoloop_state' },
      }),
    });
    const candidate = {
      id: 'iss-1',
      kind: 'bug' as const,
      scope: 'operator',
      title: 'Red Queen drill fire circuit is open',
      severity: 'major' as const,
      state: 'open' as const,
      createdAt: '2026-06-12T10:00:00.000Z',
      updatedAt: '2026-06-12T10:00:00.000Z',
      watchdogKey,
      origin: 'drill' as const,
    };
    const { deps, stamps } = fakeDeps({
      getIssue: vi.fn(async (id: string) =>
        issue(id, { scope: 'operator', payload: { watchdogKey } }),
      ),
      readItems: vi.fn(async (opts) => (opts.origins?.includes('drill') ? [candidate] : [])),
    });

    const r = await runDrillCycle(cls, deps);

    expect(r.status).toBe('resolved');
    expect(deps.applyTriage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'iss-1',
        decision: 'gate',
        target: 'owner-escalation',
        by: 'red-queen-sandbox',
      }),
    );
    expect(stamps.triaged[0]).toMatchObject({ triagedDecision: 'gate', triagedIdeaType: 'infra-environment' });
  });

  it('EI-6933: the detect-stage tick no-ops processAging/processAutoClose (both are NOT scoped to SANDBOX_WORKSPACE_ID upstream — they resolve issues via a process-global "active workspace", so left live they run against the REAL production issue backlog on every drill)', async () => {
    const cls = fakeClass();
    const { deps } = fakeDeps();
    await runDrillCycle(cls, deps);

    expect(deps.runTick).toHaveBeenCalledTimes(1);
    const [, , tickDeps] = (deps.runTick as ReturnType<typeof vi.fn>).mock.calls[0] as [
      unknown,
      unknown,
      { processAging?: (...a: unknown[]) => Promise<unknown[]>; processAutoClose?: (...a: unknown[]) => Promise<unknown[]> },
    ];
    expect(tickDeps.processAging).toBeTypeOf('function');
    expect(tickDeps.processAutoClose).toBeTypeOf('function');
    // Both must resolve to an empty array WITHOUT doing any real work — no
    // arguments matter, they are unconditional no-ops for the sandbox tick.
    await expect(tickDeps.processAging!()).resolves.toEqual([]);
    await expect(tickDeps.processAutoClose!()).resolves.toEqual([]);
  });

  it('an in-flight drill of the same class skips (one open drill per class)', async () => {
    const { deps } = fakeDeps();
    (deps.store.readOutcomes as ReturnType<typeof vi.fn>).mockResolvedValue([
      { drillId: 'old', drillClass: 'fake-drill', status: 'planted', plantedAt: 'x' } as never,
    ]);
    const r = await runDrillCycle(fakeClass(), deps);
    expect(r.status).toBe('skipped');
    expect(deps.store.insert).not.toHaveBeenCalled();
  });

  it('a skipped sandbox tick fails the drill and still cleans up', async () => {
    const cls = fakeClass();
    const { deps, stamps } = fakeDeps({
      runTick: vi.fn(async () => ({ ...ranTick([]), status: 'skipped' as const })),
    });
    const r = await runDrillCycle(cls, deps);
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('tick-skipped');
    expect(stamps.failed).toHaveLength(1);
    expect(cls.cleaned.v).toBe(true);
  });

  it('no capture matching the planted key fails the drill with the tick forensics', async () => {
    const cls = fakeClass();
    const { deps } = fakeDeps({
      getIssue: vi.fn(async (id: string) => issue(id, { payload: { watchdogKey: 'some:other' } })),
    });
    const r = await runDrillCycle(cls, deps);
    expect(r.status).toBe('failed');
    expect(r.reason).toContain('none matching');
    expect(cls.cleaned.v).toBe(true);
  });

  it('an organic-lane leak is RECORDED and fails the run verdict (status stays resolved)', async () => {
    const cls = fakeClass();
    const drillRowAsOrganic = {
      id: 'iss-1', kind: 'bug' as const, scope: 'harness:red-queen-sandbox',
      title: 't', state: 'open', createdAt: 'x', updatedAt: 'x', watchdogKey: KEY,
    };
    const { deps } = fakeDeps();
    (deps.readItems as ReturnType<typeof vi.fn>).mockImplementation(async (opts: { origins?: string[] }) =>
      opts.origins?.includes('drill')
        ? [{ ...drillRowAsOrganic, severity: 'major', origin: 'drill' }]
        : [drillRowAsOrganic], // the ORGANIC read seam leaks the drill row
    );
    const r = await runDrillCycle(cls, deps);
    expect(r.status).toBe('resolved');
    expect(r.ok).toBe(false);
    expect(r.leakCheck!.passed).toBe(false);
    expect(r.leakCheck!.organicReadClean).toBe(false);
  });

  it('a post-heal re-sweep that still fires fails the drill (remedy did not clear the friction)', async () => {
    const cls = fakeClass();
    // heal() flips healed.v, but this class keeps firing regardless.
    cls.collectors = (_sql, _planted, ws) =>
      ws === SANDBOX_WORKSPACE_ID
        ? [{ name: 'fake', collect: async () => [{ source: 'smoke-fail' as const, key: 'red-queen-sandbox', title: 't', body: 'b', severity: 'major' as const }] }]
        : [{ name: 'fake', collect: async () => [] }];
    const { deps, stamps } = fakeDeps();
    const r = await runDrillCycle(cls, deps);
    expect(r.status).toBe('failed');
    expect(r.reason).toContain('post-heal');
    expect(stamps.failed).toHaveLength(1);
    expect(cls.cleaned.v).toBe(true);
  });

  it('an exception anywhere marks the drill failed and STILL cleans up', async () => {
    const cls = fakeClass();
    const { deps, stamps } = fakeDeps({
      applyTriage: vi.fn(async () => { throw new Error('triage exploded'); }),
    });
    const r = await runDrillCycle(cls, deps);
    expect(r.status).toBe('failed');
    expect(r.reason).toContain('triage exploded');
    expect(stamps.failed).toHaveLength(1);
    expect(cls.cleaned.v).toBe(true);
  });
});

describe('runRedQueenTick', () => {
  it('expires stale drills and runs one cycle for an explicit class', async () => {
    const { deps } = fakeDeps();
    (deps.store.expireStale as ReturnType<typeof vi.fn>).mockResolvedValue(2);
    // 'smoke-fail' is a REAL registry class — its plant() runs against deps.sql,
    // so give this tick a fake sql template that absorbs the statements.
    const calls: unknown[] = [];
    const sqlFn = ((strings: TemplateStringsArray, ...params: unknown[]) => {
      calls.push({ text: strings.join('?'), params });
      return Promise.resolve([]);
    }) as unknown as Sql;
    const r = await runRedQueenTick({ ...deps, sql: sqlFn }, { classId: 'smoke-fail' });
    expect(r.status).toBe('ran');
    expect(r.expired).toBe(2);
    expect(r.drillClass).toBe('smoke-fail');
    expect(r.cycle?.status).toBe('resolved');
  });

  it('unknown explicit class ⇒ idle', async () => {
    const { deps } = fakeDeps();
    const r = await runRedQueenTick(deps, { classId: 'nope' });
    expect(r.status).toBe('idle');
  });

  it('rotation picks the never-drilled class first', async () => {
    const { deps } = fakeDeps();
    (deps.store.readOutcomes as ReturnType<typeof vi.fn>)
      // The rotation read: every class has history EXCEPT fire-circuit-open.
      .mockResolvedValueOnce([
        { drillClass: 'smoke-fail', plantedAt: '2026-06-12T01:00:00Z', status: 'resolved' },
        { drillClass: 'stuck-plan', plantedAt: '2026-06-12T02:00:00Z', status: 'resolved' },
        { drillClass: 'unresolved-escalation', plantedAt: '2026-06-12T03:00:00Z', status: 'resolved' },
        { drillClass: 'routine-engine-death', plantedAt: '2026-06-12T04:00:00Z', status: 'resolved' },
      ] as never)
      // The in-flight guard read inside runDrillCycle:
      .mockResolvedValue([] as never);
    const sqlFn = (() => Promise.resolve([])) as unknown as Sql;
    const r = await runRedQueenTick({ ...deps, sql: sqlFn });
    expect(r.drillClass).toBe('fire-circuit-open');
  });
});
