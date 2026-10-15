import { describe, it, expect, vi } from 'vitest';
import {
  evaluateDeadManGuard,
  checkLoopDeadMan,
  stampLoopArmedAt,
  hasAutonomyPosture,
  type LoopDeadManDeps,
} from './loop-dead-man';
import type { ModeRow } from '../../modes/store';

// These IO-gate cases isolate the shared rail; its durable bridge has integration coverage.
vi.mock('../../severe-event-broadcast', () => ({ broadcastSevereEvent: vi.fn(async () => true) }));
vi.mock('../../alarm-attention', () => ({ resolveAlarm: vi.fn(async () => true) }));

describe('evaluateDeadManGuard (P2a — pure dead-man decision)', () => {
  const base = { armedAtMs: 1_000_000, nowMs: 1_000_000, fireCount: 0 };

  it('no bound configured → never breaches', () => {
    expect(evaluateDeadManGuard({ ...base, nowMs: base.armedAtMs + 1e12, fireCount: 1e9 }).breach).toBe(false);
  });
  it('max-duration breach when wall-clock since arm exceeds the bound', () => {
    const v = evaluateDeadManGuard({ ...base, nowMs: base.armedAtMs + 3_600_001, maxDurationSec: 3600 });
    expect(v.breach).toBe(true);
    expect(v.reason).toContain('max-duration');
  });
  it('no max-duration breach while within the bound', () => {
    expect(evaluateDeadManGuard({ ...base, nowMs: base.armedAtMs + 60_000, maxDurationSec: 3600 }).breach).toBe(false);
  });
  it('max-fires breach when prior fires reach the bound (the (N+1)-th is withheld)', () => {
    expect(evaluateDeadManGuard({ ...base, fireCount: 10, maxFires: 10 }).breach).toBe(true);
    expect(evaluateDeadManGuard({ ...base, fireCount: 9, maxFires: 10 }).breach).toBe(false);
  });
  it('duration takes precedence over fires in the reason', () => {
    const v = evaluateDeadManGuard({ ...base, nowMs: base.armedAtMs + 9e9, fireCount: 999, maxFires: 10, maxDurationSec: 60 });
    expect(v.reason).toContain('max-duration');
  });
  it('a non-positive bound is treated as no bound', () => {
    expect(evaluateDeadManGuard({ ...base, nowMs: base.armedAtMs + 1e9, maxDurationSec: 0, maxFires: -5 }).breach).toBe(false);
  });
});

function fakeSql(row: { armed_ms: number; fire_count: number }) {
  return ((strings: TemplateStringsArray) => {
    if (/SELECT/i.test(strings.join('?'))) return Promise.resolve([row]);
    return Promise.resolve([]);
  }) as never;
}

describe('checkLoopDeadMan (P2a — IO gate)', () => {
  it('no bound → zero reads, no breach, no auto-pause', async () => {
    const autoPause = vi.fn(async () => {});
    // sql intentionally throws if touched — proves the no-bound path never reads.
    const sql = (() => {
      throw new Error('should not query');
    }) as never;
    const res = await checkLoopDeadMan({ sql, routineId: 'r', maxFires: null, maxDurationSec: null }, { autoPause });
    expect(res.breach).toBe(false);
    expect(autoPause).not.toHaveBeenCalled();
  });

  it('auto-pauses on a duration breach', async () => {
    const autoPause = vi.fn(async () => {});
    const now = 5_000_000;
    const sql = fakeSql({ armed_ms: now - 7_200_000, fire_count: 3 }); // armed 2h ago
    const res = await checkLoopDeadMan({ sql, routineId: 'r', maxDurationSec: 3600, nowMs: now }, { autoPause });
    expect(res.breach).toBe(true);
    expect(autoPause).toHaveBeenCalledTimes(1);
    expect(autoPause).toHaveBeenCalledWith(expect.anything(), 'r', expect.stringContaining('dead-man'));
  });

  it('auto-pauses on a fire-count breach', async () => {
    const autoPause = vi.fn(async () => {});
    const now = 5_000_000;
    const sql = fakeSql({ armed_ms: now - 1000, fire_count: 50 });
    const res = await checkLoopDeadMan({ sql, routineId: 'r', maxFires: 50, nowMs: now }, { autoPause });
    expect(res.breach).toBe(true);
    expect(autoPause).toHaveBeenCalledTimes(1);
  });

  it('does NOT pause while under both bounds', async () => {
    const autoPause = vi.fn(async () => {});
    const now = 5_000_000;
    const sql = fakeSql({ armed_ms: now - 1000, fire_count: 2 });
    const res = await checkLoopDeadMan({ sql, routineId: 'r', maxFires: 50, maxDurationSec: 3600, nowMs: now }, { autoPause });
    expect(res.breach).toBe(false);
    expect(autoPause).not.toHaveBeenCalled();
  });
});

