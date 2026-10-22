/**
 * checkpoint.test.ts — the loop:checkpoint handler (su-cold-auto-mode-2026-07-03 P-002
 * PRODUCER). The carry-note store (setLoopCarryNote) + renderCarryNote are mocked so the
 * assertions are purely about the tool's CONTRACT: structured-fields-vs-raw-note routing,
 * ownerId / harness resolution (matching the loopScope the wake executor reads),
 * write-vs-clear, and the no-harness guard.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/loop/checkpoint.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
// Formatting assertions ignore the ID anchor; lifecycle tests below verify IDs.
const withoutRowIds = (note: string | null | undefined) =>
  (note ?? '').replace(/^(- (?:[✓?⚠] )?)\[#[a-z0-9_.:-]+\] /gm, '$1');

import { defineTool, lookupByMcpName } from '@papercusp/agent-mcp';
import { OrgTxnTimeoutError } from '../../pg-bounded-txn';
import { continuityProbeRevision } from '../../continuity-probes';
import { currentBuildTestRoute } from '../../serving-runtimes';
import { LIMITS } from '../limits';

const LOOP_CONTINUITY_TEST_TOOL = 'test:loop-continuity-read';
const LOOP_LONG_CONTINUITY_TEST_TOOL = `test:${'x'.repeat(167 - 'test:'.length)}`;
defineTool({
  name: LOOP_CONTINUITY_TEST_TOOL,
  description: 'read-only fixture for loop checkpoint executable probes',
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: ['su'],
  effect: 'read',
  args: z.object({ value: z.string() }),
  async handler(args) {
    return { data: { value: args.value } };
  },
});
defineTool({
  name: LOOP_LONG_CONTINUITY_TEST_TOOL,
  description: 'read-only fixture for long loop checkpoint executable probes',
  capability: 'coord:read',
  requirePrincipal: false,
  agentRoles: ['su'],
  effect: 'read',
  args: z.object({ value: z.string() }),
  async handler(args) {
    return { data: { value: args.value } };
  },
});

const setLoopCarryNote = vi.fn();
const getLoopCarryNote = vi.fn();
const listLoopCarryNoteHarnesses = vi.fn(async (..._a: unknown[]) => [] as string[]);
const listLoopCarryNoteScopes = vi.fn(
  async (..._a: unknown[]) => [] as { harness: string; updatedAtMs: number | null }[],
);
const getLoopStatus = vi.fn();
const readActiveLoopFacts = vi.fn();
const getSessionBrief = vi.fn();
const getPresence = vi.fn();
const readInbox = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const readWatermark = vi.fn(async (..._a: unknown[]) => ({ messages_since_ts: '' }));
const orgSql = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const currentContextTokensForOwner = vi.fn(async (..._a: unknown[]) => null as number | null);
const defaultCompactionLimitForSpec = vi.fn(
  (..._a: Parameters<typeof import('../../agent-config-constants').defaultCompactionLimitForSpec>) => 100,
);
const listActiveAwaits = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const probeWakeReachability = vi.fn(async (..._a: unknown[]) => ({
  reachable: true,
  channel: 'inject',
  durableWhileAlive: true,
  summary: 'ok',
}));
const getModes = vi.fn(async (..._a: unknown[]) => [] as unknown[]);
const selfCompactionAvailability = vi.fn(
  (..._a: Parameters<typeof import('../../events/await/psu-pty-discovery').selfCompactionAvailability>) => ({
    available: false,
  }),
);
const readFleetWindDownLoopEndAuthorization = vi.fn(async (..._a: unknown[]) => null as boolean | null);
const withBoundedTimeout = vi.fn(
  async (..._a: unknown[]): Promise<{ value: unknown; degraded: boolean; elapsedMs: number }> => ({
    value: undefined,
    degraded: false,
    elapsedMs: 0,
  }),
);
const listVerifiedWaitTakeoversForSubscribers = vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []);
const readFrozenRepairMarker = vi.hoisted(() => vi.fn());
const unresolvedPlanDecisionRefs = vi.hoisted(() => vi.fn());
const resolveCurrentTurnStamp = vi.hoisted(() => vi.fn());
const verifyTurnRefs = vi.hoisted(() => vi.fn());
const readSuccessfulActionInvocations = vi.hoisted(() => vi.fn());
const renderCarryNoteMock = vi.hoisted(() =>
  vi.fn((fields: Record<string, string | undefined>) => 'RENDERED:' + JSON.stringify(fields)),
);
// Mock the STORE fns; a sentinel renderCarryNote keeps the routing tests about ROUTING
// (structured → render, raw → passthrough), not renderCarryNote's exact output. The pure
// walls machinery (splitCarryNoteWalls / withCarryNoteWalls / normalizeWallEntries) stays
// REAL via importOriginal — the P-006 merge tests below pin the tool's contract around it.
//
// WI-6813: the tool now writes through setLoopCarryNoteWithPrior and performs the
// walls/checks merge INSIDE that call's `transform` (atomic with the write) rather
// than caller-side. The double below therefore RUNS the real transform against the
// prior `getLoopCarryNote` is configured with, then records the transform's OUTPUT on
// the `setLoopCarryNote` spy — so every assertion in this suite still reads
// `setLoopCarryNote.mock.calls[0][1]` as "the note that was actually stored", and the
// merge under test is genuinely exercised rather than stubbed past.
// When set, the prior the STORE hands the transform from its locked row — which is
// deliberately allowed to differ from what `getLoopCarryNote` returns, so a test can
// simulate a concurrent writer landing where the old caller-side read → merge → write
// had its race window.
let storePriorOverride: string | null | undefined;
// WI-7124: what the STORE actually persisted on the last write — the fixture for the new
// verify-read (getLoopCarryNoteWithMeta), so every PRE-EXISTING test in this suite (which
// only ever configures setLoopCarryNote's return value) automatically gets a verify-read
// that AGREES with it, with zero changes needed at each call site. A test that wants to
// exercise the checkpoint_verify_failed path overrides getLoopCarryNoteWithMeta directly
// (see the WI-7124 describe block below).
let lastStoredNote: string | null = null;
const setLoopCarryNoteWithPrior = vi.fn(
  async (
    ref: unknown,
    note: unknown,
    // Derived from the real signature, not a hand-written subset: a narrower
    // literal here drifts silently the moment carry-note grows an option, and
    // reds the fleet gate from a file nobody edited.
    opts?: Parameters<typeof import('../../carry-note').setLoopCarryNoteWithPrior>[2],
    // The SAME rule as the args above, applied to the RETURN — which had been
    // left as an inferred literal (`{ stored, priorLength }`). That literal
    // drifted the moment SetCarryNoteResult grew `blockedReason` / `conflict`,
    // and red the fleet gate from a file nobody edited: exactly the failure the
    // comment above was written to prevent. Derive it from the real signature.
  ): Promise<Awaited<ReturnType<typeof import('../../carry-note').setLoopCarryNoteWithPrior>>> => {
    const prior =
      storePriorOverride !== undefined ? storePriorOverride : (((await getLoopCarryNote()) as string | null) ?? null);
    const merged = opts?.transform
      ? opts.transform(prior, note as string | null | undefined)
      : (note as string | null | undefined);
    const stored = await setLoopCarryNote(ref, merged);
    lastStoredNote = (stored as string | null | undefined) ?? null;
    return { stored, priorLength: (prior ?? '').length };
  },
);
const getLoopCarryNoteWithMeta = vi.fn(async (..._a: unknown[]): Promise<import('../../carry-note').LoopCarryNoteWithMeta> => ({
  note: lastStoredNote,
  updatedAtMs: lastStoredNote !== null ? Date.now() : null,
}));
vi.mock('../../carry-note', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  setLoopCarryNote: (...a: unknown[]) => setLoopCarryNote(...a),
  // Derive the tuple from the real signature rather than hardcoding one: a
  // hardcoded `[unknown, unknown, never]` silently drifts the moment the
  // signature changes, and reds the fleet gate from a file nobody edited.
  setLoopCarryNoteWithPrior: (...a: Parameters<typeof import('../../carry-note').setLoopCarryNoteWithPrior>) =>
    setLoopCarryNoteWithPrior(...a),
  getLoopCarryNote: (...a: unknown[]) => getLoopCarryNote(...a),
  listLoopCarryNoteHarnesses: (...a: unknown[]) => listLoopCarryNoteHarnesses(...a),
  listLoopCarryNoteScopes: (...a: unknown[]) => listLoopCarryNoteScopes(...a),
  getLoopCarryNoteWithMeta: (...a: unknown[]) => getLoopCarryNoteWithMeta(...a),
  renderCarryNote: (f: Record<string, string | undefined>) => renderCarryNoteMock(f),
}));
vi.mock('../coordination/roles', () => ({ COORD_ROLES: ['operator'] }));
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-caller', ownerLabel: 'su · caller', workspaceId: 'ws-1' })),
  resolveSelfLiteral: vi.fn((value: string | undefined, callerOwnerId: string) =>
    value === 'self' ? callerOwnerId : value,
  ),
}));
vi.mock('../coordination/presence', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getPresence: (...a: unknown[]) => getPresence(...a),
}));
vi.mock('../coordination/messages', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readInbox: (...a: unknown[]) => readInbox(...a),
}));
vi.mock('../coordination/watermarks', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readWatermark: (...a: unknown[]) => readWatermark(...a),
}));
vi.mock('@papercusp/db-org', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgPg: () => ({ sql: orgSql }),
}));
vi.mock('../../compaction-usage', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  currentContextTokensForOwner: (...a: unknown[]) => currentContextTokensForOwner(...a),
}));
vi.mock('../../agent-config-constants', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  defaultCompactionLimitForSpec: (
    ...a: Parameters<typeof import('../../agent-config-constants').defaultCompactionLimitForSpec>
  ) => defaultCompactionLimitForSpec(...a),
}));
vi.mock('../../modes/store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getModes: (...a: unknown[]) => getModes(...a),
}));
vi.mock('../../events/await/psu-pty-discovery', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  selfCompactionAvailability: (
    ...a: Parameters<typeof import('../../events/await/psu-pty-discovery').selfCompactionAvailability>
  ) => selfCompactionAvailability(...a),
  selfCompactionAvailabilityAsync: async (
    ...a: Parameters<typeof import('../../events/await/psu-pty-discovery').selfCompactionAvailabilityAsync>
  ) => selfCompactionAvailability(...a),
}));
vi.mock('../coordination/tools/continuation-gate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readFleetWindDownLoopEndAuthorization: (...a: unknown[]) => readFleetWindDownLoopEndAuthorization(...a),
}));
vi.mock('../coordination/decision-ref-advisory', () => ({
  unresolvedPlanDecisionRefs: (...a: unknown[]) => unresolvedPlanDecisionRefs(...a),
}));
// EI-7734 fallout: checkpoint.ts now routes EVERY no-armed-routine fallback through this
// mock (previously a raw ctx.harnessSlug check short-circuited before ever calling it), so
// a static `() => 'home-hive'` that ignores its args broke every test asserting an explicit
// harness/ctx value wins — it silently returned 'home-hive' regardless of what was passed.
// Mirror the real resolvePotHomeSlug's precedence (explicit arg > ctx slug > 'home-hive'
// env-fallback stand-in) so the mock actually honors the inputs it's given.
vi.mock('../../pot/wake', () => ({
  resolvePotHomeSlug: vi.fn((explicit?: string | null, ctxSlug?: string | null) => {
    const concrete = (s?: string | null) => (s && s !== '*' ? s : undefined);
    return concrete(explicit) ?? concrete(ctxSlug) ?? 'home-hive';
  }),
}));
// WI-2148: loop:checkpoint resolves its default harness from the ACTIVE routine
// (getLoopStatus), so it matches whatever the cold-wake reader resolves. An explicit
// harness is only a fallback when no routine is active; otherwise a transient project
// scope must not create a verified note invisible to the cold reader. Most tests have no
// armed routine (null), so they fall through to the old arg/ctx/home-hive chain.
vi.mock('../../harness/routines/loop', () => ({
  getLoopStatus: (...a: unknown[]) => getLoopStatus(...a),
  readActiveLoopFacts: (...a: unknown[]) => readActiveLoopFacts(...a),
}));
vi.mock('../../session-brief', () => ({ getSessionBrief: (...a: unknown[]) => getSessionBrief(...a) }));
vi.mock('../../bounded-timeout', () => ({
  withBoundedTimeout: (...a: unknown[]) => withBoundedTimeout(...a),
}));
vi.mock('../../events/await/store', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listVerifiedWaitTakeoversForSubscribers: (...a: unknown[]) => listVerifiedWaitTakeoversForSubscribers(...a),
  listActiveAwaits: (...a: unknown[]) => listActiveAwaits(...a),
}));
vi.mock('../../events/await/wake-reachability', () => ({
  probeWakeReachability: (...a: unknown[]) => probeWakeReachability(...a),
}));
vi.mock('../../release/frozen-repair-edit-marker', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../release/frozen-repair-edit-marker')>()),
  readFrozenRepairMarker,
}));
vi.mock('../../turn-provenance/turn-ref', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveCurrentTurnStamp: (...a: unknown[]) => resolveCurrentTurnStamp(...a),
  verifyTurnRefs: (...a: unknown[]) => verifyTurnRefs(...a),
}));
vi.mock('../../carry-surface-action-proof', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readSuccessfulActionInvocations: (...a: unknown[]) => readSuccessfulActionInvocations(...a),
}));
// P-005 / D-030 (7). The suite-wide withBoundedTimeout double never runs the guard's
// work, so this spy is reached only by tests that route its label through for real.
const checkFleetZeroWorkers = vi.fn(
  async (..._a: unknown[]): Promise<import('../../fleet/fleet-zero-workers-guard').FleetZeroWorkersVerdict> => ({
    action: 'allow',
  }),
);
vi.mock('../../fleet/fleet-zero-workers-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../fleet/fleet-zero-workers-guard')>()),
  checkFleetZeroWorkers: (...a: unknown[]) => checkFleetZeroWorkers(...a),
}));

const checkpointModule = await import('./checkpoint');
const tool = checkpointModule.default;
const { classifyLoopNextWake, loopGuaranteesNextWake } = checkpointModule;
// REAL (the carry-note mock above spreads importOriginal) — used to build prior notes
// through the same renderer the store persists, rather than a drift-prone literal.
const {
  mergeCarryRows,
  CARRY_CAP_HARD_MULTIPLE,
  CARRY_NOTE_MAX_CHECKS,
  CARRY_NOTE_MAX_WALLS,
  CARRY_ROW_SOFT_CAPS,
  CARRY_ROW_ID_MAX,
  shortCarryHash,
  splitCarryNoteChecks,
  splitCarryNoteWalls,
  withCarryNoteChecks,
  withCarryNoteWalls,
} = await import('../../carry-note');

type Out = { content: { text: string }[]; isError?: boolean };
const parse = (x: unknown) => (tool.args as { parse: (x: unknown) => unknown }).parse(x);
const call = (args: Record<string, unknown>, ctx: unknown = { harnessSlug: 'papercusp', workspaceId: 'ws-1' }) =>
  tool.handler(parse(args) as never, ctx as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);

beforeEach(() => {
  // Existing scope fixtures also describe the lean routine facts. Tests that
  // distinguish telemetry availability override this independently below.
  readActiveLoopFacts.mockImplementation((...args: unknown[]) => getLoopStatus(...args));
  vi.clearAllMocks();
  storePriorOverride = undefined; // default: the store's prior IS getLoopCarryNote's value
  lastStoredNote = null; // WI-7124: reset the verify-read fixture between tests
  setLoopCarryNote.mockResolvedValue('stored-note');
  getLoopCarryNote.mockResolvedValue(null); // default: no prior note ⇒ no walls to carry
  getLoopStatus.mockResolvedValue(null); // default: no armed routine found
  resolveCurrentTurnStamp.mockResolvedValue(null);
  verifyTurnRefs.mockResolvedValue([]);
  readSuccessfulActionInvocations.mockResolvedValue([]);
  getSessionBrief.mockResolvedValue(null); // default: no durable coord:orient scope found
  getPresence.mockResolvedValue(null);
  readInbox.mockResolvedValue([]);
  readWatermark.mockResolvedValue({ messages_since_ts: '' });
  orgSql.mockResolvedValue([]);
  currentContextTokensForOwner.mockResolvedValue(null);
  defaultCompactionLimitForSpec.mockReturnValue(100);
  listActiveAwaits.mockResolvedValue([]);
  probeWakeReachability.mockResolvedValue({
    reachable: true,
    channel: 'inject',
    durableWhileAlive: true,
    summary: 'ok',
  });
  getModes.mockResolvedValue([]);
  selfCompactionAvailability.mockReturnValue({ available: false });
  readFleetWindDownLoopEndAuthorization.mockResolvedValue(null);
  withBoundedTimeout.mockImplementation(async (work: unknown, options: unknown) => {
    const label = (options as { label?: string }).label;
    if (label === 'loop:checkpoint armed-routine scope probe' || label === 'loop:checkpoint session-scope read') {
      try {
        return {
          value: await (work as () => Promise<unknown>)(),
          degraded: false,
          elapsedMs: 0,
        };
      } catch (error) {
        return {
          value: null, degraded: true, reason: 'error', elapsedMs: 0,
          errorMessage: error instanceof Error ? error.message : String(error),
        };
      }
    }
    if (label === 'loop:checkpoint decision-ref advisory') {
      try {
        return {
          value: await (work as () => Promise<unknown>)(),
          degraded: false,
          elapsedMs: 0,
        };
      } catch {
        return { value: undefined, degraded: true, elapsedMs: 0 };
      }
    }
    if (label === 'carry-provenance-stamp') {
      return { value: [[], null], degraded: false, elapsedMs: 0 };
    }
    return { value: undefined, degraded: false, elapsedMs: 0 };
  });
  listVerifiedWaitTakeoversForSubscribers.mockResolvedValue([]);
  unresolvedPlanDecisionRefs.mockResolvedValue(undefined);
  readFrozenRepairMarker.mockReset();
  readFrozenRepairMarker.mockReturnValue(null);
});

describe('loopGuaranteesNextWake — dead-man-aware continuation evidence', () => {
  const loop = (overrides: Record<string, unknown> = {}) =>
    ({
      active: true,
      armedAt: '2026-08-25T04:00:00.000Z',
      firesSinceArm: 0,
      intervalSec: 300,
      maxDurationSec: null,
      maxFires: null,
      nextFireAt: null,
      fireStarved: false,
      ...overrides,
    }) as never;

  it('accepts an active unbounded loop and rejects an inactive one', () => {
    expect(loopGuaranteesNextWake(loop(), Date.parse('2026-08-25T04:30:00.000Z'))).toBe(true);
    expect(loopGuaranteesNextWake(loop({ active: false }), Date.parse('2026-08-25T04:30:00.000Z'))).toBe(false);
    expect(classifyLoopNextWake(loop(), Date.parse('2026-08-25T04:30:00.000Z'))).toEqual({
      guaranteed: true,
      reason: null,
    });
    expect(classifyLoopNextWake(loop({ active: false }), Date.parse('2026-08-25T04:30:00.000Z'))).toEqual({
      guaranteed: false,
      reason: 'no-active-loop',
    });
  });

  it('mirrors the arm-relative max-fires boundary that withholds the next delivery', () => {
    expect(loopGuaranteesNextWake(loop({ firesSinceArm: 11, maxFires: 12 }))).toBe(true);
    expect(loopGuaranteesNextWake(loop({ firesSinceArm: 12, maxFires: 12 }))).toBe(false);
    expect(classifyLoopNextWake(loop({ firesSinceArm: 12, maxFires: 12 }))).toEqual({
      guaranteed: false,
      reason: 'max-fires-exhausted',
    });
  });

  it('rejects a parked loop when its earliest post-settle fire falls beyond max-duration', () => {
    const now = Date.parse('2026-08-25T09:58:00.000Z');
    expect(loopGuaranteesNextWake(loop({ maxDurationSec: 21_600 }), now)).toBe(false);
    expect(loopGuaranteesNextWake(loop({ maxDurationSec: 21_900 }), now)).toBe(true);
  });

  it('uses a concrete scheduled fire when present and fails closed without arm-time evidence', () => {
    const now = Date.parse('2026-08-25T09:00:00.000Z');
    expect(loopGuaranteesNextWake(loop({ maxDurationSec: 21_600, nextFireAt: '2026-08-25T10:01:00.000Z' }), now)).toBe(
      false,
    );
    expect(loopGuaranteesNextWake(loop({ maxDurationSec: 21_600, armedAt: null }), now)).toBe(false);
    expect(loopGuaranteesNextWake(loop({ maxDurationSec: 21_600, intervalSec: null }), now)).toBe(false);
  });

  // EI-22089924844237484 — a third dead-man shape distinct from both branches above:
  // an active, UN-PARKED loop whose current arm has produced zero fires despite the
  // engine having had at least two interval-sized opportunities, with a concrete
  // nextFireAt already in the past. Neither the max-fires nor max-duration branch
  // above covers this (both need bounds configured; this loop has none), and neither
  // `stalled` nor cadence-drift covers it either (both require evidence this loop
  // never accrues while the whole routine engine is down).
  it('rejects an armed, un-parked loop that missed >=2 expected opportunities with zero fires and an overdue nextFireAt', () => {
    const now = Date.parse('2026-08-25T04:20:00.000Z'); // armedAt + 20min, interval 5min => 4 expected
    expect(
      loopGuaranteesNextWake(
        loop({
          parked: false,
          fireStarved: true,
          expectedFiresSinceArm: 4,
          nextFireAt: '2026-08-25T04:05:00.000Z', // overdue by 15min
        }),
        now,
      ),
    ).toBe(false);
    expect(
      classifyLoopNextWake(
        loop({
          parked: false,
          fireStarved: true,
          expectedFiresSinceArm: 4,
          nextFireAt: '2026-08-25T04:05:00.000Z',
        }),
        now,
      ),
    ).toEqual({ guaranteed: false, reason: 'fire-starved' });
  });

  it('does not reclassify a suppressed-redundant wake as fire-starved when loop status says healthy', () => {
    const now = Date.parse('2026-08-25T04:20:00.000Z');
    const healthyLoop = loop({
      parked: false,
      fireStarved: false,
      firesSinceArm: 0,
      expectedFiresSinceArm: 4,
      nextFireAt: '2026-08-25T04:05:00.000Z',
      lastWakeChannel: 'suppressed-redundant',
      lastWakeStatus: 'delivered',
      lastWakeAt: '2026-08-25T04:18:00.000Z',
      lastFiredAt: '2026-08-25T04:17:00.000Z',
      lastLoopTurnAt: '2026-08-25T04:19:00.000Z',
      lastRealTurnAt: '2026-08-25T04:19:00.000Z',
    });

    expect(classifyLoopNextWake(healthyLoop, now)).toEqual({ guaranteed: true, reason: null });
    expect(loopGuaranteesNextWake(healthyLoop, now)).toBe(true);
  });

  it('does not spuriously reject a freshly-armed loop that has not yet reached 2 expected opportunities', () => {
    const now = Date.parse('2026-08-25T04:06:00.000Z'); // armedAt + 6min, interval 5min => 1 expected
    expect(
      loopGuaranteesNextWake(
        loop({
          parked: false,
          expectedFiresSinceArm: 1,
          nextFireAt: '2026-08-25T04:05:00.000Z', // overdue, but only 1 opportunity missed
        }),
        now,
      ),
    ).toBe(true);
  });

  it('does not reject an overdue-but-parked loop (mid-turn, covered by the stalled signal instead)', () => {
    const now = Date.parse('2026-08-25T04:20:00.000Z');
    expect(
      loopGuaranteesNextWake(
        loop({
          parked: true,
          expectedFiresSinceArm: 4,
          nextFireAt: null, // parked loops carry no concrete nextFireAt
        }),
        now,
      ),
    ).toBe(true);
  });

  it('does not reject a healthy loop whose nextFireAt is still in the future', () => {
    const now = Date.parse('2026-08-25T04:20:00.000Z');
    expect(
      loopGuaranteesNextWake(
        loop({
          parked: false,
          expectedFiresSinceArm: 4,
          nextFireAt: '2026-08-25T04:25:00.000Z', // still ahead of now
        }),
        now,
      ),
    ).toBe(true);
  });

  it('rejects a delivered fire reconciled as no-loop-turn even before starvation counters trip', () => {
    expect(
      classifyLoopNextWake(
        loop({
          lastDeliveryOutcome: 'loop-delivered-wake-no-loop-turn',
          lastWakeStatus: 'delivered',
          fireStarved: false,
          turnsStalled: false,
        }),
      ),
    ).toEqual({ guaranteed: false, reason: 'last-fire-no-loop-turn' });
    expect(
      loopGuaranteesNextWake(
        loop({ lastDeliveryOutcome: 'loop-delivered-wake-no-loop-turn', turnsStalled: false }),
      ),
    ).toBe(false);
  });

  it.each(['coalesced', 'inbox'])('EI-25610308076916440: %s is not loop execution proof', (lastWakeChannel) => {
    const dispatch = '2026-10-10T17:04:26.638Z';
    const wake = {
      lastDeliveryOutcome: 'queued', lastWakeStatus: 'delivered', lastWakeChannel,
      lastWakeCreatedAt: dispatch, lastWakeAt: '2026-10-10T17:08:43.391Z',
      lastFiredAt: '2026-10-10T17:04:13.260Z', lastLoopTurnAt: null,
      lastRealTurnAt: '2026-10-10T17:09:00.000Z', lastSuppressedWakeLoopTurnAt: null,
    };
    expect(classifyLoopNextWake(loop(wake))).toEqual({ guaranteed: false, reason: 'last-fire-no-loop-turn' });
    // A genuine loop turn clears the failure even if delivery was settled later.
    expect(classifyLoopNextWake(loop({ ...wake, lastSuppressedWakeLoopTurnAt: '2026-10-10T17:05:00.000Z' })))
      .toEqual({ guaranteed: true, reason: null });
    expect(classifyLoopNextWake(loop({ ...wake, lastSuppressedWakeLoopTurnAt: dispatch })))
      .toEqual({ guaranteed: false, reason: 'last-fire-no-loop-turn' });
  });

  it.each(['queued', 'loop-armed'])('EI-25407823334233635: %s cannot erase a suppressed loop delivery', (lastDeliveryOutcome) => {
    expect(classifyLoopNextWake(loop({
      lastDeliveryOutcome,
      lastWakeStatus: 'delivered',
      lastWakeChannel: 'suppressed-redundant',
      lastWakeAt: '2026-10-08T10:57:26.612Z',
      lastFiredAt: '2026-10-08T10:19:34.899Z',
      lastLoopTurnAt: '2026-10-08T04:27:17.205Z',
      lastRealTurnAt: '2026-10-08T10:58:00.000Z',
    }))).toEqual({ guaranteed: false, reason: 'last-fire-no-loop-turn' });
  });

  it.each([null, 'invalid', '2026-10-08T10:57:26.611Z', '2026-10-08T10:57:26.612Z'])(
    'EI-25407823334233635: suppressed delivery needs a strictly later loop turn (%s)',
    (lastLoopTurnAt) => {
      expect(classifyLoopNextWake(loop({
        lastDeliveryOutcome: 'queued',
        lastWakeStatus: 'delivered',
        lastWakeChannel: 'suppressed-redundant',
        lastWakeAt: '2026-10-08T10:57:26.612Z',
        lastFiredAt: '2026-10-08T10:19:34.899Z',
        lastLoopTurnAt,
      })).guaranteed).toBe(false);
    },
  );

  it('EI-25407823334233635: clears suppression only after the latest delivery and fire', () => {
    const suppressed = {
      lastDeliveryOutcome: 'queued',
      lastWakeStatus: 'delivered',
      lastWakeChannel: 'suppressed-redundant',
      lastWakeAt: '2026-10-08T10:57:26.612Z',
      lastFiredAt: '2026-10-08T10:58:00.000Z',
    };
    expect(classifyLoopNextWake(loop({
      ...suppressed,
      lastLoopTurnAt: '2026-10-08T10:57:30.000Z',
    })).guaranteed).toBe(false);
    expect(classifyLoopNextWake(loop({
      ...suppressed,
      lastLoopTurnAt: '2026-10-08T10:58:00.001Z',
    }))).toEqual({ guaranteed: true, reason: null });
    expect(classifyLoopNextWake(loop({
      ...suppressed,
      lastWakeAt: null,
      lastLoopTurnAt: '2026-10-08T10:58:00.001Z',
    })).guaranteed).toBe(false);
  });

  it('EI-25528456701258561: counts a loop turn after dispatch even when it precedes delivery settlement', () => {
    const delayedSettlement = {
      lastWakeStatus: 'delivered',
      lastWakeChannel: 'suppressed-redundant',
      lastWakeAt: '2026-10-09T20:21:04.131Z',
      lastWakeCreatedAt: '2026-10-09T20:20:14.031Z',
      lastFiredAt: '2026-10-09T20:20:19.406Z',
      lastLoopTurnAt: '2026-10-09T20:20:24.455Z',
    };
    expect(classifyLoopNextWake(loop(delayedSettlement))).toEqual({ guaranteed: true, reason: null });
    // Legacy inputs without the dispatch clock retain the fail-closed combined-clock behavior.
    expect(classifyLoopNextWake(loop({ ...delayedSettlement, lastWakeCreatedAt: undefined }))).toEqual({
      guaranteed: false,
      reason: 'last-fire-no-loop-turn',
    });
  });

  it('EI-25552514553135466: preserves suppressed-wake recovery proof across a later re-arm', () => {
    const suppressed = {
      lastWakeStatus: 'delivered',
      lastWakeChannel: 'suppressed-redundant',
      lastWakeAt: '2026-10-10T01:36:10.215Z',
      lastWakeCreatedAt: '2026-10-10T01:35:12.101Z',
      lastFiredAt: '2026-10-10T01:35:04.575Z',
      // The loop turn completed after dispatch/fire, then the owner re-armed at 02:03Z.
      // The arm-scoped clock is therefore empty even though the old delivery recovered.
      lastLoopTurnAt: null,
      lastSuppressedWakeLoopTurnAt: '2026-10-10T01:47:00.000Z',
    };

    expect(classifyLoopNextWake(loop(suppressed))).toEqual({ guaranteed: true, reason: null });
    expect(classifyLoopNextWake(loop({
      ...suppressed,
      lastSuppressedWakeLoopTurnAt: '2026-10-10T01:35:12.101Z',
    }))).toEqual({ guaranteed: false, reason: 'last-fire-no-loop-turn' });
    expect(classifyLoopNextWake(loop({
      ...suppressed,
      lastSuppressedWakeLoopTurnAt: null,
    }))).toEqual({ guaranteed: false, reason: 'last-fire-no-loop-turn' });
  });

  it('does not treat an await-blocking withheld fire as an uncompleted suppressed wake', () => {
    const priorSuppressedWake = {
      lastWakeStatus: 'delivered',
      lastWakeChannel: 'suppressed-redundant',
      lastWakeAt: '2026-10-09T18:15:44.000Z',
      lastLoopTurnAt: '2026-10-09T18:28:21.000Z',
      lastFiredAt: '2026-10-09T18:33:08.309Z',
      lastWithheldAt: '2026-10-09T18:33:13.522Z',
      lastWithheldReason: 'await-blocking',
    };

    // The 18:15 suppressed wake already produced a loop turn at 18:28. The 18:33
    // fire never went out: await suppression re-armed it for the await's resume threshold.
    expect(classifyLoopNextWake(loop(priorSuppressedWake))).toEqual({ guaranteed: true, reason: null });
    expect(
      classifyLoopNextWake(
        loop({ ...priorSuppressedWake, lastWithheldAt: priorSuppressedWake.lastFiredAt }),
      ),
    ).toEqual({ guaranteed: true, reason: null });

    // A stale or differently-categorized withhold cannot erase a later delivery failure.
    expect(
      classifyLoopNextWake(
        loop({ ...priorSuppressedWake, lastWithheldAt: '2026-10-09T18:33:08.308Z' }),
      ),
    ).toEqual({ guaranteed: false, reason: 'last-fire-no-loop-turn' });
    expect(
      classifyLoopNextWake(
        loop({ ...priorSuppressedWake, lastWithheldReason: 'fire-gate' }),
      ),
    ).toEqual({ guaranteed: false, reason: 'last-fire-no-loop-turn' });
    expect(
      classifyLoopNextWake(
        loop({ ...priorSuppressedWake, lastLoopTurnAt: '2026-10-09T18:15:44.000Z' }),
      ),
    ).toEqual({ guaranteed: false, reason: 'last-fire-no-loop-turn' });
  });

  it('clears the no-loop-turn failure only with a strictly later per-fire completion proof', () => {
    const lastFiredAt = '2026-10-03T05:00:00.000Z';
    const failure = {
      lastDeliveryOutcome: 'loop-delivered-wake-no-loop-turn',
      lastFiredAt,
    };
    expect(classifyLoopNextWake(loop(failure)).reason).toBe('last-fire-no-loop-turn');
    expect(
      classifyLoopNextWake(
        loop({
          ...failure,
          lastFailedFireLoopTurnCompletedAt: lastFiredAt,
        }),
      ).reason,
    ).toBe('last-fire-no-loop-turn');
    expect(
      classifyLoopNextWake(
        loop({
          ...failure,
          lastFailedFireLoopTurnCompletedAt: '2026-10-03T04:59:59.999Z',
        }),
      ).reason,
    ).toBe('last-fire-no-loop-turn');
    expect(
      classifyLoopNextWake(
        loop({
          ...failure,
          lastFailedFireLoopTurnCompletedAt: '2026-10-03T05:00:00.001Z',
        }),
      ),
    ).toEqual({ guaranteed: true, reason: null });
  });

  // P-013 / RSR-P-013-C (review-system-rework-reduction-2026-09-23), EI-24023838400909760:
  // a cold loop re-armed and was told rewakeGuaranteed:true while its previous fire had
  // parked "no injectable psu host"; the next fire parked identically and the session went
  // dark. An active in-bounds loop is not a guarantee when its delivery path is broken.
  describe('a loop whose last fire PARKED undelivered is not a re-wake guarantee', () => {
    const NO_HOST = 'eligible cold loop wake has no injectable psu host — parked without resume to preserve the fresh-context boundary';

    it('reports last-fire-parked for a parked no-host cold fire', () => {
      expect(classifyLoopNextWake(loop({ lastWakeStatus: 'parked', lastWakeError: NO_HOST }))).toEqual({
        guaranteed: false,
        reason: 'last-fire-parked',
      });
      expect(loopGuaranteesNextWake(loop({ lastWakeStatus: 'parked', lastWakeError: NO_HOST }))).toBe(false);
    });

    it('also rejects other undeliverable park shapes (alive but not an injectable pty)', () => {
      expect(
        classifyLoopNextWake(
          loop({ lastWakeStatus: 'parked', lastWakeError: 'session pid 42 alive but not an injectable managed pty for this subscriber' }),
        ).reason,
      ).toBe('last-fire-parked');
    });

    it('still guarantees when the last fire was delivered, or its park already holds a durable retry', () => {
      expect(classifyLoopNextWake(loop({ lastWakeStatus: 'delivered', lastWakeError: null })).guaranteed).toBe(true);
      expect(
        classifyLoopNextWake(
          loop({
            lastWakeStatus: 'parked',
            lastWakeError: 'psu-host accepted: delivery accepted before turn-start proof; retry remains durable',
          }),
        ).guaranteed,
      ).toBe(true);
      // Legacy inputs without the wake fields keep their old verdict.
      expect(classifyLoopNextWake(loop()).guaranteed).toBe(true);
    });

    it('a dead-man bound still wins over the park diagnosis (ordering is stable)', () => {
      expect(
        classifyLoopNextWake(loop({ firesSinceArm: 12, maxFires: 12, lastWakeStatus: 'parked', lastWakeError: NO_HOST })).reason,
      ).toBe('max-fires-exhausted');
    });
  });

  it('does not reject once fires have actually been delivered, even with an overdue nextFireAt', () => {
    const now = Date.parse('2026-08-25T04:20:00.000Z');
    expect(
      loopGuaranteesNextWake(
        loop({
          parked: false,
          firesSinceArm: 3,
          expectedFiresSinceArm: 4,
          nextFireAt: '2026-08-25T04:05:00.000Z',
        }),
        now,
      ),
    ).toBe(true);
  });
});

describe('loop:checkpoint — the loop carry-note producer', () => {
  it('rejects PostgreSQL-invalid U+0000 text before carry-note persistence', () => {
    const nul = `before${String.fromCharCode(0)}after`;

    expect(() => parse({ note: nul })).toThrow(/U\+0000/);
    expect(() => parse({ checkpoint: { did: nul } })).toThrow(/U\+0000/);
    expect(setLoopCarryNoteWithPrior).not.toHaveBeenCalled();
    expect(setLoopCarryNote).not.toHaveBeenCalled();
  });

  it('distinguishes the 48-row input ceiling from the 12-row durable cap in its schema', () => {
    const shape = (tool.args as unknown as { shape: Record<string, { description?: string }> }).shape;

    expect(shape.checks?.description).toContain('Durable storage is capped at 12 check rows');
    expect(shape.checks?.description).toContain('accepts up to 48 rows as a hard validation/normalization ceiling');
    expect(shape.rowsMode?.description).toContain('Durable caps are 12 walls and 12 checks');
  });

  it('refuses the historical staging-candidate instruction before calling the carry-note store', async () => {
    readFrozenRepairMarker.mockReturnValue({
      candidate: 'c'.repeat(40),
      repairHead: 'r'.repeat(40),
      phase: 'repair-in-progress',
      failingPaths: [],
      updatedAtMs: 1_788_763_360_000,
      admittedPaths: [],
      legs: [],
    });

    const out = await call({
      note: 'Then pin whatever staging resolves to at that instant, still never a quoted sha.',
    });

    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({
      ok: false,
      error: 'frozen_candidate_lineage_violation',
      surface: 'loop-checkpoint',
      unsafeSource: 'staging',
      liveIdentity: {
        candidate: 'c'.repeat(40),
        repairHead: 'r'.repeat(40),
        queueRevision: 1_788_763_360_000,
      },
    });
    expect(setLoopCarryNoteWithPrior).not.toHaveBeenCalled();
    expect(setLoopCarryNote).not.toHaveBeenCalled();
  });

  it('allows the exact :3170 staging-sync warning text in the carry note', async () => {
    readFrozenRepairMarker.mockReturnValue({
      candidate: 'c'.repeat(40),
      repairHead: 'r'.repeat(40),
      phase: 'repair-in-progress',
      failingPaths: [],
      updatedAtMs: 1_788_763_360_000,
      admittedPaths: [],
      legs: [],
    });

    const out = await call({
      note: 'staging candidate c571e22c9e @15:29Z contains it + all 6 fix files, blob-equal to staging)',
    });

    expect(out.isError).toBeUndefined();
    expect(body(out)).toMatchObject({ ok: true });
    expect(setLoopCarryNoteWithPrior).toHaveBeenCalledTimes(1);
    expect(setLoopCarryNote).toHaveBeenCalledTimes(1);
  });

  it('allows descriptive release-source validation prose in the carry note', async () => {
    readFrozenRepairMarker.mockReturnValue({
      candidate: 'c'.repeat(40),
      repairHead: 'r'.repeat(40),
      phase: 'repair-in-progress',
      failingPaths: [],
      updatedAtMs: 1_788_763_360_000,
      admittedPaths: [],
      legs: [],
    });

    const out = await call({
      note:
        'Committing the gitlink would make the worktree clean — and would have broken the next leg: ' +
        "release-local.sh:187-204 binds every cut to ONE full superproject sha (EI-20505417131773854) " +
        "and errors 'release source drift' when current HEAD != the passed sourceSha.",
    });

    expect(out.isError).toBeUndefined();
    expect(body(out)).toMatchObject({ ok: true });
    expect(setLoopCarryNoteWithPrior).toHaveBeenCalledTimes(1);
    expect(setLoopCarryNote).toHaveBeenCalledTimes(1);
  });

  it('allows structured operator-api runtime qualification evidence through the writer guard', async () => {
    readFrozenRepairMarker.mockReturnValue({
      candidate: 'c'.repeat(40),
      repairHead: 'r'.repeat(40),
      phase: 'repair-in-progress',
      failingPaths: [],
      updatedAtMs: 1_788_763_360_000,
      admittedPaths: [],
      legs: [],
    });
    const route = currentBuildTestRoute('operator-api');
    expect(route).not.toBeNull();

    const note = JSON.stringify({
      runtimeQualification: {
        currentBuildTestRoute: route,
        observedRuntime: {
          runtime: 'staging-operator',
          port: 3170,
          buildSha: '2a0b600917',
          evidence: 'Measured request/response on that build.',
        },
        staging: {
          runtime: 'staging-operator',
          role: 'owner',
          buildSha: '2a0b600917',
        },
      },
    });

    const out = await call({ note });

    expect(out.isError).toBeUndefined();
    expect(body(out)).toMatchObject({ ok: true });
    expect(setLoopCarryNoteWithPrior).toHaveBeenCalledTimes(1);
    expect(setLoopCarryNote).toHaveBeenCalledTimes(1);
  });

  it('allows a rows-only merge when the stale instruction exists only in the locked prior', async () => {
    readFrozenRepairMarker.mockReturnValue({
      candidate: 'c'.repeat(40),
      repairHead: 'r'.repeat(40),
      phase: 'repair-in-progress',
      failingPaths: [],
      updatedAtMs: 1_788_763_360_000,
      admittedPaths: [],
      legs: [],
    });
    getLoopCarryNote.mockResolvedValue(
      'Then pin whatever staging resolves to at that instant, still never a quoted sha.',
    );

    const out = await call({ checks: [{ claim: 'the focused unit suite is green' }] });

    expect(out.isError).toBeUndefined();
    expect(body(out)).toMatchObject({ ok: true });
    expect(setLoopCarryNoteWithPrior).toHaveBeenCalledTimes(1);
    expect(setLoopCarryNote).toHaveBeenCalledTimes(1);
  });

  it('allows a diagnostic row that quotes the refusal wording', async () => {
    readFrozenRepairMarker.mockReturnValue({
      candidate: 'c'.repeat(40),
      repairHead: 'r'.repeat(40),
      phase: 'repair-in-progress',
      failingPaths: [],
      updatedAtMs: 1_788_763_360_000,
      admittedPaths: [],
      legs: [],
    });

    const out = await call({
      checks: [
        {
          claim: 'The refusal says staging was selected as the judged candidate; this row documents the diagnostic.',
        },
      ],
    });

    expect(out.isError).toBeUndefined();
    expect(body(out)).toMatchObject({ ok: true });
    expect(setLoopCarryNote).toHaveBeenCalledTimes(1);
  });

  it('allows an explicit correction to replace the stale prior while the marker remains frozen', async () => {
    readFrozenRepairMarker.mockReturnValue({
      candidate: 'c'.repeat(40),
      repairHead: 'r'.repeat(40),
      phase: 'repair-in-progress',
      failingPaths: [],
      updatedAtMs: 1_788_763_360_000,
      admittedPaths: [],
      legs: [],
    });
    getLoopCarryNote.mockResolvedValue(
      'Then pin whatever staging resolves to at that instant, still never a quoted sha.',
    );

    const out = await call({
      note: 'The earlier instruction to pin current staging/current HEAD was wrong and is retracted.',
    });

    expect(body(out)).toMatchObject({ ok: true });
    expect(setLoopCarryNote).toHaveBeenCalledTimes(1);
  });

  it('returns a retryable structured result when the carry write hits transient PostgreSQL contention', async () => {
    const timeout = new OrgTxnTimeoutError('55P03', new Error('lock timeout'));
    setLoopCarryNoteWithPrior.mockRejectedValueOnce(timeout).mockRejectedValueOnce(timeout);

    const b = body(await call({ did: 'checkpoint before the next cold wake' }));

    expect(b).toMatchObject({ ok: false, error: 'timeout', retryable: true, pgCode: '55P03' });
    expect(b.message).toContain('No carry-note was committed');
    expect(setLoopCarryNoteWithPrior).toHaveBeenCalledTimes(2);
  });

  it('retries a transient carry-write contention timeout before returning success', async () => {
    setLoopCarryNoteWithPrior.mockRejectedValueOnce(
      new OrgTxnTimeoutError('57014', new Error('statement timeout')),
    );

    const b = body(await call({ did: 'retry the checkpoint before the next cold wake' }));

    expect(setLoopCarryNoteWithPrior).toHaveBeenCalledTimes(2);
    expect(b).toMatchObject({ ok: true, verified: true });
  });

  it('opts out of the ambient workspace transaction because the handler owns independent DB scopes', () => {
    expect((tool as unknown as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
  });

  // The default flipped to merge (see the P-013 block below), so what the tool must
  // document flipped with it: the preserving default, and the explicit REPLACE that is
  // now the only way to retire a row. An agent that cannot find the retirement path in
  // the description has no way to drop a stale check at all.
  it('documents the preserving default and the explicit rowsMode retirement path', () => {
    const description = (tool as unknown as { description?: string }).description ?? '';
    const guidance = (tool as unknown as { guidance?: { when?: string } }).guidance?.when ?? '';
    expect(description).toContain("rowsMode:'replace'");
    expect(description).toContain("rowsMode:'merge'");
    expect(description).toMatch(/empty list with replace/i);
    expect(guidance).toContain("rowsMode:'replace'");
    expect(guidance).toMatch(/default merge mode preserves them/i);
  });

  it('guides cold-carry authors to anchor owner directives and completed actions', () => {
    const guidance = (tool as unknown as { guidance?: { when?: string } }).guidance;
    expect(guidance?.when).toContain('[turn:<session>@<iso-ts>]');
    expect(guidance?.when).toMatch(/same-line/i);
    expect(guidance?.when).toMatch(/never invent a ref/i);
    expect(guidance?.when).toContain('[self-imposed]');
  });

  it('guides authors through the cold-successor no-progress tripwire before compaction', () => {
    const description = (tool as unknown as { description?: string }).description ?? '';
    const guidance = (tool as unknown as { guidance?: { when?: string } }).guidance?.when ?? '';
    expect(description).toMatch(/writing it does NOT request a carry-respawn/i);
    expect(description).toContain('session:request-compaction separately');
    expect(guidance).toContain('immediately runnable action');
    expect(guidance).toContain('session:request-compaction');
    expect(guidance).toContain('bounded progress read');
    expect(guidance).toContain('writing this checkpoint alone is not post-note progress');
    expect(guidance).toContain('cold-successor-no-progress');
    expect(guidance).toMatch(/narrow boundary exception/i);
  });

  it('keeps the executable probe target shape visible in guidance and the projected schema', () => {
    type JsonNode = { [key: string]: unknown };
    const rawSchema = z.toJSONSchema(tool.args) as JsonNode;
    const rawChecks = (rawSchema.properties as JsonNode).checks as JsonNode;
    const rawRow = (rawChecks.items as JsonNode).properties as Record<string, JsonNode>;
    const rawProbeDescription = String(rawRow.probe?.description ?? '');

    const projected = lookupByMcpName('loop:checkpoint');
    expect(projected, 'loop:checkpoint must be registered in the projected catalog').toBeDefined();
    const projectedSchema = projected?.inputSchema as JsonNode;
    const projectedChecks = (projectedSchema.properties as JsonNode).checks as JsonNode;
    const projectedRow = (projectedChecks.items as JsonNode).properties as Record<string, JsonNode>;
    const projectedProbeDescription = String(projectedRow.probe?.description ?? '');
    const checksDescription = String(rawChecks.description ?? '');
    const projectedChecksDescription = String(projectedChecks.description ?? '');
    // CheckEntry.sinceMs is server-owned carry metadata: the writer inherits it
    // for existing claims and stamps new claims. Keep it out of both the authoring
    // schema and projected registry so discovery cannot promise a rejected input.
    expect(rawRow).not.toHaveProperty('sinceMs');
    expect(projectedRow).not.toHaveProperty('sinceMs');
    const description = String((tool as unknown as { description?: unknown }).description ?? '');
    const guidance = String((tool as unknown as { guidance?: { when?: unknown } }).guidance?.when ?? '');

    expect(checksDescription).toContain('sinceMs');
    expect(checksDescription).toContain('server-owned');
    expect(checksDescription).toContain('work_items:checkpoint');
    expect(projectedChecksDescription).toContain('sinceMs');
    expect(projectedChecksDescription).toContain('server-owned');
    expect(projectedChecksDescription).toContain('work_items:checkpoint');

    expect(projectedProbeDescription).toBe(rawProbeDescription);
    for (const text of [guidance, rawProbeDescription, projectedProbeDescription]) {
      expect(text).toContain("kind:'tool'");
      expect(text).toContain("kind:'state-cell'");
      expect(text).toContain('schemaRevision');
      expect(text).toContain('args');
    }
    expect(projectedProbeDescription).toMatch(/probe:\{ expect:\.\.\. \}/);
    expect(projectedProbeDescription).toMatch(/omit `probe`.*recheck/i);
  });

  it("guides carry retunes to pass loop:arm's required intervalSec and goal", () => {
    const chaining = (tool as unknown as { guidance?: { chaining?: string } }).guidance?.chaining ?? '';
    expect(chaining).toContain("loop:arm { intervalSec: <number>, goal: <string>, carry: 'cold'|'warm' }");
    expect(chaining).toMatch(/intervalSec and goal are required even when only carry changes/i);
    expect(chaining).not.toContain("loop:arm { carry: 'cold'|'warm' }");
  });

  it('makes carry ownership explicit and keeps carry rejected on loop:checkpoint', () => {
    const description = (tool as unknown as { description?: string }).description ?? '';
    const guidance = (tool as unknown as { guidance?: { when?: string } }).guidance?.when ?? '';

    expect(() => parse({ did: 'checkpointed progress', carry: 'cold' })).toThrow(/unrecognized key/i);
    expect(description).toContain('carry mode belongs to loop:arm');
    expect(description).toContain('does not accept a `carry` argument');
    expect(guidance).toContain('carry mode belongs to loop:arm');
    expect(guidance).toContain('not loop:checkpoint');
    expect(guidance).toContain('do not retry a rejected `carry` argument here');
  });

  it('structured fields → renderCarryNote, keyed by caller ownerId + ctx harness (the loopScope the wake executor reads)', async () => {
    const b = body(
      await call({ did: 'wired producer', left: 'run tests', insight: 'inject wraps note', next: 'vitest' }),
    );
    expect(b).toMatchObject({ ok: true, harness: 'papercusp', ownerId: 'su-caller', cleared: false });
    expect(b.length).toBeGreaterThan(0);
    expect(setLoopCarryNote).toHaveBeenCalledWith(
      { harness: 'papercusp', ownerId: 'su-caller', workspaceId: 'ws-1' },
      'RENDERED:' +
        JSON.stringify({ did: 'wired producer', left: 'run tests', insight: 'inject wraps note', next: 'vitest' }),
    );
  });

  it('marks a bare gate in structured next as self-imposed without suppressing explicit owner claims', async () => {
    const next = 'Do not retry compaction until current host/native-session state shows the prior recovery is no longer in flight.';
    renderCarryNoteMock.mockImplementationOnce((fields) => '## Next action\n' + (fields.next ?? ''));

    const result = body(await call({ next }));

    expect(result.provenanceLint).toBeUndefined();
    expect(setLoopCarryNote.mock.calls[0]?.[1]).toBe('## Next action\n[self-imposed] ' + next);
  });

  it('keeps an explicit owner claim in structured next visible to provenance lint', async () => {
    const next = 'The owner asked me to wait; do not retry compaction until the owner responds.';
    renderCarryNoteMock.mockImplementationOnce((fields) => '## Next action\n' + (fields.next ?? ''));

    const result = body(await call({ next }));

    expect(result.provenanceLint?.matches).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'owner-attribution' })]),
    );
    const stored = String(setLoopCarryNote.mock.calls[0]?.[1] ?? '');
    expect(stored).toContain('⚠ UNVERIFIED OWNER ATTRIBUTION');
    expect(stored).toContain('## Next action\n' + next);
  });

  it('surfaces durable stalled-wait evidence and the takeover remedy in the checkpoint result', async () => {
    const alert = {
      subscriberId: 'su-caller',
      eventKey: 'release:green:papercusp',
      firedAt: '2026-08-13T12:00:00.000Z',
      classification: 'stalled',
      nextAction: 'wake-owner-or-takeover',
      producer: { kind: 'green-checkpoint', id: 'run-42' },
      owner: { ownerId: 'su-producer', workItemId: 'WI-42' },
      checkedAtMs: 42,
      verificationDeadlineMs: 40,
      lastProgressAtMs: 1,
      lastFireAtMs: null,
      evidence: { phase: 'suite' },
      remedy: 'Wake the owner of WI-42; if it does not resume promptly, claim/take over WI-42.',
    } as const;
    listVerifiedWaitTakeoversForSubscribers.mockResolvedValueOnce([alert]);
    // Positional: the takeover read is the 5th bounded call. Before it are the
    // armed-routine scope probe, the P-005 guard, and the two advisory reads.
    withBoundedTimeout
      .mockResolvedValueOnce({ value: undefined, degraded: false, elapsedMs: 0 })
      .mockResolvedValueOnce({ value: undefined, degraded: false, elapsedMs: 0 })
      .mockResolvedValueOnce({ value: undefined, degraded: false, elapsedMs: 0 })
      .mockResolvedValueOnce({ value: undefined, degraded: false, elapsedMs: 0 })
      .mockResolvedValueOnce({ value: [alert], degraded: false, elapsedMs: 1 });

    const b = body(await call({ did: 'checkpointing before takeover', next: 'wake owner' }));

    expect(listVerifiedWaitTakeoversForSubscribers).toHaveBeenCalledWith(['su-caller']);
    expect(b.verifiedWaitTakeovers).toEqual([alert]);
  });

  it('accepts goal as a compatibility alias for next, while explicit next wins', async () => {
    await call({ did: 'made progress', goal: 'run the focused suite' });
    expect(setLoopCarryNote.mock.calls[0]?.[1]).toBe(
      'RENDERED:' +
        JSON.stringify({ did: 'made progress', left: undefined, insight: undefined, next: 'run the focused suite' }),
    );

    setLoopCarryNote.mockClear();
    await call({ goal: 'stale alias', next: 'authoritative next action' });
    expect(setLoopCarryNote.mock.calls[0]?.[1]).toBe(
      'RENDERED:' +
        JSON.stringify({ did: undefined, left: undefined, insight: undefined, next: 'authoritative next action' }),
    );
  });

  it('accepts historical keyInsight/nextAction aliases, while canonical fields win', async () => {
    const b = body(
      await call({
        did: 'made progress',
        keyInsight: 'the stale caller vocabulary is still recoverable',
        nextAction: 'retry with the canonical field names',
      }),
    );

    expect(b).toMatchObject({ ok: true, cleared: false });
    expect(setLoopCarryNote.mock.calls[0]?.[1]).toBe(
      'RENDERED:' +
        JSON.stringify({
          did: 'made progress',
          left: undefined,
          insight: 'the stale caller vocabulary is still recoverable',
          next: 'retry with the canonical field names',
        }),
    );

    setLoopCarryNote.mockClear();
    await call({
      insight: 'canonical insight',
      keyInsight: 'stale insight alias',
      next: 'canonical next',
      nextAction: 'stale next alias',
      goal: 'older goal alias',
    });
    expect(setLoopCarryNote.mock.calls[0]?.[1]).toBe(
      'RENDERED:' +
        JSON.stringify({
          did: undefined,
          left: undefined,
          insight: 'canonical insight',
          next: 'canonical next',
        }),
    );
  });

  it('accepts the workItem compatibility key without changing loop-note scope', async () => {
    const b = body(
      await call({
        workItem: 'EI-21600742704531274',
        did: 'accepted the shared loop/work-item payload shape',
        next: 'run the focused regression',
      }),
    );

    expect(b).toMatchObject({ ok: true, harness: 'papercusp', ownerId: 'su-caller', cleared: false });
    expect(setLoopCarryNote).toHaveBeenCalledWith(
      { harness: 'papercusp', ownerId: 'su-caller', workspaceId: 'ws-1' },
      expect.stringContaining('accepted the shared loop/work-item payload shape'),
    );
  });

  it('accepts the generic checkpoint field as a lossless compatibility alias for raw note', async () => {
    const b = body(await call({ checkpoint: 'legacy generic carry note' }));

    expect(b).toMatchObject({ ok: true, cleared: false });
    expect(setLoopCarryNote.mock.calls[0]?.[1]).toBe('legacy generic carry note');
  });

  it('prefers canonical note over the generic checkpoint alias, including an explicit clear', async () => {
    await call({ note: 'canonical note', checkpoint: 'legacy note' });
    expect(setLoopCarryNote.mock.calls[0]?.[1]).toBe('canonical note');

    setLoopCarryNote.mockClear();
    await call({ note: null, checkpoint: 'legacy note' });
    expect(setLoopCarryNote.mock.calls[0]?.[1]).toBe('');
  });

  it('EI-21949862791784103: accepts an OBJECT-shaped checkpoint alias as the structured carry fields', async () => {
    await call({ checkpoint: { did: 'closed four items', left: 'nothing claimed', next: 'pull the next unit' } });
    expect(setLoopCarryNote.mock.calls[0]?.[1]).toBe(
      'RENDERED:' +
        JSON.stringify({
          did: 'closed four items',
          left: 'nothing claimed',
          insight: undefined,
          next: 'pull the next unit',
        }),
    );

    // The object half aliases the same spellings the top level already accepts.
    setLoopCarryNote.mockClear();
    await call({ checkpoint: { keyInsight: 'aliased insight', goal: 'aliased next' } });
    expect(setLoopCarryNote.mock.calls[0]?.[1]).toBe(
      'RENDERED:' +
        JSON.stringify({ did: undefined, left: undefined, insight: 'aliased insight', next: 'aliased next' }),
    );
  });

  it('EI-21949862791784103: explicit top-level fields win over the object alias', async () => {
    await call({ did: 'authoritative did', checkpoint: { did: 'stale did', left: 'alias-only left' } });
    expect(setLoopCarryNote.mock.calls[0]?.[1]).toBe(
      'RENDERED:' +
        JSON.stringify({
          did: 'authoritative did',
          left: 'alias-only left',
          insight: undefined,
          next: undefined,
        }),
    );
  });

  it('EI-21949862791784103: refuses an unrecognized object shape instead of silently clearing the note', () => {
    // A stray shape must NOT compose an empty note — that is a carry-note CLEAR wearing
    // an alias costume, i.e. silent loss of the successor's only state.
    expect(() => parse({ checkpoint: { summary: 'wrong sibling shape' } })).toThrow(/[Uu]nrecognized key/);
    expect(() => parse({ checkpoint: {} })).toThrow(/at least one of did\/left\/insight\/next/);
    expect(setLoopCarryNote).not.toHaveBeenCalled();
  });

  it('EI-21719647580242620: an explicit null on an optional carry field is omission, not a refusal', async () => {
    // These fields exist to tolerate a payload SHARED with loop:arm (see the workItem and
    // goal describes), and `null` is exactly the shape a shared payload takes for a slot
    // with no value — so `.optional()` refused the case the fields were added to serve.
    expect(() =>
      parse({
        did: 'progress',
        left: null,
        insight: null,
        next: null,
        keyInsight: null,
        nextAction: null,
        goal: null,
        workItem: null,
        learned: null,
      }),
    ).not.toThrow();

    // EQUIVALENCE, not mere acceptance: every consumer already coalesces (`args.x ?? …`,
    // `args.workItem?.trim()`), so an explicit null must render the SAME note as omitting
    // the key. Asserting only that it parses would not catch a null that reached the
    // renderer as the literal string "null" or cleared a field it should have left alone.
    await call({ did: 'same', left: null, insight: null, next: null, workItem: null });
    const renderedWithNulls = setLoopCarryNote.mock.calls[0]?.[1];
    setLoopCarryNote.mockClear();
    await call({ did: 'same' });
    expect(renderedWithNulls).toBe(setLoopCarryNote.mock.calls[0]?.[1]);

    // A null-ONLY payload is not a write at all: if null means omitted, it must be refused
    // exactly as `{}` is. Admitting it would compose a note out of nothing — a carry-note
    // CLEAR wearing a write's costume, which is the silent loss this tool guards against.
    expect(() => parse({ left: null, insight: null })).toThrow(/nothing to write/);

    // ...but `note`/`checkpoint` are NOT in that class: for them an explicit null is the
    // documented CLEAR, so it must still count as a write.
    expect(() => parse({ note: null })).not.toThrow();
    expect(() => parse({ checkpoint: null })).not.toThrow();

    // CONTROL: the fields OUTSIDE this class must still refuse null. Without this the
    // assertions above would pass just as well against a schema that stopped validating.
    expect(() => parse({ did: 'progress', learnedLevel: null })).toThrow();
    expect(() => parse({ did: 'progress', walls: null })).toThrow();
  });

  it('accepts a current read-only executable probe and refuses schema drift before the store runs', () => {
    const probe = {
      kind: 'tool' as const,
      tool: LOOP_CONTINUITY_TEST_TOOL,
      args: { value: 'green' },
      schemaRevision: continuityProbeRevision(LOOP_CONTINUITY_TEST_TOOL)!,
      expect: { path: '$.value', op: 'eq' as const, value: 'green' },
    };
    expect(() => parse({ did: 'progress', checks: [{ claim: 'gate is green', probe }] })).not.toThrow();
    expect(() =>
      parse({ did: 'progress', checks: [{ claim: 'gate is green', probe: { ...probe, schemaRevision: 'stale' } }] }),
    ).toThrow(/schema_revision_mismatch/);
    expect(() =>
      parse({
        did: 'progress',
        checks: [
          {
            claim: 'gate is green',
            probe: { ...probe, args: { value: 'green', authorization: 'Bearer sk-abcdefghijklmnop' } },
          },
        ],
      }),
    ).toThrow(/secret_material/);
    expect(setLoopCarryNote).not.toHaveBeenCalled();
  });

  it('EI-21922421392042550: lifts a flattened executable tool probe into the nested probe field', () => {
    const probe = {
      kind: 'tool' as const,
      tool: LOOP_CONTINUITY_TEST_TOOL,
      args: { value: 'green' },
      schemaRevision: continuityProbeRevision(LOOP_CONTINUITY_TEST_TOOL)!,
      expect: { path: '$.value', op: 'eq' as const, value: 'green' },
    };
    const parsed = parse({
      did: 'progress',
      checks: [{ claim: 'gate is green', ...probe }],
    }) as { checks: Array<Record<string, unknown>> };

    expect(parsed.checks[0]).toEqual({ claim: 'gate is green', probe });
    // `kind` is the executable discriminator here, not the legacy claim alias;
    // the pre-existing `{kind, command, result}` compatibility path is covered
    // by the checksLint/absenceLint tests elsewhere in this suite.
    expect(parsed.checks[0]).not.toHaveProperty('kind');
  });

  it('accepts a 167-character flattened executable tool name at the shared identifier cap', () => {
    const probe = {
      kind: 'tool' as const,
      tool: LOOP_LONG_CONTINUITY_TEST_TOOL,
      args: { value: 'green' },
      schemaRevision: continuityProbeRevision(LOOP_LONG_CONTINUITY_TEST_TOOL)!,
      expect: { path: '$.value', op: 'eq' as const, value: 'green' },
    };
    expect(LOOP_LONG_CONTINUITY_TEST_TOOL).toHaveLength(167);
    expect(LIMITS.IDENT).toBeGreaterThanOrEqual(167);
    expect(() => parse({ did: 'progress', checks: [{ claim: 'long tool is accepted', ...probe }] })).not.toThrow();
  });

  it('EI-21926988610689807: accepts a NESTED probe whose kind is implied by `tool`', () => {
    // Lockstep with work_items:checkpoint — the shared normalizer means both
    // surfaces gain this together. A probe shape valid on one carry surface and
    // `invalid_args` on the other is the exact bug this pairing exists to prevent.
    const revision = continuityProbeRevision(LOOP_CONTINUITY_TEST_TOOL)!;
    const parsed = parse({
      did: 'progress',
      checks: [
        {
          claim: 'gate is green',
          probe: {
            tool: LOOP_CONTINUITY_TEST_TOOL,
            args: { value: 'green' },
            schemaRevision: revision,
            expect: { path: '$.value', op: 'eq' as const, value: 'green' },
          },
        },
      ],
    }) as { checks: Array<Record<string, unknown>> };

    expect(parsed.checks[0]).toEqual({
      claim: 'gate is green',
      probe: {
        kind: 'tool',
        tool: LOOP_CONTINUITY_TEST_TOOL,
        args: { value: 'green' },
        schemaRevision: revision,
        expect: { path: '$.value', op: 'eq', value: 'green' },
      },
    });
  });

  it('EI-21926988610689807: still REFUSES a nested probe with nothing to execute', () => {
    // The literal shape this item reported: probe:{expect:{path,op,value}}.
    // Rejection is correct — the row wants `recheck`, not a probe — but it must
    // stay a rejection rather than becoming a silently invented tool probe.
    expect(() =>
      parse({
        did: 'progress',
        checks: [{ claim: 'gate is green', probe: { expect: { path: '$.value', op: 'eq' as const, value: 'green' } } }],
      }),
    ).toThrow(/discriminator/i);
  });

  it('warns when left/next imperatively invokes a singleton mutator without its precondition', async () => {
    const b = body(
      await call({
        next: "FIRE IT NOW: tools:invoke { name:'release:checkpoint-run' }",
      }),
    );
    expect(b.ok).toBe(true);
    expect(b.imperativeLint?.flagged).toBe(true);
    expect(b.imperativeLint?.matches[0]).toMatchObject({ target: 'release:checkpoint-run' });
    expect(setLoopCarryNote).toHaveBeenCalled();
  });

  it('clears the imperative warning only with a matching runnable checks recheck', async () => {
    const b = body(
      await call({
        left: 'run release:checkpoint-run only when no active run exists',
        checks: [
          {
            claim: 'checkpoint run is safe only when no active singleton exists',
            recheck: 'systemctl --user list-units --all | grep green-checkpoint',
          },
        ],
      }),
    );
    expect(b.ok).toBe(true);
    expect(b.imperativeLint).toBeUndefined();
  });

  it('checksLint accepts matching stable row ids as coverage anchors', async () => {
    const prose =
      'Stable-C generation stable-c-false-0517 MUST remain false; ' +
      'c58 re-arm generation c58-rearm-pending MUST remain pending.';
    const b = body(
      await call({
        note: prose,
        checks: [
          {
            id: 'stable-c-false-0517',
            claim: 'Stable-C is false',
            recheck: 'read current Stable-C result',
            verified: 'current value confirmed',
          },
          {
            id: 'c58-rearm-pending',
            claim: 'c58 re-arm is pending',
            recheck: 'read current c58 await status',
            verified: 'current value confirmed',
          },
        ],
      }),
    );
    expect(b.ok).toBe(true);
    expect(b.checksLint).toBeUndefined();
  });

  it('checksLint accepts exact durable task ids carried by a contested check', async () => {
    const firstTask = '0mt8rdwku1p1azr046o';
    const secondTask = '0mt8rdx3wk0yfrza157';
    const b = body(
      await call({
        note: `Focused task generation ${firstTask} and ${secondTask} MUST remain active.`,
        checks: [
          {
            id: 'durable-caller-fix-tests',
            claim: 'both focused tasks are active without terminal verdicts',
            recheck: `capability:bash_output task_id=${firstTask}; capability:bash_output task_id=${secondTask}`,
            contested: `${firstTask} and ${secondTask} were active without terminal verdicts`,
          },
        ],
      }),
    );

    expect(b.ok).toBe(true);
    expect(b.checksLint).toBeUndefined();
  });

  // outage-must-not-be-silent-2026-08-02 P-009 — the absence-claim leg.
  //
  // The pre-existing checksLint keys on a distinctive token (hash / WI-EI id / ISO instant)
  // or an external-state noun. An absence claim carries none of those and passed straight
  // through. The sentence used below is the REAL one from the incident that motivated this:
  // it was checkpointed as settled fact, read back as fact on the next wake, and ~180 lines
  // were shipped on it before a reverse-grep refuted it (plan D-005).
  describe('absenceLint — an absence assertion in the carry-note is flagged with its falsifier', () => {
    const INCIDENT_CLAIM =
      'The mcp-proxy failure ledger has been written since W8 and there is no reader for it — nothing ingests the file.';

    it('flags an absence claim and hands back a concrete recheck', async () => {
      const b = body(await call({ did: INCIDENT_CLAIM, next: 'ship the summary' }));
      expect(b.ok).toBe(true);
      expect(b.absenceLint?.flagged).toBe(true);
      expect(b.absenceLint.claims.length).toBeGreaterThan(0);
      // The remedy must be a SEARCH, not merely "double-check this".
      expect(b.absenceLint.claims[0].recheck).toBeTruthy();
      // The directive has to name the reverse direction — the actual failure was grepping
      // the write site and never searching for readers.
      expect(b.absenceLint.note).toMatch(/reverse-grep/i);
    });

    it('uses observation guidance instead of echoing transient state as a grep target', async () => {
      const b = body(
        await call({
          left: 'The pending edit is comment-only, tests-green and tsc-clean, so there is no broken intermediate to bank.',
          next: 'ship the summary',
        }),
      );
      expect(b.ok).toBe(true);
      expect(b.absenceLint?.claims[0]?.recheck).toMatch(/what would falsify/i);
      expect(b.absenceLint?.claims[0]?.recheck).toMatch(/observe/i);
      expect(b.absenceLint?.claims[0]?.recheck).not.toMatch(/search|grep|broken intermediate to bank/i);
    });

    it('is ADVISORY — the checkpoint is still written', async () => {
      await call({ did: INCIDENT_CLAIM, next: 'ship it' });
      expect(setLoopCarryNote).toHaveBeenCalled();
    });

    it('omits the key entirely for a note that asserts no absence', async () => {
      const b = body(await call({ did: 'shipped the classifier fix', left: 'run tests', next: 'vitest' }));
      expect(b.absenceLint).toBeUndefined();
    });

    it('stays quiet for a future no-pickup condition but still flags a main-clause absence', async () => {
      const conditional = body(
        await call({
          left: 'If there is no new checkpoint/coord from cb96f by ~11:45Z, wake it with coord:send',
          next: 'verify the wake path',
        }),
      );
      expect(conditional.ok).toBe(true);
      expect(conditional.absenceLint).toBeUndefined();

      const mainClause = body(
        await call({
          left: 'If the peer misses the wake, there is no reader for the checkpoint table.',
          next: 'verify the read path',
        }),
      );
      expect(mainClause.absenceLint?.flagged).toBe(true);
    });

    it('stays quiet for rhetorical `no X` prose', async () => {
      const b = body(await call({ did: 'Cheap enough that there is no excuse for relaying.', next: 'continue' }));
      expect(b.ok).toBe(true);
      expect(b.absenceLint).toBeUndefined();
    });

    it('stays quiet for a live non-stall observation', async () => {
      const b = body(
        await call({
          did: 'The current leg is visibly progressing, so there is no stall to remediate.',
          insight: 'AFFECTED_TASK_PROGRESS bytes are advancing and stalledForSec=0.',
          next: 'poll the same affected task',
        }),
      );
      expect(b.ok).toBe(true);
      expect(b.absenceLint).toBeUndefined();
    });

    it('stays quiet when the author already parked the falsifier as a check', async () => {
      const b = body(
        await call({
          did: INCIDENT_CLAIM,
          next: 'ship it',
          checks: [
            {
              claim: INCIDENT_CLAIM,
              recheck: "grep -rn 'mcp-proxy-health' packages apps libs",
              verified: 'searched importers 2026-08-03: none found',
            },
          ],
        }),
      );
      expect(b.absenceLint).toBeUndefined();
    });
  });

  it('a raw { note } is written verbatim (renderCarryNote NOT called)', async () => {
    await call({ note: 'freeform carry text' });
    expect(setLoopCarryNote).toHaveBeenCalledWith(
      { harness: 'papercusp', ownerId: 'su-caller', workspaceId: 'ws-1' },
      'freeform carry text',
    );
  });

  it('structured fields WIN over a raw note when both are passed', async () => {
    await call({ note: 'ignore me', did: 'the real state' });
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    expect(written).toContain('RENDERED:');
    expect(written).not.toBe('ignore me');
  });

  it("an explicit { note:'' } clears (stored=null ⇒ cleared:true, length:0)", async () => {
    setLoopCarryNote.mockResolvedValue(null);
    const b = body(await call({ note: '' }));
    expect(setLoopCarryNote).toHaveBeenCalledWith(expect.anything(), '');
    expect(b).toMatchObject({ ok: true, cleared: true, length: 0 });
  });

  it("honors an explicit ownerId override (mirrors loop:arm/end/status — checkpoint another session's loop)", async () => {
    await call({ next: 'x', ownerId: 'su-other-session' });
    expect(setLoopCarryNote).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'su-other-session', harness: 'papercusp' }),
      expect.any(String),
    );
  });

  it('resolves ownerId:self to the caller instead of writing a shadow carry-note', async () => {
    await call({ next: 'x', ownerId: 'self' });

    expect(getLoopStatus).toHaveBeenCalledWith('su-caller');
    expect(setLoopCarryNote).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'su-caller', harness: 'papercusp' }),
      expect.any(String),
    );
  });

  it('honors an explicit harness override over ctx', async () => {
    await call({ next: 'x', harness: 'other-harness' });
    expect(setLoopCarryNote).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'other-harness' }),
      expect.any(String),
    );
  });

  it('EI-21273052750925106: active routine scope wins over a project-scoped harness', async () => {
    getLoopStatus.mockResolvedValueOnce({ harnessSlug: 'sb-devboard-hive', active: true } as never);

    await call({ next: 'x', harness: 'papercusp' }, { harnessSlug: 'papercusp', workspaceId: 'ws-1' });

    expect(getLoopStatus).toHaveBeenCalledWith('su-caller');
    expect(setLoopCarryNote).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'sb-devboard-hive', ownerId: 'su-caller' }),
      expect.any(String),
    );
    expect(getLoopCarryNoteWithMeta).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'sb-devboard-hive', ownerId: 'su-caller' }),
    );
  });

  // WI-2148: the actual bug — the checkpoint WRITER must key its carry-note under the
  // SAME harness the cold-wake READER resolves (the armed routine's fixed install_slug),
  // never the checkpointing session's own transient ctx.harnessSlug. A live incident showed
  // wakes 1-3 writing under harness '*' and wake-4 writing under 'papercusp' for the SAME
  // loop, purely because ctx.harnessSlug resolved differently — creating two diverging
  // carry_notes rows and risking a cold reset resuming from the stale one.
  it("WI-2148: resolves harness from the ARMED ROUTINE's install_slug, not ctx.harnessSlug — even when they disagree", async () => {
    getLoopStatus.mockResolvedValueOnce({ harnessSlug: '*', active: true } as never);
    // ctx says 'papercusp' (as if this wake's session context resolved differently than the
    // routine it was armed under) — the routine's '*' must still win, since that's what the
    // reader will resolve the note by.
    await call({ next: 'x' }, { harnessSlug: 'papercusp', workspaceId: 'ws-1' });
    expect(getLoopStatus).toHaveBeenCalledWith('su-caller');
    expect(setLoopCarryNote).toHaveBeenCalledWith(
      expect.objectContaining({ harness: '*', ownerId: 'su-caller' }),
      expect.any(String),
    );
  });

  it.each([undefined, 'papercusp'])('keeps the active routine scope when diagnostic status fails (explicit harness: %s)', async (harness) => {
    // The scope lives in the routine row even when the diagnostic reader's
    // wake/transcript enrichment fails. Falling back would strand the note in
    // papercusp while the cold reader still opens sb-devboard-hive.
    getLoopStatus.mockRejectedValue(new Error('diagnostic wake-history query failed'));
    readActiveLoopFacts.mockResolvedValue({ active: true, harnessSlug: 'sb-devboard-hive' });

    const result = body(await call({ next: 'continue the existing loop', ...(harness ? { harness } : {}) }, {
      harnessSlug: 'papercusp', workspaceId: 'ws-1',
    }));

    expect(setLoopCarryNote).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'sb-devboard-hive', ownerId: 'su-caller' }),
      expect.any(String),
    );
    expect(result).toMatchObject({ ok: true, harness: 'sb-devboard-hive', verified: true });
    expect(readActiveLoopFacts).toHaveBeenCalledWith('su-caller');
    expect(result.routineProbeFailed).toBeUndefined();
  });

  it('WI-2148: falls back to args/ctx/home-hive when getLoopStatus errors (fail-open, never blocks a checkpoint write)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    getLoopStatus.mockRejectedValueOnce(new Error('pg down'));
    const result = await call({ next: 'x' }, { harnessSlug: 'papercusp', workspaceId: 'ws-1' });
    expect(setLoopCarryNote).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'papercusp' }),
      expect.any(String),
    );
    // EI-22166372050218668: fail-open stays unblocked (assertion above), but the
    // caller must now be told the resolved scope was NOT confirmed against the armed
    // routine — the write is no longer silently indistinguishable from a verified one.
    const body = JSON.parse(result.content[0].text as string);
    expect(body.routineProbeFailed).toEqual(
      expect.objectContaining({ wroteTo: 'papercusp', reason: 'error', errorMessage: 'pg down', elapsedMs: 0 }),
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('bounds a hanging armed-routine scope probe and writes with an explicit unverified-scope warning', async () => {
    const neverSettles = new Promise<never>(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    getLoopStatus.mockReturnValueOnce(neverSettles);
    withBoundedTimeout.mockImplementationOnce(async (work: unknown, options: unknown) => {
      if (typeof work === 'function') void (work as () => Promise<unknown>)();
      return {
        value: (options as { fallback: unknown }).fallback,
        degraded: true,
        reason: 'timeout',
        elapsedMs: 5_000,
      };
    });

    const result = await call({ next: 'continue despite a slow armed-routine scope read' });
    const resultBody = body(result);
    expect(resultBody).toMatchObject({
      ok: true,
      harness: 'papercusp',
      routineProbeFailed: { wroteTo: 'papercusp', reason: 'timeout', elapsedMs: 5_000 },
    });
    expect(setLoopCarryNoteWithPrior).toHaveBeenCalledOnce();
    const { CONTINUATION_READ_BUDGET_MS } = await import('./checkpoint');
    expect(withBoundedTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        fallback: null,
        timeoutMs: CONTINUATION_READ_BUDGET_MS,
        label: 'loop:checkpoint armed-routine scope probe',
      }),
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('EI-22166372050218668: a getLoopStatus failure stays silent when an explicit harness argument resolves the write anyway', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    getLoopStatus.mockRejectedValueOnce(new Error('pg down'));
    const result = await call({ next: 'x', harness: 'papercusp' }, { harnessSlug: '*', workspaceId: 'ws-1' });
    expect(setLoopCarryNote).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'papercusp' }),
      expect.any(String),
    );
    // The explicit `harness` argument itself resolved the scope, so the probe failure
    // never had a chance to silently misroute the write — no warning flag is owed.
    const body = JSON.parse(result.content[0].text as string);
    expect(body.routineProbeFailed).toBeUndefined();
    warn.mockRestore();
  });

  it('EI-21183575241304993: uses the durable session scope before an unrelated owner loop under wildcard transport', async () => {
    getSessionBrief.mockResolvedValueOnce({ harnessSlug: 'papercusp' } as never);
    getLoopStatus.mockResolvedValueOnce({ harnessSlug: 'sb-devboard-hive', active: false } as never);
    withBoundedTimeout.mockImplementationOnce(async (work: unknown) => ({
      value: await (work as () => Promise<unknown>)(),
      degraded: false,
      elapsedMs: 0,
    }));

    await call({ next: 'x' }, { harnessSlug: '*', workspaceId: 'ws-1' });

    expect(getSessionBrief).toHaveBeenCalledWith({ ownerId: 'su-caller' });
    expect(setLoopCarryNote).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'papercusp', ownerId: 'su-caller' }),
      expect.any(String),
    );
  });

  it('EI-21189207633735449: an active routine install_slug skips the stale session-scope read', async () => {
    getLoopStatus.mockResolvedValueOnce({ harnessSlug: 'sb-devboard-hive', active: true } as never);

    await call({ next: 'x' }, { harnessSlug: '*', workspaceId: 'ws-1' });

    expect(getSessionBrief).not.toHaveBeenCalled();
    expect(setLoopCarryNote).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'sb-devboard-hive', ownerId: 'su-caller' }),
      expect.any(String),
    );
  });

  it('EI-21270894164573688: an ended routine does not hijack wildcard checkpoint fallback', async () => {
    getLoopStatus.mockResolvedValueOnce({ harnessSlug: 'sb-devboard-hive', active: false } as never);
    withBoundedTimeout.mockImplementationOnce(async (work: unknown) => ({
      value: await (work as () => Promise<unknown>)(),
      degraded: false,
      elapsedMs: 0,
    }));

    // Delayed reconciliation can arrive after the loop ended. The wildcard transport
    // carries no concrete harness, and there is no successor brief to consult; the
    // ended routine's old install_slug must not become the new checkpoint scope.
    await call({ next: 'x' }, { harnessSlug: '*', workspaceId: 'ws-1' });

    expect(getSessionBrief).toHaveBeenCalledWith({ ownerId: 'su-caller' });
    expect(setLoopCarryNote).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'home-hive', ownerId: 'su-caller' }),
      expect.any(String),
    );
  });

  it('EI-21371395040636011: bounds a hanging durable session-scope fallback', async () => {
    const neverSettles = new Promise<never>(() => undefined);
    getSessionBrief.mockReturnValueOnce(neverSettles);
    withBoundedTimeout.mockImplementationOnce(async (work: unknown) => ({
      value: await (work as () => Promise<unknown>)(),
      degraded: false,
      elapsedMs: 0,
    }));
    withBoundedTimeout.mockImplementationOnce(async (work: unknown, options: unknown) => {
      // Start the thunk to prove the handler supplies lazy work to the bounded helper,
      // then return its fallback as the real helper would after the deadline.
      if (typeof work === 'function') void (work as () => Promise<unknown>)();
      const fallback = (options as { fallback: unknown }).fallback;
      return { value: fallback, degraded: true, reason: 'timeout' as const, elapsedMs: 5_000 };
    });

    const b = body(await call({ next: 'continue without a durable scope' }, { harnessSlug: '*', workspaceId: 'ws-1' }));

    expect(b).toMatchObject({ ok: true, harness: 'home-hive' });
    expect(getSessionBrief).toHaveBeenCalledWith({ ownerId: 'su-caller' });
    const { CONTINUATION_READ_BUDGET_MS } = await import('./checkpoint');
    expect(withBoundedTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        fallback: null,
        timeoutMs: CONTINUATION_READ_BUDGET_MS,
        label: 'loop:checkpoint session-scope read',
      }),
    );
  });

  it('falls back to the home-hive slug when neither arg nor ctx has a harness', async () => {
    await call({ next: 'x' }, { workspaceId: 'ws-1' });
    expect(setLoopCarryNote).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'home-hive' }),
      expect.any(String),
    );
  });

  it('errors cleanly (no_harness) when no harness resolves anywhere — never writes an empty-namespace note', async () => {
    const { resolvePotHomeSlug } = await import('../../pot/wake');
    // `null` is in resolvePotHomeSlug's REAL return type (string | null), so this needs
    // no cast — and an uncast fixture still typechecks against the real signature if it
    // ever changes, which `as never` would have silently swallowed.
    vi.mocked(resolvePotHomeSlug).mockReturnValueOnce(null);
    const out = await call({ next: 'x' }, { workspaceId: 'ws-1' });
    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({ ok: false, error: 'no_harness' });
    expect(setLoopCarryNote).not.toHaveBeenCalled();
  });

  // EI-21510951589801937: after a loop:end there is no active routine, and a superuser
  // session carrying only the '*' sentinel with no home hive resolves nothing — so an
  // ordinary carry-note refresh failed no_harness even though the owner's note sat in
  // exactly one store. These pin the last-resort inference AND both of its guard rails:
  // it must not fire when a stronger signal already answered, and it must refuse while
  // NAMING the candidates rather than guess when the owner holds notes in several.
  describe('carry-note scope inference (EI-21510951589801937)', () => {
    // The production read is wrapped in withBoundedTimeout, whose suite-wide double
    // returns a fixed `undefined`. Execute the wrapped work for THIS call site only —
    // keyed on its label, so the other three sites keep the suite default — otherwise
    // the tests would pass against the double rather than the inference.
    const runInferenceWorkForReal = () =>
      withBoundedTimeout.mockImplementation(async (work: unknown, opts: unknown) => {
        if ((opts as { label?: string } | undefined)?.label !== 'loop:checkpoint carry-note scope inference') {
          return { value: undefined, degraded: false, elapsedMs: 0 };
        }
        return {
          value: typeof work === 'function' ? await (work as () => Promise<unknown>)() : await work,
          degraded: false,
          elapsedMs: 0,
        };
      });

    it("infers the scope from the owner's single existing carry-note when nothing else resolves", async () => {
      const { resolvePotHomeSlug } = await import('../../pot/wake');
      vi.mocked(resolvePotHomeSlug).mockReturnValueOnce(null);
      runInferenceWorkForReal();
      listLoopCarryNoteHarnesses.mockResolvedValueOnce(['sb-devboard-hive']);
      const out = await call({ next: 'x' }, { workspaceId: 'ws-1' });
      expect(out.isError).toBeFalsy();
      // The PATH, not just the verdict: the lookup was addressed to THIS owner, the
      // note landed in the inferred store, and the reply says the scope was inferred
      // rather than resolved from the session.
      expect(listLoopCarryNoteHarnesses).toHaveBeenCalledWith('su-caller');
      expect(setLoopCarryNote).toHaveBeenCalledWith(
        expect.objectContaining({ harness: 'sb-devboard-hive' }),
        expect.any(String),
      );
      expect(body(out)).toMatchObject({
        ok: true,
        harness: 'sb-devboard-hive',
        scopeInferredFrom: 'carry-note',
      });
    });

    it('refuses and NAMES the candidates instead of guessing when the owner holds notes under several harnesses', async () => {
      const { resolvePotHomeSlug } = await import('../../pot/wake');
      vi.mocked(resolvePotHomeSlug).mockReturnValueOnce(null);
      runInferenceWorkForReal();
      listLoopCarryNoteHarnesses.mockResolvedValueOnce(['hive-a', 'hive-b']);
      const out = await call({ next: 'x' }, { workspaceId: 'ws-1' });
      expect(out.isError).toBe(true);
      // Asserting `error: 'no_harness'` alone would pass with this whole branch
      // DELETED — it reuses the pre-existing refusal's code. The candidates are the
      // branch, so the candidates are what this pins.
      expect(body(out)).toMatchObject({
        ok: false,
        error: 'no_harness',
        candidates: ['hive-a', 'hive-b'],
      });
      expect(String((body(out) as { message?: string }).message)).toContain('hive-a, hive-b');
      expect(setLoopCarryNote).not.toHaveBeenCalled();
    });

    it('never consults the carry-note store when a stronger signal already resolved the scope', async () => {
      runInferenceWorkForReal();
      listLoopCarryNoteHarnesses.mockResolvedValueOnce(['some-other-hive']);
      await call({ next: 'x' }, { workspaceId: 'ws-1', harnessSlug: 'ctx-hive' });
      // Last-resort BY CONSTRUCTION: the inference can turn a failure into a write but
      // must never redirect a scope the session already answered — that placement is
      // what keeps it from reintroducing the wrong-store stranding it sits beside.
      expect(listLoopCarryNoteHarnesses).not.toHaveBeenCalled();
      expect(setLoopCarryNote).toHaveBeenCalledWith(
        expect.objectContaining({ harness: 'ctx-hive' }),
        expect.any(String),
      );
    });
  });

  it('read:true returns the current note metadata without entering the write path', async () => {
    const note = '## Next action\nresume the focused test';
    const updatedAtMs = 1_787_546_123_000;
    getLoopCarryNoteWithMeta.mockResolvedValueOnce({ note, updatedAtMs });

    const b = body(await call({ read: true, ownerId: 'su-caller', harness: 'papercusp' }));

    expect(b).toMatchObject({
      ok: true,
      read: true,
      harness: 'papercusp',
      ownerId: 'su-caller',
      note,
      contentHash: shortCarryHash(note),
      updatedAtMs,
      length: note.length,
      walls: [],
      checks: [],
    });
    expect(getLoopCarryNoteWithMeta).toHaveBeenCalledWith({
      harness: 'papercusp',
      ownerId: 'su-caller',
      workspaceId: 'ws-1',
    });
    expect(setLoopCarryNoteWithPrior).not.toHaveBeenCalled();
    expect(setLoopCarryNote).not.toHaveBeenCalled();
  });

  it('read:true returns the complete carried walls and checks rows from the stored note', async () => {
    const checks = [{ id: 'check-1', claim: 'gate is green', recheck: 'dev:pipeline_position' }];
    const walls = [{ id: 'wall-1', claim: 'owner decision pending', recheck: 'coord:inbox' }];
    const note = withCarryNoteWalls(withCarryNoteChecks('## Next action\nresume the focused test', checks), walls);
    const updatedAtMs = 1_787_546_123_000;
    getLoopCarryNoteWithMeta.mockResolvedValueOnce({ note, updatedAtMs });

    const b = body(await call({ read: true, ownerId: 'su-caller', harness: 'papercusp' }));

    // WI-6554700010008923: the rows are returned ONCE, structured — not also inside `note`.
    expect(b).toMatchObject({
      ok: true,
      read: true,
      note: '## Next action\nresume the focused test',
      updatedAtMs,
      walls,
      checks,
    });
    expect(b.note).not.toContain('## Checks');
    expect(b.note).not.toContain('## Walls');
    expect(b.noteRowsOmitted).toMatch(/walls\[\]\/checks\[\]/);
    // Hash and length still describe the FULL stored note, so attestation is unaffected.
    expect(b.contentHash).toBe(shortCarryHash(note));
    expect(b.length).toBe(note.length);
  });

  it('read:true body written back as a raw note keeps every stored row (round-trip)', async () => {
    const checks = [{ id: 'check-1', claim: 'gate is green', recheck: 'dev:pipeline_position' }];
    const walls = [{ id: 'wall-1', claim: 'owner decision pending', recheck: 'coord:inbox' }];
    const stored = withCarryNoteWalls(withCarryNoteChecks('## Next action\nresume the focused test', checks), walls);
    getLoopCarryNoteWithMeta.mockResolvedValueOnce({ note: stored, updatedAtMs: 1_787_546_123_000 });
    const b = body(await call({ read: true, ownerId: 'su-caller', harness: 'papercusp' }));

    const merged = mergeCarryRows({ priorNote: stored, baseNote: b.note, hasNoteWrite: true });
    expect(splitCarryNoteChecks(merged.note).checks).toMatchObject(checks);
    expect(splitCarryNoteWalls(merged.note).walls).toMatchObject(walls);
    expect(merged.droppedChecks).toEqual([]);
    expect(merged.droppedWalls).toEqual([]);
  });

  it('read:true returns a note without rows byte-identically and adds no omission marker', async () => {
    const note = '## Did\nplain note\n\n## Next action\nnothing carried';
    getLoopCarryNoteWithMeta.mockResolvedValueOnce({ note, updatedAtMs: 1_787_546_123_000 });
    const b = body(await call({ read: true, ownerId: 'su-caller', harness: 'papercusp' }));
    expect(b.note).toBe(note);
    expect(b).not.toHaveProperty('noteRowsOmitted');
  });

  describe('WI-1826126 — a newer carry-note stranded under another harness', () => {
    // The production staleness check is wrapped in withBoundedTimeout, whose suite-wide
    // double resolves `undefined` for every label. Run the real work for THIS label only,
    // so every other test keeps the cheap double and stays unaffected.
    const runStalenessCheckForReal = () =>
      withBoundedTimeout.mockImplementation(async (work: unknown, opts: unknown) => {
        if ((opts as { label?: string } | undefined)?.label !== 'loop:checkpoint cross-harness staleness check') {
          return { value: undefined, degraded: false, elapsedMs: 0 };
        }
        return {
          value: typeof work === 'function' ? await (work as () => Promise<unknown>)() : await work,
          degraded: false,
          elapsedMs: 0,
        };
      });

    it('honours the explicit harness on a READ even while a routine is armed elsewhere', async () => {
      // The measured incident: the armed routine pointed at one hive, the note the caller
      // needed sat in another, and the caller passed the right one. The routine won, so the
      // caller got the WRONG scope's note back with the resolved harness echoed as if the
      // argument had been honoured — which made the stranded note unreachable via this tool.
      getLoopStatus.mockResolvedValueOnce({ harnessSlug: 'sb-devboard-hive', active: true });
      getLoopCarryNoteWithMeta.mockResolvedValueOnce({ note: '## Did\nthe one I asked for', updatedAtMs: 3_000 });

      const b = body(await call({ read: true, harness: 'papercusp' }));

      expect(getLoopCarryNoteWithMeta).toHaveBeenCalledWith(expect.objectContaining({ harness: 'papercusp' }));
      expect(b).toMatchObject({ ok: true, read: true, harness: 'papercusp', note: '## Did\nthe one I asked for' });
    });

    it('keeps the armed routine authoritative on a WRITE, and reports the discarded argument', async () => {
      // The asymmetry is deliberate and must NOT be "fixed": a write has to land where the
      // cold wake will read, so an explicit override there would strand the note. What was
      // missing is the disclosure — the reply echoed only the resolved harness, so a caller
      // re-addressing a note believed the write had gone where they asked.
      getLoopStatus.mockResolvedValueOnce({ harnessSlug: 'sb-devboard-hive', active: true });

      const b = body(await call({ next: 'x', harness: 'papercusp' }));

      expect(setLoopCarryNote).toHaveBeenCalledWith(
        expect.objectContaining({ harness: 'sb-devboard-hive' }),
        expect.any(String),
      );
      expect(b).toMatchObject({
        harness: 'sb-devboard-hive',
        explicitHarnessIgnored: { requested: 'papercusp', wroteTo: 'sb-devboard-hive' },
      });
    });

    it('warns when the READ resolves an older scope while a newer note sits elsewhere', async () => {
      runStalenessCheckForReal();
      getLoopCarryNoteWithMeta.mockResolvedValueOnce({ note: '## Did\nthe stale one', updatedAtMs: 1_000 });
      listLoopCarryNoteScopes.mockResolvedValueOnce([
        { harness: 'sb-devboard-hive', updatedAtMs: 9_000 },
        { harness: 'papercusp', updatedAtMs: 1_000 },
      ]);

      const b = body(await call({ read: true }));

      expect(listLoopCarryNoteScopes).toHaveBeenCalledWith('su-caller');
      expect(b.newerNoteElsewhere).toEqual([{ harness: 'sb-devboard-hive', updatedAtMs: 9_000 }]);
      expect(String(b.staleScopeWarning)).toContain('sb-devboard-hive');
      // REPORTS, never switches: the resolved scope and its note are returned unchanged.
      // Auto-preferring the newest row is the wrong-hive resumption this warning exists
      // to prevent, so a test that accepted a switched harness would enshrine the bug.
      expect(b).toMatchObject({ ok: true, harness: 'papercusp', note: '## Did\nthe stale one' });
    });

    it('stays silent when the resolved scope already holds the newest note', async () => {
      runStalenessCheckForReal();
      getLoopCarryNoteWithMeta.mockResolvedValueOnce({ note: 'current', updatedAtMs: 9_000 });
      listLoopCarryNoteScopes.mockResolvedValueOnce([
        { harness: 'papercusp', updatedAtMs: 9_000 },
        { harness: 'sb-devboard-hive', updatedAtMs: 1_000 },
      ]);

      const b = body(await call({ read: true }));

      // An always-on caveat is worse than none: it trains the reader to skip the one
      // occasion the warning is real. Holding notes elsewhere is NOT itself the defect.
      expect(b.newerNoteElsewhere).toBeUndefined();
      expect(b.staleScopeWarning).toBeUndefined();
    });

    it('warns when THIS scope holds no note at all but another one does', async () => {
      runStalenessCheckForReal();
      getLoopCarryNoteWithMeta.mockResolvedValueOnce({ note: null, updatedAtMs: null });
      listLoopCarryNoteScopes.mockResolvedValueOnce([{ harness: 'sb-devboard-hive', updatedAtMs: 5_000 }]);

      const b = body(await call({ read: true }));

      // The most dangerous reading of the three: an agent told it has NO carry-note
      // writes a fresh one over continuity it still owns one scope away.
      expect(b.newerNoteElsewhere).toEqual([{ harness: 'sb-devboard-hive', updatedAtMs: 5_000 }]);
      expect(String(b.staleScopeWarning)).toContain('no note at all');
    });
  });

  it('read:true reports an absent note with null metadata', async () => {
    getLoopCarryNoteWithMeta.mockResolvedValueOnce({ note: null, updatedAtMs: null });

    const b = body(await call({ read: true }));

    expect(b).toMatchObject({
      ok: true,
      read: true,
      note: null,
      contentHash: null,
      updatedAtMs: null,
      length: 0,
      walls: [],
      checks: [],
    });
    expect(setLoopCarryNoteWithPrior).not.toHaveBeenCalled();
  });

  it('read:true refuses to report an empty note when the carry-note store read failed', async () => {
    getLoopCarryNoteWithMeta.mockResolvedValueOnce({ note: null, updatedAtMs: null, readFailed: true });

    const out = await call({ read: true, ownerId: 'su-caller', harness: 'papercusp' });

    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({
      ok: false,
      read: true,
      error: 'carry_note_read_failed',
      harness: 'papercusp',
      ownerId: 'su-caller',
      readFailed: true,
    });
    expect(String(body(out).message)).toContain('NOT a confirmed empty note');
    expect(listLoopCarryNoteScopes).not.toHaveBeenCalled();
    expect(setLoopCarryNoteWithPrior).not.toHaveBeenCalled();
  });

  it('rejects an empty call (nothing to write) at the args boundary', () => {
    expect(() => parse({})).toThrow();
  });

  it('bounds advisory continuation reads well below the tool transport timeout', async () => {
    const { CONTINUATION_READ_BUDGET_MS } = await import('./checkpoint');
    await call({ next: 'x' });
    expect(CONTINUATION_READ_BUDGET_MS).toBe(5_000);
    expect(withBoundedTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        fallback: undefined,
        timeoutMs: CONTINUATION_READ_BUDGET_MS,
        label: 'loop:checkpoint continuation reads',
      }),
    );
  });

  it('records per-leg continuation read durations when the aggregate budget times out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const priorBoundedTimeout = withBoundedTimeout.getMockImplementation();
    expect(priorBoundedTimeout).toBeDefined();
    readWatermark.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { messages_since_ts: '' };
    });
    withBoundedTimeout.mockImplementation(async (work: unknown, options: unknown) => {
      const label = (options as { label?: string }).label;
      if (label === 'loop:checkpoint continuation reads') {
        const value = await (work as () => Promise<unknown>)();
        return { value, degraded: true, reason: 'timeout', elapsedMs: 5_000 };
      }
      return priorBoundedTimeout!(work, options);
    });

    try {
      await call({ next: 'continue after measurement' });
      const diagnostic = warn.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.startsWith('[loop:checkpoint] continuation-read-timeout '));
      expect(diagnostic).toBeDefined();
      const timing = JSON.parse(diagnostic!.slice('[loop:checkpoint] continuation-read-timeout '.length));
      const watermark = timing.completed.find((entry: { name: string }) => entry.name === 'inbox.watermark');
      expect(watermark?.elapsedMs).toBeGreaterThanOrEqual(15);
      expect(watermark?.outcome).toBe('resolved');
      expect(timing.active).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('bounds a stalled decision-ref advisory after the carry note is stored', async () => {
    const { CONTINUATION_READ_BUDGET_MS } = await import('./checkpoint');
    unresolvedPlanDecisionRefs.mockImplementation(() => new Promise(() => {}));
    // Keyed by label, not position: the P-005 fleet_zero_workers guard is an earlier
    // bounded call, and a positional once-value would be consumed by it instead.
    withBoundedTimeout.mockImplementation(async (_work: unknown, opts: unknown) =>
      (opts as { label?: string }).label === 'loop:checkpoint decision-ref advisory'
        ? { value: undefined, degraded: true, elapsedMs: 5_000 }
        : { value: undefined, degraded: false, elapsedMs: 0 },
    );

    const out = await call({ next: 'continue after checkpoint' });

    expect(setLoopCarryNoteWithPrior).toHaveBeenCalledOnce();
    expect(body(out).ok).toBe(true);
    expect(withBoundedTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        fallback: undefined,
        timeoutMs: CONTINUATION_READ_BUDGET_MS,
        label: 'loop:checkpoint decision-ref advisory',
      }),
    );
  });

  it('runtime wiring: feeds live context, inbox, re-wake, and typed wind-down reads into the gate', async () => {
    // Execute the bounded callback instead of returning its default fallback. This is
    // deliberately handler-level coverage: the pure gate tests cannot catch a dropped
    // dynamic import, stale presence-only token source, or an unread cursor that never
    // reaches the continuation verdict.
    withBoundedTimeout.mockImplementation(async (work: unknown) => ({
      value: typeof work === 'function' ? await (work as () => Promise<unknown>)() : await (work as Promise<unknown>),
      degraded: false,
      elapsedMs: 0,
    }));
    getLoopStatus.mockResolvedValue({
      harnessSlug: 'papercusp',
      active: true,
      carry: 'warm',
      intervalSec: 300,
      goal: 'wire the gate',
    });
    getPresence.mockResolvedValue({ contextTokens: 1, compactionLimit: 100 });
    currentContextTokensForOwner.mockResolvedValue(95);
    readWatermark.mockResolvedValue({ messages_since_ts: '2026-08-21T05:00:00.000Z' });
    readInbox.mockResolvedValue([]);
    selfCompactionAvailability.mockReturnValue({ available: false });
    readFleetWindDownLoopEndAuthorization.mockResolvedValue(true);

    const b = body(await call({ next: 'wire the gate' }));

    expect(b.continuation).toMatchObject({
      contextPct: 95,
      unreadInbox: 0,
      rewakeGuaranteed: true,
      nextWakeFresh: false,
      selfCompactionAvailable: false,
      fleetWindDownLoopEndAuthorized: true,
    });
    expect(b.continuation.guidance).toContain('AUTHORIZED FLEET WIND-DOWN');
    expect(b.continuation.guidance).toContain('loop:end');
    expect(b.continuation.guidance).toContain('do not call session:end or respawn');
    expect(currentContextTokensForOwner).toHaveBeenCalledWith('su-caller');
    expect(readWatermark).toHaveBeenCalledWith('su-caller');
    expect(orgSql).toHaveBeenCalled();
    expect(readInbox).toHaveBeenCalledWith('su-caller', { since_ts: '2026-08-21T05:00:00.000Z', excludeOwn: true });
    expect(selfCompactionAvailability).toHaveBeenCalledWith('su-caller');
    expect(readFleetWindDownLoopEndAuthorization).toHaveBeenCalledWith({
      ownerId: 'su-caller',
      workspaceId: 'ws-1',
    });
  });

  it('runtime wiring: preserves the warm loop when fresh-context delivery is unavailable', async () => {
    withBoundedTimeout.mockImplementation(async (work: unknown) => ({
      value: typeof work === 'function' ? await (work as () => Promise<unknown>)() : await (work as Promise<unknown>),
      degraded: false,
      elapsedMs: 0,
    }));
    getLoopStatus.mockResolvedValue({
      harnessSlug: 'papercusp',
      active: true,
      carry: 'warm',
      armedAt: '2026-08-25T04:00:00.000Z',
      firesSinceArm: 0,
      intervalSec: 300,
      goal: 'preserve the active goal',
      maxDurationSec: null,
      maxFires: null,
      nextFireAt: null,
    });
    getModes.mockResolvedValue([{ mode: 'auto' }]);
    getPresence.mockResolvedValue({ contextTokens: 95, compactionLimit: 100 });
    currentContextTokensForOwner.mockResolvedValue(95);
    readWatermark.mockResolvedValue({ messages_since_ts: '2026-08-25T04:00:00.000Z' });
    readInbox.mockResolvedValue([]);
    selfCompactionAvailability.mockReturnValue({ available: false });
    readFleetWindDownLoopEndAuthorization.mockResolvedValue(false);

    const b = body(await call({ next: 'checkpoint before retuning' }));

    expect(b.continuation).toMatchObject({
      rewakeGuaranteed: true,
      nextWakeFresh: false,
    });
    expect(b.continuation.guidance).toMatch(/fresh-context delivery is unavailable/i);
    expect(b.continuation.guidance).toContain('Do not retune this warm loop to cold');
    expect(b.continuation.guidance).toContain('keep the existing warm path');
    expect(b.continuation.guidance).not.toContain("carry: 'cold'");
    expect(b.continuation.guidance).not.toContain('cold wake starts from that durable carry-note');
  });

  it('runtime wiring: an active loop at its dead-man boundary does not promise another wake', async () => {
    withBoundedTimeout.mockImplementation(async (work: unknown) => ({
      value: typeof work === 'function' ? await (work as () => Promise<unknown>)() : await (work as Promise<unknown>),
      degraded: false,
      elapsedMs: 0,
    }));
    getLoopStatus.mockResolvedValue({
      harnessSlug: 'papercusp',
      active: true,
      carry: 'warm',
      armedAt: '2026-08-25T04:00:00.000Z',
      firesSinceArm: 12,
      intervalSec: 60,
      maxDurationSec: null,
      maxFires: 12,
      nextFireAt: null,
    });
    getModes.mockResolvedValue([{ mode: 'auto' }]);
    getPresence.mockResolvedValue({ contextTokens: 95, compactionLimit: 100 });
    currentContextTokensForOwner.mockResolvedValue(95);
    readWatermark.mockResolvedValue({ messages_since_ts: '2026-08-25T04:00:00.000Z' });

    const b = body(await call({ next: 'settle only when another wake is real' }));

    expect(b.continuation).toMatchObject({
      rewakeGuaranteed: false,
      nextWakeFresh: null,
      activeLoopRewakeBlockedReason: 'max-fires-exhausted',
    });
    expect(b.continuation.guidance).toContain('NO guaranteed re-wake');
    expect(b.continuation.guidance).toContain('an armed loop EXISTS');
    expect(b.continuation.guidance).toContain('maxFires bound is exhausted');
    expect(b.continuation.guidance).not.toContain('no armed loop,');
  });

  it('runtime wiring: an active loop does not promise a wake when the owner route is unreachable', async () => {
    withBoundedTimeout.mockImplementation(async (work: unknown) => ({
      value: typeof work === 'function' ? await (work as () => Promise<unknown>)() : await (work as Promise<unknown>),
      degraded: false,
      elapsedMs: 0,
    }));
    getLoopStatus.mockResolvedValue({
      harnessSlug: 'papercusp',
      active: true,
      carry: 'cold',
      armedAt: '2026-08-25T04:00:00.000Z',
      firesSinceArm: 0,
      intervalSec: 60,
      maxDurationSec: null,
      maxFires: null,
      nextFireAt: null,
      goal: 'continue only when the next wake has a route',
    });
    probeWakeReachability.mockResolvedValue({
      reachable: false,
      channel: 'none',
      durableWhileAlive: false,
      summary: 'no owner wake route',
    });
    getModes.mockResolvedValue([{ mode: 'auto' }]);
    getPresence.mockResolvedValue({ contextTokens: 95, compactionLimit: 100 });
    currentContextTokensForOwner.mockResolvedValue(95);
    readWatermark.mockResolvedValue({ messages_since_ts: '2026-08-25T04:00:00.000Z' });
    readInbox.mockResolvedValue([]);
    listActiveAwaits.mockResolvedValue([]);
    selfCompactionAvailability.mockReturnValue({ available: false });
    readFleetWindDownLoopEndAuthorization.mockResolvedValue(false);

    const b = body(await call({ next: 'settle only when another wake is real' }));

    expect(probeWakeReachability).toHaveBeenCalledWith('su-caller');
    expect(b.continuation).toMatchObject({
      rewakeGuaranteed: false,
      nextWakeFresh: null,
      activeLoopRewakeBlockedReason: 'wake-unreachable',
    });
    expect(b.continuation.guidance).toContain('no delivery route for a fresh turn');
    expect(b.continuation.guidance).toContain('restore an owner wake route');
  });

  it('runtime wiring: reports the standing inbox wake separately from a qualifying deliberate await', async () => {
    withBoundedTimeout.mockImplementation(async (work: unknown) => ({
      value: typeof work === 'function' ? await (work as () => Promise<unknown>)() : await (work as Promise<unknown>),
      degraded: false,
      elapsedMs: 0,
    }));
    getLoopStatus.mockResolvedValue(null);
    getModes.mockResolvedValue([{ mode: 'auto' }]);
    getPresence.mockResolvedValue({ contextTokens: 80, compactionLimit: 100 });
    currentContextTokensForOwner.mockResolvedValue(80);
    readWatermark.mockResolvedValue({ messages_since_ts: '2026-08-25T04:00:00.000Z' });
    readInbox.mockResolvedValue([]);
    listActiveAwaits.mockResolvedValue([{ eventKey: 'coord:inbox-wake:su-caller' }]);

    const b = body(await call({ next: 'checkpoint with standing wake' }));

    expect(b.continuation).toMatchObject({
      rewakeGuaranteed: false,
      activeInboxWakeAwait: true,
    });
    expect(b.continuation.guidance).toContain('no qualifying deliberate await');
    expect(b.continuation.guidance).toContain('active standing coord:inbox-wake await present');
    expect(b.continuation.guidance).not.toContain('no registered await');
  });

  it.each([
    { label: 'unbounded event', eventKey: 'work-item:claimable', expiresTs: null, timeoutBehavior: 'wake', once: true, activeWatch: false, expected: false },
    { label: 'unbounded standing event watch', eventKey: 'work-item:claimable', expiresTs: null, timeoutBehavior: 'wake', once: false, activeWatch: true, expected: false },
    { label: 'silent expiry', eventKey: 'work-item:claimable', expiresTs: '2099-01-01T00:00:00.000Z', timeoutBehavior: 'expire', once: true, activeWatch: false, expected: false },
    { label: 'bounded event wake', eventKey: 'work-item:claimable', expiresTs: '2099-01-01T00:00:00.000Z', timeoutBehavior: 'wake', once: true, activeWatch: false, expected: true },
    { label: 'bounded inbox wake', eventKey: 'coord:inbox-wake:su-caller', expiresTs: '2099-01-01T00:00:00.000Z', timeoutBehavior: 'wake', once: true, activeWatch: false, expected: true },
    { label: 'unbounded inbox wake', eventKey: 'coord:inbox-wake:su-caller', expiresTs: null, timeoutBehavior: 'wake', once: false, activeWatch: false, expected: false },
  ])('runtime wiring: $label has the correct continuation guarantee', async ({ eventKey, expiresTs, timeoutBehavior, once, activeWatch, expected }) => {
    withBoundedTimeout.mockImplementation(async (work: unknown) => ({
      value: typeof work === 'function' ? await (work as () => Promise<unknown>)() : await (work as Promise<unknown>),
      degraded: false,
      elapsedMs: 0,
    }));
    getModes.mockResolvedValue([{ mode: 'auto' }]);
    resolveCurrentTurnStamp.mockResolvedValue({ verdict: 'agent-injected' });
    getPresence.mockResolvedValue({ contextTokens: 80, compactionLimit: 100 });
    currentContextTokensForOwner.mockResolvedValue(80);
    listActiveAwaits.mockResolvedValue([{ eventKey, expiresTs, timeoutBehavior, once }]);

    const b = body(await call({ next: 'settle only with a bounded wake' }));

    expect(b.continuation).toMatchObject({
      rewakeGuaranteed: expected,
      activeInboxWakeAwait: eventKey.startsWith('coord:inbox-wake:'),
      activeUnboundedWakeWatch: activeWatch,
      nextWakeFresh: null,
    });
    if (activeWatch) {
      expect(b.continuation.guidance).toContain('active unbounded wake:true watch present');
      expect(b.continuation.guidance).toContain('does not guarantee another turn if no event fires');
    }
  });

  it.each([
    { label: 'unbounded event', awaitRow: { eventKey: 'work-item:claimable' } },
    { label: 'bounded inbox wake', awaitRow: { eventKey: 'coord:inbox-wake:su-caller', expiresTs: '2099-01-01T00:00:00.000Z', timeoutBehavior: 'wake', once: true } },
  ])('runtime wiring: $label can preempt a cold loop without promising fresh context', async ({ awaitRow }) => {
    withBoundedTimeout.mockImplementation(async (work: unknown) => ({
      value: typeof work === 'function' ? await (work as () => Promise<unknown>)() : await (work as Promise<unknown>),
      degraded: false,
      elapsedMs: 0,
    }));
    getLoopStatus.mockResolvedValue({
      harnessSlug: 'papercusp',
      active: true,
      carry: 'cold',
      intervalSec: 60,
      goal: 'test a competing event wake',
    });
    getModes.mockResolvedValue([{ mode: 'auto' }]);
    getPresence.mockResolvedValue({ contextTokens: 95, compactionLimit: 100 });
    currentContextTokensForOwner.mockResolvedValue(95);
    readWatermark.mockResolvedValue({ messages_since_ts: '2026-08-25T04:00:00.000Z' });
    readInbox.mockResolvedValue([]);
    listActiveAwaits.mockResolvedValue([awaitRow]);
    selfCompactionAvailability.mockReturnValue({ available: false });
    readFleetWindDownLoopEndAuthorization.mockResolvedValue(false);

    const b = body(await call({ next: 'await wake may precede cold loop wake' }));

    expect(b.continuation).toMatchObject({
      rewakeGuaranteed: true,
      activeInboxWakeAwait: awaitRow.eventKey.startsWith('coord:inbox-wake:'),
      nextWakeFresh: null,
    });
    expect(b.continuation.guidance).not.toContain('configured for COLD carry');
    expect(b.continuation.guidance).not.toContain('The guaranteed next wake is WARM');
  });
});

describe('WI-7124: verify-read — the write must read back via the SAME path a cold wake uses', () => {
  it('a normal write reports verified:true + a contentHash (read-back agrees with what was stored)', async () => {
    const b = body(await call({ next: 'x' }));
    expect(b).toMatchObject({ ok: true, verified: true });
    expect(b.contentHash).toMatch(/^[0-9a-f]{12}$/);
    expect(getLoopCarryNoteWithMeta).toHaveBeenCalledWith(
      expect.objectContaining({ harness: 'papercusp', ownerId: 'su-caller' }),
    );
  });

  it('a clear (stored=null) skips the verify-read entirely — nothing to verify', async () => {
    setLoopCarryNote.mockResolvedValueOnce(null);
    const b = body(await call({ note: '' }));
    expect(b).toMatchObject({ ok: true, cleared: true, verified: null, contentHash: null });
    expect(getLoopCarryNoteWithMeta).not.toHaveBeenCalled();
  });

  it('WI-2148-class divergence: a read-back that disagrees with what was stored fails LOUDLY (checkpoint_verify_failed), never silently', async () => {
    // Simulate exactly the documented failure: the write landed under one scope key
    // but the reader resolves a DIFFERENT (stale/absent) row.
    getLoopCarryNoteWithMeta.mockResolvedValueOnce({ note: null, updatedAtMs: null });
    const out = await call({ next: 'x' });
    expect(out.isError).toBe(true);
    const b = body(out);
    expect(b.ok).toBe(false);
    expect(b.error).toMatch(/checkpoint_verify_failed/);
    expect(b.error).toMatch(/WI-2148/);
  });

  it('a verify-read that throws is reported as unavailable, not as a missing note', async () => {
    getLoopCarryNoteWithMeta.mockRejectedValueOnce(new Error('pg down'));
    const out = await call({ next: 'x' });
    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({
      ok: false,
      error: 'checkpoint_verify_unavailable',
      retryable: true,
      writePersisted: true,
      verified: null,
      length: 'stored-note'.length,
      contentHash: shortCarryHash('stored-note'),
    });
  });

  it('a reader-reported store failure is not treated as a confirmed missing note', async () => {
    getLoopCarryNoteWithMeta.mockResolvedValueOnce({ note: null, updatedAtMs: null, readFailed: true });
    const out = await call({ next: 'x' });
    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({
      ok: false,
      error: 'checkpoint_verify_unavailable',
      retryable: true,
      writePersisted: true,
      verified: null,
      length: 'stored-note'.length,
      contentHash: shortCarryHash('stored-note'),
    });
    expect(body(out).message).toContain('Visibility is unknown');
  });

  it('a verify mismatch short-circuits BEFORE the advisory continuation-gate reads run', async () => {
    getLoopCarryNoteWithMeta.mockResolvedValueOnce({ note: 'something-else', updatedAtMs: 1 });
    await call({ next: 'x' });
    // The armed-routine probe and PRE-write P-005 guard run; no advisory
    // continuation-gate read runs after the mismatch.
    expect(withBoundedTimeout.mock.calls.map((c) => (c[1] as { label?: string } | undefined)?.label)).toEqual([
      'loop:checkpoint armed-routine scope probe',
      'loop:checkpoint fleet_zero_workers',
    ]);
  });

  it('refuses a stale expectedHash without reading back or replacing the newer note', async () => {
    setLoopCarryNoteWithPrior.mockResolvedValueOnce({
      stored: 'newer note',
      priorLength: 'newer note'.length,
      blockedReason: 'expected_hash_mismatch',
      conflict: { expectedHash: 'aaaaaaaaaaaa', currentHash: 'bbbbbbbbbbbb' },
    });

    const out = await call({ next: 'stale successor write', expectedHash: 'aaaaaaaaaaaa' });

    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({
      ok: false,
      error: 'checkpoint_conflict',
      expectedHash: 'aaaaaaaaaaaa',
      currentHash: 'bbbbbbbbbbbb',
    });
    expect(getLoopCarryNoteWithMeta).not.toHaveBeenCalled();
  });

  it('surfaces a stale in-flight write as discarded before verify-read', async () => {
    setLoopCarryNoteWithPrior.mockResolvedValueOnce({
      stored: 'newer note',
      priorLength: 'newer note'.length,
      blockedReason: 'stale_write_older_than_current',
      staleWrite: {
        writeStartedAtMs: 100,
        currentUpdatedAtMs: 200,
      },
    });

    const out = await call({ next: 'stale in-flight checkpoint' });

    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({
      ok: false,
      error: 'checkpoint_stale_write',
      retryable: true,
      blockedReason: 'stale_write_older_than_current',
      staleWrite: {
        writeStartedAtMs: 100,
        currentUpdatedAtMs: 200,
      },
      currentHash: shortCarryHash('newer note'),
    });
    expect(getLoopCarryNoteWithMeta).not.toHaveBeenCalled();
  });
});

describe('P-005 / D-030 (7): a fleet-leader monitor cannot record a quiet wake on an empty fleet', () => {
  const GUARD_LABEL = 'loop:checkpoint fleet_zero_workers';
  // Run the guard's bounded work for real (so checkFleetZeroWorkers is reached); every
  // other bounded call keeps the suite default.
  type BoundedResult = { value: unknown; degraded: boolean; elapsedMs: number; reason?: string };
  const routeGuardForReal = (override?: (fallback: unknown) => BoundedResult) =>
    withBoundedTimeout.mockImplementation(async (work: unknown, opts: unknown) => {
      const o = opts as { label?: string; fallback?: unknown };
      if (o?.label !== GUARD_LABEL) return { value: undefined, degraded: false, elapsedMs: 0 };
      if (override) return override(o.fallback);
      return { value: await (work as () => Promise<unknown>)(), degraded: false, elapsedMs: 0 };
    });
  const refusal = {
    action: 'refuse' as const,
    fleetSlug: 'fleet-x',
    message: 'Fleet fleet-x, which this monitor loop leads, has 0 productive workers against target 3.',
    repairs: ['fleet:headcount-target { target, supervise:true }', 'fleet:launch-on-plan', 'fleet:wind-down'],
  };

  beforeEach(() => {
    checkFleetZeroWorkers.mockReset();
    checkFleetZeroWorkers.mockResolvedValue({ action: 'allow' });
  });

  it('refuses a quiet wake with fleet_zero_workers and writes nothing', async () => {
    routeGuardForReal();
    checkFleetZeroWorkers.mockResolvedValueOnce(refusal);

    const out = await call({ did: 'watched the fleet', next: 'keep watching' });

    expect(checkFleetZeroWorkers).toHaveBeenCalledWith({ workspaceId: 'ws-1', ownerId: 'su-caller', monitorDelta: false });
    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({
      ok: false,
      error: 'fleet_zero_workers',
      fleet: 'fleet-x',
      message: refusal.message,
      repairs: refusal.repairs,
    });
    expect(setLoopCarryNote).not.toHaveBeenCalled();
    expect(setLoopCarryNoteWithPrior).not.toHaveBeenCalled();
  });

  it('allows the write and surfaces the warning when the headcount is unmeasured', async () => {
    routeGuardForReal();
    const warning = 'fleet_zero_workers not checked for fleet fleet-x: the staffing read failed.';
    checkFleetZeroWorkers.mockResolvedValueOnce({ action: 'allow', warning });

    const b = body(await call({ did: 'watched the fleet', next: 'keep watching' }));

    expect(b).toMatchObject({ ok: true, fleetZeroWorkersWarning: warning });
  });

  it('fails open with a warning when the guard read times out', async () => {
    routeGuardForReal((fallback) => ({ value: fallback, degraded: true, reason: 'timeout', elapsedMs: 3_000 }));

    const b = body(await call({ did: 'watched the fleet', next: 'keep watching' }));

    expect(b.ok).toBe(true);
    expect(b.fleetZeroWorkersWarning).toBe('fleet_zero_workers not checked (timeout); the checkpoint was allowed.');
    expect(withBoundedTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ fallback: { action: 'allow' }, timeoutMs: 3_000, label: GUARD_LABEL }),
    );
  });

  it('adds no warning field when the guard allows a staffed fleet', async () => {
    routeGuardForReal();

    const b = body(await call({ did: 'watched the fleet', next: 'keep watching' }));

    expect(checkFleetZeroWorkers).toHaveBeenCalledTimes(1);
    expect(b.ok).toBe(true);
    expect(b).not.toHaveProperty('fleetZeroWorkersWarning');
  });

  it('does not consult the guard for a monitorDelta checkpoint', async () => {
    routeGuardForReal();
    checkFleetZeroWorkers.mockResolvedValue(refusal);
    // recordMonitorDelta runs against the stubbed SQL; a failed stamp only warns.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const b = body(await call({ did: 'a worker finished WI-1', next: 'keep watching', monitorDelta: true }));

    warn.mockRestore();
    expect(checkFleetZeroWorkers).not.toHaveBeenCalled();
    expect(b.ok).toBe(true);
  });

  it('does not consult the guard without a workspace', async () => {
    routeGuardForReal();
    checkFleetZeroWorkers.mockResolvedValue(refusal);

    await call({ next: 'x' }, { harnessSlug: 'papercusp' });

    expect(checkFleetZeroWorkers).not.toHaveBeenCalled();
  });
});

describe('EI-22995965169175295: qualified plan-decision refs in loop carry responses', () => {
  it('advises on unresolved qualified refs from the final stored note, without blocking the write', async () => {
    const stored = 'Resume from governed-plan#D-015 before the next cold wake; bare D-015 is not resolvable here.';
    const advisory = {
      flagged: true,
      refs: [
        {
          ref: 'governed-plan#D-015',
          slug: 'governed-plan',
          decisionId: 'D-015',
          reason: 'missing-plan',
        },
      ],
      note: 'decision_ref_lint: advisory only',
    };
    setLoopCarryNote.mockResolvedValueOnce(stored);
    unresolvedPlanDecisionRefs.mockResolvedValueOnce(advisory);

    const result = body(await call({ note: stored }));

    expect(unresolvedPlanDecisionRefs).toHaveBeenCalledWith(stored, {
      workspaceId: 'ws-1',
      harnessSlug: 'papercusp',
    });
    expect(result).toMatchObject({ ok: true, decisionRefAdvisory: advisory });
  });

  it('fails open when the advisory resolver rejects', async () => {
    unresolvedPlanDecisionRefs.mockRejectedValueOnce(new Error('resolver unavailable'));

    const result = body(await call({ note: 'Resume from governed-plan#D-015.' }));

    expect(result).toMatchObject({ ok: true });
    expect(result).not.toHaveProperty('decisionRefAdvisory');
  });
});

describe('loop:checkpoint — the P-006 walls merge (commitments cleared explicitly, never incidentally)', () => {
  const PRIOR_WITH_WALL = [
    '## Next action',
    'old next step',
    '',
    '## Walls',
    '- zombie PIDs await owner OK — re-check: ps -p 95902 (since 2026-07-07T12:00:00.000Z)',
  ].join('\n');

  it('a rewrite WITHOUT walls carries the prior walls forward onto the new note', async () => {
    getLoopCarryNote.mockResolvedValue(PRIOR_WITH_WALL);
    const b = body(await call({ did: 'landed X', next: 'ship Y' }));
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    expect(written).toContain('RENDERED:');
    expect(withoutRowIds(written)).toContain('## Walls');
    expect(withoutRowIds(written)).toContain('- zombie PIDs await owner OK — re-check: ps -p 95902 (since 2026-07-07T12:00:00.000Z)');
    expect(b).toMatchObject({ ok: true, walls: 1 });
  });

  it('preserves prose appended after the generated Walls section and verifies the retained note', async () => {
    const addendum = '14:40Z QUIET-WAKE DISPOSITION: the current lane is settled';
    getLoopCarryNote.mockResolvedValue(PRIOR_WITH_WALL);
    setLoopCarryNote.mockImplementation(async (_ref: unknown, note: unknown) => note as string);

    const b = body(await call({ note: `${PRIOR_WITH_WALL}\n\n${addendum}` }));
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];

    expect(b).toMatchObject({ ok: true, verified: true });
    expect(written).toContain(addendum);
    expect(written.indexOf(addendum)).toBeLessThan(written.indexOf('## Walls'));
  });

  it('a note CLEAR with standing walls preserves them as a walls-only note (never an incidental clear)', async () => {
    getLoopCarryNote.mockResolvedValue(PRIOR_WITH_WALL);
    await call({ note: '' });
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    expect(withoutRowIds(written)).toContain('## Walls\n- zombie PIDs await owner OK');
    expect(written).not.toContain('old next step');
  });

  // Post-P-013 the empty list is a NO-OP under the merge default (the tool says so in
  // its own rowsModeNote), so the clear has to be asked for: replace + []. That is the
  // point of the change — a commitment can no longer be cleared incidentally.
  it('an individually named wall retirement can clear a walls-only note', async () => {
    getLoopCarryNote.mockResolvedValue(PRIOR_WITH_WALL);
    setLoopCarryNote.mockResolvedValue(null);
    const b = body(await call({ note: '', walls: [], rowsMode: 'replace', retireIds: ['zombie PIDs await owner OK'] }));
    expect(setLoopCarryNote).toHaveBeenCalledWith(expect.anything(), '');
    expect(b).toMatchObject({ ok: true, cleared: true, walls: 0 });
  });

  it('explicit walls replace the set, preserving sinceMs + recheck for a claim that already stood', async () => {
    getLoopCarryNote.mockResolvedValue(PRIOR_WITH_WALL);
    await call({
      next: 'continue',
      walls: [{ claim: 'zombie PIDs await owner OK' }, { claim: 'capital arming pending owner decision' }],
    });
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    expect(withoutRowIds(written)).toContain('- zombie PIDs await owner OK — re-check: ps -p 95902 (since 2026-07-07T12:00:00.000Z)');
    expect(withoutRowIds(written)).toContain('- capital arming pending owner decision (since ');
  });

  it('a walls-only write keeps the narrative and retires only its named predecessor', async () => {
    getLoopCarryNote.mockResolvedValue(PRIOR_WITH_WALL);
    const b = body(
      await call({ walls: [{ claim: 'new wall', recheck: 'check-it' }], rowsMode: 'replace', retireIds: ['zombie PIDs await owner OK'] }),
    );
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    expect(written).toContain('## Next action\nold next step'); // body carried forward
    expect(withoutRowIds(written)).toContain('- new wall — re-check: check-it');
    expect(written).not.toContain('zombie PIDs');
    expect(b).toMatchObject({ ok: true, walls: 1 });
  });

  // ── WI-6813: the merge moved INSIDE the write transaction ──────────────────
  //
  // This replaces an older test that pinned the opposite contract ("a throwing
  // prior-note read FAILS OPEN: the write proceeds with no carried walls"). That
  // behaviour was a latent data-loss bug, not a safety property: the tool read the
  // prior in a SEPARATE round-trip, so a transient read blip silently dropped every
  // carried wall — owner-gated commitments — and still reported ok:true, which is
  // precisely the failure walls exist to prevent. There is no separate read to fail
  // any more, so the fail-open path it protected is now unreachable by construction.
  it('WI-6813: merges against the STORE-side prior, so a concurrent writer is not clobbered', async () => {
    // The race the old caller-side read → merge → write had: a peer lands between
    // the read and the write. Here the stale caller-side view (getLoopCarryNote)
    // shows NO walls, while the row the write actually LOCKS carries one. The
    // stored note must reflect the locked row — under the old shape the peer's wall
    // was silently clobbered.
    getLoopCarryNote.mockResolvedValue(null);
    storePriorOverride = PRIOR_WITH_WALL;
    const b = body(await call({ next: 'x' }));
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    expect(written).toContain('zombie PIDs');
    // The REPORTED count comes from the transform's own output, so it describes what
    // was actually stored rather than a second, staler merge that could disagree.
    expect(b).toMatchObject({ ok: true, walls: 1 });
  });

  it('WI-6813: performs no separate prior read — the merge runs in the write transaction', async () => {
    getLoopCarryNote.mockResolvedValue(PRIOR_WITH_WALL);
    await call({ next: 'x' });
    // Exactly one write call, and it carries the transform the store runs under its
    // row lock. (The only getLoopCarryNote call is the double's own, standing in for
    // the store's locked read — the tool itself no longer reads the prior at all.)
    expect(setLoopCarryNoteWithPrior).toHaveBeenCalledTimes(1);
    const opts = setLoopCarryNoteWithPrior.mock.calls[0]![2] as { transform?: unknown };
    expect(typeof opts?.transform).toBe('function');
    expect(getLoopCarryNote).toHaveBeenCalledTimes(1);
  });

  it('WI-6813: a failing store surfaces the error instead of storing a walls-less note', async () => {
    // The corrected contract. Losing the checkpoint loudly is strictly safer than
    // succeeding with the carried commitments silently stripped out.
    setLoopCarryNote.mockRejectedValue(new Error('pg down'));
    storePriorOverride = PRIOR_WITH_WALL;
    await expect(call({ next: 'x' })).rejects.toThrow('pg down');
  });
});

describe('loop:checkpoint — current-vs-retained provenance (EI-21165235642497045)', () => {
  it('reports lint from carried rows under retainedProvenance, not provenanceLint', async () => {
    const current = 'the owner said to run the focused suite';
    const retained = 'the owner said to retain the old checkpoint';
    const prior = mergeCarryRows({
      priorNote: null,
      baseNote: 'old narrative',
      checks: [{ claim: retained }],
      hasNoteWrite: true,
    }).note;

    getLoopCarryNote.mockResolvedValue(prior);
    setLoopCarryNote.mockImplementation(async (_ref: unknown, note: unknown) => note as string);
    withBoundedTimeout.mockImplementation(async (_work: unknown, options: unknown) => ({
      value: (options as { label?: string } | undefined)?.label === 'carry-provenance-stamp' ? [[], null] : undefined,
      degraded: false,
      elapsedMs: 0,
    }));

    const result = body(await call({ note: current }));

    expect(result.ok).toBe(true);
    expect(result.provenanceLint?.matches.some((match: { line: string }) => match.line === current)).toBe(true);
    expect(result.retainedProvenance?.matches.some((match: { line: string }) => match.line.includes(retained))).toBe(
      true,
    );
  });

  it('surfaces an unresolved turn ref as provenance lint without changing checked:false', async () => {
    const ref = '[turn:wakepump@2026-09-05T21:26:41Z]';
    setLoopCarryNote.mockImplementation(async (_ref: unknown, note: unknown) => note as string);
    withBoundedTimeout.mockImplementation(async (_work: unknown, options: unknown) => ({
      value: (options as { label?: string } | undefined)?.label === 'carry-provenance-stamp' ? [[], null] : undefined,
      degraded: false,
      elapsedMs: 0,
    }));

    const result = body(await call({ note: `The wake-pump action is recorded at ${ref}.` }));

    expect(result.ok).toBe(true);
    expect(result.provenanceLint?.matches.some((match: { kind: string }) => match.kind === 'unresolved-turn-ref')).toBe(
      true,
    );
    expect(result.turnProvenance?.refs?.[0]).toMatchObject({ ref, found: false, checked: false });
  });
});

describe('loop:checkpoint — current-turn sentinel reuses its resolved transcript stamp (EI-25234674994072047)', () => {
  it('does not turn a just-resolved [turn:self] anchor into an unchecked miss on a second read', async () => {
    const currentTurn = {
      ref: '[turn:claude:a@2026-10-06T12:54:21.287Z]',
      verdict: 'agent-injected' as const,
      origin: 'loop-fire',
    };
    resolveCurrentTurnStamp.mockResolvedValueOnce(currentTurn).mockResolvedValueOnce(null);
    verifyTurnRefs.mockResolvedValueOnce([
      {
        ref: currentTurn.ref,
        found: false,
        verdict: null,
        origin: null,
        snippet: null,
        quote: null,
        quoteMatch: null,
        checked: false,
        scope: 'cross-session',
      },
    ]);
    withBoundedTimeout.mockImplementation(async (work: unknown, options: unknown) => {
      if ((options as { label?: string }).label === 'carry-provenance-stamp') {
        return { value: await (work as Promise<unknown>), degraded: false, elapsedMs: 0 };
      }
      if ((options as { label?: string }).label === 'loop:checkpoint decision-ref advisory') {
        try {
          return { value: await (work as Promise<unknown>), degraded: false, elapsedMs: 0 };
        } catch {
          return { value: undefined, degraded: true, elapsedMs: 0 };
        }
      }
      return { value: undefined, degraded: false, elapsedMs: 0 };
    });

    const result = body(await call({ note: 'The current turn is [turn:self].' }));

    expect(resolveCurrentTurnStamp).toHaveBeenCalledTimes(1);
    expect(verifyTurnRefs).not.toHaveBeenCalled();
    expect(result.turnProvenance?.refs).toMatchObject([
      { ref: currentTurn.ref, found: true, checked: true, verdict: 'agent-injected', origin: 'loop-fire' },
    ]);
    expect(result.provenanceLint?.matches?.map((match: { kind: string }) => match.kind) ?? []).not.toContain(
      'unresolved-turn-ref',
    );
    expect(setLoopCarryNote.mock.calls[0]?.[1]).toContain(currentTurn.ref);
  });

  it('expands [turn:self] in structured check and wall rows before linting and storage', async () => {
    const currentTurn = {
      ref: '[turn:claude:current-row@2026-10-16T12:00:00.000Z]',
      verdict: 'agent-injected' as const,
      origin: 'loop-fire',
    };
    const checkClaim = 'Posted completion evidence to WI-2144600 [turn:self]';
    resolveCurrentTurnStamp.mockReset();
    resolveCurrentTurnStamp.mockResolvedValue(currentTurn);
    withBoundedTimeout.mockImplementation(async (work: unknown, options: unknown) => {
      const label = (options as { label?: string }).label;
      if (label === 'carry-provenance-stamp') {
        return { value: await (work as Promise<unknown>), degraded: false, elapsedMs: 0 };
      }
      if (label === 'loop:checkpoint decision-ref advisory') {
        try {
          return { value: await (work as Promise<unknown>), degraded: false, elapsedMs: 0 };
        } catch {
          return { value: undefined, degraded: true, elapsedMs: 0 };
        }
      }
      return { value: undefined, degraded: false, elapsedMs: 0 };
    });

    const result = body(
      await call({
        checks: [{ claim: checkClaim, recheck: 'read the matching work-item thread', verified: 'tool receipt', ok: true }],
        walls: [{ claim: 'The carry row was recorded during [turn:self].' }],
      }),
    );
    const stored = String(setLoopCarryNote.mock.calls[0]?.[1] ?? '');

    expect(result).toMatchObject({ ok: true, verified: true, checks: 1, walls: 1 });
    expect(resolveCurrentTurnStamp).toHaveBeenCalled();
    expect(stored).not.toContain('[turn:self]');
    expect(stored.split(currentTurn.ref)).toHaveLength(3);
    expect(result.turnProvenance?.refs).toMatchObject([
      { ref: currentTurn.ref, found: true, checked: true, verdict: 'agent-injected', origin: 'loop-fire' },
    ]);
    expect(result.provenanceLint?.flagged ?? false).toBe(false);
  });
});

describe('loop:checkpoint — same-turn action proof (EI-25298018130887432)', () => {
  const actionContext = {
    harnessSlug: 'papercusp',
    workspaceId: 'ws-1',
    spawnId: 'spawn-action-proof',
  };

  it('suppresses a matching successful coord action and scopes the ledger read to this caller', async () => {
    readSuccessfulActionInvocations.mockResolvedValueOnce([
      { toolName: 'coord:send', args: { to: ['su-bce40c51'], summary: 'handoff' } },
    ]);

    const result = body(await call({ note: 'Messaged fleet leader su-bce40c51 directly' }, actionContext));

    expect(result).toMatchObject({ ok: true, verified: true });
    expect(result.provenanceLint).toBeUndefined();
    expect(readSuccessfulActionInvocations).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      spawnId: 'spawn-action-proof',
      coordOwnerId: 'su-caller',
    });
  });

  it('uses the successful action proof when the documented current-turn sentinel cannot resolve', async () => {
    resolveCurrentTurnStamp.mockResolvedValueOnce(null);
    readSuccessfulActionInvocations.mockResolvedValueOnce([
      { toolName: 'coord:send', args: { to: ['su-bce40c51'], summary: 'handoff' } },
    ]);

    const result = body(
      await call({ did: '[turn:self] Messaged fleet leader su-bce40c51 directly' }, actionContext),
    );

    expect(result).toMatchObject({ ok: true, verified: true });
    expect(result.provenanceLint).toBeUndefined();
    expect(String(setLoopCarryNote.mock.calls[0]?.[1] ?? '')).toContain('[turn:self]');
  });

  it('keeps the warning when the same-turn action ledger is unavailable', async () => {
    readSuccessfulActionInvocations.mockResolvedValueOnce(null);

    const result = body(await call({ note: 'Messaged fleet leader su-bce40c51 directly' }, actionContext));

    expect(result.ok).toBe(true);
    expect(result.provenanceLint?.matches[0]?.kind).toBe('unverified-action-claim');
  });
});

describe('pickUnreadCursor — P-007 fleet-member-dx (EI-9035)', () => {
  it('never-settled watermark + a real inbox read ⇒ the read is the cursor (the old permanent "inbox not evaluated" case)', async () => {
    const { pickUnreadCursor } = await import('./checkpoint');
    expect(pickUnreadCursor('', '2026-07-10T03:00:00.000Z')).toBe('2026-07-10T03:00:00.000Z');
    expect(pickUnreadCursor(null, '2026-07-10T03:00:00.000Z')).toBe('2026-07-10T03:00:00.000Z');
  });

  it('a mid-turn read AFTER the last settle narrows the window to post-read arrivals', async () => {
    const { pickUnreadCursor } = await import('./checkpoint');
    expect(pickUnreadCursor('2026-07-10T01:00:00.000Z', '2026-07-10T03:00:00.000Z')).toBe('2026-07-10T03:00:00.000Z');
  });

  it('a stale read BEFORE the last settle defers to the watermark', async () => {
    const { pickUnreadCursor } = await import('./checkpoint');
    expect(pickUnreadCursor('2026-07-10T03:00:00.000Z', '2026-07-10T01:00:00.000Z')).toBe('2026-07-10T03:00:00.000Z');
  });

  it('neither cursor ⇒ null (the gate blocks — fail-safe toward settling, unchanged)', async () => {
    const { pickUnreadCursor } = await import('./checkpoint');
    expect(pickUnreadCursor('', null)).toBeNull();
    expect(pickUnreadCursor(undefined, undefined)).toBeNull();
  });
});

// EI-18833865002636933 — the SEAM: a `did` that is really a tag-serialized whole note is
// rescued back into four fields + typed checks BEFORE renderCarryNote sees it, and the
// rescue is REPORTED (silence is the defect this closes: the degraded note reached the
// next cold wake looking like sloppy authoring, with nothing saying it had been mangled).
describe('EI-18833865002636933: rescue-by-parse of a tag-serialized structured write', () => {
  const BLOB = [
    'Closed two gate threats.</did>',
    '<left>Nothing claimed.</left>',
    '<insight>A gate verdict is a snapshot.</insight>',
    '<next>Confirm the gate outcome.</next>',
    '<checks>[{"claim":"main is green","recheck":"git rev-parse main","verified":"21:05Z verdict"}]</checks>',
  ].join('\n');

  it('splits the blob into four fields, recovers typed checks, and REPORTS the rescue', async () => {
    const b = body(await call({ did: BLOB }));
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    expect(written).toContain(
      'RENDERED:' +
        JSON.stringify({
          did: 'Closed two gate threats.',
          left: 'Nothing claimed.',
          insight: 'A gate verdict is a snapshot.',
          next: 'Confirm the gate outcome.',
        }),
    );
    // the checks became a real `## Checks` section with the ✓ badge, not inert JSON prose
    expect(b.checks).toBe(1);
    expect(written).toContain('## Checks');
    expect(withoutRowIds(written)).toContain('- ✓ main is green — re-check: git rev-parse main');
    expect(b.rescued).toMatchObject({ from: 'tagged-blob' });
    expect(b.rescued.recovered).toEqual(expect.arrayContaining(['left', 'insight', 'next', 'checks']));
  });

  it('an explicit `checks` arg still WINS over a rescued <checks> block', async () => {
    const b = body(await call({ did: BLOB, checks: [{ claim: 'explicit wins' }] }));
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    expect(b.checks).toBe(1);
    expect(written).toContain('explicit wins');
    expect(written).not.toContain('main is green');
  });

  // ── NEGATIVE CONTROLS (the load-bearing half) ──────────────────────────────────
  it('NEGATIVE: a `did` quoting code/JSX/shell is stored BYTE-IDENTICAL and never split', async () => {
    const honest = 'Ran `cmd 2>&1 > /tmp/x.log`; fixed `<div><span/></div>` and the `a < b` guard.';
    await call({ did: honest });
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    expect(written).toBe('RENDERED:' + JSON.stringify({ did: honest }));
  });

  it('NEGATIVE: a correctly-structured call is untouched by the rescue path', async () => {
    // `did` even contains the literal close tag — siblings ARE present, so this is a
    // well-formed write that merely quotes the tag, not a serialized blob.
    const b = body(await call({ did: 'documented </did> in the runbook', left: 'l', insight: 'i', next: 'n' }));
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    expect(written).toContain(
      'RENDERED:' + JSON.stringify({ did: 'documented </did> in the runbook', left: 'l', insight: 'i', next: 'n' }),
    );
    expect(b.rescued).toBeUndefined();
  });

  it('NEGATIVE: a raw { note } containing the tag shape is written verbatim (raw notes are never parsed)', async () => {
    await call({ note: BLOB });
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    expect(written).toContain('</did>');
    expect(written).not.toContain('RENDERED:');
  });

  // EI-21918217118634060: a sibling's CLOSE tag was present in the blob (so the rescue
  // fires) but its OPEN tag never was, so it fails to extract — the rescue must NOT
  // claim "stored correctly" for that section, and must NAME it as dropped.
  it('a signaled-but-unrecovered sibling is named in droppedSections, and the note stops claiming success', async () => {
    const partiallyMalformed = [
      'Closed two gate threats.</did>',
      '<left>Nothing claimed.</left>',
      'Something about the gate in prose.</insight>', // no matching <insight> opener
      '<next>Confirm the gate outcome.</next>',
    ].join('\n');
    const b = body(await call({ did: partiallyMalformed }));
    expect(b.rescued.recovered).toEqual(expect.arrayContaining(['did', 'left', 'next']));
    expect(b.rescued.recovered).not.toContain('insight');
    expect(b.rescued.droppedSections).toEqual(['insight']);
    expect(b.rescued.note).not.toContain('stored correctly');
    expect(b.rescued.note).toContain('insight');
  });

  it('a fully-clean rescue reports no droppedSections and keeps the "stored correctly" note', async () => {
    const b = body(await call({ did: BLOB }));
    expect(b.rescued.droppedSections).toBeUndefined();
    expect(b.rescued.note).toContain('stored correctly');
  });
});

// WI-7264 — a carry-note write must not be DISCARDED over one oversized or
// wrong-shaped sub-field.
//
// Measured over 6 days of real transcripts: 80 of 1,152 loop:checkpoint calls were
// rejected (541,043 argument chars, 7.7% of this tool's total), and the bytes are
// spent TWICE because the agent rewrites and re-sends the whole note. 53 of those
// were a sub-field a few chars over its cap; ~97 were the `{status, evidence}` row
// shape. Both discard a ~6KB note the caller had already paid to transmit.
//
// The contract these tests pin: repair what is unambiguously repairable, REPORT any
// repair that lost bytes, and keep rejecting what is genuinely undeclared (EI-10883).
describe("WI-7264: repair-don't-refuse — an oversized or wrong-shaped sub-field must not discard the note", () => {
  describe('row SHAPE coercion (the {status, evidence} confusion)', () => {
    it('accepts and persists a canonical check-row falsifier', async () => {
      const check = {
        claim: 'checks rows preserve a declared falsifier',
        recheck: 'parse and persist the check row',
        falsifier: 'the parser rejects checks[0].falsifier as unrecognized',
        verified: 'the handler parsed and persisted this row',
      };
      const parsed = parse({ checks: [check] }) as { checks: typeof check[] };

      expect(parsed.checks).toEqual([check]);

      const b = body(await call({ did: 'checkpointed the check-row contract', checks: [check] }));
      expect(b).toMatchObject({ ok: true, checks: 1 });
      expect(b.repairs).toBeUndefined();
      const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
      expect(written).toContain(' — falsifier: the parser rejects checks[0].falsifier as unrecognized');
    });

    it('preserves canonical verified evidence when the ok:true alias is also present through immediate readback (EI-25632229189825943)', async () => {
      const evidence = 'the focused checkpoint probe passed';
      // The default store double returns a sentinel, which is enough for the
      // write-path assertions but cannot model a reader seeing the persisted
      // note. Return the actual second argument so this regression covers the
      // write -> read:true round trip as the production store does.
      setLoopCarryNote.mockImplementationOnce(async (_ref: unknown, note: unknown) => note as string);
      const b = body(
        await call({
          did: 'checkpointed the compatibility row',
          checks: [{ claim: 'the checkpoint probe is green', recheck: 'run the focused probe', verified: evidence, ok: true }],
        }),
      );

      expect(b).toMatchObject({ ok: true, verified: true, checks: 1 });
      expect(b.repairs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'checks[0].ok',
            kind: 'renamed',
            detail: expect.stringContaining('canonical verified value was kept'),
          }),
        ]),
      );

      const [, stored] = setLoopCarryNote.mock.calls[0] as [unknown, string];
      const storedCheck = splitCarryNoteChecks(stored).checks[0];
      expect(storedCheck).toMatchObject({
        claim: 'the checkpoint probe is green',
        recheck: 'run the focused probe',
        verified: expect.stringContaining(evidence),
      });
      expect(storedCheck?.observed).toBeUndefined();

      const read = body(await call({ read: true }));
      expect(read.checks).toHaveLength(1);
      expect(read.checks[0]).toMatchObject({ verified: expect.stringContaining(evidence) });
      expect(read.checks[0]?.observed).toBeUndefined();
    });

    it('persists verification for both keyed rows under rowsMode:merge through immediate readback (EI-26313956798536800)', async () => {
      const prior = mergeCarryRows({
        priorNote: null,
        baseNote: 'prior body',
        checks: [
          { id: 'inbox-wake-progress', claim: 'the inbox wake progressed', recheck: 'read the wake ledger' },
          { id: 'inbox-wake-unfulfilled', claim: 'no inbox wake remained unfulfilled', recheck: 'read the wake ledger' },
        ],
        hasNoteWrite: true,
      }).note;
      getLoopCarryNote.mockResolvedValue(prior);
      // Model the production write/read round trip so the regression proves the
      // persisted artifact is what the immediate reader returns for BOTH rows.
      setLoopCarryNote.mockImplementationOnce(async (_ref: unknown, note: unknown) => note as string);

      const progressEvidence = 'observed the inbox wake progress at 12:24Z';
      const unfulfilledEvidence = 'observed zero unfulfilled inbox wakes at 12:24Z';
      const b = body(
        await call({
          checks: [
            {
              id: 'inbox-wake-progress',
              claim: 'the inbox wake progressed',
              recheck: 'read the wake ledger',
              verified: progressEvidence,
            },
            {
              id: 'inbox-wake-unfulfilled',
              claim: 'no inbox wake remained unfulfilled',
              recheck: 'read the wake ledger',
              verified: unfulfilledEvidence,
            },
          ],
          rowsMode: 'merge',
        }),
      );

      expect(b).toMatchObject({ ok: true, verified: true, checks: 2, rowsMode: 'merge' });
      expect(b.repairs).toBeUndefined();
      const storedChecks = splitCarryNoteChecks(lastStoredNote).checks;
      expect(storedChecks).toHaveLength(2);
      expect(storedChecks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'inbox-wake-progress', verified: expect.stringContaining(progressEvidence) }),
          expect.objectContaining({ id: 'inbox-wake-unfulfilled', verified: expect.stringContaining(unfulfilledEvidence) }),
        ]),
      );

      const read = body(await call({ read: true }));
      expect(read.checks).toHaveLength(2);
      expect(read.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'inbox-wake-progress', verified: expect.stringContaining(progressEvidence) }),
          expect.objectContaining({ id: 'inbox-wake-unfulfilled', verified: expect.stringContaining(unfulfilledEvidence) }),
        ]),
      );
    });

    it('maps {status, evidence} to `verified`, PRESERVING the evidence rather than dropping it', () => {
      const out = parse({
        checks: [{ claim: 'gate is green', recheck: 'state:read', status: 'verified', evidence: 'saw 30/30 pass' }],
      }) as { checks: { claim: string; recheck?: string; verified?: string }[] };
      // The evidence survives, so the row still renders VERIFIED. This is the exact
      // data EI-18723223344390510 used to destroy silently.
      expect(out.checks[0]).toEqual({ claim: 'gate is green', recheck: 'state:read', verified: 'saw 30/30 pass' });
    });

    it('downgrades contradictory verification evidence at the writer boundary and reports the repair', async () => {
      const b = body(
        await call({
          did: 'checkpointed the affected suite',
          checks: [{ claim: 'the suite is green', recheck: 'run the suite', verified: 'STILL RUNNING at compaction' }],
        }),
      );
      expect(b.ok).toBe(true);
      expect(b.repairs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'checks[0].verified',
            kind: 'downgraded',
            detail: expect.stringContaining('STILL RUNNING'),
          }),
        ]),
      );
      const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
      expect(withoutRowIds(written)).toContain('- ⚠ ');
      expect(written).toContain('STILL RUNNING');
      expect(written).not.toContain('- ✓ ');
    });

    it('keeps running evidence VERIFIED when the claim itself is about queued work', async () => {
      const claim = 'fresh typechecks remain queued';
      const evidence = "both sessions were 'still running and queued at ~180s'";
      const b = body(
        await call({
          did: 'checkpointed the queued typechecks',
          checks: [{ claim, recheck: 'inspect the typecheck sessions', verified: evidence }],
        }),
      );
      expect(b.ok).toBe(true);
      expect(b.repairs).toBeUndefined();
      const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
      expect(withoutRowIds(written)).toContain('- ✓ ');
      expect(written).toContain(evidence);
      expect(written).not.toContain('- ⚠ ');
    });

    it('keeps a pending rerun VERIFIED when it supports an explicit non-admission claim', async () => {
      const evidence = 'Stable C remains non-admitting; exact rerun was pending.';
      const b = body(
        await call({
          did: 'checkpointed the non-admission evidence',
          checks: [{ claim: 'Stable C remains non-admitting', recheck: 'repeat the exact rerun', verified: evidence }],
        }),
      );
      expect(b.ok).toBe(true);
      expect(b.repairs).toBeUndefined();
      const [, written] = setLoopCarryNote.mock.calls.at(-1) as [unknown, string];
      expect(withoutRowIds(written)).toContain('- ✓ ');
      expect(written).toContain(evidence);
      expect(written).not.toContain('- ⚠ ');
    });

    it('keeps clean verification evidence as VERIFIED', async () => {
      const b = body(
        await call({
          did: 'checkpointed the affected suite',
          checks: [{ claim: 'the suite is green', recheck: 'run the suite', verified: '30/30 passed' }],
        }),
      );
      expect(b.ok).toBe(true);
      expect(b.repairs).toBeUndefined();
      const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
      expect(withoutRowIds(written)).toContain('- ✓ ');
    });

    it('keeps structured out-of-scope disposition counts VERIFIED at the writer boundary', async () => {
      const claim = 'the scoped cohort snapshot is complete';
      const evidence = JSON.stringify({ checked: 5, 'out-of-scope': 2, notChecked: 0 });
      const b = body(
        await call({
          did: 'checkpointed the scoped cohort snapshot',
          checks: [{ claim, recheck: 'read the cohort counts', verified: evidence }],
        }),
      );

      expect(b.ok).toBe(true);
      expect(b.repairs).toBeUndefined();
      const [, written] = setLoopCarryNote.mock.calls.at(-1) as [unknown, string];
      expect(withoutRowIds(written)).toContain('- ✓ ');
      expect(written).toContain(evidence);
      expect(written).not.toContain('- ⚠ ');
    });

    it('keeps literal lifecycle fields and await counts VERIFIED at the writer boundary', async () => {
      const literalStateEvidence = [
        'events:status expected_verdict=pending',
        'D-077 pending-fire hold',
        'loop health check reported five live awaits',
        'loop active/reachable interval180, pending exact await; events:await returned81020',
      ];

      for (const evidence of literalStateEvidence) {
        const b = body(
          await call({
            did: 'checkpointed the observed loop state',
            checks: [
              { claim: 'the observed loop state is verified', recheck: 'repeat the state probe', verified: evidence },
            ],
          }),
        );
        expect(b.ok, evidence).toBe(true);
        expect(b.repairs, evidence).toBeUndefined();
        const [, written] = setLoopCarryNote.mock.calls.at(-1) as [unknown, string];
        expect(withoutRowIds(written), evidence).toContain('- ✓ ');
        expect(written, evidence).toContain(evidence);
        expect(written, evidence).not.toContain('- ⚠ ');
      }
    });

    it('maps descriptive label/name rows to `claim` while preserving an explicit claim', () => {
      const out = parse({
        checks: [
          { label: 'labelled claim', status: 'verified', evidence: 'observed labelled claim' },
          { name: 'named claim' },
          {
            claim: 'canonical claim',
            label: 'ignored label',
            name: 'ignored name',
            status: 'verified',
            evidence: 'observed canonical claim',
          },
        ],
      }) as { checks: { claim: string; verified?: string }[] };

      expect(out.checks).toEqual([
        { claim: 'labelled claim', verified: 'observed labelled claim' },
        { claim: 'named claim' },
        { claim: 'canonical claim', verified: 'observed canonical claim' },
      ]);
    });

    it('maps structured kind/command/result rows to the canonical check shape', () => {
      const out = parse({
        checks: [
          {
            kind: 'the focused checkpoint test passes',
            command: 'npm run test:file -- checkpoint.test.ts',
            result: '8/8 tests passed',
          },
        ],
      }) as { checks: { claim: string; recheck?: string; verified?: string }[] };

      expect(out.checks).toEqual([
        {
          claim: 'the focused checkpoint test passes',
          recheck: 'npm run test:file -- checkpoint.test.ts',
          verified: '8/8 tests passed',
        },
      ]);
    });

    it('does NOT invent a verification: a not-yet-verified status maps to no `verified` at all (stays PREDICTED)', () => {
      const out = parse({ checks: [{ claim: 'deploy landed', status: 'predicted' }] }) as {
        checks: { claim: string; verified?: string }[];
      };
      expect(out.checks[0]).toEqual({ claim: 'deploy landed' });
      expect(out.checks[0]).not.toHaveProperty('verified');
    });

    it('preserves the reported predicted P-002/P-004 evidence as non-authoritative observed context', async () => {
      const b = body(
        await call({
          did: 'recorded current audit context',
          checks: [
            {
              id: 'p002-current-scorecard-audits',
              claim: 'P-002 adequacy audits are terminal',
              recheck: 'read all gradingAudit.state values',
              status: 'predicted',
              evidence: 'Pending with advancing reservations',
            },
            {
              id: 'p004-current-measurement',
              claim: 'P-004 has a current measurement',
              recheck: 'read the newest measurement artifact',
              status: 'predicted',
              evidence: 'Prior artifact is stale',
            },
          ],
        }),
      );

      expect(b).toMatchObject({ ok: true, checks: 2 });
      const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
      expect(written).toContain('- ? [#p002-current-scorecard-audits]');
      expect(written).toContain('evidence: Pending with advancing reservations');
      expect(written).toContain('- ? [#p004-current-measurement]');
      expect(written).toContain('evidence: Prior artifact is stale');
      expect(written).not.toContain('- ✓ [#p002-current-scorecard-audits]');
      expect(written).not.toContain('- ✓ [#p004-current-measurement]');
    });

    it('accepts the boolean `verified` the schema used to reject, without upgrading false to verified', () => {
      const t = parse({ checks: [{ claim: 'a', verified: true, evidence: 'observed at 03:00Z' }] }) as {
        checks: { verified?: string }[];
      };
      expect(t.checks[0]!.verified).toBe('observed at 03:00Z');
      const f = parse({ checks: [{ claim: 'a', verified: false }] }) as { checks: { verified?: string }[] };
      expect(f.checks[0]).not.toHaveProperty('verified');
    });

    it('keeps explicit ok:false from rendering canonical verified evidence as a green check', async () => {
      const b = body(
        await call({
          did: 'checkpointed the failed gate',
          checks: [{ claim: 'the gate exits 0', recheck: 'run the gate', ok: false, verified: 'the gate exited 1' }],
        }),
      );

      expect(b.ok).toBe(true);
      expect(b.repairs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'checks[0].verified',
            kind: 'downgraded',
            detail: expect.stringContaining('ok:false'),
          }),
        ]),
      );
      const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
      expect(withoutRowIds(written)).toContain('- ⚠ ');
      expect(written).toContain('the gate exited 1');
      expect(written).not.toContain('- ✓ ');
    });

    it('maps compact check claim strings to lossless `{ claim }` rows', () => {
      const out = parse({ checks: ['gate is green', 'main is at abc123'] }) as { checks: { claim: string }[] };
      expect(out.checks).toEqual([{ claim: 'gate is green' }, { claim: 'main is at abc123' }]);
    });

    it('accepts scalar and JSON-encoded check strings from stale wire manifests', () => {
      expect(parse({ checks: 'gate is green' })).toMatchObject({ checks: [{ claim: 'gate is green' }] });
      expect(parse({ checks: '["gate is green"]' })).toMatchObject({ checks: [{ claim: 'gate is green' }] });
    });

    it('writes compact check strings through the normal typed row path', async () => {
      const b = body(await call({ did: 'progress', checks: ['gate is green'] }));
      expect(b).toMatchObject({ ok: true, checks: 1 });
    });

    it('does NOT coerce that shape onto walls — a wall has no `verified`, so the only mapping would DROP data', () => {
      // Deliberate asymmetry with checks. Coercing here would have to discard the
      // caller's `evidence` (there is nowhere lossless to put it), which is precisely
      // the silent-loss failure EI-18723223344390510 was fixed to stop. Failing loudly
      // is the correct outcome, and walls see ~2 such calls per 6 days vs 97 for checks.
      expect(() =>
        parse({ walls: [{ claim: 'needs owner key', status: 'verified', evidence: 'asked 02:00Z' }] }),
      ).toThrow();
    });

    it('maps compact wall claim strings to lossless `{ claim }` rows', () => {
      const out = parse({ walls: ['needs owner key', 'awaiting owner approval'] }) as {
        walls: { claim: string }[];
      };
      expect(out.walls).toEqual([{ claim: 'needs owner key' }, { claim: 'awaiting owner approval' }]);
    });

    it('accepts a scalar or JSON-encoded string wall from a stale wire manifest', () => {
      expect(parse({ walls: 'needs owner key' })).toMatchObject({ walls: [{ claim: 'needs owner key' }] });
      expect(parse({ walls: '["needs owner key"]' })).toMatchObject({ walls: [{ claim: 'needs owner key' }] });
    });

    it('writes compact wall strings through the normal typed row path', async () => {
      const b = body(await call({ did: 'progress', walls: ['needs owner key'] }));
      expect(b).toMatchObject({ ok: true, walls: 1 });
    });

    it('walls still get the cap RELAXATION even though they get no shape coercion', async () => {
      const b = body(await call({ did: 'p', walls: [{ claim: 'W'.repeat(700) }] }));
      expect(b.ok).toBe(true);
      expect(b.repairs[0]).toMatchObject({ field: 'walls[0].claim', kind: 'truncated' });
    });

    it('still REJECTS a genuinely undeclared key — EI-10883 is preserved, not weakened', () => {
      expect(() => parse({ did: 'x', totallyMadeUpKey: 'y' })).toThrow();
      expect(() => parse({ did: 'x', confirmShrink: true })).toThrow();
      expect(() => parse({ checks: [{ claim: 'a', nonsenseField: 'b' }] })).toThrow();
    });
  });

  describe('soft caps are enforced by TRUNCATION, and every trim is reported', () => {
    it('accepts a bounded overlong row id but still rejects an absurdly long one at the input boundary', () => {
      expect(() =>
        parse({ did: 'progress', checks: [{ claim: 'c', id: 'x'.repeat(CARRY_ROW_ID_MAX) }] }),
      ).not.toThrow();
      expect(() =>
        parse({ did: 'progress', checks: [{ claim: 'c', id: 'x'.repeat(CARRY_ROW_ID_MAX + 1) }] }),
      ).not.toThrow();
      expect(() =>
        parse({
          did: 'progress',
          checks: [{ claim: 'c', id: 'x'.repeat(CARRY_ROW_ID_MAX * CARRY_CAP_HARD_MULTIPLE + 1) }],
        }),
      ).toThrow();
    });

    it('reports a long-id identity repair and stores the bounded merge identity', async () => {
      const longId = 'x'.repeat(CARRY_ROW_ID_MAX + 1);
      const b = body(await call({ did: 'progress', checks: [{ claim: 'c', id: longId }] }));
      expect(b.ok).toBe(true);
      expect(b.repairs).toHaveLength(1);
      expect(b.repairs[0]).toMatchObject({ field: 'checks[0].id', kind: 'truncated' });
      expect(b.repairs[0].detail).toContain(`${longId.length} chars`);
      expect(b.repairs[0].detail).toContain(`${CARRY_ROW_ID_MAX} chars`);
      const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
      expect(written).toContain(`[#${'x'.repeat(CARRY_ROW_ID_MAX)}]`);
    });

    it('accepts recovery rows past the stored cap and reports the supplied overflow', async () => {
      const checks = Array.from({ length: CARRY_NOTE_MAX_CHECKS + 1 }, (_, i) => ({ claim: `supplied ${i + 1}` }));
      expect(() =>
        parse({
          did: 'progress',
          checks: Array.from({ length: CARRY_NOTE_MAX_CHECKS * CARRY_CAP_HARD_MULTIPLE + 1 }, (_, i) => ({
            claim: `too many ${i + 1}`,
          })),
        }),
      ).toThrow();
      const b = body(await call({ did: 'progress', checks }));
      expect(b.ok).toBe(true);
      expect(b.checks).toBe(CARRY_NOTE_MAX_CHECKS);
      expect(b.checksOverflowed).toEqual([`supplied ${CARRY_NOTE_MAX_CHECKS + 1}`]);
      expect(b.overflowNote).toContain('NOT stored');
    });

    it('writes the note instead of rejecting it when a check row overruns, and reports the trim', async () => {
      const b = body(await call({ did: 'progress', checks: [{ claim: 'c', recheck: 'x'.repeat(360) }] }));
      expect(b.ok).toBe(true); // the whole note used to be discarded over this
      expect(b.repairs).toHaveLength(1);
      expect(b.repairs[0]).toMatchObject({ field: 'checks[0].recheck', kind: 'truncated' });
      expect(b.repairs[0].detail).toContain('360');
    });

    it('publishes each row soft cap alongside its hard input backstop', () => {
      type JsonNode = { [key: string]: unknown };
      const schema = (tool.args as unknown as { toJSONSchema: () => unknown }).toJSONSchema() as JsonNode;
      const properties = ((schema.properties as JsonNode).checks as JsonNode).items as JsonNode;
      const rowProperties = properties.properties as Record<string, JsonNode>;

      for (const [field, softCap] of Object.entries(CARRY_ROW_SOFT_CAPS)) {
        expect(rowProperties[field]).toMatchObject({
          maxLength: softCap * CARRY_CAP_HARD_MULTIPLE,
          'x-soft-maxLength': softCap,
        });
        expect(rowProperties[field].description).toContain(`Soft cap: ${softCap} chars`);
      }
    });

    it('publishes structured verification aliases in the nested checks schema', () => {
      type JsonNode = { [key: string]: unknown };
      const schema = (tool.args as unknown as { toJSONSchema: () => unknown }).toJSONSchema() as JsonNode;
      const properties = ((schema.properties as JsonNode).checks as JsonNode).items as JsonNode;
      const rowProperties = properties.properties as Record<string, JsonNode>;

      expect(rowProperties.kind).toMatchObject({ type: 'string' });
      expect(rowProperties.command).toMatchObject({ type: 'string' });
      expect(rowProperties.result).toMatchObject({ type: 'string' });
      expect(rowProperties.testResult).toMatchObject({ type: 'string' });
      expect(rowProperties.kind.description).toContain('Compatibility alias for `claim`');
      expect(rowProperties.command.description).toContain('Compatibility alias for `recheck`');
      expect(rowProperties.result.description).toContain('Compatibility alias for `verified`');
      expect(rowProperties.testResult.description).toContain('completion-style `testResult`');
    });

    it('truncates an overlong narrative field to the soft cap rather than rejecting the call', async () => {
      const b = body(await call({ did: 'D'.repeat(9000) }));
      expect(b.ok).toBe(true);
      expect(b.repairs[0]).toMatchObject({ field: 'did', kind: 'truncated' });
      const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
      // The cap's real job — bounding what re-injects into every future wake — still holds.
      expect(written.length).toBeLessThan(9000);
    });

    it('reports NOTHING when everything is within cap (no false positives on the normal path)', async () => {
      const b = body(await call({ did: 'short', checks: [{ claim: 'c', recheck: 'probe', verified: 'seen' }] }));
      expect(b.ok).toBe(true);
      expect(b.repairs).toBeUndefined();
    });

    it('still rejects a payload past the hard backstop — repair is for overruns, not for absurdity', () => {
      expect(() => parse({ did: 'D'.repeat(8000 * 4 + 1) })).toThrow();
    });
  });
});

/**
 * EI-19463731740128181 — the REPLY must announce rows a write dropped.
 *
 * carry-note.test.ts pins the merge helper's `droppedWalls`/`droppedChecks`; this block
 * pins the TOOL WIRING, which is the half that actually reaches an agent. The two are
 * separately breakable: the helper can compute a correct drop list that the handler
 * never surfaces, and that failure mode is invisible to a helper-level test — it is
 * exactly the shape the original bug had (a correct post-merge count, reported in a way
 * no caller could read a loss from).
 */
