-- event-wait-settlement-2026-10-20 P-005, clause AUTO-BAR-R-10-P-005@3 — live probe (read-only).
-- Clause: an item left blocked with every blocker cleared returns to open on the next re-check sweep tick.
-- Falsifier: after a tick, an item is blocked, every blocker is cleared, nothing else holds it, and the
-- clear came before that tick (stranded > 0).
--
-- Population = the re-check sweep's own scope (work-item-blocker-reaper.ts listStrandedBlocked): workspace
-- papercusp-workspace, status blocked, not an observation, at least one external blocker, none active.
-- The hold predicates are written from the clause text, not copied from the sweep's selection query.
--
-- Every candidate lands in exactly ONE bucket: a single CASE, first match wins, every hold flag COALESCEd
-- to false. An unknown flag therefore falls through toward `stranded` (fail-closed) instead of dropping
-- the row from every count, which is what the first reading's independent FILTERs allowed.
--
-- The tick is the sweep's host routine (gate-watcher-tick, every ~2 min) last start minus a 5-minute
-- settle window, so a fire still in flight cannot count against an item it has not reached yet.
--
-- Output: ONE psql -At row of eight integers, judged by scripts/lib/stranded-blocked-live-oracle.mjs:
--   all_cleared_blocked|reblocked_after_clear|other_hold|stranded|cleared_since_tick|missing_times|tick_age_s|repair_audit_rows
-- Run (repo root): sudo -n -u postgres psql -d papercusp -q -At -v ON_ERROR_STOP=1 -f docs/evidence/ews-p005-r10-stranded-live/probe.sql
-- The /*@...*/ markers are where run.mjs derives its negative controls; they are inert comments here.
BEGIN READ ONLY;
WITH t AS (
  SELECT r.last_fired_at /*@tick-start*/ AS tick_start
    FROM harness_shared.routines r
   WHERE r.workspace_id = 'papercusp-workspace'
     AND r.install_slug = 'papercusp'
     AND r.name = 'gate-watcher-tick'
), c AS (
  SELECT w.feature_id, w.origin, w.source_plan_slug, w.state_changed_at, w.payload,
         (SELECT max(COALESCE(b->>'clearedAt', b->>'updatedAt')::timestamptz)
            FROM jsonb_array_elements(w.payload->'externalBlockers') b) AS last_clear
    FROM harness_shared.work_items w
   WHERE w.workspace_id = 'papercusp-workspace'
     AND w.status = 'blocked'
     AND w.lane IS DISTINCT FROM 'observation'
     AND jsonb_typeof(w.payload->'externalBlockers') = 'array'
     AND jsonb_array_length(w.payload->'externalBlockers') > 0
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(w.payload->'externalBlockers') b WHERE b->>'status' = 'active')
  /*@extra-candidates*/
), k AS (
  SELECT CASE
           WHEN c.state_changed_at IS NULL OR c.last_clear IS NULL THEN 'missing_times'
           WHEN c.state_changed_at > c.last_clear THEN 'reblocked_after_clear'
           WHEN EXISTS (SELECT 1 FROM harness_shared.work_item_deps d
                         WHERE d.workspace_id = 'papercusp-workspace'
                           AND (d.blocked_ref = c.feature_id OR d.blocked_ref LIKE '%#' || c.feature_id))
             OR (COALESCE(c.payload->>'_claimHold', '') = 'true' AND COALESCE(c.payload->>'held_open_reason', '') <> 'blocked')
             OR NULLIF(btrim(COALESCE(c.payload->>'claim_hold_by', '')), '') IS NOT NULL
             OR COALESCE(c.payload->>'needsOwnerAction', '') = 'true'
             OR COALESCE(c.payload->>'needsHuman', '') = 'true'
             OR COALESCE(c.origin, 'local') <> 'local'
             OR c.source_plan_slug IS NOT NULL
             THEN 'other_hold'
           WHEN c.last_clear < (SELECT tick_start FROM t) - interval '5 minutes' THEN 'stranded'
           ELSE 'cleared_since_tick'
         END AS bucket
    FROM c
)
SELECT count(*) AS all_cleared_blocked,
       count(*) FILTER (WHERE bucket = 'reblocked_after_clear') AS reblocked_after_clear,
       count(*) FILTER (WHERE bucket = 'other_hold') AS other_hold,
       count(*) FILTER (WHERE bucket = 'stranded') AS stranded,
       count(*) FILTER (WHERE bucket = 'cleared_since_tick') AS cleared_since_tick,
       count(*) FILTER (WHERE bucket = 'missing_times') AS missing_times,
       COALESCE((SELECT extract(epoch FROM now() - tick_start)::bigint FROM t), -1) AS tick_age_s,
       (SELECT count(*) FROM harness_shared.audit_log a
         WHERE a.actor = 'system:blocker-stranded-repair' /*@repair-actor*/) AS repair_audit_rows
  FROM k;
ROLLBACK;
