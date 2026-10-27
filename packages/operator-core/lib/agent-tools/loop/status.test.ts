/**
 * loop:status distinguishes "no loop exists" from "this read may be from the wrong
 * database" (EI-19384072467112035, following plan outage-must-not-be-silent-2026-08-02).
 *
 * `getLoopStatus` reads through `getOrgPg()`, which can be talking to a different,
 * freshly-initdb'd embedded Postgres than the one this process pinned (a captured
 * discovery file, a per-session sidecar restarted onto a fresh empty store). In that
 * state "no row for this owner" is a correct answer from the WRONG database, not
 * evidence the loop is gone — and an agent that reads `loop:null` and re-arms on the
 * strength of it risks a duplicate loop the moment the real store becomes reachable
 * again. This only ever augments a null/negative result; a found loop row is always
 * reported as-is, unannotated.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/loop/status.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../coordination/roles', () => ({ COORD_ROLES: ['operator'] }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({
    ownerId: 'su-caller-own-id',
    ownerLabel: 'su · caller',
    source: 'omp-hook-session',
    workspaceId: 'ws-1',
    userId: null,
  })),
  resolveSelfLiteral: vi.fn((value: string | undefined, callerOwnerId: string) =>
    value === 'self' ? callerOwnerId : value,
  ),
}));
vi.mock('../../events/await/wake-reachability', () => ({
  probeWakeReachability: vi.fn(async () => ({
    reachable: true,
    channel: 'inject',
    durableWhileAlive: true,
    summary: 'ok',
  })),
}));

vi.mock('../../events/await/store', () => ({
  listWakeAwaitsForSubscriber: vi.fn(async () => ({ totalCount: 0, sample: [] })),
}));

vi.mock('../../harness/routines/loop', () => ({ getLoopStatus: vi.fn() }));
vi.mock('../../harness/routines/loop-transition-log', () => ({
  readLatestLoopTransition: vi.fn(async () => ({ status: 'none' })),
}));
vi.mock('../../carry-note', () => ({
  getLoopCarryNoteWithMeta: vi.fn(async () => ({ note: null, updatedAtMs: null })),
  shortCarryHash: vi.fn((note: string) => `hash:${note}`),
}));

import { _resetStoreIdentityForTests, pinOrVerifyStoreIdentity } from '@papercusp/db-org';
import { getLoopStatus } from '../../harness/routines/loop';
import { readLatestLoopTransition } from '../../harness/routines/loop-transition-log';
import { getLoopCarryNoteWithMeta } from '../../carry-note';
import { listWakeAwaitsForSubscriber } from '../../events/await/store';
import { probeWakeReachability } from '../../events/await/wake-reachability';
import statusTool, { deriveActiveAwaitSuppression } from './status';

const getLoopStatusMock = getLoopStatus as unknown as ReturnType<typeof vi.fn>;
const readLatestLoopTransitionMock = readLatestLoopTransition as unknown as ReturnType<typeof vi.fn>;
const getLoopCarryNoteWithMetaMock = getLoopCarryNoteWithMeta as unknown as ReturnType<typeof vi.fn>;
const listWakeAwaitsMock = listWakeAwaitsForSubscriber as unknown as ReturnType<typeof vi.fn>;
const probeWakeReachabilityMock = probeWakeReachability as unknown as ReturnType<typeof vi.fn>;

const OURS = { systemIdentifier: '7635091775813704249', database: 'papercusp' };
const IMPOSTOR = { systemIdentifier: '7111222333444555666', database: 'papercusp' };

// Via `unknown`: the tool's declared arg/event generics do not overlap this narrowed
// shape, and TS2352 correctly refuses the direct assertion (same pattern as pg_health.test.ts).
const run = (args: Record<string, unknown> = {}) =>
  (
    statusTool as unknown as {
      handler: (a: unknown, ctx: unknown) => Promise<{ content: [{ type: 'text'; text: string }] }>;
    }
  )
    .handler(args, {})
    .then((r) => JSON.parse(r.content[0].text));

describe('loop:status — ambient workspace transaction safety (EI-20229292848756531)', () => {
  it('opts out because the handler owns independent DB reads and never consumes ctx.tx', () => {
    expect((statusTool as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });
});

describe('loop:status result-door policy (EI-21927463826765541)', () => {
  it('keeps the complete liveness envelope out of the generic aggregate result door', () => {
    expect((statusTool as { skipResultDoor?: string }).skipResultDoor).toBe('oversize-by-design');
  });
});

describe('loop:status MCP effect metadata', () => {
  it('declares the liveness probe as read-only for catalog recovery', () => {
    expect((statusTool as { effect?: string }).effect).toBe('read');
  });
});

describe('loop:status concurrency (EI-21869094231635430)', () => {
  it('runs the four independent probes concurrently, not as a sequential sum of round-trips', async () => {
    getLoopStatusMock.mockResolvedValue({
      name: 'loop-su-caller-own-id',
      active: true,
      ownerId: 'su-caller-own-id',
      harnessSlug: 'papercusp',
      intervalSec: 60,
    });

    const started: string[] = [];
    const deferred = <T>() => {
      let resolve!: (v: T) => void;
      const promise = new Promise<T>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };

    const transitionD = deferred<{ status: 'none' }>();
    const carryNoteD = deferred<{ note: null; updatedAtMs: null }>();
    const reachabilityD = deferred<{
      reachable: boolean;
      channel: string;
      durableWhileAlive: boolean;
      summary: string;
    }>();
    const awaitsD = deferred<{ totalCount: number; sample: never[] }>();

    readLatestLoopTransitionMock.mockImplementation(() => {
      started.push('transition');
      return transitionD.promise;
    });
    getLoopCarryNoteWithMetaMock.mockImplementation(() => {
      started.push('carryNote');
      return carryNoteD.promise;
    });
    probeWakeReachabilityMock.mockImplementation(() => {
      started.push('reachability');
      return reachabilityD.promise;
    });
    listWakeAwaitsMock.mockImplementation(() => {
      started.push('pendingAwaits');
      return awaitsD.promise;
    });

    const resultPromise = run();

    // Flush microtasks so the handler advances past `await getLoopStatus(...)` and
    // evaluates the Promise.all argument array — which synchronously INVOKES all
    // four dependent functions before any of them settles. A sequential-await
    // version (the pre-fix shape) would only have invoked the FIRST of these at
    // this checkpoint, since the second call site is gated behind `await`ing the
    // first's promise.
    await Promise.resolve();
    await Promise.resolve();

    expect(started.sort()).toEqual(['carryNote', 'pendingAwaits', 'reachability', 'transition']);

    transitionD.resolve({ status: 'none' });
    carryNoteD.resolve({ note: null, updatedAtMs: null });
    reachabilityD.resolve({ reachable: true, channel: 'inject', durableWhileAlive: true, summary: 'ok' });
    awaitsD.resolve({ totalCount: 0, sample: [] });

    const out = await resultPromise;
    expect(out.ok).toBe(true);
    expect(out.lastTransition).toEqual({ status: 'none' });
    expect(out.carryNote).toEqual({ note: null, contentHash: null, updatedAtMs: null });
    expect(out.reachability).toEqual({
      reachable: true,
      channel: 'inject',
      durableWhileAlive: true,
      summary: 'ok',
    });
    expect(out.pendingAwaits).toEqual({ status: 'none', scope: 'non-inbox-wake' });
  });
});

describe('loop:status self owner selector (EI-22564327654701627)', () => {
  it('resolves ownerId:self to the caller instead of querying the literal owner', async () => {
    getLoopStatusMock.mockResolvedValue(null);

    await run({ ownerId: 'self' });

    expect(getLoopStatusMock).toHaveBeenCalledWith('su-caller-own-id');
  });

  it('resolves the owner alias self to the caller as well', async () => {
    getLoopStatusMock.mockResolvedValue(null);

    await run({ owner: 'self' });

    expect(getLoopStatusMock).toHaveBeenCalledWith('su-caller-own-id');
  });

  it('keeps an explicit ownerId ahead of the owner alias', async () => {
    getLoopStatusMock.mockResolvedValue(null);

    await run({ ownerId: 'su-explicit-owner', owner: 'self' });

    expect(getLoopStatusMock).toHaveBeenCalledWith('su-explicit-owner');
  });
});

/**
 * loop:status owner-scoped argument contract — EI-21137205137669557.
 *
 * SUPERSEDES EI-20232692935534790, which pinned the OPPOSITE contract (reject
 * `harness` as "misleading input"). That earlier item saw the same symptom and
 * chose a DOCUMENTATION fix: state the refusal as intentional, and pin it with a
 * test. The refusal kept being hit and re-filed afterwards — EI-22401368814327235,
 * EI-22382359559449487, EI-22380912988336391 and EI-22378007077312111 are all the
 * same complaint, filed AFTER 2026-08-12, and one of them names the behaviour as
 * "rejected by design and pinned" — i.e. an agent read the documentation, understood
 * it, and still filed the refusal as friction. Documenting a papercut did not stop
 * callers stubbing their toes on it.
 *
 * Accepting the arg is safe by CODE TRUTH, not by convention: getLoopStatuses
 * (harness/routines/loop.ts) selects `WHERE r.target_owner_id = ANY(...)` as its only
 * top-level predicate — there is no harness/install_slug filter — so a `harness` value
 * cannot change the answer. `loop:end` had already settled the identical question the
 * accept-and-ignore way with byte-identical wording, leaving `loop:status` the lone
 * sibling in its own family that hard-errored on a harmless arg.
 *
 * The second test below is a CONTROL and must stay: zod objects strip unknown keys by
 * default, so "safeParse succeeds" would pass even on a schema with no `harness` key at
 * all. It is only meaningful because defineTool wraps args in `strictArgs`. If that
 * strictness ever regresses, the control fails and the acceptance test becomes vacuous
 * — which is exactly when you need to be told.
 *
 * The family-parity assertion checks the shared sentence rather than importing
 * `./end`: end.ts pulls in workspace-registry, control-anchor, goal-io-validation,
 * modes/*, and further `events/await/store` exports that this file's hand-listed
 * vi.mock factories do not provide, so importing it would break the whole lane.
 */
