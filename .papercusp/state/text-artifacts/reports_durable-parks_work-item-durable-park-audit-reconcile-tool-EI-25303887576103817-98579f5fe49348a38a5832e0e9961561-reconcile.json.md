---
rel_path: "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-25303887576103817-98579f5fe49348a38a5832e0e9961561-reconcile.json"
updated_at: 1791670609927
_body: "content"
---

{
  "schemaVersion": "durable-park-reconcile-v1",
  "runId": "work-item-durable-park-audit:reconcile:tool:EI-25303887576103817:98579f5fe49348a38a5832e0e9961561",
  "inputSha256": "98579f5fe49348a38a5832e0e9961561b8dd5b8f3f7e23fce91f8b83e550ddf0",
  "workspaceId": "papercusp-workspace",
  "harnessSlug": "papercusp",
  "generatedAt": "2026-10-10T22:16:49.927Z",
  "actor": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
  "requested": 1,
  "cleared": 1,
  "unchanged": 0,
  "rows": [
    {
      "id": "EI-25303887576103817",
      "outcome": "cleared",
      "expectedParkFingerprint": "963eeecd6669e18dbec1fa4b9245f328ea9f811a2101a577addbe66b9d145a30",
      "observedParkFingerprint": "963eeecd6669e18dbec1fa4b9245f328ea9f811a2101a577addbe66b9d145a30",
      "reasonCode": "condition-satisfied",
      "evidence": "Park release trigger is work-item:done:EI-25303697450023492 (condition: 'The live owner finishes EI-25303697450023492; re-evaluate whether the committed shared spill repair covers this tools:invoke work_items:get path.'). Re-read 2026-10-10T22:15Z (su-6baa8, psql on harness_shared.work_items, workspace papercusp-workspace): EI-25303697450023492 status=done, taken_by none; EI-25303887576103817 status=open, taken_by null. The trigger target is terminal, so the release condition is met. The re-evaluation the condition describes is the next claimant's work and travels with the row. Settled under plan bug-queue-legitimacy-and-actionable-validation-2026-10-10 P-004 / D-009.",
      "preservedLease": false,
      "takenBy": null
    }
  ],
  "artifactPath": "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-25303887576103817-98579f5fe49348a38a5832e0e9961561-reconcile.json"
}
