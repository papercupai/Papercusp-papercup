---
rel_path: "member-custody/su-f0605073-b8b5-4d20-bab5-566dea3222ab/events-before-quiet.json"
updated_at: 1791506656950
_body: "content"
---

{
  "source": "read-only event_awaits exact own ids",
  "rows": [
    {
      "id": 251777,
      "workspace_id": "default",
      "subscriber_id": "su-f0605073-b8b5-4d20-bab5-566dea3222ab",
      "event_key": "coord:inbox-wake:su-f0605073-b8b5-4d20-bab5-566dea3222ab",
      "policy": "wake",
      "note": "always-armed inbox-wake (turn-lifecycle-control)",
      "wake_handle": {
        "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
        "pid": null,
        "kind": "adv-session",
        "agent": "codex",
        "sessionId": "01a11e08-c686-7b21-9f7f-22d0e23950c9",
        "ompThreadId": null,
        "advSessionId": 38388
      },
      "timeout_behavior": "expire",
      "expires_ts": null,
      "created_at": "2026-10-08 20:20:41.174799-04",
      "fired_at": null,
      "fired_reason": null,
      "cancelled_at": null,
      "once": false,
      "min_sleep_sec": 60,
      "urgency": false,
      "payload_filter": null,
      "scope_kind": null,
      "scope_ref": null,
      "node_id": null,
      "root_id": null,
      "member_fired_at": null,
      "member_payload": null,
      "causal_generation": null,
      "expected_condition": null,
      "superseded_at": null,
      "fired_by": null,
      "fired_payload": null,
      "producer_health": null,
      "timeout_verification": null,
      "verification_claimed_at": null,
      "bound_to": null,
      "cancel_reason": null,
      "logical_gate_key": null,
      "fired_delivery_intent_at": null
    },
    {
      "id": 251818,
      "workspace_id": "default",
      "subscriber_id": "su-f0605073-b8b5-4d20-bab5-566dea3222ab",
      "event_key": "work-item:claimable",
      "policy": "wake",
      "note": "Restoration member: further scheduler pulls only after a newly delivered canonical feature event; retain inherited spec6/cap1.",
      "wake_handle": {
        "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
        "pid": null,
        "kind": "adv-session",
        "agent": "codex",
        "sessionId": "01a11e08-c686-7b21-9f7f-22d0e23950c9",
        "ompThreadId": null,
        "advSessionId": 38388
      },
      "timeout_behavior": "wake",
      "expires_ts": null,
      "created_at": "2026-10-08 20:27:48.163613-04",
      "fired_at": null,
      "fired_reason": null,
      "cancelled_at": null,
      "once": false,
      "min_sleep_sec": 60,
      "urgency": false,
      "payload_filter": {
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
                      "flags": "i",
                      "source": "^coordination-metadata-friction-reduction-2026-09-07$"
                    }
                  }
                }
              },
              {
                "not": {
                  "plan": {
                    "matches": {
                      "flags": "i",
                      "source": "^backend-audit-diagnosis-before-repair-2026-09-13$"
                    }
                  }
                }
              },
              {
                "not": {
                  "plan": {
                    "matches": {
                      "flags": "i",
                      "source": "^cupboard-release-pipeline-content-trust-2026-09-16$"
                    }
                  }
                }
              },
              {
                "not": {
                  "plan": {
                    "matches": {
                      "flags": "i",
                      "source": "^portable-identity-packages-2026-09-26$"
                    }
                  }
                }
              },
              {
                "not": {
                  "plan": {
                    "matches": {
                      "flags": "i",
                      "source": "^hud-orders-instant-load-2026-09-13$"
                    }
                  }
                }
              },
              {
                "not": {
                  "plan": {
                    "matches": {
                      "flags": "i",
                      "source": "^pui-first-party-public-release-2026-09-07$"
                    }
                  }
                }
              },
              {
                "not": {
                  "plan": {
                    "matches": {
                      "flags": "i",
                      "source": "^gitnexus-selective-hardening-and-comparison-2026-09-13$"
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
                      "flags": "i",
                      "source": "^goal-brief-to-claimed-plan-work-2026-09-23$"
                    }
                  }
                }
              },
              {
                "not": {
                  "plan": {
                    "matches": {
                      "flags": "i",
                      "source": "^review-verification-efficiency-2026-09-09$"
                    }
                  }
                }
              },
              {
                "not": {
                  "plan": {
                    "matches": {
                      "flags": "i",
                      "source": "^rem-dream-recombination-2026-08-17$"
                    }
                  }
                }
              }
            ]
          }
        ]
      },
      "scope_kind": null,
      "scope_ref": null,
      "node_id": null,
      "root_id": null,
      "member_fired_at": null,
      "member_payload": null,
      "causal_generation": null,
      "expected_condition": null,
      "superseded_at": null,
      "fired_by": null,
      "fired_payload": null,
      "producer_health": null,
      "timeout_verification": null,
      "verification_claimed_at": null,
      "bound_to": null,
      "cancel_reason": null,
      "logical_gate_key": null,
      "fired_delivery_intent_at": null
    },
    {
      "id": 251883,
      "workspace_id": "default",
      "subscriber_id": "su-f0605073-b8b5-4d20-bab5-566dea3222ab",
      "event_key": "fleet:nonp2p-feature-drain-sol61-xhigh-0930:admission-qualified-d008",
      "policy": "wake",
      "note": "D008/D011 member f0605 quiet custody: generation1 admission-qualified gate only; no timeout, loop, ordinary feature or inbox hint authorizes further pulls. On actual gate delivery reread decisions/effective spec and restore saved ordinary watch before any normal pulls.",
      "wake_handle": {
        "cwd": "/home/marsh-office/papercupai-workspace/papercusp",
        "pid": null,
        "kind": "adv-session",
        "agent": "codex",
        "sessionId": "01a11e08-c686-7b21-9f7f-22d0e23950c9",
        "ompThreadId": null,
        "advSessionId": 38388
      },
      "timeout_behavior": "expire",
      "expires_ts": "2026-10-15 20:38:11.886-04",
      "created_at": "2026-10-08 20:38:11.895243-04",
      "fired_at": null,
      "fired_reason": null,
      "cancelled_at": null,
      "once": true,
      "min_sleep_sec": null,
      "urgency": false,
      "payload_filter": null,
      "scope_kind": null,
      "scope_ref": null,
      "node_id": null,
      "root_id": null,
      "member_fired_at": null,
      "member_payload": null,
      "causal_generation": null,
      "expected_condition": null,
      "superseded_at": null,
      "fired_by": null,
      "fired_payload": null,
      "producer_health": null,
      "timeout_verification": null,
      "verification_claimed_at": null,
      "bound_to": null,
      "cancel_reason": null,
      "logical_gate_key": null,
      "fired_delivery_intent_at": null
    }
  ]
}
