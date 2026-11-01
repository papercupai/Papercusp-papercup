/**
 * EI-7472 regression: `trackGateStall` writes the whole `gate_health` jsonb key
 * through an atomic path merge. The `watchdogAlerted` field is owned by the
 * separate green-stall-watchdog sweep, NOT this writer — so `next` must carry it
 * through or every red tick silently drops it, and the watchdog re-fires its
 * one-shot STALLED severe-event ~hourly for the life of a red streak (fleet-wide
 * alarm spam). These tests capture the actual UPDATE params and assert the flag
 * survives a red tick and clears on a green/reset tick.
 *
 * Mirrors the capture-the-`sql.unsafe`-params mock pattern (a partial mock of
 * `@papercusp/db-org` that overrides only the lazy `getOrgPg`, preserving every
 * other export so the release-actions import graph still resolves).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildGateSuiteMeasurement } from '../../release/test-pass-reuse-report';

// EI-19329732364513693: trackGateStall now measures candidate staleness via git whenever a
// candidate is passed. Keep this file HERMETIC — without this mock, every existing test that
// passes a candidate would spawn REAL `git` against integrationRoot(): slow, environment-
// dependent, and pointed at a path that need not exist in CI. The measurement is fail-safe, so
// a non-zero exit simply yields nulls; the tests that care about the VALUES inject their own
// runner rather than relying on this mock.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: () => ({
      stdout: { on: () => {} },
      on: (evt: string, cb: (code?: number) => void) => {
        if (evt === 'close') cb(1);
      },
    }),
  };
});

type UnsafeCall = { query: string; params: unknown[] };
const calls: UnsafeCall[] = [];
let seededGh: Record<string, unknown> | null = null;
let seededRepairQueue: Record<string, unknown> | null = null;
let seededGateHealthByWorkspace: Map<string, Record<string, unknown>> | null = null;
let updatedGateHealthByWorkspace: Map<string, Record<string, unknown>> | null = null;
let latestHeadlineHealth: Record<string, unknown> | null = null;
let headlineHealthOverride: Record<string, unknown> | undefined;
/**
 * WI-42118: the `green_checkpoint` pipeline_events page the CROSS-STREAK cause digest reads.
 * Default EMPTY, which the reader turns into a `null` digest — so every pre-existing test in
 * this file renders exactly the bodies it did before the digest shipped.
 */
let seededEvents: Array<{ status: string; detail: unknown; created_at: string }> = [];

/**
 * The shapes this fake returns, as ONE named union.
 *
 * Stated explicitly rather than inferred: without it TypeScript widens `unsafe` to a union of
 * three separate `Promise<…>` types, and a `vi.spyOn(...).mockImplementation(...)` returning
 * `Promise<A | B | C>` is then not assignable to `Promise<A> | Promise<B> | Promise<C>`. The
 * annotation is what lets a test override this fake per-case (see the fail-safe test below).
 */
type FakeSqlResult =
  | Array<{ gh: Record<string, unknown> | null }>
  | Array<{ headline_health: Record<string, unknown> | null }>
  | Array<{ streak: number; alerted: boolean }>
  | Array<{ status: string; detail: unknown; created_at: string }>
  | { count: number };

const fakeSql = {
  unsafe: (query: string, params: unknown[] = []): Promise<FakeSqlResult> => {
    calls.push({ query, params });
    if (query.includes('AS headline_health')) {
      return Promise.resolve([{ headline_health: headlineHealthOverride ?? latestHeadlineHealth ?? seededGh }]);
    }
    if (/SELECT\s+metadata->'gate_health'/i.test(query)) {
      const workspace = query.includes('workspace_id') ? String(params.at(-1) ?? '') : null;
      const scopedGh = workspace && seededGateHealthByWorkspace
        ? seededGateHealthByWorkspace.get(workspace) ?? null
        : seededGh;
      return Promise.resolve([{ gh: scopedGh, rq: seededRepairQueue }]);
    }
    // Escalation clear (green path) reads `.count`. A real DB would only have a
    // row to clear when the seeded gate_health actually believed an escalation
    // was open (`stallAlerted: true`) — mirror that here so the happy-path
    // recovery test (seed stallAlerted:true, expect a clean clear) doesn't spuriously
    // hit trackGateStall's "MATCHED 0 ROWS despite stallAlerted" warn path (that
    // warn is for a genuinely-diverged DB, which no test here is simulating).
    // WI-42118: the cross-streak cause digest's read. Empty by default, so a test that does
    // not seed events gets a `null` digest and unchanged bodies.
    if (/FROM\s+harness_shared\.pipeline_events/i.test(query)) {
      return Promise.resolve(seededEvents);
    }
    if (/UPDATE\s+harness_shared\.harness_escalations/i.test(query)) {
      return Promise.resolve({ count: seededGh?.stallAlerted ? 1 : 0 });
    }
    // EI-21462211894072863: the no-verdict streak bump is the one write here whose RESULT is
    // read (it RETURNINGs the post-increment streak + the one-shot flag, so the caller can
    // decide whether to escalate without a second round-trip). Simulate the SQL faithfully —
    // old value + 1, and the PRE-existing alerted flag — or the escalation edge is untestable.
    if (/consecutiveNoVerdict/.test(query) && /RETURNING/i.test(query)) {
      const prev = typeof seededGh?.consecutiveNoVerdict === 'number' ? (seededGh.consecutiveNoVerdict as number) : 0;
      latestHeadlineHealth = { ...seededGh, consecutiveNoVerdict: prev + 1 };
      return Promise.resolve([{ streak: prev + 1, alerted: seededGh?.noVerdictAlerted === true }]);
    }
    if (/UPDATE\s+harness_shared\.routines/i.test(query) && /\{gate_health\}/.test(query)) {
      if (query.includes("jsonb_build_object('lastSuiteMeasurement'")) {
        const measurement = JSON.parse(String(params[2]));
        const prior = seededGh?.lastSuiteMeasurement as { completedAtMs: number } | undefined;
        if (!prior || prior.completedAtMs <= measurement.completedAtMs) {
          seededGh = { ...seededGh, lastSuiteMeasurement: measurement };
          latestHeadlineHealth = { ...latestHeadlineHealth, lastSuiteMeasurement: measurement };
        }
      }
      const raw = typeof params[1] === 'string' ? params[1] : '';
      if (raw.startsWith('{')) {
        const payload = JSON.parse(raw) as { gate_health?: Record<string, unknown> };
        if (payload.gate_health) latestHeadlineHealth = { ...seededGh, ...latestHeadlineHealth, ...payload.gate_health };
        const workspace = String(params.at(-1) ?? '');
        if (payload.gate_health && updatedGateHealthByWorkspace) {
          updatedGateHealthByWorkspace.set(workspace, payload.gate_health);
        }
      }
    }
    // the routines gate_health write and any escalation upsert are not read for
    // their result.
    return Promise.resolve({ count: 0 });
  },
};

// PARTIAL mock — preserve every other @papercusp/db-org export (getHarnessAdminUrl,
// withWorkspace, …) so importing release-actions' whole graph still resolves; only
// the lazy getOrgPg is overridden to hand back our capturing fake `sql`.
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: fakeSql }),
}));

// P-005: the alert edge dynamically imports these two. Neither is mocked by default
// here (the pre-existing tests deliberately keep the streak BELOW the alert threshold
// so only the SELECT + the final gate_health UPDATE run) — the red-streak tests below
// cross it on purpose, so stub both or a unit test reaches the real SSE/notify path.
const notifyAttention = vi.fn(async (..._a: unknown[]) => {});
// WI-42116: the stall leg calls `notifyAttentionOnce` (the replay-safe variant — it is the one
// that accepts `dedupeKey`). It MUST be stubbed here: the call site swallows its own errors, so
// an absent export would not fail a test, it would silently turn every stall-notify assertion
// into a no-op while `console.warn('stall alert failed')` scrolled past.
const notifyAttentionOnce = vi.fn(async (..._a: unknown[]) => ({
  recordId: 1,
  deduped: false,
  mobileDelivered: true,
  desktopDelivered: true,
}));
vi.mock('../../attention-notify', () => ({
  notifyAttention: (...a: unknown[]) => notifyAttention(...a),
  notifyAttentionOnce: (...a: unknown[]) => notifyAttentionOnce(...a),
}));

const broadcastSevereEvent = vi.fn(async (_ev: Record<string, unknown>) => true);
const broadcastSevereEventResolved = vi.fn(async (_r: Record<string, unknown>) => true);
vi.mock('../../severe-event-broadcast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../severe-event-broadcast')>()),
  broadcastSevereEvent: (ev: Record<string, unknown>) => broadcastSevereEvent(ev),
  broadcastSevereEventResolved: (r: Record<string, unknown>) => broadcastSevereEventResolved(r),
}));

// Keep the real resolution/error boundary, injecting only its condition-store dependency.
// The capturing SQL above implements unsafe(), not the tagged SQL used by that store.
const resolveCondition = vi.fn(async (_input: { conditionKey: string; summary: string }) => true);
vi.mock('../../alarm-attention', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../alarm-attention')>();
  return {
    ...actual,
    resolveAlarm: (key: string, source: string, deps?: import('../../alarm-attention').AlarmAttentionDeps) =>
      actual.resolveAlarm(key, source, { resolve: resolveCondition, ...deps }),
  };
});

const findConditionKeyHolder = vi.fn(async (..._args: unknown[]): Promise<string | null> => null);
vi.mock('../../coord/condition-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../coord/condition-bridge')>()),
  findConditionKeyHolder: (...args: unknown[]) => findConditionKeyHolder(...args),
}));
const updateWorkItem = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
vi.mock('../../work-items', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../work-items')>()),
  updateWorkItem: (...args: unknown[]) => updateWorkItem(...args),
}));

// gate-resilience P-003 (D-002): the torn-sweep announcement goes out through
// `emitAwaitedEvent`, as does the pre-existing legacy red verdict event. Capture it so the
// WIRING can be asserted — and so neither emitter reaches the real events engine (which
// needs a DB) from a unit test. Both call sites swallow their own errors, so an unmocked
// engine would not fail these tests, it would just make them silently prove nothing.
const emitAwaitedEvent = vi.fn(async (_e: Record<string, unknown>) => ({}) as unknown);
vi.mock('../../events/await/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../events/await/engine')>()),
  emitAwaitedEvent: (e: Record<string, unknown>) => emitAwaitedEvent(e),
}));

import {
  trackGateStall,
  mergeGateHealthMonotonic,
  carryForeignGateHealthKeys,
  measureCandidateStaleness,
  gateRedStreakBroadcast,
  buildCheckpointDetail,
  resolveIntegrationRoot,
  FIXER_SUCCESSION_STALL_MS,
  type GitCheckRunner,
} from './release-actions';
import { gateRedStreakConditionKey } from '../../coord/gate-ownership';
import { releaseCheckpointConfig } from '../../release-checkpoint-config';
import type { SystemActionCtx } from './system-actions';

const ctx = { installSlug: 'test-slug', workspaceId: 'test-ws' } as unknown as SystemActionCtx;

/** Pull the last gate_health payload from the captured metadata write. */
function lastGateHealthWrite(): Record<string, unknown> | null {
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i];
    if (/UPDATE\s+harness_shared\.routines/i.test(c.query)) {
      const encoded = c.params.find((param) => typeof param === 'string' && param.trimStart().startsWith('{'));
      if (encoded == null) continue;
      const parsed = JSON.parse(encoded as string) as { gate_health?: Record<string, unknown> };
      if (parsed?.gate_health) return parsed.gate_health;
    }
  }
  return null;
}

beforeEach(() => {
  calls.length = 0;
  seededGh = null;
  seededRepairQueue = null;
  seededGateHealthByWorkspace = null;
  updatedGateHealthByWorkspace = null;
  latestHeadlineHealth = null;
  headlineHealthOverride = undefined;
  seededEvents = [];
  notifyAttention.mockClear();
  notifyAttentionOnce.mockClear();
  broadcastSevereEvent.mockClear();
  broadcastSevereEventResolved.mockClear();
  resolveCondition.mockReset();
  resolveCondition.mockResolvedValue(true);
  emitAwaitedEvent.mockClear();
  findConditionKeyHolder.mockReset();
  findConditionKeyHolder.mockResolvedValue(null);
  updateWorkItem.mockClear();
});

describe('WI-2143684: trackGateStall scopes routine rows by workspace', () => {
  it('leaves a same-install row in another workspace byte-identical', async () => {
    const workspaceA = { consecutiveReds: 0, lastGreenAt: Date.now(), stallAlerted: false };
    const workspaceB = {
      consecutiveReds: 7,
      firstRedAt: 123,
      lastGreenAt: 456,
      failingTests: ['other-workspace.test.ts'],
      observedCandidate: 'other-candidate',
      stallAlerted: true,
    };
    const workspaceBBefore = JSON.parse(JSON.stringify(workspaceB)) as Record<string, unknown>;
    seededGateHealthByWorkspace = new Map([
      ['workspace-a', workspaceA],
      ['workspace-b', workspaceB],
    ]);
    updatedGateHealthByWorkspace = new Map();

    await trackGateStall(
      { workspaceId: 'workspace-a', installSlug: 'shared-install' } as unknown as SystemActionCtx,
      'not-green',
    );

    expect(updatedGateHealthByWorkspace.get('workspace-a')).toMatchObject({ consecutiveReds: 1 });
    expect(updatedGateHealthByWorkspace.has('workspace-b')).toBe(false);
    expect(seededGateHealthByWorkspace.get('workspace-b')).toEqual(workspaceBBefore);
    const routineQueries = calls.filter((call) => /harness_shared\.routines/i.test(call.query));
    expect(routineQueries.length).toBeGreaterThanOrEqual(2);
    expect(routineQueries.every((call) => call.query.includes('workspace_id'))).toBe(true);
    expect(routineQueries.every((call) => call.params.at(-1) === 'workspace-a')).toBe(true);
  });
});

/**
 * gate-resilience-vs-torn-git-sync-sweeps..., P-003 final clause (D-002).
 *
 * The streak-carry for a proven-stale candidate already shipped (WI-39450) and is asserted
 * elsewhere in this file. What did NOT exist was any ANNOUNCEMENT: a torn sweep was absorbed
 * perfectly and reported nowhere, so the phenomenon could not be measured or subscribed to.
 *
 * These test the WIRING specifically, for the reason this file's P-005 block already states —
 * the pure composer (`buildTornSweepAnnouncement`, covered in release-actions.torn-sweep.test.ts)
 * would pass just as happily if the emit were never called.
 */
