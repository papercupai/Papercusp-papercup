---
rel_path: "evidence/shared-search-restart-papercusp-2026-10-22/host-authority-recovery-20261027/capture.json"
updated_at: 1793066155161
_body: "content"
---

{
  "schemaVersion": "p001-host-authority-capture-v1",
  "sourcePins": [
    {
      "path": "packages/operator-core/lib/agent-tools/memory/host-authority-source-freshness.integration.test.ts",
      "sha256": "e37c43d77d8afe7200781410979d9c578a01e9ba59ad25867f3a0effcf4bcbd5"
    },
    {
      "path": "packages/operator-core/lib/endpoint-route/routes/transport/_mcp-host.ts",
      "sha256": "0c31d2c6882743864c3efa9aaa2ae57d7d24d88ae0151b2ff4d219819d899ec2"
    },
    {
      "path": "packages/operator-core/lib/endpoint-route/routes/transport/role-principal-caps.ts",
      "sha256": "ddf02bc62b1ec4a2b413140b6c391a163649842f930ac75358ddeef80f2c5400"
    },
    {
      "path": "packages/operator-core/lib/superuser-token.ts",
      "sha256": "9643462069a27d517102cb27205ed13fc857e1b997f2c1a692f0ba7deaafabdf"
    },
    {
      "path": "packages/operator-core/lib/power-user-token.ts",
      "sha256": "3b1d6b902d281ea01b0af9d04bfee8780c440e77755b8bdf9b84931cf22ba1b3"
    },
    {
      "path": "packages/operator-core/lib/spawn-signing.ts",
      "sha256": "cef22ce0fa3343eefb27a1dfede02c06a7bc181fd765faee397e3e76b30430a6"
    },
    {
      "path": "packages/operator-core/lib/connected-apps/key.ts",
      "sha256": "b9f8e0898557b48e8bf173b9f0774212be274da43fadc23301023c0b87f2688d"
    },
    {
      "path": "packages/operator-core/lib/connected-apps/principal.ts",
      "sha256": "f19ddf98de5475fa64ae6f6615a51a86b22ca459ff663040eae374f207bdc9e4"
    },
    {
      "path": "packages/operator-core/lib/connected-apps/store.ts",
      "sha256": "b03d31485b30b6da43c58cdd7b1ffd0dbb30ab8e8bd85134805e1ec1e081eb46"
    },
    {
      "path": "packages/operator-core/lib/agent-tools/memory/search.ts",
      "sha256": "82e61cb6794055d1e3ee325ecb05d65228cef635117521e115cb9b77e0fe258e"
    },
    {
      "path": "libs/generic/tooldef/src/dispatch-stack.ts",
      "sha256": "aa47f53e311350744aa47910dea852419e21fc816d4157f75782e9e9d78d4588"
    }
  ],
  "sourceStable": true,
  "cleanup": "dropped",
  "completed": [
    "superuser",
    "power-user",
    "connected-app",
    "signed-spawn",
    "power-key-epoch",
    "spawn-key-epoch"
  ],
  "receipts": [
    {
      "phase": "authority",
      "workspace": "p001-host-authority",
      "role": "operator",
      "superuser": true,
      "powerUser": false,
      "signed": false,
      "principal": {
        "kind": "system",
        "slug": "system:operator",
        "workspace": "p001-host-authority",
        "capabilities": []
      }
    },
    {
      "phase": "dispatch",
      "rpc": {
        "result": {
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
          "content": [
            {
              "type": "text",
              "text": "{\"ok\":true,\"results\":[{\"id\":\"p001-authority-default-hit\",\"memory\":\"authority sentinel\",\"score\":0.9}],\"score_scale\":\"cosine\"}"
            },
            {
              "type": "text",
              "text": "See also: memory:remember (write a new durable fact); memory:list (filter-only lookup by exact metadata — faster than vector search); memory:forget (drop a recalled hit the user contradicted)"
            }
          ],
          "structuredContent": {
            "ok": true,
            "results": [
              {
                "id": "p001-authority-default-hit",
                "memory": "authority sentinel",
                "score": 0.9
              }
            ],
            "score_scale": "cosine"
          }
        },
        "jsonrpc": "2.0",
        "id": 1
      },
      "scopes": [
        [
          "p001-authority-default"
        ]
      ]
    },
    {
      "phase": "refusal",
      "auth": {
        "kind": "failed",
        "reason": "superuser_invalid_bearer"
      },
      "backendCalls": 1
    },
    {
      "phase": "dispatch",
      "rpc": {
        "result": {
          "content": [
            {
              "type": "text",
              "text": "{\"kind\":\"failed\",\"reason\":\"superuser_invalid_bearer\"}"
            }
          ],
          "isError": true
        },
        "jsonrpc": "2.0",
        "id": 1
      },
      "scopes": [
        [
          "p001-authority-default"
        ]
      ]
    },
    {
      "phase": "refusal",
      "auth": {
        "kind": "failed",
        "reason": "superuser_non_loopback"
      },
      "backendCalls": 1
    },
    {
      "phase": "dispatch",
      "rpc": {
        "result": {
          "content": [
            {
              "type": "text",
              "text": "{\"kind\":\"failed\",\"reason\":\"superuser_non_loopback\"}"
            }
          ],
          "isError": true
        },
        "jsonrpc": "2.0",
        "id": 1
      },
      "scopes": [
        [
          "p001-authority-default"
        ]
      ]
    },
    {
      "phase": "authority",
      "workspace": "p001-host-authority",
      "role": "operator",
      "superuser": true,
      "powerUser": true,
      "signed": false,
      "principal": {
        "kind": "system",
        "slug": "system:operator",
        "workspace": "p001-host-authority",
        "capabilities": []
      }
    },
    {
      "phase": "dispatch",
      "rpc": {
        "result": {
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
          "content": [
            {
              "type": "text",
              "text": "{\"ok\":true,\"results\":[{\"id\":\"p001-authority-default-hit\",\"memory\":\"authority sentinel\",\"score\":0.9}],\"score_scale\":\"cosine\"}"
            },
            {
              "type": "text",
              "text": "See also: memory:remember (write a new durable fact); memory:list (filter-only lookup by exact metadata — faster than vector search); memory:forget (drop a recalled hit the user contradicted)"
            }
          ],
          "structuredContent": {
            "ok": true,
            "results": [
              {
                "id": "p001-authority-default-hit",
                "memory": "authority sentinel",
                "score": 0.9
              }
            ],
            "score_scale": "cosine"
          }
        },
        "jsonrpc": "2.0",
        "id": 1
      },
      "scopes": [
        [
          "p001-authority-default"
        ]
      ]
    },
    {
      "phase": "refusal",
      "auth": {
        "kind": "failed",
        "reason": "power_user_invalid_token"
      },
      "backendCalls": 1
    },
    {
      "phase": "dispatch",
      "rpc": {
        "result": {
          "content": [
            {
              "type": "text",
              "text": "{\"kind\":\"failed\",\"reason\":\"power_user_invalid_token\"}"
            }
          ],
          "isError": true
        },
        "jsonrpc": "2.0",
        "id": 1
      },
      "scopes": [
        [
          "p001-authority-default"
        ]
      ]
    },
    {
      "phase": "refusal",
      "auth": {
        "kind": "failed",
        "reason": "power_user_invalid_token"
      },
      "backendCalls": 1
    },
    {
      "phase": "dispatch",
      "rpc": {
        "result": {
          "content": [
            {
              "type": "text",
              "text": "{\"kind\":\"failed\",\"reason\":\"power_user_invalid_token\"}"
            }
          ],
          "isError": true
        },
        "jsonrpc": "2.0",
        "id": 1
      },
      "scopes": [
        [
          "p001-authority-default"
        ]
      ]
    },
    {
      "phase": "refusal",
      "auth": {
        "kind": "failed",
        "reason": "power_user_non_loopback"
      },
      "backendCalls": 1
    },
    {
      "phase": "dispatch",
      "rpc": {
        "result": {
          "content": [
            {
              "type": "text",
              "text": "{\"kind\":\"failed\",\"reason\":\"power_user_non_loopback\"}"
            }
          ],
          "isError": true
        },
        "jsonrpc": "2.0",
        "id": 1
      },
      "scopes": [
        [
          "p001-authority-default"
        ]
      ]
    },
    {
      "phase": "authority",
      "workspace": "p001-host-authority",
      "role": "papercup",
      "superuser": false,
      "powerUser": false,
      "signed": false,
      "principal": {
        "kind": "service",
        "slug": "app:dnvw2MlStCmr4Ov4",
        "workspace": "p001-host-authority",
        "capabilities": [
          "memory:search:read"
        ]
      }
    },
    {
      "phase": "dispatch",
      "rpc": {
        "result": {
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
          "content": [
            {
              "type": "text",
              "text": "{\"ok\":true,\"results\":[{\"id\":\"p001-authority-default-hit\",\"memory\":\"authority sentinel\",\"score\":0.9}],\"score_scale\":\"cosine\"}"
            },
            {
              "type": "text",
              "text": "See also: memory:remember (write a new durable fact); memory:list (filter-only lookup by exact metadata — faster than vector search); memory:forget (drop a recalled hit the user contradicted)"
            }
          ],
          "structuredContent": {
            "ok": true,
            "results": [
              {
                "id": "p001-authority-default-hit",
                "memory": "authority sentinel",
                "score": 0.9
              }
            ],
            "score_scale": "cosine"
          }
        },
        "jsonrpc": "2.0",
        "id": 1
      },
      "scopes": [
        [
          "p001-authority-default"
        ]
      ]
    },
    {
      "phase": "refusal",
      "auth": {
        "kind": "failed",
        "reason": "connected_app_workspace_mismatch"
      },
      "backendCalls": 1
    },
    {
      "phase": "dispatch",
      "rpc": {
        "result": {
          "content": [
            {
              "type": "text",
              "text": "{\"kind\":\"failed\",\"reason\":\"connected_app_workspace_mismatch\"}"
            }
          ],
          "isError": true
        },
        "jsonrpc": "2.0",
        "id": 1
      },
      "scopes": [
        [
          "p001-authority-default"
        ]
      ]
    },
    {
      "phase": "refusal",
      "auth": {
        "kind": "failed",
        "reason": "connected_app_forbidden_param:role"
      },
      "backendCalls": 1
    },
    {
      "phase": "dispatch",
      "rpc": {
        "result": {
          "content": [
            {
              "type": "text",
              "text": "{\"kind\":\"failed\",\"reason\":\"connected_app_forbidden_param:role\"}"
            }
          ],
          "isError": true
        },
        "jsonrpc": "2.0",
        "id": 1
      },
      "scopes": [
        [
          "p001-authority-default"
        ]
      ]
    },
    {
      "phase": "authority",
      "workspace": "p001-host-authority",
      "role": "papercup",
      "superuser": false,
      "powerUser": false,
      "signed": false,
      "principal": {
        "kind": "service",
        "slug": "app:fxxUZjeRyQdbMPtd",
        "workspace": "p001-host-authority",
        "capabilities": []
      }
    },
    {
      "phase": "dispatch",
      "rpc": {
        "result": {
          "content": [
            {
              "type": "text",
              "text": "missing_capability: Principal \"app:fxxUZjeRyQdbMPtd\" lacks capability \"memory:search:read\" (tool: memory:search)"
            }
          ],
          "isError": true
        },
        "jsonrpc": "2.0",
        "id": 1
      },
      "scopes": [
        [
          "p001-authority-default"
        ]
      ]
    },
    {
      "phase": "refusal",
      "auth": {
        "kind": "failed",
        "reason": "connected_app_invalid_key:revoked"
      },
      "backendCalls": 1
    },
    {
      "phase": "dispatch",
      "rpc": {
        "result": {
          "content": [
            {
              "type": "text",
              "text": "{\"kind\":\"failed\",\"reason\":\"connected_app_invalid_key:revoked\"}"
            }
          ],
          "isError": true
        },
        "jsonrpc": "2.0",
        "id": 1
      },
      "scopes": [
        [
          "p001-authority-default"
        ]
      ]
    },
    {
      "phase": "authority",
      "workspace": "p001-host-authority",
      "role": "operator",
      "superuser": false,
      "powerUser": false,
      "signed": true,
      "principal": {
        "kind": "harness",
        "slug": "system:operator",
        "workspace": "p001-host-authority",
        "capabilities": []
      }
    },
    {
      "phase": "dispatch",
      "rpc": {
        "result": {
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
          "content": [
            {
              "type": "text",
              "text": "{\"ok\":true,\"results\":[{\"id\":\"p001-authority-default-hit\",\"memory\":\"authority sentinel\",\"score\":0.9}],\"score_scale\":\"cosine\"}"
            },
            {
              "type": "text",
              "text": "See also: memory:remember (write a new durable fact); memory:list (filter-only lookup by exact metadata — faster than vector search); memory:forget (drop a recalled hit the user contradicted)"
            }
          ],
          "structuredContent": {
            "ok": true,
            "results": [
              {
                "id": "p001-authority-default-hit",
                "memory": "authority sentinel",
                "score": 0.9
              }
            ],
            "score_scale": "cosine"
          }
        },
        "jsonrpc": "2.0",
        "id": 1
      },
      "scopes": [
        [
          "p001-authority-default"
        ]
      ]
    },
    {
      "phase": "refusal",
      "auth": {
        "kind": "failed",
        "reason": "spawn_sig_invalid_signature — Your per-spawn signing credential is no longer valid — the spawn-signing key was rotated (coarse revocation), so EVERY native mcp__papercusp__* call from this session will keep failing identically. This session cannot self-heal by retrying. Recover NOW: route tool calls through scripts/mcp-call.mjs (superuser bearer — bypasses spawn-URL signing) and/or ask your leader/orchestrator to RE-SPAWN this session. Runbook: docs:search \"mcp-call.mjs recovery\" (EI-1740/EI-1750)."
      },
      "backendCalls": 1
    },
    {
      "phase": "dispatch",
      "rpc": {
        "result": {
          "content": [
            {
              "type": "text",
              "text": "{\"kind\":\"failed\",\"reason\":\"spawn_sig_invalid_signature — Your per-spawn signing credential is no longer valid — the spawn-signing key was rotated (coarse revocation), so EVERY native mcp__papercusp__* call from this session will keep failing identically. This session cannot self-heal by retrying. Recover NOW: route tool calls through scripts/mcp-call.mjs (superuser bearer — bypasses spawn-URL signing) and/or ask your leader/orchestrator to RE-SPAWN this session. Runbook: docs:search \\\"mcp-call.mjs recovery\\\" (EI-1740/EI-1750).\"}"
            }
          ],
          "isError": true
        },
        "jsonrpc": "2.0",
        "id": 1
      },
      "scopes": [
        [
          "p001-authority-default"
        ]
      ]
    },
    {
      "phase": "authority",
      "workspace": "p001-host-authority",
      "role": "operator",
      "superuser": true,
      "powerUser": true,
      "signed": false,
      "principal": {
        "kind": "system",
        "slug": "system:operator",
        "workspace": "p001-host-authority",
        "capabilities": []
      }
    },
    {
      "phase": "dispatch",
      "rpc": {
        "result": {
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
          "content": [
            {
              "type": "text",
              "text": "{\"ok\":true,\"results\":[{\"id\":\"p001-authority-default-hit\",\"memory\":\"authority sentinel\",\"score\":0.9}],\"score_scale\":\"cosine\"}"
            },
            {
              "type": "text",
              "text": "See also: memory:remember (write a new durable fact); memory:list (filter-only lookup by exact metadata — faster than vector search); memory:forget (drop a recalled hit the user contradicted)"
            }
          ],
          "structuredContent": {
            "ok": true,
            "results": [
              {
                "id": "p001-authority-default-hit",
                "memory": "authority sentinel",
                "score": 0.9
              }
            ],
            "score_scale": "cosine"
          }
        },
        "jsonrpc": "2.0",
        "id": 1
      },
      "scopes": [
        [
          "p001-authority-default"
        ]
      ]
    },
    {
      "phase": "refusal",
      "auth": {
        "kind": "failed",
        "reason": "power_user_invalid_token"
      },
      "backendCalls": 1
    },
    {
      "phase": "dispatch",
      "rpc": {
        "result": {
          "content": [
            {
              "type": "text",
              "text": "{\"kind\":\"failed\",\"reason\":\"power_user_invalid_token\"}"
            }
          ],
          "isError": true
        },
        "jsonrpc": "2.0",
        "id": 1
      },
      "scopes": [
        [
          "p001-authority-default"
        ]
      ]
    },
    {
      "phase": "authority",
      "workspace": "p001-host-authority",
      "role": "operator",
      "superuser": true,
      "powerUser": true,
      "signed": false,
      "principal": {
        "kind": "system",
        "slug": "system:operator",
        "workspace": "p001-host-authority",
        "capabilities": []
      }
    },
    {
      "phase": "dispatch",
      "rpc": {
        "result": {
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
          "content": [
            {
              "type": "text",
              "text": "{\"ok\":true,\"results\":[{\"id\":\"p001-authority-default-hit\",\"memory\":\"authority sentinel\",\"score\":0.9}],\"score_scale\":\"cosine\"}"
            },
            {
              "type": "text",
              "text": "See also: memory:remember (write a new durable fact); memory:list (filter-only lookup by exact metadata — faster than vector search); memory:forget (drop a recalled hit the user contradicted)"
            }
          ],
          "structuredContent": {
            "ok": true,
            "results": [
              {
                "id": "p001-authority-default-hit",
                "memory": "authority sentinel",
                "score": 0.9
              }
            ],
            "score_scale": "cosine"
          }
        },
        "jsonrpc": "2.0",
        "id": 1
      },
      "scopes": [
        [
          "p001-authority-default"
        ],
        [
          "p001-authority-default"
        ]
      ]
    },
    {
      "phase": "authority",
      "workspace": "p001-host-authority",
      "role": "operator",
      "superuser": false,
      "powerUser": false,
      "signed": true,
      "principal": {
        "kind": "harness",
        "slug": "system:operator",
        "workspace": "p001-host-authority",
        "capabilities": []
      }
    },
    {
      "phase": "dispatch",
      "rpc": {
        "result": {
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
          "content": [
            {
              "type": "text",
              "text": "{\"ok\":true,\"results\":[{\"id\":\"p001-authority-default-hit\",\"memory\":\"authority sentinel\",\"score\":0.9}],\"score_scale\":\"cosine\"}"
            },
            {
              "type": "text",
              "text": "See also: memory:remember (write a new durable fact); memory:list (filter-only lookup by exact metadata — faster than vector search); memory:forget (drop a recalled hit the user contradicted)"
            }
          ],
          "structuredContent": {
            "ok": true,
            "results": [
              {
                "id": "p001-authority-default-hit",
                "memory": "authority sentinel",
                "score": 0.9
              }
            ],
            "score_scale": "cosine"
          }
        },
        "jsonrpc": "2.0",
        "id": 1
      },
      "scopes": [
        [
          "p001-authority-default"
        ]
      ]
    },
    {
      "phase": "refusal",
      "auth": {
        "kind": "failed",
        "reason": "spawn_sig_invalid_signature — Your per-spawn signing credential is no longer valid — the spawn-signing key was rotated (coarse revocation), so EVERY native mcp__papercusp__* call from this session will keep failing identically. This session cannot self-heal by retrying. Recover NOW: route tool calls through scripts/mcp-call.mjs (superuser bearer — bypasses spawn-URL signing) and/or ask your leader/orchestrator to RE-SPAWN this session. Runbook: docs:search \"mcp-call.mjs recovery\" (EI-1740/EI-1750)."
      },
      "backendCalls": 1
    },
    {
      "phase": "dispatch",
      "rpc": {
        "result": {
          "content": [
            {
              "type": "text",
              "text": "{\"kind\":\"failed\",\"reason\":\"spawn_sig_invalid_signature — Your per-spawn signing credential is no longer valid — the spawn-signing key was rotated (coarse revocation), so EVERY native mcp__papercusp__* call from this session will keep failing identically. This session cannot self-heal by retrying. Recover NOW: route tool calls through scripts/mcp-call.mjs (superuser bearer — bypasses spawn-URL signing) and/or ask your leader/orchestrator to RE-SPAWN this session. Runbook: docs:search \\\"mcp-call.mjs recovery\\\" (EI-1740/EI-1750).\"}"
            }
          ],
          "isError": true
        },
        "jsonrpc": "2.0",
        "id": 1
      },
      "scopes": [
        [
          "p001-authority-default"
        ]
      ]
    },
    {
      "phase": "authority",
      "workspace": "p001-host-authority",
      "role": "operator",
      "superuser": false,
      "powerUser": false,
      "signed": true,
      "principal": {
        "kind": "harness",
        "slug": "system:operator",
        "workspace": "p001-host-authority",
        "capabilities": []
      }
    },
    {
      "phase": "dispatch",
      "rpc": {
        "result": {
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
          "content": [
            {
              "type": "text",
              "text": "{\"ok\":true,\"results\":[{\"id\":\"p001-authority-default-hit\",\"memory\":\"authority sentinel\",\"score\":0.9}],\"score_scale\":\"cosine\"}"
            },
            {
              "type": "text",
              "text": "See also: memory:remember (write a new durable fact); memory:list (filter-only lookup by exact metadata — faster than vector search); memory:forget (drop a recalled hit the user contradicted)"
            }
          ],
          "structuredContent": {
            "ok": true,
            "results": [
              {
                "id": "p001-authority-default-hit",
                "memory": "authority sentinel",
                "score": 0.9
              }
            ],
            "score_scale": "cosine"
          }
        },
        "jsonrpc": "2.0",
        "id": 1
      },
      "scopes": [
        [
          "p001-authority-default"
        ],
        [
          "p001-authority-default"
        ]
      ]
    }
  ],
  "limitations": [
    "Private admin PG and projected schema; no production middleware or RLS proof.",
    "Fixture SDK callback calls real host auth/context/dispatch; not registerMcpHost or browser HTTP.",
    "Controlled backend, flags and ranking; operator kernel/quota/telemetry and app alerts omitted.",
    "Persisted key epoch changes in one process; no independent-process, TTL or NOTIFY proof.",
    "SU fixture has no coordinated SID/native-session binding; those controls remain unqualified.",
    "No field/provider/index/quality/budget/runtime qualification or spec-binding upgrade."
  ]
}
