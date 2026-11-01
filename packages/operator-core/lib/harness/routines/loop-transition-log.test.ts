import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CYCLE_WINDOW_ROWS,
  LOOP_CYCLE_BASIS,
  deriveLoopCycle,
  readLatestLoopTransition,
  readLatestLoopTransitionCycles,
  recordLoopTransition,
  transitionRetentionDays,
  __resetPruneThrottleForTest,
  type LoopTransitionSnapshot,
} from './loop-transition-log';

/**
 * EI-19411045952024591 — the append-only loop transition log.
 *
 * The recurrence guard that matters is the FAIL-SOFT one: this table is an instrument on
 * the hot fire path, and an instrument that can throw into the path it measures would
 * turn a diagnosis gap into an outage. Every test below that touches error handling is
 * guarding that property, not the happy path.
 */

/** A postgres-js-shaped tagged-template fake that records the statements it was given. */
function fakeSql(opts: { throwOn?: RegExp; code?: string; rows?: unknown[] } = {}) {
  const statements: { text: string; values: unknown[] }[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    statements.push({ text, values });
    if (opts.throwOn && opts.throwOn.test(text)) {
      const err = Object.assign(new Error('simulated postgres failure'), opts.code ? { code: opts.code } : {});
      return Promise.reject(err);
    }
    return Promise.resolve((opts.rows ?? []) as any);
  };
  return Object.assign(tag, { statements });
}

describe('readLatestLoopTransition', () => {
  it('returns the newest transition with await-suppression cause intact', async () => {
    const sql = fakeSql({
      rows: [
        {
          at: '2026-08-27T03:08:18.952Z',
          event: 'rearmed',
          actor: 'await-suppression',
          new_next_fire_at: '2026-08-27T03:17:32.159Z',
          interval_sec: '60',
          detail: {
            via: 'await-suppression',
            drivingEventKey: 'plan:stable:recovery-complete',
          },
        },
      ],
    });

    const out = await readLatestLoopTransition(
      {
        workspaceId: 'ws-1',
        installSlug: 'papercusp',
        routineName: 'loop-su-70702',
        targetOwnerId: 'su-70702',
      },
      { sql: sql as any },
    );

    expect(out).toEqual({
      status: 'found',
      transition: {
        at: '2026-08-27T03:08:18.952Z',
        event: 'rearmed',
        actor: 'await-suppression',
        newNextFireAt: '2026-08-27T03:17:32.159Z',
        intervalSec: 60,
        detail: {
          via: 'await-suppression',
          drivingEventKey: 'plan:stable:recovery-complete',
        },
      },
      // A lone await-suppression re-arm is NOT a turn (no park precedes it): phase is
      // 'settled' but there is no completed turn to report.
      cycle: { phase: 'settled', turnInFlightSec: null, lastTurn: null, basis: LOOP_CYCLE_BASIS },
    });
    const select = sql.statements.find((s) => /SELECT t\.at, t\.event, t\.actor/.test(s.text));
    // The window size is bound at BOTH the lateral and the outer LIMIT.
    expect(select?.values).toEqual([
      CYCLE_WINDOW_ROWS,
      'ws-1',
      'papercusp',
      'loop-su-70702',
      'su-70702',
      CYCLE_WINDOW_ROWS,
    ]);
  });

  it('derives cycle from the newest window: transition is row 0, cycle spans the older rows (EI-24709926664545964)', async () => {
    // SQL returns newest first. Measured 2026-09-30 (su-6702dbe3): the 330s `parked` span was
    // the member's own turn, and the post-settle delay was 31s.
    const sql = fakeSql({
      rows: [
        { at: '2026-09-30T17:36:33.000Z', event: 'parked', actor: 'claim-due-routine', new_next_fire_at: null, interval_sec: '60', detail: null },
        { at: '2026-09-30T17:36:02.000Z', event: 'rearmed', actor: 'reconcile-loop-routines', new_next_fire_at: '2026-09-30T17:36:28.000Z', interval_sec: '60', detail: { via: 'lifecycle', wasParked: true } },
        { at: '2026-09-30T17:30:32.000Z', event: 'parked', actor: 'claim-due-routine', new_next_fire_at: null, interval_sec: '60', detail: null },
      ],
    });
    const out = await readLatestLoopTransition(
      { workspaceId: 'ws-1', installSlug: 'papercusp', routineName: 'loop-su-6702', targetOwnerId: 'su-6702' },
      { sql: sql as any, nowMs: Date.parse('2026-09-30T17:37:03.000Z') },
    );
    expect(out.status).toBe('found');
    if (out.status !== 'found') return;
    expect(out.transition).toMatchObject({ event: 'parked', at: '2026-09-30T17:36:33.000Z' });
    expect(out.cycle).toMatchObject({
      phase: 'turn-in-flight',
      turnInFlightSec: 30,
      lastTurn: { turnSec: 330, postSettleDelaySec: 31, scheduledDelaySec: 26, settledVia: 'lifecycle' },
    });
  });

  it('an older MALFORMED row narrows the cycle window but never turns a good latest read into unknown', async () => {
    const sql = fakeSql({
      rows: [
        { at: '2026-09-30T17:36:02.000Z', event: 'rearmed', actor: 'reconcile-loop-routines', new_next_fire_at: null, interval_sec: null, detail: null },
        { at: null, event: 'parked', actor: 'claim-due-routine', new_next_fire_at: null, interval_sec: null, detail: null },
      ],
    });
    const out = await readLatestLoopTransition(
      { workspaceId: 'ws-1', installSlug: 'papercusp', routineName: 'loop-su-6702', targetOwnerId: 'su-6702' },
      { sql: sql as any, nowMs: 0 },
    );
    expect(out.status).toBe('found');
    if (out.status === 'found') expect(out.cycle.lastTurn).toBeNull();
  });

  it('distinguishes no transition from an unavailable transition read', async () => {
    const empty = fakeSql();
    await expect(
      readLatestLoopTransition(
        {
          workspaceId: 'ws-1',
          installSlug: 'papercusp',
          routineName: 'loop-su-70702',
          targetOwnerId: 'su-70702',
        },
        { sql: empty as any },
      ),
    ).resolves.toEqual({ status: 'none' });

    const unavailable = fakeSql({ throwOn: /SELECT t\.at, t\.event, t\.actor/ });
    await expect(
      readLatestLoopTransition(
        {
          workspaceId: 'ws-1',
          installSlug: 'papercusp',
          routineName: 'loop-su-70702',
          targetOwnerId: 'su-70702',
        },
        { sql: unavailable as any },
      ),
    ).resolves.toEqual({ status: 'unknown' });
  });
});

