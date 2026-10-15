-- R-5 live measurement for plan work-queue-bulk-cleanup-remediation-2026-10-01 (AUTO-BAR-R-5-P-009 / P-010).
-- Run: sudo -n -u postgres psql -d papercusp -At -F'|' -v ON_ERROR_STOP=1 \
--        -v prevstart='2026-10-06 08:26:20+00' -v bgstart='2026-10-06 08:53:54+00' -f <this file>
-- Scope: workspace_id='papercusp-workspace' (harness 'papercusp' where the relation is harness-keyed).
-- bg-host processes (final run 2026-10-06 ~09:3xZ): :prevstart = PID 1479514 start (08:26:20Z, ran until
-- 08:51:21Z), :bgstart = current PID 3201933 start (08:53:54Z, build 6b949fee10). Runner blobs at
-- 6b949fee10 equal HEAD for bulk-dedup.ts (030d5637e3, the WI-10006491 post-commit fix), promoter.ts
-- (425aa9e391), census.ts (9beee5e1e6), inbox-bulk-resolve-action.ts (197e66a853) and
-- admission-runs-reaper.ts (78ac892d94). Rows are labelled by process.
-- Runtime identity is measured separately via dev:pipeline_position servingRuntimes (evidence JSON).
-- Writers read before comparing (source paths in the evidence JSON):
--   inbox runs/skip strings: packages/operator-core/lib/harness/routines/inbox-bulk-resolve-action.ts
--   bulk stage/census/digest: packages/operator-core/lib/work-items-admission-bulk-dedup.ts
--   promoter tick detail (prescreen, misHomedByScope, reviewDebt, reviewMoot): packages/operator-core/lib/work-items-admission-promoter.ts
--   reaper (reapedBy/reapedAt/strandedAfterMs): packages/operator-core/lib/admission-runs-reaper.ts

SET TIME ZONE 'UTC';
\echo '# taken' `date -u +%Y-%m-%dT%H:%M:%SZ`

-- ───────────── Partition (1): Inbox scheduling ─────────────
\echo '## P1a inbox-resolve runs created in the last 24h (run|requested_by|phase|created|started|finished|total|auto|rec|skip|fail|onCurrentBuild|error)'
SELECT run_id, requested_by, phase, created_at, started_at, finished_at, total_items, auto_resolved, recommended, skipped, failed,
       CASE WHEN created_at >= :'bgstart' THEN 'current-process' WHEN created_at >= :'prevstart' THEN 'prior-process-same-runner-blobs' ELSE 'older' END AS build,
       left(coalesce(error,''),100)
  FROM harness_shared.attention_bulk_runs
 WHERE workspace_id = 'papercusp-workspace' AND run_kind = 'inbox-resolve'
   AND created_at >= now() - interval '24 hours'
 ORDER BY created_at;

\echo '## P1b execution overlap at each current-build run creation (run|created|overlapping_executing_runs|immediate_predecessor|predecessor_phase|predecessor_finished)'
-- An overlap = another inbox-resolve run that STARTED before this run was created and had not
-- finished by then while still in an executing phase (pending/running). A predecessor in 'review'
-- has finished executing; D-001/P-001 says it must not block the next scheduled run.
SELECT r.run_id, r.created_at,
       CASE WHEN r.created_at >= :'bgstart' THEN 'current-process' ELSE 'prior-process-same-runner-blobs' END AS build,
       (SELECT count(*) FROM harness_shared.attention_bulk_runs o
         WHERE o.workspace_id = r.workspace_id AND o.run_kind = 'inbox-resolve' AND o.run_id <> r.run_id
           AND o.started_at <= r.created_at AND (o.finished_at IS NULL OR o.finished_at > r.created_at)
           AND o.phase IN ('pending','running')) AS overlapping_executing,
       p.run_id AS predecessor, p.phase AS predecessor_phase, p.finished_at AS predecessor_finished
  FROM harness_shared.attention_bulk_runs r
  LEFT JOIN LATERAL (
    SELECT q.run_id, q.phase, q.finished_at FROM harness_shared.attention_bulk_runs q
     WHERE q.workspace_id = r.workspace_id AND q.run_kind = 'inbox-resolve' AND q.created_at < r.created_at
     ORDER BY q.created_at DESC LIMIT 1) p ON true
 WHERE r.workspace_id = 'papercusp-workspace' AND r.run_kind = 'inbox-resolve'
   AND r.created_at >= :'prevstart'
 ORDER BY r.created_at;

\echo '## P1c positive control: inbox-resolve phase census, all time (phase|n)'
SELECT phase, count(*) FROM harness_shared.attention_bulk_runs
 WHERE workspace_id = 'papercusp-workspace' AND run_kind = 'inbox-resolve' GROUP BY phase ORDER BY phase;