describe('P-003: trackGateStall ANNOUNCES a torn sweep on the record-only tick', () => {
  const CANDIDATE = '1a9e8a1f0000000000000000000000000000abcd';
  const TIP = '9f7c3d2e1111111111111111111111111111beef';
  const staleRetriage = {
    classification: 'stale-candidate' as const,
    tip: TIP,
    detail: '2 failing file(s) PASS at tip',
  };
  const tornSweepEmits = () =>
    emitAwaitedEvent.mock.calls
      .map((c) => c[0] as { key?: string })
      .filter((e) => typeof e.key === 'string' && e.key.startsWith('green-checkpoint:torn-sweep'));
  /** The gate_health payload this tick wrote; every test here writes exactly one. */
  const gateHealth = (): Record<string, unknown> => {
    const w = lastGateHealthWrite();
    expect(w).not.toBeNull();
    return w!;
  };

  it('⭐ emits the global and install-scoped torn-sweep keys, naming files and the sha range', async () => {
    seededGh = { consecutiveReds: 4, stallAlerted: false, lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'not-green', CANDIDATE, ['a/one.test.ts', 'b/two.test.ts'], null, staleRetriage);

    const emits = tornSweepEmits();
    expect(emits.map((e) => e.key)).toEqual(['green-checkpoint:torn-sweep', 'green-checkpoint:torn-sweep:test-slug']);
    const payload = (emits[0] as { payload?: Record<string, unknown> }).payload!;
    expect(payload).toMatchObject({
      installSlug: 'test-slug',
      candidate: CANDIDATE,
      tip: TIP,
      shaRange: '1a9e8a1f0000..9f7c3d2e1111',
      fileCount: 2,
      streakAdvanced: false,
    });
    expect(payload.failingTests).toEqual(['a/one.test.ts', 'b/two.test.ts']);
  });

  it('⭐ announces WITHOUT advancing the streak — the correction and the report both hold', async () => {
    seededGh = { consecutiveReds: 4, stallAlerted: false, lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'not-green', CANDIDATE, ['a/one.test.ts'], null, staleRetriage);

    expect(tornSweepEmits()).toHaveLength(2);
    // The pre-existing WI-39450 behaviour must be untouched by the announcement.
    expect(gateHealth().consecutiveReds).toBe(4);
  });

  it('does NOT announce a real red — a genuine red is not a torn sweep', async () => {
    seededGh = { consecutiveReds: 4, stallAlerted: false, lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'not-green', CANDIDATE, ['a/one.test.ts'], null, {
      classification: 'real-red',
      tip: TIP,
      detail: 'reproduces at tip',
    });

    expect(tornSweepEmits()).toEqual([]);
    // And the genuinely-red path keeps advancing the streak, exactly as before.
    expect(gateHealth().consecutiveReds).toBe(5);
  });

  it('does NOT announce when the gate never re-triaged at all', async () => {
    seededGh = { consecutiveReds: 4, stallAlerted: false, lastGreenAt: Date.now() };
    await trackGateStall(ctx, 'not-green', CANDIDATE, ['a/one.test.ts']);
    expect(tornSweepEmits()).toEqual([]);
  });

  it('does NOT announce a PROMOTION-PENDING record-only tick, even with a stale re-triage in hand', async () => {
    // P-006. `record-only` is reached by two roads and only one of them is a torn sweep: a
    // promotion-pending tick carries the streak because the verdict precedes the promotion
    // DECISION, not because a sweep tore. Announcing it would attribute a git-sync tear to a run
    // that never proved one — which is exactly the miscount the announcement exists to expose.
    // The `!promotionPending` guard in trackGateStall is the only thing separating them.
    //
    // The second arm below is the POSITIVE CONTROL, and it is what makes this test falsifiable
    // rather than merely green: it runs the IDENTICAL fixture with promotionPending dropped and
    // asserts it DOES announce. Without it, `toEqual([])` would pass just as happily if the
    // fixture never reached the announcing branch at all — a silent zero reading as a guard.
    const emitsFor = async (options: { promotionPending?: boolean; green?: boolean; runId: string }) => {
      calls.length = 0;
      emitAwaitedEvent.mockClear();
      seededGh = { consecutiveReds: 4, stallAlerted: false, lastGreenAt: Date.now() };
      await trackGateStall(
        ctx,
        'not-green',
        CANDIDATE,
        ['a/one.test.ts'],
        null,
        staleRetriage,
        null,
        undefined,
        options,
      );
      return { emits: tornSweepEmits(), reds: gateHealth().consecutiveReds };
    };

    const pending = await emitsFor({ promotionPending: true, green: true, runId: 'run-pending-1' });
    expect(pending.emits).toEqual([]);
    // The streak half is untouched by the guard — this tick still carries, for its own reason.
    expect(pending.reds).toBe(4);

    const notPending = await emitsFor({ green: true, runId: 'run-pending-2' });
    expect(notPending.emits).toHaveLength(2);
    expect(notPending.reds).toBe(4);
  });

  it('does NOT raise a red stall alarm for a promotion-pending GREEN when age crosses the threshold', async () => {
    // A pending green is intentionally record-only until promotion settles, but it is not a
    // red verdict. Feeding it to the age ladder made a stale lastGreenAt look like a current
    // red: the alarm reported "0 consecutive red" immediately before the same run's final
    // GREEN (EI-22104112908427169).
    const stallAgeMs = releaseCheckpointConfig().stallAgeMs;
    seededGh = {
      consecutiveReds: 0,
      stallAlerted: false,
      stallAlertedAtAgeMs: null,
      lastGreenAt: Date.now() - stallAgeMs * 2,
    };

    await trackGateStall(
      ctx,
      'advanced',
      'green-pending-candidate',
      [],
      null,
      undefined,
      null,
      undefined,
      { promotionPending: true, green: true, runId: 'pending-green-run' },
    );

    expect(notifyAttentionOnce).not.toHaveBeenCalled();
    expect(broadcastSevereEvent).not.toHaveBeenCalled();
    expect(lastGateHealthWrite()).toMatchObject({
      consecutiveReds: 0,
      lastVerdict: 'decision-pending',
      stallAlerted: false,
      stallAlertedAtAgeMs: null,
    });
  });
});

/**
 * P-005 (gate-ownership-followup-2026-08-08): a RED gate must open exactly one
 * condition, so the bridge mints exactly one ownable work-item — and must CLOSE it
 * on green, so the bridge settles that item instead of leaking one per episode.
 *
 * These test the WIRING, which is the part that can actually be wrong. The pure
 * composer is covered separately below; a composer test alone would pass just as
 * happily if neither edge were wired at all — which was the pre-P-005 state
 * (`green-checkpoint:red` existed only as an event key, never as a conditionKey, so
 * a plain red gate had no ownable item and a 6-red streak held `main` ~4h unowned).
 */
/**
 * ⚠ EI-21462211894072863 — why the red-tick tests below say `'not-green'` where they once said
 * `'error'`. They were never ABOUT 'error'; it was simply a convenient non-green status back when
 * every non-green status was a red. It no longer is: a run that publishes no result marker judged
 * no code, so 'error' is now the 'no-verdict' class and writes no verdict at all. Driving a
 * red-streak test with it would assert red behaviour through a status that deliberately produces
 * none. `'not-green'` is a real verdict — the gate ran and judged the code red — which is exactly
 * what these tests mean. The 'error' path has its own suite at the bottom of this file.
 */
describe('P-005: trackGateStall opens/closes the gate-red-streak CONDITION', () => {
  /** `lastGateHealthWrite()` with the null-check folded in — every test here writes one. */
  const written = (): Record<string, unknown> => {
    const w = lastGateHealthWrite();
    expect(w).not.toBeNull();
    return w!;
  };
  const KEY = gateRedStreakConditionKey('test-slug');
  /** Read the threshold from config rather than hardcoding 3 — a runtime re-tune
   *  (release:checkpoint-config, P-016) must not silently invert these tests. */
  const stallReds = releaseCheckpointConfig().stallReds;

  it('⭐ opens the condition on the red tick that reaches the streak threshold', async () => {
    // One red short of the threshold, and a RECENT green so the age leg cannot be
    // what fires (isolating the count trigger).
    seededGh = { consecutiveReds: stallReds - 1, stallAlerted: false, lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'not-green');

    expect(broadcastSevereEvent).toHaveBeenCalledTimes(1);
    const ev = broadcastSevereEvent.mock.calls[0]![0]!;
    expect(ev.conditionKey).toBe(KEY);
    // WI-6228: without oneShot the condition-staleness sweep reads this emitter's
    // deliberate silence as recovery and auto-resolves on a timer — closing the
    // owning work-item while the gate is still red.
    expect(ev.oneShot).toBe(true);
    expect(written().consecutiveReds).toBe(stallReds);
  });

  it('does NOT open below the threshold — a single self-healing red mints nothing', async () => {
    seededGh = { consecutiveReds: 0, stallAlerted: false, lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'not-green');

    expect(broadcastSevereEvent).not.toHaveBeenCalled();
    expect(written().consecutiveReds).toBe(1);
  });

  it('⭐ opens ONCE per episode — a deeper red does not re-broadcast', async () => {
    // The one-shot property is what makes the condition a SINGLETON: the bridge keys
    // on the conditionKey, but a re-alarm every hourly red tick would re-open a
    // condition the responder is already working and re-spam the whole fleet.
    seededGh = { consecutiveReds: stallReds + 2, stallAlerted: true, lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'not-green');

    expect(broadcastSevereEvent).not.toHaveBeenCalled();
  });

  it('⭐ closes the condition on the GREEN tick that ends a streak', async () => {
    seededGh = { consecutiveReds: stallReds + 2, stallAlerted: true, lastGreenAt: Date.now() - 60_000 };

    await trackGateStall(ctx, 'advanced');

    expect(broadcastSevereEventResolved).toHaveBeenCalledTimes(1);
    expect(broadcastSevereEventResolved.mock.calls[0]![0]!.conditionKey).toBe(KEY);
    expect(written().consecutiveReds).toBe(0);
  });

  it('⭐ reads the PRE-reset stallAlerted, not the value this green tick writes', async () => {
    // The trap this guards: the green branch sets `next.stallAlerted = false` a few
    // lines ABOVE the resolve. Testing the post-reset value instead of the seeded
    // `gh.stallAlerted` makes the resolve unreachable dead code — the condition then
    // never closes, the bridge never settles, and the gate accumulates one
    // permanently-open incident item per episode (D-011's leak). The assertion that
    // catches it is simply that a green tick after an ALERTED streak DOES resolve,
    // which the test above asserts; this one pins the reason by showing the written
    // flag is false at the same time.
    seededGh = { consecutiveReds: stallReds, stallAlerted: true, lastGreenAt: Date.now() - 60_000 };

    await trackGateStall(ctx, 'advanced');

    expect(written().stallAlerted).toBe(false);
    expect(broadcastSevereEventResolved).toHaveBeenCalledTimes(1);
  });

  it('a routinely-GREEN tick resolves nothing — no all-clear for an alarm never raised', async () => {
    // Without the `gh.stallAlerted` guard this fires a fleet-wide resolution every
    // green hour, for a condition that was never open.
    seededGh = { consecutiveReds: 0, stallAlerted: false, lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'advanced');

    expect(broadcastSevereEventResolved).not.toHaveBeenCalled();
  });

  it('a broadcast failure never breaks the gate_health write', async () => {
    // Fail-safe like every sibling best-effort step here: losing the condition costs
    // one un-owned red, losing the metadata write corrupts the streak state itself.
    broadcastSevereEvent.mockRejectedValueOnce(new Error('coord down'));
    seededGh = { consecutiveReds: stallReds - 1, stallAlerted: false, lastGreenAt: Date.now() };
    // The failure is REPORTED, not swallowed — assert the warn explicitly rather than
    // silencing it, so "fails safe" cannot quietly become "fails silently".
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(trackGateStall(ctx, 'not-green')).resolves.not.toThrow();

    expect(written().consecutiveReds).toBe(stallReds);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('red-streak condition broadcast failed'));
    warn.mockRestore();
  });
});

describe('WI-6554700010008583: existing gate incident headline stays current', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows a nine-day freeze and the post-increment no-verdict count without re-opening the condition', async () => {
    const now = Date.UTC(2026, 9, 11, 20);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    seededGh = {
      lastVerdict: 'not-green', lastGreenAt: now - 216 * 3_600_000,
      consecutiveReds: 2, consecutiveNoVerdict: 286, stallAlerted: true, noVerdictAlerted: true,
      failingTests: ['check-a', 'check-b', 'check-c', 'check-d', 'check-e', 'check-f', 'check-g'],
    };
    findConditionKeyHolder.mockResolvedValue('WI-existing-gate');

    await trackGateStall(ctx, 'error', undefined, undefined, 'runner exited without a verdict');

    expect(updateWorkItem).toHaveBeenCalledWith('WI-existing-gate', {
      title: 'green-checkpoint held on test-slug — ~216h since last green; 2 consecutive red verdict(s), 287 consecutive no-verdict run(s); last red: sample of 7 failure entries (total unknown); main frozen.',
    }, 'system:green-checkpoint', { harness: 'test-slug' });
    expect(findConditionKeyHolder).toHaveBeenCalledWith('gate-red-streak:test-slug', {
      harnessSlug: 'test-slug', workspaceId: 'test-ws',
    });
    expect(broadcastSevereEvent).not.toHaveBeenCalled();
    expect(calls.filter(c => /consecutiveNoVerdict/.test(c.query) && /RETURNING/i.test(c.query))).toHaveLength(1);
  });

  it('refreshes the age on a repair hold while preserving the owner and counters', async () => {
    const now = Date.UTC(2026, 9, 11, 20);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    seededGh = {
      lastVerdict: 'not-green', lastGreenAt: now - 216 * 3_600_000,
      consecutiveReds: 2, consecutiveNoVerdict: 286, stallAlerted: true,
    };
    findConditionKeyHolder.mockResolvedValue('WI-existing-gate');

    await trackGateStall(ctx, 'repair-in-progress', undefined, undefined, 'repair in progress');
    clock.mockReturnValue(now + 24 * 3_600_000);
    await trackGateStall(ctx, 'repair-in-progress', undefined, undefined, 'repair in progress');

    const titles = updateWorkItem.mock.calls.map(call => (call[1] as { title: string }).title);
    expect(titles[0]).toContain('~216h since last green');
    expect(titles[1]).toContain('~240h since last green');
    expect(titles.every(title => title.includes('2 consecutive red verdict(s), 286 consecutive no-verdict run(s)'))).toBe(true);
    expect(updateWorkItem.mock.calls.every(call => call[0] === 'WI-existing-gate')).toBe(true);
    expect(broadcastSevereEvent).not.toHaveBeenCalled();
    expect(calls.some(c => /consecutiveNoVerdict/.test(c.query) && /RETURNING/i.test(c.query))).toBe(false);
  });

  it('uses the current persisted health when another run has reset to green', async () => {
    seededGh = { consecutiveReds: 2, consecutiveNoVerdict: 286, stallAlerted: true };
    headlineHealthOverride = { lastVerdict: 'green', consecutiveReds: 0, consecutiveNoVerdict: 0 };
    findConditionKeyHolder.mockResolvedValue('WI-existing-gate');

    await trackGateStall(ctx, 'repair-in-progress', undefined, undefined, 'repair in progress');

    expect(updateWorkItem).not.toHaveBeenCalled();
    expect(broadcastSevereEvent).not.toHaveBeenCalled();
  });
});

describe('EI-26705451804341457: failure entry counts survive sampling', () => {
  const failures = Array.from({ length: 30 }, (_, i) => `workspace-${i}`);

  it('preserves the reported population in the event and headline while bounding the stored sample', () => {
    const detail = buildCheckpointDetail({ reason: 'not-green', failingTests: failures });
    expect(detail.failingTests).toEqual(failures.slice(0, 20));
    expect(detail.failingTestsSummary).toEqual({
      unit: 'reported-failure-entry', reportedEntries: 30, retainedEntries: 20, truncated: true,
    });
    const { summary, body } = gateRedStreakBroadcast({
      installSlug: 'test-slug', consecutiveReds: 1, heldHrs: 2,
      ...detail,
    });
    expect(summary).toContain('30 reported failure entries');
    expect(summary).not.toContain('failing check(s)');
    expect(body).toContain('Failure sample (20 retained)');
    expect(body).not.toContain('workspace-29');
  });

  it('does not invent a total for legacy or inconsistent count metadata', () => {
    for (const failingTestsSummary of [undefined, {
      unit: 'reported-failure-entry' as const, reportedEntries: 2, retainedEntries: 20, truncated: false,
    }]) {
      const { summary } = gateRedStreakBroadcast({
        installSlug: 'test-slug', consecutiveReds: 1, heldHrs: 2,
        failingTests: failures.slice(0, 20), failingTestsSummary,
      });
      expect(summary).toContain('sample of 20 failure entries (total unknown)');
    }
  });

  it('stores the full reported count with gate health and carries its metadata with inherited names', async () => {
    seededGh = { consecutiveReds: 0, lastGreenAt: Date.now() };
    await trackGateStall(ctx, 'not-green', 'candidate-real', failures);
    const health = lastGateHealthWrite()!;
    expect(health.failingTests).toHaveLength(20);
    expect(health.failingTestsSummary).toMatchObject({ reportedEntries: 30, retainedEntries: 20 });
    const carried = mergeGateHealthMonotonic(health, {
      lastVerdict: 'not-green', lastFromFresh: false, observedCandidate: health.observedCandidate,
      failingTests: [], failingTestsSummary: null,
    });
    expect(carried.failingTestsSummary).toEqual(health.failingTestsSummary);
    const green = buildCheckpointDetail({ reason: 'advanced', green: true, failingTests: [] });
    expect(green.failingTestsSummary).toMatchObject({ reportedEntries: 0, retainedEntries: 0, truncated: false });
  });
});

