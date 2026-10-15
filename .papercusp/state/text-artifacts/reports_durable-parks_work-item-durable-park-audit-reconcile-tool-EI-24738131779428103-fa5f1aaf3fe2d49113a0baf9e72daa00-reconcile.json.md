---
rel_path: "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-24738131779428103-fa5f1aaf3fe2d49113a0baf9e72daa00-reconcile.json"
updated_at: 1791670539513
_body: "content"
---

{
  "schemaVersion": "durable-park-reconcile-v1",
  "runId": "work-item-durable-park-audit:reconcile:tool:EI-24738131779428103:fa5f1aaf3fe2d49113a0baf9e72daa00",
  "inputSha256": "fa5f1aaf3fe2d49113a0baf9e72daa005d567855d9af3aace440b5597f6f8d77",
  "workspaceId": "papercusp-workspace",
  "harnessSlug": "papercusp",
  "generatedAt": "2026-10-10T22:15:39.513Z",
  "actor": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
  "requested": 1,
  "cleared": 1,
  "unchanged": 0,
  "rows": [
    {
      "id": "EI-24738131779428103",
      "outcome": "cleared",
      "expectedParkFingerprint": "c88c34a23f8cca435ee79e1b04ce50fa703c1412425d923a41b4972c3af9e4fb",
      "observedParkFingerprint": "c88c34a23f8cca435ee79e1b04ce50fa703c1412425d923a41b4972c3af9e4fb",
      "reasonCode": "condition-satisfied",
      "evidence": "Park release trigger is work-item:done:WI-10004525 (condition: 'WI-10004525 reaches state done; reassess EI-24738131779428103 against its completed Native Codex MCP recovery-proxy findings.'). Re-read 2026-10-10T22:15Z (su-6baa8, psql on harness_shared.work_items, workspace papercusp-workspace): WI-10004525 status=done, taken_by none; EI-24738131779428103 status=open, taken_by null. The trigger target is terminal, so the release condition is met. The re-evaluation the condition describes is the next claimant's work and travels with the row. Settled under plan bug-queue-legitimacy-and-actionable-validation-2026-10-10 P-004 / D-009.",
      "preservedLease": false,
      "takenBy": null
    }
  ],
  "artifactPath": "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-24738131779428103-fa5f1aaf3fe2d49113a0baf9e72daa00-reconcile.json"
}
