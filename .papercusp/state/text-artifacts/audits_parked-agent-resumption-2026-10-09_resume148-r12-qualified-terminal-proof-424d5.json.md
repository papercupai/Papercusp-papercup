---
rel_path: "audits/parked-agent-resumption-2026-10-09/resume148-r12-qualified-terminal-proof-424d5.json"
updated_at: 1792256056140
_body: "content"
---

{
  "schemaVersion": "parked-r12-qualified-terminal-proof-v1",
  "at": "2026-10-17T16:54:15.561726+00:00",
  "parent": "WI-6554700010008887",
  "incident": "EI-26115908945347053",
  "incidentTerminalReceipt": "work_items:complete appliedState done/completionAuthority committed at 2026-10-17T16:51:55Z (read authoritative item for exact timestamp)",
  "runId": "20261017T163313Z-158407",
  "testLedger": {
    "count": 1,
    "total": 1,
    "truncatedByLimit": false,
    "latestPerFile": false,
    "effectiveSourceFilter": "source <> 'mutation-probe' (default row-list exclusion)",
    "omittedBySourceFilter": 0,
    "runs": [
      {
        "id": 21342411,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": null,
        "root": "/mnt/data/tmp/verifier-command-tPDHWj/invoked-source",
        "executionDetails": {
          "root": "/mnt/data/tmp/verifier-command-tPDHWj/invoked-source",
          "failed": 0,
          "passed": 1,
          "skipped": 3,
          "filePath": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
          "commitSha": "105c2763aec788a3a8fe1ef95bc1424aed0ca57b",
          "testLayer": "e2e",
          "runGroupId": null,
          "harnessSlug": null,
          "workspaceId": "papercusp-workspace",
          "runStartedAt": "2026-10-17T16:32:51.414Z",
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
              "runId": "20261017T163313Z-158407",
              "resultSha256": "d9282e9c314526214030a1e680d686182dc9b8cfd846dd210e33496ed0fd8fa2",
              "sourceSha256": "6e249ead105046c9b0307ec2a8a424e4a888e72f973f33d928ae46f7973c332b",
              "lifecycleSha256": "fc2c88bd1e75c2c64b5fdc0cdd5e4b42ed5ab49c8e37be19bb65e1b0eba03816"
            }
          ],
          "runtimeEnvironmentAfterCaptureStatus": "not-configured",
          "runtimeEnvironmentBeforeCaptureStatus": "not-configured"
        },
        "filePath": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
        "status": "pass",
        "framework": "vitest",
        "startedAt": "2026-10-17T16:32:59.514Z",
        "finishedAt": "2026-10-17T16:37:17.686Z",
        "durationMs": 258172,
        "commitSha": "105c2763aec788a3a8fe1ef95bc1424aed0ca57b",
        "runGroupId": null,
        "source": "local",
        "branch": null,
        "outputTail": null,
        "loopLagP95Ms": 42.3,
        "rssMb": 236.3,
        "saturationSuspect": false,
        "worktreeDirty": false,
        "isScratchConfig": false
      }
    ]
  },
  "receiptFiles": {
    "result.json": {
      "path": "/mnt/data/offload/verification-harness/isolated-integration/20261017T163313Z-158407/result.json",
      "sha256": "d9282e9c314526214030a1e680d686182dc9b8cfd846dd210e33496ed0fd8fa2",
      "content": {
        "schemaVersion": 1,
        "harness": "isolated-integration",
        "runId": "20261017T163313Z-158407",
        "evidenceDir": "/mnt/data/offload/verification-harness/isolated-integration/20261017T163313Z-158407",
        "selection": {
          "only": null,
          "from": null
        },
        "reuseFromRunId": null,
        "preflight": null,
        "phases": [
          {
            "phase": "prepare",
            "evidenceDir": "/mnt/data/offload/verification-harness/isolated-integration/20261017T163313Z-158407/phases/prepare",
            "startedAt": "2026-10-17T16:33:13.750Z",
            "endedAt": "2026-10-17T16:33:17.780Z",
            "elapsedMs": 4030,
            "status": "passed",
            "step": null,
            "reasonCode": null
          },
          {
            "phase": "execute",
            "evidenceDir": "/mnt/data/offload/verification-harness/isolated-integration/20261017T163313Z-158407/phases/execute",
            "startedAt": "2026-10-17T16:33:17.782Z",
            "endedAt": "2026-10-17T16:37:05.014Z",
            "elapsedMs": 227232,
            "status": "passed",
            "step": null,
            "reasonCode": null
          },
          {
            "phase": "teardown",
            "evidenceDir": "/mnt/data/offload/verification-harness/isolated-integration/20261017T163313Z-158407/phases/teardown",
            "startedAt": "2026-10-17T16:37:05.017Z",
            "endedAt": "2026-10-17T16:37:05.018Z",
            "elapsedMs": 1,
            "status": "passed",
            "step": null,
            "reasonCode": null
          }
        ],
        "verdict": "pass",
        "firstFailure": null,
        "startedAt": "2026-10-17T16:33:13.747Z",
        "endedAt": "2026-10-17T16:37:05.043Z"
      }
    },
    "phases/prepare/source.json": {
      "path": "/mnt/data/offload/verification-harness/isolated-integration/20261017T163313Z-158407/phases/prepare/source.json",
      "sha256": "6e249ead105046c9b0307ec2a8a424e4a888e72f973f33d928ae46f7973c332b",
      "content": {
        "schemaVersion": 1,
        "runId": "20261017T163313Z-158407",
        "sourceCommit": "105c2763aec788a3a8fe1ef95bc1424aed0ca57b",
        "repoRoot": "/mnt/data/tmp/verifier-command-tPDHWj/invoked-source",
        "filePath": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
        "runGroupId": null,
        "workspaceId": "papercusp-workspace",
        "harnessSlug": null,
        "files": [
          {
            "path": "apps/operator/bin/bundle-host.sh",
            "sha256": "74d86d257daef185dcc7c1ce2168a5d1e1dd8bad264da3eca9bc86ac163913f3",
            "gitSha256": "74d86d257daef185dcc7c1ce2168a5d1e1dd8bad264da3eca9bc86ac163913f3"
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
            "sha256": "2a60a995e89c754fedeab43b1ae3ecfd01a58ff729343efb78b32a8a0ed25ade",
            "gitSha256": "2a60a995e89c754fedeab43b1ae3ecfd01a58ff729343efb78b32a8a0ed25ade"
          },
          {
            "path": "packages/operator-core/test/isolated-integration-proof.ts",
            "sha256": "8cca54d7e0c9b363078fce8303cf11a08059c33e9bcea7cc45dba7b64011801d",
            "gitSha256": "8cca54d7e0c9b363078fce8303cf11a08059c33e9bcea7cc45dba7b64011801d"
          },
          {
            "path": "packages/operator-core/test/liveness-alarm-http-fixture.ts",
            "sha256": "33d7530f66c2e458767fba7ddf6bbd13019f7906bfec71866e693fe093064a9d",
            "gitSha256": "33d7530f66c2e458767fba7ddf6bbd13019f7906bfec71866e693fe093064a9d"
          },
          {
            "path": "packages/operator-core/test/private-http-workspace-preflight.ts",
            "sha256": "1ad346261702d8b1620cd7482f9fa3131f43d4558a7218029bcc104159f25ff3",
            "gitSha256": "1ad346261702d8b1620cd7482f9fa3131f43d4558a7218029bcc104159f25ff3"
          },
          {
            "path": "scripts/lib/isolated-runtime-start.mjs",
            "sha256": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
            "gitSha256": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d"
          },
          {
            "path": "scripts/with-test-pg.mjs",
            "sha256": "febeb6714cb293135f2d08cb0a1b9a24314e07c37605c7fbeb76cae3b431cc2b",
            "gitSha256": "febeb6714cb293135f2d08cb0a1b9a24314e07c37605c7fbeb76cae3b431cc2b"
          },
          {
            "path": "scripts/lib/with-test-pg-cleanup.mjs",
            "sha256": "37effd76e07e992646bd8192b93ead3ee7e865712de89d9eb733bdc1a8713b61",
            "gitSha256": "37effd76e07e992646bd8192b93ead3ee7e865712de89d9eb733bdc1a8713b61"
          }
        ],
        "parentObserver": {
          "database": "org_8b6312c4f2c6",
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
      "path": "/mnt/data/offload/verification-harness/isolated-integration/20261017T163313Z-158407/phases/execute/lifecycle.json",
      "sha256": "fc2c88bd1e75c2c64b5fdc0cdd5e4b42ed5ab49c8e37be19bb65e1b0eba03816",
      "content": {
        "schemaVersion": 1,
        "runId": "20261017T163313Z-158407",
        "host": "main-server-Precision-7865-Tower",
        "observedAt": "2026-10-17T16:33:39.726Z",
        "observer": {
          "pid": 158407,
          "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:104374499",
          "parentPid": 156255
        },
        "supervisor": {
          "pid": 183428,
          "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:104377127",
          "parentPid": 158407
        },
        "worker": {
          "pid": 201254,
          "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:104379317",
          "parentPid": 183428
        },
        "database": {
          "pid": 186172,
          "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:104377411",
          "parentPid": 183428
        },
        "argv": [
          "/home/marsh-office/.local/node25/bin/node",
          "--import",
          "/mnt/data/tmp/verifier-command-tPDHWj/invoked-source/scripts/lib/isolated-runtime-start.mjs",
          "--import",
          "tsx",
          "/mnt/data/tmp/verifier-command-tPDHWj/invoked-source/packages/operator-core/test/liveness-alarm-http-fixture.ts"
        ],
        "cwd": "/mnt/data/tmp/verifier-command-tPDHWj/invoked-source",
        "workspace": "test-runtime-92b43e1d-d2c",
        "runtimeRoot": "/tmp/pcv/papercusp-test-runtime-G5mQMQ",
        "dataDir": "/tmp/pcv/papercusp-test-pg-SrMlPF",
        "pgPort": 33783,
        "ended": {
          "kind": "isolated-runtime-end",
          "childPid": 201254,
          "exitCode": 0,
          "signal": null,
          "runtimeRemoved": true,
          "pgDataRemoved": true,
          "observedAt": "2026-10-17T16:37:04.795Z"
        }
      }
    }
  },
  "privateBehaviorReceipt": {
    "workspace": "test-runtime-92b43e1d-d2c",
    "hostStopped": true,
    "signal": "agents-wedged",
    "threshold": 10,
    "belowThreshold": 9,
    "alarmCount": 1,
    "restartDedupCount": 1,
    "unknownPreserved": true,
    "sourceUnchanged": true,
    "sourceFingerprints": {
      "packages/operator-core/lib/system-health/liveness-alarm.ts": "9941ccb7143b39250a4decc4ef5df0d1ff0ed60b67959f017aab61483a276e54",
      "packages/operator-core/lib/system-health/agent-strand-census.ts": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284",
      "packages/operator-core/lib/system-health/compute.ts": "caabb259b0a63fc5cb522c926ee52ed8f39185a07cf6c9e332db9ed68c031d75",
      "packages/operator-core/lib/derived-reads/shared-snapshot.ts": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826",
      "packages/operator-core/lib/agent-tools/coordination/escalations.ts": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52",
      "packages/operator-core/lib/workspace-host/observability-store.ts": "2a60a995e89c754fedeab43b1ae3ecfd01a58ff729343efb78b32a8a0ed25ade",
      "packages/operator-core/lib/severe-event-owner.ts": "2c59fb583ed0e16abffb543fcf00f2099d2b524786dc456dac78f79648e5cbb2",
      "apps/operator/bin/hono-host.ts": "e530cb599658689b7eaabeb2f3c55fd84b8151a1ae9a22e9489d99954a703580"
    },
    "bundleSha256": "927c7d0042f282025c0552312b92a3857a886d0975f10022e957f9805c3fa59f",
    "intervalMs": 500,
    "first": {
      "pid": 343908,
      "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:104396953",
      "health": {
        "ok": true,
        "service": "papercusp-operator",
        "sha": "105c2763aec7",
        "version": "0.0.1",
        "claimSpec": {
          "specVersion": "1.0",
          "revisionAdoption": [
            "first"
          ]
        },
        "ts": "2026-10-17T16:36:43.921Z"
      }
    },
    "second": {
      "pid": 351498,
      "identity": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:104398124",
      "health": {
        "ok": true,
        "service": "papercusp-operator",
        "sha": "105c2763aec7",
        "version": "0.0.1",
        "claimSpec": {
          "specVersion": "1.0",
          "revisionAdoption": [
            "first"
          ]
        },
        "ts": "2026-10-17T16:36:56.595Z"
      }
    },
    "raised": {
      "to": [
        "human"
      ],
      "ts": "2026-10-17T16:36:44.449Z",
      "body": "Detected by the request-path infra-liveness alarm (R4-3/R4-8) — it runs on a request worker, independent of the background routine engine, so it fires even when that engine is frozen (the failure that blinds the in-engine watchdog). Signal: agents-wedged. Workspace: test-runtime-92b43e1d-d2c.",
      "from": "system:infra-liveness-alarm",
      "kind": "escalation",
      "msg_id": "mvcmcs2t-0000-26a271320faf454098d94956e7efa67a",
      "summary": "[infra-liveness] 10 agent session(s) cannot take a turn (quota-blocked 10; threshold 10) — wakes to them land and nothing happens. coord:presence reports each as suspect with its wedged class; a single class at this scale is one shared cause (a quota-walled account, a dead credential, a launcher fault). e.g. ",
      "resolved": null,
      "severity": "blocker",
      "dedupKind": "infra-liveness",
      "lastSeenTs": "2026-10-17T16:36:44.449Z",
      "repeatCount": 1,
      "needsHumanRoute": true,
      "subjectSignature": "agents-wedged",
      "livenessSignature": "agents-wedged",
      "agentStrandObservation": {
        "wedged": 10,
        "runtime": {
          "pid": 343908,
          "sha": "105c2763aec7",
          "version": "0.0.1"
        },
        "stranded": 0,
        "thresholds": {
          "wedged": 10,
          "stranded": 5
        },
        "observedAtMs": 1792255004279,
        "snapshotAtMs": 1792254996000,
        "wedgedByClass": {
          "auth-blocked": 0,
          "quota-blocked": 10,
          "unbound-successor": 0,
          "pending-turn-stuck": 0
        }
      }
    },
    "recovered": {
      "by": "system:infra-liveness-alarm",
      "to": [
        "system:infra-liveness-alarm"
      ],
      "ts": "2026-10-17T16:37:00.738Z",
      "from": "system:infra-liveness-alarm",
      "kind": "escalation_resolved",
      "note": "infra-liveness signal 'agents-wedged' cleared (condition recovered) — observed coordination agentStrand wedged=9 (quota-blocked 9; alarm threshold >= 10)",
      "choice": "auto-resolved",
      "msg_id": "res-mvcmcs2t-0000-26a271320faf454098d94956e7efa67a",
      "summary": "resolved: auto-resolved",
      "generation": 0,
      "related_msg_id": "mvcmcs2t-0000-26a271320faf454098d94956e7efa67a"
    }
  },
  "cleanupRecheck": {
    "runtimeRoot": {
      "path": "/tmp/pcv/papercusp-test-runtime-G5mQMQ",
      "existsNow": false
    },
    "dataDir": {
      "path": "/tmp/pcv/papercusp-test-pg-SrMlPF",
      "existsNow": false
    }
  },
  "processIdentityRecheck": {
    "supervisor": {
      "pid": 183428,
      "recorded": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:104377127",
      "now": null
    },
    "worker": {
      "pid": 201254,
      "recorded": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:104379317",
      "now": null
    },
    "database": {
      "pid": 186172,
      "recorded": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:104377411",
      "now": null
    }
  },
  "currentSourceComparison": [
    {
      "path": "apps/operator/bin/bundle-host.sh",
      "proofSha256": "74d86d257daef185dcc7c1ce2168a5d1e1dd8bad264da3eca9bc86ac163913f3",
      "proofGitSha256": "74d86d257daef185dcc7c1ce2168a5d1e1dd8bad264da3eca9bc86ac163913f3",
      "workingSha256Now": "74d86d257daef185dcc7c1ce2168a5d1e1dd8bad264da3eca9bc86ac163913f3",
      "workingEqualsProofNow": true
    },
    {
      "path": "apps/operator/bin/hono-host.ts",
      "proofSha256": "e530cb599658689b7eaabeb2f3c55fd84b8151a1ae9a22e9489d99954a703580",
      "proofGitSha256": "e530cb599658689b7eaabeb2f3c55fd84b8151a1ae9a22e9489d99954a703580",
      "workingSha256Now": "e530cb599658689b7eaabeb2f3c55fd84b8151a1ae9a22e9489d99954a703580",
      "workingEqualsProofNow": true
    },
    {
      "path": "packages/operator-core/lib/agent-tools/coordination/escalations.ts",
      "proofSha256": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52",
      "proofGitSha256": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52",
      "workingSha256Now": "2ce6c37f1b9fb80b74402c6f77feca45a5dc49b97c370daed70796386b54bf52",
      "workingEqualsProofNow": true
    },
    {
      "path": "packages/operator-core/lib/build-info.ts",
      "proofSha256": "6d271f5721a0d47c68fa8f42996a34f7b48fe4c06e414285a3f7fe36bdc44a50",
      "proofGitSha256": "6d271f5721a0d47c68fa8f42996a34f7b48fe4c06e414285a3f7fe36bdc44a50",
      "workingSha256Now": "6d271f5721a0d47c68fa8f42996a34f7b48fe4c06e414285a3f7fe36bdc44a50",
      "workingEqualsProofNow": true
    },
    {
      "path": "packages/operator-core/lib/derived-reads/shared-snapshot.ts",
      "proofSha256": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826",
      "proofGitSha256": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826",
      "workingSha256Now": "ab154eea455bfe4290e65f664456a15360cf4151e3a6acfcc7bb9ed666c22826",
      "workingEqualsProofNow": true
    },
    {
      "path": "packages/operator-core/lib/severe-event-owner.ts",
      "proofSha256": "2c59fb583ed0e16abffb543fcf00f2099d2b524786dc456dac78f79648e5cbb2",
      "proofGitSha256": "2c59fb583ed0e16abffb543fcf00f2099d2b524786dc456dac78f79648e5cbb2",
      "workingSha256Now": "2c59fb583ed0e16abffb543fcf00f2099d2b524786dc456dac78f79648e5cbb2",
      "workingEqualsProofNow": true
    },
    {
      "path": "packages/operator-core/lib/system-health/agent-strand-census.ts",
      "proofSha256": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284",
      "proofGitSha256": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284",
      "workingSha256Now": "f90607aafce701501836475b2f328eedc80d50eb620d2ba7b5555378908cf284",
      "workingEqualsProofNow": true
    },
    {
      "path": "packages/operator-core/lib/system-health/compute.ts",
      "proofSha256": "caabb259b0a63fc5cb522c926ee52ed8f39185a07cf6c9e332db9ed68c031d75",
      "proofGitSha256": "caabb259b0a63fc5cb522c926ee52ed8f39185a07cf6c9e332db9ed68c031d75",
      "workingSha256Now": "caabb259b0a63fc5cb522c926ee52ed8f39185a07cf6c9e332db9ed68c031d75",
      "workingEqualsProofNow": true
    },
    {
      "path": "packages/operator-core/lib/system-health/liveness-alarm-current-build.e2e.test.ts",
      "proofSha256": "f62bf14b6ae06d361333052e888d578f04a04e255a1b722c05ad493d8cd2f2f6",
      "proofGitSha256": "f62bf14b6ae06d361333052e888d578f04a04e255a1b722c05ad493d8cd2f2f6",
      "workingSha256Now": "f62bf14b6ae06d361333052e888d578f04a04e255a1b722c05ad493d8cd2f2f6",
      "workingEqualsProofNow": true
    },
    {
      "path": "packages/operator-core/lib/system-health/liveness-alarm.ts",
      "proofSha256": "9941ccb7143b39250a4decc4ef5df0d1ff0ed60b67959f017aab61483a276e54",
      "proofGitSha256": "9941ccb7143b39250a4decc4ef5df0d1ff0ed60b67959f017aab61483a276e54",
      "workingSha256Now": "9941ccb7143b39250a4decc4ef5df0d1ff0ed60b67959f017aab61483a276e54",
      "workingEqualsProofNow": true
    },
    {
      "path": "packages/operator-core/lib/workspace-host/observability-store.ts",
      "proofSha256": "2a60a995e89c754fedeab43b1ae3ecfd01a58ff729343efb78b32a8a0ed25ade",
      "proofGitSha256": "2a60a995e89c754fedeab43b1ae3ecfd01a58ff729343efb78b32a8a0ed25ade",
      "workingSha256Now": "2a60a995e89c754fedeab43b1ae3ecfd01a58ff729343efb78b32a8a0ed25ade",
      "workingEqualsProofNow": true
    },
    {
      "path": "packages/operator-core/test/isolated-integration-proof.ts",
      "proofSha256": "8cca54d7e0c9b363078fce8303cf11a08059c33e9bcea7cc45dba7b64011801d",
      "proofGitSha256": "8cca54d7e0c9b363078fce8303cf11a08059c33e9bcea7cc45dba7b64011801d",
      "workingSha256Now": "8cca54d7e0c9b363078fce8303cf11a08059c33e9bcea7cc45dba7b64011801d",
      "workingEqualsProofNow": true
    },
    {
      "path": "packages/operator-core/test/liveness-alarm-http-fixture.ts",
      "proofSha256": "33d7530f66c2e458767fba7ddf6bbd13019f7906bfec71866e693fe093064a9d",
      "proofGitSha256": "33d7530f66c2e458767fba7ddf6bbd13019f7906bfec71866e693fe093064a9d",
      "workingSha256Now": "33d7530f66c2e458767fba7ddf6bbd13019f7906bfec71866e693fe093064a9d",
      "workingEqualsProofNow": true
    },
    {
      "path": "packages/operator-core/test/private-http-workspace-preflight.ts",
      "proofSha256": "1ad346261702d8b1620cd7482f9fa3131f43d4558a7218029bcc104159f25ff3",
      "proofGitSha256": "1ad346261702d8b1620cd7482f9fa3131f43d4558a7218029bcc104159f25ff3",
      "workingSha256Now": "1ad346261702d8b1620cd7482f9fa3131f43d4558a7218029bcc104159f25ff3",
      "workingEqualsProofNow": true
    },
    {
      "path": "scripts/lib/isolated-runtime-start.mjs",
      "proofSha256": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
      "proofGitSha256": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
      "workingSha256Now": "f604dc115a6f22e3d84a1b9ad332d89f615d418f751ef20d3bcbc021ea32033d",
      "workingEqualsProofNow": true
    },
    {
      "path": "scripts/with-test-pg.mjs",
      "proofSha256": "febeb6714cb293135f2d08cb0a1b9a24314e07c37605c7fbeb76cae3b431cc2b",
      "proofGitSha256": "febeb6714cb293135f2d08cb0a1b9a24314e07c37605c7fbeb76cae3b431cc2b",
      "workingSha256Now": "febeb6714cb293135f2d08cb0a1b9a24314e07c37605c7fbeb76cae3b431cc2b",
      "workingEqualsProofNow": true
    },
    {
      "path": "scripts/lib/with-test-pg-cleanup.mjs",
      "proofSha256": "37effd76e07e992646bd8192b93ead3ee7e865712de89d9eb733bdc1a8713b61",
      "proofGitSha256": "37effd76e07e992646bd8192b93ead3ee7e865712de89d9eb733bdc1a8713b61",
      "workingSha256Now": "37effd76e07e992646bd8192b93ead3ee7e865712de89d9eb733bdc1a8713b61",
      "workingEqualsProofNow": true
    }
  ],
  "log": {
    "path": "/tmp/resume146-r12-current-proof.log",
    "bytes": 151652,
    "sha256": "1da89832fc0467e0640abe7bb19d7948314b5b4876419a4d0f4f56714f02e09a",
    "finalMarkers": [
      "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=105c2763aec788a3a8fe1ef95bc1424aed0ca57b uncommittedPaths=0/1 provenance=stamped startedAt=2026-10-17T16:32:26.017Z childSubstituted=0 skippedTests=3",
      "All 1 check(s) pass AS COMMITTED at 105c2763ae."
    ]
  },
  "boundaries": {
    "selectedCaseOnly": true,
    "threeSiblingsFiltered": true,
    "noStrandedPanelSupplementProof": true,
    "noFinalReleaseEvidence": true,
    "noParentBindingOrGrade": true,
    "originalFailure21272651Preserved": true,
    "noDuplicateRun": true
  }
}
