/**
 * A blind gap reviewer's own scratch plans (verification-system-improvements-2026-10-10
 * D-050; WI-6554700010018458).
 *
 * When the reviewed plan ships plan-tool behaviour, the reviewer has to exercise those
 * tools to review it. The session confinement (denyPlansOutside) lets it author plans
 * whose slug starts with a prefix minted for that reviewer alone, and never the reviewed
 * plan. This module mints the prefix and clears the scratch plans once the review is
 * posted (D-050 (5)), so they do not accumulate in the plan store.
 *
 * Kept apart from blind-reviewer-mint.ts so the plans:blind-review handler can import the
 * cleanup without loading the launch path.
 */
import { randomUUID } from 'node:crypto';
import { validScratchPlanBoundary, type SessionToolConfinement } from './capability-envelope/session-confinement';

/**
 * D-050 (4): one fresh prefix per reviewer. The decision names the reviewer's owner short
 * id, but launch-agent pins that id only after the confinement is built, so the mint
 * draws its own id. It serves the same purpose: no other session's slug can match it.
 */
export function blindReviewScratchPrefix(id: string = randomUUID().replaceAll('-', '').slice(0, 12)): string {
  return `blind-review-scratch-${id}-`;
}

export interface ArchiveScratchPlansDeps {
  /** The poster's stored confinement; injected in tests. */
  readConfinement?: (ownerId: string, workspaceId: string) => Promise<SessionToolConfinement | null>;
  /** Archives every live plan whose slug starts with `prefix`; returns how many. */
  archiveByPrefix?: (workspaceId: string, prefix: string) => Promise<number>;
}

/** Shared host cleanup for private reviewer and benchmark draft namespaces. */
export async function archiveScratchPlansByPrefix(workspaceId: string, prefix: string): Promise<number> {
  if (!workspaceId.trim() || !validScratchPlanBoundary({ scratchPrefix: prefix,
    reviewedSlug: 'scratch-cleanup', harness: 'scratch-cleanup' }))
    throw new Error('Scratch plan cleanup requires an exact private namespace.');
  const { withWorkspace } = await import('@papercusp/db-org');
  const rows = await withWorkspace(workspaceId, tx => tx<{ plan_slug: string }[]>`
    UPDATE harness_shared.harness_plans
       SET archived = true, op_updated_at = ${new Date().toISOString()}
     WHERE workspace_id = ${workspaceId} AND archived = false AND starts_with(plan_slug, ${prefix})
    RETURNING plan_slug`);
  return rows?.length ?? 0;
}

/**
 * Archive the poster's scratch plans. It reads the POSTER's own stored boundary, so a
 * caller can only archive plans under its own minted prefix, and the prefix pattern
 * (validScratchPlanBoundary) means the match can never reach an ordinary plan. Archiving
 * is reversible (plans:set-archived). Returns null when the poster has no boundary.
 */
export async function archiveBlindReviewScratchPlans(
  input: { workspaceId: string; ownerId: string },
  deps: ArchiveScratchPlansDeps = {},
): Promise<{ prefix: string; archived: number } | null> {
  const read = deps.readConfinement ?? (async (ownerId: string, workspaceId: string) =>
    (await import('./capability-envelope/session-confinement-store')).readSessionConfinement(ownerId, workspaceId));
  const boundary = (await read(input.ownerId, input.workspaceId))?.denyPlansOutside;
  if (!boundary || !validScratchPlanBoundary(boundary)) return null;
  const archived = await (deps.archiveByPrefix ?? archiveScratchPlansByPrefix)(input.workspaceId, boundary.scratchPrefix);
  return { prefix: boundary.scratchPrefix, archived };
}
