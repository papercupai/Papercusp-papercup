/**
 * work_items:set_blocker — typed non-work-item dependencies.
 *
 * Internal work dependencies remain `work_items:link { rel:'blocks' }` (and plan
 * `blocked-by`) so their history/graph semantics stay intact. This surface is
 * specifically for conditions that are not work-items: events, gates, runtime
 * state, and human decisions. Clearing marks history; it never deletes it.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { trackPhase, type AbortCompletionReceipt, type ToolResult } from '@papercusp/tooldef';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { runBulk, bulkContent } from '../_bulk';
import { getModes } from '../../modes/store';
import { modeImpliesAutonomy } from '../../modes/registry';
import { askOp } from '../../coord-ops/ops/compose';
import { buildCoordOpCtx } from '../../coord-ops/prod-caps';
import {
  getWorkItem,
  mergeWorkItemPayload,
  setWorkItemClaimHold,
  setWorkItemStateWithAliasInfo,
  type WorkItem,
} from '../../work-items';
import {
  activeExternalBlockers,
  applyExternalBlockerUpdate,
  externalBlockerCapabilityPolicy,
  EXTERNAL_BLOCKER_CAPABILITIES,
  OWNER_ASK_DEFAULT_ACTIONS,
  readExternalBlockers,
  isDirectHumanCapability,
  isHumanBlockerCapability,
  type DirectHumanCapability,
  type ExternalBlockerCapability,
  type ExternalBlockerKind,
  type OwnerAskDefaultAction,
} from '../../external-blockers';
import { lookupWorkItem } from './_lookup';
import { isStrictOwnerActionCapability } from '../../harness/improvements/agent-review-policy';
import { hasActiveStrictHumanAsk } from '../../hold-registry';
import { stagingFirstBlockerProblem } from '../plans/staging-first-activation-guard';
import { admitWaitRef } from '../../wait-ref-admission';
import { pureWorkItemDependencyReferents, workItemRefBlockerProblem } from './work-item-ref-blocker-guard';
import { linkWorkItemRefDependencies } from './work-item-ref-blocker-edges';
import { workItemRefDependencyRefusal } from './work-item-ref-dependency-refusal';
import { OWNER_AUTHORITY_TOPICS, type OwnerAuthorityTopic } from '../../consult/decision-review';
import { asRecord, completedResultPayload } from '../abort-completion-payload';
import { checkHoldLift, holdArg, ownerTurnRefField, prepareHoldPlacement, type HoldArg } from './set-blocker-hold';
import type { RestrictionHold } from '../../restriction-holds';

// Older callers used the missing capability as `kind` (for example,
// `kind:'credential'`). Keep accepting those inputs at the tool boundary, but
// normalize them to the canonical trigger/capability split before persistence.
const BLOCKER_KIND = z.enum([
  'event',
  'gate',
  'runtime',
  'human',
  'credential',
  'physical-device',
  'external-service-action',
  'product-decision',
  'approval-auto-clearable',
  'hold',
]);
const BLOCKER_CAPABILITY = z.enum(EXTERNAL_BLOCKER_CAPABILITIES);
type BlockerKindInput = z.infer<typeof BLOCKER_KIND>;
type BlockerCapabilityInput = z.infer<typeof BLOCKER_CAPABILITY>;
const SET_BLOCKER_CALL_CONSTRAINT =
  "For a single-item call that sets a blocker, pass id, kind, and ref; ref is required even though it is optional in the structural schema. For items:[...], each entry that sets a blocker also requires kind and ref. A clear-only call may omit ref when one active blocker can be resolved; migrateWorkItemRefs:true takes only id. When setting a strict human owner-capability blocker (capability: credential, physical-device, external-service-action, or product-decision), provide a nonblank defaultIfUnanswered. For items:[...], this applies to each entry. A reassertion may omit it only when that work-item already has an active human blocker with the same ref and a nonblank defaultIfUnanswered. Clear-only calls and non-human blockers do not require it. The legacy kind shorthands credential, physical-device, external-service-action, and product-decision are treated as human capabilities." +
  " For a non-final item blocked on main/:3070/green-checkpoint, put in summary or evidence the literal phrase 'deployed-only', what staging/current-build cannot exercise, and a concrete reason introduced with because/due to/since; otherwise the guard refuses the blocker and source work continues on staging/current-build.";
type BlockerInput = {
  id: string;
  kind?: BlockerKindInput;
  capability?: BlockerCapabilityInput;
  ref?: string;
  summary?: string;
  evidence?: string;
  nextVerb?: string;
  recheckAt?: string;
  defaultIfUnanswered?: string;
  decideBy?: string;
  defaultAction?: OwnerAskDefaultAction;
  /** consult-backed-parking R-14: a product-decision park on an owner-authority topic. */
  ownerAuthorityTopic?: OwnerAuthorityTopic;
  clear?: boolean;
  harness?: string;
  migrateWorkItemRefs?: boolean;
  /** one-work-graph-structured-holds-2026-10-26#D-014: the restriction a kind:'hold' row records. */
  hold?: HoldArg;
  ownerTurnRef?: string;
};
type NormalizedBlockerInput = Omit<BlockerInput, 'kind'> & { kind?: ExternalBlockerKind };
const CAPABILITY_KIND_ALIASES = {
  credential: { kind: 'human', capability: 'credential' },
  'physical-device': { kind: 'human', capability: 'physical-device' },
  'external-service-action': { kind: 'human', capability: 'external-service-action' },
  'product-decision': { kind: 'human', capability: 'product-decision' },
  'approval-auto-clearable': { kind: 'human', capability: 'approval-auto-clearable' },
} as const satisfies Record<string, { kind: ExternalBlockerKind; capability: ExternalBlockerCapability }>;

function validateCapabilityKindAlias(
  value: { kind?: BlockerKindInput; capability?: BlockerCapabilityInput; hold?: unknown },
  ctx: z.RefinementCtx,
) {
  // D-014 item 3: kind 'hold' and capability 'restriction-hold' only ever travel together.
  if ((value.kind === 'hold') !== (value.capability === 'restriction-hold') && value.capability !== undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['capability'],
      message: "capability 'restriction-hold' belongs to kind 'hold' only (and kind 'hold' takes no other capability)",
    });
  }
  if (value.hold !== undefined && value.kind !== 'hold') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['hold'], message: "hold is only accepted with kind 'hold'" });
  }
  const alias = value.kind ? CAPABILITY_KIND_ALIASES[value.kind as keyof typeof CAPABILITY_KIND_ALIASES] : undefined;
  if (alias && value.capability && value.capability !== alias.capability) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['capability'],
      message: `kind '${value.kind}' is a shorthand for capability '${alias.capability}' and cannot be combined with capability '${value.capability}'`,
    });
  }
}

function normalizeBlockerInput(input: BlockerInput): NormalizedBlockerInput {
  if (input.kind === 'hold') return { ...input, kind: 'hold', capability: 'restriction-hold' };
  const alias = input.kind ? CAPABILITY_KIND_ALIASES[input.kind as keyof typeof CAPABILITY_KIND_ALIASES] : undefined;
  if (!alias) return { ...input, kind: input.kind as ExternalBlockerKind | undefined };
  return {
    ...input,
    kind: alias.kind,
    capability: input.capability ?? alias.capability,
  };
}

