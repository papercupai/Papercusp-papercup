---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/doc-source-20261025-a/witness.json"
updated_at: 1792966078142
_body: "content"
---

{
  "schemaVersion": 1,
  "population": [
    "doc/lexical",
    "doc/embedding"
  ],
  "completed": [
    "doc/lexical",
    "doc/embedding"
  ],
  "pins": [
    {
      "path": "packages/operator-core/lib/agent-tools/search/doc-source-freshness.integration.test.ts",
      "sha256": "dd2a9caa8d217c6c4ad051837ae56b1e562afefe916fed37f9dd335682ff0be0"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/search/knowledge-sources.ts",
      "sha256": "c1ce37b2dc299c219f61304b43aca5337c6ece87a714c2a1dd1ce0493d5b82d8"
    },
    {
      "path": "packages/operator-core/lib/search/doc-embed-sync.ts",
      "sha256": "f51ddc98e29533d3efeacabf78b7ba9444c608615853c20935be575ac1ba1078"
    },
    {
      "path": "packages/operator-core/lib/search/surface-registry.ts",
      "sha256": "53e3bd3fd49a1d3d2413d6486983715882f857d841117b7727f30a83dbf30e23"
    }
  ],
  "receipts": [
    {
      "caseId": "doc/lexical",
      "phase": "stored-source-synced",
      "before": {
        "title": "Original procedure",
        "body": "zephyrdocwitness original canonical instructions.",
        "revision": 1,
        "readAtMs": 1792965894588
      },
      "after": {
        "title": "Original procedure",
        "body": "zephyrdocwitness original canonical instructions.",
        "revision": 1,
        "readAtMs": 1792965894592
      },
      "rows": [
        {
          "key": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
          "score": 0.1,
          "row": {
            "source": "doc",
            "source_id": "harness:p001-doc-lexical-harness:p001-doc-lexical",
            "scope": "harness:p001-doc-lexical-harness",
            "ts": "2026-10-25T22:04:54.561Z",
            "excerpt": "Original procedure\nzephyrdocwitness original canonical instructions.",
            "highlight": "zephyrdocwitness original canonical instructions.",
            "score": 0.1,
            "rankers": [
              "lexical"
            ],
            "meta": {
              "title": "Original procedure",
              "section": null,
              "status": "maintained",
              "currentness": "maintained-procedure",
              "path": "/docs/p001-doc-lexical",
              "docSourceKey": "harness:p001-doc-lexical-harness"
            }
          }
        }
      ],
      "epoch": "c558972ba7b621fcc84ceea787a723911b55c2191e4ac993f6a849c3fb275520",
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "excerpt",
              "valueFingerprint": "ec9eef367a3128c07e7b7edb8ed3db91d01c8ac42a712e51e2472f5f1364ff01"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "excerpt",
              "valueFingerprint": "ec9eef367a3128c07e7b7edb8ed3db91d01c8ac42a712e51e2472f5f1364ff01",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "c558972ba7b621fcc84ceea787a723911b55c2191e4ac993f6a849c3fb275520",
              "sourceRevision": "1",
              "readAtMs": 1792965894592
            },
            "requestStartedAtMs": 1792965894588,
            "responseAtMs": 1792965894592
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
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "highlight",
              "valueFingerprint": "736ef128fc036a93ebab7708c0291100918debdad13c679bdf0caa035b82cd49"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "highlight",
              "valueFingerprint": "736ef128fc036a93ebab7708c0291100918debdad13c679bdf0caa035b82cd49",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "c558972ba7b621fcc84ceea787a723911b55c2191e4ac993f6a849c3fb275520",
              "sourceRevision": "1",
              "readAtMs": 1792965894592
            },
            "requestStartedAtMs": 1792965894588,
            "responseAtMs": 1792965894592
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
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "ts",
              "valueFingerprint": "842596fb9e9c4a018940c3a74a3cad0de81d3dcfda844fe9b593129b613d9daf"
            },
            "indexed": null,
            "canonical": null,
            "requestStartedAtMs": 1792965894588,
            "responseAtMs": 1792965894592
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable",
              "canonical authority unavailable"
            ]
          }
        }
      ]
    },
    {
      "caseId": "doc/lexical",
      "phase": "source-changed-cache-still-old",
      "before": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894598
      },
      "after": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894603
      },
      "rows": [
        {
          "key": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
          "score": 0.1,
          "row": {
            "source": "doc",
            "source_id": "harness:p001-doc-lexical-harness:p001-doc-lexical",
            "scope": "harness:p001-doc-lexical-harness",
            "ts": "2026-10-25T22:04:54.561Z",
            "excerpt": "Original procedure\nzephyrdocwitness original canonical instructions.",
            "highlight": "zephyrdocwitness original canonical instructions.",
            "score": 0.1,
            "rankers": [
              "lexical"
            ],
            "meta": {
              "title": "Original procedure",
              "section": null,
              "status": "maintained",
              "currentness": "maintained-procedure",
              "path": "/docs/p001-doc-lexical",
              "docSourceKey": "harness:p001-doc-lexical-harness"
            }
          }
        }
      ],
      "epoch": "c558972ba7b621fcc84ceea787a723911b55c2191e4ac993f6a849c3fb275520",
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "excerpt",
              "valueFingerprint": "ec9eef367a3128c07e7b7edb8ed3db91d01c8ac42a712e51e2472f5f1364ff01"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "excerpt",
              "valueFingerprint": "d8431579ee67ce46f82a16076c73637ca0d94501524d3ed128a2f5230e37b218",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "c558972ba7b621fcc84ceea787a723911b55c2191e4ac993f6a849c3fb275520",
              "sourceRevision": "2",
              "readAtMs": 1792965894603
            },
            "requestStartedAtMs": 1792965894597,
            "responseAtMs": 1792965894603
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
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "highlight",
              "valueFingerprint": "736ef128fc036a93ebab7708c0291100918debdad13c679bdf0caa035b82cd49"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "highlight",
              "valueFingerprint": "7ed543aa14ee7cc524726ce5bb222f7688bc642151a84c50c9e3490ec9552ad7",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "c558972ba7b621fcc84ceea787a723911b55c2191e4ac993f6a849c3fb275520",
              "sourceRevision": "2",
              "readAtMs": 1792965894603
            },
            "requestStartedAtMs": 1792965894597,
            "responseAtMs": 1792965894603
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
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "ts",
              "valueFingerprint": "842596fb9e9c4a018940c3a74a3cad0de81d3dcfda844fe9b593129b613d9daf"
            },
            "indexed": null,
            "canonical": null,
            "requestStartedAtMs": 1792965894597,
            "responseAtMs": 1792965894603
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable",
              "canonical authority unavailable"
            ]
          }
        }
      ]
    },
    {
      "caseId": "doc/lexical",
      "phase": "source-change-synced",
      "before": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894611
      },
      "after": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894614
      },
      "rows": [
        {
          "key": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
          "score": 0.1,
          "row": {
            "source": "doc",
            "source_id": "harness:p001-doc-lexical-harness:p001-doc-lexical",
            "scope": "harness:p001-doc-lexical-harness",
            "ts": "2026-10-25T22:04:54.607Z",
            "excerpt": "Revised procedure\nzephyrdocwitness replacement canonical instructions.",
            "highlight": "zephyrdocwitness replacement canonical instructions.",
            "score": 0.1,
            "rankers": [
              "lexical"
            ],
            "meta": {
              "title": "Revised procedure",
              "section": null,
              "status": "maintained",
              "currentness": "maintained-procedure",
              "path": "/docs/p001-doc-lexical",
              "docSourceKey": "harness:p001-doc-lexical-harness"
            }
          }
        }
      ],
      "epoch": "c558972ba7b621fcc84ceea787a723911b55c2191e4ac993f6a849c3fb275520",
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "excerpt",
              "valueFingerprint": "d8431579ee67ce46f82a16076c73637ca0d94501524d3ed128a2f5230e37b218"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "excerpt",
              "valueFingerprint": "d8431579ee67ce46f82a16076c73637ca0d94501524d3ed128a2f5230e37b218",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "c558972ba7b621fcc84ceea787a723911b55c2191e4ac993f6a849c3fb275520",
              "sourceRevision": "2",
              "readAtMs": 1792965894614
            },
            "requestStartedAtMs": 1792965894611,
            "responseAtMs": 1792965894614
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
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "highlight",
              "valueFingerprint": "7ed543aa14ee7cc524726ce5bb222f7688bc642151a84c50c9e3490ec9552ad7"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "highlight",
              "valueFingerprint": "7ed543aa14ee7cc524726ce5bb222f7688bc642151a84c50c9e3490ec9552ad7",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "c558972ba7b621fcc84ceea787a723911b55c2191e4ac993f6a849c3fb275520",
              "sourceRevision": "2",
              "readAtMs": 1792965894614
            },
            "requestStartedAtMs": 1792965894611,
            "responseAtMs": 1792965894614
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
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "ts",
              "valueFingerprint": "d08899e2f399ae86550c978f08aae8d67c434cf29a753e2959a82c40bff81ee3"
            },
            "indexed": null,
            "canonical": null,
            "requestStartedAtMs": 1792965894611,
            "responseAtMs": 1792965894614
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable",
              "canonical authority unavailable"
            ]
          }
        }
      ]
    },
    {
      "caseId": "doc/lexical",
      "phase": "candidate-added",
      "before": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894623
      },
      "after": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894628
      },
      "rows": [
        {
          "key": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
          "score": 0.1,
          "row": {
            "source": "doc",
            "source_id": "harness:p001-doc-lexical-harness:p001-doc-lexical",
            "scope": "harness:p001-doc-lexical-harness",
            "ts": "2026-10-25T22:04:54.607Z",
            "excerpt": "Revised procedure\nzephyrdocwitness replacement canonical instructions.",
            "highlight": "zephyrdocwitness replacement canonical instructions.",
            "score": 0.1,
            "rankers": [
              "lexical"
            ],
            "meta": {
              "title": "Revised procedure",
              "section": null,
              "status": "maintained",
              "currentness": "maintained-procedure",
              "path": "/docs/p001-doc-lexical",
              "docSourceKey": "harness:p001-doc-lexical-harness"
            }
          }
        },
        {
          "key": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical-added",
          "score": 0.1,
          "row": {
            "source": "doc",
            "source_id": "harness:p001-doc-lexical-harness:p001-doc-lexical-added",
            "scope": "harness:p001-doc-lexical-harness",
            "ts": "2026-10-25T22:04:54.618Z",
            "excerpt": "Added procedure\nzephyrdocwitness added canonical instructions.",
            "highlight": "zephyrdocwitness added canonical instructions.",
            "score": 0.1,
            "rankers": [
              "lexical"
            ],
            "meta": {
              "title": "Added procedure",
              "section": null,
              "status": "maintained",
              "currentness": "maintained-procedure",
              "path": "/docs/p001-doc-lexical-added",
              "docSourceKey": "harness:p001-doc-lexical-harness"
            }
          }
        }
      ],
      "epoch": "c558972ba7b621fcc84ceea787a723911b55c2191e4ac993f6a849c3fb275520",
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "excerpt",
              "valueFingerprint": "d8431579ee67ce46f82a16076c73637ca0d94501524d3ed128a2f5230e37b218"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "excerpt",
              "valueFingerprint": "d8431579ee67ce46f82a16076c73637ca0d94501524d3ed128a2f5230e37b218",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "c558972ba7b621fcc84ceea787a723911b55c2191e4ac993f6a849c3fb275520",
              "sourceRevision": "2",
              "readAtMs": 1792965894628
            },
            "requestStartedAtMs": 1792965894623,
            "responseAtMs": 1792965894628
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
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "highlight",
              "valueFingerprint": "7ed543aa14ee7cc524726ce5bb222f7688bc642151a84c50c9e3490ec9552ad7"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "highlight",
              "valueFingerprint": "7ed543aa14ee7cc524726ce5bb222f7688bc642151a84c50c9e3490ec9552ad7",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "c558972ba7b621fcc84ceea787a723911b55c2191e4ac993f6a849c3fb275520",
              "sourceRevision": "2",
              "readAtMs": 1792965894628
            },
            "requestStartedAtMs": 1792965894623,
            "responseAtMs": 1792965894628
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
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "ts",
              "valueFingerprint": "d08899e2f399ae86550c978f08aae8d67c434cf29a753e2959a82c40bff81ee3"
            },
            "indexed": null,
            "canonical": null,
            "requestStartedAtMs": 1792965894623,
            "responseAtMs": 1792965894628
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable",
              "canonical authority unavailable"
            ]
          }
        }
      ]
    },
    {
      "caseId": "doc/lexical",
      "phase": "candidate-pruned",
      "before": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894632
      },
      "after": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894636
      },
      "rows": [
        {
          "key": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
          "score": 0.1,
          "row": {
            "source": "doc",
            "source_id": "harness:p001-doc-lexical-harness:p001-doc-lexical",
            "scope": "harness:p001-doc-lexical-harness",
            "ts": "2026-10-25T22:04:54.607Z",
            "excerpt": "Revised procedure\nzephyrdocwitness replacement canonical instructions.",
            "highlight": "zephyrdocwitness replacement canonical instructions.",
            "score": 0.1,
            "rankers": [
              "lexical"
            ],
            "meta": {
              "title": "Revised procedure",
              "section": null,
              "status": "maintained",
              "currentness": "maintained-procedure",
              "path": "/docs/p001-doc-lexical",
              "docSourceKey": "harness:p001-doc-lexical-harness"
            }
          }
        }
      ],
      "epoch": "c558972ba7b621fcc84ceea787a723911b55c2191e4ac993f6a849c3fb275520",
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "excerpt",
              "valueFingerprint": "d8431579ee67ce46f82a16076c73637ca0d94501524d3ed128a2f5230e37b218"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "excerpt",
              "valueFingerprint": "d8431579ee67ce46f82a16076c73637ca0d94501524d3ed128a2f5230e37b218",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "c558972ba7b621fcc84ceea787a723911b55c2191e4ac993f6a849c3fb275520",
              "sourceRevision": "2",
              "readAtMs": 1792965894636
            },
            "requestStartedAtMs": 1792965894632,
            "responseAtMs": 1792965894636
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
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "highlight",
              "valueFingerprint": "7ed543aa14ee7cc524726ce5bb222f7688bc642151a84c50c9e3490ec9552ad7"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "highlight",
              "valueFingerprint": "7ed543aa14ee7cc524726ce5bb222f7688bc642151a84c50c9e3490ec9552ad7",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "c558972ba7b621fcc84ceea787a723911b55c2191e4ac993f6a849c3fb275520",
              "sourceRevision": "2",
              "readAtMs": 1792965894636
            },
            "requestStartedAtMs": 1792965894632,
            "responseAtMs": 1792965894636
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
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "ts",
              "valueFingerprint": "d08899e2f399ae86550c978f08aae8d67c434cf29a753e2959a82c40bff81ee3"
            },
            "indexed": null,
            "canonical": null,
            "requestStartedAtMs": 1792965894632,
            "responseAtMs": 1792965894636
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable",
              "canonical authority unavailable"
            ]
          }
        }
      ]
    },
    {
      "caseId": "doc/lexical",
      "phase": "audience-excluded",
      "before": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894638
      },
      "after": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894642
      },
      "rows": [],
      "epoch": "c558972ba7b621fcc84ceea787a723911b55c2191e4ac993f6a849c3fb275520",
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "excerpt",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "excerpt",
              "valueFingerprint": "d8431579ee67ce46f82a16076c73637ca0d94501524d3ed128a2f5230e37b218",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "c558972ba7b621fcc84ceea787a723911b55c2191e4ac993f6a849c3fb275520",
              "sourceRevision": "2",
              "readAtMs": 1792965894642
            },
            "requestStartedAtMs": 1792965894638,
            "responseAtMs": 1792965894642
          },
          "oracle": null
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "highlight",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "highlight",
              "valueFingerprint": "7ed543aa14ee7cc524726ce5bb222f7688bc642151a84c50c9e3490ec9552ad7",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "c558972ba7b621fcc84ceea787a723911b55c2191e4ac993f6a849c3fb275520",
              "sourceRevision": "2",
              "readAtMs": 1792965894642
            },
            "requestStartedAtMs": 1792965894638,
            "responseAtMs": 1792965894642
          },
          "oracle": null
        },
        {
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "ts",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": null,
            "requestStartedAtMs": 1792965894638,
            "responseAtMs": 1792965894642
          },
          "oracle": null
        }
      ]
    },
    {
      "caseId": "doc/lexical",
      "phase": "membership-revoked",
      "before": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894644
      },
      "after": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894647
      },
      "rows": [],
      "epoch": "856777257cb085df28457a3628ee153335b3670e9438c80212386bdaf7ef6a35",
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "excerpt",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "excerpt",
              "valueFingerprint": "d8431579ee67ce46f82a16076c73637ca0d94501524d3ed128a2f5230e37b218",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "856777257cb085df28457a3628ee153335b3670e9438c80212386bdaf7ef6a35",
              "sourceRevision": "2",
              "readAtMs": 1792965894647
            },
            "requestStartedAtMs": 1792965894644,
            "responseAtMs": 1792965894647
          },
          "oracle": null
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "highlight",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "highlight",
              "valueFingerprint": "7ed543aa14ee7cc524726ce5bb222f7688bc642151a84c50c9e3490ec9552ad7",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "856777257cb085df28457a3628ee153335b3670e9438c80212386bdaf7ef6a35",
              "sourceRevision": "2",
              "readAtMs": 1792965894647
            },
            "requestStartedAtMs": 1792965894644,
            "responseAtMs": 1792965894647
          },
          "oracle": null
        },
        {
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "ts",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": null,
            "requestStartedAtMs": 1792965894644,
            "responseAtMs": 1792965894647
          },
          "oracle": null
        }
      ]
    },
    {
      "caseId": "doc/lexical",
      "phase": "membership-restored",
      "before": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894650
      },
      "after": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894653
      },
      "rows": [
        {
          "key": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
          "score": 0.1,
          "row": {
            "source": "doc",
            "source_id": "harness:p001-doc-lexical-harness:p001-doc-lexical",
            "scope": "harness:p001-doc-lexical-harness",
            "ts": "2026-10-25T22:04:54.607Z",
            "excerpt": "Revised procedure\nzephyrdocwitness replacement canonical instructions.",
            "highlight": "zephyrdocwitness replacement canonical instructions.",
            "score": 0.1,
            "rankers": [
              "lexical"
            ],
            "meta": {
              "title": "Revised procedure",
              "section": null,
              "status": "maintained",
              "currentness": "maintained-procedure",
              "path": "/docs/p001-doc-lexical",
              "docSourceKey": "harness:p001-doc-lexical-harness"
            }
          }
        }
      ],
      "epoch": "c558972ba7b621fcc84ceea787a723911b55c2191e4ac993f6a849c3fb275520",
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "excerpt",
              "valueFingerprint": "d8431579ee67ce46f82a16076c73637ca0d94501524d3ed128a2f5230e37b218"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "excerpt",
              "valueFingerprint": "d8431579ee67ce46f82a16076c73637ca0d94501524d3ed128a2f5230e37b218",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "c558972ba7b621fcc84ceea787a723911b55c2191e4ac993f6a849c3fb275520",
              "sourceRevision": "2",
              "readAtMs": 1792965894653
            },
            "requestStartedAtMs": 1792965894650,
            "responseAtMs": 1792965894653
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
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "highlight",
              "valueFingerprint": "7ed543aa14ee7cc524726ce5bb222f7688bc642151a84c50c9e3490ec9552ad7"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "highlight",
              "valueFingerprint": "7ed543aa14ee7cc524726ce5bb222f7688bc642151a84c50c9e3490ec9552ad7",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "c558972ba7b621fcc84ceea787a723911b55c2191e4ac993f6a849c3fb275520",
              "sourceRevision": "2",
              "readAtMs": 1792965894653
            },
            "requestStartedAtMs": 1792965894650,
            "responseAtMs": 1792965894653
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
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "ts",
              "valueFingerprint": "d08899e2f399ae86550c978f08aae8d67c434cf29a753e2959a82c40bff81ee3"
            },
            "indexed": null,
            "canonical": null,
            "requestStartedAtMs": 1792965894650,
            "responseAtMs": 1792965894653
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable",
              "canonical authority unavailable"
            ]
          }
        }
      ]
    },
    {
      "caseId": "doc/lexical",
      "phase": "canonical-retirement",
      "before": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894661
      },
      "after": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894665
      },
      "rows": [],
      "epoch": "8f74115941dce9451afaca87efd64abf47d54db4ba4d51c0e8a956c877f9d985",
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "excerpt",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "excerpt",
              "valueFingerprint": "d8431579ee67ce46f82a16076c73637ca0d94501524d3ed128a2f5230e37b218",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "8f74115941dce9451afaca87efd64abf47d54db4ba4d51c0e8a956c877f9d985",
              "sourceRevision": "2",
              "readAtMs": 1792965894665
            },
            "requestStartedAtMs": 1792965894661,
            "responseAtMs": 1792965894665
          },
          "oracle": null
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "highlight",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "highlight",
              "valueFingerprint": "7ed543aa14ee7cc524726ce5bb222f7688bc642151a84c50c9e3490ec9552ad7",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "8f74115941dce9451afaca87efd64abf47d54db4ba4d51c0e8a956c877f9d985",
              "sourceRevision": "2",
              "readAtMs": 1792965894665
            },
            "requestStartedAtMs": 1792965894661,
            "responseAtMs": 1792965894665
          },
          "oracle": null
        },
        {
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "ts",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": null,
            "requestStartedAtMs": 1792965894661,
            "responseAtMs": 1792965894665
          },
          "oracle": null
        }
      ]
    },
    {
      "caseId": "doc/lexical",
      "phase": "canonical-retirement-restored",
      "before": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894668
      },
      "after": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894670
      },
      "rows": [
        {
          "key": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
          "score": 0.1,
          "row": {
            "source": "doc",
            "source_id": "harness:p001-doc-lexical-harness:p001-doc-lexical",
            "scope": "harness:p001-doc-lexical-harness",
            "ts": "2026-10-25T22:04:54.607Z",
            "excerpt": "Revised procedure\nzephyrdocwitness replacement canonical instructions.",
            "highlight": "zephyrdocwitness replacement canonical instructions.",
            "score": 0.1,
            "rankers": [
              "lexical"
            ],
            "meta": {
              "title": "Revised procedure",
              "section": null,
              "status": "maintained",
              "currentness": "maintained-procedure",
              "path": "/docs/p001-doc-lexical",
              "docSourceKey": "harness:p001-doc-lexical-harness"
            }
          }
        }
      ],
      "epoch": "1d7a687cee5f5394fdd7f258885bb53561b8fd00d6e84dbf3b5bc4bcc374caa0",
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "excerpt",
              "valueFingerprint": "d8431579ee67ce46f82a16076c73637ca0d94501524d3ed128a2f5230e37b218"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "excerpt",
              "valueFingerprint": "d8431579ee67ce46f82a16076c73637ca0d94501524d3ed128a2f5230e37b218",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "1d7a687cee5f5394fdd7f258885bb53561b8fd00d6e84dbf3b5bc4bcc374caa0",
              "sourceRevision": "2",
              "readAtMs": 1792965894670
            },
            "requestStartedAtMs": 1792965894668,
            "responseAtMs": 1792965894670
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
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "highlight",
              "valueFingerprint": "7ed543aa14ee7cc524726ce5bb222f7688bc642151a84c50c9e3490ec9552ad7"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "highlight",
              "valueFingerprint": "7ed543aa14ee7cc524726ce5bb222f7688bc642151a84c50c9e3490ec9552ad7",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "1d7a687cee5f5394fdd7f258885bb53561b8fd00d6e84dbf3b5bc4bcc374caa0",
              "sourceRevision": "2",
              "readAtMs": 1792965894670
            },
            "requestStartedAtMs": 1792965894668,
            "responseAtMs": 1792965894670
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
              "entityRef": "doc:harness:p001-doc-lexical-harness:p001-doc-lexical",
              "fieldPath": "ts",
              "valueFingerprint": "d08899e2f399ae86550c978f08aae8d67c434cf29a753e2959a82c40bff81ee3"
            },
            "indexed": null,
            "canonical": null,
            "requestStartedAtMs": 1792965894668,
            "responseAtMs": 1792965894670
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable",
              "canonical authority unavailable"
            ]
          }
        }
      ]
    },
    {
      "caseId": "doc/embedding",
      "phase": "stored-source-synced",
      "before": {
        "title": "Original procedure",
        "body": "zephyrdocwitness original canonical instructions.",
        "revision": 1,
        "readAtMs": 1792965894685
      },
      "after": {
        "title": "Original procedure",
        "body": "zephyrdocwitness original canonical instructions.",
        "revision": 1,
        "readAtMs": 1792965894690
      },
      "rows": [
        {
          "key": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
          "score": 1,
          "row": {
            "source": "doc",
            "source_id": "harness:p001-doc-embedding-harness:p001-doc-embedding",
            "scope": "harness:p001-doc-embedding-harness",
            "ts": "2026-10-25T22:04:54.675Z",
            "excerpt": "Original procedure\nzephyrdocwitness original canonical instructions.",
            "highlight": "zephyrdocwitness original canonical instructions.",
            "score": 1,
            "rankers": [
              "embeddings"
            ],
            "meta": {
              "title": "Original procedure",
              "section": null,
              "status": "maintained",
              "currentness": "maintained-procedure",
              "path": "/docs/p001-doc-embedding",
              "docSourceKey": "harness:p001-doc-embedding-harness"
            }
          }
        }
      ],
      "epoch": "d9c16feaebfff582652d9244cfad738aba322f465508bf1757ce9b6af94b7d4e",
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "excerpt",
              "valueFingerprint": "ec9eef367a3128c07e7b7edb8ed3db91d01c8ac42a712e51e2472f5f1364ff01"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "excerpt",
              "valueFingerprint": "ec9eef367a3128c07e7b7edb8ed3db91d01c8ac42a712e51e2472f5f1364ff01",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "d9c16feaebfff582652d9244cfad738aba322f465508bf1757ce9b6af94b7d4e",
              "sourceRevision": "1",
              "readAtMs": 1792965894690
            },
            "requestStartedAtMs": 1792965894685,
            "responseAtMs": 1792965894690
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
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "highlight",
              "valueFingerprint": "736ef128fc036a93ebab7708c0291100918debdad13c679bdf0caa035b82cd49"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "highlight",
              "valueFingerprint": "736ef128fc036a93ebab7708c0291100918debdad13c679bdf0caa035b82cd49",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "d9c16feaebfff582652d9244cfad738aba322f465508bf1757ce9b6af94b7d4e",
              "sourceRevision": "1",
              "readAtMs": 1792965894690
            },
            "requestStartedAtMs": 1792965894685,
            "responseAtMs": 1792965894690
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
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "ts",
              "valueFingerprint": "486a00fe6014cdb6596d882d14795433752bc08ffc0888bbce2001e49124f7a7"
            },
            "indexed": null,
            "canonical": null,
            "requestStartedAtMs": 1792965894685,
            "responseAtMs": 1792965894690
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable",
              "canonical authority unavailable"
            ]
          }
        }
      ]
    },
    {
      "caseId": "doc/embedding",
      "phase": "source-changed-cache-still-old",
      "before": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894692
      },
      "after": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894699
      },
      "rows": [
        {
          "key": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
          "score": 1,
          "row": {
            "source": "doc",
            "source_id": "harness:p001-doc-embedding-harness:p001-doc-embedding",
            "scope": "harness:p001-doc-embedding-harness",
            "ts": "2026-10-25T22:04:54.675Z",
            "excerpt": "Original procedure\nzephyrdocwitness original canonical instructions.",
            "highlight": "zephyrdocwitness original canonical instructions.",
            "score": 1,
            "rankers": [
              "embeddings"
            ],
            "meta": {
              "title": "Original procedure",
              "section": null,
              "status": "maintained",
              "currentness": "maintained-procedure",
              "path": "/docs/p001-doc-embedding",
              "docSourceKey": "harness:p001-doc-embedding-harness"
            }
          }
        }
      ],
      "epoch": "d9c16feaebfff582652d9244cfad738aba322f465508bf1757ce9b6af94b7d4e",
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "excerpt",
              "valueFingerprint": "ec9eef367a3128c07e7b7edb8ed3db91d01c8ac42a712e51e2472f5f1364ff01"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "excerpt",
              "valueFingerprint": "d8431579ee67ce46f82a16076c73637ca0d94501524d3ed128a2f5230e37b218",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "d9c16feaebfff582652d9244cfad738aba322f465508bf1757ce9b6af94b7d4e",
              "sourceRevision": "2",
              "readAtMs": 1792965894699
            },
            "requestStartedAtMs": 1792965894692,
            "responseAtMs": 1792965894699
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
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "highlight",
              "valueFingerprint": "736ef128fc036a93ebab7708c0291100918debdad13c679bdf0caa035b82cd49"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "highlight",
              "valueFingerprint": "7ed543aa14ee7cc524726ce5bb222f7688bc642151a84c50c9e3490ec9552ad7",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "d9c16feaebfff582652d9244cfad738aba322f465508bf1757ce9b6af94b7d4e",
              "sourceRevision": "2",
              "readAtMs": 1792965894699
            },
            "requestStartedAtMs": 1792965894692,
            "responseAtMs": 1792965894699
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
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "ts",
              "valueFingerprint": "486a00fe6014cdb6596d882d14795433752bc08ffc0888bbce2001e49124f7a7"
            },
            "indexed": null,
            "canonical": null,
            "requestStartedAtMs": 1792965894692,
            "responseAtMs": 1792965894699
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable",
              "canonical authority unavailable"
            ]
          }
        }
      ]
    },
    {
      "caseId": "doc/embedding",
      "phase": "source-change-synced",
      "before": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894705
      },
      "after": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894709
      },
      "rows": [
        {
          "key": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
          "score": 1,
          "row": {
            "source": "doc",
            "source_id": "harness:p001-doc-embedding-harness:p001-doc-embedding",
            "scope": "harness:p001-doc-embedding-harness",
            "ts": "2026-10-25T22:04:54.702Z",
            "excerpt": "Revised procedure\nzephyrdocwitness replacement canonical instructions.",
            "highlight": "zephyrdocwitness replacement canonical instructions.",
            "score": 1,
            "rankers": [
              "embeddings"
            ],
            "meta": {
              "title": "Revised procedure",
              "section": null,
              "status": "maintained",
              "currentness": "maintained-procedure",
              "path": "/docs/p001-doc-embedding",
              "docSourceKey": "harness:p001-doc-embedding-harness"
            }
          }
        }
      ],
      "epoch": "d9c16feaebfff582652d9244cfad738aba322f465508bf1757ce9b6af94b7d4e",
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "excerpt",
              "valueFingerprint": "d8431579ee67ce46f82a16076c73637ca0d94501524d3ed128a2f5230e37b218"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "excerpt",
              "valueFingerprint": "d8431579ee67ce46f82a16076c73637ca0d94501524d3ed128a2f5230e37b218",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "d9c16feaebfff582652d9244cfad738aba322f465508bf1757ce9b6af94b7d4e",
              "sourceRevision": "2",
              "readAtMs": 1792965894709
            },
            "requestStartedAtMs": 1792965894705,
            "responseAtMs": 1792965894709
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
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "highlight",
              "valueFingerprint": "7ed543aa14ee7cc524726ce5bb222f7688bc642151a84c50c9e3490ec9552ad7"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "highlight",
              "valueFingerprint": "7ed543aa14ee7cc524726ce5bb222f7688bc642151a84c50c9e3490ec9552ad7",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "d9c16feaebfff582652d9244cfad738aba322f465508bf1757ce9b6af94b7d4e",
              "sourceRevision": "2",
              "readAtMs": 1792965894709
            },
            "requestStartedAtMs": 1792965894705,
            "responseAtMs": 1792965894709
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
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "ts",
              "valueFingerprint": "66e74186ddd513628a941388a8b7d1b9a493cae4e06bf6a685d0fd7359eccc7f"
            },
            "indexed": null,
            "canonical": null,
            "requestStartedAtMs": 1792965894705,
            "responseAtMs": 1792965894709
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable",
              "canonical authority unavailable"
            ]
          }
        }
      ]
    },
    {
      "caseId": "doc/embedding",
      "phase": "candidate-added",
      "before": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894715
      },
      "after": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894719
      },
      "rows": [
        {
          "key": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
          "score": 1,
          "row": {
            "source": "doc",
            "source_id": "harness:p001-doc-embedding-harness:p001-doc-embedding",
            "scope": "harness:p001-doc-embedding-harness",
            "ts": "2026-10-25T22:04:54.702Z",
            "excerpt": "Revised procedure\nzephyrdocwitness replacement canonical instructions.",
            "highlight": "zephyrdocwitness replacement canonical instructions.",
            "score": 1,
            "rankers": [
              "embeddings"
            ],
            "meta": {
              "title": "Revised procedure",
              "section": null,
              "status": "maintained",
              "currentness": "maintained-procedure",
              "path": "/docs/p001-doc-embedding",
              "docSourceKey": "harness:p001-doc-embedding-harness"
            }
          }
        },
        {
          "key": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding-added",
          "score": 1,
          "row": {
            "source": "doc",
            "source_id": "harness:p001-doc-embedding-harness:p001-doc-embedding-added",
            "scope": "harness:p001-doc-embedding-harness",
            "ts": "2026-10-25T22:04:54.712Z",
            "excerpt": "Added procedure\nzephyrdocwitness added canonical instructions.",
            "highlight": "zephyrdocwitness added canonical instructions.",
            "score": 1,
            "rankers": [
              "embeddings"
            ],
            "meta": {
              "title": "Added procedure",
              "section": null,
              "status": "maintained",
              "currentness": "maintained-procedure",
              "path": "/docs/p001-doc-embedding-added",
              "docSourceKey": "harness:p001-doc-embedding-harness"
            }
          }
        }
      ],
      "epoch": "d9c16feaebfff582652d9244cfad738aba322f465508bf1757ce9b6af94b7d4e",
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "excerpt",
              "valueFingerprint": "d8431579ee67ce46f82a16076c73637ca0d94501524d3ed128a2f5230e37b218"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "excerpt",
              "valueFingerprint": "d8431579ee67ce46f82a16076c73637ca0d94501524d3ed128a2f5230e37b218",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "d9c16feaebfff582652d9244cfad738aba322f465508bf1757ce9b6af94b7d4e",
              "sourceRevision": "2",
              "readAtMs": 1792965894719
            },
            "requestStartedAtMs": 1792965894715,
            "responseAtMs": 1792965894719
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
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "highlight",
              "valueFingerprint": "7ed543aa14ee7cc524726ce5bb222f7688bc642151a84c50c9e3490ec9552ad7"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "highlight",
              "valueFingerprint": "7ed543aa14ee7cc524726ce5bb222f7688bc642151a84c50c9e3490ec9552ad7",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "d9c16feaebfff582652d9244cfad738aba322f465508bf1757ce9b6af94b7d4e",
              "sourceRevision": "2",
              "readAtMs": 1792965894719
            },
            "requestStartedAtMs": 1792965894715,
            "responseAtMs": 1792965894719
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
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "ts",
              "valueFingerprint": "66e74186ddd513628a941388a8b7d1b9a493cae4e06bf6a685d0fd7359eccc7f"
            },
            "indexed": null,
            "canonical": null,
            "requestStartedAtMs": 1792965894715,
            "responseAtMs": 1792965894719
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable",
              "canonical authority unavailable"
            ]
          }
        }
      ]
    },
    {
      "caseId": "doc/embedding",
      "phase": "candidate-pruned",
      "before": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894724
      },
      "after": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894730
      },
      "rows": [
        {
          "key": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
          "score": 1,
          "row": {
            "source": "doc",
            "source_id": "harness:p001-doc-embedding-harness:p001-doc-embedding",
            "scope": "harness:p001-doc-embedding-harness",
            "ts": "2026-10-25T22:04:54.702Z",
            "excerpt": "Revised procedure\nzephyrdocwitness replacement canonical instructions.",
            "highlight": "zephyrdocwitness replacement canonical instructions.",
            "score": 1,
            "rankers": [
              "embeddings"
            ],
            "meta": {
              "title": "Revised procedure",
              "section": null,
              "status": "maintained",
              "currentness": "maintained-procedure",
              "path": "/docs/p001-doc-embedding",
              "docSourceKey": "harness:p001-doc-embedding-harness"
            }
          }
        }
      ],
      "epoch": "d9c16feaebfff582652d9244cfad738aba322f465508bf1757ce9b6af94b7d4e",
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "excerpt",
              "valueFingerprint": "d8431579ee67ce46f82a16076c73637ca0d94501524d3ed128a2f5230e37b218"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "excerpt",
              "valueFingerprint": "d8431579ee67ce46f82a16076c73637ca0d94501524d3ed128a2f5230e37b218",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "d9c16feaebfff582652d9244cfad738aba322f465508bf1757ce9b6af94b7d4e",
              "sourceRevision": "2",
              "readAtMs": 1792965894730
            },
            "requestStartedAtMs": 1792965894724,
            "responseAtMs": 1792965894730
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
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "highlight",
              "valueFingerprint": "7ed543aa14ee7cc524726ce5bb222f7688bc642151a84c50c9e3490ec9552ad7"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "highlight",
              "valueFingerprint": "7ed543aa14ee7cc524726ce5bb222f7688bc642151a84c50c9e3490ec9552ad7",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "d9c16feaebfff582652d9244cfad738aba322f465508bf1757ce9b6af94b7d4e",
              "sourceRevision": "2",
              "readAtMs": 1792965894730
            },
            "requestStartedAtMs": 1792965894724,
            "responseAtMs": 1792965894730
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
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "ts",
              "valueFingerprint": "66e74186ddd513628a941388a8b7d1b9a493cae4e06bf6a685d0fd7359eccc7f"
            },
            "indexed": null,
            "canonical": null,
            "requestStartedAtMs": 1792965894724,
            "responseAtMs": 1792965894730
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable",
              "canonical authority unavailable"
            ]
          }
        }
      ]
    },
    {
      "caseId": "doc/embedding",
      "phase": "audience-excluded",
      "before": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894734
      },
      "after": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894744
      },
      "rows": [],
      "epoch": "d9c16feaebfff582652d9244cfad738aba322f465508bf1757ce9b6af94b7d4e",
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "excerpt",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "excerpt",
              "valueFingerprint": "d8431579ee67ce46f82a16076c73637ca0d94501524d3ed128a2f5230e37b218",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "d9c16feaebfff582652d9244cfad738aba322f465508bf1757ce9b6af94b7d4e",
              "sourceRevision": "2",
              "readAtMs": 1792965894744
            },
            "requestStartedAtMs": 1792965894734,
            "responseAtMs": 1792965894744
          },
          "oracle": null
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "highlight",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "highlight",
              "valueFingerprint": "7ed543aa14ee7cc524726ce5bb222f7688bc642151a84c50c9e3490ec9552ad7",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "d9c16feaebfff582652d9244cfad738aba322f465508bf1757ce9b6af94b7d4e",
              "sourceRevision": "2",
              "readAtMs": 1792965894744
            },
            "requestStartedAtMs": 1792965894734,
            "responseAtMs": 1792965894744
          },
          "oracle": null
        },
        {
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "ts",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": null,
            "requestStartedAtMs": 1792965894734,
            "responseAtMs": 1792965894744
          },
          "oracle": null
        }
      ]
    },
    {
      "caseId": "doc/embedding",
      "phase": "membership-revoked",
      "before": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894746
      },
      "after": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894750
      },
      "rows": [],
      "epoch": "856777257cb085df28457a3628ee153335b3670e9438c80212386bdaf7ef6a35",
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "excerpt",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "excerpt",
              "valueFingerprint": "d8431579ee67ce46f82a16076c73637ca0d94501524d3ed128a2f5230e37b218",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "856777257cb085df28457a3628ee153335b3670e9438c80212386bdaf7ef6a35",
              "sourceRevision": "2",
              "readAtMs": 1792965894750
            },
            "requestStartedAtMs": 1792965894746,
            "responseAtMs": 1792965894750
          },
          "oracle": null
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "highlight",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "highlight",
              "valueFingerprint": "7ed543aa14ee7cc524726ce5bb222f7688bc642151a84c50c9e3490ec9552ad7",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "856777257cb085df28457a3628ee153335b3670e9438c80212386bdaf7ef6a35",
              "sourceRevision": "2",
              "readAtMs": 1792965894750
            },
            "requestStartedAtMs": 1792965894746,
            "responseAtMs": 1792965894750
          },
          "oracle": null
        },
        {
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "ts",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": null,
            "requestStartedAtMs": 1792965894746,
            "responseAtMs": 1792965894750
          },
          "oracle": null
        }
      ]
    },
    {
      "caseId": "doc/embedding",
      "phase": "membership-restored",
      "before": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894753
      },
      "after": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894757
      },
      "rows": [
        {
          "key": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
          "score": 1,
          "row": {
            "source": "doc",
            "source_id": "harness:p001-doc-embedding-harness:p001-doc-embedding",
            "scope": "harness:p001-doc-embedding-harness",
            "ts": "2026-10-25T22:04:54.702Z",
            "excerpt": "Revised procedure\nzephyrdocwitness replacement canonical instructions.",
            "highlight": "zephyrdocwitness replacement canonical instructions.",
            "score": 1,
            "rankers": [
              "embeddings"
            ],
            "meta": {
              "title": "Revised procedure",
              "section": null,
              "status": "maintained",
              "currentness": "maintained-procedure",
              "path": "/docs/p001-doc-embedding",
              "docSourceKey": "harness:p001-doc-embedding-harness"
            }
          }
        }
      ],
      "epoch": "d9c16feaebfff582652d9244cfad738aba322f465508bf1757ce9b6af94b7d4e",
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "excerpt",
              "valueFingerprint": "d8431579ee67ce46f82a16076c73637ca0d94501524d3ed128a2f5230e37b218"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "excerpt",
              "valueFingerprint": "d8431579ee67ce46f82a16076c73637ca0d94501524d3ed128a2f5230e37b218",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "d9c16feaebfff582652d9244cfad738aba322f465508bf1757ce9b6af94b7d4e",
              "sourceRevision": "2",
              "readAtMs": 1792965894757
            },
            "requestStartedAtMs": 1792965894753,
            "responseAtMs": 1792965894757
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
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "highlight",
              "valueFingerprint": "7ed543aa14ee7cc524726ce5bb222f7688bc642151a84c50c9e3490ec9552ad7"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "highlight",
              "valueFingerprint": "7ed543aa14ee7cc524726ce5bb222f7688bc642151a84c50c9e3490ec9552ad7",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "d9c16feaebfff582652d9244cfad738aba322f465508bf1757ce9b6af94b7d4e",
              "sourceRevision": "2",
              "readAtMs": 1792965894757
            },
            "requestStartedAtMs": 1792965894753,
            "responseAtMs": 1792965894757
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
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "ts",
              "valueFingerprint": "66e74186ddd513628a941388a8b7d1b9a493cae4e06bf6a685d0fd7359eccc7f"
            },
            "indexed": null,
            "canonical": null,
            "requestStartedAtMs": 1792965894753,
            "responseAtMs": 1792965894757
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable",
              "canonical authority unavailable"
            ]
          }
        }
      ]
    },
    {
      "caseId": "doc/embedding",
      "phase": "canonical-retirement",
      "before": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894761
      },
      "after": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894766
      },
      "rows": [],
      "epoch": "0d4c47c183ff2de47184a87f8e20b001043b799a224849f9bd0939bf5a071757",
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "excerpt",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "excerpt",
              "valueFingerprint": "d8431579ee67ce46f82a16076c73637ca0d94501524d3ed128a2f5230e37b218",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "0d4c47c183ff2de47184a87f8e20b001043b799a224849f9bd0939bf5a071757",
              "sourceRevision": "2",
              "readAtMs": 1792965894766
            },
            "requestStartedAtMs": 1792965894761,
            "responseAtMs": 1792965894766
          },
          "oracle": null
        },
        {
          "field": "highlight",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "highlight",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "highlight",
              "valueFingerprint": "7ed543aa14ee7cc524726ce5bb222f7688bc642151a84c50c9e3490ec9552ad7",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "0d4c47c183ff2de47184a87f8e20b001043b799a224849f9bd0939bf5a071757",
              "sourceRevision": "2",
              "readAtMs": 1792965894766
            },
            "requestStartedAtMs": 1792965894761,
            "responseAtMs": 1792965894766
          },
          "oracle": null
        },
        {
          "field": "ts",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "ts",
              "valueFingerprint": "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"
            },
            "indexed": null,
            "canonical": null,
            "requestStartedAtMs": 1792965894761,
            "responseAtMs": 1792965894766
          },
          "oracle": null
        }
      ]
    },
    {
      "caseId": "doc/embedding",
      "phase": "canonical-retirement-restored",
      "before": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894768
      },
      "after": {
        "title": "Revised procedure",
        "body": "zephyrdocwitness replacement canonical instructions.",
        "revision": 2,
        "readAtMs": 1792965894774
      },
      "rows": [
        {
          "key": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
          "score": 1,
          "row": {
            "source": "doc",
            "source_id": "harness:p001-doc-embedding-harness:p001-doc-embedding",
            "scope": "harness:p001-doc-embedding-harness",
            "ts": "2026-10-25T22:04:54.702Z",
            "excerpt": "Revised procedure\nzephyrdocwitness replacement canonical instructions.",
            "highlight": "zephyrdocwitness replacement canonical instructions.",
            "score": 1,
            "rankers": [
              "embeddings"
            ],
            "meta": {
              "title": "Revised procedure",
              "section": null,
              "status": "maintained",
              "currentness": "maintained-procedure",
              "path": "/docs/p001-doc-embedding",
              "docSourceKey": "harness:p001-doc-embedding-harness"
            }
          }
        }
      ],
      "epoch": "8ffcd51a2645576baecb747380e809dd02de321f2b88515839abed44af07e8e6",
      "observations": [
        {
          "field": "excerpt",
          "input": {
            "returned": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "excerpt",
              "valueFingerprint": "d8431579ee67ce46f82a16076c73637ca0d94501524d3ed128a2f5230e37b218"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "excerpt",
              "valueFingerprint": "d8431579ee67ce46f82a16076c73637ca0d94501524d3ed128a2f5230e37b218",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "8ffcd51a2645576baecb747380e809dd02de321f2b88515839abed44af07e8e6",
              "sourceRevision": "2",
              "readAtMs": 1792965894774
            },
            "requestStartedAtMs": 1792965894768,
            "responseAtMs": 1792965894774
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
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "highlight",
              "valueFingerprint": "7ed543aa14ee7cc524726ce5bb222f7688bc642151a84c50c9e3490ec9552ad7"
            },
            "indexed": null,
            "canonical": {
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "highlight",
              "valueFingerprint": "7ed543aa14ee7cc524726ce5bb222f7688bc642151a84c50c9e3490ec9552ad7",
              "authority": "registered docs-engine source; doc_sections is a derived complete-body cache",
              "authorityEpoch": "8ffcd51a2645576baecb747380e809dd02de321f2b88515839abed44af07e8e6",
              "sourceRevision": "2",
              "readAtMs": 1792965894774
            },
            "requestStartedAtMs": 1792965894768,
            "responseAtMs": 1792965894774
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
              "entityRef": "doc:harness:p001-doc-embedding-harness:p001-doc-embedding",
              "fieldPath": "ts",
              "valueFingerprint": "66e74186ddd513628a941388a8b7d1b9a493cae4e06bf6a685d0fd7359eccc7f"
            },
            "indexed": null,
            "canonical": null,
            "requestStartedAtMs": 1792965894768,
            "responseAtMs": 1792965894774
          },
          "oracle": {
            "status": "unknown",
            "action": "degrade",
            "reasons": [
              "index witness unavailable",
              "canonical authority unavailable"
            ]
          }
        }
      ]
    }
  ],
  "limits": [
    "Controlled DocSource authority and minimal SQL schema; no production authentication or scheduling claim.",
    "Manual deterministic vector backfill; real sync text writer and real lexical/vector reader SQL.",
    "Current values remain unknown without index-version proof; deliberately unsynced values are stale.",
    "Report/plan, memory/Restart, runtime, quality/cost/budgets and full acceptance remain open."
  ]
}
