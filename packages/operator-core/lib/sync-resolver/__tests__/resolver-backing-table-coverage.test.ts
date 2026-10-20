/**
 * resolver-backing-table-coverage.test.ts — the RESOLVER → TABLE → INVALIDATION guard
 * (EI-19304902443341820).
 *
 * THE GAP THIS CLOSES
 * -------------------
 * Its sibling `cache-tag-trigger-coverage.integration.test.ts` checks TABLE_TO_QUERY_NAMES against
 * the PG triggers with exact set-equality. That has teeth in three directions — a newly-mapped
 * table with no trigger, a removed trigger, a stale exemption — but every one of them requires the
 * table to ALREADY BE in the map. A resolver reading a table listed in NEITHER
 * `TABLE_TO_QUERY_NAMES` nor `OPERATOR_STATE_SYNC_NAMES` was invisible to that guard, and to every
 * other check in the repo.
 *
 * The only thing standing between that and a silently-dead sync query was a maintenance comment in
 * table-to-query-names.ts. A comment is not a guard.
 *
 * `accounts.pool` (added 2026-06-15) read `harness_shared.operator_account_pool` and was never
 * mapped, so not one invalidation ever fired from a pool write — for the query whose entire purpose
 * is showing continuously-updating account usage. Nothing errored; the tab quietly refreshed on
 * remount only. It took the owner noticing stale numbers, ~7 weeks later, to surface it (WI-6796).
 * Note the asymmetry that makes this bite: the cheapest failure to introduce was the one nothing
 * checked.
 *
 * WHY THE TABLE DIRECTION, AND NOT A CHEAPER NAME-LEVEL CHECK
 * ----------------------------------------------------------
 * The tempting cheap guard is "every registry name must appear in a map or in some
 * `notifySyncInvalidate('<name>')` callsite". It would NOT have caught this. `accounts.pool` had
 * FOUR such callsites the entire time (register / remove / reset-rate / probe-capacity). The query
 * had a push path — just not from the writer that actually moves its data (the gateway's continuous
 * usage-window projection). Only the resolver → TABLE direction can express that.
 *
 * That derivation is unsound in the other direction too: the derived-reads precompute producer
 * invalidates via `notifySyncInvalidate(producer.key)` — a VARIABLE — so a literal-string scan
 * reports six perfectly live panels as having no push path at all. Both errors were measured while
 * triaging this. Do not reintroduce it.
 *
 * WHY HERMETIC (no PG, O(1) per entry)
 * ------------------------------------
 * Deliberately NOT the "dispatch every entry against a real database" shape. That was tried and
 * repeatedly blew the green gate under load — see the note in sync-read-audit.ts, where the timeout
 * went 10s → 30s → 120s and then past it at ~123 entries. Structural inspection catches this class
 * at a cost the gate can absorb.
 *
 * WHAT IT ASSERTS
 * ---------------
 *   1. Every table a resolver DECLARES in `backingTables` invalidates THAT query name through one
 *      of the two invalidation surfaces — or carries a documented PUSH_EXEMPT reason + re-arm.
 *   2. Every registry entry either declares `backingTables` or sits in UNDECLARED_BASELINE, which
 *      is SHRINK-ONLY: exact set-equality fails on a new undeclared entry, and the size ceiling
 *      fails even if someone edits the list to make room.
 *   3. Neither allow-list may go stale.
 */
import { describe, expect, it } from 'vitest';
import { knownQueryNamesV2, getRegistryEntryV2 } from '../index';
import { TABLE_TO_QUERY_NAMES } from '../table-to-query-names';
import { OPERATOR_STATE_SYNC_NAMES } from '../../operator-state-pg';

/**
 * Declared (queryName, table) pairs that intentionally have NO table-driven invalidation, each with
 * the reason AND the condition that would re-arm it. Keyed `"<queryName> :: <schema>.<table>"`.
 *
 * Mirrors the `COVERAGE_EXEMPT` idiom in the sibling trigger guard on purpose, so a deliberately
 * poll-only query (per /internal/docs/agent-insights/push-vs-poll-and-the-90s-dedupe — continuous
 * gauges, external probes) stays legal but DECLARED, rather than merely absent and indistinguishable
 * from a bug.
 */
