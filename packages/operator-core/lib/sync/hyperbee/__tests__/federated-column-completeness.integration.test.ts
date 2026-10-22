/**
 * federated-column-completeness.integration.test.ts — the COLUMN-grain
 * federation-completeness guard (shared-pot-release-testing Brief B).
 *
 * THE GAP THIS CLOSES
 * -------------------
 * The two existing coverage guards prove federation at the TABLE grain:
 *   • `checkSubstrateCaptureCoverage` (capture-coverage.test.ts) — every
 *     `sync:'peer-log'` table has a producer.
 *   • `checkPeerLogConsistency` (projection-engine.test.ts) — every federated
 *     tableTag has a registered projection.
 * Neither proves that every COLUMN the writer sets survives the round trip. The
 * CDC path reshapes each `substrate_outbox` row through a hand-written value
 * mapper in `feature-issue-op-keys.ts` (`toFeatureValue`, `toIssueValue`, …) and
 * the projection then INSERTs only the keys that mapper carries. A column added
 * to a federated table by a later migration whose mapper is NOT updated is
 * SILENTLY DROPPED on every peer — the row federates, but that column lands
 * NULL/default on B. This is the generalized `requeue_count` class (a column that
 * existed in prod but not the federation path; README §"Why a new pass" bug #4),
 * and it is exactly the brief's S0/S1 concern — "captures but silently drops on
 * the apply side = data loss on a real hive" — at the column grain.
 *
 * WHY AN INTEGRATION TEST (not a parse of the DDL files)
 * -----------------------------------------------------
 * The brief is explicit: "Build test schemas from the REAL baseline DDL +
 * migrations, not hand-rolled subsets." The flagship `feature-content-federation`
 * test stands up a HAND-ROLLED subset schema (a CREATE TABLE with only the
 * columns it knows about) and asserts via `toMatchObject` — so it structurally
 * CANNOT see a column it didn't enumerate. This test instead migrates an empty DB
 * 000-baseline → head through the REAL boot-path runner and introspects
 * `information_schema.columns`, so a NEW migration column that nobody mapped trips
 * it automatically — no test edit required.
 *
 * WHAT IT ASSERTS
 * ---------------
 * For each CDC-captured federated table (`CDC_CAPTURED_TABLES`), run the REAL
 * `outboxRowToLocalWriteOp` over a synthetic full-column outbox row and collect
 * the keys the mapper carries. Every real column must be EITHER:
 *   (a) carried by the mapper (it federates as a value), OR
 *   (b) PROVENANCE — set by the projection from the op envelope, not the mapper
 *       (workspace_id/origin/fed_ts/author_pubkey/…); it lands on the peer, just
 *       not via the mapper value, so it is NOT data loss, OR
 *   (c) a GENERATED / tsvector / local-autoincrement column PG computes locally
 *       (never federated by design), auto-detected from information_schema, OR
 *   (d) explicitly listed in `NOT_FEDERATED[table]` with a one-line reason.
 * Any column outside all four FAILS, naming the column + the remediation: carry
 * it in `feature-issue-op-keys.ts`, or add it to `NOT_FEDERATED` with a reason.
 *
 * The `NOT_FEDERATED` entries tagged `REVIEW(findings-B)` are the CANDIDATE
 * FEDERATION GAPS this pass surfaced — columns currently dropped that LOOK like
 * content (notably on `harness_features_consolidated`). They are allow-listed so
 * the guard is green/CI-safe, but each is an owner decision recorded in
 * `shared-pot-release-testing/findings-B.md` (B-002): federate it, or confirm
 * intentionally-local and drop the REVIEW tag.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { outboxRowToLocalWriteOp, CDC_CAPTURED_TABLES } from '../feature-issue-op-keys';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');
const MIGRATION_RUNNER = resolve(
  REPO_ROOT,
  'libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js',
);

// Boot pre-step (roles + extensions) — mirrors embedded-postgres-server boot.
// Roles are cluster-global on the reused testcontainer, hence IF NOT EXISTS.
const BOOT_PREREQS_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app')   THEN CREATE ROLE harness_app   LOGIN PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero')  THEN CREATE ROLE harness_zero  LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd'; END IF;
  END $pg$;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

/**
 * PROVENANCE columns — the projection writers set these from the OP ENVELOPE /
 * derive them, not from the mapper value. They DO land on the peer (verified
 * against the projection INSERTs), just not via the mapper, so their absence
 * from the mapper output is NOT data loss. Global because the federation
 * substrate stamps them uniformly.
 */
