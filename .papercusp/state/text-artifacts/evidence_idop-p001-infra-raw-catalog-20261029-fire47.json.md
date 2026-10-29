---
rel_path: "evidence/idop-p001-infra-raw-catalog-20261029-fire47.json"
updated_at: 1793247281362
_body: "content"
---

{
  "schemaVersion": 1,
  "kind": "bounded-actual-infra-reviewer-sdk-catalog-with-native-provenance",
  "plan": "identity-definitions-own-policy-2026-10-17",
  "workItem": "WI-6554700010017386",
  "fire": 47,
  "capturedAt": "2026-10-29T04:13:49.564192+00:00",
  "acceptance": "OPEN",
  "canonicalAcceptance": false,
  "rawCatalog": {
    "path": "/tmp/idop-p001-infra-actual-catalog-fire47.json",
    "bytes": 91149,
    "sha256": "44bb7f39bab443da7988e4ce4aced8fcd60535bed019a2176b3c508d6a0f50dc",
    "observation": {
      "schemaVersion": 1,
      "kind": "actual-caller-sdk-catalog",
      "startedAt": "2026-10-29T04:09:52.917Z",
      "completedAt": "2026-10-29T04:09:56.788Z",
      "caller": {
        "ownerId": "su-6aeee7d5-ffe8-4c36-8a41-ebf47f30ab1a",
        "nativeSessionId": "01a185d7-dc46-7c01-8687-b13b70f208cb",
        "configuredRole": "infra-reviewer",
        "workspace": "papercusp-workspace",
        "harness": "papercusp",
        "configSha256": "a06113f0593d4a1b54ccf3b38ff894c392f1d2ff82058d9ac393903262cc52f3",
        "endpointSha256": "b1e607793715fd5da7a6d190fb1267d1d8d036d5207deadfada66552b2d5ebb4",
        "endpointOrigin": "http://127.0.0.1:9171",
        "endpointPath": "/api/mcp"
      },
      "transportKind": "http",
      "complete": true,
      "failure": null,
      "pages": [
        {
          "capturedAt": "2026-10-29T04:09:56.786Z",
          "request": {},
          "result": {
            "tools": [
              {
                "name": "code:run",
                "description": "Run a multi-step tool-orchestration JS script in one call with tools.ns.verb(args). Only the returned summary/media re-enters context; intermediate results stay in the runtime. Wrong names return typed signatures; dryRun:true previews write effects. Tool-name mapping is colon-to-dot: only the namespace/verb separator `:` becomes `.`, while `_` stays inside each segment (work_items:get → tools.work_items.get or tools.workItems.get; `tools:invoke` → tools.tools.invoke).",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "execution": {
                      "description": "Run once through the existing durable orchestration runtime. Returns durableRun.workflowId immediately; execution.timeoutSec is the independent execution deadline (default 3600s). Read status/output with orchestrate:inspect { durableRun:{workflowId} }; cancel with orchestrate:run { durableControl:{workflowId,action:\"cancel\"} } (via tools:invoke if not loaded). Use tools.runtime.sleep for checkpointed waits. Current authority is checked on every tool step; unsafe replay/nondeterminism is refused before admission. Cannot combine with a kernel, foreground timeoutSec, or dryRun.",
                      "type": "object",
                      "properties": {
                        "lifecycle": {
                          "type": "string",
                          "const": "background"
                        },
                        "durability": {
                          "type": "string",
                          "const": "durable"
                        },
                        "timeoutSec": {
                          "type": "integer",
                          "minimum": 1,
                          "maximum": 3600
                        }
                      },
                      "required": [
                        "lifecycle",
                        "durability"
                      ],
                      "additionalProperties": false
                    },
                    "kernel": {
                      "description": "JavaScript VM scoped to owner/workspace/harness: open creates id; run/status/close execute/read/cancel. State lives on globalThis, not lexical locals; current authority per cell. No Python/restart recovery; timeout/cancel/5m idle loses state. Refused on :3170/dryRun. Persist store output and replay via inputs after restart.",
                      "type": "object",
                      "properties": {
                        "op": {
                          "type": "string",
                          "enum": [
                            "open",
                            "run",
                            "status",
                            "close"
                          ]
                        },
                        "id": {
                          "type": "string",
                          "format": "uuid",
                          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                        }
                      },
                      "required": [
                        "op"
                      ],
                      "additionalProperties": false
                    },
                    "inputs": {
                      "description": "JSON replay state is deeply frozen. Clone nested values before mutation (JSON.parse(JSON.stringify(inputs.state))), or use store/load for state the script updates. Persist returned state and replay here after restart; arbitrary globalThis objects/functions cannot be restored.",
                      "type": "object",
                      "propertyNames": {
                        "type": "string",
                        "maxLength": 200
                      },
                      "additionalProperties": {}
                    },
                    "work_item_id": {
                      "description": "Default attribution for nested capability:bash: use the exact held WI-/EI-/F- id when holding several items. Explicit nested work_item_id overrides it.",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 120
                    },
                    "script": {
                      "description": "Plain JavaScript only; TypeScript annotations are unsupported. Call tools with `await tools.ns.verb(args)` and return a compact summary. Dynamic dispatch is `tools.tools.invoke({ name, args })`; recursive `code:run` and `orchestrate:run` calls are excluded. The sandbox exposes tools, not Node imports or an ambient shell. For shell access use `tools.capability.bash({ command })`; pass a held `work_item_id` when you hold multiple items. Nested calls return typed result roots (for bash: `output`, `exit_code`, `status`), not MCP `content`/`text`; `dev:pg_query` returns `rows`, `fields`, and `rowCount`. On timeout, `timeoutSettledReadRecovery.calls` contains only settled read-only results (up to 24 KiB/20 calls). Check `omittedReadCount`; writes are never recovered, and a slow sibling may not have settled. Use `store`/`load` with explicit `inputs` for replay state; it is capped at 200 keys and 64 KiB. Persist compact cursors and summaries, reduce large reads with `projection.pick` or `limit`, and use `payloadTier:'full'` only with a narrow projection. For oversized output, follow `summaryNotice.rawSummaryCursor` with `capability:read` in bounded slices. No timers are available; use `await sleep(ms)` for a bounded delay (maximum 10 seconds) and use its returned duration when measuring time. `notify` and `yield_control` stream output; `generatedImage` appends validated media. Return `{ summary, media: [{ type: \"image\"|\"audio\", data: \"<base64>\", mimeType }] }` to emit final media. Shell commands are nested inside JavaScript strings: preserve backslashes and `${...}` at each layer. For multiline or complex payloads, use a template literal or quoted heredoc; pass serialized JSON through quoted stdin or an argument instead of interpolating it into a shell string. Use fixed-string search or separate `-e` patterns when shell quoting is awkward.",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 1000000
                    },
                    "title": {
                      "description": "Short title for the reusable RECIPE saved on a successful run — make it discoverable by other agents (e.g. \"triage stale work-items\"). Optional: a fallback is derived from the script when omitted.",
                      "type": "string",
                      "maxLength": 120
                    },
                    "description": {
                      "description": "One/two lines on what this recipe does + when to reuse it. Optional: derived from the tool-set when omitted.",
                      "type": "string",
                      "maxLength": 2000
                    },
                    "dryRun": {
                      "description": "Preview: record effect:write tool calls without executing them (reads still run).",
                      "type": "boolean"
                    },
                    "timeoutSec": {
                      "description": "Foreground wall-clock budget: default 30s, maximum 45s (transport cap ~55s). For longer work use execution:{lifecycle:\"background\",durability:\"durable\",timeoutSec:120}; read it later with orchestrate:inspect { durableRun }.",
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 45
                    }
                  },
                  "additionalProperties": false
                },
                "annotations": {
                  "readOnlyHint": false
                },
                "_meta": {
                  "papercusp/toolRegistryRevision": "projected-tool-registry-v1:8e39e9ea53f0d6e9",
                  "papercusp/toolRegistrySource": "projected-tool-registry",
                  "papercusp/provider": {
                    "pluginName": "agent-mcp",
                    "packageName": "@papercusp/agent-mcp",
                    "version": "0.1.0",
                    "kind": "builtin"
                  },
                  "papercusp/servingGeneration": "serving-generation-v1:a528040778992a8ce2dda4696ff0affe43345629ae38c3e3ff7732a35db2389c"
                }
              },
              {
                "name": "recipes:search",
                "description": "Search reusable code:run RECIPES by intent (hybrid BM25 + embedding + tool-set overlap). Use BEFORE authoring a multi-step code:run to find a recipe that already does it. Entity-bound recipes are returned only when fleet/plan/harness/item/resource context matches; use each hit's runArgs unchanged. Read-only.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "query": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 500,
                      "description": "What you want to do — title/description text, free-form."
                    },
                    "limit": {
                      "description": "Top-N to return (default 5).",
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 50
                    },
                    "semantic": {
                      "description": "default true: include embedding similarity; false = bounded lexical-only search.",
                      "type": "boolean"
                    },
                    "context": {
                      "description": "Legacy compatibility context; bound authority is derived from the current live session and ignores these values.",
                      "type": "object",
                      "properties": {
                        "fleet": {
                          "$ref": "#/$defs/1"
                        },
                        "plan": {
                          "$ref": "#/$defs/1"
                        },
                        "harness": {
                          "$ref": "#/$defs/1"
                        },
                        "items": {
                          "$ref": "#/$defs/0"
                        },
                        "resources": {
                          "$ref": "#/$defs/0"
                        }
                      },
                      "additionalProperties": false
                    }
                  },
                  "required": [
                    "query"
                  ],
                  "additionalProperties": false,
                  "$defs": {
                    "0": {
                      "maxItems": 100,
                      "type": "array",
                      "items": {
                        "$ref": "#/$defs/1"
                      }
                    },
                    "1": {
                      "type": "string",
                      "minLength": 1
                    }
                  }
                },
                "annotations": {
                  "readOnlyHint": true
                },
                "_meta": {
                  "papercusp/toolRegistryRevision": "projected-tool-registry-v1:8e39e9ea53f0d6e9",
                  "papercusp/toolRegistrySource": "projected-tool-registry",
                  "papercusp/provider": {
                    "pluginName": "agent-mcp",
                    "packageName": "@papercusp/agent-mcp",
                    "version": "0.1.0",
                    "kind": "builtin"
                  },
                  "papercusp/servingGeneration": "serving-generation-v1:a528040778992a8ce2dda4696ff0affe43345629ae38c3e3ff7732a35db2389c"
                }
              },
              {
                "name": "tools:find",
                "description": "Find tools by INTENT across the full tool catalog (hybrid lexical + semantic). ACTIVATION IS The optional `limit` defaults to 8, accepts 1-25, and values above 25 are rejected. CONDITIONAL: on a seeded (small-surface) session the matches are added to the server tool surface (activated:true); the client may need a tool-list refresh before direct-call wrappers appear, so follow `howToCall` and use tools:invoke when a wrapper is absent. On a full-catalog session there is nothing to expand (activated:false) — call tools:invoke. High-confidence runtime symptoms (slow/queued, connection-refused, no-window, change-live?, value-stale?) route their decisive diagnostic to hit #1.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "query": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 400
                    },
                    "limit": {
                      "description": "Maximum number of matches; defaults to 8; values above 25 are rejected.",
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 25
                    },
                    "harness": {
                      "description": "Optional caller scope hint accepted for compatibility; ignored — tools:find is catalog-global and its scope is resolved from session context automatically.",
                      "type": "string",
                      "minLength": 1
                    },
                    "workspace": {
                      "description": "Optional caller scope hint accepted for compatibility; ignored — tools:find is catalog-global and its scope is resolved from session context automatically.",
                      "type": "string",
                      "minLength": 1
                    },
                    "build": {
                      "description": "Which build's catalog to search: 'staging' finds tools that exist only on staging (:3170). Default main.",
                      "type": "string",
                      "enum": [
                        "main",
                        "staging"
                      ]
                    }
                  },
                  "additionalProperties": false
                },
                "annotations": {
                  "readOnlyHint": true
                },
                "_meta": {
                  "papercusp/toolRegistryRevision": "projected-tool-registry-v1:8e39e9ea53f0d6e9",
                  "papercusp/toolRegistrySource": "projected-tool-registry",
                  "papercusp/provider": {
                    "pluginName": "agent-mcp",
                    "packageName": "@papercusp/agent-mcp",
                    "version": "0.1.0",
                    "kind": "builtin"
                  },
                  "papercusp/resultFormats": [
                    "json"
                  ],
                  "papercusp/servingGeneration": "serving-generation-v1:a528040778992a8ce2dda4696ff0affe43345629ae38c3e3ff7732a35db2389c"
                }
              },
              {
                "name": "tools:invoke",
                "description": "Call ANY tool in the full tool catalog by name, even one not in your loaded tool list. ⚠ Use colon tool names (flags:set); NEVER underscored display names. Args go in `args`. The call is dispatched server-side and gated exactly as a direct call would be. Pair with tools:find: tools:find(\"<intent>\") to get the name + arg schema, then tools:invoke({ name, args }) to run it. Use this when a tool you need is not in your loaded set and your client has not surfaced it directly.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "name": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 120
                    },
                    "servingGeneration": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 160
                    },
                    "build": {
                      "description": "'staging' runs the call on the staging operator (:3170), for a tool main does not have yet. Default main.",
                      "type": "string",
                      "enum": [
                        "main",
                        "staging"
                      ]
                    },
                    "args": {
                      "type": "object",
                      "propertyNames": {
                        "type": "string"
                      },
                      "additionalProperties": {}
                    }
                  },
                  "required": [
                    "name"
                  ],
                  "additionalProperties": false
                },
                "annotations": {
                  "readOnlyHint": false
                },
                "_meta": {
                  "papercusp/toolRegistryRevision": "projected-tool-registry-v1:8e39e9ea53f0d6e9",
                  "papercusp/toolRegistrySource": "projected-tool-registry",
                  "papercusp/provider": {
                    "pluginName": "agent-mcp",
                    "packageName": "@papercusp/agent-mcp",
                    "version": "0.1.0",
                    "kind": "builtin"
                  },
                  "papercusp/servingGeneration": "serving-generation-v1:a528040778992a8ce2dda4696ff0affe43345629ae38c3e3ff7732a35db2389c"
                }
              },
              {
                "name": "memory:remember",
                "description": "Store a STABLE fact about the user into persistent memory, kept VERBATIM as written. Use one of 4 kinds (user / feedback / project / reference). Write ONE tight, self-contained fact per call. For transient state, use coord — not memory.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "content": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 16000
                    },
                    "kind": {
                      "type": "string",
                      "enum": [
                        "user",
                        "feedback",
                        "project",
                        "reference"
                      ]
                    },
                    "harness_slug": {
                      "description": "Scope to a specific harness (project). Anyone with access to that harness will see this memory in their recall. Omit for a personal (per-user) fact.",
                      "type": "string"
                    },
                    "hive_slug": {
                      "description": "Scope to a Pot's SHARED pool (knowledge-packs P-004) — every agent in every member harness of that pot recalls it. Use for discovered project conventions (test command, build path, design system) the whole pot should inherit. Mutually exclusive with harness_slug.",
                      "type": "string"
                    },
                    "force": {
                      "description": "Bypass the dedup-on-write similarity check (P-016). Use only when knowingly writing a near-duplicate the agent has decided to keep separate. Default: false.",
                      "type": "boolean"
                    },
                    "supersede": {
                      "description": "Write this fact as the replacement for the given memory id (temporal-lite): after the new row lands, close the old row's validity window with superseded_by = the new id. This is the one-call resolution for a conflict refusal.",
                      "type": "string",
                      "format": "uuid",
                      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$"
                    },
                    "shareable": {
                      "description": "OPT-IN federation egress (F0-2): true = this memory may federate to other hives. Default false — memories are hive-private.",
                      "type": "boolean"
                    },
                    "workspace": {
                      "description": "Superuser-only: from an UNSCOPED session, tag the write under THIS workspace (the resolved workspace lands in metadata.workspace_id). Scoped/power-user sessions ignore it.",
                      "type": "string"
                    }
                  },
                  "required": [
                    "content",
                    "kind"
                  ],
                  "additionalProperties": false
                },
                "annotations": {
                  "readOnlyHint": false
                },
                "_meta": {
                  "papercusp/toolRegistryRevision": "projected-tool-registry-v1:8e39e9ea53f0d6e9",
                  "papercusp/toolRegistrySource": "projected-tool-registry",
                  "papercusp/provider": {
                    "pluginName": "agent-mcp",
                    "packageName": "@papercusp/agent-mcp",
                    "version": "0.1.0",
                    "kind": "builtin"
                  },
                  "papercusp/servingGeneration": "serving-generation-v1:a528040778992a8ce2dda4696ff0affe43345629ae38c3e3ff7732a35db2389c"
                }
              },
              {
                "name": "memory:search",
                "description": "Search the user's persistent memories by semantic similarity. Returns matched facts ranked by relevance.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "query": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 500
                    },
                    "limit": {
                      "type": "integer",
                      "minimum": 1,
                      "maximum": 20
                    },
                    "harness_slug": {
                      "description": "Scope the search to a single harness in addition to user memory. Omit to fan out across every harness in the workspace.",
                      "type": "string"
                    },
                    "harnessOnly": {
                      "description": "Scope to ONLY the named harness pool — EXCLUDE the user/personal pool. For ISOLATED per-run pools (e.g. a benchmark capability-injection arm) where the user's personal memories would be noise. Requires harness_slug; ignored without it.",
                      "type": "boolean"
                    },
                    "workspace": {
                      "description": "Superuser-only: from an UNSCOPED session, resolve harness fan-out within THIS workspace (the resolved workspace scopes the fan-out). Scoped/power-user sessions ignore it. Omit for personal (user-scoped) recall.",
                      "type": "string"
                    },
                    "as_of": {
                      "description": "TEMPORAL (temporal-lite): point-in-time recall — only memories whose UTC half-open validity window covers this ISO timestamp (valid_at <= as_of < invalid_at). When combined with include_superseded, this point-in-time window remains authoritative; the flag does not widen it. Hits carry metadata.validity.",
                      "type": "string",
                      "maxLength": 64
                    },
                    "include_superseded": {
                      "description": "TEMPORAL (temporal-lite): without as_of, include superseded/soft-forgotten memories across the full lifecycle. With as_of, the UTC point-in-time window is authoritative. Superseded hits carry metadata.validity { status:\"superseded\", superseded_by }.",
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "query"
                  ],
                  "additionalProperties": false
                },
                "annotations": {
                  "readOnlyHint": true
                },
                "_meta": {
                  "papercusp/toolRegistryRevision": "projected-tool-registry-v1:8e39e9ea53f0d6e9",
                  "papercusp/toolRegistrySource": "projected-tool-registry",
                  "papercusp/provider": {
                    "pluginName": "agent-mcp",
                    "packageName": "@papercusp/agent-mcp",
                    "version": "0.1.0",
                    "kind": "builtin"
                  },
                  "papercusp/servingGeneration": "serving-generation-v1:a528040778992a8ce2dda4696ff0affe43345629ae38c3e3ff7732a35db2389c"
                }
              },
              {
                "name": "facts:assert",
                "description": "Upsert a STANDING FACT by key; scoped conclusions fold VERBATIM into future briefs/orients until expiry or retraction. Bodies over 1200 chars are refused unless acceptTruncation:true; the 4000-char schema limit is transport headroom. ⚠ Declare a lifetime: ttlSec for CURRENT CODE/STATE (forces re-check), kind:'convention' for permanent rules, or a wall:/dead-end:/guard-rail: slot or provisional/suspected confidence. Re-asserting refreshes body + TTL. At the cap, the lowest-ranked fact is evicted unless it belongs to another author and is verified; typed slots and conventions use no cap seat.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "promotedFrom": {
                      "maxItems": 24,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "type": "string",
                            "enum": [
                              "memory",
                              "session-turn",
                              "work-item",
                              "report",
                              "fact",
                              "decision"
                            ]
                          },
                          "ref": {
                            "$ref": "#/$defs/0"
                          }
                        },
                        "required": [
                          "kind",
                          "ref"
                        ],
                        "additionalProperties": false
                      },
                      "description": "Typed sources validated in this workspace before writing: memory UUID; session-turn provider:session:index; work-item WI/EI id; report id; fact key; decision plan#D-NNN."
                    },
                    "scope": {
                      "type": "string",
                      "enum": [
                        "workspace",
                        "role",
                        "owner",
                        "harness",
                        "work_item"
                      ],
                      "description": "workspace (global, no ref) | role | owner | harness | work_item"
                    },
                    "scopeRef": {
                      "description": "Required for every scope except workspace: role name / ownerId / harness slug / WI id.",
                      "type": "string",
                      "maxLength": 120
                    },
                    "scope_ref": {
                      "description": "Alias for scopeRef (EI-7371) — prefer scopeRef; accepted so a snake_case call still resolves the ref instead of silently dropping it.",
                      "type": "string",
                      "maxLength": 120
                    },
                    "ref": {
                      "description": "Alias for scopeRef (EI-7371) — prefer scopeRef.",
                      "type": "string",
                      "maxLength": 120
                    },
                    "harness": {
                      "description": "Alias for scopeRef when scope:\"harness\" (EI-7371) — prefer scopeRef. For shareable:true, also pass a concrete harness here when the caller context is not already harness-scoped.",
                      "type": "string",
                      "maxLength": 120
                    },
                    "key": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 120,
                      "description": "Stable slug — upsert + retract target (e.g. \"wi-1439-owner-residue\")."
                    },
                    "supersedes": {
                      "description": "Retire up to 12 overlapping sibling fact keys in the SAME workspace/scope/ref while asserting this replacement. Keys are trimmed and deduplicated; the asserted key itself is refused because same-key corrections already append a version. Only CURRENT local matches are soft-retracted, atomically with this write, and the receipt reports the keys actually retired. Missing, wrong-scope, and already-retired keys are unchanged and omitted from that receipt.",
                      "maxItems": 12,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 120
                      }
                    },
                    "body": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 4000,
                      "description": "REFUSED ABOVE 1200 CHARS — size your write to this, not the 4000 schema ceiling (4000 is transport headroom only, so the refusal can measure your exact overage and preview the tail that would be cut). An over-cap body is NOT silently clipped: NO WRITE HAPPENS and the error names how many chars to cut — either shorten it, or re-call with acceptTruncation:true to force the clipped write through. Front-load the operative clause; write tight, not documents."
                    },
                    "sourceRef": {
                      "description": "Anchor that proved it. A TYPED ref — msg:<id>, wi:<id>/WI-/EI- id, session_turn:<source>:<session>:<idx>, or \"owner-turn\" (the human turn you are answering) — is PLATFORM-VERIFIED at assert time and folds with the verified verbatim quote; anything else (plan slug, prose) stays a plain anchor.",
                      "type": "string",
                      "maxLength": 200
                    },
                    "slot": {
                      "description": "Typed slots normalize key prefixes: dead-end = failed approach, rendered ⛔ DEAD END, finite TTL default90d; wall = OWNER-GATED blocker, rendered ⚠ WALL, finite TTL default90d/max90d with loud watchdog escalation on unretracted lapse (absence NEVER means resolved); guard-rail = settled do-not-repeat instruction, rendered 🛡️ GUARD RAIL, permanent by default, exempt from cap eviction and included in never-drop folds. State the failed approach/reason or blocking condition/remedy; anchor evidence with sourceRef.",
                      "type": "string",
                      "enum": [
                        "dead-end",
                        "wall",
                        "guard-rail"
                      ]
                    },
                    "audienceScope": {
                      "description": "Restrict WHO receives this fact in folds (v1 grammar: \"fleet:<slug>\") — it then folds ONLY into orients of that fleet's members. Omit = every reader of the scope. Orthogonal to `scope` (what the fact is about). facts:list still shows it to everyone (delivery relevance, not secrecy).",
                      "type": "string",
                      "maxLength": 160
                    },
                    "confidence": {
                      "description": "Evidence strength: verified = directly confirmed/replicated; provisional = single observation, unreplicated; suspected = hunch/second-hand hedge. Never strengthen a peer's confidence. Omit for legacy unbadged. Without ttlSec, provisional/suspected grants a short TTL; an ordinary write still needs an explicit ttlSec or another documented lifetime rule.",
                      "type": "string",
                      "enum": [
                        "verified",
                        "provisional",
                        "suspected"
                      ]
                    },
                    "subjectVolatile": {
                      "description": "Mark the asserted values as a snapshot of a subject that may still be changing. The ONE hard refusal in this group: when true, measuredAt is required (never defaulted to now() — that would stamp a sample of unknown age as fresh). Supplying measuredAt alone is accepted and the store infers subjectVolatile:true. The fold renders a SNAPSHOT marker, and the TTL is CLAMPED to 15 minutes rather than refused.",
                      "type": "boolean"
                    },
                    "measurement": {
                      "description": "Compatibility input alias for the persisted/read `measurement` object. It is normalized to the canonical top-level subjectVolatile/measuredAt fields; if both forms are supplied, their values must agree.",
                      "type": "object",
                      "properties": {
                        "subjectVolatile": {
                          "type": "boolean",
                          "const": true,
                          "description": "The sampled subject may still be changing."
                        },
                        "measuredAt": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 80,
                          "description": "ISO timestamp at which the moving subject was sampled."
                        }
                      },
                      "required": [
                        "subjectVolatile",
                        "measuredAt"
                      ],
                      "additionalProperties": false
                    },
                    "measuredAt": {
                      "description": "ISO timestamp at which a snapshot was sampled. Required with subjectVolatile:true; supplying measuredAt alone is accepted and the store infers subjectVolatile:true, the SNAPSHOT marker, and the 15-minute TTL. Omit it for durable invariant conclusions.",
                      "type": "string",
                      "maxLength": 80
                    },
                    "dependsOn": {
                      "description": "P-008: the CELL ids this fact rests on (max 12) — either a bare id (\"deploy.3070.sha\") or { cell, as } when the cell is caller-relative ({ cell: \"git.pipelinePosition\", as: \"packages/operator-core/lib/x.ts\" }). Each is READ AND DIGESTED NOW, so a later reader is told mechanically that \"the cell you relied on changed from X to Y\" instead of guessing from the fact's age. This is what makes an assumption auto-invalidate (D-007) — without it, an assumption is just a conclusion with a weaker badge. A cell that cannot be read is recorded as such and never later reported fresh; it never blocks the write. Run state:read { } to see the cells you may declare. \"file:<repo path>\" anchors the fact to that file's blob: reads report it stale when the file changes, and ttlSec may be omitted.",
                      "maxItems": 12,
                      "type": "array",
                      "items": {
                        "anyOf": [
                          {
                            "$ref": "#/$defs/1"
                          },
                          {
                            "type": "object",
                            "properties": {
                              "cell": {
                                "$ref": "#/$defs/1"
                              },
                              "as": {
                                "description": "The SUBJECT, for a cell whose callerRelativity is \"parameter\" — same meaning as state:read { as }.",
                                "type": "string",
                                "maxLength": 200
                              }
                            },
                            "required": [
                              "cell"
                            ],
                            "additionalProperties": false
                          }
                        ]
                      }
                    },
                    "claim": {
                      "description": "P-008: an optional TYPED restatement of what this fact asserts, e.g. { subject: \"cell:gate.greenCheckpoint.verdict\", assertion: \"unrelated-to-my-change\" }. `body` stays the prose humans read. ⚠ NOTHING READS THIS TODAY — the contradiction detector it was built for was retired (WI-6545 / D-103) after 3 of 2,217 facts ever carried a claim. Stored faithfully if you pass it; omit it unless you have your own reason.",
                      "type": "object",
                      "propertyNames": {
                        "type": "string"
                      },
                      "additionalProperties": {}
                    },
                    "enforcement": {
                      "description": "P-018: HOW this convention is enforced (kind:'convention' only) — 'structural' (impossible to do wrong; no agent decision involved), 'gate' (refused at a chokepoint), or 'detector' (measured, never silently tolerated). gate/detector REQUIRE floor (a rate in (0,1]) + reviewBy: D-016 — \"a detector without a floor is prose exhortation in a costume\". 'structural' takes neither. There is deliberately no 'prompt' tier: a convention carried only by documentation omits this and reads as untiered.",
                      "type": "object",
                      "properties": {
                        "tier": {
                          "type": "string",
                          "enum": [
                            "structural",
                            "gate",
                            "detector"
                          ]
                        },
                        "floor": {
                          "type": "number"
                        },
                        "reviewBy": {
                          "type": "string",
                          "maxLength": 40
                        }
                      },
                      "required": [
                        "tier"
                      ],
                      "additionalProperties": false
                    },
                    "ttlSec": {
                      "description": "TTL seconds (max 90d). ⚠ THERE IS NO DEFAULT: every assert must declare a lifetime, and a call that declares none is REFUSED (the old silent 7d default was removed — it was being applied to facts nobody had chosen a lifetime for, which then expired unread). Pass this for a bounded fact, or permanent:true for a standing one. You do NOT need either if the fact already implies a lifetime: kind:'convention' is permanent on its own, a wall:/dead-end:/guard-rail: slot carries its own durable default, and confidence:'provisional'|'suspected' already means a short TTL. ⚠ CONDITIONAL MAX: a volatile fact's ttlSec is CLAMPED, never refused (D-011) — anything over 900s (15 minutes) is shortened to it and disclosed back as ttlClampedFrom.",
                      "x-papercusp-call-constraint": "when subjectVolatile:true or measuredAt is supplied, ttlSec>900 is clamped to 900 and disclosed as ttlClampedFrom; the ordinary ttlSec ceiling still applies.",
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 7776000
                    },
                    "permanent": {
                      "description": "Declare this fact PERMANENT (no expiry) — the semantic alternative to ttlSec, and the way to say \"this should never lapse\" without inventing a large number. ACCEPTED ONLY for a fact that is exempt from the per-scope cap: kind:'convention', or a key under 'wall:' / 'dead-end:' / 'guard-rail:'. Everywhere else it is REFUSED, and that is deliberate rather than a restriction to work around: the ordinary cap refuses at its ceiling instead of evicting an incumbent, so an unbounded ordinary row could hold a slot forever and cause later ordinary writes to be refused. Choose by WHAT THE ROW IS, not by how durable it feels: a standing rule or decision is kind:'convention' and permanent by that fact alone; a finding about current code SHOULD expire, so give it a ttlSec and a recheck. Refused for a volatile measurement — a snapshot of a moving subject is never a standing fact.",
                      "type": "boolean"
                    },
                    "dryRun": {
                      "description": "Compute what this assert WOULD cost and write NOTHING: which fact the per-scope cap would evict (key, owner, confidence, remaining TTL), where your row would land in the victim ranking, and whether the key you are replacing already exists. Use it before asserting into a scope you know is busy, and before RESTORING an evicted fact — a restore is itself a write and can displace a third party. Ordinary at-cap writes are refused before write when the predicted victim is another author's verified fact; conventions and typed safety slots take no cap seat. FORECAST, NOT A RESERVATION: a peer asserting first changes the victim.",
                      "type": "boolean"
                    },
                    "acceptTruncation": {
                      "description": "Explicit opt-in to force the write through when body exceeds the 1200-char cap. WITHOUT this, an over-cap body is REFUSED (no write happens) — the error names the overage and previews the exact tail that would be cut, so you can re-write it tight instead of losing it silently (EI-18685042986450096: the old truncate-and-report-after behavior dropped the operative clause of a fact 3x, once removing a rule's verdict sentence entirely). Pass true only when you deliberately want the clipped write to land anyway (P-007: a write is never rejected outright — this is the one way to still get the old lossy-but-never-lost behavior).",
                      "type": "boolean"
                    },
                    "recheck": {
                      "description": "P-010: paired re-verification contract. Supply BOTH probe and falsifier (max 500 chars each). The pair folds verbatim beside the fact so a future reader knows how to test it and what result disproves it. Omission remains compatible but the success receipt warns loudly that the fact has no recheck contract.",
                      "type": "object",
                      "properties": {
                        "probe": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 500,
                          "description": "The concrete query/tool/measurement a future reader can run to verify the fact again."
                        },
                        "falsifier": {
                          "type": "string",
                          "minLength": 1,
                          "maxLength": 500,
                          "description": "The concrete result or observation that means this fact is false and must be retracted or corrected."
                        },
                        "exec": {
                          "description": "Optional executable form of probe for a guard rail: a bash command whose exit code (and stdout literal) means the fact HOLDS. Harness preflights whose scope tags overlap `scope` (e.g. [\"p505\"]) run it and fail fast when it breaks.",
                          "type": "object",
                          "properties": {
                            "command": {
                              "$ref": "#/$defs/0"
                            },
                            "expectExitCode": {
                              "type": "integer",
                              "minimum": 0,
                              "maximum": 255
                            },
                            "stdoutIncludes": {
                              "$ref": "#/$defs/0"
                            },
                            "scope": {
                              "minItems": 1,
                              "maxItems": 8,
                              "type": "array",
                              "items": {
                                "type": "string",
                                "pattern": "^[a-z0-9][a-z0-9:._-]{0,63}$",
                                "description": "Compact guard-rail scope tag (lowercase letters, digits, :, ., _, or -; max 64 characters). File paths belong in command/evidence, not scope."
                              }
                            }
                          },
                          "required": [
                            "command",
                            "expectExitCode",
                            "scope"
                          ],
                          "additionalProperties": false
                        }
                      },
                      "required": [
                        "probe",
                        "falsifier"
                      ],
                      "additionalProperties": false
                    },
                    "kind": {
                      "description": "P-008: the claim MODALITY — 'conclusion' (a settled finding), 'assumption' (provisional; pair it with dependsOn so it goes stale on its own terms), 'convention' (normative: \"we do X here\"), or 'undecidable' (NOT determinable from the available evidence — recorded so peers STOP RE-DERIVING it; REQUIRES settledBy). This is NOT `scope`: scope says who the fact is ABOUT, kind says what kind of claim it is. Omit = not declared (never rewritten to 'conclusion' — a modality nobody stated is not one).",
                      "type": "string",
                      "enum": [
                        "conclusion",
                        "assumption",
                        "convention",
                        "undecidable"
                      ]
                    },
                    "settledBy": {
                      "description": "P-002: what evidence WOULD settle this question. REQUIRED for kind:'undecidable', and REFUSED on any other kind (on a settled claim it has no referent). Name a concrete probe — a query, a tool, a measurement — not \"more investigation\". The rule mirrors the required insteadRead on refuseAnswer(): an UNKNOWN with no stated exit does not stop re-derivation, it INVITES it, because the next reader cannot distinguish \"nobody COULD determine this\" from \"nobody has tried lately\" and the cheapest way to tell them apart is to try again — which is the exact cost this modality exists to eliminate.",
                      "x-papercusp-call-constraint": "required when kind:'undecidable'; refused for every other kind.",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 500
                    },
                    "shareable": {
                      "description": "OPT-IN federation egress (F0-2): true = this fact may leave the pot over the substrate. A shareable fact MUST have a resolvable federation harness: pass a concrete `harness` for workspace, role, owner, or work_item scopes, or pass `scope:\"harness\"` with its canonical `scopeRef`. Omit or set false to keep the fact pot-private.",
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "scope",
                    "key",
                    "body"
                  ],
                  "additionalProperties": false,
                  "x-papercusp-call-constraint": "Declare exactly one lifetime: ordinary facts, including verified conclusions, require ttlSec; omit it for a measuredAt snapshot (subjectVolatile is inferred and the TTL is 15 minutes), kind:'convention', wall:/dead-end:/guard-rail: keys, or confidence:'provisional'|'suspected'. permanent:true is allowed only for conventions/typed keys; never combine it with ttlSec or a volatile measurement.",
                  "$defs": {
                    "0": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 500
                    },
                    "1": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 200
                    }
                  }
                },
                "annotations": {
                  "readOnlyHint": false
                },
                "_meta": {
                  "papercusp/toolRegistryRevision": "projected-tool-registry-v1:8e39e9ea53f0d6e9",
                  "papercusp/toolRegistrySource": "projected-tool-registry",
                  "papercusp/provider": {
                    "pluginName": "agent-mcp",
                    "packageName": "@papercusp/agent-mcp",
                    "version": "0.1.0",
                    "kind": "builtin"
                  },
                  "papercusp/servingGeneration": "serving-generation-v1:a528040778992a8ce2dda4696ff0affe43345629ae38c3e3ff7732a35db2389c"
                }
              },
              {
                "name": "facts:retract",
                "description": "Retract a standing fact by (scope, scopeRef, key) with a reason — it immediately stops folding into briefs/dossiers/orients. If the key identifies exactly one current fact, scope and scopeRef may be omitted. Soft-delete (actor and reason retained in the 30-day audit trail).",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "scope": {
                      "description": "Optional only when key matches exactly one current fact; required when the key is ambiguous.",
                      "type": "string",
                      "enum": [
                        "workspace",
                        "role",
                        "owner",
                        "harness",
                        "work_item"
                      ]
                    },
                    "scopeRef": {
                      "description": "Scope reference. Also accepted, folded into scopeRef before parse (scopeRef wins): scope_ref, ref (EI-7371).",
                      "type": "string",
                      "maxLength": 120
                    },
                    "harness": {
                      "description": "Alias for scopeRef when scope:\"harness\" (EI-7371) — prefer scopeRef.",
                      "type": "string",
                      "maxLength": 120
                    },
                    "key": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 120
                    },
                    "reason": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 500,
                      "description": "Why this fact stopped being true, ≤500 chars (longer is refused) — retained in the 30-day audit trail."
                    }
                  },
                  "required": [
                    "key",
                    "reason"
                  ],
                  "additionalProperties": false
                },
                "annotations": {
                  "readOnlyHint": false
                },
                "_meta": {
                  "papercusp/toolRegistryRevision": "projected-tool-registry-v1:8e39e9ea53f0d6e9",
                  "papercusp/toolRegistrySource": "projected-tool-registry",
                  "papercusp/provider": {
                    "pluginName": "agent-mcp",
                    "packageName": "@papercusp/agent-mcp",
                    "version": "0.1.0",
                    "kind": "builtin"
                  },
                  "papercusp/servingGeneration": "serving-generation-v1:a528040778992a8ce2dda4696ff0affe43345629ae38c3e3ff7732a35db2389c"
                }
              },
              {
                "name": "facts:list",
                "description": "List live (unexpired, unretracted) standing facts for one scope — the exact set future briefs/dossiers/orients will fold. workspace scope takes no scopeRef.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "scope": {
                      "type": "string",
                      "enum": [
                        "workspace",
                        "role",
                        "owner",
                        "harness",
                        "work_item"
                      ],
                      "description": "Which scope's live facts to list — exactly one of workspace | role | owner | harness | work_item. There is deliberately NO `plan` scope: a standing claim that binds a PLAN belongs in that plan's Decisions (plans:add-decision), which is addressable and auditable afterwards, where a fact is not. For a plan-lane conclusion that must ride every orient, scope it to the `harness` the plan lives in, or to the `work_item` executing it."
                    },
                    "scopeRef": {
                      "description": "Scope reference. Also accepted, folded into scopeRef before parse (scopeRef wins): scope_ref, ref (EI-7371).",
                      "type": "string",
                      "maxLength": 120
                    },
                    "harness": {
                      "description": "Alias for scopeRef when scope:\"harness\" (EI-7371) — prefer scopeRef.",
                      "type": "string",
                      "maxLength": 120
                    },
                    "limit": {
                      "description": "Max facts (default 4; positive values are clamped to 4 for ordinary result-door pages). With all:true, the wider page ceiling of 200 applies — a PAGE bound, not the enforced per-scope cap (5000); a scope may legitimately hold more facts than one page can return.",
                      "type": "integer",
                      "exclusiveMinimum": 0,
                      "maximum": 9007199254740991
                    },
                    "full": {
                      "description": "Return COMPLETE fact bodies instead of excerpts. Default false — bodies are excerpted (with body_truncated + body_full_chars) so a busy scope cannot blow the tool-output budget (EI-10948). Use when you need a fact verbatim, ideally with a tighter `limit`.",
                      "type": "boolean"
                    },
                    "all": {
                      "description": "Widen the page to at most 200 rows instead of the result-door-safe 4-row page. ⚠ This is a PAGE ceiling, NOT the enforced per-scope cap (5000) — a scope can hold more live facts than this returns, so all:true is not a guarantee of completeness. Check `truncatedByLimit`/`total` in the response before treating the result as the whole population; above 200 narrow by `key` or scope rather than re-requesting all:true. Large results may spill to the result-door scratch cursor; use projection or key for a smaller read. Orthogonal to full:true, which controls body excerpts.",
                      "type": "boolean"
                    },
                    "key": {
                      "description": "With versions:true, the single fact key whose history to read; without versions, query ONE live fact directly (useful when a bounded list cannot establish absence).",
                      "type": "string",
                      "maxLength": 200
                    },
                    "versions": {
                      "description": "P-008: return the VERSION HISTORY of one `key` (newest first) instead of the live list — what this fact saidbefore it was corrected, each version with its own immutable `id` and the `supersedesId` of the one it replaced. Requires `key`. Superseded versions are pruned 30d after replacement, so history is bounded.",
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "scope"
                  ],
                  "additionalProperties": false
                },
                "annotations": {
                  "readOnlyHint": true
                },
                "_meta": {
                  "papercusp/toolRegistryRevision": "projected-tool-registry-v1:8e39e9ea53f0d6e9",
                  "papercusp/toolRegistrySource": "projected-tool-registry",
                  "papercusp/provider": {
                    "pluginName": "agent-mcp",
                    "packageName": "@papercusp/agent-mcp",
                    "version": "0.1.0",
                    "kind": "builtin"
                  },
                  "papercusp/servingGeneration": "serving-generation-v1:a528040778992a8ce2dda4696ff0affe43345629ae38c3e3ff7732a35db2389c"
                }
              },
              {
                "name": "session:request-compaction",
                "description": "Compact THIS session now, at a clean stopping point (near your soft compaction limit). After this turn ends the harness cuts the process and respawns it on fresh context with the deterministic carry document as launch context (P-018 — native /compact is retired); the successor resumes automatically. Pass focus to name what to resume. Supported wire fields are focus, autoContinue, respawn, continueNote, and legacy reason (ignored).",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "focus": {
                      "description": "What to resume/emphasize after the respawn (defaults to your carry-brief anchors). Keep it ≤600 chars; an over-long focus is truncated, never rejected (EI-7032).",
                      "type": "string",
                      "maxLength": 600
                    },
                    "autoContinue": {
                      "description": "Deprecated no-op: a carry-respawn always resumes (the successor launches with a first prompt). Accepted for wire-compat with older callers.",
                      "type": "boolean"
                    },
                    "resumeMode": {
                      "description": "Deprecated no-op: carry-respawn always resumes the same logical session. Accepted only as the legacy literal \"same\" for wire compatibility.",
                      "type": "string",
                      "const": "same"
                    },
                    "reason": {
                      "description": "Deprecated no-op: an optional caller annotation accepted for wire compatibility; it does not affect carry assembly or the successor prompt.",
                      "type": "string",
                      "maxLength": 600
                    },
                    "respawn": {
                      "description": "Deprecated no-op: a carry-respawn is always requested. Accepted for wire-compat with older callers.",
                      "type": "boolean"
                    },
                    "continueNote": {
                      "description": "Override the successor's first prompt used when no owner message is open. Defaults to a \"continue + re-orient\" note derived from focus. Over-long is truncated, never rejected (EI-7032).",
                      "type": "string",
                      "maxLength": 1000
                    }
                  },
                  "additionalProperties": false
                },
                "annotations": {
                  "readOnlyHint": false
                },
                "_meta": {
                  "papercusp/toolRegistryRevision": "projected-tool-registry-v1:8e39e9ea53f0d6e9",
                  "papercusp/toolRegistrySource": "projected-tool-registry",
                  "papercusp/provider": {
                    "pluginName": "agent-mcp",
                    "packageName": "@papercusp/agent-mcp",
                    "version": "0.1.0",
                    "kind": "builtin"
                  },
                  "papercusp/servingGeneration": "serving-generation-v1:a528040778992a8ce2dda4696ff0affe43345629ae38c3e3ff7732a35db2389c"
                }
              },
              {
                "name": "plans:set-now",
                "description": "Write the plan's Now note (state + next, stored as structured fields; the plan markdown and version are untouched). The Now is the cold-resume anchor — the single most-read field, NOT a log: keep State ≤2000 chars + Next ≤800 (both auto-truncate, reported as `clamped`; long-form detail belongs in the plan body via plans:set-content / set-content-chunk).",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "harness": {
                      "description": "Concrete in-scope harness slug (e.g. papercusp); harness-scoped sessions infer it. all requires unscoped --all-workspaces. Only UNSCOPED plans:get/plans:items auto-resolve an exact slug across harnesses; scoped misses identify the owning harness, which you must then pass explicitly.",
                      "type": "string",
                      "minLength": 1
                    },
                    "slug": {
                      "type": "string",
                      "minLength": 1
                    },
                    "slugs": {
                      "description": "Plan slugs to update with the same Now block in one call.",
                      "minItems": 1,
                      "maxItems": 200,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "minLength": 1
                      }
                    },
                    "state": {
                      "type": "string",
                      "minLength": 1,
                      "description": "One paragraph (≤2000 chars) describing where the plan currently stands. Keep it tight — the Now block is a cold-resume anchor, NOT a log. Auto-truncated to 2000 chars if longer (reported as `clamped`); put long-form detail in the plan body via plans:set-content / set-content-chunk, not here."
                    },
                    "next": {
                      "type": "string",
                      "minLength": 1,
                      "description": "One sentence (≤8000 chars) — the single next concrete action and who should do it. Auto-truncated to 8000 chars if longer; multi-step detail belongs in plan items or the body."
                    },
                    "rationale": {
                      "description": "Optional — a short why behind this state change, stored on the Now note. Routine progress updates can omit it.",
                      "type": "string"
                    }
                  },
                  "required": [
                    "state",
                    "next"
                  ],
                  "additionalProperties": false
                },
                "annotations": {
                  "readOnlyHint": false
                },
                "_meta": {
                  "papercusp/toolRegistryRevision": "projected-tool-registry-v1:8e39e9ea53f0d6e9",
                  "papercusp/toolRegistrySource": "projected-tool-registry",
                  "papercusp/provider": {
                    "pluginName": "agent-mcp",
                    "packageName": "@papercusp/agent-mcp",
                    "version": "0.1.0",
                    "kind": "builtin"
                  },
                  "papercusp/servingGeneration": "serving-generation-v1:a528040778992a8ce2dda4696ff0affe43345629ae38c3e3ff7732a35db2389c"
                }
              },
              {
                "name": "plans:set-status",
                "description": "Flip one or many item statuses; auto-bumps frontmatter `updated:`. `dropped` requires a nonblank `note` or `rationale`; `done` accepts structured `verification` and returns advisory `typeEvidenceWarning` for missing or unit-only TypeScript evidence. `wip` auto-claims; `done`/`dropped` release the claim and clear assignment. A live peer claim yields per-item `claim_conflict`. Single: { slug, item, status }. Same-plan batch: { slug, itemIds:[…], status }. Mixed batch: items:[{ slug, item, status }]. Returns { ok, results:[{ ok, slug, itemId, oldStatus, newStatus, … | error }], counts } — correlate by { slug, itemId }, not position; one failure never fails the batch.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "harness": {
                      "description": "Concrete in-scope harness slug (e.g. papercusp); harness-scoped sessions infer it. all requires unscoped --all-workspaces. Only UNSCOPED plans:get/plans:items auto-resolve an exact slug across harnesses; scoped misses identify the owning harness, which you must then pass explicitly.",
                      "type": "string",
                      "minLength": 1
                    },
                    "slug": {
                      "$ref": "#/$defs/2"
                    },
                    "item": {
                      "$ref": "#/$defs/3"
                    },
                    "status": {
                      "$ref": "#/$defs/1"
                    },
                    "note": {
                      "type": "string",
                      "description": "Optional SHORT comment appended inline to the item line — REQUIRED when status is `dropped` unless a nonblank `rationale` is supplied. REPLACES any note this same tool previously injected on the item (a repeat call to fix a typo overwrites, never stacks; EI-384). Anything beyond ~1000 chars is TRUNCATED inline (with a `…` marker + a noteTruncated flag), never rejected. For a longer explanation of WHY the status changed, use `rationale` instead — it is stored on the plan revision, not spliced into the item line."
                    },
                    "itemIds": {
                      "description": "flip MANY items of the SAME plan `slug` to the same `status` (homogeneous)",
                      "minItems": 1,
                      "maxItems": 200,
                      "type": "array",
                      "items": {
                        "$ref": "#/$defs/3"
                      }
                    },
                    "items": {
                      "description": "flip many items at once — each { slug, item, status, note?, harness?, rationale? }",
                      "minItems": 1,
                      "maxItems": 200,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "slug": {
                            "$ref": "#/$defs/2"
                          },
                          "item": {
                            "$ref": "#/$defs/3"
                          },
                          "status": {
                            "description": "per-item status (else the batch `status`)",
                            "type": "string",
                            "enum": [
                              "todo",
                              "wip",
                              "blocked",
                              "needs-human",
                              "done",
                              "dropped"
                            ]
                          },
                          "note": {
                            "type": "string",
                            "description": "Optional SHORT comment appended inline to the item line — REQUIRED when status is `dropped` unless a nonblank `rationale` is supplied. REPLACES any note this same tool previously injected on the item (a repeat call to fix a typo overwrites, never stacks; EI-384). Anything beyond ~1000 chars is TRUNCATED inline (with a `…` marker + a noteTruncated flag), never rejected. For a longer explanation of WHY the status changed, use `rationale` instead — it is stored on the plan revision, not spliced into the item line."
                          },
                          "harness": {
                            "description": "per-item harness (else the batch `harness` default)",
                            "type": "string",
                            "minLength": 1
                          },
                          "rationale": {
                            "description": "per-item revision rationale (else the batch `rationale`); satisfies the required reason for status `dropped`",
                            "type": "string"
                          },
                          "onlyIfNotTerminal": {
                            "type": "boolean"
                          },
                          "onlyIfNotBlocked": {
                            "type": "boolean"
                          },
                          "onlyIfNoOtherOpenCoverage": {
                            "type": "boolean"
                          },
                          "onlyIfNoOtherInFlightCoverage": {
                            "type": "boolean"
                          },
                          "onlyIfNotCompleted": {
                            "type": "boolean"
                          },
                          "onlyIfBlockAttributedTo": {
                            "$ref": "#/$defs/2"
                          },
                          "expectedStatus": {
                            "$ref": "#/$defs/1"
                          },
                          "verification": {
                            "$ref": "#/$defs/0"
                          }
                        },
                        "required": [
                          "slug",
                          "item"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "rationale": {
                      "description": "Optional except when status is `dropped`, where either a nonblank `note` or `rationale` is REQUIRED. Supply rationale when the *why* is too long for the inline item note. Stored on the plan revision (D-009).",
                      "type": "string"
                    },
                    "onlyIfNotTerminal": {
                      "description": "Non-destructive flip: SKIP any item that is already done/dropped instead of moving it off terminal (reported `skipped:\"terminal_guard\"`, ok:true). For AUTOMATED reflections that must never un-finish shipped work; a human reopening an item deliberately just omits it.",
                      "type": "boolean"
                    },
                    "onlyIfNotBlocked": {
                      "description": "Non-destructive flip: SKIP an item already `blocked`/`needs-human` instead of weakening its explicit gate (reported `skipped:\"blocked_guard\"`, ok:true). For AUTOMATED ownership reflections; a human reopening or completing the gate deliberately omits it.",
                      "type": "boolean"
                    },
                    "onlyIfNoOtherOpenCoverage": {
                      "description": "On `done`/`dropped`, skip if another non-terminal work-item covers this plan item via implements, relates, or payload.plan_item. Prevents one sibling from clearing live shared work. No effect on other statuses; automated reflections use this, while deliberate human closure omits it.",
                      "type": "boolean"
                    },
                    "onlyIfNoOtherInFlightCoverage": {
                      "description": "Non-destructive TODO flip: SKIP it (reported `skipped:\"in_flight_coverage_guard\"`, ok:true) if ANOTHER linked work-item is non-terminal and currently assigned. Protects a parent plan lane when releasing one child is only an ownership event; a current assignee is the authoritative in-flight signal. No effect on other statuses. For AUTOMATED release reflections; a human deliberately returning the lane to `todo` omits it.",
                      "type": "boolean"
                    },
                    "onlyIfNotCompleted": {
                      "description": "Non-destructive DROP: SKIP a `done` → `dropped` flip (reported `skipped:\"completed_guard\"`, ok:true) instead of downgrading finished work. Complements `onlyIfNotTerminal`, which by design permits terminal→terminal, and `onlyIfNoOtherOpenCoverage`, which only counts NON-terminal siblings and so cannot see the DONE work-item that actually completed the item (EI-20129670928216719). No effect on any status other than `dropped`. For AUTOMATED reflections; a human deliberately reclassifying finished work as abandoned just omits it.",
                      "type": "boolean"
                    },
                    "onlyIfBlockAttributedTo": {
                      "description": "ATTRIBUTED CLEAR: the work-item id permitted to LIFT this item's block. Use on the →todo flip that mirrors a blocker CLEARING, INSTEAD of `onlyIfNotBlocked` (which would skip every such flip, the item being blocked by construction). Narrower than `onlyIfNotBlocked:false`: the flip proceeds only if the item's live injected note attributes the block to THIS work-item (reported `skipped:\"block_attribution_guard\"`, ok:true otherwise) AND no OTHER linked work-item is still blocked/needs-human (reported `skipped:\"blocked_coverage_guard\"`). `needs-human` is never cleared by this path at all. So a gate set for any other reason is left standing, and a 1:N lane is not un-blocked by one of its blockers clearing.",
                      "type": "string",
                      "minLength": 1
                    },
                    "expectedStatus": {
                      "description": "Compare-and-set: FAIL (`ok:false, code:\"expected_status_mismatch\"`) if the item is not on this status when the lock is taken. For applying a RECORDED observation whose `from` may have gone stale; unlike the `onlyIf*` guards this is an error, not a skip.",
                      "type": "string",
                      "enum": [
                        "todo",
                        "wip",
                        "blocked",
                        "needs-human",
                        "done",
                        "dropped"
                      ]
                    },
                    "verification": {
                      "$ref": "#/$defs/0"
                    }
                  },
                  "additionalProperties": false,
                  "$defs": {
                    "0": {
                      "type": "object",
                      "properties": {
                        "filesChanged": {
                          "description": "Use repo-relative paths for files in managed checkouts. For an out-of-tree deliverable, use its absolute path; work_items:complete records it as outOfRepoArtifact and excludes it from Git blob and settlement checks. External contents are not hashed. Do not use a repo-relative alias for an out-of-tree file because it is indistinguishable from a missing checkout path. If NO files changed, pass [].",
                          "type": "array",
                          "items": {
                            "$ref": "#/$defs/2"
                          }
                        },
                        "testsRun": {
                          "$ref": "#/$defs/2"
                        },
                        "testResult": {
                          "$ref": "#/$defs/2"
                        },
                        "verifiedHow": {
                          "type": "string",
                          "minLength": 1,
                          "description": "HOW it was verified — a non-empty label. Prefer 'unit' | 'integration' | 'live-drove-ui' | 'live-service' | 'manual' | 'already-passing' for queryable coarse modes; concise free-text labels are also accepted. `live-service` means a real running process/service was restarted or probed without driving UI. Put detailed evidence in `testsRun` / `testResult`."
                        },
                        "addedTests": {
                          "description": "A boolean FLAG — did this completion add or change tests? true/false, NOT a description of what was added (put that prose in `testsRun` / `testResult`).",
                          "type": "boolean"
                        }
                      },
                      "additionalProperties": false,
                      "description": "Verification evidence for a `done` flip. Supply filesChanged + verifiedHow + testsRun/testResult so the response can challenge a unit-only TypeScript close; advisory only."
                    },
                    "1": {
                      "type": "string",
                      "enum": [
                        "todo",
                        "wip",
                        "blocked",
                        "needs-human",
                        "done",
                        "dropped"
                      ]
                    },
                    "2": {
                      "type": "string",
                      "minLength": 1
                    },
                    "3": {
                      "type": "string",
                      "pattern": "^P-\\d{3,}$"
                    }
                  }
                },
                "annotations": {
                  "readOnlyHint": false
                },
                "_meta": {
                  "papercusp/toolRegistryRevision": "projected-tool-registry-v1:8e39e9ea53f0d6e9",
                  "papercusp/toolRegistrySource": "projected-tool-registry",
                  "papercusp/provider": {
                    "pluginName": "agent-mcp",
                    "packageName": "@papercusp/agent-mcp",
                    "version": "0.1.0",
                    "kind": "builtin"
                  },
                  "papercusp/servingGeneration": "serving-generation-v1:a528040778992a8ce2dda4696ff0affe43345629ae38c3e3ff7732a35db2389c"
                }
              },
              {
                "name": "plans:new",
                "description": "Create a plan in the plan store; never write a plan file. Optional content; lock-enforced unique slug. Format: /internal/docs/spec/plan-format.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "harness": {
                      "description": "Concrete in-scope harness slug (e.g. papercusp); harness-scoped sessions infer it. all requires unscoped --all-workspaces. Only UNSCOPED plans:get/plans:items auto-resolve an exact slug across harnesses; scoped misses identify the owning harness, which you must then pass explicitly.",
                      "type": "string",
                      "minLength": 1
                    },
                    "workspaceId": {
                      "description": "EI-1543: explicit opt-in escape hatch for an UNREGISTERED harness (one with no row in harness_shared.harness_registry or harness_shared.projects in ANY workspace) — resolvePlanScope refuses to silently default the workspace (WI-148: a wrong-workspace default once corrupted a named harness's plans), so plans:new otherwise throws for such a harness even though work_items:create succeeds against it. Pass the target workspace id explicitly to write the plan there anyway (e.g. \"default\" for a throwaway/demo harness). Omit for the normal case — the workspace is resolved from the harness registry.",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 120
                    },
                    "slug": {
                      "type": "string",
                      "minLength": 3,
                      "maxLength": 120,
                      "pattern": "^[a-z0-9][a-z0-9-]*[a-z0-9]$",
                      "description": "Topic slug in kebab-case. A -YYYY-MM-DD suffix is appended automatically if not already present (plan filename convention, §3.1)."
                    },
                    "title": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 1000
                    },
                    "status": {
                      "description": "Initial lifecycle status. Terminal statuses can only be reached through plans:set-plan-status.",
                      "type": "string",
                      "enum": [
                        "draft",
                        "ready",
                        "active",
                        "awaiting-acceptance"
                      ]
                    },
                    "ownerEmail": {
                      "description": "Optional plan owner email written to frontmatter.",
                      "type": "string",
                      "format": "email",
                      "pattern": "^(?!\\.)(?!.*\\.\\.)([A-Za-z0-9_'+\\-\\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\\-]*\\.)+[A-Za-z]{2,}$"
                    },
                    "rationale": {
                      "description": "Optional — why this plan exists / what prompted its creation. Stored as the rationale of the plan's first revision (D-009). Alias: `goal`.",
                      "type": "string"
                    },
                    "goal": {
                      "description": "Compatibility alias for `rationale` (the one-line why). The plan BODY is `content`, not this. `rationale` wins when both are supplied.",
                      "type": "string"
                    },
                    "content": {
                      "description": "Optional — the FULL plan body (the markdown BELOW the frontmatter: ## Now, ## Background, ## Requirements, ## Design, ## Phase 1 with items, ## Decisions). This is the same canonical field name used by plans:set-content. When provided, plans:new writes valid frontmatter + this content in ONE call, so you do NOT need a follow-up plans:set-content round-trip. Do NOT include your own --- frontmatter block — it is generated from slug/title/status/ownerEmail. ITEM LINES have a STRICT grammar and are the #1 fumble: an item is `- **P-001** `todo` Do the thing` — a `-`/`*` bullet, the id in **bold**, a status token in `backticks` (todo|wip|blocked|needs-human|done|dropped), then the text (optional trailing `blocked-by: P-002`, `importance: high`). A plain `- ` bullet, a `- [ ] ` checkbox, or `1. ` numbered line is NOT an item: plans:new refuses malformed item-looking lines with structured parse feedback before writing. If the body includes `## Requirements`, every `**R-1 — Title.** outcome` must also have a row in `## Design` under the exact `### Bar-to-work map for this plan` heading, using `| bar | implementing plan items | evidence plane |` and `tree`, `deployed`, or `live`. The bar cell is the bare key, for example `| R-1 | P-001 | tree |`; do not include the requirement title in that cell. plans:new validates this post-epoch BAR contract before persistence and reports the exact missing/invalid rows. plans:new returns itemsParsed + the parsed items so you can confirm they registered. If you intend to call plans:start, include substantive ## Requirements, the complete Design BAR map, and canonical P-NNN items; plans:start holds promotion until that spec triad is present. Omit content to get the empty starter template.",
                      "type": "string",
                      "maxLength": 200000
                    },
                    "propertySchema": {
                      "description": "OPTIONAL — typed property DECLARATIONS (P-023): name → { datatype, default?, editable_by: 'owner'|'agent'|'both' }. Each datatype must resolve in datatype_registry; defaults are validated against the datatype's payload_schema. VALUES are written later, only via plans:set-property.",
                      "type": "object",
                      "propertyNames": {
                        "type": "string"
                      },
                      "additionalProperties": {}
                    },
                    "verificationProfile": {
                      "description": "OPTIONAL — 'coding' | 'general': the default deliverable kind for the plan's items. Omit for the harness default (a code harness ⇒ coding, otherwise general).",
                      "type": "string",
                      "enum": [
                        "coding",
                        "general"
                      ]
                    },
                    "force": {
                      "description": "Creation is rejected with `similar_exists` + the overlapping plans when existing slugs/titles share this topic (EI-134 — duplicate plans split project history). Review the candidates; pass force: true only when this is genuinely a NEW effort, not a continuation. Accepts the wire strings \"true\"/\"false\" too (EI-302: stale manifest-pinned tools/list schemas).",
                      "type": "boolean"
                    }
                  },
                  "required": [
                    "slug",
                    "title"
                  ],
                  "additionalProperties": false
                },
                "annotations": {
                  "readOnlyHint": false
                },
                "_meta": {
                  "papercusp/toolRegistryRevision": "projected-tool-registry-v1:8e39e9ea53f0d6e9",
                  "papercusp/toolRegistrySource": "projected-tool-registry",
                  "papercusp/provider": {
                    "pluginName": "agent-mcp",
                    "packageName": "@papercusp/agent-mcp",
                    "version": "0.1.0",
                    "kind": "builtin"
                  },
                  "papercusp/servingGeneration": "serving-generation-v1:a528040778992a8ce2dda4696ff0affe43345629ae38c3e3ff7732a35db2389c"
                }
              },
              {
                "name": "plans:add-decision",
                "description": "Append one or many decisions to a plan. Allocates the next D-NNN inside a lock and bumps frontmatter `updated:`; concurrent calls stay collision-free. Single: `{ slug, title, body }`; bulk: `items:[{ slug, title, body, refs?, affects? }]`. Tree-fact decisions require `Measured: <file:line or command + result>`; without it, source-like paths return `measurementAdvisory` and a ruling resting on another decision as authority returns `citedRuleAdvisory`. CITE `ref` (`<slug>#D-NNN`) anywhere the decision is quoted onward — a bare `D-NNN` is allocated per-plan, so it is not a reference: `D-001` names 904 different rulings in this harness. Exact `{ title, body }` retries dedupe against the plan's most recent decision instead of appending.",
                "inputSchema": {
                  "type": "object",
                  "properties": {
                    "slug": {
                      "type": "string",
                      "minLength": 1
                    },
                    "promotedFrom": {
                      "$ref": "#/$defs/1"
                    },
                    "harness": {
                      "description": "Concrete in-scope harness slug (e.g. papercusp); harness-scoped sessions infer it. all requires unscoped --all-workspaces. Only UNSCOPED plans:get/plans:items auto-resolve an exact slug across harnesses; scoped misses identify the owning harness, which you must then pass explicitly.",
                      "type": "string",
                      "minLength": 1
                    },
                    "title": {
                      "$ref": "#/$defs/4"
                    },
                    "body": {
                      "$ref": "#/$defs/2"
                    },
                    "refs": {
                      "$ref": "#/$defs/3"
                    },
                    "affects": {
                      "$ref": "#/$defs/0"
                    },
                    "ownerTurnRef": {
                      "description": "'[turn:<session>@<ts>]' of the verified owner turn that ruled this (all items); omit = your own ruling",
                      "type": "string"
                    },
                    "items": {
                      "description": "add many decisions at once — each { slug, title, body, refs?, affects?, harness? }",
                      "minItems": 1,
                      "maxItems": 200,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "promotedFrom": {
                            "$ref": "#/$defs/1"
                          },
                          "slug": {
                            "type": "string",
                            "minLength": 1
                          },
                          "title": {
                            "$ref": "#/$defs/4"
                          },
                          "body": {
                            "$ref": "#/$defs/2"
                          },
                          "refs": {
                            "$ref": "#/$defs/3"
                          },
                          "affects": {
                            "$ref": "#/$defs/0"
                          },
                          "harness": {
                            "description": "per-item harness (else the batch `harness` default)",
                            "type": "string",
                            "minLength": 1
                          },
                          "rationale": {
                            "description": "per-item revision rationale (else the batch `rationale`)",
                            "type": "string"
                          }
                        },
                        "required": [
                          "slug",
                          "title",
                          "body"
                        ],
                        "additionalProperties": false
                      }
                    },
                    "rationale": {
                      "description": "Optional — a short why for this revision. A decision body already carries its own reasoning, so this is rarely needed. Stored on the plan revision (D-009).",
                      "type": "string"
                    }
                  },
                  "additionalProperties": false,
                  "$defs": {
                    "0": {
                      "description": "Existing plan slugs of OTHER plans this decision bears on. The edge is stored canonically as `Affects:` metadata on the source decision and indexed for affected-plan claimants; each affected plan also gets a cross-reference plan_event + watcher notify. Surface labels and item/work-item ids are not accepted here.",
                      "maxItems": 20,
                      "type": "array",
                      "items": {
                        "type": "string",
                        "minLength": 1,
                        "pattern": "^(?:[A-Za-z0-9._-]+|[A-Za-z0-9._-]+@run-\\d+)$",
                        "description": "An existing OTHER plan slug (the plan filename stem). This is not a surface label, work-item/issue id, or P-NNN item reference; use refs for in-plan P-NNN references."
                      }
                    },
                    "1": {
                      "maxItems": 24,
                      "type": "array",
                      "items": {
                        "type": "object",
                        "properties": {
                          "kind": {
                            "type": "string",
                            "enum": [
                              "memory",
                              "session-turn",
                              "work-item",
                              "report",
                              "fact",
                              "decision"
                            ]
                          },
                          "ref": {
                            "type": "string",
                            "minLength": 1,
                            "maxLength": 500
                          }
                        },
                        "required": [
                          "kind",
                          "ref"
                        ],
                        "additionalProperties": false
                      },
                      "description": "Typed sources validated in this workspace before writing: memory UUID; session-turn provider:session:index; work-item WI/EI id; report id; fact key; decision plan#D-NNN."
                    },
                    "2": {
                      "description": "The decision body. HARD CAP 5000 chars — over-length is REJECTED, not truncated, so split a long rationale or trim before calling. Measure before you rule: when the decision asserts a factual claim about the tree, read the tree and add a `Measured:` line naming the file:line or command + result. A decision cited from another decision is authority for design, not evidence about current code.",
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 5000
                    },
                    "3": {
                      "type": "array",
                      "items": {
                        "type": "string",
                        "pattern": "^P-\\d{3,}$"
                      },
                      "description": "Item IDs this decision relates to. Appear in the body as P-NNN tokens."
                    },
                    "4": {
                      "type": "string",
                      "minLength": 1,
                      "maxLength": 1000
                    }
                  }
                },
                "annotations": {
                  "readOnlyHint": false
                },
                "_meta": {
                  "papercusp/toolRegistryRevision": "projected-tool-registry-v1:8e39e9ea53f0d6e9",
                  "papercusp/toolRegistrySource": "projected-tool-registry",
                  "papercusp/provider": {
                    "pluginName": "agent-mcp",
                    "packageName": "@papercusp/agent-mcp",
                    "version": "0.1.0",
                    "kind": "builtin"
                  },
                  "papercusp/resultFormats": [
                    "json"
                  ],
                  "papercusp/servingGeneration": "serving-generation-v1:a528040778992a8ce2dda4696ff0affe43345629ae38c3e3ff7732a35db2389c"
                }
              }
            ]
          }
        }
      ],
      "toolCount": 14,
      "limits": [
        "SDK-decoded tools/list pages, not raw HTTP wire bytes or a native model tool-list frame.",
        "Caller configuration and launch attribution require independent native/launch receipt verification.",
        "Input schemas do not prove effective argument authorization; full P-001 and historical acceptance remain open."
      ],
      "configPath": "/home/marsh-office/.papercusp/su-codex-homes/session-53880/config.toml"
    }
  },
  "launchReceipt": {
    "deduped": false,
    "modelResolution": {
      "requested": "gpt-6.1-sol:xhigh",
      "agent": "codex",
      "model": "gpt-6.1-sol:xhigh",
      "effort": "xhigh",
      "alias": null
    },
    "memberModelResolutions": [
      {
        "requested": "gpt-6.1-sol:xhigh",
        "agent": "codex",
        "model": "gpt-6.1-sol:xhigh",
        "effort": "xhigh",
        "alias": null
      }
    ],
    "launch": {
      "deduped": false,
      "goalAdmission": null,
      "finalGoalAdmissions": [
        {
          "memberIndex": 0,
          "ownerId": "su-6aeee7d5-ffe8-4c36-8a41-ebf47f30ab1a",
          "receiptId": "RG-53c81fcb-f4bb-4c8f-b28f-f5973b83058e",
          "admission": null,
          "outcome": "opened"
        }
      ],
      "opened": 1,
      "failed": 0,
      "failures": [],
      "partial": false,
      "command": "psu --launched-by=su-4a84c93a-e530-450c-b01e-8beb7bdc670f --no-picker --account=auto --agent=codex --owner-id=su-6aeee7d5-ffe8-4c36-8a41-ebf47f30ab1a --harness=papercusp --plan=identity-definitions-own-policy-2026-10-17 --headless --carry=warm --model=gpt-6.1-sol:xhigh --model-source=configured-default --role=infra-reviewer --feature=WI-6554700010017386",
      "fleet": null,
      "independent": false,
      "goalVerifier": null,
      "verifierCoupling": null,
      "headcountProfile": null,
      "mode": "fresh",
      "resumedOwnerId": null,
      "ownerIds": [
        "su-6aeee7d5-ffe8-4c36-8a41-ebf47f30ab1a"
      ],
      "launchEvidence": {
        "version": 1,
        "processOpened": 1,
        "sessionRegistered": 1,
        "firstTurn": null,
        "taskDisposition": {
          "claimed": 0,
          "noClaim": 0,
          "unknown": 1
        }
      },
      "tasks": [
        {
          "taskId": "0mvt0vyse33amju1mon",
          "logPath": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/fleet-logs/P001-infra-current-build-raw-catalog-2759672-1793246873041.log",
          "normalizedLogPath": "/home/marsh-office/.papercusp-workspaces/papercusp-workspace/.papercusp/fleet-logs/P001-infra-current-build-raw-catalog-2759672-1793246873041.normalized.log",
          "pid": 2185778,
          "terminalPid": null,
          "label": "P001 infra current build raw catalog",
          "ownerId": "su-6aeee7d5-ffe8-4c36-8a41-ebf47f30ab1a",
          "headless": true,
          "kickoffProof": {
            "persisted": true,
            "nativeRef": "/home/marsh-office/.papercusp/su-codex-homes/session-53880/sessions/2026/10/29/rollout-2026-10-29T00-07-58-01a185d7-dc46-7c01-8687-b13b70f208cb.jsonl",
            "reason": null
          },
          "nativeSession": {
            "backend": "codex",
            "source": "adv_sessions",
            "ownerId": "su-6aeee7d5-ffe8-4c36-8a41-ebf47f30ab1a",
            "codexHome": "/home/marsh-office/.papercusp/su-codex-homes/session-53880",
            "rolloutId": "01a185d7-dc46-7c01-8687-b13b70f208cb",
            "exactResumeSupported": true,
            "missingReason": null
          }
        }
      ],
      "agentStarted": null,
      "freshVerdict": {
        "agentStarted": null,
        "sessions": [
          {
            "ownerId": "su-6aeee7d5-ffe8-4c36-8a41-ebf47f30ab1a",
            "sessionId": "01a185d7-dc46-7c01-8687-b13b70f208cb",
            "advSessionId": 53880
          }
        ]
      }
    },
    "completionReceipt": {
      "status": "recorded",
      "effectRef": "agent-launch:idop-p001-infra-actual-catalog-fire47-staging"
    }
  },
  "native": {
    "path": "/home/marsh-office/.papercusp/su-codex-homes/session-53880/sessions/2026/10/29/rollout-2026-10-29T00-07-58-01a185d7-dc46-7c01-8687-b13b70f208cb.jsonl",
    "selectedRecords": [
      {
        "line": 2,
        "bytes": 496,
        "sha256": "bbdfe5ad617e6e7eae53a2d7e9ea974d8c9c0c879d32ec4c0292558c292967a7",
        "gzipBase64": "H4sIAAAAAAAC/52QwW7DIBBE7/2MPeMKExJjf0dOvaCNIS4KBguvm0ZR/r3rqq56bHtCYt7MrOYOFEY/E44TdKCkOlS1rFR7lLqTTbdvn7XRLyAgFxcSRuhqAXSbPNP+zSey4zywPOEtZnTQ3TeVcL5YDi7kHQO0lGSRqITTQiGnT3L9C2wCWWNt9q6pnDd91WilKnNyh+qs9EF7ue93Z7+FcMQw+MKuZeZn7S7rId9paYlRQEiBAlJIg8Vh1Sek100sOf8w/K7+If5+8H96BHytxnPx3E27Y9U0rYAxOx9tnxP5d7LXkFy+QmeU0VIK6HOMeMoF13ntytoLI1zr/BmXSPB4PH0ARUWI5/ABAAA="
      },
      {
        "line": 12,
        "bytes": 696,
        "sha256": "fa735c9cbb9e920492545374a411ac3e82463c4fe7f18a4d93f0f1c898dc965f",
        "gzipBase64": "H4sIAAAAAAAC/0VSu47bMBDs8xUGa9OmHrYeZXBIlyppEhgg1uTS4ll8gFzFvhz876EcHK4TZkczy5l9Z2QdZgIX2chqUR95JXg9/BTtKIax6XfNUP9mWxaSth5mNlbVltFbxEJPmGPwGaUldIUT4W0OoNn4/sEwi1dkg5cK5rkwihEtuQxUcHFGQl1Aq1emkgI0DDUMOIhzqyoQ1RGwVkeDZ3Po+05X/QHapu6VxvPZGN2Vnz241QjvqGQRdeBXSUiXxaGn1er9xJTTJzaemA8aN5xbF0OiDeX7JqtkI+W9gkhLQm51iDwKUfHZ/kGugGAOlx3lzZ5c3H+OrTcJOChaYP6gcWMTtt3uNQd/YtsTu4V01TY9vfdTcLh3kPLEgzFW4T5CxKSWCJavzBzhE8zxqeDgLsNCcSFJ4Yo+F61aCFFGbxZnLdf6pFvhqsCP8vY1avnM9Pn1MtG3l+Ru18Pfr/cfL9R9v5lbvP5ag/eEqZQq1QQkyxlkuBQxpFIEgYyQM00pLJfpWemS/H9dUUGpQndcY69419Y178/6yE3dHlsUB9UYXBdJCITPDct23dCU8dA1O3EQh6F5PLbsw2qVV7MthUlYaAqp3MVoYM64ZUvGJK1fEyg3iKlIPR5f/gHul33tuAIAAA=="
      },
      {
        "line": 14,
        "bytes": 543,
        "sha256": "03c2f62bff127db9a30928700020f902cedd1ef737b86db0e8c3ebb793200934",
        "gzipBase64": "H4sIAAAAAAAC/zVRy4rcMBC85yuEzuNFkp/yMRkCOYQEEggJA0IjtcfCtmSkdiabZf49sjd76oaq7uqqfqHoFkiol5X2VDDRFJwVQn5nVc9kX5dPjItf9ERDtM7rmfa8PFF8XiHTI6Q1+ATKISyZs+rnOWhL+5c3xrB5gy54ZfQ8q7DhumEmOrtjJijGNe9qKwupW1G0tuGFbEEW1ZVrqMu2NB3P/GP6GDq684gfz3G5T/Xf93++nbH9fB/u6/RzP/NVoqcfxs1P5NO5J93AhdUX/yOPkt1tT/gTY7wlCUzwNl381xgMpETi5r3zN3J3OGY0pXx63kGaitX84r9Ed9tDIBgm8MSEzWNPWAYO1f7id28eIWaSMqNGlbNN+ga5orYatVp1SjjGsN3GI6ct+ldn/6NoCwudKdpKiKK72qYYRNVUwGpTDrBHEUEjqN1H/kUrywxLub+JSdFVj8eJvmnt+83swKPSG44hQtYZ9JzgRHOZr9pM6rCiZrc4VOE3xOjsvlgwxh6Pd/8A520YBx8CAAA="
      },
      {
        "line": 19,
        "bytes": 544,
        "sha256": "5d0905fac8d2cc2f1ba00e3e1b296201d17b21c187c6d0c0fe8176440aa1d8cb",
        "gzipBase64": "H4sIAAAAAAAC/zVR247bIBB972fwbK+A2Mb2B6xWXWWfqlZaWUITGCdWDViA1UaR/71Dqn2DM4c5Fx4sLw5TBrexkUkuu1rwWg4/eDMKPrb9SzuIT1axEO3iYWWj6CuW7xsSPWLagk+ol4yOOBvc1wCWjY8vxrx7k5fgtYF1JQYJ5T3RwAS3rZjRErjYwjSag4VBwoADvzRGABcdoDSqFT0BvbIClEA7XGYrOg6Iih57cEXoTyQPOmUySSDE6+7Q56L0mFjClIqJxU5s7Breimpi5gYx0X1iE6Org7867Hnbs87hN/oykpxzGt0XXK0uPWlXYEHwQSolk36af56+O0i/7Od6Pv+cX90b9m/v51fxsZWEPmOk9jSJZk19J7jSMsyUOIPeIKV8i2G/3p7d7dH/38sFiL61qrbYm1o1Utb9xXb1LJuuQd6a04zFSESg9MUhuVPDSTaKt6eXXp2G5jgq9qVUtpt1oWY07PkWIvU/zrAmrNieMOrFlwLorzFS/OP49g9g3+prIAIAAA=="
      },
      {
        "line": 22,
        "bytes": 661,
        "sha256": "d5494306f2b1c7e4d7ba238ec3cfe4d5c2c0681da94394b1015994dc50c434a7",
        "gzipBase64": "H4sIAAAAAAAC/zVSTW/bMAy971cYOkeprDi242uLotuQbYdhBQoDhiLRsRZZMvSxrQjy30e57Un8eOQj+XQlUc8QopgX0hHOeE1LRvnhJ6u6suwY2/K2eSEb4rzSVhjS8XJD4usCCPcQFmcDDDrCjJhFvBonFOmuH4gxWRm1s4MUxgwuxSVFBGqVc9INrBRlu1eCinIHtGHNjopDu6djXVew5+Op3VeIX6vXotX6MovwrF7M8fhrfJyfoH36enwsvy15zDeKjtxPyV6Kzw9dwcSuaqC3z1ha5G0xtGWMlUUA6awKvf3hnYQQCviHm6jir45TIZ2CgvX2u9fnvHkR3QUshpONXbHLmZWr6+21f+ftSdeTuzgvd1q5hS5IQrUdPe4nYxKGShGFcWc6ag9Vs/0dnO3JpifSzYuBCNgg+gQYWcQZArol2tE5c595s19hYBTaJJ/RNhlz622+qY3gcc5BTiIOqGnADvhGoZB0WEQIcfIunadVn+Tt20XfJWioglbSpuKctidV05FXqAHby90IWQIPIsKQ74dDNIcdrxpW5+9RH/jttiEfTLm7NBpsHESKk/OALKMwATY4tzEnIS/DesvB6FnHwf0B77XKbTnKcrt9+g+TKfW5lQIAAA=="
      },
      {
        "line": 24,
        "bytes": 996,
        "sha256": "43025528a9e580fa7368815538339d74bb57297d4181119643cf7634628ce20f",
        "gzipBase64": "H4sIAAAAAAAC/11TUW/TMBB+51dMflmRktRJ0zYNmpBAQhpCIG08AKoU3exz6y2xPdthK1X/O+duBcaTT999/r6783nPoh4wRBgca1nFq0Ve8rxafeV1W5btnBfzVfODZcx6qQ30rK1mGYs7h0T3GJw1ATsdcSCOg11vQbJ2f2Ko0YiorekE9D0xyCiOgRLCDq7HiJJALRNTdBwkrCpY4Yrf1KIEXi4AK7FsKq5q0Sxl2Sz4TM5Bzri4wdm8pMsGhmSEjyg6Eh3AJEnwm3FAE5PVfs3EINesXTNjJZ7leHYuqOx4psKFx/tRe5ys10/ZVoUUvn5z9kRxELcXCZnGwU21tC53nJe5NspDDiKO0OcCIvR2kytSqpfFbbAmXTlp3F58vP7yuXDgA05UKDyC/KB7vN4ZMUkGWWKPUTVH62dv22NBopPj3RC9NhutdpN9miT6dm8fDPpL2d4WT8jb4hnJDET9E68xBJr8C8Z/mYx8lN6MHuUV2f1DfJk4ZKfnSpTnMHOwwfd2NJHAFIeiR7OhbqK1/SnxJ84U6J4ECXuOstT6gdo9X7NszR6sv5PaH99purUDTgca2Da3SmmBUwcOvRgd6Dwxg4O/YHBHhQEeOztGN8Yu2js0gbQqzjmldhp72aVV74YElwQfaE9Sv91x/46Rgsf+kr/7GKXh99ur+1+fHj5fym/f05KaiJ4+QCe2EDv6MoFapjPS0kboHIQQt96Om+1x/UdvnnR5CWUzl8tcYiPyZV1VeXMjF7mq6kWNfC5mClMhtBQRjxVSdcvVrKqXJa+LetXM+OxwyNjJKsmLXtNydzDGraU3Yq2CPmDGxoC+0yZNgP4retbS1Ve/AbSGkqDkAwAA"
      },
      {
        "line": 27,
        "bytes": 833,
        "sha256": "7a9089065f1fde92089aec26cfad673107b1208ab51be71aa80807276601156a",
        "gzipBase64": "H4sIAAAAAAAC/0VSTW/bMAy971cYOkedpDi24+O6S4ZhG7oB+4ABQ5aoWKsiubLctCvy30er7XaySb1H8j3yiSR7gjnJ00RaIpioKGdU7L+xsuW83fGrPWO/yIaEqK2XjrSi2pD0OAHCI8xT8DP0NsEJMZN8dEFq0j69IsziVbLB90o614clTUtCoNXrmwo945I3Oz3QSmpF60EwKkuuqaj3UovtoBgHxGd2JuU/Ix/cgb37kLRnd+PN3Z+P508H/ePnOuZzi5Zcj4u/LQ7v20LIAZpt578jtVjVtgW7YozxYgYVvJ47/yUGBfNcwAMq0cXZprFQQUPBOv852uOqvEjhFjymF5/aotrjS+7Vdv6py3NB7FB6R8LZQzxoDDoyLygNAGq9o8ZAQ0u1rWiDIikMpqzNlsmBy45sOuJlsvfwFQdBx174LwbVVKuyojX6QZuqqenAt0PNjGCNGjIZlRh7XCLom+Agc603UdII9xbO62yXDDtNDtIKSHEBzEzyCNerKExxjFMI7l9cYsJI67Auhn5xLjPSmBu8TafprdVhohPaSZ/7SZUW6aiSSbpwpMZGKOur33PwOEHn1+37BBEd7dUoU4/XN+MI+E1SI6mf5DynMYblOOZLWqJ/3v1/L6DBYymFoM2gK2pEWZXAdmpr8rFEkAn6ddOooN5vRVlzng+5weBy2ZDXXmt95Sz41MsljQHdI62RboYNynZukOq2z3vvnT3Z1Id7iNHqtbDAE7pc3vwFvQCzQEEDAAA="
      },
      {
        "line": 30,
        "bytes": 1064,
        "sha256": "f04e8bb9b990cd21885a1f3e2a87408ccdf55320ba10f1d0068c9ffa38c8eea2",
        "gzipBase64": "H4sIAAAAAAAC/6VTPXPbMAzd+zM4mwlJ0aKktVPXtlPjnA6iQJuNTOooKmku5/9eUHbSoVOvk4gnfDwAD28s+zMuGc4z65gSquZScNV+F7qTqtubO63ED7ZjMY0+wMQ61e5Yfp2R3BMucwwL9j7jmXxmeJ0ijKx7e/eg1Asckf5RibwuBNl4nifMOBLox+KzHHsBI7QKWmzFoK0EIWtAZY3du0bqxoyydYN0DiscpG2HBig6xanUgGXxlD1kgmwMGenVPXxQiGue19xn/FUctk/H3g7MwjRhOhDZA4svAdOXkYwDW1ZOtRHNuOdUsOHaVjVvQEuOg9PGVQIGCQe2O7AA2T/jN2rSx3CLFxJksx8NH62uubFC8qZuDB9kNRjhlGjssAUTV+ePa8LxKzWyxfrgEvCEzx5fCrfL5nadFznktCIhM030c1xDJkiSnWOcPmxNgAM/UV4ywzpNW0Q+bQXu83m+92Oc+SyI2LUe2LzCxC1kmOKRO59Qm7ufSwzEgGYGIUTaHrVI+3t43DHymlMcNutC9nyCpYzaFYX0EBYiX7ZLu0gFsSfI/U0K9M207Az9TIvLpxTX42lTzJpCvwnizwSxsdxopXgzjDV3Stcaxd5WrijKJoSMfdEv9W3aSmkjjbxTuqpk9aGFTZz9kw9j4cvW8BRo3ezxctmxdy6lfqK3Dzj2S1yTxQL5TcrvxP9PrP/c3l/qJr5FGUVq2+3d6N7SWVKtpXSVEhzQKN62Zm8HaOpKiu0yrjK6qohy2cmX6cCaT5E0yDoH04I7ti6Yeh/KzdDN0yI7fbl8+g0uf4RcKAQAAA=="
      },
      {
        "line": 33,
        "bytes": 635,
        "sha256": "be4d0bb6eead82e1f102086961c213cdc0cdaf9fc61a72cb6b8b459c40098f41",
        "gzipBase64": "H4sIAAAAAAAC/5VSsY7cIBDt8xnU5s5gr8FuU6VNUkWWLAzDHjkMFh7v6bTaf8+sN7mkTceb997wGObKMCywoVlWNjBZy46Lmsv+e90OQg4n/SSl+MEqlosLyUQ2NLJi+L4CyeECCadlOxO/mveYjWPD9Q+LZnudbF7WCAikKDnjhHtJUyAZq4UR+uQUd6AtV62UXM+u4162XQv1yTb+7vpvQzQbTuZ8JINtoxN5ryOzJkYoIwUcWX5LUL44AiPbdt4ZAFDuxL0HzVvbdFybVnCYfat8U5tZmJFVI0sGwwW+UduQ02//31i27biyteC604rPoplV7WWt7XyYbU4+nPcC7muOcHhD8sXwApcAb/dst0P2mBgJsOxAlZXe8DnvCakkCGPO8QO3VPAmROpLMO0xHg58OS54xmV9Di6vfK0p2OM+Y3E3kVuDJuYz96FAq55+bjlRApogbUNBcJNB6q/6huarVV99JPuXUULpirm90GRyol1gg+y1lvclocWaME/Un34E8ys8+F73vbzdPv0CjN3tj3sCAAA="
      }
    ],
    "terminalExecOutput": "Chunk ID: 0a347e\nWall time: 0.0001 seconds\nProcess exited with code 0\nOriginal token count: 30\nOutput:\n{\"output\":\"/tmp/idop-p001-infra-actual-catalog-fire47.json\",\"complete\":true,\"pages\":1,\"toolCount\":14,\"failure\":null}\n"
  },
  "sharedInstrumentProof": {
    "canonical": "evidence/idop-p001-architect-raw-catalog-20261029-fire47.json",
    "bytes": 651007,
    "sha256": "e5a929475ddfbdc1e6bc7226e565c55acfef4b9c1c6e5a244cb1330b7f30dec5",
    "archivalSourceEquality": [
      {
        "path": "packages/operator-core/lib/agent-identities/idop-p001-live-catalog.ts",
        "sha256": "cc743d851ecdb43c4d126225595e91bc501a54ef824acda77ffb12872af161d7",
        "unchangedFromArchitectArchive": true
      },
      {
        "path": "packages/operator-core/lib/agent-identities/idop-p001-live-catalog.test.ts",
        "sha256": "6c393fcb3bef72dc0238afa163bf18e5b7d39ef8febaea477e2f46763eb54900",
        "unchangedFromArchitectArchive": true
      },
      {
        "path": "scripts/capture-idop-p001-live-catalog.ts",
        "sha256": "a92e211ea55867bfce91f296729d8dde4c855b473da436bb1fcd599fecf354ae",
        "unchangedFromArchitectArchive": true
      },
      {
        "path": "packages/operator-core/lib/agent-mcp-client.ts",
        "sha256": "8dbb99ef50be85abfb5c2c38c3f748c715057990e01ee06d8c677807dc342101",
        "unchangedFromArchitectArchive": true
      },
      {
        "path": "apps/operator/scripts/ptool.mjs",
        "sha256": "8b002b1c55ffb4ec7229cd153ce76a48f65d7d2e24658e9100e0681435052bf5",
        "unchangedFromArchitectArchive": true
      },
      {
        "path": "packages/operator-core/lib/role-codex-home.ts",
        "sha256": "fc411f601bbcdbba68da8fd90289c3f5d5a1929845adea2e2f5c7fdb803ca6d7",
        "unchangedFromArchitectArchive": true
      },
      {
        "path": "apps/operator/scripts/psu-launcher.mjs",
        "sha256": "59338cbbcd00a5b114aa4c123deb73e14b834dc768cb776f73cde18d7fe45404",
        "unchangedFromArchitectArchive": true
      }
    ],
    "tests": "11 local PASS, 0 skips, four infrastructure child substitutions; final three-file scoped types clean. Exact shared proof retained by reference; no unchanged suite rerun."
  },
  "controls": {
    "nativeTaskStartedAndCompleted": true,
    "nativeYield64051TerminalExit0": true,
    "ownerNativeLaunchJoin": true,
    "configAndEndpointHashesReplayed": true,
    "terminalSdkPages": 1,
    "uniqueAdvertisedSchemas": 14
  },
  "comparisonWithArchitect": {
    "architectAdvertisedCount": 50,
    "infraAdvertisedCount": 14,
    "commonNames": [
      "code:run",
      "facts:assert",
      "facts:list",
      "facts:retract",
      "memory:remember",
      "memory:search",
      "plans:add-decision",
      "plans:new",
      "plans:set-now",
      "plans:set-status",
      "recipes:search",
      "session:request-compaction",
      "tools:find",
      "tools:invoke"
    ],
    "architectOnly": [
      "activity:report",
      "checkpoint:await",
      "coord:declare-intent",
      "coord:dispatch",
      "coord:glance",
      "coord:inbox",
      "coord:orient",
      "coord:send",
      "dev:pg_query",
      "docs:search",
      "events:await",
      "events:cancel",
      "events:catalog",
      "events:status",
      "fleet:launch-on-plan",
      "improvements:capture",
      "loop:arm",
      "loop:checkpoint",
      "loop:end",
      "loop:status",
      "mode:set",
      "plans:get",
      "scheduler:get_next",
      "search:fulltext",
      "work_items:checkpoint",
      "work_items:claim",
      "work_items:claim_next",
      "work_items:claimable",
      "work_items:comment",
      "work_items:complete",
      "work_items:create",
      "work_items:get",
      "work_items:list",
      "work_items:release",
      "work_items:set_state",
      "work_items:update"
    ],
    "infraOnly": [],
    "qualification": "Two actual current caller catalog surfaces; no effective handler-authorization or historical equality claim."
  },
  "limits": [
    "Actual fresh infra-reviewer configured endpoint on current-build staging; the advertised catalog is not effective handler authorization.",
    "SDK-decoded tools/list pages retained in file and paired with native invocation/terminal exec; not a raw HTTP packet capture or full model-native control partition.",
    "First CLI edition did not emit pre-execution instrument digests; archival hashes are separately labeled.",
    "No historical baseline replacement, other-role/legal-stack coverage, four-setting vault acceptance, historical authentication, independent implementation acceptance or shipment.",
    "Existing finished observers are stopped; this native session completed after the bounded sample.",
    "This fresh infra reviewer sample supplies missing SDK inputSchemas; earlier infra metadata evidence is preserved, not replaced.",
    "Native control calls are function_call/function_call_output on this session, while the architect used custom_tool_call wrappers; both original record forms retained."
  ]
}

