/**
 * actionable-conditions.ts — the condition-key opt-in CATALOG, as a ZERO-IMPORT leaf.
 *
 * Extracted from condition-bridge.ts (P-013 of gate-verdict-liveness-and-repair-
 * reliability-2026-08-31, D-012) so the work-items-admission layer can read the
 * alarm-prefix set without a cycle: condition-bridge imports work-items.ts
 * (createWorkItem/setWorkItemState), and work-items.ts imports work-items-admission —
 * so the admission module importing condition-bridge would close that loop. Same
 * leaf-extraction precedent as scheduler/claim-states.ts (EI-11300), and the same
 * compatibility posture: condition-bridge.ts RE-EXPORTS everything here, so every
 * existing `from './condition-bridge'` importer keeps working unchanged.
 *
 * Semantics are unchanged from the original block — see condition-bridge.ts's module
 * doc for the bridge's own contract. The catalog is OPT-IN, deliberately: a transient
 * condition that opens and clears within a tick would otherwise mint and immediately
 * close a work-item on every flap. A prefix earns a place here when the condition is
 * (a) durable enough that a human or agent would want to claim it, and (b) actionable.
 */

export interface ActionableCondition {
  /** Key prefix, always ending in ':'. */
  prefix: string;
  /**
   * How to get the HARNESS this condition belongs to.
   *
   * ⚠ This field exists because the obvious shortcut is wrong and fails SILENTLY.
   * Four of the five original producers suffix the key with the harness slug
   * (`green-stall:${row.install_slug}`, `main-behind-staging:${harnessSlug}`,
   * `release-trigger-freeze:${installSlug}`, `release-trigger-fire-stale:${installSlug}`)
   * — but `single-primary:` does NOT: it is `single-primary:${verdict.key}`, and
   * the live key is `single-primary:no-primary`. `no-primary` is a VERDICT.
   *
   * A `key.split(':')[1]` harness derivation therefore files that condition's
   * work-item under harness `no-primary`, and `createWorkItem` does NOT validate
   * the harness — it just builds `scope: harnessScope(input.harness)`. The row is
   * created successfully, scoped to a harness nobody queries, and is invisible to
   * `work_items:list { harness }` forever. Same class as D-010: a plausible
   * derivation that produces an unreachable row and never errors.
   *
   * 'suffix'  = the text after the prefix IS the harness slug.
   * 'ambient' = the key carries no harness; the caller must supply one.
   * 'leading-segment' = the text after the prefix is `<harness>:<detail>`, and the
   *   harness is the segment before the FIRST ':' — for families whose key must also
   *   name a sub-subject that may itself contain ':' (a failing leg such as `lint:tsc`).
   *   'suffix' cannot serve them: it refuses any suffix containing ':' by design.
   */
  harnessFrom: 'suffix' | 'ambient' | 'leading-segment';
  severity: 'critical' | 'major' | 'minor' | 'nit';
  /**
   * Who a freshly MINTED owning work-item is assigned to at creation
   * (gate-repair-plane-on-current-build-2026-10-15 P-004, BAR R-4).
   *
   * 'live-gate-owner' = the holder of `gate.greenCheckpoint.ownership` for the
   * condition's harness, but ONLY when the presence oracle positively reports that
   * holder live (`ownershipHeldByLiveHolder`). With no live holder the item lands
   * unassigned and its summary states why — so an alarm item never sits silently in
   * the open queue while the agent already driving the gate never hears of it, and
   * never lands on a dead or stalled holder either.
   *
   * Omitted = unassigned at creation, claimable by anyone. That is deliberately the
   * default and the right answer for `frozen-repair-leg:` (D-028/D-029 of
   * green-main-cycle-time-2026-10-08: any agent may fix a leg, so assigning legs to
   * the gate owner would re-serialize exactly the labour that entry exists to spread).
   */
  assignTo?: 'live-gate-owner';
  /**
   * The family's open/resolve lifecycle is owned by a RECOMPUTING source that re-reads the
   * condition fold and broadcasts an explicit resolution, not by the one process that last
   * emitted (EI-27231825178306204). The one-shot emitter-death reconciler
   * (WI-6554700010016120, `selectDeadOneShotConditions`) then leaves the family open: its
   * premise — a dead emitter can never send the RECOVERED broadcast — is false here, because
   * whichever process runs the source's next tick sends it.
   *
   * Measured 2026-10-28: `frozen-repair-leg:` items are opened by the gate's per-RUN process,
   * so every run's exit made the reconciler close 8–13 still-failing legs (11:06, 11:39, 13:52,
   * 16:02Z). The bridge closed their items, the holders lost their claims, and the next run
   * re-opened them.
   */
  lifecycleOwnedBySource?: true;
}

