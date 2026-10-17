/**
 * enforcement-gate-io — the IO wiring for the P-016 flush-enforcement gate
 * (pure ladder: ./enforcement-gate.ts; seams: session:request-compaction,
 * coord:handoff).
 *
 * Advisory contract: the gate can only ever ADD a bounded, single-bounce
 * refusal — it is bounded (FLUSH_GATE_BUDGET_MS), fail-OPEN (any error ⇒ `clear`),
 * env-disable-able (PAPERCUSP_FLUSH_GATE=off), and its `mechanical-fallback` verdict
 * always PROCEEDS after writing state. No path permanently blocks a compaction or a
 * handoff. A host-snapshot is mandatory persistence instead: it must settle
 * before the caller may queue a cut, and a failed save leaves the session intact.
 */
import { withBoundedTimeout } from './bounded-timeout';
import {
  decideFlushGate,
  detectFlushTripwires,
  renderFlushRefusal,
  type FlushGateVerdict,
  type FlushTripwire,
  type GateBoundary,
} from './enforcement-gate';
import type { CarryBrief } from './carry-brief';
import { getWorkItem } from './work-items';
import { ANY_FAMILY_TERMINAL_STATES } from './work-item-dispatch-states';
import { MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION } from './agent-tools/coordination/compaction-recovery';
import {
  REFUSAL_MARKER_TTL_MS,
  wasRecentlyRefused,
  markRefused,
  clearRefused,
  __resetRefusalMarkers,
} from './flush-refusal-marker';

export { REFUSAL_MARKER_TTL_MS, wasRecentlyRefused, markRefused, clearRefused, __resetRefusalMarkers };

/** Total budget for the whole gate (detect + fallback writes) — advisory work
 *  riding a seam that must not slow down or fail because of it. */
export const FLUSH_GATE_BUDGET_MS = 4_000;

/** Matches the structured refusal emitted by the host checkpoint writer. Keep
 * this local structural check deliberately independent of the turn-end module:
 * tests and the bundled sidecar mock that module at this seam, and an error
 * crossing a dynamic-import boundary must remain diagnosable by its wire shape.
 */
const CHECKPOINT_WRITE_BLOCKED_CODE = 'checkpoint-write-blocked' as const;

/** The effective bounded-timeout budget. Defaults to {@link FLUSH_GATE_BUDGET_MS};
 *  PAPERCUSP_FLUSH_GATE_BUDGET_MS (a positive integer ms) overrides it without a
 *  redeploy — mirroring {@link flushGateEnabled}. Two callers want a larger budget:
 *  (1) a load-storm host where a spuriously-fired 4s deadline would fail-OPEN a real
 *  agent's flush gate (the very WI-3818 stall this bound guards against), and (2) a
 *  unit test, where an event-loop-starved gate host once beat the 4s wall clock before
 *  the instant mocked inner work resolved — degrading to `clear` and emitting the
 *  bounded-timeout console.warn (a green-checkpoint flake, WI-5582). An invalid or
 *  non-positive value falls back to the default. */
export function flushGateBudgetMs(): number {
  const raw = (process.env.PAPERCUSP_FLUSH_GATE_BUDGET_MS ?? '').trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return FLUSH_GATE_BUDGET_MS;
}

/** How long an owner's per-boundary refusal marker stands. A retry within this
 *  window that STILL has tripwires is "the agent still won't flush" ⇒ mechanical
 *  fallback. Long enough to span a loop wake (60s) and an agent's own re-read;
 *  short enough that a much-later, unrelated boundary starts fresh at `refuse`. */
/** Is the gate enabled? Default ON; PAPERCUSP_FLUSH_GATE in {off,0,false,no}
 *  disables it (operational reversibility without a redeploy). */
export function flushGateEnabled(): boolean {
  const v = (process.env.PAPERCUSP_FLUSH_GATE ?? '').trim().toLowerCase();
  return !(v === 'off' || v === '0' || v === 'false' || v === 'no');
}

// ── The mechanical fallback writer ───────────────────────────────────────────

