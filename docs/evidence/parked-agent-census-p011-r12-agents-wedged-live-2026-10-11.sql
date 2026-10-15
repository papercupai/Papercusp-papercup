-- P-011 R-12 live readback (plan parked-agent-census-resumption-and-root-cause-2026-10-09, WI-10008162).
-- Behavior: a standing alarm fires when the wedged-session count exceeds its threshold.
-- Read-only. Run: sudo -n -u postgres psql -d papercusp -At -F'|' -v ON_ERROR_STOP=1 -f <this file>
BEGIN READ ONLY;

\echo '# 1 raises and resolutions per signature (window: since 2026-10-11 04:00Z, up to the observation)'
WITH esc AS (
  SELECT msg_id, body->>'livenessSignature' AS sig, ts
    FROM harness_shared.coord_event_log
   WHERE workspace_id = 'papercusp-workspace'
     AND ts >= '2026-10-11 04:00:00+00' AND ts <= '2026-10-11 14:40:00+00'
     AND body->>'kind' = 'escalation'
     AND body->>'livenessSignature' IN ('agents-wedged', 'agents-stranded')
), res AS (
  SELECT ts, body->>'related_msg_id' AS related, body->>'note' AS note
    FROM harness_shared.coord_event_log
   WHERE workspace_id = 'papercusp-workspace'
     AND ts >= '2026-10-11 04:00:00+00' AND ts <= '2026-10-11 14:45:00+00'
     AND body->>'kind' = 'escalation_resolved'
)
SELECT e.sig,
       count(DISTINCT e.msg_id) AS raised,
       count(r.ts) AS resolved,
       round(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM r.ts - e.ts))::numeric, 1) AS median_open_sec,
       min(e.ts) AS first_raise,
       max(e.ts) AS last_raise
  FROM esc e LEFT JOIN res r ON r.related = e.msg_id
 GROUP BY e.sig ORDER BY e.sig;

\echo '# 2 the observed raise (count vs threshold, severity, audience) and its body hash'
SELECT ts, msg_id, body->>'severity' AS severity, body->'to' AS audience, body->>'summary' AS summary,
       encode(sha256(convert_to(body::text, 'UTF8')), 'hex') AS body_sha256
  FROM harness_shared.coord_event_log
 WHERE workspace_id = 'papercusp-workspace'
   AND msg_id = 'mv3ximlh-0000-02a6d7c861d04258b5347327d44b3744'
   AND body->>'kind' = 'escalation';

\echo '# 3 how that raise was resolved'
SELECT ts, body->>'by' AS by, body->>'choice' AS choice, body->>'note' AS note
  FROM harness_shared.coord_event_log
 WHERE workspace_id = 'papercusp-workspace'
   AND body->>'kind' = 'escalation_resolved'
   AND body->>'related_msg_id' = 'mv3ximlh-0000-02a6d7c861d04258b5347327d44b3744';

COMMIT;
