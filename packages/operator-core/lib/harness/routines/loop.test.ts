import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';

// Mock B-LOOP-1's upsertRoutine seam so we can assert the EXACT loop-routine row
// materializeLoop produces — the row fd5c0's fire (loop-fire.ts) + su-15ea2's
// completion-rebase consume. vi.hoisted so the spy exists when vi.mock hoists.
//
// EI-7613: materializeLoop now ALSO calls stampLoopArmedAt(sql, …) after every upsert
// (the dead-man clock's re-arm fix) — a bare `sql: {}` is not callable as a tagged
// template, so that best-effort UPDATE threw "db is not a function" and console.warn'd,
// which vitest-fail-on-console turns into a hard test failure across every materializeLoop
// case. `sqlStub` is a minimal callable tagged-template stand-in (resolves to `[]`) so
// that internal call succeeds silently, exactly like a real (if inert) postgres client.
const { upsertRoutineSpy, sqlStub, orgSqlHolder } = vi.hoisted(() => ({
  upsertRoutineSpy: vi.fn(),
  sqlStub: (_strings: TemplateStringsArray, ..._values: unknown[]) => Promise.resolve([]),
  orgSqlHolder: { sql: null as unknown },
}));

/**
 * Fake postgres client for tests that inject a client into boundedPgReadTxn.
 * Keep the query function as the tagged-template implementation so existing
 * tests can still capture strings/values or use a vi.fn mock, while begin()
 * supplies the same client as the transaction and preserves unsafe/array
 * interpolation helpers.
 */
type TransactionalFakeSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  begin: <T>(callback: (tx: TransactionalFakeSql) => Promise<T>) => Promise<T>;
  unsafe: (identifier: string) => unknown;
  array: (values: unknown[]) => unknown;
};

function transactionalSql(
  query: (strings: TemplateStringsArray, ...values: unknown[]) => unknown | Promise<unknown> = () => [],
): TransactionalFakeSql {
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    Promise.resolve(query(strings, ...values))) as TransactionalFakeSql;
  const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    // boundedPgReadTxn installs this setting before invoking the caller. It is
    // transaction plumbing, not one of the injected query's results/captures.
    if (/set_config\(\s*'statement_timeout'/i.test(strings.join(''))) return Promise.resolve([]);
    return Promise.resolve(query(strings, ...values));
  }) as TransactionalFakeSql;
  sql.begin = async <T>(callback: (tx: TransactionalFakeSql) => Promise<T>) => callback(tx);
  tx.begin = sql.begin;
  for (const client of [sql, tx]) {
    client.unsafe = (identifier: string) => identifier;
    client.array = (values: unknown[]) => values;
  }
  return sql;
}

// EI-14928 root-cause class: a MINIMAL factory here (only getOrgPg/upsertRoutine)
// crashes vitest COLLECTION whenever some OTHER db-org export is dereferenced at
// module scope anywhere in this file's transitive import graph (e.g. autoloop.ts's
// `generated.autoloopStateInHarnessShared`) — the composed graph varies by which
// other test files share this worker, so the crash is run-order-dependent, not
// deterministic per-commit. Spread importOriginal so every real export (including
// `generated`, pure drizzle table defs) stays present; only override what this
// file actually needs to stub.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: orgSqlHolder.sql ?? sqlStub }),
  upsertRoutine: upsertRoutineSpy,
}));

// Alarm delivery has its own rail tests; loop materialization stays isolated from
// the shared condition stream even when an unbounded re-arm clears an old alarm.
vi.mock('../../alarm-attention', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../alarm-attention')>()),
  resolveAlarm: vi.fn(async () => true),
}));

// autoArmFleetMemberLoop (kickoff-prompt-absorption-2026-07-17 P-001) reads the
// LOOPS flag and best-effort arms an inbox-wake — both mocked so its unit tests
// stay pure (no PG, no live flag resolver).
const { getFlagSpy, armInboxWakeSpy, getClaimSpecRecordSpy } = vi.hoisted(() => ({
  getFlagSpy: vi.fn(async () => true),
  armInboxWakeSpy: vi.fn(async () => ({ awaitId: 1, eventKey: 'k', handleNote: 'n', minSleepSec: 60 })),
  getClaimSpecRecordSpy: vi.fn(),
}));
vi.mock('@papercusp/flags/server', () => ({ getFlag: getFlagSpy }));
vi.mock('@papercusp/flags', () => ({ FLAGS: { LOOPS: 'papercusp-loops' } }));
vi.mock('../../events/await/inbox-wake-arm', () => ({ armInboxWake: armInboxWakeSpy }));
vi.mock('../../scheduler/claim-spec-store', () => ({ getClaimSpecRecord: getClaimSpecRecordSpy }));

