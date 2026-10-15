/**
 * Recurrence guard for scope-unique-identifiers-2026-07-26 P-007 (ruling #D-014):
 * a NEW harness_shared table must not make an id unique only together with
 * harness_slug, unless it is allowlisted here with a reason.
 *
 * BASELINE is the measured set as of the 2026-10-06 index manifest (61 entries,
 * seeded from the detector's own output, never hand-grown). It is SHRINK-ONLY: an
 * entry that no longer reproduces fails, so fixing a table forces its removal here.
 * work_items.work_items_pkey and work_items.work_items_scoped_identity retired on
 * 2026-10-11: migration 1444 (UNIQUE (workspace_id, feature_id), P-012) armed and the
 * manifest was regenerated, so work_items_workspace_feature_id_uq now covers both.
 */
import { describe, expect, it } from 'vitest';
import type { IndexCensusEntry } from '../schema-object-drift';
import { findHarnessScopedIdUniqueness, parseIndexColumns } from './harness-scoped-id-uniqueness';
import { INDEX_MANIFEST } from './index-manifest';

const BASELINE: readonly string[] = [
  'agent_chats_consolidated.agent_chats_consolidated_pkey',
  'agent_runs_consolidated.agent_runs_consolidated_pkey',
  'blueprint_operation_invocations.blueprint_operation_invocatio_workspace_id_harness_slug_cal_key',
  'blueprint_operation_private_inputs.blueprint_operation_private_inputs_pkey',
  'contributor_usage_events.contributor_usage_events_pkey',
  'directive_summaries_consolidated.directive_summaries_consolidated_pkey',
  'doc_revisions.doc_revisions_ws_harness_doc_seq_key',
  'executed_actions_consolidated.executed_actions_consolidated_pkey',
  'feature_claims.feature_claims_pkey',
  'feature_queue.feature_queue_pkey',
  'feature_working_set.feature_working_set_pkey',
  'goal_pots.goal_pots_live_pair_key',
  'harness_archives.harness_archives_pkey',
  'harness_chunk_plans.harness_chunk_plans_pkey',
  'harness_design_artifacts.harness_design_artifacts_pkey',
  'harness_doc_parts.harness_doc_parts_pkey',
  'harness_docs.harness_docs_pkey',
  'harness_feature_debug_notes.harness_feature_debug_notes_pkey',
  'harness_feature_notes.harness_feature_notes_pkey',
  'harness_feature_prs.harness_feature_prs_pkey',
  'harness_generator_items.harness_generator_items_pkey',
  'harness_hook_logs.harness_hook_logs_pkey',
  'harness_issues_consolidated.harness_issues_consolidated_pkey',
  'harness_pending_issues.harness_pending_issues_pkey',
  'harness_plan_assertions.harness_plan_assertions_pkey',
  'harness_promotions.harness_promotions_pkey',
  'harness_proposals_shared.harness_proposals_shared_pkey',
  'harness_run_chunks.harness_run_chunks_pkey',
  'harness_run_output.harness_run_output_pkey',
  'harness_screenshots.harness_screenshots_pkey',
  'harness_snapshots.harness_snapshots_pkey',
  'harness_snapshots_consolidated.harness_snapshots_consolidated_pkey',
  'harness_tests.harness_tests_pkey',
  'messages_consolidated.messages_consolidated_pkey',
  'p2p_receipts.p2p_receipts_pkey',
  'p2p_work_offers.p2p_work_offers_pkey',
  'pending_reviews.pending_reviews_pkey',
  'plan_decisions.plan_decisions_pkey',
  'plan_item_assignments.plan_item_assignments_pkey',
  'plan_item_claims.plan_item_claims_pkey',
  'plan_items.plan_items_pkey',
  'plan_spec_clause_revisions.plan_spec_clause_revisions_content_identity',
  'plan_spec_clause_revisions.plan_spec_clause_revisions_pkey',
  'plan_spec_clauses.plan_spec_clauses_pkey',
  'plan_spec_clauses.plan_spec_clauses_source_val_identity',
  'plugin_kv.plugin_kv_pkey',
  'plugin_reload_state.plugin_reload_state_pkey',
  'pot_reports.pot_reports_pkey',
  'snapshot_features.snapshot_features_pkey',
  'spec_evidence_bindings.spec_evidence_bindings_dedup_live',
  'steering_churn_escalations.steering_churn_escalations_pkey',
  'supervisor_notes_consolidated.supervisor_notes_consolidated_pkey',
  'testing_surfaces.testing_surfaces_identity',
  'work_item_blocked.work_item_blocked_pkey',
  'work_item_claims.work_item_claims_pkey',
  'work_item_release_cooldowns.work_item_release_cooldowns_pkey',
  'work_item_replicas.work_item_replicas_pkey',
  'work_item_spec_revision_edges.work_item_spec_revision_edges_pkey',
  'work_item_spec_revision_edges.work_item_spec_revision_edges_workspace_id_harness_slug_wor_key',
];

/**
 * Harness-scoped by design, added after the baseline. Every entry needs a reason a
 * reviewer can check: why this id is never cited outside its harness, or why a
 * by-id reader already refuses ambiguity.
 */
const ALLOWLIST: Readonly<Record<string, string>> = {};

