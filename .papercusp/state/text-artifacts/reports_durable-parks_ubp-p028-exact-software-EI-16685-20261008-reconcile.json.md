---
rel_path: "reports/durable-parks/ubp-p028-exact-software-EI-16685-20261008-reconcile.json"
updated_at: 1791489879221
_body: "content"
---

{
  "schemaVersion": "durable-park-reconcile-v1",
  "runId": "ubp-p028-exact-software-EI-16685-20261008",
  "inputSha256": "08a7e3469ddb21023cec24f2a75b6ead06fd92a633e13888478d7aadf5bd1013",
  "workspaceId": "papercusp-workspace",
  "harnessSlug": "papercusp",
  "generatedAt": "2026-10-08T20:04:39.220Z",
  "actor": "su-055e916b-4218-4d93-9e0d-4a2c57fe9026",
  "requested": 1,
  "cleared": 1,
  "unchanged": 0,
  "rows": [
    {
      "id": "EI-16685",
      "outcome": "cleared",
      "expectedParkFingerprint": "bc550e97ff5261c39e518d9b65717b129458d92c31228e78a8df3d48328afd85",
      "observedParkFingerprint": "bc550e97ff5261c39e518d9b65717b129458d92c31228e78a8df3d48328afd85",
      "reasonCode": "condition-satisfied",
      "evidence": "Original sole software condition WI-5510 is terminal DONE with named legacy stored completion evidence; committed HEAD f387766a4fe1d4d098059c38a9057918399cfd1e includes makeStaleFireGuard/decodeFireIdentity and stale-fire-drop directly before delivery in the maintained apps/operator/scripts/psu-pty-host.mjs, plus fireNumber/routineId envelope threading. Historical legacy tests are not claimed current or fully green. This clears only the park, never closes EI-16685; independent review/permission payload survives.",
      "preservedLease": false,
      "takenBy": null
    }
  ],
  "artifactPath": "reports/durable-parks/ubp-p028-exact-software-EI-16685-20261008-reconcile.json"
}