describe('stampLoopArmedAt (EI-7613 — refresh the dead-man arm instant on every materialize)', () => {
  it('issues an UPDATE merging metadata.armed_at as an ISO timestamp string', async () => {
    const calls: { text: string; values: unknown[] }[] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ text: strings.join('?'), values });
      return Promise.resolve([]);
    }) as never;

    await stampLoopArmedAt(sql, 'rt_x', 1_700_000_000_000);

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(/UPDATE harness_shared\.routines/);
    expect(calls[0].text).toContain('armed_at');
    expect(calls[0].values).toContain('rt_x');
    expect(calls[0].values).toContain(new Date(1_700_000_000_000).toISOString());
  });

  it('defaults to Date.now() when no explicit instant is given', async () => {
    const before = Date.now();
    let stampedIso = '';
    const sql = ((_strings: TemplateStringsArray, ...values: unknown[]) => {
      stampedIso = values.find((v) => typeof v === 'string' && v.includes('T')) as string;
      return Promise.resolve([]);
    }) as never;

    await stampLoopArmedAt(sql, 'rt_x');

    expect(Date.parse(stampedIso)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(stampedIso)).toBeLessThanOrEqual(Date.now());
  });
});

describe('EI-7613 regression — a re-arm resets the dead-man clock (armed_at wins over created_at)', () => {
  /** A tiny fake store wiring stampLoopArmedAt's UPDATE to checkLoopDeadMan's SELECT,
   *  modeling the real `COALESCE((metadata->>'armed_at')::timestamptz, created_at)` — proves
   *  the two functions' CONTRACT (the metadata key each writes/reads) stays in sync, not just
   *  each function in isolation. */
  function fakeRoutineStore(createdAtMs: number, fireCount = 0) {
    let armedAtIso: string | null = null;
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      if (/UPDATE harness_shared\.routines/.test(text)) {
        armedAtIso = values.find((v) => typeof v === 'string' && v.includes('T')) as string;
        return Promise.resolve([]);
      }
      const armedMs = armedAtIso ? Date.parse(armedAtIso) : createdAtMs;
      return Promise.resolve([{ armed_ms: armedMs, fire_count: fireCount }]);
    }) as never;
    return sql;
  }

  it('a loop armed long ago, then RE-ARMED just now, does NOT instantly breach a fresh maxDurationSec', async () => {
    const createdAtMs = 0; // "day 1" — the row's original arm, long, long ago
    const reArmMs = 100_000_000_000; // "day 2" — re-armed now
    const checkMs = reArmMs + 5_000; // a few seconds after the re-arm, the loop's first fire
    const sql = fakeRoutineStore(createdAtMs);

    // What materializeLoop now does on every arm (fresh or re-arm):
    await stampLoopArmedAt(sql, 'rt_x', reArmMs);

    const autoPause = vi.fn(async () => {});
    const res = await checkLoopDeadMan(
      { sql, routineId: 'rt_x', maxDurationSec: 43_200 /* 12h */, nowMs: checkMs },
      { autoPause },
    );

    // Before the fix this breached instantly (measuring from createdAtMs, ~100M s in the past).
    expect(res.breach).toBe(false);
    expect(autoPause).not.toHaveBeenCalled();
  });

  it('WITHOUT a stamp (pre-fix loop, never re-armed since this code shipped) still falls back to created_at', async () => {
    const createdAtMs = 5_000_000 - 7_200_000; // armed 2h ago, never stamped
    const sql = fakeRoutineStore(createdAtMs);

    const autoPause = vi.fn(async () => {});
    const res = await checkLoopDeadMan(
      { sql, routineId: 'rt_x', maxDurationSec: 3600 /* 1h */, nowMs: 5_000_000 },
      { autoPause },
    );

    // Legacy behavior preserved: no stamp ever written -> falls back to created_at -> breaches.
    expect(res.breach).toBe(true);
    expect(autoPause).toHaveBeenCalledTimes(1);
  });
});

