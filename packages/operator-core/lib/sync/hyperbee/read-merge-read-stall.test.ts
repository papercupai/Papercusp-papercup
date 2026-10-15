/**
 * read-merge-read-stall.test.ts — WI-2141796: a log position that never becomes
 * readable pins its cursor forever, and that MUST NOT be silent.
 *
 * THE INCIDENT (2026-09-02, tower). The `papercusp` merge cursor on log
 * `cb54460d98d8` sat at position 12048 while the writer ran on past 25,000. Every
 * inbound coordination row written after 09:42Z lived at a position the cursor had
 * never reached, so cross-machine coordination was dead for ~7.5 hours.
 *
 * WHY NOTHING CAUGHT IT. The `unavailable` branch of the read loop `break`s with no
 * output whatsoever. No apply is attempted at a position that never reads, so no
 * apply-timeout, no quarantine, no constraint error and no rollback ever fires. The
 * peer stays connected, so replication-liveness reports `live` and the substrate
 * health verdict reports `healthy`. Worse, the cursor ROW looks fresh: positions are
 * persisted as ONE map, so a SIBLING log advancing re-stamps the frozen row's
 * `updated_at`. A moving `updated_at` next to a frozen `position` is indistinguishable
 * from a healthy merge unless you compare the position against the writer's length.
 *
 * THE FIX IS OBSERVABILITY ONLY — the retry stays UNBOUNDED and unchanged, because a
 * withheld block is usually transient and dead-lettering it would lose a
 * readable-later op. What changes is that the stall now announces itself, names the
 * position, and reports how many ops are stranded behind it.
 *
 * TEETH: assert the warning is EMITTED, names the position, and reports the stranded
 * backlog — and that the cursor really is held (the pin is real, not hypothetical).
 * Before the fix the merge emitted nothing at all on this path, so the first
 * assertion fails outright.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createMergeCursor, mergeAdmittedLogsIncremental, type AdmittedLog } from './read-merge';
import type { OpEnvelope } from './op-envelope-types';
import type { PeerLogOp } from './peer-log';

function put(hbKey: string, ts: number): PeerLogOp {
  return { type: 'put', table: 'features-by-id', hbKey, value: {}, ts, schema_version: 1, author_pubkey: 'pk' };
}

/** A log whose `get(stallIndex)` NEVER settles — models a peer that is connected and
 *  serving the swarm but never returns this particular block. Every other index
 *  resolves normally. */
