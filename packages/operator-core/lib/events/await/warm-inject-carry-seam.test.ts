// @vitest-environment node
/**
 * warm-inject-carry-seam.test.ts — Phase 0 seam pin + carry regression
 * (bee-context-efficiency-2026-06-14 P-002 / WI-174).
 *
 * ## What this pins, and why
 * A long-lived "cup" runs each placed task as a headless `claude -p` turn that
 * EXITS on completion (line 387 PARKs a *live* session — only an exited one is
 * resumed). The Queen's next WARM-INJECT of a NEW task re-invokes the drained
 * bee through the wake-executor's resume seam:
 *
 *   executeWake → (exited, non-hive, claude) → Channel 2 "process gone → resume"
 *     → resumeCommandFor → `claude --resume <sessionId> -p …`
 *
 * `--resume <sessionId>` re-targets the SAME conversation, so claude reloads the
 * FULL prior-task transcript — the carry the plan measured: ~138K tokens/turn,
 * 97.4% of a long-lived bee's prompt is re-read accumulated prior-task transcript
 * (D-011). This is the exact `--resume` failure mode fresh-per-wake killed for the
 * Queen and that Phase 1 brings to bees.
 *
 * ## The exact seam (so Phase 1 edits the RIGHT line)
 * - `resumeCommandFor` (claude leg) — `wake-executor.ts` builds
 *   `['--resume', sessionId, '-p', …]`. The carry mechanism: the SAME id.
 * - `executeWake` routes an EXITED claude session there via the `resume-headless`
 *   channel, AFTER the hive-Queen fresh-wake fork and BEFORE Channel 2.
 * - Phase 1's fresh-context fork (D-018/D-021) inserts immediately after the
 *   hive-Queen fork (wake-executor.ts:407): a NEW-task warm-inject of a drained
 *   bee re-routes to a FRESH `--session-id` SPAWN (full bee-prompt re-assembly +
 *   the hydration tail) instead of `--resume`-ing the grown transcript. It is
 *   gated by `FLAGS.CUP_FRESH_CONTEXT_WARM_INJECT` — now DEFAULT ON (flipped 2026-06-23,
 *   WI-593, after live verification). The legacy `--resume` carry asserted below now runs
 *   ONLY for a wake WITHOUT the fresh-context marker (an ordinary resume), or as the
 *   fail-soft fallback when a fresh spawn is not admitted.
 *
 * The first describe blocks below use a NO-MARKER delivery, so they assert the
 * still-live `--resume` path that a non-warm-inject wake (or a not-admitted fork) takes —
 * unchanged by the flag. The "Phase 1 fork (flag ON)" suite asserts the marker-present
 * fork: the warm-inject-of-a-drained-bee case mints a fresh `--session-id` SPAWN and emits
 * NO `--resume <prior id>` carry. Within-task wakes (a live session — line 387 PARKs it)
 * never reach the fork and are untouched (D-005): the seam is only reached for an exited process.
 */
import { describe, expect, it, vi } from 'vitest';
import { executeWake, resumeCommandFor, type ExecuteWakeDeps } from './wake-executor';
import type { DeliveryWork, WakeOutcome } from './types';
import { FLAGS, FLAG_DEFAULTS } from '@papercusp/flags';

const BEE_OWNER = 's-bee-warm-1';
const BEE_SESSION_ID = 'cafef00d-0000-4000-8000-000000000001';
const BEE_CWD = '/repo/bee-task';

/**
 * A NEW-task warm-inject delivery to a DRAINED (process-exited) bee. place_batch
 * stamps `Queen warm-inject: <task.id>` on the wake (D-018); the wake text IS the
 * new task's delivery. The recorded pid is stale (the prior `-p` turn exited; the
 * adv_sessions row is NOT marked ended — the bee is a drained idle waiter), so
 * `deps.alive` returning false drives it down the resume seam.
 */
function warmInjectDelivery(over: Partial<DeliveryWork> = {}): DeliveryWork {
  return {
    id: 42,
    workspaceId: 'papercusp-workspace',
    awaitId: 7,
    subscriberId: BEE_OWNER,
    eventKey: `coord:inbox-wake:${BEE_OWNER}`,
    payload: null,
    summary: 'Queen warm-inject: WI-999',
    status: 'delivering',
    channel: null,
    attempts: 1,
    lastError: null,
    nextAttemptAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    deliveredAt: null,
    urgent: false,
    minSleepSec: null,
    coalescedCount: 1,
    source: null,
    note: 'next task placed; drain into it',
    wakeHandle: {
      kind: 'adv-session',
      advSessionId: 91,
      agent: 'claude',
      sessionId: BEE_SESSION_ID,
      ompThreadId: null,
      cwd: BEE_CWD,
      pid: 999111, // stale (prior headless -p turn exited); deps.alive → false
    },
    ...over,
  } as DeliveryWork;
}

/** Hermetic injected deps: the bee's prior `-p` process has EXITED (alive→false),
 *  the row is a non-hive claude session (label null → resume path, not the
 *  fresh-hive fork), no live psu-pty host. Mirrors the wake-executor.test.ts
 *  exited-claude cell; every OS-touching rung is injected deterministic. */
