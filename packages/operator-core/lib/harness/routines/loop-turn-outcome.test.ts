import { describe, it, expect, vi, beforeEach } from 'vitest';

// EI-13818: handleLoopResumeTurnExit reaches these via dynamic `await import(...)` at the
// call site (not through LoopTurnOutcomeDeps), so they're mocked at the module level —
// mirroring autoloop-chronic-failure.test.ts's exact pattern for the same primitives.
vi.mock('../../pot/watchdog', () => ({ claimWatchdogFire: vi.fn() }));
vi.mock('../improvements/capture-core', () => ({ captureImprovement: vi.fn() }));
vi.mock('../../overwatch/wake-bridge', () => ({ requestOverwatchWake: vi.fn() }));
vi.mock('../../pot/wake', () => ({ resolvePotHomeSlug: vi.fn(() => 'papercusp') }));

import {
  loopRoutineIdFromSource,
  computeDeathRearmMs,
  handleLoopResumeTurnExit,
} from './loop-turn-outcome';
import type { ResumeTurnOutcome } from '../../events/await/resume-turn-outcome';
import type { DeliveryWork } from '../../events/await/types';
import type { ResumeTurnExitRaw } from '../../events/await/resume-turn-outcome';
import { claimWatchdogFire } from '../../pot/watchdog';
import { captureImprovement } from '../improvements/capture-core';
import type { CaptureImprovementResult } from '../improvements/capture-core';
import { requestOverwatchWake } from '../../overwatch/wake-bridge';
import { mockResolvedTyped } from '../../testing/typed-mock';

const INTERVAL_MS = 120_000;

/**
 * These tests only care THAT `captureImprovement` resolved, never what it returned — but
 * the fixture is still typed rather than cast `as never`, so a new REQUIRED field on
 * CaptureImprovementResult becomes a compile error here instead of a runtime failure in
 * someone else's green-checkpoint run (EI-19282401068515102 / lint:mock-cast-escape).
 */
const CAPTURE_OK: CaptureImprovementResult = { ok: true, created: true, possibleDuplicates: [] };

const deathRaw = (over: Partial<ResumeTurnExitRaw> = {}): ResumeTurnExitRaw => ({
  exitCode: 1,
  signal: null,
  stdoutTail: 'API Error: 429 Too Many Requests · Rate limited',
  stderrTail: '',
  ...over,
});

const loopDelivery = (over: Partial<DeliveryWork> = {}): DeliveryWork =>
  ({
    id: 1,
    workspaceId: 'coord-ws',
    awaitId: 1,
    subscriberId: 'su-owner',
    eventKey: 'coord:inbox-wake:su-owner',
    payload: null,
    summary: null,
    status: 'delivered',
    channel: 'resume-headless',
    attempts: 1,
    lastError: null,
    nextAttemptAt: new Date(0).toISOString(),
    createdAt: new Date(0).toISOString(),
    deliveredAt: null,
    urgent: false,
    minSleepSec: null,
    coalescedCount: 1,
    source: 'loop:loop_su_owner',
    wakeHandle: null,
    note: null,
    ...over,
  }) as DeliveryWork;

/** A fake postgres-js tagged-template: routes SELECT → the routine ref, UPDATE → rearm rows,
 *  and records every call so the test can assert what ran. */
function fakeSql(opts: { ref?: Record<string, unknown> | null; rearmRows?: { id: string }[]; failTransition?: boolean } = {}) {
  const calls: { kind: 'select' | 'update' | 'other'; text: string; values: unknown[] }[] = [];
  const fn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (/^\s*SELECT/i.test(text)) {
      calls.push({ kind: 'select', text, values });
      return Promise.resolve(opts.ref === undefined ? [] : opts.ref ? [opts.ref] : []);
    }
    if (/UPDATE/i.test(text)) {
      calls.push({ kind: 'update', text, values });
      return Promise.resolve(opts.rearmRows ?? [{ id: 'loop_su_owner' }]);
    }
    calls.push({ kind: 'other', text, values });
    if (opts.failTransition && text.includes('INSERT INTO harness_shared.routine_loop_transitions')) {
      return Promise.reject(new Error('simulated transition-log failure'));
    }
    return Promise.resolve([]);
  };
  return Object.assign(fn, { calls });
}

const refRow = {
  id: 'loop_su_owner',
  name: 'loop-su-owner',
  install_slug: 'papercusp',
  workspace_id: 'ws-papercusp',
  reschedule_interval_sec: 120,
  target_owner_id: 'su-owner',
  payload_template: {
    goal: 'drain the bug queue',
    continuation: 'gated',
    mode: 'monitor',
    costCapCents: 25,
    maxFires: 8,
    maxDurationSec: 900,
  },
};

describe('loopRoutineIdFromSource', () => {
  it('parses loop:<id>', () => {
    expect(loopRoutineIdFromSource('loop:loop_su_owner')).toBe('loop_su_owner');
  });
  it('returns null for non-loop / empty / null sources', () => {
    expect(loopRoutineIdFromSource('lock:grant:t1')).toBeNull();
    expect(loopRoutineIdFromSource('loop:')).toBeNull();
    expect(loopRoutineIdFromSource(null)).toBeNull();
    expect(loopRoutineIdFromSource(undefined)).toBeNull();
  });
});