export interface FlushFallbackResult {
  /** Held work-item ids the system checkpointed (P-015 autoCheckpointStaleHeldItems). */
  checkpointedItems: string[];
  /** The armed loop's harness if the system wrote a mechanical carry-note for it. */
  loopCarryNoteWritten?: string;
}

/**
 * Write the mechanical fallback the P-016 ladder's `mechanical-fallback` verdict
 * calls for: for held-item tripwires, reuse the P-015 mechanical auto-checkpoint
 * (journal note + tool-log tail, agent prose preserved); for the armed-loop
 * tripwire, write a mechanical loop carry-note so a cold wake isn't blind. Bounded
 * + fail-soft per leg; returns what was actually written.
 */
export async function writeFlushFallback(input: {
  ownerId: string;
  workspaceId: string;
  sessionId: string;
  sinceIso: string;
  journalNote: string | null;
  tripwires: ReadonlyArray<FlushTripwire>;
  brief: CarryBrief | null;
  nowMs?: number;
  snapshotAllHeld?: boolean;
}): Promise<FlushFallbackResult> {
  const nowMs = input.nowMs ?? Date.now();
  const result: FlushFallbackResult = { checkpointedItems: [] };

  const hasHeldTripwire = input.tripwires.some(
    (t) => t.kind === 'missing-checkpoint' || t.kind === 'stale-checkpoint',
  );
  if (hasHeldTripwire || input.snapshotAllHeld) {
    try {
      const { autoCheckpointStaleHeldItems } = await import('./turn-end-tracking-io');
      const written = await autoCheckpointStaleHeldItems({
        ownerId: input.ownerId,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        sinceIso: input.sinceIso,
        journalNote: input.journalNote,
        nowMs,
        ...(input.snapshotAllHeld ? { mode: 'respawn' as const } : {}),
        // The advisory gate already built this carry snapshot to detect its
        // tripwires. Reuse its held rows; a mandatory respawn deliberately omits
        // this preview so autoCheckpointStaleHeldItems reads every held item.
        ...(!input.snapshotAllHeld && input.brief ? { heldItems: input.brief.heldItems } : {}),
      });
      result.checkpointedItems = written.map((w) => w.id);
    } catch (error) {
      if (input.snapshotAllHeld) throw error;
      /* fail-soft: the loop fallback + the refusal already gave the agent a chance */
    }
  }

  const loopTripwire = input.tripwires.find((t) => t.kind === 'armed-loop-no-carry-note');
  if (loopTripwire && input.brief?.loop) {
    try {
      const { setLoopCarryNote } = await import('./carry-note');
      const atIso = new Date(nowMs).toISOString();
      const note = input.journalNote?.trim()
        ? `## Next action\n${input.journalNote.trim()}`
        : `## Next action\n${MARKER_AWARE_POST_COMPACTION_RECOVERY_INSTRUCTION} Resume the armed loop.`;
      await setLoopCarryNote(
        { harness: input.brief.loop.harness, ownerId: input.ownerId },
        `⟦auto-checkpoint mechanical @${atIso}⟧ — the system wrote this because the loop was armed with no carry-note at a flush boundary; replace it with a real loop:checkpoint.\n\n${note}`,
      );
      result.loopCarryNoteWritten = input.brief.loop.harness;
    } catch (error) {
      if (input.snapshotAllHeld) throw error;
      /* fail-soft */
    }
  }
  return result;
}

// ── The gate entrypoint ──────────────────────────────────────────────────────

export interface FlushGateOutcome {
  verdict: FlushGateVerdict;
  tripwires: FlushTripwire[];
  /**
   * Held-item tripwire subjects that the live terminal-state re-check removed.
   * Omitted when the gate was disabled or its bounded wrapper failed open, so
   * callers can preserve their pre-gate advisory warnings in those cases.
   */
  droppedTerminalHeldItemIds?: string[];
  /** Present on `refuse` — the actionable flush instruction. */
  refusalText?: string;
  /** Present on `mechanical-fallback` — what the system wrote. */
  fallback?: FlushFallbackResult;
  /** Safe diagnostics for a failed mandatory save; never includes storage URLs or messages. */
  snapshotFailure?: {
    phase: 'checkpoint-write';
    /** A stable refusal code or a safe underlying storage code. */
    code: string;
    elapsedMs: number;
    /** Present for a locked-store refusal or an attributed item-write failure. */
    workItemId?: string;
    blockedReason?: string;
    checkpointStage?: 'load-writer' | 'read-held-items' | 'write-item';
    errorFingerprint?: string;
    completedWorkItemIds?: string[];
  };
}

