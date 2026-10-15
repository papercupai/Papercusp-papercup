---
rel_path: "reports/durable-parks/ubp-p028-exact-condition-EI-22636478173319782-20261008-r2-reconcile.json"
updated_at: 1791482655013
_body: "content"
---

{
  "schemaVersion": "durable-park-reconcile-v1",
  "runId": "ubp-p028-exact-condition-EI-22636478173319782-20261008-r2",
  "inputSha256": "fc6c7c498c5d86b53259a821792b7fdf3b3d66cc3c70c0571c133b3ff2097451",
  "workspaceId": "papercusp-workspace",
  "harnessSlug": "papercusp",
  "generatedAt": "2026-10-08T18:04:15.013Z",
  "actor": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
  "requested": 1,
  "cleared": 1,
  "unchanged": 0,
  "rows": [
    {
      "id": "EI-22636478173319782",
      "outcome": "cleared",
      "expectedParkFingerprint": "bb00d5f942d461e84208803a9d223a771055f526a592c23a6f4b51f1ce59c8bc",
      "observedParkFingerprint": "bb00d5f942d461e84208803a9d223a771055f526a592c23a6f4b51f1ce59c8bc",
      "reasonCode": "condition-satisfied",
      "evidence": "Exact sibling EI-22636613539857225 is done/committed; fresh canonical clean test_runs 20936838 and 20936839 PASS at 6b9610b0f9, both tested files and named source graph remain byte-identical. Refreshed proof reports/durable-parks/ubp-p028-operational-20261008T164008098Z-condition-EI-22636478173319782-r2.json; original terminal proof is explicitly historical. Release only this named completed-sibling wait; duplicate stays open for verification/closure.",
      "preservedLease": false,
      "takenBy": null
    }
  ],
  "artifactPath": "reports/durable-parks/ubp-p028-exact-condition-EI-22636478173319782-20261008-r2-reconcile.json"
}
