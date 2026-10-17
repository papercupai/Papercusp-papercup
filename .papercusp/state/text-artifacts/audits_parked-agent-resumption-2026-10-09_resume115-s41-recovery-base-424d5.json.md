---
rel_path: "audits/parked-agent-resumption-2026-10-09/resume115-s41-recovery-base-424d5.json"
updated_at: 1792168986378
_body: "content"
---

{
  "schemaVersion": "parked-s41-original-matrices-recovery-v1",
  "sourceNativeSession": "01a1453f-d18d-78c0-a162-da71c41d9622",
  "sourceNativePath": "/home/marsh-office/.papercusp/su-codex-homes/session-40770/sessions/2026/10/16/rollout-2026-10-16T11-06-12-01a1453f-d18d-78c0-a162-da71c41d9622.jsonl",
  "correction": "Original finished matrix completed before this continuation:21280110; the later21282244 was an unnecessary duplicate with default-model environment failures. Neither original results nor later errors are rejudged. Prior partial no-event archive683chars is superseded by this complete evidence bundle.",
  "ledger": {
    "count": 5,
    "total": 5,
    "truncatedByLimit": false,
    "latestPerFile": false,
    "effectiveSourceFilter": "none (exact testRunIds receipt lookup)",
    "omittedBySourceFilter": 0,
    "runs": [
      {
        "id": 21282244,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": null,
        "root": "/home/marsh-office/papercupai-workspace/papercusp",
        "executionDetails": {
          "root": "/home/marsh-office/papercupai-workspace/papercusp",
          "failed": 3,
          "passed": 0,
          "skipped": 0,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "commitSha": "e9f309520660140ccb2189c88ca3357aa412621e",
          "testLayer": "llm",
          "runGroupId": "d96a874d-651d-4549-81ab-2df19a4545c6",
          "scenarioId": "su-S41-scheduler-finished",
          "harnessSlug": null,
          "workspaceId": "papercusp-workspace",
          "mutationPhase": null,
          "schemaVersion": 1,
          "worktreeDirty": true,
          "testNamePattern": null,
          "collectionFailed": false,
          "runtimeEnvironmentAfter": {
            "units": [
              "llm-test-in-process-1456546"
            ],
            "observedAt": "2026-10-16T16:29:32.647Z",
            "fingerprint": "bf5dca8e20dec20a1c708fd5911cf85e93b8769f7a86b1eefb7fc34b60d0e73c",
            "schemaVersion": 1
          },
          "runtimeEnvironmentBefore": {
            "units": [
              "llm-test-in-process-1456546"
            ],
            "observedAt": "2026-10-16T16:29:26.329Z",
            "fingerprint": "bf5dca8e20dec20a1c708fd5911cf85e93b8769f7a86b1eefb7fc34b60d0e73c",
            "schemaVersion": 1
          },
          "runtimeEnvironmentAfterCaptureStatus": "captured",
          "runtimeEnvironmentBeforeCaptureStatus": "captured"
        },
        "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
        "status": "error",
        "framework": "llm-test",
        "startedAt": "2026-10-16T16:29:26.388Z",
        "finishedAt": "2026-10-16T16:29:30.373Z",
        "durationMs": 3985,
        "commitSha": "e9f309520660140ccb2189c88ca3357aa412621e",
        "runGroupId": "d96a874d-651d-4549-81ab-2df19a4545c6",
        "source": "local",
        "branch": "staging",
        "outputTail": "llm-test su-S41-scheduler-finished verdict=errored runs=3 passed=0 failed=0 errored=3; run1:request attempt=1; run1:response attempt=1 status=400; run2:request attempt=1; run2:response attempt=1 status=429; run3:request attempt=1; run3:response attempt=1 status=429",
        "loopLagP95Ms": null,
        "rssMb": null,
        "saturationSuspect": null,
        "worktreeDirty": true,
        "isScratchConfig": false
      },
      {
        "id": 21280110,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/home/marsh-office/papercupai-workspace/papercusp",
        "executionDetails": {
          "root": "/home/marsh-office/papercupai-workspace/papercusp",
          "failed": 0,
          "passed": 3,
          "skipped": 0,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "commitSha": "80da8e74f48a5c50a4dd5a0305461615183efdc3",
          "testLayer": "llm",
          "runGroupId": "e5e8864c-9f33-4565-a54e-03d620faa9fd",
          "scenarioId": "su-S41-scheduler-finished",
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "mutationPhase": null,
          "schemaVersion": 1,
          "worktreeDirty": true,
          "testNamePattern": null,
          "collectionFailed": false,
          "runtimeEnvironmentAfter": {
            "units": [
              "llm-test-in-process-1239335"
            ],
            "observedAt": "2026-10-16T15:21:45.080Z",
            "fingerprint": "20854ceec12b334d634d5645db444250cb16b0442e676f995982663858463764",
            "schemaVersion": 1
          },
          "runtimeEnvironmentBefore": {
            "units": [
              "llm-test-in-process-1239335"
            ],
            "observedAt": "2026-10-16T15:16:55.065Z",
            "fingerprint": "20854ceec12b334d634d5645db444250cb16b0442e676f995982663858463764",
            "schemaVersion": 1
          },
          "runtimeEnvironmentAfterCaptureStatus": "captured",
          "runtimeEnvironmentBeforeCaptureStatus": "captured"
        },
        "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
        "status": "pass",
        "framework": "llm-test",
        "startedAt": "2026-10-16T15:16:55.118Z",
        "finishedAt": "2026-10-16T15:21:31.384Z",
        "durationMs": 276266,
        "commitSha": "80da8e74f48a5c50a4dd5a0305461615183efdc3",
        "runGroupId": "e5e8864c-9f33-4565-a54e-03d620faa9fd",
        "source": "local",
        "branch": "staging",
        "outputTail": null,
        "loopLagP95Ms": null,
        "rssMb": null,
        "saturationSuspect": null,
        "worktreeDirty": true,
        "isScratchConfig": false
      },
      {
        "id": 21280019,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/home/marsh-office/papercupai-workspace/papercusp",
        "executionDetails": {
          "root": "/home/marsh-office/papercupai-workspace/papercusp",
          "failed": 0,
          "passed": 3,
          "skipped": 0,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "commitSha": "80da8e74f48a5c50a4dd5a0305461615183efdc3",
          "testLayer": "llm",
          "runGroupId": "4127fe23-286b-4757-94c6-cf38ab1031ca",
          "scenarioId": "su-S41-scheduler-no-event",
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "mutationPhase": null,
          "schemaVersion": 1,
          "worktreeDirty": true,
          "testNamePattern": null,
          "collectionFailed": false,
          "runtimeEnvironmentAfter": {
            "units": [
              "llm-test-in-process-116809"
            ],
            "observedAt": "2026-10-16T15:13:07.165Z",
            "fingerprint": "d8a45f35994f8537889c66d5d4286375e1cd29bef3a3dd1bc0a004248251ff3f",
            "schemaVersion": 1
          },
          "runtimeEnvironmentBefore": {
            "units": [
              "llm-test-in-process-116809"
            ],
            "observedAt": "2026-10-16T15:00:14.946Z",
            "fingerprint": "d8a45f35994f8537889c66d5d4286375e1cd29bef3a3dd1bc0a004248251ff3f",
            "schemaVersion": 1
          },
          "runtimeEnvironmentAfterCaptureStatus": "captured",
          "runtimeEnvironmentBeforeCaptureStatus": "captured"
        },
        "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
        "status": "pass",
        "framework": "llm-test",
        "startedAt": "2026-10-16T15:00:15.009Z",
        "finishedAt": "2026-10-16T15:12:26.864Z",
        "durationMs": 731855,
        "commitSha": "80da8e74f48a5c50a4dd5a0305461615183efdc3",
        "runGroupId": "4127fe23-286b-4757-94c6-cf38ab1031ca",
        "source": "local",
        "branch": "staging",
        "outputTail": null,
        "loopLagP95Ms": null,
        "rssMb": null,
        "saturationSuspect": null,
        "worktreeDirty": true,
        "isScratchConfig": false
      },
      {
        "id": 21279929,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/home/marsh-office/papercupai-workspace/papercusp",
        "executionDetails": {
          "root": "/home/marsh-office/papercupai-workspace/papercusp",
          "failed": 0,
          "passed": 3,
          "skipped": 0,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "commitSha": "25a4d821622e1af0a9bd4036aed076717e358fc9",
          "testLayer": "llm",
          "runGroupId": "a26a45c8-10c0-4bec-89c2-e250448277b7",
          "scenarioId": "su-S41-scheduler-blocked",
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "mutationPhase": null,
          "schemaVersion": 1,
          "worktreeDirty": true,
          "testNamePattern": null,
          "collectionFailed": false,
          "runtimeEnvironmentAfter": {
            "units": [
              "llm-test-in-process-3465138"
            ],
            "observedAt": "2026-10-16T14:56:34.105Z",
            "fingerprint": "75915293d070d630fba978efae04fd90e12388fe955d99d7c117b51734ec087b",
            "schemaVersion": 1
          },
          "runtimeEnvironmentBefore": {
            "units": [
              "llm-test-in-process-3465138"
            ],
            "observedAt": "2026-10-16T14:49:05.255Z",
            "fingerprint": "75915293d070d630fba978efae04fd90e12388fe955d99d7c117b51734ec087b",
            "schemaVersion": 1
          },
          "runtimeEnvironmentAfterCaptureStatus": "captured",
          "runtimeEnvironmentBeforeCaptureStatus": "captured"
        },
        "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
        "status": "pass",
        "framework": "llm-test",
        "startedAt": "2026-10-16T14:49:05.305Z",
        "finishedAt": "2026-10-16T14:56:02.813Z",
        "durationMs": 417508,
        "commitSha": "25a4d821622e1af0a9bd4036aed076717e358fc9",
        "runGroupId": "a26a45c8-10c0-4bec-89c2-e250448277b7",
        "source": "local",
        "branch": "staging",
        "outputTail": null,
        "loopLagP95Ms": null,
        "rssMb": null,
        "saturationSuspect": null,
        "worktreeDirty": true,
        "isScratchConfig": false
      },
      {
        "id": 21279750,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": "papercusp",
        "root": "/home/marsh-office/papercupai-workspace/papercusp",
        "executionDetails": {
          "root": "/home/marsh-office/papercupai-workspace/papercusp",
          "failed": 0,
          "passed": 3,
          "skipped": 0,
          "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
          "commitSha": "25a4d821622e1af0a9bd4036aed076717e358fc9",
          "testLayer": "llm",
          "runGroupId": "c9401ac4-7b16-4ff7-b35b-a98237b88a9e",
          "scenarioId": "su-S41-scheduler-independent",
          "harnessSlug": "papercusp",
          "workspaceId": "papercusp-workspace",
          "mutationPhase": null,
          "schemaVersion": 1,
          "worktreeDirty": true,
          "testNamePattern": null,
          "collectionFailed": false,
          "runtimeEnvironmentAfter": {
            "units": [
              "llm-test-in-process-2084781"
            ],
            "observedAt": "2026-10-16T14:38:14.028Z",
            "fingerprint": "ed4099835ba282fdcef0031b38d4eef94ebfd99d510c170be3e2d0a2012c9f42",
            "schemaVersion": 1
          },
          "runtimeEnvironmentBefore": {
            "units": [
              "llm-test-in-process-2084781"
            ],
            "observedAt": "2026-10-16T14:25:13.455Z",
            "fingerprint": "ed4099835ba282fdcef0031b38d4eef94ebfd99d510c170be3e2d0a2012c9f42",
            "schemaVersion": 1
          },
          "runtimeEnvironmentAfterCaptureStatus": "captured",
          "runtimeEnvironmentBeforeCaptureStatus": "captured"
        },
        "filePath": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
        "status": "pass",
        "framework": "llm-test",
        "startedAt": "2026-10-16T14:25:13.600Z",
        "finishedAt": "2026-10-16T14:37:35.945Z",
        "durationMs": 742345,
        "commitSha": "25a4d821622e1af0a9bd4036aed076717e358fc9",
        "runGroupId": "c9401ac4-7b16-4ff7-b35b-a98237b88a9e",
        "source": "local",
        "branch": "staging",
        "outputTail": null,
        "loopLagP95Ms": null,
        "rssMb": null,
        "saturationSuspect": null,
        "worktreeDirty": true,
        "isScratchConfig": false
      }
    ]
  },
  "byteCustody": {
    "head": "588a21ccb67fbecb64630a265cd3fa2d3d7143d5",
    "branch": "staging",
    "files": [
      {
        "path": "packages/operator-core/lib/llm-testing/telemetry.ts",
        "workingSha256": "5cd39122ea10a046342d3a46f9fe912725cdc0928d82938b85a66668030b2c2a",
        "committedSha256": "5cd39122ea10a046342d3a46f9fe912725cdc0928d82938b85a66668030b2c2a",
        "same": true,
        "lastCommit": "b6aae68230471be3ca2513afb8629cff1bf6c5c1"
      },
      {
        "path": "packages/operator-core/lib/llm-testing/telemetry.test.ts",
        "workingSha256": "05e848214fa55ff1d8abda6172d8d54e05177f9db0f8f71f95692148316fbf44",
        "committedSha256": "05e848214fa55ff1d8abda6172d8d54e05177f9db0f8f71f95692148316fbf44",
        "same": true,
        "lastCommit": "b6aae68230471be3ca2513afb8629cff1bf6c5c1"
      },
      {
        "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.ts",
        "workingSha256": "c9a73e05d491a952c025fdf6c7f620c1a29dbfa843442d4d2b31acc8d2446809",
        "committedSha256": "90af3386a100029b1e9dbef7582de4043d54e00be829e7e33f1715c01e1706fa",
        "same": false,
        "lastCommit": "1471729391b8f0602403ce7036d70ac976e5c985"
      },
      {
        "path": "packages/operator-core/lib/llm-testing/scenarios/su/S41-scheduler-retained-obligations.test.ts",
        "workingSha256": "1771bad6c42f5f0ec5670a28b4a915a90a6f1dcb388aaeaafe3a91957fa5cdb1",
        "committedSha256": "e3832dabd85c7d249356aa1d16af77a223472ee4d3848e6b07d6117be53178b5",
        "same": false,
        "lastCommit": "1471729391b8f0602403ce7036d70ac976e5c985"
      }
    ]
  },
  "gitSync": {
    "ok": true,
    "fired": true,
    "slug": "papercusp",
    "status": "skipped",
    "success": false,
    "committed": false,
    "head_before": "588a21ccb67fbecb64630a265cd3fa2d3d7143d5",
    "head_after": "588a21ccb67fbecb64630a265cd3fa2d3d7143d5",
    "outcome": {
      "status": "skipped",
      "reason": "exclusive_pending",
      "blockedOn": "git-sync",
      "holders": [
        {
          "owner": "system:dev-restart:git-sync-barrier:484014:52ef6508-e794-4562-a468-9ac8f830e8b9",
          "owner_label": "su \u00b7 su-94ce9",
          "mode": "exclusive",
          "status": "held",
          "lock_id": "564a32e9-d6c7-4259-99d9-1d3165abc861",
          "reason": "dev:restart git-sync kill barrier (WI-222053)",
          "acquired_ts": "2026-10-16T16:39:40.976Z",
          "expires_ts": "2026-10-16T16:41:27.058Z",
          "fence_seq": 29767
        }
      ]
    },
    "continuation": {
      "completion_event": {
        "key": "git-sync:lock-retry",
        "payload_fields": [
          "installSlug",
          "workspaceId",
          "resource",
          "reason",
          "holders"
        ]
      },
      "await_tool": "events:await",
      "progress_ref": {
        "surface": "locks:list",
        "tool": "locks:list",
        "args": {
          "resource": "git-sync"
        },
        "workspace_id": "papercusp-workspace",
        "install_slug": "papercusp",
        "resource": "git-sync",
        "fields": [
          "resources[].holders",
          "resources[].held",
          "holders",
          "draining"
        ]
      }
    },
    "note": "git-sync completed with status skipped (exclusive_pending); await git-sync:lock-retry for the next lock-retry signal and inspect continuation.progress_ref for live holder state."
  },
  "logs": {
    "/tmp/parked-resume113-s41-matrix-independent.log": "\n> @papercusp/web@0.0.1 llm-test\n> tsx bin/llm-test.ts --scenario su-S41-scheduler-independent\n\n[db] target source=operator-env-file endpoint=localhost:5432\n[flags] No override store installed in this process: runtime overrides (flags:set / POST /api/flags/set) are INVISIBLE here and getFlag() is serving FLAG_DEFAULTS. If this process is expected to observe runtime flag flips, call initFlagOverrideStore() during boot BEFORE any flag is resolved (operator-core: installFlagOverrideStore()). Silence with PAPERCUSP_SILENCE_FLAG_OVERRIDE_WARN=1 if defaults-only is intentional.\n[llm-test] inference-gateway ON \u2192 routing LLM calls through http://127.0.0.1:8788\nVH_RETENTION_DEFERRED stage=before reason=retention-mutex-busy evidence=/home/marsh-office/.local/state/verification-harness/llm-scenario-battery\n\n\u25b6 su-S41-scheduler-independent  [su]\n  \u2713 verdict=pass (3 runs)\n     run #1 status=passed cost=$0.0011 turns=1\n     run #2 status=passed cost=$0.0016 turns=2\n       judge:   0 error / 2 warn\n     run #3 status=passed cost=$0.0012 turns=2\n       judge:   0 error / 1 warn\n  ledger test_runs.id=21279750 layer=llm\nVH_PRUNED_RUNS removed=20261016T134117Z-4000466,20261016T141412Z-1428714 disk=unresolved free_before_bytes=14091792384 reserve_bytes=40279831019.520004 free_after_bytes=14090539008\n\nHARNESS_RESULT harness=llm-scenario-battery verdict=pass run=20261016T142512Z-2084781 first_failure=none passed=1 failed=0 blocked=0 skipped=0 reused=0 evidence=/home/marsh-office/.local/state/verification-harness/llm-scenario-battery/20261016T142512Z-2084781\n",
    "/tmp/parked-resume114-s41-matrix-blocked.log": "\n> @papercusp/web@0.0.1 llm-test\n> tsx bin/llm-test.ts --scenario su-S41-scheduler-blocked\n\n[db] target source=operator-env-file endpoint=localhost:5432\n[flags] No override store installed in this process: runtime overrides (flags:set / POST /api/flags/set) are INVISIBLE here and getFlag() is serving FLAG_DEFAULTS. If this process is expected to observe runtime flag flips, call initFlagOverrideStore() during boot BEFORE any flag is resolved (operator-core: installFlagOverrideStore()). Silence with PAPERCUSP_SILENCE_FLAG_OVERRIDE_WARN=1 if defaults-only is intentional.\n[llm-test] inference-gateway ON \u2192 routing LLM calls through http://127.0.0.1:8788\nVH_PRUNED_RUNS removed=- disk=unresolved free_before_bytes=10475724800 reserve_bytes=40279831019.520004 free_after_bytes=10475724800\n\n\u25b6 su-S41-scheduler-blocked  [su]\n  \u2713 verdict=pass (3 runs)\n     run #1 status=passed cost=$0.0010 turns=2\n     run #2 status=passed cost=$0.0007 turns=1\n     run #3 status=passed cost=$0.0010 turns=2\n  ledger test_runs.id=21279929 layer=llm\nVH_PRUNED_RUNS removed=20261016T142512Z-2084781 disk=unresolved free_before_bytes=14991929344 reserve_bytes=40279831019.520004 free_after_bytes=14991949824\n\nHARNESS_RESULT harness=llm-scenario-battery verdict=pass run=20261016T144900Z-3465138 first_failure=none passed=1 failed=0 blocked=0 skipped=0 reused=0 evidence=/home/marsh-office/.local/state/verification-harness/llm-scenario-battery/20261016T144900Z-3465138\n",
    "/tmp/parked-resume114-s41-matrix-no-event.log": "\n> @papercusp/web@0.0.1 llm-test\n> tsx bin/llm-test.ts --scenario su-S41-scheduler-no-event\n\n[db] target source=operator-env-file endpoint=localhost:5432\n[flags] No override store installed in this process: runtime overrides (flags:set / POST /api/flags/set) are INVISIBLE here and getFlag() is serving FLAG_DEFAULTS. If this process is expected to observe runtime flag flips, call initFlagOverrideStore() during boot BEFORE any flag is resolved (operator-core: installFlagOverrideStore()). Silence with PAPERCUSP_SILENCE_FLAG_OVERRIDE_WARN=1 if defaults-only is intentional.\n[llm-test] inference-gateway ON \u2192 routing LLM calls through http://127.0.0.1:8788\nVH_PRUNED_RUNS removed=- disk=unresolved free_before_bytes=13275308032 reserve_bytes=40279831019.520004 free_after_bytes=13275308032\n\n\u25b6 su-S41-scheduler-no-event  [su]\n  \u2713 verdict=pass (3 runs)\n     run #1 status=passed cost=$0.0012 turns=1\n       judge:   0 error / 1 warn\n     run #2 status=passed cost=$0.0014 turns=2\n     run #3 status=passed cost=$0.0010 turns=2\n       judge:   0 error / 1 warn\n  ledger test_runs.id=21280019 layer=llm\nVH_PRUNED_RUNS removed=20261016T144900Z-3465138 disk=unresolved free_before_bytes=9275232256 reserve_bytes=40279831019.520004 free_after_bytes=9275252736\n\nHARNESS_RESULT harness=llm-scenario-battery verdict=pass run=20261016T150013Z-116809 first_failure=none passed=1 failed=0 blocked=0 skipped=0 reused=0 evidence=/home/marsh-office/.local/state/verification-harness/llm-scenario-battery/20261016T150013Z-116809\n",
    "/tmp/parked-resume114-s41-matrix-finished-20261016.log": "\n> @papercusp/web@0.0.1 llm-test\n> tsx bin/llm-test.ts --scenario su-S41-scheduler-finished\n\n[db] target source=operator-env-file endpoint=localhost:5432\n[flags] No override store installed in this process: runtime overrides (flags:set / POST /api/flags/set) are INVISIBLE here and getFlag() is serving FLAG_DEFAULTS. If this process is expected to observe runtime flag flips, call initFlagOverrideStore() during boot BEFORE any flag is resolved (operator-core: installFlagOverrideStore()). Silence with PAPERCUSP_SILENCE_FLAG_OVERRIDE_WARN=1 if defaults-only is intentional.\n[llm-test] inference-gateway ON \u2192 routing LLM calls through http://127.0.0.1:8788\nVH_PRUNED_RUNS removed=- disk=unresolved free_before_bytes=22875250688 reserve_bytes=40279831019.520004 free_after_bytes=22875250688\n\n\u25b6 su-S41-scheduler-finished  [su]\n[llm-testing] SUT model === judge model (claude-sonnet-4-6). Plan \u00a76.3 recommends they differ to avoid self-grading bias.\n  ! verdict=errored (3 runs)\n     run #1 status=errored cost=$0.0000 turns=1\n       asserts: 2 error / 0 warn\n       judge:   1 error / 0 warn\n         \u2717 [custom:scheduler-obligations:must-read-scheduler-and-held-work] Scheduler miss finished: must-read-scheduler-and-held-work\n         \u2717 [custom:scheduler-obligations:finished-control-must-stop] Scheduler miss finished: finished-control-must-stop\n         \u2717 judge[meta]: Run is inconclusive \u2014 the system under test produced no usable output (SUT turn ended in error: model call failed: 400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",\"message\":\"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.\"},\"request_id\":\"req_011Cg6EU6kAb5F6guAkbb11v\"}). This is an environment/SUT-health failure, not an operator behavioral finding.\n     run #2 status=errored cost=$0.0000 turns=1\n       asserts: 2 error / 0 warn\n       judge:   1 error / 0 warn\n         \u2717 [custom:scheduler-obligations:must-read-scheduler-and-held-work] Scheduler miss finished: must-read-scheduler-and-held-work\n         \u2717 [custom:scheduler-obligations:finished-control-must-stop] Scheduler miss finished: finished-control-must-stop\n         \u2717 judge[meta]: Run is inconclusive \u2014 the system under test produced no usable output (SUT turn ended in error: model call failed: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"This request would exceed your account's rate limit. Please try again later.\"},\"request_id\":\"req_011Cg6EUF8SBAdYMLbxCzXt1\"}). This is an environment/SUT-health failure, not an operator behavioral finding.\n     run #3 status=errored cost=$0.0000 turns=1\n       asserts: 2 error / 0 warn\n       judge:   1 error / 0 warn\n         \u2717 [custom:scheduler-obligations:must-read-scheduler-and-held-work] Scheduler miss finished: must-read-scheduler-and-held-work\n         \u2717 [custom:scheduler-obligations:finished-control-must-stop] Scheduler miss finished: finished-control-must-stop\n         \u2717 judge[meta]: Run is inconclusive \u2014 the system under test produced no usable output (SUT turn ended in error: model call failed: 429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"This request would exceed your account's rate limit. Please try again later.\"},\"request_id\":\"req_011Cg6EUHkT81zuP8gbhMSPn\"}). This is an environment/SUT-health failure, not an operator behavioral finding.\n  ledger test_runs.id=21282244 layer=llm\nVH_PRUNED_RUNS removed=20261016T151653Z-1239335 disk=unresolved free_before_bytes=23170711552 reserve_bytes=40279831019.520004 free_after_bytes=23170723840\nVH_PRUNED_FOREIGN removed=public-manual-host-f9942bed-2b42-4faa-be72-5612837f6bff,public-manual-host-641209a7-dce4-4e73-8c54-04be51507bfd,public-manual-host-95f10bc2-2ed9-4a74-838b-1e2a23c3444c,public-manual-host-d4c9ea1b-ed42-4436-addf-5bcf2c2450c6,public-manual-host-2e40ccf4-4718-4bbc-b6f4-c1e0b8055069,public-manual-host-1d2e3c00-c623-42bd-b6db-4a3ff621de47,public-manual-host-c31db766-77c2-48e6-8748-154a24d51fdb,public-manual-host-cb4f0f43-1620-4ee1-a1cf-c1e1f416d265,public-manual-host-015d6814-aad2-4bec-b2ab-d56c67e45054 unjudged=-\n\nHARNESS_RESULT harness=llm-scenario-battery verdict=fail run=20261016T162924Z-1456546 first_failure=su-S41-scheduler-finished/run-scenario/scenario-failed passed=0 failed=1 blocked=0 skipped=0 reused=0 evidence=/home/marsh-office/.local/state/verification-harness/llm-scenario-battery/20261016T162924Z-1456546\n"
  },
  "originalFinishedNativeEvidence": [
    {
      "timestamp": "2026-10-16T15:16:41.483Z",
      "ordinal": 246,
      "type": "response_item",
      "payload": {
        "type": "custom_tool_call",
        "id": "ctc_0051d6249551fd05016ad23fd464d08194ae2142fdc6c7841e",
        "status": "completed",
        "call_id": "call_ea793b332fc543719875a053318cf505",
        "name": "exec",
        "input": "const r=await tools.exec_command({cmd:\"ls -l /tmp/parked-resume114-s41-matrix-finished-20261016.log; stat -c '%s %y' /tmp/parked-resume114-s41-matrix-finished-20261016.log; ps -ef | rg 's41-scheduler-finished|1187131' || true; env LLM_TEST_SUT_MODEL='gpt-6.1-sol:xhigh' LLM_TEST_JUDGE_MODEL='gpt-6-luna' LLM_TEST_SIM_MODEL='gpt-6-luna' PAPERCUSP_TEST_RUN_HARNESS='papercusp' HARNESS_SLUG='papercusp' PAPERCUSP_HARNESS_SLUG='papercusp' npm --prefix apps/operator run llm-test -- --scenario su-S41-scheduler-finished\",yield_time_ms:30000,max_output_tokens:5000});text(r);\n",
        "internal_chat_message_metadata_passthrough": {
          "turn_id": "01a14540-c76b-7a72-a1c5-d45a837012ca",
          "create_time": 1792163796.395032
        }
      }
    },
    {
      "timestamp": "2026-10-16T15:21:49.325Z",
      "ordinal": 292,
      "type": "response_item",
      "payload": {
        "type": "custom_tool_call_output",
        "id": "ctco_01a1454e-1c0b-7ea3-aaae-c0c925f8c6d3",
        "call_id": "call_9a262da23a9248d687422fe73cfecbb2",
        "output": [
          {
            "type": "input_text",
            "text": "Script completed\nWall time 18.1 seconds\nOutput:\n"
          },
          {
            "type": "input_text",
            "text": "{\"chunk_id\":\"c98785\",\"wall_time_seconds\":15.944450736,\"exit_code\":0,\"original_token_count\":156,\"output\":\"  \u2713 verdict=pass (3 runs)\\n     run #1 status=passed cost=$0.0006 turns=1\\n     run #2 status=passed cost=$0.0010 turns=1\\n     run #3 status=passed cost=$0.0006 turns=1\\n  ledger test_runs.id=21280110 layer=llm\\nVH_PRUNED_RUNS removed=20261016T150013Z-116809 disk=unresolved free_before_bytes=9773228032 reserve_bytes=40279831019.520004 free_after_bytes=9773219840\\n\\nHARNESS_RESULT harness=llm-scenario-battery verdict=pass run=20261016T151653Z-1239335 first_failure=none passed=1 failed=0 blocked=0 skipped=0 reused=0 evidence=/home/marsh-office/.local/state/verification-harness/llm-scenario-battery/20261016T151653Z-1239335\\n\"}"
          }
        ],
        "internal_chat_message_metadata_passthrough": {
          "turn_id": "01a14540-c76b-7a72-a1c5-d45a837012ca",
          "create_time": 1792164109.3236005
        }
      },
      "metadata": {
        "client_authored": false,
        "fallback_token_limit_override": 12000
      }
    }
  ]
}
