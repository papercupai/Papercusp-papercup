---
rel_path: "evidence/bg-host-p001-r1-census-working-20261029.json"
updated_at: 1793249413664
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "WI-6554700010028547",
  "scope": "working-tree source tests only; not immutable acceptance, real service boot, or Luna shipment",
  "notEstablished": [
    "immutable committed source acceptance",
    "actual guarded service boot acceptance",
    "R1 per-defect bypass acceptance",
    "full production/runtime closure",
    "Luna shipment"
  ],
  "manifest": {
    "schemaVersion": 1,
    "rubricRef": "acceptance-bg-host-committed-generation-2026-10-24",
    "revision": 10,
    "criteriaHash": "4c72c9360ac99aa3526bfe17925d10894f38408acd23521b4df1ef5f15d67835",
    "criterionKey": "r-1",
    "cases": [
      {
        "rowId": "source-census",
        "file": "packages/operator-core/lib/source-preview-export.test.ts",
        "testName": "BG-PREP-EXACT-SELECTION rejects a changed frozen source census at either compiler boundary"
      },
      {
        "rowId": "accepted-members",
        "file": "packages/operator-core/lib/source-preview-export.test.ts",
        "testName": "BG-PREP-EXACT-SELECTION rejects omitted or added accepted manifest members"
      },
      {
        "rowId": "builder-identity",
        "file": "apps/operator/lib/bundle-host-freshness.test.ts",
        "testName": "BG-PREP-EXACT-SELECTION rejects changed builder configuration or toolchain identity"
      },
      {
        "rowId": "parent-authority",
        "file": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "testName": "BG-PREP-EXACT-SELECTION rejects missing unknown or substituted parent manifest authority at actual service boot"
      },
      {
        "rowId": "parent-schema-digest",
        "file": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "testName": "BG-PREP-EXACT-SELECTION rejects parent manifest schema or digest mismatch at actual service boot"
      },
      {
        "rowId": "parent-literal-members",
        "file": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "testName": "BG-PREP-EXACT-SELECTION rejects added omitted or changed literal parent manifest members at actual service boot"
      },
      {
        "rowId": "bg-r1-source-changed-before-build",
        "file": "packages/operator-core/lib/source-preview-export.test.ts",
        "testName": "bg-r1-source-changed-before-build rejects changed frozen source before-build"
      },
      {
        "rowId": "bg-r1-source-missing-before-build",
        "file": "packages/operator-core/lib/source-preview-export.test.ts",
        "testName": "bg-r1-source-missing-before-build rejects missing frozen source before-build"
      },
      {
        "rowId": "bg-r1-source-added-before-build",
        "file": "packages/operator-core/lib/source-preview-export.test.ts",
        "testName": "bg-r1-source-added-before-build rejects added frozen source before-build"
      },
      {
        "rowId": "bg-r1-member-omitted-before-build",
        "file": "packages/operator-core/lib/source-preview-export.test.ts",
        "testName": "bg-r1-member-omitted-before-build rejects omitted accepted member before-build"
      },
      {
        "rowId": "bg-r1-member-added-before-build",
        "file": "packages/operator-core/lib/source-preview-export.test.ts",
        "testName": "bg-r1-member-added-before-build rejects added accepted member before-build"
      },
      {
        "rowId": "bg-r1-builder-configuration-before-build",
        "file": "apps/operator/lib/bundle-host-freshness.test.ts",
        "testName": "bg-r1-builder-configuration-before-build rejects changed builder-configuration before-build"
      },
      {
        "rowId": "bg-r1-toolchain-identity-before-build",
        "file": "apps/operator/lib/bundle-host-freshness.test.ts",
        "testName": "bg-r1-toolchain-identity-before-build rejects changed toolchain-identity before-build"
      },
      {
        "rowId": "bg-r1-source-changed-before-publication",
        "file": "packages/operator-core/lib/source-preview-export.test.ts",
        "testName": "bg-r1-source-changed-before-publication rejects changed frozen source before-publication"
      },
      {
        "rowId": "bg-r1-source-missing-before-publication",
        "file": "packages/operator-core/lib/source-preview-export.test.ts",
        "testName": "bg-r1-source-missing-before-publication rejects missing frozen source before-publication"
      },
      {
        "rowId": "bg-r1-source-added-before-publication",
        "file": "packages/operator-core/lib/source-preview-export.test.ts",
        "testName": "bg-r1-source-added-before-publication rejects added frozen source before-publication"
      },
      {
        "rowId": "bg-r1-member-omitted-before-publication",
        "file": "packages/operator-core/lib/source-preview-export.test.ts",
        "testName": "bg-r1-member-omitted-before-publication rejects omitted accepted member before-publication"
      },
      {
        "rowId": "bg-r1-member-added-before-publication",
        "file": "packages/operator-core/lib/source-preview-export.test.ts",
        "testName": "bg-r1-member-added-before-publication rejects added accepted member before-publication"
      },
      {
        "rowId": "bg-r1-builder-configuration-before-publication",
        "file": "apps/operator/lib/bundle-host-freshness.test.ts",
        "testName": "bg-r1-builder-configuration-before-publication rejects changed builder-configuration before-publication"
      },
      {
        "rowId": "bg-r1-toolchain-identity-before-publication",
        "file": "apps/operator/lib/bundle-host-freshness.test.ts",
        "testName": "bg-r1-toolchain-identity-before-publication rejects changed toolchain-identity before-publication"
      },
      {
        "rowId": "bg-r1-parent-authority-absent",
        "file": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "testName": "bg-r1-parent-authority-absent rejects parent authority-absent at actual service boot"
      },
      {
        "rowId": "bg-r1-parent-authority-unknown",
        "file": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "testName": "bg-r1-parent-authority-unknown rejects parent authority-unknown at actual service boot"
      },
      {
        "rowId": "bg-r1-parent-authority-candidate-substitution",
        "file": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "testName": "bg-r1-parent-authority-candidate-substitution rejects parent authority-candidate-substitution at actual service boot"
      },
      {
        "rowId": "bg-r1-parent-schema-mismatch",
        "file": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "testName": "bg-r1-parent-schema-mismatch rejects parent schema-mismatch at actual service boot"
      },
      {
        "rowId": "bg-r1-parent-digest-mismatch",
        "file": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "testName": "bg-r1-parent-digest-mismatch rejects parent digest-mismatch at actual service boot"
      },
      {
        "rowId": "bg-r1-parent-literal-member-added",
        "file": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "testName": "bg-r1-parent-literal-member-added rejects parent literal-member-added at actual service boot"
      },
      {
        "rowId": "bg-r1-parent-literal-member-omitted",
        "file": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "testName": "bg-r1-parent-literal-member-omitted rejects parent literal-member-omitted at actual service boot"
      },
      {
        "rowId": "bg-r1-parent-literal-member-changed",
        "file": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "testName": "bg-r1-parent-literal-member-changed rejects parent literal-member-changed at actual service boot"
      },
      {
        "rowId": "bg-r1-census",
        "file": "packages/operator-core/lib/source-preview-export.test.ts",
        "testName": "bg-r1-census requires exact predeclared selector and branch population"
      },
      {
        "rowId": "bg-r1-compiler-source-transient-substitution-restored",
        "file": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "testName": "bg-r1-compiler-source-transient-substitution-restored rejects selected source changed during real compiler consumption then restored before final fence"
      },
      {
        "rowId": "bg-r1-compiler-dependency-transient-substitution-restored",
        "file": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "testName": "bg-r1-compiler-dependency-transient-substitution-restored rejects selected dependency changed during real compiler consumption then restored before final fence"
      },
      {
        "rowId": "bg-r1-compiler-immutable-input-positive-control",
        "file": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "testName": "bg-r1-compiler-immutable-input-positive-control qualifies ordinary real compilation from the frozen accepted source and dependency bytes"
      }
    ]
  },
  "manifestSha256": "6e1ac5bccd5b36b38e6412cb58575abc612d7260341a3d337be236df772c104f",
  "bindings": {
    "measuredAfterRuns": true,
    "head": "9f09f9cd6596b105135999d412435fd484e98506",
    "files": [
      {
        "path": "packages/operator-core/lib/testing-case-filter.ts",
        "sha256": "dc829057473145962b47a0e3b3ac47588e5e0ee5f649b2d6674359961ec0dbe3",
        "bytes": 11349
      },
      {
        "path": "packages/operator-core/lib/testing-case-filter.test.ts",
        "sha256": "c6fbbe03c0ef141f9581dda34f4231d4ca770b257de01cf6c46b46eca577d9ed",
        "bytes": 12288
      },
      {
        "path": "packages/operator-core/lib/source-preview.fixture.ts",
        "sha256": "438a91613766a52a5007e0ad76345d9aeab2c005fe64c0ca8b8dca1affdd85ff",
        "bytes": 17579
      },
      {
        "path": "packages/operator-core/lib/source-preview-export.test.ts",
        "sha256": "068d5d7ddec0147d71c501eaabb65c92cfaa55473aa912a61e0cd00e29c7c8c6",
        "bytes": 256882
      },
      {
        "path": "packages/operator-core/lib/source-preview.r1-cases.fixture.json",
        "sha256": "6e1ac5bccd5b36b38e6412cb58575abc612d7260341a3d337be236df772c104f",
        "bytes": 8371
      },
      {
        "path": "apps/operator/lib/bundle-host-freshness.test.ts",
        "sha256": "e4141bdbb2373818ed4289fafef55ca68cc46bccf272623ad5229581c243a945",
        "bytes": 16288
      },
      {
        "path": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "sha256": "7444e02b8dd91e319aebdbc9b11ed37c9b9f6bcdab9d178d744e803e60b8dcfc",
        "bytes": 19429
      }
    ]
  },
  "canonicalCensus": {
    "runs": [
      {
        "id": "22607628",
        "file_path": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "status": "pass",
        "commit_sha": "9f09f9cd6596b105135999d412435fd484e98506",
        "worktree_dirty": true,
        "started_at": "2026-10-29T04:39:20.387Z",
        "finished_at": "2026-10-29T04:39:30.512Z"
      },
      {
        "id": "22607629",
        "file_path": "packages/operator-core/lib/source-preview-export.test.ts",
        "status": "pass",
        "commit_sha": "9f09f9cd6596b105135999d412435fd484e98506",
        "worktree_dirty": true,
        "started_at": "2026-10-29T04:39:24.350Z",
        "finished_at": "2026-10-29T04:39:59.215Z"
      },
      {
        "id": "22607637",
        "file_path": "apps/operator/lib/bundle-host-freshness.test.ts",
        "status": "pass",
        "commit_sha": "9f09f9cd6596b105135999d412435fd484e98506",
        "worktree_dirty": true,
        "started_at": "2026-10-29T04:40:16.038Z",
        "finished_at": "2026-10-29T04:40:51.646Z"
      }
    ],
    "ok": true,
    "issues": [],
    "matched": [
      {
        "rowId": "source-census",
        "receipt": {
          "file": "packages/operator-core/lib/source-preview-export.test.ts",
          "testRunId": 22607629,
          "caseKey": "BG inherited manifest and original source boundaries > BG-PREP-EXACT-SELECTION rejects a changed frozen source census at either compiler boundary",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 10790,
          "errorTail": null
        }
      },
      {
        "rowId": "accepted-members",
        "receipt": {
          "file": "packages/operator-core/lib/source-preview-export.test.ts",
          "testRunId": 22607629,
          "caseKey": "BG inherited manifest and original source boundaries > BG-PREP-EXACT-SELECTION rejects omitted or added accepted manifest members",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 5992,
          "errorTail": null
        }
      },
      {
        "rowId": "builder-identity",
        "receipt": {
          "file": "apps/operator/lib/bundle-host-freshness.test.ts",
          "testRunId": 22607637,
          "caseKey": "BG original builder identity > BG-PREP-EXACT-SELECTION rejects changed builder configuration or toolchain identity",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 20827,
          "errorTail": null
        }
      },
      {
        "rowId": "parent-authority",
        "receipt": {
          "file": "packages/operator-core/lib/release/operator-artifact.test.ts",
          "testRunId": 22607628,
          "caseKey": "operator release artifact provenance > BG-PREP-EXACT-SELECTION rejects missing unknown or substituted parent manifest authority at actual service boot",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 16,
          "errorTail": null
        }
      },
      {
        "rowId": "parent-schema-digest",
        "receipt": {
          "file": "packages/operator-core/lib/release/operator-artifact.test.ts",
          "testRunId": 22607628,
          "caseKey": "operator release artifact provenance > BG-PREP-EXACT-SELECTION rejects parent manifest schema or digest mismatch at actual service boot",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 9,
          "errorTail": null
        }
      },
      {
        "rowId": "parent-literal-members",
        "receipt": {
          "file": "packages/operator-core/lib/release/operator-artifact.test.ts",
          "testRunId": 22607628,
          "caseKey": "operator release artifact provenance > BG-PREP-EXACT-SELECTION rejects added omitted or changed literal parent manifest members at actual service boot",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 15,
          "errorTail": null
        }
      },
      {
        "rowId": "bg-r1-source-changed-before-build",
        "receipt": {
          "file": "packages/operator-core/lib/source-preview-export.test.ts",
          "testRunId": 22607629,
          "caseKey": "BG inherited manifest and original source boundaries > bg-r1-source-changed-before-build rejects changed frozen source before-build",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 1567,
          "errorTail": null
        }
      },
      {
        "rowId": "bg-r1-source-missing-before-build",
        "receipt": {
          "file": "packages/operator-core/lib/source-preview-export.test.ts",
          "testRunId": 22607629,
          "caseKey": "BG inherited manifest and original source boundaries > bg-r1-source-missing-before-build rejects missing frozen source before-build",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 1395,
          "errorTail": null
        }
      },
      {
        "rowId": "bg-r1-source-added-before-build",
        "receipt": {
          "file": "packages/operator-core/lib/source-preview-export.test.ts",
          "testRunId": 22607629,
          "caseKey": "BG inherited manifest and original source boundaries > bg-r1-source-added-before-build rejects added frozen source before-build",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 1462,
          "errorTail": null
        }
      },
      {
        "rowId": "bg-r1-member-omitted-before-build",
        "receipt": {
          "file": "packages/operator-core/lib/source-preview-export.test.ts",
          "testRunId": 22607629,
          "caseKey": "BG inherited manifest and original source boundaries > bg-r1-member-omitted-before-build rejects omitted accepted member before-build",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 1302,
          "errorTail": null
        }
      },
      {
        "rowId": "bg-r1-member-added-before-build",
        "receipt": {
          "file": "packages/operator-core/lib/source-preview-export.test.ts",
          "testRunId": 22607629,
          "caseKey": "BG inherited manifest and original source boundaries > bg-r1-member-added-before-build rejects added accepted member before-build",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 1636,
          "errorTail": null
        }
      },
      {
        "rowId": "bg-r1-builder-configuration-before-build",
        "receipt": {
          "file": "apps/operator/lib/bundle-host-freshness.test.ts",
          "testRunId": 22607637,
          "caseKey": "BG original builder identity > bg-r1-builder-configuration-before-build rejects changed builder-configuration before-build",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 4332,
          "errorTail": null
        }
      },
      {
        "rowId": "bg-r1-toolchain-identity-before-build",
        "receipt": {
          "file": "apps/operator/lib/bundle-host-freshness.test.ts",
          "testRunId": 22607637,
          "caseKey": "BG original builder identity > bg-r1-toolchain-identity-before-build rejects changed toolchain-identity before-build",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 3213,
          "errorTail": null
        }
      },
      {
        "rowId": "bg-r1-source-changed-before-publication",
        "receipt": {
          "file": "packages/operator-core/lib/source-preview-export.test.ts",
          "testRunId": 22607629,
          "caseKey": "BG inherited manifest and original source boundaries > bg-r1-source-changed-before-publication rejects changed frozen source before-publication",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 1523,
          "errorTail": null
        }
      },
      {
        "rowId": "bg-r1-source-missing-before-publication",
        "receipt": {
          "file": "packages/operator-core/lib/source-preview-export.test.ts",
          "testRunId": 22607629,
          "caseKey": "BG inherited manifest and original source boundaries > bg-r1-source-missing-before-publication rejects missing frozen source before-publication",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 1495,
          "errorTail": null
        }
      },
      {
        "rowId": "bg-r1-source-added-before-publication",
        "receipt": {
          "file": "packages/operator-core/lib/source-preview-export.test.ts",
          "testRunId": 22607629,
          "caseKey": "BG inherited manifest and original source boundaries > bg-r1-source-added-before-publication rejects added frozen source before-publication",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 1301,
          "errorTail": null
        }
      },
      {
        "rowId": "bg-r1-member-omitted-before-publication",
        "receipt": {
          "file": "packages/operator-core/lib/source-preview-export.test.ts",
          "testRunId": 22607629,
          "caseKey": "BG inherited manifest and original source boundaries > bg-r1-member-omitted-before-publication rejects omitted accepted member before-publication",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 1982,
          "errorTail": null
        }
      },
      {
        "rowId": "bg-r1-member-added-before-publication",
        "receipt": {
          "file": "packages/operator-core/lib/source-preview-export.test.ts",
          "testRunId": 22607629,
          "caseKey": "BG inherited manifest and original source boundaries > bg-r1-member-added-before-publication rejects added accepted member before-publication",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 1618,
          "errorTail": null
        }
      },
      {
        "rowId": "bg-r1-builder-configuration-before-publication",
        "receipt": {
          "file": "apps/operator/lib/bundle-host-freshness.test.ts",
          "testRunId": 22607637,
          "caseKey": "BG original builder identity > bg-r1-builder-configuration-before-publication rejects changed builder-configuration before-publication",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 3244,
          "errorTail": null
        }
      },
      {
        "rowId": "bg-r1-toolchain-identity-before-publication",
        "receipt": {
          "file": "apps/operator/lib/bundle-host-freshness.test.ts",
          "testRunId": 22607637,
          "caseKey": "BG original builder identity > bg-r1-toolchain-identity-before-publication rejects changed toolchain-identity before-publication",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 3524,
          "errorTail": null
        }
      },
      {
        "rowId": "bg-r1-parent-authority-absent",
        "receipt": {
          "file": "packages/operator-core/lib/release/operator-artifact.test.ts",
          "testRunId": 22607628,
          "caseKey": "operator release artifact provenance > bg-r1-parent-authority-absent rejects parent authority-absent at actual service boot",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 13,
          "errorTail": null
        }
      },
      {
        "rowId": "bg-r1-parent-authority-unknown",
        "receipt": {
          "file": "packages/operator-core/lib/release/operator-artifact.test.ts",
          "testRunId": 22607628,
          "caseKey": "operator release artifact provenance > bg-r1-parent-authority-unknown rejects parent authority-unknown at actual service boot",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 5,
          "errorTail": null
        }
      },
      {
        "rowId": "bg-r1-parent-authority-candidate-substitution",
        "receipt": {
          "file": "packages/operator-core/lib/release/operator-artifact.test.ts",
          "testRunId": 22607628,
          "caseKey": "operator release artifact provenance > bg-r1-parent-authority-candidate-substitution rejects parent authority-candidate-substitution at actual service boot",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 4,
          "errorTail": null
        }
      },
      {
        "rowId": "bg-r1-parent-schema-mismatch",
        "receipt": {
          "file": "packages/operator-core/lib/release/operator-artifact.test.ts",
          "testRunId": 22607628,
          "caseKey": "operator release artifact provenance > bg-r1-parent-schema-mismatch rejects parent schema-mismatch at actual service boot",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 5,
          "errorTail": null
        }
      },
      {
        "rowId": "bg-r1-parent-digest-mismatch",
        "receipt": {
          "file": "packages/operator-core/lib/release/operator-artifact.test.ts",
          "testRunId": 22607628,
          "caseKey": "operator release artifact provenance > bg-r1-parent-digest-mismatch rejects parent digest-mismatch at actual service boot",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 5,
          "errorTail": null
        }
      },
      {
        "rowId": "bg-r1-parent-literal-member-added",
        "receipt": {
          "file": "packages/operator-core/lib/release/operator-artifact.test.ts",
          "testRunId": 22607628,
          "caseKey": "operator release artifact provenance > bg-r1-parent-literal-member-added rejects parent literal-member-added at actual service boot",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 5,
          "errorTail": null
        }
      },
      {
        "rowId": "bg-r1-parent-literal-member-omitted",
        "receipt": {
          "file": "packages/operator-core/lib/release/operator-artifact.test.ts",
          "testRunId": 22607628,
          "caseKey": "operator release artifact provenance > bg-r1-parent-literal-member-omitted rejects parent literal-member-omitted at actual service boot",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 5,
          "errorTail": null
        }
      },
      {
        "rowId": "bg-r1-parent-literal-member-changed",
        "receipt": {
          "file": "packages/operator-core/lib/release/operator-artifact.test.ts",
          "testRunId": 22607628,
          "caseKey": "operator release artifact provenance > bg-r1-parent-literal-member-changed rejects parent literal-member-changed at actual service boot",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 8,
          "errorTail": null
        }
      },
      {
        "rowId": "bg-r1-census",
        "receipt": {
          "file": "packages/operator-core/lib/source-preview-export.test.ts",
          "testRunId": 22607629,
          "caseKey": "bg-r1-census requires exact predeclared selector and branch population",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 7,
          "errorTail": null
        }
      },
      {
        "rowId": "bg-r1-compiler-source-transient-substitution-restored",
        "receipt": {
          "file": "packages/operator-core/lib/release/operator-artifact.test.ts",
          "testRunId": 22607628,
          "caseKey": "BG compiler input custody > bg-r1-compiler-source-transient-substitution-restored rejects selected source changed during real compiler consumption then restored before final fence",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 3839,
          "errorTail": null
        }
      },
      {
        "rowId": "bg-r1-compiler-dependency-transient-substitution-restored",
        "receipt": {
          "file": "packages/operator-core/lib/release/operator-artifact.test.ts",
          "testRunId": 22607628,
          "caseKey": "BG compiler input custody > bg-r1-compiler-dependency-transient-substitution-restored rejects selected dependency changed during real compiler consumption then restored before final fence",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 3146,
          "errorTail": null
        }
      },
      {
        "rowId": "bg-r1-compiler-immutable-input-positive-control",
        "receipt": {
          "file": "packages/operator-core/lib/release/operator-artifact.test.ts",
          "testRunId": 22607628,
          "caseKey": "BG compiler input custody > bg-r1-compiler-immutable-input-positive-control qualifies ordinary real compilation from the frozen accepted source and dependency bytes",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 3039,
          "errorTail": null
        }
      }
    ],
    "skippedOutsidePopulation": 441,
    "rawReadbackPath": "/tmp/bg-p001-r1-canonical-census-working-20261029.json",
    "rawSha256": "61094eca7038deda0537a5f3bd550575ffac23b225e5ae501ce35fec53b9380d"
  },
  "resolverSuite": {
    "status": "pass",
    "tests": 36,
    "log": "/tmp/bg-p001-r1-census-resolver-final-working-20261029.log",
    "childSubstituted": 0,
    "worktreeDirty": true,
    "canonicalTestRunId": 22607668
  },
  "namedTypes": {
    "status": "clean",
    "files": [
      "packages/operator-core/lib/testing-case-filter.ts",
      "packages/operator-core/lib/testing-case-filter.test.ts",
      "packages/operator-core/lib/source-preview.fixture.ts",
      "packages/operator-core/lib/source-preview-export.test.ts",
      "packages/operator-core/lib/release/operator-artifact.test.ts"
    ],
    "log": "/tmp/bg-p001-r1-census-types-20261029.log"
  },
  "mutation": {
    "status": "NOT_ESTABLISHED",
    "terminalExit": 2,
    "reason": "baseline has unclassified or incomplete committed-source notice: scripts/test-files.mjs substituted",
    "parseOrAssertionProof": false,
    "treeIntegrity": "verified",
    "log": "/tmp/bg-p001-r1-census-missing-guard-mutation-20261029.log",
    "next": "rerun narrow missing-receipt guard bypass and ordinary positive in exact containing committed tree"
  },
  "reuse": "Extended testing-case-filter.ts and the existing source-preview.fixture.ts; one literal BAR fixture preserves the predeclared R1 population. Source guard does not execute tests or write the ledger."
}