describe('readLatestLoopTransitionCycles', () => {
  it('reads bounded transition windows for a roster in one scoped query', async () => {
    const sql = fakeSql({
      rows: [
        {
          routine_id: 'rt-one', at: '2026-10-26T14:16:10.315Z', event: 'parked',
          actor: 'claim-due-routine', new_next_fire_at: null, interval_sec: 60, detail: null,
        },
        {
          routine_id: 'rt-one', at: '2026-10-26T13:16:53.683Z', event: 'rearmed',
          actor: 'reconcile-loop-routines', new_next_fire_at: '2026-10-26T14:15:34.953Z',
          interval_sec: 60, detail: { via: 'gate-backoff' },
        },
        {
          routine_id: 'rt-one', at: '2026-10-26T13:16:35.296Z', event: 'parked',
          actor: 'claim-due-routine', new_next_fire_at: null, interval_sec: 60, detail: null,
        },
      ],
    });

    const out = await readLatestLoopTransitionCycles(
      { workspaceId: 'ws-1', routineIds: ['rt-one', 'rt-empty'] },
      { sql: sql as any, nowMs: Date.parse('2026-10-26T14:20:00.000Z') },
    );

    expect(out.get('rt-one')).toMatchObject({
      status: 'found',
      cycle: { phase: 'turn-in-flight', lastTurn: { scheduledDelaySec: 3_521, postSettleDelaySec: 3_557 } },
    });
    expect(out.get('rt-empty')).toEqual({ status: 'none' });
    expect(sql.statements).toHaveLength(1);
    const statement = sql.statements[0];
    expect(statement?.text).toContain('workspace_id = ?');
    expect(statement?.text).toContain('routine_id = ANY(?::text[])');
    expect(statement?.values).toEqual(['ws-1', ['rt-one', 'rt-empty'], CYCLE_WINDOW_ROWS]);
  });

  it('reports unknown rather than none when the transition instrument is unavailable', async () => {
    const sql = fakeSql({ throwOn: /routine_loop_transitions/, code: '42P01' });
    const out = await readLatestLoopTransitionCycles(
      { workspaceId: 'ws-1', routineIds: ['rt-one'] },
      { sql: sql as any },
    );
    expect(out.get('rt-one')).toEqual({ status: 'unknown' });
  });
});

