/**
 * Blocker auto-clear (plan derived-status-not-hand-written-2026-10-12#P-011).
 *
 * A typed external blocker often waits on another work item: `WI-123`,
 * `work-item:done:WI-123`, or a qualified ref such as
 * `root-disk-headroom / WI-10004397`. When that work item reached a terminal
 * state nothing cleared the blocker, so the blocked item sat parked — out of
 * scheduler self-select and with nobody told — until a person noticed
 * (EI-24716620626191303). `work_items:set_blocker` now routes a PURE work-item
 * ref to a `work_item_deps` edge (WI-10005020), but a qualified ref still
 * lands as an externalBlockers row, and a held item cannot gain a dependency
 * edge at all (work-item-deps-store refuses an unresolved blocker behind an
 * active dependant). Those rows are what this module clears.
 *
 * The rule (work-item-ref-blocker-auto-clear-rule.ts) fires on every terminal
 * `work_items:complete` / `work_items:set_state` and calls the built-in action
 * `work-item.clearBlockersNamingFinished`, which runs
 * {@link runWorkItemRefBlockerAutoClear}:
 *   1. In one transaction, lock every non-terminal item in the workspace that
 *      carries an ACTIVE blocker whose ref names a finished id, re-read the
 *      state of EVERY id each such blocker names, and clear a blocker only when
 *      all of them are terminal. History is kept: the record is marked
 *      cleared with `clearedBy` and an evidence line, never deleted
 *      (clearExternalBlockersOnLockedRow, shared with event settlement).
 *   2. After commit, un-park a feature-family item that `set_blocker` parked
 *      and that now has no active blocker (the same restore set_blocker does on
 *      a manual clear), refresh the claimable views, then message and wake the
 *      item's holder. That follow-up ({@link followUpSystemClears}) is shared by
 *      every system clear: announced-event settlement, durable-park settlement
 *      and the blocker re-check sweep call it too (event-wait-settlement-2026-10-20 P-003).
 *
 * Only `live-dependency` blockers are eligible. An owner-capability ask
 * (credential, device, external action, product decision) or an approval that
 * merely MENTIONS a work item is not answered by that item closing.
 */
import { getOrgPg } from '@papercusp/db-org';
import type { TransactionSql } from 'postgres';
import {
  activeExternalBlockers,
  type ExternalBlockerKind,
  type ExternalBlockerRecord,
} from './external-blockers';
import { normalizeTakenBy } from './sync/hyperbee/projections/harness-features';
import { ANY_FAMILY_TERMINAL_STATES } from './work-item-dispatch-states';
import { clearExternalBlockersOnLockedRow, type LockedExternalBlockerRow, type OrgSql } from './work-items';

/** Actor stamped as `clearedBy` on every blocker this module clears. */
export const BLOCKER_AUTO_CLEAR_ACTOR = 'system:blocker-auto-clear';

/** A work-item id as a whole token: `WI-1` never matches inside `WI-10`, and an
 *  id glued to a longer word (`SPEC-F-1`, `PWI-3`) is not an id. */
const WORK_ITEM_ID_TOKEN = /(?<![A-Za-z0-9-])((?:WI|EI|F)-\d+)(?![A-Za-z0-9])/g;

const TERMINAL_STATES: ReadonlySet<string> = new Set(ANY_FAMILY_TERMINAL_STATES.map((s) => s.toLowerCase()));

/** Every distinct work-item id a blocker ref names, in order of appearance. Pure. */
export function workItemIdsNamedByBlockerRef(ref: string): string[] {
  return [...new Set(Array.from(ref.matchAll(WORK_ITEM_ID_TOKEN), (match) => match[1]!))];
}

export function isTerminalWorkItemState(state: string | null | undefined): boolean {
  return typeof state === 'string' && TERMINAL_STATES.has(state.trim().toLowerCase());
}

/** Whether a blocker is the kind a finished work item can satisfy. */
export function isWorkItemDependencyBlocker(blocker: Pick<ExternalBlockerRecord, 'capability'>): boolean {
  return blocker.capability === 'live-dependency';
}