describe('EI-19339729634604096 regression — maxFires is counted SINCE THE MOST RECENT ARM, not lifetime', () => {
  /** Same shape as fakeRoutineStore above, but also tracks fire_count (bumped externally,
   *  the way incrementLoopFireCount would) and fire_count_at_arm (only stampLoopArmedAt writes
   *  it). Models the real single-statement `metadata->>'fire_count'` snapshot exactly. */
  function fakeRoutineStoreWithFires(initialFireCount: number) {
    let fireCount = initialFireCount;
    let fireCountAtArm = 0;
    let armedAtIso: string | null = null;
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      if (/UPDATE harness_shared\.routines/.test(text)) {
        // The real UPDATE snapshots fire_count_at_arm = fire_count-as-of-now, in the same
        // statement that writes armed_at — model that read-then-write here.
        armedAtIso = values.find((v) => typeof v === 'string' && v.includes('T')) as string;
        fireCountAtArm = fireCount;
        return Promise.resolve([]);
      }
      return Promise.resolve([{ armed_ms: armedAtIso ? Date.parse(armedAtIso) : Date.now(), fire_count: fireCount, fire_count_at_arm: fireCountAtArm }]);
    }) as never;
    return {
      sql,
      bumpFireCount: (n = 1) => {
        fireCount += n;
      },
    };
  }

  it('a session that already fired 7 times, then re-armed with maxFires:4, gets 4 MORE fires before breaching', async () => {
    const { sql, bumpFireCount } = fakeRoutineStoreWithFires(7); // the exact repro numbers from the filed bug
    await stampLoopArmedAt(sql, 'rt_x', 1_000_000); // re-arm: snapshots fire_count_at_arm = 7

    const autoPause = vi.fn(async () => {});
    // First post-re-arm fire (fires-since-arm = 1) must NOT breach — this is the bug: before
    // the fix, checkLoopDeadMan compared the LIFETIME 7 >= 4 and paused instantly.
    bumpFireCount(1);
    let res = await checkLoopDeadMan({ sql, routineId: 'rt_x', maxFires: 4, nowMs: 1_100_000 }, { autoPause });
    expect(res.breach).toBe(false);
    expect(autoPause).not.toHaveBeenCalled();

    // Fires 2 and 3 since arm: still under the bound.
    bumpFireCount(1);
    res = await checkLoopDeadMan({ sql, routineId: 'rt_x', maxFires: 4, nowMs: 1_200_000 }, { autoPause });
    expect(res.breach).toBe(false);
    bumpFireCount(1);
    res = await checkLoopDeadMan({ sql, routineId: 'rt_x', maxFires: 4, nowMs: 1_300_000 }, { autoPause });
    expect(res.breach).toBe(false);

    // The 4th fire since arm reaches the bound exactly — breaches now, not before.
    bumpFireCount(1);
    res = await checkLoopDeadMan({ sql, routineId: 'rt_x', maxFires: 4, nowMs: 1_400_000 }, { autoPause });
    expect(res.breach).toBe(true);
    expect(res.reason).toContain('max-fires');
    expect(autoPause).toHaveBeenCalledTimes(1);
  });

  it('a loop armed before this fix (no fire_count_at_arm stamp) falls back to baseline 0 — never over-counts into a spurious breach', async () => {
    // No stampLoopArmedAt call at all: fire_count_at_arm stays unset (COALESCE -> 0 in the
    // real SQL). A brand-new loop with maxFires:4 and 2 real fires must not breach.
    let fireCount = 2;
    const sql = ((strings: TemplateStringsArray) => {
      const text = strings.join('?');
      if (/UPDATE/.test(text)) return Promise.resolve([]);
      return Promise.resolve([{ armed_ms: Date.now(), fire_count: fireCount, fire_count_at_arm: undefined }]);
    }) as never;
    void fireCount;

    const autoPause = vi.fn(async () => {});
    const res = await checkLoopDeadMan({ sql, routineId: 'rt_x', maxFires: 4, nowMs: Date.now() }, { autoPause });
    expect(res.breach).toBe(false);
    expect(autoPause).not.toHaveBeenCalled();
  });
});