/**
 * A clear can persist blocker history before lifecycle restoration discovers that
 * the linked plan lane is still blocked. Re-run the canonical plan-lane sync so
 * that recovery writes the provenance-carrying `plan-lane:` blocker instead of
 * leaving a `blocked` work-item with no active blocker for the scheduler to find.
 *
 * This is deliberately best-effort: the original lifecycle failure remains the
 * caller-visible result, while the reconciler is the single writer for plan-lane
 * blocker semantics and can retry on its normal cadence if its read also fails.
 */
async function resyncLinkedPlanLaneAfterLifecycleFailure(
  workItem: Pick<WorkItem, 'payload' | 'harness'> &
    Partial<Pick<WorkItem, 'id' | 'family' | 'sourcePlanSlug' | 'sourcePlanItemIds'>>,
): Promise<{ planSlug: string; itemIds: string[]; results: unknown[] } | null> {
  try {
    const { resolvePlanItemStamp } = await import('../../scheduler/plan-item-lane-guard');
    const stamp = await resolvePlanItemStamp(workItem);
    if (!stamp) return null;
    const { resyncPlanItemLaneNow } = await import('../../plan-items/reconcile-linked-work-items');
    const results: unknown[] = [];
    for (const itemId of stamp.item_ids) {
      results.push(await resyncPlanItemLaneNow(stamp.plan_slug, itemId, workItem.harness ?? null));
    }
    return results.some((result) => result !== null)
      ? { planSlug: stamp.plan_slug, itemIds: [...stamp.item_ids], results }
      : null;
  } catch {
    return null;
  }
}

function directHumanCapabilityChoices(capability: DirectHumanCapability): string[] {
  switch (capability) {
    case 'credential':
      return [
        'I will provide it through the approved secret/configuration surface (do not paste a credential in chat).',
        'Route this to the credential holder; I will identify the right person.',
        'Keep this work-item parked until a credential holder is available.',
      ];
    case 'physical-device':
      return [
        'I will perform or attest the required physical-device interaction.',
        'Route this to the person who has the device; I will identify them.',
        'Keep this work-item parked until the device is available.',
      ];
    case 'external-service-action':
      return [
        'I will perform the action through the approved external-service integration.',
        'Route this to the service operator; I will identify the right person.',
        'Keep this work-item parked until the service action is available.',
      ];
    default:
      return [];
  }
}

function directHumanCapabilityQuestion(input: NormalizedBlockerInput, defaultIfUnanswered: string) {
  const capability = input.capability as DirectHumanCapability;
  const options = directHumanCapabilityChoices(capability);
  return {
    options,
    question: `How should we resolve the ${capability} blocker for work-item ${input.id}?`,
    body: [
      `Blocker: ${input.summary?.trim() ?? input.ref ?? input.id}`,
      `Reference: ${input.ref}`,
      `Action that unblocks it: ${input.nextVerb?.trim()}`,
      '',
      'Choose one option by number or reply with the corresponding action:',
      ...options.map((option, index) => `${index + 1}. ${option}`),
      '',
      `If you do not answer: ${defaultIfUnanswered}`,
    ].join('\n'),
  };
}

async function openDirectHumanCapabilityQuestion(
  input: NormalizedBlockerInput,
  identity: ReturnType<typeof resolveAgentIdentity>,
  rawCtx: unknown,
  defaultIfUnanswered: string,
  supersedesConversationId?: string,
) {
  const { question, body, options } = directHumanCapabilityQuestion(input, defaultIfUnanswered);
  const ctxHarness = (rawCtx as { harnessSlug?: unknown } | null)?.harnessSlug;
  const coordContext = buildCoordOpCtx({
    identity: { ownerId: identity.ownerId, ownerLabel: identity.ownerLabel },
    workspaceId: identity.workspaceId ?? undefined,
    harnessSlug:
      input.harness ?? (typeof ctxHarness === 'string' && ctxHarness && ctxHarness !== '*' ? ctxHarness : undefined),
    callerId: identity.ownerId,
  });
  const ask = await askOp.run(
    {
      question,
      body,
      timeout_s: 0,
      poll_ms: 2000,
      ...(supersedesConversationId ? { supersedes_conversation_id: supersedesConversationId } : {}),
    },
    coordContext,
  );
  return { conversationId: ask.conversation_id, options };
}

const fields = {
  kind: BLOCKER_KIND.optional(),
  capability: BLOCKER_CAPABILITY.optional(),
  ref: z.string().min(1).max(300).optional(),
  summary: z.string().max(1000).optional().describe(
    "Blocker rationale. For a non-final deployed-only exception, include here or in evidence the literal phrase 'deployed-only', what staging/current-build cannot exercise, and a concrete reason (because/due to/since).",
  ),
  evidence: z.string().max(4000).optional().describe(
    "Supporting evidence. The non-final deployed-only exception checks summary and evidence for the literal phrase 'deployed-only', the staging/current-build limitation, and a concrete reason (because/due to/since).",
  ),
  nextVerb: z.string().max(300).optional(),
  recheckAt: z.string().datetime({ offset: true }).optional()
    .describe('Next condition re-check. Omit to use the existing hold registry cadence; this does not authorize clearing on expiry.'),
  defaultIfUnanswered: z.string().max(500).optional(),
  decideBy: z.string().max(40).optional(),
  defaultAction: z
    .enum(OWNER_ASK_DEFAULT_ACTIONS)
    .optional()
    .describe(
      "Typed, machine-executable form of defaultIfUnanswered, applied ONCE by the reaper after decideBy passes with no owner answer. stay_parked: ask stays active, item stays parked. release_to_agents: ask cleared, item returns to the claimable pool. Needs decideBy; the free-text default is never parsed.",
    ),
  ownerAuthorityTopic: z
    .enum(OWNER_AUTHORITY_TOPICS)
    .optional()
    .describe('product-decision parks only: the owner-authority topic. Such a park never resolves to proceed without the owner.'),
  clear: z.boolean().optional(),
  harness: z.string().max(80).optional(),
  migrateWorkItemRefs: z
    .boolean()
    .optional()
    .describe('Migrate this item\'s legacy rows that name only work-items to blocks edges; pass id (+harness) only.'),
  hold: holdArg.optional().describe("kind 'hold' only: the restriction; summary is its reason. ref is derived."),
  ownerTurnRef: ownerTurnRefField.optional().describe('Owner turn placing (or lifting) a hold; absent means an agent hold.'),
};

/** A migration request names only the item: it rewrites existing rows, so a set/clear field is contradictory. */
function validateMigrateOnly(
  value: { migrateWorkItemRefs?: boolean; kind?: unknown; capability?: unknown; ref?: unknown; clear?: unknown },
  ctx: z.RefinementCtx,
  path: (string | number)[] = [],
) {
  if (value.migrateWorkItemRefs !== true) return;
  for (const key of ['kind', 'capability', 'ref', 'clear'] as const) {
    if (value[key] !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, key],
        message: `migrateWorkItemRefs rewrites the item's existing rows and cannot be combined with '${key}'`,
      });
    }
  }
}

const itemSpec = z
  .object({ id: z.string().min(1), ...fields })
  .strict()
  .superRefine(validateCapabilityKindAlias);

const TERMINAL = new Set(['passed', 'deprecated', 'resolved', 'closed', 'done', 'dropped']);

type WorkItemRow = NonNullable<Awaited<ReturnType<typeof getWorkItem>>>;
const MIGRATION_EVIDENCE = 'WI-10005020 R-15: migrated to the work_item_deps blocks edge (canonical dependency form)';

