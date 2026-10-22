---
rel_path: "verification/WI-6554700010016963/2026-10-22-operational-method-clean-21772120.json"
updated_at: 1792681282355
_body: "content"
---

{
  "schemaVersion": 1,
  "kind": "dream-control-operational-method-edition",
  "sourceWorkItem": "WI-6554700010016963",
  "spec": {
    "plan": "self-learning-dreaming-verified-shipment-2026-10-03",
    "id": "AUTO-BAR-R-2-P-002",
    "revision": 2
  },
  "pinnedCommit": "3f1e22ce78edd6a4683b8345a9bab344460a4e61",
  "command": "PAPERCUSP_DREAM_CONTROL_OBSERVATIONS_LIVE=1 PAPERCUSP_APP_OPERATION_LIVE_PROFILE=packages/operator-core/test/fixtures/dream-control-observations-live.json npm run lint:as-committed -- test:file --any --ref=3f1e22ce78edd6a4683b8345a9bab344460a4e61 -- packages/operator-core/lib/dream/dream-control-observations.live.e2e.test.ts",
  "sourceFiles": [
    {
      "path": "packages/operator-core/lib/dream/dream-control-observations.live.e2e.test.ts",
      "sha256": "a8a1fd4422df53500df40215bf0c5431a3fbcf4e2c3892f3803d9df54c764e9c"
    },
    {
      "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
      "sha256": "32cbfa4b0ae0182587e07f9f6f04b69dabe390d8f6caf35a4ff653ee17b588ed"
    },
    {
      "path": "packages/operator-core/lib/sync-resolver/index.ts",
      "sha256": "10288937f3d2c3eb1dc2f47b38ffafdcb0a3716a6353cc7ad298caf5d79774c5"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/testing/record-run.ts",
      "sha256": "e7247c63250b8410482ac71fcd50b61917d1df6432c258b059e994d07d45ea09"
    },
    {
      "path": "packages/operator-core/test/fixtures/dream-control-observations-live.json",
      "sha256": "670e5f2a7d2cfb5000bdbd086ccb4192f73e33eef594edd21cdbbff8d56213d0"
    }
  ],
  "nativeOperationalRun": {
    "ok": true,
    "runGroupId": "operational-native:c2b57ae5-981a-456d-8e8b-d1c6cd9f9019",
    "testRunIds": [
      21772120
    ],
    "status": "pass",
    "runtimeEnvironmentMeasured": true
  },
  "edition": {
    "consumedAt": "2026-10-22T14:58:03.956Z",
    "observation": {
      "schemaVersion": "dream-control-observations-v1",
      "status": "observed",
      "reason": null,
      "scope": {
        "workspaceId": "papercusp-workspace",
        "potSlug": "papercusp",
        "since": "2026-10-22T14:42:54.869Z",
        "until": "2026-10-22T14:57:54.869Z",
        "expectedRuntime": {
          "host": "port-3170",
          "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146952717",
          "buildSha": "bd0781033d"
        },
        "actionJournalUnit": "papercusp-bg-host.service",
        "expectedActionRuntime": {
          "host": "port-3271",
          "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146492889",
          "buildSha": "16b035a000"
        },
        "gymJournalUnit": "papercusp-bg-host.service",
        "expectedGymRuntime": {
          "host": "port-3271",
          "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146492889",
          "buildSha": "16b035a000"
        }
      },
      "runtime": {
        "host": "port-3170",
        "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146952717",
        "buildSha": "bd0781033d"
      },
      "capturedAt": "2026-10-22T14:58:03.186Z",
      "expiresAt": "2026-10-22T14:59:03.186Z",
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
                  "cacheGeneration": 393,
                  "cacheLoadedAtMs": 1792681081940,
                  "cacheAgeMs": 1247,
                  "ttlMs": 5000,
                  "ttlRemainingMs": 3753,
                  "loadError": null
                },
                "backendConfigured": false,
                "observedAtMs": 1792681083187
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
                  "cacheGeneration": 393,
                  "cacheLoadedAtMs": 1792681081940,
                  "cacheAgeMs": 1252,
                  "ttlMs": 5000,
                  "ttlRemainingMs": 3748,
                  "loadError": null
                },
                "backendConfigured": false,
                "observedAtMs": 1792681083192
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
                "next_fire_at": "2026-10-22 11:01:07-04",
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
                "updatedAt": 1792675357287
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
            "since": "2026-10-21T14:58:03.186Z",
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
              "since": "@1792680174.869",
              "until": "@1792681074.869",
              "resolved": {
                "sinceUtc": "2026-10-22T14:42:54.869Z",
                "untilUtc": "2026-10-22T14:57:54.869Z",
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
            "command": "journalctl --user --no-pager -o json --output-fields=__REALTIME_TIMESTAMP,_SYSTEMD_USER_UNIT,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER,PRIORITY,MESSAGE -u papercusp-bg-host.service --since @1792680174.869 --until @1792681074.869 --grep dream-action-decision: --case-sensitive=false -n 21",
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
              "since": "@1792680174.869",
              "until": "@1792681074.869",
              "resolved": {
                "sinceUtc": "2026-10-22T14:42:54.869Z",
                "untilUtc": "2026-10-22T14:57:54.869Z",
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
            "command": "journalctl --user --no-pager -o json --output-fields=__REALTIME_TIMESTAMP,_SYSTEMD_USER_UNIT,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER,PRIORITY,MESSAGE -u papercusp-bg-host.service --since @1792680174.869 --until @1792681074.869 --grep GYM_ADMISSION_DECISION  --case-sensitive=false -n 1001",
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
              "since": "2026-10-22T14:42:54.869Z",
              "until": "2026-10-22T14:57:54.869Z",
              "expectedRuntime": {
                "host": "port-3170",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146952717",
                "buildSha": "bd0781033d"
              },
              "actionJournalUnit": "papercusp-bg-host.service",
              "expectedActionRuntime": {
                "host": "port-3271",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146492889",
                "buildSha": "16b035a000"
              },
              "gymJournalUnit": "papercusp-bg-host.service",
              "expectedGymRuntime": {
                "host": "port-3271",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146492889",
                "buildSha": "16b035a000"
              }
            },
            "source": {
              "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
              "runtime": {
                "host": "port-3170",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146952717",
                "buildSha": "bd0781033d"
              }
            },
            "capturedAt": "2026-10-22T14:58:03.186Z",
            "expiresAt": "2026-10-22T14:59:03.186Z"
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
              "since": "2026-10-22T14:42:54.869Z",
              "until": "2026-10-22T14:57:54.869Z",
              "expectedRuntime": {
                "host": "port-3170",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146952717",
                "buildSha": "bd0781033d"
              },
              "actionJournalUnit": "papercusp-bg-host.service",
              "expectedActionRuntime": {
                "host": "port-3271",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146492889",
                "buildSha": "16b035a000"
              },
              "gymJournalUnit": "papercusp-bg-host.service",
              "expectedGymRuntime": {
                "host": "port-3271",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146492889",
                "buildSha": "16b035a000"
              }
            },
            "source": {
              "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
              "runtime": {
                "host": "port-3170",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146952717",
                "buildSha": "bd0781033d"
              }
            },
            "capturedAt": "2026-10-22T14:58:03.186Z",
            "expiresAt": "2026-10-22T14:59:03.186Z"
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
              "since": "2026-10-22T14:42:54.869Z",
              "until": "2026-10-22T14:57:54.869Z",
              "expectedRuntime": {
                "host": "port-3170",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146952717",
                "buildSha": "bd0781033d"
              },
              "actionJournalUnit": "papercusp-bg-host.service",
              "expectedActionRuntime": {
                "host": "port-3271",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146492889",
                "buildSha": "16b035a000"
              },
              "gymJournalUnit": "papercusp-bg-host.service",
              "expectedGymRuntime": {
                "host": "port-3271",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146492889",
                "buildSha": "16b035a000"
              }
            },
            "source": {
              "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
              "runtime": {
                "host": "port-3170",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146952717",
                "buildSha": "bd0781033d"
              }
            },
            "capturedAt": "2026-10-22T14:58:03.186Z",
            "expiresAt": "2026-10-22T14:59:03.186Z"
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
              "since": "2026-10-22T14:42:54.869Z",
              "until": "2026-10-22T14:57:54.869Z",
              "expectedRuntime": {
                "host": "port-3170",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146952717",
                "buildSha": "bd0781033d"
              },
              "actionJournalUnit": "papercusp-bg-host.service",
              "expectedActionRuntime": {
                "host": "port-3271",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146492889",
                "buildSha": "16b035a000"
              },
              "gymJournalUnit": "papercusp-bg-host.service",
              "expectedGymRuntime": {
                "host": "port-3271",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146492889",
                "buildSha": "16b035a000"
              }
            },
            "source": {
              "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
              "runtime": {
                "host": "port-3170",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146952717",
                "buildSha": "bd0781033d"
              }
            },
            "capturedAt": "2026-10-22T14:58:03.186Z",
            "expiresAt": "2026-10-22T14:59:03.186Z"
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
              "since": "2026-10-22T14:42:54.869Z",
              "until": "2026-10-22T14:57:54.869Z",
              "expectedRuntime": {
                "host": "port-3170",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146952717",
                "buildSha": "bd0781033d"
              },
              "actionJournalUnit": "papercusp-bg-host.service",
              "expectedActionRuntime": {
                "host": "port-3271",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146492889",
                "buildSha": "16b035a000"
              },
              "gymJournalUnit": "papercusp-bg-host.service",
              "expectedGymRuntime": {
                "host": "port-3271",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146492889",
                "buildSha": "16b035a000"
              }
            },
            "source": {
              "path": "packages/operator-core/lib/dream/dream-control-observations.ts",
              "runtime": {
                "host": "port-3170",
                "processId": "linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146952717",
                "buildSha": "bd0781033d"
              }
            },
            "capturedAt": "2026-10-22T14:58:03.186Z",
            "expiresAt": "2026-10-22T14:59:03.186Z"
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
  },
  "scopeLimit": "Read-only METHOD proof. No learning cycle started, no product-health PASS, no independent acceptance or shipment claim. Historical dirty native21769382 and e2e binding61854 are not relabelled.",
  "rawLog": {
    "path": "/tmp/dream-takeover-operational-clean-20261022.log",
    "sha256": "ee4644a0c51b0679396fab5d93a27d446b1ec710220fca7fa085ba5de87cb4ff",
    "content": "\n> @papercupai/papercusp-monorepo@0.0.1 lint:as-committed\n> node scripts/lint-as-committed.mjs test:file --any --ref=3f1e22ce78edd6a4683b8345a9bab344460a4e61 -- packages/operator-core/lib/dream/dream-control-observations.live.e2e.test.ts\n\nlint-as-committed: ref 3f1e22ce78edd6a4683b8345a9bab344460a4e61 = 3f1e22ce78\n  repo: /home/marsh-office/papercupai-workspace/papercusp\n  note: your working tree differs from this ref in 28 tracked file(s) \u2014 those edits are NOT under test here.\n  main snapshot: d740fc3802877d1c8c3b1068768681ee32ef0025 (independent of tested HEAD 3f1e22ce78edd6a4683b8345a9bab344460a4e61)\n  materialised committed tree in 31.8s -> /tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE\n  operator database route: DATABASE_URL -> apps/operator/.env.local\nMigrating git directory of 'apps/slack-asana-bug-drill' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/apps/slack-asana-bug-drill/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/apps/slack-asana-bug-drill'\nMigrating git directory of 'libs/agent-chat' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/agent-chat/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/agent-chat'\nMigrating git directory of 'libs/generic/cache' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/cache/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/generic/cache'\nMigrating git directory of 'libs/generic/card-stack' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/card-stack/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/generic/card-stack'\nMigrating git directory of 'libs/generic/chat-protocol' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/chat-protocol/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/chat-protocol'\nMigrating git directory of 'libs/generic/control-mutation' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/control-mutation/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/generic/control-mutation'\nMigrating git directory of 'libs/generic/debounce-coalesce' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/debounce-coalesce/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/generic/debounce-coalesce'\nMigrating git directory of 'libs/generic/desktop-ipc' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/desktop-ipc/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/generic/desktop-ipc'\nMigrating git directory of 'libs/generic/dock-workbench' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/dock-workbench/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/generic/dock-workbench'\nMigrating git directory of 'libs/generic/embedded-pg-discovery' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/embedded-pg-discovery/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/generic/embedded-pg-discovery'\nMigrating git directory of 'libs/generic/failure-detector' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/failure-detector/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/generic/failure-detector'\nMigrating git directory of 'libs/generic/git-graph' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/git-graph/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/git-graph'\nMigrating git directory of 'libs/generic/ipc-endpoint-server' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/ipc-endpoint-server/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/generic/ipc-endpoint-server'\nMigrating git directory of 'libs/generic/ipc-framing' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/ipc-framing/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/generic/ipc-framing'\nMigrating git directory of 'libs/generic/memory' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/memory/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/generic/memory'\nMigrating git directory of 'libs/generic/model-pricing' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/model-pricing/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/generic/model-pricing'\nMigrating git directory of 'libs/generic/papergrid' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/papergrid/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/papergrid'\nMigrating git directory of 'libs/generic/plan-parser' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/plan-parser/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/generic/plan-parser'\nMigrating git directory of 'libs/generic/prospect-contract' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/prospect-contract/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/generic/prospect-contract'\nMigrating git directory of 'libs/generic/rate-limit' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/rate-limit/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/generic/rate-limit'\nMigrating git directory of 'libs/generic/rerank' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/rerank/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/rerank'\nMigrating git directory of 'libs/generic/resumable-download' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/resumable-download/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/generic/resumable-download'\nMigrating git directory of 'libs/generic/rrf' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/rrf/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/generic/rrf'\nMigrating git directory of 'libs/generic/rules' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/rules/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/generic/rules'\nMigrating git directory of 'libs/generic/search' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/search/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/generic/search'\nMigrating git directory of 'libs/generic/search-core' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/search-core/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/search-core'\nMigrating git directory of 'libs/generic/sse' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/sse/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/sse'\nMigrating git directory of 'libs/generic/sync' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/sync/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/sync'\nMigrating git directory of 'libs/generic/tauri-release-kit' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/tauri-release-kit/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/generic/tauri-release-kit'\nMigrating git directory of 'libs/generic/token-kit' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/token-kit/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/token-kit'\nMigrating git directory of 'libs/generic/tooldef' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/tooldef/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/generic/tooldef'\nMigrating git directory of 'libs/generic/tooldef-http' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/tooldef-http/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/generic/tooldef-http'\nMigrating git directory of 'libs/generic/ui-primitives' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/generic/ui-primitives/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/ui-primitives'\nMigrating git directory of 'libs/papercusp' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/papercusp/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/papercusp'\nMigrating git directory of 'libs/papercusp-db' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/papercusp-db/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/papercusp-db'\nMigrating git directory of 'libs/papercusp-shared' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/papercusp-shared/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/papercusp-shared'\nMigrating git directory of 'libs/test-config' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/test-config/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/test-config'\nMigrating git directory of 'libs/testing-shell' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/libs/testing-shell/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/libs/testing-shell'\nMigrating git directory of 'papercusp-desktop' from\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/papercusp-desktop/.git' to\n'/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/modules/papercusp-desktop'\n  initialised 39 submodule(s) from local checkouts in 13.0s (no network)\n  linked 97 node_modules dir(s) (not installed, not copied; excluded from git status); 117 workspace package link(s) resolve into this tree\n  building pinned runtime exports: @papercusp/omp (packages/omp-plugin)\n\n> @papercusp/omp@0.1.0 build\n> tsc -p tsconfig.json && node build-native.mjs\n\n  building pinned runtime exports: @papercusp/sse (libs/generic/sse)\n\n> @papercusp/sse@0.0.1 build\n> node -e \"const { spawnSync } = require('node:child_process'); const { existsSync, mkdirSync, rmSync, writeFileSync } = require('node:fs'); const { dirname, resolve } = require('node:path'); const manifestPath = require.resolve('@typescript/native/package.json'); const compiler = resolve(dirname(manifestPath), require(manifestPath).bin.tsc); rmSync('dist', { recursive: true, force: true }); mkdirSync('dist', { recursive: true }); const result = spawnSync(process.execPath, [compiler, '-p', 'tsconfig.json'], { stdio: 'inherit' }); const exitCode = result.status ?? 1; const emitted = existsSync('dist/index.js'); if (emitted) writeFileSync('dist/package.json', JSON.stringify({ type: 'commonjs' }, null, 2) + '\\n'); else console.error('ERROR: tsc did not emit dist/index.js; refusing to write dist/package.json'); process.exit(emitted ? exitCode : (exitCode || 1))\"\n\nporcupine-runtime: reused cached model (sha256 verified)\n  preparing pinned runtime assets: @papercusp/web (apps/operator)\n\n> @papercusp/web@0.0.1 postinstall\n> bash scripts/setup-wake-runtime.sh && bash scripts/setup-vad-runtime.sh && bash scripts/setup-vditor-runtime.sh && bash scripts/setup-monaco-runtime.sh && bash scripts/setup-excalidraw-runtime.sh && bash scripts/setup-porcupine-runtime.sh && node scripts/setup-elevenlabs-runtime.mjs\n\nCopied 9 files to public/wake-runtime/\nort-wasm-simd-threaded.asyncify.mjs\nort-wasm-simd-threaded.asyncify.wasm\nort-wasm-simd-threaded.jsep.mjs\nort-wasm-simd-threaded.jsep.wasm\nort-wasm-simd-threaded.jspi.mjs\nort-wasm-simd-threaded.jspi.wasm\nort-wasm-simd-threaded.mjs\nort-wasm-simd-threaded.wasm\nort.bundle.min.mjs\nvad-runtime: copied silero models + worklet into public/ and ort wasm into public/vad-runtime/ plus public/\nvditor-runtime: mirrored vditor v3.11.2 and local markmap assets into public/vditor/dist/ (23M)\nmonaco-runtime: mirrored monaco-editor v0.56.0 into public/monaco/vs/ (24M)\nexcalidraw-runtime: mirrored @excalidraw/excalidraw v0.18.1 into public/excalidraw/ (18M)\nporcupine-runtime: already current (sha256 verified) \u2014 skipping download\nelevenlabs-runtime: mirrored rawAudioProcessor.js, audioConcatProcessor.js, libsamplerate.worklet.js\n  mobile producer source: /home/marsh-office/papercupai-workspace/papercup-rust-mobile @ d28b573ba5796ccc2a8261642508a6f548b21eb6 -> /tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/.git/mobile-source-contract\n\n\u2500\u2500\u2500 test:file \u2500\u2500\u2500\n  committed command: NODE_OPTIONS=\"--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}\" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs\n  forwarded args:    packages/operator-core/lib/dream/dream-control-observations.live.e2e.test.ts\n\n> @papercupai/papercusp-monorepo@0.0.1 test:file\n> NODE_OPTIONS=\"--import=$(pwd -P)/scripts/lib/committed-source-loader.mjs${NODE_OPTIONS:+ $NODE_OPTIONS}\" PC_HEAVY_RETRY_PREEMPTIONS=3 PC_HEAVY_PREEMPT_AFTER_READY=1 PC_HEAVY_COALESCE=0 bash scripts/pc-heavy.sh node --import ./scripts/lib/committed-source-loader.mjs scripts/npm-install-safe.mjs --exec-under-lock -- node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/dream/dream-control-observations.live.e2e.test.ts\n\n[pc-heavy] release gate is JUDGING (phase=materializing) \u2014 heavy slots clamped to 1 to keep headroom for its isolation re-run (EI-19315056231449472). PC_HEAVY_GATE_RESERVE=0 lifts THIS CLAMP ONLY \u2014 you still queue for a slot behind unrelated heavy runs. To run FOCUSED TESTS without queueing at all, use testing:run { files: [...] }, which spawns the router directly and takes no admission ticket (EI-20204197087661235).\n[pc-heavy] queued for a focused test lane slot (all 1 slot(s) busy) \u2014 pid 2174168, waiting up to 30s\n[pc-heavy] still queued (15s elapsed, pid 2174168, slots=1)\n[pc-heavy] still queued (30s elapsed, pid 2174168, slots=1)\n[pc-heavy] slot acquired \u2014 starting real work\nPC_HEAVY_ADMISSION status=skipped reason=memory-not-scarce priority=50 psiFullAvg10=43 admittedCgroupMiB=5350 admissionId=pc-heavy-2174168-1792681004380170968 retryHandle=psi-recovery:pc-heavy-2174168-1792681004380170968 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nNPM_INSTALL_SAFE guarding reader: node --import ./scripts/lib/committed-source-loader.mjs scripts/test-files.mjs packages/operator-core/lib/dream/dream-control-observations.live.e2e.test.ts (root=/tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE, lock=npm-install-b0c4d63441b2)\nFocused runner has no explicit PAPERCUSP_TEST_RUN_HARNESS. Test-ledger scope is unverified here; check the authoritative testing:runs row before binding proof, or set PAPERCUSP_TEST_RUN_HARNESS to the target harness (papercusp for this repo).\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_LIST_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=14 capturedBytes=0 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=pending signal=pending lastOutputLine=null\nTEST_FILE_LIST_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=8912 capturedBytes=766 completedFiles=[] pendingFiles=[] timeoutMs=120000 exitStatus=0 signal=none lastOutputLine={\"channel\":\"stdout\",\"text\":\"lib/dream/dream-control-observations.live.e2e.test.ts\"}\nPC_HEAVY_PREEMPT_READY pid=2191533\n[db] target source=env endpoint=localhost:5432\nTEST_FILE_SCOPE_PREFLIGHT {\"ok\":true}\nTEST_FILE_PROGRESS state=started cwd=\"packages/operator-core\" elapsedMs=16 capturedBytes=0 completedFiles=[] pendingFiles=[\"lib/dream/dream-control-observations.live.e2e.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine=null\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=10017 capturedBytes=1445 completedFiles=[] pendingFiles=[\"lib/dream/dream-control-observations.live.e2e.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={\"channel\":\"stderr\",\"text\":\"TEST_FILE_STARTUP_TRACE {\\\"pid\\\":2226646,\\\"event\\\":\\\"started-received\\\",\\\"childPid\\\":2233576,\\\"elapsedMs\\\":998,\\\"startupMs\\\":997,\\\"error\\\":false}\"}\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=20017 capturedBytes=1445 completedFiles=[] pendingFiles=[\"lib/dream/dream-control-observations.live.e2e.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={\"channel\":\"stderr\",\"text\":\"TEST_FILE_STARTUP_TRACE {\\\"pid\\\":2226646,\\\"event\\\":\\\"started-received\\\",\\\"childPid\\\":2233576,\\\"elapsedMs\\\":998,\\\"startupMs\\\":997,\\\"error\\\":false}\"}\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=30019 capturedBytes=1445 completedFiles=[] pendingFiles=[\"lib/dream/dream-control-observations.live.e2e.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={\"channel\":\"stderr\",\"text\":\"TEST_FILE_STARTUP_TRACE {\\\"pid\\\":2226646,\\\"event\\\":\\\"started-received\\\",\\\"childPid\\\":2233576,\\\"elapsedMs\\\":998,\\\"startupMs\\\":997,\\\"error\\\":false}\"}\nTEST_FILE_PROGRESS state=running cwd=\"packages/operator-core\" elapsedMs=40021 capturedBytes=1492 completedFiles=[] pendingFiles=[\"lib/dream/dream-control-observations.live.e2e.test.ts\"] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={\"channel\":\"stderr\",\"text\":\"[db] target source=env endpoint=localhost:5432\"}\nPC_HEAVY_PSI_FINALIZATION pid=2191533\nTEST_FILE_PROGRESS state=file-completed cwd=\"packages/operator-core\" elapsedMs=45996 capturedBytes=17590 completedFiles=[\"lib/dream/dream-control-observations.live.e2e.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=pending signal=pending lastOutputLine={\"channel\":\"stdout\",\"text\":\"\u2713 lib/dream/dream-control-observations.live.e2e.test.ts (1 test) 15479ms\"}\nTEST_FILE_PROGRESS state=finished cwd=\"packages/operator-core\" elapsedMs=48641 capturedBytes=18823 completedFiles=[\"lib/dream/dream-control-observations.live.e2e.test.ts\"] pendingFiles=[] timeoutMs=600000 exitStatus=0 signal=none lastOutputLine={\"channel\":\"stderr\",\"text\":\"TEST_FILE_STARTUP_TRACE {\\\"pid\\\":2226646,\\\"event\\\":\\\"worker-close\\\",\\\"childPid\\\":2233576,\\\"elapsedMs\\\":38923,\\\"code\\\":null,\\\"signal\\\":\\\"SIGTERM\\\"}\"}\nRunning as unit: papercusp-test-2191533-mvjo06ly-4.scope; invocation ID: 4f04ab60cd1b4060b2d31780f56f6b66\nTEST_FILE_STARTUP_TRACE {\"pid\":2224126,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"3ed36b4833ec934f0a50acad265c02d85bcd48284bfaa3e42cb0d6968c5a40a5\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":2226646,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"3ed36b4833ec934f0a50acad265c02d85bcd48284bfaa3e42cb0d6968c5a40a5\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\",\"bytes\":0,\"switches\":[]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":2226646,\"event\":\"worker-forked\",\"childPid\":2233576}\nTEST_FILE_STARTUP_TRACE {\"pid\":2226646,\"event\":\"start-sent\",\"childPid\":2233576,\"elapsedMs\":1}\nTEST_FILE_STARTUP_TRACE {\"pid\":2233576,\"event\":\"node-loaded\",\"nodeOptions\":{\"sha256\":\"3ed36b4833ec934f0a50acad265c02d85bcd48284bfaa3e42cb0d6968c5a40a5\",\"bytes\":253,\"switches\":[\"--import\"]},\"execArgv\":{\"sha256\":\"47705a7b9614dc617f23e945c98e9529307251bcc8422412fa129719566ab775\",\"bytes\":179,\"switches\":[\"--require\",\"--conditions\"]}}\nTEST_FILE_STARTUP_TRACE {\"pid\":2226646,\"event\":\"started-received\",\"childPid\":2233576,\"elapsedMs\":998,\"startupMs\":997,\"error\":false}\n[db] target source=env endpoint=localhost:5432\nTEST_FILE_HEARTBEAT completedCases=1\nTEST_FILE_STARTUP_TRACE {\"pid\":2226646,\"event\":\"stop-sent\",\"childPid\":2233576,\"elapsedMs\":38174}\nTEST_FILE_STARTUP_TRACE {\"pid\":2226646,\"event\":\"stopped-received\",\"childPid\":2233576,\"elapsedMs\":38176,\"stopMs\":2,\"error\":false}\nTEST_FILE_STARTUP_TRACE {\"pid\":2226646,\"event\":\"worker-signal\",\"childPid\":2233576,\"elapsedMs\":38179,\"signal\":\"SIGTERM\",\"sent\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":2226646,\"event\":\"worker-signal\",\"childPid\":2233576,\"elapsedMs\":38689,\"signal\":\"SIGKILL\",\"sent\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":2226646,\"event\":\"worker-disconnect\",\"childPid\":2233576,\"elapsedMs\":38901}\nTEST_FILE_STARTUP_TRACE {\"pid\":2226646,\"event\":\"worker-exit\",\"childPid\":2233576,\"elapsedMs\":38903,\"code\":null,\"signal\":\"SIGTERM\",\"started\":true}\nTEST_FILE_STARTUP_TRACE {\"pid\":2226646,\"event\":\"worker-close\",\"childPid\":2233576,\"elapsedMs\":38923,\"code\":null,\"signal\":\"SIGTERM\"}\nPC_HEAVY_ADMISSION status=completed reason=cleanup priority=50 psiFullAvg10=unavailable admittedCgroupMiB=0 admissionId=pc-heavy-2174168-1792681004380170968 retryHandle=psi-recovery:pc-heavy-2174168-1792681004380170968 freezeMeasurement=measured frozenTotalMs=0 frozenEpisodes=0 frozenOngoingMs=0\nTEST_FILE_ROUTE requested=1 groups=1\nTEST_FILE_PROVENANCE head=3f1e22ce78 testedPaths=1 uncommitted=0 unknown=0 phase=pre-run startedAt=2026-10-22T14:56:51.775Z\n  HEAD         : 3f1e22ce78\n  tested files : packages/operator-core/lib/dream/dream-control-observations.live.e2e.test.ts  [clean]\n  scope        : the NAMED paths above only \u2014 an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nROUTE cwd=packages/operator-core config=vitest.e2e.config.ts\n  requested lib/dream/dream-control-observations.live.e2e.test.ts\n  matched lib/dream/dream-control-observations.live.e2e.test.ts\n\n RUN  v4.1.8 /tmp/pcv/papercusp-lint-as-committed-3f1e22ce78-lbn7gE/packages/operator-core\n\nstdout | lib/dream/dream-control-observations.live.e2e.test.ts > Dream control observation live METHOD > retains coherent source/runtime/TTL and fail-closed clauses with native runtime witnesses\nDREAM_CONTROL_OBSERVATION_EDITION {\"consumedAt\":\"2026-10-22T14:58:03.956Z\",\"observation\":{\"schemaVersion\":\"dream-control-observations-v1\",\"status\":\"observed\",\"reason\":null,\"scope\":{\"workspaceId\":\"papercusp-workspace\",\"potSlug\":\"papercusp\",\"since\":\"2026-10-22T14:42:54.869Z\",\"until\":\"2026-10-22T14:57:54.869Z\",\"expectedRuntime\":{\"host\":\"port-3170\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146952717\",\"buildSha\":\"bd0781033d\"},\"actionJournalUnit\":\"papercusp-bg-host.service\",\"expectedActionRuntime\":{\"host\":\"port-3271\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146492889\",\"buildSha\":\"16b035a000\"},\"gymJournalUnit\":\"papercusp-bg-host.service\",\"expectedGymRuntime\":{\"host\":\"port-3271\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146492889\",\"buildSha\":\"16b035a000\"}},\"runtime\":{\"host\":\"port-3170\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146952717\",\"buildSha\":\"bd0781033d\"},\"capturedAt\":\"2026-10-22T14:58:03.186Z\",\"expiresAt\":\"2026-10-22T14:59:03.186Z\",\"observations\":{\"flags\":{\"status\":\"observed\",\"value\":{\"dream\":true,\"learningGovernor\":true,\"attestations\":{\"dream\":{\"key\":\"papercusp-dream-cycle\",\"resolvedValue\":true,\"compiledDefault\":true,\"source\":\"compiled-default\",\"overrideRead\":{\"kind\":\"cache-hit\",\"storeConfigured\":true,\"cacheKey\":\"papercusp-workspace\",\"cacheGeneration\":393,\"cacheLoadedAtMs\":1792681081940,\"cacheAgeMs\":1247,\"ttlMs\":5000,\"ttlRemainingMs\":3753,\"loadError\":null},\"backendConfigured\":false,\"observedAtMs\":1792681083187},\"learningGovernor\":{\"key\":\"papercusp-learning-governor\",\"resolvedValue\":true,\"compiledDefault\":true,\"source\":\"compiled-default\",\"overrideRead\":{\"kind\":\"cache-hit\",\"storeConfigured\":true,\"cacheKey\":\"papercusp-workspace\",\"cacheGeneration\":393,\"cacheLoadedAtMs\":1792681081940,\"cacheAgeMs\":1252,\"ttlMs\":5000,\"ttlRemainingMs\":3748,\"loadError\":null},\"backendConfigured\":false,\"observedAtMs\":1792681083192}}},\"sourceRefs\":[\"flags:DREAM_CYCLE\",\"flags:LEARNING_GOVERNOR\"]},\"dream\":{\"status\":\"observed\",\"value\":{\"routines\":[{\"name\":\"dream-cycle-manual\",\"active\":false,\"next_fire_at\":\"2026-10-17 22:10:00-04\",\"metadata\":{\"pause\":{\"reason\":\"Dream paused from Learning controls\",\"pausedBy\":\"su-9f941711-a74e-486f-9ca7-302887653aac\",\"pausedAtMs\":1792289190855},\"lastPause\":{\"reason\":\"Dream paused from Learning controls\",\"pausedBy\":\"su-9d472d4b-a9aa-46ea-9bd8-a40d0c3a7d2c\",\"pausedAtMs\":1791693764811,\"resumedAtMs\":1792288938085},\"dreamControl\":{\"at\":1792289190855,\"mode\":\"manual\",\"actor\":\"su-9f941711-a74e-486f-9ca7-302887653aac\",\"enabled\":false},\"dreamLastCycle\":{\"mode\":\"manual\",\"reason\":\"aborted\",\"costUsd\":0,\"cycleId\":\"sched-.routinesTick-2026-10-18T02:02:30.000Z-7\",\"running\":0,\"accepted\":0,\"attempts\":1,\"updatedAt\":\"2026-10-18T02:07:07.550Z\"}},\"payload_template\":{\"mode\":\"manual\"}},{\"name\":\"dream-cycle-auto\",\"active\":true,\"next_fire_at\":\"2026-10-22 11:01:07-04\",\"metadata\":{\"lastPause\":{\"reason\":\"Dream paused from Learning controls\",\"pausedBy\":\"su-9d472d4b-a9aa-46ea-9bd8-a40d0c3a7d2c\",\"pausedAtMs\":1791464349584,\"resumedAtMs\":1791693887075},\"dreamControl\":{\"at\":1792199893988,\"mode\":\"auto\",\"actor\":\"su-e41f796d-eaeb-458d-8e7b-f957a79a2445\",\"enabled\":true}},\"payload_template\":{\"mode\":\"auto\"}}],\"resolved\":{\"manual\":{\"maxDreamsPerCycle\":3,\"maxCostUsd\":1,\"rolling24hCostUsd\":5,\"timeoutMs\":600000,\"autoIdleRatioFloor\":0.5},\"auto\":{\"maxDreamsPerCycle\":3,\"maxCostUsd\":1,\"rolling24hCostUsd\":5,\"timeoutMs\":600000,\"autoIdleRatioFloor\":0.5}}},\"sourceRefs\":[\"harness_shared.routines\",\"dream-config:resolveDreamCycleConfig\"]},\"gym\":{\"status\":\"observed\",\"value\":{\"autoloop\":{\"workspaceId\":\"papercusp-workspace\",\"harnessSlug\":\"papercusp\",\"enabled\":true,\"budgetUsd\":null,\"spentUsd\":0,\"status\":\"idle\",\"lastCycle\":1,\"lastCycleAt\":1787885386903,\"updatedAt\":1787885387048},\"gates\":{\"epsilon\":0.1,\"delta\":0.5,\"costCeiling\":3},\"budgetFloorUsd\":0.5,\"remainingUsd\":null,\"nativeBudgetEligible\":false,\"cycleHardCapUsd\":null,\"nullBudgetRefusesUnattended\":true},\"sourceRefs\":[\"harness_shared.gym_autoloop_config\",\"harness_shared.operator_gym_gates\",\"gym/autoloop-tick:isEligibleAutoloop\"]},\"governors\":{\"status\":\"observed\",\"value\":{\"loops\":[{\"workspaceId\":\"papercusp-workspace\",\"loopId\":\"dream:papercusp\",\"potSlug\":\"papercusp\",\"displayName\":\"Dream cycles (papercusp)\",\"budgetKind\":\"per-cycle\",\"budgetUsd\":1,\"spentUsd\":2.574479,\"priority\":65,\"enabled\":true,\"enforcement\":\"governor\",\"meta\":{\"rollingWindowMs\":86400000,\"maxDreamsPerCycle\":3,\"rolling24hCostUsd\":5},\"registeredAt\":1788877659174,\"updatedAt\":1792288953107},{\"workspaceId\":\"papercusp-workspace\",\"loopId\":\"gym:papercusp\",\"potSlug\":\"papercusp\",\"displayName\":\"Gym autoloop (papercusp)\",\"budgetKind\":\"lifetime\",\"budgetUsd\":null,\"spentUsd\":0,\"priority\":50,\"enabled\":true,\"enforcement\":\"native\",\"meta\":null,\"registeredAt\":1781848671347,\"updatedAt\":1791432575303},{\"workspaceId\":\"papercusp-workspace\",\"loopId\":\"blender:papercusp\",\"potSlug\":\"papercusp\",\"displayName\":\"Scout cadence (papercusp)\",\"budgetKind\":\"per-cycle\",\"budgetUsd\":5,\"spentUsd\":580.1204257,\"priority\":60,\"enabled\":true,\"enforcement\":\"native\",\"meta\":null,\"registeredAt\":1785027875085,\"updatedAt\":1792675357287}],\"floorUsd\":0.5,\"potScope\":[{\"workspace_id\":\"papercusp-workspace\",\"pot_slug\":\"papercusp\",\"enabled\":true}],\"steering\":[{\"workspace_id\":\"papercusp-workspace\",\"harness_slug\":\"papercusp\",\"setting_key\":\"owner-steering:idle-activities\",\"value\":\"{\\\"gym\\\":true,\\\"dream\\\":true}\",\"updated_at\":1792199893985}],\"reservations\":[],\"governorAdmission\":[{\"loopId\":\"dream:papercusp\",\"openReservedUsd\":0,\"chargedOpenUsd\":0,\"openCount\":0,\"verdict\":{\"allow\":true,\"remainingUsd\":1},\"enforcement\":\"governor\",\"scope\":\"governor-budget-and-pot-only\"},{\"loopId\":\"gym:papercusp\",\"openReservedUsd\":0,\"chargedOpenUsd\":0,\"openCount\":0,\"verdict\":{\"allow\":false,\"reason\":\"unbudgeted\",\"remainingUsd\":null},\"enforcement\":\"native\",\"scope\":\"governor-budget-and-pot-only\"},{\"loopId\":\"blender:papercusp\",\"openReservedUsd\":0,\"chargedOpenUsd\":0,\"openCount\":0,\"verdict\":{\"allow\":true,\"remainingUsd\":5},\"enforcement\":\"native\",\"scope\":\"governor-budget-and-pot-only\"}],\"admission\":\"not-evaluated\"},\"sourceRefs\":[\"harness_shared.learning_governor_loops\",\"harness_shared.learning_pot_scope\",\"harness_shared.pot_settings\"]},\"activity\":{\"status\":\"observed\",\"value\":{\"dream\":{\"rows\":[],\"hasMore\":false,\"limit\":20,\"population\":\"bounded-window-rows\"},\"scout\":{\"rows\":[],\"hasMore\":false,\"limit\":20,\"population\":\"bounded-window-rows\",\"observations\":[]},\"modelExecution\":\"not-established\",\"outputQuality\":\"not-evaluated\",\"preLedgerPolicySkips\":\"not-recorded-in-attempt-ledger\"},\"sourceRefs\":[\"harness_shared.dream_runs\",\"harness_shared.scout_ticks\"]},\"rollingSpend\":{\"status\":\"observed\",\"value\":{\"totalUsd\":0,\"loopCount\":0,\"workspaceId\":\"papercusp-workspace\",\"since\":\"2026-10-21T14:58:03.186Z\",\"accounting\":\"maintained-conservative-admission-total\"},\"sourceRefs\":[\"dream-governor:sumDreamSpendSince\",\"harness_shared.learning_spend_events\",\"harness_shared.dream_runs\"]}},\"actionDecisions\":{\"status\":\"observed\",\"value\":{\"journal\":{\"matched\":0,\"collapsed\":0,\"truncated\":false,\"window\":{\"since\":\"@1792680174.869\",\"until\":\"@1792681074.869\",\"resolved\":{\"sinceUtc\":\"2026-10-22T14:42:54.869Z\",\"untilUtc\":\"2026-10-22T14:57:54.869Z\",\"untilRequested\":true,\"hostUtcOffsetMinutes\":-240,\"invertedHint\":null}},\"units\":[\"papercusp-bg-host.service\"],\"unitsUnknown\":[],\"unitsHistorical\":[],\"historicalCommand\":null,\"windowOutsideJournal\":null,\"command\":\"journalctl --user --no-pager -o json --output-fields=__REALTIME_TIMESTAMP,_SYSTEMD_USER_UNIT,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER,PRIORITY,MESSAGE -u papercusp-bg-host.service --since @1792680174.869 --until @1792681074.869 --grep dream-action-decision: --case-sensitive=false -n 21\",\"backend\":\"systemd\",\"entries\":[],\"journalAvailable\":true,\"journalError\":null},\"assessment\":{\"status\":\"unknown\",\"value\":null,\"reason\":\"no-actual-action-decision-records\",\"sourceRefs\":[\"journal:readJournal\",\"dream/dream-cycle-action:makeDreamCycleAction\"]}},\"sourceRefs\":[\"journal:readJournal\"]},\"gymDecisions\":{\"status\":\"observed\",\"value\":{\"journal\":{\"matched\":0,\"collapsed\":0,\"truncated\":false,\"window\":{\"since\":\"@1792680174.869\",\"until\":\"@1792681074.869\",\"resolved\":{\"sinceUtc\":\"2026-10-22T14:42:54.869Z\",\"untilUtc\":\"2026-10-22T14:57:54.869Z\",\"untilRequested\":true,\"hostUtcOffsetMinutes\":-240,\"invertedHint\":null}},\"units\":[\"papercusp-bg-host.service\"],\"unitsUnknown\":[],\"unitsHistorical\":[],\"historicalCommand\":null,\"windowOutsideJournal\":null,\"command\":\"journalctl --user --no-pager -o json --output-fields=__REALTIME_TIMESTAMP,_SYSTEMD_USER_UNIT,_SYSTEMD_UNIT,SYSLOG_IDENTIFIER,PRIORITY,MESSAGE -u papercusp-bg-host.service --since @1792680174.869 --until @1792681074.869 --grep GYM_ADMISSION_DECISION  --case-sensitive=false -n 1001\",\"backend\":\"systemd\",\"entries\":[],\"journalAvailable\":true,\"journalError\":null},\"assessment\":{\"status\":\"unknown\",\"value\":null,\"reason\":\"no-actual-gym-admission-records\",\"sourceRefs\":[\"journal:readJournal\",\"gym/autoloop-tick:runGymAutoloopTick\",\"harness/routines/gym-actions:runGymCycleInline\"]}},\"sourceRefs\":[\"journal:readJournal\"]},\"productionAdmission\":{\"status\":\"unknown\",\"value\":null,\"reason\":\"complete-dream-and-gym-production-decisions-required\",\"sourceRefs\":[\"journal:readJournal\"]},\"r2Assertions\":{\"schemaVersion\":1,\"healthy\":false,\"clauses\":[{\"id\":\"r2:dream-action-decisions\",\"status\":\"unknown\",\"healthy\":false,\"reason\":\"no-actual-action-decision-records\",\"rawRefs\":[\"/actionDecisions\"],\"sourceRefs\":[\"journal:readJournal\",\"dream/dream-cycle-action:makeDreamCycleAction\"],\"scope\":{\"workspaceId\":\"papercusp-workspace\",\"potSlug\":\"papercusp\",\"since\":\"2026-10-22T14:42:54.869Z\",\"until\":\"2026-10-22T14:57:54.869Z\",\"expectedRuntime\":{\"host\":\"port-3170\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146952717\",\"buildSha\":\"bd0781033d\"},\"actionJournalUnit\":\"papercusp-bg-host.service\",\"expectedActionRuntime\":{\"host\":\"port-3271\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146492889\",\"buildSha\":\"16b035a000\"},\"gymJournalUnit\":\"papercusp-bg-host.service\",\"expectedGymRuntime\":{\"host\":\"port-3271\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146492889\",\"buildSha\":\"16b035a000\"}},\"source\":{\"path\":\"packages/operator-core/lib/dream/dream-control-observations.ts\",\"runtime\":{\"host\":\"port-3170\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146952717\",\"buildSha\":\"bd0781033d\"}},\"capturedAt\":\"2026-10-22T14:58:03.186Z\",\"expiresAt\":\"2026-10-22T14:59:03.186Z\"},{\"id\":\"r2:gym-admission-decisions\",\"status\":\"unknown\",\"healthy\":false,\"reason\":\"no-actual-gym-admission-records\",\"rawRefs\":[\"/gymDecisions\"],\"sourceRefs\":[\"journal:readJournal\",\"gym/autoloop-tick:runGymAutoloopTick\"],\"scope\":{\"workspaceId\":\"papercusp-workspace\",\"potSlug\":\"papercusp\",\"since\":\"2026-10-22T14:42:54.869Z\",\"until\":\"2026-10-22T14:57:54.869Z\",\"expectedRuntime\":{\"host\":\"port-3170\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146952717\",\"buildSha\":\"bd0781033d\"},\"actionJournalUnit\":\"papercusp-bg-host.service\",\"expectedActionRuntime\":{\"host\":\"port-3271\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146492889\",\"buildSha\":\"16b035a000\"},\"gymJournalUnit\":\"papercusp-bg-host.service\",\"expectedGymRuntime\":{\"host\":\"port-3271\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146492889\",\"buildSha\":\"16b035a000\"}},\"source\":{\"path\":\"packages/operator-core/lib/dream/dream-control-observations.ts\",\"runtime\":{\"host\":\"port-3170\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146952717\",\"buildSha\":\"bd0781033d\"}},\"capturedAt\":\"2026-10-22T14:58:03.186Z\",\"expiresAt\":\"2026-10-22T14:59:03.186Z\"},{\"id\":\"r2:full-admission-and-spend\",\"status\":\"unknown\",\"healthy\":false,\"reason\":\"complete-production-admission-and-spend-required\",\"rawRefs\":[\"/productionAdmission\",\"/observations/governors\",\"/observations/rollingSpend\"],\"sourceRefs\":[\"dream-governor:preflightDreamCycle\",\"learning-governor:checkLoopVerdict\",\"dream-governor:sumDreamSpendSince\"],\"scope\":{\"workspaceId\":\"papercusp-workspace\",\"potSlug\":\"papercusp\",\"since\":\"2026-10-22T14:42:54.869Z\",\"until\":\"2026-10-22T14:57:54.869Z\",\"expectedRuntime\":{\"host\":\"port-3170\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146952717\",\"buildSha\":\"bd0781033d\"},\"actionJournalUnit\":\"papercusp-bg-host.service\",\"expectedActionRuntime\":{\"host\":\"port-3271\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146492889\",\"buildSha\":\"16b035a000\"},\"gymJournalUnit\":\"papercusp-bg-host.service\",\"expectedGymRuntime\":{\"host\":\"port-3271\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146492889\",\"buildSha\":\"16b035a000\"}},\"source\":{\"path\":\"packages/operator-core/lib/dream/dream-control-observations.ts\",\"runtime\":{\"host\":\"port-3170\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146952717\",\"buildSha\":\"bd0781033d\"}},\"capturedAt\":\"2026-10-22T14:58:03.186Z\",\"expiresAt\":\"2026-10-22T14:59:03.186Z\"},{\"id\":\"r2:scout-zero-route-lens-cap-provenance\",\"status\":\"unknown\",\"healthy\":false,\"reason\":\"qualifying-complete-scout-cap-lens-origin-window-required\",\"rawRefs\":[\"/observations/activity/value/scout\"],\"sourceRefs\":[\"harness_shared.scout_ticks\",\"scout/scheduler:runScoutTick\",\"scout/run:runScoutCycleTick\"],\"scope\":{\"workspaceId\":\"papercusp-workspace\",\"potSlug\":\"papercusp\",\"since\":\"2026-10-22T14:42:54.869Z\",\"until\":\"2026-10-22T14:57:54.869Z\",\"expectedRuntime\":{\"host\":\"port-3170\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146952717\",\"buildSha\":\"bd0781033d\"},\"actionJournalUnit\":\"papercusp-bg-host.service\",\"expectedActionRuntime\":{\"host\":\"port-3271\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146492889\",\"buildSha\":\"16b035a000\"},\"gymJournalUnit\":\"papercusp-bg-host.service\",\"expectedGymRuntime\":{\"host\":\"port-3271\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146492889\",\"buildSha\":\"16b035a000\"}},\"source\":{\"path\":\"packages/operator-core/lib/dream/dream-control-observations.ts\",\"runtime\":{\"host\":\"port-3170\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146952717\",\"buildSha\":\"bd0781033d\"}},\"capturedAt\":\"2026-10-22T14:58:03.186Z\",\"expiresAt\":\"2026-10-22T14:59:03.186Z\"},{\"id\":\"r2:actual-attempts-or-explicit-policy-skips\",\"status\":\"unknown\",\"healthy\":false,\"reason\":\"actual-attempt-usage-or-explicit-policy-skip-required\",\"rawRefs\":[\"/actionDecisions\",\"/observations/activity/value/dream\"],\"sourceRefs\":[\"dream/dream-cycle-action:makeDreamCycleAction\",\"harness_shared.dream_runs\"],\"scope\":{\"workspaceId\":\"papercusp-workspace\",\"potSlug\":\"papercusp\",\"since\":\"2026-10-22T14:42:54.869Z\",\"until\":\"2026-10-22T14:57:54.869Z\",\"expectedRuntime\":{\"host\":\"port-3170\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146952717\",\"buildSha\":\"bd0781033d\"},\"actionJournalUnit\":\"papercusp-bg-host.service\",\"expectedActionRuntime\":{\"host\":\"port-3271\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146492889\",\"buildSha\":\"16b035a000\"},\"gymJournalUnit\":\"papercusp-bg-host.service\",\"expectedGymRuntime\":{\"host\":\"port-3271\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146492889\",\"buildSha\":\"16b035a000\"}},\"source\":{\"path\":\"packages/operator-core/lib/dream/dream-control-observations.ts\",\"runtime\":{\"host\":\"port-3170\",\"processId\":\"linux:b8c61f1d-f67c-43a8-ac9d-2286713e224f:146952717\",\"buildSha\":\"bd0781033d\"}},\"capturedAt\":\"2026-10-22T14:58:03.186Z\",\"expiresAt\":\"2026-10-22T14:59:03.186Z\"}]}},\"productR2Healthy\":false,\"sourcePaths\":[\"packages/operator-core/lib/dream/dream-control-observations.ts\",\"packages/operator-core/lib/sync-resolver/index.ts\"],\"methodOnly\":true}\n\nstdout | lib/dream/dream-control-observations.live.e2e.test.ts > Dream control observation live METHOD > retains coherent source/runtime/TTL and fail-closed clauses with native runtime witnesses\nDREAM_CONTROL_OPERATIONAL_RUN {\"ok\":true,\"runGroupId\":\"operational-native:c2b57ae5-981a-456d-8e8b-d1c6cd9f9019\",\"testRunIds\":[21772120],\"status\":\"pass\",\"runtimeEnvironmentMeasured\":true}\n\n \u2713 lib/dream/dream-control-observations.live.e2e.test.ts (1 test) 15479ms\n     \u2713 retains coherent source/runtime/TTL and fail-closed clauses with native runtime witnesses  15472ms\n\n Test Files  1 passed (1)\n      Tests  1 passed (1)\n   Start at  10:57:27\n   Duration  38.22s (transform 16.06s, setup 556ms, import 21.10s, tests 15.48s, environment 0ms)\n\nTEST_FILE_PROVENANCE head=3f1e22ce78 testedPaths=1 uncommitted=0 unknown=0 phase=post-run startedAt=2026-10-22T14:58:08.469Z\n  HEAD         : 3f1e22ce78\n  tested files : packages/operator-core/lib/dream/dream-control-observations.live.e2e.test.ts  [clean]\n  scope        : the NAMED paths above only \u2014 an edit to any OTHER module in their import graph invalidates this result just as thoroughly and is NOT measured here\nTEST_FILE_RESULT requested=1 executed=1 matched=1 status=passed head=3f1e22ce78 uncommittedPaths=0/1 provenance=stamped startedAt=2026-10-22T14:56:51.775Z childSubstituted=0 skippedTests=0\n\n\u2550\u2550\u2550 as committed at 3f1e22ce78 \u2550\u2550\u2550\n  PASS        test:file\n\nAll 1 check(s) pass AS COMMITTED at 3f1e22ce78.\n"
  }
}