/** Stable condition namespace for bridge residues with a known agent remedy. */
export const GITHUB_BRIDGE_AGENT_ACTIONABLE_CONDITION_PREFIX = 'github-bridge-agent-actionable:';

/**
 * Stable condition namespace for a frozen candidate HELD for agent convergence
 * (WI-2141736 P-003). Declared here, in the zero-import leaf, and imported by the
 * emitter (release/frozen-repair-agent-routing.ts) rather than the other way round: the
 * catalog must not grow imports, and a prefix spelled twice is a key that can drift out
 * of its own opt-in entry — at which point the alarm broadcasts and silently mints
 * nothing, which is indistinguishable from no red at all.
 */
export const FROZEN_REPAIR_CONVERGENCE_CONDITION_PREFIX = 'frozen-repair-convergence:';

/**
 * Stable condition namespace for ONE failing leg of a frozen repair queue
 * (green-main-cycle-time-2026-10-08 P-013, D-028/D-029). Keys are
 * `frozen-repair-leg:<pipeline>:<failing entry>`, emitted only by
 * release/frozen-repair-leg-routing.ts, which imports this constant so the emitted
 * prefix and its opt-in entry cannot drift apart. The entry may contain ':' (`lint:tsc`),
 * which is why the entry below uses `harnessFrom: 'leading-segment'`.
 */
export const FROZEN_REPAIR_LEG_CONDITION_PREFIX = 'frozen-repair-leg:';

/**
 * Stable condition namespace for a collapsed fail-open rate
 * (degradation-signals-on-condition-rail-2026-10-11 P-003, BAR R-2). Keys are
 * `degraded:<mechanism>[:<scope>]:<reason>`, emitted only by the generic degradation
 * watchdog (system-health/degradation-watchdog.ts), which imports this constant so the
 * emitted prefix and its opt-in entry cannot drift apart.
 */
export const DEGRADATION_CONDITION_PREFIX = 'degraded:';

/**
 * The opt-in catalog. See {@link ActionableCondition.harnessFrom} for why the
 * harness derivation is explicit per-entry rather than parsed.
 */
