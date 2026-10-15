/**
 * Carry reference re-check at DELIVERY — plan carry-recheck-and-governed-memory-2026-10-14, P-002
 * (read side; the write side and the diff/render primitives live in `carry-ref-stamps.ts`).
 *
 * The two automatic delivery paths call this module:
 *   - wake delivery (`events/await/wake-executor.ts`, the LIVE RE-CHECK block) re-checks the loop
 *     carry-note it just read, via {@link carryRefChangesForWake};
 *   - compaction recovery (`agent-tools/coordination/compaction-recovery.ts`, rendered by
 *     `carry-doc.ts`) re-checks the loop note AND every held work-item checkpoint the successor
 *     inherits, via {@link carryRefChangesForRecovery}.
 *
 * Both render one line per carried reference whose stored version stamp moved or no longer
 * resolves, and return null when nothing moved, so an unchanged carry prints nothing.
 *
 * Deterministic end to end (D-001: no model call on this path), bounded by the caps in
 * `carry-ref-stamps.ts`, and it never throws: a failure renders as an explicit could-not-re-check
 * line, never as the silence a reader would take for "unchanged".
 *
 * Only stamps the DELIVERED note still cites are re-checked ({@link stampsCitedBy}). The stamps
 * are read in a second query, and a checkpoint may be rewritten between the two reads; a stamp
 * for a reference the delivered text does not mention would report on something the reader
 * cannot see.
 */

import { carryRefChangesBlock, extractCarryRefDeps, type CarryRefResolver, type CarryRefSource } from './carry-ref-stamps';
import type { DepStamp } from './freshness/index';

/** Keep only the stamps whose reference the delivered note text still cites. */
export function stampsCitedBy(note: string | null | undefined, stamps: readonly DepStamp[]): DepStamp[] {
  if (!note || stamps.length === 0) return [];
  const cited = new Set(extractCarryRefDeps(note, { max: Number.MAX_SAFE_INTEGER }));
  return stamps.filter((stamp) => cited.has(stamp.dep));
}

/** Shape of the loop-note stamp reader (`getLoopCarryNoteRefStamps` in carry-note.ts). */
export type LoopRefStampReader = (ref: {
  harness: string;
  ownerId: string;
  workspaceId?: string;
}) => Promise<{ note: string | null; stamps: DepStamp[] }>;

/** Shape of the batched work-item stamp reader (`getWorkItemCheckpointRefStamps`). */
export type WorkItemRefStampReader = (
  refs: ReadonlyArray<{ harness: string | null; workItemId: string; workspaceId?: string }>,
) => Promise<Map<string, { note: string; stamps: DepStamp[] }>>;

async function defaultLoopRefStampReader(): Promise<LoopRefStampReader> {
  return (await import('./carry-note')).getLoopCarryNoteRefStamps;
}

async function defaultWorkItemRefStampReader(): Promise<WorkItemRefStampReader> {
  return (await import('./work-item-checkpoint')).getWorkItemCheckpointRefStamps;
}

async function resolutionWorkspace(workspaceId: string | null | undefined): Promise<string | null> {
  // `concreteWorkspaceIdOrNull`, NOT the ambient-falling-back resolver: the same rule as the write
  // side (setLoopCarryNoteWithPrior) — never answer under whatever workspace the host is pinned to.
  const { concreteWorkspaceIdOrNull } = await import('./workspace-registry');
  return concreteWorkspaceIdOrNull(workspaceId);
}

function couldNotRecheck(where: string, readAtIso: string, err: unknown): string {
  const why = err instanceof Error ? err.message : String(err);
  return (
    `🔗 CARRIED REFERENCES — COULD NOT RE-CHECK at ${where} (readAt=${readAtIso}): ${why.slice(0, 220)}. ` +
    `This is NOT evidence they are unchanged.`
  );
}

/**
 * Wake delivery: re-check the references cited by the loop note the LIVE RE-CHECK block just
 * read. When the delivered note cites nothing the stamp row is never read, so a reference-free
 * wake costs no extra store read.
 */
