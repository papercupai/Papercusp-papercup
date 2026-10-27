---
rel_path: "evidence/p023-wake49-completion-census-20261025-v2.json"
updated_at: 1792890652496
_body: "content"
---

{
  "cutoff": "2026-10-25T01:07:49Z",
  "sql": "WITH calls AS (SELECT id,invoked_at,duration_ms,coord_owner_id,harness_slug,status,args_json,output_ref,error_message,metadata_json #>> '{kernel,enforce,serverAudit,identityLaunchRecord,advSessionId}' AS adv_session_id FROM harness_shared.tool_invocations WHERE workspace_id='papercusp-workspace' AND tool_name='work_items:complete' AND invoked_at>='2026-10-22T00:00:00Z'::timestamptz AND invoked_at<'2026-10-25T01:07:49Z'::timestamptz), cells AS (SELECT CASE WHEN args_json IS NULL THEN 'null-arguments' WHEN coalesce(args_json->>'_truncated','false')='true' THEN 'truncated-arguments' WHEN jsonb_typeof(args_json->'id')='string' AND jsonb_typeof(args_json->'items')='array' THEN 'mixed-target-envelope' WHEN jsonb_typeof(args_json->'id')='string' THEN 'single-target-envelope' WHEN jsonb_typeof(args_json->'items')='array' THEN 'bulk-target-envelope' ELSE 'unknown-target-shape' END AS cell,count(*) AS n FROM calls GROUP BY 1), targets AS (SELECT c.*,args_json AS target_args FROM calls c WHERE jsonb_typeof(args_json->'id')='string' UNION ALL SELECT c.*,t.args FROM calls c CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(c.args_json->'items')='array' THEN c.args_json->'items' ELSE '[]'::jsonb END)t(args)), matches AS (SELECT id,invoked_at,duration_ms,coord_owner_id,harness_slug,status,output_ref,left(error_message,220) AS error_excerpt,target_args->>'id' AS target_id,coalesce(target_args->>'validateOnly',args_json->>'validateOnly','false') AS validate_only,coalesce(target_args->>'recordOnly',args_json->>'recordOnly','false') AS record_only,coalesce(target_args->>'state',args_json->>'state') AS requested_state,adv_session_id FROM targets WHERE target_args->>'id'=ANY(ARRAY['WI-6554700010020287','WI-2039882','WI-2144482','WI-6554700010020422','WI-6554700010020423','WI-2039884','WI-6554700010020424','WI-2039885','WI-2039889','WI-2039890'])),unknown AS (SELECT id,invoked_at,duration_ms,coord_owner_id,adv_session_id,args_json FROM calls WHERE args_json IS NULL OR coalesce(args_json->>'_truncated','false')='true' OR (jsonb_typeof(args_json->'id') IS DISTINCT FROM 'string' AND jsonb_typeof(args_json->'items') IS DISTINCT FROM 'array')) SELECT (SELECT count(*) FROM calls) AS total_calls,(SELECT jsonb_agg(to_jsonb(cells)) FROM cells) AS cells,(SELECT jsonb_agg(to_jsonb(matches) ORDER BY invoked_at) FROM matches) AS matches,(SELECT jsonb_agg(to_jsonb(unknown) ORDER BY invoked_at) FROM unknown) AS unknown",
  "result": {
    "mode": "query",
    "rowCount": 1,
    "truncated": false,
    "fields": [
      "total_calls",
      "cells",
      "matches",
      "unknown"
    ],
    "elapsedMs": 7409,
    "rows": [
      {
        "total_calls": "2468",
        "cells": [
          {
            "n": 8,
            "cell": "truncated-arguments"
          },
          {
            "n": 2321,
            "cell": "single-target-envelope"
          },
          {
            "n": 74,
            "cell": "null-arguments"
          },
          {
            "n": 65,
            "cell": "bulk-target-envelope"
          }
        ],
        "matches": [
          {
            "id": 43947572,
            "status": "ok",
            "target_id": "WI-6554700010020287",
            "invoked_at": "2026-10-24T06:00:38.248+00:00",
            "output_ref": null,
            "duration_ms": 3868,
            "record_only": "false",
            "harness_slug": "papercusp",
            "error_excerpt": "REJECTED — 2 completion requirements for WI-6554700010020287 are unmet. This is the COMPLETE set as evaluated on this call, not just the first failure: fix all of them and re-send once. No completion record or state tran",
            "validate_only": "true",
            "adv_session_id": "48932",
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3",
            "requested_state": "done"
          },
          {
            "id": 43956890,
            "status": "ok",
            "target_id": "WI-6554700010020287",
            "invoked_at": "2026-10-24T06:24:46.088+00:00",
            "output_ref": "papercusp://scratch/papercusp-workspace/work_items:complete/65a23d35-8d37-4d3c-ac2f-710afb88600c/result-door-1792823086090.md",
            "duration_ms": 2448,
            "record_only": "false",
            "harness_slug": "papercusp",
            "error_excerpt": "REJECTED — 2 completion requirements for WI-6554700010020287 are unmet. This is the COMPLETE set as evaluated on this call, not just the first failure: fix all of them and re-send once. No completion record or state tran",
            "validate_only": "true",
            "adv_session_id": "48932",
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3",
            "requested_state": "done"
          },
          {
            "id": 43962260,
            "status": "ok",
            "target_id": "WI-6554700010020287",
            "invoked_at": "2026-10-24T06:37:15.422+00:00",
            "output_ref": "papercusp://scratch/papercusp-workspace/work_items:complete/cd9a69af-e5db-47f5-b43b-cb6d1173b0fb/result-door-1792823835423.md",
            "duration_ms": 38147,
            "record_only": "false",
            "harness_slug": "papercusp",
            "error_excerpt": "REJECTED — 2 completion requirements for WI-6554700010020287 are unmet. This is the COMPLETE set as evaluated on this call, not just the first failure: fix all of them and re-send once. No completion record or state tran",
            "validate_only": "false",
            "adv_session_id": "48932",
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3",
            "requested_state": "done"
          },
          {
            "id": 43973339,
            "status": "ok",
            "target_id": "WI-6554700010020287",
            "invoked_at": "2026-10-24T07:03:35.573+00:00",
            "output_ref": null,
            "duration_ms": 8485,
            "record_only": "false",
            "harness_slug": "papercusp",
            "error_excerpt": "Name a mapped requirement in completion.discharges or completion.contributesTo.",
            "validate_only": "true",
            "adv_session_id": "48932",
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3",
            "requested_state": "done"
          },
          {
            "id": 43974161,
            "status": "ok",
            "target_id": "WI-6554700010020287",
            "invoked_at": "2026-10-24T07:06:05.315+00:00",
            "output_ref": null,
            "duration_ms": 78854,
            "record_only": "false",
            "harness_slug": "papercusp",
            "error_excerpt": "Executable checks for discharged requirements must have passing recorded results.",
            "validate_only": "true",
            "adv_session_id": "48932",
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3",
            "requested_state": "done"
          },
          {
            "id": 43976610,
            "status": "ok",
            "target_id": "WI-6554700010020287",
            "invoked_at": "2026-10-24T07:13:33.9+00:00",
            "output_ref": null,
            "duration_ms": 26783,
            "record_only": "false",
            "harness_slug": "papercusp",
            "error_excerpt": "Executable checks for discharged requirements must have passing recorded results.",
            "validate_only": "true",
            "adv_session_id": "48932",
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3",
            "requested_state": "done"
          },
          {
            "id": 43989857,
            "status": "ok",
            "target_id": "WI-6554700010020287",
            "invoked_at": "2026-10-24T07:42:32.145+00:00",
            "output_ref": null,
            "duration_ms": 3388,
            "record_only": "false",
            "harness_slug": "papercusp",
            "error_excerpt": "Executable checks for discharged requirements must have passing recorded results.",
            "validate_only": "true",
            "adv_session_id": "48932",
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3",
            "requested_state": "done"
          },
          {
            "id": 44023255,
            "status": "ok",
            "target_id": "WI-6554700010020287",
            "invoked_at": "2026-10-24T09:03:01.299+00:00",
            "output_ref": null,
            "duration_ms": 3546,
            "record_only": "false",
            "harness_slug": "papercusp",
            "error_excerpt": "frozen_tests_red_calibration_missing_or_wrong_bytes",
            "validate_only": "true",
            "adv_session_id": "48932",
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3",
            "requested_state": "done"
          },
          {
            "id": 44051371,
            "status": "ok",
            "target_id": "WI-6554700010020287",
            "invoked_at": "2026-10-24T15:10:34.315+00:00",
            "output_ref": null,
            "duration_ms": 47835,
            "record_only": "false",
            "harness_slug": "papercusp",
            "error_excerpt": "Executable checks for discharged requirements must have passing recorded results.",
            "validate_only": "true",
            "adv_session_id": "51492",
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3",
            "requested_state": "done"
          },
          {
            "id": 44052465,
            "status": "ok",
            "target_id": "WI-6554700010020287",
            "invoked_at": "2026-10-24T15:13:52.328+00:00",
            "output_ref": null,
            "duration_ms": 42784,
            "record_only": "false",
            "harness_slug": "papercusp",
            "error_excerpt": "Executable checks for discharged requirements must have passing recorded results.",
            "validate_only": "true",
            "adv_session_id": "51492",
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3",
            "requested_state": "done"
          },
          {
            "id": 44100620,
            "status": "ok",
            "target_id": "WI-6554700010020287",
            "invoked_at": "2026-10-24T18:28:23.564+00:00",
            "output_ref": null,
            "duration_ms": 10043,
            "record_only": "false",
            "harness_slug": "papercusp",
            "error_excerpt": "REJECTED — WI-6554700010020287 declares change kind(s) logic, test-only, but this close does not carry the proof they require; the item stays open.\n- `kindEvidence` carries proof for 'background-job', which is not declar",
            "validate_only": "true",
            "adv_session_id": "51492",
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3",
            "requested_state": "done"
          },
          {
            "id": 44100903,
            "status": "ok",
            "target_id": "WI-6554700010020287",
            "invoked_at": "2026-10-24T18:30:11.87+00:00",
            "output_ref": null,
            "duration_ms": 9198,
            "record_only": "false",
            "harness_slug": "papercusp",
            "error_excerpt": null,
            "validate_only": "true",
            "adv_session_id": "51492",
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3",
            "requested_state": "done"
          },
          {
            "id": 44101604,
            "status": "ok",
            "target_id": "WI-6554700010020287",
            "invoked_at": "2026-10-24T18:33:52.776+00:00",
            "output_ref": null,
            "duration_ms": 13082,
            "record_only": "false",
            "harness_slug": "papercusp",
            "error_excerpt": null,
            "validate_only": "false",
            "adv_session_id": "51492",
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3",
            "requested_state": "done"
          },
          {
            "id": 44101864,
            "status": "ok",
            "target_id": "WI-6554700010020287",
            "invoked_at": "2026-10-24T18:35:29.008+00:00",
            "output_ref": null,
            "duration_ms": 8303,
            "record_only": "false",
            "harness_slug": "papercusp",
            "error_excerpt": null,
            "validate_only": "true",
            "adv_session_id": "51492",
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3",
            "requested_state": "done"
          },
          {
            "id": 44101944,
            "status": "ok",
            "target_id": "WI-6554700010020287",
            "invoked_at": "2026-10-24T18:35:54.317+00:00",
            "output_ref": null,
            "duration_ms": 9111,
            "record_only": "false",
            "harness_slug": "papercusp",
            "error_excerpt": null,
            "validate_only": "false",
            "adv_session_id": "51492",
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3",
            "requested_state": "done"
          }
        ],
        "unknown": [
          {
            "id": 42659684,
            "args_json": null,
            "invoked_at": "2026-10-22T00:12:55.626+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-260fa8b0-130c-4428-a95c-2af9cd98ed1b"
          },
          {
            "id": 42660116,
            "args_json": null,
            "invoked_at": "2026-10-22T00:14:19.275+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-260fa8b0-130c-4428-a95c-2af9cd98ed1b"
          },
          {
            "id": 42662626,
            "args_json": null,
            "invoked_at": "2026-10-22T00:22:13.04+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3"
          },
          {
            "id": 42662825,
            "args_json": null,
            "invoked_at": "2026-10-22T00:22:49.947+00:00",
            "duration_ms": 0,
            "adv_session_id": null,
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3"
          },
          {
            "id": 42663004,
            "args_json": null,
            "invoked_at": "2026-10-22T00:23:28.796+00:00",
            "duration_ms": 0,
            "adv_session_id": null,
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3"
          },
          {
            "id": 42667675,
            "args_json": null,
            "invoked_at": "2026-10-22T00:37:35.605+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-260fa8b0-130c-4428-a95c-2af9cd98ed1b"
          },
          {
            "id": 42667780,
            "args_json": null,
            "invoked_at": "2026-10-22T00:37:54.285+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-260fa8b0-130c-4428-a95c-2af9cd98ed1b"
          },
          {
            "id": 42668498,
            "args_json": null,
            "invoked_at": "2026-10-22T00:40:13.866+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3"
          },
          {
            "id": 42668631,
            "args_json": null,
            "invoked_at": "2026-10-22T00:40:44.176+00:00",
            "duration_ms": 0,
            "adv_session_id": null,
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3"
          },
          {
            "id": 42678684,
            "args_json": null,
            "invoked_at": "2026-10-22T01:12:13.808+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-260fa8b0-130c-4428-a95c-2af9cd98ed1b"
          },
          {
            "id": 42678893,
            "args_json": null,
            "invoked_at": "2026-10-22T01:12:50.782+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-260fa8b0-130c-4428-a95c-2af9cd98ed1b"
          },
          {
            "id": 42679080,
            "args_json": null,
            "invoked_at": "2026-10-22T01:13:20.961+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-260fa8b0-130c-4428-a95c-2af9cd98ed1b"
          },
          {
            "id": 42679203,
            "args_json": null,
            "invoked_at": "2026-10-22T01:13:43.727+00:00",
            "duration_ms": 0,
            "adv_session_id": null,
            "coord_owner_id": "su-260fa8b0-130c-4428-a95c-2af9cd98ed1b"
          },
          {
            "id": 42709223,
            "args_json": null,
            "invoked_at": "2026-10-22T02:57:52.799+00:00",
            "duration_ms": 0,
            "adv_session_id": null,
            "coord_owner_id": "su-6c30dac5-f3fb-4c45-937e-34ee5ed96cc2"
          },
          {
            "id": 42710240,
            "args_json": null,
            "invoked_at": "2026-10-22T03:00:53.918+00:00",
            "duration_ms": 0,
            "adv_session_id": null,
            "coord_owner_id": "su-6c30dac5-f3fb-4c45-937e-34ee5ed96cc2"
          },
          {
            "id": 42740243,
            "args_json": null,
            "invoked_at": "2026-10-22T04:43:57.757+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3"
          },
          {
            "id": 42740431,
            "args_json": null,
            "invoked_at": "2026-10-22T04:44:37.525+00:00",
            "duration_ms": 0,
            "adv_session_id": null,
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3"
          },
          {
            "id": 42748362,
            "args_json": null,
            "invoked_at": "2026-10-22T05:10:52.287+00:00",
            "duration_ms": 0,
            "adv_session_id": null,
            "coord_owner_id": "su-76e6595e-8210-4b3d-b784-421a673dda6d"
          },
          {
            "id": 42761633,
            "args_json": null,
            "invoked_at": "2026-10-22T05:51:29.415+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3"
          },
          {
            "id": 42761844,
            "args_json": null,
            "invoked_at": "2026-10-22T05:51:54.037+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3"
          },
          {
            "id": 42816792,
            "args_json": null,
            "invoked_at": "2026-10-22T08:11:23.432+00:00",
            "duration_ms": 2,
            "adv_session_id": null,
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3"
          },
          {
            "id": 42817003,
            "args_json": null,
            "invoked_at": "2026-10-22T08:11:49.562+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3"
          },
          {
            "id": 42817233,
            "args_json": null,
            "invoked_at": "2026-10-22T08:12:16.797+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3"
          },
          {
            "id": 42821594,
            "args_json": null,
            "invoked_at": "2026-10-22T08:25:08.914+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3"
          },
          {
            "id": 42821677,
            "args_json": null,
            "invoked_at": "2026-10-22T08:25:26.573+00:00",
            "duration_ms": 2,
            "adv_session_id": null,
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3"
          },
          {
            "id": 42839423,
            "args_json": null,
            "invoked_at": "2026-10-22T09:06:33.444+00:00",
            "duration_ms": 0,
            "adv_session_id": null,
            "coord_owner_id": "su-b3e9363f-3d37-4575-85fe-315ec2c8dc62"
          },
          {
            "id": 42839564,
            "args_json": null,
            "invoked_at": "2026-10-22T09:06:52.538+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-b3e9363f-3d37-4575-85fe-315ec2c8dc62"
          },
          {
            "id": 42839764,
            "args_json": null,
            "invoked_at": "2026-10-22T09:07:21.812+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-b3e9363f-3d37-4575-85fe-315ec2c8dc62"
          },
          {
            "id": 42865567,
            "args_json": null,
            "invoked_at": "2026-10-22T10:13:26.591+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-b3e9363f-3d37-4575-85fe-315ec2c8dc62"
          },
          {
            "id": 42866620,
            "args_json": null,
            "invoked_at": "2026-10-22T10:15:57.967+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-b3e9363f-3d37-4575-85fe-315ec2c8dc62"
          },
          {
            "id": 42867051,
            "args_json": null,
            "invoked_at": "2026-10-22T10:17:02.909+00:00",
            "duration_ms": 7,
            "adv_session_id": null,
            "coord_owner_id": "su-b3e9363f-3d37-4575-85fe-315ec2c8dc62"
          },
          {
            "id": 42882073,
            "args_json": null,
            "invoked_at": "2026-10-22T10:52:51.455+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-683eb783-a1be-42e1-871b-8aa330ae0088"
          },
          {
            "id": 42882356,
            "args_json": null,
            "invoked_at": "2026-10-22T10:53:34.951+00:00",
            "duration_ms": 2,
            "adv_session_id": null,
            "coord_owner_id": "su-683eb783-a1be-42e1-871b-8aa330ae0088"
          },
          {
            "id": 42882776,
            "args_json": null,
            "invoked_at": "2026-10-22T10:54:29.918+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-683eb783-a1be-42e1-871b-8aa330ae0088"
          },
          {
            "id": 42883537,
            "args_json": null,
            "invoked_at": "2026-10-22T10:55:46.207+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-683eb783-a1be-42e1-871b-8aa330ae0088"
          },
          {
            "id": 42905592,
            "args_json": null,
            "invoked_at": "2026-10-22T11:39:02.204+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-b3e9363f-3d37-4575-85fe-315ec2c8dc62"
          },
          {
            "id": 42906067,
            "args_json": null,
            "invoked_at": "2026-10-22T11:40:06.216+00:00",
            "duration_ms": 0,
            "adv_session_id": null,
            "coord_owner_id": "su-b3e9363f-3d37-4575-85fe-315ec2c8dc62"
          },
          {
            "id": 42910868,
            "args_json": null,
            "invoked_at": "2026-10-22T11:51:29.052+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-f71daefd-a45f-4562-b327-97b48cdce740"
          },
          {
            "id": 42911096,
            "args_json": null,
            "invoked_at": "2026-10-22T11:52:03.703+00:00",
            "duration_ms": 0,
            "adv_session_id": null,
            "coord_owner_id": "su-f71daefd-a45f-4562-b327-97b48cdce740"
          },
          {
            "id": 42911270,
            "args_json": null,
            "invoked_at": "2026-10-22T11:52:26.016+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-f71daefd-a45f-4562-b327-97b48cdce740"
          },
          {
            "id": 42951749,
            "args_json": null,
            "invoked_at": "2026-10-22T13:12:31.622+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-f71daefd-a45f-4562-b327-97b48cdce740"
          },
          {
            "id": 42951897,
            "args_json": null,
            "invoked_at": "2026-10-22T13:12:51.484+00:00",
            "duration_ms": 0,
            "adv_session_id": null,
            "coord_owner_id": "su-f71daefd-a45f-4562-b327-97b48cdce740"
          },
          {
            "id": 42957302,
            "args_json": null,
            "invoked_at": "2026-10-22T13:23:02.974+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-c6c4e5f3-f42b-41a8-9eb6-98ed4484dbd5"
          },
          {
            "id": 42974944,
            "args_json": null,
            "invoked_at": "2026-10-22T14:09:25.363+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3"
          },
          {
            "id": 42978334,
            "args_json": null,
            "invoked_at": "2026-10-22T14:17:47.885+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-c6c4e5f3-f42b-41a8-9eb6-98ed4484dbd5"
          },
          {
            "id": 42978805,
            "args_json": null,
            "invoked_at": "2026-10-22T14:18:50.461+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3"
          },
          {
            "id": 42985699,
            "args_json": null,
            "invoked_at": "2026-10-22T14:36:16.686+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-c6c4e5f3-f42b-41a8-9eb6-98ed4484dbd5"
          },
          {
            "id": 43033942,
            "args_json": null,
            "invoked_at": "2026-10-22T16:15:17.606+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-4a84c93a-e530-450c-b01e-8beb7bdc670f"
          },
          {
            "id": 43049733,
            "args_json": {
              "_size": 39073,
              "_truncated": true
            },
            "invoked_at": "2026-10-22T16:52:26.641+00:00",
            "duration_ms": 30,
            "adv_session_id": "49590",
            "coord_owner_id": "su-16a7fa38-f716-426a-b1d3-3e0a10871c85"
          },
          {
            "id": 43049889,
            "args_json": {
              "_size": 38772,
              "_truncated": true
            },
            "invoked_at": "2026-10-22T16:52:50.806+00:00",
            "duration_ms": 452,
            "adv_session_id": "49590",
            "coord_owner_id": "su-16a7fa38-f716-426a-b1d3-3e0a10871c85"
          },
          {
            "id": 43084001,
            "args_json": null,
            "invoked_at": "2026-10-22T18:10:16.109+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-5eff8f7c-61ef-450d-adc5-38eea5157740"
          },
          {
            "id": 43084197,
            "args_json": null,
            "invoked_at": "2026-10-22T18:10:32.205+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-5eff8f7c-61ef-450d-adc5-38eea5157740"
          },
          {
            "id": 43087590,
            "args_json": {
              "_size": 145922,
              "_truncated": true
            },
            "invoked_at": "2026-10-22T18:17:08.971+00:00",
            "duration_ms": 408,
            "adv_session_id": "49590",
            "coord_owner_id": "su-16a7fa38-f716-426a-b1d3-3e0a10871c85"
          },
          {
            "id": 43089566,
            "args_json": {
              "_size": 62480,
              "_truncated": true
            },
            "invoked_at": "2026-10-22T18:21:34.851+00:00",
            "duration_ms": 1631,
            "adv_session_id": "42675",
            "coord_owner_id": "su-65ecc301-e683-4b7f-85ee-98c2871ef59f"
          },
          {
            "id": 43120571,
            "args_json": null,
            "invoked_at": "2026-10-22T19:35:34.229+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-dc2412ed-9732-4888-812e-8adc9e8039c9"
          },
          {
            "id": 43129675,
            "args_json": null,
            "invoked_at": "2026-10-22T20:01:39.794+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-51f4af3d-894e-4e73-9f33-8e96b7aea369"
          },
          {
            "id": 43130167,
            "args_json": null,
            "invoked_at": "2026-10-22T20:02:32.103+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-aab8f48a-04ba-4b18-9aaa-58474a489db3"
          },
          {
            "id": 43130115,
            "args_json": null,
            "invoked_at": "2026-10-22T20:02:41.459+00:00",
            "duration_ms": 0,
            "adv_session_id": null,
            "coord_owner_id": "su-51f4af3d-894e-4e73-9f33-8e96b7aea369"
          },
          {
            "id": 43130846,
            "args_json": null,
            "invoked_at": "2026-10-22T20:04:23.502+00:00",
            "duration_ms": 3,
            "adv_session_id": null,
            "coord_owner_id": "su-51f4af3d-894e-4e73-9f33-8e96b7aea369"
          },
          {
            "id": 43131422,
            "args_json": null,
            "invoked_at": "2026-10-22T20:05:19.533+00:00",
            "duration_ms": 3,
            "adv_session_id": null,
            "coord_owner_id": "su-56361318-8122-4c67-be9f-325d9f4f8bf0"
          },
          {
            "id": 43133178,
            "args_json": null,
            "invoked_at": "2026-10-22T20:09:07.074+00:00",
            "duration_ms": 9,
            "adv_session_id": null,
            "coord_owner_id": "su-56361318-8122-4c67-be9f-325d9f4f8bf0"
          },
          {
            "id": 43134177,
            "args_json": null,
            "invoked_at": "2026-10-22T20:10:54.314+00:00",
            "duration_ms": 0,
            "adv_session_id": null,
            "coord_owner_id": "su-56361318-8122-4c67-be9f-325d9f4f8bf0"
          },
          {
            "id": 43136135,
            "args_json": null,
            "invoked_at": "2026-10-22T20:14:54.41+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-aab8f48a-04ba-4b18-9aaa-58474a489db3"
          },
          {
            "id": 43145182,
            "args_json": null,
            "invoked_at": "2026-10-22T20:35:39.275+00:00",
            "duration_ms": 2,
            "adv_session_id": null,
            "coord_owner_id": "su-aab8f48a-04ba-4b18-9aaa-58474a489db3"
          },
          {
            "id": 43158078,
            "args_json": null,
            "invoked_at": "2026-10-22T21:03:03.324+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-c5ca4868-c4df-43ab-86e1-f4bb9c726ff7"
          },
          {
            "id": 43158361,
            "args_json": null,
            "invoked_at": "2026-10-22T21:03:29.098+00:00",
            "duration_ms": 7,
            "adv_session_id": null,
            "coord_owner_id": "su-c5ca4868-c4df-43ab-86e1-f4bb9c726ff7"
          },
          {
            "id": 43162476,
            "args_json": null,
            "invoked_at": "2026-10-22T21:10:38.115+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-c5ca4868-c4df-43ab-86e1-f4bb9c726ff7"
          },
          {
            "id": 43196478,
            "args_json": null,
            "invoked_at": "2026-10-22T22:33:02.172+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-fdb30ece-9d04-4520-b353-459fdab74c4b"
          },
          {
            "id": 43212237,
            "args_json": null,
            "invoked_at": "2026-10-22T23:00:21.886+00:00",
            "duration_ms": 2,
            "adv_session_id": null,
            "coord_owner_id": "su-8f6cb08e-e1a1-4893-84b4-95800b82eb0e"
          },
          {
            "id": 43213099,
            "args_json": null,
            "invoked_at": "2026-10-22T23:01:41.112+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-8f6cb08e-e1a1-4893-84b4-95800b82eb0e"
          },
          {
            "id": 43228272,
            "args_json": null,
            "invoked_at": "2026-10-22T23:32:41.749+00:00",
            "duration_ms": 7,
            "adv_session_id": null,
            "coord_owner_id": "su-12da384f-8b83-4dd0-8884-cd15f2cd6231"
          },
          {
            "id": 43228486,
            "args_json": null,
            "invoked_at": "2026-10-22T23:33:04.286+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-12da384f-8b83-4dd0-8884-cd15f2cd6231"
          },
          {
            "id": 43228678,
            "args_json": null,
            "invoked_at": "2026-10-22T23:33:26.861+00:00",
            "duration_ms": 2,
            "adv_session_id": null,
            "coord_owner_id": "su-12da384f-8b83-4dd0-8884-cd15f2cd6231"
          },
          {
            "id": 43247296,
            "args_json": null,
            "invoked_at": "2026-10-23T00:12:53.671+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-611f037a-a3b8-460d-8e65-ea9801692de4"
          },
          {
            "id": 43247788,
            "args_json": null,
            "invoked_at": "2026-10-23T00:13:45.143+00:00",
            "duration_ms": 12,
            "adv_session_id": null,
            "coord_owner_id": "su-611f037a-a3b8-460d-8e65-ea9801692de4"
          },
          {
            "id": 43247966,
            "args_json": null,
            "invoked_at": "2026-10-23T00:14:03.962+00:00",
            "duration_ms": 0,
            "adv_session_id": null,
            "coord_owner_id": "su-611f037a-a3b8-460d-8e65-ea9801692de4"
          },
          {
            "id": 43249714,
            "args_json": null,
            "invoked_at": "2026-10-23T00:16:52.431+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-611f037a-a3b8-460d-8e65-ea9801692de4"
          },
          {
            "id": 43250839,
            "args_json": null,
            "invoked_at": "2026-10-23T00:18:36.372+00:00",
            "duration_ms": 1,
            "adv_session_id": null,
            "coord_owner_id": "su-611f037a-a3b8-460d-8e65-ea9801692de4"
          },
          {
            "id": 43713967,
            "args_json": {
              "_size": 40759,
              "_truncated": true
            },
            "invoked_at": "2026-10-23T20:14:01.833+00:00",
            "duration_ms": 23,
            "adv_session_id": "49590",
            "coord_owner_id": "su-16a7fa38-f716-426a-b1d3-3e0a10871c85"
          },
          {
            "id": 43714629,
            "args_json": {
              "_size": 40176,
              "_truncated": true
            },
            "invoked_at": "2026-10-23T20:15:28.483+00:00",
            "duration_ms": 3646,
            "adv_session_id": "49590",
            "coord_owner_id": "su-16a7fa38-f716-426a-b1d3-3e0a10871c85"
          },
          {
            "id": 43723089,
            "args_json": {
              "_size": 783724,
              "_truncated": true
            },
            "invoked_at": "2026-10-23T20:38:57.266+00:00",
            "duration_ms": 1031,
            "adv_session_id": "46622",
            "coord_owner_id": "su-35f7dfa1-063b-44b2-a2ab-283283a08979"
          },
          {
            "id": 43728057,
            "args_json": {
              "_size": 783435,
              "_truncated": true
            },
            "invoked_at": "2026-10-23T20:51:05.021+00:00",
            "duration_ms": 9327,
            "adv_session_id": "46622",
            "coord_owner_id": "su-35f7dfa1-063b-44b2-a2ab-283283a08979"
          }
        ]
      }
    ]
  }
}