function logWithStalledIndex(keyHex: string, ops: PeerLogOp[], stallIndex: number): AdmittedLog {
  return {
    keyHex,
    length: ops.length,
    get: async (i) => {
      if (i === stallIndex) return new Promise<never>(() => {}); // never settles
      return ops[i] ?? null;
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('WI-2141796 — a permanently-unreadable position announces itself instead of pinning the cursor silently', () => {
  it('emits a read-stall warning naming the position and the ops stranded behind it, and holds the cursor there', async () => {
    const cursor = createMergeCursor();
    // index0 reads → index1 NEVER settles → index2/3 are stranded behind it.
    const log = logWithStalledIndex('ABCDEF0123456789', [put('a', 1000), put('b', 2000), put('c', 3000), put('d', 4000)], 1);
    const applied: string[] = [];
    const apply = async (op: OpEnvelope): Promise<boolean> => {
      applied.push(op.hbKey ?? '');
      return true;
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 15 });

    // The pin is real: index0 folded, then the fold stopped AT the stalled position.
    expect(applied).toEqual(['a']);
    expect(cursor.positions.get('ABCDEF0123456789')).toBe(1);

    // …and it is no longer silent. THIS is the assertion that fails before the fix.
    const stallWarnings = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('read stall'));
    expect(stallWarnings).toHaveLength(1);
    expect(stallWarnings[0]).toContain('ABCDEF012345#1'); // the exact wedged position
    expect(stallWarnings[0]).toContain('3 op(s) behind it'); // length 4 − position 1
  });

  it('counts consecutively on the SAME position, and throttles below one line per pass', async () => {
    const cursor = createMergeCursor();
    const log = logWithStalledIndex('BEEF', [put('a', 1000), put('b', 2000)], 1);
    const apply = async (): Promise<boolean> => true;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // 5 passes over a permanently-stalled position: the cursor never advances, and
    // the journal must report that WITHOUT emitting a line per pass.
    for (let i = 0; i < 5; i++) {
      await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 10 });
    }

    expect(cursor.positions.get('BEEF')).toBe(1); // still pinned, five passes later
    expect(cursor.readStalls?.get('BEEF:1')).toBe(5); // counted every pass
    const stallWarnings = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('read stall'));
    // Doubling schedule → passes 1,2,4 announce; 3 and 5 stay quiet. Both bounds
    // matter: fewer than every pass (no flood), more than once (no false silence —
    // see the persisting-stall test below for why that direction is the dangerous one).
    expect(stallWarnings.length).toBeGreaterThan(1);
    expect(stallWarnings.length).toBeLessThan(5);
  });

  it('a stall that CLEARS resets the streak, so a transient blip cannot masquerade as a wedged log', async () => {
    const cursor = createMergeCursor();
    const ops = [put('a', 1000), put('b', 2000), put('c', 3000)];
    let stalled = true; // index1 withholds on the first pass, then serves
    const log: AdmittedLog = {
      keyHex: 'CAFE',
      length: ops.length,
      get: async (i) => {
        if (i === 1 && stalled) return new Promise<never>(() => {});
        return ops[i] ?? null;
      },
    };
    const applied: string[] = [];
    const apply = async (op: OpEnvelope): Promise<boolean> => {
      applied.push(op.hbKey ?? '');
      return true;
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 15 });
    expect(cursor.readStalls?.get('CAFE:1')).toBe(1);

    stalled = false; // the peer starts serving the block
    await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: apply, getTimeoutMs: 15 });

    expect(applied).toEqual(['a', 'b', 'c']); // the whole log folded once it cleared
    expect(cursor.readStalls?.get('CAFE:1')).toBeUndefined(); // streak cleared on success
    expect(cursor.positions.get('CAFE')).toBe(3);
  });

  /**
   * WI-2141796 follow-up, found by USING the fix above in production. The first
   * stall line it emitted read `cb54460d98d8#7585` — and the papercusp cursor was
   * at 14796, because ONE LOG IS FOLDED BY MANY HARNESSES, each through its own
   * cursor at its own position (39 rows on that log, spanning 6467..15595). A line
   * naming only `<log>#<pos>` cannot say WHOSE cursor stalled, and the numbers are
   * close enough to invite correlating one harness's stall with another's position.
   *
   * TEETH: the label must reach the emitted line. Dropping `cursorTag` from the
   * template, or failing to thread `cursorLabel` through from the caller, fails the
   * first assertion. The second pins the ambiguity itself: two harnesses stalling on
   * the SAME log at DIFFERENT positions must produce distinguishable lines.
   */
  it('names the cursor OWNER in the stall line, so two harnesses folding the same log are distinguishable', async () => {
    const ops = [put('a', 1000), put('b', 2000), put('c', 3000)];
    const lines: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((m: unknown) => void lines.push(String(m)));
    const apply = async (): Promise<boolean> => true;

    // Same log keyHex, two harnesses, stalling at DIFFERENT positions.
    await mergeAdmittedLogsIncremental([logWithStalledIndex('CB54460D98D8', ops, 1)], createMergeCursor(), {
      applyImpl: apply,
      getTimeoutMs: 15,
      cursorLabel: 'papercusp-workspace/papercusp',
    });
    await mergeAdmittedLogsIncremental([logWithStalledIndex('CB54460D98D8', ops, 2)], createMergeCursor(), {
      applyImpl: apply,
      getTimeoutMs: 15,
      cursorLabel: 'papercusp-workspace/hive-canary',
    });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('[papercusp-workspace/papercusp]');
    expect(lines[0]).toContain('CB54460D98D8#1');
    expect(lines[1]).toContain('[papercusp-workspace/hive-canary]');
    expect(lines[1]).toContain('CB54460D98D8#2');
    // The whole point: the two lines are not confusable with each other.
    expect(lines[0]).not.toEqual(lines[1]);
  });

  /**
   * WI-2141796 follow-up #2, also found by USING the fix. The original throttle was
   * `n === 1 || n % 100 === 0`, which announces a stall STARTING and then says
   * nothing for 98 more passes. Measured in production: papercusp stalled at
   * `cb54460d98d8#15595`, emitted one `1×` line at 17:38:58Z, and the journal stayed
   * silent for 7+ minutes while the cursor did not advance a single position.
   *
   * That silence is the bug reappearing one level up: an operator reading the log
   * cannot tell "the block arrived and we moved on" from "still wedged, 40 passes
   * deep". The whole point of the warning was to end exactly that ambiguity.
   *
   * TEETH: assert a PERSISTING stall re-announces with a CLIMBING count. Reverting
   * to the flat `% 100` throttle yields 1 line where this demands several, and the
   * final assertion pins that the counts are strictly increasing — a throttle that
   * re-warned with a constant number would satisfy a bare line-count check.
   */
  it('keeps announcing a PERSISTING stall with a climbing count, instead of going silent after the first pass', async () => {
    const cursor = createMergeCursor();
    const ops = [put('a', 1000), put('b', 2000), put('c', 3000)];
    const log = logWithStalledIndex('DEAD', ops, 1); // index1 NEVER serves
    const lines: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((m: unknown) => void lines.push(String(m)));

    // 16 passes over a position that never becomes readable.
    for (let i = 0; i < 16; i++) {
      await mergeAdmittedLogsIncremental([log], cursor, {
        applyImpl: async (): Promise<boolean> => true,
        getTimeoutMs: 5,
      });
    }

    expect(cursor.readStalls?.get('DEAD:1')).toBe(16); // it really did stall every pass
    expect(cursor.positions.get('DEAD')).toBe(1); // …and the cursor really is held

    // 1,2,4,8,16 → five announcements. The old flat throttle emitted exactly one.
    const counts = lines.map((l) => Number(/read stall \((\d+)×\)/.exec(l)?.[1]));
    expect(counts).toEqual([1, 2, 4, 8, 16]);
    expect(counts.length).toBeGreaterThan(1); // the defect this test exists to catch
    // Strictly increasing: the count must report DURATION, not just recur.
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThan(counts[i - 1]!);
  });

  it('omits the label cleanly when no cursorLabel is supplied, so the line stays well-formed', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((m: unknown) => void lines.push(String(m)));
    await mergeAdmittedLogsIncremental(
      [logWithStalledIndex('BEEF', [put('a', 1000), put('b', 2000)], 1)],
      createMergeCursor(),
      { applyImpl: async (): Promise<boolean> => true, getTimeoutMs: 15 },
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[read-merge] read stall'); // no stray brackets or double space
    expect(lines[0]).toContain('BEEF#1');
  });
});