export interface PlannedBlockerClear {
  kind: ExternalBlockerKind;
  ref: string;
  /** Every work-item id the ref names, all terminal at plan time. */
  namedIds: string[];
  /** Named ids that ended without being finished (dropped, deprecated, closed). */
  endedWithoutDone: string[];
  evidence: string;
}

/** Terminal states that mean the work was actually finished. */
const FINISHED_STATES: ReadonlySet<string> = new Set(['done', 'passed', 'resolved']);

/**
 * Which active blockers on one payload to clear, given the ids that just
 * finished and the current state of every id the blockers name. A blocker
 * clears only when it names at least one finished id AND every id it names
 * reads terminal; an id missing from `stateById` counts as not terminal. Pure.
 */
export function planWorkItemRefBlockerClears(
  payload: unknown,
  finishedIds: ReadonlySet<string>,
  stateById: ReadonlyMap<string, string | null>,
): PlannedBlockerClear[] {
  const out: PlannedBlockerClear[] = [];
  for (const blocker of activeExternalBlockers(payload)) {
    if (!isWorkItemDependencyBlocker(blocker)) continue;
    const namedIds = workItemIdsNamedByBlockerRef(blocker.ref);
    if (!namedIds.some((id) => finishedIds.has(id))) continue;
    if (!namedIds.every((id) => isTerminalWorkItemState(stateById.get(id)))) continue;
    out.push({
      kind: blocker.kind,
      ref: blocker.ref,
      namedIds,
      endedWithoutDone: namedIds.filter(
        (id) => !FINISHED_STATES.has(String(stateById.get(id) ?? '').trim().toLowerCase()),
      ),
      evidence: `auto-cleared: ${namedIds.map((id) => `${id} is ${stateById.get(id)}`).join(', ')}`,
    });
  }
  return out;
}

/** One wait a system path cleared: a typed external blocker, or a durable claim park. */
export interface SystemBlockerClear {
  kind: ExternalBlockerKind | 'durable-park';
  ref: string;
  evidence: string;
  /** Work items the ref named that ended without being finished (work-item-ref clears only). */
  endedWithoutDone?: readonly string[];
}

/**
 * An item a system path changed, described after its transaction committed: the input of
 * the shared follow-up ({@link followUpAutoClearedBlockers}). Every path that clears a wait
 * without an agent's call builds one — this module's work-item-ref auto-clear, announced
 * event settlement (reconcileEventExternalBlockers), durable-park settlement
 * (reconcileEventDurableParks) and the blocker re-check sweep (work-item-blocker-reaper.ts).
 * Plan event-wait-settlement-2026-10-20 P-003 (Design 3).
 */
export interface SystemClearedBlockerItem {
  workspaceId: string;
  featureId: string;
  harnessSlug: string | null;
  family: 'feature' | 'issue';
  /** Lifecycle state once the clear committed. */
  status: string | null;
  /** Who is told: the claimant, or for an unclaimed durable park the agent that parked it. */
  holder: string | null;
  restored: boolean;
  activeRemaining: number;
  cleared: SystemBlockerClear[];
  /** The `clearedBy` stamped on the records. Absent means this module's work-item-ref clear. */
  clearedBy?: string;
}

export interface AutoClearedBlockerItem extends SystemClearedBlockerItem {
  cleared: PlannedBlockerClear[];
}

type LockedRowWithHolder = LockedExternalBlockerRow & { harness_slug: string | null; taken_by: string | null };

const ISSUE_KINDS = new Set(['bug', 'change', 'task']);

/**
 * Clear, inside `tx`, every active blocker in `workspaceId` that is satisfied
 * now that `ids` have finished. Returns one entry per item it changed.
 */