/**
 * A deliberate boundary is agent-requested and uses the P-016 refuse-once
 * ladder. A forced boundary is runtime-owned: it must preserve the same
 * checkpoint/loop flush invariant, but cannot bounce the already-over-limit
 * session and wait for another model turn. It writes the bounded mechanical
 * fallback on the first tripwire encounter and then proceeds.
 */
export type FlushGateMode = 'deliberate' | 'forced' | 'host-snapshot';

/** Test/host seam for {@link resolveAgentToolCallsSinceNote} — mirrors the real
 *  `countAgentToolCallsInWindow`'s call shape so a unit test never opens a real
 *  Postgres connection to exercise the 'cold-successor-no-progress' tripwire. */
export type CountAgentToolCallsFn = (
  ownerId: string,
  sinceMs: number,
  untilMs: number,
) => Promise<number | null>;

/** Lazy: `./harness/routines/loop` is a large module this file otherwise never
 *  needs (mirrors `writeFlushFallback`'s dynamic imports of `turn-end-tracking-io`
 *  / `carry-note` above) — only paid when {@link resolveAgentToolCallsSinceNote}'s
 *  own gate actually matches (an active COLD loop with a note timestamp). */
const defaultCountAgentToolCallsInWindow: CountAgentToolCallsFn = async (ownerId, sinceMs, untilMs) => {
  const { countAgentToolCallsInWindow } = await import('./harness/routines/loop');
  return countAgentToolCallsInWindow(ownerId, sinceMs, untilMs);
};

/**
 * EI-21874665446367942: best-effort evidence for `detectFlushTripwires`'s
 * 'cold-successor-no-progress' tripwire — how many real agent tool calls this
 * owner made since its armed COLD loop's carry-note was last written.
 *
 * Mirrors `detectFlushTripwires`'s OWN gating condition (`loop.active &&
 * loop.carry === 'cold'`) so a warm loop, no loop, or a loop with no note
 * timestamp never pays for the extra query — it is cheap (an early `null`
 * return) on the overwhelming majority of calls. Returns `null` — never `0` —
 * on any non-match, missing timestamp, or query failure: `detectFlushTripwires`
 * treats `null` as "evidence unavailable" and will not fire the tripwire on it,
 * matching every other best-effort signal on this boundary (a transient query
 * error must never manufacture a spurious refusal).
 */
async function resolveAgentToolCallsSinceNote(
  brief: CarryBrief | null,
  ownerId: string,
  nowMs: number,
  countFn: CountAgentToolCallsFn = defaultCountAgentToolCallsInWindow,
): Promise<number | null> {
  const loop = brief?.loop;
  if (!loop || !loop.active || loop.carry !== 'cold' || loop.carryNoteUpdatedAtMs == null) return null;
  try {
    return await countFn(ownerId, loop.carryNoteUpdatedAtMs, nowMs);
  } catch (e) {
    console.warn('[enforcement-gate-io] resolveAgentToolCallsSinceNote failed (evidence unavailable):', e as Error);
    return null;
  }
}

/**
 * Run the flush gate at a boundary. Loads the caller's carry brief if one isn't
 * supplied, detects tripwires, and applies the {@link decideFlushGate} ladder:
 *   - clear  → proceed (also when the gate is env-disabled or errors — fail-open);
 *   - refuse → the caller must NOT perform the operation; marks the refusal marker;
 *   - mechanical-fallback → writes durable state, clears the marker, caller proceeds.
 * Never throws. Advisory modes fail open; a failed mandatory host save refuses.
 */
