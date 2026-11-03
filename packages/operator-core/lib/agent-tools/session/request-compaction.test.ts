/**
 * request-compaction.test.ts — the P-018/P-022 carry-respawn actuation.
 *
 * Native /compact is RETIRED (deterministic-context-carry P-022, WI-4998): the
 * tool now assembles the deterministic RespawnLaunchSpec and sends the psu-pty
 * host a mode:'carry-respawn' envelope (successor first prompt + carry-doc
 * system-prompt addendum). Verifies: the envelope shape; the P-010 first-prompt
 * rule (an OPEN owner message rides verbatim as the successor's first prompt,
 * else the tagged continue+re-orient note); the capability gate (a host without
 * 'carry-respawn' errors loudly — NO /compact fallback exists anymore); the
 * carry_build_failed refusal (session left intact); and the pre-existing
 * EI-7032 truncation + P-016 flush-gate behavior, unchanged across the swap.
 * injectIntoHost / findLiveHost / buildOwnerRespawnLaunchSpec are mocked so the
 * assertions are purely about WHICH envelope the tool emits; the real
 * hostSupports predicate runs so the caps gating is exercised honestly.
 *
 * Run: cd packages/operator-core && npx vitest run lib/agent-tools/session/request-compaction.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
// This suite stubs PG for the compaction boundaries. Keep background fallback
// telemetry at its own seam so its batched writer cannot use that partial stub.
vi.mock('../../degradation/fallback-observations', () => ({ observeFallback: vi.fn(() => true) }));
import { z } from 'zod';
import { addressContinuationToOwner, truncateHint } from './request-compaction';
import { readLedgerRows } from '../../turn-provenance/turn-provenance';
/**
 * WI-2140968: every successor first prompt is now prefixed with the ownerId it
 * was written FOR. Derive the prefix from the implementation rather than
 * restating it — a copied literal would drift the moment the wording changes,
 * and these assertions are about the note BODY, not the safety preamble.
 */
const ADDRESS_PREFIX = addressContinuationToOwner('', 'su-caller');
import { __resetRefusalMarkers } from '../../enforcement-gate-io';
import { __resetRespawnExpectedMarkers, consumeRespawnExpected } from '../../carry-respawn-marker';
const flushMarks = vi.hoisted(() => new Map<string, number>());
vi.mock('../../flush-refusal-marker', () => ({
  REFUSAL_MARKER_TTL_MS: 10 * 60_000,
  wasRecentlyRefused: async (boundary: string, ownerId: string, nowMs = Date.now()) =>
    (flushMarks.get(`${boundary}:${ownerId}`) ?? -1) >= nowMs,
  markRefused: async (boundary: string, ownerId: string, nowMs = Date.now()) => {
    flushMarks.set(`${boundary}:${ownerId}`, nowMs + 10 * 60_000);
  },
  clearRefused: async (boundary: string, ownerId: string) => { flushMarks.delete(`${boundary}:${ownerId}`); },
  __resetRefusalMarkers: async () => { flushMarks.clear(); },
}));
// P-009 split `pending` into still-racing vs ORPHANED on an age threshold, so the
// ages below are load-bearing. Derive them from the real budget rather than
// hardcoding minutes: a fixture that names its own magic number silently changes
// MEANING when the cap moves, which is exactly how this suite went red (the
// original 19m fixture was written when any pending age meant "still pending").
import {
  PENDING_RESPAWN_DEFAULT_CAP_MS,
  PENDING_RESPAWN_ORPHAN_GRACE_MS,
} from '../../carry-respawn-outcome';

// The marker is PG-backed (migration 716 — the operator is clustered, so an
// in-memory Map was invisible to the sibling worker handling the SessionEnd).
// Stand the table up in memory here so this stays a pure tool unit test, keeping
// the real single-use + TTL + per-owner semantics the assertions below rely on.
// The SQL itself is proven in carry-respawn-marker.integration.test.ts.
const respawnMarks = vi.hoisted(() => new Map<string, number>());
vi.mock('../../carry-respawn-marker', () => ({
  RESPAWN_EXPECTED_TTL_MS: 60_000,
  markRespawnExpected: async (ownerId: string, ttlMs = 60_000) => {
    if (ownerId?.trim()) respawnMarks.set(ownerId, Date.now() + ttlMs);
  },
  consumeRespawnExpected: async (ownerId: string) => {
    if (!ownerId?.trim()) return false;
    const expiresAt = respawnMarks.get(ownerId);
    if (expiresAt === undefined) return false;
    respawnMarks.delete(ownerId);
    return expiresAt >= Date.now();
  },
  __resetRespawnExpectedMarkers: async () => {
    respawnMarks.clear();
  },
}));

// WI-36074: the memory epoch bump is a PG write on the surfaced-ledger. Mocked so
// this stays a pure tool unit test — it asserts THAT the boundary fires and with
// WHICH key, not the SQL (that is proven in session-epoch-ledger.test.ts).
const bumpSessionEpoch = vi.hoisted(() => vi.fn(async () => 1 as number | null));
vi.mock('../../memory/session-epoch-ledger', () => ({
  bumpSessionEpoch: (...a: unknown[]) => bumpSessionEpoch(...(a as [])),
}));
// Only getOrgPg is stubbed (spread keeps the rest of db-org real) — the tool now
// resolves a sql tag to hand the bump, and this test has no live PG.
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await vi.importActual<Record<string, unknown>>('@papercusp/db-org');
  return { ...(await orig<typeof import('@papercusp/db-org')>()), ...actual, getOrgPg: () => ({ sql: {} }) };
});

const readFrozenRepairMarker = vi.hoisted(() => vi.fn());
vi.mock('../../release/frozen-repair-edit-marker', async (orig) => ({
  ...(await orig<typeof import('../../release/frozen-repair-edit-marker')>()),
  readFrozenRepairMarker,
}));

const findLiveHost = vi.fn();
const injectIntoHost = vi.fn();
const resolveSelfSession = vi.hoisted(() => vi.fn());
vi.mock('../../search/self-session', () => ({ resolveSelfSession }));
const readLoopFireIdentityForCurrentTurn = vi.hoisted(() => vi.fn());
vi.mock('../../harness/routines/loop-turn-start-stamp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../harness/routines/loop-turn-start-stamp')>();
  return {
    ...actual,
    readLoopFireIdentityForCurrentTurn: (...args: unknown[]) => readLoopFireIdentityForCurrentTurn(...args),
  };
});
vi.mock('../../events/await/psu-pty-discovery', () => {
  // Keep the REAL caps predicate so the gating logic is exercised honestly.
  const hostSupports = (host: { caps?: string[] } | null | undefined, cap: string) =>
    Array.isArray(host?.caps) && host!.caps!.includes(cap);
  const liveHost = (...a: unknown[]) => findLiveHost(...a) as { caps?: string[] } | null | undefined;
  return {
    findLiveHost: (...a: unknown[]) => findLiveHost(...a),
    findLiveHostAsync: async (...a: unknown[]) => liveHost(...a),
    injectIntoHost: (...a: unknown[]) => injectIntoHost(...a),
    // EI-27053660657887116: the handler reads the host's ack through the
    // confirmation-returning form. Fixtures that resolve a bare boolean keep
    // working; a fixture may resolve a full { ok, confirmation, reason } ack.
    injectIntoHostWithConfirmation: async (...a: unknown[]) => {
      const r = (await injectIntoHost(...a)) as unknown;
      return r && typeof r === 'object' ? r : { ok: Boolean(r), confirmation: r ? 'acked' : 'error' };
    },
    hostSupports,
    // The handler now reads its host gate through this shared predicate
    // (EI-20209826138488049). Composed here from the SAME two primitives the real
    // one composes, so every per-test host fixture still drives the gate unchanged.
    selfCompactionAvailability: (ownerId: string) => {
      const host = liveHost(ownerId);
      if (!host) return { available: false, reason: 'no_live_pty_host', host: null };
      if (!hostSupports(host, 'carry-respawn'))
        return { available: false, reason: 'host_predates_carry_respawn', host };
      return { available: true, reason: null, host };
    },
    selfCompactionAvailabilityAsync: async (ownerId: string) => {
      const host = liveHost(ownerId);
      if (!host) return { available: false, reason: 'no_live_pty_host', host: null };
      if (!hostSupports(host, 'carry-respawn'))
        return { available: false, reason: 'host_predates_carry_respawn', host };
      if (!hostSupports(host, 'control-socket-probe-v1'))
        return { available: false, reason: 'host_socket_probe_unsupported', host };
      return { available: true, reason: null, host };
    },
  };
});
vi.mock('../coordination/identity', () => ({
  resolveAgentIdentity: vi.fn(() => ({ ownerId: 'su-caller', ownerLabel: 'su · caller' })),
}));
const resolveWakeModeMock = vi.hoisted(() => vi.fn());
vi.mock('../coordination/wake-mode', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../coordination/wake-mode')>()),
  resolveWakeMode: (...args: unknown[]) => resolveWakeModeMock(...args),
}));
const getLoopStatus = vi.fn();
const readActiveLoopFacts = vi.fn();
const materializeLoop = vi.fn();
// Spread the real module rather than enumerating the exports this test happens to
// need: a bare factory strands silently the moment `loop.ts` gains an export. That
// is not hypothetical here — `countAgentToolCallsInWindow` (loop.ts, added for
// EI-21874665446367942) was added after this mock was written, so the flush gate's
// dynamic import resolved `undefined`, threw, and the caught error's console.warn
// reddened this file under vitest-fail-on-console. `countAgentToolCallsInWindow` is
// stubbed to `null` = "evidence unavailable", which is exactly the effective
// behaviour before the strand: `detectFlushTripwires` never fires
// 'cold-successor-no-progress' on null, so the tripwire assertions below still test
// only what they mean to. A real number here would be a DIFFERENT test (0 fires it).
vi.mock('../../harness/routines/loop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../harness/routines/loop')>();
  return {
    ...actual,
    getLoopStatus: (...a: unknown[]) => getLoopStatus(...a),
    readActiveLoopFacts: (...a: unknown[]) => readActiveLoopFacts(...a),
    materializeLoop: (...a: unknown[]) => materializeLoop(...a),
    countAgentToolCallsInWindow: async () => null,
  };
});
const getLoopCarryNoteWithMeta = vi.fn();
const setLoopCarryNote = vi.fn();
const setLoopCarryNoteWithPrior = vi.fn();
vi.mock('../../carry-note', async () => {
  const actual = await vi.importActual<typeof import('../../carry-note')>('../../carry-note');
  return {
    ...actual,
    getLoopCarryNoteWithMeta: (...a: unknown[]) => getLoopCarryNoteWithMeta(...a),
    setLoopCarryNote: (...a: unknown[]) => setLoopCarryNote(...a),
    setLoopCarryNoteWithPrior: (...a: unknown[]) => setLoopCarryNoteWithPrior(...a),
  };
});
// EI-8987: buildCarryBrief drives both the default focus AND the stale-checkpoint
// warning. Mocked with a default empty brief; individual tests override per-case.
const buildCarryBrief = vi.fn();
const autoCheckpointStaleHeldItems = vi.hoisted(() => vi.fn(async () => []));
vi.mock('../../turn-end-tracking-io', () => ({ autoCheckpointStaleHeldItems }));
vi.mock('../../carry-brief', async () => {
  const actual = await vi.importActual<typeof import('../../carry-brief')>('../../carry-brief');
  return { ...actual, buildCarryBrief: (...a: unknown[]) => buildCarryBrief(...a) };
});
const emptyBrief = { ownerId: 'su-caller', loop: null, heldItems: [], walls: [], facts: [], awaits: [], fleet: null };
// The flush gate re-checks held-item state immediately before refusing. Keep the
// request-compaction handler test hermetic while exercising that real wiring.
const getWorkItem = vi.hoisted(() => vi.fn());
vi.mock('../../work-items', async () => {
  const actual = await vi.importActual<typeof import('../../work-items')>('../../work-items');
  return { ...actual, getWorkItem: (...a: unknown[]) => getWorkItem(...a) };
});