export async function clearBlockersNamingFinishedWorkItems(
  tx: OrgSql | TransactionSql,
  input: { workspaceId: string; ids: readonly string[]; actor?: string; now?: string },
): Promise<AutoClearedBlockerItem[]> {
  const finished = [...new Set(input.ids.flatMap((id) => workItemIdsNamedByBlockerRef(id)))];
  if (!input.workspaceId || finished.length === 0) return [];

  // `payload ? 'externalBlockers'` matches the partial index from migration 1475;
  // the LIKE is only a prefilter — exact token matching happens in TS.
  const rows = await tx<LockedRowWithHolder[]>`
    SELECT workspace_id, feature_id, item_kind, status, payload, harness_slug, taken_by
      FROM harness_shared.work_items wi
     WHERE wi.workspace_id = ${input.workspaceId}
       AND wi.payload ? 'externalBlockers'
       AND NOT (lower(COALESCE(wi.status, '')) = ANY(${[...TERMINAL_STATES]}::text[]))
       AND EXISTS (
         SELECT 1
           FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(wi.payload -> 'externalBlockers') = 'array'
                  THEN wi.payload -> 'externalBlockers'
                  ELSE '[]'::jsonb END
           ) blocker
          WHERE lower(COALESCE(blocker ->> 'status', '')) = 'active'
            AND (blocker ->> 'ref') LIKE ANY(${finished.map((id) => `%${id}%`)}::text[])
       )
     ORDER BY wi.feature_id
     FOR UPDATE OF wi
  `;
  if (rows.length === 0) return [];

  const named = new Set<string>();
  for (const row of rows) {
    for (const blocker of activeExternalBlockers(row.payload)) {
      if (!isWorkItemDependencyBlocker(blocker)) continue;
      for (const id of workItemIdsNamedByBlockerRef(blocker.ref)) named.add(id);
    }
  }
  if (named.size === 0) return [];

  // Re-read every named id rather than trusting the trigger: a late reaction
  // after a reopen must not clear anything. If an id has more than one row, it
  // counts as terminal only when every row is.
  const stateRows = await tx<{ feature_id: string; status: string | null }[]>`
    SELECT feature_id, status
      FROM harness_shared.work_items
     WHERE workspace_id = ${input.workspaceId}
       AND feature_id = ANY(${[...named]}::text[])
  `;
  const stateById = new Map<string, string | null>();
  for (const row of stateRows) {
    const previous = stateById.get(row.feature_id);
    if (previous === undefined || isTerminalWorkItemState(previous)) stateById.set(row.feature_id, row.status);
  }

  const finishedSet = new Set(finished);
  const actor = input.actor?.trim() || BLOCKER_AUTO_CLEAR_ACTOR;
  const now = input.now ?? new Date().toISOString();
  const out: AutoClearedBlockerItem[] = [];
  for (const row of rows) {
    const plan = planWorkItemRefBlockerClears(row.payload, finishedSet, stateById);
    if (plan.length === 0) continue;
    const outcome = await clearExternalBlockersOnLockedRow(tx, row, plan, actor, now);
    if (!outcome.changed) continue;
    const clearedKeys = new Set(outcome.cleared.map((c) => `${c.kind}\u0000${c.ref}`));
    out.push({
      workspaceId: row.workspace_id,
      featureId: row.feature_id,
      harnessSlug: row.harness_slug ?? null,
      family: ISSUE_KINDS.has(String(row.item_kind)) ? 'issue' : 'feature',
      status: outcome.restored ? 'open' : row.status,
      holder: normalizeTakenBy(row.taken_by),
      restored: outcome.restored,
      activeRemaining: outcome.activeRemaining,
      cleared: plan.filter((p) => clearedKeys.has(`${p.kind}\u0000${p.ref}`)),
    });
  }
  return out;
}

export interface BlockerAutoClearFollowUpDeps {
  /** Move a parked feature-family item back to `open` (set_blocker's restore). */
  unparkFeature: (input: { id: string; harness: string | null; by: string }) => Promise<unknown>;
  /** Deliver a coord message to the holder. */
  send: (input: {
    workspaceId: string;
    to: string;
    summary: string;
    body: string;
    harnessSlug: string | null;
  }) => Promise<unknown>;
  /** Wake the holder's session so it takes a turn on the message. */
  wake: (input: { workspaceId: string; to: string; summary: string }) => Promise<unknown>;
  /** Refresh the work views that show what is claimable (the item just changed claimability). */
  invalidate: (input: { workspaceId: string; harnessSlug: string | null }) => Promise<unknown>;
}

