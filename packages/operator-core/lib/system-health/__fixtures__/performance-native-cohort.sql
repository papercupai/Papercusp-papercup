-- Authoring source for the application-performance rubric's five native checks.
-- Substitute the four __...__ pins when proposing a revision; an empty run list
-- remains unknown. The integration suite exercises these same query bytes.
WITH pin AS (
  SELECT '__CANDIDATE_BUILD__'::text build_sha,
         ARRAY[__VERIFIED_RUN_IDS__]::text[] verified_run_ids,
         '__METRIC_KEY__'::text metric_key,
         __BUDGET_MS__::float8 budget_ms
), attempts AS (
  SELECT r.id,r.created_ts,r.status,r.build_sha,r.run_id,
    (SELECT count(*) FROM jsonb_array_elements(r.measures) m
      WHERE m->>'key'=p.metric_key) metric_count,
    (SELECT max((m->>'value')::float8) FROM jsonb_array_elements(r.measures) m
      WHERE m->>'key'=p.metric_key AND m->>'unit'='ms'
        AND (m->>'value')::float8>=0
        AND (m->>'value')::float8<'Infinity'::float8) value_ms
  FROM harness_shared.desktop_perf_runs r CROSS JOIN pin p
  WHERE r.workspace_id='papercusp-workspace' AND r.source='wdio'
    AND r.build_sha=p.build_sha AND r.run_id=ANY(p.verified_run_ids)
), latest AS (
  SELECT * FROM attempts ORDER BY created_ts DESC,id DESC LIMIT 1
), samples AS (
  SELECT * FROM attempts
  WHERE created_ts BETWEEN extract(epoch FROM now()-interval '1 hour')*1000
                       AND extract(epoch FROM now())*1000
), summary AS (
  SELECT count(*)::int attempt_n,count(DISTINCT run_id)::int distinct_run_n,
    count(*) FILTER(WHERE metric_count=1 AND value_ms IS NOT NULL)::int valid_n,
    count(*) FILTER(WHERE status<>'pass')::int failed_n,
    percentile_disc(0.5) WITHIN GROUP(ORDER BY value_ms) FILTER(WHERE metric_count=1) p50_ms,
    percentile_disc(0.95) WITHIN GROUP(ORDER BY value_ms) FILTER(WHERE metric_count=1) p95_ms,
    min(created_ts) oldest_sample_ms,max(created_ts) newest_sample_ms
  FROM samples
)
SELECT s.*,p.build_sha candidate_build,p.verified_run_ids,p.metric_key,
  l.id latest_attempt_id,l.status latest_attempt_status,l.created_ts latest_attempt_ms,
  CASE WHEN cardinality(p.verified_run_ids)>=5 AND s.distinct_run_n>=5
    AND s.distinct_run_n=s.attempt_n AND s.valid_n=s.attempt_n
    AND NOT EXISTS (SELECT 1 FROM attempts GROUP BY run_id HAVING count(*)>1)
    AND (s.failed_n=0 OR s.p95_ms>p.budget_ms)
    AND l.metric_count=1 AND l.value_ms IS NOT NULL
    AND (l.status='pass' OR l.value_ms>p.budget_ms)
    AND l.created_ts BETWEEN extract(epoch FROM now()-interval '1 hour')*1000
                        AND extract(epoch FROM now())*1000
    THEN 100*s.p95_ms/p.budget_ms END::float8 budget_pct,
  CASE WHEN cardinality(p.verified_run_ids)=0
    THEN 'unavailable: verified candidate/run pins not yet recorded'
    ELSE 'explicit candidate cohort; unique runs and individual ages checked'
    END measurement_status,
  'Native failures can prove a measured latency breach, never a pass. Missing preflight rows and cancellation/timeout-specific denominators remain unavailable.' outcome_limit
FROM summary s CROSS JOIN pin p LEFT JOIN latest l ON true