describe('P-005: gateRedStreakBroadcast (pure)', () => {
  it('names the streak, the failing tests, and the SIBLING condition', () => {
    const { summary, body } = gateRedStreakBroadcast({
      installSlug: 'papercusp',
      consecutiveReds: 4,
      heldHrs: 5,
      candidate: 'deadbeefcafe1234',
      failingTests: ['a.test.ts', 'b.test.ts'],
    });
    expect(summary).toContain('4 consecutive red');
    expect(summary).toContain('papercusp');
    expect(body).toContain('a.test.ts');
    // Naming green-stall: is the whole mitigation for the accepted double-ownership
    // overlap — a claimant learns it from the alert instead of re-deriving it.
    expect(body).toContain('green-stall:papercusp');
  });

  it('warns AT TIP when the judged candidate trails staging', () => {
    // On this tree the fix is very often already committed, so a red whose candidate
    // is behind tip is the single most common wasted chase.
    const { body } = gateRedStreakBroadcast({
      installSlug: 'papercusp',
      consecutiveReds: 3,
      heldHrs: null,
      commitsBehindTip: 12,
    });
    expect(body).toContain('12 commit(s) behind staging');
    expect(body).toContain('AT TIP');
  });

  it('omits the behind-tip note when the candidate IS tip', () => {
    const { body } = gateRedStreakBroadcast({
      installSlug: 'papercusp',
      consecutiveReds: 3,
      heldHrs: null,
      commitsBehindTip: 0,
    });
    expect(body).not.toContain('behind staging');
  });

  // ── P-007 (converge-frozen-candidate-by-fix-only-admission-2026-08-27), re-based on
  // D-010 (frozen-candidate-stays-frozen-through-all-fixes-2026-09-03) ──────────────
  // "Discoverability at the moment of failure": a responder reaching a red gate has to
  // learn WHERE the repair is authored and WHAT may be admitted before touching
  // anything. Both previously lived only in a doc nobody opens mid-incident. Under D-010
  // there is NO repair worktree: the fix is authored in the shared staging checkout and
  // reaches the judged lineage ONLY through path-exact admission
  // (`release:repair-queue { op: 'admit', paths }`), never by re-cutting at tip.
  describe('P-007/D-010: names where to fix and the path-exact admission rule', () => {
    // FALSIFIABILITY CONTROL, kept permanently (CLAUDE.md: for a module subject, keep a
    // deliberately-wrong implementation in the test file rather than mutating the shared
    // tree). This is the pre-P-007 body verbatim-in-shape. Every assertion below must
    // REJECT it; an assertion that passes here is vacuous and would stay green if the
    // discoverability text were deleted.
    const preP007Body =
      'The release gate is FIRING but every verdict is red.\n\n' +
      'This condition owns ONE work-item for this red (the condition bridge mints it), so claim ' +
      'that item rather than opening another. Distinct from `green-stall:papercusp`, which means ' +
      'the gate is not producing verdicts AT ALL.';

    const bodyOf = () =>
      gateRedStreakBroadcast({
        installSlug: 'papercusp',
        consecutiveReds: 3,
        heldHrs: 2,
        candidate: 'deadbeefcafe1234',
      }).body;

    it('says the fix is authored on staging (no repair worktree) and names the tool that reports the lineage', () => {
      const body = bodyOf();
      // D-010: the retired worktree must NOT be named — reconstructing that path by hand is
      // how a responder ends up authoring in a tree the gate is never going to admit.
      expect(body).not.toContain('.papercusp/worktrees/green-candidate-');
      expect(body).toContain('NO repair worktree');
      expect(body).toContain('shared staging checkout');
      // ...and the tool, so the responder reads the real candidate/repairHead pair.
      expect(body).toContain("release:repair-queue { op: 'get' }");
      expect(body).toContain('repairHead');
      expect(preP007Body).not.toContain('repair worktree');
      expect(preP007Body).not.toContain('release:repair-queue');
    });

    it('states the path-exact admission rule: admit by path, diff-tree == allowlist, never a re-cut at tip', () => {
      const body = bodyOf();
      expect(body).toContain("release:repair-queue { op: 'admit', paths: [...] }");
      expect(body).toContain('dry-run first');
      expect(body).toContain('confirm: true');
      expect(body).toContain('diff-tree must equal the allowlist');
      expect(body).toContain('no path ever re-cuts the candidate from tip');
      expect(body).toContain('/internal/docs/agent-insights/frozen-candidate-fix-only-admission');
      // The retired rule shapes must be gone with the worktree they described.
      expect(body).not.toContain('git add -A');
      expect(preP007Body).not.toContain("op: 'admit'");
      expect(preP007Body).not.toContain('frozen-candidate-fix-only-admission');
    });

    it('keeps the discoverability text UNCONDITIONAL — every red carries it', () => {
      // Deliberately not gated on `candidate` / `failingTests` / a repair queue existing.
      // The responder who most needs the rule is the one reaching a red with the least
      // context attached, so gating it on optional evidence would drop it exactly then.
      const bare = gateRedStreakBroadcast({
        installSlug: 'papercusp',
        consecutiveReds: 1,
        heldHrs: null,
      }).body;
      expect(bare).toContain('NO repair worktree');
      expect(bare).toContain("release:repair-queue { op: 'admit', paths: [...] }");
      expect(bare).toContain('frozen-candidate-fix-only-admission');
    });
  });
});

describe('trackGateStall gate_health cross-writer preservation (EI-7472)', () => {
  it('preserves watchdogAlerted:true across a RED tick', async () => {
    // The watchdog sweep already flipped its dedup flag; a subsequent red
    // green-checkpoint fire must not clobber it. Keep the streak below the alert
    // threshold so only the SELECT + the final gate_health UPDATE run.
    seededGh = { consecutiveReds: 0, watchdogAlerted: true, stallAlerted: false, lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'not-green');

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    // The bug: without carrying the field through `next`, this is `undefined`.
    expect(written!.watchdogAlerted).toBe(true);
    // Sanity: this is a real red tick (streak incremented), not a reset.
    expect(written!.consecutiveReds).toBe(1);
  });

  it('preserves watchdogAlerted:false across a RED tick (absent seed defaults to false, never dropped)', async () => {
    seededGh = { consecutiveReds: 1, stallAlerted: false, lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'not-green');

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    // Field is always present (false), so the watchdog's one-shot dedup read is
    // never a null/undefined that reads as "not yet alerted".
    expect(written!.watchdogAlerted).toBe(false);
  });

  it('clears watchdogAlerted on a GREEN/reset tick (recovery clears the dedup flag)', async () => {
    seededGh = { consecutiveReds: 5, watchdogAlerted: true, stallAlerted: true, lastGreenAt: Date.now() - 60_000 };

    await trackGateStall(ctx, 'advanced');

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.watchdogAlerted).toBe(false);
    // Sanity: the green verdict reset the streak.
    expect(written!.consecutiveReds).toBe(0);
  });
});

describe('trackGateStall monotonic gate_health merge (EI-20854484804457933)', () => {
  it('preserves a completed run’s populated failures across a later non-fresh empty observation', async () => {
    const prior = {
      consecutiveReds: 1,
      lastGreenAt: Date.now(),
      lastFromFresh: true,
      lastVerdict: 'not-green',
      failingTests: ['real-failure.test.ts'],
      observedCandidate: 'candidate-re',
    };
    seededGh = prior;

    // The later observation has no failing set and cannot prove a fresh verdict (`from` is
    // absent). The old whole-key replacement wrote `[]` here and erased the completed red.
    const folded = mergeGateHealthMonotonic(prior, {
      failingTests: [],
      lastFromFresh: false,
      lastVerdict: 'not-green',
      observedCandidate: 'candidate-re',
    });
    expect(folded.failingTests).toEqual(prior.failingTests);

    await trackGateStall(ctx, 'not-green', 'candidate-real');

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.failingTests).toEqual(['real-failure.test.ts']);
    // Existing gate_health identifiers are intentionally short-sha'd to 12 characters.
    expect(written!.observedCandidate).toBe('candidate-re');

    const update = [...calls].reverse().find((call) => /UPDATE\s+harness_shared\.routines/i.test(call.query));
    expect(update?.query).toContain('jsonb_array_length');
    expect(update?.query).toContain('lastFromFresh');
    expect(update?.query).toContain('observedCandidate');
  });

  it('does not carry a prior candidate’s failures onto a newer empty verdict', () => {
    const folded = mergeGateHealthMonotonic(
      {
        failingTests: ['lint:tsc'],
        observedCandidate: 'old-candidate',
      },
      {
        failingTests: [],
        lastFromFresh: false,
        lastVerdict: 'not-green',
        observedCandidate: 'new-candidate',
      },
    );

    expect(folded.failingTests).toEqual([]);
  });
});

/**
 * EI-18832825158594027: the fold above is CORRECT to preserve the names — an empty observation
 * is not evidence the failures disappeared. What was missing is that the preserved list was
 * written back indistinguishable from a fresh measurement, so `release:trace` / `dev:why`
 * rendered inherited names as a current, authoritative blame list. Two expensive wrong moves
 * follow: editing already-green code, and re-firing the gate to "refresh" it.
 *
 * `failingTestsCarriedForward` is that missing axis. It is deliberately NOT a replacement for
 * `failingTestsMeasured` — the inherited names WERE measured, just not by this tick, so
 * conflating the two would destroy real evidence.
 */
describe('gate_health marks an INHERITED failing-test list (EI-18832825158594027)', () => {
  it('⭐ stamps failingTestsCarriedForward when it preserves a prior observation’s names', () => {
    const folded = mergeGateHealthMonotonic(
      { failingTests: ['real-failure.test.ts'], observedCandidate: 'candidate-re' },
      {
        failingTests: [],
        lastFromFresh: false,
        lastVerdict: 'not-green',
        observedCandidate: 'candidate-re',
      },
    );

    expect(folded.failingTests).toEqual(['real-failure.test.ts']);
    expect(folded.failingTestsCarriedForward).toBe(true);
  });

  /**
   * The guard that matters most. A carried-forward marker outliving the carry-forward is the
   * SAME defect one level up — a stale qualifier on a fresh list — and it fails in the more
   * dangerous direction, telling a reader to discount names that are genuinely current.
   */
  it('⭐ CLEARS the marker when the new observation measured its own failures', () => {
    const folded = mergeGateHealthMonotonic(
      {
        failingTests: ['inherited.test.ts'],
        observedCandidate: 'candidate-re',
        // A previous write left the flag set; it must not ride along onto fresh names.
        failingTestsCarriedForward: true,
      } as Record<string, unknown>,
      {
        failingTests: ['freshly-observed.test.ts'],
        lastFromFresh: true,
        lastVerdict: 'not-green',
        observedCandidate: 'candidate-re',
      },
    );

    expect(folded.failingTests).toEqual(['freshly-observed.test.ts']);
    expect(folded.failingTestsCarriedForward).toBe(false);
  });

  it('marks a non-preserving fold false rather than leaving the axis absent', () => {
    // Different candidate: the fold declines to preserve, so nothing is inherited. An ABSENT
    // field would force every consumer to guess; false is the answer.
    const folded = mergeGateHealthMonotonic(
      { failingTests: ['lint:tsc'], observedCandidate: 'old-candidate' },
      {
        failingTests: [],
        lastFromFresh: false,
        lastVerdict: 'not-green',
        observedCandidate: 'new-candidate',
      },
    );

    expect(folded.failingTests).toEqual([]);
    expect(folded.failingTestsCarriedForward).toBe(false);
  });

  /**
   * The SQL predicate re-applies the preservation rule against the row at UPDATE time, closing
   * the read/modify/write race the TS fold cannot see. That branch must stamp the marker too —
   * it is precisely the concurrent case, where the TS fold already decided `false`, that would
   * otherwise persist an unlabelled inherited list.
   */
  it('⭐ stamps the marker in the SQL race branch, not only in the TS fold', async () => {
    seededGh = { consecutiveReds: 0, stallAlerted: false, lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'not-green', 'deadbeefcafe', ['pkgA/foo.test.ts']);

    const update = [...calls].reverse().find((call) => /UPDATE\s+harness_shared\.routines/i.test(call.query));
    expect(update?.query).toContain('failingTestsCarriedForward');
    // Guard the DIRECTION: the preserve branch is the one that must set it true.
    expect(update?.query).toMatch(/\{failingTestsCarriedForward\}'[\s\S]*?'true'::jsonb/);
  });
});

/**
 * EI-7505: the green-checkpoint action already parses `failingTests` from the
 * verdict and passes them into `trackGateStall`, but the function previously
 * discarded them — the persisted `gate_health` `next` object never carried a
 * `failingTests` key, forcing a responder to hand-spelunk
 * `harness_shared.test_runs` (inconclusive — it mixes every agent's local
 * dev-test runs with the verdict run) during a live deploy-freeze just to see
 * which test(s) are failing the gate. These tests assert the list is now
 * persisted on a red tick and cleared on recovery.
 */
describe('trackGateStall persists failingTests into gate_health (EI-7505)', () => {
  it('persists the failing-test list on a RED tick', async () => {
    seededGh = { consecutiveReds: 0, stallAlerted: false, lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'not-green', 'deadbeefcafe', ['pkgA/foo.test.ts', 'pkgB/bar.test.ts']);

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.failingTests).toEqual(['pkgA/foo.test.ts', 'pkgB/bar.test.ts']);
  });

  it('truncates the persisted list to 20 entries', async () => {
    seededGh = { consecutiveReds: 0, stallAlerted: false, lastGreenAt: Date.now() };
    const tests = Array.from({ length: 30 }, (_, i) => `pkg/file-${i}.test.ts`);

    await trackGateStall(ctx, 'not-green', 'deadbeefcafe', tests);

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.failingTests).toHaveLength(20);
    expect(written!.failingTests).toEqual(tests.slice(0, 20));
  });

  it('persists an empty list on a RED tick with no failingTests param (never undefined)', async () => {
    seededGh = { consecutiveReds: 0, stallAlerted: false, lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'not-green');

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.failingTests).toEqual([]);
  });

  it('clears failingTests on a GREEN/reset tick (a stale list must not linger past recovery)', async () => {
    seededGh = {
      consecutiveReds: 5,
      stallAlerted: true,
      lastGreenAt: Date.now() - 60_000,
      failingTests: ['pkgA/foo.test.ts'],
    };

    await trackGateStall(ctx, 'advanced');

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.failingTests).toEqual([]);
  });
});

/**
 * EI-13288: green-checkpoint's stale-candidate re-triage (`classifyRedAgainstTip`) can PROVE a
 * red's named failing files pass at a newer tip, but discarded that proof before recording — a
 * reader (dev:why / coord:orient) then saw a "fresh" red naming files the gate's own evidence
 * already knew didn't reproduce. These tests assert `trackGateStall` now threads the CLI's
 * `retriage` verdict into `gate_health` (`retriageStaleTip` / `retriageDetail`), so
 * gate-verdict-freshness's Rule 3 can report the verdict as `stale-verdict` instead of a
 * misleading `red`.
 */
describe('trackGateStall persists retriage staleness into gate_health (EI-13288)', () => {
  const retriage = {
    classification: 'stale-candidate' as const,
    tip: '6d9aff3704c9c5937a0ffe13e139021d9101cff3',
    detail: '2 failing file(s) PASS at tip 6d9aff37 — the red is stale; refire cap reached',
    autoRefire: false,
    refireBlockedBy: 'charged-budget' as const,
  };

  it('persists retriageStaleTip/retriageDetail on a RED tick classified stale-candidate', async () => {
    seededGh = { consecutiveReds: 0, stallAlerted: false, lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'not-green', 'deadbeefcafe', ['pkgA/foo.test.ts'], null, retriage);

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    // Short-sha'd, matching the observedCandidate / lastFrom convention elsewhere in this blob.
    expect(written!.retriageStaleTip).toBe('6d9aff3704c9');
    expect(written!.retriageDetail).toBe(retriage.detail);
    // The streak still counts this tick — retriage staleness qualifies the FAILING-TEST NAMES,
    // it does not relax the gate's held/not-held decision (the bug's own requirement #4).
    expect(written!.consecutiveReds).toBe(1);
  });

  it('does NOT persist stale-cap fields while the stale candidate is still auto-refiring', async () => {
    seededGh = { consecutiveReds: 0, stallAlerted: false, lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'not-green', 'deadbeefcafe', ['pkgA/foo.test.ts'], null, {
      classification: 'stale-candidate',
      tip: '6d9aff3704c9c5937a0ffe13e139021d9101cff3',
      detail: '2 failing file(s) PASS at tip 6d9aff37 — auto-refiring; cap not reached',
      autoRefire: true,
      refireBlockedBy: null,
    });

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.retriageStaleTip).toBeNull();
    expect(written!.retriageDetail).toBeNull();
    // Keep the classification for additive diagnostics; only the Rule-3 stale-cap pair is
    // suppressed until the producer proves the refire was blocked.
    expect(written!.retriageClassification).toBe('stale-candidate');
  });

  it('fails closed for a legacy stale-candidate payload that omits the autoRefire flag', async () => {
    seededGh = { consecutiveReds: 0, stallAlerted: false, lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'not-green', 'deadbeefcafe', ['pkgA/foo.test.ts'], null, {
      classification: 'stale-candidate',
      tip: '6d9aff3704c9c5937a0ffe13e139021d9101cff3',
      detail: '2 failing file(s) PASS at tip 6d9aff37 — legacy payload',
    });

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.retriageStaleTip).toBeNull();
    expect(written!.retriageDetail).toBeNull();
  });

  it('does NOT persist retriage fields for a genuinely real-red (no phantom note on a true break)', async () => {
    seededGh = { consecutiveReds: 0, stallAlerted: false, lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'not-green', 'deadbeefcafe', ['pkgA/foo.test.ts'], null, {
      classification: 'real-red',
      tip: '6d9aff3704c9c5937a0ffe13e139021d9101cff3',
      detail: 'failures REPRODUCE at tip — genuine red, holding the gate',
    });

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.retriageStaleTip).toBeNull();
    expect(written!.retriageDetail).toBeNull();
  });

  it('does NOT persist retriage fields when the caller has none (old CLI / no retriage available)', async () => {
    seededGh = { consecutiveReds: 0, stallAlerted: false, lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'not-green', 'deadbeefcafe', ['pkgA/foo.test.ts']);

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.retriageStaleTip).toBeNull();
    expect(written!.retriageDetail).toBeNull();
  });

  it('a stale-candidate note does NOT outlive the red streak it was recorded on — cleared the very next tick when retriage is absent', async () => {
    seededGh = {
      consecutiveReds: 1,
      stallAlerted: false,
      lastGreenAt: Date.now() - 60_000,
      retriageStaleTip: '6d9aff3704c9',
      retriageDetail: 'stale from a prior tick',
    };

    // The NEXT red tick has no retriage info of its own (e.g. resolveTip failed) — the prior
    // tick's stale note must not linger and be misread as still describing THIS verdict.
    await trackGateStall(ctx, 'not-green', 'cafebabe1234', ['pkgA/foo.test.ts']);

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.retriageStaleTip).toBeNull();
    expect(written!.retriageDetail).toBeNull();
  });

  it('clears retriage fields on a GREEN/reset tick (recovery clears the stale note)', async () => {
    seededGh = {
      consecutiveReds: 5,
      stallAlerted: true,
      lastGreenAt: Date.now() - 60_000,
      retriageStaleTip: '6d9aff3704c9',
      retriageDetail: 'stale from a prior red streak',
    };

    await trackGateStall(ctx, 'advanced');

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.retriageStaleTip).toBeNull();
    expect(written!.retriageDetail).toBeNull();
  });
});

