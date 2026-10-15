---
rel_path: "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-25263832272746079-4a86e6a7bfacb48f01910f15711ced0f-reconcile.json"
updated_at: 1791670564614
_body: "content"
---

{
  "schemaVersion": "durable-park-reconcile-v1",
  "runId": "work-item-durable-park-audit:reconcile:tool:EI-25263832272746079:4a86e6a7bfacb48f01910f15711ced0f",
  "inputSha256": "4a86e6a7bfacb48f01910f15711ced0f7149c673f6282b6dee91a39570610133",
  "workspaceId": "papercusp-workspace",
  "harnessSlug": "papercusp",
  "generatedAt": "2026-10-10T22:16:04.614Z",
  "actor": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
  "requested": 1,
  "cleared": 1,
  "unchanged": 0,
  "rows": [
    {
      "id": "EI-25263832272746079",
      "outcome": "cleared",
      "expectedParkFingerprint": "113c9d68216f8a869d7c6c9caa99ec920b7d83a7aa60dca8586fb1457608ff77",
      "observedParkFingerprint": "113c9d68216f8a869d7c6c9caa99ec920b7d83a7aa60dca8586fb1457608ff77",
      "reasonCode": "condition-satisfied",
      "evidence": "Park release trigger is work-item:done:EI-25213409353115805 (condition: 'Verified shared targeted-presence snapshot root repair completes; then original-selector acceptance is runnable.'). Re-read 2026-10-10T22:15Z (su-6baa8, psql on harness_shared.work_items, workspace papercusp-workspace): EI-25213409353115805 status=done, taken_by none; EI-25263832272746079 status=open, taken_by null. The trigger target is terminal, so the release condition is met. The re-evaluation the condition describes is the next claimant's work and travels with the row. Settled under plan bug-queue-legitimacy-and-actionable-validation-2026-10-10 P-004 / D-009.",
      "preservedLease": false,
      "takenBy": null
    }
  ],
  "artifactPath": "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-25263832272746079-4a86e6a7bfacb48f01910f15711ced0f-reconcile.json"
}
