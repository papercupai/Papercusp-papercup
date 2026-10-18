---
rel_path: "verification/WI-6554700010016963/2026-10-18-fire23-query-timeout.json"
updated_at: 1792283724622
_body: "content"
---

{
  "captureFailed": true,
  "startedAt": "2026-10-18T00:34:21.546Z",
  "failedAt": "2026-10-18T00:34:37.018Z",
  "stage": "observation-response",
  "response": {
    "httpStatus": 500,
    "requestId": "9e2c7206-6df4-41ae-bdde-7206ac9d81e7",
    "body": {
      "error": "query \"learning.dream\" did not resolve within 10000ms (resolver timeout)",
      "name": "learning.dream"
    }
  },
  "readerDiscovery": {
    "httpStatus": 200,
    "requestId": "7792646a-7364-44ce-abb8-f869cc180bd7",
    "body": {
      "rows": [
        {
          "schemaVersion": "dream-control-observations-v1",
          "status": "unknown",
          "reason": "wrong-or-unproven-serving-runtime",
          "scope": {
            "workspaceId": "papercusp-workspace",
            "potSlug": "papercusp",
            "since": "2026-10-18T00:00:00.000Z",
            "until": "2026-10-18T00:34:21.762Z",
            "expectedRuntime": {
              "host": "identity-discovery",
              "processId": "identity-discovery",
              "buildSha": "identity-discovery"
            }
          },
          "runtime": {
            "host": "port-3170",
            "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107195916",
            "buildSha": "a37ab596aa"
          },
          "capturedAt": "2026-10-18T00:34:22.802Z",
          "expiresAt": "2026-10-18T00:35:22.802Z",
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
                  "since": "2026-10-18T00:00:00.000Z",
                  "until": "2026-10-18T00:34:21.762Z",
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
                    "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107195916",
                    "buildSha": "a37ab596aa"
                  }
                },
                "capturedAt": "2026-10-18T00:34:22.802Z",
                "expiresAt": "2026-10-18T00:35:22.802Z"
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
                  "since": "2026-10-18T00:00:00.000Z",
                  "until": "2026-10-18T00:34:21.762Z",
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
                    "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107195916",
                    "buildSha": "a37ab596aa"
                  }
                },
                "capturedAt": "2026-10-18T00:34:22.802Z",
                "expiresAt": "2026-10-18T00:35:22.802Z"
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
                  "since": "2026-10-18T00:00:00.000Z",
                  "until": "2026-10-18T00:34:21.762Z",
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
                    "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107195916",
                    "buildSha": "a37ab596aa"
                  }
                },
                "capturedAt": "2026-10-18T00:34:22.802Z",
                "expiresAt": "2026-10-18T00:35:22.802Z"
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
                  "since": "2026-10-18T00:00:00.000Z",
                  "until": "2026-10-18T00:34:21.762Z",
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
                    "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107195916",
                    "buildSha": "a37ab596aa"
                  }
                },
                "capturedAt": "2026-10-18T00:34:22.802Z",
                "expiresAt": "2026-10-18T00:35:22.802Z"
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
                  "since": "2026-10-18T00:00:00.000Z",
                  "until": "2026-10-18T00:34:21.762Z",
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
                    "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107195916",
                    "buildSha": "a37ab596aa"
                  }
                },
                "capturedAt": "2026-10-18T00:34:22.802Z",
                "expiresAt": "2026-10-18T00:35:22.802Z"
              }
            ]
          }
        }
      ],
      "version": "1792283662806",
      "timing": {
        "unit": "ms",
        "resolverStartedAtMs": 1792283662770,
        "resolverCompletedAtMs": 1792283662806,
        "resolverMs": 36
      }
    }
  },
  "actionDiscovery": {
    "httpStatus": 200,
    "requestId": "9c6d4f73-07ba-435f-8bb7-583d9b974fdb",
    "body": {
      "rows": [
        {
          "schemaVersion": "dream-control-observations-v1",
          "status": "unknown",
          "reason": "wrong-or-unproven-serving-runtime",
          "scope": {
            "workspaceId": "papercusp-workspace",
            "potSlug": "papercusp",
            "since": "2026-10-18T00:00:00.000Z",
            "until": "2026-10-18T00:34:21.762Z",
            "expectedRuntime": {
              "host": "identity-discovery",
              "processId": "identity-discovery",
              "buildSha": "identity-discovery"
            }
          },
          "runtime": {
            "host": "port-3271",
            "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107063275",
            "buildSha": "a37ab596aa"
          },
          "capturedAt": "2026-10-18T00:34:24.550Z",
          "expiresAt": "2026-10-18T00:35:24.550Z",
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
                  "since": "2026-10-18T00:00:00.000Z",
                  "until": "2026-10-18T00:34:21.762Z",
                  "expectedRuntime": {
                    "host": "identity-discovery",
                    "processId": "identity-discovery",
                    "buildSha": "identity-discovery"
                  }
                },
                "source": {
                  "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
                  "runtime": {
                    "host": "port-3271",
                    "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107063275",
                    "buildSha": "a37ab596aa"
                  }
                },
                "capturedAt": "2026-10-18T00:34:24.550Z",
                "expiresAt": "2026-10-18T00:35:24.550Z"
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
                  "since": "2026-10-18T00:00:00.000Z",
                  "until": "2026-10-18T00:34:21.762Z",
                  "expectedRuntime": {
                    "host": "identity-discovery",
                    "processId": "identity-discovery",
                    "buildSha": "identity-discovery"
                  }
                },
                "source": {
                  "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
                  "runtime": {
                    "host": "port-3271",
                    "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107063275",
                    "buildSha": "a37ab596aa"
                  }
                },
                "capturedAt": "2026-10-18T00:34:24.550Z",
                "expiresAt": "2026-10-18T00:35:24.550Z"
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
                  "since": "2026-10-18T00:00:00.000Z",
                  "until": "2026-10-18T00:34:21.762Z",
                  "expectedRuntime": {
                    "host": "identity-discovery",
                    "processId": "identity-discovery",
                    "buildSha": "identity-discovery"
                  }
                },
                "source": {
                  "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
                  "runtime": {
                    "host": "port-3271",
                    "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107063275",
                    "buildSha": "a37ab596aa"
                  }
                },
                "capturedAt": "2026-10-18T00:34:24.550Z",
                "expiresAt": "2026-10-18T00:35:24.550Z"
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
                  "since": "2026-10-18T00:00:00.000Z",
                  "until": "2026-10-18T00:34:21.762Z",
                  "expectedRuntime": {
                    "host": "identity-discovery",
                    "processId": "identity-discovery",
                    "buildSha": "identity-discovery"
                  }
                },
                "source": {
                  "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
                  "runtime": {
                    "host": "port-3271",
                    "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107063275",
                    "buildSha": "a37ab596aa"
                  }
                },
                "capturedAt": "2026-10-18T00:34:24.550Z",
                "expiresAt": "2026-10-18T00:35:24.550Z"
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
                  "since": "2026-10-18T00:00:00.000Z",
                  "until": "2026-10-18T00:34:21.762Z",
                  "expectedRuntime": {
                    "host": "identity-discovery",
                    "processId": "identity-discovery",
                    "buildSha": "identity-discovery"
                  }
                },
                "source": {
                  "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
                  "runtime": {
                    "host": "port-3271",
                    "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107063275",
                    "buildSha": "a37ab596aa"
                  }
                },
                "capturedAt": "2026-10-18T00:34:24.550Z",
                "expiresAt": "2026-10-18T00:35:24.550Z"
              }
            ]
          }
        }
      ],
      "version": "1792283664578",
      "timing": {
        "unit": "ms",
        "resolverStartedAtMs": 1792283664177,
        "resolverCompletedAtMs": 1792283664577,
        "resolverMs": 400
      }
    }
  },
  "query": {
    "potSlug": "papercusp",
    "view": "observations",
    "since": "2026-10-18T00:00:00.000Z",
    "until": "2026-10-18T00:34:21.762Z",
    "expectedRuntime": {
      "host": "port-3170",
      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107195916",
      "buildSha": "a37ab596aa"
    },
    "actionJournalUnit": "papercup-bg-host.service",
    "expectedActionRuntime": {
      "host": "port-3271",
      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107063275",
      "buildSha": "a37ab596aa"
    },
    "gymJournalUnit": "papercup-bg-host.service",
    "expectedGymRuntime": {
      "host": "port-3271",
      "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107063275",
      "buildSha": "a37ab596aa"
    }
  }
}