describe('loop:status owner-scoped argument contract (EI-21137205137669557)', () => {
  const tool = () =>
    statusTool as unknown as {
      description?: string;
      guidance?: { when?: string };
      args: {
        safeParse: (value: unknown) => { success: boolean };
        // WI-6554700010029664: args is a preprocess pipe (owner → ownerId fold); `out` is the object.
        out: { shape: { ownerId?: { description?: string }; harness?: { description?: string } } };
      };
    };

  it('ACCEPTS a harness arg instead of hard-erroring on it', () => {
    expect(tool().args.safeParse({ harness: 'papercusp' }).success).toBe(true);
    expect(tool().args.safeParse({ harness: 'papercusp', ownerId: 'another-owner' }).success).toBe(true);
    expect(tool().args.safeParse({ ownerId: 'another-owner' }).success).toBe(true);
    expect(tool().args.safeParse({}).success).toBe(true);
  });

  it('CONTROL: still rejects a genuinely unknown key, so the acceptance above is not blanket passthrough', () => {
    expect(tool().args.safeParse({ notAnArgument: 'x' }).success).toBe(false);
    // The near-miss a caller actually types; it must NOT be silently swallowed.
    expect(tool().args.safeParse({ harness_slug: 'papercusp' }).success).toBe(false);
  });

  it('documents the arg as accepted-and-ignored, matching the loop:end sibling', () => {
    expect(tool().description).toMatch(/owner-scoped/i);
    expect(tool().description).toMatch(/accepted and ignored/i);
    expect(tool().guidance?.when).toMatch(/ignores `harness`/i);
    // The canonical sentence loop:end already uses, kept verbatim across the family.
    expect(tool().args.out.shape.harness?.description).toMatch(/Accepted for compatibility and IGNORED/);
    expect(tool().args.out.shape.harness?.description).toMatch(/keyed by owner, not by harness/);
  });
});

