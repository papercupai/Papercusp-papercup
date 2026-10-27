---
rel_path: "evidence/identity-assume/recovery75/unit-bindings-currentness.json"
updated_at: 1792982618662
_body: "content"
---

{
  "ok": true,
  "slug": "agent-assume-identity-2026-10-23",
  "harnessSlug": "papercusp",
  "bounded": {
    "limit": 200,
    "truncatedByLimit": false
  },
  "detail": "full",
  "evidence": [
    {
      "id": 70890,
      "workItemId": "WI-6554700010025439",
      "planSlug": "agent-assume-identity-2026-10-23",
      "specId": "AUTO-BAR-R-10-P-001",
      "sourceValId": null,
      "specRevision": 3,
      "currentRevision": 3,
      "specFingerprint": "f431714147c75b93d6b47d884945d075da9dd4626675a98e1910835a5b795a5f",
      "evidenceKind": "mutation",
      "evidenceRef": "test-run 22098840 mutation-probe mutant fail packages/operator-core/lib/agent-tools/session/assume.test.ts @3334d25de11c",
      "fingerprints": {
        "sourceFingerprint": "sha256-file-set-v1:a73e077cfeac4afed974d760804d68bd066bb6088452bda961fee2970d621184",
        "testFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd",
        "fixtureFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd",
        "rubricFingerprint": null,
        "environmentFingerprint": null
      },
      "coverageEvidenceRef": null,
      "testRunId": 22098840,
      "testRunExecution": {
        "status": "fail",
        "passed": 0,
        "failed": 1,
        "skipped": 67,
        "collectionFailed": false,
        "testNamePattern": "R-10 tampered mismatched or non-target checkpoint refuses before custody",
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
        "testLayer": "unit"
      },
      "testRunProvenance": {
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
        "framework": "vitest",
        "source": "mutation-probe",
        "mutationPhase": "mutant",
        "mutation": {
          "leg": "mutant",
          "mode": "copy-out",
          "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -184,7 +184,7 @@\n   if (!target.success) return refuse('target-changed');\n   const rejection = targetRefusal(actor, request, target.data);\n   if (rejection) return rejection;\n-  if (JSON.stringify(target.data) !== JSON.stringify(plan.target)) return refuse('target-changed');\n+  if (false) return refuse('target-changed');\n   return { ok: true, preparation: plan };\n }\n \n",
          "subjectPath": "packages/operator-core/lib/session-assume.ts",
          "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-10 tampered mismatched or non-target checkpoint refuses before custody'",
          "againstCommit": null,
          "schemaVersion": 1,
          "testFileSha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
          "mutateExpression": "s/if \\(JSON\\.stringify\\(target\\.data\\) !== JSON\\.stringify\\(plan\\.target\\)\\)/if (false)/",
          "probeInvocationId": "3beec27c-db6d-4ce2-a288-9cd4fa93b4f6",
          "testCommandSha256": "b7bc5608c013cce1f0466ad0e65dee20965ef98604cbcda74ced8fb59598e050",
          "subjectAfterSha256": "956860062c7f8770c45ca38527105801815144fa79ce983256e0be83c2011f80",
          "mutantDiffTruncated": false,
          "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
        },
        "mutationBaseline": {
          "testRunId": 22098338,
          "status": "pass",
          "mutation": {
            "leg": "copy-baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -184,7 +184,7 @@\n   if (!target.success) return refuse('target-changed');\n   const rejection = targetRefusal(actor, request, target.data);\n   if (rejection) return rejection;\n-  if (JSON.stringify(target.data) !== JSON.stringify(plan.target)) return refuse('target-changed');\n+  if (false) return refuse('target-changed');\n   return { ok: true, preparation: plan };\n }\n \n",
            "subjectPath": "packages/operator-core/lib/session-assume.ts",
            "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-10 tampered mismatched or non-target checkpoint refuses before custody'",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
            "mutateExpression": "s/if \\(JSON\\.stringify\\(target\\.data\\) !== JSON\\.stringify\\(plan\\.target\\)\\)/if (false)/",
            "probeInvocationId": "3beec27c-db6d-4ce2-a288-9cd4fa93b4f6",
            "testCommandSha256": "b7bc5608c013cce1f0466ad0e65dee20965ef98604cbcda74ced8fb59598e050",
            "subjectAfterSha256": "956860062c7f8770c45ca38527105801815144fa79ce983256e0be83c2011f80",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
          },
          "passed": 1,
          "failed": 0,
          "skipped": 67,
          "collectionFailed": false,
          "passedCaseTitles": [
            "session:assume preparation and exact custody > R-10 tampered mismatched or non-target checkpoint refuses before custody"
          ]
        },
        "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
        "worktreeDirty": false,
        "mutationFailureLines": [
          "session:assume preparation and exact custody > R-10 tampered mismatched or non-target checkpoint refuses before custody: (recorded failed assertion)"
        ],
        "mutationFailedCaseTitles": [
          "session:assume preparation and exact custody > R-10 tampered mismatched or non-target checkpoint refuses before custody"
        ]
      },
      "details": {
        "scope": "Recovery75 clause-specific committed copy-out mutant. Descriptor and controls/logs in recovery75/unit-mutation-manifest.json.",
        "testRun": {
          "id": 22098840,
          "source": "mutation-probe",
          "status": "fail",
          "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
          "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
          "finishedAt": "2026-10-26T02:38:15.924Z",
          "asCommitted": {
            "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
            "repoPrefix": "",
            "measuredAtCommit": true
          },
          "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
          "mutationPhase": "mutant",
          "worktreeDirty": false,
          "recordedFilePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
          "harnessAttribution": "adopted-caller-harness"
        },
        "adequacy": {
          "outcome": "caught",
          "skipped": false,
          "executed": true,
          "targeted": "AUTO-BAR-R-10-P-001",
          "collected": true,
          "testCases": [
            "session:assume preparation and exact custody > R-10 tampered mismatched or non-target checkpoint refuses before custody"
          ],
          "testLayer": "unit",
          "pathReachable": true,
          "fixtureCalibrated": true,
          "oracleIndependent": true
        },
        "causalControls": {
          "mutantTestRunId": 22098840,
          "baselineTestRunId": 22098337,
          "copyBaselineTestRunId": 22098338
        },
        "measurementPin": {
          "files": [
            {
              "path": "packages/operator-core/lib/session-assume.ts",
              "repo": ".",
              "clean": true,
              "sha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf",
              "headBlob": "7997ef1b4f67084d629527caf8228282e83b115f",
              "dimension": "source"
            },
            {
              "path": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
              "repo": ".",
              "clean": true,
              "sha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
              "headBlob": "87b06f31f104f9292f859a88acfc3a7450d96010",
              "dimension": "test"
            },
            {
              "path": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
              "repo": ".",
              "clean": true,
              "sha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
              "headBlob": "87b06f31f104f9292f859a88acfc3a7450d96010",
              "dimension": "fixture"
            }
          ],
          "repos": [
            {
              "head": "b37b838d2fd2ce3ed3f1c912aedd80a780dba5cc",
              "repo": ".",
              "gitlink": null
            }
          ],
          "schemaVersion": 1
        },
        "currentMeasurement": {
          "kind": "repo-files",
          "testPaths": [
            "packages/operator-core/lib/agent-tools/session/assume.test.ts"
          ],
          "sourcePaths": [
            "packages/operator-core/lib/session-assume.ts"
          ],
          "fixturePaths": [
            "packages/operator-core/lib/agent-tools/session/assume.test.ts"
          ],
          "schemaVersion": 1
        }
      },
      "observedAt": "2026-10-26T02:42:34.727Z",
      "bindingFingerprint": "876ceb6469e6795bc186bb22733ba8b27a497c75f8aa8653687582626aa3bcd2",
      "createdBy": "su-839a2783-00ac-4155-8ece-13caed560343",
      "createdAt": "2026-10-26T02:42:33.619Z",
      "serverMeasurement": {
        "status": "measured",
        "measuredDimensions": [
          "source",
          "test",
          "fixture"
        ],
        "measuredAtCommit": "b37b838d2fd2ce3ed3f1c912aedd80a780dba5cc",
        "current": {
          "planSlug": "agent-assume-identity-2026-10-23",
          "specId": "AUTO-BAR-R-10-P-001",
          "specRevision": 3,
          "specFingerprint": "f431714147c75b93d6b47d884945d075da9dd4626675a98e1910835a5b795a5f",
          "evidenceKind": "mutation",
          "evidenceRef": "test-run 22098840 mutation-probe mutant fail packages/operator-core/lib/agent-tools/session/assume.test.ts @3334d25de11c",
          "sourceFingerprint": "sha256-file-set-v1:a73e077cfeac4afed974d760804d68bd066bb6088452bda961fee2970d621184",
          "testFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd",
          "fixtureFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd"
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
      "id": 70889,
      "workItemId": "WI-6554700010025439",
      "planSlug": "agent-assume-identity-2026-10-23",
      "specId": "AUTO-BAR-R-9-P-001",
      "sourceValId": null,
      "specRevision": 3,
      "currentRevision": 3,
      "specFingerprint": "0b638afa5ea23070d1aad1599377bc8c6c076fdf0ab646b690bf60874debbd2f",
      "evidenceKind": "mutation",
      "evidenceRef": "test-run 22098334 mutation-probe mutant fail packages/operator-core/lib/agent-tools/session/assume.test.ts @3334d25de11c",
      "fingerprints": {
        "sourceFingerprint": "sha256-file-set-v1:a73e077cfeac4afed974d760804d68bd066bb6088452bda961fee2970d621184",
        "testFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd",
        "fixtureFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd",
        "rubricFingerprint": null,
        "environmentFingerprint": null
      },
      "coverageEvidenceRef": null,
      "testRunId": 22098334,
      "testRunExecution": {
        "status": "fail",
        "passed": 0,
        "failed": 1,
        "skipped": 67,
        "collectionFailed": false,
        "testNamePattern": "R-9 commit rechecks administrative authority and reviewer restrictions",
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
        "testLayer": "unit"
      },
      "testRunProvenance": {
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
        "framework": "vitest",
        "source": "mutation-probe",
        "mutationPhase": "mutant",
        "mutation": {
          "leg": "mutant",
          "mode": "copy-out",
          "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -173,7 +173,7 @@\n   const now = deps.now();\n   if (now < plan.preparedAt || now >= plan.expiresAt ||\n       plan.expiresAt - plan.preparedAt !== ASSUME_TOKEN_TTL_MS) return refuse('expired-token');\n-  if (await deps.authorize(actor, plan.target.role) !== plan.authorizationRef) return refuse('unauthorized');\n+  if (false) return refuse('unauthorized');\n   const caller = await deps.caller(actor);\n   if (JSON.stringify(callerSchema.safeParse(caller).data) !== JSON.stringify(plan.caller)) {\n     return refuse('caller-changed');\n",
          "subjectPath": "packages/operator-core/lib/session-assume.ts",
          "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-9 commit rechecks administrative authority and reviewer restrictions'",
          "againstCommit": null,
          "schemaVersion": 1,
          "testFileSha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
          "mutateExpression": "s/if \\(await deps\\.authorize\\(actor, plan\\.target\\.role\\) !== plan\\.authorizationRef\\)/if (false)/",
          "probeInvocationId": "e5e53f29-60a1-4f0f-8f6b-1bdfb780fe18",
          "testCommandSha256": "9b1daf2b4eca1c43a1ac69c0e7d8c606e3edb02c38e6e62a6bf70dc150b71c18",
          "subjectAfterSha256": "73ab40a4af6c8c34e2f8a59f26bde75c4241e52b0e3c7422c797cd1dd6d2326d",
          "mutantDiffTruncated": false,
          "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
        },
        "mutationBaseline": {
          "testRunId": 22098332,
          "status": "pass",
          "mutation": {
            "leg": "copy-baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -173,7 +173,7 @@\n   const now = deps.now();\n   if (now < plan.preparedAt || now >= plan.expiresAt ||\n       plan.expiresAt - plan.preparedAt !== ASSUME_TOKEN_TTL_MS) return refuse('expired-token');\n-  if (await deps.authorize(actor, plan.target.role) !== plan.authorizationRef) return refuse('unauthorized');\n+  if (false) return refuse('unauthorized');\n   const caller = await deps.caller(actor);\n   if (JSON.stringify(callerSchema.safeParse(caller).data) !== JSON.stringify(plan.caller)) {\n     return refuse('caller-changed');\n",
            "subjectPath": "packages/operator-core/lib/session-assume.ts",
            "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-9 commit rechecks administrative authority and reviewer restrictions'",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
            "mutateExpression": "s/if \\(await deps\\.authorize\\(actor, plan\\.target\\.role\\) !== plan\\.authorizationRef\\)/if (false)/",
            "probeInvocationId": "e5e53f29-60a1-4f0f-8f6b-1bdfb780fe18",
            "testCommandSha256": "9b1daf2b4eca1c43a1ac69c0e7d8c606e3edb02c38e6e62a6bf70dc150b71c18",
            "subjectAfterSha256": "73ab40a4af6c8c34e2f8a59f26bde75c4241e52b0e3c7422c797cd1dd6d2326d",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
          },
          "passed": 1,
          "failed": 0,
          "skipped": 67,
          "collectionFailed": false,
          "passedCaseTitles": [
            "session:assume preparation and exact custody > R-9 commit rechecks administrative authority and reviewer restrictions"
          ]
        },
        "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
        "worktreeDirty": false,
        "mutationFailureLines": [
          "session:assume preparation and exact custody > R-9 commit rechecks administrative authority and reviewer restrictions: (recorded failed assertion)"
        ],
        "mutationFailedCaseTitles": [
          "session:assume preparation and exact custody > R-9 commit rechecks administrative authority and reviewer restrictions"
        ]
      },
      "details": {
        "scope": "Recovery75 clause-specific committed copy-out mutant. Descriptor and controls/logs in recovery75/unit-mutation-manifest.json.",
        "testRun": {
          "id": 22098334,
          "source": "mutation-probe",
          "status": "fail",
          "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
          "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
          "finishedAt": "2026-10-26T02:37:34.960Z",
          "asCommitted": {
            "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
            "repoPrefix": "",
            "measuredAtCommit": true
          },
          "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
          "mutationPhase": "mutant",
          "worktreeDirty": false,
          "recordedFilePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
          "harnessAttribution": "adopted-caller-harness"
        },
        "adequacy": {
          "outcome": "caught",
          "skipped": false,
          "executed": true,
          "targeted": "AUTO-BAR-R-9-P-001",
          "collected": true,
          "testCases": [
            "session:assume preparation and exact custody > R-9 commit rechecks administrative authority and reviewer restrictions"
          ],
          "testLayer": "unit",
          "pathReachable": true,
          "fixtureCalibrated": true,
          "oracleIndependent": true
        },
        "causalControls": {
          "mutantTestRunId": 22098334,
          "baselineTestRunId": 22098329,
          "copyBaselineTestRunId": 22098332
        },
        "measurementPin": {
          "files": [
            {
              "path": "packages/operator-core/lib/session-assume.ts",
              "repo": ".",
              "clean": true,
              "sha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf",
              "headBlob": "7997ef1b4f67084d629527caf8228282e83b115f",
              "dimension": "source"
            },
            {
              "path": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
              "repo": ".",
              "clean": true,
              "sha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
              "headBlob": "87b06f31f104f9292f859a88acfc3a7450d96010",
              "dimension": "test"
            },
            {
              "path": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
              "repo": ".",
              "clean": true,
              "sha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
              "headBlob": "87b06f31f104f9292f859a88acfc3a7450d96010",
              "dimension": "fixture"
            }
          ],
          "repos": [
            {
              "head": "b37b838d2fd2ce3ed3f1c912aedd80a780dba5cc",
              "repo": ".",
              "gitlink": null
            }
          ],
          "schemaVersion": 1
        },
        "currentMeasurement": {
          "kind": "repo-files",
          "testPaths": [
            "packages/operator-core/lib/agent-tools/session/assume.test.ts"
          ],
          "sourcePaths": [
            "packages/operator-core/lib/session-assume.ts"
          ],
          "fixturePaths": [
            "packages/operator-core/lib/agent-tools/session/assume.test.ts"
          ],
          "schemaVersion": 1
        }
      },
      "observedAt": "2026-10-26T02:42:33.364Z",
      "bindingFingerprint": "862976135754445d6641866b6b110e344a8eb867492354b5d51a1ebac398e91d",
      "createdBy": "su-839a2783-00ac-4155-8ece-13caed560343",
      "createdAt": "2026-10-26T02:42:33.354Z",
      "serverMeasurement": {
        "status": "measured",
        "measuredDimensions": [
          "source",
          "test",
          "fixture"
        ],
        "measuredAtCommit": "b37b838d2fd2ce3ed3f1c912aedd80a780dba5cc",
        "current": {
          "planSlug": "agent-assume-identity-2026-10-23",
          "specId": "AUTO-BAR-R-9-P-001",
          "specRevision": 3,
          "specFingerprint": "0b638afa5ea23070d1aad1599377bc8c6c076fdf0ab646b690bf60874debbd2f",
          "evidenceKind": "mutation",
          "evidenceRef": "test-run 22098334 mutation-probe mutant fail packages/operator-core/lib/agent-tools/session/assume.test.ts @3334d25de11c",
          "sourceFingerprint": "sha256-file-set-v1:a73e077cfeac4afed974d760804d68bd066bb6088452bda961fee2970d621184",
          "testFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd",
          "fixtureFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd"
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
      "id": 70888,
      "workItemId": "WI-6554700010025439",
      "planSlug": "agent-assume-identity-2026-10-23",
      "specId": "AUTO-BAR-R-8-P-001",
      "sourceValId": null,
      "specRevision": 4,
      "currentRevision": 4,
      "specFingerprint": "d30cfd692b34fa3703717044a6f70364dcf24be009b9a4cc55d5766588b6e9fa",
      "evidenceKind": "mutation",
      "evidenceRef": "test-run 22098327 mutation-probe mutant fail packages/operator-core/lib/agent-tools/session/assume.test.ts @3334d25de11c",
      "fingerprints": {
        "sourceFingerprint": "sha256-file-set-v1:a73e077cfeac4afed974d760804d68bd066bb6088452bda961fee2970d621184",
        "testFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd",
        "fixtureFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd",
        "rubricFingerprint": null,
        "environmentFingerprint": null
      },
      "coverageEvidenceRef": null,
      "testRunId": 22098327,
      "testRunExecution": {
        "status": "fail",
        "passed": 0,
        "failed": 1,
        "skipped": 67,
        "collectionFailed": false,
        "testNamePattern": "R-8 crash after target custody before exec or verification converges on retry",
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
        "testLayer": "unit"
      },
      "testRunProvenance": {
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
        "framework": "vitest",
        "source": "mutation-probe",
        "mutationPhase": "mutant",
        "mutation": {
          "leg": "mutant",
          "mode": "copy-out",
          "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -474,7 +474,7 @@\n   const cancelled = observation.kind === 'cancelled' && observation.queuedHandoffCancelled === true &&\n     observation.nativeWriter === 'free' && observation.transitionKey === receipt.transitionKey &&\n     observation.preparationFingerprint === receipt.preparationFingerprint;\n-  if (!cancelled) return receipt;\n+  if (false) return receipt;\n   const restored = !receipt.recovery || await deps.restoreCaller(receipt.preparation, receipt.recovery).catch(() => false);\n   const released = await deps.releaseTarget(receipt.preparation).catch(() => false);\n   const settled: AssumeTransitionReceipt = { ...receipt, updatedAt: deps.now(), durable: true,\n",
          "subjectPath": "packages/operator-core/lib/session-assume.ts",
          "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-8 crash after target custody before exec or verification converges on retry'",
          "againstCommit": null,
          "schemaVersion": 1,
          "testFileSha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
          "mutateExpression": "s/if \\(!cancelled\\) return receipt;/if (false) return receipt;/",
          "probeInvocationId": "fbc50d75-5589-4e2c-ab43-bde703837f2a",
          "testCommandSha256": "4ab279971f023f092d5243a7e8038d1765c49c09434f3d9ee0155b8cf47005ec",
          "subjectAfterSha256": "5ac41b8ed983874f4eade9e5e60625e78c95472e02f0622a1ba5de955e8c9d59",
          "mutantDiffTruncated": false,
          "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
        },
        "mutationBaseline": {
          "testRunId": 22098325,
          "status": "pass",
          "mutation": {
            "leg": "copy-baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -474,7 +474,7 @@\n   const cancelled = observation.kind === 'cancelled' && observation.queuedHandoffCancelled === true &&\n     observation.nativeWriter === 'free' && observation.transitionKey === receipt.transitionKey &&\n     observation.preparationFingerprint === receipt.preparationFingerprint;\n-  if (!cancelled) return receipt;\n+  if (false) return receipt;\n   const restored = !receipt.recovery || await deps.restoreCaller(receipt.preparation, receipt.recovery).catch(() => false);\n   const released = await deps.releaseTarget(receipt.preparation).catch(() => false);\n   const settled: AssumeTransitionReceipt = { ...receipt, updatedAt: deps.now(), durable: true,\n",
            "subjectPath": "packages/operator-core/lib/session-assume.ts",
            "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-8 crash after target custody before exec or verification converges on retry'",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
            "mutateExpression": "s/if \\(!cancelled\\) return receipt;/if (false) return receipt;/",
            "probeInvocationId": "fbc50d75-5589-4e2c-ab43-bde703837f2a",
            "testCommandSha256": "4ab279971f023f092d5243a7e8038d1765c49c09434f3d9ee0155b8cf47005ec",
            "subjectAfterSha256": "5ac41b8ed983874f4eade9e5e60625e78c95472e02f0622a1ba5de955e8c9d59",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
          },
          "passed": 1,
          "failed": 0,
          "skipped": 67,
          "collectionFailed": false,
          "passedCaseTitles": [
            "session:assume durable transition boundaries > R-8 crash after target custody before exec or verification converges on retry"
          ]
        },
        "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
        "worktreeDirty": false,
        "mutationFailureLines": [
          "session:assume durable transition boundaries > R-8 crash after target custody before exec or verification converges on retry: (recorded failed assertion)"
        ],
        "mutationFailedCaseTitles": [
          "session:assume durable transition boundaries > R-8 crash after target custody before exec or verification converges on retry"
        ]
      },
      "details": {
        "scope": "Recovery75 clause-specific committed copy-out mutant. Descriptor and controls/logs in recovery75/unit-mutation-manifest.json.",
        "testRun": {
          "id": 22098327,
          "source": "mutation-probe",
          "status": "fail",
          "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
          "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
          "finishedAt": "2026-10-26T02:36:47.349Z",
          "asCommitted": {
            "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
            "repoPrefix": "",
            "measuredAtCommit": true
          },
          "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
          "mutationPhase": "mutant",
          "worktreeDirty": false,
          "recordedFilePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
          "harnessAttribution": "adopted-caller-harness"
        },
        "adequacy": {
          "outcome": "caught",
          "skipped": false,
          "executed": true,
          "targeted": "AUTO-BAR-R-8-P-001",
          "collected": true,
          "testCases": [
            "session:assume durable transition boundaries > R-8 crash after target custody before exec or verification converges on retry"
          ],
          "testLayer": "unit",
          "pathReachable": true,
          "fixtureCalibrated": true,
          "oracleIndependent": true
        },
        "causalControls": {
          "mutantTestRunId": 22098327,
          "baselineTestRunId": 22098321,
          "copyBaselineTestRunId": 22098325
        },
        "measurementPin": {
          "files": [
            {
              "path": "packages/operator-core/lib/session-assume.ts",
              "repo": ".",
              "clean": true,
              "sha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf",
              "headBlob": "7997ef1b4f67084d629527caf8228282e83b115f",
              "dimension": "source"
            },
            {
              "path": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
              "repo": ".",
              "clean": true,
              "sha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
              "headBlob": "87b06f31f104f9292f859a88acfc3a7450d96010",
              "dimension": "test"
            },
            {
              "path": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
              "repo": ".",
              "clean": true,
              "sha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
              "headBlob": "87b06f31f104f9292f859a88acfc3a7450d96010",
              "dimension": "fixture"
            }
          ],
          "repos": [
            {
              "head": "b37b838d2fd2ce3ed3f1c912aedd80a780dba5cc",
              "repo": ".",
              "gitlink": null
            }
          ],
          "schemaVersion": 1
        },
        "currentMeasurement": {
          "kind": "repo-files",
          "testPaths": [
            "packages/operator-core/lib/agent-tools/session/assume.test.ts"
          ],
          "sourcePaths": [
            "packages/operator-core/lib/session-assume.ts"
          ],
          "fixturePaths": [
            "packages/operator-core/lib/agent-tools/session/assume.test.ts"
          ],
          "schemaVersion": 1
        }
      },
      "observedAt": "2026-10-26T02:42:29.282Z",
      "bindingFingerprint": "bc99c052d492eef7a250430d561d2f759c7415937669e06d6450fce00f3cb5b0",
      "createdBy": "su-839a2783-00ac-4155-8ece-13caed560343",
      "createdAt": "2026-10-26T02:42:29.242Z",
      "serverMeasurement": {
        "status": "measured",
        "measuredDimensions": [
          "source",
          "test",
          "fixture"
        ],
        "measuredAtCommit": "b37b838d2fd2ce3ed3f1c912aedd80a780dba5cc",
        "current": {
          "planSlug": "agent-assume-identity-2026-10-23",
          "specId": "AUTO-BAR-R-8-P-001",
          "specRevision": 4,
          "specFingerprint": "d30cfd692b34fa3703717044a6f70364dcf24be009b9a4cc55d5766588b6e9fa",
          "evidenceKind": "mutation",
          "evidenceRef": "test-run 22098327 mutation-probe mutant fail packages/operator-core/lib/agent-tools/session/assume.test.ts @3334d25de11c",
          "sourceFingerprint": "sha256-file-set-v1:a73e077cfeac4afed974d760804d68bd066bb6088452bda961fee2970d621184",
          "testFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd",
          "fixtureFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd"
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
      "id": 70887,
      "workItemId": "WI-6554700010025439",
      "planSlug": "agent-assume-identity-2026-10-23",
      "specId": "AUTO-BAR-R-5-P-001",
      "sourceValId": null,
      "specRevision": 4,
      "currentRevision": 4,
      "specFingerprint": "b6df13a2f84f66ec87e8b4415f063e9bae927d49b5ef1897a70341da033145d8",
      "evidenceKind": "mutation",
      "evidenceRef": "test-run 22098319 mutation-probe mutant fail packages/operator-core/lib/agent-tools/session/assume.test.ts @3334d25de11c",
      "fingerprints": {
        "sourceFingerprint": "sha256-file-set-v1:a73e077cfeac4afed974d760804d68bd066bb6088452bda961fee2970d621184",
        "testFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd",
        "fixtureFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd",
        "rubricFingerprint": null,
        "environmentFingerprint": null
      },
      "coverageEvidenceRef": null,
      "testRunId": 22098319,
      "testRunExecution": {
        "status": "fail",
        "passed": 0,
        "failed": 1,
        "skipped": 67,
        "collectionFailed": false,
        "testNamePattern": "R-5 nonempty caller work and return reference survive handoff failure",
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
        "testLayer": "unit"
      },
      "testRunProvenance": {
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
        "framework": "vitest",
        "source": "mutation-probe",
        "mutationPhase": "mutant",
        "mutation": {
          "leg": "mutant",
          "mode": "copy-out",
          "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -343,7 +343,7 @@\n     await record('caller-checkpointed');\n     quiesceStarted = true;\n     receipt.disposition = await deps.quiesceCaller(plan, recovery);\n-    await record('caller-quiesced');\n+    receipt.disposition.releasedWorkClaims = []; await record('caller-quiesced');\n     if (!await deps.checkCustody(plan)) throw new Error('custody-changed');\n     await record('target-custody-acquired');\n     // Persist the uncertainty barrier BEFORE sending. Even if the host accepts\n",
          "subjectPath": "packages/operator-core/lib/session-assume.ts",
          "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-5 nonempty caller work and return reference survive handoff failure'",
          "againstCommit": null,
          "schemaVersion": 1,
          "testFileSha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
          "mutateExpression": "s/await record\\('caller-quiesced'\\);/receipt.disposition.releasedWorkClaims = []; await record('caller-quiesced');/",
          "probeInvocationId": "608f1931-994d-4f4c-8e12-d2fe817774a7",
          "testCommandSha256": "3b104210880fd482544391ad88f93b74173e59f69effae29df8b26b4cd6cbb9e",
          "subjectAfterSha256": "e3593f2ec0a7431140564c4afb7d9eb801e4d784cc6ca64722ab4681bed8c1f6",
          "mutantDiffTruncated": false,
          "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
        },
        "mutationBaseline": {
          "testRunId": 22098317,
          "status": "pass",
          "mutation": {
            "leg": "copy-baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -343,7 +343,7 @@\n     await record('caller-checkpointed');\n     quiesceStarted = true;\n     receipt.disposition = await deps.quiesceCaller(plan, recovery);\n-    await record('caller-quiesced');\n+    receipt.disposition.releasedWorkClaims = []; await record('caller-quiesced');\n     if (!await deps.checkCustody(plan)) throw new Error('custody-changed');\n     await record('target-custody-acquired');\n     // Persist the uncertainty barrier BEFORE sending. Even if the host accepts\n",
            "subjectPath": "packages/operator-core/lib/session-assume.ts",
            "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-5 nonempty caller work and return reference survive handoff failure'",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
            "mutateExpression": "s/await record\\('caller-quiesced'\\);/receipt.disposition.releasedWorkClaims = []; await record('caller-quiesced');/",
            "probeInvocationId": "608f1931-994d-4f4c-8e12-d2fe817774a7",
            "testCommandSha256": "3b104210880fd482544391ad88f93b74173e59f69effae29df8b26b4cd6cbb9e",
            "subjectAfterSha256": "e3593f2ec0a7431140564c4afb7d9eb801e4d784cc6ca64722ab4681bed8c1f6",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
          },
          "passed": 1,
          "failed": 0,
          "skipped": 67,
          "collectionFailed": false,
          "passedCaseTitles": [
            "session:assume durable transition boundaries > R-5 nonempty caller work and return reference survive handoff failure"
          ]
        },
        "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
        "worktreeDirty": false,
        "mutationFailureLines": [
          "session:assume durable transition boundaries > R-5 nonempty caller work and return reference survive handoff failure: (recorded failed assertion)"
        ],
        "mutationFailedCaseTitles": [
          "session:assume durable transition boundaries > R-5 nonempty caller work and return reference survive handoff failure"
        ]
      },
      "details": {
        "scope": "Recovery75 clause-specific committed copy-out mutant. Descriptor and controls/logs in recovery75/unit-mutation-manifest.json.",
        "testRun": {
          "id": 22098319,
          "source": "mutation-probe",
          "status": "fail",
          "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
          "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
          "finishedAt": "2026-10-26T02:35:57.104Z",
          "asCommitted": {
            "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
            "repoPrefix": "",
            "measuredAtCommit": true
          },
          "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
          "mutationPhase": "mutant",
          "worktreeDirty": false,
          "recordedFilePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
          "harnessAttribution": "adopted-caller-harness"
        },
        "adequacy": {
          "outcome": "caught",
          "skipped": false,
          "executed": true,
          "targeted": "AUTO-BAR-R-5-P-001",
          "collected": true,
          "testCases": [
            "session:assume durable transition boundaries > R-5 nonempty caller work and return reference survive handoff failure"
          ],
          "testLayer": "unit",
          "pathReachable": true,
          "fixtureCalibrated": true,
          "oracleIndependent": true
        },
        "causalControls": {
          "mutantTestRunId": 22098319,
          "baselineTestRunId": 22098315,
          "copyBaselineTestRunId": 22098317
        },
        "measurementPin": {
          "files": [
            {
              "path": "packages/operator-core/lib/session-assume.ts",
              "repo": ".",
              "clean": true,
              "sha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf",
              "headBlob": "7997ef1b4f67084d629527caf8228282e83b115f",
              "dimension": "source"
            },
            {
              "path": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
              "repo": ".",
              "clean": true,
              "sha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
              "headBlob": "87b06f31f104f9292f859a88acfc3a7450d96010",
              "dimension": "test"
            },
            {
              "path": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
              "repo": ".",
              "clean": true,
              "sha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
              "headBlob": "87b06f31f104f9292f859a88acfc3a7450d96010",
              "dimension": "fixture"
            }
          ],
          "repos": [
            {
              "head": "b37b838d2fd2ce3ed3f1c912aedd80a780dba5cc",
              "repo": ".",
              "gitlink": null
            }
          ],
          "schemaVersion": 1
        },
        "currentMeasurement": {
          "kind": "repo-files",
          "testPaths": [
            "packages/operator-core/lib/agent-tools/session/assume.test.ts"
          ],
          "sourcePaths": [
            "packages/operator-core/lib/session-assume.ts"
          ],
          "fixturePaths": [
            "packages/operator-core/lib/agent-tools/session/assume.test.ts"
          ],
          "schemaVersion": 1
        }
      },
      "observedAt": "2026-10-26T02:42:29.006Z",
      "bindingFingerprint": "338d3541899d24345492a976cf9758774dae3ca9412eaaa077691abbd0ca0673",
      "createdBy": "su-839a2783-00ac-4155-8ece-13caed560343",
      "createdAt": "2026-10-26T02:42:28.998Z",
      "serverMeasurement": {
        "status": "measured",
        "measuredDimensions": [
          "source",
          "test",
          "fixture"
        ],
        "measuredAtCommit": "b37b838d2fd2ce3ed3f1c912aedd80a780dba5cc",
        "current": {
          "planSlug": "agent-assume-identity-2026-10-23",
          "specId": "AUTO-BAR-R-5-P-001",
          "specRevision": 4,
          "specFingerprint": "b6df13a2f84f66ec87e8b4415f063e9bae927d49b5ef1897a70341da033145d8",
          "evidenceKind": "mutation",
          "evidenceRef": "test-run 22098319 mutation-probe mutant fail packages/operator-core/lib/agent-tools/session/assume.test.ts @3334d25de11c",
          "sourceFingerprint": "sha256-file-set-v1:a73e077cfeac4afed974d760804d68bd066bb6088452bda961fee2970d621184",
          "testFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd",
          "fixtureFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd"
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
      "id": 70886,
      "workItemId": "WI-6554700010025439",
      "planSlug": "agent-assume-identity-2026-10-23",
      "specId": "AUTO-BAR-R-4-P-001",
      "sourceValId": null,
      "specRevision": 4,
      "currentRevision": 4,
      "specFingerprint": "291659974261bd83079c1c3051c9764d2f728bdd6016059e745b49721426e257",
      "evidenceKind": "mutation",
      "evidenceRef": "test-run 22098313 mutation-probe mutant fail packages/operator-core/lib/agent-tools/session/assume.test.ts @3334d25de11c",
      "fingerprints": {
        "sourceFingerprint": "sha256-file-set-v1:a73e077cfeac4afed974d760804d68bd066bb6088452bda961fee2970d621184",
        "testFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd",
        "fixtureFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd",
        "rubricFingerprint": null,
        "environmentFingerprint": null
      },
      "coverageEvidenceRef": null,
      "testRunId": 22098313,
      "testRunExecution": {
        "status": "fail",
        "passed": 0,
        "failed": 1,
        "skipped": 67,
        "collectionFailed": false,
        "testNamePattern": "R-4 two callers race one target with one unchanged loser",
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
        "testLayer": "unit"
      },
      "testRunProvenance": {
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
        "framework": "vitest",
        "source": "mutation-probe",
        "mutationPhase": "mutant",
        "mutation": {
          "leg": "mutant",
          "mode": "copy-out",
          "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -325,7 +325,7 @@\n     reservationUncertain = true;\n     const reservation = await deps.reserve(plan);\n     reservationUncertain = false;\n-    if (!reservation.acquired) {\n+    if (false) {\n       receipt.reason = `custody-${reservation.status}`;\n       await record('refused');\n       return receipt;\n",
          "subjectPath": "packages/operator-core/lib/session-assume.ts",
          "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-4 two callers race one target with one unchanged loser'",
          "againstCommit": null,
          "schemaVersion": 1,
          "testFileSha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
          "mutateExpression": "s/if \\(!reservation\\.acquired\\)/if (false)/",
          "probeInvocationId": "a826d9f3-8524-4687-9060-ec4a0f013f60",
          "testCommandSha256": "41115980e0f53c852665b363e43319f566f67656bcf31d1dd520228dab3fb064",
          "subjectAfterSha256": "abe4012007fbc283c0ef8f5ccd3aeec6dad5c9c7bb73ce659b21c0aac7efc0f5",
          "mutantDiffTruncated": false,
          "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
        },
        "mutationBaseline": {
          "testRunId": 22098311,
          "status": "pass",
          "mutation": {
            "leg": "copy-baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -325,7 +325,7 @@\n     reservationUncertain = true;\n     const reservation = await deps.reserve(plan);\n     reservationUncertain = false;\n-    if (!reservation.acquired) {\n+    if (false) {\n       receipt.reason = `custody-${reservation.status}`;\n       await record('refused');\n       return receipt;\n",
            "subjectPath": "packages/operator-core/lib/session-assume.ts",
            "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-4 two callers race one target with one unchanged loser'",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
            "mutateExpression": "s/if \\(!reservation\\.acquired\\)/if (false)/",
            "probeInvocationId": "a826d9f3-8524-4687-9060-ec4a0f013f60",
            "testCommandSha256": "41115980e0f53c852665b363e43319f566f67656bcf31d1dd520228dab3fb064",
            "subjectAfterSha256": "abe4012007fbc283c0ef8f5ccd3aeec6dad5c9c7bb73ce659b21c0aac7efc0f5",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
          },
          "passed": 1,
          "failed": 0,
          "skipped": 67,
          "collectionFailed": false,
          "passedCaseTitles": [
            "session:assume durable transition boundaries > R-4 two callers race one target with one unchanged loser"
          ]
        },
        "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
        "worktreeDirty": false,
        "mutationFailureLines": [
          "session:assume durable transition boundaries > R-4 two callers race one target with one unchanged loser: (recorded failed assertion)"
        ],
        "mutationFailedCaseTitles": [
          "session:assume durable transition boundaries > R-4 two callers race one target with one unchanged loser"
        ]
      },
      "details": {
        "scope": "Recovery75 clause-specific committed copy-out mutant. Descriptor and controls/logs in recovery75/unit-mutation-manifest.json.",
        "testRun": {
          "id": 22098313,
          "source": "mutation-probe",
          "status": "fail",
          "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
          "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
          "finishedAt": "2026-10-26T02:35:02.630Z",
          "asCommitted": {
            "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
            "repoPrefix": "",
            "measuredAtCommit": true
          },
          "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
          "mutationPhase": "mutant",
          "worktreeDirty": false,
          "recordedFilePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
          "harnessAttribution": "adopted-caller-harness"
        },
        "adequacy": {
          "outcome": "caught",
          "skipped": false,
          "executed": true,
          "targeted": "AUTO-BAR-R-4-P-001",
          "collected": true,
          "testCases": [
            "session:assume durable transition boundaries > R-4 two callers race one target with one unchanged loser"
          ],
          "testLayer": "unit",
          "pathReachable": true,
          "fixtureCalibrated": true,
          "oracleIndependent": true
        },
        "causalControls": {
          "mutantTestRunId": 22098313,
          "baselineTestRunId": 22098249,
          "copyBaselineTestRunId": 22098311
        },
        "measurementPin": {
          "files": [
            {
              "path": "packages/operator-core/lib/session-assume.ts",
              "repo": ".",
              "clean": true,
              "sha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf",
              "headBlob": "7997ef1b4f67084d629527caf8228282e83b115f",
              "dimension": "source"
            },
            {
              "path": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
              "repo": ".",
              "clean": true,
              "sha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
              "headBlob": "87b06f31f104f9292f859a88acfc3a7450d96010",
              "dimension": "test"
            },
            {
              "path": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
              "repo": ".",
              "clean": true,
              "sha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
              "headBlob": "87b06f31f104f9292f859a88acfc3a7450d96010",
              "dimension": "fixture"
            }
          ],
          "repos": [
            {
              "head": "b37b838d2fd2ce3ed3f1c912aedd80a780dba5cc",
              "repo": ".",
              "gitlink": null
            }
          ],
          "schemaVersion": 1
        },
        "currentMeasurement": {
          "kind": "repo-files",
          "testPaths": [
            "packages/operator-core/lib/agent-tools/session/assume.test.ts"
          ],
          "sourcePaths": [
            "packages/operator-core/lib/session-assume.ts"
          ],
          "fixturePaths": [
            "packages/operator-core/lib/agent-tools/session/assume.test.ts"
          ],
          "schemaVersion": 1
        }
      },
      "observedAt": "2026-10-26T02:42:06.054Z",
      "bindingFingerprint": "9d81e95466eed37f0cda42dc9285b5240e37df98cae224726c478af2a8f20c0d",
      "createdBy": "su-839a2783-00ac-4155-8ece-13caed560343",
      "createdAt": "2026-10-26T02:42:06.040Z",
      "serverMeasurement": {
        "status": "measured",
        "measuredDimensions": [
          "source",
          "test",
          "fixture"
        ],
        "measuredAtCommit": "b37b838d2fd2ce3ed3f1c912aedd80a780dba5cc",
        "current": {
          "planSlug": "agent-assume-identity-2026-10-23",
          "specId": "AUTO-BAR-R-4-P-001",
          "specRevision": 4,
          "specFingerprint": "291659974261bd83079c1c3051c9764d2f728bdd6016059e745b49721426e257",
          "evidenceKind": "mutation",
          "evidenceRef": "test-run 22098313 mutation-probe mutant fail packages/operator-core/lib/agent-tools/session/assume.test.ts @3334d25de11c",
          "sourceFingerprint": "sha256-file-set-v1:a73e077cfeac4afed974d760804d68bd066bb6088452bda961fee2970d621184",
          "testFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd",
          "fixtureFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd"
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
      "id": 70885,
      "workItemId": "WI-6554700010025439",
      "planSlug": "agent-assume-identity-2026-10-23",
      "specId": "AUTO-BAR-R-3-P-001",
      "sourceValId": null,
      "specRevision": 4,
      "currentRevision": 4,
      "specFingerprint": "99ab5f33499c4aa5c971266d402fd4e3ac162db5759b2faa3355dc2522a5c284",
      "evidenceKind": "mutation",
      "evidenceRef": "test-run 22098248 mutation-probe mutant fail packages/operator-core/lib/agent-tools/session/assume.test.ts @3334d25de11c",
      "fingerprints": {
        "sourceFingerprint": "sha256-file-set-v1:a73e077cfeac4afed974d760804d68bd066bb6088452bda961fee2970d621184",
        "testFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd",
        "fixtureFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd",
        "rubricFingerprint": null,
        "environmentFingerprint": null
      },
      "coverageEvidenceRef": null,
      "testRunId": 22098248,
      "testRunExecution": {
        "status": "fail",
        "passed": 0,
        "failed": 1,
        "skipped": 67,
        "collectionFailed": false,
        "testNamePattern": "R-3 unavailable corrupt stale and incompatible context refuses without fallback",
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
        "testLayer": "unit"
      },
      "testRunProvenance": {
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
        "framework": "vitest",
        "source": "mutation-probe",
        "mutationPhase": "mutant",
        "mutation": {
          "leg": "mutant",
          "mode": "copy-out",
          "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -126,7 +126,7 @@\n       (request.contextMode === 'checkpoint' && (target.backend === 'omp' ||\n         (target.backend === 'codex' ? target.executionNativeSessionId !== null\n           : !target.executionNativeSessionId || target.executionNativeSessionId === target.nativeSessionId)))) {\n-    return refuse('context-unavailable');\n+    return null;\n   }\n   return null;\n }\n",
          "subjectPath": "packages/operator-core/lib/session-assume.ts",
          "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-3 unavailable corrupt stale and incompatible context refuses without fallback'",
          "againstCommit": null,
          "schemaVersion": 1,
          "testFileSha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
          "mutateExpression": "s/    return refuse\\('context-unavailable'\\);/    return null;/",
          "probeInvocationId": "5974ed95-7cc8-4455-90c0-682cbf51759d",
          "testCommandSha256": "8c1944bb6ccb02f5d8802bb1a6fa8effc83e0c1802df52a13952312eabde4fb4",
          "subjectAfterSha256": "63e35ad93799700fec10ca5168842d2fcf87fca3e7b6213ca4bbafca54740c5a",
          "mutantDiffTruncated": false,
          "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
        },
        "mutationBaseline": {
          "testRunId": 22098247,
          "status": "pass",
          "mutation": {
            "leg": "copy-baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -126,7 +126,7 @@\n       (request.contextMode === 'checkpoint' && (target.backend === 'omp' ||\n         (target.backend === 'codex' ? target.executionNativeSessionId !== null\n           : !target.executionNativeSessionId || target.executionNativeSessionId === target.nativeSessionId)))) {\n-    return refuse('context-unavailable');\n+    return null;\n   }\n   return null;\n }\n",
            "subjectPath": "packages/operator-core/lib/session-assume.ts",
            "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-3 unavailable corrupt stale and incompatible context refuses without fallback'",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
            "mutateExpression": "s/    return refuse\\('context-unavailable'\\);/    return null;/",
            "probeInvocationId": "5974ed95-7cc8-4455-90c0-682cbf51759d",
            "testCommandSha256": "8c1944bb6ccb02f5d8802bb1a6fa8effc83e0c1802df52a13952312eabde4fb4",
            "subjectAfterSha256": "63e35ad93799700fec10ca5168842d2fcf87fca3e7b6213ca4bbafca54740c5a",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
          },
          "passed": 1,
          "failed": 0,
          "skipped": 67,
          "collectionFailed": false,
          "passedCaseTitles": [
            "session:assume preparation and exact custody > R-3 unavailable corrupt stale and incompatible context refuses without fallback"
          ]
        },
        "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
        "worktreeDirty": false,
        "mutationFailureLines": [
          "session:assume preparation and exact custody > R-3 unavailable corrupt stale and incompatible context refuses without fallback: (recorded failed assertion)"
        ],
        "mutationFailedCaseTitles": [
          "session:assume preparation and exact custody > R-3 unavailable corrupt stale and incompatible context refuses without fallback"
        ]
      },
      "details": {
        "scope": "Recovery75 clause-specific committed copy-out mutant. Descriptor and controls/logs in recovery75/unit-mutation-manifest.json.",
        "testRun": {
          "id": 22098248,
          "source": "mutation-probe",
          "status": "fail",
          "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
          "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
          "finishedAt": "2026-10-26T02:34:10.742Z",
          "asCommitted": {
            "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
            "repoPrefix": "",
            "measuredAtCommit": true
          },
          "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
          "mutationPhase": "mutant",
          "worktreeDirty": false,
          "recordedFilePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
          "harnessAttribution": "adopted-caller-harness"
        },
        "adequacy": {
          "outcome": "caught",
          "skipped": false,
          "executed": true,
          "targeted": "AUTO-BAR-R-3-P-001",
          "collected": true,
          "testCases": [
            "session:assume preparation and exact custody > R-3 unavailable corrupt stale and incompatible context refuses without fallback"
          ],
          "testLayer": "unit",
          "pathReachable": true,
          "fixtureCalibrated": true,
          "oracleIndependent": true
        },
        "causalControls": {
          "mutantTestRunId": 22098248,
          "baselineTestRunId": 22098246,
          "copyBaselineTestRunId": 22098247
        },
        "measurementPin": {
          "files": [
            {
              "path": "packages/operator-core/lib/session-assume.ts",
              "repo": ".",
              "clean": true,
              "sha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf",
              "headBlob": "7997ef1b4f67084d629527caf8228282e83b115f",
              "dimension": "source"
            },
            {
              "path": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
              "repo": ".",
              "clean": true,
              "sha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
              "headBlob": "87b06f31f104f9292f859a88acfc3a7450d96010",
              "dimension": "test"
            },
            {
              "path": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
              "repo": ".",
              "clean": true,
              "sha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
              "headBlob": "87b06f31f104f9292f859a88acfc3a7450d96010",
              "dimension": "fixture"
            }
          ],
          "repos": [
            {
              "head": "b37b838d2fd2ce3ed3f1c912aedd80a780dba5cc",
              "repo": ".",
              "gitlink": null
            }
          ],
          "schemaVersion": 1
        },
        "currentMeasurement": {
          "kind": "repo-files",
          "testPaths": [
            "packages/operator-core/lib/agent-tools/session/assume.test.ts"
          ],
          "sourcePaths": [
            "packages/operator-core/lib/session-assume.ts"
          ],
          "fixturePaths": [
            "packages/operator-core/lib/agent-tools/session/assume.test.ts"
          ],
          "schemaVersion": 1
        }
      },
      "observedAt": "2026-10-26T02:42:05.780Z",
      "bindingFingerprint": "6cdf20521810d3206714bba406c11bc078e763bc12b20b9aff589aec76260c3f",
      "createdBy": "su-839a2783-00ac-4155-8ece-13caed560343",
      "createdAt": "2026-10-26T02:42:05.761Z",
      "serverMeasurement": {
        "status": "measured",
        "measuredDimensions": [
          "source",
          "test",
          "fixture"
        ],
        "measuredAtCommit": "b37b838d2fd2ce3ed3f1c912aedd80a780dba5cc",
        "current": {
          "planSlug": "agent-assume-identity-2026-10-23",
          "specId": "AUTO-BAR-R-3-P-001",
          "specRevision": 4,
          "specFingerprint": "99ab5f33499c4aa5c971266d402fd4e3ac162db5759b2faa3355dc2522a5c284",
          "evidenceKind": "mutation",
          "evidenceRef": "test-run 22098248 mutation-probe mutant fail packages/operator-core/lib/agent-tools/session/assume.test.ts @3334d25de11c",
          "sourceFingerprint": "sha256-file-set-v1:a73e077cfeac4afed974d760804d68bd066bb6088452bda961fee2970d621184",
          "testFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd",
          "fixtureFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd"
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
      "id": 70884,
      "workItemId": "WI-6554700010025439",
      "planSlug": "agent-assume-identity-2026-10-23",
      "specId": "AUTO-BAR-R-2-P-001",
      "sourceValId": null,
      "specRevision": 4,
      "currentRevision": 4,
      "specFingerprint": "a39cdea05a09e5cf0f43f1dd7b1571b06f1b224e70b6cbcb474410d5fe7274dd",
      "evidenceKind": "mutation",
      "evidenceRef": "test-run 22098195 mutation-probe mutant fail packages/operator-core/lib/agent-tools/session/assume.test.ts @3334d25de11c",
      "fingerprints": {
        "sourceFingerprint": "sha256-file-set-v1:a73e077cfeac4afed974d760804d68bd066bb6088452bda961fee2970d621184",
        "testFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd",
        "fixtureFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd",
        "rubricFingerprint": null,
        "environmentFingerprint": null
      },
      "coverageEvidenceRef": null,
      "testRunId": 22098195,
      "testRunExecution": {
        "status": "fail",
        "passed": 0,
        "failed": 1,
        "skipped": 67,
        "collectionFailed": false,
        "testNamePattern": "R-2 target inbox and task routing spans before during and after cutover",
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
        "testLayer": "unit"
      },
      "testRunProvenance": {
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
        "framework": "vitest",
        "source": "mutation-probe",
        "mutationPhase": "mutant",
        "mutation": {
          "leg": "mutant",
          "mode": "copy-out",
          "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -432,7 +432,7 @@\n     observation.nativePid !== caller.nativePid && !!observation.nativeProcessStart &&\n     Number.isSafeInteger(ptyPid) && ptyPid > 0 && ptyPid !== caller.nativePid && !!ptyStart &&\n     observation.nativeWriterPids.length === 1 && observation.nativeWriterPids[0] === observation.nativePid &&\n-    !!observation.directedMessage.id && observation.directedMessage.recipient === target.ownerId &&\n+    !!observation.directedMessage.id && true &&\n     observation.directedMessage.consumedBy === target.ownerId && observation.directedMessage.consumptions === 1 &&\n     !!observation.assignment.id && observation.assignment.assignee === target.ownerId &&\n     observation.assignment.observedBy === target.ownerId;\n",
          "subjectPath": "packages/operator-core/lib/session-assume.ts",
          "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-2 target inbox and task routing spans before during and after cutover'",
          "againstCommit": null,
          "schemaVersion": 1,
          "testFileSha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
          "mutateExpression": "s/observation\\.directedMessage\\.recipient === target\\.ownerId/true/",
          "probeInvocationId": "b16942e3-0452-4212-a227-dccc17ca9b28",
          "testCommandSha256": "7ac1b57ecd10b9a3e37158b47685652a325626458add5d15aa1241f77913788c",
          "subjectAfterSha256": "fb57dbfd918ec76ac04345054fd5255cdcf25b51cc832e5339dd0e27aabfc532",
          "mutantDiffTruncated": false,
          "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
        },
        "mutationBaseline": {
          "testRunId": 22098193,
          "status": "pass",
          "mutation": {
            "leg": "copy-baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -432,7 +432,7 @@\n     observation.nativePid !== caller.nativePid && !!observation.nativeProcessStart &&\n     Number.isSafeInteger(ptyPid) && ptyPid > 0 && ptyPid !== caller.nativePid && !!ptyStart &&\n     observation.nativeWriterPids.length === 1 && observation.nativeWriterPids[0] === observation.nativePid &&\n-    !!observation.directedMessage.id && observation.directedMessage.recipient === target.ownerId &&\n+    !!observation.directedMessage.id && true &&\n     observation.directedMessage.consumedBy === target.ownerId && observation.directedMessage.consumptions === 1 &&\n     !!observation.assignment.id && observation.assignment.assignee === target.ownerId &&\n     observation.assignment.observedBy === target.ownerId;\n",
            "subjectPath": "packages/operator-core/lib/session-assume.ts",
            "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-2 target inbox and task routing spans before during and after cutover'",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
            "mutateExpression": "s/observation\\.directedMessage\\.recipient === target\\.ownerId/true/",
            "probeInvocationId": "b16942e3-0452-4212-a227-dccc17ca9b28",
            "testCommandSha256": "7ac1b57ecd10b9a3e37158b47685652a325626458add5d15aa1241f77913788c",
            "subjectAfterSha256": "fb57dbfd918ec76ac04345054fd5255cdcf25b51cc832e5339dd0e27aabfc532",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
          },
          "passed": 1,
          "failed": 0,
          "skipped": 67,
          "collectionFailed": false,
          "passedCaseTitles": [
            "session:assume durable transition boundaries > R-2 target inbox and task routing spans before during and after cutover"
          ]
        },
        "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
        "worktreeDirty": false,
        "mutationFailureLines": [
          "session:assume durable transition boundaries > R-2 target inbox and task routing spans before during and after cutover: (recorded failed assertion)"
        ],
        "mutationFailedCaseTitles": [
          "session:assume durable transition boundaries > R-2 target inbox and task routing spans before during and after cutover"
        ]
      },
      "details": {
        "scope": "Recovery75 clause-specific committed copy-out mutant. Descriptor and controls/logs in recovery75/unit-mutation-manifest.json.",
        "testRun": {
          "id": 22098195,
          "source": "mutation-probe",
          "status": "fail",
          "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
          "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
          "finishedAt": "2026-10-26T02:32:57.946Z",
          "asCommitted": {
            "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
            "repoPrefix": "",
            "measuredAtCommit": true
          },
          "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
          "mutationPhase": "mutant",
          "worktreeDirty": false,
          "recordedFilePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
          "harnessAttribution": "adopted-caller-harness"
        },
        "adequacy": {
          "outcome": "caught",
          "skipped": false,
          "executed": true,
          "targeted": "AUTO-BAR-R-2-P-001",
          "collected": true,
          "testCases": [
            "session:assume durable transition boundaries > R-2 target inbox and task routing spans before during and after cutover"
          ],
          "testLayer": "unit",
          "pathReachable": true,
          "fixtureCalibrated": true,
          "oracleIndependent": true
        },
        "causalControls": {
          "mutantTestRunId": 22098195,
          "baselineTestRunId": 22098191,
          "copyBaselineTestRunId": 22098193
        },
        "measurementPin": {
          "files": [
            {
              "path": "packages/operator-core/lib/session-assume.ts",
              "repo": ".",
              "clean": true,
              "sha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf",
              "headBlob": "7997ef1b4f67084d629527caf8228282e83b115f",
              "dimension": "source"
            },
            {
              "path": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
              "repo": ".",
              "clean": true,
              "sha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
              "headBlob": "87b06f31f104f9292f859a88acfc3a7450d96010",
              "dimension": "test"
            },
            {
              "path": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
              "repo": ".",
              "clean": true,
              "sha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
              "headBlob": "87b06f31f104f9292f859a88acfc3a7450d96010",
              "dimension": "fixture"
            }
          ],
          "repos": [
            {
              "head": "b37b838d2fd2ce3ed3f1c912aedd80a780dba5cc",
              "repo": ".",
              "gitlink": null
            }
          ],
          "schemaVersion": 1
        },
        "currentMeasurement": {
          "kind": "repo-files",
          "testPaths": [
            "packages/operator-core/lib/agent-tools/session/assume.test.ts"
          ],
          "sourcePaths": [
            "packages/operator-core/lib/session-assume.ts"
          ],
          "fixturePaths": [
            "packages/operator-core/lib/agent-tools/session/assume.test.ts"
          ],
          "schemaVersion": 1
        }
      },
      "observedAt": "2026-10-26T02:42:04.091Z",
      "bindingFingerprint": "ada46c9c371ec9360c17f5b1e6643ac6b437d985b90038087f744920cb6a7823",
      "createdBy": "su-839a2783-00ac-4155-8ece-13caed560343",
      "createdAt": "2026-10-26T02:42:04.068Z",
      "serverMeasurement": {
        "status": "measured",
        "measuredDimensions": [
          "source",
          "test",
          "fixture"
        ],
        "measuredAtCommit": "b37b838d2fd2ce3ed3f1c912aedd80a780dba5cc",
        "current": {
          "planSlug": "agent-assume-identity-2026-10-23",
          "specId": "AUTO-BAR-R-2-P-001",
          "specRevision": 4,
          "specFingerprint": "a39cdea05a09e5cf0f43f1dd7b1571b06f1b224e70b6cbcb474410d5fe7274dd",
          "evidenceKind": "mutation",
          "evidenceRef": "test-run 22098195 mutation-probe mutant fail packages/operator-core/lib/agent-tools/session/assume.test.ts @3334d25de11c",
          "sourceFingerprint": "sha256-file-set-v1:a73e077cfeac4afed974d760804d68bd066bb6088452bda961fee2970d621184",
          "testFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd",
          "fixtureFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd"
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
      "id": 70883,
      "workItemId": "WI-6554700010025439",
      "planSlug": "agent-assume-identity-2026-10-23",
      "specId": "AUTO-BAR-R-1-P-001",
      "sourceValId": null,
      "specRevision": 5,
      "currentRevision": 5,
      "specFingerprint": "c3b907cd50a326fad56a344fa0a3db4c74fab44dbca327a793f518a1652c9440",
      "evidenceKind": "mutation",
      "evidenceRef": "test-run 22098177 mutation-probe mutant fail packages/operator-core/lib/agent-tools/session/assume.test.ts @3334d25de11c",
      "fingerprints": {
        "sourceFingerprint": "sha256-file-set-v1:a73e077cfeac4afed974d760804d68bd066bb6088452bda961fee2970d621184",
        "testFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd",
        "fixtureFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd",
        "rubricFingerprint": null,
        "environmentFingerprint": null
      },
      "coverageEvidenceRef": null,
      "testRunId": 22098177,
      "testRunExecution": {
        "status": "fail",
        "passed": 0,
        "failed": 1,
        "skipped": 67,
        "collectionFailed": false,
        "testNamePattern": "R-1 reject unrelated-window and env-only fake takeover",
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
        "testLayer": "unit"
      },
      "testRunProvenance": {
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
        "framework": "vitest",
        "source": "mutation-probe",
        "mutationPhase": "mutant",
        "mutation": {
          "leg": "mutant",
          "mode": "copy-out",
          "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -415,7 +415,7 @@\n   return ['handoff-requested', 'handoff-accepted', 'indeterminate'].includes(receipt.state) &&\n     observation.transitionKey === receipt.transitionKey &&\n     Number.isFinite(observation.observedAt) && observation.observedAt >= receipt.updatedAt &&\n-    observation.hostId === caller.hostId && observation.attachmentId === caller.attachmentId &&\n+    true && observation.attachmentId === caller.attachmentId &&\n     observation.callerNativePid === caller.nativePid && observation.callerExited === true &&\n     observation.targetOwnerId === target.ownerId &&\n     (target.executionNativeSessionId !== null\n",
          "subjectPath": "packages/operator-core/lib/session-assume.ts",
          "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-1 reject unrelated-window and env-only fake takeover'",
          "againstCommit": null,
          "schemaVersion": 1,
          "testFileSha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
          "mutateExpression": "s/observation\\.hostId === caller\\.hostId/true/",
          "probeInvocationId": "52b5c492-fb03-4860-8099-626710503b66",
          "testCommandSha256": "e14c4de9461eae43af578809f1f5b4e71be7b941ca17f9b8b1fbc284f7281582",
          "subjectAfterSha256": "b6e5444370bc9539bfc23933910f19da687df074e3d79a9577e40b27cccc8e10",
          "mutantDiffTruncated": false,
          "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
        },
        "mutationBaseline": {
          "testRunId": 22098175,
          "status": "pass",
          "mutation": {
            "leg": "copy-baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -415,7 +415,7 @@\n   return ['handoff-requested', 'handoff-accepted', 'indeterminate'].includes(receipt.state) &&\n     observation.transitionKey === receipt.transitionKey &&\n     Number.isFinite(observation.observedAt) && observation.observedAt >= receipt.updatedAt &&\n-    observation.hostId === caller.hostId && observation.attachmentId === caller.attachmentId &&\n+    true && observation.attachmentId === caller.attachmentId &&\n     observation.callerNativePid === caller.nativePid && observation.callerExited === true &&\n     observation.targetOwnerId === target.ownerId &&\n     (target.executionNativeSessionId !== null\n",
            "subjectPath": "packages/operator-core/lib/session-assume.ts",
            "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-1 reject unrelated-window and env-only fake takeover'",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
            "mutateExpression": "s/observation\\.hostId === caller\\.hostId/true/",
            "probeInvocationId": "52b5c492-fb03-4860-8099-626710503b66",
            "testCommandSha256": "e14c4de9461eae43af578809f1f5b4e71be7b941ca17f9b8b1fbc284f7281582",
            "subjectAfterSha256": "b6e5444370bc9539bfc23933910f19da687df074e3d79a9577e40b27cccc8e10",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
          },
          "passed": 1,
          "failed": 0,
          "skipped": 67,
          "collectionFailed": false,
          "passedCaseTitles": [
            "session:assume durable transition boundaries > R-1 reject unrelated-window and env-only fake takeover"
          ]
        },
        "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
        "worktreeDirty": false,
        "mutationFailureLines": [
          "session:assume durable transition boundaries > R-1 reject unrelated-window and env-only fake takeover: (recorded failed assertion)"
        ],
        "mutationFailedCaseTitles": [
          "session:assume durable transition boundaries > R-1 reject unrelated-window and env-only fake takeover"
        ]
      },
      "details": {
        "scope": "Recovery75 clause-specific committed copy-out mutant. Descriptor and controls/logs in recovery75/unit-mutation-manifest.json.",
        "testRun": {
          "id": 22098177,
          "source": "mutation-probe",
          "status": "fail",
          "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
          "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
          "finishedAt": "2026-10-26T02:31:52.962Z",
          "asCommitted": {
            "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
            "repoPrefix": "",
            "measuredAtCommit": true
          },
          "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
          "mutationPhase": "mutant",
          "worktreeDirty": false,
          "recordedFilePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
          "harnessAttribution": "adopted-caller-harness"
        },
        "adequacy": {
          "outcome": "caught",
          "skipped": false,
          "executed": true,
          "targeted": "AUTO-BAR-R-1-P-001",
          "collected": true,
          "testCases": [
            "session:assume durable transition boundaries > R-1 reject unrelated-window and env-only fake takeover"
          ],
          "testLayer": "unit",
          "pathReachable": true,
          "fixtureCalibrated": true,
          "oracleIndependent": true
        },
        "causalControls": {
          "mutantTestRunId": 22098177,
          "baselineTestRunId": 22098173,
          "copyBaselineTestRunId": 22098175
        },
        "measurementPin": {
          "files": [
            {
              "path": "packages/operator-core/lib/session-assume.ts",
              "repo": ".",
              "clean": true,
              "sha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf",
              "headBlob": "7997ef1b4f67084d629527caf8228282e83b115f",
              "dimension": "source"
            },
            {
              "path": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
              "repo": ".",
              "clean": true,
              "sha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
              "headBlob": "87b06f31f104f9292f859a88acfc3a7450d96010",
              "dimension": "test"
            },
            {
              "path": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
              "repo": ".",
              "clean": true,
              "sha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
              "headBlob": "87b06f31f104f9292f859a88acfc3a7450d96010",
              "dimension": "fixture"
            }
          ],
          "repos": [
            {
              "head": "b37b838d2fd2ce3ed3f1c912aedd80a780dba5cc",
              "repo": ".",
              "gitlink": null
            }
          ],
          "schemaVersion": 1
        },
        "currentMeasurement": {
          "kind": "repo-files",
          "testPaths": [
            "packages/operator-core/lib/agent-tools/session/assume.test.ts"
          ],
          "sourcePaths": [
            "packages/operator-core/lib/session-assume.ts"
          ],
          "fixturePaths": [
            "packages/operator-core/lib/agent-tools/session/assume.test.ts"
          ],
          "schemaVersion": 1
        }
      },
      "observedAt": "2026-10-26T02:42:03.886Z",
      "bindingFingerprint": "2166ad7595645993ac3647b74e918cb15abe94d47700a5f1257e77f866bc0629",
      "createdBy": "su-839a2783-00ac-4155-8ece-13caed560343",
      "createdAt": "2026-10-26T02:42:03.870Z",
      "serverMeasurement": {
        "status": "measured",
        "measuredDimensions": [
          "source",
          "test",
          "fixture"
        ],
        "measuredAtCommit": "b37b838d2fd2ce3ed3f1c912aedd80a780dba5cc",
        "current": {
          "planSlug": "agent-assume-identity-2026-10-23",
          "specId": "AUTO-BAR-R-1-P-001",
          "specRevision": 5,
          "specFingerprint": "c3b907cd50a326fad56a344fa0a3db4c74fab44dbca327a793f518a1652c9440",
          "evidenceKind": "mutation",
          "evidenceRef": "test-run 22098177 mutation-probe mutant fail packages/operator-core/lib/agent-tools/session/assume.test.ts @3334d25de11c",
          "sourceFingerprint": "sha256-file-set-v1:a73e077cfeac4afed974d760804d68bd066bb6088452bda961fee2970d621184",
          "testFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd",
          "fixtureFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd"
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
      "id": 70877,
      "workItemId": "WI-6554700010025439",
      "planSlug": "agent-assume-identity-2026-10-23",
      "specId": "AUTO-BAR-R-6-P-001",
      "sourceValId": null,
      "specRevision": 5,
      "currentRevision": 5,
      "specFingerprint": "1d5aea6062264366df1d44b436e12a2aa86ecc8e186ad18449b33a515de8b2fb",
      "evidenceKind": "mutation",
      "evidenceRef": "test-run 22097651 mutation-probe mutant fail packages/operator-core/lib/agent-tools/session/assume.test.ts @3334d25de11c",
      "fingerprints": {
        "sourceFingerprint": "sha256-file-set-v1:a73e077cfeac4afed974d760804d68bd066bb6088452bda961fee2970d621184",
        "testFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd",
        "fixtureFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd",
        "rubricFingerprint": null,
        "environmentFingerprint": null
      },
      "coverageEvidenceRef": null,
      "testRunId": 22097651,
      "testRunExecution": {
        "status": "fail",
        "passed": 0,
        "failed": 1,
        "skipped": 67,
        "collectionFailed": false,
        "testNamePattern": "R-6 accepted requires later process and routed probe verification",
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
        "testLayer": "unit"
      },
      "testRunProvenance": {
        "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
        "framework": "vitest",
        "source": "mutation-probe",
        "mutationPhase": "mutant",
        "mutation": {
          "leg": "mutant",
          "mode": "copy-out",
          "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -354,7 +354,7 @@\n       handoffAttempted = false; // a definite negative ack permits rollback\n       throw new Error('host-refused');\n     }\n-    await record('handoff-accepted');\n+    await record('target-verified');\n     return receipt;\n   } catch (error) {\n     // Keep adapter errors private: command lines, credentials and context text\n",
          "subjectPath": "packages/operator-core/lib/session-assume.ts",
          "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-6 accepted requires later process and routed probe verification'",
          "againstCommit": null,
          "schemaVersion": 1,
          "testFileSha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
          "mutateExpression": "s/await record\\('handoff-accepted'\\);/await record('target-verified');/",
          "probeInvocationId": "e86cf6b2-352b-46e7-a5ab-1fc7de6fbb06",
          "testCommandSha256": "1954f66a3170adc279d61f01a9715709f197cf930d96e42a838375aa74a1d9f0",
          "subjectAfterSha256": "e091f50cc1e90f13ef8731eab8208c09822131c5286f8cc9bc439b49b78a4482",
          "mutantDiffTruncated": false,
          "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
        },
        "mutationBaseline": {
          "testRunId": 22097649,
          "status": "pass",
          "mutation": {
            "leg": "copy-baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/packages/operator-core/lib/session-assume.ts\n+++ b/packages/operator-core/lib/session-assume.ts\n@@ -354,7 +354,7 @@\n       handoffAttempted = false; // a definite negative ack permits rollback\n       throw new Error('host-refused');\n     }\n-    await record('handoff-accepted');\n+    await record('target-verified');\n     return receipt;\n   } catch (error) {\n     // Keep adapter errors private: command lines, credentials and context text\n",
            "subjectPath": "packages/operator-core/lib/session-assume.ts",
            "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/agent-tools/session/assume.test.ts --testNamePattern 'R-6 accepted requires later process and routed probe verification'",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
            "mutateExpression": "s/await record\\('handoff-accepted'\\);/await record('target-verified');/",
            "probeInvocationId": "e86cf6b2-352b-46e7-a5ab-1fc7de6fbb06",
            "testCommandSha256": "1954f66a3170adc279d61f01a9715709f197cf930d96e42a838375aa74a1d9f0",
            "subjectAfterSha256": "e091f50cc1e90f13ef8731eab8208c09822131c5286f8cc9bc439b49b78a4482",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf"
          },
          "passed": 1,
          "failed": 0,
          "skipped": 67,
          "collectionFailed": false,
          "passedCaseTitles": [
            "session:assume durable transition boundaries > R-6 accepted requires later process and routed probe verification"
          ]
        },
        "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
        "worktreeDirty": false,
        "mutationFailureLines": [
          "session:assume durable transition boundaries > R-6 accepted requires later process and routed probe verification: (recorded failed assertion)"
        ],
        "mutationFailedCaseTitles": [
          "session:assume durable transition boundaries > R-6 accepted requires later process and routed probe verification"
        ]
      },
      "details": {
        "scope": "Premature handoff acceptance promoted to target-verified; named maintained R6 assertion catches this falsifier.",
        "testRun": {
          "id": 22097651,
          "source": "mutation-probe",
          "status": "fail",
          "filePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
          "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
          "finishedAt": "2026-10-26T02:25:12.400Z",
          "asCommitted": {
            "commitSha": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
            "repoPrefix": "",
            "measuredAtCommit": true
          },
          "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-3334d25de1-WiHngT",
          "mutationPhase": "mutant",
          "worktreeDirty": false,
          "recordedFilePath": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
          "harnessAttribution": "run"
        },
        "adequacy": {
          "outcome": "caught",
          "skipped": false,
          "executed": true,
          "targeted": "AUTO-BAR-R-6-P-001",
          "collected": true,
          "testCases": [
            "session:assume durable transition boundaries > R-6 accepted requires later process and routed probe verification"
          ],
          "testLayer": "unit",
          "pathReachable": true,
          "fixtureCalibrated": true,
          "oracleIndependent": true
        },
        "causalControls": {
          "mutantTestRunId": 22097651,
          "baselineTestRunId": 22097645,
          "copyBaselineTestRunId": 22097649
        },
        "measurementPin": {
          "files": [
            {
              "path": "packages/operator-core/lib/session-assume.ts",
              "repo": ".",
              "clean": true,
              "sha256": "89c35b1fccc44181d402615c57229afdd028a67433d02f165366907e6fdbefcf",
              "headBlob": "7997ef1b4f67084d629527caf8228282e83b115f",
              "dimension": "source"
            },
            {
              "path": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
              "repo": ".",
              "clean": true,
              "sha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
              "headBlob": "87b06f31f104f9292f859a88acfc3a7450d96010",
              "dimension": "test"
            },
            {
              "path": "packages/operator-core/lib/agent-tools/session/assume.test.ts",
              "repo": ".",
              "clean": true,
              "sha256": "48bc7cc0fff95544641eb1d5a0065b3e707dd9d80fd58eca89747f9593f53daf",
              "headBlob": "87b06f31f104f9292f859a88acfc3a7450d96010",
              "dimension": "fixture"
            }
          ],
          "repos": [
            {
              "head": "3334d25de11cb03a460abe2e6b6aa1b422db0095",
              "repo": ".",
              "gitlink": null
            }
          ],
          "schemaVersion": 1
        },
        "currentMeasurement": {
          "kind": "repo-files",
          "testPaths": [
            "packages/operator-core/lib/agent-tools/session/assume.test.ts"
          ],
          "sourcePaths": [
            "packages/operator-core/lib/session-assume.ts"
          ],
          "fixturePaths": [
            "packages/operator-core/lib/agent-tools/session/assume.test.ts"
          ],
          "schemaVersion": 1
        }
      },
      "observedAt": "2026-10-26T02:33:50.828Z",
      "bindingFingerprint": "9737fb51d330a40accd0be8e5b42598d4a3137b50c2e921ced5ecd753fadbc2b",
      "createdBy": "su-839a2783-00ac-4155-8ece-13caed560343",
      "createdAt": "2026-10-26T02:33:50.800Z",
      "serverMeasurement": {
        "status": "measured",
        "measuredDimensions": [
          "source",
          "test",
          "fixture"
        ],
        "measuredAtCommit": "b37b838d2fd2ce3ed3f1c912aedd80a780dba5cc",
        "current": {
          "planSlug": "agent-assume-identity-2026-10-23",
          "specId": "AUTO-BAR-R-6-P-001",
          "specRevision": 5,
          "specFingerprint": "1d5aea6062264366df1d44b436e12a2aa86ecc8e186ad18449b33a515de8b2fb",
          "evidenceKind": "mutation",
          "evidenceRef": "test-run 22097651 mutation-probe mutant fail packages/operator-core/lib/agent-tools/session/assume.test.ts @3334d25de11c",
          "sourceFingerprint": "sha256-file-set-v1:a73e077cfeac4afed974d760804d68bd066bb6088452bda961fee2970d621184",
          "testFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd",
          "fixtureFingerprint": "sha256-file-set-v1:a6f399c81073587d8f330ded7cd10e923d030bc1ec7dc55ee17e947f4a8753bd"
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
  "count": 9,
  "currentness": {
    "current": 9,
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
}
