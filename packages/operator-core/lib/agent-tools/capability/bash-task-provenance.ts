/**
 * Background-task provenance for capability:bash and every other launch seam that ledgers a task
 * (testing:run, release:cut) — who launched it, and for which work-item / plan / goal.
 *
 * Lives OUTSIDE bash.ts on purpose. It needs only identity + goal + held-claim readers, while
 * bash.ts drags in the whole shell runtime: exec-sandbox → auth-config-overrides, and bash-jobs,
 * whose module-scope `warmScopeProbe()` reads a flag at import. When testing/run.ts and
 * release/cut.ts imported this function from './bash', every test whose graph reached either of
 * them inherited that runtime — ~20 files on frozen candidate 5ec99902 died at collection under a
 * partial `@papercusp/flags/server` mock, and set-status.bulk's "getFlag is never consulted"
 * assertion saw the probe's import-time read. Keep this module light.
 */
import { resolveAgentIdentity, type ResolveIdentityCtx } from '../coordination/identity';
import { resolveOwnerGoal } from '../coordination/agent-goal-sources';
import { readAgentStateStamp } from '../../agent-state-stamp';
import { readHeldWorkItems } from '../../carry-brief';
import type { TaskRow } from '../../task-manager/types';

export interface BashTaskProvenance {
  launchedBy: string;
  sessionId: string | null;
  harnessSlug: string | null;
  workItemId: string | null;
  planSlug: string | null;
  goalRef: string | null;
  parentTaskId?: string;
}

interface BashTaskProvenanceDeps {
  resolveIdentity: typeof resolveAgentIdentity;
  readStamp: typeof readAgentStateStamp;
  resolveGoal: typeof resolveOwnerGoal;
  /**
   * EI-21548894457555139: the caller's held (assigned, non-terminal) work-items, used
   * ONLY as the fallback below when the goal ref is not itself a work-item id. Reuses
   * the same reader the carry brief and orient's recovery fold use, so the three
   * surfaces cannot disagree about what an agent holds.
   */
  readHeldWorkItems: typeof readHeldWorkItems;
  readParentTask?: (id: string) => Promise<TaskRow | null>;
}

export interface BashTaskProvenanceOptions {
  /**
   * WI-10004202: the work-item the caller NAMES for this launch (capability:bash
   * `work_item_id`). It wins over the goal ref, because the goal ref is whatever the
   * session last declared — measured: an EVL mutation run for WI-10004188 was ledgered
   * against WI-10003976 (the declared goal) and counted in THAT item's loop-gate window.
   */
  explicitWorkItemId?: string | null;
  /** A nested API launch must keep the durable caller's task tree. */
  explicitParentTaskId?: string;
  /** Launchers without an implicit goal contract must not guess among held items. */
  requireExplicitForMultipleHeldItems?: boolean;
}

/** A caller-named work-item the resolver can positively show is not the caller's. */
export class BashProvenanceRefusal extends Error {
  constructor(
    readonly code: 'work_item_id_invalid' | 'work_item_not_held' | 'work_item_id_required' | 'parent_task_invalid',
    message: string,
  ) {
    super(message);
    this.name = 'BashProvenanceRefusal';
  }
}

const WORK_ITEM_ID_RE = /^(?:WI|EI|F)-[A-Za-z0-9._-]+$/;
/** Held-claim scan width for verifying an explicit id (the single-claim fallback reads 2). */
const EXPLICIT_HELD_SCAN_LIMIT = 200;
/** Keep a refusal actionable without allowing a large claim set to flood the response. */
const HELD_ID_HINT_CAP = 8;

function heldWorkItemRefusalHint(explicit: string, held: readonly { id: string }[]): string {
  const ids = [...new Set(held.map((item) => item.id.trim()).filter(Boolean))];
  if (ids.length === 0) {
    return ' Re-read the exact id from scheduler:get_next or work_items:get; do not shorten or infer an id.';
  }

  const prefixMatches = ids.filter((id) => id.startsWith(explicit));
  if (prefixMatches.length === 1) {
    return (
      ` The supplied value is a prefix of your held item '${prefixMatches[0]}'; pass that full id. ` +
      'Re-read the exact id from scheduler:get_next or work_items:get; do not shorten or infer an id.'
    );
  }

  const shown = ids.slice(0, HELD_ID_HINT_CAP);
  const more = ids.length - shown.length;
  return (
    ` Your currently held work-item id${ids.length === 1 ? ' is' : 's are'} ` +
    `${shown.join(', ')}${more > 0 ? `, plus ${more} more` : ''}. ` +
    'Re-read the exact id from scheduler:get_next or work_items:get; do not shorten or infer an id.'
  );
}

