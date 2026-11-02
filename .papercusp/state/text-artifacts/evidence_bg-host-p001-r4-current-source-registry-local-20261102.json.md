---
rel_path: "evidence/bg-host-p001-r4-current-source-registry-local-20261102.json"
updated_at: 1793636503854
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "WI-6554700010028547",
  "taskId": "0mvzglze65ia5s41wex",
  "terminalExit": 0,
  "log": "/tmp/luna-r4-current-registry-source41-20261102.log",
  "scope": "Local current source inventory and R4 registry verification; dirty snapshot, not immutable acceptance",
  "rows": [
    {
      "id": "23005436",
      "status": "pass",
      "file_path": "packages/operator-core/lib/source-preview-export.test.ts",
      "commit_sha": "7a4ef5eaa702deb258b9608490553ee2957f2e57",
      "worktree_dirty": true,
      "harness_slug": "papercusp",
      "workspace_id": "papercusp-workspace",
      "started_at": "2026-11-02T16:15:14.995Z",
      "finished_at": "2026-11-02T16:17:37.754Z",
      "execution_details": {
        "root": "/home/marsh-office/papercupai-workspace/papercusp",
        "failed": 0,
        "passed": 41,
        "skipped": 426,
        "filePath": "packages/operator-core/lib/source-preview-export.test.ts",
        "commitSha": "7a4ef5eaa702deb258b9608490553ee2957f2e57",
        "testLayer": "unit",
        "runGroupId": null,
        "harnessSlug": "papercusp",
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-11-02T16:15:06.723Z",
        "mutationPhase": null,
        "schemaVersion": 1,
        "worktreeDirty": true,
        "testNamePattern": "BG teardown resource inventory source controls|bg-r4-census",
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
          "bg-r4-census requires exact predeclared selector and branch population"
        ],
        "worktreeDirtyReason": "HEAD moved 902020006acc -> 7a4ef5eaa702",
        "testTimingRuntimeIdentity": "node:25.9.0 linux/x64 vitest:4.1.8",
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      }
    }
  ],
  "cases": [
    {
      "test_run_id": "23005436",
      "case_key": "bg-r4-census requires exact predeclared selector and branch population",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-error-history-delete refuses delete of original error-history custody",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-error-history-replace refuses replace of original error-history custody",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-error-history-reset refuses reset of original error-history custody",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-error-history-rewrite refuses rewrite of original error-history custody",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-evidence-reference-delete refuses delete of original evidence-reference custody",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-evidence-reference-replace refuses replace of original evidence-reference custody",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-evidence-reference-reset refuses reset of original evidence-reference custody",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-evidence-reference-rewrite refuses rewrite of original evidence-reference custody",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-origin-delete refuses delete of original origin custody",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-origin-replace refuses replace of original origin custody",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-origin-reset refuses reset of original origin custody",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-origin-rewrite refuses rewrite of original origin custody",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-owner-delete refuses delete of original owner custody",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-owner-replace refuses replace of original owner custody",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-owner-reset refuses reset of original owner custody",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-owner-rewrite refuses rewrite of original owner custody",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-parent-fire24-delete refuses delete of original parent-fire24 custody",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-parent-fire24-replace refuses replace of original parent-fire24 custody",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-parent-fire24-reset refuses reset of original parent-fire24 custody",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-custody-parent-fire24-rewrite refuses rewrite of original parent-fire24 custody",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-cancellation-after reconciles late descendants on cancellation at original teardown deadline after",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-cancellation-exactly-at reconciles late descendants on cancellation at original teardown deadline exactly-at",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-cancellation-immediately-before reconciles late descendants on cancellation at original teardown deadline immediately-before",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-failure-after reconciles late descendants on failure at original teardown deadline after",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-failure-exactly-at reconciles late descendants on failure at original teardown deadline exactly-at",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-failure-immediately-before reconciles late descendants on failure at original teardown deadline immediately-before",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-interruption-recovery-after reconciles late descendants on interruption-recovery at original teardown deadline after",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-interruption-recovery-exactly-at reconciles late descendants on interruption-recovery at original teardown deadline exactly-at",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-interruption-recovery-immediately-before reconciles late descendants on interruption-recovery at original teardown deadline immediately-before",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-success-after reconciles late descendants on success at original teardown deadline after",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-success-exactly-at reconciles late descendants on success at original teardown deadline exactly-at",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-success-immediately-before reconciles late descendants on success at original teardown deadline immediately-before",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-timeout-after reconciles late descendants on timeout at original teardown deadline after",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-timeout-exactly-at reconciles late descendants on timeout at original teardown deadline exactly-at",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-timeout-immediately-before reconciles late descendants on timeout at original teardown deadline immediately-before",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > BG-TEARDOWN-RECONCILE keeps recursive inventory append-only through late-child reconciliation",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > BG-TEARDOWN-RECONCILE preserves original parent fire24 owner origin and errors custody",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > BG-TEARDOWN-RECONCILE refuses terminal success after the predeclared teardown deadline",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > refuses complete-event truncation after restart against independently retained history",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005436",
      "case_key": "BG teardown resource inventory source controls > refuses inventory rewrite, duplicate resource and retained-peer corruption before settlement",
      "status": "pass",
      "error_tail": null
    }
  ],
  "relatedLocalProof": "evidence/bg-host-p001-r4-boundary-census-local-20261102.json",
  "remaining": "await396093/git-sync resource release, committed exact inputs and new narrow boundary mutants; original parent UNKNOWN; Luna NOT SHIPPED"
}