describe('computeDeathRearmMs (P1a — 429-aware re-arm)', () => {
  const rateDeath = (over: Partial<{ retryAfterMs: number; resetAt: number; class: string }> = {}): ResumeTurnOutcome => ({
    ok: false,
    error: { class: 'rate_limited', message: 'm', provider: 'anthropic', retryable: true, ...over } as never,
  });

  it('uses retry-after when it exceeds the interval (capped)', () => {
    expect(computeDeathRearmMs(rateDeath({ retryAfterMs: 300_000 }), INTERVAL_MS)).toBe(300_000);
  });
  it('floors at the interval when retry-after is shorter', () => {
    expect(computeDeathRearmMs(rateDeath({ retryAfterMs: 5_000 }), INTERVAL_MS)).toBe(INTERVAL_MS);
  });
  // WI-6852: the ceiling is 6h, not 1h. At 1h it BOUND on every real provider wall (measured:
  // 13 of 15 lifecycle-death re-arms landed on exactly 60m, so each under-waited and re-fired
  // into a still-active wall) instead of acting as the sanity rail against a bogus parse.
  it('caps an absurd retry-after at the 6h sanity ceiling', () => {
    expect(computeDeathRearmMs(rateDeath({ retryAfterMs: 9_999_999_999 }), INTERVAL_MS)).toBe(6 * 3_600_000);
  });
  it('no longer clips a realistic multi-hour wall (the 1h cap used to)', () => {
    expect(computeDeathRearmMs(rateDeath({ retryAfterMs: 3 * 3_600_000 }), INTERVAL_MS)).toBe(3 * 3_600_000);
  });
  it('uses resetAt - now when there is no retry-after', () => {
    const now = 1_000_000;
    const outcome: ResumeTurnOutcome = {
      ok: false,
      error: { class: 'usage_limit', message: 'm', provider: 'anthropic', retryable: false, resetAt: now + 600_000 } as never,
    };
    expect(computeDeathRearmMs(outcome, INTERVAL_MS, now)).toBe(600_000);
  });
  it('falls back to the interval for a non-rate-limit death (crash)', () => {
    const crash: ResumeTurnOutcome = {
      ok: false,
      error: { class: 'agent_crash', message: 'boom', provider: 'anthropic', retryable: true } as never,
    };
    expect(computeDeathRearmMs(crash, INTERVAL_MS)).toBe(INTERVAL_MS);
  });
});