const idx = (table: string, name: string, cols: string, where?: string): IndexCensusEntry => ({
  schema: 'harness_shared',
  name,
  table,
  definition: `CREATE UNIQUE INDEX ${name} ON harness_shared.${table} USING btree (${cols})${where ? ` WHERE (${where})` : ''}`,
  constraintBacked: true,
});

describe('findHarnessScopedIdUniqueness — controls', () => {
  it('flags an id unique only per harness', () => {
    const f = findHarnessScopedIdUniqueness([idx('t', 't_pkey', 'harness_slug, item_id')]);
    expect(f.map((x) => x.key)).toEqual(['t.t_pkey']);
    expect(f[0].idColumns).toEqual(['item_id']);
  });

  it('treats a workspace-wide unique sibling as covering, and a partial one as not', () => {
    const scoped = idx('t', 't_pkey', 'workspace_id, harness_slug, item_id');
    expect(findHarnessScopedIdUniqueness([scoped, idx('t', 't_ws_uq', 'workspace_id, item_id')])).toEqual([]);
    expect(findHarnessScopedIdUniqueness([scoped, idx('t', 't_ws_uq', 'item_id')])).toEqual([]);
    expect(
      findHarnessScopedIdUniqueness([scoped, idx('t', 't_ws_uq', 'workspace_id, item_id', 'live')]).map((x) => x.key),
    ).toEqual(['t.t_pkey']);
    // A sibling unique on workspace_id alone covers nothing.
    expect(
      findHarnessScopedIdUniqueness([scoped, idx('t', 't_ws_only', 'workspace_id')]).map((x) => x.key),
    ).toEqual(['t.t_pkey']);
  });

  it('ignores per-harness state keyed by non-id columns, user ids, other schemas and bak_ snapshots', () => {
    expect(findHarnessScopedIdUniqueness([idx('t', 't_pkey', 'workspace_id, harness_slug, role')])).toEqual([]);
    expect(findHarnessScopedIdUniqueness([idx('t', 't_pkey', 'workspace_id, harness_slug, github_user_id')])).toEqual([]);
    expect(findHarnessScopedIdUniqueness([idx('bak_t', 'bak_t_uq', 'harness_slug, feature_id')])).toEqual([]);
    expect(
      findHarnessScopedIdUniqueness([{ ...idx('t', 't_pkey', 'harness_slug, item_id'), schema: 'papercup_shared' }]),
    ).toEqual([]);
    expect(
      findHarnessScopedIdUniqueness([{ ...idx('t', 't_idx', 'harness_slug, item_id'), definition: 'CREATE INDEX t_idx ON harness_shared.t USING btree (harness_slug, item_id)' }]),
    ).toEqual([]);
  });

  it('parses expression columns and a WHERE clause without splitting inside parentheses', () => {
    const p = parseIndexColumns(
      "CREATE UNIQUE INDEX x ON harness_shared.t USING btree (workspace_id, harness_slug, ((payload ->> 'k'::text)), COALESCE(a, b)) WHERE (lane = 'x'::text)",
    );
    expect(p).toEqual({
      columns: ['workspace_id', 'harness_slug', "((payload ->> 'k'::text))", 'COALESCE(a, b)'],
      where: "(lane = 'x'::text)",
    });
  });
});

describe('harness_shared id uniqueness — real fresh-install index manifest', () => {
  const manifest = INDEX_MANIFEST;
  const findings = findHarnessScopedIdUniqueness(manifest.indexes);
  const keys = new Set(findings.map((f) => f.key));

  it('reads a non-empty manifest (an empty one would make every check below vacuous)', () => {
    expect(manifest.indexes.length).toBeGreaterThan(100);
    // Positive control: the class this guard exists for is present today (until 1444 arms).
    expect(findings.length).toBeGreaterThan(0);
  });

  it('every finding is baselined or allowlisted with a reason', () => {
    const baseline = new Set(BASELINE);
    const unexplained = findings
      .filter((f) => !baseline.has(f.key) && !ALLOWLIST[f.key]?.trim())
      .map((f) => `${f.key} (${f.columns.join(', ')})`);
    expect(
      unexplained,
      'A harness_shared UNIQUE index makes an id unique only together with harness_slug. ' +
        'Add a workspace-wide unique (workspace_id, <id>) so a by-id reader names one row, ' +
        'or add the key to ALLOWLIST with a reason (scope-unique-identifiers-2026-07-26#D-014).',
    ).toEqual([]);
  });

  it('the baseline only shrinks: every entry still reproduces', () => {
    const stale = BASELINE.filter((key) => !keys.has(key));
    expect(
      stale,
      'These baseline entries no longer reproduce (the table gained a workspace-wide unique, or was dropped). ' +
        'Delete them from BASELINE.',
    ).toEqual([]);
    expect(new Set(BASELINE).size).toBe(BASELINE.length);
  });

  it('allowlist entries are live findings and are not also baselined', () => {
    for (const key of Object.keys(ALLOWLIST)) {
      expect(keys.has(key), `${key} is allowlisted but no longer a finding`).toBe(true);
      expect(BASELINE.includes(key), `${key} is both baselined and allowlisted`).toBe(false);
    }
  });
});
