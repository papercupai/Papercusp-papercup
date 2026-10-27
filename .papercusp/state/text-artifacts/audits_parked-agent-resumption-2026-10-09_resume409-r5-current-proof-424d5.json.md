---
rel_path: "audits/parked-agent-resumption-2026-10-09/resume409-r5-current-proof-424d5.json"
updated_at: 1793062127235
_body: "content"
---

{
  "schemaVersion": 1,
  "measuredAt": "2026-10-27T00:48:46.176859+00:00",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "workItemId": "WI-6554700010008887",
  "specId": "AUTO-BAR-R-5-P-005",
  "specRevision": 3,
  "fixedCommit": "2d61978ba573da1a7cfeeb6ccfc6c89c5a88fc91",
  "durableTaskId": "0mvpyn3tr5h7pyy7ycm",
  "taskTerminal": {
    "status": "completed",
    "exitCode": 0,
    "finishedAt": "2026-10-27T00:44:58.108Z"
  },
  "runs": {
    "baseline": {
      "id": 22276404,
      "pass": 4,
      "filtered": 133
    },
    "copiedBaseline": {
      "id": 22276482,
      "pass": 4,
      "filtered": 133
    },
    "mutant": {
      "id": 22276499,
      "fail": 3,
      "pass": 1,
      "filtered": 133
    },
    "boundedSuccessor": {
      "id": 22276512,
      "pass": 4,
      "filtered": 78
    }
  },
  "sourceFootprint": [
    {
      "path": "apps/operator/scripts/psu-pty-host.mjs",
      "sha256": "1093ec8735046e0ccf33dacbf5f7fe158363fad8b1f9ec40849b1185da670448",
      "workingEqualsFixedCommit": true
    },
    {
      "path": "apps/operator/scripts/psu-launcher.mjs",
      "sha256": "031ddc94b3bb1bd2bd822de6d5299dd2ce39bcf77856c85b176851028557e5a0",
      "workingEqualsFixedCommit": true
    },
    {
      "path": "apps/operator/scripts/hooks/cc/dialog-answer-provenance.mjs",
      "sha256": "a72aeb82beb2c1b5f363dcadb29994a45bf19952780f53196a2e63cdf482186b",
      "workingEqualsFixedCommit": true
    },
    {
      "path": "apps/operator/vitest-shims/psu-pty-temp-dir.ts",
      "sha256": "651cac8c6257ab7dad254658dbd1474c2c94e814424a44532bfd6571307da910",
      "workingEqualsFixedCommit": true
    },
    {
      "path": "apps/operator/lib/psu-pty-host.integration.test.ts",
      "sha256": "f816563b54d25533562caa426d2ad4f602ab6e5939f7a3c5e7fd2ac2470d3edc",
      "workingEqualsFixedCommit": true
    },
    {
      "path": "apps/operator/lib/psu-pty-host-turn.integration.test.ts",
      "sha256": "427e4424f70d661a2e1e6e5cfc50a587608b0252a07207b2ca1a864e95b2fe46",
      "workingEqualsFixedCommit": true
    }
  ],
  "mutationEvidence": {
    "schemaVersion": 1,
    "result": {
      "baselineLedger": "test_runs:22276404",
      "expected": "caught",
      "relocation": "overlay",
      "verdict": "caught",
      "mutantParse": "ok",
      "guardExit": 1,
      "baselineExit": 0,
      "copyBaselineLedger": "test_runs:22276482",
      "target": "copy-out",
      "assertionEvidence": "test-file-assertion-failure",
      "mutantLedger": "test_runs:22276499"
    },
    "cwd": ".",
    "runnerCommit": "2d61978ba573da1a7cfeeb6ccfc6c89c5a88fc91",
    "runnerPath": "scripts/mutation-probe.sh",
    "argv": [
      "--file",
      "apps/operator/scripts/psu-pty-host.mjs",
      "--mutate",
      "s/\\Qexport function hostThroughPty(o) {\\E/export function hostThroughPty(o) { o = { ...o, onRespawn: () => true };/",
      "--test",
      "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs apps/operator/lib/psu-pty-host.integration.test.ts -t \"carry completion follows native delivery and reanchor\"",
      "--relocation",
      "overlay",
      "--fake-destructive",
      "--expect",
      "caught"
    ],
    "runnerSha256": "ce4b63547d86be6e5a2b2d06ce74542df80b049034b9d871f5870d76bbaf7441",
    "environment": {
      "PAPERCUSP_TEST_RUN_HARNESS": "papercusp",
      "PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT": "auto",
      "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO": "/tmp/pcv/papercusp-lint-as-committed-2d61978ba5-pMginP",
      "PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL": "http://127.0.0.1:3170/api/health",
      "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED": 1
    }
  },
  "priorSurvivor": {
    "runId": 22258930,
    "disposition": "not accepted as caught proof",
    "reason": "Early-binding bypass preserved fallback onRespawn before emission; replacement fault disables reporting at the shared host boundary."
  },
  "bindings": [
    {
      "id": 71622,
      "testRunId": 22276512,
      "kind": "test",
      "currentness": "current",
      "staleReasons": [],
      "unknownReasons": []
    },
    {
      "id": 71621,
      "testRunId": 22276499,
      "kind": "mutation",
      "currentness": "current",
      "staleReasons": [],
      "unknownReasons": []
    },
    {
      "id": 71616,
      "testRunId": 22276404,
      "kind": "test",
      "currentness": "current",
      "staleReasons": [],
      "unknownReasons": []
    }
  ],
  "evaluation": {
    "ok": true,
    "evaluatorBuild": {
      "sha": "5b408fc4ae",
      "version": "0.0.0"
    },
    "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
    "harnessSlug": "papercusp",
    "classRef": "plan-class-bugfix",
    "declaredClassRef": "plan-class-bugfix",
    "classRefSource": "active-acceptance-rubric",
    "rubricRef": "spec-test-adequacy",
    "governing": true,
    "includeDraft": false,
    "excludedDraftCount": 0,
    "excludedDraftSpecIds": [],
    "excludedClauses": [],
    "detail": "summary",
    "rows": [
      {
        "evaluationMode": "mechanical",
        "planSlug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specId": "AUTO-BAR-R-5-P-005",
        "specRevision": 3,
        "specFingerprint": "8d2a02e71aa7f6c023af64aea52e863ef124143d043c30ddeb1240927ea607e5",
        "planItemId": "P-005",
        "verdict": "pass",
        "wouldBlock": [],
        "mechanicalProof": {
          "applicable": true,
          "verdict": "pass",
          "requiredFiles": [
            "apps/operator/lib/psu-pty-host.integration.test.ts"
          ],
          "passingTestBindingIds": {
            "apps/operator/lib/psu-pty-host.integration.test.ts": 71616
          },
          "caughtMutantBindingIds": [
            71621
          ],
          "gaps": []
        },
        "measurementEvidence": {
          "status": "measured",
          "selectedBindings": 9,
          "measuredBindings": 9,
          "unavailableBindings": [],
          "withoutMeasurementBasis": [],
          "bindings": [
            {
              "bindingId": 38797,
              "evidenceKind": "test",
              "evidenceRef": "test-run-group:59cf9663-ae1e-4168-be30-7e529b6fc576:0",
              "status": "measured",
              "measuredAtCommit": "2d61978ba573da1a7cfeeb6ccfc6c89c5a88fc91",
              "measurementFingerprint": "sha256:24b1bdecc8fb86a89a0b40e86eba9780582fc073e0d476ca6dc733ac2e5ab31d"
            },
            {
              "bindingId": 38798,
              "evidenceKind": "mutation",
              "evidenceRef": "test-run 20993814 mutation-probe mutant fail apps/operator/lib/psu-pty-host-turn.integration.test.ts @41340bb256df+dirty",
              "status": "measured",
              "measuredAtCommit": "2d61978ba573da1a7cfeeb6ccfc6c89c5a88fc91",
              "measurementFingerprint": "sha256:24b1bdecc8fb86a89a0b40e86eba9780582fc073e0d476ca6dc733ac2e5ab31d"
            },
            {
              "bindingId": 45628,
              "evidenceKind": "test",
              "evidenceRef": "test-run-group:0d4c5b97-0d2d-430a-b08d-bb9c8dc203ec:1",
              "status": "measured",
              "measuredAtCommit": "2d61978ba573da1a7cfeeb6ccfc6c89c5a88fc91",
              "measurementFingerprint": "sha256:24b1bdecc8fb86a89a0b40e86eba9780582fc073e0d476ca6dc733ac2e5ab31d"
            },
            {
              "bindingId": 48199,
              "evidenceKind": "test",
              "evidenceRef": "test-run-group:455a9233-bb86-4c36-98fd-88a400c3895d:0",
              "status": "measured",
              "measuredAtCommit": "2d61978ba573da1a7cfeeb6ccfc6c89c5a88fc91",
              "measurementFingerprint": "sha256:24b1bdecc8fb86a89a0b40e86eba9780582fc073e0d476ca6dc733ac2e5ab31d"
            },
            {
              "bindingId": 71448,
              "evidenceKind": "test",
              "evidenceRef": "apps/operator/lib/psu-pty-host-turn.integration.test.ts",
              "status": "measured",
              "measuredAtCommit": "2d61978ba573da1a7cfeeb6ccfc6c89c5a88fc91",
              "measurementFingerprint": "sha256:33b9519e68b1525be66121c53e8a4b4eef750030782aba88978b14aba69572f9"
            },
            {
              "bindingId": 71449,
              "evidenceKind": "test",
              "evidenceRef": "apps/operator/lib/psu-pty-host.integration.test.ts",
              "status": "measured",
              "measuredAtCommit": "2d61978ba573da1a7cfeeb6ccfc6c89c5a88fc91",
              "measurementFingerprint": "sha256:29412ce82aa486d91f7baf7f2fe4e6173eeed87ba7871ad62e6dd9699de2d6cf"
            },
            {
              "bindingId": 71616,
              "evidenceKind": "test",
              "evidenceRef": "apps/operator/lib/psu-pty-host.integration.test.ts",
              "status": "measured",
              "measuredAtCommit": "2d61978ba573da1a7cfeeb6ccfc6c89c5a88fc91",
              "measurementFingerprint": "sha256:29412ce82aa486d91f7baf7f2fe4e6173eeed87ba7871ad62e6dd9699de2d6cf"
            },
            {
              "bindingId": 71621,
              "evidenceKind": "mutation",
              "evidenceRef": "test-run 22276499 mutation-probe mutant fail apps/operator/lib/psu-pty-host.integration.test.ts @2d61978ba573",
              "status": "measured",
              "measuredAtCommit": "2d61978ba573da1a7cfeeb6ccfc6c89c5a88fc91",
              "measurementFingerprint": "sha256:29412ce82aa486d91f7baf7f2fe4e6173eeed87ba7871ad62e6dd9699de2d6cf"
            },
            {
              "bindingId": 71622,
              "evidenceKind": "test",
              "evidenceRef": "apps/operator/lib/psu-pty-host-turn.integration.test.ts",
              "status": "measured",
              "measuredAtCommit": "2d61978ba573da1a7cfeeb6ccfc6c89c5a88fc91",
              "measurementFingerprint": "sha256:33b9519e68b1525be66121c53e8a4b4eef750030782aba88978b14aba69572f9"
            }
          ]
        }
      }
    ],
    "fullBody": {
      "tool": "plans:evaluate-spec-test-adequacy",
      "args": {
        "harness": "papercusp",
        "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
        "specIds": [
          "AUTO-BAR-R-5-P-005"
        ],
        "detail": "full"
      },
      "omitted": [
        "rows[].ratings[].evidence",
        "rows[].evidenceRefs",
        "rows[].scorecardDraft"
      ]
    },
    "count": 1,
    "verdicts": {
      "pass": 1,
      "fail": 0,
      "unknown": 0
    },
    "wouldBlock": [],
    "uncoveredWorkItemSelection": null
  },
  "certification": {
    "ok": true,
    "dryRun": false,
    "slug": "parked-agent-census-resumption-and-root-cause-2026-10-09",
    "evaluatorBuild": {
      "sha": "5b408fc4ae",
      "version": "0.0.0"
    },
    "classRef": "plan-class-bugfix",
    "governing": true,
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
        "specId": "AUTO-BAR-R-5-P-005",
        "specRevision": 3,
        "verdict": "pass",
        "wouldBlock": [],
        "measurementEvidence": {
          "status": "measured",
          "selectedBindings": 9,
          "measuredBindings": 9,
          "unavailableBindings": [],
          "withoutMeasurementBasis": [],
          "bindings": [
            {
              "bindingId": 38797,
              "evidenceKind": "test",
              "evidenceRef": "test-run-group:59cf9663-ae1e-4168-be30-7e529b6fc576:0",
              "status": "measured",
              "measuredAtCommit": "2d61978ba573da1a7cfeeb6ccfc6c89c5a88fc91",
              "measurementFingerprint": "sha256:24b1bdecc8fb86a89a0b40e86eba9780582fc073e0d476ca6dc733ac2e5ab31d"
            },
            {
              "bindingId": 38798,
              "evidenceKind": "mutation",
              "evidenceRef": "test-run 20993814 mutation-probe mutant fail apps/operator/lib/psu-pty-host-turn.integration.test.ts @41340bb256df+dirty",
              "status": "measured",
              "measuredAtCommit": "2d61978ba573da1a7cfeeb6ccfc6c89c5a88fc91",
              "measurementFingerprint": "sha256:24b1bdecc8fb86a89a0b40e86eba9780582fc073e0d476ca6dc733ac2e5ab31d"
            },
            {
              "bindingId": 45628,
              "evidenceKind": "test",
              "evidenceRef": "test-run-group:0d4c5b97-0d2d-430a-b08d-bb9c8dc203ec:1",
              "status": "measured",
              "measuredAtCommit": "2d61978ba573da1a7cfeeb6ccfc6c89c5a88fc91",
              "measurementFingerprint": "sha256:24b1bdecc8fb86a89a0b40e86eba9780582fc073e0d476ca6dc733ac2e5ab31d"
            },
            {
              "bindingId": 48199,
              "evidenceKind": "test",
              "evidenceRef": "test-run-group:455a9233-bb86-4c36-98fd-88a400c3895d:0",
              "status": "measured",
              "measuredAtCommit": "2d61978ba573da1a7cfeeb6ccfc6c89c5a88fc91",
              "measurementFingerprint": "sha256:24b1bdecc8fb86a89a0b40e86eba9780582fc073e0d476ca6dc733ac2e5ab31d"
            },
            {
              "bindingId": 71448,
              "evidenceKind": "test",
              "evidenceRef": "apps/operator/lib/psu-pty-host-turn.integration.test.ts",
              "status": "measured",
              "measuredAtCommit": "2d61978ba573da1a7cfeeb6ccfc6c89c5a88fc91",
              "measurementFingerprint": "sha256:33b9519e68b1525be66121c53e8a4b4eef750030782aba88978b14aba69572f9"
            },
            {
              "bindingId": 71449,
              "evidenceKind": "test",
              "evidenceRef": "apps/operator/lib/psu-pty-host.integration.test.ts",
              "status": "measured",
              "measuredAtCommit": "2d61978ba573da1a7cfeeb6ccfc6c89c5a88fc91",
              "measurementFingerprint": "sha256:29412ce82aa486d91f7baf7f2fe4e6173eeed87ba7871ad62e6dd9699de2d6cf"
            },
            {
              "bindingId": 71616,
              "evidenceKind": "test",
              "evidenceRef": "apps/operator/lib/psu-pty-host.integration.test.ts",
              "status": "measured",
              "measuredAtCommit": "2d61978ba573da1a7cfeeb6ccfc6c89c5a88fc91",
              "measurementFingerprint": "sha256:29412ce82aa486d91f7baf7f2fe4e6173eeed87ba7871ad62e6dd9699de2d6cf"
            },
            {
              "bindingId": 71621,
              "evidenceKind": "mutation",
              "evidenceRef": "test-run 22276499 mutation-probe mutant fail apps/operator/lib/psu-pty-host.integration.test.ts @2d61978ba573",
              "status": "measured",
              "measuredAtCommit": "2d61978ba573da1a7cfeeb6ccfc6c89c5a88fc91",
              "measurementFingerprint": "sha256:29412ce82aa486d91f7baf7f2fe4e6173eeed87ba7871ad62e6dd9699de2d6cf"
            },
            {
              "bindingId": 71622,
              "evidenceKind": "test",
              "evidenceRef": "apps/operator/lib/psu-pty-host-turn.integration.test.ts",
              "status": "measured",
              "measuredAtCommit": "2d61978ba573da1a7cfeeb6ccfc6c89c5a88fc91",
              "measurementFingerprint": "sha256:33b9519e68b1525be66121c53e8a4b4eef750030782aba88978b14aba69572f9"
            }
          ]
        },
        "mechanicalProof": {
          "applicable": true,
          "verdict": "pass",
          "requiredFiles": [
            "apps/operator/lib/psu-pty-host.integration.test.ts"
          ],
          "passingTestBindingIds": {
            "apps/operator/lib/psu-pty-host.integration.test.ts": 71616
          },
          "caughtMutantBindingIds": [
            71621
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
  "scope": "Current committed tree integration and calibrated mutation only. No original116 recovery outcome, strict24h runtime acceptance, whole-plan completion, or shipment claim.",
  "remaining": "Original116 eligibility/continuity/outcomes, strict>=24h loaded-runtime contract, real-provider/private-host/root961/launcher/P013 walls and historical archival timeout remain."
}