/**
 * EI-19329732364513693: a red verdict names failing tests, and both agents and the
 * release-fixer dispatcher act on those names — but nothing in `gate_health` said how OLD the
 * judged candidate was, so a red on a candidate the tree had long moved past read exactly like
 * a red on current code.
 *
 * Measured 2026-08-02: five failures across two consecutive reds, every one already GREEN at
 * tip. The component→test skew windows were 34min and 2h11m, and the run fired at 11:15:03Z
 * was cut 39 SECONDS before the fix for the very tests it judged. Six-plus agents chased those
 * phantoms for most of a night.
 *
 * These assert the verdict now self-discloses its own staleness.
 */
describe('trackGateStall persists candidate staleness into gate_health (EI-19329732364513693)', () => {
  /** Fake git: `log -1 --format=%cI` → commit time, `rev-list --count` → distance behind tip.
   *  A null argument makes that specific git call FAIL, to exercise the fail-safe path. */
  const stalenessRunner =
    (commitIso: string | null, behind: string | null): GitCheckRunner =>
    async (_root, args) => {
      if (args[0] === 'log') return { ok: commitIso != null, stdout: commitIso ?? '' };
      if (args[0] === 'rev-list') return { ok: behind != null, stdout: behind ?? '' };
      return { ok: false, stdout: '' };
    };

  /** HERMETIC ROOT PIN — this describe must not depend on WHICH CHECKOUT it runs in.
   *
   *  The two trackGateStall cases below reach the staleness measurement through
   *  `integrationRootForDiagnostic()`, which returns `null` when `resolveIntegrationRoot`
   *  refuses the tree. That resolver derives `resolve(cwd,'..','..')` and vitest runs
   *  operator-core with cwd `<tree>/packages/operator-core`, so the basename it judges is the
   *  CHECKOUT NAME: "papercusp" resolves fine, "papercusp-checkpoint" is refused. The
   *  production caller gates the measurement on a non-null root, so an unpinned run inside
   *  the checkpoint checkout records nulls and both assertions below fail — GREEN in the
   *  shared tree, RED in the only tree the gate actually runs its own suite in (observed:
   *  green-checkpoint red on candidate 53f4676f, 2026-08-12).
   *
   *  Pinning it HERE, and only here, is deliberate. These cases are about staleness fields
   *  surviving the whole-object gate_health replace (EI-19329732364513693 / EI-7472) — root
   *  RESOLUTION is not their subject, so inheriting it from the ambient checkout is the bug.
   *  ⚠ Do NOT hoist this pin to the file scope to "fix" other failures: the describe at the
   *  bottom of this file deliberately CLEARS the var to exercise the refusal path, and a
   *  global pin would mask every other test's sensitivity to the guard this file exists to
   *  protect. The value is arbitrary — the git runner is faked, so the root is never read. */
  const PINNED_ROOT = '/tmp/papercusp-gate-health-fixture-root';
  let savedRootForStaleness: string | undefined;

  beforeEach(() => {
    savedRootForStaleness = process.env.PAPERCUSP_INTEGRATION_ROOT;
    process.env.PAPERCUSP_INTEGRATION_ROOT = PINNED_ROOT;
  });

  afterEach(() => {
    if (savedRootForStaleness === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
    else process.env.PAPERCUSP_INTEGRATION_ROOT = savedRootForStaleness;
  });

  // CALIBRATION: proves the pin above is actually load-bearing. If the resolver ever stops
  // consulting the env pin, this fails LOUDLY here rather than letting the two cases below
  // start depending on the ambient checkout name again without anyone noticing.
  it('the env pin is what resolves the root (premise of the two persistence cases below)', () => {
    expect(resolveIntegrationRoot(process.env, '/tmp/papercusp-checkpoint/packages/operator-core')).toBe(PINNED_ROOT);
  });

  it('measureCandidateStaleness reads the commit time and the distance behind tip', async () => {
    const out = await measureCandidateStaleness('/repo', 'deadbeefcafe', stalenessRunner('2026-08-02T02:27:59Z', '86'));
    expect(out.candidateCommittedAt).toBe('2026-08-02T02:27:59Z');
    expect(out.commitsBehindTip).toBe(86);
  });

  it('counts commits reachable from staging but NOT the candidate (the `<candidate>..staging` direction)', async () => {
    const seen: string[][] = [];
    const spy: GitCheckRunner = async (_root, args) => {
      seen.push(args);
      return { ok: true, stdout: args[0] === 'log' ? '2026-08-02T02:27:59Z' : '5' };
    };
    await measureCandidateStaleness('/repo', 'deadbeefcafe', spy);
    // Direction matters: `staging..<candidate>` would answer the opposite question and report
    // 0 for exactly the ancient candidates this exists to flag.
    expect(seen).toContainEqual(['rev-list', '--count', 'deadbeefcafe..staging']);
  });

  it('does not fossilize a fresh verdict bound to an admitted detached repair head', async () => {
    const frozenCandidate = 'a'.repeat(40);
    const repairHead = 'c'.repeat(40);
    const repairQueue = {
      schemaVersion: 3 as const,
      phase: 'awaiting-fixer' as const,
      signature: [
        {
          kind: 'test-file' as const,
          id: 'pkgA/foo.test.ts',
          recipe: 'npm run test:file -- pkgA/foo.test.ts',
          admittedRound: 1,
          measuredHead: repairHead,
        },
      ],
      candidate: frozenCandidate,
      base: null,
      repairHead,
      attempts: 0,
      openedAtMs: Date.now() - 1_000,
      updatedAtMs: Date.now(),
      fixerSpawnId: null,
      failingTests: ['pkgA/foo.test.ts'],
    };
    seededGh = { consecutiveReds: 0, lastGreenAt: Date.now() };
    seededRepairQueue = repairQueue;
    let gitCalls = 0;
    const detachedHeadRunner: GitCheckRunner = async () => {
      gitCalls++;
      // Admission-created heads have historically carried this epoch-like timestamp. The
      // guard must keep it out of the freshness snapshot even if git can read it.
      return { ok: true, stdout: '2000-01-01T00:00:00Z' };
    };

    await trackGateStall(
      ctx,
      'not-green',
      repairHead,
      ['pkgA/foo.test.ts'],
      null,
      undefined,
      null,
      detachedHeadRunner,
      { repairQueue },
    );

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(gitCalls).toBe(0);
    expect(written!.candidateCommittedAt).toBeNull();
    expect(written!.commitsBehindTip).toBeNull();
    expect(written!.observedCandidate).toBe(repairHead.slice(0, 12));
  });

  it('still measures a queue whose repair head is the original tip candidate', async () => {
    const candidate = 'd'.repeat(40);
    const repairQueue = {
      schemaVersion: 3 as const,
      phase: 'awaiting-fixer' as const,
      signature: [
        {
          kind: 'test-file' as const,
          id: 'pkgA/foo.test.ts',
          recipe: 'npm run test:file -- pkgA/foo.test.ts',
          admittedRound: 1,
          measuredHead: candidate,
        },
      ],
      candidate,
      base: null,
      repairHead: candidate,
      attempts: 0,
      openedAtMs: Date.now() - 1_000,
      updatedAtMs: Date.now(),
      fixerSpawnId: null,
      failingTests: ['pkgA/foo.test.ts'],
    };
    seededGh = { consecutiveReds: 0, lastGreenAt: Date.now() };
    seededRepairQueue = repairQueue;
    const seen: string[][] = [];
    const tipRunner: GitCheckRunner = async (_root, args) => {
      seen.push(args);
      return { ok: true, stdout: args[0] === 'log' ? '2026-09-08T20:00:00Z' : '7' };
    };

    await trackGateStall(
      ctx,
      'not-green',
      candidate,
      ['pkgA/foo.test.ts'],
      null,
      undefined,
      null,
      tipRunner,
      { repairQueue },
    );

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(seen).toHaveLength(2);
    expect(written!.candidateCommittedAt).toBe('2026-09-08T20:00:00Z');
    expect(written!.commitsBehindTip).toBe(7);
  });

  it('is FAIL-SAFE — a git error yields nulls rather than throwing', async () => {
    const out = await measureCandidateStaleness('/repo', 'deadbeefcafe', stalenessRunner(null, null));
    expect(out.candidateCommittedAt).toBeNull();
    expect(out.commitsBehindTip).toBeNull();
  });

  it('reports a null distance when the count is unparseable, never NaN', async () => {
    const out = await measureCandidateStaleness(
      '/repo',
      'deadbeefcafe',
      stalenessRunner('2026-08-02T02:27:59Z', 'not-a-number'),
    );
    // NaN would serialize into the jsonb blob as `null` anyway, but via a route that also
    // makes arithmetic on the field silently wrong — reject it at the source.
    expect(out.commitsBehindTip).toBeNull();
    expect(out.candidateCommittedAt).toBe('2026-08-02T02:27:59Z');
  });

  it('⭐ persists candidateCommittedAt + commitsBehindTip on a RED tick (the branch that misleads)', async () => {
    seededGh = { consecutiveReds: 1, lastGreenAt: Date.now() - 60_000 };

    await trackGateStall(
      ctx,
      'not-green',
      'bb054adbccf5',
      ['pkgA/foo.test.ts'],
      null,
      undefined,
      null,
      stalenessRunner('2026-08-02T02:27:59Z', '86'),
    );

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.candidateCommittedAt).toBe('2026-08-02T02:27:59Z');
    expect(written!.commitsBehindTip).toBe(86);
    // The staleness must sit alongside the verdict it qualifies, not replace it.
    expect(written!.observedCandidate).toBe('bb054adbccf5');
    expect(written!.failingTests).toEqual(['pkgA/foo.test.ts']);
  });

  it('carries the fields through a GREEN/reset tick too (the whole-object replace must not drop them)', async () => {
    seededGh = { consecutiveReds: 5, stallAlerted: true, lastGreenAt: Date.now() - 60_000 };

    await trackGateStall(
      ctx,
      'advanced',
      'bb054adbccf5',
      [],
      null,
      undefined,
      null,
      stalenessRunner('2026-08-02T02:27:59Z', '3'),
    );

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    // EI-7472: gate_health is REPLACED wholesale on every write, so a field present only in
    // the red branch silently vanishes the moment the gate recovers.
    expect(written).toHaveProperty('candidateCommittedAt');
    expect(written).toHaveProperty('commitsBehindTip');
    expect(written!.commitsBehindTip).toBe(3);
  });

  it('records nulls and makes NO git call when the verdict carries no candidate', async () => {
    seededGh = { consecutiveReds: 1, lastGreenAt: Date.now() - 60_000 };
    let called = 0;
    const counting: GitCheckRunner = async () => {
      called++;
      return { ok: true, stdout: '1' };
    };

    await trackGateStall(ctx, 'not-green', undefined, undefined, null, undefined, null, counting);

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.candidateCommittedAt).toBeNull();
    expect(written!.commitsBehindTip).toBeNull();
    expect(called).toBe(0);
  });
});

/**
 * EI-19405864032365760 regression: a `migrations-pending` preflight ABORT must be RECORDED
 * (so every read surface can say "no verdict was rendered") while still not COUNTING as a red.
 *
 * Those two are different claims, and collapsing them is the bug: `classifyGateStallStatus`
 * correctly returns 'noop' (a tick that judged no code is not evidence of a broken build), but
 * the noop branch then returned without writing ANYTHING — leaving `consecutiveReds`,
 * `observedCandidate` and `failingTests` frozen on the PREVIOUS verdict. Every consumer kept
 * rendering that stale red as current. Measured live 2026-08-03: ~2.5h of a fleet being told
 * "Gate is RED — the reds are yours to fix" and chasing unrelated test files while the real
 * blocker was one migration failing to apply.
 */
describe('trackGateStall records an inconclusive ABORT without counting it as a red (EI-19405864032365760)', () => {
  /** The abort write is path-scoped (`jsonb_set(… '{gate_health,inconclusive}' …)`), NOT the
   *  whole-key `metadata || {gate_health: …}` replace — that distinction is the point (it cannot
   *  shadow a concurrent counter write), so it needs its own capture. */
  function lastInconclusiveWrite(): Record<string, unknown> | null {
    for (let i = calls.length - 1; i >= 0; i--) {
      const c = calls[i];
      if (/jsonb_set/i.test(c.query) && /gate_health,inconclusive/.test(c.query) && typeof c.params[1] === 'string') {
        return JSON.parse(c.params[1] as string) as Record<string, unknown>;
      }
    }
    return null;
  }

  it('⭐ records status + candidate + the pending-migration detail on a migrations-pending abort', async () => {
    seededGh = {
      consecutiveReds: 3,
      stallAlerted: true,
      failingTests: ['pkgA/old.test.ts'],
      observedCandidate: 'oldcandidat',
    };

    await trackGateStall(
      ctx,
      'migrations-pending',
      'deadbeefcafe1234',
      undefined,
      null,
      undefined,
      '727-widen-vectors.sql: null value in column "vector"',
    );

    const inc = lastInconclusiveWrite();
    // The bug: before this fix the noop branch returned early and wrote nothing at all.
    expect(inc).not.toBeNull();
    expect(inc!.status).toBe('migrations-pending');
    expect(inc!.candidate).toBe('deadbeefcafe');
    // The detail is the ONLY place the blocking migration is named — a reader who cannot see it
    // has no path from "main is stuck" to "migration 727 is failing".
    expect(inc!.detail).toContain('727-widen-vectors.sql');
    expect(typeof inc!.observedAtMs).toBe('number');
    const write = [...calls].reverse().find((call) => /gate_health,inconclusive/.test(call.query));
    expect(write?.query).toContain('{gate_health,failingTestsMeasured}');
    expect(write?.query).toContain("'false'::jsonb");
  });

  it('⭐ leaves the red counters completely untouched — the abort is recorded, never counted', async () => {
    seededGh = { consecutiveReds: 3, stallAlerted: true, lastGreenAt: Date.now() - 60_000 };

    await trackGateStall(ctx, 'migrations-pending', 'deadbeefcafe1234', undefined, null, undefined, 'pending: 727');

    // EI-2615 / EI-18757975681519069 hold: no whole-key gate_health write, so no
    // consecutiveReds increment, no firstRedAt, no stall escalation.
    expect(lastGateHealthWrite()).toBeNull();
    expect(calls.some((c) => /harness_escalations/i.test(c.query))).toBe(false);
  });

  it('⭐ writes NOTHING for skipped-locked — a peer run is producing the real verdict (EI-2615)', async () => {
    // Deliberately NOT widened to the whole noop class: there a peer run IS in flight and about
    // to write the real verdict, which is precisely the write EI-2615 proved must not be raced.
    seededGh = { consecutiveReds: 2, stallAlerted: false };

    await trackGateStall(
      ctx,
      'skipped-locked',
      'deadbeefcafe1234',
      undefined,
      null,
      undefined,
      'a peer holds the lock',
    );

    expect(lastInconclusiveWrite()).toBeNull();
    expect(lastGateHealthWrite()).toBeNull();
  });

  it('⭐ a subsequent RED verdict clears the recorded abort (it superseded it)', async () => {
    seededGh = {
      consecutiveReds: 0,
      stallAlerted: false,
      lastGreenAt: Date.now(),
      inconclusive: { status: 'migrations-pending' },
    };

    await trackGateStall(ctx, 'not-green', 'cafebabe1234', ['pkgA/foo.test.ts']);

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    // Explicit null, not merely absent: a stale abort note outliving the verdict that
    // superseded it is the same class of bug as a stale failingTests list (EI-7505).
    expect(written!.inconclusive).toBeNull();
    expect(written!.consecutiveReds).toBe(1);
    expect(written!.failingTestsMeasured).toBe(true);
  });

  it('⭐ a subsequent GREEN verdict clears the recorded abort', async () => {
    seededGh = { consecutiveReds: 2, stallAlerted: false, inconclusive: { status: 'migrations-pending' } };

    await trackGateStall(ctx, 'advanced', 'cafebabe1234');

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.inconclusive).toBeNull();
    expect(written!.consecutiveReds).toBe(0);
    expect(written!.failingTestsMeasured).toBe(true);
  });
});

