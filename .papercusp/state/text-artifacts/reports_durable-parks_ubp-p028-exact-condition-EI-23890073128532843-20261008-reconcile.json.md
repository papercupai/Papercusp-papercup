---
rel_path: "reports/durable-parks/ubp-p028-exact-condition-EI-23890073128532843-20261008-reconcile.json"
updated_at: 1791484951745
_body: "content"
---

{
  "schemaVersion": "durable-park-reconcile-v1",
  "runId": "ubp-p028-exact-condition-EI-23890073128532843-20261008",
  "inputSha256": "24eb166cd26c3610a4e5cb6cbfa1958230af15ae7cc77002f9a5b1df4bcb93be",
  "workspaceId": "papercusp-workspace",
  "harnessSlug": "papercusp",
  "generatedAt": "2026-10-08T18:42:31.745Z",
  "actor": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
  "requested": 1,
  "cleared": 1,
  "unchanged": 0,
  "rows": [
    {
      "id": "EI-23890073128532843",
      "outcome": "cleared",
      "expectedParkFingerprint": "212f18c743862983a9602ecf8ad12ff153fce623a79c929a7d6ea97d52f3b9b2",
      "observedParkFingerprint": "212f18c743862983a9602ecf8ad12ff153fce623a79c929a7d6ea97d52f3b9b2",
      "reasonCode": "typed-blocker-resolved",
      "evidence": "reports/durable-parks/ubp-p028-exact-condition-EI-23890073128532843-20261008-proof.json sha256=dc2003e8c5b93844f539bf4680ac6f82a0f2eb5065f481ee90818e9fbc4a66ca; exact linked blocker WI-10002662 is DONE with committed completion authority under share lock; no other release predicate declared.",
      "preservedLease": false,
      "takenBy": null
    }
  ],
  "artifactPath": "reports/durable-parks/ubp-p028-exact-condition-EI-23890073128532843-20261008-reconcile.json"
}