\echo '## P1d original stale-run dismiss receipts (run|kind|phase|requested_by|total|auto|rec|skip|fail|finished)'
SELECT run_id, run_kind, phase, requested_by, total_items, auto_resolved, recommended, skipped, failed, finished_at
  FROM harness_shared.attention_bulk_runs
 WHERE workspace_id = 'papercusp-workspace'
   AND run_id IN ('bulk-7d35ee41-f64f-4150-8e12-35524c481213','bulk-bc6d1eeb-5609-4881-8731-029b5b102682','bulk-ef1590f9-6abe-4072-9389-8857864d2b90')
 ORDER BY run_id;

\echo '## P1e per-item outcome of the dismissed runs (run|outcome|disposition|n)'
SELECT left(run_id, 13), coalesce(outcome,'<null>'), coalesce(disposition,'<null>'), count(*)
  FROM harness_shared.attention_bulk_run_items
 WHERE workspace_id = 'papercusp-workspace'
   AND run_id IN ('bulk-7d35ee41-f64f-4150-8e12-35524c481213','bulk-bc6d1eeb-5609-4881-8731-029b5b102682','bulk-ef1590f9-6abe-4072-9389-8857864d2b90')
 GROUP BY 1,2,3 ORDER BY 1,2,3;

-- ───────────── Partition (2): census, bounded stage, schedule, digest ─────────────
\echo '## P2a run f3083502 rows (id|status|started|finished|census_before|census_after|failedAfterMergeCommit|error|outcome|workBudget|coverageAssertion)'
SELECT id, detail->>'status', started_at, finished_at, census_before, census_after,
       detail ? 'failedAfterMergeCommit', left(coalesce(detail->>'error',''),160),
       detail->'outcome', detail->'workBudget', left(coalesce((detail->'coverageAssertion')::text,''),200)
  FROM harness_shared.admission_runs
 WHERE workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp'
   AND id LIKE 'bulk-dedup-scheduled-1791273167828-f3083502%'
 ORDER BY started_at;

\echo '## P2b bulk-dedup stage rows, last 7 days (id|status|started|finished|outcome|workBudget|error)'
SELECT id, detail->>'status', started_at, finished_at, detail->'outcome', detail->'workBudget', left(coalesce(detail->>'error',''),120)
  FROM harness_shared.admission_runs
 WHERE workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp'
   AND id LIKE 'bulk-dedup-%' AND id ~ '-stage-[0-9]+$'
   AND started_at >= now() - interval '7 days'
 ORDER BY started_at;

\echo '## P2c bulk-dedup / digest / inbox / admission routines (id|name|install|active|trigger_kind|last_fired|next_fire|trigger_config)'
SELECT id, name, install_slug, active, trigger_kind, last_fired_at, next_fire_at, left(trigger_config::text,160)
  FROM harness_shared.routines
 WHERE workspace_id = 'papercusp-workspace'
   AND (name ILIKE '%dedup%' OR name ILIKE '%digest%' OR name ILIKE '%inbox-bulk%' OR name ILIKE '%admission%'
        OR id ILIKE '%dedup%' OR payload_template::text ILIKE '%bulk-dedup%')
 ORDER BY name;

\echo '## P2d daily digests, last 4 days (id|status|started|finished|sourceCensusRunId|sourceBulkStageRunId|coverage|outcome)'
SELECT id, detail->>'status', started_at, finished_at, detail->>'sourceCensusRunId', detail->>'sourceBulkStageRunId',
       detail->'coverage', detail->'outcome'
  FROM harness_shared.admission_runs
 WHERE workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp' AND run_kind = 'daily-digest'
   AND started_at >= now() - interval '4 days'
 ORDER BY started_at;

-- ───────────── Partition (3): promoter model ticks ─────────────
\echo '## P3a fixed before/after promoter-tick population (window|ticks|model_ticks|model_ticks_with_yield|promoted|merged|failed)'
-- before = 2026-10-01 10:00Z..14:00Z (pre-fix baseline); after = 14:00Z 10-01 .. 08:00Z 10-06 (fixed end);
-- prior/current = ticks started on the prior / current bg-host process (:prevstart / :bgstart). Model tick = tokens_in > 0.
SELECT w.label, count(ar.id),
       count(ar.id) FILTER (WHERE coalesce(ar.tokens_in,0) > 0),
       count(ar.id) FILTER (WHERE coalesce(ar.tokens_in,0) > 0 AND coalesce(ar.promoted,0) + coalesce(ar.merged,0) > 0),
       coalesce(sum(ar.promoted),0), coalesce(sum(ar.merged),0),
       count(ar.id) FILTER (WHERE ar.detail->>'status' = 'failed')
  FROM (VALUES ('1-before', '2026-10-01 10:00+00'::timestamptz, '2026-10-01 14:00+00'::timestamptz),
               ('2-after',  '2026-10-01 14:00+00'::timestamptz, '2026-10-06 08:00+00'::timestamptz),
               ('3-prior-process-same-runner-blobs', :'prevstart'::timestamptz, :'bgstart'::timestamptz),
               ('4-current-process', :'bgstart'::timestamptz, now())) AS w(label, lo, hi)
  LEFT JOIN harness_shared.admission_runs ar
    ON ar.workspace_id = 'papercusp-workspace' AND ar.harness_slug = 'papercusp' AND ar.run_kind = 'promoter-tick'
   AND ar.started_at >= w.lo AND ar.started_at < w.hi
 GROUP BY w.label ORDER BY w.label;

