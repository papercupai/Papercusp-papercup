-- FROZEN ORACLE (plan papercusp-performance-audit-2026-10-12, P-005 / D-002).
-- The unanswered-directed roster statement as it stood before the ask-driven rewrite
-- (the roster_authored form from WI-6853 / WI-6875), captured verbatim from
-- fetchUnansweredDirected on 2026-10-12 with its SQL comments stripped. Do not edit it:
-- unanswered-directed-query-plan.integration.test.ts runs it beside the current
-- statement and requires identical rows. Parameters, in order:
--   $1 workspace, $2 $3 recipient ids, $4 since (ms), $5 workspace, $6 $7 recipient ids,
--   $8 satisfied expectEffect msg ids, $9 since (ms), $10 machine-sender pattern,
--   $11-$13 sender cap, $14-$17 newest cap.
    WITH roster_authored AS MATERIALIZED (
      SELECT ra.id,
             ra.workspace_id,
             CASE
               WHEN ra.body->>'from' LIKE 'system:%'
                AND strpos(ra.body->>'from', '/') > 0
               THEN substr(ra.body->>'from', strpos(ra.body->>'from', '/') + 1)
               ELSE ra.body->>'from'
             END                           AS from_id,
             ra.body->>'msg_id'            AS msg_id,
             ra.body->>'related_msg_id'    AS related_msg_id,
             ra.body->'why'->>'goalRef'    AS goal_ref,
             ra.body ? 'related_msg_id'    AS has_related,
             ra.body->'to'                 AS to_arr,
             (ra.body->>'ts')::timestamptz AS ts,
             (extract(epoch FROM (ra.body->>'ts')::timestamptz) * 1000)::bigint AS ts_ms
        FROM harness_shared.coord_event_log ra
       WHERE ra.workspace_id = $1
         AND ra.surface = 'messages'
         AND (
           ra.body->>'from' = ANY($2::text[])
           OR (
             ra.body->>'from' LIKE 'system:%'
             AND strpos(ra.body->>'from', '/') > 0
             AND substr(ra.body->>'from', strpos(ra.body->>'from', '/') + 1)
                   = ANY($3::text[])
           )
         )
    ),
    loose_replies AS MATERIALIZED (
      SELECT DISTINCT ra.id,
             ra.workspace_id,
             ra.from_id,
             rt AS to_id,
             (extract(epoch FROM ra.ts) * 1000)::bigint AS ts_ms
        FROM roster_authored ra
        CROSS JOIN LATERAL jsonb_array_elements_text(ra.to_arr) AS rt
       WHERE NOT ra.has_related
         AND jsonb_typeof(ra.to_arr) = 'array'
         AND ra.ts >= to_timestamp($4::double precision / 1000)
    ),
    directed AS (
      SELECT
        e.id AS event_id,
        e.workspace_id,
        e.body->>'msg_id' AS msg_id,
        e.body->>'from' AS from_id,
        e.body->>'summary' AS summary,
        e.body->'why'->>'goalRef' AS goal_ref,
        (extract(epoch FROM (e.body->>'ts')::timestamptz) * 1000)::bigint AS ts_ms,
        r AS recipient
        FROM harness_shared.coord_event_log e
        CROSS JOIN LATERAL jsonb_array_elements_text(e.body->'to') AS r
       WHERE e.workspace_id = $5
         AND e.surface = 'messages'
         AND e.body->'to' ?| $6::text[]
         AND (e.body->>'kind' IS NULL OR e.body->>'kind' = 'message')
         AND NOT (e.body ? 'audience')
         AND jsonb_typeof(e.body->'to') = 'array'
         AND r = ANY($7::text[])
         AND e.body->>'from' IS DISTINCT FROM r
         AND (e.body->>'msg_id' IS NULL OR NOT (e.body->>'msg_id' = ANY($8::text[])))
         AND (e.body->>'ts')::timestamptz >= to_timestamp($9::double precision / 1000)
         AND (e.body->>'expectsReply') = 'true'
         AND ((e.body->>'expects') IS DISTINCT FROM 'none'
              OR e.body->>'lifecycle' = 'release_request')
         AND ((e.body->>'auto') IS DISTINCT FROM 'true'
              OR e.body->>'lifecycle' = 'release_request')
         AND NOT (e.body->>'from' ~ $10)
         AND NOT (
           e.body ? 'related_msg_id'
           AND (e.body->>'expects') IS DISTINCT FROM 'action'
           AND (e.body->>'expects') IS DISTINCT FROM 'answer'
           AND EXISTS (
             SELECT 1 FROM roster_authored ra
              WHERE ra.workspace_id = e.workspace_id
                AND ra.msg_id = e.body->>'related_msg_id'
                AND ra.from_id = r
           )
         )
    ),
    answered_goal_clusters AS MATERIALIZED (
      SELECT DISTINCT d.workspace_id,
             d.recipient,
             d.from_id,
             d.goal_ref,
             ra.ts_ms AS reply_ts_ms,
             ra.id AS reply_event_id
        FROM directed d
        JOIN roster_authored ra
          ON ra.workspace_id = d.workspace_id
         AND ra.from_id = d.recipient
         AND ra.related_msg_id = d.msg_id
       WHERE d.goal_ref IS NOT NULL
         AND ra.goal_ref = d.goal_ref
    ),
    open_asks AS (
      SELECT d.*,
             row_number() OVER (
               PARTITION BY d.recipient, d.from_id ORDER BY d.ts_ms DESC, d.msg_id DESC
             ) AS ask_rank
        FROM directed d
       WHERE NOT EXISTS (
         SELECT 1 FROM roster_authored ra
          WHERE ra.workspace_id = d.workspace_id
            AND ra.from_id = d.recipient
            AND ra.related_msg_id = d.msg_id
       )
         AND NOT EXISTS (
           SELECT 1 FROM answered_goal_clusters agc
            WHERE agc.workspace_id = d.workspace_id
              AND agc.recipient = d.recipient
              AND agc.from_id = d.from_id
              AND agc.goal_ref = d.goal_ref
              AND (
                agc.reply_ts_ms > d.ts_ms
                OR (agc.reply_ts_ms = d.ts_ms AND agc.reply_event_id >= d.event_id)
              )
         )
    ),
    unanswered AS (
      SELECT o.* FROM open_asks o
       WHERE (
         SELECT count(*) FROM loose_replies lr
          WHERE lr.workspace_id = o.workspace_id
            AND lr.from_id = o.recipient
            AND lr.to_id = o.from_id
            AND lr.ts_ms >= o.ts_ms
       ) < o.ask_rank
    ),
    per_sender AS (
      SELECT recipient, from_id AS sender, count(*)::bigint AS scnt, min(ts_ms) AS soldest
        FROM unanswered
       GROUP BY recipient, from_id
    ),
    sender_rollup AS (
      SELECT recipient,
             count(*)::bigint AS sender_total,
             (array_agg(sender ORDER BY scnt DESC, sender))[1:$11] AS sender_ids,
             (array_agg(scnt ORDER BY scnt DESC, sender))[1:$12] AS sender_cnts,
             (array_agg(soldest ORDER BY scnt DESC, sender))[1:$13] AS sender_oldest_ts_ms
        FROM per_sender
       GROUP BY recipient
    )
    SELECT u.recipient,
           count(*) AS cnt,
           min(u.ts_ms) AS oldest_ts_ms,
           (array_agg(u.msg_id ORDER BY u.ts_ms DESC))[1:$14] AS newest_ids,
           (array_agg(u.from_id ORDER BY u.ts_ms DESC))[1:$15] AS newest_from,
           (array_agg(u.summary ORDER BY u.ts_ms DESC))[1:$16] AS newest_summary,
           (array_agg(u.ts_ms ORDER BY u.ts_ms DESC))[1:$17] AS newest_ts_ms,
           sr.sender_total,
           sr.sender_ids,
           sr.sender_cnts,
           sr.sender_oldest_ts_ms
      FROM unanswered u
      JOIN sender_rollup sr ON sr.recipient = u.recipient
     GROUP BY u.recipient, sr.sender_total, sr.sender_ids, sr.sender_cnts, sr.sender_oldest_ts_ms
