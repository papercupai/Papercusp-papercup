import { describe, it, expect, vi } from 'vitest';
import { autoPauseLoopRoutine } from './loop-cost-cap';
import { deactivateLoop, reviveDisarmedLoop } from './loop';
import endTool from '../../agent-tools/loop/end';

/**
 * WI-37571 — every loop DISARM must leave a durable row in the append-only transition log.
 *
 * WHY THESE TESTS DRIVE THE REAL FUNCTIONS AND NOT `recordLoopTransition`.
 * The bug being guarded was never that the log helper was broken — it worked, it was tested,
 * and `'disarmed'` was declared in its type union and documented in the `event` column comment.
 * The bug was that NOTHING CALLED IT with that event: two call sites existed, both writing
 * `parked`/`rearmed`, so 26+ real disarms/day went unrecorded while the module's own docstring
 * promised they were recorded. A test of the helper passes in exactly that world. So each test
 * below drives the real disarm entry point (`autoPauseLoopRoutine`, `deactivateLoop`,
 * `reviveDisarmedLoop`) through a fake `sql` and asserts on what reached the wire.
 *
 * Two properties are guarded independently, because they fail in opposite directions:
 *   1. a genuine disarm DOES emit          (the original bug: silence)
 *   2. a non-transition does NOT emit      (the fix's own failure mode: phantom disarms
 *      inflating the very census this item's falsifier reconciles against)
 */

interface FakeOpts {
  /** Rows the UPDATE ... RETURNING should yield. Default: one row representing a real change. */
  updateRows?: Record<string, unknown>[];
  /** When set, the INSERT into the transition log rejects — the fail-soft probe. */
  failInsert?: boolean;
}

/**
 * A postgres-js-shaped tagged-template fake that routes by statement text, so an
 * `UPDATE ... RETURNING` can yield rows while the log INSERT is observed separately.
 */
function fakeSql(opts: FakeOpts = {}) {
  const statements: { text: string; values: unknown[] }[] = [];
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    statements.push({ text, values });
    if (/INSERT INTO harness_shared\.routine_loop_transitions/.test(text)) {
      if (opts.failInsert) return Promise.reject(new Error('simulated transition-log failure'));
      return Promise.resolve([] as any);
    }
    if (/^\s*UPDATE harness_shared\.routines/.test(text)) {
      return Promise.resolve((opts.updateRows ?? [DEFAULT_UPDATED_ROW]) as any);
    }
    return Promise.resolve([] as any);
  };
  return Object.assign(tag, {
    statements,
    /** The transition-log INSERTs this fake saw. The whole subject of these tests. */
    transitions: () =>
      statements.filter((s) => /INSERT INTO harness_shared\.routine_loop_transitions/.test(s.text)),
  });
}

const DEFAULT_UPDATED_ROW = {
  id: 'routine-abc',
  workspace_id: 'papercusp-workspace',
  install_slug: 'papercusp',
  name: 'loop-su-145fd',
  target_role: 'system:loop-wake',
  target_owner_id: 'su-145fd',
  reschedule_interval_sec: 1200,
  was_active: true,
  prev_next_fire_at: 'infinity',
  revived_count: 1,
  from_pause_reason: 'stalled-loops-guard (WI-6639): turns-stalled',
};

/** The emit is deliberately fire-and-forget (never awaited), so let its microtask land. */
const flush = () => new Promise((r) => setTimeout(r, 0));

const GUARD_REASON = 'stalled-loops-guard (WI-6639): turns-stalled: 3 fire(s), last fired ...';

