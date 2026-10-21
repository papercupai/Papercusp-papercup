-- event-wait-settlement-2026-10-20 P-006, clause AUTO-BAR-R-12-P-006@3 — live probe (read-only).
-- Clause: every pre-existing active event blocker on an unprovable ref carries a re-check date after the backfill.
-- Falsifier: after the live backfill run, a count finds a broad-key or free-text event or gate blocker with no
-- re-check date, or finds one the backfill cleared.
--
-- Population = the backfill's own scope (work-item-blocker-reaper.ts listUnstampedWaits), widened to every
-- active row whatever its age: workspace papercusp-workspace, item not terminal, blocker kind event|gate,
-- status active, ref not a plan-lane marker. Rows written after the backfill are included on purpose
-- (fail-closed): admission must have refused them if they were unprovable, so they must pass the same test.
--
-- "Provable" is decided HERE, independently of the classifier under test (readEventConditionReachability):
--   * proving_concrete — a concrete key of an EVENT_CATALOG family whose fire proves the condition
--     (fireProves 'condition'); the family list is pinned to catalog.ts by
--     scripts/lib/unprovable-wait-backfill-live-oracle.test.ts;
--   * announced_live   — the exact ref has a live announcement (event_awaits policy 'announce', not fired,
--     not cancelled, not expired), so its producer will fire it;
--   * announced_fired  — the exact ref's announcement already fired (latched): the condition is proved, so
--     the row is a settlement question (P-004), not an unprovable wait. Reported, not a violation.
-- Anything else with no re-check date is `unprovable_unstamped` — the falsifier. A free-text ref (whitespace,
-- or no family prefix) can only land there.
--
-- Every row lands in exactly ONE bucket (a single CASE, first match wins).
-- The terminal-state list is pinned to ANY_FAMILY_TERMINAL_STATES by the same oracle test.
-- Negative controls (run.mjs) rewrite one /*@marker*/ each and must make the oracle fail.
BEGIN TRANSACTION READ ONLY;
WITH pop AS (
  SELECT w.feature_id, e
    FROM harness_shared.work_items w,
         jsonb_array_elements(w.payload->'externalBlockers') e
   WHERE w.workspace_id = 'papercusp-workspace'
     AND NOT (w.status = ANY (ARRAY['passed','deprecated','done','dropped','resolved','closed']::text[])) /*@terminal*/
     AND jsonb_typeof(w.payload->'externalBlockers') = 'array'
     AND e->>'kind' IN ('event', 'gate')
     AND e->>'status' = 'active'
     AND coalesce(e->>'ref', '') !~ '^plan-lane:'
),
ann AS (
  SELECT a.event_key,
         bool_or(a.fired_at IS NULL AND a.cancelled_at IS NULL
                 AND (a.expires_ts IS NULL OR a.expires_ts > now())) AS live,
         bool_or(a.fired_at IS NOT NULL) AS fired
    FROM harness_shared.event_awaits a
   WHERE a.policy = 'announce'
     AND a.event_key IN (SELECT e->>'ref' FROM pop)
   GROUP BY a.event_key
),
k AS (
  SELECT p.feature_id,
         CASE
           WHEN p.e->>'recheckAt' IS NOT NULL /*@stamped*/ THEN 'stamped'
           WHEN coalesce(p.e->>'ref', '') ~ '^(release:deployed|lock:grant|plan-run:finished|task:terminal|work-item:done|work-item:settled|plan-item:done|scorecard:grading-audit|coord:receipt|work-item:duplicate-settled|escalation:resolved|conversation:answered|handoff:accepted|report:published):\S+$' /*@concrete*/
             THEN 'proving_concrete'
           WHEN coalesce(an.live, false) /*@announced*/ THEN 'announced_live'
           WHEN coalesce(an.fired, false) THEN 'announced_fired'
           ELSE 'unprovable_unstamped'
         END AS bucket
    FROM pop p
    LEFT JOIN ann an ON an.event_key = p.e->>'ref'
),
hist AS (
  SELECT e
    FROM harness_shared.work_items w,
         jsonb_array_elements(w.payload->'externalBlockers') e
   WHERE w.workspace_id = 'papercusp-workspace'
     AND jsonb_typeof(w.payload->'externalBlockers') = 'array'
)
SELECT (SELECT count(*) FROM k) AS active_waits,
       (SELECT count(*) FROM k WHERE bucket = 'stamped') AS stamped,
       (SELECT count(*) FROM k WHERE bucket = 'proving_concrete') AS proving_concrete,
       (SELECT count(*) FROM k WHERE bucket = 'announced_live') AS announced_live,
       (SELECT count(*) FROM k WHERE bucket = 'announced_fired') AS announced_fired,
       (SELECT count(*) FROM k WHERE bucket = 'unprovable_unstamped') AS unprovable_unstamped,
       (SELECT count(*) FROM hist
         WHERE e->>'recheckSource' = 'system:unprovable-wait-backfill' /*@backfill-actor*/) AS backfill_stamped_rows,
       (SELECT count(*) FROM hist
         WHERE e->>'clearedBy' = 'system:unprovable-wait-backfill' /*@cleared-actor*/) AS backfill_cleared,
       (SELECT count(*) FROM hist
         WHERE e->>'recheckSource' = 'system:unprovable-wait-backfill'
           AND e->>'status' <> 'active' AND e->>'clearedBy' IS NULL /*@unattributed*/) AS stamped_inactive_unattributed;
ROLLBACK;
