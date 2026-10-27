/**
 * identity-keyed-state-inventory.test.ts — the WI-3642 lesson generalized
 * (EI-8999: "Claim-integrity invariant sweep + compaction-survival test class
 * for ALL identity-keyed state").
 *
 * WI-3642's root cause was narrow in mechanism (rebindIdentity's held-items
 * step only re-keyed via the engineer_issues compat view, missing the
 * FEATURE-family majority of live claims) but general in CLASS: any column
 * that stores a CURRENT ownerId/sid — and that some liveness-tied reader or
 * reaper treats as "this row's current holder" — silently strands its state
 * under the dead sid the instant a compaction mints a new one, unless
 * rebindIdentity (or an equivalent) explicitly re-keys it. EI-8999 asks for a
 * sweep across every such column, not just the one WI-3642 happened to hit.
 *
 * A live-DB integration test can't do this sweep (it can only exercise
 * columns it already knows to look at — the exact blind spot that let
 * WI-3642 happen). Instead this is a STATIC inventory test over the
 * generated Drizzle schema (libs/papercusp/libs/db/src/schema/schema.ts,
 * `npm run pull-schema`'s output — the single source of truth for every
 * column that actually exists in harness_shared): it greps every table for
 * columns matching known "current holder" naming patterns, then checks each
 * hit against a maintained classification below:
 *
 *   - COVERED  — re-keyed by rebindIdentity's numbered surfaces (cross-checked
 *                against rebind-identity.ts's own surface list, so this file
 *                and that one can't silently drift apart).
 *   - EXEMPT   — deliberately NOT re-keyed, with a one-line reason (an
 *                append-only log/audit column, a TTL-leased row not tied to
 *                presence liveness, or a per-agent preference whose staleness
 *                is a UX nit, not a correctness bug).
 *
 * One class is skipped STRUCTURALLY rather than listed: frozen `bak_*`
 * pre-migration backup snapshots (`CREATE TABLE … AS SELECT` undo trails). They
 * cannot be live claim state by construction, and hand-classifying each new one
 * red the fleet-wide green-checkpoint four times. See
 * isFrozenBackupSnapshotTable below for the full rationale and its limits.
 *
 * A column the scan finds that is in NEITHER list fails the test — the same
 * shape as `production-defaults.test.ts`'s KNOWN_DARK_FLAGS watermark: a new
 * identity-keyed column must be a DELIBERATE decision (rebind it + add it
 * here, or exempt it with a stated reason), never a silent gap discovered
 * three weeks later as a WI-3642-shaped incident report.
 *
 * This also guards the ALLOWLIST itself: an entry that no longer matches any
 * live column (renamed/dropped) fails too, so the list can't rot into
 * fiction. Run: cd packages/operator-core && npx vitest run
 * lib/agent-tools/coordination/identity-keyed-state-inventory.test.ts
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The generated Drizzle schema — the single source of truth for what columns
// actually exist (kept in sync with prod via `pull-schema.mjs`, per CLAUDE.md's
// storage-policy section). Static-parsed, not imported: this file is huge and
// its module graph pulls in the full drizzle-orm table definitions, which is
// unnecessary weight for a pure text scan.
// Read `generated.ts`, NOT `schema.ts`: pull-schema.mjs writes schema.ts (the
// drizzle-kit output) then copyFileSync's it to generated.ts — byte-identical —
// but schema.ts is gitignored, so it is ABSENT in a clean checkout (e.g. the
// release green-checkpoint worktree), where reading it ENOENTs and reds the gate.
// generated.ts is the TRACKED mirror, so the scan is deterministic everywhere.
// EI-20012634773877104: the subject path is OVERRIDABLE via
// IDENTITY_KEYED_SCHEMA_PATH so this same assertion can be run against a
// CANDIDATE schema before it is promoted to generated.ts. That is what lets
// `scripts/check-identity-keyed-classification.mjs` gate pull-schema.mjs with
// this exact test rather than a second, drift-prone copy of the predicate —
// and it is what lets that guard's own falsifiability test point at a temp
// fixture instead of mutating this shared tree. The default is unchanged, so
// every ordinary run (and the fleet gate) still reads the tracked mirror.
const SCHEMA_PATH = process.env.IDENTITY_KEYED_SCHEMA_PATH
  ? resolve(process.env.IDENTITY_KEYED_SCHEMA_PATH)
  : resolve(__dirname, '../../../../../libs/papercusp/libs/db/src/schema/generated.ts');

/** table.column keys the scan is allowed to find without failing — see the
 *  module doc above for COVERED vs EXEMPT semantics. */
interface Classification {
  status: 'covered' | 'exempt';
  /** For `covered`, the rebindIdentity surface name (cross-checked below). */
  surface?: string;
  /** For `exempt`, why a compaction rebind stranding this column is safe. */
  reason?: string;
}