const PUSH_EXEMPT: Record<string, string> = {
  // DAO drafts share onboarding's JSONB row, but mutateLaunches publishes after
  // its row-lock write commits. Invalidating on every onboarding write would
  // refetch the DAO view for unrelated tutorial progress. dao-launch-store.test.ts
  // pins committed revisions and silence on refused mutations.
  // RE-ARM: bridge this table if another writer changes dao_launches without
  // that committed producer push, or mutateLaunches stops publishing.
  'dao.launches :: harness_shared.setup_wizard_state':
    'dao-launch-store mutateLaunches pushes dao.launches after its committed write; bridge the table if another DAO draft writer appears or that push is removed.',

  // The only production writer is consult-expert-routing-set, which pushes this
  // singleton query after its committed write. RE-ARM: bridge the table when a
  // second writer is introduced or that explicit producer push is removed.
  'consult.expertRouting :: harness_shared.operator_consult_expert_routing':
    'the sole write route pushes consult.expertRouting after commit; bridge this table if another writer appears or the route stops pushing.',

  // P-005 inherited governance policy (WI-6554700010011434). Every write to these two tables is
  // ONE store.upsertLayer transaction, reached only through governance-policy/control.ts
  // #setGovernancePolicyLayer (the governance:policy tool and the /api/governance-policy/* routes
  // both call it), which pushes governancePolicy.state after commit (control.test.ts pins the push).
  // RE-ARM: bridge both tables (emit_change_notify trigger + TABLE_TO_QUERY_NAMES entry) if any
  // writer calls upsertLayer directly or control.ts stops pushing.
  'governancePolicy.state :: harness_shared.governance_policy_layers':
    'governance-policy/control.ts is the sole writer and pushes governancePolicy.state after each committed upsertLayer; bridge the table if a direct upsertLayer writer appears or that push is removed.',
  'governancePolicy.state :: harness_shared.governance_policy_layer_versions':
    'version rows are written only inside the same upsertLayer transaction, reached only via control.ts, which pushes governancePolicy.state after commit; bridge the table if that changes.',

  // P-030 foreign conversation projection: these are deliberately NOT given
  // another per-row invalidation producer. session_turns/tool_invocations are
  // the two hottest append ledgers, while plan_item_claims is renewed on every
  // turn. Active foreign sessions already repaint through the projection's
  // mapped coord_presence/adv_sessions/work_items/agent_modes sources, and the
  // sync layer's drift/focus refresh covers a historical mounted session.
  // RE-ARM: replace these exemptions with a SESSION-SCOPED producer push if the
  // bridge gains a partial-args target for {sourceKind,sessionId}; never attach
  // coarse per-row triggers that full-bust every mounted conversation.
  'conversations.contextProjection :: harness_shared.session_turns':
    'high-volume append transcript ledger; active-session repaint rides existing mapped context writes, with drift/focus refresh for historical rows. Re-arm only with a session-scoped producer push.',
  'conversations.contextProjection :: harness_shared.tool_invocations':
    'high-volume per-call telemetry ledger; the relevant activity:report dispatch also advances mapped agent context. Re-arm only with a session-scoped producer push, not a table-wide per-call trigger.',
  'conversations.contextProjection :: harness_shared.plan_item_claims':
    'lease-renewed on every turn; claim acquisition/release also moves mapped presence/work context. A coarse trigger would full-bust every open conversation on heartbeat churn.',

  // The plan-lock banner (semantic-search-fingerprint-coverage-2026-08-03 P-025).
  // Structurally exempt rather than merely unwired: `agent_file_locks` lives in the
  // SEPARATE `papercusp_su` database, so it is not reachable by a trigger on the
  // operator DB and cannot appear in table-to-query-names.ts at all — unlike every
  // other table in this file. The push comes from the WRITERS instead
  // (notifyPlanLockChange, wired at file-lock-guard acquire+release, release.ts and
  // acquire_granular.ts), each emitting with a short per-call dedupeWindowMs because
  // the bus's 90s window is FIRST-WINS and would otherwise DROP the release (D-042).
  // RE-ARM: if the lock store ever moves into the operator database, or the bridge
  // gains cross-database targets — then wire the table normally and delete this.
  'planLock.byPath :: papercusp_su.agent_file_locks':
    'lock rows live in a different database (papercusp_su), unreachable by an operator-DB trigger; the lock writers push explicitly via notifyPlanLockChange.',

  // integrations.tickets (linear-asana-task-sync P-007): work_items supplies only each source's
  // mirrored-record COUNT. Records are written by a connector sync pass, which also stamps the
  // source's data_sources row (sync_last_success_at), and data_sources IS bridged (mig 1399). Adding
  // integrations.tickets to work_items' bridge would refetch the page on every work-item write in
  // the workspace. RE-ARM: bridge it if records ever arrive without a data_sources write (a
  // webhook path that writes records directly, P-008).
  'integrations.tickets :: harness_shared.work_items':
    'record counts move only during a connector sync pass, which also writes the bridged data_sources row; a work_items bridge would refetch on every work-item write.',

  // plans.attentionBulkRun (inbox-bulk-resolve-2026-08-23, mig 912): every writer to
  // both tables pushes explicitly — createRun/reportOutcomes (agent-tools/inbox/
  // bulk-run.ts) and the admin bulk-resolve route each fire
  // notifySyncInvalidate('plans.attentionBulkRun') after the write commits. That fires
  // on the write's MEANING (a phase/outcome change), where a row trigger would add a
  // per-row notify on the outcome batch for no gain.
  // RE-ARM (both): wire the table in table-to-query-names.ts if its producer push is
  // ever dropped.
  'plans.attentionBulkRun :: harness_shared.attention_bulk_runs':
    'producer-push: every run writer fires notifySyncInvalidate after commit (bulk-run.ts, admin bulk-resolve route); a row trigger would fire per outcome row for no gain.',
  'plans.attentionBulkRun :: harness_shared.attention_bulk_run_items':
    'producer-push: item outcome batches are followed by one notifySyncInvalidate from the same writers; a per-row trigger on the batch is the notify-storm shape.',

  // cleanup-report-flows-2026-08-24 P-005: same bounded producer-push contract
  // on the generalized run table and the cleanup finding batch.
  'plans.cleanupRun :: harness_shared.attention_bulk_runs':
    'producer-push: every cleanup run phase transition fires notifyPlanCleanupRunChanged after commit.',
  'plans.cleanupRun :: harness_shared.plan_cleanup_run_findings':
    'producer-push: finding outcome batches are followed by one dedupe-disabled cleanup-run invalidation.',

  // Continuous heartbeat gauge: shared_presence is rewritten by every agent's keepalive, so a
  // per-row notify is the notify-storm anti-pattern (/internal/docs/performance) for a panel whose
  // entire content is "who is alive right now" — polling IS the semantics here.
  // RE-ARM: only if presence gains a debounced / coalesced change producer.
  'sidebar.hives :: harness_shared.shared_presence':
    'continuous presence heartbeat; per-row notify = notify-storm. Poll-only by design.',

  // Local desktops reads the desktop-session roster and each session owner's current claim.
  // Registry writes explicitly announce desktops.local; claims are lease-renewed and the
  // visible grid refreshes them on its visible tick instead of emitting a row notification.
  // RE-ARM: replace these with mapped, appropriately scoped producers if either contract changes.
  'desktops.local :: harness_shared.desktop_sessions':
    'desktop-session-registry calls announceRosterChange() after roster-visible writes; keep that push on every registry writer.',
  'desktops.local :: harness_shared.work_item_claims':
    'claim attribution refreshes on the visible grid tick; per-row NOTIFY would fire on lease-renewal heartbeats. Add a scoped/debounced producer before requiring immediate refresh.',

  // The derived-reads precompute substrate. These six resolvers are plain SELECTs against the
  // snapshot table, and the PRODUCER already pushes for them: derived-reads/registry.ts fires
  // notifySyncInvalidate(producer.key) after the upsert and ONLY when the payload md5 actually
  // changed. That is a strictly better signal than a table trigger, which would also fire on the
  // no-op refreshes that are the common case for a slow-moving producer.
  // RE-ARM: remove if that producer-side push is ever dropped.
  ...Object.fromEntries(
    [
      'dev.serviceHealth',
      'dev.deployState',
      'dev.gitPipeline',
      'dev.gitPipelineHives',
      'insights.coordTokens',
      'learning.soakReport',
    ].map((n) => [
      `${n} :: harness_shared.derived_read_snapshots`,
      'precompute substrate; the PRODUCER pushes notifySyncInvalidate(producer.key) on a real payload change (derived-reads/registry.ts) — better than a table trigger, which would also fire on no-op refreshes.',
    ]),
  ),

  // WI-6974 — the Orders panel's five non-work_items tables. Same producer-push shape
  // as the derived-reads block above, for the same reason and one step stronger: each
  // of these tables is written far more often by something that is NOT an orders
  // change, so a row trigger (which fires on the write, never on its meaning) would
  // push every open panel on a timer. lib/agent-orders-notify.ts carries the full
  // argument; each producer emits `{ ownerId }`, so the refetch is scoped to the ONE
  // panel viewing that agent rather than a full bust.
  //
  // RE-ARM (all five): remove the entry and wire the table in table-to-query-names.ts
  // if its producer push is ever dropped, OR if the bridge gains an owner-scoped
  // `{ name, scope }` target for it — scoping is what would make a trigger safe here,
  // and no production user of that mechanism exists yet.
  'agentOrders.byOwner :: harness_shared.session_briefs':
    'orders live in the control_* columns only, but the row also moves on intent/current_files writes; persistControlAnchor runs on ~every orient and pushes ONLY when control_state actually changed (its own IS DISTINCT FROM no-op branch) — a trigger cannot see that distinction.',
  'agentOrders.byOwner :: harness_shared.plan_item_claims':
    'renewOwnerActivityClaims rewrites last_activity_ts on EVERY TURN of every claim-holding owner — a heartbeat, the coord_presence anti-pattern. plan-items/claims.ts pushes on acquire/release ONLY, never on heartbeat/renew/extend.',
  'agentOrders.byOwner :: harness_shared.carry_notes':
    "every agent loop:checkpoint writes this table (~26/hr fleet-wide, measured 2026-08-02). setLoopCarryNote* pushes for the ref's ownerId and skips a guard-BLOCKED write, which wrote nothing.",
  'agentOrders.byOwner :: harness_shared.agent_modes':
    'event-driven but carries no owner-scoped key the bridge could scope by, so a trigger would full-bust every open panel for a mode set on an unrelated agent. modes/store.ts setMode pushes past its noop guards.',
  'agentOrders.byOwner :: harness_shared.agent_mode_changes':
    'append-only audit of the same transition as agent_modes; pushed by the same modes/store.ts setMode call rather than twice from two triggers.',

  // The coverage census (deterministic-coverage-census-2026-08-17 P-005). Same producer-push
  // shape as the derived-reads block above: both writers are BATCH producers whose row count
  // says nothing about whether the panel's numbers moved.
  //
  // Worth stating plainly, because the honest version is weaker than the derived-reads one:
  // the census push fires once per RUN, not once per CHANGE (`upserted` counts no-op upserts),
  // so it is "at most one invalidation an hour" rather than "only when the payload changed".
  // That is still strictly better than the trigger it replaces; it is not equivalent to the
  // md5-guarded producer push, and should not be described as if it were.
  //
  // RE-ARM (all three): drop the entry and wire the table in table-to-query-names.ts if either
  // producer push is removed, or if a writer outside these two paths starts moving these rows —
  // at that point the trigger is the only thing that can see the write.
  'testing.coverage :: harness_shared.testing_surfaces':
    'batch census re-upserts the whole surface population (1,105 rows) each run, nearly all no-ops; harness/routines/coverage-census-action.ts pushes ONCE per run instead of ~1,105 NOTIFYs.',
  'testing.coverage :: harness_shared.coverage_evidence':
    'written per-binding by the attribution flush; coverage-census/attribution/pg-evidence-store.ts pushes once per flush, guarded on written>0 so a flush that matched no surfaces stays quiet.',
  'testing.coverage :: harness_shared.census_provider_registrations':
    'registration rows are seeded/paused by operators, never by a census run; the panel only reads them as the registered/enabled counts behind censusUnknown, which the same once-per-run census push already covers.',

  // WI-40483 / P-023 — cloud-init/systemd logs arrive in batches and can be
  // hundreds of rows. appendWorkspaceHostLogs persists the batch and then
  // emits exactly one workspaceHosts.control invalidation; a row trigger would
  // turn one ingestion into a notification storm.
  // RE-ARM: remove this exemption and bridge the table normally if the store's
  // producer-side push is removed or a writer bypasses appendWorkspaceHostLogs.
  'workspaceHosts.control :: harness_shared.workspace_host_logs':
    'append-heavy cloud-init/systemd diagnostics; appendWorkspaceHostLogs pushes workspaceHosts.control once after each committed batch instead of emitting one PG notification per row.',

  // WI-39501 — the Learnings tab's pause/resume-all control.
  //
  // RE-ARM: drop this entry and wire the table in table-to-query-names.ts if
  // routinesTick stops rewriting the row on every fire, or if the bridge gains
  // a group-scoped target that a trigger could safely use.
  'learning.loopControl :: harness_shared.routines':
    'the routines row is rewritten on EVERY tick (nextFireAt/lastFiredAt) — a heartbeat, the coord_presence anti-pattern — so a row trigger would push every open Learnings tab on a timer while the control state it renders (active, metadata->pause) had not moved. agent-tools/routines/group-set.ts pushes notifySyncInvalidate(learning.loopControl) on the bulk pause/resume flip instead, which is the only write that changes what this query returns. The sibling agent_usage_samples IS bridged in table-to-query-names.ts.',

  'learning.dream :: harness_shared.routines':
    'Routine ticks are heartbeat-heavy. Dream control, routines:set/group-set and production cycle completion push learning.dream after committed changes; bridge this table if these producer pushes are removed.',
  'learning.dream :: harness_shared.learning_spend_events':
    'The production Dream adapter pushes learning.dream after committed recordDreamRunSpend; only dream:* events affect this query. Bridge if another Dream spend writer is added.',
  'learning.dream :: harness_shared.learning_pot_scope':
    'learning:set-pot-scope pushes learning.dream after the pot master switch commits; bridge if another live pot-scope writer is introduced.',

  // WI-39540 — the settings Memory page's denominator ("Showing 500 of 2,746").
  //
  // RE-ARM: drop this entry and wire memory_canonical in table-to-query-names.ts
  // if the memory backend seam is ever removed in favour of direct table reads.
  'userMemory.total :: harness_shared.memory_canonical':
    'read through the pluggable memory BACKEND seam (getMemoryBackend().list()), so under a remote backend (mem0) the rows never touch this table and a trigger would see nothing at all — it cannot be the whole invalidation story by construction. Every write path instead routes through memory/invalidate-user-memory-views.ts, which pushes this key together with userMemory.list so the count and the window can never refresh independently — the stale-denominator bug this query was added to fix.',

  // WI-39535 — the Retained ledger's memory leg + an open memory detail aside.
  // Same seam-not-table argument as userMemory.total directly above, and the
  // same producer: both keys ride USER_MEMORY_SYNC_KEYS in
  // memory/invalidate-user-memory-views.ts, so every memory write path (the
  // /api/user/memory routes, the memory:* MCP verbs, the journal drain) pushes
  // the ledger and the aside together with the settings page's views.
  // RE-ARM (both): drop the entry and wire memory_canonical in
  // table-to-query-names.ts if the backend seam is ever removed.
  'learning.retainFeed :: harness_shared.memory_canonical':
    'memory leg reads through the pluggable backend seam (getMemoryBackend().list()) — a remote backend never touches this table; writes push via invalidate-user-memory-views.ts (USER_MEMORY_SYNC_KEYS carries learning.retainFeed).',
  'learning.retainFeed.summary :: harness_shared.memory_canonical':
    'paired memory summary reads the same pluggable backend seam as the feed (canonical backends use the table directly, remote backends do not); writes push via invalidate-user-memory-views.ts with the row and badge keys.',
  'learning.retainDetail :: harness_shared.memory_canonical':
    'memory detail reads through the pluggable backend seam (getMemoryBackend().get()) — same seam argument as the feed row above; writes push via invalidate-user-memory-views.ts (USER_MEMORY_SYNC_KEYS carries learning.retainDetail).',
  'learning.retainCounts :: harness_shared.memory_canonical':
    'the memories BADGE counts through the same pluggable backend seam as the feed leg (WI-39900 split the counts off the page) — a remote backend never touches this table; writes push via invalidate-user-memory-views.ts (USER_MEMORY_SYNC_KEYS carries learning.retainCounts).',

  // WI-39493/WI-39534 — the ledger's recipes leg + an open recipe detail.
  // code_recipes has NO row trigger (its own list query, codeRecipes, is
  // poll-only today — the table is absent from table-to-query-names.ts, and
  // the trigger-coverage sibling asserts map ↔ trigger set-equality, so a map
  // entry without a migration adding the trigger would red THAT gate).
  // Recipes move rarely (recipes:merge / the sweep), and the ledger refreshes
  // on mount + its manual refresh + every OTHER leg's invalidations.
  // RE-ARM (both): drop the entry and bridge normally when code_recipes gains
  // a trigger (or a producer-side push lands in code-recipes-store.ts).
  'learning.retainFeed :: harness_shared.code_recipes':
    'no trigger on code_recipes (codeRecipes list is likewise poll-only); recipe writes are rare agent-tool events, and the feed refreshes on mount/manual refresh.',
  'learning.retainFeed.summary :: harness_shared.code_recipes':
    'no trigger on code_recipes — the companion summary refreshes with the feed on mount/manual refresh and otherwise has the same poll-only recipe-store limitation.',
  'learning.retainDetail :: harness_shared.code_recipes':
    'no trigger on code_recipes — same as the feed leg above; an open recipe detail refreshes on remount/manual refresh.',
  'learning.retainCounts :: harness_shared.code_recipes':
    'no trigger on code_recipes — same as the feed leg above; the recipes BADGE (WI-39900) tolerates staleness by design (generous staleTime) and refreshes on remount/manual refresh.',

  // plans.provenance (plan-item-provenance-2026-09-29 P-004). plan_audits has ONE writer
  // for this view's data — plans:audit, which pushes plans.provenance after the
  // activation audit commits (agent-tools/plans/audit.ts). session_turns supplies only
  // live quote text for turns an audit already cited; those turns are historical and
  // do not change. RE-ARM: bridge plan_audits if a second activation-audit writer
  // appears or audit.ts stops pushing; never bridge session_turns (hot append ledger).
  'plans.provenance :: harness_shared.plan_audits':
    'the sole activation-audit writer (plans:audit) pushes plans.provenance after commit; bridge the table if another writer appears or that push is removed.',
  'plans.provenance :: harness_shared.session_turns':
    'quotes are read from turns an audit already cited, which are historical and immutable; session_turns is a hot append ledger, so a trigger would full-bust every open panel for nothing.',
};

