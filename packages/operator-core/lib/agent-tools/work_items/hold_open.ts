/**
 * work_items:hold_open — hold a work-item OPEN in place, WITHOUT releasing your
 * claim (fleet-deltas-leader-primitives-2026-07-10 P-006; EI-8993 / EI-8973).
 *
 * The gap this closes: release { claimHold:true } is release-and-hold — the
 * leader pattern (WI-3548) is "I keep working/gating this item, but nobody may
 * close it or self-select it out from under me". hold_open stamps
 * `held_open_by` + `held_open_reason` on the payload (setWorkItemClaimHold):
 *   - claim_next / scheduler:get_next skip it (both claim floors honor _claimHold),
 *   - a TERMINAL transition by a NON-holder is refused (setWorkItemState's
 *     held-open guard) until the holder clears or closes it themselves,
 *   - the claim itself is untouched — the holder keeps working it.
 * `clear:true` lifts the hold (holder or force). The lifecycle note is
 * best-effort: a coord hiccup never un-holds the item.
 *
 * ⚠ EI-20710656847511624 — THIS TOOL IS THE WRONG ONE FOR A FENCE THAT MUST OUTLIVE YOU, and
 * its description now says so at CHOOSE time (it previously mentioned the sibling park only as
 * an AUDIT-time footnote, which is not where the decision gets made). The hold is a LEASE:
 * `sweepDeadOwnerControlState` / `reclaimStaleHoldOpens` match on `held_open_by = <dead owner>`
 * and lift the hold + `_claimHold` once the holder is past grace, so the item silently re-enters
 * the self-select pool when the fencing session dies. Both sweeps preserve a coexisting durable
 * park (`claim_hold_by`) and both exempt a policy-tier `held_open_reason` via the same shared
 * pattern constant — but that exemption keys off free-text reason WORDING, so it is not a
 * durability guarantee anyone should lean on.
 *   Measured: THREE agents in a row (2026-07-27 via a bare claim, su-89f241ac 2026-08-02 via
 * hold_open, su-a787d98c 2026-08-17 via hold_open) each fenced the SAME owner-gated live-money
 * items (WI-6175 / WI-5735) intending "permanent" and each got "until I die" — the 08-02 lease
 * was verified intact at 06:16Z and was gone by 08-17. When competent agents repeat a
 * predecessor's exact error, the defect is the AFFORDANCE, not the agents: the choose-time text
 * never mentioned the reaper. Both items are now durably parked via release { claimHold:true }.
 *
 * ⚠ EI-18672701535825889: `held_open_by`/`held_open_reason` is ONE of TWO `_claimHold`
 * provenance conventions, not the only one. `release { claimHold:true }` writes a SIBLING
 * convention — `claim_hold_by`/`claim_hold_reason` (a durable PARK: no reaper, no
 * terminal-transition gate, survives the parker's session ending — see
 * setWorkItemClaimHold's doc comment for the deliberate lease-vs-park split). An audit that
 * checks only this tool's fields will read every `claim_hold_by` row (the majority of held
 * rows on this harness) as unattributed — several are deliberate policy-tier human gates, not
 * corruption. Always read via `readWorkItemClaimHoldProvenance` (checks both), never
 * `readWorkItemHeldOpenBy` alone, when auditing why a row is held.
 *
 * Plan bug-queue-legitimacy-and-actionable-validation-2026-10-10 D-009 — `clear` with
 * `reconcile` is the AGENT DOOR to the evidence-based durable-park clearer
 * (`runWorkItemDurableParkReconciliation`). Before it, that clearer was reachable only
 * through the `work-item-durable-park-audit` system action with a `mode:'reconcile'`
 * payload, and `routines:fire` takes no payload — so a park whose release condition had
 * been met (65 of 108 live parks measured 2026-10-10 had no typed trigger the event
 * resolver could fire) had no clearer any agent could reach except `force:true`, which
 * skips the fingerprint/evidence contract entirely. The reconcile path needs no force:
 * its authority is the evidence plus a compare-and-set on the park's control-state
 * fingerprint, recorded as a `work_items:durable_park:clear` audit receipt. Never clear
 * a park by age or by the parker's death (plan D-018/D-022/D-023 of the UBP lineage).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { sendMessage } from '../coordination/messages';
import {
  setWorkItemClaimHold,
  readWorkItemClaimHoldProvenance,
  looksLikePolicyGate,
} from '../../work-items';
import {
  DURABLE_PARK_CLEAR_REASON_CODES,
  durableParkFingerprint,
  durableParkSingleReconcileRunId,
  planDurableParkClear,
  readDurableParkControlRow,
  runWorkItemDurableParkReconciliation,
  type DurableParkReconcileOutcome,
} from '../../work-items-durable-park-audit';
import { lookupWorkItem } from './_lookup';

/** What to do next for each non-clearing reconcile outcome (returned beside the verbatim outcome). */
const RECONCILE_HINTS: Record<Exclude<DurableParkReconcileOutcome, 'cleared'>, string> = {
  'stale-fingerprint':
    'The park control state changed since that fingerprint was read. Re-read with reconcile.dryRun:true, re-check ' +
    'your evidence against the CURRENT park, then retry with the new observedParkFingerprint.',
  assigned:
    'The item is claimed (takenBy). A park is never cleared from under a live holder — coordinate with the holder.',
  'unverified-condition':
    'The park\'s release condition/trigger contradicts itself (pause/completion/resume), so condition-satisfied ' +
    'cannot be verified against it. Use the reason code your evidence actually supports.',
  'not-durable-park': 'claim_hold_by is present but _claimHold is not true — the row is not excluded; nothing to clear.',
  'already-cleared':
    'No durable park (claim_hold_by) is present — nothing to clear. A held_open lease, if any, is untouched.',
  missing: 'No row with this id in this workspace/harness.',
};

