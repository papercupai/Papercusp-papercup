---
rel_path: "audits/parked-agent-resumption-2026-10-09/fire92-r12-terminal-retention-custody-424d5.json"
updated_at: 1792132887797
_body: "content"
---

{
  "schemaVersion": 1,
  "originalTask": "0mvak8jvkhzw9ap1u4g",
  "taskTerminalEvent": {
    "deliveryId": 843317,
    "state": "exited",
    "exitCode": 1
  },
  "logPath": ".papercusp/scratch/bash-427fcae7-02d.log",
  "logSha256": "7a39cd3ea86c891ecbb6954c18c04c55ad691e63e2c1ad1f774fa55eb4743fd5",
  "reporterPath": "/tmp/parked-fire88-r12-current-reporter-424d5.jsonl",
  "reporterSha256": "4dfa98f429122866c9be055ae61c133f87e0f0d9f903ae2ced52da0397764047",
  "originalReporter": [
    {
      "receiptId": "3e9b32bc-078d-43ea-8c5a-49696cb4757b",
      "attempt": 0,
      "filePath": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
      "status": "fail",
      "row": {
        "filePath": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
        "status": "fail",
        "durationMs": 180243,
        "startedAt": "2026-10-16T06:14:58.812Z",
        "finishedAt": "2026-10-16T06:17:59.055Z",
        "outputTail": "keeps a request-worker wedged alarm standing across restart and resolves only a measured recovery: Timed out after 180000ms waiting for fs-mutex \"papercusp-disk-retention\" (/home/marsh-office/.papercusp/fs-mutex-locks/papercusp-disk-retention.lock); holder: {\n  \"pid\": 365316,\n  \"tgid\": 365316,\n  \"startTicks\": \"91673048\",\n  \"bootId\": \"b8c61f1d-f67c-43a8-ac9d-2286713e224f\",\n  \"host\": \"main-server-Precision-7865-Tower\",\n  \"startedAt\": \"2026-10-16T06:12:56.753Z\",\n  \"name\": \"papercusp-disk-retention\",\n  \"acquiredAt\": \"2026-10-16T06:12:56.795Z\",\n  \"phase\": \"running\",\n  \"runningAt\": \"2026-10-16T06:12:56.839Z\"\n}\n",
        "isScratchConfig": false,
        "executionDetails": {
          "schemaVersion": 1,
          "runStartedAt": "2026-10-16T06:14:53.942Z",
          "root": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/verifier-command-mbfZaA/invoked-source",
          "runGroupId": null,
          "workspaceId": "papercusp-workspace",
          "harnessSlug": "papercusp",
          "testNamePattern": "keeps a request-worker wedged alarm standing across restart and resolves only a measured recovery",
          "testLayer": "e2e",
          "mutationPhase": null,
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured",
          "filePath": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
          "passed": 0,
          "failed": 1,
          "skipped": 3,
          "collectionFailed": false,
          "failedCaseTitles": [
            "keeps a request-worker wedged alarm standing across restart and resolves only a measured recovery"
          ],
          "worktreeDirty": false,
          "commitSha": "a48bba03ecda239044c6b0cbced8371fe2319415",
          "runtimeEnvironmentAfterCaptureStatus": "not-configured"
        },
        "verifierSourceReason": null,
        "cases": [
          {
            "caseIndex": 0,
            "caseKey": "keeps a request-worker wedged alarm standing across restart and resolves only a measured recovery",
            "occurrence": 1,
            "status": "fail",
            "durationMs": 180238,
            "errorTail": "Timed out after 180000ms waiting for fs-mutex \"papercusp-disk-retention\" (/home/marsh-office/.papercusp/fs-mutex-locks/papercusp-disk-retention.lock); holder: {\n  \"pid\": 365316,\n  \"tgid\": 365316,\n  \"startTicks\": \"91673048\",\n  \"bootId\": \"b8c61f1d-f67c-43a8-ac9d-2286713e224f\",\n  \"host\": \"main-server-Precision-7865-Tower\",\n  \"startedAt\": \"2026-10-16T06:12:56.753Z\",\n  \"name\": \"papercusp-disk-retention\",\n  \"acquiredAt\": \"2026-10-16T06:12:56.795Z\",\n  \"phase\": \"running\",\n  \"runningAt\": \"2026-10-16T06:12:56.839Z\"\n}\n"
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
        "commitSha": "a48bba03ecda239044c6b0cbced8371fe2319415",
        "receiptId": "3e9b32bc-078d-43ea-8c5a-49696cb4757b",
        "receiptAttempt": 0
      },
      "outcome": "inserted",
      "id": "21272651"
    }
  ],
  "markers": {
    "R12_SOURCE_PREFLIGHT": {
      "head": "a48bba03ecda239044c6b0cbced8371fe2319415",
      "sources": [
        {
          "path": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
          "sha256": "f62bf14b6ae06d361333052e888d578f04a04e255a1b722c05ad493d8cd2f2f6",
          "committedSha256": "f62bf14b6ae06d361333052e888d578f04a04e255a1b722c05ad493d8cd2f2f6"
        },
        {
          "path": "packages/operator-core/test/liveness-alarm-http-fixture.ts",
          "sha256": "d69baeafeed0a60694d009868470f274d6f1bc04e94d13f7a7f9a430b4d2bed6",
          "committedSha256": "d69baeafeed0a60694d009868470f274d6f1bc04e94d13f7a7f9a430b4d2bed6"
        },
        {
          "path": "packages/operator-core/test/private-http-workspace-preflight.ts",
          "sha256": "b376e85a13ff437837136b922b424e96177b86d9404dd1045b217f9d58bd4369",
          "committedSha256": "b376e85a13ff437837136b922b424e96177b86d9404dd1045b217f9d58bd4369"
        },
        {
          "path": "packages/operator-core/test/isolated-integration-proof.ts",
          "sha256": "14d356cbd9b3fce8014966eee580c2a4b447e0308ea2c862734f602ed2ef7793",
          "committedSha256": "14d356cbd9b3fce8014966eee580c2a4b447e0308ea2c862734f602ed2ef7793"
        },
        {
          "path": "scripts/with-test-pg.mjs",
          "sha256": "f244956e28aa03a05bb69c9ead76c2d8ea87eac725ea0608b81d303316981898",
          "committedSha256": "f244956e28aa03a05bb69c9ead76c2d8ea87eac725ea0608b81d303316981898"
        },
        {
          "path": "apps/operator/bin/hono-host.ts",
          "sha256": "e530cb599658689b7eaabeb2f3c55fd84b8151a1ae9a22e9489d99954a703580",
          "committedSha256": "e530cb599658689b7eaabeb2f3c55fd84b8151a1ae9a22e9489d99954a703580"
        },
        {
          "path": "apps/operator/bin/bundle-host.sh",
          "sha256": "cacd91c424cbc9afaea5742ea5c636606abea1469ef270ca04bd8924792c6dfe",
          "committedSha256": "cacd91c424cbc9afaea5742ea5c636606abea1469ef270ca04bd8924792c6dfe"
        },
        {
          "path": "packages/operator-core/lib/system-health/agent-strand-census.ts",
          "sha256": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284",
          "committedSha256": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284"
        },
        {
          "path": "packages/operator-core/lib/system-health/liveness-alarm.ts",
          "sha256": "9941ccb7143b39250a4decc4ef5df0d1ff0ed60b67959f017aab61483a276e54",
          "committedSha256": "9941ccb7143b39250a4decc4ef5df0d1ff0ed60b67959f017aab61483a276e54"
        },
        {
          "path": "packages/operator-core/lib/system-health/compute.ts",
          "sha256": "caabb259b0a63fc5cb522c926ee52ed8f39185a07cf6c9e332db9ed68c031d75",
          "committedSha256": "caabb259b0a63fc5cb522c926ee52ed8f39185a07cf6c9e332db9ed68c031d75"
        },
        {
          "path": "packages/operator-core/lib/workspace-host/observability-store.ts",
          "sha256": "5c438c62b4bca01aba79d9d2615f6c422ab0a8f9993cf4afe902a909f6d47a81",
          "committedSha256": "5c438c62b4bca01aba79d9d2615f6c422ab0a8f9993cf4afe902a909f6d47a81"
        },
        {
          "path": "packages/operator-core/lib/severe-event-owner.ts",
          "sha256": "2c59fb583ed0e16abffb543fcf00f2099d2b524786dc456dac78f79648e5cbb2",
          "committedSha256": "2c59fb583ed0e16abffb543fcf00f2099d2b524786dc456dac78f79648e5cbb2"
        },
        {
          "path": "packages/operator-core/lib/derived-reads/shared-snapshot.ts",
          "sha256": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826",
          "committedSha256": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826"
        },
        {
          "path": "packages/operator-core/lib/agent-tools/coordination/escalations.ts",
          "sha256": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52",
          "committedSha256": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52"
        },
        {
          "path": "packages/operator-core/lib/build-info.ts",
          "sha256": "6d271f5721a0d47c68fa8f42996a34f7b48fe4c06e414285a3f7fe36bdc44a50",
          "committedSha256": "6d271f5721a0d47c68fa8f42996a34f7b48fe4c06e414285a3f7fe36bdc44a50"
        },
        {
          "path": "scripts/lib/isolated-runtime-start.mjs",
          "sha256": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
          "committedSha256": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d"
        },
        {
          "path": "scripts/lib/with-test-pg-cleanup.mjs",
          "sha256": "37effd76e07e992646bd8192b93ead3ee7e865712de89d9eb733bdc1a8713b61",
          "committedSha256": "37effd76e07e992646bd8192b93ead3ee7e865712de89d9eb733bdc1a8713b61"
        }
      ],
      "tmpdir": "/tmp/pcv",
      "sourceDevice": 66307,
      "tmpDevice": 66304,
      "reporterPositiveControl": 21263027,
      "timeoutMs": 7200000
    },
    "R12_SOURCE_POSTFLIGHT": {
      "head": "a48bba03ecda239044c6b0cbced8371fe2319415",
      "sourceUnchanged": false,
      "files": [
        {
          "path": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
          "before": "f62bf14b6ae06d361333052e888d578f04a04e255a1b722c05ad493d8cd2f2f6",
          "after": "f62bf14b6ae06d361333052e888d578f04a04e255a1b722c05ad493d8cd2f2f6"
        },
        {
          "path": "packages/operator-core/test/liveness-alarm-http-fixture.ts",
          "before": "d69baeafeed0a60694d009868470f274d6f1bc04e94d13f7a7f9a430b4d2bed6",
          "after": "d69baeafeed0a60694d009868470f274d6f1bc04e94d13f7a7f9a430b4d2bed6"
        },
        {
          "path": "packages/operator-core/test/private-http-workspace-preflight.ts",
          "before": "b376e85a13ff437837136b922b424e96177b86d9404dd1045b217f9d58bd4369",
          "after": "a2012f5597b6aef11f4eea57e3fa33ee24d26c26974eff03c7f3c2eb88e1a321"
        },
        {
          "path": "packages/operator-core/test/isolated-integration-proof.ts",
          "before": "14d356cbd9b3fce8014966eee580c2a4b447e0308ea2c862734f602ed2ef7793",
          "after": "14d356cbd9b3fce8014966eee580c2a4b447e0308ea2c862734f602ed2ef7793"
        },
        {
          "path": "scripts/with-test-pg.mjs",
          "before": "f244956e28aa03a05bb69c9ead76c2d8ea87eac725ea0608b81d303316981898",
          "after": "f244956e28aa03a05bb69c9ead76c2d8ea87eac725ea0608b81d303316981898"
        },
        {
          "path": "apps/operator/bin/hono-host.ts",
          "before": "e530cb599658689b7eaabeb2f3c55fd84b8151a1ae9a22e9489d99954a703580",
          "after": "e530cb599658689b7eaabeb2f3c55fd84b8151a1ae9a22e9489d99954a703580"
        },
        {
          "path": "apps/operator/bin/bundle-host.sh",
          "before": "cacd91c424cbc9afaea5742ea5c636606abea1469ef270ca04bd8924792c6dfe",
          "after": "cacd91c424cbc9afaea5742ea5c636606abea1469ef270ca04bd8924792c6dfe"
        },
        {
          "path": "packages/operator-core/lib/system-health/agent-strand-census.ts",
          "before": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284",
          "after": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284"
        },
        {
          "path": "packages/operator-core/lib/system-health/liveness-alarm.ts",
          "before": "9941ccb7143b39250a4decc4ef5df0d1ff0ed60b67959f017aab61483a276e54",
          "after": "9941ccb7143b39250a4decc4ef5df0d1ff0ed60b67959f017aab61483a276e54"
        },
        {
          "path": "packages/operator-core/lib/system-health/compute.ts",
          "before": "caabb259b0a63fc5cb522c926ee52ed8f39185a07cf6c9e332db9ed68c031d75",
          "after": "caabb259b0a63fc5cb522c926ee52ed8f39185a07cf6c9e332db9ed68c031d75"
        },
        {
          "path": "packages/operator-core/lib/workspace-host/observability-store.ts",
          "before": "5c438c62b4bca01aba79d9d2615f6c422ab0a8f9993cf4afe902a909f6d47a81",
          "after": "78c74b2fa5c58698572dfc2b7891f90bbce09f19434003cc99b8b8ea21eb93de"
        },
        {
          "path": "packages/operator-core/lib/severe-event-owner.ts",
          "before": "2c59fb583ed0e16abffb543fcf00f2099d2b524786dc456dac78f79648e5cbb2",
          "after": "2c59fb583ed0e16abffb543fcf00f2099d2b524786dc456dac78f79648e5cbb2"
        },
        {
          "path": "packages/operator-core/lib/derived-reads/shared-snapshot.ts",
          "before": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826",
          "after": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826"
        },
        {
          "path": "packages/operator-core/lib/agent-tools/coordination/escalations.ts",
          "before": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52",
          "after": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52"
        },
        {
          "path": "packages/operator-core/lib/build-info.ts",
          "before": "6d271f5721a0d47c68fa8f42996a34f7b48fe4c06e414285a3f7fe36bdc44a50",
          "after": "6d271f5721a0d47c68fa8f42996a34f7b48fe4c06e414285a3f7fe36bdc44a50"
        },
        {
          "path": "scripts/lib/isolated-runtime-start.mjs",
          "before": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
          "after": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d"
        },
        {
          "path": "scripts/lib/with-test-pg-cleanup.mjs",
          "before": "37effd76e07e992646bd8192b93ead3ee7e865712de89d9eb733bdc1a8713b61",
          "after": "37effd76e07e992646bd8192b93ead3ee7e865712de89d9eb733bdc1a8713b61"
        }
      ]
    },
    "R12_WRAPPER_TERMINAL": {
      "head": "a48bba03ecda239044c6b0cbced8371fe2319415",
      "childStatus": 1,
      "childSignal": null,
      "error": null
    }
  },
  "outerPgShutdownObserved": true,
  "innerRuntimeReceipts": {
    "status": "not-allocated",
    "reason": "runHarness awaited retention before claimRunDir; selected case failed at that await"
  },
  "peerRetentionEvidence": {
    "message": "coord-send-65956d4764278e3eaabcd6ac1551193ef441bcb30b652c9c264d0c25e6860acf",
    "receipt": "3a9ddb99",
    "endedAt": "2026-10-16T06:21:39Z",
    "outcome": "incomplete queuedwriter",
    "fixOwner": "su-e99190cf-f24a-4f8d-a10f-97084e45eae7",
    "fixItem": "EI-26114269957954465",
    "verification": "pending at reply"
  },
  "boundaries": [
    "No new test launch or binding",
    "No retained inner runtime success",
    "No current passing R12 acceptance",
    "No source edit, kill, bypass or timeout widening"
  ]
}