\echo '## P3a2 D-006 model-tick yield windows (window|model_ticks|with_yield|promoted|merged)'
-- D-006 baseline: 07:40Z-11:02Z 10-01 (pre-D-001, all-zero yield) vs 11:02Z-14:15Z (D-001 live).
SELECT w.label,
       count(ar.id) FILTER (WHERE coalesce(ar.tokens_in,0) > 0),
       count(ar.id) FILTER (WHERE coalesce(ar.tokens_in,0) > 0 AND coalesce(ar.promoted,0) + coalesce(ar.merged,0) > 0),
       coalesce(sum(ar.promoted) FILTER (WHERE coalesce(ar.tokens_in,0) > 0),0),
       coalesce(sum(ar.merged) FILTER (WHERE coalesce(ar.tokens_in,0) > 0),0)
  FROM (VALUES ('d006-before','2026-10-01 07:40+00'::timestamptz,'2026-10-01 11:02+00'::timestamptz),
               ('d006-after', '2026-10-01 11:02+00'::timestamptz,'2026-10-01 14:15+00'::timestamptz)) AS w(label, lo, hi)
  LEFT JOIN harness_shared.admission_runs ar
    ON ar.workspace_id = 'papercusp-workspace' AND ar.harness_slug = 'papercusp' AND ar.run_kind = 'promoter-tick'
   AND ar.started_at >= w.lo AND ar.started_at < w.hi
 GROUP BY w.label ORDER BY w.label;

\echo '## P3e promoter-tick wall-clock latency per fixed window, finished ticks only (window|finished_ticks|p50_s|p90_s|max_s|model_p50_s|model_p90_s)'
-- Same windows as P3a. Latency = finished_at - started_at (the writer stamps both on the tick row).
SELECT w.label, count(ar.id),
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ar.finished_at - ar.started_at))::numeric, 1),
       round(percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM ar.finished_at - ar.started_at))::numeric, 1),
       round(max(extract(epoch FROM ar.finished_at - ar.started_at))::numeric, 1),
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM ar.finished_at - ar.started_at))
              FILTER (WHERE coalesce(ar.tokens_in,0) > 0))::numeric, 1),
       round((percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM ar.finished_at - ar.started_at))
              FILTER (WHERE coalesce(ar.tokens_in,0) > 0))::numeric, 1)
  FROM (VALUES ('1-before', '2026-10-01 10:00+00'::timestamptz, '2026-10-01 14:00+00'::timestamptz),
               ('2-after',  '2026-10-01 14:00+00'::timestamptz, '2026-10-06 08:00+00'::timestamptz),
               ('3-prior-process-same-runner-blobs', :'prevstart'::timestamptz, :'bgstart'::timestamptz),
               ('4-current-process', :'bgstart'::timestamptz, now())) AS w(label, lo, hi)
  LEFT JOIN harness_shared.admission_runs ar
    ON ar.workspace_id = 'papercusp-workspace' AND ar.harness_slug = 'papercusp' AND ar.run_kind = 'promoter-tick'
   AND ar.started_at >= w.lo AND ar.started_at < w.hi AND ar.finished_at IS NOT NULL
 GROUP BY w.label ORDER BY w.label;

\echo '## P3d current-build prescreen dispositions, samples removed (id|prescreen)'
SELECT id, CASE WHEN started_at >= :'bgstart' THEN 'current-process' ELSE 'prior-process-same-runner-blobs' END,
       (detail->'prescreen') - 'samples'
  FROM harness_shared.admission_runs
 WHERE workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp' AND run_kind = 'promoter-tick'
   AND started_at >= :'prevstart' AND detail ? 'prescreen'
 ORDER BY started_at;

