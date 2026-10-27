---
rel_path: "evidence/luna-capacity/source-bindings-339c94-20261024.json"
updated_at: 1792823016177
_body: "content"
---

{
  "status": "source-evidence-only-not-shipment",
  "bindingIds": [
    68545,
    68546,
    68547,
    68548,
    68549,
    68550,
    68527,
    68528,
    68529,
    68530,
    68531,
    68532,
    68533,
    68534,
    68535,
    68536,
    68537,
    68538,
    68554,
    68555,
    68556,
    68557,
    68558,
    68559
  ],
  "evidence": {
    "ok": true,
    "slug": "luna-drain-capacity-recovery-2026-10-23",
    "harnessSlug": "papercusp",
    "bounded": {
      "limit": 30,
      "truncatedByLimit": false
    },
    "detail": "full",
    "evidence": [
      {
        "id": 68559,
        "workItemId": "WI-6554700010025538",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "AUTO-BAR-R-4-P-004",
        "sourceValId": null,
        "specRevision": 4,
        "currentRevision": 4,
        "specFingerprint": "5282833d6544e041b8b06ea2be5d7fd2627873b1badc9679abe352b57c76ba9f",
        "evidenceKind": "mutation",
        "evidenceRef": "test-run 21869857 mutation-probe mutant fail packages/operator-core/lib/agent-tools/events/watch.test.ts @339c94acbed6",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:0ea13bffb340badd75d0cf3447cd370ec854b14c52416613bd12ed6db9518e16",
          "testFingerprint": "sha256-file-set-v1:6ae25d06990957a511426346d45157a8a9a9288cb46f3bc76e11c87059c474ce",
          "fixtureFingerprint": "sha256-file-set-v1:6ae25d06990957a511426346d45157a8a9a9288cb46f3bc76e11c87059c474ce",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 21869857,
        "testRunExecution": {
          "status": "fail",
          "passed": 0,
          "failed": 1,
          "skipped": 41,
          "collectionFailed": false,
          "testNamePattern": "the drained-lane contract is IDEMPOTENT",
          "filePath": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
          "testLayer": "unit"
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
          "framework": "vitest",
          "source": "mutation-probe",
          "mutationPhase": "mutant",
          "mutation": {
            "leg": "mutant",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/agent-tools/events/watch.ts\n+++ b/packages/operator-core/lib/agent-tools/events/watch.ts\n@@ -202,7 +202,7 @@\n \n /** Shared with the behavioral SU experiment so it consumes the delivered protocol. */\n export function claimableWatchBeforeSleep(pattern: string, once: boolean) {\n-  return !once && pattern === 'work-item:claimable'\n+  return false && pattern === 'work-item:claimable'\n     ? { tool: 'scheduler:get_next', required: true,\n         afterMiss: { tool: 'loop:end', required: true },\n         reason: 'Re-run scheduler:get_next BEFORE sleeping: work may predate this watch or arrive during registration. Continue on a claim; only a verified miss permits loop:end to stop the timer loop and end your turn, with this standing watch retained.' }\n",
            "subjectPath": "packages/operator-core/lib/agent-tools/events/watch.ts",
            "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/agent-tools/events/watch.test.ts -t \"the drained-lane contract is IDEMPOTENT\"",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "b4aa0e9fc9b936e7b4b1bc3d0030dc1e62badc6854548cf3e147d280fee79bc8",
            "mutateExpression": "s/return !once && pattern ===/return false \\&\\& pattern ===/",
            "probeInvocationId": "465e43d6-3135-4e4d-aab4-c0ec5b4de163",
            "testCommandSha256": "d2c80fc668e697d9fbfcd87874d15cb2ce0f2b932aa8ee088b084f5f1c189eb9",
            "subjectAfterSha256": "2d18ccadf73993214dad3d70e0348cd73ea46cd08c9c3d8bf33b5c99b1f2b3b8",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "b9a4c3aff8a14d01e94407c8760a1df8a25536743fc50eaea739fd08cdfb218a"
          },
          "mutationBaseline": {
            "testRunId": 21869854,
            "status": "pass",
            "mutation": {
              "leg": "copy-baseline",
              "mode": "copy-out",
              "mutantDiff": "--- a/packages/operator-core/lib/agent-tools/events/watch.ts\n+++ b/packages/operator-core/lib/agent-tools/events/watch.ts\n@@ -202,7 +202,7 @@\n \n /** Shared with the behavioral SU experiment so it consumes the delivered protocol. */\n export function claimableWatchBeforeSleep(pattern: string, once: boolean) {\n-  return !once && pattern === 'work-item:claimable'\n+  return false && pattern === 'work-item:claimable'\n     ? { tool: 'scheduler:get_next', required: true,\n         afterMiss: { tool: 'loop:end', required: true },\n         reason: 'Re-run scheduler:get_next BEFORE sleeping: work may predate this watch or arrive during registration. Continue on a claim; only a verified miss permits loop:end to stop the timer loop and end your turn, with this standing watch retained.' }\n",
              "subjectPath": "packages/operator-core/lib/agent-tools/events/watch.ts",
              "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/agent-tools/events/watch.test.ts -t \"the drained-lane contract is IDEMPOTENT\"",
              "againstCommit": null,
              "schemaVersion": 1,
              "testFileSha256": "b4aa0e9fc9b936e7b4b1bc3d0030dc1e62badc6854548cf3e147d280fee79bc8",
              "mutateExpression": "s/return !once && pattern ===/return false \\&\\& pattern ===/",
              "probeInvocationId": "465e43d6-3135-4e4d-aab4-c0ec5b4de163",
              "testCommandSha256": "d2c80fc668e697d9fbfcd87874d15cb2ce0f2b932aa8ee088b084f5f1c189eb9",
              "subjectAfterSha256": "2d18ccadf73993214dad3d70e0348cd73ea46cd08c9c3d8bf33b5c99b1f2b3b8",
              "mutantDiffTruncated": false,
              "subjectBeforeSha256": "b9a4c3aff8a14d01e94407c8760a1df8a25536743fc50eaea739fd08cdfb218a"
            },
            "passed": 1,
            "failed": 0,
            "skipped": 41,
            "collectionFailed": false,
            "passedCaseTitles": [
              "WI-10005697: standing pattern watch dedupe > the drained-lane contract is IDEMPOTENT: the identical standing watch twice yields ONE row + a deduped marker"
            ]
          },
          "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
          "worktreeDirty": false,
          "mutationFailureLines": [
            "WI-10005697: standing pattern watch dedupe > the drained-lane contract is IDEMPOTENT: the identical standing watch twice yields ONE row + a deduped marker: (recorded failed assertion)"
          ],
          "mutationFailedCaseTitles": [
            "WI-10005697: standing pattern watch dedupe > the drained-lane contract is IDEMPOTENT: the identical standing watch twice yields ONE row + a deduped marker"
          ]
        },
        "details": {
          "testRun": {
            "id": 21869857,
            "source": "mutation-probe",
            "status": "fail",
            "filePath": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
            "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
            "finishedAt": "2026-10-24T06:21:46.824Z",
            "asCommitted": {
              "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-339c94acbe-TnuSO3",
            "mutationPhase": "mutant",
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "caught",
            "skipped": false,
            "executed": true,
            "targeted": "AUTO-BAR-R-4-P-004",
            "collected": true,
            "testCases": [
              "WI-10005697: standing pattern watch dedupe > the drained-lane contract is IDEMPOTENT: the identical standing watch twice yields ONE row + a deduped marker"
            ],
            "testLayer": "unit",
            "falsifiable": true,
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "cdb059d89031bfdcd5a8f6f249aee4a883618579d333d0c46941c3b5eda16b66",
                "headBlob": "ad8bea9cf067c6c804746bae5a80460532ad8f5a",
                "dimension": "source"
              },
              {
                "path": "libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts/fleet-posture.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "72597f9cda7e159e49451249196dc3134368bed844e807781c4a412753e55170",
                "headBlob": "4ae91e731b93a1f69e7121de8004b1a8adaa9873",
                "dimension": "source"
              },
              {
                "path": "libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "6dcae35526f7dd1f29954c8da11eaf5dff8e1648232811b9e1494d0e04686496",
                "headBlob": "49d5e62fb879657718e88f4aabee5c1627a56bb7",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/events/watch.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b9a4c3aff8a14d01e94407c8760a1df8a25536743fc50eaea739fd08cdfb218a",
                "headBlob": "e7f5387a1660636732f52532961478e3be339eb4",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/scheduler/get_next.ts",
                "repo": ".",
                "clean": true,
                "sha256": "0cffc0daf039c4bc08b863a0fbc4e5ebd8c2968795a6ab4ad008eb6d63e898c6",
                "headBlob": "8cebbd738d58ae45066ada67abe5bd7c0b3180d8",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "repo": ".",
                "clean": true,
                "sha256": "bb108bbdc66b207a44155c6e3dfb6b37d85a4e3f3bffe3fdecafc6bfacb0301e",
                "headBlob": "1420766e3acf71d1e99610963df770b45faf1313",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/desktop-install/papercusp-files.ts",
                "repo": ".",
                "clean": true,
                "sha256": "ad031013ee30a357805e47c2ed16c5868f1351d2ad2e855fe3330b0ac653e06b",
                "headBlob": "c2c38da10ff912c6c634cd8073681dbe423f4f8d",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/fleet/capacity-recovery-evidence.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2507f43aab26678eac4372d35d3a4c9373b64d49cda389e4d963834fd50d8f5d",
                "headBlob": "c881fcaba3748c7ae3cd8273eeb8742732fd7e54",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/loop.ts",
                "repo": ".",
                "clean": true,
                "sha256": "612c811ac21d6ec20d2f04da2c25ae04d563aea7b496ad6db475dddfe7541a99",
                "headBlob": "ccb93fd05bbcca7edabefa810a3fe7d4e5d8831b",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b88e6705b4f415781ea81af19da1bdd25ac08d547432849612b07f9ee261713",
                "headBlob": "dc8e2644c30e62424c3cc11437007a94ea6b7949",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b08b2336b5046b985edee0914b9bff88319b32aaffd1cf62bca8e75c7e11427",
                "headBlob": "ed65fdaf7e6c7c9e300c6c3ba52769bca82084ef",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/targets/su.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9ecfb6c3139fbf4b6cd4524e51432e36d216f4283d09e4f9c338a85067ccc04d",
                "headBlob": "9591c7a33bbaef7fa95d509d6b7ee393c741fcd1",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/test-run-ledger.ts",
                "repo": ".",
                "clean": true,
                "sha256": "0189f069b512736e7e3104a957e55c2570154c4fcde754cedf6cfbd65f473795",
                "headBlob": "7bc4f6456a3f6832ad2265a91c38f190f43bcd7a",
                "dimension": "source"
              },
              {
                "path": "scripts/verify-fleet-capacity-recovery.mts",
                "repo": ".",
                "clean": true,
                "sha256": "4a431ede6616f70cc0498b046ce05d776a2872c49d81a59647040919565ddec6",
                "headBlob": "1e568ef85803553eb697f09d8ae2e12a2967feca",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b4aa0e9fc9b936e7b4b1bc3d0030dc1e62badc6854548cf3e147d280fee79bc8",
                "headBlob": "5fe8ce8e5c31601f7b2df53d2ba2519897ae72d4",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b4aa0e9fc9b936e7b4b1bc3d0030dc1e62badc6854548cf3e147d280fee79bc8",
                "headBlob": "5fe8ce8e5c31601f7b2df53d2ba2519897ae72d4",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
                "repo": ".",
                "gitlink": null
              },
              {
                "head": "594cacf4fcd237efa597df1f40534f0cdd7a936e",
                "repo": "libs/papercusp",
                "gitlink": "594cacf4fcd237efa597df1f40534f0cdd7a936e"
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/agent-tools/events/watch.test.ts"
            ],
            "sourcePaths": [
              "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
              "libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts/fleet-posture.md",
              "libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md",
              "packages/operator-core/lib/agent-tools/events/watch.ts",
              "packages/operator-core/lib/agent-tools/scheduler/get_next.ts",
              "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
              "packages/operator-core/lib/desktop-install/papercusp-files.ts",
              "packages/operator-core/lib/fleet/capacity-recovery-evidence.ts",
              "packages/operator-core/lib/harness/routines/loop.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
              "packages/operator-core/lib/llm-testing/targets/su.ts",
              "packages/operator-core/lib/llm-testing/test-run-ledger.ts",
              "scripts/verify-fleet-capacity-recovery.mts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/agent-tools/events/watch.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-24T06:22:59.590Z",
        "bindingFingerprint": "e671bd1b044636ac368669633a245766ff93e5657e15e66fbd99a3bd0af89dea",
        "createdBy": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "createdAt": "2026-10-24T06:22:59.574Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
          "current": {
            "planSlug": "luna-drain-capacity-recovery-2026-10-23",
            "specId": "AUTO-BAR-R-4-P-004",
            "specRevision": 4,
            "specFingerprint": "5282833d6544e041b8b06ea2be5d7fd2627873b1badc9679abe352b57c76ba9f",
            "evidenceKind": "mutation",
            "evidenceRef": "test-run 21869857 mutation-probe mutant fail packages/operator-core/lib/agent-tools/events/watch.test.ts @339c94acbed6",
            "sourceFingerprint": "sha256-file-set-v1:0ea13bffb340badd75d0cf3447cd370ec854b14c52416613bd12ed6db9518e16",
            "testFingerprint": "sha256-file-set-v1:6ae25d06990957a511426346d45157a8a9a9288cb46f3bc76e11c87059c474ce",
            "fixtureFingerprint": "sha256-file-set-v1:6ae25d06990957a511426346d45157a8a9a9288cb46f3bc76e11c87059c474ce"
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
        "id": 68558,
        "workItemId": "WI-6554700010025538",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "LUNA-CAPACITY-004",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "f25ed6fc1f7f3685371124be89743c7f7c7dadf6d2db4dea132efc77d8c3cf9c",
        "evidenceKind": "mutation",
        "evidenceRef": "test-run 21869857 mutation-probe mutant fail packages/operator-core/lib/agent-tools/events/watch.test.ts @339c94acbed6",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:0ea13bffb340badd75d0cf3447cd370ec854b14c52416613bd12ed6db9518e16",
          "testFingerprint": "sha256-file-set-v1:6ae25d06990957a511426346d45157a8a9a9288cb46f3bc76e11c87059c474ce",
          "fixtureFingerprint": "sha256-file-set-v1:6ae25d06990957a511426346d45157a8a9a9288cb46f3bc76e11c87059c474ce",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 21869857,
        "testRunExecution": {
          "status": "fail",
          "passed": 0,
          "failed": 1,
          "skipped": 41,
          "collectionFailed": false,
          "testNamePattern": "the drained-lane contract is IDEMPOTENT",
          "filePath": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
          "testLayer": "unit"
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
          "framework": "vitest",
          "source": "mutation-probe",
          "mutationPhase": "mutant",
          "mutation": {
            "leg": "mutant",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/agent-tools/events/watch.ts\n+++ b/packages/operator-core/lib/agent-tools/events/watch.ts\n@@ -202,7 +202,7 @@\n \n /** Shared with the behavioral SU experiment so it consumes the delivered protocol. */\n export function claimableWatchBeforeSleep(pattern: string, once: boolean) {\n-  return !once && pattern === 'work-item:claimable'\n+  return false && pattern === 'work-item:claimable'\n     ? { tool: 'scheduler:get_next', required: true,\n         afterMiss: { tool: 'loop:end', required: true },\n         reason: 'Re-run scheduler:get_next BEFORE sleeping: work may predate this watch or arrive during registration. Continue on a claim; only a verified miss permits loop:end to stop the timer loop and end your turn, with this standing watch retained.' }\n",
            "subjectPath": "packages/operator-core/lib/agent-tools/events/watch.ts",
            "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/agent-tools/events/watch.test.ts -t \"the drained-lane contract is IDEMPOTENT\"",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "b4aa0e9fc9b936e7b4b1bc3d0030dc1e62badc6854548cf3e147d280fee79bc8",
            "mutateExpression": "s/return !once && pattern ===/return false \\&\\& pattern ===/",
            "probeInvocationId": "465e43d6-3135-4e4d-aab4-c0ec5b4de163",
            "testCommandSha256": "d2c80fc668e697d9fbfcd87874d15cb2ce0f2b932aa8ee088b084f5f1c189eb9",
            "subjectAfterSha256": "2d18ccadf73993214dad3d70e0348cd73ea46cd08c9c3d8bf33b5c99b1f2b3b8",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "b9a4c3aff8a14d01e94407c8760a1df8a25536743fc50eaea739fd08cdfb218a"
          },
          "mutationBaseline": {
            "testRunId": 21869854,
            "status": "pass",
            "mutation": {
              "leg": "copy-baseline",
              "mode": "copy-out",
              "mutantDiff": "--- a/packages/operator-core/lib/agent-tools/events/watch.ts\n+++ b/packages/operator-core/lib/agent-tools/events/watch.ts\n@@ -202,7 +202,7 @@\n \n /** Shared with the behavioral SU experiment so it consumes the delivered protocol. */\n export function claimableWatchBeforeSleep(pattern: string, once: boolean) {\n-  return !once && pattern === 'work-item:claimable'\n+  return false && pattern === 'work-item:claimable'\n     ? { tool: 'scheduler:get_next', required: true,\n         afterMiss: { tool: 'loop:end', required: true },\n         reason: 'Re-run scheduler:get_next BEFORE sleeping: work may predate this watch or arrive during registration. Continue on a claim; only a verified miss permits loop:end to stop the timer loop and end your turn, with this standing watch retained.' }\n",
              "subjectPath": "packages/operator-core/lib/agent-tools/events/watch.ts",
              "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/agent-tools/events/watch.test.ts -t \"the drained-lane contract is IDEMPOTENT\"",
              "againstCommit": null,
              "schemaVersion": 1,
              "testFileSha256": "b4aa0e9fc9b936e7b4b1bc3d0030dc1e62badc6854548cf3e147d280fee79bc8",
              "mutateExpression": "s/return !once && pattern ===/return false \\&\\& pattern ===/",
              "probeInvocationId": "465e43d6-3135-4e4d-aab4-c0ec5b4de163",
              "testCommandSha256": "d2c80fc668e697d9fbfcd87874d15cb2ce0f2b932aa8ee088b084f5f1c189eb9",
              "subjectAfterSha256": "2d18ccadf73993214dad3d70e0348cd73ea46cd08c9c3d8bf33b5c99b1f2b3b8",
              "mutantDiffTruncated": false,
              "subjectBeforeSha256": "b9a4c3aff8a14d01e94407c8760a1df8a25536743fc50eaea739fd08cdfb218a"
            },
            "passed": 1,
            "failed": 0,
            "skipped": 41,
            "collectionFailed": false,
            "passedCaseTitles": [
              "WI-10005697: standing pattern watch dedupe > the drained-lane contract is IDEMPOTENT: the identical standing watch twice yields ONE row + a deduped marker"
            ]
          },
          "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
          "worktreeDirty": false,
          "mutationFailureLines": [
            "WI-10005697: standing pattern watch dedupe > the drained-lane contract is IDEMPOTENT: the identical standing watch twice yields ONE row + a deduped marker: (recorded failed assertion)"
          ],
          "mutationFailedCaseTitles": [
            "WI-10005697: standing pattern watch dedupe > the drained-lane contract is IDEMPOTENT: the identical standing watch twice yields ONE row + a deduped marker"
          ]
        },
        "details": {
          "testRun": {
            "id": 21869857,
            "source": "mutation-probe",
            "status": "fail",
            "filePath": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
            "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
            "finishedAt": "2026-10-24T06:21:46.824Z",
            "asCommitted": {
              "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-339c94acbe-TnuSO3",
            "mutationPhase": "mutant",
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "caught",
            "skipped": false,
            "executed": true,
            "targeted": "LUNA-CAPACITY-004",
            "collected": true,
            "testCases": [
              "WI-10005697: standing pattern watch dedupe > the drained-lane contract is IDEMPOTENT: the identical standing watch twice yields ONE row + a deduped marker"
            ],
            "testLayer": "unit",
            "falsifiable": true,
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "cdb059d89031bfdcd5a8f6f249aee4a883618579d333d0c46941c3b5eda16b66",
                "headBlob": "ad8bea9cf067c6c804746bae5a80460532ad8f5a",
                "dimension": "source"
              },
              {
                "path": "libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts/fleet-posture.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "72597f9cda7e159e49451249196dc3134368bed844e807781c4a412753e55170",
                "headBlob": "4ae91e731b93a1f69e7121de8004b1a8adaa9873",
                "dimension": "source"
              },
              {
                "path": "libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "6dcae35526f7dd1f29954c8da11eaf5dff8e1648232811b9e1494d0e04686496",
                "headBlob": "49d5e62fb879657718e88f4aabee5c1627a56bb7",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/events/watch.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b9a4c3aff8a14d01e94407c8760a1df8a25536743fc50eaea739fd08cdfb218a",
                "headBlob": "e7f5387a1660636732f52532961478e3be339eb4",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/scheduler/get_next.ts",
                "repo": ".",
                "clean": true,
                "sha256": "0cffc0daf039c4bc08b863a0fbc4e5ebd8c2968795a6ab4ad008eb6d63e898c6",
                "headBlob": "8cebbd738d58ae45066ada67abe5bd7c0b3180d8",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "repo": ".",
                "clean": true,
                "sha256": "bb108bbdc66b207a44155c6e3dfb6b37d85a4e3f3bffe3fdecafc6bfacb0301e",
                "headBlob": "1420766e3acf71d1e99610963df770b45faf1313",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/desktop-install/papercusp-files.ts",
                "repo": ".",
                "clean": true,
                "sha256": "ad031013ee30a357805e47c2ed16c5868f1351d2ad2e855fe3330b0ac653e06b",
                "headBlob": "c2c38da10ff912c6c634cd8073681dbe423f4f8d",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/fleet/capacity-recovery-evidence.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2507f43aab26678eac4372d35d3a4c9373b64d49cda389e4d963834fd50d8f5d",
                "headBlob": "c881fcaba3748c7ae3cd8273eeb8742732fd7e54",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/loop.ts",
                "repo": ".",
                "clean": true,
                "sha256": "612c811ac21d6ec20d2f04da2c25ae04d563aea7b496ad6db475dddfe7541a99",
                "headBlob": "ccb93fd05bbcca7edabefa810a3fe7d4e5d8831b",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b88e6705b4f415781ea81af19da1bdd25ac08d547432849612b07f9ee261713",
                "headBlob": "dc8e2644c30e62424c3cc11437007a94ea6b7949",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b08b2336b5046b985edee0914b9bff88319b32aaffd1cf62bca8e75c7e11427",
                "headBlob": "ed65fdaf7e6c7c9e300c6c3ba52769bca82084ef",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/targets/su.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9ecfb6c3139fbf4b6cd4524e51432e36d216f4283d09e4f9c338a85067ccc04d",
                "headBlob": "9591c7a33bbaef7fa95d509d6b7ee393c741fcd1",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/test-run-ledger.ts",
                "repo": ".",
                "clean": true,
                "sha256": "0189f069b512736e7e3104a957e55c2570154c4fcde754cedf6cfbd65f473795",
                "headBlob": "7bc4f6456a3f6832ad2265a91c38f190f43bcd7a",
                "dimension": "source"
              },
              {
                "path": "scripts/verify-fleet-capacity-recovery.mts",
                "repo": ".",
                "clean": true,
                "sha256": "4a431ede6616f70cc0498b046ce05d776a2872c49d81a59647040919565ddec6",
                "headBlob": "1e568ef85803553eb697f09d8ae2e12a2967feca",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b4aa0e9fc9b936e7b4b1bc3d0030dc1e62badc6854548cf3e147d280fee79bc8",
                "headBlob": "5fe8ce8e5c31601f7b2df53d2ba2519897ae72d4",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b4aa0e9fc9b936e7b4b1bc3d0030dc1e62badc6854548cf3e147d280fee79bc8",
                "headBlob": "5fe8ce8e5c31601f7b2df53d2ba2519897ae72d4",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
                "repo": ".",
                "gitlink": null
              },
              {
                "head": "594cacf4fcd237efa597df1f40534f0cdd7a936e",
                "repo": "libs/papercusp",
                "gitlink": "594cacf4fcd237efa597df1f40534f0cdd7a936e"
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/agent-tools/events/watch.test.ts"
            ],
            "sourcePaths": [
              "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
              "libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts/fleet-posture.md",
              "libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md",
              "packages/operator-core/lib/agent-tools/events/watch.ts",
              "packages/operator-core/lib/agent-tools/scheduler/get_next.ts",
              "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
              "packages/operator-core/lib/desktop-install/papercusp-files.ts",
              "packages/operator-core/lib/fleet/capacity-recovery-evidence.ts",
              "packages/operator-core/lib/harness/routines/loop.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
              "packages/operator-core/lib/llm-testing/targets/su.ts",
              "packages/operator-core/lib/llm-testing/test-run-ledger.ts",
              "scripts/verify-fleet-capacity-recovery.mts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/agent-tools/events/watch.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-24T06:22:59.234Z",
        "bindingFingerprint": "3c09b0b27efa741437dbde23d6c17f7a6b00caa5e3dd844ce2db6364f0008bd7",
        "createdBy": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "createdAt": "2026-10-24T06:22:59.223Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
          "current": {
            "planSlug": "luna-drain-capacity-recovery-2026-10-23",
            "specId": "LUNA-CAPACITY-004",
            "specRevision": 2,
            "specFingerprint": "f25ed6fc1f7f3685371124be89743c7f7c7dadf6d2db4dea132efc77d8c3cf9c",
            "evidenceKind": "mutation",
            "evidenceRef": "test-run 21869857 mutation-probe mutant fail packages/operator-core/lib/agent-tools/events/watch.test.ts @339c94acbed6",
            "sourceFingerprint": "sha256-file-set-v1:0ea13bffb340badd75d0cf3447cd370ec854b14c52416613bd12ed6db9518e16",
            "testFingerprint": "sha256-file-set-v1:6ae25d06990957a511426346d45157a8a9a9288cb46f3bc76e11c87059c474ce",
            "fixtureFingerprint": "sha256-file-set-v1:6ae25d06990957a511426346d45157a8a9a9288cb46f3bc76e11c87059c474ce"
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
        "id": 68557,
        "workItemId": "WI-6554700010025537",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "AUTO-BAR-R-3-P-003",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "6734dc1ca3433cfda849ea3bc8a41034f7428dbb9d76c63fc8be8d4be677ff3a",
        "evidenceKind": "mutation",
        "evidenceRef": "test-run 21869861 mutation-probe mutant fail packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts @339c94acbed6",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:b4df721fa2bccf463982fee8067af7e5d645a937ff9c0bff4743407e32bbce4a",
          "testFingerprint": "sha256-file-set-v1:cf5a6e1817e904102be14b77bbd0b8b4a051ec1dde51fffbddce76ae7ebfa6b6",
          "fixtureFingerprint": "sha256-file-set-v1:cf5a6e1817e904102be14b77bbd0b8b4a051ec1dde51fffbddce76ae7ebfa6b6",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 21869861,
        "testRunExecution": {
          "status": "fail",
          "passed": 0,
          "failed": 1,
          "skipped": 283,
          "collectionFailed": false,
          "testNamePattern": "gives required lane health the existing diagnostic budget",
          "filePath": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
          "testLayer": "unit"
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
          "framework": "vitest",
          "source": "mutation-probe",
          "mutationPhase": "mutant",
          "mutation": {
            "leg": "mutant",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/agent-tools/fleet/leader-brief.ts\n+++ b/packages/operator-core/lib/agent-tools/fleet/leader-brief.ts\n@@ -628,7 +628,7 @@\n ): Promise<FleetLaneHealthReadResult> {\n   return read({\n     ...input,\n-    issueFamilyTotalBudgetMs: FLEET_SCOPE_ISSUE_DIAG_DEFAULT_TOTAL_BUDGET_MS,\n+    issueFamilyTotalBudgetMs: 750,\n   });\n }\n \n@@ -737,7 +737,7 @@\n   const read = await (deps?.lane ?? readClaimSpecLaneHealthDiagnosed)({\n     spec: record.spec, record, fleet: input.fleet, harness,\n     workspaceId: input.workspaceId, assignee: input.member, matchedBy: record.source,\n-    issueFamilyTotalBudgetMs: FLEET_SCOPE_ISSUE_DIAG_DEFAULT_TOTAL_BUDGET_MS,\n+    issueFamilyTotalBudgetMs: 750,\n   });\n   return {\n     concurrency,\n",
            "subjectPath": "packages/operator-core/lib/agent-tools/fleet/leader-brief.ts",
            "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts -t \"gives required lane health the existing diagnostic budget\"",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "19fa50db2a443421900f73ed8cbe1c8fd64dc734dead84fe3adf0ef0eeb131ca",
            "mutateExpression": "s/issueFamilyTotalBudgetMs: FLEET_SCOPE_ISSUE_DIAG_DEFAULT_TOTAL_BUDGET_MS,/issueFamilyTotalBudgetMs: 750,/",
            "probeInvocationId": "f4afcfd0-68f2-4fe2-9710-e1c50ea9fe09",
            "testCommandSha256": "d181209467eac905fc1ba3d0b97e705e2f38a08a5bde1eec6fb84ba3cac1c04e",
            "subjectAfterSha256": "d96c49c2258c4aa7507c4f09c3773a7754953e9311c290829a5912e39bd55167",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "fbfe51b7c60fa8c817047b79655ecfbbf3ef7604a28bf0711b73ec9da0f8a526"
          },
          "mutationBaseline": {
            "testRunId": 21869851,
            "status": "pass",
            "mutation": {
              "leg": "copy-baseline",
              "mode": "copy-out",
              "mutantDiff": "--- a/packages/operator-core/lib/agent-tools/fleet/leader-brief.ts\n+++ b/packages/operator-core/lib/agent-tools/fleet/leader-brief.ts\n@@ -628,7 +628,7 @@\n ): Promise<FleetLaneHealthReadResult> {\n   return read({\n     ...input,\n-    issueFamilyTotalBudgetMs: FLEET_SCOPE_ISSUE_DIAG_DEFAULT_TOTAL_BUDGET_MS,\n+    issueFamilyTotalBudgetMs: 750,\n   });\n }\n \n@@ -737,7 +737,7 @@\n   const read = await (deps?.lane ?? readClaimSpecLaneHealthDiagnosed)({\n     spec: record.spec, record, fleet: input.fleet, harness,\n     workspaceId: input.workspaceId, assignee: input.member, matchedBy: record.source,\n-    issueFamilyTotalBudgetMs: FLEET_SCOPE_ISSUE_DIAG_DEFAULT_TOTAL_BUDGET_MS,\n+    issueFamilyTotalBudgetMs: 750,\n   });\n   return {\n     concurrency,\n",
              "subjectPath": "packages/operator-core/lib/agent-tools/fleet/leader-brief.ts",
              "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts -t \"gives required lane health the existing diagnostic budget\"",
              "againstCommit": null,
              "schemaVersion": 1,
              "testFileSha256": "19fa50db2a443421900f73ed8cbe1c8fd64dc734dead84fe3adf0ef0eeb131ca",
              "mutateExpression": "s/issueFamilyTotalBudgetMs: FLEET_SCOPE_ISSUE_DIAG_DEFAULT_TOTAL_BUDGET_MS,/issueFamilyTotalBudgetMs: 750,/",
              "probeInvocationId": "f4afcfd0-68f2-4fe2-9710-e1c50ea9fe09",
              "testCommandSha256": "d181209467eac905fc1ba3d0b97e705e2f38a08a5bde1eec6fb84ba3cac1c04e",
              "subjectAfterSha256": "d96c49c2258c4aa7507c4f09c3773a7754953e9311c290829a5912e39bd55167",
              "mutantDiffTruncated": false,
              "subjectBeforeSha256": "fbfe51b7c60fa8c817047b79655ecfbbf3ef7604a28bf0711b73ec9da0f8a526"
            },
            "passed": 1,
            "failed": 0,
            "skipped": 283,
            "collectionFailed": false,
            "passedCaseTitles": [
              "fleet:leader-brief bounded read fan-out (EI-21577690778811728) > gives required lane health the existing diagnostic budget and keeps a typed recovery fallback"
            ]
          },
          "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
          "worktreeDirty": false,
          "mutationFailureLines": [
            "fleet:leader-brief bounded read fan-out (EI-21577690778811728) > gives required lane health the existing diagnostic budget and keeps a typed recovery fallback: (recorded failed assertion)"
          ],
          "mutationFailedCaseTitles": [
            "fleet:leader-brief bounded read fan-out (EI-21577690778811728) > gives required lane health the existing diagnostic budget and keeps a typed recovery fallback"
          ]
        },
        "details": {
          "testRun": {
            "id": 21869861,
            "source": "mutation-probe",
            "status": "fail",
            "filePath": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
            "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
            "finishedAt": "2026-10-24T06:21:56.734Z",
            "asCommitted": {
              "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-339c94acbe-TnuSO3",
            "mutationPhase": "mutant",
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "caught",
            "skipped": false,
            "executed": true,
            "targeted": "AUTO-BAR-R-3-P-003",
            "collected": true,
            "testCases": [
              "fleet:leader-brief bounded read fan-out (EI-21577690778811728) > gives required lane health the existing diagnostic budget and keeps a typed recovery fallback"
            ],
            "testLayer": "unit",
            "falsifiable": true,
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "packages/operator-core/lib/agent-tools/fleet/assignments.ts",
                "repo": ".",
                "clean": true,
                "sha256": "6a095d9baa4a2d67ee9d315ddc4da285ecf314e501c1750d074a6e29d1f37d06",
                "headBlob": "06d5b140edf590313372671c10e6f87e6e5decd0",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/fleet/leader-brief-aggregate.ts",
                "repo": ".",
                "clean": true,
                "sha256": "5004d63e2bcba55325ef7def0446fbcdc792cd6f065c833dde21ef55c57324aa",
                "headBlob": "3f0b4e008bfeca6fd33c6f2a126eaef292e85c43",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/fleet/leader-brief-shape.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b4b1d301a7648fcc1fb2ba6a4724b4e09d9383b2a303df25f8f0d7a3c4cb1d8b",
                "headBlob": "1c8dc94586012ff72bb64d7f290eb63602014e75",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/fleet/leader-brief.ts",
                "repo": ".",
                "clean": true,
                "sha256": "fbfe51b7c60fa8c817047b79655ecfbbf3ef7604a28bf0711b73ec9da0f8a526",
                "headBlob": "011056110df847047baaa0abe92177ccd4854147",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/fleet/stalled-item-rotation.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9893ba7aabafc0874fea46f8c3dd58848fe2a3bb8a536752f951e7d2b785d0ff",
                "headBlob": "77d676de65d8a7329025cb6267a2dbd0f65ce1ae",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/bounded-timeout.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b4d04cb6fadc97d36e7bc3677eef8f38f759836dd5fc5c54f0259bba0c1e61f3",
                "headBlob": "15c3602648e865bec40bce87f771fc027a818920",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/degradation/fallback-observations.ts",
                "repo": ".",
                "clean": true,
                "sha256": "fbd8ffde80f427b999147a8e3107e2770e42b443aeacd7b4ae9edbaa8cb1110a",
                "headBlob": "e92b0de1ca6fe23201c837897da89787f3b108fb",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/fleet-member-idle-verdict.ts",
                "repo": ".",
                "clean": true,
                "sha256": "04073851046cae02ddc79013731c6441ce619a3118c2a81871e889ff3a2fc5ad",
                "headBlob": "9e7be6cd44e17f9cafa915fc7b5c086160810e97",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "19fa50db2a443421900f73ed8cbe1c8fd64dc734dead84fe3adf0ef0eeb131ca",
                "headBlob": "0e0db3811682b95a386364022c59d5bda7386030",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "19fa50db2a443421900f73ed8cbe1c8fd64dc734dead84fe3adf0ef0eeb131ca",
                "headBlob": "0e0db3811682b95a386364022c59d5bda7386030",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts"
            ],
            "sourcePaths": [
              "packages/operator-core/lib/agent-tools/fleet/assignments.ts",
              "packages/operator-core/lib/agent-tools/fleet/leader-brief-aggregate.ts",
              "packages/operator-core/lib/agent-tools/fleet/leader-brief-shape.ts",
              "packages/operator-core/lib/agent-tools/fleet/leader-brief.ts",
              "packages/operator-core/lib/agent-tools/fleet/stalled-item-rotation.ts",
              "packages/operator-core/lib/bounded-timeout.ts",
              "packages/operator-core/lib/degradation/fallback-observations.ts",
              "packages/operator-core/lib/fleet-member-idle-verdict.ts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-24T06:22:58.878Z",
        "bindingFingerprint": "a444c7ca0a1b006e0d8a36d73e586d2bce6fc92eb946e53a421b5a00d90352d2",
        "createdBy": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "createdAt": "2026-10-24T06:22:58.872Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
          "current": {
            "planSlug": "luna-drain-capacity-recovery-2026-10-23",
            "specId": "AUTO-BAR-R-3-P-003",
            "specRevision": 2,
            "specFingerprint": "6734dc1ca3433cfda849ea3bc8a41034f7428dbb9d76c63fc8be8d4be677ff3a",
            "evidenceKind": "mutation",
            "evidenceRef": "test-run 21869861 mutation-probe mutant fail packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts @339c94acbed6",
            "sourceFingerprint": "sha256-file-set-v1:b4df721fa2bccf463982fee8067af7e5d645a937ff9c0bff4743407e32bbce4a",
            "testFingerprint": "sha256-file-set-v1:cf5a6e1817e904102be14b77bbd0b8b4a051ec1dde51fffbddce76ae7ebfa6b6",
            "fixtureFingerprint": "sha256-file-set-v1:cf5a6e1817e904102be14b77bbd0b8b4a051ec1dde51fffbddce76ae7ebfa6b6"
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
        "id": 68556,
        "workItemId": "WI-6554700010025537",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "LUNA-CAPACITY-003",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "a68b685e6f4d51241eab4d9494c8533ca0d80d696bd37c7fc545cbee83ee4235",
        "evidenceKind": "mutation",
        "evidenceRef": "test-run 21869861 mutation-probe mutant fail packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts @339c94acbed6",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:b4df721fa2bccf463982fee8067af7e5d645a937ff9c0bff4743407e32bbce4a",
          "testFingerprint": "sha256-file-set-v1:cf5a6e1817e904102be14b77bbd0b8b4a051ec1dde51fffbddce76ae7ebfa6b6",
          "fixtureFingerprint": "sha256-file-set-v1:cf5a6e1817e904102be14b77bbd0b8b4a051ec1dde51fffbddce76ae7ebfa6b6",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 21869861,
        "testRunExecution": {
          "status": "fail",
          "passed": 0,
          "failed": 1,
          "skipped": 283,
          "collectionFailed": false,
          "testNamePattern": "gives required lane health the existing diagnostic budget",
          "filePath": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
          "testLayer": "unit"
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
          "framework": "vitest",
          "source": "mutation-probe",
          "mutationPhase": "mutant",
          "mutation": {
            "leg": "mutant",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/agent-tools/fleet/leader-brief.ts\n+++ b/packages/operator-core/lib/agent-tools/fleet/leader-brief.ts\n@@ -628,7 +628,7 @@\n ): Promise<FleetLaneHealthReadResult> {\n   return read({\n     ...input,\n-    issueFamilyTotalBudgetMs: FLEET_SCOPE_ISSUE_DIAG_DEFAULT_TOTAL_BUDGET_MS,\n+    issueFamilyTotalBudgetMs: 750,\n   });\n }\n \n@@ -737,7 +737,7 @@\n   const read = await (deps?.lane ?? readClaimSpecLaneHealthDiagnosed)({\n     spec: record.spec, record, fleet: input.fleet, harness,\n     workspaceId: input.workspaceId, assignee: input.member, matchedBy: record.source,\n-    issueFamilyTotalBudgetMs: FLEET_SCOPE_ISSUE_DIAG_DEFAULT_TOTAL_BUDGET_MS,\n+    issueFamilyTotalBudgetMs: 750,\n   });\n   return {\n     concurrency,\n",
            "subjectPath": "packages/operator-core/lib/agent-tools/fleet/leader-brief.ts",
            "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts -t \"gives required lane health the existing diagnostic budget\"",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "19fa50db2a443421900f73ed8cbe1c8fd64dc734dead84fe3adf0ef0eeb131ca",
            "mutateExpression": "s/issueFamilyTotalBudgetMs: FLEET_SCOPE_ISSUE_DIAG_DEFAULT_TOTAL_BUDGET_MS,/issueFamilyTotalBudgetMs: 750,/",
            "probeInvocationId": "f4afcfd0-68f2-4fe2-9710-e1c50ea9fe09",
            "testCommandSha256": "d181209467eac905fc1ba3d0b97e705e2f38a08a5bde1eec6fb84ba3cac1c04e",
            "subjectAfterSha256": "d96c49c2258c4aa7507c4f09c3773a7754953e9311c290829a5912e39bd55167",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "fbfe51b7c60fa8c817047b79655ecfbbf3ef7604a28bf0711b73ec9da0f8a526"
          },
          "mutationBaseline": {
            "testRunId": 21869851,
            "status": "pass",
            "mutation": {
              "leg": "copy-baseline",
              "mode": "copy-out",
              "mutantDiff": "--- a/packages/operator-core/lib/agent-tools/fleet/leader-brief.ts\n+++ b/packages/operator-core/lib/agent-tools/fleet/leader-brief.ts\n@@ -628,7 +628,7 @@\n ): Promise<FleetLaneHealthReadResult> {\n   return read({\n     ...input,\n-    issueFamilyTotalBudgetMs: FLEET_SCOPE_ISSUE_DIAG_DEFAULT_TOTAL_BUDGET_MS,\n+    issueFamilyTotalBudgetMs: 750,\n   });\n }\n \n@@ -737,7 +737,7 @@\n   const read = await (deps?.lane ?? readClaimSpecLaneHealthDiagnosed)({\n     spec: record.spec, record, fleet: input.fleet, harness,\n     workspaceId: input.workspaceId, assignee: input.member, matchedBy: record.source,\n-    issueFamilyTotalBudgetMs: FLEET_SCOPE_ISSUE_DIAG_DEFAULT_TOTAL_BUDGET_MS,\n+    issueFamilyTotalBudgetMs: 750,\n   });\n   return {\n     concurrency,\n",
              "subjectPath": "packages/operator-core/lib/agent-tools/fleet/leader-brief.ts",
              "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts -t \"gives required lane health the existing diagnostic budget\"",
              "againstCommit": null,
              "schemaVersion": 1,
              "testFileSha256": "19fa50db2a443421900f73ed8cbe1c8fd64dc734dead84fe3adf0ef0eeb131ca",
              "mutateExpression": "s/issueFamilyTotalBudgetMs: FLEET_SCOPE_ISSUE_DIAG_DEFAULT_TOTAL_BUDGET_MS,/issueFamilyTotalBudgetMs: 750,/",
              "probeInvocationId": "f4afcfd0-68f2-4fe2-9710-e1c50ea9fe09",
              "testCommandSha256": "d181209467eac905fc1ba3d0b97e705e2f38a08a5bde1eec6fb84ba3cac1c04e",
              "subjectAfterSha256": "d96c49c2258c4aa7507c4f09c3773a7754953e9311c290829a5912e39bd55167",
              "mutantDiffTruncated": false,
              "subjectBeforeSha256": "fbfe51b7c60fa8c817047b79655ecfbbf3ef7604a28bf0711b73ec9da0f8a526"
            },
            "passed": 1,
            "failed": 0,
            "skipped": 283,
            "collectionFailed": false,
            "passedCaseTitles": [
              "fleet:leader-brief bounded read fan-out (EI-21577690778811728) > gives required lane health the existing diagnostic budget and keeps a typed recovery fallback"
            ]
          },
          "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
          "worktreeDirty": false,
          "mutationFailureLines": [
            "fleet:leader-brief bounded read fan-out (EI-21577690778811728) > gives required lane health the existing diagnostic budget and keeps a typed recovery fallback: (recorded failed assertion)"
          ],
          "mutationFailedCaseTitles": [
            "fleet:leader-brief bounded read fan-out (EI-21577690778811728) > gives required lane health the existing diagnostic budget and keeps a typed recovery fallback"
          ]
        },
        "details": {
          "testRun": {
            "id": 21869861,
            "source": "mutation-probe",
            "status": "fail",
            "filePath": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
            "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
            "finishedAt": "2026-10-24T06:21:56.734Z",
            "asCommitted": {
              "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-339c94acbe-TnuSO3",
            "mutationPhase": "mutant",
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "caught",
            "skipped": false,
            "executed": true,
            "targeted": "LUNA-CAPACITY-003",
            "collected": true,
            "testCases": [
              "fleet:leader-brief bounded read fan-out (EI-21577690778811728) > gives required lane health the existing diagnostic budget and keeps a typed recovery fallback"
            ],
            "testLayer": "unit",
            "falsifiable": true,
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "packages/operator-core/lib/agent-tools/fleet/assignments.ts",
                "repo": ".",
                "clean": true,
                "sha256": "6a095d9baa4a2d67ee9d315ddc4da285ecf314e501c1750d074a6e29d1f37d06",
                "headBlob": "06d5b140edf590313372671c10e6f87e6e5decd0",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/fleet/leader-brief-aggregate.ts",
                "repo": ".",
                "clean": true,
                "sha256": "5004d63e2bcba55325ef7def0446fbcdc792cd6f065c833dde21ef55c57324aa",
                "headBlob": "3f0b4e008bfeca6fd33c6f2a126eaef292e85c43",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/fleet/leader-brief-shape.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b4b1d301a7648fcc1fb2ba6a4724b4e09d9383b2a303df25f8f0d7a3c4cb1d8b",
                "headBlob": "1c8dc94586012ff72bb64d7f290eb63602014e75",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/fleet/leader-brief.ts",
                "repo": ".",
                "clean": true,
                "sha256": "fbfe51b7c60fa8c817047b79655ecfbbf3ef7604a28bf0711b73ec9da0f8a526",
                "headBlob": "011056110df847047baaa0abe92177ccd4854147",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/fleet/stalled-item-rotation.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9893ba7aabafc0874fea46f8c3dd58848fe2a3bb8a536752f951e7d2b785d0ff",
                "headBlob": "77d676de65d8a7329025cb6267a2dbd0f65ce1ae",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/bounded-timeout.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b4d04cb6fadc97d36e7bc3677eef8f38f759836dd5fc5c54f0259bba0c1e61f3",
                "headBlob": "15c3602648e865bec40bce87f771fc027a818920",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/degradation/fallback-observations.ts",
                "repo": ".",
                "clean": true,
                "sha256": "fbd8ffde80f427b999147a8e3107e2770e42b443aeacd7b4ae9edbaa8cb1110a",
                "headBlob": "e92b0de1ca6fe23201c837897da89787f3b108fb",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/fleet-member-idle-verdict.ts",
                "repo": ".",
                "clean": true,
                "sha256": "04073851046cae02ddc79013731c6441ce619a3118c2a81871e889ff3a2fc5ad",
                "headBlob": "9e7be6cd44e17f9cafa915fc7b5c086160810e97",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "19fa50db2a443421900f73ed8cbe1c8fd64dc734dead84fe3adf0ef0eeb131ca",
                "headBlob": "0e0db3811682b95a386364022c59d5bda7386030",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "19fa50db2a443421900f73ed8cbe1c8fd64dc734dead84fe3adf0ef0eeb131ca",
                "headBlob": "0e0db3811682b95a386364022c59d5bda7386030",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts"
            ],
            "sourcePaths": [
              "packages/operator-core/lib/agent-tools/fleet/assignments.ts",
              "packages/operator-core/lib/agent-tools/fleet/leader-brief-aggregate.ts",
              "packages/operator-core/lib/agent-tools/fleet/leader-brief-shape.ts",
              "packages/operator-core/lib/agent-tools/fleet/leader-brief.ts",
              "packages/operator-core/lib/agent-tools/fleet/stalled-item-rotation.ts",
              "packages/operator-core/lib/bounded-timeout.ts",
              "packages/operator-core/lib/degradation/fallback-observations.ts",
              "packages/operator-core/lib/fleet-member-idle-verdict.ts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-24T06:22:58.725Z",
        "bindingFingerprint": "3862de7a63e6fd7a778de5a2c99cf80bd7ac5fe916dc90f01070c946b9b4e3d4",
        "createdBy": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "createdAt": "2026-10-24T06:22:58.716Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
          "current": {
            "planSlug": "luna-drain-capacity-recovery-2026-10-23",
            "specId": "LUNA-CAPACITY-003",
            "specRevision": 2,
            "specFingerprint": "a68b685e6f4d51241eab4d9494c8533ca0d80d696bd37c7fc545cbee83ee4235",
            "evidenceKind": "mutation",
            "evidenceRef": "test-run 21869861 mutation-probe mutant fail packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts @339c94acbed6",
            "sourceFingerprint": "sha256-file-set-v1:b4df721fa2bccf463982fee8067af7e5d645a937ff9c0bff4743407e32bbce4a",
            "testFingerprint": "sha256-file-set-v1:cf5a6e1817e904102be14b77bbd0b8b4a051ec1dde51fffbddce76ae7ebfa6b6",
            "fixtureFingerprint": "sha256-file-set-v1:cf5a6e1817e904102be14b77bbd0b8b4a051ec1dde51fffbddce76ae7ebfa6b6"
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
        "id": 68555,
        "workItemId": "WI-6554700010025535",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "AUTO-BAR-R-1-P-001",
        "sourceValId": null,
        "specRevision": 3,
        "currentRevision": 3,
        "specFingerprint": "a0295a1fc541565bafcf9bd3deb01485ee86bffad1faeb4bffbf599e478af022",
        "evidenceKind": "mutation",
        "evidenceRef": "test-run 21869849 mutation-probe mutant fail packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts @339c94acbed6",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:9914a7be21408f074db2948892b241aa81d385fbc8035928c0368a1ac3398d01",
          "testFingerprint": "sha256-file-set-v1:2867b7b11f341206391997ad1780aa5894a45a9abd2bd951f6298583d4a604ea",
          "fixtureFingerprint": "sha256-file-set-v1:2867b7b11f341206391997ad1780aa5894a45a9abd2bd951f6298583d4a604ea",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 21869849,
        "testRunExecution": {
          "status": "fail",
          "passed": 14,
          "failed": 2,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
          "passedCaseTitles": [],
          "testLayer": "unit",
          "passedCaseTitleCount": 14,
          "passedCaseTitlesOmitted": 14,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                21869849
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
          "framework": "vitest",
          "source": "mutation-probe",
          "mutationPhase": "mutant",
          "mutation": {
            "leg": "mutant",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/scheduler/claim-spec-store.ts\n+++ b/packages/operator-core/lib/scheduler/claim-spec-store.ts\n@@ -155,7 +155,7 @@\n  */\n export function isParkedOnExternalBlocker(row: { status: string | null; externalBlockers?: unknown }): boolean {\n   if (row.status !== 'blocked' && row.status !== 'needs-human') return false;\n-  return activeExternalBlockers({ externalBlockers: row.externalBlockers }).length > 0;\n+  return false;\n }\n \n /** One held row with its P-010 classification — the shape {@link getHeldClaimsForBee} returns. */\n",
            "subjectPath": "packages/operator-core/lib/scheduler/claim-spec-store.ts",
            "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "8d6dcf40f06183d2278198ae974faa6dbb841a762d9b833f2fb6eb8f484cb397",
            "mutateExpression": "s/return activeExternalBlockers\\(.*\\)\\.length > 0;/return false;/",
            "probeInvocationId": "cd71cff3-fa0e-433e-bff7-f39f3211c22d",
            "testCommandSha256": "b80a6c16694d5b5f5a06a6a53a21321d6bcaee81f7c3bdadbb7d6ba66d9fb903",
            "subjectAfterSha256": "69057c3328f5c42e8852efadb7ae44753ca04e9067044a4eba2e9475c7f2fcbc",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "8d751659fb7af6f7d2b4efdfb66dc7a63fb364ec3441228b1b1f6d374415e93f"
          },
          "mutationBaseline": {
            "testRunId": 21869846,
            "status": "pass",
            "mutation": {
              "leg": "copy-baseline",
              "mode": "copy-out",
              "mutantDiff": "--- a/packages/operator-core/lib/scheduler/claim-spec-store.ts\n+++ b/packages/operator-core/lib/scheduler/claim-spec-store.ts\n@@ -155,7 +155,7 @@\n  */\n export function isParkedOnExternalBlocker(row: { status: string | null; externalBlockers?: unknown }): boolean {\n   if (row.status !== 'blocked' && row.status !== 'needs-human') return false;\n-  return activeExternalBlockers({ externalBlockers: row.externalBlockers }).length > 0;\n+  return false;\n }\n \n /** One held row with its P-010 classification — the shape {@link getHeldClaimsForBee} returns. */\n",
              "subjectPath": "packages/operator-core/lib/scheduler/claim-spec-store.ts",
              "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
              "againstCommit": null,
              "schemaVersion": 1,
              "testFileSha256": "8d6dcf40f06183d2278198ae974faa6dbb841a762d9b833f2fb6eb8f484cb397",
              "mutateExpression": "s/return activeExternalBlockers\\(.*\\)\\.length > 0;/return false;/",
              "probeInvocationId": "cd71cff3-fa0e-433e-bff7-f39f3211c22d",
              "testCommandSha256": "b80a6c16694d5b5f5a06a6a53a21321d6bcaee81f7c3bdadbb7d6ba66d9fb903",
              "subjectAfterSha256": "69057c3328f5c42e8852efadb7ae44753ca04e9067044a4eba2e9475c7f2fcbc",
              "mutantDiffTruncated": false,
              "subjectBeforeSha256": "8d751659fb7af6f7d2b4efdfb66dc7a63fb364ec3441228b1b1f6d374415e93f"
            },
            "passed": 16,
            "failed": 0,
            "skipped": 0,
            "collectionFailed": false,
            "passedCaseTitles": [
              "isParkedOnExternalBlocker — P-010 (plan D-010) > frees the slot for a blocked or needs-human hold with an active typed blocker",
              "isParkedOnExternalBlocker — P-010 (plan D-010) > still counts a wip hold even when it carries an active blocker (the holder says it is working it)",
              "isParkedOnExternalBlocker — P-010 (plan D-010) > still counts a plain park: blocked with no blocker, only cleared ones, or a record the parser rejects (EI-11796)",
              "isParkedOnExternalBlocker — P-010 (plan D-010) > calibration: the real predicate passes every case",
              "isParkedOnExternalBlocker — P-010 (plan D-010) > control: the case table rejects a predicate that ignores status",
              "isParkedOnExternalBlocker — P-010 (plan D-010) > control: the case table rejects a predicate that any non-empty array (ignores cleared/malformed)",
              "isParkedOnExternalBlocker — P-010 (plan D-010) > control: the case table rejects a predicate that blocked only (drops needs-human)",
              "isParkedOnExternalBlocker — P-010 (plan D-010) > control: the case table rejects a predicate that any blocked status parks (EI-11796 regression)",
              "evaluateClaimConcurrency — the shared verdict > defaults to one held lane when the spec names no limit (EI-11796 fail-closed default)",
              "evaluateClaimConcurrency — the shared verdict > is NOT blocked when the bee holds nothing",
              "evaluateClaimConcurrency — the shared verdict > honours a leader-authored limit above 1 rather than assuming the default",
              "evaluateClaimConcurrency — the shared verdict > blocks at the limit, not merely above it (>= is the scheduler semantic)",
              "evaluateClaimConcurrency — the shared verdict > names the held ids so a refusal or alert can say exactly what to release",
              "evaluateClaimConcurrency — the shared verdict > accepts a bare count for callers that only have a number (heldIds then empty, never fabricated)",
              "evaluateClaimConcurrency — the shared verdict > reports blocker-parked holds without counting them (P-010) — named, never hidden",
              "evaluateClaimConcurrency — the shared verdict > treats a nullish limit as the default rather than as \"unlimited\""
            ]
          },
          "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
          "worktreeDirty": false,
          "mutationFailureLines": [
            "isParkedOnExternalBlocker — P-010 (plan D-010) > frees the slot for a blocked or needs-human hold with an active typed blocker: (recorded failed assertion)",
            "isParkedOnExternalBlocker — P-010 (plan D-010) > calibration: the real predicate passes every case: (recorded failed assertion)"
          ],
          "mutationFailedCaseTitles": [
            "isParkedOnExternalBlocker — P-010 (plan D-010) > frees the slot for a blocked or needs-human hold with an active typed blocker",
            "isParkedOnExternalBlocker — P-010 (plan D-010) > calibration: the real predicate passes every case"
          ]
        },
        "details": {
          "testRun": {
            "id": 21869849,
            "source": "mutation-probe",
            "status": "fail",
            "filePath": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
            "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
            "finishedAt": "2026-10-24T06:19:24.155Z",
            "asCommitted": {
              "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-339c94acbe-TnuSO3",
            "mutationPhase": "mutant",
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "caught",
            "skipped": false,
            "executed": true,
            "targeted": "AUTO-BAR-R-1-P-001",
            "collected": true,
            "testCases": [
              "isParkedOnExternalBlocker — P-010 (plan D-010) > frees the slot for a blocked or needs-human hold with an active typed blocker"
            ],
            "testLayer": "unit",
            "falsifiable": true,
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "packages/operator-core/lib/scheduler/claim-spec-store.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8d751659fb7af6f7d2b4efdfb66dc7a63fb364ec3441228b1b1f6d374415e93f",
                "headBlob": "aedb066044139ed16fe6f66a4a43ff26b636085c",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8d6dcf40f06183d2278198ae974faa6dbb841a762d9b833f2fb6eb8f484cb397",
                "headBlob": "e980728836769d69489a9007e9469c31f857df88",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8d6dcf40f06183d2278198ae974faa6dbb841a762d9b833f2fb6eb8f484cb397",
                "headBlob": "e980728836769d69489a9007e9469c31f857df88",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts"
            ],
            "sourcePaths": [
              "packages/operator-core/lib/scheduler/claim-spec-store.ts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-24T06:22:58.575Z",
        "bindingFingerprint": "0be0f8285fc662cf74349802fbe7782e0a139e6284e1c4f31eb2a61f00b17545",
        "createdBy": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "createdAt": "2026-10-24T06:22:58.564Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
          "current": {
            "planSlug": "luna-drain-capacity-recovery-2026-10-23",
            "specId": "AUTO-BAR-R-1-P-001",
            "specRevision": 3,
            "specFingerprint": "a0295a1fc541565bafcf9bd3deb01485ee86bffad1faeb4bffbf599e478af022",
            "evidenceKind": "mutation",
            "evidenceRef": "test-run 21869849 mutation-probe mutant fail packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts @339c94acbed6",
            "sourceFingerprint": "sha256-file-set-v1:9914a7be21408f074db2948892b241aa81d385fbc8035928c0368a1ac3398d01",
            "testFingerprint": "sha256-file-set-v1:2867b7b11f341206391997ad1780aa5894a45a9abd2bd951f6298583d4a604ea",
            "fixtureFingerprint": "sha256-file-set-v1:2867b7b11f341206391997ad1780aa5894a45a9abd2bd951f6298583d4a604ea"
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
        "id": 68554,
        "workItemId": "WI-6554700010025535",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "LUNA-CAPACITY-001",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "c0da5d3844f764e2740a41f21c1e475df6c390d9abc1327fb214002eb0f3a744",
        "evidenceKind": "mutation",
        "evidenceRef": "test-run 21869849 mutation-probe mutant fail packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts @339c94acbed6",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:9914a7be21408f074db2948892b241aa81d385fbc8035928c0368a1ac3398d01",
          "testFingerprint": "sha256-file-set-v1:2867b7b11f341206391997ad1780aa5894a45a9abd2bd951f6298583d4a604ea",
          "fixtureFingerprint": "sha256-file-set-v1:2867b7b11f341206391997ad1780aa5894a45a9abd2bd951f6298583d4a604ea",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 21869849,
        "testRunExecution": {
          "status": "fail",
          "passed": 14,
          "failed": 2,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
          "passedCaseTitles": [],
          "testLayer": "unit",
          "passedCaseTitleCount": 14,
          "passedCaseTitlesOmitted": 14,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                21869849
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
          "framework": "vitest",
          "source": "mutation-probe",
          "mutationPhase": "mutant",
          "mutation": {
            "leg": "mutant",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/scheduler/claim-spec-store.ts\n+++ b/packages/operator-core/lib/scheduler/claim-spec-store.ts\n@@ -155,7 +155,7 @@\n  */\n export function isParkedOnExternalBlocker(row: { status: string | null; externalBlockers?: unknown }): boolean {\n   if (row.status !== 'blocked' && row.status !== 'needs-human') return false;\n-  return activeExternalBlockers({ externalBlockers: row.externalBlockers }).length > 0;\n+  return false;\n }\n \n /** One held row with its P-010 classification — the shape {@link getHeldClaimsForBee} returns. */\n",
            "subjectPath": "packages/operator-core/lib/scheduler/claim-spec-store.ts",
            "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "8d6dcf40f06183d2278198ae974faa6dbb841a762d9b833f2fb6eb8f484cb397",
            "mutateExpression": "s/return activeExternalBlockers\\(.*\\)\\.length > 0;/return false;/",
            "probeInvocationId": "cd71cff3-fa0e-433e-bff7-f39f3211c22d",
            "testCommandSha256": "b80a6c16694d5b5f5a06a6a53a21321d6bcaee81f7c3bdadbb7d6ba66d9fb903",
            "subjectAfterSha256": "69057c3328f5c42e8852efadb7ae44753ca04e9067044a4eba2e9475c7f2fcbc",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "8d751659fb7af6f7d2b4efdfb66dc7a63fb364ec3441228b1b1f6d374415e93f"
          },
          "mutationBaseline": {
            "testRunId": 21869846,
            "status": "pass",
            "mutation": {
              "leg": "copy-baseline",
              "mode": "copy-out",
              "mutantDiff": "--- a/packages/operator-core/lib/scheduler/claim-spec-store.ts\n+++ b/packages/operator-core/lib/scheduler/claim-spec-store.ts\n@@ -155,7 +155,7 @@\n  */\n export function isParkedOnExternalBlocker(row: { status: string | null; externalBlockers?: unknown }): boolean {\n   if (row.status !== 'blocked' && row.status !== 'needs-human') return false;\n-  return activeExternalBlockers({ externalBlockers: row.externalBlockers }).length > 0;\n+  return false;\n }\n \n /** One held row with its P-010 classification — the shape {@link getHeldClaimsForBee} returns. */\n",
              "subjectPath": "packages/operator-core/lib/scheduler/claim-spec-store.ts",
              "testCommand": "test -f {} && npm run test:file -- packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
              "againstCommit": null,
              "schemaVersion": 1,
              "testFileSha256": "8d6dcf40f06183d2278198ae974faa6dbb841a762d9b833f2fb6eb8f484cb397",
              "mutateExpression": "s/return activeExternalBlockers\\(.*\\)\\.length > 0;/return false;/",
              "probeInvocationId": "cd71cff3-fa0e-433e-bff7-f39f3211c22d",
              "testCommandSha256": "b80a6c16694d5b5f5a06a6a53a21321d6bcaee81f7c3bdadbb7d6ba66d9fb903",
              "subjectAfterSha256": "69057c3328f5c42e8852efadb7ae44753ca04e9067044a4eba2e9475c7f2fcbc",
              "mutantDiffTruncated": false,
              "subjectBeforeSha256": "8d751659fb7af6f7d2b4efdfb66dc7a63fb364ec3441228b1b1f6d374415e93f"
            },
            "passed": 16,
            "failed": 0,
            "skipped": 0,
            "collectionFailed": false,
            "passedCaseTitles": [
              "isParkedOnExternalBlocker — P-010 (plan D-010) > frees the slot for a blocked or needs-human hold with an active typed blocker",
              "isParkedOnExternalBlocker — P-010 (plan D-010) > still counts a wip hold even when it carries an active blocker (the holder says it is working it)",
              "isParkedOnExternalBlocker — P-010 (plan D-010) > still counts a plain park: blocked with no blocker, only cleared ones, or a record the parser rejects (EI-11796)",
              "isParkedOnExternalBlocker — P-010 (plan D-010) > calibration: the real predicate passes every case",
              "isParkedOnExternalBlocker — P-010 (plan D-010) > control: the case table rejects a predicate that ignores status",
              "isParkedOnExternalBlocker — P-010 (plan D-010) > control: the case table rejects a predicate that any non-empty array (ignores cleared/malformed)",
              "isParkedOnExternalBlocker — P-010 (plan D-010) > control: the case table rejects a predicate that blocked only (drops needs-human)",
              "isParkedOnExternalBlocker — P-010 (plan D-010) > control: the case table rejects a predicate that any blocked status parks (EI-11796 regression)",
              "evaluateClaimConcurrency — the shared verdict > defaults to one held lane when the spec names no limit (EI-11796 fail-closed default)",
              "evaluateClaimConcurrency — the shared verdict > is NOT blocked when the bee holds nothing",
              "evaluateClaimConcurrency — the shared verdict > honours a leader-authored limit above 1 rather than assuming the default",
              "evaluateClaimConcurrency — the shared verdict > blocks at the limit, not merely above it (>= is the scheduler semantic)",
              "evaluateClaimConcurrency — the shared verdict > names the held ids so a refusal or alert can say exactly what to release",
              "evaluateClaimConcurrency — the shared verdict > accepts a bare count for callers that only have a number (heldIds then empty, never fabricated)",
              "evaluateClaimConcurrency — the shared verdict > reports blocker-parked holds without counting them (P-010) — named, never hidden",
              "evaluateClaimConcurrency — the shared verdict > treats a nullish limit as the default rather than as \"unlimited\""
            ]
          },
          "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
          "worktreeDirty": false,
          "mutationFailureLines": [
            "isParkedOnExternalBlocker — P-010 (plan D-010) > frees the slot for a blocked or needs-human hold with an active typed blocker: (recorded failed assertion)",
            "isParkedOnExternalBlocker — P-010 (plan D-010) > calibration: the real predicate passes every case: (recorded failed assertion)"
          ],
          "mutationFailedCaseTitles": [
            "isParkedOnExternalBlocker — P-010 (plan D-010) > frees the slot for a blocked or needs-human hold with an active typed blocker",
            "isParkedOnExternalBlocker — P-010 (plan D-010) > calibration: the real predicate passes every case"
          ]
        },
        "details": {
          "testRun": {
            "id": 21869849,
            "source": "mutation-probe",
            "status": "fail",
            "filePath": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
            "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
            "finishedAt": "2026-10-24T06:19:24.155Z",
            "asCommitted": {
              "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-339c94acbe-TnuSO3",
            "mutationPhase": "mutant",
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "caught",
            "skipped": false,
            "executed": true,
            "targeted": "LUNA-CAPACITY-001",
            "collected": true,
            "testCases": [
              "isParkedOnExternalBlocker — P-010 (plan D-010) > frees the slot for a blocked or needs-human hold with an active typed blocker"
            ],
            "testLayer": "unit",
            "falsifiable": true,
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "packages/operator-core/lib/scheduler/claim-spec-store.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8d751659fb7af6f7d2b4efdfb66dc7a63fb364ec3441228b1b1f6d374415e93f",
                "headBlob": "aedb066044139ed16fe6f66a4a43ff26b636085c",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8d6dcf40f06183d2278198ae974faa6dbb841a762d9b833f2fb6eb8f484cb397",
                "headBlob": "e980728836769d69489a9007e9469c31f857df88",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8d6dcf40f06183d2278198ae974faa6dbb841a762d9b833f2fb6eb8f484cb397",
                "headBlob": "e980728836769d69489a9007e9469c31f857df88",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts"
            ],
            "sourcePaths": [
              "packages/operator-core/lib/scheduler/claim-spec-store.ts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-24T06:22:57.943Z",
        "bindingFingerprint": "bdd5fbaee543e4fe1a4fdfaeefe4d47515f3789282e2d162edc40cf4b1939aae",
        "createdBy": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "createdAt": "2026-10-24T06:22:57.930Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
          "current": {
            "planSlug": "luna-drain-capacity-recovery-2026-10-23",
            "specId": "LUNA-CAPACITY-001",
            "specRevision": 2,
            "specFingerprint": "c0da5d3844f764e2740a41f21c1e475df6c390d9abc1327fb214002eb0f3a744",
            "evidenceKind": "mutation",
            "evidenceRef": "test-run 21869849 mutation-probe mutant fail packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts @339c94acbed6",
            "sourceFingerprint": "sha256-file-set-v1:9914a7be21408f074db2948892b241aa81d385fbc8035928c0368a1ac3398d01",
            "testFingerprint": "sha256-file-set-v1:2867b7b11f341206391997ad1780aa5894a45a9abd2bd951f6298583d4a604ea",
            "fixtureFingerprint": "sha256-file-set-v1:2867b7b11f341206391997ad1780aa5894a45a9abd2bd951f6298583d4a604ea"
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
        "id": 68550,
        "workItemId": "WI-6554700010025537",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "AUTO-BAR-R-3-P-003",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "6734dc1ca3433cfda849ea3bc8a41034f7428dbb9d76c63fc8be8d4be677ff3a",
        "evidenceKind": "test",
        "evidenceRef": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:b4df721fa2bccf463982fee8067af7e5d645a937ff9c0bff4743407e32bbce4a",
          "testFingerprint": "sha256-file-set-v1:cf5a6e1817e904102be14b77bbd0b8b4a051ec1dde51fffbddce76ae7ebfa6b6",
          "fixtureFingerprint": "sha256-file-set-v1:cf5a6e1817e904102be14b77bbd0b8b4a051ec1dde51fffbddce76ae7ebfa6b6",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 21869227,
        "testRunExecution": {
          "status": "pass",
          "passed": 284,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
          "passedCaseTitles": [
            "fleet:leader-brief bounded read fan-out (EI-21577690778811728) > gives required lane health the existing diagnostic budget and keeps a typed recovery fallback"
          ],
          "testLayer": "unit",
          "passedCaseTitleCount": 284,
          "passedCaseTitlesOmitted": 283,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                21869227
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
          "framework": "vitest",
          "source": "local",
          "mutationPhase": null,
          "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 21869227,
            "source": "local",
            "status": "pass",
            "filePath": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
            "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
            "finishedAt": "2026-10-24T05:38:42.791Z",
            "asCommitted": {
              "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-339c94acbe-cx0yMN",
            "mutationPhase": null,
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "AUTO-BAR-R-3-P-003",
            "collected": true,
            "testCases": [
              "gives required lane health the existing diagnostic budget and keeps a typed recovery fallback"
            ],
            "testLayer": "unit",
            "falsifiable": true,
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "packages/operator-core/lib/agent-tools/fleet/assignments.ts",
                "repo": ".",
                "clean": true,
                "sha256": "6a095d9baa4a2d67ee9d315ddc4da285ecf314e501c1750d074a6e29d1f37d06",
                "headBlob": "06d5b140edf590313372671c10e6f87e6e5decd0",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/fleet/leader-brief-aggregate.ts",
                "repo": ".",
                "clean": true,
                "sha256": "5004d63e2bcba55325ef7def0446fbcdc792cd6f065c833dde21ef55c57324aa",
                "headBlob": "3f0b4e008bfeca6fd33c6f2a126eaef292e85c43",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/fleet/leader-brief-shape.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b4b1d301a7648fcc1fb2ba6a4724b4e09d9383b2a303df25f8f0d7a3c4cb1d8b",
                "headBlob": "1c8dc94586012ff72bb64d7f290eb63602014e75",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/fleet/leader-brief.ts",
                "repo": ".",
                "clean": true,
                "sha256": "fbfe51b7c60fa8c817047b79655ecfbbf3ef7604a28bf0711b73ec9da0f8a526",
                "headBlob": "011056110df847047baaa0abe92177ccd4854147",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/fleet/stalled-item-rotation.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9893ba7aabafc0874fea46f8c3dd58848fe2a3bb8a536752f951e7d2b785d0ff",
                "headBlob": "77d676de65d8a7329025cb6267a2dbd0f65ce1ae",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/bounded-timeout.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b4d04cb6fadc97d36e7bc3677eef8f38f759836dd5fc5c54f0259bba0c1e61f3",
                "headBlob": "15c3602648e865bec40bce87f771fc027a818920",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/degradation/fallback-observations.ts",
                "repo": ".",
                "clean": true,
                "sha256": "fbd8ffde80f427b999147a8e3107e2770e42b443aeacd7b4ae9edbaa8cb1110a",
                "headBlob": "e92b0de1ca6fe23201c837897da89787f3b108fb",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/fleet-member-idle-verdict.ts",
                "repo": ".",
                "clean": true,
                "sha256": "04073851046cae02ddc79013731c6441ce619a3118c2a81871e889ff3a2fc5ad",
                "headBlob": "9e7be6cd44e17f9cafa915fc7b5c086160810e97",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "19fa50db2a443421900f73ed8cbe1c8fd64dc734dead84fe3adf0ef0eeb131ca",
                "headBlob": "0e0db3811682b95a386364022c59d5bda7386030",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "19fa50db2a443421900f73ed8cbe1c8fd64dc734dead84fe3adf0ef0eeb131ca",
                "headBlob": "0e0db3811682b95a386364022c59d5bda7386030",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "b0b5d23760f8065b133651c0325ec0b49620eeab",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts"
            ],
            "sourcePaths": [
              "packages/operator-core/lib/agent-tools/fleet/assignments.ts",
              "packages/operator-core/lib/agent-tools/fleet/leader-brief-aggregate.ts",
              "packages/operator-core/lib/agent-tools/fleet/leader-brief-shape.ts",
              "packages/operator-core/lib/agent-tools/fleet/leader-brief.ts",
              "packages/operator-core/lib/agent-tools/fleet/stalled-item-rotation.ts",
              "packages/operator-core/lib/bounded-timeout.ts",
              "packages/operator-core/lib/degradation/fallback-observations.ts",
              "packages/operator-core/lib/fleet-member-idle-verdict.ts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-24T06:15:57.773Z",
        "bindingFingerprint": "7e17f1bbce76f70ec61c3aa8b6f7e3767fdbb6ed6aacbdaad7ed499a4ed2caff",
        "createdBy": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "createdAt": "2026-10-24T06:15:57.627Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
          "current": {
            "planSlug": "luna-drain-capacity-recovery-2026-10-23",
            "specId": "AUTO-BAR-R-3-P-003",
            "specRevision": 2,
            "specFingerprint": "6734dc1ca3433cfda849ea3bc8a41034f7428dbb9d76c63fc8be8d4be677ff3a",
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
            "sourceFingerprint": "sha256-file-set-v1:b4df721fa2bccf463982fee8067af7e5d645a937ff9c0bff4743407e32bbce4a",
            "testFingerprint": "sha256-file-set-v1:cf5a6e1817e904102be14b77bbd0b8b4a051ec1dde51fffbddce76ae7ebfa6b6",
            "fixtureFingerprint": "sha256-file-set-v1:cf5a6e1817e904102be14b77bbd0b8b4a051ec1dde51fffbddce76ae7ebfa6b6"
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
        "id": 68549,
        "workItemId": "WI-6554700010025537",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "LUNA-CAPACITY-003",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "a68b685e6f4d51241eab4d9494c8533ca0d80d696bd37c7fc545cbee83ee4235",
        "evidenceKind": "test",
        "evidenceRef": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:b4df721fa2bccf463982fee8067af7e5d645a937ff9c0bff4743407e32bbce4a",
          "testFingerprint": "sha256-file-set-v1:cf5a6e1817e904102be14b77bbd0b8b4a051ec1dde51fffbddce76ae7ebfa6b6",
          "fixtureFingerprint": "sha256-file-set-v1:cf5a6e1817e904102be14b77bbd0b8b4a051ec1dde51fffbddce76ae7ebfa6b6",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 21869227,
        "testRunExecution": {
          "status": "pass",
          "passed": 284,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
          "passedCaseTitles": [
            "fleet:leader-brief bounded read fan-out (EI-21577690778811728) > gives required lane health the existing diagnostic budget and keeps a typed recovery fallback"
          ],
          "testLayer": "unit",
          "passedCaseTitleCount": 284,
          "passedCaseTitlesOmitted": 283,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                21869227
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
          "framework": "vitest",
          "source": "local",
          "mutationPhase": null,
          "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 21869227,
            "source": "local",
            "status": "pass",
            "filePath": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
            "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
            "finishedAt": "2026-10-24T05:38:42.791Z",
            "asCommitted": {
              "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-339c94acbe-cx0yMN",
            "mutationPhase": null,
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "LUNA-CAPACITY-003",
            "collected": true,
            "testCases": [
              "gives required lane health the existing diagnostic budget and keeps a typed recovery fallback"
            ],
            "testLayer": "unit",
            "falsifiable": true,
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "packages/operator-core/lib/agent-tools/fleet/assignments.ts",
                "repo": ".",
                "clean": true,
                "sha256": "6a095d9baa4a2d67ee9d315ddc4da285ecf314e501c1750d074a6e29d1f37d06",
                "headBlob": "06d5b140edf590313372671c10e6f87e6e5decd0",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/fleet/leader-brief-aggregate.ts",
                "repo": ".",
                "clean": true,
                "sha256": "5004d63e2bcba55325ef7def0446fbcdc792cd6f065c833dde21ef55c57324aa",
                "headBlob": "3f0b4e008bfeca6fd33c6f2a126eaef292e85c43",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/fleet/leader-brief-shape.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b4b1d301a7648fcc1fb2ba6a4724b4e09d9383b2a303df25f8f0d7a3c4cb1d8b",
                "headBlob": "1c8dc94586012ff72bb64d7f290eb63602014e75",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/fleet/leader-brief.ts",
                "repo": ".",
                "clean": true,
                "sha256": "fbfe51b7c60fa8c817047b79655ecfbbf3ef7604a28bf0711b73ec9da0f8a526",
                "headBlob": "011056110df847047baaa0abe92177ccd4854147",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/fleet/stalled-item-rotation.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9893ba7aabafc0874fea46f8c3dd58848fe2a3bb8a536752f951e7d2b785d0ff",
                "headBlob": "77d676de65d8a7329025cb6267a2dbd0f65ce1ae",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/bounded-timeout.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b4d04cb6fadc97d36e7bc3677eef8f38f759836dd5fc5c54f0259bba0c1e61f3",
                "headBlob": "15c3602648e865bec40bce87f771fc027a818920",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/degradation/fallback-observations.ts",
                "repo": ".",
                "clean": true,
                "sha256": "fbd8ffde80f427b999147a8e3107e2770e42b443aeacd7b4ae9edbaa8cb1110a",
                "headBlob": "e92b0de1ca6fe23201c837897da89787f3b108fb",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/fleet-member-idle-verdict.ts",
                "repo": ".",
                "clean": true,
                "sha256": "04073851046cae02ddc79013731c6441ce619a3118c2a81871e889ff3a2fc5ad",
                "headBlob": "9e7be6cd44e17f9cafa915fc7b5c086160810e97",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "19fa50db2a443421900f73ed8cbe1c8fd64dc734dead84fe3adf0ef0eeb131ca",
                "headBlob": "0e0db3811682b95a386364022c59d5bda7386030",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "19fa50db2a443421900f73ed8cbe1c8fd64dc734dead84fe3adf0ef0eeb131ca",
                "headBlob": "0e0db3811682b95a386364022c59d5bda7386030",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "b0b5d23760f8065b133651c0325ec0b49620eeab",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts"
            ],
            "sourcePaths": [
              "packages/operator-core/lib/agent-tools/fleet/assignments.ts",
              "packages/operator-core/lib/agent-tools/fleet/leader-brief-aggregate.ts",
              "packages/operator-core/lib/agent-tools/fleet/leader-brief-shape.ts",
              "packages/operator-core/lib/agent-tools/fleet/leader-brief.ts",
              "packages/operator-core/lib/agent-tools/fleet/stalled-item-rotation.ts",
              "packages/operator-core/lib/bounded-timeout.ts",
              "packages/operator-core/lib/degradation/fallback-observations.ts",
              "packages/operator-core/lib/fleet-member-idle-verdict.ts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-24T06:15:57.067Z",
        "bindingFingerprint": "d1a47f8364697333aad8fe23e54511dae839f6de34f3d225d5d534e9562ea3d3",
        "createdBy": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "createdAt": "2026-10-24T06:15:56.976Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
          "current": {
            "planSlug": "luna-drain-capacity-recovery-2026-10-23",
            "specId": "LUNA-CAPACITY-003",
            "specRevision": 2,
            "specFingerprint": "a68b685e6f4d51241eab4d9494c8533ca0d80d696bd37c7fc545cbee83ee4235",
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
            "sourceFingerprint": "sha256-file-set-v1:b4df721fa2bccf463982fee8067af7e5d645a937ff9c0bff4743407e32bbce4a",
            "testFingerprint": "sha256-file-set-v1:cf5a6e1817e904102be14b77bbd0b8b4a051ec1dde51fffbddce76ae7ebfa6b6",
            "fixtureFingerprint": "sha256-file-set-v1:cf5a6e1817e904102be14b77bbd0b8b4a051ec1dde51fffbddce76ae7ebfa6b6"
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
        "id": 68548,
        "workItemId": "WI-6554700010025535",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "AUTO-BAR-R-1-P-001",
        "sourceValId": null,
        "specRevision": 3,
        "currentRevision": 3,
        "specFingerprint": "a0295a1fc541565bafcf9bd3deb01485ee86bffad1faeb4bffbf599e478af022",
        "evidenceKind": "test",
        "evidenceRef": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:9914a7be21408f074db2948892b241aa81d385fbc8035928c0368a1ac3398d01",
          "testFingerprint": "sha256-file-set-v1:2867b7b11f341206391997ad1780aa5894a45a9abd2bd951f6298583d4a604ea",
          "fixtureFingerprint": "sha256-file-set-v1:2867b7b11f341206391997ad1780aa5894a45a9abd2bd951f6298583d4a604ea",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 21869226,
        "testRunExecution": {
          "status": "pass",
          "passed": 16,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
          "passedCaseTitles": [
            "isParkedOnExternalBlocker — P-010 (plan D-010) > frees the slot for a blocked or needs-human hold with an active typed blocker"
          ],
          "testLayer": "unit",
          "passedCaseTitleCount": 16,
          "passedCaseTitlesOmitted": 15,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                21869226
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
          "framework": "vitest",
          "source": "local",
          "mutationPhase": null,
          "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 21869226,
            "source": "local",
            "status": "pass",
            "filePath": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
            "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
            "finishedAt": "2026-10-24T05:38:34.024Z",
            "asCommitted": {
              "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-339c94acbe-cx0yMN",
            "mutationPhase": null,
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "AUTO-BAR-R-1-P-001",
            "collected": true,
            "testCases": [
              "frees the slot for a blocked or needs-human hold with an active typed blocker"
            ],
            "testLayer": "unit",
            "falsifiable": true,
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "packages/operator-core/lib/scheduler/claim-spec-store.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8d751659fb7af6f7d2b4efdfb66dc7a63fb364ec3441228b1b1f6d374415e93f",
                "headBlob": "aedb066044139ed16fe6f66a4a43ff26b636085c",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8d6dcf40f06183d2278198ae974faa6dbb841a762d9b833f2fb6eb8f484cb397",
                "headBlob": "e980728836769d69489a9007e9469c31f857df88",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8d6dcf40f06183d2278198ae974faa6dbb841a762d9b833f2fb6eb8f484cb397",
                "headBlob": "e980728836769d69489a9007e9469c31f857df88",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "b0b5d23760f8065b133651c0325ec0b49620eeab",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts"
            ],
            "sourcePaths": [
              "packages/operator-core/lib/scheduler/claim-spec-store.ts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-24T06:15:55.506Z",
        "bindingFingerprint": "00d4a3b7e97279e30e1056417d376a62d433077b64212bf6d58ef3bd0cda79c9",
        "createdBy": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "createdAt": "2026-10-24T06:15:55.380Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
          "current": {
            "planSlug": "luna-drain-capacity-recovery-2026-10-23",
            "specId": "AUTO-BAR-R-1-P-001",
            "specRevision": 3,
            "specFingerprint": "a0295a1fc541565bafcf9bd3deb01485ee86bffad1faeb4bffbf599e478af022",
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
            "sourceFingerprint": "sha256-file-set-v1:9914a7be21408f074db2948892b241aa81d385fbc8035928c0368a1ac3398d01",
            "testFingerprint": "sha256-file-set-v1:2867b7b11f341206391997ad1780aa5894a45a9abd2bd951f6298583d4a604ea",
            "fixtureFingerprint": "sha256-file-set-v1:2867b7b11f341206391997ad1780aa5894a45a9abd2bd951f6298583d4a604ea"
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
        "id": 68547,
        "workItemId": "WI-6554700010025535",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "AUTO-BAR-R-1-P-001",
        "sourceValId": null,
        "specRevision": 3,
        "currentRevision": 3,
        "specFingerprint": "a0295a1fc541565bafcf9bd3deb01485ee86bffad1faeb4bffbf599e478af022",
        "evidenceKind": "test",
        "evidenceRef": "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:9f8b30a549761d9ee229a0c8df68b57549ca90432135cf89f3ea1f780aa72266",
          "testFingerprint": "sha256-file-set-v1:0024adf1c431373c08a56967ce6794ccc0fc69af4ef9b4b87cd7b8d1831834d5",
          "fixtureFingerprint": "sha256-file-set-v1:27b5b6024bcca427aef0603b629365663eab478e87f58ed848117866769e2d4a",
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
          "passedCaseTitles": [
            "cup_claim_specs store (mig 372) > P-010 (D-010): a hold parked on a typed external blocker frees its concurrency slot > Luna: clearing a typed blocker restores cap2 counting without changing custody or the member override"
          ],
          "testLayer": "integration",
          "passedCaseTitleCount": 51,
          "passedCaseTitlesOmitted": 50,
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
            "targeted": "AUTO-BAR-R-1-P-001",
            "collected": true,
            "testCases": [
              "Luna: clearing a typed blocker restores cap2 counting without changing custody or the member override"
            ],
            "testLayer": "integration",
            "falsifiable": true,
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
                "path": "libs/papercusp/libs/db/sql/372-bee-claim-specs.sql",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "66815e915f199ac92f8a5627866ae3f80498c84674669e6a995e5dadb3aa0c99",
                "headBlob": "97da589f138b6a919d3e724990562a6dc5e1bb5d",
                "dimension": "fixture"
              },
              {
                "path": "libs/papercusp/libs/db/sql/389-bee-claim-spec-id-only.sql",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "0556e30ea73615644bd3c3e6122bb34e99292b586d30f0e6e99cb0937e27bced",
                "headBlob": "bf25c68409f98dbb968ce1b4ee316b062abc7dee",
                "dimension": "fixture"
              },
              {
                "path": "libs/papercusp/libs/db/sql/438-bee-claim-specs-federation.sql",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "bb8da0b0ddaf8927fde3cb3590f9e4e89678428a72788a4b7b1ee551bc3c5c88",
                "headBlob": "4be909c5b48e1b54a14609df353ca5405292e408",
                "dimension": "fixture"
              },
              {
                "path": "libs/papercusp/libs/db/sql/archive/102-substrate-outbox.sql",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "16321aa9db8f7d5acc7069d9fb59cebbae43b0c201abf2d5ae2bc10bdc93dbf3",
                "headBlob": "de35272cc6e1486f2e3c5f1478759498702ae7bb",
                "dimension": "fixture"
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
                "head": "b0b5d23760f8065b133651c0325ec0b49620eeab",
                "repo": ".",
                "gitlink": null
              },
              {
                "head": "594cacf4fcd237efa597df1f40534f0cdd7a936e",
                "repo": "libs/papercusp",
                "gitlink": "594cacf4fcd237efa597df1f40534f0cdd7a936e"
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
              "libs/papercusp/libs/db/sql/372-bee-claim-specs.sql",
              "libs/papercusp/libs/db/sql/389-bee-claim-spec-id-only.sql",
              "libs/papercusp/libs/db/sql/438-bee-claim-specs-federation.sql",
              "libs/papercusp/libs/db/sql/archive/102-substrate-outbox.sql",
              "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
              "packages/operator-core/test/_pg-helpers.ts",
              "packages/operator-core/test/_work-items-schema.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-24T06:15:54.957Z",
        "bindingFingerprint": "a2c4ea9d73604372f439ec0d3388be502c59918e3f6c3f57c76704759cdf79a4",
        "createdBy": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "createdAt": "2026-10-24T06:15:54.701Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
          "current": {
            "planSlug": "luna-drain-capacity-recovery-2026-10-23",
            "specId": "AUTO-BAR-R-1-P-001",
            "specRevision": 3,
            "specFingerprint": "a0295a1fc541565bafcf9bd3deb01485ee86bffad1faeb4bffbf599e478af022",
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
            "sourceFingerprint": "sha256-file-set-v1:9f8b30a549761d9ee229a0c8df68b57549ca90432135cf89f3ea1f780aa72266",
            "testFingerprint": "sha256-file-set-v1:0024adf1c431373c08a56967ce6794ccc0fc69af4ef9b4b87cd7b8d1831834d5",
            "fixtureFingerprint": "sha256-file-set-v1:27b5b6024bcca427aef0603b629365663eab478e87f58ed848117866769e2d4a"
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
        "id": 68546,
        "workItemId": "WI-6554700010025535",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "LUNA-CAPACITY-001",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "c0da5d3844f764e2740a41f21c1e475df6c390d9abc1327fb214002eb0f3a744",
        "evidenceKind": "test",
        "evidenceRef": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:9914a7be21408f074db2948892b241aa81d385fbc8035928c0368a1ac3398d01",
          "testFingerprint": "sha256-file-set-v1:2867b7b11f341206391997ad1780aa5894a45a9abd2bd951f6298583d4a604ea",
          "fixtureFingerprint": "sha256-file-set-v1:2867b7b11f341206391997ad1780aa5894a45a9abd2bd951f6298583d4a604ea",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 21869226,
        "testRunExecution": {
          "status": "pass",
          "passed": 16,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
          "passedCaseTitles": [
            "isParkedOnExternalBlocker — P-010 (plan D-010) > frees the slot for a blocked or needs-human hold with an active typed blocker"
          ],
          "testLayer": "unit",
          "passedCaseTitleCount": 16,
          "passedCaseTitlesOmitted": 15,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                21869226
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
          "framework": "vitest",
          "source": "local",
          "mutationPhase": null,
          "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 21869226,
            "source": "local",
            "status": "pass",
            "filePath": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
            "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
            "finishedAt": "2026-10-24T05:38:34.024Z",
            "asCommitted": {
              "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-339c94acbe-cx0yMN",
            "mutationPhase": null,
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "LUNA-CAPACITY-001",
            "collected": true,
            "testCases": [
              "frees the slot for a blocked or needs-human hold with an active typed blocker"
            ],
            "testLayer": "unit",
            "falsifiable": true,
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "packages/operator-core/lib/scheduler/claim-spec-store.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8d751659fb7af6f7d2b4efdfb66dc7a63fb364ec3441228b1b1f6d374415e93f",
                "headBlob": "aedb066044139ed16fe6f66a4a43ff26b636085c",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8d6dcf40f06183d2278198ae974faa6dbb841a762d9b833f2fb6eb8f484cb397",
                "headBlob": "e980728836769d69489a9007e9469c31f857df88",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8d6dcf40f06183d2278198ae974faa6dbb841a762d9b833f2fb6eb8f484cb397",
                "headBlob": "e980728836769d69489a9007e9469c31f857df88",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "b0b5d23760f8065b133651c0325ec0b49620eeab",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts"
            ],
            "sourcePaths": [
              "packages/operator-core/lib/scheduler/claim-spec-store.ts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-24T06:15:53.602Z",
        "bindingFingerprint": "ae26b28b8d92c7976b875260bd7c2f4fd01d1cf900081258d08fbe36d95f5ac7",
        "createdBy": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "createdAt": "2026-10-24T06:15:53.441Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
          "current": {
            "planSlug": "luna-drain-capacity-recovery-2026-10-23",
            "specId": "LUNA-CAPACITY-001",
            "specRevision": 2,
            "specFingerprint": "c0da5d3844f764e2740a41f21c1e475df6c390d9abc1327fb214002eb0f3a744",
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
            "sourceFingerprint": "sha256-file-set-v1:9914a7be21408f074db2948892b241aa81d385fbc8035928c0368a1ac3398d01",
            "testFingerprint": "sha256-file-set-v1:2867b7b11f341206391997ad1780aa5894a45a9abd2bd951f6298583d4a604ea",
            "fixtureFingerprint": "sha256-file-set-v1:2867b7b11f341206391997ad1780aa5894a45a9abd2bd951f6298583d4a604ea"
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
        "id": 68545,
        "workItemId": "WI-6554700010025535",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "LUNA-CAPACITY-001",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "c0da5d3844f764e2740a41f21c1e475df6c390d9abc1327fb214002eb0f3a744",
        "evidenceKind": "test",
        "evidenceRef": "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:9f8b30a549761d9ee229a0c8df68b57549ca90432135cf89f3ea1f780aa72266",
          "testFingerprint": "sha256-file-set-v1:0024adf1c431373c08a56967ce6794ccc0fc69af4ef9b4b87cd7b8d1831834d5",
          "fixtureFingerprint": "sha256-file-set-v1:27b5b6024bcca427aef0603b629365663eab478e87f58ed848117866769e2d4a",
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
          "passedCaseTitles": [
            "cup_claim_specs store (mig 372) > P-010 (D-010): a hold parked on a typed external blocker frees its concurrency slot > Luna: clearing a typed blocker restores cap2 counting without changing custody or the member override"
          ],
          "testLayer": "integration",
          "passedCaseTitleCount": 51,
          "passedCaseTitlesOmitted": 50,
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
            "targeted": "LUNA-CAPACITY-001",
            "collected": true,
            "testCases": [
              "Luna: clearing a typed blocker restores cap2 counting without changing custody or the member override"
            ],
            "testLayer": "integration",
            "falsifiable": true,
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
                "path": "libs/papercusp/libs/db/sql/372-bee-claim-specs.sql",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "66815e915f199ac92f8a5627866ae3f80498c84674669e6a995e5dadb3aa0c99",
                "headBlob": "97da589f138b6a919d3e724990562a6dc5e1bb5d",
                "dimension": "fixture"
              },
              {
                "path": "libs/papercusp/libs/db/sql/389-bee-claim-spec-id-only.sql",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "0556e30ea73615644bd3c3e6122bb34e99292b586d30f0e6e99cb0937e27bced",
                "headBlob": "bf25c68409f98dbb968ce1b4ee316b062abc7dee",
                "dimension": "fixture"
              },
              {
                "path": "libs/papercusp/libs/db/sql/438-bee-claim-specs-federation.sql",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "bb8da0b0ddaf8927fde3cb3590f9e4e89678428a72788a4b7b1ee551bc3c5c88",
                "headBlob": "4be909c5b48e1b54a14609df353ca5405292e408",
                "dimension": "fixture"
              },
              {
                "path": "libs/papercusp/libs/db/sql/archive/102-substrate-outbox.sql",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "16321aa9db8f7d5acc7069d9fb59cebbae43b0c201abf2d5ae2bc10bdc93dbf3",
                "headBlob": "de35272cc6e1486f2e3c5f1478759498702ae7bb",
                "dimension": "fixture"
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
                "head": "b0b5d23760f8065b133651c0325ec0b49620eeab",
                "repo": ".",
                "gitlink": null
              },
              {
                "head": "594cacf4fcd237efa597df1f40534f0cdd7a936e",
                "repo": "libs/papercusp",
                "gitlink": "594cacf4fcd237efa597df1f40534f0cdd7a936e"
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
              "libs/papercusp/libs/db/sql/372-bee-claim-specs.sql",
              "libs/papercusp/libs/db/sql/389-bee-claim-spec-id-only.sql",
              "libs/papercusp/libs/db/sql/438-bee-claim-specs-federation.sql",
              "libs/papercusp/libs/db/sql/archive/102-substrate-outbox.sql",
              "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
              "packages/operator-core/test/_pg-helpers.ts",
              "packages/operator-core/test/_work-items-schema.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-24T06:15:52.448Z",
        "bindingFingerprint": "ae02ec1820619189c56be7dd6dd60c17cd32cc22a8f8316a43e9c672be883245",
        "createdBy": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "createdAt": "2026-10-24T06:15:52.287Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
          "current": {
            "planSlug": "luna-drain-capacity-recovery-2026-10-23",
            "specId": "LUNA-CAPACITY-001",
            "specRevision": 2,
            "specFingerprint": "c0da5d3844f764e2740a41f21c1e475df6c390d9abc1327fb214002eb0f3a744",
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
            "sourceFingerprint": "sha256-file-set-v1:9f8b30a549761d9ee229a0c8df68b57549ca90432135cf89f3ea1f780aa72266",
            "testFingerprint": "sha256-file-set-v1:0024adf1c431373c08a56967ce6794ccc0fc69af4ef9b4b87cd7b8d1831834d5",
            "fixtureFingerprint": "sha256-file-set-v1:27b5b6024bcca427aef0603b629365663eab478e87f58ed848117866769e2d4a"
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
        "id": 68538,
        "workItemId": "WI-6554700010025538",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "AUTO-BAR-R-4-P-004",
        "sourceValId": null,
        "specRevision": 4,
        "currentRevision": 4,
        "specFingerprint": "5282833d6544e041b8b06ea2be5d7fd2627873b1badc9679abe352b57c76ba9f",
        "evidenceKind": "test",
        "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:0ea13bffb340badd75d0cf3447cd370ec854b14c52416613bd12ed6db9518e16",
          "testFingerprint": "sha256-file-set-v1:4c03e6bf2fb42e14c41edab78f1d0db21ba774c657c2215e96f96a08768d73c2",
          "fixtureFingerprint": "sha256-file-set-v1:4c03e6bf2fb42e14c41edab78f1d0db21ba774c657c2215e96f96a08768d73c2",
          "rubricFingerprint": null,
          "environmentFingerprint": "2019944703dd1c3662b7c8a60ca333d7e4193e3ec0ac274c545c4b00c30b49d1"
        },
        "coverageEvidenceRef": null,
        "testRunId": 21868509,
        "testRunExecution": {
          "status": "pass",
          "passed": 1,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
          "scenarioId": "su-S42-drain-watch-during-registration",
          "passedCaseTitlesIncomplete": true,
          "testLayer": "llm"
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
          "framework": "llm-test",
          "source": "local",
          "mutationPhase": null,
          "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 21868509,
            "source": "local",
            "status": "pass",
            "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
            "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
            "finishedAt": "2026-10-24T05:11:32.063Z",
            "asCommitted": {
              "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-339c94acbe-cx0yMN",
            "mutationPhase": null,
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "AUTO-BAR-R-4-P-004",
            "collected": true,
            "testCases": [
              "su-S42-drain-watch-during-registration"
            ],
            "testLayer": "llm",
            "falsifiable": true,
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "live",
          "measurementPin": {
            "files": [
              {
                "path": "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "cdb059d89031bfdcd5a8f6f249aee4a883618579d333d0c46941c3b5eda16b66",
                "headBlob": "ad8bea9cf067c6c804746bae5a80460532ad8f5a",
                "dimension": "source"
              },
              {
                "path": "libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts/fleet-posture.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "72597f9cda7e159e49451249196dc3134368bed844e807781c4a412753e55170",
                "headBlob": "4ae91e731b93a1f69e7121de8004b1a8adaa9873",
                "dimension": "source"
              },
              {
                "path": "libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "6dcae35526f7dd1f29954c8da11eaf5dff8e1648232811b9e1494d0e04686496",
                "headBlob": "49d5e62fb879657718e88f4aabee5c1627a56bb7",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/events/watch.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b9a4c3aff8a14d01e94407c8760a1df8a25536743fc50eaea739fd08cdfb218a",
                "headBlob": "e7f5387a1660636732f52532961478e3be339eb4",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/scheduler/get_next.ts",
                "repo": ".",
                "clean": true,
                "sha256": "0cffc0daf039c4bc08b863a0fbc4e5ebd8c2968795a6ab4ad008eb6d63e898c6",
                "headBlob": "8cebbd738d58ae45066ada67abe5bd7c0b3180d8",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "repo": ".",
                "clean": true,
                "sha256": "bb108bbdc66b207a44155c6e3dfb6b37d85a4e3f3bffe3fdecafc6bfacb0301e",
                "headBlob": "1420766e3acf71d1e99610963df770b45faf1313",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/desktop-install/papercusp-files.ts",
                "repo": ".",
                "clean": true,
                "sha256": "ad031013ee30a357805e47c2ed16c5868f1351d2ad2e855fe3330b0ac653e06b",
                "headBlob": "c2c38da10ff912c6c634cd8073681dbe423f4f8d",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/fleet/capacity-recovery-evidence.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2507f43aab26678eac4372d35d3a4c9373b64d49cda389e4d963834fd50d8f5d",
                "headBlob": "c881fcaba3748c7ae3cd8273eeb8742732fd7e54",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/loop.ts",
                "repo": ".",
                "clean": true,
                "sha256": "612c811ac21d6ec20d2f04da2c25ae04d563aea7b496ad6db475dddfe7541a99",
                "headBlob": "ccb93fd05bbcca7edabefa810a3fe7d4e5d8831b",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b88e6705b4f415781ea81af19da1bdd25ac08d547432849612b07f9ee261713",
                "headBlob": "dc8e2644c30e62424c3cc11437007a94ea6b7949",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b08b2336b5046b985edee0914b9bff88319b32aaffd1cf62bca8e75c7e11427",
                "headBlob": "ed65fdaf7e6c7c9e300c6c3ba52769bca82084ef",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/targets/su.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9ecfb6c3139fbf4b6cd4524e51432e36d216f4283d09e4f9c338a85067ccc04d",
                "headBlob": "9591c7a33bbaef7fa95d509d6b7ee393c741fcd1",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/test-run-ledger.ts",
                "repo": ".",
                "clean": true,
                "sha256": "0189f069b512736e7e3104a957e55c2570154c4fcde754cedf6cfbd65f473795",
                "headBlob": "7bc4f6456a3f6832ad2265a91c38f190f43bcd7a",
                "dimension": "source"
              },
              {
                "path": "scripts/verify-fleet-capacity-recovery.mts",
                "repo": ".",
                "clean": true,
                "sha256": "4a431ede6616f70cc0498b046ce05d776a2872c49d81a59647040919565ddec6",
                "headBlob": "1e568ef85803553eb697f09d8ae2e12a2967feca",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b88e6705b4f415781ea81af19da1bdd25ac08d547432849612b07f9ee261713",
                "headBlob": "dc8e2644c30e62424c3cc11437007a94ea6b7949",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b88e6705b4f415781ea81af19da1bdd25ac08d547432849612b07f9ee261713",
                "headBlob": "dc8e2644c30e62424c3cc11437007a94ea6b7949",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "b0b5d23760f8065b133651c0325ec0b49620eeab",
                "repo": ".",
                "gitlink": null
              },
              {
                "head": "594cacf4fcd237efa597df1f40534f0cdd7a936e",
                "repo": "libs/papercusp",
                "gitlink": "594cacf4fcd237efa597df1f40534f0cdd7a936e"
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts"
            ],
            "sourcePaths": [
              "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
              "libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts/fleet-posture.md",
              "libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md",
              "packages/operator-core/lib/agent-tools/events/watch.ts",
              "packages/operator-core/lib/agent-tools/scheduler/get_next.ts",
              "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
              "packages/operator-core/lib/desktop-install/papercusp-files.ts",
              "packages/operator-core/lib/fleet/capacity-recovery-evidence.ts",
              "packages/operator-core/lib/harness/routines/loop.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
              "packages/operator-core/lib/llm-testing/targets/su.ts",
              "packages/operator-core/lib/llm-testing/test-run-ledger.ts",
              "scripts/verify-fleet-capacity-recovery.mts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts"
            ],
            "runtimeUnits": [
              "llm-test-in-process-1349606"
            ],
            "schemaVersion": 1,
            "completedRuntime": {
              "kind": "llm-in-process"
            }
          }
        },
        "observedAt": "2026-10-24T06:07:18.724Z",
        "bindingFingerprint": "cbf4e64d8467b81a476a330c3ffd1a93f961d95d19dfa928f5a41c62db2e7960",
        "createdBy": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "createdAt": "2026-10-24T06:07:18.491Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture",
            "environment"
          ],
          "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
          "current": {
            "planSlug": "luna-drain-capacity-recovery-2026-10-23",
            "specId": "AUTO-BAR-R-4-P-004",
            "specRevision": 4,
            "specFingerprint": "5282833d6544e041b8b06ea2be5d7fd2627873b1badc9679abe352b57c76ba9f",
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
            "sourceFingerprint": "sha256-file-set-v1:0ea13bffb340badd75d0cf3447cd370ec854b14c52416613bd12ed6db9518e16",
            "testFingerprint": "sha256-file-set-v1:4c03e6bf2fb42e14c41edab78f1d0db21ba774c657c2215e96f96a08768d73c2",
            "fixtureFingerprint": "sha256-file-set-v1:4c03e6bf2fb42e14c41edab78f1d0db21ba774c657c2215e96f96a08768d73c2",
            "environmentFingerprint": "2019944703dd1c3662b7c8a60ca333d7e4193e3ec0ac274c545c4b00c30b49d1"
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
            "environment": "current",
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
        "id": 68537,
        "workItemId": "WI-6554700010025538",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "AUTO-BAR-R-4-P-004",
        "sourceValId": null,
        "specRevision": 4,
        "currentRevision": 4,
        "specFingerprint": "5282833d6544e041b8b06ea2be5d7fd2627873b1badc9679abe352b57c76ba9f",
        "evidenceKind": "test",
        "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:0ea13bffb340badd75d0cf3447cd370ec854b14c52416613bd12ed6db9518e16",
          "testFingerprint": "sha256-file-set-v1:4c03e6bf2fb42e14c41edab78f1d0db21ba774c657c2215e96f96a08768d73c2",
          "fixtureFingerprint": "sha256-file-set-v1:4c03e6bf2fb42e14c41edab78f1d0db21ba774c657c2215e96f96a08768d73c2",
          "rubricFingerprint": null,
          "environmentFingerprint": "b05d3c6f61da0368e6eadd2c059a1ed6f12fd41c535a49da50647684d987895e"
        },
        "coverageEvidenceRef": null,
        "testRunId": 21868510,
        "testRunExecution": {
          "status": "pass",
          "passed": 1,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
          "scenarioId": "su-S42-drain-watch-preexisting",
          "passedCaseTitlesIncomplete": true,
          "testLayer": "llm"
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
          "framework": "llm-test",
          "source": "local",
          "mutationPhase": null,
          "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 21868510,
            "source": "local",
            "status": "pass",
            "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
            "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
            "finishedAt": "2026-10-24T05:11:24.523Z",
            "asCommitted": {
              "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-339c94acbe-cx0yMN",
            "mutationPhase": null,
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "AUTO-BAR-R-4-P-004",
            "collected": true,
            "testCases": [
              "su-S42-drain-watch-preexisting"
            ],
            "testLayer": "llm",
            "falsifiable": true,
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "live",
          "measurementPin": {
            "files": [
              {
                "path": "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "cdb059d89031bfdcd5a8f6f249aee4a883618579d333d0c46941c3b5eda16b66",
                "headBlob": "ad8bea9cf067c6c804746bae5a80460532ad8f5a",
                "dimension": "source"
              },
              {
                "path": "libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts/fleet-posture.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "72597f9cda7e159e49451249196dc3134368bed844e807781c4a412753e55170",
                "headBlob": "4ae91e731b93a1f69e7121de8004b1a8adaa9873",
                "dimension": "source"
              },
              {
                "path": "libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "6dcae35526f7dd1f29954c8da11eaf5dff8e1648232811b9e1494d0e04686496",
                "headBlob": "49d5e62fb879657718e88f4aabee5c1627a56bb7",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/events/watch.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b9a4c3aff8a14d01e94407c8760a1df8a25536743fc50eaea739fd08cdfb218a",
                "headBlob": "e7f5387a1660636732f52532961478e3be339eb4",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/scheduler/get_next.ts",
                "repo": ".",
                "clean": true,
                "sha256": "0cffc0daf039c4bc08b863a0fbc4e5ebd8c2968795a6ab4ad008eb6d63e898c6",
                "headBlob": "8cebbd738d58ae45066ada67abe5bd7c0b3180d8",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "repo": ".",
                "clean": true,
                "sha256": "bb108bbdc66b207a44155c6e3dfb6b37d85a4e3f3bffe3fdecafc6bfacb0301e",
                "headBlob": "1420766e3acf71d1e99610963df770b45faf1313",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/desktop-install/papercusp-files.ts",
                "repo": ".",
                "clean": true,
                "sha256": "ad031013ee30a357805e47c2ed16c5868f1351d2ad2e855fe3330b0ac653e06b",
                "headBlob": "c2c38da10ff912c6c634cd8073681dbe423f4f8d",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/fleet/capacity-recovery-evidence.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2507f43aab26678eac4372d35d3a4c9373b64d49cda389e4d963834fd50d8f5d",
                "headBlob": "c881fcaba3748c7ae3cd8273eeb8742732fd7e54",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/loop.ts",
                "repo": ".",
                "clean": true,
                "sha256": "612c811ac21d6ec20d2f04da2c25ae04d563aea7b496ad6db475dddfe7541a99",
                "headBlob": "ccb93fd05bbcca7edabefa810a3fe7d4e5d8831b",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b88e6705b4f415781ea81af19da1bdd25ac08d547432849612b07f9ee261713",
                "headBlob": "dc8e2644c30e62424c3cc11437007a94ea6b7949",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b08b2336b5046b985edee0914b9bff88319b32aaffd1cf62bca8e75c7e11427",
                "headBlob": "ed65fdaf7e6c7c9e300c6c3ba52769bca82084ef",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/targets/su.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9ecfb6c3139fbf4b6cd4524e51432e36d216f4283d09e4f9c338a85067ccc04d",
                "headBlob": "9591c7a33bbaef7fa95d509d6b7ee393c741fcd1",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/test-run-ledger.ts",
                "repo": ".",
                "clean": true,
                "sha256": "0189f069b512736e7e3104a957e55c2570154c4fcde754cedf6cfbd65f473795",
                "headBlob": "7bc4f6456a3f6832ad2265a91c38f190f43bcd7a",
                "dimension": "source"
              },
              {
                "path": "scripts/verify-fleet-capacity-recovery.mts",
                "repo": ".",
                "clean": true,
                "sha256": "4a431ede6616f70cc0498b046ce05d776a2872c49d81a59647040919565ddec6",
                "headBlob": "1e568ef85803553eb697f09d8ae2e12a2967feca",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b88e6705b4f415781ea81af19da1bdd25ac08d547432849612b07f9ee261713",
                "headBlob": "dc8e2644c30e62424c3cc11437007a94ea6b7949",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b88e6705b4f415781ea81af19da1bdd25ac08d547432849612b07f9ee261713",
                "headBlob": "dc8e2644c30e62424c3cc11437007a94ea6b7949",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "b0b5d23760f8065b133651c0325ec0b49620eeab",
                "repo": ".",
                "gitlink": null
              },
              {
                "head": "594cacf4fcd237efa597df1f40534f0cdd7a936e",
                "repo": "libs/papercusp",
                "gitlink": "594cacf4fcd237efa597df1f40534f0cdd7a936e"
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts"
            ],
            "sourcePaths": [
              "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
              "libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts/fleet-posture.md",
              "libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md",
              "packages/operator-core/lib/agent-tools/events/watch.ts",
              "packages/operator-core/lib/agent-tools/scheduler/get_next.ts",
              "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
              "packages/operator-core/lib/desktop-install/papercusp-files.ts",
              "packages/operator-core/lib/fleet/capacity-recovery-evidence.ts",
              "packages/operator-core/lib/harness/routines/loop.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
              "packages/operator-core/lib/llm-testing/targets/su.ts",
              "packages/operator-core/lib/llm-testing/test-run-ledger.ts",
              "scripts/verify-fleet-capacity-recovery.mts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts"
            ],
            "runtimeUnits": [
              "llm-test-in-process-1350872"
            ],
            "schemaVersion": 1,
            "completedRuntime": {
              "kind": "llm-in-process"
            }
          }
        },
        "observedAt": "2026-10-24T06:07:17.163Z",
        "bindingFingerprint": "b9fa3eded9b93de91ded636aa2708822b796d1f9d3bd1b351f405503cdcef6bd",
        "createdBy": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "createdAt": "2026-10-24T06:07:17.031Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture",
            "environment"
          ],
          "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
          "current": {
            "planSlug": "luna-drain-capacity-recovery-2026-10-23",
            "specId": "AUTO-BAR-R-4-P-004",
            "specRevision": 4,
            "specFingerprint": "5282833d6544e041b8b06ea2be5d7fd2627873b1badc9679abe352b57c76ba9f",
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
            "sourceFingerprint": "sha256-file-set-v1:0ea13bffb340badd75d0cf3447cd370ec854b14c52416613bd12ed6db9518e16",
            "testFingerprint": "sha256-file-set-v1:4c03e6bf2fb42e14c41edab78f1d0db21ba774c657c2215e96f96a08768d73c2",
            "fixtureFingerprint": "sha256-file-set-v1:4c03e6bf2fb42e14c41edab78f1d0db21ba774c657c2215e96f96a08768d73c2",
            "environmentFingerprint": "b05d3c6f61da0368e6eadd2c059a1ed6f12fd41c535a49da50647684d987895e"
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
            "environment": "current",
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
        "id": 68536,
        "workItemId": "WI-6554700010025538",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "AUTO-BAR-R-4-P-004",
        "sourceValId": null,
        "specRevision": 4,
        "currentRevision": 4,
        "specFingerprint": "5282833d6544e041b8b06ea2be5d7fd2627873b1badc9679abe352b57c76ba9f",
        "evidenceKind": "test",
        "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:0ea13bffb340badd75d0cf3447cd370ec854b14c52416613bd12ed6db9518e16",
          "testFingerprint": "sha256-file-set-v1:4c03e6bf2fb42e14c41edab78f1d0db21ba774c657c2215e96f96a08768d73c2",
          "fixtureFingerprint": "sha256-file-set-v1:4c03e6bf2fb42e14c41edab78f1d0db21ba774c657c2215e96f96a08768d73c2",
          "rubricFingerprint": null,
          "environmentFingerprint": "fbd6fa471c273c065978e2841c32a331674be8c6a5655a5a50675288cd995c59"
        },
        "coverageEvidenceRef": null,
        "testRunId": 21868481,
        "testRunExecution": {
          "status": "pass",
          "passed": 1,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
          "scenarioId": "su-S42-drain-watch-empty",
          "passedCaseTitlesIncomplete": true,
          "testLayer": "llm"
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
          "framework": "llm-test",
          "source": "local",
          "mutationPhase": null,
          "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 21868481,
            "source": "local",
            "status": "pass",
            "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
            "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
            "finishedAt": "2026-10-24T05:10:04.946Z",
            "asCommitted": {
              "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-339c94acbe-cx0yMN",
            "mutationPhase": null,
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "AUTO-BAR-R-4-P-004",
            "collected": true,
            "testCases": [
              "su-S42-drain-watch-empty"
            ],
            "testLayer": "llm",
            "falsifiable": true,
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "live",
          "measurementPin": {
            "files": [
              {
                "path": "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "cdb059d89031bfdcd5a8f6f249aee4a883618579d333d0c46941c3b5eda16b66",
                "headBlob": "ad8bea9cf067c6c804746bae5a80460532ad8f5a",
                "dimension": "source"
              },
              {
                "path": "libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts/fleet-posture.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "72597f9cda7e159e49451249196dc3134368bed844e807781c4a412753e55170",
                "headBlob": "4ae91e731b93a1f69e7121de8004b1a8adaa9873",
                "dimension": "source"
              },
              {
                "path": "libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "6dcae35526f7dd1f29954c8da11eaf5dff8e1648232811b9e1494d0e04686496",
                "headBlob": "49d5e62fb879657718e88f4aabee5c1627a56bb7",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/events/watch.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b9a4c3aff8a14d01e94407c8760a1df8a25536743fc50eaea739fd08cdfb218a",
                "headBlob": "e7f5387a1660636732f52532961478e3be339eb4",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/scheduler/get_next.ts",
                "repo": ".",
                "clean": true,
                "sha256": "0cffc0daf039c4bc08b863a0fbc4e5ebd8c2968795a6ab4ad008eb6d63e898c6",
                "headBlob": "8cebbd738d58ae45066ada67abe5bd7c0b3180d8",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "repo": ".",
                "clean": true,
                "sha256": "bb108bbdc66b207a44155c6e3dfb6b37d85a4e3f3bffe3fdecafc6bfacb0301e",
                "headBlob": "1420766e3acf71d1e99610963df770b45faf1313",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/desktop-install/papercusp-files.ts",
                "repo": ".",
                "clean": true,
                "sha256": "ad031013ee30a357805e47c2ed16c5868f1351d2ad2e855fe3330b0ac653e06b",
                "headBlob": "c2c38da10ff912c6c634cd8073681dbe423f4f8d",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/fleet/capacity-recovery-evidence.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2507f43aab26678eac4372d35d3a4c9373b64d49cda389e4d963834fd50d8f5d",
                "headBlob": "c881fcaba3748c7ae3cd8273eeb8742732fd7e54",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/loop.ts",
                "repo": ".",
                "clean": true,
                "sha256": "612c811ac21d6ec20d2f04da2c25ae04d563aea7b496ad6db475dddfe7541a99",
                "headBlob": "ccb93fd05bbcca7edabefa810a3fe7d4e5d8831b",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b88e6705b4f415781ea81af19da1bdd25ac08d547432849612b07f9ee261713",
                "headBlob": "dc8e2644c30e62424c3cc11437007a94ea6b7949",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b08b2336b5046b985edee0914b9bff88319b32aaffd1cf62bca8e75c7e11427",
                "headBlob": "ed65fdaf7e6c7c9e300c6c3ba52769bca82084ef",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/targets/su.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9ecfb6c3139fbf4b6cd4524e51432e36d216f4283d09e4f9c338a85067ccc04d",
                "headBlob": "9591c7a33bbaef7fa95d509d6b7ee393c741fcd1",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/test-run-ledger.ts",
                "repo": ".",
                "clean": true,
                "sha256": "0189f069b512736e7e3104a957e55c2570154c4fcde754cedf6cfbd65f473795",
                "headBlob": "7bc4f6456a3f6832ad2265a91c38f190f43bcd7a",
                "dimension": "source"
              },
              {
                "path": "scripts/verify-fleet-capacity-recovery.mts",
                "repo": ".",
                "clean": true,
                "sha256": "4a431ede6616f70cc0498b046ce05d776a2872c49d81a59647040919565ddec6",
                "headBlob": "1e568ef85803553eb697f09d8ae2e12a2967feca",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b88e6705b4f415781ea81af19da1bdd25ac08d547432849612b07f9ee261713",
                "headBlob": "dc8e2644c30e62424c3cc11437007a94ea6b7949",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b88e6705b4f415781ea81af19da1bdd25ac08d547432849612b07f9ee261713",
                "headBlob": "dc8e2644c30e62424c3cc11437007a94ea6b7949",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "b0b5d23760f8065b133651c0325ec0b49620eeab",
                "repo": ".",
                "gitlink": null
              },
              {
                "head": "594cacf4fcd237efa597df1f40534f0cdd7a936e",
                "repo": "libs/papercusp",
                "gitlink": "594cacf4fcd237efa597df1f40534f0cdd7a936e"
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts"
            ],
            "sourcePaths": [
              "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
              "libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts/fleet-posture.md",
              "libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md",
              "packages/operator-core/lib/agent-tools/events/watch.ts",
              "packages/operator-core/lib/agent-tools/scheduler/get_next.ts",
              "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
              "packages/operator-core/lib/desktop-install/papercusp-files.ts",
              "packages/operator-core/lib/fleet/capacity-recovery-evidence.ts",
              "packages/operator-core/lib/harness/routines/loop.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
              "packages/operator-core/lib/llm-testing/targets/su.ts",
              "packages/operator-core/lib/llm-testing/test-run-ledger.ts",
              "scripts/verify-fleet-capacity-recovery.mts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts"
            ],
            "runtimeUnits": [
              "llm-test-in-process-1261286"
            ],
            "schemaVersion": 1,
            "completedRuntime": {
              "kind": "llm-in-process"
            }
          }
        },
        "observedAt": "2026-10-24T06:07:15.884Z",
        "bindingFingerprint": "4842d1a4506fa0cfa842a4bec770d996935300b3bf4961bc38e52a1957b94a2b",
        "createdBy": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "createdAt": "2026-10-24T06:07:15.749Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture",
            "environment"
          ],
          "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
          "current": {
            "planSlug": "luna-drain-capacity-recovery-2026-10-23",
            "specId": "AUTO-BAR-R-4-P-004",
            "specRevision": 4,
            "specFingerprint": "5282833d6544e041b8b06ea2be5d7fd2627873b1badc9679abe352b57c76ba9f",
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
            "sourceFingerprint": "sha256-file-set-v1:0ea13bffb340badd75d0cf3447cd370ec854b14c52416613bd12ed6db9518e16",
            "testFingerprint": "sha256-file-set-v1:4c03e6bf2fb42e14c41edab78f1d0db21ba774c657c2215e96f96a08768d73c2",
            "fixtureFingerprint": "sha256-file-set-v1:4c03e6bf2fb42e14c41edab78f1d0db21ba774c657c2215e96f96a08768d73c2",
            "environmentFingerprint": "fbd6fa471c273c065978e2841c32a331674be8c6a5655a5a50675288cd995c59"
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
            "environment": "current",
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
        "id": 68535,
        "workItemId": "WI-6554700010025538",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "AUTO-BAR-R-4-P-004",
        "sourceValId": null,
        "specRevision": 4,
        "currentRevision": 4,
        "specFingerprint": "5282833d6544e041b8b06ea2be5d7fd2627873b1badc9679abe352b57c76ba9f",
        "evidenceKind": "test",
        "evidenceRef": "packages/operator-core/lib/agent-tools/scheduler/idle-loop-recipe-pin.test.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:0ea13bffb340badd75d0cf3447cd370ec854b14c52416613bd12ed6db9518e16",
          "testFingerprint": "sha256-file-set-v1:24e40c145b71ad55360c6a623be0575e5d2c2ebf6c41fa178e87816b24e38354",
          "fixtureFingerprint": "sha256-file-set-v1:24e40c145b71ad55360c6a623be0575e5d2c2ebf6c41fa178e87816b24e38354",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 21868446,
        "testRunExecution": {
          "status": "pass",
          "passed": 9,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/agent-tools/scheduler/idle-loop-recipe-pin.test.ts",
          "passedCaseTitles": [
            "P-006 idle-loop recipe pin (composable-event-awaits-2026-07-11) > IDLE_PULL_MISS_ADVICE carries the full recipe: claimable key, standing watch, hint-not-claim, no timer poll"
          ],
          "testLayer": "unit",
          "passedCaseTitleCount": 9,
          "passedCaseTitlesOmitted": 8,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                21868446
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/agent-tools/scheduler/idle-loop-recipe-pin.test.ts",
          "framework": "vitest",
          "source": "local",
          "mutationPhase": null,
          "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 21868446,
            "source": "local",
            "status": "pass",
            "filePath": "packages/operator-core/lib/agent-tools/scheduler/idle-loop-recipe-pin.test.ts",
            "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
            "finishedAt": "2026-10-24T05:02:54.491Z",
            "asCommitted": {
              "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-339c94acbe-cx0yMN",
            "mutationPhase": null,
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/agent-tools/scheduler/idle-loop-recipe-pin.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "AUTO-BAR-R-4-P-004",
            "collected": true,
            "testCases": [
              "IDLE_PULL_MISS_ADVICE carries the full recipe: claimable key, standing watch, hint-not-claim, no timer poll"
            ],
            "testLayer": "unit",
            "falsifiable": true,
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "cdb059d89031bfdcd5a8f6f249aee4a883618579d333d0c46941c3b5eda16b66",
                "headBlob": "ad8bea9cf067c6c804746bae5a80460532ad8f5a",
                "dimension": "source"
              },
              {
                "path": "libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts/fleet-posture.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "72597f9cda7e159e49451249196dc3134368bed844e807781c4a412753e55170",
                "headBlob": "4ae91e731b93a1f69e7121de8004b1a8adaa9873",
                "dimension": "source"
              },
              {
                "path": "libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "6dcae35526f7dd1f29954c8da11eaf5dff8e1648232811b9e1494d0e04686496",
                "headBlob": "49d5e62fb879657718e88f4aabee5c1627a56bb7",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/events/watch.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b9a4c3aff8a14d01e94407c8760a1df8a25536743fc50eaea739fd08cdfb218a",
                "headBlob": "e7f5387a1660636732f52532961478e3be339eb4",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/scheduler/get_next.ts",
                "repo": ".",
                "clean": true,
                "sha256": "0cffc0daf039c4bc08b863a0fbc4e5ebd8c2968795a6ab4ad008eb6d63e898c6",
                "headBlob": "8cebbd738d58ae45066ada67abe5bd7c0b3180d8",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "repo": ".",
                "clean": true,
                "sha256": "bb108bbdc66b207a44155c6e3dfb6b37d85a4e3f3bffe3fdecafc6bfacb0301e",
                "headBlob": "1420766e3acf71d1e99610963df770b45faf1313",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/desktop-install/papercusp-files.ts",
                "repo": ".",
                "clean": true,
                "sha256": "ad031013ee30a357805e47c2ed16c5868f1351d2ad2e855fe3330b0ac653e06b",
                "headBlob": "c2c38da10ff912c6c634cd8073681dbe423f4f8d",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/fleet/capacity-recovery-evidence.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2507f43aab26678eac4372d35d3a4c9373b64d49cda389e4d963834fd50d8f5d",
                "headBlob": "c881fcaba3748c7ae3cd8273eeb8742732fd7e54",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/loop.ts",
                "repo": ".",
                "clean": true,
                "sha256": "612c811ac21d6ec20d2f04da2c25ae04d563aea7b496ad6db475dddfe7541a99",
                "headBlob": "ccb93fd05bbcca7edabefa810a3fe7d4e5d8831b",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b88e6705b4f415781ea81af19da1bdd25ac08d547432849612b07f9ee261713",
                "headBlob": "dc8e2644c30e62424c3cc11437007a94ea6b7949",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b08b2336b5046b985edee0914b9bff88319b32aaffd1cf62bca8e75c7e11427",
                "headBlob": "ed65fdaf7e6c7c9e300c6c3ba52769bca82084ef",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/targets/su.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9ecfb6c3139fbf4b6cd4524e51432e36d216f4283d09e4f9c338a85067ccc04d",
                "headBlob": "9591c7a33bbaef7fa95d509d6b7ee393c741fcd1",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/test-run-ledger.ts",
                "repo": ".",
                "clean": true,
                "sha256": "0189f069b512736e7e3104a957e55c2570154c4fcde754cedf6cfbd65f473795",
                "headBlob": "7bc4f6456a3f6832ad2265a91c38f190f43bcd7a",
                "dimension": "source"
              },
              {
                "path": "scripts/verify-fleet-capacity-recovery.mts",
                "repo": ".",
                "clean": true,
                "sha256": "4a431ede6616f70cc0498b046ce05d776a2872c49d81a59647040919565ddec6",
                "headBlob": "1e568ef85803553eb697f09d8ae2e12a2967feca",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/scheduler/idle-loop-recipe-pin.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "aec85625f18da273357cd9ee7321cdae3b0c35b034c75fbd0a77195f5b9065e8",
                "headBlob": "4ab699da1d8775a8670a33257d5703a2e30fff8e",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/scheduler/idle-loop-recipe-pin.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "aec85625f18da273357cd9ee7321cdae3b0c35b034c75fbd0a77195f5b9065e8",
                "headBlob": "4ab699da1d8775a8670a33257d5703a2e30fff8e",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "b0b5d23760f8065b133651c0325ec0b49620eeab",
                "repo": ".",
                "gitlink": null
              },
              {
                "head": "594cacf4fcd237efa597df1f40534f0cdd7a936e",
                "repo": "libs/papercusp",
                "gitlink": "594cacf4fcd237efa597df1f40534f0cdd7a936e"
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/agent-tools/scheduler/idle-loop-recipe-pin.test.ts"
            ],
            "sourcePaths": [
              "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
              "libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts/fleet-posture.md",
              "libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md",
              "packages/operator-core/lib/agent-tools/events/watch.ts",
              "packages/operator-core/lib/agent-tools/scheduler/get_next.ts",
              "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
              "packages/operator-core/lib/desktop-install/papercusp-files.ts",
              "packages/operator-core/lib/fleet/capacity-recovery-evidence.ts",
              "packages/operator-core/lib/harness/routines/loop.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
              "packages/operator-core/lib/llm-testing/targets/su.ts",
              "packages/operator-core/lib/llm-testing/test-run-ledger.ts",
              "scripts/verify-fleet-capacity-recovery.mts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/agent-tools/scheduler/idle-loop-recipe-pin.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-24T06:07:14.728Z",
        "bindingFingerprint": "f19808a4997e8ad995283534b0ee5c9f49da3a92efcd11e44698ec28929bb68e",
        "createdBy": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "createdAt": "2026-10-24T06:07:14.550Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
          "current": {
            "planSlug": "luna-drain-capacity-recovery-2026-10-23",
            "specId": "AUTO-BAR-R-4-P-004",
            "specRevision": 4,
            "specFingerprint": "5282833d6544e041b8b06ea2be5d7fd2627873b1badc9679abe352b57c76ba9f",
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/agent-tools/scheduler/idle-loop-recipe-pin.test.ts",
            "sourceFingerprint": "sha256-file-set-v1:0ea13bffb340badd75d0cf3447cd370ec854b14c52416613bd12ed6db9518e16",
            "testFingerprint": "sha256-file-set-v1:24e40c145b71ad55360c6a623be0575e5d2c2ebf6c41fa178e87816b24e38354",
            "fixtureFingerprint": "sha256-file-set-v1:24e40c145b71ad55360c6a623be0575e5d2c2ebf6c41fa178e87816b24e38354"
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
        "id": 68534,
        "workItemId": "WI-6554700010025538",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "AUTO-BAR-R-4-P-004",
        "sourceValId": null,
        "specRevision": 4,
        "currentRevision": 4,
        "specFingerprint": "5282833d6544e041b8b06ea2be5d7fd2627873b1badc9679abe352b57c76ba9f",
        "evidenceKind": "test",
        "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.test.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:0ea13bffb340badd75d0cf3447cd370ec854b14c52416613bd12ed6db9518e16",
          "testFingerprint": "sha256-file-set-v1:fba9fe3f8a52dd8317eb94a34938efbaf5f23b983881fa6ae84d636291ae0fed",
          "fixtureFingerprint": "sha256-file-set-v1:fba9fe3f8a52dd8317eb94a34938efbaf5f23b983881fa6ae84d636291ae0fed",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 21868445,
        "testRunExecution": {
          "status": "pass",
          "passed": 16,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.test.ts",
          "passedCaseTitles": [
            "Luna drain subscribe/recheck behavioral experiment calibration > allows an initial miss but requires the post-subscription recheck before idle entry"
          ],
          "testLayer": "unit",
          "passedCaseTitleCount": 16,
          "passedCaseTitlesOmitted": 15,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                21868445
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.test.ts",
          "framework": "vitest",
          "source": "local",
          "mutationPhase": null,
          "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 21868445,
            "source": "local",
            "status": "pass",
            "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.test.ts",
            "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
            "finishedAt": "2026-10-24T05:02:54.383Z",
            "asCommitted": {
              "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-339c94acbe-cx0yMN",
            "mutationPhase": null,
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "AUTO-BAR-R-4-P-004",
            "collected": true,
            "testCases": [
              "allows an initial miss but requires the post-subscription recheck before idle entry"
            ],
            "testLayer": "unit",
            "falsifiable": true,
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "cdb059d89031bfdcd5a8f6f249aee4a883618579d333d0c46941c3b5eda16b66",
                "headBlob": "ad8bea9cf067c6c804746bae5a80460532ad8f5a",
                "dimension": "source"
              },
              {
                "path": "libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts/fleet-posture.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "72597f9cda7e159e49451249196dc3134368bed844e807781c4a412753e55170",
                "headBlob": "4ae91e731b93a1f69e7121de8004b1a8adaa9873",
                "dimension": "source"
              },
              {
                "path": "libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "6dcae35526f7dd1f29954c8da11eaf5dff8e1648232811b9e1494d0e04686496",
                "headBlob": "49d5e62fb879657718e88f4aabee5c1627a56bb7",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/events/watch.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b9a4c3aff8a14d01e94407c8760a1df8a25536743fc50eaea739fd08cdfb218a",
                "headBlob": "e7f5387a1660636732f52532961478e3be339eb4",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/scheduler/get_next.ts",
                "repo": ".",
                "clean": true,
                "sha256": "0cffc0daf039c4bc08b863a0fbc4e5ebd8c2968795a6ab4ad008eb6d63e898c6",
                "headBlob": "8cebbd738d58ae45066ada67abe5bd7c0b3180d8",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "repo": ".",
                "clean": true,
                "sha256": "bb108bbdc66b207a44155c6e3dfb6b37d85a4e3f3bffe3fdecafc6bfacb0301e",
                "headBlob": "1420766e3acf71d1e99610963df770b45faf1313",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/desktop-install/papercusp-files.ts",
                "repo": ".",
                "clean": true,
                "sha256": "ad031013ee30a357805e47c2ed16c5868f1351d2ad2e855fe3330b0ac653e06b",
                "headBlob": "c2c38da10ff912c6c634cd8073681dbe423f4f8d",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/fleet/capacity-recovery-evidence.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2507f43aab26678eac4372d35d3a4c9373b64d49cda389e4d963834fd50d8f5d",
                "headBlob": "c881fcaba3748c7ae3cd8273eeb8742732fd7e54",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/loop.ts",
                "repo": ".",
                "clean": true,
                "sha256": "612c811ac21d6ec20d2f04da2c25ae04d563aea7b496ad6db475dddfe7541a99",
                "headBlob": "ccb93fd05bbcca7edabefa810a3fe7d4e5d8831b",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b88e6705b4f415781ea81af19da1bdd25ac08d547432849612b07f9ee261713",
                "headBlob": "dc8e2644c30e62424c3cc11437007a94ea6b7949",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b08b2336b5046b985edee0914b9bff88319b32aaffd1cf62bca8e75c7e11427",
                "headBlob": "ed65fdaf7e6c7c9e300c6c3ba52769bca82084ef",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/targets/su.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9ecfb6c3139fbf4b6cd4524e51432e36d216f4283d09e4f9c338a85067ccc04d",
                "headBlob": "9591c7a33bbaef7fa95d509d6b7ee393c741fcd1",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/test-run-ledger.ts",
                "repo": ".",
                "clean": true,
                "sha256": "0189f069b512736e7e3104a957e55c2570154c4fcde754cedf6cfbd65f473795",
                "headBlob": "7bc4f6456a3f6832ad2265a91c38f190f43bcd7a",
                "dimension": "source"
              },
              {
                "path": "scripts/verify-fleet-capacity-recovery.mts",
                "repo": ".",
                "clean": true,
                "sha256": "4a431ede6616f70cc0498b046ce05d776a2872c49d81a59647040919565ddec6",
                "headBlob": "1e568ef85803553eb697f09d8ae2e12a2967feca",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b55a1a484d2d0c66311c24c77b0a8a2ac6d47b5737d4d774988d00032603010e",
                "headBlob": "771f9d4cd358a2f25d48e140114466ae3b00fadb",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b55a1a484d2d0c66311c24c77b0a8a2ac6d47b5737d4d774988d00032603010e",
                "headBlob": "771f9d4cd358a2f25d48e140114466ae3b00fadb",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "b0b5d23760f8065b133651c0325ec0b49620eeab",
                "repo": ".",
                "gitlink": null
              },
              {
                "head": "594cacf4fcd237efa597df1f40534f0cdd7a936e",
                "repo": "libs/papercusp",
                "gitlink": "594cacf4fcd237efa597df1f40534f0cdd7a936e"
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.test.ts"
            ],
            "sourcePaths": [
              "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
              "libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts/fleet-posture.md",
              "libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md",
              "packages/operator-core/lib/agent-tools/events/watch.ts",
              "packages/operator-core/lib/agent-tools/scheduler/get_next.ts",
              "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
              "packages/operator-core/lib/desktop-install/papercusp-files.ts",
              "packages/operator-core/lib/fleet/capacity-recovery-evidence.ts",
              "packages/operator-core/lib/harness/routines/loop.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
              "packages/operator-core/lib/llm-testing/targets/su.ts",
              "packages/operator-core/lib/llm-testing/test-run-ledger.ts",
              "scripts/verify-fleet-capacity-recovery.mts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-24T06:07:13.750Z",
        "bindingFingerprint": "f8f64bf1fba4db1b5b16320ca25f63ab6a523dc8f0a5b444aa591a11ba2f2739",
        "createdBy": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "createdAt": "2026-10-24T06:07:13.524Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
          "current": {
            "planSlug": "luna-drain-capacity-recovery-2026-10-23",
            "specId": "AUTO-BAR-R-4-P-004",
            "specRevision": 4,
            "specFingerprint": "5282833d6544e041b8b06ea2be5d7fd2627873b1badc9679abe352b57c76ba9f",
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.test.ts",
            "sourceFingerprint": "sha256-file-set-v1:0ea13bffb340badd75d0cf3447cd370ec854b14c52416613bd12ed6db9518e16",
            "testFingerprint": "sha256-file-set-v1:fba9fe3f8a52dd8317eb94a34938efbaf5f23b983881fa6ae84d636291ae0fed",
            "fixtureFingerprint": "sha256-file-set-v1:fba9fe3f8a52dd8317eb94a34938efbaf5f23b983881fa6ae84d636291ae0fed"
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
        "id": 68533,
        "workItemId": "WI-6554700010025538",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "AUTO-BAR-R-4-P-004",
        "sourceValId": null,
        "specRevision": 4,
        "currentRevision": 4,
        "specFingerprint": "5282833d6544e041b8b06ea2be5d7fd2627873b1badc9679abe352b57c76ba9f",
        "evidenceKind": "test",
        "evidenceRef": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:0ea13bffb340badd75d0cf3447cd370ec854b14c52416613bd12ed6db9518e16",
          "testFingerprint": "sha256-file-set-v1:6ae25d06990957a511426346d45157a8a9a9288cb46f3bc76e11c87059c474ce",
          "fixtureFingerprint": "sha256-file-set-v1:6ae25d06990957a511426346d45157a8a9a9288cb46f3bc76e11c87059c474ce",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 21868444,
        "testRunExecution": {
          "status": "pass",
          "passed": 42,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
          "passedCaseTitles": [
            "WI-10005697: standing pattern watch dedupe > the drained-lane contract is IDEMPOTENT: the identical standing watch twice yields ONE row + a deduped marker"
          ],
          "testLayer": "unit",
          "passedCaseTitleCount": 42,
          "passedCaseTitlesOmitted": 41,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                21868444
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
          "framework": "vitest",
          "source": "local",
          "mutationPhase": null,
          "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 21868444,
            "source": "local",
            "status": "pass",
            "filePath": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
            "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
            "finishedAt": "2026-10-24T05:02:46.593Z",
            "asCommitted": {
              "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-339c94acbe-cx0yMN",
            "mutationPhase": null,
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "AUTO-BAR-R-4-P-004",
            "collected": true,
            "testCases": [
              "the drained-lane contract is IDEMPOTENT: the identical standing watch twice yields ONE row + a deduped marker"
            ],
            "testLayer": "unit",
            "falsifiable": true,
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "cdb059d89031bfdcd5a8f6f249aee4a883618579d333d0c46941c3b5eda16b66",
                "headBlob": "ad8bea9cf067c6c804746bae5a80460532ad8f5a",
                "dimension": "source"
              },
              {
                "path": "libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts/fleet-posture.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "72597f9cda7e159e49451249196dc3134368bed844e807781c4a412753e55170",
                "headBlob": "4ae91e731b93a1f69e7121de8004b1a8adaa9873",
                "dimension": "source"
              },
              {
                "path": "libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "6dcae35526f7dd1f29954c8da11eaf5dff8e1648232811b9e1494d0e04686496",
                "headBlob": "49d5e62fb879657718e88f4aabee5c1627a56bb7",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/events/watch.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b9a4c3aff8a14d01e94407c8760a1df8a25536743fc50eaea739fd08cdfb218a",
                "headBlob": "e7f5387a1660636732f52532961478e3be339eb4",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/scheduler/get_next.ts",
                "repo": ".",
                "clean": true,
                "sha256": "0cffc0daf039c4bc08b863a0fbc4e5ebd8c2968795a6ab4ad008eb6d63e898c6",
                "headBlob": "8cebbd738d58ae45066ada67abe5bd7c0b3180d8",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "repo": ".",
                "clean": true,
                "sha256": "bb108bbdc66b207a44155c6e3dfb6b37d85a4e3f3bffe3fdecafc6bfacb0301e",
                "headBlob": "1420766e3acf71d1e99610963df770b45faf1313",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/desktop-install/papercusp-files.ts",
                "repo": ".",
                "clean": true,
                "sha256": "ad031013ee30a357805e47c2ed16c5868f1351d2ad2e855fe3330b0ac653e06b",
                "headBlob": "c2c38da10ff912c6c634cd8073681dbe423f4f8d",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/fleet/capacity-recovery-evidence.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2507f43aab26678eac4372d35d3a4c9373b64d49cda389e4d963834fd50d8f5d",
                "headBlob": "c881fcaba3748c7ae3cd8273eeb8742732fd7e54",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/loop.ts",
                "repo": ".",
                "clean": true,
                "sha256": "612c811ac21d6ec20d2f04da2c25ae04d563aea7b496ad6db475dddfe7541a99",
                "headBlob": "ccb93fd05bbcca7edabefa810a3fe7d4e5d8831b",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b88e6705b4f415781ea81af19da1bdd25ac08d547432849612b07f9ee261713",
                "headBlob": "dc8e2644c30e62424c3cc11437007a94ea6b7949",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b08b2336b5046b985edee0914b9bff88319b32aaffd1cf62bca8e75c7e11427",
                "headBlob": "ed65fdaf7e6c7c9e300c6c3ba52769bca82084ef",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/targets/su.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9ecfb6c3139fbf4b6cd4524e51432e36d216f4283d09e4f9c338a85067ccc04d",
                "headBlob": "9591c7a33bbaef7fa95d509d6b7ee393c741fcd1",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/test-run-ledger.ts",
                "repo": ".",
                "clean": true,
                "sha256": "0189f069b512736e7e3104a957e55c2570154c4fcde754cedf6cfbd65f473795",
                "headBlob": "7bc4f6456a3f6832ad2265a91c38f190f43bcd7a",
                "dimension": "source"
              },
              {
                "path": "scripts/verify-fleet-capacity-recovery.mts",
                "repo": ".",
                "clean": true,
                "sha256": "4a431ede6616f70cc0498b046ce05d776a2872c49d81a59647040919565ddec6",
                "headBlob": "1e568ef85803553eb697f09d8ae2e12a2967feca",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b4aa0e9fc9b936e7b4b1bc3d0030dc1e62badc6854548cf3e147d280fee79bc8",
                "headBlob": "5fe8ce8e5c31601f7b2df53d2ba2519897ae72d4",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b4aa0e9fc9b936e7b4b1bc3d0030dc1e62badc6854548cf3e147d280fee79bc8",
                "headBlob": "5fe8ce8e5c31601f7b2df53d2ba2519897ae72d4",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "b0b5d23760f8065b133651c0325ec0b49620eeab",
                "repo": ".",
                "gitlink": null
              },
              {
                "head": "594cacf4fcd237efa597df1f40534f0cdd7a936e",
                "repo": "libs/papercusp",
                "gitlink": "594cacf4fcd237efa597df1f40534f0cdd7a936e"
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/agent-tools/events/watch.test.ts"
            ],
            "sourcePaths": [
              "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
              "libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts/fleet-posture.md",
              "libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md",
              "packages/operator-core/lib/agent-tools/events/watch.ts",
              "packages/operator-core/lib/agent-tools/scheduler/get_next.ts",
              "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
              "packages/operator-core/lib/desktop-install/papercusp-files.ts",
              "packages/operator-core/lib/fleet/capacity-recovery-evidence.ts",
              "packages/operator-core/lib/harness/routines/loop.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
              "packages/operator-core/lib/llm-testing/targets/su.ts",
              "packages/operator-core/lib/llm-testing/test-run-ledger.ts",
              "scripts/verify-fleet-capacity-recovery.mts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/agent-tools/events/watch.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-24T06:07:12.721Z",
        "bindingFingerprint": "57974167759fa1f70d4b23a3129626e45dbfdd55cdb546fb9c11d7f8afcaf431",
        "createdBy": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "createdAt": "2026-10-24T06:07:12.618Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
          "current": {
            "planSlug": "luna-drain-capacity-recovery-2026-10-23",
            "specId": "AUTO-BAR-R-4-P-004",
            "specRevision": 4,
            "specFingerprint": "5282833d6544e041b8b06ea2be5d7fd2627873b1badc9679abe352b57c76ba9f",
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
            "sourceFingerprint": "sha256-file-set-v1:0ea13bffb340badd75d0cf3447cd370ec854b14c52416613bd12ed6db9518e16",
            "testFingerprint": "sha256-file-set-v1:6ae25d06990957a511426346d45157a8a9a9288cb46f3bc76e11c87059c474ce",
            "fixtureFingerprint": "sha256-file-set-v1:6ae25d06990957a511426346d45157a8a9a9288cb46f3bc76e11c87059c474ce"
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
        "id": 68532,
        "workItemId": "WI-6554700010025538",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "LUNA-CAPACITY-004",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "f25ed6fc1f7f3685371124be89743c7f7c7dadf6d2db4dea132efc77d8c3cf9c",
        "evidenceKind": "test",
        "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:0ea13bffb340badd75d0cf3447cd370ec854b14c52416613bd12ed6db9518e16",
          "testFingerprint": "sha256-file-set-v1:4c03e6bf2fb42e14c41edab78f1d0db21ba774c657c2215e96f96a08768d73c2",
          "fixtureFingerprint": "sha256-file-set-v1:4c03e6bf2fb42e14c41edab78f1d0db21ba774c657c2215e96f96a08768d73c2",
          "rubricFingerprint": null,
          "environmentFingerprint": "2019944703dd1c3662b7c8a60ca333d7e4193e3ec0ac274c545c4b00c30b49d1"
        },
        "coverageEvidenceRef": null,
        "testRunId": 21868509,
        "testRunExecution": {
          "status": "pass",
          "passed": 1,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
          "scenarioId": "su-S42-drain-watch-during-registration",
          "passedCaseTitlesIncomplete": true,
          "testLayer": "llm"
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
          "framework": "llm-test",
          "source": "local",
          "mutationPhase": null,
          "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 21868509,
            "source": "local",
            "status": "pass",
            "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
            "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
            "finishedAt": "2026-10-24T05:11:32.063Z",
            "asCommitted": {
              "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-339c94acbe-cx0yMN",
            "mutationPhase": null,
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "LUNA-CAPACITY-004",
            "collected": true,
            "testCases": [
              "su-S42-drain-watch-during-registration"
            ],
            "testLayer": "llm",
            "falsifiable": true,
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "live",
          "measurementPin": {
            "files": [
              {
                "path": "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "cdb059d89031bfdcd5a8f6f249aee4a883618579d333d0c46941c3b5eda16b66",
                "headBlob": "ad8bea9cf067c6c804746bae5a80460532ad8f5a",
                "dimension": "source"
              },
              {
                "path": "libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts/fleet-posture.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "72597f9cda7e159e49451249196dc3134368bed844e807781c4a412753e55170",
                "headBlob": "4ae91e731b93a1f69e7121de8004b1a8adaa9873",
                "dimension": "source"
              },
              {
                "path": "libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "6dcae35526f7dd1f29954c8da11eaf5dff8e1648232811b9e1494d0e04686496",
                "headBlob": "49d5e62fb879657718e88f4aabee5c1627a56bb7",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/events/watch.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b9a4c3aff8a14d01e94407c8760a1df8a25536743fc50eaea739fd08cdfb218a",
                "headBlob": "e7f5387a1660636732f52532961478e3be339eb4",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/scheduler/get_next.ts",
                "repo": ".",
                "clean": true,
                "sha256": "0cffc0daf039c4bc08b863a0fbc4e5ebd8c2968795a6ab4ad008eb6d63e898c6",
                "headBlob": "8cebbd738d58ae45066ada67abe5bd7c0b3180d8",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "repo": ".",
                "clean": true,
                "sha256": "bb108bbdc66b207a44155c6e3dfb6b37d85a4e3f3bffe3fdecafc6bfacb0301e",
                "headBlob": "1420766e3acf71d1e99610963df770b45faf1313",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/desktop-install/papercusp-files.ts",
                "repo": ".",
                "clean": true,
                "sha256": "ad031013ee30a357805e47c2ed16c5868f1351d2ad2e855fe3330b0ac653e06b",
                "headBlob": "c2c38da10ff912c6c634cd8073681dbe423f4f8d",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/fleet/capacity-recovery-evidence.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2507f43aab26678eac4372d35d3a4c9373b64d49cda389e4d963834fd50d8f5d",
                "headBlob": "c881fcaba3748c7ae3cd8273eeb8742732fd7e54",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/loop.ts",
                "repo": ".",
                "clean": true,
                "sha256": "612c811ac21d6ec20d2f04da2c25ae04d563aea7b496ad6db475dddfe7541a99",
                "headBlob": "ccb93fd05bbcca7edabefa810a3fe7d4e5d8831b",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b88e6705b4f415781ea81af19da1bdd25ac08d547432849612b07f9ee261713",
                "headBlob": "dc8e2644c30e62424c3cc11437007a94ea6b7949",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b08b2336b5046b985edee0914b9bff88319b32aaffd1cf62bca8e75c7e11427",
                "headBlob": "ed65fdaf7e6c7c9e300c6c3ba52769bca82084ef",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/targets/su.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9ecfb6c3139fbf4b6cd4524e51432e36d216f4283d09e4f9c338a85067ccc04d",
                "headBlob": "9591c7a33bbaef7fa95d509d6b7ee393c741fcd1",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/test-run-ledger.ts",
                "repo": ".",
                "clean": true,
                "sha256": "0189f069b512736e7e3104a957e55c2570154c4fcde754cedf6cfbd65f473795",
                "headBlob": "7bc4f6456a3f6832ad2265a91c38f190f43bcd7a",
                "dimension": "source"
              },
              {
                "path": "scripts/verify-fleet-capacity-recovery.mts",
                "repo": ".",
                "clean": true,
                "sha256": "4a431ede6616f70cc0498b046ce05d776a2872c49d81a59647040919565ddec6",
                "headBlob": "1e568ef85803553eb697f09d8ae2e12a2967feca",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b88e6705b4f415781ea81af19da1bdd25ac08d547432849612b07f9ee261713",
                "headBlob": "dc8e2644c30e62424c3cc11437007a94ea6b7949",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b88e6705b4f415781ea81af19da1bdd25ac08d547432849612b07f9ee261713",
                "headBlob": "dc8e2644c30e62424c3cc11437007a94ea6b7949",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "b0b5d23760f8065b133651c0325ec0b49620eeab",
                "repo": ".",
                "gitlink": null
              },
              {
                "head": "594cacf4fcd237efa597df1f40534f0cdd7a936e",
                "repo": "libs/papercusp",
                "gitlink": "594cacf4fcd237efa597df1f40534f0cdd7a936e"
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts"
            ],
            "sourcePaths": [
              "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
              "libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts/fleet-posture.md",
              "libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md",
              "packages/operator-core/lib/agent-tools/events/watch.ts",
              "packages/operator-core/lib/agent-tools/scheduler/get_next.ts",
              "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
              "packages/operator-core/lib/desktop-install/papercusp-files.ts",
              "packages/operator-core/lib/fleet/capacity-recovery-evidence.ts",
              "packages/operator-core/lib/harness/routines/loop.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
              "packages/operator-core/lib/llm-testing/targets/su.ts",
              "packages/operator-core/lib/llm-testing/test-run-ledger.ts",
              "scripts/verify-fleet-capacity-recovery.mts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts"
            ],
            "runtimeUnits": [
              "llm-test-in-process-1349606"
            ],
            "schemaVersion": 1,
            "completedRuntime": {
              "kind": "llm-in-process"
            }
          }
        },
        "observedAt": "2026-10-24T06:07:11.854Z",
        "bindingFingerprint": "1c9481a3f5689a6a66c561efdde13c4f4cbb92426ec6ce6d3574bc2cc7b1b0fc",
        "createdBy": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "createdAt": "2026-10-24T06:07:11.689Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture",
            "environment"
          ],
          "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
          "current": {
            "planSlug": "luna-drain-capacity-recovery-2026-10-23",
            "specId": "LUNA-CAPACITY-004",
            "specRevision": 2,
            "specFingerprint": "f25ed6fc1f7f3685371124be89743c7f7c7dadf6d2db4dea132efc77d8c3cf9c",
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
            "sourceFingerprint": "sha256-file-set-v1:0ea13bffb340badd75d0cf3447cd370ec854b14c52416613bd12ed6db9518e16",
            "testFingerprint": "sha256-file-set-v1:4c03e6bf2fb42e14c41edab78f1d0db21ba774c657c2215e96f96a08768d73c2",
            "fixtureFingerprint": "sha256-file-set-v1:4c03e6bf2fb42e14c41edab78f1d0db21ba774c657c2215e96f96a08768d73c2",
            "environmentFingerprint": "2019944703dd1c3662b7c8a60ca333d7e4193e3ec0ac274c545c4b00c30b49d1"
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
            "environment": "current",
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
        "id": 68531,
        "workItemId": "WI-6554700010025538",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "LUNA-CAPACITY-004",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "f25ed6fc1f7f3685371124be89743c7f7c7dadf6d2db4dea132efc77d8c3cf9c",
        "evidenceKind": "test",
        "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:0ea13bffb340badd75d0cf3447cd370ec854b14c52416613bd12ed6db9518e16",
          "testFingerprint": "sha256-file-set-v1:4c03e6bf2fb42e14c41edab78f1d0db21ba774c657c2215e96f96a08768d73c2",
          "fixtureFingerprint": "sha256-file-set-v1:4c03e6bf2fb42e14c41edab78f1d0db21ba774c657c2215e96f96a08768d73c2",
          "rubricFingerprint": null,
          "environmentFingerprint": "b05d3c6f61da0368e6eadd2c059a1ed6f12fd41c535a49da50647684d987895e"
        },
        "coverageEvidenceRef": null,
        "testRunId": 21868510,
        "testRunExecution": {
          "status": "pass",
          "passed": 1,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
          "scenarioId": "su-S42-drain-watch-preexisting",
          "passedCaseTitlesIncomplete": true,
          "testLayer": "llm"
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
          "framework": "llm-test",
          "source": "local",
          "mutationPhase": null,
          "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 21868510,
            "source": "local",
            "status": "pass",
            "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
            "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
            "finishedAt": "2026-10-24T05:11:24.523Z",
            "asCommitted": {
              "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-339c94acbe-cx0yMN",
            "mutationPhase": null,
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "LUNA-CAPACITY-004",
            "collected": true,
            "testCases": [
              "su-S42-drain-watch-preexisting"
            ],
            "testLayer": "llm",
            "falsifiable": true,
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "live",
          "measurementPin": {
            "files": [
              {
                "path": "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "cdb059d89031bfdcd5a8f6f249aee4a883618579d333d0c46941c3b5eda16b66",
                "headBlob": "ad8bea9cf067c6c804746bae5a80460532ad8f5a",
                "dimension": "source"
              },
              {
                "path": "libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts/fleet-posture.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "72597f9cda7e159e49451249196dc3134368bed844e807781c4a412753e55170",
                "headBlob": "4ae91e731b93a1f69e7121de8004b1a8adaa9873",
                "dimension": "source"
              },
              {
                "path": "libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "6dcae35526f7dd1f29954c8da11eaf5dff8e1648232811b9e1494d0e04686496",
                "headBlob": "49d5e62fb879657718e88f4aabee5c1627a56bb7",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/events/watch.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b9a4c3aff8a14d01e94407c8760a1df8a25536743fc50eaea739fd08cdfb218a",
                "headBlob": "e7f5387a1660636732f52532961478e3be339eb4",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/scheduler/get_next.ts",
                "repo": ".",
                "clean": true,
                "sha256": "0cffc0daf039c4bc08b863a0fbc4e5ebd8c2968795a6ab4ad008eb6d63e898c6",
                "headBlob": "8cebbd738d58ae45066ada67abe5bd7c0b3180d8",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "repo": ".",
                "clean": true,
                "sha256": "bb108bbdc66b207a44155c6e3dfb6b37d85a4e3f3bffe3fdecafc6bfacb0301e",
                "headBlob": "1420766e3acf71d1e99610963df770b45faf1313",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/desktop-install/papercusp-files.ts",
                "repo": ".",
                "clean": true,
                "sha256": "ad031013ee30a357805e47c2ed16c5868f1351d2ad2e855fe3330b0ac653e06b",
                "headBlob": "c2c38da10ff912c6c634cd8073681dbe423f4f8d",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/fleet/capacity-recovery-evidence.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2507f43aab26678eac4372d35d3a4c9373b64d49cda389e4d963834fd50d8f5d",
                "headBlob": "c881fcaba3748c7ae3cd8273eeb8742732fd7e54",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/loop.ts",
                "repo": ".",
                "clean": true,
                "sha256": "612c811ac21d6ec20d2f04da2c25ae04d563aea7b496ad6db475dddfe7541a99",
                "headBlob": "ccb93fd05bbcca7edabefa810a3fe7d4e5d8831b",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b88e6705b4f415781ea81af19da1bdd25ac08d547432849612b07f9ee261713",
                "headBlob": "dc8e2644c30e62424c3cc11437007a94ea6b7949",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b08b2336b5046b985edee0914b9bff88319b32aaffd1cf62bca8e75c7e11427",
                "headBlob": "ed65fdaf7e6c7c9e300c6c3ba52769bca82084ef",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/targets/su.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9ecfb6c3139fbf4b6cd4524e51432e36d216f4283d09e4f9c338a85067ccc04d",
                "headBlob": "9591c7a33bbaef7fa95d509d6b7ee393c741fcd1",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/test-run-ledger.ts",
                "repo": ".",
                "clean": true,
                "sha256": "0189f069b512736e7e3104a957e55c2570154c4fcde754cedf6cfbd65f473795",
                "headBlob": "7bc4f6456a3f6832ad2265a91c38f190f43bcd7a",
                "dimension": "source"
              },
              {
                "path": "scripts/verify-fleet-capacity-recovery.mts",
                "repo": ".",
                "clean": true,
                "sha256": "4a431ede6616f70cc0498b046ce05d776a2872c49d81a59647040919565ddec6",
                "headBlob": "1e568ef85803553eb697f09d8ae2e12a2967feca",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b88e6705b4f415781ea81af19da1bdd25ac08d547432849612b07f9ee261713",
                "headBlob": "dc8e2644c30e62424c3cc11437007a94ea6b7949",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b88e6705b4f415781ea81af19da1bdd25ac08d547432849612b07f9ee261713",
                "headBlob": "dc8e2644c30e62424c3cc11437007a94ea6b7949",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "b0b5d23760f8065b133651c0325ec0b49620eeab",
                "repo": ".",
                "gitlink": null
              },
              {
                "head": "594cacf4fcd237efa597df1f40534f0cdd7a936e",
                "repo": "libs/papercusp",
                "gitlink": "594cacf4fcd237efa597df1f40534f0cdd7a936e"
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts"
            ],
            "sourcePaths": [
              "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
              "libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts/fleet-posture.md",
              "libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md",
              "packages/operator-core/lib/agent-tools/events/watch.ts",
              "packages/operator-core/lib/agent-tools/scheduler/get_next.ts",
              "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
              "packages/operator-core/lib/desktop-install/papercusp-files.ts",
              "packages/operator-core/lib/fleet/capacity-recovery-evidence.ts",
              "packages/operator-core/lib/harness/routines/loop.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
              "packages/operator-core/lib/llm-testing/targets/su.ts",
              "packages/operator-core/lib/llm-testing/test-run-ledger.ts",
              "scripts/verify-fleet-capacity-recovery.mts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts"
            ],
            "runtimeUnits": [
              "llm-test-in-process-1350872"
            ],
            "schemaVersion": 1,
            "completedRuntime": {
              "kind": "llm-in-process"
            }
          }
        },
        "observedAt": "2026-10-24T06:07:10.874Z",
        "bindingFingerprint": "5504da9793678c3932c308bce26ffc220c4dd9a3a64f9229c09b46f36b9a4a86",
        "createdBy": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "createdAt": "2026-10-24T06:07:10.711Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture",
            "environment"
          ],
          "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
          "current": {
            "planSlug": "luna-drain-capacity-recovery-2026-10-23",
            "specId": "LUNA-CAPACITY-004",
            "specRevision": 2,
            "specFingerprint": "f25ed6fc1f7f3685371124be89743c7f7c7dadf6d2db4dea132efc77d8c3cf9c",
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
            "sourceFingerprint": "sha256-file-set-v1:0ea13bffb340badd75d0cf3447cd370ec854b14c52416613bd12ed6db9518e16",
            "testFingerprint": "sha256-file-set-v1:4c03e6bf2fb42e14c41edab78f1d0db21ba774c657c2215e96f96a08768d73c2",
            "fixtureFingerprint": "sha256-file-set-v1:4c03e6bf2fb42e14c41edab78f1d0db21ba774c657c2215e96f96a08768d73c2",
            "environmentFingerprint": "b05d3c6f61da0368e6eadd2c059a1ed6f12fd41c535a49da50647684d987895e"
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
            "environment": "current",
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
        "id": 68530,
        "workItemId": "WI-6554700010025538",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "LUNA-CAPACITY-004",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "f25ed6fc1f7f3685371124be89743c7f7c7dadf6d2db4dea132efc77d8c3cf9c",
        "evidenceKind": "test",
        "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:0ea13bffb340badd75d0cf3447cd370ec854b14c52416613bd12ed6db9518e16",
          "testFingerprint": "sha256-file-set-v1:4c03e6bf2fb42e14c41edab78f1d0db21ba774c657c2215e96f96a08768d73c2",
          "fixtureFingerprint": "sha256-file-set-v1:4c03e6bf2fb42e14c41edab78f1d0db21ba774c657c2215e96f96a08768d73c2",
          "rubricFingerprint": null,
          "environmentFingerprint": "fbd6fa471c273c065978e2841c32a331674be8c6a5655a5a50675288cd995c59"
        },
        "coverageEvidenceRef": null,
        "testRunId": 21868481,
        "testRunExecution": {
          "status": "pass",
          "passed": 1,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
          "scenarioId": "su-S42-drain-watch-empty",
          "passedCaseTitlesIncomplete": true,
          "testLayer": "llm"
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
          "framework": "llm-test",
          "source": "local",
          "mutationPhase": null,
          "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 21868481,
            "source": "local",
            "status": "pass",
            "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
            "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
            "finishedAt": "2026-10-24T05:10:04.946Z",
            "asCommitted": {
              "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-339c94acbe-cx0yMN",
            "mutationPhase": null,
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "LUNA-CAPACITY-004",
            "collected": true,
            "testCases": [
              "su-S42-drain-watch-empty"
            ],
            "testLayer": "llm",
            "falsifiable": true,
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "live",
          "measurementPin": {
            "files": [
              {
                "path": "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "cdb059d89031bfdcd5a8f6f249aee4a883618579d333d0c46941c3b5eda16b66",
                "headBlob": "ad8bea9cf067c6c804746bae5a80460532ad8f5a",
                "dimension": "source"
              },
              {
                "path": "libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts/fleet-posture.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "72597f9cda7e159e49451249196dc3134368bed844e807781c4a412753e55170",
                "headBlob": "4ae91e731b93a1f69e7121de8004b1a8adaa9873",
                "dimension": "source"
              },
              {
                "path": "libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "6dcae35526f7dd1f29954c8da11eaf5dff8e1648232811b9e1494d0e04686496",
                "headBlob": "49d5e62fb879657718e88f4aabee5c1627a56bb7",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/events/watch.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b9a4c3aff8a14d01e94407c8760a1df8a25536743fc50eaea739fd08cdfb218a",
                "headBlob": "e7f5387a1660636732f52532961478e3be339eb4",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/scheduler/get_next.ts",
                "repo": ".",
                "clean": true,
                "sha256": "0cffc0daf039c4bc08b863a0fbc4e5ebd8c2968795a6ab4ad008eb6d63e898c6",
                "headBlob": "8cebbd738d58ae45066ada67abe5bd7c0b3180d8",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "repo": ".",
                "clean": true,
                "sha256": "bb108bbdc66b207a44155c6e3dfb6b37d85a4e3f3bffe3fdecafc6bfacb0301e",
                "headBlob": "1420766e3acf71d1e99610963df770b45faf1313",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/desktop-install/papercusp-files.ts",
                "repo": ".",
                "clean": true,
                "sha256": "ad031013ee30a357805e47c2ed16c5868f1351d2ad2e855fe3330b0ac653e06b",
                "headBlob": "c2c38da10ff912c6c634cd8073681dbe423f4f8d",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/fleet/capacity-recovery-evidence.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2507f43aab26678eac4372d35d3a4c9373b64d49cda389e4d963834fd50d8f5d",
                "headBlob": "c881fcaba3748c7ae3cd8273eeb8742732fd7e54",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/loop.ts",
                "repo": ".",
                "clean": true,
                "sha256": "612c811ac21d6ec20d2f04da2c25ae04d563aea7b496ad6db475dddfe7541a99",
                "headBlob": "ccb93fd05bbcca7edabefa810a3fe7d4e5d8831b",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b88e6705b4f415781ea81af19da1bdd25ac08d547432849612b07f9ee261713",
                "headBlob": "dc8e2644c30e62424c3cc11437007a94ea6b7949",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b08b2336b5046b985edee0914b9bff88319b32aaffd1cf62bca8e75c7e11427",
                "headBlob": "ed65fdaf7e6c7c9e300c6c3ba52769bca82084ef",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/targets/su.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9ecfb6c3139fbf4b6cd4524e51432e36d216f4283d09e4f9c338a85067ccc04d",
                "headBlob": "9591c7a33bbaef7fa95d509d6b7ee393c741fcd1",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/test-run-ledger.ts",
                "repo": ".",
                "clean": true,
                "sha256": "0189f069b512736e7e3104a957e55c2570154c4fcde754cedf6cfbd65f473795",
                "headBlob": "7bc4f6456a3f6832ad2265a91c38f190f43bcd7a",
                "dimension": "source"
              },
              {
                "path": "scripts/verify-fleet-capacity-recovery.mts",
                "repo": ".",
                "clean": true,
                "sha256": "4a431ede6616f70cc0498b046ce05d776a2872c49d81a59647040919565ddec6",
                "headBlob": "1e568ef85803553eb697f09d8ae2e12a2967feca",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b88e6705b4f415781ea81af19da1bdd25ac08d547432849612b07f9ee261713",
                "headBlob": "dc8e2644c30e62424c3cc11437007a94ea6b7949",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b88e6705b4f415781ea81af19da1bdd25ac08d547432849612b07f9ee261713",
                "headBlob": "dc8e2644c30e62424c3cc11437007a94ea6b7949",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "b0b5d23760f8065b133651c0325ec0b49620eeab",
                "repo": ".",
                "gitlink": null
              },
              {
                "head": "594cacf4fcd237efa597df1f40534f0cdd7a936e",
                "repo": "libs/papercusp",
                "gitlink": "594cacf4fcd237efa597df1f40534f0cdd7a936e"
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts"
            ],
            "sourcePaths": [
              "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
              "libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts/fleet-posture.md",
              "libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md",
              "packages/operator-core/lib/agent-tools/events/watch.ts",
              "packages/operator-core/lib/agent-tools/scheduler/get_next.ts",
              "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
              "packages/operator-core/lib/desktop-install/papercusp-files.ts",
              "packages/operator-core/lib/fleet/capacity-recovery-evidence.ts",
              "packages/operator-core/lib/harness/routines/loop.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
              "packages/operator-core/lib/llm-testing/targets/su.ts",
              "packages/operator-core/lib/llm-testing/test-run-ledger.ts",
              "scripts/verify-fleet-capacity-recovery.mts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts"
            ],
            "runtimeUnits": [
              "llm-test-in-process-1261286"
            ],
            "schemaVersion": 1,
            "completedRuntime": {
              "kind": "llm-in-process"
            }
          }
        },
        "observedAt": "2026-10-24T06:07:09.768Z",
        "bindingFingerprint": "318826086a2b0bf0f99bb660e9f004d626bf6af03e0eb92d2b6c04589c0ccf9d",
        "createdBy": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "createdAt": "2026-10-24T06:07:09.677Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture",
            "environment"
          ],
          "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
          "current": {
            "planSlug": "luna-drain-capacity-recovery-2026-10-23",
            "specId": "LUNA-CAPACITY-004",
            "specRevision": 2,
            "specFingerprint": "f25ed6fc1f7f3685371124be89743c7f7c7dadf6d2db4dea132efc77d8c3cf9c",
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
            "sourceFingerprint": "sha256-file-set-v1:0ea13bffb340badd75d0cf3447cd370ec854b14c52416613bd12ed6db9518e16",
            "testFingerprint": "sha256-file-set-v1:4c03e6bf2fb42e14c41edab78f1d0db21ba774c657c2215e96f96a08768d73c2",
            "fixtureFingerprint": "sha256-file-set-v1:4c03e6bf2fb42e14c41edab78f1d0db21ba774c657c2215e96f96a08768d73c2",
            "environmentFingerprint": "fbd6fa471c273c065978e2841c32a331674be8c6a5655a5a50675288cd995c59"
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
            "environment": "current",
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
        "id": 68529,
        "workItemId": "WI-6554700010025538",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "LUNA-CAPACITY-004",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "f25ed6fc1f7f3685371124be89743c7f7c7dadf6d2db4dea132efc77d8c3cf9c",
        "evidenceKind": "test",
        "evidenceRef": "packages/operator-core/lib/agent-tools/scheduler/idle-loop-recipe-pin.test.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:0ea13bffb340badd75d0cf3447cd370ec854b14c52416613bd12ed6db9518e16",
          "testFingerprint": "sha256-file-set-v1:24e40c145b71ad55360c6a623be0575e5d2c2ebf6c41fa178e87816b24e38354",
          "fixtureFingerprint": "sha256-file-set-v1:24e40c145b71ad55360c6a623be0575e5d2c2ebf6c41fa178e87816b24e38354",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 21868446,
        "testRunExecution": {
          "status": "pass",
          "passed": 9,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/agent-tools/scheduler/idle-loop-recipe-pin.test.ts",
          "passedCaseTitles": [
            "P-006 idle-loop recipe pin (composable-event-awaits-2026-07-11) > IDLE_PULL_MISS_ADVICE carries the full recipe: claimable key, standing watch, hint-not-claim, no timer poll"
          ],
          "testLayer": "unit",
          "passedCaseTitleCount": 9,
          "passedCaseTitlesOmitted": 8,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                21868446
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/agent-tools/scheduler/idle-loop-recipe-pin.test.ts",
          "framework": "vitest",
          "source": "local",
          "mutationPhase": null,
          "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 21868446,
            "source": "local",
            "status": "pass",
            "filePath": "packages/operator-core/lib/agent-tools/scheduler/idle-loop-recipe-pin.test.ts",
            "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
            "finishedAt": "2026-10-24T05:02:54.491Z",
            "asCommitted": {
              "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-339c94acbe-cx0yMN",
            "mutationPhase": null,
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/agent-tools/scheduler/idle-loop-recipe-pin.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "LUNA-CAPACITY-004",
            "collected": true,
            "testCases": [
              "IDLE_PULL_MISS_ADVICE carries the full recipe: claimable key, standing watch, hint-not-claim, no timer poll"
            ],
            "testLayer": "unit",
            "falsifiable": true,
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "cdb059d89031bfdcd5a8f6f249aee4a883618579d333d0c46941c3b5eda16b66",
                "headBlob": "ad8bea9cf067c6c804746bae5a80460532ad8f5a",
                "dimension": "source"
              },
              {
                "path": "libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts/fleet-posture.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "72597f9cda7e159e49451249196dc3134368bed844e807781c4a412753e55170",
                "headBlob": "4ae91e731b93a1f69e7121de8004b1a8adaa9873",
                "dimension": "source"
              },
              {
                "path": "libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "6dcae35526f7dd1f29954c8da11eaf5dff8e1648232811b9e1494d0e04686496",
                "headBlob": "49d5e62fb879657718e88f4aabee5c1627a56bb7",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/events/watch.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b9a4c3aff8a14d01e94407c8760a1df8a25536743fc50eaea739fd08cdfb218a",
                "headBlob": "e7f5387a1660636732f52532961478e3be339eb4",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/scheduler/get_next.ts",
                "repo": ".",
                "clean": true,
                "sha256": "0cffc0daf039c4bc08b863a0fbc4e5ebd8c2968795a6ab4ad008eb6d63e898c6",
                "headBlob": "8cebbd738d58ae45066ada67abe5bd7c0b3180d8",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "repo": ".",
                "clean": true,
                "sha256": "bb108bbdc66b207a44155c6e3dfb6b37d85a4e3f3bffe3fdecafc6bfacb0301e",
                "headBlob": "1420766e3acf71d1e99610963df770b45faf1313",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/desktop-install/papercusp-files.ts",
                "repo": ".",
                "clean": true,
                "sha256": "ad031013ee30a357805e47c2ed16c5868f1351d2ad2e855fe3330b0ac653e06b",
                "headBlob": "c2c38da10ff912c6c634cd8073681dbe423f4f8d",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/fleet/capacity-recovery-evidence.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2507f43aab26678eac4372d35d3a4c9373b64d49cda389e4d963834fd50d8f5d",
                "headBlob": "c881fcaba3748c7ae3cd8273eeb8742732fd7e54",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/loop.ts",
                "repo": ".",
                "clean": true,
                "sha256": "612c811ac21d6ec20d2f04da2c25ae04d563aea7b496ad6db475dddfe7541a99",
                "headBlob": "ccb93fd05bbcca7edabefa810a3fe7d4e5d8831b",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b88e6705b4f415781ea81af19da1bdd25ac08d547432849612b07f9ee261713",
                "headBlob": "dc8e2644c30e62424c3cc11437007a94ea6b7949",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b08b2336b5046b985edee0914b9bff88319b32aaffd1cf62bca8e75c7e11427",
                "headBlob": "ed65fdaf7e6c7c9e300c6c3ba52769bca82084ef",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/targets/su.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9ecfb6c3139fbf4b6cd4524e51432e36d216f4283d09e4f9c338a85067ccc04d",
                "headBlob": "9591c7a33bbaef7fa95d509d6b7ee393c741fcd1",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/test-run-ledger.ts",
                "repo": ".",
                "clean": true,
                "sha256": "0189f069b512736e7e3104a957e55c2570154c4fcde754cedf6cfbd65f473795",
                "headBlob": "7bc4f6456a3f6832ad2265a91c38f190f43bcd7a",
                "dimension": "source"
              },
              {
                "path": "scripts/verify-fleet-capacity-recovery.mts",
                "repo": ".",
                "clean": true,
                "sha256": "4a431ede6616f70cc0498b046ce05d776a2872c49d81a59647040919565ddec6",
                "headBlob": "1e568ef85803553eb697f09d8ae2e12a2967feca",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/scheduler/idle-loop-recipe-pin.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "aec85625f18da273357cd9ee7321cdae3b0c35b034c75fbd0a77195f5b9065e8",
                "headBlob": "4ab699da1d8775a8670a33257d5703a2e30fff8e",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/scheduler/idle-loop-recipe-pin.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "aec85625f18da273357cd9ee7321cdae3b0c35b034c75fbd0a77195f5b9065e8",
                "headBlob": "4ab699da1d8775a8670a33257d5703a2e30fff8e",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "b0b5d23760f8065b133651c0325ec0b49620eeab",
                "repo": ".",
                "gitlink": null
              },
              {
                "head": "594cacf4fcd237efa597df1f40534f0cdd7a936e",
                "repo": "libs/papercusp",
                "gitlink": "594cacf4fcd237efa597df1f40534f0cdd7a936e"
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/agent-tools/scheduler/idle-loop-recipe-pin.test.ts"
            ],
            "sourcePaths": [
              "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
              "libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts/fleet-posture.md",
              "libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md",
              "packages/operator-core/lib/agent-tools/events/watch.ts",
              "packages/operator-core/lib/agent-tools/scheduler/get_next.ts",
              "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
              "packages/operator-core/lib/desktop-install/papercusp-files.ts",
              "packages/operator-core/lib/fleet/capacity-recovery-evidence.ts",
              "packages/operator-core/lib/harness/routines/loop.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
              "packages/operator-core/lib/llm-testing/targets/su.ts",
              "packages/operator-core/lib/llm-testing/test-run-ledger.ts",
              "scripts/verify-fleet-capacity-recovery.mts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/agent-tools/scheduler/idle-loop-recipe-pin.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-24T06:07:08.897Z",
        "bindingFingerprint": "25ef981c37245945199a1a9f223c3d4051ca9904d38b8d3ac5ef0867cf7db039",
        "createdBy": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "createdAt": "2026-10-24T06:07:08.754Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
          "current": {
            "planSlug": "luna-drain-capacity-recovery-2026-10-23",
            "specId": "LUNA-CAPACITY-004",
            "specRevision": 2,
            "specFingerprint": "f25ed6fc1f7f3685371124be89743c7f7c7dadf6d2db4dea132efc77d8c3cf9c",
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/agent-tools/scheduler/idle-loop-recipe-pin.test.ts",
            "sourceFingerprint": "sha256-file-set-v1:0ea13bffb340badd75d0cf3447cd370ec854b14c52416613bd12ed6db9518e16",
            "testFingerprint": "sha256-file-set-v1:24e40c145b71ad55360c6a623be0575e5d2c2ebf6c41fa178e87816b24e38354",
            "fixtureFingerprint": "sha256-file-set-v1:24e40c145b71ad55360c6a623be0575e5d2c2ebf6c41fa178e87816b24e38354"
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
        "id": 68528,
        "workItemId": "WI-6554700010025538",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "LUNA-CAPACITY-004",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "f25ed6fc1f7f3685371124be89743c7f7c7dadf6d2db4dea132efc77d8c3cf9c",
        "evidenceKind": "test",
        "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.test.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:0ea13bffb340badd75d0cf3447cd370ec854b14c52416613bd12ed6db9518e16",
          "testFingerprint": "sha256-file-set-v1:fba9fe3f8a52dd8317eb94a34938efbaf5f23b983881fa6ae84d636291ae0fed",
          "fixtureFingerprint": "sha256-file-set-v1:fba9fe3f8a52dd8317eb94a34938efbaf5f23b983881fa6ae84d636291ae0fed",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 21868445,
        "testRunExecution": {
          "status": "pass",
          "passed": 16,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.test.ts",
          "passedCaseTitles": [
            "Luna drain subscribe/recheck behavioral experiment calibration > allows an initial miss but requires the post-subscription recheck before idle entry"
          ],
          "testLayer": "unit",
          "passedCaseTitleCount": 16,
          "passedCaseTitlesOmitted": 15,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                21868445
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.test.ts",
          "framework": "vitest",
          "source": "local",
          "mutationPhase": null,
          "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 21868445,
            "source": "local",
            "status": "pass",
            "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.test.ts",
            "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
            "finishedAt": "2026-10-24T05:02:54.383Z",
            "asCommitted": {
              "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-339c94acbe-cx0yMN",
            "mutationPhase": null,
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "LUNA-CAPACITY-004",
            "collected": true,
            "testCases": [
              "allows an initial miss but requires the post-subscription recheck before idle entry"
            ],
            "testLayer": "unit",
            "falsifiable": true,
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "cdb059d89031bfdcd5a8f6f249aee4a883618579d333d0c46941c3b5eda16b66",
                "headBlob": "ad8bea9cf067c6c804746bae5a80460532ad8f5a",
                "dimension": "source"
              },
              {
                "path": "libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts/fleet-posture.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "72597f9cda7e159e49451249196dc3134368bed844e807781c4a412753e55170",
                "headBlob": "4ae91e731b93a1f69e7121de8004b1a8adaa9873",
                "dimension": "source"
              },
              {
                "path": "libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "6dcae35526f7dd1f29954c8da11eaf5dff8e1648232811b9e1494d0e04686496",
                "headBlob": "49d5e62fb879657718e88f4aabee5c1627a56bb7",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/events/watch.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b9a4c3aff8a14d01e94407c8760a1df8a25536743fc50eaea739fd08cdfb218a",
                "headBlob": "e7f5387a1660636732f52532961478e3be339eb4",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/scheduler/get_next.ts",
                "repo": ".",
                "clean": true,
                "sha256": "0cffc0daf039c4bc08b863a0fbc4e5ebd8c2968795a6ab4ad008eb6d63e898c6",
                "headBlob": "8cebbd738d58ae45066ada67abe5bd7c0b3180d8",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "repo": ".",
                "clean": true,
                "sha256": "bb108bbdc66b207a44155c6e3dfb6b37d85a4e3f3bffe3fdecafc6bfacb0301e",
                "headBlob": "1420766e3acf71d1e99610963df770b45faf1313",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/desktop-install/papercusp-files.ts",
                "repo": ".",
                "clean": true,
                "sha256": "ad031013ee30a357805e47c2ed16c5868f1351d2ad2e855fe3330b0ac653e06b",
                "headBlob": "c2c38da10ff912c6c634cd8073681dbe423f4f8d",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/fleet/capacity-recovery-evidence.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2507f43aab26678eac4372d35d3a4c9373b64d49cda389e4d963834fd50d8f5d",
                "headBlob": "c881fcaba3748c7ae3cd8273eeb8742732fd7e54",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/loop.ts",
                "repo": ".",
                "clean": true,
                "sha256": "612c811ac21d6ec20d2f04da2c25ae04d563aea7b496ad6db475dddfe7541a99",
                "headBlob": "ccb93fd05bbcca7edabefa810a3fe7d4e5d8831b",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b88e6705b4f415781ea81af19da1bdd25ac08d547432849612b07f9ee261713",
                "headBlob": "dc8e2644c30e62424c3cc11437007a94ea6b7949",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b08b2336b5046b985edee0914b9bff88319b32aaffd1cf62bca8e75c7e11427",
                "headBlob": "ed65fdaf7e6c7c9e300c6c3ba52769bca82084ef",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/targets/su.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9ecfb6c3139fbf4b6cd4524e51432e36d216f4283d09e4f9c338a85067ccc04d",
                "headBlob": "9591c7a33bbaef7fa95d509d6b7ee393c741fcd1",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/test-run-ledger.ts",
                "repo": ".",
                "clean": true,
                "sha256": "0189f069b512736e7e3104a957e55c2570154c4fcde754cedf6cfbd65f473795",
                "headBlob": "7bc4f6456a3f6832ad2265a91c38f190f43bcd7a",
                "dimension": "source"
              },
              {
                "path": "scripts/verify-fleet-capacity-recovery.mts",
                "repo": ".",
                "clean": true,
                "sha256": "4a431ede6616f70cc0498b046ce05d776a2872c49d81a59647040919565ddec6",
                "headBlob": "1e568ef85803553eb697f09d8ae2e12a2967feca",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b55a1a484d2d0c66311c24c77b0a8a2ac6d47b5737d4d774988d00032603010e",
                "headBlob": "771f9d4cd358a2f25d48e140114466ae3b00fadb",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b55a1a484d2d0c66311c24c77b0a8a2ac6d47b5737d4d774988d00032603010e",
                "headBlob": "771f9d4cd358a2f25d48e140114466ae3b00fadb",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "b0b5d23760f8065b133651c0325ec0b49620eeab",
                "repo": ".",
                "gitlink": null
              },
              {
                "head": "594cacf4fcd237efa597df1f40534f0cdd7a936e",
                "repo": "libs/papercusp",
                "gitlink": "594cacf4fcd237efa597df1f40534f0cdd7a936e"
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.test.ts"
            ],
            "sourcePaths": [
              "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
              "libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts/fleet-posture.md",
              "libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md",
              "packages/operator-core/lib/agent-tools/events/watch.ts",
              "packages/operator-core/lib/agent-tools/scheduler/get_next.ts",
              "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
              "packages/operator-core/lib/desktop-install/papercusp-files.ts",
              "packages/operator-core/lib/fleet/capacity-recovery-evidence.ts",
              "packages/operator-core/lib/harness/routines/loop.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
              "packages/operator-core/lib/llm-testing/targets/su.ts",
              "packages/operator-core/lib/llm-testing/test-run-ledger.ts",
              "scripts/verify-fleet-capacity-recovery.mts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-24T06:07:06.860Z",
        "bindingFingerprint": "505ab058909737a7344ece65c9de8ffedb0715a0e99388bfb7bfef7a8a391a10",
        "createdBy": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "createdAt": "2026-10-24T06:07:06.390Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
          "current": {
            "planSlug": "luna-drain-capacity-recovery-2026-10-23",
            "specId": "LUNA-CAPACITY-004",
            "specRevision": 2,
            "specFingerprint": "f25ed6fc1f7f3685371124be89743c7f7c7dadf6d2db4dea132efc77d8c3cf9c",
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.test.ts",
            "sourceFingerprint": "sha256-file-set-v1:0ea13bffb340badd75d0cf3447cd370ec854b14c52416613bd12ed6db9518e16",
            "testFingerprint": "sha256-file-set-v1:fba9fe3f8a52dd8317eb94a34938efbaf5f23b983881fa6ae84d636291ae0fed",
            "fixtureFingerprint": "sha256-file-set-v1:fba9fe3f8a52dd8317eb94a34938efbaf5f23b983881fa6ae84d636291ae0fed"
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
        "id": 68527,
        "workItemId": "WI-6554700010025538",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "LUNA-CAPACITY-004",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "f25ed6fc1f7f3685371124be89743c7f7c7dadf6d2db4dea132efc77d8c3cf9c",
        "evidenceKind": "test",
        "evidenceRef": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:0ea13bffb340badd75d0cf3447cd370ec854b14c52416613bd12ed6db9518e16",
          "testFingerprint": "sha256-file-set-v1:6ae25d06990957a511426346d45157a8a9a9288cb46f3bc76e11c87059c474ce",
          "fixtureFingerprint": "sha256-file-set-v1:6ae25d06990957a511426346d45157a8a9a9288cb46f3bc76e11c87059c474ce",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 21868444,
        "testRunExecution": {
          "status": "pass",
          "passed": 42,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
          "passedCaseTitles": [
            "WI-10005697: standing pattern watch dedupe > the drained-lane contract is IDEMPOTENT: the identical standing watch twice yields ONE row + a deduped marker"
          ],
          "testLayer": "unit",
          "passedCaseTitleCount": 42,
          "passedCaseTitlesOmitted": 41,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                21868444
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
          "framework": "vitest",
          "source": "local",
          "mutationPhase": null,
          "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 21868444,
            "source": "local",
            "status": "pass",
            "filePath": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
            "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
            "finishedAt": "2026-10-24T05:02:46.593Z",
            "asCommitted": {
              "commitSha": "339c94acbed6503c2d223cf15fe2bcece2b5b9de",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-339c94acbe-cx0yMN",
            "mutationPhase": null,
            "worktreeDirty": false,
            "recordedFilePath": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "LUNA-CAPACITY-004",
            "collected": true,
            "testCases": [
              "the drained-lane contract is IDEMPOTENT: the identical standing watch twice yields ONE row + a deduped marker"
            ],
            "testLayer": "unit",
            "falsifiable": true,
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "cdb059d89031bfdcd5a8f6f249aee4a883618579d333d0c46941c3b5eda16b66",
                "headBlob": "ad8bea9cf067c6c804746bae5a80460532ad8f5a",
                "dimension": "source"
              },
              {
                "path": "libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts/fleet-posture.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "72597f9cda7e159e49451249196dc3134368bed844e807781c4a412753e55170",
                "headBlob": "4ae91e731b93a1f69e7121de8004b1a8adaa9873",
                "dimension": "source"
              },
              {
                "path": "libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md",
                "repo": "libs/papercusp",
                "clean": true,
                "sha256": "6dcae35526f7dd1f29954c8da11eaf5dff8e1648232811b9e1494d0e04686496",
                "headBlob": "49d5e62fb879657718e88f4aabee5c1627a56bb7",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/events/watch.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b9a4c3aff8a14d01e94407c8760a1df8a25536743fc50eaea739fd08cdfb218a",
                "headBlob": "e7f5387a1660636732f52532961478e3be339eb4",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/scheduler/get_next.ts",
                "repo": ".",
                "clean": true,
                "sha256": "0cffc0daf039c4bc08b863a0fbc4e5ebd8c2968795a6ab4ad008eb6d63e898c6",
                "headBlob": "8cebbd738d58ae45066ada67abe5bd7c0b3180d8",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
                "repo": ".",
                "clean": true,
                "sha256": "bb108bbdc66b207a44155c6e3dfb6b37d85a4e3f3bffe3fdecafc6bfacb0301e",
                "headBlob": "1420766e3acf71d1e99610963df770b45faf1313",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/desktop-install/papercusp-files.ts",
                "repo": ".",
                "clean": true,
                "sha256": "ad031013ee30a357805e47c2ed16c5868f1351d2ad2e855fe3330b0ac653e06b",
                "headBlob": "c2c38da10ff912c6c634cd8073681dbe423f4f8d",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/fleet/capacity-recovery-evidence.ts",
                "repo": ".",
                "clean": true,
                "sha256": "2507f43aab26678eac4372d35d3a4c9373b64d49cda389e4d963834fd50d8f5d",
                "headBlob": "c881fcaba3748c7ae3cd8273eeb8742732fd7e54",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/harness/routines/loop.ts",
                "repo": ".",
                "clean": true,
                "sha256": "612c811ac21d6ec20d2f04da2c25ae04d563aea7b496ad6db475dddfe7541a99",
                "headBlob": "ccb93fd05bbcca7edabefa810a3fe7d4e5d8831b",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b88e6705b4f415781ea81af19da1bdd25ac08d547432849612b07f9ee261713",
                "headBlob": "dc8e2644c30e62424c3cc11437007a94ea6b7949",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
                "repo": ".",
                "clean": true,
                "sha256": "8b08b2336b5046b985edee0914b9bff88319b32aaffd1cf62bca8e75c7e11427",
                "headBlob": "ed65fdaf7e6c7c9e300c6c3ba52769bca82084ef",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/targets/su.ts",
                "repo": ".",
                "clean": true,
                "sha256": "9ecfb6c3139fbf4b6cd4524e51432e36d216f4283d09e4f9c338a85067ccc04d",
                "headBlob": "9591c7a33bbaef7fa95d509d6b7ee393c741fcd1",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/llm-testing/test-run-ledger.ts",
                "repo": ".",
                "clean": true,
                "sha256": "0189f069b512736e7e3104a957e55c2570154c4fcde754cedf6cfbd65f473795",
                "headBlob": "7bc4f6456a3f6832ad2265a91c38f190f43bcd7a",
                "dimension": "source"
              },
              {
                "path": "scripts/verify-fleet-capacity-recovery.mts",
                "repo": ".",
                "clean": true,
                "sha256": "4a431ede6616f70cc0498b046ce05d776a2872c49d81a59647040919565ddec6",
                "headBlob": "1e568ef85803553eb697f09d8ae2e12a2967feca",
                "dimension": "source"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b4aa0e9fc9b936e7b4b1bc3d0030dc1e62badc6854548cf3e147d280fee79bc8",
                "headBlob": "5fe8ce8e5c31601f7b2df53d2ba2519897ae72d4",
                "dimension": "test"
              },
              {
                "path": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "b4aa0e9fc9b936e7b4b1bc3d0030dc1e62badc6854548cf3e147d280fee79bc8",
                "headBlob": "5fe8ce8e5c31601f7b2df53d2ba2519897ae72d4",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "b0b5d23760f8065b133651c0325ec0b49620eeab",
                "repo": ".",
                "gitlink": null
              },
              {
                "head": "594cacf4fcd237efa597df1f40534f0cdd7a936e",
                "repo": "libs/papercusp",
                "gitlink": "594cacf4fcd237efa597df1f40534f0cdd7a936e"
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "packages/operator-core/lib/agent-tools/events/watch.test.ts"
            ],
            "sourcePaths": [
              "libs/papercusp/packages/harness/blueprints/base/prompts/su.md",
              "libs/papercusp/packages/harness/blueprints/su.fleet-member/prompts/fleet-posture.md",
              "libs/papercusp/packages/harness/blueprints/su.mode-auto/prompts/autonomy.md",
              "packages/operator-core/lib/agent-tools/events/watch.ts",
              "packages/operator-core/lib/agent-tools/scheduler/get_next.ts",
              "packages/operator-core/lib/agent-tools/tools/invoke-args.ts",
              "packages/operator-core/lib/desktop-install/papercusp-files.ts",
              "packages/operator-core/lib/fleet/capacity-recovery-evidence.ts",
              "packages/operator-core/lib/harness/routines/loop.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
              "packages/operator-core/lib/llm-testing/scenarios/su/_asserts.ts",
              "packages/operator-core/lib/llm-testing/targets/su.ts",
              "packages/operator-core/lib/llm-testing/test-run-ledger.ts",
              "scripts/verify-fleet-capacity-recovery.mts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/agent-tools/events/watch.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-24T06:07:03.481Z",
        "bindingFingerprint": "709be75c53743ea1df611897b4f54582964bb688426b953414007de5cfc26514",
        "createdBy": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "createdAt": "2026-10-24T06:07:03.138Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
          "current": {
            "planSlug": "luna-drain-capacity-recovery-2026-10-23",
            "specId": "LUNA-CAPACITY-004",
            "specRevision": 2,
            "specFingerprint": "f25ed6fc1f7f3685371124be89743c7f7c7dadf6d2db4dea132efc77d8c3cf9c",
            "evidenceKind": "test",
            "evidenceRef": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
            "sourceFingerprint": "sha256-file-set-v1:0ea13bffb340badd75d0cf3447cd370ec854b14c52416613bd12ed6db9518e16",
            "testFingerprint": "sha256-file-set-v1:6ae25d06990957a511426346d45157a8a9a9288cb46f3bc76e11c87059c474ce",
            "fixtureFingerprint": "sha256-file-set-v1:6ae25d06990957a511426346d45157a8a9a9288cb46f3bc76e11c87059c474ce"
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
    "count": 24,
    "currentness": {
      "current": 24,
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
  "adequacy": {
    "ok": true,
    "evaluatorBuild": {
      "sha": "b0b5d23760",
      "version": "0.0.0"
    },
    "slug": "luna-drain-capacity-recovery-2026-10-23",
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
    "detail": "summary",
    "rows": [
      {
        "evaluationMode": "mechanical",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "AUTO-BAR-R-1-P-001",
        "specRevision": 3,
        "specFingerprint": "a0295a1fc541565bafcf9bd3deb01485ee86bffad1faeb4bffbf599e478af022",
        "planItemId": "P-001",
        "verdict": "pass",
        "wouldBlock": [],
        "mechanicalProof": {
          "applicable": true,
          "verdict": "pass",
          "requiredFiles": [
            "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
            "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts"
          ],
          "passingTestBindingIds": {
            "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts": 68548,
            "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts": 68547
          },
          "caughtMutantBindingIds": [
            68555
          ],
          "gaps": []
        },
        "measurementEvidence": {
          "status": "measured",
          "selectedBindings": 3,
          "measuredBindings": 3,
          "unavailableBindings": [],
          "withoutMeasurementBasis": [],
          "bindings": [
            {
              "bindingId": 68547,
              "evidenceKind": "test",
              "evidenceRef": "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
              "status": "measured",
              "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
              "measurementFingerprint": "sha256:6f6862754779f1c4dacb77a514cbf72d0b67c202fe9f8d19feaa838e2b033462"
            },
            {
              "bindingId": 68548,
              "evidenceKind": "test",
              "evidenceRef": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
              "status": "measured",
              "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
              "measurementFingerprint": "sha256:e7083af75ea13aea428bae2fc8b600872ce00dad1ae4f764bc4040b2785d8450"
            },
            {
              "bindingId": 68555,
              "evidenceKind": "mutation",
              "evidenceRef": "test-run 21869849 mutation-probe mutant fail packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts @339c94acbed6",
              "status": "measured",
              "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
              "measurementFingerprint": "sha256:e7083af75ea13aea428bae2fc8b600872ce00dad1ae4f764bc4040b2785d8450"
            }
          ]
        }
      },
      {
        "evaluationMode": "mechanical",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "AUTO-BAR-R-3-P-003",
        "specRevision": 2,
        "specFingerprint": "6734dc1ca3433cfda849ea3bc8a41034f7428dbb9d76c63fc8be8d4be677ff3a",
        "planItemId": "P-003",
        "verdict": "pass",
        "wouldBlock": [],
        "mechanicalProof": {
          "applicable": true,
          "verdict": "pass",
          "requiredFiles": [
            "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts"
          ],
          "passingTestBindingIds": {
            "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts": 68550
          },
          "caughtMutantBindingIds": [
            68557
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
              "bindingId": 68550,
              "evidenceKind": "test",
              "evidenceRef": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
              "status": "measured",
              "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
              "measurementFingerprint": "sha256:25af8f2e46fb24c742092d1a99a1c14c954ec67dff010d774180fdde3fc25ae1"
            },
            {
              "bindingId": 68557,
              "evidenceKind": "mutation",
              "evidenceRef": "test-run 21869861 mutation-probe mutant fail packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts @339c94acbed6",
              "status": "measured",
              "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
              "measurementFingerprint": "sha256:25af8f2e46fb24c742092d1a99a1c14c954ec67dff010d774180fdde3fc25ae1"
            }
          ]
        }
      },
      {
        "evaluationMode": "judgment",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "AUTO-BAR-R-4-P-004",
        "specRevision": 4,
        "specFingerprint": "5282833d6544e041b8b06ea2be5d7fd2627873b1badc9679abe352b57c76ba9f",
        "planItemId": "P-004",
        "verdict": "unknown",
        "requiredProofFloor": "l4",
        "wouldBlock": [
          "falsifiability",
          "plan-class-risk-floor"
        ],
        "measurementEvidence": {
          "status": "measured",
          "selectedBindings": 5,
          "measuredBindings": 5,
          "unavailableBindings": [],
          "withoutMeasurementBasis": [],
          "bindings": [
            {
              "bindingId": 68533,
              "evidenceKind": "test",
              "evidenceRef": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
              "status": "measured",
              "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
              "measurementFingerprint": "sha256:e9927699bd790c9207aaf4d3e2a5335eb386f87d91edfcaaed95be60cdbaee0a"
            },
            {
              "bindingId": 68534,
              "evidenceKind": "test",
              "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.test.ts",
              "status": "measured",
              "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
              "measurementFingerprint": "sha256:bc10cfdd513c88eb2efef42a4c40262b4e6e9aff8770e45080d09ad615bb65f2"
            },
            {
              "bindingId": 68535,
              "evidenceKind": "test",
              "evidenceRef": "packages/operator-core/lib/agent-tools/scheduler/idle-loop-recipe-pin.test.ts",
              "status": "measured",
              "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
              "measurementFingerprint": "sha256:f2e87e56b79261806566c1af7652cddbb199cbfb2ef08fe486be5304423cbdff"
            },
            {
              "bindingId": 68538,
              "evidenceKind": "test",
              "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
              "status": "measured",
              "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
              "measurementFingerprint": "sha256:68d309feaff2d81f0e542a8f352083fdfb82fa0850efdb991677361b0a3e18b2"
            },
            {
              "bindingId": 68559,
              "evidenceKind": "mutation",
              "evidenceRef": "test-run 21869857 mutation-probe mutant fail packages/operator-core/lib/agent-tools/events/watch.test.ts @339c94acbed6",
              "status": "measured",
              "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
              "measurementFingerprint": "sha256:e9927699bd790c9207aaf4d3e2a5335eb386f87d91edfcaaed95be60cdbaee0a"
            }
          ]
        },
        "ratings": {
          "traceability": {
            "rating": "pass"
          },
          "fixture-calibration": {
            "rating": "pass"
          },
          "falsifiability": {
            "rating": "unknown",
            "evidence": "Successful mutation or counterexample binding(s) do not establish clause-scoped falsifiability for luna-drain-capacity-recovery-2026-10-23/AUTO-BAR-R-4-P-004@4 (5282833d6544e041b8b06ea2be5d7fd2627873b1badc9679abe352b57c76ba9f); 1 successful mutation or counterexample binding(s) name luna-drain-capacity-recovery-2026-10-23/AUTO-BAR-R-4-P-004@4 (5282833d6544e041b8b06ea2be5d7fd2627873b1badc9679abe352b57c76ba9f), but the measured failed case is missing from a successful current same-clause adequacy.testCases binding or its passing baseline. Measured failing case line(s), reporter format \"<case full name>: <message>\" — declare the part before \": \" exactly: \"WI-10005697: standing pattern watch dedupe > the drained-lane contract is IDEMPOTENT: the identical standing watch twice yields ONE row + a deduped marker: (recorded failed assertion)\". Bound evidence: id=68559, kind=mutation, ref=\"test-run 21869857 mutation-probe mutant fail packages/operator-core/lib/agent-tools/events/watch.test.ts @339c94acbed6\", lineage=durable, lineageReason=\"durable testRunId\", currentness=current, currentnessProvenance=server-measured, sourceFingerprint=\"sha256-file-set-v1…",
            "evidenceTruncated": true,
            "suggestion": "Add the exact measured failed case title from the mutation run to adequacy.testCases on the successful current same-clause test binding; missing or mismatched case identity cannot establish falsifiability. Ledger row required: testing:run { files, harness, evidence } records and binds a testRunId; scripts/mutation-probe.sh with PAPERCUSP_TEST_RUN_HARNESS set records source=mutation-probe rows (listed only by testing:runs { source:'mutation-probe' })."
          },
          "correct-layer": {
            "rating": "pass"
          },
          "oracle-independence": {
            "rating": "pass"
          },
          "execution-integrity": {
            "rating": "pass"
          },
          "freshness": {
            "rating": "pass"
          },
          "plan-class-risk-floor": {
            "rating": "unknown",
            "evidence": "No targeted L4 coverage/mutation/counterexample result or current approved waiver is bound for luna-drain-capacity-recovery-2026-10-23/AUTO-BAR-R-4-P-004@4 (5282833d6544e041b8b06ea2be5d7fd2627873b1badc9679abe352b57c76ba9f). Bound evidence: id=68559, kind=mutation, ref=\"test-run 21869857 mutation-probe mutant fail packages/operator-core/lib/agent-tools/events/watch.test.ts @339c94acbed6\", lineage=durable, lineageReason=\"durable testRunId\", currentness=current, currentnessProvenance=server-measured, sourceFingerprint=\"sha256-file-set-v1…",
            "evidenceTruncated": true,
            "suggestion": "Bind targeted L4 proof or record a justified approvalRef-bearing waiver on the spec revision."
          },
          "disclosed-gap": {
            "rating": "not-applicable"
          }
        }
      },
      {
        "evaluationMode": "judgment",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "LUNA-CAPACITY-001",
        "specRevision": 2,
        "specFingerprint": "c0da5d3844f764e2740a41f21c1e475df6c390d9abc1327fb214002eb0f3a744",
        "planItemId": "P-001",
        "verdict": "unknown",
        "requiredProofFloor": "l4",
        "wouldBlock": [
          "falsifiability",
          "plan-class-risk-floor"
        ],
        "measurementEvidence": {
          "status": "measured",
          "selectedBindings": 3,
          "measuredBindings": 3,
          "unavailableBindings": [],
          "withoutMeasurementBasis": [],
          "bindings": [
            {
              "bindingId": 68545,
              "evidenceKind": "test",
              "evidenceRef": "packages/operator-core/lib/scheduler/claim-spec-store.integration.test.ts",
              "status": "measured",
              "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
              "measurementFingerprint": "sha256:6f6862754779f1c4dacb77a514cbf72d0b67c202fe9f8d19feaa838e2b033462"
            },
            {
              "bindingId": 68546,
              "evidenceKind": "test",
              "evidenceRef": "packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts",
              "status": "measured",
              "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
              "measurementFingerprint": "sha256:e7083af75ea13aea428bae2fc8b600872ce00dad1ae4f764bc4040b2785d8450"
            },
            {
              "bindingId": 68554,
              "evidenceKind": "mutation",
              "evidenceRef": "test-run 21869849 mutation-probe mutant fail packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts @339c94acbed6",
              "status": "measured",
              "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
              "measurementFingerprint": "sha256:e7083af75ea13aea428bae2fc8b600872ce00dad1ae4f764bc4040b2785d8450"
            }
          ]
        },
        "ratings": {
          "traceability": {
            "rating": "pass"
          },
          "fixture-calibration": {
            "rating": "pass"
          },
          "falsifiability": {
            "rating": "unknown",
            "evidence": "Successful mutation or counterexample binding(s) do not establish clause-scoped falsifiability for luna-drain-capacity-recovery-2026-10-23/LUNA-CAPACITY-001@2 (c0da5d3844f764e2740a41f21c1e475df6c390d9abc1327fb214002eb0f3a744); 1 successful mutation or counterexample binding(s) name luna-drain-capacity-recovery-2026-10-23/LUNA-CAPACITY-001@2 (c0da5d3844f764e2740a41f21c1e475df6c390d9abc1327fb214002eb0f3a744), but the measured fai …[middle omitted]… or its passing baseline. Measured failing case line(s), reporter format \"<case full name>: <message>\" — declare the part before \": \" exactly: \"isParkedOnExternalBlocker — P-010 (plan D-010) > calibration: the real predicate passes every case: (recorded failed assertion)\", \"isParkedOnExternalBlocker — P-010 (plan D-010) > frees the slot for a blocked or needs-human hold with an active typed blocker: (recorded failed assertion)\". Bound evidence: id=68554, kind=mutation, ref=\"test-run 21869849 mutation-probe mutant fail packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts @339c94acbed6\", lineage=durable, lineageReason=\"durable testRunId\", currentness=current, currentnessProvenance=server-measured, sourceFingerprint=\"sha256-f…",
            "evidenceTruncated": true,
            "suggestion": "Add the exact measured failed case title from the mutation run to adequacy.testCases on the successful current same-clause test binding; missing or mismatched case identity cannot establish falsifiability. Ledger row required: testing:run { files, harness, evidence } records and binds a testRunId; scripts/mutation-probe.sh with PAPERCUSP_TEST_RUN_HARNESS set records source=mutation-probe rows (listed only by testing:runs { source:'mutation-probe' })."
          },
          "correct-layer": {
            "rating": "pass"
          },
          "oracle-independence": {
            "rating": "pass"
          },
          "execution-integrity": {
            "rating": "pass"
          },
          "freshness": {
            "rating": "pass"
          },
          "plan-class-risk-floor": {
            "rating": "unknown",
            "evidence": "No targeted L4 coverage/mutation/counterexample result or current approved waiver is bound for luna-drain-capacity-recovery-2026-10-23/LUNA-CAPACITY-001@2 (c0da5d3844f764e2740a41f21c1e475df6c390d9abc1327fb214002eb0f3a744). Bound evidence: id=68554, kind=mutation, ref=\"test-run 21869849 mutation-probe mutant fail packages/operator-core/lib/scheduler/claim-concurrency-oracle.test.ts @339c94acbed6\", lineage=durable, lineageReason=\"durable testRunId\", currentness=current, currentnessProvenance=server-measured, sourceFingerprint=\"sha256-f…",
            "evidenceTruncated": true,
            "suggestion": "Bind targeted L4 proof or record a justified approvalRef-bearing waiver on the spec revision."
          },
          "disclosed-gap": {
            "rating": "not-applicable"
          }
        }
      },
      {
        "evaluationMode": "judgment",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "LUNA-CAPACITY-003",
        "specRevision": 2,
        "specFingerprint": "a68b685e6f4d51241eab4d9494c8533ca0d80d696bd37c7fc545cbee83ee4235",
        "planItemId": "P-003",
        "verdict": "unknown",
        "requiredProofFloor": "l4",
        "wouldBlock": [
          "falsifiability",
          "plan-class-risk-floor"
        ],
        "measurementEvidence": {
          "status": "measured",
          "selectedBindings": 2,
          "measuredBindings": 2,
          "unavailableBindings": [],
          "withoutMeasurementBasis": [],
          "bindings": [
            {
              "bindingId": 68549,
              "evidenceKind": "test",
              "evidenceRef": "packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts",
              "status": "measured",
              "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
              "measurementFingerprint": "sha256:25af8f2e46fb24c742092d1a99a1c14c954ec67dff010d774180fdde3fc25ae1"
            },
            {
              "bindingId": 68556,
              "evidenceKind": "mutation",
              "evidenceRef": "test-run 21869861 mutation-probe mutant fail packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts @339c94acbed6",
              "status": "measured",
              "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
              "measurementFingerprint": "sha256:25af8f2e46fb24c742092d1a99a1c14c954ec67dff010d774180fdde3fc25ae1"
            }
          ]
        },
        "ratings": {
          "traceability": {
            "rating": "pass"
          },
          "fixture-calibration": {
            "rating": "pass"
          },
          "falsifiability": {
            "rating": "unknown",
            "evidence": "Successful mutation or counterexample binding(s) do not establish clause-scoped falsifiability for luna-drain-capacity-recovery-2026-10-23/LUNA-CAPACITY-003@2 (a68b685e6f4d51241eab4d9494c8533ca0d80d696bd37c7fc545cbee83ee4235); 1 successful mutation or counterexample binding(s) name luna-drain-capacity-recovery-2026-10-23/LUNA-CAPACITY-003@2 (a68b685e6f4d51241eab4d9494c8533ca0d80d696bd37c7fc545cbee83ee4235), but the measured failed case is missing from a successful current same-clause adequacy.testCases binding or its passing baseline. Measured failing case line(s), reporter format \"<case full name>: <message>\" — declare the part before \": \" exactly: \"fleet:leader-brief bounded read fan-out (EI-21577690778811728) > gives required lane health the existing diagnostic budget and keeps a typed recovery fallback: (recorded failed assertion)\". Bound evidence: id=68556, kind=mutation, ref=\"test-run 21869861 mutation-probe mutant fail packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts @339c94acbed6\", lineage=durable, lineageReason=\"durable testRunId\", currentness=current, currentnessProvenance=server-measured, sourceFingerprint=\"sha256-file-…",
            "evidenceTruncated": true,
            "suggestion": "Add the exact measured failed case title from the mutation run to adequacy.testCases on the successful current same-clause test binding; missing or mismatched case identity cannot establish falsifiability. Ledger row required: testing:run { files, harness, evidence } records and binds a testRunId; scripts/mutation-probe.sh with PAPERCUSP_TEST_RUN_HARNESS set records source=mutation-probe rows (listed only by testing:runs { source:'mutation-probe' })."
          },
          "correct-layer": {
            "rating": "pass"
          },
          "oracle-independence": {
            "rating": "pass"
          },
          "execution-integrity": {
            "rating": "pass"
          },
          "freshness": {
            "rating": "pass"
          },
          "plan-class-risk-floor": {
            "rating": "unknown",
            "evidence": "No targeted L4 coverage/mutation/counterexample result or current approved waiver is bound for luna-drain-capacity-recovery-2026-10-23/LUNA-CAPACITY-003@2 (a68b685e6f4d51241eab4d9494c8533ca0d80d696bd37c7fc545cbee83ee4235). Bound evidence: id=68556, kind=mutation, ref=\"test-run 21869861 mutation-probe mutant fail packages/operator-core/lib/agent-tools/fleet/leader-brief.test.ts @339c94acbed6\", lineage=durable, lineageReason=\"durable testRunId\", currentness=current, currentnessProvenance=server-measured, sourceFingerprint=\"sha256-file-…",
            "evidenceTruncated": true,
            "suggestion": "Bind targeted L4 proof or record a justified approvalRef-bearing waiver on the spec revision."
          },
          "disclosed-gap": {
            "rating": "not-applicable"
          }
        }
      },
      {
        "evaluationMode": "judgment",
        "planSlug": "luna-drain-capacity-recovery-2026-10-23",
        "specId": "LUNA-CAPACITY-004",
        "specRevision": 2,
        "specFingerprint": "f25ed6fc1f7f3685371124be89743c7f7c7dadf6d2db4dea132efc77d8c3cf9c",
        "planItemId": "P-004",
        "verdict": "unknown",
        "requiredProofFloor": "l4",
        "wouldBlock": [
          "falsifiability",
          "plan-class-risk-floor"
        ],
        "measurementEvidence": {
          "status": "measured",
          "selectedBindings": 5,
          "measuredBindings": 5,
          "unavailableBindings": [],
          "withoutMeasurementBasis": [],
          "bindings": [
            {
              "bindingId": 68527,
              "evidenceKind": "test",
              "evidenceRef": "packages/operator-core/lib/agent-tools/events/watch.test.ts",
              "status": "measured",
              "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
              "measurementFingerprint": "sha256:e9927699bd790c9207aaf4d3e2a5335eb386f87d91edfcaaed95be60cdbaee0a"
            },
            {
              "bindingId": 68528,
              "evidenceKind": "test",
              "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.test.ts",
              "status": "measured",
              "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
              "measurementFingerprint": "sha256:bc10cfdd513c88eb2efef42a4c40262b4e6e9aff8770e45080d09ad615bb65f2"
            },
            {
              "bindingId": 68529,
              "evidenceKind": "test",
              "evidenceRef": "packages/operator-core/lib/agent-tools/scheduler/idle-loop-recipe-pin.test.ts",
              "status": "measured",
              "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
              "measurementFingerprint": "sha256:f2e87e56b79261806566c1af7652cddbb199cbfb2ef08fe486be5304423cbdff"
            },
            {
              "bindingId": 68532,
              "evidenceKind": "test",
              "evidenceRef": "packages/operator-core/lib/llm-testing/scenarios/su/S42-drain-watch-recheck.ts",
              "status": "measured",
              "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
              "measurementFingerprint": "sha256:68d309feaff2d81f0e542a8f352083fdfb82fa0850efdb991677361b0a3e18b2"
            },
            {
              "bindingId": 68558,
              "evidenceKind": "mutation",
              "evidenceRef": "test-run 21869857 mutation-probe mutant fail packages/operator-core/lib/agent-tools/events/watch.test.ts @339c94acbed6",
              "status": "measured",
              "measuredAtCommit": "9528780dad78fc4e7b7e1ac63ca789ad55b53993",
              "measurementFingerprint": "sha256:e9927699bd790c9207aaf4d3e2a5335eb386f87d91edfcaaed95be60cdbaee0a"
            }
          ]
        },
        "ratings": {
          "traceability": {
            "rating": "pass"
          },
          "fixture-calibration": {
            "rating": "pass"
          },
          "falsifiability": {
            "rating": "unknown",
            "evidence": "Successful mutation or counterexample binding(s) do not establish clause-scoped falsifiability for luna-drain-capacity-recovery-2026-10-23/LUNA-CAPACITY-004@2 (f25ed6fc1f7f3685371124be89743c7f7c7dadf6d2db4dea132efc77d8c3cf9c); 1 successful mutation or counterexample binding(s) name luna-drain-capacity-recovery-2026-10-23/LUNA-CAPACITY-004@2 (f25ed6fc1f7f3685371124be89743c7f7c7dadf6d2db4dea132efc77d8c3cf9c), but the measured failed case is missing from a successful current same-clause adequacy.testCases binding or its passing baseline. Measured failing case line(s), reporter format \"<case full name>: <message>\" — declare the part before \": \" exactly: \"WI-10005697: standing pattern watch dedupe > the drained-lane contract is IDEMPOTENT: the identical standing watch twice yields ONE row + a deduped marker: (recorded failed assertion)\". Bound evidence: id=68558, kind=mutation, ref=\"test-run 21869857 mutation-probe mutant fail packages/operator-core/lib/agent-tools/events/watch.test.ts @339c94acbed6\", lineage=durable, lineageReason=\"durable testRunId\", currentness=current, currentnessProvenance=server-measured, sourceFingerprint=\"sha256-file-set-v1…",
            "evidenceTruncated": true,
            "suggestion": "Add the exact measured failed case title from the mutation run to adequacy.testCases on the successful current same-clause test binding; missing or mismatched case identity cannot establish falsifiability. Ledger row required: testing:run { files, harness, evidence } records and binds a testRunId; scripts/mutation-probe.sh with PAPERCUSP_TEST_RUN_HARNESS set records source=mutation-probe rows (listed only by testing:runs { source:'mutation-probe' })."
          },
          "correct-layer": {
            "rating": "pass"
          },
          "oracle-independence": {
            "rating": "pass"
          },
          "execution-integrity": {
            "rating": "pass"
          },
          "freshness": {
            "rating": "pass"
          },
          "plan-class-risk-floor": {
            "rating": "unknown",
            "evidence": "No targeted L4 coverage/mutation/counterexample result or current approved waiver is bound for luna-drain-capacity-recovery-2026-10-23/LUNA-CAPACITY-004@2 (f25ed6fc1f7f3685371124be89743c7f7c7dadf6d2db4dea132efc77d8c3cf9c). Bound evidence: id=68558, kind=mutation, ref=\"test-run 21869857 mutation-probe mutant fail packages/operator-core/lib/agent-tools/events/watch.test.ts @339c94acbed6\", lineage=durable, lineageReason=\"durable testRunId\", currentness=current, currentnessProvenance=server-measured, sourceFingerprint=\"sha256-file-set-v1…",
            "evidenceTruncated": true,
            "suggestion": "Bind targeted L4 proof or record a justified approvalRef-bearing waiver on the spec revision."
          },
          "disclosed-gap": {
            "rating": "not-applicable"
          }
        }
      }
    ],
    "nonPassingDetail": {
      "tool": "plans:evaluate-spec-test-adequacy",
      "args": {
        "harness": "papercusp",
        "slug": "luna-drain-capacity-recovery-2026-10-23",
        "bindingIds": [
          68545,
          68546,
          68547,
          68548,
          68549,
          68550,
          68527,
          68528,
          68529,
          68530,
          68531,
          68532,
          68533,
          68534,
          68535,
          68536,
          68537,
          68538,
          68554,
          68555,
          68556,
          68557,
          68558,
          68559
        ],
        "specIds": [
          "LUNA-CAPACITY-001",
          "AUTO-BAR-R-1-P-001",
          "LUNA-CAPACITY-003",
          "AUTO-BAR-R-3-P-003",
          "LUNA-CAPACITY-004",
          "AUTO-BAR-R-4-P-004"
        ],
        "criteria": [
          "falsifiability",
          "plan-class-risk-floor"
        ],
        "detail": "full"
      },
      "omitted": [
        "rows[].scorecardDraft",
        "rows[].ratings of passing criteria"
      ]
    },
    "fullBody": {
      "tool": "plans:evaluate-spec-test-adequacy",
      "args": {
        "harness": "papercusp",
        "slug": "luna-drain-capacity-recovery-2026-10-23",
        "bindingIds": [
          68545,
          68546,
          68547,
          68548,
          68549,
          68550,
          68527,
          68528,
          68529,
          68530,
          68531,
          68532,
          68533,
          68534,
          68535,
          68536,
          68537,
          68538,
          68554,
          68555,
          68556,
          68557,
          68558,
          68559
        ],
        "specIds": [
          "LUNA-CAPACITY-001",
          "AUTO-BAR-R-1-P-001",
          "LUNA-CAPACITY-003",
          "AUTO-BAR-R-3-P-003",
          "LUNA-CAPACITY-004",
          "AUTO-BAR-R-4-P-004"
        ],
        "detail": "full"
      },
      "omitted": [
        "rows[].ratings[].evidence",
        "rows[].evidenceRefs",
        "rows[].scorecardDraft"
      ]
    },
    "count": 6,
    "verdicts": {
      "pass": 2,
      "fail": 0,
      "unknown": 4
    },
    "wouldBlock": [
      {
        "specId": "AUTO-BAR-R-4-P-004",
        "revision": 4,
        "criteria": [
          "falsifiability",
          "plan-class-risk-floor"
        ]
      },
      {
        "specId": "LUNA-CAPACITY-001",
        "revision": 2,
        "criteria": [
          "falsifiability",
          "plan-class-risk-floor"
        ]
      },
      {
        "specId": "LUNA-CAPACITY-003",
        "revision": 2,
        "criteria": [
          "falsifiability",
          "plan-class-risk-floor"
        ]
      },
      {
        "specId": "LUNA-CAPACITY-004",
        "revision": 2,
        "criteria": [
          "falsifiability",
          "plan-class-risk-floor"
        ]
      }
    ],
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
  "notes": [
    "R2/runtime/R5/R6/final acceptance/shipment remain pending.",
    "Original test matrices were reused; new mutation probes fill absent or stale red-capability evidence.",
    "No source changes, BG lifecycle or live release gate operations."
  ]
}
