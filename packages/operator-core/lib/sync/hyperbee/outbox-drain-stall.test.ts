/**
 * WI-2009 (gate 1b, shared-hive-p2p-release-readiness-2026-07-03): the outbox-
 * drain pass watchdog. The drain loop serializes passes behind a `draining`
 * flag — before this fix, ONE pass hanging on an await (keychain unwrap inside
 * epochEncrypt on a wedged mac keychain [WI-2018], epoch-key resolution, a
 * wedged append) froze the loop FOREVER: every later poll/NOTIFY coalesced
 * into the stuck pass, local writes silently stopped federating, and the only
 * "recovery" was ONE fresh attempt per process restart (the live-VM signature:
 * fail-count frozen 18min+ across restarts).
 *
 * These tests pin: (1) a hung pass times out, the loop un-wedges, and the NEXT
 * pass runs and drains; (2) the stall escalates via the episode hook; (3) the
 * watchdog is inert on healthy passes.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  drainOutboxOnce,
  startOutboxDrain,
  DRAIN_PASS_TIMEOUT_MS,
  DRAIN_BACKLOG_STALL_MS,
  DRAIN_ORPHAN_LOOKBACK_MS,
  DRAIN_ORPHAN_CHECK_INTERVAL_MS,
  OUTBOX_GC_AGE_MS,
} from './outbox-drain';
import type { BootedHarnessHandle } from './boot';

/** A row of the WI-2136 orphan-tail GROUP BY (drained_log_key ≠ live key). */
interface OrphanGroup {
  drained_log_key: string;
  rows: number;
  oldest_at: number | null;
  newest_at: number | null;
}

/** Minimal postgres.Sql fake: a template-tag returning rows for the drain SELECT,
 *  an answer for the WI-2009 leg-3 backlog-stall probe + the WI-2136 orphan-tail
 *  GROUP BY, and a countable result for everything else (GC / UPDATE), plus a
 *  listen() stub.
 *
 *  `opts.stuckProbe` answers the leg-3 probe (`SELECT 1 FROM …substrate_outbox …
 *  LIMIT 1`): true → a mapped undrained row is still waiting ([{…}]); false →
 *  nothing mappable is stuck ([]). Default true.
 *  `opts.orphanGroups` answers the WI-2136 detector query (`… GROUP BY
 *  drained_log_key`): the prior-era log keys with stranded drained rows. Default [].
 *  `opts.onUpdate` observes each drained_at UPDATE's interpolated values
 *  ([now, drained_log_key, id]) so a test can assert the log-key attribution stamp. */
function fakePg(
  nextRows: () => unknown[],
  opts: {
    stuckProbe?: () => boolean;
    orphanGroups?: () => OrphanGroup[];
    onUpdate?: (vals: unknown[]) => void;
  } = {},
) {
  const stuckProbe = opts.stuckProbe ?? (() => true);
  const orphanGroups = opts.orphanGroups ?? (() => []);
  const tag = async (strings: TemplateStringsArray, ...vals: unknown[]) => {
    const sql = strings.join(' ');
    if (/SELECT id, table_name/.test(sql)) {
      const rows = nextRows() as unknown[] & { count?: number };
      return rows;
    }
    if (/GROUP BY drained_log_key/.test(sql)) {
      return orphanGroups() as unknown[] & { count?: number };
    }
    if (/SELECT 1\s+FROM harness_shared\.substrate_outbox/.test(sql)) {
      return (stuckProbe() ? [{ '?column?': 1 }] : []) as unknown[] & { count?: number };
    }
    if (/UPDATE harness_shared\.substrate_outbox\s+SET drained_at/.test(sql)) {
      opts.onUpdate?.(vals);
    }
    const r = [] as unknown[] & { count?: number };
    r.count = 0;
    return r;
  };
  (tag as unknown as { listen: unknown }).listen = () => ({
    unlisten: async () => {},
  });
  return tag as never;
}

function fakeHandle(append: (op: unknown) => Promise<void>): BootedHarnessHandle {
  return {
    workspaceId: 'ws',
    harnessSlug: 'hx',
    ownLog: { keyHex: 'aa'.repeat(32) },
    append,
    registerCloseHook: () => {},
  } as unknown as BootedHarnessHandle;
}

const OUTBOX_ROW = {
  id: 1,
  table_name: 'harness_features_consolidated',
  op: 'put',
  key: 'F-1',
  row: { id: 'F-1' },
  ts: 1,
  op_hlc: null,
};