export async function runFlushGate(input: {
  boundary: GateBoundary;
  /** Defaults to the deliberate P-016 refuse-once ladder. */
  mode?: FlushGateMode;
  ownerId: string;
  workspaceId: string;
  sessionId: string;
  sinceIso: string;
  journalNote?: string | null;
  brief?: CarryBrief | null;
  nowMs?: number;
  /** Test seam: override the live `getWorkItem` re-check `dropTerminalHeldTripwires`
   *  uses to see past a stale-brief race. Production callers omit it. */
  getWorkItemStateFn?: GetWorkItemStateFn;
  /** Test seam: override {@link resolveAgentToolCallsSinceNote}'s real
   *  `countAgentToolCallsInWindow` call. Production callers omit it. */
  countAgentToolCallsFn?: CountAgentToolCallsFn;
}): Promise<FlushGateOutcome> {
  const clear: FlushGateOutcome = { verdict: 'clear', tripwires: [] };
  // A requested respawn is a host-owned save, including fresh items beyond the
  // carry preview. A failed save leaves the process intact; no model paperwork
  // or refuse-once dance can repair an unavailable host writer.
  if (input.mode === 'host-snapshot') {
    const startedAt = Date.now();
    try {
      // This is the cut's prerequisite, not an advisory sweep. Racing a running
      // save against the advisory timer returned a refusal while writes kept
      // going, and a retry started the same all-held save again. Await its real
      // receipt under the request's existing operation deadline instead.
      const fallback = await writeFlushFallback({ ...input, snapshotAllHeld: true,
        brief: input.brief ?? null, journalNote: input.journalNote ?? null,
        tripwires: detectFlushTripwires(input.brief ?? null, input.nowMs ?? Date.now(), null, input.boundary) });
      await clearRefused(input.boundary, input.ownerId);
      return { verdict: 'mechanical-fallback', tripwires: [], fallback };
    } catch (error) {
      const diagnostic = error && typeof error === 'object' ? error as {
        checkpointStage?: unknown; workItemId?: unknown; errorFingerprint?: unknown; completedWorkItemIds?: unknown;
      } : null;
      const attributed = diagnostic && ['load-writer', 'read-held-items', 'write-item'].includes(String(diagnostic.checkpointStage)) &&
        typeof diagnostic.errorFingerprint === 'string' && /^[a-f0-9]{16}$/.test(diagnostic.errorFingerprint) &&
        Array.isArray(diagnostic.completedWorkItemIds) && diagnostic.completedWorkItemIds.every((id) => typeof id === 'string')
        ? { checkpointStage: diagnostic.checkpointStage as 'load-writer' | 'read-held-items' | 'write-item',
            errorFingerprint: diagnostic.errorFingerprint, completedWorkItemIds: diagnostic.completedWorkItemIds as string[],
            ...(typeof diagnostic.workItemId === 'string' ? { workItemId: diagnostic.workItemId } : {}) }
        : null;
      const structured = error && typeof error === 'object' &&
        (error as { code?: unknown }).code === CHECKPOINT_WRITE_BLOCKED_CODE &&
        typeof (error as { workItemId?: unknown }).workItemId === 'string' &&
        typeof (error as { blockedReason?: unknown }).blockedReason === 'string'
        ? {
            workItemId: (error as { workItemId: string }).workItemId,
            blockedReason: (error as { blockedReason: string }).blockedReason,
          }
        : null;
      const rawCode = error && typeof error === 'object' && 'code' in error ? error.code : null;
      const code = structured
        ? CHECKPOINT_WRITE_BLOCKED_CODE
        : typeof rawCode === 'string' && /^[A-Z0-9_]{1,64}$/.test(rawCode)
          ? rawCode : 'checkpoint-write-failed';
      const snapshotFailure = {
        phase: 'checkpoint-write' as const,
        code,
        elapsedMs: Date.now() - startedAt,
        ...(attributed ?? {}),
        ...(structured ?? {}),
      };
      const refusalText = structured
        ? `The host checkpoint write was blocked for ${structured.workItemId} (${structured.blockedReason}). The session remains intact; inspect the concurrent checkpoint update before retrying.`
        : `The host checkpoint write failed (${code})${attributed ? ` at ${attributed.checkpointStage}${attributed.workItemId ? ` for ${attributed.workItemId}` : ''}; diagnostic ${attributed.errorFingerprint}` : ''}. The session remains intact; inspect host persistence before retrying.`;
      return { verdict: 'refuse', tripwires: [],
        refusalText,
        snapshotFailure };
    }
  }
  if (!flushGateEnabled()) return clear;
  const { value } = await withBoundedTimeout(runFlushGateInner(input), {
    fallback: clear,
    timeoutMs: flushGateBudgetMs(),
    label: `flush-gate:${input.boundary}`,
  });
  return value;
}

