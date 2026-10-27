---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/coord-message-source-20261026/source-witness.json"
updated_at: 1792984660016
_body: "content"
---

{
  "schemaVersion": 1,
  "population": [
    "coord_message/lexical"
  ],
  "completed": [
    "coord_message/lexical"
  ],
  "pins": [
    {
      "path": "packages/operator-core/lib/agent-tools/search/coord-message-source-freshness.integration.test.ts",
      "sha256": "7c59123c3f960be139ecc449e470bf35adb96c562df1a19e1a1312775b4704d9"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/search/sources.ts",
      "sha256": "c65d7b85eb7b5394ac3049a328ae5225972180b072470d210265511baed2738b"
    },
    {
      "path": "packages/operator-core/lib/search/surface-registry.ts",
      "sha256": "53e3bd3fd49a1d3d2413d6486983715882f857d841117b7727f30a83dbf30e23"
    }
  ],
  "receipts": [
    {
      "caseId": "coord_message/lexical",
      "phase": "stored-fields-and-host-global-policy",
      "before": {
        "raw": {
          "id": 1,
          "workspace_id": "p001-coord-workspace",
          "surface": "messages",
          "msg_id": "target",
          "body": {
            "body": "original canonical body",
            "from": "author-A",
            "kind": "notify",
            "summary": "zephyrcoordwitness original summary"
          },
          "ts": "2026-01-15T12:00:00.000Z",
          "harness_slug": "p001-coord-harness",
          "revision": "6417"
        },
        "corpus": [
          {
            "workspace_id": "p001-coord-workspace-other",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "foreign-workspace",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6418"
          },
          {
            "workspace_id": "default",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "host-global",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6421"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness-other",
            "surface": "messages",
            "msg_id": "other-harness",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6419"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "intents",
            "msg_id": "other-surface",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6420"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "target",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6417"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": null,
            "surface": "messages",
            "msg_id": "unscoped",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6422"
          }
        ],
        "readAtMs": 1792984526704,
        "epoch": "978ac607663b21ddb4c4d247874fe37585d30ac6954d775d7926ec437a61e5ba"
      },
      "after": {
        "raw": {
          "id": 1,
          "workspace_id": "p001-coord-workspace",
          "surface": "messages",
          "msg_id": "target",
          "body": {
            "body": "original canonical body",
            "from": "author-A",
            "kind": "notify",
            "summary": "zephyrcoordwitness original summary"
          },
          "ts": "2026-01-15T12:00:00.000Z",
          "harness_slug": "p001-coord-harness",
          "revision": "6417"
        },
        "corpus": [
          {
            "workspace_id": "p001-coord-workspace-other",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "foreign-workspace",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6418"
          },
          {
            "workspace_id": "default",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "host-global",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6421"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness-other",
            "surface": "messages",
            "msg_id": "other-harness",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6419"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "intents",
            "msg_id": "other-surface",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6420"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "target",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6417"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": null,
            "surface": "messages",
            "msg_id": "unscoped",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6422"
          }
        ],
        "readAtMs": 1792984526711,
        "epoch": "978ac607663b21ddb4c4d247874fe37585d30ac6954d775d7926ec437a61e5ba"
      },
      "rows": [
        {
          "key": "coord_message:target",
          "score": 0.1,
          "row": {
            "source": "coord_message",
            "source_id": "target",
            "scope": "p001-coord-harness",
            "excerpt": "[notify from author-A Thu Jan 15 2026 07:00:00 GMT-0500 (Eastern Standard Time)] zephyrcoordwitness original summary original canonical body",
            "highlight": "<mark>zephyrcoordwitness</mark> original summary original canonical body",
            "score": 0.1,
            "rankers": [
              "lexical"
            ]
          }
        },
        {
          "key": "coord_message:host-global",
          "score": 0.1,
          "row": {
            "source": "coord_message",
            "source_id": "host-global",
            "scope": "p001-coord-harness",
            "excerpt": "[notify from author-A Thu Jan 15 2026 07:00:00 GMT-0500 (Eastern Standard Time)] zephyrcoordwitness original summary original canonical body",
            "highlight": "<mark>zephyrcoordwitness</mark> original summary original canonical body",
            "score": 0.1,
            "rankers": [
              "lexical"
            ]
          }
        }
      ],
      "expectedIds": [
        "target",
        "host-global"
      ],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "coord_message:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "0248e21269b1aa831c649cd6cc264819744aa006b89625bd9574625e6b0e4ad0"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "coord_message:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "0248e21269b1aa831c649cd6cc264819744aa006b89625bd9574625e6b0e4ad0",
              "authority": "harness_shared.coord_event_log",
              "authorityEpoch": "978ac607663b21ddb4c4d247874fe37585d30ac6954d775d7926ec437a61e5ba",
              "sourceRevision": "6417",
              "readAtMs": 1792984526711
            },
            "requestStartedAtMs": 1792984526701,
            "responseAtMs": 1792984526710
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "coord_message:target",
              "fieldPath": "highlight",
              "valueFingerprint": "df5b02be39ebe4d77461a722d1256be5453cbed108d21514068d95f7222911a6"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "coord_message:target",
              "fieldPath": "highlight",
              "valueFingerprint": "df5b02be39ebe4d77461a722d1256be5453cbed108d21514068d95f7222911a6",
              "authority": "harness_shared.coord_event_log",
              "authorityEpoch": "978ac607663b21ddb4c4d247874fe37585d30ac6954d775d7926ec437a61e5ba",
              "sourceRevision": "6417",
              "readAtMs": 1792984526711
            },
            "requestStartedAtMs": 1792984526701,
            "responseAtMs": 1792984526710
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        }
      ]
    },
    {
      "caseId": "coord_message/lexical",
      "phase": "body-changed-event-time-unchanged",
      "before": {
        "raw": {
          "id": 1,
          "workspace_id": "p001-coord-workspace",
          "surface": "messages",
          "msg_id": "target",
          "body": {
            "body": "replacement canonical body",
            "from": "author-A",
            "kind": "notify",
            "summary": "zephyrcoordwitness replacement summary"
          },
          "ts": "2026-01-15T12:00:00.000Z",
          "harness_slug": "p001-coord-harness",
          "revision": "6423"
        },
        "corpus": [
          {
            "workspace_id": "p001-coord-workspace-other",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "foreign-workspace",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6418"
          },
          {
            "workspace_id": "default",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "host-global",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6421"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness-other",
            "surface": "messages",
            "msg_id": "other-harness",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6419"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "intents",
            "msg_id": "other-surface",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6420"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "target",
            "body": {
              "body": "replacement canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness replacement summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6423"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": null,
            "surface": "messages",
            "msg_id": "unscoped",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6422"
          }
        ],
        "readAtMs": 1792984526716,
        "epoch": "978ac607663b21ddb4c4d247874fe37585d30ac6954d775d7926ec437a61e5ba"
      },
      "after": {
        "raw": {
          "id": 1,
          "workspace_id": "p001-coord-workspace",
          "surface": "messages",
          "msg_id": "target",
          "body": {
            "body": "replacement canonical body",
            "from": "author-A",
            "kind": "notify",
            "summary": "zephyrcoordwitness replacement summary"
          },
          "ts": "2026-01-15T12:00:00.000Z",
          "harness_slug": "p001-coord-harness",
          "revision": "6423"
        },
        "corpus": [
          {
            "workspace_id": "p001-coord-workspace-other",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "foreign-workspace",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6418"
          },
          {
            "workspace_id": "default",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "host-global",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6421"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness-other",
            "surface": "messages",
            "msg_id": "other-harness",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6419"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "intents",
            "msg_id": "other-surface",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6420"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "target",
            "body": {
              "body": "replacement canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness replacement summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6423"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": null,
            "surface": "messages",
            "msg_id": "unscoped",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6422"
          }
        ],
        "readAtMs": 1792984526719,
        "epoch": "978ac607663b21ddb4c4d247874fe37585d30ac6954d775d7926ec437a61e5ba"
      },
      "rows": [
        {
          "key": "coord_message:host-global",
          "score": 0.1,
          "row": {
            "source": "coord_message",
            "source_id": "host-global",
            "scope": "p001-coord-harness",
            "excerpt": "[notify from author-A Thu Jan 15 2026 07:00:00 GMT-0500 (Eastern Standard Time)] zephyrcoordwitness original summary original canonical body",
            "highlight": "<mark>zephyrcoordwitness</mark> original summary original canonical body",
            "score": 0.1,
            "rankers": [
              "lexical"
            ]
          }
        },
        {
          "key": "coord_message:target",
          "score": 0.1,
          "row": {
            "source": "coord_message",
            "source_id": "target",
            "scope": "p001-coord-harness",
            "excerpt": "[notify from author-A Thu Jan 15 2026 07:00:00 GMT-0500 (Eastern Standard Time)] zephyrcoordwitness replacement summary replacement canonical body",
            "highlight": "<mark>zephyrcoordwitness</mark> replacement summary replacement canonical body",
            "score": 0.1,
            "rankers": [
              "lexical"
            ]
          }
        }
      ],
      "expectedIds": [
        "target",
        "host-global"
      ],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "coord_message:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "1c96c3938b07caaa5f4ca43a723d81f40a39c974b90bbbd9fe4415d29d9f66b2"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "coord_message:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "1c96c3938b07caaa5f4ca43a723d81f40a39c974b90bbbd9fe4415d29d9f66b2",
              "authority": "harness_shared.coord_event_log",
              "authorityEpoch": "978ac607663b21ddb4c4d247874fe37585d30ac6954d775d7926ec437a61e5ba",
              "sourceRevision": "6423",
              "readAtMs": 1792984526719
            },
            "requestStartedAtMs": 1792984526715,
            "responseAtMs": 1792984526718
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "coord_message:target",
              "fieldPath": "highlight",
              "valueFingerprint": "76f2fa218dc196571aee61ce1ba5c3620ff978c7343a7e512cde00f0904e56a9"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "coord_message:target",
              "fieldPath": "highlight",
              "valueFingerprint": "76f2fa218dc196571aee61ce1ba5c3620ff978c7343a7e512cde00f0904e56a9",
              "authority": "harness_shared.coord_event_log",
              "authorityEpoch": "978ac607663b21ddb4c4d247874fe37585d30ac6954d775d7926ec437a61e5ba",
              "sourceRevision": "6423",
              "readAtMs": 1792984526719
            },
            "requestStartedAtMs": 1792984526715,
            "responseAtMs": 1792984526718
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        }
      ]
    },
    {
      "caseId": "coord_message/lexical",
      "phase": "old-field-fresh-envelope-refused",
      "field": "excerpt",
      "input": {
        "returned": {
          "entityRef": "coord_message:target",
          "fieldPath": "excerpt",
          "valueFingerprint": "0248e21269b1aa831c649cd6cc264819744aa006b89625bd9574625e6b0e4ad0"
        },
        "indexed": null,
        "canonical": {
          "entityRef": "coord_message:target",
          "fieldPath": "excerpt",
          "valueFingerprint": "1c96c3938b07caaa5f4ca43a723d81f40a39c974b90bbbd9fe4415d29d9f66b2",
          "authority": "harness_shared.coord_event_log",
          "authorityEpoch": "978ac607663b21ddb4c4d247874fe37585d30ac6954d775d7926ec437a61e5ba",
          "sourceRevision": "6423",
          "readAtMs": 1792984526719
        },
        "requestStartedAtMs": 1792984526715,
        "responseAtMs": 1792984526718
      },
      "oracle": {
        "status": "stale",
        "action": "degrade",
        "reasons": [
          "canonical: returned value differs",
          "index witness unavailable"
        ]
      }
    },
    {
      "caseId": "coord_message/lexical",
      "phase": "old-field-fresh-envelope-refused",
      "field": "highlight",
      "input": {
        "returned": {
          "entityRef": "coord_message:target",
          "fieldPath": "highlight",
          "valueFingerprint": "df5b02be39ebe4d77461a722d1256be5453cbed108d21514068d95f7222911a6"
        },
        "indexed": null,
        "canonical": {
          "entityRef": "coord_message:target",
          "fieldPath": "highlight",
          "valueFingerprint": "76f2fa218dc196571aee61ce1ba5c3620ff978c7343a7e512cde00f0904e56a9",
          "authority": "harness_shared.coord_event_log",
          "authorityEpoch": "978ac607663b21ddb4c4d247874fe37585d30ac6954d775d7926ec437a61e5ba",
          "sourceRevision": "6423",
          "readAtMs": 1792984526719
        },
        "requestStartedAtMs": 1792984526715,
        "responseAtMs": 1792984526718
      },
      "oracle": {
        "status": "stale",
        "action": "degrade",
        "reasons": [
          "canonical: returned value differs",
          "index witness unavailable"
        ]
      }
    },
    {
      "caseId": "coord_message/lexical",
      "phase": "candidate-added",
      "before": {
        "raw": {
          "id": 1,
          "workspace_id": "p001-coord-workspace",
          "surface": "messages",
          "msg_id": "target",
          "body": {
            "body": "replacement canonical body",
            "from": "author-A",
            "kind": "notify",
            "summary": "zephyrcoordwitness replacement summary"
          },
          "ts": "2026-01-15T12:00:00.000Z",
          "harness_slug": "p001-coord-harness",
          "revision": "6423"
        },
        "corpus": [
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "added",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6424"
          },
          {
            "workspace_id": "p001-coord-workspace-other",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "foreign-workspace",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6418"
          },
          {
            "workspace_id": "default",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "host-global",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6421"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness-other",
            "surface": "messages",
            "msg_id": "other-harness",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6419"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "intents",
            "msg_id": "other-surface",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6420"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "target",
            "body": {
              "body": "replacement canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness replacement summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6423"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": null,
            "surface": "messages",
            "msg_id": "unscoped",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6422"
          }
        ],
        "readAtMs": 1792984526722,
        "epoch": "978ac607663b21ddb4c4d247874fe37585d30ac6954d775d7926ec437a61e5ba"
      },
      "after": {
        "raw": {
          "id": 1,
          "workspace_id": "p001-coord-workspace",
          "surface": "messages",
          "msg_id": "target",
          "body": {
            "body": "replacement canonical body",
            "from": "author-A",
            "kind": "notify",
            "summary": "zephyrcoordwitness replacement summary"
          },
          "ts": "2026-01-15T12:00:00.000Z",
          "harness_slug": "p001-coord-harness",
          "revision": "6423"
        },
        "corpus": [
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "added",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6424"
          },
          {
            "workspace_id": "p001-coord-workspace-other",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "foreign-workspace",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6418"
          },
          {
            "workspace_id": "default",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "host-global",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6421"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness-other",
            "surface": "messages",
            "msg_id": "other-harness",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6419"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "intents",
            "msg_id": "other-surface",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6420"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "target",
            "body": {
              "body": "replacement canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness replacement summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6423"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": null,
            "surface": "messages",
            "msg_id": "unscoped",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6422"
          }
        ],
        "readAtMs": 1792984526724,
        "epoch": "978ac607663b21ddb4c4d247874fe37585d30ac6954d775d7926ec437a61e5ba"
      },
      "rows": [
        {
          "key": "coord_message:host-global",
          "score": 0.1,
          "row": {
            "source": "coord_message",
            "source_id": "host-global",
            "scope": "p001-coord-harness",
            "excerpt": "[notify from author-A Thu Jan 15 2026 07:00:00 GMT-0500 (Eastern Standard Time)] zephyrcoordwitness original summary original canonical body",
            "highlight": "<mark>zephyrcoordwitness</mark> original summary original canonical body",
            "score": 0.1,
            "rankers": [
              "lexical"
            ]
          }
        },
        {
          "key": "coord_message:target",
          "score": 0.1,
          "row": {
            "source": "coord_message",
            "source_id": "target",
            "scope": "p001-coord-harness",
            "excerpt": "[notify from author-A Thu Jan 15 2026 07:00:00 GMT-0500 (Eastern Standard Time)] zephyrcoordwitness replacement summary replacement canonical body",
            "highlight": "<mark>zephyrcoordwitness</mark> replacement summary replacement canonical body",
            "score": 0.1,
            "rankers": [
              "lexical"
            ]
          }
        },
        {
          "key": "coord_message:added",
          "score": 0.1,
          "row": {
            "source": "coord_message",
            "source_id": "added",
            "scope": "p001-coord-harness",
            "excerpt": "[notify from author-A Thu Jan 15 2026 07:00:00 GMT-0500 (Eastern Standard Time)] zephyrcoordwitness original summary original canonical body",
            "highlight": "<mark>zephyrcoordwitness</mark> original summary original canonical body",
            "score": 0.1,
            "rankers": [
              "lexical"
            ]
          }
        }
      ],
      "expectedIds": [
        "target",
        "host-global",
        "added"
      ],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "coord_message:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "1c96c3938b07caaa5f4ca43a723d81f40a39c974b90bbbd9fe4415d29d9f66b2"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "coord_message:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "1c96c3938b07caaa5f4ca43a723d81f40a39c974b90bbbd9fe4415d29d9f66b2",
              "authority": "harness_shared.coord_event_log",
              "authorityEpoch": "978ac607663b21ddb4c4d247874fe37585d30ac6954d775d7926ec437a61e5ba",
              "sourceRevision": "6423",
              "readAtMs": 1792984526724
            },
            "requestStartedAtMs": 1792984526721,
            "responseAtMs": 1792984526724
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "coord_message:target",
              "fieldPath": "highlight",
              "valueFingerprint": "76f2fa218dc196571aee61ce1ba5c3620ff978c7343a7e512cde00f0904e56a9"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "coord_message:target",
              "fieldPath": "highlight",
              "valueFingerprint": "76f2fa218dc196571aee61ce1ba5c3620ff978c7343a7e512cde00f0904e56a9",
              "authority": "harness_shared.coord_event_log",
              "authorityEpoch": "978ac607663b21ddb4c4d247874fe37585d30ac6954d775d7926ec437a61e5ba",
              "sourceRevision": "6423",
              "readAtMs": 1792984526724
            },
            "requestStartedAtMs": 1792984526721,
            "responseAtMs": 1792984526724
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        }
      ]
    },
    {
      "caseId": "coord_message/lexical",
      "phase": "candidate-deleted",
      "before": {
        "raw": {
          "id": 1,
          "workspace_id": "p001-coord-workspace",
          "surface": "messages",
          "msg_id": "target",
          "body": {
            "body": "replacement canonical body",
            "from": "author-A",
            "kind": "notify",
            "summary": "zephyrcoordwitness replacement summary"
          },
          "ts": "2026-01-15T12:00:00.000Z",
          "harness_slug": "p001-coord-harness",
          "revision": "6423"
        },
        "corpus": [
          {
            "workspace_id": "p001-coord-workspace-other",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "foreign-workspace",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6418"
          },
          {
            "workspace_id": "default",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "host-global",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6421"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness-other",
            "surface": "messages",
            "msg_id": "other-harness",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6419"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "intents",
            "msg_id": "other-surface",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6420"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "target",
            "body": {
              "body": "replacement canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness replacement summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6423"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": null,
            "surface": "messages",
            "msg_id": "unscoped",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6422"
          }
        ],
        "readAtMs": 1792984526726,
        "epoch": "978ac607663b21ddb4c4d247874fe37585d30ac6954d775d7926ec437a61e5ba"
      },
      "after": {
        "raw": {
          "id": 1,
          "workspace_id": "p001-coord-workspace",
          "surface": "messages",
          "msg_id": "target",
          "body": {
            "body": "replacement canonical body",
            "from": "author-A",
            "kind": "notify",
            "summary": "zephyrcoordwitness replacement summary"
          },
          "ts": "2026-01-15T12:00:00.000Z",
          "harness_slug": "p001-coord-harness",
          "revision": "6423"
        },
        "corpus": [
          {
            "workspace_id": "p001-coord-workspace-other",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "foreign-workspace",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6418"
          },
          {
            "workspace_id": "default",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "host-global",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6421"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness-other",
            "surface": "messages",
            "msg_id": "other-harness",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6419"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "intents",
            "msg_id": "other-surface",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6420"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "target",
            "body": {
              "body": "replacement canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness replacement summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6423"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": null,
            "surface": "messages",
            "msg_id": "unscoped",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6422"
          }
        ],
        "readAtMs": 1792984526729,
        "epoch": "978ac607663b21ddb4c4d247874fe37585d30ac6954d775d7926ec437a61e5ba"
      },
      "rows": [
        {
          "key": "coord_message:host-global",
          "score": 0.1,
          "row": {
            "source": "coord_message",
            "source_id": "host-global",
            "scope": "p001-coord-harness",
            "excerpt": "[notify from author-A Thu Jan 15 2026 07:00:00 GMT-0500 (Eastern Standard Time)] zephyrcoordwitness original summary original canonical body",
            "highlight": "<mark>zephyrcoordwitness</mark> original summary original canonical body",
            "score": 0.1,
            "rankers": [
              "lexical"
            ]
          }
        },
        {
          "key": "coord_message:target",
          "score": 0.1,
          "row": {
            "source": "coord_message",
            "source_id": "target",
            "scope": "p001-coord-harness",
            "excerpt": "[notify from author-A Thu Jan 15 2026 07:00:00 GMT-0500 (Eastern Standard Time)] zephyrcoordwitness replacement summary replacement canonical body",
            "highlight": "<mark>zephyrcoordwitness</mark> replacement summary replacement canonical body",
            "score": 0.1,
            "rankers": [
              "lexical"
            ]
          }
        }
      ],
      "expectedIds": [
        "target",
        "host-global"
      ],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "coord_message:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "1c96c3938b07caaa5f4ca43a723d81f40a39c974b90bbbd9fe4415d29d9f66b2"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "coord_message:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "1c96c3938b07caaa5f4ca43a723d81f40a39c974b90bbbd9fe4415d29d9f66b2",
              "authority": "harness_shared.coord_event_log",
              "authorityEpoch": "978ac607663b21ddb4c4d247874fe37585d30ac6954d775d7926ec437a61e5ba",
              "sourceRevision": "6423",
              "readAtMs": 1792984526729
            },
            "requestStartedAtMs": 1792984526725,
            "responseAtMs": 1792984526728
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "coord_message:target",
              "fieldPath": "highlight",
              "valueFingerprint": "76f2fa218dc196571aee61ce1ba5c3620ff978c7343a7e512cde00f0904e56a9"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "coord_message:target",
              "fieldPath": "highlight",
              "valueFingerprint": "76f2fa218dc196571aee61ce1ba5c3620ff978c7343a7e512cde00f0904e56a9",
              "authority": "harness_shared.coord_event_log",
              "authorityEpoch": "978ac607663b21ddb4c4d247874fe37585d30ac6954d775d7926ec437a61e5ba",
              "sourceRevision": "6423",
              "readAtMs": 1792984526729
            },
            "requestStartedAtMs": 1792984526725,
            "responseAtMs": 1792984526728
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        }
      ]
    },
    {
      "caseId": "coord_message/lexical",
      "phase": "scope-filter-absent",
      "before": {
        "raw": {
          "id": 1,
          "workspace_id": "p001-coord-workspace",
          "surface": "messages",
          "msg_id": "target",
          "body": {
            "body": "replacement canonical body",
            "from": "author-A",
            "kind": "notify",
            "summary": "zephyrcoordwitness replacement summary"
          },
          "ts": "2026-01-15T12:00:00.000Z",
          "harness_slug": "p001-coord-harness",
          "revision": "6423"
        },
        "corpus": [
          {
            "workspace_id": "p001-coord-workspace-other",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "foreign-workspace",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6418"
          },
          {
            "workspace_id": "default",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "host-global",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6421"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness-other",
            "surface": "messages",
            "msg_id": "other-harness",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6419"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "intents",
            "msg_id": "other-surface",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6420"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "target",
            "body": {
              "body": "replacement canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness replacement summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6423"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": null,
            "surface": "messages",
            "msg_id": "unscoped",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6422"
          }
        ],
        "readAtMs": 1792984526731,
        "epoch": "aa7300e1e8e8cd5243179d1a48b50365a20685778207bca545c7af55dc1e7343"
      },
      "after": {
        "raw": {
          "id": 1,
          "workspace_id": "p001-coord-workspace",
          "surface": "messages",
          "msg_id": "target",
          "body": {
            "body": "replacement canonical body",
            "from": "author-A",
            "kind": "notify",
            "summary": "zephyrcoordwitness replacement summary"
          },
          "ts": "2026-01-15T12:00:00.000Z",
          "harness_slug": "p001-coord-harness",
          "revision": "6423"
        },
        "corpus": [
          {
            "workspace_id": "p001-coord-workspace-other",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "foreign-workspace",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6418"
          },
          {
            "workspace_id": "default",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "host-global",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6421"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness-other",
            "surface": "messages",
            "msg_id": "other-harness",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6419"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "intents",
            "msg_id": "other-surface",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6420"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "target",
            "body": {
              "body": "replacement canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness replacement summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6423"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": null,
            "surface": "messages",
            "msg_id": "unscoped",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6422"
          }
        ],
        "readAtMs": 1792984526734,
        "epoch": "aa7300e1e8e8cd5243179d1a48b50365a20685778207bca545c7af55dc1e7343"
      },
      "rows": [
        {
          "key": "coord_message:other-harness",
          "score": 0.1,
          "row": {
            "source": "coord_message",
            "source_id": "other-harness",
            "scope": "p001-coord-harness-other",
            "excerpt": "[notify from author-A Thu Jan 15 2026 07:00:00 GMT-0500 (Eastern Standard Time)] zephyrcoordwitness original summary original canonical body",
            "highlight": "<mark>zephyrcoordwitness</mark> original summary original canonical body",
            "score": 0.1,
            "rankers": [
              "lexical"
            ]
          }
        },
        {
          "key": "coord_message:host-global",
          "score": 0.1,
          "row": {
            "source": "coord_message",
            "source_id": "host-global",
            "scope": "p001-coord-harness",
            "excerpt": "[notify from author-A Thu Jan 15 2026 07:00:00 GMT-0500 (Eastern Standard Time)] zephyrcoordwitness original summary original canonical body",
            "highlight": "<mark>zephyrcoordwitness</mark> original summary original canonical body",
            "score": 0.1,
            "rankers": [
              "lexical"
            ]
          }
        },
        {
          "key": "coord_message:unscoped",
          "score": 0.1,
          "row": {
            "source": "coord_message",
            "source_id": "unscoped",
            "excerpt": "[notify from author-A Thu Jan 15 2026 07:00:00 GMT-0500 (Eastern Standard Time)] zephyrcoordwitness original summary original canonical body",
            "highlight": "<mark>zephyrcoordwitness</mark> original summary original canonical body",
            "score": 0.1,
            "rankers": [
              "lexical"
            ]
          }
        },
        {
          "key": "coord_message:target",
          "score": 0.1,
          "row": {
            "source": "coord_message",
            "source_id": "target",
            "scope": "p001-coord-harness",
            "excerpt": "[notify from author-A Thu Jan 15 2026 07:00:00 GMT-0500 (Eastern Standard Time)] zephyrcoordwitness replacement summary replacement canonical body",
            "highlight": "<mark>zephyrcoordwitness</mark> replacement summary replacement canonical body",
            "score": 0.1,
            "rankers": [
              "lexical"
            ]
          }
        }
      ],
      "expectedIds": [
        "target",
        "host-global",
        "other-harness",
        "unscoped"
      ],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "coord_message:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "1c96c3938b07caaa5f4ca43a723d81f40a39c974b90bbbd9fe4415d29d9f66b2"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "coord_message:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "1c96c3938b07caaa5f4ca43a723d81f40a39c974b90bbbd9fe4415d29d9f66b2",
              "authority": "harness_shared.coord_event_log",
              "authorityEpoch": "aa7300e1e8e8cd5243179d1a48b50365a20685778207bca545c7af55dc1e7343",
              "sourceRevision": "6423",
              "readAtMs": 1792984526734
            },
            "requestStartedAtMs": 1792984526730,
            "responseAtMs": 1792984526733
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "coord_message:target",
              "fieldPath": "highlight",
              "valueFingerprint": "76f2fa218dc196571aee61ce1ba5c3620ff978c7343a7e512cde00f0904e56a9"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "coord_message:target",
              "fieldPath": "highlight",
              "valueFingerprint": "76f2fa218dc196571aee61ce1ba5c3620ff978c7343a7e512cde00f0904e56a9",
              "authority": "harness_shared.coord_event_log",
              "authorityEpoch": "aa7300e1e8e8cd5243179d1a48b50365a20685778207bca545c7af55dc1e7343",
              "sourceRevision": "6423",
              "readAtMs": 1792984526734
            },
            "requestStartedAtMs": 1792984526730,
            "responseAtMs": 1792984526733
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        }
      ]
    },
    {
      "caseId": "coord_message/lexical",
      "phase": "different-harness",
      "before": {
        "raw": {
          "id": 1,
          "workspace_id": "p001-coord-workspace",
          "surface": "messages",
          "msg_id": "target",
          "body": {
            "body": "replacement canonical body",
            "from": "author-A",
            "kind": "notify",
            "summary": "zephyrcoordwitness replacement summary"
          },
          "ts": "2026-01-15T12:00:00.000Z",
          "harness_slug": "p001-coord-harness",
          "revision": "6423"
        },
        "corpus": [
          {
            "workspace_id": "p001-coord-workspace-other",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "foreign-workspace",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6418"
          },
          {
            "workspace_id": "default",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "host-global",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6421"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness-other",
            "surface": "messages",
            "msg_id": "other-harness",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6419"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "intents",
            "msg_id": "other-surface",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6420"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "target",
            "body": {
              "body": "replacement canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness replacement summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6423"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": null,
            "surface": "messages",
            "msg_id": "unscoped",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6422"
          }
        ],
        "readAtMs": 1792984526736,
        "epoch": "58f8de555b6f18470b9bf2885c27260654aea1463b5842b47b0756e62979bb35"
      },
      "after": {
        "raw": {
          "id": 1,
          "workspace_id": "p001-coord-workspace",
          "surface": "messages",
          "msg_id": "target",
          "body": {
            "body": "replacement canonical body",
            "from": "author-A",
            "kind": "notify",
            "summary": "zephyrcoordwitness replacement summary"
          },
          "ts": "2026-01-15T12:00:00.000Z",
          "harness_slug": "p001-coord-harness",
          "revision": "6423"
        },
        "corpus": [
          {
            "workspace_id": "p001-coord-workspace-other",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "foreign-workspace",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6418"
          },
          {
            "workspace_id": "default",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "host-global",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6421"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness-other",
            "surface": "messages",
            "msg_id": "other-harness",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6419"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "intents",
            "msg_id": "other-surface",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6420"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "target",
            "body": {
              "body": "replacement canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness replacement summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6423"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": null,
            "surface": "messages",
            "msg_id": "unscoped",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6422"
          }
        ],
        "readAtMs": 1792984526739,
        "epoch": "58f8de555b6f18470b9bf2885c27260654aea1463b5842b47b0756e62979bb35"
      },
      "rows": [
        {
          "key": "coord_message:other-harness",
          "score": 0.1,
          "row": {
            "source": "coord_message",
            "source_id": "other-harness",
            "scope": "p001-coord-harness-other",
            "excerpt": "[notify from author-A Thu Jan 15 2026 07:00:00 GMT-0500 (Eastern Standard Time)] zephyrcoordwitness original summary original canonical body",
            "highlight": "<mark>zephyrcoordwitness</mark> original summary original canonical body",
            "score": 0.1,
            "rankers": [
              "lexical"
            ]
          }
        }
      ],
      "expectedIds": [
        "other-harness"
      ],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "coord_message:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "coord_message:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "1c96c3938b07caaa5f4ca43a723d81f40a39c974b90bbbd9fe4415d29d9f66b2",
              "authority": "harness_shared.coord_event_log",
              "authorityEpoch": "58f8de555b6f18470b9bf2885c27260654aea1463b5842b47b0756e62979bb35",
              "sourceRevision": "6423",
              "readAtMs": 1792984526739
            },
            "requestStartedAtMs": 1792984526735,
            "responseAtMs": 1792984526738
          },
          "oracle": null
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "coord_message:target",
              "fieldPath": "highlight",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "coord_message:target",
              "fieldPath": "highlight",
              "valueFingerprint": "76f2fa218dc196571aee61ce1ba5c3620ff978c7343a7e512cde00f0904e56a9",
              "authority": "harness_shared.coord_event_log",
              "authorityEpoch": "58f8de555b6f18470b9bf2885c27260654aea1463b5842b47b0756e62979bb35",
              "sourceRevision": "6423",
              "readAtMs": 1792984526739
            },
            "requestStartedAtMs": 1792984526735,
            "responseAtMs": 1792984526738
          },
          "oracle": null
        }
      ]
    },
    {
      "caseId": "coord_message/lexical",
      "phase": "owner-A-visible",
      "before": {
        "raw": {
          "id": 1,
          "workspace_id": "p001-coord-workspace",
          "surface": "messages",
          "msg_id": "target",
          "body": {
            "body": "replacement canonical body",
            "from": "author-A",
            "kind": "notify",
            "summary": "zephyrcoordwitness replacement summary"
          },
          "ts": "2026-01-15T12:00:00.000Z",
          "harness_slug": "p001-coord-harness",
          "revision": "6423"
        },
        "corpus": [
          {
            "workspace_id": "p001-coord-workspace-other",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "foreign-workspace",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6418"
          },
          {
            "workspace_id": "default",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "host-global",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6421"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness-other",
            "surface": "messages",
            "msg_id": "other-harness",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6419"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "intents",
            "msg_id": "other-surface",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6420"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "target",
            "body": {
              "body": "replacement canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness replacement summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6423"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": null,
            "surface": "messages",
            "msg_id": "unscoped",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6422"
          }
        ],
        "readAtMs": 1792984526740,
        "epoch": "8966716e144d21a1ba9f2a80132c63bc62271bcaf56bff5c5fb7d24784e262a2"
      },
      "after": {
        "raw": {
          "id": 1,
          "workspace_id": "p001-coord-workspace",
          "surface": "messages",
          "msg_id": "target",
          "body": {
            "body": "replacement canonical body",
            "from": "author-A",
            "kind": "notify",
            "summary": "zephyrcoordwitness replacement summary"
          },
          "ts": "2026-01-15T12:00:00.000Z",
          "harness_slug": "p001-coord-harness",
          "revision": "6423"
        },
        "corpus": [
          {
            "workspace_id": "p001-coord-workspace-other",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "foreign-workspace",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6418"
          },
          {
            "workspace_id": "default",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "host-global",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6421"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness-other",
            "surface": "messages",
            "msg_id": "other-harness",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6419"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "intents",
            "msg_id": "other-surface",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6420"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "target",
            "body": {
              "body": "replacement canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness replacement summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6423"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": null,
            "surface": "messages",
            "msg_id": "unscoped",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6422"
          }
        ],
        "readAtMs": 1792984526743,
        "epoch": "8966716e144d21a1ba9f2a80132c63bc62271bcaf56bff5c5fb7d24784e262a2"
      },
      "rows": [
        {
          "key": "coord_message:host-global",
          "score": 0.1,
          "row": {
            "source": "coord_message",
            "source_id": "host-global",
            "scope": "p001-coord-harness",
            "excerpt": "[notify from author-A Thu Jan 15 2026 07:00:00 GMT-0500 (Eastern Standard Time)] zephyrcoordwitness original summary original canonical body",
            "highlight": "<mark>zephyrcoordwitness</mark> original summary original canonical body",
            "score": 0.1,
            "rankers": [
              "lexical"
            ]
          }
        },
        {
          "key": "coord_message:target",
          "score": 0.1,
          "row": {
            "source": "coord_message",
            "source_id": "target",
            "scope": "p001-coord-harness",
            "excerpt": "[notify from author-A Thu Jan 15 2026 07:00:00 GMT-0500 (Eastern Standard Time)] zephyrcoordwitness replacement summary replacement canonical body",
            "highlight": "<mark>zephyrcoordwitness</mark> replacement summary replacement canonical body",
            "score": 0.1,
            "rankers": [
              "lexical"
            ]
          }
        }
      ],
      "expectedIds": [
        "target",
        "host-global"
      ],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "coord_message:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "1c96c3938b07caaa5f4ca43a723d81f40a39c974b90bbbd9fe4415d29d9f66b2"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "coord_message:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "1c96c3938b07caaa5f4ca43a723d81f40a39c974b90bbbd9fe4415d29d9f66b2",
              "authority": "harness_shared.coord_event_log",
              "authorityEpoch": "8966716e144d21a1ba9f2a80132c63bc62271bcaf56bff5c5fb7d24784e262a2",
              "sourceRevision": "6423",
              "readAtMs": 1792984526743
            },
            "requestStartedAtMs": 1792984526739,
            "responseAtMs": 1792984526742
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "coord_message:target",
              "fieldPath": "highlight",
              "valueFingerprint": "76f2fa218dc196571aee61ce1ba5c3620ff978c7343a7e512cde00f0904e56a9"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "coord_message:target",
              "fieldPath": "highlight",
              "valueFingerprint": "76f2fa218dc196571aee61ce1ba5c3620ff978c7343a7e512cde00f0904e56a9",
              "authority": "harness_shared.coord_event_log",
              "authorityEpoch": "8966716e144d21a1ba9f2a80132c63bc62271bcaf56bff5c5fb7d24784e262a2",
              "sourceRevision": "6423",
              "readAtMs": 1792984526743
            },
            "requestStartedAtMs": 1792984526739,
            "responseAtMs": 1792984526742
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        }
      ]
    },
    {
      "caseId": "coord_message/lexical",
      "phase": "owner-A-after-change",
      "before": {
        "raw": {
          "id": 1,
          "workspace_id": "p001-coord-workspace",
          "surface": "messages",
          "msg_id": "target",
          "body": {
            "body": "replacement canonical body",
            "from": "author-B",
            "kind": "notify",
            "summary": "zephyrcoordwitness replacement summary"
          },
          "ts": "2026-01-15T12:00:00.000Z",
          "harness_slug": "p001-coord-harness",
          "revision": "6426"
        },
        "corpus": [
          {
            "workspace_id": "p001-coord-workspace-other",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "foreign-workspace",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6418"
          },
          {
            "workspace_id": "default",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "host-global",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6421"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness-other",
            "surface": "messages",
            "msg_id": "other-harness",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6419"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "intents",
            "msg_id": "other-surface",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6420"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "target",
            "body": {
              "body": "replacement canonical body",
              "from": "author-B",
              "kind": "notify",
              "summary": "zephyrcoordwitness replacement summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6426"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": null,
            "surface": "messages",
            "msg_id": "unscoped",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6422"
          }
        ],
        "readAtMs": 1792984526745,
        "epoch": "8966716e144d21a1ba9f2a80132c63bc62271bcaf56bff5c5fb7d24784e262a2"
      },
      "after": {
        "raw": {
          "id": 1,
          "workspace_id": "p001-coord-workspace",
          "surface": "messages",
          "msg_id": "target",
          "body": {
            "body": "replacement canonical body",
            "from": "author-B",
            "kind": "notify",
            "summary": "zephyrcoordwitness replacement summary"
          },
          "ts": "2026-01-15T12:00:00.000Z",
          "harness_slug": "p001-coord-harness",
          "revision": "6426"
        },
        "corpus": [
          {
            "workspace_id": "p001-coord-workspace-other",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "foreign-workspace",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6418"
          },
          {
            "workspace_id": "default",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "host-global",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6421"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness-other",
            "surface": "messages",
            "msg_id": "other-harness",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6419"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "intents",
            "msg_id": "other-surface",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6420"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "target",
            "body": {
              "body": "replacement canonical body",
              "from": "author-B",
              "kind": "notify",
              "summary": "zephyrcoordwitness replacement summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6426"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": null,
            "surface": "messages",
            "msg_id": "unscoped",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6422"
          }
        ],
        "readAtMs": 1792984526748,
        "epoch": "8966716e144d21a1ba9f2a80132c63bc62271bcaf56bff5c5fb7d24784e262a2"
      },
      "rows": [
        {
          "key": "coord_message:host-global",
          "score": 0.1,
          "row": {
            "source": "coord_message",
            "source_id": "host-global",
            "scope": "p001-coord-harness",
            "excerpt": "[notify from author-A Thu Jan 15 2026 07:00:00 GMT-0500 (Eastern Standard Time)] zephyrcoordwitness original summary original canonical body",
            "highlight": "<mark>zephyrcoordwitness</mark> original summary original canonical body",
            "score": 0.1,
            "rankers": [
              "lexical"
            ]
          }
        }
      ],
      "expectedIds": [
        "host-global"
      ],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "coord_message:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "coord_message:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "cbcabf23620c45200caff51d1d0bde81ceddcd1b2e6d3a21ebf6aa20f8c65783",
              "authority": "harness_shared.coord_event_log",
              "authorityEpoch": "8966716e144d21a1ba9f2a80132c63bc62271bcaf56bff5c5fb7d24784e262a2",
              "sourceRevision": "6426",
              "readAtMs": 1792984526748
            },
            "requestStartedAtMs": 1792984526744,
            "responseAtMs": 1792984526747
          },
          "oracle": null
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "coord_message:target",
              "fieldPath": "highlight",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "coord_message:target",
              "fieldPath": "highlight",
              "valueFingerprint": "76f2fa218dc196571aee61ce1ba5c3620ff978c7343a7e512cde00f0904e56a9",
              "authority": "harness_shared.coord_event_log",
              "authorityEpoch": "8966716e144d21a1ba9f2a80132c63bc62271bcaf56bff5c5fb7d24784e262a2",
              "sourceRevision": "6426",
              "readAtMs": 1792984526748
            },
            "requestStartedAtMs": 1792984526744,
            "responseAtMs": 1792984526747
          },
          "oracle": null
        }
      ]
    },
    {
      "caseId": "coord_message/lexical",
      "phase": "owner-B-after-change",
      "before": {
        "raw": {
          "id": 1,
          "workspace_id": "p001-coord-workspace",
          "surface": "messages",
          "msg_id": "target",
          "body": {
            "body": "replacement canonical body",
            "from": "author-B",
            "kind": "notify",
            "summary": "zephyrcoordwitness replacement summary"
          },
          "ts": "2026-01-15T12:00:00.000Z",
          "harness_slug": "p001-coord-harness",
          "revision": "6426"
        },
        "corpus": [
          {
            "workspace_id": "p001-coord-workspace-other",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "foreign-workspace",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6418"
          },
          {
            "workspace_id": "default",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "host-global",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6421"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness-other",
            "surface": "messages",
            "msg_id": "other-harness",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6419"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "intents",
            "msg_id": "other-surface",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6420"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "target",
            "body": {
              "body": "replacement canonical body",
              "from": "author-B",
              "kind": "notify",
              "summary": "zephyrcoordwitness replacement summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6426"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": null,
            "surface": "messages",
            "msg_id": "unscoped",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6422"
          }
        ],
        "readAtMs": 1792984526749,
        "epoch": "707f0280f4bd8b04ecbf90555563bbb8df3ad745fae787b8c21f7c3b6fea8da0"
      },
      "after": {
        "raw": {
          "id": 1,
          "workspace_id": "p001-coord-workspace",
          "surface": "messages",
          "msg_id": "target",
          "body": {
            "body": "replacement canonical body",
            "from": "author-B",
            "kind": "notify",
            "summary": "zephyrcoordwitness replacement summary"
          },
          "ts": "2026-01-15T12:00:00.000Z",
          "harness_slug": "p001-coord-harness",
          "revision": "6426"
        },
        "corpus": [
          {
            "workspace_id": "p001-coord-workspace-other",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "foreign-workspace",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6418"
          },
          {
            "workspace_id": "default",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "host-global",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6421"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness-other",
            "surface": "messages",
            "msg_id": "other-harness",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6419"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "intents",
            "msg_id": "other-surface",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6420"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "target",
            "body": {
              "body": "replacement canonical body",
              "from": "author-B",
              "kind": "notify",
              "summary": "zephyrcoordwitness replacement summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6426"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": null,
            "surface": "messages",
            "msg_id": "unscoped",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6422"
          }
        ],
        "readAtMs": 1792984526752,
        "epoch": "707f0280f4bd8b04ecbf90555563bbb8df3ad745fae787b8c21f7c3b6fea8da0"
      },
      "rows": [
        {
          "key": "coord_message:target",
          "score": 0.1,
          "row": {
            "source": "coord_message",
            "source_id": "target",
            "scope": "p001-coord-harness",
            "excerpt": "[notify from author-B Thu Jan 15 2026 07:00:00 GMT-0500 (Eastern Standard Time)] zephyrcoordwitness replacement summary replacement canonical body",
            "highlight": "<mark>zephyrcoordwitness</mark> replacement summary replacement canonical body",
            "score": 0.1,
            "rankers": [
              "lexical"
            ]
          }
        }
      ],
      "expectedIds": [
        "target"
      ],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "coord_message:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "cbcabf23620c45200caff51d1d0bde81ceddcd1b2e6d3a21ebf6aa20f8c65783"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "coord_message:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "cbcabf23620c45200caff51d1d0bde81ceddcd1b2e6d3a21ebf6aa20f8c65783",
              "authority": "harness_shared.coord_event_log",
              "authorityEpoch": "707f0280f4bd8b04ecbf90555563bbb8df3ad745fae787b8c21f7c3b6fea8da0",
              "sourceRevision": "6426",
              "readAtMs": 1792984526752
            },
            "requestStartedAtMs": 1792984526748,
            "responseAtMs": 1792984526751
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "coord_message:target",
              "fieldPath": "highlight",
              "valueFingerprint": "76f2fa218dc196571aee61ce1ba5c3620ff978c7343a7e512cde00f0904e56a9"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "coord_message:target",
              "fieldPath": "highlight",
              "valueFingerprint": "76f2fa218dc196571aee61ce1ba5c3620ff978c7343a7e512cde00f0904e56a9",
              "authority": "harness_shared.coord_event_log",
              "authorityEpoch": "707f0280f4bd8b04ecbf90555563bbb8df3ad745fae787b8c21f7c3b6fea8da0",
              "sourceRevision": "6426",
              "readAtMs": 1792984526752
            },
            "requestStartedAtMs": 1792984526748,
            "responseAtMs": 1792984526751
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        }
      ]
    },
    {
      "caseId": "coord_message/lexical",
      "phase": "since-inclusive",
      "before": {
        "raw": {
          "id": 1,
          "workspace_id": "p001-coord-workspace",
          "surface": "messages",
          "msg_id": "target",
          "body": {
            "body": "replacement canonical body",
            "from": "author-B",
            "kind": "notify",
            "summary": "zephyrcoordwitness replacement summary"
          },
          "ts": "2026-01-15T12:00:00.000Z",
          "harness_slug": "p001-coord-harness",
          "revision": "6426"
        },
        "corpus": [
          {
            "workspace_id": "p001-coord-workspace-other",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "foreign-workspace",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6418"
          },
          {
            "workspace_id": "default",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "host-global",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6421"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness-other",
            "surface": "messages",
            "msg_id": "other-harness",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6419"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "intents",
            "msg_id": "other-surface",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6420"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "target",
            "body": {
              "body": "replacement canonical body",
              "from": "author-B",
              "kind": "notify",
              "summary": "zephyrcoordwitness replacement summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6426"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": null,
            "surface": "messages",
            "msg_id": "unscoped",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6422"
          }
        ],
        "readAtMs": 1792984526753,
        "epoch": "d0bd047a1d5dd5a7870b054ff47c1b11b03e4ce00a48cd7e146ffa9a5d39ed5c"
      },
      "after": {
        "raw": {
          "id": 1,
          "workspace_id": "p001-coord-workspace",
          "surface": "messages",
          "msg_id": "target",
          "body": {
            "body": "replacement canonical body",
            "from": "author-B",
            "kind": "notify",
            "summary": "zephyrcoordwitness replacement summary"
          },
          "ts": "2026-01-15T12:00:00.000Z",
          "harness_slug": "p001-coord-harness",
          "revision": "6426"
        },
        "corpus": [
          {
            "workspace_id": "p001-coord-workspace-other",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "foreign-workspace",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6418"
          },
          {
            "workspace_id": "default",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "host-global",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6421"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness-other",
            "surface": "messages",
            "msg_id": "other-harness",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6419"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "intents",
            "msg_id": "other-surface",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6420"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "target",
            "body": {
              "body": "replacement canonical body",
              "from": "author-B",
              "kind": "notify",
              "summary": "zephyrcoordwitness replacement summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6426"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": null,
            "surface": "messages",
            "msg_id": "unscoped",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6422"
          }
        ],
        "readAtMs": 1792984526756,
        "epoch": "d0bd047a1d5dd5a7870b054ff47c1b11b03e4ce00a48cd7e146ffa9a5d39ed5c"
      },
      "rows": [
        {
          "key": "coord_message:host-global",
          "score": 0.1,
          "row": {
            "source": "coord_message",
            "source_id": "host-global",
            "scope": "p001-coord-harness",
            "excerpt": "[notify from author-A Thu Jan 15 2026 07:00:00 GMT-0500 (Eastern Standard Time)] zephyrcoordwitness original summary original canonical body",
            "highlight": "<mark>zephyrcoordwitness</mark> original summary original canonical body",
            "score": 0.1,
            "rankers": [
              "lexical"
            ]
          }
        },
        {
          "key": "coord_message:target",
          "score": 0.1,
          "row": {
            "source": "coord_message",
            "source_id": "target",
            "scope": "p001-coord-harness",
            "excerpt": "[notify from author-B Thu Jan 15 2026 07:00:00 GMT-0500 (Eastern Standard Time)] zephyrcoordwitness replacement summary replacement canonical body",
            "highlight": "<mark>zephyrcoordwitness</mark> replacement summary replacement canonical body",
            "score": 0.1,
            "rankers": [
              "lexical"
            ]
          }
        }
      ],
      "expectedIds": [
        "target",
        "host-global"
      ],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "coord_message:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "cbcabf23620c45200caff51d1d0bde81ceddcd1b2e6d3a21ebf6aa20f8c65783"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "coord_message:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "cbcabf23620c45200caff51d1d0bde81ceddcd1b2e6d3a21ebf6aa20f8c65783",
              "authority": "harness_shared.coord_event_log",
              "authorityEpoch": "d0bd047a1d5dd5a7870b054ff47c1b11b03e4ce00a48cd7e146ffa9a5d39ed5c",
              "sourceRevision": "6426",
              "readAtMs": 1792984526756
            },
            "requestStartedAtMs": 1792984526752,
            "responseAtMs": 1792984526755
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "coord_message:target",
              "fieldPath": "highlight",
              "valueFingerprint": "76f2fa218dc196571aee61ce1ba5c3620ff978c7343a7e512cde00f0904e56a9"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "coord_message:target",
              "fieldPath": "highlight",
              "valueFingerprint": "76f2fa218dc196571aee61ce1ba5c3620ff978c7343a7e512cde00f0904e56a9",
              "authority": "harness_shared.coord_event_log",
              "authorityEpoch": "d0bd047a1d5dd5a7870b054ff47c1b11b03e4ce00a48cd7e146ffa9a5d39ed5c",
              "sourceRevision": "6426",
              "readAtMs": 1792984526756
            },
            "requestStartedAtMs": 1792984526752,
            "responseAtMs": 1792984526755
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        }
      ]
    },
    {
      "caseId": "coord_message/lexical",
      "phase": "since-after-event",
      "before": {
        "raw": {
          "id": 1,
          "workspace_id": "p001-coord-workspace",
          "surface": "messages",
          "msg_id": "target",
          "body": {
            "body": "replacement canonical body",
            "from": "author-B",
            "kind": "notify",
            "summary": "zephyrcoordwitness replacement summary"
          },
          "ts": "2026-01-15T12:00:00.000Z",
          "harness_slug": "p001-coord-harness",
          "revision": "6426"
        },
        "corpus": [
          {
            "workspace_id": "p001-coord-workspace-other",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "foreign-workspace",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6418"
          },
          {
            "workspace_id": "default",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "host-global",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6421"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness-other",
            "surface": "messages",
            "msg_id": "other-harness",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6419"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "intents",
            "msg_id": "other-surface",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6420"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "target",
            "body": {
              "body": "replacement canonical body",
              "from": "author-B",
              "kind": "notify",
              "summary": "zephyrcoordwitness replacement summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6426"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": null,
            "surface": "messages",
            "msg_id": "unscoped",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6422"
          }
        ],
        "readAtMs": 1792984526757,
        "epoch": "9f0e28ac120208bf6949e35986dcdea698a45b43de57f6c072819df7fc279b72"
      },
      "after": {
        "raw": {
          "id": 1,
          "workspace_id": "p001-coord-workspace",
          "surface": "messages",
          "msg_id": "target",
          "body": {
            "body": "replacement canonical body",
            "from": "author-B",
            "kind": "notify",
            "summary": "zephyrcoordwitness replacement summary"
          },
          "ts": "2026-01-15T12:00:00.000Z",
          "harness_slug": "p001-coord-harness",
          "revision": "6426"
        },
        "corpus": [
          {
            "workspace_id": "p001-coord-workspace-other",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "foreign-workspace",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6418"
          },
          {
            "workspace_id": "default",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "host-global",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6421"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness-other",
            "surface": "messages",
            "msg_id": "other-harness",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6419"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "intents",
            "msg_id": "other-surface",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6420"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "target",
            "body": {
              "body": "replacement canonical body",
              "from": "author-B",
              "kind": "notify",
              "summary": "zephyrcoordwitness replacement summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6426"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": null,
            "surface": "messages",
            "msg_id": "unscoped",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6422"
          }
        ],
        "readAtMs": 1792984526759,
        "epoch": "9f0e28ac120208bf6949e35986dcdea698a45b43de57f6c072819df7fc279b72"
      },
      "rows": [],
      "expectedIds": [],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "coord_message:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "coord_message:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "cbcabf23620c45200caff51d1d0bde81ceddcd1b2e6d3a21ebf6aa20f8c65783",
              "authority": "harness_shared.coord_event_log",
              "authorityEpoch": "9f0e28ac120208bf6949e35986dcdea698a45b43de57f6c072819df7fc279b72",
              "sourceRevision": "6426",
              "readAtMs": 1792984526759
            },
            "requestStartedAtMs": 1792984526756,
            "responseAtMs": 1792984526759
          },
          "oracle": null
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "coord_message:target",
              "fieldPath": "highlight",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "coord_message:target",
              "fieldPath": "highlight",
              "valueFingerprint": "76f2fa218dc196571aee61ce1ba5c3620ff978c7343a7e512cde00f0904e56a9",
              "authority": "harness_shared.coord_event_log",
              "authorityEpoch": "9f0e28ac120208bf6949e35986dcdea698a45b43de57f6c072819df7fc279b72",
              "sourceRevision": "6426",
              "readAtMs": 1792984526759
            },
            "requestStartedAtMs": 1792984526756,
            "responseAtMs": 1792984526759
          },
          "oracle": null
        }
      ]
    },
    {
      "caseId": "coord_message/lexical",
      "phase": "until-exclusive",
      "before": {
        "raw": {
          "id": 1,
          "workspace_id": "p001-coord-workspace",
          "surface": "messages",
          "msg_id": "target",
          "body": {
            "body": "replacement canonical body",
            "from": "author-B",
            "kind": "notify",
            "summary": "zephyrcoordwitness replacement summary"
          },
          "ts": "2026-01-15T12:00:00.000Z",
          "harness_slug": "p001-coord-harness",
          "revision": "6426"
        },
        "corpus": [
          {
            "workspace_id": "p001-coord-workspace-other",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "foreign-workspace",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6418"
          },
          {
            "workspace_id": "default",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "host-global",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6421"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness-other",
            "surface": "messages",
            "msg_id": "other-harness",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6419"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "intents",
            "msg_id": "other-surface",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6420"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "target",
            "body": {
              "body": "replacement canonical body",
              "from": "author-B",
              "kind": "notify",
              "summary": "zephyrcoordwitness replacement summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6426"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": null,
            "surface": "messages",
            "msg_id": "unscoped",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6422"
          }
        ],
        "readAtMs": 1792984526760,
        "epoch": "1b10afddc1f7ab7e1e4b6959fc2922b250ad05d80cc20548f7366d15348dd9ad"
      },
      "after": {
        "raw": {
          "id": 1,
          "workspace_id": "p001-coord-workspace",
          "surface": "messages",
          "msg_id": "target",
          "body": {
            "body": "replacement canonical body",
            "from": "author-B",
            "kind": "notify",
            "summary": "zephyrcoordwitness replacement summary"
          },
          "ts": "2026-01-15T12:00:00.000Z",
          "harness_slug": "p001-coord-harness",
          "revision": "6426"
        },
        "corpus": [
          {
            "workspace_id": "p001-coord-workspace-other",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "foreign-workspace",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6418"
          },
          {
            "workspace_id": "default",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "host-global",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6421"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness-other",
            "surface": "messages",
            "msg_id": "other-harness",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6419"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "intents",
            "msg_id": "other-surface",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6420"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "target",
            "body": {
              "body": "replacement canonical body",
              "from": "author-B",
              "kind": "notify",
              "summary": "zephyrcoordwitness replacement summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6426"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": null,
            "surface": "messages",
            "msg_id": "unscoped",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6422"
          }
        ],
        "readAtMs": 1792984526763,
        "epoch": "1b10afddc1f7ab7e1e4b6959fc2922b250ad05d80cc20548f7366d15348dd9ad"
      },
      "rows": [],
      "expectedIds": [],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "coord_message:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "coord_message:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "cbcabf23620c45200caff51d1d0bde81ceddcd1b2e6d3a21ebf6aa20f8c65783",
              "authority": "harness_shared.coord_event_log",
              "authorityEpoch": "1b10afddc1f7ab7e1e4b6959fc2922b250ad05d80cc20548f7366d15348dd9ad",
              "sourceRevision": "6426",
              "readAtMs": 1792984526763
            },
            "requestStartedAtMs": 1792984526760,
            "responseAtMs": 1792984526762
          },
          "oracle": null
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "coord_message:target",
              "fieldPath": "highlight",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "coord_message:target",
              "fieldPath": "highlight",
              "valueFingerprint": "76f2fa218dc196571aee61ce1ba5c3620ff978c7343a7e512cde00f0904e56a9",
              "authority": "harness_shared.coord_event_log",
              "authorityEpoch": "1b10afddc1f7ab7e1e4b6959fc2922b250ad05d80cc20548f7366d15348dd9ad",
              "sourceRevision": "6426",
              "readAtMs": 1792984526763
            },
            "requestStartedAtMs": 1792984526760,
            "responseAtMs": 1792984526762
          },
          "oracle": null
        }
      ]
    },
    {
      "caseId": "coord_message/lexical",
      "phase": "until-after-event",
      "before": {
        "raw": {
          "id": 1,
          "workspace_id": "p001-coord-workspace",
          "surface": "messages",
          "msg_id": "target",
          "body": {
            "body": "replacement canonical body",
            "from": "author-B",
            "kind": "notify",
            "summary": "zephyrcoordwitness replacement summary"
          },
          "ts": "2026-01-15T12:00:00.000Z",
          "harness_slug": "p001-coord-harness",
          "revision": "6426"
        },
        "corpus": [
          {
            "workspace_id": "p001-coord-workspace-other",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "foreign-workspace",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6418"
          },
          {
            "workspace_id": "default",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "host-global",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6421"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness-other",
            "surface": "messages",
            "msg_id": "other-harness",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6419"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "intents",
            "msg_id": "other-surface",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6420"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "target",
            "body": {
              "body": "replacement canonical body",
              "from": "author-B",
              "kind": "notify",
              "summary": "zephyrcoordwitness replacement summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6426"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": null,
            "surface": "messages",
            "msg_id": "unscoped",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6422"
          }
        ],
        "readAtMs": 1792984526764,
        "epoch": "dc006305990cff8212631baa91abc324990947f8f1b99ff3845b0647f4fd9e47"
      },
      "after": {
        "raw": {
          "id": 1,
          "workspace_id": "p001-coord-workspace",
          "surface": "messages",
          "msg_id": "target",
          "body": {
            "body": "replacement canonical body",
            "from": "author-B",
            "kind": "notify",
            "summary": "zephyrcoordwitness replacement summary"
          },
          "ts": "2026-01-15T12:00:00.000Z",
          "harness_slug": "p001-coord-harness",
          "revision": "6426"
        },
        "corpus": [
          {
            "workspace_id": "p001-coord-workspace-other",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "foreign-workspace",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6418"
          },
          {
            "workspace_id": "default",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "host-global",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6421"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness-other",
            "surface": "messages",
            "msg_id": "other-harness",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6419"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "intents",
            "msg_id": "other-surface",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6420"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "target",
            "body": {
              "body": "replacement canonical body",
              "from": "author-B",
              "kind": "notify",
              "summary": "zephyrcoordwitness replacement summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6426"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": null,
            "surface": "messages",
            "msg_id": "unscoped",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6422"
          }
        ],
        "readAtMs": 1792984526766,
        "epoch": "dc006305990cff8212631baa91abc324990947f8f1b99ff3845b0647f4fd9e47"
      },
      "rows": [
        {
          "key": "coord_message:host-global",
          "score": 0.1,
          "row": {
            "source": "coord_message",
            "source_id": "host-global",
            "scope": "p001-coord-harness",
            "excerpt": "[notify from author-A Thu Jan 15 2026 07:00:00 GMT-0500 (Eastern Standard Time)] zephyrcoordwitness original summary original canonical body",
            "highlight": "<mark>zephyrcoordwitness</mark> original summary original canonical body",
            "score": 0.1,
            "rankers": [
              "lexical"
            ]
          }
        },
        {
          "key": "coord_message:target",
          "score": 0.1,
          "row": {
            "source": "coord_message",
            "source_id": "target",
            "scope": "p001-coord-harness",
            "excerpt": "[notify from author-B Thu Jan 15 2026 07:00:00 GMT-0500 (Eastern Standard Time)] zephyrcoordwitness replacement summary replacement canonical body",
            "highlight": "<mark>zephyrcoordwitness</mark> replacement summary replacement canonical body",
            "score": 0.1,
            "rankers": [
              "lexical"
            ]
          }
        }
      ],
      "expectedIds": [
        "target",
        "host-global"
      ],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "coord_message:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "cbcabf23620c45200caff51d1d0bde81ceddcd1b2e6d3a21ebf6aa20f8c65783"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "coord_message:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "cbcabf23620c45200caff51d1d0bde81ceddcd1b2e6d3a21ebf6aa20f8c65783",
              "authority": "harness_shared.coord_event_log",
              "authorityEpoch": "dc006305990cff8212631baa91abc324990947f8f1b99ff3845b0647f4fd9e47",
              "sourceRevision": "6426",
              "readAtMs": 1792984526766
            },
            "requestStartedAtMs": 1792984526763,
            "responseAtMs": 1792984526765
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "coord_message:target",
              "fieldPath": "highlight",
              "valueFingerprint": "76f2fa218dc196571aee61ce1ba5c3620ff978c7343a7e512cde00f0904e56a9"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "coord_message:target",
              "fieldPath": "highlight",
              "valueFingerprint": "76f2fa218dc196571aee61ce1ba5c3620ff978c7343a7e512cde00f0904e56a9",
              "authority": "harness_shared.coord_event_log",
              "authorityEpoch": "dc006305990cff8212631baa91abc324990947f8f1b99ff3845b0647f4fd9e47",
              "sourceRevision": "6426",
              "readAtMs": 1792984526766
            },
            "requestStartedAtMs": 1792984526763,
            "responseAtMs": 1792984526765
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable"
            ]
          }
        }
      ]
    },
    {
      "caseId": "coord_message/lexical",
      "phase": "explicit-session-refusal",
      "before": {
        "raw": {
          "id": 1,
          "workspace_id": "p001-coord-workspace",
          "surface": "messages",
          "msg_id": "target",
          "body": {
            "body": "replacement canonical body",
            "from": "author-B",
            "kind": "notify",
            "summary": "zephyrcoordwitness replacement summary"
          },
          "ts": "2026-01-15T12:00:00.000Z",
          "harness_slug": "p001-coord-harness",
          "revision": "6426"
        },
        "corpus": [
          {
            "workspace_id": "p001-coord-workspace-other",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "foreign-workspace",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6418"
          },
          {
            "workspace_id": "default",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "host-global",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6421"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness-other",
            "surface": "messages",
            "msg_id": "other-harness",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6419"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "intents",
            "msg_id": "other-surface",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6420"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "target",
            "body": {
              "body": "replacement canonical body",
              "from": "author-B",
              "kind": "notify",
              "summary": "zephyrcoordwitness replacement summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6426"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": null,
            "surface": "messages",
            "msg_id": "unscoped",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6422"
          }
        ],
        "readAtMs": 1792984526767,
        "epoch": "1321d2bd2dd3b03ad224ccfe7eb160834a2102738840fc8d36857f53aa631ab0"
      },
      "after": {
        "raw": {
          "id": 1,
          "workspace_id": "p001-coord-workspace",
          "surface": "messages",
          "msg_id": "target",
          "body": {
            "body": "replacement canonical body",
            "from": "author-B",
            "kind": "notify",
            "summary": "zephyrcoordwitness replacement summary"
          },
          "ts": "2026-01-15T12:00:00.000Z",
          "harness_slug": "p001-coord-harness",
          "revision": "6426"
        },
        "corpus": [
          {
            "workspace_id": "p001-coord-workspace-other",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "foreign-workspace",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6418"
          },
          {
            "workspace_id": "default",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "host-global",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6421"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness-other",
            "surface": "messages",
            "msg_id": "other-harness",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6419"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "intents",
            "msg_id": "other-surface",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6420"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": "p001-coord-harness",
            "surface": "messages",
            "msg_id": "target",
            "body": {
              "body": "replacement canonical body",
              "from": "author-B",
              "kind": "notify",
              "summary": "zephyrcoordwitness replacement summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6426"
          },
          {
            "workspace_id": "p001-coord-workspace",
            "harness_slug": null,
            "surface": "messages",
            "msg_id": "unscoped",
            "body": {
              "body": "original canonical body",
              "from": "author-A",
              "kind": "notify",
              "summary": "zephyrcoordwitness original summary"
            },
            "ts": "2026-01-15T12:00:00.000Z",
            "revision": "6422"
          }
        ],
        "readAtMs": 1792984526768,
        "epoch": "1321d2bd2dd3b03ad224ccfe7eb160834a2102738840fc8d36857f53aa631ab0"
      },
      "rows": [],
      "expectedIds": [],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "coord_message:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "coord_message:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "cbcabf23620c45200caff51d1d0bde81ceddcd1b2e6d3a21ebf6aa20f8c65783",
              "authority": "harness_shared.coord_event_log",
              "authorityEpoch": "1321d2bd2dd3b03ad224ccfe7eb160834a2102738840fc8d36857f53aa631ab0",
              "sourceRevision": "6426",
              "readAtMs": 1792984526768
            },
            "requestStartedAtMs": 1792984526766,
            "responseAtMs": 1792984526767
          },
          "oracle": null
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "coord_message:target",
              "fieldPath": "highlight",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "coord_message:target",
              "fieldPath": "highlight",
              "valueFingerprint": "76f2fa218dc196571aee61ce1ba5c3620ff978c7343a7e512cde00f0904e56a9",
              "authority": "harness_shared.coord_event_log",
              "authorityEpoch": "1321d2bd2dd3b03ad224ccfe7eb160834a2102738840fc8d36857f53aa631ab0",
              "sourceRevision": "6426",
              "readAtMs": 1792984526768
            },
            "requestStartedAtMs": 1792984526766,
            "responseAtMs": 1792984526767
          },
          "oracle": null
        }
      ]
    }
  ],
  "limits": [
    "Minimal private PostgreSQL schema and controlled canonical changes; actual registered lexical SQL reader.",
    "Default-workspace messages are deliberately host-global; foreign non-default workspaces remain excluded.",
    "No production coordination authoring/delivery/sync, authentication, candidate completeness or index-version witness.",
    "Reader scope epoch is controlled fixture input, not a measured production authorization epoch.",
    "Matching values remain unknown without index evidence; copied old values fail canonical comparison.",
    "Other adapters, quality, budgets, runtime acceptance and shipment remain open."
  ]
}