const reconcileArg = z
  .object({
    reasonCode: z
      .enum(DURABLE_PARK_CLEAR_REASON_CODES)
      .describe(
        'why the park may end: condition-satisfied (its stated release condition is met) | duplicate-terminal | ' +
          'review-completed | typed-blocker-resolved | operator-directed (needs ownerOverride:true)',
      ),
    evidence: z
      .string()
      .trim()
      .min(1)
      .max(4000)
      .describe('concrete, re-checkable proof the condition holds (a sha + containment check, a terminal item id, …) — never age or parker death'),
    expectedParkFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
      .describe('observedParkFingerprint from a dryRun read; omitted ⇒ dry run (nothing is written)'),
    dryRun: z.boolean().optional().describe('preview the outcome and return observedParkFingerprint; writes nothing'),
  })
  .describe(
    'with clear:true, settle a DURABLE PARK on evidence instead of force: fingerprint compare-and-set + audit receipt ' +
      '(plan D-009). Read first (dryRun), then re-call with expectedParkFingerprint. A coexisting held_open lease survives.',
  );

// EI-18672701535825889 / WI-5946: looksLikePolicyGate moved to work-items.ts so
// work_items:claim's claim-hold guard (claim.ts) shares the SAME predicate instead of a
// second copy that could drift — a reason naming a deliberate policy-tier human gate (a
// `D-NNN` decision id, the triage gate's own `triageDecision:"gate"` marker, or the literal
// phrase "policy-tier") must not be liftable/claimable by a bare `force:true`.