describe('loop:status return guidance matches the emitted loop record', () => {
  it('documents lastFiredAt, the field emitted by loop:status', async () => {
    const emitted = {
      active: true,
      intervalSec: 60,
      parked: false,
      nextFireAt: null,
      lastFiredAt: '2026-08-22T09:15:00.000Z',
      cadenceDrift: false,
    };
    getLoopStatusMock.mockResolvedValue(emitted);

    const out = await run();
    const returns = (statusTool as unknown as { guidance?: { returns?: string } }).guidance?.returns ?? '';

    expect(out.loop).toMatchObject(emitted);
    expect(returns).toContain('lastFiredAt');
    expect(returns).toContain('cadenceDrift');
    expect(returns).not.toMatch(/\blastFireAt\b/);
  });
});

beforeEach(() => {
  _resetStoreIdentityForTests();
  getLoopStatusMock.mockReset();
  probeWakeReachabilityMock.mockReset();
  probeWakeReachabilityMock.mockResolvedValue({
    reachable: true,
    channel: 'inject',
    durableWhileAlive: true,
    summary: 'ok',
  });
  getLoopCarryNoteWithMetaMock.mockReset();
  getLoopCarryNoteWithMetaMock.mockResolvedValue({ note: null, updatedAtMs: null });
  listWakeAwaitsMock.mockReset();
  listWakeAwaitsMock.mockResolvedValue({ totalCount: 0, sample: [] });
  readLatestLoopTransitionMock.mockReset();
  readLatestLoopTransitionMock.mockResolvedValue({ status: 'none' });
});