const ALLOWLIST: Record<string, Classification> = {
  // --- COVERED: re-keyed by rebindIdentity (rebind-identity.ts) ---
  'routines.target_owner_id': { status: 'covered', surface: 'loop-routine' },
  'pending_wakes.owner_id': { status: 'covered', surface: 'pending-wakes' }, // EI-8999
  'coord_presence.owner_id': { status: 'covered', surface: 'presence' },
  'fleet_membership_events.owner_id': { status: 'covered', surface: 'fleet-membership' },
  'agent_fleets.leader_owner_id': { status: 'covered', surface: 'fleet-leadership' },
  // cup-lexicon-full-rename P-009 Phase 2 (WI-3954): the base table (né bee_claim_specs).
  'cup_claim_specs.bee_id': { status: 'covered', surface: 'claim-spec' },
  // The compat VIEW over cup_claim_specs (dropped in a later contract phase) —
  // re-keyed transitively via the base table's 'claim-spec' rebind surface.
  'bee_claim_specs.bee_id': { status: 'covered', surface: 'claim-spec' },
  // Migration 810's retained history for the row above (EI-18677010014746233). COVERED,
  // not exempt, even though it is append-only: this is the UNDO for a destructive spec
  // write, so leaving it under a dead id makes `scheduler:get_claim_spec { cupId,
  // history }` return an EMPTY window to the rebound agent — which reads as "no history"
  // rather than "filed under the id you no longer are". Re-keyed by the same
  // 'claim-spec' surface, deliberately as its LAST statement (the surface's own DELETE
  // fires the retention trigger and writes one more ghost-keyed row).
  'cup_claim_spec_revisions.bee_id': { status: 'covered', surface: 'claim-spec' },
  'event_awaits.subscriber_id': { status: 'covered', surface: 'awaits' },
  // Migration 839. The PARENT registry row of 'event_awaits.subscriber_id' directly
  // above: one watch:create row fans out to a paired event_awaits row (wake:true)
  // and/or a coord_entity_subscriptions inject row (wake:false). Delivery selects
  // those CHILDREN, so an unmoved parent does not stop wakes — it breaks the UPSERT
  // IDENTITY instead: interest-watch.ts re-finds an existing watch by
  // (owner_id, event_key), so a rebound agent stops matching its own row, inserts a
  // duplicate, and the original lingers under the dead sid, swept forever and
  // cancellable by nobody. COVERED, active rows only (an inactive watch is spent).
  'interest_watches.owner_id': { status: 'covered', surface: 'interest-watches' },
  // EI-21457373491665728: consult verbs authorize CURRENT participants through
  // these columns. Open rows follow a rebound session, and expired rows do too
  // because consult:close retains a requester-only late-disposition action.
  'consult_state.requester_id': { status: 'covered', surface: 'consult-participants' },
  'consult_state.responder_id': { status: 'covered', surface: 'consult-participants' },
  'plan_item_claims.owner': { status: 'covered', surface: 'plan-claims' },
  'work_item_claims.owner': { status: 'covered', surface: 'work-claims' },
  'coord_watermarks.owner_id': { status: 'covered', surface: 'watermarks' },
  'coord_read_cursors.owner_id': { status: 'covered', surface: 'read-cursors' }, // EI-8999, caught live as migration 537 landed

  'work_items.taken_by': { status: 'covered', surface: 'held-work-items' },
  'agent_facts.scope_ref': { status: 'covered', surface: 'owner-facts' },

  // --- EXEMPT: deliberately not re-keyed ---
  'code_intel_research_trails.owner_id': {
    status: 'exempt',
    reason:
      'Migration 1561 stores optional caller-session research history. research-trail.ts persistResearchBatch ' +
      'and readResearchTrail key it by workspace, stable owner and harness, retain subjects for seven days, ' +
      'and never use it as a current-holder claim or presence-tied reaper. A different session may start ' +
      'a fresh trail; rebinding would mix its research history with the original session context.',
  },
  'code_intel_pushes.owner_id': {
    status: 'exempt',
    reason:
      'Migration 1519 records delivered code-intelligence facts by recipient, compaction epoch and hook turn. ' +
      'push-channel.ts commitPushFacts uses that history for delivery deduplication and per-turn character spend, ' +
      'not a current-holder claim or presence-tied reaper. Rebinding would rewrite who received a fact and ' +
      'mix the historical delivery/budget ledger of distinct session contexts.',
  },
  'code_intel_push_skips.owner_id': {
    status: 'exempt',
    reason:
      'Migration 1544 records code-intelligence facts that a recipient turn could not receive because the ' +
      'request or turn character budget was spent (push-channel.ts recordPushSkips). It is per-turn ' +
      'delivery evidence beside code_intel_pushes, not a current-holder claim or presence-tied reaper; ' +
      'rebinding would rewrite which session context missed a fact.',
  },
  'gateway_request_outcomes.owner_id': {
    status: 'exempt',
    reason:
      'Migration 1510 per-request gateway outcome evidence: gateway-request-outcome-store.ts writes the ' +
      'requesting owner at finalization and prunes by retention_expires_at_ms. This is historical route/error ' +
      'attribution, not a live claim; rebinding would misattribute earlier requests to a successor.',
  },
  'desktop_sessions.scope_ref': {
    status: 'exempt',
    reason:
      "polymorphic desktop RESOURCE selector paired with scope='pot'|'agent'|'workspace' — not an owner-id column. " +
      'Desktop liveness and reaping use owner_pid + owner_boot_id, lifecycle state, TTL, and task_id; no ' +
      'presence-tied reader/reaper treats scope_ref as the current holder. Rebinding it would wrongly transfer a ' +
      'display lease (and would corrupt pot/workspace refs), so callers explicitly resolve or re-register the scope.',
  },
  'trigger_sources.scope_ref': {
    status: 'exempt',
    reason:
      'Migration 1324 EXPAND-phase compat VIEW over data_sources (SELECT * FROM harness_shared.data_sources), kept ' +
      'only so the deployed release still resolves the old table name; same column, same exemption as ' +
      'data_sources.scope_ref below. Remove this entry when the CONTRACT migration drops the view.',
  },
  'data_sources.scope_ref': {
    status: 'exempt',
    reason:
      "enterprise-data-sources-2026-10-01 D-010 (migration 1317; table renamed from trigger_sources by 1324): the " +
      "data-source CORPUS-scope reference — a pot " +
      "slug, non-null iff scope='pot' (data_sources_scope_ref_chk) and NULL for scope='personal'|'organization'. " +
      'It is a configuration selector naming which pot a connector ingests into, never an ownerId/sid; the ' +
      'personal owner lives in owner_user_id (a human user id). No presence-tied reader/reaper keys on it, and ' +
      'rebinding it would corrupt the pot ref. Same class as desktop_sessions.scope_ref.',
  },
  'governance_policy_layers.scope_ref': {
    status: 'exempt',
    reason:
      'papercusp-enterprise-readiness-roadmap-2026-10-09 P-005 (migration 1497): the governance-policy LAYER scope, ' +
      "paired with level='organization'|'department'|'workspace' and unique per (level, scope_ref). It holds an org, " +
      'department or workspace id, never an agent ownerId/sid. No presence-tied reader/reaper keys on it, and ' +
      'rebinding it would move a policy layer onto the wrong tenant. Same class as data_sources.scope_ref.',
  },
  'governance_policy_layer_versions.scope_ref': {
    status: 'exempt',
    reason:
      'Migration 1497 append-only versioned evidence of governance_policy_layers: a historical copy of the ' +
      'layer scope (org/department/workspace id) at each version. It is provenance, not a current-holder claim, ' +
      'so rewriting it would falsify the audit record. Same exemption as governance_policy_layers.scope_ref.',
  },
  'agent_activity.owner_id': {
    status: 'exempt',
    reason: 'append-only activity LOG (who did what, when) — not a current-holder claim any reader treats as live.',
  },
  'orientation_class_reach.owner_id': {
    status: 'exempt',
    reason:
      'migration 1192 per-owner orientation TELEMETRY counters (turns_rendered / rows_rendered, first/last_rendered_at) — ' +
      'a historical measurement of what was actually rendered to an id, not a current-holder claim. Re-keying would ' +
      'restate one agent reach as another and corrupt the metric, so stranding it is the correct outcome.',
  },
  'orientation_obligation_action.owner_id': {
    status: 'exempt',
    reason:
      'migration 1192 per-owner obligation LATENCY telemetry (turns_outstanding, turns_to_disposition, dispositions) — ' +
      'measures how long the id that actually saw an obligation took to disposition it. No reaper or reader treats the ' +
      'row as a live claim, and rebinding would attribute one agent latency to another.',
  },
  'psu_pty_host_events.owner_id': {
    status: 'exempt',
    reason:
      'append-only psu pty host EVENT LOG (ts / kind / payload / row_digest) carrying its own TTL retention sweep — ' +
      'psu-pty-host-events-ingest.ts DELETEs aged rows, so this is provenance of which id emitted the event and is ' +
      'aged out rather than re-keyed.',
  },
  'event_wake_attempts.subscriber_id': {
    status: 'exempt',
    reason:
      'migration 958 append-only required-wake OUTCOME ledger: inbox-wake.ts stamps the recipient that was ' +
      'actually targeted, and presence-wakeability.ts reads only recent attempts to decide whether that original ' +
      'session missed a required wake. It is evidence, not a live await/claim; rebinding would falsify the recipient ' +
      "and could transfer an old session's miss/queued evidence onto the new session.",
  },
  'triage_snapshots.taken_by': {
    status: 'exempt',
    reason:
      'historical author provenance on an immutable stamped census (migration 892) — no executable reader/reaper treats it as current ownership, and rebinding would falsify who took the snapshot.',
  },
  // A NAME COLLISION, not a coordination column (WI-1220421). This scan is name-based, and
  // `owner_id` here belongs to a DIFFERENT IDENTIFIER SPACE: it is the app-side
  // `AuthIdentity.ownerId` — the opaque `sub` of a JWT the app itself verifies
  // (apps/sidecar/src/auth.ts) — not a papercusp agent/session id. Migration 1029 states
  // outright that the two spaces are unrelated and NOT derivable from one another, and that
  // inferring one from the other is the failure the table exists to prevent.
  //
  // Note this is the one exempt entry where a rebind is PROHIBITED rather than merely
  // pointless, so do not "upgrade" it to covered: rewriting it would re-point a real
  // platform user's app mapping at a different app owner and silently deliver one person's
  // mail into another person's app — the cross-tenant leak the
  // app_owner_mappings_owner_unique constraint was added to stop. Per owner-mapping.ts, a
  // wrong mapping "does not raise an error anywhere".
  'app_owner_mappings.owner_id': {
    status: 'exempt',
    reason:
      'app-side JWT `sub` (migration 1029), a different identifier space from papercusp agent ids — a deliberately configured operator mapping, never a presence-tied holder claim, with no reaper or lease. Rebinding is PROHIBITED, not merely unnecessary: it would silently deliver one user’s data into another user’s app.',
  },
  // Migration 745 (EI-19411045952024591). Deliberately the EXEMPT twin of the COVERED
  // 'routines.target_owner_id' above: that column is the live claim (rebound so the loop
  // keeps waking the right agent); THIS one is its append-only HISTORY. Rebinding here
  // would not merely be unnecessary, it would FALSIFY the evidence — the table exists
  // because the single-row stores overwrite themselves, so rewriting a past transition's
  // owner destroys the very record ("who held this routine when it parked") it was added
  // to preserve. Sole writer is loop-transition-log.ts; no functional reader (adv-roster
  // and dead-owner-control-sweep read `routines`, not this table), and the migration
  // states the contract outright: "evidence, never an input to scheduling".
  'routine_loop_transitions.target_owner_id': {
    status: 'exempt',
    reason:
      'append-only transition HISTORY of routines.target_owner_id (migration 745) — a record of who was targeted AT that transition, never read as a live claim. A rebind would corrupt the forensic record it exists to keep.',
  },
  'adv_sessions.coord_owner_id': {
    status: 'exempt',
    reason: "the session's OWN record, created under its own id at boot — never read/reaped keyed on a DIFFERENT session's liveness.",
  },
  'blueprint_package_installations.owner_id': {
    status: 'exempt',
    reason:
      'immutable wearer of an exact owner/specification/state installation (migration 1232), not a presence lease or current-holder claim. sessionPackageDependentId hashes the original owner into dependent_id; rebinding only owner_id would corrupt that identity and transfer applicability. A replacement logical wearer must prepare its own dependent; the old installation is retired through its persisted resource journal, never adopted by rebindIdentity.',
  },
  'tool_invocations.coord_owner_id': {
    status: 'exempt',
    reason: 'immutable per-call audit log row — attribution, not a claim any reaper acts on.',
  },
  // Migration 1149 (P-009 / D-028 / D-030) — active-identity attribution. Same shape as
  // agent_mode_changes.owner_id below: the LIVE authority is session_briefs.control_state.activation,
  // and these are its temporal flight record. Verified 2026-09-12 against pg_class: the events row
  // is the only TABLE; the other three are VIEWS derived from it.
  'session_identity_activation_events.owner_id': {
    status: 'exempt',
    reason:
      'append-only immutable activation-event ledger (migration 1149) — one row per desired/prepared/applied/failed transition phase. The CURRENT activation lives in session_briefs.control_state.activation, which the migration header names as the sole live authority; this is history. A stranded row loses a past transition from the flight record and can never mis-deliver a live claim.',
  },
  'session_identity_activation_spans.owner_id': {
    status: 'exempt',
    reason:
      'VIEW derived from session_identity_activation_events (verified relkind=v) — holds no state of its own, so a rebind has nothing to rewrite here; classification follows the base ledger above.',
  },
  'session_identity_layer_spans.owner_id': {
    status: 'exempt',
    reason:
      'VIEW derived from session_identity_activation_events (verified relkind=v) — holds no state of its own; classification follows the base ledger above.',
  },
  'tool_invocations_identity_attribution.coord_owner_id': {
    status: 'exempt',
    reason:
      'VIEW joining the activation ledger to existing tool/inference meters (verified relkind=v) — holds no state of its own, and its base column tool_invocations.coord_owner_id is already exempt above as per-call audit attribution.',
  },
  'agent_mode_changes.owner_id': {
    status: 'exempt',
    reason: 'append-only mode-change event log — the CURRENT mode lives in agent_modes.owner_id (see below), this is history.',
  },
  'agent_modes.owner_id': {
    status: 'covered',
    surface: 'agent-modes',
  },
  'agent_display_names.owner_id': {
    status: 'exempt',
    reason:
      'durable manual display-name attribute (migration 1045 / D-003), not a live claim or lease; a rebound session may miss the old cosmetic name and safely falls back to objective/short id, while rebinding could transfer a human-chosen label to a different session.',
  },
  'agent_seat_consumptions.owner_id': {
    status: 'exempt',
    reason: 'seat accounting is boot-time-consume / explicit-release (consumeSeatAtBoot / releaseSeatConsumption), not presence-reap-tied as far as this sweep found — flagged for a follow-up audit of its release path (no reaper caller found; TTL/explicit-release only), not a confirmed WI-3642-class bug.',
  },
  // Migrations 1251 + 1253 (portable-identity-packages-2026-09-26 P-011, D-024).
  'identity_hook_turns.owner_id': {
    status: 'exempt',
    reason:
      "a session's CURRENT identity-hook turn and what its sinks spent in it — per-turn budget scratch, replaced wholesale at every turn start. A rebound id simply opens a fresh turn at its first sink; a stranded row only means the old id's last turn is never charged again.",
  },
  'session_briefs.owner_id': {
    status: 'exempt',
    reason: "the session's own carry-brief snapshot, written by and read back by the SAME id at each of its own turns — a rebind moves the loop carry-note (a separate surface) which is what a cold successor actually reads.",
  },
  // Migration 779 (fleet-lead-instrumentation-audit-2026-08-09 D-011), classified as the
  // EXEMPT twin of session_briefs.owner_id directly above — same class: an agent's own
  // snapshot, written and read back by the SAME id at each of its own wakes.
  'fleet_brief_snapshots.owner_id': {
    status: 'exempt',
    reason:
      "the LEADER's own wake-boundary snapshot behind fleet:leader-brief's delta block — keyed per-leader by design (D-011 §4) precisely so two readers of one fleet cannot consume each other's baseline. A rebind strands the row, so the next read simply finds no baseline for the new id — which the brief reports as `available:false`, NEVER as a zero delta (the migration's own stated contract). So a stranded row costs delta CONTINUITY across a respawn and can never produce a WRONG delta: it fails safe and announces itself, unlike the coord_read_cursors/coord_watermarks entries above, where a stranded row silently mis-delivers. Upgrade to covered if leader-brief continuity across a rebind is later judged worth the re-key.",
  },
  'session_respawn_expected.owner_id': {
    status: 'exempt',
    reason:
      'a single-use, short-TTL marker that only ever SUPPRESSES a release — never grants or holds a resource. A rebind stranding the row cannot lose a claim: a consume that misses simply runs the ordinary session-end lease release (the pre-existing behavior), and the orphaned row is deleted by its own TTL on the next consume. Fail-safe by construction (WI-6756 leg 2, migration 716).',
  },
  'flush_gate_refusals.owner_id': {
    status: 'exempt',
    reason:
      'a short-TTL P-016 boundary-refusal marker (migration 805) that only suppresses a duplicate refusal for the same boundary/owner pair; it never grants or holds a resource. A rebind strands at most a ten-minute marker, while the new owner can record its own refusal, and expiry bounds residue. The marker also fails open on storage trouble, so no live claim or reaper depends on this owner_id.',
  },
  // WI-10002452. This entry used to read `covered`/'owner-directives', and was
  // WRONG in the most expensive way available: the surface it named exists, so
  // the cross-check below passed, while its predicate (`WHERE owner_id =
  // <from-session-id>`) could never match a row. A NAMED surface is not a
  // WORKING one, and the one guard built to catch stranded identity columns was
  // certifying this one as protected.
  //
  // Measured over all 203 live rows: owner_id is 'owner' ×181 and 'Avi' ×22 —
  // zero session-shaped values, and `owner_id = recorded_by` false for every
  // row. It is the HUMAN owner's label, not a session id, so there is nothing
  // for a rebind to re-key and stranding it is meaningless rather than safe-ish.
  // The live binding moved to `recorded_by` below, which is what the original
  // 'owner-directives' surface was always reaching for.
  'owner_directives.owner_id': {
    status: 'exempt',
    reason:
      'the HUMAN owner label, not a coord session id — measured across all 203 live rows as ' +
      "'owner' ×181 / 'Avi' ×22, zero session-shaped, and never equal to recorded_by. A rebind " +
      'has nothing to re-key here; the live per-session binding is owner_directives.recorded_by, ' +
      'which carries the real owner-directives surface (WI-10002452).',
  },
  // The column the name rule cannot see (provenance-SHAPED, identity-VALUED) —
  // swept in deliberately via IDENTITY_COLUMNS_BY_DECLARATION. Open rows are
  // binding control state rendered on every wake/orient until dispositioned, so
  // they must follow a re-bound live session; dispositioned rows stay on the
  // originating sid as immutable history and rebindIdentity leaves them. That
  // was always the INTENT of the 'owner-directives' surface — it was simply
  // pointed at the wrong column until WI-10002452.
  'owner_directives.recorded_by': {
    status: 'covered',
    surface: 'owner-directives',
  },
  // Migration 1195 (directive-visibility-and-ownership-2026-09-22, P-008 / D-008).
  // The PER-SESSION agenda row that replaces the global capture_status column: it
  // says whether THIS owner still has the directive on its own banner, so a
  // stranded row re-renders a directive the session already cleared (or, worse,
  // silently keeps one cleared for an id nobody is running). It is this session's
  // own live control state, so it must follow a re-bound session exactly as the
  // owner_directives rows above do.
  'owner_directive_agenda.owner_id': {
    status: 'covered',
    surface: 'directive-agenda',
  },
  'tui_view_state.owner_id': {
    status: 'exempt',
    reason: 'per-agent UI preference (panel layout etc.) — a rebind losing it means the new sid sees default UI state, not a lost claim or a wrongly-freed resource.',
  },
  'test_downgrades.owner': {
    status: 'exempt',
    reason:
      'accountability record (green-main-ratchet P-002): who owns getting a downgraded test blocking again. No reaper or reader keys on it as a live holder; the downgrade stays active until revoked, and the daily digest surfaces it whatever the owner session state.',
  },
  'tui_layouts.owner_id': { status: 'exempt', reason: 'same class as tui_view_state.owner_id — UI preference, not a claim.' },
  'tui_crews.owner_id': { status: 'exempt', reason: 'same class as tui_view_state.owner_id — UI preference, not a claim.' },
  'agent_name_sessions.session_owner_id': {
    status: 'exempt',
    reason: 'naming-registry attribution for a session that already exists under its own id — not reaped by a different id going stale.',
  },
  'fleet_ekg_sessions.owner_id': {
    status: 'exempt',
    reason: 'EKG telemetry session record, keyed by its own id at creation — not a claim another reaper acts on.',
  },
  'shared_session_presence.owner_id': {
    status: 'exempt',
    reason: "the federation mirror of coord_presence — same ghost-row-on-death handling as the 'presence' surface (the live id's own beat repopulates it; nothing to move).",
  },
  'bench_run_tasks.bee_id': {
    status: 'exempt',
    reason: 'benchmark-harness run attribution, an isolated evaluation context — not live coordination state a reaper touches.',
  },
  'coord_entity_subscriptions.subscriber_id': {
    status: 'exempt',
    reason: 'topic subscriptions are cheaply re-established (declare-intent / topics:subscribe re-fires each orient) — a rebind losing one means a missed notification window, not a stranded claim/resource. Worth a future rebind surface if this proves to bite in practice; filed as a follow-up, not a confirmed incident.',
  },
  'event_wake_deliveries.subscriber_id': {
    status: 'exempt',
    reason: 'a delivery-history LOG row (what was sent to whom) — not a live subscription or claim.',
  },
  'gateway_stall_events.owner_id': {
    status: 'exempt',
    reason:
      'append-only stall-event LOG (migration 624, EI-2431): a short-lived durability mirror of the ' +
      "gateway's in-memory stall ring, age-pruned on every insert — owner_id is the wake TARGET the " +
      'stall-waker resolves at read time, not a held claim. A carry-respawn keeps the coord ownerId so ' +
      'the row stays addressable, and a row for a genuinely dead owner just ages out; no presence-tied ' +
      'reaper keys on this table.',
  },
  'event_await_nodes.subscriber_id': {
    status: 'exempt',
    reason:
      'composable-event-awaits (migration 572): the interior/root threshold-tree nodes. The WAKE routes ' +
      "through the tree's ANCHOR event_awaits row (fireComposedRoot → insertComposedRootDelivery uses " +
      "anchor.subscriberId), and event_awaits.subscriber_id IS re-keyed (the 'awaits' surface) — so a rebind " +
      'still delivers the composed wake to the live sid. No presence-tied reaper keys on this table (the ' +
      'timeout sweep keys on expires_ts, a TTL); the node subscriber_id is read only by listActiveComposedRoots ' +
      'for the events:status tree render, so a stale sid means the tree does not render under the new sid — a ' +
      'display nit, not a stranded claim. Same class as event_wake_deliveries/coord_entity_subscriptions.',
  },
  'voice_lease.owner_id': {
    status: 'exempt',
    reason: 'a TTL-expiring lease (its own expires_ts governs reclaim) — not reaped by presence liveness of the owner id.',
  },
  'llm_test_claims.owner_id': {
    status: 'exempt',
    reason: 'an isolated eval-harness claim (LLM test scenario runs), TTL-leased like voice_lease — not part of live agent coordination presence sweeps.',
  },
  'work_item_replicas.owner': {
    status: 'exempt',
    reason: 'a heartbeat-LEASED redundancy slot (migration 195) reclaimed on its own expires_ts, same TTL-lease class as voice_lease/llm_test_claims — not presence-reaped.',
  },
  'agent_fleets.owner': {
    status: 'exempt',
    reason: "the fleet's CREATOR attribution, distinct from leader_owner_id (current leadership, covered by the 'fleet-leadership' surface) — display/provenance only, no reaper keys on it.",
  },
  'session_turns.owner': {
    status: 'exempt',
    reason: 'a per-turn append-only session-history log row (which session logged this turn) — attribution, not a live claim.',
  },
  'session_turn_parts.owner': {
    status: 'exempt',
    reason:
      'same class as session_turns.owner — migration 702 makes this table the append-only PARTS companion to that log (its own header: "the FAITHFUL transcript companion to session_turns"), so the column is which session logged the part. Attribution, not a live claim; retention prunes it at 14d and no reaper keys on it.',
  },
  'harness_plans.owner': {
    status: 'exempt',
    reason: "the plan's creator/owner attribution field, distinct from the per-lane plan_item_claims.owner (covered by the 'plan-claims' surface) — display/provenance only, no reaper keys on it.",
  },
  'engineer_issues.assignee': {
    status: 'covered',
    surface: 'held-items',
    // (Also covered transitively by 'held-work-items', which re-keys the
    // underlying work_items.taken_by this compat view reads through — see
    // rebind-identity.ts step 11 vs 11b.)
  },
  'harness_features.taken_by': {
    status: 'covered',
    surface: 'held-work-items',
    // A per-harness-schema view/legacy projection over the same
    // harness_shared.work_items.taken_by column 'held-work-items' re-keys
    // directly — not an independently-stored copy.
  },
  'harness_features_consolidated.taken_by': {
    status: 'covered',
    surface: 'held-work-items',
  },
  'work_items_claimable.taken_by': {
    status: 'covered',
    surface: 'held-work-items',
    // work-item-claim-floors-ssot (migration 654): a VIEW that projects
    // `wi.taken_by` straight through from harness_shared.work_items (see
    // `CREATE VIEW harness_shared.work_items_claimable` in
    // 654-work-item-claim-floors-ssot.sql) — not an independently-stored
    // copy, so the base table's 'held-work-items' rebind already covers it,
    // same shape as harness_features(_consolidated).taken_by above.
  },

  'predicate_watches.owner_id': {
    status: 'exempt',
    reason:
      'registrant attribution for the poll dispatch principal + display (predicate-watch.ts) — the row\'s ' +
      'actual liveness is governed entirely by its PAIRED event_awaits row (gcOrphanedPredicateWatches ' +
      'deactivates on that pairing going inactive, never on owner_id/presence), and event_awaits.subscriber_id ' +
      'IS re-keyed (the \'awaits\' surface) — so a stale owner_id here means the dead predecessor\'s id lingers ' +
      'in error/source strings, not a stranded claim or a wrongly-GC\'d watch. Same class as tui_view_state.owner_id.',
  },
  'session_archives.owner': {
    status: 'exempt',
    reason:
      "the archived session's OWN post-mortem attribution, stamped by archiveSession() AFTER that session " +
      'already ended (migration 539) — never read by a reaper keyed on a DIFFERENT session\'s presence, same ' +
      'class as session_turns.owner.',
  },
  'event_awaits.scope_ref': {
    status: 'exempt',
    reason:
      "EI-9270 (announced gate events): the DISCOVERY-scope slug (fleet/plan/harness) that gates who sees a " +
      "policy='announce' row in events:catalog/coord:orient — NOT an ownerId/sid (contrast agent_facts.scope_ref, " +
      "which IS one). scope_ref is only 'identity-shaped' by column-name pattern; its actual value is a " +
      "fleet/plan/harness slug (or null for scopeKind='global'), never a current-holder claim a presence-tied " +
      'reaper/reader keys on — no rebind needed.',
  },
  'event_awaits_effective.subscriber_id': {
    status: 'covered',
    surface: 'awaits',
    // P-016 (migration 710): a VIEW defined as `SELECT a.*, <derived deadline
    // columns> FROM harness_shared.event_awaits a` — subscriber_id is projected
    // straight through, unmodified, not an independently-stored copy. The base
    // table's 'awaits' rebind therefore already covers it; the view adds only
    // effective_*/root_* deadline columns. Same shape as work_items_claimable.taken_by.
  },
  'event_awaits_effective.scope_ref': {
    status: 'exempt',
    reason:
      "the same DISCOVERY-scope slug as event_awaits.scope_ref, reaching this view unmodified through its " +
      "`SELECT a.*` projection (migration 710) — a fleet/plan/harness slug gating who SEES an announced row, " +
      "never an ownerId/sid a presence-tied reaper keys on. Identity-shaped by column name only; see the " +
      'event_awaits.scope_ref entry above for the full argument. No rebind needed, for the same reason.',
  },
  'session_turn_journal.owner_id': {
    status: 'exempt',
    reason:
      'deterministic-context-carry-2026-07-14 P-012 (migration 605): one append-only row inserted per turn end ' +
      '(recordTurnJournal), never updated — owner_id is attribution of who wrote the journal note, read back via ' +
      'journal:recent filters, not a current-holder claim any presence-tied reaper acts on. Same class as ' +
      'session_turns.owner / agent_activity.owner_id.',
  },
  'session_cursor.owner_id': {
    status: 'exempt',
    reason:
      'ambient-semantic-push-2026-07-14 P-001 (migration 609): per-session lexical-cursor cache keyed by ' +
      'session_id, REBUILT at every turn end and pruned by staleness code-side — owner_id is nullable ' +
      '("coord identity when known") debug/prune metadata, never a current-holder claim a presence-tied ' +
      'reaper/reader keys on. Same class as session_turns.owner.',
  },
  'push_delivery.target_owner_id': {
    status: 'exempt',
    reason:
      'ambient-semantic-push-2026-07-14 P-003 (migration 610): the ambient-push delivery rail\'s queue + tally + ' +
      'disposition ledger — target_owner_id is the RECIPIENT axis of a per-push row (queued → delivered/dropped). ' +
      'A row stranded by an identity rebind is just an ambient hint that never ships (the rail\'s own floor/' +
      'novelty/budget gates drop it); nothing holds work or is reaped on it. Whole feature DEFAULT-OFF behind ' +
      'PAPERCUSP_AMBIENT_CURSOR.',
  },
  'collision_hysteresis.owner_id': {
    status: 'exempt',
    reason:
      'ambient-semantic-push-2026-07-14 P-004 (migration 612): per-SELF-session detector streak state keyed by ' +
      'session_id, replaced on every tick — owner_id is nullable and per the migration comment "for pruning/' +
      'debugging only". Same class as session_cursor.owner_id.',
  },
  'topic_hysteresis.owner_id': {
    status: 'exempt',
    reason:
      'ambient-semantic-push-2026-07-14 P-008 (migration 613): per-SELF-session auto-subscribe streak state, ' +
      'same shape and same "for pruning/debugging only" owner_id as collision_hysteresis.owner_id.',
  },
  'adjacency_state.owner_id': {
    status: 'exempt',
    reason:
      'ambient-semantic-push-2026-07-14 P-013 (migration 614): per-SELF-session adjacency streak state, same ' +
      'shape and same "for pruning/debugging only" owner_id as collision_hysteresis.owner_id.',
  },
  // NOTE: snapshot / scratch tables are NOT listed here. TWO independent
  // mechanisms keep them out of this allowlist, and BOTH mean a hand-written
  // entry for one is guaranteed to rot (asserted below by the
  // "no leading-underscore scratch tables" test):
  //
  //   1. `bak_*` frozen undo snapshots are skipped structurally by the scan
  //      itself (isFrozenBackupSnapshotTable — see its comment for why, and for
  //      the four gate reds that motivated it). The two entries that used to sit
  //      here (bak_20260717_unify_work_items.taken_by,
  //      bak_20260717_unify_subs.subscriber_id) were removed with that change:
  //      the scan no longer finds them, so leaving them would red the "allowlist
  //      has not rotted" test instead.
  //
  //   2. Leading-underscore MIGRATION-INTERNAL scratch tables (e.g.
  //      `_pot_backfill_649_dropped`, `_pot_members_686_orphans`) never reach
  //      the scan at all: pull-schema.mjs "Fix 0" strips them from
  //      generated.ts before it is written (stripScratchTableDeclarations,
  //      EI-18785808338338490). A `_pot_backfill_649_dropped.taken_by` entry
  //      DID sit here — added 2026-07-20 when drizzle-kit still emitted the
  //      table — and it reds this gate as soon as the strip landed
  //      (2026-07-27). The table still EXISTS in Postgres; it is simply no
  //      longer application surface, so there is nothing for this inventory to
  //      classify. Do not re-add it when you see the table in psql.
  'session_pending_gates.owner_id': {
    status: 'exempt',
    reason:
      'owner-inbox-single-pane-2026-07-17 P-002 (migration 619): "asking agent\'s coord identity, when known" — ' +
      'a provenance stamp set once at gate-open and only ever read back for DISPLAY (sessions:list-pending-gates, ' +
      'the owner-wall attention adapter). No reader re-queries or reaps rows keyed on a LIVE owner_id — the gate ' +
      'itself is addressed by (session_id, ref_id), same class as agent_activity.owner_id / tool_invocations.coord_owner_id.',
  },
};

