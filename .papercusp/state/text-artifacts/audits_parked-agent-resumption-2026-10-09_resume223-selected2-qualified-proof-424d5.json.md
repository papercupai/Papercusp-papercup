---
rel_path: "audits/parked-agent-resumption-2026-10-09/resume223-selected2-qualified-proof-424d5.json"
updated_at: 1792749665687
_body: "content"
---

{
  "schemaVersion": 1,
  "observedAt": "2026-10-23T09:59:10.353Z",
  "sourceCommit": "12e9c9723675b7bcd76181c5ba7986a642c948c7",
  "testRunId": "21811825",
  "ledgerReceipt": {
    "receiptId": "044b57b8-d7cc-4a25-b0b2-1e032650e999",
    "attempt": 0,
    "filePath": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
    "status": "pass",
    "row": {
      "filePath": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
      "status": "pass",
      "durationMs": 337915,
      "startedAt": "2026-10-23T09:27:59.714Z",
      "finishedAt": "2026-10-23T09:33:37.629Z",
      "outputTail": null,
      "isScratchConfig": false,
      "executionDetails": {
        "schemaVersion": 1,
        "runStartedAt": "2026-10-23T09:27:32.263Z",
        "root": "/mnt/data/tmp/verifier-command-N5MC5Q/invoked-source",
        "runGroupId": "parked-resume221-r15-r16-private-pg-424d5",
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "testNamePattern": "activates agents-stranded at the configured threshold independently of wedged|preserves the active agents-stranded alarm when its census leg is unobservable",
        "testLayer": "e2e",
        "mutationPhase": null,
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured",
        "filePath": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
        "passed": 2,
        "failed": 0,
        "skipped": 7,
        "collectionFailed": false,
        "passedCaseTitles": [
          "activates agents-stranded at the configured threshold independently of wedged",
          "preserves the active agents-stranded alarm when its census leg is unobservable"
        ],
        "isolatedRuntimeReceipts": [
          {
            "runId": "20261023T092814Z-1899007",
            "resultSha256": "8e83e252221907e39ae6ffc4da1f14126d535ff0569b55e1dadef981b42d47b1",
            "sourceSha256": "3777fad7be024b152ff5a8b52e84ff9ca999a13b59a9111f032d709b13ed99fe",
            "lifecycleSha256": "e150f66ba4eb56e33831d9e8a03e305098ef1c219cbaa0b8a6580dde469141e6"
          }
        ],
        "worktreeDirty": false,
        "commitSha": "12e9c9723675b7bcd76181c5ba7986a642c948c7",
        "runtimeEnvironmentAfterCaptureStatus": "not-configured"
      },
      "verifierSourceReason": null,
      "cases": [
        {
          "caseIndex": 0,
          "caseKey": "activates agents-stranded at the configured threshold independently of wedged",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 337907,
          "errorTail": null
        },
        {
          "caseIndex": 1,
          "caseKey": "preserves the active agents-stranded alarm when its census leg is unobservable",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 0,
          "errorTail": null
        },
        {
          "caseIndex": 2,
          "caseKey": "keeps a request-worker wedged alarm standing across restart and resolves only a measured recovery",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseIndex": 3,
          "caseKey": "keeps one accountable hosted reliability alarm across restart and unknown evidence, then resolves witnessed recovery",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseIndex": 4,
          "caseKey": "delivers one connector-loss alarm and resolves reconnection across restart and unknown evidence",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseIndex": 5,
          "caseKey": "delivers one Papercusp-owned spend alarm and resolves a measured budget recovery",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseIndex": 6,
          "caseKey": "publishes measured wedged class counts and stranded totals on the coordination panel",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseIndex": 7,
          "caseKey": "keeps coordination population severity at WARN without a duplicate generic panel page",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseIndex": 8,
          "caseKey": "pages once per population episode and permits a new page after documented recovery and flap suppression",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        }
      ],
      "worktreeDirty": false,
      "commitSha": "12e9c9723675b7bcd76181c5ba7986a642c948c7",
      "receiptId": "044b57b8-d7cc-4a25-b0b2-1e032650e999",
      "receiptAttempt": 0
    },
    "outcome": "inserted",
    "id": "21811825"
  },
  "retained": "/mnt/data/offload/verification-harness/isolated-integration/retained/20261023T092814Z-1899007",
  "receipts": [
    {
      "path": "/mnt/data/offload/verification-harness/isolated-integration/retained/20261023T092814Z-1899007/result.json",
      "expected": "8e83e252221907e39ae6ffc4da1f14126d535ff0569b55e1dadef981b42d47b1",
      "actual": "8e83e252221907e39ae6ffc4da1f14126d535ff0569b55e1dadef981b42d47b1",
      "matches": true
    },
    {
      "path": "/mnt/data/offload/verification-harness/isolated-integration/retained/20261023T092814Z-1899007/phases/prepare/source.json",
      "expected": "3777fad7be024b152ff5a8b52e84ff9ca999a13b59a9111f032d709b13ed99fe",
      "actual": "3777fad7be024b152ff5a8b52e84ff9ca999a13b59a9111f032d709b13ed99fe",
      "matches": true
    },
    {
      "path": "/mnt/data/offload/verification-harness/isolated-integration/retained/20261023T092814Z-1899007/phases/execute/lifecycle.json",
      "expected": "e150f66ba4eb56e33831d9e8a03e305098ef1c219cbaa0b8a6580dde469141e6",
      "actual": "e150f66ba4eb56e33831d9e8a03e305098ef1c219cbaa0b8a6580dde469141e6",
      "matches": true
    }
  ],
  "result": {
    "schemaVersion": 1,
    "harness": "isolated-integration",
    "runId": "20261023T092814Z-1899007",
    "evidenceDir": "/mnt/data/offload/verification-harness/isolated-integration/20261023T092814Z-1899007",
    "selection": {
      "only": null,
      "from": null
    },
    "reuseFromRunId": null,
    "preflight": null,
    "phases": [
      {
        "phase": "prepare",
        "evidenceDir": "/mnt/data/offload/verification-harness/isolated-integration/20261023T092814Z-1899007/phases/prepare",
        "startedAt": "2026-10-23T09:28:14.834Z",
        "endedAt": "2026-10-23T09:28:33.135Z",
        "elapsedMs": 18301,
        "status": "passed",
        "step": null,
        "reasonCode": null
      },
      {
        "phase": "execute",
        "evidenceDir": "/mnt/data/offload/verification-harness/isolated-integration/20261023T092814Z-1899007/phases/execute",
        "startedAt": "2026-10-23T09:28:33.138Z",
        "endedAt": "2026-10-23T09:33:37.556Z",
        "elapsedMs": 304418,
        "status": "passed",
        "step": null,
        "reasonCode": null
      },
      {
        "phase": "teardown",
        "evidenceDir": "/mnt/data/offload/verification-harness/isolated-integration/20261023T092814Z-1899007/phases/teardown",
        "startedAt": "2026-10-23T09:33:37.559Z",
        "endedAt": "2026-10-23T09:33:37.560Z",
        "elapsedMs": 1,
        "status": "passed",
        "step": null,
        "reasonCode": null
      }
    ],
    "verdict": "pass",
    "firstFailure": null,
    "startedAt": "2026-10-23T09:28:14.824Z",
    "endedAt": "2026-10-23T09:33:37.561Z"
  },
  "lifecycle": {
    "schemaVersion": 1,
    "runId": "20261023T092814Z-1899007",
    "host": "main-server-Precision-7865-Tower",
    "observedAt": "2026-10-23T09:29:09.425Z",
    "observer": {
      "pid": 1899007,
      "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:153664926",
      "parentPid": 1877818
    },
    "supervisor": {
      "pid": 1935749,
      "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:153668663",
      "parentPid": 1899007
    },
    "worker": {
      "pid": 1967746,
      "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:153672282",
      "parentPid": 1935749
    },
    "database": {
      "pid": 1939307,
      "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:153669116",
      "parentPid": 1935749
    },
    "argv": [
      "/home/marsh-office/.local/node25/bin/node",
      "--import",
      "/mnt/data/tmp/verifier-command-N5MC5Q/invoked-source/scripts/lib/isolated-runtime-start.mjs",
      "--import",
      "tsx",
      "/mnt/data/tmp/verifier-command-N5MC5Q/invoked-source/packages/operator-core/test/liveness-alarm-http-fixture.ts"
    ],
    "cwd": "/mnt/data/tmp/verifier-command-N5MC5Q/invoked-source",
    "workspace": "test-runtime-8cbc5c1a-173",
    "runtimeRoot": "/tmp/pcv/papercusp-test-runtime-Wtcc6Q",
    "dataDir": "/tmp/pcv/papercusp-test-pg-0QoI7T",
    "pgPort": 39287,
    "ended": {
      "kind": "isolated-runtime-end",
      "childPid": 1967746,
      "exitCode": 0,
      "signal": null,
      "runtimeRemoved": true,
      "pgDataRemoved": true,
      "observedAt": "2026-10-23T09:33:37.311Z"
    }
  },
  "footprint": [
    {
      "path": "apps/operator/bin/bundle-host.sh",
      "sha256": "b4875de3cb0908026c2e20d646084df414ec572a0bad7e8c7a60bf79254780c9",
      "gitSha256": "b4875de3cb0908026c2e20d646084df414ec572a0bad7e8c7a60bf79254780c9",
      "outerManifestSha256": "b4875de3cb0908026c2e20d646084df414ec572a0bad7e8c7a60bf79254780c9",
      "committed": "b4875de3cb0908026c2e20d646084df414ec572a0bad7e8c7a60bf79254780c9",
      "current": "b4875de3cb0908026c2e20d646084df414ec572a0bad7e8c7a60bf79254780c9",
      "originalMatches": true,
      "currentMatches": true
    },
    {
      "path": "apps/operator/bin/hono-host.ts",
      "sha256": "738e1f2bdb9cb1d521c51813e58cd9d89ab64885f01f39ab98a14ae18de5efff",
      "gitSha256": "738e1f2bdb9cb1d521c51813e58cd9d89ab64885f01f39ab98a14ae18de5efff",
      "outerManifestSha256": "738e1f2bdb9cb1d521c51813e58cd9d89ab64885f01f39ab98a14ae18de5efff",
      "committed": "738e1f2bdb9cb1d521c51813e58cd9d89ab64885f01f39ab98a14ae18de5efff",
      "current": "738e1f2bdb9cb1d521c51813e58cd9d89ab64885f01f39ab98a14ae18de5efff",
      "originalMatches": true,
      "currentMatches": true
    },
    {
      "path": "packages/operator-core/lib/agent-tools/coordination/escalations.ts",
      "sha256": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52",
      "gitSha256": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52",
      "outerManifestSha256": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52",
      "committed": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52",
      "current": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52",
      "originalMatches": true,
      "currentMatches": true
    },
    {
      "path": "packages/operator-core/lib/attention-notify-store.ts",
      "sha256": "f225420758db7ef5a955596aad005d8a99e3a75eae95d85d3a03f460bab6c9c0",
      "gitSha256": "f225420758db7ef5a955596aad005d8a99e3a75eae95d85d3a03f460bab6c9c0",
      "outerManifestSha256": "f225420758db7ef5a955596aad005d8a99e3a75eae95d85d3a03f460bab6c9c0",
      "committed": "f225420758db7ef5a955596aad005d8a99e3a75eae95d85d3a03f460bab6c9c0",
      "current": "f225420758db7ef5a955596aad005d8a99e3a75eae95d85d3a03f460bab6c9c0",
      "originalMatches": true,
      "currentMatches": true
    },
    {
      "path": "packages/operator-core/lib/attention-notify.ts",
      "sha256": "0e746061fc5a1c5b8c991a2d56070333693f8ecba0ef91e43ea1105d9fce7091",
      "gitSha256": "0e746061fc5a1c5b8c991a2d56070333693f8ecba0ef91e43ea1105d9fce7091",
      "outerManifestSha256": "0e746061fc5a1c5b8c991a2d56070333693f8ecba0ef91e43ea1105d9fce7091",
      "committed": "0e746061fc5a1c5b8c991a2d56070333693f8ecba0ef91e43ea1105d9fce7091",
      "current": "0e746061fc5a1c5b8c991a2d56070333693f8ecba0ef91e43ea1105d9fce7091",
      "originalMatches": true,
      "currentMatches": true
    },
    {
      "path": "packages/operator-core/lib/build-info.ts",
      "sha256": "ea31b635aa4d7c7b0b7ceb056ff3e0428cd0bf49bd519a263668bc394bc6a13f",
      "gitSha256": "ea31b635aa4d7c7b0b7ceb056ff3e0428cd0bf49bd519a263668bc394bc6a13f",
      "outerManifestSha256": "ea31b635aa4d7c7b0b7ceb056ff3e0428cd0bf49bd519a263668bc394bc6a13f",
      "committed": "ea31b635aa4d7c7b0b7ceb056ff3e0428cd0bf49bd519a263668bc394bc6a13f",
      "current": "ea31b635aa4d7c7b0b7ceb056ff3e0428cd0bf49bd519a263668bc394bc6a13f",
      "originalMatches": true,
      "currentMatches": true
    },
    {
      "path": "packages/operator-core/lib/derived-reads/shared-snapshot.ts",
      "sha256": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826",
      "gitSha256": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826",
      "outerManifestSha256": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826",
      "committed": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826",
      "current": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826",
      "originalMatches": true,
      "currentMatches": true
    },
    {
      "path": "packages/operator-core/lib/operator-state-pg.ts",
      "sha256": "4bf2bd4cef6ab2600b68fda640e3e79ca7b8ec625d7f4d0c6fd710f7e81f750b",
      "gitSha256": "4bf2bd4cef6ab2600b68fda640e3e79ca7b8ec625d7f4d0c6fd710f7e81f750b",
      "outerManifestSha256": "4bf2bd4cef6ab2600b68fda640e3e79ca7b8ec625d7f4d0c6fd710f7e81f750b",
      "committed": "4bf2bd4cef6ab2600b68fda640e3e79ca7b8ec625d7f4d0c6fd710f7e81f750b",
      "current": "4bf2bd4cef6ab2600b68fda640e3e79ca7b8ec625d7f4d0c6fd710f7e81f750b",
      "originalMatches": true,
      "currentMatches": true
    },
    {
      "path": "packages/operator-core/lib/severe-event-owner.ts",
      "sha256": "2c59fb583ed0e16abffb543fcf00f2099d2b524786dc456dac78f79648e5cbb2",
      "gitSha256": "2c59fb583ed0e16abffb543fcf00f2099d2b524786dc456dac78f79648e5cbb2",
      "outerManifestSha256": "2c59fb583ed0e16abffb543fcf00f2099d2b524786dc456dac78f79648e5cbb2",
      "committed": "2c59fb583ed0e16abffb543fcf00f2099d2b524786dc456dac78f79648e5cbb2",
      "current": "2c59fb583ed0e16abffb543fcf00f2099d2b524786dc456dac78f79648e5cbb2",
      "originalMatches": true,
      "currentMatches": true
    },
    {
      "path": "packages/operator-core/lib/system-health/agent-strand-census.ts",
      "sha256": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284",
      "gitSha256": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284",
      "outerManifestSha256": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284",
      "committed": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284",
      "current": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284",
      "originalMatches": true,
      "currentMatches": true
    },
    {
      "path": "packages/operator-core/lib/system-health/compute.ts",
      "sha256": "92a8075abee46b5b9ba9e8bf8140e2f6077f16228f96319c381ddc394061a862",
      "gitSha256": "92a8075abee46b5b9ba9e8bf8140e2f6077f16228f96319c381ddc394061a862",
      "outerManifestSha256": "92a8075abee46b5b9ba9e8bf8140e2f6077f16228f96319c381ddc394061a862",
      "committed": "92a8075abee46b5b9ba9e8bf8140e2f6077f16228f96319c381ddc394061a862",
      "current": "92a8075abee46b5b9ba9e8bf8140e2f6077f16228f96319c381ddc394061a862",
      "originalMatches": true,
      "currentMatches": true
    },
    {
      "path": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
      "sha256": "033fdb0a3c1336752b005507b992268819d6cf256e5941e9a6bce32c3ee27302",
      "gitSha256": "033fdb0a3c1336752b005507b992268819d6cf256e5941e9a6bce32c3ee27302",
      "outerManifestSha256": "033fdb0a3c1336752b005507b992268819d6cf256e5941e9a6bce32c3ee27302",
      "committed": "033fdb0a3c1336752b005507b992268819d6cf256e5941e9a6bce32c3ee27302",
      "current": "033fdb0a3c1336752b005507b992268819d6cf256e5941e9a6bce32c3ee27302",
      "originalMatches": true,
      "currentMatches": true
    },
    {
      "path": "packages/operator-core/lib/system-health/liveness-alarm.ts",
      "sha256": "9941ccb7143b39250a4decc4ef5df0d1ff0ed60b67959f017aab61483a276e54",
      "gitSha256": "9941ccb7143b39250a4decc4ef5df0d1ff0ed60b67959f017aab61483a276e54",
      "outerManifestSha256": "9941ccb7143b39250a4decc4ef5df0d1ff0ed60b67959f017aab61483a276e54",
      "committed": "9941ccb7143b39250a4decc4ef5df0d1ff0ed60b67959f017aab61483a276e54",
      "current": "9941ccb7143b39250a4decc4ef5df0d1ff0ed60b67959f017aab61483a276e54",
      "originalMatches": true,
      "currentMatches": true
    },
    {
      "path": "packages/operator-core/lib/system-health/thresholds.ts",
      "sha256": "ffe939989e28a5a1564670b7899503d9226e2b66785beee0a3e2480271a83616",
      "gitSha256": "ffe939989e28a5a1564670b7899503d9226e2b66785beee0a3e2480271a83616",
      "outerManifestSha256": "ffe939989e28a5a1564670b7899503d9226e2b66785beee0a3e2480271a83616",
      "committed": "ffe939989e28a5a1564670b7899503d9226e2b66785beee0a3e2480271a83616",
      "current": "ffe939989e28a5a1564670b7899503d9226e2b66785beee0a3e2480271a83616",
      "originalMatches": true,
      "currentMatches": true
    },
    {
      "path": "packages/operator-core/lib/workspace-host/observability-store.ts",
      "sha256": "cd6b35d891eccfbdef60d1b1b15afb887b80ec51c031c7984371569e32cfe777",
      "gitSha256": "cd6b35d891eccfbdef60d1b1b15afb887b80ec51c031c7984371569e32cfe777",
      "outerManifestSha256": "cd6b35d891eccfbdef60d1b1b15afb887b80ec51c031c7984371569e32cfe777",
      "committed": "cd6b35d891eccfbdef60d1b1b15afb887b80ec51c031c7984371569e32cfe777",
      "current": "cd6b35d891eccfbdef60d1b1b15afb887b80ec51c031c7984371569e32cfe777",
      "originalMatches": true,
      "currentMatches": true
    },
    {
      "path": "packages/operator-core/test/isolated-integration-proof.ts",
      "sha256": "fae5be50947bbd41f38acbe2b85bdd0fef8d7ab8a1e19cdc0b6fde453ce860c6",
      "gitSha256": "fae5be50947bbd41f38acbe2b85bdd0fef8d7ab8a1e19cdc0b6fde453ce860c6",
      "outerManifestSha256": "fae5be50947bbd41f38acbe2b85bdd0fef8d7ab8a1e19cdc0b6fde453ce860c6",
      "committed": "fae5be50947bbd41f38acbe2b85bdd0fef8d7ab8a1e19cdc0b6fde453ce860c6",
      "current": "fae5be50947bbd41f38acbe2b85bdd0fef8d7ab8a1e19cdc0b6fde453ce860c6",
      "originalMatches": true,
      "currentMatches": true
    },
    {
      "path": "packages/operator-core/test/liveness-alarm-http-fixture.ts",
      "sha256": "b7c5fbb5740a12b71fe252beeb5da55c9c154207fe99154d84d9f5366aa7ce72",
      "gitSha256": "b7c5fbb5740a12b71fe252beeb5da55c9c154207fe99154d84d9f5366aa7ce72",
      "outerManifestSha256": "b7c5fbb5740a12b71fe252beeb5da55c9c154207fe99154d84d9f5366aa7ce72",
      "committed": "b7c5fbb5740a12b71fe252beeb5da55c9c154207fe99154d84d9f5366aa7ce72",
      "current": "b7c5fbb5740a12b71fe252beeb5da55c9c154207fe99154d84d9f5366aa7ce72",
      "originalMatches": true,
      "currentMatches": true
    },
    {
      "path": "packages/operator-core/test/private-http-workspace-preflight.ts",
      "sha256": "7d741c02c2409bb9cfb730b923031bab5e6d24bb7dc9791b66ae2a8e935a4149",
      "gitSha256": "7d741c02c2409bb9cfb730b923031bab5e6d24bb7dc9791b66ae2a8e935a4149",
      "outerManifestSha256": "7d741c02c2409bb9cfb730b923031bab5e6d24bb7dc9791b66ae2a8e935a4149",
      "committed": "7d741c02c2409bb9cfb730b923031bab5e6d24bb7dc9791b66ae2a8e935a4149",
      "current": "7d741c02c2409bb9cfb730b923031bab5e6d24bb7dc9791b66ae2a8e935a4149",
      "originalMatches": true,
      "currentMatches": true
    },
    {
      "path": "scripts/lib/isolated-runtime-start.mjs",
      "sha256": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
      "gitSha256": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
      "outerManifestSha256": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
      "committed": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
      "current": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
      "originalMatches": true,
      "currentMatches": true
    },
    {
      "path": "scripts/with-test-pg.mjs",
      "sha256": "97e9c296d89947617c7b3617d830d9670f4413ea8c915d00ef3a4c847457746c",
      "gitSha256": "97e9c296d89947617c7b3617d830d9670f4413ea8c915d00ef3a4c847457746c",
      "outerManifestSha256": "97e9c296d89947617c7b3617d830d9670f4413ea8c915d00ef3a4c847457746c",
      "committed": "97e9c296d89947617c7b3617d830d9670f4413ea8c915d00ef3a4c847457746c",
      "current": "97e9c296d89947617c7b3617d830d9670f4413ea8c915d00ef3a4c847457746c",
      "originalMatches": true,
      "currentMatches": true
    },
    {
      "path": "scripts/lib/with-test-pg-cleanup.mjs",
      "sha256": "92e9bc6ce77ddc75fe84c3788001214e7687a10c96b5469564a4862f019c2eae",
      "gitSha256": "92e9bc6ce77ddc75fe84c3788001214e7687a10c96b5469564a4862f019c2eae",
      "outerManifestSha256": "92e9bc6ce77ddc75fe84c3788001214e7687a10c96b5469564a4862f019c2eae",
      "committed": "92e9bc6ce77ddc75fe84c3788001214e7687a10c96b5469564a4862f019c2eae",
      "current": "92e9bc6ce77ddc75fe84c3788001214e7687a10c96b5469564a4862f019c2eae",
      "originalMatches": true,
      "currentMatches": true
    }
  ],
  "processChecks": [
    {
      "role": "worker",
      "pid": 1967746,
      "original": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:153672282",
      "current": {
        "unavailable": "ENOENT"
      }
    },
    {
      "role": "database",
      "pid": 1939307,
      "original": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:153669116",
      "current": {
        "unavailable": "ENOENT"
      }
    },
    {
      "role": "supervisor",
      "pid": 1935749,
      "original": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:153668663",
      "current": {
        "unavailable": "ENOENT"
      }
    },
    {
      "role": "observer",
      "pid": 1899007,
      "original": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:153664926",
      "current": {
        "unavailable": "ENOENT"
      }
    }
  ],
  "cleanup": {
    "runtimeAbsent": true,
    "pgDataAbsent": true,
    "ownedRootAbsent": true,
    "taskReceipt": "completed",
    "cgroupAbsent": true,
    "cgroupProcs": null
  },
  "dependencies": {
    "beforeSha256": "a669bbb8a8237e7163d4c16803f991e7d7cbb9a7b46b8dbdee6516e752131951",
    "afterSha256": "a669bbb8a8237e7163d4c16803f991e7d7cbb9a7b46b8dbdee6516e752131951",
    "byteIdentical": true,
    "sourceReceiptCanonicalSha256": "acf4e2e6a7cbdec5f6bb3efa5c3632ed1c4d39d7e895c750800e0c94120ab003",
    "sourceReceiptCanonicalMatches": true,
    "sourceCommitMatches": true,
    "policy": {
      "path": "apps/operator/bin/release/dependency-generation.sh",
      "sha256": "e1705a45018674f2857f6cd6992f822205dced5c1714ded6732801bc5ab7716b"
    },
    "trees": [
      {
        "path": "apps/operator-docs/node_modules",
        "records": 0
      },
      {
        "path": "apps/operator-public/node_modules",
        "records": 1
      },
      {
        "path": "apps/operator-vite/node_modules",
        "records": 97
      },
      {
        "path": "apps/operator/node_modules",
        "records": 1018
      },
      {
        "path": "apps/papercusp-docs/node_modules",
        "records": 0
      },
      {
        "path": "apps/papercusp-publish/node_modules",
        "records": 0
      },
      {
        "path": "apps/slack-asana-bug-drill/node_modules",
        "records": 368
      },
      {
        "path": "apps/slack-asana-bug-drill/template-kit/node_modules",
        "records": 115
      },
      {
        "path": "libs/agent-chat/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/activity-bridge/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/artifact-registry/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/audio-dsp/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/bench-metrics/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/cache/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/chat-cards/node_modules",
        "records": 3762
      },
      {
        "path": "libs/generic/chat-protocol/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/control-mutation/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/debounce-coalesce/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/dependency-order/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/deployment-driver/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/desktop-ipc/node_modules",
        "records": 11
      },
      {
        "path": "libs/generic/dock-workbench/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/embedded-pg-discovery/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/eval-battery/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/event-reaction/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/facets/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/failure-detector/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/fanout-resolver/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/git-graph/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/gui-readiness/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/image-blankness/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/ipc-endpoint-server/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/ipc-framing/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/kokoro-tts/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/lexicon/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/linkable-edges/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/locks-core/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/memory/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/model-pricing/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/module-singleton/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/overlap-clusters/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/p2p-voice/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/papergrid/bloom-grid/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/papergrid/grid-core/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/papergrid/kv-persist-indexeddb/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/papergrid/kv-persist/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/plan-parser/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/plugin-loader/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/pot-app-seam/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/projection-index/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/prospect-contract/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/pubsub-substrate/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/ranked-selection/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/rate-limit/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/release-profile/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/rerank/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/resource-profile/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/result-encoding/node_modules",
        "records": 1019
      },
      {
        "path": "libs/generic/resumable-download/node_modules",
        "records": 279
      },
      {
        "path": "libs/generic/rrf/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/rules/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/scheduled-registry/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/search-core/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/search/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/seed-bundle/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/sequence-patterns/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/step-program/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/structured-concurrency/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/tauri-release-kit/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/tauri-verify/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/template-kit/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/tooldef-http/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/tooldef/node_modules",
        "records": 0
      },
      {
        "path": "libs/generic/ui-primitives/node_modules",
        "records": 0
      },
      {
        "path": "libs/host-platform/node_modules",
        "records": 0
      },
      {
        "path": "libs/papercusp-publish-auth/node_modules",
        "records": 0
      },
      {
        "path": "libs/papercusp-shared/node_modules",
        "records": 0
      },
      {
        "path": "libs/papercusp/node_modules",
        "records": 0
      },
      {
        "path": "libs/papercusp/packages/embedded-postgres-server/node_modules",
        "records": 1117
      },
      {
        "path": "libs/papercusp/packages/locks/node_modules",
        "records": 0
      },
      {
        "path": "libs/test-config/node_modules",
        "records": 0
      },
      {
        "path": "libs/testing-shell/node_modules",
        "records": 0
      },
      {
        "path": "node_modules",
        "records": 390091
      },
      {
        "path": "packages/agent-mcp/node_modules",
        "records": 0
      },
      {
        "path": "packages/backup/node_modules",
        "records": 0
      },
      {
        "path": "packages/coordination/node_modules",
        "records": 0
      },
      {
        "path": "packages/docs-engine/node_modules",
        "records": 0
      },
      {
        "path": "packages/omp-plugin/node_modules",
        "records": 10
      },
      {
        "path": "packages/operator-core/node_modules",
        "records": 1396
      },
      {
        "path": "packages/operator-ui/node_modules",
        "records": 3762
      },
      {
        "path": "packages/plugin-sdk/node_modules",
        "records": 0
      },
      {
        "path": "packages/plugin-wit/node_modules",
        "records": 0
      },
      {
        "path": "packages/tooldef-mcp/node_modules",
        "records": 0
      },
      {
        "path": "papercusp-desktop/node_modules",
        "records": 19
      },
      {
        "path": "templates/papercusp-iphone-shell/checks/node_modules",
        "records": 0
      },
      {
        "path": "templates/papercusp-iphone-shell/node_modules",
        "records": 0
      },
      {
        "path": "templates/papercusp-ops-pots/node_modules",
        "records": 0
      },
      {
        "path": "tools/perf-test/wdio/node_modules",
        "records": 13975
      }
    ]
  },
  "outerSourceSha256": "ef6e6129956da6cde489fc3c5732722b006cc03b895d40ed3d2590c292074b9c",
  "phaseRows": [
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 1,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "source.admission",
      "event": "started",
      "elapsedMs": 0
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 2,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "source.admission",
      "event": "completed",
      "elapsedMs": 1,
      "durationMs": 1,
      "budget": {
        "deadlineEpochMs": 1792751637840,
        "remainingMs": 5257317,
        "knownEstimateMs": 5249023,
        "cleanupReserveMs": 860729,
        "childCutoffEpochMs": 1792750777111,
        "estimate": {
          "preparationMs": 1212869,
          "sourceCheckMs": 28624,
          "dependencyCheckMs": 201372,
          "cleanupMs": 860729,
          "childEstimateMs": 1867000,
          "unknownChild": false,
          "remainingMs": 3732937,
          "totalMs": 5249023,
          "observedLaunchMs": null,
          "launchReserveMs": 30000,
          "requiredTimeoutMs": 5280000
        }
      }
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 3,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "source.freeze",
      "event": "started",
      "elapsedMs": 1
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 4,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "source.freeze",
      "event": "completed",
      "elapsedMs": 63648,
      "durationMs": 63645
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 5,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "receipt.write",
      "event": "started",
      "elapsedMs": 63650
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 6,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "receipt.write",
      "event": "completed",
      "elapsedMs": 63927,
      "durationMs": 278
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 7,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "deps.source.before",
      "event": "started",
      "elapsedMs": 63928
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 8,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "deps.source.before",
      "event": "completed",
      "elapsedMs": 91591,
      "durationMs": 27662
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 9,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "deps.snapshot",
      "event": "started",
      "elapsedMs": 91601
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 10,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "deps.snapshot",
      "event": "completed",
      "elapsedMs": 907710,
      "durationMs": 816107
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 11,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "deps.source.after-snapshot",
      "event": "started",
      "elapsedMs": 907718
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 12,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "deps.source.after-snapshot",
      "event": "completed",
      "elapsedMs": 944864,
      "durationMs": 37144
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 13,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "deps.inputs",
      "event": "started",
      "elapsedMs": 944880
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 14,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "deps.inputs",
      "event": "completed",
      "elapsedMs": 949714,
      "durationMs": 4834
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 15,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "deps.measure",
      "event": "started",
      "elapsedMs": 949714
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 16,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "deps.measure",
      "event": "completed",
      "elapsedMs": 956633,
      "durationMs": 6919
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 17,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "deps.source.after-preflight",
      "event": "started",
      "elapsedMs": 956634
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 18,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "deps.source.after-preflight",
      "event": "completed",
      "elapsedMs": 983458,
      "durationMs": 26824
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 19,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "deps.census",
      "event": "started",
      "elapsedMs": 983463
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 20,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "deps.census",
      "event": "completed",
      "elapsedMs": 1189803,
      "durationMs": 206340
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 21,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "deps.receipt.write",
      "event": "started",
      "elapsedMs": 1189806
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 22,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "deps.receipt.write",
      "event": "completed",
      "elapsedMs": 1197102,
      "durationMs": 7296
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 23,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "child.admission",
      "event": "started",
      "elapsedMs": 1198357
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 24,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "child.admission",
      "event": "completed",
      "elapsedMs": 1198357,
      "durationMs": 0,
      "budget": {
        "deadlineEpochMs": 1792751637840,
        "remainingMs": 4058962,
        "knownEstimateMs": 3704718,
        "cleanupReserveMs": 816116,
        "childCutoffEpochMs": 1792750821724,
        "estimate": {
          "preparationMs": 1197081,
          "sourceCheckMs": 37158,
          "dependencyCheckMs": 206342,
          "cleanupMs": 816116,
          "childEstimateMs": 1867000,
          "unknownChild": false,
          "remainingMs": 3704718,
          "totalMs": 5201069,
          "observedLaunchMs": null,
          "launchReserveMs": 30000,
          "requiredTimeoutMs": 5232000
        }
      }
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 25,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "child.preflight",
      "event": "started",
      "elapsedMs": 1198357
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 26,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "child.preflight",
      "event": "completed",
      "elapsedMs": 1233594,
      "durationMs": 35237
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 27,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "child.run",
      "event": "started",
      "elapsedMs": 1233595
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 28,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "child.run",
      "event": "completed",
      "elapsedMs": 1696190,
      "durationMs": 462594,
      "exitCode": 0,
      "diagnosticsPath": "/tmp/pcv/parked-resume221-budgeted-eFvYNP/verifier-source.json.child.json"
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 29,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "deps.postverify",
      "event": "started",
      "elapsedMs": 1696193
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 30,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "deps.postverify",
      "event": "completed",
      "elapsedMs": 1970332,
      "durationMs": 274139
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 31,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "source.postverify",
      "event": "started",
      "elapsedMs": 1970333
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 32,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "source.postverify",
      "event": "completed",
      "elapsedMs": 2003081,
      "durationMs": 32747
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 33,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "cleanup",
      "event": "started",
      "elapsedMs": 2003082
    },
    {
      "schemaVersion": "verifier-phase-v1",
      "sequence": 34,
      "taskId": "0mvkqw6rx1uzftwe14u",
      "phase": "cleanup",
      "event": "completed",
      "elapsedMs": 2041883,
      "durationMs": 38797
    }
  ]
}