// ── EI-19899671638499010: stopping an AUTONOMOUS loop must page the owner ──────────
//
// The measured failure (su-1f7ee244, 2026-08-08): a session registered in auto mode, bound to
// an owner-directed plan, hit `dead-man max-fires 12 >= 12` and then took ZERO turns for four
// days. Nothing was broken — the pause was correct. What was missing is that a pause of an
// autonomous session is PERMANENT from that session's side: a paused loop does not fire, and
// the detector built for this state (coord:orient's wakeSourceLostWarning) is only ever
// delivered ON a wake. So the state flip has to be loud at the instant it happens.

// Bind the mocks to the REAL dep signatures — the sibling convention. A bare `vi.fn(async () =>
// [])` records a zero-arg call tuple, so reading `notify.mock.calls[0][0].kind` below is a type
// error that vitest cannot see and only `lint:tsc` catches, i.e. at the fleet gate.
type GetModesFn = NonNullable<LoopDeadManDeps['getModes']>;
type NotifyFn = NonNullable<LoopDeadManDeps['notify']>;

/** A complete `agent_modes` row — only `mode` drives the verdict, the rest is shape. */
const modeRow = (mode: string): ModeRow => ({
  workspaceId: 'ws',
  ownerId: 'su-halted',
  axisKey: 'autonomy',
  mode,
  reason: 'test',
  setBy: 'owner',
  ownerDirected: true,
  setAt: '2026-08-08T00:00:00.000Z',
  // Mode-defined parameter (migration 767); null for the autonomy axis, which
  // has nothing to be "about". Present because ModeRow requires it — a partial
  // row here would compile only until the next field is added.
  subject: null,
  // Directly registered modes have no implication parent (migration 1075).
  impliedBy: null,
});

/** A routines row that carries the owner/workspace the page needs. */
function fakeSqlWithOwner(over: { target_owner_id?: string | null; workspace_id?: string | null } = {}) {
  return ((strings: TemplateStringsArray) => {
    if (/UPDATE/i.test(strings.join('?'))) return Promise.resolve([]);
    return Promise.resolve([
      {
        armed_ms: 1_000_000,
        fire_count: 12,
        fire_count_at_arm: 0,
        target_owner_id: 'su-halted',
        workspace_id: 'ws',
        ...over,
      },
    ]);
  }) as never;
}

const breaching = { routineId: 'rt_auto', maxFires: 12, nowMs: 1_000_000 };

describe('hasAutonomyPosture (pure) — anchored to the registry axis, not to id spellings', () => {
  it('an autonomy-axis mode counts', () => {
    expect(hasAutonomyPosture([modeRow('auto')])).toBe(true);
    expect(hasAutonomyPosture([modeRow('cold-auto')])).toBe(true);
  });
  it('an overlay-only posture does NOT count', () => {
    expect(hasAutonomyPosture([modeRow('grade')])).toBe(false);
    expect(hasAutonomyPosture([])).toBe(false);
  });
  it('an UNKNOWN mode id counts as autonomous (fails toward paging)', () => {
    // The cost asymmetry: a spurious page costs one notification, a missed one cost 4 days.
    // An unrecognized posture is not evidence of "not autonomous", so it must not buy silence.
    expect(hasAutonomyPosture([modeRow('some-future-mode')])).toBe(true);
  });
  it('mixed: one autonomy row among overlays is enough', () => {
    expect(hasAutonomyPosture([modeRow('grade'), modeRow('auto')])).toBe(true);
  });
});

