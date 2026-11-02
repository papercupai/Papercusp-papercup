---
rel_path: "evidence/bg-host-p001-r4-boundary-census-local-20261102.json"
updated_at: 1793636189609
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "WI-6554700010028547",
  "scope": "Local maintained boundary/census verification only; two boundary run rows have harness_slug null and are NOT acceptance bindings",
  "rows": [
    {
      "id": "23005344",
      "file_path": "apps/operator/lib/bundle-host-freshness.test.ts",
      "status": "pass",
      "harness_slug": null,
      "workspace_id": "papercusp-workspace",
      "commit_sha": "902020006accc6d889227d01dd42969e7f614626",
      "worktree_dirty": true,
      "started_at": "2026-11-02T16:06:03.812Z",
      "finished_at": "2026-11-02T16:06:06.097Z",
      "execution_details": {
        "root": "/home/marsh-office/papercupai-workspace/papercusp",
        "failed": 0,
        "passed": 1,
        "skipped": 22,
        "filePath": "apps/operator/lib/bundle-host-freshness.test.ts",
        "commitSha": "902020006accc6d889227d01dd42969e7f614626",
        "testLayer": "unit",
        "runGroupId": null,
        "harnessSlug": null,
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-11-02T16:06:00.017Z",
        "mutationPhase": null,
        "schemaVersion": 1,
        "worktreeDirty": true,
        "testNamePattern": "BG-TEARDOWN-RECONCILE",
        "collectionFailed": false,
        "passedCaseTitles": [
          "BG-TEARDOWN-RECONCILE preserves source compiler and boot evidence during cleanup"
        ],
        "worktreeDirtyReason": "98 porcelain line(s) before the run: M apps/operator-docs/src/content/docs/agent-insights/code-intel-reuse-measurement-runbook.mdx |  M apps/operator/lib/bundle-host-freshness.test.ts |  M apps/operator/scripts/__tests__/embed-sidecar-pressure-watchdog.test.ts |  M apps/operator/scripts/hooks/inject/__tests__/dispatcher.test.ts |  M apps/operator/scripts/hooks/inject/core.mjs",
        "testTimingRuntimeIdentity": "node:25.9.0 linux/x64 vitest:4.1.8",
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      }
    },
    {
      "id": "23005375",
      "file_path": "packages/operator-core/lib/release/operator-artifact.test.ts",
      "status": "pass",
      "harness_slug": null,
      "workspace_id": "papercusp-workspace",
      "commit_sha": "902020006accc6d889227d01dd42969e7f614626",
      "worktree_dirty": true,
      "started_at": "2026-11-02T16:06:19.639Z",
      "finished_at": "2026-11-02T16:06:19.705Z",
      "execution_details": {
        "root": "/home/marsh-office/papercupai-workspace/papercusp",
        "failed": 0,
        "passed": 1,
        "skipped": 29,
        "filePath": "packages/operator-core/lib/release/operator-artifact.test.ts",
        "commitSha": "902020006accc6d889227d01dd42969e7f614626",
        "testLayer": "unit",
        "runGroupId": null,
        "harnessSlug": null,
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-11-02T16:06:16.068Z",
        "mutationPhase": null,
        "schemaVersion": 1,
        "worktreeDirty": true,
        "testNamePattern": "BG-TEARDOWN-RECONCILE",
        "collectionFailed": false,
        "passedCaseTitles": [
          "operator release artifact provenance > BG-TEARDOWN-RECONCILE refuses terminal sealing with owned survivors"
        ],
        "worktreeDirtyReason": "99 porcelain line(s) before the run: M apps/operator-docs/src/content/docs/agent-insights/code-intel-reuse-measurement-runbook.mdx |  M apps/operator/lib/bundle-host-freshness.test.ts |  M apps/operator/scripts/__tests__/embed-sidecar-pressure-watchdog.test.ts |  M apps/operator/scripts/hooks/inject/__tests__/dispatcher.test.ts |  M apps/operator/scripts/hooks/inject/core.mjs",
        "testTimingRuntimeIdentity": "node:25.9.0 linux/x64 vitest:4.1.8",
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      }
    },
    {
      "id": "23005405",
      "file_path": "packages/operator-core/lib/source-preview-export.test.ts",
      "status": "pass",
      "harness_slug": "papercusp",
      "workspace_id": "papercusp-workspace",
      "commit_sha": "902020006accc6d889227d01dd42969e7f614626",
      "worktree_dirty": true,
      "started_at": "2026-11-02T16:08:50.541Z",
      "finished_at": "2026-11-02T16:08:51.874Z",
      "execution_details": {
        "root": "/home/marsh-office/papercupai-workspace/papercusp",
        "failed": 0,
        "passed": 1,
        "skipped": 466,
        "filePath": "packages/operator-core/lib/source-preview-export.test.ts",
        "commitSha": "902020006accc6d889227d01dd42969e7f614626",
        "testLayer": "unit",
        "runGroupId": null,
        "harnessSlug": "papercusp",
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-11-02T16:08:43.782Z",
        "mutationPhase": null,
        "schemaVersion": 1,
        "worktreeDirty": true,
        "testNamePattern": "bg-r4-census",
        "collectionFailed": false,
        "passedCaseTitles": [
          "bg-r4-census requires exact predeclared selector and branch population"
        ],
        "worktreeDirtyReason": "106 porcelain line(s) before the run: M apps/operator-docs/src/content/docs/agent-insights/code-intel-reuse-measurement-runbook.mdx |  M apps/operator/lib/bundle-host-freshness.test.ts |  M apps/operator/scripts/__tests__/embed-sidecar-pressure-watchdog.test.ts |  M apps/operator/scripts/hooks/inject/__tests__/dispatcher.test.ts |  M apps/operator/scripts/hooks/inject/core.mjs",
        "testTimingRuntimeIdentity": "node:25.9.0 linux/x64 vitest:4.1.8",
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      }
    }
  ],
  "cases": [
    {
      "test_run_id": "23005344",
      "case_key": "BG-TEARDOWN-RECONCILE preserves source compiler and boot evidence during cleanup",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005375",
      "case_key": "operator release artifact provenance > BG-TEARDOWN-RECONCILE refuses terminal sealing with owned survivors",
      "status": "pass",
      "error_tail": null
    },
    {
      "test_run_id": "23005405",
      "case_key": "bg-r4-census requires exact predeclared selector and branch population",
      "status": "pass",
      "error_tail": null
    }
  ],
  "fingerprints": [
    {
      "path": "apps/operator/lib/bundle-host-freshness.test.ts",
      "sha256": "c42170698522dc2fc82b035e59c3c2dc08cce880e04af5c2e69cb503367bc2d1"
    },
    {
      "path": "packages/operator-core/lib/release/operator-artifact.test.ts",
      "sha256": "e7a125ad44cfe9161940107c89eb71fcad99ff8f2fe491ccaeed3795f8fee39b"
    },
    {
      "path": "packages/operator-core/lib/source-preview.fixture.ts",
      "sha256": "859fb4d9ee31b76a0b3ba050acd4c0830d22de8b99d4ffa83f7b334130c11a3c"
    },
    {
      "path": "packages/operator-core/lib/source-preview-export.test.ts",
      "sha256": "f243713dfeba1ef5bf7a5e3572f60bfad0dc0bf54644e6752f8ccf324fa5e04f"
    },
    {
      "path": "packages/operator-core/lib/source-preview.r4-cases.fixture.json",
      "sha256": "7ec87884eab8d57b5bbf49aec05d67dcc383edc6a79d40b1ccfc9a7c6003703a"
    }
  ],
  "types": {
    "log": "/tmp/luna-r4-boundary-census-tsc-20261102.log",
    "operator": "clean exit0",
    "operatorCore": "clean exit0"
  },
  "sourceProof": "evidence/bg-host-p001-r4-deadline-history-immutable-5895-20261102.json",
  "remaining": "Await git-sync resource release396093 then pin committed inputs, run immutable selected suites and qualify narrow retained-evidence/survivor mutants. Exact post-run R4 census requires P002 restart implementation and operational/manual-provenance proof. Original parent UNKNOWN still prohibits actual BG preparation/activation; Luna NOT SHIPPED."
}

