/**
 * reviewable-miss.ts — turn "every spec match is awaiting PEER REVIEW" into work the
 * missing caller can do, instead of a stand-down (WI-10004358).
 *
 * THE DEFECT. The claim floor deliberately excludes rows whose `payload.agentReview.status`
 * is `pending` (agent-review-policy.ts, migration 860): an idea must be peer-reviewed before
 * anyone implements it. Nothing wrong with the floor. But the two miss reports a claimer
 * reads — `fleetScopedMiss` for a fleet member, `buildMissDiagnosis` for a solo caller —
 * classified such a lane as FLOOR-GATED and said the gating "very likely self-clears once the
 * gating condition lifts" / "idling is correct", with `windDown: true`. Peer review never
 * self-clears: it clears only when some agent runs `improvements:agent-review` and grades the
 * item via `blender:grade-idea`. So the one population positioned to do that review — idle
 * drain members whose OWN spec is stranded behind it — was told to stand down.
 *
 * Measured 2026-09-30 (goal work-on-everything-fresh-grading-and-improvement-60d3a8): its drain
 * spec matched 331 rows, 0 claimable, 24 pending peer review; workspace-wide 1,366 agent-review
 * ledger rows sat ungraded, with grading happening only in episodic GRADE-mode bursts (none
 * after 2026-09-20 beyond single items).
 *
 * THE FIX. When a stranded miss's breakdown shows spec-matched rows pending review, the miss
 * names the review route — list the spec's review ids, claim one, grade it — and must not
 * certify a drain. The route reuses the existing doors (work_items:claimable's
 * `excludedSample.queueControl.agentReview`, improvements:agent-review, blender:grade-idea);
 * nothing new is claimed on the caller's behalf. Review claims stay tied to explicit ids
 * returned by the caller's scoped read. The harness-wide `claim-next` mode cannot preserve a
 * fleet claim spec, so it must never be offered as a fallback here.
 *
 * `revision-requested` rows are NOT counted: they wait on their SUBMITTER's resubmission, which
 * a peer cannot perform, so they would advertise work the caller cannot do.
 *
 * Pending rows HELD by another agent (`taken_by` set and not the caller) are NOT counted
 * either (EI-25949663083795915): improvements:agent-review refuses them with
 * `claim-conflict` (holder !== reviewer), so `pendingAgentReview` means "pending AND
 * claimable by this caller", and the advised sample ids carry the same predicate.
 *
 * PURE: no I/O, so both miss paths share one wording and a focused test pins the advice,
 * including the bug reproduction gate.
 */

/** The review-relevant subset of `IssueClaimExclusionBreakdown['queueControl']`. */
export interface ReviewQueueCounts {
  pendingAgentReview: number;
}

export const REVIEWABLE_MISS_IDS_AT = 'excludedSample.queueControl.agentReview[].id';

export interface ReviewableMissRoute {
  /** Spec-matched rows whose peer review is pending and that no OTHER agent holds — work a
   *  non-submitter can claim now. */
  pendingAgentReview: number;
  /** Step 1: list the spec's pending-review ids (read-only). The ids are at
   *  `excludedSample.queueControl.agentReview[].id`, each with its `ledgerIdeaId`. */
  list: {
    tool: 'work_items:claimable';
    args: {
      harness?: string;
      spec?: string;
      breakdownOnly: true;
      sampleExcluded: number;
      /** Dispatch-level projection keeps the bounded sample visible through the result door. */
      projection: { pick: string[] };
    };
    idsAt: typeof REVIEWABLE_MISS_IDS_AT;
  };
  /** Step 2: bind one listed id to the required `id` argument before calling the review tool. */
  claim: {
    tool: 'improvements:agent-review';
    mode: 'claim';
    idFrom: typeof REVIEWABLE_MISS_IDS_AT;
    harness?: string;
  };
  /** Step 3: record the peer grade — this is what clears the review floor. */
  grade: { tool: 'blender:grade-idea'; ideaIdFrom: 'ledgerIdeaId' };
}