/**
 * P-013 / RSR-P-013-C (review-system-rework-reduction-2026-09-23), EI-24023838400909760:
 * loop status reports rewakeGuaranteed:false when the last fire parked. The verdict is
 * the same classifier loop:checkpoint's continuation gate uses (./next-wake).
 */
describe('loop:status rewake verdict (P-013)', () => {
  const armed = {
    active: true,
    intervalSec: 600,
    parked: false,
    nextFireAt: '2099-01-01T00:00:00.000Z',
    armedAt: '2026-09-23T03:55:04.000Z',
    firesSinceArm: 1,
    maxFires: null,
    maxDurationSec: null,
    expectedFiresSinceArm: 1,
    carry: 'cold',
  };

  it('reports rewakeGuaranteed:false with last-fire-parked when the newest fire parked with no injectable host', async () => {
    getLoopStatusMock.mockResolvedValue({
      ...armed,
      lastWakeStatus: 'parked',
      lastWakeError: 'eligible cold loop wake has no injectable psu host — parked without resume to preserve the fresh-context boundary',
    });
    const out = await run();
    expect(out.rewake).toEqual({ rewakeGuaranteed: false, reason: 'last-fire-parked' });
  });

  // WI-6554700010030084: a cold reset ends the session it was delivered to; SessionEnd hygiene then
  // drops the reset's own (host-accepted) row. That drop is not an undelivered fire.
  it('does not read a cold reset dropped by its own SessionEnd as a parked fire', async () => {
    getLoopStatusMock.mockResolvedValue({
      ...armed,
      lastWakeStatus: 'dropped',
      lastWakeError: 'standing inbox-wake await cancelled before delivery after the psu host had accepted this delivery; the host-owned commit is not an undelivered wake (WI-1062047, WI-6554700010030084)',
    });
    const out = await run();
    expect(out.rewake).toEqual({ rewakeGuaranteed: true, reason: null });
  });

  it('still reads a drop the host never accepted as last-fire-parked', async () => {
    getLoopStatusMock.mockResolvedValue({
      ...armed,
      lastWakeStatus: 'dropped',
      lastWakeError: 'standing inbox-wake await cancelled before delivery (WI-1062047)',
    });
    const out = await run();
    expect(out.rewake).toEqual({ rewakeGuaranteed: false, reason: 'last-fire-parked' });
  });

  it('reports rewakeGuaranteed:true for the same loop once its last fire was delivered', async () => {
    getLoopStatusMock.mockResolvedValue({ ...armed, lastWakeStatus: 'delivered', lastWakeError: null });
    const out = await run();
    expect(out.rewake).toEqual({ rewakeGuaranteed: true, reason: null });
  });

  it('does not promise a re-wake when the live owner route probe finds no delivery channel', async () => {
    getLoopStatusMock.mockResolvedValue({ ...armed, lastWakeStatus: 'delivered', lastWakeError: null });
    probeWakeReachabilityMock.mockResolvedValue({
      reachable: false,
      channel: 'none',
      durableWhileAlive: false,
      summary: 'no owner wake route',
    });

    const out = await run();

    expect(out.reachability).toMatchObject({ reachable: false, channel: 'none' });
    expect(out.rewake).toEqual({ rewakeGuaranteed: false, reason: 'wake-unreachable' });
  });

  it('uses the wake dispatch timestamp when a loop-fire turn completes before delivery settlement', async () => {
    const lastWakeCreatedAt = '2026-10-09T20:20:14.031Z';
    getLoopStatusMock.mockResolvedValue({
      ...armed,
      lastWakeStatus: 'delivered',
      lastWakeChannel: 'suppressed-redundant',
      lastWakeAt: '2026-10-09T20:21:04.131Z',
      lastWakeCreatedAt,
      lastFiredAt: '2026-10-09T20:20:19.406Z',
      lastLoopTurnAt: '2026-10-09T20:20:24.455Z',
      lastWakeError: null,
    });
    const out = await run();
    expect(out.loop.lastWakeCreatedAt).toBe(lastWakeCreatedAt);
    expect(out.rewake).toEqual({ rewakeGuaranteed: true, reason: null });
  });

  it('reports no re-wake guarantee after reconciliation confirms a delivered wake produced no loop turn', async () => {
    getLoopStatusMock.mockResolvedValue({
      ...armed,
      lastWakeStatus: 'delivered',
      lastWakeError: null,
      lastDeliveryOutcome: 'loop-delivered-wake-no-loop-turn',
      fireStarved: false,
      turnsStalled: false,
    });
    const out = await run();
    expect(out.rewake).toEqual({ rewakeGuaranteed: false, reason: 'last-fire-no-loop-turn' });
  });

  it('restores the re-wake guarantee when a delayed loop turn completes after that fire', async () => {
    getLoopStatusMock.mockResolvedValue({
      ...armed,
      lastFiredAt: '2026-10-03T05:00:00.000Z',
      lastFailedFireLoopTurnCompletedAt: '2026-10-03T05:00:00.001Z',
      lastWakeStatus: 'delivered',
      lastWakeError: null,
      lastDeliveryOutcome: 'loop-delivered-wake-no-loop-turn',
      fireStarved: false,
      turnsStalled: false,
    });
    const out = await run();
    expect(out.loop.lastFailedFireLoopTurnCompletedAt).toBe('2026-10-03T05:00:00.001Z');
    expect(out.rewake).toEqual({ rewakeGuaranteed: true, reason: null });
  });

  it('keeps the turn-settle wake guarantee for a parked loop with no concrete nextFireAt', async () => {
    getLoopStatusMock.mockResolvedValue({
      ...armed,
      parked: true,
      nextFireAt: null,
      lastWakeStatus: 'delivered',
      lastWakeError: null,
    });
    const out = await run();
    expect(out.loop).toMatchObject({ active: true, parked: true, nextFireAt: null });
    expect(out.rewake).toEqual({ rewakeGuaranteed: true, reason: null });
  });

  it('is null when no loop exists', async () => {
    getLoopStatusMock.mockResolvedValue(null);
    expect((await run()).rewake).toBeNull();
  });

  it('documents the field in the tool returns guidance', () => {
    const returns = (statusTool as unknown as { guidance?: { returns?: string } }).guidance?.returns ?? '';
    expect(returns).toContain('rewakeGuaranteed');
    expect(returns).toContain('last-fire-parked');
    expect(returns).toContain('wake-unreachable');
    expect(returns).toContain('lastFailedFireLoopTurnCompletedAt');
  });
});