export const ACTIONABLE_CONDITIONS: readonly ActionableCondition[] = [
  // `assignTo: 'live-gate-owner'` on the gate and repair-queue entries below: see
  // ActionableCondition.assignTo (gate-repair-plane-on-current-build-2026-10-15 P-004).
  { prefix: 'green-stall:', harnessFrom: 'suffix', severity: 'critical', assignTo: 'live-gate-owner' },
  // P-008: reuse the lost-run sweep's existing keys and measured recovery.
  { prefix: 'green-checkpoint-lost-run:', harnessFrom: 'suffix', severity: 'critical', assignTo: 'live-gate-owner' },
  { prefix: 'green-checkpoint-run-progress:', harnessFrom: 'suffix', severity: 'major', assignTo: 'live-gate-owner' },
  // P-005 (gate-ownership-followup-2026-08-08). A gate that FIRES hourly and reds
  // every time is not a stall — `green-stall:` above cannot see it (its legs are
  // fire-staleness and a 12h no-green backstop), so until this entry existed a plain
  // red gate had NO condition and therefore no ownable work-item. Emitted by
  // `trackGateStall` (harness/routines/release-actions.ts) at the SAME edge that
  // already fires the urgent stall alert, so the condition's open/close cannot drift
  // from the state machine that decides the gate is stuck. Critical: `main` is frozen.
  { prefix: 'gate-red-streak:', harnessFrom: 'suffix', severity: 'critical', assignTo: 'live-gate-owner' },
  // WI-2141736 P-003 (frozen-candidate-freeze-actually-holds-2026-09-02). Distinct from
  // `gate-red-streak:` above, which says "the gate is red, own it". THIS one says the
  // frozen candidate is being HELD with no dispatchable fixer — so agent/human convergence
  // onto a NAMED sha, by a named call, within a stated deadline, is the only remaining
  // repair path before the candidate is retired. Measured 2026-09-02: a six-day provider
  // wall produced 20 retirements and 0 resumes in one day, and nothing ever asked an agent
  // to converge. Opted in because it is durable (bounded by the 4h convergence hold, not a
  // per-tick flap) and actionable (the body carries the exact `release:repair-queue`
  // converge call). Emitted by green-checkpoint's `routeFrozenRepairToAgents` dep on every
  // tick the hold holds; suffix is `pipelineName(integrationRoot)`, the same slug the other
  // gate entries use. Critical: it is the last path off a frozen `main`.
  {
    prefix: FROZEN_REPAIR_CONVERGENCE_CONDITION_PREFIX,
    harnessFrom: 'suffix',
    severity: 'critical',
    assignTo: 'live-gate-owner',
  },
  // green-main-cycle-time-2026-10-08 P-013 (D-028/D-029): ONE claimable item per failing
  // leg of the frozen queue, so the repair is not a single gate owner's serial labour —
  // any agent may claim a leg, fix it and admit the fix (admission needs no gate
  // ownership). Durable: opened when a leg enters the queue's failing set, resolved when
  // it leaves, never per-tick. Major, not critical: the convergence and red-streak items
  // above already carry the stop-the-line severity for the queue as a whole.
  // `lifecycleOwnedBySource`: the router resolves departed legs (and every leg on a cleared
  // queue) itself on the next tick, from whichever gate process runs it.
  {
    prefix: FROZEN_REPAIR_LEG_CONDITION_PREFIX,
    harnessFrom: 'leading-segment',
    severity: 'major',
    lifecycleOwnedBySource: true,
  },
  // `main` lagging `staging` is the gate not promoting, so it is the gate owner's too.
  { prefix: 'main-behind-staging:', harnessFrom: 'suffix', severity: 'major', assignTo: 'live-gate-owner' },
  { prefix: 'release-trigger-freeze:', harnessFrom: 'suffix', severity: 'major' },
  { prefix: 'release-trigger-fire-stale:', harnessFrom: 'suffix', severity: 'major' },
  { prefix: 'single-primary:', harnessFrom: 'ambient', severity: 'critical' },
  // github-bridge divergence has a separate agent-actionable lane for known
  // local remedies (for example restoring a workflow file when the remote
  // OAuth token lacks the `workflow` scope). Keep it distinct from the
  // owner-gated bridge alarm so the same condition gets one ownable item and
  // does not page a human for a fix an agent can apply.
  { prefix: GITHUB_BRIDGE_AGENT_ACTIONABLE_CONDITION_PREFIX, harnessFrom: 'suffix', severity: 'major' },
  // degradation-signals-on-condition-rail-2026-10-11 P-003 (R-2). A registered mechanism
  // whose trailing fail-open window collapsed — e.g. gate pass reuse falling to 0 of ~7,689
  // eligible tasks (run 762a13a6) with nothing alarmed. Durable by construction: the
  // watchdog only opens after a minimum eligible count and resolves with hysteresis, so it
  // cannot flap per tick. 'ambient' because the key carries a mechanism, never a harness.
  // `lifecycleOwnedBySource`: only the watchdog's metric-backed window can establish recovery;
  // the 2026-10-17 retrieval incident closed `degraded:retrieval:mixed` at 65–69% recovery
  // solely because its old emitter exited.
  { prefix: DEGRADATION_CONDITION_PREFIX, harnessFrom: 'ambient', severity: 'major', lifecycleOwnedBySource: true },
];

/** The bare prefixes — derived, so the catalog stays the single source of truth. */
export const ACTIONABLE_CONDITION_PREFIXES: readonly string[] = ACTIONABLE_CONDITIONS.map((c) => c.prefix);

/** The catalog entry governing this key, or null when it is not opted in. */
export function actionableConditionFor(conditionKey: string): ActionableCondition | null {
  const key = conditionKey.trim();
  if (!key) return null;
  return ACTIONABLE_CONDITIONS.find((c) => key.startsWith(c.prefix)) ?? null;
}

/**
 * Is this key's lifecycle owned by a recomputing source, so the death of its last emitter is
 * NOT evidence of recovery? Derived from the catalog — never a second hand-typed prefix list.
 */
export function isLifecycleOwnedBySource(conditionKey: string): boolean {
  return actionableConditionFor(conditionKey)?.lifecycleOwnedBySource === true;
}

/** Should this condition key mint an owning work-item? */
export function isActionableConditionKey(conditionKey: string): boolean {
  return actionableConditionFor(conditionKey) !== null;
}