export interface ReviewableMiss {
  route: ReviewableMissRoute;
  /** Leads the miss's error/diagnosis text: why this is not an idle lane. */
  message: string;
  /** Leads the miss's advice: what to do instead of standing down. */
  advice: string;
}

/** How many ids to ask `work_items:claimable` for — enough to skip past the caller's own
 *  submissions and rows a peer reviewer grabbed first, without a heavy sample. */
export const REVIEWABLE_MISS_SAMPLE = 5;

/**
 * Returns the review route when a stranded miss has spec-matched rows pending peer review,
 * else `null` (the caller's existing drain/floor-gated verdict stands unchanged).
 *
 * Callers apply it ONLY where the lane is otherwise reported as stranded (0 claimable): a
 * lane with claimable rows should claim those first, and a paused fleet must not pull work.
 */
export function reviewableMiss(
  queueControl: ReviewQueueCounts | null | undefined,
  opts: { harness?: string | null; spec?: string | null } = {},
): ReviewableMiss | null {
  const pending = Math.floor(Number(queueControl?.pendingAgentReview ?? 0));
  if (!Number.isFinite(pending) || pending <= 0) return null;
  const harness = opts.harness?.trim() || undefined;
  const spec = opts.spec?.trim() || undefined;
  const route: ReviewableMissRoute = {
    pendingAgentReview: pending,
    list: {
      tool: 'work_items:claimable',
      args: {
        ...(harness ? { harness } : {}),
        ...(spec ? { spec } : {}),
        breakdownOnly: true,
        sampleExcluded: REVIEWABLE_MISS_SAMPLE,
        projection: { pick: ['excludedSample.queueControl.agentReview'] },
      },
      idsAt: REVIEWABLE_MISS_IDS_AT,
    },
    claim: {
      tool: 'improvements:agent-review',
      mode: 'claim',
      idFrom: REVIEWABLE_MISS_IDS_AT,
      ...(harness ? { harness } : {}),
    },
    grade: { tool: 'blender:grade-idea', ideaIdFrom: 'ledgerIdeaId' },
  };
  const listCall =
    `work_items:claimable { ${harness ? `harness:'${harness}', ` : ''}${spec ? `spec:'${spec}', ` : ''}` +
    `breakdownOnly:true, sampleExcluded:${REVIEWABLE_MISS_SAMPLE}, ` +
    'projection:{pick:["excludedSample.queueControl.agentReview"]} }';
  const message =
    `REVIEWABLE, NOT IDLE: ${pending} spec-matched row(s) are held by PENDING PEER REVIEW. ` +
    'That floor never self-clears — it clears only when a non-submitter reviews and grades the row — ' +
    'so this lane is not drained and idling on it strands the work.';
  const advice =
    `DO NOT STAND DOWN YET: review the ${pending} pending row(s) in your own spec. ` +
    `1) ${listCall} → ids at excludedSample.queueControl.agentReview[].id; ` +
    `2) For one listed id you did not submit, call improvements:agent-review { mode:'claim', id:<listed id>${harness ? `, harness:'${harness}'` : ''} }; ` +
    '3) read the item, then blender:grade-idea { ideaId: <its ledgerIdeaId>, grade, feedback }. ' +
    'A grade of 4+ approves only after its gates pass: bugs need an accepted current-build reproduction receipt. ' +
    'Without one, a 4+ grade leaves the bug revision-requested/not-ready; record and verify the receipt before treating it as approved. ' +
    'A grade of 3 or lower sends it back for revision. Then pull again. ' +
    "If a claim returns claimed:false with reason 'agent-review-not-pending', discard that id and refresh the scoped claimability sample before trying another. The earlier list was a read-only snapshot, not a reservation; this refusal alone does not establish a selector defect. " +
    `If improvements:agent-review returns claimed:false for every id in that scoped read, no review is available ` +
    `from this bounded sample. Do not use claim-next: it scopes only to a harness and can claim review work outside ` +
    `this fleet spec. The sample is capped at ${REVIEWABLE_MISS_SAMPLE} ids per floor, so it does not prove the full ` +
    'pending-review population is exhausted; keep the lane open and re-read the scoped claimability view when its candidates change.';
  return { route, message, advice };
}