const PROVENANCE = new Set<string>([
  'workspace_id', // op envelope → projection (the harness/workspace demux)
  'origin', // projection stamps 'local' | 'remote' (the echo-loop guard column)
  'fed_ts', // projection stamps from op provenance.ts (EI-79 LWW cursor)
  'fed_hlc', // projection stamps from op provenance.fedHlc (= op.hlc) — the D-001 HLC ordering key
  'author_pubkey', // projection stamps from the op's writerPubkey
  'verified_author_github_user_id', // projection derives via verified pot_members attestation (features; P-008)
  'schema_version', // rides the op envelope, not the row value
  'owner_author_pubkey', // harness_plans (mig 414/P-018-D-012): projection binds from the VERIFIED
  // source-log device on first authorized remote write (harness-plans.ts ownerToBind), preserved
  // across later overwrites — never carried from the mapper's row value.
]);

/**
 * Per-table columns intentionally NOT federated, EACH with the reason it is safe
 * to leave local. Entries tagged `REVIEW(findings-B)` are CANDIDATE GAPS this
 * pass surfaced (content-looking columns currently dropped) — allow-listed to
 * keep the guard green, but pending an owner federate/keep-local decision
 * (findings-B.md B-002). A bare entry (no REVIEW tag) is a settled local column.
 */
