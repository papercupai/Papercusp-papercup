---
rel_path: "audits/parked-refresh-29283/rows.json"
updated_at: 1792996869100
_body: "content"
---

[
  {
    "n": 1,
    "id": "su-034085e8-1170-4bbd-bcbd-668ee070b4b2",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 0,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "listener",
          "event": "coord:inbox-wake:su-034085e8-1170-4bbd-bcbd-668ee070b4b2"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": false,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": []
  },
  {
    "n": 2,
    "id": "su-121588b4-6958-4f3b-ade0-da6c3e306a27",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 1,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "listener",
          "event": "coord:inbox-wake:su-121588b4-6958-4f3b-ade0-da6c3e306a27"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": false,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": false,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": [
      {
        "id": "work:su-121588b4-6958-4f3b-ade0-da6c3e306a27:papercusp:EI-26821810700706198",
        "kind": "work",
        "ownerId": "su-121588b4-6958-4f3b-ade0-da6c3e306a27",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "EI-26821810700706198",
              "harness": "papercusp",
              "title": "P001 source publication blocked by recurring root disk reserve breach and git-sync fetch refusals",
              "state": "blocked"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No structured value recorded.",
            "recordedAt": "2026-10-26T05:41:16.788Z"
          },
          "left": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No structured value recorded.",
            "recordedAt": "2026-10-26T05:41:16.788Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 1,
              "detailRecords": true
            },
            "source": "work_items.payload.externalBlockers (recorded holds, not live clearance)",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "known",
            "value": false,
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "A recorded owner, external or state hold remains in force."
          }
        }
      },
      {
        "id": "work:su-121588b4-6958-4f3b-ade0-da6c3e306a27:papercusp:EI-26821810700706198:blocker:0",
        "kind": "work",
        "ownerId": "su-121588b4-6958-4f3b-ade0-da6c3e306a27",
        "fields": {
          "blocker": {
            "status": "known",
            "value": {
              "workItem": "EI-26821810700706198",
              "kind": "runtime",
              "ref": "git-sync:papercusp",
              "summary": "Storage reserve admission measured recovered; final maintained writer readiness verdict is still in progress after bounded45s retry.",
              "capability": "live-dependency"
            },
            "source": "work_items.payload.externalBlockers (recorded hold)",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "recordedAt": "2026-10-26T05:18:56.006Z"
          },
          "clearance": {
            "status": "unknown",
            "source": "live blocker producer",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No unambiguous supported producer state was available; the recorded hold remains in force."
          }
        }
      }
    ]
  },
  {
    "n": 3,
    "id": "su-1aad2883-c2c7-4724-a83e-dcb4c7398780",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 0,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "listener",
          "event": "coord:inbox-wake:su-1aad2883-c2c7-4724-a83e-dcb4c7398780"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": false,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": false,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": []
  },
  {
    "n": 4,
    "id": "su-1c4234ac-daad-4171-8282-479adcf4c88a",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 0,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "listener",
          "event": "coord:inbox-wake:su-1c4234ac-daad-4171-8282-479adcf4c88a"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": false,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": []
  },
  {
    "n": 5,
    "id": "su-2631b06c-a3ff-4597-ae90-d7f9d46dfee9",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 2,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "substantive",
          "event": "conversation:answered:conv-mv6lk58n-0000-cdcfe4862aa04b76b6675cb9a92a6cba"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "unknown",
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z",
        "reason": "No independently executable step was established; inspect each work record for the missing evidence or hold."
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": [
      {
        "id": "work:su-2631b06c-a3ff-4597-ae90-d7f9d46dfee9:papercusp:EI-25767817934968832",
        "kind": "work",
        "ownerId": "su-2631b06c-a3ff-4597-ae90-d7f9d46dfee9",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "EI-25767817934968832",
              "harness": "papercusp",
              "title": "Bulk-scratch /tmp exhaustion blocks agent control-plane initialization before operator dispatch",
              "state": "open"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No structured value recorded.",
            "recordedAt": "2026-10-25T21:25:57.683Z"
          },
          "left": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No structured value recorded.",
            "recordedAt": "2026-10-25T21:25:57.683Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 0,
              "unresolvedDependencies": 0,
              "dependencies": [],
              "truncatedByLimit": false
            },
            "source": "work_items + work_item_deps canonical unresolved-blocker reader",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "unknown",
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No current, subject-matching next step is available."
          }
        }
      },
      {
        "id": "work:su-2631b06c-a3ff-4597-ae90-d7f9d46dfee9:papercusp:EI-25800184592103661",
        "kind": "work",
        "ownerId": "su-2631b06c-a3ff-4597-ae90-d7f9d46dfee9",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "EI-25800184592103661",
              "harness": "papercusp",
              "title": "tools:invoke → dev:pipeline_position tool-call failure (upstream_died_mid_stream)",
              "state": "open"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No structured value recorded.",
            "recordedAt": "2026-10-25T21:25:56.348Z"
          },
          "left": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No structured value recorded.",
            "recordedAt": "2026-10-25T21:25:56.348Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 0,
              "unresolvedDependencies": 0,
              "dependencies": [],
              "truncatedByLimit": false
            },
            "source": "work_items + work_item_deps canonical unresolved-blocker reader",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "unknown",
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No current, subject-matching next step is available."
          }
        }
      }
    ]
  },
  {
    "n": 6,
    "id": "su-352ac68d-6750-463a-bea4-845cf4e42bf9",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 0,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "substantive",
          "event": "plan:r2-to-gcs-storage-migration-2026-10-23:r2-to-gcs-storage-migration-complete"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": false,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": []
  },
  {
    "n": 7,
    "id": "su-35f7dfa1-063b-44b2-a2ab-283283a08979",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 0,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "substantive",
          "event": "plan:acceptance:blind-reviewer-disposable-runtime-broker-2026-10-25"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": false,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": []
  },
  {
    "n": 8,
    "id": "su-3cde87ef-8d98-4dbf-b0f1-a6570a8238bd",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 0,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "listener",
          "event": "coord:inbox-wake:su-3cde87ef-8d98-4dbf-b0f1-a6570a8238bd"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": false,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": []
  },
  {
    "n": 9,
    "id": "su-3de6dd1e-08a1-4869-b9ba-bf9adaae0031",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 9,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "substantive",
          "event": "task:terminal:0mvok0m421w7h5551ju"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": true,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": [
      {
        "id": "work:su-3de6dd1e-08a1-4869-b9ba-bf9adaae0031:papercusp:EI-26704834706423075",
        "kind": "work",
        "ownerId": "su-3de6dd1e-08a1-4869-b9ba-bf9adaae0031",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "EI-26704834706423075",
              "harness": "papercusp",
              "title": "Measure an over-cap admission radius in bounded chunks before publication",
              "state": "open"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "Checkpoint subject or authored span is stale, missing or unverified.",
            "recordedAt": "2026-10-26T03:47:40.148Z"
          },
          "left": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "Checkpoint subject or authored span is stale, missing or unverified.",
            "recordedAt": "2026-10-26T03:47:40.148Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 0,
              "unresolvedDependencies": 0,
              "dependencies": [],
              "truncatedByLimit": false
            },
            "source": "work_items + work_item_deps canonical unresolved-blocker reader",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "unknown",
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No current, subject-matching next step is available."
          }
        }
      },
      {
        "id": "work:su-3de6dd1e-08a1-4869-b9ba-bf9adaae0031:papercusp:EI-26902763842338940",
        "kind": "work",
        "ownerId": "su-3de6dd1e-08a1-4869-b9ba-bf9adaae0031",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "EI-26902763842338940",
              "harness": "papercusp",
              "title": "Immutable admission radius fetches reached cross-workspace blobs one at a time",
              "state": "open"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "Checkpoint subject or authored span is stale, missing or unverified.",
            "recordedAt": "2026-10-26T03:47:40.038Z"
          },
          "left": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "Checkpoint subject or authored span is stale, missing or unverified.",
            "recordedAt": "2026-10-26T03:47:40.038Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 0,
              "unresolvedDependencies": 0,
              "dependencies": [],
              "truncatedByLimit": false
            },
            "source": "work_items + work_item_deps canonical unresolved-blocker reader",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "unknown",
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No current, subject-matching next step is available."
          }
        }
      },
      {
        "id": "work:su-3de6dd1e-08a1-4869-b9ba-bf9adaae0031:papercusp:EI-26920945369410477",
        "kind": "work",
        "ownerId": "su-3de6dd1e-08a1-4869-b9ba-bf9adaae0031",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "EI-26920945369410477",
              "harness": "papercusp",
              "title": "Staging candidate bundled spawn-mcp importer before pinned codex dispatcher exporter",
              "state": "open"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "Checkpoint subject or authored span is stale, missing or unverified.",
            "recordedAt": "2026-10-26T03:47:39.888Z"
          },
          "left": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "Checkpoint subject or authored span is stale, missing or unverified.",
            "recordedAt": "2026-10-26T03:47:39.888Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 0,
              "unresolvedDependencies": 0,
              "dependencies": [],
              "truncatedByLimit": false
            },
            "source": "work_items + work_item_deps canonical unresolved-blocker reader",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "unknown",
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No current, subject-matching next step is available."
          }
        }
      },
      {
        "id": "work:su-3de6dd1e-08a1-4869-b9ba-bf9adaae0031:papercusp:EI-26943236233404464",
        "kind": "work",
        "ownerId": "su-3de6dd1e-08a1-4869-b9ba-bf9adaae0031",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "EI-26943236233404464",
              "harness": "papercusp",
              "title": "Original R6 cannot collect tests because committed-source loader rejects Vite config",
              "state": "open"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "Checkpoint subject or authored span is stale, missing or unverified.",
            "recordedAt": "2026-10-26T06:18:22.938Z"
          },
          "left": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "Checkpoint subject or authored span is stale, missing or unverified.",
            "recordedAt": "2026-10-26T06:18:22.938Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 0,
              "unresolvedDependencies": 0,
              "dependencies": [],
              "truncatedByLimit": false
            },
            "source": "work_items + work_item_deps canonical unresolved-blocker reader",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "unknown",
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No current, subject-matching next step is available."
          }
        }
      },
      {
        "id": "work:su-3de6dd1e-08a1-4869-b9ba-bf9adaae0031:papercusp:EI-26961427216041080",
        "kind": "work",
        "ownerId": "su-3de6dd1e-08a1-4869-b9ba-bf9adaae0031",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "EI-26961427216041080",
              "harness": "papercusp",
              "title": "Fresh frozen R6 private-PG run fails previously green UI collection with No such built-in module node:",
              "state": "open"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "Checkpoint subject or authored span is stale, missing or unverified.",
            "recordedAt": "2026-10-26T06:18:22.938Z"
          },
          "left": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "Checkpoint subject or authored span is stale, missing or unverified.",
            "recordedAt": "2026-10-26T06:18:22.938Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 0,
              "unresolvedDependencies": 0,
              "dependencies": [],
              "truncatedByLimit": false
            },
            "source": "work_items + work_item_deps canonical unresolved-blocker reader",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "unknown",
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No current, subject-matching next step is available."
          }
        }
      },
      {
        "id": "work:su-3de6dd1e-08a1-4869-b9ba-bf9adaae0031:papercusp:EI-26991429230697440",
        "kind": "work",
        "ownerId": "su-3de6dd1e-08a1-4869-b9ba-bf9adaae0031",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "EI-26991429230697440",
              "harness": "papercusp",
              "title": "Owned R6 worker ends unobserved while queue stays running and terminal await times out",
              "state": "open"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "Checkpoint subject or authored span is stale, missing or unverified.",
            "recordedAt": "2026-10-26T06:18:22.938Z"
          },
          "left": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "Checkpoint subject or authored span is stale, missing or unverified.",
            "recordedAt": "2026-10-26T06:18:22.938Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 0,
              "unresolvedDependencies": 0,
              "dependencies": [],
              "truncatedByLimit": false
            },
            "source": "work_items + work_item_deps canonical unresolved-blocker reader",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "unknown",
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No current, subject-matching next step is available."
          }
        }
      },
      {
        "id": "work:su-3de6dd1e-08a1-4869-b9ba-bf9adaae0031:papercusp:WI-10007649",
        "kind": "work",
        "ownerId": "su-3de6dd1e-08a1-4869-b9ba-bf9adaae0031",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "WI-10007649",
              "harness": "papercusp",
              "title": "Drive Avi's Slack/Asana bug-to-PR workflow plan through shipment",
              "state": "open"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "known",
            "value": "Only main shipment lane remains here: PRIMARYawait370914 EXACTtask:terminal:0mvok0m421w7h5551ju until2026-10-26T06:35:55.266Z. Late990548 is alreadyhandled/inflightduplicate, doNOTreset370914. Onterminalfullnormalizedguarded/imported/report",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "recordedAt": "2026-10-26T06:16:53.365Z",
            "truncated": true,
            "evidenceRef": "work_items:get"
          },
          "left": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No structured value recorded.",
            "recordedAt": "2026-10-26T06:16:53.365Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 0,
              "unresolvedDependencies": 0,
              "dependencies": [],
              "truncatedByLimit": false
            },
            "source": "work_items + work_item_deps canonical unresolved-blocker reader",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "known",
            "value": true,
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "The assigned current step has registered AUTO authority and no measured work dependency or recorded hold. This is evidence, not a new grant of authority."
          }
        }
      },
      {
        "id": "work:su-3de6dd1e-08a1-4869-b9ba-bf9adaae0031:papercusp:WI-6554700010020243",
        "kind": "work",
        "ownerId": "su-3de6dd1e-08a1-4869-b9ba-bf9adaae0031",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "WI-6554700010020243",
              "harness": "papercusp",
              "title": "Classify and repair frozen gate 8d9b6463 (authorized release-fixer attempt 1)",
              "state": "open"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "known",
            "value": "Use370914 only. Terminalcompleteclassification→freshcloneCAS/helper2exactc93→133→original4. TimeoutexacteventfirstthenONEownprogressdelta/no-delta1diagnosis. EI270167done; doNOTretest/reclose/reaudit. Rootmain gate lane remains excluded.",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "recordedAt": "2026-10-26T06:16:53.463Z"
          },
          "left": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No structured value recorded.",
            "recordedAt": "2026-10-26T06:16:53.463Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 0,
              "unresolvedDependencies": 0,
              "dependencies": [],
              "truncatedByLimit": false
            },
            "source": "work_items + work_item_deps canonical unresolved-blocker reader",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "known",
            "value": true,
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "The assigned current step has registered AUTO authority and no measured work dependency or recorded hold. This is evidence, not a new grant of authority."
          }
        }
      },
      {
        "id": "work:su-3de6dd1e-08a1-4869-b9ba-bf9adaae0031:papercusp:WI-6554700010025640",
        "kind": "work",
        "ownerId": "su-3de6dd1e-08a1-4869-b9ba-bf9adaae0031",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "WI-6554700010025640",
              "harness": "papercusp",
              "title": "Wire complete aggregates into the existing ratchet/queue CAS, verify small-mode compatibility and qualify the original clone through current",
              "state": "open"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "known",
            "value": "Await370914; fullnormalizedterminalclassificationbeforefreshcloneCAS/helper2c93→133→original4/P016/exactSHIP. No rootgateops, duplicatemonitor/sourceaudit/nativefixrerun.",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "recordedAt": "2026-10-26T06:16:53.599Z"
          },
          "left": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No structured value recorded.",
            "recordedAt": "2026-10-26T06:16:53.599Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 0,
              "unresolvedDependencies": 0,
              "dependencies": [],
              "truncatedByLimit": false
            },
            "source": "work_items + work_item_deps canonical unresolved-blocker reader",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "known",
            "value": true,
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "The assigned current step has registered AUTO authority and no measured work dependency or recorded hold. This is evidence, not a new grant of authority."
          }
        }
      }
    ]
  },
  {
    "n": 10,
    "id": "su-459931b4-da8d-44fd-a216-257aae418e27",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 2,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "listener",
          "event": "coord:inbox-wake:su-459931b4-da8d-44fd-a216-257aae418e27"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": true,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": [
      {
        "id": "work:su-459931b4-da8d-44fd-a216-257aae418e27:papercusp:WI-6554700010008495",
        "kind": "work",
        "ownerId": "su-459931b4-da8d-44fd-a216-257aae418e27",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "WI-6554700010008495",
              "harness": "papercusp",
              "title": "Operator e2e run has no reporter result: operator-e2e-nightly:sched-.routinesTick-2026-10-11T08:30:00.000Z-51",
              "state": "blocked"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No structured value recorded.",
            "recordedAt": "2026-10-25T23:19:08.245Z"
          },
          "left": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No structured value recorded.",
            "recordedAt": "2026-10-25T23:19:08.245Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 1,
              "detailRecords": true
            },
            "source": "work_items.payload.externalBlockers (recorded holds, not live clearance)",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "known",
            "value": false,
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "A recorded owner, external or state hold remains in force."
          }
        }
      },
      {
        "id": "work:su-459931b4-da8d-44fd-a216-257aae418e27:papercusp:WI-6554700010008495:blocker:0",
        "kind": "work",
        "ownerId": "su-459931b4-da8d-44fd-a216-257aae418e27",
        "fields": {
          "blocker": {
            "status": "known",
            "value": {
              "workItem": "WI-6554700010008495",
              "kind": "runtime",
              "ref": "/home/marsh-office/.papercusp/logs/operator-e2e-isolated/2026-10-11T08-30-02-693Z-0mv3kbrus1tv0ilh9kq.log",
              "summary": "The Oct 11 reporter outcome cannot be attributed: its exact task log is absent, its run group has no test_runs rows, and the later retry failed before Playwright.",
              "capability": "live-dependency"
            },
            "source": "work_items.payload.externalBlockers (recorded hold)",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "recordedAt": "2026-10-25T20:56:45.876Z"
          },
          "clearance": {
            "status": "unknown",
            "source": "live blocker producer",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No unambiguous supported producer state was available; the recorded hold remains in force."
          }
        }
      },
      {
        "id": "work:su-459931b4-da8d-44fd-a216-257aae418e27:papercusp:WI-6554700010009465",
        "kind": "work",
        "ownerId": "su-459931b4-da8d-44fd-a216-257aae418e27",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "WI-6554700010009465",
              "harness": "papercusp",
              "title": "[alarm:carry-delivery:main-server-Precision-7865-Tower:orphan:%5B%22su-1322a26f-8cde-41a7-8d59-f5b15099619e%22%2C%222026-10-12T22%3A33%3A54.",
              "state": "open"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "known",
            "value": "On a new inbox/source wake, re-read both item resumes. Before any scheduler pull, re-read the current fleet claim spec and pull only if a slot is free and admitted. Re-read the target owner log/presence only on a new source delivery or rear",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "recordedAt": "2026-10-25T23:20:04.145Z",
            "truncated": true,
            "evidenceRef": "work_items:get"
          },
          "left": {
            "status": "known",
            "value": "Keep this incident open. Preserve the leader-slot disposition in check leader-slot-reply: retain both claims and the inbox wake, with no release or pull until the leader changes the disposition or capacity changes.",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "recordedAt": "2026-10-25T23:20:04.145Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 0,
              "unresolvedDependencies": 0,
              "dependencies": [],
              "truncatedByLimit": false
            },
            "source": "work_items + work_item_deps canonical unresolved-blocker reader",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "known",
            "value": true,
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "The assigned current step has registered AUTO authority and no measured work dependency or recorded hold. This is evidence, not a new grant of authority."
          }
        }
      }
    ]
  },
  {
    "n": 11,
    "id": "su-48e0ce16-442a-4961-8643-320a92d0c0fd",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 1,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "listener",
          "event": "coord:inbox-wake:su-48e0ce16-442a-4961-8643-320a92d0c0fd"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": true,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": [
      {
        "id": "work:su-48e0ce16-442a-4961-8643-320a92d0c0fd:papercusp:EI-25774579383606093",
        "kind": "work",
        "ownerId": "su-48e0ce16-442a-4961-8643-320a92d0c0fd",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "EI-25774579383606093",
              "harness": "papercusp",
              "title": "R11 W5 backfill error-rate acceptance appears to regress despite passing cohort progress",
              "state": "open"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "known",
            "value": "Send the fleet leader the exact-window result and request any independent sidecar archive. Continue only from retained W5 evidence; do not infer a denominator from the sweep-start count alone.",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "recordedAt": "2026-10-25T23:31:40.826Z"
          },
          "left": {
            "status": "known",
            "value": "Ask the fleet leader once whether an independent sidecar [T0,T1) archive exists. If none, keep the denominator/rate unknown and the acceptance regression unconfirmed; the root cause remains unknown. Do not rerun W5 or change thresholds.",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "recordedAt": "2026-10-25T23:31:40.826Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 0,
              "unresolvedDependencies": 0,
              "dependencies": [],
              "truncatedByLimit": false
            },
            "source": "work_items + work_item_deps canonical unresolved-blocker reader",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "known",
            "value": true,
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "The assigned current step has registered AUTO authority and no measured work dependency or recorded hold. This is evidence, not a new grant of authority."
          }
        }
      }
    ]
  },
  {
    "n": 12,
    "id": "su-4a84c93a-e530-450c-b01e-8beb7bdc670f",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 3,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "substantive",
          "event": "conversation:answered:conv-mvjy4dsp-0000-a44413cc2aeb4f568e412f6d1f81d163"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": true,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": [
      {
        "id": "work:su-4a84c93a-e530-450c-b01e-8beb7bdc670f:papercusp:EI-26990056807889807",
        "kind": "work",
        "ownerId": "su-4a84c93a-e530-450c-b01e-8beb7bdc670f",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "EI-26990056807889807",
              "harness": "papercusp",
              "title": "Loop status marks an actively executing Codex continuation turnsStalled with stale native turn observation",
              "state": "open"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "known",
            "value": "At authorized follow-up, recover the original durable evidence/actual continuation identity and inspect writer+classifier before reproduction. Do not infer stopped process from carried numeric exec handle, and do not close from current cont",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "recordedAt": "2026-10-25T22:45:50.991Z",
            "truncated": true,
            "evidenceRef": "work_items:get"
          },
          "left": {
            "status": "known",
            "value": "Incidental suspected loop-status false-stall classification remains unverified, not fixed. This is separate from P001 and not a reason to broaden the identity mission.",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "recordedAt": "2026-10-25T22:45:50.991Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 0,
              "unresolvedDependencies": 0,
              "dependencies": [],
              "truncatedByLimit": false
            },
            "source": "work_items + work_item_deps canonical unresolved-blocker reader",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "known",
            "value": true,
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "The assigned current step has registered AUTO authority and no measured work dependency or recorded hold. This is evidence, not a new grant of authority."
          }
        }
      },
      {
        "id": "work:su-4a84c93a-e530-450c-b01e-8beb7bdc670f:papercusp:WI-6554700010017386",
        "kind": "work",
        "ownerId": "su-4a84c93a-e530-450c-b01e-8beb7bdc670f",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "WI-6554700010017386",
              "harness": "papercusp",
              "title": "Baseline by observation. Freeze every role's, built-in identity's and worn stack's effective tool set in Avi's workspace, including each too",
              "state": "open"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No structured value recorded.",
            "recordedAt": "2026-10-25T22:50:08.268Z"
          },
          "left": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No structured value recorded.",
            "recordedAt": "2026-10-25T22:50:08.268Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 0,
              "unresolvedDependencies": 0,
              "dependencies": [],
              "truncatedByLimit": false
            },
            "source": "work_items + work_item_deps canonical unresolved-blocker reader",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "known",
            "value": false,
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "The current plan lane, dependency or owner decision blocks this step."
          }
        }
      },
      {
        "id": "work:su-4a84c93a-e530-450c-b01e-8beb7bdc670f:papercusp:WI-6554700010020777",
        "kind": "work",
        "ownerId": "su-4a84c93a-e530-450c-b01e-8beb7bdc670f",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "WI-6554700010020777",
              "harness": "papercusp",
              "title": "Drive identity permissions plan through owner-directed AUTO implementation and shipment",
              "state": "open"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No structured value recorded.",
            "recordedAt": "2026-10-25T22:50:08.530Z"
          },
          "left": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No structured value recorded.",
            "recordedAt": "2026-10-25T22:50:08.530Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 0,
              "unresolvedDependencies": 0,
              "dependencies": [],
              "truncatedByLimit": false
            },
            "source": "work_items + work_item_deps canonical unresolved-blocker reader",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "unknown",
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No current, subject-matching next step is available."
          }
        }
      }
    ]
  },
  {
    "n": 13,
    "id": "su-4bdf29dd-7a52-4bac-94be-47eaa097981a",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 0,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "listener",
          "event": "coord:inbox-wake:su-4bdf29dd-7a52-4bac-94be-47eaa097981a"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": false,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": []
  },
  {
    "n": 14,
    "id": "su-51f4af3d-894e-4e73-9f33-8e96b7aea369",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 0,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "listener",
          "event": "coord:inbox-wake:su-51f4af3d-894e-4e73-9f33-8e96b7aea369"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": false,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": []
  },
  {
    "n": 15,
    "id": "su-526d5bda-59ea-4d1d-a4f4-9358741c1a6a",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 0,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "listener",
          "event": "coord:inbox-wake:su-526d5bda-59ea-4d1d-a4f4-9358741c1a6a"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": false,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": []
  },
  {
    "n": 16,
    "id": "su-52eb8d6e-7e32-485e-8a46-c6a1ee7ea8b0",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 0,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "listener",
          "event": "coord:inbox-wake:su-52eb8d6e-7e32-485e-8a46-c6a1ee7ea8b0"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": false,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": []
  },
  {
    "n": 17,
    "id": "su-552486f9-f640-40fd-bf13-f16b62051fed",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 0,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "substantive",
          "event": "conversation:answered:conv-mvh9n5sq-0000-94c3201477e64ae4b5afa2baf5b43678"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": false,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": []
  },
  {
    "n": 18,
    "id": "su-58f6ce8c-a42b-4feb-ac5c-79a11355ec0f",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 0,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "listener",
          "event": "coord:inbox-wake:su-58f6ce8c-a42b-4feb-ac5c-79a11355ec0f"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": false,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": false,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": []
  },
  {
    "n": 19,
    "id": "su-5d78087d-4beb-4895-bfb4-691aa1c506ea",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 2,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "listener",
          "event": "coord:inbox-wake:su-5d78087d-4beb-4895-bfb4-691aa1c506ea"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": true,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": [
      {
        "id": "work:su-5d78087d-4beb-4895-bfb4-691aa1c506ea:papercusp:EI-25642418457381511",
        "kind": "work",
        "ownerId": "su-5d78087d-4beb-4895-bfb4-691aa1c506ea",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "EI-25642418457381511",
              "harness": "papercusp",
              "title": "result-door scratch spill write ETIMEDOUT (>30000ms) on scorecards:emit via tools:invoke",
              "state": "open"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "known",
            "value": "On the next wake, refresh inbox, assignments, claim spec, and await 367466. Resume investigation only if exact correlated scorecards:emit evidence arrives.",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "recordedAt": "2026-10-25T23:18:46.800Z"
          },
          "left": {
            "status": "known",
            "value": "Still open and assigned. No exact correlated scorecards:emit evidence arrived in the current inbox, and no incident-source polling was done.",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "recordedAt": "2026-10-25T23:18:46.800Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 0,
              "unresolvedDependencies": 0,
              "dependencies": [],
              "truncatedByLimit": false
            },
            "source": "work_items + work_item_deps canonical unresolved-blocker reader",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "known",
            "value": true,
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "The assigned current step has registered AUTO authority and no measured work dependency or recorded hold. This is evidence, not a new grant of authority."
          }
        }
      },
      {
        "id": "work:su-5d78087d-4beb-4895-bfb4-691aa1c506ea:papercusp:EI-25812519922184353",
        "kind": "work",
        "ownerId": "su-5d78087d-4beb-4895-bfb4-691aa1c506ea",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "EI-25812519922184353",
              "harness": "papercusp",
              "title": "coord:orient tool-call failure (502)",
              "state": "open"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "known",
            "value": "On the next wake, check leader disposition and refresh assignments, claim spec, and await 367466. Recover the executed capability:bash output handle if available, then inspect only the filtered proxy failure record around 2026-10-12T21:58:5",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "recordedAt": "2026-10-25T23:19:23.458Z",
            "truncated": true,
            "evidenceRef": "work_items:get"
          },
          "left": {
            "status": "known",
            "value": "Still open; no code changed. The original 2026-10-12 failure is one upstream reset report; a current successful orient does not identify its cause. A code:run attempt to retrieve the proxy ledger failed to surface the nested capability:bash",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "recordedAt": "2026-10-25T23:19:23.458Z",
            "truncated": true,
            "evidenceRef": "work_items:get"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 0,
              "unresolvedDependencies": 0,
              "dependencies": [],
              "truncatedByLimit": false
            },
            "source": "work_items + work_item_deps canonical unresolved-blocker reader",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "known",
            "value": true,
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "The assigned current step has registered AUTO authority and no measured work dependency or recorded hold. This is evidence, not a new grant of authority."
          }
        }
      }
    ]
  },
  {
    "n": 20,
    "id": "su-60a60fc5-defd-4121-b86e-981f1a004785",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 3,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "substantive",
          "event": "conversation:answered:conv-mv6zdq7p-0000-a28e3f7c38dc4a13a7812587e6ee833d"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "unknown",
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z",
        "reason": "No independently executable step was established; inspect each work record for the missing evidence or hold."
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": [
      {
        "id": "work:su-60a60fc5-defd-4121-b86e-981f1a004785:papercusp:EI-25381403971663190",
        "kind": "work",
        "ownerId": "su-60a60fc5-defd-4121-b86e-981f1a004785",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "EI-25381403971663190",
              "harness": "papercusp",
              "title": "Historical native-session verifier rejection on loop MCP calls",
              "state": "open"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No structured value recorded.",
            "recordedAt": "2026-10-26T05:57:31.486Z"
          },
          "left": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No structured value recorded.",
            "recordedAt": "2026-10-26T05:57:31.486Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 0,
              "unresolvedDependencies": 0,
              "dependencies": [],
              "truncatedByLimit": false
            },
            "source": "work_items + work_item_deps canonical unresolved-blocker reader",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "unknown",
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No current, subject-matching next step is available."
          }
        }
      },
      {
        "id": "work:su-60a60fc5-defd-4121-b86e-981f1a004785:papercusp:EI-25544613413335431",
        "kind": "work",
        "ownerId": "su-60a60fc5-defd-4121-b86e-981f1a004785",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "EI-25544613413335431",
              "harness": "papercusp",
              "title": "Stable lifecycle report rejects maintained wake_delivery_id while staging accepts it",
              "state": "blocked"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No structured value recorded.",
            "recordedAt": "2026-10-26T06:14:56.587Z"
          },
          "left": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No structured value recorded.",
            "recordedAt": "2026-10-26T06:14:56.587Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 1,
              "detailRecords": true
            },
            "source": "work_items.payload.externalBlockers (recorded holds, not live clearance)",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "known",
            "value": false,
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "A recorded owner, external or state hold remains in force."
          }
        }
      },
      {
        "id": "work:su-60a60fc5-defd-4121-b86e-981f1a004785:papercusp:EI-25544613413335431:blocker:0",
        "kind": "work",
        "ownerId": "su-60a60fc5-defd-4121-b86e-981f1a004785",
        "fields": {
          "blocker": {
            "status": "known",
            "value": {
              "workItem": "EI-25544613413335431",
              "kind": "event",
              "ref": "conversation:answered:conv-mv6zdq7p-0000-a28e3f7c38dc4a13a7812587e6ee833d",
              "summary": "Gated pending the custodian's explicit answer in the existing conversation or explicit fleet-leader re-scope.",
              "capability": "live-dependency"
            },
            "source": "work_items.payload.externalBlockers (recorded hold)",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "recordedAt": "2026-10-26T01:32:51.421Z"
          },
          "clearance": {
            "status": "unknown",
            "source": "live blocker producer",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No unambiguous supported producer state was available; the recorded hold remains in force."
          }
        }
      },
      {
        "id": "work:su-60a60fc5-defd-4121-b86e-981f1a004785:papercusp:EI-25557250881939855",
        "kind": "work",
        "ownerId": "su-60a60fc5-defd-4121-b86e-981f1a004785",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "EI-25557250881939855",
              "harness": "papercusp",
              "title": "Benchmark cost-read failures become zero telemetry and missing usage can enter efficiency claims",
              "state": "blocked"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No structured value recorded.",
            "recordedAt": "2026-10-26T05:57:29.779Z"
          },
          "left": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No structured value recorded.",
            "recordedAt": "2026-10-26T05:57:29.779Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 1,
              "detailRecords": true
            },
            "source": "work_items.payload.externalBlockers (recorded holds, not live clearance)",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "known",
            "value": false,
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "A recorded owner, external or state hold remains in force."
          }
        }
      },
      {
        "id": "work:su-60a60fc5-defd-4121-b86e-981f1a004785:papercusp:EI-25557250881939855:blocker:0",
        "kind": "work",
        "ownerId": "su-60a60fc5-defd-4121-b86e-981f1a004785",
        "fields": {
          "blocker": {
            "status": "known",
            "value": {
              "workItem": "EI-25557250881939855",
              "kind": "event",
              "ref": "conversation:answered:conv-mv6zdq7p-0000-a28e3f7c38dc4a13a7812587e6ee833d",
              "summary": "Gated pending the existing custodian conversation answer; also requires fresh occurrence-linked verifier evidence or explicit fleet-leader re-scope.",
              "capability": "live-dependency"
            },
            "source": "work_items.payload.externalBlockers (recorded hold)",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "recordedAt": "2026-10-26T01:32:57.866Z"
          },
          "clearance": {
            "status": "unknown",
            "source": "live blocker producer",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No unambiguous supported producer state was available; the recorded hold remains in force."
          }
        }
      }
    ]
  },
  {
    "n": 21,
    "id": "su-611f037a-a3b8-460d-8e65-ea9801692de4",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 0,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "listener",
          "event": "coord:inbox-wake:su-611f037a-a3b8-460d-8e65-ea9801692de4"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": false,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": []
  },
  {
    "n": 22,
    "id": "su-637d70bf-567e-4ee9-ab87-88d69ca99dc9",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 0,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "listener",
          "event": "coord:inbox-wake:su-637d70bf-567e-4ee9-ab87-88d69ca99dc9"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": false,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": []
  },
  {
    "n": 23,
    "id": "su-65ecc301-e683-4b7f-85ee-98c2871ef59f",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 0,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "listener",
          "event": "coord:inbox-wake:su-65ecc301-e683-4b7f-85ee-98c2871ef59f"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": false,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": []
  },
  {
    "n": 24,
    "id": "su-8051f4a9-643a-4c17-bf5d-2aa01a7ce5ec",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 0,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "listener",
          "event": "coord:inbox-wake:su-8051f4a9-643a-4c17-bf5d-2aa01a7ce5ec"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": false,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": []
  },
  {
    "n": 25,
    "id": "su-805773aa-0100-4fc7-a169-b0bd245ad475",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 1,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "substantive",
          "event": "conversation:answered:conv-mvo92b3m-0000-d2512caa2e224d5f9b417306c6ace7fc"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "unknown",
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z",
        "reason": "No independently executable step was established; inspect each work record for the missing evidence or hold."
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": [
      {
        "id": "work:su-805773aa-0100-4fc7-a169-b0bd245ad475:papercusp:EI-25525687915049025",
        "kind": "work",
        "ownerId": "su-805773aa-0100-4fc7-a169-b0bd245ad475",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "EI-25525687915049025",
              "harness": "papercusp",
              "title": "tools:find tool-call failure (ENOSPC)",
              "state": "open"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No structured value recorded.",
            "recordedAt": "2026-10-26T04:44:12.796Z"
          },
          "left": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No structured value recorded.",
            "recordedAt": "2026-10-26T04:44:12.796Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 0,
              "unresolvedDependencies": 0,
              "dependencies": [],
              "truncatedByLimit": false
            },
            "source": "work_items + work_item_deps canonical unresolved-blocker reader",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "unknown",
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No current, subject-matching next step is available."
          }
        }
      }
    ]
  },
  {
    "n": 26,
    "id": "su-8257d540-04d1-44b3-9de8-f411398b6908",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 0,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "listener",
          "event": "coord:inbox-wake:su-8257d540-04d1-44b3-9de8-f411398b6908"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": false,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": []
  },
  {
    "n": 27,
    "id": "su-843e294a-e363-4b17-b899-52a3c0f75fb6",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 0,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "listener",
          "event": "coord:inbox-wake:su-843e294a-e363-4b17-b899-52a3c0f75fb6"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": false,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": []
  },
  {
    "n": 28,
    "id": "su-85787563-ee76-479d-924c-6b2985481003",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 1,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "listener",
          "event": "coord:inbox-wake:su-85787563-ee76-479d-924c-6b2985481003"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": false,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": [
      {
        "id": "work:su-85787563-ee76-479d-924c-6b2985481003:papercusp:WI-6554700010009554",
        "kind": "work",
        "ownerId": "su-85787563-ee76-479d-924c-6b2985481003",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "WI-6554700010009554",
              "harness": "papercusp",
              "title": "Exact PUI299829 Codex explicit native approval probe receives no target card",
              "state": "blocked"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No structured value recorded.",
            "recordedAt": "2026-10-25T23:30:16.365Z"
          },
          "left": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No structured value recorded.",
            "recordedAt": "2026-10-25T23:30:16.365Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 1,
              "detailRecords": true
            },
            "source": "work_items.payload.externalBlockers (recorded holds, not live clearance)",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "known",
            "value": false,
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "A recorded owner, external or state hold remains in force."
          }
        }
      },
      {
        "id": "work:su-85787563-ee76-479d-924c-6b2985481003:papercusp:WI-6554700010009554:blocker:0",
        "kind": "work",
        "ownerId": "su-85787563-ee76-479d-924c-6b2985481003",
        "fields": {
          "blocker": {
            "status": "known",
            "value": {
              "workItem": "WI-6554700010009554",
              "kind": "runtime",
              "ref": "/tmp/pui-acceptance-7534f/run-299829-native-approval-20261013-0130/vitest-codex.log",
              "summary": "Need the target Codex approval card and matching effect receipt for task 0mv601nqk1kloe5hk6y before root cause can be established.",
              "capability": "live-dependency"
            },
            "source": "work_items.payload.externalBlockers (recorded hold)",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "recordedAt": "2026-10-25T23:26:42.904Z"
          },
          "clearance": {
            "status": "unknown",
            "source": "live blocker producer",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No unambiguous supported producer state was available; the recorded hold remains in force."
          }
        }
      }
    ]
  },
  {
    "n": 29,
    "id": "su-89069bd7-404c-4496-998b-5d7604433a46",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 2,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "substantive",
          "event": "goal:plan-placement:unresolved-owner-scope:su-89069bd7-404c-4496-998b-5d7604433a46"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": true,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": [
      {
        "id": "work:su-89069bd7-404c-4496-998b-5d7604433a46:papercusp:EI-25784012089390150",
        "kind": "work",
        "ownerId": "su-89069bd7-404c-4496-998b-5d7604433a46",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "EI-25784012089390150",
              "harness": "papercusp",
              "title": "Quota-blocked psu member remains parked/wakeable/reachable while required wake never starts a turn",
              "state": "open"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "Checkpoint subject or authored span is stale, missing or unverified.",
            "recordedAt": "2026-10-25T23:20:24.321Z"
          },
          "left": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "Checkpoint subject or authored span is stale, missing or unverified.",
            "recordedAt": "2026-10-25T23:20:24.321Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 0,
              "unresolvedDependencies": 0,
              "dependencies": [],
              "truncatedByLimit": false
            },
            "source": "work_items + work_item_deps canonical unresolved-blocker reader",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "unknown",
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No current, subject-matching next step is available."
          }
        }
      },
      {
        "id": "work:su-89069bd7-404c-4496-998b-5d7604433a46:papercusp:EI-25797287475145885",
        "kind": "work",
        "ownerId": "su-89069bd7-404c-4496-998b-5d7604433a46",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "EI-25797287475145885",
              "harness": "papercusp",
              "title": "coord:ask advertises agent routing but refuses agent callers",
              "state": "open"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "known",
            "value": "On the existing conversation:answered await or timeout, re-read this exact conversation and event status. Verify leader pickup from a post-send presence change or reply. Resume no source work without a maintained review receipt or supersedi",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "recordedAt": "2026-10-25T23:22:24.330Z",
            "truncated": true,
            "evidenceRef": "work_items:get"
          },
          "left": {
            "status": "known",
            "value": "Keep source restrictions and both admission holds intact. A queued review request or wake is routing progress only, not a qualifying receipt or clearance.",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "recordedAt": "2026-10-25T23:22:24.330Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 0,
              "unresolvedDependencies": 0,
              "dependencies": [],
              "truncatedByLimit": false
            },
            "source": "work_items + work_item_deps canonical unresolved-blocker reader",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "known",
            "value": true,
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "The assigned current step has registered AUTO authority and no measured work dependency or recorded hold. This is evidence, not a new grant of authority."
          }
        }
      }
    ]
  },
  {
    "n": 30,
    "id": "su-9597cf3f-9a5f-415e-acd0-ab9807365c75",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 0,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "substantive",
          "event": "plan:acceptance:managed-agent-capability-contract-and-native-cutover-2026-09-13"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": false,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": []
  },
  {
    "n": 31,
    "id": "su-9ab8c7bf-12d5-412a-aefd-0ec60b3aa6bd",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 2,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "substantive",
          "event": "conversation:answered:conv-mvn11x6x-0000-406aa032d77f4c39beb90482d97b1a24"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "unknown",
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z",
        "reason": "No independently executable step was established; inspect each work record for the missing evidence or hold."
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": [
      {
        "id": "work:su-9ab8c7bf-12d5-412a-aefd-0ec60b3aa6bd:papercusp:EI-26980019744053063",
        "kind": "work",
        "ownerId": "su-9ab8c7bf-12d5-412a-aefd-0ec60b3aa6bd",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "EI-26980019744053063",
              "harness": "papercusp",
              "title": "Current METHOD review is routed with transcript-only consultation instructions",
              "state": "open"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "Checkpoint subject or authored span is stale, missing or unverified.",
            "recordedAt": "2026-10-25T23:35:32.827Z"
          },
          "left": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "Checkpoint subject or authored span is stale, missing or unverified.",
            "recordedAt": "2026-10-25T23:35:32.827Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 0,
              "unresolvedDependencies": 0,
              "dependencies": [],
              "truncatedByLimit": false
            },
            "source": "work_items + work_item_deps canonical unresolved-blocker reader",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "unknown",
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No current, subject-matching next step is available."
          }
        }
      },
      {
        "id": "work:su-9ab8c7bf-12d5-412a-aefd-0ec60b3aa6bd:papercusp:WI-6554700010012117",
        "kind": "work",
        "ownerId": "su-9ab8c7bf-12d5-412a-aefd-0ec60b3aa6bd",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "WI-6554700010012117",
              "harness": "papercusp",
              "title": "Carry native-code-intelligence-ecosystem-and-dream-2026-10-09 to shipped: add + execute use-measurement/good-use item, P-027 prep, ship path",
              "state": "open"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "Checkpoint subject or authored span is stale, missing or unverified.",
            "recordedAt": "2026-10-25T23:35:32.827Z"
          },
          "left": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "Checkpoint subject or authored span is stale, missing or unverified.",
            "recordedAt": "2026-10-25T23:35:32.827Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 0,
              "unresolvedDependencies": 0,
              "dependencies": [],
              "truncatedByLimit": false
            },
            "source": "work_items + work_item_deps canonical unresolved-blocker reader",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "unknown",
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No current, subject-matching next step is available."
          }
        }
      }
    ]
  },
  {
    "n": 32,
    "id": "su-9d78ddac-35c1-4787-9cd5-5215340c049a",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 0,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "listener",
          "event": "coord:inbox-wake:su-9d78ddac-35c1-4787-9cd5-5215340c049a"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": false,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": []
  },
  {
    "n": 33,
    "id": "su-9e008133-9540-4ece-82e1-a085ca6d29d4",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 0,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "listener",
          "event": "coord:inbox-wake:su-9e008133-9540-4ece-82e1-a085ca6d29d4"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": false,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": false,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": []
  },
  {
    "n": 34,
    "id": "su-9e6d609b-e392-41da-9c62-95c1b7cf4e08",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 1,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "substantive",
          "event": "conversation:answered:conv-mvo9etxn-0000-9b075064dae3404ea07b0ecab4629ca3"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": true,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": [
      {
        "id": "work:su-9e6d609b-e392-41da-9c62-95c1b7cf4e08:papercusp:EI-25640953135074525",
        "kind": "work",
        "ownerId": "su-9e6d609b-e392-41da-9c62-95c1b7cf4e08",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "EI-25640953135074525",
              "harness": "papercusp",
              "title": "improvements:capture dedup ran degraded — lexical and semantic dedup both 'unavailable' at 2026-10-11T00:31Z",
              "state": "open"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "known",
            "value": "On the conversation:answered wake, reorient and read the owner's answer; apply the chosen disposition. Until then, preserve the item open and do not probe or edit.",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "recordedAt": "2026-10-25T20:07:55.969Z"
          },
          "left": {
            "status": "known",
            "value": "The D-312 release is not verified. The original root cause remains unknown and no qualifying natural slow/late exact trace is present.",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "recordedAt": "2026-10-25T20:07:55.969Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 0,
              "unresolvedDependencies": 0,
              "dependencies": [],
              "truncatedByLimit": false
            },
            "source": "work_items + work_item_deps canonical unresolved-blocker reader",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "known",
            "value": true,
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "The assigned current step has registered AUTO authority and no measured work dependency or recorded hold. This is evidence, not a new grant of authority."
          }
        }
      }
    ]
  },
  {
    "n": 35,
    "id": "su-a26dee79-79c4-4258-8094-641d2b805b5d",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 2,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "listener",
          "event": "coord:inbox-wake:su-a26dee79-79c4-4258-8094-641d2b805b5d"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "unknown",
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z",
        "reason": "No independently executable step was established; inspect each work record for the missing evidence or hold."
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": [
      {
        "id": "work:su-a26dee79-79c4-4258-8094-641d2b805b5d:papercusp:EI-25744454665452865",
        "kind": "work",
        "ownerId": "su-a26dee79-79c4-4258-8094-641d2b805b5d",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "EI-25744454665452865",
              "harness": "papercusp",
              "title": "capability:read raw:true+offset/limit on a result-door .spill reference returns an empty body with no error",
              "state": "open"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No structured value recorded.",
            "recordedAt": "2026-10-25T22:29:42.987Z"
          },
          "left": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No structured value recorded.",
            "recordedAt": "2026-10-25T22:29:42.987Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 0,
              "unresolvedDependencies": 0,
              "dependencies": [],
              "truncatedByLimit": false
            },
            "source": "work_items + work_item_deps canonical unresolved-blocker reader",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "unknown",
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No current, subject-matching next step is available."
          }
        }
      },
      {
        "id": "work:su-a26dee79-79c4-4258-8094-641d2b805b5d:papercusp:EI-25879870290163805",
        "kind": "work",
        "ownerId": "su-a26dee79-79c4-4258-8094-641d2b805b5d",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "EI-25879870290163805",
              "harness": "papercusp",
              "title": "Frozen R13 receipt instrument rejects retained native terminal receipt envelope variants",
              "state": "open"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "unknown",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No structured value recorded.",
            "recordedAt": "2026-10-25T23:27:46.026Z"
          },
          "left": {
            "status": "known",
            "value": "Inspect the canonical saved instrument and exact six retained result fragments. Preserve Cold26 unchanged; if the exact formats can be handled safely, create a versioned successor with narrow positive/negative validation and run it only aga",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "recordedAt": "2026-10-25T23:27:46.026Z",
            "truncated": true,
            "evidenceRef": "work_items:get"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 0,
              "unresolvedDependencies": 0,
              "dependencies": [],
              "truncatedByLimit": false
            },
            "source": "work_items + work_item_deps canonical unresolved-blocker reader",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "unknown",
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "No current, subject-matching next step is available."
          }
        }
      }
    ]
  },
  {
    "n": 36,
    "id": "su-a9eb0831-f923-419a-a433-63f720e02b6a",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 0,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "listener",
          "event": "coord:inbox-wake:su-a9eb0831-f923-419a-a433-63f720e02b6a"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": false,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": []
  },
  {
    "n": 37,
    "id": "su-bbfd627f-1859-4ffe-aa04-8c96b24955ea",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 0,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "substantive",
          "event": "plan:acceptance:r2-to-gcs-storage-migration-2026-10-23"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": false,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": []
  },
  {
    "n": 38,
    "id": "su-c270ea81-86f8-4e24-aa03-6fcf12ab8bde",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 0,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "listener",
          "event": "coord:inbox-wake:su-c270ea81-86f8-4e24-aa03-6fcf12ab8bde"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": false,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": []
  },
  {
    "n": 39,
    "id": "su-d74d0101-2ce9-4082-8c02-5702a05e6ba3",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 0,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "substantive",
          "event": "work-item:claimable"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": false,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": []
  },
  {
    "n": 40,
    "id": "su-dc2412ed-9732-4888-812e-8adc9e8039c9",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 0,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "listener",
          "event": "coord:inbox-wake:su-dc2412ed-9732-4888-812e-8adc9e8039c9"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": false,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": []
  },
  {
    "n": 41,
    "id": "su-respawn-29abf2c1d168f7a9d537bc4e0f568429",
    "agent": {
      "session": {
        "status": "known",
        "value": "parked",
        "source": "presence liveness oracle",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "ownedWorkCount": {
        "status": "known",
        "value": 1,
        "source": "work_items.taken_by",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wait": {
        "status": "known",
        "value": {
          "kind": "listener",
          "event": "coord:inbox-wake:su-respawn-29abf2c1d168f7a9d537bc4e0f568429"
        },
        "source": "presence.awaitingEventKey",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "registeredAuto": {
        "status": "known",
        "value": true,
        "source": "agent_modes registry",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeMode": {
        "status": "known",
        "value": "auto",
        "source": "presence wake configuration (not registered authority)",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "independentWork": {
        "status": "known",
        "value": true,
        "source": "owned work executable assessments",
        "observedAt": "2026-10-26T06:33:31.776Z"
      },
      "wakeWindow": {
        "status": "known",
        "value": "last 7 days, exact linked requests only",
        "source": "coord messages and event deliveries",
        "observedAt": "2026-10-26T06:33:31.776Z"
      }
    },
    "work": [
      {
        "id": "work:su-respawn-29abf2c1d168f7a9d537bc4e0f568429:papercusp:WI-6554700010028902",
        "kind": "work",
        "ownerId": "su-respawn-29abf2c1d168f7a9d537bc4e0f568429",
        "fields": {
          "identity": {
            "status": "known",
            "value": {
              "id": "WI-6554700010028902",
              "harness": "papercusp",
              "title": "Code-intelligence shipment lane: dream-native-start-terminal-settlement-2026-10-23",
              "state": "open"
            },
            "source": "work_items",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "next": {
            "status": "known",
            "value": "Read original author session and current settlement seam; run current maintained focused handshake tests, then canonical activation-readiness repair.",
            "source": "carry_notes.latestUpdate.next",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "recordedAt": "2026-10-25T19:49:25.984Z"
          },
          "left": {
            "status": "known",
            "value": "Recover original author/source conversation for canonical activation audit; requalify focused proof because production source changed; original exact-native host adoption, independent grading and deployed shipment remain unverified.",
            "source": "carry_notes.latestUpdate.left",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "recordedAt": "2026-10-25T19:49:25.984Z"
          },
          "blockers": {
            "status": "known",
            "value": {
              "activeRecordedHolds": 0,
              "unresolvedDependencies": 0,
              "dependencies": [],
              "truncatedByLimit": false
            },
            "source": "work_items + work_item_deps canonical unresolved-blocker reader",
            "observedAt": "2026-10-26T06:33:31.776Z"
          },
          "executable": {
            "status": "known",
            "value": true,
            "source": "work_items + carry_notes.latestUpdate.next + agent_modes + work_item_deps + plan item lane/decisions",
            "observedAt": "2026-10-26T06:33:31.776Z",
            "reason": "The assigned current step has registered AUTO authority and no measured work dependency or recorded hold. This is evidence, not a new grant of authority."
          }
        }
      }
    ]
  }
]