/** Column-name patterns that mean "this stores a CURRENT holder/owner
 *  identity" — the shape a presence-tied reader/reaper is likely to key on.
 *  Deliberately narrow (false negatives are safer than false positives here:
 *  a name like `created_by` or `assigned_by` is PROVENANCE — who did this —
 *  not a live claim, and is excluded on purpose). */
const IDENTITY_COLUMN_NAMES = new Set([
  'owner_id',
  'owner',
  'assignee',
  'taken_by',
  'held_by',
  'holder_id',
  'claimed_by',
  'locked_by',
  'leader_owner_id',
  'target_owner_id',
  'subscriber_id',
  'bee_id',
  'session_owner_id',
  'coord_owner_id',
  'requester_id',
  'responder_id',
  'scope_ref', // only identity-shaped when paired with scope='owner' (agent_facts) — swept in, classified by table.
]);

/** Per-TABLE opt-ins: `table.column` pairs that ARE live holder identity even
 *  though the NAME is provenance-shaped, so the deliberately-narrow name-only
 *  sweep above cannot see them. The name rule stays as-is — widening it would
 *  drag in every genuine `created_by`/`assigned_by` — but a table may declare
 *  an exception, which is the explicit per-table opt-in WI-10002452 called for.
 *
 *  WI-10002452: `owner_directives` has its two columns' roles INVERTED relative
 *  to their names, and that inversion is what hid a dead rebind surface for
 *  months. `owner_id` is identity-SHAPED but holds the HUMAN owner label
 *  (measured across all 203 live rows: 'owner' ×181, 'Avi' ×22, zero
 *  session-shaped, and `owner_id = recorded_by` false for every row), while
 *  `recorded_by` is provenance-SHAPED but is the REAL live session binding —
 *  it is what says which session the owner was addressing, and what `orders:*`
 *  and the turn-start Orientation banner key on. Opting it in forces it to be
 *  classified, so it can be COVERED honestly instead of being invisible. */
