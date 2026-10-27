---
rel_path: "evidence/bg-host-p001-fire74-recipe-output-20261026.json"
updated_at: 1792973505148
_body: "content"
---

{
  "schemaVersion": "bg-p001-detached-recipe-proof-v1",
  "createdAt": "2026-10-26T00:11:44.747Z",
  "owner": "su-4585c0c9-eddc-47a6-b7d4-54c22bbfd2b3",
  "nativeThread": "01a17569-f537-7e52-a97a-a94e9d3111f2",
  "workItem": "WI-6554700010028547",
  "plan": "bg-host-committed-generation-2026-10-24",
  "item": "P-001",
  "scope": "Local detached output-only recipe integration. P001 remains open.",
  "changes": [
    "Explicit --publish-qualified-output-only shell route validates the original transaction digest, recipe command, actual Node and builder before invoking the exclusive recipe stage.",
    "runBgVerifierBuildRecipe compiles each retained original invocation sequentially with private esbuild 0.25.0, qualifies complete temporary and logical outputs, and verifies the published evidence.",
    "Publication retains original binding, compiler receipts and qualified output set alongside the logical record; verification rejects swapped original evidence.",
    "Failed later compilation leaves an unpublished private stage and original evidence; re-entry refuses the existing attempt. Missing nominated publication destination refuses before stage creation."
  ],
  "metrics": {
    "files": {
      "scripts/source-preview.mjs": {
        "sha256": "92b8e6176d0c06ea0dfd745f2b03f5b16a118e8829c011076fd5959d50077118",
        "gitBlob": "a78b4aca7b50711792857f4de77b63375452f987"
      },
      "scripts/source-preview.d.mts": {
        "sha256": "81ede40215c099139f3e3bfbb38ce4bb2e31828961b84f1c5e879bc8ef8e5eaa",
        "gitBlob": "2fb98f9697f6c494da8d26769f9b97a49de60830"
      },
      "apps/operator/bin/bundle-host.sh": {
        "sha256": "1c79a34f8edda032ecd246ce39082781ef1a95a39697e7bfd9b2eef5d34908f3",
        "gitBlob": "3f6e0cfdb3e5878d2d63f71e5de5cbe06799a4ba"
      },
      "packages/operator-core/lib/source-preview-export.test.ts": {
        "sha256": "47f577802e43af85a643f3305d947119377bdb33873cdadcad6a2cbd3ba2f331",
        "gitBlob": "4a6e5cbdc593503788e799e7c28f309bc90fc896"
      }
    },
    "logs": {
      "/tmp/bg-host-fire74-recipe-20261025.log": {
        "sha256": "d4a53f58c4f4b9bfcb84c53084be3ad80ca039e1c12ac271a1ebcb4181840d51",
        "bytes": 193600,
        "summaries": [
          "TEST_FILE_GROUP_RESULT cwd=packages/operator-core executed=1 status=failed",
          " Test Files  1 failed (1)",
          "      Tests  1 failed | 2 passed | 371 skipped (374)",
          "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=failed head=851ec1dffb uncommittedPaths=1/1 provenance=stamped startedAt=2026-10-25T23:50:23.525Z childSubstituted=0 skippedTests=371"
        ]
      },
      "/tmp/bg-host-fire74-recipe-fixed-20261025.log": {
        "sha256": "affc1ac017cc875ac84952e6b1c6c2de94b3daf16ff76b2368fef295dfefce14",
        "bytes": 153264,
        "summaries": [
          " Test Files  1 passed (1)",
          "      Tests  3 passed | 371 skipped (374)",
          "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=851ec1dffb uncommittedPaths=1/1 provenance=stamped startedAt=2026-10-25T23:52:45.378Z childSubstituted=0 skippedTests=371"
        ]
      },
      "/tmp/bg-host-fire74-publication-regression-20261025.log": {
        "sha256": "0b94d0ddd13d64e72fc082c6ac8c2fa7ac40f62cc471e5410457eebae0d7bbac",
        "bytes": 168126,
        "summaries": [
          " Test Files  1 passed (1)",
          "      Tests  40 passed | 337 skipped (377)",
          "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=851ec1dffb uncommittedPaths=1/1 provenance=unknown startedAt=2026-10-25T23:56:10.900Z childSubstituted=0 skippedTests=337"
        ]
      },
      "/tmp/bg-host-fire74-final-tsc-20261025.log": {
        "sha256": "ce84142e5e90000c0e6fba3c4af4a4c4e32ba684f0a3ea0b423b76950aa9cd90",
        "bytes": 4910,
        "summaries": [
          "LINT_TSC_RUN_STAMP label=operator-core at=2026-10-26T00:00:08.617Z head=ff7390e194 scope=files files=2",
          "LINT_TSC_RUN_STAMP label=scripts at=2026-10-26T00:00:22.876Z head=ff7390e194 scope=files files=1",
          "LINT_TSC_RESULT label=scripts scope=files exit=0 status=clean at=2026-10-26T00:00:22.876Z head=ff7390e194",
          "LINT_TSC_RESULT label=operator-core scope=files exit=0 status=clean filesRoutedAway=1 at=2026-10-26T00:00:08.617Z head=ff7390e194"
        ]
      },
      "/tmp/bg-host-fire74-declarations-check-20261025.log": {
        "sha256": "87226833b9310e62dcb2b0abc78befbe11ad3533e4b6005ab4d11d797ca9ec6a",
        "bytes": 370,
        "summaries": []
      }
    },
    "head": "7a245c9263b91e8984cc10f0f9231982c7156add",
    "branch": "staging"
  },
  "testRuns": {
    "recipe": {
      "id": 22080681,
      "passed": 3,
      "failed": 0,
      "filtered": 371,
      "pattern": "BG recipe output-only mode",
      "provenance": "stamped",
      "childSubstituted": 0,
      "coverage": [
        "real maintained shell main+worker compilation and complete publication/readback",
        "later compiler failure leaves no partial publication and refuses replay",
        "missing original publication destination has no build effects"
      ],
      "testFileTiming": "Recipe run preceded the additive three evidence-swap regression cases; selected recipe case bodies are unchanged."
    },
    "publicationAndBinding": {
      "id": 22083503,
      "status": "pass",
      "harnessSlug": "papercusp",
      "workspaceId": "papercusp-workspace",
      "filePath": "packages/operator-core/lib/source-preview-export.test.ts",
      "commitSha": "08782a2fd406509db1257e3cbcd520553b26112a",
      "startedAt": "2026-10-25T23:56:21.875Z",
      "executionDetails": {
        "passed": 40,
        "failed": 0,
        "skipped": 337,
        "testNamePattern": "logical-output|binds the maintained BG recipe|refuses maintained BG recipe",
        "worktreeDirty": true,
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured",
        "runtimeEnvironmentAfterCaptureStatus": "not-configured"
      }
    },
    "publicationAndBindingRouter": {
      "provenance": "unknown",
      "childSubstituted": 0,
      "filtered": 337
    }
  },
  "verification": {
    "canonicalScopedTypecheck": {
      "exitCode": 0,
      "scopes": [
        "operator-core named test",
        "scripts declaration routed by canonical lint gate"
      ],
      "log": "/tmp/bg-host-fire74-final-tsc-20261025.log"
    },
    "declarationsParity": {
      "exitCode": 0,
      "log": "/tmp/bg-host-fire74-declarations-check-20261025.log"
    },
    "syntaxAndDiff": {
      "exitCode": 0,
      "checks": [
        "node --check scripts/source-preview.mjs",
        "bash -n apps/operator/bin/bundle-host.sh",
        "git diff --check for the four changed files"
      ]
    },
    "terminalNativeCommands": "All current native exec handles drained; no live command remains."
  },
  "failedAttempts": [
    {
      "log": "/tmp/bg-host-fire74-recipe-20261025.log",
      "reason": "Test expected unbound @BG_PID@ argv instead of retained compiler argv bound to actual shell PID. Assertion corrected; focused rerun passed."
    },
    {
      "runId": "f61fd59c-bab8-4add-b74c-860f89806946",
      "detachedRunId": "47075b4c-0828-4bbe-b588-6e2ef31a30eb",
      "reason": "Foreground testing tool cap returned detached recovery. Detached attempt failed at the same pre-correction assertion. It is terminal, not running."
    }
  ],
  "continuity": {
    "carryPayload": "Expired lagged Fire74 payload named Fire68, but live item/loop checkpoint was Fire73; recovered current state instead of reimplementing it.",
    "recoveryRef": "EI-25932550248841646#comment-1206117",
    "native": "fresh native thread verified; original owner/claim retained",
    "loop": "Existing cold loop retained; last measured rewakeGuaranteed false / last-fire-no-loop-turn. No duplicate loop armed."
  },
  "limitations": [
    "REAL original parent manifest remains UNKNOWN; actual source preparation and service activation are forbidden.",
    "This runs the caller-retained compiler population. Complete production recipe population, copied ancillary assets, resolver metadata/compiler self-consumption, closed workspace/dependency/external/runtime imports and R4 remain open.",
    "No BG serving cohort, service pointer, service restart, deployment, LIVE_GATE_OPS, BAR acceptance or authentic parent settlement was exercised.",
    "The selected test groups are local working-tree evidence; the regression router reports provenance unknown. Commit containment and runtime environment captures are unmeasured.",
    "D014 plan delta still needs its canonical activation/acceptance audit. P002/P003 independent acceptance remains separate."
  ],
  "retainedPriorEvidence": [
    "evidence/bg-host-p001-fire73-logical-publication-20261025.json",
    "evidence/bg-host-through-fire73-wip-952a8aae234b-20261025.md",
    "evidence/bg-host-p001-fire68-output-set-20261025.json",
    "evidence/bg-host-p001-fire67-recipe-binding-20261025.json"
  ]
}
