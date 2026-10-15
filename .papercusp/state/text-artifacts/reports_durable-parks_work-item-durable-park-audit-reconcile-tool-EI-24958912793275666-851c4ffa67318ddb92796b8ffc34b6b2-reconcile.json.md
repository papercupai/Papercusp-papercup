---
rel_path: "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-24958912793275666-851c4ffa67318ddb92796b8ffc34b6b2-reconcile.json"
updated_at: 1791670558506
_body: "content"
---

{
  "schemaVersion": "durable-park-reconcile-v1",
  "runId": "work-item-durable-park-audit:reconcile:tool:EI-24958912793275666:851c4ffa67318ddb92796b8ffc34b6b2",
  "inputSha256": "851c4ffa67318ddb92796b8ffc34b6b2a46b59c83758d1fb9c4f2bc1b00d37c2",
  "workspaceId": "papercusp-workspace",
  "harnessSlug": "papercusp",
  "generatedAt": "2026-10-10T22:15:58.506Z",
  "actor": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
  "requested": 1,
  "cleared": 1,
  "unchanged": 0,
  "rows": [
    {
      "id": "EI-24958912793275666",
      "outcome": "cleared",
      "expectedParkFingerprint": "dec751759eaf0045c3820924d70ec00c38daa6318e5323d31d608bc7c3ed83be",
      "observedParkFingerprint": "dec751759eaf0045c3820924d70ec00c38daa6318e5323d31d608bc7c3ed83be",
      "reasonCode": "condition-satisfied",
      "evidence": "Park release trigger is work-item:done:EI-24932442270076519 (condition: 'After parent EI-24932442270076519 completes, compare its completion evidence against this digest's 12 contributing work-items and determine residual scope.'). Re-read 2026-10-10T22:15Z (su-6baa8, psql on harness_shared.work_items, workspace papercusp-workspace): EI-24932442270076519 status=done, taken_by none; EI-24958912793275666 status=open, taken_by null. The trigger target is terminal, so the release condition is met. The re-evaluation the condition describes is the next claimant's work and travels with the row. Settled under plan bug-queue-legitimacy-and-actionable-validation-2026-10-10 P-004 / D-009.",
      "preservedLease": false,
      "takenBy": null
    }
  ],
  "artifactPath": "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-24958912793275666-851c4ffa67318ddb92796b8ffc34b6b2-reconcile.json"
}