describe('checkLoopDeadMan — owner page on an autonomous halt (EI-19899671638499010)', () => {
  it('THE GUARD: a breach on an AUTO session pauses AND pages the owner', async () => {
    const autoPause = vi.fn(async () => {});
    const getModes = vi.fn<GetModesFn>(async () => [modeRow('auto')]);
    const notify = vi.fn<NotifyFn>(async () => {});

    const res = await checkLoopDeadMan(
      { sql: fakeSqlWithOwner(), ...breaching },
      { autoPause, getModes, notify },
    );

    expect(res.breach).toBe(true);
    expect(res.escalated).toBe(true);
    // the pause still happens — the page is an ADDITION, never a replacement
    expect(autoPause).toHaveBeenCalledTimes(1);

    expect(notify).toHaveBeenCalledTimes(1);
    const page = notify.mock.calls[0][0];
    expect(page.kind).toBe('intervention');
    expect(page.importance).toBe('urgent');
    expect(page.title).toContain('su-halted');
    expect(page.workspaceId).toBe('ws');
    expect(page.body).toContain('max-fires');
  });

  it('a breach on a NON-autonomous session pauses SILENTLY', async () => {
    // Byte-identical to the case above but for the registered mode: an interactive session has
    // a human in front of it who sees the next turn, so a page would be noise. This pair is what
    // makes the gate falsifiable — paging unconditionally fails here, never paging fails above.
    const autoPause = vi.fn(async () => {});
    const getModes = vi.fn<GetModesFn>(async () => [modeRow('grade')]);
    const notify = vi.fn<NotifyFn>(async () => {});

    const res = await checkLoopDeadMan(
      { sql: fakeSqlWithOwner(), ...breaching },
      { autoPause, getModes, notify },
    );

    expect(res.breach).toBe(true);
    expect(res.escalated).toBe(false);
    expect(autoPause).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('a session with NO registered mode pauses silently', async () => {
    const autoPause = vi.fn(async () => {});
    const getModes = vi.fn<GetModesFn>(async () => []);
    const notify = vi.fn<NotifyFn>(async () => {});

    const res = await checkLoopDeadMan({ sql: fakeSqlWithOwner(), ...breaching }, { autoPause, getModes, notify });

    expect(res.escalated).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  it('NO breach → no pause, no page, and the modes read never happens', async () => {
    const autoPause = vi.fn(async () => {});
    const getModes = vi.fn<GetModesFn>(async () => [modeRow('auto')]);
    const notify = vi.fn<NotifyFn>(async () => {});

    const res = await checkLoopDeadMan(
      { sql: fakeSqlWithOwner(), routineId: 'rt_auto', maxFires: 99, nowMs: 1_000_000 },
      { autoPause, getModes, notify },
    );

    expect(res.breach).toBe(false);
    expect(autoPause).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    // the gate must stay cheap on the fire path — no extra read on the healthy path
    expect(getModes).not.toHaveBeenCalled();
  });

  it('a FAILING page never costs the pause, and never throws out of the fire path', async () => {
    const autoPause = vi.fn(async () => {});
    const getModes = vi.fn<GetModesFn>(async () => [modeRow('auto')]);
    const notify = vi.fn<NotifyFn>(async () => {
      throw new Error('push transport down');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await checkLoopDeadMan({ sql: fakeSqlWithOwner(), ...breaching }, { autoPause, getModes, notify });

    expect(res.breach).toBe(true);
    expect(res.escalated).toBe(false);
    expect(autoPause).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('owner page failed'))).toBe(true);
    warn.mockRestore();
  });

  it('a routine row with no owner pauses silently instead of throwing', async () => {
    const autoPause = vi.fn(async () => {});
    const getModes = vi.fn<GetModesFn>(async () => [modeRow('auto')]);
    const notify = vi.fn<NotifyFn>(async () => {});

    const res = await checkLoopDeadMan(
      { sql: fakeSqlWithOwner({ target_owner_id: null }), ...breaching },
      { autoPause, getModes, notify },
    );

    expect(res.breach).toBe(true);
    expect(res.escalated).toBe(false);
    expect(autoPause).toHaveBeenCalledTimes(1);
    expect(getModes).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