const NOT_FEDERATED: Record<string, Record<string, string>> = {
  harness_features_consolidated: {
    // Settled local — re-derived / machine-local / index / work-state, never content:
    working_users: 'derived projection of feature_working_set (recomputed locally per peer)',
    worked_by_history: 'local append-only audit of who worked it on THIS machine',
    verifier_last_error: 'verifier state, machine-local',
    verified_done_at_remote_ts: 'verifier state, re-derived per machine (polls the remote done-marker)',
    verifier_last_checked_at: 'verifier heartbeat, machine-local',
    audited_at: 'auto-review runs independently per peer (audit re-run locally)',
    audit_verdict: 'auto-review runs independently per peer',
    audit_reasons: 'auto-review runs independently per peer',
    created_by_github_user_id: 'provenance; author identity rides author_pubkey (PROVENANCE) on remote rows',
    assignee_rank: 'per-bee work-list ordering, local work state',
    rank_writer: 'per-bee work-list ordering, local work state',
    rank_updated_at: 'per-bee work-list ordering, local work state',
    requeue_count: 'local execution retry counter (per-machine dispatch state; the README §bug-4 schema-drift column)',
    schedule: 'recurring-schedule (cron/rrule) — machine-local scheduling, not content',
    schedule_active: 'machine-local scheduling state',
    scheduled_at: 'machine-local one-shot fire time',
    tzid: 'machine-local schedule timezone',
    template_slug: 'machine-local scheduled-template linkage',
    run_seq: 'machine-local scheduled-run sequence',
    // WI-251 (findings-B B-002) RESOLVED 2026-06-20 (consensus su-328af/su-860d3):
    // the 10 content/lineage columns formerly REVIEW-tagged here are now FEDERATED
    // (toFeatureValue mapper + harness-features projection INSERT/UPSERT), so they
    // are removed from NOT_FEDERATED and this test now asserts they cross A→B.
    // work-item-release-cooldown-2026 (mig 485): per-machine claim-cooldown
    // bookkeeping (releaseWorkItem's UPDATE stamps these on the row IT frees) —
    // same call as assignee_rank/rank_writer/rank_updated_at above, local work-list
    // state, not content.
    last_released_by: 'per-machine claim-cooldown bookkeeping, local work state (mig 485)',
    last_released_at: 'per-machine claim-cooldown bookkeeping, local work state (mig 485)',
    // EI-9418 (mig 551, shared-embedding-sidecar-and-enrichment-2026-07-10): the
    // vector + its embedder tag are deliberately NOT portable across machines.
    // `memoryEmbedderMode` picks the active embedder per-process (space
    // discipline, mig 530/551 header) — a vector federated from a peer running a
    // DIFFERENT embedder would be a foreign-space value the exact
    // `embedding_mode IS DISTINCT FROM $active` re-embed sweep exists to catch and
    // discard, so shipping it over the wire would just have the receiver
    // immediately re-embed it locally anyway. Each machine computes its own from
    // the row's real (federated) content instead.
    embedding: 'embedder-mode-specific vector, machine-local (mig 551) — foreign-space noise if federated, re-embedded locally instead',
    embedding_mode: 'tags which embedder produced `embedding` on THIS machine, machine-local (mig 551)',
    // WI-10004160: the guard did not run 2026-08-29 → 2026-09-30 (no gate route; integration
    // tier is opt-in), so these landed undeclared. Same family as embedding/embedding_mode.
    embedding_profile: 'exact embedding-space identity of the machine-local `embedding` (mig 1154) — describes a vector that never federates',
    // Mig 1322 (enterprise-data-sources-2026-10-01 P-010, D-017): nature/audience are stamped by
    // the BEFORE INSERT OR UPDATE trigger nature_stamp_from_registry_trg, which ALWAYS derives them
    // from the receiver's datatype_registry and overwrites any caller-supplied value. A federated
    // value would be discarded on receive, so each peer computes its own.
    nature: 'derived by trigger from datatype_registry on every insert/update (mig 1322); a federated value is overwritten on receive',
    audience: 'derived by trigger from datatype_registry on every insert/update (mig 1322); a federated value is overwritten on receive',
  },
  harness_issues_consolidated: {
    // Issues federate every content column — only PROVENANCE is local. (Empty.)
  },
  contributor_usage_events: {
    // Append-only ledger; every content column federates. (Empty.)
  },
  harness_plans: {
    verification_profile: 'machine-local execution/verification policy; explicitly excluded from federation clocks by migration 1537',
    verification_profile_source: 'provenance of the local verification profile; migration 1537 masks profile-only writes',
    // harness_plans federates the canonical markdown `content` + content_hash +
    // scalars; the structured columns are re-derived locally from `content` (the
    // plan parser / the flag-gated recompose owns them), and the orchestrator /
    // scheduling columns are machine-local. (See projections/harness-plans.ts doc.)
    version: 'optimistic-CAS guard (D-005), machine-local row version',
    op_status: 'orchestrator picking state, machine-local',
    created_at: 'machine-local row timestamp (the federated date is the TEXT `created`)',
    updated_at: 'machine-local row timestamp (the federated date is the TEXT `updated`)',
    op_started_at: 'orchestrator picking state, machine-local',
    op_updated_at: 'orchestrator picking state, machine-local',
    op_priority: 'local dispatch priority, machine-local',
    current_wave: 'local promote-wave cursor, machine-local',
    items: 'denormalized parse of the federated `content` (re-derived on apply)',
    decisions: 'denormalized parse of the federated `content` (re-derived on apply)',
    now_state: 'denormalized parse of the federated `content` (re-derived on apply)',
    now_next: 'denormalized parse of the federated `content` (re-derived on apply)',
    schedule: 'recurring-schedule, machine-local scheduling',
    schedule_active: 'machine-local scheduling state',
    scheduled_at: 'machine-local one-shot fire time',
    expires_at: 'machine-local schedule expiry',
    tzid: 'machine-local schedule timezone',
    template_slug: 'machine-local scheduled-template linkage',
    run_seq: 'machine-local scheduled-run sequence',
    // EI-21467654382027859. NOT a denormalized parse of `content` like items/decisions
    // above — it is a real pointer, and that is exactly why it must stay local: it
    // references harness_shared.goals, and NO goals table is in the federated set, so
    // shipping it would land a plan on every peer claiming membership in a goal that
    // peer has never heard of. Revisit if goals themselves ever federate. The three
    // columns flagged alongside it (output_schema, property_schema, properties) are
    // tool-written plan definition — not parsed from `content` — and now DO federate.
    goal_id: 'pointer into harness_shared.goals, which does not federate — would dangle on every peer (EI-21467654382027859)',
    // EI-9418 (mig 553): same embedder-mode-specific reasoning as
    // harness_features_consolidated above — machine-local, re-derived from the
    // federated `content` locally rather than shipped over the wire.
    embedding: 'embedder-mode-specific vector, machine-local (mig 553) — foreign-space noise if federated, re-embedded locally instead',
    embedding_mode: 'tags which embedder produced `embedding` on THIS machine, machine-local (mig 553)',
    embedding_profile: 'exact embedding-space identity of the machine-local `embedding` (mig 1154) — describes a vector that never federates',
    // Acceptance-BAR contract seed (mig 1111). D-093 of p2p-public-release-endgame-2026-09-01:
    // do NOT federate — every node re-derives it by running the strict seed when a plan OR its
    // bar rubric arrives (either order), the same re-derive-on-apply rule as items/decisions.
    // epoch/cohort are also stamped by the local BEFORE INSERT trigger stamp_acceptance_bar_epoch.
    acceptance_bar_epoch: 're-derived on apply: local insert trigger + strict seed (D-093, WI-10004146)',
    acceptance_bar_cohort: 're-derived on apply: local insert trigger + strict seed (D-093, WI-10004146)',
    acceptance_bar_set_hash: 're-derived on apply by the strict seed from the federated content + rubric (D-093, WI-10004146)',
    acceptance_bar_rubric_slug: 're-derived on apply by the strict seed from the federated content + rubric (D-093, WI-10004146)',
    acceptance_bar_rubric_revision: 're-derived on apply by the strict seed from the federated content + rubric (D-093, WI-10004146)',
    acceptance_bar_seeded_at: 'machine-local seed timestamp, re-stamped when the strict seed runs on apply (D-093, WI-10004146)',
    acceptance_bar_seeded_by: 'machine-local seed actor, re-stamped when the strict seed runs on apply (D-093, WI-10004146)',
    acceptance_bar_verified_revision: 'machine-local: the LOCAL plan version a receiver verified its BAR state at (WI-10004146)',
  },
  coord_conversations: {
    accepted_post_id: 'local bigserial reference; the federated answer is `accepted_answer` (mapper doc)',
    // mig 1181 (EI-23245293187768303): authorization provenance validated against the opener's
    // LIVE local claim. A receiver cannot re-validate a sender's claim, and the column contract is
    // "NULL = cannot authorize recovered-owner supersession", so landing NULL on a peer fails closed.
    plan_slug: 'recovered-owner supersession provenance validated against a LOCAL live claim (mig 1181); NULL on a peer fails closed by design',
    work_item_id: 'recovered-owner supersession provenance validated against a LOCAL live claim (mig 1181); NULL on a peer fails closed by design',
  },
  coord_event_log: {
    // id is a local autoincrement pk (auto-detected); msg_id is the fed key.
  },
  coord_threads: {
    // Every content column federates. (Empty.)
  },
  coord_thread_posts: {
    // id is a local autoincrement pk (auto-detected); post_msg_id is the fed key.
  },
  plan_item_assignments: {
    // fed_key is a GENERATED column (auto-detected). Content columns federate.
    created_at: 'machine-local row timestamp (federated times are assigned_ts/released_ts)',
    updated_at: 'machine-local row timestamp',
  },
  pot_settings: {
    created_at: 'machine-local row timestamp; the federated content is the `value`',
    updated_at: 'machine-local row timestamp; the federated content is the `value`',
  },
  pot_policy: {
    // EN-1: the federated subset is policy_json + owner_pubkey + signature + policy_version
    // (the owner-signed content, all carried by toHivePolicyValue). Only timestamps are local.
    created_at: 'machine-local row timestamp; the federated content is policy_json + signature',
    updated_at: 'machine-local row timestamp; the federated content is policy_json + signature',
  },
  pot_reports: {
    // EN-3 / P-MOD: the federated subset is report_id + reporter identity + target + status
    // (all carried by toHiveReportValue). Only the timestamps are machine-local.
    created_at: 'machine-local row timestamp; the federated content is the report fields + status',
    updated_at: 'machine-local row timestamp; the federated content is the report fields + status',
  },
  pot_pending_joins: {
    // EN-3 / P-MEMBER: the federated subset is the joiner identity + devices + the decision
    // (status/decided_*) — all carried by toHivePendingJoinValue. pending_join_fed_key is a
    // GENERATED column (auto-detected); only the timestamps are machine-local.
    created_at: 'machine-local row timestamp; the federated content is the joiner fields + decision',
    updated_at: 'machine-local row timestamp; the federated content is the joiner fields + decision',
  },
  pot_epoch_keys: {
    // shared-hive-rekey-2026-06-19 (P-005): the federated subset is the WRAPPED per-member
    // epoch key material + the epoch/member coords (carried by the value-mapper). Only the
    // row timestamps are machine-local. DARK until papercusp-hive-rekey flips (capture is
    // flag-gated), but the CDC map entry is unconditional so the column guard covers it now.
    created_at: 'machine-local row timestamp',
    updated_at: 'machine-local row timestamp',
  },
  pot_members: {
    display_name: 'GitHub-derived cosmetic, re-resolved per machine',
    avatar_url: 'GitHub-derived cosmetic, re-resolved per machine',
    joined_at: 'machine-local membership timestamp',
    last_seen_at: 'presence heartbeat, machine-local',
    channel1_verified_at: 'per-machine attestation-channel verification timestamp',
    channel2_verified_at: 'per-machine attestation-channel verification timestamp',
    channel2_branch_ref: 'per-machine attestation-channel ref',
    binding_last_checked_at: 'per-machine binding re-verify heartbeat',
    repo_permission: 'per-machine GitHub permission probe result (re-resolved locally)',
    permission_checked_at: 'per-machine permission probe timestamp',
  },
  engineer_issues: {
    assignee_rank: 'per-bee work-list ordering, local work state (mapper doc)',
    rank_writer: 'per-bee work-list ordering, local work state (mapper doc)',
    rank_updated_at: 'per-bee work-list ordering, local work state (mapper doc)',
    // Issue-family priority (mig 588): the shared-backlog rank is per-machine
    // dispatch state today — same family as the per-bee ordering columns above.
    // REVIEW(remaining-lanes P-201): whether backlog priority should federate is
    // part of the work-distribution activation posture decision
    // (p2p-public-release-remaining-lanes-2026-07-16 P-201) — tracked there, not
    // silently ignored.
    feature_order:
      'per-machine dispatch/backlog rank (same family as assignee_rank) — cross-machine priority is a work-distribution-activation question (REVIEW: remaining-lanes P-201)',
    last_progress_at: 'machine-local item-scoped progress heartbeat; claims/progress are re-established per receiver',
    base_harness_slug: 'engineer_issues view trigger identity helper (mig 510); not peer content',
    base_origin: 'engineer_issues view trigger origin-preservation helper (mig 514); op provenance supplies federation origin',
    updated_at: 'machine-local row timestamp (federated time is created_at via the mapper)',
    signal_origin: 'frontier signal provenance (organic/drill/replay/shadow) — local learning-lane tag',
    // `lane` is GENERATED ALWAYS on the BASE table (harness_shared.work_items,
    // mig 721) — PG recomputes it from `payload`, which DOES federate, so every
    // peer derives the same value with no wire bytes. It is listed here rather
    // than auto-detected because the `is_generated === 'ALWAYS'` skip below reads
    // information_schema for the relation under test, and for a VIEW that always
    // reports 'NEVER' — a view column never inherits its base column's generated
    // flag. So the auto-detect silently covers work_items but not this view.
    lane: 'GENERATED ALWAYS from the federated `payload` on the base table (mig 721) — recomputed locally by PG; the view hides the generated flag from auto-detection',
    // Mig 776 (context-injection-retrieval-reach-and-visibility-2026-08-03 P-005)
    // widened this VIEW to expose the embedding the base table
    // (harness_shared.work_items) always carried, so the work_item search source
    // could gain a semantic leg. Same embedder-mode-specific reasoning as
    // harness_features_consolidated (mig 551) and harness_plans (mig 553) above:
    // machine-local, re-embedded locally from the row's federated content.
    embedding: 'embedder-mode-specific vector, machine-local (mig 776) — foreign-space noise if federated, re-embedded locally instead',
    embedding_mode: 'tags which embedder produced `embedding` on THIS machine, machine-local (mig 776)',
    embedding_profile: 'exact embedding-space identity of the machine-local `embedding` (mig 1154) — describes a vector that never federates',
    // The VIEW re-exposes base-table columns, so the base table's own classification applies and
    // the information_schema GENERATED auto-exemption cannot see through the view.
    last_released_by: 'per-machine claim-cooldown bookkeeping, local work state (mig 485; same as the base table)',
    last_released_at: 'per-machine claim-cooldown bookkeeping, local work state (mig 485; same as the base table)',
    claim_hold: 'GENERATED ALWAYS from payload._claimHold on the base table (mig 1110); payload federates, so each peer re-derives it',
    needs_owner_action: 'GENERATED ALWAYS from payload.needsOwnerAction on the base table (mig 1110); payload federates, so each peer re-derives it',
    // EI-21467654382027859 (mig 965): the other NINE columns this guard named
    // (admission/admitted_at/admitted_by, state_changed_at, tags, parent_id,
    // source_plan_slug, source_plan_item_ids, expected_cost_cents) now federate —
    // see mig 965's header for the per-column reasoning. These two do NOT, and the
    // reasons are different from each other:
    // ⚠ BOTH of these are columns of the SAME work_items base table that the FEATURE
    // half (harness_features_consolidated, NOT_FEDERATED empty) DOES federate. That is
    // not an oversight on either side — the two families already diverge deliberately
    // on dispatch columns, and feature_order above is the precedent in the other
    // direction: features federate it as Queen steering (toFeatureValue's dispatch-column
    // comment, su-ae509 2026-06-10) while THIS family keeps it local with a REVIEW.
    // redundancy follows that same documented issue-family stance. goal_id does NOT have
    // an issue-family precedent, so it is flagged rather than presented as settled:
    redundancy:
      'per-item work-distribution fan-out factor (mig 195), inert unless PAPERCUSP_WORKITEM_REDUNDANCY is on — same dispatch family as feature_order above, which this family already keeps local (REVIEW: remaining-lanes P-201). The feature family federates both as steering; that divergence is deliberate on both sides.',
    goal_id:
      'pointer into harness_shared.goals, which does not federate — would dangle on every peer (EI-21467654382027859; same ruling as harness_plans.goal_id above, decided on the same item). ⚠ OPEN TENSION, deliberately recorded rather than settled: harness_features_consolidated federates goal_id today, so the same column on the same base table federates for features and not for issues. Either the dangling pointer is acceptable (and this should federate too) or it is not (and the feature half is wrong). Revisit with the remaining-lanes work-distribution decision rather than assuming this entry settled it.',
    // Mig 1322 (enterprise-data-sources-2026-10-01 P-010, D-017): nature/audience are stamped by
    // the BEFORE INSERT OR UPDATE trigger nature_stamp_from_registry_trg, which ALWAYS derives them
    // from the receiver's datatype_registry and overwrites any caller-supplied value. A federated
    // value would be discarded on receive, so each peer computes its own.
    nature: 'derived by trigger from datatype_registry on every insert/update (mig 1322); a federated value is overwritten on receive',
    audience: 'derived by trigger from datatype_registry on every insert/update (mig 1322); a federated value is overwritten on receive',
  },
  harness_plan_parts: {
    author: 'rides the op provenance (writerPubkey → author_pubkey), not the row value (mapper doc)',
    created_at: 'machine-local row timestamp',
    updated_at: 'machine-local row timestamp',
  },
  p2p_fleet_directory: {
    // P-101/D-006: the federated subset is the owner-signed record + envelope
    // (record_json/signature/signer/version/archived — all carried by
    // toFleetDirectoryValue). Only the row timestamps are machine-local.
    created_at: 'machine-local row timestamp; the federated content is record_json + signature',
    updated_at: 'machine-local row timestamp; the federated content is record_json + signature',
  },
  p2p_work_offers: {
    // P-102 store leg (WI-1935): the federated subset is the publisher-signed
    // record + envelope (record_json/signature/signer/version + the verified
    // convenience columns — all carried by toWorkOfferValue).
    local_disposition:
      "HOST-LOCAL refusal (revocation-reaper P-106 deferred #2) — deliberately never federates: a host cannot re-sign the publisher's record, it only stops serving it HERE (mig 490 masks it from the stamp trigger; the projection upsert never touches it)",
    created_at: 'machine-local row timestamp; the federated content is record_json + signature',
    updated_at: 'machine-local row timestamp; the federated content is record_json + signature',
  },
  p2p_fleet_leader_leases: {
    // P-302 LIVE-2 seam 1: the federated subset is the incumbent identity +
    // roster epoch (toFleetLeaderLeaseValue). Row timestamps are local; the
    // ordering cursor is fed_ts/fed_hlc from the op envelope.
    created_at: 'machine-local row timestamp',
    updated_at: 'machine-local row timestamp',
  },
  agent_facts: {
    // F1-4/P-012 (mig 461/462): the federated subset is scope/scope_ref/key/body/
    // source_ref/expires_at/retracted_at/created_by plus content metadata such
    // as audience/provenance/confidence/measurement (toAgentFactValue). Timestamps
    // are machine-local; source_hive is deliberately receiver-stamped from the
    // admitted log identity (never trusted from a sender-claimed value).
    created_at: 'machine-local row timestamp',
    updated_at: 'machine-local row timestamp',
    source_hive: 'receiver-stamped from the admitted log identity — never carried (a sender-claimed source is never trusted)',
    shareable: 'send-side capture gate (mig 461/462 trigger WHEN NEW.shareable=true) — implicitly true for every row that reaches the wire at all, so redundant to carry',
    // EI-21467654382027859: the other 10 previously-missing columns now federate
    // (kind/claim/enforcement/settled_by/recheck/depends_on as claim substance,
    // superseded_at/retracted_by/retraction_reason/evicted_at as liveness+audit).
    // This one is the sole documented-local of that set:
    supersedes_id:
      "the agent_facts.id of the version this row replaced — a LOCAL bigserial pk, so a peer's id space is unrelated and shipping it would point at whatever row happens to hold that number there. Exactly the accepted_post_id precedent in coord_conversations above. The chain stays walkable on each peer from identity + superseded_at, which do federate.",
  },
  gym_qd_archive: {
    // F1-2/F1-5 (mig 464/465): the federated subset is niche_key/candidate_id/scope/
    // domain/risk/fitness/descriptor/rationale/federatable/outcome_record/updated_at
    // (toGymQdEliteValue). created_at is machine-local (this row's local insert time).
    created_at: 'machine-local row timestamp (the federated cursor is updated_at, carried by the mapper)',
    // REVIEW(findings-B): `source` ('gym'|'scout' — the sender-local seed-origin tag,
    // mig 193) is real content a peer might want (weight scout-seeded elites
    // differently), but the RECEIVE-side table (gym_qd_foreign_elites) has no column
    // for it — carrying it needs a schema addition, out of scope for restoring this
    // guard (WI-2233). Tracked as a candidate gap, not silently ignored.
    source: 'sender-local seed-origin tag (gym|scout) — receive-side gym_qd_foreign_elites has no matching column yet; a real but small future gap, not carried today',
  },
  cup_claim_specs: {
    // P-016 (mig 438): federated subset is spec/revision/updated_by. updated_at is
    // machine-local. id_only is a DENORMALIZED observability tripwire the projection
    // now recomputes locally from the federated `spec` via isIdOnlySelector (never
    // carried on the wire — see bee-claim-spec.ts writeToPg).
    updated_at: 'machine-local row timestamp',
    id_only: 'denormalized tripwire recomputed locally from `spec` via isIdOnlySelector (bee-claim-spec.ts), not carried on the wire',
  },
  gate_verdicts: {
    // shared-hive-release-gate federation: the federated subset is the signed
    // verdict fields (repo_key/staging_sha/shard_id/inputs_hash/verdict/duration_ms/
    // device_pubkey/verdict_ts/sig — toGateVerdictValue). created_at is machine-local
    // (the federated timestamp is verdict_ts, carried by the mapper).
    created_at: 'machine-local row timestamp (federated time is verdict_ts, carried by the mapper)',
  },
  p2p_peer_grants: {
    // P-001 (mig 463): the federated subset is the grantor-signed record fields
    // (toP2pPeerGrantValue). Only the row timestamps are machine-local.
    created_at: 'machine-local row timestamp',
    updated_at: 'machine-local row timestamp',
  },
  p2p_receipts: {
    // P-004 (mig 468): the federated subset is the receipt fields (toP2pReceiptValue).
    // Only the row timestamp is machine-local (receipt_ts is the federated time).
    created_at: 'machine-local row timestamp (federated time is receipt_ts, carried by the mapper)',
  },
  memory_canonical: {
    used_count: 'local memory_session_surfaced outcome aggregate (memory/surfaced-outcomes.ts); not a replicated counter',
    contradicted_count: 'local session outcome aggregate; remote LWW replacement would lose independently counted feedback',
    // mem0-cross-machine-federation-2026-07-10 (EI-9430 fix): the federated subset
    // is id/payload/created_at/updated_at/harness_slug (toMemoryValue). Mirrors the
    // agent_facts pattern below for source_hive; the memory-quality/decay fields are
    // per-machine lifecycle state, never content.
    source_hive: 'receiver-stamped from the admitted log identity — never carried (a sender-claimed source is never trusted, same as agent_facts)',
    last_validated_at: 'per-machine memory-quality/decay lifecycle, re-derived independently on each peer',
    last_surfaced_at: 'per-machine recency-of-use heartbeat, machine-local',
    state: 'per-machine memory-quality lifecycle (active/broken_anchor/superseded/contradicted/forgotten) — each peer re-evaluates its own copy',
  },
};

