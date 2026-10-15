---
rel_path: "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-24758685381095108-00ccc07798f381a8221abfc277e88013-reconcile.json"
updated_at: 1791670546971
_body: "content"
---

{
  "schemaVersion": "durable-park-reconcile-v1",
  "runId": "work-item-durable-park-audit:reconcile:tool:EI-24758685381095108:00ccc07798f381a8221abfc277e88013",
  "inputSha256": "00ccc07798f381a8221abfc277e880138128a0d127663691e6000668946cd79b",
  "workspaceId": "papercusp-workspace",
  "harnessSlug": "papercusp",
  "generatedAt": "2026-10-10T22:15:46.971Z",
  "actor": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
  "requested": 1,
  "cleared": 1,
  "unchanged": 0,
  "rows": [
    {
      "id": "EI-24758685381095108",
      "outcome": "cleared",
      "expectedParkFingerprint": "2e3dbb5dc4f38984566687fad88b5dfd19fcb2ad60ebbd7794089e89186e3171",
      "observedParkFingerprint": "2e3dbb5dc4f38984566687fad88b5dfd19fcb2ad60ebbd7794089e89186e3171",
      "reasonCode": "condition-satisfied",
      "evidence": "Park release trigger is work-item:done:EI-23680208818629006 (condition: 'Peer fix EI-23680208818629006 is successfully complete; revalidate that tools:find exposes every required evidence.bindings field before closing this item.'). Re-read 2026-10-10T22:15Z (su-6baa8, psql on harness_shared.work_items, workspace papercusp-workspace): EI-23680208818629006 status=done, taken_by none; EI-24758685381095108 status=open, taken_by null. The trigger target is terminal, so the release condition is met. The re-evaluation the condition describes is the next claimant's work and travels with the row. Settled under plan bug-queue-legitimacy-and-actionable-validation-2026-10-10 P-004 / D-009.",
      "preservedLease": false,
      "takenBy": null
    }
  ],
  "artifactPath": "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-24758685381095108-00ccc07798f381a8221abfc277e88013-reconcile.json"
}