// P-018: the deterministic successor spec. Mocked so tests drive firstPrompt /
// openOwnerQuestion / null-assembly branches without a real transcript.
const buildOwnerRespawnLaunchSpec = vi.fn();
const sessionCarryPolicy = vi.hoisted(() => vi.fn());
vi.mock('../../capability-envelope/session-confinement-port', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../capability-envelope/session-confinement-port')>()),
  sessionCarryPolicy,
}));
vi.mock('../../carry-respawn', async () => {
  const actual = await vi.importActual<typeof import('../../carry-respawn')>('../../carry-respawn');
  return { ...actual, buildOwnerRespawnLaunchSpec: (...a: unknown[]) => buildOwnerRespawnLaunchSpec(...a) };
});
// The effective-window resolve is a live PG/session read — pin it to the
// fallback path by default so tests stay hermetic (the fallback constant is 200k).
const contextWindowForOwner = vi.hoisted(() => vi.fn(async () => null as number | null));
const currentUsageForOwner = vi.hoisted(() => vi.fn());
const triggerPresence = vi.hoisted(() => vi.fn());
vi.mock('../coordination/presence', async importOriginal => ({
  ...await importOriginal<typeof import('../coordination/presence')>(), getPresence: triggerPresence,
}));
vi.mock('../../compaction-usage', async () => {
  const actual = await vi.importActual<typeof import('../../compaction-usage')>('../../compaction-usage');
  return {
    ...actual,
    resolveModelSpecForOwner: async () => null,
    estimateContextWindowForOwner: contextWindowForOwner,
    currentContextUsageForOwner: currentUsageForOwner,
  };
});

const savePendingCarryRespawn = vi.hoisted(() => vi.fn());
const clearPendingCarryRespawn = vi.hoisted(() => vi.fn());
vi.mock('../../session-brief', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../session-brief')>();
  return {
    ...actual,
    savePendingCarryRespawn: (...a: unknown[]) => savePendingCarryRespawn(...a),
    clearPendingCarryRespawn: (...a: unknown[]) => clearPendingCarryRespawn(...a),
  };
});

const tool = (await import('./request-compaction')).default;

it('opts out of the ambient workspace transaction because the handler never reads ctx.tx', () => {
  expect((tool as unknown as { skipWorkspaceTx?: boolean }).skipWorkspaceTx).toBe(true);
});

it('pins the resolved Codex transcript on the carry control envelope', async () => {
  findLiveHost.mockReturnValue(carryHost);
  resolveSelfSession.mockResolvedValue({ sourceKind: 'codex', filePath: '/fixture/sessions/current.jsonl' });
  await call({ focus: 'preserve the completed turn boundary' });
  expect(injected().sourceTranscriptPath).toBe('/fixture/sessions/current.jsonl');
});

type Out = { content: { text: string }[]; isError?: boolean };
// EI-19480099650947832: the tool reads the host's own event log to report what
// happened to the PREVIOUS carry-respawn. The DERIVATION is unit-tested in
// carry-respawn-outcome.test.ts; what these mocks cover is the WIRING — that the
// tool actually calls it and that the verdict reaches the caller. The note
// builder is deliberately NOT mocked, so the text asserted below is the real one.
const readPriorRespawnOutcome = vi.fn();
vi.mock('../../carry-respawn-outcome', async () => {
  const actual = await vi.importActual<typeof import('../../carry-respawn-outcome')>(
    '../../carry-respawn-outcome',
  );
  return { ...actual, readPriorRespawnOutcome: (...a: unknown[]) => readPriorRespawnOutcome(...a) };
});
// WI-10002530: the respawn-storm breaker. Its ledger read is covered by
// carry-respawn-storm.test.ts; here only the handler wiring is under test.
const detectRespawnStorm = vi.hoisted(() => vi.fn());
const escalateRespawnStorm = vi.hoisted(() => vi.fn());
vi.mock('../../carry-respawn-storm', async () => {
  const actual = await vi.importActual<typeof import('../../carry-respawn-storm')>('../../carry-respawn-storm');
  return {
    ...actual,
    detectRespawnStorm: (...a: unknown[]) => detectRespawnStorm(...a),
    escalateRespawnStorm: (...a: unknown[]) => escalateRespawnStorm(...a),
  };
});
const NO_STORM = { storm: false, reason: null, cutsSinceRealTurn: 0, cutTimes: [], lastRealTurnAt: null };
// WI-6554700010008342: the handler scans all of /proc under a 5s production
// deadline (NATIVE_BG_SCAN_DEADLINE_MS). On the green-checkpoint, the gate load
// pushed that walk past the deadline, so the report came back `degraded: true`
// and the "omits the field" case failed although nothing was alive. These cases
// test the handler's wiring, not the deadline (native-bg-task-ledger.test.ts
// owns that), so give the scan a deadline that load cannot exhaust. A caller-
// supplied scanDeadlineMs still wins.
vi.mock('../../native-bg-task-ledger', async () => {
  const actual = await vi.importActual<typeof import('../../native-bg-task-ledger')>('../../native-bg-task-ledger');
  return {
    ...actual,
    readLiveNativeBgTasks: (input: Parameters<typeof actual.readLiveNativeBgTasks>[0]) =>
      actual.readLiveNativeBgTasks({ scanDeadlineMs: 60_000, ...input }),
  };
});

type Envelope = { mode: string; data: string; systemPromptAddendum?: string; sourceTranscriptPath?: string };
const parse = (x: unknown) => (tool.args as { parse: (x: unknown) => unknown }).parse(x);
const call = (args: Record<string, unknown>, ctx: unknown = {}) =>
  tool.handler(parse(args) as never, ctx as never) as Promise<Out>;
const body = (o: Out) => JSON.parse(o.content[0]!.text);
const injected = (): Envelope => (injectIntoHost.mock.calls[0] as [string, Envelope])[1];

const carryHost = { ownerId: 'su-caller', sock: '/tmp/sock', caps: ['compact', 'carry-respawn', 'control-socket-probe-v1', 'mcp-reconnect'] };
const staleHost = { ownerId: 'su-caller', sock: '/tmp/sock', caps: ['compact'] }; // predates carry-respawn
const closedSpec = {
  systemPromptAddendum: 'CARRY-DOC-ADDENDUM',
  firstPrompt: null,
  budgetChars: 24_000,
  openOwnerQuestion: { crossesOpenOwnerMessage: false },
};

// turn-provenance P-002: the continuation-note first prompt is envelope+ledger-
// tagged (origin self-compaction). Isolate the ledger dir so this suite never
// writes the real ~/.papercusp/turn-provenance, and strip the envelope where an
// assertion is about the NOTE itself.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach } from 'vitest';
let provDir = '';
const ENVELOPE_LINE = /^⟦turn-origin:self-compaction nonce:[a-f0-9]{16}⟧\n/;

beforeEach(async () => {
  vi.clearAllMocks();
  sessionCarryPolicy.mockReset().mockResolvedValue(undefined);
  currentUsageForOwner.mockReset();
  triggerPresence.mockReset().mockResolvedValue({ compactionLimit: 20_000, compactionLimitExplicit: true });
  resolveWakeModeMock.mockReset().mockResolvedValue('auto');
  await __resetRefusalMarkers(); // P-016 durable marker — isolate each test
  void __resetRespawnExpectedMarkers(); // EI-18676518990229124 — same module-level isolation
  delete process.env.PAPERCUSP_FLUSH_GATE;
  injectIntoHost.mockResolvedValue(true);
  savePendingCarryRespawn.mockResolvedValue({
    nonce: 'pending-carry-nonce',
    createdAtMs: 1,
    expiresAtMs: 900_001,
    firstPrompt: 'saved successor prompt',
    systemPromptAddendum: 'saved carry addendum',
  });
  clearPendingCarryRespawn.mockResolvedValue(true);
  resolveSelfSession.mockResolvedValue(null);
  readLoopFireIdentityForCurrentTurn.mockReset().mockResolvedValue(null);
  readPriorRespawnOutcome.mockResolvedValue({ outcome: 'none' });
  detectRespawnStorm.mockResolvedValue(NO_STORM);
  escalateRespawnStorm.mockResolvedValue(undefined);
  buildCarryBrief.mockResolvedValue(emptyBrief);
  autoCheckpointStaleHeldItems.mockReset().mockResolvedValue([]);
  getWorkItem.mockResolvedValue({ state: 'wip' });
  readFrozenRepairMarker.mockReturnValue(null);
  buildOwnerRespawnLaunchSpec.mockResolvedValue(closedSpec);
  contextWindowForOwner.mockResolvedValue(null);
  getLoopStatus.mockResolvedValue(null);
  readActiveLoopFacts.mockResolvedValue({
    active: true,
    intervalSec: 60,
    harnessSlug: 'papercusp',
    goal: 'drain the active lane',
    kickoff: 'CUSTOM OR DEFAULT LOOP KICKOFF',
    customWakePrompt: false,
    fireCount: 0,
    carry: 'warm',
    continuation: 'settle',
    mode: 'work',
    monitor: null,
    armedAt: null,
  });
  materializeLoop.mockResolvedValue({
    id: 'loop-id',
    name: 'loop-su-caller',
    nextFireAt: null,
    targetRole: 'loop-wake',
    intervalSec: 60,
    changed: true,
  });
  setLoopCarryNote.mockResolvedValue(undefined);
  setLoopCarryNoteWithPrior.mockImplementation(async (_ref: unknown, note: unknown) => ({
    stored: typeof note === 'string' ? note : null,
    priorLength: 0,
  }));
  getLoopCarryNoteWithMeta.mockResolvedValue({ note: null, updatedAtMs: null });
  provDir = mkdtempSync(join(tmpdir(), 'reqcomp-prov-'));
  process.env.PAPERCUSP_TURN_PROVENANCE_DIR = provDir;
});
afterEach(() => {
  delete process.env.PAPERCUSP_TURN_PROVENANCE_DIR;
  rmSync(provDir, { recursive: true, force: true });
});

// EI-19480099650947832: `respawn: true` only ever meant "the socket write was
// accepted". The host still has to win a busy-gate and can terminally DROP the
// carry — and every such drop was invisible to the caller, who had just been
// told "wrap up now and stop" and therefore stopped managing its own context.
describe('session:request-compaction — reports what happened to the PREVIOUS respawn', () => {
  it('surfaces a prior DROP, with the host’s own reason, in both the field and the note', async () => {
    findLiveHost.mockReturnValue(carryHost);
    readPriorRespawnOutcome.mockResolvedValue({
      outcome: 'dropped',
      reason: 'busy-gate-expired',
      ts: '2026-08-04T00:38:29.702Z',
      ageMs: 9 * 60_000,
    });
    const b = body(await call({ focus: 'anything' }));
    expect(readPriorRespawnOutcome).toHaveBeenCalledTimes(1);
    expect(b.priorRespawn).toMatchObject({ outcome: 'dropped', reason: 'busy-gate-expired' });
    expect(b.note).toContain('prior-respawn-DROPPED');
    expect(b.note).toContain('busy-gate-expired');
    // The operative correction the caller has to act on.
    expect(b.note).toContain('spawning and submitting its first turn are separate steps');
    expect(b.note).not.toContain('NEVER CUT');
  });

  it('says a still-pending re-poll STILL INSIDE its window is SUPERSEDED by this request rather than racing it', async () => {
    findLiveHost.mockReturnValue(carryHost);
    readPriorRespawnOutcome.mockResolvedValue({
      outcome: 'pending',
      ageMs: PENDING_RESPAWN_DEFAULT_CAP_MS / 4, // deliberately well inside the re-poll window
    });
    const b = body(await call({ focus: 'anything' }));
    expect(b.priorRespawn.outcome).toBe('pending');
    expect(b.note).toContain('prior-respawn-STILL-PENDING');
  });

  // The branch above has a twin the tool path never covered, which is why the
  // fixture could drift across the P-009 threshold and go on asserting a
  // scenario its own name no longer described. Both `pending` verdicts reach the
  // caller as outcome:'pending' — only the NOTE distinguishes them — so the note
  // is the only thing that can carry "nobody is waiting on that attempt".
  it('reports delayed delivery without declaring a multi-window retry orphaned', async () => {
    findLiveHost.mockReturnValue(carryHost);
    readPriorRespawnOutcome.mockResolvedValue({
      outcome: 'pending',
      ageMs: PENDING_RESPAWN_DEFAULT_CAP_MS + PENDING_RESPAWN_ORPHAN_GRACE_MS + 60_000,
    });
    const b = body(await call({ focus: 'anything' }));
    expect(b.priorRespawn.outcome).toBe('pending');
    expect(b.note).toContain('prior-respawn-DELAYED');
    expect(b.note).toContain('may still be retrying');
    expect(b.note).not.toContain('ORPHANED');
    expect(b.note).not.toContain('prior-respawn-STILL-PENDING');
  });

  // A warning that fires when nothing is wrong trains agents to ignore it.
  it('is SILENT when the last respawn delivered, and when there is no history at all', async () => {
    findLiveHost.mockReturnValue(carryHost);
    readPriorRespawnOutcome.mockResolvedValue({ outcome: 'delivered', ageMs: 1000 });
    expect(body(await call({ focus: 'x' })).note).not.toContain('prior-respawn');
    vi.clearAllMocks();
    injectIntoHost.mockResolvedValue(true);
    buildCarryBrief.mockResolvedValue(emptyBrief);
    buildOwnerRespawnLaunchSpec.mockResolvedValue(closedSpec);
    findLiveHost.mockReturnValue(carryHost);
    readPriorRespawnOutcome.mockResolvedValue({ outcome: 'none' });
    const b = body(await call({ focus: 'x' }));
    expect(b.priorRespawn).toEqual({ outcome: 'none' });
    expect(b.note).not.toContain('prior-respawn');
  });

  // The read must describe HISTORY, not the request being made — so it happens
  // before the inject, never after.
  it('reads the prior verdict BEFORE injecting this request', async () => {
    findLiveHost.mockReturnValue(carryHost);
    const order: string[] = [];
    readPriorRespawnOutcome.mockImplementation(async () => {
      order.push('read');
      return { outcome: 'none' };
    });
    injectIntoHost.mockImplementation(async () => {
      order.push('inject');
      return true;
    });
    await call({ focus: 'x' });
    expect(order).toEqual(['read', 'inject']);
  });
});

