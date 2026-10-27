-- EI-26805167986752964: replacement for the archived WI-10006249 escape.sql.
-- Run through dev:pg_query / an existing kind:sql rubric probe; no writes.
-- Change the inputs for a new edition and retain the returned cutoff/scope.
-- This is a citation proxy, not a cause-adjudicated defect escape rate.
-- Creation/close times are cutoff-bounded; titles and plan membership are read
-- as stored now, not reconstructed as-of history. The original archive stays intact.
WITH inputs AS (
  SELECT 'papercusp-workspace'::text AS workspace_id,
         'papercusp'::text AS harness_slug,
         '2026-10-24T04:45:54.342531Z'::timestamptz AS cutoff
), src AS (
  SELECT w.feature_id, w.item_kind, w.closed_ts,
         w.source_plan_slug IS NOT NULL AS plan_bound
  FROM harness_shared.work_items w CROSS JOIN inputs p
  WHERE w.workspace_id = p.workspace_id AND w.harness_slug = p.harness_slug
    AND w.status = 'done' AND w.lane IS DISTINCT FROM 'observation'
    AND w.closed_ts BETWEEN (extract(epoch FROM p.cutoff - interval '44 days') * 1000)::bigint
                        AND (extract(epoch FROM p.cutoff - interval '14 days') * 1000)::bigint
    AND jsonb_typeof(w.payload->'_completionEvidence'->'filesChanged') = 'array'
    AND jsonb_array_length(w.payload->'_completionEvidence'->'filesChanged') > 0
), cites AS (
  SELECT DISTINCT b.feature_id AS bug_id, m[1] AS cited_id, b.created_ts
  FROM harness_shared.work_items b CROSS JOIN inputs p
  CROSS JOIN LATERAL regexp_matches(
    coalesce(b.title, '') || ' ' || coalesce(b.summary, ''),
    '((?:EI|WI)-[0-9]{3,})', 'g'
  ) m
  WHERE b.workspace_id = p.workspace_id AND b.harness_slug = p.harness_slug
    AND b.item_kind = 'bug' AND b.lane IS DISTINCT FROM 'observation'
    AND b.created_ts > (extract(epoch FROM p.cutoff - interval '44 days') * 1000)::bigint
    AND b.created_ts <= (extract(epoch FROM p.cutoff) * 1000)::bigint
), hit AS (
  SELECT DISTINCT s.feature_id, c.bug_id
  FROM src s JOIN cites c ON c.cited_id = s.feature_id AND c.bug_id <> s.feature_id
    AND c.created_ts BETWEEN s.closed_ts AND s.closed_ts + 14 * 86400000::bigint
)
SELECT p.workspace_id, p.harness_slug, p.cutoff, s.item_kind, s.plan_bound,
       count(DISTINCT s.feature_id)::int AS closed_items,
       count(DISTINCT h.feature_id)::int AS cited_items,
       round(100.0 * count(DISTINCT h.feature_id)
             / NULLIF(count(DISTINCT s.feature_id), 0), 2)::double precision AS citation_pct
FROM src s CROSS JOIN inputs p LEFT JOIN hit h ON h.feature_id = s.feature_id
GROUP BY p.workspace_id, p.harness_slug, p.cutoff, s.item_kind, s.plan_bound
ORDER BY s.item_kind, s.plan_bound