const OWNER_ACTION_FLAGS = ['needsOwnerAction', 'needsHuman'] as const;

/**
 * WI-10008173 — the owner-action payload flags a CLEAR must release with its blocker.
 *
 * `payload.needsOwnerAction` (and legacy `needsHuman`) are written ALONGSIDE a human
 * blocker (resolve-core's park write, mergeIssuePayload in work-items.ts) and gate every
 * claim door on their own (`needsOwnerActionExclusionSql`, the `needsOwnerAction` claimable
 * exclusion leg). Clearing the last active human blocker removes the flag's only backing
 * evidence, so the flag must go in the SAME CAS write; leaving it reopened the row while
 * keeping it excluded from every claim door (measured 2026-10-10: 7 open rows, 0 active
 * blockers, flag still set).
 *
 * Releases nothing unless this request CLEARS a human-kind blocker and no active human-kind
 * blocker remains, so a surviving owner ask, a non-human clear, or a set call never drops
 * an owner flag.
 */
export function ownerActionFlagsReleasedByClear(
  payload: unknown,
  remainingActive: ReadonlyArray<{ kind: string }>,
  change: { kind: string; cleared: boolean },
): Array<(typeof OWNER_ACTION_FLAGS)[number]> {
  if (!change.cleared || change.kind !== 'human') return [];
  if (remainingActive.some((blocker) => blocker.kind === 'human')) return [];
  const record = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
  return OWNER_ACTION_FLAGS.filter((key) => record[key] === true);
}

/**
 * WI-10005020 (P-002 / R-15) — migrate an item's legacy `externalBlockers` rows whose ref
 * names ONLY work-items to the canonical `blocks` edge, then clear the row (history kept).
 *
 * - A referent equal to the item's own id is not a dependency: rows naming only the item
 *   itself are owner-action records and stay untouched; a self id inside a multi-ref row
 *   is dropped from the referents.
 * - A terminal dependent gets its rows cleared without new edges — nothing can wait on it.
 * - A refused edge (missing referent, cycle, an active dependant's guard) leaves that row
 *   active and is reported, so no dependency is ever lost.
 * - When no active row remains, the lifecycle mirrors clearing the last blocker: `blocked`
 *   returns to `open` (the edge alone now gates claiming) and an issue's claim hold drops.
 */