/**
 * The gate must survive running inside its OWN checkout.
 *
 * `resolveIntegrationRoot` is fail-CLOSED by design: it throws when the cwd-derived root is a
 * release/checkpoint checkout, so a gate/deploy run can never silently act on the wrong tree
 * (EI-20263854732193595). But `trackGateStall`'s candidate-staleness step passed
 * `integrationRoot()` as a call ARGUMENT — a SYNCHRONOUS throw, evaluated before the promise
 * its `.catch()` guards ever exists — so the documented "any git error yields nulls rather
 * than throwing" contract could not apply to it.
 *
 * That combination red-pinned the gate on its own suite: vitest runs operator-core with cwd
 * `<tree>/packages/operator-core`, so inside `…/papercusp-checkpoint` the `../..` fallback
 * resolves to the checkpoint checkout and the resolver refuses — failing every test here that
 * passes a candidate, in the one tree where green-checkpoint actually executes them.
 *
 * These pin the CONTRACT (a health tick still records, with null staleness) rather than the
 * call shape, so any future refactor that puts a throw back outside the fail-safe fails here.
 */
describe('trackGateStall survives an unresolvable integration root (gate running in its own checkout)', () => {
  const CHECKPOINT_CWD = '/tmp/papercusp-checkpoint/packages/operator-core';
  let cwdSpy: ReturnType<typeof vi.spyOn> | null = null;
  let savedRoot: string | undefined;

  beforeEach(() => {
    savedRoot = process.env.PAPERCUSP_INTEGRATION_ROOT;
    // The explicit env pin short-circuits the guard — clear it so the cwd fallback is what runs.
    delete process.env.PAPERCUSP_INTEGRATION_ROOT;
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(CHECKPOINT_CWD);
  });

  afterEach(() => {
    cwdSpy?.mockRestore();
    cwdSpy = null;
    if (savedRoot === undefined) delete process.env.PAPERCUSP_INTEGRATION_ROOT;
    else process.env.PAPERCUSP_INTEGRATION_ROOT = savedRoot;
  });

  // CALIBRATION: proves the premise. Without this, a guard that stopped refusing would make
  // every assertion below pass vacuously — the test would still be green while testing nothing.
  it('the guard really does refuse this cwd (premise of the tests below)', () => {
    expect(() => resolveIntegrationRoot(process.env, process.cwd())).toThrow(/refusing to gate/);
  });

  it('⭐ records a RED tick instead of throwing, with staleness degraded to nulls', async () => {
    seededGh = { consecutiveReds: 0, stallAlerted: false };

    await expect(trackGateStall(ctx, 'not-green', 'cafebabe1234', ['pkgA/foo.test.ts'])).resolves.not.toThrow();

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.consecutiveReds).toBe(1);
    // The tick is recorded WITHOUT the optional diagnostic — never at the cost of the tick.
    expect(written!.candidateCommittedAt).toBeNull();
    expect(written!.commitsBehindTip).toBeNull();
  });

  // CONTROL (permanent, pure): the defect was never about git or about the guard — it was the
  // CALL SHAPE. A synchronous throw in an argument happens before the callee returns a promise,
  // so the callee's own `.catch()` cannot see it. Kept here so the fix's shape is falsifiable
  // without mutating the shared tree: revert the call sites and the ⭐ tests above go red.
  it('control: a sync throw in an ARGUMENT escapes that call’s own .catch()', async () => {
    const refuse = (): string => {
      throw new Error('refusing to gate /tmp/papercusp-checkpoint');
    };
    const measure = async (_root: string): Promise<string> => 'measured';

    // OLD shape — `.catch()` is attached to a promise that is never created.
    await expect((async () => measure(refuse()).catch(() => 'fallback'))()).rejects.toThrow(/refusing to gate/);

    // FIXED shape — resolve the root first, then decide; the fallback is reachable.
    let root: string | null;
    try {
      root = refuse();
    } catch {
      root = null;
    }
    await expect((async () => (root ? measure(root).catch(() => 'fallback') : 'fallback'))()).resolves.toBe('fallback');
  });

  it('⭐ records a GREEN tick instead of throwing', async () => {
    seededGh = { consecutiveReds: 3, stallAlerted: false };

    await expect(trackGateStall(ctx, 'advanced', 'cafebabe1234')).resolves.not.toThrow();

    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.consecutiveReds).toBe(0);
  });
});

/**
 * EI-20706962612084953: the `reset` class holds TWO populations, and only one of them is green.
 * `classifyGateStallStatus(status, pinMoved)` sends a NOT-GREEN verdict here whenever the release
 * pin moved — deliberately, because a moved pin proves `main` is advancing and the "main is
 * frozen" stall streak is therefore not real. But the blob written for it was the FULL green
 * signature: consecutiveReds 0, firstRedAt null, failingTests [], lastGreenAt = now, and no field
 * marking it apart from a real green. Every surface that answers "is the gate green?" off
 * gate_health therefore answered GREEN for a run that recorded not-green, and the stall detectors
 * keyed on lastGreenAt / consecutiveReds were suppressed for exactly that run.
 *
 * These assert the SPLIT: the stall streak still resets (that is the branch's legitimate job),
 * while nothing in the blob claims a green that did not happen.
 */
describe('EI-20706962612084953: a pin-moved NOT-GREEN tick must not write a GREEN signature', () => {
  /** A last-green far enough in the past that "carried" vs "stamped now" cannot be confused. */
  const OLD_GREEN = 1_600_000_000_000;
  const MOVED_FROM = 'bbbbbbbbbbbb';
  const LAST_MAIN = 'aaaaaaaaaaaa';

  it('⭐ CARRIES lastGreenAt instead of stamping it — the gate did not green', async () => {
    seededGh = { consecutiveReds: 2, lastGreenAt: OLD_GREEN, lastMainPin: LAST_MAIN, lastFrom: LAST_MAIN };

    await trackGateStall(ctx, 'not-green', 'd6fee86480b0', ['apps/api/src/stats/stats.module.test.ts'], MOVED_FROM);

    const w = lastGateHealthWrite();
    expect(w).not.toBeNull();
    // the branch's legitimate purpose is PRESERVED — main is advancing, so the stall streak resets
    expect(w!.consecutiveReds).toBe(0);
    expect(w!.firstRedAt).toBeNull();
    // ...but the age of the last REAL green must keep running; that age is what `verdictStale` measures
    expect(w!.lastGreenAt).toBe(OLD_GREEN);
  });

  it('⭐ marks the verdict explicitly, so a reader never has to infer it from lastGreenAt', async () => {
    seededGh = { lastGreenAt: OLD_GREEN, lastMainPin: LAST_MAIN };

    await trackGateStall(ctx, 'not-green', 'd6fee86480b0', ['x.test.ts'], MOVED_FROM);

    expect(lastGateHealthWrite()!.lastVerdict).toBe('not-green');
  });

  it('⭐ keeps the run’s real failing tests rather than clearing them as a recovery', async () => {
    seededGh = { lastGreenAt: OLD_GREEN, lastMainPin: LAST_MAIN };

    await trackGateStall(ctx, 'not-green', 'd6fee86480b0', ['a.test.ts', 'b.test.ts'], MOVED_FROM);

    expect(lastGateHealthWrite()!.failingTests).toEqual(['a.test.ts', 'b.test.ts']);
  });

  it('⭐ carries stallAlerted + watchdogAlerted — a not-green tick is not a recovery', async () => {
    // Both flags are recovery-cleared on a real green. Clearing `stallAlerted` here would ALSO
    // strand the open red-streak condition: the later genuine green reads it false, broadcasts no
    // resolve, and leaks a permanently-open incident item (the D-011 leak).
    seededGh = { stallAlerted: true, watchdogAlerted: true, lastGreenAt: OLD_GREEN, lastMainPin: LAST_MAIN };

    await trackGateStall(ctx, 'not-green', 'd6fee86480b0', ['x.test.ts'], MOVED_FROM);

    const w = lastGateHealthWrite();
    expect(w!.stallAlerted).toBe(true);
    expect(w!.watchdogAlerted).toBe(true);
  });

  it('⭐ broadcasts NO all-clear — a moved pin is not a green verdict', async () => {
    seededGh = { stallAlerted: true, lastGreenAt: OLD_GREEN, lastMainPin: LAST_MAIN };

    await trackGateStall(ctx, 'not-green', 'd6fee86480b0', ['x.test.ts'], MOVED_FROM);

    // the broadcast SAYS "GREEN again … the earlier red-gate alarm is stale" and SETTLES the
    // owning work-item, so firing it here is a false all-clear on a still-open red episode
    expect(broadcastSevereEventResolved).not.toHaveBeenCalled();
  });

  it('CONTROL: a genuinely GREEN tick still writes the full green signature and DOES all-clear', async () => {
    // Calibration — without this, every assertion above would pass just as happily against a
    // build that had broken the green path outright.
    seededGh = {
      consecutiveReds: 2,
      stallAlerted: true,
      watchdogAlerted: true,
      lastGreenAt: OLD_GREEN,
      lastMainPin: LAST_MAIN,
      failingTests: ['stale.test.ts'],
    };

    await trackGateStall(ctx, 'advanced', 'cafebabe1234', [], MOVED_FROM);

    const w = lastGateHealthWrite();
    expect(w!.consecutiveReds).toBe(0);
    expect(w!.lastVerdict).toBe('green');
    expect(w!.lastGreenAt).not.toBe(OLD_GREEN);
    expect(w!.failingTests).toEqual([]);
    expect(w!.watchdogAlerted).toBe(false);
    expect(w!.stallAlerted).toBe(false);
    expect(broadcastSevereEventResolved).toHaveBeenCalled();
  });
});

/**
 * EI-20706962612084953 (the root cause of how OFTEN the above fired): `pinMoved` compared the
 * live pin against `lastFrom` — the pin the previous run STARTED from, i.e. the pre-fast-forward
 * value. After any 'advanced' run, `main` sits at the candidate while `lastFrom` holds the sha it
 * advanced FROM, so the very next tick saw a difference and declared `pinMoved` for the routine's
 * OWN advance. Consequence: the first red after a green was systematically classified 'reset' —
 * the single most important red to surface was the one that could not be.
 *
 * `lastMainPin` records where main was LEFT, so only a genuinely EXTERNAL advance moves it.
 * `lastFrom` is deliberately untouched: gate-verdict-freshness Rule 1 needs the pre-FF value.
 */
describe('EI-20706962612084953: lastMainPin stops the routine’s OWN advance reading as a moved pin', () => {
  it('⭐ an advanced tick records where main ENDED (the candidate), not where it started', async () => {
    seededGh = { lastMainPin: 'aaaaaaaaaaaa' };

    await trackGateStall(ctx, 'advanced', 'cafebabe1234', [], 'aaaaaaaaaaaa');

    const w = lastGateHealthWrite();
    expect(w!.lastMainPin).toBe('cafebabe1234');
    // `lastFrom` keeps its own contract — the pin as observed AT verdict time (pre-FF)
    expect(w!.lastFrom).toBe('aaaaaaaaaaaa');
  });

  it('⭐ the red that FOLLOWS a green is COUNTED, not masked as a reset', async () => {
    // main sits where the last green left it; this run judges a new candidate and fails.
    seededGh = { consecutiveReds: 0, lastMainPin: 'cafebabe1234', lastFrom: 'aaaaaaaaaaaa' };

    await trackGateStall(ctx, 'not-green', 'deadbeef5678', ['t.test.ts'], 'cafebabe1234');

    const w = lastGateHealthWrite();
    expect(w!.consecutiveReds).toBe(1);
    expect(w!.lastVerdict).toBe('not-green');
    expect(w!.failingTests).toEqual(['t.test.ts']);
    // a red leaves main exactly where it found it
    expect(w!.lastMainPin).toBe('cafebabe1234');
  });

  it('a genuinely EXTERNAL advance still resets the streak (the starvation case this branch exists for)', async () => {
    // Only ROUTINE-invoked runs write gate_health, so a manual/other-lineage FF shows up here as
    // a live pin that matches NEITHER recorded value. That is still hard evidence main is flowing.
    seededGh = { consecutiveReds: 4, lastMainPin: 'aaaaaaaaaaaa', lastFrom: 'aaaaaaaaaaaa' };

    await trackGateStall(ctx, 'not-green', 'deadbeef5678', ['t.test.ts'], 'zzzzzzzzzzzz');

    expect(lastGateHealthWrite()!.consecutiveReds).toBe(0);
  });

  it('a legacy blob with no lastMainPin falls back to lastFrom (degrades to the previous behaviour)', async () => {
    // Written before this field existed: a missing pin must not read as "main never moved".
    seededGh = { consecutiveReds: 4, lastFrom: 'aaaaaaaaaaaa' };

    await trackGateStall(ctx, 'not-green', 'deadbeef5678', ['t.test.ts'], 'bbbbbbbbbbbb');

    expect(lastGateHealthWrite()!.consecutiveReds).toBe(0);
  });

  it('an advanced-prefix tick records a null pin rather than inventing one', async () => {
    // main moved to the longest green PREFIX — a sha this function is never handed.
    seededGh = { lastMainPin: 'aaaaaaaaaaaa' };

    await trackGateStall(ctx, 'advanced-prefix', 'cafebabe1234', [], 'aaaaaaaaaaaa');

    expect(lastGateHealthWrite()!.lastMainPin).toBeNull();
  });
});

/**
 * EI-21462211894072863 — a tick that produced NO verdict must not be counted as a RED.
 *
 * ## The defect, as measured
 *
 * A green-checkpoint run that exits without publishing a parseable result marker judged no code
 * at all. Until this change it arrived as status 'error' and fell through to the 'red' class, so
 * every such tick incremented `consecutiveReds` — the counter that freezes `main`, dispatches
 * release-fixers, and renders as "Gate is RED (N consecutive) — the reds are yours to fix".
 *
 * Observed live on papercusp 2026-08-25: scheduled run 8104 exited exitCode=1 with no marker, and
 * `consecutiveReds` reached 42 while the last REAL verdict predated the last fire by 5.7h. The
 * gate was WEDGED, not red, and the failing-test list every reader was offered had been named by
 * a run many fires earlier.
 *
 * ## Why the counting must survive
 *
 * The obvious fix — make 'error' a plain 'noop' — is explicitly guarded against (see the control
 * in release-actions.test.ts) and the guard is right: 'error' is the UNKNOWN-cause bucket, and
 * silencing it is how a crashing gate freezes `main` with nobody told. So the split is not
 * counted-vs-uncounted but WHICH COUNTER, and these tests pin both halves together — a "fix" that
 * removed the false red by going quiet fails here just as loudly as the original defect.
 */
