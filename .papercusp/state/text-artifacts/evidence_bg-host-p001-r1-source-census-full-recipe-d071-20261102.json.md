---
rel_path: "evidence/bg-host-p001-r1-source-census-full-recipe-d071-20261102.json"
updated_at: 1793622698831
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "WI-6554700010028547",
  "plan": "bg-host-committed-generation-2026-10-24",
  "scope": "R1 source-unit slice at original full release-glob recipe",
  "ref": "d071343508155dfb54cb1a96bb31b82b8a6577da",
  "root": "/tmp/pcv/papercusp-lint-as-committed-d071343508-bqU7Kw",
  "sourceGlobs": [
    "apps/operator/bin/release/**"
  ],
  "recipeSource": "/tmp/luna-r1-source-22986802-bind-20261102.json",
  "groups": [
    {
      "id": 22989343,
      "status": "pass",
      "commit": "d071343508155dfb54cb1a96bb31b82b8a6577da",
      "worktreeDirty": false,
      "group": "4c3fe271-60d6-42c4-87b5-423f684d864e",
      "attribution": {
        "ownerId": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "workItemId": "WI-6554700010028547"
      },
      "leg": null,
      "cases": [
        {
          "test_run_id": "22989343",
          "case_key": "bg-r1-census requires exact predeclared selector and branch population",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989343",
          "case_key": "BG inherited manifest and original source boundaries > BG-PREP-EXACT-SELECTION rejects a changed frozen source census at either compiler boundary",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989343",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-changed-before-build rejects changed frozen source before-build",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989343",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-missing-before-build rejects missing frozen source before-build",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989343",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-added-before-build rejects added frozen source before-build",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989343",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-changed-before-publication rejects changed frozen source before-publication",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989343",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-missing-before-publication rejects missing frozen source before-publication",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989343",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-added-before-publication rejects added frozen source before-publication",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989343",
          "case_key": "BG inherited manifest and original source boundaries > BG-PREP-EXACT-SELECTION rejects omitted or added accepted manifest members",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989343",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-member-omitted-before-build rejects omitted accepted member before-build",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989343",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-member-added-before-build rejects added accepted member before-build",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989343",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-member-omitted-before-publication rejects omitted accepted member before-publication",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989343",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-member-added-before-publication rejects added accepted member before-publication",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989343",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-compiler-resolver-metadata-transient-restored refuses publication after real resolution used changed package metadata then restored it",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989343",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-compiler-absent-resolver-metadata refuses a package manifest created during real resolution and removed before publication",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989343",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-compiler-absent-resolver-metadata qualifies immutable absence during real compilation",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989343",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-compiler-absent-resolver-metadata refuses restored namespace mutation in source-directory",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989343",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-compiler-absent-resolver-metadata refuses restored namespace mutation in source-ancestor",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989343",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-compiler-metadata-identical-rewrite refuses original metadata rewritten with identical bytes: package.json",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989343",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-compiler-metadata-identical-rewrite refuses original metadata rewritten with identical bytes: node_modules/fixture-dependency/package.json",
          "status": "pass",
          "error_tail": null
        }
      ]
    },
    {
      "id": 22989346,
      "status": "pass",
      "commit": "d071343508155dfb54cb1a96bb31b82b8a6577da",
      "worktreeDirty": false,
      "group": "2ef56d3c-994c-4d58-babf-06810ce477aa",
      "attribution": {
        "ownerId": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "workItemId": "WI-6554700010028547"
      },
      "leg": "baseline",
      "cases": [
        {
          "test_run_id": "22989346",
          "case_key": "BG inherited manifest and original source boundaries > preserves inherited literal inputs and recursive pins while unrelated canonical source changes",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989346",
          "case_key": "BG inherited manifest and original source boundaries > BG-PREP-EXACT-SELECTION rejects a changed frozen source census at either compiler boundary",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989346",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-changed-before-build rejects changed frozen source before-build",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989346",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-missing-before-build rejects missing frozen source before-build",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989346",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-added-before-build rejects added frozen source before-build",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989346",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-changed-before-publication rejects changed frozen source before-publication",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989346",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-missing-before-publication rejects missing frozen source before-publication",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989346",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-added-before-publication rejects added frozen source before-publication",
          "status": "pass",
          "error_tail": null
        }
      ]
    },
    {
      "id": 22989347,
      "status": "pass",
      "commit": "d071343508155dfb54cb1a96bb31b82b8a6577da",
      "worktreeDirty": false,
      "group": "2ef56d3c-994c-4d58-babf-06810ce477aa",
      "attribution": {
        "ownerId": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "workItemId": "WI-6554700010028547"
      },
      "leg": "copy-baseline",
      "cases": [
        {
          "test_run_id": "22989347",
          "case_key": "BG inherited manifest and original source boundaries > preserves inherited literal inputs and recursive pins while unrelated canonical source changes",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989347",
          "case_key": "BG inherited manifest and original source boundaries > BG-PREP-EXACT-SELECTION rejects a changed frozen source census at either compiler boundary",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989347",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-changed-before-build rejects changed frozen source before-build",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989347",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-missing-before-build rejects missing frozen source before-build",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989347",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-added-before-build rejects added frozen source before-build",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989347",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-changed-before-publication rejects changed frozen source before-publication",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989347",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-missing-before-publication rejects missing frozen source before-publication",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989347",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-added-before-publication rejects added frozen source before-publication",
          "status": "pass",
          "error_tail": null
        }
      ]
    },
    {
      "id": 22989348,
      "status": "fail",
      "commit": "d071343508155dfb54cb1a96bb31b82b8a6577da",
      "worktreeDirty": false,
      "group": "2ef56d3c-994c-4d58-babf-06810ce477aa",
      "attribution": {
        "ownerId": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "workItemId": "WI-6554700010028547"
      },
      "leg": "mutant",
      "cases": [
        {
          "test_run_id": "22989348",
          "case_key": "BG inherited manifest and original source boundaries > preserves inherited literal inputs and recursive pins while unrelated canonical source changes",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22989348",
          "case_key": "BG inherited manifest and original source boundaries > BG-PREP-EXACT-SELECTION rejects a changed frozen source census at either compiler boundary",
          "status": "fail",
          "error_tail": "expected [Function] to throw an error\nactual: undefined\nexpected: null"
        },
        {
          "test_run_id": "22989348",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-changed-before-build rejects changed frozen source before-build",
          "status": "fail",
          "error_tail": "expected [Function] to throw an error\nactual: undefined\nexpected: null"
        },
        {
          "test_run_id": "22989348",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-missing-before-build rejects missing frozen source before-build",
          "status": "fail",
          "error_tail": "expected [Function] to throw an error\nactual: undefined\nexpected: null"
        },
        {
          "test_run_id": "22989348",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-added-before-build rejects added frozen source before-build",
          "status": "fail",
          "error_tail": "expected [Function] to throw an error\nactual: undefined\nexpected: null"
        },
        {
          "test_run_id": "22989348",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-changed-before-publication rejects changed frozen source before-publication",
          "status": "fail",
          "error_tail": "expected [Function] to throw an error\nactual: undefined\nexpected: null"
        },
        {
          "test_run_id": "22989348",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-missing-before-publication rejects missing frozen source before-publication",
          "status": "fail",
          "error_tail": "expected [Function] to throw an error\nactual: undefined\nexpected: null"
        },
        {
          "test_run_id": "22989348",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-added-before-publication rejects added frozen source before-publication",
          "status": "fail",
          "error_tail": "expected [Function] to throw an error\nactual: undefined\nexpected: null"
        }
      ]
    }
  ],
  "descriptor": {
    "leg": "mutant",
    "mode": "copy-out",
    "mutantDiff": "--- a/scripts/source-preview.mjs\n+++ b/scripts/source-preview.mjs\n@@ -1040,7 +1040,7 @@\n     prepared.sourceReceiptSha256, 'BG original source receipt changed');\n   assert.deepEqual(source.testedInputs.map(row => row.path).sort(), Object.keys(acceptedManifest.members).sort(),\n     'BG accepted input membership mismatch');\n-  verifyVerifierSourceSync(root, source, { runtimeArtifacts: true });\n+  void source;\n   const trees = new Map();\n   for (const [path, blob] of Object.entries(acceptedManifest.members)) {\n     assert.equal(committedInputBlob(root, source.sourceCommit, path, trees), blob,\n",
    "subjectPath": "scripts/source-preview.mjs",
    "testCommand": "PROBE_SUBJECT={} node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/source-preview-export.test.ts --testNamePattern=\"bg-r1-source-(changed|missing|added)-|BG-PREP-EXACT-SELECTION rejects a changed frozen source|preserves inherited literal inputs\"",
    "againstCommit": null,
    "schemaVersion": 1,
    "testFileSha256": "d5d08455da88941926606a05a2d67ad0e549fd7113115faee8e83dd487bdc34c",
    "mutateExpression": "s/\\QverifyVerifierSourceSync(root, source, { runtimeArtifacts: true });\\E/void source;/",
    "probeInvocationId": "25ea6f0e-9b1f-45d7-aa59-b77a782f7466",
    "testCommandSha256": "ba425ed97652940b19e3c84419372dbfa6fca4ad26999f23fc271e1c5a7d59b9",
    "subjectAfterSha256": "4dfa86003c06b11329a9e952fd775f9bcb1ac2e05a8d5d116b16f18e986ee2c1",
    "mutantDiffTruncated": false,
    "subjectBeforeSha256": "8f9e41ff2ba61ecb5f18e70004b4e5da5b1d3b7472fd8706ef1dc4ba462f625d"
  },
  "log": ".papercusp/scratch/bash-0051fa47-539.log",
  "verdict": {
    "caught": true,
    "mutantParse": "ok",
    "relocation": "overlay",
    "contained": true,
    "trackedSourceUnchanged": true
  },
  "limits": [
    "Earlier 22988778/22988834 bindings omitted release glob and remain UNKNOWN history; corrected runs retain original complete recipe",
    "Original parent authority UNKNOWN: actual preparation and activation prohibited",
    "Full P001/runtime/independent acceptance/Luna shipment open"
  ]
}
