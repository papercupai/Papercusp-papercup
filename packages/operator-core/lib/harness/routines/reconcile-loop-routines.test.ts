/**
 * Unit regression test for EI-2549 — the fleet-wide loop re-arm wedge.
 *
 * ROOT CAUSE: the operator's pooled `getOrgPg()` connection runs `prepare: false`, so
 * postgres-js returns `timestamptz` columns as STRINGS, not `Date`s. The original code called
 * `row.last_fired_at.getTime()`, which threw `getTime is not a function` on the FIRST row of
 * every reconcile pass — silently aborting the whole pass (caught by reconcileAndGovern's
 * best-effort try) so EVERY loop parked at infinity forever after one fire. The integration
 * tests used a direct, type-parsing connection (Date columns) and so never reproduced it — a
 * real test gap this closes by driving reconcileLoopRoutines with STRING-typed rows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import { parseUsageReset, MODEL_CAPACITY_RETRY_AFTER_MS } from '@papercusp/papercusp-shared/agent';
import {
  reconcileLoopRoutines as reconcileLoopRoutinesImpl,
  classifyLoopLifecycleTurn,
  defaultEscalateLifecycleDeath,
  defaultEscalateNoTurnWedge,
  noTurnWedgeEscalateAfter,
  reconcileLoopNoTurnWedgeEscalations,
  reconcileLoopLifecycleDeathEscalations,
  LOOP_NO_TURN_WEDGE_SIGNATURE_PREFIX,
  LOOP_LIFECYCLE_DEATH_SIGNATURE_PREFIX,
} from './reconcile-loop-routines';

// EI-18668025239634541 recurrence guard: mocked so the test below can assert on the
// `meta.subjectSignature` (conditionKey) `defaultEscalateLifecycleDeath` passes through —
// the exact field that was missing and caused every provider-kill occurrence to leak a
// fresh permanently-open escalation instead of coalescing onto one row.
vi.mock('../../agent-tools/coordination/escalations', () => ({
  openEscalation: vi.fn(async () => undefined),
}));
import { openEscalation } from '../../agent-tools/coordination/escalations';

/** Never-breach terminal-guard stub for tests that only care about the pre-existing
 *  stuck-backstop re-arm behavior (WI-1399 added a guard check ahead of every stuck-backstop
 *  re-arm — these tests pin it to "no breach" so the original re-arm assertions still hold). */
const NEVER_BREACH_GUARD = vi.fn(async () => ({ breach: false }) as { breach: boolean; reason?: string });

/** HERMETIC module-level wrapper. Legacy fakeSql seams do not implement sql.unsafe/sql.array,
 *  so evidence defaults to unavailable; WI-41228 tests inject explicit counts. */
const reconcileLoopRoutines = (o: NonNullable<Parameters<typeof reconcileLoopRoutinesImpl>[0]>) =>
  reconcileLoopRoutinesImpl({ countAgentToolCallsInWindow: async () => null, ...o });

/** HERMETIC wrapper — do NOT call reconcileLoopRoutinesImpl bare. fakeSql intercepts the SQL,
 *  but the DEFAULT recordFire/readFireState bind getOrgPg() — the LIVE dev database — so a
 *  bare call leaks fire-state writes into dev PG (the EI-7006 time-bomb flake, 2026-07-03).
 *  Explicit injections in `o` still win (spread order). */
const reconcile = (o: NonNullable<Parameters<typeof reconcileLoopRoutines>[0]>) =>
  reconcileLoopRoutines({ recordFire: async () => {}, readFireState: async () => null, ...o });
/** No prior error streak, by default, for tests that don't care about the stuck-fire count. */
const NO_PRIOR_ERRORS = vi.fn(async () => null);

/** A minimal tagged-template stub mimicking postgres-js: the SELECT returns the seeded loop
 *  rows; any UPDATE records its params + reports one matched row. */
function fakeSql(rows: Record<string, unknown>[], updates: unknown[][]): Sql {
  return ((strings: TemplateStringsArray, ...vals: unknown[]) => {
    const q = strings.join(' ? ');
    // Anchor on the statement HEAD: the reconcile SELECT legitimately contains the
    // substring "update" (carry_notes.updated_ts), so a bare /UPDATE/i misclassifies it.
    if (/^\s*UPDATE/i.test(q)) {
      updates.push(vals);
      return Promise.resolve([{ id: 'rt-1' }]);
    }
    return Promise.resolve(rows);
  }) as unknown as Sql;
}

describe('reconcileLoopRoutines — expected execution recovery accounting', () => {
  it.each([true, false])('reports only a recovery that rearmed the durable schedule: %s', async rearmed => {
    const nowMs = 1_792_000_000_000;
    const updates: unknown[][] = [];
    const sql = fakeSql([{ id: 'rt-recovery', target_owner_id: 'su-recovery', interval_sec: 60,
      parked: true, install_slug: 'papercusp', name: 'loop-su-recovery',
      routine_workspace_id: 'ws-test', last_fired_at: new Date(nowMs - 60_000).toISOString() }], updates);
    const recoverExpectedExecution = vi.fn(async () => ({ handled: true, rearmed, state: {
      status: 'recovering' as const, reason: 'native-turn-failed', attempts: 1, probes: 0,
      observedAt: nowMs, nextProbeAt: nowMs + 30_000, generation: 'host:1:child', lastAttemptAt: nowMs,
    } }));
    const result = await reconcile({ sql, nowMs, recoverExpectedExecution });
    expect(recoverExpectedExecution).toHaveBeenCalledWith({ sql, routineId: 'rt-recovery', ownerId: 'su-recovery', nowMs });
    expect(result.rearmed).toBe(rearmed ? 1 : 0);
    expect(result.loops).toEqual(rearmed ? [{ id: 'rt-recovery', targetOwnerId: 'su-recovery',
      completedAt: nowMs, nextFireAt: nowMs + 30_000, via: 'execution-recovery' }] : []);
    expect(updates).toHaveLength(0);
  });
});

describe('reconcileLoopRoutines — exact fire identity query contract', () => {
  it('requires typed routineId+wakeCount activity detail before pairing a loop turn', async () => {
    const statements: string[] = [];
    const sql = ((strings: TemplateStringsArray) => {
      statements.push(strings.join(' ? '));
      return Promise.resolve([
        {
          id: 'rt-identity', target_owner_id: 'su-identity', interval_sec: 60, parked: false,
          is_cron: false, install_slug: 'papercusp', name: 'loop-su-identity',
          routine_workspace_id: 'ws-test', last_fired_at: null,
          fire_state_last_fired_at: null, fire_state_last_withheld_at: null,
          last_wake_at: null, last_wake_created_at: null, last_wake_status: null,
          last_wake_channel: null, last_loop_turn_at: null, lifecycle_completed_at: null,
          lifecycle_started_at: null, turn_journal_completed_at: null,
          loop_turn_started_at: null, carry: null, armed_at: null, note_updated_ts: null,
          presence_last_active_at: null, last_assistant_text_after_fire: null,
          turns_ingest_watermark: null, payload_template: null, monitor_delta_at: null,
        },
      ]);
    }) as unknown as Sql;
    await reconcile({ sql, nowMs: Date.now(), checkUnreachableTerminalGuard: NEVER_BREACH_GUARD });
    expect(statements[0]).toContain("detail->'loopFire'->>'routineId'");
    expect(statements[0]).toContain("detail->'loopFire'->>'wakeCount'");
  });
});

describe('reconcileLoopRoutines — string-typed timestamptz columns (pooled prepare:false connection, EI-2549)', () => {
  const T0 = 1_782_000_000_000;
  // The exact shape postgres-js yields on a prepare:false connection: a raw PG timestamp string.
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  it('re-arms a parked loop whose timestamptz columns arrive as STRINGS (the bug repro)', async () => {
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [
        {
          id: 'rt-1',
          target_owner_id: 'su-test',
          interval_sec: 60,
          parked: true,
          install_slug: 'papercusp',
          name: 'loop-su-test',
          routine_workspace_id: 'ws-papercusp',
          last_fired_at: pgString(T0), // STRING, not Date — `.getTime()` would throw here
          lifecycle_completed_at: pgString(T0 + 5_000), // STRING — the PRIMARY settle signal
          presence_last_active_at: null,
        },
      ],
      updates,
    );
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({ sql, nowMs: T0 + 10_000, recordFire });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ id: 'rt-1', via: 'lifecycle' });
    expect(res.loops[0].nextFireAt).toBe(T0 + 5_000 + 60_000); // completed + interval, from the string ts
    expect(updates).toHaveLength(1); // the re-arm UPDATE actually executed (pass not aborted)
    // P0b: a COMPLETED turn feeds the circuit with 'ok' (resets the failure streak).
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-test', expect.stringContaining('lifecycle'), 'ok');
  });

  it('string presence-quiescence fallback also re-arms (no lifecycle marker)', async () => {
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [
        {
          id: 'rt-1',
          target_owner_id: 'su-test',
          interval_sec: 60,
          parked: true,
          install_slug: 'papercusp',
          name: 'loop-su-test',
          routine_workspace_id: 'ws-papercusp',
          last_fired_at: pgString(T0),
          lifecycle_completed_at: null,
          presence_last_active_at: pgString(T0 + 4_000), // STRING; quiet ≥60s by nowMs below
        },
      ],
      updates,
    );
    const res = await reconcile({ sql, nowMs: T0 + 70_000 });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('presence-quiescence');
  });
});

describe('reconcileLoopRoutines — provider deadline provenance and strict success rebase', () => {
  const T0 = 1_782_000_000_000;
  const deadlineMs = T0 + 4 * 24 * 60 * 60_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  const providerHeldRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'rt-provider-held',
    target_owner_id: 'su-provider-held',
    interval_sec: 60,
    parked: false,
    is_cron: false,
    install_slug: 'papercusp',
    name: 'loop-su-provider-held',
    routine_workspace_id: 'ws-papercusp',
    last_fired_at: pgString(T0),
    next_fire_at: pgString(deadlineMs),
    provider_retry_next_fire_at: pgString(deadlineMs),
    last_wake_status: 'delivered',
    last_wake_at: pgString(T0 + 4_000),
    last_wake_created_at: pgString(T0 + 3_000),
    last_wake_channel: 'resume-headless',
    last_loop_turn_at: pgString(T0 + 10_000),
    loop_turn_started_at: pgString(T0 + 5_000),
    lifecycle_completed_at: null,
    turn_journal_completed_at: null,
    lifecycle_started_at: null,
    carry: 'warm',
    armed_at: null,
    note_updated_ts: null,
    presence_last_active_at: null,
    last_assistant_text_after_fire: 'Completed the task successfully.',
    payload_template: { mode: 'work' },
    ...overrides,
  });

  const run = async (row: Record<string, unknown>) => {
    const statements: { text: string; values: unknown[] }[] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join(' ? ');
      if (/^\s*UPDATE/i.test(text)) {
        statements.push({ text, values });
        return Promise.resolve([{ id: 'rt-provider-held' }]);
      }
      return Promise.resolve([row]);
    }) as unknown as Sql;
    const res = await reconcile({
      sql,
      nowMs: T0 + 15_000,
      recordFire: vi.fn(async () => {}),
      readFireState: NO_PRIOR_ERRORS,
      recoverExpectedExecution: vi.fn(async () => ({ handled: false as const })),
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    return { res, statements };
  };

  it('rebases the exact provider deadline after a strict loop-origin successful turn', async () => {
    const { res, statements } = await run(providerHeldRow());
    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ via: 'loop-turn', nextFireAt: T0 + 70_000 });
    expect(statements).toHaveLength(1);
    expect(statements[0].text).toContain("metadata->'providerRetrySchedule'->>'nextFireAt'");
    expect(statements[0].text).toContain("metadata = COALESCE(metadata, '{}'::jsonb) - 'providerRetrySchedule'");
    expect(statements[0].values).toContain(new Date(deadlineMs).toISOString());
  });

  it('does not rebase a provider deadline from owner-wide lifecycle evidence alone', async () => {
    const { res, statements } = await run(providerHeldRow({
      last_wake_status: null,
      last_wake_at: null,
      last_loop_turn_at: null,
      lifecycle_completed_at: pgString(T0 + 10_000),
    }));
    expect(res.rearmed).toBe(0);
    expect(statements).toHaveLength(0);
  });

  it('does not rebase when the marker no longer matches the installed next_fire_at', async () => {
    const { res, statements } = await run(providerHeldRow({
      next_fire_at: pgString(deadlineMs + 1_000),
    }));
    expect(res.rearmed).toBe(0);
    expect(statements).toHaveLength(0);
  });
});

describe('reconcileLoopRoutines — stale pure-loop parked snapshot cannot overwrite a re-arm (EI-21122026530854360)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  it('skips the stale completion UPDATE after loop:arm has installed a fresh finite schedule', async () => {
    const statements: string[] = [];
    // The SELECT snapshot says the pure loop is parked, but loop:arm won the race afterward
    // and the live row now has a fresh finite next_fire_at. An unguarded LEAST UPDATE would
    // match this state and regress that schedule to the stale completion + interval value.
    const sql = ((strings: TemplateStringsArray, ..._vals: unknown[]) => {
      const query = strings.join(' ? ');
      if (/^\s*UPDATE/i.test(query)) {
        statements.push(query);
        const hasPureLoopParkGuard =
          query.includes("jsonb_exists(trigger_config, 'cron')") &&
          query.includes("next_fire_at = 'infinity'::timestamptz");
        // Simulate the live row's WHERE evaluation: it is finite now, so the fixed guard
        // yields zero rows. The pre-fix statement would report one matched row here.
        return Promise.resolve(hasPureLoopParkGuard ? [] : [{ id: 'rt-race' }]);
      }
      return Promise.resolve([
        {
          id: 'rt-race',
          target_owner_id: 'su-race',
          interval_sec: 60,
          parked: true,
          is_cron: false,
          install_slug: 'papercusp',
          name: 'loop-su-race',
          routine_workspace_id: 'ws-papercusp',
          last_fired_at: pgString(T0),
          lifecycle_completed_at: pgString(T0 + 5_000),
          presence_last_active_at: null,
        },
      ]);
    }) as unknown as Sql;

    const res = await reconcile({
      sql,
      nowMs: T0 + 10_000,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });

    expect(res.rearmed).toBe(0);
    expect(res.loops).toEqual([]);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("jsonb_exists(trigger_config, 'cron')");
    expect(statements[0]).toContain("next_fire_at = 'infinity'::timestamptz");
  });
});

describe('reconcileLoopRoutines — expired completion re-arm is normalized to a future fire (EI-22346847925961653)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  it('does not advertise a completion-relative next fire that is already past when reconcile is delayed', async () => {
    const updates: unknown[][] = [];
    const nowMs = T0 + 31 * 60_000;
    const intervalMs = 60_000;
    const sql = fakeSql(
      [
        {
          id: 'rt-expired-rearm',
          target_owner_id: 'su-expired-rearm',
          interval_sec: 60,
          parked: true,
          is_cron: false,
          install_slug: 'papercusp',
          name: 'loop-su-expired-rearm',
          routine_workspace_id: 'ws-papercusp',
          last_fired_at: pgString(T0),
          lifecycle_completed_at: pgString(T0 + 5_000),
          turn_journal_completed_at: null,
          lifecycle_started_at: null,
          presence_last_active_at: null,
          last_assistant_text_after_fire: null,
          turns_ingest_watermark: null,
        },
      ],
      updates,
    );

    const res = await reconcile({
      sql,
      nowMs,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });

    const expectedNextFireAt = nowMs + intervalMs;
    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({
      id: 'rt-expired-rearm',
      via: 'lifecycle',
      nextFireAt: expectedNextFireAt,
    });
    // The SQL bind and the returned diagnostic must agree on the normalized future timestamp.
    expect(updates[0]?.[0]).toBe(new Date(expectedNextFireAt).toISOString());
    expect(res.loops[0]!.nextFireAt).toBeGreaterThan(nowMs);
  });
});

describe('reconcileLoopRoutines — cold settle ladder (su-cold-auto 2026-07-03)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');
  const coldRow = (over: Record<string, unknown>) => ({
    id: 'rt-1',
    target_owner_id: 'su-test',
    interval_sec: 60,
    parked: true,
    install_slug: 'papercusp',
    name: 'loop-su-test',
    routine_workspace_id: 'ws-papercusp',
    last_fired_at: pgString(T0),
    presence_last_active_at: null,
    carry: 'cold',
    note_updated_ts: null,
    ...over,
  });
  const coldDeliveredRow = (over: Record<string, unknown> = {}) =>
    coldRow({
      is_cron: false,
      fire_state_last_fired_at: null,
      fire_state_last_withheld_at: null,
      last_wake_at: pgString(T0 + 120_000),
      last_wake_created_at: pgString(T0 + 120_000),
      last_wake_status: 'delivered',
      last_wake_channel: 'psu-socket-inject',
      last_loop_turn_at: null,
      lifecycle_completed_at: null,
      lifecycle_started_at: pgString(T0 + 121_000),
      turn_journal_completed_at: null,
      loop_turn_started_at: pgString(T0 + 125_000),
      ...over,
    });

  it('releases a never-fired cold loop only after a carry-note newer than the arm settles it', async () => {
    const updates: unknown[][] = [];
    const armedAt = T0 + 1_000;
    const noteAt = T0 + 5_000; // the long arming turn checkpoints after the nominal first-fire time
    const sql = fakeSql(
      [
        coldRow({
          last_fired_at: null,
          armed_at: pgString(armedAt),
          note_updated_ts: String(noteAt),
        }),
      ],
      updates,
    );

    const res = await reconcile({ sql, nowMs: T0 + 10_000 });

    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({
      id: 'rt-1',
      completedAt: noteAt,
      nextFireAt: noteAt + 60_000,
      via: 'initial-cold-note-refresh',
    });
    expect(updates).toHaveLength(1);
  });

  it("the reset boundary (ended→started back-to-back at delivery) is NOT a settle — the 'ended' is the DYING session, not the woken turn finishing", async () => {
    // Live repro (fire #4972 → overlap #4979): cold delivery at T0+1s restarts the session —
    // old process emits 'ended' (+1000ms), new process 'started' (+1250ms). The cold turn is
    // STILL RUNNING; re-arming off that 'ended' fires the next wake mid-turn.
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [
        coldRow({
          lifecycle_completed_at: pgString(T0 + 1_000),
          lifecycle_started_at: pgString(T0 + 1_250), // newest marker is 'started' → session RUNNING
        }),
      ],
      updates,
    );
    const res = await reconcile({ sql, nowMs: T0 + 10_000 });
    expect(res.rearmed).toBe(0);
    expect(updates).toHaveLength(0); // no re-arm UPDATE — the loop stays parked until the cold turn settles
  });

  it("the cold turn's OWN Stop-hook 'ended' (newer than the boundary 'started') IS the settle", async () => {
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [
        coldRow({
          lifecycle_completed_at: pgString(T0 + 90_000), // the cold turn finished at +90s
          lifecycle_started_at: pgString(T0 + 1_250), // the boundary 'started' is older
        }),
      ],
      updates,
    );
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({ sql, nowMs: T0 + 95_000, recordFire });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('lifecycle');
    expect(res.loops[0].nextFireAt).toBe(T0 + 90_000 + 60_000); // completed + interval, off the REAL settle
  });

  it("a warm loop (no carry marker) with a post-fire 'ended' settles exactly as before", async () => {
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [
        coldRow({
          carry: null, // WARM loop
          lifecycle_completed_at: pgString(T0 + 5_000),
          lifecycle_started_at: null, // warm: 'started' fired at boot, outside the > last_fired window
        }),
      ],
      updates,
    );
    const res = await reconcile({ sql, nowMs: T0 + 10_000 });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('lifecycle');
  });

  it('the carry-note REFRESH is a cold settle (the protocol\'s own completion receipt), even with no turn-ended marker', async () => {
    // The iteration checkpointed (loop:checkpoint before turn end) but its Stop report was
    // dropped — the note refresh is authoritative evidence the iteration ran.
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [
        coldRow({
          lifecycle_completed_at: pgString(T0 + 1_000),
          lifecycle_started_at: pgString(T0 + 1_250), // boundary only — no turn-ended yet
          note_updated_ts: String(T0 + 45_000), // bigint arrives as a STRING over the wire
        }),
      ],
      updates,
    );
    const res = await reconcile({ sql, nowMs: T0 + 50_000 });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('note-refresh');
    expect(res.loops[0].nextFireAt).toBe(T0 + 45_000 + 60_000);
  });

  it('bare presence-quiescence is NOT a cold settle — a recycled, booted-but-idle session whose carry inject was dropped must NOT re-fire (the stale-note treadmill, wakes #5033→#5036)', async () => {
    // Live repro: the wc8 RECYCLE killed the child (ended, no started yet / boot idle),
    // presence advanced at boot then went quiet ≥60s with the iteration NEVER run. The old
    // quiescence fallback read that as settled and fired wc9 91s later into a booting host.
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [
        coldRow({
          lifecycle_completed_at: pgString(T0 + 1_000), // the recycle kill's 'ended'
          lifecycle_started_at: null, // fresh child hasn't emitted 'started' (or boot idle)
          presence_last_active_at: pgString(T0 + 5_000), // boot activity, then quiet
          note_updated_ts: String(T0 - 300_000), // note is STALE (pre-fire) — iteration never ran
        }),
      ],
      updates,
    );
    const res = await reconcile({ sql, nowMs: T0 + 100_000 }); // 95s quiet — old code re-fired here
    expect(res.rearmed).toBe(0);
    expect(updates).toHaveLength(0); // parked until real evidence (or the stuck-park backstop retries)
  });

  it('a warm loop still recovers via presence-quiescence (the fallback is unchanged for warm)', async () => {
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [
        coldRow({
          carry: null, // WARM loop
          lifecycle_completed_at: null,
          lifecycle_started_at: null,
          presence_last_active_at: pgString(T0 + 30_000), // worked until +30s, then quiet
        }),
      ],
      updates,
    );
    const res = await reconcile({ sql, nowMs: T0 + 100_000 }); // 70s quiet
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('presence-quiescence');
  });

  it('holds a cold post-dispatch loop turn through the backstop boundary, even after an early carry-note refresh', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql(
        [
          coldDeliveredRow({
            // The turn started for this delivery, but its only journal row predates that start.
            // A carry-note can be written before the long-running turn actually exits.
            turn_journal_completed_at: pgString(T0 + 124_000),
            note_updated_ts: String(T0 + 130_000),
          }),
        ],
        updates,
      ),
      // Past the fire's 30m stuck threshold, but still inside the delivery's bounded dwell.
      nowMs: T0 + 30 * 60_000 + 1_000,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });

    expect(res.rearmed).toBe(0);
    expect(res.loops).toEqual([]);
    expect(updates).toHaveLength(0);
    expect(recordFire).not.toHaveBeenCalled();
  });

  it('holds a cold suppressed-redundant delivery until the in-flight turn completes', async () => {
    const suppressed = coldDeliveredRow({
      last_wake_channel: 'suppressed-redundant',
      loop_turn_started_at: null,
      turn_journal_completed_at: null,
      note_updated_ts: null,
    });
    const waiting = await reconcile({
      sql: fakeSql([suppressed], []),
      // Backstop from the fire has elapsed; the matching wake dwell has not.
      nowMs: T0 + 30 * 60_000 + 1_000,
      recordFire: vi.fn(async () => {}),
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    expect(waiting.rearmed).toBe(0);
    expect(waiting.loops).toEqual([]);

    const recordFire = vi.fn(async () => {});
    const completed = await reconcile({
      sql: fakeSql(
        [
          {
            ...suppressed,
            turn_journal_completed_at: pgString(T0 + 150_000),
          },
        ],
        [],
      ),
      nowMs: T0 + 151_000,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    expect(completed.rearmed).toBe(1);
    expect(completed.loops[0]).toMatchObject({ via: 'turn-journal', completedAt: T0 + 150_000 });
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-test', 'loop-turn-journal', 'ok');
  });

  it('restores the existing stuck-backstop retry once the cold in-flight dwell expires', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql(
        [
          coldDeliveredRow({
            note_updated_ts: null,
          }),
        ],
        [],
      ),
      nowMs: T0 + 32 * 60_000, // 30m after the delivery, past its bounded hold
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });

    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ via: 'stuck-backstop' });
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-test', 'loop-stuck-backstop', 'error');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("no completion signal — re-armed to retry (circuit fed 'error')"),
    );
  });
});