export default defineTool({
  name: 'work_items:hold_open',
  profile: 'engineer',
  description:
    'Hold a work-item OPEN without releasing your claim: stamps you as held_open_by (+ reason), excludes it from ' +
    'claim_next/scheduler self-select, and refuses a terminal transition by anyone ELSE until you clear it. ' +
    '{ id, reason } to hold; { id, clear:true } to lift (another agent\'s hold needs force:true). A durable park ' +
    'whose release condition is met: { id, clear:true, reconcile:{ reasonCode, evidence } } — evidence + fingerprint ' +
    'CAS, no force. ⚠ THIS HOLD IS A LEASE: the WI-4531 dead-owner reaper lifts it once you are dead past grace. A ' +
    'fence that must OUTLIVE your session (an owner-gated item, a policy decision) needs release { claimHold:true } ' +
    // P-011 prompt-weight: the burn_down audit pointer moved to the free `returns`, beside
    // the not_holder refusal that names the same two conventions (EI-22083648545226771).
    '— a durable PARK (claim_hold_by) no reaper touches.',
  guidance: {
    when:
      'You are gating an item — verifying, awaiting evidence, or keeping a recurring/leader item alive — and peers must ' +
      'neither close it nor self-select it while you do. Your claim stays; work continues.',
    notWhen:
      'You are WALKING AWAY from the item, or the fence must OUTLIVE your session — that is work_items:park (checkpoint ' +
      '+ release) or release { claimHold:true } (release + hold). Blocked on an external event/gate/runtime/human condition → ' +
      'work_items:set_blocker. Blocked by another work-item → work_items:link { rel:"blocks" }. Done → ' +
      'complete (a holder completing their own held item is allowed).',
    chaining:
      'work_items:hold_open { id, reason } → work → complete/set_state yourself (holder passes the guard), or hold_open { id, clear:true } to hand it back to normal lifecycle.',
    returns:
      'Hold: { ok, id, held:true, heldBy, reason, note? } (note is set when you re-stamped another agent\'s hold). ' +
      'Clear: { ok, id, held:false, clearedFrom }. Refusals: not_holder (+ heldBy, reason, convention — says whether ' +
      'you hit a held_open LEASE or a claim_hold DURABLE PARK), policy_gate_requires_owner_override (force:true alone ' +
      'is refused for a policy-tier reason; a policy-tier reason is also exempt from the reaper, but do NOT rely on ' +
      'reason wording for durability — park it), work_item_unreadable (a READ failure, not a missing item: retry ' +
      'rather than re-filing), clear_failed, hold_failed. Auditing why a row is held? read work_items:burn_down\'s ' +
      'parked reason — it checks both conventions. Reconcile (plan D-009): dry run → { ok, dryRun:true, outcome, ' +
      'wouldClear, observedParkFingerprint, ownerOverrideRequired, park }; apply → { ok, outcome, held, clearedFrom, ' +
      'observedParkFingerprint, preservedLease, runId, artifactPath }. outcome is the reconciler\'s verbatim verdict: ' +
      'cleared | already-cleared (ok) | stale-fingerprint | assigned | unverified-condition | not-durable-park | ' +
      'missing (ok:false, error reconcile_<outcome>, + hint). Identical input replays the recorded run. Refusals: ' +
      'policy_gate_requires_owner_override, operator_directed_requires_owner_override, reconcile_scope_unresolved, ' +
      'reconcile_failed.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).describe('the work-item id to hold open (or clear)'),
      reason: z.string().min(1).max(500).optional().describe('why it must stay open — stamped as held_open_reason + broadcast (required unless clear:true)'),
      clear: z.boolean().optional().describe('true lifts the hold instead of setting it'),
      force: z.boolean().optional().describe('clear ANOTHER agent\'s hold (leader override only; default false refuses with not_holder) — checked against BOTH claim-hold provenance conventions (held_open_by lease AND claim_hold_by durable park)'),
      ownerOverride: z
        .boolean()
        .optional()
        .describe(
          'REQUIRED (in addition to force) to clear a hold whose reason names a policy-tier gate (a D-NNN decision id, ' +
            'triageDecision:"gate", or "policy-tier") — force:true alone refuses it (EI-18672701535825889).',
        ),
      reconcile: reconcileArg.optional(),
      harness: z.string().max(80).optional().describe('harness the item lives under (else resolved from the item)'),
    })
    .refine((a) => a.clear === true || Boolean(a.reason), { message: 'pass { reason } to hold, or { clear:true } to lift' })
    .refine((a) => !a.reconcile || a.clear === true, { message: 'reconcile settles a park — pass it with clear:true' }),
  result: z
    .object({
      ok: z.boolean().optional(),
      id: z.string().optional(),
      held: z.boolean().optional(),
      heldBy: z.string().nullable().optional(),
      reason: z.string().optional(),
      note: z.string().optional(),
      clearedFrom: z.unknown().optional(),
      error: z.string().optional(),
      convention: z.unknown().optional(),
    })
    .passthrough(),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const c = ctx as { harnessSlug?: string | null };
    const hint = args.harness ?? c.harnessSlug ?? undefined;
    const hintHarness = hint && hint !== '*' ? hint : undefined;
    const fail = (payload: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, id: args.id, ...payload }) }],
    });
    // WI-6746: an unreadable item must not be reported as an absent one — the caller is
    // about to place or clear a HOLD, and "not found" sends them to re-file or re-create
    // rather than retry. Absence and unreachability are different answers.
    const lookup = await lookupWorkItem(args.id, hintHarness);
    if (lookup.status === 'unreadable') {
      return fail({
        error: `work_item_unreadable — could not read '${args.id}' (${lookup.error}). This is a READ FAILURE, not a missing item: retry rather than re-filing it.`,
      });
    }
    if (lookup.status === 'missing') return fail({ error: `work_item '${args.id}' not found` });
    const item = lookup.item;
    // EI-18672701535825889: check BOTH claim-hold provenance conventions — a row held ONLY via
    // the durable-park convention (claim_hold_by, no held_open_by) previously slipped through
    // this guard entirely (readWorkItemHeldOpenBy alone returned null ⇒ `prior` falsy ⇒ no
    // not_holder check, no force required), silently clearing another agent's park.
    const provenance = readWorkItemClaimHoldProvenance(item.payload);
    const prior = provenance.heldOpen ?? provenance.parked;
    const ok = (payload: Record<string, unknown>) => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ id: args.id, ...payload }) }],
    });
    if (args.clear && args.reconcile) {
      // D-009: settle a DURABLE PARK on evidence. No `force` and no not_holder check — the
      // authority is the evidence plus the fingerprint CAS, and the parker is routinely gone.
      // The two owner-authority gates still apply to the WRITE (a dry run only reads).
      const rc = args.reconcile;
      const park = provenance.parked;
      const policyGated = Boolean(park && park.by !== ident.ownerId && looksLikePolicyGate(park.reason));
      const ownerOverrideRequired = policyGated || rc.reasonCode === 'operator-directed';
      const workspaceId = ident.workspaceId ?? null;
      const harnessSlug = item.harness ?? null;
      if (!workspaceId || !harnessSlug) {
        return fail({
          error: 'reconcile_scope_unresolved',
          hint: `Could not resolve ${!workspaceId ? 'your workspace' : `the harness of ${args.id}`} — the reconciler is workspace+harness scoped. Pass harness explicitly or retry from a workspace-bound session.`,
        });
      }
      let row: Awaited<ReturnType<typeof readDurableParkControlRow>>;
      try {
        row = await readDurableParkControlRow({ workspaceId, harnessSlug, id: item.id });
      } catch (err) {
        return fail({
          error: `work_item_unreadable — could not read the park control state of '${args.id}' (${err instanceof Error ? err.message : String(err)}). This is a READ FAILURE: retry.`,
        });
      }
      if (!row) return fail({ error: 'reconcile_missing', outcome: 'missing', hint: RECONCILE_HINTS.missing });
      const observedParkFingerprint = durableParkFingerprint({ state: row.state, takenBy: row.takenBy, payload: row.payload });
      const parkView = park
        ? { by: park.by, reason: park.reason, at: park.at, releaseCondition: (row.payload as { claim_hold_release?: unknown } | null)?.claim_hold_release ?? null }
        : null;
      if (rc.dryRun || !rc.expectedParkFingerprint) {
        const plan = planDurableParkClear(row, {
          id: row.id,
          expectedParkFingerprint: rc.expectedParkFingerprint ?? observedParkFingerprint,
          reasonCode: rc.reasonCode,
          evidence: rc.evidence,
        });
        return ok({
          ok: true,
          dryRun: true,
          outcome: plan.outcome,
          // An owner-gated row only clears WITH ownerOverride; reporting wouldClear:true without it
          // made a batch settler read "cleared" and then hit policy_gate_requires_owner_override.
          wouldClear: plan.outcome === 'cleared' && (!ownerOverrideRequired || args.ownerOverride === true),
          observedParkFingerprint,
          expectedParkFingerprint: rc.expectedParkFingerprint ?? null,
          preservedLease: plan.preservedLease,
          takenBy: plan.takenBy,
          ownerOverrideRequired,
          park: parkView,
          next:
            plan.outcome === 'cleared'
              ? `Nothing written. To apply, re-call with reconcile.expectedParkFingerprint:"${observedParkFingerprint}" (no dryRun)${ownerOverrideRequired ? ' and ownerOverride:true (owner sign-off only)' : ''}.`
              : RECONCILE_HINTS[plan.outcome],
        });
      }
      if (policyGated && !args.ownerOverride) {
        return fail({
          error: 'policy_gate_requires_owner_override',
          heldBy: park?.by ?? null,
          reason: park?.reason ?? null,
          convention: 'claim_hold (durable park)',
          hint: `${args.id} is parked for a policy-tier reason — evidence alone does not lift an owner gate. Pass ownerOverride:true only with genuine owner sign-off (EI-18672701535825889).`,
        });
      }
      if (rc.reasonCode === 'operator-directed' && !args.ownerOverride) {
        return fail({
          error: 'operator_directed_requires_owner_override',
          hint: 'reasonCode operator-directed asserts an owner/operator instruction; pass ownerOverride:true with that sign-off cited in evidence, or use the reason code your evidence supports.',
        });
      }
      const decision = {
        id: row.id,
        expectedParkFingerprint: rc.expectedParkFingerprint,
        reasonCode: rc.reasonCode,
        evidence: rc.evidence,
      };
      const runId = durableParkSingleReconcileRunId({ workspaceId, harnessSlug, actor: ident.ownerId, decision });
      let result: Awaited<ReturnType<typeof runWorkItemDurableParkReconciliation>>;
      try {
        result = await runWorkItemDurableParkReconciliation({
          workspaceId,
          harnessSlug,
          actor: ident.ownerId,
          decisions: [decision],
          runId,
        });
      } catch (err) {
        return fail({ error: `reconcile_failed — ${err instanceof Error ? err.message : String(err)}`, runId });
      }
      const r = result.rows[0];
      if (!r) return fail({ error: 'reconcile_failed — the reconciler returned no row for the decision', runId });
      if (r.outcome === 'cleared') {
        await sendMessage(ident, {
          to: ['*'],
          summary: `🔓 ${args.id} durable park CLEARED by ${ident.ownerId} on evidence (${rc.reasonCode}${park ? `; was parked by ${park.by}` : ''}) — ${rc.evidence.slice(0, 120)}`,
          harnessSlug,
          extra: { auto: true, lifecycle: 'durable_park_reconcile', work_item: args.id, runId },
        }).catch(() => {});
      }
      const settled = r.outcome === 'cleared' || r.outcome === 'already-cleared';
      return ok({
        ok: settled,
        outcome: r.outcome,
        ...(settled ? {} : { error: `reconcile_${r.outcome}`, hint: RECONCILE_HINTS[r.outcome as Exclude<DurableParkReconcileOutcome, 'cleared'>] }),
        ...(r.outcome === 'already-cleared' ? { hint: RECONCILE_HINTS['already-cleared'] } : {}),
        held: r.outcome === 'cleared' ? r.preservedLease : undefined,
        clearedFrom: r.outcome === 'cleared' ? (park?.by ?? null) : undefined,
        observedParkFingerprint: r.observedParkFingerprint,
        expectedParkFingerprint: r.expectedParkFingerprint,
        preservedLease: r.preservedLease,
        takenBy: r.takenBy,
        runId: result.runId,
        artifactPath: result.artifactPath,
      });
    }
    if (args.clear) {
      if (prior && prior.by !== ident.ownerId) {
        if (looksLikePolicyGate(prior.reason) && !args.ownerOverride) {
          return fail({
            error: 'policy_gate_requires_owner_override',
            heldBy: prior.by,
            reason: prior.reason,
            convention: provenance.heldOpen ? 'held_open (lease)' : 'claim_hold (durable park)',
            hint: `${args.id} is held for a policy-tier reason ("${(prior.reason ?? '').slice(0, 160)}") — force:true alone is refused for a policy gate. Pass ownerOverride:true only with genuine owner sign-off (EI-18672701535825889).`,
          });
        }
        if (!args.force) {
          return fail({
            error: 'not_holder',
            heldBy: prior.by,
            reason: prior.reason,
            convention: provenance.heldOpen ? 'held_open (lease)' : 'claim_hold (durable park)',
            hint: `Held by ${prior.by} (${provenance.heldOpen ? 'held_open lease' : 'claim_hold durable park'}), not you — coordinate with the holder (coord:send) or pass force:true (leader override).`,
          });
        }
      }
      const cleared = await setWorkItemClaimHold(args.id, false, { harness: item.harness ?? undefined });
      if (!cleared) return fail({ error: 'clear_failed' });
      await sendMessage(ident, {
        to: ['*'],
        summary: `🔓 ${args.id} hold-open CLEARED by ${ident.ownerId}${prior && prior.by !== ident.ownerId ? ` (was ${prior.by}, forced)` : ''} — normal lifecycle resumes`,
        harnessSlug: item.harness ?? undefined,
        extra: { auto: true, lifecycle: 'hold_open_clear', work_item: args.id },
      }).catch(() => {});
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify({ ok: true, id: args.id, held: false, clearedFrom: prior?.by ?? null }) },
        ],
      };
    }
    const held = await setWorkItemClaimHold(args.id, true, {
      harness: item.harness ?? undefined,
      by: ident.ownerId,
      reason: args.reason,
    });
    if (!held) return fail({ error: 'hold_failed' });
    await sendMessage(ident, {
      to: ['*'],
      summary: `🔒 ${args.id} HELD OPEN by ${ident.ownerId} — no terminal transition by others until cleared: ${(args.reason ?? '').slice(0, 140)}`,
      harnessSlug: item.harness ?? undefined,
      extra: { auto: true, lifecycle: 'hold_open', work_item: args.id },
    }).catch(() => {});
    // EI-20710656847511624: state the lease's EXPIRY at the moment of the call. Three agents in
    // a row placed a hold_open intending a permanent fence and each got one the dead-owner sweep
    // lifted when their session ended; each had verified the hold APPLIED (has_hold=true,
    // still_claimable=false) and stopped there, because nothing in the response said the hold was
    // liveness-bound. A caller who reads only `{ ok:true, held:true }` must not be able to
    // conclude "fenced permanently". Emitted unconditionally — never inferred from reason prose,
    // which is exactly the free-text guessing the policy-gate exemption already shows is fragile.
    const policyExempt = looksLikePolicyGate(args.reason ?? null);
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            id: args.id,
            held: true,
            heldBy: ident.ownerId,
            reason: args.reason,
            note: prior && prior.by !== ident.ownerId ? `re-stamped (was held by ${prior.by})` : undefined,
            durability: policyExempt ? 'lease (policy-tier exempt from reaping)' : 'lease (expires when you do)',
            leaseNote: policyExempt
              ? 'This is a LEASE (held_open_*), but its reason names a policy-tier gate, so the dead-owner sweeps exempt ' +
                'it from reaping. That exemption keys off reason WORDING, not intent — if this fence must outlive your ' +
                'session, do not lean on it: release { claimHold:true } writes a durable park (claim_hold_*) instead.'
              : 'This is a LEASE, NOT a permanent fence: the dead-owner sweeps lift it once you are dead past grace, and ' +
                'the item then re-enters the self-select pool. If this fence must OUTLIVE your session (an owner-gated ' +
                'item, a policy decision), use release { claimHold:true } — a durable park (claim_hold_*) no reaper ' +
                'touches (EI-20710656847511624).',
          }),
        },
      ],
    };
  },
});
