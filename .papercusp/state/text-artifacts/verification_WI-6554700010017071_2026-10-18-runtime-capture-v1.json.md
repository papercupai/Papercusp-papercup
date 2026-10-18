---
rel_path: "verification/WI-6554700010017071/2026-10-18-runtime-capture-v1.json"
updated_at: 1792288673151
_body: "content"
---

{
  "artifact": "wi17071-runtime-capture-v1",
  "artifactSha256": "f4b8759a9a07bf2df0bc26775faf66cb078a00942b6b864ee247260bb0674b4d",
  "capturedAt": "2026-10-18T01:55:02.555Z",
  "commitBinding": {
    "all22CommittedMatch": true,
    "all22WorkingMatch": true,
    "bindingArtifact": "verification/WI-6554700010017071/2026-10-18-commit-258ed96687e4-binding-v1.json",
    "commit": "258ed96687e4c7cb9c2a44f2f15cb8abf2ae0e15",
    "manifest": "verification/WI-6554700010017071/2026-10-18-journal-deadline-source-v1.json"
  },
  "expiresAt": "2026-10-18T01:56:02.555Z",
  "interpretation": {
    "clauseStatuses": [
      [
        "r2:dream-action-decisions",
        "unknown",
        "incomplete-dream-decisions"
      ],
      [
        "r2:gym-admission-decisions",
        "unknown",
        "gym-decisions-not-observed"
      ],
      [
        "r2:full-admission-and-spend",
        "unknown",
        "complete-production-admission-and-spend-required"
      ],
      [
        "r2:scout-zero-route-lens-cap-provenance",
        "unknown",
        "qualifying-complete-scout-cap-lens-origin-window-required"
      ],
      [
        "r2:actual-attempts-or-explicit-policy-skips",
        "unknown",
        "actual-attempt-usage-or-explicit-policy-skip-required"
      ]
    ],
    "methodObserved": true,
    "productR2Healthy": false,
    "scopeLimit": "Exact current :3170 runtime and 00:00Z through capture window; no shipment or approval claim."
  },
  "probeRuntime": {
    "buildSha": "258ed96687",
    "host": "port-3170",
    "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
  },
  "request": {
    "args": {
      "actionJournalUnit": "papercusp-bg-host.service",
      "expectedActionRuntime": {
        "buildSha": "258ed96687",
        "host": "port-3170",
        "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
      },
      "expectedGymRuntime": {
        "buildSha": "258ed96687",
        "host": "port-3170",
        "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
      },
      "expectedRuntime": {
        "buildSha": "258ed96687",
        "host": "port-3170",
        "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
      },
      "gymJournalUnit": "papercusp-bg-host.service",
      "potSlug": "papercusp",
      "since": "2026-10-18T00:00:00.000Z",
      "until": "2026-10-18T01:54:56.442Z",
      "view": "observations"
    },
    "endpoint": "http://127.0.0.1:3170/api/zero-harness/rest-query",
    "queryName": "learning.dream"
  },
  "response": {
    "rows": [
      {
        "actionDecisions": {
          "reason": "dream-action-journal exceeded the read budget",
          "sourceRefs": [
            "journal:readJournal"
          ],
          "status": "unknown",
          "value": null
        },
        "capturedAt": "2026-10-18T01:55:02.555Z",
        "expiresAt": "2026-10-18T01:56:02.555Z",
        "gymDecisions": {
          "reason": "gym-admission-journal exceeded the read budget",
          "sourceRefs": [
            "journal:readJournal"
          ],
          "status": "unknown",
          "value": null
        },
        "observations": {
          "activity": {
            "sourceRefs": [
              "harness_shared.dream_runs",
              "harness_shared.scout_ticks"
            ],
            "status": "observed",
            "value": {
              "dream": {
                "hasMore": false,
                "limit": 20,
                "population": "bounded-window-rows",
                "rows": []
              },
              "modelExecution": "not-established",
              "outputQuality": "not-evaluated",
              "preLedgerPolicySkips": "not-recorded-in-attempt-ledger",
              "scout": {
                "hasMore": false,
                "limit": 20,
                "observations": [
                  {
                    "budgetProvenance": {
                      "resolved": {
                        "maxCostUsd": 5,
                        "maxCriticsPerIdea": 2,
                        "maxIdeators": 2
                      },
                      "schemaVersion": 1,
                      "status": "observed",
                      "supplied": {
                        "maxCostUsd": 5,
                        "maxCriticsPerIdea": 2,
                        "maxIdeators": 2
                      }
                    },
                    "costUsd": null,
                    "ideasRouted": 0,
                    "ideatorCount": null,
                    "lenses": null,
                    "modelUsage": "not-established",
                    "oneIdeatorZeroRoute": null,
                    "origin": "scout",
                    "raw": {
                      "budget_used_usd": null,
                      "detail": {
                        "admissionThrottle": {
                          "latencySampleSize": 39,
                          "level": "deep",
                          "maxIdeators": 1,
                          "p95Ms": 537753719.1501001,
                          "pending": 288,
                          "reasons": [
                            "pending 288 exceeds two promoter batches (40)",
                            "claim-latency p95 537753719ms exceeds 10800000ms"
                          ],
                          "source": "p005-queue-health"
                        },
                        "budgetProvenance": {
                          "resolved": {
                            "maxCostUsd": 5,
                            "maxCriticsPerIdea": 2,
                            "maxIdeators": 2
                          },
                          "schemaVersion": 1,
                          "supplied": {
                            "maxCostUsd": 5,
                            "maxCriticsPerIdea": 2,
                            "maxIdeators": 2
                          }
                        },
                        "hostBuildSha": "43a8a5f95d",
                        "p95Ms": 537753719.1501001,
                        "pending": 288,
                        "reason": "admission-throttle-deep",
                        "throttleReasons": [
                          "pending 288 exceeds two promoter batches (40)",
                          "claim-latency p95 537753719ms exceeds 10800000ms"
                        ]
                      },
                      "gate": "generation-preflight",
                      "id": "4288",
                      "ideas_generated": 0,
                      "ideas_routed": 0,
                      "install_slug": "papercusp-workspace",
                      "origin": "scout",
                      "pot_slug": "papercusp",
                      "status": "gated",
                      "tick_at": "2026-10-17 21:33:31.799934-04",
                      "workspace_id": "papercusp-workspace"
                    },
                    "suppliedOneIdeatorCapRespected": null
                  },
                  {
                    "budgetProvenance": {
                      "resolved": {
                        "maxCostUsd": 5,
                        "maxCriticsPerIdea": 2,
                        "maxIdeators": 2
                      },
                      "schemaVersion": 1,
                      "status": "observed",
                      "supplied": {
                        "maxCostUsd": 5,
                        "maxCriticsPerIdea": 2,
                        "maxIdeators": 2
                      }
                    },
                    "costUsd": null,
                    "ideasRouted": 0,
                    "ideatorCount": null,
                    "lenses": null,
                    "modelUsage": "not-established",
                    "oneIdeatorZeroRoute": null,
                    "origin": "scout",
                    "raw": {
                      "budget_used_usd": null,
                      "detail": {
                        "admissionThrottle": {
                          "latencySampleSize": 40,
                          "level": "deep",
                          "maxIdeators": 1,
                          "p95Ms": 534194875.6200498,
                          "pending": 281,
                          "reasons": [
                            "pending 281 exceeds two promoter batches (40)",
                            "claim-latency p95 534194876ms exceeds 10800000ms"
                          ],
                          "source": "p005-queue-health"
                        },
                        "budgetProvenance": {
                          "resolved": {
                            "maxCostUsd": 5,
                            "maxCriticsPerIdea": 2,
                            "maxIdeators": 2
                          },
                          "schemaVersion": 1,
                          "supplied": {
                            "maxCostUsd": 5,
                            "maxCriticsPerIdea": 2,
                            "maxIdeators": 2
                          }
                        },
                        "hostBuildSha": "43a8a5f95d",
                        "p95Ms": 534194875.6200498,
                        "pending": 281,
                        "reason": "admission-throttle-deep",
                        "throttleReasons": [
                          "pending 281 exceeds two promoter batches (40)",
                          "claim-latency p95 534194876ms exceeds 10800000ms"
                        ]
                      },
                      "gate": "generation-preflight",
                      "id": "4287",
                      "ideas_generated": 0,
                      "ideas_routed": 0,
                      "install_slug": "papercusp-workspace",
                      "origin": "scout",
                      "pot_slug": "papercusp",
                      "status": "gated",
                      "tick_at": "2026-10-17 21:25:50.457179-04",
                      "workspace_id": "papercusp-workspace"
                    },
                    "suppliedOneIdeatorCapRespected": null
                  },
                  {
                    "budgetProvenance": {
                      "resolved": {
                        "maxCostUsd": 5,
                        "maxCriticsPerIdea": 2,
                        "maxIdeators": 2
                      },
                      "schemaVersion": 1,
                      "status": "observed",
                      "supplied": {
                        "maxCostUsd": 5,
                        "maxCriticsPerIdea": 2,
                        "maxIdeators": 2
                      }
                    },
                    "costUsd": null,
                    "ideasRouted": 0,
                    "ideatorCount": null,
                    "lenses": null,
                    "modelUsage": "not-established",
                    "oneIdeatorZeroRoute": null,
                    "origin": "scout",
                    "raw": {
                      "budget_used_usd": null,
                      "detail": {
                        "admissionThrottle": {
                          "latencySampleSize": 106,
                          "level": "deep",
                          "maxIdeators": 1,
                          "p95Ms": 209367194.10474998,
                          "pending": 264,
                          "reasons": [
                            "pending 264 exceeds two promoter batches (40)",
                            "claim-latency p95 209367194ms exceeds 10800000ms"
                          ],
                          "source": "p005-queue-health"
                        },
                        "budgetProvenance": {
                          "resolved": {
                            "maxCostUsd": 5,
                            "maxCriticsPerIdea": 2,
                            "maxIdeators": 2
                          },
                          "schemaVersion": 1,
                          "supplied": {
                            "maxCostUsd": 5,
                            "maxCriticsPerIdea": 2,
                            "maxIdeators": 2
                          }
                        },
                        "hostBuildSha": "a37ab596aa",
                        "p95Ms": 209367194.10474998,
                        "pending": 264,
                        "reason": "admission-throttle-deep",
                        "throttleReasons": [
                          "pending 264 exceeds two promoter batches (40)",
                          "claim-latency p95 209367194ms exceeds 10800000ms"
                        ]
                      },
                      "gate": "generation-preflight",
                      "id": "4286",
                      "ideas_generated": 0,
                      "ideas_routed": 0,
                      "install_slug": "papercusp-workspace",
                      "origin": "scout",
                      "pot_slug": "papercusp",
                      "status": "gated",
                      "tick_at": "2026-10-17 20:30:22.619042-04",
                      "workspace_id": "papercusp-workspace"
                    },
                    "suppliedOneIdeatorCapRespected": null
                  },
                  {
                    "budgetProvenance": {
                      "resolved": {
                        "maxCostUsd": 5,
                        "maxCriticsPerIdea": 2,
                        "maxIdeators": 2
                      },
                      "schemaVersion": 1,
                      "status": "observed",
                      "supplied": {
                        "maxCostUsd": 5,
                        "maxCriticsPerIdea": 2,
                        "maxIdeators": 2
                      }
                    },
                    "costUsd": null,
                    "ideasRouted": 0,
                    "ideatorCount": null,
                    "lenses": null,
                    "modelUsage": "not-established",
                    "oneIdeatorZeroRoute": null,
                    "origin": "scout",
                    "raw": {
                      "budget_used_usd": null,
                      "detail": {
                        "admissionThrottle": {
                          "latencySampleSize": 119,
                          "level": "deep",
                          "maxIdeators": 1,
                          "p95Ms": 235499437.5902,
                          "pending": 255,
                          "reasons": [
                            "pending 255 exceeds two promoter batches (40)",
                            "claim-latency p95 235499438ms exceeds 10800000ms"
                          ],
                          "source": "p005-queue-health"
                        },
                        "budgetProvenance": {
                          "resolved": {
                            "maxCostUsd": 5,
                            "maxCriticsPerIdea": 2,
                            "maxIdeators": 2
                          },
                          "schemaVersion": 1,
                          "supplied": {
                            "maxCostUsd": 5,
                            "maxCriticsPerIdea": 2,
                            "maxIdeators": 2
                          }
                        },
                        "hostBuildSha": "a37ab596aa",
                        "p95Ms": 235499437.5902,
                        "pending": 255,
                        "reason": "admission-throttle-deep",
                        "throttleReasons": [
                          "pending 255 exceeds two promoter batches (40)",
                          "claim-latency p95 235499438ms exceeds 10800000ms"
                        ]
                      },
                      "gate": "generation-preflight",
                      "id": "4285",
                      "ideas_generated": 0,
                      "ideas_routed": 0,
                      "install_slug": "papercusp-workspace",
                      "origin": "scout",
                      "pot_slug": "papercusp",
                      "status": "gated",
                      "tick_at": "2026-10-17 20:07:11.983066-04",
                      "workspace_id": "papercusp-workspace"
                    },
                    "suppliedOneIdeatorCapRespected": null
                  }
                ],
                "population": "bounded-window-rows",
                "rows": [
                  {
                    "budget_used_usd": null,
                    "detail": {
                      "admissionThrottle": {
                        "latencySampleSize": 39,
                        "level": "deep",
                        "maxIdeators": 1,
                        "p95Ms": 537753719.1501001,
                        "pending": 288,
                        "reasons": [
                          "pending 288 exceeds two promoter batches (40)",
                          "claim-latency p95 537753719ms exceeds 10800000ms"
                        ],
                        "source": "p005-queue-health"
                      },
                      "budgetProvenance": {
                        "resolved": {
                          "maxCostUsd": 5,
                          "maxCriticsPerIdea": 2,
                          "maxIdeators": 2
                        },
                        "schemaVersion": 1,
                        "supplied": {
                          "maxCostUsd": 5,
                          "maxCriticsPerIdea": 2,
                          "maxIdeators": 2
                        }
                      },
                      "hostBuildSha": "43a8a5f95d",
                      "p95Ms": 537753719.1501001,
                      "pending": 288,
                      "reason": "admission-throttle-deep",
                      "throttleReasons": [
                        "pending 288 exceeds two promoter batches (40)",
                        "claim-latency p95 537753719ms exceeds 10800000ms"
                      ]
                    },
                    "gate": "generation-preflight",
                    "id": "4288",
                    "ideas_generated": 0,
                    "ideas_routed": 0,
                    "install_slug": "papercusp-workspace",
                    "origin": "scout",
                    "pot_slug": "papercusp",
                    "status": "gated",
                    "tick_at": "2026-10-17 21:33:31.799934-04",
                    "workspace_id": "papercusp-workspace"
                  },
                  {
                    "budget_used_usd": null,
                    "detail": {
                      "admissionThrottle": {
                        "latencySampleSize": 40,
                        "level": "deep",
                        "maxIdeators": 1,
                        "p95Ms": 534194875.6200498,
                        "pending": 281,
                        "reasons": [
                          "pending 281 exceeds two promoter batches (40)",
                          "claim-latency p95 534194876ms exceeds 10800000ms"
                        ],
                        "source": "p005-queue-health"
                      },
                      "budgetProvenance": {
                        "resolved": {
                          "maxCostUsd": 5,
                          "maxCriticsPerIdea": 2,
                          "maxIdeators": 2
                        },
                        "schemaVersion": 1,
                        "supplied": {
                          "maxCostUsd": 5,
                          "maxCriticsPerIdea": 2,
                          "maxIdeators": 2
                        }
                      },
                      "hostBuildSha": "43a8a5f95d",
                      "p95Ms": 534194875.6200498,
                      "pending": 281,
                      "reason": "admission-throttle-deep",
                      "throttleReasons": [
                        "pending 281 exceeds two promoter batches (40)",
                        "claim-latency p95 534194876ms exceeds 10800000ms"
                      ]
                    },
                    "gate": "generation-preflight",
                    "id": "4287",
                    "ideas_generated": 0,
                    "ideas_routed": 0,
                    "install_slug": "papercusp-workspace",
                    "origin": "scout",
                    "pot_slug": "papercusp",
                    "status": "gated",
                    "tick_at": "2026-10-17 21:25:50.457179-04",
                    "workspace_id": "papercusp-workspace"
                  },
                  {
                    "budget_used_usd": null,
                    "detail": {
                      "admissionThrottle": {
                        "latencySampleSize": 106,
                        "level": "deep",
                        "maxIdeators": 1,
                        "p95Ms": 209367194.10474998,
                        "pending": 264,
                        "reasons": [
                          "pending 264 exceeds two promoter batches (40)",
                          "claim-latency p95 209367194ms exceeds 10800000ms"
                        ],
                        "source": "p005-queue-health"
                      },
                      "budgetProvenance": {
                        "resolved": {
                          "maxCostUsd": 5,
                          "maxCriticsPerIdea": 2,
                          "maxIdeators": 2
                        },
                        "schemaVersion": 1,
                        "supplied": {
                          "maxCostUsd": 5,
                          "maxCriticsPerIdea": 2,
                          "maxIdeators": 2
                        }
                      },
                      "hostBuildSha": "a37ab596aa",
                      "p95Ms": 209367194.10474998,
                      "pending": 264,
                      "reason": "admission-throttle-deep",
                      "throttleReasons": [
                        "pending 264 exceeds two promoter batches (40)",
                        "claim-latency p95 209367194ms exceeds 10800000ms"
                      ]
                    },
                    "gate": "generation-preflight",
                    "id": "4286",
                    "ideas_generated": 0,
                    "ideas_routed": 0,
                    "install_slug": "papercusp-workspace",
                    "origin": "scout",
                    "pot_slug": "papercusp",
                    "status": "gated",
                    "tick_at": "2026-10-17 20:30:22.619042-04",
                    "workspace_id": "papercusp-workspace"
                  },
                  {
                    "budget_used_usd": null,
                    "detail": {
                      "admissionThrottle": {
                        "latencySampleSize": 119,
                        "level": "deep",
                        "maxIdeators": 1,
                        "p95Ms": 235499437.5902,
                        "pending": 255,
                        "reasons": [
                          "pending 255 exceeds two promoter batches (40)",
                          "claim-latency p95 235499438ms exceeds 10800000ms"
                        ],
                        "source": "p005-queue-health"
                      },
                      "budgetProvenance": {
                        "resolved": {
                          "maxCostUsd": 5,
                          "maxCriticsPerIdea": 2,
                          "maxIdeators": 2
                        },
                        "schemaVersion": 1,
                        "supplied": {
                          "maxCostUsd": 5,
                          "maxCriticsPerIdea": 2,
                          "maxIdeators": 2
                        }
                      },
                      "hostBuildSha": "a37ab596aa",
                      "p95Ms": 235499437.5902,
                      "pending": 255,
                      "reason": "admission-throttle-deep",
                      "throttleReasons": [
                        "pending 255 exceeds two promoter batches (40)",
                        "claim-latency p95 235499438ms exceeds 10800000ms"
                      ]
                    },
                    "gate": "generation-preflight",
                    "id": "4285",
                    "ideas_generated": 0,
                    "ideas_routed": 0,
                    "install_slug": "papercusp-workspace",
                    "origin": "scout",
                    "pot_slug": "papercusp",
                    "status": "gated",
                    "tick_at": "2026-10-17 20:07:11.983066-04",
                    "workspace_id": "papercusp-workspace"
                  }
                ]
              }
            }
          },
          "dream": {
            "sourceRefs": [
              "harness_shared.routines",
              "dream-config:resolveDreamCycleConfig"
            ],
            "status": "observed",
            "value": {
              "resolved": {
                "auto": {
                  "autoIdleRatioFloor": 0.5,
                  "maxCostUsd": 1,
                  "maxDreamsPerCycle": 3,
                  "rolling24hCostUsd": 5,
                  "timeoutMs": 600000
                },
                "manual": {
                  "autoIdleRatioFloor": 0.5,
                  "maxCostUsd": 1,
                  "maxDreamsPerCycle": 3,
                  "rolling24hCostUsd": 5,
                  "timeoutMs": 600000
                }
              },
              "routines": [
                {
                  "active": false,
                  "metadata": {
                    "dreamControl": {
                      "actor": "su-9d472d4b-a9aa-46ea-9bd8-a40d0c3a7d2c",
                      "at": 1791693764811,
                      "enabled": false,
                      "mode": "manual"
                    },
                    "dreamLastCycle": {
                      "accepted": 0,
                      "attempts": 1,
                      "costUsd": 0.45735760000000003,
                      "cycleId": "dream-cycle:papercusp-workspace:papercusp:252cdcc1-6c0d-4504-b1e4-84451a482284",
                      "mode": "manual",
                      "reason": "completed",
                      "running": 0,
                      "updatedAt": "2026-10-14T03:43:07.572Z"
                    },
                    "lastPause": {
                      "pausedAtMs": 1791461948438,
                      "pausedBy": "su-9d472d4b-a9aa-46ea-9bd8-a40d0c3a7d2c",
                      "reason": "Dream paused from Learning controls",
                      "resumedAtMs": 1791693223522
                    },
                    "pause": {
                      "pausedAtMs": 1791693764811,
                      "pausedBy": "su-9d472d4b-a9aa-46ea-9bd8-a40d0c3a7d2c",
                      "reason": "Dream paused from Learning controls"
                    }
                  },
                  "name": "dream-cycle-manual",
                  "next_fire_at": "2026-10-11 00:45:00-04",
                  "payload_template": {
                    "mode": "manual"
                  }
                },
                {
                  "active": true,
                  "metadata": {
                    "dreamControl": {
                      "actor": "su-e41f796d-eaeb-458d-8e7b-f957a79a2445",
                      "at": 1792199893988,
                      "enabled": true,
                      "mode": "auto"
                    },
                    "lastPause": {
                      "pausedAtMs": 1791464349584,
                      "pausedBy": "su-9d472d4b-a9aa-46ea-9bd8-a40d0c3a7d2c",
                      "reason": "Dream paused from Learning controls",
                      "resumedAtMs": 1791693887075
                    }
                  },
                  "name": "dream-cycle-auto",
                  "next_fire_at": "2026-10-17 22:01:07-04",
                  "payload_template": {
                    "mode": "auto"
                  }
                }
              ]
            }
          },
          "flags": {
            "sourceRefs": [
              "flags:DREAM_CYCLE",
              "flags:LEARNING_GOVERNOR"
            ],
            "status": "observed",
            "value": {
              "attestations": {
                "dream": {
                  "backendConfigured": false,
                  "compiledDefault": true,
                  "key": "papercusp-dream-cycle",
                  "observedAtMs": 1792288502556,
                  "overrideRead": {
                    "cacheAgeMs": 2760,
                    "cacheGeneration": 36,
                    "cacheKey": "papercusp-workspace",
                    "cacheLoadedAtMs": 1792288499796,
                    "kind": "cache-hit",
                    "loadError": null,
                    "storeConfigured": true,
                    "ttlMs": 5000,
                    "ttlRemainingMs": 2240
                  },
                  "resolvedValue": true,
                  "source": "compiled-default"
                },
                "learningGovernor": {
                  "backendConfigured": false,
                  "compiledDefault": true,
                  "key": "papercusp-learning-governor",
                  "observedAtMs": 1792288502559,
                  "overrideRead": {
                    "cacheAgeMs": 2763,
                    "cacheGeneration": 36,
                    "cacheKey": "papercusp-workspace",
                    "cacheLoadedAtMs": 1792288499796,
                    "kind": "cache-hit",
                    "loadError": null,
                    "storeConfigured": true,
                    "ttlMs": 5000,
                    "ttlRemainingMs": 2237
                  },
                  "resolvedValue": true,
                  "source": "compiled-default"
                }
              },
              "dream": true,
              "learningGovernor": true
            }
          },
          "governors": {
            "sourceRefs": [
              "harness_shared.learning_governor_loops",
              "harness_shared.learning_pot_scope",
              "harness_shared.pot_settings"
            ],
            "status": "observed",
            "value": {
              "admission": "not-evaluated",
              "floorUsd": 0.5,
              "governorAdmission": [
                {
                  "chargedOpenUsd": 0,
                  "enforcement": "governor",
                  "loopId": "dream:papercusp",
                  "openCount": 0,
                  "openReservedUsd": 0,
                  "scope": "governor-budget-and-pot-only",
                  "verdict": {
                    "allow": true,
                    "remainingUsd": 10
                  }
                },
                {
                  "chargedOpenUsd": 0,
                  "enforcement": "native",
                  "loopId": "gym:papercusp",
                  "openCount": 0,
                  "openReservedUsd": 0,
                  "scope": "governor-budget-and-pot-only",
                  "verdict": {
                    "allow": false,
                    "reason": "unbudgeted",
                    "remainingUsd": null
                  }
                },
                {
                  "chargedOpenUsd": 0,
                  "enforcement": "native",
                  "loopId": "blender:papercusp",
                  "openCount": 0,
                  "openReservedUsd": 0,
                  "scope": "governor-budget-and-pot-only",
                  "verdict": {
                    "allow": true,
                    "remainingUsd": 5
                  }
                }
              ],
              "loops": [
                {
                  "budgetKind": "per-cycle",
                  "budgetUsd": 10,
                  "displayName": "Dream cycles (papercusp)",
                  "enabled": true,
                  "enforcement": "governor",
                  "loopId": "dream:papercusp",
                  "meta": {
                    "maxDreamsPerCycle": 1,
                    "rolling24hCostUsd": 200,
                    "rollingWindowMs": 86400000
                  },
                  "potSlug": "papercusp",
                  "priority": 65,
                  "registeredAt": 1788877659174,
                  "spentUsd": 2.574479,
                  "updatedAt": 1791949387343,
                  "workspaceId": "papercusp-workspace"
                },
                {
                  "budgetKind": "lifetime",
                  "budgetUsd": null,
                  "displayName": "Gym autoloop (papercusp)",
                  "enabled": true,
                  "enforcement": "native",
                  "loopId": "gym:papercusp",
                  "meta": null,
                  "potSlug": "papercusp",
                  "priority": 50,
                  "registeredAt": 1781848671347,
                  "spentUsd": 0,
                  "updatedAt": 1791432575303,
                  "workspaceId": "papercusp-workspace"
                },
                {
                  "budgetKind": "per-cycle",
                  "budgetUsd": 5,
                  "displayName": "Scout cadence (papercusp)",
                  "enabled": true,
                  "enforcement": "native",
                  "loopId": "blender:papercusp",
                  "meta": null,
                  "potSlug": "papercusp",
                  "priority": 60,
                  "registeredAt": 1785027875085,
                  "spentUsd": 580.1204257,
                  "updatedAt": 1792287209856,
                  "workspaceId": "papercusp-workspace"
                }
              ],
              "potScope": [
                {
                  "enabled": true,
                  "pot_slug": "papercusp",
                  "workspace_id": "papercusp-workspace"
                }
              ],
              "reservations": [],
              "steering": [
                {
                  "harness_slug": "papercusp",
                  "setting_key": "owner-steering:idle-activities",
                  "updated_at": 1792199893985,
                  "value": "{\"gym\":true,\"dream\":true}",
                  "workspace_id": "papercusp-workspace"
                }
              ]
            }
          },
          "gym": {
            "sourceRefs": [
              "harness_shared.gym_autoloop_config",
              "harness_shared.operator_gym_gates",
              "gym/autoloop-tick:isEligibleAutoloop"
            ],
            "status": "observed",
            "value": {
              "autoloop": {
                "budgetUsd": null,
                "enabled": true,
                "harnessSlug": "papercusp",
                "lastCycle": 1,
                "lastCycleAt": 1787885386903,
                "spentUsd": 0,
                "status": "idle",
                "updatedAt": 1787885387048,
                "workspaceId": "papercusp-workspace"
              },
              "budgetFloorUsd": 0.5,
              "cycleHardCapUsd": null,
              "gates": {
                "costCeiling": 3,
                "delta": 0.5,
                "epsilon": 0.1
              },
              "nativeBudgetEligible": false,
              "nullBudgetRefusesUnattended": true,
              "remainingUsd": null
            }
          },
          "rollingSpend": {
            "sourceRefs": [
              "dream-governor:sumDreamSpendSince",
              "harness_shared.learning_spend_events",
              "harness_shared.dream_runs"
            ],
            "status": "observed",
            "value": {
              "accounting": "maintained-conservative-admission-total",
              "loopCount": 0,
              "since": "2026-10-17T01:55:02.555Z",
              "totalUsd": 0,
              "workspaceId": "papercusp-workspace"
            }
          }
        },
        "productionAdmission": {
          "reason": "complete-dream-and-gym-production-decisions-required",
          "sourceRefs": [
            "journal:readJournal"
          ],
          "status": "unknown",
          "value": null
        },
        "r2Assertions": {
          "clauses": [
            {
              "capturedAt": "2026-10-18T01:55:02.555Z",
              "expiresAt": "2026-10-18T01:56:02.555Z",
              "healthy": false,
              "id": "r2:dream-action-decisions",
              "rawRefs": [
                "/actionDecisions"
              ],
              "reason": "incomplete-dream-decisions",
              "scope": {
                "actionJournalUnit": "papercusp-bg-host.service",
                "expectedActionRuntime": {
                  "buildSha": "258ed96687",
                  "host": "port-3170",
                  "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
                },
                "expectedGymRuntime": {
                  "buildSha": "258ed96687",
                  "host": "port-3170",
                  "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
                },
                "expectedRuntime": {
                  "buildSha": "258ed96687",
                  "host": "port-3170",
                  "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
                },
                "gymJournalUnit": "papercusp-bg-host.service",
                "potSlug": "papercusp",
                "since": "2026-10-18T00:00:00.000Z",
                "until": "2026-10-18T01:54:56.442Z",
                "workspaceId": "papercusp-workspace"
              },
              "source": {
                "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
                "runtime": {
                  "buildSha": "258ed96687",
                  "host": "port-3170",
                  "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
                }
              },
              "sourceRefs": [
                "journal:readJournal",
                "dream/dream-cycle-action:makeDreamCycleAction"
              ],
              "status": "unknown"
            },
            {
              "capturedAt": "2026-10-18T01:55:02.555Z",
              "expiresAt": "2026-10-18T01:56:02.555Z",
              "healthy": false,
              "id": "r2:gym-admission-decisions",
              "rawRefs": [
                "/gymDecisions"
              ],
              "reason": "gym-decisions-not-observed",
              "scope": {
                "actionJournalUnit": "papercusp-bg-host.service",
                "expectedActionRuntime": {
                  "buildSha": "258ed96687",
                  "host": "port-3170",
                  "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
                },
                "expectedGymRuntime": {
                  "buildSha": "258ed96687",
                  "host": "port-3170",
                  "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
                },
                "expectedRuntime": {
                  "buildSha": "258ed96687",
                  "host": "port-3170",
                  "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
                },
                "gymJournalUnit": "papercusp-bg-host.service",
                "potSlug": "papercusp",
                "since": "2026-10-18T00:00:00.000Z",
                "until": "2026-10-18T01:54:56.442Z",
                "workspaceId": "papercusp-workspace"
              },
              "source": {
                "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
                "runtime": {
                  "buildSha": "258ed96687",
                  "host": "port-3170",
                  "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
                }
              },
              "sourceRefs": [
                "journal:readJournal",
                "gym/autoloop-tick:runGymAutoloopTick"
              ],
              "status": "unknown"
            },
            {
              "capturedAt": "2026-10-18T01:55:02.555Z",
              "expiresAt": "2026-10-18T01:56:02.555Z",
              "healthy": false,
              "id": "r2:full-admission-and-spend",
              "rawRefs": [
                "/productionAdmission",
                "/observations/governors",
                "/observations/rollingSpend"
              ],
              "reason": "complete-production-admission-and-spend-required",
              "scope": {
                "actionJournalUnit": "papercusp-bg-host.service",
                "expectedActionRuntime": {
                  "buildSha": "258ed96687",
                  "host": "port-3170",
                  "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
                },
                "expectedGymRuntime": {
                  "buildSha": "258ed96687",
                  "host": "port-3170",
                  "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
                },
                "expectedRuntime": {
                  "buildSha": "258ed96687",
                  "host": "port-3170",
                  "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
                },
                "gymJournalUnit": "papercusp-bg-host.service",
                "potSlug": "papercusp",
                "since": "2026-10-18T00:00:00.000Z",
                "until": "2026-10-18T01:54:56.442Z",
                "workspaceId": "papercusp-workspace"
              },
              "source": {
                "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
                "runtime": {
                  "buildSha": "258ed96687",
                  "host": "port-3170",
                  "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
                }
              },
              "sourceRefs": [
                "dream-governor:preflightDreamCycle",
                "learning-governor:checkLoopVerdict",
                "dream-governor:sumDreamSpendSince"
              ],
              "status": "unknown"
            },
            {
              "capturedAt": "2026-10-18T01:55:02.555Z",
              "expiresAt": "2026-10-18T01:56:02.555Z",
              "healthy": false,
              "id": "r2:scout-zero-route-lens-cap-provenance",
              "rawRefs": [
                "/observations/activity/value/scout"
              ],
              "reason": "qualifying-complete-scout-cap-lens-origin-window-required",
              "scope": {
                "actionJournalUnit": "papercusp-bg-host.service",
                "expectedActionRuntime": {
                  "buildSha": "258ed96687",
                  "host": "port-3170",
                  "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
                },
                "expectedGymRuntime": {
                  "buildSha": "258ed96687",
                  "host": "port-3170",
                  "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
                },
                "expectedRuntime": {
                  "buildSha": "258ed96687",
                  "host": "port-3170",
                  "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
                },
                "gymJournalUnit": "papercusp-bg-host.service",
                "potSlug": "papercusp",
                "since": "2026-10-18T00:00:00.000Z",
                "until": "2026-10-18T01:54:56.442Z",
                "workspaceId": "papercusp-workspace"
              },
              "source": {
                "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
                "runtime": {
                  "buildSha": "258ed96687",
                  "host": "port-3170",
                  "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
                }
              },
              "sourceRefs": [
                "harness_shared.scout_ticks",
                "scout/scheduler:runScoutTick",
                "scout/run:runScoutCycleTick"
              ],
              "status": "unknown"
            },
            {
              "capturedAt": "2026-10-18T01:55:02.555Z",
              "expiresAt": "2026-10-18T01:56:02.555Z",
              "healthy": false,
              "id": "r2:actual-attempts-or-explicit-policy-skips",
              "rawRefs": [
                "/actionDecisions",
                "/observations/activity/value/dream"
              ],
              "reason": "actual-attempt-usage-or-explicit-policy-skip-required",
              "scope": {
                "actionJournalUnit": "papercusp-bg-host.service",
                "expectedActionRuntime": {
                  "buildSha": "258ed96687",
                  "host": "port-3170",
                  "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
                },
                "expectedGymRuntime": {
                  "buildSha": "258ed96687",
                  "host": "port-3170",
                  "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
                },
                "expectedRuntime": {
                  "buildSha": "258ed96687",
                  "host": "port-3170",
                  "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
                },
                "gymJournalUnit": "papercusp-bg-host.service",
                "potSlug": "papercusp",
                "since": "2026-10-18T00:00:00.000Z",
                "until": "2026-10-18T01:54:56.442Z",
                "workspaceId": "papercusp-workspace"
              },
              "source": {
                "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
                "runtime": {
                  "buildSha": "258ed96687",
                  "host": "port-3170",
                  "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
                }
              },
              "sourceRefs": [
                "dream/dream-cycle-action:makeDreamCycleAction",
                "harness_shared.dream_runs"
              ],
              "status": "unknown"
            }
          ],
          "healthy": false,
          "schemaVersion": 1
        },
        "reason": null,
        "runtime": {
          "buildSha": "258ed96687",
          "host": "port-3170",
          "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
        },
        "schemaVersion": "dream-control-observations-v1",
        "scope": {
          "actionJournalUnit": "papercusp-bg-host.service",
          "expectedActionRuntime": {
            "buildSha": "258ed96687",
            "host": "port-3170",
            "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
          },
          "expectedGymRuntime": {
            "buildSha": "258ed96687",
            "host": "port-3170",
            "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
          },
          "expectedRuntime": {
            "buildSha": "258ed96687",
            "host": "port-3170",
            "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
          },
          "gymJournalUnit": "papercusp-bg-host.service",
          "potSlug": "papercusp",
          "since": "2026-10-18T00:00:00.000Z",
          "until": "2026-10-18T01:54:56.442Z",
          "workspaceId": "papercusp-workspace"
        },
        "status": "observed"
      }
    ],
    "timing": {
      "resolverCompletedAtMs": 1792288502781,
      "resolverMs": 6245,
      "resolverStartedAtMs": 1792288496536,
      "unit": "ms"
    },
    "version": "1792288502782"
  },
  "runtime": {
    "buildSha": "258ed96687",
    "host": "port-3170",
    "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:107736274"
  },
  "schemaVersion": 1
}