describe('reconcileLoopRoutines — turn-journal completion signal (WI-6069)', () => {
  // Root cause: `lifecycle-report.sh` (the kind='lifecycle' 'ended' marker) is wired in
  // ~/.claude/settings.json ONLY to SessionStart/SessionEnd, never to Stop — so it only ever
  // fires at a genuine session restart, never at an ordinary turn boundary. A warm session
  // driven entirely by push wakes (events:await / a loop re-wake) never restarts, so before
  // this fix it never got a completion signal from layer 1 and (absent quiescence) silently
  // degraded to the ~30min stuck-park backstop every fire, regardless of the configured
  // interval. `session_turn_journal` (P-012's per-CLI Stop-hook journal write) DOES fire at
  // the end of every ordinary turn — this is the new layer-1.5 signal that closes the gap.
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');
  const warmRow = (over: Record<string, unknown>) => ({
    id: 'rt-1',
    target_owner_id: 'su-test',
    interval_sec: 60,
    parked: true,
    install_slug: 'papercusp',
    name: 'loop-su-test',
    routine_workspace_id: 'ws-papercusp',
    last_fired_at: pgString(T0),
    lifecycle_completed_at: null,
    lifecycle_started_at: null,
    presence_last_active_at: null,
    ...over,
  });

  it("re-arms via 'turn-journal' off a per-turn Stop-hook journal write, with NO lifecycle marker and NO presence-quiescence quiet-gap needed", async () => {
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [warmRow({ turn_journal_completed_at: pgString(T0 + 5_000) })],
      updates,
    );
    const recordFire = vi.fn(async () => {});
    // Only 6s after the fire — well short of FALLBACK_QUIET_MS (60s) — so presence-quiescence
    // could never have settled this; turn-journal is the ONLY signal that can.
    const res = await reconcile({ sql, nowMs: T0 + 6_000, recordFire });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ id: 'rt-1', via: 'turn-journal' });
    expect(res.loops[0].nextFireAt).toBe(T0 + 5_000 + 60_000); // completed + interval
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-test', expect.stringContaining('turn-journal'), 'ok');
  });

  it('the lifecycle marker still wins when BOTH signals are present (no behavior change for a session that DOES restart)', async () => {
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [
        warmRow({
          lifecycle_completed_at: pgString(T0 + 3_000),
          turn_journal_completed_at: pgString(T0 + 5_000),
        }),
      ],
      updates,
    );
    const res = await reconcile({ sql, nowMs: T0 + 10_000 });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('lifecycle');
    expect(res.loops[0].completedAt).toBe(T0 + 3_000);
  });

  it("a turn-journal settle whose turn text is a provider-kill signature is reclassified as 'error' (EI-13818 coverage extended to this via)", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}); // expected diagnostic log
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [
        warmRow({
          turn_journal_completed_at: pgString(T0 + 5_000),
          last_assistant_text_after_fire: 'You have exceeded your usage limit · resets 5:40am',
        }),
      ],
      updates,
    );
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({ sql, nowMs: T0 + 6_000, recordFire });
    expect(res.rearmed).toBe(1);
    expect(recordFire).toHaveBeenCalledWith(
      'papercusp',
      'loop-su-test',
      expect.stringContaining('loop-lifecycle-death'),
      'error',
    );
  });

  // EI-20476474709976110 — COLD layer-1.5. This REVERSES the previous decision that a cold
  // loop must ignore turn_journal_completed_at. That exclusion left leg (1) unreachable at an
  // ordinary turn boundary (lifecycle-report.sh is wired only to SessionStart/SessionEnd,
  // never to Stop), so a dropped loop:checkpoint silently degraded a cold loop to the >=30min
  // stuck-park backstop. The three tests below lock the new contract AND the safety property
  // the old exclusion was protecting.
  it("a COLD loop re-arms via 'turn-journal' when the per-turn journal write is NEWER than the post-fire 'started' boundary", async () => {
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [
        warmRow({
          carry: 'cold',
          note_updated_ts: null, // agent did NOT call loop:checkpoint — the common real case
          lifecycle_started_at: pgString(T0 + 1_000), // cold wake booted the fresh child
          turn_journal_completed_at: pgString(T0 + 5_000), // ...whose turn then finished
        }),
      ],
      updates,
    );
    const res = await reconcile({ sql, nowMs: T0 + 10_000 });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ id: 'rt-1', via: 'turn-journal' });
    expect(res.loops[0].completedAt).toBe(T0 + 5_000);
  });

  it("a COLD loop does NOT settle on a journal write OLDER than the post-fire 'started' — that row is the DYING child's last turn, not the woken iteration", async () => {
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [
        warmRow({
          carry: 'cold',
          note_updated_ts: null,
          turn_journal_completed_at: pgString(T0 + 2_000), // dying child's turn...
          lifecycle_started_at: pgString(T0 + 3_000), // ...then the recycle booted the new one
        }),
      ],
      updates,
    );
    const res = await reconcile({ sql, nowMs: T0 + 10_000 });
    expect(res.rearmed).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("a COLD loop does NOT settle on a journal write when there is NO post-fire 'started' — turn_journal is owner-wide, so without a reboot marker it may be unrelated work", async () => {
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [
        warmRow({
          carry: 'cold',
          note_updated_ts: null,
          lifecycle_started_at: null, // session never demonstrably rebooted for this fire
          turn_journal_completed_at: pgString(T0 + 5_000), // could be ANY owner turn
        }),
      ],
      updates,
    );
    const res = await reconcile({ sql, nowMs: T0 + 10_000 });
    expect(res.rearmed).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it('a COLD loop with NO journal row is still left in flight — the 2026-07-03 booted-but-idle trap stays closed', async () => {
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [
        warmRow({
          carry: 'cold',
          note_updated_ts: null,
          turn_journal_completed_at: null, // booted, carry inject deferred, NO turn ever ran
          lifecycle_started_at: pgString(T0 + 1_000),
          presence_last_active_at: pgString(T0 + 5_000), // quiet-but-alive must NOT settle cold
        }),
      ],
      updates,
    );
    const res = await reconcile({ sql, nowMs: T0 + 10_000 });
    expect(res.rearmed).toBe(0);
    expect(updates).toHaveLength(0);
  });
});

describe('reconcileLoopRoutines — strict per-fire loop-origin completion (EI-21743034835075378)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  function deliveredWarmRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'rt-loop-origin',
      target_owner_id: 'su-loop-origin',
      interval_sec: 60,
      parked: true,
      is_cron: false,
      install_slug: 'papercusp',
      name: 'loop-su-loop-origin',
      routine_workspace_id: 'ws-papercusp',
      last_fired_at: pgString(T0),
      fire_state_last_fired_at: null,
      fire_state_last_withheld_at: null,
      last_wake_at: pgString(T0 + 1_000),
      last_wake_status: 'delivered',
      last_loop_turn_at: null,
      lifecycle_completed_at: pgString(T0 + 2_000),
      turn_journal_completed_at: pgString(T0 + 3_000),
      lifecycle_started_at: null,
      carry: null,
      armed_at: null,
      note_updated_ts: null,
      presence_last_active_at: pgString(T0 + 4_000),
      last_assistant_text_after_fire: 'unrelated owner activity',
      turns_ingest_watermark: pgString(T0 + 4_000),
      payload_template: null,
      monitor_delta_at: null,
      ...overrides,
    };
  }

  it('does not let owner-wide completion signals settle a delivered wake before its loop-origin turn is observed', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql([deliveredWarmRow()], updates),
      nowMs: T0 + 30_000, // inside the 2×interval delivery/turn grace
      recordFire,
    });

    expect(res.rearmed).toBe(0);
    expect(res.loops).toEqual([]);
    expect(updates).toHaveLength(0);
    expect(recordFire).not.toHaveBeenCalled();
  });

  describe('indexed loop completion reconciliation', () => {
    it.each([['current10', T0 + 5_000, true], ['stale9', null, false], ['generic pickup', T0 + 500, false]] as const)(
      'settles only recognized current-fire completion: %s', async (_label, at, recognized) => {
        const result = await reconcile({
          sql: fakeSql([deliveredWarmRow({ last_loop_turn_at: at === null ? null : pgString(at) })], []),
          nowMs: T0 + 30_000,
        });
        expect(result.rearmed).toBe(recognized ? 1 : 0);
        if (recognized) expect(result.loops[0]).toMatchObject({ via: 'loop-turn', completedAt: at });
      },
    );
  });

  it('re-arms from the delivered wake after grace when the loop-origin clock is absent or stale', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql(
        [
          deliveredWarmRow({
            // A turn after the claim but before delivery is not proof for this wake.
            last_loop_turn_at: pgString(T0 + 500),
            presence_last_active_at: null,
          }),
        ],
        updates,
      ),
      nowMs: T0 + 3 * 60_000, // beyond the 120s delivery grace
      recordFire,
    });

    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({
      id: 'rt-loop-origin',
      via: 'delivered-wake-no-loop-turn',
      completedAt: T0 + 1_000,
      // The delivery clock is stale by this pass, so normalization schedules one
      // full interval from the current reconcile clock instead of persisting a past fire.
      nextFireAt: T0 + 3 * 60_000 + 60_000,
    });
    expect(recordFire).toHaveBeenCalledWith(
      'papercusp',
      'loop-su-loop-origin',
      'loop-delivered-wake-no-loop-turn',
      'error',
    );
  });

  // WI-6554700010012153: a delivered wake that never becomes a turn used to emit only a
  // console.warn, and the backed-off circuit needed hours to open (EI-25930229050142968:
  // six such fires over ~1h50m with no loud signal). These pin the loud escalation.
  describe('no-turn wedge escalation (WI-6554700010012153)', () => {
    const staleWake = () =>
      deliveredWarmRow({ last_loop_turn_at: pgString(T0 + 500), presence_last_active_at: null });

    it('escalates once the post-record failure streak reaches the threshold, naming the loop and owner', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const escalateNoTurnWedge = vi.fn(async () => {});
      const res = await reconcile({
        sql: fakeSql([staleWake()], []),
        nowMs: T0 + 3 * 60_000,
        readFireState: vi.fn(async () => ({ consecutiveErrors: 3 }) as never),
        escalateNoTurnWedge,
        noTurnWedgeThreshold: 3,
      });

      expect(res.loops[0]).toMatchObject({ via: 'delivered-wake-no-loop-turn' });
      expect(escalateNoTurnWedge).toHaveBeenCalledTimes(1);
      expect(escalateNoTurnWedge).toHaveBeenCalledWith({
        routineId: 'rt-loop-origin',
        targetOwnerId: 'su-loop-origin',
        installSlug: 'papercusp',
        name: 'loop-su-loop-origin',
        consecutiveErrors: 3,
        lastWakeDeliveredAt: new Date(T0 + 1_000).toISOString(),
      });
    });

    it('stays quiet below the threshold — one or two missed turns are the circuit’s job, not an alarm', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const escalateNoTurnWedge = vi.fn(async () => {});
      await reconcile({
        sql: fakeSql([staleWake()], []),
        nowMs: T0 + 3 * 60_000,
        readFireState: vi.fn(async () => ({ consecutiveErrors: 2 }) as never),
        escalateNoTurnWedge,
        noTurnWedgeThreshold: 3,
      });
      expect(escalateNoTurnWedge).not.toHaveBeenCalled();
    });

    it('does not escalate on a settled loop-origin turn, however long the prior streak', async () => {
      const escalateNoTurnWedge = vi.fn(async () => {});
      await reconcile({
        sql: fakeSql([deliveredWarmRow({ last_loop_turn_at: pgString(T0 + 5_000) })], []),
        nowMs: T0 + 3 * 60_000,
        readFireState: vi.fn(async () => ({ consecutiveErrors: 7 }) as never),
        escalateNoTurnWedge,
        noTurnWedgeThreshold: 3,
      });
      expect(escalateNoTurnWedge).not.toHaveBeenCalled();
    });

    it('a failing escalation never aborts the re-arm it accompanies', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const res = await reconcile({
        sql: fakeSql([staleWake()], []),
        nowMs: T0 + 3 * 60_000,
        readFireState: vi.fn(async () => ({ consecutiveErrors: 5 }) as never),
        escalateNoTurnWedge: vi.fn(async () => {
          throw new Error('coord context unavailable');
        }),
        noTurnWedgeThreshold: 3,
      });
      expect(res.rearmed).toBe(1);
    });
  });

  it('uses a matching loop-origin assistant turn as the completion signal', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql(
        [
          deliveredWarmRow({
            last_loop_turn_at: pgString(T0 + 8_000),
            presence_last_active_at: null,
          }),
        ],
        updates,
      ),
      nowMs: T0 + 9_000,
      recordFire,
    });

    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({
      id: 'rt-loop-origin',
      via: 'loop-turn',
      completedAt: T0 + 8_000,
      nextFireAt: T0 + 68_000,
    });
    expect(recordFire).toHaveBeenCalledWith(
      'papercusp',
      'loop-su-loop-origin',
      'loop-loop-turn',
      'ok',
    );
  });

  // WI-10005545: a provider-killed turn still produces a loop-origin turn (the prompt landed and
  // the reply IS the API error), so 'loop-turn' is the via a psu-hosted warm loop reaches. It was
  // never reclassified: measured 2026-10-02, goal holder su-9ec5d030's 13:53:06Z and 14:02:01Z
  // fires each answered 'API Error: Request rejected (429) ...' and were recorded 'ok' at the
  // bare interval. The test above is the negative control (ordinary text stays 'ok').
  it("reclassifies a loop-turn settle whose reply is a provider 429 as a lifecycle death ('error'), not a false 'ok'", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}); // expected diagnostic log
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const escalateLifecycleDeath = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql(
        [
          deliveredWarmRow({
            last_loop_turn_at: pgString(T0 + 8_000),
            presence_last_active_at: null,
            last_assistant_text_after_fire:
              "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.",
          }),
        ],
        updates,
      ),
      nowMs: T0 + 9_000,
      recordFire,
      escalateLifecycleDeath,
    });

    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ id: 'rt-loop-origin', via: 'loop-turn', completedAt: T0 + 8_000 });
    expect(recordFire).toHaveBeenCalledWith(
      'papercusp',
      'loop-su-loop-origin',
      'loop-lifecycle-death:model_error',
      'error',
    );
    expect(recordFire).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'loop-loop-turn', 'ok');
    expect(escalateLifecycleDeath).toHaveBeenCalledWith(
      expect.objectContaining({
        routineId: 'rt-loop-origin',
        targetOwnerId: 'su-loop-origin',
        verdict: expect.objectContaining({ reason: 'model_error' }),
      }),
    );
  });

  it('a loop-turn settle whose reply is a usage wall re-arms past the bare interval (reset-aware), not straight back into the wall', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const escalateLifecycleDeath = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql(
        [
          deliveredWarmRow({
            last_loop_turn_at: pgString(T0 + 8_000),
            presence_last_active_at: null,
            last_assistant_text_after_fire: "You've hit your session limit · resets 5:40am (America/New_York)",
          }),
        ],
        updates,
      ),
      nowMs: T0 + 9_000,
      recordFire,
      escalateLifecycleDeath,
    });

    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('loop-turn');
    // A false 'ok' would schedule completedAt + interval = T0 + 68_000.
    expect(res.loops[0].nextFireAt).toBeGreaterThan(T0 + 8_000 + 60_000);
    expect(recordFire).toHaveBeenCalledWith(
      'papercusp',
      'loop-su-loop-origin',
      'loop-lifecycle-death:usage_limit',
      'error',
    );
  });

  // EI-24791346664119438: `delivered_at` is a SETTLE stamp (coalesce / turn-end settles write
  // now()), so a SHORT loop-fire turn can end before it lands. Measured 2026-10-02: fire prompt
  // at created+1s, reply at delivered-2s. Flooring the proof on delivered_at scored that real
  // turn as 'delivered-wake-no-loop-turn' → recordFire('error') → fire-gate backoff.
  it('credits a short loop-origin turn that ended before the delivery settle stamp, floored on the dispatch clock', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql(
        [
          deliveredWarmRow({
            last_wake_created_at: pgString(T0 + 1_000),
            last_wake_at: pgString(T0 + 42_000), // coalesced settle, after the turn ended
            last_wake_channel: 'coalesced',
            last_loop_turn_at: pgString(T0 + 40_000),
            presence_last_active_at: null,
          }),
        ],
        updates,
      ),
      nowMs: T0 + 3 * 60_000, // past the delivery grace, where the old floor retried as error
      recordFire,
    });

    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ id: 'rt-loop-origin', via: 'loop-turn', completedAt: T0 + 40_000 });
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-loop-origin', 'loop-loop-turn', 'ok');
    expect(recordFire).not.toHaveBeenCalledWith(
      'papercusp',
      'loop-su-loop-origin',
      'loop-delivered-wake-no-loop-turn',
      'error',
    );
  });

  it('still refuses a loop-origin turn that predates the wake dispatch clock', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql(
        [
          deliveredWarmRow({
            last_wake_created_at: pgString(T0 + 1_000),
            last_wake_at: pgString(T0 + 42_000),
            last_wake_channel: 'coalesced',
            // After the claim, but before this wake was even dispatched: not proof for it.
            last_loop_turn_at: pgString(T0 + 500),
            presence_last_active_at: null,
          }),
        ],
        updates,
      ),
      nowMs: T0 + 3 * 60_000,
      recordFire,
    });

    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ id: 'rt-loop-origin', via: 'delivered-wake-no-loop-turn' });
    expect(recordFire).toHaveBeenCalledWith(
      'papercusp',
      'loop-su-loop-origin',
      'loop-delivered-wake-no-loop-turn',
      'error',
    );
  });

  // EI-24791346664119438: session_turns is ingested AFTER a turn, so a long loop turn has no
  // strict proof while it runs. Measured 2026-10-02: 64/334 settles in 24h were real loop turns
  // scored 'delivered-wake-no-loop-turn' → error. The real-time turn-start stamp holds them.
  it('holds a long loop turn whose real-time start stamp postdates the wake dispatch', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql(
        [
          deliveredWarmRow({
            last_wake_created_at: pgString(T0 + 1_000),
            last_wake_at: pgString(T0 + 1_500),
            last_wake_channel: 'psu-socket-inject',
            last_loop_turn_at: null, // not ingested yet: the turn is still running
            loop_turn_started_at: pgString(T0 + 5_000),
            turn_journal_completed_at: pgString(T0 + 3_000), // a PRIOR turn's end, before the stamp
            presence_last_active_at: null, // a long silent Bash: presence is quiet
          }),
        ],
        updates,
      ),
      nowMs: T0 + 3 * 60_000, // past the delivery grace, where the detector used to retry
      recordFire,
    });

    expect(res.rearmed).toBe(0);
    expect(recordFire).not.toHaveBeenCalledWith(
      'papercusp',
      'loop-su-loop-origin',
      'loop-delivered-wake-no-loop-turn',
      'error',
    );
  });

  it('settles a stamped loop turn as ok once the Stop-hook journal lands after the stamp', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql(
        [
          deliveredWarmRow({
            last_wake_created_at: pgString(T0 + 1_000),
            last_wake_at: pgString(T0 + 1_500),
            last_wake_channel: 'psu-socket-inject',
            last_loop_turn_at: null, // still not ingested
            loop_turn_started_at: pgString(T0 + 5_000),
            lifecycle_completed_at: null,
            turn_journal_completed_at: pgString(T0 + 90_000), // the loop turn's own end
            presence_last_active_at: null,
          }),
        ],
        updates,
      ),
      nowMs: T0 + 3 * 60_000,
      recordFire,
    });

    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ id: 'rt-loop-origin', via: 'turn-journal' });
    expect(recordFire).not.toHaveBeenCalledWith(
      'papercusp',
      'loop-su-loop-origin',
      'loop-delivered-wake-no-loop-turn',
      'error',
    );
  });

  it('ignores a turn-start stamp that predates the wake dispatch clock', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql(
        [
          deliveredWarmRow({
            last_wake_created_at: pgString(T0 + 1_000),
            last_wake_at: pgString(T0 + 1_500),
            last_wake_channel: 'psu-socket-inject',
            last_loop_turn_at: null,
            // An earlier loop-fire turn, before this wake was dispatched: not proof for it.
            loop_turn_started_at: pgString(T0 + 500),
            presence_last_active_at: null,
          }),
        ],
        updates,
      ),
      nowMs: T0 + 3 * 60_000,
      recordFire,
    });

    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ id: 'rt-loop-origin', via: 'delivered-wake-no-loop-turn' });
  });

  it('does not suppress the legacy completion ladder for a non-delivered wake', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql(
        [
          deliveredWarmRow({
            last_wake_status: 'failed',
            lifecycle_completed_at: pgString(T0 + 2_000),
            turn_journal_completed_at: pgString(T0 + 3_000),
            last_loop_turn_at: null,
            presence_last_active_at: null,
          }),
        ],
        updates,
      ),
      nowMs: T0 + 10_000,
      recordFire,
    });

    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({
      id: 'rt-loop-origin',
      via: 'lifecycle',
      completedAt: T0 + 2_000,
    });
    expect(recordFire).toHaveBeenCalledWith(
      'papercusp',
      'loop-su-loop-origin',
      'loop-lifecycle',
      'ok',
    );
  });

  it('keeps a recently active delivered turn in flight after delivery grace, not on the stale-wake retry path', async () => {
    const updates: unknown[][] = [];
    const res = await reconcile({
      sql: fakeSql(
        [
          deliveredWarmRow({
            lifecycle_completed_at: null,
            turn_journal_completed_at: null,
            presence_last_active_at: pgString(T0 + 100_000),
          }),
        ],
        updates,
      ),
      nowMs: T0 + 130_000, // wake grace elapsed, but genuine activity was only 30s ago
    });

    expect(res.rearmed).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it('routes a post-grace delivered wake with no loop turn through the terminal guard before retrying', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const checkUnreachableTerminalGuard = vi.fn(async () => ({
      breach: true,
      reason: 'dead-owner: delivered wake never became a loop turn',
    }));
    const cancelInboxWake = vi.fn(async () => 1);
    const escalateDeadLoop = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql(
        [
          deliveredWarmRow({
            lifecycle_completed_at: null,
            turn_journal_completed_at: null,
            last_loop_turn_at: null,
            presence_last_active_at: null,
          }),
        ],
        updates,
      ),
      nowMs: T0 + 31 * 60_000, // past stuckParkMs(60s) = 30min
      recordFire,
      checkUnreachableTerminalGuard,
      cancelInboxWake,
      escalateDeadLoop,
    });

    expect(res.rearmed).toBe(0);
    expect(res.loops).toEqual([]);
    expect(res.terminated).toEqual([
      {
        id: 'rt-loop-origin',
        targetOwnerId: 'su-loop-origin',
        reason: 'dead-owner: delivered wake never became a loop turn',
      },
    ]);
    expect(updates).toHaveLength(0);
    expect(checkUnreachableTerminalGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        routineId: 'rt-loop-origin',
        targetOwnerId: 'su-loop-origin',
        circuitOpen: false,
      }),
    );
    expect(recordFire).toHaveBeenCalledWith(
      'papercusp',
      'loop-su-loop-origin',
      'loop-terminal-unreachable',
      'error',
    );
    expect(cancelInboxWake).toHaveBeenCalledWith('su-loop-origin', 'ws-papercusp');
    expect(escalateDeadLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        routineId: 'rt-loop-origin',
        targetOwnerId: 'su-loop-origin',
        reason: 'dead-owner: delivered wake never became a loop turn',
      }),
    );
  });

  it('preserves cron+loop and cold-loop ladders when the new discriminator fields are present', async () => {
    const cronUpdates: unknown[][] = [];
    const cron = await reconcile({
      sql: fakeSql(
        [
          deliveredWarmRow({
            is_cron: true,
            last_loop_turn_at: null,
            presence_last_active_at: null,
          }),
        ],
        cronUpdates,
      ),
      nowMs: T0 + 10_000,
    });
    expect(cron.rearmed).toBe(1);
    expect(cron.loops[0]).toMatchObject({ via: 'lifecycle', completedAt: T0 + 2_000 });

    const coldUpdates: unknown[][] = [];
    const cold = await reconcile({
      sql: fakeSql(
        [
          deliveredWarmRow({
            carry: 'cold',
            lifecycle_completed_at: null,
            turn_journal_completed_at: pgString(T0 + 5_000),
            presence_last_active_at: pgString(T0 + 5_000),
            note_updated_ts: null,
          }),
        ],
        coldUpdates,
      ),
      nowMs: T0 + 10_000,
    });
    expect(cold.rearmed).toBe(0);
    expect(coldUpdates).toHaveLength(0);
  });
});