/**
 * Registry entries that do not yet declare `backingTables`.
 *
 * SHRINK-ONLY. This is a ratchet, not a parking lot: it exists so the guard could be introduced
 * without auditing all 213 resolvers in one sitting, and every name removed from it is one more
 * panel whose liveness is provable rather than assumed. Do NOT add to it — a new registry entry
 * must declare its backing tables (or a PUSH_EXEMPT reason). See UNDECLARED_CEILING below.
 */
const UNDECLARED_BASELINE: readonly string[] = [
  'adaptiveTelemetry.byHarness',
  'advRoster.list',
  'agentChats.byHarness',
  'agentChats.detail',
  'agentConfig.modelTiersBaseline',
  'agentDetail.byOwner',
  'agentRunsConsolidated.recent',
  'auditLog.operatorDecisions',
  'automation.catalog',
  'autonomy.graduation',
  'autonomy.policy',
  'chunkPlans.byFeature',
  'chunkPlans.byHarness',
  'codeRecipes',
  'contributors.byHarness',
  'conversations.agentChatDetail',
  'conversations.agentChatList',
  'conversations.agentMessageDetail',
  'conversations.agentMessageList',
  'conversations.deliberationDetail',
  'conversations.deliberationList',
  'conversations.questionDetail',
  'conversations.questionsList',
  'coord.history',
  'coord.inbox',
  'coord.plans',
  'decision.ledger',
  'designMemos.list',
  'designRegistry.search',
  'designRegressions.list',
  'designSketches.byFeature',
  'designTokens.list',
  'dev.assignableMembers',
  'dev.coordFeed',
  'dev.coordPresence',
  'dev.fleetGovernor',
  'dev.pgActiveQueries',
  'dev.pgHealth',
  'dev.telemetry',
  'dev.toolFormatAdoption',
  'dockLayouts.byName',
  'dockLayouts.list',
  'evals.benchEstimate',
  'evals.benchRun',
  'evals.benchRunLive',
  'evals.benchRuns',
  'evals.coordTrace',
  'evals.fleet',
  'evals.report',
  'evals.runs',
  'evals.suites',
  'featureAudit.byHarness',
  'featureDebugNotes.byHarness',
  'featureNotes.byHarness',
  'featurePrs.byHarness',
  'featureTimeline.byFeature',
  'featuresConsolidated.byHive',
  'featuresConsolidated.byPlanSlug',
  'featuresConsolidated.bySlug',
  'featuresConsolidated.detail',
  'fleet.status',
  'fleetAssignments.byHarness',
  'fleets.byWorkspace',
  'harnessArchives.byHarness',
  'harnessBrainstorm.byHarness',
  'harnessCheckpoints.byHarness',
  'harnessDecisions.byHarness',
  'harnessEscalations.byHarness',
  'harnessHookLogs.byHarness',
  'harnessLanes.byHarness',
  'harnessLanes.snapshot',
  'harnessPendingIssues.byHarness',
  'harnessProjectFiles.byHarness',
  'harnessProjects.lite',
  'harnessScreenshots.byHarness',
  'harnessSkills.byHarness',
  'harnessSmokeTest.byHarness',
  'harnessStatus.byHarness',
  'harnessTests.byHarness',
  'harnessTextArtifact.byHarness',
  'harnessWorkspaces.byHarness',
  'health.history',
  'health.snapshot',
  'hive.beaconConsent',
  'hive.controlState',
  'hive.overrides',
  'hive.steering',
  'hive.workspaceScope',
  'hiveFromRepo.progress',
  'hiveRoster.byHarness',
  'hiveRoster.byHive',
  'insights.tokens',
  'issuesConsolidated.bySlug',
  'knowledgePacks.candidates',
  'knowledgePacks.list',
  'kpis.all',
  'learning.bakeoff',
  'learning.demand',
  'learning.efficacy',
  'learning.ekg',
  'learning.experiments',
  'learning.gym',
  'learning.health',
  'learning.hive',
  'learning.hiveList',
  'learning.hiveThroughput',
  'learning.improvements',
  'learning.knowledge',
  'learning.redQueen',
  'learning.releaseReadiness',
  'learning.scout',
  'network.board',
  'network.federationStatus',
  'network.fleet.wakes',
  'network.hive.asks',
  'network.hive.beacons',
  'network.hive.wakes',
  'network.hiveDirectory',
  'notes.list',
  'operatorBudget.byWorkspace',
  'operatorConfig.byWorkspace',
  'operatorConversations.current',
  'operatorPreferences.byWorkspace',
  'operatorReports.latest',
  'operatorStandingApprovals.byWorkspace',
  'operatorTurns.page',
  'overwatch.controlState',
  'overwatch.liveness',
  'overwatch.snapshot',
  'p2p.allotments',
  'p2p.audit',
  'p2p.grants',
  'p2p.settings',
  'pendingReviews.byHarness',
  'planItems.byPlan',
  'planSessions.list',
  'plans.attention',
  'plans.attentionCounts',
  'plans.attentionItem',
  'plans.byHive',
  'plans.get',
  'plans.items',
  'plans.lint',
  'plans.list',
  'plans.revisions',
  'plans.runHistory',
  'plans.runs',
  'plans.schedule',
  'plans.scheduledOccurrences',
  'plans.search',
  'plans.viewer',
  'plansDrafts.bySlug',
  'pluginConfigs.byHarness',
  'pluginEnables.byWorkspace',
  'prReviewerSettings.byHarness',
  'projectSpecRevisions.byProject',
  'proposalsShared.byHarness',
  'recipeCandidates',
  'rubrics.list',
  'savedPrompts.byScope',
  'scheduler.running',
  'sidebar.fleetCups',
  'snapshotsConsolidated.bySlug',
  'storage.usage',
  'taskManager.inventory',
  'toastLog.recent',
  'trust.list',
  'usage.spend',
  'userActions.byHarness',
  'userActions.byKind',
  'userActions.recent',
  'userMemory.feedbackStats',
  'userMemory.journalStatus',
  'userMemory.list',
  'userPreferences.current',
  'voicePrefs.effective',
  'voicePrefs.workspace',
  'weather.current',
  'workItems.delta24h',
  'workItems.stats',
];

