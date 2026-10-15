---
rel_path: "audits/parked-agent-resumption-2026-10-09/fire47-two-owner-bounded-mcp-read-20261014-424d5.json"
updated_at: 1792017101255
_body: "content"
---

{
  "schemaVersion": "parked-fire47-two-owner-bounded-mcp-read-v1",
  "workItem": "WI-6554700010008887",
  "args": {
    "sql": "SELECT id::text, coord_owner_id, invoked_at, tool_name, status, args_json, output_ref FROM harness_shared.tool_invocations WHERE workspace_id = 'papercusp-workspace' AND coord_owner_id IN ('su-298f8b56-c687-404f-99e1-d1c1e53baf0c','su-fc5749a7-6632-4f73-9c99-8b475641e7e2') AND invoked_at >= '2026-10-10T01:09:46.552Z' AND invoked_at <= '2026-10-10T16:00:36.515Z' AND tool_name IN ('work_items:claim','work_items:create','work_items:release','work_items:set_state','work_items:complete','coord:declare-intent','loop:end','fleet:kill','coord:handoff','coord:dispatch','mode:set') ORDER BY invoked_at, id",
    "maxRows": 100,
    "timeoutMs": 5000,
    "allowUnscoped": false,
    "allowUnboundedJsonSearch": false
  },
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"advisory\":\"⚠ single-agent activity read: harness_shared.tool_invocations records MCP calls ONLY, so this window is NOT \\\"everything this agent did\\\" — native Claude Code Bash/Read/Grep/Edit produce no row at all, and this box's bypass-permissions preamble actively steers agents to native Bash for reads. Measured over ingested transcript parts (24h): native 54,009 calls across 183 agents vs MCP 35,479 across 128, so ~60% of recorded tool use is invisible here. The error is DIRECTIONAL — missing rows can only make an agent look LESS active, so a sparse or empty window reads as \\\"idle\\\" and escalates into waking, accusing or reassigning a peer who was working (EI-21847759967934033: this ledger showed one agent making only coord:glance / activity:report while it was in fact running Bash the whole time). THE RULE: positive rows prove activity; absence here proves nothing. To look for the missing half, start with `activity:tool-log { owner: '<the coord ownerId>' }` — it reads harness_shared.agent_activity, which DOES record native calls, and renders the command text. But do not invert the error onto it: that store is empty for ~45% of agents (24h: 182 of 333 tool_invocations owners had any rows), so an empty tool-log is equally not evidence of idleness. Corroborate with the transcript store, which is corpus-namespaced — workspace_id = 'default', NOT your tenant id: SELECT ts, tool_name, text FROM harness_shared.session_turn_parts WHERE workspace_id = 'default' AND owner = '<the coord ownerId>' AND ts > now() - interval '30 minutes' ORDER BY ts DESC LIMIT 50. `owner` is the coord ownerId and `text` is the faithful-render payload column, so both take the same id you scoped this query with. ⚠ absence unverified: rowCount is 0 and no positiveControlSql was run. Re-run with a known-positive SELECT through the same table/scope/instrument before treating this as evidence of absence. ⓘ a tool covers this read: activity:tool-log / dev:telemetry / dev:tool_cooccurrence — per-tool rollups (count, error rate, p50/p95) and the compact per-session call log. Raw SQL stays correct for genuinely ad-hoc analysis (a join, a group-by, a one-off slice); this fired because the query is a plain single-table read.\",\"mode\":\"query\",\"rowCount\":0,\"truncated\":false,\"fields\":[],\"elapsedMs\":237,\"rows\":[],\"absence\":{\"status\":\"unverified\",\"code\":\"positive-control-not-run\"}}"
      },
      {
        "type": "text",
        "text": "See also: work_items:claimable; plans:list; db:migrations; testing:runs; issues:list / work_items:get; dev:pg_active_queries; dev:pg_table_sizes; dev:pg_health"
      },
      {
        "type": "text",
        "text": "See also: tools:find (discover a tool by intent — returns names + schemas, and activates them where supported)"
      }
    ]
  },
  "limit": "Zero retained MCP rows is unverified absence and proves no inactivity; native/source transcript history still needed."
}
