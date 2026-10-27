---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/memory-dispatch-auth-20261026-r1/manifest.json"
updated_at: 1793044367388
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "WI-6554700010022135",
  "plan": "shared-search-restart-papercusp-2026-10-22",
  "item": "P-001",
  "testRunId": 22254994,
  "outcome": "pass",
  "passed": 7,
  "failed": 0,
  "skipped": 0,
  "harnessSlug": null,
  "worktreeDirty": true,
  "routerProvenance": "unknown",
  "testPath": "packages/operator-core/lib/agent-tools/memory/dispatch-source-freshness.integration.test.ts",
  "testSha256": "b345d48a6393aedfe79a8861f8583855c0f53a95979c8d20d51e67952a91f1d4",
  "witness": {
    "file": "witness.json",
    "chars": 146269,
    "bytes": 146421,
    "sha256": "b01dc189b0f10e68b82917e1e287708565e3788a880976cd5ec4e16b985949b8",
    "fullReadbackEqual": true,
    "sourcePins": 14,
    "receipts": 25,
    "unexecuted": []
  },
  "report": {
    "id": "rpt_6330ad77-1f5f-43a0-9450-c67a92947f40",
    "path": "/reports?sel=rpt_6330ad77-1f5f-43a0-9450-c67a92947f40",
    "visibility": "owner",
    "fullReadbackEqual": true
  },
  "newAcceptanceBinding": null,
  "fieldCurrentness": "unknown",
  "originalBinding": {
    "id": 71348,
    "testRunId": 22247225,
    "disposition": "preserved, contributing-only, overall currentness unknown"
  },
  "limits": [
    "private admin database connection shim; production RLS not exercised",
    "actual system bearer auth; host HTTP/cookie/spawn and PI auth open",
    "real default-user helper without ambient cookie; browser user binding open",
    "projected session harness and role are fixture inputs",
    "explicit real invalidation API; NOTIFY/TTL/cross-process epochs open",
    "controlled embeddings/client facade/flags/ancillary ranking",
    "production fields/provider freshness/ingestion/index/quality/numeric budgets/runtime proof open",
    "complete executed-source closure not captured",
    "paid judging paused"
  ],
  "followup": "Actual host auth and session user/workspace/harness derivation before projected memory dispatch; pin source closure and target harness prospectively on new runs.",
  "incidentalDefect": "EI-26810819700181555"
}
