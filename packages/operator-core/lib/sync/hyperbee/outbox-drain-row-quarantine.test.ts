/**
 * outbox-drain-row-quarantine.test.ts — WI-3896 (tower outbox-drain wedge — the
 * "papercusp substrate_merge_cursor never establishes" incident).
 *
 * THE GAP `DRAIN_PASS_TIMEOUT_MS` (WI-2009) DOESN'T COVER: the pass-level
 * watchdog un-wedges the LOOP (a fresh pass re-attempts), but `drainOutboxOnce`
 * always re-selects the SAME earliest-undrained rows first (`ORDER BY id`) — so
 * when ONE row's stage (epoch-encrypt / append) genuinely never settles, it is
 * the leading row of EVERY pass, every pass times out on that SAME row, and
 * NOTHING behind it ever gets a chance to drain. That is the live incident
 * shape: outbox-drain kept retrying forever with zero net progress.
 *
 * THE FIX: a per-row stage timeout (`ROW_STAGE_TIMEOUT_MS`, bound well under the
 * pass-level timeout) names the exact hanging row; `startOutboxDrain` counts
 * CONSECUTIVE timeouts for that SAME row id and, after `ROW_QUARANTINE_THRESHOLD`,
 * adds it to a standing quarantine set that `drainOutboxOnce` checks BEFORE any
 * hanging stage on every future pass — so a poison row is permanently skipped
 * (left undrained ON PURPOSE, never falsely marked drained_at) and rows behind
 * it resume draining normally.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  startOutboxDrain,
  RowStageTimeoutError,
  ROW_STAGE_TIMEOUT_MS,
  ROW_QUARANTINE_THRESHOLD,
} from './outbox-drain';
import type { BootedHarnessHandle } from './boot';

/** Minimal postgres.Sql fake — same shape as outbox-drain-stall.test.ts's. */
function fakePg(nextRows: () => unknown[], opts: { onUpdate?: (vals: unknown[]) => void } = {}) {
  const tag = async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const sql = strings.join(' ');
    if (/SELECT id, table_name/.test(sql)) {
      return nextRows() as unknown[] & { count?: number };
    }
    if (/UPDATE harness_shared\.substrate_outbox\s+SET drained_at/.test(sql)) {
      opts.onUpdate?.(vals);
    }
    const r = [] as unknown[] & { count?: number };
    r.count = 0;
    return r;
  };
  (tag as unknown as { listen: unknown }).listen = () => ({ unlisten: async () => {} });
  return tag as never;
}

function fakeHandle(append: (op: unknown) => Promise<void>, harnessSlug = 'hx'): BootedHarnessHandle {
  return {
    workspaceId: 'ws',
    harnessSlug,
    ownLog: { keyHex: 'aa'.repeat(32) },
    append,
    registerCloseHook: () => {},
  } as unknown as BootedHarnessHandle;
}

function row(id: number, key: string) {
  return { id, table_name: 'harness_features_consolidated', op: 'put', key, row: { id: key }, ts: id, op_hlc: null };
}

/** Model the real SELECT exclusion and the persistence receipt, including a
 * delayed/failed write. A test must not return quarantined rows from the batch
 * query: doing so hides the DB-clear vs process-local-set disagreement. */
function quarantinePg(opts: {
  initiallyQuarantined?: boolean;
  persist?: () => Promise<void>;
} = {}) {
  let quarantined = opts.initiallyQuarantined ?? false;
  let drained = false;
  const persist = vi.fn(async () => {
    await opts.persist?.();
    quarantined = true;
    return [{ id: 1 }];
  });
  const tag = async (strings: TemplateStringsArray, ..._vals: unknown[]) => {
    const sql = strings.join(' ');
    if (/SELECT id, table_name/.test(sql)) return quarantined || drained ? [] : [row(1, 'retry')];
    if (/SELECT id FROM/.test(sql)) return quarantined && !drained ? [{ id: 1 }] : [];
    if (/SET quarantined_at/.test(sql)) return persist();
    if (/SET drained_at/.test(sql)) drained = true;
    return Object.assign([], { count: 0 });
  };
  tag.listen = () => ({ unlisten: async () => {} });
  return {
    pg: tag as never,
    persist,
    clear: () => { quarantined = false; },
    drained: () => drained,
    quarantined: () => quarantined,
  };
}