describe('loop:status latest transition diagnostics (EI-21573850378423298)', () => {
  it('surfaces await-suppression and its driving event instead of resembling fire starvation', async () => {
    getLoopStatusMock.mockResolvedValue({
      name: 'loop-su-caller-own-id',
      active: true,
      ownerId: 'su-caller-own-id',
      harnessSlug: 'papercusp',
      intervalSec: 60,
      firesSinceArm: 0,
      nextFireAt: '2026-08-27T03:17:32.159Z',
    });
    readLatestLoopTransitionMock.mockResolvedValue({
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
      // EI-24709926664545964: the derived cycle rides on the found transition untouched.
      cycle: {
        phase: 'settled',
        turnInFlightSec: null,
        lastTurn: { turnSec: 330, postSettleDelaySec: 31, scheduledDelaySec: 26 },
        basis: 'test-basis',
      },
    });

    const out = await run();

    expect(out.lastTransition).toMatchObject({
      status: 'found',
      transition: {
        actor: 'await-suppression',
        detail: { drivingEventKey: 'plan:stable:recovery-complete' },
      },
      cycle: { lastTurn: { turnSec: 330, postSettleDelaySec: 31 } },
    });
    expect(readLatestLoopTransitionMock).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      installSlug: 'papercusp',
      routineName: 'loop-su-caller-own-id',
      targetOwnerId: 'su-caller-own-id',
    });
    const returns = (statusTool as unknown as { guidance?: { returns?: string } }).guidance?.returns ?? '';
    expect(returns).toContain('lastTransition');
    expect(returns).toContain("actor:'await-suppression'");
    // The instrument fix: the description must say `parked` is a turn in flight, not a delay.
    expect(returns).toContain('cycle.lastTurn.turnSec');
    expect(returns).toContain('TURN is in flight');
  });

  it('returns null and skips the transition read when no loop exists', async () => {
    getLoopStatusMock.mockResolvedValue(null);

    const out = await run();

    expect(out.lastTransition).toBeNull();
    expect(out.awaitSuppression).toBeNull();
    expect(readLatestLoopTransitionMock).not.toHaveBeenCalled();
  });

  it('WI-10004466: states a currently-withheld wake at top level with its driving await', async () => {
    const until = new Date(Date.now() + 55 * 60_000).toISOString();
    getLoopStatusMock.mockResolvedValue({
      name: 'loop-su-caller-own-id',
      active: true,
      ownerId: 'su-caller-own-id',
      harnessSlug: 'papercusp',
      intervalSec: 120,
      firesSinceArm: 3,
      nextFireAt: until,
    });
    readLatestLoopTransitionMock.mockResolvedValue({
      status: 'found',
      transition: {
        at: new Date().toISOString(),
        event: 'rearmed',
        actor: 'await-suppression',
        newNextFireAt: until,
        intervalSec: 120,
        detail: { via: 'await-suppression', drivingEventKey: 'plan-item:done:x:P-008' },
      },
      cycle: { phase: 'settled', turnInFlightSec: null, lastTurn: null, basis: 'test-basis' },
    });

    const out = await run();

    expect(out.awaitSuppression).toMatchObject({
      suppressedUntil: until,
      drivingEventKey: 'plan-item:done:x:P-008',
    });
    expect(String((out.awaitSuppression as { summary: string }).summary)).toContain('events:cancel');
  });
});

