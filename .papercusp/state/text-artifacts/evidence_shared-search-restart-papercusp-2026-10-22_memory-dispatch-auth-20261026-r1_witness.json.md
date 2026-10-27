---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/memory-dispatch-auth-20261026-r1/witness.json"
updated_at: 1793043872430
_body: "content"
---

{
  "schemaVersion": 1,
  "query": "zephyrdispatchmemory",
  "sourcePins": [
    {
      "path": "packages/agent-mcp/src/server.ts",
      "sha256": "0b00325373029f3f39dd3f96a080c9a360544ed966650a9aef0555bd078cc817"
    },
    {
      "path": "packages/agent-mcp/src/auth.ts",
      "sha256": "c0179829ab12d36347dba6400ea2c2ae7a04f9406ff7175a908c7d9b46301504"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/memory/search.ts",
      "sha256": "82e61cb6794055d1e3ee325ecb05d65228cef635117521e115cb9b77e0fe258e"
    },
    {
      "path": "packages/operator-core/lib/auth.ts",
      "sha256": "83536580499636fb25e83834095a9181323bdcc5e25000287028c76e18206d62"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/coordination/identity.ts",
      "sha256": "912eb40f13d791f2d53b15eb730f939b83e806a7a3b30d5e100a427e10e549c2"
    },
    {
      "path": "packages/operator-core/lib/harness-registry.ts",
      "sha256": "d78e711d2f136aa7e0c6e3b8bb0614f182aff4e44a404cbf16b1b0bbbda4f558"
    },
    {
      "path": "packages/operator-core/lib/operator-state-pg.ts",
      "sha256": "4bf2bd4cef6ab2600b68fda640e3e79ca7b8ec625d7f4d0c6fd710f7e81f750b"
    },
    {
      "path": "packages/operator-core/lib/memory/hive-scope.ts",
      "sha256": "044e2cab3a913040546cd200bafde43c31d0cf88edeff4e37314c15c4ba9d521"
    },
    {
      "path": "packages/operator-core/lib/memory/workspace-scope-recall.ts",
      "sha256": "eb1c371a2f3a7f3319ea7c349c7b3f40f237a22b61ce46388ebca2bbd2c38c00"
    },
    {
      "path": "packages/operator-core/lib/blueprint/package-memory-visibility.ts",
      "sha256": "34238137bd9a2dfcdc17fb6e759b48ba8dbbf1e8577ea6f2b9fcffe2f92dbd39"
    },
    {
      "path": "libs/generic/tooldef/src/define-tool.ts",
      "sha256": "c32fcecd3e2cbc50bafae715b87a65e02c04b100646a1b9b7824a21a2a6e642f"
    },
    {
      "path": "libs/generic/tooldef/src/dispatch-projected.ts",
      "sha256": "888b3b2a32a2f45713cdc4f0737960ee1fa7834db73b9084702ce1c736aeb9aa"
    },
    {
      "path": "libs/generic/tooldef/src/dispatch-stack.ts",
      "sha256": "aa47f53e311350744aa47910dea852419e21fc816d4157f75782e9e9d78d4588"
    },
    {
      "path": "libs/generic/memory/src/hybrid-backend.ts",
      "sha256": "effa0f3b1541c4ced6d619f006bbb083a378dfb04228adba25e545ede9347073"
    }
  ],
  "testSha256": "b345d48a6393aedfe79a8861f8583855c0f53a95979c8d20d51e67952a91f1d4",
  "profileId": "gemma-embeddinggemma-300m-768@v1",
  "vectorFingerprint": "738ca73546b0da9bed824e8dbe27729677ef9890716c2bdfb9a49d830791b698",
  "population": [
    "bearer-refusals",
    "workspace-fanout",
    "wearer-revocation",
    "projected-hive-and-judge"
  ],
  "executed": [
    "bearer-refusals",
    "workspace-fanout",
    "wearer-revocation",
    "projected-hive-and-judge"
  ],
  "unexecuted": [],
  "receipts": [
    {
      "phase": "unknown-token",
      "result": {
        "ok": false,
        "error": {
          "code": "invalid_bearer",
          "message": "Bearer token did not resolve to a principal"
        }
      }
    },
    {
      "phase": "stored-hash-mismatch",
      "result": {
        "ok": false,
        "error": {
          "code": "invalid_bearer",
          "message": "Bearer token did not resolve to a principal"
        }
      }
    },
    {
      "phase": "missing-capability",
      "result": {
        "ok": false,
        "error": {
          "code": "missing_capability",
          "message": "Principal system:denied lacks capability \"memory:search:read\" (tool: memory:search)"
        }
      }
    },
    {
      "phase": "caller-workspace-channel",
      "result": {
        "ok": false,
        "error": {
          "code": "invalid_args",
          "message": "Unrecognized key: \"workspaceId\""
        }
      }
    },
    {
      "phase": "caller-user-channel",
      "result": {
        "ok": false,
        "error": {
          "code": "invalid_args",
          "message": "Unrecognized key: \"user_id\""
        }
      }
    },
    {
      "mode": "hybrid",
      "phase": "workspace-a",
      "request": {
        "query": "zephyrdispatchmemory",
        "limit": 20
      },
      "tokenHash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
      "path": "dispatch → resolveBearer → Standard Schema → withWorkspace → memory:search → hybrid/canonical",
      "startedAtMs": 1793043722298,
      "responseAtMs": 1793043722614,
      "before": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152005"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152009"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "name": "reader",
            "bearer_hash": "37f435b8aa0011e5f6a02263e1cf51700f12d9715ef71e5916429b607a05a12e",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152011"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152006"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152007"
          }
        ],
        "packages": [],
        "canonical": [
          {
            "id": "child",
            "payload": {
              "data": "zephyrdispatchmemory child",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-child"
            },
            "state": "active",
            "revision": "5152020"
          },
          {
            "id": "foreign",
            "payload": {
              "data": "zephyrdispatchmemory foreign",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-foreign"
            },
            "state": "active",
            "revision": "5152024"
          },
          {
            "id": "foreign-user",
            "payload": {
              "data": "zephyrdispatchmemory foreign-user",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "foreign-user"
            },
            "state": "active",
            "revision": "5152016"
          },
          {
            "id": "home",
            "payload": {
              "data": "zephyrdispatchmemory home",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152018"
          },
          {
            "id": "personal-a",
            "payload": {
              "data": "zephyrdispatchmemory personal-a",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-a"
            },
            "state": "active",
            "revision": "5152012"
          },
          {
            "id": "personal-b",
            "payload": {
              "data": "zephyrdispatchmemory personal-b",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-b"
            },
            "state": "active",
            "revision": "5152014"
          },
          {
            "id": "sibling",
            "payload": {
              "data": "zephyrdispatchmemory sibling",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-sibling"
            },
            "state": "active",
            "revision": "5152022"
          }
        ]
      },
      "after": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152005"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152009"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "name": "reader",
            "bearer_hash": "37f435b8aa0011e5f6a02263e1cf51700f12d9715ef71e5916429b607a05a12e",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152011"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152006"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152007"
          }
        ],
        "packages": [],
        "canonical": [
          {
            "id": "child",
            "payload": {
              "data": "zephyrdispatchmemory child",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-child"
            },
            "state": "active",
            "revision": "5152020"
          },
          {
            "id": "foreign",
            "payload": {
              "data": "zephyrdispatchmemory foreign",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-foreign"
            },
            "state": "active",
            "revision": "5152024"
          },
          {
            "id": "foreign-user",
            "payload": {
              "data": "zephyrdispatchmemory foreign-user",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "foreign-user"
            },
            "state": "active",
            "revision": "5152016"
          },
          {
            "id": "home",
            "payload": {
              "data": "zephyrdispatchmemory home",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152018"
          },
          {
            "id": "personal-a",
            "payload": {
              "data": "zephyrdispatchmemory personal-a",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-a"
            },
            "state": "active",
            "revision": "5152012"
          },
          {
            "id": "personal-b",
            "payload": {
              "data": "zephyrdispatchmemory personal-b",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-b"
            },
            "state": "active",
            "revision": "5152014"
          },
          {
            "id": "sibling",
            "payload": {
              "data": "zephyrdispatchmemory sibling",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-sibling"
            },
            "state": "active",
            "revision": "5152022"
          }
        ]
      },
      "output": {
        "ok": true,
        "results": [
          {
            "id": "personal-a",
            "memory": "zephyrdispatchmemory personal-a",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "workspace_id": "p001-memory-dispatch-a"
            },
            "score": 0.03252247488101534
          },
          {
            "id": "home",
            "memory": "zephyrdispatchmemory home",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory"
            },
            "score": 0.031746031746031744
          },
          {
            "id": "child",
            "memory": "zephyrdispatchmemory child",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory"
            },
            "score": 0.03125
          },
          {
            "id": "sibling",
            "memory": "zephyrdispatchmemory sibling",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory"
            },
            "score": 0.03076923076923077
          }
        ],
        "score_scale": "rrf"
      },
      "expected": [
        "personal-a",
        "home",
        "child",
        "sibling"
      ],
      "fixtureAuthorityEpoch": "95b447f7a4ddbe661359a29091060759b52d3b93557ec56ab5219da65caed044",
      "fieldCurrentness": "unknown"
    },
    {
      "mode": "hybrid",
      "phase": "workspace-b-same-principal-slug",
      "request": {
        "query": "zephyrdispatchmemory",
        "limit": 20
      },
      "tokenHash": "37f435b8aa0011e5f6a02263e1cf51700f12d9715ef71e5916429b607a05a12e",
      "path": "dispatch → resolveBearer → Standard Schema → withWorkspace → memory:search → hybrid/canonical",
      "startedAtMs": 1793043722616,
      "responseAtMs": 1793043722646,
      "before": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152005"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152009"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "name": "reader",
            "bearer_hash": "37f435b8aa0011e5f6a02263e1cf51700f12d9715ef71e5916429b607a05a12e",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152011"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152006"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152007"
          }
        ],
        "packages": [],
        "canonical": [
          {
            "id": "child",
            "payload": {
              "data": "zephyrdispatchmemory child",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-child"
            },
            "state": "active",
            "revision": "5152020"
          },
          {
            "id": "foreign",
            "payload": {
              "data": "zephyrdispatchmemory foreign",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-foreign"
            },
            "state": "active",
            "revision": "5152024"
          },
          {
            "id": "foreign-user",
            "payload": {
              "data": "zephyrdispatchmemory foreign-user",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "foreign-user"
            },
            "state": "active",
            "revision": "5152016"
          },
          {
            "id": "home",
            "payload": {
              "data": "zephyrdispatchmemory home",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152018"
          },
          {
            "id": "personal-a",
            "payload": {
              "data": "zephyrdispatchmemory personal-a",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-a"
            },
            "state": "active",
            "revision": "5152012"
          },
          {
            "id": "personal-b",
            "payload": {
              "data": "zephyrdispatchmemory personal-b",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-b"
            },
            "state": "active",
            "revision": "5152014"
          },
          {
            "id": "sibling",
            "payload": {
              "data": "zephyrdispatchmemory sibling",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-sibling"
            },
            "state": "active",
            "revision": "5152022"
          }
        ]
      },
      "after": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152005"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152009"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "name": "reader",
            "bearer_hash": "37f435b8aa0011e5f6a02263e1cf51700f12d9715ef71e5916429b607a05a12e",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152011"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152006"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152007"
          }
        ],
        "packages": [],
        "canonical": [
          {
            "id": "child",
            "payload": {
              "data": "zephyrdispatchmemory child",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-child"
            },
            "state": "active",
            "revision": "5152020"
          },
          {
            "id": "foreign",
            "payload": {
              "data": "zephyrdispatchmemory foreign",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-foreign"
            },
            "state": "active",
            "revision": "5152024"
          },
          {
            "id": "foreign-user",
            "payload": {
              "data": "zephyrdispatchmemory foreign-user",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "foreign-user"
            },
            "state": "active",
            "revision": "5152016"
          },
          {
            "id": "home",
            "payload": {
              "data": "zephyrdispatchmemory home",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152018"
          },
          {
            "id": "personal-a",
            "payload": {
              "data": "zephyrdispatchmemory personal-a",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-a"
            },
            "state": "active",
            "revision": "5152012"
          },
          {
            "id": "personal-b",
            "payload": {
              "data": "zephyrdispatchmemory personal-b",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-b"
            },
            "state": "active",
            "revision": "5152014"
          },
          {
            "id": "sibling",
            "payload": {
              "data": "zephyrdispatchmemory sibling",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-sibling"
            },
            "state": "active",
            "revision": "5152022"
          }
        ]
      },
      "output": {
        "ok": true,
        "results": [
          {
            "id": "personal-b",
            "memory": "zephyrdispatchmemory personal-b",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "workspace_id": "p001-memory-dispatch-b"
            },
            "score": 0.03252247488101534
          },
          {
            "id": "foreign",
            "memory": "zephyrdispatchmemory foreign",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory"
            },
            "score": 0.031746031746031744
          }
        ],
        "score_scale": "rrf"
      },
      "expected": [
        "personal-b",
        "foreign"
      ],
      "fixtureAuthorityEpoch": "95b447f7a4ddbe661359a29091060759b52d3b93557ec56ab5219da65caed044",
      "fieldCurrentness": "unknown"
    },
    {
      "mode": "hybrid",
      "phase": "scoped-workspace-argument-does-not-retarget",
      "request": {
        "query": "zephyrdispatchmemory",
        "limit": 20,
        "workspace": "p001-memory-dispatch-b"
      },
      "tokenHash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
      "path": "dispatch → resolveBearer → Standard Schema → withWorkspace → memory:search → hybrid/canonical",
      "startedAtMs": 1793043722647,
      "responseAtMs": 1793043722691,
      "before": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152005"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152009"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "name": "reader",
            "bearer_hash": "37f435b8aa0011e5f6a02263e1cf51700f12d9715ef71e5916429b607a05a12e",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152011"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152006"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152007"
          }
        ],
        "packages": [],
        "canonical": [
          {
            "id": "child",
            "payload": {
              "data": "zephyrdispatchmemory child",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-child"
            },
            "state": "active",
            "revision": "5152020"
          },
          {
            "id": "foreign",
            "payload": {
              "data": "zephyrdispatchmemory foreign",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-foreign"
            },
            "state": "active",
            "revision": "5152024"
          },
          {
            "id": "foreign-user",
            "payload": {
              "data": "zephyrdispatchmemory foreign-user",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "foreign-user"
            },
            "state": "active",
            "revision": "5152016"
          },
          {
            "id": "home",
            "payload": {
              "data": "zephyrdispatchmemory home",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152018"
          },
          {
            "id": "personal-a",
            "payload": {
              "data": "zephyrdispatchmemory personal-a",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-a"
            },
            "state": "active",
            "revision": "5152012"
          },
          {
            "id": "personal-b",
            "payload": {
              "data": "zephyrdispatchmemory personal-b",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-b"
            },
            "state": "active",
            "revision": "5152014"
          },
          {
            "id": "sibling",
            "payload": {
              "data": "zephyrdispatchmemory sibling",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-sibling"
            },
            "state": "active",
            "revision": "5152022"
          }
        ]
      },
      "after": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152005"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152009"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "name": "reader",
            "bearer_hash": "37f435b8aa0011e5f6a02263e1cf51700f12d9715ef71e5916429b607a05a12e",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152011"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152006"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152007"
          }
        ],
        "packages": [],
        "canonical": [
          {
            "id": "child",
            "payload": {
              "data": "zephyrdispatchmemory child",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-child"
            },
            "state": "active",
            "revision": "5152020"
          },
          {
            "id": "foreign",
            "payload": {
              "data": "zephyrdispatchmemory foreign",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-foreign"
            },
            "state": "active",
            "revision": "5152024"
          },
          {
            "id": "foreign-user",
            "payload": {
              "data": "zephyrdispatchmemory foreign-user",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "foreign-user"
            },
            "state": "active",
            "revision": "5152016"
          },
          {
            "id": "home",
            "payload": {
              "data": "zephyrdispatchmemory home",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152018"
          },
          {
            "id": "personal-a",
            "payload": {
              "data": "zephyrdispatchmemory personal-a",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-a"
            },
            "state": "active",
            "revision": "5152012"
          },
          {
            "id": "personal-b",
            "payload": {
              "data": "zephyrdispatchmemory personal-b",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-b"
            },
            "state": "active",
            "revision": "5152014"
          },
          {
            "id": "sibling",
            "payload": {
              "data": "zephyrdispatchmemory sibling",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-sibling"
            },
            "state": "active",
            "revision": "5152022"
          }
        ]
      },
      "output": {
        "ok": true,
        "results": [
          {
            "id": "personal-a",
            "memory": "zephyrdispatchmemory personal-a",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "workspace_id": "p001-memory-dispatch-a"
            },
            "score": 0.03252247488101534
          },
          {
            "id": "home",
            "memory": "zephyrdispatchmemory home",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory"
            },
            "score": 0.031746031746031744
          },
          {
            "id": "child",
            "memory": "zephyrdispatchmemory child",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory"
            },
            "score": 0.03125
          },
          {
            "id": "sibling",
            "memory": "zephyrdispatchmemory sibling",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory"
            },
            "score": 0.03076923076923077
          }
        ],
        "score_scale": "rrf"
      },
      "expected": [
        "personal-a",
        "home",
        "child",
        "sibling"
      ],
      "fixtureAuthorityEpoch": "95b447f7a4ddbe661359a29091060759b52d3b93557ec56ab5219da65caed044",
      "fieldCurrentness": "unknown"
    },
    {
      "mode": "lexical-fallback",
      "phase": "workspace-a",
      "request": {
        "query": "zephyrdispatchmemory",
        "limit": 20
      },
      "tokenHash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
      "path": "dispatch → resolveBearer → Standard Schema → withWorkspace → memory:search → hybrid/canonical",
      "startedAtMs": 1793043722742,
      "responseAtMs": 1793043722771,
      "before": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152030"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152034"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "name": "reader",
            "bearer_hash": "37f435b8aa0011e5f6a02263e1cf51700f12d9715ef71e5916429b607a05a12e",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152036"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152031"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152032"
          }
        ],
        "packages": [],
        "canonical": [
          {
            "id": "child",
            "payload": {
              "data": "zephyrdispatchmemory child",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-child"
            },
            "state": "active",
            "revision": "5152045"
          },
          {
            "id": "foreign",
            "payload": {
              "data": "zephyrdispatchmemory foreign",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-foreign"
            },
            "state": "active",
            "revision": "5152049"
          },
          {
            "id": "foreign-user",
            "payload": {
              "data": "zephyrdispatchmemory foreign-user",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "foreign-user"
            },
            "state": "active",
            "revision": "5152041"
          },
          {
            "id": "home",
            "payload": {
              "data": "zephyrdispatchmemory home",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152043"
          },
          {
            "id": "personal-a",
            "payload": {
              "data": "zephyrdispatchmemory personal-a",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-a"
            },
            "state": "active",
            "revision": "5152037"
          },
          {
            "id": "personal-b",
            "payload": {
              "data": "zephyrdispatchmemory personal-b",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-b"
            },
            "state": "active",
            "revision": "5152039"
          },
          {
            "id": "sibling",
            "payload": {
              "data": "zephyrdispatchmemory sibling",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-sibling"
            },
            "state": "active",
            "revision": "5152047"
          }
        ]
      },
      "after": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152030"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152034"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "name": "reader",
            "bearer_hash": "37f435b8aa0011e5f6a02263e1cf51700f12d9715ef71e5916429b607a05a12e",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152036"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152031"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152032"
          }
        ],
        "packages": [],
        "canonical": [
          {
            "id": "child",
            "payload": {
              "data": "zephyrdispatchmemory child",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-child"
            },
            "state": "active",
            "revision": "5152045"
          },
          {
            "id": "foreign",
            "payload": {
              "data": "zephyrdispatchmemory foreign",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-foreign"
            },
            "state": "active",
            "revision": "5152049"
          },
          {
            "id": "foreign-user",
            "payload": {
              "data": "zephyrdispatchmemory foreign-user",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "foreign-user"
            },
            "state": "active",
            "revision": "5152041"
          },
          {
            "id": "home",
            "payload": {
              "data": "zephyrdispatchmemory home",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152043"
          },
          {
            "id": "personal-a",
            "payload": {
              "data": "zephyrdispatchmemory personal-a",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-a"
            },
            "state": "active",
            "revision": "5152037"
          },
          {
            "id": "personal-b",
            "payload": {
              "data": "zephyrdispatchmemory personal-b",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-b"
            },
            "state": "active",
            "revision": "5152039"
          },
          {
            "id": "sibling",
            "payload": {
              "data": "zephyrdispatchmemory sibling",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-sibling"
            },
            "state": "active",
            "revision": "5152047"
          }
        ]
      },
      "output": {
        "ok": true,
        "results": [
          {
            "id": "personal-a",
            "memory": "zephyrdispatchmemory personal-a",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "workspace_id": "p001-memory-dispatch-a"
            },
            "score": 1
          },
          {
            "id": "home",
            "memory": "zephyrdispatchmemory home",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory"
            },
            "score": 1
          },
          {
            "id": "child",
            "memory": "zephyrdispatchmemory child",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory"
            },
            "score": 1
          },
          {
            "id": "sibling",
            "memory": "zephyrdispatchmemory sibling",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory"
            },
            "score": 1
          }
        ],
        "score_scale": "lexical",
        "degraded": true,
        "degraded_reason": "memory_timeout",
        "fallback": "lexical"
      },
      "expected": [
        "personal-a",
        "home",
        "child",
        "sibling"
      ],
      "fixtureAuthorityEpoch": "ef4e2962d0174e796a30372546c9ede2b568ecd15a16e541cca9e7e82ec91ba6",
      "fieldCurrentness": "unknown"
    },
    {
      "mode": "lexical-fallback",
      "phase": "workspace-b-same-principal-slug",
      "request": {
        "query": "zephyrdispatchmemory",
        "limit": 20
      },
      "tokenHash": "37f435b8aa0011e5f6a02263e1cf51700f12d9715ef71e5916429b607a05a12e",
      "path": "dispatch → resolveBearer → Standard Schema → withWorkspace → memory:search → hybrid/canonical",
      "startedAtMs": 1793043722773,
      "responseAtMs": 1793043722800,
      "before": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152030"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152034"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "name": "reader",
            "bearer_hash": "37f435b8aa0011e5f6a02263e1cf51700f12d9715ef71e5916429b607a05a12e",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152036"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152031"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152032"
          }
        ],
        "packages": [],
        "canonical": [
          {
            "id": "child",
            "payload": {
              "data": "zephyrdispatchmemory child",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-child"
            },
            "state": "active",
            "revision": "5152045"
          },
          {
            "id": "foreign",
            "payload": {
              "data": "zephyrdispatchmemory foreign",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-foreign"
            },
            "state": "active",
            "revision": "5152049"
          },
          {
            "id": "foreign-user",
            "payload": {
              "data": "zephyrdispatchmemory foreign-user",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "foreign-user"
            },
            "state": "active",
            "revision": "5152041"
          },
          {
            "id": "home",
            "payload": {
              "data": "zephyrdispatchmemory home",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152043"
          },
          {
            "id": "personal-a",
            "payload": {
              "data": "zephyrdispatchmemory personal-a",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-a"
            },
            "state": "active",
            "revision": "5152037"
          },
          {
            "id": "personal-b",
            "payload": {
              "data": "zephyrdispatchmemory personal-b",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-b"
            },
            "state": "active",
            "revision": "5152039"
          },
          {
            "id": "sibling",
            "payload": {
              "data": "zephyrdispatchmemory sibling",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-sibling"
            },
            "state": "active",
            "revision": "5152047"
          }
        ]
      },
      "after": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152030"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152034"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "name": "reader",
            "bearer_hash": "37f435b8aa0011e5f6a02263e1cf51700f12d9715ef71e5916429b607a05a12e",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152036"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152031"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152032"
          }
        ],
        "packages": [],
        "canonical": [
          {
            "id": "child",
            "payload": {
              "data": "zephyrdispatchmemory child",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-child"
            },
            "state": "active",
            "revision": "5152045"
          },
          {
            "id": "foreign",
            "payload": {
              "data": "zephyrdispatchmemory foreign",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-foreign"
            },
            "state": "active",
            "revision": "5152049"
          },
          {
            "id": "foreign-user",
            "payload": {
              "data": "zephyrdispatchmemory foreign-user",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "foreign-user"
            },
            "state": "active",
            "revision": "5152041"
          },
          {
            "id": "home",
            "payload": {
              "data": "zephyrdispatchmemory home",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152043"
          },
          {
            "id": "personal-a",
            "payload": {
              "data": "zephyrdispatchmemory personal-a",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-a"
            },
            "state": "active",
            "revision": "5152037"
          },
          {
            "id": "personal-b",
            "payload": {
              "data": "zephyrdispatchmemory personal-b",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-b"
            },
            "state": "active",
            "revision": "5152039"
          },
          {
            "id": "sibling",
            "payload": {
              "data": "zephyrdispatchmemory sibling",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-sibling"
            },
            "state": "active",
            "revision": "5152047"
          }
        ]
      },
      "output": {
        "ok": true,
        "results": [
          {
            "id": "personal-b",
            "memory": "zephyrdispatchmemory personal-b",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "workspace_id": "p001-memory-dispatch-b"
            },
            "score": 1
          },
          {
            "id": "foreign",
            "memory": "zephyrdispatchmemory foreign",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory"
            },
            "score": 1
          }
        ],
        "score_scale": "lexical",
        "degraded": true,
        "degraded_reason": "memory_timeout",
        "fallback": "lexical"
      },
      "expected": [
        "personal-b",
        "foreign"
      ],
      "fixtureAuthorityEpoch": "ef4e2962d0174e796a30372546c9ede2b568ecd15a16e541cca9e7e82ec91ba6",
      "fieldCurrentness": "unknown"
    },
    {
      "mode": "lexical-fallback",
      "phase": "scoped-workspace-argument-does-not-retarget",
      "request": {
        "query": "zephyrdispatchmemory",
        "limit": 20,
        "workspace": "p001-memory-dispatch-b"
      },
      "tokenHash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
      "path": "dispatch → resolveBearer → Standard Schema → withWorkspace → memory:search → hybrid/canonical",
      "startedAtMs": 1793043722803,
      "responseAtMs": 1793043722829,
      "before": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152030"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152034"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "name": "reader",
            "bearer_hash": "37f435b8aa0011e5f6a02263e1cf51700f12d9715ef71e5916429b607a05a12e",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152036"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152031"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152032"
          }
        ],
        "packages": [],
        "canonical": [
          {
            "id": "child",
            "payload": {
              "data": "zephyrdispatchmemory child",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-child"
            },
            "state": "active",
            "revision": "5152045"
          },
          {
            "id": "foreign",
            "payload": {
              "data": "zephyrdispatchmemory foreign",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-foreign"
            },
            "state": "active",
            "revision": "5152049"
          },
          {
            "id": "foreign-user",
            "payload": {
              "data": "zephyrdispatchmemory foreign-user",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "foreign-user"
            },
            "state": "active",
            "revision": "5152041"
          },
          {
            "id": "home",
            "payload": {
              "data": "zephyrdispatchmemory home",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152043"
          },
          {
            "id": "personal-a",
            "payload": {
              "data": "zephyrdispatchmemory personal-a",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-a"
            },
            "state": "active",
            "revision": "5152037"
          },
          {
            "id": "personal-b",
            "payload": {
              "data": "zephyrdispatchmemory personal-b",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-b"
            },
            "state": "active",
            "revision": "5152039"
          },
          {
            "id": "sibling",
            "payload": {
              "data": "zephyrdispatchmemory sibling",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-sibling"
            },
            "state": "active",
            "revision": "5152047"
          }
        ]
      },
      "after": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152030"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152034"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "name": "reader",
            "bearer_hash": "37f435b8aa0011e5f6a02263e1cf51700f12d9715ef71e5916429b607a05a12e",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152036"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152031"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152032"
          }
        ],
        "packages": [],
        "canonical": [
          {
            "id": "child",
            "payload": {
              "data": "zephyrdispatchmemory child",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-child"
            },
            "state": "active",
            "revision": "5152045"
          },
          {
            "id": "foreign",
            "payload": {
              "data": "zephyrdispatchmemory foreign",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-foreign"
            },
            "state": "active",
            "revision": "5152049"
          },
          {
            "id": "foreign-user",
            "payload": {
              "data": "zephyrdispatchmemory foreign-user",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "foreign-user"
            },
            "state": "active",
            "revision": "5152041"
          },
          {
            "id": "home",
            "payload": {
              "data": "zephyrdispatchmemory home",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152043"
          },
          {
            "id": "personal-a",
            "payload": {
              "data": "zephyrdispatchmemory personal-a",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-a"
            },
            "state": "active",
            "revision": "5152037"
          },
          {
            "id": "personal-b",
            "payload": {
              "data": "zephyrdispatchmemory personal-b",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-b"
            },
            "state": "active",
            "revision": "5152039"
          },
          {
            "id": "sibling",
            "payload": {
              "data": "zephyrdispatchmemory sibling",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-sibling"
            },
            "state": "active",
            "revision": "5152047"
          }
        ]
      },
      "output": {
        "ok": true,
        "results": [
          {
            "id": "personal-a",
            "memory": "zephyrdispatchmemory personal-a",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "workspace_id": "p001-memory-dispatch-a"
            },
            "score": 1
          },
          {
            "id": "home",
            "memory": "zephyrdispatchmemory home",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory"
            },
            "score": 1
          },
          {
            "id": "child",
            "memory": "zephyrdispatchmemory child",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory"
            },
            "score": 1
          },
          {
            "id": "sibling",
            "memory": "zephyrdispatchmemory sibling",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory"
            },
            "score": 1
          }
        ],
        "score_scale": "lexical",
        "degraded": true,
        "degraded_reason": "memory_timeout",
        "fallback": "lexical"
      },
      "expected": [
        "personal-a",
        "home",
        "child",
        "sibling"
      ],
      "fixtureAuthorityEpoch": "ef4e2962d0174e796a30372546c9ede2b568ecd15a16e541cca9e7e82ec91ba6",
      "fieldCurrentness": "unknown"
    },
    {
      "mode": "hybrid",
      "phase": "authenticated-wearer",
      "request": {
        "query": "zephyrdispatchmemory",
        "limit": 20,
        "harness_slug": "p001-home",
        "harnessOnly": true
      },
      "tokenHash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
      "path": "dispatch → resolveBearer → Standard Schema → withWorkspace → memory:search → hybrid/canonical",
      "startedAtMs": 1793043722865,
      "responseAtMs": 1793043722894,
      "before": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152055"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "other",
            "bearer_hash": "b9d2d9a355e33b2490ee66584157fe9fd286d5899cc5e8bb8ca88fbe4d764bd0",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152061"
          },
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152059"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152056"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152057"
          }
        ],
        "packages": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "dependent_id": "installation",
            "owner_id": "system:reader",
            "phase": "applied",
            "revision": "5152066"
          }
        ],
        "canonical": [
          {
            "id": "organic",
            "payload": {
              "data": "zephyrdispatchmemory organic",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152062"
          },
          {
            "id": "pinned",
            "payload": {
              "data": "zephyrdispatchmemory pinned",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "source": "pack",
              "pack_id": "p001-pack",
              "user_id": "harness:p001-home",
              "pack_item_id": "note",
              "pack_version": "1.0.0",
              "identity_package_resource": "resource-v1"
            },
            "state": "archived",
            "revision": "5152064"
          }
        ]
      },
      "after": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152055"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "other",
            "bearer_hash": "b9d2d9a355e33b2490ee66584157fe9fd286d5899cc5e8bb8ca88fbe4d764bd0",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152061"
          },
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152059"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152056"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152057"
          }
        ],
        "packages": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "dependent_id": "installation",
            "owner_id": "system:reader",
            "phase": "applied",
            "revision": "5152066"
          }
        ],
        "canonical": [
          {
            "id": "organic",
            "payload": {
              "data": "zephyrdispatchmemory organic",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152062"
          },
          {
            "id": "pinned",
            "payload": {
              "data": "zephyrdispatchmemory pinned",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "source": "pack",
              "pack_id": "p001-pack",
              "user_id": "harness:p001-home",
              "pack_item_id": "note",
              "pack_version": "1.0.0",
              "identity_package_resource": "resource-v1"
            },
            "state": "archived",
            "revision": "5152064"
          }
        ]
      },
      "output": {
        "ok": true,
        "results": [
          {
            "id": "pinned",
            "memory": "zephyrdispatchmemory pinned",
            "metadata": {
              "data": "zephyrdispatchmemory pinned",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "source": "pack",
              "pack_id": "p001-pack",
              "user_id": "harness:p001-home",
              "pack_item_id": "note",
              "pack_version": "1.0.0",
              "identity_package_resource": "resource-v1",
              "identity_package": {
                "pack_id": "p001-pack",
                "pack_version": "1.0.0",
                "pack_item_id": "note",
                "pinned": true
              }
            },
            "score": 0.037400846113167636
          },
          {
            "id": "organic",
            "memory": "zephyrdispatchmemory organic",
            "metadata": {
              "data": "zephyrdispatchmemory organic",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "score": 0.03252247488101534
          }
        ],
        "score_scale": "rrf"
      },
      "expected": [
        "organic",
        "pinned"
      ],
      "fixtureAuthorityEpoch": "6a3f08afd8bcfcc0cd60797f43cac1a50137f9b403574ac105660327d268f7ea",
      "fieldCurrentness": "unknown"
    },
    {
      "mode": "hybrid",
      "phase": "different-authenticated-wearer",
      "request": {
        "query": "zephyrdispatchmemory",
        "limit": 20,
        "harness_slug": "p001-home",
        "harnessOnly": true
      },
      "tokenHash": "b9d2d9a355e33b2490ee66584157fe9fd286d5899cc5e8bb8ca88fbe4d764bd0",
      "path": "dispatch → resolveBearer → Standard Schema → withWorkspace → memory:search → hybrid/canonical",
      "startedAtMs": 1793043722896,
      "responseAtMs": 1793043722921,
      "before": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152055"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "other",
            "bearer_hash": "b9d2d9a355e33b2490ee66584157fe9fd286d5899cc5e8bb8ca88fbe4d764bd0",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152061"
          },
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152059"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152056"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152057"
          }
        ],
        "packages": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "dependent_id": "installation",
            "owner_id": "system:reader",
            "phase": "applied",
            "revision": "5152066"
          }
        ],
        "canonical": [
          {
            "id": "organic",
            "payload": {
              "data": "zephyrdispatchmemory organic",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152062"
          },
          {
            "id": "pinned",
            "payload": {
              "data": "zephyrdispatchmemory pinned",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "source": "pack",
              "pack_id": "p001-pack",
              "user_id": "harness:p001-home",
              "pack_item_id": "note",
              "pack_version": "1.0.0",
              "identity_package_resource": "resource-v1"
            },
            "state": "archived",
            "revision": "5152064"
          }
        ]
      },
      "after": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152055"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "other",
            "bearer_hash": "b9d2d9a355e33b2490ee66584157fe9fd286d5899cc5e8bb8ca88fbe4d764bd0",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152061"
          },
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152059"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152056"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152057"
          }
        ],
        "packages": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "dependent_id": "installation",
            "owner_id": "system:reader",
            "phase": "applied",
            "revision": "5152066"
          }
        ],
        "canonical": [
          {
            "id": "organic",
            "payload": {
              "data": "zephyrdispatchmemory organic",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152062"
          },
          {
            "id": "pinned",
            "payload": {
              "data": "zephyrdispatchmemory pinned",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "source": "pack",
              "pack_id": "p001-pack",
              "user_id": "harness:p001-home",
              "pack_item_id": "note",
              "pack_version": "1.0.0",
              "identity_package_resource": "resource-v1"
            },
            "state": "archived",
            "revision": "5152064"
          }
        ]
      },
      "output": {
        "ok": true,
        "results": [
          {
            "id": "organic",
            "memory": "zephyrdispatchmemory organic",
            "metadata": {
              "data": "zephyrdispatchmemory organic",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "score": 0.03278688524590164
          }
        ],
        "score_scale": "rrf"
      },
      "expected": [
        "organic"
      ],
      "fixtureAuthorityEpoch": "6a3f08afd8bcfcc0cd60797f43cac1a50137f9b403574ac105660327d268f7ea",
      "fieldCurrentness": "unknown"
    },
    {
      "mode": "hybrid",
      "phase": "package-revoked",
      "request": {
        "query": "zephyrdispatchmemory",
        "limit": 20,
        "harness_slug": "p001-home",
        "harnessOnly": true
      },
      "tokenHash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
      "path": "dispatch → resolveBearer → Standard Schema → withWorkspace → memory:search → hybrid/canonical",
      "startedAtMs": 1793043722922,
      "responseAtMs": 1793043722943,
      "before": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152055"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "other",
            "bearer_hash": "b9d2d9a355e33b2490ee66584157fe9fd286d5899cc5e8bb8ca88fbe4d764bd0",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152061"
          },
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152059"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152056"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152057"
          }
        ],
        "packages": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "dependent_id": "installation",
            "owner_id": "system:reader",
            "phase": "removed",
            "revision": "5152071"
          }
        ],
        "canonical": [
          {
            "id": "organic",
            "payload": {
              "data": "zephyrdispatchmemory organic",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152062"
          },
          {
            "id": "pinned",
            "payload": {
              "data": "zephyrdispatchmemory pinned",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "source": "pack",
              "pack_id": "p001-pack",
              "user_id": "harness:p001-home",
              "pack_item_id": "note",
              "pack_version": "1.0.0",
              "identity_package_resource": "resource-v1"
            },
            "state": "archived",
            "revision": "5152064"
          }
        ]
      },
      "after": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152055"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "other",
            "bearer_hash": "b9d2d9a355e33b2490ee66584157fe9fd286d5899cc5e8bb8ca88fbe4d764bd0",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152061"
          },
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152059"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152056"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152057"
          }
        ],
        "packages": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "dependent_id": "installation",
            "owner_id": "system:reader",
            "phase": "removed",
            "revision": "5152071"
          }
        ],
        "canonical": [
          {
            "id": "organic",
            "payload": {
              "data": "zephyrdispatchmemory organic",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152062"
          },
          {
            "id": "pinned",
            "payload": {
              "data": "zephyrdispatchmemory pinned",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "source": "pack",
              "pack_id": "p001-pack",
              "user_id": "harness:p001-home",
              "pack_item_id": "note",
              "pack_version": "1.0.0",
              "identity_package_resource": "resource-v1"
            },
            "state": "archived",
            "revision": "5152064"
          }
        ]
      },
      "output": {
        "ok": true,
        "results": [
          {
            "id": "organic",
            "memory": "zephyrdispatchmemory organic",
            "metadata": {
              "data": "zephyrdispatchmemory organic",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "score": 0.03278688524590164
          }
        ],
        "score_scale": "rrf"
      },
      "expected": [
        "organic"
      ],
      "fixtureAuthorityEpoch": "57d3a6823484650213125d87f247dd0189d2f7668d96fd25e0d625e5ca5b0de4",
      "fieldCurrentness": "unknown"
    },
    {
      "phase": "grant-revoked-after-explicit-invalidation",
      "result": {
        "ok": false,
        "error": {
          "code": "missing_capability",
          "message": "Principal system:reader lacks capability \"memory:search:read\" (tool: memory:search)"
        }
      }
    },
    {
      "mode": "lexical-fallback",
      "phase": "authenticated-wearer",
      "request": {
        "query": "zephyrdispatchmemory",
        "limit": 20,
        "harness_slug": "p001-home",
        "harnessOnly": true
      },
      "tokenHash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
      "path": "dispatch → resolveBearer → Standard Schema → withWorkspace → memory:search → hybrid/canonical",
      "startedAtMs": 1793043722980,
      "responseAtMs": 1793043723018,
      "before": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152075"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "other",
            "bearer_hash": "b9d2d9a355e33b2490ee66584157fe9fd286d5899cc5e8bb8ca88fbe4d764bd0",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152081"
          },
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152079"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152076"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152077"
          }
        ],
        "packages": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "dependent_id": "installation",
            "owner_id": "system:reader",
            "phase": "applied",
            "revision": "5152086"
          }
        ],
        "canonical": [
          {
            "id": "organic",
            "payload": {
              "data": "zephyrdispatchmemory organic",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152082"
          },
          {
            "id": "pinned",
            "payload": {
              "data": "zephyrdispatchmemory pinned",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "source": "pack",
              "pack_id": "p001-pack",
              "user_id": "harness:p001-home",
              "pack_item_id": "note",
              "pack_version": "1.0.0",
              "identity_package_resource": "resource-v1"
            },
            "state": "archived",
            "revision": "5152084"
          }
        ]
      },
      "after": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152075"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "other",
            "bearer_hash": "b9d2d9a355e33b2490ee66584157fe9fd286d5899cc5e8bb8ca88fbe4d764bd0",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152081"
          },
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152079"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152076"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152077"
          }
        ],
        "packages": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "dependent_id": "installation",
            "owner_id": "system:reader",
            "phase": "applied",
            "revision": "5152086"
          }
        ],
        "canonical": [
          {
            "id": "organic",
            "payload": {
              "data": "zephyrdispatchmemory organic",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152082"
          },
          {
            "id": "pinned",
            "payload": {
              "data": "zephyrdispatchmemory pinned",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "source": "pack",
              "pack_id": "p001-pack",
              "user_id": "harness:p001-home",
              "pack_item_id": "note",
              "pack_version": "1.0.0",
              "identity_package_resource": "resource-v1"
            },
            "state": "archived",
            "revision": "5152084"
          }
        ]
      },
      "output": {
        "ok": true,
        "results": [
          {
            "id": "pinned",
            "memory": "zephyrdispatchmemory pinned",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "source": "pack",
              "pack_id": "p001-pack",
              "pack_item_id": "note",
              "pack_version": "1.0.0",
              "identity_package_resource": "resource-v1",
              "identity_package": {
                "pack_id": "p001-pack",
                "pack_version": "1.0.0",
                "pack_item_id": "note",
                "pinned": true
              }
            },
            "score": 1.15
          },
          {
            "id": "organic",
            "memory": "zephyrdispatchmemory organic",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory"
            },
            "score": 1
          }
        ],
        "score_scale": "lexical",
        "degraded": true,
        "degraded_reason": "memory_timeout",
        "fallback": "lexical"
      },
      "expected": [
        "organic",
        "pinned"
      ],
      "fixtureAuthorityEpoch": "d9b8e42c305fbb8264626bcc3def333fd0b08ff01796527410e01be14a0f9265",
      "fieldCurrentness": "unknown"
    },
    {
      "mode": "lexical-fallback",
      "phase": "different-authenticated-wearer",
      "request": {
        "query": "zephyrdispatchmemory",
        "limit": 20,
        "harness_slug": "p001-home",
        "harnessOnly": true
      },
      "tokenHash": "b9d2d9a355e33b2490ee66584157fe9fd286d5899cc5e8bb8ca88fbe4d764bd0",
      "path": "dispatch → resolveBearer → Standard Schema → withWorkspace → memory:search → hybrid/canonical",
      "startedAtMs": 1793043723019,
      "responseAtMs": 1793043723042,
      "before": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152075"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "other",
            "bearer_hash": "b9d2d9a355e33b2490ee66584157fe9fd286d5899cc5e8bb8ca88fbe4d764bd0",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152081"
          },
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152079"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152076"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152077"
          }
        ],
        "packages": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "dependent_id": "installation",
            "owner_id": "system:reader",
            "phase": "applied",
            "revision": "5152086"
          }
        ],
        "canonical": [
          {
            "id": "organic",
            "payload": {
              "data": "zephyrdispatchmemory organic",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152082"
          },
          {
            "id": "pinned",
            "payload": {
              "data": "zephyrdispatchmemory pinned",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "source": "pack",
              "pack_id": "p001-pack",
              "user_id": "harness:p001-home",
              "pack_item_id": "note",
              "pack_version": "1.0.0",
              "identity_package_resource": "resource-v1"
            },
            "state": "archived",
            "revision": "5152084"
          }
        ]
      },
      "after": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152075"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "other",
            "bearer_hash": "b9d2d9a355e33b2490ee66584157fe9fd286d5899cc5e8bb8ca88fbe4d764bd0",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152081"
          },
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152079"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152076"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152077"
          }
        ],
        "packages": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "dependent_id": "installation",
            "owner_id": "system:reader",
            "phase": "applied",
            "revision": "5152086"
          }
        ],
        "canonical": [
          {
            "id": "organic",
            "payload": {
              "data": "zephyrdispatchmemory organic",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152082"
          },
          {
            "id": "pinned",
            "payload": {
              "data": "zephyrdispatchmemory pinned",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "source": "pack",
              "pack_id": "p001-pack",
              "user_id": "harness:p001-home",
              "pack_item_id": "note",
              "pack_version": "1.0.0",
              "identity_package_resource": "resource-v1"
            },
            "state": "archived",
            "revision": "5152084"
          }
        ]
      },
      "output": {
        "ok": true,
        "results": [
          {
            "id": "organic",
            "memory": "zephyrdispatchmemory organic",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory"
            },
            "score": 1
          }
        ],
        "score_scale": "lexical",
        "degraded": true,
        "degraded_reason": "memory_timeout",
        "fallback": "lexical"
      },
      "expected": [
        "organic"
      ],
      "fixtureAuthorityEpoch": "d9b8e42c305fbb8264626bcc3def333fd0b08ff01796527410e01be14a0f9265",
      "fieldCurrentness": "unknown"
    },
    {
      "mode": "lexical-fallback",
      "phase": "package-revoked",
      "request": {
        "query": "zephyrdispatchmemory",
        "limit": 20,
        "harness_slug": "p001-home",
        "harnessOnly": true
      },
      "tokenHash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
      "path": "dispatch → resolveBearer → Standard Schema → withWorkspace → memory:search → hybrid/canonical",
      "startedAtMs": 1793043723043,
      "responseAtMs": 1793043723063,
      "before": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152075"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "other",
            "bearer_hash": "b9d2d9a355e33b2490ee66584157fe9fd286d5899cc5e8bb8ca88fbe4d764bd0",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152081"
          },
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152079"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152076"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152077"
          }
        ],
        "packages": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "dependent_id": "installation",
            "owner_id": "system:reader",
            "phase": "removed",
            "revision": "5152091"
          }
        ],
        "canonical": [
          {
            "id": "organic",
            "payload": {
              "data": "zephyrdispatchmemory organic",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152082"
          },
          {
            "id": "pinned",
            "payload": {
              "data": "zephyrdispatchmemory pinned",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "source": "pack",
              "pack_id": "p001-pack",
              "user_id": "harness:p001-home",
              "pack_item_id": "note",
              "pack_version": "1.0.0",
              "identity_package_resource": "resource-v1"
            },
            "state": "archived",
            "revision": "5152084"
          }
        ]
      },
      "after": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152075"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "other",
            "bearer_hash": "b9d2d9a355e33b2490ee66584157fe9fd286d5899cc5e8bb8ca88fbe4d764bd0",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152081"
          },
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152079"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152076"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152077"
          }
        ],
        "packages": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "dependent_id": "installation",
            "owner_id": "system:reader",
            "phase": "removed",
            "revision": "5152091"
          }
        ],
        "canonical": [
          {
            "id": "organic",
            "payload": {
              "data": "zephyrdispatchmemory organic",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152082"
          },
          {
            "id": "pinned",
            "payload": {
              "data": "zephyrdispatchmemory pinned",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "source": "pack",
              "pack_id": "p001-pack",
              "user_id": "harness:p001-home",
              "pack_item_id": "note",
              "pack_version": "1.0.0",
              "identity_package_resource": "resource-v1"
            },
            "state": "archived",
            "revision": "5152084"
          }
        ]
      },
      "output": {
        "ok": true,
        "results": [
          {
            "id": "organic",
            "memory": "zephyrdispatchmemory organic",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory"
            },
            "score": 1
          }
        ],
        "score_scale": "lexical",
        "degraded": true,
        "degraded_reason": "memory_timeout",
        "fallback": "lexical"
      },
      "expected": [
        "organic"
      ],
      "fixtureAuthorityEpoch": "b3e649e87824fce083dd310dcd72c5faa156f6540952121148db2f1d471083a1",
      "fieldCurrentness": "unknown"
    },
    {
      "phase": "grant-revoked-after-explicit-invalidation",
      "result": {
        "ok": false,
        "error": {
          "code": "missing_capability",
          "message": "Principal system:reader lacks capability \"memory:search:read\" (tool: memory:search)"
        }
      }
    },
    {
      "mode": "hybrid",
      "phase": "session-hive-clamp",
      "request": {
        "query": "zephyrdispatchmemory",
        "limit": 20
      },
      "tokenHash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
      "session": {
        "harnessSlug": "p001-home"
      },
      "path": "resolveBearer → dispatchProjectedTool → memory:search → hybrid/canonical",
      "startedAtMs": 1793043723149,
      "responseAtMs": 1793043723186,
      "before": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152095"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "judge",
            "bearer_hash": "99659cfbda8c98539d44c4c703f8d16524414bffa766d39b849a5b9861455367",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152101"
          },
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152099"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152096"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152097"
          }
        ],
        "packages": [],
        "canonical": [
          {
            "id": "child",
            "payload": {
              "data": "zephyrdispatchmemory child",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-child"
            },
            "state": "active",
            "revision": "5152104"
          },
          {
            "id": "home",
            "payload": {
              "data": "zephyrdispatchmemory home",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152102"
          },
          {
            "id": "personal",
            "payload": {
              "data": "zephyrdispatchmemory personal",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-a"
            },
            "state": "active",
            "revision": "5152108"
          },
          {
            "id": "sibling",
            "payload": {
              "data": "zephyrdispatchmemory sibling",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-sibling"
            },
            "state": "active",
            "revision": "5152106"
          }
        ]
      },
      "after": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152095"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "judge",
            "bearer_hash": "99659cfbda8c98539d44c4c703f8d16524414bffa766d39b849a5b9861455367",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152101"
          },
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152099"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152096"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152097"
          }
        ],
        "packages": [],
        "canonical": [
          {
            "id": "child",
            "payload": {
              "data": "zephyrdispatchmemory child",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-child"
            },
            "state": "active",
            "revision": "5152104"
          },
          {
            "id": "home",
            "payload": {
              "data": "zephyrdispatchmemory home",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152102"
          },
          {
            "id": "personal",
            "payload": {
              "data": "zephyrdispatchmemory personal",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-a"
            },
            "state": "active",
            "revision": "5152108"
          },
          {
            "id": "sibling",
            "payload": {
              "data": "zephyrdispatchmemory sibling",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-sibling"
            },
            "state": "active",
            "revision": "5152106"
          }
        ]
      },
      "output": {
        "ok": true,
        "results": [
          {
            "id": "personal",
            "memory": "zephyrdispatchmemory personal",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "workspace_id": "p001-memory-dispatch-a"
            },
            "score": 0.03278688524590164
          },
          {
            "id": "home",
            "memory": "zephyrdispatchmemory home",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory"
            },
            "score": 0.03225806451612903
          },
          {
            "id": "child",
            "memory": "zephyrdispatchmemory child",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory"
            },
            "score": 0.031746031746031744
          }
        ],
        "score_scale": "rrf"
      },
      "expected": [
        "home",
        "child",
        "personal"
      ],
      "fixtureAuthorityEpoch": "76221ae34f569ee35eb4d6037f96f093be65317a8e03dfffb1a4c741e1ff5081",
      "fieldCurrentness": "unknown"
    },
    {
      "mode": "hybrid",
      "phase": "judge-own-harness",
      "request": {
        "query": "zephyrdispatchmemory",
        "limit": 20
      },
      "tokenHash": "99659cfbda8c98539d44c4c703f8d16524414bffa766d39b849a5b9861455367",
      "session": {
        "harnessSlug": "p001-child",
        "judge": true
      },
      "path": "resolveBearer → dispatchProjectedTool → memory:search → hybrid/canonical",
      "startedAtMs": 1793043723187,
      "responseAtMs": 1793043723210,
      "before": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152095"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "judge",
            "bearer_hash": "99659cfbda8c98539d44c4c703f8d16524414bffa766d39b849a5b9861455367",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152101"
          },
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152099"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152096"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152097"
          }
        ],
        "packages": [],
        "canonical": [
          {
            "id": "child",
            "payload": {
              "data": "zephyrdispatchmemory child",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-child"
            },
            "state": "active",
            "revision": "5152104"
          },
          {
            "id": "home",
            "payload": {
              "data": "zephyrdispatchmemory home",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152102"
          },
          {
            "id": "personal",
            "payload": {
              "data": "zephyrdispatchmemory personal",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-a"
            },
            "state": "active",
            "revision": "5152108"
          },
          {
            "id": "sibling",
            "payload": {
              "data": "zephyrdispatchmemory sibling",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-sibling"
            },
            "state": "active",
            "revision": "5152106"
          }
        ]
      },
      "after": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152095"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "judge",
            "bearer_hash": "99659cfbda8c98539d44c4c703f8d16524414bffa766d39b849a5b9861455367",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152101"
          },
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152099"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152096"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152097"
          }
        ],
        "packages": [],
        "canonical": [
          {
            "id": "child",
            "payload": {
              "data": "zephyrdispatchmemory child",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-child"
            },
            "state": "active",
            "revision": "5152104"
          },
          {
            "id": "home",
            "payload": {
              "data": "zephyrdispatchmemory home",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152102"
          },
          {
            "id": "personal",
            "payload": {
              "data": "zephyrdispatchmemory personal",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-a"
            },
            "state": "active",
            "revision": "5152108"
          },
          {
            "id": "sibling",
            "payload": {
              "data": "zephyrdispatchmemory sibling",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-sibling"
            },
            "state": "active",
            "revision": "5152106"
          }
        ]
      },
      "output": {
        "ok": true,
        "results": [
          {
            "id": "child",
            "memory": "zephyrdispatchmemory child",
            "metadata": {
              "data": "zephyrdispatchmemory child",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-child"
            },
            "score": 0.03278688524590164
          }
        ],
        "score_scale": "rrf"
      },
      "expected": [
        "child"
      ],
      "fixtureAuthorityEpoch": "76221ae34f569ee35eb4d6037f96f093be65317a8e03dfffb1a4c741e1ff5081",
      "fieldCurrentness": "unknown"
    },
    {
      "phase": "judge-foreign-harness-refused",
      "result": {
        "ok": true,
        "result": {
          "content": [
            {
              "type": "text",
              "text": "{\"ok\":false,\"reason\":\"judge_harness_scope_mismatch\",\"results\":[]}"
            },
            {
              "type": "text",
              "text": "See also: memory:remember (write a new durable fact); memory:list (filter-only lookup by exact metadata — faster than vector search); memory:forget (drop a recalled hit the user contradicted)"
            }
          ],
          "_meta": {
            "explicitFullRequest": true,
            "format": "json",
            "structured": true,
            "_seeAlso": [
              {
                "tool": "memory:remember (write a new durable fact)"
              },
              {
                "tool": "memory:list (filter-only lookup by exact metadata — faster than vector search)"
              },
              {
                "tool": "memory:forget (drop a recalled hit the user contradicted)"
              }
            ]
          },
          "structuredContent": {
            "ok": false,
            "reason": "judge_harness_scope_mismatch",
            "results": []
          }
        }
      }
    },
    {
      "mode": "lexical-fallback",
      "phase": "session-hive-clamp",
      "request": {
        "query": "zephyrdispatchmemory",
        "limit": 20
      },
      "tokenHash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
      "session": {
        "harnessSlug": "p001-home"
      },
      "path": "resolveBearer → dispatchProjectedTool → memory:search → hybrid/canonical",
      "startedAtMs": 1793043723247,
      "responseAtMs": 1793043723271,
      "before": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152113"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "judge",
            "bearer_hash": "99659cfbda8c98539d44c4c703f8d16524414bffa766d39b849a5b9861455367",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152119"
          },
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152117"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152114"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152115"
          }
        ],
        "packages": [],
        "canonical": [
          {
            "id": "child",
            "payload": {
              "data": "zephyrdispatchmemory child",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-child"
            },
            "state": "active",
            "revision": "5152122"
          },
          {
            "id": "home",
            "payload": {
              "data": "zephyrdispatchmemory home",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152120"
          },
          {
            "id": "personal",
            "payload": {
              "data": "zephyrdispatchmemory personal",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-a"
            },
            "state": "active",
            "revision": "5152126"
          },
          {
            "id": "sibling",
            "payload": {
              "data": "zephyrdispatchmemory sibling",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-sibling"
            },
            "state": "active",
            "revision": "5152124"
          }
        ]
      },
      "after": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152113"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "judge",
            "bearer_hash": "99659cfbda8c98539d44c4c703f8d16524414bffa766d39b849a5b9861455367",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152119"
          },
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152117"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152114"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152115"
          }
        ],
        "packages": [],
        "canonical": [
          {
            "id": "child",
            "payload": {
              "data": "zephyrdispatchmemory child",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-child"
            },
            "state": "active",
            "revision": "5152122"
          },
          {
            "id": "home",
            "payload": {
              "data": "zephyrdispatchmemory home",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152120"
          },
          {
            "id": "personal",
            "payload": {
              "data": "zephyrdispatchmemory personal",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-a"
            },
            "state": "active",
            "revision": "5152126"
          },
          {
            "id": "sibling",
            "payload": {
              "data": "zephyrdispatchmemory sibling",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-sibling"
            },
            "state": "active",
            "revision": "5152124"
          }
        ]
      },
      "output": {
        "ok": true,
        "results": [
          {
            "id": "personal",
            "memory": "zephyrdispatchmemory personal",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "workspace_id": "p001-memory-dispatch-a"
            },
            "score": 1
          },
          {
            "id": "home",
            "memory": "zephyrdispatchmemory home",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory"
            },
            "score": 1
          },
          {
            "id": "child",
            "memory": "zephyrdispatchmemory child",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory"
            },
            "score": 1
          }
        ],
        "score_scale": "lexical",
        "degraded": true,
        "degraded_reason": "memory_timeout",
        "fallback": "lexical"
      },
      "expected": [
        "home",
        "child",
        "personal"
      ],
      "fixtureAuthorityEpoch": "14d4578a6b3cd5183b02da29d00f6d288e9251bf187a90304aed9d6e9cc11c19",
      "fieldCurrentness": "unknown"
    },
    {
      "mode": "lexical-fallback",
      "phase": "judge-own-harness",
      "request": {
        "query": "zephyrdispatchmemory",
        "limit": 20
      },
      "tokenHash": "99659cfbda8c98539d44c4c703f8d16524414bffa766d39b849a5b9861455367",
      "session": {
        "harnessSlug": "p001-child",
        "judge": true
      },
      "path": "resolveBearer → dispatchProjectedTool → memory:search → hybrid/canonical",
      "startedAtMs": 1793043723273,
      "responseAtMs": 1793043723295,
      "before": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152113"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "judge",
            "bearer_hash": "99659cfbda8c98539d44c4c703f8d16524414bffa766d39b849a5b9861455367",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152119"
          },
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152117"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152114"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152115"
          }
        ],
        "packages": [],
        "canonical": [
          {
            "id": "child",
            "payload": {
              "data": "zephyrdispatchmemory child",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-child"
            },
            "state": "active",
            "revision": "5152122"
          },
          {
            "id": "home",
            "payload": {
              "data": "zephyrdispatchmemory home",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152120"
          },
          {
            "id": "personal",
            "payload": {
              "data": "zephyrdispatchmemory personal",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-a"
            },
            "state": "active",
            "revision": "5152126"
          },
          {
            "id": "sibling",
            "payload": {
              "data": "zephyrdispatchmemory sibling",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-sibling"
            },
            "state": "active",
            "revision": "5152124"
          }
        ]
      },
      "after": {
        "users": [
          {
            "id": "p001-default-user",
            "username": "default",
            "is_active": true,
            "revision": "5152113"
          }
        ],
        "principals": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "judge",
            "bearer_hash": "99659cfbda8c98539d44c4c703f8d16524414bffa766d39b849a5b9861455367",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152119"
          },
          {
            "workspace_id": "p001-memory-dispatch-a",
            "name": "reader",
            "bearer_hash": "42d1a78c63ca7d7561b9ee79698707047840fc0cf000cc933baf2ef02ce430a4",
            "capabilities": [
              "memory:search:read"
            ],
            "revision": "5152117"
          }
        ],
        "registry": [
          {
            "workspace_id": "p001-memory-dispatch-a",
            "payload": {
              "projects": [
                {
                  "slug": "p001-home",
                  "harness_kind": "hive"
                },
                {
                  "slug": "p001-child",
                  "hive_slug": "p001-home"
                },
                {
                  "slug": "p001-sibling",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152114"
          },
          {
            "workspace_id": "p001-memory-dispatch-b",
            "payload": {
              "projects": [
                {
                  "slug": "p001-foreign",
                  "harness_kind": "hive"
                }
              ]
            },
            "revision": "5152115"
          }
        ],
        "packages": [],
        "canonical": [
          {
            "id": "child",
            "payload": {
              "data": "zephyrdispatchmemory child",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-child"
            },
            "state": "active",
            "revision": "5152122"
          },
          {
            "id": "home",
            "payload": {
              "data": "zephyrdispatchmemory home",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-home"
            },
            "state": "active",
            "revision": "5152120"
          },
          {
            "id": "personal",
            "payload": {
              "data": "zephyrdispatchmemory personal",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "p001-default-user",
              "workspace_id": "p001-memory-dispatch-a"
            },
            "state": "active",
            "revision": "5152126"
          },
          {
            "id": "sibling",
            "payload": {
              "data": "zephyrdispatchmemory sibling",
              "kind": "project",
              "name": "zephyrdispatchmemory",
              "user_id": "harness:p001-sibling"
            },
            "state": "active",
            "revision": "5152124"
          }
        ]
      },
      "output": {
        "ok": true,
        "results": [
          {
            "id": "child",
            "memory": "zephyrdispatchmemory child",
            "metadata": {
              "kind": "project",
              "name": "zephyrdispatchmemory"
            },
            "score": 1
          }
        ],
        "score_scale": "lexical",
        "degraded": true,
        "degraded_reason": "memory_timeout",
        "fallback": "lexical"
      },
      "expected": [
        "child"
      ],
      "fixtureAuthorityEpoch": "14d4578a6b3cd5183b02da29d00f6d288e9251bf187a90304aed9d6e9cc11c19",
      "fieldCurrentness": "unknown"
    },
    {
      "phase": "judge-foreign-harness-refused",
      "result": {
        "ok": true,
        "result": {
          "content": [
            {
              "type": "text",
              "text": "{\"ok\":false,\"reason\":\"judge_harness_scope_mismatch\",\"results\":[]}"
            },
            {
              "type": "text",
              "text": "See also: memory:remember (write a new durable fact); memory:list (filter-only lookup by exact metadata — faster than vector search); memory:forget (drop a recalled hit the user contradicted)"
            }
          ],
          "_meta": {
            "explicitFullRequest": true,
            "format": "json",
            "structured": true,
            "_seeAlso": [
              {
                "tool": "memory:remember (write a new durable fact)"
              },
              {
                "tool": "memory:list (filter-only lookup by exact metadata — faster than vector search)"
              },
              {
                "tool": "memory:forget (drop a recalled hit the user contradicted)"
              }
            ]
          },
          "structuredContent": {
            "ok": false,
            "reason": "judge_harness_scope_mismatch",
            "results": []
          }
        }
      }
    }
  ],
  "fieldCurrentness": "unknown",
  "limits": [
    "Private minimal PG schema and admin connection shim; production RLS/connection middleware unmeasured.",
    "Real persisted system bearer resolution/dispatch; host HTTP/cookie/spawn authentication and PI grants unmeasured.",
    "Actual user helper selects single-user default without an ambient browser cookie; multi-user browser binding unmeasured.",
    "Projected session harness/role are fixture inputs after real bearer resolution; host derivation unmeasured.",
    "Grant invalidation API is real; NOTIFY transport, TTL expiry and cross-process epochs unmeasured.",
    "Controlled embeddings, single-scope client facade, flags and ancillary ranking; quality/ingestion/index/freshness/budget/runtime closure unmeasured.",
    "Canonical value equality and fixture authority fingerprint are contributing evidence, not production field freshness."
  ]
}