describe('outbox drain shutdown during an admitted pass', () => {
  it('does not append rows from a SELECT that completes after stop', async () => {
    let releaseRows!: (rows: unknown[]) => void;
    let selected!: () => void;
    const selectStarted = new Promise<void>(resolve => { selected = resolve; });
    const rows = new Promise<unknown[]>(resolve => { releaseRows = resolve; });
    const tag = async (strings: TemplateStringsArray) => {
      if (/SELECT id, table_name/.test(strings.join(' '))) {
        selected();
        return rows;
      }
      return Object.assign([], { count: 0 });
    };
    tag.listen = () => ({ unlisten: async () => {} });
    const append = vi.fn(async () => {});
    const drain = startOutboxDrain(fakeHandle(append), tag as never, {
      pollMs: 0, _passTimeoutMs: 0, _backlogStallMs: 0,
    });
    await selectStarted;
    await drain.stop();
    releaseRows([OUTBOX_ROW]);
    // Let the admitted pass consume the SELECT result; no clock-based delay.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(append).not.toHaveBeenCalled();
  });

  it('records an append already in progress at shutdown and leaves the next row pending', async () => {
    const controller = new AbortController();
    let finishAppend!: () => void;
    let enteredAppend!: () => void;
    const appendStarted = new Promise<void>(resolve => { enteredAppend = resolve; });
    const appendDone = new Promise<void>(resolve => { finishAppend = resolve; });
    const updates: unknown[][] = [];
    const append = vi.fn(async () => { enteredAppend(); await appendDone; });
    const pg = fakePg(() => [OUTBOX_ROW, { ...OUTBOX_ROW, id: 2, key: 'F-2' }], {
      onUpdate: vals => { updates.push(vals); },
    });
    const pass = drainOutboxOnce(fakeHandle(append), pg, { signal: controller.signal });
    await appendStarted;
    controller.abort();
    finishAppend();
    expect(await pass).toBe(1);
    expect(append).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.[2]).toBe(1);
  });
});