describe('deriveActiveAwaitSuppression (WI-10004466)', () => {
  const now = Date.parse('2026-10-01T00:30:00.000Z');
  const until = '2026-10-01T01:20:34.000Z';
  const found = (over: Record<string, unknown> = {}) => ({
    status: 'found' as const,
    transition: {
      at: '2026-10-01T00:24:32.000Z',
      event: 'rearmed',
      actor: 'await-suppression',
      newNextFireAt: until,
      intervalSec: 120,
      detail: { drivingEventKey: 'k' },
      ...over,
    },
    cycle: { phase: 'settled', turnInFlightSec: null, lastTurn: null, basis: 'b' },
  });

  it('is active while the suppression re-arm still owns a future schedule', () => {
    expect(deriveActiveAwaitSuppression(found() as never, until, now)).toMatchObject({
      suppressedUntil: until,
      drivingEventKey: 'k',
    });
    expect(deriveActiveAwaitSuppression(found() as never, new Date(until), now)).not.toBeNull();
  });

  it('is null once the target passed, a different actor wrote last, or a later arm moved the schedule', () => {
    expect(deriveActiveAwaitSuppression(found() as never, until, Date.parse(until) + 1)).toBeNull();
    expect(deriveActiveAwaitSuppression(found({ actor: 'loop-arm' }) as never, until, now)).toBeNull();
    expect(deriveActiveAwaitSuppression(found() as never, '2026-10-01T00:32:00.000Z', now)).toBeNull();
    expect(deriveActiveAwaitSuppression({ status: 'unknown' }, until, now)).toBeNull();
    expect(deriveActiveAwaitSuppression(null, until, now)).toBeNull();
  });
});