describe('EI-21462211894072863: a verdict-less tick counts as WEDGED, never as a red', () => {
  const stallReds = releaseCheckpointConfig().stallReds;

  /** The no-verdict streak UPDATE, as captured (null when the tick never issued one). */
  const noVerdictBump = (): { query: string; params: unknown[] } | null =>
    calls.find((c) => /consecutiveNoVerdict/.test(c.query) && /RETURNING/i.test(c.query)) ?? null;

  it('⭐ leaves consecutiveReds ALONE — the counter keeps describing the last run that judged code', async () => {
    // A real red streak already stands. The wedge must not deepen it: those 4 reds describe a
    // run that actually judged code, and this tick judged none.
    seededGh = { consecutiveReds: 4, firstRedAt: 1_000, failingTests: ['pkgA/real.test.ts'], lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'error');

    // The whole-blob write is the one that would have carried a 5. It must not happen at all:
    // this branch returns before it, precisely so it cannot shadow a peer run's real verdict.
    expect(lastGateHealthWrite()).toBeNull();
    expect(noVerdictBump()).not.toBeNull();
  });

  it('⭐ counts the tick in its OWN streak, so a crashing gate never goes silent', async () => {
    seededGh = { consecutiveReds: 0, consecutiveNoVerdict: 1, lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'error');

    const bump = noVerdictBump();
    expect(bump).not.toBeNull();
    // Written to the leaf PATH, never the whole `{gate_health}` key: this branch runs
    // concurrently with a peer run's real verdict write, and a whole-key replace here is the
    // EI-7472 hazard that would shadow it.
    expect(bump!.query).toMatch(/jsonb_set/);
    expect(bump!.query).not.toMatch(/'\{gate_health\}'/);
    expect(bump!.params[0]).toBe('test-slug');
  });

  it('EI-22642378999251872: persistent disk-headroom uses the same counted wedge path and escalation', async () => {
    seededGh = {
      consecutiveReds: 3,
      consecutiveNoVerdict: stallReds - 1,
      noVerdictAlerted: false,
      lastGreenAt: Date.now(),
    };

    await trackGateStall(
      ctx,
      'disk-headroom',
      'deadbeefcafe',
      undefined,
      undefined,
      undefined,
      '/tmp remains below the critical write floor after bounded fleet-log GC',
    );

    expect(lastGateHealthWrite()).toBeNull();
    expect(noVerdictBump()).not.toBeNull();
    expect(broadcastSevereEvent).toHaveBeenCalledTimes(1);
    const event = broadcastSevereEvent.mock.calls[0]![0]!;
    expect(String(event.summary)).toContain('latest: disk-headroom');
    expect(String(event.summary)).toMatch(/NOT a red build/i);
    expect(String(event.body)).toContain('standing preflight condition');
  });

  it('⭐ escalates at the SAME threshold a red streak would — loudness is preserved exactly', async () => {
    seededGh = { consecutiveNoVerdict: stallReds - 1, noVerdictAlerted: false, lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'error');

    expect(broadcastSevereEvent).toHaveBeenCalledTimes(1);
    const ev = broadcastSevereEvent.mock.calls[0]![0]!;
    // The alarm must say WEDGED and must not invite test triage — the response this whole
    // change exists to prevent.
    expect(String(ev.summary)).toMatch(/WEDGED/);
    expect(String(ev.summary)).toMatch(/NOT a red build/i);
    expect(String(ev.body)).toMatch(/DO NOT triage/i);
    // Apparatus repair owns its own condition; it must never mint the code-red item.
    expect(ev.conditionKey).toBe('alarm:release-gate-no-verdict:test-slug');
    expect(ev.conditionKey).not.toBe(gateRedStreakConditionKey('test-slug'));
  });

  it('does NOT escalate below the threshold, and only ONCE per episode', async () => {
    seededGh = { consecutiveNoVerdict: 0, lastGreenAt: Date.now() };
    await trackGateStall(ctx, 'error');
    expect(broadcastSevereEvent).not.toHaveBeenCalled();

    // Already alarmed for this episode: a deeper wedge must not re-spam the fleet, matching
    // `stallAlerted`'s transition-only contract on the red path.
    calls.length = 0;
    broadcastSevereEvent.mockClear();
    seededGh = { consecutiveNoVerdict: stallReds + 2, noVerdictAlerted: true, lastGreenAt: Date.now() };
    await trackGateStall(ctx, 'error');
    expect(broadcastSevereEvent).not.toHaveBeenCalled();
  });

  it('⭐ a real verdict of EITHER colour ends the streak — that is what "consecutive" means', async () => {
    for (const status of ['not-green', 'advanced']) {
      calls.length = 0;
      seededGh = { consecutiveReds: 2, consecutiveNoVerdict: 7, noVerdictAlerted: true, lastGreenAt: Date.now() };

      await trackGateStall(ctx, status, 'deadbeefcafe', []);

      const written = lastGateHealthWrite();
      expect(written).not.toBeNull();
      // Stated outright rather than left to the whole-key replace, so a later change to a
      // MERGING write cannot silently resurrect a dead streak or its one-shot flag.
      expect(written!.consecutiveNoVerdict).toBe(0);
      expect(written!.noVerdictAlerted).toBe(false);
      expect(resolveCondition).toHaveBeenCalledWith(expect.objectContaining({
        conditionKey: 'alarm:release-gate-no-verdict:test-slug',
      }));
    }
  });

  it.each(['up-to-date', 'skipped-locked', 'error', 'disk-headroom', 'repair-in-progress'])(
    'does not resolve the apparatus episode on %s without a measured verdict', async (status) => {
      seededGh = { consecutiveNoVerdict: 7, noVerdictAlerted: true, lastGreenAt: Date.now() };
      await trackGateStall(ctx, status);
      expect(resolveCondition.mock.calls.map(([input]) => input.conditionKey))
        .not.toContain('alarm:release-gate-no-verdict:test-slug');
    },
  );

  it('a moved release pin still wins — the wedge branch never runs', async () => {
    // `pinMoved` is hard evidence the pipeline is flowing, and it outranks every status.
    seededGh = { consecutiveReds: 3, consecutiveNoVerdict: 5, lastMainPin: 'aaaaaaaaaaaa' };

    await trackGateStall(ctx, 'error', 'deadbeef5678', [], 'bbbbbbbbbbbb');

    expect(noVerdictBump()).toBeNull();
    expect(lastGateHealthWrite()!.consecutiveReds).toBe(0);
  });

  it('fails SAFE: a broken streak write degrades to invisible, never to a wrong verdict', async () => {
    seededGh = { consecutiveReds: 4, lastGreenAt: Date.now() };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unsafe = vi.spyOn(fakeSql, 'unsafe');
    unsafe.mockImplementation((q: string, p: unknown[] = []) => {
      calls.push({ query: q, params: p });
      if (/SELECT\s+metadata->'gate_health'/i.test(q)) return Promise.resolve([{ gh: seededGh }]);
      if (/consecutiveNoVerdict/.test(q)) return Promise.reject(new Error('pg down'));
      return Promise.resolve({ count: 0 });
    });

    await expect(trackGateStall(ctx, 'error')).resolves.not.toThrow();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no-verdict streak record failed'));
    // The critical half: even with the counter write dead, no red was fabricated.
    expect(lastGateHealthWrite()).toBeNull();
    unsafe.mockRestore();
    warn.mockRestore();
  });
});

/**
 * WI-42116 (ruling green-main-fast-2026-08-25 D-022): the stall alarm must ESCALATE with the
 * stall, not decay to silence after one alert.
 *
 * ## The measured defect
 * The old edge was `(stalledByCount || stalledByAge) && !stallAlerted`, and `stallAlerted` is
 * carried on every red — so the alarm had exactly ONE rung. papercusp 2026-08-26:
 * `consecutiveReds: 43`, last green 5.12 days earlier, ONE alert raised on day one. Reds #4–#43
 * were silent, which is why a livelocked gate read as "already alerted, someone's on it".
 *
 * ## Why these are WIRING tests, not decision tests
 * `stall-escalation-ladder.test.ts` already pins the decision function's arithmetic, including a
 * permanent naive-implementation control. That suite would pass identically if the ladder were
 * never called — which was the state this file's own P-005 block warns about. What can actually
 * be wrong is HERE: which leg re-fires, which stays one-shot, and whether the marks survive the
 * three separate `gate_health` write paths (red / green / pin-moved).
 *
 * ⚠ The two legs have DIFFERENT cadences on purpose. Re-notifying the human is the fix;
 * re-broadcasting the condition or re-writing the escalation row would be a REGRESSION
 * (EI-7472's fleet re-spam, and WI-6228's second owning work-item for one stall). Every test
 * below that asserts a re-notify also asserts those two stayed silent — decoupling them is the
 * whole change, so a test that only checked the notify could not tell the fix from the bug.
 */