/**
 * The baseline may only SHRINK. Set to the seeded size; lower it as entries are declared. Raising
 * it takes a deliberate edit here, which is the point: it makes growth visible in review instead of
 * a quiet append (the DARK_FLAGS_HIGH_WATERMARK pattern, and for the same reason — that watermark
 * got silently bumped 22→24→25→26 for the same bug class until it was split and pinned).
 */
const UNDECLARED_CEILING = 182;

/** Does a write to `table` invalidate `name`, through either invalidation surface? */
function tableInvalidates(table: string, name: string): boolean {
  for (const t of TABLE_TO_QUERY_NAMES[table] ?? []) {
    if ((typeof t === 'string' ? t : t.name) === name) return true;
  }
  // OPERATOR_STATE_SYNC_NAMES is keyed by BARE table name; TABLE_TO_QUERY_NAMES by schema.table.
  const bare = table.includes('.') ? table.slice(table.indexOf('.') + 1) : table;
  const stateNames = (OPERATOR_STATE_SYNC_NAMES as Record<string, readonly string[] | undefined>)[bare];
  return (stateNames ?? []).includes(name);
}

function declaredTables(name: string): readonly string[] {
  return getRegistryEntryV2(name)?.backingTables ?? [];
}

/**
 * An explicit empty array is a declaration: it means the resolver is deliberately file-backed
 * (or otherwise independent of Postgres), not that its liveness contract was forgotten. Keep
 * declaration PRESENCE separate from the list used by the invalidation-pair checks above.
 */
