---
rel_path: "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-25286473017545396-cfd08e9166c64a785ea7c2e03588bb14-reconcile.json"
updated_at: 1791670571001
_body: "content"
---

{
  "schemaVersion": "durable-park-reconcile-v1",
  "runId": "work-item-durable-park-audit:reconcile:tool:EI-25286473017545396:cfd08e9166c64a785ea7c2e03588bb14",
  "inputSha256": "cfd08e9166c64a785ea7c2e03588bb14415061d0bd58399ffab6f646097d6309",
  "workspaceId": "papercusp-workspace",
  "harnessSlug": "papercusp",
  "generatedAt": "2026-10-10T22:16:11.001Z",
  "actor": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
  "requested": 1,
  "cleared": 1,
  "unchanged": 0,
  "rows": [
    {
      "id": "EI-25286473017545396",
      "outcome": "cleared",
      "expectedParkFingerprint": "98c29f01956e50763969d9fe9f52d59b505f2c8465538fabd10b2cef689eeb9e",
      "observedParkFingerprint": "98c29f01956e50763969d9fe9f52d59b505f2c8465538fabd10b2cef689eeb9e",
      "reasonCode": "condition-satisfied",
      "evidence": "Park release trigger is work-item:done:EI-25286491844937496 (condition: 'Re-evaluate this duplicate judge-recovery report after the canonical fix item settles; determine whether this report is still distinct or can be closed as duplicate.'). Re-read 2026-10-10T22:15Z (su-6baa8, psql on harness_shared.work_items, workspace papercusp-workspace): EI-25286491844937496 status=done, taken_by none; EI-25286473017545396 status=open, taken_by null. The trigger target is terminal, so the release condition is met. The re-evaluation the condition describes is the next claimant's work and travels with the row. Settled under plan bug-queue-legitimacy-and-actionable-validation-2026-10-10 P-004 / D-009.",
      "preservedLease": false,
      "takenBy": null
    }
  ],
  "artifactPath": "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-25286473017545396-cfd08e9166c64a785ea7c2e03588bb14-reconcile.json"
}
