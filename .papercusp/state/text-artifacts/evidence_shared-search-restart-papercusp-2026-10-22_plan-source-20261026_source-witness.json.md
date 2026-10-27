---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/plan-source-20261026/source-witness.json"
updated_at: 1792983753062
_body: "content"
---

{
  "schemaVersion": 1,
  "population": [
    "plan/lexical",
    "plan/embedding"
  ],
  "completed": [
    "plan/lexical",
    "plan/embedding"
  ],
  "pins": [
    {
      "path": "packages/operator-core/lib/agent-tools/search/plan-source-freshness.integration.test.ts",
      "sha256": "54696bfb9360f9627114a7356346c8c9512420a9590810044d2ed50a6bea2537"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/search/knowledge-sources.ts",
      "sha256": "c1ce37b2dc299c219f61304b43aca5337c6ece87a714c2a1dd1ce0493d5b82d8"
    },
    {
      "path": "packages/operator-core/lib/search/chunks/registry.ts",
      "sha256": "4f4df5fb5f422025457b6750dbde3e9d95827e22c9c0da56e1d82992deb0db86"
    },
    {
      "path": "packages/operator-core/lib/search/surface-registry.ts",
      "sha256": "53e3bd3fd49a1d3d2413d6486983715882f857d841117b7727f30a83dbf30e23"
    }
  ],
  "receipts": [
    {
      "caseId": "plan/lexical",
      "phase": "stored-and-indexed",
      "before": {
        "raw": {
          "workspace_id": "p001-plan-lexical",
          "harness_slug": "p001-plan-lexical-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness original canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.208Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'origin':4 'plan':2 'task':6 'zephyrplanwit':3",
          "revision": "6417"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness original canonical tasks",
            "parent_sha": "5e2355b8df9ede58df26d33c9c959a955daf2816e1c39d1ae2418a7e619ba08e",
            "chunk_sha": "33d98978eb850d76c5aca538e2caad24ae0e841949fb395dae11a1bbd28e6705",
            "revision": "6418"
          }
        ],
        "readAtMs": 1792983150236,
        "epoch": "e5bfba8b630652abc078586bba0a58834231c8248d52243a94428b2509fdba94"
      },
      "after": {
        "raw": {
          "workspace_id": "p001-plan-lexical",
          "harness_slug": "p001-plan-lexical-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness original canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.208Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'origin':4 'plan':2 'task':6 'zephyrplanwit':3",
          "revision": "6417"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness original canonical tasks",
            "parent_sha": "5e2355b8df9ede58df26d33c9c959a955daf2816e1c39d1ae2418a7e619ba08e",
            "chunk_sha": "33d98978eb850d76c5aca538e2caad24ae0e841949fb395dae11a1bbd28e6705",
            "revision": "6418"
          }
        ],
        "readAtMs": 1792983150242,
        "epoch": "e5bfba8b630652abc078586bba0a58834231c8248d52243a94428b2509fdba94"
      },
      "rows": [
        {
          "key": "plan:p001-plan-lexical-harness:target",
          "score": 0.10000000149011612,
          "row": {
            "source": "plan",
            "source_id": "p001-plan-lexical-harness:target",
            "scope": "harness:p001-plan-lexical-harness",
            "ts": "2026-10-26T02:52:30.208Z",
            "excerpt": "Canonical plan\nzephyrplanwitness original canonical tasks",
            "highlight": "<mark>zephyrplanwitness</mark> original canonical tasks",
            "score": 0.10000000149011612,
            "rankers": [
              "lexical"
            ],
            "meta": {
              "title": "Canonical plan",
              "section": null,
              "status": "ready",
              "currentness": "plan",
              "path": "/admin/plans?plan=target&harness=p001-plan-lexical-harness"
            }
          }
        }
      ],
      "expectedIds": [
        "p001-plan-lexical-harness:target"
      ],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "a0c5546d4695dc94f7cf97c54f391d23f87c712b59a438fd216a4dd0a362e543"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "a0c5546d4695dc94f7cf97c54f391d23f87c712b59a438fd216a4dd0a362e543",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "e5bfba8b630652abc078586bba0a58834231c8248d52243a94428b2509fdba94",
              "sourceRevision": "6417",
              "readAtMs": 1792983150242
            },
            "requestStartedAtMs": 1792983150234,
            "responseAtMs": 1792983150241
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
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "b352a8f3d1d034c1c95243a5302c0be776dfd9134def1d8d3c2eecfe5e5374b6"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "b352a8f3d1d034c1c95243a5302c0be776dfd9134def1d8d3c2eecfe5e5374b6",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "e5bfba8b630652abc078586bba0a58834231c8248d52243a94428b2509fdba94",
              "sourceRevision": "6417",
              "readAtMs": 1792983150242
            },
            "requestStartedAtMs": 1792983150234,
            "responseAtMs": 1792983150241
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
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "7493551181fd7ba46c059bc71135f5ce231f1e6889711df9df97d6ad2cccf682"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "7493551181fd7ba46c059bc71135f5ce231f1e6889711df9df97d6ad2cccf682",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "e5bfba8b630652abc078586bba0a58834231c8248d52243a94428b2509fdba94",
              "sourceRevision": "6417",
              "readAtMs": 1792983150242
            },
            "requestStartedAtMs": 1792983150234,
            "responseAtMs": 1792983150241
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
      "caseId": "plan/lexical",
      "phase": "canonical-content-changed-before-reindex",
      "before": {
        "raw": {
          "workspace_id": "p001-plan-lexical",
          "harness_slug": "p001-plan-lexical-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.245Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6423"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness original canonical tasks",
            "parent_sha": "5e2355b8df9ede58df26d33c9c959a955daf2816e1c39d1ae2418a7e619ba08e",
            "chunk_sha": "33d98978eb850d76c5aca538e2caad24ae0e841949fb395dae11a1bbd28e6705",
            "revision": "6418"
          }
        ],
        "readAtMs": 1792983150246,
        "epoch": "e5bfba8b630652abc078586bba0a58834231c8248d52243a94428b2509fdba94"
      },
      "after": {
        "raw": {
          "workspace_id": "p001-plan-lexical",
          "harness_slug": "p001-plan-lexical-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.245Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6423"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness original canonical tasks",
            "parent_sha": "5e2355b8df9ede58df26d33c9c959a955daf2816e1c39d1ae2418a7e619ba08e",
            "chunk_sha": "33d98978eb850d76c5aca538e2caad24ae0e841949fb395dae11a1bbd28e6705",
            "revision": "6418"
          }
        ],
        "readAtMs": 1792983150251,
        "epoch": "e5bfba8b630652abc078586bba0a58834231c8248d52243a94428b2509fdba94"
      },
      "rows": [
        {
          "key": "plan:p001-plan-lexical-harness:target",
          "score": 0.10000000149011612,
          "row": {
            "source": "plan",
            "source_id": "p001-plan-lexical-harness:target",
            "scope": "harness:p001-plan-lexical-harness",
            "ts": "2026-10-26T02:52:30.245Z",
            "excerpt": "Canonical plan\nzephyrplanwitness replacement canonical tasks",
            "highlight": "<mark>zephyrplanwitness</mark> replacement canonical tasks",
            "score": 0.10000000149011612,
            "rankers": [
              "lexical"
            ],
            "meta": {
              "title": "Canonical plan",
              "section": null,
              "status": "ready",
              "currentness": "plan",
              "path": "/admin/plans?plan=target&harness=p001-plan-lexical-harness"
            }
          }
        }
      ],
      "expectedIds": [
        "p001-plan-lexical-harness:target"
      ],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "e5bfba8b630652abc078586bba0a58834231c8248d52243a94428b2509fdba94",
              "sourceRevision": "6423",
              "readAtMs": 1792983150251
            },
            "requestStartedAtMs": 1792983150245,
            "responseAtMs": 1792983150250
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
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cec672ef897d9634381f0b12f3cfa3747019ddaa992e8c96b4550fdf9cf22113"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cec672ef897d9634381f0b12f3cfa3747019ddaa992e8c96b4550fdf9cf22113",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "e5bfba8b630652abc078586bba0a58834231c8248d52243a94428b2509fdba94",
              "sourceRevision": "6423",
              "readAtMs": 1792983150251
            },
            "requestStartedAtMs": 1792983150245,
            "responseAtMs": 1792983150250
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
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "a252bcedf5a45ed6e7785b133aae8f5e9bde41f790f9f7c6850a1ba6f206677c"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "a252bcedf5a45ed6e7785b133aae8f5e9bde41f790f9f7c6850a1ba6f206677c",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "e5bfba8b630652abc078586bba0a58834231c8248d52243a94428b2509fdba94",
              "sourceRevision": "6423",
              "readAtMs": 1792983150251
            },
            "requestStartedAtMs": 1792983150245,
            "responseAtMs": 1792983150250
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
      "caseId": "plan/lexical",
      "phase": "canonical-content-reindexed",
      "before": {
        "raw": {
          "workspace_id": "p001-plan-lexical",
          "harness_slug": "p001-plan-lexical-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.245Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6423"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6424"
          }
        ],
        "readAtMs": 1792983150254,
        "epoch": "e5bfba8b630652abc078586bba0a58834231c8248d52243a94428b2509fdba94"
      },
      "after": {
        "raw": {
          "workspace_id": "p001-plan-lexical",
          "harness_slug": "p001-plan-lexical-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.245Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6423"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6424"
          }
        ],
        "readAtMs": 1792983150259,
        "epoch": "e5bfba8b630652abc078586bba0a58834231c8248d52243a94428b2509fdba94"
      },
      "rows": [
        {
          "key": "plan:p001-plan-lexical-harness:target",
          "score": 0.10000000149011612,
          "row": {
            "source": "plan",
            "source_id": "p001-plan-lexical-harness:target",
            "scope": "harness:p001-plan-lexical-harness",
            "ts": "2026-10-26T02:52:30.245Z",
            "excerpt": "Canonical plan\nzephyrplanwitness replacement canonical tasks",
            "highlight": "<mark>zephyrplanwitness</mark> replacement canonical tasks",
            "score": 0.10000000149011612,
            "rankers": [
              "lexical"
            ],
            "meta": {
              "title": "Canonical plan",
              "section": null,
              "status": "ready",
              "currentness": "plan",
              "path": "/admin/plans?plan=target&harness=p001-plan-lexical-harness"
            }
          }
        }
      ],
      "expectedIds": [
        "p001-plan-lexical-harness:target"
      ],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "e5bfba8b630652abc078586bba0a58834231c8248d52243a94428b2509fdba94",
              "sourceRevision": "6423",
              "readAtMs": 1792983150259
            },
            "requestStartedAtMs": 1792983150253,
            "responseAtMs": 1792983150258
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
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cec672ef897d9634381f0b12f3cfa3747019ddaa992e8c96b4550fdf9cf22113"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cec672ef897d9634381f0b12f3cfa3747019ddaa992e8c96b4550fdf9cf22113",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "e5bfba8b630652abc078586bba0a58834231c8248d52243a94428b2509fdba94",
              "sourceRevision": "6423",
              "readAtMs": 1792983150259
            },
            "requestStartedAtMs": 1792983150253,
            "responseAtMs": 1792983150258
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
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "a252bcedf5a45ed6e7785b133aae8f5e9bde41f790f9f7c6850a1ba6f206677c"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "a252bcedf5a45ed6e7785b133aae8f5e9bde41f790f9f7c6850a1ba6f206677c",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "e5bfba8b630652abc078586bba0a58834231c8248d52243a94428b2509fdba94",
              "sourceRevision": "6423",
              "readAtMs": 1792983150259
            },
            "requestStartedAtMs": 1792983150253,
            "responseAtMs": 1792983150258
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
      "caseId": "plan/lexical",
      "phase": "candidate-added",
      "before": {
        "raw": {
          "workspace_id": "p001-plan-lexical",
          "harness_slug": "p001-plan-lexical-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.245Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6423"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6424"
          }
        ],
        "readAtMs": 1792983150263,
        "epoch": "e5bfba8b630652abc078586bba0a58834231c8248d52243a94428b2509fdba94"
      },
      "after": {
        "raw": {
          "workspace_id": "p001-plan-lexical",
          "harness_slug": "p001-plan-lexical-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.245Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6423"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6424"
          }
        ],
        "readAtMs": 1792983150268,
        "epoch": "e5bfba8b630652abc078586bba0a58834231c8248d52243a94428b2509fdba94"
      },
      "rows": [
        {
          "key": "plan:p001-plan-lexical-harness:added",
          "score": 0.10000000149011612,
          "row": {
            "source": "plan",
            "source_id": "p001-plan-lexical-harness:added",
            "scope": "harness:p001-plan-lexical-harness",
            "ts": "2026-10-26T02:52:30.260Z",
            "excerpt": "Canonical plan\nzephyrplanwitness original canonical tasks",
            "highlight": "<mark>zephyrplanwitness</mark> original canonical tasks",
            "score": 0.10000000149011612,
            "rankers": [
              "lexical"
            ],
            "meta": {
              "title": "Canonical plan",
              "section": null,
              "status": "ready",
              "currentness": "plan",
              "path": "/admin/plans?plan=added&harness=p001-plan-lexical-harness"
            }
          }
        },
        {
          "key": "plan:p001-plan-lexical-harness:target",
          "score": 0.10000000149011612,
          "row": {
            "source": "plan",
            "source_id": "p001-plan-lexical-harness:target",
            "scope": "harness:p001-plan-lexical-harness",
            "ts": "2026-10-26T02:52:30.245Z",
            "excerpt": "Canonical plan\nzephyrplanwitness replacement canonical tasks",
            "highlight": "<mark>zephyrplanwitness</mark> replacement canonical tasks",
            "score": 0.10000000149011612,
            "rankers": [
              "lexical"
            ],
            "meta": {
              "title": "Canonical plan",
              "section": null,
              "status": "ready",
              "currentness": "plan",
              "path": "/admin/plans?plan=target&harness=p001-plan-lexical-harness"
            }
          }
        }
      ],
      "expectedIds": [
        "p001-plan-lexical-harness:target",
        "p001-plan-lexical-harness:added"
      ],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "e5bfba8b630652abc078586bba0a58834231c8248d52243a94428b2509fdba94",
              "sourceRevision": "6423",
              "readAtMs": 1792983150268
            },
            "requestStartedAtMs": 1792983150262,
            "responseAtMs": 1792983150267
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
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cec672ef897d9634381f0b12f3cfa3747019ddaa992e8c96b4550fdf9cf22113"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cec672ef897d9634381f0b12f3cfa3747019ddaa992e8c96b4550fdf9cf22113",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "e5bfba8b630652abc078586bba0a58834231c8248d52243a94428b2509fdba94",
              "sourceRevision": "6423",
              "readAtMs": 1792983150268
            },
            "requestStartedAtMs": 1792983150262,
            "responseAtMs": 1792983150267
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
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "a252bcedf5a45ed6e7785b133aae8f5e9bde41f790f9f7c6850a1ba6f206677c"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "a252bcedf5a45ed6e7785b133aae8f5e9bde41f790f9f7c6850a1ba6f206677c",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "e5bfba8b630652abc078586bba0a58834231c8248d52243a94428b2509fdba94",
              "sourceRevision": "6423",
              "readAtMs": 1792983150268
            },
            "requestStartedAtMs": 1792983150262,
            "responseAtMs": 1792983150267
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
      "caseId": "plan/lexical",
      "phase": "candidate-deleted-despite-retained-chunk",
      "before": {
        "raw": {
          "workspace_id": "p001-plan-lexical",
          "harness_slug": "p001-plan-lexical-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.245Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6423"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6424"
          }
        ],
        "readAtMs": 1792983150271,
        "epoch": "e5bfba8b630652abc078586bba0a58834231c8248d52243a94428b2509fdba94"
      },
      "after": {
        "raw": {
          "workspace_id": "p001-plan-lexical",
          "harness_slug": "p001-plan-lexical-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.245Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6423"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6424"
          }
        ],
        "readAtMs": 1792983150276,
        "epoch": "e5bfba8b630652abc078586bba0a58834231c8248d52243a94428b2509fdba94"
      },
      "rows": [
        {
          "key": "plan:p001-plan-lexical-harness:target",
          "score": 0.10000000149011612,
          "row": {
            "source": "plan",
            "source_id": "p001-plan-lexical-harness:target",
            "scope": "harness:p001-plan-lexical-harness",
            "ts": "2026-10-26T02:52:30.245Z",
            "excerpt": "Canonical plan\nzephyrplanwitness replacement canonical tasks",
            "highlight": "<mark>zephyrplanwitness</mark> replacement canonical tasks",
            "score": 0.10000000149011612,
            "rankers": [
              "lexical"
            ],
            "meta": {
              "title": "Canonical plan",
              "section": null,
              "status": "ready",
              "currentness": "plan",
              "path": "/admin/plans?plan=target&harness=p001-plan-lexical-harness"
            }
          }
        }
      ],
      "expectedIds": [
        "p001-plan-lexical-harness:target"
      ],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "e5bfba8b630652abc078586bba0a58834231c8248d52243a94428b2509fdba94",
              "sourceRevision": "6423",
              "readAtMs": 1792983150276
            },
            "requestStartedAtMs": 1792983150269,
            "responseAtMs": 1792983150275
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
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cec672ef897d9634381f0b12f3cfa3747019ddaa992e8c96b4550fdf9cf22113"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cec672ef897d9634381f0b12f3cfa3747019ddaa992e8c96b4550fdf9cf22113",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "e5bfba8b630652abc078586bba0a58834231c8248d52243a94428b2509fdba94",
              "sourceRevision": "6423",
              "readAtMs": 1792983150276
            },
            "requestStartedAtMs": 1792983150269,
            "responseAtMs": 1792983150275
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
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "a252bcedf5a45ed6e7785b133aae8f5e9bde41f790f9f7c6850a1ba6f206677c"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "a252bcedf5a45ed6e7785b133aae8f5e9bde41f790f9f7c6850a1ba6f206677c",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "e5bfba8b630652abc078586bba0a58834231c8248d52243a94428b2509fdba94",
              "sourceRevision": "6423",
              "readAtMs": 1792983150276
            },
            "requestStartedAtMs": 1792983150269,
            "responseAtMs": 1792983150275
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
      "caseId": "plan/lexical",
      "phase": "audience-excluded",
      "before": {
        "raw": {
          "workspace_id": "p001-plan-lexical",
          "harness_slug": "p001-plan-lexical-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.245Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6423"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6424"
          }
        ],
        "readAtMs": 1792983150294,
        "epoch": "e7e617e77aec325c5d824503e84dbc7f98d87ca7264a892390d79aa1c4a61e77"
      },
      "after": {
        "raw": {
          "workspace_id": "p001-plan-lexical",
          "harness_slug": "p001-plan-lexical-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.245Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6423"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6424"
          }
        ],
        "readAtMs": 1792983150300,
        "epoch": "e7e617e77aec325c5d824503e84dbc7f98d87ca7264a892390d79aa1c4a61e77"
      },
      "rows": [],
      "expectedIds": [],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "e7e617e77aec325c5d824503e84dbc7f98d87ca7264a892390d79aa1c4a61e77",
              "sourceRevision": "6423",
              "readAtMs": 1792983150300
            },
            "requestStartedAtMs": 1792983150277,
            "responseAtMs": 1792983150299
          },
          "oracle": null
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cec672ef897d9634381f0b12f3cfa3747019ddaa992e8c96b4550fdf9cf22113",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "e7e617e77aec325c5d824503e84dbc7f98d87ca7264a892390d79aa1c4a61e77",
              "sourceRevision": "6423",
              "readAtMs": 1792983150300
            },
            "requestStartedAtMs": 1792983150277,
            "responseAtMs": 1792983150299
          },
          "oracle": null
        },
        {
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "a252bcedf5a45ed6e7785b133aae8f5e9bde41f790f9f7c6850a1ba6f206677c",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "e7e617e77aec325c5d824503e84dbc7f98d87ca7264a892390d79aa1c4a61e77",
              "sourceRevision": "6423",
              "readAtMs": 1792983150300
            },
            "requestStartedAtMs": 1792983150277,
            "responseAtMs": 1792983150299
          },
          "oracle": null
        }
      ]
    },
    {
      "caseId": "plan/lexical",
      "phase": "server-harness-fence",
      "before": {
        "raw": {
          "workspace_id": "p001-plan-lexical",
          "harness_slug": "p001-plan-lexical-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.245Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6423"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6424"
          }
        ],
        "readAtMs": 1792983150302,
        "epoch": "1cc5a3b3d3c13a38d2bde0f106fa3518837a83b26464aa1b72d21ccd9978a4fb"
      },
      "after": {
        "raw": {
          "workspace_id": "p001-plan-lexical",
          "harness_slug": "p001-plan-lexical-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.245Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6423"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6424"
          }
        ],
        "readAtMs": 1792983150308,
        "epoch": "1cc5a3b3d3c13a38d2bde0f106fa3518837a83b26464aa1b72d21ccd9978a4fb"
      },
      "rows": [],
      "expectedIds": [],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "1cc5a3b3d3c13a38d2bde0f106fa3518837a83b26464aa1b72d21ccd9978a4fb",
              "sourceRevision": "6423",
              "readAtMs": 1792983150308
            },
            "requestStartedAtMs": 1792983150300,
            "responseAtMs": 1792983150307
          },
          "oracle": null
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cec672ef897d9634381f0b12f3cfa3747019ddaa992e8c96b4550fdf9cf22113",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "1cc5a3b3d3c13a38d2bde0f106fa3518837a83b26464aa1b72d21ccd9978a4fb",
              "sourceRevision": "6423",
              "readAtMs": 1792983150308
            },
            "requestStartedAtMs": 1792983150300,
            "responseAtMs": 1792983150307
          },
          "oracle": null
        },
        {
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "a252bcedf5a45ed6e7785b133aae8f5e9bde41f790f9f7c6850a1ba6f206677c",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "1cc5a3b3d3c13a38d2bde0f106fa3518837a83b26464aa1b72d21ccd9978a4fb",
              "sourceRevision": "6423",
              "readAtMs": 1792983150308
            },
            "requestStartedAtMs": 1792983150300,
            "responseAtMs": 1792983150307
          },
          "oracle": null
        }
      ]
    },
    {
      "caseId": "plan/lexical",
      "phase": "archived-automatic-refusal",
      "before": {
        "raw": {
          "workspace_id": "p001-plan-lexical",
          "harness_slug": "p001-plan-lexical-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": true,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.245Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6428"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6424"
          }
        ],
        "readAtMs": 1792983150310,
        "epoch": "ca042ec13582484a2b9668a50e48f2b1a052c1770a642edbfaa0daecdf8de6ba"
      },
      "after": {
        "raw": {
          "workspace_id": "p001-plan-lexical",
          "harness_slug": "p001-plan-lexical-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": true,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.245Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6428"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6424"
          }
        ],
        "readAtMs": 1792983150315,
        "epoch": "ca042ec13582484a2b9668a50e48f2b1a052c1770a642edbfaa0daecdf8de6ba"
      },
      "rows": [],
      "expectedIds": [],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "ca042ec13582484a2b9668a50e48f2b1a052c1770a642edbfaa0daecdf8de6ba",
              "sourceRevision": "6428",
              "readAtMs": 1792983150315
            },
            "requestStartedAtMs": 1792983150309,
            "responseAtMs": 1792983150314
          },
          "oracle": null
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cec672ef897d9634381f0b12f3cfa3747019ddaa992e8c96b4550fdf9cf22113",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "ca042ec13582484a2b9668a50e48f2b1a052c1770a642edbfaa0daecdf8de6ba",
              "sourceRevision": "6428",
              "readAtMs": 1792983150315
            },
            "requestStartedAtMs": 1792983150309,
            "responseAtMs": 1792983150314
          },
          "oracle": null
        },
        {
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "a252bcedf5a45ed6e7785b133aae8f5e9bde41f790f9f7c6850a1ba6f206677c",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "ca042ec13582484a2b9668a50e48f2b1a052c1770a642edbfaa0daecdf8de6ba",
              "sourceRevision": "6428",
              "readAtMs": 1792983150315
            },
            "requestStartedAtMs": 1792983150309,
            "responseAtMs": 1792983150314
          },
          "oracle": null
        }
      ]
    },
    {
      "caseId": "plan/lexical",
      "phase": "archived-explicit-historical",
      "before": {
        "raw": {
          "workspace_id": "p001-plan-lexical",
          "harness_slug": "p001-plan-lexical-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": true,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.245Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6428"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6424"
          }
        ],
        "readAtMs": 1792983150317,
        "epoch": "3f4dd23b2e04ca85af5e3df3331193c894d7024ea8ee4bd5454d2ba05a733da0"
      },
      "after": {
        "raw": {
          "workspace_id": "p001-plan-lexical",
          "harness_slug": "p001-plan-lexical-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": true,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.245Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6428"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6424"
          }
        ],
        "readAtMs": 1792983150324,
        "epoch": "3f4dd23b2e04ca85af5e3df3331193c894d7024ea8ee4bd5454d2ba05a733da0"
      },
      "rows": [
        {
          "key": "plan:p001-plan-lexical-harness:target",
          "score": 0.10000000149011612,
          "row": {
            "source": "plan",
            "source_id": "p001-plan-lexical-harness:target",
            "scope": "harness:p001-plan-lexical-harness",
            "ts": "2026-10-26T02:52:30.245Z",
            "excerpt": "Canonical plan\nzephyrplanwitness replacement canonical tasks",
            "highlight": "<mark>zephyrplanwitness</mark> replacement canonical tasks",
            "score": 0.10000000149011612,
            "rankers": [
              "lexical"
            ],
            "meta": {
              "title": "Canonical plan",
              "section": null,
              "status": "historical",
              "currentness": "historical",
              "path": "/admin/plans?plan=target&harness=p001-plan-lexical-harness"
            }
          }
        }
      ],
      "expectedIds": [
        "p001-plan-lexical-harness:target"
      ],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "3f4dd23b2e04ca85af5e3df3331193c894d7024ea8ee4bd5454d2ba05a733da0",
              "sourceRevision": "6428",
              "readAtMs": 1792983150324
            },
            "requestStartedAtMs": 1792983150316,
            "responseAtMs": 1792983150322
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
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cec672ef897d9634381f0b12f3cfa3747019ddaa992e8c96b4550fdf9cf22113"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cec672ef897d9634381f0b12f3cfa3747019ddaa992e8c96b4550fdf9cf22113",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "3f4dd23b2e04ca85af5e3df3331193c894d7024ea8ee4bd5454d2ba05a733da0",
              "sourceRevision": "6428",
              "readAtMs": 1792983150324
            },
            "requestStartedAtMs": 1792983150316,
            "responseAtMs": 1792983150322
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
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "a252bcedf5a45ed6e7785b133aae8f5e9bde41f790f9f7c6850a1ba6f206677c"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "a252bcedf5a45ed6e7785b133aae8f5e9bde41f790f9f7c6850a1ba6f206677c",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "3f4dd23b2e04ca85af5e3df3331193c894d7024ea8ee4bd5454d2ba05a733da0",
              "sourceRevision": "6428",
              "readAtMs": 1792983150324
            },
            "requestStartedAtMs": 1792983150316,
            "responseAtMs": 1792983150322
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
      "caseId": "plan/lexical",
      "phase": "superseded-automatic-refusal",
      "before": {
        "raw": {
          "workspace_id": "p001-plan-lexical",
          "harness_slug": "p001-plan-lexical-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": "successor",
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.245Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6429"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6424"
          }
        ],
        "readAtMs": 1792983150328,
        "epoch": "bfb9635bac9756cc35fb63c404d43bd73397847e2f88813672ed03c21f7adc45"
      },
      "after": {
        "raw": {
          "workspace_id": "p001-plan-lexical",
          "harness_slug": "p001-plan-lexical-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": "successor",
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.245Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6429"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6424"
          }
        ],
        "readAtMs": 1792983150335,
        "epoch": "bfb9635bac9756cc35fb63c404d43bd73397847e2f88813672ed03c21f7adc45"
      },
      "rows": [],
      "expectedIds": [],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "bfb9635bac9756cc35fb63c404d43bd73397847e2f88813672ed03c21f7adc45",
              "sourceRevision": "6429",
              "readAtMs": 1792983150335
            },
            "requestStartedAtMs": 1792983150326,
            "responseAtMs": 1792983150333
          },
          "oracle": null
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cec672ef897d9634381f0b12f3cfa3747019ddaa992e8c96b4550fdf9cf22113",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "bfb9635bac9756cc35fb63c404d43bd73397847e2f88813672ed03c21f7adc45",
              "sourceRevision": "6429",
              "readAtMs": 1792983150335
            },
            "requestStartedAtMs": 1792983150326,
            "responseAtMs": 1792983150333
          },
          "oracle": null
        },
        {
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "a252bcedf5a45ed6e7785b133aae8f5e9bde41f790f9f7c6850a1ba6f206677c",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "bfb9635bac9756cc35fb63c404d43bd73397847e2f88813672ed03c21f7adc45",
              "sourceRevision": "6429",
              "readAtMs": 1792983150335
            },
            "requestStartedAtMs": 1792983150326,
            "responseAtMs": 1792983150333
          },
          "oracle": null
        }
      ]
    },
    {
      "caseId": "plan/lexical",
      "phase": "superseded-explicit-historical",
      "before": {
        "raw": {
          "workspace_id": "p001-plan-lexical",
          "harness_slug": "p001-plan-lexical-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": "successor",
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.245Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6429"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6424"
          }
        ],
        "readAtMs": 1792983150337,
        "epoch": "f9b433376f39f9f76d6e215d8dc2ae7ac7b7278686852b55a2a4cd562970b35d"
      },
      "after": {
        "raw": {
          "workspace_id": "p001-plan-lexical",
          "harness_slug": "p001-plan-lexical-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": "successor",
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.245Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6429"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6424"
          }
        ],
        "readAtMs": 1792983150344,
        "epoch": "f9b433376f39f9f76d6e215d8dc2ae7ac7b7278686852b55a2a4cd562970b35d"
      },
      "rows": [
        {
          "key": "plan:p001-plan-lexical-harness:target",
          "score": 0.10000000149011612,
          "row": {
            "source": "plan",
            "source_id": "p001-plan-lexical-harness:target",
            "scope": "harness:p001-plan-lexical-harness",
            "ts": "2026-10-26T02:52:30.245Z",
            "excerpt": "Canonical plan\nzephyrplanwitness replacement canonical tasks",
            "highlight": "<mark>zephyrplanwitness</mark> replacement canonical tasks",
            "score": 0.10000000149011612,
            "rankers": [
              "lexical"
            ],
            "meta": {
              "title": "Canonical plan",
              "section": null,
              "status": "historical",
              "currentness": "historical",
              "path": "/admin/plans?plan=target&harness=p001-plan-lexical-harness"
            }
          }
        }
      ],
      "expectedIds": [
        "p001-plan-lexical-harness:target"
      ],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "f9b433376f39f9f76d6e215d8dc2ae7ac7b7278686852b55a2a4cd562970b35d",
              "sourceRevision": "6429",
              "readAtMs": 1792983150344
            },
            "requestStartedAtMs": 1792983150335,
            "responseAtMs": 1792983150343
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
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cec672ef897d9634381f0b12f3cfa3747019ddaa992e8c96b4550fdf9cf22113"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cec672ef897d9634381f0b12f3cfa3747019ddaa992e8c96b4550fdf9cf22113",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "f9b433376f39f9f76d6e215d8dc2ae7ac7b7278686852b55a2a4cd562970b35d",
              "sourceRevision": "6429",
              "readAtMs": 1792983150344
            },
            "requestStartedAtMs": 1792983150335,
            "responseAtMs": 1792983150343
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
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "a252bcedf5a45ed6e7785b133aae8f5e9bde41f790f9f7c6850a1ba6f206677c"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "a252bcedf5a45ed6e7785b133aae8f5e9bde41f790f9f7c6850a1ba6f206677c",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "f9b433376f39f9f76d6e215d8dc2ae7ac7b7278686852b55a2a4cd562970b35d",
              "sourceRevision": "6429",
              "readAtMs": 1792983150344
            },
            "requestStartedAtMs": 1792983150335,
            "responseAtMs": 1792983150343
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
      "caseId": "plan/lexical",
      "phase": "template-automatic-refusal",
      "before": {
        "raw": {
          "workspace_id": "p001-plan-lexical",
          "harness_slug": "p001-plan-lexical-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": "rubric",
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.245Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6430"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6424"
          }
        ],
        "readAtMs": 1792983150347,
        "epoch": "7b3140624185e16d2ce34e4f81b46ec0ba67be36259b54c43dc0d53f9321019b"
      },
      "after": {
        "raw": {
          "workspace_id": "p001-plan-lexical",
          "harness_slug": "p001-plan-lexical-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": "rubric",
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.245Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6430"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6424"
          }
        ],
        "readAtMs": 1792983150354,
        "epoch": "7b3140624185e16d2ce34e4f81b46ec0ba67be36259b54c43dc0d53f9321019b"
      },
      "rows": [],
      "expectedIds": [],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "7b3140624185e16d2ce34e4f81b46ec0ba67be36259b54c43dc0d53f9321019b",
              "sourceRevision": "6430",
              "readAtMs": 1792983150354
            },
            "requestStartedAtMs": 1792983150346,
            "responseAtMs": 1792983150352
          },
          "oracle": null
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cec672ef897d9634381f0b12f3cfa3747019ddaa992e8c96b4550fdf9cf22113",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "7b3140624185e16d2ce34e4f81b46ec0ba67be36259b54c43dc0d53f9321019b",
              "sourceRevision": "6430",
              "readAtMs": 1792983150354
            },
            "requestStartedAtMs": 1792983150346,
            "responseAtMs": 1792983150352
          },
          "oracle": null
        },
        {
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-lexical-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "a252bcedf5a45ed6e7785b133aae8f5e9bde41f790f9f7c6850a1ba6f206677c",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "7b3140624185e16d2ce34e4f81b46ec0ba67be36259b54c43dc0d53f9321019b",
              "sourceRevision": "6430",
              "readAtMs": 1792983150354
            },
            "requestStartedAtMs": 1792983150346,
            "responseAtMs": 1792983150352
          },
          "oracle": null
        }
      ]
    },
    {
      "caseId": "plan/lexical",
      "phase": "draft-items-replaced",
      "draft": [
        {
          "key": "plan:p001-plan-lexical-harness:target#P-001",
          "score": 0.10000000149011612,
          "row": {
            "source": "plan",
            "source_id": "p001-plan-lexical-harness:target#P-001",
            "scope": "p001-plan-lexical-harness",
            "excerpt": "zephyrplanwitness original item",
            "highlight": "zephyrplanwitness original item",
            "score": 0.10000000149011612,
            "rankers": [
              "lexical"
            ],
            "meta": {
              "title": "zephyrplanwitness original item",
              "planTitle": "Canonical plan",
              "status": "draft",
              "planSlug": "target",
              "itemId": "P-001",
              "itemStatus": "todo",
              "path": "/admin/plans?plan=target&harness=p001-plan-lexical-harness"
            }
          }
        }
      ],
      "revisedDraft": [
        {
          "key": "plan:p001-plan-lexical-harness:target#P-002",
          "score": 0.10000000149011612,
          "row": {
            "source": "plan",
            "source_id": "p001-plan-lexical-harness:target#P-002",
            "scope": "p001-plan-lexical-harness",
            "excerpt": "zephyrplanwitness replacement item",
            "highlight": "zephyrplanwitness replacement item",
            "score": 0.10000000149011612,
            "rankers": [
              "lexical"
            ],
            "meta": {
              "title": "zephyrplanwitness replacement item",
              "planTitle": "Canonical plan",
              "status": "draft",
              "planSlug": "target",
              "itemId": "P-002",
              "itemStatus": "todo",
              "path": "/admin/plans?plan=target&harness=p001-plan-lexical-harness"
            }
          }
        }
      ]
    },
    {
      "caseId": "plan/embedding",
      "phase": "stored-and-indexed",
      "before": {
        "raw": {
          "workspace_id": "p001-plan-embedding",
          "harness_slug": "p001-plan-embedding-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness original canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.383Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'origin':4 'plan':2 'task':6 'zephyrplanwit':3",
          "revision": "6434"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness original canonical tasks",
            "parent_sha": "5e2355b8df9ede58df26d33c9c959a955daf2816e1c39d1ae2418a7e619ba08e",
            "chunk_sha": "33d98978eb850d76c5aca538e2caad24ae0e841949fb395dae11a1bbd28e6705",
            "revision": "6435"
          }
        ],
        "readAtMs": 1792983150404,
        "epoch": "3e13d3a26406b2d7f2b7dae6945b4b314101890f48f00418586f321a13f47ea3"
      },
      "after": {
        "raw": {
          "workspace_id": "p001-plan-embedding",
          "harness_slug": "p001-plan-embedding-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness original canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.383Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'origin':4 'plan':2 'task':6 'zephyrplanwit':3",
          "revision": "6434"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness original canonical tasks",
            "parent_sha": "5e2355b8df9ede58df26d33c9c959a955daf2816e1c39d1ae2418a7e619ba08e",
            "chunk_sha": "33d98978eb850d76c5aca538e2caad24ae0e841949fb395dae11a1bbd28e6705",
            "revision": "6435"
          }
        ],
        "readAtMs": 1792983150408,
        "epoch": "3e13d3a26406b2d7f2b7dae6945b4b314101890f48f00418586f321a13f47ea3"
      },
      "rows": [
        {
          "key": "plan:p001-plan-embedding-harness:target",
          "score": 0.98,
          "row": {
            "source": "plan",
            "source_id": "p001-plan-embedding-harness:target",
            "scope": "harness:p001-plan-embedding-harness",
            "ts": "2026-10-26T02:52:30.383Z",
            "excerpt": "Canonical plan\nzephyrplanwitness original canonical tasks",
            "highlight": "zephyrplanwitness original canonical tasks",
            "score": 0.98,
            "rankers": [
              "embeddings"
            ],
            "meta": {
              "title": "Canonical plan",
              "section": null,
              "status": "ready",
              "currentness": "plan",
              "path": "/admin/plans?plan=target&harness=p001-plan-embedding-harness"
            }
          }
        }
      ],
      "expectedIds": [
        "p001-plan-embedding-harness:target"
      ],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "a0c5546d4695dc94f7cf97c54f391d23f87c712b59a438fd216a4dd0a362e543"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "a0c5546d4695dc94f7cf97c54f391d23f87c712b59a438fd216a4dd0a362e543",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "3e13d3a26406b2d7f2b7dae6945b4b314101890f48f00418586f321a13f47ea3",
              "sourceRevision": "6434",
              "readAtMs": 1792983150408
            },
            "requestStartedAtMs": 1792983150403,
            "responseAtMs": 1792983150407
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
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "33d98978eb850d76c5aca538e2caad24ae0e841949fb395dae11a1bbd28e6705"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "33d98978eb850d76c5aca538e2caad24ae0e841949fb395dae11a1bbd28e6705",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "3e13d3a26406b2d7f2b7dae6945b4b314101890f48f00418586f321a13f47ea3",
              "sourceRevision": "6434",
              "readAtMs": 1792983150408
            },
            "requestStartedAtMs": 1792983150403,
            "responseAtMs": 1792983150407
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
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "33383c12588d5d7db3925c290184b2c06d8757299f3bd4d91b0e8c2141adf2f1"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "33383c12588d5d7db3925c290184b2c06d8757299f3bd4d91b0e8c2141adf2f1",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "3e13d3a26406b2d7f2b7dae6945b4b314101890f48f00418586f321a13f47ea3",
              "sourceRevision": "6434",
              "readAtMs": 1792983150408
            },
            "requestStartedAtMs": 1792983150403,
            "responseAtMs": 1792983150407
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
      "caseId": "plan/embedding",
      "phase": "canonical-content-changed-before-reindex",
      "before": {
        "raw": {
          "workspace_id": "p001-plan-embedding",
          "harness_slug": "p001-plan-embedding-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.410Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6440"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness original canonical tasks",
            "parent_sha": "5e2355b8df9ede58df26d33c9c959a955daf2816e1c39d1ae2418a7e619ba08e",
            "chunk_sha": "33d98978eb850d76c5aca538e2caad24ae0e841949fb395dae11a1bbd28e6705",
            "revision": "6435"
          }
        ],
        "readAtMs": 1792983150411,
        "epoch": "3e13d3a26406b2d7f2b7dae6945b4b314101890f48f00418586f321a13f47ea3"
      },
      "after": {
        "raw": {
          "workspace_id": "p001-plan-embedding",
          "harness_slug": "p001-plan-embedding-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.410Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6440"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness original canonical tasks",
            "parent_sha": "5e2355b8df9ede58df26d33c9c959a955daf2816e1c39d1ae2418a7e619ba08e",
            "chunk_sha": "33d98978eb850d76c5aca538e2caad24ae0e841949fb395dae11a1bbd28e6705",
            "revision": "6435"
          }
        ],
        "readAtMs": 1792983150415,
        "epoch": "3e13d3a26406b2d7f2b7dae6945b4b314101890f48f00418586f321a13f47ea3"
      },
      "rows": [
        {
          "key": "plan:p001-plan-embedding-harness:target",
          "score": 0.98,
          "row": {
            "source": "plan",
            "source_id": "p001-plan-embedding-harness:target",
            "scope": "harness:p001-plan-embedding-harness",
            "ts": "2026-10-26T02:52:30.410Z",
            "excerpt": "Canonical plan\nzephyrplanwitness original canonical tasks",
            "highlight": "zephyrplanwitness original canonical tasks",
            "score": 0.98,
            "rankers": [
              "embeddings"
            ],
            "meta": {
              "title": "Canonical plan",
              "section": null,
              "status": "ready",
              "currentness": "plan",
              "path": "/admin/plans?plan=target&harness=p001-plan-embedding-harness"
            }
          }
        }
      ],
      "expectedIds": [
        "p001-plan-embedding-harness:target"
      ],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "a0c5546d4695dc94f7cf97c54f391d23f87c712b59a438fd216a4dd0a362e543"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "3e13d3a26406b2d7f2b7dae6945b4b314101890f48f00418586f321a13f47ea3",
              "sourceRevision": "6440",
              "readAtMs": 1792983150415
            },
            "requestStartedAtMs": 1792983150410,
            "responseAtMs": 1792983150414
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
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "33d98978eb850d76c5aca538e2caad24ae0e841949fb395dae11a1bbd28e6705"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "3e13d3a26406b2d7f2b7dae6945b4b314101890f48f00418586f321a13f47ea3",
              "sourceRevision": "6440",
              "readAtMs": 1792983150415
            },
            "requestStartedAtMs": 1792983150410,
            "responseAtMs": 1792983150414
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
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "c3dc99586799988815b67329d0576080ca2dbcd30ccbce86ca9a3349a3240be0"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "c3dc99586799988815b67329d0576080ca2dbcd30ccbce86ca9a3349a3240be0",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "3e13d3a26406b2d7f2b7dae6945b4b314101890f48f00418586f321a13f47ea3",
              "sourceRevision": "6440",
              "readAtMs": 1792983150415
            },
            "requestStartedAtMs": 1792983150410,
            "responseAtMs": 1792983150414
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
      "caseId": "plan/embedding",
      "phase": "canonical-content-reindexed",
      "before": {
        "raw": {
          "workspace_id": "p001-plan-embedding",
          "harness_slug": "p001-plan-embedding-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.410Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6440"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6441"
          }
        ],
        "readAtMs": 1792983150418,
        "epoch": "3e13d3a26406b2d7f2b7dae6945b4b314101890f48f00418586f321a13f47ea3"
      },
      "after": {
        "raw": {
          "workspace_id": "p001-plan-embedding",
          "harness_slug": "p001-plan-embedding-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.410Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6440"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6441"
          }
        ],
        "readAtMs": 1792983150425,
        "epoch": "3e13d3a26406b2d7f2b7dae6945b4b314101890f48f00418586f321a13f47ea3"
      },
      "rows": [
        {
          "key": "plan:p001-plan-embedding-harness:target",
          "score": 0.98,
          "row": {
            "source": "plan",
            "source_id": "p001-plan-embedding-harness:target",
            "scope": "harness:p001-plan-embedding-harness",
            "ts": "2026-10-26T02:52:30.410Z",
            "excerpt": "Canonical plan\nzephyrplanwitness replacement canonical tasks",
            "highlight": "zephyrplanwitness replacement canonical tasks",
            "score": 0.98,
            "rankers": [
              "embeddings"
            ],
            "meta": {
              "title": "Canonical plan",
              "section": null,
              "status": "ready",
              "currentness": "plan",
              "path": "/admin/plans?plan=target&harness=p001-plan-embedding-harness"
            }
          }
        }
      ],
      "expectedIds": [
        "p001-plan-embedding-harness:target"
      ],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "3e13d3a26406b2d7f2b7dae6945b4b314101890f48f00418586f321a13f47ea3",
              "sourceRevision": "6440",
              "readAtMs": 1792983150425
            },
            "requestStartedAtMs": 1792983150417,
            "responseAtMs": 1792983150424
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
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "3e13d3a26406b2d7f2b7dae6945b4b314101890f48f00418586f321a13f47ea3",
              "sourceRevision": "6440",
              "readAtMs": 1792983150425
            },
            "requestStartedAtMs": 1792983150417,
            "responseAtMs": 1792983150424
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
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "c3dc99586799988815b67329d0576080ca2dbcd30ccbce86ca9a3349a3240be0"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "c3dc99586799988815b67329d0576080ca2dbcd30ccbce86ca9a3349a3240be0",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "3e13d3a26406b2d7f2b7dae6945b4b314101890f48f00418586f321a13f47ea3",
              "sourceRevision": "6440",
              "readAtMs": 1792983150425
            },
            "requestStartedAtMs": 1792983150417,
            "responseAtMs": 1792983150424
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
      "caseId": "plan/embedding",
      "phase": "candidate-added",
      "before": {
        "raw": {
          "workspace_id": "p001-plan-embedding",
          "harness_slug": "p001-plan-embedding-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.410Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6440"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6441"
          }
        ],
        "readAtMs": 1792983150428,
        "epoch": "3e13d3a26406b2d7f2b7dae6945b4b314101890f48f00418586f321a13f47ea3"
      },
      "after": {
        "raw": {
          "workspace_id": "p001-plan-embedding",
          "harness_slug": "p001-plan-embedding-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.410Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6440"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6441"
          }
        ],
        "readAtMs": 1792983150434,
        "epoch": "3e13d3a26406b2d7f2b7dae6945b4b314101890f48f00418586f321a13f47ea3"
      },
      "rows": [
        {
          "key": "plan:p001-plan-embedding-harness:added",
          "score": 0.98,
          "row": {
            "source": "plan",
            "source_id": "p001-plan-embedding-harness:added",
            "scope": "harness:p001-plan-embedding-harness",
            "ts": "2026-10-26T02:52:30.426Z",
            "excerpt": "Canonical plan\nzephyrplanwitness original canonical tasks",
            "highlight": "zephyrplanwitness original canonical tasks",
            "score": 0.98,
            "rankers": [
              "embeddings"
            ],
            "meta": {
              "title": "Canonical plan",
              "section": null,
              "status": "ready",
              "currentness": "plan",
              "path": "/admin/plans?plan=added&harness=p001-plan-embedding-harness"
            }
          }
        },
        {
          "key": "plan:p001-plan-embedding-harness:target",
          "score": 0.98,
          "row": {
            "source": "plan",
            "source_id": "p001-plan-embedding-harness:target",
            "scope": "harness:p001-plan-embedding-harness",
            "ts": "2026-10-26T02:52:30.410Z",
            "excerpt": "Canonical plan\nzephyrplanwitness replacement canonical tasks",
            "highlight": "zephyrplanwitness replacement canonical tasks",
            "score": 0.98,
            "rankers": [
              "embeddings"
            ],
            "meta": {
              "title": "Canonical plan",
              "section": null,
              "status": "ready",
              "currentness": "plan",
              "path": "/admin/plans?plan=target&harness=p001-plan-embedding-harness"
            }
          }
        }
      ],
      "expectedIds": [
        "p001-plan-embedding-harness:target",
        "p001-plan-embedding-harness:added"
      ],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "3e13d3a26406b2d7f2b7dae6945b4b314101890f48f00418586f321a13f47ea3",
              "sourceRevision": "6440",
              "readAtMs": 1792983150434
            },
            "requestStartedAtMs": 1792983150427,
            "responseAtMs": 1792983150432
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
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "3e13d3a26406b2d7f2b7dae6945b4b314101890f48f00418586f321a13f47ea3",
              "sourceRevision": "6440",
              "readAtMs": 1792983150434
            },
            "requestStartedAtMs": 1792983150427,
            "responseAtMs": 1792983150432
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
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "c3dc99586799988815b67329d0576080ca2dbcd30ccbce86ca9a3349a3240be0"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "c3dc99586799988815b67329d0576080ca2dbcd30ccbce86ca9a3349a3240be0",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "3e13d3a26406b2d7f2b7dae6945b4b314101890f48f00418586f321a13f47ea3",
              "sourceRevision": "6440",
              "readAtMs": 1792983150434
            },
            "requestStartedAtMs": 1792983150427,
            "responseAtMs": 1792983150432
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
      "caseId": "plan/embedding",
      "phase": "candidate-deleted-despite-retained-chunk",
      "before": {
        "raw": {
          "workspace_id": "p001-plan-embedding",
          "harness_slug": "p001-plan-embedding-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.410Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6440"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6441"
          }
        ],
        "readAtMs": 1792983150436,
        "epoch": "3e13d3a26406b2d7f2b7dae6945b4b314101890f48f00418586f321a13f47ea3"
      },
      "after": {
        "raw": {
          "workspace_id": "p001-plan-embedding",
          "harness_slug": "p001-plan-embedding-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.410Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6440"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6441"
          }
        ],
        "readAtMs": 1792983150441,
        "epoch": "3e13d3a26406b2d7f2b7dae6945b4b314101890f48f00418586f321a13f47ea3"
      },
      "rows": [
        {
          "key": "plan:p001-plan-embedding-harness:target",
          "score": 0.98,
          "row": {
            "source": "plan",
            "source_id": "p001-plan-embedding-harness:target",
            "scope": "harness:p001-plan-embedding-harness",
            "ts": "2026-10-26T02:52:30.410Z",
            "excerpt": "Canonical plan\nzephyrplanwitness replacement canonical tasks",
            "highlight": "zephyrplanwitness replacement canonical tasks",
            "score": 0.98,
            "rankers": [
              "embeddings"
            ],
            "meta": {
              "title": "Canonical plan",
              "section": null,
              "status": "ready",
              "currentness": "plan",
              "path": "/admin/plans?plan=target&harness=p001-plan-embedding-harness"
            }
          }
        }
      ],
      "expectedIds": [
        "p001-plan-embedding-harness:target"
      ],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "3e13d3a26406b2d7f2b7dae6945b4b314101890f48f00418586f321a13f47ea3",
              "sourceRevision": "6440",
              "readAtMs": 1792983150441
            },
            "requestStartedAtMs": 1792983150435,
            "responseAtMs": 1792983150440
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
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "3e13d3a26406b2d7f2b7dae6945b4b314101890f48f00418586f321a13f47ea3",
              "sourceRevision": "6440",
              "readAtMs": 1792983150441
            },
            "requestStartedAtMs": 1792983150435,
            "responseAtMs": 1792983150440
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
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "c3dc99586799988815b67329d0576080ca2dbcd30ccbce86ca9a3349a3240be0"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "c3dc99586799988815b67329d0576080ca2dbcd30ccbce86ca9a3349a3240be0",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "3e13d3a26406b2d7f2b7dae6945b4b314101890f48f00418586f321a13f47ea3",
              "sourceRevision": "6440",
              "readAtMs": 1792983150441
            },
            "requestStartedAtMs": 1792983150435,
            "responseAtMs": 1792983150440
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
      "caseId": "plan/embedding",
      "phase": "audience-excluded",
      "before": {
        "raw": {
          "workspace_id": "p001-plan-embedding",
          "harness_slug": "p001-plan-embedding-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.410Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6440"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6441"
          }
        ],
        "readAtMs": 1792983150442,
        "epoch": "92151c8de7dde3be82e1c969541aacfa79689af032b96730e187879ec22eca29"
      },
      "after": {
        "raw": {
          "workspace_id": "p001-plan-embedding",
          "harness_slug": "p001-plan-embedding-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.410Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6440"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6441"
          }
        ],
        "readAtMs": 1792983150447,
        "epoch": "92151c8de7dde3be82e1c969541aacfa79689af032b96730e187879ec22eca29"
      },
      "rows": [],
      "expectedIds": [],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "92151c8de7dde3be82e1c969541aacfa79689af032b96730e187879ec22eca29",
              "sourceRevision": "6440",
              "readAtMs": 1792983150447
            },
            "requestStartedAtMs": 1792983150441,
            "responseAtMs": 1792983150446
          },
          "oracle": null
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "92151c8de7dde3be82e1c969541aacfa79689af032b96730e187879ec22eca29",
              "sourceRevision": "6440",
              "readAtMs": 1792983150447
            },
            "requestStartedAtMs": 1792983150441,
            "responseAtMs": 1792983150446
          },
          "oracle": null
        },
        {
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "c3dc99586799988815b67329d0576080ca2dbcd30ccbce86ca9a3349a3240be0",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "92151c8de7dde3be82e1c969541aacfa79689af032b96730e187879ec22eca29",
              "sourceRevision": "6440",
              "readAtMs": 1792983150447
            },
            "requestStartedAtMs": 1792983150441,
            "responseAtMs": 1792983150446
          },
          "oracle": null
        }
      ]
    },
    {
      "caseId": "plan/embedding",
      "phase": "server-harness-fence",
      "before": {
        "raw": {
          "workspace_id": "p001-plan-embedding",
          "harness_slug": "p001-plan-embedding-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.410Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6440"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6441"
          }
        ],
        "readAtMs": 1792983150448,
        "epoch": "3690302a5e54932e0c1a22547353aa6dca39543e5828d4eb4b2285e3fc2ff69b"
      },
      "after": {
        "raw": {
          "workspace_id": "p001-plan-embedding",
          "harness_slug": "p001-plan-embedding-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.410Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6440"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6441"
          }
        ],
        "readAtMs": 1792983150452,
        "epoch": "3690302a5e54932e0c1a22547353aa6dca39543e5828d4eb4b2285e3fc2ff69b"
      },
      "rows": [],
      "expectedIds": [],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "3690302a5e54932e0c1a22547353aa6dca39543e5828d4eb4b2285e3fc2ff69b",
              "sourceRevision": "6440",
              "readAtMs": 1792983150452
            },
            "requestStartedAtMs": 1792983150447,
            "responseAtMs": 1792983150451
          },
          "oracle": null
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "3690302a5e54932e0c1a22547353aa6dca39543e5828d4eb4b2285e3fc2ff69b",
              "sourceRevision": "6440",
              "readAtMs": 1792983150452
            },
            "requestStartedAtMs": 1792983150447,
            "responseAtMs": 1792983150451
          },
          "oracle": null
        },
        {
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "c3dc99586799988815b67329d0576080ca2dbcd30ccbce86ca9a3349a3240be0",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "3690302a5e54932e0c1a22547353aa6dca39543e5828d4eb4b2285e3fc2ff69b",
              "sourceRevision": "6440",
              "readAtMs": 1792983150452
            },
            "requestStartedAtMs": 1792983150447,
            "responseAtMs": 1792983150451
          },
          "oracle": null
        }
      ]
    },
    {
      "caseId": "plan/embedding",
      "phase": "archived-automatic-refusal",
      "before": {
        "raw": {
          "workspace_id": "p001-plan-embedding",
          "harness_slug": "p001-plan-embedding-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": true,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.410Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6445"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6441"
          }
        ],
        "readAtMs": 1792983150453,
        "epoch": "f00600586620608bfe321e614c6904415d7c23f674b84388a06f849657e9866c"
      },
      "after": {
        "raw": {
          "workspace_id": "p001-plan-embedding",
          "harness_slug": "p001-plan-embedding-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": true,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.410Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6445"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6441"
          }
        ],
        "readAtMs": 1792983150458,
        "epoch": "f00600586620608bfe321e614c6904415d7c23f674b84388a06f849657e9866c"
      },
      "rows": [],
      "expectedIds": [],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "f00600586620608bfe321e614c6904415d7c23f674b84388a06f849657e9866c",
              "sourceRevision": "6445",
              "readAtMs": 1792983150458
            },
            "requestStartedAtMs": 1792983150452,
            "responseAtMs": 1792983150457
          },
          "oracle": null
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "f00600586620608bfe321e614c6904415d7c23f674b84388a06f849657e9866c",
              "sourceRevision": "6445",
              "readAtMs": 1792983150458
            },
            "requestStartedAtMs": 1792983150452,
            "responseAtMs": 1792983150457
          },
          "oracle": null
        },
        {
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "c3dc99586799988815b67329d0576080ca2dbcd30ccbce86ca9a3349a3240be0",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "f00600586620608bfe321e614c6904415d7c23f674b84388a06f849657e9866c",
              "sourceRevision": "6445",
              "readAtMs": 1792983150458
            },
            "requestStartedAtMs": 1792983150452,
            "responseAtMs": 1792983150457
          },
          "oracle": null
        }
      ]
    },
    {
      "caseId": "plan/embedding",
      "phase": "archived-explicit-historical",
      "before": {
        "raw": {
          "workspace_id": "p001-plan-embedding",
          "harness_slug": "p001-plan-embedding-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": true,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.410Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6445"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6441"
          }
        ],
        "readAtMs": 1792983150459,
        "epoch": "ff339f28a8233f6fdfc35a3f2113b9e7ddd3fefdf5043fbaefe4028d09ac8663"
      },
      "after": {
        "raw": {
          "workspace_id": "p001-plan-embedding",
          "harness_slug": "p001-plan-embedding-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": true,
          "superseded_by": null,
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.410Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6445"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6441"
          }
        ],
        "readAtMs": 1792983150463,
        "epoch": "ff339f28a8233f6fdfc35a3f2113b9e7ddd3fefdf5043fbaefe4028d09ac8663"
      },
      "rows": [
        {
          "key": "plan:p001-plan-embedding-harness:target",
          "score": 0.98,
          "row": {
            "source": "plan",
            "source_id": "p001-plan-embedding-harness:target",
            "scope": "harness:p001-plan-embedding-harness",
            "ts": "2026-10-26T02:52:30.410Z",
            "excerpt": "Canonical plan\nzephyrplanwitness replacement canonical tasks",
            "highlight": "zephyrplanwitness replacement canonical tasks",
            "score": 0.98,
            "rankers": [
              "embeddings"
            ],
            "meta": {
              "title": "Canonical plan",
              "section": null,
              "status": "historical",
              "currentness": "historical",
              "path": "/admin/plans?plan=target&harness=p001-plan-embedding-harness"
            }
          }
        }
      ],
      "expectedIds": [
        "p001-plan-embedding-harness:target"
      ],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "ff339f28a8233f6fdfc35a3f2113b9e7ddd3fefdf5043fbaefe4028d09ac8663",
              "sourceRevision": "6445",
              "readAtMs": 1792983150463
            },
            "requestStartedAtMs": 1792983150458,
            "responseAtMs": 1792983150462
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
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "ff339f28a8233f6fdfc35a3f2113b9e7ddd3fefdf5043fbaefe4028d09ac8663",
              "sourceRevision": "6445",
              "readAtMs": 1792983150463
            },
            "requestStartedAtMs": 1792983150458,
            "responseAtMs": 1792983150462
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
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "c3dc99586799988815b67329d0576080ca2dbcd30ccbce86ca9a3349a3240be0"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "c3dc99586799988815b67329d0576080ca2dbcd30ccbce86ca9a3349a3240be0",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "ff339f28a8233f6fdfc35a3f2113b9e7ddd3fefdf5043fbaefe4028d09ac8663",
              "sourceRevision": "6445",
              "readAtMs": 1792983150463
            },
            "requestStartedAtMs": 1792983150458,
            "responseAtMs": 1792983150462
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
      "caseId": "plan/embedding",
      "phase": "superseded-automatic-refusal",
      "before": {
        "raw": {
          "workspace_id": "p001-plan-embedding",
          "harness_slug": "p001-plan-embedding-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": "successor",
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.410Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6446"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6441"
          }
        ],
        "readAtMs": 1792983150464,
        "epoch": "642601b4d9860e7df875753463c16d1b85f7e9241648b193f8baeb88075cc7f1"
      },
      "after": {
        "raw": {
          "workspace_id": "p001-plan-embedding",
          "harness_slug": "p001-plan-embedding-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": "successor",
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.410Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6446"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6441"
          }
        ],
        "readAtMs": 1792983150468,
        "epoch": "642601b4d9860e7df875753463c16d1b85f7e9241648b193f8baeb88075cc7f1"
      },
      "rows": [],
      "expectedIds": [],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "642601b4d9860e7df875753463c16d1b85f7e9241648b193f8baeb88075cc7f1",
              "sourceRevision": "6446",
              "readAtMs": 1792983150468
            },
            "requestStartedAtMs": 1792983150464,
            "responseAtMs": 1792983150467
          },
          "oracle": null
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "642601b4d9860e7df875753463c16d1b85f7e9241648b193f8baeb88075cc7f1",
              "sourceRevision": "6446",
              "readAtMs": 1792983150468
            },
            "requestStartedAtMs": 1792983150464,
            "responseAtMs": 1792983150467
          },
          "oracle": null
        },
        {
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "c3dc99586799988815b67329d0576080ca2dbcd30ccbce86ca9a3349a3240be0",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "642601b4d9860e7df875753463c16d1b85f7e9241648b193f8baeb88075cc7f1",
              "sourceRevision": "6446",
              "readAtMs": 1792983150468
            },
            "requestStartedAtMs": 1792983150464,
            "responseAtMs": 1792983150467
          },
          "oracle": null
        }
      ]
    },
    {
      "caseId": "plan/embedding",
      "phase": "superseded-explicit-historical",
      "before": {
        "raw": {
          "workspace_id": "p001-plan-embedding",
          "harness_slug": "p001-plan-embedding-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": "successor",
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.410Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6446"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6441"
          }
        ],
        "readAtMs": 1792983150469,
        "epoch": "4dac5b7eb6239bbf2fe6d508f6421e9e0cfbc9c6003b92ffb013ef17130d2435"
      },
      "after": {
        "raw": {
          "workspace_id": "p001-plan-embedding",
          "harness_slug": "p001-plan-embedding-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": "successor",
          "template_slug": null,
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.410Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6446"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6441"
          }
        ],
        "readAtMs": 1792983150472,
        "epoch": "4dac5b7eb6239bbf2fe6d508f6421e9e0cfbc9c6003b92ffb013ef17130d2435"
      },
      "rows": [
        {
          "key": "plan:p001-plan-embedding-harness:target",
          "score": 0.98,
          "row": {
            "source": "plan",
            "source_id": "p001-plan-embedding-harness:target",
            "scope": "harness:p001-plan-embedding-harness",
            "ts": "2026-10-26T02:52:30.410Z",
            "excerpt": "Canonical plan\nzephyrplanwitness replacement canonical tasks",
            "highlight": "zephyrplanwitness replacement canonical tasks",
            "score": 0.98,
            "rankers": [
              "embeddings"
            ],
            "meta": {
              "title": "Canonical plan",
              "section": null,
              "status": "historical",
              "currentness": "historical",
              "path": "/admin/plans?plan=target&harness=p001-plan-embedding-harness"
            }
          }
        }
      ],
      "expectedIds": [
        "p001-plan-embedding-harness:target"
      ],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "4dac5b7eb6239bbf2fe6d508f6421e9e0cfbc9c6003b92ffb013ef17130d2435",
              "sourceRevision": "6446",
              "readAtMs": 1792983150472
            },
            "requestStartedAtMs": 1792983150468,
            "responseAtMs": 1792983150471
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
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "4dac5b7eb6239bbf2fe6d508f6421e9e0cfbc9c6003b92ffb013ef17130d2435",
              "sourceRevision": "6446",
              "readAtMs": 1792983150472
            },
            "requestStartedAtMs": 1792983150468,
            "responseAtMs": 1792983150471
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
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "c3dc99586799988815b67329d0576080ca2dbcd30ccbce86ca9a3349a3240be0"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "c3dc99586799988815b67329d0576080ca2dbcd30ccbce86ca9a3349a3240be0",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "4dac5b7eb6239bbf2fe6d508f6421e9e0cfbc9c6003b92ffb013ef17130d2435",
              "sourceRevision": "6446",
              "readAtMs": 1792983150472
            },
            "requestStartedAtMs": 1792983150468,
            "responseAtMs": 1792983150471
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
      "caseId": "plan/embedding",
      "phase": "template-automatic-refusal",
      "before": {
        "raw": {
          "workspace_id": "p001-plan-embedding",
          "harness_slug": "p001-plan-embedding-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": "rubric",
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.410Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6447"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6441"
          }
        ],
        "readAtMs": 1792983150474,
        "epoch": "adc04a2b46180372b2df13706e7c42ed387992e020df0d9619b77c66c6a80cef"
      },
      "after": {
        "raw": {
          "workspace_id": "p001-plan-embedding",
          "harness_slug": "p001-plan-embedding-harness",
          "plan_slug": "target",
          "title": "Canonical plan",
          "content": "zephyrplanwitness replacement canonical tasks",
          "status": "ready",
          "archived": false,
          "superseded_by": null,
          "template_slug": "rubric",
          "items": [
            {
              "id": "P-001",
              "text": "zephyrplanwitness original item",
              "status": "todo"
            }
          ],
          "updated_at": "2026-10-26T02:52:30.410Z",
          "embedding": null,
          "embedding_mode": null,
          "embedding_profile": null,
          "_search": "'canon':1,5 'plan':2 'replac':4 'task':6 'zephyrplanwit':3",
          "revision": "6447"
        },
        "chunks": [
          {
            "content": "zephyrplanwitness replacement canonical tasks",
            "parent_sha": "dc4d6f9eb78e643744bd2ad5b6b9122ef9bdd95c5eb1d4834fbb2d7e67a7aa3e",
            "chunk_sha": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
            "revision": "6441"
          }
        ],
        "readAtMs": 1792983150477,
        "epoch": "adc04a2b46180372b2df13706e7c42ed387992e020df0d9619b77c66c6a80cef"
      },
      "rows": [],
      "expectedIds": [],
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "excerpt",
              "valueFingerprint": "425b614fcf8c84c392dce83b4f0a2052905dbcfc2f57f4fb484ad762716c944f",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "adc04a2b46180372b2df13706e7c42ed387992e020df0d9619b77c66c6a80cef",
              "sourceRevision": "6447",
              "readAtMs": 1792983150477
            },
            "requestStartedAtMs": 1792983150473,
            "responseAtMs": 1792983150476
          },
          "oracle": null
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "highlight",
              "valueFingerprint": "cea16e082d0c316a5c67275b17800290453cebd14e387f1faa8e32dae4530c4a",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "adc04a2b46180372b2df13706e7c42ed387992e020df0d9619b77c66c6a80cef",
              "sourceRevision": "6447",
              "readAtMs": 1792983150477
            },
            "requestStartedAtMs": 1792983150473,
            "responseAtMs": 1792983150476
          },
          "oracle": null
        },
        {
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "plan:p001-plan-embedding-harness:target",
              "fieldPath": "ts",
              "valueFingerprint": "c3dc99586799988815b67329d0576080ca2dbcd30ccbce86ca9a3349a3240be0",
              "authority": "harness_shared.harness_plans",
              "authorityEpoch": "adc04a2b46180372b2df13706e7c42ed387992e020df0d9619b77c66c6a80cef",
              "sourceRevision": "6447",
              "readAtMs": 1792983150477
            },
            "requestStartedAtMs": 1792983150473,
            "responseAtMs": 1792983150476
          },
          "oracle": null
        }
      ]
    },
    {
      "caseId": "plan/embedding",
      "phase": "draft-items-replaced",
      "draft": [
        {
          "key": "plan:p001-plan-embedding-harness:target#P-001",
          "score": 0.98,
          "row": {
            "source": "plan",
            "source_id": "p001-plan-embedding-harness:target#P-001",
            "scope": "p001-plan-embedding-harness",
            "excerpt": "zephyrplanwitness original item",
            "highlight": "zephyrplanwitness original item",
            "score": 0.98,
            "rankers": [
              "embeddings"
            ],
            "meta": {
              "title": "zephyrplanwitness original item",
              "planTitle": "Canonical plan",
              "status": "draft",
              "planSlug": "target",
              "itemId": "P-001",
              "itemStatus": "todo",
              "path": "/admin/plans?plan=target&harness=p001-plan-embedding-harness"
            }
          }
        }
      ],
      "revisedDraft": [
        {
          "key": "plan:p001-plan-embedding-harness:target#P-002",
          "score": 0.98,
          "row": {
            "source": "plan",
            "source_id": "p001-plan-embedding-harness:target#P-002",
            "scope": "p001-plan-embedding-harness",
            "excerpt": "zephyrplanwitness replacement item",
            "highlight": "zephyrplanwitness replacement item",
            "score": 0.98,
            "rankers": [
              "embeddings"
            ],
            "meta": {
              "title": "zephyrplanwitness replacement item",
              "planTitle": "Canonical plan",
              "status": "draft",
              "planSlug": "target",
              "itemId": "P-002",
              "itemStatus": "todo",
              "path": "/admin/plans?plan=target&harness=p001-plan-embedding-harness"
            }
          }
        }
      ]
    }
  ],
  "limits": [
    "Minimal private PostgreSQL schema and controlled row/chunk mutations; actual registered lexical and vector SQL readers.",
    "No production plan authoring, authentication, sync, embedder, candidate completeness or index-version witness.",
    "Canonical mismatches are stale; matching values remain unknown without an index witness.",
    "Draft item replacement is checked separately; no timestamp or field-currentness claim for draft-item output.",
    "Other adapters, budgets, quality, runtime acceptance and shipment remain open."
  ]
}