export async function carryRefChangesForWake(input: {
  ownerId: string;
  harness: string;
  workspaceId: string | null | undefined;
  /** The exact note text the delivery is about to show. */
  deliveredNote: string | null;
  readAtIso: string;
  readLoopRefStamps?: LoopRefStampReader;
  resolve?: CarryRefResolver;
  timeoutMs?: number;
}): Promise<string | null> {
  if (!input.deliveredNote || extractCarryRefDeps(input.deliveredNote, { max: 1 }).length === 0) return null;
  try {
    const read = input.readLoopRefStamps ?? (await defaultLoopRefStampReader());
    const { stamps } = await read({ harness: input.harness, ownerId: input.ownerId, workspaceId: input.workspaceId ?? undefined });
    const cited = stampsCitedBy(input.deliveredNote, stamps);
    if (cited.length === 0) return null;
    return await carryRefChangesBlock([{ label: 'loop note', stamps: cited }], {
      workspaceId: await resolutionWorkspace(input.workspaceId),
      harness: input.harness,
      where: 'wake delivery',
      readAtIso: input.readAtIso,
      resolve: input.resolve,
      timeoutMs: input.timeoutMs,
    });
  } catch (err) {
    return couldNotRecheck('wake delivery', input.readAtIso, err);
  }
}

/** A held item as the carry document already read it (id, canonical harness, stored checkpoint). */
export interface RecoveryHeldItem {
  id: string;
  harness: string | null;
  checkpoint: string | null;
}

/**
 * Compaction recovery: re-check the references cited by the loop carry-note (when a loop is
 * active) and by every held work-item checkpoint, in one batched resolution.
 */
export async function carryRefChangesForRecovery(input: {
  ownerId: string;
  workspaceId: string;
  sessionHarness: string | null;
  /** The held items the carry document already read; read here only when omitted. */
  heldItems?: readonly RecoveryHeldItem[];
  readAtIso: string;
  getLoopStatus?: (ownerId: string) => Promise<{ active: boolean; harnessSlug: string } | null>;
  readHeldWorkItems?: (ownerId: string, workspaceId: string) => Promise<readonly RecoveryHeldItem[]>;
  readLoopRefStamps?: LoopRefStampReader;
  readWorkItemRefStamps?: WorkItemRefStampReader;
  resolve?: CarryRefResolver;
  timeoutMs?: number;
}): Promise<string | null> {
  try {
    const getLoopStatus =
      input.getLoopStatus ?? (await import('./harness/routines/loop')).getLoopStatus;
    const readHeld =
      input.readHeldWorkItems ??
      (async (ownerId: string, workspaceId: string) =>
        (await import('./carry-brief')).readHeldWorkItems(ownerId, workspaceId, { limit: 20 }));
    const [loop, held] = await Promise.all([
      getLoopStatus(input.ownerId).catch(() => null),
      input.heldItems ? Promise.resolve(input.heldItems) : readHeld(input.ownerId, input.workspaceId).catch(() => []),
    ]);
    const sources: CarryRefSource[] = [];
    if (loop?.active && loop.harnessSlug) {
      const readLoop = input.readLoopRefStamps ?? (await defaultLoopRefStampReader());
      const { note, stamps } = await readLoop({ harness: loop.harnessSlug, ownerId: input.ownerId }).catch(() => ({
        note: null,
        stamps: [] as DepStamp[],
      }));
      const cited = stampsCitedBy(note, stamps);
      if (cited.length > 0) sources.push({ label: 'loop note', stamps: cited });
    }
    const citing = held.filter((item) => extractCarryRefDeps(item.checkpoint, { max: 1 }).length > 0);
    if (citing.length > 0) {
      const readItems = input.readWorkItemRefStamps ?? (await defaultWorkItemRefStampReader());
      const byId = await readItems(
        citing.map((item) => ({ harness: item.harness, workItemId: item.id, workspaceId: input.workspaceId })),
      ).catch(() => new Map<string, { note: string; stamps: DepStamp[] }>());
      for (const item of citing) {
        const stored = byId.get(item.id);
        // The successor is shown `item.checkpoint`; re-check only what THAT text cites.
        const cited = stored ? stampsCitedBy(item.checkpoint, stored.stamps) : [];
        if (cited.length > 0) sources.push({ label: `${item.id} checkpoint`, stamps: cited });
      }
    }
    if (sources.length === 0) return null;
    return await carryRefChangesBlock(sources, {
      workspaceId: await resolutionWorkspace(input.workspaceId),
      harness: input.sessionHarness,
      where: 'compaction recovery',
      readAtIso: input.readAtIso,
      resolve: input.resolve,
      timeoutMs: input.timeoutMs,
    });
  } catch (err) {
    return couldNotRecheck('compaction recovery', input.readAtIso, err);
  }
}