const IDENTITY_COLUMNS_BY_DECLARATION = new Set([
  'owner_directives.recorded_by',
]);

/** camelCase field name -> its default drizzle-kit snake_case column name
 *  (used only when the column call omits an explicit `"snake_name"` arg,
 *  e.g. `owner: text().notNull()`). */
function toSnakeCase(camel: string): string {
  return camel.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
}

/** Frozen pre-migration backup snapshots, recognised by the `bak_` prefix every
 *  such migration in this repo uses (656's own comment: "these bak_ tables ARE
 *  the undo path … same convention as bak_20260717_unify_work_items").
 *
 *  These are skipped STRUCTURALLY rather than hand-classified one by one, and
 *  that is not a weakening of the gate — a `CREATE TABLE … AS SELECT` snapshot
 *  cannot be live claim state by construction: it is written once by a
 *  migration, never updated, and no reader or reaper can key on a table that
 *  did not exist when the code was written (verified: no application source
 *  references any `bak_*` table — the only files that name one are the two
 *  generated schema mirrors and this test). So the answer for every one of them
 *  is, and can only ever be, `exempt`.
 *
 *  Hand-classifying them instead cost real fleet time: each new snapshot red the
 *  hourly green-checkpoint — and with it EVERY agent's deploys — hours after its
 *  migration landed, four times (bak_20260717_unify_work_items.taken_by,
 *  bak_20260717_unify_subs.subscriber_id, then bak_wi5720_retired_slug_plans.owner
 *  at migration 656 / WI-5720; 15 such tables exist today). Worse, each entry then
 *  became FUTURE gate-red debt via the "allowlist has not rotted" test below:
 *  DROPPING a spent bak_ table — the correct hygiene those entries' own
 *  "DELETE this entry when the bak_ table is dropped" notes ask for — would red
 *  the gate a second time. The inventory is there to force a deliberate decision
 *  about LIVE identity-keyed state; spending a fleet-wide deploy block on a
 *  frozen undo trail is noise that erodes exactly that signal.
 *
 *  Deliberately narrow: only the `bak_` prefix. A snapshot named outside the
 *  convention (e.g. `_pot_backfill_649_dropped`) still surfaces and must still be
 *  classified by hand below, so an unrecognised table never slips through. */