function deps(over: Partial<ExecuteWakeDeps> = {}): ExecuteWakeDeps {
  // The drained bee's adv-session row (the wake handle's advSessionId 91).
  const beeSessionRow = {
    id: 91,
    pid: 999111,
    endedAt: null,
    agent: 'claude',
    sessionId: BEE_SESSION_ID,
    coordOwnerId: BEE_OWNER,
    cwd: BEE_CWD,
    label: null, // not a hive operator → Channel 2 resume, not hive-fresh-wake
  };
  return {
    getSession: (async () => beeSessionRow) as never,
    // A dead pid makes executeWake elect the owner's CURRENT adv-session before it
    // resumes, so a delayed wake never resumes a dead predecessor. The production
    // lookup reads PG; keep the fixture hermetic by making the drained bee's own row
    // the owner's latest. The successor-row election is covered in wake-executor.test.ts.
    getLatestSessionForOwner: (async () => beeSessionRow) as never,
    findPty: (() => null) as never,
    write: (() => true) as never,
    spawnManagedPty: (() => ({ id: 'pty-x' })) as never,
    spawnDetached: vi.fn(() => 4321),
    presence: (async () => ({ stale: false, revoked: false })) as never,
    alive: () => false, // the headless -p turn for the prior task exited
    findPsuHost: (() => null) as never, // hermetic: no live psu-pty host
    injectPsuHost: (async () => true) as never,
    fireHiveWake: (async () => true) as never, // never reached (label null)
    // Channel 2 claims the adv row atomically before spawning; the production
    // claim writes to PG, so keep this fixture hermetic and model a WINNING
    // claim. The claim's losing/faulting paths are covered in
    // wake-executor-matrix.test.ts.
    claimResume: async () => true,
    // WI-10002854: the real accountant writes the ledger row and adv pid to PG.
    accountHeadlessResumeTurn: () => ({ pidRecorded: Promise.resolve(), finish: () => {} }),
    ...over,
  };
}

describe('resumeCommandFor — the carry mechanism (claude resumes the SAME session)', () => {
  it('re-targets the EXACT prior session id via --resume (continuous transcript) and mints NO fresh --session-id', () => {
    const r = resumeCommandFor(
      { agent: 'claude', sessionId: BEE_SESSION_ID, ompThreadId: null },
      'next task: WI-999',
    );
    expect(r).not.toBeNull();
    expect(r!.bin).toBe('claude');

    // --resume <sameId>: the conversation UUID is reused, so claude reloads the
    // full prior-task transcript — the carry (D-011, 97.4% of the prompt).
    const ri = r!.args.indexOf('--resume');
    expect(ri).toBeGreaterThan(-1);
    expect(r!.args[ri + 1]).toBe(BEE_SESSION_ID);
    expect(r!.args).toContain('-p'); // headless one-turn

    // NOT a fresh session: `--session-id <uuid>` is the fresh-spawn / fresh-per-wake
    // flag (mutually exclusive with --resume; see native-session-id-roundtrip).
    // Its ABSENCE is the carry invariant Phase 1 inverts.
    expect(r!.args).not.toContain('--session-id');
  });
});

describe('executeWake — warm-inject of a DRAINED bee re-invokes on the SAME session (the seam Phase 1 forks)', () => {
  it('exited claude bee + NEW-task warm-inject → resume-headless carrying --resume <prior sessionId>, no fresh --session-id', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(warmInjectDelivery(), deps({ spawnDetached }));

    // Routed through Channel 2 (process gone → resume), detached headless.
    expect(out).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'resume-headless' });

    const [bin, args, o] = spawnDetached.mock.calls[0] as unknown as [
      string,
      string[],
      { cwd: string; env: Record<string, string> },
    ];
    expect(bin).toBe('claude');

    // THE CARRY: the same conversation id → the full prior-task transcript reloads.
    const ri = args.indexOf('--resume');
    expect(ri).toBeGreaterThan(-1);
    expect(args[ri + 1]).toBe(BEE_SESSION_ID);
    expect(args).toContain('-p');

    // NOT a fresh session today — Phase 1 (flag ON) inverts exactly this line.
    expect(args).not.toContain('--session-id');

    // The carry rides the bee's STABLE coord identity (Phase 1 keeps the identity /
    // slot / claims, changes only the session) and the bee's working dir.
    expect(o.env.PAPERCUSP_SID).toBe(BEE_OWNER);
    expect(o.cwd).toBe(BEE_CWD);
  });

  it('a LIVE bee session is PARKED, never resumed (D-005: within-task wakes never reach the fork)', async () => {
    // pid alive + not one of our managed ptys → park; the resume seam (and the
    // Phase 1 fork after line 407) is only ever reached for an EXITED process, so
    // a mid-task wake can never trigger fresh-context re-invocation.
    const spawnDetached = vi.fn(() => 4321);
    const out = await executeWake(
      warmInjectDelivery(),
      deps({ alive: () => true, findPty: (() => null) as never, spawnDetached }),
    );
    expect(out.kind).toBe('park');
    expect(spawnDetached).not.toHaveBeenCalled();
  });
});