describe('loop:checkpoint — a dropped row is REPORTED, never silent (EI-19463731740128181)', () => {
  // Real via importOriginal (the module mock spreads it), so the prior is built by the
  // same renderer the store persists — not a hand-written fixture that can drift.
  const buildPrior = (
    checks: { claim: string; recheck?: string; verified?: string }[],
    walls: { claim: string; recheck?: string }[] = [],
  ) => mergeCarryRows({ priorNote: null, baseNote: 'prior body', checks, walls, hasNoteWrite: true }).note;

  it('reports individually named check retirements', async () => {
    getLoopCarryNote.mockResolvedValue(
      buildPrior([
        { claim: 'gate is green', recheck: 'state:read', verified: 'saw 30/30 @2026-08-03T10:00:00.000Z' },
        { claim: 'main is at abc123', recheck: 'git rev-parse main' },
        { claim: 'deploy landed', recheck: 'curl :3070/api/health' },
      ]),
    );
    // Post-P-013 / EI-21503907176334936 the drop only happens under an EXPLICIT,
    // CONFIRMED replace — which is exactly when it still has to be announced: an
    // agent that asked to retire one stale row must be told which others went with it.
    const b = body(
      await call({
        did: 'progress',
        checks: [{ claim: 'a brand new claim' }],
        rowsMode: 'replace',
        retireIds: ['gate is green', 'main is at abc123', 'deploy landed'],
      }),
    );

    expect(b.ok).toBe(true); // CONFIRMED retirement proceeds — and reports the loss
    expect(b.checks).toBe(1);
    expect(b.checksRetired).toEqual(['gate is green', 'main is at abc123', 'deploy landed']);
    expect(b.checksDropped).toBeUndefined();
  });

  it('reports a named wall retirement separately from checks', async () => {
    getLoopCarryNote.mockResolvedValue(
      buildPrior([], [{ claim: 'owner must ratify the cutover' }, { claim: 'awaiting capital arming' }]),
    );
    const b = body(
      await call({
        did: 'progress',
        walls: [{ claim: 'awaiting capital arming' }],
        rowsMode: 'replace',
        retireIds: ['owner must ratify the cutover'],
      }),
    );

    expect(b.walls).toBe(1);
    expect(b.wallsRetired).toEqual(['owner must ratify the cutover']);
    expect(b.checksDropped).toBeUndefined(); // independent axes — no cross-reporting
  });

  it('says NOTHING on the carry-forward path, so the common reply shape is unchanged', async () => {
    getLoopCarryNote.mockResolvedValue(
      buildPrior([{ claim: 'gate is green', recheck: 'state:read' }], [{ claim: 'owner must ratify' }]),
    );
    // No `checks`/`walls` args at all ⇒ every carried row is preserved by construction.
    const b = body(await call({ did: 'progress' }));

    expect(b.checks).toBe(1);
    expect(b.walls).toBe(1);
    expect(b.checksDropped).toBeUndefined();
    expect(b.checksDroppedNote).toBeUndefined();
    expect(b.wallsDropped).toBeUndefined();
  });
});