describe('reconcileLoopRoutines — circuit feed (loop-wake-rate-limit-robustness P0b)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  it("a stuck-park backstop re-arm feeds the circuit with 'error' (channel-agnostic dead-turn signal)", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}); // the stuck-park backstop logs (expected)
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const sql = fakeSql(
      [
        {
          id: 'rt-stuck',
          target_owner_id: 'su-dead',
          interval_sec: 120,
          parked: true,
          install_slug: 'papercusp',
          name: 'loop-su-dead',
          routine_workspace_id: 'ws-papercusp',
          last_fired_at: pgString(T0), // fired long ago…
          lifecycle_completed_at: null, // …no completion marker (turn died / never delivered)…
          presence_last_active_at: null, // …and no post-fire activity.
        },
      ],
      updates,
    );
    // nowMs is well past max(30min, 4×interval) since the fire → the stuck-park backstop fires.
    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 31 * 60_000,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    expect(res.rearmed).toBe(1);
    expect(res.terminated).toEqual([]);
    expect(res.loops[0].via).toBe('stuck-backstop');
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-dead', expect.stringContaining('stuck-backstop'), 'error');
  });

  it('a still-in-flight loop (no signal, not yet stuck) re-arms NOTHING and feeds NOTHING', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const sql = fakeSql(
      [
        {
          id: 'rt-inflight',
          target_owner_id: 'su-busy',
          interval_sec: 120,
          parked: true,
          install_slug: 'papercusp',
          name: 'loop-su-busy',
          routine_workspace_id: 'ws-papercusp',
          last_fired_at: pgString(T0),
          lifecycle_completed_at: null,
          presence_last_active_at: pgString(T0 + 1_000), // active AFTER the fire → a live long turn
        },
      ],
      updates,
    );
    const res = await reconcile({ sql, nowMs: T0 + 5_000, recordFire });
    expect(res.rearmed).toBe(0);
    expect(recordFire).not.toHaveBeenCalled();
  });
});

describe('reconcileLoopRoutines — stuck-backstop (no-signal) death reclassification (EI-19295537569038753)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  it("a wedged session that never produces a completion SIGNAL (no lifecycle marker, no presence bump) still gets its captured text reclassified — reset-aware rearm past the bare interval, not the blind stuck-backstop interval", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}); // expected diagnostic logs
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const escalateLifecycleDeath = vi.fn(async () => {});
    const wallText = "You've hit your session limit · resets 5:40am (America/New_York)";
    const nowMs = T0 + 31 * 60_000;
    const verdict = classifyLoopLifecycleTurn(wallText, 60_000, nowMs);
    expect(verdict?.reason).toBe('usage_limit');
    expect(verdict?.rearmDelayMs).toBeGreaterThan(60_000);
    const sql = fakeSql(
      [
        {
          id: 'rt-wedged',
          target_owner_id: 'su-wedged',
          interval_sec: 60,
          parked: true,
          install_slug: 'papercusp',
          name: 'loop-su-wedged',
          routine_workspace_id: 'ws-papercusp',
          last_fired_at: pgString(T0),
          lifecycle_completed_at: null, // no Stop-hook 'ended' — the process never cleanly exits
          presence_last_active_at: null, // no post-fire activity AT ALL (signal === null: see completionSignal)
          // The turn's own final text DID capture the wall — a text-only reply with no tool
          // call, so presence never bumped and neither lifecycle/turn-journal/presence-quiescence
          // ever produces a `signal`. Before this fix, this field was fetched and then never read
          // on this branch.
          last_assistant_text_after_fire: wallText,
        },
      ],
      updates,
    );
    // Past the classic stuck-park dwell (>=30min) so the backstop actually fires.
    const res = await reconcileLoopRoutines({
      sql,
      nowMs,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
      escalateLifecycleDeath,
    });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('stuck-backstop'); // the signal classification itself is unchanged
    // The parsed delay is relative to this reconciliation pass, not the earlier parked fire.
    // Using T0 + rearmDelayMs would count the 31-minute park twice and wake before the reset.
    expect(res.loops[0].nextFireAt).toBe(nowMs + verdict!.rearmDelayMs);
    expect(recordFire).toHaveBeenCalledWith(
      'papercusp',
      'loop-su-wedged',
      expect.stringContaining('lifecycle-death:usage_limit'), // not the bare 'loop-stuck-backstop' detail
      'error', // stuck-backstop always recorded 'error' — unchanged, just now correctly reset-aware
    );
    expect(escalateLifecycleDeath).toHaveBeenCalledWith(
      expect.objectContaining({
        routineId: 'rt-wedged',
        targetOwnerId: 'su-wedged',
        verdict: expect.objectContaining({ reason: 'usage_limit' }),
      }),
    );
  });

  it('a stuck-backstop row with ORDINARY (or absent) captured text keeps the plain interval but never a past fire', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const escalateLifecycleDeath = vi.fn(async () => {});
    const sql = fakeSql(
      [
        {
          id: 'rt-dead',
          target_owner_id: 'su-dead',
          interval_sec: 120,
          parked: true,
          install_slug: 'papercusp',
          name: 'loop-su-dead',
          routine_workspace_id: 'ws-papercusp',
          last_fired_at: pgString(T0),
          lifecycle_completed_at: null,
          presence_last_active_at: null,
          last_assistant_text_after_fire: null, // never delivered / no text at all — the common case
        },
      ],
      updates,
    );
    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 31 * 60_000,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
      escalateLifecycleDeath,
    });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('stuck-backstop');
    // The old last-fired + interval candidate is already stale at this delayed pass.
    expect(res.loops[0].nextFireAt).toBe(T0 + 31 * 60_000 + 120_000);
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-dead', expect.stringContaining('stuck-backstop'), 'error');
    expect(escalateLifecycleDeath).not.toHaveBeenCalled();
  });
});

describe('classifyLoopLifecycleTurn — pure classifier (EI-13818)', () => {
  const NOW = 1_782_000_000_000;

  it('returns null for a genuine settle (no provider-kill signature)', () => {
    expect(classifyLoopLifecycleTurn('Fixed the bug, tests green, work item complete.', 60_000, NOW)).toBeNull();
  });

  it('returns null for absent/blank text (a read miss must never manufacture a death)', () => {
    expect(classifyLoopLifecycleTurn(null, 60_000, NOW)).toBeNull();
    expect(classifyLoopLifecycleTurn(undefined, 60_000, NOW)).toBeNull();
    expect(classifyLoopLifecycleTurn('   ', 60_000, NOW)).toBeNull();
  });

  // EI-22102700164999066. This leg scans BLIND over `last_assistant_text_after_fire`, so it
  // carries both halves of one contract: a real provider 429 must still be caught (that is the
  // death this leg exists for), while a turn that merely DISCUSSED one must not be. Before the
  // fix the second case was recorded as a dead wake — recordFire('error'), fire-gate backoff and
  // a spurious death escalation against a healthy loop.
  it('catches a real machine-emitted 429 death (the incident text)', () => {
    const text =
      "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.";
    const verdict = classifyLoopLifecycleTurn(text, 60_000, NOW);
    expect(verdict?.reason).toBe('model_error');
    // model_error is not reset-parseable, so it re-arms at the bare interval and leaves further
    // backoff to the fire-gate circuit the 'error' verdict feeds.
    expect(verdict?.rearmDelayMs).toBe(60_000);
  });

  it('does NOT treat a turn that merely DISCUSSES rate limits / 429s as a death', () => {
    for (const benign of [
      'discussed the rate limit fix and why 429 handling matters',
      'Fixed the 429 backoff bug; the loop is rate limited only under load. Tests green.',
      'Investigated EI-22102700164999066: the wake died on a rate limit with no escalation.',
    ]) {
      expect(classifyLoopLifecycleTurn(benign, 60_000, NOW)).toBeNull();
    }
  });

  // EI-23881176965254978 — the Codex model-capacity wall the owner reported. It kills a wake
  // exactly like the 429 above, but names neither a limit, a quota, nor a status code, so it
  // classified as a clean SETTLE: the loop recorded a healthy fire and re-armed on the blind
  // interval, walking the next wake straight back into the same wall. These three pin the whole
  // contract — caught, floored, and (the falsifiable half) not tripped by merely discussing it.
  it('catches a Codex model-capacity death and floors the re-arm at the provider retry window', () => {
    const verdict = classifyLoopLifecycleTurn(
      '⚠ Selected model is at capacity. Please try a different model.',
      30_000,
      NOW,
    );
    expect(verdict?.reason).toBe('model_error');
    // The 30s interval is TIGHTER than the capacity window, so it is floored UP to it.
    expect(verdict?.rearmDelayMs).toBe(MODEL_CAPACITY_RETRY_AFTER_MS);
    expect(verdict?.rearmDelayMs).toBeGreaterThan(30_000); // the bare interval would under-wait
  });

  it('leaves a loop slower than the capacity window on its own cadence (a minimum-wait rail, not a schedule)', () => {
    const verdict = classifyLoopLifecycleTurn(
      'Selected model is at capacity. Please try a different model.',
      15 * 60_000,
      NOW,
    );
    expect(verdict?.reason).toBe('model_error');
    expect(verdict?.rearmDelayMs).toBe(15 * 60_000);
  });

  it('does NOT treat a turn that merely DISCUSSES the capacity wall as a death', () => {
    for (const benign of [
      'Implemented the retry: a Codex turn whose selected model is at capacity now waits 60s.',
      'The owner reported "Selected model is at capacity" — added the classifier and tests. Green.',
    ]) {
      expect(classifyLoopLifecycleTurn(benign, 60_000, NOW)).toBeNull();
    }
  });

  it("classifies a usage_limit death and computes a reset-aware rearm delay (not the bare interval)", () => {
    const text = "You've hit your session limit · resets 5:40am (America/New_York)";
    const verdict = classifyLoopLifecycleTurn(text, 60_000, NOW);
    expect(verdict?.reason).toBe('usage_limit');
    expect(verdict?.evidence).toContain('session limit');
    // Cross-check against the SAME reset parser the verdict reuses — no independent TZ math.
    const expectedReset = parseUsageReset(text, NOW);
    expect(expectedReset).toBeDefined();
    expect(verdict?.rearmDelayMs).toBe(Math.min(Math.max(expectedReset!.atMs - NOW, 60_000), 6 * 3_600_000));
    expect(verdict?.rearmDelayMs).toBeGreaterThan(60_000); // strictly more than the bare interval
  });

  it('does NOT treat a quoted weekly usage-limit reset sentence as a dead wake', () => {
    const providerText = "You've hit your weekly limit · resets Sep 10, 7am (America/New_York)";
    expect(classifyLoopLifecycleTurn(providerText, 60_000, NOW)?.reason).toBe('usage_limit');

    const discussion = `Reviewed the healthy-loop report, which quoted “${providerText}”; no provider limit stopped this turn.`;
    expect(classifyLoopLifecycleTurn(discussion, 60_000, NOW)).toBeNull();
  });

  // WI-6852: the cap was 1h, which BOUND on every real wall instead of acting as a sanity rail
  // (measured: 13 of 15 lifecycle-death re-arms landed on exactly 60m, i.e. every one was clipped
  // and under-waited, then re-fired into the still-active wall). Relative-duration text is used
  // here deliberately: it pins the expected value with no timezone math to get wrong.
  it('does NOT clip a multi-hour wall to the old 1h cap (WI-6852)', () => {
    const verdict = classifyLoopLifecycleTurn(
      "You've hit your session limit · resets in 3 hours",
      60_000,
      NOW,
    );
    expect(verdict?.reason).toBe('usage_limit');
    expect(verdict?.rearmDelayMs).toBe(3 * 3_600_000);
    expect(verdict?.rearmDelayMs).toBeGreaterThan(3_600_000); // the old cap would have clipped it
  });

  it('still applies a sanity ceiling so a bogus parse cannot park a loop for a day', () => {
    const verdict = classifyLoopLifecycleTurn(
      "You've hit your session limit · resets in 30 hours",
      60_000,
      NOW,
    );
    expect(verdict?.rearmDelayMs).toBe(6 * 3_600_000);
  });

  // EI-20544023385610622 — THE DEFECT, at the layer that exhibited it. EI-20542327908037306 taught
  // the parser the weekly form, but this caller then clipped the correctly-parsed ~113h hold to the
  // 6h cap tuned for DAILY walls, so a walled loop still re-fired ~4x/day into a window it already
  // knew was closed — each COLD fire burning a full context reset for zero work.
  it('holds a date-qualified WEEKLY wall in full instead of clipping it to the daily 6h cap', () => {
    // Sat Aug 15 → the following Thu Aug 20: days out, and the message NAMES the date.
    const now = Date.parse('2026-08-15T17:47:00Z');
    const text = "You've hit your weekly limit · resets Aug 20, 7am (America/New_York)";
    const verdict = classifyLoopLifecycleTurn(text, 60_000, now);
    expect(verdict?.reason).toBe('usage_limit');
    // Pinned against the same parser, so no independent TZ math can drift.
    const reset = parseUsageReset(text, now);
    expect(reset?.precision).toBe('dated');
    expect(verdict?.rearmDelayMs).toBe(reset!.atMs - now);
    // The regression this pins: the old single cap returned exactly 6h here.
    expect(verdict?.rearmDelayMs).toBeGreaterThan(6 * 3_600_000);
    expect(verdict?.rearmDelayMs).toBeGreaterThan(4 * 86_400_000);
  });

  // The other half of the same decision: widening the ceiling for a NAMED instant must not widen
  // it for an INFERRED one, or the mis-parse hazard the rail exists to prevent comes back for
  // every loop on the box.
  it('does NOT extend the ceiling for a bare-clock reset, whose day is inferred', () => {
    const now = Date.parse('2026-08-15T17:47:00Z');
    // "resets 4am" ~10h out by the next-occurrence rule — beyond 6h, and still clipped to it.
    const verdict = classifyLoopLifecycleTurn(
      "You've hit your session limit · resets 4am (America/New_York)",
      60_000,
      now,
    );
    expect(parseUsageReset('resets 4am', now)?.precision).toBe('clock');
    expect(verdict?.rearmDelayMs).toBe(6 * 3_600_000);
  });

  it('classifies an auth_wall death with the plain-interval rearm (no reset time to parse)', () => {
    const text = 'Your organization has disabled Claude subscription access for Claude Code.';
    const verdict = classifyLoopLifecycleTurn(text, 60_000, NOW);
    expect(verdict?.reason).toBe('auth_wall');
    expect(verdict?.rearmDelayMs).toBe(60_000);
  });

  it('never shortens the rearm below the loop interval', () => {
    // A reset time in the very near future (or already past — "already passed today" pushes to
    // tomorrow per parseUsageReset, but even a same-second edge case must never UNDERCUT the
    // caller's own interval floor).
    const verdict = classifyLoopLifecycleTurn("hit your usage limit · resets now", 5 * 60_000, NOW);
    expect(verdict?.rearmDelayMs).toBeGreaterThanOrEqual(5 * 60_000);
  });
});

describe('reconcileLoopRoutines — lifecycle-death reclassification (EI-13818)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  it("a CLEANLY-completed turn whose text is a session-limit death feeds 'error' (not a false 'ok') and re-arms past the bare interval", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}); // expected diagnostic log
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const escalateLifecycleDeath = vi.fn(async () => {});
    const sql = fakeSql(
      [
        {
          id: 'rt-1',
          target_owner_id: 'su-leader',
          interval_sec: 180, // the reported incident's ~3min cadence
          parked: true,
          install_slug: 'papercusp',
          name: 'loop-su-leader',
          routine_workspace_id: 'ws-papercusp',
          last_fired_at: pgString(T0),
          lifecycle_completed_at: pgString(T0 + 5_000), // the Stop hook DID fire — a "clean" exit
          presence_last_active_at: null,
          last_assistant_text_after_fire: "You've hit your session limit · resets 5:40am (America/New_York)",
        },
      ],
      updates,
    );
    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 10_000,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
      escalateLifecycleDeath,
    });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('lifecycle'); // the signal itself is unchanged — only the outcome is
    // The whole point: this must NOT be the bare completedAt+interval a false 'ok' would use.
    expect(res.loops[0].nextFireAt).toBeGreaterThan(T0 + 5_000 + 180_000);
    expect(recordFire).toHaveBeenCalledWith(
      'papercusp',
      'loop-su-leader',
      expect.stringContaining('lifecycle-death:usage_limit'),
      'error', // NOT 'ok' — this is the exact false-positive the bug report describes
    );
    expect(escalateLifecycleDeath).toHaveBeenCalledWith(
      expect.objectContaining({
        routineId: 'rt-1',
        targetOwnerId: 'su-leader',
        verdict: expect.objectContaining({ reason: 'usage_limit' }),
      }),
    );
  });

  it("a Claude API 400 without a colon feeds 'error' instead of resetting the loop streak", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const escalateLifecycleDeath = vi.fn(async () => {});
    const sql = fakeSql(
      [
        {
          id: 'rt-api-error',
          target_owner_id: 'su-broken',
          interval_sec: 45 * 60,
          parked: true,
          install_slug: 'papercusp',
          name: 'loop-su-broken',
          routine_workspace_id: 'ws-papercusp',
          last_fired_at: pgString(T0),
          lifecycle_completed_at: pgString(T0 + 5_000),
          presence_last_active_at: null,
          last_assistant_text_after_fire:
            "API Error 400 Tool reference 'advisor' not found in available tools",
        },
      ],
      updates,
    );
    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 10_000,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
      escalateLifecycleDeath,
    });

    expect(res.rearmed).toBe(1);
    expect(recordFire).toHaveBeenCalledWith(
      'papercusp',
      'loop-su-broken',
      'loop-lifecycle-death:model_error',
      'error',
    );
    expect(escalateLifecycleDeath).toHaveBeenCalledWith(
      expect.objectContaining({
        routineId: 'rt-api-error',
        targetOwnerId: 'su-broken',
        verdict: expect.objectContaining({ reason: 'model_error' }),
      }),
    );
  });

  it('a lifecycle completion with ORDINARY text is unaffected — still feeds `ok` at the bare interval', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const escalateLifecycleDeath = vi.fn(async () => {});
    const sql = fakeSql(
      [
        {
          id: 'rt-1',
          target_owner_id: 'su-healthy',
          interval_sec: 60,
          parked: true,
          install_slug: 'papercusp',
          name: 'loop-su-healthy',
          routine_workspace_id: 'ws-papercusp',
          last_fired_at: pgString(T0),
          lifecycle_completed_at: pgString(T0 + 5_000),
          presence_last_active_at: null,
          last_assistant_text_after_fire: 'Checkpointed and ending the turn — work continues next wake.',
        },
      ],
      updates,
    );
    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 10_000,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
      escalateLifecycleDeath,
    });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].nextFireAt).toBe(T0 + 5_000 + 60_000); // byte-identical to the pre-EI-13818 math
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-healthy', expect.stringContaining('lifecycle'), 'ok');
    expect(escalateLifecycleDeath).not.toHaveBeenCalled();
  });
});