describe('handleLoopResumeTurnExit (P0b — feed the circuit on a dead loop turn)', () => {
  it.each([
    { rearm: true, failTransition: false },
    { rearm: true, failTransition: true },
    { rearm: false, failTransition: false },
  ])('EI-25819428676194926: a 429 death records only actual rearms and tolerates logger failure (%j)', async ({ rearm, failTransition }) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}); // the handler logs the observed death (expected)
    const sql = fakeSql({ ref: refRow, rearmRows: rearm ? [{ id: 'loop_su_owner' }] : [], failTransition });
    const recordFire = vi.fn(async () => {});
    const res = await handleLoopResumeTurnExit(loopDelivery(), deathRaw(), { sql: sql as never, recordFire });

    expect(res.handled).toBe(true);
    expect(res.class).toBe('rate_limited');
    if (rearm) expect(res.rearmedMs).toBeGreaterThan(0);
    else expect(res.rearmedMs).toBeUndefined();
    // Fed the EXISTING circuit with the loop's exact fire-gate key + 'error'.
    expect(recordFire).toHaveBeenCalledTimes(1);
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-owner', expect.stringContaining('rate_limited'), 'infra-error') // WI-669: infra-shaped — counter preserved;
    // Issued the re-arm UPDATE (guarded to the parked 'infinity' row).
    const update = sql.calls.find((c) => c.kind === 'update');
    expect(update).toBeTruthy();
    expect(update!.text).toContain("'infinity'");
    const transitions = sql.calls.filter((c) => c.text.includes('INSERT INTO harness_shared.routine_loop_transitions'));
    expect(transitions).toHaveLength(rearm ? 1 : 0);
    if (rearm) {
      expect(transitions[0].values.slice(0,8)).toEqual([
        'ws-papercusp', 'papercusp', 'loop_su_owner', 'loop-su-owner',
        'system:loop-wake', 'su-owner', 'rearmed', 'loop-turn-outcome',
      ]);
      // Compare the emitted deadline with the actual guarded UPDATE's bound value.
      expect(transitions[0].values[8]).toBe(update!.values[0]);
      const detail = transitions[0].values[10];
      expect(typeof detail).toBe('string');
      if (typeof detail !== 'string') throw new Error('missing transition provenance');
      expect(JSON.parse(detail)).toMatchObject({
        via: 'resume-turn-death', class: 'rate_limited', deliveryId: 1,
        source: 'loop:loop_su_owner', delayMs: res.rearmedMs,
      });
    }
  });

  it('ties a provider-derived retry deadline marker to the exact guarded next_fire_at write', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const now = 1_782_000_000_000;
    const sql = fakeSql({ ref: refRow, rearmRows: [{ id: 'loop_su_owner' }] });
    const res = await handleLoopResumeTurnExit(
      loopDelivery(),
      deathRaw({ stdoutTail: "You've hit your session limit · resets in 3 hours" }),
      { sql: sql as never, recordFire: vi.fn(async () => {}), now },
    );

    expect(res.rearmedMs).toBeGreaterThan(120_000);
    const update = sql.calls.find((call) => call.kind === 'update');
    expect(update).toBeTruthy();
    expect(update!.text).toContain('providerRetrySchedule');
    expect(update!.text).toContain('resume-turn-death');
    const exactDeadline = new Date(now + res.rearmedMs!).toISOString();
    expect(update!.values.filter((value) => value === exactDeadline)).toHaveLength(2);
    expect(update!.values).toContain(true);
  });

  it('a Codex exit 0 without turn.completed records malformed_output and re-arms the loop', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({ ref: refRow, rearmRows: [{ id: 'loop_su_owner' }] });
    const recordFire = vi.fn(async () => {});
    const res = await handleLoopResumeTurnExit(
      loopDelivery(),
      deathRaw({
        exitCode: 0,
        stdoutTail: '{"type":"item.completed","item":{"type":"command_execution","exit_code":0}}',
        outputProtocol: 'codex-jsonl',
      }),
      { sql: sql as never, recordFire },
    );

    expect(res).toMatchObject({ handled: true, class: 'malformed_output' });
    expect(recordFire).toHaveBeenCalledWith(
      'papercusp',
      'loop-su-owner',
      expect.stringContaining('malformed_output'),
      'error',
    );
    expect(sql.calls.some((c) => c.kind === 'update')).toBe(true);
  });

  it('a SURVIVED loop turn (clean exit) is a no-op — reconcile owns the ok reset', async () => {
    const sql = fakeSql({ ref: refRow });
    const recordFire = vi.fn(async () => {});
    const res = await handleLoopResumeTurnExit(loopDelivery(), deathRaw({ exitCode: 0, stdoutTail: 'done' }), {
      sql: sql as never,
      recordFire,
    });
    expect(res.handled).toBe(false);
    expect(recordFire).not.toHaveBeenCalled();
    expect(sql.calls).toHaveLength(0); // never even touched the DB
  });

  it('a NON-loop wake death is ignored (no attribution to any loop)', async () => {
    const sql = fakeSql({ ref: refRow });
    const recordFire = vi.fn(async () => {});
    const res = await handleLoopResumeTurnExit(loopDelivery({ source: 'lock:grant:t1' }), deathRaw(), {
      sql: sql as never,
      recordFire,
    });
    expect(res.handled).toBe(false);
    expect(recordFire).not.toHaveBeenCalled();
    expect(sql.calls).toHaveLength(0);
  });

  it('a loop that has since ended (routine row gone) records nothing', async () => {
    const sql = fakeSql({ ref: null });
    const recordFire = vi.fn(async () => {});
    const res = await handleLoopResumeTurnExit(loopDelivery(), deathRaw(), { sql: sql as never, recordFire });
    expect(res.handled).toBe(false);
    expect(recordFire).not.toHaveBeenCalled();
  });

  it('a context-overflow death pauses the loop and never re-arms the same oversized warm transcript', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(claimWatchdogFire).mockResolvedValue(true);
    mockResolvedTyped(vi.mocked(captureImprovement), CAPTURE_OK);
    vi.mocked(requestOverwatchWake).mockResolvedValue({ wired: true, result: { fired: true } });
    const sql = fakeSql({ ref: refRow, rearmRows: [{ id: 'loop_su_owner' }] });
    const recordFire = vi.fn(async () => {});
    const autoPause = vi.fn(async () => {});
    const res = await handleLoopResumeTurnExit(
      loopDelivery(),
      deathRaw({ stdoutTail: 'Prompt is too long: 210000 tokens > 200000 maximum' }),
      { sql: sql as never, recordFire, autoPause },
    );

    expect(res).toMatchObject({ handled: true, class: 'context_overflow' });
    expect(res.rearmedMs).toBeUndefined();
    expect(autoPause).toHaveBeenCalledWith(
      sql,
      'loop_su_owner',
      expect.stringContaining('paused to prevent repeated oversized warm wakes'),
      'loop-turn-outcome',
    );
    expect(sql.calls.filter((c) => c.kind === 'update')).toHaveLength(0);
    expect(captureImprovement).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'bug',
        body: expect.stringContaining('context-overflow terminal guard'),
      }),
    );
    expect(requestOverwatchWake).toHaveBeenCalledTimes(1);
  });

  it('a missing tool-reference API 400 pauses the loop and surfaces fresh-session recovery', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(claimWatchdogFire).mockResolvedValue(true);
    mockResolvedTyped(vi.mocked(captureImprovement).mockClear(), CAPTURE_OK);
    vi.mocked(requestOverwatchWake).mockClear().mockResolvedValue({ wired: true, result: { fired: true } });
    const sql = fakeSql({ ref: refRow, rearmRows: [{ id: 'loop_su_owner' }] });
    const recordFire = vi.fn(async () => {});
    const autoPause = vi.fn(async () => {});
    const res = await handleLoopResumeTurnExit(
      loopDelivery(),
      deathRaw({
        exitCode: 0,
        signal: null,
        stdoutTail: "API Error: 400 Tool reference 'Monitor' not found in available tools",
        stderrTail: '',
      }),
      { sql: sql as never, recordFire, autoPause },
    );

    expect(res).toMatchObject({ handled: true, class: 'permanent' });
    expect(res.rearmedMs).toBeUndefined();
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-owner', 'resume-turn-death:permanent', 'error');
    expect(autoPause).toHaveBeenCalledWith(
      sql,
      'loop_su_owner',
      expect.stringContaining('stale tool reference'),
      'loop-turn-outcome',
    );
    expect(sql.calls.filter((c) => c.kind === 'update')).toHaveLength(0);
    const body = vi.mocked(captureImprovement).mock.calls.at(-1)?.[0]?.body as string;
    expect(body).toContain('stale-tool-reference terminal guard');
    expect(body).toContain('fresh session');
    expect(body).not.toContain('every wake risks re-firing');
    expect(requestOverwatchWake).toHaveBeenCalledTimes(1);
  });

  it('a context-overflow death queues carry-respawn first, then re-arms the loop cold through CAS', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(claimWatchdogFire).mockResolvedValue(false);
    const sql = fakeSql({ ref: refRow, rearmRows: [{ id: 'loop_su_owner' }] });
    const recordFire = vi.fn(async () => {});
    const order: string[] = [];
    const autoPause = vi.fn(async () => {
      order.push('pause');
    });
    const availability = vi.fn(async () => ({
      available: true as const,
      reason: null,
      host: { ownerId: 'su-owner', sock: '/tmp/su-owner.sock' },
    }));
    const buildRespawnSpec = vi.fn(async () => ({
      systemPromptAddendum: 'RECOVERY-ADDENDUM',
      firstPrompt: null,
      budgetChars: 24_000,
      openOwnerQuestion: { crossesOpenOwnerMessage: false },
    }));
    const injectPsuHost = vi.fn(async () => {
      order.push('inject');
      return true;
    });
    const markRespawnExpected = vi.fn(async () => {
      order.push('mark');
    });
    const bumpSessionEpoch = vi.fn(async () => {
      order.push('epoch');
      return 1;
    });
    let materializedInput: unknown;
    const materializeLoop = vi.fn(async (input: unknown) => {
      order.push('materialize');
      materializedInput = input;
      return {
        id: 'loop_su_owner',
        name: 'loop-su-owner',
        nextFireAt: null,
        targetRole: 'system:loop-wake',
        intervalSec: 120,
        changed: true,
      };
    });

    const res = await handleLoopResumeTurnExit(
      loopDelivery(),
      deathRaw({ stdoutTail: 'Prompt is too long: 210000 tokens > 200000 maximum' }),
      {
        sql: sql as never,
        recordFire,
        autoPause,
        selfCompactionAvailabilityAsync: availability as never,
        buildRespawnSpec: buildRespawnSpec as never,
        injectPsuHost: injectPsuHost as never,
        markRespawnExpected: markRespawnExpected as never,
        bumpSessionEpoch: bumpSessionEpoch as never,
        materializeLoop: materializeLoop as never,
        effectiveWindowTokens: 210_000,
      },
    );

    expect(res).toMatchObject({
      handled: true,
      class: 'context_overflow',
      recoveryQueued: true,
      recoveryRearmed: true,
    });
    expect(res.rearmedMs).toBeUndefined();
    expect(order).toEqual(['pause', 'inject', 'mark', 'epoch', 'materialize']);
    expect(availability).toHaveBeenCalledWith('su-owner');
    expect(buildRespawnSpec).toHaveBeenCalledWith(
      'su-owner',
      expect.objectContaining({
        effectiveWindowTokens: 210_000,
        buildOpts: { workspaceId: 'ws-papercusp', boundaryDeliberate: true },
      }),
    );
    expect(injectPsuHost).toHaveBeenCalledWith(
      '/tmp/su-owner.sock',
      expect.objectContaining({
        mode: 'carry-respawn',
        ownerId: 'su-owner',
        systemPromptAddendum: 'RECOVERY-ADDENDUM',
        data: expect.stringContaining('Context-overflow recovery queued'),
      }),
      15 * 60_000,
    );
    const recoveryPayload = (injectPsuHost.mock.calls as unknown as Array<[string, { data?: unknown }]>)[0]?.[1];
    const recoveryPrompt = String(recoveryPayload?.data ?? '');
    expect(recoveryPrompt).toContain('ADDRESSED TO su-owner');
    expect(recoveryPrompt.indexOf('ADDRESSED TO su-owner')).toBeLessThan(
      recoveryPrompt.indexOf('Context-overflow recovery queued'),
    );
    expect(recoveryPrompt).toContain('⟦post-compaction-recovery⟧');
    expect(recoveryPrompt).toContain('do not call coord:orient');
    expect(recoveryPrompt).toContain('coord:declare-intent { intent, current_plan_slug, items }');
    expect(recoveryPrompt).toContain('exactly once only when the marker is absent');
    expect(recoveryPrompt).not.toContain('Re-run coord:orient');
    expect(bumpSessionEpoch).toHaveBeenCalledWith(sql, 'su-owner');
    expect(materializedInput).toMatchObject({
      workspaceId: 'ws-papercusp',
      harnessSlug: 'papercusp',
      ownerId: 'su-owner',
      intervalSec: 120,
      carry: 'cold',
      active: true,
      onlyIfInactive: true,
      sql,
    });
    expect((materializedInput as { kickoff: string }).kickoff).toContain("COLD loop (carry:'cold')");
    // The legacy warm re-arm is guarded out for the entire context-overflow branch.
    expect(sql.calls.filter((c) => c.kind === 'update')).toHaveLength(0);
  });

  it('a context-overflow death with no carry-capable host stays paused and performs no recovery writes', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(claimWatchdogFire).mockResolvedValue(false);
    const sql = fakeSql({ ref: refRow, rearmRows: [{ id: 'loop_su_owner' }] });
    const recordFire = vi.fn(async () => {});
    const autoPause = vi.fn(async () => {});
    const availability = vi.fn(async () => ({ available: false as const, reason: 'no_live_pty_host' as const, host: null }));
    const buildRespawnSpec = vi.fn(async () => null);
    const injectPsuHost = vi.fn(async () => true);
    const markRespawnExpected = vi.fn(async () => {});
    const bumpSessionEpoch = vi.fn(async () => 1);
    const materializeLoop = vi.fn(async (_input: unknown) => ({
      id: 'loop_su_owner',
      name: 'loop-su-owner',
      nextFireAt: null,
      targetRole: 'system:loop-wake',
      intervalSec: 120,
      changed: true,
    }));

    const res = await handleLoopResumeTurnExit(
      loopDelivery(),
      deathRaw({ stdoutTail: 'Prompt is too long: 210000 tokens > 200000 maximum' }),
      {
        sql: sql as never,
        recordFire,
        autoPause,
        selfCompactionAvailabilityAsync: availability as never,
        buildRespawnSpec: buildRespawnSpec as never,
        injectPsuHost: injectPsuHost as never,
        markRespawnExpected: markRespawnExpected as never,
        bumpSessionEpoch: bumpSessionEpoch as never,
        materializeLoop: materializeLoop as never,
      },
    );

    expect(res).toMatchObject({
      handled: true,
      class: 'context_overflow',
      recoveryQueued: false,
      recoveryRearmed: false,
      recoveryReason: 'no_live_pty_host',
    });
    expect(autoPause).toHaveBeenCalledTimes(1);
    expect(buildRespawnSpec).not.toHaveBeenCalled();
    expect(injectPsuHost).not.toHaveBeenCalled();
    expect(markRespawnExpected).not.toHaveBeenCalled();
    expect(bumpSessionEpoch).not.toHaveBeenCalled();
    expect(materializeLoop).not.toHaveBeenCalled();
    expect(sql.calls.filter((c) => c.kind === 'update')).toHaveLength(0);
  });

  it('a context-overflow carry-build failure stays paused and never invokes the socket or cold re-arm', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(claimWatchdogFire).mockResolvedValue(false);
    const sql = fakeSql({ ref: refRow, rearmRows: [{ id: 'loop_su_owner' }] });
    const recordFire = vi.fn(async () => {});
    const autoPause = vi.fn(async () => {});
    const availability = vi.fn(async () => ({
      available: true as const,
      reason: null,
      host: { ownerId: 'su-owner', sock: '/tmp/su-owner.sock' },
    }));
    const buildRespawnSpec = vi.fn(async () => null);
    const injectPsuHost = vi.fn(async () => true);
    const markRespawnExpected = vi.fn(async () => {});
    const bumpSessionEpoch = vi.fn(async () => 1);
    const materializeLoop = vi.fn(async (_input: unknown) => ({
      id: 'loop_su_owner',
      name: 'loop-su-owner',
      nextFireAt: null,
      targetRole: 'system:loop-wake',
      intervalSec: 120,
      changed: true,
    }));

    const res = await handleLoopResumeTurnExit(
      loopDelivery(),
      deathRaw({ stdoutTail: 'Prompt is too long: 210000 tokens > 200000 maximum' }),
      {
        sql: sql as never,
        recordFire,
        autoPause,
        selfCompactionAvailabilityAsync: availability as never,
        buildRespawnSpec: buildRespawnSpec as never,
        injectPsuHost: injectPsuHost as never,
        markRespawnExpected: markRespawnExpected as never,
        bumpSessionEpoch: bumpSessionEpoch as never,
        materializeLoop: materializeLoop as never,
        effectiveWindowTokens: 200_000,
      },
    );

    expect(res).toMatchObject({
      handled: true,
      class: 'context_overflow',
      recoveryQueued: false,
      recoveryRearmed: false,
      recoveryReason: 'carry_build_failed',
    });
    expect(autoPause).toHaveBeenCalledTimes(1);
    expect(injectPsuHost).not.toHaveBeenCalled();
    expect(markRespawnExpected).not.toHaveBeenCalled();
    expect(bumpSessionEpoch).not.toHaveBeenCalled();
    expect(materializeLoop).not.toHaveBeenCalled();
    expect(sql.calls.filter((c) => c.kind === 'update')).toHaveLength(0);
  });

  it('a missing native resume session pauses the loop and never re-arms the stale target', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({ ref: refRow, rearmRows: [{ id: 'loop_su_owner' }] });
    const recordFire = vi.fn(async () => {});
    const autoPause = vi.fn(async () => {});
    const res = await handleLoopResumeTurnExit(
      loopDelivery(),
      deathRaw({
        stdoutTail: 'Error: Session "01a02f7b-b7be-7030-ad56-53149607c6cd" not found',
        stderrTail: '',
      }),
      { sql: sql as never, recordFire, autoPause },
    );

    expect(res).toMatchObject({ handled: true, class: 'permanent' });
    expect(recordFire).toHaveBeenCalledWith(
      'papercusp',
      'loop-su-owner',
      'resume-target-stale:permanent',
      'error',
    );
    expect(autoPause).toHaveBeenCalledWith(
      sql,
      'loop_su_owner',
      expect.stringContaining('stale resume target'),
      'loop-turn-outcome',
    );
    expect(sql.calls.filter((c) => c.kind === 'update')).toHaveLength(0);
  });

  // EI-21331509652694202. `auth` is marked NOT retryable by the shared taxonomy ("401/403 — NOT
  // retryable without new creds") but used to land in the re-arm branch, where
  // computeDeathRearmMs special-cases only rate_limited/usage_limit — so it fell through to the
  // PLAIN interval and respawned a CLI into the same rejected credential every intervalSec
  // forever. Measured live on loop-su-173ff9eb: 0 real turns in 18 minutes on a ~77s cadence.
  it('an auth-wall death pauses the loop and never re-arms into the rejected credential', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(claimWatchdogFire).mockResolvedValue(true);
    mockResolvedTyped(vi.mocked(captureImprovement), CAPTURE_OK);
    vi.mocked(requestOverwatchWake).mockResolvedValue({ wired: true, result: { fired: true } });
    const sql = fakeSql({ ref: refRow, rearmRows: [{ id: 'loop_su_owner' }] });
    const recordFire = vi.fn(async () => {});
    const autoPause = vi.fn(async () => {});
    const res = await handleLoopResumeTurnExit(
      loopDelivery(),
      // A detached resume's exact 401 error; the classifier scans both streams
      // before an exit can be trusted as success.
      deathRaw({
        exitCode: 1,
        signal: null,
        stdoutTail: '',
        stderrTail:
          '2026-09-24T06:54:20.399557Z ERROR codex_api::endpoint::responses_websocket: ' +
          'failed to connect to websocket: HTTP error: 401 Unauthorized, url: wss://api.openai.com/v1/responses',
      }),
      { sql: sql as never, recordFire, autoPause },
    );

    expect(res).toMatchObject({ handled: true, class: 'auth' });
    // The regression this pins: no re-arm delay was computed, and no rearm UPDATE was issued.
    expect(res.rearmedMs).toBeUndefined();
    expect(sql.calls.filter((c) => c.kind === 'update')).toHaveLength(0);
    expect(autoPause).toHaveBeenCalledWith(
      sql,
      'loop_su_owner',
      expect.stringContaining('auth wall'),
      'loop-turn-outcome',
    );
    // Pausing must remove the futile respawn WITHOUT silencing the operator-facing alert.
    expect(captureImprovement).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'bug', title: expect.stringContaining('LOOP WEDGED') }),
    );
    const body = vi.mocked(captureImprovement).mock.calls.at(-1)?.[0]?.body as string;
    expect(body).toContain('PAUSED by an auth-wall terminal guard');
    expect(body).toContain('NOT re-firing on a cadence');
    expect(body).toContain('new credentials');
    expect(body).not.toContain('every wake risks re-firing');
    expect(body).not.toContain('429-aware re-arm');
  });

  // NEGATIVE CONTROL for the test above, kept permanently in-file. Without it, a fix that simply
  // paused EVERY death would satisfy the auth assertions and look correct. This is the same
  // clean-exit wedge shape, differing only in the stdout text, and it must still RE-ARM.
  it('control: a usage_limit wedge (same clean-exit shape) still re-arms and is NOT paused', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(claimWatchdogFire).mockResolvedValue(true);
    mockResolvedTyped(vi.mocked(captureImprovement), CAPTURE_OK);
    vi.mocked(requestOverwatchWake).mockResolvedValue({ wired: true, result: { fired: true } });
    const sql = fakeSql({ ref: refRow, rearmRows: [{ id: 'loop_su_owner' }] });
    const recordFire = vi.fn(async () => {});
    const autoPause = vi.fn(async () => {});
    const res = await handleLoopResumeTurnExit(
      loopDelivery(),
      deathRaw({
        exitCode: 0,
        signal: null,
        stdoutTail: "You've hit your session limit · resets 5:40am (America/New_York)",
        stderrTail: '',
      }),
      { sql: sql as never, recordFire, autoPause },
    );

    expect(res).toMatchObject({ handled: true, class: 'usage_limit' });
    expect(autoPause).not.toHaveBeenCalled();
    expect(res.rearmedMs).toBeGreaterThan(0);
    const transitions = sql.calls.filter((c) => c.text.includes('INSERT INTO harness_shared.routine_loop_transitions'));
    expect(transitions).toHaveLength(1);
    const detail = transitions[0].values[10];
    if (typeof detail !== 'string') throw new Error('missing usage-reset provenance');
    expect(JSON.parse(detail)).toMatchObject({
      class: 'usage_limit', resetAt: expect.any(Number), resetPrecision: expect.any(String),
    });
  });
});