/**
 * EI-21503907176334936 — under rowsMode:'replace', retiring carried rows is now a
 * CONFIRMED operation, not an accepted-then-reported one. The transform refuses
 * BEFORE any store write unless `confirmRetire: true`, so a monitor loop re-sending
 * its whole note each wake from a stale view loses nothing. This pins the TOOL
 * wiring of that refusal: it must name the exact drop set and leave the prior
 * carry-note untouched (the store spy never fires).
 */
describe('loop:checkpoint — replace-mode retirement is CONFIRMED, never silent (EI-21503907176334936)', () => {
  const buildPrior = (
    checks: { claim: string; recheck?: string; verified?: string }[],
    walls: { claim: string; recheck?: string }[] = [],
  ) => mergeCarryRows({ priorNote: null, baseNote: 'prior body', checks, walls, hasNoteWrite: true }).note;

  const THREE = [
    { claim: 'gate is green', recheck: 'state:read', verified: 'saw 30/30 @2026-08-03T10:00:00.000Z' },
    { claim: 'main is at abc123', recheck: 'git rev-parse main' },
    { claim: 'deploy landed', recheck: 'curl :3070/api/health' },
  ];

  it('preserves omitted checks during a replace-style write without retireIds', async () => {
    getLoopCarryNote.mockResolvedValue(buildPrior(THREE));
    const b = body(await call({ did: 'progress', checks: [{ claim: 'a brand new claim' }], rowsMode: 'replace' }));

    expect(b).toMatchObject({ ok: true, checks: 4 });
    expect(b.checksDropped).toBeUndefined();
    const written = setLoopCarryNote.mock.calls[0]?.[1] as string;
    for (const row of THREE) expect(written).toContain(row.claim);
    expect(written).toContain('progress');
  });

  it('confirmRetire:true cannot authorize omission-based row retirement', async () => {
    getLoopCarryNote.mockResolvedValue(buildPrior(THREE));
    const b = body(
      await call({
        did: 'progress',
        checks: [{ claim: 'a brand new claim' }],
        rowsMode: 'replace',
        confirmRetire: true,
      }),
    );

    expect(b.ok).toBe(true);
    expect(b.checks).toBe(4);
    expect(b.checksDropped).toBeUndefined();
    const written = setLoopCarryNote.mock.calls[0]?.[1] as string;
    for (const row of THREE) expect(written).toContain(row.claim);
  });

  it('an empty replace-style list keeps the standing wall', async () => {
    getLoopCarryNote.mockResolvedValue(
      buildPrior([], [{ claim: 'zombie PIDs await owner OK', recheck: 'ps -p 95902' }]),
    );
    const b = body(await call({ note: '', walls: [], rowsMode: 'replace' }));

    expect(b).toMatchObject({ ok: true, walls: 1 });
    expect(b.wallsDropped).toBeUndefined();
    expect(setLoopCarryNote.mock.calls[0]?.[1]).toContain('zombie PIDs await owner OK');
  });

  it('a replace whose lists already cover the carried set needs NO confirmation', async () => {
    getLoopCarryNote.mockResolvedValue(buildPrior([{ claim: 'gate is green', recheck: 'state:read' }]));
    const b = body(await call({ did: 'progress', checks: [{ claim: 'gate is green' }], rowsMode: 'replace' }));

    expect(b.ok).toBe(true);
    expect(b.checks).toBe(1);
    expect(b.checksDropped).toBeUndefined();
  });
});