const DEFAULT_BASH_PROVENANCE_DEPS: BashTaskProvenanceDeps = {
  resolveIdentity: resolveAgentIdentity,
  readStamp: readAgentStateStamp,
  resolveGoal: resolveOwnerGoal,
  readHeldWorkItems,
};

/**
 * Resolve background-task provenance at the launch seam, while the caller's
 * stable identity and live goal are still available.  The task ledger cannot
 * reconstruct either from a child pid later.  Resolution is fail-soft: an
 * unattributable caller still gets a working shell, but never a fabricated
 * work-item association.
 */
export async function resolveBashTaskProvenance(
  ctx: ResolveIdentityCtx,
  harnessSlug: string | null,
  deps: BashTaskProvenanceDeps = DEFAULT_BASH_PROVENANCE_DEPS,
  options: BashTaskProvenanceOptions = {},
): Promise<BashTaskProvenance> {
  let ownerId: string | null = null;
  try {
    ownerId = deps.resolveIdentity(ctx).ownerId;
  } catch {
    ownerId = null;
  }

  let goalRef = ownerId ? deps.readStamp(ownerId).goalRef : null;
  if (ownerId && !goalRef) {
    goalRef = (await deps.resolveGoal(ownerId, 'self'))?.ref ?? null;
  }

  const explicit = options.explicitWorkItemId?.trim() || null;
  let implicitHeldWorkItemId: string | null | undefined;
  if (ownerId && !explicit && options.requireExplicitForMultipleHeldItems) {
    let held: Array<{ id: string }> | null = null;
    try {
      const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? '';
      held = await deps.readHeldWorkItems(ownerId, workspaceId, { limit: 2 });
    } catch {
      // A strict launcher needs a named item if its implicit attribution is unmeasured.
    }
    if (!held) {
      throw new BashProvenanceRefusal(
        'work_item_id_required',
        'Held work-items could not be read; pass work_item_id explicitly for this launch.',
      );
    }
    if (held && held.length > 1) {
      throw new BashProvenanceRefusal(
        'work_item_id_required',
        'work_item_id is required when you hold multiple work-items; name the item this launch serves.',
      );
    }
    if (held) implicitHeldWorkItemId = held[0]?.id ?? null;
  }
  if (explicit) {
    if (!WORK_ITEM_ID_RE.test(explicit)) {
      throw new BashProvenanceRefusal(
        'work_item_id_invalid',
        `work_item_id '${explicit}' is not a work-item id (expected WI-/EI-/F-…).`,
      );
    }
    // Naming an item you do not hold would move a run's cost and its loop-gate count
    // onto someone else's item — the misattribution this option exists to remove. Refuse
    // only on a POSITIVE read; an unreadable claim keeps the shell fail-soft.
    if (ownerId) {
      let held: Array<{ id: string }> | null = null;
      try {
        const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? '';
        held = await deps.readHeldWorkItems(ownerId, workspaceId, { limit: EXPLICIT_HELD_SCAN_LIMIT });
      } catch {
        held = null;
      }
      if (held && !held.some((h) => h.id === explicit)) {
        throw new BashProvenanceRefusal(
          'work_item_not_held',
          `work_item_id '${explicit}' is not one of your currently held, non-terminal work-items. ` +
            'A direct by-id claim of a terminal item does not create an active hold; choose a held item or omit work_item_id.' +
            heldWorkItemRefusalHint(explicit, held),
        );
      }
    }
  }

  let workItemId = explicit;
  if (!workItemId) {
    // A declared work-item goal can outlive its claim (including after it is done).
    // Treat it as a candidate, not proof of current ownership; the live held-claim
    // reader below validates it before task costs or loop attempts are attributed.
    workItemId = implicitHeldWorkItemId !== undefined ? implicitHeldWorkItemId : null;
  }
  // EI-21548894457555139: the goal ref is only SOMETIMES a work-item id. A fleet leader
  // or a plan-bound agent declares `fleet:<slug>` / `<plan>#P-NNN`, so the regex above
  // yields null and the task lands in the ledger unlinked — `processes:list` then cannot
  // answer "which work-item is this process for?" even though the agent is holding one.
  // Measured: an agent holding EI-21548894457555139 linked correctly, while the same
  // agent's fleet-scoped work would not have.
  //
  // Fall back to the caller's held claim, and ONLY when it is UNAMBIGUOUS. An agent
  // holding several items gives no basis for choosing between them, and a fabricated
  // work-item association is worse than an absent one: absent reads as "unknown", while
  // wrong reads as fact and misattributes the cost and the provenance of the run. That
  // is the same principle this function's own doc comment already states.
  if (!workItemId && ownerId && implicitHeldWorkItemId === undefined) {
    try {
      const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId ?? '';
      const goalWorkItemId = goalRef && WORK_ITEM_ID_RE.test(goalRef) ? goalRef : null;
      const held = await deps.readHeldWorkItems(ownerId, workspaceId, {
        limit: goalWorkItemId ? EXPLICIT_HELD_SCAN_LIMIT : 2,
      });
      if (goalWorkItemId && held.some((item) => item.id === goalWorkItemId)) {
        workItemId = goalWorkItemId;
      } else if (held.length === 1) {
        workItemId = held[0]!.id;
      }
    } catch {
      // Provenance is fail-soft by contract — an unreadable claim never blocks the shell.
    }
  }
  const planMatch = goalRef?.match(/^(?:plan:)?(.+?)#P-\d+$/) ?? null;
  const principalFallback = ctx.principal?.slug?.trim() || 'capability:bash';
  const parentTaskId = options.explicitParentTaskId;
  if (parentTaskId !== undefined) {
    // An explicit parent is a lifetime/ownership assertion. Unlike optional
    // attribution above, an unreadable or foreign parent must refuse the fork.
    const workspaceId = ctx.workspaceId ?? ctx.principal?.workspaceId;
    let parent: TaskRow | null = null;
    if (/^[0-9a-z]{4,64}$/.test(parentTaskId)) {
      try {
        const readParent = deps.readParentTask ?? (await import('../../task-manager/store')).getTask;
        parent = await readParent(parentTaskId);
      } catch { /* Unmeasured lineage cannot safely authorize a nested task. */ }
    }
    if (!ownerId || !workspaceId || !parent || parent.workspaceId !== workspaceId ||
      parent.launchedBy !== ownerId || parent.harnessSlug !== harnessSlug ||
      parent.workItemId !== workItemId || !['pending', 'running'].includes(parent.state) || parent.endedAt) {
      throw new BashProvenanceRefusal('parent_task_invalid',
        'parent_task_id must name a readable live task owned by this caller in the same workspace, harness and work-item.');
    }
  }
  return {
    launchedBy: ownerId ?? principalFallback,
    sessionId: ownerId,
    harnessSlug,
    workItemId,
    planSlug: planMatch?.[1] ?? null,
    goalRef,
    ...(parentTaskId === undefined ? {} : { parentTaskId }),
  };
}

/**
 * `capability:bash` is the common arbitrary-command launcher, so a declared goal
 * is not enough to pick between multiple held items. Require the caller to name
 * the item whose cost and slow-attempt history this command belongs to.
 */
export function resolveCapabilityBashTaskProvenance(
  ctx: ResolveIdentityCtx,
  harnessSlug: string | null,
  deps: BashTaskProvenanceDeps = DEFAULT_BASH_PROVENANCE_DEPS,
  options: BashTaskProvenanceOptions = {},
): Promise<BashTaskProvenance> {
  return resolveBashTaskProvenance(ctx, harnessSlug, deps, {
    ...options,
    requireExplicitForMultipleHeldItems: true,
  });
}
