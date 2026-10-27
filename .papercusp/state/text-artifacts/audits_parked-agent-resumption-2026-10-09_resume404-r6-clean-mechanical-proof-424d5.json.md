---
rel_path: "audits/parked-agent-resumption-2026-10-09/resume404-r6-clean-mechanical-proof-424d5.json"
updated_at: 1793042488939
_body: "content"
---

{
  "schemaVersion": 1,
  "scope": "R6 revision3 current mechanical proof only; not whole-plan/runtime/24h acceptance",
  "workItem": "WI-6554700010008887",
  "clause": "AUTO-BAR-R-6-P-006",
  "sourceRef": "82c8e15b190f87c57cabedfc5035d03589152982",
  "observedAt": "2026-10-26T19:11:05.943332+00:00",
  "falsePremiseCorrected": "The target refusal was corrected by the predecessor: binding71324 was accepted, but dirty provenance prevented current proof. No retry of that accepted bind was necessary.",
  "retainedPassingSuites": {
    "bindings": [
      71314,
      71315,
      71316,
      71320
    ],
    "runs": [
      22247387,
      22247386,
      22247385,
      22249447
    ],
    "rerun": false
  },
  "mutation": {
    "runnerCommit": "82c8e15b190f87c57cabedfc5035d03589152982",
    "schemaVersion": 1,
    "runnerPath": "scripts/mutation-probe.sh",
    "result": {
      "relocation": "overlay",
      "verdict": "caught",
      "copyBaselineLedger": "test_runs:22250012",
      "expected": "caught",
      "baselineExit": 0,
      "mutantParse": "ok",
      "guardExit": 1,
      "target": "copy-out",
      "baselineLedger": "test_runs:22250007",
      "mutantLedger": "test_runs:22250013",
      "assertionEvidence": "test-file-assertion-failure"
    },
    "runnerSha256": "ce4b63547d86be6e5a2b2d06ce74542df80b049034b9d871f5870d76bbaf7441",
    "argv": [
      "--file",
      "packages/operator-core/lib/events/await/turn-proof.ts",
      "--mutate",
      "s/return 'awaiting';/return 'host-attested';/",
      "--test",
      "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/events/await/turn-proof.test.ts",
      "--relocation",
      "overlay",
      "--expect",
      "caught"
    ],
    "environment": {
      "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED": 1,
      "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO": "/tmp/pcv/papercusp-lint-as-committed-82c8e15b19-zpys4l",
      "PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT": "auto",
      "PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL": "http://127.0.0.1:9171/api/health",
      "PAPERCUSP_TEST_RUN_HARNESS": "papercusp"
    },
    "cwd": "."
  },
  "causalControls": {
    "baselineTestRunId": 22250007,
    "copyBaselineTestRunId": 22250012,
    "mutantTestRunId": 22250013
  },
  "ledgerMeasured": [
    {
      "id": 22250007,
      "phase": "baseline",
      "passed": 36,
      "failed": 0,
      "skipped": 0,
      "worktreeDirty": false
    },
    {
      "id": 22250012,
      "phase": "copy-baseline",
      "passed": 36,
      "failed": 0,
      "skipped": 0,
      "worktreeDirty": false
    },
    {
      "id": 22250013,
      "phase": "mutant",
      "passed": 34,
      "failed": 2,
      "skipped": 0,
      "worktreeDirty": false
    }
  ],
  "failedAssertions": [
    "initialTurnProof (P-006/D-004) > books the inbox fallback as awaiting, never as a started turn",
    "initialTurnProof (P-006/D-004) > books every unattested turn-burning channel as awaiting"
  ],
  "bindingReceipt": {
    "ok": true,
    "results": [
      {
        "ok": true,
        "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "derivedFromTestRun": {
          "testRunId": 22250013,
          "evidenceKind": "mutation",
          "evidenceRef": "test-run 22250013 mutation-probe mutant fail packages/operator-core/lib/events/await/turn-proof.test.ts @82c8e15b190f",
          "measurement": {
            "schemaVersion": 1,
            "kind": "repo-files",
            "sourcePaths": [
              "packages/operator-core/lib/events/await/turn-proof.ts",
              "packages/operator-core/lib/events/await/types.ts"
            ],
            "testPaths": [
              "packages/operator-core/lib/events/await/turn-proof.test.ts"
            ],
            "fixturePaths": [
              "packages/operator-core/lib/events/await/turn-proof.test.ts"
            ]
          },
          "harnessAttribution": "run"
        },
        "status": "created",
        "id": 71334,
        "workItemId": "WI-10008157",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-6-P-006",
        "sourceValId": null,
        "specRevision": 3,
        "specFingerprint": "493d3c0e30fedaf077185310c85d0f46dcfbb3394fb40423cf0215347a4bed48",
        "bindingFingerprint": "bf2314c8b3f1f1f847032271886b7a761ab869e3ac4a43559e46c6140f7815cb"
      }
    ],
    "counts": {
      "ok": 1,
      "failed": 0
    }
  },
  "evaluator": {
    "ok": true,
    "evaluatorBuild": {
      "sha": "82c8e15b19",
      "version": "0.0.0"
    },
    "verdicts": {
      "pass": 1,
      "fail": 0,
      "unknown": 0
    },
    "rows": [
      {
        "specId": "AUTO-BAR-R-6-P-006",
        "specRevision": 3,
        "verdict": "pass",
        "mechanicalProof": {
          "applicable": true,
          "verdict": "pass",
          "requiredFiles": [
            "packages/operator-core/lib/agent-tools/coordination/tools/wake.test.ts",
            "packages/operator-core/lib/events/await/pickup-sweep.test.ts",
            "packages/operator-core/lib/events/await/turn-proof.test.ts",
            "packages/operator-core/lib/events/await/wake-executor.test.ts"
          ],
          "passingTestBindingIds": {
            "packages/operator-core/lib/agent-tools/coordination/tools/wake.test.ts": 71315,
            "packages/operator-core/lib/events/await/pickup-sweep.test.ts": 71320,
            "packages/operator-core/lib/events/await/turn-proof.test.ts": 71316,
            "packages/operator-core/lib/events/await/wake-executor.test.ts": 71314
          },
          "caughtMutantBindingIds": [
            71334
          ],
          "gaps": []
        }
      }
    ]
  },
  "independentCurrentness": {
    "ok": true,
    "evidence": [
      {
        "id": 71334,
        "testRunId": 22250013,
        "specId": "AUTO-BAR-R-6-P-006",
        "specRevision": 3,
        "currentness": {
          "overall": "current",
          "staleReasons": [],
          "unknownReasons": []
        }
      },
      {
        "id": 71320,
        "testRunId": 22249447,
        "specId": "AUTO-BAR-R-6-P-006",
        "specRevision": 3,
        "currentness": {
          "overall": "current",
          "staleReasons": [],
          "unknownReasons": []
        }
      },
      {
        "id": 71316,
        "testRunId": 22247385,
        "specId": "AUTO-BAR-R-6-P-006",
        "specRevision": 3,
        "currentness": {
          "overall": "current",
          "staleReasons": [],
          "unknownReasons": []
        }
      },
      {
        "id": 71315,
        "testRunId": 22247386,
        "specId": "AUTO-BAR-R-6-P-006",
        "specRevision": 3,
        "currentness": {
          "overall": "current",
          "staleReasons": [],
          "unknownReasons": []
        }
      },
      {
        "id": 71314,
        "testRunId": 22247387,
        "specId": "AUTO-BAR-R-6-P-006",
        "specRevision": 3,
        "currentness": {
          "overall": "current",
          "staleReasons": [],
          "unknownReasons": []
        }
      }
    ]
  },
  "logs": {
    "cleanMutation": {
      "path": "/tmp/parked-resume404-r6-clean-mutation-424d5.log",
      "sha256": "d284a7a40fef651c51e8f28612e382fb9f2ec394c13cee39a5584a41d93eeaeb"
    },
    "originalSuites": "/tmp/parked-resume402-r6-committed-v2-424d5.log",
    "fourthSuite": "/tmp/parked-resume403-r6-pickup-committed-424d5.log"
  },
  "sourcePreflight": {
    "phase": "source-preflight",
    "root": "/tmp/pcv/papercusp-lint-as-committed-82c8e15b19-zpys4l",
    "ref": "82c8e15b190f87c57cabedfc5035d03589152982",
    "head": "82c8e15b190f87c57cabedfc5035d03589152982",
    "clean": true
  },
  "containment": "MUTATION_PROBE_CONTAINMENT status=contained overlays=1 uncovered=0 failed=0",
  "treeIntegrity": "[mutation-probe] tree integrity: VERIFIED — /tmp/pcv/papercusp-lint-as-committed-82c8e15b19-zpys4l/packages/operator-core/lib/events/await/turn-proof.ts is byte-identical to its pre-probe state",
  "terminal": {
    "phase": "mutation-terminal",
    "root": "/tmp/pcv/papercusp-lint-as-committed-82c8e15b19-zpys4l",
    "ref": "82c8e15b190f87c57cabedfc5035d03589152982",
    "code": 0,
    "signal": null
  },
  "unchangedWalls": [
    "original116/frozen cohort",
    "strict final24h runtime acceptance",
    "provider/private-host/launcher/P013 owner-gated obligations",
    "historical timeout owner-to-workflow/inner-await cause UNKNOWN",
    "no live-gate/native-driver/staging-repair/publisher takeover"
  ],
  "productionSourceEdits": [],
  "governingCertification": {
    "ok": true,
    "dryRun": false,
    "evaluatorBuild": {
      "sha": "e3d8713b02",
      "version": "0.0.0"
    },
    "governing": true,
    "classRef": "plan-class-bugfix",
    "counts": {
      "clauses": 1,
      "passing": 1,
      "filed": 0,
      "unchanged": 0,
      "refused": 0,
      "notPassing": 0,
      "mechanicallyVerified": 1
    },
    "clauses": [
      {
        "specId": "AUTO-BAR-R-6-P-006",
        "specRevision": 3,
        "verdict": "pass",
        "wouldBlock": [],
        "mechanicalProof": {
          "applicable": true,
          "verdict": "pass",
          "requiredFiles": [
            "packages/operator-core/lib/agent-tools/coordination/tools/wake.test.ts",
            "packages/operator-core/lib/events/await/pickup-sweep.test.ts",
            "packages/operator-core/lib/events/await/turn-proof.test.ts",
            "packages/operator-core/lib/events/await/wake-executor.test.ts"
          ],
          "passingTestBindingIds": {
            "packages/operator-core/lib/agent-tools/coordination/tools/wake.test.ts": 71315,
            "packages/operator-core/lib/events/await/pickup-sweep.test.ts": 71320,
            "packages/operator-core/lib/events/await/turn-proof.test.ts": 71316,
            "packages/operator-core/lib/events/await/wake-executor.test.ts": 71314
          },
          "caughtMutantBindingIds": [
            71334
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
    }
  },
  "certificationScope": "Unpinned R6 revision3 governing mechanical adequacy only. Not full work-item completion, plan ship readiness or runtime acceptance."
}
