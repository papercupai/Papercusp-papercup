---
rel_path: "evidence/identity-assume/recovery94/classifier-proof-and-close-draft.json"
updated_at: 1793250536589
_body: "content"
---

{
  "edition": "Recovery94",
  "workItem": "EI-27286518152280621",
  "status": "verified-local-awaiting-committed-content-identity",
  "closeDraft": {
    "id": "EI-27286518152280621",
    "harness": "papercusp",
    "state": "done",
    "assumptions": "none",
    "validateOnly": true,
    "completion": {
      "summary": "Recognize Vitest's serialized promise-settlement AssertionError using its exact settlement message and immediate @vitest/expect matcher frame. Preserve rejection of runtime, hook, mismatched-origin and mixed failures.",
      "testsRun": [
        "npm run test:file -- libs/test-config/src/vitest-failure-classification.test.ts (before fix: 2 failed, 3 passed; /tmp/assume94-classifier-red.log)",
        "testing:run shared classifier: run ff6125ba-6bcc-4e54-9a9f-2d554c1f92ac, ledger22608718, 5 passed/0 failed/0 skipped",
        "testing:run router -t 'failed assertion diagnostics': run da5fd97f-af39-4d5c-a946-5517a977ea9c, ledger22608724, 5 passed/0 failed/234 filtered"
      ],
      "testResult": "Focused current-tree regressions passed. No full-router, PG mutation, native acceptance or shipment claim is made.",
      "verifiedHow": "Tests construct actual Vitest AssertionError objects, confirm their name, serialize stack||message exactly as the JSON reporter does, and exercise classifier and router marker consumers. Both real settlement assertions failed on the old classifier, then passed with the narrow fix. git diff --check passed in the superproject and test-config submodule.",
      "filesChanged": [
        "libs/test-config/src/vitest-failure-classification.mjs",
        "libs/test-config/src/vitest-failure-classification.test.ts",
        "packages/operator-core/lib/__tests__/test-file-router.test.ts"
      ],
      "rootCauseVerification": {
        "hypothesis": "Vitest's promise matchers replace a real AssertionError stack with a plain Error stack; the shared classifier's AssertionError-header-only contract discards it.",
        "alternativeHypothesis": "The promise rejection is an unasserted runtime failure and was correctly excluded.",
        "distinguishingTest": "Catch actual resolves/rejects settlement failures, assert error.name is AssertionError, serialize stack||message, and classify the same bytes before and after the fix; also retain runtime/hook and near-miss negative controls.",
        "testProcedure": "Run the maintained shared classifier file before changing its implementation, then through testing:run after the fix; run the router's failed assertion diagnostics block to verify the emitted mutation marker.",
        "testResult": "Before fix, both actual settlement assertion cases failed classification; after fix shared5 and router5 passed with negative controls retained.",
        "predictedObservations": {
          "hypothesis": "Actual errors have name AssertionError and Error-prefixed rewritten stacks; old classifier returns false and the narrow signature repair returns true.",
          "alternativeHypothesis": "Actual failures lack AssertionError identity or come from a runtime/hook origin, so the provenance-qualified assertion controls cannot pass."
        },
        "actualObservation": "Installed @vitest/expect creates AssertionError and rewrites err.stack from a captured Error. Real assertion tests confirmed name AssertionError and Error-prefixed stacks; both reproduced red before the fix and passed after it. Router emits TEST_FILE_ASSERTION_FAILURE and the runtime control remains NON_ASSERTION.",
        "evidenceRefs": [
          "test-run:22608718",
          "test-run:22608724",
          "/tmp/assume94-classifier-red.log",
          "libs/test-config/src/vitest-failure-classification.mjs"
        ]
      },
      "verification": {
        "coverage": {
          "population": [
            "real resolves settlement assertion",
            "real rejects settlement assertion",
            "near-miss origin/message and mixed runtime controls",
            "router assertion marker and runtime marker"
          ],
          "checked": [
            "real resolves settlement assertion",
            "real rejects settlement assertion",
            "near-miss origin/message and mixed runtime controls",
            "router assertion marker and runtime marker"
          ],
          "notChecked": [],
          "notApplicable": [],
          "residue": []
        }
      }
    }
  },
  "proof": {
    "sharedRun": {
      "runId": "ff6125ba-6bcc-4e54-9a9f-2d554c1f92ac",
      "ledgerId": 22608718,
      "passed": 5,
      "failed": 0,
      "skipped": 0
    },
    "routerRun": {
      "runId": "da5fd97f-af39-4d5c-a946-5517a977ea9c",
      "ledgerId": 22608724,
      "passed": 5,
      "failed": 0,
      "filtered": 234
    },
    "sourceSha256": {
      "libs/test-config/src/vitest-failure-classification.mjs": "201988ab2bab95dd29229212799f1c9bb9bd61d98bf15be12408b3b0331c7513",
      "libs/test-config/src/vitest-failure-classification.test.ts": "60d7373a3a84d5acfdd1bbe56663b29a6fa843a0039fd72cac403f46944e3a10",
      "packages/operator-core/lib/__tests__/test-file-router.test.ts": "f1be36997b08b84ab8fef8f2efff9c79737b30724aa8b54d2eafc6ce0b300366"
    }
  },
  "boundary": "Old Recovery93 mutation stays INCONCLUSIVE; focused local tests do not establish fresh mutation/native acceptance or shipment."
}
