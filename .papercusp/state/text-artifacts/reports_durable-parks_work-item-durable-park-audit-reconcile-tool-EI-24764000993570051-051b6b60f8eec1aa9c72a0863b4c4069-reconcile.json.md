---
rel_path: "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-24764000993570051-051b6b60f8eec1aa9c72a0863b4c4069-reconcile.json"
updated_at: 1791670549196
_body: "content"
---

{
  "schemaVersion": "durable-park-reconcile-v1",
  "runId": "work-item-durable-park-audit:reconcile:tool:EI-24764000993570051:051b6b60f8eec1aa9c72a0863b4c4069",
  "inputSha256": "051b6b60f8eec1aa9c72a0863b4c40692eeb23f692e4c45f6acc0e65470b991f",
  "workspaceId": "papercusp-workspace",
  "harnessSlug": "papercusp",
  "generatedAt": "2026-10-10T22:15:49.196Z",
  "actor": "su-6baa8b9a-8d72-4223-b6d2-bf9f687dcfcb",
  "requested": 1,
  "cleared": 1,
  "unchanged": 0,
  "rows": [
    {
      "id": "EI-24764000993570051",
      "outcome": "cleared",
      "expectedParkFingerprint": "ef89ec0eec2d4bb9c93177fe6768ee56b801d1c5c6ebf57626e8551c0325807b",
      "observedParkFingerprint": "ef89ec0eec2d4bb9c93177fe6768ee56b801d1c5c6ebf57626e8551c0325807b",
      "reasonCode": "condition-satisfied",
      "evidence": "Park release trigger is work-item:done:EI-24772008911230982 (condition: 'The canonical aggregate EI-24772008911230982 reaches a terminal resolution and its finding determines whether this contributing report has independent remaining work.'). Re-read 2026-10-10T22:15Z (su-6baa8, psql on harness_shared.work_items, workspace papercusp-workspace): EI-24772008911230982 status=done, taken_by none; EI-24764000993570051 status=open, taken_by null. The trigger target is terminal, so the release condition is met. The re-evaluation the condition describes is the next claimant's work and travels with the row. Settled under plan bug-queue-legitimacy-and-actionable-validation-2026-10-10 P-004 / D-009.",
      "preservedLease": false,
      "takenBy": null
    }
  ],
  "artifactPath": "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-24764000993570051-051b6b60f8eec1aa9c72a0863b4c4069-reconcile.json"
}
