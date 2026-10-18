---
rel_path: "verification/WI-6554700010016963/2026-10-17-shared-consumer-diagnostic-v1.json"
updated_at: 1792279563469
_body: "content"
---

{
  "schemaVersion": 1,
  "workItem": "WI-6554700010016963",
  "kind": "bounded-shared-consumer-diagnostic",
  "priorFailure": {
    "at": "2026-10-17T23:25:28Z",
    "httpStatus": 500,
    "requestId": "606364a1-a866-424b-ae19-09e8db5639d9",
    "reason": "learning.dream resolver timeout at10000ms",
    "scopeHours": 2
  },
  "results": [
    {
      "id": "plain-two-hour",
      "args": {
        "potSlug": "papercusp",
        "view": "observations",
        "expectedRuntime": {
          "host": "port-3271",
          "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:106690543",
          "buildSha": "6d864c64eb"
        },
        "since": "2026-10-17T21:25:57.048Z",
        "until": "2026-10-17T23:25:57.048Z"
      },
      "httpStatus": 200,
      "elapsedMs": 5284,
      "truncated": false,
      "body": {
        "rows": [
          {
            "schemaVersion": "dream-control-observations-v1",
            "status": "observed",
            "reason": null,
            "scope": {
              "workspaceId": "papercusp-workspace",
              "potSlug": "papercusp",
              "since": "2026-10-17T21:25:57.048Z",
              "until": "2026-10-17T23:25:57.048Z",
              "expectedRuntime": {
                "host": "port-3271",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:106690543",
                "buildSha": "6d864c64eb"
              }
            },
            "runtime": {
              "host": "port-3271",
              "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:106690543",
              "buildSha": "6d864c64eb"
            },
            "capturedAt": "2026-10-17T23:26:00.975Z",
            "expiresAt": "2026-10-17T23:27:00.975Z",
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
                        "cacheGeneration": 14935,
                        "cacheLoadedAtMs": 1792279560011,
                        "cacheAgeMs": 965,
                        "ttlMs": 5000,
                        "ttlRemainingMs": 4035,
                        "loadError": null
                      },
                      "backendConfigured": false,
                      "observedAtMs": 1792279560976
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
                        "cacheGeneration": 14935,
                        "cacheLoadedAtMs": 1792279560011,
                        "cacheAgeMs": 966,
                        "ttlMs": 5000,
                        "ttlRemainingMs": 4034,
                        "loadError": null
                      },
                      "backendConfigured": false,
                      "observedAtMs": 1792279560977
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
                      "next_fire_at": "2026-10-11 00:45:00-04",
                      "metadata": {
                        "pause": {
                          "reason": "Dream paused from Learning controls",
                          "pausedBy": "su-9d472d4b-a9aa-46ea-9bd8-a40d0c3a7d2c",
                          "pausedAtMs": 1791693764811
                        },
                        "lastPause": {
                          "reason": "Dream paused from Learning controls",
                          "pausedBy": "su-9d472d4b-a9aa-46ea-9bd8-a40d0c3a7d2c",
                          "pausedAtMs": 1791461948438,
                          "resumedAtMs": 1791693223522
                        },
                        "dreamControl": {
                          "at": 1791693764811,
                          "mode": "manual",
                          "actor": "su-9d472d4b-a9aa-46ea-9bd8-a40d0c3a7d2c",
                          "enabled": false
                        },
                        "dreamLastCycle": {
                          "mode": "manual",
                          "reason": "completed",
                          "costUsd": 0.45735760000000003,
                          "cycleId": "dream-cycle:papercusp-workspace:papercusp:252cdcc1-6c0d-4504-b1e4-84451a482284",
                          "running": 0,
                          "accepted": 0,
                          "attempts": 1,
                          "updatedAt": "2026-10-14T03:43:07.572Z"
                        }
                      },
                      "payload_template": {
                        "mode": "manual"
                      }
                    },
                    {
                      "name": "dream-cycle-auto",
                      "active": true,
                      "next_fire_at": "2026-10-17 19:31:07-04",
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
                      "budgetUsd": 10,
                      "spentUsd": 2.574479,
                      "priority": 65,
                      "enabled": true,
                      "enforcement": "governor",
                      "meta": {
                        "rollingWindowMs": 86400000,
                        "maxDreamsPerCycle": 1,
                        "rolling24hCostUsd": 200
                      },
                      "registeredAt": 1788877659174,
                      "updatedAt": 1791949387343
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
                      "updatedAt": 1792278317709
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
                        "remainingUsd": 10
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
                    "rows": [],
                    "hasMore": false,
                    "limit": 20,
                    "population": "bounded-window-rows"
                  },
                  "scout": {
                    "rows": [
                      {
                        "id": "4283",
                        "workspace_id": "papercusp-workspace",
                        "install_slug": "papercusp-workspace",
                        "pot_slug": "papercusp",
                        "tick_at": "2026-10-17 19:05:18.008264-04",
                        "origin": "scout",
                        "status": "gated",
                        "gate": "generation-preflight",
                        "ideas_generated": 0,
                        "ideas_routed": 0,
                        "budget_used_usd": null,
                        "detail": {
                          "p95Ms": 297383442.8681,
                          "reason": "admission-throttle-deep",
                          "pending": 245,
                          "hostBuildSha": "6d864c64eb",
                          "throttleReasons": [
                            "pending 245 exceeds two promoter batches (40)",
                            "claim-latency p95 297383443ms exceeds 10800000ms"
                          ],
                          "admissionThrottle": {
                            "level": "deep",
                            "p95Ms": 297383442.8681,
                            "source": "p005-queue-health",
                            "pending": 245,
                            "reasons": [
                              "pending 245 exceeds two promoter batches (40)",
                              "claim-latency p95 297383443ms exceeds 10800000ms"
                            ],
                            "maxIdeators": 1,
                            "latencySampleSize": 115
                          }
                        }
                      },
                      {
                        "id": "4282",
                        "workspace_id": "papercusp-workspace",
                        "install_slug": "papercusp-workspace",
                        "pot_slug": "papercusp",
                        "tick_at": "2026-10-17 18:30:12.316721-04",
                        "origin": "scout",
                        "status": "gated",
                        "gate": "generation-preflight",
                        "ideas_generated": 0,
                        "ideas_routed": 0,
                        "budget_used_usd": null,
                        "detail": {
                          "p95Ms": 299846669.70199996,
                          "reason": "admission-throttle-deep",
                          "pending": 241,
                          "hostBuildSha": "1548b1c6d6",
                          "throttleReasons": [
                            "pending 241 exceeds two promoter batches (40)",
                            "claim-latency p95 299846670ms exceeds 10800000ms"
                          ],
                          "admissionThrottle": {
                            "level": "deep",
                            "p95Ms": 299846669.70199996,
                            "source": "p005-queue-health",
                            "pending": 241,
                            "reasons": [
                              "pending 241 exceeds two promoter batches (40)",
                              "claim-latency p95 299846670ms exceeds 10800000ms"
                            ],
                            "maxIdeators": 1,
                            "latencySampleSize": 73
                          }
                        }
                      },
                      {
                        "id": "4281",
                        "workspace_id": "papercusp-workspace",
                        "install_slug": "papercusp-workspace",
                        "pot_slug": "papercusp",
                        "tick_at": "2026-10-17 18:00:15.914636-04",
                        "origin": "scout",
                        "status": "gated",
                        "gate": "generation-preflight",
                        "ideas_generated": 0,
                        "ideas_routed": 0,
                        "budget_used_usd": null,
                        "detail": {
                          "p95Ms": 304213768.6274,
                          "reason": "admission-throttle-deep",
                          "pending": 236,
                          "hostBuildSha": "1548b1c6d6",
                          "throttleReasons": [
                            "pending 236 exceeds two promoter batches (40)",
                            "claim-latency p95 304213769ms exceeds 10800000ms"
                          ],
                          "admissionThrottle": {
                            "level": "deep",
                            "p95Ms": 304213768.6274,
                            "source": "p005-queue-health",
                            "pending": 236,
                            "reasons": [
                              "pending 236 exceeds two promoter batches (40)",
                              "claim-latency p95 304213769ms exceeds 10800000ms"
                            ],
                            "maxIdeators": 1,
                            "latencySampleSize": 53
                          }
                        }
                      },
                      {
                        "id": "4280",
                        "workspace_id": "papercusp-workspace",
                        "install_slug": "papercusp-workspace",
                        "pot_slug": "papercusp",
                        "tick_at": "2026-10-17 17:40:15.747751-04",
                        "origin": "scout",
                        "status": "gated",
                        "gate": "generation-preflight",
                        "ideas_generated": 0,
                        "ideas_routed": 0,
                        "budget_used_usd": null,
                        "detail": {
                          "p95Ms": 304909470.1522,
                          "reason": "admission-throttle-deep",
                          "pending": 229,
                          "hostBuildSha": "1548b1c6d6",
                          "throttleReasons": [
                            "pending 229 exceeds two promoter batches (40)",
                            "claim-latency p95 304909470ms exceeds 10800000ms"
                          ],
                          "admissionThrottle": {
                            "level": "deep",
                            "p95Ms": 304909470.1522,
                            "source": "p005-queue-health",
                            "pending": 229,
                            "reasons": [
                              "pending 229 exceeds two promoter batches (40)",
                              "claim-latency p95 304909470ms exceeds 10800000ms"
                            ],
                            "maxIdeators": 1,
                            "latencySampleSize": 33
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
                          "id": "4283",
                          "workspace_id": "papercusp-workspace",
                          "install_slug": "papercusp-workspace",
                          "pot_slug": "papercusp",
                          "tick_at": "2026-10-17 19:05:18.008264-04",
                          "origin": "scout",
                          "status": "gated",
                          "gate": "generation-preflight",
                          "ideas_generated": 0,
                          "ideas_routed": 0,
                          "budget_used_usd": null,
                          "detail": {
                            "p95Ms": 297383442.8681,
                            "reason": "admission-throttle-deep",
                            "pending": 245,
                            "hostBuildSha": "6d864c64eb",
                            "throttleReasons": [
                              "pending 245 exceeds two promoter batches (40)",
                              "claim-latency p95 297383443ms exceeds 10800000ms"
                            ],
                            "admissionThrottle": {
                              "level": "deep",
                              "p95Ms": 297383442.8681,
                              "source": "p005-queue-health",
                              "pending": 245,
                              "reasons": [
                                "pending 245 exceeds two promoter batches (40)",
                                "claim-latency p95 297383443ms exceeds 10800000ms"
                              ],
                              "maxIdeators": 1,
                              "latencySampleSize": 115
                            }
                          }
                        },
                        "origin": "scout",
                        "budgetProvenance": {
                          "status": "unknown",
                          "reason": "missing-or-invalid-tick-budget-provenance"
                        },
                        "suppliedOneIdeatorCapRespected": null,
                        "ideatorCount": null,
                        "lenses": null,
                        "ideasRouted": 0,
                        "costUsd": null,
                        "oneIdeatorZeroRoute": null,
                        "modelUsage": "not-established"
                      },
                      {
                        "raw": {
                          "id": "4282",
                          "workspace_id": "papercusp-workspace",
                          "install_slug": "papercusp-workspace",
                          "pot_slug": "papercusp",
                          "tick_at": "2026-10-17 18:30:12.316721-04",
                          "origin": "scout",
                          "status": "gated",
                          "gate": "generation-preflight",
                          "ideas_generated": 0,
                          "ideas_routed": 0,
                          "budget_used_usd": null,
                          "detail": {
                            "p95Ms": 299846669.70199996,
                            "reason": "admission-throttle-deep",
                            "pending": 241,
                            "hostBuildSha": "1548b1c6d6",
                            "throttleReasons": [
                              "pending 241 exceeds two promoter batches (40)",
                              "claim-latency p95 299846670ms exceeds 10800000ms"
                            ],
                            "admissionThrottle": {
                              "level": "deep",
                              "p95Ms": 299846669.70199996,
                              "source": "p005-queue-health",
                              "pending": 241,
                              "reasons": [
                                "pending 241 exceeds two promoter batches (40)",
                                "claim-latency p95 299846670ms exceeds 10800000ms"
                              ],
                              "maxIdeators": 1,
                              "latencySampleSize": 73
                            }
                          }
                        },
                        "origin": "scout",
                        "budgetProvenance": {
                          "status": "unknown",
                          "reason": "missing-or-invalid-tick-budget-provenance"
                        },
                        "suppliedOneIdeatorCapRespected": null,
                        "ideatorCount": null,
                        "lenses": null,
                        "ideasRouted": 0,
                        "costUsd": null,
                        "oneIdeatorZeroRoute": null,
                        "modelUsage": "not-established"
                      },
                      {
                        "raw": {
                          "id": "4281",
                          "workspace_id": "papercusp-workspace",
                          "install_slug": "papercusp-workspace",
                          "pot_slug": "papercusp",
                          "tick_at": "2026-10-17 18:00:15.914636-04",
                          "origin": "scout",
                          "status": "gated",
                          "gate": "generation-preflight",
                          "ideas_generated": 0,
                          "ideas_routed": 0,
                          "budget_used_usd": null,
                          "detail": {
                            "p95Ms": 304213768.6274,
                            "reason": "admission-throttle-deep",
                            "pending": 236,
                            "hostBuildSha": "1548b1c6d6",
                            "throttleReasons": [
                              "pending 236 exceeds two promoter batches (40)",
                              "claim-latency p95 304213769ms exceeds 10800000ms"
                            ],
                            "admissionThrottle": {
                              "level": "deep",
                              "p95Ms": 304213768.6274,
                              "source": "p005-queue-health",
                              "pending": 236,
                              "reasons": [
                                "pending 236 exceeds two promoter batches (40)",
                                "claim-latency p95 304213769ms exceeds 10800000ms"
                              ],
                              "maxIdeators": 1,
                              "latencySampleSize": 53
                            }
                          }
                        },
                        "origin": "scout",
                        "budgetProvenance": {
                          "status": "unknown",
                          "reason": "missing-or-invalid-tick-budget-provenance"
                        },
                        "suppliedOneIdeatorCapRespected": null,
                        "ideatorCount": null,
                        "lenses": null,
                        "ideasRouted": 0,
                        "costUsd": null,
                        "oneIdeatorZeroRoute": null,
                        "modelUsage": "not-established"
                      },
                      {
                        "raw": {
                          "id": "4280",
                          "workspace_id": "papercusp-workspace",
                          "install_slug": "papercusp-workspace",
                          "pot_slug": "papercusp",
                          "tick_at": "2026-10-17 17:40:15.747751-04",
                          "origin": "scout",
                          "status": "gated",
                          "gate": "generation-preflight",
                          "ideas_generated": 0,
                          "ideas_routed": 0,
                          "budget_used_usd": null,
                          "detail": {
                            "p95Ms": 304909470.1522,
                            "reason": "admission-throttle-deep",
                            "pending": 229,
                            "hostBuildSha": "1548b1c6d6",
                            "throttleReasons": [
                              "pending 229 exceeds two promoter batches (40)",
                              "claim-latency p95 304909470ms exceeds 10800000ms"
                            ],
                            "admissionThrottle": {
                              "level": "deep",
                              "p95Ms": 304909470.1522,
                              "source": "p005-queue-health",
                              "pending": 229,
                              "reasons": [
                                "pending 229 exceeds two promoter batches (40)",
                                "claim-latency p95 304909470ms exceeds 10800000ms"
                              ],
                              "maxIdeators": 1,
                              "latencySampleSize": 33
                            }
                          }
                        },
                        "origin": "scout",
                        "budgetProvenance": {
                          "status": "unknown",
                          "reason": "missing-or-invalid-tick-budget-provenance"
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
                  "since": "2026-10-16T23:26:00.975Z",
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
              "status": "unknown",
              "value": null,
              "reason": "action-runtime-and-unit-required",
              "sourceRefs": [
                "journal:readJournal"
              ]
            },
            "gymDecisions": {
              "status": "unknown",
              "value": null,
              "reason": "gym-runtime-and-unit-required",
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
            }
          }
        ],
        "version": "1792279562318",
        "timing": {
          "unit": "ms",
          "resolverStartedAtMs": 1792279560728,
          "resolverCompletedAtMs": 1792279562318,
          "resolverMs": 1590
        }
      },
      "consumedAt": "2026-10-17T23:26:02.332Z"
    },
    {
      "id": "exact-dream-journal-minute",
      "args": {
        "potSlug": "papercusp",
        "view": "observations",
        "expectedRuntime": {
          "host": "port-3271",
          "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:106690543",
          "buildSha": "6d864c64eb"
        },
        "since": "2026-10-17T23:01:00.000Z",
        "until": "2026-10-17T23:02:00.000Z",
        "actionJournalUnit": "papercusp-bg-host.service",
        "expectedActionRuntime": {
          "host": "port-3271",
          "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:106690543",
          "buildSha": "6d864c64eb"
        },
        "gymJournalUnit": "papercusp-bg-host.service",
        "expectedGymRuntime": {
          "host": "port-3271",
          "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:106690543",
          "buildSha": "6d864c64eb"
        }
      },
      "httpStatus": 200,
      "elapsedMs": 6376,
      "truncated": false,
      "body": {
        "rows": [
          {
            "schemaVersion": "dream-control-observations-v1",
            "status": "observed",
            "reason": null,
            "scope": {
              "workspaceId": "papercusp-workspace",
              "potSlug": "papercusp",
              "since": "2026-10-17T23:01:00.000Z",
              "until": "2026-10-17T23:02:00.000Z",
              "expectedRuntime": {
                "host": "port-3271",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:106690543",
                "buildSha": "6d864c64eb"
              },
              "actionJournalUnit": "papercusp-bg-host.service",
              "expectedActionRuntime": {
                "host": "port-3271",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:106690543",
                "buildSha": "6d864c64eb"
              },
              "gymJournalUnit": "papercusp-bg-host.service",
              "expectedGymRuntime": {
                "host": "port-3271",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:106690543",
                "buildSha": "6d864c64eb"
              }
            },
            "runtime": {
              "host": "port-3271",
              "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:106690543",
              "buildSha": "6d864c64eb"
            },
            "capturedAt": "2026-10-17T23:26:02.056Z",
            "expiresAt": "2026-10-17T23:27:02.056Z",
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
                        "cacheGeneration": 14935,
                        "cacheLoadedAtMs": 1792279560011,
                        "cacheAgeMs": 2045,
                        "ttlMs": 5000,
                        "ttlRemainingMs": 2955,
                        "loadError": null
                      },
                      "backendConfigured": false,
                      "observedAtMs": 1792279562056
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
                        "cacheGeneration": 14935,
                        "cacheLoadedAtMs": 1792279560011,
                        "cacheAgeMs": 2046,
                        "ttlMs": 5000,
                        "ttlRemainingMs": 2954,
                        "loadError": null
                      },
                      "backendConfigured": false,
                      "observedAtMs": 1792279562057
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
                      "next_fire_at": "2026-10-11 00:45:00-04",
                      "metadata": {
                        "pause": {
                          "reason": "Dream paused from Learning controls",
                          "pausedBy": "su-9d472d4b-a9aa-46ea-9bd8-a40d0c3a7d2c",
                          "pausedAtMs": 1791693764811
                        },
                        "lastPause": {
                          "reason": "Dream paused from Learning controls",
                          "pausedBy": "su-9d472d4b-a9aa-46ea-9bd8-a40d0c3a7d2c",
                          "pausedAtMs": 1791461948438,
                          "resumedAtMs": 1791693223522
                        },
                        "dreamControl": {
                          "at": 1791693764811,
                          "mode": "manual",
                          "actor": "su-9d472d4b-a9aa-46ea-9bd8-a40d0c3a7d2c",
                          "enabled": false
                        },
                        "dreamLastCycle": {
                          "mode": "manual",
                          "reason": "completed",
                          "costUsd": 0.45735760000000003,
                          "cycleId": "dream-cycle:papercusp-workspace:papercusp:252cdcc1-6c0d-4504-b1e4-84451a482284",
                          "running": 0,
                          "accepted": 0,
                          "attempts": 1,
                          "updatedAt": "2026-10-14T03:43:07.572Z"
                        }
                      },
                      "payload_template": {
                        "mode": "manual"
                      }
                    },
                    {
                      "name": "dream-cycle-auto",
                      "active": true,
                      "next_fire_at": "2026-10-17 19:31:07-04",
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
                      "budgetUsd": 10,
                      "spentUsd": 2.574479,
                      "priority": 65,
                      "enabled": true,
                      "enforcement": "governor",
                      "meta": {
                        "rollingWindowMs": 86400000,
                        "maxDreamsPerCycle": 1,
                        "rolling24hCostUsd": 200
                      },
                      "registeredAt": 1788877659174,
                      "updatedAt": 1791949387343
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
                      "updatedAt": 1792278317709
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
                        "remainingUsd": 10
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
                    "rows": [],
                    "hasMore": false,
                    "limit": 20,
                    "population": "bounded-window-rows"
                  },
                  "scout": {
                    "rows": [],
                    "hasMore": false,
                    "limit": 20,
                    "population": "bounded-window-rows",
                    "observations": []
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
                  "since": "2026-10-16T23:26:02.056Z",
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
                  "matched": 1,
                  "collapsed": 0,
                  "truncated": false,
                  "window": {
                    "since": "@1792278060",
                    "until": "@1792278120",
                    "resolved": null
                  },
                  "units": [
                    "papercusp-bg-host.service"
                  ],
                  "unitsUnknown": [],
                  "unitsHistorical": [],
                  "historicalCommand": null,
                  "windowOutsideJournal": null,
                  "command": "journalctl --user --no-pager -o json --output-fields=__REALTIME_TIMESTAMP,_SYSTEMD_USER_UNIT,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER,PRIORITY,MESSAGE -u papercusp-bg-host.service --since @1792278060 --until @1792278120 --grep dream-action-decision: --case-sensitive=false -n 21",
                  "backend": "systemd",
                  "entries": [
                    {
                      "ts": "2026-10-17T23:01:34.801Z",
                      "unit": "papercusp-bg-host.service",
                      "level": "info",
                      "message": "[dream-cycle] dream-action-decision:{\"schemaVersion\":1,\"actionId\":\"sched-.routinesTick-2026-10-17T23:01:30.000Z-11\",\"workspaceId\":\"papercusp-workspace\",\"potSlug\":\"papercusp\",\"capturedAt\":\"2026-10-17T23:01:34.801Z\",\"runtime\":{\"host\":\"port-3271\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:106690543\",\"buildSha\":\"6d864c64eb\"},\"source\":\"dream/dream-cycle-action:makeDreamCycleAction\",\"mode\":\"auto\",\"reason\":\"idle-ratio-below-floor\",\"cycle\":{\"maxDreamsPerCycle\":3,\"maxCostUsd\":1,\"rolling24hCostUsd\":5,\"timeoutMs\":600000,\"autoIdleRatioFloor\":0.5},\"admission\":[{\"gate\":\"feature\",\"status\":\"passed\",\"inputs\":{\"enabled\":true}},{\"gate\":\"owner-idle\",\"status\":\"passed\",\"inputs\":{\"allowed\":true,\"potSlug\":\"papercusp\",\"observation\":{\"status\":\"observed\",\"home\":\"papercusp\",\"allowed\":true,\"steering\":{\"directive\":null,\"eligiblePlans\":[],\"eligibleHives\":[],\"includeUnplannedWork\":true,\"pauseNewWork\":true,\"pausedUntil\":null,\"modelTiers\":null,\"tierCeilings\":{\"cup\":\"standard\",\"mug\":\"max\"},\"cadenceFloorSec\":null,\"maxBees\":1,\"idleActivities\":{\"gym\":true,\"dream\":true},\"autoScaleOut\":null,\"decomposition\":\"parallel\",\"modelOverrides\":null,\"federatedPriming\":null,\"createWakeSuppressPlans\":[]}}}},{\"gate\":\"idle-ratio\",\"status\":\"refused\",\"inputs\":{\"idleRatio\":0,\"floor\":0.5}},{\"gate\":\"source\",\"status\":\"not-reached\",\"inputs\":{}},{\"gate\":\"governor\",\"status\":\"not-reached\",\"inputs\":{}},{\"gate\":\"continue\",\"status\":\"not-reached\",\"inputs\":{}}],\"disposition\":\"pre-attempt-policy-skip\",\"idleRatio\":0,\"floor\":0.5,\"paidCalls\":0,\"model\":null,\"usage\":null,\"costUsd\":0}",
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
                        "actionId": "sched-.routinesTick-2026-10-17T23:01:30.000Z-11",
                        "workspaceId": "papercusp-workspace",
                        "potSlug": "papercusp",
                        "capturedAt": "2026-10-17T23:01:34.801Z",
                        "runtime": {
                          "host": "port-3271",
                          "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:106690543",
                          "buildSha": "6d864c64eb"
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
                      }
                    ],
                    "admission": [
                      {
                        "actionId": "sched-.routinesTick-2026-10-17T23:01:30.000Z-11",
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
                    "since": "@1792278060",
                    "until": "@1792278120",
                    "resolved": {
                      "sinceUtc": "2026-10-17T23:01:00.000Z",
                      "untilUtc": "2026-10-17T23:02:00.000Z",
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
                  "command": "journalctl --user --no-pager -o json --output-fields=__REALTIME_TIMESTAMP,_SYSTEMD_USER_UNIT,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER,PRIORITY,MESSAGE -u papercusp-bg-host.service --since @1792278060 --until @1792278120 --grep GYM_ADMISSION_DECISION  --case-sensitive=false -n 1001",
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
            }
          }
        ],
        "version": "1792279563419",
        "timing": {
          "unit": "ms",
          "resolverStartedAtMs": 1792279560744,
          "resolverCompletedAtMs": 1792279563417,
          "resolverMs": 2673
        }
      },
      "consumedAt": "2026-10-17T23:26:03.424Z"
    }
  ],
  "boundary": "Exact observed serving identity; no claim loadedSha equals newly committed source; no paid cycle, independent acceptance or shipment"
}