describe('WI-42116: the gate-stall alarm is a bounded LADDER, not a one-shot', () => {
  const written = (): Record<string, unknown> => {
    const w = lastGateHealthWrite();
    expect(w).not.toBeNull();
    return w!;
  };
  const stallReds = releaseCheckpointConfig().stallReds;
  const stallAgeMs = releaseCheckpointConfig().stallAgeMs;
  /** The durable escalation-row UPSERT — a one-shot leg, so its ABSENCE is the assertion. */
  const escalationWrites = () =>
    calls.filter((c) => /INSERT\s+INTO\s+harness_shared\.harness_escalations/i.test(c.query));
  const notifyArg = (i = 0) =>
    notifyAttentionOnce.mock.calls[i]![0] as {
      title: string;
      body: string;
      dedupeKey: string;
      data: Record<string, unknown>;
    };
  const fixerMarkWrite = () =>
    [...calls]
      .reverse()
      .find((c) => /stallAlertedAtFixerAgeMs/.test(c.query) && /stallFixerSuccessionKey/.test(c.query));
  const awaitingFixer = (over: Record<string, unknown> = {}): Record<string, unknown> => {
    const now = Date.now();
    return {
      schemaVersion: 3,
      phase: 'awaiting-fixer',
      candidate: 'a'.repeat(40),
      qualificationAttemptId: null,
      base: 'b'.repeat(40),
      repairHead: 'c'.repeat(40),
      affectedTestProofGroup: null,
      worktreePath: '/tmp/frozen-repair',
      attempts: 1,
      openedAtMs: now - 2 * FIXER_SUCCESSION_STALL_MS,
      updatedAtMs: now - FIXER_SUCCESSION_STALL_MS - 1_000,
      fixerSpawnId: 'dead-fixer',
      failingTests: ['lib/broken.test.ts'],
      ...over,
    };
  };

  it('⭐ RE-NOTIFIES at the next count rung — the deeper red that used to be silent', async () => {
    // Rung 1 (stallReds) already announced. This tick lands ON rung 2 (stallReds * 3).
    // A recent green keeps the AGE axis below its first rung, isolating the count trigger.
    seededGh = {
      consecutiveReds: stallReds * 3 - 1,
      stallAlerted: true,
      stallAlertedAtReds: stallReds,
      lastGreenAt: Date.now(),
    };

    await trackGateStall(ctx, 'not-green');

    expect(notifyAttentionOnce).toHaveBeenCalledTimes(1);
    const alert = notifyArg();
    expect(alert.data).toMatchObject({ stallAxis: 'count', stallRung: stallReds * 3, stallRungIndex: 1 });
    // The rung is IN the title: a re-escalation that reads identically to the day-one alert is
    // indistinguishable from a duplicate, and a reader who files it as one has learned nothing.
    expect(alert.title).toContain('escalation 2');
    // Per-rung idempotency at the delivery layer, for two callers racing the SAME tick.
    expect(alert.dedupeKey).toBe(`gate-stall:test-slug:count:${stallReds * 3}`);
    // ⚠ The half that makes this a fix rather than a regression — both one-shot legs held.
    expect(broadcastSevereEvent).not.toHaveBeenCalled();
    expect(escalationWrites()).toHaveLength(0);
    expect(written().stallAlertedAtReds).toBe(stallReds * 3);
  });

  it('⭐ HOLDS between rungs — a red past the threshold but below the next rung says nothing', async () => {
    // This is EI-7472's guard, stated as a test: the naive "re-alert while still red" fix
    // re-spammed the fleet ~hourly for the life of a streak. Between rungs, silence is correct.
    seededGh = {
      consecutiveReds: stallReds + 1,
      stallAlerted: true,
      stallAlertedAtReds: stallReds,
      lastGreenAt: Date.now(),
    };

    await trackGateStall(ctx, 'not-green');

    expect(notifyAttentionOnce).not.toHaveBeenCalled();
    expect(broadcastSevereEvent).not.toHaveBeenCalled();
    // The mark does not regress on a quiet tick either.
    expect(written().stallAlertedAtReds).toBe(stallReds);
  });

  it('⭐ escalates on AGE when the count axis is FROZEN — the livelocked gate this exists to catch', async () => {
    // THE load-bearing case. `carryStreak = recordOnly || alreadyCountedPending` holds
    // `consecutiveReds` FIXED on a record-only tick, so a gate whose every red is withheld as a
    // proven-stale candidate sits at one red count indefinitely while time runs on. papercusp was
    // in exactly that state. A COUNT-ONLY ladder would therefore go silent on the one gate it was
    // built for — which is why the age axis is load-bearing, not belt-and-braces.
    const CANDIDATE = '1a9e8a1f0000000000000000000000000000abcd';
    const staleRetriage = {
      classification: 'stale-candidate' as const,
      tip: '9f7c3d2e1111111111111111111111111111beef',
      detail: '2 failing file(s) PASS at tip',
    };
    seededGh = {
      consecutiveReds: stallReds + 1,
      stallAlerted: true,
      stallAlertedAtReds: stallReds + 1,
      stallAlertedAtAgeMs: stallAgeMs, // age rung 1 already announced
      lastGreenAt: Date.now() - stallAgeMs * 3.5, // past age rung 2 (stallAgeMs * 3)
    };

    await trackGateStall(ctx, 'not-green', CANDIDATE, ['a/one.test.ts'], null, staleRetriage);

    // The premise, asserted rather than assumed: this tick really did NOT advance the count.
    // Without this the test could pass through the count axis and prove nothing about age.
    expect(written().consecutiveReds).toBe(stallReds + 1);
    expect(notifyAttentionOnce).toHaveBeenCalledTimes(1);
    expect(notifyArg().data).toMatchObject({ stallAxis: 'age', stallRung: stallAgeMs * 3 });
    expect(written().stallAlertedAtAgeMs).toBe(stallAgeMs * 3);
    expect(broadcastSevereEvent).not.toHaveBeenCalled();
  });

  it('⭐ escalates a confirmed-dead awaiting-fixer queue on its OWN axis without counting a red', async () => {
    seededGh = {
      consecutiveReds: stallReds + 1,
      stallAlerted: true,
      stallAlertedAtReds: stallReds,
      lastGreenAt: Date.now(),
    };
    seededRepairQueue = awaitingFixer();

    await trackGateStall(ctx, 'repair-in-progress', 'a'.repeat(40), [], null, undefined, 'waiting on fixer');

    expect(notifyAttentionOnce).toHaveBeenCalledTimes(1);
    const alert = notifyArg();
    expect(alert.title).toContain('fixer DEAD');
    expect(alert.data).toMatchObject({
      stallAxis: 'fixer',
      stallRung: FIXER_SUCCESSION_STALL_MS,
      fixerSuccessionState: 'dead',
      fixerSpawnId: 'dead-fixer',
    });
    expect(alert.body).toContain('awaiting-fixer');
    expect(alert.body).toContain('do not start a parallel repair');
    // This is an ownership/succession alarm, never a code verdict or second owning item.
    expect(lastGateHealthWrite()).toBeNull();
    expect(broadcastSevereEvent).toHaveBeenCalledWith(expect.objectContaining({
      conditionKey: 'alarm:release-fixer-succession:test-slug',
    }));
    expect(escalationWrites()).toHaveLength(0);
    const mark = fixerMarkWrite();
    expect(mark).toBeDefined();
    expect(JSON.parse(String(mark!.params[1]))).toBe(FIXER_SUCCESSION_STALL_MS);
    expect(JSON.parse(String(mark!.params[2]))).toContain('dead-fixer');
  });

  it('⭐ alarms when no fixer materialized after the reservation window, and holds on replay', async () => {
    seededGh = { consecutiveReds: 1, stallAlerted: false, lastGreenAt: Date.now() };
    seededRepairQueue = awaitingFixer({ attempts: 0, fixerSpawnId: null });

    await trackGateStall(ctx, 'repair-in-progress');

    expect(notifyAttentionOnce).toHaveBeenCalledTimes(1);
    expect(notifyArg().title).toContain('fixer ABSENT');
    expect(notifyArg().data).toMatchObject({
      stallAxis: 'fixer',
      fixerSuccessionState: 'absent',
      fixerSpawnId: null,
    });
    const mark = fixerMarkWrite();
    expect(mark).toBeDefined();
    const priorMark = JSON.parse(String(mark!.params[1]));
    const priorKey = JSON.parse(String(mark!.params[2]));

    // Feed back the exact persisted identity/mark: the same hourly observation must hold,
    // proving the axis did not become a per-tick pager.
    calls.length = 0;
    notifyAttentionOnce.mockClear();
    seededGh = {
      consecutiveReds: 1,
      stallAlerted: false,
      lastGreenAt: Date.now(),
      stallAlertedAtFixerAgeMs: priorMark,
      stallFixerSuccessionKey: priorKey,
    };
    await trackGateStall(ctx, 'repair-in-progress');
    expect(notifyAttentionOnce).not.toHaveBeenCalled();
  });

  it('preserves the succession condition and marks when liveness cannot be read', async () => {
    seededGh = { stallAlertedAtFixerAgeMs: FIXER_SUCCESSION_STALL_MS, stallFixerSuccessionKey: 'prior-key' };
    seededRepairQueue = awaitingFixer();
    const original = fakeSql.unsafe;
    const unsafe = vi.spyOn(fakeSql, 'unsafe').mockImplementation((query, params) =>
      query.includes('sa.launcher_host') ? Promise.reject(new Error('liveness unavailable')) : original(query, params));
    try {
      await trackGateStall(ctx, 'repair-in-progress');
      expect(resolveCondition).not.toHaveBeenCalled();
      expect(broadcastSevereEvent).not.toHaveBeenCalled();
      expect(notifyAttentionOnce).not.toHaveBeenCalled();
      const mark = fixerMarkWrite()!;
      expect(JSON.parse(String(mark.params[1]))).toBe(FIXER_SUCCESSION_STALL_MS);
      expect(JSON.parse(String(mark.params[2]))).toBe('prior-key');
    } finally { unsafe.mockRestore(); }
  });

  it('does not resolve a malformed queue as measured absence', async () => {
    seededRepairQueue = { schemaVersion: 3, phase: 'awaiting-fixer' };
    await trackGateStall(ctx, 'repair-in-progress');
    expect(resolveCondition).not.toHaveBeenCalled();
  });

  it('resolves succession after a readable queue end', async () => {
    seededRepairQueue = null;
    await trackGateStall(ctx, 'repair-in-progress');
    expect(resolveCondition).toHaveBeenCalledWith(expect.objectContaining({
      conditionKey: 'alarm:release-fixer-succession:test-slug',
    }));
  });

  it('attempts owner notification even if the succession broadcast fails', async () => {
    seededGh = { consecutiveReds: 1, lastGreenAt: Date.now() };
    seededRepairQueue = awaitingFixer();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    broadcastSevereEvent.mockRejectedValueOnce(new Error('condition delivery unavailable'));
    try {
      await trackGateStall(ctx, 'repair-in-progress');
      expect(notifyAttentionOnce).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('fixer-succession condition broadcast failed'));
    } finally { warn.mockRestore(); }
  });

  it('⭐ a legacy blob (stallAlerted, no marks) does NOT re-alert for a stall already announced', async () => {
    // Back-compat is a one-time migration, not a decision re-taken hourly: seed each axis at its
    // FIRST rung so the ladder resumes at rung 2 instead of re-announcing on the deploy tick.
    seededGh = { consecutiveReds: stallReds + 1, stallAlerted: true, lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'not-green');

    expect(notifyAttentionOnce).not.toHaveBeenCalled();
    // And the seeding is PERSISTED on this quiet tick, so it happens once rather than every tick.
    expect(written().stallAlertedAtReds).toBe(stallReds);
    expect(written().stallAlertedAtAgeMs).toBe(stallAgeMs);
  });

  it('⭐ a GREEN resets the ladder to the bottom — all marks cleared', async () => {
    // The ONLY intended way back to null: the decision layer never regresses a mark, so if green
    // did not clear them the NEXT stall would resume halfway up the previous episode's ladder and
    // skip its own rung-1 alert.
    seededGh = {
      consecutiveReds: stallReds * 3,
      stallAlerted: true,
      stallAlertedAtReds: stallReds * 3,
      stallAlertedAtAgeMs: stallAgeMs * 3,
      stallAlertedAtFixerAgeMs: FIXER_SUCCESSION_STALL_MS,
      stallFixerSuccessionKey: 'old-fixer-attempt',
      lastGreenAt: Date.now() - 60_000,
    };

    await trackGateStall(ctx, 'advanced');

    expect(written().stallAlertedAtReds).toBeNull();
    expect(written().stallAlertedAtAgeMs).toBeNull();
    expect(written().stallAlertedAtFixerAgeMs).toBeNull();
    expect(written().stallFixerSuccessionKey).toBeNull();
  });

  it('⭐ opens the one-shot legs on rung 1, exactly as before — the fix changed cadence, not the edge', async () => {
    // The regression guard for the split itself: `firstRungOfEpisode` is the PRE-tick
    // `stallAlerted`, so a fresh episode must still mint its escalation row AND its condition.
    // If this ever goes quiet, the ladder has swallowed the leg that produces the ownable item.
    seededGh = { consecutiveReds: stallReds - 1, stallAlerted: false, lastGreenAt: Date.now() };

    await trackGateStall(ctx, 'not-green');

    expect(notifyAttentionOnce).toHaveBeenCalledTimes(1);
    expect(notifyArg().title).not.toContain('escalation');
    expect(broadcastSevereEvent).toHaveBeenCalledTimes(1);
    expect(broadcastSevereEvent.mock.calls[0]![0]!.oneShot).toBe(true);
    expect(escalationWrites()).toHaveLength(1);
  });

  // ── WI-42118 (D-022(d)): the CROSS-STREAK cause digest ────────────────────────────────
  // Everything else in both bodies is a snapshot of the alerting tick, so neither could say
  // whether the failing set is one unfixed break or churn. These pin that it now reaches BOTH.

  /** A `green_checkpoint` pipeline_events row, as the digest reader sees it. */
  const evt = (agoMs: number, status: string, failingTests: string[]) => ({
    status,
    detail: JSON.stringify(failingTests.length ? { failingTests } : {}),
    created_at: new Date(Date.now() - agoMs).toISOString(),
  });
  const HOUR = 3_600_000;
  const escalationBody = () => String(escalationWrites()[0]!.params[2]);

  it('⭐ carries a STABLE cause digest into the HUMAN body — the half that named no tests at all', async () => {
    seededGh = { consecutiveReds: stallReds - 1, stallAlerted: false, lastGreenAt: Date.now() - 40 * HOUR };
    seededEvents = [
      evt(2 * HOUR, 'not-green', ['lint:tsc']),
      evt(20 * HOUR, 'not-green', ['lint:tsc']),
      evt(36 * HOUR, 'not-green', ['lint:tsc']),
    ];

    await trackGateStall(ctx, 'not-green');

    const body = notifyArg().body;
    expect(body).toContain('CAUSE: STABLE');
    expect(body).toContain('lint:tsc');
    expect(body).toContain('one unfixed break');
    // Structured too, so a consumer can route on the class without parsing prose.
    expect(notifyArg().data).toMatchObject({ causeStability: 'stable', causePersistent: ['lint:tsc'] });
    // ...and the durable row carries the same verdict.
    expect(escalationBody()).toContain('CAUSE: STABLE');
    expect(JSON.parse(escalationBody()).cause).toMatchObject({ stability: 'stable', persistent: ['lint:tsc'] });
  });

  /**
   * ⭐ Most rows in a real streak are non-verdict statuses naming zero tests, and the alarm
   * must read the streak THROUGH them rather than being derailed by them.
   *
   * ⚠ Precisely what this pins, because the obvious stronger claim is false: interleaved
   * zero-test rows cannot flip STABLE to CHURNING even if the filter broke — a tick naming
   * no tests never enters the naming set (proved by the CONTROL tests in
   * `streak-cause-digest.test.ts`). What the filter protects here is the COUNT the human is
   * shown: `redTicks` must be 2, not 5. A body quoting 5 red verdicts for a streak that
   * produced 2 is the same class of over-count the ladder's `carryStreak` exists to avoid.
   */
  it('⭐ reads a stable streak through interleaved non-verdict ticks, and counts only the verdicts', async () => {
    seededGh = { consecutiveReds: stallReds - 1, stallAlerted: false, lastGreenAt: Date.now() - 40 * HOUR };
    seededEvents = [
      evt(2 * HOUR, 'not-green', ['lint:tsc']),
      evt(6 * HOUR, 'skipped-locked', []),
      evt(10 * HOUR, 'repair-in-progress', []),
      evt(14 * HOUR, 'cancelled', []),
      evt(20 * HOUR, 'not-green', ['lint:tsc']),
    ];

    await trackGateStall(ctx, 'not-green');

    expect(notifyArg().body).toContain('CAUSE: STABLE');
    expect(notifyArg().body).not.toContain('CHURNING');
    expect(notifyArg().data).toMatchObject({ causeStability: 'stable' });
    // The load-bearing assertion: 2 verdicts, not the 5 rows the window contains.
    expect(JSON.parse(escalationBody()).cause).toMatchObject({ redTicks: 2, namingTicks: 2 });
    expect(notifyArg().body).toContain('ALL 2 red verdicts');
  });

  it('⭐ says CHURNING — and says not to chase the names — when nothing is common to all reds', async () => {
    seededGh = { consecutiveReds: stallReds - 1, stallAlerted: false, lastGreenAt: Date.now() - 40 * HOUR };
    seededEvents = [
      evt(2 * HOUR, 'not-green', ['a.test.ts']),
      evt(10 * HOUR, 'not-green', ['b.test.ts']),
      evt(20 * HOUR, 'not-green', ['c.test.ts']),
    ];

    await trackGateStall(ctx, 'not-green');

    expect(notifyArg().body).toContain('CAUSE: CHURNING');
    expect(notifyArg().body).toContain('do NOT chase');
    expect(notifyArg().data).toMatchObject({ causeStability: 'churning', causePersistent: [] });
  });

  it('⭐ says the alarm is about the GATE when every red named nothing — the livelock shape', async () => {
    seededGh = { consecutiveReds: stallReds - 1, stallAlerted: false, lastGreenAt: Date.now() - 40 * HOUR };
    seededEvents = [evt(2 * HOUR, 'not-green', []), evt(10 * HOUR, 'not-green', []), evt(20 * HOUR, 'not-green', [])];

    await trackGateStall(ctx, 'not-green');

    expect(notifyArg().body).toContain('about the GATE, not the code');
    expect(notifyArg().data).toMatchObject({ causeStability: 'silent' });
  });

  /** Fail-safe + back-compat: no event history ⇒ the bodies render exactly as they did before. */
  it('renders the pre-digest bodies unchanged when no streak history is readable', async () => {
    seededGh = { consecutiveReds: stallReds - 1, stallAlerted: false, lastGreenAt: Date.now() - 40 * HOUR };
    seededEvents = [];

    await trackGateStall(ctx, 'not-green');

    expect(notifyAttentionOnce).toHaveBeenCalledTimes(1);
    expect(notifyArg().body).not.toContain('CAUSE:');
    expect(notifyArg().data.causeStability).toBeNull();
    expect(JSON.parse(escalationBody()).cause).toBeNull();
  });
});

/**
 * P-009 (gate-verdict-liveness-and-repair-reliability-2026-08-31): an `awaiting-fixer`
 * repair hold used to stamp `failingTestsMeasured:false` on EVERY tick — hours of "nothing
 * is measured" while agents chased stale failing names (D-001 loss class 4). When the CLI's
 * hold tick carries a cheap-legs measurement (CheckpointVerdict.repairTickLegs), the
 * inconclusive write must instead keep the list MEASURED: refresh exactly the measured
 * leg-shaped entries against the row's LIVE value, stamp `failingTestsMeasured` true, and
 * record head+time provenance under `gate_health.repairTickLegs`. Without a measurement the
 * historical `false` stamp must stay byte-identical.
 */
describe('P-009: an awaiting-fixer hold tick with a cheap-legs measurement stays MEASURED', () => {
  const CANDIDATE = '1a9e8a1f0000000000000000000000000000abcd';
  const tickLegs = {
    head: 'c'.repeat(40),
    atMs: 111,
    ok: false,
    failingSignatures: ['lint:tsc'],
    legs: [
      { id: 'lint:tsc', status: 'fail' as const, durationMs: 5 },
      { id: 'lint:migrations', status: 'pass' as const, durationMs: 2 },
    ],
  };

  it('writes failingTestsMeasured TRUE, refreshes the measured entries in SQL, and records provenance', async () => {
    await trackGateStall(ctx, 'repair-in-progress', CANDIDATE, undefined, null, undefined, 'held', undefined, {
      repairTickLegs: tickLegs,
    });
    const write = calls.find((c) => /failingTestsMeasured/.test(c.query) && /'true'::jsonb/.test(c.query));
    expect(write).toBeDefined();
    // provenance lands on its own gate_health path…
    expect(write!.query).toContain(`'{gate_health,repairTickLegs}'`);
    // …and the failingTests refresh merges against the row's LIVE value at UPDATE time
    // (the EI-7472 convention): measured ids filtered out, fresh failing appended.
    expect(write!.query).toContain('jsonb_array_elements_text');
    expect(write!.params[3]).toEqual(['lint:tsc', 'lint:migrations']);
    expect(JSON.parse(write!.params[4] as string)).toEqual(['lint:tsc']);
    const provenance = JSON.parse(write!.params[2] as string) as Record<string, unknown>;
    expect(provenance).toMatchObject({ head: 'c'.repeat(12), atMs: 111, ok: false, failingSignatures: ['lint:tsc'] });
    // and this tick must NOT also stamp the historical false — that is the exact staleness
    // this item exists to kill.
    const falseStamp = calls.find((c) => /failingTestsMeasured/.test(c.query) && /'false'::jsonb/.test(c.query));
    expect(falseStamp).toBeUndefined();
  });

  // WI-10002091 RECURRENCE GUARD. The provenance must carry the PER-LEG records, not just
  // the signature list. `failingSignatures` names WHICH LEG failed and never WHICH FILES, so
  // `legs[].outputTail` is the only path-bearing evidence the gate produces:
  // `repair-tick-legs-snapshot.ts` declares `legs` (documented "Bounded to 32 by the writer")
  // and `readRepairTickLegOutputs` (P-021) reads `legs[].outputTail` as "the only evidence of
  // WHICH files a lint / post-suite leg reported". The writer omitted the field entirely, so
  // that reader returned {} FOREVER and every repair manifest rendered pathless — a full day
  // of lint:tsc reds was undiagnosable from any surface.
  // NOTE the sibling assertion above uses toMatchObject, which passes with `legs` ABSENT.
  // That is exactly how this survived, so these assert the field explicitly.
  it('persists the per-leg records INCLUDING outputTail', async () => {
    const tail = 'apps/operator/lib/x.ts(1,2): error TS2322: Type X is not assignable.';
    await trackGateStall(ctx, 'repair-in-progress', CANDIDATE, undefined, null, undefined, 'held', undefined, {
      repairTickLegs: {
        ...tickLegs,
        legs: [
          { id: 'lint:tsc', status: 'fail' as const, durationMs: 5, outputTail: tail },
          { id: 'lint:migrations', status: 'pass' as const, durationMs: 2 },
        ],
      },
    });
    const write = calls.find((c) => /failingTestsMeasured/.test(c.query) && /'true'::jsonb/.test(c.query));
    const provenance = JSON.parse(write!.params[2] as string) as { legs?: Array<Record<string, unknown>> };
    expect(provenance.legs).toEqual([
      { id: 'lint:tsc', status: 'fail', durationMs: 5, outputTail: tail },
      { id: 'lint:migrations', status: 'pass', durationMs: 2 },
    ]);
  });

  it('bounds the persisted legs to 32 and FRONT-slices a long outputTail', async () => {
    const long = `first/file.ts(1,1): error TS1000${'F'.repeat(2500)}`;
    await trackGateStall(ctx, 'repair-in-progress', CANDIDATE, undefined, null, undefined, 'held', undefined, {
      repairTickLegs: {
        ...tickLegs,
        legs: Array.from({ length: 40 }, (_, i) => ({
          id: `leg:${i}`,
          status: 'fail' as const,
          durationMs: 1,
          outputTail: long,
        })),
      },
    });
    const write = calls.find((c) => /failingTestsMeasured/.test(c.query) && /'true'::jsonb/.test(c.query));
    const provenance = JSON.parse(write!.params[2] as string) as { legs: Array<{ outputTail: string }> };
    expect(provenance.legs).toHaveLength(32);
    // FRONT, not tail (WI-10002075): summarizeLegOutput puts the file names first, so
    // truncating from the end would discard exactly what this evidence exists to carry.
    expect(provenance.legs[0].outputTail).toBe(long.slice(0, 1000));
    expect(provenance.legs[0].outputTail).toContain('first/file.ts');
  });

  it('without a measurement, the hold still stamps failingTestsMeasured false (unchanged behaviour)', async () => {
    await trackGateStall(ctx, 'repair-in-progress', CANDIDATE, undefined, null, undefined, 'held');
    const write = calls.find((c) => /failingTestsMeasured/.test(c.query));
    expect(write).toBeDefined();
    expect(write!.query).toContain(`'false'::jsonb`);
    expect(write!.query).not.toContain('repairTickLegs');
  });
});