/**
 * EI-21861120616734083: `missing-checkpoint`/`stale-checkpoint` tripwires are
 * built from a SNAPSHOT brief — the subject can go terminal (another turn
 * completes it) between that read and the refusal reaching the agent. The
 * refusal then literally instructs `work_items:checkpoint { id, checkpoint }`
 * for an item `work_items:checkpoint` itself now correctly refuses with
 * `terminal_item` — an impossible instruction the agent has no way to satisfy,
 * repeatedly mistaken for a stuck compaction and re-filed (EI-21841856375687010,
 * EI-21845268673816123, EI-21828297910822386, EI-21867218655207954, this one).
 * The mechanical-fallback retry path already self-heals this (it re-reads held
 * items fresh, which naturally excludes anything now terminal) — this closes
 * the same race on the FIRST refusal too, so the confusing dead-end instruction
 * is never issued in the first place. Bounded, per-subject, fail-soft: a lookup
 * error keeps the tripwire (a spurious refusal is recoverable; silently
 * dropping a real unflushed item is not).
 */
/** Test/host seam for {@link dropTerminalHeldTripwires} — mirrors the injectable
 *  shape `readHeldWorkItems` already uses (`getWorkItemCheckpointFn`), so a unit
 *  test never has to hit a real DB for this bounded, best-effort re-check. */
export type GetWorkItemStateFn = (
  id: string,
  harness?: string,
) => Promise<{ state: string } | null>;

const defaultGetWorkItemState: GetWorkItemStateFn = (id, harness) => getWorkItem(id, harness);

interface TerminalHeldTripwireResult {
  tripwires: FlushTripwire[];
  droppedTerminalHeldItemIds: string[];
}

async function dropTerminalHeldTripwires(
  tripwires: readonly FlushTripwire[],
  heldItemHarness: ReadonlyMap<string, string | null>,
  getWorkItemStateFn: GetWorkItemStateFn,
): Promise<TerminalHeldTripwireResult> {
  const subjects = [
    ...new Set(
      tripwires
        .filter((t) => t.kind === 'missing-checkpoint' || t.kind === 'stale-checkpoint')
        .map((t) => t.subject),
    ),
  ];
  if (subjects.length === 0) {
    return { tripwires: [...tripwires], droppedTerminalHeldItemIds: [] };
  }
  const terminal = new Set<string>();
  await Promise.all(
    subjects.map(async (id) => {
      try {
        const item = await getWorkItemStateFn(id, heldItemHarness.get(id) ?? undefined);
        if (item && ANY_FAMILY_TERMINAL_STATES.includes(item.state)) terminal.add(id);
      } catch {
        /* fail-soft: keep the tripwire — see doc comment above */
      }
    }),
  );
  return {
    tripwires:
      terminal.size === 0
        ? [...tripwires]
        : tripwires.filter(
            (t) =>
              !(t.kind === 'missing-checkpoint' || t.kind === 'stale-checkpoint') ||
              !terminal.has(t.subject),
          ),
    // Keep the snapshot's subject order stable for callers and tests.
    droppedTerminalHeldItemIds: subjects.filter((id) => terminal.has(id)),
  };
}

