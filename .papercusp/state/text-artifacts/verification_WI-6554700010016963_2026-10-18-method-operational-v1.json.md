---
rel_path: "verification/WI-6554700010016963/2026-10-18-method-operational-v1.json"
updated_at: 1792292909520
_body: "content"
---

{
  "schemaVersion": 1,
  "kind": "operational-test-evidence",
  "name": "D007 Dream R2 METHOD typed detector on committed containing staging",
  "framework": "node",
  "command": [
    "env",
    "TSX_TSCONFIG_PATH=apps/operator/tsconfig.json",
    "node",
    "--import",
    "tsx",
    "--input-type=module",
    "-"
  ],
  "exitCode": 0,
  "startedAt": "2026-10-18T02:12:27.042109Z",
  "finishedAt": "2026-10-18T02:13:19.564Z",
  "summary": "D007 METHOD only: exact committed reader, matching runtime/scope, original consumer within60s, maintained typed clauses and UNKNOWN/unhealthy semantics. Product health remains false; no approval or shipment.",
  "assertions": [
    {
      "id": "method:containing-source",
      "passed": true,
      "evidence": "{\"sourceHash\":\"32cbfa4b0ae0182587e07f9f6f04b69dabe390d8f6caf35a4ff653ee17b588ed\",\"loadedSourceHash\":\"32cbfa4b0ae0182587e07f9f6f04b69dabe390d8f6caf35a4ff653ee17b588ed\",\"buildSha\":\"258ed96687\"}"
    },
    {
      "id": "method:wrong-runtime-refuses",
      "passed": true,
      "evidence": "{\"reason\":\"wrong-or-unproven-serving-runtime\"}"
    },
    {
      "id": "method:exact-runtime-and-scope",
      "passed": true,
      "evidence": "{\"runtime\":{\"host\":\"port-3170\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274\",\"buildSha\":\"258ed96687\"},\"scope\":{\"workspaceId\":\"papercusp-workspace\",\"potSlug\":\"papercusp\",\"since\":\"2026-10-18T02:00:00.000Z\",\"until\":\"2026-10-18T02:12:27.042109Z\",\"expectedRuntime\":{\"host\":\"port-3170\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274\",\"buildSha\":\"258ed96687\"},\"actionJournalUnit\":\"papercusp-bg-host.service\",\"expectedActionRuntime\":{\"host\":\"port-3271\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126\",\"buildSha\":\"43a8a5f95d\"},\"gymJournalUnit\":\"papercusp-bg-host.service\",\"expectedGymRuntime\":{\"host\":\"port-3271\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126\",\"buildSha\":\"43a8a5f95d\"}}}"
    },
    {
      "id": "method:consumer-within-ttl",
      "passed": true,
      "evidence": "{\"capturedAt\":\"2026-10-18T02:12:30.645Z\",\"consumedAt\":\"2026-10-18T02:12:30.808483Z\",\"expiresAt\":\"2026-10-18T02:13:30.645Z\"}"
    },
    {
      "id": "method:maintained-typed-assessor",
      "passed": true,
      "evidence": "{\"clauseIds\":[\"r2:dream-action-decisions\",\"r2:gym-admission-decisions\",\"r2:full-admission-and-spend\",\"r2:scout-zero-route-lens-cap-provenance\",\"r2:actual-attempts-or-explicit-policy-skips\"],\"healthy\":false}"
    },
    {
      "id": "method:r2:dream-action-decisions",
      "passed": true,
      "evidence": "{\"id\":\"r2:dream-action-decisions\",\"status\":\"pass\",\"healthy\":true,\"reason\":\"actual-complete-dream-decisions\",\"rawRefs\":[\"/actionDecisions\"],\"sourceRefs\":[\"journal:readJournal\",\"dream/dream-cycle-action:makeDreamCycleAction\"],\"scope\":{\"workspaceId\":\"papercusp-workspace\",\"potSlug\":\"papercusp\",\"since\":\"2026-10-18T02:00:00.000Z\",\"until\":\"2026-10-18T02:12:27.042109Z\",\"expectedRuntime\":{\"host\":\"port-3170\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274\",\"buildSha\":\"258ed96687\"},\"actionJournalUnit\":\"papercusp-bg-host.service\",\"expectedActionRuntime\":{\"host\":\"port-3271\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126\",\"buildSha\":\"43a8a5f95d\"},\"gymJournalUnit\":\"papercusp-bg-host.service\",\"expectedGymRuntime\":{\"host\":\"port-3271\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126\",\"buildSha\":\"43a8a5f95d\"}},\"source\":{\"path\":\"packages/operator-core/lib/dream/dream-control-observations.ts\",\"runtime\":{\"host\":\"port-3170\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274\",\"buildSha\":\"258ed96687\"}},\"capturedAt\":\"2026-10-18T02:12:30.645Z\",\"expiresAt\":\"2026-10-18T02:13:30.645Z\"}"
    },
    {
      "id": "method:r2:gym-admission-decisions",
      "passed": true,
      "evidence": "{\"id\":\"r2:gym-admission-decisions\",\"status\":\"unknown\",\"healthy\":false,\"reason\":\"no-actual-gym-admission-records\",\"rawRefs\":[\"/gymDecisions\"],\"sourceRefs\":[\"journal:readJournal\",\"gym/autoloop-tick:runGymAutoloopTick\"],\"scope\":{\"workspaceId\":\"papercusp-workspace\",\"potSlug\":\"papercusp\",\"since\":\"2026-10-18T02:00:00.000Z\",\"until\":\"2026-10-18T02:12:27.042109Z\",\"expectedRuntime\":{\"host\":\"port-3170\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274\",\"buildSha\":\"258ed96687\"},\"actionJournalUnit\":\"papercusp-bg-host.service\",\"expectedActionRuntime\":{\"host\":\"port-3271\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126\",\"buildSha\":\"43a8a5f95d\"},\"gymJournalUnit\":\"papercusp-bg-host.service\",\"expectedGymRuntime\":{\"host\":\"port-3271\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126\",\"buildSha\":\"43a8a5f95d\"}},\"source\":{\"path\":\"packages/operator-core/lib/dream/dream-control-observations.ts\",\"runtime\":{\"host\":\"port-3170\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274\",\"buildSha\":\"258ed96687\"}},\"capturedAt\":\"2026-10-18T02:12:30.645Z\",\"expiresAt\":\"2026-10-18T02:13:30.645Z\"}"
    },
    {
      "id": "method:r2:full-admission-and-spend",
      "passed": true,
      "evidence": "{\"id\":\"r2:full-admission-and-spend\",\"status\":\"unknown\",\"healthy\":false,\"reason\":\"complete-production-admission-and-spend-required\",\"rawRefs\":[\"/productionAdmission\",\"/observations/governors\",\"/observations/rollingSpend\"],\"sourceRefs\":[\"dream-governor:preflightDreamCycle\",\"learning-governor:checkLoopVerdict\",\"dream-governor:sumDreamSpendSince\"],\"scope\":{\"workspaceId\":\"papercusp-workspace\",\"potSlug\":\"papercusp\",\"since\":\"2026-10-18T02:00:00.000Z\",\"until\":\"2026-10-18T02:12:27.042109Z\",\"expectedRuntime\":{\"host\":\"port-3170\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274\",\"buildSha\":\"258ed96687\"},\"actionJournalUnit\":\"papercusp-bg-host.service\",\"expectedActionRuntime\":{\"host\":\"port-3271\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126\",\"buildSha\":\"43a8a5f95d\"},\"gymJournalUnit\":\"papercusp-bg-host.service\",\"expectedGymRuntime\":{\"host\":\"port-3271\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126\",\"buildSha\":\"43a8a5f95d\"}},\"source\":{\"path\":\"packages/operator-core/lib/dream/dream-control-observations.ts\",\"runtime\":{\"host\":\"port-3170\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274\",\"buildSha\":\"258ed96687\"}},\"capturedAt\":\"2026-10-18T02:12:30.645Z\",\"expiresAt\":\"2026-10-18T02:13:30.645Z\"}"
    },
    {
      "id": "method:r2:scout-zero-route-lens-cap-provenance",
      "passed": true,
      "evidence": "{\"id\":\"r2:scout-zero-route-lens-cap-provenance\",\"status\":\"unknown\",\"healthy\":false,\"reason\":\"qualifying-complete-scout-cap-lens-origin-window-required\",\"rawRefs\":[\"/observations/activity/value/scout\"],\"sourceRefs\":[\"harness_shared.scout_ticks\",\"scout/scheduler:runScoutTick\",\"scout/run:runScoutCycleTick\"],\"scope\":{\"workspaceId\":\"papercusp-workspace\",\"potSlug\":\"papercusp\",\"since\":\"2026-10-18T02:00:00.000Z\",\"until\":\"2026-10-18T02:12:27.042109Z\",\"expectedRuntime\":{\"host\":\"port-3170\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274\",\"buildSha\":\"258ed96687\"},\"actionJournalUnit\":\"papercusp-bg-host.service\",\"expectedActionRuntime\":{\"host\":\"port-3271\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126\",\"buildSha\":\"43a8a5f95d\"},\"gymJournalUnit\":\"papercusp-bg-host.service\",\"expectedGymRuntime\":{\"host\":\"port-3271\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126\",\"buildSha\":\"43a8a5f95d\"}},\"source\":{\"path\":\"packages/operator-core/lib/dream/dream-control-observations.ts\",\"runtime\":{\"host\":\"port-3170\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274\",\"buildSha\":\"258ed96687\"}},\"capturedAt\":\"2026-10-18T02:12:30.645Z\",\"expiresAt\":\"2026-10-18T02:13:30.645Z\"}"
    },
    {
      "id": "method:r2:actual-attempts-or-explicit-policy-skips",
      "passed": true,
      "evidence": "{\"id\":\"r2:actual-attempts-or-explicit-policy-skips\",\"status\":\"unknown\",\"healthy\":false,\"reason\":\"actual-attempt-usage-or-explicit-policy-skip-required\",\"rawRefs\":[\"/actionDecisions\",\"/observations/activity/value/dream\"],\"sourceRefs\":[\"dream/dream-cycle-action:makeDreamCycleAction\",\"harness_shared.dream_runs\"],\"scope\":{\"workspaceId\":\"papercusp-workspace\",\"potSlug\":\"papercusp\",\"since\":\"2026-10-18T02:00:00.000Z\",\"until\":\"2026-10-18T02:12:27.042109Z\",\"expectedRuntime\":{\"host\":\"port-3170\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274\",\"buildSha\":\"258ed96687\"},\"actionJournalUnit\":\"papercusp-bg-host.service\",\"expectedActionRuntime\":{\"host\":\"port-3271\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126\",\"buildSha\":\"43a8a5f95d\"},\"gymJournalUnit\":\"papercusp-bg-host.service\",\"expectedGymRuntime\":{\"host\":\"port-3271\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126\",\"buildSha\":\"43a8a5f95d\"}},\"source\":{\"path\":\"packages/operator-core/lib/dream/dream-control-observations.ts\",\"runtime\":{\"host\":\"port-3170\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274\",\"buildSha\":\"258ed96687\"}},\"capturedAt\":\"2026-10-18T02:12:30.645Z\",\"expiresAt\":\"2026-10-18T02:13:30.645Z\"}"
    },
    {
      "id": "method:unknown-is-unhealthy",
      "passed": true,
      "evidence": "{\"healthy\":false,\"statuses\":[{\"id\":\"r2:dream-action-decisions\",\"status\":\"pass\",\"healthy\":true},{\"id\":\"r2:gym-admission-decisions\",\"status\":\"unknown\",\"healthy\":false},{\"id\":\"r2:full-admission-and-spend\",\"status\":\"unknown\",\"healthy\":false},{\"id\":\"r2:scout-zero-route-lens-cap-provenance\",\"status\":\"unknown\",\"healthy\":false},{\"id\":\"r2:actual-attempts-or-explicit-policy-skips\",\"status\":\"unknown\",\"healthy\":false}]}"
    },
    {
      "id": "method:currentness-fails-closed",
      "passed": true,
      "evidence": "{\"current\":false,\"reason\":\"incomplete-gym-decisions\"}"
    }
  ],
  "source": {
    "sourcePath": "packages/operator-core/lib/dream/dream-control-observations.ts",
    "loadedSha": "258ed96687",
    "blobSha256": "32cbfa4b0ae0182587e07f9f6f04b69dabe390d8f6caf35a4ff653ee17b588ed",
    "localAssessorSha256": "32cbfa4b0ae0182587e07f9f6f04b69dabe390d8f6caf35a4ff653ee17b588ed",
    "testedSourceSha256": "32cbfa4b0ae0182587e07f9f6f04b69dabe390d8f6caf35a4ff653ee17b588ed"
  },
  "scope": {
    "workspaceId": "papercusp-workspace",
    "potSlug": "papercusp",
    "since": "2026-10-18T02:00:00.000Z",
    "until": "2026-10-18T02:12:27.042109Z",
    "expectedRuntime": {
      "host": "port-3170",
      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274",
      "buildSha": "258ed96687"
    },
    "actionJournalUnit": "papercusp-bg-host.service",
    "expectedActionRuntime": {
      "host": "port-3271",
      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126",
      "buildSha": "43a8a5f95d"
    },
    "gymJournalUnit": "papercusp-bg-host.service",
    "expectedGymRuntime": {
      "host": "port-3271",
      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126",
      "buildSha": "43a8a5f95d"
    }
  },
  "consumedAt": "2026-10-18T02:12:30.808483Z",
  "currentness": {
    "current": false,
    "reason": "incomplete-gym-decisions"
  },
  "methodFreshness": {
    "validAtConsumer": true,
    "basis": "exact identity/scope/60s timestamp assertion; product currentness separate"
  },
  "productR2Healthy": false,
  "requests": {
    "identityDiscovery": {
      "httpStatus": 200,
      "requestId": null,
      "body": {
        "rows": [
          {
            "schemaVersion": "dream-control-observations-v1",
            "status": "unknown",
            "reason": "wrong-or-unproven-serving-runtime",
            "scope": {
              "workspaceId": "papercusp-workspace",
              "potSlug": "papercusp",
              "since": "2026-10-18T02:00:00.000Z",
              "until": "2026-10-18T02:12:27.042109Z",
              "expectedRuntime": {
                "host": "identity-discovery",
                "processId": "identity-discovery",
                "buildSha": "identity-discovery"
              }
            },
            "runtime": {
              "host": "port-3170",
              "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274",
              "buildSha": "258ed96687"
            },
            "capturedAt": "2026-10-18T02:12:27.073Z",
            "expiresAt": "2026-10-18T02:13:27.073Z",
            "observations": null,
            "r2Assertions": {
              "schemaVersion": 1,
              "healthy": false,
              "clauses": [
                {
                  "id": "r2:dream-action-decisions",
                  "status": "unknown",
                  "healthy": false,
                  "reason": "stale-or-wrong-serving-runtime",
                  "rawRefs": [
                    "/status"
                  ],
                  "sourceRefs": [
                    "journal:readJournal",
                    "dream/dream-cycle-action:makeDreamCycleAction"
                  ],
                  "scope": {
                    "workspaceId": "papercusp-workspace",
                    "potSlug": "papercusp",
                    "since": "2026-10-18T02:00:00.000Z",
                    "until": "2026-10-18T02:12:27.042109Z",
                    "expectedRuntime": {
                      "host": "identity-discovery",
                      "processId": "identity-discovery",
                      "buildSha": "identity-discovery"
                    }
                  },
                  "source": {
                    "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
                    "runtime": {
                      "host": "port-3170",
                      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274",
                      "buildSha": "258ed96687"
                    }
                  },
                  "capturedAt": "2026-10-18T02:12:27.073Z",
                  "expiresAt": "2026-10-18T02:13:27.073Z"
                },
                {
                  "id": "r2:gym-admission-decisions",
                  "status": "unknown",
                  "healthy": false,
                  "reason": "stale-or-wrong-serving-runtime",
                  "rawRefs": [
                    "/status"
                  ],
                  "sourceRefs": [
                    "journal:readJournal",
                    "gym/autoloop-tick:runGymAutoloopTick"
                  ],
                  "scope": {
                    "workspaceId": "papercusp-workspace",
                    "potSlug": "papercusp",
                    "since": "2026-10-18T02:00:00.000Z",
                    "until": "2026-10-18T02:12:27.042109Z",
                    "expectedRuntime": {
                      "host": "identity-discovery",
                      "processId": "identity-discovery",
                      "buildSha": "identity-discovery"
                    }
                  },
                  "source": {
                    "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
                    "runtime": {
                      "host": "port-3170",
                      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274",
                      "buildSha": "258ed96687"
                    }
                  },
                  "capturedAt": "2026-10-18T02:12:27.073Z",
                  "expiresAt": "2026-10-18T02:13:27.073Z"
                },
                {
                  "id": "r2:full-admission-and-spend",
                  "status": "unknown",
                  "healthy": false,
                  "reason": "stale-or-wrong-serving-runtime",
                  "rawRefs": [
                    "/status",
                    "/observations"
                  ],
                  "sourceRefs": [
                    "dream-governor:preflightDreamCycle",
                    "learning-governor:checkLoopVerdict",
                    "dream-governor:sumDreamSpendSince"
                  ],
                  "scope": {
                    "workspaceId": "papercusp-workspace",
                    "potSlug": "papercusp",
                    "since": "2026-10-18T02:00:00.000Z",
                    "until": "2026-10-18T02:12:27.042109Z",
                    "expectedRuntime": {
                      "host": "identity-discovery",
                      "processId": "identity-discovery",
                      "buildSha": "identity-discovery"
                    }
                  },
                  "source": {
                    "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
                    "runtime": {
                      "host": "port-3170",
                      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274",
                      "buildSha": "258ed96687"
                    }
                  },
                  "capturedAt": "2026-10-18T02:12:27.073Z",
                  "expiresAt": "2026-10-18T02:13:27.073Z"
                },
                {
                  "id": "r2:scout-zero-route-lens-cap-provenance",
                  "status": "unknown",
                  "healthy": false,
                  "reason": "stale-or-wrong-serving-runtime",
                  "rawRefs": [
                    "/observations"
                  ],
                  "sourceRefs": [
                    "harness_shared.scout_ticks",
                    "scout/scheduler:runScoutTick",
                    "scout/run:runScoutCycleTick"
                  ],
                  "scope": {
                    "workspaceId": "papercusp-workspace",
                    "potSlug": "papercusp",
                    "since": "2026-10-18T02:00:00.000Z",
                    "until": "2026-10-18T02:12:27.042109Z",
                    "expectedRuntime": {
                      "host": "identity-discovery",
                      "processId": "identity-discovery",
                      "buildSha": "identity-discovery"
                    }
                  },
                  "source": {
                    "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
                    "runtime": {
                      "host": "port-3170",
                      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274",
                      "buildSha": "258ed96687"
                    }
                  },
                  "capturedAt": "2026-10-18T02:12:27.073Z",
                  "expiresAt": "2026-10-18T02:13:27.073Z"
                },
                {
                  "id": "r2:actual-attempts-or-explicit-policy-skips",
                  "status": "unknown",
                  "healthy": false,
                  "reason": "stale-or-wrong-serving-runtime",
                  "rawRefs": [
                    "/status",
                    "/observations"
                  ],
                  "sourceRefs": [
                    "dream/dream-cycle-action:makeDreamCycleAction",
                    "harness_shared.dream_runs"
                  ],
                  "scope": {
                    "workspaceId": "papercusp-workspace",
                    "potSlug": "papercusp",
                    "since": "2026-10-18T02:00:00.000Z",
                    "until": "2026-10-18T02:12:27.042109Z",
                    "expectedRuntime": {
                      "host": "identity-discovery",
                      "processId": "identity-discovery",
                      "buildSha": "identity-discovery"
                    }
                  },
                  "source": {
                    "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
                    "runtime": {
                      "host": "port-3170",
                      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274",
                      "buildSha": "258ed96687"
                    }
                  },
                  "capturedAt": "2026-10-18T02:12:27.073Z",
                  "expiresAt": "2026-10-18T02:13:27.073Z"
                }
              ]
            }
          }
        ],
        "version": "1792289547078",
        "timing": {
          "unit": "ms",
          "resolverStartedAtMs": 1792289547060,
          "resolverCompletedAtMs": 1792289547078,
          "resolverMs": 18
        }
      }
    },
    "observation": {
      "httpStatus": 200,
      "requestId": null,
      "body": {
        "rows": [
          {
            "schemaVersion": "dream-control-observations-v1",
            "status": "observed",
            "reason": null,
            "scope": {
              "workspaceId": "papercusp-workspace",
              "potSlug": "papercusp",
              "since": "2026-10-18T02:00:00.000Z",
              "until": "2026-10-18T02:12:27.042109Z",
              "expectedRuntime": {
                "host": "port-3170",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274",
                "buildSha": "258ed96687"
              },
              "actionJournalUnit": "papercusp-bg-host.service",
              "expectedActionRuntime": {
                "host": "port-3271",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126",
                "buildSha": "43a8a5f95d"
              },
              "gymJournalUnit": "papercusp-bg-host.service",
              "expectedGymRuntime": {
                "host": "port-3271",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126",
                "buildSha": "43a8a5f95d"
              }
            },
            "runtime": {
              "host": "port-3170",
              "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274",
              "buildSha": "258ed96687"
            },
            "capturedAt": "2026-10-18T02:12:30.645Z",
            "expiresAt": "2026-10-18T02:13:30.645Z",
            "observations": {
              "flags": {
                "status": "observed",
                "value": {
                  "dream": true,
                  "learningGovernor": true,
                  "attestations": {
                    "dream": {
                      "key": "papercusp-dream-cycle",
                      "resolvedValue": true,
                      "compiledDefault": true,
                      "source": "compiled-default",
                      "overrideRead": {
                        "kind": "cache-hit",
                        "storeConfigured": true,
                        "cacheKey": "papercusp-workspace",
                        "cacheGeneration": 286,
                        "cacheLoadedAtMs": 1792289546007,
                        "cacheAgeMs": 4638,
                        "ttlMs": 5000,
                        "ttlRemainingMs": 362,
                        "loadError": null
                      },
                      "backendConfigured": false,
                      "observedAtMs": 1792289550645
                    },
                    "learningGovernor": {
                      "key": "papercusp-learning-governor",
                      "resolvedValue": true,
                      "compiledDefault": true,
                      "source": "compiled-default",
                      "overrideRead": {
                        "kind": "cache-hit",
                        "storeConfigured": true,
                        "cacheKey": "papercusp-workspace",
                        "cacheGeneration": 286,
                        "cacheLoadedAtMs": 1792289546007,
                        "cacheAgeMs": 4639,
                        "ttlMs": 5000,
                        "ttlRemainingMs": 361,
                        "loadError": null
                      },
                      "backendConfigured": false,
                      "observedAtMs": 1792289550646
                    }
                  }
                },
                "sourceRefs": [
                  "flags:DREAM_CYCLE",
                  "flags:LEARNING_GOVERNOR"
                ]
              },
              "dream": {
                "status": "observed",
                "value": {
                  "routines": [
                    {
                      "name": "dream-cycle-manual",
                      "active": false,
                      "next_fire_at": "2026-10-17 22:10:00-04",
                      "metadata": {
                        "pause": {
                          "reason": "Dream paused from Learning controls",
                          "pausedBy": "su-9f941711-a74e-486f-9ca7-302887653aac",
                          "pausedAtMs": 1792289190855
                        },
                        "lastPause": {
                          "reason": "Dream paused from Learning controls",
                          "pausedBy": "su-9d472d4b-a9aa-46ea-9bd8-a40d0c3a7d2c",
                          "pausedAtMs": 1791693764811,
                          "resumedAtMs": 1792288938085
                        },
                        "dreamControl": {
                          "at": 1792289190855,
                          "mode": "manual",
                          "actor": "su-9f941711-a74e-486f-9ca7-302887653aac",
                          "enabled": false
                        },
                        "dreamLastCycle": {
                          "mode": "manual",
                          "reason": "aborted",
                          "costUsd": 0,
                          "cycleId": "sched-.routinesTick-2026-10-18T02:02:30.000Z-7",
                          "running": 0,
                          "accepted": 0,
                          "attempts": 1,
                          "updatedAt": "2026-10-18T02:07:07.550Z"
                        }
                      },
                      "payload_template": {
                        "mode": "manual"
                      }
                    },
                    {
                      "name": "dream-cycle-auto",
                      "active": true,
                      "next_fire_at": "2026-10-17 22:31:07-04",
                      "metadata": {
                        "lastPause": {
                          "reason": "Dream paused from Learning controls",
                          "pausedBy": "su-9d472d4b-a9aa-46ea-9bd8-a40d0c3a7d2c",
                          "pausedAtMs": 1791464349584,
                          "resumedAtMs": 1791693887075
                        },
                        "dreamControl": {
                          "at": 1792199893988,
                          "mode": "auto",
                          "actor": "su-e41f796d-eaeb-458d-8e7b-f957a79a2445",
                          "enabled": true
                        }
                      },
                      "payload_template": {
                        "mode": "auto"
                      }
                    }
                  ],
                  "resolved": {
                    "manual": {
                      "maxDreamsPerCycle": 3,
                      "maxCostUsd": 1,
                      "rolling24hCostUsd": 5,
                      "timeoutMs": 600000,
                      "autoIdleRatioFloor": 0.5
                    },
                    "auto": {
                      "maxDreamsPerCycle": 3,
                      "maxCostUsd": 1,
                      "rolling24hCostUsd": 5,
                      "timeoutMs": 600000,
                      "autoIdleRatioFloor": 0.5
                    }
                  }
                },
                "sourceRefs": [
                  "harness_shared.routines",
                  "dream-config:resolveDreamCycleConfig"
                ]
              },
              "gym": {
                "status": "observed",
                "value": {
                  "autoloop": {
                    "workspaceId": "papercusp-workspace",
                    "harnessSlug": "papercusp",
                    "enabled": true,
                    "budgetUsd": null,
                    "spentUsd": 0,
                    "status": "idle",
                    "lastCycle": 1,
                    "lastCycleAt": 1787885386903,
                    "updatedAt": 1787885387048
                  },
                  "gates": {
                    "epsilon": 0.1,
                    "delta": 0.5,
                    "costCeiling": 3
                  },
                  "budgetFloorUsd": 0.5,
                  "remainingUsd": null,
                  "nativeBudgetEligible": false,
                  "cycleHardCapUsd": null,
                  "nullBudgetRefusesUnattended": true
                },
                "sourceRefs": [
                  "harness_shared.gym_autoloop_config",
                  "harness_shared.operator_gym_gates",
                  "gym/autoloop-tick:isEligibleAutoloop"
                ]
              },
              "governors": {
                "status": "observed",
                "value": {
                  "loops": [
                    {
                      "workspaceId": "papercusp-workspace",
                      "loopId": "dream:papercusp",
                      "potSlug": "papercusp",
                      "displayName": "Dream cycles (papercusp)",
                      "budgetKind": "per-cycle",
                      "budgetUsd": 1,
                      "spentUsd": 2.574479,
                      "priority": 65,
                      "enabled": true,
                      "enforcement": "governor",
                      "meta": {
                        "rollingWindowMs": 86400000,
                        "maxDreamsPerCycle": 3,
                        "rolling24hCostUsd": 5
                      },
                      "registeredAt": 1788877659174,
                      "updatedAt": 1792288953107
                    },
                    {
                      "workspaceId": "papercusp-workspace",
                      "loopId": "gym:papercusp",
                      "potSlug": "papercusp",
                      "displayName": "Gym autoloop (papercusp)",
                      "budgetKind": "lifetime",
                      "budgetUsd": null,
                      "spentUsd": 0,
                      "priority": 50,
                      "enabled": true,
                      "enforcement": "native",
                      "meta": null,
                      "registeredAt": 1781848671347,
                      "updatedAt": 1791432575303
                    },
                    {
                      "workspaceId": "papercusp-workspace",
                      "loopId": "blender:papercusp",
                      "potSlug": "papercusp",
                      "displayName": "Scout cadence (papercusp)",
                      "budgetKind": "per-cycle",
                      "budgetUsd": 5,
                      "spentUsd": 580.1204257,
                      "priority": 60,
                      "enabled": true,
                      "enforcement": "native",
                      "meta": null,
                      "registeredAt": 1785027875085,
                      "updatedAt": 1792289392510
                    }
                  ],
                  "floorUsd": 0.5,
                  "potScope": [
                    {
                      "workspace_id": "papercusp-workspace",
                      "pot_slug": "papercusp",
                      "enabled": true
                    }
                  ],
                  "steering": [
                    {
                      "workspace_id": "papercusp-workspace",
                      "harness_slug": "papercusp",
                      "setting_key": "owner-steering:idle-activities",
                      "value": "{\"gym\":true,\"dream\":true}",
                      "updated_at": 1792199893985
                    }
                  ],
                  "reservations": [],
                  "governorAdmission": [
                    {
                      "loopId": "dream:papercusp",
                      "openReservedUsd": 0,
                      "chargedOpenUsd": 0,
                      "openCount": 0,
                      "verdict": {
                        "allow": true,
                        "remainingUsd": 1
                      },
                      "enforcement": "governor",
                      "scope": "governor-budget-and-pot-only"
                    },
                    {
                      "loopId": "gym:papercusp",
                      "openReservedUsd": 0,
                      "chargedOpenUsd": 0,
                      "openCount": 0,
                      "verdict": {
                        "allow": false,
                        "reason": "unbudgeted",
                        "remainingUsd": null
                      },
                      "enforcement": "native",
                      "scope": "governor-budget-and-pot-only"
                    },
                    {
                      "loopId": "blender:papercusp",
                      "openReservedUsd": 0,
                      "chargedOpenUsd": 0,
                      "openCount": 0,
                      "verdict": {
                        "allow": true,
                        "remainingUsd": 5
                      },
                      "enforcement": "native",
                      "scope": "governor-budget-and-pot-only"
                    }
                  ],
                  "admission": "not-evaluated"
                },
                "sourceRefs": [
                  "harness_shared.learning_governor_loops",
                  "harness_shared.learning_pot_scope",
                  "harness_shared.pot_settings"
                ]
              },
              "activity": {
                "status": "observed",
                "value": {
                  "dream": {
                    "rows": [
                      {
                        "workspace_id": "papercusp-workspace",
                        "pot_slug": "papercusp",
                        "run_id": "sched-.routinesTick-2026-10-18T02:02:30.000Z-7:dream:1",
                        "cycle_id": "sched-.routinesTick-2026-10-18T02:02:30.000Z-7",
                        "mode": "manual",
                        "status": "error",
                        "dreamer_model": "gpt-6.1-sol:xhigh",
                        "reviewer_model": null,
                        "dream_usage": null,
                        "review_usage": null,
                        "input_tokens": 0,
                        "output_tokens": 0,
                        "cost_usd": 0,
                        "routed_ref": null,
                        "started_at": "2026-10-17 22:02:33.09581-04",
                        "completed_at": "2026-10-17 22:07:07.504529-04",
                        "updated_at": "2026-10-17 22:07:07.518414-04",
                        "capability_run": {
                          "calls": [
                            {
                              "error": null,
                              "model": "local:packet",
                              "phase": "packet",
                              "usage": {
                                "model": "local:packet",
                                "costUsd": 0,
                                "inputTokens": 0,
                                "outputTokens": 0
                              },
                              "callId": "packet:catalogue",
                              "status": "settled",
                              "reservedUsd": 0
                            }
                          ],
                          "sampling": null,
                          "artifactId": null,
                          "dreamerModel": "gpt-6.1-sol:xhigh",
                          "manifestHash": "6bf47f17e42310b03ccdc5f2de2cd34da217f464f0a553168c3b89e0daaebb80",
                          "reviewerModel": "gpt-6.1-sol:xhigh",
                          "schemaVersion": "dream-capability-run-v1",
                          "manifestRevision": "problem-focused-2026-09-27-v1",
                          "dreamPromptVersion": "capability-relational-v1",
                          "reviewPromptVersion": "dream-capability-review-v1"
                        }
                      }
                    ],
                    "hasMore": false,
                    "limit": 20,
                    "population": "bounded-window-rows"
                  },
                  "scout": {
                    "rows": [
                      {
                        "id": "4290",
                        "workspace_id": "papercusp-workspace",
                        "install_slug": "papercusp-workspace",
                        "pot_slug": "papercusp",
                        "tick_at": "2026-10-17 22:09:53.965381-04",
                        "origin": "scout",
                        "status": "gated",
                        "gate": "generation-preflight",
                        "ideas_generated": 0,
                        "ideas_routed": 0,
                        "budget_used_usd": null,
                        "detail": {
                          "p95Ms": 601863031.92465,
                          "reason": "admission-throttle-deep",
                          "pending": 300,
                          "hostBuildSha": "43a8a5f95d",
                          "throttleReasons": [
                            "pending 300 exceeds two promoter batches (40)",
                            "claim-latency p95 601863032ms exceeds 10800000ms"
                          ],
                          "budgetProvenance": {
                            "resolved": {
                              "maxCostUsd": 5,
                              "maxIdeators": 2,
                              "maxCriticsPerIdea": 2
                            },
                            "supplied": {
                              "maxCostUsd": 5,
                              "maxIdeators": 2,
                              "maxCriticsPerIdea": 2
                            },
                            "schemaVersion": 1
                          },
                          "admissionThrottle": {
                            "level": "deep",
                            "p95Ms": 601863031.92465,
                            "source": "p005-queue-health",
                            "pending": 300,
                            "reasons": [
                              "pending 300 exceeds two promoter batches (40)",
                              "claim-latency p95 601863032ms exceeds 10800000ms"
                            ],
                            "maxIdeators": 1,
                            "latencySampleSize": 38
                          }
                        }
                      }
                    ],
                    "hasMore": false,
                    "limit": 20,
                    "population": "bounded-window-rows",
                    "observations": [
                      {
                        "raw": {
                          "id": "4290",
                          "workspace_id": "papercusp-workspace",
                          "install_slug": "papercusp-workspace",
                          "pot_slug": "papercusp",
                          "tick_at": "2026-10-17 22:09:53.965381-04",
                          "origin": "scout",
                          "status": "gated",
                          "gate": "generation-preflight",
                          "ideas_generated": 0,
                          "ideas_routed": 0,
                          "budget_used_usd": null,
                          "detail": {
                            "p95Ms": 601863031.92465,
                            "reason": "admission-throttle-deep",
                            "pending": 300,
                            "hostBuildSha": "43a8a5f95d",
                            "throttleReasons": [
                              "pending 300 exceeds two promoter batches (40)",
                              "claim-latency p95 601863032ms exceeds 10800000ms"
                            ],
                            "budgetProvenance": {
                              "resolved": {
                                "maxCostUsd": 5,
                                "maxIdeators": 2,
                                "maxCriticsPerIdea": 2
                              },
                              "supplied": {
                                "maxCostUsd": 5,
                                "maxIdeators": 2,
                                "maxCriticsPerIdea": 2
                              },
                              "schemaVersion": 1
                            },
                            "admissionThrottle": {
                              "level": "deep",
                              "p95Ms": 601863031.92465,
                              "source": "p005-queue-health",
                              "pending": 300,
                              "reasons": [
                                "pending 300 exceeds two promoter batches (40)",
                                "claim-latency p95 601863032ms exceeds 10800000ms"
                              ],
                              "maxIdeators": 1,
                              "latencySampleSize": 38
                            }
                          }
                        },
                        "origin": "scout",
                        "budgetProvenance": {
                          "status": "observed",
                          "schemaVersion": 1,
                          "supplied": {
                            "maxCostUsd": 5,
                            "maxIdeators": 2,
                            "maxCriticsPerIdea": 2
                          },
                          "resolved": {
                            "maxIdeators": 2,
                            "maxCostUsd": 5,
                            "maxCriticsPerIdea": 2
                          }
                        },
                        "suppliedOneIdeatorCapRespected": null,
                        "ideatorCount": null,
                        "lenses": null,
                        "ideasRouted": 0,
                        "costUsd": null,
                        "oneIdeatorZeroRoute": null,
                        "modelUsage": "not-established"
                      }
                    ]
                  },
                  "modelExecution": "not-established",
                  "outputQuality": "not-evaluated",
                  "preLedgerPolicySkips": "not-recorded-in-attempt-ledger"
                },
                "sourceRefs": [
                  "harness_shared.dream_runs",
                  "harness_shared.scout_ticks"
                ]
              },
              "rollingSpend": {
                "status": "observed",
                "value": {
                  "totalUsd": 0,
                  "loopCount": 0,
                  "workspaceId": "papercusp-workspace",
                  "since": "2026-10-17T02:12:30.645Z",
                  "accounting": "maintained-conservative-admission-total"
                },
                "sourceRefs": [
                  "dream-governor:sumDreamSpendSince",
                  "harness_shared.learning_spend_events",
                  "harness_shared.dream_runs"
                ]
              }
            },
            "actionDecisions": {
              "status": "observed",
              "value": {
                "journal": {
                  "matched": 2,
                  "collapsed": 0,
                  "truncated": false,
                  "window": {
                    "since": "@1792288800",
                    "until": "@1792289547.042",
                    "resolved": null
                  },
                  "units": [
                    "papercusp-bg-host.service"
                  ],
                  "unitsUnknown": [],
                  "unitsHistorical": [],
                  "historicalCommand": null,
                  "windowOutsideJournal": null,
                  "command": "journalctl --user --no-pager -o json --output-fields=__REALTIME_TIMESTAMP,_SYSTEMD_USER_UNIT,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER,PRIORITY,MESSAGE -u papercusp-bg-host.service --since @1792288800 --until @1792289547.042 --grep dream-action-decision: --case-sensitive=false -n 21",
                  "backend": "systemd",
                  "entries": [
                    {
                      "ts": "2026-10-18T02:01:43.544Z",
                      "unit": "papercusp-bg-host.service",
                      "level": "info",
                      "message": "[dream-cycle] dream-action-decision:{\"schemaVersion\":1,\"actionId\":\"sched-.routinesTick-2026-10-18T02:01:30.000Z-11\",\"workspaceId\":\"papercusp-workspace\",\"potSlug\":\"papercusp\",\"capturedAt\":\"2026-10-18T02:01:43.543Z\",\"runtime\":{\"host\":\"port-3271\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126\",\"buildSha\":\"43a8a5f95d\"},\"source\":\"dream/dream-cycle-action:makeDreamCycleAction\",\"mode\":\"auto\",\"reason\":\"idle-ratio-below-floor\",\"cycle\":{\"maxDreamsPerCycle\":3,\"maxCostUsd\":1,\"rolling24hCostUsd\":5,\"timeoutMs\":600000,\"autoIdleRatioFloor\":0.5},\"admission\":[{\"gate\":\"feature\",\"status\":\"passed\",\"inputs\":{\"enabled\":true}},{\"gate\":\"owner-idle\",\"status\":\"passed\",\"inputs\":{\"allowed\":true,\"potSlug\":\"papercusp\",\"observation\":{\"status\":\"observed\",\"home\":\"papercusp\",\"allowed\":true,\"steering\":{\"directive\":null,\"eligiblePlans\":[],\"eligibleHives\":[],\"includeUnplannedWork\":true,\"pauseNewWork\":true,\"pausedUntil\":null,\"modelTiers\":null,\"tierCeilings\":{\"cup\":\"standard\",\"mug\":\"max\"},\"cadenceFloorSec\":null,\"maxBees\":1,\"idleActivities\":{\"gym\":true,\"dream\":true},\"autoScaleOut\":null,\"decomposition\":\"parallel\",\"modelOverrides\":null,\"federatedPriming\":null,\"createWakeSuppressPlans\":[]}}}},{\"gate\":\"idle-ratio\",\"status\":\"refused\",\"inputs\":{\"idleRatio\":0,\"floor\":0.5}},{\"gate\":\"source\",\"status\":\"not-reached\",\"inputs\":{}},{\"gate\":\"governor\",\"status\":\"not-reached\",\"inputs\":{}},{\"gate\":\"continue\",\"status\":\"not-reached\",\"inputs\":{}}],\"disposition\":\"pre-attempt-policy-skip\",\"idleRatio\":0,\"floor\":0.5,\"paidCalls\":0,\"model\":null,\"usage\":null,\"costUsd\":0}",
                      "repeat": 1
                    },
                    {
                      "ts": "2026-10-18T02:07:08.285Z",
                      "unit": "papercusp-bg-host.service",
                      "level": "info",
                      "message": "[dream-cycle] dream-action-decision:{\"schemaVersion\":1,\"actionId\":\"sched-.routinesTick-2026-10-18T02:02:30.000Z-7\",\"workspaceId\":\"papercusp-workspace\",\"potSlug\":\"papercusp\",\"capturedAt\":\"2026-10-18T02:07:07.559Z\",\"runtime\":{\"host\":\"port-3271\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126\",\"buildSha\":\"43a8a5f95d\"},\"source\":\"dream/dream-cycle-action:makeDreamCycleAction\",\"mode\":\"manual\",\"reason\":\"aborted\",\"cycle\":{\"maxDreamsPerCycle\":3,\"maxCostUsd\":1,\"rolling24hCostUsd\":5,\"timeoutMs\":600000,\"autoIdleRatioFloor\":0.5},\"admission\":[{\"gate\":\"feature\",\"status\":\"passed\",\"inputs\":{\"enabled\":true}},{\"gate\":\"owner-idle\",\"status\":\"not-applicable\",\"inputs\":{\"mode\":\"manual\"}},{\"gate\":\"idle-ratio\",\"status\":\"not-applicable\",\"inputs\":{\"mode\":\"manual\"}},{\"gate\":\"source\",\"status\":\"passed\",\"inputs\":{\"rootPath\":\"<repo-root>\",\"repositoryId\":\"papercusp\"}},{\"gate\":\"governor\",\"status\":\"passed\",\"inputs\":{\"allow\":true,\"loopId\":\"dream:papercusp\",\"cycleRemainingUsd\":1,\"rollingSpentUsd\":0,\"rollingRemainingUsd\":5,\"rollingLoopCount\":0,\"config\":{\"maxDreamsPerCycle\":3,\"maxCostUsd\":1,\"rolling24hCostUsd\":5,\"timeoutMs\":600000,\"autoIdleRatioFloor\":0.5},\"source\":\"dream-governor:preflightDreamCycle\"}},{\"gate\":\"continue\",\"status\":\"passed\",\"inputs\":{\"feature\":true,\"active\":true,\"idleAllowed\":true,\"mode\":\"manual\",\"idleObservation\":null}},{\"gate\":\"continue\",\"status\":\"passed\",\"inputs\":{\"feature\":true,\"active\":true,\"idleAllowed\":true,\"mode\":\"manual\",\"idleObservation\":null}},{\"gate\":\"continue\",\"status\":\"refused\",\"inputs\":{\"reason\":\"routine-inactive\",\"rows\":[{\"active\":false}]}}],\"disposition\":\"cycle-result\",\"cycleId\":\"sched-.routinesTick-2026-10-18T02:02:30.000Z-7\",\"attempts\":1,\"costUsd\":0,\"governorReason\":null,\"modelUsageSource\":\"harness_shared.dream_runs\",\"runRefs\":[\"sched-.routinesTick-2026-10-18T02:02:30.000Z-7:dream:1\"]}",
                      "repeat": 1
                    }
                  ],
                  "journalAvailable": true,
                  "journalError": null
                },
                "assessment": {
                  "status": "observed",
                  "value": {
                    "records": [
                      {
                        "schemaVersion": 1,
                        "actionId": "sched-.routinesTick-2026-10-18T02:01:30.000Z-11",
                        "workspaceId": "papercusp-workspace",
                        "potSlug": "papercusp",
                        "capturedAt": "2026-10-18T02:01:43.543Z",
                        "runtime": {
                          "host": "port-3271",
                          "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126",
                          "buildSha": "43a8a5f95d"
                        },
                        "source": "dream/dream-cycle-action:makeDreamCycleAction",
                        "mode": "auto",
                        "reason": "idle-ratio-below-floor",
                        "disposition": "pre-attempt-policy-skip",
                        "costUsd": 0,
                        "cycle": {
                          "maxDreamsPerCycle": 3,
                          "maxCostUsd": 1,
                          "rolling24hCostUsd": 5,
                          "timeoutMs": 600000,
                          "autoIdleRatioFloor": 0.5
                        },
                        "admission": [
                          {
                            "gate": "feature",
                            "status": "passed",
                            "inputs": {
                              "enabled": true
                            }
                          },
                          {
                            "gate": "owner-idle",
                            "status": "passed",
                            "inputs": {
                              "allowed": true,
                              "potSlug": "papercusp",
                              "observation": {
                                "status": "observed",
                                "home": "papercusp",
                                "allowed": true,
                                "steering": {
                                  "directive": null,
                                  "eligiblePlans": [],
                                  "eligibleHives": [],
                                  "includeUnplannedWork": true,
                                  "pauseNewWork": true,
                                  "pausedUntil": null,
                                  "modelTiers": null,
                                  "tierCeilings": {
                                    "cup": "standard",
                                    "mug": "max"
                                  },
                                  "cadenceFloorSec": null,
                                  "maxBees": 1,
                                  "idleActivities": {
                                    "gym": true,
                                    "dream": true
                                  },
                                  "autoScaleOut": null,
                                  "decomposition": "parallel",
                                  "modelOverrides": null,
                                  "federatedPriming": null,
                                  "createWakeSuppressPlans": []
                                }
                              }
                            }
                          },
                          {
                            "gate": "idle-ratio",
                            "status": "refused",
                            "inputs": {
                              "idleRatio": 0,
                              "floor": 0.5
                            }
                          },
                          {
                            "gate": "source",
                            "status": "not-reached",
                            "inputs": {}
                          },
                          {
                            "gate": "governor",
                            "status": "not-reached",
                            "inputs": {}
                          },
                          {
                            "gate": "continue",
                            "status": "not-reached",
                            "inputs": {}
                          }
                        ],
                        "idleRatio": 0,
                        "floor": 0.5,
                        "paidCalls": 0,
                        "model": null,
                        "usage": null
                      },
                      {
                        "schemaVersion": 1,
                        "actionId": "sched-.routinesTick-2026-10-18T02:02:30.000Z-7",
                        "workspaceId": "papercusp-workspace",
                        "potSlug": "papercusp",
                        "capturedAt": "2026-10-18T02:07:07.559Z",
                        "runtime": {
                          "host": "port-3271",
                          "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126",
                          "buildSha": "43a8a5f95d"
                        },
                        "source": "dream/dream-cycle-action:makeDreamCycleAction",
                        "mode": "manual",
                        "reason": "aborted",
                        "disposition": "cycle-result",
                        "costUsd": 0,
                        "cycle": {
                          "maxDreamsPerCycle": 3,
                          "maxCostUsd": 1,
                          "rolling24hCostUsd": 5,
                          "timeoutMs": 600000,
                          "autoIdleRatioFloor": 0.5
                        },
                        "admission": [
                          {
                            "gate": "feature",
                            "status": "passed",
                            "inputs": {
                              "enabled": true
                            }
                          },
                          {
                            "gate": "owner-idle",
                            "status": "not-applicable",
                            "inputs": {
                              "mode": "manual"
                            }
                          },
                          {
                            "gate": "idle-ratio",
                            "status": "not-applicable",
                            "inputs": {
                              "mode": "manual"
                            }
                          },
                          {
                            "gate": "source",
                            "status": "passed",
                            "inputs": {
                              "rootPath": "<repo-root>",
                              "repositoryId": "papercusp"
                            }
                          },
                          {
                            "gate": "governor",
                            "status": "passed",
                            "inputs": {
                              "allow": true,
                              "loopId": "dream:papercusp",
                              "cycleRemainingUsd": 1,
                              "rollingSpentUsd": 0,
                              "rollingRemainingUsd": 5,
                              "rollingLoopCount": 0,
                              "config": {
                                "maxDreamsPerCycle": 3,
                                "maxCostUsd": 1,
                                "rolling24hCostUsd": 5,
                                "timeoutMs": 600000,
                                "autoIdleRatioFloor": 0.5
                              },
                              "source": "dream-governor:preflightDreamCycle"
                            }
                          },
                          {
                            "gate": "continue",
                            "status": "passed",
                            "inputs": {
                              "feature": true,
                              "active": true,
                              "idleAllowed": true,
                              "mode": "manual",
                              "idleObservation": null
                            }
                          },
                          {
                            "gate": "continue",
                            "status": "passed",
                            "inputs": {
                              "feature": true,
                              "active": true,
                              "idleAllowed": true,
                              "mode": "manual",
                              "idleObservation": null
                            }
                          },
                          {
                            "gate": "continue",
                            "status": "refused",
                            "inputs": {
                              "reason": "routine-inactive",
                              "rows": [
                                {
                                  "active": false
                                }
                              ]
                            }
                          }
                        ],
                        "cycleId": "sched-.routinesTick-2026-10-18T02:02:30.000Z-7",
                        "attempts": 1,
                        "governorReason": null,
                        "modelUsageSource": "harness_shared.dream_runs",
                        "runRefs": [
                          "sched-.routinesTick-2026-10-18T02:02:30.000Z-7:dream:1"
                        ]
                      }
                    ],
                    "admission": [
                      {
                        "actionId": "sched-.routinesTick-2026-10-18T02:01:30.000Z-11",
                        "assessment": {
                          "status": "observed",
                          "value": {
                            "allow": false,
                            "reason": "idle-ratio-below-floor",
                            "gates": [
                              {
                                "gate": "feature",
                                "status": "passed",
                                "inputs": {
                                  "enabled": true
                                }
                              },
                              {
                                "gate": "owner-idle",
                                "status": "passed",
                                "inputs": {
                                  "allowed": true,
                                  "potSlug": "papercusp",
                                  "observation": {
                                    "status": "observed",
                                    "home": "papercusp",
                                    "allowed": true,
                                    "steering": {
                                      "directive": null,
                                      "eligiblePlans": [],
                                      "eligibleHives": [],
                                      "includeUnplannedWork": true,
                                      "pauseNewWork": true,
                                      "pausedUntil": null,
                                      "modelTiers": null,
                                      "tierCeilings": {
                                        "cup": "standard",
                                        "mug": "max"
                                      },
                                      "cadenceFloorSec": null,
                                      "maxBees": 1,
                                      "idleActivities": {
                                        "gym": true,
                                        "dream": true
                                      },
                                      "autoScaleOut": null,
                                      "decomposition": "parallel",
                                      "modelOverrides": null,
                                      "federatedPriming": null,
                                      "createWakeSuppressPlans": []
                                    }
                                  }
                                }
                              },
                              {
                                "gate": "idle-ratio",
                                "status": "refused",
                                "inputs": {
                                  "idleRatio": 0,
                                  "floor": 0.5
                                }
                              },
                              {
                                "gate": "source",
                                "status": "not-reached",
                                "inputs": {}
                              },
                              {
                                "gate": "governor",
                                "status": "not-reached",
                                "inputs": {}
                              },
                              {
                                "gate": "continue",
                                "status": "not-reached",
                                "inputs": {}
                              }
                            ],
                            "scope": "actual-production-action"
                          },
                          "sourceRefs": [
                            "dream/dream-cycle-action:makeDreamCycleAction",
                            "dream-governor:preflightDreamCycle"
                          ]
                        }
                      },
                      {
                        "actionId": "sched-.routinesTick-2026-10-18T02:02:30.000Z-7",
                        "assessment": {
                          "status": "observed",
                          "value": {
                            "allow": false,
                            "reason": "continuation-refused",
                            "gates": [
                              {
                                "gate": "feature",
                                "status": "passed",
                                "inputs": {
                                  "enabled": true
                                }
                              },
                              {
                                "gate": "owner-idle",
                                "status": "not-applicable",
                                "inputs": {
                                  "mode": "manual"
                                }
                              },
                              {
                                "gate": "idle-ratio",
                                "status": "not-applicable",
                                "inputs": {
                                  "mode": "manual"
                                }
                              },
                              {
                                "gate": "source",
                                "status": "passed",
                                "inputs": {
                                  "rootPath": "<repo-root>",
                                  "repositoryId": "papercusp"
                                }
                              },
                              {
                                "gate": "governor",
                                "status": "passed",
                                "inputs": {
                                  "allow": true,
                                  "loopId": "dream:papercusp",
                                  "cycleRemainingUsd": 1,
                                  "rollingSpentUsd": 0,
                                  "rollingRemainingUsd": 5,
                                  "rollingLoopCount": 0,
                                  "config": {
                                    "maxDreamsPerCycle": 3,
                                    "maxCostUsd": 1,
                                    "rolling24hCostUsd": 5,
                                    "timeoutMs": 600000,
                                    "autoIdleRatioFloor": 0.5
                                  },
                                  "source": "dream-governor:preflightDreamCycle"
                                }
                              },
                              {
                                "gate": "continue",
                                "status": "passed",
                                "inputs": {
                                  "feature": true,
                                  "active": true,
                                  "idleAllowed": true,
                                  "mode": "manual",
                                  "idleObservation": null
                                }
                              },
                              {
                                "gate": "continue",
                                "status": "passed",
                                "inputs": {
                                  "feature": true,
                                  "active": true,
                                  "idleAllowed": true,
                                  "mode": "manual",
                                  "idleObservation": null
                                }
                              },
                              {
                                "gate": "continue",
                                "status": "refused",
                                "inputs": {
                                  "reason": "routine-inactive",
                                  "rows": [
                                    {
                                      "active": false
                                    }
                                  ]
                                }
                              }
                            ],
                            "scope": "actual-production-action"
                          },
                          "sourceRefs": [
                            "dream/dream-cycle-action:makeDreamCycleAction",
                            "dream-governor:preflightDreamCycle"
                          ]
                        }
                      }
                    ],
                    "modelUsage": "follow-dream-run-ledger"
                  },
                  "sourceRefs": [
                    "journal:readJournal",
                    "dream/dream-cycle-action:makeDreamCycleAction"
                  ]
                }
              },
              "sourceRefs": [
                "journal:readJournal"
              ]
            },
            "gymDecisions": {
              "status": "observed",
              "value": {
                "journal": {
                  "matched": 0,
                  "collapsed": 0,
                  "truncated": false,
                  "window": {
                    "since": "@1792288800",
                    "until": "@1792289547.042",
                    "resolved": {
                      "sinceUtc": "2026-10-18T02:00:00.000Z",
                      "untilUtc": "2026-10-18T02:12:27.042Z",
                      "untilRequested": true,
                      "hostUtcOffsetMinutes": -240,
                      "invertedHint": null
                    }
                  },
                  "units": [
                    "papercusp-bg-host.service"
                  ],
                  "unitsUnknown": [],
                  "unitsHistorical": [],
                  "historicalCommand": null,
                  "windowOutsideJournal": null,
                  "command": "journalctl --user --no-pager -o json --output-fields=__REALTIME_TIMESTAMP,_SYSTEMD_USER_UNIT,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER,PRIORITY,MESSAGE -u papercusp-bg-host.service --since @1792288800 --until @1792289547.042 --grep GYM_ADMISSION_DECISION  --case-sensitive=false -n 1001",
                  "backend": "systemd",
                  "entries": [],
                  "journalAvailable": true,
                  "journalError": null
                },
                "assessment": {
                  "status": "unknown",
                  "value": null,
                  "reason": "no-actual-gym-admission-records",
                  "sourceRefs": [
                    "journal:readJournal",
                    "gym/autoloop-tick:runGymAutoloopTick",
                    "harness/routines/gym-actions:runGymCycleInline"
                  ]
                }
              },
              "sourceRefs": [
                "journal:readJournal"
              ]
            },
            "productionAdmission": {
              "status": "unknown",
              "value": null,
              "reason": "complete-dream-and-gym-production-decisions-required",
              "sourceRefs": [
                "journal:readJournal"
              ]
            },
            "r2Assertions": {
              "schemaVersion": 1,
              "healthy": false,
              "clauses": [
                {
                  "id": "r2:dream-action-decisions",
                  "status": "pass",
                  "healthy": true,
                  "reason": "actual-complete-dream-decisions",
                  "rawRefs": [
                    "/actionDecisions"
                  ],
                  "sourceRefs": [
                    "journal:readJournal",
                    "dream/dream-cycle-action:makeDreamCycleAction"
                  ],
                  "scope": {
                    "workspaceId": "papercusp-workspace",
                    "potSlug": "papercusp",
                    "since": "2026-10-18T02:00:00.000Z",
                    "until": "2026-10-18T02:12:27.042109Z",
                    "expectedRuntime": {
                      "host": "port-3170",
                      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274",
                      "buildSha": "258ed96687"
                    },
                    "actionJournalUnit": "papercusp-bg-host.service",
                    "expectedActionRuntime": {
                      "host": "port-3271",
                      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126",
                      "buildSha": "43a8a5f95d"
                    },
                    "gymJournalUnit": "papercusp-bg-host.service",
                    "expectedGymRuntime": {
                      "host": "port-3271",
                      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126",
                      "buildSha": "43a8a5f95d"
                    }
                  },
                  "source": {
                    "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
                    "runtime": {
                      "host": "port-3170",
                      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274",
                      "buildSha": "258ed96687"
                    }
                  },
                  "capturedAt": "2026-10-18T02:12:30.645Z",
                  "expiresAt": "2026-10-18T02:13:30.645Z"
                },
                {
                  "id": "r2:gym-admission-decisions",
                  "status": "unknown",
                  "healthy": false,
                  "reason": "no-actual-gym-admission-records",
                  "rawRefs": [
                    "/gymDecisions"
                  ],
                  "sourceRefs": [
                    "journal:readJournal",
                    "gym/autoloop-tick:runGymAutoloopTick"
                  ],
                  "scope": {
                    "workspaceId": "papercusp-workspace",
                    "potSlug": "papercusp",
                    "since": "2026-10-18T02:00:00.000Z",
                    "until": "2026-10-18T02:12:27.042109Z",
                    "expectedRuntime": {
                      "host": "port-3170",
                      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274",
                      "buildSha": "258ed96687"
                    },
                    "actionJournalUnit": "papercusp-bg-host.service",
                    "expectedActionRuntime": {
                      "host": "port-3271",
                      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126",
                      "buildSha": "43a8a5f95d"
                    },
                    "gymJournalUnit": "papercusp-bg-host.service",
                    "expectedGymRuntime": {
                      "host": "port-3271",
                      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126",
                      "buildSha": "43a8a5f95d"
                    }
                  },
                  "source": {
                    "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
                    "runtime": {
                      "host": "port-3170",
                      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274",
                      "buildSha": "258ed96687"
                    }
                  },
                  "capturedAt": "2026-10-18T02:12:30.645Z",
                  "expiresAt": "2026-10-18T02:13:30.645Z"
                },
                {
                  "id": "r2:full-admission-and-spend",
                  "status": "unknown",
                  "healthy": false,
                  "reason": "complete-production-admission-and-spend-required",
                  "rawRefs": [
                    "/productionAdmission",
                    "/observations/governors",
                    "/observations/rollingSpend"
                  ],
                  "sourceRefs": [
                    "dream-governor:preflightDreamCycle",
                    "learning-governor:checkLoopVerdict",
                    "dream-governor:sumDreamSpendSince"
                  ],
                  "scope": {
                    "workspaceId": "papercusp-workspace",
                    "potSlug": "papercusp",
                    "since": "2026-10-18T02:00:00.000Z",
                    "until": "2026-10-18T02:12:27.042109Z",
                    "expectedRuntime": {
                      "host": "port-3170",
                      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274",
                      "buildSha": "258ed96687"
                    },
                    "actionJournalUnit": "papercusp-bg-host.service",
                    "expectedActionRuntime": {
                      "host": "port-3271",
                      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126",
                      "buildSha": "43a8a5f95d"
                    },
                    "gymJournalUnit": "papercusp-bg-host.service",
                    "expectedGymRuntime": {
                      "host": "port-3271",
                      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126",
                      "buildSha": "43a8a5f95d"
                    }
                  },
                  "source": {
                    "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
                    "runtime": {
                      "host": "port-3170",
                      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274",
                      "buildSha": "258ed96687"
                    }
                  },
                  "capturedAt": "2026-10-18T02:12:30.645Z",
                  "expiresAt": "2026-10-18T02:13:30.645Z"
                },
                {
                  "id": "r2:scout-zero-route-lens-cap-provenance",
                  "status": "unknown",
                  "healthy": false,
                  "reason": "qualifying-complete-scout-cap-lens-origin-window-required",
                  "rawRefs": [
                    "/observations/activity/value/scout"
                  ],
                  "sourceRefs": [
                    "harness_shared.scout_ticks",
                    "scout/scheduler:runScoutTick",
                    "scout/run:runScoutCycleTick"
                  ],
                  "scope": {
                    "workspaceId": "papercusp-workspace",
                    "potSlug": "papercusp",
                    "since": "2026-10-18T02:00:00.000Z",
                    "until": "2026-10-18T02:12:27.042109Z",
                    "expectedRuntime": {
                      "host": "port-3170",
                      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274",
                      "buildSha": "258ed96687"
                    },
                    "actionJournalUnit": "papercusp-bg-host.service",
                    "expectedActionRuntime": {
                      "host": "port-3271",
                      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126",
                      "buildSha": "43a8a5f95d"
                    },
                    "gymJournalUnit": "papercusp-bg-host.service",
                    "expectedGymRuntime": {
                      "host": "port-3271",
                      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126",
                      "buildSha": "43a8a5f95d"
                    }
                  },
                  "source": {
                    "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
                    "runtime": {
                      "host": "port-3170",
                      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274",
                      "buildSha": "258ed96687"
                    }
                  },
                  "capturedAt": "2026-10-18T02:12:30.645Z",
                  "expiresAt": "2026-10-18T02:13:30.645Z"
                },
                {
                  "id": "r2:actual-attempts-or-explicit-policy-skips",
                  "status": "unknown",
                  "healthy": false,
                  "reason": "actual-attempt-usage-or-explicit-policy-skip-required",
                  "rawRefs": [
                    "/actionDecisions",
                    "/observations/activity/value/dream"
                  ],
                  "sourceRefs": [
                    "dream/dream-cycle-action:makeDreamCycleAction",
                    "harness_shared.dream_runs"
                  ],
                  "scope": {
                    "workspaceId": "papercusp-workspace",
                    "potSlug": "papercusp",
                    "since": "2026-10-18T02:00:00.000Z",
                    "until": "2026-10-18T02:12:27.042109Z",
                    "expectedRuntime": {
                      "host": "port-3170",
                      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274",
                      "buildSha": "258ed96687"
                    },
                    "actionJournalUnit": "papercusp-bg-host.service",
                    "expectedActionRuntime": {
                      "host": "port-3271",
                      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126",
                      "buildSha": "43a8a5f95d"
                    },
                    "gymJournalUnit": "papercusp-bg-host.service",
                    "expectedGymRuntime": {
                      "host": "port-3271",
                      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126",
                      "buildSha": "43a8a5f95d"
                    }
                  },
                  "source": {
                    "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
                    "runtime": {
                      "host": "port-3170",
                      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274",
                      "buildSha": "258ed96687"
                    }
                  },
                  "capturedAt": "2026-10-18T02:12:30.645Z",
                  "expiresAt": "2026-10-18T02:13:30.645Z"
                }
              ]
            }
          }
        ],
        "version": "1792289550806",
        "timing": {
          "unit": "ms",
          "resolverStartedAtMs": 1792289547084,
          "resolverCompletedAtMs": 1792289550806,
          "resolverMs": 3722
        }
      }
    }
  },
  "expectedBackgroundRuntime": {
    "host": "port-3271",
    "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107770126",
    "buildSha": "43a8a5f95d"
  },
  "commitBindingArtifact": "verification/WI-6554700010017071/2026-10-18-commit-258ed96687e4-binding-v1.json"
}