async function migrateWorkItemRefRows(input: NormalizedBlockerInput, workItem: WorkItemRow, by: string) {
  const ownId = input.id.toUpperCase();
  const dependentTerminal = TERMINAL.has(workItem.state.toLowerCase());
  const converted: Array<{ kind: string; ref: string; blockers: string[] }> = [];
  const refused: Array<{ kind: string; ref: string; error: string }> = [];
  const untouchedSelfOnly: Array<{ kind: string; ref: string }> = [];
  let payload: Record<string, unknown> =
    workItem.payload && typeof workItem.payload === 'object' && !Array.isArray(workItem.payload)
      ? (workItem.payload as Record<string, unknown>)
      : {};
  let blockers = readExternalBlockers(payload);

  for (const row of activeExternalBlockers(workItem.payload)) {
    const referents = pureWorkItemDependencyReferents(row.ref);
    if (!referents) continue;
    const dependencies = referents.filter((referent) => referent !== ownId);
    if (!dependencies.length) {
      untouchedSelfOnly.push({ kind: row.kind, ref: row.ref });
      continue;
    }
    if (!dependentTerminal) {
      const linked = await linkWorkItemRefDependencies({
        dependentId: input.id,
        harness: input.harness,
        referents: dependencies,
        by,
      });
      if (!linked.ok) {
        refused.push({ kind: row.kind, ref: row.ref, error: linked.error });
        continue;
      }
    }
    const history = applyExternalBlockerUpdate(
      payload,
      { kind: row.kind, ref: row.ref, clear: true, evidence: MIGRATION_EVIDENCE },
      by,
      { autoAuthority: false },
    );
    blockers = history.blockers;
    payload = { ...payload, externalBlockers: blockers };
    converted.push({ kind: row.kind, ref: row.ref, blockers: dependentTerminal ? [] : dependencies });
  }

  const migration = { dependentTerminal, converted, refused, untouchedSelfOnly };
  if (!converted.length) {
    return {
      ok: refused.length === 0,
      id: input.id,
      changed: false,
      workItem,
      migration,
      activeBlockers: activeExternalBlockers(workItem.payload),
      ...(refused.length
        ? {
            code: 'work_item_ref_dependency_refused',
            error: refused.map((r) => r.error).join(' | '),
            refusal: workItemRefDependencyRefusal(input.id, refused.map((r) => r.ref).join(',')),
          }
        : {}),
    };
  }

  const ownerFlagUnset = ownerActionFlagsReleasedByClear(
    workItem.payload,
    blockers.filter((blocker) => blocker.status === 'active'),
    { kind: converted.some((row) => row.kind === 'human') ? 'human' : 'non-human', cleared: true },
  );
  const updated = await mergeWorkItemPayload(input.id, { externalBlockers: blockers }, {
    harness: input.harness,
    expectedExternalBlockers: (workItem.payload as { externalBlockers?: unknown } | null)?.externalBlockers,
    ...(ownerFlagUnset.length > 0 ? { unset: ownerFlagUnset } : {}),
  });
  if (!updated) return {
    ok: false as const, id: input.id, code: 'blocker_history_conflict',
    error: 'Blocker history changed or the row became unwritable; the typed hold was not cleared. Dependency edges may already exist. Read work_items:get before retrying.',
    migration,
    partialOutcome: { blockerHistoryPersisted: false, dependencyEdgesMayBePersisted: !dependentTerminal },
  };
  const active = activeExternalBlockers(updated.payload);
  let finalWorkItem = updated;
  let lifecycle: unknown = null;
  if (active.length === 0 && !dependentTerminal) {
    if (updated.state === 'blocked') {
      // The payload write and the edges above are already committed, so a refused
      // restore (e.g. the plan gate while the linked plan item is still blocked)
      // must not report the whole migration as failed. The item stays blocked,
      // which is correct while that gate holds; report the refusal as lifecycle.
      try {
        const restored = await setWorkItemStateWithAliasInfo(input.id, 'open', { harness: input.harness, by });
        if (restored.workItem) finalWorkItem = restored.workItem;
        lifecycle = restored;
      } catch (err) {
        lifecycle = {
          restored: false,
          state: updated.state,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    } else if (updated.family === 'issue') {
      lifecycle = await setWorkItemClaimHold(input.id, false, {
        harness: input.harness,
        by,
        reason: 'external work-item-ref blockers migrated to blocks edges',
      });
    }
  }
  return {
    ok: refused.length === 0,
    id: input.id,
    changed: true,
    workItem: finalWorkItem,
    migration,
    activeBlockers: active,
    blockerHistory: blockers,
    lifecycle,
    ...(refused.length
      ? {
          code: 'work_item_ref_dependency_refused',
          error: refused.map((r) => r.error).join(' | '),
          refusal: workItemRefDependencyRefusal(input.id, refused.map((r) => r.ref).join(',')),
        }
      : {}),
  };
}

/**
 * A completed set_blocker envelope can outlive its dispatch deadline after the blocker,
 * dependency edge, or owner ask already persisted. Name only effects the returned rows prove;
 * an ambiguous/thrown bulk row stays recovery-incomplete so callers re-read before retrying.
 */
export function setBlockerAbortCompletionReceipt(_args: unknown, result: ToolResult): AbortCompletionReceipt {
  const payload = completedResultPayload(result);
  const rows = Array.isArray(payload?.results) ? payload.results : [];
  if (rows.length === 0) {
    return {
      status: 'recovery-incomplete',
      reason: 'work_items:set_blocker result did not contain per-item outcomes after abort',
      failures: ['no-set-blocker-results'],
    };
  }

  const effects = new Set<string>();
  let allExplicitNoOps = true;
  for (const value of rows) {
    const row = asRecord(value);
    const id = typeof row?.id === 'string' ? row.id.trim() : '';
    if (!row || !id) {
      allExplicitNoOps = false;
      continue;
    }
    const partial = asRecord(row.partialOutcome);
    if (row.changed === true || partial?.blockerHistoryPersisted === true) {
      effects.add(`work-item:${id}`);
    }
    if (partial?.ownerAskOpened === true && typeof partial.ownerAskConversationId === 'string') {
      effects.add(`coord-conversation:${partial.ownerAskConversationId}`);
    }
    if (row.ok !== true || row.changed !== false) allExplicitNoOps = false;
  }

  if (effects.size > 0) {
    return { status: 'recorded', effectRef: [...effects].sort().join(',') };
  }
  if (allExplicitNoOps) {
    return { status: 'not-recorded', reason: 'every set_blocker row completed with changed:false' };
  }
  return {
    status: 'recovery-incomplete',
    reason: 'work_items:set_blocker result does not prove whether every requested effect persisted',
    failures: ['set-blocker-effect-unproven'],
  };
}

export default defineTool({
  name: 'work_items:set_blocker',
  profile: 'engineer',
  abortCompletionReceipt: setBlockerAbortCompletionReceipt,
  description:
    "Set/clear typed external blockers (event, gate, runtime, human capability); internal work-item dependencies use work_items:link {rel:'blocks'}. `kind` names the trigger, `capability` what is missing. Shorthands such as `kind:'credential'` normalize to human/credential. Clear preserves history. Non-final work proceeds on staging/current-build; main/:3070 waits require final shipment or a named deployed-only property staging cannot exercise. Include literal 'deployed-only', the staging limitation, and a concrete reason in summary/evidence.",
  guidance: {
    // P-011: response documentation lives here, not in `description` — `returns` is not
    // counted against the 1500-char prompt-weight budget and is demand-loaded via
    // tools:find instead of baked into every system prompt (the WI-9334 pattern).
    returns:
      'activeBlockers (the rows still holding this item), capabilityDispositions (what to await/obtain per capability; under AUTO/DRAIN a standing approval is history-cleared rather than parking the item), ownerAsk (the real coord:ask-owner conversation and choice list opened for a credential/device/service action), and lifecycle. Clearing the LAST blocker returns a feature blocked→todo, or drops the issue-family claim hold. Internal work-item dependencies are not represented here — those stay in work_items:link{rel:\'blocks\'} and plan blocked-by. Omitted legacy rows infer live-dependency; new human rows require a closed-list capability.',
    when: "Use only when a named external condition or human capability actually stops work. Credential/device/service blockers open coord:ask-owner. kind:'product-decision' may park with defaultIfUnanswered + decideBy; owner-authority topics still need the owner. Use a stable ref and name nextVerb when known.",
    notWhen:
      "Use work_items:link {rel:'blocks'} when another work-item must finish first. A vague concern is not a blocker. Do not pause ordinary non-final work for main/:3070/green-checkpoint; staging/current-build is the acceptance plane.",
    chaining:
      'set_blocker {id,kind,ref,…} → follow the returned disposition → set_blocker {id,ref,clear:true,evidence} when resolved. Omit ref on clear-only only when one active blocker matches.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  // This handler only performs independent work-item/mode operations and never
  // reads ctx.tx. Do not hold an ambient workspace transaction while those
  // operations wait on the database; tools:invoke callers otherwise consume a
  // pool slot for the whole handler lifetime.
  skipWorkspaceTx: true,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional(),
      kind: BLOCKER_KIND.optional(),
      capability: BLOCKER_CAPABILITY.optional(),
      ref: z.string().min(1).max(300).optional(),
      summary: fields.summary,
      evidence: fields.evidence,
      nextVerb: z.string().max(300).optional(),
      recheckAt: fields.recheckAt,
      defaultIfUnanswered: z.string().max(500).optional(),
      decideBy: z.string().max(40).optional(),
      defaultAction: fields.defaultAction,
      ownerAuthorityTopic: fields.ownerAuthorityTopic,
      clear: z.boolean().optional(),
      harness: z.string().max(80).optional(),
      migrateWorkItemRefs: fields.migrateWorkItemRefs,
      hold: fields.hold,
      ownerTurnRef: fields.ownerTurnRef,
      items: z.array(itemSpec).min(1).max(100).optional(),
    })
    .strict()
    .refine(
      (args) =>
        (args.items?.length ?? 0) > 0 ||
        (Boolean(args.id) &&
          (Boolean(args.ref) ||
            args.clear === true ||
            args.migrateWorkItemRefs === true ||
            (args.kind === 'hold' && args.hold !== undefined))),
      {
        message:
          'pass { id, ref, kind?, summary? } for one, or items:[{ id, ref, kind?, … }]; clear:true may omit ref when one active blocker matches; migrateWorkItemRefs:true takes only id',
      },
    )
    .superRefine((args, ctx) => {
      validateCapabilityKindAlias(args, ctx);
      validateMigrateOnly(args, ctx);
      if (!args.items?.length) return;
      for (const [index, item] of args.items.entries()) {
        validateMigrateOnly(item, ctx, ['items', index]);
        const holdDerivesRef = item.kind === 'hold' && item.hold !== undefined;
        if (!item.clear && !item.ref && item.migrateWorkItemRefs !== true && !holdDerivesRef) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['items', index, 'ref'],
            message: 'ref is required when setting a blocker',
          });
        }
      }
    })
    .refine(
      (args) =>
        (args.items?.length ?? 0) > 0 ||
        Boolean(args.kind) ||
        args.clear === true ||
        args.migrateWorkItemRefs === true,
      {
        message: 'kind is required when setting a blocker; clear:true may infer kind from ref',
      },
    )
    .superRefine((args, ctx) => {
      if (!args.items?.length) return;
      for (const [index, item] of args.items.entries()) {
        if (!item.kind && item.clear !== true && item.migrateWorkItemRefs !== true) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['items', index, 'kind'],
            message: 'kind is required when setting a blocker; clear:true may infer kind from ref',
          });
        }
      }
    })
    .meta({ 'x-papercusp-call-constraint': SET_BLOCKER_CALL_CONSTRAINT }),
  result: z
    .object({
      rel: z.string().optional(),
      ok: z.boolean().optional(),
      id: z.string().optional(),
      activeBlockers: z.array(z.unknown()).optional(),
      capabilityDispositions: z.unknown().optional(),
      lifecycle: z.unknown().optional(),
      park: z.unknown().optional(),
      ownerAsk: z.object({ conversationId: z.string(), options: z.array(z.string()) }).optional(),
      error: z.string().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const identity = resolveAgentIdentity(ctx);
    const rawItems: BlockerInput[] = args.items?.length
      ? args.items
      : [
          {
            id: args.id as string,
            kind: args.kind as ExternalBlockerKind,
            capability: args.capability,
            ref: args.ref as string,
            summary: args.summary,
            evidence: args.evidence,
            nextVerb: args.nextVerb,
            recheckAt: args.recheckAt,
            defaultIfUnanswered: args.defaultIfUnanswered,
            decideBy: args.decideBy,
            defaultAction: args.defaultAction,
            ownerAuthorityTopic: args.ownerAuthorityTopic,
            clear: args.clear,
            harness: args.harness,
            migrateWorkItemRefs: args.migrateWorkItemRefs,
            hold: args.hold,
            ownerTurnRef: args.ownerTurnRef,
          },
        ];
    const items: NormalizedBlockerInput[] = rawItems.map(normalizeBlockerInput);
    const wantsAutoAuthority = items.some((input) => !input.clear && input.capability === 'approval-auto-clearable');
    let autoAuthority = false;
    if (wantsAutoAuthority) {
      try {
        const modes = await trackPhase(ctx.phases, 'set_blocker:get-modes', () =>
          getModes(identity.workspaceId ?? 'default', identity.ownerId),
        );
        autoAuthority = modes.some((row) => modeImpliesAutonomy(row.mode));
      } catch {
        // Fail closed: a mode-read outage must never fabricate approval.
      }
    }
    const env = await runBulk(
      items,
      async (input) => {
        const workItem = await trackPhase(ctx.phases, 'set_blocker:get-work-item', () =>
          getWorkItem(input.id, input.harness),
        );
        if (!workItem) return { ok: false as const, id: input.id, error: `work_item '${input.id}' not found` };
        if (input.migrateWorkItemRefs) {
          return migrateWorkItemRefRows(input, workItem, identity.ownerId);
        }
        if (!input.clear && TERMINAL.has(workItem.state.toLowerCase())) {
          return {
            ok: false as const,
            id: input.id,
            error: `work_item '${input.id}' is already terminal ('${workItem.state}') — reopen it explicitly before adding an active blocker`,
          };
        }
        // one-work-graph-structured-holds-2026-10-26#D-014: a hold's ref, review date and
        // placer are derived here, never taken from the caller.
        let holdRow: RestrictionHold | undefined;
        const isHold = input.kind === 'hold';
        if (!input.clear && isHold) {
          const prepared = await trackPhase(ctx.phases, 'set_blocker:prepare-hold', () =>
            prepareHoldPlacement({
              workspaceId: identity.workspaceId ?? 'default',
              hold: input.hold,
              reason: input.summary,
              ownerTurnRef: input.ownerTurnRef,
              ctx,
            }),
          );
          if (!prepared.ok) {
            return {
              ok: false as const,
              id: input.id,
              code: prepared.code,
              field: prepared.field,
              error: `work_item '${input.id}' hold refused — ${prepared.error} Blocker was not written.`,
            };
          }
          holdRow = prepared.hold;
          input = { ...input, ref: prepared.ref, recheckAt: prepared.hold.reviewAt };
        }
        if (!input.clear) {
          if (!input.ref) {
            return {
              ok: false as const,
              id: input.id,
              error: `work_item '${input.id}' blocker ref is required when setting a blocker. Blocker was not written.`,
            };
          }
          // WI-10005020 (P-002 / R-14): a ref naming ONLY work-items (bare ids or
          // `work-item:done:<id>` keys) is a dependency, and its one canonical form is
          // the `blocks` edge the claim floors, plans:items blockedBy and the
          // dependency traversal read. Record that edge instead of an external row;
          // the lifecycle is left alone because the edge itself gates claiming.
          // Legacy owner asks can use their own item id as the ask identity.
          // Preserve that existing condition on reassertion; it is not a
          // dependency on the item itself. New bare refs still use the edge
          // writer, and the structured-owner-ask checks below still apply.
          const existingSelfOwnerAsk =
            input.kind === 'human' &&
            isStrictOwnerActionCapability(input.capability) &&
            input.ref.toUpperCase() === input.id.toUpperCase() &&
            activeExternalBlockers(workItem.payload).some((blocker) =>
              blocker.kind === 'human' &&
              blocker.ref === input.ref &&
              blocker.capability === input.capability,
            );
          // A hold ref names its target (often a work-item id) but is not a dependency.
          const referents = existingSelfOwnerAsk || isHold ? null : pureWorkItemDependencyReferents(input.ref);
          if (referents) {
          const linked = await trackPhase(ctx.phases, 'set_blocker:link-dependency', () =>
            linkWorkItemRefDependencies({
              dependentId: input.id,
              harness: input.harness,
              referents,
              by: identity.ownerId,
            }),
          );
            if (!linked.ok) {
              return { ok: false as const, id: input.id, error: linked.error, code: linked.code, refusal: linked.refusal };
            }
            return {
              ok: true as const,
              id: input.id,
              changed: true,
              workItem,
              convertedToEdge: { rel: 'blocks' as const, blockers: linked.edges.map((edge) => edge.blocker) },
              note:
                `Recorded as work_item_deps blocks edge(s) ${referents.join(', ')} → ${input.id}; no external ` +
                'blocker row was written. The edge resolves itself when the blocker is terminal (dropped counts); ' +
                'remove it with work_items:link { rel:"blocks", remove:true }.',
              activeBlockers: activeExternalBlockers(workItem.payload),
              blockerHistory: readExternalBlockers(workItem.payload),
              capabilityDisposition: externalBlockerCapabilityPolicy(input.capability ?? 'live-dependency'),
              autoCleared: false,
            };
          }
          if (input.kind === 'human' && !isHumanBlockerCapability(input.capability)) {
            return {
              ok: false as const,
              id: input.id,
              code: 'human_blocker_capability_required',
              error:
                `work_item '${input.id}' human blocker rejected — choose an explicit closed-list capability ` +
                `(${EXTERNAL_BLOCKER_CAPABILITIES.filter((capability) => capability !== 'live-dependency').join(', ')}). ` +
                'An engineering defect or internal implementation failure remains agent work; do not park it as an untyped human blocker.',
            };
          }
          // WI-2141488: a bare work-item id MIXED with other conditions is still
          // inert as external text — refuse at the write; `clear` is deliberately
          // exempt so rows already carrying a bad ref stay clearable.
          const workItemRef =
            existingSelfOwnerAsk || isHold ? null : workItemRefBlockerProblem({ itemId: input.id, ref: input.ref });
          if (workItemRef) {
            return {
              ok: false as const,
              id: input.id,
              error: `${workItemRef.detail} Blocker was not written.`,
              code: workItemRef.code,
            };
          }
          // A hold restricts an action ('deploy', 'release', …); it is not a wait on the release
          // plane, so the staging-first dependency classifier does not apply to it.
          const stagingFirst = isHold ? null : stagingFirstBlockerProblem({
            itemId: input.id,
            itemText: `${workItem.title ?? ''}\n${workItem.summary ?? ''}`,
            // The staging-first guard classifies dependency semantics, not the
            // caller's provenance note. In particular, evidence commonly names
            // both :3170 and :3070 to say which runtime was measured; feeding
            // that note into the release-plane matcher turns an unrelated gate
            // blocker into a false non-final deployment wait.
            blockerText: [input.ref, input.nextVerb].filter(Boolean).join('\n'),
            // ...but the caller's summary/evidence IS where the refusal tells them to
            // name the deployed-only property, so the narrow exception (and only it)
            // reads them (EI-24018845641231261).
            exceptionText: [input.summary, input.evidence].filter(Boolean).join('\n'),
            kind: input.kind ?? '',
          });
          if (stagingFirst) {
            return {
              ok: false as const,
              id: input.id,
              error: `${stagingFirst.detail} Blocker was not written; use staging/current-build for this work item.`,
              code: stagingFirst.code,
            };
          }
          // event-wait-settlement-2026-10-20 P-006 (D-001 item 2; R-11, R-20): a NEW event or
          // gate wait must name something a fire can prove — every releasing path releases on
          // fireCertifiesCondition, so any other ref strands the item. Re-asserting a row that is
          // already active is not a new wait (pre-existing unprovable rows are handled by the
          // re-check backfill, D-001 item 1), and `clear` never reaches this block.
          const isEventWait = input.kind === 'event' || input.kind === 'gate';
          const reassertsActiveRow = activeExternalBlockers(workItem.payload).some(
            (blocker) => blocker.kind === input.kind && blocker.ref === input.ref,
          );
          if (isEventWait && !reassertsActiveRow) {
            const admission = await trackPhase(ctx.phases, 'set_blocker:admit-wait-ref', () =>
              admitWaitRef(input.ref as string, { surface: 'blocker' }),
            );
            if (!admission.ok) {
              return {
                ok: false as const,
                id: input.id,
                code: admission.code,
                error: `work_item '${input.id}' ${input.kind} blocker refused — ${admission.detail} Blocker was not written.`,
                reachability: admission.reachability,
              };
            }
          }
        }
        const strictHumanAsk =
          !input.clear && input.kind === 'human' && isStrictOwnerActionCapability(input.capability);
        if (strictHumanAsk && (!input.summary?.trim() || !input.nextVerb?.trim())) {
          return {
            ok: false as const,
            id: input.id,
            error:
              `work_item '${input.id}' owner-capability blocker rejected — a structured ask requires both ` +
              '`summary` (the concrete question) and `nextVerb` (what action unblocks it).',
          };
        }
        // Owner-attention ledger (EI-23783029010995961): an ask the owner may never
        // answer must say what the system WILL do in that case, so silence is a
        // stated outcome instead of an invisible chronic deferral. A plain
        // re-assertion of an existing ask may omit it when the record already has one.
        if (strictHumanAsk) {
          const existingDefault = activeExternalBlockers(workItem.payload).find(
            (blocker) => blocker.kind === 'human' && blocker.ref === input.ref,
          )?.defaultIfUnanswered;
          if (!input.defaultIfUnanswered?.trim() && !existingDefault?.trim()) {
            return {
              ok: false as const,
              id: input.id,
              error:
                `work_item '${input.id}' owner-capability blocker rejected — state \`defaultIfUnanswered\`: what the ` +
                'system will do if the owner never answers (e.g. "stays parked; weekly digest re-surfaces it" or ' +
                '"proceeds with option A"). Add `decideBy` (ISO timestamp) when that default has a date. Blocker was not written.',
            };
          }
        }
        if (!input.clear && input.decideBy !== undefined && !Number.isFinite(Date.parse(input.decideBy))) {
          return {
            ok: false as const,
            id: input.id,
            error: `work_item '${input.id}' decideBy '${input.decideBy}' is not a parseable ISO timestamp. Blocker was not written.`,
          };
        }
        if (strictHumanAsk) {
          // EI-13766 requirement 2: preflight plan truth BEFORE persisting the
          // blocker payload. The canonical lifecycle writer repeats this guard,
          // but discovering it only there would leave a half-written human
          // blocker behind after the state transition is rejected.
          const { planItemNeedsHumanContradiction } = await import('../../scheduler/plan-item-lane-guard');
          const contradiction = await trackPhase(ctx.phases, 'set_blocker:check-plan-lane', () =>
            planItemNeedsHumanContradiction(workItem),
          ).catch(() => null);
          if (contradiction) {
            return {
              ok: false as const,
              id: input.id,
              error:
                `work_item '${input.id}' owner-capability blocker rejected — ${contradiction.reason}. ` +
                'Update the plan item to needs-human first; no blocker was written.',
            };
          }
        }

        // consult-backed-parking-2026-10-12 P-005 (R-3, R-13, R-14): a NEW product-decision
        // blocker is a park. It opens a decision-review consult, and the stored blocker ref
        // becomes consult:<id>. Re-asserting an active park (ref already consult:<id>) skips this.
        let parkOpened: import('../../consult/park-door').ParkOpened | null = null;
        if (!input.clear && input.kind === 'human' && input.capability === 'product-decision') {
          const parkDoor = await import('../../consult/park-door');
          const activeRefs = activeExternalBlockers(workItem.payload)
            .filter((blocker) => blocker.kind === 'human' && blocker.capability === 'product-decision')
            .map((blocker) => blocker.ref);
          if (!parkDoor.isParkReassertion(input.ref, activeRefs)) {
            if (input.defaultAction !== undefined) {
              return {
                ok: false as const,
                id: input.id,
                code: 'park_default_action_unsupported',
                error:
                  `work_item '${input.id}' product-decision park rejected — \`defaultAction\` belongs to owner asks; ` +
                  'a park resolves through its decision-review consult. Omit defaultAction. Blocker was not written.',
              };
            }
            const park = await trackPhase(ctx.phases, 'set_blocker:open-decision-park', () =>
              parkDoor.openDecisionReviewPark(
                {
                  workItemId: input.id,
                  setterId: identity.ownerId,
                  question: input.summary?.trim() || input.ref || input.id,
                  defaultIfUnanswered: input.defaultIfUnanswered,
                  decideBy: input.decideBy,
                  ownerAuthorityTopic: input.ownerAuthorityTopic ?? null,
                  callerRef: input.ref,
                },
                parkDoor.makeProdParkDoorDeps(identity),
              ),
            );
            if (!park.ok) {
              return { ok: false as const, id: input.id, code: park.code, error: `work_item '${input.id}' ${park.error}` };
            }
            parkOpened = park.park;
          }
        }

        let ownerAsk: { conversationId: string; options: string[] } | null = null;
        let ownerAskConversationId: string | undefined;
        if (!input.clear && input.kind === 'human' && isDirectHumanCapability(input.capability)) {
          const currentAsk = activeExternalBlockers(workItem.payload).find(
            (blocker) =>
              blocker.kind === 'human' &&
              blocker.capability === input.capability &&
              blocker.ref === input.ref,
          );
          const effectiveDefault =
            input.defaultIfUnanswered?.trim() || currentAsk?.defaultIfUnanswered?.trim() || '';
          const unchangedAsk = Boolean(
            currentAsk?.ownerAskConversationId &&
            currentAsk.summary === input.summary?.trim() &&
            currentAsk.nextVerb === input.nextVerb?.trim() &&
            currentAsk.defaultIfUnanswered?.trim() === effectiveDefault,
          );
          if (unchangedAsk) {
            ownerAskConversationId = currentAsk!.ownerAskConversationId;
            ownerAsk = {
              conversationId: ownerAskConversationId!,
              options: directHumanCapabilityChoices(input.capability),
            };
          } else {
            try {
              ownerAsk = await trackPhase(ctx.phases, 'set_blocker:open-owner-ask', () =>
                openDirectHumanCapabilityQuestion(
                  input,
                  identity,
                  ctx,
                  effectiveDefault,
                  currentAsk?.ownerAskConversationId,
                ),
              );
              ownerAskConversationId = ownerAsk.conversationId;
            } catch (error) {
              return {
                ok: false as const,
                id: input.id,
                code: 'owner_ask_failed',
                error:
                  `work_item '${input.id}' owner-capability blocker rejected — coord:ask-owner could not be opened: ` +
                  `${error instanceof Error ? error.message : String(error)}. Blocker was not written.`,
              };
            }
          }
        }

        // A clear-only request may omit kind when the ref points to exactly one
        // active blocker. Keep the (kind, ref) identity strict when a ref is
        // reused across different blocker kinds, rather than clearing the wrong
        // dependency. The schema already rejects kind-less set requests; this
        // guard is defensive for callers that bypass parsing.
        let resolvedKind = input.kind;
        let resolvedRef = parkOpened ? parkOpened.blockerRef : input.ref;
        if (input.clear && !resolvedRef) {
          const active = activeExternalBlockers(workItem.payload);
          const candidates = resolvedKind ? active.filter((blocker) => blocker.kind === resolvedKind) : active;
          if (candidates.length > 1) {
            const qualifier = resolvedKind ? ` of kind '${resolvedKind}'` : '';
            return {
              ok: false as const,
              id: input.id,
              error:
                `work_item '${input.id}' clear-only blocker request omitted ref but matches ${candidates.length} active blockers${qualifier}; ` +
                'pass ref explicitly',
            };
          }
          const candidate = candidates[0];
          if (!candidate) {
            return {
              ok: true as const,
              id: input.id,
              changed: false,
              workItem,
              activeBlockers: active,
              blockerHistory: readExternalBlockers(workItem.payload),
              capabilityDisposition: externalBlockerCapabilityPolicy(input.capability ?? 'live-dependency'),
              autoCleared: false,
            };
          }
          resolvedKind = candidate.kind;
          resolvedRef = candidate.ref;
        } else if (input.clear && !resolvedKind) {
          // A clear-only request with a ref may omit kind when the ref points to
          // exactly one active blocker. Keep the (kind, ref) identity strict when
          // a ref is reused across different blocker kinds.
          const matchingKinds = [
            ...new Set(
              activeExternalBlockers(workItem.payload)
                .filter((blocker) => blocker.ref === resolvedRef)
                .map((blocker) => blocker.kind),
            ),
          ];
          if (matchingKinds.length > 1) {
            return {
              ok: false as const,
              id: input.id,
              error:
                `work_item '${input.id}' clear-only blocker ref '${resolvedRef}' is ambiguous across kinds ` +
                `(${matchingKinds.join(', ')}); pass kind explicitly`,
            };
          }
          resolvedKind = matchingKinds[0];
          if (!resolvedKind) {
            return {
              ok: true as const,
              id: input.id,
              changed: false,
              workItem,
              activeBlockers: activeExternalBlockers(workItem.payload),
              blockerHistory: readExternalBlockers(workItem.payload),
              capabilityDisposition: externalBlockerCapabilityPolicy(input.capability ?? 'live-dependency'),
              autoCleared: false,
            };
          }
        }
        if (!resolvedKind || !resolvedRef) {
          return {
            ok: false as const,
            id: input.id,
            error: input.clear
              ? 'clear-only blocker requests need an active blocker ref to resolve'
              : 'kind and ref are required when setting a blocker',
          };
        }
        if (input.clear && resolvedKind === 'hold') {
          // R-6: an owner hold lifts only on a verified owner turn; P-011 adds the review verbs.
          const activeHold = activeExternalBlockers(workItem.payload).find(
            (blocker) => blocker.kind === 'hold' && blocker.ref === resolvedRef,
          );
          const lift = await trackPhase(ctx.phases, 'set_blocker:check-hold-lift', () =>
            checkHoldLift(activeHold?.hold, { ownerTurnRef: input.ownerTurnRef, ctx }),
          );
          if (!lift.ok) {
            return {
              ok: false as const,
              id: input.id,
              code: lift.code,
              field: lift.field,
              error: `work_item '${input.id}' hold not lifted — ${lift.error}`,
            };
          }
        }

        const history = applyExternalBlockerUpdate(
          workItem.payload,
          {
            kind: resolvedKind,
            capability: input.capability,
            ref: resolvedRef,
            summary: input.summary,
            evidence: parkOpened ? [input.evidence, parkOpened.evidence].filter(Boolean).join('\n') : input.evidence,
            nextVerb: input.nextVerb,
            recheckAt: input.recheckAt,
            defaultIfUnanswered: input.defaultIfUnanswered,
            decideBy: parkOpened ? parkOpened.deadlineAt : input.decideBy,
            defaultAction: input.defaultAction,
            ownerAskConversationId,
            clear: input.clear,
            ...(holdRow ? { hold: holdRow } : {}),
          },
          identity.ownerId,
          { autoAuthority },
        );
        if (!history.changed) {
          return {
            ok: true as const,
            id: input.id,
            changed: false,
            workItem,
            activeBlockers: activeExternalBlockers(workItem.payload),
            blockerHistory: history.blockers,
            capabilityDisposition: externalBlockerCapabilityPolicy(
              input.capability ??
                history.blockers.at(-1)?.capability ??
                (resolvedKind === 'human' ? 'product-decision' : 'live-dependency'),
            ),
            autoCleared: history.autoCleared,
            ...(ownerAsk ? { ownerAsk } : {}),
          };
        }

        const active = history.blockers.filter((blocker) => blocker.status === 'active');
        // WI-2146530: lifecycle follows the blockers that REMAIN after this
        // update, not the shape of the current request. A partial clear has
        // `input.clear=true`, so `strictHumanAsk` is necessarily false even
        // when a credential / physical-device / external-service blocker is
        // still active. Parking that row as generic `blocked` removes it from
        // the owner-action queue despite the surviving blocker still requiring
        // owner capability.
        //
        // D-029: "strict" is the hold registry's answerable ask (structured AND carrying
        // defaultIfUnanswered), the same predicate the canonical needs-human writer refuses
        // on. A surviving LEGACY ask with no default parks as `blocked` (an owner-clearer
        // blocker hold) instead of a needs-human write the writer would refuse.
        const remainingStrictHumanAsk = hasActiveStrictHumanAsk({ externalBlockers: active });
        const ownerFlagUnset = ownerActionFlagsReleasedByClear(workItem.payload, active, {
          kind: resolvedKind,
          cleared: input.clear === true,
        });
        const updated = await trackPhase(ctx.phases, 'set_blocker:merge-blocker-history', () =>
          mergeWorkItemPayload(
            input.id,
            { externalBlockers: history.blockers },
            {
              harness: input.harness,
              expectedExternalBlockers: (workItem.payload as { externalBlockers?: unknown } | null)?.externalBlockers,
              requireNonTerminal: !input.clear && !history.autoCleared,
              ...(ownerFlagUnset.length > 0 ? { unset: ownerFlagUnset } : {}),
            },
          ),
        );
        if (!updated) {
          return {
            ok: false as const, id: input.id, code: 'blocker_history_conflict',
            error: 'Blocker history or lifecycle changed, or the row became unwritable. This attempt wrote no blocker history or lifecycle. Read work_items:get before retrying.',
            ...(ownerAsk ? {
              ownerAsk,
              partialOutcome: {
                blockerHistoryPersisted: false,
                ownerAskOpened: true,
                ownerAskConversationId: ownerAsk.conversationId,
              },
            } : {}),
          };
        }

        // EI-13301 fix: `finalWorkItem` tracks the POST-transition snapshot so the
        // response never reports pre-write state (Defect 2 — a caller that trusts the
        // return value couldn't see the item had just been parked/restored).
        let finalWorkItem = updated;
        let lifecycle: unknown = null;
        try {
          if (active.length > 0) {
            lifecycle = await trackPhase(ctx.phases, 'set_blocker:set-lifecycle', () =>
              setWorkItemStateWithAliasInfo(
                input.id,
                remainingStrictHumanAsk ? 'needs-human' : 'blocked',
                {
                  harness: input.harness,
                  by: identity.ownerId,
                },
              ),
            );
          } else if (updated.family === 'feature' && updated.state === 'blocked') {
            // work-item-status-full-unify P-007: restore to the UNIFIED claimable token
            // 'open' directly (was 'todo', which only reached 'open' via the legacy
            // alias-fold + mis-reported the synced state — same class as the
            // planSyncWorkItemState re-open writer fixed in P-005).
            lifecycle = await trackPhase(ctx.phases, 'set_blocker:set-lifecycle', () =>
              setWorkItemStateWithAliasInfo(input.id, 'open', {
                harness: input.harness,
                by: identity.ownerId,
              }),
            );
          } else if (updated.family === 'issue') {
            lifecycle = await trackPhase(ctx.phases, 'set_blocker:release-claim-hold', () =>
              setWorkItemClaimHold(input.id, false, {
                harness: input.harness,
                by: identity.ownerId,
                reason: `external blocker ${resolvedKind}:${resolvedRef} cleared`,
              }),
            );
          }
          if (lifecycle && typeof lifecycle === 'object' && 'workItem' in lifecycle) {
            const lifecycleItem = (lifecycle as { workItem?: typeof updated }).workItem;
            if (lifecycleItem) finalWorkItem = lifecycleItem;
          }
          // EI-13301 Defect 1 backstop: state:'blocked' must never survive with zero
          // active blockers — that combination is invisible to claim_next/scheduler:get_next
          // AND carries no blocker explaining the exclusion (a stranded item nobody can
          // find). If the branches above didn't clear it for any reason (a race with a
          // concurrent write, an unhandled family/state combination, …), force the
          // restore now rather than leaving the item silently orphaned.
          // WI-10005104: the same stranding exists for an ISSUE-family item parked as
          // `needs-human` on a strict human ask — setWorkItemClaimHold above only strips
          // payload hold keys and never touches `status`, so clearing the last ask left
          // `needs-human` with zero blockers (unclaimable AND unexplained). Feature-family
          // `needs-human` is deliberately excluded: it can be the plan lane's own state.
          const strandedIssueNeedsHuman = updated.family === 'issue' && finalWorkItem.state === 'needs-human';
          if (active.length === 0 && (finalWorkItem.state === 'blocked' || strandedIssueNeedsHuman)) {
            const restored = await trackPhase(ctx.phases, 'set_blocker:restore-lifecycle', () =>
              setWorkItemStateWithAliasInfo(
                input.id,
                // work-item-status-full-unify P-007: both families restore to the unified
                // claimable token 'open' (feature `todo`→`open` collapsed the duality).
                'open',
                { harness: input.harness, by: identity.ownerId },
              ),
            );
            if (restored.workItem) finalWorkItem = restored.workItem;
            lifecycle = lifecycle ?? restored;
          }
        } catch (error) {
          // The payload write above already committed. Return a structured
          // partial outcome with the authoritative post-failure row so a caller
          // can recover without blindly repeating a clear that has taken effect.
          // A failed re-read is reported as UNREADABLE, never folded into "no row" (WI-6746).
          const lookup = await trackPhase(ctx.phases, 'set_blocker:recover-work-item', () =>
            lookupWorkItem(input.id, input.harness),
          );
          let persisted = lookup.status === 'found' ? lookup.item : null;
          let persistedActive = persisted ? activeExternalBlockers(persisted.payload) : active;
          let persistedState = persisted?.state ?? null;
          let planLaneRepair: { planSlug: string; itemIds: string[]; results: unknown[] } | null = null;
          if (input.clear && persisted && persistedState === 'blocked' && persistedActive.length === 0) {
            planLaneRepair = await resyncLinkedPlanLaneAfterLifecycleFailure(persisted);
            if (planLaneRepair) {
              // The reconciler may have added the provenance-carrying plan-lane
              // blocker or restored the row. Re-read so the partial outcome names
              // the authoritative post-repair state, not the pre-repair snapshot.
              const repaired = await trackPhase(ctx.phases, 'set_blocker:recover-work-item-after-plan-lane', () =>
                lookupWorkItem(input.id, input.harness),
              );
              if (repaired.status === 'found') {
                persisted = repaired.item;
                persistedActive = activeExternalBlockers(repaired.item.payload);
                persistedState = repaired.item.state;
              }
            }
          }
          const stateText = persistedState ??
            (lookup.status === 'unreadable' ? `unreadable (${lookup.error})` : 'unavailable (row not found)');
          return {
            ok: false as const,
            id: input.id,
            code: input.clear ? 'partial-clear' : 'partial-set',
            error: `typed blocker persisted, but lifecycle transition failed: ${error instanceof Error ? error.message : String(error)}. ` +
              `Current state: ${stateText}; active blockers: ${persistedActive.length}. ` +
              'Read work_items:get before recovery; do not repeat the clear blindly.',
            partialOutcome: {
              blockerHistoryPersisted: true,
              lifecycleApplied: false,
              currentState: persistedState,
              activeBlockerCount: persistedActive.length,
              recoveryAction: planLaneRepair && persistedActive.length > 0
                ? `Plan lane ${planLaneRepair.planSlug}#${planLaneRepair.itemIds.join(',')} was re-synced; keep its active plan-lane blocker and retry after the lane clears.`
                : persistedState === 'blocked' && persistedActive.length === 0
                  ? 'Reopen the item through work_items:set_state after checking for independent work-item dependencies.'
                  : 'Read work_items:get and repair the lifecycle state indicated by the remaining blockers.',
            },
            workItem: persisted ?? updated,
            activeBlockers: persistedActive,
            blockerHistory: persisted ? readExternalBlockers(persisted.payload) : history.blockers,
            ...(planLaneRepair ? { planLaneRepair } : {}),
          };
        }

        return {
          ok: true as const,
          id: input.id,
          changed: true,
          workItem: finalWorkItem,
          activeBlockers: active,
          blockerHistory: history.blockers,
          capabilityDispositions: active.map((blocker) => externalBlockerCapabilityPolicy(blocker.capability)),
          capabilityDisposition: externalBlockerCapabilityPolicy(
            input.capability ??
              history.blockers.at(-1)?.capability ??
              (resolvedKind === 'human' ? 'product-decision' : 'live-dependency'),
          ),
          autoCleared: history.autoCleared,
          lifecycle,
          ...(parkOpened ? { park: parkOpened } : {}),
          ...(ownerAsk ? { ownerAsk } : {}),
          ...(resolvedKind === 'event' && !input.clear && !history.autoCleared ? { await: { event: resolvedRef } } : {}),
        };
      },
      { keyOf: (input) => ({ id: input.id, kind: input.kind, ref: input.ref }) },
    );
    return bulkContent(env);
  },
});