describe('session:request-compaction — P-018/P-022 carry-respawn actuation', () => {
  it('refuses before persistence or host injection when the effective mode is manual', async () => {
    resolveWakeModeMock.mockResolvedValue('manual');

    const out = await call({ focus: 'continue the preserved unit' });

    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({ ok: false, requested: false, error: 'wake_mode_manual' });
    expect(savePendingCarryRespawn).not.toHaveBeenCalled();
    expect(injectIntoHost).not.toHaveBeenCalled();
  });

  it('fails closed when the effective wake mode cannot be read', async () => {
    resolveWakeModeMock.mockRejectedValueOnce(new Error('read unavailable'));

    const out = await call({ focus: 'continue the preserved unit' });

    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({ ok: false, requested: false, error: 'wake_mode_unavailable' });
    expect(savePendingCarryRespawn).not.toHaveBeenCalled();
    expect(injectIntoHost).not.toHaveBeenCalled();
  });

  // EI-27053660657887116: every Claude psu host advertises pending-carry-fence-v1
  // but has no native session id, so the host's fence refused every NONCE-BOUND
  // carry as 'stale-carry-target' — and the tool reported that as an unreachable
  // socket. Bind only when the host can match; surface a host refusal as one.
  describe('pending-carry fence binding (EI-27053660657887116)', () => {
    const fenceIdentity = {
      advSessionId: '52768',
      startedAt: 1_793_000_507_733,
      childGeneration: 5,
      hostCodeVersion: '0329058646',
    };
    const claudeFenceHost = { ...carryHost, caps: [...carryHost.caps, 'pending-carry-fence-v1'], ...fenceIdentity };
    const codexFenceHost = { ...claudeFenceHost, nativeSessionId: '019a0000-0000-7000-8000-000000000001' };

    it('sends an UNBOUND carry to a fence-capable host that has no native session id (every Claude host)', async () => {
      findLiveHost.mockReturnValue(claudeFenceHost);
      const b = body(await call({ focus: 'finish the fence fix' }));
      expect(b.ok).toBe(true);
      const msg = injected() as Envelope & Record<string, unknown>;
      expect(msg.mode).toBe('carry-respawn');
      expect(msg).not.toHaveProperty('carryNonce');
      expect(msg).not.toHaveProperty('expectedNativeSessionId');
    });

    it('still binds the carry to its nonce when the host can match the fence identity', async () => {
      findLiveHost.mockReturnValue(codexFenceHost);
      await call({ focus: 'finish the fence fix' });
      const msg = injected() as Envelope & Record<string, unknown>;
      expect(msg.carryNonce).toBe('pending-carry-nonce');
      expect(msg.expectedNativeSessionId).toBe(codexFenceHost.nativeSessionId);
      expect(msg.expectedChildGeneration).toBe(5);
    });

    it('reports a host REFUSAL with its reason, never as an unreachable socket', async () => {
      findLiveHost.mockReturnValue(carryHost);
      injectIntoHost.mockResolvedValue({ ok: false, confirmation: 'acked', reason: 'stale-carry-target' });
      const out = await call({ focus: 'finish the fence fix' });
      expect(out.isError).toBe(true);
      const b = body(out);
      expect(b.ok).toBe(false);
      expect(b.error).toBe('carry_respawn_refused');
      expect(b.hostRefusalReason).toBe('stale-carry-target');
      expect(b.hostConfirmation).toBe('acked');
      expect(b.note).toContain('REFUSED');
      expect(b.note).toContain('stale-carry-target');
      expect(b.note).not.toContain('Failed to reach');
    });

    it('reports immediate connection failures without claiming the timeout elapsed', async () => {
      findLiveHost.mockReturnValue(carryHost);
      injectIntoHost.mockResolvedValue({
        ok: false,
        confirmation: 'error',
        transportErrorCode: 'ECONNREFUSED',
      });
      const out = await call({ focus: 'finish the fence fix' });
      expect(out.isError).toBe(true);
      const b = body(out);
      expect(b.ok).toBe(false);
      expect(b.error).toBe('carry_respawn_unreachable');
      expect(b.hostConfirmation).toBe('error');
      expect(b.hostTransportErrorCode).toBe('ECONNREFUSED');
      expect(b.note).toContain('failed before a host acknowledgement');
      expect(b.note).toContain('ECONNREFUSED');
      expect(b.note).not.toContain('waiting up to');
    });

    it('reports the socket acknowledgement timeout and preserves the ambiguous outcome', async () => {
      findLiveHost.mockReturnValue(carryHost);
      injectIntoHost.mockResolvedValue({ ok: false, confirmation: 'timeout' });
      const out = await call({ focus: 'finish the fence fix' });
      expect(out.isError).toBe(true);
      const b = body(out);
      expect(b.ok).toBe(false);
      expect(b.error).toBe('carry_respawn_ack_timeout');
      expect(b).not.toHaveProperty('hostRefusalReason');
      expect(b.hostConfirmation).toBe('timeout');
      expect(b.note).toContain('No acknowledgement arrived from the session TUI host socket');
      expect(b.note).toContain('within 540000ms');
      expect(b.note).toContain('host may have accepted the request');
    });
  });

  it('keeps the transport budget beyond the legacy-host compatibility wait', () => {
    expect(tool.timeoutSec).toBe(600);
  });

  it('carry-respawn-capable host → mode:carry-respawn with the addendum + a NON-EMPTY continue note derived from focus', async () => {
    findLiveHost.mockReturnValue(carryHost);
    const b = body(await call({ focus: 'finish the ratchet fix' }));
    expect(injectIntoHost).toHaveBeenCalledTimes(1);
    expect(injectIntoHost.mock.calls[0]?.[2]).toBe(9 * 60_000);
    const msg = injected();
    expect(msg.mode).toBe('carry-respawn');
    expect(msg.systemPromptAddendum).toBe('CARRY-DOC-ADDENDUM');
    // The first prompt is what RESUMES the successor — it must be non-empty.
    expect(typeof msg.data).toBe('string');
    expect(msg.data.length).toBeGreaterThan(0);
    expect(msg.data).toContain('finish the ratchet fix');
    expect(msg.data).toContain('⟦post-compaction-recovery⟧');
    expect(msg.data).toContain('do not call coord:orient');
    expect(msg.data).toContain('coord:declare-intent { intent, current_plan_slug, items }');
    expect(msg.data).toContain('exactly once only when the marker is absent');
    expect(msg.data).not.toContain('First re-run coord:orient');
    // turn-provenance P-002: the machine-authored continuation is envelope-tagged.
    expect(msg.data).toMatch(ENVELOPE_LINE);
    expect(b).toMatchObject({
      ok: true,
      requested: true,
      respawn: 'queued',
      budgetChars: 24_000,
      firstPromptSource: 'continuation-note',
    });
  });

  it('carries a verified loop identity into the generated self-compaction prompt', async () => {
    findLiveHost.mockReturnValue(carryHost);
    resolveSelfSession.mockResolvedValue({
      sourceKind: 'codex',
      sessionId: 'current-session',
      filePath: '/fixture/sessions/current.jsonl',
    });
    readLoopFireIdentityForCurrentTurn.mockResolvedValue({ routineId: 'routine-10', wakeCount: 10 });

    const result = body(await call({ focus: 'finish the current loop work' }));
    const rows = readLedgerRows('su-caller', { dir: provDir, includeExpired: true });
    const continuation = rows.filter((row) => row.origin === 'self-compaction').pop();

    expect(result.firstPromptSource).toBe('continuation-note');
    expect(readLoopFireIdentityForCurrentTurn).toHaveBeenCalledWith(
      { owner: 'su-caller', sessionId: 'current-session', sourceKind: 'codex' },
      expect.anything(),
    );
    expect(continuation?.loopFire).toEqual({ routineId: 'routine-10', wakeCount: 10 });
  });

  it('tags an open owner message for machine provenance without attaching loop identity', async () => {
    findLiveHost.mockReturnValue(carryHost);
    resolveSelfSession.mockResolvedValue({
      sourceKind: 'codex',
      sessionId: 'current-session',
      filePath: '/fixture/sessions/current.jsonl',
    });
    readLoopFireIdentityForCurrentTurn.mockResolvedValue({ routineId: 'routine-10', wakeCount: 10 });
    buildOwnerRespawnLaunchSpec.mockResolvedValue({
      ...closedSpec,
      firstPrompt: 'owner-authored question',
      openOwnerQuestion: { crossesOpenOwnerMessage: true },
    });

    const result = body(await call({ focus: 'preserve the current work' }));
    const rows = readLedgerRows('su-caller', { dir: provDir, includeExpired: true });
    const msg = injected();

    expect(result.firstPromptSource).toBe('open-owner-message');
    expect(msg.data).toMatch(ENVELOPE_LINE);
    expect(msg.data.replace(ENVELOPE_LINE, '')).toBe('owner-authored question');
    const provenance = rows.filter((row) => row.origin === 'self-compaction').at(-1);
    expect(provenance).toBeDefined();
    expect(provenance?.loopFire).toBeUndefined();
  });

  it('persists the exact first prompt and addendum before asking the host to respawn', async () => {
    findLiveHost.mockReturnValue(carryHost);
    const order: string[] = [];
    savePendingCarryRespawn.mockImplementation(async (_identity: unknown, payload: unknown) => {
      order.push('persist');
      return { nonce: 'pending-carry-nonce', ...(payload as Record<string, unknown>) };
    });
    injectIntoHost.mockImplementation(async () => {
      order.push('inject');
      return true;
    });

    const result = body(await call({ focus: 'continue the preserved unit' }));
    const msg = injected();

    expect(order).toEqual(['persist', 'inject']);
    expect(savePendingCarryRespawn).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'su-caller' }),
      { firstPrompt: msg.data, systemPromptAddendum: 'CARRY-DOC-ADDENDUM' },
    );
    expect(result).toMatchObject({ ok: true, requested: true, respawn: 'queued' });
  });

  it('does not send a carry-respawn when the durable save returns no slot', async () => {
    findLiveHost.mockReturnValue(carryHost);
    savePendingCarryRespawn.mockResolvedValue(null);

    const out = await call({ focus: 'continue the preserved unit' });

    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({ ok: false, requested: false, error: 'carry_persist_failed' });
    expect(injectIntoHost).not.toHaveBeenCalled();
  });

  it('refuses the historical staging-candidate focus before any host or fallback persistence', async () => {
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
      focus: 'Then pin whatever staging resolves to at that instant, still never a quoted sha.',
    });

    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({
      ok: false,
      error: 'frozen_candidate_lineage_violation',
      surface: 'compaction-continuation',
      unsafeSource: 'staging',
      liveIdentity: {
        candidate: 'c'.repeat(40),
        repairHead: 'r'.repeat(40),
        queueRevision: 1_788_763_360_000,
      },
    });
    expect(buildOwnerRespawnLaunchSpec).not.toHaveBeenCalled();
    expect(setLoopCarryNoteWithPrior).not.toHaveBeenCalled();
    expect(injectIntoHost).not.toHaveBeenCalled();
  });

  it('allows a negative staging-route note in the focus to pass the live carry boundary', async () => {
    findLiveHost.mockReturnValue(carryHost);
    readFrozenRepairMarker.mockReturnValue({
      candidate: 'c'.repeat(40),
      repairHead: 'r'.repeat(40),
      phase: 'repair-in-progress',
      failingPaths: [],
      updatedAtMs: 1_788_763_360_000,
      admittedPaths: [],
      legs: [],
    });

    const focus = 'The candidate fix is uncommitted and no approved staging route has been provided.';
    const out = await call({ focus });

    expect(out.isError).toBeUndefined();
    expect(body(out)).toMatchObject({ ok: true, requested: true, respawn: 'queued' });
    expect(buildOwnerRespawnLaunchSpec).toHaveBeenCalledTimes(1);
    expect(injectIntoHost).toHaveBeenCalledTimes(1);
    expect(injected().data).toContain(focus);
  });

  it('does not reinterpret stale candidate prose in the immutable host addendum as a live instruction', async () => {
    readFrozenRepairMarker.mockReturnValue({
      candidate: 'c'.repeat(40),
      repairHead: 'r'.repeat(40),
      phase: 'repair-in-progress',
      failingPaths: [],
      updatedAtMs: 1_788_763_360_000,
      admittedPaths: [],
      legs: [],
    });
    buildOwnerRespawnLaunchSpec.mockResolvedValue({
      ...closedSpec,
      systemPromptAddendum:
        'D-017 — Then pin whatever staging resolves to at that instant, still never a quoted sha.',
    });

    const out = await call({ focus: 'Resume the currently held work-item from live state.' });

    expect(out.isError).toBeUndefined();
    expect(body(out)).toMatchObject({ ok: true, requested: true, respawn: 'queued' });
    expect(buildOwnerRespawnLaunchSpec).toHaveBeenCalledTimes(1);
    expect(injectIntoHost).toHaveBeenCalledTimes(1);
    expect(injected().systemPromptAddendum).toContain('staging resolves to');
  });

  it('still refuses unsafe candidate prose in the live firstPrompt at the host boundary', async () => {
    readFrozenRepairMarker.mockReturnValue({
      candidate: 'c'.repeat(40),
      repairHead: 'r'.repeat(40),
      phase: 'repair-in-progress',
      failingPaths: [],
      updatedAtMs: 1_788_763_360_000,
      admittedPaths: [],
      legs: [],
    });
    buildOwnerRespawnLaunchSpec.mockResolvedValue({
      ...closedSpec,
      firstPrompt: 'Then pin whatever staging resolves to at that instant.',
      openOwnerQuestion: { crossesOpenOwnerMessage: true },
    });

    const out = await call({ focus: 'Resume the currently held work-item from live state.' });

    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({
      error: 'frozen_candidate_lineage_violation',
      surface: 'compaction-continuation',
      unsafeSource: 'staging',
    });
    expect(injectIntoHost).not.toHaveBeenCalled();
  });

  it('keeps moving-tip behavior when no frozen marker exists', async () => {
    findLiveHost.mockReturnValue(carryHost);
    await call({ focus: 'Then pin whatever staging resolves to at that instant, still never a quoted sha.' });
    expect(injectIntoHost).toHaveBeenCalledTimes(1);
  });

  it('host WITHOUT the carry-respawn cap → loud host_predates_carry_respawn error, NOTHING injected (no /compact fallback exists — P-022)', async () => {
    findLiveHost.mockReturnValue(staleHost);
    const out = await call({ focus: 'x' });
    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({ ok: false, error: 'host_predates_carry_respawn' });
    expect(injectIntoHost).not.toHaveBeenCalled();
    expect(buildOwnerRespawnLaunchSpec).not.toHaveBeenCalled();
  });

  it('WI-10002530: a respawn STORM → refused respawn-storm, process intact, ONE escalation naming the held items, nothing injected', async () => {
    findLiveHost.mockReturnValue(carryHost);
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      heldItems: [{ id: 'WI-777', title: 'gate lane', body: null, harness: 'papercusp', checkpoint: null }],
    });
    const verdict = {
      storm: true,
      reason: 'dense-cuts',
      cutsSinceRealTurn: 2,
      cutTimes: ['2026-09-23T00:15:19.000Z', '2026-09-23T00:14:38.000Z'],
      lastRealTurnAt: '2026-09-23T00:14:36.000Z',
    };
    detectRespawnStorm.mockResolvedValue(verdict);
    const out = await call({ focus: 'x' });
    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({ ok: false, requested: false, error: 'respawn-storm', storm: verdict });
    expect(detectRespawnStorm).toHaveBeenCalledWith('su-caller');
    expect(escalateRespawnStorm).toHaveBeenCalledTimes(1);
    expect(escalateRespawnStorm.mock.calls[0]![0]).toMatchObject({
      ownerId: 'su-caller',
      verdict,
      heldItems: [{ id: 'WI-777', title: 'gate lane' }],
    });
    expect(injectIntoHost).not.toHaveBeenCalled();
    expect(buildOwnerRespawnLaunchSpec).not.toHaveBeenCalled();
  });

  it('WI-10002530: no storm → the breaker is consulted, raises nothing, and the cut still queues', async () => {
    findLiveHost.mockReturnValue(carryHost);
    const out = await call({ focus: 'x' });
    expect(body(out)).toMatchObject({ requested: true, respawn: 'queued' });
    expect(detectRespawnStorm).toHaveBeenCalledWith('su-caller');
    expect(escalateRespawnStorm).not.toHaveBeenCalled();
    expect(injectIntoHost).toHaveBeenCalledTimes(1);
  });

  it('spec assembly failure (null) → carry_build_failed, session left intact, nothing injected', async () => {
    findLiveHost.mockReturnValue(carryHost);
    buildOwnerRespawnLaunchSpec.mockResolvedValue(null);
    const out = await call({ focus: 'x' });
    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({ ok: false, requested: false, error: 'carry_build_failed' });
    expect(injectIntoHost).not.toHaveBeenCalled();
  });

  it('reports frozen assignment assembly hashes and labels its mocked host queue without claiming delivery', async () => {
    findLiveHost.mockReturnValue(carryHost);
    const frozenAssignmentCarry = { mode: 'off', initialPromptSha256: 'a'.repeat(64),
      noteSha256: null, firstPromptSha256: 'a'.repeat(64) };
    buildOwnerRespawnLaunchSpec.mockResolvedValue({ firstPrompt: 'Frozen initial assignment',
      systemPromptAddendum: '', budgetChars: 0, openOwnerQuestion: { crossesOpenOwnerMessage: false }, frozenAssignmentCarry });
    const result = body(await call({}));
    expect(result).toMatchObject({ ok: true, respawn: 'queued', firstPromptSource: 'frozen-assignment', frozenAssignmentCarry });
    expect(injected().data).toBe('Frozen initial assignment');
    expect(injected().systemPromptAddendum).toBe('');
    expect(savePendingCarryRespawn).toHaveBeenCalledWith(expect.anything(),
      { firstPrompt: 'Frozen initial assignment', systemPromptAddendum: '' });
  });

  it.each(['on', 'off'] as const)('confines frozen %s compaction before ambient carry, flush and transcript reads', async (mode) => {
    const { createHash } = await import('node:crypto');
    const { buildFrozenAssignmentRespawnSpec } = await import('../../carry-respawn');
    const boundary = { initialPrompt: 'Frozen task only',
      initialPromptSha256: createHash('sha256').update('Frozen task only').digest('hex'), mode };
    sessionCarryPolicy.mockResolvedValue(boundary);
    resolveSelfSession.mockResolvedValue({ sourceKind: 'codex', sessionId: 'own-native',
      filePath: '/fixture/own-native-rollout.jsonl' });
    buildOwnerRespawnLaunchSpec.mockResolvedValue(buildFrozenAssignmentRespawnSpec(boundary, 'Own bounded note'));
    // A general brief would introduce a foreign held item and trigger a save.
    buildCarryBrief.mockResolvedValue({ ...emptyBrief,
      heldItems: [{ id: 'WI-FOREIGN', title: 'Ambient secret', checkpoint: null }] });
    findLiveHost.mockReturnValue(carryHost);
    const result = body(await call({ continueNote: 'Own bounded note' }));
    expect(result).toMatchObject({ ok: true, respawn: 'queued', firstPromptSource: 'frozen-assignment',
      staleCheckpoints: [], frozenAssignmentCarry: { mode } });
    expect(injected().data).toBe(mode === 'on'
      ? "Frozen task only\n\nContinuation note from this assignment's prior session:\nOwn bounded note" : 'Frozen task only');
    expect(injected().systemPromptAddendum).toBe('');
    expect(injected().sourceTranscriptPath).toBe('/fixture/own-native-rollout.jsonl');
    expect(buildCarryBrief).not.toHaveBeenCalled();
    expect(autoCheckpointStaleHeldItems).not.toHaveBeenCalled();
    expect(getWorkItem).not.toHaveBeenCalled();
    expect(resolveSelfSession).toHaveBeenCalledWith('su-caller');
    expect(readLoopFireIdentityForCurrentTurn).not.toHaveBeenCalled();
    expect(getLoopStatus).not.toHaveBeenCalled();
    expect(getLoopCarryNoteWithMeta).not.toHaveBeenCalled();
    expect(bumpSessionEpoch).not.toHaveBeenCalled();
  });

  it('refuses an unavailable carry policy before any ambient or host fallback read', async () => {
    sessionCarryPolicy.mockRejectedValue(new Error('policy store unavailable'));
    expect(body(await call({}))).toMatchObject({ ok: false, error: 'carry_policy_unavailable', respawn: false });
    expect(findLiveHost).not.toHaveBeenCalled();
    expect(buildCarryBrief).not.toHaveBeenCalled();
    expect(buildOwnerRespawnLaunchSpec).not.toHaveBeenCalled();
    expect(injectIntoHost).not.toHaveBeenCalled();
  });
  it.each(['early', 'stale', 'missing', 'reached', 'different-native', 'changed-limit', 'derived-limit'] as const)(
    'uses actual host usage for a frozen self-compaction trigger: %s', async state => {
    const { createHash } = await import('node:crypto');
    const { buildFrozenAssignmentRespawnSpec } = await import('../../carry-respawn');
    const boundary = { mode: 'on' as const, initialPrompt: 'Frozen threshold task', compactionLimit: 20_000,
      initialPromptSha256: createHash('sha256').update('Frozen threshold task').digest('hex') };
    sessionCarryPolicy.mockResolvedValue(boundary);
    if (state === 'changed-limit') triggerPresence.mockResolvedValue({ compactionLimit: 25_000, compactionLimitExplicit: true });
    if (state === 'derived-limit') triggerPresence.mockResolvedValue({ compactionLimit: 20_000, compactionLimitExplicit: false });
    currentUsageForOwner.mockResolvedValue({ backend: 'codex', nativeSessionId: 'own-native',
      sessionStartedAtMs: Date.now() - 1000, unavailableReason: null, reading: state === 'missing' ? null : {
        tokens: state === 'early' ? 19_999 : 20_000, observedAtMs: Date.now() - (state === 'stale' ? 120_000 : 0),
        source: 'codex-last-token-usage' } });
    resolveSelfSession.mockResolvedValue({ sourceKind: 'codex', sessionId: state === 'different-native' ? 'successor-native' : 'own-native',
      filePath: '/fixture/own-native-rollout.jsonl' });
    buildOwnerRespawnLaunchSpec.mockImplementation(async (_owner, opts) =>
      buildFrozenAssignmentRespawnSpec(boundary, opts.continueNote, opts.frozenTrigger));
    findLiveHost.mockReturnValue(carryHost);
    const result = body(await call({ continueNote: 'Own bounded note' }));
    if (state === 'reached') {
      expect(result).toMatchObject({ respawn: 'queued', frozenAssignmentCarry: { trigger: {
        kind: 'matched-threshold', source: 'self-request', limitTokens: 20_000, observedTokens: 20_000,
        nativeSessionId: 'own-native' } } });
      expect(injected().data).toContain('Own bounded note');
    } else {
      expect(result).toMatchObject({ ok: false, requested: false,
        error: state === 'different-native' ? 'carry_build_failed' : 'frozen_compaction_trigger_unverified' });
      expect(injectIntoHost).not.toHaveBeenCalled();
      expect(savePendingCarryRespawn).not.toHaveBeenCalled();
    }
    expect(buildCarryBrief).not.toHaveBeenCalled();
  });

  it('refuses a changed frozen carry policy without persisting or injecting an ambient successor', async () => {
    const { createHash } = await import('node:crypto');
    sessionCarryPolicy.mockResolvedValue({ mode: 'off', initialPrompt: 'Frozen task only',
      initialPromptSha256: createHash('sha256').update('Frozen task only').digest('hex') });
    findLiveHost.mockReturnValue(carryHost);
    buildOwnerRespawnLaunchSpec.mockResolvedValue({ ...closedSpec, firstPrompt: 'Ambient replacement' });
    expect(body(await call({}))).toMatchObject({ ok: false, error: 'carry_build_failed' });
    expect(savePendingCarryRespawn).not.toHaveBeenCalled();
    expect(injectIntoHost).not.toHaveBeenCalled();
    expect(buildCarryBrief).not.toHaveBeenCalled();
  });

  it('does not read loop carry for a frozen assignment without a live host', async () => {
    const { createHash } = await import('node:crypto');
    sessionCarryPolicy.mockResolvedValue({ mode: 'off', initialPrompt: 'Frozen task only',
      initialPromptSha256: createHash('sha256').update('Frozen task only').digest('hex') });
    findLiveHost.mockReturnValue(null);
    expect(body(await call({}))).toMatchObject({ ok: false, error: 'no_live_pty_host', respawn: false });
    expect(getLoopStatus).not.toHaveBeenCalled();
    expect(getLoopCarryNoteWithMeta).not.toHaveBeenCalled();
  });

  it('refuses corrupt frozen carry bytes without throwing or reading ambient context', async () => {
    sessionCarryPolicy.mockResolvedValue({ mode: 'off', initialPrompt: 'Altered task bytes',
      initialPromptSha256: 'a'.repeat(64) });
    findLiveHost.mockReturnValue(carryHost);
    buildOwnerRespawnLaunchSpec.mockResolvedValue(null);
    expect(body(await call({}))).toMatchObject({ ok: false, requested: false, error: 'carry_build_failed' });
    expect(buildCarryBrief).not.toHaveBeenCalled();
    expect(savePendingCarryRespawn).not.toHaveBeenCalled();
    expect(injectIntoHost).not.toHaveBeenCalled();
  });

  it('the spec build is a DELIBERATE boundary with the resolved (fallback) window', async () => {
    findLiveHost.mockReturnValue(carryHost);
    await call({ focus: 'x' });
    expect(buildOwnerRespawnLaunchSpec).toHaveBeenCalledWith(
      'su-caller',
      expect.objectContaining({
        effectiveWindowTokens: 200_000,
        buildOpts: expect.objectContaining({ boundaryDeliberate: true }),
      }),
    );
  });

  it('uses Codex rollout effective-window telemetry when available', async () => {
    findLiveHost.mockReturnValue(carryHost);
    contextWindowForOwner.mockResolvedValue(258_400);
    await call({ focus: 'x' });
    expect(buildOwnerRespawnLaunchSpec).toHaveBeenCalledWith(
      'su-caller',
      expect.objectContaining({ effectiveWindowTokens: 258_400 }),
    );
  });

  it('continueNote overrides the derived first prompt verbatim (behind the provenance envelope + WI-2140968 address line)', async () => {
    findLiveHost.mockReturnValue(carryHost);
    await call({ focus: 'x', continueNote: 'resume: do the thing' });
    expect(buildOwnerRespawnLaunchSpec).toHaveBeenCalledWith('su-caller',
      expect.objectContaining({ continueNote: 'resume: do the thing' }));
    const msg = injected();
    expect(msg.mode).toBe('carry-respawn');
    expect(msg.data).toMatch(ENVELOPE_LINE);
    const payload = msg.data.replace(ENVELOPE_LINE, '');
    // WI-2140968: a caller-supplied note REPLACES the derived one, so it is the
    // branch that would ship unaddressed if the stamp lived in
    // defaultContinueNote. It must carry the address line too.
    expect(payload.startsWith(ADDRESS_PREFIX)).toBe(true);
    expect(payload).toContain('su-caller');
    // The caller's text still rides verbatim — unparaphrased, untruncated.
    expect(payload.replace(ADDRESS_PREFIX, '')).toBe('resume: do the thing');
  });

  it('replaces a first-prompt hint that repeats a same-session retracted continuation', async () => {
    findLiveHost.mockReturnValue(carryHost);
    buildOwnerRespawnLaunchSpec.mockResolvedValue({
      ...closedSpec,
      retractedContinuationRefs: ['EI-20191442676357637'],
    });
    await call({ focus: 'Resume the ship path for EI-20191442676357637 and execute it now.' });
    const payload = injected().data.replace(ENVELOPE_LINE, '');
    expect(payload).toContain('RETRACTED CONTINUATION DIRECTIVE');
    expect(payload).toContain('EI-20191442676357637');
    expect(payload).toContain('Re-orient from the automatically delivered carry document');
    expect(payload).not.toContain('execute it now');
  });

  it('autoContinue is a wire-compat no-op: passing false still respawns (a carry-respawn always resumes)', async () => {
    findLiveHost.mockReturnValue(carryHost);
    const b = body(await call({ focus: 'x', autoContinue: false }));
    expect(injected().mode).toBe('carry-respawn');
    expect(b).toMatchObject({ ok: true, respawn: 'queued' });
  });

  it('legacy resumeMode:"same" is a bounded wire-compat no-op: stale callers still queue the cut', async () => {
    findLiveHost.mockReturnValue(carryHost);
    const b = body(await call({ focus: 'x', resumeMode: 'same' }));
    expect(injected().mode).toBe('carry-respawn');
    expect(b).toMatchObject({ ok: true, respawn: 'queued' });
    expect(() => parse({ focus: 'x', resumeMode: 'fresh' })).toThrow();
  });

  it('legacy reason is a bounded wire-compat no-op: callers can annotate the request without blocking the cut (EI-20252809455491677)', async () => {
    findLiveHost.mockReturnValue(carryHost);
    const b = body(await call({ focus: 'x', reason: 'clean stopping point' }));
    expect(injected().mode).toBe('carry-respawn');
    expect(b).toMatchObject({ ok: true, respawn: 'queued' });
  });

  it('legacy respawn:true is a wire-compat no-op: stale carry callers still queue the cut (EI-20250117090491411)', async () => {
    findLiveHost.mockReturnValue(carryHost);
    const b = body(await call({ focus: 'x', respawn: true }));
    expect(injected().mode).toBe('carry-respawn');
    expect(b).toMatchObject({ ok: true, respawn: 'queued' });
  });

  it('no live psu-pty host → clean no_live_pty_host error, nothing injected', async () => {
    findLiveHost.mockReturnValue(null);
    const out = await call({ focus: 'x' });
    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({
      ok: false,
      requested: false,
      respawn: false,
      error: 'no_live_pty_host',
    });
    expect(body(out).note).toContain('no carry-respawn was queued');
    expect(injectIntoHost).not.toHaveBeenCalled();
    expect(detectRespawnStorm).not.toHaveBeenCalled();
  });

  it('refuses self-compaction when host metadata cannot verify its control socket', async () => {
    findLiveHost.mockReturnValue({
      ...carryHost,
      caps: ['compact', 'carry-respawn', 'mcp-reconnect'],
    });
    const out = await call({ focus: 'x' });
    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({
      ok: false,
      requested: false,
      respawn: false,
      error: 'host_socket_probe_unsupported',
    });
    expect(body(out).note).toContain('listener cannot be confirmed');
    expect(injectIntoHost).not.toHaveBeenCalled();
  });

  it('an armed cold loop and verified carry-note do not prove compaction without a host', async () => {
    findLiveHost.mockReturnValue(null);
    getLoopStatus.mockResolvedValue({
      active: true,
      carry: 'cold',
      harnessSlug: 'papercusp',
    });
    getLoopCarryNoteWithMeta.mockResolvedValue({
      note: '## Next action\ncontinue',
      updatedAtMs: Date.now(),
    });
    const out = await call({ focus: 'x' });
    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({
      ok: false,
      requested: false,
      respawn: false,
      error: 'no_live_pty_host',
      carry: 'cold',
      carryNote: { verified: true },
    });
    expect(body(out).note).toContain('do not prove the next turn can be delivered');
    expect(body(out).note).not.toContain('End this turn');
    expect(injectIntoHost).not.toHaveBeenCalled();
    expect(detectRespawnStorm).not.toHaveBeenCalled();
  });

  it.each([
    ['empty compaction request', {}],
    ['focused compaction request', { focus: 'continue the fleet lane' }],
    ['automatic continuation request', { autoContinue: true }],
    ['explicit respawn request', { respawn: true, continueNote: 'resume the held lane' }],
  ])('%s without a host preserves the active warm route', async (_label, args) => {
    findLiveHost.mockReturnValue(null);
    getLoopStatus.mockResolvedValue({
      active: true,
      carry: 'warm',
      harnessSlug: 'papercusp',
      goal: 'Preserve the original WARM route and qualified admission HOLD',
    });
    getLoopCarryNoteWithMeta.mockResolvedValue({
      note: 'Existing source-custody checkpoint',
      updatedAtMs: Date.now(),
    });

    const out = await call(args);

    expect(out.isError).toBe(true);
    expect(body(out)).toMatchObject({
      ok: false,
      requested: false,
      respawn: false,
      error: 'no_live_pty_host',
      carry: 'warm',
      retuned: false,
    });
    expect(body(out).note).toContain('keeps its warm carry policy');
    expect(body(out).note).not.toContain('End this turn');
    expect(setLoopCarryNoteWithPrior).not.toHaveBeenCalled();
    expect(materializeLoop).not.toHaveBeenCalled();
    expect(savePendingCarryRespawn).not.toHaveBeenCalled();
    expect(injectIntoHost).not.toHaveBeenCalled();
    expect(detectRespawnStorm).not.toHaveBeenCalled();
  });

  it('no focus → the carry-brief/default preserve-set focus still yields a non-empty first prompt', async () => {
    findLiveHost.mockReturnValue(carryHost);
    const b = body(await call({}));
    const msg = injected();
    expect(msg.mode).toBe('carry-respawn');
    expect(msg.data.length).toBeGreaterThan(0); // DEFAULT_FOCUS folded into the note
    expect(b).toMatchObject({ ok: true, respawn: 'queued' });
  });

  it('a failed socket write (injectIntoHost=false) surfaces requested:false, respawn:false', async () => {
    findLiveHost.mockReturnValue(carryHost);
    injectIntoHost.mockResolvedValue(false);
    const b = body(await call({ focus: 'x' }));
    expect(b).toMatchObject({ ok: false, requested: false, respawn: false });
    expect(clearPendingCarryRespawn).toHaveBeenCalledWith('su-caller', 'pending-carry-nonce');
  });

  // EI-18686525818431054: the default injectIntoHost socket timeout (2000ms) is
  // sized for an ordinary wake turn, not a carry-respawn — the host's busy-gate
  // wait behind the ack can legitimately run far longer (up to the doubled
  // busy-gate cap), and a host predating the ack-early fix awaits the WHOLE
  // gated pipeline before acking at all. A carry-respawn call must use a much
  // longer client-side timeout so it doesn't false-negative exactly when the
  // sanctioned context-shedding path is needed most.
  it('carry-respawn passes a socket timeout FAR longer than injectIntoHost\'s 2000ms default (EI-18686525818431054)', async () => {
    findLiveHost.mockReturnValue(carryHost);
    await call({ focus: 'x' });
    expect(injectIntoHost).toHaveBeenCalledTimes(1);
    const timeoutArg = injectIntoHost.mock.calls[0]![2] as number;
    expect(timeoutArg).toBeGreaterThanOrEqual(5 * 60_000); // safely past the 2x180s busy-gate cap
  });

  // EI-18686525818431054 ask #3: the failure note must name the socket path
  // tried (+ host pid) so the next diagnosis doesn't have to reverse-engineer
  // it from `ps`/`find` (this filing's own investigation cost ~6 tool calls).
  it('a failed socket write names the socket path + host pid in the failure note and body', async () => {
    findLiveHost.mockReturnValue({ ...carryHost, pid: 4242 });
    injectIntoHost.mockResolvedValue(false);
    const b = body(await call({ focus: 'x' })) as { note: string; hostSock?: string; hostPid?: number };
    expect(b.hostSock).toBe('/tmp/sock');
    expect(b.hostPid).toBe(4242);
    expect(b.note).toContain('/tmp/sock');
    expect(b.note).toContain('4242');
  });
});