/**
 * EI-24709926664545964 — `deriveLoopCycle` separates the member's TURN (parked -> rearmed) from
 * the re-arm DELAY (rearmed -> next parked). Two agents filed "the loop re-fires 7.7x slower
 * than armed" off a 330s `parked` span that was the member's own turn; these tests pin the
 * split so the two numbers can never be conflated again.
 */
describe('deriveLoopCycle', () => {
  const T = (hhmmss: string, day = '2026-09-30') => `${day}T${hhmmss}.000Z`;
  function tr(
    at: string,
    event: string,
    extra: Partial<LoopTransitionSnapshot> = {},
  ): LoopTransitionSnapshot {
    return {
      at,
      event,
      actor: event === 'parked' ? 'claim-due-routine' : 'reconcile-loop-routines',
      newNextFireAt: null,
      intervalSec: 60,
      detail: null,
      ...extra,
    };
  }
  /** Rows are written oldest-first here for readability; the read returns them newest-first. */
  const newestFirst = (...oldestFirst: LoopTransitionSnapshot[]) => [...oldestFirst].reverse();

  it('MEASURED fixture (su-6702dbe3 17:25-17:36Z): 330s turn, 31s post-settle delay — not a 361s "re-fire gap"', () => {
    const out = deriveLoopCycle(
      newestFirst(
        tr(T('17:25:02'), 'parked'),
        tr(T('17:29:03'), 'rearmed', { newNextFireAt: T('17:30:03') }),
        tr(T('17:30:32'), 'parked'),
        tr(T('17:36:02'), 'rearmed', { newNextFireAt: T('17:36:28'), detail: { via: 'lifecycle', wasParked: true } }),
        tr(T('17:36:33'), 'parked'),
      ),
      Date.parse(T('17:36:43')),
    );
    expect(out.phase).toBe('turn-in-flight');
    expect(out.turnInFlightSec).toBe(10);
    expect(out.lastTurn).toEqual({
      parkedAt: T('17:30:32'),
      settledAt: T('17:36:02'),
      turnSec: 330,
      settledBy: 'reconcile-loop-routines',
      settledVia: 'lifecycle',
      scheduledDelaySec: 26,
      postSettleDelaySec: 31,
    });
    // The misreading this exists to prevent: park-to-park (361s) is turn + delay, not a delay.
    expect(out.lastTurn!.turnSec + out.lastTurn!.postSettleDelaySec!).toBe(361);
    expect(out.basis).toBe(LOOP_CYCLE_BASIS);
  });

  it('a genuinely LATE re-arm is visible as postSettleDelaySec — the split is not hiding a real fault', () => {
    // Control for the test above: if the derivation merely echoed intervalSec or reused the
    // turn span for both fields, it would pass the measured fixture and fail here.
    const out = deriveLoopCycle(
      newestFirst(
        tr(T('10:00:00'), 'parked'),
        tr(T('10:01:00'), 'rearmed', { newNextFireAt: T('10:02:00') }),
        tr(T('10:09:00'), 'parked'),
      ),
      Date.parse(T('10:09:30')),
    );
    expect(out.lastTurn).toMatchObject({ turnSec: 60, scheduledDelaySec: 60, postSettleDelaySec: 480 });
  });

  it('newest row is a re-arm: phase settled, post-settle delay unknown until the next fire claims', () => {
    const out = deriveLoopCycle(
      newestFirst(tr(T('10:00:00'), 'parked'), tr(T('10:04:00'), 'rearmed', { newNextFireAt: T('10:05:00') })),
      Date.parse(T('10:04:30')),
    );
    expect(out.phase).toBe('settled');
    expect(out.turnInFlightSec).toBeNull();
    expect(out.lastTurn).toMatchObject({ turnSec: 240, scheduledDelaySec: 60, postSettleDelaySec: null });
  });

  it('an await-suppression re-arm is NOT a turn: the earlier real turn is reported, the suppressed park ends its delay', () => {
    const out = deriveLoopCycle(
      newestFirst(
        tr(T('10:00:00'), 'parked'),
        tr(T('10:01:00'), 'rearmed'),
        tr(T('10:02:00'), 'parked'),
        tr(T('10:02:01'), 'rearmed', { actor: 'await-suppression', detail: { via: 'await-suppression' } }),
      ),
      Date.parse(T('10:03:00')),
    );
    expect(out.phase).toBe('settled');
    expect(out.lastTurn).toMatchObject({ turnSec: 60, postSettleDelaySec: 60 });
  });

  it('a re-arm that does not follow a park (reachability sweep on an already-settled loop) settled nothing', () => {
    const out = deriveLoopCycle(
      newestFirst(tr(T('10:00:00'), 'rearmed'), tr(T('10:05:00'), 'rearmed')),
      Date.parse(T('10:06:00')),
    );
    expect(out.phase).toBe('settled');
    expect(out.lastTurn).toBeNull();
  });

  it('empty, disarmed and clock-skewed windows are phase other / no turn — never a fabricated number', () => {
    expect(deriveLoopCycle([], 0)).toMatchObject({ phase: 'other', turnInFlightSec: null, lastTurn: null });
    expect(deriveLoopCycle([tr(T('10:00:00'), 'disarmed')], 0)).toMatchObject({ phase: 'other', lastTurn: null });
    // A settle stamped BEFORE its park (clock skew) yields no negative duration.
    expect(
      deriveLoopCycle(newestFirst(tr(T('10:05:00'), 'parked'), tr(T('10:04:00'), 'rearmed')), Date.parse(T('10:06:00'))).lastTurn,
    ).toBeNull();
  });
});

