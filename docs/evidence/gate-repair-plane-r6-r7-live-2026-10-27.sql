-- gate-repair-plane-on-current-build-2026-10-15: live readings for acceptance bars R-6 and R-7.
-- Read-only. Run: sudo -n -u postgres psql -d papercusp -At -F'|' -v ON_ERROR_STOP=1 -f <this file>

-- R-6 (AUTO-BAR-R-6-P-006): the subject bg-host idle-actuator pass record (gate-repair-plane#D-014).
-- Expect: kind green_checkpoint_repair_latency, marker = the current IDLE_ACTUATOR_PASS_MARKER value,
-- executor stamp naming the bg-host (port-3271) and the build it ran, and an open frozen repair queue
-- (main red) in the same record's snapshot.
SELECT 'r6-subject' AS reading, id, kind, created_at,
       detail->'idleActuator'->>'marker' AS marker,
       detail->'idleActuator'->'executor'->>'hostId' AS executor_host,
       detail->'idleActuator'->'executor'->'executingBuild'->>'sha' AS executing_build,
       detail->'idleActuator'->'executor'->'executingBuild'->>'source' AS build_source,
       detail->'idleActuator'->'snapshot'->>'phase' AS queue_phase,
       detail->'idleActuator'->'snapshot'->>'candidate' AS frozen_candidate,
       detail->'idleActuator'->'snapshot'->>'lastVerdictAtMs' AS last_verdict_at_ms
  FROM harness_shared.pipeline_events
 WHERE workspace_id = 'papercusp-workspace' AND id = 845672;

-- R-6 residue census: every pass record carrying the current marker, partitioned by executing build.
SELECT 'r6-marker-records-by-build' AS reading,
       coalesce(detail->'idleActuator'->'executor'->'executingBuild'->>'sha', '<null>') AS executing_build,
       count(*) AS n, min(created_at) AS first_at, max(created_at) AS last_at
  FROM harness_shared.pipeline_events
 WHERE workspace_id = 'papercusp-workspace'
   AND kind = 'green_checkpoint_repair_latency'
   AND detail->'idleActuator'->>'marker' = 'gate-repair-plane-r6-proof-2026-10-27-stamped'
 GROUP BY 2 ORDER BY 4;

-- R-7 (AUTO-BAR-R-7-P-003): exhaustive partition of release:repair-queue calls since the :9071 proxy
-- restart onto the routing build (2026-10-27T04:06Z). Falsified by any row with serving_host port-3070
-- and no build selector; fewer than 20 selector-less rows reads unknown.
SELECT 'r7-partition' AS reading,
       coalesce(serving_host, '<null>') AS serving_host,
       (args_json ? 'build') AS has_build_selector,
       (args_json IS NULL) AS args_null,
       count(*) AS n, min(invoked_at) AS first_at, max(invoked_at) AS last_at
  FROM harness_shared.tool_invocations
 WHERE workspace_id = 'papercusp-workspace'
   AND tool_name = 'release:repair-queue'
   AND invoked_at >= '2026-10-27T04:06:00Z'
 GROUP BY 2, 3, 4 ORDER BY 5 DESC;