describe('Phase 1 gate — the fork is LIVE (default-ON, WI-593); the carry above is now the fail-soft/no-marker fallback', () => {
  it('FLAGS.CUP_FRESH_CONTEXT_WARM_INJECT defaults ON — a marker-carrying drained-bee warm-inject forks to a fresh spawn', () => {
    expect(FLAG_DEFAULTS[FLAGS.CUP_FRESH_CONTEXT_WARM_INJECT]).toBe(true);
    // Flipped ON 2026-06-23 after live verification (real executeWake + real getFlag →
    // channel fresh-context-warm-inject, never --resume). The `--resume` carry asserted in
    // the block above now runs ONLY for a wake WITHOUT the fresh-context marker (an ordinary
    // resume) or as the fail-soft fallback when a fresh spawn is not admitted — see the
    // "Phase 1 fork (flag ON)" suite below for the marker-present fork behavior.
  });
});

// ─────────────────────── Phase 1 (P-005): the fork, flag ON ───────────────────────
// The marker payload (freshContextWorkItem/Harness/Brief) is stamped on the wake by
// place_batch ONLY when the flag is on. With it present + the fork enabled, an exited
// bee's NEW-task warm-inject re-routes to a FRESH spawn — NO `--resume`, no carry.
// `deps.freshContext` is injected so no real spawn / flag-store / DB fires.
const MARKER = { freshContextWorkItem: 'WI-999', freshContextHarness: 'acme', freshContextBrief: 'do the thing' };

describe('Phase 1 fork (flag ON) — drained bee + NEW task → fresh spawn, the carry inverts', () => {
  it('re-routes to a fresh bee spawn (channel fresh-context-warm-inject) and NEVER --resumes', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const spawnFreshBee = vi.fn(async () => ({ ok: true, spawnId: 's-fresh-1' }));
    const releaseClaim = vi.fn(async () => {});
    const out = await executeWake(
      warmInjectDelivery({ payload: MARKER }),
      deps({ spawnDetached, freshContext: { enabled: async () => true, spawnFreshBee, releaseClaim } }),
    );

    expect(out).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'fresh-context-warm-inject' });
    // The fork fired with the marker's target, the bee's stable identity as lineage,
    // and its workspace — NOT the wake-executor's --resume path.
    expect(spawnFreshBee).toHaveBeenCalledWith({
      workspaceId: 'papercusp-workspace',
      harness: 'acme',
      workItemId: 'WI-999',
      brief: 'do the thing',
      parentSpawnId: BEE_OWNER,
    });
    // The exited bee's stale claim is freed so the fresh bee self-claims the item.
    expect(releaseClaim).toHaveBeenCalledWith('WI-999', 'acme');
    // THE INVARIANT INVERSION: no --resume carry — spawnDetached (the legacy resume) never ran.
    expect(spawnDetached).not.toHaveBeenCalled();
  });

  it('falls back to the legacy --resume when the fresh spawn is not admitted (fail-soft)', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const spawnFreshBee = vi.fn(async () => ({ ok: false, spawnId: null })); // e.g. over fleet cap
    const releaseClaim = vi.fn(async () => {});
    const out = await executeWake(
      warmInjectDelivery({ payload: MARKER }),
      deps({ spawnDetached, freshContext: { enabled: async () => true, spawnFreshBee, releaseClaim } }),
    );

    // The wake is never stranded: it drops through to the legacy resume seam.
    expect(out).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'resume-headless' });
    const [, args] = spawnDetached.mock.calls[0] as unknown as [string, string[], unknown];
    expect(args).toContain('--resume');
    // A failed spawn must NOT release the claim (the bee resumes, claim intact).
    expect(releaseClaim).not.toHaveBeenCalled();
  });

  it('does NOT fork an ordinary warm-inject (no marker payload) even with the fork enabled', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const spawnFreshBee = vi.fn(async () => ({ ok: true, spawnId: 's-x' }));
    const out = await executeWake(
      warmInjectDelivery(), // payload: null — no marker
      deps({ spawnDetached, freshContext: { enabled: async () => true, spawnFreshBee, releaseClaim: async () => {} } }),
    );
    expect(out).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'resume-headless' });
    expect(spawnFreshBee).not.toHaveBeenCalled();
  });

  it('defence-in-depth: a marker present but the fork disabled still --resumes (no fork)', async () => {
    const spawnDetached = vi.fn(() => 4321);
    const spawnFreshBee = vi.fn(async () => ({ ok: true, spawnId: 's-x' }));
    const out = await executeWake(
      warmInjectDelivery({ payload: MARKER }),
      deps({ spawnDetached, freshContext: { enabled: async () => false, spawnFreshBee, releaseClaim: async () => {} } }),
    );
    expect(out).toEqual<WakeOutcome>({ kind: 'delivered', channel: 'resume-headless' });
    expect(spawnFreshBee).not.toHaveBeenCalled();
  });
});
