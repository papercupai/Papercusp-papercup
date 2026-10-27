---
rel_path: "audits/parked-agent-resumption-2026-10-09/resume397-r10-calibration-metadata-correction-424d5.json"
updated_at: 1792988990692
_body: "content"
---

{
  "schemaVersion": 1,
  "scope": "R10 only; no whole-plan or runtime acceptance",
  "diagnosis": "70938 omitted adequacy.testCases, so filtered calibration lacked a declared passing case scope. 70945 adds only the three exact measured failed assertions, all present as passing in same-invocation copy baseline22108640.",
  "unchangedTestRunId": 22108658,
  "noTestRerun": true,
  "selectedBindings": [
    70937,
    70945
  ],
  "evidence": {
    "ok": true,
    "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
    "harnessSlug": "papercusp",
    "bounded": {
      "limit": 10,
      "truncatedByLimit": false
    },
    "detail": "full",
    "evidence": [
      {
        "id": 70945,
        "workItemId": "WI-10008161",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-10-P-010",
        "sourceValId": null,
        "specRevision": 3,
        "currentRevision": 3,
        "specFingerprint": "aea9918a074a671f3d9705ead8208003b6ff4a8dbc2c834479e26a102d1cc2de",
        "evidenceKind": "mutation",
        "evidenceRef": "test-run 22108658 mutation-probe mutant fail packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts @56859cff637c",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:9f8b30a549761d9ee229a0c8df68b57549ca90432135cf89f3ea1f780aa72266",
          "testFingerprint": "sha256-file-set-v1:0024adf1c431373c08a56967ce6794ccc0fc69af4ef9b4b87cd7b8d1831834d5",
          "fixtureFingerprint": "sha256-file-set-v1:9e0bee9ff5996f21b7040f8d370fc6c5b55e88ccc443c5a303a37834a00aadaf",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 22108658,
        "testRunExecution": {
          "status": "fail",
          "passed": 1,
          "failed": 3,
          "skipped": 47,
          "collectionFailed": false,
          "testNamePattern": "P-010",
          "filePath": "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
          "passedCaseTitles": [],
          "testLayer": "integration",
          "passedCaseTitleCount": 1,
          "passedCaseTitlesOmitted": 1,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                22108658
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
          "framework": "vitest",
          "source": "mutation-probe",
          "mutationPhase": "mutant",
          "mutation": {
            "leg": "mutant",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/scheduler/claim-spec-store.ts\n+++ b/packages/operator-core/lib/scheduler/claim-spec-store.ts\n@@ -155,7 +155,7 @@\n  */\n export function isParkedOnExternalBlocker(row: { status: string | null; externalBlockers?: unknown }): boolean {\n   if (row.status !== 'blocked' && row.status !== 'needs-human') return false;\n-  return activeExternalBlockers({ externalBlockers: row.externalBlockers }).length > 0;\n+  return false;\n }\n \n /** One held row with its P-010 classification — the shape {@link getHeldClaimsForBee} returns. */\n",
            "subjectPath": "packages/operator-core/lib/scheduler/claim-spec-store.ts",
            "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts -t \"P-010\"",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "dc3d1bfb9c4d43975de099369b149c60a44930a0d42ee5e6143a17e57d3faff5",
            "mutateExpression": "s/\\Qreturn activeExternalBlockers({ externalBlockers: row.externalBlockers }).length > 0;\\E/return false;/",
            "probeInvocationId": "1d3e96ec-e5bf-4257-aaa4-3afd4df3a45d",
            "testCommandSha256": "9522101ef17f3cdf8b3674fb32954b002fe634e4300e2ed78a066e5f7871fc43",
            "subjectAfterSha256": "69057c3328f5c42e8852efadb7ae44753ca04e9067044a4eba2e9475c7f2fcbc",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "8d751659fb7af6f7d2b4efdfb66dc7a63fb364ec3441228b1b1f6d374415e93f"
          },
          "mutationBaseline": {
            "testRunId": 22108640,
            "status": "pass",
            "mutation": {
              "leg": "copy-baseline",
              "mode": "copy-out",
              "mutantDiff": "--- a/packages/operator-core/lib/scheduler/claim-spec-store.ts\n+++ b/packages/operator-core/lib/scheduler/claim-spec-store.ts\n@@ -155,7 +155,7 @@\n  */\n export function isParkedOnExternalBlocker(row: { status: string | null; externalBlockers?: unknown }): boolean {\n   if (row.status !== 'blocked' && row.status !== 'needs-human') return false;\n-  return activeExternalBlockers({ externalBlockers: row.externalBlockers }).length > 0;\n+  return false;\n }\n \n /** One held row with its P-010 classification — the shape {@link getHeldClaimsForBee} returns. */\n",
              "subjectPath": "packages/operator-core/lib/scheduler/claim-spec-store.ts",
              "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts -t \"P-010\"",
              "againstCommit": null,
              "schemaVersion": 1,
              "testFileSha256": "dc3d1bfb9c4d43975de099369b149c60a44930a0d42ee5e6143a17e57d3faff5",
              "mutateExpression": "s/\\Qreturn activeExternalBlockers({ externalBlockers: row.externalBlockers }).length > 0;\\E/return false;/",
              "probeInvocationId": "1d3e96ec-e5bf-4257-aaa4-3afd4df3a45d",
              "testCommandSha256": "9522101ef17f3cdf8b3674fb32954b002fe634e4300e2ed78a066e5f7871fc43",
              "subjectAfterSha256": "69057c3328f5c42e8852efadb7ae44753ca04e9067044a4eba2e9475c7f2fcbc",
              "mutantDiffTruncated": false,
              "subjectBeforeSha256": "8d751659fb7af6f7d2b4efdfb66dc7a63fb364ec3441228b1b1f6d374415e93f"
            },
            "passed": 4,
            "failed": 0,
            "skipped": 47,
            "collectionFailed": false,
            "passedCaseTitles": [
              "cup_claim_specs store (mig 372) > P-010 (D-010): a hold parked on a typed external blocker frees its concurrency slot > counts only the rows its holder is not parked on externally",
              "cup_claim_specs store (mig 372) > P-010 (D-010): a hold parked on a typed external blocker frees its concurrency slot > readClaimConcurrency names the parked rows and leaves them out of activeClaims",
              "cup_claim_specs store (mig 372) > P-010 (D-010): a hold parked on a typed external blocker frees its concurrency slot > readClaimConcurrencyBatch returns the same verdict as the single-bee reader",
              "cup_claim_specs store (mig 372) > P-010 (D-010): a hold parked on a typed external blocker frees its concurrency slot > Luna: clearing a typed blocker restores cap2 counting without changing custody or the member override"
            ]
          },
          "commitSha": "56859cff637cd26d472f6c2c35e0e1406053f792",
          "worktreeDirty": false,
          "mutationFailureLines": [
            "cup_claim_specs store (mig 372) > P-010 (D-010): a hold parked on a typed external blocker frees its concurrency slot > counts only the rows its holder is not parked on externally: (recorded failed assertion)",
            "cup_claim_specs store (mig 372) > P-010 (D-010): a hold parked on a typed external blocker frees its concurrency slot > readClaimConcurrency names the parked rows and leaves them out of activeClaims: (recorded failed assertion)",
            "cup_claim_specs store (mig 372) > P-010 (D-010): a hold parked on a typed external blocker frees its concurrency slot > Luna: clearing a typed blocker restores cap2 counting without changing custody or the member override: (recorded failed assertion)"
          ],
          "mutationFailedCaseTitles": [
            "cup_claim_specs store (mig 372) > P-010 (D-010): a hold parked on a typed external blocker frees its concurrency slot > counts only the rows its holder is not parked on externally",
            "cup_claim_specs store (mig 372) > P-010 (D-010): a hold parked on a typed external blocker frees its concurrency slot > readClaimConcurrency names the parked rows and leaves them out of activeClaims",
            "cup_claim_specs store (mig 372) > P-010 (D-010): a hold parked on a typed external blocker frees its concurrency slot > Luna: clearing a typed blocker restores cap2 counting without changing custody or the member override"
          ]
        },
        "details": {
          "testRun": {
            "id": 22108658,
            "source": "mutation-probe",
            "status": "fail",
            "filePath": "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
            "commitSha": "56859cff637cd26d472f6c2c35e0e1406053f792",
            "finishedAt": "2026-10-26T03:42:01.995Z",
            "asCommitted": {
              "commitSha": "56859cff637cd26d472f6c2c35e0e1406053f792",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-56859cff63-khq7Ae",
            "mutationPhase": "mutant",
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "caught",
            "skipped": false,
            "executed": true,
            "targeted": "auto-bar-r-10-p-010",
            "collected": true,
            "testCases": [
              "cup_claim_specs store (mig 372) > P-010 (D-010): a hold parked on a typed external blocker frees its concurrency slot > counts only the rows its holder is not parked on externally",
              "cup_claim_specs store (mig 372) > P-010 (D-010): a hold parked on a typed external blocker frees its concurrency slot > readClaimConcurrency names the parked rows and leaves them out of activeClaims",
              "cup_claim_specs store (mig 372) > P-010 (D-010): a hold parked on a typed external blocker frees its concurrency slot > Luna: clearing a typed blocker restores cap2 counting without changing custody or the member override"
            ],
            "testLayer": "integration",
            "coverageRungs": {
              "l3": true
            },
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "packages/operator-core/lib/external-blockers.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2a2d4a20a5b06ca92ae33d36b0e42d5e86ed1a4dd661ac90d8e01966a8044261",
                "headBlob": "6d04bed99388a6ce3d90c9ad0594c464abdfcdcd",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-spec-store.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8d751659fb7af6f7d2b4efdfb66dc7a63fb364ec3441228b1b1f6d374415e93f",
                "headBlob": "aedb066044139ed16fe6f66a4a43ff26b636085c",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-spec.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9504992049bfec34ee92b57b46c957b4cc8fbe2be4d3a4c2bc3852cf32a2da9e",
                "headBlob": "bc37710b3f1306284ac08264ecbb4f3fdb00309e",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/sync/hyperbee/projections/bee-claim-spec.ts",
                "repo": ".",
                "clean": true,
                "sha256": "a419dd308f7935479d23c945261c67cb6b015b4e8d5f05d81f9c139042a263bc",
                "headBlob": "59bac5e85c6381715d6b1fe96a7518038d130b64",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "dc3d1bfb9c4d43975de099369b149c60a44930a0d42ee5e6143a17e57d3faff5",
                "headBlob": "ba99d2c064469fdf607815c734b835090378a78e",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "dc3d1bfb9c4d43975de099369b149c60a44930a0d42ee5e6143a17e57d3faff5",
                "headBlob": "ba99d2c064469fdf607815c734b835090378a78e",
                "dimension": "fixture"
              },
              {
                "path": "packages/operator-core/test/_pg-helpers.ts",
                "repo": ".",
                "clean": true,
                "sha256": "67083d27aec0fe13c70e52488229f4baae470cbdad666ab092e0e82dc34a9700",
                "headBlob": "eff96fea50c11e960a6eae1bdaa485ea32c94f3f",
                "dimension": "fixture"
              },
              {
                "path": "packages/operator-core/test/_work-items-schema.ts",
                "repo": ".",
                "clean": true,
                "sha256": "aa5d0ec9a86a57fcfda746bd04deff4bc07d17ec8b4bcaab11a9aaad5637c798",
                "headBlob": "13c1d9fd766e6b3545f5fcfb9596e495273657eb",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "576352ec6bc3990653395b237ac345956d2bde3f",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts"
            ],
            "sourcePaths": [
              "packages/operator-core/lib/external-blockers.ts",
              "packages/operator-core/lib/scheduler/claim-spec-store.ts",
              "packages/operator-core/lib/scheduler/claim-spec.ts",
              "packages/operator-core/lib/sync/hyperbee/projections/bee-claim-spec.ts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
              "packages/operator-core/test/_pg-helpers.ts",
              "packages/operator-core/test/_work-items-schema.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-26T04:22:54.818Z",
        "bindingFingerprint": "f925a42fbde40e92f92badd3b6165e12ec4c1f3f1281d2ed82d217a5cdd0b7e4",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-26T04:22:54.707Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "f1856cf021f35e98799beb2921f0a78d8188dd9f",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-10-P-010",
            "specRevision": 3,
            "specFingerprint": "aea9918a074a671f3d9705ead8208003b6ff4a8dbc2c834479e26a102d1cc2de",
            "evidenceKind": "mutation",
            "evidenceRef": "test-run 22108658 mutation-probe mutant fail packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts @56859cff637c",
            "sourceFingerprint": "sha256-file-set-v1:9f8b30a549761d9ee229a0c8df68b57549ca90432135cf89f3ea1f780aa72266",
            "testFingerprint": "sha256-file-set-v1:0024adf1c431373c08a56967ce6794ccc0fc69af4ef9b4b87cd7b8d1831834d5",
            "fixtureFingerprint": "sha256-file-set-v1:9e0bee9ff5996f21b7040f8d370fc6c5b55e88ccc443c5a303a37834a00aadaf"
          }
        },
        "currentness": {
          "overall": "current",
          "dimensions": {
            "spec": "current",
            "source": "current",
            "test": "current",
            "fixture": "current",
            "rubric": "not-applicable",
            "environment": "not-applicable",
            "coverageEvidence": "not-applicable",
            "testRun": "current"
          },
          "staleReasons": [],
          "unknownReasons": [],
          "comparisonSupplied": true,
          "provenance": "server-measured"
        }
      },
      {
        "id": 70938,
        "workItemId": "WI-10008161",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-10-P-010",
        "sourceValId": null,
        "specRevision": 3,
        "currentRevision": 3,
        "specFingerprint": "aea9918a074a671f3d9705ead8208003b6ff4a8dbc2c834479e26a102d1cc2de",
        "evidenceKind": "mutation",
        "evidenceRef": "test-run 22108658 mutation-probe mutant fail packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts @56859cff637c",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:9f8b30a549761d9ee229a0c8df68b57549ca90432135cf89f3ea1f780aa72266",
          "testFingerprint": "sha256-file-set-v1:0024adf1c431373c08a56967ce6794ccc0fc69af4ef9b4b87cd7b8d1831834d5",
          "fixtureFingerprint": "sha256-file-set-v1:9e0bee9ff5996f21b7040f8d370fc6c5b55e88ccc443c5a303a37834a00aadaf",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 22108658,
        "testRunExecution": {
          "status": "fail",
          "passed": 1,
          "failed": 3,
          "skipped": 47,
          "collectionFailed": false,
          "testNamePattern": "P-010",
          "filePath": "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
          "passedCaseTitles": [],
          "testLayer": "integration",
          "passedCaseTitleCount": 1,
          "passedCaseTitlesOmitted": 1,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                22108658
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
          "framework": "vitest",
          "source": "mutation-probe",
          "mutationPhase": "mutant",
          "mutation": {
            "leg": "mutant",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/scheduler/claim-spec-store.ts\n+++ b/packages/operator-core/lib/scheduler/claim-spec-store.ts\n@@ -155,7 +155,7 @@\n  */\n export function isParkedOnExternalBlocker(row: { status: string | null; externalBlockers?: unknown }): boolean {\n   if (row.status !== 'blocked' && row.status !== 'needs-human') return false;\n-  return activeExternalBlockers({ externalBlockers: row.externalBlockers }).length > 0;\n+  return false;\n }\n \n /** One held row with its P-010 classification — the shape {@link getHeldClaimsForBee} returns. */\n",
            "subjectPath": "packages/operator-core/lib/scheduler/claim-spec-store.ts",
            "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts -t \"P-010\"",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "dc3d1bfb9c4d43975de099369b149c60a44930a0d42ee5e6143a17e57d3faff5",
            "mutateExpression": "s/\\Qreturn activeExternalBlockers({ externalBlockers: row.externalBlockers }).length > 0;\\E/return false;/",
            "probeInvocationId": "1d3e96ec-e5bf-4257-aaa4-3afd4df3a45d",
            "testCommandSha256": "9522101ef17f3cdf8b3674fb32954b002fe634e4300e2ed78a066e5f7871fc43",
            "subjectAfterSha256": "69057c3328f5c42e8852efadb7ae44753ca04e9067044a4eba2e9475c7f2fcbc",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "8d751659fb7af6f7d2b4efdfb66dc7a63fb364ec3441228b1b1f6d374415e93f"
          },
          "mutationBaseline": {
            "testRunId": 22108640,
            "status": "pass",
            "mutation": {
              "leg": "copy-baseline",
              "mode": "copy-out",
              "mutantDiff": "--- a/packages/operator-core/lib/scheduler/claim-spec-store.ts\n+++ b/packages/operator-core/lib/scheduler/claim-spec-store.ts\n@@ -155,7 +155,7 @@\n  */\n export function isParkedOnExternalBlocker(row: { status: string | null; externalBlockers?: unknown }): boolean {\n   if (row.status !== 'blocked' && row.status !== 'needs-human') return false;\n-  return activeExternalBlockers({ externalBlockers: row.externalBlockers }).length > 0;\n+  return false;\n }\n \n /** One held row with its P-010 classification — the shape {@link getHeldClaimsForBee} returns. */\n",
              "subjectPath": "packages/operator-core/lib/scheduler/claim-spec-store.ts",
              "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts -t \"P-010\"",
              "againstCommit": null,
              "schemaVersion": 1,
              "testFileSha256": "dc3d1bfb9c4d43975de099369b149c60a44930a0d42ee5e6143a17e57d3faff5",
              "mutateExpression": "s/\\Qreturn activeExternalBlockers({ externalBlockers: row.externalBlockers }).length > 0;\\E/return false;/",
              "probeInvocationId": "1d3e96ec-e5bf-4257-aaa4-3afd4df3a45d",
              "testCommandSha256": "9522101ef17f3cdf8b3674fb32954b002fe634e4300e2ed78a066e5f7871fc43",
              "subjectAfterSha256": "69057c3328f5c42e8852efadb7ae44753ca04e9067044a4eba2e9475c7f2fcbc",
              "mutantDiffTruncated": false,
              "subjectBeforeSha256": "8d751659fb7af6f7d2b4efdfb66dc7a63fb364ec3441228b1b1f6d374415e93f"
            },
            "passed": 4,
            "failed": 0,
            "skipped": 47,
            "collectionFailed": false,
            "passedCaseTitles": [
              "cup_claim_specs store (mig 372) > P-010 (D-010): a hold parked on a typed external blocker frees its concurrency slot > counts only the rows its holder is not parked on externally",
              "cup_claim_specs store (mig 372) > P-010 (D-010): a hold parked on a typed external blocker frees its concurrency slot > readClaimConcurrency names the parked rows and leaves them out of activeClaims",
              "cup_claim_specs store (mig 372) > P-010 (D-010): a hold parked on a typed external blocker frees its concurrency slot > readClaimConcurrencyBatch returns the same verdict as the single-bee reader",
              "cup_claim_specs store (mig 372) > P-010 (D-010): a hold parked on a typed external blocker frees its concurrency slot > Luna: clearing a typed blocker restores cap2 counting without changing custody or the member override"
            ]
          },
          "commitSha": "56859cff637cd26d472f6c2c35e0e1406053f792",
          "worktreeDirty": false,
          "mutationFailureLines": [
            "cup_claim_specs store (mig 372) > P-010 (D-010): a hold parked on a typed external blocker frees its concurrency slot > counts only the rows its holder is not parked on externally: (recorded failed assertion)",
            "cup_claim_specs store (mig 372) > P-010 (D-010): a hold parked on a typed external blocker frees its concurrency slot > readClaimConcurrency names the parked rows and leaves them out of activeClaims: (recorded failed assertion)",
            "cup_claim_specs store (mig 372) > P-010 (D-010): a hold parked on a typed external blocker frees its concurrency slot > Luna: clearing a typed blocker restores cap2 counting without changing custody or the member override: (recorded failed assertion)"
          ],
          "mutationFailedCaseTitles": [
            "cup_claim_specs store (mig 372) > P-010 (D-010): a hold parked on a typed external blocker frees its concurrency slot > counts only the rows its holder is not parked on externally",
            "cup_claim_specs store (mig 372) > P-010 (D-010): a hold parked on a typed external blocker frees its concurrency slot > readClaimConcurrency names the parked rows and leaves them out of activeClaims",
            "cup_claim_specs store (mig 372) > P-010 (D-010): a hold parked on a typed external blocker frees its concurrency slot > Luna: clearing a typed blocker restores cap2 counting without changing custody or the member override"
          ]
        },
        "details": {
          "testRun": {
            "id": 22108658,
            "source": "mutation-probe",
            "status": "fail",
            "filePath": "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
            "commitSha": "56859cff637cd26d472f6c2c35e0e1406053f792",
            "finishedAt": "2026-10-26T03:42:01.995Z",
            "asCommitted": {
              "commitSha": "56859cff637cd26d472f6c2c35e0e1406053f792",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-56859cff63-khq7Ae",
            "mutationPhase": "mutant",
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "caught",
            "skipped": false,
            "executed": true,
            "targeted": "auto-bar-r-10-p-010",
            "collected": true,
            "testLayer": "integration",
            "coverageRungs": {
              "l3": true
            },
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "packages/operator-core/lib/external-blockers.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2a2d4a20a5b06ca92ae33d36b0e42d5e86ed1a4dd661ac90d8e01966a8044261",
                "headBlob": "6d04bed99388a6ce3d90c9ad0594c464abdfcdcd",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-spec-store.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8d751659fb7af6f7d2b4efdfb66dc7a63fb364ec3441228b1b1f6d374415e93f",
                "headBlob": "aedb066044139ed16fe6f66a4a43ff26b636085c",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-spec.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9504992049bfec34ee92b57b46c957b4cc8fbe2be4d3a4c2bc3852cf32a2da9e",
                "headBlob": "bc37710b3f1306284ac08264ecbb4f3fdb00309e",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/sync/hyperbee/projections/bee-claim-spec.ts",
                "repo": ".",
                "clean": true,
                "sha256": "a419dd308f7935479d23c945261c67cb6b015b4e8d5f05d81f9c139042a263bc",
                "headBlob": "59bac5e85c6381715d6b1fe96a7518038d130b64",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "dc3d1bfb9c4d43975de099369b149c60a44930a0d42ee5e6143a17e57d3faff5",
                "headBlob": "ba99d2c064469fdf607815c734b835090378a78e",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "dc3d1bfb9c4d43975de099369b149c60a44930a0d42ee5e6143a17e57d3faff5",
                "headBlob": "ba99d2c064469fdf607815c734b835090378a78e",
                "dimension": "fixture"
              },
              {
                "path": "packages/operator-core/test/_pg-helpers.ts",
                "repo": ".",
                "clean": true,
                "sha256": "67083d27aec0fe13c70e52488229f4baae470cbdad666ab092e0e82dc34a9700",
                "headBlob": "eff96fea50c11e960a6eae1bdaa485ea32c94f3f",
                "dimension": "fixture"
              },
              {
                "path": "packages/operator-core/test/_work-items-schema.ts",
                "repo": ".",
                "clean": true,
                "sha256": "aa5d0ec9a86a57fcfda746bd04deff4bc07d17ec8b4bcaab11a9aaad5637c798",
                "headBlob": "13c1d9fd766e6b3545f5fcfb9596e495273657eb",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "576352ec6bc3990653395b237ac345956d2bde3f",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts"
            ],
            "sourcePaths": [
              "packages/operator-core/lib/external-blockers.ts",
              "packages/operator-core/lib/scheduler/claim-spec-store.ts",
              "packages/operator-core/lib/scheduler/claim-spec.ts",
              "packages/operator-core/lib/sync/hyperbee/projections/bee-claim-spec.ts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
              "packages/operator-core/test/_pg-helpers.ts",
              "packages/operator-core/test/_work-items-schema.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-26T03:43:44.744Z",
        "bindingFingerprint": "2a9364e138f154aa99d3e098471cd4b5b11f12358605d44222642449b2c1086c",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-26T03:43:44.534Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "f1856cf021f35e98799beb2921f0a78d8188dd9f",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-10-P-010",
            "specRevision": 3,
            "specFingerprint": "aea9918a074a671f3d9705ead8208003b6ff4a8dbc2c834479e26a102d1cc2de",
            "evidenceKind": "mutation",
            "evidenceRef": "test-run 22108658 mutation-probe mutant fail packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts @56859cff637c",
            "sourceFingerprint": "sha256-file-set-v1:9f8b30a549761d9ee229a0c8df68b57549ca90432135cf89f3ea1f780aa72266",
            "testFingerprint": "sha256-file-set-v1:0024adf1c431373c08a56967ce6794ccc0fc69af4ef9b4b87cd7b8d1831834d5",
            "fixtureFingerprint": "sha256-file-set-v1:9e0bee9ff5996f21b7040f8d370fc6c5b55e88ccc443c5a303a37834a00aadaf"
          }
        },
        "currentness": {
          "overall": "current",
          "dimensions": {
            "spec": "current",
            "source": "current",
            "test": "current",
            "fixture": "current",
            "rubric": "not-applicable",
            "environment": "not-applicable",
            "coverageEvidence": "not-applicable",
            "testRun": "current"
          },
          "staleReasons": [],
          "unknownReasons": [],
          "comparisonSupplied": true,
          "provenance": "server-measured"
        }
      },
      {
        "id": 70937,
        "workItemId": "WI-10008161",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-10-P-010",
        "sourceValId": null,
        "specRevision": 3,
        "currentRevision": 3,
        "specFingerprint": "aea9918a074a671f3d9705ead8208003b6ff4a8dbc2c834479e26a102d1cc2de",
        "evidenceKind": "test",
        "evidenceRef": "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:9f8b30a549761d9ee229a0c8df68b57549ca90432135cf89f3ea1f780aa72266",
          "testFingerprint": "sha256-file-set-v1:0024adf1c431373c08a56967ce6794ccc0fc69af4ef9b4b87cd7b8d1831834d5",
          "fixtureFingerprint": "sha256-file-set-v1:9e0bee9ff5996f21b7040f8d370fc6c5b55e88ccc443c5a303a37834a00aadaf",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 21869294,
        "testRunExecution": {
          "status": "pass",
          "passed": 51,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
          "passedCaseTitles": [],
          "testLayer": "integration",
          "passedCaseTitleCount": 51,
          "passedCaseTitlesOmitted": 51,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                21869294
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
          "framework": "vitest",
          "source": "local",
          "mutationPhase": null,
          "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 21869294,
            "source": "local",
            "status": "pass",
            "filePath": "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
            "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
            "finishedAt": "2026-10-24T05:44:13.644Z",
            "asCommitted": {
              "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-339c94acbe-OMAYfA",
            "mutationPhase": null,
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "collected": true,
            "testLayer": "integration",
            "fixtureCalibrated": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "packages/operator-core/lib/external-blockers.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2a2d4a20a5b06ca92ae33d36b0e42d5e86ed1a4dd661ac90d8e01966a8044261",
                "headBlob": "6d04bed99388a6ce3d90c9ad0594c464abdfcdcd",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-spec-store.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8d751659fb7af6f7d2b4efdfb66dc7a63fb364ec3441228b1b1f6d374415e93f",
                "headBlob": "aedb066044139ed16fe6f66a4a43ff26b636085c",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-spec.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9504992049bfec34ee92b57b46c957b4cc8fbe2be4d3a4c2bc3852cf32a2da9e",
                "headBlob": "bc37710b3f1306284ac08264ecbb4f3fdb00309e",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/sync/hyperbee/projections/bee-claim-spec.ts",
                "repo": ".",
                "clean": true,
                "sha256": "a419dd308f7935479d23c945261c67cb6b015b4e8d5f05d81f9c139042a263bc",
                "headBlob": "59bac5e85c6381715d6b1fe96a7518038d130b64",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "dc3d1bfb9c4d43975de099369b149c60a44930a0d42ee5e6143a17e57d3faff5",
                "headBlob": "ba99d2c064469fdf607815c734b835090378a78e",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "dc3d1bfb9c4d43975de099369b149c60a44930a0d42ee5e6143a17e57d3faff5",
                "headBlob": "ba99d2c064469fdf607815c734b835090378a78e",
                "dimension": "fixture"
              },
              {
                "path": "packages/operator-core/test/_pg-helpers.ts",
                "repo": ".",
                "clean": true,
                "sha256": "67083d27aec0fe13c70e52488229f4baae470cbdad666ab092e0e82dc34a9700",
                "headBlob": "eff96fea50c11e960a6eae1bdaa485ea32c94f3f",
                "dimension": "fixture"
              },
              {
                "path": "packages/operator-core/test/_work-items-schema.ts",
                "repo": ".",
                "clean": true,
                "sha256": "aa5d0ec9a86a57fcfda746bd04deff4bc07d17ec8b4bcaab11a9aaad5637c798",
                "headBlob": "13c1d9fd766e6b3545f5fcfb9596e495273657eb",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "e721d9f7bc0b69d8f7318660aa2d0ac048fd1571",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts"
            ],
            "sourcePaths": [
              "packages/operator-core/lib/external-blockers.ts",
              "packages/operator-core/lib/scheduler/claim-spec-store.ts",
              "packages/operator-core/lib/scheduler/claim-spec.ts",
              "packages/operator-core/lib/sync/hyperbee/projections/bee-claim-spec.ts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
              "packages/operator-core/test/_pg-helpers.ts",
              "packages/operator-core/test/_work-items-schema.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-26T03:39:04.868Z",
        "bindingFingerprint": "cbbd1aaf1bdabb5892a84da1dfedbd0aee92a7ed94ca8d5d457cb372e37608ec",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-26T03:39:04.768Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "f1856cf021f35e98799beb2921f0a78d8188dd9f",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-10-P-010",
            "specRevision": 3,
            "specFingerprint": "aea9918a074a671f3d9705ead8208003b6ff4a8dbc2c834479e26a102d1cc2de",
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
            "sourceFingerprint": "sha256-file-set-v1:9f8b30a549761d9ee229a0c8df68b57549ca90432135cf89f3ea1f780aa72266",
            "testFingerprint": "sha256-file-set-v1:0024adf1c431373c08a56967ce6794ccc0fc69af4ef9b4b87cd7b8d1831834d5",
            "fixtureFingerprint": "sha256-file-set-v1:9e0bee9ff5996f21b7040f8d370fc6c5b55e88ccc443c5a303a37834a00aadaf"
          }
        },
        "currentness": {
          "overall": "current",
          "dimensions": {
            "spec": "current",
            "source": "current",
            "test": "current",
            "fixture": "current",
            "rubric": "not-applicable",
            "environment": "not-applicable",
            "coverageEvidence": "not-applicable",
            "testRun": "current"
          },
          "staleReasons": [],
          "unknownReasons": [],
          "comparisonSupplied": true,
          "provenance": "server-measured"
        }
      }
    ],
    "count": 3,
    "currentness": {
      "current": 3,
      "stale": 0,
      "unknown": 0
    },
    "_meta": {
      "explicitFullRequest": true,
      "format": "json",
      "_seeAlso": [
        {
          "tool": "plans:bind-spec-evidence (append proof)"
        },
        {
          "tool": "plans:get-specs (canonical behavior)"
        }
      ]
    }
  },
  "evaluator": {
    "ok": true,
    "evaluatorBuild": {
      "sha": "1e104d3cf4",
      "version": "0.0.0"
    },
    "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
    "harnessSlug": "papercusp",
    "classRef": "plan-class-bugfix",
    "declaredClassRef": "plan-class-bugfix",
    "classRefSource": "active-acceptance-rubric",
    "rubricRef": "spec-test-adequacy",
    "governing": false,
    "includeDraft": false,
    "excludedDraftCount": 0,
    "excludedDraftSpecIds": [],
    "excludedClauses": [],
    "governingNote": "DIAGNOSTIC READ — the evidence cohort is PINNED (workItemIds/evidenceRefs/bindingIds). The ship gate evaluates every binding of each clause UNSCOPED, so a pass here is not the ship verdict; read plans:get { slug, shipReadiness:true } for the governing per-bar state.",
    "detail": "full",
    "rows": [
      {
        "evaluationMode": "mechanical",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-10-P-010",
        "specRevision": 3,
        "specFingerprint": "aea9918a074a671f3d9705ead8208003b6ff4a8dbc2c834479e26a102d1cc2de",
        "planItemId": "P-010",
        "verdict": "pass",
        "wouldBlock": [],
        "mechanicalProof": {
          "applicable": true,
          "verdict": "pass",
          "requiredFiles": [
            "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts"
          ],
          "passingTestBindingIds": {
            "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts": 70937
          },
          "caughtMutantBindingIds": [
            70945
          ],
          "gaps": []
        },
        "measurementEvidence": {
          "status": "measured",
          "selectedBindings": 2,
          "measuredBindings": 2,
          "unavailableBindings": [],
          "withoutMeasurementBasis": [],
          "bindings": [
            {
              "bindingId": 70937,
              "evidenceKind": "test",
              "evidenceRef": "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
              "status": "measured",
              "measuredAtCommit": "f1856cf021f35e98799beb2921f0a78d8188dd9f",
              "measurementFingerprint": "sha256:aa3efb3ccad37b127ffe2225819de4a33f17d70c414ce890fc3fd383b41e3263"
            },
            {
              "bindingId": 70945,
              "evidenceKind": "mutation",
              "evidenceRef": "test-run 22108658 mutation-probe mutant fail packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts @56859cff637c",
              "status": "measured",
              "measuredAtCommit": "f1856cf021f35e98799beb2921f0a78d8188dd9f",
              "measurementFingerprint": "sha256:aa3efb3ccad37b127ffe2225819de4a33f17d70c414ce890fc3fd383b41e3263"
            }
          ]
        }
      }
    ],
    "count": 1,
    "verdicts": {
      "pass": 1,
      "fail": 0,
      "unknown": 0
    },
    "wouldBlock": [],
    "uncoveredWorkItemSelection": null,
    "_meta": {
      "explicitFullRequest": true,
      "format": "json",
      "_seeAlso": [
        {
          "tool": "plans:get-spec-evidence"
        },
        {
          "tool": "scorecards:emit"
        },
        {
          "tool": "rubrics:get spec-test-adequacy"
        }
      ]
    }
  },
  "certification": {
    "build": "1e104d3cf4",
    "passing": 1,
    "mechanicallyVerified": 1,
    "filed": 0,
    "card": "not-required"
  },
  "log": "/tmp/parked-resume396-r10-mutation-424d5.log"
}