/**
 * P-013 (fleet-lead-instrumentation-audit-2026-08-09) — the drop must be AVOIDABLE,
 * not merely visible. The block above pins the report; this one pins the two escapes
 * from needing it, at the TOOL boundary where an agent meets them: `rowsMode:'merge'`
 * and a stable row `id`.
 *
 * Same separately-breakable split as above — the helper can merge perfectly while the
 * handler never threads `rowsMode` through (it is passed at TWO call sites, the locked
 * transform and its fallback), and no helper-level test can see that.
 */
describe("loop:checkpoint — rowsMode:'merge' and row ids make the drop avoidable (P-013)", () => {
  it('P-007 persists distinct check/wall IDs and preserves them across a body clear', async () => {
    setLoopCarryNote.mockImplementation(async (_ref: unknown, note: unknown) => note as string);
    expect(body(await call({ did: 'progress',
      checks: [{ claim: 'shared wording', recheck: 'probe', verified: 'observed' }],
      walls: [{ claim: 'shared wording', recheck: 'ask for decision' }],
    })).ok).toBe(true);
    const first = lastStoredNote;
    const check = splitCarryNoteChecks(first).checks[0]!;
    const wall = splitCarryNoteWalls(first).walls[0]!;
    expect(check.id).toEqual(expect.any(String));
    expect(wall.id).toEqual(expect.any(String));
    expect(check.id).not.toBe(wall.id);
    getLoopCarryNote.mockResolvedValue(first);
    expect(body(await call({ note: null })).ok).toBe(true);
    expect(splitCarryNoteChecks(lastStoredNote).checks).toEqual([check]);
    expect(splitCarryNoteWalls(lastStoredNote).walls).toEqual([wall]);
    expect(lastStoredNote).not.toContain('progress');
  });

  it('P-007 closes a keyed wall only by its ID and preserves the omitted check', async () => {
    setLoopCarryNote.mockImplementation(async (_ref: unknown, note: unknown) => note as string);
    await call({ did: 'progress', checks: [{ claim: 'carried check', verified: 'observed' }],
      walls: [{ claim: 'carried wall' }] });
    const first = lastStoredNote;
    const check = splitCarryNoteChecks(first).checks[0]!;
    const wall = splitCarryNoteWalls(first).walls[0]!;
    getLoopCarryNote.mockResolvedValue(first);
    const unmatched = body(await call({ checks: [], retireIds: ['carried wall'] }));
    expect(unmatched.unmatchedRowRefs).toContain('carried wall');
    expect(splitCarryNoteWalls(lastStoredNote).walls).toEqual([wall]);
    getLoopCarryNote.mockResolvedValue(lastStoredNote);
    expect(body(await call({ checks: [], retireIds: [wall.id!] })).ok).toBe(true);
    expect(splitCarryNoteWalls(lastStoredNote).walls).toEqual([]);
    expect(splitCarryNoteChecks(lastStoredNote).checks).toEqual([check]);
  });

  const buildPrior = (
    checks: { id?: string; claim: string; recheck?: string; verified?: string }[],
    walls: { id?: string; claim: string; recheck?: string }[] = [],
  ) => mergeCarryRows({ priorNote: null, baseNote: 'prior body', checks, walls, hasNoteWrite: true }).note;

  const THREE = [
    { claim: 'gate is green', recheck: 'state:read', verified: 'saw 30/30 @2026-08-03T10:00:00.000Z' },
    { claim: 'main is at abc123', recheck: 'git rev-parse main' },
    { claim: 'deploy landed', recheck: 'curl :3070/api/health' },
  ];

  it('adds ONE check without dropping the carried three, and says which mode it ran', async () => {
    getLoopCarryNote.mockResolvedValue(buildPrior(THREE));
    const b = body(await call({ did: 'progress', checks: [{ claim: 'a brand new claim' }], rowsMode: 'merge' }));

    expect(b.ok).toBe(true);
    expect(b.checks).toBe(4);
    expect(b.checksDropped).toBeUndefined();
    expect(b.rowsMode).toBe('merge');
  });

  // The default is now MERGE (EI-20281899810081153: "rowsMode:'merge' as the default for
  // additive checks on both checkpoint tools. Explicit rowsMode:'replace' remains the
  // retirement path"). This pair replaces the old CONTROL, which pinned the opposite —
  // it asserted the default "is unchanged" and so became the thing that had to change.
  // Both halves are kept deliberately: one proves the preserving default, the other
  // proves retirement is still REACHABLE, which is the property that flip could break.
  it('DEFAULT — the identical call WITHOUT rowsMode now PRESERVES the carried three', async () => {
    getLoopCarryNote.mockResolvedValue(buildPrior(THREE));
    const b = body(await call({ did: 'progress', checks: [{ claim: 'a brand new claim' }] }));

    expect(b.checks).toBe(4);
    expect(b.checksDropped).toBeUndefined();
  });

  it('passes narrative metadata so a next-only merge preserves prior sections and checks', async () => {
    const prior = mergeCarryRows({
      priorNote: null,
      baseNote: [
        '## Did',
        'finished the first pass',
        '',
        '## Left',
        'run the focused suite',
        '',
        '## Key insight',
        'the locked prior is authoritative',
        '',
        '## Next action',
        're-read the current note',
      ].join('\n'),
      checks: [{ claim: 'gate is green', recheck: 'state:read', verified: 'saw green' }],
      hasNoteWrite: true,
    }).note;
    getLoopCarryNote.mockResolvedValue(prior);

    const b = body(await call({ next: 'run the focused suite now' }));
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];

    expect(written).toContain('## Did\nfinished the first pass');
    expect(written).toContain('## Left\nrun the focused suite');
    expect(written).toContain('## Key insight\nthe locked prior is authoritative');
    expect(written).toContain('## Next action\nrun the focused suite now');
    expect(written).toContain('gate is green');
    expect(b).toMatchObject({ ok: true, checks: 1 });
    expect(b.checksDropped).toBeUndefined();
  });

  it('CONTROL — retirement is reachable when each removed row is named', async () => {
    // Guards the OTHER direction: a change that made merge unconditional would make the
    // test above pass while silently removing the only way to retire a stale row.
    getLoopCarryNote.mockResolvedValue(buildPrior(THREE));
    const b = body(
      await call({
        did: 'progress',
        checks: [{ claim: 'a brand new claim' }],
        rowsMode: 'replace',
        retireIds: THREE.map(row => row.claim),
      }),
    );

    expect(b.checks).toBe(1);
    expect(b.checksRetired).toHaveLength(3);
    expect(b.checksDropped).toBeUndefined();
  });

  it('merges WALLS under the same flag', async () => {
    getLoopCarryNote.mockResolvedValue(buildPrior([], [{ claim: 'owner must ratify the cutover' }]));
    const b = body(await call({ did: 'progress', walls: [{ claim: 'awaiting capital arming' }], rowsMode: 'merge' }));

    expect(b.walls).toBe(2);
    expect(b.wallsDropped).toBeUndefined();
  });

  it('re-words a claim in place under a stable id, keeping its evidence and reporting no loss', async () => {
    getLoopCarryNote.mockResolvedValue(
      buildPrior([{ id: 'gate', claim: 'gate is green', recheck: 'state:read', verified: 'saw 30/30' }]),
    );
    const b = body(
      await call({ did: 'progress', checks: [{ id: 'gate', claim: 'gate is green AT TIP, not at the candidate' }] }),
    );

    expect(b.checks).toBe(1);
    expect(b.checksDropped).toBeUndefined();
    // The stored note is the artifact a cold wake reads — assert against IT, not a count.
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    expect(written).toContain('gate is green AT TIP, not at the candidate');
    expect(written).toContain('saw 30/30'); // evidence inherited across the reword
    expect(written).not.toContain('- ✓ [#gate] gate is green —');
  });

  it('updates a predicted stable-id check to verified while retaining its first-seen age', async () => {
    const prior = buildPrior([{ id: 'loop-wake-confirmed', claim: 'The loop wake produced a loop-origin turn' }]);
    getLoopCarryNote.mockResolvedValue(prior);
    const priorCheck = splitCarryNoteChecks(prior).checks[0]!;
    const evidence = 'Observed a loop-origin turn after the scheduled fire';

    const b = body(
      await call({
        checks: [
          {
            id: 'loop-wake-confirmed',
            claim: 'The loop wake produced a loop-origin turn',
            recheck: 'read the current session timeline',
            verified: evidence,
          },
        ],
        rowsMode: 'merge',
      }),
    );

    expect(b).toMatchObject({ ok: true, verified: true, checks: 1, rowsMode: 'merge' });
    expect(b.checksDropped).toBeUndefined();
    const [, stored] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    const storedChecks = splitCarryNoteChecks(stored).checks;
    expect(storedChecks).toHaveLength(1);
    expect(storedChecks[0]?.verified).toContain(evidence);
    expect(storedChecks[0]?.sinceMs).toBe(priorCheck.sinceMs);
    expect(stored).toContain('- ✓ [#loop-wake-confirmed] The loop wake produced a loop-origin turn');
  });

  it('promotes legacy unkeyed rows when a caller adds ids under merge, without duplicating them', async () => {
    getLoopCarryNote.mockResolvedValue(
      buildPrior([
        { claim: 'gate is green', recheck: 'state:read', verified: 'saw 30/30' },
        { claim: 'main is at abc123', recheck: 'git rev-parse HEAD', verified: 'observed abc123' },
        { claim: 'deploy landed', recheck: 'health probe', verified: 'health ok' },
        { claim: 'tests passed', recheck: 'focused suite', verified: '4/4 passed' },
      ]),
    );
    const b = body(
      await call({
        did: 'progress',
        checks: [
          { id: 'gate', claim: 'gate is green' },
          { id: 'tip', claim: 'main is at abc123' },
          { id: 'deploy', claim: 'deploy landed' },
          { id: 'tests', claim: 'tests passed' },
        ],
        rowsMode: 'merge',
      }),
    );

    expect(b.checks).toBe(4);
    expect(b.checksDropped).toBeUndefined();
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    expect(written.match(/^[-] [✓?⚠]/gm)).toHaveLength(4);
    expect(written).toContain('[#gate] gate is green');
    expect(written).toContain('[#tip] main is at abc123');
    expect(written).toContain('saw 30/30');
    expect(written).not.toContain('- ✓ gate is green —');
  });

  it("explains that merge's [] is a no-op, so a caller never reads it as a failed clear", async () => {
    getLoopCarryNote.mockResolvedValue(buildPrior(THREE));
    const b = body(await call({ did: 'progress', checks: [], rowsMode: 'merge' }));

    expect(b.checks).toBe(3); // untouched
    expect(b.rowsModeNote).toContain('NO-OP');
    expect(b.rowsModeNote).toContain("rowsMode:'replace'");
  });

  it('refuses a merge that would evict a carried check at the cap', async () => {
    const carriedChecks = Array.from({ length: CARRY_NOTE_MAX_CHECKS }, (_, i) => ({
      id: `check-${i + 1}`,
      claim: `carried ${i + 1}`,
    }));
    getLoopCarryNote.mockResolvedValue(buildPrior(carriedChecks));
    const b = body(await call({ did: 'progress', checks: [{ claim: 'one row past the cap' }], rowsMode: 'merge' }));

    expect(b.ok).toBe(false);
    expect(b.error).toBe('checkpoint_merge_would_evict_rows');
    expect(b.checksDropped).toEqual([`carried ${CARRY_NOTE_MAX_CHECKS}`]);
    expect(b.checksDroppedRows).toEqual([
      { id: `check-${CARRY_NOTE_MAX_CHECKS}`, claim: `carried ${CARRY_NOTE_MAX_CHECKS}` },
    ]);
    expect(b.message).toContain('checksDroppedRows');
    const storedChecks = splitCarryNoteChecks(setLoopCarryNote.mock.calls[0]?.[1] as string).checks;
    expect(storedChecks.map(({ id, claim }) => ({ id, claim }))).toEqual(carriedChecks);
    // EI-22377179869127416: the ROW write is still refused, but the narrative is no
    // longer taken hostage with it — the message must say so, or a caller reading
    // "NOTHING was written" would re-send a note that already committed.
    expect(b.narrativePersisted).toBe(true);
    expect(b.message).toContain('NARRATIVE WAS SAVED');
    expect(b.message).not.toContain('NOTHING was written');
  });

  it('refuses a merge that would evict a carried wall at the cap', async () => {
    const carriedWalls = Array.from({ length: CARRY_NOTE_MAX_WALLS }, (_, i) => ({
      id: `wall-${i + 1}`,
      claim: `carried wall ${i + 1}`,
    }));
    getLoopCarryNote.mockResolvedValue(buildPrior([], carriedWalls));
    const b = body(await call({ did: 'progress', walls: [{ claim: 'new wall' }], rowsMode: 'merge' }));

    expect(b.ok).toBe(false);
    expect(b.error).toBe('checkpoint_merge_would_evict_rows');
    expect(b.wallsDropped).toEqual([`carried wall ${CARRY_NOTE_MAX_WALLS}`]);
    expect(b.wallsDroppedRows).toEqual([
      { id: `wall-${CARRY_NOTE_MAX_WALLS}`, claim: `carried wall ${CARRY_NOTE_MAX_WALLS}` },
    ]);
    const storedWalls = splitCarryNoteWalls(setLoopCarryNote.mock.calls[0]?.[1] as string).walls;
    expect(storedWalls.map(({ id, claim }) => ({ id, claim }))).toEqual(carriedWalls);
    expect(b.message).toContain('confirmRetire:true');
    // P-025: the refusal teaches the one-row remedies, not a full resend.
    expect(b.message).toContain('replaces');
    expect(b.message).toContain('retireIds');
  });

  // P-025 (review-system-rework-reduction-2026-09-23): 1,675 merge-eviction refusals in 7
  // days, each recovered by re-sending all 12 rows to change one. Through the real schema.
  const checkLines = (note: string) => note.split('\n').filter((l) => /^- [✓?⚠]/.test(l));

  it('P-025: a `replaces` edit at the cap is a ONE-row write — accepted, other rows byte-identical', async () => {
    const prior = buildPrior(
      Array.from({ length: CARRY_NOTE_MAX_CHECKS }, (_, i) => ({ claim: `carried ${i + 1}`, recheck: `probe ${i + 1}` })),
    );
    getLoopCarryNote.mockResolvedValue(prior);
    const b = body(
      await call({ did: 'progress', checks: [{ claim: 'carried 5, reworded', replaces: 'carried 5' }], rowsMode: 'merge' }),
    );

    expect(b.ok).toBe(true);
    expect(b.checks).toBe(CARRY_NOTE_MAX_CHECKS);
    expect(b.checksDropped).toBeUndefined();
    expect(b.unmatchedRowRefs).toBeUndefined();
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    const before = checkLines(prior);
    const after = checkLines(written);
    expect(after).toHaveLength(before.length);
    before.forEach((line, i) => {
      if (i === 4) expect(after[i]).toMatch(/carried 5, reworded — re-check: probe 5/);
      else expect(withoutRowIds(after[i])).toBe(withoutRowIds(line));
    });
  });

  it('P-025: retireIds retires one named row so a genuinely new row fits at the cap in one call', async () => {
    getLoopCarryNote.mockResolvedValue(
      buildPrior(Array.from({ length: CARRY_NOTE_MAX_CHECKS }, (_, i) => ({ claim: `carried ${i + 1}` }))),
    );
    const b = body(
      await call({ did: 'progress', checks: [{ claim: 'a genuinely new row' }], retireIds: ['carried 3'], rowsMode: 'merge' }),
    );

    expect(b.ok).toBe(true);
    expect(b.checks).toBe(CARRY_NOTE_MAX_CHECKS);
    expect(b.checksDropped).toBeUndefined();
    expect(b.checksRetired).toEqual(['carried 3']);
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    expect(written).toContain('a genuinely new row');
    expect(written).not.toMatch(/^- \? carried 3$/m);
  });

  it('P-025: an unmatched `replaces` is reported and treated as the net addition it is (still refused at the cap)', async () => {
    getLoopCarryNote.mockResolvedValue(
      buildPrior(Array.from({ length: CARRY_NOTE_MAX_CHECKS }, (_, i) => ({ claim: `carried ${i + 1}` }))),
    );
    const b = body(
      await call({ did: 'progress', checks: [{ claim: 'x', replaces: 'no such carried row' }], rowsMode: 'merge' }),
    );

    expect(b.ok).toBe(false);
    expect(b.error).toBe('checkpoint_merge_would_evict_rows');
    expect(b.checksDropped).toEqual([`carried ${CARRY_NOTE_MAX_CHECKS}`]);
  });

  // EI-21849813048365808: a routine merge refresh near the cap (e.g. a monitor loop
  // re-stating its checks every wake) hit `checkpoint_merge_would_evict_rows` on every
  // write once the carried set filled up, and the only advertised fix was a separate
  // rowsMode:'replace' resend of the FULL current set first. confirmRetire:true gives
  // the SAME one-call escape merge already offers replace: let the cap's own
  // PREDICTED-before-VERIFIED eviction proceed instead of refusing.
  it('confirmRetire:true cannot authorize cap eviction of an unnamed check', async () => {
    getLoopCarryNote.mockResolvedValue(
      buildPrior(Array.from({ length: CARRY_NOTE_MAX_CHECKS }, (_, i) => ({ claim: `carried ${i + 1}` }))),
    );
    const b = body(
      await call({
        did: 'progress',
        checks: [{ claim: 'one row past the cap' }],
        rowsMode: 'merge',
        confirmRetire: true,
      }),
    );

    expect(b).toMatchObject({ ok: false, error: 'checkpoint_merge_would_evict_rows' });
    expect(b.checksDropped).toEqual([`carried ${CARRY_NOTE_MAX_CHECKS}`]);
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    expect(written).not.toContain('one row past the cap');
    expect(splitCarryNoteChecks(written).checks.map(row => row.claim)).toEqual(
      Array.from({ length: CARRY_NOTE_MAX_CHECKS }, (_, i) => `carried ${i + 1}`),
    );
  });

  it('a confirmRetire retry still refuses unnamed eviction and preserves the actual rows', async () => {
    const prior = buildPrior(
      Array.from({ length: CARRY_NOTE_MAX_CHECKS }, (_, i) => ({ claim: `carried ${i + 1}` })),
    );
    getLoopCarryNote.mockResolvedValue(prior);

    const refused = body(
      await call({
        did: 'preview the two-row retry',
        checks: [{ claim: 'preview row one' }, { claim: 'preview row two' }],
        rowsMode: 'merge',
      }),
    );

    expect(refused).toMatchObject({
      ok: false,
      error: 'checkpoint_merge_would_evict_rows',
      checksDropped: [`carried ${CARRY_NOTE_MAX_CHECKS - 1}`, `carried ${CARRY_NOTE_MAX_CHECKS}`],
    });
    // The refusal persists the fresh narrative but leaves the carried rows intact.
    const refusalWrite = setLoopCarryNote.mock.calls[0]?.[1] as string;
    expect(refusalWrite).toContain('preview the two-row retry');
    expect(splitCarryNoteChecks(refusalWrite).checks).toHaveLength(CARRY_NOTE_MAX_CHECKS);

    setLoopCarryNote.mockClear();
    getLoopCarryNote.mockResolvedValue(refusalWrite);
    const confirmed = body(
      await call({
        did: 'confirm the one-row retry',
        checks: [{ claim: 'confirmed row' }],
        rowsMode: 'merge',
        confirmRetire: true,
      }),
    );

    expect(confirmed).toMatchObject({
      ok: false,
      checksDropped: [`carried ${CARRY_NOTE_MAX_CHECKS}`],
    });
    const retryWrite = setLoopCarryNote.mock.calls[0]?.[1] as string;
    expect(splitCarryNoteChecks(retryWrite).checks).toEqual(splitCarryNoteChecks(refusalWrite).checks);
  });

  it('confirmRetire:true cannot authorize cap eviction of an unnamed wall', async () => {
    getLoopCarryNote.mockResolvedValue(
      buildPrior(
        [],
        Array.from({ length: CARRY_NOTE_MAX_WALLS }, (_, i) => ({ claim: `carried wall ${i + 1}` })),
      ),
    );
    const b = body(
      await call({ did: 'progress', walls: [{ claim: 'new wall' }], rowsMode: 'merge', confirmRetire: true }),
    );

    expect(b).toMatchObject({ ok: false, error: 'checkpoint_merge_would_evict_rows' });
    expect(b.wallsDropped).toEqual([`carried wall ${CARRY_NOTE_MAX_WALLS}`]);
    const written = setLoopCarryNote.mock.calls[0]?.[1] as string;
    expect(written).toContain(`carried wall ${CARRY_NOTE_MAX_WALLS}`);
    expect(written).not.toContain('new wall');
  });

  it("still refuses an ordinary rowsMode:'merge' overflow when confirmRetire is false", async () => {
    getLoopCarryNote.mockResolvedValue(
      buildPrior(Array.from({ length: CARRY_NOTE_MAX_CHECKS }, (_, i) => ({ claim: `carried ${i + 1}` }))),
    );
    const b = body(
      await call({
        did: 'progress',
        checks: [{ claim: 'one row past the cap' }],
        rowsMode: 'merge',
        confirmRetire: false,
      }),
    );

    expect(b.ok).toBe(false);
    expect(b.error).toBe('checkpoint_merge_would_evict_rows');
    // EI-22377179869127416: the ROW write is still refused — the supplied row must NOT
    // land and every carried row must survive byte-identical. What changed is that the
    // narrative now commits alongside them instead of being rolled back with the rows.
    const written = setLoopCarryNote.mock.calls[0]?.[1] as string;
    expect(written).toContain('progress');
    const writtenChecks = splitCarryNoteChecks(written).checks.map((c) => c.claim);
    expect(writtenChecks).toEqual(Array.from({ length: CARRY_NOTE_MAX_CHECKS }, (_, i) => `carried ${i + 1}`));
    expect(writtenChecks).not.toContain('one row past the cap');
  });

  // EI-22377179869127416 — the harm the row-cap refusal actually caused. At a full cap an
  // ordinary additive checkpoint was refused ENTIRELY, so the stored note kept the PREVIOUS
  // turn's narrative and a cold wake resumed from work that was already finished. The row
  // cap and the narrative are separate commitments; only the rows were ever in conflict.
  it('replaces a stale narrative even when the row write is refused, so a cold wake resumes from this turn', async () => {
    getLoopCarryNote.mockResolvedValue(
      buildPrior(Array.from({ length: CARRY_NOTE_MAX_CHECKS }, (_, i) => ({ claim: `carried ${i + 1}` }))),
    );

    const b = body(
      await call({
        did: 'the turn that must not be lost',
        checks: [{ claim: 'one row past the cap' }],
        rowsMode: 'merge',
      }),
    );

    expect(b.ok).toBe(false);
    expect(b.narrativePersisted).toBe(true);

    const written = setLoopCarryNote.mock.calls[0]?.[1] as string;
    // The successor reads THIS turn...
    expect(written).toContain('the turn that must not be lost');
    // ...and not the stale body it would have been left with before the fix.
    expect(written).not.toContain('prior body');
  });

  it('preserves a legacy over-cap set and saves the narrative when a new row cannot fit', async () => {
    const verifiedRows = Array.from({ length: 8 }, (_, i) => ({
      claim: `VERIFIED-${String(i + 1).padStart(2, '0')} holds`,
      recheck: `probe verified ${i + 1}`,
      verified: `measured on current HEAD ${i + 1}`,
    }));
    const predictedRows = Array.from({ length: 12 }, (_, i) => ({
      claim: `PREDICTED-${String(i + 1).padStart(2, '0')} holds`,
      recheck: `probe predicted ${i + 1}`,
    }));
    const prior = withCarryNoteChecks('legacy checkpoint body', [...verifiedRows, ...predictedRows]);
    expect(splitCarryNoteChecks(prior).checks).toHaveLength(CARRY_NOTE_MAX_CHECKS + 8);
    getLoopCarryNote.mockResolvedValue(prior);

    const b = body(
      await call({
        did: 'the finding I just made',
        checks: [{ claim: 'BRAND-NEW holds', recheck: 'probe new', verified: 'measured just now' }],
        rowsMode: 'merge',
      }),
    );
    const [, written] = setLoopCarryNote.mock.calls[0] as [unknown, string];
    const storedChecks = splitCarryNoteChecks(written).checks;
    const storedClaims = storedChecks.map((row) => row.claim);

    expect(b).toMatchObject({ ok: false, error: 'checkpoint_merge_would_evict_rows', narrativePersisted: true });
    expect(storedChecks).toEqual(splitCarryNoteChecks(prior).checks);
    expect(storedClaims).not.toContain('BRAND-NEW holds');
    expect(written).toContain('the finding I just made');
    for (const row of verifiedRows) expect(storedClaims).toContain(row.claim);
    expect(storedClaims.filter((claim) => claim.startsWith('PREDICTED-'))).toHaveLength(12);
    expect(b.checksDropped).toHaveLength(9);
    expect(b.checksDropped.every((claim: string) => claim.startsWith('PREDICTED-'))).toBe(true);
  });

  it('repeated legacy over-cap rewrites preserve every carried row', async () => {
    const prior = withCarryNoteChecks(
      'legacy checkpoint body',
      Array.from({ length: CARRY_NOTE_MAX_CHECKS + 8 }, (_, i) => ({
        claim: `LEGACY-${String(i + 1).padStart(2, '0')} holds`,
      })),
    );
    getLoopCarryNote.mockResolvedValue(prior);

    const first = body(
      await call({
        did: 'first touch',
        checks: [{ claim: 'FIRST holds', verified: 'measured' }],
        rowsMode: 'merge',
      }),
    );
    expect(first.ok).toBe(false);
    expect(first.checksDropped.length).toBeGreaterThan(0);
    const normalized = setLoopCarryNote.mock.calls[0]?.[1] as string;
    expect(splitCarryNoteChecks(normalized).checks).toHaveLength(CARRY_NOTE_MAX_CHECKS + 8);

    setLoopCarryNote.mockClear();
    getLoopCarryNote.mockResolvedValue(normalized);
    const second = body(
      await call({
        did: 'second touch',
        checks: [{ claim: 'SECOND holds', verified: 'measured' }],
        rowsMode: 'merge',
      }),
    );

    expect(second).toMatchObject({ ok: false, error: 'checkpoint_merge_would_evict_rows' });
    // EI-22377179869127416: the self-healed note is at the cap, so the ROW write is
    // refused exactly as before — the escape must not become reusable. The narrative
    // still commits, and the normalized carried set is preserved untouched.
    const secondWrite = setLoopCarryNote.mock.calls[0]?.[1] as string;
    expect(secondWrite).toContain('second touch');
    const secondChecks = splitCarryNoteChecks(secondWrite).checks.map((c) => c.claim);
    expect(secondChecks).toHaveLength(CARRY_NOTE_MAX_CHECKS + 8);
    expect(secondChecks).not.toContain('SECOND holds');
    expect(secondChecks).not.toContain('FIRST holds');
    expect(secondChecks).toEqual(splitCarryNoteChecks(prior).checks.map(row => row.claim));
  });

  it('says nothing about overflow on an ordinary write', async () => {
    getLoopCarryNote.mockResolvedValue(buildPrior(THREE));
    const b = body(await call({ did: 'progress', checks: [{ claim: 'a fourth' }], rowsMode: 'merge' }));

    expect(b.checksOverflowed).toBeUndefined();
    expect(b.wallsOverflowed).toBeUndefined();
    expect(b.overflowNote).toBeUndefined();
  });
});
