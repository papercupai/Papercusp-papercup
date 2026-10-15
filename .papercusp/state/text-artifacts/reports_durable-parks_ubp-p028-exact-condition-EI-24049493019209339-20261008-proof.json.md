---
rel_path: "reports/durable-parks/ubp-p028-exact-condition-EI-24049493019209339-20261008-proof.json"
updated_at: 1791486253490
_body: "content"
---

{
  "schemaVersion": "p028-exact-condition-proof-v1",
  "id": "EI-24049493019209339",
  "rootId": "EI-24042135255703680",
  "verifiedAt": "2026-10-08T19:04:13.490Z",
  "positive": {
    "database": "papercusp",
    "port": 5432,
    "owned": 1
  },
  "declaredReleaseContract": {
    "owner": "su-aae8dddd-6fde-4c86-bd73-6e4710c75bc7",
    "trigger": "work-item:done:EI-24042135255703680",
    "evidence": "a live resolver or producer registration can still satisfy the condition",
    "condition": "The overlapping reservation-epoch fix is completed; re-check whether it prevents a second auditor from being recruited after the first reservation owner settles the exact card.",
    "reachability": "reachable"
  },
  "expectedParkFingerprint": "fecb41aaf780c2ba74410b6d46f5d073b211195b3931c9f7e8d207b3a98cf508",
  "rootRead": {
    "id": "EI-24042135255703680",
    "state": "done",
    "authority": "committed",
    "payloadSha256": "1e30906d513d6f06e690e163f9e33720dae5898c82772e00b6fb148135cf6ebe",
    "shareLockedDuringReconciliation": true
  },
  "verification": {
    "declaredCondition": "The overlapping reservation-epoch fix is completed; re-check whether it prevents a second auditor from being recruited after the first reservation owner settles the exact card.",
    "observation": "The declared hold awaits completion of this software dependency. Canonical root is DONE/committed and remains share-locked during the CAS. Subsequent re-evaluation of the subject stays pending.",
    "boundary": "This releases the dependency park only; it does not close or verify the subject bug."
  },
  "cohortRef": "reports/durable-parks/ubp-p028-operational-20261008183436Z-dispositions.json",
  "sourceCommit": "58227b6dc24fe2b8a7b5bcc6079ac19a9d743cd9",
  "sourceBefore": [
    {
      "path": "packages/operator-core/lib/work-items-durable-park-audit.ts",
      "sha256": "858ee0479b2577e6f64a5ecbafe0f58ebbc9c5c314707055656597fd4ad798e7"
    },
    {
      "path": "packages/operator-core/lib/durable-park-release-contract.ts",
      "sha256": "6c9f88f3f60e46f0827bb1fd2df6a72d822e231ac88748a9a5c6cd69cb856c2d"
    },
    {
      "path": "packages/operator-core/lib/external-condition-reachability.ts",
      "sha256": "cbafbb90889e436f5c08f9ed656d88fcb8bcd8270e1d52024ce7ede54727e460"
    },
    {
      "path": "packages/operator-core/lib/work-items.ts",
      "sha256": "faeb77ca0a537b725e960cf9adb071b72da6f46f3364401c345b4d02ad2bdfba"
    }
  ],
  "sourcePayload": {
    "_ei": {
      "scope": "harness:papercusp",
      "source": "su",
      "severity": "major",
      "created_by": "su-f538bb28-704c-4bf3-8950-078ab0f8c2bb",
      "signal_origin": "organic"
    },
    "_claimHold": true,
    "filedByRole": "su",
    "claim_hold_at": "2026-09-23T18:21:26.991Z",
    "claim_hold_by": "su-0c70ddfa-7079-4d85-a05e-b58db9363712",
    "dedupCoverage": {
      "lexical": "ok",
      "degraded": true,
      "semantic": "unavailable"
    },
    "ideaLifecycle": {
      "state": "open",
      "stateUpdatedAt": "2026-09-23T10:56:23.733Z"
    },
    "externalBlockers": [
      {
        "ref": "work-item:done:EI-24042135255703680",
        "kind": "event",
        "status": "cleared",
        "summary": "A live peer is implementing the overlapping reservation-epoch guard; revalidate this report when that work-item completes.",
        "evidence": "WI-10005020 R-15: migrated to the work_item_deps blocks edge (canonical dependency form)",
        "nextVerb": "After the peer completion event, re-read the implementation and its verification; close this item as already fixed only if the double-placement path is covered.",
        "clearedAt": "2026-10-02T00:02:02.512Z",
        "clearedBy": "su-7d5affe9-dd3a-4f93-80e2-b2ea46b7c552",
        "createdAt": "2026-09-23T18:21:22.641Z",
        "createdBy": "su-0c70ddfa-7079-4d85-a05e-b58db9363712",
        "updatedAt": "2026-10-02T00:02:02.512Z",
        "capability": "live-dependency",
        "capabilitySource": "inferred"
      }
    ],
    "admissionIdentity": {
      "titleKey": "title:24048952049646665 audit auditor consult double for fork grading integrity later launched min placed reserved settled while",
      "schemaVersion": "admission-identity-v1"
    },
    "claim_hold_reason": "This drain item overlaps peer EI-24042135255703680, which owns the exact files and is actively implementing the same reservation-epoch fix.",
    "freshnessEnvelope": {
      "observedAt": "2026-09-23T10:56:23.734Z",
      "linkedFixRefs": [],
      "reporterSession": "su-f538bb28-704c-4bf3-8950-078ab0f8c2bb",
      "observedSourceSha": "98a496c74c",
      "toolSchemaVersion": null,
      "observedRuntimeSha": "98a496c74c",
      "deployBuildIdentity": "98a496c74c@0.0.0",
      "reporterRuntimeVersion": "0.0.0",
      "lastSuccessfulReproductionAt": null
    },
    "claim_hold_release": {
      "owner": "su-aae8dddd-6fde-4c86-bd73-6e4710c75bc7",
      "trigger": "work-item:done:EI-24042135255703680",
      "evidence": "a live resolver or producer registration can still satisfy the condition",
      "condition": "The overlapping reservation-epoch fix is completed; re-check whether it prevents a second auditor from being recruited after the first reservation owner settles the exact card.",
      "reachability": "reachable"
    },
    "claim_history_post_id": 9001788375295,
    "implementationReadiness": {
      "reason": "existing-immediate-capture-policy",
      "source": "capture-policy",
      "status": "ready",
      "updatedAt": "2026-09-23T10:56:23.733Z",
      "schemaVersion": "implementation-readiness-v1"
    }
  }
}
