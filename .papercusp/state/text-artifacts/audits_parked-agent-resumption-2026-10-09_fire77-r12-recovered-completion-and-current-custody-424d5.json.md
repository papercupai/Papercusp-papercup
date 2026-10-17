---
rel_path: "audits/parked-agent-resumption-2026-10-09/fire77-r12-recovered-completion-and-current-custody-424d5.json"
updated_at: 1792121027818
_body: "content"
---

{
  "schemaVersion": 1,
  "edition": "Fire77",
  "measuredAt": "2026-10-16T03:23:46.249202+00:00",
  "ownerId": "su-424d5476-0b13-401a-a926-0aaa9f212391",
  "workItem": "WI-6554700010008887",
  "taskId": "0mvad5fnds9kjv8nwq1",
  "logPath": ".papercusp/scratch/bash-167b2811-500.log",
  "logSha256": "3a74dda5dd0742e163b272d76419abb9e52bfd188e52501ae5f3ed7bb34e9091",
  "terminal": [
    "R12_WRAPPER_TERMINAL {\"head\":\"9926609424b1bf34268a708a20334aed39156e28\",\"childStatus\":0,\"childSignal\":null,\"error\":null}",
    "[capability:bash] JOB END: status=completed exit=0 at 2026-10-16T03:08:53.154Z — this line was recorded by the transient-service runner; its file-backed sink survives loss of the operator host and is authoritative for durable output.",
    "[capability:bash] JOB END: status=completed exit=0 at 2026-10-16T03:08:53.221Z — this line marks the job reaching an OBSERVED terminal state; if it is ABSENT, no terminal marker has been durably recorded yet: the job may still be running, or it may have died before its close handler wrote JOB END. Check capability:bash_output/task ledger; recovery writes JOB DIED after a ledger-confirmed unobserved death."
  ],
  "reporter": {
    "receiptId": "47830a86-6a1e-4307-82e8-1dbda04776e4",
    "attempt": 0,
    "filePath": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
    "status": "pass",
    "row": {
      "filePath": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
      "status": "pass",
      "durationMs": 250898,
      "startedAt": "2026-10-16T02:56:06.099Z",
      "finishedAt": "2026-10-16T03:00:16.997Z",
      "outputTail": null,
      "isScratchConfig": false,
      "executionDetails": {
        "schemaVersion": 1,
        "runStartedAt": "2026-10-16T02:55:59.401Z",
        "root": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/verifier-command-ULHNXg/invoked-source",
        "runGroupId": null,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "testNamePattern": "keeps a request-worker wedged alarm standing across restart and resolves only a measured recovery",
        "testLayer": "e2e",
        "mutationPhase": null,
        "runtimeEnvironmentBeforeCaptureStatus": "not-configured",
        "filePath": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
        "passed": 1,
        "failed": 0,
        "skipped": 3,
        "collectionFailed": false,
        "passedCaseTitles": [
          "keeps a request-worker wedged alarm standing across restart and resolves only a measured recovery"
        ],
        "isolatedRuntimeReceipts": [
          {
            "runId": "20261016T025613Z-2182451",
            "resultSha256": "8dbd3b4def02240f5efef3854e5a77101929cb32a433885ce9baf7d44f4dd2f8",
            "sourceSha256": "77387365cc30813e9f00d623e6a86fd3815906dbb4711156399ba8b9f3e26f73",
            "lifecycleSha256": "45c235f2d8d521d58ad1b7d63669f59b55c8b6ae7c3986fa4d0184b66db30d80"
          }
        ],
        "worktreeDirty": false,
        "commitSha": "9926609424b1bf34268a708a20334aed39156e28",
        "runtimeEnvironmentAfterCaptureStatus": "not-configured"
      },
      "verifierSourceReason": null,
      "cases": [
        {
          "caseIndex": 0,
          "caseKey": "keeps a request-worker wedged alarm standing across restart and resolves only a measured recovery",
          "occurrence": 1,
          "status": "pass",
          "durationMs": 250890,
          "errorTail": null
        },
        {
          "caseIndex": 1,
          "caseKey": "keeps one accountable hosted reliability alarm across restart and unknown evidence, then resolves witnessed recovery",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseIndex": 2,
          "caseKey": "delivers one connector-loss alarm and resolves reconnection across restart and unknown evidence",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        },
        {
          "caseIndex": 3,
          "caseKey": "delivers one Papercusp-owned spend alarm and resolves a measured budget recovery",
          "occurrence": 1,
          "status": "skip",
          "durationMs": null,
          "errorTail": null
        }
      ],
      "worktreeDirty": false,
      "commitSha": "9926609424b1bf34268a708a20334aed39156e28",
      "receiptId": "47830a86-6a1e-4307-82e8-1dbda04776e4",
      "receiptAttempt": 0
    },
    "outcome": "inserted",
    "id": "21268585"
  },
  "ledger": {
    "id": "21268585",
    "file_path": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
    "status": "pass",
    "execution_details": {
      "root": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/verifier-command-ULHNXg/invoked-source",
      "failed": 0,
      "passed": 1,
      "skipped": 3,
      "filePath": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
      "commitSha": "9926609424b1bf34268a708a20334aed39156e28",
      "testLayer": "e2e",
      "runGroupId": null,
      "harnessSlug": "papercusp",
      "workspaceId": "papercusp-workspace",
      "runStartedAt": "2026-10-16T02:55:59.401Z",
      "mutationPhase": null,
      "schemaVersion": 1,
      "worktreeDirty": false,
      "testNamePattern": "keeps a request-worker wedged alarm standing across restart and resolves only a measured recovery",
      "collectionFailed": false,
      "passedCaseTitles": [
        "keeps a request-worker wedged alarm standing across restart and resolves only a measured recovery"
      ],
      "isolatedRuntimeReceipts": [
        {
          "runId": "20261016T025613Z-2182451",
          "resultSha256": "8dbd3b4def02240f5efef3854e5a77101929cb32a433885ce9baf7d44f4dd2f8",
          "sourceSha256": "77387365cc30813e9f00d623e6a86fd3815906dbb4711156399ba8b9f3e26f73",
          "lifecycleSha256": "45c235f2d8d521d58ad1b7d63669f59b55c8b6ae7c3986fa4d0184b66db30d80"
        }
      ],
      "runtimeEnvironmentAfterCaptureStatus": "not-configured",
      "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
    },
    "commit_sha": "9926609424b1bf34268a708a20334aed39156e28",
    "worktree_dirty": false
  },
  "retainedEvidenceRoot": "/home/marsh-office/.local/state/verification-harness/isolated-integration/retained/20261016T025613Z-2182451",
  "originalArtifacts": {
    "result.json": {
      "sha256": "8dbd3b4def02240f5efef3854e5a77101929cb32a433885ce9baf7d44f4dd2f8",
      "data": {
        "schemaVersion": 1,
        "harness": "isolated-integration",
        "runId": "20261016T025613Z-2182451",
        "evidenceDir": "/home/marsh-office/.local/state/verification-harness/isolated-integration/20261016T025613Z-2182451",
        "selection": {
          "only": null,
          "from": null
        },
        "reuseFromRunId": null,
        "preflight": null,
        "phases": [
          {
            "phase": "prepare",
            "evidenceDir": "/home/marsh-office/.local/state/verification-harness/isolated-integration/20261016T025613Z-2182451/phases/prepare",
            "startedAt": "2026-10-16T02:56:13.497Z",
            "endedAt": "2026-10-16T02:56:24.004Z",
            "elapsedMs": 10507,
            "status": "passed",
            "step": null,
            "reasonCode": null
          },
          {
            "phase": "execute",
            "evidenceDir": "/home/marsh-office/.local/state/verification-harness/isolated-integration/20261016T025613Z-2182451/phases/execute",
            "startedAt": "2026-10-16T02:56:24.006Z",
            "endedAt": "2026-10-16T03:00:14.571Z",
            "elapsedMs": 230565,
            "status": "passed",
            "step": null,
            "reasonCode": null
          },
          {
            "phase": "teardown",
            "evidenceDir": "/home/marsh-office/.local/state/verification-harness/isolated-integration/20261016T025613Z-2182451/phases/teardown",
            "startedAt": "2026-10-16T03:00:14.667Z",
            "endedAt": "2026-10-16T03:00:14.668Z",
            "elapsedMs": 1,
            "status": "passed",
            "step": null,
            "reasonCode": null
          }
        ],
        "verdict": "pass",
        "firstFailure": null,
        "startedAt": "2026-10-16T02:56:13.495Z",
        "endedAt": "2026-10-16T03:00:15.692Z"
      }
    },
    "phases/prepare/source.json": {
      "sha256": "77387365cc30813e9f00d623e6a86fd3815906dbb4711156399ba8b9f3e26f73",
      "data": {
        "schemaVersion": 1,
        "runId": "20261016T025613Z-2182451",
        "sourceCommit": "9926609424b1bf34268a708a20334aed39156e28",
        "repoRoot": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/verifier-command-ULHNXg/invoked-source",
        "filePath": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
        "runGroupId": null,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "files": [
          {
            "path": "apps/operator/bin/bundle-host.sh",
            "sha256": "cacd91c424cbc9afaea5742ea5c636606abea1469ef270ca04bd8924792c6dfe",
            "gitSha256": "cacd91c424cbc9afaea5742ea5c636606abea1469ef270ca04bd8924792c6dfe"
          },
          {
            "path": "apps/operator/bin/hono-host.ts",
            "sha256": "e530cb599658689b7eaabeb2f3c55fd84b8151a1ae9a22e9489d99954a703580",
            "gitSha256": "e530cb599658689b7eaabeb2f3c55fd84b8151a1ae9a22e9489d99954a703580"
          },
          {
            "path": "packages/operator-core/lib/agent-tools/coordination/escalations.ts",
            "sha256": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52",
            "gitSha256": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52"
          },
          {
            "path": "packages/operator-core/lib/build-info.ts",
            "sha256": "6d271f5721a0d47c68fa8f42996a34f7b48fe4c06e414285a3f7fe36bdc44a50",
            "gitSha256": "6d271f5721a0d47c68fa8f42996a34f7b48fe4c06e414285a3f7fe36bdc44a50"
          },
          {
            "path": "packages/operator-core/lib/derived-reads/shared-snapshot.ts",
            "sha256": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826",
            "gitSha256": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826"
          },
          {
            "path": "packages/operator-core/lib/severe-event-owner.ts",
            "sha256": "2c59fb583ed0e16abffb543fcf00f2099d2b524786dc456dac78f79648e5cbb2",
            "gitSha256": "2c59fb583ed0e16abffb543fcf00f2099d2b524786dc456dac78f79648e5cbb2"
          },
          {
            "path": "packages/operator-core/lib/system-health/agent-strand-census.ts",
            "sha256": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284",
            "gitSha256": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284"
          },
          {
            "path": "packages/operator-core/lib/system-health/compute.ts",
            "sha256": "caabb259b0a63fc5cb522c926ee52ed8f39185a07cf6c9e332db9ed68c031d75",
            "gitSha256": "caabb259b0a63fc5cb522c926ee52ed8f39185a07cf6c9e332db9ed68c031d75"
          },
          {
            "path": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
            "sha256": "f62bf14b6ae06d361333052e888d578f04a04e255a1b722c05ad493d8cd2f2f6",
            "gitSha256": "f62bf14b6ae06d361333052e888d578f04a04e255a1b722c05ad493d8cd2f2f6"
          },
          {
            "path": "packages/operator-core/lib/system-health/liveness-alarm.ts",
            "sha256": "9941ccb7143b39250a4decc4ef5df0d1ff0ed60b67959f017aab61483a276e54",
            "gitSha256": "9941ccb7143b39250a4decc4ef5df0d1ff0ed60b67959f017aab61483a276e54"
          },
          {
            "path": "packages/operator-core/lib/workspace-host/observability-store.ts",
            "sha256": "a5caa034e552bbe282b1fd8ba1536ae9d2a081977be1f74c796ed62b15872bf5",
            "gitSha256": "a5caa034e552bbe282b1fd8ba1536ae9d2a081977be1f74c796ed62b15872bf5"
          },
          {
            "path": "packages/operator-core/test/isolated-integration-proof.ts",
            "sha256": "4d94abc628459995b95d2d59568d448129fc8d2942c1a8c33df81518cae1c007",
            "gitSha256": "4d94abc628459995b95d2d59568d448129fc8d2942c1a8c33df81518cae1c007"
          },
          {
            "path": "packages/operator-core/test/liveness-alarm-http-fixture.ts",
            "sha256": "d69baeafeed0a60694d009868470f274d6f1bc04e94d13f7a7f9a430b4d2bed6",
            "gitSha256": "d69baeafeed0a60694d009868470f274d6f1bc04e94d13f7a7f9a430b4d2bed6"
          },
          {
            "path": "packages/operator-core/test/private-http-workspace-preflight.ts",
            "sha256": "b376e85a13ff437837136b922b424e96177b86d9404dd1045b217f9d58bd4369",
            "gitSha256": "b376e85a13ff437837136b922b424e96177b86d9404dd1045b217f9d58bd4369"
          },
          {
            "path": "scripts/lib/isolated-runtime-start.mjs",
            "sha256": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
            "gitSha256": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d"
          },
          {
            "path": "scripts/with-test-pg.mjs",
            "sha256": "f244956e28aa03a05bb69c9ead76c2d8ea87eac725ea0608b81d303316981898",
            "gitSha256": "f244956e28aa03a05bb69c9ead76c2d8ea87eac725ea0608b81d303316981898"
          },
          {
            "path": "scripts/lib/with-test-pg-cleanup.mjs",
            "sha256": "37effd76e07e992646bd8192b93ead3ee7e865712de89d9eb733bdc1a8713b61",
            "gitSha256": "37effd76e07e992646bd8192b93ead3ee7e865712de89d9eb733bdc1a8713b61"
          }
        ],
        "parentObserver": {
          "database": "org_caa54f7d8031",
          "flush": {
            "written": 0,
            "failed": 0,
            "dropped": 0,
            "rejected": 0
          }
        }
      }
    },
    "phases/execute/lifecycle.json": {
      "sha256": "45c235f2d8d521d58ad1b7d63669f59b55c8b6ae7c3986fa4d0184b66db30d80",
      "data": {
        "schemaVersion": 1,
        "runId": "20261016T025613Z-2182451",
        "host": "main-server-Precision-7865-Tower",
        "observedAt": "2026-10-16T02:56:41.175Z",
        "observer": {
          "pid": 2182451,
          "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:90833298",
          "parentPid": 2181252
        },
        "supervisor": {
          "pid": 2197857,
          "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:90835749",
          "parentPid": 2182451
        },
        "worker": {
          "pid": 2209512,
          "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:90837462",
          "parentPid": 2197857
        },
        "database": {
          "pid": 2199619,
          "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:90835982",
          "parentPid": 2197857
        },
        "argv": [
          "/home/marsh-office/.local/node25/bin/node",
          "--import",
          "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/verifier-command-ULHNXg/invoked-source/scripts/lib/isolated-runtime-start.mjs",
          "--import",
          "tsx",
          "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/verifier-command-ULHNXg/invoked-source/packages/operator-core/test/liveness-alarm-http-fixture.ts"
        ],
        "cwd": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/verifier-command-ULHNXg/invoked-source",
        "workspace": "test-runtime-7f14219a-e31",
        "runtimeRoot": "/tmp/pcv/papercusp-test-runtime-xnNuK7",
        "dataDir": "/tmp/pcv/papercusp-test-pg-LJTvjI",
        "pgPort": 41501,
        "ended": {
          "kind": "isolated-runtime-end",
          "childPid": 2209512,
          "exitCode": 0,
          "signal": null,
          "runtimeRemoved": true,
          "pgDataRemoved": true,
          "observedAt": "2026-10-16T03:00:14.119Z"
        }
      }
    }
  },
  "currentHead": "7f780420fa1b8fef6e4b29caa0ed04d893c2ac22",
  "currentSourceCoverage": [
    {
      "path": "apps/operator/bin/bundle-host.sh",
      "original": "cacd91c424cbc9afaea5742ea5c636606abea1469ef270ca04bd8924792c6dfe",
      "current": "cacd91c424cbc9afaea5742ea5c636606abea1469ef270ca04bd8924792c6dfe",
      "committed": "cacd91c424cbc9afaea5742ea5c636606abea1469ef270ca04bd8924792c6dfe"
    },
    {
      "path": "apps/operator/bin/hono-host.ts",
      "original": "e530cb599658689b7eaabeb2f3c55fd84b8151a1ae9a22e9489d99954a703580",
      "current": "e530cb599658689b7eaabeb2f3c55fd84b8151a1ae9a22e9489d99954a703580",
      "committed": "e530cb599658689b7eaabeb2f3c55fd84b8151a1ae9a22e9489d99954a703580"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/coordination/escalations.ts",
      "original": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52",
      "current": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52",
      "committed": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52"
    },
    {
      "path": "packages/operator-core/lib/build-info.ts",
      "original": "6d271f5721a0d47c68fa8f42996a34f7b48fe4c06e414285a3f7fe36bdc44a50",
      "current": "6d271f5721a0d47c68fa8f42996a34f7b48fe4c06e414285a3f7fe36bdc44a50",
      "committed": "6d271f5721a0d47c68fa8f42996a34f7b48fe4c06e414285a3f7fe36bdc44a50"
    },
    {
      "path": "packages/operator-core/lib/derived-reads/shared-snapshot.ts",
      "original": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826",
      "current": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826",
      "committed": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826"
    },
    {
      "path": "packages/operator-core/lib/severe-event-owner.ts",
      "original": "2c59fb583ed0e16abffb543fcf00f2099d2b524786dc456dac78f79648e5cbb2",
      "current": "2c59fb583ed0e16abffb543fcf00f2099d2b524786dc456dac78f79648e5cbb2",
      "committed": "2c59fb583ed0e16abffb543fcf00f2099d2b524786dc456dac78f79648e5cbb2"
    },
    {
      "path": "packages/operator-core/lib/system-health/agent-strand-census.ts",
      "original": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284",
      "current": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284",
      "committed": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284"
    },
    {
      "path": "packages/operator-core/lib/system-health/compute.ts",
      "original": "caabb259b0a63fc5cb522c926ee52ed8f39185a07cf6c9e332db9ed68c031d75",
      "current": "caabb259b0a63fc5cb522c926ee52ed8f39185a07cf6c9e332db9ed68c031d75",
      "committed": "caabb259b0a63fc5cb522c926ee52ed8f39185a07cf6c9e332db9ed68c031d75"
    },
    {
      "path": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
      "original": "f62bf14b6ae06d361333052e888d578f04a04e255a1b722c05ad493d8cd2f2f6",
      "current": "f62bf14b6ae06d361333052e888d578f04a04e255a1b722c05ad493d8cd2f2f6",
      "committed": "f62bf14b6ae06d361333052e888d578f04a04e255a1b722c05ad493d8cd2f2f6"
    },
    {
      "path": "packages/operator-core/lib/system-health/liveness-alarm.ts",
      "original": "9941ccb7143b39250a4decc4ef5df0d1ff0ed60b67959f017aab61483a276e54",
      "current": "9941ccb7143b39250a4decc4ef5df0d1ff0ed60b67959f017aab61483a276e54",
      "committed": "9941ccb7143b39250a4decc4ef5df0d1ff0ed60b67959f017aab61483a276e54"
    },
    {
      "path": "packages/operator-core/lib/workspace-host/observability-store.ts",
      "original": "a5caa034e552bbe282b1fd8ba1536ae9d2a081977be1f74c796ed62b15872bf5",
      "current": "a5caa034e552bbe282b1fd8ba1536ae9d2a081977be1f74c796ed62b15872bf5",
      "committed": "a5caa034e552bbe282b1fd8ba1536ae9d2a081977be1f74c796ed62b15872bf5"
    },
    {
      "path": "packages/operator-core/test/isolated-integration-proof.ts",
      "original": "4d94abc628459995b95d2d59568d448129fc8d2942c1a8c33df81518cae1c007",
      "current": "4d94abc628459995b95d2d59568d448129fc8d2942c1a8c33df81518cae1c007",
      "committed": "4d94abc628459995b95d2d59568d448129fc8d2942c1a8c33df81518cae1c007"
    },
    {
      "path": "packages/operator-core/test/liveness-alarm-http-fixture.ts",
      "original": "d69baeafeed0a60694d009868470f274d6f1bc04e94d13f7a7f9a430b4d2bed6",
      "current": "d69baeafeed0a60694d009868470f274d6f1bc04e94d13f7a7f9a430b4d2bed6",
      "committed": "d69baeafeed0a60694d009868470f274d6f1bc04e94d13f7a7f9a430b4d2bed6"
    },
    {
      "path": "packages/operator-core/test/private-http-workspace-preflight.ts",
      "original": "b376e85a13ff437837136b922b424e96177b86d9404dd1045b217f9d58bd4369",
      "current": "b376e85a13ff437837136b922b424e96177b86d9404dd1045b217f9d58bd4369",
      "committed": "b376e85a13ff437837136b922b424e96177b86d9404dd1045b217f9d58bd4369"
    },
    {
      "path": "scripts/lib/isolated-runtime-start.mjs",
      "original": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
      "current": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
      "committed": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d"
    },
    {
      "path": "scripts/with-test-pg.mjs",
      "original": "f244956e28aa03a05bb69c9ead76c2d8ea87eac725ea0608b81d303316981898",
      "current": "f244956e28aa03a05bb69c9ead76c2d8ea87eac725ea0608b81d303316981898",
      "committed": "f244956e28aa03a05bb69c9ead76c2d8ea87eac725ea0608b81d303316981898"
    },
    {
      "path": "scripts/lib/with-test-pg-cleanup.mjs",
      "original": "37effd76e07e992646bd8192b93ead3ee7e865712de89d9eb733bdc1a8713b61",
      "current": "37effd76e07e992646bd8192b93ead3ee7e865712de89d9eb733bdc1a8713b61",
      "committed": "37effd76e07e992646bd8192b93ead3ee7e865712de89d9eb733bdc1a8713b61"
    }
  ],
  "cleanupPathsAbsent": {
    "runtimeRoot": true,
    "dataDir": true
  },
  "writerReference": "libs/test-config/src/admin-test-runs-reporter.ts:74..93; hashes result.json,phases/prepare/source.json,phases/execute/lifecycle.json",
  "scope": "One maintained selected R12 e2e pass with3filtered skips. Existing job recovered; no rerun/source edit or installed/final-all-fix/24h acceptance claim. Original historical proof21264977 unchanged.",
  "next": "Bind exact R12@4 supported fromTestRun21268585; verify adequacy/currentness before claiming current acceptance."
}