describe('reconcileLoopRoutines — presence-quiescence death reclassification (EI-15722)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  it("a presence-quiescence settle whose last turn text is a provider-kill signature feeds 'error' (not a false 'ok') and re-arms past the bare interval — the exact false-positive that let a loop fire on schedule for 22h+ with zero real turns", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}); // expected diagnostic log
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const escalateLifecycleDeath = vi.fn(async () => {});
    const sql = fakeSql(
      [
        {
          id: 'rt-1',
          target_owner_id: 'su-stuck',
          interval_sec: 60,
          parked: true,
          install_slug: 'papercusp',
          name: 'loop-su-stuck',
          routine_workspace_id: 'ws-papercusp',
          last_fired_at: pgString(T0),
          // NO lifecycle 'ended' marker — the Stop-hook report was lost (the exact reason the
          // presence-quiescence fallback exists at all: layer 2, "a detached, fail-open POST").
          lifecycle_completed_at: null,
          presence_last_active_at: pgString(T0 + 4_000), // one dispatch bumped activity, then quiet
          last_assistant_text_after_fire: "You've hit your session limit · resets 5:40am (America/New_York)",
        },
      ],
      updates,
    );
    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 70_000, // ≥ FALLBACK_QUIET_MS (60s) past the last activity, so the fallback fires
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
      escalateLifecycleDeath,
    });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('presence-quiescence'); // the signal itself is unchanged — only the outcome is
    // The whole point: this must NOT be the bare completedAt+interval a false 'ok' would use.
    expect(res.loops[0].nextFireAt).toBeGreaterThan(T0 + 4_000 + 60_000);
    expect(recordFire).toHaveBeenCalledWith(
      'papercusp',
      'loop-su-stuck',
      expect.stringContaining('lifecycle-death:usage_limit'),
      'error', // NOT 'ok' — previously this via recorded 'ok' unconditionally, with no text check at all
    );
    expect(escalateLifecycleDeath).toHaveBeenCalledWith(
      expect.objectContaining({
        routineId: 'rt-1',
        targetOwnerId: 'su-stuck',
        verdict: expect.objectContaining({ reason: 'usage_limit' }),
      }),
    );
  });

  it('a presence-quiescence settle with ORDINARY (or absent) turn text still feeds `ok` without a past next fire', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const escalateLifecycleDeath = vi.fn(async () => {});
    const sql = fakeSql(
      [
        {
          id: 'rt-1',
          target_owner_id: 'su-healthy',
          interval_sec: 60,
          parked: true,
          install_slug: 'papercusp',
          name: 'loop-su-healthy',
          routine_workspace_id: 'ws-papercusp',
          last_fired_at: pgString(T0),
          lifecycle_completed_at: null,
          presence_last_active_at: pgString(T0 + 4_000),
          last_assistant_text_after_fire: 'Claimed the next bug and fixed it — ending the turn.',
        },
      ],
      updates,
    );
    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 70_000,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
      escalateLifecycleDeath,
    });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('presence-quiescence');
    expect(res.loops[0].nextFireAt).toBe(T0 + 70_000 + 60_000);
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-healthy', expect.stringContaining('presence-quiescence'), 'ok');
    expect(escalateLifecycleDeath).not.toHaveBeenCalled();
  });
});

describe('reconcileLoopRoutines — dead-owner terminal guard (WI-1399)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  function stuckRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'rt-dead',
      target_owner_id: 'su-permanently-gone',
      interval_sec: 120,
      parked: true,
      install_slug: 'papercusp',
      name: 'loop-su-gone',
      routine_workspace_id: 'ws-papercusp',
      last_fired_at: pgString(T0),
      lifecycle_completed_at: null,
      presence_last_active_at: null,
      ...overrides,
    };
  }

  it('a stuck-backstop fire whose terminal guard BREACHES is TERMINATED, not re-armed — AND (WI-2339 D+E) cancels the ghost inbox-wake + loudly escalates', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const sql = fakeSql([stuckRow()], updates);
    const recordFire = vi.fn(async () => {});
    const readFireState = vi.fn(async () => ({ lastFiredAt: null, consecutiveErrors: 2 }));
    const checkUnreachableTerminalGuard = vi.fn(async () => ({ breach: true, reason: 'dead-owner: unreachable, WI-1399' }));
    // WI-2339 fixes D + E — injected so the unit stays hermetic (the real defaults hit coord/PG).
    const cancelInboxWake = vi.fn(async () => 1);
    const escalateDeadLoop = vi.fn(async () => {});

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 31 * 60_000,
      recordFire,
      readFireState,
      checkUnreachableTerminalGuard,
      cancelInboxWake,
      escalateDeadLoop,
    });

    expect(res.rearmed).toBe(0);
    expect(res.loops).toEqual([]);
    expect(res.terminated).toEqual([
      { id: 'rt-dead', targetOwnerId: 'su-permanently-gone', reason: 'dead-owner: unreachable, WI-1399' },
    ]);
    expect(updates).toHaveLength(0); // no re-arm UPDATE fired — the guard's own autoPause already deactivated it
    // stuckFireCount passed to the guard is (prior consecutiveErrors=2) + 1 = 3 for THIS fire.
    expect(checkUnreachableTerminalGuard).toHaveBeenCalledWith(
      expect.objectContaining({ routineId: 'rt-dead', targetOwnerId: 'su-permanently-gone', stuckFireCount: 3 }),
    );
    // Still recorded to the fire history (autoloop_state), per the terminal-guard contract.
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-gone', 'loop-terminal-unreachable', 'error');
    // WI-2339 fix D — the dead owner's ghost standing inbox-wake await is cancelled so it stops
    // poisoning every OTHER wake source (called with the owner + its workspace).
    expect(cancelInboxWake).toHaveBeenCalledWith('su-permanently-gone', 'ws-papercusp');
    // WI-2339 fix E — a loud human escalation is raised (pause+escalate, not silent no-op), carrying
    // the routine/owner/harness + the guard's reason.
    expect(escalateDeadLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        routineId: 'rt-dead',
        targetOwnerId: 'su-permanently-gone',
        installSlug: 'papercusp',
        name: 'loop-su-gone',
        reason: 'dead-owner: unreachable, WI-1399',
      }),
    );
  });

  it('a stuck-backstop fire whose terminal guard does NOT breach re-arms exactly as before (backward-compat)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const sql = fakeSql([stuckRow()], updates);
    const recordFire = vi.fn(async () => {});
    const readFireState = vi.fn(async () => null); // no prior errors → stuckFireCount = 1
    const checkUnreachableTerminalGuard = vi.fn(async () => ({ breach: false }));

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 31 * 60_000,
      recordFire,
      readFireState,
      checkUnreachableTerminalGuard,
    });

    expect(res.terminated).toEqual([]);
    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ id: 'rt-dead', via: 'stuck-backstop' });
    expect(checkUnreachableTerminalGuard).toHaveBeenCalledWith(expect.objectContaining({ stuckFireCount: 1 }));
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-gone', expect.stringContaining('stuck-backstop'), 'error');
  });

  it('a terminal-guard check failure is fail-soft — falls back to the normal stuck-backstop re-arm', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const sql = fakeSql([stuckRow()], updates);
    const recordFire = vi.fn(async () => {});
    const readFireState = vi.fn(async () => null);
    const checkUnreachableTerminalGuard = vi.fn(async () => {
      throw new Error('probe read failed');
    });

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 31 * 60_000,
      recordFire,
      readFireState,
      checkUnreachableTerminalGuard,
    });

    expect(res.terminated).toEqual([]);
    expect(res.rearmed).toBe(1); // never blocked / never threw — the row was still re-armed to retry
  });

  it('a readFireState failure is fail-soft — treated as zero prior errors, guard still consulted', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const sql = fakeSql([stuckRow()], updates);
    const recordFire = vi.fn(async () => {});
    const readFireState = vi.fn(async () => {
      throw new Error('pg read failed');
    });
    const checkUnreachableTerminalGuard = vi.fn(async () => ({ breach: false }));

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 31 * 60_000,
      recordFire,
      readFireState,
      checkUnreachableTerminalGuard,
    });

    expect(res.rearmed).toBe(1);
    expect(checkUnreachableTerminalGuard).toHaveBeenCalledWith(expect.objectContaining({ stuckFireCount: 1 }));
  });
});

describe('reconcileLoopRoutines — bounded consecutive zero-tool escalation (WI-41228)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');
  const settledRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'rt-zero-tool',
    target_owner_id: 'su-zero-tool',
    interval_sec: 60,
    parked: true,
    is_cron: false,
    install_slug: 'papercusp',
    name: 'loop-su-zero-tool',
    routine_workspace_id: 'ws-papercusp',
    last_fired_at: pgString(T0),
    lifecycle_completed_at: pgString(T0 + 5_000),
    turn_journal_completed_at: null,
    lifecycle_started_at: null,
    presence_last_active_at: null,
    last_assistant_text_after_fire: null,
    turns_ingest_watermark: null,
    ...overrides,
  });

  it('the Nth zero-tool dispatched fire pauses then terminates exactly once without re-arming', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const countAgentToolCallsInWindow = vi.fn(async () => 0);
    const recordZeroToolFireObservation = vi.fn(async () => ({
      counted: true,
      streak: 3,
      toolCalls: 0,
      fireToken: new Date(T0).toISOString(),
      threshold: 3,
      atThreshold: true,
    }));
    const autoPauseLoopRoutine = vi.fn(async () => {});
    const cancelInboxWake = vi.fn(async () => 1);
    const escalateDeadLoop = vi.fn(async () => {});

    const res = await reconcileLoopRoutines({
      sql: fakeSql([settledRow()], updates),
      nowMs: T0 + 10_000,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      countAgentToolCallsInWindow,
      recordZeroToolFireObservation,
      autoPauseLoopRoutine,
      cancelInboxWake,
      escalateDeadLoop,
      zeroToolThreshold: 3,
    });

    // WI-2143038: the evidence window runs to NOW (T0 + 10_000), not to the turn-settled
    // `completedAt` (T0 + 5_000) which could close before the woken agent's work landed —
    // and it asks the 'fire-productivity' question, which counts native tool calls and does
    // NOT exclude the carry-note writers. Both are load-bearing: with the old contract a
    // watcher whose wake is a Bash probe plus a loop:checkpoint scored a structural zero.
    expect(countAgentToolCallsInWindow).toHaveBeenCalledWith(
      'su-zero-tool',
      T0,
      T0 + 10_000,
      expect.objectContaining({ evidenceScope: 'fire-productivity' }),
    );
    expect(recordZeroToolFireObservation).toHaveBeenCalledTimes(1);
    expect(autoPauseLoopRoutine).toHaveBeenCalledWith(
      expect.anything(),
      'rt-zero-tool',
      expect.stringContaining('3 consecutive dispatched turns'),
      'loop-zero-tool-escalation',
    );
    expect(res.rearmed).toBe(0);
    expect(res.terminated).toHaveLength(1);
    expect(updates).toHaveLength(0);
    expect(cancelInboxWake).toHaveBeenCalledTimes(1);
    expect(escalateDeadLoop).toHaveBeenCalledTimes(1);
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-zero-tool', 'loop-terminal-unreachable', 'error');
  });

  it('a pre-threshold zero-tool fire keeps the existing healthy-settle outcome mapping', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const autoPauseLoopRoutine = vi.fn(async () => {});
    const res = await reconcileLoopRoutines({
      sql: fakeSql([settledRow()], updates),
      nowMs: T0 + 10_000,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      countAgentToolCallsInWindow: vi.fn(async () => 0),
      recordZeroToolFireObservation: vi.fn(async () => ({
        counted: true,
        streak: 2,
        toolCalls: 0,
        fireToken: new Date(T0).toISOString(),
        threshold: 3,
        atThreshold: false,
      })),
      autoPauseLoopRoutine,
      zeroToolThreshold: 3,
    });

    expect(res.rearmed).toBe(1);
    expect(autoPauseLoopRoutine).not.toHaveBeenCalled();
    expect(recordFire).toHaveBeenCalledWith(
      'papercusp',
      'loop-su-zero-tool',
      expect.stringContaining('lifecycle'),
      'ok',
    );
  });

  it('preserves a native Codex usage-limit cause and routes the fire through lifecycle recovery', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const escalateLifecycleDeath = vi.fn(async () => {});
    const error = {
      source: 'event_msg:error' as const,
      code: 'usage_limit_exceeded',
      rawCode: 'usageLimitExceeded',
      message: 'Try again at Oct 3rd, 2026 5:30 PM.',
      retryAt: 'Oct 3rd, 2026 5:30 PM',
      account: null,
      timestamp: '2026-09-30T00:00:00Z',
      turnKey: 'turn-1',
    };
    const res = await reconcileLoopRoutines({
      sql: fakeSql([settledRow({ codex_adv_session_id: 30858 })], updates),
      nowMs: Date.parse('2026-09-30T00:01:00Z'),
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      countAgentToolCallsInWindow: vi.fn(async () => 0),
      readCodexProviderErrorAfter: vi.fn(async (sessionKey, afterMs) => {
        expect(sessionKey).toBe(30858);
        expect(afterMs).toBe(T0);
        return error;
      }),
      recordZeroToolFireObservation: vi.fn(async () => ({
        counted: true,
        streak: 1,
        toolCalls: 0,
        fireToken: new Date(T0).toISOString(),
        threshold: 3,
        atThreshold: false,
      })),
      escalateLifecycleDeath,
    });

    expect(res.rearmed).toBe(1);
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-zero-tool', 'loop-lifecycle-death:usage_limit', 'error');
    expect(escalateLifecycleDeath).toHaveBeenCalledWith(expect.objectContaining({
      verdict: expect.objectContaining({
        reason: 'usage_limit',
        evidence: expect.stringContaining('usage_limit_exceeded'),
      }),
    }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("provider kill ('usage_limit')"));
  });

  it.each([
    {
      code: 'server_overloaded',
      rawCode: 'server_overloaded',
      message: 'Selected model is at capacity. Please try a different model.',
    },
    {
      code: 'provider_error',
      rawCode: 'provider_error',
      message: 'upstream provider admission failed (401)',
    },
  ])('routes native Codex $code through lifecycle recovery instead of a healthy settle', async ({ code, rawCode, message }) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const escalateLifecycleDeath = vi.fn(async () => {});
    const error = {
      source: 'event_msg:task_complete' as const,
      code,
      rawCode,
      message,
      retryAt: null,
      account: null,
      timestamp: '2026-09-30T00:00:00Z',
      turnKey: 'turn-native-provider',
    };
    const res = await reconcileLoopRoutines({
      sql: fakeSql([settledRow({ codex_adv_session_id: 30858 })], updates),
      nowMs: T0 + 10_000,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      countAgentToolCallsInWindow: vi.fn(async () => 0),
      readCodexProviderErrorAfter: vi.fn(async () => error),
      recordZeroToolFireObservation: vi.fn(async () => ({
        counted: true,
        streak: 1,
        toolCalls: 0,
        fireToken: new Date(T0).toISOString(),
        threshold: 3,
        atThreshold: false,
      })),
      escalateLifecycleDeath,
    });

    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ id: 'rt-zero-tool', via: 'lifecycle' });
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-zero-tool', 'loop-lifecycle-death:model_error', 'error');
    expect(escalateLifecycleDeath).toHaveBeenCalledWith(expect.objectContaining({
      verdict: expect.objectContaining({
        reason: 'model_error',
        evidence: expect.stringContaining(`code=${code}`),
      }),
    }));
  });

  it('includes the native Codex usage-limit code in the existing R4 pause alert', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const autoPauseLoopRoutine = vi.fn(async () => {});
    const cancelInboxWake = vi.fn(async () => 1);
    const escalateDeadLoop = vi.fn(async () => {});
    const error = {
      source: 'event_msg:error' as const,
      code: 'usage_limit_exceeded',
      rawCode: 'usageLimitExceeded',
      message: null,
      retryAt: null,
      account: null,
      timestamp: '2026-09-30T00:00:00Z',
      turnKey: 'turn-1',
    };
    await reconcileLoopRoutines({
      sql: fakeSql([settledRow({ codex_adv_session_id: 30858 })], updates),
      nowMs: T0 + 10_000,
      recordFire: vi.fn(async () => {}),
      readFireState: NO_PRIOR_ERRORS,
      countAgentToolCallsInWindow: vi.fn(async () => 0),
      readCodexProviderErrorAfter: vi.fn(async () => error),
      recordZeroToolFireObservation: vi.fn(async () => ({
        counted: true,
        streak: 3,
        toolCalls: 0,
        fireToken: new Date(T0).toISOString(),
        threshold: 3,
        atThreshold: true,
      })),
      autoPauseLoopRoutine,
      cancelInboxWake,
      escalateDeadLoop,
      zeroToolThreshold: 3,
    });

    expect(autoPauseLoopRoutine).toHaveBeenCalledWith(
      expect.anything(),
      'rt-zero-tool',
      expect.stringContaining('native Codex event_msg:error reported code=usage_limit_exceeded'),
      'loop-zero-tool-escalation',
    );
    expect(cancelInboxWake).toHaveBeenCalledWith('su-zero-tool', 'ws-papercusp');
    expect(escalateDeadLoop).toHaveBeenCalledWith(expect.objectContaining({
      routineId: 'rt-zero-tool',
      targetOwnerId: 'su-zero-tool',
    }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('TERMINATED (auto-paused, not re-armed)'));
  });

  it('unavailable tool-call evidence fails open and preserves the existing re-arm', async () => {
    const updates: unknown[][] = [];
    const recordZeroToolFireObservation = vi.fn();
    const res = await reconcileLoopRoutines({
      sql: fakeSql([settledRow()], updates),
      nowMs: T0 + 10_000,
      recordFire: vi.fn(async () => {}),
      readFireState: NO_PRIOR_ERRORS,
      countAgentToolCallsInWindow: vi.fn(async () => null),
      recordZeroToolFireObservation,
    });

    expect(res.rearmed).toBe(1);
    expect(recordZeroToolFireObservation).not.toHaveBeenCalled();
  });
});