const { recordLoopTransitionSpy } = vi.hoisted(() => ({
  recordLoopTransitionSpy: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock('./loop-transition-log', () => ({ recordLoopTransition: recordLoopTransitionSpy }));

import {
  materializeLoop,
  deactivateLoop,
  deactivateLoopForGoal,
  buildLoopWakePrompt,
  detectDrivenWorkItemId,
  loopRoutineName,
  computeLoopStall,
  computeLoopFireStarvation,
  LOOP_FIRE_STARVATION_MIN_MISSED_OPPORTUNITIES,
  computeTurnsStalled,
  computeLifecycleBackoff,
  TURNS_STALLED_MIN_FIRE_COUNT,
  autoArmFleetMemberLoop,
  readActiveLoopFacts,
  getLoopStatuses,
  computeLoopCadence,
  computeCadenceDrift,
  LOOP_WAKE_ACTION,
  LOOP_INTERVAL_FLOOR_SEC,
  LOOP_END_PAUSE_PREFIX,
  countAgentToolCallsInWindow,
} from './loop';
import { resolveAlarm } from '../../alarm-attention';

describe('getLoopStatuses — default client acquisition attribution (EI-25884587459468153)', () => {
  it('labels the getOrgPg client as org-admin when its connection acquisition times out', async () => {
    vi.useFakeTimers();
    const { resetAcquireRegistryForTest } = await import('@papercusp/db-org');
    resetAcquireRegistryForTest();
    orgSqlHolder.sql = { begin: () => new Promise(() => {}) };
    try {
      const pending = getLoopStatuses(['su-x']).then(
        () => null,
        (error: unknown) => error as { pool: string | null; message: string },
      );

      await vi.advanceTimersByTimeAsync(8_001);
      const error = await pending;

      expect(error).not.toBeNull();
      expect(error?.pool).toBe('org-admin');
      expect(error?.message).toContain('acquirePool=org-admin');
    } finally {
      orgSqlHolder.sql = null;
      resetAcquireRegistryForTest();
      vi.useRealTimers();
    }
  });
});

describe('buildLoopWakePrompt — instructs VALID work-item states (EI-6978)', () => {
  const prompt = buildLoopWakePrompt({ ownerId: 'su-x', intervalSec: 60, harness: 'papercusp', goal: 'do the thing' });

  it('does NOT carry the old broken directive "in_progress → completed" ("completed" is not a valid state, rejected every wake)', () => {
    expect(prompt).not.toContain('in_progress → completed');
  });

  it('directs terminal completion through work_items:complete, never a bare "done" assertion', () => {
    // fleet-member-native-guidance-2026-07-10 P-008: the exact call signature
    // (`state:'done'`) is now the persona's + the tool's own guidance to state, not
    // re-spelled in the wake prompt — the prompt just points at the contract.
    expect(prompt).toContain('work_items:complete');
    expect(prompt).toContain('never a bare "done" assertion');
  });

  it("does not prescribe a specific mid-work state literal (delegated to work_items:set_state's own EI-7478 aliasing guidance)", () => {
    // The prompt no longer mentions in_progress at all — it would be redundant with
    // (and risked drifting from) the tool's own description of issue-family state aliasing.
    expect(prompt).not.toContain("state:'in_progress'");
  });

  it('substitutes the template vars (no unreplaced {goal}/{harness}/{ownerId})', () => {
    expect(prompt).toContain('do the thing');
    expect(prompt).toContain('papercusp');
    expect(prompt).toContain('su-x');
    expect(prompt).not.toMatch(/\{(goal|harness|ownerId|intervalSec)\}/);
  });

  it('wraps the replayed goal itself with agent-authored provenance markers', () => {
    expect(prompt).toContain('⟦agent-authored-goal⟧do the thing⟦/agent-authored-goal⟧');
  });
});

describe('buildLoopWakePrompt — kind guidance is not hardcoded to task (EI-7674)', () => {
  const prompt = buildLoopWakePrompt({ ownerId: 'su-x', intervalSec: 60, harness: 'papercusp', goal: 'do the thing' });

  it("does NOT hardcode kind:'task' as the create example — task is NON-CODE only and most loop-driven work is code", () => {
    expect(prompt).not.toContain("kind:'task'");
  });

  it("tells the agent to pick kind by what the unit IS (fleet-member-native-guidance P-008: delegated to the persona's member-loop contract, not re-spelled per-wake)", () => {
    expect(prompt).toMatch(/pick `kind` by what it IS/);
    expect(prompt).toContain('Working as a fleet MEMBER — the member operating loop');
  });

  it('the kind/state mechanics (bug/change/task, the in_progress alias) are no longer spelled out per-wake — the persona + tool guidance own them now', () => {
    expect(prompt).not.toContain('a bug/change/task item is issue-family');
    expect(prompt).not.toContain("kind:'change'");
  });
});

describe('computeLoopStall (P2b — parked-healthy vs parked-dead)', () => {
  const STUCK = 30 * 60_000; // max(30min, 4×interval) for a ≤7.5min interval
  const NOW = 1_800_000_000_000; // arbitrary fixed epoch ms
  /** Build an input the way production does, where `parkedMs` IS `now - last_fired_at`, so
   *  the park duration and the fire timestamp can never disagree (WI-6639: they are the two
   *  halves of the same fact, and the old boolean interface let them drift apart). */
  const parkedFor = (
    parkedMs: number,
    o: { intervalSec?: number; completion?: boolean; lastActiveAtMs?: number | null } = {},
  ) => ({
    parked: true,
    parkedMs,
    intervalSec: o.intervalSec ?? 120,
    hasCompletionSinceFire: o.completion ?? false,
    lastFiredAtMs: NOW - parkedMs,
    lastActiveAtMs: o.lastActiveAtMs ?? null,
    nowMs: NOW,
  });

  it('not parked → never stalled', () => {
    expect(computeLoopStall({ ...parkedFor(99e9), parked: false })).toEqual({ stalled: false, stalledSinceMs: null });
  });
  it('parked but recently (under the stuck threshold) → healthy in-flight', () => {
    expect(computeLoopStall(parkedFor(60_000)).stalled).toBe(false);
  });
  it('parked long, no completion, no activity → STALLED with the parked duration', () => {
    const r = computeLoopStall(parkedFor(STUCK + 1000));
    expect(r.stalled).toBe(true);
    expect(r.stalledSinceMs).toBe(STUCK + 1000);
  });
  it('parked long but a completion marker exists → NOT stalled (the turn finished)', () => {
    expect(computeLoopStall(parkedFor(STUCK + 1000, { completion: true })).stalled).toBe(false);
  });
  it('parked long but the session is active RIGHT NOW → NOT stalled (a legitimately long turn)', () => {
    // Presence is both after the fire and fresh — the exemption this guard exists for.
    expect(computeLoopStall(parkedFor(STUCK + 1000, { lastActiveAtMs: NOW - 60_000 })).stalled).toBe(false);
  });

  // ── WI-6639 regression: the frozen-liveness blind spot ──────────────────────
  it('WI-6639: presence a minute AFTER the final fire, then dead for 160h → STALLED', () => {
    // THE BUG. `activeSinceFire` used to be the caller-computed `presence > lastFired`, a
    // comparison of two PAST instants. This session emitted one last beat just after its
    // final fire and then died, which pinned that boolean true FOREVER and permanently
    // disarmed the park check — measured live as 12 loops parked at 'infinity' for
    // 49h–160h, every one of them reporting `stalled: false`.
    const parkedMs = 160 * 60 * 60_000;
    const r = computeLoopStall(parkedFor(parkedMs, { lastActiveAtMs: NOW - parkedMs + 60_000 }));
    expect(r.stalled).toBe(true);
    expect(r.stalledSinceMs).toBe(parkedMs);
  });
  it('WI-6639: presence after the fire but older than the floor → STALLED (liveness is judged against now)', () => {
    expect(computeLoopStall(parkedFor(STUCK * 3, { lastActiveAtMs: NOW - STUCK - 1000 })).stalled).toBe(true);
  });
  it('WI-6639: presence BEFORE the fire is never an exemption, however fresh the clock', () => {
    // A beat that predates the fire says nothing about the wake turn that followed it.
    expect(computeLoopStall(parkedFor(STUCK + 1000, { lastActiveAtMs: NOW - STUCK - 2000 })).stalled).toBe(true);
  });

  it('the threshold scales to 4×interval for a long interval', () => {
    // interval 1200s → 4× = 4800s = 80min > 30min, so 60min parked is NOT yet stalled.
    expect(computeLoopStall(parkedFor(60 * 60_000, { intervalSec: 1200 })).stalled).toBe(false);
    expect(computeLoopStall(parkedFor(90 * 60_000, { intervalSec: 1200 })).stalled).toBe(true);
  });
});

describe('computeLoopFireStarvation (EI-21301493615546911 — no post-arm fire)', () => {
  const NOW = 1_800_000_000_000;
  const armedAtMs = NOW - 10 * 60_000;
  const base = {
    active: true,
    parked: true,
    firesSinceArm: 0,
    expectedFiresSinceArm: LOOP_FIRE_STARVATION_MIN_MISSED_OPPORTUNITIES,
    armedAtMs,
    lastFiredAtMs: armedAtMs - 60_000,
    lastActiveAtMs: armedAtMs - 60 * 60_000,
    intervalSec: 60,
    nowMs: NOW,
  };

  it('flags an active parked loop after three missed opportunities with no post-arm fire', () => {
    expect(computeLoopFireStarvation(base)).toBe(true);
  });

  it('stays quiet before the three-opportunity floor', () => {
    expect(
      computeLoopFireStarvation({
        ...base,
        expectedFiresSinceArm: LOOP_FIRE_STARVATION_MIN_MISSED_OPPORTUNITIES - 1,
      }),
    ).toBe(false);
  });

  it('stays quiet when any post-arm fire is recorded, even if the count lags', () => {
    expect(
      computeLoopFireStarvation({
        ...base,
        firesSinceArm: 1,
        expectedFiresSinceArm: 10,
        lastFiredAtMs: armedAtMs + 1,
      }),
    ).toBe(false);
  });

  it('stays quiet for an unparked loop when its next fire is unknown or still in the future', () => {
    expect(computeLoopFireStarvation({ ...base, parked: false })).toBe(false);
    expect(computeLoopFireStarvation({ ...base, parked: false, nextFireAtMs: NOW + 1_000 })).toBe(false);
  });

  it('flags an active unparked loop when its concrete next fire is overdue', () => {
    expect(computeLoopFireStarvation({ ...base, parked: false, nextFireAtMs: NOW - 1_000 })).toBe(true);
  });

  it('stays quiet for an inactive loop', () => {
    expect(computeLoopFireStarvation({ ...base, active: false })).toBe(false);
  });

  it('stays quiet when the owner has recent activity (a legitimate long first turn)', () => {
    expect(computeLoopFireStarvation({ ...base, lastActiveAtMs: NOW - 1_000 })).toBe(false);
  });

  describe('WI-6554700010012442 — presence must not mask a loop whose arming turn already ended', () => {
    // Observed 2026-10-14 (su-1055507e): parked ~66 min, firesSinceArm 0 vs expected 52,
    // while inbox wakes and fleet awaits kept the presence beat fresh. A fresh beat can
    // only excuse zero fires while the arming turn is still running. A later prompt proves
    // that turn ended, so after the floor the loop should have fired.
    const observed = {
      ...base,
      armedAtMs: NOW - 66 * 60_000,
      lastFiredAtMs: null,
      expectedFiresSinceArm: 52,
      lastActiveAtMs: NOW - 5_000,
    };

    it('flags a parked never-fired loop with fresh presence once a post-arm prompt is past the floor', () => {
      expect(
        computeLoopFireStarvation({ ...observed, firstPromptAfterArmAtMs: NOW - 60 * 60_000 }),
      ).toBe(true);
    });

    it('stays quiet while the first post-arm prompt is younger than the floor', () => {
      expect(
        computeLoopFireStarvation({ ...observed, firstPromptAfterArmAtMs: NOW - 2 * 60_000 }),
      ).toBe(false);
    });

    it('stays quiet with fresh presence and no post-arm prompt (the arming turn may still be running)', () => {
      expect(computeLoopFireStarvation({ ...observed, firstPromptAfterArmAtMs: null })).toBe(false);
      expect(computeLoopFireStarvation(observed)).toBe(false);
    });

    it('ignores a prompt timestamp at or before the arm', () => {
      expect(computeLoopFireStarvation({ ...observed, firstPromptAfterArmAtMs: observed.armedAtMs })).toBe(false);
      expect(computeLoopFireStarvation({ ...observed, firstPromptAfterArmAtMs: Number.NaN })).toBe(false);
    });

    it('still requires an overdue concrete next fire for an unparked loop', () => {
      const settled = { ...observed, parked: false, firstPromptAfterArmAtMs: NOW - 60 * 60_000 };
      expect(computeLoopFireStarvation({ ...settled, nextFireAtMs: NOW + 1_000 })).toBe(false);
      expect(computeLoopFireStarvation({ ...settled, nextFireAtMs: NOW - 1_000 })).toBe(true);
    });
  });

  it('allows a never-fired loop with no fire timestamp to be diagnosed once the floor is crossed', () => {
    expect(computeLoopFireStarvation({ ...base, lastFiredAtMs: null })).toBe(true);
  });
});

describe('computeTurnsStalled (EI-18712914572668391 — fires attempted vs turns produced)', () => {
  const NOW = 1_800_000_000_000; // arbitrary fixed epoch ms
  const intervalSec = 300; // 300s, matches the incident this item was filed on

  it('inactive loop → never flagged, regardless of the gap', () => {
    expect(
      computeTurnsStalled({
        active: false,
        fireCount: 50,
        lastFiredAtMs: NOW,
        lastTurnAtMs: NOW - 10 * 60 * 60_000,
        intervalSec,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it('fewer than TURNS_STALLED_MIN_FIRE_COUNT fires → never flagged (no trend yet, avoid startup noise)', () => {
    expect(TURNS_STALLED_MIN_FIRE_COUNT).toBeGreaterThan(1);
    expect(
      computeTurnsStalled({
        active: true,
        fireCount: TURNS_STALLED_MIN_FIRE_COUNT - 1,
        lastFiredAtMs: NOW,
        lastTurnAtMs: null, // even the strongest signal (no turn EVER) is suppressed pre-threshold
        intervalSec,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it('no last-fired timestamp → nothing to compare against, never flagged', () => {
    expect(
      computeTurnsStalled({
        active: true,
        fireCount: 10,
        lastFiredAtMs: null,
        lastTurnAtMs: null,
        intervalSec,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it('NO turn has EVER completed for this owner, yet several fires landed → flagged (the strongest signal)', () => {
    expect(
      computeTurnsStalled({
        active: true,
        fireCount: TURNS_STALLED_MIN_FIRE_COUNT,
        lastFiredAtMs: NOW,
        lastTurnAtMs: null,
        intervalSec,
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it('the incident this item was filed on: 36 fires over ~3h @300s interval, carry-note/turn frozen ~3h behind → flagged', () => {
    // Mirrors the filed evidence: fireCount:36, armed 10:09, lastFiredAt 13:04 — the
    // session's last real activity (carry-note write) sat frozen at 10:08, ~3h behind.
    expect(
      computeTurnsStalled({
        active: true,
        fireCount: 36,
        lastFiredAtMs: NOW,
        lastTurnAtMs: NOW - 3 * 60 * 60_000, // ~3h behind the most recent fire
        intervalSec,
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it('a turn completed recently relative to the last fire (within the generous floor) → NOT flagged (healthy)', () => {
    expect(
      computeTurnsStalled({
        active: true,
        fireCount: 10,
        lastFiredAtMs: NOW,
        lastTurnAtMs: NOW - 2 * 60_000, // 2min behind — a normal in-flight turn
        intervalSec,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it('EI-21303383797798186: recent manual turns cannot mask a missing loop-origin completion', () => {
    expect(
      computeTurnsStalled({
        active: true,
        fireCount: TURNS_STALLED_MIN_FIRE_COUNT,
        lastFiredAtMs: NOW,
        lastTurnAtMs: NOW - 10_000, // owner-prompted assistant output is fresh
        lastLoopTurnAtMs: null, // but no autonomous loop turn completed
        intervalSec,
        nowMs: NOW,
      }),
    ).toBe(true);

    expect(
      computeTurnsStalled({
        active: true,
        fireCount: TURNS_STALLED_MIN_FIRE_COUNT,
        lastFiredAtMs: NOW,
        lastTurnAtMs: NOW - 10_000,
        lastLoopTurnAtMs: NOW - 5_000,
        intervalSec,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  // ── WI-6639 regression: the frozen-gap blind spot ───────────────────────────
  it('WI-6639: fires STOPPED too, so the fired-vs-turn gap froze small → still flagged', () => {
    // The measured population: last turn landed 4min after the last fire, then the whole
    // loop went silent for 156h. `lastFiredAtMs - lastTurnAtMs` is NEGATIVE here, so the
    // original gap check read healthy forever — 11 of 14 dead loops reported false.
    const dead = 156 * 60 * 60_000;
    expect(
      computeTurnsStalled({
        active: true,
        fireCount: 157,
        lastFiredAtMs: NOW - dead,
        lastTurnAtMs: NOW - dead + 4 * 60_000,
        lastActiveAtMs: NOW - dead + 5 * 60_000,
        intervalSec,
        nowMs: NOW,
      }),
    ).toBe(true);
  });

  it('WI-6639: a quiet-but-ALIVE session (fresh presence) is not flagged by the new clause', () => {
    // Guards the fix against false positives: fires are stale but the session is provably
    // active right now, so this is a long turn in flight, not a corpse.
    expect(
      computeTurnsStalled({
        active: true,
        fireCount: 20,
        lastFiredAtMs: NOW - 4 * 60 * 60_000,
        lastTurnAtMs: NOW - 4 * 60 * 60_000 + 60_000,
        lastActiveAtMs: NOW - 30_000, // beating right now
        intervalSec,
        nowMs: NOW,
      }),
    ).toBe(false);
  });

  it("the floor scales to 4×interval for a long-interval loop, mirroring computeLoopStall's own floor", () => {
    const longIntervalSec = 1200; // 4× = 80min > the 30min base floor
    expect(
      computeTurnsStalled({
        active: true,
        fireCount: 10,
        lastFiredAtMs: NOW,
        lastTurnAtMs: NOW - 60 * 60_000, // 60min behind — under the scaled 80min floor
        intervalSec: longIntervalSec,
        nowMs: NOW,
      }),
    ).toBe(false);
    expect(
      computeTurnsStalled({
        active: true,
        fireCount: 10,
        lastFiredAtMs: NOW,
        lastTurnAtMs: NOW - 90 * 60_000, // 90min behind — past the scaled 80min floor
        intervalSec: longIntervalSec,
        nowMs: NOW,
      }),
    ).toBe(true);
  });
});

describe('computeLifecycleBackoff (EI-19325288514307343 — backed-off vs dead, without opening the escalation queue)', () => {
  const NOW2 = Date.parse('2026-08-02T21:00:00.000Z');

  it('is null when the loop is not active — nothing to "resume"', () => {
    expect(
      computeLifecycleBackoff({
        active: false,
        lastDeliveryOutcome: 'loop-lifecycle-death:usage_limit',
        nextFireAtIso: new Date(NOW2 + 3_600_000).toISOString(),
        nowMs: NOW2,
      }),
    ).toBeNull();
  });

  it('is null when the last recorded outcome is not a lifecycle-death (the common/healthy case)', () => {
    for (const outcome of [null, 'ok', 'loop-lifecycle', 'loop-stuck-backstop']) {
      expect(
        computeLifecycleBackoff({
          active: true,
          lastDeliveryOutcome: outcome,
          nextFireAtIso: new Date(NOW2 + 60_000).toISOString(),
          nowMs: NOW2,
        }),
      ).toBeNull();
    }
  });

  it('extracts the reason suffix and the resume window from a lifecycle-death outcome', () => {
    const until = new Date(NOW2 + 3_607_000).toISOString();
    expect(
      computeLifecycleBackoff({
        active: true,
        lastDeliveryOutcome: 'loop-lifecycle-death:usage_limit',
        nextFireAtIso: until,
        nowMs: NOW2,
      }),
    ).toEqual({ reason: 'usage_limit', until, resumesInMs: 3_607_000 });
  });

  it('clears itself the instant a LATER fire records a normal outcome — never a sticky flag', () => {
    // Same routine, but the most recent recordFire call overwrote last_status after a
    // successful retry: lastDeliveryOutcome no longer carries the lifecycle-death prefix.
    expect(
      computeLifecycleBackoff({
        active: true,
        lastDeliveryOutcome: 'loop-lifecycle',
        nextFireAtIso: new Date(NOW2 + 60_000).toISOString(),
        nowMs: NOW2,
      }),
    ).toBeNull();
  });

  it('defaults an empty reason suffix to "unknown" rather than an empty string', () => {
    const out = computeLifecycleBackoff({
      active: true,
      lastDeliveryOutcome: 'loop-lifecycle-death:',
      nextFireAtIso: new Date(NOW2 + 60_000).toISOString(),
      nowMs: NOW2,
    });
    expect(out?.reason).toBe('unknown');
  });

  it('clamps resumesInMs to 0 rather than going negative when nextFireAt is already in the past', () => {
    const past = new Date(NOW2 - 60_000).toISOString();
    const out = computeLifecycleBackoff({
      active: true,
      lastDeliveryOutcome: 'loop-lifecycle-death:rate_limited',
      nextFireAtIso: past,
      nowMs: NOW2,
    });
    expect(out).toEqual({ reason: 'rate_limited', until: past, resumesInMs: 0 });
  });

  it('reports resumesInMs:null when nextFireAt is null (defensive — should not happen while active+un-parked)', () => {
    const out = computeLifecycleBackoff({
      active: true,
      lastDeliveryOutcome: 'loop-lifecycle-death:usage_limit',
      nextFireAtIso: null,
      nowMs: NOW2,
    });
    expect(out).toEqual({ reason: 'usage_limit', until: null, resumesInMs: null });
  });

  // EI-19381528967421062: loop-turn-outcome.ts's FAST observer (the common path — it
  // reacts the instant a resume turn's exit is seen, not the reconcile backstop) writes
  // `resume-turn-death:<klass>` via recordFire, NOT `loop-lifecycle-death:`. Before this
  // fix that prefix was invisible here, so a loop rate-limited through the fast path read
  // `lifecycleBackoff: null` while `nextFireAt` sat ~100 intervals out — silently absent,
  // not merely stale (measured live: EI-19381528967421062's own reporter hit exactly this).
  it('also recognizes resume-turn-death: (the fast-observer prefix), not just loop-lifecycle-death:', () => {
    const until = new Date(NOW2 + 6_000_000).toISOString();
    expect(
      computeLifecycleBackoff({
        active: true,
        lastDeliveryOutcome: 'resume-turn-death:rate_limited',
        nextFireAtIso: until,
        nowMs: NOW2,
      }),
    ).toEqual({ reason: 'rate_limited', until, resumesInMs: 6_000_000 });
  });

  it('extracts the reason suffix from a resume-turn-death: outcome the same way as loop-lifecycle-death:', () => {
    const until = new Date(NOW2 + 3_600_000).toISOString();
    const a = computeLifecycleBackoff({
      active: true,
      lastDeliveryOutcome: 'loop-lifecycle-death:usage_limit',
      nextFireAtIso: until,
      nowMs: NOW2,
    });
    const b = computeLifecycleBackoff({
      active: true,
      lastDeliveryOutcome: 'resume-turn-death:usage_limit',
      nextFireAtIso: until,
      nowMs: NOW2,
    });
    expect(a).toEqual(b);
  });
});

beforeEach(() => {
  upsertRoutineSpy.mockReset();
  recordLoopTransitionSpy.mockReset();
  (resolveAlarm as unknown as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(true);
  // Echo the input back as a plausible RoutineRow (materializeLoop reads .id/.name/.nextFireAt/.targetRole).
  upsertRoutineSpy.mockImplementation(async (_sql: unknown, input: any) => ({
    id: `rt_${input.installSlug}_${input.name}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase(),
    name: input.name,
    installSlug: input.installSlug,
    workspaceId: input.workspaceId,
    triggerKind: input.triggerKind,
    triggerConfig: input.triggerConfig,
    targetRole: input.targetRole,
    payloadTemplate: input.payloadTemplate,
    concurrency: input.concurrency,
    catchup: 'skip-old',
    active: input.active,
    lastFiredAt: null,
    nextFireAt: input.nextFireAt ?? null,
    rescheduleIntervalSec: input.rescheduleIntervalSec ?? null,
    targetOwnerId: input.targetOwnerId ?? null,
  }));
});

describe('deactivateLoop — dead-man condition disposition', () => {
  it('resolves a dead-man alarm when the owner ends a loop already paused by the guard', async () => {
    const sql = vi.fn()
      .mockResolvedValueOnce([{ id: 'rt_ws_loop_su-dead' }])
      .mockResolvedValueOnce([]);

    await expect(deactivateLoop('su-dead', { sql: sql as any, reason: 'intentional wind-down' }))
      .resolves.toBe(false);

    expect(resolveAlarm).toHaveBeenCalledExactlyOnceWith(
      'alarm:loop-dead-man:rt_ws_loop_su-dead',
      'loop-dead-man',
    );
  });

  it('resolves dead-man alarms for every loop row it deactivates', async () => {
    const sql = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 'rt_ws_loop_su-active',
        workspace_id: 'ws',
        install_slug: 'papercusp',
        name: 'loop-su-active',
        target_role: LOOP_WAKE_ACTION,
        reschedule_interval_sec: 60,
      }]);

    await expect(deactivateLoop('su-active', { sql: sql as any })).resolves.toBe(true);

    expect(resolveAlarm).toHaveBeenCalledExactlyOnceWith(
      'alarm:loop-dead-man:rt_ws_loop_su-active',
      'loop-dead-man',
    );
  });
});

describe('deactivateLoopForGoal (EI-21123319355080521)', () => {
  it('deactivates an active loop whose structured goal references the surrendered authority', async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join(' ? '), values });
      return Promise.resolve([
        {
          id: 'rt_goal',
          workspace_id: 'ws',
          install_slug: 'papercusp',
          name: 'loop-su-x',
          target_role: LOOP_WAKE_ACTION,
          target_owner_id: 'su-x',
          reschedule_interval_sec: 60,
        },
      ]);
    }) as any;

    await expect(
      deactivateLoopForGoal('su-x', 'goal-123', {
        sql,
        reason: "mode 'goal' cleared — authority 'goal-123' revoked",
        actor: 'su-x',
      }),
    ).resolves.toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toContain("payload_template->>'goal'");
    expect(calls[0]!.values).toEqual(expect.arrayContaining(['su-x', 'goal-123']));
    expect(recordLoopTransitionSpy).toHaveBeenCalledWith(
      sql,
      expect.objectContaining({
        event: 'disarmed',
        targetOwnerId: 'su-x',
        actor: 'su-x',
        detail: expect.objectContaining({ goalSubject: 'goal-123', authorityRevoked: true }),
      }),
    );
  });

  it('does not touch the database for an empty subject', async () => {
    const sql = vi.fn();
    await expect(deactivateLoopForGoal('su-x', '   ', { sql: sql as any })).resolves.toBe(false);
    expect(sql).not.toHaveBeenCalled();
  });
});

describe('buildLoopWakePrompt (the per-wake template, P-008)', () => {
  it('interpolates the loop specifics and carries the locked B-LOOP-4 self-assign convention', () => {
    const p = buildLoopWakePrompt({
      ownerId: 'su-abc',
      intervalSec: 300,
      harness: 'papercusp',
      goal: 'ship the widget',
    });
    expect(p).toContain('su-abc'); // the owner id the agent self-assigns to
    expect(p).toContain('300'); // the interval
    expect(p).toContain('papercusp'); // the harness
    expect(p).toContain('ship the widget'); // the goal
    // fleet-member-native-guidance-2026-07-10 P-008: the create+self-assign contract
    // (B-LOOP-4 / su-1ec26) now lives natively in the persona's member-loop section —
    // the wake prompt POINTS at it instead of re-spelling the call signature.
    expect(p).toContain('Working as a fleet MEMBER — the member operating loop');
    expect(p).toContain('assign_to');
    // how to stop (don't spin on empty wakes)
    expect(p).toContain('loop:end');
    expect(p).toContain('acknowledgeOpenDirectives:true, acknowledgeWakeLessAutonomy:true');
    // every placeholder was substituted
    expect(p).not.toMatch(/\{(intervalSec|harness|ownerId|goal)\}/);
  });

  // parked-agent-census-resumption-and-root-cause-2026-10-09 P-008: the wake prompts used to
  // teach "blocked externally -> loop:end" and a reflexive acknowledgeWakeLessAutonomy. 100 of
  // 140 self-stopped parkers passed that flag; 51 were AUTO, holding claims, with no wake source.
  it('teaches blocked = set_blocker + bounded await + end turn, never loop:end (P-008)', () => {
    const base = { ownerId: 'su-x', intervalSec: 60, harness: 'papercusp', goal: 'g' };
    const work = buildLoopWakePrompt(base);
    const monitor = buildLoopWakePrompt({ ...base, mode: 'monitor' });
    const driven = buildLoopWakePrompt({ ...base, carry: 'cold', workItem: 'WI-123' });
    for (const p of [work, monitor, driven]) {
      expect(p).not.toContain('call `loop:end` and say why');
      expect(p).not.toContain('(or you are blocked)');
    }
    for (const p of [work, driven]) {
      expect(p).toContain('work_items:set_blocker');
      expect(p).toContain("on_timeout:'wake'");
    }
    expect(work).toContain('work-item:unblocked:<id>');
    expect(work).toContain('Being blocked is never a reason to call `loop:end`');
    // The acknowledgement is scoped to a claimless stop; a claim holder follows the refusal's recovery.
    expect(work).toContain('that acknowledgement covers a claimless stop only');
    for (const p of [work, monitor]) {
      expect(p).toContain('acknowledgeWakeLessAutonomy:true` for a claimless stop');
      expect(p).toContain("follow the refusal's `recovery`");
    }
    expect(driven).toContain('you hold no other unfinished work-items');
    expect(driven).toContain('do not loop:end');
  });

  it('a WARM loop (default / absent carry) is byte-identical — no cold addendum (su-cold-auto P-002)', () => {
    const warmDefault = buildLoopWakePrompt({ ownerId: 'su-x', intervalSec: 60, harness: 'papercusp', goal: 'g' });
    const warmExplicit = buildLoopWakePrompt({
      ownerId: 'su-x',
      intervalSec: 60,
      harness: 'papercusp',
      goal: 'g',
      carry: 'warm',
    });
    expect(warmExplicit).toBe(warmDefault); // explicit warm == absent
    expect(warmDefault).not.toContain('loop:checkpoint');
    expect(warmDefault).not.toContain('COLD loop');
  });

  it('a COLD loop appends the bootstrap addendum instructing loop:checkpoint (so pre-anchor warm wakes seed the first carry-note)', () => {
    const warm = buildLoopWakePrompt({
      ownerId: 'su-x',
      intervalSec: 60,
      harness: 'papercusp',
      goal: 'g',
      carry: 'warm',
    });
    const cold = buildLoopWakePrompt({
      ownerId: 'su-x',
      intervalSec: 60,
      harness: 'papercusp',
      goal: 'g',
      carry: 'cold',
    });
    // the cold prompt is the warm one PLUS the addendum (superset, no base text lost)
    expect(cold.startsWith(warm)).toBe(true);
    expect(cold.length).toBeGreaterThan(warm.length);
    expect(cold).toContain('loop:checkpoint');
    for (const f of ['did', 'left', 'insight', 'next']) expect(cold).toContain(f);
    expect(cold).toContain('COLD loop');
  });

  it('a MONITOR loop gets the lean check/steer/checkpoint contract with NO work-item boilerplate (compaction-continuity P-001c)', () => {
    const monitor = buildLoopWakePrompt({
      ownerId: 'su-x',
      intervalSec: 120,
      harness: 'papercusp',
      goal: 'watch the bug-drain fleet',
      mode: 'monitor',
    });
    // The lean monitoring contract…
    expect(monitor).toContain('Monitor wake');
    expect(monitor).toContain('watch the bug-drain fleet');
    expect(monitor).toContain('120');
    expect(monitor).toContain('deltas');
    expect(monitor).toContain('loop:end');
    expect(monitor).toContain('acknowledgeOpenDirectives:true, acknowledgeWakeLessAutonomy:true');
    // …with NONE of the per-wake work-item contract (the boilerplate a monitor loop burned every wake).
    expect(monitor).not.toContain('work_items:create');
    expect(monitor).not.toContain('assign_to');
    expect(monitor).not.toContain('work_items:complete');
    // every placeholder was substituted
    expect(monitor).not.toMatch(/\{(intervalSec|harness|ownerId|goal)\}/);
  });

  it("mode 'work' (default / absent) is byte-identical to the existing template", () => {
    const workDefault = buildLoopWakePrompt({ ownerId: 'su-x', intervalSec: 60, harness: 'papercusp', goal: 'g' });
    const workExplicit = buildLoopWakePrompt({
      ownerId: 'su-x',
      intervalSec: 60,
      harness: 'papercusp',
      goal: 'g',
      mode: 'work',
    });
    expect(workExplicit).toBe(workDefault);
    expect(workDefault).toContain('Working as a fleet MEMBER — the member operating loop');
  });

  it('the monitor mode composes with the cold/gated addenda like the work mode does', () => {
    const coldMonitor = buildLoopWakePrompt({
      ownerId: 'su-x',
      intervalSec: 60,
      harness: 'papercusp',
      goal: 'g',
      mode: 'monitor',
      carry: 'cold',
    });
    expect(coldMonitor).toContain('Monitor wake');
    expect(coldMonitor).toContain('COLD loop');
  });

  it('a SETTLE loop (default / absent continuation) has no gated addendum (flush-to-proceed P-005)', () => {
    const settleDefault = buildLoopWakePrompt({ ownerId: 'su-x', intervalSec: 60, harness: 'papercusp', goal: 'g' });
    const settleExplicit = buildLoopWakePrompt({
      ownerId: 'su-x',
      intervalSec: 60,
      harness: 'papercusp',
      goal: 'g',
      continuation: 'settle',
    });
    expect(settleExplicit).toBe(settleDefault); // explicit settle == absent
    expect(settleDefault).not.toContain('GATED loop');
    expect(settleDefault).not.toContain('continuation gate');
  });

  it('a GATED loop appends the continuation-gate addendum (superset of the base, no base text lost)', () => {
    const settle = buildLoopWakePrompt({ ownerId: 'su-x', intervalSec: 60, harness: 'papercusp', goal: 'g' });
    const gated = buildLoopWakePrompt({
      ownerId: 'su-x',
      intervalSec: 60,
      harness: 'papercusp',
      goal: 'g',
      continuation: 'gated',
    });
    expect(gated.startsWith(settle)).toBe(true);
    expect(gated.length).toBeGreaterThan(settle.length);
    expect(gated).toContain('GATED loop');
    expect(gated).toContain('CONTINUATION GATE');
    expect(gated).toContain('loop:checkpoint'); // the gate read lives on loop:checkpoint's return
    expect(gated).toContain('work_items:checkpoint'); // flush-first mandate
  });

  it('cold + gated compose (both addenda appended)', () => {
    const both = buildLoopWakePrompt({
      ownerId: 'su-x',
      intervalSec: 60,
      harness: 'papercusp',
      goal: 'g',
      carry: 'cold',
      continuation: 'gated',
    });
    expect(both).toContain('COLD loop');
    expect(both).toContain('GATED loop');
  });

  it('WI-2429 fix A: a COLD loop driving a workItem names it concretely in the prompt (not the soft "if you hold one")', () => {
    const withItem = buildLoopWakePrompt({
      ownerId: 'su-x',
      intervalSec: 60,
      harness: 'papercusp',
      goal: 'g',
      carry: 'cold',
      workItem: 'WI-2339',
    });
    const without = buildLoopWakePrompt({
      ownerId: 'su-x',
      intervalSec: 60,
      harness: 'papercusp',
      goal: 'g',
      carry: 'cold',
    });
    expect(withItem.startsWith(without)).toBe(true); // superset — the concrete line is appended
    expect(withItem).toContain('DRIVING work-item WI-2339');
    expect(withItem).toContain("work_items:complete { id:'WI-2339'");
  });

  it('WI-2429 fix A: a WARM loop ignores workItem in the prompt (the concrete mandate is cold-only)', () => {
    const warm = buildLoopWakePrompt({
      ownerId: 'su-x',
      intervalSec: 60,
      harness: 'papercusp',
      goal: 'g',
      carry: 'warm',
      workItem: 'WI-2339',
    });
    expect(warm).not.toContain('DRIVING work-item');
  });
});

describe('detectDrivenWorkItemId (WI-2429 fix A — goal auto-detect)', () => {
  it('returns the single WI-/EI-/F- id a goal names', () => {
    expect(detectDrivenWorkItemId('root-cause WI-2339 and fix it')).toBe('WI-2339');
    expect(detectDrivenWorkItemId('drive EI-7284 to green')).toBe('EI-7284');
    expect(detectDrivenWorkItemId('implement F-12')).toBe('F-12');
  });
  it('normalizes a lower-case id to canonical upper-case', () => {
    expect(detectDrivenWorkItemId('work wi-2339')).toBe('WI-2339');
  });
  it('returns null when the goal names NO work-item id', () => {
    expect(detectDrivenWorkItemId('keep the fleet healthy')).toBeNull();
    expect(detectDrivenWorkItemId('')).toBeNull();
  });
  it('returns null when the goal is AMBIGUOUS (multiple distinct ids) — never guess which is driven', () => {
    expect(detectDrivenWorkItemId('reconcile WI-1 against WI-2')).toBeNull();
  });
  it('returns null when the only id is explicitly excluded by the goal', () => {
    expect(detectDrivenWorkItemId('continue the scoped plan; ignore WI-1774')).toBeNull();
    expect(detectDrivenWorkItemId('WI-1774 is explicitly excluded from this lane')).toBeNull();
    expect(detectDrivenWorkItemId('do not work on WI-1774')).toBeNull();
  });
  it('a repeated single id is still unambiguous (one distinct id)', () => {
    expect(detectDrivenWorkItemId('WI-5: continue WI-5')).toBe('WI-5');
  });
});

describe('materializeLoop — the loop routine row (consumed by the B-LOOP-3 fire)', () => {
  it('writes a PURE loop row the engine treats as the third recurrence kind', async () => {
    const now = new Date('2026-06-20T00:00:00.000Z');
    const res = await materializeLoop({
      workspaceId: 'ws',
      harnessSlug: 'papercusp',
      ownerId: 'su-pinned',
      intervalSec: 120,
      kickoff: 'do the thing',
      costCapCents: 500,
      now,
    });

    expect(upsertRoutineSpy).toHaveBeenCalledTimes(1);
    const input = upsertRoutineSpy.mock.calls[0][1];

    // A PURE loop: trigger_kind 'cron' (rides listDueCronRoutines) but trigger_config {}
    // (no cron/rrule ⇒ claim.ts parks it at 'infinity' in-flight) + the loop columns set.
    expect(input).toMatchObject({
      installSlug: 'papercusp',
      name: 'loop-su-pinned',
      triggerKind: 'cron',
      triggerConfig: {},
      targetRole: LOOP_WAKE_ACTION,
      concurrency: 'skip',
      active: true,
      rescheduleIntervalSec: 120,
      targetOwnerId: 'su-pinned',
    });

    // The fire reads the wake text from payload_template.kickoff and the cap from .costCapCents.
    expect(input.payloadTemplate).toEqual({ kickoff: 'do the thing', costCapCents: 500 });

    // First fire = now + interval (FINITE, so the existing claim path fires it once; the
    // completion-rebase then owns re-arming the parked loop).
    expect(input.nextFireAt.getTime()).toBe(now.getTime() + 120_000);

    expect(res.name).toBe('loop-su-pinned');
    expect(res.targetRole).toBe(LOOP_WAKE_ACTION);
  });

  it('omits costCapCents from payload_template when no cap is given', async () => {
    await materializeLoop({
      workspaceId: 'ws',
      harnessSlug: 'h',
      ownerId: 'o',
      intervalSec: 60,
      kickoff: 'k',
    });
    const input = upsertRoutineSpy.mock.calls[0][1];
    expect(input.payloadTemplate).toEqual({ kickoff: 'k' });
    expect('costCapCents' in input.payloadTemplate).toBe(false);
  });

  it('stamps customWakePrompt only for an explicitly custom kickoff', async () => {
    await materializeLoop({
      workspaceId: 'ws',
      harnessSlug: 'h',
      ownerId: 'o',
      intervalSec: 60,
      kickoff: 'custom wake instruction',
      customWakePrompt: true,
    });
    expect(upsertRoutineSpy.mock.calls[0][1].payloadTemplate).toEqual({
      kickoff: 'custom wake instruction',
      customWakePrompt: true,
    });
  });

  it('stamps a canonical work-item anchor into payload_template', async () => {
    await materializeLoop({
      workspaceId: 'ws',
      harnessSlug: 'h',
      ownerId: 'o',
      intervalSec: 60,
      kickoff: 'drive the item',
      workItem: 'wi-42',
    });
    expect(upsertRoutineSpy.mock.calls[0][1].payloadTemplate).toEqual({
      kickoff: 'drive the item',
      workItem: 'WI-42',
    });
  });

  it('reads only the strict customWakePrompt marker; legacy rows remain non-custom', async () => {
    const query = vi.fn(async () => [
      {
        active: true,
        reschedule_interval_sec: 60,
        install_slug: 'h',
        // Typed as the production signature (loop.ts: `payload_template: Record<string, unknown> | null`)
        // rather than letting vi.fn() infer the element type from THIS literal. Without the
        // annotation the inferred type requires `customWakePrompt`, which makes the legacy row
        // below — a row that genuinely predates the marker — impossible to express. The point of
        // this test is that such rows exist, so the mock must be able to produce one.
        payload_template: {
          kickoff: 'custom wake instruction',
          customWakePrompt: true,
          workItem: 'wi-42',
        } as Record<string, unknown>,
        fire_count: 2,
        armed_at: null,
      },
    ]);
    const sql = transactionalSql(query);
    const facts = await readActiveLoopFacts('o', { sql: sql as never });
    expect(facts).toMatchObject({
      kickoff: 'custom wake instruction',
      customWakePrompt: true,
      workItem: 'WI-42',
    });

    query.mockResolvedValueOnce([
      {
        active: true,
        reschedule_interval_sec: 60,
        install_slug: 'h',
        payload_template: { kickoff: 'legacy kickoff' },
        fire_count: 2,
        armed_at: null,
      },
    ]);
    const legacyFacts = await readActiveLoopFacts('o', { sql: sql as never });
    expect(legacyFacts?.customWakePrompt).toBe(false);
  });

  it.each([false, true])('records the arm writer attribution (recovery=$0)', async (recovery) => {
    await materializeLoop({
      workspaceId: 'ws', harnessSlug: 'h', ownerId: 'o', intervalSec: 60,
      kickoff: 'owned work', onlyIfInactive: recovery,
    });
    expect(recordLoopTransitionSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      targetOwnerId: 'o', event: 'rearmed',
      actor: recovery ? 'loop-recovery-materialize' : 'loop-explicit-materialize',
    }));
  });

  it.each(['infinity', new Date(NaN), new Date(8_640_000_000_000_000)])('records a parked arm as PostgreSQL infinity (%s)', async (nextFireAt) => {
    upsertRoutineSpy.mockResolvedValueOnce({ id: 'rt_cold', name: 'loop-o', targetRole: LOOP_WAKE_ACTION, nextFireAt });

    await materializeLoop({ workspaceId: 'ws', harnessSlug: 'h', ownerId: 'o', intervalSec: 60, kickoff: 'owned work', carry: 'cold' });

    expect(recordLoopTransitionSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      event: 'rearmed', newNextFireAt: 'infinity',
    }));
  });

  it('stamps carry:"cold" onto payload_template only when armed cold (su-cold-auto P-003)', async () => {
    await materializeLoop({
      workspaceId: 'ws',
      harnessSlug: 'h',
      ownerId: 'o',
      intervalSec: 60,
      kickoff: 'k',
      carry: 'cold',
    });
    expect(upsertRoutineSpy.mock.calls[0][1].payloadTemplate).toEqual({ kickoff: 'k', carry: 'cold' });
  });

  it('parks a never-fired cold loop until its first carry-note settles the arming turn', async () => {
    const now = new Date('2026-08-22T08:00:00.000Z');
    await materializeLoop({
      workspaceId: 'ws',
      harnessSlug: 'h',
      ownerId: 'o',
      intervalSec: 60,
      kickoff: 'k',
      carry: 'cold',
      now,
    });

    // A finite arm-time schedule can be claimed while the long loop:arm turn is still
    // settling. The first cold fire must start parked; reconcile releases it only after a
    // carry-note newer than metadata.armed_at exists (EI-20988940040434762).
    expect(upsertRoutineSpy.mock.calls[0][1].nextFireAt).toBe('infinity');
  });

  it('stamps continuation:"gated" onto payload_template only when armed gated (flush-to-proceed P-005)', async () => {
    await materializeLoop({
      workspaceId: 'ws',
      harnessSlug: 'h',
      ownerId: 'o',
      intervalSec: 60,
      kickoff: 'k',
      continuation: 'gated',
    });
    expect(upsertRoutineSpy.mock.calls[0][1].payloadTemplate).toEqual({ kickoff: 'k', continuation: 'gated' });
  });

  it('a SETTLE (or absent) continuation leaves payload_template byte-identical to today (no continuation key)', async () => {
    await materializeLoop({
      workspaceId: 'ws',
      harnessSlug: 'h',
      ownerId: 'o',
      intervalSec: 60,
      kickoff: 'k',
      continuation: 'settle',
    });
    const input = upsertRoutineSpy.mock.calls[0][1];
    expect(input.payloadTemplate).toEqual({ kickoff: 'k' });
    expect('continuation' in input.payloadTemplate).toBe(false);
  });

  it('a WARM (or absent) carry leaves payload_template byte-identical to today (no carry key)', async () => {
    await materializeLoop({
      workspaceId: 'ws',
      harnessSlug: 'h',
      ownerId: 'o',
      intervalSec: 60,
      kickoff: 'k',
      carry: 'warm',
    });
    const input = upsertRoutineSpy.mock.calls[0][1];
    expect(input.payloadTemplate).toEqual({ kickoff: 'k' });
    expect('carry' in input.payloadTemplate).toBe(false);
  });

  it("WI-5345: stamps mode:'monitor' onto payload_template only when armed with mode:'monitor'", async () => {
    await materializeLoop({
      workspaceId: 'ws',
      harnessSlug: 'h',
      ownerId: 'o',
      intervalSec: 60,
      kickoff: 'k',
      mode: 'monitor',
    });
    expect(upsertRoutineSpy.mock.calls[0][1].payloadTemplate).toEqual({ kickoff: 'k', mode: 'monitor' });
  });

  it('anti-babysitting P-003: persists admitted monitor policy on the existing payload_template', async () => {
    const monitor = {
      predicateKey: 'release:green:papercusp',
      stopCondition: 'exact green verdict exists',
      noDeltaBudget: 1,
      remainingNoDeltaBudget: 1,
      authority: { kind: 'work-item' as const, workItem: 'WI-42' },
    };
    await materializeLoop({
      workspaceId: 'ws',
      harnessSlug: 'h',
      ownerId: 'o',
      intervalSec: 60,
      kickoff: 'k',
      mode: 'monitor',
      monitor,
    });
    expect(upsertRoutineSpy.mock.calls[0][1].payloadTemplate).toEqual({
      kickoff: 'k',
      mode: 'monitor',
      monitor,
    });
  });

  it('WI-5345: a WORK (or absent) mode leaves payload_template byte-identical to today (no mode key)', async () => {
    await materializeLoop({
      workspaceId: 'ws',
      harnessSlug: 'h',
      ownerId: 'o',
      intervalSec: 60,
      kickoff: 'k',
      mode: 'work',
    });
    const input = upsertRoutineSpy.mock.calls[0][1];
    expect(input.payloadTemplate).toEqual({ kickoff: 'k' });
    expect('mode' in input.payloadTemplate).toBe(false);
  });

  it('honours an explicit firstFireInSec (first wake sooner than one interval)', async () => {
    const now = new Date('2026-06-20T00:00:00.000Z');
    await materializeLoop({
      workspaceId: 'ws',
      harnessSlug: 'h',
      ownerId: 'o',
      intervalSec: 600,
      kickoff: 'k',
      firstFireInSec: 60,
      now,
    });
    const input = upsertRoutineSpy.mock.calls[0][1];
    expect(input.nextFireAt.getTime()).toBe(now.getTime() + 60_000);
  });
});

describe('autoArmFleetMemberLoop (kickoff-prompt-absorption-2026-07-17 P-001)', () => {
  const baseOpts = {
    workspaceId: 'ws',
    ownerId: 'su-member-1',
    harnessSlug: 'papercusp',
    planSlug: 'backlog-drain-2026-07-16',
    fleetSlug: 'backlog-drain',
    fleetRole: 'member',
  };

  // A minimal fake tagged-template sql matching the shared sqlStub's contract
  // (always resolves []) — sufficient for both getLoopStatuses' SELECT (0 rows
  // ⇒ not-armed) and materializeLoop's FOR-UPDATE existing-check (0 rows ⇒ the
  // insert branch, which routes through the mocked `upsertRoutine` regardless
  // of which sql instance was passed in).
  const emptySql = transactionalSql();

  beforeEach(() => {
    getFlagSpy.mockReset().mockResolvedValue(true);
    armInboxWakeSpy.mockReset().mockResolvedValue({ awaitId: 1, eventKey: 'k', handleNote: 'n', minSleepSec: 60 });
    getClaimSpecRecordSpy.mockReset().mockResolvedValue({
      source: 'fleet',
      fleetSlug: 'backlog-drain',
      harnessSlug: 'papercusp',
      revision: 5,
      updatedBy: 'su-leader',
      updatedAt: '2026-08-31T00:00:00.000Z',
      spec: {
        specId: 'fleet:backlog-drain',
        revision: 5,
        states: ['open'],
        view: { filter: { field: 'kind', op: '=', value: 'bug' } },
      },
    });
  });

  it('skips a LEADER — never auto-arms outside the member role', async () => {
    const res = await autoArmFleetMemberLoop({ ...baseOpts, fleetRole: 'leader', sql: emptySql as any });
    expect(res).toEqual({ armed: false, reason: 'not-a-member' });
    expect(getFlagSpy).not.toHaveBeenCalled();
  });

  it('arms a planless member from its authored fleet claim-spec mission', async () => {
    const res = await autoArmFleetMemberLoop({ ...baseOpts, planSlug: null, sql: emptySql as any });
    expect(res).toMatchObject({ armed: true, reason: 'armed', loopName: 'loop-su-member-1' });
    expect(getClaimSpecRecordSpy).toHaveBeenCalledWith(
      { cupId: 'su-member-1', workspaceId: 'ws' },
      emptySql,
    );
    const insertInput = upsertRoutineSpy.mock.calls.at(-1)?.[1];
    expect(insertInput.payloadTemplate.goal).toContain('fleet:backlog-drain');
    expect(insertInput.payloadTemplate.goal).toContain('backlog-drain');
    expect(insertInput.payloadTemplate.goal).toContain('scheduler:get_next');
  });

  it('fails closed when a planless fleet membership has no authored sentinel', async () => {
    getClaimSpecRecordSpy.mockResolvedValueOnce({
      source: 'default',
      fleetSlug: 'backlog-drain',
      spec: { specId: 'default', states: ['open'], view: {} },
      revision: null,
      updatedBy: null,
      updatedAt: null,
    });

    const res = await autoArmFleetMemberLoop({ ...baseOpts, planSlug: null, sql: emptySql as any });

    expect(res).toEqual({ armed: false, reason: 'fleet-claim-spec-unresolved' });
    expect(upsertRoutineSpy).not.toHaveBeenCalled();
  });

  it('fails closed when a planless member has no claim-spec binding at all', async () => {
    getClaimSpecRecordSpy.mockResolvedValueOnce({
      source: 'default',
      spec: { specId: 'default', states: ['open'], view: {} },
      revision: null,
      updatedBy: null,
      updatedAt: null,
    });

    const res = await autoArmFleetMemberLoop({ ...baseOpts, planSlug: null, sql: emptySql as any });

    expect(res).toEqual({ armed: false, reason: 'no-claim-spec-bound' });
    expect(upsertRoutineSpy).not.toHaveBeenCalled();
  });

  it('skips when the papercusp-loops flag is OFF', async () => {
    getFlagSpy.mockResolvedValue(false);
    const res = await autoArmFleetMemberLoop({ ...baseOpts, sql: emptySql as any });
    expect(res).toEqual({ armed: false, reason: 'loops-disabled' });
    expect(getFlagSpy).toHaveBeenCalledWith('papercusp-loops', 'system');
  });

  it('reports (not throws) when the flag check itself errors', async () => {
    getFlagSpy.mockRejectedValue(new Error('resolver down'));
    const res = await autoArmFleetMemberLoop({ ...baseOpts, sql: emptySql as any });
    expect(res.armed).toBe(false);
    expect(res.reason).toContain('flag-check-failed');
    expect(res.reason).toContain('resolver down');
  });

  it('happy path: arms via materializeLoop and skips the live inbox-wake leg under an injected test sql', async () => {
    const res = await autoArmFleetMemberLoop({ ...baseOpts, sql: emptySql as any });
    expect(res.armed).toBe(true);
    expect(res.reason).toBe('armed');
    expect(res.loopName).toBe('loop-su-member-1');
    // The goal names the plan + fleet so the wake prompt orients the member.
    const insertInput = upsertRoutineSpy.mock.calls.at(-1)?.[1];
    expect(insertInput.payloadTemplate.kickoff).toContain('backlog-drain-2026-07-16');
    expect(insertInput.payloadTemplate.kickoff).toContain('backlog-drain');
    expect(insertInput.targetOwnerId).toBe('su-member-1');
    // The test-sql seam bypasses the live-singleton-only armInboxWake leg entirely.
    expect(armInboxWakeSpy).not.toHaveBeenCalled();
  });

  it('explicit member carry overrides the default when auto-arming', async () => {
    const res = await autoArmFleetMemberLoop({ ...baseOpts, carry: 'cold', sql: emptySql as any });
    expect(res.armed).toBe(true);
    const insertInput = upsertRoutineSpy.mock.calls.at(-1)?.[1];
    expect(insertInput.payloadTemplate.carry).toBe('cold');
  });

  it('is idempotent: an existing ACTIVE loop for this owner is never clobbered', async () => {
    const activeRow = {
      install_slug: 'papercusp',
      name: 'loop-su-member-1',
      active: true,
      reschedule_interval_sec: 60,
      target_owner_id: 'su-member-1',
      payload_template: { kickoff: 'existing kickoff' },
      fire_count: 3,
      last_fired_at: null,
      parked: false,
      next_fire_at: null,
      parked_ms: null,
      last_delivery_outcome: null,
      consecutive_errors: 0,
      lifecycle_completed_at: null,
      presence_last_active_at: null,
    };
    // Classify by query text: the DISTINCT-ON status read gets the active row;
    // everything else (materializeLoop would never even run past the early
    // return, but keep it inert regardless) gets [].
    const statusSql = transactionalSql((strings: TemplateStringsArray, ..._values: unknown[]) => {
      const text = strings.join(' ? ');
      if (/DISTINCT ON/.test(text)) return Promise.resolve([activeRow]);
      return Promise.resolve([]);
    });
    const res = await autoArmFleetMemberLoop({ ...baseOpts, sql: statusSql as any });
    expect(res).toEqual({ armed: false, reason: 'already-armed', loopName: 'loop-su-member-1' });
    expect(upsertRoutineSpy).not.toHaveBeenCalled();
    expect(armInboxWakeSpy).not.toHaveBeenCalled();
  });

  it('does not auto-arm a member whose loop was explicitly ended', async () => {
    const sql = transactionalSql((strings) => /DISTINCT ON/.test(strings.join(' ')) ? [{
      install_slug: 'papercusp', name: 'loop-su-member-1', active: false,
      reschedule_interval_sec: 600, target_owner_id: 'su-member-1',
      payload_template: { goal: 'completed work' }, fire_count: 3,
      metadata: { pause: { reason: `${LOOP_END_PAUSE_PREFIX} finished`, pausedAtMs: 1 } },
    }] : []);

    const result = await autoArmFleetMemberLoop({ ...baseOpts, sql: sql as unknown as Sql });

    expect(result).toEqual({ armed: false, reason: 'explicit-loop-end', loopName: 'loop-su-member-1' });
    expect(upsertRoutineSpy).not.toHaveBeenCalled();
  });

  function inactiveMonitorSql(
    statusMonitor: Record<string, unknown> | null,
    payloadMonitor: Record<string, unknown> | null,
    standdown = false,
    activeAtMaterialization = false,
  ) {
    const payload = {
      kickoff: 'preserved member monitor kickoff',
      goal: 'continue the owned bounded monitor',
      mode: 'monitor',
      ...(payloadMonitor ? { monitor: payloadMonitor } : {}),
    };
    return transactionalSql((strings) => {
      const query = strings.join(' ? ');
      if (/DISTINCT ON/.test(query)) {
        return [{
          install_slug: 'papercusp',
          name: 'loop-su-member-1',
          active: false,
          reschedule_interval_sec: 1200,
          target_owner_id: 'su-member-1',
          payload_template: { ...payload, monitor: statusMonitor },
          metadata: standdown
            ? { monitor_standdown: { code: 'no_delta_budget_exhausted', reason: 'quiet budget exhausted', atMs: 1791335177901 } }
            : {},
          fire_count: 100,
        }];
      }
      if (/SELECT r.active/.test(query)) {
        return [{ active: false, install_slug: 'papercusp', reschedule_interval_sec: 1200, payload_template: payload }];
      }
      if (/FOR UPDATE/.test(query) && activeAtMaterialization) {
        return [{ id: 'explicit-arm', name: 'loop-su-member-1', active: true, target_role: 'su', reschedule_interval_sec: 300 }];
      }
      return [];
    });
  }

  const memberMonitor = {
    predicateKey: 'owned-member-predicate',
    stopCondition: 'owned operation completes',
    noDeltaBudget: 100,
    remainingNoDeltaBudget: 0,
    authority: { kind: 'work-item', workItem: 'WI-12345' },
  };

  it.each(['status', 'payload', 'standdown'] as const)(
    'does not revive an exhausted member monitor recorded by %s',
    async (source) => {
      const sql = inactiveMonitorSql(
        source === 'status' ? memberMonitor : null,
        source === 'payload' ? memberMonitor : null,
        source === 'standdown',
      );

      const res = await autoArmFleetMemberLoop({ ...baseOpts, sql: sql as any });

      expect(res).toEqual({ armed: false, reason: 'no-delta-budget-exhausted', loopName: 'loop-su-member-1' });
      expect(upsertRoutineSpy).not.toHaveBeenCalled();
      expect(recordLoopTransitionSpy).not.toHaveBeenCalled();
      expect(armInboxWakeSpy).not.toHaveBeenCalled();
      expect(memberMonitor.remainingNoDeltaBudget).toBe(0);
    },
  );

  it.each(['status', 'payload'] as const)(
    'preserves a renewed positive member monitor budget from %s despite historical standdown',
    async (source) => {
      const renewedMonitor = { ...memberMonitor, remainingNoDeltaBudget: 73 };
      const sql = inactiveMonitorSql(
        source === 'status' ? renewedMonitor : null,
        source === 'payload' ? renewedMonitor : null,
        true,
      );

      const res = await autoArmFleetMemberLoop({ ...baseOpts, sql: sql as any });

      expect(res).toMatchObject({ armed: true, reason: 'armed' });
      expect(upsertRoutineSpy.mock.calls.at(-1)?.[1].payloadTemplate).toMatchObject({
        mode: 'monitor',
        monitor: renewedMonitor,
        kickoff: 'preserved member monitor kickoff',
      });
      expect(renewedMonitor.remainingNoDeltaBudget).toBe(73);
    },
  );

  it('preserves an explicit active member arm that wins the recovery race', async () => {
    const renewedMonitor = { ...memberMonitor, remainingNoDeltaBudget: 73 };
    const sql = inactiveMonitorSql(renewedMonitor, renewedMonitor, false, true);

    await autoArmFleetMemberLoop({ ...baseOpts, sql: sql as any });

    expect(upsertRoutineSpy).not.toHaveBeenCalled();
    expect(recordLoopTransitionSpy).not.toHaveBeenCalled();
  });
});

describe('getLoopStatuses — firesSinceArm (WI-36070: the number maxFires is actually compared against)', () => {
  // One fake row shaped like the SELECT's output. Only the fire counters and the bound matter
  // here; everything else is filler the mapper reads but this suite does not assert on.
  function rowSql(over: Record<string, unknown> = {}) {
    const row = {
      install_slug: 'papercusp',
      name: 'loop-su-x',
      active: true,
      reschedule_interval_sec: 60,
      target_owner_id: 'su-x',
      payload_template: { carry: 'warm', continuation: 'settle', mode: 'work', maxFires: 40 },
      fire_count: 113,
      fire_count_at_arm: 98,
      last_fired_at: null,
      armed_at: '2026-08-08T17:30:29.385Z',
      parked: false,
      next_fire_at: null,
      parked_ms: null,
      last_delivery_outcome: 'queued',
      consecutive_errors: 0,
      lifecycle_completed_at: null,
      last_turn_at: null,
      last_real_turn_at: null,
      last_wake_channel: null,
      last_wake_status: null,
      last_wake_at: null,
      last_wake_created_at: null,
      last_wake_error: null,
      presence_last_active_at: null,
      ...over,
    };
    return transactionalSql(() => [row]);
  }

  // THE DEFECT. These are the real numbers measured on su-7854d874's own loop, which is what
  // made this filable: 113 lifetime fires against a bound of 40 reads as a breached dead-man on
  // an `active: true` loop, and the reading is wrong — the guard had 25 fires of headroom left.
  it('reports fires SINCE ARM, not the lifetime fireCount, so an arm-relative bound is readable', async () => {
    const out = await getLoopStatuses(['su-x'], { sql: rowSql() as any });
    const s = out.get('su-x')!;
    expect(s.fireCount).toBe(113); // lifetime — unchanged, still reported
    expect(s.firesSinceArm).toBe(15); // 113 - 98: what checkLoopDeadMan decides on
    expect(s.maxFires).toBe(40);
    // The whole point: against the RIGHT counter this loop is nowhere near its bound.
    expect(s.firesSinceArm).toBeLessThan(s.maxFires!);
    // ...while the comparison the payload used to permit says the opposite. This assertion is
    // the guard: it fails if anyone ever "simplifies" firesSinceArm back to the lifetime count.
    expect(s.fireCount).toBeGreaterThan(s.maxFires!);
  });

  it('exposes the wake dispatch clock separately from its later delivery-settle clock', async () => {
    const out = await getLoopStatuses(['su-x'], {
      sql: rowSql({
        last_wake_status: 'delivered',
        last_wake_at: '2026-10-09T20:21:04.131Z',
        last_wake_created_at: '2026-10-09T20:20:14.031Z',
      }) as any,
    });
    const status = out.get('su-x')!;
    expect(status.lastWakeAt).toBe('2026-10-09T20:21:04.131Z');
    expect(status.lastWakeCreatedAt).toBe('2026-10-09T20:20:14.031Z');
  });

  it('reuses an injected TransactionSql instead of opening a nested transaction', async () => {
    const transaction = rowSql() as TransactionalFakeSql & { begin?: TransactionalFakeSql['begin'] };
    Reflect.deleteProperty(transaction, 'begin');

    const out = await getLoopStatuses(['su-x'], { sql: transaction as unknown as Sql });

    expect(out.get('su-x')?.firesSinceArm).toBe(15);
  });

  it('CALIBRATION: with no baseline stamped (a loop armed before fire_count_at_arm existed) it degrades to the lifetime count, never to a negative', async () => {
    const out = await getLoopStatuses(['su-x'], { sql: rowSql({ fire_count: 7, fire_count_at_arm: 0 }) as any });
    expect(out.get('su-x')!.firesSinceArm).toBe(7);
  });

  it('CLAMPS at 0 — a baseline ahead of the lifetime count never reports negative headroom consumed', async () => {
    const out = await getLoopStatuses(['su-x'], { sql: rowSql({ fire_count: 3, fire_count_at_arm: 10 }) as any });
    expect(out.get('su-x')!.firesSinceArm).toBe(0);
  });

  it('a FRESHLY re-armed loop reports 0 fires since arm even with a long lifetime history', async () => {
    const out = await getLoopStatuses(['su-x'], { sql: rowSql({ fire_count: 500, fire_count_at_arm: 500 }) as any });
    const s = out.get('su-x')!;
    expect(s.firesSinceArm).toBe(0);
    expect(s.fireCount).toBe(500);
  });

  it('EI-21219642654072321: a PARKED loop exposes its park age — the designed in-flight sentinel made self-describing', async () => {
    const out = await getLoopStatuses(['su-x'], { sql: rowSql({ parked: true, parked_ms: 95_000 }) as unknown as Sql });
    const s = out.get('su-x')!;
    expect(s.parked).toBe(true);
    expect(s.parkedForSec).toBe(95);
  });

  it('EI-21219642654072321: NOT parked → parkedForSec is null even when the fire-age column has a value', async () => {
    const out = await getLoopStatuses(['su-x'], {
      sql: rowSql({ parked: false, parked_ms: 95_000 }) as unknown as Sql,
    });
    expect(out.get('su-x')!.parkedForSec).toBeNull();
  });

  it('EI-21301493615546911: marks a parked active loop stalled when its current arm has no post-arm fire', async () => {
    const now = Date.now();
    const armedAt = new Date(now - 10 * 60_000).toISOString();
    const out = await getLoopStatuses(['su-x'], {
      sql: rowSql({
        fire_count: 5,
        fire_count_at_arm: 5,
        armed_at: armedAt,
        last_fired_at: new Date(now - 60 * 60_000).toISOString(),
        parked: true,
        next_fire_at: null,
        presence_last_active_at: new Date(now - 60 * 60_000).toISOString(),
      }) as unknown as Sql,
    });
    const status = out.get('su-x')!;

    expect(status.firesSinceArm).toBe(0);
    expect(status.expectedFiresSinceArm).toBeGreaterThanOrEqual(9);
    expect(status.turnsStalled).toBe(false);
    expect(status.stalled).toBe(true);
  });

  it('EI-22705233904760117: marks an unparked zero-fire loop stalled when its overdue next fire was never delivered', async () => {
    const now = Date.now();
    const out = await getLoopStatuses(['su-x'], {
      sql: rowSql({
        fire_count: 0,
        fire_count_at_arm: 0,
        armed_at: new Date(now - 35 * 60_000).toISOString(),
        last_fired_at: null,
        parked: false,
        next_fire_at: new Date(now - 30 * 60_000).toISOString(),
        presence_last_active_at: new Date(now - 60 * 60_000).toISOString(),
      }) as unknown as Sql,
    });
    const status = out.get('su-x')!;

    expect(status.firesSinceArm).toBe(0);
    expect(status.expectedFiresSinceArm).toBeGreaterThanOrEqual(34);
    expect(status.turnsStalled).toBe(false);
    expect(status.stalled).toBe(true);
  });

  it('EI-21276782387845111: exposes cadenceDrift while keeping the filed parked slow-cadence shape quiet', async () => {
    const now = Date.now();
    const out = await getLoopStatuses(['su-x'], {
      sql: rowSql({
        fire_count: 1,
        fire_count_at_arm: 0,
        armed_at: new Date(now - 34 * 120_000).toISOString(),
        last_fired_at: new Date(now - 216_000).toISOString(),
        longest_observed_gap_sec: 2_400,
        parked: true,
        next_fire_at: null,
      }) as unknown as Sql,
    });
    const status = out.get('su-x')!;

    expect(status.firesSinceArm).toBe(1);
    expect(status.expectedFiresSinceArm).toBeGreaterThanOrEqual(34);
    expect(status.cadenceRatio).toBeGreaterThan(4);
    expect(status.cadenceDrift).toBe(false);
  });

  it('EI-21276782387845111: flags sustained cadence drift only for an overdue scheduled fire', async () => {
    const now = Date.now();
    const out = await getLoopStatuses(['su-x'], {
      sql: rowSql({
        fire_count: 5,
        fire_count_at_arm: 0,
        armed_at: new Date(now - 70 * 60_000).toISOString(),
        last_fired_at: new Date(now - 10 * 60_000).toISOString(),
        longest_observed_gap_sec: 1_207.28,
        parked: false,
        next_fire_at: new Date(now - 10 * 60_000).toISOString(),
      }) as unknown as Sql,
    });

    expect(out.get('su-x')!.cadenceDrift).toBe(true);
  });

  it('EI-22457624472620001: an active provider backoff is not reported as turnsStalled', async () => {
    const now = Date.now();
    const out = await getLoopStatuses(['su-x'], {
      sql: rowSql({
        fire_count: 10,
        fire_count_at_arm: 0,
        last_fired_at: new Date(now - 60 * 60_000).toISOString(),
        last_delivery_outcome: 'resume-turn-death:usage_limit',
        next_fire_at: new Date(now + 60 * 60_000).toISOString(),
        last_turn_at: new Date(now - 3 * 60_000).toISOString(),
        last_real_turn_at: new Date(now - 3 * 60_000).toISOString(),
      }) as unknown as Sql,
    });
    const status = out.get('su-x')!;

    expect(status.lifecycleBackoff).toMatchObject({ reason: 'usage_limit' });
    expect(status.lifecycleBackoff!.resumesInMs).toBeGreaterThan(0);
    expect(status.turnsStalled).toBe(false);
  });

  it.each(['active-inference', 'native-operation'] as const)(
    'EI-26633791289838468: a current %s execution for the latest fire is not reported as stalled',
    async (reason) => {
    const now = Date.now();
    const firedAt = new Date(now - 71_000).toISOString();
    const out = await getLoopStatuses(['su-x'], {
      sql: rowSql({
        fire_count: 3,
        fire_count_at_arm: 0,
        last_fired_at: firedAt,
        parked: true,
        parked_ms: 71_000,
        last_wake_status: 'delivered',
        last_wake_at: firedAt,
        presence_last_active_at: new Date(now - 1_000).toISOString(),
        metadata: {
          executionRecovery: {
            status: 'running',
            reason,
            observedAt: now - 1_000,
            nextProbeAt: now + 29_000,
            attempts: 0,
            probes: 1,
            generation: '123:2:456',
            lastAttemptAt: null,
          },
        },
      }) as unknown as Sql,
    });

    const status = out.get('su-x')!;
    expect(status.parked).toBe(true);
    expect(status.lastWakeStatus).toBe('delivered');
    expect(status.executionRecovery).toMatchObject({ status: 'running', reason });
    expect(status.turnsStalled).toBe(false);
    expect(status.stalled).toBe(false);
    },
  );

  it('does not let a running marker from before the latest fire mask the no-loop-turn verdict', async () => {
    const now = Date.now();
    const out = await getLoopStatuses(['su-x'], {
      sql: rowSql({
        fire_count: 3,
        fire_count_at_arm: 0,
        last_fired_at: new Date(now - 71_000).toISOString(),
        parked: true,
        parked_ms: 71_000,
        last_wake_status: 'delivered',
        last_wake_at: new Date(now - 71_000).toISOString(),
        presence_last_active_at: new Date(now - 1_000).toISOString(),
        metadata: {
          executionRecovery: {
            status: 'running',
            reason: 'active-inference',
            observedAt: now - 120_000,
            nextProbeAt: now - 90_000,
            attempts: 0,
            probes: 1,
            generation: '123:2:456',
            lastAttemptAt: null,
          },
        },
      }) as unknown as Sql,
    });

    expect(out.get('su-x')!.turnsStalled).toBe(true);
  });

  it('EI-22457624472620001: an elapsed provider backoff does not mask a real stall', async () => {
    const now = Date.now();
    const out = await getLoopStatuses(['su-x'], {
      sql: rowSql({
        fire_count: 10,
        fire_count_at_arm: 0,
        last_fired_at: new Date(now - 60 * 60_000).toISOString(),
        last_delivery_outcome: 'resume-turn-death:usage_limit',
        next_fire_at: new Date(now - 1_000).toISOString(),
        last_turn_at: new Date(now - 60 * 60_000).toISOString(),
        last_real_turn_at: new Date(now - 60 * 60_000).toISOString(),
      }) as unknown as Sql,
    });
    const status = out.get('su-x')!;

    expect(status.lifecycleBackoff!.resumesInMs).toBe(0);
    expect(status.turnsStalled).toBe(true);
  });
});

describe('getLoopStatuses — monitor standdown reason reaches the status surface (P-004, ABM-P004-REASON)', () => {
  // WHY THIS SUITE EXISTS. `monitorStanddown` is parsed out of `r.metadata`, so the whole
  // explanation depends on ONE column staying in the SELECT. Drop `r.metadata` and
  // `readMonitorStanddownRecord(undefined)` returns null — which is indistinguishable from
  // "this monitor never stood down". The failure is silent and it lands exactly where it hurts:
  // an `active:false` monitor whose reason has quietly disappeared, so an operator reading
  // loop:status cannot tell an enforced standdown from a dead loop. Parsing is covered in
  // monitor-standdown.test.ts; what is pinned HERE is the trip through the status surface.
  function standdownRowSql(over: Record<string, unknown> = {}) {
    const row = {
      install_slug: 'papercusp',
      name: 'loop-su-x',
      active: false,
      reschedule_interval_sec: 60,
      target_owner_id: 'su-x',
      payload_template: { carry: 'warm', continuation: 'settle', mode: 'monitor' },
      fire_count: 3,
      fire_count_at_arm: 0,
      last_fired_at: null,
      armed_at: '2026-08-27T11:00:00.000Z',
      parked: false,
      next_fire_at: null,
      parked_ms: null,
      last_delivery_outcome: 'queued',
      consecutive_errors: 0,
      lifecycle_completed_at: null,
      last_turn_at: null,
      last_real_turn_at: null,
      last_wake_channel: null,
      last_wake_status: null,
      last_wake_at: null,
      last_wake_error: null,
      presence_last_active_at: null,
      ...over,
    };
    return transactionalSql(() => [row]);
  }

  it('surfaces a budget-exhaustion standdown with its machine-readable code and reason', async () => {
    const out = await getLoopStatuses(['su-x'], {
      sql: standdownRowSql({
        metadata: {
          monitor_standdown: {
            code: 'no_delta_budget_exhausted',
            authorityCode: null,
            reason: 'one quiet wake',
            atMs: 1_756_000_000_000,
          },
        },
      }) as unknown as Sql,
    });

    expect(out.get('su-x')!.monitorStanddown).toEqual({
      code: 'no_delta_budget_exhausted',
      authorityCode: null,
      reason: 'one quiet wake',
      atMs: 1_756_000_000_000,
    });
  });

  it('carries the authority code through, so an authority loss is distinguishable from a spent budget', async () => {
    const out = await getLoopStatuses(['su-x'], {
      sql: standdownRowSql({
        metadata: {
          monitor_standdown: {
            code: 'authority_lost',
            authorityCode: 'monitor_fleet_not_led',
            reason: 'fleet leadership moved to another session',
            atMs: 1,
          },
        },
      }) as unknown as Sql,
    });

    const s = out.get('su-x')!;
    expect(s.monitorStanddown?.code).toBe('authority_lost');
    expect(s.monitorStanddown?.authorityCode).toBe('monitor_fleet_not_led');
  });

  it('CALIBRATION: a monitor that never stood down reports null, so the field explains rather than merely flags', async () => {
    const out = await getLoopStatuses(['su-x'], { sql: standdownRowSql() as unknown as Sql });
    expect(out.get('su-x')!.monitorStanddown).toBeNull();
  });

  it('CAUGHT: the surface DISCRIMINATES a stood-down monitor from one that never stood down', async () => {
    // This is the negative control for the two cases above, and it is the one that would
    // actually go red. The regression is silent: if `metadata` stops reaching the mapper,
    // EVERY reading collapses to null and an enforced standdown becomes indistinguishable
    // from a loop that merely died. A mapper hard-wired to null still passes the CALIBRATION
    // case on its own — so only the discriminating comparison catches it.
    const stoodDown = await getLoopStatuses(['su-x'], {
      sql: standdownRowSql({
        metadata: {
          monitor_standdown: {
            code: 'authority_lost',
            authorityCode: 'monitor_fleet_not_led',
            reason: 'fleet leadership moved',
            atMs: 1,
          },
        },
      }) as unknown as Sql,
    });
    const never = await getLoopStatuses(['su-x'], { sql: standdownRowSql() as unknown as Sql });

    expect(stoodDown.get('su-x')!.monitorStanddown).not.toBeNull();
    expect(never.get('su-x')!.monitorStanddown).toBeNull();
    // Equal readings mean the column stopped being read — the exact silent regression.
    expect(stoodDown.get('su-x')!.monitorStanddown).not.toEqual(never.get('su-x')!.monitorStanddown);
  });
});

describe('getLoopStatuses — loop:standdown-all bulk pause reaches the status surface (EI-22138154596110669)', () => {
  // Same shape of bug as the monitor-standdown suite above, one column over: `standdown` is
  // parsed out of `r.metadata.pause`, gated on `isLoopStanddownPause` so an ORDINARY per-loop
  // pause (routines:set / loop:end, no marker) must NEVER populate it — that discrimination is
  // the whole point of the marker (a fleet-wide "stand-down" broadcast must be verifiable
  // against real per-loop state, not conflated with any other reason a loop happens to be off).
  function pauseRowSql(pause: unknown, active = false) {
    const row = {
      install_slug: 'papercusp',
      name: 'loop-su-x',
      active,
      reschedule_interval_sec: 60,
      target_owner_id: 'su-x',
      payload_template: { carry: 'warm', continuation: 'settle', mode: 'work' },
      fire_count: 3,
      fire_count_at_arm: 0,
      last_fired_at: null,
      armed_at: '2026-08-27T11:00:00.000Z',
      parked: false,
      next_fire_at: null,
      parked_ms: null,
      last_delivery_outcome: 'queued',
      consecutive_errors: 0,
      lifecycle_completed_at: null,
      last_turn_at: null,
      last_real_turn_at: null,
      last_wake_channel: null,
      last_wake_status: null,
      last_wake_at: null,
      last_wake_error: null,
      presence_last_active_at: null,
      metadata: pause == null ? {} : { pause },
    };
    return transactionalSql(() => [row]);
  }

  it.each([
    { reason: `${LOOP_END_PAUSE_PREFIX} finished`, active: false, ended: true },
    { reason: `${LOOP_END_PAUSE_PREFIX} old end`, active: true, ended: false },
    { reason: 'recoverable worker failure', active: false, ended: false },
  ])('distinguishes explicit end from recovery and later explicit arm: $reason/$active', async ({ reason, active, ended }) => {
    const out = await getLoopStatuses(['su-x'], {
      sql: pauseRowSql({ reason, pausedAtMs: 1 }, active) as unknown as Sql,
    });
    expect(out.get('su-x')?.explicitlyEnded ?? false).toBe(ended);
  });

  it('surfaces an active stand-down with a ready-to-render banner and the parsed pause fields', async () => {
    const out = await getLoopStatuses(['su-x'], {
      sql: pauseRowSql({
        standdownAll: true,
        reason: 'coordinated host restart',
        pausedBy: 'su-leader',
        pausedAtMs: 1_756_000_000_000,
        expiresAtMs: 1_756_000_000_000 + 4 * 3_600_000,
      }) as unknown as Sql,
    });
    const s = out.get('su-x')!.standdown;
    expect(s).not.toBeNull();
    expect(s).toMatchObject({
      reason: 'coordinated host restart',
      pausedBy: 'su-leader',
      pausedAtMs: 1_756_000_000_000,
      expiresAtMs: 1_756_000_000_000 + 4 * 3_600_000,
    });
    expect(s!.banner).toContain('⛔ STAND-DOWN ACTIVE');
    expect(s!.banner).toContain('su-leader');
  });

  it('CALIBRATION: no pause at all reports null', async () => {
    const out = await getLoopStatuses(['su-x'], { sql: pauseRowSql(null) as unknown as Sql });
    expect(out.get('su-x')!.standdown).toBeNull();
  });

  it('an ORDINARY per-loop pause (no standdownAll marker) must NEVER populate this field', async () => {
    const out = await getLoopStatuses(['su-x'], {
      sql: pauseRowSql({ reason: 'ad-hoc hold via routines:set', pausedBy: 'su-someone', pausedAtMs: 1 }) as unknown as Sql,
    });
    expect(out.get('su-x')!.standdown).toBeNull();
  });

  it('CAUGHT: the surface DISCRIMINATES a marker-bearing stand-down from an ordinary pause and from no pause', async () => {
    // The negative control: a mapper hard-wired to null passes the CALIBRATION case above on
    // its own, so only this comparison catches the column silently dropping out of the SELECT.
    const stoodDown = await getLoopStatuses(['su-x'], {
      sql: pauseRowSql({ standdownAll: true, reason: 'x', pausedBy: 'y', pausedAtMs: 1, expiresAtMs: 2 }) as unknown as Sql,
    });
    const ordinary = await getLoopStatuses(['su-x'], {
      sql: pauseRowSql({ reason: 'ad-hoc', pausedBy: 'y', pausedAtMs: 1 }) as unknown as Sql,
    });
    const never = await getLoopStatuses(['su-x'], { sql: pauseRowSql(null) as unknown as Sql });

    expect(stoodDown.get('su-x')!.standdown).not.toBeNull();
    expect(ordinary.get('su-x')!.standdown).toBeNull();
    expect(never.get('su-x')!.standdown).toBeNull();
  });
});

describe('computeLoopCadence (EI-20217869515819188 — configured vs observed cadence)', () => {
  const armedAtMs = Date.parse('2026-08-11T20:03:22.000Z');
  const nowMs = armedAtMs + (7 * 60 * 60 + 47 * 60) * 1000;

  it('reports expected opportunities, effective interval, and slow-cadence ratio from arm-relative fires', () => {
    const out = computeLoopCadence({
      intervalSec: 60,
      armedAtMs,
      firesSinceArm: 15,
      lastFiredAtMs: armedAtMs + 15 * 31 * 60 * 1000,
      longestObservedGapSec: 2.5 * 60 * 60,
      nowMs,
    });

    expect(out.expectedFiresSinceArm).toBe(467);
    expect(out.effectiveIntervalSec).toBe(31 * 60);
    expect(out.cadenceRatio).toBe(31);
    expect(out.longestObservedGapSec).toBe(2.5 * 60 * 60);
  });

  it('keeps every metric null when its timestamps are insufficient, never fabricating zero', () => {
    expect(
      computeLoopCadence({
        intervalSec: 60,
        armedAtMs: null,
        firesSinceArm: 0,
        lastFiredAtMs: null,
        longestObservedGapSec: null,
        nowMs,
      }),
    ).toEqual({
      expectedFiresSinceArm: null,
      effectiveIntervalSec: null,
      cadenceRatio: null,
      longestObservedGapSec: null,
    });
  });

  it('preserves a measured zero gap while rejecting invalid history values', () => {
    expect(
      computeLoopCadence({
        intervalSec: 60,
        armedAtMs,
        firesSinceArm: 1,
        lastFiredAtMs: armedAtMs,
        longestObservedGapSec: 0,
        nowMs: armedAtMs,
      }).longestObservedGapSec,
    ).toBe(0);
    expect(
      computeLoopCadence({
        intervalSec: 60,
        armedAtMs,
        firesSinceArm: 1,
        lastFiredAtMs: armedAtMs,
        longestObservedGapSec: -1,
        nowMs: armedAtMs,
      }).longestObservedGapSec,
    ).toBeNull();
  });
});

describe('computeCadenceDrift (EI-20247200923975596 — advisory sustained drift)', () => {
  // The clock is PINNED (nowMs + a fixed nextFireAt) rather than left to Date.now(): overdue-ness
  // is now part of the verdict, so a fixture that lets real time drift under it would decide the
  // assertion by how long the suite took to reach this line.
  const NOW_MS = Date.parse('2026-08-16T00:10:00.000Z');
  const base = {
    active: true,
    intervalSec: 60,
    firesSinceArm: 5,
    expectedFiresSinceArm: 62,
    cadenceRatio: 12.13396,
    longestObservedGapSec: 1207.28,
    parked: false,
    // 600s late against a 60s interval — well past the 4-interval (240s) overdue floor.
    nextFireAt: '2026-08-16T00:00:00.000Z',
    nowMs: NOW_MS,
  };

  it('flags multiple fires with missed opportunities, a slow ratio, and a corroborating gap', () => {
    expect(computeCadenceDrift(base)).toBe(true);
  });

  it('stays quiet for startup, normal cadence, missing history, or inactive loops', () => {
    expect(computeCadenceDrift({ ...base, firesSinceArm: 2 })).toBe(false);
    expect(computeCadenceDrift({ ...base, expectedFiresSinceArm: 7, cadenceRatio: 1.4 })).toBe(false);
    expect(computeCadenceDrift({ ...base, longestObservedGapSec: null })).toBe(false);
    expect(computeCadenceDrift({ ...base, active: false })).toBe(false);
  });

  // The settling gate (loop.ts) — every statistical precondition above is already satisfied by
  // `base`, so each case here isolates the gate itself. Without these, the gate could be deleted
  // and the suite would stay green.
  describe('the settling gate — drift needs a demonstrably LATE fire, not just a slow ratio', () => {
    it('never flags a PARKED loop: a mid-turn loop is settling, and settling is not drift', () => {
      expect(computeCadenceDrift({ ...base, parked: true })).toBe(false);
    });

    it('stays quiet when nextFireAt is absent or unparseable — overdue-ness is unestablished, not proven', () => {
      expect(computeCadenceDrift({ ...base, nextFireAt: null })).toBe(false);
      expect(computeCadenceDrift({ ...base, nextFireAt: undefined })).toBe(false);
      expect(computeCadenceDrift({ ...base, nextFireAt: 'not-a-timestamp' })).toBe(false);
    });

    it('stays quiet when the next fire is still in the FUTURE — nothing is late yet', () => {
      expect(computeCadenceDrift({ ...base, nextFireAt: '2026-08-16T00:15:00.000Z' })).toBe(false);
    });

    it('holds the 4-interval overdue floor from both sides', () => {
      // 239s late — one second short of the floor.
      expect(computeCadenceDrift({ ...base, nextFireAt: '2026-08-16T00:06:01.000Z' })).toBe(false);
      // Exactly 240s late — the floor is inclusive (`>=`).
      expect(computeCadenceDrift({ ...base, nextFireAt: '2026-08-16T00:06:00.000Z' })).toBe(true);
    });
  });
});

describe('countAgentToolCallsInWindow (EI-19984789589075138 — the cold-wake un-checkpointed-work evidence check)', () => {
  function countSql(n: number) {
    return transactionalSql(() => [{ n }]);
  }
  function throwingSql() {
    // agentToolInvocationPredicate builds a SQL fragment before the bounded
    // transaction starts, so throw synchronously here; a rejected promise at
    // that pre-query composition point would become an unhandled rejection.
    return transactionalSql(() => {
      throw new Error('boom');
    });
  }

  it('returns the row count when the query succeeds', async () => {
    const out = await countAgentToolCallsInWindow('su-x', 0, 1000, { sql: countSql(3) as any });
    expect(out).toBe(3);
  });

  it('returns 0 (not null) for a genuinely empty window — a real, confirmed answer', async () => {
    const out = await countAgentToolCallsInWindow('su-x', 0, 1000, { sql: countSql(0) as any });
    expect(out).toBe(0);
  });

  it('filters explicit automatic origins while retaining legacy NULL rows', async () => {
    const calls: { strings: readonly string[]; values: unknown[] }[] = [];
    const sql = transactionalSql((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ strings: [...strings], values });
      return Promise.resolve([{ n: 1 }]);
    });

    const out = await countAgentToolCallsInWindow('su-x', 0, 1000, { sql: sql as any });

    expect(out).toBe(1);
    const rendered = calls.flatMap((call) => call.strings).join(' ');
    const values = calls.flatMap((call) =>
      call.values.flatMap((value: unknown) => (Array.isArray(value) ? value : [value])),
    );
    expect(rendered).toContain('IS NULL');
    expect(values).toEqual(
      expect.arrayContaining([
        'call_origin',
        'tool_name',
        'agent',
        'unknown',
        'activity:report',
        'coord:glance',
        'coord:inbox',
      ]),
    );
  });

  it('EI-20543456503122446: binds the carry-note bookkeeping exclusion so the note-writing call cannot count itself', async () => {
    // A tool_invocations row is stamped at INSERT, after the handler's write commits, so
    // the loop:checkpoint that WROTE the note lands inside the window this note opens.
    // Without the exclusion the guard's `0` downgrade is unreachable for any session that
    // checkpoints and then dies — i.e. exactly the bounced-fire case it exists for.
    // NOTE: this asserts COMPOSITION only. The fake sql below never executes the
    // predicate, which is why the semantic proof lives in loop.integration.test.ts.
    const calls: { strings: readonly string[]; values: unknown[] }[] = [];
    const array = vi.fn((values: unknown[]) => ({ values }));
    const sql = transactionalSql((strings: TemplateStringsArray, ...values: unknown[]) => {
      if (values.some(Array.isArray)) throw new Error('Received an instance of Array');
      calls.push({ strings: [...strings], values });
      return Promise.resolve([{ n: 0 }]);
    });
    sql.array = array;

    await countAgentToolCallsInWindow('su-x', 0, 1000, { sql: sql as any });

    const rendered = calls.flatMap((call) => call.strings).join(' ');
    expect(rendered).toContain('tool_name <> ALL');
    expect(array).toHaveBeenCalledWith(['loop:checkpoint', 'work_items:checkpoint']);
  });

  it('returns null (never 0) when the query itself fails — "unavailable" must not read as "confirmed zero"', async () => {
    // The catch path deliberately console.warn's (best-effort logging) — expect it
    // explicitly (vitest-fail-on-console) rather than letting it fail the test.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await countAgentToolCallsInWindow('su-x', 0, 1000, { sql: throwingSql() as any });
    expect(out).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  // WI-2143038: pins the actual su-54215254 regression — the fix (loop.ts scope split +
  // reconcile-loop-routines.ts's opt-in) is exercised elsewhere only via mocks that assert
  // *composition* (evidenceScope was passed) or the *default* scope's ledger-only query.
  // Nothing before this seeded a real agent_activity row and asserted the union actually
  // rescues the count — the exact gap su-0c710c57 flagged as "the obvious next step" in
  // their fix-landed comment on this item.
  describe("'fire-productivity' scope (WI-2143038) — the native-Bash rescue leg", () => {
    it('counts a native call recorded ONLY in agent_activity when the MCP ledger is empty — the false-disarm this item reports', async () => {
      // Reproduces the su-54215254 disarm: tool_invocations (MCP-only) is empty for the
      // fire's window, but agent_activity (the per-CLI hook ledger) has one real
      // agent-authored pre-hook row from a native Bash call. The union must surface it.
      // NOTE: agentToolInvocationPredicate(sql) makes its OWN preliminary fragment-building
      // call through this same fake `sql` before either real query runs (see throwingSql's
      // comment above) — it matches neither table name, so it must fall through to a benign
      // default rather than the two branches below, or it is misread as an unexpected query.
      const sql = transactionalSql((strings: TemplateStringsArray) => {
        const rendered = strings.join(' ');
        if (rendered.includes('harness_shared.agent_activity')) return [{ n: 1 }];
        if (rendered.includes('harness_shared.tool_invocations')) return [{ n: 0 }];
        return []; // the predicate-fragment call — its value is embedded, not read as a count
      });

      const out = await countAgentToolCallsInWindow('su-x', 0, 1000, {
        sql: sql as any,
        evidenceScope: 'fire-productivity',
      });

      expect(out).toBe(1);
    });

    it('takes the larger of the two ledgers rather than only the native one', async () => {
      const sql = transactionalSql((strings: TemplateStringsArray) => {
        const rendered = strings.join(' ');
        if (rendered.includes('harness_shared.agent_activity')) return [{ n: 1 }];
        if (rendered.includes('harness_shared.tool_invocations')) return [{ n: 5 }];
        return []; // the predicate-fragment call, see note above
      });

      const out = await countAgentToolCallsInWindow('su-x', 0, 1000, {
        sql: sql as any,
        evidenceScope: 'fire-productivity',
      });

      expect(out).toBe(5);
    });

    it('the default (post-note-work) scope ALSO unions in agent_activity — native-only post-note work must not score a structural 0 (WI-10002086)', async () => {
      const seen: string[] = [];
      const sql = transactionalSql((strings: TemplateStringsArray) => {
        const rendered = strings.join(' ');
        seen.push(rendered);
        if (rendered.includes('harness_shared.agent_activity')) return [{ n: 3 }];
        if (rendered.includes('harness_shared.tool_invocations')) return [{ n: 0 }];
        return []; // the predicate-fragment call, see note above
      });

      const out = await countAgentToolCallsInWindow('su-x', 0, 1000, { sql: sql as any });

      // This assertion used to read `expect(out).toBe(0)` plus "never queries
      // agent_activity at all" — it pinned the DEFECT in place. Before WI-10002086 this
      // scope counted tool_invocations only, so three native Bash/Edit calls of real
      // post-note work scored 0, and su-cold-loop.ts's `confirmedNoWork` downgraded the
      // warning to "the note above is CURRENT. No recovery hunt needed." A false NEGATIVE
      // in a safety signal, which is strictly worse than the false-positive direction.
      expect(out).toBe(3);
      expect(seen.some((s) => s.includes('harness_shared.agent_activity'))).toBe(true);
    });

    it('excludes the carry-note bookkeeping names from the post-note-work native leg, so the checkpoint that WROTE the note cannot answer yes on its own behalf (WI-10002086)', async () => {
      const excluded: string[][] = [];
      const sql = transactionalSql((strings: TemplateStringsArray, ...values: unknown[]) => {
        const rendered = strings.join(' ');
        if (rendered.includes('harness_shared.agent_activity')) {
          // The exclusion set travels as a PARAMETER, not in the template text, so assert
          // on the bound value. The canonical list is the one carrying 'activity:report';
          // the sibling CLI-tail array holds 'activity_report' and is skipped by this test.
          for (const v of values) {
            if (Array.isArray(v) && v.includes('activity:report')) excluded.push(v as string[]);
          }
          return [{ n: 0 }];
        }
        if (rendered.includes('harness_shared.tool_invocations')) return [{ n: 0 }];
        return [];
      });

      await countAgentToolCallsInWindow('su-x', 0, 1000, { sql: sql as any });

      expect(excluded.length).toBeGreaterThan(0);
      // The window OPENS at the note's updated_at, and the note-writing call's own row is
      // stamped at INSERT — after the handler's write commits, so it lands just INSIDE the
      // window (measured: note 18:20:06.840Z, its loop:checkpoint row 18:20:07.136Z). Leg 1
      // already excludes these; leg 2 must too, or widening it merely trades the false
      // negative above for a false POSITIVE on every cold wake.
      expect(excluded[0]).toContain('loop:checkpoint');
      expect(excluded[0]).toContain('work_items:checkpoint');
    });

    it("'fire-productivity' still KEEPS the carry-note bookkeeping names in the native leg — for a disciplined watcher the checkpoint is often the only call of the wake (su-54215254)", async () => {
      const excluded: string[][] = [];
      const sql = transactionalSql((strings: TemplateStringsArray, ...values: unknown[]) => {
        const rendered = strings.join(' ');
        if (rendered.includes('harness_shared.agent_activity')) {
          for (const v of values) {
            if (Array.isArray(v) && v.includes('activity:report')) excluded.push(v as string[]);
          }
          return [{ n: 0 }];
        }
        if (rendered.includes('harness_shared.tool_invocations')) return [{ n: 0 }];
        return [];
      });

      await countAgentToolCallsInWindow('su-x', 0, 1000, {
        sql: sql as any,
        evidenceScope: 'fire-productivity',
      });

      expect(excluded.length).toBeGreaterThan(0);
      expect(excluded[0]).not.toContain('loop:checkpoint');
      expect(excluded[0]).not.toContain('work_items:checkpoint');
    });

    it('still returns null on a fire-productivity query failure — evidence-unavailable must not become a false zero either', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const out = await countAgentToolCallsInWindow('su-x', 0, 1000, {
        sql: throwingSql() as any,
        evidenceScope: 'fire-productivity',
      });
      expect(out).toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      warnSpy.mockRestore();
    });
  });
});

describe('loop constants / naming', () => {
  it('loopRoutineName is deterministic per owner (the upsert key)', () => {
    expect(loopRoutineName('su-x')).toBe('loop-su-x');
  });
  it('the policy floor is the 60s /loop floor', () => {
    expect(LOOP_INTERVAL_FLOOR_SEC).toBe(60);
  });
  it('the loop target_role is the stable self-documenting value', () => {
    expect(LOOP_WAKE_ACTION).toBe('system:loop-wake');
  });
});
