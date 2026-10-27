---
rel_path: "evidence/identity-assume/recovery50/native14-ledger-receipt.json"
updated_at: 1792931962933
_body: "content"
---

{
  "count": 1,
  "total": 1,
  "truncatedByLimit": false,
  "latestPerFile": false,
  "effectiveSourceFilter": "none (exact testRunIds receipt lookup)",
  "omittedBySourceFilter": 0,
  "runs": [
    {
      "id": 22006039,
      "workspaceId": "papercusp-workspace",
      "harnessSlug": null,
      "root": "/tmp/pcv/papercusp-lint-as-committed-2bbff3bf44-M5aTlI",
      "executionDetails": {
        "root": "/tmp/pcv/papercusp-lint-as-committed-2bbff3bf44-M5aTlI",
        "failed": 0,
        "passed": 14,
        "skipped": 0,
        "filePath": "apps/operator/lib/psu-identity-assume-native.integration.test.ts",
        "commitSha": "2bbff3bf44ad94fc5165c25d87793432c102ca26",
        "testLayer": "integration",
        "runGroupId": null,
        "harnessSlug": null,
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-10-25T12:34:25.765Z",
        "mutationPhase": null,
        "schemaVersion": 1,
        "worktreeDirty": false,
        "testNamePattern": null,
        "collectionFailed": false,
        "passedCaseTitles": [
          "discovers a deferred handoff tool before invoking an already advertised executor",
          "read-only context preview isolates an overlapping coordination writer",
          "preserves the original native failure and startup evidence after fixture cleanup",
          "resumes installed native target context and returns the caller on the same managed attachment (native-resume)",
          "resumes installed native target context and returns the caller on the same managed attachment (checkpoint)",
          "uses production custody and routed responsibilities through the installed native handoff (native-resume)",
          "uses production custody and routed responsibilities through the installed native handoff (checkpoint)",
          "admits exactly one of two installed native callers and preserves the losing caller responsibilities",
          "routes installed native target input output resize interrupt and exit through the inherited managed channel",
          "previews one exact ended target without writes and refuses live, foreign and unknown custody",
          "R-8 recovers persisted native handoff after managed host SIGKILL before target execution",
          "R-5 exact caller return restores input output resize interrupt and exit on the original pane",
          "R-1 delivers the invoking native tool response before fresh completion permits caller replacement",
          "R-8 recovers after target native writer acquisition and managed host SIGKILL before verification"
        ],
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      },
      "filePath": "apps/operator/lib/psu-identity-assume-native.integration.test.ts",
      "status": "pass",
      "framework": "vitest",
      "startedAt": "2026-10-25T12:34:50.801Z",
      "finishedAt": "2026-10-25T12:37:09.060Z",
      "durationMs": 138259,
      "commitSha": "2bbff3bf44ad94fc5165c25d87793432c102ca26",
      "runGroupId": null,
      "source": "local",
      "branch": null,
      "outputTail": null,
      "loopLagP95Ms": null,
      "rssMb": 694.1,
      "saturationSuspect": null,
      "worktreeDirty": false,
      "isScratchConfig": false,
      "cases": [
        {
          "caseKey": "discovers a deferred handoff tool before invoking an already advertised executor",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 3,
          "errorTail": null
        },
        {
          "caseKey": "read-only context preview isolates an overlapping coordination writer",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 1647,
          "errorTail": null
        },
        {
          "caseKey": "preserves the original native failure and startup evidence after fixture cleanup",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 1615,
          "errorTail": null
        },
        {
          "caseKey": "resumes installed native target context and returns the caller on the same managed attachment (native-resume)",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 2860,
          "errorTail": null
        },
        {
          "caseKey": "resumes installed native target context and returns the caller on the same managed attachment (checkpoint)",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 2817,
          "errorTail": null
        },
        {
          "caseKey": "uses production custody and routed responsibilities through the installed native handoff (native-resume)",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 24799,
          "errorTail": null
        },
        {
          "caseKey": "uses production custody and routed responsibilities through the installed native handoff (checkpoint)",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 10287,
          "errorTail": null
        },
        {
          "caseKey": "admits exactly one of two installed native callers and preserves the losing caller responsibilities",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 14024,
          "errorTail": null
        },
        {
          "caseKey": "routes installed native target input output resize interrupt and exit through the inherited managed channel",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 10557,
          "errorTail": null
        },
        {
          "caseKey": "previews one exact ended target without writes and refuses live, foreign and unknown custody",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 18461,
          "errorTail": null
        },
        {
          "caseKey": "R-8 recovers persisted native handoff after managed host SIGKILL before target execution",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 12311,
          "errorTail": null
        },
        {
          "caseKey": "R-5 exact caller return restores input output resize interrupt and exit on the original pane",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 14513,
          "errorTail": null
        },
        {
          "caseKey": "R-1 delivers the invoking native tool response before fresh completion permits caller replacement",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 12264,
          "errorTail": null
        },
        {
          "caseKey": "R-8 recovers after target native writer acquisition and managed host SIGKILL before verification",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 12040,
          "errorTail": null
        }
      ]
    }
  ],
  "_meta": {
    "explicitFullRequest": true,
    "format": "json",
    "_seeAlso": [
      {
        "tool": "testing:flakiness (is this red a known flake — cross-run flip rate)"
      },
      {
        "tool": "testing:run (actually run test files)"
      },
      {
        "tool": "dev:pipeline_position (is my change live / what is blocking it)"
      }
    ]
  }
}