// EI-22131227584499489: `focus`/`continueNote` are free text the CALLING owner
// writes itself — verify the integrity caution is actually wired into the
// injected first prompt (carry-brief.test.ts covers unverifiedFocusRefs /
// renderFocusIntegrityWarning as pure functions; this covers the WIRING).
describe('session:request-compaction — focus-integrity warning wired into the note (EI-22131227584499489)', () => {
  // checkpoint is non-null so the P-016 flush-enforcement gate (above) does not
  // itself refuse the cut before the focus-integrity branch ever runs.
  const briefWithHeld = {
    ownerId: 'su-caller',
    loop: null,
    heldItems: [{ id: 'WI-3319', title: null, body: null, harness: 'papercusp', checkpoint: 'in progress' }],
    walls: [],
    facts: [],
    awaits: [],
    fleet: null,
  };
  const reviewTargetId = 'WI-6554700010010741';
  const briefWithReviewTarget = {
    ...briefWithHeld,
    deferredItems: [
      {
        id: reviewTargetId,
        title: 'Acceptance review-target reservation',
        body: null,
        harness: 'papercusp',
        kind: 'task',
        source: 'commented' as const,
      },
    ],
  };

  it('prepends a ⚠ FOCUS INTEGRITY caution to the injected note when focus names a WI/carry-hash the owner does not hold', async () => {
    findLiveHost.mockReturnValue(carryHost);
    buildCarryBrief.mockResolvedValue(briefWithHeld);
    await call({
      focus: "Resume the gate-red repair. Read the loop carry-note (e5729a1f033a) and WI-2140920's checkpoint.",
    });
    const msg = injected();
    expect(msg.data).toContain('⚠ FOCUS INTEGRITY');
    expect(msg.data).toContain('WI-2140920');
    expect(msg.data).toContain('carry-note e5729a1f033a');
  });

  it('preserves focus on a review target this session commented on', async () => {
    findLiveHost.mockReturnValue(carryHost);
    buildCarryBrief.mockResolvedValue(briefWithReviewTarget);
    const focus = `Continue grading ${reviewTargetId}.`;
    await call({ focus }, { role: 'judge' });
    const msg = injected();
    expect(msg.data).toContain(focus);
    expect(msg.data).not.toContain('FOCUS INTEGRITY');
  });

  it('removes a foreign ref from the executable resume directive when the recipient has no lane', async () => {
    findLiveHost.mockReturnValue(carryHost);
    buildCarryBrief.mockResolvedValue(emptyBrief);
    await call({
      focus: 'Continue P-003 (WI-10000572) on the peer portal performance lane.',
    });
    const note = injected().data.replace(ENVELOPE_LINE, '');
    expect(note).toContain('⚠ FOCUS INTEGRITY');
    expect(note).toContain('WI-10000572');
    expect(note).toContain('do not infer or claim a lane');
    expect(note).not.toMatch(/Then resume:[\s\S]*WI-10000572/);
  });

  it("stays SILENT when focus only names the owner's own held item (no false positive)", async () => {
    findLiveHost.mockReturnValue(carryHost);
    buildCarryBrief.mockResolvedValue(briefWithHeld);
    await call({ focus: 'resume WI-3319' });
    const msg = injected();
    expect(msg.data).not.toContain('FOCUS INTEGRITY');
  });

  it('is not evaluated when an OPEN OWNER MESSAGE supplies firstPrompt directly (the free-text branch never runs)', async () => {
    findLiveHost.mockReturnValue(carryHost);
    buildCarryBrief.mockResolvedValue(briefWithHeld);
    buildOwnerRespawnLaunchSpec.mockResolvedValue({
      ...closedSpec,
      firstPrompt: 'resume WI-9999999 per the owner’s own words',
      openOwnerQuestion: { crossesOpenOwnerMessage: true },
    });
    const b = body(await call({ focus: 'irrelevant' }));
    const msg = injected();
    expect(msg.data).not.toContain('FOCUS INTEGRITY');
    expect(b.firstPromptSource).toBe('open-owner-message');
  });
});

