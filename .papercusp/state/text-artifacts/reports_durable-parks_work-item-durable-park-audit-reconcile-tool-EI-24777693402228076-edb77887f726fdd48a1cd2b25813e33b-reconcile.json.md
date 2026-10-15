---
rel_path: "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-24777693402228076-edb77887f726fdd48a1cd2b25813e33b-reconcile.json"
updated_at: 1791670550639
_body: "content"
---

{
  "schemaVersion": "durable-park-reconcile-v1",
  "runId": "work-item-durable-park-audit:reconcile:tool:EI-24777693402228076:edb77887f726fdd48a1cd2b25813e33b",
  "inputSha256": "edb77887f726fdd48a1cd2b25813e33bddd1f5606dd347763940a0f978247c25",
  "workspaceId": "papercusp-workspace",
  "harnessSlug": "papercusp",
  "generatedAt": "2026-10-10T22:15:50.639Z",
  "actor": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
  "requested": 1,
  "cleared": 1,
  "unchanged": 0,
  "rows": [
    {
      "id": "EI-24777693402228076",
      "outcome": "cleared",
      "expectedParkFingerprint": "5a85f5ddd020e802025625fe0d9b1a022ecc829fcceae71905c5dd52f3818c72",
      "observedParkFingerprint": "5a85f5ddd020e802025625fe0d9b1a022ecc829fcceae71905c5dd52f3818c72",
      "reasonCode": "condition-satisfied",
      "evidence": "Park release trigger is work-item:done:EI-24780569549840269 (condition: 'Recheck the historical work_items:search lock_timeout after the owner of the related work_items:release lock_timeout investigation records a diagnosis; clear this hold only after verifying whether that diagnosis explains or excludes this search report.'). Re-read 2026-10-10T22:15Z (su-6baa8, psql on harness_shared.work_items, workspace papercusp-workspace): EI-24780569549840269 status=done, taken_by none; EI-24777693402228076 status=open, taken_by null. The trigger target is terminal, so the release condition is met. The re-evaluation the condition describes is the next claimant's work and travels with the row. Settled under plan bug-queue-legitimacy-and-actionable-validation-2026-10-10 P-004 / D-009.",
      "preservedLease": false,
      "takenBy": null
    }
  ],
  "artifactPath": "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-24777693402228076-edb77887f726fdd48a1cd2b25813e33b-reconcile.json"
}
