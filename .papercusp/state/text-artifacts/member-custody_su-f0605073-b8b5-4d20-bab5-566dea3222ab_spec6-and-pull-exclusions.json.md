---
rel_path: "member-custody/su-f0605073-b8b5-4d20-bab5-566dea3222ab/spec6-and-pull-exclusions.json"
updated_at: 1791506775513
_body: "content"
---

{
  "spec": {
    "ok": true,
    "source": "fleet",
    "spec": {
      "specVersion": "1.0",
      "specId": "fleet-launch-nonp2p-feature-drain-sol61-xhigh-0930-kinds",
      "revision": 6,
      "basedOn": "feature-change-reconciliation-and-zero-state-clarity-2026-09-05#D-026,D-027,D-028 plus gitnexus-selective-hardening-and-comparison-2026-09-13#Now, goal-brief-to-claimed-plan-work-2026-09-23#Now, review-verification-efficiency-2026-09-09#D-001 and WI-10000985 newest checkpoint; rem-dream-recombination-2026-08-17#D-023 solo-route exclusion, WI-10004487",
      "boundModel": "gpt-6.1-sol:xhigh",
      "view": {
        "filter": {
          "all": [
            {
              "op": "in",
              "field": "kind",
              "value": [
                "feature"
              ]
            },
            {
              "not": {
                "any": [
                  {
                    "op": "word",
                    "field": "title",
                    "value": "p2p"
                  },
                  {
                    "op": "word",
                    "field": "summary",
                    "value": "p2p"
                  },
                  {
                    "op": "word",
                    "field": "plan",
                    "value": "p2p"
                  },
                  {
                    "op": "word",
                    "field": "title",
                    "value": "shared-hive"
                  },
                  {
                    "op": "word",
                    "field": "summary",
                    "value": "shared-hive"
                  },
                  {
                    "op": "word",
                    "field": "plan",
                    "value": "shared-hive"
                  },
                  {
                    "op": "word",
                    "field": "title",
                    "value": "federation"
                  },
                  {
                    "op": "word",
                    "field": "summary",
                    "value": "federation"
                  },
                  {
                    "op": "word",
                    "field": "plan",
                    "value": "federation"
                  },
                  {
                    "op": "word",
                    "field": "title",
                    "value": "federated"
                  },
                  {
                    "op": "word",
                    "field": "summary",
                    "value": "federated"
                  },
                  {
                    "op": "word",
                    "field": "plan",
                    "value": "federated"
                  },
                  {
                    "op": "word",
                    "field": "title",
                    "value": "federate"
                  },
                  {
                    "op": "word",
                    "field": "summary",
                    "value": "federate"
                  },
                  {
                    "op": "word",
                    "field": "plan",
                    "value": "federate"
                  },
                  {
                    "op": "word",
                    "field": "title",
                    "value": "federates"
                  },
                  {
                    "op": "word",
                    "field": "summary",
                    "value": "federates"
                  },
                  {
                    "op": "word",
                    "field": "plan",
                    "value": "federates"
                  },
                  {
                    "op": "word",
                    "field": "title",
                    "value": "federating"
                  },
                  {
                    "op": "word",
                    "field": "summary",
                    "value": "federating"
                  },
                  {
                    "op": "word",
                    "field": "plan",
                    "value": "federating"
                  },
                  {
                    "op": "word",
                    "field": "title",
                    "value": "holepunch"
                  },
                  {
                    "op": "word",
                    "field": "summary",
                    "value": "holepunch"
                  },
                  {
                    "op": "word",
                    "field": "plan",
                    "value": "holepunch"
                  },
                  {
                    "op": "word",
                    "field": "title",
                    "value": "steering lease"
                  },
                  {
                    "op": "word",
                    "field": "summary",
                    "value": "steering lease"
                  },
                  {
                    "op": "word",
                    "field": "plan",
                    "value": "steering lease"
                  },
                  {
                    "op": "word",
                    "field": "title",
                    "value": "replication"
                  },
                  {
                    "op": "word",
                    "field": "summary",
                    "value": "replication"
                  },
                  {
                    "op": "word",
                    "field": "plan",
                    "value": "replication"
                  },
                  {
                    "op": "word",
                    "field": "title",
                    "value": "swarm"
                  },
                  {
                    "op": "word",
                    "field": "summary",
                    "value": "swarm"
                  },
                  {
                    "op": "word",
                    "field": "plan",
                    "value": "swarm"
                  },
                  {
                    "op": "word",
                    "field": "title",
                    "value": "hyperswarm"
                  },
                  {
                    "op": "word",
                    "field": "summary",
                    "value": "hyperswarm"
                  },
                  {
                    "op": "word",
                    "field": "plan",
                    "value": "hyperswarm"
                  },
                  {
                    "op": "word",
                    "field": "title",
                    "value": "hyperdht"
                  },
                  {
                    "op": "word",
                    "field": "summary",
                    "value": "hyperdht"
                  },
                  {
                    "op": "word",
                    "field": "plan",
                    "value": "hyperdht"
                  },
                  {
                    "op": "word",
                    "field": "title",
                    "value": "hyperbee"
                  },
                  {
                    "op": "word",
                    "field": "summary",
                    "value": "hyperbee"
                  },
                  {
                    "op": "word",
                    "field": "plan",
                    "value": "hyperbee"
                  },
                  {
                    "op": "word",
                    "field": "title",
                    "value": "dht"
                  },
                  {
                    "op": "word",
                    "field": "summary",
                    "value": "dht"
                  },
                  {
                    "op": "word",
                    "field": "plan",
                    "value": "dht"
                  },
                  {
                    "op": "word",
                    "field": "title",
                    "value": "udx"
                  },
                  {
                    "op": "word",
                    "field": "summary",
                    "value": "udx"
                  },
                  {
                    "op": "word",
                    "field": "plan",
                    "value": "udx"
                  },
                  {
                    "op": "word",
                    "field": "title",
                    "value": "relay"
                  },
                  {
                    "op": "word",
                    "field": "summary",
                    "value": "relay"
                  },
                  {
                    "op": "word",
                    "field": "plan",
                    "value": "relay"
                  },
                  {
                    "op": "word",
                    "field": "title",
                    "value": "pot-git"
                  },
                  {
                    "op": "word",
                    "field": "summary",
                    "value": "pot-git"
                  },
                  {
                    "op": "word",
                    "field": "plan",
                    "value": "pot-git"
                  },
                  {
                    "op": "word",
                    "field": "title",
                    "value": "ref-announce"
                  },
                  {
                    "op": "word",
                    "field": "summary",
                    "value": "ref-announce"
                  },
                  {
                    "op": "word",
                    "field": "plan",
                    "value": "ref-announce"
                  },
                  {
                    "op": "word",
                    "field": "title",
                    "value": "duplex"
                  },
                  {
                    "op": "word",
                    "field": "summary",
                    "value": "duplex"
                  },
                  {
                    "op": "word",
                    "field": "plan",
                    "value": "duplex"
                  },
                  {
                    "op": "word",
                    "field": "title",
                    "value": "hypercore"
                  },
                  {
                    "op": "word",
                    "field": "summary",
                    "value": "hypercore"
                  },
                  {
                    "op": "word",
                    "field": "plan",
                    "value": "hypercore"
                  },
                  {
                    "op": "word",
                    "field": "title",
                    "value": "hyperblobs"
                  },
                  {
                    "op": "word",
                    "field": "summary",
                    "value": "hyperblobs"
                  },
                  {
                    "op": "word",
                    "field": "plan",
                    "value": "hyperblobs"
                  },
                  {
                    "op": "word",
                    "field": "title",
                    "value": "hyperdrive"
                  },
                  {
                    "op": "word",
                    "field": "summary",
                    "value": "hyperdrive"
                  },
                  {
                    "op": "word",
                    "field": "plan",
                    "value": "hyperdrive"
                  },
                  {
                    "op": "word",
                    "field": "title",
                    "value": "autobase"
                  },
                  {
                    "op": "word",
                    "field": "summary",
                    "value": "autobase"
                  },
                  {
                    "op": "word",
                    "field": "plan",
                    "value": "autobase"
                  }
                ]
              }
            },
            {
              "not": {
                "op": "glob",
                "field": "plan",
                "value": "coordination-metadata-friction-reduction-2026-09-07"
              }
            },
            {
              "not": {
                "op": "glob",
                "field": "plan",
                "value": "backend-audit-diagnosis-before-repair-2026-09-13"
              }
            },
            {
              "not": {
                "op": "glob",
                "field": "plan",
                "value": "cupboard-release-pipeline-content-trust-2026-09-16"
              }
            },
            {
              "not": {
                "op": "glob",
                "field": "plan",
                "value": "portable-identity-packages-2026-09-26"
              }
            },
            {
              "not": {
                "op": "glob",
                "field": "plan",
                "value": "hud-orders-instant-load-2026-09-13"
              }
            },
            {
              "not": {
                "op": "glob",
                "field": "plan",
                "value": "pui-first-party-public-release-2026-09-07"
              }
            },
            {
              "not": {
                "op": "glob",
                "field": "plan",
                "value": "gitnexus-selective-hardening-and-comparison-2026-09-13"
              }
            },
            {
              "not": {
                "op": "in",
                "field": "id",
                "value": [
                  "WI-10002995",
                  "WI-10002996",
                  "WI-10003251"
                ]
              }
            },
            {
              "not": {
                "op": "glob",
                "field": "plan",
                "value": "goal-brief-to-claimed-plan-work-2026-09-23"
              }
            },
            {
              "not": {
                "op": "glob",
                "field": "plan",
                "value": "review-verification-efficiency-2026-09-09"
              }
            },
            {
              "not": {
                "op": "glob",
                "field": "plan",
                "value": "rem-dream-recombination-2026-08-17"
              }
            }
          ]
        }
      },
      "rank": {
        "mode": "lexicographic",
        "terms": [
          {
            "expr": "affinity(bee.held_paths,item.paths)",
            "dir": "desc"
          },
          {
            "expr": "severity_rank",
            "dir": "desc"
          },
          {
            "expr": "priority",
            "dir": "desc"
          },
          {
            "expr": "age",
            "dir": "asc"
          }
        ]
      },
      "limits": {
        "maxConcurrentClaims": 1
      },
      "states": [
        "open"
      ]
    },
    "revision": 6,
    "updatedBy": "su-0da9d55e-30de-4a57-9380-8c81a7e3c99d",
    "updatedAt": "2026-09-30 21:58:46.110004-04",
    "harnessSlug": "papercusp",
    "fleetSlug": "nonp2p-feature-drain-sol61-xhigh-0930"
  },
  "pull": {
    "at": "2026-10-09T00:27:09.130Z",
    "call_id": "call_c194918faabf49a390dc3d7080856fb1",
    "value": {
      "ok": false,
      "error": "POOL BLOCKED, NOT SPEC-BROKEN (EI-18741523426513509): claim spec fleet-launch-nonp2p-feature-drain-sol61-xhigh-0930-kinds (spec rev 6)'s view.filter matched 78 issue/feature-family row(s), but every one is presently excluded by a claim floor (see `excludedBreakdownSummary`) — an uncleared plan-lane blocker, a peer's claim-hold, needs-human, or similar. This is an EFFECT (the pool is momentarily gated), not a CAUSE (a wrong/over-narrow spec) — the two have opposite remedies (await/re-poll vs. rewrite the spec), so do NOT treat this as a spec-authoring problem: it very likely self-clears once the gating condition lifts, with no spec change required.",
      "fleetScope": {
        "fleet": "nonp2p-feature-drain-sol61-xhigh-0930",
        "specId": "fleet-launch-nonp2p-feature-drain-sol61-xhigh-0930-kinds",
        "revision": 6,
        "source": "fleet"
      },
      "claimability": {
        "value": 0,
        "population": {
          "kind": "fleet-claim-spec",
          "fleet": "nonp2p-feature-drain-sol61-xhigh-0930",
          "harness": "papercusp",
          "spec": {
            "ref": "fleet-launch-nonp2p-feature-drain-sol61-xhigh-0930-kinds (spec rev 6)",
            "revision": 6,
            "source": "fleet",
            "planScoped": true
          },
          "basis": "issue+feature-family",
          "matchedByFilter": 78,
          "excluded": {
            "taken": 0,
            "claimHold": 0,
            "needsOwnerAction": 0,
            "agentReview": 0,
            "observationLane": 0,
            "externalBlocker": 0,
            "planLaneReserved": 0,
            "federationDetector": 0,
            "loopNoise": 0,
            "alreadyCompleted": 0,
            "watchdogRecovery": 0,
            "crossMachineRig": 0,
            "blockedDep": 0,
            "cooldown": 0,
            "remoteOrigin": 0,
            "admissionPending": 0,
            "liveGateOps": 0,
            "stopTheLine": 0,
            "featureClaimFloors": 78,
            "featureReservedPlanLane": 18
          },
          "families": {
            "issue": {
              "claimable": 0,
              "matchedByFilter": 0,
              "excluded": {
                "taken": 0,
                "claimHold": 0,
                "needsOwnerAction": 0,
                "agentReview": 0,
                "observationLane": 0,
                "externalBlocker": 0,
                "planLaneReserved": 0,
                "federationDetector": 0,
                "loopNoise": 0,
                "alreadyCompleted": 0,
                "watchdogRecovery": 0,
                "crossMachineRig": 0,
                "blockedDep": 0,
                "cooldown": 0,
                "remoteOrigin": 0,
                "admissionPending": 0,
                "liveGateOps": 0,
                "stopTheLine": 0
              }
            },
            "feature": {
              "matchedByFilter": 78,
              "claimable": 0,
              "excluded": {
                "claimFloors": 78,
                "reservedPlanLane": 18
              }
            }
          }
        },
        "interpretation": {
          "state": "floor-gated",
          "exactness": {
            "status": "exact",
            "reason": "matched rows exist and every one is excluded by one or more claim floors"
          },
          "evidence": {
            "fleetPaused": false,
            "matchedByFilter": 78,
            "excluded": {
              "taken": 0,
              "claimHold": 0,
              "needsOwnerAction": 0,
              "agentReview": 0,
              "observationLane": 0,
              "externalBlocker": 0,
              "planLaneReserved": 0,
              "federationDetector": 0,
              "loopNoise": 0,
              "alreadyCompleted": 0,
              "watchdogRecovery": 0,
              "crossMachineRig": 0,
              "blockedDep": 0,
              "cooldown": 0,
              "remoteOrigin": 0,
              "admissionPending": 0,
              "liveGateOps": 0,
              "stopTheLine": 0,
              "featureClaimFloors": 78,
              "featureReservedPlanLane": 18
            }
          }
        }
      },
      "quarantinedIds": [],
      "windDown": true,
      "payloadFilter": {
        "all": [
          {
            "harness": {
              "equals": "papercusp"
            }
          },
          {
            "all": [
              {
                "kind": {
                  "in": [
                    "feature"
                  ]
                }
              },
              {
                "not": {
                  "plan": {
                    "matches": {
                      "source": "^coordination-metadata-friction-reduction-2026-09-07$",
                      "flags": "i"
                    }
                  }
                }
              },
              {
                "not": {
                  "plan": {
                    "matches": {
                      "source": "^backend-audit-diagnosis-before-repair-2026-09-13$",
                      "flags": "i"
                    }
                  }
                }
              },
              {
                "not": {
                  "plan": {
                    "matches": {
                      "source": "^cupboard-release-pipeline-content-trust-2026-09-16$",
                      "flags": "i"
                    }
                  }
                }
              },
              {
                "not": {
                  "plan": {
                    "matches": {
                      "source": "^portable-identity-packages-2026-09-26$",
                      "flags": "i"
                    }
                  }
                }
              },
              {
                "not": {
                  "plan": {
                    "matches": {
                      "source": "^hud-orders-instant-load-2026-09-13$",
                      "flags": "i"
                    }
                  }
                }
              },
              {
                "not": {
                  "plan": {
                    "matches": {
                      "source": "^pui-first-party-public-release-2026-09-07$",
                      "flags": "i"
                    }
                  }
                }
              },
              {
                "not": {
                  "plan": {
                    "matches": {
                      "source": "^gitnexus-selective-hardening-and-comparison-2026-09-13$",
                      "flags": "i"
                    }
                  }
                }
              },
              {
                "not": {
                  "id": {
                    "in": [
                      "WI-10002995",
                      "WI-10002996",
                      "WI-10003251"
                    ]
                  }
                }
              },
              {
                "not": {
                  "plan": {
                    "matches": {
                      "source": "^goal-brief-to-claimed-plan-work-2026-09-23$",
                      "flags": "i"
                    }
                  }
                }
              },
              {
                "not": {
                  "plan": {
                    "matches": {
                      "source": "^review-verification-efficiency-2026-09-09$",
                      "flags": "i"
                    }
                  }
                }
              },
              {
                "not": {
                  "plan": {
                    "matches": {
                      "source": "^rem-dream-recombination-2026-08-17$",
                      "flags": "i"
                    }
                  }
                }
              }
            ]
          }
        ]
      },
      "reason": "all_matches_gated",
      "featureBreakdown": {
        "matchedByFilter": 78,
        "claimable": 0,
        "excluded": {
          "claimFloors": 78,
          "reservedPlanLane": 18
        }
      },
      "leaderLiveness": true,
      "excludedBreakdown": {
        "matchedByFilter": 0,
        "claimable": 0,
        "affinityCoverage": {
          "denominator": 0,
          "nonEmptyPaths": 0,
          "floor": 0.5,
          "belowFloor": false
        },
        "excluded": {
          "taken": 0,
          "claimHold": 0,
          "needsOwnerAction": 0,
          "agentReview": 0,
          "observationLane": 0,
          "externalBlocker": 0,
          "planLaneReserved": 0,
          "federationDetector": 0,
          "loopNoise": 0,
          "alreadyCompleted": 0,
          "watchdogRecovery": 0,
          "crossMachineRig": 0,
          "blockedDep": 0,
          "cooldown": 0,
          "remoteOrigin": 0,
          "admissionPending": 0,
          "liveGateOps": 0,
          "stopTheLine": 0
        },
        "queueControl": {
          "activeClaims": 0,
          "rawClaimHolds": 0,
          "holdOpenLeases": 0,
          "durableParks": 0,
          "unattributedClaimHolds": 0,
          "pendingAgentReview": 0,
          "revisionRequestedAgentReview": 0
        }
      },
      "excludedBreakdownSummary": "Your spec's filter matches 0 issue-family and 78 feature-family row(s); feature claim floors exclude 78 unique row(s), including 18 reserved plan-lane row(s) (an overlapping subset). These are real pre-floor matches, not an empty spec; see featureBreakdown and claimability.population.families.",
      "advice": "This is a FLOOR-GATED miss (WI-5561 / EI-18741523426513509), not a scope/spec mismatch — quote `reason: \"all_matches_gated\"` if you report it (do NOT quote spec_matches_nothing; that is a different, spec-authoring problem with the opposite remedy). Do NOT re-author the claim spec. See `excludedBreakdownSummary` for which floors (federation-detector / owner-action / claim-hold / observation-lane / plan-lane externalBlocker / …) are excluding your spec's matched rows — these floors are commonly TRANSIENT (e.g. an uncleared plan-lane gate that clears the moment a dependency plan-item closes) and often self-resolve within seconds to minutes with no intervention. Checkpoint, release, call loop:end { acknowledgeOpenDirectives: true, acknowledgeWakeLessAutonomy: true }, and report the breakdown to your fleet leader if it persists — a floor-gated pool needs a DIFFERENT lane/scope (or the gating condition itself resolved by whoever owns it), not a claim-spec re-author. You may still park the standing watch `watch:create { pattern: \"work-item:claimable\", wake:true, once:false, payload_filter: <the `payloadFilter` returned in this response> }` in case a floor lifts (a claim-hold or owner-action gate clears) and end your turn — do not pass targetKind with wake:true; its wake is a HINT and the watch remains armed."
    }
  }
}