describe('loop:status carry-note read-back (EI-21380031331878722)', () => {
  it('surfaces the routine-scoped note, current hash, and write timestamp', async () => {
    getLoopStatusMock.mockResolvedValue({
      active: true,
      ownerId: 'su-caller-own-id',
      harnessSlug: 'papercusp',
      intervalSec: 60,
    });
    getLoopCarryNoteWithMetaMock.mockResolvedValue({
      note: '## Next action\nreconcile the uncertain write',
      updatedAtMs: 1_787_546_123_000,
    });

    const out = await run();

    expect(out.carryNote).toEqual({
      note: '## Next action\nreconcile the uncertain write',
      contentHash: 'hash:## Next action\nreconcile the uncertain write',
      updatedAtMs: 1_787_546_123_000,
    });
    expect(getLoopCarryNoteWithMetaMock).toHaveBeenCalledWith({
      harness: 'papercusp',
      ownerId: 'su-caller-own-id',
    });
  });

  it('reports an explicit empty read when the routine has no carry-note', async () => {
    getLoopStatusMock.mockResolvedValue({ active: true, harnessSlug: 'papercusp' });

    const out = await run();

    expect(out.carryNote).toEqual({ note: null, contentHash: null, updatedAtMs: null });
  });

  it('does not perform a carry-note lookup when no loop exists', async () => {
    getLoopStatusMock.mockResolvedValue(null);

    const out = await run();

    expect(out.carryNote).toBeNull();
    expect(getLoopCarryNoteWithMetaMock).not.toHaveBeenCalled();
  });
});

describe('loop:status store-identity delivery', () => {
  it('OMITS storeIdentityWarning when no violation is latched, loop null', async () => {
    getLoopStatusMock.mockResolvedValue(null);
    pinOrVerifyStoreIdentity(OURS, 'postgresql://localhost:5432/papercusp');

    const out = await run();

    expect(out.ok).toBe(true);
    expect(out.loop).toBeNull();
    expect(out).not.toHaveProperty('storeIdentityWarning');
  });

  it('OMITS storeIdentityWarning when a violation IS latched but a loop row WAS found', async () => {
    getLoopStatusMock.mockResolvedValue({ active: false, intervalSec: 60 });
    pinOrVerifyStoreIdentity(OURS, 'postgresql://localhost:5432/papercusp');
    pinOrVerifyStoreIdentity(IMPOSTOR, 'postgresql://127.0.0.1:22060/papercusp');

    const out = await run();

    // A found row is trustworthy regardless — only the null/negative path is annotated.
    expect(out.loop).toEqual({ active: false, intervalSec: 60 });
    expect(out).not.toHaveProperty('storeIdentityWarning');
  });

  it('SURFACES storeIdentityWarning on a null loop when a violation is latched', async () => {
    getLoopStatusMock.mockResolvedValue(null);
    pinOrVerifyStoreIdentity(OURS, 'postgresql://localhost:5432/papercusp');
    pinOrVerifyStoreIdentity(IMPOSTOR, 'postgresql://127.0.0.1:22060/papercusp');

    const out = await run();

    expect(out.ok).toBe(true);
    expect(out.loop).toBeNull();
    const w = out.storeIdentityWarning;
    expect(w).toBeTruthy();
    expect(w.severity).toBe('critical');
    // The exact wrong conclusion this exists to stop.
    expect(w.whatThisMeans).toMatch(/do not treat this loop:null as/i);
    expect(w.whatThisMeans).toMatch(/re-arm/i);
    expect(w.detail).toContain('22060');
  });

  it('leaks no credentials into the surfaced warning', async () => {
    getLoopStatusMock.mockResolvedValue(null);
    pinOrVerifyStoreIdentity(OURS, 'postgresql://harness_admin:secret@localhost:5432/papercusp');
    pinOrVerifyStoreIdentity(IMPOSTOR, 'postgresql://harness_admin:secret@127.0.0.1:22060/papercusp');

    const out = await run();

    expect(JSON.stringify(out)).not.toContain('secret');
  });
});