describe('reconcileLoopRoutines — circuit-open fast path (EI-7006)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  function parkedRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'rt-dead',
      target_owner_id: 'su-permanently-gone',
      interval_sec: 120, // stuckParkMs = max(30min, 4×120s=8min) = 30min
      parked: true,
      install_slug: 'papercusp',
      name: 'loop-su-gone',
      routine_workspace_id: 'ws-papercusp',
      last_fired_at: pgString(T0),
      lifecycle_completed_at: null,
      presence_last_active_at: null,
      ...overrides,
    };
  }

  it('PROPERTY (dead-owner terminates fast): a CIRCUIT-OPEN loop is routed to the guard BEFORE the stuck-park dwell elapses, and TERMINATES', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const sql = fakeSql([parkedRow()], updates);
    const recordFire = vi.fn(async () => {});
    const readFireState = vi.fn(async () => ({ lastFiredAt: null, consecutiveErrors: 12 })); // ≥8 → circuit OPEN
    const guard = vi.fn(async () => ({ breach: true, reason: 'dead-owner circuit-open, WI-1399 / EI-7006' }));

    // nowMs is only 2 min past the fire — WELL UNDER stuckParkMs(120s)=30min. The OLD code would
    // never consult the guard here (stuck-park branch not entered); the fix routes it via circuitOpen.
    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 2 * 60_000,
      recordFire,
      readFireState,
      checkUnreachableTerminalGuard: guard,
      cancelInboxWake: async () => 0, // WI-2339 D/E: hermetic no-ops (real defaults hit coord/PG)
      escalateDeadLoop: async () => {},
    });

    expect(res.terminated).toEqual([
      { id: 'rt-dead', targetOwnerId: 'su-permanently-gone', reason: 'dead-owner circuit-open, WI-1399 / EI-7006' },
    ]);
    expect(res.rearmed).toBe(0);
    expect(updates).toHaveLength(0); // never re-armed — the guard's own autoPause deactivated it
    // Routed WITH the circuit-open flag + stuckFireCount == consecutiveErrors (NOT +1).
    expect(guard).toHaveBeenCalledWith(expect.objectContaining({ circuitOpen: true, stuckFireCount: 12 }));
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-gone', 'loop-terminal-unreachable', 'error');
  });

  it('a CIRCUIT-OPEN but still-REACHABLE loop (guard declines) is neither terminated nor re-armed — the fire-gate owns cadence', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const sql = fakeSql([parkedRow()], updates);
    const recordFire = vi.fn(async () => {});
    const readFireState = vi.fn(async () => ({ lastFiredAt: null, consecutiveErrors: 12 }));
    const guard = vi.fn(async () => ({ breach: false })); // reachable → guard declines

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 2 * 60_000, // under the stuck-park dwell
      recordFire,
      readFireState,
      checkUnreachableTerminalGuard: guard,
    });

    expect(res.terminated).toEqual([]);
    expect(res.rearmed).toBe(0); // NOT stuck-park-elapsed → NOT re-armed (don't fight the circuit backoff)
    expect(updates).toHaveLength(0);
    expect(recordFire).not.toHaveBeenCalled(); // no error recorded — left to the fire-gate
    expect(guard).toHaveBeenCalledWith(expect.objectContaining({ circuitOpen: true }));
  });

  it('PROPERTY (healthy long turn NEVER terminates): a loop with activity AFTER the fire — even past the stuck-park dwell — is skipped for free (guard + fire-state never consulted)', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    // Would be circuit-open (99≥8) and would breach IF consulted — proving the pre-filter, not the guard, protects it.
    const readFireState = vi.fn(async () => ({ lastFiredAt: null, consecutiveErrors: 99 }));
    const guard = vi.fn(async () => ({ breach: true, reason: 'should-not-be-called' }));
    // Active 40min AFTER the fire (past the 30min dwell); nowMs only 30s later, so NOT presence-quiescent yet.
    const sql = fakeSql([parkedRow({ presence_last_active_at: pgString(T0 + 40 * 60_000) })], updates);

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 40 * 60_000 + 30_000,
      recordFire,
      readFireState,
      checkUnreachableTerminalGuard: guard,
    });

    expect(res.terminated).toEqual([]);
    expect(res.rearmed).toBe(0);
    expect(guard).not.toHaveBeenCalled(); // never consulted — the loop looks alive
    expect(readFireState).not.toHaveBeenCalled(); // cheap pre-filter: no fire-state read for a live loop
    expect(recordFire).not.toHaveBeenCalled();
  });

  it('a stuck-park loop that is ALSO circuit-open still terminates (both triggers true, circuitOpen wins the fast path)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const sql = fakeSql([parkedRow()], updates);
    const recordFire = vi.fn(async () => {});
    const readFireState = vi.fn(async () => ({ lastFiredAt: null, consecutiveErrors: 40 }));
    const guard = vi.fn(async () => ({ breach: true, reason: 'dead-owner, EI-7006' }));

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 31 * 60_000, // BOTH stuck-park-elapsed AND circuit-open
      recordFire,
      readFireState,
      checkUnreachableTerminalGuard: guard,
      cancelInboxWake: async () => 0, // WI-2339 D/E: hermetic no-ops (real defaults hit coord/PG)
      escalateDeadLoop: async () => {},
    });

    expect(res.terminated).toHaveLength(1);
    expect(res.rearmed).toBe(0);
    // circuit-open takes precedence → stuckFireCount is the raw streak (40), not streak+1.
    expect(guard).toHaveBeenCalledWith(expect.objectContaining({ circuitOpen: true, stuckFireCount: 40 }));
  });
});

describe('reconcileLoopRoutines — WI-2714 quick-retry leg (recover-then-escalate, not escalate-only)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  function parkedRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'rt-parked',
      target_owner_id: 'su-parked',
      interval_sec: 60, // quickRetryParkMs = max(10min, 3×60s=3min) = 10min; stuckParkMs = max(30min,4×60s) = 30min
      parked: true,
      install_slug: 'papercusp',
      name: 'loop-su-parked',
      routine_workspace_id: 'ws-papercusp',
      last_fired_at: pgString(T0),
      lifecycle_completed_at: null,
      presence_last_active_at: null,
      ...overrides,
    };
  }

  it('EI-21549554609576994: retries promptly when the routine claim parked but fire dispatch never started', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [
        parkedRow({
          carry: 'cold',
          // claimDueRoutine stamped routines.last_fired_at at T0, but neither the
          // fire-state writer nor the routine-scoped wake ledger advanced for this claim.
          fire_state_last_fired_at: pgString(T0 - 60_000),
          fire_state_last_withheld_at: null,
          last_wake_at: pgString(T0 - 60_000),
        }),
      ],
      updates,
    );
    const recordFire = vi.fn(async () => {});
    const guard = vi.fn(async () => ({ breach: true, reason: 'must-not-run-inside-dispatch-grace' }));

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 2 * 60_000,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: guard,
    });

    expect(res.rearmed).toBe(1);
    expect(res.terminated).toEqual([]);
    expect(res.loops[0]).toMatchObject({ id: 'rt-parked', via: 'claim-dispatch-gap' });
    expect(res.loops[0].nextFireAt).toBe(T0 + 2 * 60_000 + 60_000);
    expect(guard).not.toHaveBeenCalled();
    expect(recordFire).toHaveBeenCalledWith(
      'papercusp',
      'loop-su-parked',
      'loop-claim-dispatch-gap',
      'error',
    );
  });

  it('EI-21549554609576994: a started, withheld, delivered, active, or still-in-grace claim is not a dispatch gap', async () => {
    const controls = [
      { fire_state_last_fired_at: pgString(T0 + 1) },
      { fire_state_last_withheld_at: pgString(T0 + 1) },
      { last_wake_at: pgString(T0 + 1) },
      { presence_last_active_at: pgString(T0 + 1) },
    ];

    for (const control of controls) {
      const updates: unknown[][] = [];
      const res = await reconcileLoopRoutines({
        sql: fakeSql(
          [
            parkedRow({
              carry: 'cold',
              fire_state_last_fired_at: pgString(T0 - 60_000),
              fire_state_last_withheld_at: null,
              last_wake_at: pgString(T0 - 60_000),
              ...control,
            }),
          ],
          updates,
        ),
        nowMs: T0 + 2 * 60_000,
        recordFire: vi.fn(async () => {}),
        readFireState: NO_PRIOR_ERRORS,
      });
      expect(res.rearmed).toBe(0);
      expect(updates).toHaveLength(0);
    }

    const withinGraceUpdates: unknown[][] = [];
    const withinGrace = await reconcileLoopRoutines({
      sql: fakeSql(
        [
          parkedRow({
            carry: 'cold',
            fire_state_last_fired_at: pgString(T0 - 60_000),
            fire_state_last_withheld_at: null,
            last_wake_at: pgString(T0 - 60_000),
          }),
        ],
        withinGraceUpdates,
      ),
      nowMs: T0 + 2 * 60_000 - 1,
      recordFire: vi.fn(async () => {}),
      readFireState: NO_PRIOR_ERRORS,
    });
    expect(withinGrace.rearmed).toBe(0);
    expect(withinGraceUpdates).toHaveLength(0);
  });

  it('a quiet-parked, REACHABLE loop retries EARLY (10min, well before the classic 30min dwell) when under the attempt cap', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const sql = fakeSql([parkedRow()], updates);
    const recordFire = vi.fn(async () => {});
    const readFireState = vi.fn(async () => ({ lastFiredAt: null, consecutiveErrors: 0 })); // first attempt
    const guard = vi.fn(async () => ({ breach: true, reason: 'should-not-be-called-this-early' }));

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 10 * 60_000, // exactly the quick-retry floor, WELL under the 30min classic dwell
      recordFire,
      readFireState,
      checkUnreachableTerminalGuard: guard,
    });

    expect(res.rearmed).toBe(1);
    expect(res.terminated).toEqual([]);
    expect(res.loops[0]).toMatchObject({ id: 'rt-parked', via: 'stuck-backstop', quickRetry: true });
    // The terminal guard must NEVER be consulted this early — quick-retry only ever attempts
    // another wake, never a pause (the dwell + reachability veto for TERMINATION is untouched).
    expect(guard).not.toHaveBeenCalled();
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-parked', expect.stringContaining('stuck-backstop'), 'error');
  });

  it('does NOT quick-retry before the quick-retry floor — a loop parked only 5min is left untouched', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const readFireState = vi.fn(async () => ({ lastFiredAt: null, consecutiveErrors: 0 }));
    const sql = fakeSql([parkedRow()], updates);

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 5 * 60_000, // under BOTH the quick-retry floor (10min) and the classic dwell
      recordFire,
      readFireState,
    });

    expect(res.rearmed).toBe(0);
    expect(updates).toHaveLength(0);
    expect(recordFire).not.toHaveBeenCalled();
  });

  it('quick-retry is BOUNDED — once consecutiveErrors reaches the attempt cap (3), it stops firing early and falls back to needing the classic dwell', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    // 3 prior quick-retry attempts already recorded — at the cap, so quick-retry is no longer eligible.
    const readFireState = vi.fn(async () => ({ lastFiredAt: null, consecutiveErrors: 3 }));
    const sql = fakeSql([parkedRow()], updates);

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 10 * 60_000, // past the quick-retry floor, but still WELL under the classic 30min dwell
      recordFire,
      readFireState,
    });

    expect(res.rearmed).toBe(0); // exhausted quick-retry, not yet at the classic dwell → left untouched
    expect(updates).toHaveLength(0);
    expect(recordFire).not.toHaveBeenCalled();
  });

  it('once past the classic dwell, behaves exactly as the pre-existing stuck-backstop path (quickRetry NOT flagged)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const sql = fakeSql([parkedRow()], updates);
    const recordFire = vi.fn(async () => {});
    const readFireState = vi.fn(async () => ({ lastFiredAt: null, consecutiveErrors: 0 }));
    const guard = vi.fn(async () => ({ breach: false }));

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 31 * 60_000, // past the classic 30min dwell
      recordFire,
      readFireState,
      checkUnreachableTerminalGuard: guard,
    });

    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ id: 'rt-parked', via: 'stuck-backstop' });
    expect(res.loops[0].quickRetry).toBeUndefined();
    expect(guard).toHaveBeenCalled(); // classic path DOES consult the terminal guard
  });

  it('a CIRCUIT-OPEN loop is never quick-retried early — routed to the terminal-guard fast path instead (no fight with the circuit backoff)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const sql = fakeSql([parkedRow()], updates);
    const recordFire = vi.fn(async () => {});
    const readFireState = vi.fn(async () => ({ lastFiredAt: null, consecutiveErrors: 12 })); // ≥8 → circuit OPEN
    const guard = vi.fn(async () => ({ breach: false }));

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 10 * 60_000, // past the quick-retry floor
      recordFire,
      readFireState,
      checkUnreachableTerminalGuard: guard,
    });

    // circuitOpen routes to the (declined) terminal-guard fast path, same as EI-7006 — never the
    // quick-retry leg (quick-retry explicitly excludes circuitOpen so it never fights the backoff).
    expect(guard).toHaveBeenCalledWith(expect.objectContaining({ circuitOpen: true }));
    expect(res.rearmed).toBe(0); // guard declined AND not stuck-park-elapsed yet → left untouched
  });

  it('a HEALTHY (active-since-fire) loop is never quick-retried — the pre-filter protects it exactly as before', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const readFireState = vi.fn(async () => ({ lastFiredAt: null, consecutiveErrors: 0 }));
    // GENUINELY still-active: last activity 30s ago — inside FALLBACK_QUIET_MS (60s), so the
    // presence-quiescence settle path does NOT fire (that would legitimately re-arm a
    // worked-then-quiet turn, a DIFFERENT leg). completionSignal → null, so we actually reach the
    // quick-retry pre-filter, whose `presence_last_active_at > last_fired` test leaves this healthy
    // loop untouched. (A +9min/+10min fixture is 60s-quiet = exactly settled → re-arms via
    // presence-quiescence, which is NOT what this test means to assert.)
    const sql = fakeSql([parkedRow({ presence_last_active_at: pgString(T0 + 10 * 60_000 - 30_000) })], updates); // active 30s ago
    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 10 * 60_000, // past the quick-retry floor, but presence shows genuine post-fire activity
      recordFire,
      readFireState,
    });
    expect(res.rearmed).toBe(0);
    expect(recordFire).not.toHaveBeenCalled();
  });

  it('PAPERCUSP_LOOP_QUICK_RETRY_MAX_ATTEMPTS<=0 disables the quick-retry leg entirely (fail-soft to today\'s behavior)', async () => {
    const prev = process.env.PAPERCUSP_LOOP_QUICK_RETRY_MAX_ATTEMPTS;
    process.env.PAPERCUSP_LOOP_QUICK_RETRY_MAX_ATTEMPTS = '0';
    try {
      const updates: unknown[][] = [];
      const recordFire = vi.fn(async () => {});
      const readFireState = vi.fn(async () => ({ lastFiredAt: null, consecutiveErrors: 0 }));
      const sql = fakeSql([parkedRow()], updates);
      const res = await reconcileLoopRoutines({
        sql,
        nowMs: T0 + 10 * 60_000, // past the quick-retry floor — would have retried if enabled
        recordFire,
        readFireState,
      });
      expect(res.rearmed).toBe(0);
      expect(recordFire).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_LOOP_QUICK_RETRY_MAX_ATTEMPTS;
      else process.env.PAPERCUSP_LOOP_QUICK_RETRY_MAX_ATTEMPTS = prev;
    }
  });
});

describe('reconcileLoopRoutines — ARMED-loop reachability sweep (EI-11407)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');
  const TERMINAL_WINDOW_MS = 2 * 3600_000; // DEFAULT_TERMINAL_UNREACHABLE_MS (60s interval floors to this)

  /** An ARMED (not parked, not cron) pure loop that has already fired + settled once. */
  function armedRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'rt-armed',
      target_owner_id: 'su-armed-owner',
      interval_sec: 60,
      parked: false,
      is_cron: false,
      install_slug: 'papercusp',
      name: 'loop-su-armed',
      routine_workspace_id: 'ws-papercusp',
      last_fired_at: pgString(T0),
      lifecycle_completed_at: null,
      lifecycle_started_at: null,
      presence_last_active_at: null,
      ...overrides,
    };
  }

  it('an ARMED loop well within the terminal window is left alone — the guard is never even consulted', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const guard = vi.fn(async () => ({ breach: true, reason: 'should-not-be-called' }));
    const sql = fakeSql([armedRow()], updates);

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 3600_000, // 1h — under the 2h terminal window
      recordFire,
      checkUnreachableTerminalGuard: guard,
    });

    expect(guard).not.toHaveBeenCalled();
    expect(res.terminated).toEqual([]);
    expect(res.rearmed).toBe(0); // an armed loop is never rebased — nothing to fold
    expect(updates).toHaveLength(0);
  });

  it('an ARMED loop past the terminal window with an UNREACHABLE owner is TERMINATED (not re-armed) — full WI-2339 D+E side effects fire', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const cancelInboxWake = vi.fn(async () => 1);
    const escalateDeadLoop = vi.fn(async () => {});
    const guard = vi.fn(async () => ({ breach: true, reason: 'dead-owner: unreachable (armed, EI-11407)' }));
    const sql = fakeSql([armedRow()], updates);

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + TERMINAL_WINDOW_MS + 1_000, // just past the 2h terminal window
      recordFire,
      checkUnreachableTerminalGuard: guard,
      cancelInboxWake,
      escalateDeadLoop,
    });

    expect(res.terminated).toEqual([
      { id: 'rt-armed', targetOwnerId: 'su-armed-owner', reason: 'dead-owner: unreachable (armed, EI-11407)' },
    ]);
    expect(res.rearmed).toBe(0);
    expect(updates).toHaveLength(0); // no rebase UPDATE — the guard's autoPause deactivated it directly
    // The guard's fire-count floor is pre-satisfied (no discrete fire-attempt streak exists for
    // an armed loop) and circuitOpen is always false on this leg.
    expect(guard).toHaveBeenCalledWith(
      expect.objectContaining({ routineId: 'rt-armed', targetOwnerId: 'su-armed-owner', circuitOpen: false }),
    );
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-armed', 'loop-terminal-unreachable', 'error');
    expect(cancelInboxWake).toHaveBeenCalledWith('su-armed-owner', 'ws-papercusp');
    expect(escalateDeadLoop).toHaveBeenCalledWith(
      expect.objectContaining({ routineId: 'rt-armed', targetOwnerId: 'su-armed-owner' }),
    );
  });

  it('an ARMED loop past the terminal window whose owner IS reachable is left armed (guard declines, no termination, no rearm)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const guard = vi.fn(async () => ({ breach: false }));
    const sql = fakeSql([armedRow()], updates);

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + TERMINAL_WINDOW_MS + 1_000,
      recordFire,
      checkUnreachableTerminalGuard: guard,
    });

    expect(guard).toHaveBeenCalled();
    expect(res.terminated).toEqual([]);
    expect(res.rearmed).toBe(0); // armed loops are never rebased by this sweep regardless
    expect(recordFire).not.toHaveBeenCalled();
  });

  it('dwell is measured from the LATEST known-alive evidence — recent presence activity after the fire resets the clock', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const guard = vi.fn(async () => ({ breach: true, reason: 'should-not-be-called-yet' }));
    // Activity 30min after the fire — the real dwell floor is THIS, not last_fired_at.
    const sql = fakeSql([armedRow({ presence_last_active_at: pgString(T0 + 1800_000) })], updates);

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 1800_000 + TERMINAL_WINDOW_MS - 1_000, // just under 2h since the LATEST activity
      recordFire,
      checkUnreachableTerminalGuard: guard,
    });

    expect(guard).not.toHaveBeenCalled(); // still within the window measured from the later timestamp
    expect(res.terminated).toEqual([]);
  });

  it('an armed CRON+loop is UNCHANGED by this sweep — is_cron:true skips the new branch entirely', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const guard = vi.fn(async () => ({ breach: true, reason: 'should-not-be-called-for-cron' }));
    const sql = fakeSql([armedRow({ is_cron: true })], updates);

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + TERMINAL_WINDOW_MS + 1_000, // well past the window — would trip the armed-pure-loop leg
      recordFire,
      checkUnreachableTerminalGuard: guard,
    });

    // Falls through to the pre-existing cron+loop handling: no completion signal and not parked
    // → looksDeadOrStuck is false (parked required) → skipped exactly as before this change.
    expect(guard).not.toHaveBeenCalled();
    expect(res.terminated).toEqual([]);
    expect(res.rearmed).toBe(0);
  });

  it('a guard failure on the armed-loop sweep is fail-soft — the loop is left armed, never throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const guard = vi.fn(async () => {
      throw new Error('probe read failed');
    });
    const sql = fakeSql([armedRow()], updates);

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + TERMINAL_WINDOW_MS + 1_000,
      recordFire,
      checkUnreachableTerminalGuard: guard,
    });

    expect(res.terminated).toEqual([]);
    expect(res.rearmed).toBe(0);
  });

  it('an armed pure loop resets a stale fire-error streak from its strict loop-origin completion', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const readFireState = vi.fn(async () => ({
      lastFiredAt: new Date(T0 + 1_000),
      consecutiveErrors: 7,
    }));
    const sql = fakeSql(
      [
        armedRow({
          fire_state_last_fired_at: pgString(T0 + 1_000),
          fire_state_last_withheld_at: null,
          last_wake_at: null,
          last_loop_turn_at: pgString(T0 + 5_000),
        }),
      ],
      updates,
    );

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 10_000,
      recordFire,
      readFireState,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });

    expect(res.rearmed).toBe(0);
    expect(res.terminated).toEqual([]);
    expect(readFireState).toHaveBeenCalledWith('papercusp', 'loop-su-armed');
    expect(recordFire).toHaveBeenCalledTimes(1);
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-armed', 'loop-armed-settle', 'ok');
  });

  it('does not re-record an armed settle after the fire-state watermark already covers the loop turn', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const readFireState = vi.fn(async () => ({
      lastFiredAt: new Date(T0 + 6_000),
      consecutiveErrors: 7,
    }));
    const sql = fakeSql(
      [
        armedRow({
          fire_state_last_fired_at: pgString(T0 + 6_000),
          fire_state_last_withheld_at: null,
          last_wake_at: null,
          last_loop_turn_at: pgString(T0 + 5_000),
        }),
      ],
      updates,
    );

    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 10_000,
      recordFire,
      readFireState,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });

    expect(res.rearmed).toBe(0);
    expect(readFireState).not.toHaveBeenCalled();
    expect(recordFire).not.toHaveBeenCalled();
  });
});

/**
 * EI-18668025239634541 — recurrence guard for the loop-lifecycle-death escalation leak.
 *
 * ROOT CAUSE: `defaultEscalateLifecycleDeath` called `openEscalation` with NO conditionKey,
 * so dedup fell back to the prose SUMMARY — which embedded `~${mins}m`, a value that backs
 * off between occurrences (`rearmDelayMs`) and therefore never repeats even for the SAME
 * loop. Every reconcile pass over a loop stuck on a provider wall leaked a fresh
 * permanently-open escalation row instead of bumping repeatCount on one (measured: 10
 * leaked rows / 10 occurrences / 2.5h, 1.0x coalescing — vs 4.8x coalescing everywhere a
 * conditionKey IS supplied).
 *
 * A summary-equality assertion would NOT have caught this (the whole point of the bug is
 * that the summary DIFFERS across occurrences) — this asserts on the actual dedup key
 * (`meta.subjectSignature`) the fix introduces, exactly as the item requested.
 */
