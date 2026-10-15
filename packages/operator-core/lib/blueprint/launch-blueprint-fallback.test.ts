/**
 * Tests for defaultFire's fallback-spawn-recording path (WI-108):
 * when durableSpawnFire is unavailable (DBOS off or inside a step), the
 * fire-and-forget loopbackFetch now also records a durable spawned_agents row
 * so the launch is visible in fleet:tree instead of silently untracked.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  configureScheduledRegistry,
  resetScheduledRegistry,
  type TimerHandle,
} from '@papercusp/scheduled-registry';

// Use vi.fn() directly inside factories — avoids the TDZ issue from referencing
// module-level vars inside hoisted vi.mock calls.
// Spread the real module so a lazy transitive import (curation-surface →
// operator-conversations → `generated`) the async tail may touch still resolves;
// only getOrgPg is overridden with the test handle.
vi.mock('@papercusp/db-org', async (importActual) => ({
  ...(await importActual<typeof import('@papercusp/db-org')>()),
  getOrgPg: vi.fn(),
}));
vi.mock('../fleet/spawn-tree', async original => ({
  ...(await original<typeof import('../fleet/spawn-tree')>()),
  recordSpawn: vi.fn(), finishSpawn: vi.fn(), recordSpawnAccountRoute: vi.fn(async () => {}),
}));
// Heartbeat the launch row (P-011 liveness fix) — the SPAWN_HEARTBEAT_INTERVAL_MS
// is kept SMALL here so the interval fires within the test (the real 60s never would).
// Release-fix also stamps its short-lived firing process until /invoke hands the row
// to the actual child; other roles remain route-stamped only.
vi.mock('../fleet/spawn-reclaim', () => ({
  heartbeatSpawns: vi.fn(),
  recordSpawnPid: vi.fn(() => Promise.resolve()),
  SPAWN_HEARTBEAT_INTERVAL_MS: 10,
}));
vi.mock('../loopback-fetch', async (importActual) => ({
  ...(await importActual<typeof import('../loopback-fetch')>()),
  loopbackFetch: vi.fn(),
}));
// DBOS inactive → goes straight to fire-and-forget fallback.
vi.mock('../dbos/dbos-flags', () => ({ dbosOrchestratorActive: vi.fn(() => false) }));
vi.mock('../degradation/fallback-observations', () => ({ observeFallback: vi.fn(() => true) }));
const durableSpawnFireMock = vi.hoisted(() => vi.fn());
vi.mock('../dbos/durable-spawn', () => ({ durableSpawnFire: durableSpawnFireMock }));
// Keep no-turn classification deterministic without probing a live gateway.
vi.mock('../inference-gateway/observability', () => ({ gatewayWholesaleThrottled: vi.fn(async () => false) }));

import { getOrgPg } from '@papercusp/db-org';
import { recordSpawn, finishSpawn } from '../fleet/spawn-tree';
import { heartbeatSpawns, recordSpawnPid } from '../fleet/spawn-reclaim';
import { loopbackFetch } from '../loopback-fetch';
import { gatewayWholesaleThrottled } from '../inference-gateway/observability';
import { dbosOrchestratorActive } from '../dbos/dbos-flags';
import {
  fireLaunchBlueprint,
  setLaunchBlueprintFire,
  setLaunchBlueprintResolver,
  resetLaunchBlueprintTriggerMap,
} from './launch-blueprint';
import { loadBuiltinBlueprint } from '@papercusp/orchestrator/blueprint';

const opts = { installSlug: 'papercup', workspaceId: 'ws_test' };

// These tests cover fallback bookkeeping, not the retired Mug/Cup tier. Use
// explicit revived fixtures for those roles; the real default resolver is tested
// separately below so retirement coverage cannot be mistaken for fallback coverage.
beforeEach(() => {
  setLaunchBlueprintResolver((id) => {
    const blueprint = loadBuiltinBlueprint(id).blueprint;
    if (id === 'coding' || id === 'cup') return { ...blueprint, retired: null };
    return blueprint;
  });
});

it('rejects retired coding/cup launch blueprints before fallback bookkeeping can run', async () => {
  setLaunchBlueprintResolver(null);

  await expect(fireLaunchBlueprint('coding', opts)).rejects.toThrow(/blueprint "coding" is RETIRED/i);
  await expect(fireLaunchBlueprint('cup', opts)).rejects.toThrow(/blueprint "cup" is RETIRED/i);
  expect(recordSpawn).not.toHaveBeenCalled();
  expect(loopbackFetch).not.toHaveBeenCalled();
});

function enableRealManagedTimersForTest(): void {
  resetScheduledRegistry();
  configureScheduledRegistry({
    setIntervalImpl: (cb, ms) => setInterval(cb, ms) as unknown as TimerHandle,
    clearIntervalImpl: (handle) => clearInterval(handle as unknown as ReturnType<typeof setInterval>),
  });
}

// Stable mock sql handle — same object every getOrgPg() call so finishSpawn
// gets the same reference that recordSpawn got.
const activeQueenRows: Array<{ spawn_id: string; harness_slug: string | null }> = [];
const mockSql = vi.fn(async (strings: TemplateStringsArray | string) => {
  const text = Array.isArray(strings) ? strings.join(' ') : String(strings);
  if (text.includes('FROM harness_shared.spawned_agents')) return activeQueenRows;
  return [];
}) as unknown as ReturnType<typeof vi.fn> & { begin: (cb: (tx: typeof mockSql) => unknown) => unknown };
mockSql.begin = vi.fn(async (cb: (tx: typeof mockSql) => unknown) => cb(mockSql));

afterEach(() => {
  setLaunchBlueprintFire(null);
  setLaunchBlueprintResolver(null);
  resetLaunchBlueprintTriggerMap();
  activeQueenRows.length = 0;
  vi.clearAllMocks();
  vi.mocked(dbosOrchestratorActive).mockReturnValue(false);
  mockSql.begin = vi.fn(async (cb: (tx: typeof mockSql) => unknown) => cb(mockSql));
  resetScheduledRegistry();
});

describe('defaultFire fallback — durable spawn row (WI-108)', () => {
  beforeEach(() => {
    vi.mocked(getOrgPg).mockReturnValue({ sql: mockSql } as unknown as ReturnType<typeof getOrgPg>);
    vi.mocked(recordSpawn).mockResolvedValue(undefined);
    vi.mocked(finishSpawn).mockResolvedValue(undefined);
    vi.mocked(loopbackFetch).mockResolvedValue(new Response('', { status: 200 }));
    vi.mocked(gatewayWholesaleThrottled).mockResolvedValue(false);
  });

  it('does not launch a direct child after an uncertain durable enqueue', async () => {
    vi.mocked(dbosOrchestratorActive).mockReturnValue(true);
    durableSpawnFireMock.mockRejectedValueOnce(Object.assign(new Error('reply lost'), {
      name: 'DurableSpawnEnqueueUncertainError',
    }));
    await expect(fireLaunchBlueprint('cup', opts)).rejects.toThrow(/reply lost/);
    expect(loopbackFetch).not.toHaveBeenCalled();
    expect(recordSpawn).not.toHaveBeenCalled();
  });

  it('retains the explicitly non-durable fallback when no enqueue was attempted', async () => {
    vi.mocked(dbosOrchestratorActive).mockReturnValue(true);
    durableSpawnFireMock.mockResolvedValueOnce(false);
    const result = await fireLaunchBlueprint('cup', opts);
    expect(result.spawn?.durable).toBe(false);
    expect(loopbackFetch).toHaveBeenCalledOnce();
  });

  it('records a spawned_agents row with status=running before fetch', async () => {
    await fireLaunchBlueprint('cup', opts);

    expect(recordSpawn).toHaveBeenCalledOnce();
    const [sql, input] = vi.mocked(recordSpawn).mock.calls[0]!;
    expect(sql).toBe(mockSql);
    expect(input).toMatchObject({
      workspaceId: 'ws_test',
      harnessSlug: 'papercup',
      childRole: 'cup',
      status: 'running',
      // parent_role is NOT NULL in spawned_agents — a parentless launch records
      // 'operator' (a NULL here failed the insert and untracked EVERY fallback
      // launch; learning-system-audit-improvements-2026-06-09 D-010).
      parentRole: 'operator',
      parentSpawnId: null,
    });
    expect(typeof input.spawnId).toBe('string');
    expect(input.spawnId).toMatch(/^s-\d+-[0-9a-f]{8}$/);
    expect(typeof input.runId).toBe('string');
    expect(input.runId).toMatch(/^launch-\d+-[0-9a-f]{6}$/);
  });

  it('records release-fix pre-handoff ownership, then hands the same row id to /invoke for child PID stamping', async () => {
    await fireLaunchBlueprint('release-fix', opts);

    const recordedSpawnId = vi.mocked(recordSpawn).mock.calls[0]![1].spawnId;
    const [, init] = vi.mocked(loopbackFetch).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.spawnRecordId).toBe(recordedSpawnId);
    expect(recordSpawnPid).toHaveBeenCalledOnce();
    expect(recordSpawnPid).toHaveBeenCalledWith(mockSql, recordedSpawnId, process.pid);
    expect(vi.mocked(recordSpawnPid).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(loopbackFetch).mock.invocationCallOrder[0]!,
    );
  });

  it('keeps non-release fallback rows route-stamped only', async () => {
    await fireLaunchBlueprint('cup', opts);

    expect(recordSpawnPid).not.toHaveBeenCalled();
  });

  it('records the launching parent lineage when the launch carries one', async () => {
    await fireLaunchBlueprint('cup', { ...opts, parent: { spawnId: 's-parent-1', role: 'mug' } });

    expect(recordSpawn).toHaveBeenCalledOnce();
    const [, input] = vi.mocked(recordSpawn).mock.calls[0]!;
    expect(input).toMatchObject({ parentSpawnId: 's-parent-1', parentRole: 'mug' });
  });

  it('flips the row to done after fetch succeeds', async () => {
    await fireLaunchBlueprint('cup', opts);
    await vi.waitFor(() => expect(finishSpawn).toHaveBeenCalledOnce());

    const [sql, input] = vi.mocked(finishSpawn).mock.calls[0]!;
    expect(sql).toBe(mockSql);
    expect(input).toMatchObject({ workspaceId: 'ws_test', status: 'done' });
    // spawnId on finish must match what was recorded
    const recordedSpawnId = vi.mocked(recordSpawn).mock.calls[0]![1].spawnId;
    expect(input.spawnId).toBe(recordedSpawnId);
  });

  it('flips the row to failed after fetch throws', async () => {
    const fetchErr = new Error('loopback: ECONNREFUSED');
    vi.mocked(loopbackFetch).mockRejectedValue(fetchErr);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await fireLaunchBlueprint('cup', opts);
    await vi.waitFor(() => expect(finishSpawn).toHaveBeenCalledOnce());

    const [, input] = vi.mocked(finishSpawn).mock.calls[0]!;
    expect(input).toMatchObject({
      workspaceId: 'ws_test',
      status: 'failed',
      errorMessage: fetchErr.message,
    });
    warn.mockRestore();
  });

  it('opens the durable release-fixer escalation when a release-fix launch times out before its first turn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(loopbackFetch).mockImplementation(async () => new Response(JSON.stringify({
      ok: false,
      exitCode: 143,
      timedOut: true,
      agentOutput: '',
      rawStdoutTail: '[08:16:17 invoke-once received termination signal — aborting agent',
    }), { status: 200 }));

    await fireLaunchBlueprint('release-fix', {
      ...opts,
      bodyExtra: {
        releaseFixerContext: {
          candidate: 'deadbeefcafe0123',
          failingTests: ['lib/gate.test.ts'],
        },
      },
    });
    await vi.waitFor(() => expect(finishSpawn).toHaveBeenCalledTimes(2));

    const sqlTexts = mockSql.mock.calls.map((args) => {
      const strings = args[0] as TemplateStringsArray | string | undefined;
      return Array.isArray(strings) ? strings.join(' ') : String(strings);
    });
    expect(sqlTexts.some((text) => text.includes('INSERT INTO harness_shared.harness_escalations'))).toBe(true);
    const escalationCall = mockSql.mock.calls.find((args) => {
      const strings = args[0] as TemplateStringsArray | string | undefined;
      return (Array.isArray(strings) ? strings.join(' ') : String(strings)).includes(
        'INSERT INTO harness_shared.harness_escalations',
      );
    });
    expect(escalationCall).toBeDefined();
    expect(escalationCall).toContain('green-checkpoint-release-fixer-no-turn');
    expect(vi.mocked(finishSpawn).mock.calls[0]![1]).toMatchObject({ status: 'failed' });
    expect(vi.mocked(finishSpawn).mock.calls[1]![1]).toMatchObject({ status: 'failed' });
    warn.mockRestore();
  });

  it('retries one release-fix infra_loss fallback and suppresses escalation when the retry runs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(loopbackFetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        exitCode: 143,
        timedOut: true,
        agentOutput: '',
        rawStdoutTail: 'first launch died before a turn',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        exitCode: 0,
        agentOutput: 'decision: recovered',
      }), { status: 200 }));

    await fireLaunchBlueprint('release-fix', opts);
    await vi.waitFor(() => expect(finishSpawn).toHaveBeenCalledTimes(2));

    expect(vi.mocked(loopbackFetch)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(finishSpawn).mock.calls[0]![1]).toMatchObject({ status: 'failed' });
    expect(vi.mocked(finishSpawn).mock.calls[1]![1]).toMatchObject({ status: 'done', exitCode: 0 });
    const sqlTexts = mockSql.mock.calls.map((args) => {
      const strings = args[0] as TemplateStringsArray | string | undefined;
      return Array.isArray(strings) ? strings.join(' ') : String(strings);
    });
    expect(sqlTexts.some((text) => text.includes('INSERT INTO harness_shared.harness_escalations'))).toBe(false);
    warn.mockRestore();
  });

  it('does not retry a capacity_shed release-fix fallback', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(gatewayWholesaleThrottled).mockResolvedValue(true);
    vi.mocked(loopbackFetch).mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      exitCode: 1,
      timedOut: false,
      agentOutput: '',
      stderr: '',
    }), { status: 200 }));

    await fireLaunchBlueprint('release-fix', opts);
    await vi.waitFor(() => expect(finishSpawn).toHaveBeenCalledOnce());

    expect(vi.mocked(loopbackFetch)).toHaveBeenCalledOnce();
    expect(vi.mocked(finishSpawn).mock.calls[0]![1]).toMatchObject({
      status: 'failed',
      errorMessage: expect.stringContaining('capacity_shed:'),
    });
    warn.mockRestore();
  });

  it('does not retry an infra_loss fallback for a non-release blueprint', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(loopbackFetch).mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      exitCode: 143,
      timedOut: true,
      agentOutput: '',
    }), { status: 200 }));

    await fireLaunchBlueprint('cup', opts);
    await vi.waitFor(() => expect(finishSpawn).toHaveBeenCalledOnce());

    expect(vi.mocked(loopbackFetch)).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('persists the harvested invoke exit code and stderr tail on a non-release fallback spawn row', async () => {
    const stderr = `${'diagnostic '.repeat(250)}cup child failed before its first turn`;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(loopbackFetch).mockResolvedValue(new Response(JSON.stringify({
      ok: false,
      exitCode: 127,
      timedOut: false,
      agentOutput: '',
      stderr,
      rawStdoutTail: 'raw stdout context',
    }), { status: 200 }));

    await fireLaunchBlueprint('cup', opts);
    await vi.waitFor(() => expect(finishSpawn).toHaveBeenCalledOnce());

    expect(vi.mocked(finishSpawn).mock.calls[0]![1]).toMatchObject({
      status: 'failed',
      exitCode: 127,
      outputTail: stderr.slice(-2000),
    });
    warn.mockRestore();
  });

  it('persists structured exit and stderr fields for a successful invoke too', async () => {
    const stderr = 'release-fixer completed with a non-fatal warning';
    vi.mocked(loopbackFetch).mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      exitCode: 0,
      agentOutput: 'decision: no changes needed',
      stderr,
    }), { status: 200 }));

    await fireLaunchBlueprint('release-fix', opts);
    await vi.waitFor(() => expect(finishSpawn).toHaveBeenCalledOnce());

    expect(vi.mocked(finishSpawn).mock.calls[0]![1]).toMatchObject({
      status: 'done',
      exitCode: 0,
      outputTail: stderr,
    });
  });

  it('keeps an explicitly captured empty stderr distinct from an absent stderr field', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(loopbackFetch).mockResolvedValueOnce(new Response(JSON.stringify({
      ok: false,
      exitCode: 1,
      agentOutput: '',
      stderr: '',
    }), { status: 200 }));
    await fireLaunchBlueprint('cup', opts);
    await vi.waitFor(() => expect(finishSpawn).toHaveBeenCalledOnce());
    expect(vi.mocked(finishSpawn).mock.calls[0]![1]).toMatchObject({ outputTail: '' });

    vi.clearAllMocks();
    vi.mocked(recordSpawn).mockResolvedValue(undefined);
    vi.mocked(finishSpawn).mockResolvedValue(undefined);
    vi.mocked(loopbackFetch).mockResolvedValueOnce(new Response(JSON.stringify({
      ok: false,
      exitCode: 1,
      agentOutput: '',
    }), { status: 200 }));
    await fireLaunchBlueprint('cup', opts);
    await vi.waitFor(() => expect(finishSpawn).toHaveBeenCalledOnce());
    expect(vi.mocked(finishSpawn).mock.calls[0]![1]).toMatchObject({ outputTail: null });
    warn.mockRestore();
  });

  it('still fires loopbackFetch even when recordSpawn throws (best-effort tracking)', async () => {
    vi.mocked(recordSpawn).mockRejectedValue(new Error('pg down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await fireLaunchBlueprint('cup', opts);
    // fetch still went out
    expect(loopbackFetch).toHaveBeenCalledOnce();
    // finishSpawn NOT called (pg is null after the record failure)
    await Promise.resolve();
    expect(finishSpawn).not.toHaveBeenCalled();

    warn.mockRestore();
  });

  it('skips a fallback Queen launch when the workspace already has an active Queen', async () => {
    activeQueenRows.push({ spawn_id: 's-live-queen', harness_slug: 'papercup' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const target = await fireLaunchBlueprint('coding', {
      ...opts,
      kickoff: 'overlapping wake',
      bodyExtra: { queenBrief: 'PRECOMPUTED' },
    });

    expect(target.role).toBe('mug');
    expect(target.spawn).toMatchObject({ spawnId: 's-live-queen', runId: null, durable: false });
    expect(recordSpawn).not.toHaveBeenCalled();
    expect(loopbackFetch).not.toHaveBeenCalled();
    expect(finishSpawn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped duplicate Mug launch'));
    warn.mockRestore();
  });

  it('threads the correct body fields (blueprintId extra, kickoff, timeoutMs) to the invoke route', async () => {
    await fireLaunchBlueprint('cup', { ...opts, kickoff: 'go', timeoutMs: 120_000, extra: ['FOO=bar'] });

    expect(loopbackFetch).toHaveBeenCalledOnce();
    const [, init] = vi.mocked(loopbackFetch).mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.kickoff).toBe('go');
    expect(body.timeoutMs).toBe(120_000);
    expect(body.extra).toContain('BLUEPRINT_ID=cup');
    expect(body.extra).toContain('FOO=bar');
  });
});

/**
 * Heartbeat the long-lived launch row (P-011 liveness fix). `loopbackFetch` holds
 * the connection for the WHOLE worker run — a kind:'hive' Queen wake runs up to the
 * invoke route's 2700s ceiling, far past RECLAIM_STALE_MS (300s). Before this fix the
 * recorded row was never heartbeated, so the P-011 reclaim sweep (opportunistic inside
 * every admitSpawn) reaped a still-running Queen at ~310s ("spawn heartbeat stale > 300s
 * … launching operator host presumed dead"), killing orchestration mid-run (P-033 bench).
 */
