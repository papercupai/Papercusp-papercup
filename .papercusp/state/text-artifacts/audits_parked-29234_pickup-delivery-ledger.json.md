---
rel_path: "audits/parked-29234/pickup-delivery-ledger.json"
updated_at: 1792985963599
_body: "content"
---

{
  "advisory": "⚠ corpus namespace, not a tenant: harness_shared.event_wake_deliveries stores every row under the literal workspace_id = 'default' (the session-transcript CORPUS namespace — see search/session-ingest.ts, which hardcodes it deliberately). This query filters it by 'papercusp-workspace', which matches ZERO rows out of a fully-populated table and returns a clean, confidence-inspiring empty result. This is the habit-driven form of the trap, so the warning fires BECAUSE the predicate is present: drop it, or write workspace_id = 'default'. To scope to a tenant here, filter on `owner` (the coord ownerId) instead — that is the column that actually identifies an agent. ⚠ absence unverified: rowCount is 0 and no positiveControlSql was run. Re-run with a known-positive SELECT through the same table/scope/instrument before treating this as evidence of absence.",
  "mode": "query",
  "rowCount": 0,
  "truncated": false,
  "fields": [],
  "elapsedMs": 231,
  "rows": [],
  "absence": {
    "status": "unverified",
    "code": "positive-control-not-run"
  },
  "_meta": {
    "explicitFullRequest": true,
    "format": "json",
    "_seeAlso": [
      {
        "tool": "work_items:claimable"
      },
      {
        "tool": "plans:list"
      },
      {
        "tool": "db:migrations"
      },
      {
        "tool": "testing:runs"
      },
      {
        "tool": "issues:list / work_items:get"
      },
      {
        "tool": "dev:pg_active_queries"
      },
      {
        "tool": "dev:pg_table_sizes"
      },
      {
        "tool": "dev:pg_health"
      }
    ]
  }
}
