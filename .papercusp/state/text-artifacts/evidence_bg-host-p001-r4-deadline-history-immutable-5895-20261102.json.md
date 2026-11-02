---
rel_path: "evidence/bg-host-p001-r4-deadline-history-immutable-5895-20261102.json"
updated_at: 1793635288102
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "WI-6554700010028547",
  "scope": "Immutable R4 original-deadline and independent-history source control evidence only; no operational BG acceptance or shipment",
  "commit": "58952091fb2b0476b8b4c5e501e7d6a5a9d64afc",
  "taskId": "0mvzfagyra7jtu11n7x",
  "terminalExit": 0,
  "log": "/tmp/luna-r4-clock-history-vitest-mutations-5895-20261102.log",
  "fingerprints": [
    {
      "path": "packages/operator-core/lib/verifier-source.ts",
      "frozen": "338778b5d2820f32b9b714f97e835155593b17389a768aa42bd59924c3b5f904",
      "current": "338778b5d2820f32b9b714f97e835155593b17389a768aa42bd59924c3b5f904"
    },
    {
      "path": "packages/operator-core/lib/source-preview-export.test.ts",
      "frozen": "ce77b8a4c0e4cf62f710c9f7e679215b83259693e568e6431ff62e070ce4f8f4",
      "current": "ce77b8a4c0e4cf62f710c9f7e679215b83259693e568e6431ff62e070ce4f8f4"
    },
    {
      "path": "scripts/source-preview.mjs",
      "frozen": "a11ea71505b723c4ad93df583ef693e3af814b3da19addb50ccd1c4ffd2adeb3",
      "current": "a11ea71505b723c4ad93df583ef693e3af814b3da19addb50ccd1c4ffd2adeb3"
    },
    {
      "path": "scripts/source-preview.d.mts",
      "frozen": "5cdf6f56432ae988da1e92d43d4b1a0ebd693e3c94aecf0c1705bc6c36f9990b",
      "current": "5cdf6f56432ae988da1e92d43d4b1a0ebd693e3c94aecf0c1705bc6c36f9990b"
    }
  ],
  "protocol": {
    "probes": [
      {
        "schemaVersion": 1,
        "result": {
          "baselineExit": 0,
          "mutantParse": "ok",
          "verdict": "caught",
          "relocation": "overlay",
          "assertionEvidence": "vitest-failed-tests",
          "target": "copy-out",
          "baselineLedger": "test_runs:23003356",
          "copyBaselineLedger": "test_runs:23003870",
          "guardExit": 1,
          "mutantLedger": "test_runs:23003882",
          "expected": "caught"
        },
        "argv": [
          "--file",
          "packages/operator-core/lib/verifier-source.ts",
          "--mutate",
          "if (index($_, \"deadlineExceeded ||= now() >= header.deadlineEpochMs;\") >= 0) { $_ = \"      deadlineExceeded ||= false; // narrowly bypass inherited teardown deadline\\n\"; }",
          "--test",
          "test -r {} && cd packages/operator-core && NODE_OPTIONS= NODE_PATH= ../../scripts/pc-heavy.sh node ../../node_modules/vitest/vitest.mjs run lib/source-preview-export.test.ts -t 'bg-r4-teardown-|BG-TEARDOWN-RECONCILE keeps recursive inventory append-only'",
          "--expect",
          "caught",
          "--relocation",
          "overlay",
          "--fake-destructive"
        ],
        "environment": {
          "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED": 1,
          "PAPERCUSP_TEST_RUN_HARNESS": "papercusp",
          "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO": "/home/marsh-office/papercupai-workspace/papercusp",
          "PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL": "http://127.0.0.1:3170/api/health",
          "PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT": "auto"
        },
        "runnerCommit": "58952091fb2b0476b8b4c5e501e7d6a5a9d64afc",
        "cwd": ".",
        "runnerPath": "scripts/mutation-probe.sh",
        "runnerSha256": "f131184b934757f3923b06fcd75629044bd153eff3b24712c365a6823d509472"
      },
      {
        "environment": {
          "PAPERCUSP_MUTATION_DESCRIPTOR_EXPORT": "auto",
          "PAPERCUSP_MUTATION_DESCRIPTOR_READER_HEALTH_URL": "http://127.0.0.1:3170/api/health",
          "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REPO": "/home/marsh-office/papercupai-workspace/papercusp",
          "PAPERCUSP_MUTATION_DESCRIPTOR_READER_REQUIRED": 1,
          "PAPERCUSP_TEST_RUN_HARNESS": "papercusp"
        },
        "runnerCommit": "58952091fb2b0476b8b4c5e501e7d6a5a9d64afc",
        "runnerPath": "scripts/mutation-probe.sh",
        "schemaVersion": 1,
        "argv": [
          "--file",
          "packages/operator-core/lib/verifier-source.ts",
          "--mutate",
          "if (index($_, \"const anchor = options.expectedHistory;\") >= 0) { s/const anchor/let anchor/; } if (index($_, \"inventory recovery needs independently retained history anchor\") >= 0) { $_ .= \"    anchor = { byteLength: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex'), dev: info.dev, ino: info.ino }; // narrowly re-anchor changed history\\n\"; }",
          "--test",
          "test -r {} && cd packages/operator-core && NODE_OPTIONS= NODE_PATH= ../../scripts/pc-heavy.sh node ../../node_modules/vitest/vitest.mjs run lib/source-preview-export.test.ts -t 'refuses complete-event truncation after restart|BG-TEARDOWN-RECONCILE keeps recursive inventory append-only'",
          "--expect",
          "caught",
          "--relocation",
          "overlay",
          "--fake-destructive"
        ],
        "runnerSha256": "f131184b934757f3923b06fcd75629044bd153eff3b24712c365a6823d509472",
        "result": {
          "baselineLedger": "test_runs:23003891",
          "mutantLedger": "test_runs:23004672",
          "expected": "caught",
          "mutantParse": "ok",
          "relocation": "overlay",
          "assertionEvidence": "vitest-failed-tests",
          "copyBaselineLedger": "test_runs:23003915",
          "baselineExit": 0,
          "target": "copy-out",
          "guardExit": 1,
          "verdict": "caught"
        },
        "cwd": "."
      }
    ],
    "contained": 2,
    "intact": 2,
    "terminal": "R4_PROBE_END={\"name\":\"independent-history-anchor\",\"exit\":0}"
  },
  "deadline": {
    "baseline": 23003356,
    "copyBaseline": 23003870,
    "mutant": 23003882,
    "positivePassesPerBaseline": 16,
    "negativeFailures": 15,
    "ordinaryPositivePasses": 1,
    "clockTrace": {
      "opened": 100,
      "deadlineEpochMs": 200,
      "immediatelyBefore": 199,
      "exactlyAt": 200,
      "after": 201,
      "beforeRowLateTerminal": 200
    },
    "outcomes": [
      "success",
      "failure",
      "cancellation",
      "timeout",
      "interruption-recovery"
    ],
    "predicted": "Narrow deadline validation bypass leaves deadlineExceeded false and wrongly permits timely success; exact timing assertion fails",
    "observed": "All 15 timing/outcome assertions fail with deadlineExceeded:false; independent ordinary recursive cleanup remains PASS"
  },
  "history": {
    "baseline": 23003891,
    "copyBaseline": 23003915,
    "mutant": 23004672,
    "positivePassesPerBaseline": 2,
    "negativeFailures": 1,
    "ordinaryPositivePasses": 1,
    "predicted": "Re-anchoring changed journal after restart accepts complete-event truncation; original expected-refusal assertion fails",
    "observed": "Exact complete-event truncation test fails expected function to throw; independent ordinary recursive cleanup remains PASS"
  },
  "rows": [
    {
      "id": "23003356",
      "file_path": "packages/operator-core/lib/source-preview-export.test.ts",
      "status": "pass",
      "commit_sha": "58952091fb2b0476b8b4c5e501e7d6a5a9d64afc",
      "worktree_dirty": false,
      "source": "mutation-probe",
      "harness_slug": "papercusp",
      "workspace_id": "papercusp-workspace",
      "execution_details": {
        "root": "/tmp/pcv/papercusp-lint-as-committed-58952091fb-qnEK0D",
        "failed": 0,
        "passed": 16,
        "skipped": 450,
        "filePath": "packages/operator-core/lib/source-preview-export.test.ts",
        "mutation": {
          "leg": "baseline",
          "mode": "copy-out",
          "mutantDiff": "--- a/packages/operator-core/lib/verifier-source.ts\n+++ b/packages/operator-core/lib/verifier-source.ts\n@@ -244,7 +244,7 @@\n         await discoverProcesses();\n         if (resources.size !== count) return inventory.reconcile({ outcome, custody });\n       }\n-      deadlineExceeded ||= now() >= header.deadlineEpochMs;\n+      deadlineExceeded ||= false; // narrowly bypass inherited teardown deadline\n       const terminal = { outcome, deadlineEpochMs: header.deadlineEpochMs, deadlineExceeded,\n         observations, survivors, sealed: survivors.length === 0,\n         status: survivors.length ? 'incomplete' : outcome === 'success' && !deadlineExceeded ? 'completed' : 'failed' };\n",
          "subjectPath": "packages/operator-core/lib/verifier-source.ts",
          "testCommand": "test -r {} && cd packages/operator-core && NODE_OPTIONS= NODE_PATH= ../../scripts/pc-heavy.sh node ../../node_modules/vitest/vitest.mjs run lib/source-preview-export.test.ts -t 'bg-r4-teardown-|BG-TEARDOWN-RECONCILE keeps recursive inventory append-only'",
          "againstCommit": null,
          "schemaVersion": 1,
          "testFileSha256": "ce77b8a4c0e4cf62f710c9f7e679215b83259693e568e6431ff62e070ce4f8f4",
          "mutateExpression": "if (index($_, \"deadlineExceeded ||= now() >= header.deadlineEpochMs;\") >= 0) { $_ = \"      deadlineExceeded ||= false; // narrowly bypass inherited teardown deadline\\n\"; }",
          "probeInvocationId": "ba3038b7-564e-498b-8efb-98f7c3bc1f6a",
          "testCommandSha256": "b0775d3d1790e6556184a982977cb6ab5c9255c2bed873470c63911f42443617",
          "subjectAfterSha256": "45aa53bb8bbb88fda3a6c4120d5646b85ef702f9357f6eee29200ecb22823e89",
          "mutantDiffTruncated": false,
          "subjectBeforeSha256": "338778b5d2820f32b9b714f97e835155593b17389a768aa42bd59924c3b5f904"
        },
        "commitSha": "58952091fb2b0476b8b4c5e501e7d6a5a9d64afc",
        "testLayer": "unit",
        "runGroupId": null,
        "harnessSlug": "papercusp",
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-11-02T15:43:32.482Z",
        "mutationPhase": "baseline",
        "schemaVersion": 1,
        "worktreeDirty": false,
        "testNamePattern": "bg-r4-teardown-|BG-TEARDOWN-RECONCILE keeps recursive inventory append-only",
        "collectionFailed": false,
        "passedCaseTitles": [
          "BG teardown resource inventory source controls > BG-TEARDOWN-RECONCILE keeps recursive inventory append-only through late-child reconciliation",
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
          "BG teardown resource inventory source controls > bg-r4-teardown-interruption-recovery-after reconciles late descendants on interruption-recovery at original teardown deadline after"
        ],
        "testTimingRuntimeIdentity": "node:25.9.0 linux/x64 vitest:4.1.8",
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      },
      "started_at": "2026-11-02T15:43:44.589Z",
      "finished_at": "2026-11-02T15:47:59.436Z"
    },
    {
      "id": "23003870",
      "file_path": "packages/operator-core/lib/source-preview-export.test.ts",
      "status": "pass",
      "commit_sha": "58952091fb2b0476b8b4c5e501e7d6a5a9d64afc",
      "worktree_dirty": false,
      "source": "mutation-probe",
      "harness_slug": "papercusp",
      "workspace_id": "papercusp-workspace",
      "execution_details": {
        "root": "/tmp/pcv/papercusp-lint-as-committed-58952091fb-qnEK0D",
        "failed": 0,
        "passed": 16,
        "skipped": 450,
        "filePath": "packages/operator-core/lib/source-preview-export.test.ts",
        "mutation": {
          "leg": "copy-baseline",
          "mode": "copy-out",
          "mutantDiff": "--- a/packages/operator-core/lib/verifier-source.ts\n+++ b/packages/operator-core/lib/verifier-source.ts\n@@ -244,7 +244,7 @@\n         await discoverProcesses();\n         if (resources.size !== count) return inventory.reconcile({ outcome, custody });\n       }\n-      deadlineExceeded ||= now() >= header.deadlineEpochMs;\n+      deadlineExceeded ||= false; // narrowly bypass inherited teardown deadline\n       const terminal = { outcome, deadlineEpochMs: header.deadlineEpochMs, deadlineExceeded,\n         observations, survivors, sealed: survivors.length === 0,\n         status: survivors.length ? 'incomplete' : outcome === 'success' && !deadlineExceeded ? 'completed' : 'failed' };\n",
          "subjectPath": "packages/operator-core/lib/verifier-source.ts",
          "testCommand": "test -r {} && cd packages/operator-core && NODE_OPTIONS= NODE_PATH= ../../scripts/pc-heavy.sh node ../../node_modules/vitest/vitest.mjs run lib/source-preview-export.test.ts -t 'bg-r4-teardown-|BG-TEARDOWN-RECONCILE keeps recursive inventory append-only'",
          "againstCommit": null,
          "schemaVersion": 1,
          "testFileSha256": "ce77b8a4c0e4cf62f710c9f7e679215b83259693e568e6431ff62e070ce4f8f4",
          "mutateExpression": "if (index($_, \"deadlineExceeded ||= now() >= header.deadlineEpochMs;\") >= 0) { $_ = \"      deadlineExceeded ||= false; // narrowly bypass inherited teardown deadline\\n\"; }",
          "probeInvocationId": "ba3038b7-564e-498b-8efb-98f7c3bc1f6a",
          "testCommandSha256": "b0775d3d1790e6556184a982977cb6ab5c9255c2bed873470c63911f42443617",
          "subjectAfterSha256": "45aa53bb8bbb88fda3a6c4120d5646b85ef702f9357f6eee29200ecb22823e89",
          "mutantDiffTruncated": false,
          "subjectBeforeSha256": "338778b5d2820f32b9b714f97e835155593b17389a768aa42bd59924c3b5f904"
        },
        "commitSha": "58952091fb2b0476b8b4c5e501e7d6a5a9d64afc",
        "testLayer": "unit",
        "runGroupId": null,
        "harnessSlug": "papercusp",
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-11-02T15:48:12.975Z",
        "mutationPhase": "copy-baseline",
        "schemaVersion": 1,
        "worktreeDirty": false,
        "testNamePattern": "bg-r4-teardown-|BG-TEARDOWN-RECONCILE keeps recursive inventory append-only",
        "collectionFailed": false,
        "passedCaseTitles": [
          "BG teardown resource inventory source controls > BG-TEARDOWN-RECONCILE keeps recursive inventory append-only through late-child reconciliation",
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
          "BG teardown resource inventory source controls > bg-r4-teardown-interruption-recovery-after reconciles late descendants on interruption-recovery at original teardown deadline after"
        ],
        "testTimingRuntimeIdentity": "node:25.9.0 linux/x64 vitest:4.1.8",
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      },
      "started_at": "2026-11-02T15:48:26.672Z",
      "finished_at": "2026-11-02T15:52:31.494Z"
    },
    {
      "id": "23003882",
      "file_path": "packages/operator-core/lib/source-preview-export.test.ts",
      "status": "fail",
      "commit_sha": "58952091fb2b0476b8b4c5e501e7d6a5a9d64afc",
      "worktree_dirty": false,
      "source": "mutation-probe",
      "harness_slug": "papercusp",
      "workspace_id": "papercusp-workspace",
      "execution_details": {
        "root": "/tmp/pcv/papercusp-lint-as-committed-58952091fb-qnEK0D",
        "failed": 15,
        "passed": 1,
        "skipped": 450,
        "filePath": "packages/operator-core/lib/source-preview-export.test.ts",
        "mutation": {
          "leg": "mutant",
          "mode": "copy-out",
          "mutantDiff": "--- a/packages/operator-core/lib/verifier-source.ts\n+++ b/packages/operator-core/lib/verifier-source.ts\n@@ -244,7 +244,7 @@\n         await discoverProcesses();\n         if (resources.size !== count) return inventory.reconcile({ outcome, custody });\n       }\n-      deadlineExceeded ||= now() >= header.deadlineEpochMs;\n+      deadlineExceeded ||= false; // narrowly bypass inherited teardown deadline\n       const terminal = { outcome, deadlineEpochMs: header.deadlineEpochMs, deadlineExceeded,\n         observations, survivors, sealed: survivors.length === 0,\n         status: survivors.length ? 'incomplete' : outcome === 'success' && !deadlineExceeded ? 'completed' : 'failed' };\n",
          "subjectPath": "packages/operator-core/lib/verifier-source.ts",
          "testCommand": "test -r {} && cd packages/operator-core && NODE_OPTIONS= NODE_PATH= ../../scripts/pc-heavy.sh node ../../node_modules/vitest/vitest.mjs run lib/source-preview-export.test.ts -t 'bg-r4-teardown-|BG-TEARDOWN-RECONCILE keeps recursive inventory append-only'",
          "againstCommit": null,
          "schemaVersion": 1,
          "testFileSha256": "ce77b8a4c0e4cf62f710c9f7e679215b83259693e568e6431ff62e070ce4f8f4",
          "mutateExpression": "if (index($_, \"deadlineExceeded ||= now() >= header.deadlineEpochMs;\") >= 0) { $_ = \"      deadlineExceeded ||= false; // narrowly bypass inherited teardown deadline\\n\"; }",
          "probeInvocationId": "ba3038b7-564e-498b-8efb-98f7c3bc1f6a",
          "testCommandSha256": "b0775d3d1790e6556184a982977cb6ab5c9255c2bed873470c63911f42443617",
          "subjectAfterSha256": "45aa53bb8bbb88fda3a6c4120d5646b85ef702f9357f6eee29200ecb22823e89",
          "mutantDiffTruncated": false,
          "subjectBeforeSha256": "338778b5d2820f32b9b714f97e835155593b17389a768aa42bd59924c3b5f904"
        },
        "commitSha": "58952091fb2b0476b8b4c5e501e7d6a5a9d64afc",
        "testLayer": "unit",
        "runGroupId": null,
        "harnessSlug": "papercusp",
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-11-02T15:52:48.031Z",
        "mutationPhase": "mutant",
        "schemaVersion": 1,
        "worktreeDirty": false,
        "testNamePattern": "bg-r4-teardown-|BG-TEARDOWN-RECONCILE keeps recursive inventory append-only",
        "collectionFailed": false,
        "failedCaseTitles": [
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
          "BG teardown resource inventory source controls > bg-r4-teardown-interruption-recovery-after reconciles late descendants on interruption-recovery at original teardown deadline after"
        ],
        "passedCaseTitles": [
          "BG teardown resource inventory source controls > BG-TEARDOWN-RECONCILE keeps recursive inventory append-only through late-child reconciliation"
        ],
        "testTimingRuntimeIdentity": "node:25.9.0 linux/x64 vitest:4.1.8",
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      },
      "started_at": "2026-11-02T15:53:01.808Z",
      "finished_at": "2026-11-02T15:54:47.264Z"
    },
    {
      "id": "23003891",
      "file_path": "packages/operator-core/lib/source-preview-export.test.ts",
      "status": "pass",
      "commit_sha": "58952091fb2b0476b8b4c5e501e7d6a5a9d64afc",
      "worktree_dirty": false,
      "source": "mutation-probe",
      "harness_slug": "papercusp",
      "workspace_id": "papercusp-workspace",
      "execution_details": {
        "root": "/tmp/pcv/papercusp-lint-as-committed-58952091fb-qnEK0D",
        "failed": 0,
        "passed": 2,
        "skipped": 464,
        "filePath": "packages/operator-core/lib/source-preview-export.test.ts",
        "mutation": {
          "leg": "baseline",
          "mode": "copy-out",
          "mutantDiff": "--- a/packages/operator-core/lib/verifier-source.ts\n+++ b/packages/operator-core/lib/verifier-source.ts\n@@ -89,9 +89,10 @@\n     assert.ok(info.isFile() && !info.isSymbolicLink(), 'inventory is not a regular receipt');\n     bytes = readFileSync(options.path, 'utf8');\n     assert.ok(bytes.endsWith('\\n'), 'inventory has an incomplete append; retain for recovery');\n-    const anchor = options.expectedHistory;\n+    let anchor = options.expectedHistory;\n     assert.ok(anchor && Number.isSafeInteger(anchor.byteLength) && anchor.byteLength > 0,\n       'inventory recovery needs independently retained history anchor');\n+    anchor = { byteLength: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex'), dev: info.dev, ino: info.ino }; // narrowly re-anchor changed history\n     assert.ok(info.dev === anchor.dev && info.ino === anchor.ino && Buffer.byteLength(bytes) >= anchor.byteLength,\n       'inventory recovery history anchor changed');\n     assert.equal(createHash('sha256').update(Buffer.from(bytes).subarray(0, anchor.byteLength)).digest('hex'),\n",
          "subjectPath": "packages/operator-core/lib/verifier-source.ts",
          "testCommand": "test -r {} && cd packages/operator-core && NODE_OPTIONS= NODE_PATH= ../../scripts/pc-heavy.sh node ../../node_modules/vitest/vitest.mjs run lib/source-preview-export.test.ts -t 'refuses complete-event truncation after restart|BG-TEARDOWN-RECONCILE keeps recursive inventory append-only'",
          "againstCommit": null,
          "schemaVersion": 1,
          "testFileSha256": "ce77b8a4c0e4cf62f710c9f7e679215b83259693e568e6431ff62e070ce4f8f4",
          "mutateExpression": "if (index($_, \"const anchor = options.expectedHistory;\") >= 0) { s/const anchor/let anchor/; } if (index($_, \"inventory recovery needs independently retained history anchor\") >= 0) { $_ .= \"    anchor = { byteLength: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex'), dev: info.dev, ino: info.ino }; // narrowly re-anchor changed history\\n\"; }",
          "probeInvocationId": "573b2bd4-9523-4ada-bada-919a7e343d8b",
          "testCommandSha256": "f55c7d6205c2bba5966ed7f371c800c162d797552fd2fad99c4c2ac7a51d81de",
          "subjectAfterSha256": "b7377f0a99e8a6f59e400049c24bf56a5a96b8b7d6c646f533b6501f9b51eee4",
          "mutantDiffTruncated": false,
          "subjectBeforeSha256": "338778b5d2820f32b9b714f97e835155593b17389a768aa42bd59924c3b5f904"
        },
        "commitSha": "58952091fb2b0476b8b4c5e501e7d6a5a9d64afc",
        "testLayer": "unit",
        "runGroupId": null,
        "harnessSlug": "papercusp",
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-11-02T15:55:18.349Z",
        "mutationPhase": "baseline",
        "schemaVersion": 1,
        "worktreeDirty": false,
        "testNamePattern": "refuses complete-event truncation after restart|BG-TEARDOWN-RECONCILE keeps recursive inventory append-only",
        "collectionFailed": false,
        "passedCaseTitles": [
          "BG teardown resource inventory source controls > BG-TEARDOWN-RECONCILE keeps recursive inventory append-only through late-child reconciliation",
          "BG teardown resource inventory source controls > refuses complete-event truncation after restart against independently retained history"
        ],
        "testTimingRuntimeIdentity": "node:25.9.0 linux/x64 vitest:4.1.8",
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      },
      "started_at": "2026-11-02T15:55:28.450Z",
      "finished_at": "2026-11-02T15:55:51.553Z"
    },
    {
      "id": "23003915",
      "file_path": "packages/operator-core/lib/source-preview-export.test.ts",
      "status": "pass",
      "commit_sha": "58952091fb2b0476b8b4c5e501e7d6a5a9d64afc",
      "worktree_dirty": false,
      "source": "mutation-probe",
      "harness_slug": "papercusp",
      "workspace_id": "papercusp-workspace",
      "execution_details": {
        "root": "/tmp/pcv/papercusp-lint-as-committed-58952091fb-qnEK0D",
        "failed": 0,
        "passed": 2,
        "skipped": 464,
        "filePath": "packages/operator-core/lib/source-preview-export.test.ts",
        "mutation": {
          "leg": "copy-baseline",
          "mode": "copy-out",
          "mutantDiff": "--- a/packages/operator-core/lib/verifier-source.ts\n+++ b/packages/operator-core/lib/verifier-source.ts\n@@ -89,9 +89,10 @@\n     assert.ok(info.isFile() && !info.isSymbolicLink(), 'inventory is not a regular receipt');\n     bytes = readFileSync(options.path, 'utf8');\n     assert.ok(bytes.endsWith('\\n'), 'inventory has an incomplete append; retain for recovery');\n-    const anchor = options.expectedHistory;\n+    let anchor = options.expectedHistory;\n     assert.ok(anchor && Number.isSafeInteger(anchor.byteLength) && anchor.byteLength > 0,\n       'inventory recovery needs independently retained history anchor');\n+    anchor = { byteLength: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex'), dev: info.dev, ino: info.ino }; // narrowly re-anchor changed history\n     assert.ok(info.dev === anchor.dev && info.ino === anchor.ino && Buffer.byteLength(bytes) >= anchor.byteLength,\n       'inventory recovery history anchor changed');\n     assert.equal(createHash('sha256').update(Buffer.from(bytes).subarray(0, anchor.byteLength)).digest('hex'),\n",
          "subjectPath": "packages/operator-core/lib/verifier-source.ts",
          "testCommand": "test -r {} && cd packages/operator-core && NODE_OPTIONS= NODE_PATH= ../../scripts/pc-heavy.sh node ../../node_modules/vitest/vitest.mjs run lib/source-preview-export.test.ts -t 'refuses complete-event truncation after restart|BG-TEARDOWN-RECONCILE keeps recursive inventory append-only'",
          "againstCommit": null,
          "schemaVersion": 1,
          "testFileSha256": "ce77b8a4c0e4cf62f710c9f7e679215b83259693e568e6431ff62e070ce4f8f4",
          "mutateExpression": "if (index($_, \"const anchor = options.expectedHistory;\") >= 0) { s/const anchor/let anchor/; } if (index($_, \"inventory recovery needs independently retained history anchor\") >= 0) { $_ .= \"    anchor = { byteLength: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex'), dev: info.dev, ino: info.ino }; // narrowly re-anchor changed history\\n\"; }",
          "probeInvocationId": "573b2bd4-9523-4ada-bada-919a7e343d8b",
          "testCommandSha256": "f55c7d6205c2bba5966ed7f371c800c162d797552fd2fad99c4c2ac7a51d81de",
          "subjectAfterSha256": "b7377f0a99e8a6f59e400049c24bf56a5a96b8b7d6c646f533b6501f9b51eee4",
          "mutantDiffTruncated": false,
          "subjectBeforeSha256": "338778b5d2820f32b9b714f97e835155593b17389a768aa42bd59924c3b5f904"
        },
        "commitSha": "58952091fb2b0476b8b4c5e501e7d6a5a9d64afc",
        "testLayer": "unit",
        "runGroupId": null,
        "harnessSlug": "papercusp",
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-11-02T15:56:34.916Z",
        "mutationPhase": "copy-baseline",
        "schemaVersion": 1,
        "worktreeDirty": false,
        "testNamePattern": "refuses complete-event truncation after restart|BG-TEARDOWN-RECONCILE keeps recursive inventory append-only",
        "collectionFailed": false,
        "passedCaseTitles": [
          "BG teardown resource inventory source controls > BG-TEARDOWN-RECONCILE keeps recursive inventory append-only through late-child reconciliation",
          "BG teardown resource inventory source controls > refuses complete-event truncation after restart against independently retained history"
        ],
        "testTimingRuntimeIdentity": "node:25.9.0 linux/x64 vitest:4.1.8",
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      },
      "started_at": "2026-11-02T15:56:48.538Z",
      "finished_at": "2026-11-02T15:57:11.737Z"
    },
    {
      "id": "23004672",
      "file_path": "packages/operator-core/lib/source-preview-export.test.ts",
      "status": "fail",
      "commit_sha": "58952091fb2b0476b8b4c5e501e7d6a5a9d64afc",
      "worktree_dirty": false,
      "source": "mutation-probe",
      "harness_slug": "papercusp",
      "workspace_id": "papercusp-workspace",
      "execution_details": {
        "root": "/tmp/pcv/papercusp-lint-as-committed-58952091fb-qnEK0D",
        "failed": 1,
        "passed": 1,
        "skipped": 464,
        "filePath": "packages/operator-core/lib/source-preview-export.test.ts",
        "mutation": {
          "leg": "mutant",
          "mode": "copy-out",
          "mutantDiff": "--- a/packages/operator-core/lib/verifier-source.ts\n+++ b/packages/operator-core/lib/verifier-source.ts\n@@ -89,9 +89,10 @@\n     assert.ok(info.isFile() && !info.isSymbolicLink(), 'inventory is not a regular receipt');\n     bytes = readFileSync(options.path, 'utf8');\n     assert.ok(bytes.endsWith('\\n'), 'inventory has an incomplete append; retain for recovery');\n-    const anchor = options.expectedHistory;\n+    let anchor = options.expectedHistory;\n     assert.ok(anchor && Number.isSafeInteger(anchor.byteLength) && anchor.byteLength > 0,\n       'inventory recovery needs independently retained history anchor');\n+    anchor = { byteLength: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex'), dev: info.dev, ino: info.ino }; // narrowly re-anchor changed history\n     assert.ok(info.dev === anchor.dev && info.ino === anchor.ino && Buffer.byteLength(bytes) >= anchor.byteLength,\n       'inventory recovery history anchor changed');\n     assert.equal(createHash('sha256').update(Buffer.from(bytes).subarray(0, anchor.byteLength)).digest('hex'),\n",
          "subjectPath": "packages/operator-core/lib/verifier-source.ts",
          "testCommand": "test -r {} && cd packages/operator-core && NODE_OPTIONS= NODE_PATH= ../../scripts/pc-heavy.sh node ../../node_modules/vitest/vitest.mjs run lib/source-preview-export.test.ts -t 'refuses complete-event truncation after restart|BG-TEARDOWN-RECONCILE keeps recursive inventory append-only'",
          "againstCommit": null,
          "schemaVersion": 1,
          "testFileSha256": "ce77b8a4c0e4cf62f710c9f7e679215b83259693e568e6431ff62e070ce4f8f4",
          "mutateExpression": "if (index($_, \"const anchor = options.expectedHistory;\") >= 0) { s/const anchor/let anchor/; } if (index($_, \"inventory recovery needs independently retained history anchor\") >= 0) { $_ .= \"    anchor = { byteLength: Buffer.byteLength(bytes), sha256: createHash('sha256').update(bytes).digest('hex'), dev: info.dev, ino: info.ino }; // narrowly re-anchor changed history\\n\"; }",
          "probeInvocationId": "573b2bd4-9523-4ada-bada-919a7e343d8b",
          "testCommandSha256": "f55c7d6205c2bba5966ed7f371c800c162d797552fd2fad99c4c2ac7a51d81de",
          "subjectAfterSha256": "b7377f0a99e8a6f59e400049c24bf56a5a96b8b7d6c646f533b6501f9b51eee4",
          "mutantDiffTruncated": false,
          "subjectBeforeSha256": "338778b5d2820f32b9b714f97e835155593b17389a768aa42bd59924c3b5f904"
        },
        "commitSha": "58952091fb2b0476b8b4c5e501e7d6a5a9d64afc",
        "testLayer": "unit",
        "runGroupId": null,
        "harnessSlug": "papercusp",
        "workspaceId": "papercusp-workspace",
        "runStartedAt": "2026-11-02T15:57:17.638Z",
        "mutationPhase": "mutant",
        "schemaVersion": 1,
        "worktreeDirty": false,
        "testNamePattern": "refuses complete-event truncation after restart|BG-TEARDOWN-RECONCILE keeps recursive inventory append-only",
        "collectionFailed": false,
        "failedCaseTitles": [
          "BG teardown resource inventory source controls > refuses complete-event truncation after restart against independently retained history"
        ],
        "passedCaseTitles": [
          "BG teardown resource inventory source controls > BG-TEARDOWN-RECONCILE keeps recursive inventory append-only through late-child reconciliation"
        ],
        "testTimingRuntimeIdentity": "node:25.9.0 linux/x64 vitest:4.1.8",
        "runtimeEnvironmentAfterCaptureStatus": "not-configured",
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
      },
      "started_at": "2026-11-02T15:57:32.709Z",
      "finished_at": "2026-11-02T15:57:58.188Z"
    }
  ],
  "cases": [
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-cancellation-after reconciles late descendants on cancellation at original teardown deadline after",
      "case_index": 30,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 9734,
      "test_run_id": 23003356
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-cancellation-exactly-at reconciles late descendants on cancellation at original teardown deadline exactly-at",
      "case_index": 29,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 9348,
      "test_run_id": 23003356
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-cancellation-immediately-before reconciles late descendants on cancellation at original teardown deadline immediately-before",
      "case_index": 28,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 11846,
      "test_run_id": 23003356
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-failure-after reconciles late descendants on failure at original teardown deadline after",
      "case_index": 27,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 10745,
      "test_run_id": 23003356
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-failure-exactly-at reconciles late descendants on failure at original teardown deadline exactly-at",
      "case_index": 26,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 20484,
      "test_run_id": 23003356
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-failure-immediately-before reconciles late descendants on failure at original teardown deadline immediately-before",
      "case_index": 25,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 18276,
      "test_run_id": 23003356
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-interruption-recovery-after reconciles late descendants on interruption-recovery at original teardown deadline after",
      "case_index": 36,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 15944,
      "test_run_id": 23003356
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-interruption-recovery-exactly-at reconciles late descendants on interruption-recovery at original teardown deadline exactly-at",
      "case_index": 35,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 21124,
      "test_run_id": 23003356
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-interruption-recovery-immediately-before reconciles late descendants on interruption-recovery at original teardown deadline immediately-before",
      "case_index": 34,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 10242,
      "test_run_id": 23003356
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-success-after reconciles late descendants on success at original teardown deadline after",
      "case_index": 24,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 23011,
      "test_run_id": 23003356
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-success-exactly-at reconciles late descendants on success at original teardown deadline exactly-at",
      "case_index": 23,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 17837,
      "test_run_id": 23003356
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-success-immediately-before reconciles late descendants on success at original teardown deadline immediately-before",
      "case_index": 22,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 21045,
      "test_run_id": 23003356
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-timeout-after reconciles late descendants on timeout at original teardown deadline after",
      "case_index": 33,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 10651,
      "test_run_id": 23003356
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-timeout-exactly-at reconciles late descendants on timeout at original teardown deadline exactly-at",
      "case_index": 32,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 14879,
      "test_run_id": 23003356
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-timeout-immediately-before reconciles late descendants on timeout at original teardown deadline immediately-before",
      "case_index": 31,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 18622,
      "test_run_id": 23003356
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > BG-TEARDOWN-RECONCILE keeps recursive inventory append-only through late-child reconciliation",
      "case_index": 0,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 19870,
      "test_run_id": 23003356
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-cancellation-after reconciles late descendants on cancellation at original teardown deadline after",
      "case_index": 30,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 10954,
      "test_run_id": 23003870
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-cancellation-exactly-at reconciles late descendants on cancellation at original teardown deadline exactly-at",
      "case_index": 29,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 8032,
      "test_run_id": 23003870
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-cancellation-immediately-before reconciles late descendants on cancellation at original teardown deadline immediately-before",
      "case_index": 28,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 10999,
      "test_run_id": 23003870
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-failure-after reconciles late descendants on failure at original teardown deadline after",
      "case_index": 27,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 9572,
      "test_run_id": 23003870
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-failure-exactly-at reconciles late descendants on failure at original teardown deadline exactly-at",
      "case_index": 26,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 12242,
      "test_run_id": 23003870
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-failure-immediately-before reconciles late descendants on failure at original teardown deadline immediately-before",
      "case_index": 25,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 17654,
      "test_run_id": 23003870
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-interruption-recovery-after reconciles late descendants on interruption-recovery at original teardown deadline after",
      "case_index": 36,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 18288,
      "test_run_id": 23003870
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-interruption-recovery-exactly-at reconciles late descendants on interruption-recovery at original teardown deadline exactly-at",
      "case_index": 35,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 39467,
      "test_run_id": 23003870
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-interruption-recovery-immediately-before reconciles late descendants on interruption-recovery at original teardown deadline immediately-before",
      "case_index": 34,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 28839,
      "test_run_id": 23003870
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-success-after reconciles late descendants on success at original teardown deadline after",
      "case_index": 24,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 12863,
      "test_run_id": 23003870
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-success-exactly-at reconciles late descendants on success at original teardown deadline exactly-at",
      "case_index": 23,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 11136,
      "test_run_id": 23003870
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-success-immediately-before reconciles late descendants on success at original teardown deadline immediately-before",
      "case_index": 22,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 8494,
      "test_run_id": 23003870
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-timeout-after reconciles late descendants on timeout at original teardown deadline after",
      "case_index": 33,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 17499,
      "test_run_id": 23003870
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-timeout-exactly-at reconciles late descendants on timeout at original teardown deadline exactly-at",
      "case_index": 32,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 16800,
      "test_run_id": 23003870
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-timeout-immediately-before reconciles late descendants on timeout at original teardown deadline immediately-before",
      "case_index": 31,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 9615,
      "test_run_id": 23003870
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > BG-TEARDOWN-RECONCILE keeps recursive inventory append-only through late-child reconciliation",
      "case_index": 0,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 10358,
      "test_run_id": 23003870
    },
    {
      "status": "fail",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-cancellation-after reconciles late descendants on cancellation at original teardown deadline after",
      "case_index": 30,
      "error_tail": "expected { outcome: 'cancellation', …(6) } to match object { sealed: false, …(2) }\n(4 matching properties omitted from actual)\nactual: {\n  \"deadlineExceeded\": false,\n  \"sealed\": false,\n  \"survivors\": [\n    \"late-output\",\n    \"helper\",\n    \"process:3535221:linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:5386893\",\n  ],\n}\nexpected: {\n  \"deadlineExceeded\": true,\n  \"sealed\": false,\n  \"survivors\": [\n    \"late-output\",\n    \"helper\",\n    \"process:3535221:linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:5386893\",\n  ],\n}",
      "occurrence": 1,
      "duration_ms": 2611,
      "test_run_id": 23003882
    },
    {
      "status": "fail",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-cancellation-exactly-at reconciles late descendants on cancellation at original teardown deadline exactly-at",
      "case_index": 29,
      "error_tail": "expected { outcome: 'cancellation', …(6) } to match object { sealed: false, …(2) }\n(4 matching properties omitted from actual)\nactual: {\n  \"deadlineExceeded\": false,\n  \"sealed\": false,\n  \"survivors\": [\n    \"late-output\",\n    \"helper\",\n    \"process:3533220:linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:5386587\",\n  ],\n}\nexpected: {\n  \"deadlineExceeded\": true,\n  \"sealed\": false,\n  \"survivors\": [\n    \"late-output\",\n    \"helper\",\n    \"process:3533220:linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:5386587\",\n  ],\n}",
      "occurrence": 1,
      "duration_ms": 2995,
      "test_run_id": 23003882
    },
    {
      "status": "fail",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-cancellation-immediately-before reconciles late descendants on cancellation at original teardown deadline immediately-before",
      "case_index": 28,
      "error_tail": "expected { outcome: 'cancellation', …(6) } to match object { outcome: 'cancellation', …(4) }\n(2 matching properties omitted from actual)\nactual: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": false,\n  \"outcome\": \"cancellation\",\n  \"sealed\": true,\n  \"status\": \"failed\",\n}\nexpected: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": true,\n  \"outcome\": \"cancellation\",\n  \"sealed\": true,\n  \"status\": \"failed\",\n}",
      "occurrence": 1,
      "duration_ms": 6899,
      "test_run_id": 23003882
    },
    {
      "status": "fail",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-failure-after reconciles late descendants on failure at original teardown deadline after",
      "case_index": 27,
      "error_tail": "expected { outcome: 'failure', …(6) } to match object { sealed: false, …(2) }\n(4 matching properties omitted from actual)\nactual: {\n  \"deadlineExceeded\": false,\n  \"sealed\": false,\n  \"survivors\": [\n    \"late-output\",\n    \"helper\",\n    \"process:3527089:linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:5385549\",\n  ],\n}\nexpected: {\n  \"deadlineExceeded\": true,\n  \"sealed\": false,\n  \"survivors\": [\n    \"late-output\",\n    \"helper\",\n    \"process:3527089:linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:5385549\",\n  ],\n}",
      "occurrence": 1,
      "duration_ms": 3475,
      "test_run_id": 23003882
    },
    {
      "status": "fail",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-failure-exactly-at reconciles late descendants on failure at original teardown deadline exactly-at",
      "case_index": 26,
      "error_tail": "expected { outcome: 'failure', …(6) } to match object { sealed: false, …(2) }\n(4 matching properties omitted from actual)\nactual: {\n  \"deadlineExceeded\": false,\n  \"sealed\": false,\n  \"survivors\": [\n    \"late-output\",\n    \"helper\",\n    \"process:3525610:linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:5385310\",\n  ],\n}\nexpected: {\n  \"deadlineExceeded\": true,\n  \"sealed\": false,\n  \"survivors\": [\n    \"late-output\",\n    \"helper\",\n    \"process:3525610:linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:5385310\",\n  ],\n}",
      "occurrence": 1,
      "duration_ms": 2387,
      "test_run_id": 23003882
    },
    {
      "status": "fail",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-failure-immediately-before reconciles late descendants on failure at original teardown deadline immediately-before",
      "case_index": 25,
      "error_tail": "expected { outcome: 'failure', …(6) } to match object { outcome: 'failure', …(4) }\n(2 matching properties omitted from actual)\nactual: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": false,\n  \"outcome\": \"failure\",\n  \"sealed\": true,\n  \"status\": \"failed\",\n}\nexpected: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": true,\n  \"outcome\": \"failure\",\n  \"sealed\": true,\n  \"status\": \"failed\",\n}",
      "occurrence": 1,
      "duration_ms": 9410,
      "test_run_id": 23003882
    },
    {
      "status": "fail",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-interruption-recovery-after reconciles late descendants on interruption-recovery at original teardown deadline after",
      "case_index": 36,
      "error_tail": "expected { …(7) } to match object { sealed: false, …(2) }\n(4 matching properties omitted from actual)\nactual: {\n  \"deadlineExceeded\": false,\n  \"sealed\": false,\n  \"survivors\": [\n    \"late-output\",\n    \"helper\",\n    \"process:3575095:linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:5392011\",\n  ],\n}\nexpected: {\n  \"deadlineExceeded\": true,\n  \"sealed\": false,\n  \"survivors\": [\n    \"late-output\",\n    \"helper\",\n    \"process:3575095:linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:5392011\",\n  ],\n}",
      "occurrence": 1,
      "duration_ms": 3757,
      "test_run_id": 23003882
    },
    {
      "status": "fail",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-interruption-recovery-exactly-at reconciles late descendants on interruption-recovery at original teardown deadline exactly-at",
      "case_index": 35,
      "error_tail": "expected { …(7) } to match object { sealed: false, …(2) }\n(4 matching properties omitted from actual)\nactual: {\n  \"deadlineExceeded\": false,\n  \"sealed\": false,\n  \"survivors\": [\n    \"late-output\",\n    \"helper\",\n    \"process:3570848:linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:5391359\",\n  ],\n}\nexpected: {\n  \"deadlineExceeded\": true,\n  \"sealed\": false,\n  \"survivors\": [\n    \"late-output\",\n    \"helper\",\n    \"process:3570848:linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:5391359\",\n  ],\n}",
      "occurrence": 1,
      "duration_ms": 6522,
      "test_run_id": 23003882
    },
    {
      "status": "fail",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-interruption-recovery-immediately-before reconciles late descendants on interruption-recovery at original teardown deadline immediately-before",
      "case_index": 34,
      "error_tail": "expected { …(7) } to match object { …(5) }\n(2 matching properties omitted from actual)\nactual: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": false,\n  \"outcome\": \"interruption-recovery\",\n  \"sealed\": true,\n  \"status\": \"failed\",\n}\nexpected: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": true,\n  \"outcome\": \"interruption-recovery\",\n  \"sealed\": true,\n  \"status\": \"failed\",\n}",
      "occurrence": 1,
      "duration_ms": 26400,
      "test_run_id": 23003882
    },
    {
      "status": "fail",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-success-after reconciles late descendants on success at original teardown deadline after",
      "case_index": 24,
      "error_tail": "expected { outcome: 'success', …(6) } to match object { sealed: false, …(2) }\n(4 matching properties omitted from actual)\nactual: {\n  \"deadlineExceeded\": false,\n  \"sealed\": false,\n  \"survivors\": [\n    \"late-output\",\n    \"helper\",\n    \"process:3517451:linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:5383975\",\n  ],\n}\nexpected: {\n  \"deadlineExceeded\": true,\n  \"sealed\": false,\n  \"survivors\": [\n    \"late-output\",\n    \"helper\",\n    \"process:3517451:linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:5383975\",\n  ],\n}",
      "occurrence": 1,
      "duration_ms": 3959,
      "test_run_id": 23003882
    },
    {
      "status": "fail",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-success-exactly-at reconciles late descendants on success at original teardown deadline exactly-at",
      "case_index": 23,
      "error_tail": "expected { outcome: 'success', …(6) } to match object { sealed: false, …(2) }\n(4 matching properties omitted from actual)\nactual: {\n  \"deadlineExceeded\": false,\n  \"sealed\": false,\n  \"survivors\": [\n    \"late-output\",\n    \"helper\",\n    \"process:3516584:linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:5383709\",\n  ],\n}\nexpected: {\n  \"deadlineExceeded\": true,\n  \"sealed\": false,\n  \"survivors\": [\n    \"late-output\",\n    \"helper\",\n    \"process:3516584:linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:5383709\",\n  ],\n}",
      "occurrence": 1,
      "duration_ms": 2652,
      "test_run_id": 23003882
    },
    {
      "status": "fail",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-success-immediately-before reconciles late descendants on success at original teardown deadline immediately-before",
      "case_index": 22,
      "error_tail": "expected { outcome: 'success', …(6) } to match object { outcome: 'success', …(4) }\n(2 matching properties omitted from actual)\nactual: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": false,\n  \"outcome\": \"success\",\n  \"sealed\": true,\n  \"status\": \"completed\",\n}\nexpected: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": true,\n  \"outcome\": \"success\",\n  \"sealed\": true,\n  \"status\": \"failed\",\n}",
      "occurrence": 1,
      "duration_ms": 7701,
      "test_run_id": 23003882
    },
    {
      "status": "fail",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-timeout-after reconciles late descendants on timeout at original teardown deadline after",
      "case_index": 33,
      "error_tail": "expected { outcome: 'timeout', …(6) } to match object { sealed: false, …(2) }\n(4 matching properties omitted from actual)\nactual: {\n  \"deadlineExceeded\": false,\n  \"sealed\": false,\n  \"survivors\": [\n    \"late-output\",\n    \"helper\",\n    \"process:3542046:linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:5388305\",\n  ],\n}\nexpected: {\n  \"deadlineExceeded\": true,\n  \"sealed\": false,\n  \"survivors\": [\n    \"late-output\",\n    \"helper\",\n    \"process:3542046:linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:5388305\",\n  ],\n}",
      "occurrence": 1,
      "duration_ms": 4165,
      "test_run_id": 23003882
    },
    {
      "status": "fail",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-timeout-exactly-at reconciles late descendants on timeout at original teardown deadline exactly-at",
      "case_index": 32,
      "error_tail": "expected { outcome: 'timeout', …(6) } to match object { sealed: false, …(2) }\n(4 matching properties omitted from actual)\nactual: {\n  \"deadlineExceeded\": false,\n  \"sealed\": false,\n  \"survivors\": [\n    \"late-output\",\n    \"helper\",\n    \"process:3541141:linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:5388045\",\n  ],\n}\nexpected: {\n  \"deadlineExceeded\": true,\n  \"sealed\": false,\n  \"survivors\": [\n    \"late-output\",\n    \"helper\",\n    \"process:3541141:linux:c58f787e-e441-4c5c-a0f5-40e3b362e124:5388045\",\n  ],\n}",
      "occurrence": 1,
      "duration_ms": 2564,
      "test_run_id": 23003882
    },
    {
      "status": "fail",
      "case_key": "BG teardown resource inventory source controls > bg-r4-teardown-timeout-immediately-before reconciles late descendants on timeout at original teardown deadline immediately-before",
      "case_index": 31,
      "error_tail": "expected { outcome: 'timeout', …(6) } to match object { outcome: 'timeout', …(4) }\n(2 matching properties omitted from actual)\nactual: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": false,\n  \"outcome\": \"timeout\",\n  \"sealed\": true,\n  \"status\": \"failed\",\n}\nexpected: {\n  \"deadlineEpochMs\": 200,\n  \"deadlineExceeded\": true,\n  \"outcome\": \"timeout\",\n  \"sealed\": true,\n  \"status\": \"failed\",\n}",
      "occurrence": 1,
      "duration_ms": 8980,
      "test_run_id": 23003882
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > BG-TEARDOWN-RECONCILE keeps recursive inventory append-only through late-child reconciliation",
      "case_index": 0,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 7791,
      "test_run_id": 23003882
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > BG-TEARDOWN-RECONCILE keeps recursive inventory append-only through late-child reconciliation",
      "case_index": 0,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 21836,
      "test_run_id": 23003891
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > refuses complete-event truncation after restart against independently retained history",
      "case_index": 39,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 7,
      "test_run_id": 23003891
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > BG-TEARDOWN-RECONCILE keeps recursive inventory append-only through late-child reconciliation",
      "case_index": 0,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 20521,
      "test_run_id": 23003915
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > refuses complete-event truncation after restart against independently retained history",
      "case_index": 39,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 7,
      "test_run_id": 23003915
    },
    {
      "status": "pass",
      "case_key": "BG teardown resource inventory source controls > BG-TEARDOWN-RECONCILE keeps recursive inventory append-only through late-child reconciliation",
      "case_index": 0,
      "error_tail": null,
      "occurrence": 1,
      "duration_ms": 23173,
      "test_run_id": 23004672
    },
    {
      "status": "fail",
      "case_key": "BG teardown resource inventory source controls > refuses complete-event truncation after restart against independently retained history",
      "case_index": 39,
      "error_tail": "expected [Function] to throw an error\nactual: undefined\nexpected: null",
      "occurrence": 1,
      "duration_ms": 10,
      "test_run_id": 23004672
    }
  ],
  "remaining": "Full R4 42 selectors, operational terminal inventory, P002 restart/rollback then P003 independent verification and original parent custody unresolved. Original parent UNKNOWN prohibits actual BG preparation/activation. Luna NOT SHIPPED."
}