/**
 * EI-18676518990229124: a successful carry-respawn must mark the owner
 * "respawn expected" so activity:report's SessionEnd/Stop P-002 fast path
 * skips force-releasing its work-item leases (the killed child's SessionEnd
 * is a scheduled same-owner continuation, not a death). A FAILED respawn
 * (nothing actually queued) must NOT mark the owner — the P-001 scheduled
 * backstop remains the correct recovery for that case, unchanged.
 */
describe('session:request-compaction — carry-respawn marker (EI-18676518990229124)', () => {
  it('a successful respawn marks the owner as respawn-expected', async () => {
    findLiveHost.mockReturnValue(carryHost);
    injectIntoHost.mockResolvedValue(true);
    const b = body(await call({ focus: 'x' }));
    expect(b.ok).toBe(true);
    expect(await consumeRespawnExpected('su-caller')).toBe(true);
  });

  it('a failed socket write does NOT mark the owner', async () => {
    findLiveHost.mockReturnValue(carryHost);
    injectIntoHost.mockResolvedValue(false);
    await call({ focus: 'x' });
    expect(await consumeRespawnExpected('su-caller')).toBe(false);
  });

  it('a refused cut (host predates carry-respawn) never marks the owner', async () => {
    findLiveHost.mockReturnValue(staleHost);
    await call({ focus: 'x' });
    expect(await consumeRespawnExpected('su-caller')).toBe(false);
  });

  it('a failed host checkpoint never marks the owner (nothing was queued)', async () => {
    autoCheckpointStaleHeldItems.mockRejectedValueOnce(new Error('snapshot unavailable'));
    findLiveHost.mockReturnValue(carryHost);
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      heldItems: [{ id: 'WI-500', title: 'unflushed', body: null, harness: 'papercup', checkpoint: null }],
    });
    const b = body(await call({ focus: 'x' }));
    expect(b.error).toBe('flush-required');
    expect(await consumeRespawnExpected('su-caller')).toBe(false);
  });

  it.each([
    ['08006', '08006'],
    ['postgresql://fixture:never-emit@invalid/database', 'checkpoint-write-failed'],
  ])('reports safe host persistence diagnostics for code %s without queueing a cut', async (code, expectedCode) => {
    autoCheckpointStaleHeldItems.mockRejectedValueOnce(Object.assign(
      new Error('postgresql://fixture:never-emit@invalid/database'), { code },
    ));
    findLiveHost.mockReturnValue(carryHost);

    const b = body(await call({ focus: 'resume after a verified host save' }));

    expect(b).toMatchObject({
      ok: false, requested: false, error: 'flush-required',
      snapshotFailure: { phase: 'checkpoint-write', code: expectedCode, elapsedMs: expect.any(Number) },
    });
    expect(JSON.stringify(b)).not.toContain('never-emit');
    expect(injectIntoHost).not.toHaveBeenCalled();
    expect(buildOwnerRespawnLaunchSpec).not.toHaveBeenCalled();
    expect(savePendingCarryRespawn).not.toHaveBeenCalled();
    expect(bumpSessionEpoch).not.toHaveBeenCalled();
    expect(await consumeRespawnExpected('su-caller')).toBe(false);
  });

  it('carries a structured blocked checkpoint refusal through the tool response', async () => {
    autoCheckpointStaleHeldItems.mockRejectedValueOnce(Object.assign(
      new Error('internal checkpoint detail'), {
        code: 'checkpoint-write-blocked',
        workItemId: 'WI-500',
        blockedReason: 'write_refused',
      },
    ));
    findLiveHost.mockReturnValue(carryHost);

    const b = body(await call({ focus: 'resume after a blocked host save' }));

    expect(b).toMatchObject({
      ok: false,
      requested: false,
      error: 'flush-required',
      snapshotFailure: {
        phase: 'checkpoint-write',
        code: 'checkpoint-write-blocked',
        workItemId: 'WI-500',
        blockedReason: 'write_refused',
        elapsedMs: expect.any(Number),
      },
    });
    expect(JSON.stringify(b)).not.toContain('internal checkpoint detail');
    expect(injectIntoHost).not.toHaveBeenCalled();
    expect(await consumeRespawnExpected('su-caller')).toBe(false);
  });
});