const BACKUP_SNAPSHOT_TABLE_RE = /^bak_/;

export function isFrozenBackupSnapshotTable(table: string): boolean {
  return BACKUP_SNAPSHOT_TABLE_RE.test(table);
}

interface ScanHit {
  table: string;
  column: string;
}

/** Static-parse schema.ts: track the current `harnessShared.table("name", {`
 *  block and record every column line whose db name matches
 *  IDENTITY_COLUMN_NAMES, plus any `table.column` in
 *  IDENTITY_COLUMNS_BY_DECLARATION. A column line looks like `fieldName: type(...)` or
 *  `fieldName: type("explicit_db_name")...` — take the explicit name when
 *  present, else derive it from the camelCase field name. Exported for the
 *  self-test below. */
export function scanIdentityColumns(schemaSrc: string): ScanHit[] {
  // Matches both `harnessShared.table("name", {` (base tables) AND
  // `harnessShared.view("name", {` (views, e.g. engineer_issues — the
  // compat view holding `taken_by AS assignee`) — a view can carry an
  // identity-keyed column just as live-read as a base table's.
  const tableStart = /\.(?:table|view)\("([a-z0-9_]+)"/;
  const colLine = /^\s*(\w+):\s*\w+\(\s*(?:"([a-z0-9_]+)")?/;
  let currentTable: string | null = null;
  const hits: ScanHit[] = [];
  for (const line of schemaSrc.split('\n')) {
    const ts = line.match(tableStart);
    // A frozen `bak_` snapshot sets currentTable to null, so its columns are
    // skipped by the `!currentTable` guard below until the next table block —
    // see isFrozenBackupSnapshotTable for why that is safe, not a loophole.
    if (ts) currentTable = isFrozenBackupSnapshotTable(ts[1]) ? null : ts[1];
    const cm = line.match(colLine);
    if (!cm || !currentTable) continue;
    const dbName = cm[2] ?? toSnakeCase(cm[1]);
    if (
      IDENTITY_COLUMN_NAMES.has(dbName) ||
      IDENTITY_COLUMNS_BY_DECLARATION.has(`${currentTable}.${dbName}`)
    )
      hits.push({ table: currentTable, column: dbName });
  }
  return hits;
}

describe('scanIdentityColumns (pure parser self-test)', () => {
  it('picks up an explicit quoted db-name and derives an implicit one from camelCase', () => {
    const src = `
export const fooInHarnessShared = harnessShared.table("foo", {
	ownerId: text("owner_id").notNull(),
	owner: text().notNull(),
	unrelated: text("something_else"),
});
`;
    const hits = scanIdentityColumns(src);
    expect(hits).toEqual([
      { table: 'foo', column: 'owner_id' },
      { table: 'foo', column: 'owner' },
    ]);
  });

  it('resets the current table at each new table("...") block', () => {
    const src = `
export const aInHarnessShared = harnessShared.table("a", {
	ownerId: text("owner_id").notNull(),
});
export const bInHarnessShared = harnessShared.table("b", {
	assignee: text("assignee"),
});
`;
    expect(scanIdentityColumns(src)).toEqual([
      { table: 'a', column: 'owner_id' },
      { table: 'b', column: 'assignee' },
    ]);
  });

  // Recurrence guard for the class of gate red that motivated the structural
  // skip (WI-5755): a migration lands a frozen `bak_` undo snapshot, pull-schema
  // regenerates generated.ts, and its inherited identity-shaped column reds the
  // fleet-wide green-checkpoint hours later. If someone removes or loosens the
  // skip, these fail HERE — as a pure parser assertion — instead of in the gate.
  it('skips frozen bak_ backup snapshots, and resumes scanning at the next real table', () => {
    const src = `
export const bakWi5720RetiredSlugPlansInHarnessShared = harnessShared.table("bak_wi5720_retired_slug_plans", {
	owner: text(),
	takenBy: text("taken_by"),
});
export const liveInHarnessShared = harnessShared.table("live_table", {
	ownerId: text("owner_id").notNull(),
});
`;
    // The snapshot's columns are gone; the live table AFTER it is still scanned
    // (i.e. the skip does not swallow the rest of the file).
    expect(scanIdentityColumns(src)).toEqual([{ table: 'live_table', column: 'owner_id' }]);
  });

  it('only skips the bak_ convention — a snapshot named outside it still surfaces for classification', () => {
    const src = `
export const potBackfillInHarnessShared = harnessShared.table("_pot_backfill_649_dropped", {
	takenBy: text("taken_by"),
});
export const backupsInHarnessShared = harnessShared.table("backups_owner_audit", {
	ownerId: text("owner_id"),
});
`;
    // Neither name matches /^bak_/, so THIS parser sweeps both in — the skip is
    // narrow, not a prefix free-for-all. NOTE this is a statement about
    // scanIdentityColumns in isolation, NOT about what reaches it end-to-end:
    // `_`-prefixed scratch tables are stripped from generated.ts upstream by
    // pull-schema.mjs "Fix 0" (EI-18785808338338490), so in the real pipeline
    // this parser never sees one. Do not read this case as "underscore tables
    // need an ALLOWLIST entry" — they must NOT have one (see the guard below).
    expect(scanIdentityColumns(src)).toEqual([
      { table: '_pot_backfill_649_dropped', column: 'taken_by' },
      { table: 'backups_owner_audit', column: 'owner_id' },
    ]);
    expect(isFrozenBackupSnapshotTable('_pot_backfill_649_dropped')).toBe(false);
    expect(isFrozenBackupSnapshotTable('backups_owner_audit')).toBe(false);
    expect(isFrozenBackupSnapshotTable('bak_20260717_unify_work_items')).toBe(true);
  });
});

describe('identity-keyed state inventory (EI-8999 — the WI-3642 lesson generalized)', () => {
  const schemaSrc = readFileSync(SCHEMA_PATH, 'utf8');
  const hits = scanIdentityColumns(schemaSrc);
  const foundKeys = new Set(hits.map((h) => `${h.table}.${h.column}`));

  it('found at least the columns this sweep was seeded from (schema.ts is readable + non-empty)', () => {
    // A canary: if this drops to 0 the scan silently broke (wrong path, schema
    // regenerated in an incompatible shape, …) and every other assertion below
    // would vacuously pass. Guard against a green-by-accident test.
    expect(hits.length).toBeGreaterThan(10);
  });

  it('every identity-keyed column found in the live schema is a DELIBERATE decision (covered or exempt)', () => {
    const unclassified = [...foundKeys].filter((k) => !(k in ALLOWLIST));
    expect(
      unclassified,
      unclassified.length > 0
        ? `New identity-keyed column(s) found with no classification: ${unclassified.join(', ')}.\n` +
            'Either (a) it is a live current-holder claim a presence-tied reaper/reader keys on — add a ' +
            "rebindIdentity surface for it (rebind-identity.ts) and list it here as 'covered', or (b) it is " +
            "provenance/log/TTL-leased/preference state safe to strand — add it here as 'exempt' with a one-line " +
            'reason. Do not silently ignore: this is exactly the shape of gap WI-3642 shipped as an incident.'
        : undefined,
    ).toEqual([]);
  });

  it('the allowlist itself has not rotted — every entry still matches a live column', () => {
    const stale = Object.keys(ALLOWLIST).filter((k) => !foundKeys.has(k));
    expect(
      stale,
      stale.length > 0
        ? `Allowlist entries no longer found in schema.ts (renamed/dropped column or table — remove or update): ${stale.join(', ')}`
        : undefined,
    ).toEqual([]);
  });

  // RECURRENCE GUARD for the 2026-07-27 gate red. A leading-underscore
  // MIGRATION-INTERNAL scratch table (`_pot_backfill_649_dropped`,
  // `_pot_members_686_orphans`, …) is stripped from generated.ts by
  // pull-schema.mjs "Fix 0" (stripScratchTableDeclarations,
  // EI-18785808338338490) BEFORE this scan ever reads it. So such a table can
  // never appear in `foundKeys`, and any allowlist entry naming one is
  // guaranteed to rot the moment it is added — which is exactly what happened:
  // the entry was written 2026-07-20 against a generated.ts that still carried
  // the table, and reded the fleet-wide gate when the strip landed.
  //
  // The trap is that the table is still VISIBLE in psql, so an agent looking at
  // the live DB naturally concludes it needs classifying. This fails that
  // instinct HERE, as a pure assertion with the reason attached, instead of in
  // the gate an hour later with only "entry no longer found" to go on.
  it('has no leading-underscore scratch tables — they are stripped upstream and can never match', () => {
    const scratch = Object.keys(ALLOWLIST).filter((k) => k.startsWith('_'));
    expect(
      scratch,
      scratch.length > 0
        ? `Allowlist entries name migration-internal scratch table(s): ${scratch.join(', ')}.\n` +
            'These are stripped from generated.ts by pull-schema.mjs "Fix 0" ' +
            '(stripScratchTableDeclarations, EI-18785808338338490), so this scan can never see them ' +
            'and the entry will rot. They are NOT application surface — there is nothing to classify, ' +
            'even though the table still exists in Postgres. Delete the entry.'
        : undefined,
    ).toEqual([]);
  });

  it('every "covered" entry names a surface that actually exists in rebindIdentity', async () => {
    // Import lazily (and only the source text, not the runtime module) so this
    // stays a pure-text assertion with no PG/module-graph dependency: read
    // rebind-identity.ts's own source and confirm each claimed surface name is
    // one of its `run('<surface>', ...)` calls. This is what keeps this file
    // and rebind-identity.ts from silently drifting apart (a surface renamed
    // there without updating here, or vice versa).
    const { readFileSync: rf } = await import('node:fs');
    const rebindSrc = rf(resolve(__dirname, 'rebind-identity.ts'), 'utf8');
    const declaredSurfaces = new Set(
      [...rebindSrc.matchAll(/run\('([a-z-]+)'/g)].map((m) => m[1]),
    );
    const covered = Object.entries(ALLOWLIST).filter(([, c]) => c.status === 'covered');
    const missing = covered.filter(([, c]) => !c.surface || !declaredSurfaces.has(c.surface));
    expect(
      missing.map(([k]) => k),
      missing.length > 0 ? `Covered entries naming a surface rebind-identity.ts no longer declares: ${missing.map(([k]) => k).join(', ')}` : undefined,
    ).toEqual([]);
  });
});
