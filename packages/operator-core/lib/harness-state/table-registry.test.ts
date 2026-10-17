import { describe, it, expect } from 'vitest';
import {
  resolveTableSpec,
  needsReview,
  classifyInventory,
  NEEDS_REVIEW,
  DEFAULT_SPEC,
  GIT_TABLES,
  RETIRED_HOST_LOCAL_GIT_TABLES,
} from './table-registry';

describe('harness-state table-registry (P-002 two-axis model)', () => {
  it('classifies the GIT-document tables: slug-shared + git', () => {
    for (const t of ['harness_decisions', 'harness_text_artifacts', 'feature_audit_consolidated', 'harness_feature_debug_notes']) {
      expect(resolveTableSpec(t)).toMatchObject({ key: 'slug-shared', sync: 'git' });
    }
  });

  it('classifies the live shared tables: slug-shared + peer-log', () => {
    for (const t of ['harness_features_consolidated', 'feature_queue', 'contributors']) {
      expect(resolveTableSpec(t)).toMatchObject({ key: 'slug-shared', sync: 'peer-log' });
    }
  });

  it('classifies operator/user/session tables as workspace-owned (prefix rule)', () => {
    for (const t of ['operator_preferences', 'user_sessions', 'voice_lease', 'adv_sessions']) {
      expect(resolveTableSpec(t)).toMatchObject({ key: 'workspace-owned', sync: 'none' });
    }
  });

  it('keeps native code-intelligence push state workspace-owned and local', () => {
    expect(resolveTableSpec('code_intel_pushes')).toMatchObject({ key: 'workspace-owned', sync: 'none' });
  });

  it('P-002 review: telemetry / mem0 / coord-presence / plugin / backup → workspace-owned', () => {
    for (const t of [
      'tool_invocations', 'tool_invocations_spawn_tree', 'route_invocations', 'adaptive_telemetry',
      'memory_anchors', 'memory_vec_local',
      // coord_presence stays local (delivery/liveness state, reconciled separately).
      // NOTE: coord_event_log + coord_conversations now FEDERATE (peer-log) for
      // harness-scoped rows (distributed-coordination-shared-harness-2026-06-04
      // Track A) — they are listed in PEER_LOG_WORKSPACE_OWNED, asserted below.
      'coord_presence',
      'plugin_configs', 'hidden_plugins',
      'backup_events', 'spawned_agents',
    ]) {
      expect(resolveTableSpec(t)).toMatchObject({ key: 'workspace-owned', sync: 'none' });
    }
  });

  it('harness-scoped coord content (coord_event_log / coord_conversations) federates over the peer-log', () => {
    for (const t of ['coord_event_log', 'coord_conversations']) {
      expect(resolveTableSpec(t)).toMatchObject({ key: 'workspace-owned', sync: 'peer-log' });
    }
  });

  it('the work-queue issue/task family (engineer_issues) federates over the peer-log (fed-reanchor B5)', () => {
    expect(resolveTableSpec('engineer_issues')).toMatchObject({ key: 'workspace-owned', sync: 'peer-log' });
  });

  it('SECURITY tables never sync and win over the operator_ prefix', () => {
    for (const t of ['operator_credentials', 'oauth_nonces', 'system_principals', 'mobile_pair_tokens']) {
      const s = resolveTableSpec(t);
      expect(s.security).toBe(true);
      expect(s.sync).toBe('none');
      expect(s.key).toBe('workspace-owned');
    }
  });

  it('the across-workspaces config override is workspace-owned', () => {
    expect(resolveTableSpec('harness_prompt_overrides').key).toBe('workspace-owned');
  });

  it('P-002 completeness review: per-workspace tables are workspace-owned (not slug-shared)', () => {
    // harness_registry is the membership list — one row per workspace; must NOT be slug-shared.
    for (const t of ['harness_registry', 'plan_revisions', 'plan_runs', 'harness_brainstorm', 'harness_dock_layouts', 'autoloop_state']) {
      expect(resolveTableSpec(t)).toMatchObject({ key: 'workspace-owned', sync: 'none' });
    }
  });

  it('falls through to DEFAULT (slug-shared / none) for plain result tables', () => {
    // §7.4 LOCAL runtime, slug-keyed, not synced; substrate plumbing is local.
    expect(resolveTableSpec('agent_runs_consolidated')).toEqual(DEFAULT_SPEC);
    expect(resolveTableSpec('agent_chats_consolidated')).toEqual(DEFAULT_SPEC);
    expect(resolveTableSpec('substrate_outbox')).toEqual(DEFAULT_SPEC);
    expect(resolveTableSpec('pr_check_status_cache')).toEqual(DEFAULT_SPEC);
  });

  it('harness_feature_prs is NOT federated — reclassified sync:none (EI-479)', () => {
    // PR state is GitHub-derived + re-polled per-machine; no producer ever
    // existed, so it falls through to DEFAULT (slug-shared / sync:'none') rather
    // than the retired sync:'peer-log' classification + orphan Hyperbee projection.
    expect(resolveTableSpec('harness_feature_prs')).toEqual(DEFAULT_SPEC);
    expect(resolveTableSpec('harness_feature_prs').sync).toBe('none');
  });

  it('strips a schema qualifier before resolving', () => {
    expect(resolveTableSpec('harness_shared.harness_decisions')).toMatchObject({ sync: 'git' });
    // strip still works for a non-harness_shared qualifier:
    expect(resolveTableSpec('papercusp_shared.messages')).toEqual(resolveTableSpec('messages'));
  });

  it('the retired papercup-org demo bus is NOT git-synced (no harness scoping)', () => {
    // papercusp_shared.{messages,directives,briefings,directive_summaries} (D-008
    // org demo) have no workspace_id/harness_slug → cannot fit per-harness
    // git-export; they were silently skipped (different schema). Removing them
    // from GIT_DOCS makes the classification honest (they were never synced).
    for (const t of ['messages', 'directives', 'briefings', 'directive_summaries']) {
      expect(resolveTableSpec(t).sync).not.toBe('git');
      expect(GIT_TABLES).not.toContain(t);
    }
  });

  it('excludes operational / fs-mirror tables from git-export (volatile columns → churn)', () => {
    // Two P-003b live-boot lessons:
    //  - harness_branch_actions: fs-watcher mirror (Mirror 7k git-log enrichment)
    //    with a `last_check_ms` heartbeat re-upserted every poll → perpetual loop.
    //  - harness_lanes: the live agent-lane occupancy tracker (pid/started_at —
    //    machine-local runtime) → churned + accumulated 600+ stuck rows for
    //    ephemeral gym-smoke harnesses with no drain loop.
    // A volatile column makes the row "change" every write, so the no-op capture
    // guard can't help; operational tables must simply not be sync:'git'.
    for (const t of ['harness_branch_actions', 'harness_lanes']) {
      expect(resolveTableSpec(t)).toEqual(DEFAULT_SPEC);
      expect(GIT_TABLES).not.toContain(t);
    }
  });

  it('per-host watchdog verdicts (harness_escalations) are NOT git-synced (WI-10003731)', () => {
    // Every writer is a machine-local watchdog upserting ITS host's verdict under
    // the same (harness_slug, phase) key, so each device of a multi-device pot
    // committed a different body for the same file and every member head
    // conflicted with staging (P-505 physical drill, 2026-09-28).
    expect(resolveTableSpec('harness_escalations')).toEqual(DEFAULT_SPEC);
    expect(resolveTableSpec('harness_shared.harness_escalations').sync).toBe('none');
    expect(RETIRED_HOST_LOCAL_GIT_TABLES).toContain('harness_escalations');
  });

  it('invariant: a retired host-local table can never be git-synced again', () => {
    // The pot-git integrator lets staging win conflicts under these tables'
    // directories. That is only sound while nothing git-syncs them — a table
    // re-added to GIT_DOCS would have its REAL cross-device edits silently dropped.
    for (const t of RETIRED_HOST_LOCAL_GIT_TABLES) {
      expect(GIT_TABLES).not.toContain(t);
      expect(resolveTableSpec(t).sync).not.toBe('git');
    }
  });

  it('NEEDS_REVIEW is empty at P-002 close', () => {
    expect(Object.keys(NEEDS_REVIEW)).toHaveLength(0);
    expect(needsReview('anything')).toBe(false);
  });

  it('invariant: security always implies sync none', () => {
    for (const t of ['operator_secrets', 'token_index', 'provision_state']) {
      const s = resolveTableSpec(t);
      if (s.security) expect(s.sync).toBe('none');
    }
  });

  it('classifyInventory groups a live list + surfaces defaulted / unreviewed', () => {
    const sample = [
      'harness_features_consolidated', // peer-log
      'harness_decisions',             // git
      'operator_preferences',          // workspace-owned (prefix)
      'operator_credentials',          // security
      'agent_runs_consolidated',       // DEFAULT
      'some_brand_new_table',          // DEFAULT (would be flagged as defaulted → review)
    ];
    const c = classifyInventory(sample);
    expect(c.total).toBe(6);
    expect(c.unreviewed).toHaveLength(0); // NEEDS_REVIEW empty
    // a NEW unclassified table surfaces in `defaulted` so it can't hide:
    expect(c.defaulted).toContain('some_brand_new_table');
    expect(c.defaulted).toContain('agent_runs_consolidated');
    expect(c.defaulted).not.toContain('harness_features_consolidated');
    expect(c.byBucket['slug-shared/peer-log']).toBe(1);
    expect(c.byBucket['workspace-owned/none/sec']).toBe(1);
  });
});
