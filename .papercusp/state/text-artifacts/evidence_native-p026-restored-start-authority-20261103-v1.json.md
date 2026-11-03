---
rel_path: "evidence/native-p026-restored-start-authority-20261103-v1.json"
updated_at: 1793671290120
_body: "content"
---

{
  "schema": "native-p026-restored-start-proof-v1",
  "observedAt": "2026-11-03 02:01:29 UTC",
  "transportKey": "native-p026-start-after-source-read-20261103-v1",
  "endpoint": "http://127.0.0.1:3170",
  "startReceipt": {
    "ok": true,
    "counts": {
      "ok": 1,
      "failed": 0
    },
    "results": [
      {
        "ok": true,
        "slug": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
        "harnessSlug": "papercusp",
        "executionStart": {
          "seq": 185,
          "contentHash": "28587d00a1f9598928e8597061108937e289f3ac387778ad226e2c538c359506"
        },
        "admission": {
          "ready": true,
          "reason": "ready"
        },
        "claimSpecBinding": {
          "ok": true,
          "errors": [],
          "revision": 3
        },
        "promotion": {
          "workItems": [
            {
              "workItemId": "WI-10007889",
              "planItemId": "P-026",
              "newlyPromoted": false,
              "actionable": true
            }
          ]
        }
      }
    ]
  },
  "storedProof": {
    "mode": "query",
    "rowCount": 1,
    "truncated": false,
    "fields": [
      "workspace_id",
      "harness_slug",
      "plan_slug",
      "version",
      "content_hash",
      "execution_start_revision_seq",
      "status",
      "proof_content_hash",
      "proof_schema",
      "proof_scope"
    ],
    "elapsedMs": 35,
    "rows": [
      {
        "workspace_id": "papercusp-workspace",
        "harness_slug": "papercusp",
        "plan_slug": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
        "version": "183",
        "content_hash": "28587d00a1f9598928e8597061108937e289f3ac387778ad226e2c538c359506",
        "execution_start_revision_seq": 185,
        "status": "ready",
        "proof_content_hash": "28587d00a1f9598928e8597061108937e289f3ac387778ad226e2c538c359506",
        "proof_schema": "plan-execution-start-v1",
        "proof_scope": {
          "planSlug": "native-code-intelligence-ecosystem-and-dream-2026-10-09",
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace"
        }
      }
    ]
  },
  "precondition": {
    "explicit3170Snapshot": {
      "complete": true,
      "truncated": false,
      "problems": [],
      "capture": "/tmp/native-p026-readiness-3170-20261103.json"
    }
  },
  "priorProof": {
    "seq": 183,
    "current": false,
    "artifact": "evidence/native-p026-start-authority-20261103-v1.json"
  },
  "limitations": [
    "Selected authoritative start receipt fields only; display message intentionally omitted because upstream clipping affected that non-authority prose.",
    "Canonical plan-start proof only. Native/public tool admission and all six live CLI acceptance cells remain unverified.",
    "Existing D041 headless Sol6.1 xhigh fleet route; D053 retains original WI-10007889 holder; no self test-route override.",
    "P021 fixed1800000ms/forecast1686000ms with unchanged validation; remaining five only after usablePASS.",
    "No METHOD UNKNOWN/scientific hold, budget, binding, runtime ownership, or release-gate waiver. No post-start planNow/body writes."
  ]
}