/**
 * The sync queries that list claimable work (the Work tab's item list and its counts).
 * The work_items row trigger already bridges to these; the follow-up also pushes them from
 * the producer side, as the admission routines do for their ledger, so an open panel
 * converges on the release even where trigger delivery lags.
 */
export const CLAIMABLE_WORK_QUERY_NAMES = ['workItems.byHarness', 'workItems.summary'] as const;

export interface BlockerAutoClearFollowUp {
  featureId: string;
  unparked: boolean | null;
  invalidated: boolean;
  notified: boolean;
  woken: boolean;
  errors: string[];
}

function describeClear(item: SystemClearedBlockerItem): { summary: string; body: string } {
  if (item.cleared.length === 0) {
    // The blocker re-check sweep's stranded repair (event-wait-settlement-2026-10-20 P-005):
    // nothing was cleared now; every blocker was cleared earlier but the item stayed blocked.
    return {
      summary: `Returned to ${item.status ?? 'open'}: ${item.featureId} was still blocked with no active blocker`,
      body: [
        `${item.featureId} stayed blocked after every one of its blockers had been cleared, with nothing else ` +
          `holding it, so the system returned it to ${item.status ?? 'open'} (clearedBy ${item.clearedBy ?? BLOCKER_AUTO_CLEAR_ACTOR}).`,
        'Its blocker history is kept on the item; read it with work_items:get.',
      ].join('\n'),
    };
  }
  const refs = item.cleared.map((c) => c.ref).join('; ');
  const noun = item.cleared.every((c) => c.kind === 'durable-park') ? 'Park released' : 'Blocker cleared';
  const summary = `${noun} on ${item.featureId}: ${refs} (${item.cleared.map((c) => c.evidence.replace(/^auto-cleared: /, '')).join('; ')})`;
  const opening =
    item.clearedBy === undefined
      ? `A work item your blocker on ${item.featureId} was waiting on has reached a terminal state, so the blocker was cleared automatically (history kept on the item, clearedBy ${BLOCKER_AUTO_CLEAR_ACTOR}).`
      : `The condition ${item.featureId} was waiting on has been met, so the system cleared the wait (history kept on the item, clearedBy ${item.clearedBy}).`;
  const lines = [
    opening,
    ...item.cleared.map((c) => `- ${c.kind === 'durable-park' ? 'durable park' : `${c.kind} blocker`} "${c.ref}": ${c.evidence}`),
    item.activeRemaining === 0
      ? `No active blocker remains on ${item.featureId}.`
      : `${item.activeRemaining} other active blocker(s) still hold ${item.featureId}; read them with work_items:get.`,
  ];
  const endedWithoutDone = [...new Set(item.cleared.flatMap((c) => c.endedWithoutDone ?? []))];
  if (endedWithoutDone.length > 0) {
    lines.push(
      `${endedWithoutDone.join(', ')} ended without being finished (dropped, deprecated or closed): check whether ${item.featureId} still makes sense before you continue.`,
    );
  }
  return { summary, body: lines.join('\n') };
}

/**
 * The post-commit half, shared by every system clear (event-wait-settlement-2026-10-20
 * P-003): un-park feature-family items with nothing left to wait on, refresh the
 * claimable views when an item's last wait is gone, then message and wake each holder.
 * Every step is fail-soft per item — the clear already committed, and the next terminal
 * transition, the re-check sweep or the holder reading the item is the backstop for
 * anything that failed here.
 */
