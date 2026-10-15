---
rel_path: "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-24734764483393480-908efe6d82a6a900ad8d86b1999e6d7d-reconcile.json"
updated_at: 1791670536785
_body: "content"
---

{
  "schemaVersion": "durable-park-reconcile-v1",
  "runId": "work-item-durable-park-audit:reconcile:tool:EI-24734764483393480:908efe6d82a6a900ad8d86b1999e6d7d",
  "inputSha256": "908efe6d82a6a900ad8d86b1999e6d7dcc48aed10e15b50d5cfc6cfcaa82046d",
  "workspaceId": "papercusp-workspace",
  "harnessSlug": "papercusp",
  "generatedAt": "2026-10-10T22:15:36.785Z",
  "actor": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
  "requested": 1,
  "cleared": 1,
  "unchanged": 0,
  "rows": [
    {
      "id": "EI-24734764483393480",
      "outcome": "cleared",
      "expectedParkFingerprint": "94357705cacc50bd24b123c6d81fffcad10df1d052d7299835da48d933adf850",
      "observedParkFingerprint": "94357705cacc50bd24b123c6d81fffcad10df1d052d7299835da48d933adf850",
      "reasonCode": "condition-satisfied",
      "evidence": "Park release trigger is work-item:done:EI-24404095648820288 (condition: 'The active route investigation in EI-24404095648820288 reaches terminal; then verify whether its resolution covers this code:run/tools:find transport report.'). Re-read 2026-10-10T22:15Z (su-6baa8, psql on harness_shared.work_items, workspace papercusp-workspace): EI-24404095648820288 status=done, taken_by none; EI-24734764483393480 status=open, taken_by null. The trigger target is terminal, so the release condition is met. The re-evaluation the condition describes is the next claimant's work and travels with the row. Settled under plan bug-queue-legitimacy-and-actionable-validation-2026-10-10 P-004 / D-009.",
      "preservedLease": false,
      "takenBy": null
    }
  ],
  "artifactPath": "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-24734764483393480-908efe6d82a6a900ad8d86b1999e6d7d-reconcile.json"
}