/** Run the REAL mapper over a synthetic full-column row and return the keys it
 *  carries onto the peer-log op value (the federated column set). The mapper
 *  builds a fixed-shape object, so the carried KEY set is independent of the
 *  sentinel values — we only need every real column present so a future column
 *  the mapper happens to read is exercised. */
function carriedColumns(tableName: string, realColumns: string[]): Set<string> {
  const row: Record<string, unknown> = { origin: 'local' };
  for (const c of realColumns) {
    if (!(c in row)) row[c] = `sentinel:${c}`;
  }
  const op = outboxRowToLocalWriteOp({ table_name: tableName, op: 'put', key: 'k-sentinel', ts: 1700, row });
  if (op.type !== 'put') throw new Error('expected a put op');
  return new Set(Object.keys(op.value as Record<string, unknown>));
}

let db: MigratedTestDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'fedcol',
    provision: async (url) => {
      const { applyPendingMigrations } = (await import(pathToFileURL(MIGRATION_RUNNER).href)) as {
        applyPendingMigrations: (opts: { client: postgres.Sql; sqlDir: string }) => Promise<unknown>;
      };
      const s = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await s.unsafe(BOOT_PREREQS_DDL);
        await applyPendingMigrations({ client: s, sqlDir: SQL_DIR });
      } finally {
        await s.end({ timeout: 5 });
      }
    },
  });
  sql = postgres(db.url, { max: 4, onnotice: () => {}, prepare: false });
}, 240_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

