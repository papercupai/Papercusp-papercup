---
rel_path: "audits/parked-agent-resumption-2026-10-09/fire47-report-publication-readback-20261014-424d5.json"
updated_at: 1792017364642
_body: "content"
---

{
  "schemaVersion": "parked-fire47-report-publication-readback-v1",
  "request_key": "parked-fire47-final-two-count-custody-424d5-20261014-v1",
  "report_id": "rpt_3ee5d711-6f18-4f9b-b8ad-f090d36ab081",
  "source": "audits/parked-agent-resumption-2026-10-09/fire47-owner-report-20261014-424d5.md",
  "guiPath": "/reports?sel=rpt_3ee5d711-6f18-4f9b-b8ad-f090d36ab081",
  "publish": {
    "ok": true,
    "report_id": "rpt_3ee5d711-6f18-4f9b-b8ad-f090d36ab081",
    "request_key": "parked-fire47-final-two-count-custody-424d5-20261014-v1",
    "workspace_id": "papercusp-workspace",
    "title": "Parked-agent final cutoff custody: original count difference remains unresolved",
    "summary": "Original final presence checksum verified; two counts differ between snapshots but final work-item identities remain unestablished.",
    "kind": "audit",
    "subject": {
      "kind": "work_item",
      "ref": "WI-6554700010008887",
      "label": null
    },
    "origin": {
      "harness_slug": "papercusp",
      "author_owner_id": "su-424d5476-0b13-401a-a926-0aaa9f212391",
      "author_session_ref": "662895a2-63f4-4ed9-b75b-08d55284c681"
    },
    "visibility": "owner",
    "supersedes_report_id": null,
    "lineage_id": "rpt_3ee5d711-6f18-4f9b-b8ad-f090d36ab081",
    "source": "agent",
    "tags": [
      "parked-agent",
      "historical-custody"
    ],
    "published_at": "2026-10-14T22:32:35.129Z",
    "updated_at": "2026-10-14T22:32:35.129Z",
    "retired_at": null,
    "path": "/reports?sel=rpt_3ee5d711-6f18-4f9b-b8ad-f090d36ab081",
    "body_bytes": 1759,
    "body_sha256": "1c6dcc503426f9676fb134dc7360666be11bb92e7da715290e888af92ec79e8b",
    "goal_owner_report": null,
    "event_emitted": true
  },
  "readback": {
    "ok": true,
    "results": [
      {
        "ok": true,
        "id": "rpt_3ee5d711-6f18-4f9b-b8ad-f090d36ab081",
        "report": {
          "report_id": "rpt_3ee5d711-6f18-4f9b-b8ad-f090d36ab081",
          "workspace_id": "papercusp-workspace",
          "title": "Parked-agent final cutoff custody: original count difference remains unresolved",
          "summary": "Original final presence checksum verified; two counts differ between snapshots but final work-item identities remain unestablished.",
          "kind": "audit",
          "subject": {
            "kind": "work_item",
            "ref": "WI-6554700010008887",
            "label": null
          },
          "origin": {
            "harness_slug": "papercusp",
            "author_owner_id": "su-424d5476-0b13-401a-a926-0aaa9f212391",
            "author_session_ref": "662895a2-63f4-4ed9-b75b-08d55284c681"
          },
          "visibility": "owner",
          "supersedes_report_id": null,
          "lineage_id": "rpt_3ee5d711-6f18-4f9b-b8ad-f090d36ab081",
          "source": "agent",
          "tags": [
            "parked-agent",
            "historical-custody"
          ],
          "published_at": "2026-10-14T22:32:35.129Z",
          "updated_at": "2026-10-14T22:32:35.129Z",
          "retired_at": null,
          "path": "/reports/rpt_3ee5d711-6f18-4f9b-b8ad-f090d36ab081",
          "body_bytes": 1759,
          "body_md": "# Parked-agent cutoff review — 2026-10-14, Fire47\n\nThe original final presence file has been recovered and its SHA256 matches the frozen source: `633e47d809ba6f1b4b9c690c662a6b076b414c674ab465f65ee8fd7e56e1af27`.\n\n| Historical session | 01:09:46Z snapshot | 16:00:36.515Z snapshot |\n| --- | --- | --- |\n| su-298f8b56 | Three named work-items | claimCount 4; no serialized workItemClaims names |\n| su-fc5749a7 | Three named work-items | claimCount 4; no serialized workItemClaims names |\n\nThe committed count writer adds plan-claim and work-item arrays. Both final rows have an empty plan-claim array. This confirms a between-snapshot count difference; it does not identify a fourth work-item or establish final held authority, a legitimate wait, pickup, or preserved execution continuity.\n\nThe complete selected final source (4,821 characters) and assessment (3,180 characters) were saved and independently read back exactly under `audits/parked-agent-resumption-2026-10-09/`: `fire47-final-two-count-source-v2-20261014-424d5.json` and `fire47-two-cutoff-count-assessment-20261014-424d5.json`. The original source file is `.papercusp/scratch/park-audit/pres-full.json`.\n\nAll seven governing cases and whole-cohort eligibility remain open. Recovery outcomes remain unjoined. The next evidence step is original dated native/claim-lifecycle history for the two sessions, including the retained last-turn witnesses at 04:21:04.465Z and 14:43:38.968Z. The bounded MCP-only read returned no rows; that is unverified absence and proves no inactivity.\n\nA further transport reset was recorded on existing incident EI-25988128742965194 (comment 1181741). CLI recovery restored the read; root cause remains unresolved. No R14 census or terminal acceptance was claimed."
        }
      }
    ],
    "counts": {
      "ok": 1,
      "failed": 0
    }
  },
  "verification": {
    "exactBody": true,
    "chars": 1757,
    "visibility": "owner",
    "independentRead": true,
    "readRoute": "authenticated default proxy after3170 refused connection",
    "original3170Read": {
      "chunk_id": "3cb108",
      "wall_time_seconds": 19.749109573,
      "exit_code": 1,
      "original_token_count": 502,
      "output": "papercusp defineTool CLI (ptool): launcher\n/home/marsh-office/papercupai-workspace/papercusp/apps/operator/scripts/ptool.mjs\nptool: connection trace {\"schemaVersion\":\"ptool-connection-trace-v1\",\"traceId\":\"4dd88af8-26b1-4eb8-937e-042e26bd7afb\",\"operatorConnectSequence\":1,\"launcherSource\":\"cli-url-flag\",\"launcherScriptPath\":\"/home/marsh-office/papercupai-workspace/papercusp/apps/operator/scripts/ptool.mjs\",\"clientId\":\"su-424d5476-0b13-401a-a926-0aaa9f212391\",\"toolName\":\"reports:get\",\"candidateRoutes\":[{\"routeClass\":\"local-direct\",\"host\":\"127.0.0.1\",\"port\":3170,\"attemptTimeoutMs\":15000}],\"retryBudgetMs\":20000,\"primaryCandidateMaxAttempts\":21,\"fallbackCandidateMaxAttempts\":21,\"attemptedRoutes\":[],\"event\":\"operator-connect-start\",\"stage\":\"operator-connect\",\"phaseStartedAt\":\"2026-10-14T22:32:53.018Z\"}\nptool: connection trace {\"schemaVersion\":\"ptool-connection-trace-v1\",\"traceId\":\"4dd88af8-26b1-4eb8-937e-042e26bd7afb\",\"operatorConnectSequence\":1,\"launcherSource\":\"cli-url-flag\",\"launcherScriptPath\":\"/home/marsh-office/papercupai-workspace/papercusp/apps/operator/scripts/ptool.mjs\",\"clientId\":\"su-424d5476-0b13-401a-a926-0aaa9f212391\",\"toolName\":\"reports:get\",\"candidateRoutes\":[{\"routeClass\":\"local-direct\",\"host\":\"127.0.0.1\",\"port\":3170,\"attemptTimeoutMs\":15000}],\"retryBudgetMs\":20000,\"primaryCandidateMaxAttempts\":21,\"fallbackCandidateMaxAttempts\":21,\"attemptedRoutes\":[{\"routeClass\":\"local-direct\",\"host\":\"127.0.0.1\",\"port\":3170,\"attemptTimeoutMs\":15000,\"attempts\":14}],\"event\":\"operator-connect-failed\",\"stage\":\"mcp-initialize\",\"route\":{\"routeClass\":\"local-direct\",\"host\":\"127.0.0.1\",\"port\":3170,\"attemptTimeoutMs\":15000},\"phaseStartedAt\":\"2026-10-14T22:32:53.018Z\",\"elapsedMs\":19523,\"failureKind\":\"transport\",\"errorCode\":null}\nptool: could not reach the operator at http://127.0.0.1:3170 (fetch failed (cause: ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:3170)). Is the desktop/operator running? Override with PAPERCUSP_OPERATOR_URL or --url=. [14 connect attempt(s) over 19s: 14x transport]\n"
    }
  }
}
