---
rel_path: "audits/parked-agent-resumption-2026-10-09/r29-r30-r31-clean-mechanical-proof-20261025-424d5.json"
updated_at: 1792958538087
_body: "content"
---

{
  "at": "2026-10-25T20:02:18.054Z",
  "scope": "R29/R30/R31 tree unit mechanical adequacy only; no real-provider, live population, original116, R14 or whole-plan acceptance claim.",
  "preservation": [
    {
      "specId": "AUTO-BAR-R-29-P-004",
      "revision": 2,
      "active": true,
      "semanticFieldsExact": true
    },
    {
      "specId": "AUTO-BAR-R-30-P-004",
      "revision": 2,
      "active": true,
      "semanticFieldsExact": true
    },
    {
      "specId": "AUTO-BAR-R-31-P-004",
      "revision": 2,
      "active": true,
      "semanticFieldsExact": true
    }
  ],
  "original": {
    "ok": true,
    "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
    "harnessSlug": "papercusp",
    "specs": [
      {
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-29-P-004",
        "sourceValId": null,
        "currentRevision": 2,
        "revision": 1,
        "planItemId": "P-004",
        "behavior": "A Codex quota latch releases the next same-route recovery attempt when its stated reset becomes due.",
        "behaviorClass": "happy-path",
        "requiredEvidence": [
          "tree"
        ],
        "requiredTestLayers": [
          "unit"
        ],
        "mutationRequired": false,
        "lifecycleStatus": "draft",
        "supersedes": null,
        "exemption": null,
        "falsifier": {
          "observation": "The reset is due but the unchanged-route attempt remains indefinitely latched."
        },
        "contentHash": "193d37cf9677f42ca9393588ff5034d85e7a1dfcb5b294dd5572daf4a8b5c927",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-17T22:54:22.228Z",
        "acceptedBy": null,
        "acceptedAt": null,
        "acceptanceRef": "acceptance-parked-agent-census-resumption-and-root-cause-2026-10-09@9:R-29",
        "sourceBar": {
          "barKey": "R-29",
          "barHash": "597bcef8455574f234ba4d1ebbc8b9946f6db979cf3e6eef1a6fc06ed9e6087b",
          "barSetHash": "fa0600d29e77c05a36329aa052fe5f1d4cc5f5ba6430ef011f56dcaa3e1bc329",
          "rubricSlug": "acceptance-parked-agent-census-resumption-and-root-cause-2026-10-09",
          "rubricRevision": 9,
          "evidencePlane": "tree"
        }
      },
      {
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-30-P-004",
        "sourceValId": null,
        "currentRevision": 2,
        "revision": 1,
        "planItemId": "P-004",
        "behavior": "A latched Codex quota wall permits one deferred wake when its bounded backoff probe becomes due.",
        "behaviorClass": "happy-path",
        "requiredEvidence": [
          "tree"
        ],
        "requiredTestLayers": [
          "unit"
        ],
        "mutationRequired": false,
        "lifecycleStatus": "draft",
        "supersedes": null,
        "exemption": null,
        "falsifier": {
          "observation": "An early top-up cannot be discovered before the stated reset or more than one wake bypasses the same probe interval."
        },
        "contentHash": "af441b802791bcdcf5e5b4921a8ff6df446208f591220fdcb662721e1d5ed59c",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-17T22:54:22.228Z",
        "acceptedBy": null,
        "acceptedAt": null,
        "acceptanceRef": "acceptance-parked-agent-census-resumption-and-root-cause-2026-10-09@9:R-30",
        "sourceBar": {
          "barKey": "R-30",
          "barHash": "cfd44476dfc8a12af1d7cbb4c2a05f334b949968a8b4bf4930a5f5b34929f1a7",
          "barSetHash": "fa0600d29e77c05a36329aa052fe5f1d4cc5f5ba6430ef011f56dcaa3e1bc329",
          "rubricSlug": "acceptance-parked-agent-census-resumption-and-root-cause-2026-10-09",
          "rubricRevision": 9,
          "evidencePlane": "tree"
        }
      },
      {
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-31-P-004",
        "sourceValId": null,
        "currentRevision": 2,
        "revision": 1,
        "planItemId": "P-004",
        "behavior": "A still-walled Codex probe re-establishes the quota latch from its current provider response.",
        "behaviorClass": "happy-path",
        "requiredEvidence": [
          "tree"
        ],
        "requiredTestLayers": [
          "unit"
        ],
        "mutationRequired": false,
        "lifecycleStatus": "draft",
        "supersedes": null,
        "exemption": null,
        "falsifier": {
          "observation": "The failed probe leaves unlimited wake admission or retains an obsolete reset instead of re-latching."
        },
        "contentHash": "45b6238adbf1c31513deb3f946d8849e48a4edb53d96b44f3a4b0c29e12d08ce",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-17T22:54:22.228Z",
        "acceptedBy": null,
        "acceptedAt": null,
        "acceptanceRef": "acceptance-parked-agent-census-resumption-and-root-cause-2026-10-09@9:R-31",
        "sourceBar": {
          "barKey": "R-31",
          "barHash": "9a22c662c1b01cf304f6eb1dcc7dae5cd0baf10dab8dbf8cd0734c056cf8698d",
          "barSetHash": "fa0600d29e77c05a36329aa052fe5f1d4cc5f5ba6430ef011f56dcaa3e1bc329",
          "rubricSlug": "acceptance-parked-agent-census-resumption-and-root-cause-2026-10-09",
          "rubricRevision": 9,
          "evidencePlane": "tree"
        }
      }
    ],
    "count": 3,
    "mode": "exact-revision",
    "_meta": {
      "explicitFullRequest": true,
      "format": "json",
      "_seeAlso": [
        {
          "tool": "plans:set-specs (append a revision)"
        },
        {
          "tool": "plans:get-item (read the owning outcome)"
        }
      ]
    }
  },
  "current": {
    "ok": true,
    "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
    "harnessSlug": "papercusp",
    "specs": [
      {
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-29-P-004",
        "sourceValId": null,
        "currentRevision": 2,
        "revision": 2,
        "planItemId": "P-004",
        "behavior": "A Codex quota latch releases the next same-route recovery attempt when its stated reset becomes due.",
        "behaviorClass": "happy-path",
        "requiredEvidence": [
          "tree"
        ],
        "requiredTestLayers": [
          "unit"
        ],
        "mutationRequired": false,
        "lifecycleStatus": "active",
        "supersedes": null,
        "exemption": null,
        "falsifier": {
          "observation": "The reset is due but the unchanged-route attempt remains indefinitely latched."
        },
        "contentHash": "345a1ad9e86562f01a5ee167a035df2389252d6ee1535887734140f57efcabf8",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T19:59:56.635Z",
        "acceptedBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "acceptedAt": "2026-10-25T19:59:56.697Z",
        "acceptanceRef": "acceptance-parked-agent-census-resumption-and-root-cause-2026-10-09@9:R-29",
        "sourceBar": {
          "barKey": "R-29",
          "barHash": "597bcef8455574f234ba4d1ebbc8b9946f6db979cf3e6eef1a6fc06ed9e6087b",
          "barSetHash": "fa0600d29e77c05a36329aa052fe5f1d4cc5f5ba6430ef011f56dcaa3e1bc329",
          "rubricSlug": "acceptance-parked-agent-census-resumption-and-root-cause-2026-10-09",
          "rubricRevision": 9,
          "evidencePlane": "tree"
        }
      },
      {
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-30-P-004",
        "sourceValId": null,
        "currentRevision": 2,
        "revision": 2,
        "planItemId": "P-004",
        "behavior": "A latched Codex quota wall permits one deferred wake when its bounded backoff probe becomes due.",
        "behaviorClass": "happy-path",
        "requiredEvidence": [
          "tree"
        ],
        "requiredTestLayers": [
          "unit"
        ],
        "mutationRequired": false,
        "lifecycleStatus": "active",
        "supersedes": null,
        "exemption": null,
        "falsifier": {
          "observation": "An early top-up cannot be discovered before the stated reset or more than one wake bypasses the same probe interval."
        },
        "contentHash": "6080d96905e23778b8f88e854b6098a074d4f5520f7c0c28ed0d05081fcc64d8",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T19:59:56.635Z",
        "acceptedBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "acceptedAt": "2026-10-25T19:59:56.697Z",
        "acceptanceRef": "acceptance-parked-agent-census-resumption-and-root-cause-2026-10-09@9:R-30",
        "sourceBar": {
          "barKey": "R-30",
          "barHash": "cfd44476dfc8a12af1d7cbb4c2a05f334b949968a8b4bf4930a5f5b34929f1a7",
          "barSetHash": "fa0600d29e77c05a36329aa052fe5f1d4cc5f5ba6430ef011f56dcaa3e1bc329",
          "rubricSlug": "acceptance-parked-agent-census-resumption-and-root-cause-2026-10-09",
          "rubricRevision": 9,
          "evidencePlane": "tree"
        }
      },
      {
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-31-P-004",
        "sourceValId": null,
        "currentRevision": 2,
        "revision": 2,
        "planItemId": "P-004",
        "behavior": "A still-walled Codex probe re-establishes the quota latch from its current provider response.",
        "behaviorClass": "happy-path",
        "requiredEvidence": [
          "tree"
        ],
        "requiredTestLayers": [
          "unit"
        ],
        "mutationRequired": false,
        "lifecycleStatus": "active",
        "supersedes": null,
        "exemption": null,
        "falsifier": {
          "observation": "The failed probe leaves unlimited wake admission or retains an obsolete reset instead of re-latching."
        },
        "contentHash": "7b9bd2f889019dd0600054e90272dc9850a7af6dfdd774895c71b49224b05be7",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T20:01:54.173Z",
        "acceptedBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "acceptedAt": "2026-10-25T20:01:54.270Z",
        "acceptanceRef": "acceptance-parked-agent-census-resumption-and-root-cause-2026-10-09@9:R-31",
        "sourceBar": {
          "barKey": "R-31",
          "barHash": "9a22c662c1b01cf304f6eb1dcc7dae5cd0baf10dab8dbf8cd0734c056cf8698d",
          "barSetHash": "fa0600d29e77c05a36329aa052fe5f1d4cc5f5ba6430ef011f56dcaa3e1bc329",
          "rubricSlug": "acceptance-parked-agent-census-resumption-and-root-cause-2026-10-09",
          "rubricRevision": 9,
          "evidencePlane": "tree"
        }
      }
    ],
    "count": 3,
    "mode": "current",
    "_meta": {
      "explicitFullRequest": true,
      "format": "json",
      "_seeAlso": [
        {
          "tool": "plans:set-specs (append a revision)"
        },
        {
          "tool": "plans:get-item (read the owning outcome)"
        }
      ]
    }
  },
  "cert": {
    "ok": true,
    "dryRun": false,
    "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
    "evaluatorBuild": {
      "sha": "737afe8645",
      "version": "0.0.0"
    },
    "classRef": "plan-class-bugfix",
    "governing": true,
    "counts": {
      "clauses": 3,
      "passing": 3,
      "filed": 0,
      "unchanged": 0,
      "refused": 0,
      "notPassing": 0,
      "mechanicallyVerified": 3
    },
    "clauses": [
      {
        "specId": "AUTO-BAR-R-29-P-004",
        "specRevision": 2,
        "verdict": "pass",
        "wouldBlock": [],
        "measurementEvidence": {
          "status": "measured",
          "selectedBindings": 2,
          "measuredBindings": 2,
          "unavailableBindings": [],
          "withoutMeasurementBasis": [],
          "bindings": [
            {
              "bindingId": 70457,
              "evidenceKind": "test",
              "evidenceRef": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
              "status": "measured",
              "measuredAtCommit": "ce119f4c1de76803438457abc72cb464b2b7ac41",
              "measurementFingerprint": "sha256:f1081c548b566f66b145387d263ba4510ba596dfeee22fee6a107534daf80721"
            },
            {
              "bindingId": 70459,
              "evidenceKind": "mutation",
              "evidenceRef": "test-run 22056073 mutation-probe mutant fail apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts @0f9e16607008",
              "status": "measured",
              "measuredAtCommit": "ce119f4c1de76803438457abc72cb464b2b7ac41",
              "measurementFingerprint": "sha256:f1081c548b566f66b145387d263ba4510ba596dfeee22fee6a107534daf80721"
            }
          ]
        },
        "mechanicalProof": {
          "applicable": true,
          "verdict": "pass",
          "requiredFiles": [
            "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
          ],
          "passingTestBindingIds": {
            "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts": 70457
          },
          "caughtMutantBindingIds": [
            70459
          ],
          "gaps": []
        },
        "card": {
          "status": "not-required",
          "reason": "mechanical-test-adequacy"
        }
      },
      {
        "specId": "AUTO-BAR-R-30-P-004",
        "specRevision": 2,
        "verdict": "pass",
        "wouldBlock": [],
        "measurementEvidence": {
          "status": "measured",
          "selectedBindings": 2,
          "measuredBindings": 2,
          "unavailableBindings": [],
          "withoutMeasurementBasis": [],
          "bindings": [
            {
              "bindingId": 70456,
              "evidenceKind": "test",
              "evidenceRef": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
              "status": "measured",
              "measuredAtCommit": "ce119f4c1de76803438457abc72cb464b2b7ac41",
              "measurementFingerprint": "sha256:f1081c548b566f66b145387d263ba4510ba596dfeee22fee6a107534daf80721"
            },
            {
              "bindingId": 70458,
              "evidenceKind": "mutation",
              "evidenceRef": "test-run 22056235 mutation-probe mutant fail apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts @0f9e16607008",
              "status": "measured",
              "measuredAtCommit": "ce119f4c1de76803438457abc72cb464b2b7ac41",
              "measurementFingerprint": "sha256:f1081c548b566f66b145387d263ba4510ba596dfeee22fee6a107534daf80721"
            }
          ]
        },
        "mechanicalProof": {
          "applicable": true,
          "verdict": "pass",
          "requiredFiles": [
            "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
          ],
          "passingTestBindingIds": {
            "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts": 70456
          },
          "caughtMutantBindingIds": [
            70458
          ],
          "gaps": []
        },
        "card": {
          "status": "not-required",
          "reason": "mechanical-test-adequacy"
        }
      },
      {
        "specId": "AUTO-BAR-R-31-P-004",
        "specRevision": 2,
        "verdict": "pass",
        "wouldBlock": [],
        "measurementEvidence": {
          "status": "measured",
          "selectedBindings": 2,
          "measuredBindings": 2,
          "unavailableBindings": [],
          "withoutMeasurementBasis": [],
          "bindings": [
            {
              "bindingId": 70462,
              "evidenceKind": "test",
              "evidenceRef": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
              "status": "measured",
              "measuredAtCommit": "ce119f4c1de76803438457abc72cb464b2b7ac41",
              "measurementFingerprint": "sha256:f1081c548b566f66b145387d263ba4510ba596dfeee22fee6a107534daf80721"
            },
            {
              "bindingId": 70463,
              "evidenceKind": "mutation",
              "evidenceRef": "test-run 22057713 mutation-probe mutant fail apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts @0f9e16607008",
              "status": "measured",
              "measuredAtCommit": "ce119f4c1de76803438457abc72cb464b2b7ac41",
              "measurementFingerprint": "sha256:f1081c548b566f66b145387d263ba4510ba596dfeee22fee6a107534daf80721"
            }
          ]
        },
        "mechanicalProof": {
          "applicable": true,
          "verdict": "pass",
          "requiredFiles": [
            "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
          ],
          "passingTestBindingIds": {
            "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts": 70462
          },
          "caughtMutantBindingIds": [
            70463
          ],
          "gaps": []
        },
        "card": {
          "status": "not-required",
          "reason": "mechanical-test-adequacy"
        }
      }
    ],
    "completionReadiness": {
      "status": "not-checked",
      "note": "Certification can combine evidence from multiple work items. It does not establish that any work item can close. Supply completionWorkItemId to check the existing scoped completion gate."
    },
    "_meta": {
      "explicitFullRequest": true,
      "format": "json",
      "_seeAlso": [
        {
          "tool": "plans:evaluate-spec-test-adequacy"
        },
        {
          "tool": "scorecards:emit"
        }
      ]
    }
  },
  "evidence": {
    "ok": true,
    "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
    "harnessSlug": "papercusp",
    "bounded": {
      "limit": 200,
      "truncatedByLimit": false
    },
    "detail": "full",
    "evidence": [
      {
        "id": 70463,
        "workItemId": "WI-10008155",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-31-P-004",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "7b9bd2f889019dd0600054e90272dc9850a7af6dfdd774895c71b49224b05be7",
        "evidenceKind": "mutation",
        "evidenceRef": "test-run 22057713 mutation-probe mutant fail apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts @0f9e16607008",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:45c615733436912053f13f8608903c1bb3d178fd070ecf975592ebfd8ab9911b",
          "testFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
          "fixtureFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 22057713,
        "testRunExecution": {
          "status": "fail",
          "passed": 20,
          "failed": 1,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "passedCaseTitles": [],
          "testLayer": "unit",
          "passedCaseTitleCount": 20,
          "passedCaseTitlesOmitted": 20,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                22057713
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "framework": "vitest",
          "source": "mutation-probe",
          "mutationPhase": "mutant",
          "mutation": {
            "leg": "mutant",
            "mode": "copy-out",
            "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6835,7 +6835,7 @@\n       // The reset clause can arrive in a later chunk than the matched words,\n       // so keep trying until one parses. Parsed once: the text is static, and\n       // a relative \"in 2 hours\" re-read later would drift.\n-      if (hit.matched && resetAtMs == null) resetAtMs = parseQuotaResetAtMs(buffer, agent, now());\n+      if (hit.matched && resetAtMs == null && lastExpiryAtMs == null) resetAtMs = parseQuotaResetAtMs(buffer, agent, now());\n       if (hit.matched === blocked) return null;\n       blocked = hit.matched;\n       blockedSinceMs = blocked ? now() : null;\n",
            "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
            "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
            "mutateExpression": "s/if \\(hit.matched && resetAtMs == null\\) resetAtMs =/if (hit.matched \\&\\& resetAtMs == null \\&\\& lastExpiryAtMs == null) resetAtMs =/",
            "probeInvocationId": "8741124d-1097-455d-9b9f-4b29d3bbc04c",
            "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
            "subjectAfterSha256": "b4323cdb99aa9afe920db6f20ea7059598fb7fe2a694b433b2b9202f427289ba",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57"
          },
          "mutationBaseline": {
            "testRunId": 22057709,
            "status": "pass",
            "mutation": {
              "leg": "copy-baseline",
              "mode": "copy-out",
              "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6835,7 +6835,7 @@\n       // The reset clause can arrive in a later chunk than the matched words,\n       // so keep trying until one parses. Parsed once: the text is static, and\n       // a relative \"in 2 hours\" re-read later would drift.\n-      if (hit.matched && resetAtMs == null) resetAtMs = parseQuotaResetAtMs(buffer, agent, now());\n+      if (hit.matched && resetAtMs == null && lastExpiryAtMs == null) resetAtMs = parseQuotaResetAtMs(buffer, agent, now());\n       if (hit.matched === blocked) return null;\n       blocked = hit.matched;\n       blockedSinceMs = blocked ? now() : null;\n",
              "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
              "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
              "againstCommit": null,
              "schemaVersion": 1,
              "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
              "mutateExpression": "s/if \\(hit.matched && resetAtMs == null\\) resetAtMs =/if (hit.matched \\&\\& resetAtMs == null \\&\\& lastExpiryAtMs == null) resetAtMs =/",
              "probeInvocationId": "8741124d-1097-455d-9b9f-4b29d3bbc04c",
              "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
              "subjectAfterSha256": "b4323cdb99aa9afe920db6f20ea7059598fb7fe2a694b433b2b9202f427289ba",
              "mutantDiffTruncated": false,
              "subjectBeforeSha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57"
            },
            "passed": 21,
            "failed": 0,
            "skipped": 0,
            "collectionFailed": false,
            "passedCaseTitles": [
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
              "provider detector replay mode follows the replacement child > quota ignores resumed history after a fresh launch, then detects a fresh failure",
              "provider detector replay mode follows the replacement child > auth ignores resumed history after a fresh launch, then detects a fresh failure",
              "parseQuotaResetAtMs (WI-6554700010008412) > parses the incident copy as a local-time instant",
              "parseQuotaResetAtMs (WI-6554700010008412) > parses the clause after ANSI styling and terminal line wraps",
              "parseQuotaResetAtMs (WI-6554700010008412) > parses a relative duration from the moment it is read",
              "parseQuotaResetAtMs (WI-6554700010008412) > reads a bare time already past as tomorrow, and a yearless past date as next year",
              "parseQuotaResetAtMs (WI-6554700010008412) > uses the newest statement when the window holds an older wall too",
              "parseQuotaResetAtMs (WI-6554700010008412) > never returns a reset that is not in the future, and never parses other products",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle"
            ]
          },
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "worktreeDirty": false,
          "mutationFailureLines": [
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn: (recorded failed assertion)"
          ],
          "mutationFailedCaseTitles": [
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn"
          ]
        },
        "details": {
          "testRun": {
            "id": 22057713,
            "source": "mutation-probe",
            "status": "fail",
            "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
            "finishedAt": "2026-10-25T19:59:42.374Z",
            "asCommitted": {
              "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
            "mutationPhase": "mutant",
            "worktreeDirty": false,
            "recordedFilePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "caught",
            "skipped": false,
            "executed": true,
            "targeted": "auto-bar-r-31-p-004",
            "collected": true,
            "testCases": [
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn"
            ],
            "testLayer": "unit",
            "falsifiable": true,
            "fixtureFree": false,
            "coverageRungs": {
              "l4": true
            },
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "apps/operator/scripts/psu-pty-host.mjs",
                "repo": ".",
                "clean": true,
                "sha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57",
                "headBlob": "26cca304f05c7cc003704d7a90bdf4488d7ea08b",
                "dimension": "source"
              },
              {
                "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
                "headBlob": "ebd760b141c69bb216ab1ddf788e6ef3a9366c37",
                "dimension": "test"
              },
              {
                "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
                "headBlob": "ebd760b141c69bb216ab1ddf788e6ef3a9366c37",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "74c53ce381b22d79173fe0e96bf138be76c9f149",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            ],
            "sourcePaths": [
              "apps/operator/scripts/psu-pty-host.mjs"
            ],
            "fixturePaths": [
              "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-25T20:00:39.956Z",
        "bindingFingerprint": "cc98c44dacf205bb830943b154b012c9f21e45c322bcd562c0c9a4e973f97ef4",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T20:01:54.173Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "ce119f4c1de76803438457abc72cb464b2b7ac41",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-31-P-004",
            "specRevision": 2,
            "specFingerprint": "7b9bd2f889019dd0600054e90272dc9850a7af6dfdd774895c71b49224b05be7",
            "evidenceKind": "mutation",
            "evidenceRef": "test-run 22057713 mutation-probe mutant fail apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts @0f9e16607008",
            "sourceFingerprint": "sha256-file-set-v1:45c615733436912053f13f8608903c1bb3d178fd070ecf975592ebfd8ab9911b",
            "testFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
            "fixtureFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4"
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
        "id": 70461,
        "workItemId": "WI-10008155",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-31-P-004",
        "sourceValId": null,
        "specRevision": 1,
        "currentRevision": 2,
        "specFingerprint": "45b6238adbf1c31513deb3f946d8849e48a4edb53d96b44f3a4b0c29e12d08ce",
        "evidenceKind": "mutation",
        "evidenceRef": "test-run 22057713 mutation-probe mutant fail apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts @0f9e16607008",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:45c615733436912053f13f8608903c1bb3d178fd070ecf975592ebfd8ab9911b",
          "testFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
          "fixtureFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 22057713,
        "testRunExecution": {
          "status": "fail",
          "passed": 20,
          "failed": 1,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "passedCaseTitles": [],
          "testLayer": "unit",
          "passedCaseTitleCount": 20,
          "passedCaseTitlesOmitted": 20,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                22057713
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "framework": "vitest",
          "source": "mutation-probe",
          "mutationPhase": "mutant",
          "mutation": {
            "leg": "mutant",
            "mode": "copy-out",
            "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6835,7 +6835,7 @@\n       // The reset clause can arrive in a later chunk than the matched words,\n       // so keep trying until one parses. Parsed once: the text is static, and\n       // a relative \"in 2 hours\" re-read later would drift.\n-      if (hit.matched && resetAtMs == null) resetAtMs = parseQuotaResetAtMs(buffer, agent, now());\n+      if (hit.matched && resetAtMs == null && lastExpiryAtMs == null) resetAtMs = parseQuotaResetAtMs(buffer, agent, now());\n       if (hit.matched === blocked) return null;\n       blocked = hit.matched;\n       blockedSinceMs = blocked ? now() : null;\n",
            "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
            "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
            "mutateExpression": "s/if \\(hit.matched && resetAtMs == null\\) resetAtMs =/if (hit.matched \\&\\& resetAtMs == null \\&\\& lastExpiryAtMs == null) resetAtMs =/",
            "probeInvocationId": "8741124d-1097-455d-9b9f-4b29d3bbc04c",
            "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
            "subjectAfterSha256": "b4323cdb99aa9afe920db6f20ea7059598fb7fe2a694b433b2b9202f427289ba",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57"
          },
          "mutationBaseline": {
            "testRunId": 22057709,
            "status": "pass",
            "mutation": {
              "leg": "copy-baseline",
              "mode": "copy-out",
              "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6835,7 +6835,7 @@\n       // The reset clause can arrive in a later chunk than the matched words,\n       // so keep trying until one parses. Parsed once: the text is static, and\n       // a relative \"in 2 hours\" re-read later would drift.\n-      if (hit.matched && resetAtMs == null) resetAtMs = parseQuotaResetAtMs(buffer, agent, now());\n+      if (hit.matched && resetAtMs == null && lastExpiryAtMs == null) resetAtMs = parseQuotaResetAtMs(buffer, agent, now());\n       if (hit.matched === blocked) return null;\n       blocked = hit.matched;\n       blockedSinceMs = blocked ? now() : null;\n",
              "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
              "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
              "againstCommit": null,
              "schemaVersion": 1,
              "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
              "mutateExpression": "s/if \\(hit.matched && resetAtMs == null\\) resetAtMs =/if (hit.matched \\&\\& resetAtMs == null \\&\\& lastExpiryAtMs == null) resetAtMs =/",
              "probeInvocationId": "8741124d-1097-455d-9b9f-4b29d3bbc04c",
              "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
              "subjectAfterSha256": "b4323cdb99aa9afe920db6f20ea7059598fb7fe2a694b433b2b9202f427289ba",
              "mutantDiffTruncated": false,
              "subjectBeforeSha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57"
            },
            "passed": 21,
            "failed": 0,
            "skipped": 0,
            "collectionFailed": false,
            "passedCaseTitles": [
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
              "provider detector replay mode follows the replacement child > quota ignores resumed history after a fresh launch, then detects a fresh failure",
              "provider detector replay mode follows the replacement child > auth ignores resumed history after a fresh launch, then detects a fresh failure",
              "parseQuotaResetAtMs (WI-6554700010008412) > parses the incident copy as a local-time instant",
              "parseQuotaResetAtMs (WI-6554700010008412) > parses the clause after ANSI styling and terminal line wraps",
              "parseQuotaResetAtMs (WI-6554700010008412) > parses a relative duration from the moment it is read",
              "parseQuotaResetAtMs (WI-6554700010008412) > reads a bare time already past as tomorrow, and a yearless past date as next year",
              "parseQuotaResetAtMs (WI-6554700010008412) > uses the newest statement when the window holds an older wall too",
              "parseQuotaResetAtMs (WI-6554700010008412) > never returns a reset that is not in the future, and never parses other products",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle"
            ]
          },
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "worktreeDirty": false,
          "mutationFailureLines": [
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn: (recorded failed assertion)"
          ],
          "mutationFailedCaseTitles": [
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn"
          ]
        },
        "details": {
          "testRun": {
            "id": 22057713,
            "source": "mutation-probe",
            "status": "fail",
            "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
            "finishedAt": "2026-10-25T19:59:42.374Z",
            "asCommitted": {
              "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
            "mutationPhase": "mutant",
            "worktreeDirty": false,
            "recordedFilePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "caught",
            "skipped": false,
            "executed": true,
            "targeted": "auto-bar-r-31-p-004",
            "collected": true,
            "testCases": [
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn"
            ],
            "testLayer": "unit",
            "falsifiable": true,
            "fixtureFree": false,
            "coverageRungs": {
              "l4": true
            },
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "apps/operator/scripts/psu-pty-host.mjs",
                "repo": ".",
                "clean": true,
                "sha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57",
                "headBlob": "26cca304f05c7cc003704d7a90bdf4488d7ea08b",
                "dimension": "source"
              },
              {
                "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
                "headBlob": "ebd760b141c69bb216ab1ddf788e6ef3a9366c37",
                "dimension": "test"
              },
              {
                "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
                "headBlob": "ebd760b141c69bb216ab1ddf788e6ef3a9366c37",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "74c53ce381b22d79173fe0e96bf138be76c9f149",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            ],
            "sourcePaths": [
              "apps/operator/scripts/psu-pty-host.mjs"
            ],
            "fixturePaths": [
              "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-25T20:00:39.956Z",
        "bindingFingerprint": "e8a6828af54aec194cac016aa542114ea09f9ebd024781cbd07ac7f30a415e6e",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T20:00:39.946Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "ce119f4c1de76803438457abc72cb464b2b7ac41",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-31-P-004",
            "specRevision": 1,
            "specFingerprint": "45b6238adbf1c31513deb3f946d8849e48a4edb53d96b44f3a4b0c29e12d08ce",
            "evidenceKind": "mutation",
            "evidenceRef": "test-run 22057713 mutation-probe mutant fail apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts @0f9e16607008",
            "sourceFingerprint": "sha256-file-set-v1:45c615733436912053f13f8608903c1bb3d178fd070ecf975592ebfd8ab9911b",
            "testFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
            "fixtureFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4"
          }
        },
        "currentness": {
          "overall": "stale",
          "dimensions": {
            "spec": "stale",
            "source": "current",
            "test": "current",
            "fixture": "current",
            "rubric": "not-applicable",
            "environment": "not-applicable",
            "coverageEvidence": "not-applicable",
            "testRun": "current"
          },
          "staleReasons": [
            "spec-stale"
          ],
          "unknownReasons": [],
          "comparisonSupplied": true,
          "provenance": "server-measured"
        }
      },
      {
        "id": 70462,
        "workItemId": "WI-10008155",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-31-P-004",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "7b9bd2f889019dd0600054e90272dc9850a7af6dfdd774895c71b49224b05be7",
        "evidenceKind": "test",
        "evidenceRef": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:45c615733436912053f13f8608903c1bb3d178fd070ecf975592ebfd8ab9911b",
          "testFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
          "fixtureFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 22057691,
        "testRunExecution": {
          "status": "pass",
          "passed": 21,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "passedCaseTitles": [
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled"
          ],
          "testLayer": "unit",
          "passedCaseTitleCount": 21,
          "passedCaseTitlesOmitted": 18,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                22057691
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "framework": "vitest",
          "source": "mutation-probe",
          "mutationPhase": "baseline",
          "mutation": {
            "leg": "baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6835,7 +6835,7 @@\n       // The reset clause can arrive in a later chunk than the matched words,\n       // so keep trying until one parses. Parsed once: the text is static, and\n       // a relative \"in 2 hours\" re-read later would drift.\n-      if (hit.matched && resetAtMs == null) resetAtMs = parseQuotaResetAtMs(buffer, agent, now());\n+      if (hit.matched && resetAtMs == null && lastExpiryAtMs == null) resetAtMs = parseQuotaResetAtMs(buffer, agent, now());\n       if (hit.matched === blocked) return null;\n       blocked = hit.matched;\n       blockedSinceMs = blocked ? now() : null;\n",
            "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
            "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
            "mutateExpression": "s/if \\(hit.matched && resetAtMs == null\\) resetAtMs =/if (hit.matched \\&\\& resetAtMs == null \\&\\& lastExpiryAtMs == null) resetAtMs =/",
            "probeInvocationId": "8741124d-1097-455d-9b9f-4b29d3bbc04c",
            "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
            "subjectAfterSha256": "b4323cdb99aa9afe920db6f20ea7059598fb7fe2a694b433b2b9202f427289ba",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57"
          },
          "mutationBaseline": null,
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 22057691,
            "source": "mutation-probe",
            "status": "pass",
            "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
            "finishedAt": "2026-10-25T19:58:58.937Z",
            "asCommitted": {
              "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
            "mutationPhase": "baseline",
            "worktreeDirty": false,
            "recordedFilePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "auto-bar-r-31-p-004",
            "collected": true,
            "testCases": [
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)"
            ],
            "testLayer": "unit",
            "falsifiable": true,
            "fixtureFree": false,
            "coverageRungs": {
              "l4": true
            },
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "apps/operator/scripts/psu-pty-host.mjs",
                "repo": ".",
                "clean": true,
                "sha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57",
                "headBlob": "26cca304f05c7cc003704d7a90bdf4488d7ea08b",
                "dimension": "source"
              },
              {
                "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
                "headBlob": "ebd760b141c69bb216ab1ddf788e6ef3a9366c37",
                "dimension": "test"
              },
              {
                "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
                "headBlob": "ebd760b141c69bb216ab1ddf788e6ef3a9366c37",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "74c53ce381b22d79173fe0e96bf138be76c9f149",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            ],
            "sourcePaths": [
              "apps/operator/scripts/psu-pty-host.mjs"
            ],
            "fixturePaths": [
              "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-25T20:00:39.802Z",
        "bindingFingerprint": "39d5d30a0b5d363e29a262fa4b50ece45f8f0fbe2f9cbc3251de37da52d66e8a",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T20:01:54.173Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "ce119f4c1de76803438457abc72cb464b2b7ac41",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-31-P-004",
            "specRevision": 2,
            "specFingerprint": "7b9bd2f889019dd0600054e90272dc9850a7af6dfdd774895c71b49224b05be7",
            "evidenceKind": "test",
            "evidenceRef": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "sourceFingerprint": "sha256-file-set-v1:45c615733436912053f13f8608903c1bb3d178fd070ecf975592ebfd8ab9911b",
            "testFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
            "fixtureFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4"
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
        "id": 70460,
        "workItemId": "WI-10008155",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-31-P-004",
        "sourceValId": null,
        "specRevision": 1,
        "currentRevision": 2,
        "specFingerprint": "45b6238adbf1c31513deb3f946d8849e48a4edb53d96b44f3a4b0c29e12d08ce",
        "evidenceKind": "test",
        "evidenceRef": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:45c615733436912053f13f8608903c1bb3d178fd070ecf975592ebfd8ab9911b",
          "testFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
          "fixtureFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 22057691,
        "testRunExecution": {
          "status": "pass",
          "passed": 21,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "passedCaseTitles": [
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled"
          ],
          "testLayer": "unit",
          "passedCaseTitleCount": 21,
          "passedCaseTitlesOmitted": 18,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                22057691
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "framework": "vitest",
          "source": "mutation-probe",
          "mutationPhase": "baseline",
          "mutation": {
            "leg": "baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6835,7 +6835,7 @@\n       // The reset clause can arrive in a later chunk than the matched words,\n       // so keep trying until one parses. Parsed once: the text is static, and\n       // a relative \"in 2 hours\" re-read later would drift.\n-      if (hit.matched && resetAtMs == null) resetAtMs = parseQuotaResetAtMs(buffer, agent, now());\n+      if (hit.matched && resetAtMs == null && lastExpiryAtMs == null) resetAtMs = parseQuotaResetAtMs(buffer, agent, now());\n       if (hit.matched === blocked) return null;\n       blocked = hit.matched;\n       blockedSinceMs = blocked ? now() : null;\n",
            "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
            "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
            "mutateExpression": "s/if \\(hit.matched && resetAtMs == null\\) resetAtMs =/if (hit.matched \\&\\& resetAtMs == null \\&\\& lastExpiryAtMs == null) resetAtMs =/",
            "probeInvocationId": "8741124d-1097-455d-9b9f-4b29d3bbc04c",
            "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
            "subjectAfterSha256": "b4323cdb99aa9afe920db6f20ea7059598fb7fe2a694b433b2b9202f427289ba",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57"
          },
          "mutationBaseline": null,
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 22057691,
            "source": "mutation-probe",
            "status": "pass",
            "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
            "finishedAt": "2026-10-25T19:58:58.937Z",
            "asCommitted": {
              "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
            "mutationPhase": "baseline",
            "worktreeDirty": false,
            "recordedFilePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "auto-bar-r-31-p-004",
            "collected": true,
            "testCases": [
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)"
            ],
            "testLayer": "unit",
            "falsifiable": true,
            "fixtureFree": false,
            "coverageRungs": {
              "l4": true
            },
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "apps/operator/scripts/psu-pty-host.mjs",
                "repo": ".",
                "clean": true,
                "sha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57",
                "headBlob": "26cca304f05c7cc003704d7a90bdf4488d7ea08b",
                "dimension": "source"
              },
              {
                "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
                "headBlob": "ebd760b141c69bb216ab1ddf788e6ef3a9366c37",
                "dimension": "test"
              },
              {
                "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
                "headBlob": "ebd760b141c69bb216ab1ddf788e6ef3a9366c37",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "74c53ce381b22d79173fe0e96bf138be76c9f149",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            ],
            "sourcePaths": [
              "apps/operator/scripts/psu-pty-host.mjs"
            ],
            "fixturePaths": [
              "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-25T20:00:39.802Z",
        "bindingFingerprint": "8df8c2b588709b75f7cb412d7ec1e7412fa03cb8aea61a72ba81f76106feed60",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T20:00:39.787Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "ce119f4c1de76803438457abc72cb464b2b7ac41",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-31-P-004",
            "specRevision": 1,
            "specFingerprint": "45b6238adbf1c31513deb3f946d8849e48a4edb53d96b44f3a4b0c29e12d08ce",
            "evidenceKind": "test",
            "evidenceRef": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "sourceFingerprint": "sha256-file-set-v1:45c615733436912053f13f8608903c1bb3d178fd070ecf975592ebfd8ab9911b",
            "testFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
            "fixtureFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4"
          }
        },
        "currentness": {
          "overall": "stale",
          "dimensions": {
            "spec": "stale",
            "source": "current",
            "test": "current",
            "fixture": "current",
            "rubric": "not-applicable",
            "environment": "not-applicable",
            "coverageEvidence": "not-applicable",
            "testRun": "current"
          },
          "staleReasons": [
            "spec-stale"
          ],
          "unknownReasons": [],
          "comparisonSupplied": true,
          "provenance": "server-measured"
        }
      },
      {
        "id": 70458,
        "workItemId": "WI-10008155",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-30-P-004",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "6080d96905e23778b8f88e854b6098a074d4f5520f7c0c28ed0d05081fcc64d8",
        "evidenceKind": "mutation",
        "evidenceRef": "test-run 22056235 mutation-probe mutant fail apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts @0f9e16607008",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:45c615733436912053f13f8608903c1bb3d178fd070ecf975592ebfd8ab9911b",
          "testFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
          "fixtureFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 22056235,
        "testRunExecution": {
          "status": "fail",
          "passed": 19,
          "failed": 2,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "passedCaseTitles": [],
          "testLayer": "unit",
          "passedCaseTitleCount": 19,
          "passedCaseTitlesOmitted": 19,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                22056235
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "framework": "vitest",
          "source": "mutation-probe",
          "mutationPhase": "mutant",
          "mutation": {
            "leg": "mutant",
            "mode": "copy-out",
            "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6766,7 +6766,7 @@\n     const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs + resetGraceMs;\n     // A non-finite base disables probing (the cap must not re-enable it).\n     const probeMs = Number.isFinite(probeBaseMs) ? Math.min(probeBaseMs * 2 ** probes, probeMaxMs) : Infinity;\n-    const dueProbe = blocked && !dueReset && probing && blockedSinceMs != null &&\n+    const dueProbe = false && !dueReset && probing && blockedSinceMs != null &&\n       Number.isFinite(probeMs) && expiryAt >= blockedSinceMs + probeMs;\n     if (dueReset || dueProbe) {\n       const expired = {\n",
            "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
            "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
            "mutateExpression": "s/const dueProbe = blocked && !dueReset && probing/const dueProbe = false \\&\\& !dueReset \\&\\& probing/",
            "probeInvocationId": "cc2a5193-9c84-4bbe-989a-0be5dff5c4ab",
            "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
            "subjectAfterSha256": "293b912714af72fbc27ca1ad447e3660d1825a2323cca987f4959bdd8300247a",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57"
          },
          "mutationBaseline": {
            "testRunId": 22056231,
            "status": "pass",
            "mutation": {
              "leg": "copy-baseline",
              "mode": "copy-out",
              "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6766,7 +6766,7 @@\n     const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs + resetGraceMs;\n     // A non-finite base disables probing (the cap must not re-enable it).\n     const probeMs = Number.isFinite(probeBaseMs) ? Math.min(probeBaseMs * 2 ** probes, probeMaxMs) : Infinity;\n-    const dueProbe = blocked && !dueReset && probing && blockedSinceMs != null &&\n+    const dueProbe = false && !dueReset && probing && blockedSinceMs != null &&\n       Number.isFinite(probeMs) && expiryAt >= blockedSinceMs + probeMs;\n     if (dueReset || dueProbe) {\n       const expired = {\n",
              "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
              "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
              "againstCommit": null,
              "schemaVersion": 1,
              "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
              "mutateExpression": "s/const dueProbe = blocked && !dueReset && probing/const dueProbe = false \\&\\& !dueReset \\&\\& probing/",
              "probeInvocationId": "cc2a5193-9c84-4bbe-989a-0be5dff5c4ab",
              "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
              "subjectAfterSha256": "293b912714af72fbc27ca1ad447e3660d1825a2323cca987f4959bdd8300247a",
              "mutantDiffTruncated": false,
              "subjectBeforeSha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57"
            },
            "passed": 21,
            "failed": 0,
            "skipped": 0,
            "collectionFailed": false,
            "passedCaseTitles": [
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
              "provider detector replay mode follows the replacement child > quota ignores resumed history after a fresh launch, then detects a fresh failure",
              "provider detector replay mode follows the replacement child > auth ignores resumed history after a fresh launch, then detects a fresh failure",
              "parseQuotaResetAtMs (WI-6554700010008412) > parses the incident copy as a local-time instant",
              "parseQuotaResetAtMs (WI-6554700010008412) > parses the clause after ANSI styling and terminal line wraps",
              "parseQuotaResetAtMs (WI-6554700010008412) > parses a relative duration from the moment it is read",
              "parseQuotaResetAtMs (WI-6554700010008412) > reads a bare time already past as tomorrow, and a yearless past date as next year",
              "parseQuotaResetAtMs (WI-6554700010008412) > uses the newest statement when the window holds an older wall too",
              "parseQuotaResetAtMs (WI-6554700010008412) > never returns a reset that is not in the future, and never parses other products",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle"
            ]
          },
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "worktreeDirty": false,
          "mutationFailureLines": [
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled: (recorded failed assertion)",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe: (recorded failed assertion)"
          ],
          "mutationFailedCaseTitles": [
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe"
          ]
        },
        "details": {
          "testRun": {
            "id": 22056235,
            "source": "mutation-probe",
            "status": "fail",
            "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
            "finishedAt": "2026-10-25T19:43:25.377Z",
            "asCommitted": {
              "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
            "mutationPhase": "mutant",
            "worktreeDirty": false,
            "recordedFilePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "caught",
            "skipped": false,
            "executed": true,
            "targeted": "auto-bar-r-30-p-004",
            "collected": true,
            "testCases": [
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe"
            ],
            "testLayer": "unit",
            "falsifiable": true,
            "fixtureFree": false,
            "coverageRungs": {
              "l4": true
            },
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "apps/operator/scripts/psu-pty-host.mjs",
                "repo": ".",
                "clean": true,
                "sha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57",
                "headBlob": "26cca304f05c7cc003704d7a90bdf4488d7ea08b",
                "dimension": "source"
              },
              {
                "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
                "headBlob": "ebd760b141c69bb216ab1ddf788e6ef3a9366c37",
                "dimension": "test"
              },
              {
                "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
                "headBlob": "ebd760b141c69bb216ab1ddf788e6ef3a9366c37",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "075342a0f10ffffb8cfa38f5a0de1287d1d6577a",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            ],
            "sourcePaths": [
              "apps/operator/scripts/psu-pty-host.mjs"
            ],
            "fixturePaths": [
              "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-25T19:55:38.533Z",
        "bindingFingerprint": "ac7ca9454ea4161096ead51b30a7f98c9521d949ffae8d62380893b2995776ea",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T19:59:56.635Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "ce119f4c1de76803438457abc72cb464b2b7ac41",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-30-P-004",
            "specRevision": 2,
            "specFingerprint": "6080d96905e23778b8f88e854b6098a074d4f5520f7c0c28ed0d05081fcc64d8",
            "evidenceKind": "mutation",
            "evidenceRef": "test-run 22056235 mutation-probe mutant fail apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts @0f9e16607008",
            "sourceFingerprint": "sha256-file-set-v1:45c615733436912053f13f8608903c1bb3d178fd070ecf975592ebfd8ab9911b",
            "testFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
            "fixtureFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4"
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
        "id": 70455,
        "workItemId": "WI-10008155",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-30-P-004",
        "sourceValId": null,
        "specRevision": 1,
        "currentRevision": 2,
        "specFingerprint": "af441b802791bcdcf5e5b4921a8ff6df446208f591220fdcb662721e1d5ed59c",
        "evidenceKind": "mutation",
        "evidenceRef": "test-run 22056235 mutation-probe mutant fail apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts @0f9e16607008",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:45c615733436912053f13f8608903c1bb3d178fd070ecf975592ebfd8ab9911b",
          "testFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
          "fixtureFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 22056235,
        "testRunExecution": {
          "status": "fail",
          "passed": 19,
          "failed": 2,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "passedCaseTitles": [],
          "testLayer": "unit",
          "passedCaseTitleCount": 19,
          "passedCaseTitlesOmitted": 19,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                22056235
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "framework": "vitest",
          "source": "mutation-probe",
          "mutationPhase": "mutant",
          "mutation": {
            "leg": "mutant",
            "mode": "copy-out",
            "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6766,7 +6766,7 @@\n     const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs + resetGraceMs;\n     // A non-finite base disables probing (the cap must not re-enable it).\n     const probeMs = Number.isFinite(probeBaseMs) ? Math.min(probeBaseMs * 2 ** probes, probeMaxMs) : Infinity;\n-    const dueProbe = blocked && !dueReset && probing && blockedSinceMs != null &&\n+    const dueProbe = false && !dueReset && probing && blockedSinceMs != null &&\n       Number.isFinite(probeMs) && expiryAt >= blockedSinceMs + probeMs;\n     if (dueReset || dueProbe) {\n       const expired = {\n",
            "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
            "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
            "mutateExpression": "s/const dueProbe = blocked && !dueReset && probing/const dueProbe = false \\&\\& !dueReset \\&\\& probing/",
            "probeInvocationId": "cc2a5193-9c84-4bbe-989a-0be5dff5c4ab",
            "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
            "subjectAfterSha256": "293b912714af72fbc27ca1ad447e3660d1825a2323cca987f4959bdd8300247a",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57"
          },
          "mutationBaseline": {
            "testRunId": 22056231,
            "status": "pass",
            "mutation": {
              "leg": "copy-baseline",
              "mode": "copy-out",
              "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6766,7 +6766,7 @@\n     const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs + resetGraceMs;\n     // A non-finite base disables probing (the cap must not re-enable it).\n     const probeMs = Number.isFinite(probeBaseMs) ? Math.min(probeBaseMs * 2 ** probes, probeMaxMs) : Infinity;\n-    const dueProbe = blocked && !dueReset && probing && blockedSinceMs != null &&\n+    const dueProbe = false && !dueReset && probing && blockedSinceMs != null &&\n       Number.isFinite(probeMs) && expiryAt >= blockedSinceMs + probeMs;\n     if (dueReset || dueProbe) {\n       const expired = {\n",
              "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
              "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
              "againstCommit": null,
              "schemaVersion": 1,
              "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
              "mutateExpression": "s/const dueProbe = blocked && !dueReset && probing/const dueProbe = false \\&\\& !dueReset \\&\\& probing/",
              "probeInvocationId": "cc2a5193-9c84-4bbe-989a-0be5dff5c4ab",
              "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
              "subjectAfterSha256": "293b912714af72fbc27ca1ad447e3660d1825a2323cca987f4959bdd8300247a",
              "mutantDiffTruncated": false,
              "subjectBeforeSha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57"
            },
            "passed": 21,
            "failed": 0,
            "skipped": 0,
            "collectionFailed": false,
            "passedCaseTitles": [
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
              "provider detector replay mode follows the replacement child > quota ignores resumed history after a fresh launch, then detects a fresh failure",
              "provider detector replay mode follows the replacement child > auth ignores resumed history after a fresh launch, then detects a fresh failure",
              "parseQuotaResetAtMs (WI-6554700010008412) > parses the incident copy as a local-time instant",
              "parseQuotaResetAtMs (WI-6554700010008412) > parses the clause after ANSI styling and terminal line wraps",
              "parseQuotaResetAtMs (WI-6554700010008412) > parses a relative duration from the moment it is read",
              "parseQuotaResetAtMs (WI-6554700010008412) > reads a bare time already past as tomorrow, and a yearless past date as next year",
              "parseQuotaResetAtMs (WI-6554700010008412) > uses the newest statement when the window holds an older wall too",
              "parseQuotaResetAtMs (WI-6554700010008412) > never returns a reset that is not in the future, and never parses other products",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle"
            ]
          },
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "worktreeDirty": false,
          "mutationFailureLines": [
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled: (recorded failed assertion)",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe: (recorded failed assertion)"
          ],
          "mutationFailedCaseTitles": [
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe"
          ]
        },
        "details": {
          "testRun": {
            "id": 22056235,
            "source": "mutation-probe",
            "status": "fail",
            "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
            "finishedAt": "2026-10-25T19:43:25.377Z",
            "asCommitted": {
              "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
            "mutationPhase": "mutant",
            "worktreeDirty": false,
            "recordedFilePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "caught",
            "skipped": false,
            "executed": true,
            "targeted": "auto-bar-r-30-p-004",
            "collected": true,
            "testCases": [
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe"
            ],
            "testLayer": "unit",
            "falsifiable": true,
            "fixtureFree": false,
            "coverageRungs": {
              "l4": true
            },
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "apps/operator/scripts/psu-pty-host.mjs",
                "repo": ".",
                "clean": true,
                "sha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57",
                "headBlob": "26cca304f05c7cc003704d7a90bdf4488d7ea08b",
                "dimension": "source"
              },
              {
                "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
                "headBlob": "ebd760b141c69bb216ab1ddf788e6ef3a9366c37",
                "dimension": "test"
              },
              {
                "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
                "headBlob": "ebd760b141c69bb216ab1ddf788e6ef3a9366c37",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "075342a0f10ffffb8cfa38f5a0de1287d1d6577a",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            ],
            "sourcePaths": [
              "apps/operator/scripts/psu-pty-host.mjs"
            ],
            "fixturePaths": [
              "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-25T19:55:38.533Z",
        "bindingFingerprint": "ac9667a6a6c8ac7fce29dba451adc3119cf9fbd1de903c761544138ab3550ba8",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T19:55:38.503Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "ce119f4c1de76803438457abc72cb464b2b7ac41",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-30-P-004",
            "specRevision": 1,
            "specFingerprint": "af441b802791bcdcf5e5b4921a8ff6df446208f591220fdcb662721e1d5ed59c",
            "evidenceKind": "mutation",
            "evidenceRef": "test-run 22056235 mutation-probe mutant fail apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts @0f9e16607008",
            "sourceFingerprint": "sha256-file-set-v1:45c615733436912053f13f8608903c1bb3d178fd070ecf975592ebfd8ab9911b",
            "testFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
            "fixtureFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4"
          }
        },
        "currentness": {
          "overall": "stale",
          "dimensions": {
            "spec": "stale",
            "source": "current",
            "test": "current",
            "fixture": "current",
            "rubric": "not-applicable",
            "environment": "not-applicable",
            "coverageEvidence": "not-applicable",
            "testRun": "current"
          },
          "staleReasons": [
            "spec-stale"
          ],
          "unknownReasons": [],
          "comparisonSupplied": true,
          "provenance": "server-measured"
        }
      },
      {
        "id": 70456,
        "workItemId": "WI-10008155",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-30-P-004",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "6080d96905e23778b8f88e854b6098a074d4f5520f7c0c28ed0d05081fcc64d8",
        "evidenceKind": "test",
        "evidenceRef": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:45c615733436912053f13f8608903c1bb3d178fd070ecf975592ebfd8ab9911b",
          "testFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
          "fixtureFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 22056230,
        "testRunExecution": {
          "status": "pass",
          "passed": 21,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "passedCaseTitles": [
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)"
          ],
          "testLayer": "unit",
          "passedCaseTitleCount": 21,
          "passedCaseTitlesOmitted": 18,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                22056230
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "framework": "vitest",
          "source": "mutation-probe",
          "mutationPhase": "baseline",
          "mutation": {
            "leg": "baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6766,7 +6766,7 @@\n     const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs + resetGraceMs;\n     // A non-finite base disables probing (the cap must not re-enable it).\n     const probeMs = Number.isFinite(probeBaseMs) ? Math.min(probeBaseMs * 2 ** probes, probeMaxMs) : Infinity;\n-    const dueProbe = blocked && !dueReset && probing && blockedSinceMs != null &&\n+    const dueProbe = false && !dueReset && probing && blockedSinceMs != null &&\n       Number.isFinite(probeMs) && expiryAt >= blockedSinceMs + probeMs;\n     if (dueReset || dueProbe) {\n       const expired = {\n",
            "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
            "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
            "mutateExpression": "s/const dueProbe = blocked && !dueReset && probing/const dueProbe = false \\&\\& !dueReset \\&\\& probing/",
            "probeInvocationId": "cc2a5193-9c84-4bbe-989a-0be5dff5c4ab",
            "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
            "subjectAfterSha256": "293b912714af72fbc27ca1ad447e3660d1825a2323cca987f4959bdd8300247a",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57"
          },
          "mutationBaseline": null,
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 22056230,
            "source": "mutation-probe",
            "status": "pass",
            "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
            "finishedAt": "2026-10-25T19:42:39.894Z",
            "asCommitted": {
              "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
            "mutationPhase": "baseline",
            "worktreeDirty": false,
            "recordedFilePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "auto-bar-r-30-p-004",
            "collected": true,
            "testCases": [
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)"
            ],
            "testLayer": "unit",
            "falsifiable": true,
            "fixtureFree": false,
            "coverageRungs": {
              "l4": true
            },
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "apps/operator/scripts/psu-pty-host.mjs",
                "repo": ".",
                "clean": true,
                "sha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57",
                "headBlob": "26cca304f05c7cc003704d7a90bdf4488d7ea08b",
                "dimension": "source"
              },
              {
                "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
                "headBlob": "ebd760b141c69bb216ab1ddf788e6ef3a9366c37",
                "dimension": "test"
              },
              {
                "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
                "headBlob": "ebd760b141c69bb216ab1ddf788e6ef3a9366c37",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "075342a0f10ffffb8cfa38f5a0de1287d1d6577a",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            ],
            "sourcePaths": [
              "apps/operator/scripts/psu-pty-host.mjs"
            ],
            "fixturePaths": [
              "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-25T19:55:38.326Z",
        "bindingFingerprint": "bbc23a6f4950d0c70c852d874c253353118b0524864f5b81deed44635ca28f73",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T19:59:56.635Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "ce119f4c1de76803438457abc72cb464b2b7ac41",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-30-P-004",
            "specRevision": 2,
            "specFingerprint": "6080d96905e23778b8f88e854b6098a074d4f5520f7c0c28ed0d05081fcc64d8",
            "evidenceKind": "test",
            "evidenceRef": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "sourceFingerprint": "sha256-file-set-v1:45c615733436912053f13f8608903c1bb3d178fd070ecf975592ebfd8ab9911b",
            "testFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
            "fixtureFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4"
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
        "id": 70454,
        "workItemId": "WI-10008155",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-30-P-004",
        "sourceValId": null,
        "specRevision": 1,
        "currentRevision": 2,
        "specFingerprint": "af441b802791bcdcf5e5b4921a8ff6df446208f591220fdcb662721e1d5ed59c",
        "evidenceKind": "test",
        "evidenceRef": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:45c615733436912053f13f8608903c1bb3d178fd070ecf975592ebfd8ab9911b",
          "testFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
          "fixtureFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 22056230,
        "testRunExecution": {
          "status": "pass",
          "passed": 21,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "passedCaseTitles": [
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)"
          ],
          "testLayer": "unit",
          "passedCaseTitleCount": 21,
          "passedCaseTitlesOmitted": 18,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                22056230
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "framework": "vitest",
          "source": "mutation-probe",
          "mutationPhase": "baseline",
          "mutation": {
            "leg": "baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6766,7 +6766,7 @@\n     const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs + resetGraceMs;\n     // A non-finite base disables probing (the cap must not re-enable it).\n     const probeMs = Number.isFinite(probeBaseMs) ? Math.min(probeBaseMs * 2 ** probes, probeMaxMs) : Infinity;\n-    const dueProbe = blocked && !dueReset && probing && blockedSinceMs != null &&\n+    const dueProbe = false && !dueReset && probing && blockedSinceMs != null &&\n       Number.isFinite(probeMs) && expiryAt >= blockedSinceMs + probeMs;\n     if (dueReset || dueProbe) {\n       const expired = {\n",
            "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
            "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
            "mutateExpression": "s/const dueProbe = blocked && !dueReset && probing/const dueProbe = false \\&\\& !dueReset \\&\\& probing/",
            "probeInvocationId": "cc2a5193-9c84-4bbe-989a-0be5dff5c4ab",
            "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
            "subjectAfterSha256": "293b912714af72fbc27ca1ad447e3660d1825a2323cca987f4959bdd8300247a",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57"
          },
          "mutationBaseline": null,
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 22056230,
            "source": "mutation-probe",
            "status": "pass",
            "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
            "finishedAt": "2026-10-25T19:42:39.894Z",
            "asCommitted": {
              "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
            "mutationPhase": "baseline",
            "worktreeDirty": false,
            "recordedFilePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "auto-bar-r-30-p-004",
            "collected": true,
            "testCases": [
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)"
            ],
            "testLayer": "unit",
            "falsifiable": true,
            "fixtureFree": false,
            "coverageRungs": {
              "l4": true
            },
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "apps/operator/scripts/psu-pty-host.mjs",
                "repo": ".",
                "clean": true,
                "sha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57",
                "headBlob": "26cca304f05c7cc003704d7a90bdf4488d7ea08b",
                "dimension": "source"
              },
              {
                "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
                "headBlob": "ebd760b141c69bb216ab1ddf788e6ef3a9366c37",
                "dimension": "test"
              },
              {
                "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
                "headBlob": "ebd760b141c69bb216ab1ddf788e6ef3a9366c37",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "075342a0f10ffffb8cfa38f5a0de1287d1d6577a",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            ],
            "sourcePaths": [
              "apps/operator/scripts/psu-pty-host.mjs"
            ],
            "fixturePaths": [
              "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-25T19:55:38.326Z",
        "bindingFingerprint": "ae2b0a67ab8753c83cb546db238f2e08788f03d8761682bd3bbafff61da5b37e",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T19:55:38.301Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "ce119f4c1de76803438457abc72cb464b2b7ac41",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-30-P-004",
            "specRevision": 1,
            "specFingerprint": "af441b802791bcdcf5e5b4921a8ff6df446208f591220fdcb662721e1d5ed59c",
            "evidenceKind": "test",
            "evidenceRef": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "sourceFingerprint": "sha256-file-set-v1:45c615733436912053f13f8608903c1bb3d178fd070ecf975592ebfd8ab9911b",
            "testFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
            "fixtureFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4"
          }
        },
        "currentness": {
          "overall": "stale",
          "dimensions": {
            "spec": "stale",
            "source": "current",
            "test": "current",
            "fixture": "current",
            "rubric": "not-applicable",
            "environment": "not-applicable",
            "coverageEvidence": "not-applicable",
            "testRun": "current"
          },
          "staleReasons": [
            "spec-stale"
          ],
          "unknownReasons": [],
          "comparisonSupplied": true,
          "provenance": "server-measured"
        }
      },
      {
        "id": 70459,
        "workItemId": "WI-10008155",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-29-P-004",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "345a1ad9e86562f01a5ee167a035df2389252d6ee1535887734140f57efcabf8",
        "evidenceKind": "mutation",
        "evidenceRef": "test-run 22056073 mutation-probe mutant fail apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts @0f9e16607008",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:45c615733436912053f13f8608903c1bb3d178fd070ecf975592ebfd8ab9911b",
          "testFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
          "fixtureFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 22056073,
        "testRunExecution": {
          "status": "fail",
          "passed": 19,
          "failed": 2,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "passedCaseTitles": [],
          "testLayer": "unit",
          "passedCaseTitleCount": 19,
          "passedCaseTitlesOmitted": 19,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                22056073
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "framework": "vitest",
          "source": "mutation-probe",
          "mutationPhase": "mutant",
          "mutation": {
            "leg": "mutant",
            "mode": "copy-out",
            "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6763,7 +6763,7 @@\n     // same static bytes cannot re-latch it; a wall that is still up repaints a\n     // fresh banner on the next turn and latches again with its new reset.\n     const expiryAt = blocked ? now() : 0;\n-    const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs + resetGraceMs;\n+    const dueReset = false;\n     // A non-finite base disables probing (the cap must not re-enable it).\n     const probeMs = Number.isFinite(probeBaseMs) ? Math.min(probeBaseMs * 2 ** probes, probeMaxMs) : Infinity;\n     const dueProbe = blocked && !dueReset && probing && blockedSinceMs != null &&\n",
            "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
            "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
            "mutateExpression": "s/const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs \\+ resetGraceMs;/const dueReset = false;/",
            "probeInvocationId": "a2c7ec8d-753a-45a8-bc82-33cbb87751e3",
            "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
            "subjectAfterSha256": "0ed1b7b10e89dd5635fa47eeb48f66235a43881d6e689941fc5b65254cb30abc",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57"
          },
          "mutationBaseline": {
            "testRunId": 22055502,
            "status": "pass",
            "mutation": {
              "leg": "copy-baseline",
              "mode": "copy-out",
              "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6763,7 +6763,7 @@\n     // same static bytes cannot re-latch it; a wall that is still up repaints a\n     // fresh banner on the next turn and latches again with its new reset.\n     const expiryAt = blocked ? now() : 0;\n-    const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs + resetGraceMs;\n+    const dueReset = false;\n     // A non-finite base disables probing (the cap must not re-enable it).\n     const probeMs = Number.isFinite(probeBaseMs) ? Math.min(probeBaseMs * 2 ** probes, probeMaxMs) : Infinity;\n     const dueProbe = blocked && !dueReset && probing && blockedSinceMs != null &&\n",
              "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
              "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
              "againstCommit": null,
              "schemaVersion": 1,
              "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
              "mutateExpression": "s/const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs \\+ resetGraceMs;/const dueReset = false;/",
              "probeInvocationId": "a2c7ec8d-753a-45a8-bc82-33cbb87751e3",
              "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
              "subjectAfterSha256": "0ed1b7b10e89dd5635fa47eeb48f66235a43881d6e689941fc5b65254cb30abc",
              "mutantDiffTruncated": false,
              "subjectBeforeSha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57"
            },
            "passed": 21,
            "failed": 0,
            "skipped": 0,
            "collectionFailed": false,
            "passedCaseTitles": [
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
              "provider detector replay mode follows the replacement child > quota ignores resumed history after a fresh launch, then detects a fresh failure",
              "provider detector replay mode follows the replacement child > auth ignores resumed history after a fresh launch, then detects a fresh failure",
              "parseQuotaResetAtMs (WI-6554700010008412) > parses the incident copy as a local-time instant",
              "parseQuotaResetAtMs (WI-6554700010008412) > parses the clause after ANSI styling and terminal line wraps",
              "parseQuotaResetAtMs (WI-6554700010008412) > parses a relative duration from the moment it is read",
              "parseQuotaResetAtMs (WI-6554700010008412) > reads a bare time already past as tomorrow, and a yearless past date as next year",
              "parseQuotaResetAtMs (WI-6554700010008412) > uses the newest statement when the window holds an older wall too",
              "parseQuotaResetAtMs (WI-6554700010008412) > never returns a reset that is not in the future, and never parses other products",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle"
            ]
          },
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "worktreeDirty": false,
          "mutationFailureLines": [
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once: (recorded failed assertion)",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn: (recorded failed assertion)"
          ],
          "mutationFailedCaseTitles": [
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn"
          ]
        },
        "details": {
          "testRun": {
            "id": 22056073,
            "source": "mutation-probe",
            "status": "fail",
            "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
            "finishedAt": "2026-10-25T19:41:44.233Z",
            "asCommitted": {
              "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
            "mutationPhase": "mutant",
            "worktreeDirty": false,
            "recordedFilePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "caught",
            "skipped": false,
            "executed": true,
            "targeted": "auto-bar-r-29-p-004",
            "collected": true,
            "testCases": [
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn"
            ],
            "testLayer": "unit",
            "falsifiable": true,
            "fixtureFree": false,
            "coverageRungs": {
              "l4": true
            },
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "apps/operator/scripts/psu-pty-host.mjs",
                "repo": ".",
                "clean": true,
                "sha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57",
                "headBlob": "26cca304f05c7cc003704d7a90bdf4488d7ea08b",
                "dimension": "source"
              },
              {
                "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
                "headBlob": "ebd760b141c69bb216ab1ddf788e6ef3a9366c37",
                "dimension": "test"
              },
              {
                "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
                "headBlob": "ebd760b141c69bb216ab1ddf788e6ef3a9366c37",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "075342a0f10ffffb8cfa38f5a0de1287d1d6577a",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            ],
            "sourcePaths": [
              "apps/operator/scripts/psu-pty-host.mjs"
            ],
            "fixturePaths": [
              "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-25T19:55:37.716Z",
        "bindingFingerprint": "360f06004f77894e052f87b4c5ad4eb69f185b125592f6d744fabdba6adbe465",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T19:59:56.635Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "ce119f4c1de76803438457abc72cb464b2b7ac41",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-29-P-004",
            "specRevision": 2,
            "specFingerprint": "345a1ad9e86562f01a5ee167a035df2389252d6ee1535887734140f57efcabf8",
            "evidenceKind": "mutation",
            "evidenceRef": "test-run 22056073 mutation-probe mutant fail apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts @0f9e16607008",
            "sourceFingerprint": "sha256-file-set-v1:45c615733436912053f13f8608903c1bb3d178fd070ecf975592ebfd8ab9911b",
            "testFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
            "fixtureFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4"
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
        "id": 70453,
        "workItemId": "WI-10008155",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-29-P-004",
        "sourceValId": null,
        "specRevision": 1,
        "currentRevision": 2,
        "specFingerprint": "193d37cf9677f42ca9393588ff5034d85e7a1dfcb5b294dd5572daf4a8b5c927",
        "evidenceKind": "mutation",
        "evidenceRef": "test-run 22056073 mutation-probe mutant fail apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts @0f9e16607008",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:45c615733436912053f13f8608903c1bb3d178fd070ecf975592ebfd8ab9911b",
          "testFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
          "fixtureFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 22056073,
        "testRunExecution": {
          "status": "fail",
          "passed": 19,
          "failed": 2,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "passedCaseTitles": [],
          "testLayer": "unit",
          "passedCaseTitleCount": 19,
          "passedCaseTitlesOmitted": 19,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                22056073
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "framework": "vitest",
          "source": "mutation-probe",
          "mutationPhase": "mutant",
          "mutation": {
            "leg": "mutant",
            "mode": "copy-out",
            "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6763,7 +6763,7 @@\n     // same static bytes cannot re-latch it; a wall that is still up repaints a\n     // fresh banner on the next turn and latches again with its new reset.\n     const expiryAt = blocked ? now() : 0;\n-    const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs + resetGraceMs;\n+    const dueReset = false;\n     // A non-finite base disables probing (the cap must not re-enable it).\n     const probeMs = Number.isFinite(probeBaseMs) ? Math.min(probeBaseMs * 2 ** probes, probeMaxMs) : Infinity;\n     const dueProbe = blocked && !dueReset && probing && blockedSinceMs != null &&\n",
            "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
            "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
            "mutateExpression": "s/const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs \\+ resetGraceMs;/const dueReset = false;/",
            "probeInvocationId": "a2c7ec8d-753a-45a8-bc82-33cbb87751e3",
            "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
            "subjectAfterSha256": "0ed1b7b10e89dd5635fa47eeb48f66235a43881d6e689941fc5b65254cb30abc",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57"
          },
          "mutationBaseline": {
            "testRunId": 22055502,
            "status": "pass",
            "mutation": {
              "leg": "copy-baseline",
              "mode": "copy-out",
              "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6763,7 +6763,7 @@\n     // same static bytes cannot re-latch it; a wall that is still up repaints a\n     // fresh banner on the next turn and latches again with its new reset.\n     const expiryAt = blocked ? now() : 0;\n-    const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs + resetGraceMs;\n+    const dueReset = false;\n     // A non-finite base disables probing (the cap must not re-enable it).\n     const probeMs = Number.isFinite(probeBaseMs) ? Math.min(probeBaseMs * 2 ** probes, probeMaxMs) : Infinity;\n     const dueProbe = blocked && !dueReset && probing && blockedSinceMs != null &&\n",
              "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
              "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
              "againstCommit": null,
              "schemaVersion": 1,
              "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
              "mutateExpression": "s/const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs \\+ resetGraceMs;/const dueReset = false;/",
              "probeInvocationId": "a2c7ec8d-753a-45a8-bc82-33cbb87751e3",
              "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
              "subjectAfterSha256": "0ed1b7b10e89dd5635fa47eeb48f66235a43881d6e689941fc5b65254cb30abc",
              "mutantDiffTruncated": false,
              "subjectBeforeSha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57"
            },
            "passed": 21,
            "failed": 0,
            "skipped": 0,
            "collectionFailed": false,
            "passedCaseTitles": [
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
              "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
              "provider detector replay mode follows the replacement child > quota ignores resumed history after a fresh launch, then detects a fresh failure",
              "provider detector replay mode follows the replacement child > auth ignores resumed history after a fresh launch, then detects a fresh failure",
              "parseQuotaResetAtMs (WI-6554700010008412) > parses the incident copy as a local-time instant",
              "parseQuotaResetAtMs (WI-6554700010008412) > parses the clause after ANSI styling and terminal line wraps",
              "parseQuotaResetAtMs (WI-6554700010008412) > parses a relative duration from the moment it is read",
              "parseQuotaResetAtMs (WI-6554700010008412) > reads a bare time already past as tomorrow, and a yearless past date as next year",
              "parseQuotaResetAtMs (WI-6554700010008412) > uses the newest statement when the window holds an older wall too",
              "parseQuotaResetAtMs (WI-6554700010008412) > never returns a reset that is not in the future, and never parses other products",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle"
            ]
          },
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "worktreeDirty": false,
          "mutationFailureLines": [
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once: (recorded failed assertion)",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn: (recorded failed assertion)"
          ],
          "mutationFailedCaseTitles": [
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn"
          ]
        },
        "details": {
          "testRun": {
            "id": 22056073,
            "source": "mutation-probe",
            "status": "fail",
            "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
            "finishedAt": "2026-10-25T19:41:44.233Z",
            "asCommitted": {
              "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
            "mutationPhase": "mutant",
            "worktreeDirty": false,
            "recordedFilePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "caught",
            "skipped": false,
            "executed": true,
            "targeted": "auto-bar-r-29-p-004",
            "collected": true,
            "testCases": [
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn"
            ],
            "testLayer": "unit",
            "falsifiable": true,
            "fixtureFree": false,
            "coverageRungs": {
              "l4": true
            },
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "apps/operator/scripts/psu-pty-host.mjs",
                "repo": ".",
                "clean": true,
                "sha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57",
                "headBlob": "26cca304f05c7cc003704d7a90bdf4488d7ea08b",
                "dimension": "source"
              },
              {
                "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
                "headBlob": "ebd760b141c69bb216ab1ddf788e6ef3a9366c37",
                "dimension": "test"
              },
              {
                "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
                "headBlob": "ebd760b141c69bb216ab1ddf788e6ef3a9366c37",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "075342a0f10ffffb8cfa38f5a0de1287d1d6577a",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            ],
            "sourcePaths": [
              "apps/operator/scripts/psu-pty-host.mjs"
            ],
            "fixturePaths": [
              "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-25T19:55:37.716Z",
        "bindingFingerprint": "7f5d371f0ef28952630b390dab63e5aa8f5fb47f697bcea65a2fd78ae8d059aa",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T19:55:37.710Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "ce119f4c1de76803438457abc72cb464b2b7ac41",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-29-P-004",
            "specRevision": 1,
            "specFingerprint": "193d37cf9677f42ca9393588ff5034d85e7a1dfcb5b294dd5572daf4a8b5c927",
            "evidenceKind": "mutation",
            "evidenceRef": "test-run 22056073 mutation-probe mutant fail apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts @0f9e16607008",
            "sourceFingerprint": "sha256-file-set-v1:45c615733436912053f13f8608903c1bb3d178fd070ecf975592ebfd8ab9911b",
            "testFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
            "fixtureFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4"
          }
        },
        "currentness": {
          "overall": "stale",
          "dimensions": {
            "spec": "stale",
            "source": "current",
            "test": "current",
            "fixture": "current",
            "rubric": "not-applicable",
            "environment": "not-applicable",
            "coverageEvidence": "not-applicable",
            "testRun": "current"
          },
          "staleReasons": [
            "spec-stale"
          ],
          "unknownReasons": [],
          "comparisonSupplied": true,
          "provenance": "server-measured"
        }
      },
      {
        "id": 70457,
        "workItemId": "WI-10008155",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-29-P-004",
        "sourceValId": null,
        "specRevision": 2,
        "currentRevision": 2,
        "specFingerprint": "345a1ad9e86562f01a5ee167a035df2389252d6ee1535887734140f57efcabf8",
        "evidenceKind": "test",
        "evidenceRef": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:45c615733436912053f13f8608903c1bb3d178fd070ecf975592ebfd8ab9911b",
          "testFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
          "fixtureFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 22055500,
        "testRunExecution": {
          "status": "pass",
          "passed": 21,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "passedCaseTitles": [
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)"
          ],
          "testLayer": "unit",
          "passedCaseTitleCount": 21,
          "passedCaseTitlesOmitted": 17,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                22055500
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "framework": "vitest",
          "source": "mutation-probe",
          "mutationPhase": "baseline",
          "mutation": {
            "leg": "baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6763,7 +6763,7 @@\n     // same static bytes cannot re-latch it; a wall that is still up repaints a\n     // fresh banner on the next turn and latches again with its new reset.\n     const expiryAt = blocked ? now() : 0;\n-    const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs + resetGraceMs;\n+    const dueReset = false;\n     // A non-finite base disables probing (the cap must not re-enable it).\n     const probeMs = Number.isFinite(probeBaseMs) ? Math.min(probeBaseMs * 2 ** probes, probeMaxMs) : Infinity;\n     const dueProbe = blocked && !dueReset && probing && blockedSinceMs != null &&\n",
            "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
            "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
            "mutateExpression": "s/const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs \\+ resetGraceMs;/const dueReset = false;/",
            "probeInvocationId": "a2c7ec8d-753a-45a8-bc82-33cbb87751e3",
            "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
            "subjectAfterSha256": "0ed1b7b10e89dd5635fa47eeb48f66235a43881d6e689941fc5b65254cb30abc",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57"
          },
          "mutationBaseline": null,
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 22055500,
            "source": "mutation-probe",
            "status": "pass",
            "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
            "finishedAt": "2026-10-25T19:41:14.148Z",
            "asCommitted": {
              "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
            "mutationPhase": "baseline",
            "worktreeDirty": false,
            "recordedFilePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "auto-bar-r-29-p-004",
            "collected": true,
            "testCases": [
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words"
            ],
            "testLayer": "unit",
            "falsifiable": true,
            "fixtureFree": false,
            "coverageRungs": {
              "l4": true
            },
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "apps/operator/scripts/psu-pty-host.mjs",
                "repo": ".",
                "clean": true,
                "sha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57",
                "headBlob": "26cca304f05c7cc003704d7a90bdf4488d7ea08b",
                "dimension": "source"
              },
              {
                "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
                "headBlob": "ebd760b141c69bb216ab1ddf788e6ef3a9366c37",
                "dimension": "test"
              },
              {
                "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
                "headBlob": "ebd760b141c69bb216ab1ddf788e6ef3a9366c37",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "075342a0f10ffffb8cfa38f5a0de1287d1d6577a",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            ],
            "sourcePaths": [
              "apps/operator/scripts/psu-pty-host.mjs"
            ],
            "fixturePaths": [
              "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-25T19:55:37.200Z",
        "bindingFingerprint": "a7dfc6ed5d2706241e4330b30155eb101cc7fa5b0fabb0461bab702be9918493",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T19:59:56.635Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "ce119f4c1de76803438457abc72cb464b2b7ac41",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-29-P-004",
            "specRevision": 2,
            "specFingerprint": "345a1ad9e86562f01a5ee167a035df2389252d6ee1535887734140f57efcabf8",
            "evidenceKind": "test",
            "evidenceRef": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "sourceFingerprint": "sha256-file-set-v1:45c615733436912053f13f8608903c1bb3d178fd070ecf975592ebfd8ab9911b",
            "testFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
            "fixtureFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4"
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
        "id": 70452,
        "workItemId": "WI-10008155",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-29-P-004",
        "sourceValId": null,
        "specRevision": 1,
        "currentRevision": 2,
        "specFingerprint": "193d37cf9677f42ca9393588ff5034d85e7a1dfcb5b294dd5572daf4a8b5c927",
        "evidenceKind": "test",
        "evidenceRef": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
        "fingerprints": {
          "sourceFingerprint": "sha256-file-set-v1:45c615733436912053f13f8608903c1bb3d178fd070ecf975592ebfd8ab9911b",
          "testFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
          "fixtureFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
          "rubricFingerprint": null,
          "environmentFingerprint": null
        },
        "coverageEvidenceRef": null,
        "testRunId": 22055500,
        "testRunExecution": {
          "status": "pass",
          "passed": 21,
          "failed": 0,
          "skipped": 0,
          "collectionFailed": false,
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "passedCaseTitles": [
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)"
          ],
          "testLayer": "unit",
          "passedCaseTitleCount": 21,
          "passedCaseTitlesOmitted": 17,
          "passedCaseTitlesRef": {
            "tool": "testing:runs",
            "args": {
              "testRunIds": [
                22055500
              ],
              "cases": true
            }
          }
        },
        "testRunProvenance": {
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "framework": "vitest",
          "source": "mutation-probe",
          "mutationPhase": "baseline",
          "mutation": {
            "leg": "baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6763,7 +6763,7 @@\n     // same static bytes cannot re-latch it; a wall that is still up repaints a\n     // fresh banner on the next turn and latches again with its new reset.\n     const expiryAt = blocked ? now() : 0;\n-    const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs + resetGraceMs;\n+    const dueReset = false;\n     // A non-finite base disables probing (the cap must not re-enable it).\n     const probeMs = Number.isFinite(probeBaseMs) ? Math.min(probeBaseMs * 2 ** probes, probeMaxMs) : Infinity;\n     const dueProbe = blocked && !dueReset && probing && blockedSinceMs != null &&\n",
            "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
            "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
            "mutateExpression": "s/const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs \\+ resetGraceMs;/const dueReset = false;/",
            "probeInvocationId": "a2c7ec8d-753a-45a8-bc82-33cbb87751e3",
            "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
            "subjectAfterSha256": "0ed1b7b10e89dd5635fa47eeb48f66235a43881d6e689941fc5b65254cb30abc",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57"
          },
          "mutationBaseline": null,
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "worktreeDirty": false
        },
        "details": {
          "testRun": {
            "id": 22055500,
            "source": "mutation-probe",
            "status": "pass",
            "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
            "finishedAt": "2026-10-25T19:41:14.148Z",
            "asCommitted": {
              "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
              "repoPrefix": "",
              "measuredAtCommit": true
            },
            "recordedRoot": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
            "mutationPhase": "baseline",
            "worktreeDirty": false,
            "recordedFilePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "harnessAttribution": "run"
          },
          "adequacy": {
            "outcome": "passed",
            "skipped": false,
            "executed": true,
            "targeted": "auto-bar-r-29-p-004",
            "collected": true,
            "testCases": [
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
              "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words"
            ],
            "testLayer": "unit",
            "falsifiable": true,
            "fixtureFree": false,
            "coverageRungs": {
              "l4": true
            },
            "pathReachable": true,
            "fixtureCalibrated": true,
            "oracleIndependent": true
          },
          "evidencePlane": "tree",
          "measurementPin": {
            "files": [
              {
                "path": "apps/operator/scripts/psu-pty-host.mjs",
                "repo": ".",
                "clean": true,
                "sha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57",
                "headBlob": "26cca304f05c7cc003704d7a90bdf4488d7ea08b",
                "dimension": "source"
              },
              {
                "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
                "headBlob": "ebd760b141c69bb216ab1ddf788e6ef3a9366c37",
                "dimension": "test"
              },
              {
                "path": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
                "repo": ".",
                "clean": true,
                "sha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
                "headBlob": "ebd760b141c69bb216ab1ddf788e6ef3a9366c37",
                "dimension": "fixture"
              }
            ],
            "repos": [
              {
                "head": "075342a0f10ffffb8cfa38f5a0de1287d1d6577a",
                "repo": ".",
                "gitlink": null
              }
            ],
            "schemaVersion": 1
          },
          "currentMeasurement": {
            "kind": "repo-files",
            "testPaths": [
              "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            ],
            "sourcePaths": [
              "apps/operator/scripts/psu-pty-host.mjs"
            ],
            "fixturePaths": [
              "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts"
            ],
            "schemaVersion": 1
          }
        },
        "observedAt": "2026-10-25T19:55:37.200Z",
        "bindingFingerprint": "264ff25a15bdbf8df6f3ada118d734555f0e5115572023aa4666a34080b3f09a",
        "createdBy": "su-424d5476-0b13-401a-a926-0aaa9f212391",
        "createdAt": "2026-10-25T19:55:37.178Z",
        "serverMeasurement": {
          "status": "measured",
          "measuredDimensions": [
            "source",
            "test",
            "fixture"
          ],
          "measuredAtCommit": "ce119f4c1de76803438457abc72cb464b2b7ac41",
          "current": {
            "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
            "specId": "AUTO-BAR-R-29-P-004",
            "specRevision": 1,
            "specFingerprint": "193d37cf9677f42ca9393588ff5034d85e7a1dfcb5b294dd5572daf4a8b5c927",
            "evidenceKind": "test",
            "evidenceRef": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "sourceFingerprint": "sha256-file-set-v1:45c615733436912053f13f8608903c1bb3d178fd070ecf975592ebfd8ab9911b",
            "testFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4",
            "fixtureFingerprint": "sha256-file-set-v1:a0e6c1394e394061065526a673c1a895d098a5b6c1efe6f39a9859615b8674f4"
          }
        },
        "currentness": {
          "overall": "stale",
          "dimensions": {
            "spec": "stale",
            "source": "current",
            "test": "current",
            "fixture": "current",
            "rubric": "not-applicable",
            "environment": "not-applicable",
            "coverageEvidence": "not-applicable",
            "testRun": "current"
          },
          "staleReasons": [
            "spec-stale"
          ],
          "unknownReasons": [],
          "comparisonSupplied": true,
          "provenance": "server-measured"
        }
      }
    ],
    "count": 12,
    "currentness": {
      "current": 6,
      "stale": 6,
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
  "ledger": {
    "count": 9,
    "total": 9,
    "truncatedByLimit": false,
    "latestPerFile": false,
    "effectiveSourceFilter": "none (exact testRunIds receipt lookup)",
    "omittedBySourceFilter": 0,
    "runs": [
      {
        "id": 22057713,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
          "failed": 1,
          "passed": 20,
          "skipped": 0,
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "mutation": {
            "leg": "mutant",
            "mode": "copy-out",
            "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6835,7 +6835,7 @@\n       // The reset clause can arrive in a later chunk than the matched words,\n       // so keep trying until one parses. Parsed once: the text is static, and\n       // a relative \"in 2 hours\" re-read later would drift.\n-      if (hit.matched && resetAtMs == null) resetAtMs = parseQuotaResetAtMs(buffer, agent, now());\n+      if (hit.matched && resetAtMs == null && lastExpiryAtMs == null) resetAtMs = parseQuotaResetAtMs(buffer, agent, now());\n       if (hit.matched === blocked) return null;\n       blocked = hit.matched;\n       blockedSinceMs = blocked ? now() : null;\n",
            "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
            "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
            "mutateExpression": "s/if \\(hit.matched && resetAtMs == null\\) resetAtMs =/if (hit.matched \\&\\& resetAtMs == null \\&\\& lastExpiryAtMs == null) resetAtMs =/",
            "probeInvocationId": "8741124d-1097-455d-9b9f-4b29d3bbc04c",
            "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
            "subjectAfterSha256": "b4323cdb99aa9afe920db6f20ea7059598fb7fe2a694b433b2b9202f427289ba",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57"
          },
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-25T19:59:34.694Z",
          "mutationPhase": "mutant",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": null,
          "collectionFailed": false,
          "failedCaseTitles": [
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn"
          ],
          "passedCaseTitles": [
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
            "provider detector replay mode follows the replacement child > quota ignores resumed history after a fresh launch, then detects a fresh failure",
            "provider detector replay mode follows the replacement child > auth ignores resumed history after a fresh launch, then detects a fresh failure",
            "parseQuotaResetAtMs (WI-6554700010008412) > parses the incident copy as a local-time instant",
            "parseQuotaResetAtMs (WI-6554700010008412) > parses the clause after ANSI styling and terminal line wraps",
            "parseQuotaResetAtMs (WI-6554700010008412) > parses a relative duration from the moment it is read",
            "parseQuotaResetAtMs (WI-6554700010008412) > reads a bare time already past as tomorrow, and a yearless past date as next year",
            "parseQuotaResetAtMs (WI-6554700010008412) > uses the newest statement when the window holds an older wall too",
            "parseQuotaResetAtMs (WI-6554700010008412) > never returns a reset that is not in the future, and never parses other products",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
        "status": "fail",
        "framework": "vitest",
        "startedAt": "2026-10-25T19:59:41.740Z",
        "finishedAt": "2026-10-25T19:59:42.374Z",
        "durationMs": 634,
        "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn: expected null to be 1792034700000 // Object.is equality\nactual: null\nexpected: 1792034700000",
        "loopLagP95Ms": null,
        "rssMb": 332.3,
        "saturationSuspect": null,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": [
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 159,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 112,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 108,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 110,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 110,
            "errorTail": null
          },
          {
            "caseKey": "provider detector replay mode follows the replacement child > quota ignores resumed history after a fresh launch, then detects a fresh failure",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "provider detector replay mode follows the replacement child > auth ignores resumed history after a fresh launch, then detects a fresh failure",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses the incident copy as a local-time instant",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses the clause after ANSI styling and terminal line wraps",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses a relative duration from the moment it is read",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > reads a bare time already past as tomorrow, and a yearless past date as next year",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > uses the newest statement when the window holds an older wall too",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > never returns a reset that is not in the future, and never parses other products",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 3,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
            "occurrence": 1,
            "status": "fail",
            "durationMs": 7,
            "errorTail": "expected null to be 1792034700000 // Object.is equality\nactual: null\nexpected: 1792034700000"
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          }
        ]
      },
      {
        "id": 22057709,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
          "failed": 0,
          "passed": 21,
          "skipped": 0,
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "mutation": {
            "leg": "copy-baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6835,7 +6835,7 @@\n       // The reset clause can arrive in a later chunk than the matched words,\n       // so keep trying until one parses. Parsed once: the text is static, and\n       // a relative \"in 2 hours\" re-read later would drift.\n-      if (hit.matched && resetAtMs == null) resetAtMs = parseQuotaResetAtMs(buffer, agent, now());\n+      if (hit.matched && resetAtMs == null && lastExpiryAtMs == null) resetAtMs = parseQuotaResetAtMs(buffer, agent, now());\n       if (hit.matched === blocked) return null;\n       blocked = hit.matched;\n       blockedSinceMs = blocked ? now() : null;\n",
            "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
            "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
            "mutateExpression": "s/if \\(hit.matched && resetAtMs == null\\) resetAtMs =/if (hit.matched \\&\\& resetAtMs == null \\&\\& lastExpiryAtMs == null) resetAtMs =/",
            "probeInvocationId": "8741124d-1097-455d-9b9f-4b29d3bbc04c",
            "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
            "subjectAfterSha256": "b4323cdb99aa9afe920db6f20ea7059598fb7fe2a694b433b2b9202f427289ba",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57"
          },
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-25T19:59:10.992Z",
          "mutationPhase": "copy-baseline",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": null,
          "collectionFailed": false,
          "passedCaseTitles": [
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
            "provider detector replay mode follows the replacement child > quota ignores resumed history after a fresh launch, then detects a fresh failure",
            "provider detector replay mode follows the replacement child > auth ignores resumed history after a fresh launch, then detects a fresh failure",
            "parseQuotaResetAtMs (WI-6554700010008412) > parses the incident copy as a local-time instant",
            "parseQuotaResetAtMs (WI-6554700010008412) > parses the clause after ANSI styling and terminal line wraps",
            "parseQuotaResetAtMs (WI-6554700010008412) > parses a relative duration from the moment it is read",
            "parseQuotaResetAtMs (WI-6554700010008412) > reads a bare time already past as tomorrow, and a yearless past date as next year",
            "parseQuotaResetAtMs (WI-6554700010008412) > uses the newest statement when the window holds an older wall too",
            "parseQuotaResetAtMs (WI-6554700010008412) > never returns a reset that is not in the future, and never parses other products",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
        "status": "pass",
        "framework": "vitest",
        "startedAt": "2026-10-25T19:59:17.872Z",
        "finishedAt": "2026-10-25T19:59:18.480Z",
        "durationMs": 608,
        "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": null,
        "loopLagP95Ms": null,
        "rssMb": 359.6,
        "saturationSuspect": null,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": [
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 154,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 111,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 109,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 106,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 106,
            "errorTail": null
          },
          {
            "caseKey": "provider detector replay mode follows the replacement child > quota ignores resumed history after a fresh launch, then detects a fresh failure",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "provider detector replay mode follows the replacement child > auth ignores resumed history after a fresh launch, then detects a fresh failure",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses the incident copy as a local-time instant",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses the clause after ANSI styling and terminal line wraps",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses a relative duration from the moment it is read",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > reads a bare time already past as tomorrow, and a yearless past date as next year",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > uses the newest statement when the window holds an older wall too",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > never returns a reset that is not in the future, and never parses other products",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          }
        ]
      },
      {
        "id": 22057691,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
          "failed": 0,
          "passed": 21,
          "skipped": 0,
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "mutation": {
            "leg": "baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6835,7 +6835,7 @@\n       // The reset clause can arrive in a later chunk than the matched words,\n       // so keep trying until one parses. Parsed once: the text is static, and\n       // a relative \"in 2 hours\" re-read later would drift.\n-      if (hit.matched && resetAtMs == null) resetAtMs = parseQuotaResetAtMs(buffer, agent, now());\n+      if (hit.matched && resetAtMs == null && lastExpiryAtMs == null) resetAtMs = parseQuotaResetAtMs(buffer, agent, now());\n       if (hit.matched === blocked) return null;\n       blocked = hit.matched;\n       blockedSinceMs = blocked ? now() : null;\n",
            "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
            "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
            "mutateExpression": "s/if \\(hit.matched && resetAtMs == null\\) resetAtMs =/if (hit.matched \\&\\& resetAtMs == null \\&\\& lastExpiryAtMs == null) resetAtMs =/",
            "probeInvocationId": "8741124d-1097-455d-9b9f-4b29d3bbc04c",
            "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
            "subjectAfterSha256": "b4323cdb99aa9afe920db6f20ea7059598fb7fe2a694b433b2b9202f427289ba",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57"
          },
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-25T19:58:51.653Z",
          "mutationPhase": "baseline",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": null,
          "collectionFailed": false,
          "passedCaseTitles": [
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
            "provider detector replay mode follows the replacement child > quota ignores resumed history after a fresh launch, then detects a fresh failure",
            "provider detector replay mode follows the replacement child > auth ignores resumed history after a fresh launch, then detects a fresh failure",
            "parseQuotaResetAtMs (WI-6554700010008412) > parses the incident copy as a local-time instant",
            "parseQuotaResetAtMs (WI-6554700010008412) > parses the clause after ANSI styling and terminal line wraps",
            "parseQuotaResetAtMs (WI-6554700010008412) > parses a relative duration from the moment it is read",
            "parseQuotaResetAtMs (WI-6554700010008412) > reads a bare time already past as tomorrow, and a yearless past date as next year",
            "parseQuotaResetAtMs (WI-6554700010008412) > uses the newest statement when the window holds an older wall too",
            "parseQuotaResetAtMs (WI-6554700010008412) > never returns a reset that is not in the future, and never parses other products",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
        "status": "pass",
        "framework": "vitest",
        "startedAt": "2026-10-25T19:58:58.328Z",
        "finishedAt": "2026-10-25T19:58:58.937Z",
        "durationMs": 609,
        "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": null,
        "loopLagP95Ms": null,
        "rssMb": 336.7,
        "saturationSuspect": null,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": [
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 150,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 110,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 111,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 107,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 107,
            "errorTail": null
          },
          {
            "caseKey": "provider detector replay mode follows the replacement child > quota ignores resumed history after a fresh launch, then detects a fresh failure",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "provider detector replay mode follows the replacement child > auth ignores resumed history after a fresh launch, then detects a fresh failure",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses the incident copy as a local-time instant",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses the clause after ANSI styling and terminal line wraps",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses a relative duration from the moment it is read",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > reads a bare time already past as tomorrow, and a yearless past date as next year",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > uses the newest statement when the window holds an older wall too",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > never returns a reset that is not in the future, and never parses other products",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          }
        ]
      },
      {
        "id": 22056235,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
          "failed": 2,
          "passed": 19,
          "skipped": 0,
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "mutation": {
            "leg": "mutant",
            "mode": "copy-out",
            "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6766,7 +6766,7 @@\n     const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs + resetGraceMs;\n     // A non-finite base disables probing (the cap must not re-enable it).\n     const probeMs = Number.isFinite(probeBaseMs) ? Math.min(probeBaseMs * 2 ** probes, probeMaxMs) : Infinity;\n-    const dueProbe = blocked && !dueReset && probing && blockedSinceMs != null &&\n+    const dueProbe = false && !dueReset && probing && blockedSinceMs != null &&\n       Number.isFinite(probeMs) && expiryAt >= blockedSinceMs + probeMs;\n     if (dueReset || dueProbe) {\n       const expired = {\n",
            "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
            "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
            "mutateExpression": "s/const dueProbe = blocked && !dueReset && probing/const dueProbe = false \\&\\& !dueReset \\&\\& probing/",
            "probeInvocationId": "cc2a5193-9c84-4bbe-989a-0be5dff5c4ab",
            "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
            "subjectAfterSha256": "293b912714af72fbc27ca1ad447e3660d1825a2323cca987f4959bdd8300247a",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57"
          },
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-25T19:43:19.861Z",
          "mutationPhase": "mutant",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": null,
          "collectionFailed": false,
          "failedCaseTitles": [
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe"
          ],
          "passedCaseTitles": [
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
            "provider detector replay mode follows the replacement child > quota ignores resumed history after a fresh launch, then detects a fresh failure",
            "provider detector replay mode follows the replacement child > auth ignores resumed history after a fresh launch, then detects a fresh failure",
            "parseQuotaResetAtMs (WI-6554700010008412) > parses the incident copy as a local-time instant",
            "parseQuotaResetAtMs (WI-6554700010008412) > parses the clause after ANSI styling and terminal line wraps",
            "parseQuotaResetAtMs (WI-6554700010008412) > parses a relative duration from the moment it is read",
            "parseQuotaResetAtMs (WI-6554700010008412) > reads a bare time already past as tomorrow, and a yearless past date as next year",
            "parseQuotaResetAtMs (WI-6554700010008412) > uses the newest statement when the window holds an older wall too",
            "parseQuotaResetAtMs (WI-6554700010008412) > never returns a reset that is not in the future, and never parses other products",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
        "status": "fail",
        "framework": "vitest",
        "startedAt": "2026-10-25T19:43:24.750Z",
        "finishedAt": "2026-10-25T19:43:25.377Z",
        "durationMs": 627,
        "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled: expected true to be false // Object.is equality\nactual: true\nexpected: false\nmakeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe: expected true to be false // Object.is equality\nactual: true\nexpected: false",
        "loopLagP95Ms": null,
        "rssMb": 323.7,
        "saturationSuspect": null,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": [
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 155,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 112,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 110,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 110,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 109,
            "errorTail": null
          },
          {
            "caseKey": "provider detector replay mode follows the replacement child > quota ignores resumed history after a fresh launch, then detects a fresh failure",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "provider detector replay mode follows the replacement child > auth ignores resumed history after a fresh launch, then detects a fresh failure",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses the incident copy as a local-time instant",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses the clause after ANSI styling and terminal line wraps",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses a relative duration from the moment it is read",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > reads a bare time already past as tomorrow, and a yearless past date as next year",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > uses the newest statement when the window holds an older wall too",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > never returns a reset that is not in the future, and never parses other products",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
            "occurrence": 1,
            "status": "fail",
            "durationMs": 7,
            "errorTail": "expected true to be false // Object.is equality\nactual: true\nexpected: false"
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
            "occurrence": 1,
            "status": "fail",
            "durationMs": 1,
            "errorTail": "expected true to be false // Object.is equality\nactual: true\nexpected: false"
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          }
        ]
      },
      {
        "id": 22056231,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
          "failed": 0,
          "passed": 21,
          "skipped": 0,
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "mutation": {
            "leg": "copy-baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6766,7 +6766,7 @@\n     const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs + resetGraceMs;\n     // A non-finite base disables probing (the cap must not re-enable it).\n     const probeMs = Number.isFinite(probeBaseMs) ? Math.min(probeBaseMs * 2 ** probes, probeMaxMs) : Infinity;\n-    const dueProbe = blocked && !dueReset && probing && blockedSinceMs != null &&\n+    const dueProbe = false && !dueReset && probing && blockedSinceMs != null &&\n       Number.isFinite(probeMs) && expiryAt >= blockedSinceMs + probeMs;\n     if (dueReset || dueProbe) {\n       const expired = {\n",
            "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
            "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
            "mutateExpression": "s/const dueProbe = blocked && !dueReset && probing/const dueProbe = false \\&\\& !dueReset \\&\\& probing/",
            "probeInvocationId": "cc2a5193-9c84-4bbe-989a-0be5dff5c4ab",
            "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
            "subjectAfterSha256": "293b912714af72fbc27ca1ad447e3660d1825a2323cca987f4959bdd8300247a",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57"
          },
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-25T19:42:59.053Z",
          "mutationPhase": "copy-baseline",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": null,
          "collectionFailed": false,
          "passedCaseTitles": [
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
            "provider detector replay mode follows the replacement child > quota ignores resumed history after a fresh launch, then detects a fresh failure",
            "provider detector replay mode follows the replacement child > auth ignores resumed history after a fresh launch, then detects a fresh failure",
            "parseQuotaResetAtMs (WI-6554700010008412) > parses the incident copy as a local-time instant",
            "parseQuotaResetAtMs (WI-6554700010008412) > parses the clause after ANSI styling and terminal line wraps",
            "parseQuotaResetAtMs (WI-6554700010008412) > parses a relative duration from the moment it is read",
            "parseQuotaResetAtMs (WI-6554700010008412) > reads a bare time already past as tomorrow, and a yearless past date as next year",
            "parseQuotaResetAtMs (WI-6554700010008412) > uses the newest statement when the window holds an older wall too",
            "parseQuotaResetAtMs (WI-6554700010008412) > never returns a reset that is not in the future, and never parses other products",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
        "status": "pass",
        "framework": "vitest",
        "startedAt": "2026-10-25T19:43:02.718Z",
        "finishedAt": "2026-10-25T19:43:03.400Z",
        "durationMs": 682,
        "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": null,
        "loopLagP95Ms": null,
        "rssMb": 328.5,
        "saturationSuspect": null,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": [
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 206,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 114,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 111,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 111,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 114,
            "errorTail": null
          },
          {
            "caseKey": "provider detector replay mode follows the replacement child > quota ignores resumed history after a fresh launch, then detects a fresh failure",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "provider detector replay mode follows the replacement child > auth ignores resumed history after a fresh launch, then detects a fresh failure",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses the incident copy as a local-time instant",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses the clause after ANSI styling and terminal line wraps",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses a relative duration from the moment it is read",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > reads a bare time already past as tomorrow, and a yearless past date as next year",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > uses the newest statement when the window holds an older wall too",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > never returns a reset that is not in the future, and never parses other products",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          }
        ]
      },
      {
        "id": 22056230,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
          "failed": 0,
          "passed": 21,
          "skipped": 0,
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "mutation": {
            "leg": "baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6766,7 +6766,7 @@\n     const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs + resetGraceMs;\n     // A non-finite base disables probing (the cap must not re-enable it).\n     const probeMs = Number.isFinite(probeBaseMs) ? Math.min(probeBaseMs * 2 ** probes, probeMaxMs) : Infinity;\n-    const dueProbe = blocked && !dueReset && probing && blockedSinceMs != null &&\n+    const dueProbe = false && !dueReset && probing && blockedSinceMs != null &&\n       Number.isFinite(probeMs) && expiryAt >= blockedSinceMs + probeMs;\n     if (dueReset || dueProbe) {\n       const expired = {\n",
            "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
            "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
            "mutateExpression": "s/const dueProbe = blocked && !dueReset && probing/const dueProbe = false \\&\\& !dueReset \\&\\& probing/",
            "probeInvocationId": "cc2a5193-9c84-4bbe-989a-0be5dff5c4ab",
            "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
            "subjectAfterSha256": "293b912714af72fbc27ca1ad447e3660d1825a2323cca987f4959bdd8300247a",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57"
          },
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-25T19:42:34.926Z",
          "mutationPhase": "baseline",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": null,
          "collectionFailed": false,
          "passedCaseTitles": [
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
            "provider detector replay mode follows the replacement child > quota ignores resumed history after a fresh launch, then detects a fresh failure",
            "provider detector replay mode follows the replacement child > auth ignores resumed history after a fresh launch, then detects a fresh failure",
            "parseQuotaResetAtMs (WI-6554700010008412) > parses the incident copy as a local-time instant",
            "parseQuotaResetAtMs (WI-6554700010008412) > parses the clause after ANSI styling and terminal line wraps",
            "parseQuotaResetAtMs (WI-6554700010008412) > parses a relative duration from the moment it is read",
            "parseQuotaResetAtMs (WI-6554700010008412) > reads a bare time already past as tomorrow, and a yearless past date as next year",
            "parseQuotaResetAtMs (WI-6554700010008412) > uses the newest statement when the window holds an older wall too",
            "parseQuotaResetAtMs (WI-6554700010008412) > never returns a reset that is not in the future, and never parses other products",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
        "status": "pass",
        "framework": "vitest",
        "startedAt": "2026-10-25T19:42:39.275Z",
        "finishedAt": "2026-10-25T19:42:39.894Z",
        "durationMs": 619,
        "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": null,
        "loopLagP95Ms": null,
        "rssMb": 349.7,
        "saturationSuspect": null,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": [
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 149,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 111,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 109,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 109,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 107,
            "errorTail": null
          },
          {
            "caseKey": "provider detector replay mode follows the replacement child > quota ignores resumed history after a fresh launch, then detects a fresh failure",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "provider detector replay mode follows the replacement child > auth ignores resumed history after a fresh launch, then detects a fresh failure",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses the incident copy as a local-time instant",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses the clause after ANSI styling and terminal line wraps",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses a relative duration from the moment it is read",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > reads a bare time already past as tomorrow, and a yearless past date as next year",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > uses the newest statement when the window holds an older wall too",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > never returns a reset that is not in the future, and never parses other products",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          }
        ]
      },
      {
        "id": 22056073,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
          "failed": 2,
          "passed": 19,
          "skipped": 0,
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "mutation": {
            "leg": "mutant",
            "mode": "copy-out",
            "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6763,7 +6763,7 @@\n     // same static bytes cannot re-latch it; a wall that is still up repaints a\n     // fresh banner on the next turn and latches again with its new reset.\n     const expiryAt = blocked ? now() : 0;\n-    const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs + resetGraceMs;\n+    const dueReset = false;\n     // A non-finite base disables probing (the cap must not re-enable it).\n     const probeMs = Number.isFinite(probeBaseMs) ? Math.min(probeBaseMs * 2 ** probes, probeMaxMs) : Infinity;\n     const dueProbe = blocked && !dueReset && probing && blockedSinceMs != null &&\n",
            "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
            "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
            "mutateExpression": "s/const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs \\+ resetGraceMs;/const dueReset = false;/",
            "probeInvocationId": "a2c7ec8d-753a-45a8-bc82-33cbb87751e3",
            "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
            "subjectAfterSha256": "0ed1b7b10e89dd5635fa47eeb48f66235a43881d6e689941fc5b65254cb30abc",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57"
          },
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-25T19:41:41.016Z",
          "mutationPhase": "mutant",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": null,
          "collectionFailed": false,
          "failedCaseTitles": [
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn"
          ],
          "passedCaseTitles": [
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
            "provider detector replay mode follows the replacement child > quota ignores resumed history after a fresh launch, then detects a fresh failure",
            "provider detector replay mode follows the replacement child > auth ignores resumed history after a fresh launch, then detects a fresh failure",
            "parseQuotaResetAtMs (WI-6554700010008412) > parses the incident copy as a local-time instant",
            "parseQuotaResetAtMs (WI-6554700010008412) > parses the clause after ANSI styling and terminal line wraps",
            "parseQuotaResetAtMs (WI-6554700010008412) > parses a relative duration from the moment it is read",
            "parseQuotaResetAtMs (WI-6554700010008412) > reads a bare time already past as tomorrow, and a yearless past date as next year",
            "parseQuotaResetAtMs (WI-6554700010008412) > uses the newest statement when the window holds an older wall too",
            "parseQuotaResetAtMs (WI-6554700010008412) > never returns a reset that is not in the future, and never parses other products",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
        "status": "fail",
        "framework": "vitest",
        "startedAt": "2026-10-25T19:41:43.637Z",
        "finishedAt": "2026-10-25T19:41:44.233Z",
        "durationMs": 596,
        "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once: expected true to be false // Object.is equality\nactual: true\nexpected: false\nmakeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn: expected true to be false // Object.is equality\nactual: true\nexpected: false",
        "loopLagP95Ms": null,
        "rssMb": 336.4,
        "saturationSuspect": null,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": [
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 139,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 108,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 110,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 108,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 106,
            "errorTail": null
          },
          {
            "caseKey": "provider detector replay mode follows the replacement child > quota ignores resumed history after a fresh launch, then detects a fresh failure",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "provider detector replay mode follows the replacement child > auth ignores resumed history after a fresh launch, then detects a fresh failure",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses the incident copy as a local-time instant",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses the clause after ANSI styling and terminal line wraps",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses a relative duration from the moment it is read",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > reads a bare time already past as tomorrow, and a yearless past date as next year",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > uses the newest statement when the window holds an older wall too",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > never returns a reset that is not in the future, and never parses other products",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
            "occurrence": 1,
            "status": "fail",
            "durationMs": 6,
            "errorTail": "expected true to be false // Object.is equality\nactual: true\nexpected: false"
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
            "occurrence": 1,
            "status": "fail",
            "durationMs": 1,
            "errorTail": "expected true to be false // Object.is equality\nactual: true\nexpected: false"
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          }
        ]
      },
      {
        "id": 22055502,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
          "failed": 0,
          "passed": 21,
          "skipped": 0,
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "mutation": {
            "leg": "copy-baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6763,7 +6763,7 @@\n     // same static bytes cannot re-latch it; a wall that is still up repaints a\n     // fresh banner on the next turn and latches again with its new reset.\n     const expiryAt = blocked ? now() : 0;\n-    const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs + resetGraceMs;\n+    const dueReset = false;\n     // A non-finite base disables probing (the cap must not re-enable it).\n     const probeMs = Number.isFinite(probeBaseMs) ? Math.min(probeBaseMs * 2 ** probes, probeMaxMs) : Infinity;\n     const dueProbe = blocked && !dueReset && probing && blockedSinceMs != null &&\n",
            "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
            "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
            "mutateExpression": "s/const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs \\+ resetGraceMs;/const dueReset = false;/",
            "probeInvocationId": "a2c7ec8d-753a-45a8-bc82-33cbb87751e3",
            "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
            "subjectAfterSha256": "0ed1b7b10e89dd5635fa47eeb48f66235a43881d6e689941fc5b65254cb30abc",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57"
          },
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-25T19:41:26.363Z",
          "mutationPhase": "copy-baseline",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": null,
          "collectionFailed": false,
          "passedCaseTitles": [
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
            "provider detector replay mode follows the replacement child > quota ignores resumed history after a fresh launch, then detects a fresh failure",
            "provider detector replay mode follows the replacement child > auth ignores resumed history after a fresh launch, then detects a fresh failure",
            "parseQuotaResetAtMs (WI-6554700010008412) > parses the incident copy as a local-time instant",
            "parseQuotaResetAtMs (WI-6554700010008412) > parses the clause after ANSI styling and terminal line wraps",
            "parseQuotaResetAtMs (WI-6554700010008412) > parses a relative duration from the moment it is read",
            "parseQuotaResetAtMs (WI-6554700010008412) > reads a bare time already past as tomorrow, and a yearless past date as next year",
            "parseQuotaResetAtMs (WI-6554700010008412) > uses the newest statement when the window holds an older wall too",
            "parseQuotaResetAtMs (WI-6554700010008412) > never returns a reset that is not in the future, and never parses other products",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
        "status": "pass",
        "framework": "vitest",
        "startedAt": "2026-10-25T19:41:28.863Z",
        "finishedAt": "2026-10-25T19:41:29.459Z",
        "durationMs": 596,
        "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": null,
        "loopLagP95Ms": null,
        "rssMb": 343.1,
        "saturationSuspect": null,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": [
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 143,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 111,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 108,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 105,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 108,
            "errorTail": null
          },
          {
            "caseKey": "provider detector replay mode follows the replacement child > quota ignores resumed history after a fresh launch, then detects a fresh failure",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "provider detector replay mode follows the replacement child > auth ignores resumed history after a fresh launch, then detects a fresh failure",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses the incident copy as a local-time instant",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses the clause after ANSI styling and terminal line wraps",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses a relative duration from the moment it is read",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > reads a bare time already past as tomorrow, and a yearless past date as next year",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > uses the newest statement when the window holds an older wall too",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > never returns a reset that is not in the future, and never parses other products",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          }
        ]
      },
      {
        "id": 22055500,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
        "executionDetails": {
          "root": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
          "failed": 0,
          "passed": 21,
          "skipped": 0,
          "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
          "mutation": {
            "leg": "baseline",
            "mode": "copy-out",
            "mutantDiff": "--- a/apps/operator/scripts/psu-pty-host.mjs\n+++ b/apps/operator/scripts/psu-pty-host.mjs\n@@ -6763,7 +6763,7 @@\n     // same static bytes cannot re-latch it; a wall that is still up repaints a\n     // fresh banner on the next turn and latches again with its new reset.\n     const expiryAt = blocked ? now() : 0;\n-    const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs + resetGraceMs;\n+    const dueReset = false;\n     // A non-finite base disables probing (the cap must not re-enable it).\n     const probeMs = Number.isFinite(probeBaseMs) ? Math.min(probeBaseMs * 2 ** probes, probeMaxMs) : Infinity;\n     const dueProbe = blocked && !dueReset && probing && blockedSinceMs != null &&\n",
            "subjectPath": "apps/operator/scripts/psu-pty-host.mjs",
            "testCommand": "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "againstCommit": null,
            "schemaVersion": 1,
            "testFileSha256": "f6684144b0d7535c4501fd9a42f0d147d53a7c4988fb78f3adaac8dd7e58c953",
            "mutateExpression": "s/const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs \\+ resetGraceMs;/const dueReset = false;/",
            "probeInvocationId": "a2c7ec8d-753a-45a8-bc82-33cbb87751e3",
            "testCommandSha256": "32a8379f2569907dea64630cec893f7e11fc2897baac27e5b7184c872af3d2e3",
            "subjectAfterSha256": "0ed1b7b10e89dd5635fa47eeb48f66235a43881d6e689941fc5b65254cb30abc",
            "mutantDiffTruncated": false,
            "subjectBeforeSha256": "e7624a80cb941871d0fd084c43f30de0150ab8d561cd92be3db2fda4a0c94e57"
          },
          "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-25T19:41:11.138Z",
          "mutationPhase": "baseline",
          "schemaVersion": 1,
          "worktreeDirty": false,
          "testNamePattern": null,
          "collectionFailed": false,
          "passedCaseTitles": [
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
            "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
            "provider detector replay mode follows the replacement child > quota ignores resumed history after a fresh launch, then detects a fresh failure",
            "provider detector replay mode follows the replacement child > auth ignores resumed history after a fresh launch, then detects a fresh failure",
            "parseQuotaResetAtMs (WI-6554700010008412) > parses the incident copy as a local-time instant",
            "parseQuotaResetAtMs (WI-6554700010008412) > parses the clause after ANSI styling and terminal line wraps",
            "parseQuotaResetAtMs (WI-6554700010008412) > parses a relative duration from the moment it is read",
            "parseQuotaResetAtMs (WI-6554700010008412) > reads a bare time already past as tomorrow, and a yearless past date as next year",
            "parseQuotaResetAtMs (WI-6554700010008412) > uses the newest statement when the window holds an older wall too",
            "parseQuotaResetAtMs (WI-6554700010008412) > never returns a reset that is not in the future, and never parses other products",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
            "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle"
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
        "status": "pass",
        "framework": "vitest",
        "startedAt": "2026-10-25T19:41:13.557Z",
        "finishedAt": "2026-10-25T19:41:14.148Z",
        "durationMs": 591,
        "commitSha": "0f9e16607008b5c7f930091a836a80d786268b5a",
        "runGroupId": null,
        "source": "mutation-probe",
        "branch": null,
        "outputTail": null,
        "loopLagP95Ms": null,
        "rssMb": 341.1,
        "saturationSuspect": null,
        "worktreeDirty": false,
        "isScratchConfig": false,
        "cases": [
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['absolute local time']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 140,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['relative duration']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 108,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['ANSI and wrapped output']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 109,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['newest statement']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 106,
            "errorTail": null
          },
          {
            "caseKey": "host discovery quota reset publication (R28) > publishes the parsed provider reset instant as quotaResetAtMs on the host record ['no stated reset']",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 108,
            "errorTail": null
          },
          {
            "caseKey": "provider detector replay mode follows the replacement child > quota ignores resumed history after a fresh launch, then detects a fresh failure",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "provider detector replay mode follows the replacement child > auth ignores resumed history after a fresh launch, then detects a fresh failure",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses the incident copy as a local-time instant",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses the clause after ANSI styling and terminal line wraps",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > parses a relative duration from the moment it is read",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > reads a bare time already past as tomorrow, and a yearless past date as next year",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > uses the newest statement when the window holds an older wall too",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "parseQuotaResetAtMs (WI-6554700010008412) > never returns a reset that is not in the future, and never parses other products",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > holds the incident latch until the stated reset, then expires it once",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 2,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > re-latches with the new reset when the wall is still up on the next turn",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > picks up a reset clause that arrives in a later chunk than the matched words",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > keeps the fail-closed level when no reset is stated and probing is off (control)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > probes a latched codex wall before its stated reset, backing off while it stays walled",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 1,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > starts a new episode at the base interval once a wall returns long after the last probe",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > never probes a claude wall (its TUI auto-continues at the reset)",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
            "errorTail": null
          },
          {
            "caseKey": "makeQuotaBlockDetector reset expiry (WI-6554700010008412) > clears the parsed reset on recycle",
            "occurrence": 1,
            "status": "pass",
            "durationMs": 0,
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
  },
  "probeLogs": [
    {
      "path": "/tmp/parked-r29-mutant-safe-20261025-424d5.log",
      "bytes": 67688,
      "sha256": "0e2c5ec1f1dd797efe9fe736d1341fb4b1d1fbd906491127e818aa76f5c9d957",
      "descriptor": [
        {
          "cwd": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
          "argv": [
            "--file",
            "apps/operator/scripts/psu-pty-host.mjs",
            "--mutate",
            "s/const dueReset = blocked && resetAtMs != null && expiryAt >= resetAtMs \\+ resetGraceMs;/const dueReset = false;/",
            "--test",
            "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "--relocation",
            "overlay",
            "--fake-destructive"
          ],
          "result": {
            "baselineExit": 0,
            "guardExit": 1,
            "verdict": "caught",
            "mutantLedger": "test_runs:22056073",
            "target": "copy-out",
            "expected": "caught",
            "assertionEvidence": "test-file-assertion-failure",
            "relocation": "overlay",
            "baselineLedger": "test_runs:22055500",
            "copyBaselineLedger": "test_runs:22055502",
            "mutantParse": "ok"
          },
          "runnerPath": "scripts/mutation-probe.sh",
          "runnerSha256": "e621acee7ead3bfbc43f30d5a8e62f71506b80f5ef80660fe0092150af0aa403",
          "environment": {
            "PAPERCUSP_TEST_RUN_HARNESS": "papercusp",
            "PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL": "http://127.0.0.1:9171/api/health",
            "PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT": "auto",
            "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED": 1,
            "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO": "/home/marsh-office/papercupai-workspace/papercusp"
          },
          "schemaVersion": 1,
          "runnerCommit": "737afe86458adb2220ba0c9a4d021c21397514d9"
        }
      ],
      "treeIntegrity": [
        "[mutation-probe] tree integrity: VERIFIED — /tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG/apps/operator/scripts/psu-pty-host.mjs is byte-identical to its pre-probe state"
      ]
    },
    {
      "path": "/tmp/parked-r30-mutant-safe-20261025-424d5.log",
      "bytes": 68971,
      "sha256": "fc337797458a15f5c4e733e4e4ddb5f8c892ce0da367059c250080dadf47831a",
      "descriptor": [
        {
          "runnerSha256": "e621acee7ead3bfbc43f30d5a8e62f71506b80f5ef80660fe0092150af0aa403",
          "runnerCommit": "737afe86458adb2220ba0c9a4d021c21397514d9",
          "environment": {
            "PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT": "auto",
            "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO": "/home/marsh-office/papercupai-workspace/papercusp",
            "PAPERCUSP_TEST_RUN_HARNESS": "papercusp",
            "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED": 1,
            "PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL": "http://127.0.0.1:9171/api/health"
          },
          "runnerPath": "scripts/mutation-probe.sh",
          "schemaVersion": 1,
          "cwd": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
          "argv": [
            "--file",
            "apps/operator/scripts/psu-pty-host.mjs",
            "--mutate",
            "s/const dueProbe = blocked && !dueReset && probing/const dueProbe = false \\&\\& !dueReset \\&\\& probing/",
            "--test",
            "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "--relocation",
            "overlay",
            "--fake-destructive"
          ],
          "result": {
            "mutantLedger": "test_runs:22056235",
            "baselineExit": 0,
            "copyBaselineLedger": "test_runs:22056231",
            "guardExit": 1,
            "baselineLedger": "test_runs:22056230",
            "verdict": "caught",
            "assertionEvidence": "test-file-assertion-failure",
            "expected": "caught",
            "relocation": "overlay",
            "mutantParse": "ok",
            "target": "copy-out"
          }
        }
      ],
      "treeIntegrity": [
        "[mutation-probe] tree integrity: VERIFIED — /tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG/apps/operator/scripts/psu-pty-host.mjs is byte-identical to its pre-probe state"
      ]
    },
    {
      "path": "/tmp/parked-r31-mutant-safe-20261025-424d5.log",
      "bytes": 64012,
      "sha256": "dd6fd812d33ae90acbaea9834d9660f933ec93aa29e696e1839a1070e6de503e",
      "descriptor": [
        {
          "argv": [
            "--file",
            "apps/operator/scripts/psu-pty-host.mjs",
            "--mutate",
            "s/if \\(hit.matched && resetAtMs == null\\) resetAtMs =/if (hit.matched \\&\\& resetAtMs == null \\&\\& lastExpiryAtMs == null) resetAtMs =/",
            "--test",
            "test -f {} && npm run test:file -- apps/operator/lib/psu-pty-host-quota-reset-expiry.test.ts",
            "--relocation",
            "overlay",
            "--fake-destructive"
          ],
          "result": {
            "expected": "caught",
            "target": "copy-out",
            "copyBaselineLedger": "test_runs:22057709",
            "baselineLedger": "test_runs:22057691",
            "guardExit": 1,
            "assertionEvidence": "test-file-assertion-failure",
            "baselineExit": 0,
            "verdict": "caught",
            "relocation": "overlay",
            "mutantParse": "ok",
            "mutantLedger": "test_runs:22057713"
          },
          "cwd": "/tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG",
          "schemaVersion": 1,
          "environment": {
            "PAPERCUSP_TEST_RUN_HARNESS": "papercusp",
            "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED": 1,
            "PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT": "auto",
            "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO": "/home/marsh-office/papercupai-workspace/papercusp",
            "PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL": "http://127.0.0.1:9171/api/health"
          },
          "runnerCommit": "74c53ce381b22d79173fe0e96bf138be76c9f149",
          "runnerPath": "scripts/mutation-probe.sh",
          "runnerSha256": "e621acee7ead3bfbc43f30d5a8e62f71506b80f5ef80660fe0092150af0aa403"
        }
      ],
      "treeIntegrity": [
        "[mutation-probe] tree integrity: VERIFIED — /tmp/pcv/papercusp-lint-as-committed-0f9e166070-utlXNG/apps/operator/scripts/psu-pty-host.mjs is byte-identical to its pre-probe state"
      ]
    }
  ],
  "predecessorArtifact": "audits/parked-agent-resumption-2026-10-09/r27-clean-mechanical-proof-22052412-424d5.json"
}