describe('federated CDC tables — every column federates or is documented-local (column-drift guard)', () => {
  it('sanity: the CDC-captured set is the 25 known federated tables', () => {
    // A new CDC table without a case here means a new federated table shipped —
    // the per-table loop below will still cover it (it iterates CDC_CAPTURED_TABLES).
    // 27 = 26 prior + memory_canonical (EI-9430: the table-registry classification
    // + capture triggers landed with mem0-cross-machine-federation-2026-07-10, but
    // TABLE_NAME_TO_TABLE_TAG/PEER_LOG_TAG_TO_TABLE were never updated — this pass
    // wires the real mapper (toMemoryValue) + this table's NOT_FEDERATED coverage).
    // This count is a TRIPWIRE, not a target: bump it AND add the new table's
    // NOT_FEDERATED/mapper coverage together.
    expect(CDC_CAPTURED_TABLES.length).toBe(27);
  });

  for (const table of CDC_CAPTURED_TABLES) {
    it(`${table}: mapper carries every real column except documented-local`, async () => {
      // The REAL applied schema — not a hand-rolled subset.
      const cols = await sql<
        Array<{
          column_name: string;
          is_generated: string;
          is_identity: string;
          data_type: string;
          column_default: string | null;
        }>
      >`
        SELECT column_name, is_generated, is_identity, data_type, column_default
          FROM information_schema.columns
         WHERE table_schema = 'harness_shared' AND table_name = ${table}
      `;
      expect(cols.length, `table harness_shared.${table} not found in the migrated schema`).toBeGreaterThan(0);

      const realColumns = cols.map((c) => c.column_name);
      const carried = carriedColumns(table, realColumns);
      const local = NOT_FEDERATED[table] ?? {};

      const dropped: string[] = [];
      for (const c of cols) {
        const name = c.column_name;
        if (carried.has(name)) continue; // federates as a value
        if (PROVENANCE.has(name)) continue; // set by the projection from the op envelope
        if (c.is_generated === 'ALWAYS') continue; // PG-generated (fed_key, part_fed_key)
        if (c.data_type === 'tsvector') continue; // local search index (_search)
        // a local autoincrement pk the mapper does not carry — the federated
        // identity is a different key column (msg_id / post_msg_id). Covers both
        // bigserial (nextval default) and GENERATED-AS-IDENTITY pks.
        if ((c.column_default ?? '').includes('nextval(')) continue;
        if (c.is_identity === 'YES') continue;
        if (name in local) continue; // documented intentionally-local
        dropped.push(name);
      }

      expect(
        dropped,
        `harness_shared.${table} has column(s) that federation SILENTLY DROPS — they land ` +
          `NULL/default on every peer (data loss). For each: carry it in the value mapper ` +
          `(feature-issue-op-keys.ts) + the projection INSERT, OR add it to NOT_FEDERATED['${table}'] ` +
          `in this test with the reason it is safe to keep local. Dropped: ${dropped.join(', ')}`,
      ).toEqual([]);
    });
  }
});
