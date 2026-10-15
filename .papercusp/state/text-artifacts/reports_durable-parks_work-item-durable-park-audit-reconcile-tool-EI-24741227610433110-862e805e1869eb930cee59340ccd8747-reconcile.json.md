---
rel_path: "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-24741227610433110-862e805e1869eb930cee59340ccd8747-reconcile.json"
updated_at: 1791670543054
_body: "content"
---

{
  "schemaVersion": "durable-park-reconcile-v1",
  "runId": "work-item-durable-park-audit:reconcile:tool:EI-24741227610433110:862e805e1869eb930cee59340ccd8747",
  "inputSha256": "862e805e1869eb930cee59340ccd8747a8010d40efac06b0bf5cd167212fdfab",
  "workspaceId": "papercusp-workspace",
  "harnessSlug": "papercusp",
  "generatedAt": "2026-10-10T22:15:43.054Z",
  "actor": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
  "requested": 1,
  "cleared": 1,
  "unchanged": 0,
  "rows": [
    {
      "id": "EI-24741227610433110",
      "outcome": "cleared",
      "expectedParkFingerprint": "5ab242c1e0ea438e863b3140ee6a2331709e20c6ae25cf7bebc79d20e2e8bf0f",
      "observedParkFingerprint": "5ab242c1e0ea438e863b3140ee6a2331709e20c6ae25cf7bebc79d20e2e8bf0f",
      "reasonCode": "condition-satisfied",
      "evidence": "Park release trigger is work-item:done:WI-10004513 (condition: 'WI-10004513 is marked done, so its related source fix is complete and this overlapping incident can be re-evaluated.'). Re-read 2026-10-10T22:15Z (su-6baa8, psql on harness_shared.work_items, workspace papercusp-workspace): WI-10004513 status=done, taken_by none; EI-24741227610433110 status=open, taken_by null. The trigger target is terminal, so the release condition is met. The re-evaluation the condition describes is the next claimant's work and travels with the row. Settled under plan bug-queue-legitimacy-and-actionable-validation-2026-10-10 P-004 / D-009.",
      "preservedLease": false,
      "takenBy": null
    }
  ],
  "artifactPath": "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-24741227610433110-862e805e1869eb930cee59340ccd8747-reconcile.json"
}