const PARK = {
  workspaceId: 'ws-1',
  installSlug: 'papercusp',
  routineId: 'routine-abc',
  routineName: 'loop-su-70702',
  targetRole: 'system:loop',
  targetOwnerId: 'su-70702',
  event: 'parked' as const,
  actor: 'claim-due-routine',
  newNextFireAt: 'infinity',
  intervalSec: 600,
};

describe('recordLoopTransition', () => {
  beforeEach(() => {
    __resetPruneThrottleForTest();
    vi.restoreAllMocks();
  });

  it('appends one row carrying the forensic payload (event, actor, routine identity)', async () => {
    const sql = fakeSql();
    await recordLoopTransition(sql as any, PARK);

    const insert = sql.statements.find((s) => /INSERT INTO harness_shared\.routine_loop_transitions/.test(s.text));
    expect(insert).toBeDefined();
    // The three columns the incident query keys on, plus the park sentinel.
    expect(insert!.values).toContain('parked');
    expect(insert!.values).toContain('claim-due-routine');
    expect(insert!.values).toContain('routine-abc');
    expect(insert!.values).toContain('infinity');
    expect(insert!.values).toContain('ws-1');
  });

  it('serialises detail to JSON and passes null (not undefined) for absent optionals', async () => {
    const sql = fakeSql();
    await recordLoopTransition(sql as any, {
      workspaceId: 'ws-1',
      installSlug: 'papercusp',
      routineId: 'r1',
      event: 'rearmed',
      actor: 'reconcile-loop-routines',
      newNextFireAt: '2026-08-03T04:07:16.000Z',
      detail: { via: 'lifecycle', wasParked: true, parkedMs: 2_700_000 },
    });

    const insert = sql.statements.find((s) => /INSERT INTO/.test(s.text))!;
    expect(insert.values).toContain(JSON.stringify({ via: 'lifecycle', wasParked: true, parkedMs: 2_700_000 }));
    // Absent optionals must bind as SQL NULL, never undefined (postgres-js rejects undefined).
    expect(insert.values).not.toContain(undefined);
    expect(insert.values.filter((v) => v === null).length).toBeGreaterThan(0);
  });

  it('FAIL-SOFT: a failing insert never throws into the caller', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({ throwOn: /INSERT INTO/ });

    // The guarded property: the fire path awaits nothing and can never be broken by
    // the instrument. A rejection here would surface as a failed claim/re-arm.
    await expect(recordLoopTransition(sql as any, PARK)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('FAIL-SOFT: a failing PRUNE never throws and never masks the successful insert', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({ throwOn: /DELETE FROM/ });

    await expect(recordLoopTransition(sql as any, PARK)).resolves.toBeUndefined();
    await new Promise((r) => setImmediate(r)); // let the fire-and-forget prune settle

    expect(sql.statements.some((s) => /INSERT INTO/.test(s.text))).toBe(true);
    // Hygiene failure is deliberately silent — it must not spam the fire path.
    expect(warn).not.toHaveBeenCalled();
  });

  it('an ABSENT table (42P01) warns ONCE then goes quiet — the code may deploy before its migration', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sql = fakeSql({ throwOn: /INSERT INTO/, code: '42P01' });

    await recordLoopTransition(sql as any, PARK);
    await recordLoopTransition(sql as any, PARK);
    await recordLoopTransition(sql as any, PARK);

    // One warn total, and no further SQL attempted: an instrument that floods the log at
    // loop cadence would bury the very signal it exists to surface.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/migration 745 not yet applied/);
    expect(sql.statements.filter((s) => /INSERT INTO/.test(s.text))).toHaveLength(1);
  });

  it('does NOT latch on a transient failure — a real write error stays visible every time', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // No `code`: an ordinary transient failure, not a missing relation.
    const sql = fakeSql({ throwOn: /INSERT INTO/ });

    await recordLoopTransition(sql as any, PARK);
    await recordLoopTransition(sql as any, PARK);

    // The quiet path is scoped to "table absent" ONLY. Latching on any error would let a
    // genuine, ongoing write fault disappear after its first occurrence.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(sql.statements.filter((s) => /INSERT INTO/.test(s.text))).toHaveLength(2);
  });

  it('throttles the piggybacked prune so it does not run on every transition', async () => {
    const sql = fakeSql();

    await recordLoopTransition(sql as any, PARK);
    await recordLoopTransition(sql as any, PARK);
    await recordLoopTransition(sql as any, PARK);
    await new Promise((r) => setImmediate(r));

    const deletes = sql.statements.filter((s) => /DELETE FROM harness_shared\.routine_loop_transitions/.test(s.text));
    expect(deletes).toHaveLength(1);
    expect(sql.statements.filter((s) => /INSERT INTO/.test(s.text))).toHaveLength(3);
  });
});

describe('transitionRetentionDays', () => {
  const prev = process.env.PAPERCUSP_LOOP_TRANSITION_RETENTION_DAYS;
  afterEach(() => {
    if (prev === undefined) delete process.env.PAPERCUSP_LOOP_TRANSITION_RETENTION_DAYS;
    else process.env.PAPERCUSP_LOOP_TRANSITION_RETENTION_DAYS = prev;
  });

  it('defaults to 7 days', () => {
    delete process.env.PAPERCUSP_LOOP_TRANSITION_RETENTION_DAYS;
    expect(transitionRetentionDays()).toBe(7);
  });

  it('honours an explicit override', () => {
    process.env.PAPERCUSP_LOOP_TRANSITION_RETENTION_DAYS = '30';
    expect(transitionRetentionDays()).toBe(30);
  });

  it('floors at 1 day so a bad value can never disable the evidence window', () => {
    // A 0/negative/garbage retention would prune the table to nothing on the next write —
    // silently destroying the exact history this table exists to hold.
    for (const bad of ['0', '-5', 'abc', '']) {
      process.env.PAPERCUSP_LOOP_TRANSITION_RETENTION_DAYS = bad;
      expect(transitionRetentionDays()).toBe(7);
    }
  });
});