/**
 * WI-36074 (context-injection P-023) — THE MEMORY EPOCH BOUNDARY, and the
 * recurrence guard for the class of bug that produced it.
 *
 * `bumpSessionEpoch` clears the per-session surfaced ledger so the memory pool
 * becomes injectable again after context is wiped. Its ONLY production reach
 * used to be compact-reprime, called from the session-recovery-brief route,
 * fetched ONLY by the SessionStart hook gated on `source === 'compact'` — a path
 * psu sessions can NEVER take, because they launch with DISABLE_COMPACT=1 +
 * DISABLE_AUTO_COMPACT=1 (the P-022 cutover). So the P-022 cutover moved the
 * compaction boundary to carry-respawn and orphaned the bump behind a retired
 * hook. Measured cost before the fix: last bump 6 days stale with ~29 agents
 * live, 99.3% of 57,154 ledger rows frozen at epoch 0, and injection dropping
 * 42.6% of everything it retrieved (D-071) — worst precisely ACROSS a respawn,
 * i.e. when context was gone and re-priming mattered most.
 *
 * THE CLASS, stated so this guard keeps earning its place: a boundary event was
 * re-implemented somewhere new and the bookkeeping that hung off the OLD boundary
 * was left pointing at a path that can no longer execute. Nothing failed loudly —
 * the bump simply never ran. These assertions pin the bump to the boundary that
 * actually fires today, so retiring/moving it again breaks a test instead of
 * silently starving every agent's recall for another six days.
 */
describe('session:request-compaction — memory epoch boundary (WI-36074)', () => {
  it('a successful respawn BUMPS the session epoch, keyed by ownerId', async () => {
    findLiveHost.mockReturnValue(carryHost);
    injectIntoHost.mockResolvedValue(true);
    const b = body(await call({ focus: 'x' }));
    expect(b.ok).toBe(true);
    // The key MUST be the ownerId: injection's warm-session dedup reads the
    // ledger under that same id (compact-reprime bumps and stamps under it too),
    // so a bump keyed on anything else clears a ledger nobody reads.
    expect(bumpSessionEpoch).toHaveBeenCalledWith(expect.anything(), 'su-caller');
  });

  it('a failed socket write does NOT bump (nothing was queued, context survives)', async () => {
    findLiveHost.mockReturnValue(carryHost);
    injectIntoHost.mockResolvedValue(false);
    await call({ focus: 'x' });
    expect(bumpSessionEpoch).not.toHaveBeenCalled();
  });

  it('a refused cut (host predates carry-respawn) never bumps', async () => {
    findLiveHost.mockReturnValue(staleHost);
    await call({ focus: 'x' });
    expect(bumpSessionEpoch).not.toHaveBeenCalled();
  });

  it('a failed host checkpoint never bumps (the session is left intact)', async () => {
    autoCheckpointStaleHeldItems.mockRejectedValueOnce(new Error('snapshot unavailable'));
    findLiveHost.mockReturnValue(carryHost);
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      heldItems: [{ id: 'WI-500', title: 'unflushed', body: null, harness: 'papercup', checkpoint: null }],
    });
    const b = body(await call({ focus: 'x' }));
    expect(b.error).toBe('flush-required');
    expect(bumpSessionEpoch).not.toHaveBeenCalled();
  });

  it('a bump failure NEVER fails the cut — memory hygiene is best-effort', async () => {
    findLiveHost.mockReturnValue(carryHost);
    injectIntoHost.mockResolvedValue(true);
    bumpSessionEpoch.mockRejectedValueOnce(new Error('pg down'));
    const b = body(await call({ focus: 'x' }));
    expect(b.ok).toBe(true);
    expect(b.respawn).not.toBe(false);
  });
});

/**
 * EI-19326331501849713 — the ack must state a QUEUED INTENT, never an outcome.
 *
 * `respawn: true` only ever meant "the socket write was accepted": the host still
 * has to win the busy gate (pty quiet) and can terminally DROP the carry. Reported
 * as a BOOLEAN it read as "a cut happened", so an agent told `true` stopped
 * managing its own context and waited for a successor that never arrived — the
 * exact failure this ticket was filed for.
 *
 * The note is pinned alongside the field because the note is the half an agent
 * actually acts on: a truthful field under wording that says "it resumes
 * automatically" would still produce the original bug.
 */
describe('session:request-compaction ack states a queued intent, not an outcome (EI-19326331501849713)', () => {
  it("reports respawn:'queued' — NOT true — when the inject is accepted", async () => {
    findLiveHost.mockReturnValue(carryHost);
    injectIntoHost.mockResolvedValue(true);
    const b = body(await call({ focus: 'x' }));
    expect(b.respawn).toBe('queued');
    expect(b.respawn).not.toBe(true);
    // Truthiness is the compatibility contract: every existing `if (res.respawn)`
    // must keep working, which is what makes this safe as a non-breaking change.
    expect(Boolean(b.respawn)).toBe(true);
  });

  it('still reports respawn:false when the inject fails', async () => {
    findLiveHost.mockReturnValue(carryHost);
    injectIntoHost.mockResolvedValue(false);
    const b = body(await call({ focus: 'x' }));
    expect(b.respawn).toBe(false);
  });

  it('the note names the precondition and the falsifier, and never asserts the cut happened', async () => {
    findLiveHost.mockReturnValue(carryHost);
    injectIntoHost.mockResolvedValue(true);
    const note = String(body(await call({ focus: 'x' })).note ?? '');
    expect(note).toContain('QUEUED');
    expect(note).toMatch(/not performed yet/i);
    expect(note).toMatch(/quiet/i); // the precondition the cut waits on
    expect(note).toMatch(/still here/i); // the falsifier the agent can check itself
    expect(note).toContain('host saved the mechanical checkpoint');
    // The retired wording asserted the outcome outright; if it ever returns, the
    // field being honest would not save the agent from acting on the prose.
    expect(note).not.toContain('it resumes automatically');
  });
});

