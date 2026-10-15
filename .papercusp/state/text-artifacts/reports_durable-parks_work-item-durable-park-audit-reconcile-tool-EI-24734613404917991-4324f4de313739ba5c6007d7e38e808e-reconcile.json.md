---
rel_path: "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-24734613404917991-4324f4de313739ba5c6007d7e38e808e-reconcile.json"
updated_at: 1791670535600
_body: "content"
---

{
  "schemaVersion": "durable-park-reconcile-v1",
  "runId": "work-item-durable-park-audit:reconcile:tool:EI-24734613404917991:4324f4de313739ba5c6007d7e38e808e",
  "inputSha256": "4324f4de313739ba5c6007d7e38e808ec31743a91eb05eaf4dfa89d98b6f5555",
  "workspaceId": "papercusp-workspace",
  "harnessSlug": "papercusp",
  "generatedAt": "2026-10-10T22:15:35.600Z",
  "actor": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
  "requested": 1,
  "cleared": 1,
  "unchanged": 0,
  "rows": [
    {
      "id": "EI-24734613404917991",
      "outcome": "cleared",
      "expectedParkFingerprint": "e05cb116074b410bbf195220563413e598ee9c4067d619e50bc6e58fd123dcdf",
      "observedParkFingerprint": "e05cb116074b410bbf195220563413e598ee9c4067d619e50bc6e58fd123dcdf",
      "reasonCode": "condition-satisfied",
      "evidence": "Park release trigger is work-item:done:EI-24744827222668206 (condition: 'The sentinel implementation item completes; recheck this exact reset trace for worker/request attribution and decide whether independent proxy work remains.'). Re-read 2026-10-10T22:15Z (su-6baa8, psql on harness_shared.work_items, workspace papercusp-workspace): EI-24744827222668206 status=done, taken_by none; EI-24734613404917991 status=open, taken_by null. The trigger target is terminal, so the release condition is met. The re-evaluation the condition describes is the next claimant's work and travels with the row. Settled under plan bug-queue-legitimacy-and-actionable-validation-2026-10-10 P-004 / D-009.",
      "preservedLease": false,
      "takenBy": null
    }
  ],
  "artifactPath": "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-24734613404917991-4324f4de313739ba5c6007d7e38e808e-reconcile.json"
}