describe('defaultEscalateLifecycleDeath — stable conditionKey (EI-18668025239634541)', () => {
  const baseInfo = {
    routineId: 'rt-42',
    targetOwnerId: 'su-test',
    installSlug: 'papercusp',
    name: 'loop-su-test',
  };

  it('passes an IDENTICAL non-empty conditionKey across two calls with DIFFERENT rearmDelayMs', async () => {
    const mockOpenEscalation = vi.mocked(openEscalation);
    mockOpenEscalation.mockClear();

    await defaultEscalateLifecycleDeath({
      ...baseInfo,
      verdict: { reason: 'usage_limit', evidence: 'e1', rearmDelayMs: 5 * 60_000 },
    });
    await defaultEscalateLifecycleDeath({
      ...baseInfo,
      verdict: { reason: 'usage_limit', evidence: 'e2', rearmDelayMs: 47 * 60_000 },
    });

    expect(mockOpenEscalation).toHaveBeenCalledTimes(2);
    const call1 = mockOpenEscalation.mock.calls[0]?.[1] as { meta?: { subjectSignature?: string } };
    const call2 = mockOpenEscalation.mock.calls[1]?.[1] as { meta?: { subjectSignature?: string } };
    const key1 = call1?.meta?.subjectSignature;
    const key2 = call2?.meta?.subjectSignature;

    expect(key1).toBeTruthy();
    expect(key2).toBeTruthy();
    expect(key1).toBe(key2); // THE regression this guards: must NOT vary with rearmDelayMs/mins.
  });

  it('keys the conditionKey on the loop identity (installSlug + routineId), distinguishing different loops', async () => {
    const mockOpenEscalation = vi.mocked(openEscalation);
    mockOpenEscalation.mockClear();

    await defaultEscalateLifecycleDeath({
      ...baseInfo,
      routineId: 'rt-A',
      verdict: { reason: 'usage_limit', evidence: 'e', rearmDelayMs: 60_000 },
    });
    await defaultEscalateLifecycleDeath({
      ...baseInfo,
      routineId: 'rt-B',
      verdict: { reason: 'usage_limit', evidence: 'e', rearmDelayMs: 60_000 },
    });

    const keyA = (mockOpenEscalation.mock.calls[0]?.[1] as { meta?: { subjectSignature?: string } })?.meta
      ?.subjectSignature;
    const keyB = (mockOpenEscalation.mock.calls[1]?.[1] as { meta?: { subjectSignature?: string } })?.meta
      ?.subjectSignature;
    expect(keyA).toBeTruthy();
    expect(keyB).toBeTruthy();
    expect(keyA).not.toBe(keyB);
  });

  it('the summary itself no longer embeds the volatile duration (defense in depth for the dedup fallback)', async () => {
    const mockOpenEscalation = vi.mocked(openEscalation);
    mockOpenEscalation.mockClear();

    await defaultEscalateLifecycleDeath({
      ...baseInfo,
      verdict: { reason: 'usage_limit', evidence: 'e', rearmDelayMs: 33 * 60_000 },
    });

    const input = mockOpenEscalation.mock.calls[0]?.[1] as { summary: string; body: string };
    expect(input.summary).not.toMatch(/~?\d+m/); // no minutes count in the dedup-relevant summary
    expect(input.body).toMatch(/~33m/); // the detail still lives in body, just not in summary
  });
});

describe('reconcileLoopRoutines — presence-quiescence defers behind the session_turns ingest watermark (WI-6852)', () => {
  const T0 = 1_782_000_000_000;
  const QUIET = 70_000; // > FALLBACK_QUIET_MS (60s)

  /** A warm loop that settles ONLY via presence-quiescence: no lifecycle marker, no turn journal. */
  const quiescentRow = (over: Record<string, unknown> = {}) => ({
    id: 'rt-1',
    target_owner_id: 'su-test',
    interval_sec: 900,
    parked: true,
    install_slug: 'papercusp',
    name: 'loop-su-test',
    routine_workspace_id: 'ws-papercusp',
    last_fired_at: new Date(T0),
    lifecycle_completed_at: null,
    turn_journal_completed_at: null,
    presence_last_active_at: new Date(T0 + 4_000),
    last_assistant_text_after_fire: null,
    ...over,
  });

  it('DEFERS the settle while the ingest watermark is BEHIND the quiet instant (the live 02:58 fire-into-a-wall repro)', async () => {
    const updates: unknown[][] = [];
    // The owner IS ingested (watermark present) but the ingest has not yet reached the final
    // beat, so a null assistant text is a LAG artifact — not evidence the turn ended cleanly.
    const sql = fakeSql([quiescentRow({ turns_ingest_watermark: new Date(T0 - 30_000) })], updates);
    const res = await reconcile({ sql, nowMs: T0 + QUIET, readFireState: NO_PRIOR_ERRORS });
    expect(res.rearmed).toBe(0);
    expect(updates).toHaveLength(0); // stayed parked — no bare-interval re-arm into the wall
  });

  it('SETTLES normally once the watermark has REACHED the quiet instant (the absence is then real)', async () => {
    const updates: unknown[][] = [];
    const sql = fakeSql([quiescentRow({ turns_ingest_watermark: new Date(T0 + 4_000) })], updates);
    const res = await reconcile({ sql, nowMs: T0 + QUIET, readFireState: NO_PRIOR_ERRORS });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('presence-quiescence');
  });

  it('does NOT defer when the owner has NO indexed turns at all — deferring needs positive evidence of lag, so this population keeps today behavior', async () => {
    const updates: unknown[][] = [];
    const sql = fakeSql([quiescentRow({ turns_ingest_watermark: null })], updates);
    const res = await reconcile({ sql, nowMs: T0 + QUIET, readFireState: NO_PRIOR_ERRORS });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('presence-quiescence');
  });

  it('does NOT defer when the assistant text IS present — a lagging watermark is irrelevant once the evidence itself has landed', async () => {
    const updates: unknown[][] = [];
    const sql = fakeSql(
      [
        quiescentRow({
          last_assistant_text_after_fire: 'ordinary turn text',
          turns_ingest_watermark: new Date(T0 - 30_000),
        }),
      ],
      updates,
    );
    const res = await reconcile({ sql, nowMs: T0 + QUIET, readFireState: NO_PRIOR_ERRORS });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('presence-quiescence');
  });

  it('a deferred loop is NOT wedged — the layer-3 stuck-park backstop still re-arms it at its dwell floor', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const updates: unknown[][] = [];
    // Same lagging-watermark row (so completionSignal keeps DEFERRING), now just past the
    // stuck-park dwell — stuckBackstopCadenceMs = max(default, interval*4) = 60min at 900s — so
    // the layer-3 backstop takes over. This is the safety property the defer rests on: the worst
    // case of deferring is a LATE settle, never a permanently parked loop.
    // The terminal guard is injected non-breaching so this asserts the RE-ARM, not the
    // dead-owner termination decision (which is a separate path with its own tests above).
    const sql = fakeSql([quiescentRow({ turns_ingest_watermark: new Date(T0 - 30_000) })], updates);
    const res = await reconcile({
      sql,
      nowMs: T0 + 61 * 60_000,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: async () => ({ breach: false }),
    });
    expect(res.terminated).toEqual([]);
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('stuck-backstop');
  });
});

