/**
 * Batch admission for a cleanup campaign (code-cleanup-campaigns-2026-10-26 P-007, R-7).
 *
 * A campaign batch starts only when:
 *  - no other agent holds a live lock on any of its target files,
 *  - no other agent has an edit_attribution_ledger row on any of them inside the recency window
 *    (default 30 minutes), and
 *  - the campaign is below its concurrency cap (default 2 running batches).
 * An admitted batch's files are locked by the batch for its duration; `batchEditViolations`
 * names every edit made outside that lock, so a runner can refuse to land them.
 *
 * The decision is pure over injected readers (`AdmissionDeps`), so it is unit-testable;
 * `nativeAdmissionReaders` binds the readers to the SU lock store and the edit ledger. Lock
 * acquisition stays injected: the campaign runner is a fleet agent that locks through
 * `locks:acquire`, and a host caller may use the store directly.
 */
import { getOrgPg } from '@papercusp/db-org';
import { getTxPool, readQueue } from '../agent-tools/locks/su-lock-store';

export const DEFAULT_CAMPAIGN_CONCURRENCY_CAP = 2;
export const DEFAULT_RECENT_EDIT_WINDOW_MS = 30 * 60 * 1000;

export interface AdmissionBatch { id: string; targetFiles: readonly string[] }
export interface PeerLock { path: string; owner: string; expiresAt: Date | null }
export interface PeerEdit { path: string; owner: string; at: Date }

export interface AdmissionInput {
  campaignId: string;
  /** The runner's own owner id: its own locks and edits never block it. */
  self: string;
  /** Candidate batches, best first. */
  candidates: readonly AdmissionBatch[];
  /** Ids of this campaign's batches that are running now. */
  running: readonly string[];
  cap?: number;
  recentEditWindowMs?: number;
  now: Date;
}

export type AcquireOutcome = { ok: true; lockId: string } | { ok: false; detail: string };

export interface AdmissionDeps {
  /** Live locks on any of `paths`, any holder. */
  liveLocks(paths: readonly string[]): Promise<readonly PeerLock[]>;
  /** Ledger edits on any of `paths` at or after `since`, any editor. */
  editsSince(paths: readonly string[], since: Date): Promise<readonly PeerEdit[]>;
  /** Lock every target file of `batch` for the batch's duration. */
  acquire(batch: AdmissionBatch, intent: string): Promise<AcquireOutcome>;
}

export type AdmissionSkipReason =
  | 'cap-reached' | 'already-running' | 'no-target-files' | 'overlaps-admitted'
  | 'peer-lock' | 'peer-recent-edit' | 'lock-contended';

export interface AdmissionSkip { batchId: string; reason: AdmissionSkipReason; paths: string[]; detail: string }
export interface AdmittedBatch { batchId: string; lockId: string; targetFiles: string[] }
export interface AdmissionResult { admitted: AdmittedBatch[]; skipped: AdmissionSkip[] }

