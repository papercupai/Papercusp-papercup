---
rel_path: "evidence/bg-host-p001-r1-source-census-immutable-d071-20261102.json"
updated_at: 1793622294774
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "WI-6554700010028547",
  "plan": "bg-host-committed-generation-2026-10-24",
  "scope": "R1 source census source-unit slice only",
  "ref": "d071343508155dfb54cb1a96bb31b82b8a6577da",
  "root": "/tmp/pcv/papercusp-lint-as-committed-d071343508-bqU7Kw",
  "groups": [
    {
      "id": 22988778,
      "status": "pass",
      "commit": "d071343508155dfb54cb1a96bb31b82b8a6577da",
      "worktreeDirty": false,
      "group": "cd206e80-c25c-4d46-a9a7-7c7e4db4f09a",
      "attribution": {
        "ownerId": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "workItemId": "WI-6554700010028547"
      },
      "leg": null,
      "cases": [
        {
          "test_run_id": "22988778",
          "case_key": "bg-r1-census requires exact predeclared selector and branch population",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988778",
          "case_key": "BG inherited manifest and original source boundaries > BG-PREP-EXACT-SELECTION rejects a changed frozen source census at either compiler boundary",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988778",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-changed-before-build rejects changed frozen source before-build",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988778",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-missing-before-build rejects missing frozen source before-build",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988778",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-added-before-build rejects added frozen source before-build",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988778",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-changed-before-publication rejects changed frozen source before-publication",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988778",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-missing-before-publication rejects missing frozen source before-publication",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988778",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-added-before-publication rejects added frozen source before-publication",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988778",
          "case_key": "BG inherited manifest and original source boundaries > BG-PREP-EXACT-SELECTION rejects omitted or added accepted manifest members",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988778",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-member-omitted-before-build rejects omitted accepted member before-build",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988778",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-member-added-before-build rejects added accepted member before-build",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988778",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-member-omitted-before-publication rejects omitted accepted member before-publication",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988778",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-member-added-before-publication rejects added accepted member before-publication",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988778",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-compiler-resolver-metadata-transient-restored refuses publication after real resolution used changed package metadata then restored it",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988778",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-compiler-absent-resolver-metadata refuses a package manifest created during real resolution and removed before publication",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988778",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-compiler-absent-resolver-metadata qualifies immutable absence during real compilation",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988778",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-compiler-absent-resolver-metadata refuses restored namespace mutation in source-directory",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988778",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-compiler-absent-resolver-metadata refuses restored namespace mutation in source-ancestor",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988778",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-compiler-metadata-identical-rewrite refuses original metadata rewritten with identical bytes: package.json",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988778",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-compiler-metadata-identical-rewrite refuses original metadata rewritten with identical bytes: node_modules/fixture-dependency/package.json",
          "status": "pass",
          "error_tail": null
        }
      ]
    },
    {
      "id": 22988807,
      "status": "pass",
      "commit": "d071343508155dfb54cb1a96bb31b82b8a6577da",
      "worktreeDirty": false,
      "group": "25418502-9ba2-496a-ae24-c4c6e3ceb525",
      "attribution": {
        "ownerId": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "workItemId": "WI-6554700010028547"
      },
      "leg": "baseline",
      "cases": [
        {
          "test_run_id": "22988807",
          "case_key": "BG inherited manifest and original source boundaries > preserves inherited literal inputs and recursive pins while unrelated canonical source changes",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988807",
          "case_key": "BG inherited manifest and original source boundaries > BG-PREP-EXACT-SELECTION rejects a changed frozen source census at either compiler boundary",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988807",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-changed-before-build rejects changed frozen source before-build",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988807",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-missing-before-build rejects missing frozen source before-build",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988807",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-added-before-build rejects added frozen source before-build",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988807",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-changed-before-publication rejects changed frozen source before-publication",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988807",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-missing-before-publication rejects missing frozen source before-publication",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988807",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-added-before-publication rejects added frozen source before-publication",
          "status": "pass",
          "error_tail": null
        }
      ]
    },
    {
      "id": 22988814,
      "status": "pass",
      "commit": "d071343508155dfb54cb1a96bb31b82b8a6577da",
      "worktreeDirty": false,
      "group": "5b790908-6a10-4c72-8a59-d85b4a4f0e1e",
      "attribution": {
        "ownerId": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "workItemId": "WI-6554700010028547"
      },
      "leg": "copy-baseline",
      "cases": [
        {
          "test_run_id": "22988814",
          "case_key": "BG inherited manifest and original source boundaries > preserves inherited literal inputs and recursive pins while unrelated canonical source changes",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988814",
          "case_key": "BG inherited manifest and original source boundaries > BG-PREP-EXACT-SELECTION rejects a changed frozen source census at either compiler boundary",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988814",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-changed-before-build rejects changed frozen source before-build",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988814",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-missing-before-build rejects missing frozen source before-build",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988814",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-added-before-build rejects added frozen source before-build",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988814",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-changed-before-publication rejects changed frozen source before-publication",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988814",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-missing-before-publication rejects missing frozen source before-publication",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988814",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-added-before-publication rejects added frozen source before-publication",
          "status": "pass",
          "error_tail": null
        }
      ]
    },
    {
      "id": 22988834,
      "status": "fail",
      "commit": "d071343508155dfb54cb1a96bb31b82b8a6577da",
      "worktreeDirty": false,
      "group": "49955f21-c929-4a3f-922d-4a58f0124452",
      "attribution": {
        "ownerId": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
        "workItemId": "WI-6554700010028547"
      },
      "leg": "mutant",
      "cases": [
        {
          "test_run_id": "22988834",
          "case_key": "BG inherited manifest and original source boundaries > preserves inherited literal inputs and recursive pins while unrelated canonical source changes",
          "status": "pass",
          "error_tail": null
        },
        {
          "test_run_id": "22988834",
          "case_key": "BG inherited manifest and original source boundaries > BG-PREP-EXACT-SELECTION rejects a changed frozen source census at either compiler boundary",
          "status": "fail",
          "error_tail": "expected [Function] to throw an error\nactual: undefined\nexpected: null"
        },
        {
          "test_run_id": "22988834",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-changed-before-build rejects changed frozen source before-build",
          "status": "fail",
          "error_tail": "expected [Function] to throw an error\nactual: undefined\nexpected: null"
        },
        {
          "test_run_id": "22988834",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-missing-before-build rejects missing frozen source before-build",
          "status": "fail",
          "error_tail": "expected [Function] to throw an error\nactual: undefined\nexpected: null"
        },
        {
          "test_run_id": "22988834",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-added-before-build rejects added frozen source before-build",
          "status": "fail",
          "error_tail": "expected [Function] to throw an error\nactual: undefined\nexpected: null"
        },
        {
          "test_run_id": "22988834",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-changed-before-publication rejects changed frozen source before-publication",
          "status": "fail",
          "error_tail": "expected [Function] to throw an error\nactual: undefined\nexpected: null"
        },
        {
          "test_run_id": "22988834",
          "case_key": "BG inherited manifest and original source boundaries > bg-r1-source-missing-before-publication rejects missing frozen source before-publication",
          "status": "fail",
          "error_tail": "expected [Function] to throw an error\nactual: undefined\nexpected: null"
        },
        {
          "test_run_id": "22988834",
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
    "probeInvocationId": "bcaf63d3-f857-42ce-9e56-2cf1132540ed",
    "testCommandSha256": "ba425ed97652940b19e3c84419372dbfa6fca4ad26999f23fc271e1c5a7d59b9",
    "subjectAfterSha256": "4dfa86003c06b11329a9e952fd775f9bcb1ac2e05a8d5d116b16f18e986ee2c1",
    "mutantDiffTruncated": false,
    "subjectBeforeSha256": "8f9e41ff2ba61ecb5f18e70004b4e5da5b1d3b7472fd8706ef1dc4ba462f625d"
  },
  "sourceLog": ".papercusp/scratch/bash-87de6648-f99.log",
  "mutationLog": ".papercusp/scratch/bash-44f1890b-297.log",
  "verdict": {
    "caught": true,
    "mutantParse": "ok",
    "relocation": "overlay",
    "contained": true,
    "trackedSourceUnchanged": true
  },
  "limits": [
    "Original parent authority UNKNOWN: actual preparation and activation prohibited",
    "Full P001/runtime/independent acceptance/Luna shipment open"
  ]
}