describe('outbox-drain pass watchdog (WI-2009)', () => {
  it('a hung append times out, escalates, and the loop UN-WEDGES (next pass drains)', async () => {
    vi.useFakeTimers();
    // The drain catch path console.error's on the failed pass (by design — the loud
    // failure log); expected + ASSERTED below, so vitest-fail-on-console stays green.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let calls = 0;
      let resolveHung: (() => void) | undefined;
      const append = vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          // First pass: hang forever (the WI-2018 keychain-unwrap shape).
          await new Promise<void>((res) => {
            resolveHung = res;
          });
        }
        // Later passes: succeed instantly.
      });
      const episodes: string[] = [];
      // One undrained row on every SELECT (the UPDATE fake never clears it —
      // fine: we only assert attempt/latch behavior, not drained bookkeeping).
      const pg = fakePg(() => {
        const rows = [{ ...OUTBOX_ROW }] as unknown[] & { count?: number };
        rows.count = 1;
        return rows;
      });
      const drain = startOutboxDrain(fakeHandle(append), pg, {
        pollMs: 1000,
        _passTimeoutMs: 5000,
        _onStallEpisode: (d) => episodes.push(d),
      });

      // Initial pass starts immediately and hangs.
      await vi.advanceTimersByTimeAsync(10);
      expect(append).toHaveBeenCalledTimes(1);

      // Polls at 1s/2s/3s/4s coalesce into the stuck pass — no new attempts.
      await vi.advanceTimersByTimeAsync(4000);
      expect(append).toHaveBeenCalledTimes(1);
      expect(episodes).toHaveLength(0);

      // Watchdog expires at 5s → escalation + loop un-wedged; the next poll
      // tick runs a FRESH pass that attempts the row again.
      await vi.advanceTimersByTimeAsync(1100);
      expect(episodes).toHaveLength(1);
      expect(episodes[0]).toContain('WI-2009');
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('[outbox-drain] drain failed'),
        expect.anything(),
      );
      await vi.advanceTimersByTimeAsync(1100);
      expect(append.mock.calls.length).toBeGreaterThanOrEqual(2);

      // The zombie pass settling later must not explode (unhandled rejection).
      resolveHung?.();
      await vi.advanceTimersByTimeAsync(10);

      await drain.stop();
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('healthy passes never trip the watchdog', async () => {
    vi.useFakeTimers();
    try {
      const append = vi.fn(async () => {});
      const episodes: string[] = [];
      let served = false;
      const pg = fakePg(() => {
        // One row on the first pass, then empty (drained).
        if (served) {
          const r = [] as unknown[] & { count?: number };
          r.count = 0;
          return r;
        }
        served = true;
        const rows = [{ ...OUTBOX_ROW }] as unknown[] & { count?: number };
        rows.count = 1;
        return rows;
      });
      const drain = startOutboxDrain(fakeHandle(append), pg, {
        pollMs: 1000,
        _passTimeoutMs: 5000,
        _onStallEpisode: (d) => episodes.push(d),
      });
      await vi.advanceTimersByTimeAsync(12_000);
      expect(append).toHaveBeenCalledTimes(1);
      expect(episodes).toHaveLength(0);
      await drain.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('production default timeout is bounded (2min — well under the ~12min host recycle)', () => {
    expect(DRAIN_PASS_TIMEOUT_MS).toBe(120_000);
  });
});

/**
 * WI-2009 leg 3 — the backlog-stall detector the hung-pass watchdog does NOT
 * cover. The filed live signature is NOT a hung pass: each pass SETTLES (fails
 * fast on a persistent EpochKeyUnavailableError / append fault, or drains
 * nothing), so the `DRAIN_PASS_TIMEOUT_MS` watchdog never fires — yet mapped
 * undrained rows sit frozen and nobody pages. This detector escalates a durable
 * `drain_backlog_stalled` EI when the drain makes ZERO forward progress for the
 * whole window while a mapped undrained row still waits. Progress-based: any
 * drained row resets the clock (a legitimate large catch-up never false-fires),
 * and it reaches the check on BOTH the settle and the fast-fail throw path.
 */
describe('outbox-drain backlog-stall detector (WI-2009 leg 3)', () => {
  const emptyRows = () => {
    const r = [] as unknown[] & { count?: number };
    r.count = 0;
    return r;
  };
  const oneRow = () => {
    const r = [{ ...OUTBOX_ROW }] as unknown[] & { count?: number };
    r.count = 1;
    return r;
  };

  it('passes SETTLE draining zero rows + a mapped row still waiting → exactly ONE drain_backlog_stalled (latch holds)', async () => {
    vi.useFakeTimers();
    try {
      const append = vi.fn(async () => {}); // never called — the drain SELECT is empty
      const episodes: Array<{ detail: string; kind?: string }> = [];
      const pg = fakePg(() => emptyRows(), { stuckProbe: () => true });
      const drain = startOutboxDrain(fakeHandle(append), pg, {
        pollMs: 1000,
        _passTimeoutMs: 0, // isolate the backlog detector from the hung-pass watchdog
        _backlogStallMs: 5000,
        _onStallEpisode: (detail, kind) => episodes.push({ detail, kind }),
      });

      // Under the no-progress window: nothing escalates yet.
      await vi.advanceTimersByTimeAsync(4000);
      expect(episodes).toHaveLength(0);

      // Cross the 5s window → exactly one backlog-stall episode (NOT a hung-pass one).
      await vi.advanceTimersByTimeAsync(4000);
      const backlog = episodes.filter((e) => e.kind === 'drain_backlog_stalled');
      expect(backlog).toHaveLength(1);
      expect(backlog[0].detail).toContain('WI-2009');
      expect(backlog[0].detail).toContain('ZERO forward progress');
      expect(episodes.some((e) => e.kind === 'drain_stalled')).toBe(false);

      // Latch: further no-progress passes do NOT re-file.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(episodes.filter((e) => e.kind === 'drain_backlog_stalled')).toHaveLength(1);
      expect(append).not.toHaveBeenCalled();

      await drain.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the FAST-FAIL throw path (persistent append fault) also reaches the detector and escalates', async () => {
    vi.useFakeTimers();
    // Each failing pass logs the loud drain-failed line (by design); expected +
    // ASSERTED below so vitest-fail-on-console stays green.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const append = vi.fn(async () => {
        throw new Error('persistent append fault');
      });
      const episodes: Array<{ detail: string; kind?: string }> = [];
      const pg = fakePg(() => oneRow(), { stuckProbe: () => true });
      const drain = startOutboxDrain(fakeHandle(append), pg, {
        pollMs: 1000,
        _passTimeoutMs: 0,
        _backlogStallMs: 5000,
        _onStallEpisode: (detail, kind) => episodes.push({ detail, kind }),
      });

      await vi.advanceTimersByTimeAsync(8000);
      const backlog = episodes.filter((e) => e.kind === 'drain_backlog_stalled');
      expect(backlog).toHaveLength(1);
      // A plain append fault is NOT a DrainPassTimeoutError, so the hung-pass
      // detector must stay silent — only the backlog detector fires.
      expect(episodes.some((e) => e.kind === 'drain_stalled')).toBe(false);
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('[outbox-drain] drain failed'),
        expect.anything(),
      );

      await drain.stop();
    } finally {
      errSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('a pass that DRAINS a row resets the no-progress clock → never escalates', async () => {
    vi.useFakeTimers();
    try {
      const append = vi.fn(async () => {}); // succeeds → the served row drains every pass
      const episodes: Array<{ detail: string; kind?: string }> = [];
      const pg = fakePg(() => oneRow(), { stuckProbe: () => true });
      const drain = startOutboxDrain(fakeHandle(append), pg, {
        pollMs: 1000,
        _passTimeoutMs: 0,
        _backlogStallMs: 5000,
        _onStallEpisode: (detail, kind) => episodes.push({ detail, kind }),
      });

      // Well past the window: every pass makes forward progress, so lastProgressAt
      // keeps resetting and the detector never even runs.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(episodes).toHaveLength(0);
      expect(append.mock.calls.length).toBeGreaterThan(1);

      await drain.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('zero forward progress but NO mapped row waiting (probe empty) → no escalation', async () => {
    vi.useFakeTimers();
    try {
      const append = vi.fn(async () => {});
      const episodes: Array<{ detail: string; kind?: string }> = [];
      // The drain drains nothing AND the probe finds no mapped row — e.g. the only
      // undrained rows are forward-compat unmapped tables (excluded on purpose).
      const pg = fakePg(() => emptyRows(), { stuckProbe: () => false });
      const drain = startOutboxDrain(fakeHandle(append), pg, {
        pollMs: 1000,
        _passTimeoutMs: 0,
        _backlogStallMs: 5000,
        _onStallEpisode: (detail, kind) => episodes.push({ detail, kind }),
      });

      await vi.advanceTimersByTimeAsync(15_000);
      expect(episodes).toHaveLength(0);

      await drain.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('production default backlog-stall window is 10min (bounded, above transient key-arrival delay)', () => {
    expect(DRAIN_BACKLOG_STALL_MS).toBe(10 * 60 * 1000);
  });
});

/**
 * WI-2136 — the orphan-tail recurrence guard. The tower bg-host own-log keypair
 * does NOT persist across restarts (WI-2105: e06b8704 era → 4072cfad era), so a
 * restart orphans the prior log's unreplicated tail — rows sit drained_at-stamped
 * but their blocks can never replicate (no live process holds the dead log). The
 * drain now stamps `drained_log_key` per row (mig 495); this detector compares the
 * distinct recently-drained keys against the live key and pages a durable
 * `drain_orphan_tail` EI for any dead-era tail, ONCE per dead key. It runs at boot
 * (the moment the stranded tail is detectable) and throttled thereafter.
 */
describe('outbox-drain orphan-tail recurrence guard (WI-2136)', () => {
  const emptyCounted = () => {
    const r = [] as unknown[] & { count?: number };
    r.count = 0;
    return r;
  };
  const LIVE_KEY = 'aa'.repeat(32); // matches fakeHandle().ownLog.keyHex

  it('stamps drained_log_key = the live own-log key on each drained row (attribution)', async () => {
    vi.useFakeTimers();
    try {
      const append = vi.fn(async () => {});
      const updates: unknown[][] = [];
      let served = false;
      const pg = fakePg(
        () => {
          if (served) return emptyCounted();
          served = true;
          const rows = [{ ...OUTBOX_ROW }] as unknown[] & { count?: number };
          rows.count = 1;
          return rows;
        },
        { onUpdate: (vals) => updates.push(vals) },
      );
      const drain = startOutboxDrain(fakeHandle(append), pg, {
        pollMs: 1000,
        _passTimeoutMs: 0,
        _backlogStallMs: 0,
        _orphanCheckIntervalMs: -1, // isolate the attribution stamp from detection
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(append).toHaveBeenCalledTimes(1);
      expect(updates).toHaveLength(1);
      // UPDATE … SET drained_at = ${now}, drained_log_key = ${keyHex} WHERE id = ${id}
      expect(updates[0]![1]).toBe(LIVE_KEY);
      await drain.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a prior-era drained_log_key at boot → exactly ONE drain_orphan_tail per dead key (latched)', async () => {
    vi.useFakeTimers();
    try {
      const append = vi.fn(async () => {});
      const episodes: Array<{ detail: string; kind?: string }> = [];
      const deadKey = 'bb'.repeat(32);
      const pg = fakePg(() => emptyCounted(), {
        orphanGroups: () => [{ drained_log_key: deadKey, rows: 3, oldest_at: 1000, newest_at: 2000 }],
      });
      const drain = startOutboxDrain(fakeHandle(append), pg, {
        pollMs: 1000,
        _passTimeoutMs: 0,
        _backlogStallMs: 0,
        _orphanCheckIntervalMs: 1000, // let a re-check run to prove the latch holds
        _onStallEpisode: (detail, kind) => episodes.push({ detail, kind }),
      });

      await vi.advanceTimersByTimeAsync(50);
      const orphan = () => episodes.filter((e) => e.kind === 'drain_orphan_tail');
      expect(orphan()).toHaveLength(1);
      expect(orphan()[0]!.detail).toContain('orphan-tail');
      expect(orphan()[0]!.detail).toContain(deadKey.slice(0, 12));
      // The live-key drain-stall kinds never fire here (nothing is stuck/hung).
      expect(episodes.some((e) => e.kind !== 'drain_orphan_tail')).toBe(false);

      // Re-checks past the throttle keep returning the same dead key → latch holds.
      await vi.advanceTimersByTimeAsync(5000);
      expect(orphan()).toHaveLength(1);

      await drain.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('two distinct prior-era keys → one drain_orphan_tail EACH', async () => {
    vi.useFakeTimers();
    try {
      const append = vi.fn(async () => {});
      const episodes: Array<{ detail: string; kind?: string }> = [];
      const k1 = 'bb'.repeat(32);
      const k2 = 'cc'.repeat(32);
      const pg = fakePg(() => emptyCounted(), {
        orphanGroups: () => [
          { drained_log_key: k1, rows: 2, oldest_at: 10, newest_at: 20 },
          { drained_log_key: k2, rows: 5, oldest_at: 30, newest_at: 40 },
        ],
      });
      const drain = startOutboxDrain(fakeHandle(append), pg, {
        pollMs: 1000,
        _passTimeoutMs: 0,
        _backlogStallMs: 0,
        _orphanCheckIntervalMs: 60_000,
        _onStallEpisode: (detail, kind) => episodes.push({ detail, kind }),
      });

      await vi.advanceTimersByTimeAsync(50);
      const orphan = episodes.filter((e) => e.kind === 'drain_orphan_tail');
      expect(orphan).toHaveLength(2);
      expect(orphan.some((e) => e.detail.includes(k1.slice(0, 12)))).toBe(true);
      expect(orphan.some((e) => e.detail.includes(k2.slice(0, 12)))).toBe(true);

      await drain.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('no prior-era keys (all drained onto the live log) → no orphan escalation', async () => {
    vi.useFakeTimers();
    try {
      const append = vi.fn(async () => {});
      const episodes: Array<{ detail: string; kind?: string }> = [];
      const pg = fakePg(() => emptyCounted(), { orphanGroups: () => [] });
      const drain = startOutboxDrain(fakeHandle(append), pg, {
        pollMs: 1000,
        _passTimeoutMs: 0,
        _backlogStallMs: 0,
        _orphanCheckIntervalMs: 1000,
        _onStallEpisode: (detail, kind) => episodes.push({ detail, kind }),
      });

      await vi.advanceTimersByTimeAsync(5000);
      expect(episodes.filter((e) => e.kind === 'drain_orphan_tail')).toHaveLength(0);

      await drain.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a negative check interval disables the orphan detector entirely', async () => {
    vi.useFakeTimers();
    try {
      const append = vi.fn(async () => {});
      const episodes: Array<{ detail: string; kind?: string }> = [];
      const pg = fakePg(() => emptyCounted(), {
        orphanGroups: () => [{ drained_log_key: 'bb'.repeat(32), rows: 1, oldest_at: 1, newest_at: 2 }],
      });
      const drain = startOutboxDrain(fakeHandle(append), pg, {
        pollMs: 1000,
        _passTimeoutMs: 0,
        _backlogStallMs: 0,
        _orphanCheckIntervalMs: -1,
        _onStallEpisode: (detail, kind) => episodes.push({ detail, kind }),
      });

      await vi.advanceTimersByTimeAsync(10_000);
      expect(episodes.filter((e) => e.kind === 'drain_orphan_tail')).toHaveLength(0);

      await drain.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('production defaults: orphan lookback = the 24h GC horizon; check throttle = 10min', () => {
    expect(DRAIN_ORPHAN_LOOKBACK_MS).toBe(OUTBOX_GC_AGE_MS);
    expect(DRAIN_ORPHAN_CHECK_INTERVAL_MS).toBe(10 * 60 * 1000);
  });
});