function hasBackingTablesDeclaration(name: string): boolean {
  const entry = getRegistryEntryV2(name);
  return entry !== undefined && Object.prototype.hasOwnProperty.call(entry, 'backingTables');
}

describe('sync resolvers — every declared backing table actually invalidates its query', () => {
  const allNames = [...knownQueryNamesV2()].sort();

  it('sanity: the registry is non-trivial and both invalidation maps loaded', () => {
    // Guards against a silently-empty set making every check below vacuous.
    expect(allNames.length).toBeGreaterThan(100);
    expect(Object.keys(TABLE_TO_QUERY_NAMES).length).toBeGreaterThan(20);
    expect(Object.keys(OPERATOR_STATE_SYNC_NAMES).length).toBeGreaterThan(0);
  });

  it('the regression case is pinned: accounts.pool declares operator_account_pool AND is invalidated by it', () => {
    // This exact pair was un-live for ~7 weeks (WI-6796). If this ever fails again, the Accounts tab
    // has silently gone back to refreshing on remount only.
    expect(declaredTables('accounts.pool')).toContain('harness_shared.operator_account_pool');
    expect(tableInvalidates('harness_shared.operator_account_pool', 'accounts.pool')).toBe(true);
  });

  it('workItemAdmission.runs declares both its ledger and queue-rollup producers', () => {
    expect(declaredTables('workItemAdmission.runs')).toEqual([
      'harness_shared.admission_runs',
      'harness_shared.work_items',
    ]);
  });

  it('WI-6182: all eight Learning-tab stragglers declare complete push-backed sources', () => {
    expect(declaredTables('learning.retain')).toEqual([
      'harness_shared.work_items',
      'harness_shared.coord_links',
      'harness_shared.harness_plans',
      'harness_shared.scout_lens_weights',
    ]);
    expect(declaredTables('learning.apiary')).toEqual([
      'harness_shared.cup_keeper_instances',
      'harness_shared.cup_keeper_runs',
      'harness_shared.cup_keeper_scores',
    ]);
    expect(declaredTables('learning.hiveEvalTrend')).toEqual([
      'harness_shared.pot_eval_instances',
      'harness_shared.pot_eval_runs',
      'harness_shared.pot_eval_scores',
    ]);
    expect(declaredTables('learning.scoutDrafts')).toEqual([
      'harness_shared.scout_routed_ideas',
      'harness_shared.harness_plans',
    ]);
    const analyzeSources = [
      'harness_shared.scout_cycle_stage_artifacts',
      'harness_shared.scout_ticks',
      'harness_shared.scout_routed_ideas',
    ];
    expect(declaredTables('learning.analyze')).toEqual(analyzeSources);
    expect(declaredTables('learning.analyzeCycle')).toEqual(analyzeSources);
    expect(declaredTables('learning.frontier')).toEqual([
      'harness_shared.routines',
      'harness_shared.scout_ticks',
      'harness_shared.learning_governor_loops',
      'harness_shared.calibration_predictions',
      'harness_shared.regret_findings',
      'harness_shared.transfer_lessons',
      'harness_shared.prompt_ablation_runs',
    ]);
  });

  it('every declared (query, table) pair is invalidated, or documented in PUSH_EXEMPT', () => {
    const unwired: string[] = [];
    for (const name of allNames) {
      for (const table of declaredTables(name)) {
        const key = `${name} :: ${table}`;
        if (tableInvalidates(table, name)) continue;
        if (PUSH_EXEMPT[key]) continue;
        unwired.push(key);
      }
    }
    expect(
      unwired.sort(),
      `Sync quer(ies) declare a backing table whose writes do NOT invalidate them. The panel will ` +
        `LOOK live and will not be — it refreshes on remount only, silently, exactly as accounts.pool ` +
        `did for ~7 weeks (WI-6796). For each: EITHER add the query name to that table's entry in ` +
        `table-to-query-names.ts / OPERATOR_STATE_SYNC_NAMES, OR — if it is deliberately poll-only (a ` +
        `continuous gauge, an external probe; see push-vs-poll-and-the-90s-dedupe) — add it to ` +
        `PUSH_EXEMPT in this file with the reason AND the re-arm condition.\n` +
        `  unwired: [${unwired.join(', ')}]`,
    ).toEqual([]);
  });

  it('no PUSH_EXEMPT entry is stale (each names a real declared pair that still lacks invalidation)', () => {
    const stale: string[] = [];
    for (const key of Object.keys(PUSH_EXEMPT)) {
      const [name, table] = key.split(' :: ');
      if (!name || !table) {
        stale.push(`${key} (malformed key — expected "<queryName> :: <schema>.<table>")`);
        continue;
      }
      if (!declaredTables(name).includes(table)) {
        stale.push(`${key} (no longer declared on that resolver)`);
        continue;
      }
      if (tableInvalidates(table, name)) stale.push(`${key} (now genuinely invalidated — the exemption is dead)`);
    }
    expect(
      stale.sort(),
      `PUSH_EXEMPT has stale entr(ies) — the pair is no longer declared, or has SINCE gained real ` +
        `invalidation. Remove the dead exemption so the allow-list keeps meaning something: ${stale.join(', ')}`,
    ).toEqual([]);
  });
});

