---
rel_path: "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-25152107634140832-8ad08a0e705761d7bd31c2fc5f0fc8ce-reconcile.json"
updated_at: 1791722137555
_body: "content"
---

{
  "schemaVersion": "durable-park-reconcile-v1",
  "runId": "work-item-durable-park-audit:reconcile:tool:EI-25152107634140832:8ad08a0e705761d7bd31c2fc5f0fc8ce",
  "inputSha256": "8ad08a0e705761d7bd31c2fc5f0fc8cefae595c2d57f54a0b12a0bc538342f07",
  "workspaceId": "papercusp-workspace",
  "harnessSlug": "papercusp",
  "generatedAt": "2026-10-11T12:35:37.554Z",
  "actor": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
  "requested": 1,
  "cleared": 1,
  "unchanged": 0,
  "rows": [
    {
      "id": "EI-25152107634140832",
      "outcome": "cleared",
      "expectedParkFingerprint": "41e686240aad63a4db3e32a94a026729b0d6b9b3c492c986c08a7522eaa9bf15",
      "observedParkFingerprint": "41e686240aad63a4db3e32a94a026729b0d6b9b3c492c986c08a7522eaa9bf15",
      "reasonCode": "condition-satisfied",
      "evidence": "nonp2p-bug-drain-2026-08-08#D-167: current registered fleet leader su-055e916b explicitly confirms this deferred scope-reader investigation should resume. This is a new leader confirmation; the Oct5 dependency latch alone never certified the Oct10 park. Original review/admission, non-reproduction and same-request evidence gates remain.",
      "preservedLease": false,
      "takenBy": null
    }
  ],
  "artifactPath": "reports/durable-parks/work-item-durable-park-audit-reconcile-tool-EI-25152107634140832-8ad08a0e705761d7bd31c2fc5f0fc8ce-reconcile.json"
}
