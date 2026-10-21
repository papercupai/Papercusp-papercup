---
rel_path: "verification/WI-6554700010016963/2026-10-21-live-method-committed.json"
updated_at: 1792543190886
_body: "content"
---

{
  "schemaVersion": 1,
  "kind": "dream-control-observation-live-method",
  "testRunId": 21480203,
  "commit": "9aef0217564c998598bb5b69f34b7706d3708232",
  "worktreeDirty": false,
  "logSha256": "ee4d3117dcccd229f5a2ab1fc52be81c5dce5a629e43c9f051fcc9d2305d8754",
  "resultStamp": "TEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=9aef021756 uncommittedPaths=0/1 provenance=stamped startedAt=2026-10-21T00:37:42.383Z childSubstituted=0 skippedTests=0",
  "edition": {
    "consumedAt": "2026-10-21T00:38:00.433Z",
    "observation": {
      "schemaVersion": "dream-control-observations-v1",
      "status": "observed",
      "reason": null,
      "scope": {
        "workspaceId": "papercusp-workspace",
        "potSlug": "papercusp",
        "since": "2026-10-21T00:22:55.684Z",
        "until": "2026-10-21T00:37:55.684Z",
        "expectedRuntime": {
          "host": "port-3170",
          "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:133160377",
          "buildSha": "35322dd5cd"
        },
        "actionJournalUnit": "papercusp-bg-host.service",
        "expectedActionRuntime": {
          "host": "port-3271",
          "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:133050634",
          "buildSha": "35322dd5cd"
        },
        "gymJournalUnit": "papercusp-bg-host.service",
        "expectedGymRuntime": {
          "host": "port-3271",
          "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:133050634",
          "buildSha": "35322dd5cd"
        }
      },
      "runtime": {
        "host": "port-3170",
        "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:133160377",
        "buildSha": "35322dd5cd"
      },
      "capturedAt": "2026-10-21T00:38:00.377Z",
      "expiresAt": "2026-10-21T00:39:00.377Z",
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
                  "cacheGeneration": 108,
                  "cacheLoadedAtMs": 1792543076936,
                  "cacheAgeMs": 3441,
                  "ttlMs": 5000,
                  "ttlRemainingMs": 1559,
                  "loadError": null
                },
                "backendConfigured": false,
                "observedAtMs": 1792543080377
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
                  "cacheGeneration": 108,
                  "cacheLoadedAtMs": 1792543076936,
                  "cacheAgeMs": 3442,
                  "ttlMs": 5000,
                  "ttlRemainingMs": 1558,
                  "loadError": null
                },
                "backendConfigured": false,
                "observedAtMs": 1792543080378
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
                "name": "dream-cycle-auto",
                "active": true,
                "next_fire_at": "2026-10-20 21:01:07-04",
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
              },
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
                "updatedAt": 1792542611763
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
              "rows": [],
              "hasMore": false,
              "limit": 20,
              "population": "bounded-window-rows"
            },
            "scout": {
              "rows": [
                {
                  "id": "4430",
                  "workspace_id": "papercusp-workspace",
                  "install_slug": "papercusp-workspace",
                  "pot_slug": "papercusp",
                  "tick_at": "2026-10-20 20:30:12.074254-04",
                  "origin": "scout",
                  "status": "gated",
                  "gate": "generation-preflight",
                  "ideas_generated": 0,
                  "ideas_routed": 0,
                  "budget_used_usd": null,
                  "detail": {
                    "p95Ms": 279191648.4789996,
                    "reason": "admission-throttle-deep",
                    "pending": 684,
                    "hostBuildSha": "35322dd5cd",
                    "throttleReasons": [
                      "pending 684 exceeds two promoter batches (40)",
                      "claim-latency p95 279191648ms exceeds 10800000ms"
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
                      "p95Ms": 279191648.4789996,
                      "source": "p005-queue-health",
                      "pending": 684,
                      "reasons": [
                        "pending 684 exceeds two promoter batches (40)",
                        "claim-latency p95 279191648ms exceeds 10800000ms"
                      ],
                      "maxIdeators": 1,
                      "latencySampleSize": 23
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
                    "id": "4430",
                    "workspace_id": "papercusp-workspace",
                    "install_slug": "papercusp-workspace",
                    "pot_slug": "papercusp",
                    "tick_at": "2026-10-20 20:30:12.074254-04",
                    "origin": "scout",
                    "status": "gated",
                    "gate": "generation-preflight",
                    "ideas_generated": 0,
                    "ideas_routed": 0,
                    "budget_used_usd": null,
                    "detail": {
                      "p95Ms": 279191648.4789996,
                      "reason": "admission-throttle-deep",
                      "pending": 684,
                      "hostBuildSha": "35322dd5cd",
                      "throttleReasons": [
                        "pending 684 exceeds two promoter batches (40)",
                        "claim-latency p95 279191648ms exceeds 10800000ms"
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
                        "p95Ms": 279191648.4789996,
                        "source": "p005-queue-health",
                        "pending": 684,
                        "reasons": [
                          "pending 684 exceeds two promoter batches (40)",
                          "claim-latency p95 279191648ms exceeds 10800000ms"
                        ],
                        "maxIdeators": 1,
                        "latencySampleSize": 23
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
            "since": "2026-10-20T00:38:00.377Z",
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
            "matched": 0,
            "collapsed": 0,
            "truncated": false,
            "window": {
              "since": "@1792542175.684",
              "until": "@1792543075.684",
              "resolved": {
                "sinceUtc": "2026-10-21T00:22:55.684Z",
                "untilUtc": "2026-10-21T00:37:55.684Z",
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
            "command": "journalctl --user --no-pager -o json --output-fields=__REALTIME_TIMESTAMP,_SYSTEMD_USER_UNIT,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER,PRIORITY,MESSAGE -u papercusp-bg-host.service --since @1792542175.684 --until @1792543075.684 --grep dream-action-decision: --case-sensitive=false -n 21",
            "backend": "systemd",
            "entries": [],
            "journalAvailable": true,
            "journalError": null
          },
          "assessment": {
            "status": "unknown",
            "value": null,
            "reason": "no-actual-action-decision-records",
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
              "since": "@1792542175.684",
              "until": "@1792543075.684",
              "resolved": {
                "sinceUtc": "2026-10-21T00:22:55.684Z",
                "untilUtc": "2026-10-21T00:37:55.684Z",
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
            "command": "journalctl --user --no-pager -o json --output-fields=__REALTIME_TIMESTAMP,_SYSTEMD_USER_UNIT,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER,PRIORITY,MESSAGE -u papercusp-bg-host.service --since @1792542175.684 --until @1792543075.684 --grep GYM_ADMISSION_DECISION  --case-sensitive=false -n 1001",
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
            "status": "unknown",
            "healthy": false,
            "reason": "no-actual-action-decision-records",
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
              "since": "2026-10-21T00:22:55.684Z",
              "until": "2026-10-21T00:37:55.684Z",
              "expectedRuntime": {
                "host": "port-3170",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:133160377",
                "buildSha": "35322dd5cd"
              },
              "actionJournalUnit": "papercusp-bg-host.service",
              "expectedActionRuntime": {
                "host": "port-3271",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:133050634",
                "buildSha": "35322dd5cd"
              },
              "gymJournalUnit": "papercusp-bg-host.service",
              "expectedGymRuntime": {
                "host": "port-3271",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:133050634",
                "buildSha": "35322dd5cd"
              }
            },
            "source": {
              "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
              "runtime": {
                "host": "port-3170",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:133160377",
                "buildSha": "35322dd5cd"
              }
            },
            "capturedAt": "2026-10-21T00:38:00.377Z",
            "expiresAt": "2026-10-21T00:39:00.377Z"
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
              "since": "2026-10-21T00:22:55.684Z",
              "until": "2026-10-21T00:37:55.684Z",
              "expectedRuntime": {
                "host": "port-3170",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:133160377",
                "buildSha": "35322dd5cd"
              },
              "actionJournalUnit": "papercusp-bg-host.service",
              "expectedActionRuntime": {
                "host": "port-3271",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:133050634",
                "buildSha": "35322dd5cd"
              },
              "gymJournalUnit": "papercusp-bg-host.service",
              "expectedGymRuntime": {
                "host": "port-3271",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:133050634",
                "buildSha": "35322dd5cd"
              }
            },
            "source": {
              "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
              "runtime": {
                "host": "port-3170",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:133160377",
                "buildSha": "35322dd5cd"
              }
            },
            "capturedAt": "2026-10-21T00:38:00.377Z",
            "expiresAt": "2026-10-21T00:39:00.377Z"
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
              "since": "2026-10-21T00:22:55.684Z",
              "until": "2026-10-21T00:37:55.684Z",
              "expectedRuntime": {
                "host": "port-3170",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:133160377",
                "buildSha": "35322dd5cd"
              },
              "actionJournalUnit": "papercusp-bg-host.service",
              "expectedActionRuntime": {
                "host": "port-3271",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:133050634",
                "buildSha": "35322dd5cd"
              },
              "gymJournalUnit": "papercusp-bg-host.service",
              "expectedGymRuntime": {
                "host": "port-3271",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:133050634",
                "buildSha": "35322dd5cd"
              }
            },
            "source": {
              "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
              "runtime": {
                "host": "port-3170",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:133160377",
                "buildSha": "35322dd5cd"
              }
            },
            "capturedAt": "2026-10-21T00:38:00.377Z",
            "expiresAt": "2026-10-21T00:39:00.377Z"
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
              "since": "2026-10-21T00:22:55.684Z",
              "until": "2026-10-21T00:37:55.684Z",
              "expectedRuntime": {
                "host": "port-3170",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:133160377",
                "buildSha": "35322dd5cd"
              },
              "actionJournalUnit": "papercusp-bg-host.service",
              "expectedActionRuntime": {
                "host": "port-3271",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:133050634",
                "buildSha": "35322dd5cd"
              },
              "gymJournalUnit": "papercusp-bg-host.service",
              "expectedGymRuntime": {
                "host": "port-3271",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:133050634",
                "buildSha": "35322dd5cd"
              }
            },
            "source": {
              "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
              "runtime": {
                "host": "port-3170",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:133160377",
                "buildSha": "35322dd5cd"
              }
            },
            "capturedAt": "2026-10-21T00:38:00.377Z",
            "expiresAt": "2026-10-21T00:39:00.377Z"
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
              "since": "2026-10-21T00:22:55.684Z",
              "until": "2026-10-21T00:37:55.684Z",
              "expectedRuntime": {
                "host": "port-3170",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:133160377",
                "buildSha": "35322dd5cd"
              },
              "actionJournalUnit": "papercusp-bg-host.service",
              "expectedActionRuntime": {
                "host": "port-3271",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:133050634",
                "buildSha": "35322dd5cd"
              },
              "gymJournalUnit": "papercusp-bg-host.service",
              "expectedGymRuntime": {
                "host": "port-3271",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:133050634",
                "buildSha": "35322dd5cd"
              }
            },
            "source": {
              "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
              "runtime": {
                "host": "port-3170",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:133160377",
                "buildSha": "35322dd5cd"
              }
            },
            "capturedAt": "2026-10-21T00:38:00.377Z",
            "expiresAt": "2026-10-21T00:39:00.377Z"
          }
        ]
      }
    },
    "productR2Healthy": false,
    "sourcePaths": [
      "packages/operator-core/lib/dream/dream-control-observations.ts",
      "packages/operator-core/lib/sync-resolver/index.ts"
    ],
    "methodOnly": true
  }
}
