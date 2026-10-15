---
rel_path: "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-25303334727767704-56fa451fea25ab129e991438952722d0-reconcile.json"
updated_at: 1791670605131
_body: "content"
---

{
  "schemaVersion": "durable-park-reconcile-v1",
  "runId": "work-item-durable-park-audit:reconcile:tool:EI-25303334727767704:56fa451fea25ab129e991438952722d0",
  "inputSha256": "56fa451fea25ab129e991438952722d011d5f82e7335d245c95412be721555c6",
  "workspaceId": "papercusp-workspace",
  "harnessSlug": "papercusp",
  "generatedAt": "2026-10-10T22:16:45.131Z",
  "actor": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
  "requested": 1,
  "cleared": 1,
  "unchanged": 0,
  "rows": [
    {
      "id": "EI-25303334727767704",
      "outcome": "cleared",
      "expectedParkFingerprint": "7b217a7eb8707c38298bb0295e17976f7ccb291e43405e356ffb887d44e51973",
      "observedParkFingerprint": "7b217a7eb8707c38298bb0295e17976f7ccb291e43405e356ffb887d44e51973",
      "reasonCode": "condition-satisfied",
      "evidence": "Park release trigger is work-item:done:EI-25304677620490090 (condition: 'EI-25304677620490090 reaches done; re-evaluate whether this code:run spill report is independently unresolved using that item's fix and test evidence.'). Re-read 2026-10-10T22:15Z (su-6baa8, psql on harness_shared.work_items, workspace papercusp-workspace): EI-25304677620490090 status=done, taken_by none; EI-25303334727767704 status=open, taken_by null. The trigger target is terminal, so the release condition is met. The re-evaluation the condition describes is the next claimant's work and travels with the row. Settled under plan bug-queue-legitimacy-and-actionable-validation-2026-10-10 P-004 / D-009.",
      "preservedLease": false,
      "takenBy": null
    }
  ],
  "artifactPath": "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-25303334727767704-56fa451fea25ab129e991438952722d0-reconcile.json"
}