/**
 * EI-7032 — session:request-compaction failed 40% of calls (130/321 in 24h), and
 * EVERY failure was the SAME thing: `focus: Too big <=600 chars`. That reject lands
 * at the worst moment (the agent is AT its context limit, which is WHY it called
 * this), forcing a wasted retry. A focus/continueNote is only a first-prompt HINT,
 * so an over-long one is now TRUNCATED to the cap instead of rejected — the
 * boundary always proceeds.
 */
describe('session:request-compaction over-long hint truncation (EI-7032)', () => {
  describe('truncateHint (unit)', () => {
    it('returns a within-cap string unchanged (same value)', () => {
      expect(truncateHint('short focus', 600)).toBe('short focus');
      const exact = 'x'.repeat(600);
      expect(truncateHint(exact, 600)).toBe(exact);
    });

    it('truncates an over-cap string to EXACTLY the cap, …-marked (never > cap)', () => {
      const long = 'x'.repeat(700);
      const out = truncateHint(long, 600);
      expect(out.length).toBe(600);
      expect(out.endsWith('…')).toBe(true);
      expect(out.startsWith('x'.repeat(599))).toBe(true);
    });

    it('handles the 1000-cap continueNote the same way', () => {
      expect(truncateHint('y'.repeat(1500), 1000).length).toBe(1000);
    });
  });

  describe('through the real tool schema (the 40% of calls that 400ed now parse)', () => {
    beforeEach(() => {
      findLiveHost.mockReturnValue(carryHost);
      injectIntoHost.mockResolvedValue(true);
    });

    it('a 900-char focus no longer 400s — it parses, truncated to ≤600, and the boundary proceeds', async () => {
      const long = 'preserve '.repeat(100); // 900 chars, well over 600
      expect(long.length).toBeGreaterThan(600);
      const b = body(await call({ focus: long }));
      expect(b).toMatchObject({ ok: true, requested: true });
      // The truncated (…-marked) focus rides inside the continuation-note first prompt.
      const note = injected().data.replace(ENVELOPE_LINE, '');
      expect(note).toContain('…');
      expect(note).not.toContain(long); // the untruncated 900-char original never rides
    });

    it('an over-long continueNote also parses instead of rejecting', async () => {
      const b = body(await call({ focus: 'x', continueNote: 'z'.repeat(1400) }));
      expect(b).toMatchObject({ ok: true });
      // The CALLER'S note is capped at 1000; the provenance envelope line and the
      // WI-2140968 address line both ride on top of it. The cap governs the
      // caller's hint — measuring it against the fixed machine-authored preamble
      // too would make every future safety line eat the caller's budget.
      const note = injected().data.replace(ENVELOPE_LINE, '').replace(ADDRESS_PREFIX, '');
      expect(note.length).toBeLessThanOrEqual(1000);
      expect(note.startsWith('z')).toBe(true);
    });

    it('a normal short focus rides untouched inside the first prompt', async () => {
      await call({ focus: 'finish the compaction test' });
      expect(injected().data).toContain('finish the compaction test');
    });
  });

  it('the published tools/list JSON schema still advertises focus maxLength 600 (clients keep aiming short)', () => {
    const json = z.toJSONSchema(tool.args as never) as {
      properties?: Record<string, { maxLength?: number; type?: string }>;
    };
    expect(json.properties?.focus?.type).toBe('string');
    expect(json.properties?.focus?.maxLength).toBe(600);
    expect(json.properties?.reason?.type).toBe('string');
    expect(json.properties?.reason?.maxLength).toBe(600);
    expect(json.properties?.continueNote?.maxLength).toBe(1000);
  });
});

/**
 * EI-8987 + P-016: session:request-compaction surfaces held work-items with a
 * missing/stale checkpoint (the highest-risk case: a cut-away transcript with
 * zero durable carry-note is a genuine state loss). P-016 turns the old warn into an
 * enforcement gate: unflushed state HOLDS the boundary ONCE (naming the flush);
 * a retry that still hasn't flushed gets a system-written mechanical fallback and
 * proceeds. The ladder never strands — the second encounter always proceeds — so it
 * respects the original "don't hard-refuse the tool an agent calls at its limit"
 * constraint while adding teeth. staleCheckpoints (the raw list) is still surfaced
 * on every proceed path. (The pure detection is covered in enforcement-gate.test.ts.)
 */
describe('session:request-compaction — P-016 flush-enforcement gate', () => {
  beforeEach(() => {
    findLiveHost.mockReturnValue(carryHost);
    injectIntoHost.mockResolvedValue(true);
  });

  it('no held items → staleCheckpoints empty, no warning text, the cut proceeds normally', async () => {
    buildCarryBrief.mockResolvedValue(emptyBrief);
    const b = body(await call({ focus: 'x' }));
    expect(b.staleCheckpoints).toEqual([]);
    expect(b.note).not.toContain('NO checkpoint');
    expect(b.ok).toBe(true);
  });

  it('terminal held item filtered by the gate re-check → no dead-end checkpoint warning', async () => {
    const id = 'EI-21934531959724440';
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      heldItems: [{ id, title: 'already done', body: null, harness: 'papercusp', checkpoint: null }],
    });
    getWorkItem.mockResolvedValue({ id, state: 'done' });

    const b = body(await call({ focus: 'x' }));

    // The snapshot writer re-reads live held items, excluding terminal rows.
    expect(autoCheckpointStaleHeldItems).toHaveBeenCalledWith(expect.objectContaining({ mode: 'respawn' }));
    expect(b).toMatchObject({ ok: true, requested: true, staleCheckpoints: [] });
    expect(b.note).not.toContain('flush-integrity');
    expect(injectIntoHost).toHaveBeenCalledTimes(1);
  });

  it('disabling the advisory ladder still saves the host checkpoint', async () => {
    const id = 'EI-21934531959724440';
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      heldItems: [{ id, title: 'gate disabled', body: null, harness: 'papercusp', checkpoint: null }],
    });
    process.env.PAPERCUSP_FLUSH_GATE = 'off';

    const b = body(await call({ focus: 'x' }));

    expect(b).toMatchObject({
      ok: true,
      requested: true,
      staleCheckpoints: [],
    });
    expect(b.note).not.toContain('flush-integrity');
    expect(injectIntoHost).toHaveBeenCalledTimes(1);
  });

  it('a held item WITH a checkpoint → not flagged', async () => {
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      heldItems: [{ id: 'WI-100', title: 'fix the thing', body: null, harness: 'papercup', checkpoint: 'in progress' }],
    });
    const b = body(await call({ focus: 'x' }));
    expect(b.staleCheckpoints).toEqual([]);
  });

  it('a held item with NO checkpoint is saved by the host on the first request', async () => {
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      heldItems: [{ id: 'WI-200', title: 'the risky one', body: null, harness: 'papercup', checkpoint: null }],
    });
    const b = body(await call({ focus: 'x' }));
    expect(b).toMatchObject({ ok: true, requested: true });
    expect(autoCheckpointStaleHeldItems).toHaveBeenCalledWith(expect.objectContaining({ mode: 'respawn', ownerId: 'su-caller' }));
    expect(injectIntoHost).toHaveBeenCalledTimes(1);
  });

  it('saves held items even when the loop checkpoint is fresh', async () => {
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      loop: {
        harness: 'papercusp',
        active: true,
        intervalSec: 60,
        carry: 'cold',
        carryNote: '## Next\nresume the current unit',
        carryNoteUpdatedAtMs: Date.now(),
      },
      heldItems: [{ id: 'EI-21557508946389368', title: 'held work', body: null, harness: 'papercup', checkpoint: null }],
    });
    const b = body(await call({ focus: 'x' }));
    expect(b).toMatchObject({ ok: true, requested: true });
    expect(autoCheckpointStaleHeldItems).toHaveBeenCalledTimes(1);
    expect(injectIntoHost).toHaveBeenCalledTimes(1);
  });

  it('the host snapshot includes fresh and missing held checkpoints on its first call', async () => {
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      heldItems: [
        { id: 'WI-1', title: 'has one', body: null, harness: 'papercup', checkpoint: 'ok' },
        { id: 'WI-2', title: 'missing', body: null, harness: 'papercup', checkpoint: null },
        { id: 'WI-3', title: 'also missing', body: null, harness: 'papercup', checkpoint: null },
      ],
    });
    const b = body(await call({ focus: 'x' }));
    expect(b).toMatchObject({ ok: true, requested: true });
    expect(autoCheckpointStaleHeldItems).toHaveBeenCalledWith(expect.objectContaining({ mode: 'respawn' }));
    expect(b.staleCheckpoints).toEqual([]);
  });

  it('an old checkpoint is saved without requiring another agent turn', async () => {
    const fortyMinAgo = Date.now() - 40 * 60_000;
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      heldItems: [
        { id: 'WI-300', title: 'long-running', body: null, harness: 'papercup', checkpoint: 'old flush', checkpointUpdatedAtMs: fortyMinAgo, lastProgressAtMs: Date.now() },
      ],
    });
    const b = body(await call({ focus: 'x' }));
    expect(b).toMatchObject({ ok: true, requested: true });
    expect(b.mechanicalFallback).toBeDefined();
  });

  it('P-016: a stale-checkpoint retry gets the bounded mechanical fallback instead of stranding compaction', async () => {
    const fortyMinAgo = Date.now() - 40 * 60_000;
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      heldItems: [
        {
          id: 'WI-303',
          title: 'long-running',
          body: null,
          harness: 'papercup',
          checkpoint: 'old flush',
          checkpointUpdatedAtMs: fortyMinAgo,
          lastProgressAtMs: Date.now(),
        },
      ],
    });

    const first = body(await call({ focus: 'x' }));
    expect(first).toMatchObject({ ok: true, requested: true });
    expect(first.mechanicalFallback).toBeDefined();

    // A later request repeats the host save without demanding a model flush.
    const second = body(await call({ focus: 'x' }));
    expect(second).toMatchObject({ ok: true, requested: true });
    expect(second.mechanicalFallback).toBeDefined();
    expect(second.staleCheckpoints).toEqual([]);
    expect(injectIntoHost).toHaveBeenCalledTimes(2);
  });

  it('P-003: a FRESH checkpoint (within the stale window) is not flagged', async () => {
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      heldItems: [
        { id: 'WI-301', title: 'fresh', body: null, harness: 'papercup', checkpoint: 'just flushed', checkpointUpdatedAtMs: Date.now() - 60_000 },
      ],
    });
    const b = body(await call({ focus: 'x' }));
    expect(b.staleCheckpoints).toEqual([]);
  });

  it('P-003: a checkpoint with NO write-instant meta (legacy/injected read) is never age-flagged', async () => {
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      heldItems: [{ id: 'WI-302', title: 'no meta', body: null, harness: 'papercup', checkpoint: 'state', checkpointUpdatedAtMs: null }],
    });
    const b = body(await call({ focus: 'x' }));
    expect(b.staleCheckpoints).toEqual([]);
  });

  it('missing and stale checkpoints are saved without pre-save warnings', async () => {
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      heldItems: [
        { id: 'WI-310', title: 'no note', body: null, harness: 'papercup', checkpoint: null },
        { id: 'WI-311', title: 'old note', body: null, harness: 'papercup', checkpoint: 'x', checkpointUpdatedAtMs: Date.now() - 20 * 60_000, lastProgressAtMs: Date.now() },
      ],
    });
    const b = body(await call({ focus: 'x' }));
    expect(b).toMatchObject({ ok: true, requested: true, staleCheckpoints: [] });
    expect(b.note).not.toContain('work_items:checkpoint');
  });

  it('an armed loop with NO carry-note gets a host fallback without a model flush round trip', async () => {
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      loop: { harness: 'papercusp', active: true, intervalSec: 60, carry: 'cold', carryNote: null, carryNoteUpdatedAtMs: null },
    });
    const b = body(await call({ focus: 'x' }));
    expect(b).toMatchObject({ ok: true, requested: true });
    expect(setLoopCarryNote).toHaveBeenCalledWith(
      { harness: 'papercusp', ownerId: 'su-caller' }, expect.stringContaining('auto-checkpoint mechanical'),
    );
    expect(injectIntoHost).toHaveBeenCalledTimes(1);
  });

  it('judge role gets the permitted address check and threads role into carry assembly', async () => {
    findLiveHost.mockReturnValue(carryHost);
    const b = body(await call({ focus: 'evaluate the candidate evidence' }, { role: 'judge' }));
    const msg = injected();

    expect(b.ok).toBe(true);
    expect(msg.data).toContain('assigned evaluation');
    expect(msg.data).toContain('evaluate the candidate evidence');
    expect(msg.data).toContain('host checks this address');
    expect(msg.data).not.toContain('coord:orient {}');
    expect(msg.data).not.toContain('self.ownerId');
    for (const forbidden of [
      'coord:declare-intent',
      'scheduler:get_next',
      'loop:status',
      'code:run',
      'sessions:search',
      'sessions:read',
    ]) {
      expect(msg.data).not.toContain(forbidden);
    }
    expect(buildOwnerRespawnLaunchSpec).toHaveBeenCalledWith(
      'su-caller',
      expect.objectContaining({ role: 'judge' }),
    );
  });

  it('an armed WARM loop with NO carry-note does not hold compaction', async () => {
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      loop: { harness: 'papercusp', active: true, intervalSec: 60, carry: 'warm', carryNote: null, carryNoteUpdatedAtMs: null },
    });
    const b = body(await call({ focus: 'x' }));
    expect(b.ok).toBe(true);
    expect(b.staleCheckpoints).toEqual([]);
    expect(injectIntoHost).toHaveBeenCalledTimes(1);
  });

  it('buildCarryBrief throwing → fails soft to an empty staleCheckpoints list, never blocks the cut', async () => {
    buildCarryBrief.mockRejectedValue(new Error('db unavailable'));
    const b = body(await call({ focus: 'x' }));
    expect(b.staleCheckpoints).toEqual([]);
    expect(b.ok).toBe(true);
    expect(injectIntoHost).toHaveBeenCalledTimes(1);
  });

  it('only ONE buildCarryBrief call per request (focus derivation + warning share the same brief)', async () => {
    buildCarryBrief.mockResolvedValue(emptyBrief);
    await call({}); // no focus → also drives the default-focus derivation
    expect(buildCarryBrief).toHaveBeenCalledTimes(1);
  });

  it('repeated requests save mechanically without the former refuse-once round trip', async () => {
    buildCarryBrief.mockResolvedValue({
      ...emptyBrief,
      heldItems: [{ id: 'WI-9', title: null, body: null, harness: null, checkpoint: null }],
    });
    const first = body(await call({ focus: 'x' }));
    expect(first).toMatchObject({ ok: true, requested: true });
    expect(injectIntoHost).toHaveBeenCalledTimes(1);

    // Retry with the SAME unflushed state → the system writes the fallback ITSELF and
    // the cut proceeds (never strands). The mechanicalFallback field is present
    // and staleCheckpoints is still surfaced.
    const second = body(await call({ focus: 'x' }));
    expect(second.ok).toBe(true);
    expect(second.requested).toBe(true);
    expect(second.mechanicalFallback).toBeDefined();
    expect(second.staleCheckpoints).toEqual([]);
    expect(injectIntoHost).toHaveBeenCalledTimes(2);
  });
});