describe('defaultFire fallback — heartbeats the launch row while the fetch is in flight (P-011)', () => {
  // Real timers (the SPAWN_HEARTBEAT_INTERVAL_MS mock is 10ms) — fake timers here pull a
  // lazy import chain into the partial @papercusp/db-org mock during microtask flushing.
  //
  // EI-8978 (watchdog-caught flake, 2026-07-09): the ORIGINAL margins here were tick(45)/
  // tick(25) against a 10ms interval — only a 2-4x safety margin. On this box's routinely
  // shared/contended event loop (concurrent vitest workers, host load spikes) a few tens of
  // ms of scheduling jitter is common, so a fixed-sleep-then-assert-exact-count check at
  // this granularity is inherently flaky in BOTH directions: too few beats observed (the
  // "expected 1 to be >= 2" failure) AND — more subtly — extra beats sneaking in before the
  // "no further growth" snapshot is taken (the "expected 14 to be 9" failure). The interval
  // itself is deterministically cleared (`stopHeartbeat()` runs SYNCHRONOUSLY as the first
  // statement of the fetch's `.then`/`.catch`, before any further macrotask can fire — see
  // launch-blueprint.ts), so this is a test-margin problem, not a production race. Fix:
  // widen every margin to a large multiple of the interval (10-30x, still <1s wall-clock
  // total) and poll for the lower-bound instead of asserting after one fixed sleep.
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

  beforeEach(() => {
    enableRealManagedTimersForTest();
    vi.mocked(getOrgPg).mockReturnValue({ sql: mockSql } as unknown as ReturnType<typeof getOrgPg>);
    vi.mocked(recordSpawn).mockResolvedValue(undefined);
    vi.mocked(finishSpawn).mockResolvedValue(undefined);
    vi.mocked(heartbeatSpawns).mockResolvedValue(undefined);
  });

  it('beats the recorded spawnId on the heartbeat interval until the fetch settles', async () => {
    // A fetch that resolves only when we let it — so the row stays "in flight" while we tick.
    let resolveFetch!: (r: Response) => void;
    vi.mocked(loopbackFetch).mockReturnValue(new Promise<Response>((r) => { resolveFetch = r; }));

    await fireLaunchBlueprint('cup', { ...opts, kickoff: 'wake' });
    const recordedSpawnId = vi.mocked(recordSpawn).mock.calls[0]![1].spawnId;

    // Poll for the ≥2-beats threshold instead of a fixed sleep — robust to scheduling
    // jitter that would otherwise slow the interval below the naive tick(45) assumption.
    await vi.waitFor(() => expect(vi.mocked(heartbeatSpawns).mock.calls.length).toBeGreaterThanOrEqual(2), {
      timeout: 3000,
    });
    for (const [sql, ids] of vi.mocked(heartbeatSpawns).mock.calls) {
      expect(sql).toBe(mockSql);
      expect(ids).toEqual([recordedSpawnId]);
    }

    // Worker finishes → the heartbeat stops (synchronously, before finishSpawn is even
    // invoked — see the STATUS comment above) and the row flips done.
    resolveFetch(new Response('', { status: 200 }));
    await vi.waitFor(() => expect(finishSpawn).toHaveBeenCalledOnce());
    const beatsAtFinish = vi.mocked(heartbeatSpawns).mock.calls.length;

    // No further beats after the fetch settled (the interval was cleared). A generous
    // multiple of the interval — not a razor-thin margin — so this genuinely proves
    // stability rather than just outrunning the next scheduling slot.
    await tick(300);
    expect(vi.mocked(heartbeatSpawns).mock.calls.length).toBe(beatsAtFinish);
  });

  it('stops heartbeating when the fetch fails too (no leak)', async () => {
    let rejectFetch!: (e: unknown) => void;
    vi.mocked(loopbackFetch).mockReturnValue(new Promise<Response>((_r, rej) => { rejectFetch = rej; }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await fireLaunchBlueprint('cup', opts);
    await vi.waitFor(() => expect(heartbeatSpawns).toHaveBeenCalled(), { timeout: 3000 });

    rejectFetch(new Error('loopback: ECONNREFUSED'));
    await vi.waitFor(() => expect(finishSpawn).toHaveBeenCalledOnce());
    const beatsAtFail = vi.mocked(heartbeatSpawns).mock.calls.length;
    await tick(300);
    expect(vi.mocked(heartbeatSpawns).mock.calls.length).toBe(beatsAtFail);
    warn.mockRestore();
  });

  it('does not heartbeat when the row was never recorded (pg null)', async () => {
    vi.mocked(recordSpawn).mockRejectedValue(new Error('pg down'));
    vi.mocked(loopbackFetch).mockResolvedValue(new Response('', { status: 200 }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await fireLaunchBlueprint('cup', opts);
    await tick(300);
    expect(heartbeatSpawns).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