describe('reconcileLoopRoutines — a usage-limit re-arm may push next_fire_at LATER (WI-6852)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  /** Like `fakeSql`, but records the STATEMENT TEXT. That is the only way to tell the two re-arm
   *  branches apart: they differ in SQL SHAPE (GREATEST + a `next_fire_at <` guard vs LEAST + a
   *  `next_fire_at >` one), not in their bind values, so the shared `updates` capture cannot see it. */
  function fakeSqlCapturingText(rows: Record<string, unknown>[], statements: string[], bindings: unknown[][]): Sql {
    return ((strings: TemplateStringsArray, ...vals: unknown[]) => {
      const q = strings.join(' ? ');
      if (/^\s*UPDATE/i.test(q)) {
        statements.push(q);
        bindings.push(vals);
        return Promise.resolve([{ id: 'rt-1' }]);
      }
      return Promise.resolve(rows);
    }) as unknown as Sql;
  }

  const walledRow = (text: string, intervalSec: number) => ({
    id: 'rt-1',
    target_owner_id: 'su-walled',
    interval_sec: intervalSec,
    parked: true,
    install_slug: 'papercusp',
    name: 'loop-su-walled',
    routine_workspace_id: 'ws-papercusp',
    last_fired_at: pgString(T0),
    lifecycle_completed_at: pgString(T0 + 5_000),
    presence_last_active_at: null,
    last_assistant_text_after_fire: text,
  });

  const run = async (text: string, intervalSec: number) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {}); // expected diagnostic log
    const statements: string[] = [];
    const bindings: unknown[][] = [];
    const sql = fakeSqlCapturingText([walledRow(text, intervalSec)], statements, bindings);
    const res = await reconcileLoopRoutines({
      sql,
      nowMs: T0 + 10_000,
      recordFire: vi.fn(async () => {}),
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
      escalateLifecycleDeath: vi.fn(async () => {}),
    });
    const armStmt = statements.find((s) => /UPDATE\s+harness_shared\.routines/i.test(s));
    return { res, armStmt, bindings };
  };

  it('uses the never-EARLIER (GREATEST) statement for a reset-aware usage_limit death', async () => {
    const { res, armStmt, bindings } = await run("You've hit your session limit · resets in 3 hours", 180);
    expect(res.rearmed).toBe(1);
    expect(armStmt).toBeDefined();
    // The whole defect: the ordinary statement is never-later BY CONSTRUCTION, so a blind re-arm
    // that had already set next_fire_at = now+interval made this wall-aware re-arm a silent no-op.
    expect(armStmt).toContain('GREATEST');
    expect(armStmt).toContain('next_fire_at < ');
    expect(armStmt).toContain('providerRetrySchedule');
    expect(armStmt).not.toContain('LEAST');
    // ...and the deferral must preserve the reset instant parsed from nowMs, not completedAt.
    expect(res.loops[0].nextFireAt).toBe(T0 + 10_000 + 3 * 3_600_000);
    const exactDeadline = new Date(res.loops[0].nextFireAt).toISOString();
    expect(bindings[0].filter((value) => value === exactDeadline).length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the ordinary never-LATER (LEAST) statement for a NON-usage_limit death', async () => {
    // The control that gives the assertion above its meaning: an auth_wall is still a lifecycle
    // DEATH (same code path, same escalation) — only usage_limit carries a reset instant worth
    // deferring to, so only usage_limit may push a loop's cadence out.
    const { res, armStmt } = await run(
      'Your organization has disabled Claude subscription access for Claude Code.',
      180,
    );
    expect(res.rearmed).toBe(1);
    expect(armStmt).toContain('LEAST');
    expect(armStmt).not.toContain('GREATEST');
  });

  it('keeps the ordinary statement when the parsed reset adds nothing beyond the interval', async () => {
    // interval 6h vs a 3h wall ⇒ rearmMs === intervalMs, so no reset-aware information survives
    // the interval floor and there is nothing to defer past.
    const { res, armStmt } = await run("You've hit your session limit · resets in 3 hours", 6 * 3600);
    expect(res.rearmed).toBe(1);
    expect(armStmt).toContain('LEAST');
    expect(armStmt).not.toContain('GREATEST');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WI-36792 — the gate-backoff re-arm leg.
//
// The defect these pin: a PURE LOOP is parked at next_fire_at='infinity' by
// claimDueRoutine at CLAIM time, before the fire runs. If the fire-gate then
// WITHHOLDS, no wake is sent, so no turn happens, so no completion-rebase ever
// re-arms it — and reconcile used to `continue` here on the premise that "the
// fire-gate owns its cadence". The gate cannot cause a claim, so for a parked
// loop nobody owns it: the loop is dead until a human re-arms it. Measured on a
// live session 2026-08-08: a 2h44m silent halt.
//
// FALSIFIABILITY (mutation-probe tier 1 — the subject is an imported module, so
// the controls live here permanently instead of mutating the shared tree): the
// two CONTROL cases below drive the same fixture through an ALLOWING gate and
// through a NON-parked row. If the production branch ever stops reading the gate
// verdict or the parked flag and re-arms unconditionally, those two red — while
// the positive cases stay green. A positive-only suite would pass against a
// branch that fired on every quiet-parked loop, which is the regression most
// worth catching here.
describe('reconcileLoopRoutines — gate-backoff re-arm for a parked loop (WI-36792)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  /** The quiet-parked fixture: fired, no completion marker, no post-fire activity —
   *  i.e. exactly the shape a withheld fire leaves behind. */
  const parkedRow = (over: Record<string, unknown> = {}) => ({
    id: 'rt-gate',
    target_owner_id: 'su-gated',
    interval_sec: 60,
    parked: true,
    install_slug: 'papercusp',
    name: 'loop-su-gated',
    routine_workspace_id: 'ws-papercusp',
    last_fired_at: pgString(T0),
    lifecycle_completed_at: null,
    presence_last_active_at: null,
    ...over,
  });

  /** The incident's real fire-state: 4 consecutive errors — BELOW circuitThreshold (8), so the
   *  circuit is not open; this is plain backoff.
   *  NOTE the two clocks are DIFFERENT columns in production — routines.last_fired_at (the park)
   *  vs autoloop_state.last_fired_at (the backoff clock, which a withhold deliberately does NOT
   *  advance). They sat 9s apart in the real incident. The fix consults the gate's own verdict
   *  rather than recomputing from the park time, which is why that skew is harmless; the fixture
   *  collapses them only for legibility. */
  const WITHHELD_STATE = vi.fn(async () => ({ lastFiredAt: new Date(T0), consecutiveErrors: 4 }));

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('re-arms a parked loop the REAL fire-gate is withholding, to the exact moment the backoff expires', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    // 26s after the park. Deliberately drives the REAL evaluateFireGate rather than a stub: this
    // is the calibration case that proves the wiring, so the number asserted below is the
    // production formula's own output, not a fixture asserting what it wishes were true.
    const res = await reconcile({
      sql: fakeSql([parkedRow()], updates),
      nowMs: T0 + 26_000,
      recordFire,
      readFireState: WITHHELD_STATE,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });

    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('gate-backoff');
    // backoff = base 60s * 2^(4-1) = 480s from the gate's clock; elapsed 26s ⇒ 454s remaining —
    // the exact `retry in ~454s` the live autoloop_state row recorded on 2026-08-08.
    expect(res.loops[0].nextFireAt).toBe(T0 + 480_000);
  });

  it("records NO fire outcome — an 'ok' would ERASE the streak the backoff is computed from", async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const countAgentToolCallsInWindow = vi.fn(async () => 0);
    await reconcile({
      sql: fakeSql([parkedRow()], updates),
      nowMs: T0 + 26_000,
      recordFire,
      readFireState: WITHHELD_STATE,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
      countAgentToolCallsInWindow,
    });
    // The asymmetry is load-bearing, not an oversight: this re-arm observed nothing about the
    // turn. 'ok' would reset consecutive_errors (the loop re-fires at once and reads as healthy);
    // 'error' would double-count a failure the fire path already recorded.
    expect(recordFire).not.toHaveBeenCalled();
    // WI-41228: a withheld fire dispatched NO turn, so it must not feed the zero-tool streak.
    expect(countAgentToolCallsInWindow).not.toHaveBeenCalled();
  });

  it('CONTROL — an ALLOWING gate re-arms nothing on this leg (proves the branch reads the verdict)', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql([parkedRow()], updates),
      nowMs: T0 + 26_000,
      recordFire,
      // A clean streak ⇒ the real gate ALLOWS ⇒ nothing is being withheld ⇒ nothing to rescue.
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    expect(res.rearmed).toBe(0);
    expect(recordFire).not.toHaveBeenCalled();
  });

  it('CONTROL — a NON-parked row (cron+loop with a live schedule) is never pulled sooner by this leg', async () => {
    const updates: unknown[][] = [];
    const res = await reconcile({
      sql: fakeSql([parkedRow({ parked: false })], updates),
      nowMs: T0 + 26_000,
      recordFire: async () => {},
      readFireState: WITHHELD_STATE,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    // A routine with a real future next_fire_at keeps being CLAIMED on schedule, so the gate
    // genuinely IS re-consulted for it — the premise that is false only for a parked loop.
    expect(res.loops.find((l) => l.via === 'gate-backoff')).toBeUndefined();
  });

  it('INCIDENT ANCHOR (2026-08-08) — the rescue lands BEFORE the stalled-loops-guard disarm that followed', async () => {
    const updates: unknown[][] = [];
    // Real timeline: park 21:54:31Z; gate withheld 21:54:40Z (consecutive_errors=4,
    // "retry in ~454s"); stalled-loops-guard disarmed the loop 22:07:36Z; owner re-armed by
    // hand at 23:05Z. Today's code re-armed at none of those points.
    const park = Date.parse('2026-08-08T21:54:31.403Z');
    const disarm = Date.parse('2026-08-08T22:07:36.000Z');
    const res = await reconcile({
      sql: fakeSql([parkedRow({ last_fired_at: pgString(park) })], updates),
      nowMs: park + 26_000,
      recordFire: async () => {},
      readFireState: vi.fn(async () => ({ lastFiredAt: new Date(park), consecutiveErrors: 4 })),
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    expect(res.loops[0].via).toBe('gate-backoff');
    // ~22:02:31Z — five minutes of margin. The loop wakes, produces a turn, and the ordinary
    // completion-rebase takes over, so the disarm never has a stalled loop to act on.
    expect(res.loops[0].nextFireAt).toBeLessThan(disarm);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// WI-2141029 (EI-22123519641932348) — the gate-backoff leg must NOT fire on a DISPATCHED turn.
//
// The defect these pin: the WI-36792 leg above rescues a claim the gate REFUSED. But a fire
// the gate ALLOWED looks identical for its first ~30s (no completion signal, presence not yet
// bumped, circuit still open from the prior streak), and re-arming it UN-PARKS the row — so
// when the turn settles the next tick takes the armed-loop `continue` and recordFire('ok')
// never runs. The streak never decays; a 60s loop fires hourly forever. Measured 2026-09-02
// on loop-su-a7410503: fire 04:41:33Z → 'gate-backoff' re-arm 04:42:04Z (to 05:41Z) → settle
// 04:45:08Z → consecutive_errors still 10, for ~4h across four fires.
//
// The discriminator is the dispatch clock the production SELECT already carries: loop-fire's
// recordFire('attempt') advances autoloop_state.last_fired_at to ≥ the claim's
// routines.last_fired_at; a withhold writes only last_withheld_at. The CONTROL case drives the
// identical row with the fired clock OLDER than the claim and must still take the WI-36792
// rescue — proving the branch reads the clock's VALUE, not merely the columns' presence.
describe('reconcileLoopRoutines — gate-backoff leg leaves a DISPATCHED in-flight turn parked (WI-2141029)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  /** Parked at the claim (T0); the fire went THROUGH 2s later (dispatch clock ≥ claim, wake
   *  sent); the turn has produced nothing observable yet — the first ~30s of a real turn. */
  const dispatchedRow = (over: Record<string, unknown> = {}) => ({
    id: 'rt-dispatched',
    target_owner_id: 'su-dispatched',
    interval_sec: 60,
    parked: true,
    install_slug: 'papercusp',
    name: 'loop-su-dispatched',
    routine_workspace_id: 'ws-papercusp',
    last_fired_at: pgString(T0),
    lifecycle_completed_at: null,
    presence_last_active_at: null,
    fire_state_last_fired_at: pgString(T0 + 2_000),
    fire_state_last_withheld_at: null,
    last_wake_at: pgString(T0 + 2_000),
    ...over,
  });

  /** The incident's fire-state: streak 10 (circuit OPEN, ≥ threshold 8) with the backoff clock
   *  just advanced by the dispatch — exactly what made the gate read 'backoff' again 30s later. */
  const OPEN_CIRCUIT_JUST_FIRED = vi.fn(async () => ({ lastFiredAt: new Date(T0 + 2_000), consecutiveErrors: 10 }));

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('does NOT re-arm via gate-backoff 26s into a dispatched turn — leaves it parked and records nothing', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql([dispatchedRow()], updates),
      nowMs: T0 + 26_000,
      recordFire,
      readFireState: OPEN_CIRCUIT_JUST_FIRED,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    expect(res.rearmed).toBe(0);
    expect(res.loops.find((l) => l.via === 'gate-backoff')).toBeUndefined();
    expect(recordFire).not.toHaveBeenCalled();
  });

  it("then the settle records 'ok' — the streak decays precisely because the row stayed parked to observe it", async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql([dispatchedRow({ lifecycle_completed_at: pgString(T0 + 200_000) })], updates),
      nowMs: T0 + 210_000,
      recordFire,
      readFireState: OPEN_CIRCUIT_JUST_FIRED,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('lifecycle');
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-dispatched', 'loop-lifecycle', 'ok');
  });

  it('CONTROL — the same row with the fired clock OLDER than the claim (a WITHHELD claim) still takes the WI-36792 rescue', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql(
        [
          dispatchedRow({
            // A withhold advances ONLY last_withheld_at; the fired clock and the wake stay older.
            fire_state_last_fired_at: pgString(T0 - 9_000),
            fire_state_last_withheld_at: pgString(T0 + 2_000),
            last_wake_at: pgString(T0 - 9_000),
          }),
        ],
        updates,
      ),
      nowMs: T0 + 26_000,
      recordFire,
      readFireState: vi.fn(async () => ({ lastFiredAt: new Date(T0 - 9_000), consecutiveErrors: 10 })),
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe('gate-backoff');
    expect(recordFire).not.toHaveBeenCalled();
  });

  it.each(['running', 'settled'] as const)(
    'rescues a withheld claim while an unrelated native turn is %s (EI-26238295261550737)',
    async phase => {
      const recordFire = vi.fn(async () => {});
      const recoverExpectedExecution = vi.fn(async () => ({ handled: true as const }));
      const res = await reconcile({
        sql: fakeSql([dispatchedRow({
          fire_state_last_fired_at: pgString(T0 - 9_000),
          fire_state_last_withheld_at: pgString(T0 + 2_000),
          last_wake_at: pgString(T0 - 9_000),
          last_wake_created_at: pgString(T0 - 10_000),
          last_wake_status: 'delivered',
          last_wake_channel: 'inbox',
          last_loop_turn_at: null,
          presence_last_active_at: pgString(T0 + 25_000),
          lifecycle_completed_at: phase === 'settled' ? pgString(T0 + 24_000) : null,
        })], []),
        nowMs: T0 + 26_000,
        recordFire,
        recoverExpectedExecution,
        readFireState: vi.fn(async () => ({ lastFiredAt: new Date(T0 - 9_000), consecutiveErrors: 10 })),
        checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
      });
      expect(recoverExpectedExecution).not.toHaveBeenCalled();
      expect(res.rearmed).toBe(1);
      expect(res.loops[0].via).toBe('gate-backoff');
      expect(res.loops[0].nextFireAt).toBeGreaterThan(T0 + 26_000);
      // Neither the unrelated activity nor its completion is a successful loop fire.
      expect(recordFire).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['new dispatch', { fire_state_last_fired_at: pgString(T0 + 2_000) }],
    ['older withhold', { fire_state_last_withheld_at: pgString(T0 - 1) }],
    ['new wake', { last_wake_created_at: pgString(T0 + 3_000) }],
    ['missing dispatch clock', { fire_state_last_fired_at: undefined }],
  ])('preserves execution protection with %s evidence', async (_name, clocks) => {
    const recoverExpectedExecution = vi.fn(async () => ({ handled: true as const }));
    const row: Record<string, unknown> = dispatchedRow({
      fire_state_last_fired_at: pgString(T0 - 9_000),
      fire_state_last_withheld_at: pgString(T0 + 2_000),
      last_wake_created_at: pgString(T0 - 10_000),
      last_wake_at: pgString(T0 - 9_000),
      last_wake_status: 'delivered', last_wake_channel: 'psu-socket-inject',
      last_loop_turn_at: null, presence_last_active_at: pgString(T0 + 25_000),
      ...clocks,
    });
    if (row.fire_state_last_fired_at === undefined) delete row.fire_state_last_fired_at;
    const result = await reconcile({ sql: fakeSql([row], []), nowMs: T0 + 26_000,
      recoverExpectedExecution, checkUnreachableTerminalGuard: NEVER_BREACH_GUARD });
    expect(recoverExpectedExecution).toHaveBeenCalledOnce();
    expect(result.rearmed).toBe(0);
  });

  it.each([null, { lastFiredAt: new Date(T0 + 10_000), consecutiveErrors: 10 }])(
    'leaves a withheld claim parked when the reread is unavailable or proves a later dispatch: %j',
    async currentState => {
      const recordFire = vi.fn(async () => {});
      const result = await reconcile({ sql: fakeSql([dispatchedRow({
        fire_state_last_fired_at: pgString(T0 - 9_000),
        fire_state_last_withheld_at: pgString(T0 + 2_000),
        last_wake_at: pgString(T0 - 9_000),
        presence_last_active_at: pgString(T0 + 25_000),
      })], []), nowMs: T0 + 26_000, recordFire,
      readFireState: vi.fn(async () => currentState), checkUnreachableTerminalGuard: NEVER_BREACH_GUARD });
      expect(result.rearmed).toBe(0);
      expect(recordFire).not.toHaveBeenCalled();
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// EI-22127560919383327 — a wake settled 'suppressed-redundant' (a turn was already in flight)
// is NOT a failed delivery.
//
// The defect these pin: the await engine settles a loop wake that lands mid-turn WITHOUT
// spending a turn (channel 'suppressed-redundant', status still 'delivered'); the psu-host
// stacks the queued prompt into the NEXT turn once the running one ends. deliveredWakeWithoutLoopTurn
// read only the status, so after the 120s grace + 60s of presence quiet (presence bumps only on
// tool calls — a turn generating a large edit is silent) it returned 'retry' and fed
// recordFire('error') for a wake that was never attempted. Measured 2026-09-02 on
// loop-su-a7410503: fire 05:37:32Z mid-turn → transition #402464 'rearmed via
// delivered-wake-no-loop-turn' at 05:41:09Z → consecutive_errors 0→1 on a healthy loop.
//
// FALSIFIABILITY: the CONTROL drives the identical row through channel 'psu-socket-inject' and
// must still take the pre-existing retry, proving the branch reads the CHANNEL VALUE; the
// STRAND-BOUND case proves a lost lifecycle 'ended' report cannot park the loop forever.
describe("reconcileLoopRoutines — a 'suppressed-redundant' wake waits for the in-flight turn to end (EI-22127560919383327)", () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  /** Fired at T0 while a turn was already running; the engine settled the wake without a turn
   *  1s later. No loop-origin turn, no lifecycle end since the fire, presence silent. */
  const suppressedRow = (over: Record<string, unknown> = {}) => ({
    id: 'rt-suppressed',
    target_owner_id: 'su-suppressed',
    interval_sec: 60,
    parked: true,
    is_cron: false,
    install_slug: 'papercusp',
    name: 'loop-su-suppressed',
    routine_workspace_id: 'ws-papercusp',
    last_fired_at: pgString(T0),
    fire_state_last_fired_at: pgString(T0 + 500),
    fire_state_last_withheld_at: null,
    last_wake_at: pgString(T0 + 1_000),
    last_wake_status: 'delivered',
    last_wake_channel: 'suppressed-redundant',
    last_loop_turn_at: null,
    lifecycle_completed_at: null,
    turn_journal_completed_at: null,
    lifecycle_started_at: null,
    carry: null,
    armed_at: null,
    note_updated_ts: null,
    presence_last_active_at: null,
    last_assistant_text_after_fire: null,
    turns_ingest_watermark: null,
    payload_template: null,
    monitor_delta_at: null,
    ...over,
  });

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('does NOT retry (or feed the circuit) while the in-flight turn has not ended, even past grace + presence quiet', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql([suppressedRow()], updates),
      nowMs: T0 + 220_000, // 120s grace + 60s FALLBACK_QUIET_MS both long elapsed
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    expect(res.rearmed).toBe(0);
    expect(res.loops).toEqual([]);
    expect(recordFire).not.toHaveBeenCalled();
  });

  it('CONTROL — the identical row on channel psu-socket-inject still takes the pre-existing retry', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql([suppressedRow({ last_wake_channel: 'psu-socket-inject' })], updates),
      nowMs: T0 + 220_000,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ id: 'rt-suppressed', via: 'delivered-wake-no-loop-turn' });
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-suppressed', 'loop-delivered-wake-no-loop-turn', 'error');
  });

  it('once the in-flight turn ENDS, the grace runs from that lifecycle clock — then the ordinary retry applies', async () => {
    const ended = suppressedRow({ lifecycle_completed_at: pgString(T0 + 150_000) });
    // 10s after the turn ended: the queued prompt is only now being injected — still awaiting.
    const early = await reconcile({
      sql: fakeSql([ended], []),
      nowMs: T0 + 160_000,
      recordFire: vi.fn(async () => {}),
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    expect(early.rearmed).toBe(0);
    // 150s after the turn ended (> the 120s grace), no loop-origin turn and presence silent:
    // now it IS a failed handoff, and the pre-existing retry + circuit feed apply unchanged.
    const recordFire = vi.fn(async () => {});
    const late = await reconcile({
      sql: fakeSql([ended], []),
      nowMs: T0 + 300_000,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    expect(late.rearmed).toBe(1);
    expect(late.loops[0]).toMatchObject({ via: 'delivered-wake-no-loop-turn', completedAt: T0 + 1_000 });
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-suppressed', 'loop-delivered-wake-no-loop-turn', 'error');
  });

  it('STRAND-BOUND — with NO lifecycle end ever observed, the wait is capped at the stuck-park dwell, after which the ladder judges it as before', async () => {
    const updates: unknown[][] = [];
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql([suppressedRow()], updates),
      nowMs: T0 + 30 * 60_000 + 1_000, // max(30min, 4×60s) + 1s past the wake
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ via: 'delivered-wake-no-loop-turn' });
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-suppressed', 'loop-delivered-wake-no-loop-turn', 'error');
  });
});

// EI-22177872501023528 — a WARM suppressed-redundant wake must not wait 30 min for a lifecycle
// 'ended' that never comes.
//
// The defect these pin: the EI-22127560919383327 leg above holds the fire until a lifecycle
// 'ended' newer than the wake. That marker "in practice only fires at a genuine session restart"
// (this module's own layer-1 note), so a WARM session that never restarts never produces one —
// and the stacked prompt only carries turn_origin='loop-fire' when the LOOP's wake opens the next
// turn, so when a watchdog/wake-pump/coord wake opens it first the strict loop-turn clock never
// advances either. Both hold together for exactly one population, measured 2026-09-02 on
// papercusp-workspace: warm + suppressed-redundant = 8 parked loops, 8/8 with zero post-fire
// loop-fire turns, averaging 17.5x their own interval (every other parked group: 1.8-5.2x).
// Only the layer-3 stuck-park backstop could rescue them — a flat 30-min floor, i.e. 30x cadence
// for a 60s loop.
//
// FALSIFIABILITY: the two CONTROLs drive the identical row with presence STILL BUSY and with
// presence that never advanced past the fire, and both must keep the pre-existing awaiting-turn
// hold — proving the new branch reads the quiet-gap and the did-work-after-the-fire predicates
// rather than simply abandoning the leg.
describe("reconcileLoopRoutines — a warm 'suppressed-redundant' wake settles on presence quiet, not on a lifecycle 'ended' that never arrives (EI-22177872501023528)", () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  /** WARM loop, fired at T0 mid-turn; wake settled 'suppressed-redundant' 1s later. No loop-origin
   *  turn and no lifecycle 'ended' will EVER arrive (warm session, never restarts). */
  const warmSuppressedRow = (over: Record<string, unknown> = {}) => ({
    id: 'rt-warm-suppressed',
    target_owner_id: 'su-warm-suppressed',
    interval_sec: 60,
    parked: true,
    is_cron: false,
    install_slug: 'papercusp',
    name: 'loop-su-warm-suppressed',
    routine_workspace_id: 'ws-papercusp',
    last_fired_at: pgString(T0),
    fire_state_last_fired_at: pgString(T0 + 500),
    fire_state_last_withheld_at: null,
    last_wake_at: pgString(T0 + 1_000),
    last_wake_status: 'delivered',
    last_wake_channel: 'suppressed-redundant',
    last_loop_turn_at: null,
    lifecycle_completed_at: null,
    turn_journal_completed_at: null,
    lifecycle_started_at: null,
    carry: null, // WARM
    armed_at: null,
    note_updated_ts: null,
    // Worked until +40s (the stacked prompt's turn), then went quiet.
    presence_last_active_at: pgString(T0 + 40_000),
    last_assistant_text_after_fire: null,
    turns_ingest_watermark: null,
    payload_template: null,
    monitor_delta_at: null,
    ...over,
  });

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it.each(['suppressed-redundant', 'coalesced', 'inbox'])('recovers a %s non-turn wake after quiet without mistaking unrelated inference for loop execution', async channel => {
    const recordFire = vi.fn(async () => {});
    const recoverExpectedExecution = vi.fn(async () => ({ handled: true as const }));
    const res = await reconcile({
      sql: fakeSql([warmSuppressedRow({ last_wake_channel: channel })], []),
      // Coalesced/inbox wakes retain their existing two-interval dispatch grace.
      nowMs: T0 + (channel === 'suppressed-redundant' ? 110_000 : 130_000),
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
      recoverExpectedExecution,
    });
    // This active inference is the unrelated turn that caused suppression, not a loop-fire turn.
    expect(recoverExpectedExecution).not.toHaveBeenCalled();
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).toBe(channel === 'suppressed-redundant' ? 'presence-quiescence' : 'delivered-wake-no-loop-turn');
    // A wake that was never spent must never feed the fire-circuit (EI-22127560919383327).
    if (channel === 'suppressed-redundant') expect(recordFire).not.toHaveBeenCalledWith(
      expect.anything(), expect.anything(), expect.anything(), 'error',
    );
  });

  it('still lets expected-execution recovery protect a delivered wake that may have opened a loop turn', async () => {
    const recoverExpectedExecution = vi.fn(async () => ({ handled: true as const }));
    const res = await reconcile({
      sql: fakeSql([warmSuppressedRow({ last_wake_channel: 'psu-socket-inject' })], []),
      nowMs: T0 + 110_000,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
      recoverExpectedExecution,
    });
    expect(recoverExpectedExecution).toHaveBeenCalledTimes(1);
    expect(res.rearmed).toBe(0);
  });

  // WI-6554700010012279: the wake-executor DROPPED this fire's delivery (superseded by a
  // re-arm), so nothing was injected and no loop turn can ever exist for it. Execution
  // recovery used to protect on the session's unrelated active inference and the loop stayed
  // parked for over an hour. The ordinary signal ladder must settle and re-arm it.
  it('re-arms a parked loop whose fire delivery was dropped, without consulting execution recovery', async () => {
    const recoverExpectedExecution = vi.fn(async () => ({ handled: true as const }));
    const res = await reconcile({
      sql: fakeSql([warmSuppressedRow({ last_wake_status: 'dropped', last_wake_channel: null })], []),
      nowMs: T0 + 110_000,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
      recoverExpectedExecution,
    });
    expect(recoverExpectedExecution).not.toHaveBeenCalled();
    expect(res.rearmed).toBe(1);
    expect(res.loops[0].via).not.toBe('execution-recovery');
  });

  it('CONTROL: a dropped wake older than the current fire still consults execution recovery', async () => {
    const recoverExpectedExecution = vi.fn(async () => ({ handled: true as const }));
    const res = await reconcile({
      sql: fakeSql([warmSuppressedRow({ last_wake_status: 'dropped', last_wake_channel: null,
        last_wake_at: pgString(T0 - 60_000) })], []),
      nowMs: T0 + 110_000,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
      recoverExpectedExecution,
    });
    expect(recoverExpectedExecution).toHaveBeenCalledTimes(1);
    expect(res.rearmed).toBe(0);
  });

  it.each(['coalesced', 'inbox'])('keeps the existing dispatch grace for an unproved %s wake', async channel => {
    const recoverExpectedExecution = vi.fn(async () => ({ handled: true as const }));
    const result = await reconcile({ sql: fakeSql([warmSuppressedRow({ last_wake_channel: channel })], []),
      nowMs: T0 + 110_000, readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD, recoverExpectedExecution });
    expect(recoverExpectedExecution).not.toHaveBeenCalled();
    expect(result.rearmed).toBe(0);
  });

  it('CONTROL — while the session is STILL BUSY (presence beat 20s old) it keeps waiting, unchanged', async () => {
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql([warmSuppressedRow({ presence_last_active_at: pgString(T0 + 90_000) })], []),
      nowMs: T0 + 110_000, // only 20s quiet — under FALLBACK_QUIET_MS
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    expect(res.rearmed).toBe(0);
    expect(recordFire).not.toHaveBeenCalled();
  });

  it('CONTROL — presence that never advanced past the fire is no evidence a turn ran, so it keeps waiting', async () => {
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql([warmSuppressedRow({ presence_last_active_at: pgString(T0 - 5_000) })], []),
      nowMs: T0 + 110_000,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    expect(res.rearmed).toBe(0);
    expect(recordFire).not.toHaveBeenCalled();
  });
});

/**
 * P-004 (anti-babysitting-monitor-enforcement-2026-08-25) — the MONITOR settlement branch.
 *
 * The pure decisions live in monitor-standdown.test.ts; these cover the WIRING, which is
 * where the expensive mistakes are: does a standdown actually REPLACE the re-arm (rather
 * than running beside it), does a surviving monitor persist its decremented budget, and —
 * the regression that would make the whole feature silently inert — does a WORK loop still
 * take the untouched path?
 */
describe('reconcileLoopRoutines — monitor standdown (P-004)', () => {
  const T0 = 1_782_000_000_000;
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  type AppliedMonitorBudgetWrite = {
    routineId: string;
    fireToken: string;
    remainingNoDeltaBudget: number;
  };

  type StatementRecordingState = {
    settledBudgetFireByRoutine: Map<string, string>;
    appliedBudgetWrites: AppliedMonitorBudgetWrite[];
  };

  const statementRecordingState = (): StatementRecordingState => ({
    settledBudgetFireByRoutine: new Map(),
    appliedBudgetWrites: [],
  });

  /** Records statements and models the atomic per-fire guard used by the budget UPDATE. */
  function statementRecordingSql(
    rows: Record<string, unknown>[],
    seen: string[],
    state: StatementRecordingState = statementRecordingState(),
  ): Sql {
    return ((strings: TemplateStringsArray, ...vals: unknown[]) => {
      const q = strings.join(' ? ');
      if (/^\s*UPDATE/i.test(q)) {
        seen.push(q);
        if (q.includes("'{monitor,remainingNoDeltaBudget}'")) {
          const [remaining, fireTokenValue, routineIdValue] = vals;
          const fireToken = String(fireTokenValue);
          const routineId = String(routineIdValue);
          const guardedByThisFire = /\(metadata->>'monitor_budget_fire_at'\)\s+IS DISTINCT FROM\s+\?\s*::text/.test(q);

          // A missing or changed predicate applies the write again. With the production
          // predicate, the second overlapping snapshot for the same fire is a no-op.
          if (guardedByThisFire && state.settledBudgetFireByRoutine.get(routineId) === fireToken) {
            return Promise.resolve([]);
          }

          state.settledBudgetFireByRoutine.set(routineId, fireToken);
          state.appliedBudgetWrites.push({ routineId, fireToken, remainingNoDeltaBudget: Number(remaining) });
          return Promise.resolve([{ id: routineId }]);
        }
        // Enough columns for standDownMonitorLoop's RETURNING destructure; the transition
        // write it triggers is fail-soft evidence and never affects the verdict.
        return Promise.resolve([
          {
            id: 'rt-1',
            workspace_id: 'ws-papercusp',
            install_slug: 'papercusp',
            name: 'loop-su-test',
            target_role: null,
            target_owner_id: 'su-test',
            reschedule_interval_sec: 60,
            prev_next_fire_at: 'infinity',
          },
        ]);
      }
      if (
        /^\s*SELECT/i.test(q) &&
        /\(metadata->>'monitor_budget_fire_at'\)\s*=\s*\?\s*::text/.test(q)
      ) {
        const [routineIdValue, fireTokenValue] = vals;
        const routineId = String(routineIdValue);
        const fireToken = String(fireTokenValue);
        return Promise.resolve(state.settledBudgetFireByRoutine.get(routineId) === fireToken ? [{ id: routineId }] : []);
      }
      if (/^\s*INSERT/i.test(q)) return Promise.resolve([]);
      return Promise.resolve(rows);
    }) as unknown as Sql;
  }

  const monitorPayload = (overrides: Record<string, unknown> = {}) => ({
    mode: 'monitor',
    monitor: {
      predicateKey: 'release:green:papercusp',
      stopCondition: 'the green verdict is recorded',
      noDeltaBudget: 1,
      remainingNoDeltaBudget: 1,
      authority: { kind: 'work-item', workItem: 'WI-42' },
      ...overrides,
    },
  });

  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'rt-1',
    target_owner_id: 'su-test',
    interval_sec: 60,
    parked: true,
    install_slug: 'papercusp',
    name: 'loop-su-test',
    routine_workspace_id: 'ws-papercusp',
    last_fired_at: pgString(T0),
    lifecycle_completed_at: pgString(T0 + 5_000), // the settle signal
    presence_last_active_at: null,
    payload_template: monitorPayload(),
    monitor_delta_at: null,
    ...overrides,
  });

  const AUTHORITY_HELD = vi.fn(async () => ({ ok: true }) as const);

  const standdownWrites = (seen: string[]) => seen.filter((q) => q.includes('monitor_standdown'));
  const budgetWrites = (seen: string[]) => seen.filter((q) => q.includes('remainingNoDeltaBudget'));
  const rearmWrites = (seen: string[]) => seen.filter((q) => q.includes('next_fire_at = LEAST'));

  it('a QUIET settled fire on the default budget stands the monitor down INSTEAD of re-arming', async () => {
    const seen: string[] = [];
    const res = await reconcile({
      sql: statementRecordingSql([row()], seen),
      nowMs: T0 + 10_000,
      recheckMonitorAuthority: AUTHORITY_HELD,
    });
    // The whole point: no re-arm happened, and the loop is reported terminated with a reason.
    expect(res.rearmed).toBe(0);
    expect(rearmWrites(seen)).toHaveLength(0);
    expect(standdownWrites(seen)).toHaveLength(1);
    expect(res.terminated).toHaveLength(1);
    expect(res.terminated[0]).toMatchObject({ id: 'rt-1', targetOwnerId: 'su-test' });
    expect(res.terminated[0].reason).toContain('no_delta_budget_exhausted');
    // The standdown write must be the ATOMIC one — deactivation and reason in one statement.
    expect(standdownWrites(seen)[0]).toContain('active = FALSE');
  });

  it('a monitor with budget left persists the DECREMENT and then re-arms normally', async () => {
    const seen: string[] = [];
    const res = await reconcile({
      sql: statementRecordingSql([row({ payload_template: monitorPayload({ noDeltaBudget: 3, remainingNoDeltaBudget: 3 }) })], seen),
      nowMs: T0 + 10_000,
      recheckMonitorAuthority: AUTHORITY_HELD,
    });
    expect(res.rearmed).toBe(1);
    expect(budgetWrites(seen)).toHaveLength(1);
    expect(standdownWrites(seen)).toHaveLength(0);
    expect(rearmWrites(seen)).toHaveLength(1);
  });

  it('a delta stamped AFTER the fire keeps the monitor alive at full budget', async () => {
    const seen: string[] = [];
    const res = await reconcile({
      sql: statementRecordingSql(
        [
          row({
            payload_template: monitorPayload({ noDeltaBudget: 4, remainingNoDeltaBudget: 1 }),
            monitor_delta_at: pgString(T0 + 1_000), // after last_fired_at = T0
          }),
        ],
        seen,
      ),
      nowMs: T0 + 10_000,
      recheckMonitorAuthority: AUTHORITY_HELD,
    });
    // remainingNoDeltaBudget was 1 — one quiet wake from death. The delta rescues it.
    expect(res.rearmed).toBe(1);
    expect(standdownWrites(seen)).toHaveLength(0);
  });

  it('a delta stamped BEFORE the fire does NOT rescue it — a stale marker is not a delta', async () => {
    const seen: string[] = [];
    const res = await reconcile({
      sql: statementRecordingSql([row({ monitor_delta_at: pgString(T0 - 1_000) })], seen),
      nowMs: T0 + 10_000,
      recheckMonitorAuthority: AUTHORITY_HELD,
    });
    expect(res.rearmed).toBe(0);
    expect(standdownWrites(seen)).toHaveLength(1);
  });

  it('a LOST authority stands the monitor down even with budget to spare', async () => {
    const seen: string[] = [];
    const res = await reconcile({
      sql: statementRecordingSql([row({ payload_template: monitorPayload({ noDeltaBudget: 10, remainingNoDeltaBudget: 10 }) })], seen),
      nowMs: T0 + 10_000,
      recheckMonitorAuthority: vi.fn(async () => ({
        ok: false as const,
        code: 'monitor_peer_owned_progress',
        message: 'WI-42 is already owned and progressing under live peer su-peer.',
      })),
    });
    expect(res.rearmed).toBe(0);
    expect(res.terminated[0].reason).toContain('monitor_peer_owned_progress');
    expect(standdownWrites(seen)).toHaveLength(1);
  });

  it('a THROWN authority recheck fails OPEN — the monitor survives on remaining budget', async () => {
    const seen: string[] = [];
    const res = await reconcile({
      sql: statementRecordingSql([row({ payload_template: monitorPayload({ noDeltaBudget: 3, remainingNoDeltaBudget: 3 }) })], seen),
      nowMs: T0 + 10_000,
      recheckMonitorAuthority: vi.fn(async () => {
        throw new Error('connection terminated');
      }),
    });
    // A transient read failure must never manufacture a standdown.
    expect(res.rearmed).toBe(1);
    expect(standdownWrites(seen)).toHaveLength(0);
  });

  it('a WORK loop is untouched — no authority read, no budget write, ordinary re-arm', async () => {
    const seen: string[] = [];
    const recheck = vi.fn(async () => ({ ok: true }) as const);
    const res = await reconcile({
      sql: statementRecordingSql([row({ payload_template: { mode: 'work' } })], seen),
      nowMs: T0 + 10_000,
      recheckMonitorAuthority: recheck,
    });
    expect(res.rearmed).toBe(1);
    expect(recheck).not.toHaveBeenCalled();
    expect(budgetWrites(seen)).toHaveLength(0);
    expect(standdownWrites(seen)).toHaveLength(0);
  });

  it('two overlapping settled passes apply one budget write for the same fire, then accept the next fire', async () => {
    const seen: string[] = [];
    const state = statementRecordingState();
    const sql = statementRecordingSql(
      [row({ payload_template: monitorPayload({ noDeltaBudget: 3, remainingNoDeltaBudget: 3 }) })],
      seen,
      state,
    );
    const firstFire = {
      sql,
      nowMs: T0 + 10_000,
      recheckMonitorAuthority: AUTHORITY_HELD,
    };

    // Both calls read the same static pre-decrement fixture before either reaches the
    // write. The fake database applies the conditional UPDATE at the point each statement
    // runs, as PostgreSQL does after the row lock is acquired.
    await Promise.all([reconcile(firstFire), reconcile(firstFire)]);
    expect(budgetWrites(seen)).toHaveLength(2);
    expect(state.appliedBudgetWrites).toEqual([
      { routineId: 'rt-1', fireToken: String(T0), remainingNoDeltaBudget: 2 },
    ]);

    // A new settled fire has a new last_fired_at token, so its budget update still applies.
    await reconcile({
      sql: statementRecordingSql(
        [
          row({
            last_fired_at: pgString(T0 + 60_000),
            lifecycle_completed_at: pgString(T0 + 65_000),
            payload_template: monitorPayload({ noDeltaBudget: 3, remainingNoDeltaBudget: 2 }),
          }),
        ],
        seen,
        state,
      ),
      nowMs: T0 + 70_000,
      recheckMonitorAuthority: AUTHORITY_HELD,
    });
    expect(state.appliedBudgetWrites).toEqual([
      { routineId: 'rt-1', fireToken: String(T0), remainingNoDeltaBudget: 2 },
      { routineId: 'rt-1', fireToken: String(T0 + 60_000), remainingNoDeltaBudget: 1 },
    ]);
  });

  it('a NON-SETTLE re-arm (fire withheld by the gate) never touches the budget or the authority', async () => {
    const seen: string[] = [];
    const recheck = vi.fn(async () => ({ ok: true }) as const);
    // The gate-backoff leg logs its own re-arm; that is pre-existing, expected behaviour here.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // No completion signal at all + an open fire-gate backoff ⇒ via 'gate-backoff': the agent
    // received NO WAKE, so charging it a quiet-wake unit would stand a healthy monitor down
    // for the scheduler's failure.
    const res = await reconcile({
      sql: statementRecordingSql([row({ lifecycle_completed_at: null, presence_last_active_at: null })], seen),
      nowMs: T0 + 70_000,
      recheckMonitorAuthority: recheck,
      readFireState: vi.fn(async () => ({ lastFiredAt: new Date(T0), consecutiveErrors: 4 })),
      recordFire: async () => {},
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    expect(res.loops[0]?.via).toBe('gate-backoff');
    expect(recheck).not.toHaveBeenCalled();
    expect(budgetWrites(seen)).toHaveLength(0);
    expect(standdownWrites(seen)).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('fire-gate withholding'));
    warn.mockRestore();
  });

  it('a loop with NO payload_template at all (a legacy row) still re-arms', async () => {
    const seen: string[] = [];
    const res = await reconcile({
      sql: statementRecordingSql([row({ payload_template: null })], seen),
      nowMs: T0 + 10_000,
      recheckMonitorAuthority: AUTHORITY_HELD,
    });
    expect(res.rearmed).toBe(1);
    expect(standdownWrites(seen)).toHaveLength(0);
  });
});

