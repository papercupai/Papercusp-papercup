/**
 * su-ideate-schedule — the hourly su ideate pass scheduler (plan
 * scout-su-ideate-pipeline-gaps-2026-10-08 P-007 / R-14, D-005, D-006).
 * Pure over injected deps: no Postgres, no process spawn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSuIdeatePassBrief,
  defaultSuIdeateScheduleDeps,
  harnessFromPassLabel,
  nextSuIdeateLens,
  readSuIdeateOpenCircuits,
  runSuIdeateSchedule,
  suIdeateAttemptsSinceLastPass,
  SU_IDEATE_MAX_ATTEMPTS,
  SU_IDEATE_PASS_STALE_MS,
  type SuIdeateLaunchRecord,
  type SuIdeateScheduleDeps,
} from './su-ideate-schedule';

const { launchAgentHandler, readPoolSnapshot } = vi.hoisted(() => ({
  launchAgentHandler: vi.fn(),
  readPoolSnapshot: vi.fn(),
}));
vi.mock('../agent-tools/capability/launch-agent', () => ({ default: { handler: launchAgentHandler } }));
vi.mock('./capacity-probe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./capacity-probe')>()),
  readScoutPoolSnapshot: readPoolSnapshot,
}));

const NOW = Date.parse('2026-10-08T15:00:00Z');
const HOUR = 60 * 60 * 1000;

interface FakeHarness {
  lastPassMs?: number | null;
  lastLens?: string | null;
  enabled?: boolean;
  observations?: number;
  queue?: { total: number; pending: number };
}

function makeDeps(harnesses: Record<string, FakeHarness>, launches: SuIdeateLaunchRecord[] = []) {
  const launch = vi.fn<SuIdeateScheduleDeps['launch']>(async () => ({ ok: true }));
  const countObservationsSince = vi.fn<SuIdeateScheduleDeps['countObservationsSince']>(
    async (_ws, h) => harnesses[h]?.observations ?? 0,
  );
  const deps: SuIdeateScheduleDeps = {
    listHarnesses: async () => Object.keys(harnesses),
    readLastPass: async (_ws, h) => ({ lastPassMs: harnesses[h]?.lastPassMs ?? null, lastLens: harnesses[h]?.lastLens ?? null }),
    learningEnabled: async (_ws, h) => harnesses[h]?.enabled ?? true,
    countObservationsSince,
    readIdeaQueue: async (_ws, h) => harnesses[h]?.queue ?? { total: 0, pending: 0 },
    listLaunches: async () => launches,
    launch,
  };
  return { deps, launch, countObservationsSince };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('su-ideate production launch routing', () => {
  const input = {
    workspaceId: 'ws', harnessSlug: 'papercusp', lens: 'risk-first' as const,
    key: 'su-ideate-pass:papercusp:never:1', brief: 'one scheduled pass',
  };
  beforeEach(() => {
    launchAgentHandler.mockReset();
    readPoolSnapshot.mockReset();
    launchAgentHandler.mockImplementation(async (args: { account?: string; agent?: string }) =>
      args.account === 'auto'
        ? { content: [], structuredContent: { deduped: false } }
        : { isError: true, content: [{ text: 'weekly usage wall on the workstation account' }] },
    );
  });

  it('uses the Codex gateway route when the Claude pool is exhausted', async () => {
    readPoolSnapshot.mockResolvedValue({ observedAtMs: NOW, healthyAccounts: 0, codexConfigured: true, codexCliAccountCount: 1 });
    expect(await defaultSuIdeateScheduleDeps.launch(input)).toMatchObject({ ok: true });
    expect(launchAgentHandler).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex', account: 'auto', harness: 'papercusp', headless: true, independent: true, count: 1 }),
      expect.objectContaining({ workspaceId: 'ws', harnessSlug: 'papercusp', ownerId: 'system:su-ideate-schedule' }),
    );
  });

  it('uses the Claude gateway route when its pool is available', async () => {
    readPoolSnapshot.mockResolvedValue({ observedAtMs: NOW, healthyAccounts: 2, codexConfigured: true, codexCliAccountCount: 1 });
    expect(await defaultSuIdeateScheduleDeps.launch(input)).toMatchObject({ ok: true });
    expect(launchAgentHandler.mock.calls[0]![0]).toMatchObject({ agent: 'claude', account: 'auto' });
  });

  it('keeps the historical backend on an unknown probe while still using gateway account routing', async () => {
    readPoolSnapshot.mockResolvedValue(undefined);
    expect(await defaultSuIdeateScheduleDeps.launch(input)).toMatchObject({ ok: true });
    expect(launchAgentHandler.mock.calls[0]![0]).toMatchObject({ agent: 'claude', account: 'auto' });
  });

  it('does not create a task when the existing probe affirmatively reports no provider route', async () => {
    readPoolSnapshot.mockResolvedValue({ observedAtMs: NOW, healthyAccounts: 0, codexConfigured: false });
    expect(await defaultSuIdeateScheduleDeps.launch(input)).toMatchObject({ ok: false });
    expect(launchAgentHandler).not.toHaveBeenCalled();
  });
});

describe('su-ideate schedule — lens rotation and labels', () => {
  it('rotates risk-first → user-value-first → cost-leverage → risk-first, starting at risk-first', () => {
    expect(nextSuIdeateLens(null)).toBe('risk-first');
    expect(nextSuIdeateLens('risk-first')).toBe('user-value-first');
    expect(nextSuIdeateLens('user-value-first')).toBe('cost-leverage');
    expect(nextSuIdeateLens('cost-leverage')).toBe('risk-first');
    expect(nextSuIdeateLens('analogical')).toBe('risk-first');
  });

  it('parses the harness out of a scheduled-pass label and ignores other labels', () => {
    expect(harnessFromPassLabel('su-ideate-pass:email:never:1')).toBe('email');
    expect(harnessFromPassLabel('su-ideate-pass:sb-devboard-hive:1791470000000:2')).toBe('sb-devboard-hive');
    expect(harnessFromPassLabel('grading-audit:EI-1')).toBeNull();
    expect(harnessFromPassLabel(null)).toBeNull();
  });

  it('the brief names the harness, the lens, the pass-record close and session:end', () => {
    const brief = buildSuIdeatePassBrief({ harnessSlug: 'email', lens: 'cost-leverage', reason: '12 observations' });
    expect(brief).toContain("harness 'email'");
    expect(brief).toContain('blender:ideate-pass-record { ideasFiled, observationsMined, lens: \'cost-leverage\', notes }');
    expect(brief).not.toMatch(/ideasGenerated|ideasRouted|ideasDeduped/);
    expect(brief).toContain('session:end');
    expect(brief).toContain('[lens:cost-leverage]');
  });
});

describe('su-ideate schedule — D-015 verdict per harness (R-14)', () => {
  it('launches ONE pass for the overdue harness with the next lens, its harness and a pass-epoch key', async () => {
    const { deps, launch } = makeDeps({
      email: { lastPassMs: NOW - 5 * HOUR, lastLens: 'risk-first', observations: 12 },
      portal: { lastPassMs: NOW - 3 * HOUR, observations: 40 },
    });
    const out = await runSuIdeateSchedule({ workspaceId: 'ws', nowMs: NOW }, deps);
    expect(launch).toHaveBeenCalledTimes(1);
    const arg = launch.mock.calls[0][0];
    expect(arg.harnessSlug).toBe('email');
    expect(arg.lens).toBe('user-value-first');
    expect(arg.key).toBe(`su-ideate-pass:email:${NOW - 5 * HOUR}:1`);
    expect(out.launched).toEqual({ harnessSlug: 'email', lens: 'user-value-first', key: arg.key, deduped: false });
  });

  it('elapsed time alone never makes a harness overdue (D-015: observation-keyed, not calendar-keyed)', async () => {
    const { deps, launch } = makeDeps({ crm: { lastPassMs: NOW - 30 * 24 * HOUR, observations: 3 } });
    const out = await runSuIdeateSchedule({ workspaceId: 'ws', nowMs: NOW }, deps);
    expect(launch).not.toHaveBeenCalled();
    expect(out.decisions).toEqual([
      expect.objectContaining({ harnessSlug: 'crm', disposition: 'not-overdue' }),
    ]);
  });

  it('a drained su-ideate idea queue is overdue even below the observation threshold', async () => {
    const { deps, launch } = makeDeps({ portal: { lastPassMs: NOW - HOUR, observations: 0, queue: { total: 4, pending: 0 } } });
    await runSuIdeateSchedule({ workspaceId: 'ws', nowMs: NOW }, deps);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0][0].harnessSlug).toBe('portal');
  });

  it('evaluates never-passed harnesses first, then the oldest last pass, and counts observations since that pass', async () => {
    const { deps, launch, countObservationsSince } = makeDeps({
      papercusp: { lastPassMs: NOW - HOUR, observations: 9000 },
      crm: { lastPassMs: null, observations: 2 },
      email: { lastPassMs: NOW - 9 * HOUR, observations: 15 },
    });
    const out = await runSuIdeateSchedule({ workspaceId: 'ws', nowMs: NOW }, deps);
    expect(out.decisions.map((d) => [d.harnessSlug, d.disposition])).toEqual([
      ['crm', 'not-overdue'],
      ['email', 'launched'],
    ]);
    expect(launch.mock.calls[0][0].key).toBe(`su-ideate-pass:email:${NOW - 9 * HOUR}:1`);
    expect(countObservationsSince).toHaveBeenCalledWith('ws', 'crm', null);
    expect(countObservationsSince).toHaveBeenCalledWith('ws', 'email', NOW - 9 * HOUR);
  });

  it('skips a harness whose pot has learning switched off', async () => {
    const { deps, launch } = makeDeps({
      email: { lastPassMs: null, observations: 50, enabled: false },
      portal: { lastPassMs: NOW - HOUR, observations: 50 },
    });
    const out = await runSuIdeateSchedule({ workspaceId: 'ws', nowMs: NOW }, deps);
    expect(out.decisions[0]).toMatchObject({ harnessSlug: 'email', disposition: 'learning-disabled' });
    expect(launch.mock.calls[0][0].harnessSlug).toBe('portal');
  });
});

describe('su-ideate schedule — cost and liveness bounds (D-006)', () => {
  it('a live, fresh launch that has not yet recorded its pass blocks the whole tick', async () => {
    const { deps, launch } = makeDeps(
      { email: { lastPassMs: NOW - 5 * HOUR, observations: 50 }, portal: { lastPassMs: null, observations: 50 } },
      [{ harnessSlug: 'email', startedAtMs: NOW - 20 * 60 * 1000, live: true }],
    );
    const out = await runSuIdeateSchedule({ workspaceId: 'ws', nowMs: NOW }, deps);
    expect(launch).not.toHaveBeenCalled();
    expect(out.stopped).toBe('pass-in-flight');
    expect(out.inFlight?.harnessSlug).toBe('email');
  });

  it('a live launch that already recorded its pass, or is stale, does not block', async () => {
    const { deps, launch } = makeDeps(
      { email: { lastPassMs: NOW - 10 * 60 * 1000, observations: 0 }, portal: { lastPassMs: null, observations: 50 } },
      [
        { harnessSlug: 'email', startedAtMs: NOW - 40 * 60 * 1000, live: true }, // parked after recording
        { harnessSlug: 'crm', startedAtMs: NOW - SU_IDEATE_PASS_STALE_MS - 1, live: true }, // stale
      ],
    );
    const out = await runSuIdeateSchedule({ workspaceId: 'ws', nowMs: NOW }, deps);
    expect(out.stopped).toBeUndefined();
    expect(launch.mock.calls[0][0].harnessSlug).toBe('portal');
  });

  it('opens the circuit after the max attempts since the last pass and moves to the next harness', async () => {
    const dead = Array.from({ length: SU_IDEATE_MAX_ATTEMPTS }, (_, i) => ({
      harnessSlug: 'email',
      startedAtMs: NOW - (30 - i) * HOUR,
      live: false,
    }));
    const { deps, launch } = makeDeps(
      { email: { lastPassMs: NOW - 40 * HOUR, observations: 50 }, portal: { lastPassMs: NOW - HOUR, observations: 50 } },
      dead,
    );
    const out = await runSuIdeateSchedule({ workspaceId: 'ws', nowMs: NOW }, deps);
    expect(out.decisions[0]).toMatchObject({ harnessSlug: 'email', disposition: 'attempts-exhausted', attempts: SU_IDEATE_MAX_ATTEMPTS });
    expect(launch.mock.calls[0][0].harnessSlug).toBe('portal');
  });

  it('numbers a retry after a dead attempt into a fresh idempotency key', async () => {
    const { deps, launch } = makeDeps(
      { email: { lastPassMs: NOW - 9 * HOUR, observations: 50 } },
      [{ harnessSlug: 'email', startedAtMs: NOW - 5 * HOUR, live: false }],
    );
    await runSuIdeateSchedule({ workspaceId: 'ws', nowMs: NOW }, deps);
    expect(launch.mock.calls[0][0].key).toBe(`su-ideate-pass:email:${NOW - 9 * HOUR}:2`);
  });

  it('stops before any read once the rolling-24h launch budget is spent', async () => {
    vi.stubEnv('PAPERCUSP_SU_IDEATE_MAX_LAUNCHES_PER_DAY', '2');
    const { deps, launch, countObservationsSince } = makeDeps(
      { email: { lastPassMs: null, observations: 50 } },
      [
        { harnessSlug: 'portal', startedAtMs: NOW - 3 * HOUR, live: false },
        { harnessSlug: 'crm', startedAtMs: NOW - 5 * HOUR, live: false },
        { harnessSlug: 'crm', startedAtMs: NOW - 30 * HOUR, live: false }, // outside the window
      ],
    );
    const out = await runSuIdeateSchedule({ workspaceId: 'ws', nowMs: NOW }, deps);
    expect(out).toMatchObject({ stopped: 'daily-budget-exhausted', launchesLast24h: 2, budget: 2 });
    expect(launch).not.toHaveBeenCalled();
    expect(countObservationsSince).not.toHaveBeenCalled();
  });

  it('counts attempts only after the last recorded pass, for that harness alone', () => {
    const launches: SuIdeateLaunchRecord[] = [
      { harnessSlug: 'email', startedAtMs: NOW - 10 * HOUR, live: false }, // before the pass
      { harnessSlug: 'email', startedAtMs: NOW - 3 * HOUR, live: false },
      { harnessSlug: 'portal', startedAtMs: NOW - 2 * HOUR, live: false },
    ];
    expect(suIdeateAttemptsSinceLastPass(launches, 'email', NOW - 5 * HOUR)).toHaveLength(1);
    expect(suIdeateAttemptsSinceLastPass(launches, 'email', null)).toHaveLength(2);
  });

  it('a refused launch ends the tick with the error, without trying the next harness', async () => {
    const { deps, launch } = makeDeps({
      email: { lastPassMs: null, observations: 50 },
      portal: { lastPassMs: NOW - HOUR, observations: 50 },
    });
    launch.mockResolvedValueOnce({ ok: false, error: 'governor refused admission' });
    const out = await runSuIdeateSchedule({ workspaceId: 'ws', nowMs: NOW }, deps);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(out.launched).toBeUndefined();
    expect(out.decisions).toEqual([
      expect.objectContaining({ harnessSlug: 'email', disposition: 'launch-failed', error: 'governor refused admission' }),
    ]);
  });

  it('a harness-specific scope refusal preserves the denial and reaches the next permitted overdue harness', async () => {
    const { deps, launch } = makeDeps({
      crm: { lastPassMs: null, observations: 10 },
      papercusp: { lastPassMs: null, observations: 50 },
      portal: { lastPassMs: null, observations: 50 },
    });
    const refusal = "scope_denied: harness 'crm' is outside the workspace work-scope policy (allowed: papercusp, portal)";
    launch.mockResolvedValueOnce({ ok: false, error: refusal });

    const out = await runSuIdeateSchedule({ workspaceId: 'ws', nowMs: NOW }, deps);

    expect(launch.mock.calls.map(([input]) => input.harnessSlug)).toEqual(['crm', 'papercusp']);
    expect(out.launched?.harnessSlug).toBe('papercusp');
    expect(out.decisions).toEqual([
      expect.objectContaining({ harnessSlug: 'crm', disposition: 'launch-failed', error: refusal }),
      expect.objectContaining({ harnessSlug: 'papercusp', disposition: 'launched' }),
    ]);
  });

  it('an unknown global refusal mentioning scope denial still ends the tick', async () => {
    const { deps, launch } = makeDeps({
      crm: { lastPassMs: null, observations: 50 },
      papercusp: { lastPassMs: null, observations: 50 },
    });
    launch.mockResolvedValueOnce({ ok: false, error: 'gateway failure after scope_denied: diagnostic' });

    const out = await runSuIdeateSchedule({ workspaceId: 'ws', nowMs: NOW }, deps);

    expect(launch).toHaveBeenCalledTimes(1);
    expect(out.launched).toBeUndefined();
  });
});

describe('su-ideate open circuits — the dead-pass alarm feed (plan D-010)', () => {
  const dead = (harnessSlug: string, n: number, newestAgoH = 3, live = false): SuIdeateLaunchRecord[] =>
    Array.from({ length: n }, (_, i) => ({ harnessSlug, startedAtMs: NOW - (newestAgoH + i) * HOUR, live }));

  it('reports a harness whose max scheduled passes since its last pass all ended without recording', async () => {
    const { deps } = makeDeps(
      { email: { lastPassMs: NOW - 40 * HOUR }, portal: { lastPassMs: NOW - HOUR } },
      [...dead('email', SU_IDEATE_MAX_ATTEMPTS), ...dead('portal', 1)],
    );
    const out = await readSuIdeateOpenCircuits('ws', NOW, deps);
    expect(out).toEqual({
      harnessesChecked: 2,
      open: [{ harnessSlug: 'email', attempts: SU_IDEATE_MAX_ATTEMPTS, lastPassMs: NOW - 40 * HOUR, lastLaunchMs: NOW - 3 * HOUR }],
    });
  });

  it('agrees with the scheduler: the harness it reports is exactly the one the tick skips as attempts-exhausted', async () => {
    const launches = dead('email', SU_IDEATE_MAX_ATTEMPTS);
    const { deps } = makeDeps({ email: { lastPassMs: null, observations: 50 } }, launches);
    const [open, tick] = await Promise.all([
      readSuIdeateOpenCircuits('ws', NOW, deps),
      runSuIdeateSchedule({ workspaceId: 'ws', nowMs: NOW }, deps),
    ]);
    expect(open.open.map((c) => c.harnessSlug)).toEqual(['email']);
    expect(tick.decisions[0]).toMatchObject({ harnessSlug: 'email', disposition: 'attempts-exhausted' });
  });

  it('is not open while the newest attempt is live and fresh (it may still record)', async () => {
    const launches = [{ harnessSlug: 'email', startedAtMs: NOW - HOUR, live: true }, ...dead('email', SU_IDEATE_MAX_ATTEMPTS - 1)];
    const { deps } = makeDeps({ email: { lastPassMs: null } }, launches);
    expect((await readSuIdeateOpenCircuits('ws', NOW, deps)).open).toEqual([]);
    // …but a live attempt older than the stale window no longer defers the alarm.
    const stale = [{ harnessSlug: 'email', startedAtMs: NOW - SU_IDEATE_PASS_STALE_MS - HOUR, live: true }, ...dead('email', SU_IDEATE_MAX_ATTEMPTS - 1)];
    const { deps: staleDeps } = makeDeps({ email: { lastPassMs: null } }, stale);
    expect((await readSuIdeateOpenCircuits('ws', NOW, staleDeps)).open.map((c) => c.harnessSlug)).toEqual(['email']);
  });

  it('a harness whose pot learning switch is off is deliberate silence, not an open circuit', async () => {
    const { deps } = makeDeps({ email: { lastPassMs: null, enabled: false } }, dead('email', SU_IDEATE_MAX_ATTEMPTS));
    expect(await readSuIdeateOpenCircuits('ws', NOW, deps)).toEqual({ harnessesChecked: 1, open: [] });
  });

  it('launches before the last recorded pass do not count toward the circuit', async () => {
    const { deps } = makeDeps({ email: { lastPassMs: NOW - 2 * HOUR } }, dead('email', SU_IDEATE_MAX_ATTEMPTS, 3));
    expect((await readSuIdeateOpenCircuits('ws', NOW, deps)).open).toEqual([]);
  });
});