export async function followUpAutoClearedBlockers(
  items: readonly SystemClearedBlockerItem[],
  deps: BlockerAutoClearFollowUpDeps,
): Promise<BlockerAutoClearFollowUp[]> {
  const results: BlockerAutoClearFollowUp[] = [];
  for (const item of items) {
    const result: BlockerAutoClearFollowUp = {
      featureId: item.featureId,
      unparked: null,
      invalidated: false,
      notified: false,
      woken: false,
      errors: [],
    };
    if (item.family === 'feature' && String(item.status ?? '').toLowerCase() === 'blocked' && item.activeRemaining === 0) {
      try {
        await deps.unparkFeature({ id: item.featureId, harness: item.harnessSlug, by: BLOCKER_AUTO_CLEAR_ACTOR });
        result.unparked = true;
      } catch (err) {
        result.unparked = false;
        result.errors.push(`unpark: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (item.activeRemaining === 0) {
      try {
        await deps.invalidate({ workspaceId: item.workspaceId, harnessSlug: item.harnessSlug });
        result.invalidated = true;
      } catch (err) {
        result.errors.push(`invalidate: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (item.holder) {
      const { summary, body } = describeClear(item);
      try {
        await deps.send({ workspaceId: item.workspaceId, to: item.holder, summary, body, harnessSlug: item.harnessSlug });
        result.notified = true;
      } catch (err) {
        result.errors.push(`send: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        await deps.wake({ workspaceId: item.workspaceId, to: item.holder, summary });
        result.woken = true;
      } catch (err) {
        result.errors.push(`wake: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    results.push(result);
  }
  return results;
}

/** Production follow-up deps, imported lazily: this module is loaded from the
 *  reaction dispatch path, and the coordination stack is heavy. */
export function productionBlockerAutoClearFollowUpDeps(): BlockerAutoClearFollowUpDeps {
  return {
    unparkFeature: async ({ id, harness, by }) => {
      const { setWorkItemStateWithAliasInfo } = await import('./work-items');
      return setWorkItemStateWithAliasInfo(id, 'open', { harness: harness ?? undefined, by });
    },
    send: async ({ workspaceId, to, summary, body, harnessSlug }) => {
      const { sendMessage } = await import('./agent-tools/coordination/messages');
      return sendMessage(
        {
          ownerId: BLOCKER_AUTO_CLEAR_ACTOR,
          ownerLabel: 'system · blocker-auto-clear',
          source: 'principal',
          workspaceId,
          userId: null,
        },
        { to: [to], summary, body, harnessSlug },
      );
    },
    wake: async ({ workspaceId, to, summary }) => {
      const { wakeRecipients } = await import('./agent-tools/coordination/inbox-wake');
      return wakeRecipients([to], { summary, source: BLOCKER_AUTO_CLEAR_ACTOR, workspaceId });
    },
    invalidate: async () => {
      const { notifySyncInvalidate } = await import('./sync-sse');
      await Promise.all(CLAIMABLE_WORK_QUERY_NAMES.map((name) => notifySyncInvalidate(name)));
    },
  };
}

/**
 * The follow-up as the settlement paths call it, after their transaction committed: never
 * throws, so a failed message or wake can never fail the emit, retirement or sweep that
 * cleared the wait.
 */
export async function followUpSystemClears(
  items: readonly SystemClearedBlockerItem[],
  deps: BlockerAutoClearFollowUpDeps = productionBlockerAutoClearFollowUpDeps(),
): Promise<BlockerAutoClearFollowUp[]> {
  if (items.length === 0) return [];
  try {
    return await followUpAutoClearedBlockers(items, deps);
  } catch (err) {
    console.warn(
      `[system-clear-follow-up] ! ${items.map((i) => i.featureId).join(',')}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/** Clear and follow up, for the `work-item.clearBlockersNamingFinished` built-in action. */
export async function runWorkItemRefBlockerAutoClear(
  workspaceId: string,
  ids: readonly string[],
  deps: BlockerAutoClearFollowUpDeps = productionBlockerAutoClearFollowUpDeps(),
): Promise<{ cleared: AutoClearedBlockerItem[]; followUps: BlockerAutoClearFollowUp[] }> {
  const { sql } = getOrgPg();
  const cleared = await sql.begin(
    async (tx): Promise<AutoClearedBlockerItem[]> => clearBlockersNamingFinishedWorkItems(tx, { workspaceId, ids }),
  );
  const followUps = await followUpAutoClearedBlockers(cleared, deps);
  return { cleared, followUps };
}
