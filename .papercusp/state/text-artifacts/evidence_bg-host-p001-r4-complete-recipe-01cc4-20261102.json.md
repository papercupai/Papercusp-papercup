---
rel_path: "evidence/bg-host-p001-r4-complete-recipe-01cc4-20261102.json"
updated_at: 1793639288169
_body: "content"
---

{
  "schemaVersion": 1,
  "scope": "Source-only supplemental proof; no native runtime or shipment acceptance",
  "plan": "bg-host-committed-generation-2026-10-24",
  "spec": "AUTO-BAR-R-4-P-001@11",
  "ref": "01cc4b182c1a19c8662d6d91907310b9bb146f43",
  "task": "0mvzi7fmu1g0j8pw13w",
  "rows": [
    {
      "id": "23007390",
      "file_path": "packages/operator-core/lib/source-preview-export.test.ts",
      "framework": "vitest",
      "status": "pass",
      "duration_ms": "220776",
      "started_at": "2026-11-02T17:00:10.167Z",
      "finished_at": "2026-11-02T17:03:50.943Z",
      "output_tail": null,
      "suite_id": null,
      "run_group_id": "32a625ce-f7c0-49cb-b0c5-60ba14a4f504",
      "source": "local",
      "branch": null,
      "commit_sha": "01cc4b182c1a19c8662d6d91907310b9bb146f43",
      "created_at": "2026-11-02T17:03:55.530Z",
      "harness_slug": "papercusp",
      "workspace_id": "papercusp-workspace",
      "loop_lag_p95_ms": null,
      "rss_mb": 161.4,
      "is_scratch_config": false,
      "worktree_dirty": false,
      "execution_details": {
        "root": "/tmp/pcv/papercusp-lint-as-committed-01cc4b182c-w2WQD0",
        "failed": 0,
        "passed": 42,
        "skipped": 425,
        "filePath": "packages/operator-core/lib/source-preview-export.test.ts",
        "commitSha": "01cc4b182c1a19c8662d6d91907310b9bb146f43",
        "testLayer": "unit",
        "runGroupId": "32a625ce-f7c0-49cb-b0c5-60ba14a4f504",
        "attribution": {
          "ownerId": "su-1b1c4d3e-d960-4de6-935e-95e776b84f58",
          "workItemId": "WI-6554700010028547"
        },
        "harnessSlug": "papercusp",
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-11-02T17:00:03.439Z",
        "mutationPhase": null,
        "schemaVersion": 1,
        "worktreeDirty": false,
        "testNamePattern": "BG teardown resource inventory source controls|bg-r4-census|bg-r1-census",
        "collectionFailed": false,
        "passedCaseTitles": [
          "BG teardown resource inventory source controls > BG-TEARDOWN-RECONCILE keeps recursive inventory append-only through late-child reconciliation",
          "BG teardown resource inventory source controls > BG-TEARDOWN-RECONCILE preserves original parent fire24 owner origin and errors custody",
          "BG teardown resource inventory source controls > bg-r4-custody-parent-fire24-delete refuses delete of original parent-fire24 custody",
          "BG teardown resource inventory source controls > bg-r4-custody-parent-fire24-reset refuses reset of original parent-fire24 custody",
          "BG teardown resource inventory source controls > bg-r4-custody-parent-fire24-replace refuses replace of original parent-fire24 custody",
          "BG teardown resource inventory source controls > bg-r4-custody-parent-fire24-rewrite refuses rewrite of original parent-fire24 custody",
          "BG teardown resource inventory source controls > bg-r4-custody-owner-delete refuses delete of original owner custody",
          "BG teardown resource inventory source controls > bg-r4-custody-owner-reset refuses reset of original owner custody",
          "BG teardown resource inventory source controls > bg-r4-custody-owner-replace refuses replace of original owner custody",
          "BG teardown resource inventory source controls > bg-r4-custody-owner-rewrite refuses rewrite of original owner custody",
          "BG teardown resource inventory source controls > bg-r4-custody-origin-delete refuses delete of original origin custody",
          "BG teardown resource inventory source controls > bg-r4-custody-origin-reset refuses reset of original origin custody",
          "BG teardown resource inventory source controls > bg-r4-custody-origin-replace refuses replace of original origin custody",
          "BG teardown resource inventory source controls > bg-r4-custody-origin-rewrite refuses rewrite of original origin custody",
          "BG teardown resource inventory source controls > bg-r4-custody-error-history-delete refuses delete of original error-history custody",
          "BG teardown resource inventory source controls > bg-r4-custody-error-history-reset refuses reset of original error-history custody",
          "BG teardown resource inventory source controls > bg-r4-custody-error-history-replace refuses replace of original error-history custody",
          "BG teardown resource inventory source controls > bg-r4-custody-error-history-rewrite refuses rewrite of original error-history custody",
          "BG teardown resource inventory source controls > bg-r4-custody-evidence-reference-delete refuses delete of original evidence-reference custody",
          "BG teardown resource inventory source controls > bg-r4-custody-evidence-reference-reset refuses reset of original evidence-reference custody",
          "BG teardown resource inventory source controls > bg-r4-custody-evidence-reference-replace refuses replace of original evidence-reference custody",
          "BG teardown resource inventory source controls > bg-r4-custody-evidence-reference-rewrite refuses rewrite of original evidence-reference custody",
          "BG teardown resource inventory source controls > bg-r4-teardown-success-immediately-before reconciles late descendants on success at original teardown deadline immediately-before",
          "BG teardown resource inventory source controls > bg-r4-teardown-success-exactly-at reconciles late descendants on success at original teardown deadline exactly-at",
          "BG teardown resource inventory source controls > bg-r4-teardown-success-after reconciles late descendants on success at original teardown deadline after",
          "BG teardown resource inventory source controls > bg-r4-teardown-failure-immediately-before reconciles late descendants on failure at original teardown deadline immediately-before",
          "BG teardown resource inventory source controls > bg-r4-teardown-failure-exactly-at reconciles late descendants on failure at original teardown deadline exactly-at",
          "BG teardown resource inventory source controls > bg-r4-teardown-failure-after reconciles late descendants on failure at original teardown deadline after",
          "BG teardown resource inventory source controls > bg-r4-teardown-cancellation-immediately-before reconciles late descendants on cancellation at original teardown deadline immediately-before",
          "BG teardown resource inventory source controls > bg-r4-teardown-cancellation-exactly-at reconciles late descendants on cancellation at original teardown deadline exactly-at",
          "BG teardown resource inventory source controls > bg-r4-teardown-cancellation-after reconciles late descendants on cancellation at original teardown deadline after",
          "BG teardown resource inventory source controls > bg-r4-teardown-timeout-immediately-before reconciles late descendants on timeout at original teardown deadline immediately-before",
          "BG teardown resource inventory source controls > bg-r4-teardown-timeout-exactly-at reconciles late descendants on timeout at original teardown deadline exactly-at",
          "BG teardown resource inventory source controls > bg-r4-teardown-timeout-after reconciles late descendants on timeout at original teardown deadline after",
          "BG teardown resource inventory source controls > bg-r4-teardown-interruption-recovery-immediately-before reconciles late descendants on interruption-recovery at original teardown deadline immediately-before",
          "BG teardown resource inventory source controls > bg-r4-teardown-interruption-recovery-exactly-at reconciles late descendants on interruption-recovery at original teardown deadline exactly-at",
          "BG teardown resource inventory source controls > bg-r4-teardown-interruption-recovery-after reconciles late descendants on interruption-recovery at original teardown deadline after",
          "BG teardown resource inventory source controls > BG-TEARDOWN-RECONCILE refuses terminal success after the predeclared teardown deadline",
          "BG teardown resource inventory source controls > refuses inventory rewrite, duplicate resource and retained-peer corruption before settlement",
          "BG teardown resource inventory source controls > refuses complete-event truncation after restart against independently retained history",
          "bg-r4-census requires exact predeclared selector and branch population",
          "bg-r1-census requires exact predeclared selector and branch population"
        ],
        "testTimingRuntimeIdentity": "node:25.9.0 linux/x64 vitest:4.1.8",
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      },
      "configuration_snapshot": {
        "flagEnv": {},
        "envSha256": {
          "NODE_ENV": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
          "PAPERCUSP_SID": "c05949a2b9e65d3ab47bc78676ba561995fcba01e121c09c62e24e3768803abe",
          "PC_HEAVY_BYPASS": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PC_HEAVY_COALESCE": "5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
          "PC_HEAVY_ADMISSION_ID": "d44c07b4eb4dbb2a1a171195306213932e83581a8ec99f5dd88105cf26b70a02",
          "PC_HEAVY_RETRY_ACTIVE": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PAPERCUSP_OPERATOR_URL": "b224a4527f06e2bb86ca2121f0bbc56e3182320cec709203d18bbc86a249e0ef",
          "PAPERCUSP_WORKSPACE_ID": "24201c2745800b53f808f1453ded79e6bcd37ed1757e8683f6a5e888dc1a90b2",
          "PC_HEAVY_ADMISSION_DIR": "2e3d87ddaf4cc9697f474e935e721a325b7c408e83a0225a656aa3864db46372",
          "PAPERCUSP_TEST_RUN_GROUP": "e95fe258acb34766f8a175f1af58bf0a5802bd1b69b52155743f0b05df7d6289",
          "PAPERCUSP_TEST_RUNS_DB_URL": "c942ee8b9c119f1e62d4016bb52dc6cabbf6f15fa7a77bdf9da269f2ab70ece8",
          "PAPERCUSP_TEST_RUN_HARNESS": "f4df233b6a1a63ee848f046a99738cafc2b1b7d23a6cd6afb140960556c128d0",
          "PC_HEAVY_RETRY_PREEMPTIONS": "4e07408562bedb8b60ce05c1decfe3ad16b72230967de01f640b7e4729b49fce",
          "PAPERCUSP_ADMISSION_CONTEXT": "1b684096082e52f422e82c1ae0a2bb8bf2448f4f4128560abf6abab3756c02eb",
          "PC_HEAVY_ADMISSION_PRIORITY": "1a6562590ef19d1045d06c4055742d38288e9e6dcd71ccde5cee80f1d5a774eb",
          "PAPERCUSP_INSTALL_MUTEX_HELD": "fa30c83846b66797b97d544aa6b74bf7314ccab42211162740289c660d17165e",
          "PAPERCUSP_TEST_RUN_WORKSPACE": "24201c2745800b53f808f1453ded79e6bcd37ed1757e8683f6a5e888dc1a90b2",
          "PAPERCUSP_TEST_RUN_WORK_ITEM": "a86647abcb539d574193a6d8df2be0aff95606e6b356c5fc3d430974d5e8930b",
          "PAPERCUSP_TEST_STARTUP_TRACE": "acce452846a9f67d6404230e79b0b190f509cde980b164040ad766ed6b9993e8",
          "PC_HEAVY_PREEMPT_AFTER_READY": "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
          "PC_HEAVY_PREEMPT_RESULT_FILE": "bc4c866238574e6079f0e946e762483eee4c8bf66a1b58371084cfcc3e80e9c4",
          "PAPERCUSP_COMMITTED_SOURCE_GIT": "106aa88494971ea56c867f371d12746ef6ce5f5bd4f73b857235642caeb88363",
          "PAPERCUSP_TASK_DEADLINE_EPOCH_MS": "9f9e5589415ae680678a625909f01f4cd95f8ce3c2bcc95d55ace69d2f545f4d",
          "PAPERCUSP_COMMITTED_SOURCE_NOTICES": "8eb78fa9894d1a1e2c9d672a86874bebc4ee38bd3eee321fbd5d7db5932ae566",
          "PAPERCUSP_RESTRICTED_HOLD_PREFLIGHT": "749a7554eba9d6fd2ad69c3b29c083c6c9e56f360a4c3216306571aa826ba539",
          "PAPERCUSP_CAPABILITY_BASH_FOREGROUND": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          "PAPERCUSP_CAPABILITY_BASH_BACKGROUND_TASK_ID": "c9e3a0fa2ff6a5f9b198546b16e93608313bdb689353b08959eb2ac0ae3242ea",
          "PAPERCUSP_CAPABILITY_BASH_FOREGROUND_TIMEOUT_MS": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        },
        "fingerprint": "sha256-config-snapshot-v1:59b96e3e87f201cec2c5c98d3bf2f4ee20b48d305f9bc3bd414ff68e94c99c41",
        "schemaVersion": 1
      }
    }
  ],
  "cases": [
    {
      "test_run_id": "23007390",
      "case_index": 0,
      "case_key": "BG teardown resource inventory source controls > BG-TEARDOWN-RECONCILE keeps recursive inventory append-only through late-child reconciliation",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 13383,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 1,
      "case_key": "BG teardown resource inventory source controls > BG-TEARDOWN-RECONCILE preserves original parent fire24 owner origin and errors custody",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 10,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 2,
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-parent-fire24-delete refuses delete of original parent-fire24 custody",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 5,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 3,
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-parent-fire24-reset refuses reset of original parent-fire24 custody",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 3,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 4,
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-parent-fire24-replace refuses replace of original parent-fire24 custody",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 3,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 5,
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-parent-fire24-rewrite refuses rewrite of original parent-fire24 custody",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 3,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 6,
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-owner-delete refuses delete of original owner custody",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 2,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 7,
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-owner-reset refuses reset of original owner custody",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 3,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 8,
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-owner-replace refuses replace of original owner custody",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 3,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 9,
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-owner-rewrite refuses rewrite of original owner custody",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 2,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 10,
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-origin-delete refuses delete of original origin custody",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 2,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 11,
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-origin-reset refuses reset of original origin custody",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 2,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 12,
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-origin-replace refuses replace of original origin custody",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 2,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 13,
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-origin-rewrite refuses rewrite of original origin custody",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 2,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 14,
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-error-history-delete refuses delete of original error-history custody",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 2,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 15,
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-error-history-reset refuses reset of original error-history custody",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 2,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 16,
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-error-history-replace refuses replace of original error-history custody",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 2,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 17,
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-error-history-rewrite refuses rewrite of original error-history custody",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 2,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 18,
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-evidence-reference-delete refuses delete of original evidence-reference custody",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 2,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 19,
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-evidence-reference-reset refuses reset of original evidence-reference custody",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 2,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 20,
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-evidence-reference-replace refuses replace of original evidence-reference custody",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 2,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 21,
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-evidence-reference-rewrite refuses rewrite of original evidence-reference custody",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 2,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 22,
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-success-immediately-before reconciles late descendants on success at original teardown deadline immediately-before",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 9388,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 23,
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-success-exactly-at reconciles late descendants on success at original teardown deadline exactly-at",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 13048,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 24,
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-success-after reconciles late descendants on success at original teardown deadline after",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 12479,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 25,
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-failure-immediately-before reconciles late descendants on failure at original teardown deadline immediately-before",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 11740,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 26,
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-failure-exactly-at reconciles late descendants on failure at original teardown deadline exactly-at",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 9637,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 27,
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-failure-after reconciles late descendants on failure at original teardown deadline after",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 12753,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 28,
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-cancellation-immediately-before reconciles late descendants on cancellation at original teardown deadline immediately-before",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 13122,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 29,
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-cancellation-exactly-at reconciles late descendants on cancellation at original teardown deadline exactly-at",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 18022,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 30,
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-cancellation-after reconciles late descendants on cancellation at original teardown deadline after",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 21496,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 31,
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-timeout-immediately-before reconciles late descendants on timeout at original teardown deadline immediately-before",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 22205,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 32,
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-timeout-exactly-at reconciles late descendants on timeout at original teardown deadline exactly-at",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 12309,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 33,
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-timeout-after reconciles late descendants on timeout at original teardown deadline after",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 13926,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 34,
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-interruption-recovery-immediately-before reconciles late descendants on interruption-recovery at original teardown deadline immediately-before",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 12002,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 35,
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-interruption-recovery-exactly-at reconciles late descendants on interruption-recovery at original teardown deadline exactly-at",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 9324,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 36,
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-interruption-recovery-after reconciles late descendants on interruption-recovery at original teardown deadline after",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 14538,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 37,
      "case_key": "BG teardown resource inventory source controls > BG-TEARDOWN-RECONCILE refuses terminal success after the predeclared teardown deadline",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 6,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 38,
      "case_key": "BG teardown resource inventory source controls > refuses inventory rewrite, duplicate resource and retained-peer corruption before settlement",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 5,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 39,
      "case_key": "BG teardown resource inventory source controls > refuses complete-event truncation after restart against independently retained history",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 2,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 40,
      "case_key": "bg-r4-census requires exact predeclared selector and branch population",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 3,
      "error_tail": null
    },
    {
      "test_run_id": "23007390",
      "case_index": 41,
      "case_key": "bg-r1-census requires exact predeclared selector and branch population",
      "occurrence": 1,
      "status": "pass",
      "duration_ms": 1,
      "error_tail": null
    }
  ],
  "recipe": {
    "sourceGlobs": [
      "apps/operator/bin/release/**"
    ],
    "fixturePaths": [
      "packages/operator-core/lib/source-preview-export.test.ts",
      "packages/operator-core/lib/source-preview.fixture.ts",
      "packages/operator-core/lib/source-preview.r4-cases.fixture.json"
    ]
  },
  "withdrawnUnmeasurableBinding": 75083,
  "newBinding": 75116,
  "currentnessRead": {
    "exitCode": 1,
    "result": null,
    "errorRef": "/tmp/luna-r4-boundary-01cc4-final-current-20261102.err"
  },
  "log": {
    "path": "/tmp/luna-r4-source-complete-recipe-01cc4-20261102.log",
    "sha256": "6a3036161130964218efb750d885c00f6f3604a5f91aa9da0d5d3a3b96c9adb5",
    "terminal": [
      "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=01cc4b182c uncommittedPaths=0/1 provenance=stamped startedAt=2026-11-02T16:59:25.817Z childSubstituted=0 childNoticeOffsetBytes=0 skippedTests=425",
      "R4_COMPLETE_RECIPE_TERMINAL={\"root\":\"/tmp/pcv/papercusp-lint-as-committed-01cc4b182c-w2WQD0\",\"ref\":\"01cc4b182c1a19c8662d6d91907310b9bb146f43\",\"group\":\"32a625ce-f7c0-49cb-b0c5-60ba14a4f504\",\"status\":0,\"signal\":null}"
    ]
  },
  "priorCompleteProof": "evidence/bg-host-p001-r4-boundary-registry-immutable-01cc4-20261102.json",
  "followup": "EI-27696477758604810",
  "remaining": [
    "P002 restart/rollback implementation and full42 executed census",
    "Operational terminal and native acceptance/P003 independent verification",
    "Original parent e0f2 UNKNOWN; no actual BG preparation/activation",
    "Luna shipment"
  ]
}
