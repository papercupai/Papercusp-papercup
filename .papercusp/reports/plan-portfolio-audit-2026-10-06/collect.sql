\set ON_ERROR_STOP on
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '90s';
WITH portfolio AS (
  SELECT * FROM harness_shared.harness_plans
  WHERE workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp'
), subjects AS (
  SELECT * FROM portfolio WHERE COALESCE(status, 'draft') <> 'shipped'
), relevant_edges AS (
  SELECT l.* FROM harness_shared.coord_links l
  -- Canonical coverage reader intentionally finds exact plan-item references
  -- across the legacy/default and current-workspace link plane.
  WHERE ((l.dst_kind = 'plan_item' AND split_part(l.dst_ref, '#', 1) IN (SELECT plan_slug FROM subjects))
    OR (l.src_kind = 'plan_item' AND split_part(l.src_ref, '#', 1) IN (SELECT plan_slug FROM subjects)))
), linked_work AS (
  SELECT w.* FROM harness_shared.work_items w
  WHERE w.workspace_id = 'papercusp-workspace'
  AND (w.source_plan_slug IN (SELECT plan_slug FROM subjects)
    OR w.payload->'plan_item'->>'plan_slug' IN (SELECT plan_slug FROM subjects)
    OR w.feature_id IN (SELECT regexp_replace(src_ref, '^.*#', '') FROM relevant_edges WHERE src_kind IN ('work_item','feature','issue'))
    OR w.feature_id IN (SELECT regexp_replace(dst_ref, '^.*#', '') FROM relevant_edges WHERE dst_kind IN ('work_item','feature','issue')))
)
SELECT jsonb_build_object(
  'snapshotAt', transaction_timestamp(),
  'workspace', 'papercusp-workspace', 'harness', 'papercusp',
  'portfolio', (SELECT jsonb_agg(jsonb_build_object('slug',plan_slug,'title',title,'status',COALESCE(status,'draft'),'owner',owner,'supersededBy',superseded_by,'supersedes',supersedes,'archived',archived,'legacy',is_legacy,'template',template,'templateSlug',template_slug,'createdAt',created_at,'updatedAt',updated_at) ORDER BY plan_slug) FROM portfolio),
  'plans', (SELECT jsonb_agg(jsonb_build_object('slug',plan_slug,'title',title,'status',COALESCE(status,'draft'),'opStatus',op_status,'owner',owner,'content',content,'contentHash',content_hash,'version',version,'items',items,'decisions',decisions,'nowState',now_state,'nowNext',now_next,'archived',archived,'legacy',is_legacy,'template',template,'templateData',template_data,'templateSlug',template_slug,'scheduleActive',schedule_active,'supersededBy',superseded_by,'supersedes',supersedes,'createdAt',created_at,'updatedAt',updated_at,'initiative',initiative,'goalId',goal_id,'acceptanceRubric',acceptance_bar_rubric_slug,'acceptanceRubricRevision',acceptance_bar_rubric_revision) ORDER BY plan_slug) FROM subjects),
  'work', (SELECT jsonb_agg(jsonb_build_object('id',feature_id,'harness',harness_slug,'title',title,'summary',summary,'status',status,'kind',item_kind,'holder',taken_by,'takenAt',taken_at,'expiresAt',expires_at,'lastProgressAt',last_progress_at,'sourcePlan',source_plan_slug,'sourceItems',source_plan_item_ids,'stamp',payload->'plan_item','completion',completion_ref,'completionEvidence',payload->'_completionEvidence','checkpoint',payload->'_checkpoint','readiness',implementation_readiness_projection,'agentReview',agent_review_projection,'blockers',external_blockers_projection,'workerHistory',worked_by_history,'reopens',reopen_history_projection,'attempts',attempts,'claimHold',claim_hold,'needsOwner',needs_owner_action,'terminalOwner',terminal_owner,'updatedTs',updated_ts,'createdTs',created_ts) ORDER BY feature_id,harness_slug) FROM linked_work),
  'edges', (SELECT jsonb_agg(to_jsonb(e)) FROM relevant_edges e),
  'claims', (SELECT jsonb_agg(to_jsonb(c)) FROM harness_shared.plan_item_claims c WHERE workspace_id='papercusp-workspace' AND harness_slug='papercusp' AND plan_slug IN (SELECT plan_slug FROM subjects)),
  'audits', (SELECT jsonb_agg(to_jsonb(a)-'activation') FROM harness_shared.plan_audits a WHERE workspace_id='papercusp-workspace' AND harness_slug='papercusp' AND plan_slug IN (SELECT plan_slug FROM subjects)),
  'presence', (SELECT jsonb_agg(to_jsonb(c)) FROM harness_shared.coord_presence c WHERE workspace_id='papercusp-workspace'),
  'sessions', (SELECT jsonb_agg(jsonb_build_object('owner',s.coord_owner_id,'plan',s.plan_slug,'startedAt',s.started_at,'endedAt',s.ended_at,'sessionState',s.su_session_state,'updatedAt',s.su_session_updated_at,'launchParent',s.launch_parent_owner,'fleet',s.launch_spec->'fleet','label',s.label,'agent',s.agent)) FROM (SELECT DISTINCT ON (coord_owner_id) coord_owner_id,plan_slug,started_at,ended_at,su_session_state,su_session_updated_at,launch_parent_owner,launch_spec,label,agent FROM harness_shared.adv_sessions WHERE workspace_id='papercusp-workspace' AND coord_owner_id IS NOT NULL AND (plan_slug IN (SELECT plan_slug FROM subjects) OR coord_owner_id IN (SELECT taken_by FROM linked_work WHERE taken_by IS NOT NULL) OR coord_owner_id IN (SELECT owner FROM harness_shared.plan_item_claims WHERE workspace_id='papercusp-workspace' AND harness_slug='papercusp') OR coord_owner_id IN (SELECT owner FROM subjects WHERE owner IS NOT NULL)) ORDER BY coord_owner_id,started_at DESC) s),
  'revisions', (SELECT jsonb_agg(to_jsonb(r)) FROM (SELECT plan_slug,count(*)::int AS revisions,min(created_at) AS first_revision,max(created_at) AS latest_revision FROM harness_shared.plan_revisions WHERE workspace_id='papercusp-workspace' AND harness_slug='papercusp' AND plan_slug IN (SELECT plan_slug FROM subjects) GROUP BY plan_slug) r),
  'testFiles', (SELECT jsonb_agg(to_jsonb(t)) FROM (SELECT DISTINCT ON (file_path) id,file_path,status,framework,finished_at,commit_sha,worktree_dirty,source FROM harness_shared.test_runs WHERE workspace_id='papercusp-workspace' AND harness_slug='papercusp' AND finished_at > now()-interval '90 days' ORDER BY file_path,finished_at DESC) t)
);
COMMIT;
