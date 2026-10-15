-- Plan work-queue-bulk-cleanup-remediation-2026-10-01 P-002 / activation requirement M-002 (WI-10004720).
-- Current operational proof that the three stale review runs the owner decided to dismiss on 2026-10-01
-- ("Dismiss all three": inbox-resolve bulk-ef1590f9, plan-cleanup bulk-7d35ee41 and bulk-bc6d1eeb) are
-- terminal and hold no row/finding still waiting on the owner.
--
-- READ-ONLY. Run:
--   sudo -n -u postgres psql -d papercusp -At -F'|' -v ON_ERROR_STOP=1 \
--     -f docs/evidence/work-queue-bulk-cleanup-p002-stale-runs-settled-2026-10-06.sql
--
-- Writer of attention_bulk_runs.phase: settleRunPhase (packages/operator-core/lib/attention/bulk-run-store.ts),
-- which derives the phase from the run's item rows (inbox-resolve) or findings rows (plan-cleanup).
-- "Open" below uses the same terminal outcome sets the dismissal script used
-- (docs/evidence/wi-10004720-dismiss-stale-runs.sh): items auto_resolved|dismissed; findings
-- auto_applied|accepted|dismissed.

BEGIN TRANSACTION READ ONLY;

\echo S1|population: target run ids present (expect 3)
SELECT count(*)
  FROM harness_shared.attention_bulk_runs
 WHERE workspace_id = 'papercusp-workspace'
   AND run_id IN ('bulk-ef1590f9-6abe-4072-9389-8857864d2b90',
                  'bulk-7d35ee41-f64f-4150-8e12-35524c481213',
                  'bulk-bc6d1eeb-5609-4881-8731-029b5b102682');

\echo S2|run_id|run_kind|phase|items_total|items_open|items_dismissed|findings_total|findings_open|findings_dismissed
SELECT r.run_id, r.run_kind, r.phase,
       (SELECT count(*) FROM harness_shared.attention_bulk_run_items i
         WHERE i.workspace_id = r.workspace_id AND i.run_id = r.run_id),
       (SELECT count(*) FROM harness_shared.attention_bulk_run_items i
         WHERE i.workspace_id = r.workspace_id AND i.run_id = r.run_id
           AND (i.outcome IS NULL OR i.outcome NOT IN ('auto_resolved', 'dismissed'))),
       (SELECT count(*) FROM harness_shared.attention_bulk_run_items i
         WHERE i.workspace_id = r.workspace_id AND i.run_id = r.run_id AND i.outcome = 'dismissed'),
       (SELECT count(*) FROM harness_shared.plan_cleanup_run_findings f
         WHERE f.workspace_id = r.workspace_id AND f.run_id = r.run_id),
       (SELECT count(*) FROM harness_shared.plan_cleanup_run_findings f
         WHERE f.workspace_id = r.workspace_id AND f.run_id = r.run_id
           AND (f.outcome IS NULL OR f.outcome NOT IN ('auto_applied', 'accepted', 'dismissed'))),
       (SELECT count(*) FROM harness_shared.plan_cleanup_run_findings f
         WHERE f.workspace_id = r.workspace_id AND f.run_id = r.run_id AND f.outcome = 'dismissed')
  FROM harness_shared.attention_bulk_runs r
 WHERE r.workspace_id = 'papercusp-workspace'
   AND r.run_id IN ('bulk-ef1590f9-6abe-4072-9389-8857864d2b90',
                    'bulk-7d35ee41-f64f-4150-8e12-35524c481213',
                    'bulk-bc6d1eeb-5609-4881-8731-029b5b102682')
 ORDER BY r.run_id;

\echo S3|positive control: the open-row predicate does return non-zero on other runs (count of runs with >=1 open item)
SELECT count(DISTINCT r.run_id)
  FROM harness_shared.attention_bulk_runs r
  JOIN harness_shared.attention_bulk_run_items i
    ON i.workspace_id = r.workspace_id AND i.run_id = r.run_id
 WHERE r.workspace_id = 'papercusp-workspace'
   AND (i.outcome IS NULL OR i.outcome NOT IN ('auto_resolved', 'dismissed'));

\echo S4|measured_at
SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

COMMIT;