describe('WI-37571: loop disarms are recorded in routine_loop_transitions', () => {
  describe('autoPauseLoopRoutine — the shared primitive behind 4 guards', () => {
    it('emits a disarmed transition when a routine actually crosses active TRUE -> FALSE', async () => {
      const sql = fakeSql();
      await autoPauseLoopRoutine(sql as any, 'routine-abc', GUARD_REASON);
      await flush();

      const rows = sql.transitions();
      // PRECONDITION: without this, an assertion over an empty list passes vacuously — which
      // is exactly how the original defect hid.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.values).toContain('disarmed');
      expect(rows[0]!.values).toContain('routine-abc');
      expect(rows[0]!.values).toContain('papercusp-workspace');
    });

    it('records the guard-authored reason, so WHICH guard disarmed stays recoverable', async () => {
      const sql = fakeSql();
      await autoPauseLoopRoutine(sql as any, 'routine-abc', GUARD_REASON);
      await flush();

      const detail = sql.transitions()[0]!.values.find(
        (v) => typeof v === 'string' && v.includes('stalled-loops-guard'),
      ) as string;
      expect(detail).toBeDefined();
      // The EI-19406534159939583 discriminator must survive: 'infinity' (parked in-flight,
      // re-arm path broke) vs a concrete instant (fires landed, no turn came) are different
      // faults, and the pause write nulls the column that separates them.
      expect(JSON.parse(detail).pausedNextFireAt).toBe('infinity');
    });

    it('accepts an explicit actor so per-guard disarm rates are a GROUP BY, not prose-parsing', async () => {
      const sql = fakeSql();
      await autoPauseLoopRoutine(sql as any, 'routine-abc', GUARD_REASON, 'stalled-loops-guard');
      await flush();

      expect(sql.transitions()[0]!.values).toContain('stalled-loops-guard');
    });

    it('CONTROL: does NOT emit when the routine was ALREADY inactive (a re-stamp, not a disarm)', async () => {
      // This write has no `AND active = TRUE` guard, so re-pausing an inactive routine still
      // updates metadata and returns a row. Logging that as a disarm would inflate the census
      // this item's falsifier reconciles — a phantom event is worse than a missing one,
      // because it corroborates a wrong story instead of leaving a visible gap.
      const sql = fakeSql({ updateRows: [{ ...DEFAULT_UPDATED_ROW, was_active: false }] });
      await autoPauseLoopRoutine(sql as any, 'routine-abc', GUARD_REASON);
      await flush();

      expect(sql.transitions()).toHaveLength(0);
    });

    it('CONTROL: does NOT emit when the UPDATE matched no row at all', async () => {
      const sql = fakeSql({ updateRows: [] });
      await autoPauseLoopRoutine(sql as any, 'missing-routine', GUARD_REASON);
      await flush();

      expect(sql.transitions()).toHaveLength(0);
    });

    it('FAIL-SOFT: a transition-log failure never fails the disarm it reports on', async () => {
      // The module's stated invariant: this log is EVIDENCE, never an input to scheduling, and
      // an instrument that can throw into the path it measures turns a diagnosis gap into an
      // outage. The disarm must still resolve.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const sql = fakeSql({ failInsert: true });
        await expect(autoPauseLoopRoutine(sql as any, 'routine-abc', GUARD_REASON)).resolves.toBeUndefined();
        await flush();

        // ...and it must be LOUD about its own failure rather than degrading silently: a log
        // that quietly stops recording is indistinguishable from a fleet that stopped
        // disarming anyone, which is the entire class of bug this item exists to close.
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]![0])).toContain('[loop-transition-log] record failed');
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('deactivateLoop — the loop:end path', () => {
    it('emits a disarmed transition attributed to loop-end, not to a guard', async () => {
      const sql = fakeSql();
      const ended = await deactivateLoop('su-145fd', { sql: sql as any });
      await flush();

      expect(ended).toBe(true);
      const rows = sql.transitions();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.values).toContain('disarmed');
      // An agent ending its own loop is a healthy outcome; a guard reaping it is not. Until
      // this row existed the durable record was identical (absent) for both.
      expect(rows[0]!.values).toContain('loop-end');
      expect(rows[0]!.values).toContain('su-145fd');
    });

    it('persists a caller-supplied stop reason instead of discarding it', async () => {
      const sql = fakeSql();
      await deactivateLoop('su-145fd', {
        sql: sql as any,
        reason: 'fleet lane drained; no further admitted work',
      });
      await flush();

      const detail = sql.transitions()[0]!.values.find(
        (v) => typeof v === 'string' && v.includes('fleet lane drained'),
      ) as string;
      expect(detail).toBeDefined();
      expect(JSON.parse(detail).reason).toBe('fleet lane drained; no further admitted work');
    });

    it('preserves a supervisory caller instead of mislabeling it as loop-end', async () => {
      const sql = fakeSql();
      await deactivateLoop('su-145fd', {
        sql: sql as any,
        actor: 'goal-stop-fanout',
        reason: 'goal g1 entered paused — goal-stop fan-out',
      });
      await flush();

      const row = sql.transitions()[0]!;
      expect(row.values).toContain('goal-stop-fanout');
      expect(row.values).not.toContain('loop-end');
      const detail = row.values.find(
        (v) => typeof v === 'string' && v.includes('goal-stop fan-out'),
      ) as string;
      expect(JSON.parse(detail).reason).toBe('goal g1 entered paused — goal-stop fan-out');
    });

    it('accepts reason while keeping the owner-scoped no-harness contract explicit', () => {
      const tool = endTool as unknown as {
        description?: string;
        guidance?: { when?: string };
        args: { safeParse: (value: unknown) => { success: boolean } };
      };

      // RE-PINNED 2026-08-31 (test-suite-recovery-2026-08-27 D-026). This used to require
      // that loop:end declare "no `harness` argument" and REJECT one. ea108a5722
      // (2026-08-31T01:28Z) deliberately reversed that: `harness` is now accepted and
      // IGNORED, because nearly every other tool in the catalog takes one and callers
      // reached for it out of habit, so the rejection was a papercut rather than a
      // safeguard. That is a considered contract change stated in three places at once
      // (description, guidance.when, and the field's own .describe()), not a drift.
      //
      // The claim being guarded never was "the key is rejected" — it is "loops are keyed
      // by OWNER, not by harness". So the pin moves to the property that still carries it:
      // the arg must be accepted AND documented as inert everywhere it appears. Pinning
      // only the schema would let the alias quietly become load-bearing with nothing red.
      expect(tool.description).toMatch(/owner-scoped/i);
      expect(tool.description).toMatch(/keyed by owner, not by harness/i);
      expect(tool.description).toMatch(/`harness`[^.]*no effect/i);
      expect(tool.guidance?.when).toMatch(/pass `reason`/i);
      expect(tool.guidance?.when).toMatch(/ignores `harness`/i);
      expect(tool.args.safeParse({ reason: 'goal complete' }).success).toBe(true);
      expect(tool.args.safeParse({ harness: 'papercusp' }).success).toBe(true);
      // The compatibility arg must say it does nothing where a caller reads the schema,
      // or it reads as a real scoping knob the first time someone inspects the args.
      const harnessField = (
        tool as unknown as { args: { shape: Record<string, { description?: string }> } }
      ).args.shape.harness;
      expect(harnessField?.description).toMatch(/ignored|no effect/i);
    });

    it('CONTROL: emits nothing — and returns false — when no active loop matched', async () => {
      const sql = fakeSql({ updateRows: [] });
      const ended = await deactivateLoop('su-nobody', { sql: sql as any });
      await flush();

      // Guards the return-value contract too: this function switched from a driver `count` to
      // the RETURNING row count when the emit was added, and `loop:end` reports this boolean
      // straight back to the caller.
      expect(ended).toBe(false);
      expect(sql.transitions()).toHaveLength(0);
    });

    it('emits one row per matched routine (duplicate loop rows provably occur here)', async () => {
      const sql = fakeSql({
        updateRows: [DEFAULT_UPDATED_ROW, { ...DEFAULT_UPDATED_ROW, id: 'routine-dup' }],
      });
      await deactivateLoop('su-145fd', { sql: sql as any });
      await flush();

      expect(sql.transitions()).toHaveLength(2);
    });
  });

  describe('reviveDisarmedLoop — the transition that makes the revival RATE observable', () => {
    const selectedPause = {
      pausedAtMs: Date.parse('2026-08-09T17:07:00.000Z'),
      pauseReason: 'stalled-loops-guard (WI-6639): turns-stalled: fixture',
    };

    it('emits a revived transition carrying the ratchet count', async () => {
      const sql = fakeSql();
      await reviveDisarmedLoop(
        sql as any,
        'routine-abc',
        selectedPause,
        'owner is making progressing tool calls',
      );
      await flush();

      const rows = sql.transitions();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.values).toContain('revived');
      expect(rows[0]!.values).toContain('stalled-loops-guard-revival');

      const detail = rows[0]!.values.find(
        (v) => typeof v === 'string' && v.includes('revivedCount'),
      ) as string;
      // The ratchet is this function's documented flap bound. A mutable counter can never show
      // the SEQUENCE (a later disarm overwrites the reason beside it); the event stream can.
      expect(JSON.parse(detail).revivedCount).toBe(1);
    });

    it('CONTROL: emits nothing when the loop was already active (the guarded no-op)', async () => {
      const sql = fakeSql({ updateRows: [] });
      await reviveDisarmedLoop(sql as any, 'routine-abc', selectedPause, 'already running');
      await flush();

      expect(sql.transitions()).toHaveLength(0);
    });
  });

  /**
   * FALSIFIABILITY CONTROL — permanent, and the reason the suite above is not vacuous.
   *
   * This reconstructs the PRE-FIX shape of the disarm write: the identical UPDATE with no
   * emit. It asserts that shape VIOLATES the property. Without it, every assertion above
   * would still pass if `recordLoopTransition` were wired to fire unconditionally, or if the
   * fake happened to record something incidental — and a guard that cannot fail is
   * indistinguishable from a disabled one.
   *
   * It is kept in-test rather than proved by mutating the tree, deliberately: git-sync sweeps
   * the whole shared checkout every few minutes and has committed a probe mutant before, so a
   * revert-run-restore probe has a real window and a restore step a killed turn can skip. A
   * permanent control gets identical evidence with no window at all.
   */
  it('CONTROL (pre-fix shape): the same UPDATE without an emit produces NO transition row', async () => {
    const sql = fakeSql();
    const preFixAutoPause = async (s: any, routineId: string, reason: string) => {
      await s`
        UPDATE harness_shared.routines
           SET active = FALSE, next_fire_at = NULL,
               metadata = COALESCE(metadata, '{}'::jsonb)
                        || jsonb_build_object('loop_paused_reason', ${reason}::text)
         WHERE id = ${routineId}
      `;
    };

    await preFixAutoPause(sql, 'routine-abc', GUARD_REASON);
    await flush();

    // The disarm happened...
    expect(sql.statements.some((s) => /UPDATE harness_shared\.routines/.test(s.text))).toBe(true);
    // ...and left no durable trace. This is what the whole fleet's disarm history looked like.
    expect(sql.transitions()).toHaveLength(0);
  });
});