\echo '## P3b current-build promoter ticks (id|status|started|finished|batch|promoted|merged|held|tokens_in|prescreen|misHomedByScope|reviewDebt|reviewMoot)'
SELECT id, CASE WHEN started_at >= :'bgstart' THEN 'current-process' ELSE 'prior-process-same-runner-blobs' END,
       detail->>'status', started_at, finished_at, batch_size, promoted, merged, held, tokens_in,
       left(coalesce((detail->'prescreen')::text,''),400), detail->'misHomedByScope',
       left(coalesce((detail->'reviewDebt')::text,''),300), left(coalesce((detail->'reviewMoot')::text,''),200)
  FROM harness_shared.admission_runs
 WHERE workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp' AND run_kind = 'promoter-tick'
   AND started_at >= :'prevstart'
 ORDER BY started_at;

\echo '## P3c 14-row repair: every copy of the rehomed + dropped original learning-loop ids (feature_id|harness|status|origin|admission|rehomed_from|state_changed)'
WITH ids AS (
  SELECT DISTINCT feature_id FROM harness_shared.work_items
   WHERE workspace_id = 'papercusp-workspace' AND payload ? 'rehomed_from'
     AND payload->'rehomed_from'->>'at' LIKE '2026-10-01T12:3%'
  UNION SELECT unnest(ARRAY['EI-24267222757977875','EI-24267222987491045','EI-24267223289868756'])
)
SELECT wi.feature_id, wi.harness_slug, wi.status, wi.origin, wi.admission, wi.payload->'rehomed_from', wi.state_changed_at
  FROM harness_shared.work_items wi JOIN ids USING (feature_id)
 WHERE wi.workspace_id = 'papercusp-workspace'
 ORDER BY wi.feature_id, wi.harness_slug;

-- ───────────── Partition (4): residual, reap history, review debt ─────────────
\echo '## P4a kind-threshold residual: unfinished admission_runs of any kind or age (run_kind|id|status|started|age)'
SELECT run_kind, id, detail->>'status', started_at, now() - started_at
  FROM harness_shared.admission_runs
 WHERE workspace_id = 'papercusp-workspace' AND finished_at IS NULL
 ORDER BY started_at;

\echo '## P4b positive control: runs started in the last 6h by kind (run_kind|started|finished|unfinished|max_duration)'
SELECT run_kind, count(*), count(finished_at), count(*) - count(finished_at), max(finished_at - started_at)
  FROM harness_shared.admission_runs
 WHERE workspace_id = 'papercusp-workspace' AND started_at >= now() - interval '6 hours'
 GROUP BY run_kind ORDER BY run_kind;

\echo '## P4c historic reap ledger (reapedBy|reapedAt|run_kind|n)'
SELECT detail->>'reapedBy', detail->>'reapedAt', run_kind, count(*)
  FROM harness_shared.admission_runs
 WHERE workspace_id = 'papercusp-workspace' AND detail ? 'reapedBy'
 GROUP BY 1,2,3 ORDER BY 2,3;

\echo '## P4d comparable review-debt series from promoter ticks (id|started|reviewDebt.pending|overdue|reviewMoot.closed|truncatedByLimit)'
SELECT id, started_at, detail->'reviewDebt'->>'pending', detail->'reviewDebt'->>'overdue',
       detail->'reviewMoot'->>'closed', detail->'reviewMoot'->>'truncatedByLimit'
  FROM harness_shared.admission_runs
 WHERE workspace_id = 'papercusp-workspace' AND harness_slug = 'papercusp' AND run_kind = 'promoter-tick'
   AND detail ? 'reviewDebt'
   AND (started_at BETWEEN '2026-10-01 12:10+00' AND '2026-10-01 14:05+00'
        OR started_at BETWEEN '2026-10-03 09:10+00' AND '2026-10-03 09:20+00'
        OR started_at >= :'prevstart')
 ORDER BY started_at;

\echo '## P4e independent re-count of review debt (same predicate as readWorkItemAdmissionQueueHealth, workspace-wide) (review_pending|review_overdue|population)'
SELECT count(*) FILTER (WHERE COALESCE(wi.payload #>> '{admissionReview,state}', CASE WHEN wi.admission = 'unreviewed' THEN 'pending' END) = 'pending'),
       count(*) FILTER (WHERE COALESCE(wi.payload #>> '{admissionReview,state}', CASE WHEN wi.admission = 'unreviewed' THEN 'pending' END) = 'pending'
                          AND NULLIF(wi.payload #>> '{admissionReview,reviewDueAt}', '') IS NOT NULL
                          AND (wi.payload #>> '{admissionReview,reviewDueAt}')::timestamptz < now()),
       count(*)
  FROM harness_shared.work_items wi
 WHERE wi.workspace_id = 'papercusp-workspace'
   AND (wi.admission IS NOT NULL OR wi.admitted_at IS NOT NULL);