describe('handleLoopResumeTurnExit — EI-13818 wedge-death alert (item c)', () => {
  const wedgeRaw = (over: Partial<ResumeTurnExitRaw> = {}): ResumeTurnExitRaw => ({
    exitCode: 0,
    signal: null,
    stdoutTail: "You've hit your session limit · resets 5:40am (America/New_York)",
    stderrTail: '',
    ...over,
  });

  beforeEach(() => {
    vi.mocked(claimWatchdogFire).mockReset().mockResolvedValue(true);
    mockResolvedTyped(vi.mocked(captureImprovement).mockReset(), CAPTURE_OK);
    vi.mocked(requestOverwatchWake).mockReset().mockResolvedValue({ wired: true, result: { fired: true } });
  });

  it('a wedged (usage_limit) clean-exit death claims the watchdog debounce + files + wakes overwatch', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({ ref: refRow, rearmRows: [{ id: 'loop_su_owner' }] });
    const recordFire = vi.fn(async () => {});
    const res = await handleLoopResumeTurnExit(loopDelivery(), wedgeRaw(), { sql: sql as never, recordFire });

    expect(res.handled).toBe(true);
    expect(res.class).toBe('usage_limit');
    expect(claimWatchdogFire).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'ws-papercusp',
        installSlug: 'papercusp::loop_su_owner',
        source: 'loop-wedge-death',
        windowHours: 6,
      }),
    );
    expect(captureImprovement).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'bug', severity: 'major', title: expect.stringContaining('LOOP WEDGED') }),
    );
    expect(requestOverwatchWake).toHaveBeenCalledTimes(1);
  });

  it('a debounced claim (already fired within 6h) skips capture + overwatch wake entirely', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(claimWatchdogFire).mockResolvedValue(false);
    const sql = fakeSql({ ref: refRow, rearmRows: [{ id: 'loop_su_owner' }] });
    const recordFire = vi.fn(async () => {});
    const res = await handleLoopResumeTurnExit(loopDelivery(), wedgeRaw(), { sql: sql as never, recordFire });

    expect(res.handled).toBe(true); // the circuit-feed + re-arm still happen regardless
    expect(captureImprovement).not.toHaveBeenCalled();
    expect(requestOverwatchWake).not.toHaveBeenCalled();
  });

  it('a non-surfaceToUser death (rate_limited — auto-absorbed, not surfaced) never triggers the wedge alert', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({ ref: refRow, rearmRows: [{ id: 'loop_su_owner' }] });
    const recordFire = vi.fn(async () => {});
    const res = await handleLoopResumeTurnExit(loopDelivery(), deathRaw(), { sql: sql as never, recordFire }); // deathRaw = 429/rate_limited, not surfaceToUser

    expect(res.handled).toBe(true);
    expect(claimWatchdogFire).not.toHaveBeenCalled();
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('an agent_crash on a 10-minute loop cadence is not misreported as chronic provider backoff', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const longCadenceRef = { ...refRow, reschedule_interval_sec: 600 };
    const sql = fakeSql({ ref: longCadenceRef, rearmRows: [{ id: 'loop_su_owner' }] });
    const recordFire = vi.fn(async () => {});
    const crashRaw = deathRaw({
      stdoutTail: '',
      stderrTail: 'Permission deny rule "ToolSearch" matches no known tool — check for typos.',
    });
    const res = await handleLoopResumeTurnExit(loopDelivery(), crashRaw, { sql: sql as never, recordFire });

    expect(res.class).toBe('agent_crash');
    expect(res.rearmedMs).toBe(600_000);
    expect(claimWatchdogFire).not.toHaveBeenCalled();
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('a rate-limit delay equal to a 10-minute loop cadence is not chronic backoff', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const longCadenceRef = { ...refRow, reschedule_interval_sec: 600 };
    const sql = fakeSql({ ref: longCadenceRef, rearmRows: [{ id: 'loop_su_owner' }] });
    const recordFire = vi.fn(async () => {});
    const res = await handleLoopResumeTurnExit(loopDelivery(), deathRaw(), { sql: sql as never, recordFire });

    expect(res.class).toBe('rate_limited');
    expect(res.rearmedMs).toBe(600_000);
    expect(claimWatchdogFire).not.toHaveBeenCalled();
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  // EI-19381528967421062: this is the item's OWN reported gap. surfaceToUser alone missed a
  // sustained rate_limited streak (dead egress proxy) whose computed re-arm delay ran
  // ~50-100 minutes with zero alert. A short/ordinary rate_limited death (the test above,
  // computed delay = the 2min cadence) must stay silent; ONE whose additional delay clears the
  // chronic floor must alert despite the class being non-surfaceToUser.
  it('a CHRONIC rate_limited death (provider-added delay >= the chronic floor) DOES trigger the wedge alert', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({ ref: refRow, rearmRows: [{ id: 'loop_su_owner' }] });
    const recordFire = vi.fn(async () => {});
    // Parses to retryAfterMs = 900_000 (15min) via classifySubprocessResult's "retry after Ns"
    // pattern — well past the interval floor (120s) AND the 10min chronic-alert floor.
    const chronicRaw = deathRaw({
      stdoutTail: 'API Error: 429 Too Many Requests · Rate limited · retry after 900 seconds',
    });
    const res = await handleLoopResumeTurnExit(loopDelivery(), chronicRaw, { sql: sql as never, recordFire });

    expect(res.handled).toBe(true);
    expect(res.class).toBe('rate_limited');
    expect(res.rearmedMs).toBe(900_000);
    expect(claimWatchdogFire).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'loop-wedge-death', windowHours: 6 }),
    );
    expect(captureImprovement).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.stringContaining('chronic-backoff trigger') }),
    );
    expect(requestOverwatchWake).toHaveBeenCalledTimes(1);
  });

  /**
   * WI-41683. The alert body used to open with "every wake risks re-firing into the same
   * wall" for EVERY class — including the two that PAUSE the loop, whose own bracket note
   * two sentences later says it was stopped. A reader of a paused-class item therefore went
   * hunting for a wake-loop that no longer existed. These two tests are a contrastive pair:
   * the paused class must not carry the re-fire claim, and the re-arming class still must.
   */
  it('a PAUSED-class alert states the loop is not re-firing, and gives the close criterion', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(claimWatchdogFire).mockResolvedValue(true);
    mockResolvedTyped(vi.mocked(captureImprovement).mockClear(), CAPTURE_OK);
    vi.mocked(requestOverwatchWake).mockResolvedValue({ wired: true, result: { fired: true } });
    const sql = fakeSql({ ref: refRow, rearmRows: [{ id: 'loop_su_owner' }] });

    await handleLoopResumeTurnExit(
      loopDelivery(),
      deathRaw({ stdoutTail: 'Prompt is too long: 210000 tokens > 200000 maximum' }),
      { sql: sql as never, recordFire: vi.fn(async () => {}), autoPause: vi.fn(async () => {}) },
    );

    const body = vi.mocked(captureImprovement).mock.calls.at(-1)?.[0]?.body as string;
    expect(body).toContain('PAUSED by a terminal guard');
    expect(body).toContain('close the item as already-resolved');
    // The false claim that sent readers looking for a live wake-loop.
    expect(body).not.toContain('every wake risks re-firing');
    // The bracket note the existing assertions rely on must survive the rewrite.
    expect(body).toContain('context-overflow terminal guard');
  });

  it('a RE-ARMING-class alert still carries the re-fire warning', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockResolvedTyped(vi.mocked(captureImprovement).mockClear(), CAPTURE_OK);
    const sql = fakeSql({ ref: refRow, rearmRows: [{ id: 'loop_su_owner' }] });

    await handleLoopResumeTurnExit(
      loopDelivery(),
      deathRaw({
        stdoutTail: 'API Error: 429 Too Many Requests · Rate limited · retry after 900 seconds',
      }),
      { sql: sql as never, recordFire: vi.fn(async () => {}) },
    );

    const body = vi.mocked(captureImprovement).mock.calls.at(-1)?.[0]?.body as string;
    expect(body).toContain('every wake risks re-firing');
    expect(body).not.toContain('PAUSED by a terminal guard');
  });

  it('a malformed Authorization alert points to credential construction, not waiting out a cap', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockResolvedTyped(vi.mocked(captureImprovement).mockClear(), CAPTURE_OK);
    const sql = fakeSql({ ref: refRow, rearmRows: [{ id: 'loop_su_owner' }] });
    const raw =
      `codex_api::endpoint::responses_websocket: failed to connect to websocket: UTF-8 encoding error: ` +
      `failed to convert header to a str for header name 'authorization'\n` +
      `with value: "Bearer abcDEF123456 fired — WI-40086"`;

    await handleLoopResumeTurnExit(
      loopDelivery(),
      deathRaw({ stdoutTail: raw }),
      { sql: sql as never, recordFire: vi.fn(async () => {}) },
    );

    const body = vi.mocked(captureImprovement).mock.calls.at(-1)?.[0]?.body as string;
    expect(body).toContain('malformed Authorization header');
    expect(body).toContain('credential-construction error');
    expect(body).toContain('not a provider usage cap');
    expect(body).toContain('do not wait for a reset');
    expect(body).toContain('malformed-authorization terminal guard');
    expect(body).not.toContain('every wake risks re-firing');
    expect(body).not.toContain('waiting out the cap');
    expect(body).not.toContain('abcDEF123456');
  });

  it('a rate_limited death JUST UNDER the chronic floor still stays silent (no spam on ordinary longer waits)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({ ref: refRow, rearmRows: [{ id: 'loop_su_owner' }] });
    const recordFire = vi.fn(async () => {});
    // 9min — under the 10min chronic floor.
    const almostChronicRaw = deathRaw({
      stdoutTail: 'API Error: 429 Too Many Requests · Rate limited · retry after 540 seconds',
    });
    const res = await handleLoopResumeTurnExit(loopDelivery(), almostChronicRaw, { sql: sql as never, recordFire });

    expect(res.handled).toBe(true);
    expect(res.rearmedMs).toBe(540_000);
    expect(claimWatchdogFire).not.toHaveBeenCalled();
    expect(captureImprovement).not.toHaveBeenCalled();
  });

  it('a throwing claimWatchdogFire fails soft — the outcome contract is undisturbed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(claimWatchdogFire).mockRejectedValue(new Error('pg down'));
    const sql = fakeSql({ ref: refRow, rearmRows: [{ id: 'loop_su_owner' }] });
    const recordFire = vi.fn(async () => {});
    const res = await handleLoopResumeTurnExit(loopDelivery(), wedgeRaw(), { sql: sql as never, recordFire });

    expect(res.handled).toBe(true);
    expect(res.class).toBe('usage_limit');
    expect(captureImprovement).not.toHaveBeenCalled();
  });
});