describe('outbox-drain per-row poison quarantine (WI-3896)', () => {
  it.each(['boot', 'live'] as const)('manual DB clear retries a %s quarantine without restarting the drain', async (origin) => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = quarantinePg({ initiallyQuarantined: origin === 'boot' });
    let repaired = false;
    const append = vi.fn(async () => {
      if (!repaired) return new Promise<void>(() => {});
    });
    const episodes: string[] = [];
    const drain = startOutboxDrain(fakeHandle(append), db.pg, {
      pollMs: 1000, _passTimeoutMs: 0, _backlogStallMs: 0,
      _rowTimeoutMs: 100, _rowQuarantineThreshold: 3,
      _onStallEpisode: (_detail, kind) => { if (kind) episodes.push(kind); },
    });
    try {
      await vi.advanceTimersByTimeAsync(3200);
      expect(db.quarantined()).toBe(true);
      expect(db.drained()).toBe(false);
      expect(append).toHaveBeenCalledTimes(origin === 'boot' ? 0 : 3);
      repaired = true;
      db.clear(); // the documented manual retry, using the SAME live drain
      await vi.advanceTimersByTimeAsync(1000);
      expect(append).toHaveBeenCalledTimes(origin === 'boot' ? 1 : 4);
      expect(db.drained()).toBe(true); // only after the append actually resolves
      expect(episodes.filter(kind => kind === 'drain_row_quarantined')).toHaveLength(origin === 'boot' ? 0 : 1);
    } finally {
      await drain.stop();
      errSpy.mockRestore(); warnSpy.mockRestore(); vi.useRealTimers();
    }
  });

  it.each(['pending', 'failed', 'no-receipt'] as const)('keeps the in-memory quarantine while persistence is %s', async (outcome) => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = quarantinePg({ persist: () => outcome === 'pending'
      ? new Promise<void>(() => {}) : Promise.reject(new Error('persist failed')) });
    const pg = outcome === 'no-receipt'
      ? fakePg(() => [row(1, 'retry')]) : db.pg;
    const append = vi.fn(() => new Promise<void>(() => {}));
    const drain = startOutboxDrain(fakeHandle(append, `hx-fallback-${outcome}`), pg, {
      pollMs: 1000, _passTimeoutMs: 0, _backlogStallMs: 0,
      _rowTimeoutMs: 100, _rowQuarantineThreshold: 3,
      _onStallEpisode: () => {},
    });
    try {
      await vi.advanceTimersByTimeAsync(6200);
      expect(append).toHaveBeenCalledTimes(3);
      expect(db.drained()).toBe(false);
    } finally {
      await drain.stop();
      errSpy.mockRestore(); warnSpy.mockRestore(); vi.useRealTimers();
    }
  });

  it('a cleared row that still hangs gets three new attempts and is quarantined again without false delivery', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = quarantinePg();
    const append = vi.fn(() => new Promise<void>(() => {}));
    const episodes: string[] = [];
    const drain = startOutboxDrain(fakeHandle(append), db.pg, {
      pollMs: 1000, _passTimeoutMs: 0, _backlogStallMs: 0,
      _rowTimeoutMs: 100, _rowQuarantineThreshold: 3,
      _onStallEpisode: (_detail, kind) => { if (kind) episodes.push(kind); },
    });
    try {
      await vi.advanceTimersByTimeAsync(3200);
      expect(append).toHaveBeenCalledTimes(3);
      expect(db.persist).toHaveBeenCalledTimes(1);
      db.clear();
      await vi.advanceTimersByTimeAsync(4000);
      expect(append).toHaveBeenCalledTimes(6);
      expect(db.persist).toHaveBeenCalledTimes(2);
      expect(db.quarantined()).toBe(true);
      expect(db.drained()).toBe(false);
      expect(episodes.filter(kind => kind === 'drain_row_quarantined')).toHaveLength(2);
    } finally {
      await drain.stop();
      errSpy.mockRestore(); warnSpy.mockRestore(); vi.useRealTimers();
    }
  });

  it('a row that NEVER settles is quarantined after N consecutive timeouts — later rows then drain', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // row=1 ("poison") never settles; row=2 ("good") succeeds instantly whenever reached.
      const append = vi.fn(async (op: unknown) => {
        if ((op as { hbKey?: string }).hbKey === 'poison') return new Promise<void>(() => {}); // hangs forever
        // good row: resolves immediately
      });
      const episodes: Array<{ detail: string; kind?: string }> = [];
      const updated: unknown[][] = [];
      // Every pass's SELECT returns the same two undrained rows (the fake never
      // marks poison drained; good's UPDATE is observed but the fake keeps
      // returning it too, since we don't bother filtering it out post-drain —
      // we only assert on append call counts + the quarantine episode).
      const pg = fakePg(() => [row(1, 'poison'), row(2, 'good')], {
        onUpdate: (vals) => updated.push(vals),
      });

      const drain = startOutboxDrain(fakeHandle(append), pg, {
        pollMs: 1000,
        _passTimeoutMs: 0, // isolate the per-row detector from the pass-level watchdog
        _backlogStallMs: 0,
        _rowTimeoutMs: 100,
        _rowQuarantineThreshold: 3,
        _onStallEpisode: (detail, kind) => episodes.push({ detail, kind }),
      });

      // Initial pass: row 1 hangs, row-stage timeout fires at 100ms → 1st episode counted
      // (not yet quarantined — threshold is 3). No row-2 progress yet (pass aborted at row 1).
      await vi.advanceTimersByTimeAsync(150);
      expect(append).toHaveBeenCalledTimes(1);
      expect(updated).toHaveLength(0);

      // Poll #2 (1000ms cadence) re-attempts the SAME batch → row 1 hangs again (2nd timeout).
      await vi.advanceTimersByTimeAsync(1000);
      expect(append).toHaveBeenCalledTimes(2);

      // Poll #3 → 3rd consecutive timeout on row 1 → QUARANTINED. The quarantine
      // is applied in this poll's CATCH (after the pass already rejected on row
      // 1), so row 2 is reached on the NEXT pass, not this one.
      await vi.advanceTimersByTimeAsync(1000);
      const quarantined = episodes.filter((e) => e.kind === 'drain_row_quarantined');
      expect(quarantined).toHaveLength(1);
      expect(quarantined[0]!.detail).toContain('id=1');
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('WI-3896 quarantine'));

      // Poll #4: row 1 is now quarantined → skipped instantly, row 2 is reached
      // + applied in THIS pass.
      await vi.advanceTimersByTimeAsync(1000);
      expect(updated.length).toBeGreaterThanOrEqual(1);
      // append was called for 'good' at least once (row.hbKey 'good' calls resolve
      // instantly and don't hang, unlike 'poison').
      expect(append.mock.calls.some((c) => (c[0] as { hbKey?: string }).hbKey === 'good')).toBe(true);

      // Further polls: row 1 stays quarantined — no more hang-append attempts on it,
      // and the skip warning is logged (deduped, not spammed).
      const appendCallsBeforeMorePolls = append.mock.calls.filter(
        (c) => (c[0] as { hbKey?: string }).hbKey === 'poison',
      ).length;
      await vi.advanceTimersByTimeAsync(3000);
      const poisonCallsAfter = append.mock.calls.filter(
        (c) => (c[0] as { hbKey?: string }).hbKey === 'poison',
      ).length;
      expect(poisonCallsAfter).toBe(appendCallsBeforeMorePolls); // never called again
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('QUARANTINED poison row id=1'));

      await drain.stop();
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('a row that times out just ONCE (transient/load-induced) is NOT quarantined — plain retry, no episode', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let calls = 0;
      const append = vi.fn(async () => {
        calls += 1;
        if (calls === 1) return new Promise<void>(() => {}); // hangs once
        // subsequent calls succeed instantly
      });
      const episodes: Array<{ detail: string; kind?: string }> = [];
      const pg = fakePg(() => [row(1, 'k1')]);

      const drain = startOutboxDrain(fakeHandle(append), pg, {
        pollMs: 1000,
        _passTimeoutMs: 0,
        _backlogStallMs: 0,
        _rowTimeoutMs: 100,
        _rowQuarantineThreshold: 3,
        _onStallEpisode: (detail, kind) => episodes.push({ detail, kind }),
      });

      await vi.advanceTimersByTimeAsync(150); // 1st timeout — below threshold
      expect(episodes.filter((e) => e.kind === 'drain_row_quarantined')).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1000); // retry — this time it succeeds
      expect(episodes.filter((e) => e.kind === 'drain_row_quarantined')).toHaveLength(0);
      expect(calls).toBeGreaterThanOrEqual(2);

      await drain.stop();
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('RowStageTimeoutError names the row id + stage + timeout in its message', () => {
    const e = new RowStageTimeoutError(42, 'epoch-encrypt (row id=42 table=t)', 45_000);
    expect(e.rowId).toBe(42);
    expect(e.message).toContain('row id=42');
    expect(e.message).toContain('45000ms');
    expect(e.name).toBe('RowStageTimeoutError');
  });

  it('production defaults: row-stage timeout well under the pass-level watchdog; quarantine threshold matches WI-255', () => {
    expect(ROW_STAGE_TIMEOUT_MS).toBe(45_000);
    expect(ROW_QUARANTINE_THRESHOLD).toBe(3);
  });

  it('WI-3896 follow-up: a HUNG fan-out (never settles) no longer wedges the pass for the full 120s pass-level watchdog — it gives up after fanoutTimeoutMs and the row still drains', async () => {
    // Live incident this pins: [outbox-drain] PASS TIMEOUT fired 17x in a row, every
    // time on the SAME 'fanout (row id=...)' stage — because fan-out was previously
    // bounded ONLY by logIfStageStalls (observability-only, never times out), a
    // genuinely-hung fanout() blocked the row (and the whole pass) forever, so the
    // pass-level DRAIN_PASS_TIMEOUT_MS (120s) watchdog was the ONLY thing that ever
    // un-wedged it — and since the row is re-selected first every retry, it repeated
    // forever with zero net progress. Racing fan-out against its own fanoutTimeoutMs
    // (SEPARATE from epoch-encrypt/append's rowTimeoutMs — see follow-up-2 test below
    // for why they must NOT share a budget) lets it give up in well under 120s instead.
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const append = vi.fn(async () => {});
      const fanout = vi.fn(() => new Promise<void>(() => {})); // never settles
      const updated: unknown[][] = [];
      const pg = fakePg(() => [row(1, 'k1')], { onUpdate: (vals) => updated.push(vals) });

      const drain = startOutboxDrain(fakeHandle(append), pg, {
        pollMs: 1000,
        fanout,
        _passTimeoutMs: 0, // isolate the per-row detector from the pass-level watchdog
        _backlogStallMs: 0,
        _rowTimeoutMs: 100,
        _fanoutTimeoutMs: 100,
      });

      // The append lands immediately; fan-out hangs — but bounded at 100ms, so the
      // row still reaches mark-drained in THIS same pass rather than wedging it.
      await vi.advanceTimersByTimeAsync(150);

      expect(append).toHaveBeenCalledTimes(1);
      expect(fanout).toHaveBeenCalledTimes(1);
      expect(updated.length).toBeGreaterThanOrEqual(1); // drained despite the hung fan-out
      // Fan-out's timeout is caught by the EXISTING best-effort catch (non-blocking) —
      // logged as a fan-out failure, not a new "WI-3896 quarantine" class.
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('[outbox-drain] fan-out failed'),
        expect.stringContaining('row id=1'),
      );

      await drain.stop();
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('WI-3896 fanout-follow-up-2: a SYSTEMICALLY-degraded fan-out (every DIFFERENT row hangs, not one poison id) no longer exhausts the 120s pass watchdog after only ~2-3 rows — a tight fanoutTimeoutMs (separate from the 45s rowTimeoutMs) lets many more rows drain per pass', async () => {
    // Live incident this pins (post-deploy of the FIRST fanout fix): PASS TIMEOUT
    // recurred every ~2min (18:03:33, 18:05:34, 18:07:35) with ZERO quarantine
    // lines ever firing — journalctl showed the STALLING ROW ID ADVANCING between
    // consecutive stage-stall logs (6012522 -> 6012523, different tables), proving
    // this was NOT a single poison row (which the row-level quarantine already
    // handled) but a systemically-slow fan-out path (getOrgPg()'s pool) where
    // EVERY row's fan-out hangs. At the shared 45s rowTimeoutMs, only 120s/45s ~=
    // 2 rows fit in a pass before DRAIN_PASS_TIMEOUT_MS fires anyway — so the
    // per-row quarantine (needs 3 CONSECUTIVE timeouts on the SAME id) never gets
    // a chance to engage, and the pass just re-wedges forever with near-zero
    // throughput. A tight, SEPARATE fanoutTimeoutMs fixes the THROUGHPUT, not just
    // the single-row-forever case the first fix already covered.
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const append = vi.fn(async () => {});
      // EVERY row's fan-out hangs (systemic degradation, not one poison id).
      const fanout = vi.fn(() => new Promise<void>(() => {}));
      const updated: unknown[][] = [];
      // 5 distinct undrained rows returned every SELECT (mirrors the live
      // incident's growing undrained backlog across different row ids/tables).
      const rows5 = [row(1, 'k1'), row(2, 'k2'), row(3, 'k3'), row(4, 'k4'), row(5, 'k5')];
      const pg = fakePg(() => rows5, { onUpdate: (vals) => updated.push(vals) });

      const drain = startOutboxDrain(fakeHandle(append), pg, {
        pollMs: 100_000, // isolate this pass — no second poll during the assertion window
        fanout,
        _passTimeoutMs: 0, // isolate fan-out throughput from the pass-level watchdog itself
        _backlogStallMs: 0,
        _rowTimeoutMs: 45_000, // production magnitude — NOT what bounds fan-out anymore
        _fanoutTimeoutMs: 8_000, // production magnitude (FANOUT_ROW_TIMEOUT_MS)
      });

      // All 5 rows' fan-out hangs get bounded at 8s each = 40s total — comfortably
      // under the 120s pass budget (proving throughput, not just single-row escape).
      await vi.advanceTimersByTimeAsync(41_000);

      expect(fanout).toHaveBeenCalledTimes(5); // every row's fan-out was attempted
      expect(updated.length).toBe(5); // ALL 5 rows drained despite every fan-out hanging
      // Count only the "fan-out failed" lines, not console.error overall — an
      // ABANDONED per-row race's logIfStageStalls wrapper keeps its own internal
      // 15s stall-log timer armed even after raceRowStage gives up at 8s (a
      // pre-existing, harmless artifact of the shared raceRowStage+
      // logIfStageStalls combo, unrelated to this fix): a zombie
      // "[stage-stall] STAGE STALL ... fanout ..." line can still fire later for
      // an already-abandoned row, which would over-count a bare toHaveBeenCalledTimes.
      const fanoutFailedCalls = errSpy.mock.calls.filter((c) =>
        String(c[0]).includes('[outbox-drain] fan-out failed'),
      );
      expect(fanoutFailedCalls).toHaveLength(5); // 5 distinct fan-out-failed logs, one per row

      await drain.stop();
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