/** A log whose `get(slowIndex)` resolves only AFTER `delayMs` — models a block that
 *  IS served, just not inside the bound. Every other index resolves normally. */
function logWithSlowIndex(keyHex: string, ops: PeerLogOp[], slowIndex: number, delayMs: number): AdmittedLog {
  return {
    keyHex,
    length: ops.length,
    get: async (i) => {
      if (i === slowIndex) await new Promise((r) => setTimeout(r, delayMs));
      return ops[i] ?? null;
    },
  };
}

const lateReads = (spy: { mock: { calls: unknown[][] } }): string[] =>
  spy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('late read'));

describe('WI-2141796 — SLOW-but-served and genuinely-unreadable must not look identical', () => {
  // A read-stall line proves only that the read did not FINISH in the bound. Both a
  // withheld block and a merely-slow one produce that same line, and they imply
  // OPPOSITE fixes (chase the peer vs. fix what made the read slow). These two tests
  // pin that the pair is now distinguishable from the journal alone.

  it('says so when the abandoned read DID eventually arrive — the block was slow, not unreadable', async () => {
    const cursor = createMergeCursor();
    const log = logWithSlowIndex('CAFEBABE', [put('a', 1000), put('b', 2000)], 1, 60);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: async () => true, getTimeoutMs: 5 });

    // The bound gave up and pinned the cursor, exactly as for an unreadable block…
    expect(warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('read stall'))).toHaveLength(1);
    expect(cursor.positions.get('CAFEBABE')).toBe(1);

    // …but the read arrives afterwards, and THAT is what must now be reported.
    await new Promise((r) => setTimeout(r, 120));
    const late = lateReads(warnSpy);
    expect(late).toHaveLength(1);
    expect(late[0]).toContain('CAFEBABE#1');
    expect(late[0]).toContain('DID eventually resolve');
  });

  it('caches a late result so a consistently slow block eventually advances instead of starving the cursor', async () => {
    const cursor = createMergeCursor();
    const ops = [put('a', 1000), put('b', 2000)];
    let getCalls = 0;
    const log: AdmittedLog = {
      keyHex: 'SLOWREUSE',
      length: ops.length,
      get: async (i) => {
        getCalls++;
        if (i === 1) await new Promise((r) => setTimeout(r, 60));
        return ops[i] ?? null;
      },
    };
    const applied: string[] = [];
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // The first pass times out at index 1 and registers a late-result cache.
    const first = await mergeAdmittedLogsIncremental([log], cursor, {
      applyImpl: async (op) => {
        applied.push(op.hbKey ?? '');
        return true;
      },
      getTimeoutMs: 5,
      cursorLabel: 'low-load-repro',
    });
    expect(first.caughtUp).toBe(false);
    expect(cursor.positions.get('SLOWREUSE')).toBe(1);
    expect(getCalls).toBe(2); // index 0 + one physical attempt for index 1

    // A second pass before the 60ms read resolves may retry (preserving the
    // never-settling-read contract), but its eventual result is cached.
    const second = await mergeAdmittedLogsIncremental([log], cursor, {
      applyImpl: async (op) => {
        applied.push(op.hbKey ?? '');
        return true;
      },
      getTimeoutMs: 5,
      cursorLabel: 'low-load-repro',
    });
    expect(second.caughtUp).toBe(false);
    expect(getCalls).toBe(3);

    // Once either late read resolves, the next pass consumes its cached result.
    await new Promise((r) => setTimeout(r, 80));
    const third = await mergeAdmittedLogsIncremental([log], cursor, {
      applyImpl: async (op) => {
        applied.push(op.hbKey ?? '');
        return true;
      },
      getTimeoutMs: 5,
      cursorLabel: 'low-load-repro',
    });
    expect(third.caughtUp).toBe(true);
    expect(cursor.positions.get('SLOWREUSE')).toBe(2);
    expect(getCalls).toBe(3);
    expect(applied).toEqual(['a', 'b']);
    expect(lateReads(warnSpy).length).toBeGreaterThan(0);
  });

  it('retains one result per held position when multiple timed-out reads settle', async () => {
    const cursor = createMergeCursor();
    const ops = [put('a', 1000), put('b', 2000)];
    const finish: Array<(op: PeerLogOp) => void> = [];
    const log: AdmittedLog = {
      keyHex: 'DUPLICATELATE',
      length: ops.length,
      get: async (i) => i === 0 ? ops[i] : new Promise<PeerLogOp>((resolve) => finish.push(resolve)),
    };
    const applied: string[] = [];
    const opts = {
      applyImpl: async (op: OpEnvelope) => { applied.push(op.hbKey ?? ''); return true; },
      getTimeoutMs: 5,
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await mergeAdmittedLogsIncremental([log], cursor, opts);
    await mergeAdmittedLogsIncremental([log], cursor, opts);
    expect(finish).toHaveLength(2);
    for (const resolve of finish) resolve(ops[1]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cursor.lateReadResults?.size).toBe(1);
    expect(cursor.lateReadResults?.get('DUPLICATELATE:1')).toEqual({ kind: 'op', op: ops[1] });
    const result = await mergeAdmittedLogsIncremental([log], cursor, opts);
    expect(result.caughtUp).toBe(true);
    expect(applied).toEqual(['a', 'b']);
    expect(finish).toHaveLength(2);
    expect(cursor.lateReadResults?.size).toBe(0);
  });

  it('keeps a served late block when another timed-out attempt rejects', async () => {
    const cursor = createMergeCursor();
    const ops = [put('a', 1000), put('b', 2000)];
    const attempts: Array<{ resolve: (op: PeerLogOp) => void; reject: (error: Error) => void }> = [];
    const log: AdmittedLog = {
      keyHex: 'LATEMIXED',
      length: ops.length,
      get: async (i) => i === 0 ? ops[i] : new Promise<PeerLogOp>((resolve, reject) => attempts.push({ resolve, reject })),
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = { applyImpl: async () => true, getTimeoutMs: 5 };
    await mergeAdmittedLogsIncremental([log], cursor, opts);
    await mergeAdmittedLogsIncremental([log], cursor, opts);
    attempts[0].reject(new Error('first attempt failed'));
    attempts[1].resolve(ops[1]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cursor.lateReadResults?.get('LATEMIXED:1')).toEqual({ kind: 'op', op: ops[1] });
    const result = await mergeAdmittedLogsIncremental([log], cursor, opts);
    expect(result.caughtUp).toBe(true);
    expect(cursor.positions.get('LATEMIXED')).toBe(2);
    expect(attempts).toHaveLength(2);
  });

  it('stays SILENT for a read that never settles — the control that gives the late-read line its meaning', async () => {
    const cursor = createMergeCursor();
    const log = logWithStalledIndex('D00D', [put('a', 1000), put('b', 2000)], 1);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await mergeAdmittedLogsIncremental([log], cursor, { applyImpl: async () => true, getTimeoutMs: 5 });
    await new Promise((r) => setTimeout(r, 120));

    // Same read-stall line as the slow case — which is precisely why the ABSENCE of a
    // late-read line has to carry the distinction. A late-read line that fired here
    // too would tell a reader nothing.
    expect(warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('read stall'))).toHaveLength(1);
    expect(lateReads(warnSpy)).toHaveLength(0);
  });
});