describe('turn-settle wall nag (compaction-continuity-hardening P-006)', () => {
  const cleanExitWithAsk = (finalText: string): ResumeTurnExitRaw =>
    deathRaw({ exitCode: 0, signal: null, stdoutTail: finalText });

  it('a clean exit ending on an owner-ask with ZERO wall rows stashes the nag', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({ ref: refRow });
    const stashWallNag = vi.fn(async () => true);
    const res = await handleLoopResumeTurnExit(
      loopDelivery(),
      cleanExitWithAsk('shipped the fix.\nThe teardown is pending owner approval.'),
      {
        sql: sql as never,
        getLoopCarryNote: (async () => '## Next action\ngo') as never, // note, but NO walls rows
        stashWallNag: stashWallNag as never,
        now: 42,
      },
    );
    expect(res).toMatchObject({ handled: false, routineId: 'loop_su_owner', nagged: true });
    expect(stashWallNag).toHaveBeenCalledWith(
      { harness: 'papercusp', ownerId: 'su-owner' },
      'The teardown is pending owner approval.',
      42,
    );
  });

  it('an owner-ask already covered by a wall row stays silent', async () => {
    const sql = fakeSql({ ref: refRow });
    const stashWallNag = vi.fn(async () => true);
    const res = await handleLoopResumeTurnExit(
      loopDelivery(),
      cleanExitWithAsk('still awaiting owner OK on the PIDs.'),
      {
        sql: sql as never,
        getLoopCarryNote: (async () => '## Walls\n- zombie PIDs await owner OK — re-check: ps -p 95902') as never,
        stashWallNag: stashWallNag as never,
      },
    );
    expect(res).toMatchObject({ handled: false, routineId: 'loop_su_owner' });
    expect(res.nagged).toBeUndefined();
    expect(stashWallNag).not.toHaveBeenCalled();
  });

  it('a clean exit with NO owner-ask never touches the DB (pure detect gates the read)', async () => {
    const sql = fakeSql({ ref: refRow });
    const res = await handleLoopResumeTurnExit(loopDelivery(), cleanExitWithAsk('all green; ending the turn.'), {
      sql: sql as never,
      stashWallNag: vi.fn(async () => true) as never,
    });
    expect(res).toMatchObject({ handled: false, routineId: 'loop_su_owner' });
    expect(sql.calls).toHaveLength(0);
  });

  it('a throwing carry-note read fails soft — the outcome contract is undisturbed', async () => {
    const sql = fakeSql({ ref: refRow });
    const res = await handleLoopResumeTurnExit(
      loopDelivery(),
      cleanExitWithAsk('blocked on the owner for credentials.'),
      {
        sql: sql as never,
        getLoopCarryNote: (async () => {
          throw new Error('pg down');
        }) as never,
        stashWallNag: vi.fn(async () => true) as never,
      },
    );
    expect(res).toMatchObject({ handled: false, routineId: 'loop_su_owner' });
    expect(res.nagged).toBeUndefined();
  });
});