function positiveInt(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer, got ${value}`);
  return value;
}

/** Decide which candidate batches start this round, and lock the ones that do. */
export async function admitBatches(input: AdmissionInput, deps: AdmissionDeps): Promise<AdmissionResult> {
  const cap = positiveInt(input.cap ?? DEFAULT_CAMPAIGN_CONCURRENCY_CAP, 'cap');
  const windowMs = positiveInt(input.recentEditWindowMs ?? DEFAULT_RECENT_EDIT_WINDOW_MS, 'recentEditWindowMs');
  const running = new Set(input.running);
  const since = new Date(input.now.getTime() - windowMs);
  const allFiles = [...new Set(input.candidates.flatMap(b => b.targetFiles))];

  // One read per signal for the whole round, not one per batch.
  const [locks, edits] = allFiles.length
    ? await Promise.all([deps.liveLocks(allFiles), deps.editsSince(allFiles, since)])
    : [[], []];
  const peerLocked = new Map<string, PeerLock>();
  for (const l of locks) {
    if (l.owner === input.self) continue;
    if (l.expiresAt && l.expiresAt.getTime() <= input.now.getTime()) continue;
    peerLocked.set(l.path, l);
  }
  const peerEdited = new Map<string, PeerEdit>();
  for (const e of edits) {
    if (e.owner === input.self || e.at.getTime() < since.getTime()) continue;
    peerEdited.set(e.path, e);
  }

  const admitted: AdmittedBatch[] = [];
  const skipped: AdmissionSkip[] = [];
  const claimedThisRound = new Set<string>();
  let slots = cap - running.size;

  for (const batch of input.candidates) {
    const files = [...new Set(batch.targetFiles)];
    const skip = (reason: AdmissionSkipReason, paths: string[], detail: string) =>
      skipped.push({ batchId: batch.id, reason, paths, detail });
    if (running.has(batch.id)) { skip('already-running', [], 'the batch is already running'); continue; }
    if (slots <= 0) {
      skip('cap-reached', [], `campaign ${input.campaignId} already runs ${cap - slots} of its cap ${cap} batches`);
      continue;
    }
    if (!files.length) { skip('no-target-files', [], 'the batch names no target files to lock'); continue; }
    const overlap = files.filter(f => claimedThisRound.has(f));
    if (overlap.length) { skip('overlaps-admitted', overlap, 'another batch admitted this round targets these files'); continue; }
    const locked = files.filter(f => peerLocked.has(f));
    if (locked.length) {
      skip('peer-lock', locked, locked.map(f => `${f} locked by ${peerLocked.get(f)!.owner}`).join('; '));
      continue;
    }
    const edited = files.filter(f => peerEdited.has(f));
    if (edited.length) {
      skip('peer-recent-edit', edited, edited.map(f => {
        const e = peerEdited.get(f)!;
        return `${f} edited by ${e.owner} at ${e.at.toISOString()}`;
      }).join('; '));
      continue;
    }
    const outcome = await deps.acquire({ id: batch.id, targetFiles: files },
      `cleanup campaign ${input.campaignId} batch ${batch.id}`);
    if (!outcome.ok) { skip('lock-contended', files, outcome.detail); continue; }
    admitted.push({ batchId: batch.id, lockId: outcome.lockId, targetFiles: files });
    for (const f of files) claimedThisRound.add(f);
    slots -= 1;
  }
  return { admitted, skipped };
}

/** Edited files the batch did not lock: each one was edited outside the batch's own lock. */
export function batchEditViolations(batch: Pick<AdmittedBatch, 'targetFiles'>, editedFiles: readonly string[]): string[] {
  const locked = new Set(batch.targetFiles);
  return [...new Set(editedFiles)].filter(f => !locked.has(f));
}

/**
 * Readers bound to the SU lock store and the edit ledger. Locks are read across every
 * coordination domain (`coordinationDomain: null`): a lock's domain is the reader's checkout,
 * so a domain-scoped read from another checkout reports a held lock as absent; reading all
 * domains can only skip more, never admit a locked file.
 */
export function nativeAdmissionReaders(scope: { workspaceId: string }): Pick<AdmissionDeps, 'liveLocks' | 'editsSince'> {
  return {
    async liveLocks(paths) {
      if (!paths.length) return [];
      const q = await readQueue(getTxPool(), { coordinationDomain: null, paths: [...paths], includeWaiting: false });
      return q.active_locks.map(r => ({ path: r.path, owner: r.owner, expiresAt: r.expires_ts ?? null }));
    },
    async editsSince(paths, since) {
      if (!paths.length) return [];
      const { sql } = getOrgPg();
      const rows = await sql<{ agent_id: string; file: string; ts: Date }[]>`
        SELECT agent_id, file, ts FROM harness_shared.edit_attribution_ledger
         WHERE workspace_id = ${scope.workspaceId} AND file = ANY(${[...paths]}) AND ts >= ${since}`;
      return rows.map(r => ({ path: r.file, owner: r.agent_id, at: new Date(r.ts) }));
    },
  };
}
