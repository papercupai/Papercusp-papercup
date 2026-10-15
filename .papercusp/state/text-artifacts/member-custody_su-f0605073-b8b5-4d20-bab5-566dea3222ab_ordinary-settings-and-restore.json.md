---
rel_path: "member-custody/su-f0605073-b8b5-4d20-bab5-566dea3222ab/ordinary-settings-and-restore.json"
updated_at: 1791506775513
_body: "content"
---

{
  "originalReceipt": {
    "at": "2026-10-09T00:28:05.908Z",
    "call_id": "call_6bd34d4cfa404deda3f937696f174ef3",
    "value": {
      "ok": true,
      "watch": {
        "id": 251818,
        "pattern": "work-item:claimable",
        "wake": true,
        "once": false,
        "min_sleep_sec": 60,
        "urgency": false,
        "expires_ts": null,
        "on_timeout": "wake",
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
        }
      },
      "wake_handle": "session #38388 (codex) — injectable/resumable",
      "advice": "Registered a standing wake watch (floored). End your turn — you will be re-woken on matches, at most once per min_sleep_sec, with bursts coalesced into one wake."
    }
  },
  "completeCanonicalRow": {
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
  "originalExpiresTs": null,
  "expirySemantics": "indefinite; omit timeout_sec on restore",
  "restoreTool": "watch:create",
  "restoreArgs": {
    "pattern": "work-item:claimable",
    "wake": true,
    "once": false,
    "min_sleep_sec": 60,
    "urgency": false,
    "on_timeout": "wake",
    "note": "Restoration member: further scheduler pulls only after a newly delivered canonical feature event; retain inherited spec6/cap1.",
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
    }
  },
  "restorePrerequisites": "Only actual generation1 admission-qualified gate DELIVERY; reread current decisions and effective spec before restore. Restore ordinary watch before normal pulls. D008 HOLD supersedes earlier startup/event pull permission."
}
