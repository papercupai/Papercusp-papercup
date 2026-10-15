---
rel_path: "audits/parked-agent-resumption-2026-10-09/fire59-r12-completed-run-and-current-source-custody-20261015-424d5.json"
updated_at: 1792031674405
_body: "content"
---

{
  "schemaVersion": 1,
  "observedAt": "2026-10-15T02:34:32.150286+00:00",
  "workItem": "WI-6554700010008887",
  "latestTestRunId": 21249366,
  "earlierTestRunId": 21249302,
  "latestCommit": "d1524c233646e6ce12fdcbdb0d254c73784995c0",
  "caseResult": {
    "passed": 1,
    "failed": 0,
    "skippedFilteredSiblings": 3,
    "testLayer": "e2e"
  },
  "proofRoot": "/home/marsh-office/.local/state/verification-harness/isolated-integration/20261015T020719Z-1146795",
  "originalArtifacts": {
    "result.json": {
      "schemaVersion": 1,
      "harness": "isolated-integration",
      "runId": "20261015T020719Z-1146795",
      "evidenceDir": "/home/marsh-office/.local/state/verification-harness/isolated-integration/20261015T020719Z-1146795",
      "selection": {
        "only": null,
        "from": null
      },
      "reuseFromRunId": null,
      "preflight": null,
      "phases": [
        {
          "phase": "prepare",
          "evidenceDir": "/home/marsh-office/.local/state/verification-harness/isolated-integration/20261015T020719Z-1146795/phases/prepare",
          "startedAt": "2026-10-15T02:07:19.993Z",
          "endedAt": "2026-10-15T02:07:22.700Z",
          "elapsedMs": 2707,
          "status": "passed",
          "step": null,
          "reasonCode": null
        },
        {
          "phase": "execute",
          "evidenceDir": "/home/marsh-office/.local/state/verification-harness/isolated-integration/20261015T020719Z-1146795/phases/execute",
          "startedAt": "2026-10-15T02:07:22.701Z",
          "endedAt": "2026-10-15T02:12:04.513Z",
          "elapsedMs": 281812,
          "status": "passed",
          "step": null,
          "reasonCode": null
        },
        {
          "phase": "teardown",
          "evidenceDir": "/home/marsh-office/.local/state/verification-harness/isolated-integration/20261015T020719Z-1146795/phases/teardown",
          "startedAt": "2026-10-15T02:12:05.941Z",
          "endedAt": "2026-10-15T02:12:05.942Z",
          "elapsedMs": 1,
          "status": "passed",
          "step": null,
          "reasonCode": null
        }
      ],
      "verdict": "pass",
      "firstFailure": null,
      "startedAt": "2026-10-15T02:07:19.988Z",
      "endedAt": "2026-10-15T02:12:06.853Z"
    },
    "phases/prepare/source.json": {
      "schemaVersion": 1,
      "runId": "20261015T020719Z-1146795",
      "sourceCommit": "d1524c233646e6ce12fdcbdb0d254c73784995c0",
      "repoRoot": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/verifier-command-KFsEN3/invoked-source",
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
          "sha256": "611708b9bd17e8464a84168251b918f8991f4bb270bf34e67921f8bea4efd98d",
          "gitSha256": "611708b9bd17e8464a84168251b918f8991f4bb270bf34e67921f8bea4efd98d"
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
          "sha256": "f46b54aebc449cf0616ae0a457924cb59fcac18d724e845fb0f3af7628b4853f",
          "gitSha256": "f46b54aebc449cf0616ae0a457924cb59fcac18d724e845fb0f3af7628b4853f"
        },
        {
          "path": "packages/operator-core/lib/workspace-host/observability-store.ts",
          "sha256": "a5caa034e552bbe282b1fd8ba1536ae9d2a081977be1f74c796ed62b15872bf5",
          "gitSha256": "a5caa034e552bbe282b1fd8ba1536ae9d2a081977be1f74c796ed62b15872bf5"
        },
        {
          "path": "packages/operator-core/test/isolated-integration-proof.ts",
          "sha256": "62dd3348dd79c446af03397d5b17eadc7bd611cfb360f1089bce55714b84eae1",
          "gitSha256": "62dd3348dd79c446af03397d5b17eadc7bd611cfb360f1089bce55714b84eae1"
        },
        {
          "path": "packages/operator-core/test/liveness-alarm-http-fixture.ts",
          "sha256": "e5b53c8231eb7938c52ca22cb89e966b1e6f672dae28937eda745dee796a87d6",
          "gitSha256": "e5b53c8231eb7938c52ca22cb89e966b1e6f672dae28937eda745dee796a87d6"
        },
        {
          "path": "packages/operator-core/test/private-http-workspace-preflight.ts",
          "sha256": "d47d18c45f069da8614721447d8a88ee9cad2c275e60d04260762a8b5b7eab20",
          "gitSha256": "d47d18c45f069da8614721447d8a88ee9cad2c275e60d04260762a8b5b7eab20"
        },
        {
          "path": "scripts/lib/isolated-runtime-start.mjs",
          "sha256": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
          "gitSha256": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d"
        },
        {
          "path": "scripts/with-test-pg.mjs",
          "sha256": "c5b091686531409443a86b582dfd2f9c465a8b9d7055c752354df490be87f750",
          "gitSha256": "c5b091686531409443a86b582dfd2f9c465a8b9d7055c752354df490be87f750"
        },
        {
          "path": "scripts/lib/with-test-pg-cleanup.mjs",
          "sha256": "37effd76e07e992646bd8192b93ead3ee7e865712de89d9eb733bdc1a8713b61",
          "gitSha256": "37effd76e07e992646bd8192b93ead3ee7e865712de89d9eb733bdc1a8713b61"
        }
      ],
      "parentObserver": {
        "database": "org_4ccd3b7e9818",
        "flush": {
          "written": 0,
          "failed": 0,
          "dropped": 0,
          "rejected": 0
        }
      }
    },
    "phases/execute/lifecycle.json": {
      "schemaVersion": 1,
      "runId": "20261015T020719Z-1146795",
      "host": "main-server-Precision-7865-Tower",
      "observedAt": "2026-10-15T02:07:50.008Z",
      "observer": {
        "pid": 1146795,
        "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:81900813",
        "parentPid": 1144738
      },
      "supervisor": {
        "pid": 1154758,
        "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:81901619",
        "parentPid": 1146795
      },
      "worker": {
        "pid": 1175915,
        "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:81904341",
        "parentPid": 1154758
      },
      "database": {
        "pid": 1157870,
        "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:81901988",
        "parentPid": 1154758
      },
      "argv": [
        "/home/marsh-office/.local/node25/bin/node",
        "--import",
        "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/verifier-command-KFsEN3/invoked-source/scripts/lib/isolated-runtime-start.mjs",
        "--import",
        "tsx",
        "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/verifier-command-KFsEN3/invoked-source/packages/operator-core/test/liveness-alarm-http-fixture.ts"
      ],
      "cwd": "/home/marsh-office/papercupai-workspace/papercusp/.papercusp/scratch/verifier-command-KFsEN3/invoked-source",
      "workspace": "test-runtime-2d3c9602-ab8",
      "runtimeRoot": "/tmp/pcv/papercusp-test-runtime-N2z0xz",
      "dataDir": "/tmp/pcv/papercusp-test-pg-L6g7lf",
      "pgPort": 33807,
      "ended": {
        "kind": "isolated-runtime-end",
        "childPid": 1175915,
        "exitCode": 0,
        "signal": null,
        "runtimeRemoved": true,
        "pgDataRemoved": true,
        "observedAt": "2026-10-15T02:12:03.604Z"
      }
    }
  },
  "receiptHashes": {
    "result.json": "c8b82de84eeaed9aa2350f1ad1b9bc6a546b20d866dc3a0f7181242cd9f3f02f",
    "phases/prepare/source.json": "37f5d873cf6bce512625d25c7d1aee4254c8af998e39bb5def3c78ff3cfbca35",
    "phases/execute/lifecycle.json": "204ab5f250d445a09a1bbe232a9c4bfe832873f78ac70067d688a74dd172ecff"
  },
  "receiptHashesMatchStoredLedger": true,
  "sourceComparisons": [
    {
      "path": "apps/operator/bin/bundle-host.sh",
      "recorded": "cacd91c424cbc9afaea5742ea5c636606abea1469ef270ca04bd8924792c6dfe",
      "working": "cacd91c424cbc9afaea5742ea5c636606abea1469ef270ca04bd8924792c6dfe",
      "head": "cacd91c424cbc9afaea5742ea5c636606abea1469ef270ca04bd8924792c6dfe",
      "matches": true
    },
    {
      "path": "apps/operator/bin/hono-host.ts",
      "recorded": "611708b9bd17e8464a84168251b918f8991f4bb270bf34e67921f8bea4efd98d",
      "working": "611708b9bd17e8464a84168251b918f8991f4bb270bf34e67921f8bea4efd98d",
      "head": "611708b9bd17e8464a84168251b918f8991f4bb270bf34e67921f8bea4efd98d",
      "matches": true
    },
    {
      "path": "packages/operator-core/lib/agent-tools/coordination/escalations.ts",
      "recorded": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52",
      "working": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52",
      "head": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52",
      "matches": true
    },
    {
      "path": "packages/operator-core/lib/build-info.ts",
      "recorded": "6d271f5721a0d47c68fa8f42996a34f7b48fe4c06e414285a3f7fe36bdc44a50",
      "working": "6d271f5721a0d47c68fa8f42996a34f7b48fe4c06e414285a3f7fe36bdc44a50",
      "head": "6d271f5721a0d47c68fa8f42996a34f7b48fe4c06e414285a3f7fe36bdc44a50",
      "matches": true
    },
    {
      "path": "packages/operator-core/lib/derived-reads/shared-snapshot.ts",
      "recorded": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826",
      "working": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826",
      "head": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826",
      "matches": true
    },
    {
      "path": "packages/operator-core/lib/severe-event-owner.ts",
      "recorded": "2c59fb583ed0e16abffb543fcf00f2099d2b524786dc456dac78f79648e5cbb2",
      "working": "2c59fb583ed0e16abffb543fcf00f2099d2b524786dc456dac78f79648e5cbb2",
      "head": "2c59fb583ed0e16abffb543fcf00f2099d2b524786dc456dac78f79648e5cbb2",
      "matches": true
    },
    {
      "path": "packages/operator-core/lib/system-health/agent-strand-census.ts",
      "recorded": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284",
      "working": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284",
      "head": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284",
      "matches": true
    },
    {
      "path": "packages/operator-core/lib/system-health/compute.ts",
      "recorded": "caabb259b0a63fc5cb522c926ee52ed8f39185a07cf6c9e332db9ed68c031d75",
      "working": "caabb259b0a63fc5cb522c926ee52ed8f39185a07cf6c9e332db9ed68c031d75",
      "head": "caabb259b0a63fc5cb522c926ee52ed8f39185a07cf6c9e332db9ed68c031d75",
      "matches": true
    },
    {
      "path": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
      "recorded": "f62bf14b6ae06d361333052e888d578f04a04e255a1b722c05ad493d8cd2f2f6",
      "working": "f62bf14b6ae06d361333052e888d578f04a04e255a1b722c05ad493d8cd2f2f6",
      "head": "f62bf14b6ae06d361333052e888d578f04a04e255a1b722c05ad493d8cd2f2f6",
      "matches": true
    },
    {
      "path": "packages/operator-core/lib/system-health/liveness-alarm.ts",
      "recorded": "f46b54aebc449cf0616ae0a457924cb59fcac18d724e845fb0f3af7628b4853f",
      "working": "f46b54aebc449cf0616ae0a457924cb59fcac18d724e845fb0f3af7628b4853f",
      "head": "f46b54aebc449cf0616ae0a457924cb59fcac18d724e845fb0f3af7628b4853f",
      "matches": true
    },
    {
      "path": "packages/operator-core/lib/workspace-host/observability-store.ts",
      "recorded": "a5caa034e552bbe282b1fd8ba1536ae9d2a081977be1f74c796ed62b15872bf5",
      "working": "a5caa034e552bbe282b1fd8ba1536ae9d2a081977be1f74c796ed62b15872bf5",
      "head": "a5caa034e552bbe282b1fd8ba1536ae9d2a081977be1f74c796ed62b15872bf5",
      "matches": true
    },
    {
      "path": "packages/operator-core/test/isolated-integration-proof.ts",
      "recorded": "62dd3348dd79c446af03397d5b17eadc7bd611cfb360f1089bce55714b84eae1",
      "working": "29a7d8389d2e220713a72406ebad295be771ad08e1537a49a41641ae905712b2",
      "head": "29a7d8389d2e220713a72406ebad295be771ad08e1537a49a41641ae905712b2",
      "matches": false
    },
    {
      "path": "packages/operator-core/test/liveness-alarm-http-fixture.ts",
      "recorded": "e5b53c8231eb7938c52ca22cb89e966b1e6f672dae28937eda745dee796a87d6",
      "working": "e5b53c8231eb7938c52ca22cb89e966b1e6f672dae28937eda745dee796a87d6",
      "head": "e5b53c8231eb7938c52ca22cb89e966b1e6f672dae28937eda745dee796a87d6",
      "matches": true
    },
    {
      "path": "packages/operator-core/test/private-http-workspace-preflight.ts",
      "recorded": "d47d18c45f069da8614721447d8a88ee9cad2c275e60d04260762a8b5b7eab20",
      "working": "aef9d2b335b1dd6146f767febeb0818767096fce4814e57a5077d89220519c09",
      "head": "aef9d2b335b1dd6146f767febeb0818767096fce4814e57a5077d89220519c09",
      "matches": false
    },
    {
      "path": "scripts/lib/isolated-runtime-start.mjs",
      "recorded": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
      "working": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
      "head": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
      "matches": true
    },
    {
      "path": "scripts/with-test-pg.mjs",
      "recorded": "c5b091686531409443a86b582dfd2f9c465a8b9d7055c752354df490be87f750",
      "working": "c5b091686531409443a86b582dfd2f9c465a8b9d7055c752354df490be87f750",
      "head": "c5b091686531409443a86b582dfd2f9c465a8b9d7055c752354df490be87f750",
      "matches": true
    },
    {
      "path": "scripts/lib/with-test-pg-cleanup.mjs",
      "recorded": "37effd76e07e992646bd8192b93ead3ee7e865712de89d9eb733bdc1a8713b61",
      "working": "37effd76e07e992646bd8192b93ead3ee7e865712de89d9eb733bdc1a8713b61",
      "head": "37effd76e07e992646bd8192b93ead3ee7e865712de89d9eb733bdc1a8713b61",
      "matches": true
    }
  ],
  "runtimeRemoved": true,
  "pgDataRemoved": true,
  "limits": [
    "Pinned committed run passed; two shared helpers subsequently changed, so this is historical scoped proof, not current-source acceptance.",
    "No rerun started during recovery. No historical backfill or old-row mutation.",
    "Overall R5/R12/R13/root961/final-runtime/actual24h R14 remain open."
  ],
  "recoveredPredecessor": "01a13d39-477d-7c42-b18c-427e9b34ecfa"
}
