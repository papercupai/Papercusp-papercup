---
rel_path: "audits/parked-agent-resumption-2026-10-09/r13-private-http-warm-proof-fire28-424d5.json"
updated_at: 1791848789844
_body: "content"
---

{
  "schemaVersion": "private-http-warm-proof-fire28-v1",
  "rootItem": "EI-25793355480687493",
  "runId": "20261012T233246Z-12235",
  "evidenceRoot": "/home/marsh-office/.local/state/verification-harness/isolated-integration/20261012T233246Z-12235",
  "log": "/tmp/parked-fire28-private-http-424d5.log",
  "command": "PAPERCUSP_TEST_RUN_HARNESS=papercusp npm run test:file -- packages/operator-core/lib/agent-tools/session/request-compaction-http.integration.test.ts -t 'refused no-host compaction preserves WARM custody'",
  "exit": 0,
  "passed": 1,
  "skipped": 3,
  "receipt": {
    "workspace": "test-runtime-6a3a8a0d-894",
    "ownerId": "loopback/private-compaction-warm",
    "requests": [
      {
        "name": "coord:whoami",
        "status": 200,
        "result": {
          "ownerId": "loopback/private-compaction-warm",
          "ownerLabel": "system \u00b7 loopback",
          "source": "principal",
          "workspaceId": "test-runtime-6a3a8a0d-894",
          "userId": null,
          "fleetSlug": null,
          "fleetRole": null,
          "inbox_wake_key": "coord:inbox-wake:loopback/private-compaction-warm"
        }
      },
      {
        "name": "session:request-compaction",
        "status": 200,
        "result": {
          "ok": false,
          "requested": false,
          "respawn": false,
          "error": "no_live_pty_host",
          "carry": "warm",
          "retuned": false,
          "note": "No live psu-pty host is available, so no carry-respawn was queued. The active loop keeps its warm carry policy and existing carry-note. Flush state and use the authorized managed-host recovery route before expecting a fresh-context successor."
        }
      },
      {
        "name": "session:request-compaction",
        "status": 200,
        "result": {
          "ok": false,
          "requested": false,
          "respawn": false,
          "error": "no_live_pty_host",
          "carry": "warm",
          "retuned": false,
          "note": "No live psu-pty host is available, so no carry-respawn was queued. The active loop keeps its warm carry policy and existing carry-note. Flush state and use the authorized managed-host recovery route before expecting a fresh-context successor."
        }
      },
      {
        "name": "session:request-compaction",
        "status": 200,
        "result": {
          "ok": false,
          "requested": false,
          "respawn": false,
          "error": "no_live_pty_host",
          "carry": "warm",
          "retuned": false,
          "note": "No live psu-pty host is available, so no carry-respawn was queued. The active loop keeps its warm carry policy and existing carry-note. Flush state and use the authorized managed-host recovery route before expecting a fresh-context successor."
        }
      },
      {
        "name": "session:request-compaction",
        "status": 200,
        "result": {
          "ok": false,
          "requested": false,
          "respawn": false,
          "error": "no_live_pty_host",
          "carry": "warm",
          "retuned": false,
          "note": "No live psu-pty host is available, so no carry-respawn was queued. The active loop keeps its warm carry policy and existing carry-note. Flush state and use the authorized managed-host recovery route before expecting a fresh-context successor."
        }
      }
    ],
    "preserved": true,
    "noPendingRespawn": true,
    "carry": "warm",
    "carryNote": "Existing source-custody checkpoint; preserve WARM",
    "testedArgs": 4,
    "hostPid": 213461,
    "hostStopped": true,
    "bundleSha256": "b97186616f74d3e8ae20b0c47405cdfcf1f8bd318dcda9018f0b46a5298eee8c",
    "health": {
      "ok": true,
      "service": "papercusp-operator",
      "sha": "9a1020fbdf",
      "version": "0.0.1",
      "ts": "2026-10-12T23:37:19.883Z"
    }
  },
  "source": {
    "schemaVersion": 1,
    "runId": "20261012T233246Z-12235",
    "sourceCommit": "9a1020fbdf38b4040d5f1e702a18128b8e7f32e5",
    "repoRoot": "/home/marsh-office/papercupai-workspace/papercusp",
    "filePath": "packages/operator-core/lib/agent-tools/session/request-compaction-http.integration.test.ts",
    "runGroupId": null,
    "workspaceId": "papercusp-workspace",
    "harnessSlug": "papercusp",
    "files": [
      {
        "path": "apps/operator/bin/bundle-host-common.sh",
        "sha256": "6b4d7a1f191274f177dad5ae195bbb13c311efaf084a082dad3436551d83cb6b",
        "gitSha256": "6b4d7a1f191274f177dad5ae195bbb13c311efaf084a082dad3436551d83cb6b"
      },
      {
        "path": "apps/operator/bin/bundle-host.sh",
        "sha256": "a7e7650b7887b691d890a32d3f7d406b333c9e139cd13c1b5deef9678156844a",
        "gitSha256": "a7e7650b7887b691d890a32d3f7d406b333c9e139cd13c1b5deef9678156844a"
      },
      {
        "path": "apps/operator/bin/hono-host.ts",
        "sha256": "611708b9bd17e8464a84168251b918f8991f4bb270bf34e67921f8bea4efd98d",
        "gitSha256": "611708b9bd17e8464a84168251b918f8991f4bb270bf34e67921f8bea4efd98d"
      },
      {
        "path": "packages/operator-core/lib/agent-tools/session/request-compaction-http.integration.test.ts",
        "sha256": "a46938cf6883f5affec56be3dde0a650aacf8fdef6ce8043a921ffd2c45b0477",
        "gitSha256": "a46938cf6883f5affec56be3dde0a650aacf8fdef6ce8043a921ffd2c45b0477"
      },
      {
        "path": "packages/operator-core/lib/agent-tools/session/request-compaction.ts",
        "sha256": "6b6575a01790d9015f15ecd55e2a059a5164c8df29442327e0d18f7d3ce44f50",
        "gitSha256": "6b6575a01790d9015f15ecd55e2a059a5164c8df29442327e0d18f7d3ce44f50"
      },
      {
        "path": "packages/operator-core/lib/carry-note.ts",
        "sha256": "20781919a4058dd5de4cd440d8ca9b0727b9b729579699d5e48d94ae71dce3a3",
        "gitSha256": "20781919a4058dd5de4cd440d8ca9b0727b9b729579699d5e48d94ae71dce3a3"
      },
      {
        "path": "packages/operator-core/lib/endpoint-route/routes/agent-mcp/run-tool.ts",
        "sha256": "8f0a9b2e44a550dcc4fda414f22f25bcbb8511089084c4b404a3e420a83133b2",
        "gitSha256": "8f0a9b2e44a550dcc4fda414f22f25bcbb8511089084c4b404a3e420a83133b2"
      },
      {
        "path": "packages/operator-core/lib/harness/routines/loop.ts",
        "sha256": "5feb1fc0f1302cf90580f0008827fbf25e983b87ebe596ab8945d19ac791be8d",
        "gitSha256": "5feb1fc0f1302cf90580f0008827fbf25e983b87ebe596ab8945d19ac791be8d"
      },
      {
        "path": "packages/operator-core/test/compaction-warm-http-scenario.ts",
        "sha256": "f6c80e8631d29261d2b8971397585a86f9787f46c349d9befd9c60ec62c6e283",
        "gitSha256": "f6c80e8631d29261d2b8971397585a86f9787f46c349d9befd9c60ec62c6e283"
      },
      {
        "path": "packages/operator-core/test/isolated-integration-proof.ts",
        "sha256": "a701fe53d46a1069a315031448ba4e5efa0178ce7eb65f94010f93503cdd1c6d",
        "gitSha256": "a701fe53d46a1069a315031448ba4e5efa0178ce7eb65f94010f93503cdd1c6d"
      },
      {
        "path": "packages/operator-core/test/staging-first-http-fixture.ts",
        "sha256": "2a6166d475081bac285e1910bba4619fecb571870a8f9587c21c7acbd68ada4e",
        "gitSha256": "2a6166d475081bac285e1910bba4619fecb571870a8f9587c21c7acbd68ada4e"
      },
      {
        "path": "scripts/lib/isolated-runtime-start.mjs",
        "sha256": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
        "gitSha256": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d"
      },
      {
        "path": "scripts/with-test-pg.mjs",
        "sha256": "c6d7b37763b90a10528e1b62869cd4b506de94083102fa6e6bf73725683e83f3",
        "gitSha256": "c6d7b37763b90a10528e1b62869cd4b506de94083102fa6e6bf73725683e83f3"
      },
      {
        "path": "scripts/lib/with-test-pg-cleanup.mjs",
        "sha256": "1abdb1dd0d923a74a4b17e17865f2def90ea1379ebe805c2a87fc45f1b4199ed",
        "gitSha256": "1abdb1dd0d923a74a4b17e17865f2def90ea1379ebe805c2a87fc45f1b4199ed"
      }
    ],
    "parentObserver": {
      "database": "org_12127eae2014",
      "flush": {
        "written": 0,
        "failed": 0,
        "dropped": 0,
        "rejected": 0
      }
    }
  },
  "lifecycle": {
    "schemaVersion": 1,
    "runId": "20261012T233246Z-12235",
    "host": "main-server-Precision-7865-Tower",
    "observedAt": "2026-10-12T23:33:29.229Z",
    "observer": {
      "pid": 12235,
      "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:63693187",
      "parentPid": 5001
    },
    "supervisor": {
      "pid": 32783,
      "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:63695184",
      "parentPid": 12235
    },
    "worker": {
      "pid": 62265,
      "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:63698238",
      "parentPid": 32783
    },
    "database": {
      "pid": 43417,
      "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:63695648",
      "parentPid": 32783
    },
    "argv": [
      "/home/marsh-office/.local/node25/bin/node",
      "--import",
      "/home/marsh-office/papercupai-workspace/papercusp/scripts/lib/isolated-runtime-start.mjs",
      "--import",
      "tsx",
      "/home/marsh-office/papercupai-workspace/papercusp/packages/operator-core/test/staging-first-http-fixture.ts"
    ],
    "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
    "workspace": "test-runtime-6a3a8a0d-894",
    "runtimeRoot": "/tmp/pcv/papercusp-test-runtime-SoNAJN",
    "dataDir": "/tmp/pcv/papercusp-test-pg-4URqKh",
    "pgPort": 36967,
    "ended": {
      "kind": "isolated-runtime-end",
      "childPid": 62265,
      "exitCode": 0,
      "signal": null,
      "runtimeRemoved": true,
      "pgDataRemoved": true,
      "observedAt": "2026-10-12T23:37:27.242Z"
    }
  },
  "workerResult": {
    "code": 0,
    "signal": null,
    "timedOut": false,
    "timeoutPhase": null,
    "exitWaitTimedOut": false,
    "stdioDrainTimedOut": false,
    "error": null
  },
  "limits": [
    "Private as-built request proof; not historical a9a7 recovery or whole-plan acceptance",
    "No production shipment or >=24h R14 anchor asserted"
  ],
  "falsifier": "Any retained no-host response changes carry/routine/note or queues a respawn; missing original cleanup or source hash drift invalidates this scoped proof."
}
