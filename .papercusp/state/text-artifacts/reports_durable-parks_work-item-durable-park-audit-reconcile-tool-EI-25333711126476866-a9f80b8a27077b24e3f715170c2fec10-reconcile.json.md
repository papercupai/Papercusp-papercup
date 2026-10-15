---
rel_path: "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-25333711126476866-a9f80b8a27077b24e3f715170c2fec10-reconcile.json"
updated_at: 1791670625833
_body: "content"
---

{
  "schemaVersion": "durable-park-reconcile-v1",
  "runId": "work-item-durable-park-audit:reconcile:tool:EI-25333711126476866:a9f80b8a27077b24e3f715170c2fec10",
  "inputSha256": "a9f80b8a27077b24e3f715170c2fec10729918f8ef3fe16c244f20b82dcde5b3",
  "workspaceId": "papercusp-workspace",
  "harnessSlug": "papercusp",
  "generatedAt": "2026-10-10T22:17:05.833Z",
  "actor": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
  "requested": 1,
  "cleared": 1,
  "unchanged": 0,
  "rows": [
    {
      "id": "EI-25333711126476866",
      "outcome": "cleared",
      "expectedParkFingerprint": "702fbd4f6340deb20210b94f21c8780a14e09ccbbd6ecb2ea5e37b7243086366",
      "observedParkFingerprint": "702fbd4f6340deb20210b94f21c8780a14e09ccbbd6ecb2ea5e37b7243086366",
      "reasonCode": "condition-satisfied",
      "evidence": "Park release trigger is work-item:done:EI-25314891261005918 (condition: 'The active blocker EI-25314891261005918 reaches a terminal outcome; then compare its verified result with this item's four contributors and resume only for uncovered cases.'). Re-read 2026-10-10T22:15Z (su-6baa8, psql on harness_shared.work_items, workspace papercusp-workspace): EI-25314891261005918 status=done, taken_by none; EI-25333711126476866 status=open, taken_by null. The trigger target is terminal, so the release condition is met. The re-evaluation the condition describes is the next claimant's work and travels with the row. Settled under plan bug-queue-legitimacy-and-actionable-validation-2026-10-10 P-004 / D-009.",
      "preservedLease": false,
      "takenBy": null
    }
  ],
  "artifactPath": "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-25333711126476866-a9f80b8a27077b24e3f715170c2fec10-reconcile.json"
}