// WI-2140827: a warm pure loop whose SESSION STAYS BUSY on unrelated work was wedged at
// 'infinity' with no reachable settle layer. `coord_presence.last_active_at` is owner-wide, so
// peer coord wakes / event awaits / owner turns bump it every few seconds forever; the
// delivered-wake deferral read that as "the woken turn is still running" and never expired,
// while `hasDeliveredWakeWithoutLoopTurn` simultaneously suppressed the owner-wide ladder and
// `looksDeadOrStuck` read false off that same recent activity — so layers 1, 1.5, 2 AND the
// layer-3 stuck-park backstop were all unreachable AT ONCE. The property was inverted from the
// intent: the busier the session, the more certainly its loop was wedged, while a quiet one was
// rescued within ~30min. Measured live 2026-09-02: 4 warm loops wedged, presence beats 1–68s
// old, including a 60s loop parked 2574s (43× interval) and a 900s loop parked 4955s.
//
// FALSIFIABILITY: the INSIDE-THE-DWELL control drives the identical row 10 min in and must still
// wait (no re-arm, no circuit write) — that is EI-22127560919383327's protection, and it proves
// these tests read the DWELL BOUND rather than passing for any busy row.
describe('reconcileLoopRoutines — a busy session no longer wedges its own loop forever (WI-2140827)', () => {
  const T0 = 1_782_000_000_000;
  const DWELL_MS = 30 * 60_000; // stuckBackstopCadenceMs(60s) = max(30min, 4×60s)
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  /** Warm 60s loop, fired at T0, wake DELIVERED at T0+1s on an ordinary channel, and no
   *  loop-origin turn ever stamped. The session is alive and working on other things, so
   *  presence keeps beating — `presence_last_active_at` is set per-case relative to now. */
  const busyRow = (over: Record<string, unknown> = {}) => ({
    id: 'rt-busy',
    target_owner_id: 'su-busy',
    interval_sec: 60,
    parked: true,
    is_cron: false,
    install_slug: 'papercusp',
    name: 'loop-su-busy',
    routine_workspace_id: 'ws-papercusp',
    last_fired_at: pgString(T0),
    fire_state_last_fired_at: pgString(T0 + 500),
    fire_state_last_withheld_at: null,
    last_wake_at: pgString(T0 + 1_000),
    last_wake_status: 'delivered',
    last_wake_channel: 'psu-socket-inject',
    last_loop_turn_at: null,
    lifecycle_completed_at: null,
    turn_journal_completed_at: null,
    lifecycle_started_at: null,
    carry: null,
    armed_at: null,
    note_updated_ts: null,
    presence_last_active_at: null,
    last_assistant_text_after_fire: null,
    turns_ingest_watermark: null,
    payload_template: null,
    monitor_delta_at: null,
    ...over,
  });

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('CONTROL — inside the dwell, a fresh presence beat still defers (EI-22127560919383327 intact)', async () => {
    const nowMs = T0 + 1_000 + 600_000; // 10 min in — well inside the 30 min dwell
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql([busyRow({ presence_last_active_at: pgString(nowMs - 5_000) })], []),
      nowMs,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    expect(res.rearmed).toBe(0);
    expect(res.loops).toEqual([]);
    expect(recordFire).not.toHaveBeenCalled();
  });

  it('past the dwell, a continuously-busy session no longer holds its loop parked forever', async () => {
    const nowMs = T0 + 1_000 + DWELL_MS + 60_000;
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({
      // presence beat 5s ago — the exact shape that used to defer indefinitely
      sql: fakeSql([busyRow({ presence_last_active_at: pgString(nowMs - 5_000) })], []),
      nowMs,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ id: 'rt-busy', via: 'delivered-wake-no-loop-turn' });
  });

  it('past the dwell the ordinary ladder is restored, so a real turn settles it as ok (not an error retry)', async () => {
    const nowMs = T0 + 1_000 + DWELL_MS + 60_000;
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql(
        [
          busyRow({
            presence_last_active_at: pgString(nowMs - 5_000),
            turn_journal_completed_at: pgString(T0 + 30_000),
          }),
        ],
        [],
      ),
      nowMs,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ id: 'rt-busy', via: 'turn-journal' });
    expect(recordFire).toHaveBeenCalledWith('papercusp', 'loop-su-busy', 'loop-turn-journal', 'ok');
  });
});

describe('reconcileLoopRoutines — looksDeadOrStuck stays bounded to the fire, not the latest unrelated beat (EI-22171105225585428)', () => {
  const T0 = 1_782_100_000_000;
  const DWELL_MS = 30 * 60_000; // stuckParkMs(60s) = max(30min, 4×60s)
  const pgString = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');

  /** Warm 60s loop, fired at T0, whose wake was NEVER delivered (e.g. dropped after retries) —
   *  the exact shape measured live on EI-22171105225585428. `last_wake_status` is NOT
   *  'delivered', so `deliveredWakeWithoutLoopTurn` returns null (deliveredWakeRetryAt stays
   *  null) — but that alone is NOT enough to reach the `looksDeadOrStuck` ladder: `signal` is
   *  computed FIRST via `completionSignal()`, whose OWN presence-quiescence fallback (module
   *  header layer 2) shares the EXACT SAME `FALLBACK_QUIET_MS` staleness bar as this fix's
   *  disjunct 2 — so once a post-fire beat goes stale, `completionSignal` intercepts it FIRST
   *  and returns `via:'presence-quiescence'` before disjunct 2 is ever evaluated (verified: the
   *  fixture below WITHOUT `turns_ingest_watermark` produces exactly that, not 'stuck-backstop').
   *  The two stale-beat tests below therefore also pin `turns_ingest_watermark` behind the beat,
   *  so `completionSignal`'s WI-6852 ingest-lag guard defers (returns null) instead — the one
   *  legitimate way `signal` stays null with a genuinely stale, non-'delivered' post-fire beat,
   *  which is exactly the shape that reaches disjunct 2 in production. The session is alive and
   *  working on something else entirely, so OWNER-WIDE presence keeps beating regardless of
   *  this loop. */
  const undeliveredRow = (over: Record<string, unknown> = {}) => ({
    id: 'rt-undelivered',
    target_owner_id: 'su-undelivered',
    interval_sec: 60,
    parked: true,
    is_cron: false,
    install_slug: 'papercusp',
    name: 'loop-su-undelivered',
    routine_workspace_id: 'ws-papercusp',
    last_fired_at: pgString(T0),
    fire_state_last_fired_at: pgString(T0 + 500),
    fire_state_last_withheld_at: null,
    last_wake_at: pgString(T0 + 1_000),
    last_wake_status: 'dropped',
    last_wake_channel: 'coord-inbox-wake',
    last_loop_turn_at: null,
    lifecycle_completed_at: null,
    turn_journal_completed_at: null,
    lifecycle_started_at: null,
    carry: null,
    armed_at: null,
    note_updated_ts: null,
    presence_last_active_at: null,
    last_assistant_text_after_fire: null,
    turns_ingest_watermark: null,
    payload_template: null,
    monitor_delta_at: null,
    ...over,
  });

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('CONTROL — inside the dwell, a fresh unrelated beat still defers (unchanged)', async () => {
    const nowMs = T0 + 1_000 + 600_000; // 10 min in — well inside the 30 min dwell
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql([undeliveredRow({ presence_last_active_at: pgString(nowMs - 5_000) })], []),
      nowMs,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    expect(res.rearmed).toBe(0);
    expect(res.loops).toEqual([]);
    expect(recordFire).not.toHaveBeenCalled();
  });

  it('a stray beat that has since gone stale no longer blocks the quick-retry leg from ever running', async () => {
    // The bug: disjunct 2 used the FULL dwell (30min here) as its staleness bar, so a single
    // stray beat 4min after the fire stayed "fresh enough" for the next ~26min — well past the
    // 10min quick-retry threshold — silently short-circuiting the early `continue` gate on every
    // tick and starving the quick-retry leg below of ever being reached, even though the beat
    // itself had gone quiet (>60s stale) minutes ago.
    //
    // `turns_ingest_watermark` is pinned behind the beat so `completionSignal`'s own
    // presence-quiescence fallback (which shares this fix's 60s bar) DEFERS instead of settling
    // the fire itself — see the fixture doc comment above. Without it, this fixture settles via
    // 'presence-quiescence' before disjunct 2 is ever reached, REGARDLESS of whether the fix
    // under test is applied (verified empirically: the pre-fix bar produces the identical
    // 'presence-quiescence' via here too) — i.e. it would silently test nothing.
    const beatAtMs = T0 + 4 * 60_000; // one isolated, unrelated beat 4min after the fire
    const nowMs = T0 + 1_000 + 10 * 60_000; // just past quickRetryParkMs(60s)=10min — beat is ~6min stale
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql(
        [
          undeliveredRow({
            presence_last_active_at: pgString(beatAtMs),
            turns_ingest_watermark: pgString(T0),
          }),
        ],
        [],
      ),
      nowMs,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ id: 'rt-undelivered', via: 'stuck-backstop' });
  });

  it('past the full dwell, the classic stuck-backstop still fires even with a somewhat-recent stray beat', async () => {
    const nowMs = T0 + 1_000 + DWELL_MS + 60_000; // past the dwell measured from the FIRE
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql(
        [
          undeliveredRow({
            // beat is 2 minutes old — long stale by the new 60s bar, so this exercises the SAME
            // path as before via disjunct 2, then falls through to the unchanged stuckParkElapsed
            // dwell. turns_ingest_watermark pinned behind it for the same reason as the test above
            // (completionSignal's own presence-quiescence check would otherwise intercept first).
            presence_last_active_at: pgString(nowMs - 2 * 60_000),
            turns_ingest_watermark: pgString(T0),
          }),
        ],
        [],
      ),
      nowMs,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ id: 'rt-undelivered', via: 'stuck-backstop' });
  });

  it('a beat that never happens (lastActiveMs <= lastFiredMs) is still caught via quick-retry, well before the dwell (unchanged)', async () => {
    // quickRetryParkMs(60s) = max(10min, 3×60s) = 10min: past that, before the 30min dwell,
    // a genuinely-dead loop (no presence at all since the fire — the pre-existing first
    // disjunct, untouched by this fix) is still caught by the WI-2714 quick-retry leg.
    const nowMs = T0 + 1_000 + 11 * 60_000; // 11 min in — past quick-retry, inside the dwell
    const recordFire = vi.fn(async () => {});
    const res = await reconcile({
      sql: fakeSql([undeliveredRow({ presence_last_active_at: pgString(T0 - 60_000) })], []),
      nowMs,
      recordFire,
      readFireState: NO_PRIOR_ERRORS,
      checkUnreachableTerminalGuard: NEVER_BREACH_GUARD,
    });
    expect(res.rearmed).toBe(1);
    expect(res.loops[0]).toMatchObject({ id: 'rt-undelivered', via: 'stuck-backstop' });
  });
});

/**
 * WI-6554700010012153 — the no-turn wedge escalation must coalesce (stable key, no volatile
 * count in the summary) and must CLOSE itself once the loop recovers, or it joins the
 * immortal-escalation class EI-19408412473830336 fixed for its two siblings.
 */
describe('loop no-turn wedge watchdog — dedup + auto-resolve (WI-6554700010012153)', () => {
  const info = {
    routineId: 'rt-wedge',
    targetOwnerId: 'su-wedged',
    installSlug: 'papercusp',
    name: 'loop-su-wedged',
    lastWakeDeliveredAt: '2026-10-14T05:05:00.000Z',
  };

  it('keys every occurrence of the same loop onto one stable conditionKey, whatever the streak', async () => {
    const mockOpenEscalation = vi.mocked(openEscalation);
    mockOpenEscalation.mockClear();
    await defaultEscalateNoTurnWedge({ ...info, consecutiveErrors: 3 });
    await defaultEscalateNoTurnWedge({ ...info, consecutiveErrors: 6 });

    const args = mockOpenEscalation.mock.calls.map(
      (c) => c[1] as { summary: string; meta?: { subjectSignature?: string }; harness_slug?: string },
    );
    expect(args).toHaveLength(2);
    expect(args[0]?.meta?.subjectSignature).toBe(`${LOOP_NO_TURN_WEDGE_SIGNATURE_PREFIX}:papercusp:rt-wedge`);
    expect(args[1]?.meta?.subjectSignature).toBe(args[0]?.meta?.subjectSignature);
    // The summary is the dedup fallback; it must not carry the volatile streak.
    expect(args[0]?.summary).toBe(args[1]?.summary);
    expect(args[0]?.summary).toContain('su-wedged');
    expect(args[0]?.harness_slug).toBe('papercusp');
  });

  const openRow = (sig: string) => ({ msg_id: `m-${sig}`, subjectSignature: sig }) as never;
  const routineSql = (rows: { id: string; active: boolean }[]) =>
    (() =>
      Promise.resolve(
        rows.map((r) => ({ ...r, install_slug: 'papercusp', name: `loop-${r.id}` })),
      )) as unknown as Sql;

  it('resolves once a later fire succeeded, and leaves a still-failing loop open', async () => {
    const resolve = vi.fn(async () => 'resolved');
    const res = await reconcileLoopNoTurnWedgeEscalations({
      sql: routineSql([
        { id: 'rt-recovered', active: true },
        { id: 'rt-still-wedged', active: true },
      ]),
      listOpen: async () => [
        openRow(`${LOOP_NO_TURN_WEDGE_SIGNATURE_PREFIX}:papercusp:rt-recovered`),
        openRow(`${LOOP_NO_TURN_WEDGE_SIGNATURE_PREFIX}:papercusp:rt-still-wedged`),
      ],
      resolve,
      readFireState: vi.fn(async (_slug: string, name: string) =>
        (name === 'loop-rt-recovered' ? { consecutiveErrors: 0 } : { consecutiveErrors: 4 }) as never,
      ),
    });

    expect(res).toMatchObject({ scanned: 2, resolved: 1, stillOpen: 1, unparseable: 0 });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(
      `m-${LOOP_NO_TURN_WEDGE_SIGNATURE_PREFIX}:papercusp:rt-recovered`,
      'auto-resolved',
      expect.stringContaining('loop-no-turn-wedge watchdog'),
    );
  });

  it('resolves when the routine is gone or was auto-paused by the stronger loop-death watchdog', async () => {
    const resolve = vi.fn(async () => 'resolved');
    const res = await reconcileLoopNoTurnWedgeEscalations({
      sql: routineSql([{ id: 'rt-paused', active: false }]),
      listOpen: async () => [
        openRow(`${LOOP_NO_TURN_WEDGE_SIGNATURE_PREFIX}:papercusp:rt-paused`),
        openRow(`${LOOP_NO_TURN_WEDGE_SIGNATURE_PREFIX}:papercusp:rt-deleted`),
      ],
      resolve,
      readFireState: vi.fn(async () => ({ consecutiveErrors: 9 }) as never),
    });
    expect(res).toMatchObject({ scanned: 2, resolved: 2, stillOpen: 0 });
  });

  it('each watchdog reads only its own prefix — a sibling signature is never resolved by the wrong leg', async () => {
    const resolve = vi.fn(async () => 'resolved');
    const res = await reconcileLoopLifecycleDeathEscalations({
      sql: routineSql([{ id: 'rt-x', active: true }]),
      listOpen: async () => [openRow(`${LOOP_NO_TURN_WEDGE_SIGNATURE_PREFIX}:papercusp:rt-x`)],
      resolve,
      readFireState: vi.fn(async () => ({ consecutiveErrors: 0 }) as never),
    });
    expect(res).toMatchObject({ scanned: 1, resolved: 0, unparseable: 1 });
    expect(resolve).not.toHaveBeenCalled();

    // …and the shared body still serves the lifecycle leg's own rows, with its own wording.
    const lifecycle = await reconcileLoopLifecycleDeathEscalations({
      sql: routineSql([{ id: 'rt-x', active: true }]),
      listOpen: async () => [openRow(`${LOOP_LIFECYCLE_DEATH_SIGNATURE_PREFIX}:papercusp:rt-x`)],
      resolve,
      readFireState: vi.fn(async () => ({ consecutiveErrors: 0 }) as never),
    });
    expect(lifecycle).toMatchObject({ resolved: 1 });
    expect(resolve).toHaveBeenLastCalledWith(
      `m-${LOOP_LIFECYCLE_DEATH_SIGNATURE_PREFIX}:papercusp:rt-x`,
      'auto-resolved',
      expect.stringContaining('the provider wall cleared'),
    );
  });

  it('threshold override: a valid positive integer applies; junk or non-positive falls back to 3', () => {
    const prev = process.env.PAPERCUSP_LOOP_NO_TURN_ESCALATE_AFTER;
    try {
      process.env.PAPERCUSP_LOOP_NO_TURN_ESCALATE_AFTER = '5';
      expect(noTurnWedgeEscalateAfter()).toBe(5);
      for (const bad of ['0', '-2', 'many', '']) {
        process.env.PAPERCUSP_LOOP_NO_TURN_ESCALATE_AFTER = bad;
        expect(noTurnWedgeEscalateAfter()).toBe(3);
      }
    } finally {
      if (prev === undefined) delete process.env.PAPERCUSP_LOOP_NO_TURN_ESCALATE_AFTER;
      else process.env.PAPERCUSP_LOOP_NO_TURN_ESCALATE_AFTER = prev;
    }
  });
});
