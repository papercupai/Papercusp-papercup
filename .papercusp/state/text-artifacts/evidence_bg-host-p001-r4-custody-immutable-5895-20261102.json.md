---
rel_path: "evidence/bg-host-p001-r4-custody-immutable-5895-20261102.json"
updated_at: 1793633950978
_body: "content"
---

{
  "schemaVersion": 1,
  "scope": "Only R4 source custody guards; not full R4 acceptance, actual BG preparation, or Luna shipment.",
  "workItem": "WI-6554700010028547",
  "commit": "58952091fb2b0476b8b4c5e501e7d6a5a9d64afc",
  "taskId": "0mvzezh7s1ay1zu87ku",
  "terminalExit": 0,
  "verdict": "caught",
  "mutantParse": "ok",
  "assertionEvidence": "vitest-failed-tests",
  "containment": "overlay contained",
  "treeIntegrity": "original source byte-identical",
  "log": "/tmp/luna-r4-custody-vitest-mutation-5895-20261102.log",
  "rows": [
    {
      "id": "23001671",
      "status": "pass",
      "commit_sha": "58952091fb2b0476b8b4c5e501e7d6a5a9d64afc",
      "worktree_dirty": false,
      "attribution": null,
      "mutation": {
        "leg": "baseline",
        "mode": "copy-out",
        "mutantDiff": "--- a/packages/operator-core/lib/verifier-source.ts\n+++ b/packages/operator-core/lib/verifier-source.ts\n@@ -210,7 +210,7 @@\n      * close alone can manufacture an EXIT observation. */\n     async reconcile({ outcome, custody }: { outcome: VerifierTeardownOutcome; custody: Record<string, unknown> }): Promise<InventoryTerminal> {\n       assert.ok(!sealed, 'inventory already sealed');\n-      assert.deepEqual(custody, header.custody, 'original parent custody changed');\n+      void custody; // narrowly bypass original-custody guard\n       assert.ok(!originalOutcome || originalOutcome === outcome, 'original teardown outcome changed');\n       await discoverProcesses();\n       const observations: InventoryObservation[] = [];\n",
        "subjectPath": "packages/operator-core/lib/verifier-source.ts",
        "testCommand": "test -r {} && cd packages/operator-core && NODE_OPTIONS= NODE_PATH= ../../scripts/pc-heavy.sh node ../../node_modules/vitest/vitest.mjs run lib/source-preview-export.test.ts -t 'bg-r4-custody-|BG-TEARDOWN-RECONCILE keeps recursive inventory append-only'",
        "againstCommit": null,
        "schemaVersion": 1,
        "testFileSha256": "ce77b8a4c0e4cf62f710c9f7e679215b83259693e568e6431ff62e070ce4f8f4",
        "mutateExpression": "if (index($_, \"assert.deepEqual(custody, header.custody,\") >= 0) { $_ = \"      void custody; // narrowly bypass original-custody guard\\n\"; }",
        "probeInvocationId": "2d01b291-b5bf-467b-8c59-85cb2f06ac8b",
        "testCommandSha256": "a3fedfb844386e65494a8e00f0937a0a00cb51c5ae7e5695d3b788ce2712e304",
        "subjectAfterSha256": "89b026c084d4156c411ef6cd11be268e4271b849761e4cde7715925eef053884",
        "mutantDiffTruncated": false,
        "subjectBeforeSha256": "338778b5d2820f32b9b714f97e835155593b17389a768aa42bd59924c3b5f904"
      }
    },
    {
      "id": "23001695",
      "status": "pass",
      "commit_sha": "58952091fb2b0476b8b4c5e501e7d6a5a9d64afc",
      "worktree_dirty": false,
      "attribution": null,
      "mutation": {
        "leg": "copy-baseline",
        "mode": "copy-out",
        "mutantDiff": "--- a/packages/operator-core/lib/verifier-source.ts\n+++ b/packages/operator-core/lib/verifier-source.ts\n@@ -210,7 +210,7 @@\n      * close alone can manufacture an EXIT observation. */\n     async reconcile({ outcome, custody }: { outcome: VerifierTeardownOutcome; custody: Record<string, unknown> }): Promise<InventoryTerminal> {\n       assert.ok(!sealed, 'inventory already sealed');\n-      assert.deepEqual(custody, header.custody, 'original parent custody changed');\n+      void custody; // narrowly bypass original-custody guard\n       assert.ok(!originalOutcome || originalOutcome === outcome, 'original teardown outcome changed');\n       await discoverProcesses();\n       const observations: InventoryObservation[] = [];\n",
        "subjectPath": "packages/operator-core/lib/verifier-source.ts",
        "testCommand": "test -r {} && cd packages/operator-core && NODE_OPTIONS= NODE_PATH= ../../scripts/pc-heavy.sh node ../../node_modules/vitest/vitest.mjs run lib/source-preview-export.test.ts -t 'bg-r4-custody-|BG-TEARDOWN-RECONCILE keeps recursive inventory append-only'",
        "againstCommit": null,
        "schemaVersion": 1,
        "testFileSha256": "ce77b8a4c0e4cf62f710c9f7e679215b83259693e568e6431ff62e070ce4f8f4",
        "mutateExpression": "if (index($_, \"assert.deepEqual(custody, header.custody,\") >= 0) { $_ = \"      void custody; // narrowly bypass original-custody guard\\n\"; }",
        "probeInvocationId": "2d01b291-b5bf-467b-8c59-85cb2f06ac8b",
        "testCommandSha256": "a3fedfb844386e65494a8e00f0937a0a00cb51c5ae7e5695d3b788ce2712e304",
        "subjectAfterSha256": "89b026c084d4156c411ef6cd11be268e4271b849761e4cde7715925eef053884",
        "mutantDiffTruncated": false,
        "subjectBeforeSha256": "338778b5d2820f32b9b714f97e835155593b17389a768aa42bd59924c3b5f904"
      }
    },
    {
      "id": "23001736",
      "status": "fail",
      "commit_sha": "58952091fb2b0476b8b4c5e501e7d6a5a9d64afc",
      "worktree_dirty": false,
      "attribution": null,
      "mutation": {
        "leg": "mutant",
        "mode": "copy-out",
        "mutantDiff": "--- a/packages/operator-core/lib/verifier-source.ts\n+++ b/packages/operator-core/lib/verifier-source.ts\n@@ -210,7 +210,7 @@\n      * close alone can manufacture an EXIT observation. */\n     async reconcile({ outcome, custody }: { outcome: VerifierTeardownOutcome; custody: Record<string, unknown> }): Promise<InventoryTerminal> {\n       assert.ok(!sealed, 'inventory already sealed');\n-      assert.deepEqual(custody, header.custody, 'original parent custody changed');\n+      void custody; // narrowly bypass original-custody guard\n       assert.ok(!originalOutcome || originalOutcome === outcome, 'original teardown outcome changed');\n       await discoverProcesses();\n       const observations: InventoryObservation[] = [];\n",
        "subjectPath": "packages/operator-core/lib/verifier-source.ts",
        "testCommand": "test -r {} && cd packages/operator-core && NODE_OPTIONS= NODE_PATH= ../../scripts/pc-heavy.sh node ../../node_modules/vitest/vitest.mjs run lib/source-preview-export.test.ts -t 'bg-r4-custody-|BG-TEARDOWN-RECONCILE keeps recursive inventory append-only'",
        "againstCommit": null,
        "schemaVersion": 1,
        "testFileSha256": "ce77b8a4c0e4cf62f710c9f7e679215b83259693e568e6431ff62e070ce4f8f4",
        "mutateExpression": "if (index($_, \"assert.deepEqual(custody, header.custody,\") >= 0) { $_ = \"      void custody; // narrowly bypass original-custody guard\\n\"; }",
        "probeInvocationId": "2d01b291-b5bf-467b-8c59-85cb2f06ac8b",
        "testCommandSha256": "a3fedfb844386e65494a8e00f0937a0a00cb51c5ae7e5695d3b788ce2712e304",
        "subjectAfterSha256": "89b026c084d4156c411ef6cd11be268e4271b849761e4cde7715925eef053884",
        "mutantDiffTruncated": false,
        "subjectBeforeSha256": "338778b5d2820f32b9b714f97e835155593b17389a768aa42bd59924c3b5f904"
      }
    }
  ],
  "cases": [
    {
      "test_run_id": "23001671",
      "case_key": "BG teardown resource inventory source controls > BG-TEARDOWN-RECONCILE keeps recursive inventory append-only through late-child reconciliation",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001671",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-parent-fire24-delete refuses delete of original parent-fire24 custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001671",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-parent-fire24-reset refuses reset of original parent-fire24 custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001671",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-parent-fire24-replace refuses replace of original parent-fire24 custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001671",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-parent-fire24-rewrite refuses rewrite of original parent-fire24 custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001671",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-owner-delete refuses delete of original owner custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001671",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-owner-reset refuses reset of original owner custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001671",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-owner-replace refuses replace of original owner custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001671",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-owner-rewrite refuses rewrite of original owner custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001671",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-origin-delete refuses delete of original origin custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001671",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-origin-reset refuses reset of original origin custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001671",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-origin-replace refuses replace of original origin custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001671",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-origin-rewrite refuses rewrite of original origin custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001671",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-error-history-delete refuses delete of original error-history custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001671",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-error-history-reset refuses reset of original error-history custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001671",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-error-history-replace refuses replace of original error-history custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001671",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-error-history-rewrite refuses rewrite of original error-history custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001671",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-evidence-reference-delete refuses delete of original evidence-reference custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001671",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-evidence-reference-reset refuses reset of original evidence-reference custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001671",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-evidence-reference-replace refuses replace of original evidence-reference custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001671",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-evidence-reference-rewrite refuses rewrite of original evidence-reference custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001695",
      "case_key": "BG teardown resource inventory source controls > BG-TEARDOWN-RECONCILE keeps recursive inventory append-only through late-child reconciliation",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001695",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-parent-fire24-delete refuses delete of original parent-fire24 custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001695",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-parent-fire24-reset refuses reset of original parent-fire24 custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001695",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-parent-fire24-replace refuses replace of original parent-fire24 custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001695",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-parent-fire24-rewrite refuses rewrite of original parent-fire24 custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001695",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-owner-delete refuses delete of original owner custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001695",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-owner-reset refuses reset of original owner custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001695",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-owner-replace refuses replace of original owner custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001695",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-owner-rewrite refuses rewrite of original owner custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001695",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-origin-delete refuses delete of original origin custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001695",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-origin-reset refuses reset of original origin custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001695",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-origin-replace refuses replace of original origin custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001695",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-origin-rewrite refuses rewrite of original origin custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001695",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-error-history-delete refuses delete of original error-history custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001695",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-error-history-reset refuses reset of original error-history custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001695",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-error-history-replace refuses replace of original error-history custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001695",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-error-history-rewrite refuses rewrite of original error-history custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001695",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-evidence-reference-delete refuses delete of original evidence-reference custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001695",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-evidence-reference-reset refuses reset of original evidence-reference custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001695",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-evidence-reference-replace refuses replace of original evidence-reference custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001695",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-evidence-reference-rewrite refuses rewrite of original evidence-reference custody",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001736",
      "case_key": "BG teardown resource inventory source controls > BG-TEARDOWN-RECONCILE keeps recursive inventory append-only through late-child reconciliation",
      "status": "pass",
      "error": null
    },
    {
      "test_run_id": "23001736",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-parent-fire24-delete refuses delete of original parent-fire24 custody",
      "status": "fail",
      "error": "promise resolved \"{ outcome: 'success', …(6) }\" instead of rejecting\nactual: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": false,\n  \"observations\": [\n    {\n      \"id\": \"candida"
    },
    {
      "test_run_id": "23001736",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-parent-fire24-reset refuses reset of original parent-fire24 custody",
      "status": "fail",
      "error": "promise resolved \"{ outcome: 'success', …(6) }\" instead of rejecting\nactual: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": false,\n  \"observations\": [\n    {\n      \"id\": \"candida"
    },
    {
      "test_run_id": "23001736",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-parent-fire24-replace refuses replace of original parent-fire24 custody",
      "status": "fail",
      "error": "promise resolved \"{ outcome: 'success', …(6) }\" instead of rejecting\nactual: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": false,\n  \"observations\": [\n    {\n      \"id\": \"candida"
    },
    {
      "test_run_id": "23001736",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-parent-fire24-rewrite refuses rewrite of original parent-fire24 custody",
      "status": "fail",
      "error": "promise resolved \"{ outcome: 'success', …(6) }\" instead of rejecting\nactual: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": false,\n  \"observations\": [\n    {\n      \"id\": \"candida"
    },
    {
      "test_run_id": "23001736",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-owner-delete refuses delete of original owner custody",
      "status": "fail",
      "error": "promise resolved \"{ outcome: 'success', …(6) }\" instead of rejecting\nactual: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": false,\n  \"observations\": [\n    {\n      \"id\": \"candida"
    },
    {
      "test_run_id": "23001736",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-owner-reset refuses reset of original owner custody",
      "status": "fail",
      "error": "promise resolved \"{ outcome: 'success', …(6) }\" instead of rejecting\nactual: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": false,\n  \"observations\": [\n    {\n      \"id\": \"candida"
    },
    {
      "test_run_id": "23001736",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-owner-replace refuses replace of original owner custody",
      "status": "fail",
      "error": "promise resolved \"{ outcome: 'success', …(6) }\" instead of rejecting\nactual: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": false,\n  \"observations\": [\n    {\n      \"id\": \"candida"
    },
    {
      "test_run_id": "23001736",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-owner-rewrite refuses rewrite of original owner custody",
      "status": "fail",
      "error": "promise resolved \"{ outcome: 'success', …(6) }\" instead of rejecting\nactual: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": false,\n  \"observations\": [\n    {\n      \"id\": \"candida"
    },
    {
      "test_run_id": "23001736",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-origin-delete refuses delete of original origin custody",
      "status": "fail",
      "error": "promise resolved \"{ outcome: 'success', …(6) }\" instead of rejecting\nactual: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": false,\n  \"observations\": [\n    {\n      \"id\": \"candida"
    },
    {
      "test_run_id": "23001736",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-origin-reset refuses reset of original origin custody",
      "status": "fail",
      "error": "promise resolved \"{ outcome: 'success', …(6) }\" instead of rejecting\nactual: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": false,\n  \"observations\": [\n    {\n      \"id\": \"candida"
    },
    {
      "test_run_id": "23001736",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-origin-replace refuses replace of original origin custody",
      "status": "fail",
      "error": "promise resolved \"{ outcome: 'success', …(6) }\" instead of rejecting\nactual: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": false,\n  \"observations\": [\n    {\n      \"id\": \"candida"
    },
    {
      "test_run_id": "23001736",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-origin-rewrite refuses rewrite of original origin custody",
      "status": "fail",
      "error": "promise resolved \"{ outcome: 'success', …(6) }\" instead of rejecting\nactual: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": false,\n  \"observations\": [\n    {\n      \"id\": \"candida"
    },
    {
      "test_run_id": "23001736",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-error-history-delete refuses delete of original error-history custody",
      "status": "fail",
      "error": "promise resolved \"{ outcome: 'success', …(6) }\" instead of rejecting\nactual: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": false,\n  \"observations\": [\n    {\n      \"id\": \"candida"
    },
    {
      "test_run_id": "23001736",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-error-history-reset refuses reset of original error-history custody",
      "status": "fail",
      "error": "promise resolved \"{ outcome: 'success', …(6) }\" instead of rejecting\nactual: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": false,\n  \"observations\": [\n    {\n      \"id\": \"candida"
    },
    {
      "test_run_id": "23001736",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-error-history-replace refuses replace of original error-history custody",
      "status": "fail",
      "error": "promise resolved \"{ outcome: 'success', …(6) }\" instead of rejecting\nactual: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": false,\n  \"observations\": [\n    {\n      \"id\": \"candida"
    },
    {
      "test_run_id": "23001736",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-error-history-rewrite refuses rewrite of original error-history custody",
      "status": "fail",
      "error": "promise resolved \"{ outcome: 'success', …(6) }\" instead of rejecting\nactual: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": false,\n  \"observations\": [\n    {\n      \"id\": \"candida"
    },
    {
      "test_run_id": "23001736",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-evidence-reference-delete refuses delete of original evidence-reference custody",
      "status": "fail",
      "error": "promise resolved \"{ outcome: 'success', …(6) }\" instead of rejecting\nactual: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": false,\n  \"observations\": [\n    {\n      \"id\": \"candida"
    },
    {
      "test_run_id": "23001736",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-evidence-reference-reset refuses reset of original evidence-reference custody",
      "status": "fail",
      "error": "promise resolved \"{ outcome: 'success', …(6) }\" instead of rejecting\nactual: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": false,\n  \"observations\": [\n    {\n      \"id\": \"candida"
    },
    {
      "test_run_id": "23001736",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-evidence-reference-replace refuses replace of original evidence-reference custody",
      "status": "fail",
      "error": "promise resolved \"{ outcome: 'success', …(6) }\" instead of rejecting\nactual: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": false,\n  \"observations\": [\n    {\n      \"id\": \"candida"
    },
    {
      "test_run_id": "23001736",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-evidence-reference-rewrite refuses rewrite of original evidence-reference custody",
      "status": "fail",
      "error": "promise resolved \"{ outcome: 'success', …(6) }\" instead of rejecting\nactual: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": false,\n  \"observations\": [\n    {\n      \"id\": \"candida"
    }
  ],
  "negativeSelectors": [
    "bg-r4-custody-parent-fire24-delete",
    "bg-r4-custody-parent-fire24-reset",
    "bg-r4-custody-parent-fire24-replace",
    "bg-r4-custody-parent-fire24-rewrite",
    "bg-r4-custody-owner-delete",
    "bg-r4-custody-owner-reset",
    "bg-r4-custody-owner-replace",
    "bg-r4-custody-owner-rewrite",
    "bg-r4-custody-origin-delete",
    "bg-r4-custody-origin-reset",
    "bg-r4-custody-origin-replace",
    "bg-r4-custody-origin-rewrite",
    "bg-r4-custody-error-history-delete",
    "bg-r4-custody-error-history-reset",
    "bg-r4-custody-error-history-replace",
    "bg-r4-custody-error-history-rewrite",
    "bg-r4-custody-evidence-reference-delete",
    "bg-r4-custody-evidence-reference-reset",
    "bg-r4-custody-evidence-reference-replace",
    "bg-r4-custody-evidence-reference-rewrite"
  ],
  "ordinaryPositive": {
    "test_run_id": "23001736",
    "case_key": "BG teardown resource inventory source controls > BG-TEARDOWN-RECONCILE keeps recursive inventory append-only through late-child reconciliation",
    "status": "pass",
    "error": null
  },
  "instrumentRepair": "The source router substituted committed subject bytes; canonical project Vitest directly preserves pc-heavy, default admin reporter, exact selected population and private frozen overlay. No loader substitution is accepted as proof.",
  "reader": "http://127.0.0.1:3170/api/health at58952091fb",
  "remaining": "Deadline/history and remaining42-selector/live methods remain open; original parent authorityUNKNOWN still bars actual prep/activation."
}