/**
 * deterministic-context-carry-2026-07-14 P-010: the first-prompt rule at a
 * DELIBERATE boundary. An OPEN (unanswered) owner message is the successor's
 * first prompt — delivered VERBATIM through the spec (deriveLaunchPromptText),
 * never envelope-tagged and never quoted inside a machine note — and the warn
 * field/note surface it. Answered/absent → the tagged continuation note rides
 * instead. Warn-only: an open question never blocks the cut (a hard refuse
 * would strand — a retry cannot answer the owner for you).
 */
describe('session:request-compaction — P-010 open-owner-question first-prompt rule', () => {
  beforeEach(() => {
    findLiveHost.mockReturnValue(carryHost);
    injectIntoHost.mockResolvedValue(true);
    buildCarryBrief.mockResolvedValue(emptyBrief);
  });

  it('an OPEN owner message → it IS the successor first prompt (verbatim, un-enveloped), warn surfaced, cut STILL queued', async () => {
    buildOwnerRespawnLaunchSpec.mockResolvedValue({
      ...closedSpec,
      firstPrompt: 'ship the release when green',
      openOwnerQuestion: { crossesOpenOwnerMessage: true },
    });
    const b = body(await call({ focus: 'x' }));
    expect(b.openOwnerQuestion).toBe(true);
    expect(b.openOwnerMessageQuestion).toBe(true);
    expect(b.openOwnerAskCount).toBe(0);
    expect(b.firstPromptSource).toBe('open-owner-message');
    expect(b.note).toContain('open-owner-question');
    // Warn-only: the cut was NOT blocked.
    expect(b.ok).toBe(true);
    expect(b.requested).toBe(true);
    const msg = injected();
    expect(msg.data).toBe('ship the release when green'); // verbatim spec prompt, no envelope
    expect(msg.data).not.toMatch(ENVELOPE_LINE);
  });

  it('no open owner message → the tagged continuation note rides and no warn appears', async () => {
    buildOwnerRespawnLaunchSpec.mockResolvedValue(closedSpec);
    const b = body(await call({ focus: 'x' }));
    expect(b.openOwnerQuestion).toBe(false);
    expect(b.openOwnerMessageQuestion).toBe(false);
    expect(b.openOwnerAskCount).toBe(0);
    expect(b.firstPromptSource).toBe('continuation-note');
    expect(b.note).not.toContain('open-owner-question');
    expect(injected().data).toMatch(ENVELOPE_LINE);
  });

  it('an open coord:ask-owner ledger row → report true immediately after the ask opens', async () => {
    buildOwnerRespawnLaunchSpec.mockResolvedValue({
      ...closedSpec,
      // The live builder derives this from buildCarryDoc. Keeping the fixture
      // at the spec boundary proves request-compaction does not fall back to
      // the transcript-only P-010 predicate.
      openOwnerAskCount: 1,
    });
    const b = body(await call({ focus: 'x' }));
    expect(b.openOwnerQuestion).toBe(true);
    expect(b.openOwnerMessageQuestion).toBe(false);
    expect(b.openOwnerAskCount).toBe(1);
    expect(b.note).toContain('open-owner-question');
    expect(b.note).toContain('1 owner ask(s) remain OPEN');
    expect(b.ok).toBe(true);
    expect(b.requested).toBe(true);
  });

  // WI-10002032 follow-up. The gate distinguishes basis 'known-unanswered' (an owner
  // message really is open) from 'history-uncertain' (the tail reader's byte window
  // truncated the history, so answered/no-demand is UNKNOWN). The note used to discard
  // `basis` and emit the known-unanswered wording for BOTH — positively asserting an
  // owner message existed on agent-launched sessions that have no owner speech at all.
  // Two arms on purpose: each kills a DIFFERENT assertion, so neither is vacuous.
  it("basis='history-uncertain' → reports UNKNOWN and must NOT assert an owner message exists", async () => {
    buildOwnerRespawnLaunchSpec.mockResolvedValue({
      ...closedSpec,
      openOwnerQuestion: {
        crossesOpenOwnerMessage: true,
        basis: 'history-uncertain',
        historyStatus: 'truncated',
      },
    });
    const b = body(await call({ focus: 'x' }));
    // The signal is still raised — this fix corrects the WORDING, it does not suppress.
    expect(b.openOwnerQuestion).toBe(true);
    expect(b.openOwnerMessageQuestion).toBe(true);
    expect(b.openOwnerAskCount).toBe(0);
    expect(b.note).toContain('open-owner-question');
    expect(b.note).toContain('TRUNCATED');
    expect(b.note).toContain('UNKNOWN');
    expect(b.note).toContain('NOT a finding that an owner message exists');
    // The load-bearing silence: never claim the owner's message is unanswered when we
    // only know the history was bounded.
    expect(b.note).not.toContain('final message looks UNANSWERED');
    // Warn-only, exactly as the known-unanswered arm.
    expect(b.ok).toBe(true);
    expect(b.requested).toBe(true);
  });

  it("basis='known-unanswered' → keeps the direct wording (the fix must not over-soften)", async () => {
    buildOwnerRespawnLaunchSpec.mockResolvedValue({
      ...closedSpec,
      openOwnerQuestion: { crossesOpenOwnerMessage: true, basis: 'known-unanswered' },
    });
    const b = body(await call({ focus: 'x' }));
    expect(b.openOwnerQuestion).toBe(true);
    expect(b.openOwnerMessageQuestion).toBe(true);
    expect(b.openOwnerAskCount).toBe(0);
    expect(b.note).toContain('final message looks UNANSWERED');
    expect(b.note).not.toContain('NOT a finding that an owner message exists');
    expect(b.ok).toBe(true);
  });
});

/**
 * WI-5936 / EI-16611 — the cut SIGTERMs native background Bash jobs.
 *
 * The module's selection rules are unit-tested in native-bg-task-ledger.test.ts.
 * What is proven HERE is the WIRE: that the tool actually reads the ledger and
 * that the result reaches the agent-facing `note`. That deserves its own test
 * because a broken wire fails SILENTLY — every unit test still passes, the tool
 * still returns ok, and the warning simply never appears, which is
 * indistinguishable from "you had no live jobs".
 *
 * Liveness here is a REAL open fd (the same signal the hook's own advisory
 * uses), not a mocked predicate, so this also pins the seconds-vs-ms agreement
 * with the python writer end to end.
 */
describe('session:request-compaction — native bg task warning (WI-5936)', () => {
  let bgHome = '';
  const origPapercuspHome = process.env.PAPERCUSP_HOME;

  beforeEach(() => {
    findLiveHost.mockReturnValue(carryHost);
    injectIntoHost.mockResolvedValue(true);
    buildCarryBrief.mockResolvedValue(emptyBrief);
    bgHome = mkdtempSync(join(tmpdir(), 'reqcompact-bg-'));
    mkdirSync(join(bgHome, '.papercusp', 'tracking'), { recursive: true });
    // The ledger honors this isolation pin before the user's home. Changing
    // HOME alone leaves a workspace-scoped runner reading its real ledger.
    process.env.PAPERCUSP_HOME = join(bgHome, '.papercusp');
  });

  afterEach(() => {
    if (origPapercuspHome === undefined) delete process.env.PAPERCUSP_HOME;
    else process.env.PAPERCUSP_HOME = origPapercuspHome;
    rmSync(bgHome, { recursive: true, force: true });
  });

  /** Holds `path` open for writing until killed. `exec` REPLACES the shell so
   *  the fd dies with kill() instead of leaking to an orphaned child. */
  const holdOpen = (path: string) =>
    spawn('bash', ['-c', `exec 3>'${path}'; exec sleep 30 >&3`], { stdio: 'ignore' });

  const writeLedger = (logPath: string, sid: string | null) =>
    writeFileSync(
      join(bgHome, '.papercusp', 'tracking', 'bg-output-tracking.json'),
      JSON.stringify({
        [logPath]: {
          // SECONDS — the shape the python hook writes.
          started_at: Date.now() / 1000 - 90,
          ...(sid ? { sid } : {}),
        },
      }),
    );

  it('warns, naming the job, when one of THIS session’s bg jobs is still running', async () => {
    const log = join(bgHome, 'running.log');
    const holder = holdOpen(log);
    try {
      await new Promise((r) => setTimeout(r, 300));
      writeLedger(log, 'su-caller');
      const b = body(await call({ focus: 'x' }));
      expect(b.ok).toBe(true); // WARNS — never refuses the cut
      expect(b.note).toContain('native-bg-tasks');
      expect(b.note).toContain(log);
      expect(b.nativeBgTasks.live).toHaveLength(1);
    } finally {
      holder.kill();
    }
  });

  it('stays silent — and omits the field — when the job has already finished', async () => {
    const log = join(bgHome, 'finished.log');
    writeFileSync(log, 'done\n');
    writeLedger(log, 'su-caller'); // recorded, but nothing holds it open
    const b = body(await call({ focus: 'x' }));
    expect(b.note).not.toContain('native-bg-tasks');
    expect(b.nativeBgTasks).toBeUndefined();
  });

  it("ignores another session's live job — this cut cannot kill it", async () => {
    const log = join(bgHome, 'peer.log');
    const holder = holdOpen(log);
    try {
      await new Promise((r) => setTimeout(r, 300));
      writeLedger(log, 'su-some-other-agent');
      const b = body(await call({ focus: 'x' }));
      expect(b.note).not.toContain('native-bg-tasks');
      expect(b.nativeBgTasks).toBeUndefined();
    } finally {
      holder.kill();
    }
  });

  it('no ledger at all → no warning, and the cut proceeds untouched', async () => {
    const b = body(await call({ focus: 'x' }));
    expect(b.ok).toBe(true);
    expect(b.note).not.toContain('native-bg-tasks');
  });
});