async function runFlushGateInner(input: {
  boundary: GateBoundary;
  mode?: FlushGateMode;
  ownerId: string;
  workspaceId: string;
  sessionId: string;
  sinceIso: string;
  journalNote?: string | null;
  brief?: CarryBrief | null;
  nowMs?: number;
  getWorkItemStateFn?: GetWorkItemStateFn;
  countAgentToolCallsFn?: CountAgentToolCallsFn;
}): Promise<FlushGateOutcome> {
  const nowMs = input.nowMs ?? Date.now();
  // Only FETCH when the caller didn't provide a brief at all (undefined). An
  // explicit `null` means the caller already tried and the read failed (e.g. the
  // compaction seam's loadCarryBrief) — don't re-pay a failing round-trip.
  let brief: CarryBrief | null;
  if (input.brief === undefined) {
    try {
      const { buildCarryBrief } = await import('./carry-brief');
      brief = await buildCarryBrief(input.ownerId, { workspaceId: input.workspaceId });
    } catch {
      brief = null;
    }
  } else {
    brief = input.brief;
  }
  const agentToolCallsSinceNote = await resolveAgentToolCallsSinceNote(
    brief,
    input.ownerId,
    nowMs,
    input.countAgentToolCallsFn,
  );
  const rawTripwires = detectFlushTripwires(brief, nowMs, agentToolCallsSinceNote, input.boundary);
  const heldItemHarness = new Map<string, string | null>(
    (brief?.heldItems ?? []).map((h) => [h.id, h.harness ?? null]),
  );
  const terminalCheck =
    rawTripwires.length === 0
      ? { tripwires: rawTripwires, droppedTerminalHeldItemIds: [] }
      : await dropTerminalHeldTripwires(
          rawTripwires,
          heldItemHarness,
          input.getWorkItemStateFn ?? defaultGetWorkItemState,
        );
  const tripwires = terminalCheck.tripwires;
  const droppedTerminalHeldItemIds = terminalCheck.droppedTerminalHeldItemIds;

  // A watchdog-owned carry-respawn is already the emergency boundary: the
  // session is over its force threshold and may not get another model turn
  // before the host cuts it. Preserve the flush invariant without routing this
  // path through the deliberate refuse-once ladder. The deliberate
  // session:request-compaction caller leaves `mode` unset and remains bounded
  // by exactly the existing refuse → mechanical-fallback sequence.
  if (input.mode === 'forced' && tripwires.length > 0) {
    const fallback = await writeFlushFallback({
      ownerId: input.ownerId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      sinceIso: input.sinceIso,
      journalNote: input.journalNote ?? null,
      tripwires,
      brief,
      nowMs,
    });
    // A prior deliberate refusal may have left a marker behind. The forced
    // path has now crossed the boundary itself, so retire that marker just as
    // the normal mechanical-fallback rung does; never create one here.
    await clearRefused(input.boundary, input.ownerId);
    return { verdict: 'mechanical-fallback', tripwires, droppedTerminalHeldItemIds, fallback };
  }

  const alreadyRefused = await wasRecentlyRefused(input.boundary, input.ownerId, nowMs);
  const verdict = decideFlushGate({ tripwires, alreadyRefused });

  if (verdict === 'clear') {
    // A clean boundary retires any stale marker so the next real one starts fresh.
    if (alreadyRefused) await clearRefused(input.boundary, input.ownerId);
    return { verdict, tripwires, droppedTerminalHeldItemIds };
  }
  if (verdict === 'refuse') {
    await markRefused(input.boundary, input.ownerId, nowMs);
    return {
      verdict,
      tripwires,
      droppedTerminalHeldItemIds,
      refusalText: renderFlushRefusal(input.boundary, tripwires),
    };
  }
  // mechanical-fallback: write durable state, then let the caller proceed.
  const fallback = await writeFlushFallback({
    ownerId: input.ownerId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    sinceIso: input.sinceIso,
    journalNote: input.journalNote ?? null,
    tripwires,
    brief,
    nowMs,
  });
  await clearRefused(input.boundary, input.ownerId);
  return { verdict, tripwires, droppedTerminalHeldItemIds, fallback };
}