describe('sync resolvers — the undeclared baseline is a shrink-only ratchet', () => {
  const allNames = [...knownQueryNamesV2()].sort();

  it('every registry entry either declares backingTables or is in the baseline', () => {
    const undeclared = allNames.filter((n) => !hasBackingTablesDeclaration(n)).sort();
    const declaredInBaseline = UNDECLARED_BASELINE.filter(hasBackingTablesDeclaration);
    expect(
      undeclared,
      `The set of registry entries WITHOUT a backingTables declaration has changed.\n` +
        `  • Added a NEW sync query? Declare its backingTables (see QueryEntry in sync-resolver/index.ts). ` +
        `Do NOT append it to UNDECLARED_BASELINE — the baseline is closed, and appending re-opens exactly ` +
        `the hole this guard exists to close.\n` +
        `  • Just declared one that used to be undeclared? Remove it from UNDECLARED_BASELINE and lower ` +
        `UNDECLARED_CEILING to match. That is one more panel whose liveness is now provable.\n` +
        `  Already declared baseline entries: [${declaredInBaseline.join(', ')}]`,
    ).toEqual([...UNDECLARED_BASELINE].sort());
  });

  it('the baseline never grows', () => {
    expect(
      UNDECLARED_BASELINE.length,
      `UNDECLARED_BASELINE grew. It is a ratchet for retiring an EXISTING gap, not a parking lot for ` +
        `new undeclared queries — a new entry must declare its backing tables instead.`,
    ).toBeLessThanOrEqual(UNDECLARED_CEILING);
  });

  it('the baseline names only real registry entries (it cannot rot ahead of the registry)', () => {
    const known = new Set(knownQueryNamesV2());
    const ghosts = UNDECLARED_BASELINE.filter((n) => !known.has(n));
    expect(ghosts, `UNDECLARED_BASELINE names quer(ies) no longer in the registry: ${ghosts.join(', ')}`).toEqual([]);
  });
});
