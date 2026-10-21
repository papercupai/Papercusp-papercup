-- event-wait-settlement-2026-10-20 P-005, clause AUTO-BAR-R-10-P-005@3 — live reading.
-- Falsifier: after a re-check sweep tick, an item whose external blockers are all cleared, with no
-- other hold, is still in state blocked (falsifying_stranded > 0).
-- Read-only. Run with the last observed sweep tick as :tick, e.g.
--   sudo -n -u postgres psql -d papercusp -At -F '|' -v tick=2026-10-21T01:56:54Z -f docs/evidence/ews-p005-r10-stranded-blocked-live.sql
-- Partition: reblocked_after_clear (blocked again after the last clear, for a reason the blocker
-- history does not record) + other_hold (dependency edge, durable claim park, owner-reserved,
-- non-local origin, plan item) + falsifying_stranded + cleared_after_last_tick = all_cleared_blocked.
-- The predicate is written from the clause text, not copied from the sweep's selection query.
BEGIN READ ONLY;
WITH c AS (
  SELECT w.workspace_id, w.feature_id, w.origin, w.source_plan_slug, w.state_changed_at, w.payload,
         (SELECT max(COALESCE(b->>'clearedAt', b->>'updatedAt')::timestamptz)
            FROM jsonb_array_elements(w.payload->'externalBlockers') b) AS last_clear
    FROM harness_shared.work_items w
   WHERE w.status = 'blocked'
     AND w.lane IS DISTINCT FROM 'observation'
     AND COALESCE(w.nature, 'work') = 'work'
     AND jsonb_typeof(w.payload->'externalBlockers') = 'array'
     AND jsonb_array_length(w.payload->'externalBlockers') > 0
     AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(w.payload->'externalBlockers') b WHERE b->>'status' = 'active')
), k AS (
  SELECT c.*,
         (state_changed_at > last_clear) AS reblocked_after_clear,
         EXISTS (SELECT 1 FROM harness_shared.work_item_deps d
                  WHERE d.workspace_id = c.workspace_id
                    AND (d.blocked_ref = c.feature_id OR d.blocked_ref LIKE '%#' || c.feature_id)) AS has_dep_edge,
         ((COALESCE(payload->>'_claimHold', '') = 'true' AND COALESCE(payload->>'held_open_reason', '') <> 'blocked')
           OR NULLIF(btrim(COALESCE(payload->>'claim_hold_by', '')), '') IS NOT NULL) AS has_park,
         (payload->>'needsOwnerAction' = 'true' OR payload->>'needsHuman' = 'true') AS owner_reserved,
         (origin <> 'local') AS non_local,
         (source_plan_slug IS NOT NULL) AS plan_item
    FROM c
)
SELECT count(*) AS all_cleared_blocked,
       count(*) FILTER (WHERE reblocked_after_clear) AS reblocked_after_clear,
       count(*) FILTER (WHERE state_changed_at IS NULL OR last_clear IS NULL) AS missing_times,
       count(*) FILTER (WHERE NOT reblocked_after_clear
                          AND (has_dep_edge OR has_park OR owner_reserved OR non_local OR plan_item)) AS other_hold,
       count(*) FILTER (WHERE NOT reblocked_after_clear
                          AND NOT (has_dep_edge OR has_park OR owner_reserved OR non_local OR plan_item)
                          AND last_clear < :'tick'::timestamptz) AS falsifying_stranded,
       count(*) FILTER (WHERE NOT reblocked_after_clear
                          AND NOT (has_dep_edge OR has_park OR owner_reserved OR non_local OR plan_item)
                          AND last_clear >= :'tick'::timestamptz) AS cleared_after_last_tick,
       now() AS measured_at,
       (SELECT count(*) FROM harness_shared.audit_log a WHERE a.actor = 'system:blocker-stranded-repair') AS repair_audit_rows
  FROM k;
ROLLBACK;
