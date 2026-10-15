---
rel_path: "audits/parked-agent-resumption-2026-10-09/fire55-reporter-committed-ledger-custody-20261015-424d5.json"
updated_at: 1792027355654
_body: "content"
---

{
  "schemaVersion": "parked-fire55-reporter-custody-v1",
  "observedAt": "2026-10-15T01:22:05.130447+00:00",
  "workItem": "EI-26005080504809800",
  "originalProof": {
    "slug": "papercusp",
    "rel_path": "audits/parked-agent-resumption-2026-10-09/fire54-reporter-filtered-sibling-fix-20261015-424d5.json",
    "chars": 148848,
    "sha256": "6d085fe368467bf1adfd1c5f0900d7d3da8f3d573a85fd5ae9f6cfa13c66c25e"
  },
  "committedCustody": [
    {
      "path": "libs/test-config/src/admin-test-runs-reporter.ts",
      "repoRoot": "/home/marsh-office/papercupai-workspace/papercusp/libs/test-config",
      "repoPath": "src/admin-test-runs-reporter.ts",
      "head": "e5a48e8ea2ca8cbba07c81e47d08b8424a563d8f",
      "workSha": "2e88a42b283606f925ce9dc66170030bcd645188e67c5a16e0ae186b0540ed06",
      "committedSha": "2e88a42b283606f925ce9dc66170030bcd645188e67c5a16e0ae186b0540ed06",
      "equal": true,
      "lastCommit": "ad860f94d2a48c547758108c9b7436a92b65fc72"
    },
    {
      "path": "libs/test-config/src/admin-test-runs-reporter.test.ts",
      "repoRoot": "/home/marsh-office/papercupai-workspace/papercusp/libs/test-config",
      "repoPath": "src/admin-test-runs-reporter.test.ts",
      "head": "e5a48e8ea2ca8cbba07c81e47d08b8424a563d8f",
      "workSha": "a7ed058ae252620ba9bf50d447fa34f5632a2bbb428f4e9d0975192229d49be7",
      "committedSha": "a7ed058ae252620ba9bf50d447fa34f5632a2bbb428f4e9d0975192229d49be7",
      "equal": true,
      "lastCommit": "e5a48e8ea2ca8cbba07c81e47d08b8424a563d8f"
    }
  ],
  "ledger": {
    "count": 2,
    "total": 2,
    "truncatedByLimit": false,
    "latestPerFile": false,
    "effectiveSourceFilter": "none (exact testRunIds receipt lookup)",
    "omittedBySourceFilter": 0,
    "runs": [
      {
        "id": 21249060,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/home/marsh-office/papercupai-workspace/papercusp",
        "executionDetails": {
          "root": "/home/marsh-office/papercupai-workspace/papercusp",
          "failed": 0,
          "passed": 6,
          "skipped": 166,
          "filePath": "libs/test-config/src/admin-test-runs-reporter.test.ts",
          "commitSha": "3d2e1fd122eb4823c6b044472d5d898b012c14a8",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "mutationPhase": null,
          "schemaVersion": 1,
          "worktreeDirty": true,
          "testNamePattern": "original isolated runtime receipt recording",
          "collectionFailed": false,
          "passedCaseTitles": [
            "original isolated runtime receipt recording > persists original worker receipts only for an isolated-capable project layer (integration)",
            "original isolated runtime receipt recording > persists original worker receipts only for an isolated-capable project layer (e2e)",
            "original isolated runtime receipt recording > persists original worker receipts only for an isolated-capable project layer (unit)",
            "original isolated runtime receipt recording > persists original worker receipts only for an isolated-capable project layer (browser)",
            "original isolated runtime receipt recording > persists original worker receipts only for an isolated-capable project layer (undefined)",
            "original isolated runtime receipt recording > hashes the real bytes, refusing ordinary, partial and duplicate fixture claims"
          ],
          "worktreeDirtyReason": "git status unreadable before the run: {\"command\":\"git status --porcelain --untracked-files=all\",\"timeoutMs\":2000,\"elapsedMs\":2647,\"code\":null,\"signal\":\"SIGTERM\",\"killed\":true,\"message\":\"Command failed: git status --porcelain --untracked-files=all\\n\",\"stderr\":\"\"}; {\"command\":\"git status --porcelain --untracked-files=all\",\"timeoutMs\":8000,\"elapsedMs\":8078,\"code\":null,\"signal\":\"SIGTERM\",\"killed\":true,\"message\":\"Command failed: git status --porcelain --untracked-files=all\\n\",\"stderr\":\"\"}; {\"command\":\"git status --porcelain --untracked-files=all\",\"timeoutMs\":2000,\"elapsedMs\":2009,\"code\":null,\"signal\":\"SIGTERM\",\"killed\":true,\"message\":\"Command failed: git status --porcelain --untracked-files=all\\n\",\"stderr\":\"\"}; {\"command\":\"git status --porcelain --untracked-files=all\",\"timeoutMs\":8000,\"elapsedMs\":8015,\"code\":null,\"signal\":\"SIGTERM\",\"killed\":true,\"message\":\"Command failed: git status --porcelain --untracked-files=all\\n\",\"stderr\":\"\"}",
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "libs/test-config/src/admin-test-runs-reporter.test.ts",
        "status": "pass",
        "framework": "vitest",
        "startedAt": "2026-10-15T01:05:43.289Z",
        "finishedAt": "2026-10-15T01:05:43.319Z",
        "durationMs": 30,
        "commitSha": "3d2e1fd122eb4823c6b044472d5d898b012c14a8",
        "runGroupId": null,
        "source": "local",
        "branch": "staging",
        "outputTail": null,
        "loopLagP95Ms": 20.8,
        "rssMb": 127.9,
        "saturationSuspect": false,
        "worktreeDirty": true,
        "isScratchConfig": false
      },
      {
        "id": 21249053,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/home/marsh-office/papercupai-workspace/papercusp",
        "executionDetails": {
          "root": "/home/marsh-office/papercupai-workspace/papercusp",
          "failed": 1,
          "passed": 5,
          "skipped": 166,
          "filePath": "libs/test-config/src/admin-test-runs-reporter.test.ts",
          "commitSha": "3d2e1fd122eb4823c6b044472d5d898b012c14a8",
          "testLayer": "unit",
          "runGroupId": null,
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "mutationPhase": null,
          "schemaVersion": 1,
          "worktreeDirty": true,
          "testNamePattern": "original isolated runtime receipt recording",
          "collectionFailed": false,
          "failedCaseTitles": [
            "original isolated runtime receipt recording > hashes the real bytes, refusing ordinary, partial and duplicate fixture claims"
          ],
          "passedCaseTitles": [
            "original isolated runtime receipt recording > persists original worker receipts only for an isolated-capable project layer (integration)",
            "original isolated runtime receipt recording > persists original worker receipts only for an isolated-capable project layer (e2e)",
            "original isolated runtime receipt recording > persists original worker receipts only for an isolated-capable project layer (unit)",
            "original isolated runtime receipt recording > persists original worker receipts only for an isolated-capable project layer (browser)",
            "original isolated runtime receipt recording > persists original worker receipts only for an isolated-capable project layer (undefined)"
          ],
          "worktreeDirtyReason": "87 porcelain line(s) before the run: M apps/operator-vite/package.json |  M apps/operator-vite/src/components/adv/workflows-model.test.ts |  M apps/operator-vite/src/components/adv/workflows-model.ts |  M apps/operator/bin/hosted-check-refs.test.ts |  M apps/operator/lib/psu-launcher.test.ts",
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "libs/test-config/src/admin-test-runs-reporter.test.ts",
        "status": "fail",
        "framework": "vitest",
        "startedAt": "2026-10-15T01:04:18.704Z",
        "finishedAt": "2026-10-15T01:04:18.742Z",
        "durationMs": 38,
        "commitSha": "3d2e1fd122eb4823c6b044472d5d898b012c14a8",
        "runGroupId": null,
        "source": "local",
        "branch": "staging",
        "outputTail": "original isolated runtime receipt recording > hashes the real bytes, refusing ordinary, partial and duplicate fixture claims: expected undefined to deeply equal [ { …(4) } ]\nactual: undefined\nexpected: [\n  {\n    \"lifecycleSha256\": \"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a\",\n    \"resultSha256\": \"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a\",\n    \"runId\": \"20261008T000000Z-100\",\n    \"sourceSha256\": \"44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a\",\n  },\n]",
        "loopLagP95Ms": 25.5,
        "rssMb": 165.7,
        "saturationSuspect": false,
        "worktreeDirty": true,
        "isScratchConfig": false
      }
    ]
  },
  "limits": [
    "Focused local run 21249060 is recorded worktreeDirty; source/test bytes later independently equal committed blobs. No clean-tree run claimed.",
    "Original R12 run21249005 was not backfilled. Current R12 acceptance remains separate under WI-6554700010008887.",
    "No new test run or source edit in Fire55."
  ]
}