/**
 * C4 of EI-22270968007901491 (main-green-status-visible-2026-09-03): `trackGateStall`'s final
 * write REPLACED the whole `gate_health` key, so every key owned by another writer that was not
 * hand-carried through `next` (EI-7472 did that for ONE key, `watchdogAlerted`) was dropped by
 * the next real verdict. Measured live 2026-09-03: `freezeAndConverge` — written by the tick's
 * own disposition writer at 19:23Z — was absent from the papercusp row after the 19:25Z verdict,
 * so the freeze-disposition cell read "no record" while a candidate was frozen.
 *
 * The fix inverts the rule: unmentioned keys are FOREIGN and carried; a clear is explicit.
 */
describe('trackGateStall carries keys it does not own (C4, EI-22270968007901491)', () => {
  const freezeAndConverge = { enabled: true, state: 'held', reason: 'red on 761d0a85', candidate: '761d0a85ac12', observedAtMs: 1 };

  it('⭐ preserves freezeAndConverge (and inFlightCandidate) across a RED verdict', async () => {
    seededGh = { consecutiveReds: 0, stallAlerted: false, lastGreenAt: Date.now(), freezeAndConverge, inFlightCandidate: { sha: 'abc', atMs: 2 } };
    await trackGateStall(ctx, 'not-green', 'c'.repeat(40), ['a.test.ts']);
    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect(written!.freezeAndConverge).toEqual(freezeAndConverge);
    expect(written!.inFlightCandidate).toEqual({ sha: 'abc', atMs: 2 });
    // Sanity: a real red tick, not a reset.
    expect(written!.consecutiveReds).toBe(1);
  });

  it('⭐ preserves freezeAndConverge across a GREEN verdict too — a green is not a reason to forget the freeze record', async () => {
    seededGh = { consecutiveReds: 3, stallAlerted: false, lastGreenAt: Date.now() - 60_000, freezeAndConverge };
    await trackGateStall(ctx, 'advanced');
    const written = lastGateHealthWrite();
    expect(written!.freezeAndConverge).toEqual(freezeAndConverge);
    expect(written!.consecutiveReds).toBe(0);
  });

  it('a real verdict clears the hold tick\'s repairTickLegs EXPLICITLY (never by omission)', async () => {
    seededGh = { consecutiveReds: 0, stallAlerted: false, lastGreenAt: Date.now(), repairTickLegs: { head: 'd'.repeat(12), atMs: 3, legs: [] } };
    await trackGateStall(ctx, 'not-green', 'c'.repeat(40), ['a.test.ts']);
    const written = lastGateHealthWrite();
    // The key is PRESENT and null — a merge write clears only what is stated.
    expect('repairTickLegs' in written!).toBe(true);
    expect(written!.repairTickLegs).toBeNull();
  });

  it('⭐ the SQL merges against the row\'s LIVE gate_health, so a peer write between SELECT and UPDATE survives', async () => {
    seededGh = { consecutiveReds: 0, stallAlerted: false, lastGreenAt: Date.now() };
    await trackGateStall(ctx, 'not-green', 'c'.repeat(40), ['a.test.ts']);
    const final = [...calls].reverse().find((c) => /UPDATE\s+harness_shared\.routines/i.test(c.query) && typeof c.params[1] === 'string');
    expect(final).toBeDefined();
    // The whole-key replace was `'{gate_health}', CASE … END`; the merge wraps the CASE.
    expect(final!.query).toMatch(/COALESCE\(metadata->'gate_health', '\{\}'::jsonb\) \|\| \(CASE/);
    expect(final!.query).not.toMatch(/'\{gate_health\}',\s*CASE/);
  });

  describe('carryForeignGateHealthKeys (pure)', () => {
    it('carries a key `next` never mentions, and lets `next` win on every key it does', () => {
      const out = carryForeignGateHealthKeys(
        { freezeAndConverge, watchdogAlerted: true, consecutiveReds: 7 },
        { consecutiveReds: 8, watchdogAlerted: false },
      );
      expect(out).toEqual({ freezeAndConverge, consecutiveReds: 8, watchdogAlerted: false });
    });

    it('an explicit null in `next` is a CLEAR, not an omission — the foreign value does not resurrect', () => {
      const out = carryForeignGateHealthKeys({ repairTickLegs: { head: 'x' }, freezeAndConverge }, { repairTickLegs: null });
      expect(out).toEqual({ freezeAndConverge, repairTickLegs: null });
    });

    it('a null / absent previous row carries nothing and does not throw', () => {
      expect(carryForeignGateHealthKeys(null, { a: 1 })).toEqual({ a: 1 });
      expect(carryForeignGateHealthKeys(undefined, { a: 1 })).toEqual({ a: 1 });
    });

    it('CONTROL: a replace (the pre-C4 behaviour) would have dropped the foreign key', () => {
      const previous = { freezeAndConverge, consecutiveReds: 7 };
      const next = { consecutiveReds: 8 };
      const replaced = { ...next };
      expect('freezeAndConverge' in replaced).toBe(false);
      expect('freezeAndConverge' in carryForeignGateHealthKeys(previous, next)).toBe(true);
    });
  });
});

describe('P-013 (gate-file-level-test-reuse-2026-09-27): gate_health.testPassReuse', () => {
  const measurement = (runGroupId = 'suite-A', completedAtMs = 200) => buildGateSuiteMeasurement(
    'AFFECTED_TASK_CACHE_SUMMARY hits=2 misses=1 proofIdentity=current-run group=missing scope=missing reasons={"passing":2,"noProof":1}',
    'a'.repeat(40), { command: 'npm run test:affected', runGroupId, startedAtMs: 100, completedAtMs })!;

  it.each(['advanced', 'not-green', 'perf-held'])('persists actual measurement on %s and archives its exact identity', async (status) => {
    const m = measurement();
    await trackGateStall(ctx, status, undefined, undefined, null, undefined, null, undefined, { suiteMeasurement: m });
    expect(latestHeadlineHealth?.lastSuiteMeasurement).toEqual(m);
    expect(buildCheckpointDetail({ reason: status, suiteMeasurement: m }).suiteMeasurement).toEqual(m);
    expect(buildCheckpointDetail({ reason: status, suiteMeasurements: [m] }).suiteMeasurements).toEqual([m]);
    const write = calls.find((c) => c.query.includes("jsonb_build_object('lastSuiteMeasurement'"))!;
    expect(write.params).toEqual([ctx.installSlug, ctx.workspaceId, JSON.stringify(m), 200]);
    expect(write.query).toContain("target_role = 'system:green-checkpoint'");
    expect(write.query).toContain('<= $4');
  });

  it('does not advance last actual suite on a replay, hold, malformed record or late older write', async () => {
    const prior = measurement('suite-B', 500);
    seededGh = { consecutiveReds: 0, lastGreenAt: Date.now(), lastSuiteMeasurement: prior };
    await trackGateStall(ctx, 'advanced', undefined, undefined, null, undefined, null, undefined, {});
    expect(latestHeadlineHealth?.lastSuiteMeasurement).toEqual(prior);
    await trackGateStall(ctx, 'skipped-locked');
    expect(latestHeadlineHealth?.lastSuiteMeasurement).toEqual(prior);
    await trackGateStall(ctx, 'advanced', undefined, undefined, null, undefined, null, undefined, { suiteMeasurement: measurement() });
    expect(latestHeadlineHealth?.lastSuiteMeasurement).toEqual(prior);
    expect(buildCheckpointDetail({ reason: 'advanced', suiteMeasurement: { ...prior, judgedSha: 'bad' } }).suiteMeasurement).toBeUndefined();
    // The status UPDATE must merge the live value, not copy a stale SELECT over it.
    expect(lastGateHealthWrite()).not.toHaveProperty('lastSuiteMeasurement');
  });

  const reuse = (over: Record<string, unknown> = {}) => ({
    judgedSha: 'c58655490ce1a3be734de61df08aa7f8159122d4',
    recordedAtMs: 1_790_530_000_000,
    invocations: 1,
    candidates: 10,
    reused: 7,
    minSavedTestMs: 30_000,
    unmeasured: 0,
    alarms: [],
    offReasons: [],
    headline: 'per-file reuse: 7 of 10 candidate file(s) reused, at least 30s test time saved, no alarms',
    // WI-10003603: the pass-proof recorder's outcome. The read-side parse always emits this key
    // (null when the round reported none), so a full record carries it explicitly.
    recorder: null,
    ...over,
  });
  const recorder = {
    tasks: 3,
    written: 3,
    rows: 412,
    retired: 1,
    notPersisted: 0,
    nothingToRecord: 0,
    failed: 0,
    timedOut: 0,
    noReport: 0,
    malformed: 0,
    // WI-10003792: the noReport split, always emitted by the read-side parse.
    noReportExpected: 0,
    noReportUnexpected: 0,
    invocations: 1,
    verdict: 'recorded',
    alarm: false,
    alarms: [],
  };
  const track = (status: string, testPassReuse?: unknown) =>
    trackGateStall(ctx, status, undefined, undefined, null, undefined, null, undefined, { testPassReuse });

  it.each([
    ['a green verdict', 'advanced'],
    ['a red verdict', 'not-green'],
  ])('⭐ stores the round record on %s', async (_label, status) => {
    await track(status, reuse());
    expect(lastGateHealthWrite()?.testPassReuse).toEqual(reuse());
  });

  it('⭐ stores the recorder outcome with the round record (WI-10003603)', async () => {
    await track('not-green', reuse({ recorder }));
    expect(lastGateHealthWrite()?.testPassReuse).toEqual(reuse({ recorder }));
  });

  it('a recorder persisted before the noReport split (WI-10003792) is stored with both split counts as 0', async () => {
    const { noReportExpected: _e, noReportUnexpected: _u, ...legacyRecorder } = recorder;
    await track('not-green', reuse({ recorder: legacyRecorder }));
    expect(lastGateHealthWrite()?.testPassReuse).toEqual(reuse({ recorder }));
  });

  it('a record that omits the recorder is stored with recorder:null, never a guessed outcome', async () => {
    const { recorder: _omit, ...legacy } = reuse();
    await track('advanced', legacy);
    expect(lastGateHealthWrite()?.testPassReuse).toEqual(reuse({ recorder: null }));
  });

  it('⭐ a round that reported nothing keeps the previous record, labelled with its own sha', async () => {
    const prior = reuse({ judgedSha: '09e39c5dff58aa11', reused: 3 });
    seededGh = { consecutiveReds: 0, lastGreenAt: Date.now(), testPassReuse: prior };
    await track('advanced', undefined);
    // Never a zero nobody measured: the older record survives and still names its sha.
    expect(lastGateHealthWrite()?.testPassReuse).toEqual(prior);
  });

  it('drops a malformed value instead of storing it', async () => {
    await track('advanced', { ...reuse(), judgedSha: 'main' });
    const written = lastGateHealthWrite();
    expect(written).not.toBeNull();
    expect('testPassReuse' in written!).toBe(false);
  });

  it.each([
    ['a green verdict', 'advanced'],
    ['a red verdict', 'not-green'],
  ])('⭐ stores the round phase breakdown on %s, and an unmeasured round CLEARS it', async (_label, status) => {
    const roundPhases = {
      totalMs: 3_000_000,
      phases: [
        { phase: 'candidate-suite', ms: 2_400_000 },
        { phase: 'other', ms: 600_000 },
      ],
      breakdown: 'total 50m 00s: candidate-suite 40m 00s (80%), other 10m 00s (20%)',
    };
    await trackGateStall(ctx, status, undefined, undefined, null, undefined, null, undefined, { roundPhases });
    expect(lastGateHealthWrite()?.roundPhases).toEqual(roundPhases);
    // No sha of its own: leaving it would pair an old round's phases with a newer candidate.
    seededGh = { consecutiveReds: 0, lastGreenAt: Date.now(), roundPhases };
    await trackGateStall(ctx, status, undefined, undefined, null, undefined, null, undefined, {});
    expect(lastGateHealthWrite()?.roundPhases).toBeNull();
  });
});

// WI-6554700010018008: green-checkpoint reported verdictFlipQuarantine (P-008) and the doc comment
// said gate_health persisted it, but release-actions never threaded it, so gate_health never held
// it. Pin both hops: trackGateStall stores the per-round records, and every call site that threads
// gate records into trackGateStall carries them (the hop that was actually missing).
describe('WI-6554700010018008: gate_health.verdictFlipQuarantine and gate_health.ratchetShadow', () => {
  const vfq = (over: Record<string, unknown> = {}) => ({
    flips: 2,
    quarantined: [
      { testFile: 'packages/x/a.test.ts', testCase: 'flips on the same sha', owner: 'su-abc', workItemId: 'WI-1' },
    ],
    alreadyCovered: 1,
    unowned: [],
    errors: [],
    ...over,
  });
  const shadow = {
    composedProof: {
      schemaVersion: 1,
      candidate: '1540f7f342c7',
      repairHead: 'ff9f45a40f9d',
      atMs: 1_792_478_000_000,
      status: 'planned',
      rerunCount: 4,
      comparison: {
        fullGreen: false,
        composedGreen: false,
        agree: true,
        missedByComposed: [],
        extraInComposed: [],
        rerunReadFrom: 'full-run-failing-set',
      },
    },
    newRedEjection: {
      schemaVersion: 1,
      candidate: '1540f7f342c7',
      base: 'ac05bfd1a8c4',
      atMs: 1_792_478_000_000,
      status: 'nothing-new',
      blameCheck: 'not-run',
    },
  };
  const track = (status: string, opts: Record<string, unknown>) =>
    trackGateStall(ctx, status, undefined, undefined, null, undefined, null, undefined, opts);

  it.each([
    ['a green verdict', 'advanced'],
    ['a red verdict', 'not-green'],
  ])('⭐ stores both round records on %s', async (_label, status) => {
    await track(status, { verdictFlipQuarantine: vfq(), ratchetShadow: shadow });
    const written = lastGateHealthWrite();
    expect(written?.verdictFlipQuarantine).toEqual(vfq());
    expect(written?.ratchetShadow).toEqual(shadow);
  });

  it('⭐ an unreported round CLEARS both (explicit null), never an older round beside a newer candidate', async () => {
    seededGh = { consecutiveReds: 0, lastGreenAt: Date.now(), verdictFlipQuarantine: vfq(), ratchetShadow: shadow };
    await track('advanced', {});
    const written = lastGateHealthWrite();
    expect(written?.verdictFlipQuarantine).toBeNull();
    expect(written?.ratchetShadow).toBeNull();
  });

  it('drops malformed values instead of storing them', async () => {
    await track('not-green', {
      verdictFlipQuarantine: { ...vfq(), flips: 'two' },
      ratchetShadow: { composedProof: { ...shadow.composedProof, schemaVersion: 2 } },
    });
    const written = lastGateHealthWrite();
    expect(written?.verdictFlipQuarantine).toBeNull();
    expect(written?.ratchetShadow).toBeNull();
  });

  it('a quarantine entry missing its owner or work-item is dropped; the rest of the record is kept', async () => {
    const extra = { testFile: 'packages/x/b.test.ts', testCase: 'no owner' };
    await track('not-green', { verdictFlipQuarantine: vfq({ quarantined: [...vfq().quarantined, extra] }) });
    expect(lastGateHealthWrite()?.verdictFlipQuarantine).toEqual(vfq());
  });

  it('⭐ every call site that threads gate records into trackGateStall threads these two as well', () => {
    const src = readFileSync(new URL('./release-actions.ts', import.meta.url), 'utf8');
    // A threading site is an options literal carrying `testPassReuse: <x>.testPassReuse`.
    const sites = [...src.matchAll(/testPassReuse: (verdict|parsed\?)\.testPassReuse,([\s\S]*?)\n\s*\}/g)];
    // Positive control: the three known sites (red hold, promotion-pending, marker fallback).
    expect(sites.length).toBeGreaterThanOrEqual(3);
    for (const [, from, block] of sites) {
      for (const key of ['promotionRatchet', 'verdictFlipQuarantine', 'ratchetShadow']) {
        expect(block, `${from}.${key} missing from a trackGateStall threading site`).toContain(
          `${key}: ${from}.${key},`,
        );
      }
    }
  });
});