describe('loop:status pendingAwaits (EI-19415169477907694)', () => {
  it('reports status:none when the caller holds no live non-inbox-wake await', async () => {
    getLoopStatusMock.mockResolvedValue(null);
    listWakeAwaitsMock.mockResolvedValue({ totalCount: 0, sample: [] });

    const out = await run();

    expect(out.pendingAwaits).toEqual({ status: 'none', scope: 'non-inbox-wake' });
  });

  it('still reports standing inbox-wake reachability when no loop or explicit park exists (EI-21452056705704146)', async () => {
    getLoopStatusMock.mockResolvedValue(null);
    listWakeAwaitsMock.mockResolvedValue({ totalCount: 0, sample: [] });

    const out = await run();

    expect(out.loop).toBeNull();
    expect(out.reachability).toEqual({
      reachable: true,
      channel: 'inject',
      durableWhileAlive: true,
      summary: 'ok',
    });
    // `none` is scoped to caller-authored parks; it no longer masquerades as
    // proof that the standing host inbox-wake channel is absent.
    expect(out.pendingAwaits).toEqual({ status: 'none', scope: 'non-inbox-wake' });
  });

  it('reports status:found with a sample of event keys when awaits are live', async () => {
    getLoopStatusMock.mockResolvedValue(null);
    listWakeAwaitsMock.mockResolvedValue({
      totalCount: 2,
      sample: [
        { eventKey: 'work-item:claimable', expiresTs: null, rootId: null },
        { eventKey: 'release:green:papercusp', expiresTs: null, rootId: null },
      ],
    });

    const out = await run();

    expect(out.pendingAwaits).toEqual({
      status: 'found',
      count: 2,
      sample: ['work-item:claimable', 'release:green:papercusp'],
      scope: 'non-inbox-wake',
    });
  });

  it('reports the uncapped total when the store returns a capped sample', async () => {
    getLoopStatusMock.mockResolvedValue(null);
    listWakeAwaitsMock.mockResolvedValue({
      totalCount: 6,
      sample: [
        { eventKey: 'await:1', expiresTs: null, rootId: null },
        { eventKey: 'await:2', expiresTs: null, rootId: null },
        { eventKey: 'await:3', expiresTs: null, rootId: null },
        { eventKey: 'await:4', expiresTs: null, rootId: null },
        { eventKey: 'await:5', expiresTs: null, rootId: null },
      ],
    });

    const out = await run();

    expect(out.pendingAwaits).toEqual({
      status: 'found',
      count: 6,
      sample: ['await:1', 'await:2', 'await:3', 'await:4', 'await:5'],
      scope: 'non-inbox-wake',
    });
  });

  it('degrades to status:unknown (never "none") when the lookup fails — a failed lookup must not fabricate a measurement', async () => {
    getLoopStatusMock.mockResolvedValue(null);
    listWakeAwaitsMock.mockRejectedValue(new Error('pg unavailable'));

    const out = await run();

    expect(out.pendingAwaits).toEqual({ status: 'unknown', scope: 'non-inbox-wake' });
  });

  it('is computed even when no loop is armed (a bare events:await with no loop still deserves this answer)', async () => {
    getLoopStatusMock.mockResolvedValue(null);
    listWakeAwaitsMock.mockResolvedValue({
      totalCount: 1,
      sample: [{ eventKey: 'lock:grant:t1', expiresTs: null, rootId: null }],
    });

    const out = await run();

    expect(out.loop).toBeNull();
    expect(out.pendingAwaits).toEqual({
      status: 'found',
      count: 1,
      sample: ['lock:grant:t1'],
      scope: 'non-inbox-wake',
    });
  });
});

// EI-21197839138727609 guard: the declared response shape MUST name the `loop`
// wrapper, and the handler body MUST nest the record under it. A jq/code:run
// reducer that assumes root-level active/interval fields iterates null — the
// exact reported failure — so doc and body are pinned together here (mirrors
// find.test.ts's declared-vs-actual pin for tools:find).
describe('loop:status declared-vs-actual envelope (EI-21197839138727609)', () => {
  it('declares the ROOT ENVELOPE and names the `loop` wrapper in guidance.returns', () => {
    const tool = statusTool as unknown as { guidance?: { returns?: string } };
    expect(tool.guidance?.returns).toContain('ROOT ENVELOPE');
    expect(tool.guidance?.returns).toMatch(/NESTED under `loop`/);
    expect(tool.guidance?.returns).toContain("pendingAwaits.scope:'non-inbox-wake'");
    expect(tool.guidance?.returns).toMatch(/NEVER evidence that the owner is globally unreachable/);
  });

  it('nests the loop record under `loop` (never at the root) so reducers descend .loop', async () => {
    getLoopStatusMock.mockResolvedValue({
      active: true,
      intervalSec: 90,
      parked: false,
      nextFireAt: '2026-08-24T10:00:00.000Z',
      lastFiredAt: null,
      fireCount: 3,
      firesSinceArm: 3,
    });
    listWakeAwaitsMock.mockResolvedValue({ totalCount: 0, sample: [] });

    const out = await run();

    expect(out.ok).toBe(true);
    expect(out.loop).toMatchObject({ active: true, intervalSec: 90 });
    // Root-level convenience fields would BE the reported bug shape — assert absence.
    expect(out.active).toBeUndefined();
    expect(out.intervalSec).toBeUndefined();
  });
});
