---
rel_path: "reports/durable-parks/ubp-p028-operational-20261008T164008098Z-condition-EI-22636478173319782-r2.json"
updated_at: 1791482588935
_body: "content"
---

{
  "schemaVersion": "p028-condition-authority-v1",
  "workspaceId": "papercusp-workspace",
  "harness": "papercusp",
  "checkedAt": "2026-10-08T18:03:08.909Z",
  "sourceRunId": "ubp-p028-operational-20261008T164008098Z",
  "matrixSha256": "f56259029f65fb99c7aa26e88ff2300ff9f7b5f52f83a9465ca070688df6a692",
  "subject": {
    "id": "EI-22636478173319782",
    "condition": "Sibling EI-22636613539857225 completes the shared plans:new acceptance-BAR validation fix and this duplicate item can be verified/closed.",
    "trigger": "work-item:done:EI-22636613539857225",
    "owner": "su-04436973-b490-4123-9cd9-bca7ac89189c",
    "currentState": "open",
    "currentAssignee": null,
    "expectedParkFingerprint": "bb00d5f942d461e84208803a9d223a771055f526a592c23a6f4b51f1ce59c8bc",
    "lease": {
      "by": null,
      "reason": null,
      "at": null
    }
  },
  "blocker": {
    "id": "EI-22636613539857225",
    "state": "done",
    "completionAuthority": "committed",
    "originalCompletionFreshness": "stale",
    "currentVerification": {
      "testRunIds": [
        20936838,
        20936839
      ],
      "runs": [
        {
          "id": 20936838,
          "file_path": "packages/operator-core/lib/agent-tools/plans/new-parse-admission.test.ts",
          "status": "pass",
          "commit_sha": "6b9610b0f9231ee17a18a0fec2cd46177b0983e5",
          "worktree_dirty": false,
          "source": "local",
          "harness_slug": "papercusp",
          "workspace_id": "papercusp-workspace",
          "finished_at": "2026-10-08 13:14:11.1-04"
        },
        {
          "id": 20936839,
          "file_path": "packages/operator-core/lib/agent-tools/plans/__tests__/new-body.test.ts",
          "status": "pass",
          "commit_sha": "6b9610b0f9231ee17a18a0fec2cd46177b0983e5",
          "worktree_dirty": false,
          "source": "local",
          "harness_slug": "papercusp",
          "workspace_id": "papercusp-workspace",
          "finished_at": "2026-10-08 13:14:11.122-04"
        }
      ],
      "testLines": [
        " ✓ lib/agent-tools/plans/new-parse-admission.test.ts (7 tests) 18ms",
        " ✓ lib/agent-tools/plans/__tests__/new-body.test.ts (5 tests) 9ms"
      ],
      "testedSha": "6b9610b0f9231ee17a18a0fec2cd46177b0983e5",
      "currentHead": "c889625bec27718ef9ba8750115d009b812f1968",
      "sourceIdentities": [
        {
          "path": "packages/operator-core/lib/external-condition-reachability.ts",
          "sha256": "cbafbb90889e436f5c08f9ed656d88fcb8bcd8270e1d52024ce7ede54727e460"
        },
        {
          "path": "packages/operator-core/lib/external-condition-reachability.test.ts",
          "sha256": "ed8a88d7468634c1048eda39ec4fcb9e48f0f607c7d257ec1d0370392d017e5a"
        },
        {
          "path": "packages/operator-core/lib/durable-park-release-contract.ts",
          "sha256": "6c9f88f3f60e46f0827bb1fd2df6a72d822e231ac88748a9a5c6cd69cb856c2d"
        },
        {
          "path": "packages/operator-core/lib/work-items-durable-park-audit.ts",
          "sha256": "858ee0479b2577e6f64a5ecbafe0f58ebbc9c5c314707055656597fd4ad798e7"
        },
        {
          "path": "packages/operator-core/lib/work-items-durable-park-audit.test.ts",
          "sha256": "4cb598960aa184483b83a087fa8aa2988e97efb58940f10ae8ed111ba1e051b7"
        },
        {
          "path": "packages/operator-core/lib/work-items-claim-hold.integration.test.ts",
          "sha256": "14758e9f8ded0bf5b599947099be1f1a76fa6de375d91381fdfce5d475a9560e"
        },
        {
          "path": "packages/operator-core/lib/events/await/store.integration.test.ts",
          "sha256": "01e67e045ea142bf156d2efd63ecef8c98ec7137248ce59eadae659928c53679"
        },
        {
          "path": "packages/operator-core/lib/agent-tools/work_items/release.test.ts",
          "sha256": "50334fceccbbdadeb72dce4d1189da95ab4bce6a9a3d53db7284dbc0ba7458b2"
        },
        {
          "path": "packages/operator-core/lib/agent-tools/fleet_registry/pause-holds.test.ts",
          "sha256": "53478f2e636b58fa169b55999fb2fa9664a2dce025bcd91d4e7eb2f52f678f28"
        },
        {
          "path": "packages/operator-core/lib/harness/routines/work-item-durable-park-audit-action.integration.test.ts",
          "sha256": "60f0d8270f423bd1389bfe44e9b7365f155f2a3120d88b685b570a66cf252444"
        },
        {
          "path": "packages/operator-core/lib/agent-tools/plans/new.ts",
          "sha256": "621801a32a8e089544ddb3f1be76845d27007750d64432e866f9715c041929d2"
        },
        {
          "path": "packages/operator-core/lib/agent-tools/plans/new-parse-admission.test.ts",
          "sha256": "7b56d26181dd4a7393641b9e02f1a6b281a4886a7995edaaa1bef47fa954212d"
        },
        {
          "path": "packages/operator-core/lib/agent-tools/plans/__tests__/new-body.test.ts",
          "sha256": "2447775eb6d5f5bdcfe9b7d1783e3cc40465a75cc4c63be219e859e0c3095c41"
        }
      ],
      "scope": "13 named source/test paths; complete imported graph unknown",
      "sourceInspection": "plans:new validates acceptanceBarProblems before withPlanLock persistence; maintained admission tests reject missing BAR map and accept explicit complete map."
    }
  },
  "decision": {
    "id": "EI-22636478173319782",
    "expectedParkFingerprint": "bb00d5f942d461e84208803a9d223a771055f526a592c23a6f4b51f1ce59c8bc",
    "reasonCode": "condition-satisfied",
    "evidence": "Exact sibling EI-22636613539857225 is done/committed; fresh canonical clean test_runs 20936838 and 20936839 PASS at 6b9610b0f9, both tested files and named source graph remain byte-identical. Refreshed proof reports/durable-parks/ubp-p028-operational-20261008T164008098Z-condition-EI-22636478173319782-r2.json; original terminal proof is explicitly historical. Release only this named completed-sibling wait; duplicate stays open for verification/closure."
  },
  "actualParkClears": 0,
  "priorEvidencePath": "reports/durable-parks/ubp-p028-operational-20261008T164008098Z-condition-EI-22636478173319782.json",
  "priorEvidenceStatus": "historical: terminal completion freshness stale",
  "sourceMatrixPath": "reports/durable-parks/ubp-p028-operational-20261008T164008098Z-matrix.json"
}
