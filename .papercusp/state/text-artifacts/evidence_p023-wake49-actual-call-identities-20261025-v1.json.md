---
rel_path: "evidence/p023-wake49-actual-call-identities-20261025-v1.json"
updated_at: 1792890786735
_body: "content"
---

{
  "query": {
    "sql": "SELECT id,invoked_at,args_json->>'validateOnly' AS validate_only,args_json->>'recordOnly' AS record_only,args_json->>'state' AS state,metadata_json #>> '{otel,callId}' AS call_id,left(error_message,250) AS error FROM harness_shared.tool_invocations WHERE workspace_id='papercusp-workspace' AND id IN (43962260,44101604,44101944) ORDER BY id",
    "allowUnscoped": false,
    "maxRows": 5,
    "timeoutMs": 10000
  },
  "result": {
    "advisory": "ⓘ a tool covers this read: activity:tool-log / dev:telemetry / dev:tool_cooccurrence — per-tool rollups (count, error rate, p50/p95) and the compact per-session call log. Raw SQL stays correct for genuinely ad-hoc analysis (a join, a group-by, a one-off slice); this fired because the query is a plain single-table read.",
    "mode": "query",
    "rowCount": 3,
    "truncated": false,
    "fields": [
      "id",
      "invoked_at",
      "validate_only",
      "record_only",
      "state",
      "call_id",
      "error"
    ],
    "elapsedMs": 29,
    "rows": [
      {
        "id": "43962260",
        "invoked_at": "2026-10-24 06:37:15.422+00",
        "validate_only": null,
        "record_only": null,
        "state": "done",
        "call_id": "zbm7q3-184",
        "error": "REJECTED — 2 completion requirements for WI-6554700010020287 are unmet. This is the COMPLETE set as evaluated on this call, not just the first failure: fix all of them and re-send once. No completion record or state transition was written.\n\n(1/2) ref"
      },
      {
        "id": "44101604",
        "invoked_at": "2026-10-24 18:33:52.776+00",
        "validate_only": null,
        "record_only": null,
        "state": "done",
        "call_id": "mn3kjm-g",
        "error": null
      },
      {
        "id": "44101944",
        "invoked_at": "2026-10-24 18:35:54.317+00",
        "validate_only": null,
        "record_only": null,
        "state": "done",
        "call_id": "mn3kjm-y",
        "error": null
      }
    ]
  }
}
