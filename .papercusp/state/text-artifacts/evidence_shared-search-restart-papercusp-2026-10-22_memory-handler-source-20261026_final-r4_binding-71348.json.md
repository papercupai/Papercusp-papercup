---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/memory-handler-source-20261026/final-r4/binding-71348.json"
updated_at: 1793042550500
_body: "content"
---

{
  "bindingRequest": {
    "workItemId": "WI-6554700010022135",
    "specId": "SEARCH-FRESHNESS-BOUNDARIES",
    "specRevision": 2,
    "fromTestRun": 22247225,
    "sourcePaths": [
      "packages/operator-core/lib/agent-tools/memory/search.ts",
      "packages/operator-core/lib/blueprint/package-memory-visibility.ts",
      "packages/operator-core/lib/memory/workspace-scope-recall.ts",
      "libs/generic/memory/src/hybrid-backend.ts",
      "libs/generic/memory/src/mem0-backend.ts",
      "libs/generic/memory/src/canonical-store.ts"
    ],
    "fixturePaths": [
      "packages/operator-core/lib/agent-tools/memory/handler-source-freshness.integration.test.ts",
      "packages/operator-core/test/_pg-helpers.ts"
    ],
    "details": {
      "contributingOnly": true,
      "summary": "Original final-r4 actual memory:search handler capture; contributing evidence only, not full freshness/P001 acceptance.",
      "artifactsPrefix": "evidence/shared-search-restart-papercusp-2026-10-22/memory-handler-source-20261026/final-r4/",
      "nativeReceiptId": "c93e02d5-6c9d-40cb-9112-562af6594690",
      "observations": {
        "testFileCommit": "d7515b8b1edc7016dac6de243613b9514edb2f76",
        "testFileSha256": "79d9fef2b734c9c1a1b11e33d4628dba8c87c5e3d054ab820772100e4cc96d2a",
        "allSevenSavedSourcePinsMatchCommittedAndWorking": true,
        "fieldCurrentness": "unknown"
      },
      "adequacy": {
        "fixtureCalibrated": true,
        "testLayer": "integration",
        "pathReachable": true,
        "falsifiable": true,
        "disclosedGap": "Controlled user/wearer/principal, registry, flags, embeddings, ancillary ranking inputs and single-scope client facade. Production transport authentication, authority epochs/provider freshness, ingestion/index completeness, native Mem0 entity boosting, quality, budgets and shipped runtime proof remain open. This local fixture cannot discharge the complete clause."
      }
    }
  },
  "bindingReceipt": {
    "ok": true,
    "results": [
      {
        "ok": true,
        "slug": "shared-search-restart-papercusp-2026-10-22",
        "derivedFromTestRun": {
          "testRunId": 22247225,
          "evidenceKind": "test",
          "evidenceRef": "packages/operator-core/lib/agent-tools/memory/handler-source-freshness.integration.test.ts",
          "measurement": {
            "schemaVersion": 1,
            "kind": "repo-files",
            "sourcePaths": [
              "libs/generic/memory/src/canonical-store.ts",
              "libs/generic/memory/src/hybrid-backend.ts",
              "libs/generic/memory/src/mem0-backend.ts",
              "packages/operator-core/lib/agent-tools/memory/search.ts",
              "packages/operator-core/lib/blueprint/package-memory-visibility.ts",
              "packages/operator-core/lib/memory/workspace-scope-recall.ts"
            ],
            "testPaths": [
              "packages/operator-core/lib/agent-tools/memory/handler-source-freshness.integration.test.ts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/agent-tools/memory/handler-source-freshness.integration.test.ts",
              "packages/operator-core/test/_pg-helpers.ts"
            ]
          },
          "harnessAttribution": "run"
        },
        "status": "created",
        "id": 71348,
        "workItemId": "WI-6554700010022135",
        "planSlug": "shared-search-restart-papercusp-2026-10-22",
        "specId": "SEARCH-FRESHNESS-BOUNDARIES",
        "sourceValId": null,
        "specRevision": 2,
        "specFingerprint": "46df5bf08c870e835807cb57f2d6d4475879b519706414512e1a06c112984347",
        "bindingFingerprint": "14f7a089a18ae097fd16ec74e02c7006f600dcfec8924f477dd591ad958f00c7"
      }
    ],
    "counts": {
      "ok": 1,
      "failed": 0
    }
  },
  "readback": {
    "ok": true,
    "slug": "shared-search-restart-papercusp-2026-10-22",
    "harnessSlug": "papercusp",
    "bounded": {
      "limit": 1,
      "truncatedByLimit": false
    },
    "detail": "full",
    "evidence": [
      {
        "id": 71348,
        "workItemId": "WI-6554700010022135",
        "planSlug": "shared-search-restart-papercusp-2026-10-22",
        "specId": "SEARCH-FRESHNESS-BOUNDARIES",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "46df5bf08c870e835807cb57f2d6d4475879b519706414512e1a06c112984347",
        "evidenceKind": "test",
        "evidenceRef": "packages/operator-core/lib/agent-tools/memory/handler-source-freshness.integration.test.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:79a2a4e587ff7f78e984061bf986b5d5033725672ea6f74e75e2bcf14ccc13a6",
          "testFingerprint": "sha256-file-set-v1:ab9d78e1b5f1f3313964f21a383f3ceea77633c606aecb212f79dbe2ec36e773",
          "fixtureFingerprint": "sha256-file-set-v1:a089502a75824b115d4706cd6ee2899b1aad6a468a1097e31f2ebca331e5fb90",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 22247225,
        "testRunExecution": {
          "status": "pass",
          "passed": 4,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/agent-tools/memory/handler-source-freshness.integration.test.ts",
          "passedCaseTitles": [],
          "testLayer": "integration",
          "passedCaseTitleCount": 4,
          "passedCaseTitlesOmitted": 4,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                22247225
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/agent-tools/memory/handler-source-freshness.integration.test.ts",
          "framework": "vitest",
          "source": "local",
          "mutationPhase": null,
          "commitSha": "82c8e15b190f87c57cabedfc5035d03589152982",
          "worktreeDirty": true
        },
        "details": {
          "summary": "Original final-r4 actual memory:search handler capture; contributing evidence only, not full freshness/P001 acceptance.",
          "testRun": {
            "id": 22247225,
            "source": "local",
            "status": "pass",
            "filePath": "packages/operator-core/lib/agent-tools/memory/handler-source-freshness.integration.test.ts",
            "commitSha": "82c8e15b190f87c57cabedfc5035d03589152982",
            "finishedAt": "2026-10-26T18:29:16.012Z",
            "recordedRoot": "/home/marsh-office/papercupai-workspace/papercusp",
            "mutationPhase": null,
            "worktreeDirty": true,
            "recordedFilePath": "packages/operator-core/lib/agent-tools/memory/handler-source-freshness.integration.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "collected": true,
            "testLayer": "integration",
            "falsifiable": true,
            "disclosedGap": "Controlled user/wearer/principal, registry, flags, embeddings, ancillary ranking inputs and single-scope client facade. Production transport authentication, authority epochs/provider freshness, ingestion/index completeness, native Mem0 entity boosting, quality, budgets and shipped runtime proof remain open. This local fixture cannot discharge the complete clause.",
            "pathReachable": true,
            "fixtureCalibrated": true
          },
          "observations": {
            "testFileCommit": "d7515b8b1edc7016dac6de243613b9514edb2f76",
            "testFileSha256": "79d9fef2b734c9c1a1b11e33d4628dba8c87c5e3d054ab820772100e4cc96d2a",
            "fieldCurrentness": "unknown",
            "allSevenSavedSourcePinsMatchCommittedAndWorking": true
          },
          "measurementPin": {
            "files": [
              {
                "path": "libs/generic/memory/src/canonical-store.ts",
                "repo": "libs/generic/memory",
                "clean": true,
                "sha256": "7cf2de83231645f3bbd5decf57ad06a0b45495ddeb78b19c780781ff3cb53f62",
                "headBlob": "879f2b736915f379d5489780a9a70e3be7d48189",
                "dimension": "source"
              },
              {
                "path": "libs/generic/memory/src/hybrid-backend.ts",
                "repo": "libs/generic/memory",
                "clean": true,
                "sha256": "effa0f3b1541c4ced6d619f006bbb083a378dfb04228adba25e545ede9347073",
                "headBlob": "fcb95042e27210d620dfaa3a861a9c9a8d4571d1",
                "dimension": "source"
              },
              {
                "path": "libs/generic/memory/src/mem0-backend.ts",
                "repo": "libs/generic/memory",
                "clean": true,
                "sha256": "d55c88135e858615eb6aae35972d5ef30261c10f3fa3aa601602a811cf0a85e1",
                "headBlob": "9c68e8ec3bd73d207fc2ffeca5dbc0a6a3c4cd57",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/memory/search.ts",
                "repo": ".",
                "clean": true,
                "sha256": "82e61cb6794055d1e3ee325ecb05d65228cef635117521e115cb9b77e0fe258e",
                "headBlob": "45eff4ec4a688c9984a5917225dfdf5a14b6911e",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/blueprint/package-memory-visibility.ts",
                "repo": ".",
                "clean": true,
                "sha256": "34238137bd9a2dfcdc17fb6e759b48ba8dbbf1e8577ea6f2b9fcffe2f92dbd39",
                "headBlob": "64f00efa24aede154fc2a008849b529b7684a900",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/memory/workspace-scope-recall.ts",
                "repo": ".",
                "clean": true,
                "sha256": "eb1c371a2f3a7f3319ea7c349c7b3f40f237a22b61ce46388ebca2bbd2c38c00",
                "headBlob": "926750bb0a617889188227d1a6bea759b60d4246",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/memory/handler-source-freshness.integration.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "79d9fef2b734c9c1a1b11e33d4628dba8c87c5e3d054ab820772100e4cc96d2a",
                "headBlob": "851feccde7efbd76f72cac5f69d3966cf370b3f0",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/memory/handler-source-freshness.integration.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "79d9fef2b734c9c1a1b11e33d4628dba8c87c5e3d054ab820772100e4cc96d2a",
                "headBlob": "851feccde7efbd76f72cac5f69d3966cf370b3f0",
                "dimension": "fixture",
                "rootHarnessSlug": "papercusp"
              },
              {
                "path": "packages/operator-core/test/_pg-helpers.ts",
                "repo": ".",
                "clean": true,
                "sha256": "d1bf71dfc7c76e7b0f93f1a0670230704af300277ff7b9a3459f1f94ee78803c",
                "headBlob": "0f22bc91ef0145c1dfe561e3373294fcfef1e188",
                "dimension": "fixture",
                "rootHarnessSlug": "papercusp"
              }
            ],
            "repos": [
              {
                "head": "69d65a470984ac49f56e52d0a0632173db9254ee",
                "repo": ".",
                "gitlink": null
              },
              {
                "head": "fe9878936d3da86d872fc1a5fdd29877e903d1f0",
                "repo": "libs/generic/memory",
                "gitlink": "fe9878936d3da86d872fc1a5fdd29877e903d1f0"
              },
              {
                "head": "69d65a470984ac49f56e52d0a0632173db9254ee",
                "repo": ".",
                "gitlink": null,
                "rootHarnessSlug": "papercusp"
              }
            ],
            "schemaVersion": 1
          },
          "artifactsPrefix": "evidence/shared-search-restart-papercusp-2026-10-22/memory-handler-source-20261026/final-r4/",
          "nativeReceiptId": "c93e02d5-6c9d-40cb-9112-562af6594690",
          "contributingOnly": true,
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/agent-tools/memory/handler-source-freshness.integration.test.ts"
            ],
            "sourcePaths": [
              "libs/generic/memory/src/canonical-store.ts",
              "libs/generic/memory/src/hybrid-backend.ts",
              "libs/generic/memory/src/mem0-backend.ts",
              "packages/operator-core/lib/agent-tools/memory/search.ts",
              "packages/operator-core/lib/blueprint/package-memory-visibility.ts",
              "packages/operator-core/lib/memory/workspace-scope-recall.ts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/agent-tools/memory/handler-source-freshness.integration.test.ts",
              "packages/operator-core/test/_pg-helpers.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-26T19:19:02.668Z",
        "bindingFingerprint": "14f7a089a18ae097fd16ec74e02c7006f600dcfec8924f477dd591ad958f00c7",
        "createdBy": "su-45e55f4b-3b99-466a-85fb-973108f644c9",
        "createdAt": "2026-10-26T19:19:02.564Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "69d65a470984ac49f56e52d0a0632173db9254ee",
          "current": {
            "planSlug": "shared-search-restart-papercusp-2026-10-22",
            "specId": "SEARCH-FRESHNESS-BOUNDARIES",
            "specRevision": 2,
            "specFingerprint": "46df5bf08c870e835807cb57f2d6d4475879b519706414512e1a06c112984347",
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/agent-tools/memory/handler-source-freshness.integration.test.ts",
            "sourceFingerprint": "sha256-file-set-v1:79a2a4e587ff7f78e984061bf986b5d5033725672ea6f74e75e2bcf14ccc13a6",
            "testFingerprint": "sha256-file-set-v1:ab9d78e1b5f1f3313964f21a383f3ceea77633c606aecb212f79dbe2ec36e773",
            "fixtureFingerprint": "sha256-file-set-v1:a089502a75824b115d4706cd6ee2899b1aad6a468a1097e31f2ebca331e5fb90"
          }
        },
        "currentness": {
          "overall": "unknown",
          "dimensions": {
            "spec": "current",
            "source": "current",
            "test": "current",
            "fixture": "current",
            "rubric": "not-applicable",
            "environment": "not-applicable",
            "coverageEvidence": "not-applicable",
            "testRun": "unknown"
          },
          "staleReasons": [],
          "unknownReasons": [
            "test-run-worktree-not-clean"
          ],
          "comparisonSupplied": true,
          "provenance": "server-measured"
        }
      }
    ],
    "count": 1,
    "currentness": {
      "current": 0,
      "stale": 0,
      "unknown": 1
    }
  }
}

